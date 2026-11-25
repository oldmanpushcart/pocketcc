/**
 * 购物车一键兑换纯规划器：复刻 ShoppingCollectTools.openOneClickBuyPanel 的数量与余额顺序。
 * 输入只能来自 ACL 对 4204 应答的归一；本模块不接触游戏符号，也不发请求。
 * @param {{items:Array<object>, skipped:Array<object>}|null} cart ACL 规划投影
 * @returns {{shopData:Array<object>, affordable:number, insufficient:number, exhausted:number, skipped:number}}
 */
export function planShoppingCart(cart) {
  var out = { shopData: [], affordable: 0, insufficient: 0, exhausted: 0, skipped: 0 };
  if (!cart || !Array.isArray(cart.items)) return out;
  out.skipped = Array.isArray(cart.skipped) ? cart.skipped.length : 0;
  var balances = Object.create(null);
  /** @type {Map<number,object>} shopType → 请求组，保持首次出现顺序 */
  var groups = new Map();
  for (var i = 0; i < cart.items.length; i++) {
    var item = cart.items[i];
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
    out.affordable++;
  }
  return out;
}
