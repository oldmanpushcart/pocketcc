// 口袋控制中心 — 升级通道在远程体侧的镜像（MAIN world）。
// 远程体不碰网络、也不碰 chrome.*：状态只由 background 经 bridge 广播而来，面板上的写操作
// （检查更新 / 清除已下载包 / 锁定 / 稍后）一律以命令形式转给后台，回执即最新快照。
// 本模块只做「取快照 + 发命令 + 把状态摊到 bus 上」，判据一律在 core/update.js（纯函数）。
import { NS } from './constants.js';
import { bus, EVT } from './bus.js';
import { createLog } from './log.js';
import { ASK_TIMEOUT_MS } from './update.js';

/** @type {ReturnType<createLog>} 升级通道日志器（tag=UPDATE） */
const log = createLog('UPDATE');

/** @type {number} 请求-应答关联自增序号 */
let seq = 0;
/** @type {Map<string, {resolve: Function, reject: Function}>} 消息 id -> 在途请求 */
const pending = new Map();
/** @type {object|null} 最近一次后台快照（null = 还没通过话，UI 需容空态） */
let last = null;
/** @type {boolean} 监听是否已挂（只允许挂一次） */
let installed = false;

/**
 * 收到 bridge 回包：广播按 ev 认，请求回执按 id 认。两类都可能在同一 world 与 storage.js 的回执并存，
 * 故未登记的 id 一律放过，绝不替别人 resolve/reject。
 * @param {MessageEvent} event window message 事件
 */
function onMessage(event) {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.__ns !== NS || msg.dir !== 'bridge->main') return;
  if (msg.ev === 'update-state') {
    apply(msg.state);
    return;
  }
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error));
  else entry.resolve(msg.result);
}

/**
 * 快照落库并广播（同一份快照重复到达也照发，UI 侧自己做幂等）
 * @param {object} state 后台 snapshot()
 * @returns {object} 入参原样，便于链式
 */
function apply(state) {
  if (!state || typeof state !== 'object') return state;
  last = state;
  bus.emit(EVT.UPDATE_STATE, state);
  return state;
}

/**
 * 向 bridge 发一次升级通道请求并等回执。必然在 ASK_TIMEOUT_MS 内 settle：本模块的调用方全在启动链上，
 * 一个永不落定的 promise 会把等它的那一段卡死（后台被回收 / bridge 上下文失效时根本不会有回执）。
 * @param {'update-bundle'|'update-cmd'} op 协议操作名
 * @param {object} [payload] 附带字段
 * @returns {Promise<*>} 后台结果
 */
function ask(op, payload) {
  const id = `${NS}-upd-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`update round trip timeout (${ASK_TIMEOUT_MS}ms)`));
    }, ASK_TIMEOUT_MS);
    // settle 前清掉定时器：超时与被回执争同一笔账时，只有先到者能结算
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    window.postMessage({ __ns: NS, dir: 'main->bridge', id, op, ...payload }, '*');
  });
}

/**
 * 挂状态镜像监听（boot 装配期调用一次；重复调用幂等）。
 * @returns {void}
 */
export function installUpdateMirror() {
  if (installed) return;
  installed = true;
  window.addEventListener('message', onMessage);
  // 后台 serveBundle 前已经 publish 过一次，但那时本 world 的监听还没挂上（远程体正在被 exec）——
  // 故这里主动补要一次快照，欢迎页页脚那句才有得说。不等回执，启动链绝不因它而停。
  fetchSnapshot();
}

/** @returns {object|null} 最近一次已知快照（还没通过话为 null） */
export function updateSnapshot() {
  return last;
}

/**
 * 主动向后台要一次快照（面板首绘与操作后对齐用）。失败只留一行 debug，不打扰玩家。
 * @returns {Promise<object|null>} 新快照，失败回上一份已知值
 */
export function fetchSnapshot() {
  return ask('update-cmd', { cmd: 'state' })
    .then((s) => apply(s))
    .catch((e) => {
      log.debug('snapshot fetch failed: %s', String((e && e.message) || e));
      return last;
    });
}

/**
 * 发一条升级命令并取回新快照。失败时把原因记 warn 并回 null，由调用方决定要不要提示。
 * @param {string} cmd 命令名（refresh|clear|lock|unlock|dismiss|auto）
 * @param {object} [args] 参数
 * @returns {Promise<object|null>}
 */
export function updateCmd(cmd, args) {
  return ask('update-cmd', { cmd, ...args })
    .then((s) => apply(s))
    .catch((e) => {
      log.warn('update cmd %s failed: %s', cmd, String((e && e.message) || e));
      return null;
    });
}

/**
 * 本次页面的运行来源：壳 exec 前挂下的交接信息（后台快照里没有这一维——它知道「本地最优」，
 * 只有壳知道「这一页究竟跑了哪份、是不是降级跑的基线」）。
 * @returns {{ver:string, from:string, degraded:boolean, shellVer:string}}
 */
export function runSource() {
  const s = window.__pccShell__ || {};
  return {
    ver: String(s.ver || ''),
    from: String(s.from || 'unknown'),
    degraded: !!s.degraded,
    shellVer: String(s.shellVer || ''),
  };
}
