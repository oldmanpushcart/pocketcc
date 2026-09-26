/**
 * 聊天窗口 feat：半透明浮层（overlay.js）的业务层。
 * 数据全部走 pocketcc.chat（只读+发包，不触碰游戏任何状态与 UI）：
 *   接收：EventCenter 的 newChatPush/chatpushpm/chatdel/chatupdate（经 ctx.on.event 订阅，pause 自动摘）
 *         → normalize → 预处理成可渲染 entry → 按频道/会话键入环形缓冲（每键 600 条，uuid 去重）；
 *   私聊/跨服为双列家族视图（微信 PC 风：左会话列表右聊天窗）；跨服 chip 侧栏列出全部活动动态房
 *         （游戏把这些子频道摆在世界 TAB 下：VchatChannelConfigV5 world subs 含 CROSS/KVK/各活动频道，
 *         房间随活动出现消亡，游戏已吸收 roomChatChange 订阅维护 _chatList.other，我们读同源+定时对账）；
 *   历史：首次打开（或切到未加载频道）调 chat.historyRooms()（loadHistoryV2，游戏 _rooms 全量）扇出入各频道缓冲；
 *         滚动到顶 chat.olderHistory(roomId, 最旧 uuid) 翻页（单次进入每频道最多 25 页）；
 *         私聊会话打开时 chat.history(uid) 全量 + chat.markRead(uid)；
 *   发送：chat.send（@编码按游戏 checkAtData 口径 "@昵称"→RS序号RS + custom.atData；全体成员走 AtAllName 常量；
 *         引用 custom.responseData={name,msg,uuid}）/ chat.sharePos；本地 5s 冷却对齐游戏 UI 层 _bCanSend；
 *         发送即插乐观条目，真回声按 同文本+self+短时窗 原位合并。
 * 快捷键：Ctrl+K 开关浮层——window 捕获阶段监听（同 F8 教训：游戏在冒泡阶段 stopPropagation，
 *   document 冒泡监听在焦点于画布时收不到）。
 * 生命周期：无场景/模式门控（浮层是辅助 UI，全场景可用）；面板 enabled 驱动 install/run。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { getUid } from '../../core/player.js';
import { storage } from '../../core/storage.js';
import { reactor } from '../../core/reactor.js';
import { ChatOverlay, AT_ALL_LABEL } from './overlay.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CHATWIN） */
const log = createLog('CHATWIN');

/** @type {string} @全体成员协议常量（chatCommon.AtAllName） */
const AT_ALL_TOKEN = '@@__everyone__##';
/** @type {string} 游戏 checkAtData 的 @ 占位分隔符（String.fromCharCode(30)，记录分隔符 RS） */
const RS = String.fromCharCode(30);
/** @type {number} 本地发送冷却（毫秒），对齐游戏 UI 层 5 秒 */
const COOLDOWN_MS = 5000;
/** @type {number} 每会话键缓冲上限（条）——与翻页上限匹配（25 页×≈20 条/页），超出后最旧条目被挤掉，翻页游标仍有效 */
const BUF_LIMIT = 600;
/** @type {number} 每频道单次进入的历史翻页上限（防 runaway；切频道重进会重置） */
const MAX_PULL_PAGES = 25;
/** @type {string} 浮层几何存储键（UID 命名空间下） */
const GEOM_KEY = 'pocketcc.chatWindow.geom';

/**
 * 频道定义表：key 为缓冲/视图键，c 为 PostChatMsg 频道号（私聊带 uid 位另算）。
 * @type {Array<{key:string, label:string, c:number|null}>}
 */
const CHAN_DEFS = [
  { key: 'world', label: '世界', c: 0 },
  { key: 'alliance', label: '联盟', c: 2 },
  { key: 'pm', label: '私聊', c: 1 },
  { key: 'cross', label: '跨服', c: 3 },
  { key: 'group', label: '群聊', c: 5 },
];

/** @type {Object<string, string>} 频道号 -> 缓冲键（world/alliance/…；未预置的落 c<n>） */
const KEY_BY_C = {};
for (const d of CHAN_DEFS) if (d.c != null && d.key !== 'pm') KEY_BY_C[d.c] = d.key;

/**
 * 动态房频道（跨服/活动，一房一会话）：除世界 0、私聊 1、联盟 2、群聊 5 这几个固定单会话外，
 * 按 roomId 拆会话键。游戏 UI 里这些子频道摆在世界 TAB 下（VchatChannelConfigV5 world subs），
 * 我们统一归入「跨服」侧栏家族。
 * @param {number} c 频道号
 * @returns {boolean}
 */
function isDynamicRoomChan(c) { return c !== 0 && c !== 1 && c !== 2 && c !== 5; }

/** 频道号 -> 会话键前缀（'cross'、'c6' 等） */
function chanKeyOf(c) { return KEY_BY_C[c] || ('c' + c); }

/** 会话键 -> 频道号；取不到返回 null */
function chanOfKey(key) {
  var p = key.slice(0, key.indexOf(':'));
  var d = CHAN_DEFS.find((x) => x.key === p);
  if (d) return d.c;
  if (p.charAt(0) === 'c' && /^\d+$/.test(p.slice(1))) return +p.slice(1);
  return null;
}

/** 侧栏兜底名（chatHeads 活动名优先，取不到时用游戏频道配置名，再退频道号衍名） */
function chanLabelOfKey(key) {
  var p = key.slice(0, key.indexOf(':'));
  var d = CHAN_DEFS.find((x) => x.key === p);
  if (d) return d.label;
  var n = p.charAt(0) === 'c' ? p.slice(1) : p;
  try { // 游戏同源：chatCommon.chatToggleConfig 频道号→文案键（如 3→cross_server_system_007）再本地化
    var cm = game.get('chatCommon');
    if (cm && cm.getChatToggleConfig) {
      var t = locText(cm.getChatToggleConfig(+n));
      if (t) return t;
    }
  } catch (e) { /* 模块不可用走衍名 */ }
  return '频道' + n;
}

/**
 * 服务器文案键 → 游戏当前语言文本（LocalManager.getNetMsgText，与游戏对网络提示的翻译同源：
 * 支持 '<键,参数1|参数2>' 裸串形态；敏感词拒答、撤回拒绝等场景用。查不到键/模块不可用时回原文）
 * @param {*} s 应答 data 原文（文案键或任意文本）
 * @returns {string} 译文或原文
 */
function locText(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return s;
  try {
    var L = game.get('LocalManager').LOCAL;
    if (!L || typeof L.getNetMsgText !== 'function') return s;
    return String(L.getNetMsgText(s) || '') || s;
  } catch (e) { return s; }
}

/** @type {object} 面板推入的模块配置（configure 更新） */
var cfg = { quick: { world: true, alliance: true, pm: true, cross: true, group: false }, opacity: 75 };

/** @type {ChatOverlay|null} 浮层视图实例 */
var overlay = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {number} RequestId.ALLIANCE_GET_MEMBER_LIST（RequestId.js:315），联盟成员列表只读查询；应答 schema 未实证，尽力解析+日志定稿 */
const CMD_ALLIANCE_MEMBERS = 1132;
/** @type {number} RequestId.AddFriend（RequestId.js:150），发起好友申请；载荷按 {uid} 尽力口径（真机待验） */
const CMD_ADD_FRIEND = 501;
/** @type {number} RequestId.PLAYER_INFO（RequestId.js:207），查玩家基础信息；游戏内聊天点名字同源用法 {uid}，应答 parse 后取 .playerInfo（ChatTools.showPrivateView 口径） */
const CMD_PLAYER_INFO = 630;
/** @type {number} NRequestIdV2.RECALL_CHAT_MESSAGE（NRequestIdV2.js:25），撤回自己消息；游戏 revokeMsg 同源：sendPBV2 {roomId, uuid, channel, toUid}，时限配置 630061（默认 60s） */
const CMD_RECALL_CHAT = 254;
/** @type {number} 联盟成员缓存有效期（毫秒） */
const MEMBERS_TTL_MS = 1000 * 60 * 10;

/** @type {{list:Array<{uid:string,name:string}>, at:number}|null} 联盟成员表缓存 */
var membersCache = null;

/**
 * 会话缓冲：键 -> {title, c, roomId, list:[entry], ids:Set, unread, loaded, pullPages, speakers:Map, lastAt}
 * @type {Map<string, object>}
 */
var bufs = new Map();
/** @type {string} 当前视图键 */
var activeKey = 'world';
/** @type {'idle'|'busy'|'done'} 频道全量历史（loadHistoryV2）拉取状态（done 后不再重复） */
var channelHistoryState = 'idle';
/** @type {number} 上次发送尝试时刻（冷却闸门） */
var lastSendAt = 0;

/**
 * 取（或建）缓冲
 * @param {string} key 会话键
 * @param {string} [title] 展示标题
 * @returns {object} 缓冲对象
 */
function bufOf(key, title) {
  var b = bufs.get(key);
  if (!b) {
    b = { key, title: title || key, c: null, roomId: '', list: [], ids: new Set(), unread: 0, loaded: false, pullPages: 0, speakers: new Map(), lastAt: 0 };
    var d = CHAN_DEFS.find((x) => x.key === key);
    if (d) b.c = d.c;
    bufs.set(key, b);
  }
  if (title) b.title = title;
  return b;
}

/**
 * 从游戏频道头列表（chat.chatHeads，只读）补齐各频道缓冲的 roomId。
 * 背景：动态频道（群聊 5 等）的进房是惰性的——玩家没在游戏里打开过该频道时服务器不会
 * push roomChatChange、NetChatClient 未 addRoom，浮层既收不到推信也学不到 roomId；
 * 而群聊发送的 PostChatMsg group 字段必填（游戏发送分支 dataSameWithGroupSpecial=[5]），
 * 不兜底就会因 group='' 被服务器拒发。仅读频道列表，不改游戏任何状态。
 * 注：同频道多个会话（如多个群）时 v1 只取首个。
 * @returns {void}
 */
function syncRoomIds() {
  var chat = window.pocketcc.chat;
  if (!chat || !chat.chatHeads) return;
  for (var h of chat.chatHeads()) {
    if (!h.id || h.channel === 1 || h.channel === 3) continue; // 私聊走 pm:<uid>；跨服多房间由侧栏视图按 cross:<roomId> 管理
    var key = KEY_BY_C[h.channel];
    if (!key) continue;
    var b = bufs.get(key);
    if (b && !b.roomId) b.roomId = String(h.id);
  }
}

/** JSON.parse 兜底（协议里 custom/fp 都是 JSON 字符串；net 主协议应答 d 也是字符串原文） */
function safeParse(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}

/**
 * 从 chat proxy 应答提取消息数组。chat.Ret.data 是**完整应答对象**（形如 {code, data:{list}}，
 * toRet 不再剥一层），故取数主路径是 ret.data.data.list；兼容直挂 list 的形态兜底。
 * @param {object} ret chat.history/historyRooms/olderHistory 的 Ret
 * @returns {object[]} 消息数组（探不到空数组）
 */
function historyList(ret) {
  var d = ret && ret.data;
  if (!d || typeof d !== 'object') return [];
  var l = d.list != null ? d.list : (d.data && typeof d.data === 'object' ? d.data.list : null);
  return Array.isArray(l) ? l : [];
}

/** @returns {string} 本人数字 UID */
function myUid() { return String(getUid() || ''); }

/** @returns {string} 本人 StrUid（快速登录模式下与 UID 不同，PM 的 fu/tu 用它） */
function myStrUid() {
  try {
    var dc = game.get('DataCenter');
    var s = dc && dc.DATA && dc.DATA.UserData && dc.DATA.UserData.StrUid;
    if (s != null && s !== '') return String(s);
  } catch (e) { }
  return myUid();
}

/**
 * 时间归一：频道 t 为秒串、PM/time 为毫秒——统一成毫秒。
 * @param {number|null} t 原始时间
 * @param {number|null} ms 原始 time 字段（毫秒）
 * @returns {number}
 */
function toMs(t, ms) {
  var v = ms != null ? +ms : (t != null ? +t : Date.now());
  if (v < 1e11) v *= 1000;
  return v;
}

/**
 * yyyy-MM-dd HH:mm:ss 展示串（用户要求含日期秒，历史跨度大时分定位哪天）
 * @param {number} ms 毫秒时刻
 * @returns {string}
 */
function hhmm(ms) {
  var d = new Date(ms);
  var p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 把一条原始消息（推送项或历史项）预处理成 overlay 可渲染 entry。
 * schema 差异（fu 字符串/对象、u/n/fp 名字位置）在这里全部抹平。
 * @param {object} raw socket/历史原始项
 * @param {string} kind 'push'|'pm'
 * @returns {{entry:object, key:string, self:boolean}} entry + 归属缓冲键 + 是否本人
 */
function buildEntry(raw, kind) {
  var chat = window.pocketcc.chat;
  var norm = chat.normalize(raw, kind);
  var custom = safeParse(raw.custom) || {};
  var atData = custom.atData || null;
  var responseData = custom.responseData || null;
  var fp = safeParse(raw.fp) || {};
  var f = safeParse(raw.f) || {};
  var uid = String((norm.from && norm.from.uid) || raw.uid || (typeof raw.fu === 'object' ? raw.fu.uid : raw.fu) || '');
  var name = (norm.from && norm.from.name) || raw.u || raw.n || fp.username || f.n || '';
  if (!name) name = uid ? '玩家' + uid.slice(-4) : '?';
  var self = !!uid && (uid === myUid() || uid === myStrUid());

  // 正文：历史项可能只有 content 无 m（游戏侧预处理口径），这里同源兼容；@编码还原 + 链接转 chip
  var text = String((norm.text != null && norm.text !== '') ? norm.text : (raw.content != null ? raw.content : ''))
    .split(AT_ALL_TOKEN).join('@' + AT_ALL_LABEL);
  var segments;
  if (norm.isLink) {
    segments = linkSegments(norm, raw);
  } else if (kind === 'pm' && /^\d+\s*,\s*\d+$/.test(text)) {
    segments = [{ type: 'chip', s: '[位置 ' + text + ']', copy: text.replace(/\s/g, '') }];
  } else {
    segments = decodeAtCodes(text, atData);
  }
  var plain = segments.map((s) => s.s).join('');

  // 会话键
  var key;
  if (kind === 'pm') {
    var tu = typeof raw.tu === 'object' ? String((raw.tu && raw.tu.uid) || '') : String(raw.tu || '');
    var other = self ? tu : uid;
    key = 'pm:' + (other || 'unknown');
  } else if (raw.roomId && isDynamicRoomChan(+norm.channel)) {
    key = chanKeyOf(+norm.channel) + ':' + String(raw.roomId); // 跨服/活动动态房：一房一会话（条目随活动出现/消亡，游戏 roomChatChange 吸收）
  } else {
    key = KEY_BY_C[norm.channel != null ? +norm.channel : -1] || ('c' + norm.channel);
  }

  // 被 @ 判据：atData 点名本人，或文本含 @全体成员（弱高亮）
  var mention = false;
  if (!self && atData && atData.uid) {
    for (var u of atData.uid) { var su = String(u && u.uid != null ? u.uid : u); if (su === myUid() || su === myStrUid()) { mention = true; break; } }
  }
  if (!self && text.indexOf('@' + AT_ALL_LABEL) >= 0) mention = true;

  var entry = {
    id: raw.uuid != null ? String(raw.uuid) : (norm.id != null ? String(norm.id) : 'x' + Date.now()),
    uid,
    timeMs: toMs(raw.t != null ? raw.t : norm.time, raw.time),
    timeStr: hhmm(toMs(raw.t != null ? raw.t : norm.time, raw.time)),
    name: self ? '我' : name,
    self,
    mention,
    pmDir: null,
    segments,
    plain,
    quote: responseData ? { name: String(responseData.name || ''), msg: String(responseData.msg || ''), id: responseData.uuid || responseData.msgId || null } : null,
  };
  return { entry, key, self, otherUid: kind === 'pm' && self ? String((typeof raw.tu === 'object' ? raw.tu.uid : raw.tu) || '') : '' };
}

/**
 * 链接消息 -> chip 片段（0=位置/基地、1=战报、2=表情、3=砍价，其余兜底）
 * @param {object} norm chat.normalize 产物
 * @param {object} raw 原始项
 * @returns {object[]}
 */
function linkSegments(norm, raw) {
  var llm = norm.llm || safeParse(raw.llm) || {};
  if (norm.linkType === 0 && llm.p) {
    var p = llm.p;
    var copy = p.x + ',' + p.y;
    var label = llm.s ? '[' + llm.s + ']' : '[位置 ' + copy + ']';
    return [{ type: 'chip', s: label, copy }];
  }
  if (norm.linkType === 1) return [{ type: 'chip', s: '[战报]' }];
  if (norm.linkType === 2) return [{ type: 'chip', s: '[表情]' }];
  if (norm.linkType === 3) return [{ type: 'chip', s: '[活动链接]' }];
  return [{ type: 'chip', s: '[链接]' }];
}

/**
 * 还原 @ 编码：RS序号RS 片段换成 atData.name 对应昵称
 * @param {string} text 已替换 AtAllName 常量的正文
 * @param {object|null} atData custom.atData
 * @returns {object[]} segments
 */
function decodeAtCodes(text, atData) {
  var segs = [];
  var re = new RegExp(RS + '(\\d+)' + RS, 'g');
  var last = 0; var m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', s: text.slice(last, m.index) });
    var nm = atData && atData.name ? atData.name[+m[1]] : null;
    segs.push({ type: 'at', s: '@' + (nm != null ? String(nm).replace(AT_ALL_TOKEN, AT_ALL_LABEL) : '?') });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ type: 'text', s: text.slice(last) });
  return segs.length ? segs : [{ type: 'text', s: text }];
}

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
      if (o.self && String(o.id).indexOf('local:') === 0 && o.plain === entry.plain && Math.abs(entry.timeMs - o.timeMs) < 60000) {
        b.ids.delete(o.id);
        b.list[i] = entry;
        b.ids.add(entry.id);
        refreshView(key, entry);
        return false;
      }
    }
  }
  b.list.push(entry);
  b.ids.add(entry.id);
  while (b.list.length > BUF_LIMIT) { var drop = b.list.shift(); b.ids.delete(drop.id); }
  b.lastAt = Math.max(b.lastAt, entry.timeMs);
  if (!entry.self) {
    b.speakers.set(entry.uid, entry.name); // 近期发言者（@选人数据源）
    if (overlay && !(overlay.isVisible() && key === activeKey)) b.unread++;
  }
  if (overlay && overlay.isVisible() && key === activeKey) overlay.appendMessage(entry);
  return true;
}

/** 乐观条目替换真回声后刷新当前视图 */
function refreshView(key, entry) {
  if (overlay && overlay.isVisible() && key === activeKey) overlay.renderMessages(bufOf(key).list);
}

/**
 * 收信入口（EventCenter 载荷可能单项或数组）
 * @param {string} kind 'push'|'pm'
 * @param {object|object[]} payload 原始项
 * @returns {void}
 */
function ingest(kind, payload) {
  var chat = window.pocketcc.chat;
  if (!chat) return;
  var items = Array.isArray(payload) ? payload : [payload];
  for (var raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      var r = buildEntry(raw, kind);
      // 发送者名只用于初始化私聊会话标题；动态房/固定频道不得拿玩家名当 title（否则侧栏活动名被污染）
      var b = bufOf(r.key, (r.key.indexOf('pm:') === 0 && !r.self && r.entry.name) ? r.entry.name : undefined);
      if (r.self && r.key.indexOf('pm:') === 0 && b.title !== b.key) r.entry.pmDir = '-> ' + b.title; // 实时追加路径也要带方向标注
      if (raw.roomId) b.roomId = String(raw.roomId);
      pushEntry(r.key, r.entry);
    } catch (e) {
      log.warn('ingest %s failed: %s', kind, e && e.message);
    }
  }
  broadcastUnread();
}

/** 删除推送：按 uuid（单项/数组）从各缓冲移除 */
function onDel(payload) {
  var ids = new Set();
  var arr = Array.isArray(payload) ? payload : [payload];
  for (var p of arr) { if (p && typeof p === 'object' && p.uuid != null) ids.add(String(p.uuid)); }
  if (!ids.size) return;
  var touched = false;
  for (var b of bufs.values()) {
    var before = b.list.length;
    b.list = b.list.filter((e) => { if (ids.has(e.id)) { b.ids.delete(e.id); return false; } return true; });
    if (b.list.length !== before) touched = true;
  }
  if (touched && overlay && overlay.isVisible()) renderActive();
}

/** 更新推送：移除旧条目后按新内容重建（best-effort，schema 未知不做强解析） */
function onUpdate(payload) {
  var arr = Array.isArray(payload) ? payload : [payload];
  for (var p of arr) {
    if (!p || typeof p !== 'object' || p.uuid == null) continue;
    delOne(String(p.uuid));
    if (p.m != null || p.content != null) ingest(+p.c === 1 ? 'pm' : 'push', p);
  }
}

/** 按 uuid 移除一条 */
function delOne(id) {
  for (var b of bufs.values()) {
    for (var i = 0; i < b.list.length; i++) {
      if (b.list[i].id === id) { b.list.splice(i, 1); b.ids.delete(id); if (overlay && overlay.isVisible() && b.key === activeKey) renderActive(); return; }
    }
  }
}

/** 未读角标广播（overlay 一次刷全；pm:/cross: 会话的未读另聚合到家族 chip） */
function broadcastUnread() {
  if (!overlay) return;
  var map = {};
  var fam = { pm: 0, cross: 0 };
  for (var [k, b] of bufs) {
    if (!b.unread) continue;
    map[k] = b.unread;
    if (k.indexOf('pm:') === 0) fam.pm += b.unread;
    else if (familyOf(k) === 'cross') fam.cross += b.unread;
  }
  if (fam.pm) map.pm = (map.pm || 0) + fam.pm;
  if (fam.cross) map.cross = (map.cross || 0) + fam.cross;
  overlay.setUnread(map);
  if (overlay.isVisible()) updateSide(); // 侧栏未读数同步
}

/** 重绘当前视图（含私聊方向标注） */
function renderActive() {
  if (!overlay) return;
  var b = bufOf(activeKey);
  var list = b.list;
  if (b.key.indexOf('pm:') === 0) {
    var other = b.title !== b.key ? b.title : '';
    for (var e of list) e.pmDir = e.self ? ('-> ' + other) : '';
  }
  overlay.renderMessages(list);
  b.unread = 0;
  broadcastUnread();
}

// ─────────────────────── 历史 ───────────────────────

/**
 * 频道全量历史（loadHistoryV2，一次拉所有已 join 房间扇入缓冲）
 * @returns {Promise<void>}
 */
async function loadChannelHistory() {
  if (channelHistoryState !== 'idle') return;
  channelHistoryState = 'busy';
  try {
    var chat = window.pocketcc.chat;
    var ret = await chat.historyRooms();
    absorbHistoryItems(historyList(ret));
    await absorbExtraRooms();
    for (var d of CHAN_DEFS) if (d.key !== 'pm') bufOf(d.key).loaded = true;
    channelHistoryState = 'done';
    if (overlay && overlay.isVisible()) renderActive();
  } catch (e) {
    channelHistoryState = 'idle';
    log.warn('load channel history failed: %s', e && e.message);
    if (overlay) overlay.toast('历史拉取失败：' + (e && e.message ? e.message.slice(0, 40) : '未知错误'));
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
      var kind = (+raw.c === 1 || (raw.fu != null && raw.tu != null && raw.roomId == null)) ? 'pm' : 'push';
      var r = buildEntry(raw, kind);
      if (raw.roomId) bufOf(r.key).roomId = String(raw.roomId);
      entries.push({ key: r.key, entry: r.entry });
    } catch (e) { /* 单条解析失败跳过 */ }
  }
  entries.sort((a, b) => a.entry.timeMs - b.entry.timeMs);
  for (var it of entries) pushEntrySilent(it.key, it.entry);
  return entries.length;
}

/**
 * ChatList 里有、但 NetChatClient 未进房的房间（玩家没在游戏里开过该频道，如群聊）单独补拉。
 * loadHistoryV2 对未进房房间是否放行取决于服务端校验（真机待验）——逐房尝试、失败静默，不影响主拉取。
 * @returns {Promise<void>}
 */
async function absorbExtraRooms() {
  var chat = window.pocketcc.chat;
  if (!chat.chatHeads) return;
  var joined = new Set(chat.status().rooms || []);
  var tried = new Set();
  for (var h of chat.chatHeads()) {
    if (!h.id || h.channel === 1 || joined.has(h.id) || tried.has(h.id)) continue;
    tried.add(h.id);
    var key = isDynamicRoomChan(h.channel) ? chanKeyOf(h.channel) + ':' + h.id : KEY_BY_C[h.channel]; // 动态房一房一话钥；固定频道单键
    if (!key) continue;
    var kb = bufOf(key);
    if (!kb.roomId) kb.roomId = h.id; // 先发 roomId 给发送/翻页用，哪怕历史被拒
    if (isDynamicRoomChan(h.channel)) { kb.c = h.channel; if (h.name && kb.title === key) kb.title = h.name; }
    try {
      var r = await chat.historyRooms([h.id]);
      absorbHistoryItems(historyList(r));
      kb.loaded = true;
    } catch (e) { /* 未进房房间可能被拒，静默跳过 */ }
  }
}

/** 历史条目入缓冲（不即时 append、不计未读，等整列重绘） */
function pushEntrySilent(key, entry) {
  var b = bufOf(key);
  if (b.ids.has(entry.id)) return;
  b.list.push(entry);
  b.ids.add(entry.id);
  while (b.list.length > BUF_LIMIT) { var drop = b.list.shift(); b.ids.delete(drop.id); }
  b.lastAt = Math.max(b.lastAt, entry.timeMs);
  if (!entry.self) b.speakers.set(entry.uid, entry.name);
}

/**
 * 翻更旧一页（滚动到顶触发；仅频道视图且有 roomId 时可用）
 * @returns {Promise<void>}
 */
var olderInflight = false;
async function loadOlder() {
  if (olderInflight) return; // 自动补齐与手动滚顶可能并发，同游标只允许一发
  var b = bufOf(activeKey);
  if (b.key.indexOf('pm:') === 0) return; // 私聊历史一次性全量，无翻页
  if (!b.loaded) return;                   // 全量还没回来，先不翻
  if (!b.roomId || b.pullPages >= MAX_PULL_PAGES) return;
  var oldest = null;
  for (var e of b.list) if (String(e.id).indexOf('local:') !== 0 && (!oldest || e.timeMs < oldest.timeMs)) oldest = e;
  if (!oldest) return;
  // 翻页游标必须是服务器 uuid（游标即 MsgId，游戏 askLastPageData: GroupId|MsgId），合成 id 不可用
  if (String(oldest.id).charAt(0) === 'x') { log.info('oldest entry has synthetic id, skip paging'); return; }
  olderInflight = true;
  b.pullPages++;
  try {
    var chat = window.pocketcc.chat;
    var ret = await chat.olderHistory(b.roomId, oldest.id);
    // 被拒（code!==1）不锁死：退计次、留样本日志，下次滚顶还能重试；只有确认成功的空页才是真到头
    if (!ret || !ret.ok) {
      b.pullPages--;
      log.warn('older history rejected: code=%s data=%s', ret && ret.code, String(ret && ret.data).slice(0, 160));
      return;
    }
    var list = historyList(ret);
    var entries = [];
    for (var raw of list) {
      try {
        var r = buildEntry(raw, 'push');
        if (r.key !== b.key) continue;
        entries.push(r.entry);
      } catch (e2) { }
    }
    entries.sort((x, y) => x.timeMs - y.timeMs);
    var fresh = [];
    for (var en of entries) if (!b.ids.has(en.id)) { b.list.unshift(en); b.ids.add(en.id); fresh.push(en); }
    if (fresh.length && overlay && overlay.isVisible()) overlay.prependMessages(fresh);
    if (!entries.length) b.pullPages = MAX_PULL_PAGES; // 确认成功的空页=真到头，锁止
  } catch (e) {
    log.warn('older history failed: %s', e && e.message);
  } finally { olderInflight = false; }
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
    var chat = window.pocketcc.chat;
    var ret = await chat.history(uid);
    var list = historyList(ret);
    b.list = []; b.ids = new Set();
    var entries = [];
    for (var raw of list) {
      try { entries.push(buildEntry(raw, 'pm').entry); } catch (e) { }
    }
    entries.sort((x, y) => x.timeMs - y.timeMs);
    for (var en of entries) pushEntrySilent(key, en);
    chat.markRead(uid).catch(() => { });
    if (overlay && overlay.isVisible() && activeKey === key) renderActive();
  } catch (e) {
    log.warn('pm history failed: %s', e && e.message);
    if (overlay) overlay.toast('私聊历史拉取失败');
  }
}

/**
 * 确保当前视图历史就绪
 * @param {string} key 会话键
 * @returns {void}
 */
function ensureHistory(key) {
  if (key.indexOf('pm:') === 0) { loadPmHistory(key); return; }
  if (key.indexOf(':') > 0 && familyOf(key) === 'cross') { loadDynRoom(key); return; }
  var b = bufOf(key);
  if (!b.loaded) loadChannelHistory();
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
    var chat = window.pocketcc.chat;
    var ret = await chat.historyRooms([b.roomId]);
    absorbHistoryItems(historyList(ret));
    if (overlay && overlay.isVisible() && activeKey === key) renderActive();
    if (overlay && overlay.isVisible() && familyOf(activeKey) === 'cross') updateSide();
  } catch (e) {
    log.warn('dyn room history failed: %s', e && e.message);
  }
}

// ─────────────────────── 侧栏会话列表（微信 PC 风双列） ───────────────────────

/**
 * 会话家族归属：pm/cross 用双列视图（左列表右会话），其余频道单列；
 * 跨服/活动动态房（c6:xxx 等）统一归 cross 家族（游戏内这些子频道摆在世界 TAB 下）
 * @param {string} key 会话键
 * @returns {'pm'|'cross'|null}
 */
function familyOf(key) {
  if (key === 'pm' || key.indexOf('pm:') === 0) return 'pm';
  if (key === 'cross') return 'cross';
  if (key.indexOf(':') > 0) {
    var c = chanOfKey(key);
    if (c != null && isDynamicRoomChan(c)) return 'cross';
  }
  return null;
}

/** 侧栏副行：最后一条消息预览 */
function lastSub(b) {
  var last = b.list.length ? b.list[b.list.length - 1] : null;
  return last ? String(last.name || '') + ': ' + String(last.plain || '').slice(0, 18) : '';
}

/**
 * 重建左侧会话列表。pm：缓冲 + chatHeads c=1（loadChatList 产物，含浮层装前会话）；
 * cross：chatHeads 全部动态房条目（跨服 3、KVK、无双峡谷、联盟对决等活动房间，
 * 随活动出现/消亡，游戏吸收 roomChatChange 后维护条目，我们只读同源）+ 已知缓冲；
 * 无房间时给空态占位（发送不携 roomId，服务器路由，仍可发）。
 * @returns {void}
 */
function updateSide() {
  if (!overlay) return;
  var fam = familyOf(activeKey);
  if (!fam) { overlay.setSideList([], activeKey); return; }
  var chat = window.pocketcc.chat;
  var heads = chat && chat.chatHeads ? chat.chatHeads() : [];
  var items = [];
  var has = new Set();
  if (fam === 'pm') {
    for (var [k, b] of bufs) {
      if (k.indexOf('pm:') !== 0) continue;
      has.add(k);
      items.push({ key: k, title: b.title !== k ? b.title : 'U' + k.slice(-4), sub: pmInfoText(k), unread: b.unread, ts: b.lastAt });
    }
    for (var h of heads) {
      if (h.channel !== 1 || !h.id) continue;
      var pk = 'pm:' + h.id;
      if (has.has(pk)) continue;
      has.add(pk);
      if (h.name) bufOf(pk).title = h.name;
      var pb = bufOf(pk);
      items.push({ key: pk, title: pb.title !== pk ? pb.title : 'U' + String(h.id).slice(-4), sub: pmInfoText(pk), unread: pb.unread, ts: pb.lastAt });
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
      items.push({ key: ck, title: cb.title !== ck ? cb.title : chanLabelOfKey(ck), sub: lastSub(cb), unread: cb.unread, ts: cb.lastAt });
    }
    for (var [k3, b3] of bufs) { // 推信学过但 chatHeads 尚无条目的房间也列出
      if (has.has(k3) || familyOf(k3) !== 'cross' || k3 === 'cross') continue;
      items.push({ key: k3, title: b3.title !== k3 ? b3.title : chanLabelOfKey(k3), sub: lastSub(b3), unread: b3.unread, ts: b3.lastAt });
    }
    if (!items.length) items.push({ key: 'cross', title: '跨服', sub: '暂无跨服/活动频道', ts: 0 });
  }
  items.sort((a, b2) => (b2.ts || 0) - (a.ts || 0));
  overlay.setSideList(items, activeKey);
}

/** @type {Map<string, {state:string, txt:string}>} 私聊侧栏副行信息缓存（630 懒查，键=会话键；fail/pending 不重发） */
var pmInfoCache = new Map();

/**
 * 私聊侧栏副行：对方基本信息（区/等级/power，用户口径不显聊天内容）；
 * 首次渲染时懒发 PLAYER_INFO(630)（仅数字 uid——StrUid 形态未实证可查），应答到达后刷侧栏。
 * @param {string} pk 'pm:<uid>'
 * @returns {string}
 */
function pmInfoText(pk) {
  var ci = pmInfoCache.get(pk);
  if (!ci) {
    var uid = pk.slice(3);
    var net = window.pocketcc.net;
    if (net && /^\d+$/.test(uid)) {
      pmInfoCache.set(pk, { state: 'pending', txt: '' });
      net.send(CMD_PLAYER_INFO, { uid }).then((ret) => {
        var d = safeParse(ret && ret.data);
        if (!ret || !ret.ok || !d || typeof d !== 'object') { pmInfoCache.set(pk, { state: 'fail', txt: '' }); return; }
        var bits = [];
        if (d.serverId != null) bits.push('区 ' + d.serverId);
        if (d.level != null) bits.push('Lv.' + d.level);
        if (d.power != null) bits.push('战力 ' + fmtPower(d.power));
        pmInfoCache.set(pk, { state: 'done', txt: bits.join(' · ') });
        if (overlay && overlay.isVisible() && familyOf(activeKey) === 'pm') updateSide();
      }).catch(() => { pmInfoCache.set(pk, { state: 'fail', txt: '' }); });
    }
    return '';
  }
  return ci.txt;
}

// ─────────────────────── 频道切换与视图 ───────────────────────

/**
 * 重建快捷栏/更多菜单并下发 overlay（配置或会话集变化时调用）。
 * 私聊会话不再列入「更多」菜单——已由左侧列表（updateSide）承载。
 * @returns {void}
 */
function syncChannels() {
  if (!overlay) return;
  var quick = CHAN_DEFS.filter((d) => cfg.quick[d.key]).map((d) => ({ key: d.key, label: d.label }));
  var more = CHAN_DEFS.filter((d) => !cfg.quick[d.key]).map((d) => ({ key: d.key, label: d.label }));
  // pm:xxx / cross:xxx 选中时高亮其家族 chip
  overlay.setChannels(quick, more, familyOf(activeKey) || activeKey);
  updateSide();
}

/**
 * 切换当前视图
 * @param {string} key 会话键
 * @returns {void}
 */
function activateKey(key) {
  if (key === 'pm') {
    // 私聊 chip：先用游戏会话列表（chatHeads c=1，含浮层装前会话）预建缓冲，再进最近一个
    var chat0 = window.pocketcc.chat;
    if (chat0 && chat0.chatHeads) {
      for (var h0 of chat0.chatHeads()) {
        if (h0.channel !== 1 || !h0.id) continue;
        var pb0 = bufOf('pm:' + h0.id);
        if (h0.name && pb0.title === pb0.key) pb0.title = h0.name;
      }
    }
    var latest = null;
    for (var [k, b] of bufs) if (k.indexOf('pm:') === 0 && (!latest || b.lastAt > latest.ts)) latest = { k, ts: b.lastAt };
    if (!latest) { if (overlay) { overlay.setActive(key); activeKey = key; overlay.renderMessages([]); overlay.toast('双击消息或点发送者名字开私聊'); updateSide(); } return; }
    key = latest.k;
  } else if (key === 'cross') {
    // 跨服 chip：进最近有消息的活动/跨服房间；都没有则进空态缓冲（发送不携 roomId，服务器路由）
    syncRoomIdsCross();
    var first = null;
    for (var [k2, b2] of bufs) if (k2 !== 'cross' && familyOf(k2) === 'cross' && (!first || b2.lastAt > first.ts)) first = { k: k2, ts: b2.lastAt };
    if (first && first.ts) key = first.k;
  }
  activeKey = key;
  var ab = bufOf(key);
  ab.pullPages = 0; // 重新进入允许再拨一段旧史（MAX_PULL_PAGES 是单次进入的防 runaway 上限）
  if (overlay) { overlay.setActive(familyOf(key) || key); overlay.setTitle(viewTitle(key)); renderActive(); } // chip 高亮按家族键（pm:xxx/cross:xxx 归 pm/cross）
  ensureHistory(key);
  syncChannels();
}

/**
 * 标题栏文本：预置频道用 label；pm:/cross: 会话用对方昵称/房间名
 * @param {string} key 会话键
 * @returns {string}
 */
function viewTitle(key) {
  var d = CHAN_DEFS.find((x) => x.key === key);
  if (d && key.indexOf(':') < 0) return d.label;
  var b = bufs.get(key);
  if (!b) return '聊天';
  if (key.indexOf('pm:') === 0) return '私聊 · ' + (b.title !== key ? b.title : 'U' + key.slice(-4));
  if (familyOf(key) === 'cross' && key.indexOf(':') > 0) return b.title !== key ? b.title : chanLabelOfKey(key);
  return b.title !== key ? b.title : '聊天';
}

/**
 * 跨服/活动房间对账（游戏侧 roomChatChange 进/退房的同源结果在 _chatList.other）：
 * chatHeads 动态房条目 → 建/补 <chanKey>:<roomId> 缓冲；随活动出现的房间由此感知。
 * @returns {void}
 */
function syncRoomIdsCross() {
  var chat = window.pocketcc.chat;
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
  name: '名字', nickname: '昵称', nickName: '昵称', level: '等级', power: '战力', combat: '战力',
  vipLevel: 'VIP', headIcon: '头像', serverId: '服号', sex: '性别', allianceName: '联盟',
  alliance: '联盟', aid: '联盟ID', pos: '坐标', x: '坐标X', y: '坐标Y', title: '称号', pwr: '战力',
};

/**
 * 战力紧凑显示：K（千）/M（百万）口径（用户定案；armyPower 换算公式未明，暂不展示）。
 * @param {number} v 数值
 * @returns {string}
 */
function fmtPower(v) {
  v = +v || 0;
  var f = (n, u) => { var s = n.toFixed(1); return (s.slice(-2) === '.0' ? s.slice(0, -2) : s) + u; };
  if (v >= 1e6) return f(v / 1e6, 'M');
  if (v >= 1e3) return f(v / 1e3, 'K');
  return String(Math.round(v));
}

/**
 * PLAYER_INFO(630) 应答→信息行（schema 已真机实证：顶层 level/power/armyPower/allianceName/x/y…，
 * 其中 playerInfo 字段是微信绑定资料的内层 JSON 串，昵称在其 username 里；未知形态兜底标量全列）。
 * @param {object} d 应答顶层 parse 产物
 * @returns {string[]}
 */
function infoLines(d) {
  var lines = [];
  if (!d || typeof d !== 'object') return lines;
  if (d.level != null) lines.push('等级: ' + d.level);
  if (d.power != null) lines.push('战力: ' + fmtPower(d.power));
  // armyPower 暂不展示：换算公式未明（用户口径）
  if (d.allianceName) lines.push('联盟: ' + d.allianceName + (d.allianceTag ? ' [' + d.allianceTag + ']' : ''));
  if (d.x != null && d.y != null) lines.push('坐标: ' + d.x + ',' + d.y);
  if (d.serverId != null) lines.push('服务器: ' + d.serverId);
  if (d.like != null) lines.push('获赞: ' + d.like);
  if (!lines.length) {
    for (var k in d) {
      if (lines.length >= 14) break;
      var v = d[k];
      if (v == null || typeof v === 'object') continue;
      lines.push((INFO_LABELS[k] || INFO_LABELS[k.toLowerCase()] || k) + ': ' + String(v));
    }
  }
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

/**
 * 撤回自己的消息（游戏 revokeMsg 同源口径，newChatController.js:4049-4069）：
 * sendPBV2(254, {roomId, uuid, channel, toUid})；toUid：私聊房标识是无下划线的纯 uid →
 * Int64.fromString(roomId)，其余房间 → Int64.fromNumber(0)。时限配置表 630061（默认 60s）。
 * 成功后服务器会广播 chatdel 移除各端条目，本地 delOne 兜底。
 * @param {object} entry 消息条目
 * @returns {Promise<void>}
 */
async function doRevoke(entry) {
  var net = window.pocketcc.net;
  if (!net || !overlay) return;
  if (!entry || !entry.self) { overlay.toast('只能撤回自己的消息'); return; }
  if (String(entry.id).indexOf('local:') === 0) { overlay.toast('消息尚未发送完成，稍后再试'); return; }
  var b = bufOf(activeKey);
  var limit = 60;
  try {
    var tu = game.get('TableUtils');
    limit = +(tu && tu.getDataConfigData && tu.getDataConfigData(630061)) || 60;
  } catch (e) { /* 配置表取不到用默认 */ }
  var nowSec = 0;
  try { nowSec = +game.get('DataCenter').DATA.ServerTime || 0; } catch (e) { /* 下面兜底 */ }
  if (!nowSec) nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - Math.floor(entry.timeMs / 1000) > limit) { overlay.toast('超过 ' + limit + ' 秒时限，不能撤回'); return; }
  var channel = b.c != null ? b.c : (activeKey.indexOf('pm:') === 0 ? 1 : chanOfKey(activeKey));
  if (channel == null) { overlay.toast('无法确定该消息的频道'); return; }
  var roomId = b.roomId || '';
  if (activeKey.indexOf('pm:') === 0) roomId = activeKey.slice(3); // 私聊房标识=对方 uid（游戏 NowChoiceKey.Id 同形）
  var toUid = 0;
  try {
    var L = game.get('Long64Bit');
    if (L && L.Int64) {
      toUid = roomId.indexOf('_') <= 0 ? L.Int64.fromString(roomId || '0') : L.Int64.fromNumber(0);
    } else {
      toUid = /^\d+$/.test(roomId) ? Number(roomId) : 0; // 模块取不到时的纯数字兜底
    }
  } catch (e) { toUid = 0; }
  try {
    var ret = await net.sendPBV2(CMD_RECALL_CHAT, { roomId: roomId, uuid: String(entry.id), channel: channel, toUid: toUid });
    if (ret && ret.ok) {
      delOne(String(entry.id));
      overlay.toast('已撤回');
    } else {
      log.info('recall rejected: %s', String(ret && ret.data).slice(0, 200));
      overlay.toast('撤回失败：' + locText(String(ret && ret.data != null ? ret.data : '无应答')).slice(0, 30));
    }
  } catch (e) {
    log.warn('recall failed: %s', e && e.message);
    overlay.toast('撤回异常');
  }
}

/**
 * 好友关系同步判定（游戏内存同源：UserData.Friends Map，登录下发+push 维护，CheckIsMyFriend 口径）。
 * key 可能是数字/字符串，先 has 再转串遍历比（Map 条目为好友数、很小，开销可控）。
 * @param {object} entry 消息条目
 * @returns {boolean|null} null=判不出（无数据源异常）
 */
function checkFriend(entry) {
  if (!entry || !entry.uid) return null;
  try {
    var ud = game.get('DataCenter').DATA.UserData;
    var fr = ud && ud.Friends;
    if (!fr || typeof fr.has !== 'function' || typeof fr.keys !== 'function') return null;
    if (fr.has(entry.uid) || fr.has(+entry.uid)) return true;
    for (var k of fr.keys()) { if (String(k) === String(entry.uid)) return true; }
    return false;
  } catch (e) { return null; }
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
 * 从条目里按候选键序取字段值；值为对象时拆 Int64 {low,high}/{uid} 包裹形态（成员表 uid 字段结构未实证）。
 * @param {object} it 条目
 * @param {string[]} keys 候选字段名
 * @returns {string} 取不到的值返回空串
 */
function pickField(it, keys) {
  for (var k of keys) {
    var v = it[k];
    if (v == null || v === '') continue;
    if (typeof v === 'object') v = (v.uid != null ? v.uid : v.low);
    if (v != null && v !== '') return String(v);
  }
  return '';
}

/**
 * 把 1132 应答体解析成 {uid,name} 列表。应答 schema 已实证（AlliancePermissionPopup.js:60-68）：
 * 顶层含 members 数组，条目带 rank 与 playerInfo（内层 JSON 串，昵称在其 username 里）。
 * @param {object|Array} d parse 后的应答体
 * @param {string[]} diag 诊断输出收集器
 * @returns {Array<{uid:string, name:string}>}
 */
function parseMemberList(d, diag) {
  var arr = findMemberArray(d);
  if (!arr.length && d && typeof d.data === 'object' && d.data != null) arr = findMemberArray(d.data); // 信封多一层时下钻
  if (!arr.length) { diag.push('shape unknown: ' + JSON.stringify(d).slice(0, 240)); return []; }
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
    if (!uid || !name || seen.has(uid)) { if (!skippedSample && (!uid || !name)) skippedSample = it; continue; }
    seen.add(uid);
    list.push({ uid, name });
  }
  if (skippedSample) diag.push('unparsed item sample: ' + JSON.stringify(skippedSample).slice(0, 240));
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
  if (membersCache && Date.now() - membersCache.at < MEMBERS_TTL_MS) return membersCache.list;
  var net = window.pocketcc.net;
  if (!net) return [];
  try {
    var alliance = game.get('DataCenter').DATA.UserData.Alliance;
    var aid = alliance && alliance.Aid;
    if (!aid) return []; // 不在盟，无需查询
    var ret = await net.send(CMD_ALLIANCE_MEMBERS, { allianceId: aid }); // 透传原值，与游戏同源
    var diag = [];
    var list = parseMemberList(safeParse(ret && ret.data), diag);
    if (!list.length) {
      log.info('alliance members empty/rejected: ok=%s resp=%s', ret && ret.ok, String(ret && ret.data).slice(0, 240));
      return [];
    }
    membersCache = { list, at: Date.now() };
    log.info('alliance members fetched: %s', diag.join(' | '));
    var totalCount = +alliance.MemberCount || 0;
    if (totalCount && list.length < totalCount) log.warn('members incomplete (paged?) items=%d memberCount=%d', list.length, totalCount);
    return list;
  } catch (e) {
    log.warn('fetch alliance members failed: %s', e && e.message);
    return [];
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
    if (!uid || uid === 'unknown') { if (overlay) overlay.toast('先选择私聊对象'); return null; }
    return { c: 1, uid };
  }
  if (key === 'pm') { if (overlay) overlay.toast('先选择私聊对象，或点发送者名字开私聊'); return null; }
  if (key.indexOf(':') > 0 && familyOf(key) === 'cross') return { c: chanOfKey(key) }; // 跨服/活动发送不携 roomId（游戏同世界 else 分支，服务器路由到已 join 房）
  var d = CHAN_DEFS.find((x) => x.key === key);
  if (!d) { if (overlay) overlay.toast('该频道暂不支持发送'); return null; }
  var opts = { c: d.c };  // 直接传数字 c（send 内部 opts.c 优先，免走 channel 名映射；c=0 世界也不会被 || 吃掉）
  if (d.c === 5) {
    var b = bufOf(key);
    if (!b.roomId) syncRoomIds(); // roomId 兜底：不依赖玩家在游戏里切过频道（见 syncRoomIds）
    if (!b.roomId) { if (overlay) overlay.toast('未发现可发送的群聊频道（需已加入群）'); return null; }
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
  for (var a of (atList || [])) {
    var token = '@' + a.name;
    if (encoded.indexOf(token) < 0) continue;
    if (a.all) {
      encoded = encoded.split(token).join(AT_ALL_TOKEN);
      continue;
    }
    atData = atData || { uid: [], name: [], msgId: '' };
    var idx = atData.uid.length;
    atData.uid.push(a.uid);
    atData.name.push(a.name);
    encoded = encoded.replace(token, RS + idx + RS);
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
  var chat = window.pocketcc.chat;
  if (!chat) return false;
  var now = Date.now();
  if (now - lastSendAt < COOLDOWN_MS) {
    if (overlay) overlay.toast('发送太快，请 ' + Math.ceil((COOLDOWN_MS - (now - lastSendAt)) / 1000) + 's 后再试');
    return false;
  }
  var target = sendTarget(activeKey);
  if (!target) return false;
  var enc = encodeAt(text, atList);
  var responseData = quoteEntry ? { name: quoteEntry.name, msg: quoteEntry.plain, uuid: quoteEntry.id } : null;
  lastSendAt = now;
  if (overlay) overlay.startCooldown(Math.ceil(COOLDOWN_MS / 1000));
  // 乐观条目（回声到达时原位合并）
  var bAct = bufOf(activeKey);
  var localEntry = {
    id: 'local:' + now, uid: myUid(), timeMs: now, timeStr: hhmm(now), name: '我', self: true, mention: false,
    pmDir: activeKey.indexOf('pm:') === 0 && bAct.title !== activeKey ? '-> ' + bAct.title : null,
    segments: decodeAtCodes(enc.encoded, enc.atData),
    plain: text,
    quote: quoteEntry ? { name: quoteEntry.name, msg: quoteEntry.plain, id: quoteEntry.id } : null,
  };
  pushEntry(activeKey, localEntry);
  try {
    var opts = Object.assign({}, target, { atData: enc.atData, responseData });
    var ret = await chat.send(enc.encoded, opts);
    // net 不做 JSON_PARSE，Ret.data 是应答字符串原文（真机 2026-09-27：成功为 '{"success":1,m:...}' JSON 串，
    // 业拒为 '<本地化文案键,参数>' 裸串）；游表口径 t.d 先 parse 再 1 == n.success
    var payload = safeParse(ret && ret.data) || {};
    var ok = !!(ret && ret.ok && +payload.success === 1);
    if (!ok) {
      delOne(localEntry.id);
      var reason = typeof (ret && ret.data) === 'string' ? ret.data : (payload.msg || payload.message || '');
      if (overlay) overlay.toast('发送失败：' + (locText(String(reason || '服务器拒绝')).slice(0, 40)));
    }
    return ok;
  } catch (e) {
    delOne(localEntry.id);
    if (overlay) overlay.toast('发送异常：' + (e && e.message ? String(e.message).slice(0, 40) : ''));
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
  var chat = window.pocketcc.chat;
  if (!chat) return;
  var now = Date.now();
  if (now - lastSendAt < COOLDOWN_MS) { if (overlay) overlay.toast('发送太快，稍后再试'); return; }
  var target = sendTarget(activeKey);
  if (!target) return;
  lastSendAt = now;
  if (overlay) { overlay.startCooldown(Math.ceil(COOLDOWN_MS / 1000)); }
  try {
    var ret = await chat.sharePos(x, y, Object.assign({}, target));
    var payload = safeParse(ret && ret.data) || {}; // 同 doSend：Ret.data 是应答字符串原文
    if (overlay) overlay.toast(ret && ret.ok && +payload.success === 1 ? '已分享坐标 ' + x + ',' + y : '分享失败');
  } catch (e) {
    log.warn('share pos failed: %s', e && e.message);
    if (overlay) overlay.toast('分享异常');
  }
}

// ─────────────────────── 生命周期 ───────────────────────

/** Ctrl+K window 捕获监听（install 时装，全场景生效） */
function onKeydown(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key !== 'k' && e.code !== 'KeyK') return;
  e.preventDefault();
  if (!ctxRef || !ctxRef.alive()) return; // 功能未激活时热键静默
  var vis = overlay.toggle();
  if (vis) {
    renderActive();
    ensureHistory(activeKey);
    syncChannels();
    overlay.focusInput();
  }
}

/**
 * 浮层 handlers（视图动作 -> 业务）
 * @returns {object}
 */
function makeHandlers() {
  return {
    onSend: (text, atList, quote) => doSend(text, atList, quote),
    onSharePos: (x, y) => { doSharePos(x, y); },
    onRequestAtList: () => {
      var b = bufOf(activeKey);
      var speakers = [];
      var seen = new Set([myUid(), myStrUid()]);
      for (var [uid, name] of b.speakers) if (!seen.has(String(uid))) speakers.push({ uid: String(uid), name });
      speakers.sort((a, x) => a.name.localeCompare(x.name, 'zh'));
      var allowAll = activeKey === 'alliance' || activeKey === 'group';
      overlay.openAtPicker(speakers.slice(0, 50), allowAll);
      if (activeKey === 'alliance') {
        // 联盟频道：成员表异步到位后二次刷新候选（浮层开着时保留过滤词）
        ensureMembers().then((ms) => {
          if (!ms.length || !overlay) return;
          var merged = ms.slice();
          for (var s of speakers) if (!merged.some((m) => String(m.uid) === String(s.uid))) merged.push(s);
          overlay.setAtCandidates(merged);
        });
      }
    },
    onChannelSelect: (key) => activateKey(key),
    onSideSelect: (key) => activateKey(key),
    onLoadOlder: () => { loadOlder(); },
    onQuote: (entry) => { if (overlay) overlay.setQuote(entry); },
    onRevoke: (entry) => { doRevoke(entry); },
    onNamePm: (entry) => {
      if (!entry || entry.self || !entry.uid) return;
      if (activeKey.indexOf('pm:') === 0) return;
      var key = 'pm:' + entry.uid;
      bufOf(key, entry.name);
      activateKey(key);
    },
    onCheckFriend: (entry) => checkFriend(entry),
    onNameInfo: (entry) => {
      var net = window.pocketcc.net;
      if (!net || !entry || !entry.uid || entry.self || !overlay) return;
      net.send(CMD_PLAYER_INFO, { uid: String(entry.uid) }).then((ret) => {
        var d = safeParse(ret && ret.data);
        if (!ret || !ret.ok || !d || typeof d !== 'object') {
          log.info('PlayerInfo rejected: %s', String(ret && ret.data).slice(0, 200));
          overlay.showInfoPop(entry.name || '玩家信息', ['获取失败：' + locText(String(ret && ret.data != null ? ret.data : '无应答')).slice(0, 40)]);
          return;
        }
        overlay.showInfoPop(infoNick(d) || entry.name || '玩家信息', infoLines(d));
      }).catch((e) => {
        log.warn('PlayerInfo failed: %s', e && e.message);
        overlay.showInfoPop(entry.name || '玩家信息', ['查询异常']);
      });
    },
    onNameAddFriend: (entry) => {
      var net = window.pocketcc.net;
      if (!net || !entry || !entry.uid || entry.self) return;
      // 好友判定已由菜单侧 onCheckFriend 用 Friends Map 分流；这里是确认非好友后的发申请，服务器自拒兼做兜底
      net.send(CMD_ADD_FRIEND, { uid: String(entry.uid) }).then((ret) => {
        log.info('AddFriend resp: %s', String(ret && ret.data).slice(0, 200));
        if (overlay) overlay.toast(ret && ret.ok ? '好友申请已发送' : '加好友被拒：' + String(ret && ret.data != null ? ret.data : '').slice(0, 30));
      }).catch((e) => {
        log.warn('AddFriend failed: %s', e && e.message);
        if (overlay) overlay.toast('加好友异常');
      });
    },
    onVisibleChange: (visible) => { if (!visible && overlay) { /* 隐藏仅停渲染，订阅与缓冲继续 */ } },
    onGeomChange: (geom) => { try { Promise.resolve(storage.set(GEOM_KEY, geom)).catch(() => { }); } catch (e) { } },
  };
}

/**
 * 安装：建浮层、挂 Ctrl+K、异步恢复几何。幂等。
 * @param {object} ctx reactor 上下文
 * @returns {boolean} 成功
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  if (!window.pocketcc.chat) { log.warn('chat base unavailable'); return false; }
  overlay = new ChatOverlay(makeHandlers());
  overlay.mount();
  overlay.setOpacity(cfg.opacity);
  syncRoomIds();
  syncChannels();
  window.addEventListener('keydown', onKeydown, true);
  // 跨服房间随活动出现/消亡（游戏吸收 roomChatChange 后维护 chatHeads），开层时定时对账侧栏
  window.setInterval(function () {
    if (overlay && overlay.isVisible() && familyOf(activeKey)) { syncRoomIdsCross(); updateSide(); }
  }, 30000);
  installed = true;
  // 几何存档：读盘失败（命名空间未设等）静默用默认
  storage.get(GEOM_KEY).then((g) => { if (g && overlay) overlay.setGeom(g); }).catch(() => { });
  log.info('chat window installed (Ctrl+K).');
  return true;
}

/**
 * 配置推入：快捷栏/透明度热更。
 * @param {object} c toModuleCfg 产物
 * @returns {void}
 */
function configure(c) {
  if (!c) return;
  if (c.quick) cfg.quick = c.quick;
  if (c.opacity != null) cfg.opacity = c.opacity;
  if (overlay) { overlay.setOpacity(cfg.opacity); syncChannels(); }
}

/**
 * 激活：订阅聊天事件（pause 由 ctx.on.event 统一摘除）。
 * @param {object} ctx reactor 上下文
 * @returns {void}
 */
function run(ctx) {
  ctxRef = ctx;
  ctx.on.event('newChatPush', function (p) { ingest('push', p); });
  ctx.on.event('chatpushpm', function (p) { ingest('pm', p); });
  ctx.on.event('chatdel', function (p) { onDel(p); });
  ctx.on.event('chatupdate', function (p) { onUpdate(p); });
}

reactor.register({
  id: 'chatWindow',
  label: '聊天窗口',
  storageKey: 'pocketcc.chatWindow.config',
  defaults: {
    enabled: true,
    quickWorld: true, quickAlliance: true, quickPm: true, quickCross: true, quickGroup: false,
    opacity: 75,
  },
  fields: [
    { key: 'quickWorld', label: '世界', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickAlliance', label: '联盟', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickPm', label: '私聊', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickCross', label: '跨服', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickGroup', label: '群聊', type: 'checkbox', section: '快捷切换栏' },
    { key: 'opacity', label: '不透明度(%)', min: 30, step: 5 },
  ],
  toModuleCfg: function (c) {
    return {
      quick: { world: !!c.quickWorld, alliance: !!c.quickAlliance, pm: !!c.quickPm, cross: !!c.quickCross, group: !!c.quickGroup },
      opacity: c.opacity,
    };
  },
  install: function (ctx) { return install(ctx); },
  configure: configure,
  run: run,
});
