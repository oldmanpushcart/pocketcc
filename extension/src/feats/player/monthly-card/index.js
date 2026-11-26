/**
 * 至尊月卡（新版计时月卡 cardId=5003，reactor 说明书形态，玩家基础设置，单开关双链）
 *
 * 合并口径：同一张至尊月卡承载两类每日收益，面板只出一个「至尊月卡」开关，内部两条子链并行：
 *   ① daily gift  —— 750 GET_TIMECARD_REWARD 领取当日免费礼包（见 gift.js）；
 *   ② ad x2       —— 9706 读权威进度 + 9708 一次全领广告特权 x2（见 ad-rewards.js）。
 *   两条子链共用 cardId=5003 的有效期判据，各自维护服务器日界日戳与择时；本文件只做注册、
 *   网络底座安装、启动 kick 与面板合并状态行，不承载任何协议动作。
 *
 * 面板状态行：两子链各自把状态压成短值，这里拼成「礼包 1/1 · 广告 3/6」；两边都未生效时只显示
 *   「未生效」，避免同一张卡重复报两次。广告进度未读回前显示「—」（不谎报 0）。
 *
 * 调度：两个 createCycle 单飞、互不阻塞（礼包按 nextRewardTime/日界睡，广告按槽位 cd/日界睡），
 *   run() 同时 kick 两条链；pause 后 ctx.alive()=false，两条链睡醒即自然停摆，resume 走 run() 重 kick。
 */
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';

import * as gift from './gift.js';
import * as ad from './ad-rewards.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('MONTHLY-CARD');

/**
 * 合并状态行：礼包短值 + 广告短值；都未生效时收敛为单个「未生效」。
 * @returns {string}
 */
function statusText() {
  var g = gift.statusText();
  var a = ad.statusText();
  if (g === '未生效' && a === '未生效') return '未生效';
  return '礼包 ' + g + ' · 广告 ' + a;
}

/**
 * 安装：网络底座只装一次，随后把上下文交给两条子链（子链 attach 不重复 install）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  var net = ctx.net;
  if (!net || !net.install()) {
    log.warn('install failed: pocketcc.net unavailable');
    return false;
  }
  gift.attach(ctx);
  ad.attach(ctx);
  log.info('installed.');
  return true;
}

/**
 * 启动：两条子链各自复位内存态、回读日戳并立即判断一次。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  gift.start(ctx);
  ad.start(ctx);
}

reactor.register({
  id: 'monthlyCard',
  label: '至尊月卡',
  storageKey: 'pocketcc.feat.monthlyCard',
  symbols: ['dataCenter', 'tableManager', 'tableName'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_monthlyInfo',
      type: 'text',
      label: '今日',
      get: function () {
        return statusText();
      },
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
});

/** @type {function():Promise<number>} 单测专用：礼包子链单轮。 */
export const giftCycleRun = gift.cycleRun;
/** @type {function():Promise<number>} 单测专用：广告特权子链单轮。 */
export const adCycleRun = ad.cycleRun;
export { install as installForTest };
/** 单测专用：复位两条子链内存态，不启动 cycle。 */
export function resetForTest() {
  gift.resetForTest();
  ad.resetForTest();
}
/** 单测专用：同时发起两条子链的日戳回读，等价 run() 的首拍保护。 */
export function loadStampForTest() {
  return Promise.all([gift.loadStampForTest(), ad.loadStampForTest()]);
}
