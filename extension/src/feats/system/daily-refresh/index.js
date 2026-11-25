/**
 * 每日零点刷新（服务器日界刷新网页，系统设置，单链）
 *
 * 到 gameData.nextDailyResetTs()（游戏 DateUtils 归日式，UTC+8 0 点）后等待 1 分钟结算缓冲，
 *   调用 location.reload() 刷新当前 H5 页面。既有 boot/installAutoLogin 会在新页面重放游戏缓存的
 *   serverToken 并重新进入游戏，无需调用游戏 UI 或私有登录接口。
 *
 * 调度：createCycle 单飞，长睡每 2 小时截断重读服务器钟（防本地墙钟/后台节流漂移）；到点只刷新一次，
 *   时钟不可用退 15 分钟巡检。pause 后 alive=false，不再重排，也不会在到点后继续刷新。
 */
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('DAILY-REFRESH');
/** @type {number} 服务器日切结算缓冲（毫秒） */
const DAY_ROLL_BUFFER_MS = 1000 * 60;
/** @type {number} 长睡截断（毫秒）：重读服务器钟，防后台定时器漂移 */
const WAIT_CAP_MS = 1000 * 60 * 60 * 2;
/** @type {number} 时钟不可用巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 本轮已锚定的服务器日界；到点刷新后前移到下一日界，防同拍重复 */
var targetResetTs = 0;
/** @type {function():void} 实际刷新函数（单测可替换） */
var reloadPage = function () {
  window.location.reload();
};

/**
 * @returns {boolean} 当前 reactor 功能是否仍存活
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * cycle 单轮：按服务器日界排程，到点刷新一次。
 * @returns {number} 下次唤醒毫秒
 */
function cycleRun() {
  var now = gameData.serverTime();
  var next = gameData.nextDailyResetTs();
  if (!now || !next) {
    log.debug('daily-refresh idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  // nextDailyResetTs 过界后会返回“次日”，因此必须保留唤醒前锚定的 target，
  // 否则 00:01 醒来时会把 delay 重算成约 24h，永远不执行刷新。
  if (!targetResetTs || targetResetTs > next) targetResetTs = next;
  var dueTs = targetResetTs + DAY_ROLL_BUFFER_MS / 1000;
  if (now < dueTs) return Math.min((dueTs - now) * 1000, WAIT_CAP_MS);
  if (!aliveFn()) {
    log.debug('daily-refresh skipped: feature paused at dueTs=%d.', dueTs);
    return 0;
  }
  targetResetTs = next;
  log.info('server midnight reached, reload page and resume auto-login.');
  reloadPage();
  return IDLE_TICK_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 启动并立即排下一日界。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  targetResetTs = 0;
  log.info('started.');
  cycle.kick();
}

reactor.register({
  id: 'dailyRefresh',
  label: '每日零点刷新',
  storageKey: 'pocketcc.feat.dailyRefresh',
  symbols: ['dataCenter'],
  // 只依赖服务器钟，不限定 homeland：秘境/战斗等场景到点也应执行用户要求的整页刷新。
  offInCombat: false,
  defaults: { enabled: false },
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  run: run,
});

export { cycleRun };
/** 单测专用：复位刷新记忆并替换刷新动作/存活判定。 */
export function resetForTest(reload, alive) {
  ctxRef = alive ? { alive: alive } : null;
  targetResetTs = 0;
  reloadPage = reload || function () {};
}
