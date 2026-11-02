/**
 * chat 内部底座 · 共享 context（core/chat/context.js）
 * 原 core/chat.js 单 IIFE 闭包状态的目录化归宿（阶段五）：socket 客户端引用、订阅表、
 * 三组 hook 现场、命令号缓存等跨文件可变状态集中于此，导出单一 ctx 对象——各兄弟切片
 * （client/send/proxy/receive/log/normalize）读写同一份，语义与闭包共享变量严格等价。
 * 本文件零反向 import（只依赖 log/game/player），是 chat 目录的依赖叶子；
 * 生命周期编排（install 补挂 hook、uninstall 对称还原）经 setInstallerHooks 插槽由 client.js 回填，
 * 避免 receive/log ←→ client 循环。行为口径逐字继承拆分前 chat.js。
 */
import { createLog } from '../log.js';
import { game } from '../game.js';
import { getUid } from '../player.js';

/** @type {ReturnType<createLog>} 模块日志器（沿用拆分前 tag=CHAT，口径零漂移） */
export const log = createLog('CHAT');

/**
 * 应答超时（毫秒）。socket.emit("proxy") 的 ack 回调只在服务器应答时触发；
 * 不应答则 sendProxy 的 ok/err 永不执行、Promise 永挂，口径同 net.js SEND_TIMEOUT_MS。
 */
export const SEND_TIMEOUT_MS = 15000;

/**
 * 语义 type → socket 事件名。游戏侧 NetChatClient 对这几个事件只做逐字透传
 * （c.on('chatpush', e => EVENT.emit('newChatPush', e))，同引用无变形），故直连 socket 拿到的载荷
 * 与走 EventCenter 完全一致；del 只挂一次（游戏把 chatdel 双转发为 chatMsgDelete + chatdel）。
 * @type {Object<string,string>}
 */
export const SOCKET_MAP = {
  push: 'chatpush',
  pm: 'chatpushpm',
  update: 'chatupdate',
  del: 'chatdel',
  reconnect: 'reconnect',
};

/**
 * socket 实例身份自检间隔（毫秒）。实例更替的主路径已由 connectSocket 包装与 io 工厂包装零延迟捕获，
 * 这里只作兜底（_io 被别处改回原厂、或旧实例在无人调工厂时被丢弃），故放宽到 15s。
 */
export const REBIND_CHECK_MS = 15000;

/**
 * 频道语义预设：名称 → PostChatMsg 的 c 值。
 * 真机 2026-09-26 已验证：world=0（世界）、pm=1（私聊，opts.uid 必填）、alliance=2（联盟）。
 * 其余来源：chatCommon.CHAT_CHANNEL_TYPE 枚举（未逐一经流量验证，供参考）：
 *   cross=3 跨服 / mod=4 置顶 / group=5 群聊（opts.group 填 roomId）/ kvk=6 / cab=7 秘书组 / transfer=8 转会 / language=9 语种。
 * 未预设频道直接传 opts.c=数字即可。
 * @type {Object<string,number>}
 */
export const CHANNELS = {
  world: 0,
  pm: 1,
  alliance: 2,
  cross: 3,
  mod: 4,
  group: 5,
  kvk: 6,
  cab: 7,
  transfer: 8,
  language: 9,
};

/**
 * 聊天服务器固定应用号（真机与 newChatController 均硬编 102，入 sign 拼串首位）。
 * @type {number}
 */
export const APP_ID = 102;

/**
 * 跨切片共享的可变状态（拆分前为 IIFE 顶层闭包变量，逐字段等价搬入）。
 * @type {{
 *   client: object|null, installed: boolean,
 *   logEnabled: boolean, proxyOrig: Function|null, proxyMine: Function|null,
 *   proxyOwn: boolean, proxyHooked: boolean, logInboundOffs: Array<Function>,
 *   subs: Map<string, Set<Function>>, boundSocket: object|null, bound: Map<string, Function>,
 *   rebindTimer: number|null,
 *   connectOrig: Function|null, connectMine: Function|null, connectOwn: boolean, connectHooked: boolean,
 *   ioOrig: Function|null, ioMine: Function|null,
 *   postCmd: number|null, sysCmd: number|null,
 *   hooks: {install: Function|null, uninstall: Function|null}
 * }}
 */
export const ctx = {
  /** NetChatClient 伪静态类单例（game.get('NetChatClient').default） */
  client: null,
  /** 封装层是否已安装 */
  installed: false,

  /** 聊天日志总开关 */
  logEnabled: false,
  /** 原 sendProxy */
  proxyOrig: null,
  /** 我们的 sendProxy 包装 */
  proxyMine: null,
  /** client 上 sendProxy 原本是否为自有属性（决定还原用赋值还是 delete） */
  proxyOwn: false,
  /** sendProxy 当前是否已被包装 */
  proxyHooked: false,
  /** 日志期入站订阅的退订句柄 */
  logInboundOffs: [],

  /** 语义 type → 订阅者集（去重、退订配对、重挂遍历都走它） */
  subs: new Map(),
  /** 监听当前挂靠的 socket 实例（身份锚） */
  boundSocket: null,
  /** 在 boundSocket 上挂着的 type → 我们的 fan-out listener */
  bound: new Map(),
  /** socket 身份自检定时器（只在有订阅时跑） */
  rebindTimer: null,
  /** 原 connectSocket */
  connectOrig: null,
  /** 我们的 connectSocket 包装 */
  connectMine: null,
  /** client 上 connectSocket 原本是否为自有属性（决定还原用赋值还是 delete） */
  connectOwn: false,
  /** connectSocket 当前是否已被包装 */
  connectHooked: false,
  /** 原聊天 socket 工厂（client._io） */
  ioOrig: null,
  /** 我们的工厂包装 */
  ioMine: null,

  /** PostChatMsg 命令号（懒查 RequestId，查不到回落真机观测值 670） */
  postCmd: null,
  /** GET_CHAT_PUSH_LIST 命令号（懒查 NRequestIdV2，查不到回落源码观测值 954） */
  sysCmd: null,

  /** 生命周期插槽：client.js 求值期回填，installCore/uninstallCore 编排时调用（避免反向 import 成环） */
  hooks: { install: null, uninstall: null },
};

/**
 * proxy 应答结果：code 业务码（解析失败/缺字段为 null），data 完整应答对象（解析失败时为原始串）。
 * 驻 context 供 proxy.js 的 toRet 与外壳 api.Ret 共用（拆分前住同文件类声明）。
 */
export class Ret {
  /**
   * 构造应答结果
   * @param {number|null} code 业务码
   * @param {object|string} data 完整应答
   */
  constructor(code, data) {
    this.code = code;
    this.data = data;
  }

  /**
   * 是否业务成功（聊天服务器 code===1 为成功，同 NetChatClient.sendProxy 判据）
   */
  get ok() {
    return this.code === 1;
  }

  /**
   * 创建应答结果
   * @param {number|null} code 业务码
   * @param {object|string} data 完整应答
   * @returns {Ret}
   */
  static from(code, data) {
    return new Ret(code, data);
  }
}

/**
 * 安装核心：取 NetChatClient 单例并校验关键方法在场（拆分前 install 的状态操作部分）；
 * 成功后经 hooks.install 让 receive.js 补挂 connectSocket/_io 包装。
 * 模块在页面加载期即注册，无场景时机依赖；各 API 首用时懒兜底（同 event.on 模式），boot.js 不显式调用。
 * @returns {boolean} 安装成功
 */
export function installCore() {
  if (ctx.installed) return true;
  var mod = game.get('NetChatClient');
  var c = mod && mod.default;
  if (!c || typeof c.sendProxy !== 'function' || typeof c.IsValid !== 'function') {
    log.warn('install failed, NetChatClient is missing.');
    return false;
  }
  ctx.client = c;
  ctx.installed = true;
  if (ctx.hooks.install) ctx.hooks.install();
  log.info('installed.');
  return true;
}

/** client.js 回填生命周期插槽（求值期一次；receive/log 只经 ensure 懒触发安装，不 import client） */
export function setInstallerHooks(h) {
  ctx.hooks.install = h.install || null;
  ctx.hooks.uninstall = h.uninstall || null;
}

/**
 * 卸载核心：拆钩子→清订阅→放引用，顺序与拆分前 uninstall 严格一致；
 * hooks.uninstall 由 client.js 回填（log 还原 + 定时器/订阅表/socket 摘挂）。
 * @returns {boolean} 卸载成功
 */
export function uninstallCore() {
  if (!ctx.installed) return true;
  // hooks.uninstall 由 client.js 回填：按拆分前顺序 setLog(false)→stopRebindTimer→dropAllSubs→unhookConnect→unhookIo
  if (ctx.hooks.uninstall) ctx.hooks.uninstall();
  ctx.installed = false;
  ctx.client = null;
  log.info('uninstalled.');
  return true;
}

/**
 * 各 API 首用时的懒兜底：未安装则装一次（等价拆分前各函数内 `if (!installed && !install())` 行）。
 * @returns {boolean} 底座可用
 */
export function ensure() {
  return ctx.installed || installCore();
}

// ─────────────────────── 纯 helper（游戏符号只读，跨切片共用） ───────────────────────

/**
 * 懒解析 PostChatMsg 命令号（RequestId 枚举；查不到回落真机观测值 670，防模块改版时静默错发）
 * @returns {number} 命令号
 */
export function resolvePostCmd() {
  if (ctx.postCmd != null) return ctx.postCmd;
  var v = null;
  try {
    var m = game.get('RequestId');
    if (m) {
      if (typeof m.PostChatMsg === 'number') v = m.PostChatMsg;
      else if (m.RequestId && typeof m.RequestId.PostChatMsg === 'number')
        v = m.RequestId.PostChatMsg;
    }
  } catch (e) {}
  ctx.postCmd = v != null ? v : 670;
  if (v == null) log.warn('PostChatMsg not found in RequestId, fallback to observed 670.');
  return ctx.postCmd;
}

/**
 * 懒解析 GET_CHAT_PUSH_LIST 命令号（NRequestIdV2 枚举；查不到回落源码观测值 954，防改版静默错发）
 * @returns {number} 命令号
 */
export function resolveSysCmd() {
  if (ctx.sysCmd != null) return ctx.sysCmd;
  var v = null;
  try {
    var m = game.get('NRequestIdV2');
    if (m) {
      if (typeof m.GET_CHAT_PUSH_LIST === 'number') v = m.GET_CHAT_PUSH_LIST;
      else if (m.NRequestIdV2 && typeof m.NRequestIdV2.GET_CHAT_PUSH_LIST === 'number')
        v = m.NRequestIdV2.GET_CHAT_PUSH_LIST;
    }
  } catch (e) {}
  ctx.sysCmd = v != null ? v : 954;
  if (v == null)
    log.warn('GET_CHAT_PUSH_LIST not found in NRequestIdV2, fallback to observed 954.');
  return ctx.sysCmd;
}

/**
 * 当前服务器秒时刻（游戏 getCustomInfo 拼 clientTime/fClientTime 的同源字段 DataCenter.DATA.ServerTime）；
 * 探不到回落本地时间。
 * @returns {number}
 */
export function serverTimeSec() {
  try {
    var dc = game.get('DataCenter');
    var st = dc && dc.DATA && dc.DATA.ServerTime;
    if (st != null) return Math.floor(+st);
  } catch (e) {}
  return Math.floor(Date.now() / 1000);
}

/**
 * 当前玩家 StrUid（游表口径：custom.fUid / clientTime 用 StrUid，快速登录模式下与 UID 不同；
 * UID 取不到时回落到 getUid()）。
 * @returns {string}
 */
export function getStrUid() {
  try {
    var dc = game.get('DataCenter');
    var s = dc && dc.DATA && dc.DATA.UserData && dc.DATA.UserData.StrUid;
    if (s != null && s !== '') return String(s);
  } catch (e) {}
  var u = getUid();
  return u != null ? String(u) : '';
}

/**
 * 当前服号（坐标 z 值）：读 DataCenter.DATA.UserData.ServerId（游戏地图模块拼分享坐标的同源字段），
 * 探不到返回 0，由调用方显式传 opts.z。
 * @returns {number}
 */
export function getServerId() {
  try {
    var dc = game.get('DataCenter');
    var id = dc && dc.DATA && dc.DATA.UserData && dc.DATA.UserData.ServerId;
    if (id != null) return +id | 0;
  } catch (e) {}
  return 0;
}

/**
 * 连接状态快照的内部实现（status() 与 historyRooms/summary 共用，拆分前同走 status() 一函数）：
 * 不含懒 install（调用方已 ensure）。
 * @returns {object} {connected:boolean, socketIp:string, rooms:string[]}；rooms 为拷贝，不共享游戏数组引用
 */
export function roomsSnapshot() {
  var rooms = [];
  try {
    rooms = (ctx.client._rooms || []).slice();
  } catch (e) {}
  return { connected: !!ctx.client.IsValid(), socketIp: ctx.client._socketIp || '', rooms: rooms };
}
