/** @type {number} 金融中心购物车查询（SHOPPING_CAR_INFO，legacy PB） */
export const CMD_SHOPPING_CAR_INFO = 4204;

/**
 * 道具商店 tab（FinancialCenterTabType.ITEM_SHOP=2，配置表 SHOP）：货架要么不限购（玫瑰/麦克风），
 * 要么每日限购极大（图纸 1000 次），只有金币是 20 次 —— 限购量级混杂，不能用数量判据，
 * 只能按商店归属把整店视为「搭车项」：可买，但不足以单独触发一次 4203。
 * @type {number}
 */
export const SHOP_TYPE_ITEM = 2;

/** @type {number} 金融中心购物车一键兑换（SHOPPING_CAR_BUY，legacy PB） */
export const CMD_SHOPPING_CAR_BUY = 4203;
