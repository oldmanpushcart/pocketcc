/**
 * chat 内部底座 · proxy 隧道与读数据面（core/chat/proxy.js）
 * 原 core/chat.js 的 proxy/apiSigned/signParams/md5/history…/systemMessages/withTimeout/toRet 区段，
 * 阶段五逐字迁出（行为零变化）。走 sendProxy 隧道拉历史/未读/标已读（sign=md5(参数拼串+time)）。
 * 引用方向 proxy→client（借 status 取当前 _rooms）→receive→context，单向不成环。
 */
import { getUid } from '../player.js';
import { netApi } from '../net.js';
import { game } from '../game.js';
import {
  ensure,
  ctx,
  Ret,
  APP_ID,
  CHANNELS,
  SEND_TIMEOUT_MS,
  resolveSysCmd,
  serverTimeSec,
  getStrUid,
} from './context.js';
import { toSysItem } from './normalize.js';
import { status } from './client.js';

/**
 * 给一个 proxy 应答归一化：解析成功的应答对象取 code；解析失败时游戏把原始字符串传进 err 回调
 * @param {object|string} r sendProxy ok/err 回调实参
 * @returns {Ret} 应答结果
 */
export function toRet(r) {
  var code = r && typeof r === 'object' ? (r.code != null ? r.code : null) : null;
  return Ret.from(code, r);
}

/**
 * 走聊天 proxy 隧道发包（emit("proxy", {url,query,body}, ack)）。
 * 未连接立即 reject——游戏 sendProxy 内部 IsValid 不过会静默丢弃、回调永不触发。
 * ok/err 两条回调都 resolve（业务成败看 Ret.ok = code===1，服务器拒绝也是有效应答）；
 * 仅超时/传输失败 reject。
 * @param {string} url 业务 url（如聊天服务器 REST 风格路径）
 * @param {object|null} [query] query 参数对象
 * @param {string|object|null} [body] body 载荷
 * @returns {Promise<Ret>} 应答结果
 */
export function proxy(url, query, body) {
  return withTimeout(
    new Promise(function (resolve, reject) {
      if (!ensure()) return reject(new Error('Chat proxy: NetChatClient is missing.'));
      if (!ctx.client.IsValid())
        return reject(new Error('Chat proxy [' + url + ']: socket not connected.'));
      var settle = function (r) {
        try {
          resolve(toRet(r));
        } catch (e) {
          reject(e);
        }
      };
      try {
        ctx.client.sendProxy(url, settle, query || null, body || '', settle);
      } catch (e) {
        reject(e);
      }
    }),
    'Proxy [' + url + ']',
  );
}

/**
 * 聊天服务器 REST 基址：读登录时服务器下发的 newChatController.url（静态，
 * 真机值如 http://chat-api-v5-cn-ali-inner.rivergame.net）；未登录/探不到返回空串。
 * @returns {string}
 */
export function apiBase() {
  try {
    var m = game.get('newChatController');
    var cls = m && m.newChatController;
    if (cls && cls.url) return cls.url;
  } catch (e) {}
  return '';
}

/**
 * 复用游戏自带 md5（与 newChatController 拼 sign 同一实现：SafeUtils.default.md5），保证与服务端验签一致。
 * @param {string} s
 * @returns {string} 32 位小写 hex
 */
export function md5(s) {
  var m = game.get('SafeUtils');
  var f = m && m.default && m.default.md5;
  if (typeof f !== 'function') throw new Error('chat: md5 unavailable via SafeUtils.');
  return f(s);
}

/**
 * 生成 query 签名（真机 2026-09-26 源码 + 双样本验证）：
 * sign = md5( 各参数按序拼 key+value 的连接 + time值 )，time 已含在 params 内（拼接时多尾接一次）。
 * @param {object} params 不含 sign 的参数对象（含 time）
 * @param {boolean} sort true=按 key 字母序（getStringFromParmsSort，getUnread/markRead 系），false=插入序（loadPmChat/loadHistory 系）
 * @returns {string} sign
 */
export function signParams(params, sort) {
  var keys = sort ? Object.keys(params).sort() : Object.keys(params);
  var s = '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k !== 'sign') s += k + params[k];
  }
  return md5(s + params.time);
}

/**
 * 带签名的聊天服务器 GET（经 proxy 隧道）：自动补 time 与 sign，基址取 newChatController.url。
 * @param {string} path 端点路径（如 /pm/loadPmChat）
 * @param {object} params 业务参数（不含 time/sign；插入序端点需自行保证 key 顺序）
 * @param {object} [opts] {sort:boolean 是否按 key 字母序签名，缺省 false}
 * @returns {Promise<Ret>} 应答（ret.ok；业务体在 ret.data.data，Ret.data 是完整应答对象 {code, data}）
 */
export function apiSigned(path, params, opts) {
  opts = opts || {};
  var base = apiBase();
  if (!base)
    return Promise.reject(
      new Error('chat.' + path + ': chat server url unavailable (login first?).'),
    );
  try {
    params.time = String(Date.now());
    params.sign = signParams(params, !!opts.sort);
  } catch (e) {
    return Promise.reject(e);
  }
  return proxy(base + path, params);
}

/**
 * 拉与某人的私聊历史（/pm/loadPmChat，插入序签名）。只读，不改游戏任何状态。
 * @param {string|number} targetUid 对方 UID
 * @param {object} [opts] {channel 私聊频道号，缺省 1}
 * @returns {Promise<Ret>} ret.data.data.list 为消息数组（Ret.data 是完整应答对象；schema 同 chatpushpm，含双向、按 t 升序）
 */
export function history(targetUid, opts) {
  if (targetUid == null || targetUid === '')
    return Promise.reject(new Error('chat.history: targetUid required.'));
  opts = opts || {};
  var q = {
    appId: APP_ID,
    uid: String(getUid() || ''),
    to: String(targetUid),
    channel: opts.channel != null ? opts.channel : CHANNELS.pm,
  };
  return apiSigned('/pm/loadPmChat', q, { sort: false });
}

/**
 * 拉频道历史（/chat/loadHistoryV2，插入序签名，游戏 getHistoryData 同源口径：
 * query={appId,roomId:'房1;房2;…',time}，房号列表缺省取游戏当前 _rooms（世界/联盟等由游戏自己 join）。
 * 只读，不改游戏任何状态。应答 data.list 为历史消息数组（schema 同频道推送，项带 roomId/c；
 * 游戏侧对历史项预处理过 fu=uid、m=content，本层交给 normalize/调用方兼容）。
 * @param {string[]|null} [roomIds] 房号数组；缺省全部已 join 房间
 * @returns {Promise<Ret>} 历史列表在 ret.data.data.list（Ret.data 是完整应答对象）
 */
export function historyRooms(roomIds) {
  var ids = roomIds;
  if (!ids || !ids.length) ids = status().rooms;
  ids = (ids || []).filter(Boolean);
  if (!ids.length)
    return Promise.reject(new Error('chat.historyRooms: no rooms available (login/join first?).'));
  var q = { appId: APP_ID, roomId: ids.join(';') };
  return apiSigned('/chat/loadHistoryV2', q, { sort: false });
}

/**
 * 翻更旧的频道历史（同端点，roomId 位填游标 "<roomId>|<最旧消息uuid>"——
 * 游戏 askLastPageData 的 GroupId|MsgId 口径，MsgId 即推送/历史里的 uuid）。
 * @param {string} roomId 房间号（如 102_1_4336）
 * @param {string} beforeUuid 当前已加载最旧一条消息的 uuid
 * @returns {Promise<Ret>} 更旧一页消息在 ret.data.data.list（schema 同 historyRooms）
 */
export function olderHistory(roomId, beforeUuid) {
  if (!roomId || !beforeUuid)
    return Promise.reject(new Error('chat.olderHistory: roomId and beforeUuid required.'));
  return historyRooms([roomId + '|' + beforeUuid]);
}

/**
 * 查未读锚点 + @提及（/chat/getUnreadAnchorAndMentions，字母序签名）。
 * @param {string|number|object} target 对方 UID，或 {roomId:'...'} 查群/房间频道
 * @returns {Promise<Ret>} ret.data.data：{count, firstUnreadSeq, latestUuid, mentionCount, mentions, ...}
 */
export function unread(target) {
  var q;
  if (target && typeof target === 'object' && target.roomId != null) {
    q = { appId: APP_ID, uid: String(getUid() || ''), roomId: String(target.roomId) };
  } else {
    if (target == null || target === '')
      return Promise.reject(new Error('chat.unread: target uid or roomId required.'));
    q = { appId: APP_ID, uid: String(getUid() || ''), toUid: String(target) };
  }
  return apiSigned('/chat/getUnreadAnchorAndMentions', q, { sort: true });
}

/**
 * 标记与某人的私聊已读（/pm/readPm，插入序签名；清未读红点）。只读语义但会改变服务端未读状态。
 * @param {string|number} targetUid 对方 UID
 * @param {object} [opts] {channel 私聊频道号，缺省 1}
 * @returns {Promise<Ret>} ret.ok 即已读成功
 */
export function markRead(targetUid, opts) {
  opts = opts || {};
  if (targetUid == null || targetUid === '')
    return Promise.reject(new Error('chat.markRead: targetUid required.'));
  var q = {
    appId: APP_ID,
    uid: String(getUid() || ''),
    to: String(targetUid),
    channel: opts.channel != null ? opts.channel : CHANNELS.pm,
  };
  return apiSigned('/pm/readPm', q, { sort: false });
}

/**
 * 拉频道会话摘要 + @提及（/chat/getChatHomeSummary，字母序签名，游戏 requestChannelTipInfo 同源：
 * query={appId,uid:StrUid,roomIds:'房1;房2',time}）。房号列表缺省取游戏当前 _rooms。
 * 用途：权威未读数/最后一条消息/@气泡——玩家未在游戏中打开过的频道也能拿到（本地 chatHeads 枚举不到）。
 * @param {string[]|null} [roomIds] 房号数组；缺省全部已 join 房间
 * @returns {Promise<Ret>} ret.data.data：{list:{"房号":{unreadCount,lastMessage,loadMoreMsgPoint}}, mentions:[...]}（Ret.data 为完整应答）
 */
export function summary(roomIds) {
  var ids = roomIds;
  if (!ids || !ids.length) ids = status().rooms;
  ids = (ids || []).filter(Boolean);
  var q = { appId: APP_ID, uid: getStrUid(), roomIds: ids.join(';') };
  return apiSigned('/chat/getChatHomeSummary', q, { sort: true });
}

/**
 * 拉私聊/置顶/转会等会话列表（/pm/loadChatList，插入序签名，游戏 getUserListFromServerByType 同源：
 * query={appId,uid:UID,channel,time}）。无需预先知道对方 UID 即可枚举「跟谁聊过」。
 * @param {object} [opts] {channel 会话类型：1 私聊(缺省) / 4 置顶(mod) / 8 转会，见 CHAT_CHANNEL_TYPE}
 * @returns {Promise<Ret>} ret.data.data.list 为会话条目数组（每项含双向 fu/fp/tu/tp，自己发起时取 tu/tp；schema 同私聊推送）
 */
export function pmList(opts) {
  opts = opts || {};
  var q = {
    appId: APP_ID,
    uid: String(getUid() || ''),
    channel: opts.channel != null ? opts.channel | 0 : CHANNELS.pm,
  };
  return apiSigned('/pm/loadChatList', q, { sort: false });
}

/**
 * 定位拉取某条消息前后的历史（/chat/loadHistoryAround，字母序签名，游戏 loadHistoryAround 同源：
 * query={appId,uid:StrUid,roomId,uuid,beforeCount,afterCount,time}）。
 * 用途：跳到未读锚点/回应目标/撤回消息时，本地缓冲缺该段历史则按 uuid 锚点补齐上下文。
 * @param {string} roomId 房间号（如 102_1_4336）
 * @param {string} uuid 锚点消息 uuid（历史/推送项的 uuid 字段）
 * @param {object} [opts] {beforeCount 锚点前拉几条（缺省 50）, afterCount 锚点后拉几条（游戏固定 50，可覆盖）}
 * @returns {Promise<Ret>} ret.data.data.list 为上下文消息数组（schema 同 historyRooms）
 */
export function aroundHistory(roomId, uuid, opts) {
  opts = opts || {};
  if (!roomId || !uuid)
    return Promise.reject(new Error('chat.aroundHistory: roomId and uuid required.'));
  var q = {
    appId: APP_ID,
    uid: getStrUid(),
    roomId: String(roomId),
    uuid: String(uuid),
    beforeCount: opts.beforeCount != null ? opts.beforeCount | 0 : 50,
    afterCount: opts.afterCount != null ? opts.afterCount | 0 : 50,
  };
  return apiSigned('/chat/loadHistoryAround', q, { sort: true });
}

/**
 * 查服务器系统消息（GET_CHAT_PUSH_LIST，主协议 PBV2 通道；游戏 requestChatSystemMsg 同源：
 * pack={beginSecsTime,channel[,aroundBeginSec,aroundEndSec]}，应答 pbAckV2.data.infos[]）。
 * 世界/联盟历史里 fu=="-1" 的系统条目即来自此，与聊天服务器历史合并展示；纯查询、只读安全。
 * 已发出未应答时（net.isSending 闸门，同游戏 checkRequestIdNoRes）直接返回空数组，不并发重复请求。
 * @param {object} [opts] {beginSecsTime 起始秒时刻（缺省当前服务器秒）, channel 频道号（缺省 -1 全部）,
 *     aroundBeginSec/aroundEndSec 定位上下文时段（成对 >0 才带上）}
 * @returns {Promise<Array<object>>} 已按游戏 createOneSysMsg 归一的系统消息数组（{c,m,roomId,t,uuid,uid:"-1",fu:"-1",isGameMsg,...params}），
 *     可直接喂 normalize/classify（fu=="-1" 命中系统模板分支）；闸门/失败返回空数组
 */
export function systemMessages(opts) {
  opts = opts || {};
  var net = netApi;
  if (!net) return Promise.reject(new Error('chat.systemMessages: pocketcc.net unavailable.'));
  var cmd = resolveSysCmd();
  if (net.isSending(cmd)) return Promise.resolve([]); // 在途去重闸门（同游戏）
  var pack = {
    beginSecsTime: opts.beginSecsTime != null ? opts.beginSecsTime | 0 : serverTimeSec(),
    channel: opts.channel != null ? opts.channel | 0 : -1,
  };
  if (opts.aroundBeginSec > 0 && opts.aroundEndSec > 0) {
    pack.aroundBeginSec = opts.aroundBeginSec | 0;
    pack.aroundEndSec = opts.aroundEndSec | 0;
  }
  return net.sendPBV2(cmd, pack).then(function (ret) {
    var infos = ret && ret.ok && ret.data && ret.data.infos ? ret.data.infos : [];
    var out = [];
    for (var i = 0; i < infos.length; i++) out.push(toSysItem(infos[i]));
    return out;
  });
}

/**
 * 给一个发包 Promise 套上超时：到点未 settle 即 reject（同 net.js，迟到应答无害空操作）
 * @param {Promise<Ret>} p 原始发包 Promise
 * @param {string} label 错误信息标签
 * @returns {Promise<Ret>}
 */
export function withTimeout(p, label) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error(label + ' no server response in ' + SEND_TIMEOUT_MS + 'ms.'));
    }, SEND_TIMEOUT_MS);
    p.then(
      function (v) {
        clearTimeout(timer);
        resolve(v);
      },
      function (e) {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
