/**
 * 定时刷新（服务器日界/周界刷新网页，系统设置，单链）
 *
 * 两档勾选共用一条 createCycle：
 *   daily  到 gameData.nextDailyResetTs()（游戏 DateUtils 归日式，UTC+8 0 点）后等待 1 分钟结算缓冲；
 *   weekly 到 gameData.nextWeeklyResetTs()（服务器本地周一 0 点）后等待 1 分钟结算缓冲。
 *   两档都到点时只调用一次 location.reload()（周一 0 点天然同刻，不再需要两条 cycle 互让）；
 *   新页面由既有 boot/installAutoLogin 重放游戏缓存的 serverToken 并重新进入游戏，
 *   无需调用游戏 UI 或私有登录接口。
 *
 * 调度：createCycle 单飞，长睡每 2 小时截断重读服务器钟（防本地墙钟/后台节流漂移）；
 *   两档各自锚定唤醒前的界（next* 过界后会返回下一周期，不锚定就永远等不到刷新）；
 *   到点只刷新一次，时钟不可用或两档全关时退 15 分钟巡检。
 *   pause 后 alive=false，不再重排，也不会在到点后继续刷新。
 */
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('SCHEDULED-REFRESH');
/** @type {number} 服务器日切/周切结算缓冲（毫秒） */
const ROLL_BUFFER_MS = 1000 * 60;
/** @type {number} 长睡截断（毫秒）：重读服务器钟，防后台定时器漂移 */
const WAIT_CAP_MS = 1000 * 60 * 60 * 2;
/** @type {number} 时钟不可用/两档全关时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {{enabled:boolean, daily:boolean, weekly:boolean}} 运行时配置（configure 灌入） */
var MCFG = { enabled: false, daily: true, weekly: true };
/** @type {number} 本轮已锚定的服务器日界；到点刷新后前移到下一日界，防同拍重复 */
var targetDailyTs = 0;
/** @type {number} 本轮已锚定的服务器周界；到点刷新后前移，防同拍重复 */
var targetWeeklyTs = 0;
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
 * 算一档的到期时刻：next* 是「下一个界」，锚定后加结算缓冲。
 * @param {number} next 下一个界（服务器秒，0=时钟不可用）
 * @param {number} anchor 本轮已锚定的界（服务器秒）
 * @returns {{anchor:number, due:number}} 更新后的锚点与到期时刻（due=0 表示本档不参与排程）
 */
function dueOf(next, anchor) {
  if (!next) return { anchor: 0, due: 0 };
  // next* 过界后会返回「下一周期」，必须保留唤醒前锚定的 target，
  // 否则 00:01 醒来时会把 delay 重算成约 24h/7d，永远不执行刷新。
  if (!anchor || anchor > next) anchor = next;
  return { anchor: anchor, due: anchor + ROLL_BUFFER_MS / 1000 };
}

/**
 * cycle 单轮：取已勾选档位里最近的界，到点刷新一次。
 * @returns {number} 下次唤醒毫秒
 */
function cycleRun() {
  var now = gameData.serverTime();
  if (!now) {
    log.debug('scheduled-refresh idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  var day = { anchor: 0, due: 0 };
  var week = { anchor: 0, due: 0 };
  if (MCFG.daily) {
    day = dueOf(gameData.nextDailyResetTs(), targetDailyTs);
    targetDailyTs = day.anchor;
  }
  if (MCFG.weekly) {
    week = dueOf(gameData.nextWeeklyResetTs(), targetWeeklyTs);
    targetWeeklyTs = week.anchor;
  }
  var dueTs = day.due && week.due ? Math.min(day.due, week.due) : day.due || week.due;
  if (!dueTs) {
    log.debug('scheduled-refresh idle: no schedule enabled or clock unavailable.');
    return IDLE_TICK_MS;
  }
  if (now < dueTs) return Math.min((dueTs - now) * 1000, WAIT_CAP_MS);
  if (!aliveFn()) {
    log.debug('scheduled-refresh skipped: feature paused at dueTs=%d.', dueTs);
    return 0;
  }
  // 到点：逐档前移到下一周期，同一拍只刷新一次（周一两档同刻到期亦如此）。
  var hit = [];
  if (day.due && now >= day.due) {
    hit.push('daily');
    targetDailyTs = gameData.nextDailyResetTs() || 0;
  }
  if (week.due && now >= week.due) {
    hit.push('weekly');
    targetWeeklyTs = gameData.nextWeeklyResetTs() || 0;
  }
  log.info('server %s reset reached, reload page and resume auto-login.', hit.join('+'));
  reloadPage();
  return IDLE_TICK_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 配置灌入（reactor → 本模块）：勾选档位翻动时重新锚定并重排。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (!partial) return MCFG;
  var prev = MCFG;
  MCFG = partial;
  // 档位翻转后清掉旧锚点：刚勾上的档从下一个界重新算，不把「过界后的下一周期」误当成本次要刷新的界。
  if (!!prev.daily !== !!MCFG.daily) targetDailyTs = 0;
  if (!!prev.weekly !== !!MCFG.weekly) targetWeeklyTs = 0;
  // 关闭流程不走这里重排：setConfig 先 configure 后 pause，此时 kick 可能在 pause 前抢跑一轮。
  if (MCFG.enabled && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 启动并立即排下一次刷新。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  targetDailyTs = 0;
  targetWeeklyTs = 0;
  log.info('started.');
  cycle.kick();
}

/**
 * 面板 cfg → 运行时归一化：两档缺省均视为勾选（旧存档/首次启用直接全开）。
 * @param {object} c 面板合并后配置
 * @returns {{enabled:boolean, daily:boolean, weekly:boolean}}
 */
function normalizeCfg(c) {
  return {
    enabled: !!(c && c.enabled),
    daily: !(c && c.daily === false),
    weekly: !(c && c.weekly === false),
  };
}

reactor.register({
  id: 'scheduledRefresh',
  label: '定时刷新',
  storageKey: 'pocketcc.feat.scheduledRefresh',
  symbols: ['dataCenter'],
  // 只依赖服务器钟，不限定 homeland：秘境/战斗等场景到点也应执行用户要求的整页刷新。
  offInCombat: false,
  defaults: { enabled: false, daily: true, weekly: true },
  fields: [
    { key: 'daily', type: 'checkbox', label: '每日零点刷新' },
    { key: 'weekly', type: 'checkbox', label: '每周一刷新' },
  ],
  toModuleCfg: normalizeCfg,
  configure: configure,
  run: run,
});

export { cycleRun };
/** 单测专用：复位刷新记忆并替换刷新动作/存活判定/档位开关。 */
export function resetForTest(reload, alive, cfg) {
  ctxRef = alive ? { alive: alive } : null;
  targetDailyTs = 0;
  targetWeeklyTs = 0;
  reloadPage = reload || function () {};
  MCFG = normalizeCfg(Object.assign({ enabled: true }, cfg || {}));
}
