/**
 * 每周一刷新（服务器周界刷新网页，系统设置，单链）
 *
 * 到 gameData.nextWeeklyResetTs()（服务器本地周一 0 点，UTC+8）后等待 1 分钟结算缓冲，
 *   调用 location.reload()。新页面由既有 boot/installAutoLogin 重放缓存凭据并重新进入游戏。
 *   套装金币等周常玩法的领取功能可在刷新后的新页面继续执行；本功能不代开商城、不购买。
 *   周一同时开启每日零点刷新时自动让位，避免两个 cycle 竞争触发同一次整页导航。
 *
 * 调度与每日刷新同口径：createCycle 单飞，长睡每 2 小时截断重读服务器钟；到点只刷新一次。
 *   跨周界时先保留唤醒前锚定的 target，避免 00:01 醒来把目标误算成下一周而永不刷新。
 */
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('WEEKLY-REFRESH');
/** @type {number} 周切结算缓冲（毫秒） */
const WEEK_ROLL_BUFFER_MS = 1000 * 60;
/** @type {number} 长睡截断（毫秒）：重读服务器钟，防后台定时器漂移 */
const WAIT_CAP_MS = 1000 * 60 * 60 * 2;
/** @type {number} 时钟不可用巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 本轮已锚定的服务器周界；到点刷新后前移，防同拍重复 */
var targetResetTs = 0;
/** @type {function():void} 实际刷新函数（单测可替换） */
var reloadPage = function () {
  window.location.reload();
};

/** @returns {boolean} 当前 reactor 功能是否仍存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * cycle 单轮：按服务器周界排程，到点刷新一次。
 * @returns {number} 下次唤醒毫秒
 */
function cycleRun() {
  var now = gameData.serverTime();
  var next = gameData.nextWeeklyResetTs();
  if (!now || !next) {
    log.debug('weekly-refresh idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  // nextWeeklyResetTs 过界后返回“下周一”，必须保留唤醒前锚定的 target。
  if (!targetResetTs || targetResetTs > next) targetResetTs = next;
  var dueTs = targetResetTs + WEEK_ROLL_BUFFER_MS / 1000;
  if (now < dueTs) return Math.min((dueTs - now) * 1000, WAIT_CAP_MS);
  if (!aliveFn()) {
    log.debug('weekly-refresh skipped: feature paused at dueTs=%d.', dueTs);
    return 0;
  }
  targetResetTs = next;
  // 周一同时撞上每日零点刷新时让位，避免两个 cycle 竞争触发同一次整页导航。
  if (reactor.isRunning('dailyRefresh')) {
    log.debug('weekly-refresh skipped at dueTs=%d: daily-refresh is running.', dueTs);
    return IDLE_TICK_MS;
  }
  log.info('server Monday reset reached, reload page and resume auto-login.');
  reloadPage();
  return IDLE_TICK_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/** 启动并立即排下一周界。@param {object} ctx reactor 上下文 */
function run(ctx) {
  ctxRef = ctx;
  targetResetTs = 0;
  log.info('started.');
  cycle.kick();
}

reactor.register({
  id: 'weeklyRefresh',
  label: '每周一刷新',
  storageKey: 'pocketcc.feat.weeklyRefresh',
  symbols: ['dataCenter'],
  // 周界刷新不限定 homeland；秘境/战斗等场景同样需要整页刷新。
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
