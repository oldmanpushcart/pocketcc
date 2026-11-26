/**
 * 军级宝箱（当前军级每日免费礼包，默认关闭，单链，只发免费领取协议）。
 *
 * 协议（游戏客户端源码 + 实录双证）：
 *   RequestId.GET_VIP_DAY_REWARD=2002，V1 NET.send，空载荷 {}；
 *   应答 d 为 JSON 串，含 freeFlag 与 reward，游戏回调 JSON_PARSE(resp.d)。
 *   UserData.VipRewardCdTime-ServerTime<=0 时可领；20011 推送更新免费礼包状态。
 *   军级面板 vipUpItem 的宝箱按钮按 _realLevel||1 / _curSelectedLevel||1 归一，
 *   VIP0 同样可领（展示 1 级奖励），故本 feat 不以军级 0 作为跳过判据。
 *   本功能不调用 chargeClick/shopChargeClick，不购买、不升级、不模拟切换军级。
 *
 * 报文实证 dashcam-rec-20261127T005909-军级宝箱领取.ndjson：
 *   req:send 2002 {} → resp d={reward:{items:[{itemId,itemCount}…]},freeFlag:<下一日界>}，
 *   同批 10401 PUSH_TOOL / 10001 PUSH_RESOURCE / 10031 PUSH_REWARD 到账。
 *
 * 防重领：直发 2002 不执行游戏 UI 回调，成功应答按服务器 freeFlag 锚定冷却（缺失才退
 * 下一日界）；只有明确 freeFlag 或非空 reward 的成功应答才落 claimed 日戳。空应答不谎报
 * 成功，CODE_NOT_SENT 短重试；跨午夜旧回执不落旧日戳，暂停不吞已发回执。
 *
 * 日界静置（实证 dashcam-log-20261127）：服务器 2002 判据是 ServerTime > VipRewardCdTime
 * （严格大于、秒粒度），客户端 serverTime 也是整秒，于是 0 点整同一秒内 VipRewardCdTime -
 * ServerTime <= 0 在客户端已成立、服务器却仍判不成立。本 feat 在 00:00:00.592 发车被
 * code=3 拒（用户 00:59 手工领取成功），故睡到冷却锚点后再静置 RESET_SETTLE_MS 才发车。
 * 业务拒绝不再一次即整日抑制：先按 REJECT_RETRY_MS 阶梯重试（日界附近被拒多为服务器
 * 秒数尚未越过锚点），阶梯耗尽才落 claimed=false 日戳抑制到下一日界。
 */
import { CODE_NOT_SENT, parseData, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { dailyText } from '../../../core/daily-stats.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';
import { CMD_VIP_DAY_REWARD, PUSH_VIP_FREE_REWARD_UPDATE } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('VIP-DAILY-GIFT');
/** @type {number} 状态未就绪/业务拒绝后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 未发出/空成功应答的短重试间隔（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/**
 * @type {number} 冷却锚点/日界后的静置毫秒：服务器判据 ServerTime > VipRewardCdTime 是严格
 * 大于且秒粒度，锚点同一秒内发车必被 code=3 拒（实证 2026-11-27 00:00:00.592 level=13
 * code=3，同日 00:59 手工领取成功）。静置 10 秒同时覆盖客户端 ServerTime 的少量漂移。
 */
const RESET_SETTLE_MS = 1000 * 10;
/** @type {number[]} 业务拒绝后的重试阶梯（毫秒）；耗尽才按当日已解决抑制 */
const REJECT_RETRY_MS = [1000 * 60, 1000 * 60 * 5, 1000 * 60 * 15, 1000 * 60 * 30];
/** @type {number} 一天秒数（与 gameData.nextDailyResetTs 的日界口径一致） */
const DAY_SEC = 86400;
/** @type {string} UID 隔离运行数据中的当日已解决日戳键 */
const STAMP_KEY = 'vipDailyGift.resolved';

/** @type {object|null} pocketcc.net 网络底座 */
var net = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 今日已解决对应的下一服务器日界 */
var resolvedResetTs = 0;
/** @type {boolean} 今日是否明确领成 */
var claimedToday = false;
/** @type {number} 本日业务拒绝已重试次数 */
var rejectTries = 0;
/** @type {number} rejectTries 所属的游戏日起点（换日归零） */
var rejectDayStart = 0;
/** @type {Promise<void>|null} 首拍等待的日戳回读 */
var stampLoad = null;

/** @returns {boolean} 当前激活代次是否存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 旧激活代次在 pause/resume 后不得继续写状态。
 * @param {AbortSignal|null} signal 本轮取消信号
 * @returns {boolean}
 */
function roundAlive(signal) {
  return aliveFn() && !(signal && signal.aborted);
}

/**
 * 睡到冷却锚点后再静置，避开服务器严格大于判据的边界同秒；时钟不可用退巡检。
 * @param {number} resetTs 冷却锚点秒（服务器 freeFlag，缺失时退下一日界）
 * @returns {number} 毫秒
 */
function sleepToReset(resetTs) {
  var now = gameData.serverTime();
  return resetTs && now
    ? Math.max((resetTs - now) * 1000 + RESET_SETTLE_MS, RESET_SETTLE_MS)
    : IDLE_TICK_MS;
}

/**
 * 免费礼包回执是否有明确成功凭证。
 * @param {*} d parseData 后的 V1 应答业务体
 * @returns {boolean}
 */
function hasClaimReceipt(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.freeFlag === true) return true;
  var freeFlag = Number(d.freeFlag);
  if (Number.isFinite(freeFlag) && freeFlag > gameData.serverTime()) return true;
  var items = d.reward && d.reward.items;
  if (!Array.isArray(items)) return false;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || (item.id == null && item.itemId == null)) continue;
    var count = item.num != null ? item.num : item.itemCount != null ? item.itemCount : item.count;
    if (count != null && Number(count) > 0) return true;
  }
  return false;
}

/**
 * 回读今日日戳；跨日自动作废。
 * @returns {Promise<void>}
 */
function loadStamp() {
  return storage.data
    .get(STAMP_KEY)
    .then(function (v) {
      var ts = Number(v && v.resetTs) || 0;
      var now = gameData.serverTime();
      if (ts > 0 && now > 0 && now < ts) {
        resolvedResetTs = ts;
        claimedToday = !!(v && v.claimed);
        bus.emit(EVT.UI_REFRESH);
        log.debug('restored vip-daily-gift day-stamp, resetTs=%d claimed=%s.', ts, claimedToday);
      }
    })
    .catch(function (err) {
      log.warn('cmd 2002 day-stamp load failed: %s', err && err.message);
    });
}

/**
 * 发起落盘；即使 pause 也先保存，避免恢复后重领。
 * @param {number} resetTs 冷却锚点秒（服务器 freeFlag，缺失时退下一日界）
 * @param {boolean} claimed 是否明确领成
 */
function saveStamp(resetTs, claimed) {
  resolvedResetTs = resetTs;
  claimedToday = !!claimed;
  storage.data.set(STAMP_KEY, { resetTs: resetTs, claimed: claimedToday }).catch(function (err) {
    log.warn('cmd 2002 day-stamp persist failed: %s', err && err.message);
  });
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 直发当前军级每日免费礼包。
 * @returns {Promise<{ok:boolean,claimed:boolean,code:number,reason?:string,nextTs?:number}>}
 *   成功时 nextTs = 应答 freeFlag（服务器权威冷却），缺失为 0。
 */
async function claimOnce() {
  if (!net) return { ok: false, claimed: false, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_VIP_DAY_REWARD,
    {},
    {
      protocol: 'send',
      onError: function (err) {
        log.warn('cmd 2002 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) {
    return {
      ok: false,
      claimed: false,
      code: ret ? ret.code : CODE_NOT_SENT,
      reason: ret && ret.reason,
    };
  }
  var d = parseData(ret.data);
  if (!hasClaimReceipt(d)) {
    log.warn('cmd 2002 ok but no freeFlag/reward receipt; do not mark resolved.');
    return { ok: false, claimed: false, code: -2 };
  }
  // 游戏 updateVipRewardCdTime(resp.freeFlag)：freeFlag 即服务器权威冷却锚点。
  return { ok: true, claimed: true, code: 0, nextTs: Number(d.freeFlag) || 0 };
}

/**
 * cycle 单轮：UID 日戳 → 真实军级/冷却 → 2002 → 明确回执落日戳。
 * @returns {Promise<number>} 下次唤醒毫秒
 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (stampLoad) await stampLoad;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  if (!now) {
    log.debug('cmd 2002 idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  if (resolvedResetTs > now) {
    log.debug(
      'cmd 2002 skipped: today resolved, claimed=%s resetTs=%d.',
      claimedToday,
      resolvedResetTs,
    );
    return sleepToReset(resolvedResetTs);
  }
  var vip = gameData.vipDailyGift();
  if (!vip) {
    log.debug('cmd 2002 idle: UserData VIP/free-gift state unavailable.');
    return IDLE_TICK_MS;
  }
  if (vip.cooldownTs > now) {
    // 冷却已推进到未来（本 feat 已领/换设备领取/20011 推送回写），本日无重试必要。
    rejectTries = 0;
    log.debug('cmd 2002 waiting: level=%d cooldownTs=%d.', vip.level, vip.cooldownTs);
    return sleepToReset(Math.min(vip.cooldownTs, gameData.nextDailyResetTs(now)));
  }
  var roundResetTs = gameData.nextDailyResetTs(now);
  if (!roundResetTs) {
    log.debug('cmd 2002 idle: next daily reset unavailable, level=%d.', vip.level);
    return IDLE_TICK_MS;
  }
  var dayStart = roundResetTs - DAY_SEC;
  if (dayStart !== rejectDayStart) {
    rejectDayStart = dayStart;
    rejectTries = 0;
  }
  // 日界静置：0 点整同一秒内发车必被服务器严格大于判据拒（实证 00:00:00.592 code=3），
  // 睡醒落点或页面加载恰在日界头几秒时，先补齐静置再发。
  var intoDay = now - dayStart;
  if (intoDay < RESET_SETTLE_MS / 1000) {
    var settleMs = (RESET_SETTLE_MS / 1000 - intoDay) * 1000 + 200;
    log.debug('cmd 2002 boundary settle %dms after daily reset, level=%d.', settleMs, vip.level);
    return settleMs;
  }
  var ret = await claimOnce();
  var paused = !roundAlive(signal);
  if (!ret.ok) {
    if (ret.code === CODE_NOT_SENT) {
      if (paused) return 0;
      log.warn('cmd 2002 transient (not sent/in-flight), retry soon; level=%d.', vip.level);
      return TRANSIENT_RETRY_MS;
    }
    if (gameData.nextDailyResetTs() !== roundResetTs) {
      log.debug('cmd 2002 empty/rejected response crossed midnight; discard stale result.');
      return paused ? 0 : 1000;
    }
    if (ret.code === -2) return paused ? 0 : TRANSIENT_RETRY_MS;
    // 业务拒绝先按阶梯重试：一次拒绝不等于当日无望（日界同秒被拒即此类）。
    if (rejectTries < REJECT_RETRY_MS.length) {
      var retryMs = REJECT_RETRY_MS[rejectTries++];
      if (paused) return 0;
      log.info(
        'cmd 2002 vip daily gift rejected; retry in %ds (try %d/%d). level=%d code=%s;data=%s',
        retryMs / 1000,
        rejectTries,
        REJECT_RETRY_MS.length + 1,
        vip.level,
        ret.code,
        rejectText(ret) || '-',
      );
      return retryMs;
    }
    saveStamp(roundResetTs, false);
    if (paused) return 0;
    log.info(
      'cmd 2002 vip daily gift rejected; give up for today after %d tries. level=%d code=%s;data=%s',
      REJECT_RETRY_MS.length + 1,
      vip.level,
      ret.code,
      rejectText(ret) || '-',
    );
    return sleepToReset(roundResetTs);
  }
  rejectTries = 0;
  if (gameData.nextDailyResetTs() !== roundResetTs) {
    log.debug('cmd 2002 claim response crossed midnight; old day-stamp discarded.');
    return paused ? 0 : 1000;
  }
  // 服务器 freeFlag 是权威冷却；合法时按它锚定，缺失/异常才退下一日界。
  var nextTs = ret.nextTs > now ? ret.nextTs : roundResetTs;
  saveStamp(nextTs, true);
  if (paused) return 0;
  log.info(
    'vip daily gift claimed for current military rank (level=%d nextTs=%d).',
    vip.level,
    nextTs,
  );
  return sleepToReset(nextTs);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 安装网络底座。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  net = ctx.net;
  if (!net || !net.install()) {
    net = null;
    log.warn('install failed: pocketcc.net unavailable.');
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * 每次激活登记推送；pause 时 reactor 会摘除，install 只执行一次。
 * @param {object} ctx reactor 上下文
 */
function subscribe(ctx) {
  // 推送只触发面板刷新与一拍重读；冷却态仍以 UserData/本次回执为准，不缓存第二份真相。
  // 换设备领取或服务器提前放开冷却时，kick 让引擎立刻重读而不是傻等到旧锚点。
  ctx.on.push(PUSH_VIP_FREE_REWARD_UPDATE, function () {
    bus.emit(EVT.UI_REFRESH);
    cycle.kick();
  });
}

/** @param {object} ctx reactor 上下文 */
function run(ctx) {
  ctxRef = ctx;
  resolvedResetTs = 0;
  claimedToday = false;
  rejectTries = 0;
  rejectDayStart = 0;
  stampLoad = loadStamp();
  subscribe(ctx);
  log.info('started.');
  cycle.kick();
}

reactor.register({
  id: 'vipDailyGift',
  label: '军级宝箱',
  storageKey: 'pocketcc.feat.vipDailyGift',
  symbols: ['dataCenter'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_vipGiftInfo',
      type: 'text',
      label: '今日',
      get: function () {
        var vip = gameData.vipDailyGift();
        if (!vip) return '—';
        if (claimedToday || vip.cooldownTs > gameData.serverTime()) return dailyText(1, 1);
        return dailyText(0, 1);
      },
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
});

export { cycleRun, install as installForTest, subscribe as subscribeForTest };
/** 单测专用：复位内存日戳与拒绝重试计数，不启动 cycle。 */
export function resetForTest() {
  resolvedResetTs = 0;
  claimedToday = false;
  rejectTries = 0;
  rejectDayStart = 0;
  stampLoad = null;
}
/** 单测专用：发起日戳回读。 */
export function loadStampForTest() {
  stampLoad = loadStamp();
  return stampLoad;
}
