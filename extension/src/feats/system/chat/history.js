/**
 * 聊天窗口 · 历史切片：频道全量拉取、翻页、定位、摘要、私聊/动态房历史。
 * 依赖方向红线：只 import core + context + normalize（无兄弟回边）；跨切片调用走 S.fns。
 */
import { chatApi } from '../../../core/chat.js';
import { S, log, bufOf, BUF_LIMIT, MAX_PULL_PAGES, CHAN_DEFS, KEY_BY_C } from './context.js';
import {
  buildEntry,
  insertOrdered,
  stripRich,
  historyList,
  familyOf,
  chanOfKey,
  chanKeyOf,
  isDynamicRoomChan,
} from './normalize.js';

// ─────────────────────── 历史 ───────────────────────

/**
 * 频道全量历史（loadHistoryV2，一次拉所有已 join 房间扇入缓冲）
 * @returns {Promise<void>}
 */
async function loadChannelHistory() {
  if (S.channelHistoryState !== 'idle') return;
  S.channelHistoryState = 'busy';
  try {
    var chat = chatApi;
    var ret = await chat.historyRooms();
    // 服务器系统消息（GET_CHAT_PUSH_LIST）与 loadHistoryV2 结果同批入缓冲：合并后统一按时间升序，
    // 避免系统条目（fu="-1"）追加到列表尾部错序（游戏 getHistoryData 在 system_chat_on_server 下同源合并）。
    var items = historyList(ret);
    try {
      var sys = await chat.systemMessages({ channel: -1 });
      if (sys && sys.length) items = items.concat(sys);
    } catch (e) {
      log.warn('system messages unavailable: %s', e && e.message);
    }
    S.fns.absorbHistoryItems(items);
    await S.fns.absorbExtraRooms();
    for (var d of CHAN_DEFS) if (d.key !== 'pm') bufOf(d.key).loaded = true;
    S.channelHistoryState = 'done';
    try {
      await S.fns.applySummary();
    } catch (e) {
      log.warn('summary unavailable: %s', e && e.message);
    }
    if (S.overlay && S.overlay.isVisible()) S.fns.renderActive();
  } catch (e) {
    S.channelHistoryState = 'idle';
    log.warn('load channel history failed: %s', e && e.message);
    if (S.overlay)
      S.overlay.toast('历史拉取失败：' + (e && e.message ? e.message.slice(0, 40) : '未知错误'));
  }
}

/**
 * 一批历史条目入缓冲（解析→按时间排序→静默入列）
 * @param {object[]} list 原始历史项
 * @returns {number} 入列条数
 */
function absorbHistoryItems(list) {
  var entries = [];
  for (var raw of list) {
    try {
      var kind =
        +raw.c === 1 || (raw.fu != null && raw.tu != null && raw.roomId == null) ? 'pm' : 'push';
      var r = buildEntry(raw, kind, S.cfg.showDate);
      if (raw.roomId) bufOf(r.key).roomId = String(raw.roomId);
      entries.push({ key: r.key, entry: r.entry });
    } catch (e) {
      /* 单条解析失败跳过 */
    }
  }
  entries.sort((a, b) => a.entry.timeMs - b.entry.timeMs);
  for (var it of entries) S.fns.pushEntrySilent(it.key, it.entry);
  return entries.length;
}

/**
 * ChatList 里有、但 NetChatClient 未进房的房间（玩家没在游戏里开过该频道，如群聊）单独补拉。
 * loadHistoryV2 对未进房房间是否放行取决于服务端校验（真机待验）——逐房尝试、失败静默，不影响主拉取。
 * @returns {Promise<void>}
 */
async function absorbExtraRooms() {
  var chat = chatApi;
  if (!chat.chatHeads) return;
  var joined = new Set(chat.status().rooms || []);
  var tried = new Set();
  for (var h of chat.chatHeads()) {
    if (!h.id || h.channel === 1 || joined.has(h.id) || tried.has(h.id)) continue;
    tried.add(h.id);
    var key = isDynamicRoomChan(h.channel)
      ? chanKeyOf(h.channel) + ':' + h.id
      : KEY_BY_C[h.channel]; // 动态房一房一话钥；固定频道单键
    if (!key) continue;
    var kb = bufOf(key);
    if (!kb.roomId) kb.roomId = h.id; // 先发 roomId 给发送/翻页用，哪怕历史被拒
    if (isDynamicRoomChan(h.channel)) {
      kb.c = h.channel;
      if (h.name && kb.title === key) kb.title = h.name;
    }
    try {
      var r = await chat.historyRooms([h.id]);
      S.fns.absorbHistoryItems(historyList(r));
      kb.loaded = true;
    } catch (e) {
      /* 未进房房间可能被拒，静默跳过 */
    }
  }
}

/** 历史条目入缓冲（不即时 append、不计未读，等整列重绘） */
function pushEntrySilent(key, entry) {
  var b = bufOf(key);
  if (b.ids.has(entry.id)) return;
  insertOrdered(b, entry); // 与 pushEntry 同源：跨批次 absorb（主拉取 + 补拉房间）也按时间序合并
  while (b.list.length > BUF_LIMIT) {
    var drop = b.list.shift();
    b.ids.delete(drop.id);
  }
  b.lastAt = Math.max(b.lastAt, entry.timeMs);
  if (!entry.self) b.speakers.set(entry.uid, entry.name);
}

/**
 * 翻更旧一页（滚动到顶触发；仅频道视图且有 roomId 时可用）
 * @returns {Promise<void>}
 */
async function loadOlder() {
  if (S.olderInflight) return; // 自动补齐与手动滚顶可能并发，同游标只允许一发
  var b = bufOf(S.activeKey);
  if (b.key.indexOf('pm:') === 0) return; // 私聊历史一次性全量，无翻页
  if (!b.loaded) return; // 全量还没回来，先不翻
  if (!b.roomId) return;
  if (b.pullPages >= MAX_PULL_PAGES) {
    S.fns.setStatus('end');
    return;
  } // 已达上限：显式告知“已加载全部”
  // 翻页游标必须是服务器真实消息 uuid（游标即 MsgId）：跳过系统播报（uid=="-1"/isGameMsg，来自 GET_CHAT_PUSH_LIST，
  // 其 uuid 非 loadHistoryV2 合法游标，误用会导致翻页死锁）、本地乐观条目、合成 id
  var oldest = null;
  for (var e of b.list) {
    if (String(e.id).indexOf('local:') === 0) continue;
    if (e.uid === '-1' || (e.raw && e.raw.isGameMsg)) continue;
    if (!oldest || e.timeMs < oldest.timeMs) oldest = e;
  }
  if (!oldest) return;
  // 游标首位为 'x' 的是合成 id（无服务器 uuid），不可用
  if (String(oldest.id).charAt(0) === 'x') {
    log.info('oldest entry has synthetic id, skip paging');
    return;
  }
  S.olderInflight = true;
  b.pullPages++;
  S.fns.setStatus('loading');
  try {
    var chat = chatApi;
    var ret = await chat.olderHistory(b.roomId, oldest.id);
    // 被拒（code!==1）不锁死：退计次、留样本日志，下次滚顶还能重试；只有确认成功的空页才是真到头
    if (!ret || !ret.ok) {
      b.pullPages--;
      S.fns.setStatus('error');
      log.info(
        'older history rejected: code=%s data=%s',
        ret && ret.code,
        String(ret && ret.data).slice(0, 160),
      );
      return;
    }
    var list = historyList(ret);
    var entries = [];
    for (var raw of list) {
      try {
        var r = buildEntry(raw, 'push', S.cfg.showDate);
        if (r.key !== b.key) continue;
        entries.push(r.entry);
      } catch (e2) {}
    }
    entries.sort((x, y) => x.timeMs - y.timeMs);
    var headMs = b.list.length ? b.list[0].timeMs : Infinity; // 插入前队首时间：判断这批旧史是否严格更旧
    var fresh = [];
    for (var en of entries)
      if (!b.ids.has(en.id)) {
        insertOrdered(b, en);
        fresh.push(en);
      } // 按时间归并：954 系统消息可能比翻页旧史更旧，不能整块前置
    if (fresh.length) {
      while (b.list.length > BUF_LIMIT) {
        var dropOld = b.list.pop();
        b.ids.delete(dropOld.id);
      }
      if (S.overlay && S.overlay.isVisible() && S.activeKey === b.key) {
        // 整批都早于原队首（常态）→ 增量前插保阅读位置；否则（与更旧的系统消息交错）→ 整列按时间重排
        if (fresh[fresh.length - 1].timeMs < headMs) S.overlay.prependMessages(fresh);
        else S.overlay.renderMessages(b.list, true);
      }
    }
    if (!entries.length) {
      b.pullPages = MAX_PULL_PAGES;
      S.fns.setStatus('end');
    } // 确认成功的空页=真到头，锁止
    else S.fns.setStatus(b.pullPages >= MAX_PULL_PAGES ? 'end' : '');
  } catch (e) {
    log.warn('older history failed: %s', e && e.message);
    S.fns.setStatus('error');
  } finally {
    S.olderInflight = false;
  }
}

/** 顶部历史状态条（仅浮层可见时）：'loading'/'end'/'error'/'' 隐去 */
function setStatus(state) {
  if (S.overlay && S.overlay.isVisible()) S.overlay.setHistoryStatus(state);
}

/**
 * 引用「定位原消息」时目标不在已加载区间：用 loadHistoryAround 拉取该消息前后上下文入缓冲后二次跳转。
 * overlay.#jumpTo 找不到行时经 handlers.onLocateMessage 回调进来。
 * @param {string} uuid 目标消息 uuid
 * @returns {Promise<void>}
 */
async function locateMessage(uuid) {
  if (S.locateInflight || !uuid) return;
  var key = S.activeKey;
  var b = bufOf(key);
  var chat = chatApi;
  var roomId = b.roomId;
  if (!roomId && b.c != null) {
    // 缓冲未带 roomId：按频道从 chatHeads 兜底解析（world/alliance/group 固定单会话）
    var heads = chat.chatHeads ? chat.chatHeads() : [];
    for (var h of heads) {
      if (h.channel === b.c && h.id) {
        roomId = b.roomId = String(h.id);
        break;
      }
    }
  }
  log.info('locate: key=%s roomId=%s uuid=%s', key, roomId || '(empty)', uuid);
  if (!roomId || !chat.aroundHistory) {
    if (S.overlay) S.overlay.toast('定位失败：会话房间未知');
    return;
  }
  S.locateInflight = true;
  try {
    var ret = await chat.aroundHistory(roomId, uuid, { beforeCount: 40, afterCount: 40 });
    var list = historyList(ret);
    var hit = false;
    for (var it of list)
      if (String(it.uuid) === String(uuid)) {
        hit = true;
        break;
      }
    log.info(
      'locate aroundHistory: ok=%s items=%d anchorInList=%s',
      ret && ret.ok,
      list.length,
      hit,
    );
    if (!list.length) {
      if (S.overlay) S.overlay.toast('原消息已超期或不可加载');
      return;
    }
    S.fns.absorbHistoryItems(list);
    if (S.activeKey === key && S.overlay && S.overlay.isVisible()) {
      S.fns.renderActive();
      S.overlay.jumpToMessage(uuid);
    }
  } catch (e) {
    log.warn('around history locate failed: %s', e && e.message);
    if (S.overlay)
      S.overlay.toast('定位失败：' + (e && e.message ? String(e.message).slice(0, 30) : '未知'));
  } finally {
    S.locateInflight = false;
  }
}

/**
 * 用 getChatHomeSummary 的服务端权威摘要补齐最后一条预览（缓冲为空时给侧栏副标题兜底 lastSub）。
 * 注：不采用服务端 unreadCount 播种未读——频道/跨服房间无 markRead 通道，播种后 reload 会反复重现、无法真正消除；
 * 未读仍由本地计数（pushEntry 增量 + renderActive 查看清零）接管。
 * 仅覆盖已建缓冲且有 roomId 的会话。
 * @returns {Promise<void>}
 */
async function applySummary() {
  var chat = chatApi;
  if (!chat || !chat.summary) return;
  var ret = await chat.summary();
  var data = ret && ret.data && ret.data.data;
  var list = data && data.list;
  if (!list || typeof list !== 'object') return;
  var byRoom = new Map();
  for (var [, bb] of S.bufs) if (bb.roomId) byRoom.set(String(bb.roomId), bb);
  var touched = false;
  for (var rid in list) {
    var info = list[rid];
    if (!info || !info.lastMessage) continue;
    var b = byRoom.get(String(rid));
    if (!b) continue;
    b.lastPreview = stripRich(info.lastMessage);
    touched = true;
  }
  if (touched && S.overlay && S.overlay.isVisible()) S.fns.updateSide();
}

/**
 * 私聊会话历史（/pm/loadPmChat 全量）+ 标已读
 * @param {string} key 'pm:<uid>'
 * @returns {Promise<void>}
 */
async function loadPmHistory(key) {
  var b = bufOf(key);
  if (b.loaded) return;
  b.loaded = true;
  var uid = key.slice(3);
  if (!uid || uid === 'unknown') return;
  try {
    var chat = chatApi;
    var ret = await chat.history(uid);
    var list = historyList(ret);
    b.list = [];
    b.ids = new Set();
    var entries = [];
    for (var raw of list) {
      try {
        entries.push(buildEntry(raw, 'pm', S.cfg.showDate).entry);
      } catch (e) {}
    }
    entries.sort((x, y) => x.timeMs - y.timeMs);
    for (var en of entries) S.fns.pushEntrySilent(key, en);
    chat.markRead(uid).catch(() => {});
    if (S.overlay && S.overlay.isVisible() && S.activeKey === key) S.fns.renderActive();
  } catch (e) {
    log.warn('pm history failed: %s', e && e.message);
    if (S.overlay) S.overlay.toast('私聊历史拉取失败');
  }
}

/**
 * 确保当前视图历史就绪
 * @param {string} key 会话键
 * @returns {void}
 */
function ensureHistory(key) {
  if (key.indexOf('pm:') === 0) {
    S.fns.loadPmHistory(key);
    return;
  }
  if (key.indexOf(':') > 0 && familyOf(key) === 'cross') {
    S.fns.loadDynRoom(key);
    return;
  }
  var b = bufOf(key);
  if (!b.loaded) S.fns.loadChannelHistory();
}

/**
 * 跨服/活动动态房单房历史（loadHistoryV2 只点该房；未进过房可能被拒，静默）
 * @param {string} key '<chanKey>:<roomId>'
 * @returns {Promise<void>}
 */
async function loadDynRoom(key) {
  var b = bufOf(key);
  if (b.loaded) return;
  b.loaded = true;
  if (b.c == null) b.c = chanOfKey(key);
  b.roomId = key.slice(key.indexOf(':') + 1);
  try {
    var chat = chatApi;
    var ret = await chat.historyRooms([b.roomId]);
    S.fns.absorbHistoryItems(historyList(ret));
    if (S.overlay && S.overlay.isVisible() && S.activeKey === key) S.fns.renderActive();
    if (S.overlay && S.overlay.isVisible() && familyOf(S.activeKey) === 'cross') S.fns.updateSide();
  } catch (e) {
    log.warn('dyn room history failed: %s', e && e.message);
  }
}

// ─────────── 切片函数登记 ───────────
Object.assign(S.fns, {
  loadChannelHistory,
  absorbHistoryItems,
  absorbExtraRooms,
  pushEntrySilent,
  loadOlder,
  setStatus,
  locateMessage,
  applySummary,
  loadPmHistory,
  ensureHistory,
  loadDynRoom,
});
