/**
 * 购物车一键兑换纯规划器：应买 = chooseNum（购物车勾选数量），已买 = purchasedBuyNum
 * （服务端在限购周期内的已购计数，日刷新项 0 点归零、周刷新项随周一日界归零）。
 *
 * 逐项两级上限（与游戏 ShoppingCollectTools.openOneClickBuyPanel、AllianceShopItemData 同源）：
 *   gap  = chooseNum − purchasedBuyNum                        还欠几个（唯一收敛判据）
 *   cap  = buy_limit === -1 ? ∞ : buy_limit − purchasedBuyNum  商店限购天花板
 *   want = min(gap, cap)
 *   buy_limit 的其他负数（联盟店非限购商品回 -99）= 游戏一键同样不买，归 capped。
 *
 * 余额按购物车原序逐件扣减，**能买几个买几个**（4203 的 buyNum 允许任意数量，支持部分购买）：
 *   qty = min(want, floor(余额 / price))；买得起整件自然就是整件，等价游戏一键那件商品的 getBuyMaxCount。
 *   同一货币池按原序共享，前序项买剩的零头仍可由后序低价项捡走；一件都买不起才计 pending（欠着，等余额增长）。
 *   成交只增 purchasedBuyNum，gap 单调下降 → 无限购项也必然收敛，调用方无需本地当日台账。
 *
 * @param {{items:Array<object>, skipped?:Array<object>}|null} cart ACL 规划投影
 * @returns {{
 *   shopData: Array<object>,
 *   entries: string[],
 *   items: number,
 *   done: number,
 *   capped: number,
 *   pending: number,
 *   skipped: number,
 *   planned: number,
 *   partial: number,
 * }} shopData 非空即应发包；entries 为本次涉及的台账键；done=已买齐；capped=天花板压住；
 *     pending=仍欠但本轮分不到余额；planned=本轮项数；partial=其中按余额减量的项数
 */
export function shoppingCartKey(item) {
  return String(item.shopType) + ':' + String(item.productId);
}

/**
 * 按「应买−已买」差值、限购天花板与余额规划一轮请求体。
 * @param {{items:Array<object>, skipped?:Array<object>}|null} cart ACL 规划投影
 * @returns {object} 见函数头 JSDoc
 */
export function planShoppingCart(cart) {
  var out = {
    shopData: [],
    entries: [],
    items: 0,
    done: 0,
    capped: 0,
    pending: 0,
    skipped: 0,
    planned: 0,
    partial: 0,
  };
  if (!cart || !Array.isArray(cart.items)) return out;
  out.items = cart.items.length;
  out.skipped = Array.isArray(cart.skipped) ? cart.skipped.length : 0;
  /** @type {Object<string,number>} 货币池快照；按购物车原序消耗 */
  var balances = Object.create(null);
  /** @type {Map<number,object>} shopType → 请求组，保持购物车首次出现顺序 */
  var groups = new Map();
  for (var i = 0; i < cart.items.length; i++) {
    var item = cart.items[i];
    var bought = Number(item.purchasedBuyNum) || 0;
    var gap = (Number(item.chooseNum) || 0) - bought;
    if (gap <= 0) {
      out.done++;
      continue;
    }
    var limit = Number(item.buyLimit);
    if (!Number.isFinite(limit) || limit < -1) {
      out.capped++;
      continue;
    }
    var want = limit === -1 ? gap : Math.min(gap, limit - bought);
    if (!(want > 0)) {
      out.capped++;
      continue;
    }
    var pool = String(item.currencyKey);
    if (balances[pool] == null) balances[pool] = Number(item.balance) || 0;
    var price = Number(item.price) || 0;
    var qty = Math.min(want, price > 0 ? Math.floor(balances[pool] / price) : want);
    if (!(qty > 0)) {
      out.pending++;
      continue;
    }
    if (qty < want) out.partial++;
    balances[pool] -= price * qty;
    var shopType = Number(item.shopType);
    var group = groups.get(shopType);
    if (!group) {
      group = { shopType: shopType, productData: [] };
      groups.set(shopType, group);
      out.shopData.push(group);
    }
    group.productData.push({ productId: String(item.productId), buyNum: qty });
    out.entries.push(shoppingCartKey(item));
    out.planned++;
  }
  return out;
}
