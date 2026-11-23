// 玩家 UID 侦测与切换：配置按 UID 隔离的源头。
// 轮询（1s，O(1) 读字段，与 session.js 活性监视同风格）侦测 UserData.UID：
//   空 → 非空（登录完成）：给 storage 设 'pocketcc[通道后缀].u{uid}.' 前缀（根段由 core/constants.js 按发布通道派生，
//     正式无后缀）→ 广播 player.ready（启动编排据此加载配置）；
//   a → b（不刷新型换号）：低频动作，直接整页 reload 重建——浏览器原子清空全部模块级状态与副作用
//     （setInterval/监听/各 feat 的 installed/blacklist/queue 等），比 in-place 软重启可靠且零侵入 feat。
//     恢复靠 auto-login 缓存 token 自动重登 + 本模块 waitUid → migrate → load → startFeatures 全链路，无需人工。
// waitUid：启动编排用——UID 就绪才加载配置；超时 resolve(null) 降级（registry 检测 ns
//   未设时跳过存储读写、直接用默认配置，保证自动重连在登录卡死时仍可用）。
import { createLog } from './log.js';
import { game } from './game.js';
import { bus, EVT } from './bus.js';
import { setNamespace, getNamespace } from './storage.js';
import { STORAGE_ROOT } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=PLAYER） */
const log = createLog('PLAYER');

/** @type {string|null} 当前 UID（未登录/未知为 null） */
let currentUid = null;
/** @type {boolean} UID 轮询是否已启动 */
let watching = false;

/** 当前 UID（未登录/未知时为 null）。功能侧优先用它，避免等 player.ready 事件。 */
export function getUid() {
  return currentUid;
}

/**
 * 从游戏内存读 UID（DataCenter.DATA.UserData.UID）
 * @returns {string|null}
 */
function readGameUid() {
  const dc = game.get('DataCenter');
  const u = dc && dc.DATA && dc.DATA.UserData;
  const uid = u && u.UID;
  return uid ? String(uid) : null;
}

/** @type {boolean} 刷新守卫：一次换号只导航一次 */
let reloadScheduled = false;

/**
 * 换号即整页刷新：先落盘（默认异步写）再 reload。
 * @param {string} from 旧 UID
 * @param {string} to 新 UID
 */
function scheduleSwitchReload(from, to) {
  if (reloadScheduled) return;
  reloadScheduled = true;
  log.info('player switched: %s -> %s, reloading page to rebuild all state', from, to);
  setTimeout(() => window.location.reload(), 500);
}

/**
 * 应用新 UID：设存储前缀；首次就绪广播 player.ready，已有旧值则整页 reload 重建。
 * @param {string} uid 新 UID
 */
function apply(uid) {
  if (uid === currentUid) return;
  const prevUid = currentUid;
  currentUid = uid;
  setNamespace(`${STORAGE_ROOT}.u${uid}.`);
  if (prevUid) {
    scheduleSwitchReload(prevUid, uid);
  } else {
    log.info('player ready: uid=%s', uid);
    bus.emit(EVT.PLAYER_READY, { uid: uid });
  }
}

/** 开始轮询侦测 UID。幂等。 */
export function startPlayerWatch() {
  if (watching) return;
  watching = true;
  setInterval(() => {
    const uid = readGameUid();
    if (uid) apply(uid);
  }, 1000);
}

/**
 * 等 UID 就绪（内部顺带确保轮询已启动）。
 * @param {number} timeoutMs 超时即 resolve(null)，调用方走默认配置降级。
 * @returns {Promise<string|null>}
 */
export function waitUid(timeoutMs = 20000) {
  startPlayerWatch();
  if (currentUid) return Promise.resolve(currentUid);
  return new Promise((resolve) => {
    let done = false;
    const finish = (uid) => {
      if (done) return;
      done = true;
      off();
      resolve(uid);
    };
    const off = bus.on(EVT.PLAYER_READY, (e) => finish(e.uid));
    setTimeout(() => finish(null), timeoutMs);
  });
}

/** 存储层是否已按 UID 设前缀（registry 读写配置的前置条件）。 */
export function hasNamespace() {
  return !!getNamespace();
}
