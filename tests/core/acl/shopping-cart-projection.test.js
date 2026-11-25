// 购物车 ACL 只读投影：配置表、货币、限购和 Int64 商品号归一；不调用游戏 init/update。
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
};
const user = {
  Resource: { Gold: 100, BountyMilitary: 20, AdventureCoin: 30, CsbRes: 40, Honor: 50 },
  IslandBattleData: { points: 60 },
  getItemAmount: (id) => ({ 900: 70, 901: 80, 902: 90 })[Number(id)] || 0,
  Buff: { getValueWithBuff: (limit) => Number(limit) + 2 },
};
const rows = {
  SHOP: {
    1001: { price_shop: 10, buy_limit: 5 },
    13: { price_shop: 1, buy_limit: 3 },
  },
  MINING: { 1002: { needItem: '900|7', rewardItem: '1|2', limit: 2, price_shop: 999 } },
  recovery_shop: { 1003: { price_shop: 8, buy_limit: 4 } },
  behemoth_shop: { 1004: { costItemId: 902, costItemNum: 9, timeBuyLimit: 'x,3', buy_limit: 99 } },
  DATACONFIG: { 2181903: { value: '901' } },
};
const tableNames = {};
for (const name of [
  'SHOP',
  'VIP_SHOP',
  'LEGIONSHOP',
  'EXPEDITION_SHOP',
  'ISLAND_SHOP',
  'MINING',
  'csb_shop',
  'recovery_shop',
  'behemoth_shop',
  'DATACONFIG',
])
  tableNames[name] = name;
const modules = {
  DataCenter: { DATA: { UserData: user } },
  TableManager: {
    TABLE: {
      getTableDataById(table, id) {
        return (rows[table] && rows[table][id]) || null;
      },
    },
  },
  TableName: { TableName: tableNames },
  GameDefine: { BuffType: { ShopBuyGold: 88 } },
};
globalThis.__require = (name) => modules[name] || null;
const { gameData } = await import('../../../extension/src/core/acl/game-data.js');

test('购物车投影：普通商品保留字符串 ID、限购、选择数和货币快照', () => {
  const cart = gameData.shoppingCart([
    { shopType: 2, productPurchasedData: [{ productId: 1001, purchasedBuyNum: 1, chooseNum: 4 }] },
  ]);
  assert.deepEqual(cart.items, [
    {
      shopType: 2,
      productId: '1001',
      purchasedBuyNum: 1,
      chooseNum: 4,
      price: 10,
      buyLimit: 5,
      currencyKey: '1:0',
      balance: 100,
    },
  ]);
  assert.deepEqual(cart.skipped, []);
});

test('购物车投影：道具货币、限时限购与 DataConfig 货币 ID 按源码规则解析', () => {
  const cart = gameData.shoppingCart([
    {
      shopType: 7,
      productPurchasedData: [{ productId: '1002', purchasedBuyNum: 0, chooseNum: 5 }],
    },
    {
      shopType: 14,
      productPurchasedData: [{ productId: '1003', purchasedBuyNum: 0, chooseNum: 1 }],
    },
    {
      shopType: 16,
      productPurchasedData: [{ productId: '1004', purchasedBuyNum: 0, chooseNum: 2 }],
    },
  ]);
  assert.deepEqual(
    cart.items.map((x) => [x.productId, x.price, x.buyLimit, x.currencyKey, x.balance]),
    [
      ['1002', 7, 2, '6:900', 70],
      ['1003', 8, 4, '6:901', 80],
      ['1004', 9, 3, '6:902', 90],
    ],
  );
});

test('购物车投影：shopId=13 使用 ShopBuyGold buff 后的限购', () => {
  const cart = gameData.shoppingCart([
    { shopType: 2, productPurchasedData: [{ productId: 13, purchasedBuyNum: 0, chooseNum: 9 }] },
  ]);
  assert.equal(cart.items[0].buyLimit, 5);
});

test('购物车投影：联盟动态定价 fail-closed；缺配置不猜价', () => {
  const cart = gameData.shoppingCart([
    { shopType: 13, productPurchasedData: [{ productId: '9', purchasedBuyNum: 0, chooseNum: 1 }] },
    { shopType: 2, productPurchasedData: [{ productId: '404', purchasedBuyNum: 0, chooseNum: 1 }] },
  ]);
  assert.equal(cart.items.length, 0);
  assert.deepEqual(cart.skipped, [
    { shopType: 13, productId: '9', reason: 'dynamic-alliance-price' },
    { shopType: 2, productId: '404', reason: 'shop-config-missing' },
  ]);
});

test('购物车投影：缺数组返回 null，空数组是可确认空车', () => {
  assert.equal(gameData.shoppingCart(null), null);
  assert.deepEqual(gameData.shoppingCart([]), { items: [], skipped: [] });
});
