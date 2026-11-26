/**
 * 至尊月卡每日礼包（当前新版计时月卡，reactor 说明书形态，玩家基础设置，单链）
 *
 * 状态与协议（公开游戏客户端源码；未做账号登录抓包）：
 *   UserData.TimeCards 由 UserData.updateTimeCards 维护，元素含 cardId/endTime/nextRewardTime。
 *   ExchangeController.MONTHLYCARD_SHIT_ID_NEW=5003；游戏仅在 ServerTime<endTime 且
 *   ServerTime>nextRewardTime 时显示领取按钮，点击发送：
 *     750 GET_TIMECARD_REWARD，V1 send，载荷 {cardId} → 应答 d 为 JSON 串（游戏回调 JSON_PARSE(resp.d)）。
 *   本功能只发免费领取请求，不购买月卡、不调用游戏 Update/回写、不 OpenUI。
 *
 * 防重领：750 直发不经游戏 UI 回调，不能依赖 nextRewardTime 立即回写；发包前锚定服务器日界，
 *   领取成功/真正业务拒绝后在 storage.data 落 resolvedResetTs 日戳，同日刷新后零发包。
 *   应答跨午夜时旧日戳立即过期，下一拍可按新日再判；CODE_NOT_SENT 必须短重试且不落日戳。
 *
 * 调度：createCycle 单飞；active+ready 领一拍，wait 睡到 nextRewardTime+1 秒与日界中较早者，
 *   当日已解决睡到日界，月卡未生效/数据未就绪退 15 分钟巡检（续费状态可能变化）。
 */
import { CODE_NOT_SENT, parseData, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { dailyText } from '../../../core/daily-stats.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';

import { CARD_ID_MONTHLY, CMD_GET_TIMECARD_REWARD } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('MONTHLY-CARD');

/** @type {number} 未生效/数据未就绪巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 瞬态未发出的短重试间隔（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {string} UID 隔离运行数据中的当日已解决日戳键 */
const STAMP_KEY = 'monthlyCard.resolved';

/** @type {object|null} pocketcc.net 网络底座 */
var net = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 今日已解决对应的下一服务器日界；未到该时刻抑制同日重发 */
var resolvedResetTs = 0;
/** @type {boolean} 今日是否领成（面板只读凭证） */
var claimedToday = false;
/** @type {Promise<void>|null} 首拍等待的日戳回读 */
var stampLoad = null;

/**
 * @returns {boolean} 当前 reactor 功能是否仍存活
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 本轮是否仍属于当前激活代次；pause 后即使 resume，旧 signal 也不会复活。
 * @param {AbortSignal|null} signal 本轮开始时捕获的取消信号
 * @returns {boolean}
 */
function roundAlive(signal) {
  return aliveFn() && !(signal && signal.aborted);
}

/**
 * 睡到指定服务器时刻，时钟不可用退巡检；至少等待 1 秒，避免同拍空转。
 * @param {number} untilTs epoch 秒
 * @returns {number} 毫秒
 */
function sleepToTs(untilTs) {
  var now = gameData.serverTime();
  if (!now || !untilTs) return IDLE_TICK_MS;
  return Math.max((untilTs - now) * 1000, 1000);
}

/**
 * 游戏 UI 只在 JSON_PARSE(e.d) 得到非空对象后展示奖励；空对象/空串不构成领取凭证。
 * @param {*} d 已解析的 750 应答业务体
 * @returns {boolean}
 */
function hasRewardPayload(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length > 0;
}

/**
 * 直发 750 领取当前至尊月卡当日礼包；V1 应答 data 可能是 JSON 串。永不 reject。
 * @returns {Promise<{ok:boolean, code:number, claimed:boolean, reason?:string}>}
 */
async function claimOnce() {
  if (!net) return { ok: false, claimed: false, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_GET_TIMECARD_REWARD,
    // 商店档位是已知小整数；ACL 用字符串精确匹配，这里保持游戏 UI 的数值载荷形态。
    { cardId: CARD_ID_MONTHLY },
    {
      protocol: 'send',
      onError: function (err) {
        log.warn('cmd 750 send threw: %s', err && err.message);
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
  var claimed = hasRewardPayload(d);
  if (!claimed) log.warn('cmd 750 ok but reward payload is empty; retry soon.');
  return { ok: true, claimed: claimed, code: 0 };
}

/**
 * cycle 单轮：日戳 → 月卡有效期 → nextRewardTime → 750 → 落日戳并择时。
 * @returns {Promise<number>} 下次唤醒毫秒
 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (stampLoad) await stampLoad;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  if (!now) {
    log.debug('cmd 750 idle: server time unavailable.');
    return IDLE_TICK_MS;
  }
  if (resolvedResetTs > now) {
    log.debug('cmd 750 skipped: today resolved until resetTs=%d.', resolvedResetTs);
    return sleepToTs(resolvedResetTs);
  }
  claimedToday = false;
  var card = gameData.monthlyCard(CARD_ID_MONTHLY);
  if (!card || now >= card.endTime) {
    log.debug('cmd 750 skipped: cardId=%d inactive or expired.', CARD_ID_MONTHLY);
    return IDLE_TICK_MS;
  }
  if (now <= card.nextRewardTime) {
    log.debug('cmd 750 waiting: nextRewardTime=%d.', card.nextRewardTime);
    return sleepToTs(Math.min(card.nextRewardTime + 1, gameData.nextDailyResetTs(now)));
  }

  // 日界必须在发包前锚定：应答若跨午夜，不能把昨日结果误记成“次日已解决”。
  var roundResetTs = gameData.nextDailyResetTs(now);
  if (!roundResetTs) {
    log.debug('cmd 750 idle: next daily reset unavailable.');
    return IDLE_TICK_MS;
  }
  var ret = await claimOnce();
  var afterNow = gameData.serverTime() || now;
  if (!ret.ok && ret.code === CODE_NOT_SENT) {
    if (!roundAlive(signal)) return 0;
    log.warn('cmd 750 transient (not sent/in-flight), retry soon.');
    return TRANSIENT_RETRY_MS;
  }
  if (ret.ok && !ret.claimed) {
    if (!roundAlive(signal)) return 0;
    log.warn('cmd 750 ok but no reward payload; do not mark today resolved.');
    return TRANSIENT_RETRY_MS;
  }
  resolvedResetTs = roundResetTs;
  claimedToday = ret.claimed && roundResetTs > afterNow;
  // 成功/真拒绝先发起落盘，再判本轮存活：pause 不能吞掉已发出请求的回执。
  saveStamp(ret.claimed);
  if (!roundAlive(signal)) return 0;
  if (ret.ok) {
    log.info('monthly-card daily gift claimed (#%s).', card.cardId);
  } else {
    log.info(
      'monthly-card claim rejected, retry after midnight. code=%s;data=%s',
      ret.code,
      rejectText(ret) || '-',
    );
  }
  return sleepToTs(resolvedResetTs);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 回读当日日戳；仅当前服务器日界内有效，读失败按无日戳由服务器裁决。
 * @returns {Promise<void>}
 */
function loadStamp() {
  return storage.data
    .get(STAMP_KEY)
    .then(function (v) {
      var ts = Number(v && v.resetTs) || 0;
      var now = gameData.serverTime();
      if (ts > now && now > 0 && String(v && v.cardId) === String(CARD_ID_MONTHLY)) {
        resolvedResetTs = ts;
        claimedToday = !!(v && v.claimed);
        bus.emit(EVT.UI_REFRESH);
      } else if (ts > now && now > 0) {
        log.debug('cmd 750 ignored day-stamp from another cardId=%s.', v && v.cardId);
      }
    })
    .catch(function (err) {
      log.warn('monthly-card day-stamp load failed: %s', err && err.message);
    });
}

/**
 * 落盘当日已解决日戳。写失败不阻塞内存日戳与调度。
 * @param {boolean} claimed 是否领成
 */
function saveStamp(claimed) {
  storage.data
    .set(STAMP_KEY, {
      resetTs: resolvedResetTs,
      cardId: CARD_ID_MONTHLY,
      claimed: !!claimed,
    })
    .catch(function (err) {
      log.warn('monthly-card day-stamp save failed: %s', err && err.message);
    });
  bus.emit(EVT.UI_REFRESH);
}

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
    log.warn('install failed: pocketcc.net unavailable');
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * 启动：复位日戳并异步回读，随后立即判断一次。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  resolvedResetTs = 0;
  claimedToday = false;
  stampLoad = loadStamp();
  log.info('started.');
  cycle.kick();
}

reactor.register({
  id: 'monthlyCard',
  label: '至尊月卡每日礼包',
  storageKey: 'pocketcc.feat.monthlyCard',
  symbols: ['dataCenter'],
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
        var now = gameData.serverTime();
        var card = gameData.monthlyCard(CARD_ID_MONTHLY);
        if (!now || !card || now >= card.endTime) return '未生效';
        if (claimedToday || now <= card.nextRewardTime) return dailyText(1, 1);
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

export { cycleRun, install as installForTest };
/** 单测专用：复位内存日戳，不启动 cycle。 */
export function resetForTest() {
  resolvedResetTs = 0;
  claimedToday = false;
  stampLoad = null;
}
/** 单测专用：发起日戳回读，等价 run() 的首拍保护。 */
export function loadStampForTest() {
  stampLoad = loadStamp();
  return stampLoad;
}
