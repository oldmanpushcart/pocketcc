// 会话健康与恢复：自动重连（hook NetMgr 断线/连接入口 → 卡死则延迟刷新页面）、
// 活性监视（轮询 O(1) 字段覆盖静默断线）、登录成功信号，并把健康态翻转广播成 session.* 事件。
//
// 目前 session.* 仅供观察（日志 / 控制台），未接 reactor 门控——功能不因断线暂停，行为与重构前一致。
// 依据目标源码 NetMgr.js：showPanel(1/2/3) 是「通讯中断」弹窗唯一出口(1=onError 2=onTimeOut 3=onClose)；
// setWaitStatus 标记连接中；onConnect 为连接成功。纯事件驱动，无 UI 遍历。配置实时读 configs.reconnect。
import { createLog } from './log.js';
import { game } from './game.js';
import { bus } from './bus.js';
import { configs } from './registry.js';
import { worldSignals } from './game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=NET，与网络层共用一个面） */
const logNet = createLog('NET');

// ─────────────────────────── 会话健康态（广播用，带翻转去重防刷） ───────────────────────────
/** @type {boolean} 当前会话是否健康 */
let healthy = false;

/**
 * 置健康并广播 session.healthy（已健康则去重）
 * @param {string} reason 变健康的缘由（日志与事件载荷）
 */
function setHealthy(reason) {
  if (healthy) return;
  healthy = true;
  logNet.info('session healthy: %s', reason);
  bus.emit('session.healthy', { reason: reason });
}

/**
 * 置不健康并广播 session.unhealthy（已不健康则去重）
 * @param {string} reason 卡死缘由
 */
function setUnhealthy(reason) {
  if (!healthy) return;
  healthy = false;
  logNet.warn('session unhealthy: %s', reason);
  bus.emit('session.unhealthy', { reason: reason });
}

// ─────────────────────────── 自动重连：刷新限流 ───────────────────────────
/** @type {string} sessionStorage 里的刷新时刻列表键 */
const RELOAD_LOG_KEY = 'pocketcc.reloadLog';
/** @type {number} 限流窗口（5 分钟内） */
const RELOAD_WINDOW_MS = 5 * 60 * 1000;
/** @type {number} 窗口内最多刷新次数 */
const RELOAD_MAX = 3;

/**
 * 读窗口内的刷新时刻列表（已过期项过滤掉）
 * @returns {number[]} 时间戳数组
 */
function readReloadLog() {
  const now = Date.now();
  let records;
  try {
    records = JSON.parse(sessionStorage.getItem(RELOAD_LOG_KEY) || '[]');
  } catch (e) {
    records = [];
  }
  return records.filter((t) => now - t < RELOAD_WINDOW_MS);
}

/**
 * 当前是否还允许再刷新一次（限流闸门）
 * @returns {boolean}
 */
function allowReload() {
  return readReloadLog().length < RELOAD_MAX;
}

/** 记一笔本次刷新时刻 */
function pushReloadLog() {
  const records = readReloadLog();
  records.push(Date.now());
  sessionStorage.setItem(RELOAD_LOG_KEY, JSON.stringify(records));
}

/** 清空刷新计数（会话确认健康后调用，避免旧记录卡住下次自愈） */
function resetReloadLog() {
  sessionStorage.removeItem(RELOAD_LOG_KEY);
}

/** @type {number|null} 延迟刷新定时器 */
let reloadTimer = null;
/** @type {number|null} 连接超时定时器 */
let connectTimer = null;
/** @type {number} 开始重连的时刻；0=非连接中 */
let connectingSince = 0;

/** 取消已排队的延迟刷新 */
function cancelReload() {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

/**
 * 发现卡死：先广播 unhealthy，再按重连配置与限流决定是否排一次页面刷新。
 * @param {string} reason 卡死缘由（日志）
 * @param {boolean} [immediate] 是否立即刷新（跳过 intervalSec 等待）
 */
function scheduleReload(reason, immediate) {
  // 健康态独立于「是否启用自动刷新」：即便重连关着，检测到卡死也广播 unhealthy
  setUnhealthy(reason);
  const rc = configs.reconnect;
  if (!rc.enabled) return;
  if (reloadTimer) return;
  if (!allowReload()) {
    logNet.info(
      'reload limit reached within window, auto-reconnect halted, manual action required',
    );
    return;
  }
  const delay = immediate ? 0 : rc.intervalSec * 1000;
  logNet.info(`stuck detected: ${reason}, reloading in ${(delay / 1000).toFixed(0)}s`);
  reloadTimer = setTimeout(() => {
    pushReloadLog();
    logNet.info(`auto-reconnect: reloading page (${reason})`);
    window.location.reload();
  }, delay);
}

/** 解除连接超时定时器 */
function disarmConnectTimeout() {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
}

/** 挂连接超时定时器：到点仍在连接中即判卡死 */
function armConnectTimeout() {
  if (connectTimer) return;
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (connectingSince) scheduleReload('connect-timeout', true);
  }, configs.reconnect.connectTimeoutSec * 1000);
}
/** 标记进入重连中（并挂连接超时） */
function markConnecting() {
  if (!connectingSince) connectingSince = Date.now();
  armConnectTimeout();
}

/** 标记连接成功：清计时、撤刷新、置健康 */
function markConnected() {
  connectingSince = 0;
  disarmConnectTimeout();
  cancelReload();
  setHealthy('connected');
}

/**
 * hook NetMgr 的断线/连接入口（showPanel / setWaitStatus / onConnect），驱动上面的状态机。
 * 由 boot.js 在配置就绪后调用一次。
 */
export function installReconnectHooks() {
  const net = game.get('NetMgr').NET;

  const origShowPanel = net.showPanel;
  net.showPanel = function (code) {
    scheduleReload(`disconnect-dialog(${code})`);
    return origShowPanel.apply(this, arguments);
  };

  const origSetWaitStatus = net.setWaitStatus;
  net.setWaitStatus = function (wait) {
    if (wait) markConnecting();
    else markConnected();
    return origSetWaitStatus.apply(this, arguments);
  };

  const origOnConnect = net.onConnect;
  net.onConnect = function () {
    markConnected();
    resetReloadLog();
    return origOnConnect.apply(this, arguments);
  };
}

// ─────────────────────────── 活性监视：覆盖静默断线 ───────────────────────────
//   如「账号重复登录」场景客户端走 NetMgr.close()→Socket.close()，只把 _states 置 CLOSED(2)，
//   不触发 onClose/onError/showPanel/setWaitStatus 任何回调（见 Socket.js:304），故只能轮询 O(1) 字段：
//   信号1 states !== SocketStates.CONNECTED(1)；信号2 lastReceiveTime 停滞超过阈值（服务器不再回包，含心跳）。
/** @type {number} 断线持续起始时刻；0=正常 */
let stuckSince = 0;
/** @type {boolean} 活性监视是否已启动（setInterval 只挂一次） */
let livenessStarted = false;

/**
 * 启动活性监视轮询（2 秒一次，O(1) 读字段）：
 * 覆盖「静默断线」——客户端走 NetMgr.close() 不触发任何回调，只能靠 states 与 lastReceiveTime 两信号判定。
 */
function startLivenessWatch() {
  const net = game.get('NetMgr').NET;
  const CONNECTED = game.get('SocketCore').SocketStates.CONNECTED;
  setInterval(() => {
    const rc = configs.reconnect;
    if (!rc.enabled) return;
    const disconnected = net.states !== CONNECTED;
    const trafficStale = Date.now() - net.lastReceiveTime > rc.connectTimeoutSec * 1000;
    if (disconnected || trafficStale) {
      if (!stuckSince) stuckSince = Date.now();
      else if (Date.now() - stuckSince > rc.connectTimeoutSec * 1000) {
        scheduleReload(
          disconnected ? `socket-not-connected(states=${net.states})` : 'no-server-traffic',
          true,
        );
      }
    } else {
      stuckSince = 0;
      cancelReload();
      // 流量恢复（含 trafficStale 这种 states 仍 CONNECTED、不会再触发 onConnect 的情形）→ 回健康
      setHealthy('traffic-resumed');
    }
  }, 2000);
}

// ─────────────────────────── 启动/登录看门狗：覆盖「登录前维护卡死」 ───────────────────────────
//   服务器更新维护时客户端停在 Launch/Login 场景弹「版本公告 / 服务器维护」面板，登录流程走不到头：
//   既不调 NetMgr.showPanel（那是连接建立后的断线弹窗），又因收不到 LOGIN_SUCCESS 而永不启动活性监视，
//   上面两套自愈全部失效。这里补一条独立通道：订阅 scene.change，若长时间停在 boot 语义场景
//   （Launch/Login）且始终没等到 LOGIN_SUCCESS，就直接刷新页面重试，直到真正确认登录成功。
//   与断线重连不同：本通道刻意绕开 5 分钟 3 次的限流窗口（维护常达 10-15 分钟，走限流会中途彻底闸死），
//   每次刷新后页面重启、宽限期重新计时，天然形成「每 LAUNCH_GRACE_MS 重试一次」的节奏。
/** @type {number} boot 场景宽限期：进入 Launch/Login 后超过此时长仍未登录，判为维护卡死并刷新（毫秒） */
const LAUNCH_GRACE_MS = 90 * 1000;
/** @type {number} 看门狗轮询节奏（毫秒）：仅用于到点判定，实际刷新节奏由宽限期决定 */
const WATCHDOG_POLL_MS = 5 * 1000;

/** @type {boolean} 是否已收到 LOGIN_SUCCESS（收到即永久解除看门狗） */
let loginConfirmed = false;
/** @type {number} 进入 boot 场景（未登录）的起始时刻；0=当前不在 boot 卡死态 */
let bootSince = 0;
/** @type {number|null} 看门狗轮询定时器 */
let watchdogTimer = null;

/** 解除并停用启动看门狗（登录确认后调用） */
function disarmLaunchWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  bootSince = 0;
}

/**
 * 安装启动/登录看门狗：boot.js 在配置就绪后随 installReconnectHooks 一起调用一次。
 * 幂等：已装或登录已确认则直接返回。
 */
export function installLaunchWatchdog() {
  if (watchdogTimer || loginConfirmed) return;
  // 订阅场景切换：进入 boot（Launch/Login）起表，离开 boot 归零（scene-watcher 只在真改名时才广播，不会自我重置宽限期）
  bus.on('scene.change', ({ name }) => {
    if (loginConfirmed) return;
    const inBoot = worldSignals.sceneSemantic() === 'boot';
    bootSince = inBoot ? Date.now() : 0;
    if (inBoot) logNet.debug('launch watchdog: entered boot scene %s', name);
  });
  // 兜底自检：安装时可能已身处 boot 且错过初次 scene.change（scene-watcher 早于本 hook 广播过）
  if (worldSignals.sceneSemantic() === 'boot') bootSince = bootSince || Date.now();
  watchdogTimer = setInterval(() => {
    const rc = configs.reconnect;
    if (!rc || !rc.enabled) return; // 自动重连总开关关着 → 看门狗也不动作
    if (loginConfirmed) {
      disarmLaunchWatchdog();
      return;
    }
    if (!bootSince) return;
    // 仍停在 boot 场景才算数（scene.change 漏推时以现场语义复核，离开则归零）
    if (worldSignals.sceneSemantic() !== 'boot') {
      bootSince = 0;
      return;
    }
    if (Date.now() - bootSince < LAUNCH_GRACE_MS) return;
    logNet.info('launch watchdog: pre-login maintenance stall in boot scene, reloading to retry');
    bootSince = Date.now(); // 复位计时（刷新后本上下文即销毁，此行仅防御同页重复刷新）
    window.location.reload();
  }, WATCHDOG_POLL_MS);
}

// ─────────────────────────── 登录成功信号 ───────────────────────────
//   仅用于「会话健康」——清零重连计数 + 广播 healthy + 启动活性监视。
//   功能启动不挂这里（见 boot.js watchHomeMapReady）：LOGIN_SUCCESS 只代表 net 登录态就绪，主城场景可能仍在加载。
/**
 * 监听登录成功（FWSMvc LOGIN_SUCCESS）：清零重连计数、广播健康、首次启动活性监视。
 * 功能启动不挂这里（见 boot.js watchHomeMapReady）。
 */
export function watchLoginSuccess() {
  const FWSMvc = game.get('FWSMvc');
  const conn = new FWSMvc.FMessageConnectionAbstract();
  conn.onFMessage_LOGIN_SUCCESS = () => {
    logNet.info('LOGIN_SUCCESS captured');
    resetReloadLog(); // 会话恢复健康，清零重连计数
    setHealthy('login-success');
    // 登录真正确认：永久解除启动/登录看门狗（维护卡死自愈到此为止，之后交断线重连/活性监视接管）
    loginConfirmed = true;
    disarmLaunchWatchdog();
    if (!livenessStarted) {
      livenessStarted = true;
      startLivenessWatch();
    }
  };
  conn.connect();
}
