/**
 * 购物车一键兑换纯规划器：复刻 ShoppingCollectTools.openOneClickBuyPanel 的数量/限购/余额口径。
 *
 * 唯一购买纪律（不区分商店与商品类型）：调用方维护当日台账，购物车里每一项每天最多成交一批。
 *   - 已成交（sold 命中）或限购余量为 0 的项直接跳过；
 *   - 其余项按购物车原序（与游戏 openOneClickBuyPanel 一致）逐项扣减对应货币，
 *     买得起就进本轮 shopData，买不起计入 pending，留给后续巡检等余额；
 *   - 任一项可买即值得发包；全部项成交或达限购后，调用方落「今日已解决」并睡到次日。
 *
 * @param {{items:Array<object>, skipped?:Array<object>}|null} cart ACL 规划投影
 * @param {{sold?: Set<string>}} [state] 今日已成交键集合（`shopType:productId`）
 * @returns {{
 *   shopData: Array<object>,
 *   entries: string[],
 *   items: number,
 *   sold: number,
 *   exhausted: number,
 *   pending: number,
 *   skipped: number,
 * }} shopData 非空即应发包；entries 是本次请求包含的台账键；pending 为买不起的未成交项数
 */
/**
 * 商品在当日台账里的稳定键。
 * @param {object} item ACL 投影项
 * @returns {string} `shopType:productId`
 */
export function shoppingCartKey(item) {
  return String(item.shopType) + ':' + String(item.productId);
}

/**
 * 按限购/chooseNum/余额规划一轮请求体。
 * @param {{items:Array<object>, skipped?:Array<object>}|null} cart ACL 规划投影
 * @param {{sold?: Set<string>}} [state] 今日已成交键集合
 * @returns {object} 见函数头 JSDoc
 */
export function planShoppingCart(cart, state) {
  var out = {
    shopData: [],
    entries: [],
    items: 0,
    sold: 0,
    exhausted: 0,
    pending: 0,
    skipped: 0,
  };
  if (!cart || !Array.isArray(cart.items)) return out;
  out.items = cart.items.length;
  out.skipped = Array.isArray(cart.skipped) ? cart.skipped.length : 0;
  var sold = state && state.sold instanceof Set ? state.sold : null;
  /** @type {Object<string, number>} 货币池快照；按购物车原序逐项扣减 */
  var balances = Object.create(null);
  /** @type {Map<number,object>} shopType → 请求组，保持首次出现顺序 */
  var groups = new Map();
  for (var i = 0; i < cart.items.length; i++) {
    var item = cart.items[i];
    var key = shoppingCartKey(item);
    if (sold && sold.has(key)) {
      out.sold++;
      continue;
    }
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
    var currency = String(item.currencyKey);
    if (balances[currency] == null) balances[currency] = Number(item.balance) || 0;
    var cost = (Number(item.price) || 0) * qty;
    if (cost > balances[currency]) {
      out.pending++;
      continue;
    }
    balances[currency] -= cost;
    var group = groups.get(Number(item.shopType));
    if (!group) {
      group = { shopType: Number(item.shopType), productData: [] };
      groups.set(group.shopType, group);
      out.shopData.push(group);
    }
    group.productData.push({ productId: String(item.productId), buyNum: qty });
    out.entries.push(key);
  }
  return out;
}
