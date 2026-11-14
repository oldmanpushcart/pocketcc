/**
 * 聊天窗口 · 共享可变状态叶子（依赖方向红线：本文件不 import 任何兄弟切片，只 import core 原语）。
 *
 * 模型纪律（ESM 语义约束）：namespace import 绑定只读，`import * as ctx; ctx.x = …` 会抛 TypeError，
 * 因此可变状态统一收进单一导出对象 `S`，切片 `import { S }` 后通过 `S.xxx = …` 读写同一实例；
 * 永不重新赋值的常量/频道表/CMD 号则作为普通 named export（named import 只读绑定即可，无需前缀改造）。
 *
 * 装配方式：生命周期由 index.js 直接交给 reactor.register（不经本模块）；跨切片互调环由
 * S.fns 函数注册表打散：各切片求值期末尾 Object.assign(S.fns, {…}) 登记，调用点一律走 S.fns.xxx。
 */
import { createLog } from '../../../core/log.js';
import { chatApi } from '../../../core/chat.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CHATWIN） */
export const log = createLog('CHATWIN');

// ─────────── 常量（named export，只读绑定） ───────────

/** @type {string} @全体成员协议常量（chatCommon.AtAllName） */
export const AT_ALL_TOKEN = '@@__everyone__##';
/** @type {string} @全体成员展示文案（浮层与归一层共用；自 chat-overlay 下沉，避免纯函数层反向依赖视图模块） */
export const AT_ALL_LABEL = '全体成员';
/** @type {string} 游戏 checkAtData 的 @ 占位分隔符（String.fromCharCode(30)，记录分隔符 RS） */
export const RS = String.fromCharCode(30);
/** @type {number} 本地发送冷却（毫秒），对齐游戏 UI 层 5 秒 */
export const COOLDOWN_MS = 5000;
/** @type {number} 每会话键缓冲上限（条）——与翻页上限匹配（25 页×≈20 条/页），超出后最旧条目被挤掉，翻页游标仍有效 */
export const BUF_LIMIT = 600;
/** @type {number} 每频道单次进入的历史翻页上限（防 runaway；切频道重进会重置） */
export const MAX_PULL_PAGES = 25;
/** @type {string} 浮层几何存储键（UID 命名空间下） */
export const GEOM_KEY = 'pocketcc.chatWindow.geom';
/** @type {string} 私聊玩家信息盘缓存键（data blob：{uid:{d,ts}}，UID 命名空间下） */
export const PM_INFO_STORE_KEY = 'pocketcc.chat.playerInfo';
/** @type {number} 私聊玩家信息缓存有效期 ms（超期在点开该会话时重查） */
export const PM_INFO_TTL_MS = 3 * 24 * 3600 * 1000;
/** @type {number} 联盟成员缓存有效期（毫秒） */
export const MEMBERS_TTL_MS = 1000 * 60 * 10;
/** @type {number} 相邻两次 PM 信息查询的最小间隔 ms */
export const PM_INFO_GAP_MS = 500;

// ─────────── 协议 cmd 号 ───────────

// ─────────── 频道定义 ───────────

/**
 * 频道定义表：key 为缓冲/视图键，c 为 PostChatMsg 频道号（私聊带 uid 位另算）。
 * @type {Array<{key:string, label:string, c:number|null}>}
 */
export const CHAN_DEFS = [
  { key: 'world', label: '世界', c: 0 },
  { key: 'alliance', label: '联盟', c: 2 },
  { key: 'pm', label: '私聊', c: 1 },
  { key: 'cross', label: '跨服', c: 3 },
  { key: 'group', label: '群聊', c: 5 },
];

/** @type {Object<string, string>} 频道号 -> 缓冲键（world/alliance/…；未预置的落 c<n>） */
export const KEY_BY_C = {};
for (const d of CHAN_DEFS) if (d.c != null && d.key !== 'pm') KEY_BY_C[d.c] = d.key;

// ─────────── 可变状态（切片通过 S.xxx 读写同一实例） ───────────

/**
 * 单一可变状态对象：所有被多切片共用的模块级状态都收在这里，切片统一
 * `import { S } from './context.js'` 后 `S.xxx = …` 读写。
 */
export const S = {
  /** @type {object} 面板推入的模块配置（configure 更新） */
  cfg: {
    quick: { world: true, alliance: true, pm: true, cross: true, group: false },
    opacity: 75,
    showDate: true,
  },
  /** @type {import('./chat-overlay.js').ChatOverlay|null} 浮层视图实例（index.js 在 install 时置入） */
  overlay: null,
  /** @type {object|null} reactor 上下文 */
  ctxRef: null,
  /** @type {boolean} install 幂等守卫 */
  installed: false,

  /**
   * 会话缓冲：键 -> {title, c, roomId, list, ids, unread, loaded, pullPages, speakers, lastAt, readOnce, lastPreview}
   * @type {Map<string, object>}
   */
  bufs: new Map(),
  /** @type {string} 当前视图键 */
  activeKey: 'world',
  /** @type {'idle'|'busy'|'done'} 频道全量历史拉取状态 */
  channelHistoryState: 'idle',
  /** @type {number} 上次发送尝试时刻（冷却闸门） */
  lastSendAt: 0,

  /** @type {{list:Array<{uid:string,name:string}>, at:number}|null} 联盟成员表缓存 */
  membersCache: null,

  /** @type {Object<string, {d:object, ts:number}>} 玩家信息盘缓存镜像 */
  pmInfoStore: {},
  /** @type {boolean} 盘缓存是否已成功装载（仅读盘成功后置真，避免 UID 未就绪窗口把空快照钉死） */
  pmInfoDiskLoaded: false,
  /** @type {Map<string, {state:string, txt:string, av?:object, d?:object, ts?:number}>} 私聊侧栏副行信息缓存 */
  pmInfoCache: new Map(),
  /** @type {string[]} 待查玩家信息的会话键队列 */
  pmInfoQueue: [],
  /** @type {boolean} 是否有在途 PM 查询 */
  pmInfoServing: false,
  /** @type {boolean} 是否已拉过私聊会话列表 */
  pmListFetched: false,
  /** @type {Promise<void>|null} 私聊列表在途去重 */
  pmListPromise: null,
  /** @type {boolean} olderInflight 翻页在途闸门 */
  olderInflight: false,
  /** @type {boolean} locateInflight 定位在途闸门 */
  locateInflight: false,
  /** @type {boolean} battleInflight 战报查询在途闸门 */
  battleInflight: false,

  /**
   * 跨切片函数注册表：各切片在求值期把「可能被兄弟切片/装配层调用」的函数挂到 S.fns，
   * 调用点统一走 `S.fns.xxx(...)`。兄弟切片之间因此无需互相 import（依赖方向恒为 切片→context），
   * depcruise 无环；漏改的裸调用会触发 no-undef。装配前所有切片已完成登记，运行期调用无时序问题。
   * @type {Object<string, Function>}
   */
  fns: {},
};

// ─────────── 共用辅助（作用于 S.bufs，供各切片复用） ───────────

/**
 * 取（或建）缓冲
 * @param {string} key 会话键
 * @param {string} [title] 展示标题
 * @returns {object} 缓冲对象
 */
export function bufOf(key, title) {
  var b = S.bufs.get(key);
  if (!b) {
    b = {
      key,
      title: title || key,
      c: null,
      roomId: '',
      list: [],
      ids: new Set(),
      unread: 0,
      loaded: false,
      pullPages: 0,
      speakers: new Map(),
      lastAt: 0,
      readOnce: false,
      lastPreview: '',
    };
    var d = CHAN_DEFS.find((x) => x.key === key);
    if (d) b.c = d.c;
    S.bufs.set(key, b);
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
export function syncRoomIds() {
  var chat = chatApi;
  if (!chat || !chat.chatHeads) return;
  for (var h of chat.chatHeads()) {
    if (!h.id || h.channel === 1 || h.channel === 3) continue; // 私聊走 pm:<uid>；跨服多房间由侧栏视图按 cross:<roomId> 管理
    var key = KEY_BY_C[h.channel];
    if (!key) continue;
    var b = S.bufs.get(key);
    if (b && !b.roomId) b.roomId = String(h.id);
  }
}
