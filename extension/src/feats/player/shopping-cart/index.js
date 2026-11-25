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
 * 均按游戏遍历顺序扣减；ACL 只读投影配置和货币，无法可靠定价的联盟动态商品 fail-closed 跳过。
 * 4203 成功但应答未明确携带 purchased 明细或 reward 时不落「今日已解决」日戳，下一轮重新查询，
 * 避免空应答假成功（悬赏领取同款事故的跨玩法防线）。真业务拒绝不落日戳，15 分钟后再读；
 * 货币不足同样不睡整天，等资源变化。空车/全部达限购才落 UID 隔离日戳到次日。
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

/** @type {number} 数据未就绪/货币不足/业务拒绝后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 瞬态未发出/空成功应答的短重试（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {number} 睡过服务器 0 点后的缓冲（毫秒） */
const DAILY_ANCHOR_BUFFER_MS = 1000 * 60;
/** @type {string} UID 命名空间内的每日已解决日戳键 */
const STAMP_KEY = 'shoppingCart.resolved';

/** @type {object|null} 网络底座 */
var net;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 今日已解决对应的下一日界绝对秒 */
var resolvedResetTs = 0;
/** @type {Promise<void>|null} 首拍日戳回读 */
var stampLoad = null;

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
        bus.emit(EVT.UI_REFRESH);
        log.debug('restored shopping-cart day-stamp, resetTs=%d.', ts);
      }
    })
    .catch(function () {
      log.warn('shopping-cart stamp load failed; query server on this round.');
    });
}

/**
 * 落今日已解决日戳；写失败不影响内存当拍抑制。
 * @param {number} resetTs 发包前锚定的下一日界
 */
function saveStamp(resetTs) {
  resolvedResetTs = resetTs;
  storage.data.set(STAMP_KEY, { resetTs: resetTs }).catch(function () {
    log.warn('shopping-cart stamp persist failed; memory suppression remains.');
  });
  bus.emit(EVT.UI_REFRESH);
}

/** cycle 单轮：读日戳 → 4204 → 规划 → 4203 → 明确成功才落日戳。 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (stampLoad) await stampLoad;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  var next = gameData.nextDailyResetTs(now);
  if (!now || !next) {
    log.debug('shopping-cart idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  if (resolvedResetTs && now < resolvedResetTs) return sleepToTs(resolvedResetTs);
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
  var plan = planShoppingCart(cart);
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
    if (!cart.items.length && !plan.skipped) {
      log.debug('shopping-cart empty on server; mark today resolved.');
      saveStamp(next);
      return sleepToTs(next);
    }
    if (cart.items.length && plan.exhausted === cart.items.length && !plan.skipped) {
      log.debug('shopping-cart all items exhausted by purchase limits; mark today resolved.');
      saveStamp(next);
      return sleepToTs(next);
    }
    log.debug(
      'shopping-cart no affordable item: exhausted=%d insufficient=%d skipped=%d; retry later.',
      plan.exhausted,
      plan.insufficient,
      plan.skipped,
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
  // 成功回执跨 pause 也要保存，避免恢复后重兑；随后由 alive 决定是否继续调度。
  if (buy && buy.ok) {
    var bought = buy.data && buy.data.shoppingCarBuy;
    var confirmed = hasBuyReceipt(bought);
    if (confirmed) {
      // 跨午夜旧回执不能压制新一天：仅当发包前锚点仍等于当前下一日界才落盘。
      if (gameData.nextDailyResetTs(gameData.serverTime()) === next) {
        saveStamp(next);
        log.info('shopping-cart one-click exchange confirmed (%d product(s)).', plan.affordable);
      } else {
        log.debug('shopping-cart buy confirmed after midnight; old day-stamp discarded.');
        return 1000;
      }
    } else {
      log.warn('cmd 4203 ok but no actual purchased detail/reward item; re-query soon.');
      return aliveFn() ? TRANSIENT_RETRY_MS : 0;
    }
  } else if (buy && buy.code !== CODE_NOT_SENT) {
    log.info('cmd 4203 buy rejected; no day-stamp. code=%s reason=%s', buy.code, buy.reason || '-');
    return aliveFn() ? IDLE_TICK_MS : 0;
  } else {
    log.warn('cmd 4203 transient not-sent/in-flight/unknown; re-query before any retry.');
    return aliveFn() ? TRANSIENT_RETRY_MS : 0;
  }
  if (!aliveFn()) return 0;
  return sleepToTs(next);
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
  resolvedResetTs = 0;
  stampLoad = loadStamp();
  log.info('started.');
  cycle.kick();
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
      get: function () {
        var now = gameData.serverTime();
        return resolvedResetTs > 0 && now > 0 && now < resolvedResetTs ? '今日已兑换' : '等待兑换';
      },
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
});

export { cycleRun, planShoppingCart, install as installForTest };
/** 单测专用：复位在飞态，不 kick cycle。 */
export function resetForTest() {
  resolvedResetTs = 0;
  stampLoad = null;
}
/** 单测专用：发起日戳回读。 */
export function loadStampForTest() {
  stampLoad = loadStamp();
  return stampLoad;
}
