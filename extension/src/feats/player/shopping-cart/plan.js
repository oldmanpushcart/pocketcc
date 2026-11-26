/**
 * 购物车一键兑换纯规划器：复刻 ShoppingCollectTools.openOneClickBuyPanel 的数量/限购/余额口径，
 * 但触发语义不同——本玩法要求本轮至少有一个「驱动项」买得起才发 4203。
 *
 * 驱动项 vs 搭车项：
 * - 搭车项 = 道具商店（SHOP_TYPE_ITEM=2）或 buyLimit=-1 的商品。真机截图实证（2026-11-26 道具商店货架）：
 *   同店混着不限购（玫瑰、麦克风）、每日 1000 次（图纸）与 20 次（金币）三种量级，
 *   数量判据不可用；整店按「不稀缺」处理，只随驱动项同批购买，不足以单独触发。
 * - 驱动项 = 其余商品（军级商店周刷新 1~数次、军团/冒险/CSB/海岛/道具币等有限购货架）。
 *
 * 其他有意取舍：
 * - 扣减顺序：先驱动项、后搭车项（各自保持购物车原序），避免搭车项抢占同货币额度把驱动项挤成买不起。
 *   游戏的 openOneClickBuyPanel 严格按购物车遍历顺序扣减，这里刻意偏离。
 * - sold：调用方按日界维护的「今日已成交」键集合；命中即排除，保证每项每天最多成交一批，
 *   避免当日余额增长后的补买轮次把无界商品重复带上。
 * - 买不起的驱动项计入 driverPending，调用方据此决定「继续巡检等余额」而不是落日戳。
 *
 * @param {{items:Array<object>, skipped?:Array<object>}|null} cart ACL 规划投影
 * @param {{sold?: Set<string>}} [state] 今日已成交键集合（`shopType:productId`）
 * @returns {{
 *   shopData: Array<object>,
 *   affordable: number,
 *   drivers: number,
 *   riders: number,
 *   trigger: boolean,
 *   items: number,
 *   driverSeen: number,
 *   driverPending: number,
 *   insufficient: number,
 *   exhausted: number,
 *   sold: number,
 *   skipped: number,
 *   entries: Array<{key: string, rider: boolean}>,
 * }} shopData 保持「驱动组在前、搭车组在后」的分组序；trigger=本轮是否存在可买驱动项；
 *    entries 是本次写请求将包含的商品键（成交/尝试台账用）
 */
import { SHOP_TYPE_ITEM } from './constants.js';

/**
 * 商品在当日台账里的稳定键。
 * @param {object} item ACL 投影项
 * @returns {string} `shopType:productId`
 */
export function shoppingCartKey(item) {
  return String(item.shopType) + ':' + String(item.productId);
}

/**
 * 搭车项判定：道具商店整店 + 任何商店的无界（buyLimit=-1）商品。
 * @param {object} item ACL 投影项
 * @returns {boolean}
 */
function isRider(item) {
  return Number(item.shopType) === SHOP_TYPE_ITEM || Number(item.buyLimit) === -1;
}

/**
 * @typedef {{item: object, rider: boolean}} PlannedEntry
 */

/**
 * 按限购/chooseNum/余额规划一轮请求体。
 * @param {{items:Array<object>, skipped?:Array<object>}|null} cart ACL 规划投影
 * @param {{sold?: Set<string>}} [state] 今日已成交键集合
 * @returns {object} 见函数头 JSDoc
 */
export function planShoppingCart(cart, state) {
  var out = {
    shopData: [],
    affordable: 0,
    drivers: 0,
    riders: 0,
    trigger: false,
    items: 0,
    driverSeen: 0,
    driverPending: 0,
    insufficient: 0,
    exhausted: 0,
    sold: 0,
    skipped: 0,
    entries: [],
  };
  if (!cart || !Array.isArray(cart.items)) return out;
  out.items = cart.items.length;
  out.skipped = Array.isArray(cart.skipped) ? cart.skipped.length : 0;
  var sold = state && state.sold instanceof Set ? state.sold : null;
  /** @type {Object<string, number>} 货币池快照；先驱动后搭车按序扣减 */
  var balances = Object.create(null);
  /** @type {Map<number,object>} shopType → 请求组，保持首次出现顺序 */
  var groups = new Map();
  /** @type {PlannedEntry[]} 驱动项桶 */
  var drivers = [];
  /** @type {PlannedEntry[]} 搭车项桶 */
  var riders = [];
  for (var i = 0; i < cart.items.length; i++) {
    var entry = cart.items[i];
    var rider = isRider(entry);
    if (!rider) out.driverSeen++;
    if (sold && sold.has(shoppingCartKey(entry))) {
      out.sold++;
      continue;
    }
    (rider ? riders : drivers).push({ item: entry, rider: rider });
  }
  var buckets = [drivers, riders];
  for (var b = 0; b < buckets.length; b++) {
    var bucket = buckets[b];
    for (var k = 0; k < bucket.length; k++) {
      var item = bucket[k].item;
      var limit = Number(item.buyLimit);
      var remaining =
        limit === -1
          ? Number.MAX_SAFE_INTEGER
          : Math.max(0, limit - Number(item.purchasedBuyNum) || 0);
      var qty = Math.min(remaining, Math.max(0, Number(item.chooseNum) || 0));
      if (!(qty > 0)) {
        out.exhausted++;
        continue;
      }
      var key = String(item.currencyKey);
      if (balances[key] == null) balances[key] = Number(item.balance) || 0;
      var cost = (Number(item.price) || 0) * qty;
      if (cost > balances[key]) {
        out.insufficient++;
        if (!bucket[k].rider) out.driverPending++;
        continue;
      }
      balances[key] -= cost;
      var group = groups.get(Number(item.shopType));
      if (!group) {
        group = { shopType: Number(item.shopType), productData: [] };
        groups.set(group.shopType, group);
        out.shopData.push(group);
      }
      group.productData.push({ productId: String(item.productId), buyNum: qty });
      out.entries.push({ key: shoppingCartKey(item), rider: bucket[k].rider });
      out.affordable++;
      if (bucket[k].rider) out.riders++;
      else out.drivers++;
    }
  }
  out.trigger = out.drivers > 0;
  return out;
}
