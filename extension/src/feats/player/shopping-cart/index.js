/**
 * 金融中心购物车每日一键兑换（默认关闭，单链、只读查询 + 4203 写入）。
 *
 * 协议（官方公开 H5 源码 subpack2.5c3c4.js 实证）：
 *   4204 SHOPPING_CAR_INFO，NET.sendPB，{header:{}} →
 *     pbAck.shoppingCarInfo.singleShopData[]，每项 {shopType,productPurchasedData[]}；
 *     明细含 productId/purchasedBuyNum/chooseNum。
 *   4203 SHOPPING_CAR_BUY，NET.sendPB，
 *     {header:{},shoppingCarBuy:{shopData:[{shopType,productData:[{productId,buyNum}]}]}} →
 *     pbAck.shoppingCarBuy.shopPurchasedInfo.singleShopData[] + reward。
 *
 * 规划口径与游戏 ShoppingCollectTools.openOneClickBuyPanel 一致：限购余量、chooseNum、货币余额
 * 按序扣减；ACL 只读投影配置和货币，无法可靠定价的联盟动态商品 fail-closed 跳过。
 *
 * 触发与日戳语义（与游戏「一键购买全量购物车」不同）：
 *   道具商店（shopType=2）不限购/千次限购货架（玫瑰等）只作搭车项，必须有至少一个驱动项
 *   同时买得起才发 4203；只有搭车项可买时不发包、不落日戳、15 分钟后重看。
 *   每项每天最多成交一批（当日台账 `shopType:productId`），因此当日余额增长后的补买轮次
 *   不会把玫瑰等无界商品重复带上；首轮买不起的驱动项会在后续巡检中补买。
 *   日戳只在「今日无待购驱动项」时落：空车、驱动项全部成交/达限购；仅剩未成交搭车项也视为
 *   今天不可能再触发。台账按 UID 隔离并带 resetTs，跨日自动作废。
 *
 * 合规：不 OpenUI、不调用游戏 Update、不涉及任何真钱/充值分支；全程 base/world 常态本服可运行。
 */
import { CODE_NOT_SENT } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';
import { CMD_SHOPPING_CAR_INFO, CMD_SHOPPING_CAR_BUY } from './constants.js';
import { planShoppingCart } from './plan.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('SHOPPING-CART');

/** @type {number} 数据未就绪/等待余额/业务拒绝后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 瞬态未发出/空成功应答的短重试（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {number} 成交后的同轮复检间隔（毫秒）：回读 4204 判断是否还有待补驱动项 */
const AFTER_BUY_RECHECK_MS = 1000 * 5;
/** @type {number} 睡过服务器 0 点后的缓冲（毫秒） */
const DAILY_ANCHOR_BUFFER_MS = 1000 * 60;
/** @type {string} UID 命名空间内的当日台账键（resetTs + 已成交项） */
const DAY_KEY = 'shoppingCart.day';
/** @type {string} 旧版「今日已解决」日戳键（升级当日只读兼容，避免重复兑换） */
const LEGACY_STAMP_KEY = 'shoppingCart.resolved';

/** @type {object|null} 网络底座 */
var net;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 台账归属的下一日界绝对秒；now >= 它即整份作废 */
var ledgerResetTs = 0;
/** @type {boolean} 今日无待购驱动项，睡到次日 */
var dayDone = false;
/** @type {Object<string, 1>} 今日已成交商品键 */
var soldMap = Object.create(null);
/** @type {Set<string>} soldMap 的集合视图（规划器入参） */
var soldSet = new Set();
/** @type {object|null} 最近一轮规划结果（只用于面板状态文案） */
var lastPlan = null;
/** @type {Promise<void>|null} 首拍台账回读 */
var stateLoad = null;

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
 * 4203 的成功凭证必须是实际购买明细或实际奖励项；空对象/空数组不算。
 * @param {*} bought pbAck.shoppingCarBuy
 * @returns {boolean}
 */
function hasBuyReceipt(bought) {
  var info = bought && bought.shopPurchasedInfo;
  var groups = info && info.singleShopData;
  if (Array.isArray(groups)) {
    for (var i = 0; i < groups.length; i++) {
      var products = groups[i] && groups[i].productPurchasedData;
      if (!Array.isArray(products)) continue;
      for (var j = 0; j < products.length; j++) {
        var p = products[j];
        if (p && p.productId != null && Number(p.purchasedBuyNum) > 0) return true;
      }
    }
  }
  var items = bought && bought.reward && bought.reward.items;
  if (!Array.isArray(items)) return false;
  for (var k = 0; k < items.length; k++) {
    var item = items[k];
    if (!item || (item.id == null && item.itemId == null)) continue;
    var count = item.num != null ? item.num : item.itemCount != null ? item.itemCount : item.count;
    if (count == null || Number(count) > 0) return true;
  }
  return false;
}

/**
 * 睡到下一日界 + 缓冲；无日界时安全巡检。
 * @param {number} untilTs 下一日界绝对秒
 * @returns {number} 毫秒
 */
function sleepToTs(untilTs) {
  if (!untilTs) return IDLE_TICK_MS;
  var left = (untilTs - gameData.serverTime()) * 1000 + DAILY_ANCHOR_BUFFER_MS;
  return Math.max(left, IDLE_TICK_MS);
}

/**
 * 落盘当日台账；写失败不影响内存当拍语义。
 * @returns {Promise<void>}
 */
function persistLedger() {
  var sold = Object.assign({}, soldMap);
  return storage.data
    .set(DAY_KEY, { resetTs: ledgerResetTs, done: dayDone, sold: sold })
    .catch(function () {
      log.warn('shopping-cart ledger persist failed; memory suppression remains.');
    });
}

/**
 * 把本批商品登记为今日已成交。
 * @param {Array<{key: string}>} entries 请求里实际包含的商品
 * @param {number} resetTs 发包前锚定的下一日界
 */
function markSold(entries, resetTs) {
  ledgerResetTs = resetTs;
  for (var i = 0; i < entries.length; i++) {
    soldMap[entries[i].key] = 1;
    soldSet.add(entries[i].key);
  }
  persistLedger();
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 只登记搭车项：4203 成功但回执无明细，或请求已上线但业务拒绝时，钻石货架不再重试，
 * 驱动项留给下一轮 4204 用服务端 purchasedBuyNum 复核。
 * @param {Array<{key: string, rider: boolean}>} entries 规划条目
 * @param {number} resetTs 发包前锚定的下一日界
 */
function markRiders(entries, resetTs) {
  var riders = [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].rider) riders.push(entries[i]);
  }
  if (riders.length) markSold(riders, resetTs);
}

/**
 * 今日无待购驱动项：落「今日已解决」并睡到次日。
 * @param {number} next 下一日界绝对秒
 */
function finishDay(next) {
  ledgerResetTs = next;
  dayDone = true;
  persistLedger();
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 跨日作废台账（内存态）；盘上旧数据由 resetTs 自然过期。
 */
function resetDay() {
  ledgerResetTs = 0;
  dayDone = false;
  soldMap = Object.create(null);
  soldSet.clear();
  lastPlan = null;
}

/**
 * 回读当日台账；跨日自动作废。旧版日戳只表示「今天已处理」，升级当日不再重兑。
 * @returns {Promise<void>}
 */
function loadState() {
  return Promise.all([storage.data.get(DAY_KEY), storage.data.get(LEGACY_STAMP_KEY)])
    .then(function (vals) {
      var day = vals[0] || null;
      var now = gameData.serverTime();
      var resetTs = Number(day && day.resetTs) || 0;
      if (resetTs > 0 && now > 0 && now < resetTs) {
        ledgerResetTs = resetTs;
        dayDone = !!day.done;
        var sold = day.sold && typeof day.sold === 'object' ? day.sold : null;
        if (sold) {
          for (var key in sold) {
            if (!sold[key]) continue;
            soldMap[key] = 1;
            soldSet.add(key);
          }
        }
        bus.emit(EVT.UI_REFRESH);
        log.debug(
          'restored shopping-cart day ledger (%d sold), resetTs=%d.',
          soldSet.size,
          resetTs,
        );
        return;
      }
      var legacy = vals[1] || null;
      var legacyTs = Number(legacy && legacy.resetTs) || 0;
      if (legacyTs > 0 && now > 0 && now < legacyTs) {
        ledgerResetTs = legacyTs;
        dayDone = true;
        bus.emit(EVT.UI_REFRESH);
        log.debug('legacy day-stamp honored for upgrade day, resetTs=%d.', legacyTs);
      }
    })
    .catch(function () {
      log.warn('shopping-cart ledger load failed; query server on this round.');
    });
}

/** cycle 单轮：读台账 → 4204 → 规划（驱动/搭车）→ 4203 → 明确成功只记本批，不落日戳。 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (stateLoad) await stateLoad;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  var next = gameData.nextDailyResetTs(now);
  if (!now || !next) {
    log.debug('shopping-cart idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  if (ledgerResetTs && now >= ledgerResetTs) resetDay();
  if (dayDone && ledgerResetTs) return sleepToTs(ledgerResetTs);
  if (!net) {
    log.warn('shopping-cart skipped: network base unavailable.');
    return IDLE_TICK_MS;
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
    var code = query ? query.code : CODE_NOT_SENT;
    if (code === CODE_NOT_SENT) {
      log.warn('cmd 4204 transient not-sent/in-flight (code=%s), retry soon.', code);
      return TRANSIENT_RETRY_MS;
    }
    log.info('cmd 4204 query rejected, retry later. code=%s reason=%s', code, query.reason || '-');
    return IDLE_TICK_MS;
  }
  var ack = query.data && query.data.shoppingCarInfo;
  var cart = ack ? gameData.shoppingCart(ack.singleShopData) : null;
  if (!cart) {
    log.warn('cmd 4204 malformed ack or cart projection unavailable; no buy sent.');
    return IDLE_TICK_MS;
  }
  var plan = planShoppingCart(cart, { sold: soldSet });
  lastPlan = plan;
  if (plan.skipped) {
    for (var si = 0; si < cart.skipped.length; si++) {
      var skip = cart.skipped[si];
      log.debug(
        'shopping-cart item skipped: shopType=%s productId=%s reason=%s.',
        skip.shopType,
        skip.productId,
        skip.reason,
      );
    }
  }
  if (!plan.shopData.length) {
    if (!cart.items.length) {
      log.debug('shopping-cart empty on server; mark today resolved.');
      finishDay(next);
      return sleepToTs(next);
    }
    if (plan.driverSeen > 0 && plan.driverPending === 0) {
      log.debug(
        'shopping-cart drivers all sold/limit-exhausted (sold=%d exhausted=%d); mark today resolved.',
        plan.sold,
        plan.exhausted,
      );
      finishDay(next);
      return sleepToTs(next);
    }
    if (plan.driverSeen === 0) {
      log.debug(
        'shopping-cart only rider (shopType=2/unbounded) items in cart; wait for cart changes.',
      );
      return IDLE_TICK_MS;
    }
    log.debug(
      'shopping-cart no affordable driver: exhausted=%d insufficient=%d pending=%d sold=%d; retry later.',
      plan.exhausted,
      plan.insufficient,
      plan.driverPending,
      plan.sold,
    );
    return IDLE_TICK_MS;
  }
  if (!plan.trigger) {
    log.debug(
      'shopping-cart only riders affordable (%d); not enough to trigger a buy.',
      plan.riders,
    );
    return IDLE_TICK_MS;
  }

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
  var buyCode = buy ? buy.code : CODE_NOT_SENT;
  // 成交/尝试记录跨 pause 也要保存，避免恢复后重兑；随后由 alive 决定是否继续调度。
  if (buy && buy.ok) {
    var bought = buy.data && buy.data.shoppingCarBuy;
    var confirmed = hasBuyReceipt(bought);
    // 跨午夜旧回执不能压制新一天：仅当发包前锚点仍等于当前下一日界才落账。
    if (gameData.nextDailyResetTs(gameData.serverTime()) !== next) {
      log.debug('shopping-cart buy confirmed after midnight; old day ledger discarded.');
      return 1000;
    }
    if (confirmed) {
      markSold(plan.entries, next);
      log.info(
        'shopping-cart exchange confirmed: drivers=%d riders=%d; continue same-day replan.',
        plan.drivers,
        plan.riders,
      );
      return aliveFn() ? AFTER_BUY_RECHECK_MS : 0;
    }
    // 空壳成功：搭车项保守记今日已尝试（钻石货架不重复买），驱动项留待 4204 复核。
    markRiders(plan.entries, next);
    log.warn('cmd 4203 ok but no actual purchased detail/reward; riders held, re-query soon.');
    return aliveFn() ? TRANSIENT_RETRY_MS : 0;
  }
  if (buyCode !== CODE_NOT_SENT) {
    // 业务拒绝 = 什么都没买：搭车项也不记账，余额/时序变化后仍可补买。
    log.info(
      'cmd 4203 buy rejected; no marks. code=%s reason=%s',
      buyCode,
      (buy && buy.reason) || '-',
    );
    return aliveFn() ? IDLE_TICK_MS : 0;
  }
  log.warn('cmd 4203 transient not-sent/in-flight/unknown; re-query before any retry.');
  return aliveFn() ? TRANSIENT_RETRY_MS : 0;
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
  resetDay();
  stateLoad = loadState();
  log.info('started.');
  cycle.kick();
}

/**
 * 面板状态文案：今日已兑换 / 已兑换 N 项 / 仅有道具商店商品 / 等待兑换。
 * @returns {string}
 */
function statusText() {
  var now = gameData.serverTime();
  if (dayDone && ledgerResetTs > 0 && now > 0 && now < ledgerResetTs) return '今日已兑换';
  if (soldSet.size > 0) return '已兑换 ' + soldSet.size + ' 项，等待补买';
  if (lastPlan && lastPlan.items > 0 && lastPlan.driverSeen === 0) return '仅有道具商店商品';
  return '等待兑换';
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

export { cycleRun, planShoppingCart, install as installForTest };
/** 单测专用：复位在飞态与台账，不 kick cycle。 */
export function resetForTest() {
  resetDay();
  stateLoad = null;
}
/** 单测专用：发起台账回读。 */
export function loadStateForTest() {
  stateLoad = loadState();
  return stateLoad;
}
