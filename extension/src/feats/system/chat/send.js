/**
 * 聊天窗口 · 发送切片：发送目标、@编码、发送、分享坐标、撤回。
 * 依赖方向红线：只 import core + context + normalize；跨切片调用（pushEntry/renderActive/checkFriend 等）走 S.fns。
 */
import { safeParse } from '../../../core/util.js';
import { gameData, gameConf, bits } from '../../../core/game-api.js';
import { chatApi } from '../../../core/chat.js';
import { netApi } from '../../../core/net.js';
import { S, log, bufOf, syncRoomIds, AT_ALL_TOKEN, COOLDOWN_MS, CHAN_DEFS } from './context.js';
import { CMD_RECALL_CHAT } from './constants.js';
import { familyOf, chanOfKey, myUid, hhmm, locText, decodeAtCodes } from './normalize.js';

/**
 * 撤回自己的消息（游戏 revokeMsg 同源口径，newChatController.js:4049-4069）：
 * sendPBV2(254, {roomId, uuid, channel, toUid})；toUid：私聊房标识是无下划线的纯 uid →
 * Int64.fromString(roomId)，其余房间 → Int64.fromNumber(0)。时限配置表 630061（默认 60s）。
 * 成功后服务器会广播 chatdel 移除各端条目，本地 delOne 兜底。
 * @param {object} entry 消息条目
 * @returns {Promise<void>}
 */
async function doRevoke(entry) {
  var net = netApi;
  if (!net || !S.overlay) return;
  if (!entry || !entry.self) {
    S.overlay.toast('只能撤回自己的消息');
    return;
  }
  if (String(entry.id).indexOf('local:') === 0) {
    S.overlay.toast('消息尚未发送完成，稍后再试');
    return;
  }
  var b = bufOf(S.activeKey);
  var limit = +gameConf.dataConfig(630061) || 60; // 撤回时限配置（game-api 取不到时默认 60s）
  var nowSec = gameData.serverTime() || Math.floor(Date.now() / 1000);
  if (nowSec - Math.floor(entry.timeMs / 1000) > limit) {
    S.overlay.toast('超过 ' + limit + ' 秒时限，不能撤回');
    return;
  }
  var channel = b.c != null ? b.c : S.activeKey.indexOf('pm:') === 0 ? 1 : chanOfKey(S.activeKey);
  if (channel == null) {
    S.overlay.toast('无法确定该消息的频道');
    return;
  }
  var roomId = b.roomId || '';
  if (S.activeKey.indexOf('pm:') === 0) roomId = S.activeKey.slice(3); // 私聊房标识=对方 uid（游戏 NowChoiceKey.Id 同形）
  // 游戏 revokeMsg 同源：无下划线 → Int64.fromString(roomId)，其余 → 0（game-api bits 封装）
  var toUid = bits.int64(roomId.indexOf('_') <= 0 ? roomId || '0' : '0');
  try {
    var ret = await net.sendPBV2(CMD_RECALL_CHAT, {
      roomId: roomId,
      uuid: String(entry.id),
      channel: channel,
      toUid: toUid,
    });
    if (ret && ret.ok) {
      S.fns.revokeInPlace(String(entry.id), Date.now()); // 原位转撤回卡，与游戏观感一致（服务器 chatdel 再幂等确认）
      S.overlay.toast('已撤回');
    } else {
      log.info('recall rejected: %s', String(ret && ret.data).slice(0, 200));
      S.overlay.toast(
        '撤回失败：' + locText(String(ret && ret.data != null ? ret.data : '无应答')).slice(0, 30),
      );
    }
  } catch (e) {
    log.warn('recall failed: %s', e && e.message);
    S.overlay.toast('撤回异常');
  }
}

/**
 * 解析当前视图的发送目标参数
 * @param {string} key 会话键
 * @returns {object|null} chat.send 的 opts 底座（channel/uid/group），不可发送返回 null
 */
function sendTarget(key) {
  if (key.indexOf('pm:') === 0) {
    var uid = key.slice(3);
    if (!uid || uid === 'unknown') {
      if (S.overlay) S.overlay.toast('先选择私聊对象');
      return null;
    }
    return { c: 1, uid };
  }
  if (key === 'pm') {
    if (S.overlay) S.overlay.toast('先选择私聊对象，或点发送者名字开私聊');
    return null;
  }
  if (key.indexOf(':') > 0 && familyOf(key) === 'cross') return { c: chanOfKey(key) }; // 跨服/活动发送不携 roomId（游戏同世界 else 分支，服务器路由到已 join 房）
  var d = CHAN_DEFS.find((x) => x.key === key);
  if (!d) {
    if (S.overlay) S.overlay.toast('该频道暂不支持发送');
    return null;
  }
  var opts = { c: d.c }; // 直接传数字 c（send 内部 opts.c 优先，免走 channel 名映射；c=0 世界也不会被 || 吃掉）
  if (d.c === 5) {
    var b = bufOf(key);
    if (!b.roomId) syncRoomIds(); // roomId 兜底：不依赖玩家在游戏里切过频道（见 syncRoomIds）
    if (!b.roomId) {
      if (S.overlay) S.overlay.toast('未发现可发送的群聊频道（需已加入群）');
      return null;
    }
    opts.group = b.roomId;
  }
  return opts;
}

/**
 * @ 编码：把输入里的 "@昵称" 依次替换成 RS序号RS，产出 atData（游戏 checkAtData 口径）；
 * 「@全体成员」替换为 AtAllName 常量、不进 atData。
 * @param {string} text 原始输入
 * @param {Array<{uid:string, name:string, all?:boolean}>} atList overlay 登记的 @ 列表
 * @returns {{encoded:string, atData:object|null}}
 */
function encodeAt(text, atList) {
  var encoded = text;
  var atData = null;
  for (var a of atList || []) {
    var token = '@' + a.name;
    if (encoded.indexOf(token) < 0) continue; // 文本里已无此 @ → 不进 atData（对齐游戏 checkAtData 剪枝）
    if (a.all) {
      encoded = encoded.split(token).join(AT_ALL_TOKEN); // @全体成员 → AtAllName 常量（游戏发送前 split/join 同口径）
      continue;
    }
    atData = atData || { uid: [], name: [], msgId: '' };
    atData.uid.push(a.uid);
    atData.name.push(a.name);
    // m 保留字面 "@昵称"，不替换成 RS序号RS：游戏 sendChatInfo 发的是 editBox 原文（checkAtData 仅剪 atData、
    // 其 RS 替换作用在局部副本上被丢弃），渲染端 formationRichMsg 靠字面 "@"+atData.name[h] 匹配上色；
    // 若这里塞 RS序号RS，游戏匹配不到字面 @name，会把 RS 当分隔符逐段吐成「@昵称0@undefined」脏数据
  }
  return { encoded, atData };
}

/**
 * 发送文本（含 @/引用）。乐观条目 + 5s 冷却。
 * @param {string} text 原始输入文本
 * @param {Array<object>} atList @ 列表
 * @param {object|null} quoteEntry 被引用条目
 * @returns {Promise<boolean>} 是否已接受提交（overlay 据此清输入框）
 */
async function doSend(text, atList, quoteEntry) {
  var chat = chatApi;
  if (!chat) return false;
  var now = Date.now();
  if (now - S.lastSendAt < COOLDOWN_MS) {
    if (S.overlay)
      S.overlay.toast(
        '发送太快，请 ' + Math.ceil((COOLDOWN_MS - (now - S.lastSendAt)) / 1000) + 's 后再试',
      );
    return false;
  }
  var target = S.fns.sendTarget(S.activeKey);
  if (!target) return false;
  var enc = S.fns.encodeAt(text, atList);
  var responseData = quoteEntry
    ? { name: quoteEntry.name, msg: quoteEntry.plain, uuid: quoteEntry.id }
    : null;
  S.lastSendAt = now;
  if (S.overlay) S.overlay.startCooldown(Math.ceil(COOLDOWN_MS / 1000));
  // 乐观条目（回声到达时原位合并）
  var bAct = bufOf(S.activeKey);
  var localEntry = {
    id: 'local:' + now,
    uid: myUid(),
    timeMs: now,
    timeStr: hhmm(now, S.cfg.showDate),
    name: '我',
    self: true,
    mention: false,
    pmDir:
      S.activeKey.indexOf('pm:') === 0 && bAct.title !== S.activeKey ? '-> ' + bAct.title : null,
    segments: decodeAtCodes(enc.encoded, enc.atData),
    plain: text,
    quote: quoteEntry ? { name: quoteEntry.name, msg: quoteEntry.plain, id: quoteEntry.id } : null,
  };
  S.fns.pushEntry(S.activeKey, localEntry);
  try {
    var opts = Object.assign({}, target, { atData: enc.atData, responseData });
    var ret = await chat.send(enc.encoded, opts);
    // net 不做 JSON_PARSE，Ret.data 是应答字符串原文（真机 2026-09-27：成功为 '{"success":1,m:...}' JSON 串，
    // 业拒为 '<本地化文案键,参数>' 裸串）；游表口径 t.d 先 parse 再 1 == n.success
    var payload = safeParse(ret && ret.data) || {};
    var ok = !!(ret && ret.ok && +payload.success === 1);
    if (!ok) {
      S.fns.delOne(localEntry.id);
      var reason =
        typeof (ret && ret.data) === 'string' ? ret.data : payload.msg || payload.message || '';
      if (S.overlay)
        S.overlay.toast('发送失败：' + locText(String(reason || '服务器拒绝')).slice(0, 40));
    }
    return ok;
  } catch (e) {
    S.fns.delOne(localEntry.id);
    if (S.overlay)
      S.overlay.toast('发送异常：' + (e && e.message ? String(e.message).slice(0, 40) : ''));
    return false;
  }
}

/**
 * 分享地图坐标（输入框 "x,y" → 坐标按钮）
 * @param {number} x x
 * @param {number} y y
 * @returns {Promise<void>}
 */
async function doSharePos(x, y) {
  var chat = chatApi;
  if (!chat) return;
  var now = Date.now();
  if (now - S.lastSendAt < COOLDOWN_MS) {
    if (S.overlay) S.overlay.toast('发送太快，稍后再试');
    return;
  }
  var target = S.fns.sendTarget(S.activeKey);
  if (!target) return;
  S.lastSendAt = now;
  if (S.overlay) {
    S.overlay.startCooldown(Math.ceil(COOLDOWN_MS / 1000));
  }
  try {
    var ret = await chat.sharePos(x, y, Object.assign({}, target));
    var payload = safeParse(ret && ret.data) || {}; // 同 doSend：Ret.data 是应答字符串原文
    if (S.overlay)
      S.overlay.toast(
        ret && ret.ok && +payload.success === 1 ? '已分享坐标 ' + x + ',' + y : '分享失败',
      );
  } catch (e) {
    log.warn('share pos failed: %s', e && e.message);
    if (S.overlay) S.overlay.toast('分享异常');
  }
}

// ─────────── 切片函数登记 ───────────
Object.assign(S.fns, { doRevoke, sendTarget, encodeAt, doSend, doSharePos });
