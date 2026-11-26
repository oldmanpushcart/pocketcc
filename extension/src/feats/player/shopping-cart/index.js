/**
 * 金融中心购物车每日一键兑换（默认关闭，单链：4204 查询 → 规划 → 4203 兑换）。
 *
 * 协议（报文实证 dashcam/store/rec/14179309129759/dashcam-rec-20261126T181710-购物车.ndjson）：
 *   4204 SHOPPING_CAR_INFO，legacy sendPB，{header:{}} →
 *     pbAck.shoppingCarInfo.singleShopData[]，每项 {shopType,productPurchasedData[]}，
 *     明细 {productId,chooseNum,purchasedBuyNum}。
 *   4203 SHOPPING_CAR_BUY，legacy sendPB，
 *     {header:{},shoppingCarBuy:{shopData:[{shopType,productData:[{productId,buyNum}]}]}} →
 *     pbAck.shoppingCarBuy{reward,shopPurchasedInfo}；实测回执的 shopPurchasedInfo 是**成交后的全量
 *     购物车**（26 项与查询一一对应，只有被买项 purchasedBuyNum +1），可直接判收尾、省一次 4204。
 *
 * 收敛判据（服务端计数是唯一真相，本地不留任何当日台账）：
 *   chooseNum = 购物车勾选的应买数量；purchasedBuyNum = 限购周期内已买到数量（日刷新项 0 点归零，
 *   周刷新项随周一日界归零，故日/周两种周期无需特判）。gap = chooseNum − purchasedBuyNum ≤ 0 即该项
 *   今日已了结；成交只会让计数变大 → 重载/换号/漏拍都自愈，也不会重复成交
 *   （旧「每项每天一批」台账口径下，11-26 10:08 那轮把 2:28 从 1 买到 2 就是这么来的）。
 *
 * 择时：全部项了结（含只剩被限购天花板压死的项）→ 睡到下一日界 + 5 分钟，期间零发包；
 *   仍欠但本轮买不起 → 15 分钟起步、每轮 +5 分钟、封顶 60 分钟，任何成交或跨日回到首档；
 *   所有等待分支统一夹到日界，免得退避把新一天的首扫拖后一小时。
 *   4203 允许任意 buyNum，故支持部分购买：某商店限购还够但货币不够时，按购物车原序能买几个买几个（见 plan.js）。
 *   成交轮直接用 4203 回执判收尾；若回执里已买计数没涨（服务端口头成功），连踩两拍即转退避，不 5 秒一次打乒乓。
 *
 * 合规：不 OpenUI、不调用游戏 Update/Delete、不涉及任何真钱/充值分支；全程 base/world 常态本服可运行。
 */
import { CODE_NOT_SENT } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { dailyText } from '../../../core/daily-stats.js';
import { bus, EVT } from '../../../core/bus.js';
import { CMD_SHOPPING_CAR_INFO, CMD_SHOPPING_CAR_BUY } from './constants.js';
import { planShoppingCart } from './plan.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('SHOPPING-CART');

/** @type {number} 等余额巡检退避首档（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 每轮空增步进（毫秒）：15 → 20 → 25 … */
const IDLE_STEP_MS = 1000 * 60 * 5;
/** @type {number} 等余额巡检退避封顶（毫秒） */
const IDLE_MAX_MS = 1000 * 60 * 60;
/** @type {number} 退避最高档下标：(60-15)/5 = 9 */
const IDLE_MAX_STEP = (IDLE_MAX_MS - IDLE_TICK_MS) / IDLE_STEP_MS;
/** @type {number} 瞬态未发出/应答不可解析后的短重试（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {number} 成交后复检间隔（毫秒）：回执算不出收尾时回读一次 4204 */
const AFTER_BUY_RECHECK_MS = 1000 * 5;
/** @type {number} 睡过服务器 0 点后的缓冲（毫秒）：等日刷新推送落地再醒 */
const DAILY_ANCHOR_BUFFER_MS = 1000 * 60 * 5;
/** @type {number} 连续几轮「4203 说成功但已买计数没涨」即转退避，避免 5 秒一次打乒乓 */
const MAX_STALL_ROUNDS = 2;

/** @type {object|null} 网络底座 */
var net;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {object|null} 最近一轮规划结果（只用于面板状态文案） */
var lastPlan = null;
/** @type {number} 等余额退避档位（0..IDLE_MAX_STEP） */
var idleStep = 0;
/** @type {number} 本轮锚定的下一日界绝对秒；变化即视为跨日，退避与乒乓计数归零 */
var anchorTs = 0;
/** @type {number} 连续「成交回执无进展」轮数 */
var stall = 0;
/** @type {string} 上次已上报的面板文案，用于去重 UI_REFRESH */
var lastText = '';

/** @returns {boolean} 功能是否仍存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * @param {AbortSignal|null} signal 本轮取消信号
 * @returns {boolean} 当前激活代次仍有效
 */
function roundAlive(signal) {
  return aliveFn() && !(signal && signal.aborted);
}

/**
 * 购物车快照的已买总数（服务端计数的标量摘要）：只用于判定「这一轮 4203 是否真有进展」，
 * 不参与任何购买决策——决策逐项看 gap，跨日归零也不会误判（跨日在锚点变化时已重置本状态）。
 * @param {{items:Array<object>}|null} cart ACL 投影
 * @returns {number}
 */
function purchasedTotal(cart) {
  if (!cart || !Array.isArray(cart.items)) return 0;
  var sum = 0;
  for (var i = 0; i < cart.items.length; i++) sum += Number(cart.items[i].purchasedBuyNum) || 0;
  return sum;
}

/**
 * 睡到下一日界 + 缓冲。
 * @param {number} untilTs 下一日界绝对秒
 * @returns {number} 毫秒
 */
function sleepToTs(untilTs) {
  if (!untilTs) return IDLE_TICK_MS;
  var left = (untilTs - gameData.serverTime()) * 1000 + DAILY_ANCHOR_BUFFER_MS;
  return Math.max(left, DAILY_ANCHOR_BUFFER_MS);
}

/**
 * 等待类择时统一夹到日界：新一天的首扫最迟在 0 点 + 缓冲醒来，退避再长也拖不过它。
 * @param {number} ms 候选睡眠
 * @param {number} next 本轮锚定的下一日界绝对秒
 * @returns {number} 毫秒
 */
function clampToDay(ms, next) {
  return Math.min(ms, sleepToTs(next));
}

/**
 * 等余额巡检的下一拍间隔：15 分钟起步，每轮 +5 分钟，60 分钟封顶；任何成交或跨日都回到首档。
 * @returns {number} 毫秒
 */
function idleDelay() {
  var d = IDLE_TICK_MS + idleStep * IDLE_STEP_MS;
  if (idleStep < IDLE_MAX_STEP) idleStep++;
  return d;
}

/**
 * 4204 应答 → 购物车投影。
 * @param {*} data pbAck
 * @returns {{items:Array<object>,skipped:Array<object>}|null} null=应答不可用或投影不可用
 */
function cartFromQuery(data) {
  var ack = data && data.shoppingCarInfo;
  return ack ? gameData.shoppingCart(ack.singleShopData) : null;
}

/**
 * 4203 成功回执 → 成交后的全量购物车投影（报文实证与 4204 同构）。
 * @param {*} data pbAck
 * @returns {{items:Array<object>,skipped:Array<object>}|null} null=回执没带购物车快照
 */
function cartFromBuy(data) {
  var bought = data && data.shoppingCarBuy;
  var info = bought && bought.shopPurchasedInfo;
  return info ? gameData.shoppingCart(info.singleShopData) : null;
}

/**
 * 逐项留痕：ACL 无法可靠定价/取限购的商品不代兑（联盟店折扣读不到、动态价、缺表行）。
 * @param {{items:Array<object>,skipped:Array<object>}} cart
 */
function logSkipped(cart) {
  var rows = cart && cart.skipped;
  if (!rows || !rows.length) return;
  for (var i = 0; i < rows.length; i++) {
    log.debug(
      'shopping-cart item not exchanged: shopType=%s productId=%s reason=%s.',
      rows[i].shopType,
      rows[i].productId,
      rows[i].reason,
    );
  }
}

/**
 * 记下面板文案，变化时才踢一次 UI_REFRESH（长静默期不该反复刷面板）。
 */
function publishStatus() {
  var text = statusText();
  if (text === lastText) return;
  lastText = text;
  bus.emit(EVT.UI_REFRESH);
}

/** cycle 单轮：4204 → 规划 → （需要时）4203 → 由服务端计数决定下一拍。 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  var next = gameData.nextDailyResetTs(now);
  if (!now || !next) {
    log.debug('shopping-cart idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  if (anchorTs !== next) {
    anchorTs = next;
    idleStep = 0;
    stall = 0;
  }
  if (!net) {
    log.warn('shopping-cart skipped: network base unavailable.');
    return clampToDay(IDLE_TICK_MS, next);
  }

  var query = await net.sendGuarded(
    CMD_SHOPPING_CAR_INFO,
    { header: {} },
    {
      protocol: 'sendPB',
      onError: function (err) {
        log.warn('cmd 4204 shopping-cart query threw: %s', err && err.message);
      },
    },
  );
  if (!roundAlive(signal)) return 0;
  if (gameData.nextDailyResetTs() !== next) {
    log.debug('cmd 4204 response crossed midnight; discard stale cart.');
    return 1000;
  }
  if (!query || !query.ok) {
    var qCode = query ? query.code : CODE_NOT_SENT;
    if (qCode === CODE_NOT_SENT) {
      log.warn('cmd 4204 transient not-sent/in-flight (code=%s), retry soon.', qCode);
      return clampToDay(TRANSIENT_RETRY_MS, next);
    }
    log.info(
      'cmd 4204 query rejected, retry later. code=%s reason=%s',
      qCode,
      (query && query.reason) || '-',
    );
    return clampToDay(IDLE_TICK_MS, next);
  }
  var cart = cartFromQuery(query.data);
  if (!cart) {
    log.warn('cmd 4204 malformed ack or cart projection unavailable; no buy sent.');
    return clampToDay(IDLE_TICK_MS, next);
  }
  var total = purchasedTotal(cart);
  var plan = planShoppingCart(cart);
  lastPlan = plan;
  publishStatus();
  logSkipped(cart);
  if (!plan.shopData.length) return settle(plan, next);

  // 写请求前再次核验激活代次和日界，避免在飞暂停恢复/跨日应答后继续兑换。
  if (!roundAlive(signal)) return 0;
  if (gameData.nextDailyResetTs() !== next) {
    log.debug('shopping-cart cart crossed midnight before buy; no stale exchange sent.');
    return 1000;
  }
  var buy = await net.sendGuarded(
    CMD_SHOPPING_CAR_BUY,
    { header: {}, shoppingCarBuy: { shopData: plan.shopData } },
    {
      protocol: 'sendPB',
      onError: function (err) {
        log.warn('cmd 4203 shopping-cart buy threw: %s', err && err.message);
      },
    },
  );
  if (!buy || !buy.ok) {
    var bCode = buy ? buy.code : CODE_NOT_SENT;
    if (bCode !== CODE_NOT_SENT) {
      // 业务拒绝 = 什么都没买：服务端计数没动，下一轮按新余额重算，本地无需任何补偿。
      log.info(
        'cmd 4203 buy rejected; nothing exchanged. code=%s reason=%s',
        bCode,
        (buy && buy.reason) || '-',
      );
      return clampToDay(idleDelay(), next);
    }
    log.warn('cmd 4203 transient not-sent/in-flight/unknown; re-query before any retry.');
    return clampToDay(TRANSIENT_RETRY_MS, next);
  }
  if (gameData.nextDailyResetTs(gameData.serverTime()) !== next) {
    log.debug('cmd 4203 ok after midnight; receipt belongs to yesterday, re-scan next round.');
    return 1000;
  }
  var receipt = cartFromBuy(buy.data);
  if (!receipt) {
    // 没带全量购物车快照就无从判进展：不动退避档，5 秒后回读 4204 由服务端计数定性。
    log.warn(
      'cmd 4203 ok without shopPurchasedInfo snapshot (items=%d); re-query soon.',
      plan.entries.length,
    );
    return clampToDay(AFTER_BUY_RECHECK_MS, next);
  }
  if (purchasedTotal(receipt) > total) {
    // 只有服务端计数真涨了才算成交：退避回首档、乒乓计数清零。
    stall = 0;
    idleStep = 0;
  } else {
    // 服务端说成功、已买计数却没涨：不认账；连踩几轮就转退避，别 5 秒一次打乒乓。
    stall++;
    if (stall >= MAX_STALL_ROUNDS) {
      log.warn(
        'cmd 4203 ok but purchasedBuyNum unchanged for %d rounds; back off instead of re-querying.',
        stall,
      );
      return clampToDay(idleDelay(), next);
    }
  }
  var after = planShoppingCart(receipt);
  lastPlan = after;
  publishStatus();
  log.info(
    'cmd 4203 exchange confirmed: sent=%d partial=%d; still owing pending=%d.',
    plan.planned,
    plan.partial,
    after.pending,
  );
  if (!after.shopData.length) return settle(after, next);
  // 还有欠账（多为服务端只成交了一部分）：余额要等推送落地，5 秒后重查 4204 再规划。
  return clampToDay(AFTER_BUY_RECHECK_MS, next);
}

/**
 * 本轮无包可发的收尾择时：全了结就睡到日界，还欠则按退避等余额。
 * @param {object} plan 最近一轮规划
 * @param {number} next 本轮锚定的下一日界绝对秒
 * @returns {number} 毫秒
 */
function settle(plan, next) {
  if (!plan.items) {
    log.debug('shopping-cart empty on server; sleep to next day boundary.');
    return sleepToTs(next);
  }
  if (!plan.pending) {
    log.debug(
      'shopping-cart nothing left today (done=%d capped=%d skipped=%d); sleep to next day boundary.',
      plan.done,
      plan.capped,
      plan.skipped,
    );
    return sleepToTs(next);
  }
  log.debug(
    'shopping-cart still owing %d item(s) (done=%d capped=%d); wait for balance.',
    plan.pending,
    plan.done,
    plan.capped,
  );
  return clampToDay(idleDelay(), next);
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
    log.warn('shopping-cart install failed: pocketcc.net unavailable.');
    net = null;
    return false;
  }
  log.info('installed.');
  return true;
}

/** @param {object} ctx reactor 上下文 */
function run(ctx) {
  ctxRef = ctx;
  lastPlan = null;
  lastText = '';
  idleStep = 0;
  stall = 0;
  anchorTs = 0;
  log.info('started.');
  cycle.kick();
}

/**
 * 面板状态文案：额度类统一「已完成 x/y」口径（core/daily-stats.dailyText 收口），
 * 分子 = 服务端已买够数的项 + 被限购天花板压住的项（今日都无需再动）。
 * @returns {string}
 */
function statusText() {
  var plan = lastPlan;
  if (!plan) return '等待检测';
  if (!plan.items) return '购物车为空';
  var settled = plan.done + plan.capped;
  if (settled >= plan.items) return '今日已完成';
  var text = dailyText(settled, plan.items);
  if (plan.pending) text += '，' + plan.pending + ' 项等余额';
  if (plan.skipped) text += '（' + plan.skipped + ' 项不代兑）';
  return text;
}

reactor.register({
  id: 'shoppingCart',
  label: '购物车每日一键兑换',
  storageKey: 'pocketcc.feat.shoppingCart',
  symbols: ['dataCenter'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_cartInfo',
      type: 'text',
      label: '今日',
      get: statusText,
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
});

export { cycleRun, planShoppingCart, install as installForTest, statusText };
/** 单测专用：复位在飞态与择时状态（本 feat 已无落盘台账）。 */
export function resetForTest() {
  lastPlan = null;
  lastText = '';
  idleStep = 0;
  stall = 0;
  anchorTs = 0;
}
