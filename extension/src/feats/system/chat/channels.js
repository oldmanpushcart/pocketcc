/**
 * 聊天窗口 · 频道/会话切片：推送入缓冲、渲染、侧栏会话列表、私聊玩家信息、频道切换、成员表。
 * 依赖方向红线：本文件只 import core 原语 + context + normalize（兄弟切片一律不 import）；
 * 对兄弟切片的调用统一走 S.fns（装配前由各切片登记，运行期安全）。文件末尾把本切片公开函数登记进 S.fns。
 */
import { safeParse } from '../../../core/util.js';
import { gameData, avatar } from '../../../core/game-api.js';
import { storage } from '../../../core/storage.js';
import { chatApi } from '../../../core/chat.js';
import { netApi } from '../../../core/net.js';
import {
  S,
  log,
  bufOf,
  BUF_LIMIT,
  MAX_PULL_PAGES,
  PM_INFO_STORE_KEY,
  PM_INFO_TTL_MS,
  PM_INFO_GAP_MS,
  MEMBERS_TTL_MS,
  CHAN_DEFS,
} from './context.js';
import { CMD_ALLIANCE_MEMBERS, CMD_PLAYER_INFO } from './constants.js';
import {
  buildEntry,
  insertOrdered,
  familyOf,
  chanKeyOf,
  chanLabelOfKey,
  isDynamicRoomChan,
  myUid,
  myStrUid,
  toMs,
  pickField,
} from './normalize.js';

/**
 * 入缓冲（uuid 去重 + 乐观条目合并 + 未读计数 + 环形裁剪）
 * @param {string} key 会话键
 * @param {object} entry 条目
 * @returns {boolean} 是否真正新增
 */
function pushEntry(key, entry) {
  var b = bufOf(key);
  if (b.ids.has(entry.id)) return false;
  if (entry.self && String(entry.id).indexOf('local:') !== 0) {
    // 真回声：合并掉同文本的乐观条目（self + local: 前缀 + 60s 时窗内文本相同 → 原位替换）
    for (var i = b.list.length - 1; i >= 0; i--) {
      var o = b.list[i];
      if (
        o.self &&
        String(o.id).indexOf('local:') === 0 &&
        o.plain === entry.plain &&
        Math.abs(entry.timeMs - o.timeMs) < 60000
      ) {
        b.ids.delete(o.id);
        b.list[i] = entry;
        b.ids.add(entry.id);
        S.fns.refreshView(key);
        return false;
      }
    }
  }
  var atTail = insertOrdered(b, entry); // 常态追尾；系统/战报补投带历史时间戳时按时间序插入
  while (b.list.length > BUF_LIMIT) {
    var drop = b.list.shift();
    b.ids.delete(drop.id);
  }
  b.lastAt = Math.max(b.lastAt, entry.timeMs);
  if (!entry.self) {
    b.speakers.set(entry.uid, entry.name); // 近期发言者（@选人数据源）
    if (S.overlay && !(S.overlay.isVisible() && key === S.activeKey)) b.unread++;
  }
  if (S.overlay && S.overlay.isVisible() && key === S.activeKey) {
    // 追尾走增量（贴底自动跟随、否则浮标）；乱序插入按时间重排整列并保持阅读位置
    if (atTail) S.overlay.appendMessage(entry);
    else S.overlay.renderMessages(b.list, true);
  }
  return true;
}

/** 乐观条目替换真回声后刷新当前视图 */
function refreshView(key) {
  if (S.overlay && S.overlay.isVisible() && key === S.activeKey)
    S.overlay.renderMessages(bufOf(key).list);
}

/**
 * 收信入口（EventCenter 载荷可能单项或数组）
 * @param {string} kind 'push'|'pm'
 * @param {object|object[]} payload 原始项
 * @returns {void}
 */
function ingest(kind, payload) {
  var chat = chatApi;
  if (!chat) return;
  var items = Array.isArray(payload) ? payload : [payload];
  for (var raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      var r = buildEntry(raw, kind, S.cfg.showDate);
      // 发送者名只用于初始化私聊会话标题；动态房/固定频道不得拿玩家名当 title（否则侧栏活动名被污染）
      var b = bufOf(
        r.key,
        r.key.indexOf('pm:') === 0 && !r.self && r.entry.name ? r.entry.name : undefined,
      );
      if (r.self && r.key.indexOf('pm:') === 0 && b.title !== b.key)
        r.entry.pmDir = '-> ' + b.title; // 实时追加路径也要带方向标注
      if (raw.roomId) b.roomId = String(raw.roomId);
      S.fns.pushEntry(r.key, r.entry);
    } catch (e) {
      log.warn('ingest %s failed: %s', kind, e && e.message);
    }
  }
  S.fns.broadcastUnread();
}

/**
 * 按 uuid 原位转「撤回」占位：并入 deletedAt 后重建条目（分类层出 revoke 卡），不物理移除。
 * 原条目不在缓冲时不凭空补入（避免造无上下文占位），返回 false。
 * @param {string} id uuid 串
 * @param {number} deletedAt 撤回时间戳（仅判 >0 触发 revoke 分类）
 * @returns {boolean} 命中并重建返回 true
 */
function revokeInPlace(id, deletedAt) {
  for (var b of S.bufs.values()) {
    var idx = b.list.findIndex((e) => e.id === id);
    if (idx < 0) continue;
    var merged = Object.assign({}, b.list[idx].raw || {}, { deletedAt: deletedAt });
    try {
      var r = buildEntry(merged, +merged.c === 1 ? 'pm' : 'push', S.cfg.showDate);
      r.entry.id = id; // 锁回原 uuid，避免合并后 id 漂移
      b.list[idx] = r.entry;
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * 删除/撤回推送（chatdel）：与游戏同源——带 deletedAt 的原位转「撤回」占位卡（保留气泡，
 * 游戏 deleteChatMsg 是空存根、撤回实由 chatdel→onChatUpdate 的 deletedAt 支做原位替换），
 * 无 deletedAt 的纯删除仍按 uuid 物理移除。单项/数组载荷均支持。
 */
function onDel(payload) {
  var arr = Array.isArray(payload) ? payload : [payload];
  var removeIds = new Set();
  var touched = false;
  for (var p of arr) {
    if (!p || typeof p !== 'object' || p.uuid == null) continue;
    if ((+p.deletedAt || 0) > 0) {
      if (S.fns.revokeInPlace(String(p.uuid), +p.deletedAt)) touched = true;
    } else removeIds.add(String(p.uuid));
  }
  if (removeIds.size) {
    for (var b of S.bufs.values()) {
      var before = b.list.length;
      b.list = b.list.filter((e) => {
        if (removeIds.has(e.id)) {
          b.ids.delete(e.id);
          return false;
        }
        return true;
      });
      if (b.list.length !== before) touched = true;
    }
  }
  if (touched && S.overlay && S.overlay.isVisible()) S.fns.renderActive();
}

/**
 * 更新推送（chatupdate）：按 uuid 原位合并补丁字段后重建条目（llm/ct/deletedAt 变化会重分类：
 * 坐标回填→可跳转、deletedAt>0→撤回卡）。找不到原条目则当新消息入列（best-effort）。
 */
function onUpdate(payload) {
  var arr = Array.isArray(payload) ? payload : [payload];
  for (var p of arr) {
    if (!p || typeof p !== 'object' || p.uuid == null) continue;
    var id = String(p.uuid);
    var owner = null;
    for (var b of S.bufs.values()) {
      for (var e of b.list) {
        if (e.id === id) {
          owner = b;
          break;
        }
      }
      if (owner) break;
    }
    if (owner) {
      var idx = owner.list.findIndex((e) => e.id === id);
      var merged = Object.assign({}, owner.list[idx].raw || {}, p); // 补丁覆盖原 raw（不 mutate 原对象）
      try {
        var r = buildEntry(merged, +merged.c === 1 ? 'pm' : 'push', S.cfg.showDate);
        r.entry.id = id; // 锁回原 uuid，避免合并后 id 漂移
        owner.list[idx] = r.entry;
        if (S.overlay && S.overlay.isVisible() && owner.key === S.activeKey) S.fns.renderActive();
      } catch (e2) {
        /* 重建失败保留原条目 */
      }
    } else {
      if (p.m != null || p.content != null) S.fns.ingest(+p.c === 1 ? 'pm' : 'push', p);
    }
  }
}

/**
 * CHAT_INFO_LIST(10919) 实时推送：被攻击/主动攻击等系统战报消息（与 systemMessages 拉取同构的 infos）。
 * 复用 chat.toSysItem 归一（fu="-1" 命中系统模板分支）→ S.fns.ingest('push') 按 uuid 去重入相应频道缓冲
 * （非当前频道计未读、当前频道 appendMessage 实时追底）。纯接收，不改游戏状态。
 * @param {object} ev net Event（net 已剥 pbAckV2 信封，ev.data 即 {infos}，兼容 JSON 串）
 * @returns {void}
 */
function onChatInfoList(ev) {
  var chat = chatApi;
  if (!chat || !chat.toSysItem) return;
  var d = ev && ev.data;
  if (typeof d === 'string') d = safeParse(d);
  var infos = (d && d.infos) || null;
  if (!Array.isArray(infos) || !infos.length) return;
  var sys = [];
  for (var it of infos) {
    try {
      sys.push(chat.toSysItem(it));
    } catch (e) {
      /* 单项脏数据跳过 */
    }
  }
  if (sys.length) S.fns.ingest('push', sys);
}

/** 按 uuid 移除一条 */
function delOne(id) {
  for (var b of S.bufs.values()) {
    for (var i = 0; i < b.list.length; i++) {
      if (b.list[i].id === id) {
        b.list.splice(i, 1);
        b.ids.delete(id);
        if (S.overlay && S.overlay.isVisible() && b.key === S.activeKey) S.fns.renderActive();
        return;
      }
    }
  }
}

/** 未读角标广播（overlay 一次刷全；pm:/cross: 会话的未读另聚合到家族 chip） */
function broadcastUnread() {
  if (!S.overlay) return;
  var map = {};
  var fam = { pm: 0, cross: 0 };
  for (var [k, b] of S.bufs) {
    if (!b.unread) continue;
    map[k] = b.unread;
    if (k.indexOf('pm:') === 0) fam.pm += b.unread;
    else if (familyOf(k) === 'cross') fam.cross += b.unread;
  }
  if (fam.pm) map.pm = (map.pm || 0) + fam.pm;
  if (fam.cross) map.cross = (map.cross || 0) + fam.cross;
  S.overlay.setUnread(map);
  if (S.overlay.isVisible()) S.fns.updateSide(); // 侧栏未读数同步
}

/** 重绘当前视图（含私聊方向标注） */
function renderActive() {
  if (!S.overlay) return;
  var b = bufOf(S.activeKey);
  var list = b.list;
  if (b.key.indexOf('pm:') === 0) {
    var other = b.title !== b.key ? b.title : '';
    for (var e of list) e.pmDir = e.self ? '-> ' + other : '';
  }
  // 切频道先重置顶部状态（在 renderMessages 前，避免覆盖随后 #fillViewport 同步触发的 loading）：私聊无翻页、频道达上限显“全部”
  S.fns.setStatus(b.key.indexOf('pm:') === 0 ? '' : b.pullPages >= MAX_PULL_PAGES ? 'end' : '');
  S.overlay.renderMessages(list);
  b.unread = 0;
  b.readOnce = true; // 本会话已查看：后续 applySummary 不再用服务端未读覆盖（交本地增量/清零接管）
  S.fns.broadcastUnread();
}

// ─────────────────────── 侧栏会话列表（微信 PC 风双列） ───────────────────────

/** 侧栏副行：最后一条消息预览 */
function lastSub(b) {
  var last = b.list.length ? b.list[b.list.length - 1] : null;
  if (last) return String(last.name || '') + ': ' + String(last.plain || '').slice(0, 18);
  return b.lastPreview ? String(b.lastPreview).slice(0, 24) : ''; // 缓冲未加载时用 summary 的服务端最后一条兜底
}

/**
 * 重建左侧会话列表。pm：缓冲 + chatHeads c=1（loadChatList 产物，含浮层装前会话）；
 * cross：chatHeads 全部动态房条目（跨服 3、KVK、无双峡谷、联盟对决等活动房间，
 * 随活动出现/消亡，游戏吸收 roomChatChange 后维护条目，我们只读同源）+ 已知缓冲；
 * 无房间时给空态占位（发送不携 roomId，服务器路由，仍可发）。
 * @returns {void}
 */
function updateSide() {
  if (!S.overlay) return;
  var fam = familyOf(S.activeKey);
  if (!fam) {
    S.overlay.setSideList([], S.activeKey);
    return;
  }
  var chat = chatApi;
  var heads = chat && chat.chatHeads ? chat.chatHeads() : [];
  var items = [];
  var has = new Set();
  if (fam === 'pm') {
    for (var [k, b] of S.bufs) {
      if (k.indexOf('pm:') !== 0) continue;
      has.add(k);
      items.push({
        key: k,
        title: b.title !== k ? b.title : 'U' + k.slice(-4),
        sub: S.fns.pmInfoText(k),
        unread: b.unread,
        ts: b.lastAt,
        avatar: (S.pmInfoCache.get(k) || {}).av,
      });
    }
    for (var h of heads) {
      if (h.channel !== 1 || !h.id) continue;
      var pk = 'pm:' + h.id;
      if (has.has(pk)) continue;
      has.add(pk);
      if (h.name) bufOf(pk).title = h.name;
      var pb = bufOf(pk);
      items.push({
        key: pk,
        title: pb.title !== pk ? pb.title : 'U' + String(h.id).slice(-4),
        sub: S.fns.pmInfoText(pk),
        unread: pb.unread,
        ts: pb.lastAt,
        avatar: (S.pmInfoCache.get(pk) || {}).av,
      });
    }
  } else {
    for (var h2 of heads) {
      if (!h2.id || !isDynamicRoomChan(h2.channel)) continue;
      var ck = chanKeyOf(h2.channel) + ':' + h2.id;
      var cb = bufOf(ck);
      cb.roomId = String(h2.id);
      cb.c = h2.channel;
      if (h2.name && cb.title === ck) cb.title = h2.name;
      if (has.has(ck)) continue;
      has.add(ck);
      items.push({
        key: ck,
        title: cb.title !== ck ? cb.title : chanLabelOfKey(ck),
        sub: S.fns.lastSub(cb),
        unread: cb.unread,
        ts: cb.lastAt,
      });
    }
    for (var [k3, b3] of S.bufs) {
      // 推信学过但 chatHeads 尚无条目的房间也列出
      if (has.has(k3) || familyOf(k3) !== 'cross' || k3 === 'cross') continue;
      items.push({
        key: k3,
        title: b3.title !== k3 ? b3.title : chanLabelOfKey(k3),
        sub: S.fns.lastSub(b3),
        unread: b3.unread,
        ts: b3.lastAt,
      });
    }
    if (!items.length) items.push({ key: 'cross', title: '跨服', sub: '暂无跨服/活动频道', ts: 0 });
  }
  items.sort((a, b2) => (b2.ts || 0) - (a.ts || 0));
  S.overlay.setSideList(items, S.activeKey);
}

/**
 * 私聊侧栏副行：对方基本信息（区/等级/power，用户口径不显聊天内容）；只读缓存，
 * 未命中不再入队（避免进私聊 TAB 整列会话批量抓 630）——改由点开该会话 / 查看信息时按需刷新。
 * @param {string} pk 'pm:<uid>'
 * @returns {string}
 */
function pmInfoText(pk) {
  var ci = S.pmInfoCache.get(pk);
  return ci ? ci.txt : '';
}

/** 消费队列：每轮最多发一个 630，完成（含失败）后隔 PM_INFO_GAP_MS 再下一个 */
function servePmInfo() {
  if (S.pmInfoServing) return;
  var pk = S.pmInfoQueue.shift();
  if (!pk) return;
  var uid = pk.slice(3);
  var net = netApi;
  if (!net || !/^\d+$/.test(uid)) {
    S.pmInfoCache.set(pk, { state: 'fail', txt: '' });
    S.fns.servePmInfo();
    return;
  } // 不可查形态直接定案，不占带宽
  S.pmInfoServing = true;
  S.pmInfoCache.set(pk, { state: 'pending', txt: '' });
  net
    .send(CMD_PLAYER_INFO, { uid })
    .then((ret) => {
      var d = safeParse(ret && ret.data);
      if (!ret || !ret.ok || !d || typeof d !== 'object') {
        S.pmInfoCache.set(pk, { state: 'fail', txt: '' });
        return;
      }
      S.fns.pmStoreSet(uid, d); // 回填内存视图缓存 + 写穿盘
      if (S.overlay && S.overlay.isVisible() && familyOf(S.activeKey) === 'pm') S.fns.updateSide();
    })
    .catch(() => {
      S.pmInfoCache.set(pk, { state: 'fail', txt: '' });
    })
    .finally(() => {
      S.pmInfoServing = false;
      if (S.pmInfoQueue.length) setTimeout(servePmInfo, PM_INFO_GAP_MS);
    });
}

/**
 * 630 应答 → 侧栏副行文本（区 · 等级 · 战力），servePmInfo 与盘缓存回填共用。
 * @param {object} d 应答顶层 parse 产物
 * @returns {string}
 */
function pmBitsText(d) {
  var b = [];
  if (d.serverId != null) b.push('区 ' + d.serverId);
  if (d.level != null) b.push('Lv.' + d.level);
  if (d.power != null) b.push('战力 ' + S.fns.fmtPower(d.power));
  return b.join(' · ');
}

/**
 * 写穿：一个玩家的 630 应答同时回填内存视图缓存（pmInfoCache）并落 data blob（整块 {uid:{d,ts}}）。
 * 存的是完整 d，将来扩充展示字段无需重查（盘里已有）。
 * @param {string} uid 对方 uid（非数字串直接跳过）
 * @param {object} d 630 应答顶层 parse 产物
 * @returns {void}
 */
function pmStoreSet(uid, d) {
  uid = String(uid == null ? '' : uid);
  if (!/^\d+$/.test(uid) || !d || typeof d !== 'object') return;
  var ts = Date.now();
  S.pmInfoStore[uid] = { d: d, ts: ts };
  try {
    Promise.resolve(storage.data.set(PM_INFO_STORE_KEY, Object.assign({}, S.pmInfoStore))).catch(
      () => {},
    );
  } catch (e) {}
  var pk = 'pm:' + uid;
  S.pmInfoCache.set(pk, {
    state: 'done',
    txt: S.fns.pmBitsText(d),
    av: S.fns.resolveAvatar(d, { uid: uid, name: (bufOf(pk) && bufOf(pk).title) || '' }),
    d: d,
    ts: ts,
  });
}

/**
 * 装载私聊玩家信息盘缓存（仅成功读盘后定案 loaded），回填 pmInfoCache，
 * 使进私聊 TAB 直接显缓存、不批量重抓。命名空间未就绪时 reject 不落 loaded，下次进私聊再试。
 * @returns {Promise<void>} 读盘（或已 loaded 时的立即 resolve），供 backfillPmInfo 串接
 */
function loadPmInfoCache() {
  if (S.pmInfoDiskLoaded) return Promise.resolve();
  return storage.data
    .get(PM_INFO_STORE_KEY)
    .then((blob) => {
      S.pmInfoDiskLoaded = true;
      if (!blob || typeof blob !== 'object') return;
      S.pmInfoStore = blob;
      for (var uid in S.pmInfoStore) {
        var rec = S.pmInfoStore[uid];
        if (!rec || !rec.d || typeof rec.d !== 'object') continue;
        var pk = 'pm:' + uid;
        var cur = S.pmInfoCache.get(pk);
        if (cur && cur.state === 'done' && (cur.ts || 0) >= (rec.ts || 0)) continue; // 内存比盘新（本次已查）不覆盖
        S.pmInfoCache.set(pk, {
          state: 'done',
          txt: S.fns.pmBitsText(rec.d),
          av: S.fns.resolveAvatar(rec.d, { uid: uid, name: (bufOf(pk) && bufOf(pk).title) || '' }),
          d: rec.d,
          ts: rec.ts || 0,
        });
      }
      if (S.overlay && S.overlay.isVisible() && familyOf(S.activeKey) === 'pm') S.fns.updateSide();
    })
    .catch(() => {
      /* 读盘失败/命名空间未就绪：下次进私聊再试 */
    });
}

/**
 * 切进某个私聊会话时按需刷新该玩家信息：缓存缺失或超过 TTL 才查，
 * 走既有串行队列（servePmInfo），避免快速切会话爆发式查询。
 * @param {string} key 会话键（'pm:<uid>' 才处理）
 * @returns {void}
 */
function maybeRefreshPmInfo(key) {
  if (!key || key.indexOf('pm:') !== 0) return;
  var uid = key.slice(3);
  if (!/^\d+$/.test(uid)) return;
  var ci = S.pmInfoCache.get(key);
  var stale = !ci || ci.state !== 'done' || Date.now() - (ci.ts || 0) > PM_INFO_TTL_MS;
  if (!stale) return;
  if (S.pmInfoQueue.indexOf(key) < 0) S.pmInfoQueue.push(key);
  S.fns.servePmInfo();
}

/**
 * 进私聊 TAB 时回填空数据：扫描全部会话（缓冲 pm: + chatHeads c=1），仅把「无 done 缓存」
 * 的玩家入既有串行队列（servePmInfo，500ms 限速、非并行）逐个补查。盘缓存命中者不重抓，
 * 故冷启动一次性补齐后，后续进 TAB 几乎无空位、不再批量抓。与 maybeRefreshPmInfo 共用队列去重。
 * @returns {void}
 */
function backfillPmInfo() {
  var chat = chatApi;
  var keys = new Set();
  for (var [k] of S.bufs) {
    if (k.indexOf('pm:') === 0) keys.add(k);
  }
  if (chat && chat.chatHeads) {
    for (var h of chat.chatHeads()) {
      if (h.channel === 1 && h.id) keys.add('pm:' + h.id);
    }
  }
  var enq = 0;
  for (var key of keys) {
    var uid = key.slice(3);
    if (!/^\d+$/.test(uid)) continue; // 非数字 uid（StrUid 等）不可查，跳过不占带宽
    var ci = S.pmInfoCache.get(key);
    if (ci && ci.state === 'done') continue; // 已有（盘/本次）不重抓
    if (ci && ci.state === 'pending') continue; // 在途
    if (ci && ci.state === 'fail') continue; // 已定案失败，不在此重试（点开时 maybeRefreshPmInfo 再试）
    if (S.pmInfoQueue.indexOf(key) < 0) {
      S.pmInfoQueue.push(key);
      enq++;
    }
  }
  if (enq) S.fns.servePmInfo();
}

// ─────────────────────── 私聊会话枚举 (/pm/loadChatList) ───────────────────────

/**
 * 用 /pm/loadChatList 枚举全部私聊会话（含游戏 UI 未打开过的），补进 pm:<uid> 缓冲的标题/时间。
 * 只读补全，不改游戏任何状态；对方昵称从 profile(fp/tp) 解析（自己发出的行取 tp、收到的行取 fp），
 * 拉不到名字时保留 U尾号 占位。完成时若正停在私聊家族则刷左侧列表。
 * @returns {Promise<void>|undefined} 无 pmList API 时返回 undefined
 */
function seedPmList() {
  if (S.pmListFetched) return undefined;
  if (S.pmListPromise) return S.pmListPromise;
  var chat = chatApi;
  if (!chat || !chat.pmList) return undefined;
  S.pmListPromise = (async () => {
    try {
      var ret = await chat.pmList({ channel: 1 });
      var list = (ret && ret.data && ret.data.data && ret.data.data.list) || [];
      var meS = myStrUid();
      var meU = myUid();
      for (var it of list) {
        var fu = String(it.fu || '');
        var tu = String(it.tu || '');
        var selfSent = !!fu && (fu === meS || fu === meU);
        var other = selfSent ? tu : fu;
        if (!other || other === meS || other === meU) continue;
        var prof = safeParse(selfSent ? it.tp : it.fp) || {};
        var pk = 'pm:' + other;
        var pb = bufOf(pk);
        if (prof.username && pb.title === pb.key) pb.title = String(prof.username);
        pb.lastAt = Math.max(
          pb.lastAt,
          toMs(it.t != null ? it.t : null, it.time != null ? it.time : null),
        );
      }
      S.pmListFetched = true;
      if (S.overlay && S.overlay.isVisible() && familyOf(S.activeKey) === 'pm') S.fns.updateSide();
    } catch (e) {
      log.warn('pm list seed failed: %s', e && e.message);
    } finally {
      S.pmListPromise = null;
    }
  })();
  return S.pmListPromise;
}

// ─────────────────────── 频道切换与视图 ───────────────────────

/**
 * 重建快捷栏/更多菜单并下发 overlay（配置或会话集变化时调用）。
 * 私聊会话不再列入「更多」菜单——已由左侧列表（updateSide）承载。
 * @returns {void}
 */
function syncChannels() {
  if (!S.overlay) return;
  var quick = CHAN_DEFS.filter((d) => S.cfg.quick[d.key]).map((d) => ({
    key: d.key,
    label: d.label,
  }));
  var more = CHAN_DEFS.filter((d) => !S.cfg.quick[d.key]).map((d) => ({
    key: d.key,
    label: d.label,
  }));
  // pm:xxx / cross:xxx 选中时高亮其家族 chip
  S.overlay.setChannels(quick, more, familyOf(S.activeKey) || S.activeKey);
  S.fns.updateSide();
}

/**
 * 切换当前视图
 * @param {string} key 会话键
 * @returns {void}
 */
function activateKey(key) {
  if (key === 'pm') {
    var cacheP = S.fns.loadPmInfoCache(); // 进私聊家族：先用盘缓存回填侧栏（不批量重抓）
    var listP = S.fns.seedPmList(); // 异步枚举全部私聊会话补入左侧列表（不阻塞当前 chip 选中）
    // 盘缓存 + 会话列表都就绪后，回填空数据玩家（串行逐个，非并行）
    Promise.all([Promise.resolve(cacheP), Promise.resolve(listP)]).then(
      backfillPmInfo,
      backfillPmInfo,
    );
    // 私聊 chip：先用游戏会话列表（chatHeads c=1，含浮层装前会话）预建缓冲，再进最近一个
    var chat0 = chatApi;
    if (chat0 && chat0.chatHeads) {
      for (var h0 of chat0.chatHeads()) {
        if (h0.channel !== 1 || !h0.id) continue;
        var pb0 = bufOf('pm:' + h0.id);
        if (h0.name && pb0.title === pb0.key) pb0.title = h0.name;
      }
    }
    var latest = null;
    for (var [k, b] of S.bufs)
      if (k.indexOf('pm:') === 0 && (!latest || b.lastAt > latest.ts)) latest = { k, ts: b.lastAt };
    if (!latest) {
      if (S.overlay) {
        S.overlay.setActive(key);
        S.activeKey = key;
        S.overlay.renderMessages([]);
        S.overlay.toast('双击消息或点发送者名字开私聊');
        S.fns.updateSide();
      }
      return;
    }
    key = latest.k;
  } else if (key === 'cross') {
    // 跨服 chip：进最近有消息的活动/跨服房间；都没有则进空态缓冲（发送不携 roomId，服务器路由）
    S.fns.syncRoomIdsCross();
    var first = null;
    for (var [k2, b2] of S.bufs)
      if (k2 !== 'cross' && familyOf(k2) === 'cross' && (!first || b2.lastAt > first.ts))
        first = { k: k2, ts: b2.lastAt };
    if (first && first.ts) key = first.k;
  }
  S.activeKey = key;
  S.fns.maybeRefreshPmInfo(key); // 切进具体私聊会话：缓存缺失/过期才刷新该一个（不批量抓）
  var ab = bufOf(key);
  ab.pullPages = 0; // 重新进入允许再拨一段旧史（MAX_PULL_PAGES 是单次进入的防 runaway 上限）
  if (S.overlay) {
    S.overlay.setActive(familyOf(key) || key);
    S.overlay.setTitle(S.fns.viewTitle(key));
    S.fns.renderActive();
  } // chip 高亮按家族键（pm:xxx/cross:xxx 归 pm/cross）
  S.fns.ensureHistory(key);
  S.fns.syncChannels();
}

/**
 * 标题栏文本：预置频道用 label；pm:/cross: 会话用对方昵称/房间名
 * @param {string} key 会话键
 * @returns {string}
 */
function viewTitle(key) {
  var d = CHAN_DEFS.find((x) => x.key === key);
  if (d && key.indexOf(':') < 0) return d.label;
  var b = S.bufs.get(key);
  if (!b) return '聊天';
  if (key.indexOf('pm:') === 0)
    return '私聊 · ' + (b.title !== key ? b.title : 'U' + key.slice(-4));
  if (familyOf(key) === 'cross' && key.indexOf(':') > 0)
    return b.title !== key ? b.title : chanLabelOfKey(key);
  return b.title !== key ? b.title : '聊天';
}

/**
 * 跨服/活动房间对账（游戏侧 roomChatChange 进/退房的同源结果在 _chatList.other）：
 * chatHeads 动态房条目 → 建/补 <chanKey>:<roomId> 缓冲；随活动出现的房间由此感知。
 * @returns {void}
 */
function syncRoomIdsCross() {
  var chat = chatApi;
  if (!chat || !chat.chatHeads) return;
  for (var h of chat.chatHeads()) {
    if (!h.id || !isDynamicRoomChan(h.channel)) continue;
    var key = chanKeyOf(h.channel) + ':' + h.id;
    var b = bufOf(key);
    b.c = h.channel;
    if (!b.roomId) b.roomId = String(h.id);
    if (h.name && b.title === key) b.title = h.name;
  }
}

// ─────────────────────── 发送 ───────────────────────

/** @type {{[k:string]: string}} 未知应答形态兜底时的字段→中文标签 */
const INFO_LABELS = {
  name: '名字',
  nickname: '昵称',
  nickName: '昵称',
  level: '等级',
  power: '战力',
  combat: '战力',
  vipLevel: 'VIP',
  headIcon: '头像',
  serverId: '服号',
  sex: '性别',
  allianceName: '联盟',
  alliance: '联盟',
  aid: '联盟ID',
  pos: '坐标',
  x: '坐标X',
  y: '坐标Y',
  title: '称号',
  pwr: '战力',
};

/** 战力/大数字单位阶梯：与游戏 NumUtils.getLargeNumberShow 完全一致 —— K,M,B,T 后接 aa..zz，每档 ×1000（下标 j 对应阈值 1000^(len-j)） */
const POWER_UNITS = (function () {
  var u = ['K', 'M', 'B', 'T'];
  for (var c = 97; c <= 122; c++) u.push(String.fromCharCode(c) + String.fromCharCode(c));
  return u; // 长度 30
})();

/**
 * 战力/大数字显示：复刻游戏 NumUtils.getLargeNumberShow 口径（逐字对齐）。
 * 单位阶梯 K(1e3)/M(1e6)/B(1e9)/T(1e12)/aa(1e15)/bb(1e18)…每×1000 进一档。
 * 有效数字约 3 位：尾数>100 取整、>10 留 1 位、否则留 2 位；默认向下截断（与游戏默认一致），round=true 才四舍五入。
 * <1000：普通数字串（plain=true 时取整）；<=0 → "0"；null/空 → ""。
 * @param {number|string} v 数值
 * @param {boolean} [round] 是否四舍五入（游戏默认 false=截断）
 * @param {boolean} [plain] 小于 1000 时是否取整（游戏默认 false）
 * @returns {string}
 */
function fmtPower(v, round, plain) {
  if (v == null || v === '') return '';
  v = +v;
  if (!(v > 0)) return '0';
  var len = POWER_UNITS.length;
  for (var n = 0; n < len; n++) {
    var r = 1e3;
    for (var s = n + 1; s < len; s++) r *= 1e3; // r = 1000^(len - n)，从大阈值往下扫，首个 v>=r 即为当档
    if (v >= r) {
      var l = v > 100 * r ? 0 : v > 10 * r ? 1 : 2;
      var unit = POWER_UNITS[len - n - 1];
      if (round) return (v / r).toFixed(l) + unit;
      var c = Math.pow(10, l);
      return Math.floor(v / (r / c)) / c + unit;
    }
  }
  return plain ? v.toFixed() : String(v);
}

/**
 * PLAYER_INFO(630) 应答→信息行（schema 已真机实证：顶层 level/power/armyPower/allianceName/x/y…，
 * 其中 playerInfo 字段是微信绑定资料的内层 JSON 串，昵称在其 username 里；未知形态兜底标量全列）。
 * 坐标行携带跳转 action（serverId 作跨服服号），视图层渲染为可点链接→ onJump 飞图。
 * @param {object} d 应答顶层 parse 产物
 * @param {string} [uid] 查询目标玩家 UID（应答顶层无 uid 字段时的兜底）
 * @returns {Array<string|{s:string, action?:object, copy?:string}>}
 */
function infoLines(d, uid) {
  var lines = [];
  if (!d || typeof d !== 'object') return lines;
  if (d.level != null) lines.push('等级: ' + d.level);
  if (d.power != null) lines.push('战力: ' + S.fns.fmtPower(d.power));
  // armyPower 暂不展示：换算公式未明（用户口径）
  if (d.allianceName)
    lines.push('联盟: ' + d.allianceName + (d.allianceTag ? ' [' + d.allianceTag + ']' : ''));
  if (d.x != null && d.y != null)
    lines.push({
      s: '坐标: ' + d.x + ',' + d.y + (d.serverId != null ? '@' + d.serverId : ''),
      action: {
        type: 'pos',
        x: +d.x,
        y: +d.y,
        z: d.serverId != null ? +d.serverId : null,
        click: true,
      },
    });
  if (d.serverId != null) lines.push('服务器: ' + d.serverId);
  if (d.like != null) lines.push('获赞: ' + d.like);
  if (!lines.length) {
    // 兜底：已知字段全缺（协议漂移/异常应答）时标量全列；在 UID 行插入前判定，防其恒在把兜底挤成死代码
    for (var k in d) {
      if (lines.length >= 14) break;
      if (k === 'uid') continue; // UID 另有专行，避免重复
      var v = d[k];
      if (v == null || typeof v === 'object') continue;
      lines.push((INFO_LABELS[k] || INFO_LABELS[k.toLowerCase()] || k) + ': ' + String(v));
    }
  }
  var shownUid = d.uid != null ? String(d.uid) : uid != null && uid !== '' ? String(uid) : '';
  // UID 行带 copy 动作 → 视图层渲染为复制链接（点击即拷、不关卡片）；14 位数字串直显，禁止 Number 化防精度丢失
  if (shownUid) lines.unshift({ s: 'UID: ' + shownUid, copy: shownUid });
  return lines;
}

/**
 * 从 630 应答取展示昵称（微信资料内层串优先，回退消息条目携带的名字）。
 * @param {object} d 应答顶层 parse 产物
 * @returns {string}
 */
function infoNick(d) {
  var wx = safeParse(d && d.playerInfo);
  return String((wx && (wx.username || wx.nickname)) || (d && d.nickname) || '');
}

/** @type {string[]} 头像 URL 取值优先级（复刻游戏 PlayerInfoTool.d：avatarurl‖headimgurl_custom‖headimgurl） */
const AVATAR_KEYS = ['avatarurl', 'headimgurl_custom', 'headimgurl'];

/**
 * 630 应答→头像描述子（纯只读，不新增请求；数据即 onNameInfo/servePmInfo 已收到的那条 630）。
 * 真机待验：头像三键在顶层 d 还是内层 playerInfo 串——两处都探；游戏的性别默认头像是本地图集精灵名
 * （icon_man01_1 等，非 URL），渲染不了 → url 空则由视图层走首字母占位。
 * @param {object} d PLAYER_INFO(630) 应答顶层 parse 产物
 * @param {{uid?:string, name?:string}} [entry] 触发条目的 uid/名字（占位与配色兜底）
 * @returns {{url:string, initial:string, hue:number}}
 */
function resolveAvatar(d, entry) {
  var wx = safeParse(d && d.playerInfo);
  var src = [wx, d]; // 内层资料串优先，其次顶层（真机键位未定，两处都探）
  var rawVal = '';
  var usedKey = '';
  for (var i = 0; i < src.length && !rawVal; i++) {
    var o = src[i];
    if (!o || typeof o !== 'object') continue;
    for (var k = 0; k < AVATAR_KEYS.length; k++) {
      var v = o[AVATAR_KEYS[k]];
      if (typeof v === 'string' && v.trim()) {
        rawVal = v.trim();
        usedKey = AVATAR_KEYS[k];
        break;
      }
    }
  }
  // 头像字段可能是 http(s) 真实 URL（平台/用户上传），也可能是游戏自带头像图集名（hero_icon…_global 等，
  // 非 URL，直接塑 <img> 会 404）→ 统一交 core/game-api avatar.iconUrl 换算（图集名走游戏 PathUtils.GetIconURL）。
  var url = rawVal ? avatar.iconUrl(rawVal) : '';
  if (usedKey) log.info('playerInfo avatar hit: %s -> %s', usedKey, url ? 'url' : 'placeholder');
  var nick = S.fns.infoNick(d) || (entry && entry.name) || '';
  var uid = String((entry && entry.uid) || (d && d.uid) || '');
  var initial = nick ? Array.from(nick)[0].toUpperCase() : uid ? 'U' + uid.slice(-4) : '?';
  var hue;
  if (uid && /\d/.test(uid)) hue = Math.abs(parseInt(uid.slice(-6), 10) || 0) % 360;
  else {
    var h = 0;
    var s = nick || uid || '?';
    for (var j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) | 0;
    hue = Math.abs(h) % 360;
  }
  return { url: url, initial: initial, hue: hue };
}

/**
 * 好友关系同步判定（游戏内存同源：UserData.Friends Map，登录下发+push 维护，CheckIsMyFriend 口径，
 * 数据源经 game-api gameData.friends 探测）。
 * key 可能是数字/字符串，先 has 再转串遍历比（Map 条目为好友数、很小，开销可控）。
 * @param {object} entry 消息条目
 * @returns {boolean|null} null=判不出（无数据源异常）
 */
function checkFriend(entry) {
  if (!entry || !entry.uid) return null;
  var fr = gameData.friends();
  if (!fr) return null;
  try {
    if (fr.has(entry.uid) || fr.has(+entry.uid)) return true;
    for (var k of fr.keys()) {
      if (String(k) === String(entry.uid)) return true;
    }
    return false;
  } catch (e) {
    return null;
  }
}

/**
 * 从未知结构的成员应答里尽力找成员数组：直接数组 / 对象里最长的对象数组值。
 * @param {object|Array} d parse 后的应答体
 * @returns {object[]}
 */
function findMemberArray(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  var cands = [];
  for (var k in d) {
    var v = d[k];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] != null) cands.push(v);
  }
  if (!cands.length) return [];
  cands.sort((a, b) => b.length - a.length);
  return cands[0];
}

/**
 * 把 1132 应答体解析成 {uid,name} 列表。应答 schema 已实证（AlliancePermissionPopup.js:60-68）：
 * 顶层含 members 数组，条目带 rank 与 playerInfo（内层 JSON 串，昵称在其 username 里）。
 * @param {object|Array} d parse 后的应答体
 * @param {string[]} diag 诊断输出收集器
 * @returns {Array<{uid:string, name:string}>}
 */
function parseMemberList(d, diag) {
  var arr = S.fns.findMemberArray(d);
  if (!arr.length && d && typeof d.data === 'object' && d.data != null)
    arr = S.fns.findMemberArray(d.data); // 信封多一层时下钻
  if (!arr.length) {
    diag.push('shape unknown: ' + JSON.stringify(d).slice(0, 240));
    return [];
  }
  var list = [];
  var seen = new Set();
  var skippedSample = null;
  for (var it of arr) {
    var uid = pickField(it, ['uid', 'Uid', 'fid', 'playerId', 'pid']);
    var name = pickField(it, ['name', 'Name', 'nickname', 'Nickname', 'nickName', 'n', 'pn']);
    if (!name) {
      var wx = safeParse(it.playerInfo); // 成员条目昵称藏在微信资料内层串（实证口径）
      name = wx ? String(wx.username || wx.nickname || '') : '';
    }
    if (!uid || !name || seen.has(uid)) {
      if (!skippedSample && (!uid || !name)) skippedSample = it;
      continue;
    }
    seen.add(uid);
    list.push({ uid, name });
  }
  if (skippedSample)
    diag.push('unparsed item sample: ' + JSON.stringify(skippedSample).slice(0, 240));
  diag.push('items=' + arr.length + ' parsed=' + list.length);
  return list;
}

/**
 * 确保联盟成员表就绪（1132 只读查询，10min 缓存）。参数与应答 schema 已实证
 * （AlliancePermissionPopup.js：{allianceId: Aid} → {members:[{rank, playerInfo(内层串)…}]}）。
 * 失败返空数组（选人退化为近期发言者）。
 * @returns {Promise<Array<{uid:string, name:string}>>}
 */
async function ensureMembers() {
  if (S.membersCache && Date.now() - S.membersCache.at < MEMBERS_TTL_MS) return S.membersCache.list;
  var net = netApi;
  if (!net) return [];
  try {
    var alliance = gameData.alliance();
    var aid = alliance && alliance.Aid;
    if (!aid) return []; // 不在盟，无需查询
    var ret = await net.send(CMD_ALLIANCE_MEMBERS, { allianceId: aid }); // 透传原值，与游戏同源
    var diag = [];
    var list = S.fns.parseMemberList(safeParse(ret && ret.data), diag);
    if (!list.length) {
      log.info(
        'alliance members empty/rejected: ok=%s resp=%s',
        ret && ret.ok,
        String(ret && ret.data).slice(0, 240),
      );
      return [];
    }
    S.membersCache = { list, at: Date.now() };
    log.info('alliance members fetched: %s', diag.join(' | '));
    var totalCount = +alliance.MemberCount || 0;
    if (totalCount && list.length < totalCount)
      log.warn('members incomplete (paged?) items=%d memberCount=%d', list.length, totalCount);
    return list;
  } catch (e) {
    log.warn('fetch alliance members failed: %s', e && e.message);
    return [];
  }
}

// ─────────── 切片函数登记（供兄弟切片/装配层经 S.fns 调用） ───────────
Object.assign(S.fns, {
  pushEntry,
  refreshView,
  ingest,
  revokeInPlace,
  onDel,
  onUpdate,
  onChatInfoList,
  delOne,
  broadcastUnread,
  renderActive,
  lastSub,
  updateSide,
  pmInfoText,
  servePmInfo,
  pmBitsText,
  pmStoreSet,
  loadPmInfoCache,
  maybeRefreshPmInfo,
  backfillPmInfo,
  seedPmList,
  syncChannels,
  activateKey,
  viewTitle,
  syncRoomIdsCross,
  fmtPower,
  infoLines,
  infoNick,
  resolveAvatar,
  checkFriend,
  findMemberArray,
  parseMemberList,
  ensureMembers,
});
