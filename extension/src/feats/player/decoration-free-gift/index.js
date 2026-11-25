/**
 * 套装商城免费套装金币（默认关闭，周一服务器日界，单链）。
 *
 * 协议（公开 H5 客户端源码 subpack2.5c3c4.js 实证）：
 *   3963 DECORATION_CONTENT_SHOP_GET_INFO，NET.sendPB，
 *     {header:{},decorationContentShopGetInfo:{reqType:1}} →
 *     pbAck.decorationContentShopGetInfo.canGetFreeNum。
 *   3965 DECORATION_CONTENT_SHOP_FREE_GET，NET.sendPB，{header:{}} →
 *     pbAck.decorationContentShopFreeGet.reward。UI 的 -99 只是本地哨兵，不入载荷。
 *   免费请求成功后本地只递减显示次数，服务器权威剩余量必须重查 3963。
 *
 * 不调用 3964 付费分支，不处理 ¥30 兑换；仅 canGetFreeNum>0 时领取。查询确认 0 或
 * 领取后重查确认 0 才落 UID 周戳。CODE_NOT_SENT/空应答不落戳，真业务拒绝 15 分钟后再读；
 * 周界使用服务器 UTC+8 周一 0 点，跨周旧回执不污染新周。
 */
import { CODE_NOT_SENT, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';
import { CMD_DECORATION_SHOP_INFO, CMD_DECORATION_SHOP_FREE_GET } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('DECORATION-GIFT');
/** @type {number} 拒绝/状态未就绪后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 未发出/领取后额度未归零的短重试（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {number} 周一刷新后的缓冲（毫秒） */
const WEEK_ANCHOR_BUFFER_MS = 1000 * 60;
/** @type {string} UID 隔离运行数据中的本周已解决日戳键 */
const STAMP_KEY = 'decorationFreeGift.resolved';
/** @type {number} 本地哨兵：成功应答缺少业务体 */
const MALFORMED_RESPONSE = -2;

/** @type {object|null} pocketcc.net 网络底座 */
var net = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 本周已解决对应的下一周界 */
var resolvedResetTs = 0;
/** @type {boolean} 本周是否明确领取成功 */
var claimedThisWeek = false;
/** @type {Promise<void>|null} 首拍周戳回读 */
var stampLoad = null;

/** @returns {boolean} 当前激活是否存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * @param {AbortSignal|null} signal 本轮取消信号
 * @returns {boolean} 当前激活代次是否仍有效
 */
function roundAlive(signal) {
  return aliveFn() && !(signal && signal.aborted);
}

/**
 * 睡到下一周界，至少 1 秒；时钟不可用退巡检。
 * @param {number} resetTs 下一服务器周界秒
 * @returns {number} 毫秒
 */
function sleepToReset(resetTs) {
  var now = gameData.serverTime();
  return resetTs && now
    ? Math.max((resetTs - now) * 1000 + WEEK_ANCHOR_BUFFER_MS, 1000)
    : IDLE_TICK_MS;
}

/**
 * 回读本周周戳；跨周自动作废。
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
        claimedThisWeek = !!(v && v.claimed);
        bus.emit(EVT.UI_REFRESH);
        log.debug(
          'restored decoration-gift week-stamp, resetTs=%d claimed=%s.',
          ts,
          claimedThisWeek,
        );
      }
    })
    .catch(function (err) {
      log.warn('cmd 3963 week-stamp load failed: %s', err && err.message);
    });
}

/**
 * @param {number} resetTs 发包前锚定的下一周界
 * @param {boolean} claimed 是否领取成功
 */
function saveStamp(resetTs, claimed) {
  resolvedResetTs = resetTs;
  claimedThisWeek = !!claimed;
  storage.data.set(STAMP_KEY, { resetTs: resetTs, claimed: claimedThisWeek }).catch(function (err) {
    log.warn('cmd 3963 week-stamp persist failed: %s', err && err.message);
  });
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 查询服务器权威免费额度。
 * @returns {Promise<{ok:boolean,remaining:number,code:number,reason?:string}>}
 */
async function fetchInfo() {
  if (!net) return { ok: false, remaining: -1, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_DECORATION_SHOP_INFO,
    { header: {}, decorationContentShopGetInfo: { reqType: 1 } },
    {
      protocol: 'sendPB',
      onError: function (err) {
        log.warn('cmd 3963 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) {
    return {
      ok: false,
      remaining: -1,
      code: ret ? ret.code : CODE_NOT_SENT,
      reason: ret && ret.reason,
    };
  }
  var ack = ret.data && ret.data.decorationContentShopGetInfo;
  var info = gameData.decorationFreeGift(ack);
  if (!info) {
    log.warn('cmd 3963 ack missing decorationContentShopGetInfo.canGetFreeNum.');
    return { ok: false, remaining: -1, code: MALFORMED_RESPONSE };
  }
  return { ok: true, remaining: info.canGetFreeNum, code: 0 };
}

/**
 * 免费领取；不使用付费商品 ID 或 UI 的 -99 哨兵。
 * @returns {Promise<{ok:boolean,code:number,reason?:string}>}
 */
async function claimOnce() {
  if (!net) return { ok: false, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_DECORATION_SHOP_FREE_GET,
    { header: {} },
    {
      protocol: 'sendPB',
      onError: function (err) {
        log.warn('cmd 3965 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) {
    return { ok: false, code: ret ? ret.code : CODE_NOT_SENT, reason: ret && ret.reason };
  }
  if (!ret.data || !ret.data.decorationContentShopFreeGet) {
    log.warn('cmd 3965 ok but missing decorationContentShopFreeGet; re-query remaining.');
  }
  return { ok: true, code: 0 };
}

/**
 * cycle 单轮：周戳 → 3963 → 有额度发 3965 → 重查 3963 → 确认 0 落周戳。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (stampLoad) await stampLoad;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  if (!now) {
    log.debug('cmd 3963/3965 idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  if (resolvedResetTs > now) {
    log.debug(
      'cmd 3963/3965 skipped: week resolved, claimed=%s resetTs=%d.',
      claimedThisWeek,
      resolvedResetTs,
    );
    return sleepToReset(resolvedResetTs);
  }
  var roundResetTs = gameData.nextWeeklyResetTs(now);
  if (!roundResetTs) {
    log.debug('cmd 3963/3965 idle: next weekly reset unavailable.');
    return IDLE_TICK_MS;
  }
  var info = await fetchInfo();
  var paused = !roundAlive(signal);
  if (!info.ok) {
    if (info.code === CODE_NOT_SENT) {
      if (paused) return 0;
      log.warn('cmd 3963 transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    if (gameData.nextWeeklyResetTs() !== roundResetTs) return paused ? 0 : 1000;
    if (info.code === MALFORMED_RESPONSE) return paused ? 0 : IDLE_TICK_MS;
    log.info(
      'cmd 3963 query rejected, poll later. code=%s reason=%s',
      info.code,
      info.reason || '-',
    );
    return paused ? 0 : IDLE_TICK_MS;
  }
  if (gameData.nextWeeklyResetTs() !== roundResetTs) {
    log.debug('cmd 3963 response crossed weekly reset; discard stale free quota.');
    return paused ? 0 : 1000;
  }
  if (info.remaining <= 0) {
    saveStamp(roundResetTs, false);
    if (paused) return 0;
    log.debug('cmd 3963 no free decoration coins; mark week resolved.');
    return sleepToReset(roundResetTs);
  }
  var claim = await claimOnce();
  paused = !roundAlive(signal);
  if (!claim.ok) {
    if (claim.code === CODE_NOT_SENT) {
      if (paused) return 0;
      log.warn('cmd 3965 transient (not sent/in-flight); re-query before retry.');
      return TRANSIENT_RETRY_MS;
    }
    if (gameData.nextWeeklyResetTs() !== roundResetTs) return paused ? 0 : 1000;
    log.info(
      'cmd 3965 free gift rejected; no week-stamp. code=%s;data=%s',
      claim.code,
      rejectText(claim) || '-',
    );
    return paused ? 0 : IDLE_TICK_MS;
  }
  // 不论 3965 回执是否带 reward，都以 3963 的权威剩余额度作为完成凭证。
  var after = await fetchInfo();
  paused = !roundAlive(signal);
  if (!after.ok) {
    if (after.code === CODE_NOT_SENT) {
      if (paused) return 0;
      log.warn('cmd 3963 post-claim transient; do not mark week resolved.');
      return TRANSIENT_RETRY_MS;
    }
    if (gameData.nextWeeklyResetTs() !== roundResetTs) return paused ? 0 : 1000;
    log.info(
      'cmd 3963 post-claim rejected, retry later. code=%s reason=%s',
      after.code,
      after.reason || '-',
    );
    return paused ? 0 : IDLE_TICK_MS;
  }
  if (gameData.nextWeeklyResetTs() !== roundResetTs) {
    log.debug('cmd 3963 post-claim crossed weekly reset; old week-stamp discarded.');
    return paused ? 0 : 1000;
  }
  if (after.remaining <= 0) {
    saveStamp(roundResetTs, true);
    if (paused) return 0;
    log.info('free decoration coins claimed; server remaining=0.');
    return sleepToReset(roundResetTs);
  }
  if (paused) return 0;
  log.debug(
    'cmd 3965 sent but free quota remains=%d; re-query before another claim.',
    after.remaining,
  );
  return TRANSIENT_RETRY_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
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

/** @param {object} ctx reactor 上下文 */
function run(ctx) {
  ctxRef = ctx;
  resolvedResetTs = 0;
  claimedThisWeek = false;
  stampLoad = loadStamp();
  log.info('started; weekly anchor=Monday 00:00 UTC+8 +60s.');
  cycle.kick();
}

reactor.register({
  id: 'decorationFreeGift',
  label: '每周免费套装金币',
  storageKey: 'pocketcc.feat.decorationFreeGift',
  symbols: ['dataCenter'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_decorationGiftInfo',
      type: 'text',
      label: '本周',
      get: function () {
        var now = gameData.serverTime();
        return resolvedResetTs > 0 && now > 0 && now < resolvedResetTs
          ? claimedThisWeek
            ? '本周已领取'
            : '本周无需领取'
          : '等待领取';
      },
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
});

export { cycleRun, install as installForTest };
/** 单测专用：复位内存周戳，不启动 cycle。 */
export function resetForTest() {
  resolvedResetTs = 0;
  claimedThisWeek = false;
  stampLoad = null;
}
/** 单测专用：发起周戳回读。 */
export function loadStampForTest() {
  stampLoad = loadStamp();
  return stampLoad;
}
