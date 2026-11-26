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
  Buff: {
    getValueWithBuff: (limit) => Number(limit) + 2,
    // 游戏口径：AllianceShopData.getDiscount = 1e4 × Buff.getBuffPercentValue(BuffType.AllianceDiscount)
    getBuffPercentValue: (type) => (Number(type) === 500 ? 0.1 : 0),
  },
};
const rows = {
  SHOP: {
    1001: { price_shop: 10, buy_limit: 5 },
    13: { price_shop: 1, buy_limit: 3 },
  },
  MINING: { 1002: { needItem: '900|7', rewardItem: '1|2', limit: 2, price_shop: 999 } },
  recovery_shop: { 1003: { price_shop: 8, buy_limit: 4 } },
  behemoth_shop: { 1004: { costItemId: 902, costItemNum: 9, timeBuyLimit: 'x,3', buy_limit: 99 } },
  ALLIANCE_SHOP: {
    2001: { price_shop: 100, buy_limit: 0, timeBuyLimit: '86400,10' },
    2002: { price_shop: 50, buy_limit: 4 },
    2003: { price_shop: 30 },
  },
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
  'ALLIANCE_SHOP',
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
  GameDefine: { BuffType: { ShopBuyGold: 88, AllianceDiscount: 500 } },
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

test('购物车投影：联盟商店走荣誉货币、buff 折扣价与 timeBuyLimit/buy_limit 限购', () => {
  const cart = gameData.shoppingCart([
    {
      shopType: 13,
      productPurchasedData: [
        { productId: '2001', purchasedBuyNum: 4, chooseNum: 10 },
        { productId: '2002', purchasedBuyNum: 0, chooseNum: 2 },
      ],
    },
  ]);
  assert.deepEqual(
    cart.items.map((x) => [x.productId, x.price, x.buyLimit, x.currencyKey, x.balance]),
    [
      ['2001', 90, 10, '7:0', 50], // floor(100 - 100×1000/1e4) = 90，限购取 timeBuyLimit 第二段
      ['2002', 45, 4, '7:0', 50],
    ],
  );
  assert.deepEqual(cart.skipped, []);
});

test('购物车投影：联盟非限购商品不代兑（游戏一键同样不买）', () => {
  const cart = gameData.shoppingCart([
    {
      shopType: 13,
      productPurchasedData: [{ productId: '2003', purchasedBuyNum: 0, chooseNum: 1 }],
    },
  ]);
  assert.equal(cart.items.length, 0);
  assert.deepEqual(cart.skipped, [
    { shopType: 13, productId: '2003', reason: 'alliance-not-limit-commodity' },
  ]);
});

test('购物车投影：联盟折扣读不到则 fail-closed，不按原价误兑', () => {
  const saved = user.Buff.getBuffPercentValue;
  delete user.Buff.getBuffPercentValue;
  try {
    const cart = gameData.shoppingCart([
      {
        shopType: 13,
        productPurchasedData: [{ productId: '2001', purchasedBuyNum: 0, chooseNum: 1 }],
      },
    ]);
    assert.equal(cart.items.length, 0);
    assert.deepEqual(cart.skipped, [
      { shopType: 13, productId: '2001', reason: 'alliance-discount-unavailable' },
    ]);
  } finally {
    user.Buff.getBuffPercentValue = saved;
  }
});

test('购物车投影：缺配置不猜价', () => {
  const cart = gameData.shoppingCart([
    { shopType: 2, productPurchasedData: [{ productId: '404', purchasedBuyNum: 0, chooseNum: 1 }] },
  ]);
  assert.equal(cart.items.length, 0);
  assert.deepEqual(cart.skipped, [
    { shopType: 2, productId: '404', reason: 'shop-config-missing' },
  ]);
});

test('购物车投影：缺数组返回 null，空数组是可确认空车', () => {
  assert.equal(gameData.shoppingCart(null), null);
  assert.deepEqual(gameData.shoppingCart([]), { items: [], skipped: [] });
});
