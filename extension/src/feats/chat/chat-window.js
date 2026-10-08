/**
 * 聊天窗口 feat：半透明浮层（chat-overlay.js）的业务层。
 * 数据全部走 pocketcc.chat（只读+发包，不触碰游戏任何状态与 UI）：
 *   接收：EventCenter 的 newChatPush/chatpushpm/chatdel/chatupdate（经 ctx.on.event 订阅，pause 自动摘）
 *         → normalize → 预处理成可渲染 entry → 按频道/会话键入环形缓冲（每键 600 条，uuid 去重）；
 *   私聊/跨服为双列家族视图（微信 PC 风：左会话列表右聊天窗）；跨服 chip 侧栏列出全部活动动态房
 *         （游戏把这些子频道摆在世界 TAB 下：VchatChannelConfigV5 world subs 含 CROSS/KVK/各活动频道，
 *         房间随活动出现消亡，游戏已吸收 roomChatChange 订阅维护 _chatList.other，我们读同源+定时对账）；
 *   历史：首次打开（或切到未加载频道）调 chat.historyRooms()（loadHistoryV2，游戏 _rooms 全量）扇出入各频道缓冲；
 *         滚动到顶 chat.olderHistory(roomId, 最旧 uuid) 翻页（单次进入每频道最多 25 页）；
 *         私聊会话打开时 chat.history(uid) 全量 + chat.markRead(uid)；
 *   发送：chat.send（@编码按游戏真机口径 m 保留字面 "@昵称" + custom.atData 并列名单（checkAtData 只剪 atData、不改文本，
 *         渲染端 formationRichMsg 靠字面 @name 上色）；全体成员走 AtAllName 常量；
 *         引用 custom.responseData={name,msg,uuid}）/ chat.sharePos；本地 5s 冷却对齐游戏 UI 层 _bCanSend；
 *         发送即插乐观条目，真回声按 同文本+self+短时窗 原位合并。
 * 快捷键：Ctrl+K 开关浮层——window 捕获阶段监听（同 F8 教训：游戏在冒泡阶段 stopPropagation，
 *   document 冒泡监听在焦点于画布时收不到）。
 * 生命周期：无场景/模式门控（浮层是辅助 UI，全场景可用）；面板 enabled 驱动 install/run。
 */
import { createLog } from '../../core/log.js';
import { l10n, nav, gameData, gameConf, bits, avatar } from '../../core/game-api.js';
import { getUid } from '../../core/player.js';
import { storage } from '../../core/storage.js';
import { reactor } from '../../core/reactor.js';
import { ChatOverlay, AT_ALL_LABEL } from './chat-overlay.js';
import { classify, CST_LABEL } from './classify.js';

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

/** @type {string} 私聊玩家信息盘缓存键（data blob：{uid:{d,ts}}，UID 命名空间下） */
const PM_INFO_STORE_KEY = 'pocketcc.chat.playerInfo';
/** @type {Object<string, {d:object, ts:number}>} 玩家信息盘缓存镜像（整块写回） */
var pmInfoStore = {};
/** @type {boolean} 盘缓存是否已成功装载（仅读盘成功后置真，避免 UID 未就绪窗口把空快照钉死） */
var pmInfoDiskLoaded = false;
/** @type {number} 私聊玩家信息缓存有效期 ms（超期在点开该会话时重查） */
const PM_INFO_TTL_MS = 3 * 24 * 3600 * 1000;

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
  var t = l10n.channelName(+n); // 游戏同源：频道号→文案键（如 3→cross_server_system_007）再本地化
  if (t) return t;
  return '频道' + n;
}

/**
 * 服务器文案键 → 游戏当前语言文本（转发 core/game-api l10n.net，支持 '<键,参数>' 裸串；查不到回原文）
 * @param {*} s 应答 data 原文（文案键或任意文本）
 * @returns {string} 译文或原文
 */
function locText(s) { return l10n.net(s); }

/**
 * 语言键+参数 → 游戏当前语言文本（转发 core/game-api l10n.text，与游戏 getText(key,...paras) 同源；
 * 查不到回原文）。系统消息模板翻译（P3）与配置表 name 字段本地化均走此入口。
 * @param {string} key 语言键
 * @param {...*} paras 模板参数
 * @returns {string}
 */
function locGetText(key) { return l10n.text.apply(null, arguments); }

/**
 * 配置表行查询（转发 core/game-api l10n.tableRow，只读；未命中返回 null）。
 * @param {string} semantic 语义表名（emotion/emotionNew/emojiGif/item/building）
 * @param {*} id 行 id
 * @returns {object|null}
 */
function tableRow(semantic, id) { return l10n.tableRow(semantic, id); }

/** 空判（对齐游戏 r.Obj.isEmpty） */
function isEm(v) { return v == null || v === ''; }

/** @type {object} 面板推入的模块配置（configure 更新） */
var cfg = { quick: { world: true, alliance: true, pm: true, cross: true, group: false }, opacity: 75, showDate: true };

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
/** @type {number} RequestId.MAIL_QUERY（RequestId.js：e[e.MAIL_QUERY=929]），查战报邮件详情；游戏 shareLinkBattleClick 同源 {uid,mailId}，
 *  纯只读查询（同 630 的 net.send 通道），应答体 .d 串再 parse 取 .mail */
const CMD_MAIL_QUERY = 929;
/** @type {number} CHAT_INFO_LIST（服务器主动推），GET_CHAT_PUSH_LIST(≈954) 的实时对应物：被攻击/主动攻击等
 *  系统战报类消息经此推下（载荷 {header, data:{infos:[{uuid,content,roomId,time,channel,params}]}}，
 *  infos 项与 systemMessages 拉取同构）。原仅靠进频道时 systemMessages 拉一次，故实时看不到——这里订阅补上。 */
const CMD_CHAT_INFO_LIST = 10919;
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
    b = { key, title: title || key, c: null, roomId: '', list: [], ids: new Set(), unread: 0, loaded: false, pullPages: 0, speakers: new Map(), lastAt: 0, readOnce: false, lastPreview: '' };
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
 * 剥离 Cocos 富文本标签（<color=#xxx>…</c>、<b>/<i>/<u>/<font>/<outline>/<shadow>/<link>/<on click…>）
 * 与残留的 \x1E/\x1F 模板分隔符，仅保留可见文本（浮层是纯文本渲染，游戏用这些标签上色）。
 * @param {string} s 原文
 * @returns {string} 净文本
 */
function stripRich(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:color|c|b|i|u|font|outline|shadow|link|on|img|image|sprite|quad)\b[^>]*>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '') // 兜底：剔除其余任何 HTML 形标签（如系统推送内联的 <img src="battle_win"/>），防漏进纯文本浮层
    .replace(/[\u001e\u001f]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 对一段渲染片段逐个剔富文本（仅含 < > 或控制符的才拷贝重写，避免无谓分配）。
 * @param {object[]} segs buildEntry 产物 segments
 * @returns {object[]} 净片段
 */
function sanitizeSegments(segs) {
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    if (sg && typeof sg.s === 'string' && /[<>\u001e\u001f]/.test(sg.s)) {
      var c = Object.assign({}, sg); c.s = stripRich(sg.s); segs[i] = c;
    }
  }
  return segs;
}

/** @type {RegExp} 坐标链接化匹配：括号内两个 1~4 位整数（半/全角逗号、容忍空白），如 (270,452) / （3,7） */
const COORD_LINK_RE = /[（(]\s*(\d{1,4})\s*[,，]\s*(\d{1,4})\s*[)）]/g;

/**
 * 把文本片段里 (x,y) 形式的坐标替换成可点击跳转链接（inline chip，点击仅飞图+标记、默认本服 z=null）。
 * 只处理 type==='text' 片段；命中段切成 [前文本][坐标chip][后文本]，未命中原样。全/半角括号与逗号均识别。
 * 已带 action 的 chip / at 片段不介入（那是链接卡，语义更明确）。无命中时直接返回原数组，避免常规消息分配。
 * @param {object[]} segs sanitizeSegments 产物
 * @returns {object[]} 链接化后的片段
 */
function linkifyCoords(segs) {
  var out = null; // 懒建：首个命中前不拷贝，无命中路径零分配
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    var isText = sg && sg.type === 'text' && typeof sg.s === 'string' && (sg.s.indexOf('(') >= 0 || sg.s.indexOf('（') >= 0);
    if (!isText) { if (out) out.push(sg); continue; }
    var re = new RegExp(COORD_LINK_RE.source, 'g');
    var last = 0; var m; var hit = false;
    while ((m = re.exec(sg.s)) !== null) {
      var x = +m[1]; var y = +m[2];
      if (x === 0 && y === 0) continue; // (0,0) 视为非坐标占位，跳过
      if (!out) out = segs.slice(0, i);
      hit = true;
      if (m.index > last) out.push({ type: 'text', s: sg.s.slice(last, m.index) });
      out.push({ type: 'chip', s: m[0], action: { type: 'pos', x: x, y: y, z: null, subMap: null, click: false }, jumpHint: x + ',' + y });
      last = re.lastIndex;
    }
    if (hit) { if (last < sg.s.length) out.push({ type: 'text', s: sg.s.slice(last) }); }
    else if (out) out.push(sg);
  }
  return out || segs;
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
function myStrUid() { return gameData.strUid() || myUid(); }

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
 * 时间展示串：cfg.showDate 为真时 'yyyy-MM-dd HH:mm:ss'（历史跨度大时定位哪天），
 * 为假时仅 'HH:mm:ss'。秒始终展示（用户口径）。
 * @param {number} ms 毫秒时刻
 * @returns {string}
 */
function hhmm(ms) {
  var d = new Date(ms);
  var p = (n) => (n < 10 ? '0' : '') + n;
  var hms = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  return cfg.showDate ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hms : hms;
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
  if (uid === '-1') name = ''; // 系统消息（fu/uid=="-1"）无发送者昵称，正文模板即全部
  var self = !!uid && (uid === myUid() || uid === myStrUid());

  // 正文：历史项可能只有 content 无 m（游戏侧预处理口径），这里同源兼容；@编码还原 + 链接转 chip
  var text = String((norm.text != null && norm.text !== '') ? norm.text : (raw.content != null ? raw.content : ''))
    .split(AT_ALL_TOKEN).join('@' + AT_ALL_LABEL);
  var cls = classify(raw, norm, { translate: locGetText });
  var segments;
  if (cls.kind === 'system' || cls.kind === 'custom_system') {
    // P3：正文是语言键模板（\x1e/\x1f/|/; 规则，UpdateData:714-730），走游戏 getText 同键翻译；
    // 富卡片系统消息（cst∈ChatCustomSystemType）前置卡型 chip
    segments = decodeSystemText(cls.sys, atData);
    if (cls.kind === 'custom_system' && CST_LABEL[cls.cst]) segments = [{ type: 'chip', s: '[' + CST_LABEL[cls.cst] + ']' }].concat(segments);
  } else if (cls.kind === 'ct') {
    // ct 内容（红包/图片/寻人）：游戏展示文本为 getText(m)（UpdateData:732），chip 标类型 + 正文译文
    segments = [{ type: 'chip', s: cls.label }].concat(text ? decodeAtCodes(locGetText(text), atData) : []);
  } else if (cls.kind !== 'chat') {
    segments = linkSegments(cls, norm);
  } else if (kind === 'pm' && /^(\d+)\s*,\s*(\d+)$/.test(text)) {
    var mm = /^(\d+)\s*,\s*(\d+)$/.exec(text);
    segments = [{
      type: 'chip', s: '[位置 ' + mm[1] + ',' + mm[2] + ']',
      action: { type: 'pos', x: +mm[1], y: +mm[2], z: null, click: false }, jumpHint: mm[1] + ',' + mm[2],
    }];
  } else {
    segments = richSplit(text, custom.richParas, atData); // P4：内联表情/道具/建筑富文本 + @还原
  }
  // P4：消息表态（reactions=[{reactionType,count}]，>99 显示 99+，chatupdate 原位合并后自动重算）
  segments = segments.concat(reactionsSegments(raw.reactions));
  segments = sanitizeSegments(segments); // 剔服务器富文本标签（<color=…></c> 等）与控制符，防漏进纯文本浮层
  segments = linkifyCoords(segments); // 输出文本里的 (x,y) 坐标 → 可点击跳转链接（仅飞图+标记、默认本服）
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
    raw, // 保留原始项供 chatupdate 原位合并后重新 buildEntry/classify（生命周期 P2）
  };
  return { entry, key, self, otherUid: kind === 'pm' && self ? String((typeof raw.tu === 'object' ? raw.tu.uid : raw.tu) || '') : '' };
}

/**
 * 链接/特殊消息 classify 描述子 -> 渲染 chip 片段（带 action 则可跳转、否则可复制）。
 * 位置类按 st 语义与坐标出标签；行军/集结卡出跳转 chip；表情卡查表出名字；unknown 出占位 chip。
 * @param {object} cls classify() 产物
 * @param {object} norm normalize 产物（裸串 link<id> 表情回退查 emotionId）
 * @returns {object[]} segments
 */
function linkSegments(cls, norm) {
  // 撤回卡：置灰纯文本，无交互
  if (cls.kind === 'revoke') return [{ type: 'chip', s: cls.label || '[已撤回]' }];
  var label = cls.kind === 'emoji' ? emojiLabel(cls, norm) : cls.label;
  var hint = '';
  if (cls.action && cls.action.type === 'pos') hint = cls.action.x + ',' + cls.action.y + ' 跳转地图';
  else if (cls.action && cls.action.type === 'march') hint = '跳转行军线';
  else if (cls.action && cls.action.type === 'battle') hint = '查看战报详情';
  return [{ type: 'chip', s: label, action: cls.action || null, jumpHint: hint || label }];
}

/**
 * P4 表情/动图卡标题：按 parseLink:1075-1115 查表口径把 [表情]/[动图] 占位换成真名。
 * GIF(60)→emotionGIFId 查 emoji_gif 表；IMAGE(2)→customEmotionId 提示语 / emotionId、iconID 查
 * emotion_new 表 / iconIDs 按 '|' 分段逐查 emotion 表；裸串 link<id> 回退 norm.emotionId。
 * @param {object} cls classify() 产物（kind==='emoji'）
 * @param {object} norm normalize 产物
 * @returns {string} chip 文本（查不到回退 cls.label）
 */
function emojiLabel(cls, norm) {
  var llm = cls.llm || {};
  if (cls.t === 60) {
    var g = isEm(llm.emotionGIFId) ? null : tableRow('emojiGif', llm.emotionGIFId);
    return g ? '[' + locGetText(g.name) + ']' : cls.label;
  }
  if (!isEm(llm.customEmotionId)) return locGetText('emoji_upload_tips_07');
  if (!isEm(llm.emotionId) || !isEm(llm.iconID)) {
    var r1 = tableRow('emotionNew', !isEm(llm.emotionId) ? llm.emotionId : llm.iconID);
    if (r1) return '[' + locGetText(r1.name) + ']';
  }
  var icons = !isEm(llm.iconIDs) ? llm.iconIDs : (!isEm(llm.iconID) ? llm.iconID : (norm && !isEm(norm.emotionId) ? norm.emotionId : null));
  if (icons == null) return cls.label;
  var s = '';
  String(icons).split('|').forEach(function (h) { var r2 = tableRow('emotion', h); s += r2 ? '[' + locGetText(r2.name) + ']' : '[表情]'; });
  return s || cls.label;
}

/**
 * P3 系统消息模板 → 译文 segments（argsAreKeys 时参数逐个先译再代入，UpdateData:726-729）。
 * @param {{key:string,args:string[],argsAreKeys:boolean}|null} sys classify 产物 sys 字段
 * @param {object|null} atData custom.atData
 * @returns {object[]} segments
 */
function decodeSystemText(sys, atData) {
  if (!sys || isEm(sys.key)) return [];
  var args = sys.args || [];
  if (sys.argsAreKeys) args = args.map(function (a) { return locGetText(a); });
  return decodeAtCodes(locGetText.apply(null, [sys.key].concat(args)), atData);
}

/**
 * P4 [0:id]/[1:id]/[2:id] 富文本标签 → 游戏口径展示文本（ChatTools S()/D()/N() 同源：
 * 表情→[名]、道具→#名#、建筑→{名}）；查不到返回 null 交调用方回退原标签。
 * @param {number} ty CustomRichTagType（0表情/1道具/2建筑）
 * @param {string} id 表行 id
 * @returns {string|null}
 */
function richTagText(ty, id) {
  var row = ty === 0 ? tableRow('emotionNew', id) : ty === 1 ? tableRow('item', id) : ty === 2 ? tableRow('building', id) : null;
  if (!row) return null;
  var nm = locGetText(row.name);
  return ty === 0 ? '[' + nm + ']' : ty === 1 ? '#' + nm + '#' : '{' + nm + '}';
}

/**
 * P4 内联富文本：\uf8f8 占位符按序消费 custom.richParas("type,id")，[type:id] 标签直解；
 * 文本片段继续走 @还原。未命中查表时占位丢弃、标签保留原文（同游戏 U() 兜底）。
 * @param {string} text 正文
 * @param {string[]|undefined} richParas custom.richParas
 * @param {object|null} atData custom.atData
 * @returns {object[]} segments
 */
function richSplit(text, richParas, atData) {
  if (!/\uf8f8|\[\d+:\d+\]/.test(text)) return decodeAtCodes(text, atData);
  var out = []; var qi = 0; var last = 0; var m;
  var re = /\uf8f8|\[(\d+):(\d+)\]/g;
  var pushText = function (s) { if (s) out = out.concat(decodeAtCodes(s, atData)); };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    var ty; var id;
    if (m[0] === '\uf8f8') {
      var pr = String((richParas && richParas[qi++]) || '').split(',');
      if (pr.length !== 2 || isEm(pr[1])) { last = re.lastIndex; continue; } // 对齐游戏 U()：非法项替空
      ty = +pr[0]; id = pr[1];
    } else { ty = +m[1]; id = m[2]; }
    var txt = richTagText(ty, id);
    pushText(txt != null ? txt : (m[0] === '\uf8f8' ? '' : '[' + ty + ':' + id + ']'));
    last = re.lastIndex;
  }
  pushText(text.slice(last));
  return out;
}

/** @type {Object<string,string>} reactionType→中文标签（真机仅实证 'like'，其余原样显示） */
const REACT_LABEL = { like: '点赞' };

/**
 * P4 消息表态 → 尾部 chip（[{reactionType,count}] 过滤 count>0，>99 显示 99+）。
 * @param {Array|undefined} list raw.reactions
 * @returns {object[]} segments（无有效表态返回空数组）
 */
function reactionsSegments(list) {
  if (!Array.isArray(list)) return [];
  var parts = [];
  for (var r of list) {
    var n = r && +r.count || 0;
    if (n <= 0) continue;
    parts.push('[' + (REACT_LABEL[r.reactionType] || String(r.reactionType || '?')) + ' ×' + (n > 99 ? '99+' : n) + ']');
  }
  return parts.length ? [{ type: 'chip', s: parts.join(' ') }] : [];
}

/**
 * 还原 @ 编码：RS序号RS 片段换成 atData.name 对应昵称
 * @param {string} text 已替换 AtAllName 常量的正文
 * @param {object|null} atData custom.atData
 * @returns {object[]} segments
 */
function decodeAtCodes(text, atData) {
  // 游戏 m 保留字面 "@昵称"（atData 仅作并列上色名单）；RS序号RS 兼容旧格式/系统消息，其余文本段再按字面 @name 切
  var names = (atData && Array.isArray(atData.name) && atData.name.length)
    ? atData.name.map(function (nm) { return '@' + String(nm).split(AT_ALL_TOKEN).join('@' + AT_ALL_LABEL); }).filter(function (t) { return t.length > 1; })
    : [];
  var segs = [];
  var pushPlain = function (s) { if (s) segs = segs.concat(splitLiteralAt(s, names)); };
  var re = new RegExp(RS + '(\\d+)' + RS, 'g');
  var last = 0; var m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    var nm = atData && atData.name ? atData.name[+m[1]] : null;
    segs.push({ type: 'at', s: '@' + (nm != null ? String(nm).replace(AT_ALL_TOKEN, AT_ALL_LABEL) : '?') });
    last = re.lastIndex;
  }
  if (last < text.length) pushPlain(text.slice(last));
  return segs.length ? segs : [{ type: 'text', s: text }];
}

/**
 * 按 atData.name 名单把文本里的字面 "@昵称" 切成 at 高亮段（长名优先，防短名抢先截断）。
 * @param {string} s 文本片段
 * @param {string[]} names 已带前导 @ 的昵称列表
 * @returns {object[]} segments
 */
function splitLiteralAt(s, names) {
  if (!names.length || s.indexOf('@') < 0) return [{ type: 'text', s: s }];
  var sorted = names.slice().sort(function (a, b) { return b.length - a.length; });
  var out = []; var buf = ''; var i = 0;
  while (i < s.length) {
    if (s[i] === '@') {
      var hit = null;
      for (var k = 0; k < sorted.length; k++) { if (s.startsWith(sorted[k], i)) { hit = sorted[k]; break; } }
      if (hit) {
        if (buf) { out.push({ type: 'text', s: buf }); buf = ''; }
        out.push({ type: 'at', s: hit });
        i += hit.length; continue;
      }
    }
    buf += s[i]; i++;
  }
  if (buf) out.push({ type: 'text', s: buf });
  return out.length ? out : [{ type: 'text', s: s }];
}

/**
 * 按 timeMs 升序把条目插入缓冲（稳定：同一时刻后到者排在前到者之后，保实时到达序）。
 * 常态实时消息时间递增 → 命中快路径直接追尾；系统播报/战报补投（10919 批量、带历史时间戳）
 * 会乱序到达 → 二分定位插入，保证整列始终按时间排序（否则被追加到底部、把花车等实时卡顶错位）。
 * @param {object} b 缓冲对象
 * @param {object} entry 条目（须已含 timeMs）
 * @returns {boolean} 是否追加在尾部（true=有序追尾，可增量渲染；false=插入到列表中部，需整列重排）
 */
function insertOrdered(b, entry) {
  var list = b.list;
  if (!list.length || entry.timeMs >= list[list.length - 1].timeMs) {
    list.push(entry);
    b.ids.add(entry.id);
    return true;
  }
  var lo = 0; var hi = list.length;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (list[mid].timeMs <= entry.timeMs) lo = mid + 1; else hi = mid; }
  list.splice(lo, 0, entry);
  b.ids.add(entry.id);
  return false;
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
  var atTail = insertOrdered(b, entry); // 常态追尾；系统/战报补投带历史时间戳时按时间序插入
  while (b.list.length > BUF_LIMIT) { var drop = b.list.shift(); b.ids.delete(drop.id); }
  b.lastAt = Math.max(b.lastAt, entry.timeMs);
  if (!entry.self) {
    b.speakers.set(entry.uid, entry.name); // 近期发言者（@选人数据源）
    if (overlay && !(overlay.isVisible() && key === activeKey)) b.unread++;
  }
  if (overlay && overlay.isVisible() && key === activeKey) {
    // 追尾走增量（贴底自动跟随、否则浮标）；乱序插入按时间重排整列并保持阅读位置
    if (atTail) overlay.appendMessage(entry);
    else overlay.renderMessages(b.list, true);
  }
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

/**
 * 按 uuid 原位转「撤回」占位：并入 deletedAt 后重建条目（分类层出 revoke 卡），不物理移除。
 * 原条目不在缓冲时不凭空补入（避免造无上下文占位），返回 false。
 * @param {string} id uuid 串
 * @param {number} deletedAt 撤回时间戳（仅判 >0 触发 revoke 分类）
 * @returns {boolean} 命中并重建返回 true
 */
function revokeInPlace(id, deletedAt) {
  for (var b of bufs.values()) {
    var idx = b.list.findIndex((e) => e.id === id);
    if (idx < 0) continue;
    var merged = Object.assign({}, b.list[idx].raw || {}, { deletedAt: deletedAt });
    try {
      var r = buildEntry(merged, +merged.c === 1 ? 'pm' : 'push');
      r.entry.id = id; // 锁回原 uuid，避免合并后 id 漂移
      b.list[idx] = r.entry;
      return true;
    } catch (e) { return false; }
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
    if ((+p.deletedAt || 0) > 0) { if (revokeInPlace(String(p.uuid), +p.deletedAt)) touched = true; }
    else removeIds.add(String(p.uuid));
  }
  if (removeIds.size) {
    for (var b of bufs.values()) {
      var before = b.list.length;
      b.list = b.list.filter((e) => { if (removeIds.has(e.id)) { b.ids.delete(e.id); return false; } return true; });
      if (b.list.length !== before) touched = true;
    }
  }
  if (touched && overlay && overlay.isVisible()) renderActive();
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
    for (var b of bufs.values()) { for (var e of b.list) { if (e.id === id) { owner = b; break; } } if (owner) break; }
    if (owner) {
      var idx = owner.list.findIndex((e) => e.id === id);
      var merged = Object.assign({}, owner.list[idx].raw || {}, p); // 补丁覆盖原 raw（不 mutate 原对象）
      try {
        var r = buildEntry(merged, +merged.c === 1 ? 'pm' : 'push');
        r.entry.id = id; // 锁回原 uuid，避免合并后 id 漂移
        owner.list[idx] = r.entry;
        if (overlay && overlay.isVisible() && owner.key === activeKey) renderActive();
      } catch (e2) { /* 重建失败保留原条目 */ }
    } else {
      if (p.m != null || p.content != null) ingest(+p.c === 1 ? 'pm' : 'push', p);
    }
  }
}

/**
 * CHAT_INFO_LIST(10919) 实时推送：被攻击/主动攻击等系统战报消息（与 systemMessages 拉取同构的 infos）。
 * 复用 chat.toSysItem 归一（fu="-1" 命中系统模板分支）→ ingest('push') 按 uuid 去重入相应频道缓冲
 * （非当前频道计未读、当前频道 appendMessage 实时追底）。纯接收，不改游戏状态。
 * @param {object} ev net Event（ev.data 形如 {header, data:{infos}}，兼容 {infos} / JSON 串）
 * @returns {void}
 */
function onChatInfoList(ev) {
  var chat = window.pocketcc.chat;
  if (!chat || !chat.toSysItem) return;
  var d = ev && ev.data;
  if (typeof d === 'string') d = safeParse(d);
  var infos = (d && d.data && d.data.infos) || (d && d.infos) || null;
  if (!Array.isArray(infos) || !infos.length) return;
  var sys = [];
  for (var it of infos) { try { sys.push(chat.toSysItem(it)); } catch (e) { /* 单项脏数据跳过 */ } }
  if (sys.length) ingest('push', sys);
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
  // 切频道先重置顶部状态（在 renderMessages 前，避免覆盖随后 #fillViewport 同步触发的 loading）：私聊无翻页、频道达上限显“全部”
  setStatus(b.key.indexOf('pm:') === 0 ? '' : (b.pullPages >= MAX_PULL_PAGES ? 'end' : ''));
  overlay.renderMessages(list);
  b.unread = 0;
  b.readOnce = true; // 本会话已查看：后续 applySummary 不再用服务端未读覆盖（交本地增量/清零接管）
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
    // 服务器系统消息（GET_CHAT_PUSH_LIST）与 loadHistoryV2 结果同批入缓冲：合并后统一按时间升序，
    // 避免系统条目（fu="-1"）追加到列表尾部错序（游戏 getHistoryData 在 system_chat_on_server 下同源合并）。
    var items = historyList(ret);
    try {
      var sys = await chat.systemMessages({ channel: -1 });
      if (sys && sys.length) items = items.concat(sys);
    } catch (e) { log.warn('system messages unavailable: %s', e && e.message); }
    absorbHistoryItems(items);
    await absorbExtraRooms();
    for (var d of CHAN_DEFS) if (d.key !== 'pm') bufOf(d.key).loaded = true;
    channelHistoryState = 'done';
    try { await applySummary(); } catch (e) { log.warn('summary unavailable: %s', e && e.message); }
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
  insertOrdered(b, entry); // 与 pushEntry 同源：跨批次 absorb（主拉取 + 补拉房间）也按时间序合并
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
  if (!b.roomId) return;
  if (b.pullPages >= MAX_PULL_PAGES) { setStatus('end'); return; } // 已达上限：显式告知“已加载全部”
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
  if (String(oldest.id).charAt(0) === 'x') { log.info('oldest entry has synthetic id, skip paging'); return; }
  olderInflight = true;
  b.pullPages++;
  setStatus('loading');
  try {
    var chat = window.pocketcc.chat;
    var ret = await chat.olderHistory(b.roomId, oldest.id);
    // 被拒（code!==1）不锁死：退计次、留样本日志，下次滚顶还能重试；只有确认成功的空页才是真到头
    if (!ret || !ret.ok) {
      b.pullPages--;
      setStatus('error');
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
    var headMs = b.list.length ? b.list[0].timeMs : Infinity; // 插入前队首时间：判断这批旧史是否严格更旧
    var fresh = [];
    for (var en of entries) if (!b.ids.has(en.id)) { insertOrdered(b, en); fresh.push(en); } // 按时间归并：954 系统消息可能比翻页旧史更旧，不能整块前置
    if (fresh.length) {
      while (b.list.length > BUF_LIMIT) { var dropOld = b.list.pop(); b.ids.delete(dropOld.id); }
      if (overlay && overlay.isVisible() && activeKey === b.key) {
        // 整批都早于原队首（常态）→ 增量前插保阅读位置；否则（与更旧的系统消息交错）→ 整列按时间重排
        if (fresh[fresh.length - 1].timeMs < headMs) overlay.prependMessages(fresh);
        else overlay.renderMessages(b.list, true);
      }
    }
    if (!entries.length) { b.pullPages = MAX_PULL_PAGES; setStatus('end'); } // 确认成功的空页=真到头，锁止
    else setStatus(b.pullPages >= MAX_PULL_PAGES ? 'end' : '');
  } catch (e) {
    log.warn('older history failed: %s', e && e.message);
    setStatus('error');
  } finally { olderInflight = false; }
}

/** 顶部历史状态条（仅浮层可见时）：'loading'/'end'/'error'/'' 隐去 */
function setStatus(state) { if (overlay && overlay.isVisible()) overlay.setHistoryStatus(state); }

/**
 * 引用「定位原消息」时目标不在已加载区间：用 loadHistoryAround 拉取该消息前后上下文入缓冲后二次跳转。
 * overlay.#jumpTo 找不到行时经 handlers.onLocateMessage 回调进来。
 * @param {string} uuid 目标消息 uuid
 * @returns {Promise<void>}
 */
var locateInflight = false;
async function locateMessage(uuid) {
  if (locateInflight || !uuid) return;
  var key = activeKey;
  var b = bufOf(key);
  var chat = window.pocketcc.chat;
  var roomId = b.roomId;
  if (!roomId && b.c != null) { // 缓冲未带 roomId：按频道从 chatHeads 兜底解析（world/alliance/group 固定单会话）
    var heads = chat.chatHeads ? chat.chatHeads() : [];
    for (var h of heads) { if (h.channel === b.c && h.id) { roomId = b.roomId = String(h.id); break; } }
  }
  log.info('locate: key=%s roomId=%s uuid=%s', key, roomId || '(empty)', uuid);
  if (!roomId || !chat.aroundHistory) { if (overlay) overlay.toast('定位失败：会话房间未知'); return; }
  locateInflight = true;
  try {
    var ret = await chat.aroundHistory(roomId, uuid, { beforeCount: 40, afterCount: 40 });
    var list = historyList(ret);
    var hit = false;
    for (var it of list) if (String(it.uuid) === String(uuid)) { hit = true; break; }
    log.info('locate aroundHistory: ok=%s items=%d anchorInList=%s', ret && ret.ok, list.length, hit);
    if (!list.length) { if (overlay) overlay.toast('原消息已超期或不可加载'); return; }
    absorbHistoryItems(list);
    if (activeKey === key && overlay && overlay.isVisible()) { renderActive(); overlay.jumpToMessage(uuid); }
  } catch (e) {
    log.warn('around history locate failed: %s', e && e.message);
    if (overlay) overlay.toast('定位失败：' + (e && e.message ? String(e.message).slice(0, 30) : '未知'));
  } finally { locateInflight = false; }
}

/**
 * 用 getChatHomeSummary 的服务端权威摘要补齐最后一条预览（缓冲为空时给侧栏副标题兜底 lastSub）。
 * 注：不采用服务端 unreadCount 播种未读——频道/跨服房间无 markRead 通道，播种后 reload 会反复重现、无法真正消除；
 * 未读仍由本地计数（pushEntry 增量 + renderActive 查看清零）接管。
 * 仅覆盖已建缓冲且有 roomId 的会话。
 * @returns {Promise<void>}
 */
async function applySummary() {
  var chat = window.pocketcc.chat;
  if (!chat || !chat.summary) return;
  var ret = await chat.summary();
  var data = ret && ret.data && ret.data.data;
  var list = data && data.list;
  if (!list || typeof list !== 'object') return;
  var byRoom = new Map();
  for (var [k, bb] of bufs) if (bb.roomId) byRoom.set(String(bb.roomId), bb);
  var touched = false;
  for (var rid in list) {
    var info = list[rid];
    if (!info || !info.lastMessage) continue;
    var b = byRoom.get(String(rid));
    if (!b) continue;
    b.lastPreview = stripRich(info.lastMessage); touched = true;
  }
  if (touched && overlay && overlay.isVisible()) updateSide();
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
      items.push({ key: k, title: b.title !== k ? b.title : 'U' + k.slice(-4), sub: pmInfoText(k), unread: b.unread, ts: b.lastAt, avatar: (pmInfoCache.get(k) || {}).av });
    }
    for (var h of heads) {
      if (h.channel !== 1 || !h.id) continue;
      var pk = 'pm:' + h.id;
      if (has.has(pk)) continue;
      has.add(pk);
      if (h.name) bufOf(pk).title = h.name;
      var pb = bufOf(pk);
      items.push({ key: pk, title: pb.title !== pk ? pb.title : 'U' + String(h.id).slice(-4), sub: pmInfoText(pk), unread: pb.unread, ts: pb.lastAt, avatar: (pmInfoCache.get(pk) || {}).av });
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

/** @type {Map<string, {state:string, txt:string, av?:object, d?:object, ts?:number}>} 私聊侧栏副行信息缓存（键=会话键；进 TAB 不批量抓，仅点开会话/查看信息时刷新，盘缓存回填） */
var pmInfoCache = new Map();

/**
 * 私聊侧栏副行：对方基本信息（区/等级/power，用户口径不显聊天内容）；只读缓存，
 * 未命中不再入队（避免进私聊 TAB 整列会话批量抓 630）——改由点开该会话 / 查看信息时按需刷新。
 * @param {string} pk 'pm:<uid>'
 * @returns {string}
 */
function pmInfoText(pk) {
  var ci = pmInfoCache.get(pk);
  return ci ? ci.txt : '';
}

/** @type {string[]} 待查玩家信息的会话键队列（FIFO，去重） */
var pmInfoQueue = [];
/** @type {boolean} 是否有在途查询（串行闸门） */
var pmInfoServing = false;
/** @type {number} 相邻两次查询的最小间隔 ms（串行限速，保护服务器） */
const PM_INFO_GAP_MS = 500;

/** 消费队列：每轮最多发一个 630，完成（含失败）后隔 PM_INFO_GAP_MS 再下一个 */
function servePmInfo() {
  if (pmInfoServing) return;
  var pk = pmInfoQueue.shift();
  if (!pk) return;
  var uid = pk.slice(3);
  var net = window.pocketcc.net;
  if (!net || !/^\d+$/.test(uid)) { pmInfoCache.set(pk, { state: 'fail', txt: '' }); servePmInfo(); return; } // 不可查形态直接定案，不占带宽
  pmInfoServing = true;
  pmInfoCache.set(pk, { state: 'pending', txt: '' });
  net.send(CMD_PLAYER_INFO, { uid }).then((ret) => {
    var d = safeParse(ret && ret.data);
    if (!ret || !ret.ok || !d || typeof d !== 'object') { pmInfoCache.set(pk, { state: 'fail', txt: '' }); return; }
    pmStoreSet(uid, d); // 回填内存视图缓存 + 写穿盘
    if (overlay && overlay.isVisible() && familyOf(activeKey) === 'pm') updateSide();
  }).catch(() => { pmInfoCache.set(pk, { state: 'fail', txt: '' }); })
    .finally(() => {
      pmInfoServing = false;
      if (pmInfoQueue.length) setTimeout(servePmInfo, PM_INFO_GAP_MS);
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
  if (d.power != null) b.push('战力 ' + fmtPower(d.power));
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
  pmInfoStore[uid] = { d: d, ts: ts };
  try { Promise.resolve(storage.data.set(PM_INFO_STORE_KEY, Object.assign({}, pmInfoStore))).catch(() => { }); } catch (e) { }
  var pk = 'pm:' + uid;
  pmInfoCache.set(pk, { state: 'done', txt: pmBitsText(d), av: resolveAvatar(d, { uid: uid, name: (bufOf(pk) && bufOf(pk).title) || '' }), d: d, ts: ts });
}

/**
 * 装载私聊玩家信息盘缓存（仅成功读盘后定案 loaded），回填 pmInfoCache，
 * 使进私聊 TAB 直接显缓存、不批量重抓。命名空间未就绪时 reject 不落 loaded，下次进私聊再试。
 * @returns {Promise<void>} 读盘（或已 loaded 时的立即 resolve），供 backfillPmInfo 串接
 */
function loadPmInfoCache() {
  if (pmInfoDiskLoaded) return Promise.resolve();
  return storage.data.get(PM_INFO_STORE_KEY).then((blob) => {
    pmInfoDiskLoaded = true;
    if (!blob || typeof blob !== 'object') return;
    pmInfoStore = blob;
    for (var uid in pmInfoStore) {
      var rec = pmInfoStore[uid];
      if (!rec || !rec.d || typeof rec.d !== 'object') continue;
      var pk = 'pm:' + uid;
      var cur = pmInfoCache.get(pk);
      if (cur && cur.state === 'done' && (cur.ts || 0) >= (rec.ts || 0)) continue; // 内存比盘新（本次已查）不覆盖
      pmInfoCache.set(pk, { state: 'done', txt: pmBitsText(rec.d), av: resolveAvatar(rec.d, { uid: uid, name: (bufOf(pk) && bufOf(pk).title) || '' }), d: rec.d, ts: rec.ts || 0 });
    }
    if (overlay && overlay.isVisible() && familyOf(activeKey) === 'pm') updateSide();
  }).catch(() => { /* 读盘失败/命名空间未就绪：下次进私聊再试 */ });
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
  var ci = pmInfoCache.get(key);
  var stale = !ci || ci.state !== 'done' || (Date.now() - (ci.ts || 0) > PM_INFO_TTL_MS);
  if (!stale) return;
  if (pmInfoQueue.indexOf(key) < 0) pmInfoQueue.push(key);
  servePmInfo();
}

/**
 * 进私聊 TAB 时回填空数据：扫描全部会话（缓冲 pm: + chatHeads c=1），仅把「无 done 缓存」
 * 的玩家入既有串行队列（servePmInfo，500ms 限速、非并行）逐个补查。盘缓存命中者不重抓，
 * 故冷启动一次性补齐后，后续进 TAB 几乎无空位、不再批量抓。与 maybeRefreshPmInfo 共用队列去重。
 * @returns {void}
 */
function backfillPmInfo() {
  var chat = window.pocketcc.chat;
  var keys = new Set();
  for (var [k] of bufs) { if (k.indexOf('pm:') === 0) keys.add(k); }
  if (chat && chat.chatHeads) {
    for (var h of chat.chatHeads()) { if (h.channel === 1 && h.id) keys.add('pm:' + h.id); }
  }
  var enq = 0;
  for (var key of keys) {
    var uid = key.slice(3);
    if (!/^\d+$/.test(uid)) continue; // 非数字 uid（StrUid 等）不可查，跳过不占带宽
    var ci = pmInfoCache.get(key);
    if (ci && ci.state === 'done') continue; // 已有（盘/本次）不重抓
    if (ci && ci.state === 'pending') continue; // 在途
    if (ci && ci.state === 'fail') continue; // 已定案失败，不在此重试（点开时 maybeRefreshPmInfo 再试）
    if (pmInfoQueue.indexOf(key) < 0) { pmInfoQueue.push(key); enq++; }
  }
  if (enq) servePmInfo();
}

// ─────────────────────── 私聊会话枚举 (/pm/loadChatList) ───────────────────────

/** @type {boolean} 是否已拉过会话列表（生命周期内枚举一次，后续靠推信增量维护） */
var pmListFetched = false;
/** @type {Promise<void>|null} 在途去重（避免刷侧栏时重复发） */
var pmListPromise = null;

/**
 * 用 /pm/loadChatList 枚举全部私聊会话（含游戏 UI 未打开过的），补进 pm:<uid> 缓冲的标题/时间。
 * 只读补全，不改游戏任何状态；对方昵称从 profile(fp/tp) 解析（自己发出的行取 tp、收到的行取 fp），
 * 拉不到名字时保留 U尾号 占位。完成时若正停在私聊家族则刷左侧列表。
 * @returns {Promise<void>|undefined} 无 pmList API 时返回 undefined
 */
function seedPmList() {
  if (pmListFetched) return undefined;
  if (pmListPromise) return pmListPromise;
  var chat = window.pocketcc.chat;
  if (!chat || !chat.pmList) return undefined;
  pmListPromise = (async () => {
    try {
      var ret = await chat.pmList({ channel: 1 });
      var list = (ret && ret.data && ret.data.data && ret.data.data.list) || [];
      var meS = myStrUid(); var meU = myUid();
      for (var it of list) {
        var fu = String(it.fu || ''); var tu = String(it.tu || '');
        var selfSent = !!fu && (fu === meS || fu === meU);
        var other = selfSent ? tu : fu;
        if (!other || other === meS || other === meU) continue;
        var prof = safeParse(selfSent ? it.tp : it.fp) || {};
        var pk = 'pm:' + other;
        var pb = bufOf(pk);
        if (prof.username && pb.title === pb.key) pb.title = String(prof.username);
        pb.lastAt = Math.max(pb.lastAt, toMs(it.t != null ? it.t : null, it.time != null ? it.time : null));
      }
      pmListFetched = true;
      if (overlay && overlay.isVisible() && familyOf(activeKey) === 'pm') updateSide();
    } catch (e) {
      log.warn('pm list seed failed: %s', e && e.message);
    } finally { pmListPromise = null; }
  })();
  return pmListPromise;
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
    var cacheP = loadPmInfoCache(); // 进私聊家族：先用盘缓存回填侧栏（不批量重抓）
    var listP = seedPmList(); // 异步枚举全部私聊会话补入左侧列表（不阻塞当前 chip 选中）
    // 盘缓存 + 会话列表都就绪后，回填空数据玩家（串行逐个，非并行）
    Promise.all([Promise.resolve(cacheP), Promise.resolve(listP)]).then(backfillPmInfo, backfillPmInfo);
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
  maybeRefreshPmInfo(key); // 切进具体私聊会话：缓存缺失/过期才刷新该一个（不批量抓）
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

/** 战力/大数字单位阶梯：与游戏 NumUtils.getLargeNumberShow 完全一致 —— K,M,B,T 后接 aa..zz，每档 ×1000（下标 j 对应阈值 1000^(len-j)） */
const POWER_UNITS = (function () {
  var u = ['K', 'M', 'B', 'T'];
  for (var c = 97; c <= 122; c++) u.push(String.fromCharCode(c) + String.fromCharCode(c));
  return u;   // 长度 30
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
    for (var s = n + 1; s < len; s++) r *= 1e3;   // r = 1000^(len - n)，从大阈值往下扫，首个 v>=r 即为当档
    if (v >= r) {
      var l = v > 100 * r ? 0 : (v > 10 * r ? 1 : 2);
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
  if (d.power != null) lines.push('战力: ' + fmtPower(d.power));
  // armyPower 暂不展示：换算公式未明（用户口径）
  if (d.allianceName) lines.push('联盟: ' + d.allianceName + (d.allianceTag ? ' [' + d.allianceTag + ']' : ''));
  if (d.x != null && d.y != null) lines.push({
    s: '坐标: ' + d.x + ',' + d.y + (d.serverId != null ? '@' + d.serverId : ''),
    action: { type: 'pos', x: +d.x, y: +d.y, z: d.serverId != null ? +d.serverId : null, click: true },
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
  var shownUid = d.uid != null ? String(d.uid) : (uid != null && uid !== '' ? String(uid) : '');
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
  var rawVal = ''; var usedKey = '';
  for (var i = 0; i < src.length && !rawVal; i++) {
    var o = src[i]; if (!o || typeof o !== 'object') continue;
    for (var k = 0; k < AVATAR_KEYS.length; k++) {
      var v = o[AVATAR_KEYS[k]];
      if (typeof v === 'string' && v.trim()) { rawVal = v.trim(); usedKey = AVATAR_KEYS[k]; break; }
    }
  }
  // 头像字段可能是 http(s) 真实 URL（平台/用户上传），也可能是游戏自带头像图集名（hero_icon…_global 等，
  // 非 URL，直接塑 <img> 会 404）→ 统一交 core/game-api avatar.iconUrl 换算（图集名走游戏 PathUtils.GetIconURL）。
  var url = rawVal ? avatar.iconUrl(rawVal) : '';
  if (usedKey) log.info('playerInfo avatar hit: %s -> %s', usedKey, url ? 'url' : 'placeholder');
  var nick = infoNick(d) || (entry && entry.name) || '';
  var uid = String((entry && entry.uid) || (d && d.uid) || '');
  var initial = nick ? Array.from(nick)[0].toUpperCase() : (uid ? 'U' + uid.slice(-4) : '?');
  var hue;
  if (uid && /\d/.test(uid)) hue = Math.abs(parseInt(uid.slice(-6), 10) || 0) % 360;
  else { var h = 0; var s = nick || uid || '?'; for (var j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) | 0; hue = Math.abs(h) % 360; }
  return { url: url, initial: initial, hue: hue };
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
  var limit = +gameConf.dataConfig(630061) || 60; // 撤回时限配置（game-api 取不到时默认 60s）
  var nowSec = gameData.serverTime() || Math.floor(Date.now() / 1000);
  if (nowSec - Math.floor(entry.timeMs / 1000) > limit) { overlay.toast('超过 ' + limit + ' 秒时限，不能撤回'); return; }
  var channel = b.c != null ? b.c : (activeKey.indexOf('pm:') === 0 ? 1 : chanOfKey(activeKey));
  if (channel == null) { overlay.toast('无法确定该消息的频道'); return; }
  var roomId = b.roomId || '';
  if (activeKey.indexOf('pm:') === 0) roomId = activeKey.slice(3); // 私聊房标识=对方 uid（游戏 NowChoiceKey.Id 同形）
  // 游戏 revokeMsg 同源：无下划线 → Int64.fromString(roomId)，其余 → 0（game-api bits 封装）
  var toUid = bits.int64(roomId.indexOf('_') <= 0 ? (roomId || '0') : '0');
  try {
    var ret = await net.sendPBV2(CMD_RECALL_CHAT, { roomId: roomId, uuid: String(entry.id), channel: channel, toUid: toUid });
    if (ret && ret.ok) {
      revokeInPlace(String(entry.id), Date.now()); // 原位转撤回卡，与游戏观感一致（服务器 chatdel 再幂等确认）
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
    var alliance = gameData.alliance();
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

// ─────────────────── P5 联动跳转（导航能力在 core/game-api nav，本层只出文案） ───────────────────

/**
 * 跳转执行入口：按卡片 action 调 game-api 导航；技术 err 语义键映射为用户文案。
 * @param {object} action classify 产出/信息卡坐标行的 {type:'pos'|'march', ...}
 * @returns {void}
 */
function jumpTo(action) {
  if (!action || !overlay) return;
  if (action.type === 'battle') { queryBattle(action); return; } // 战报卡：纯只读 MAIL_QUERY 查询 + 浮层展示（见下方 queryBattle）
  var r = action.type === 'march' ? nav.flyMarch(action)
    : action.type === 'pos' ? nav.flyTo(action)
      : { ok: false, err: 'nomarch' };
  if (r.ok) {
    overlay.toast(action.type === 'march' ? '跳转行军线' : (action.click ? '跳转并选中 ' : '定位到 ') + action.x + ',' + action.y);
    return;
  }
  overlay.toast(r.err === 'unavailable' ? '世界地图导航不可用'
    : r.err === 'nomarch' ? '该卡片暂不能直接跳转' : '跳转异常');
}

/** @type {boolean} 战报查询在途闸门（防连点爆发重复请求，同 servePmInfo 口径） */
var battleInflight = false;

/**
 * 点战报卡（capability=query-battle）：发 MAIL_QUERY 纯只读查询，回包解析后在浮层展示详情。
 * 全程不触碰游戏 OpenUI（红线）；action.uid/mailId 由 classify 从 llm.fuid/llm.mId 提取。
 * @param {object} action {uid, mailId}
 * @returns {Promise<void>}
 */
async function queryBattle(action) {
  if (battleInflight || !overlay) return;
  var net = window.pocketcc.net;
  if (!net || !action || !action.uid || !action.mailId) { overlay.toast('战报暂不可查'); return; }
  battleInflight = true;
  try {
    var ret = await net.send(CMD_MAIL_QUERY, { uid: action.uid, mailId: action.mailId });
    var resp = safeParse(ret && ret.data);
    // 游戏口径：应答 .d 是 JSON 串，parse 后取 .mail；兼容应答体直接挂 mail / 无 .d 包裹的形态
    var inner = resp && resp.d != null ? safeParse(resp.d) : resp;
    var mail = inner && inner.mail ? inner.mail : inner;
    if (!ret || !ret.ok || !mail || typeof mail !== 'object') {
      log.info('mail query empty: ok=%s respKeys=%s', ret && ret.ok, resp && Object.keys(resp).join(','));
      overlay.toast('战报暂不可查'); return;
    }
    overlay.showInfoPop('战报详情', battleRows(mail));
  } catch (e) {
    log.warn('mail query failed: %s', e && e.message);
    overlay.toast('战报查询失败');
  } finally {
    battleInflight = false;
  }
}

/**
 * 战报 mail 报头 -> showInfoPop 信息行（白名单渲染，不拉 rUrl）。
 * 真机实证：MAIL_QUERY 应答仅报头（title/reportId/rUrl/rewardStatus/fromUser/rrId/fromUserInfo），
 * 战斗明细在 rUrl 指向的限时 OSS JSON 里（易过期、需另解 schema），故只排干净报头 + 一句引导，不逐条 dump 原始键。
 * @param {object} mail MAIL_QUERY 应答里的战报报头
 * @returns {Array<string|{s:string, action:object}>}
 */
function battleRows(mail) {
  var lines = [];
  if (!mail || typeof mail !== 'object') return lines;
  log.info('battle mail keys: %s', Object.keys(mail).join(','));
  var title = pickField(mail, ['title', 'reportName', 'name', 'subject']);
  if (title) lines.push('战报: ' + title);
  var rid = pickField(mail, ['reportId', 'rId']);
  if (rid) lines.push('战报编号: ' + rid);
  lines.push('完整战斗明细请在游戏内点开查看（战报正文限时有效）');
  return lines;
}

/**
 * 浮层 handlers（视图动作 -> 业务）
 * @returns {object}
 */
function makeHandlers() {
  return {
    onSend: (text, atList, quote) => doSend(text, atList, quote),
    onSharePos: (x, y) => { doSharePos(x, y); },
    onJump: (action) => { jumpTo(action); },
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
    onLocateMessage: (uuid) => { locateMessage(uuid); },
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
        pmStoreSet(String(entry.uid), d); // 查看信息也写穿缓存（侧栏副行/头像随之更新）
        if (overlay && overlay.isVisible() && familyOf(activeKey) === 'pm') updateSide();
        overlay.showInfoPop(infoNick(d) || entry.name || '玩家信息', infoLines(d, entry.uid), resolveAvatar(d, entry));
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
 * 日期展示开关变更后：按 timeMs 重算各缓冲条目展示串并刷新当前视图（timeStr 已烘焙进条目）。
 * @returns {void}
 */
function retimeAll() {
  for (var b of bufs.values()) for (var e of b.list) e.timeStr = hhmm(e.timeMs);
  if (overlay && overlay.isVisible()) renderActive();
}

/**
 * 配置推入：快捷栏/透明度/日期展示热更。
 * @param {object} c toModuleCfg 产物
 * @returns {void}
 */
function configure(c) {
  if (!c) return;
  if (c.quick) cfg.quick = c.quick;
  if (c.opacity != null) cfg.opacity = c.opacity;
  var dateToggled = c.showDate != null && !!c.showDate !== cfg.showDate;
  if (c.showDate != null) cfg.showDate = !!c.showDate;
  if (overlay) { overlay.setOpacity(cfg.opacity); syncChannels(); }
  if (dateToggled) retimeAll();
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
  // CHAT_INFO_LIST(10919)：被攻击/主动攻击等系统战报消息的实时推（走主协议 bus.net.<cmd>，非聊天 socket 事件）
  ctx.on.push(CMD_CHAT_INFO_LIST, onChatInfoList);
}

reactor.register({
  id: 'chatWindow',
  label: '聊天窗口',
  storageKey: 'pocketcc.chatWindow.config',
  symbols: ['dataCenter', 'tableManager', 'tableUtils', 'long64Bit', 'chatCommon?', 'navFly?'],
  defaults: {
    enabled: true,
    quickWorld: true, quickAlliance: true, quickPm: true, quickCross: true, quickGroup: false,
    showDate: true,
    opacity: 75,
  },
  fields: [
    { key: 'quickWorld', label: '世界', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickAlliance', label: '联盟', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickPm', label: '私聊', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickCross', label: '跨服', type: 'checkbox', section: '快捷切换栏' },
    { key: 'quickGroup', label: '群聊', type: 'checkbox', section: '快捷切换栏' },
    { key: 'showDate', label: '时间含年月日', type: 'checkbox', section: '消息显示' },
    { key: 'opacity', label: '不透明度(%)', min: 30, step: 5 },
  ],
  toModuleCfg: function (c) {
    return {
      quick: { world: !!c.quickWorld, alliance: !!c.quickAlliance, pm: !!c.quickPm, cross: !!c.quickCross, group: !!c.quickGroup },
      showDate: !!c.showDate,
      opacity: c.opacity,
    };
  },
  install: function (ctx) { return install(ctx); },
  configure: configure,
  run: run,
});
