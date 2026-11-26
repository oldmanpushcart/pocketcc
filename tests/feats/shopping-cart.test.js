// 金融中心购物车一键兑换离线回归：4204 查询 → 驱动/搭车规划 → 4203 → 当日台账（不落日戳）。
// 不连接游戏服务器；ACL 配置投影以注入归一数据替代，协议外层形态逐键锁定。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
  document: {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.chrome = globalThis.chrome || {
  runtime: { id: 'test', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { gameData } = await import('../../extension/src/core/game-api.js');
const { storage } = await import('../../extension/src/core/storage.js');
const { MENU, collectFeatureIds } = await import('../../extension/src/core/menu.js');
const { reactor } = await import('../../extension/src/core/reactor.js');
const cartFeat = await import('../../extension/src/feats/player/shopping-cart/index.js');
const { planShoppingCart } = await import('../../extension/src/feats/player/shopping-cart/plan.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const orig = {
  serverTime: gameData.serverTime,
  nextDailyResetTs: gameData.nextDailyResetTs,
  shoppingCart: gameData.shoppingCart,
  dataGet: storage.data.get,
  dataSet: storage.data.set,
};
const NOW = 1794585900; // 2026-11-14 00:05 UTC+8
const DAY_KEY = 'shoppingCart.day';
const LEGACY_KEY = 'shoppingCart.resolved';
let now;
let sent;
let respond;
let stored;
let alive;
let abortRound;
let normalized;

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  return t ? t - ((t - 57600) % 86400) + 86400 : 0;
}
/** 默认驱动项：军级商店（shopType=3）周刷新，不属于道具商店。 */
function item(over) {
  return Object.assign(
    {
      shopType: 3,
      productId: '1001',
      purchasedBuyNum: 0,
      chooseNum: 3,
      price: 10,
      buyLimit: 5,
      currencyKey: '1:0',
      balance: 100,
    },
    over,
  );
}
/** 道具商店（shopType=2）无限购货架，典型如玫瑰。 */
function rider(over) {
  return item({ shopType: 2, productId: 'rose', buyLimit: -1, chooseNum: 1, ...over });
}
function okCart(items, skipped) {
  return { ok: true, code: 0, data: { shoppingCarInfo: { singleShopData: { items, skipped } } } };
}
function okBuy(shopType, productId) {
  return {
    ok: true,
    code: 0,
    data: {
      shoppingCarBuy: {
        shopPurchasedInfo: {
          singleShopData: [{ shopType, productPurchasedData: [{ productId, purchasedBuyNum: 3 }] }],
        },
        reward: { items: [] },
      },
    },
  };
}
const fakeNet = {
  install: () => true,
  sendGuarded: async (cmd, data, opts) => {
    sent.push({ cmd, data, protocol: opts.protocol });
    return respond(cmd, data);
  },
};
const fakeCtx = { alive: () => alive, net: fakeNet, signal: new AbortController().signal };
cartFeat.installForTest(fakeCtx);

beforeEach(() => {
  now = NOW;
  sent = [];
  stored = new Map();
  alive = true;
  abortRound = new AbortController();
  fakeCtx.signal = abortRound.signal;
  normalized = { items: [item()], skipped: [] };
  gameData.serverTime = () => now;
  gameData.nextDailyResetTs = nextReset;
  gameData.shoppingCart = () => normalized;
  storage.data.get = async (key) => stored.get(key);
  storage.data.set = async (key, value) => stored.set(key, value);
  respond = (cmd) =>
    cmd === 4204 ? okCart(normalized.items, normalized.skipped) : okBuy(3, '1001');
  cartFeat.resetForTest();
});

afterEach(() => {
  Object.assign(gameData, {
    serverTime: orig.serverTime,
    nextDailyResetTs: orig.nextDailyResetTs,
    shoppingCart: orig.shoppingCart,
  });
  storage.data.get = orig.dataGet;
  storage.data.set = orig.dataSet;
});

// ---------- 纯规划 ----------

test('纯规划：道具商店整店 + 无界商品都是搭车项，不单独触发', () => {
  const onlyShop2 = planShoppingCart({
    items: [item({ shopType: 2, productId: 'a', buyLimit: 5 })],
    skipped: [],
  });
  assert.equal(onlyShop2.riders, 1);
  assert.equal(onlyShop2.trigger, false);
  assert.equal(onlyShop2.driverSeen, 0);

  const onlyUnbounded = planShoppingCart({
    items: [item({ shopType: 3, productId: 'b', buyLimit: -1 })],
    skipped: [],
  });
  assert.equal(onlyUnbounded.riders, 1);
  assert.equal(onlyUnbounded.trigger, false);
  assert.equal(onlyUnbounded.driverSeen, 0);
});

test('纯规划：驱动项 + 搭车项同批，驱动组在前；搭车项不抢同货币额度', () => {
  const plan = planShoppingCart({
    items: [
      rider({ chooseNum: 5, price: 10, balance: 60 }),
      item({ shopType: 3, productId: 'vip', chooseNum: 3, price: 10, balance: 60 }),
    ],
    skipped: [],
  });
  // 先驱动后搭车：驱动花掉 30 后只剩 30，玫瑰 50 买不起；若按购物车原序则恰好相反
  assert.deepEqual(plan.shopData, [
    { shopType: 3, productData: [{ productId: 'vip', buyNum: 3 }] },
  ]);
  assert.equal(plan.drivers, 1);
  assert.equal(plan.riders, 0);
  assert.equal(plan.driverPending, 0);
  assert.equal(plan.insufficient, 1);
  assert.equal(plan.trigger, true);
});

test('纯规划：限购余量、chooseNum 与逐项余额扣减', () => {
  const plan = planShoppingCart({
    items: [
      item({ productId: '1', shopType: 3, chooseNum: 9, purchasedBuyNum: 2, buyLimit: 5 }),
      item({ productId: '2', shopType: 5, chooseNum: 2, currencyKey: '3:0', balance: 50 }),
      item({
        productId: '3',
        shopType: 5,
        chooseNum: 3,
        currencyKey: '3:0',
        balance: 50,
        price: 15,
      }),
    ],
    skipped: [],
  });
  assert.deepEqual(plan.shopData, [
    { shopType: 3, productData: [{ productId: '1', buyNum: 3 }] },
    { shopType: 5, productData: [{ productId: '2', buyNum: 2 }] },
  ]);
  assert.equal(plan.drivers, 2);
  assert.equal(plan.insufficient, 1);
});

test('纯规划：今日已成交项排除，但仍计入 driverSeen 供日戳判定', () => {
  const plan = planShoppingCart(
    { items: [item({ productId: 'a' })], skipped: [] },
    { sold: new Set(['3:a']) },
  );
  assert.deepEqual(plan.shopData, []);
  assert.equal(plan.sold, 1);
  assert.equal(plan.driverSeen, 1);
  assert.equal(plan.driverPending, 0);
});

test('面板集成：功能已注册、挂入玩家基础设置且默认关闭、配置仍只有 enabled', () => {
  assert.ok(collectFeatureIds({ children: MENU }).includes('shoppingCart'));
  const spec = reactor.list().find((s) => s.id === 'shoppingCart');
  assert.ok(spec);
  assert.equal(spec.defaults.enabled, false);
  assert.deepEqual(spec.toModuleCfg({ enabled: true }), { enabled: true });
});

// ---------- 调度：触发与台账 ----------

test('驱动项 + 玫瑰：同批发包；成交后只记台账，不落日戳', async () => {
  normalized = { items: [rider(), item({ productId: 'vip', shopType: 3 })], skipped: [] };
  respond = (cmd) => (cmd === 4204 ? okCart(normalized.items) : okBuy(3, 'vip'));
  assert.equal(await cartFeat.cycleRun(), 5000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204, 4203],
  );
  assert.deepEqual(sent[1].data, {
    header: {},
    shoppingCarBuy: {
      shopData: [
        { shopType: 3, productData: [{ productId: 'vip', buyNum: 3 }] },
        { shopType: 2, productData: [{ productId: 'rose', buyNum: 1 }] },
      ],
    },
  });
  const day = stored.get(DAY_KEY);
  assert.equal(day.resetTs, nextReset());
  assert.equal(day.done, false);
  assert.deepEqual(day.sold, { '3:vip': 1, '2:rose': 1 });
  assert.equal(stored.has(LEGACY_KEY), false);
});

test('成交后同日复检：已成交项不再发 4203，驱动项买完即落今日已解决', async () => {
  await cartFeat.cycleRun();
  assert.deepEqual(stored.get(DAY_KEY).sold, { '3:1001': 1 });
  sent = [];
  assert.ok((await cartFeat.cycleRun()) > 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  const day = stored.get(DAY_KEY);
  assert.equal(day.done, true);
  assert.equal(day.resetTs, nextReset());
});

test('首轮买不起的驱动项：余额增长后同日补买，全部成交才落今日已解决', async () => {
  normalized = {
    items: [
      item({ productId: 'a', chooseNum: 1, price: 10, balance: 10 }),
      item({ productId: 'b', chooseNum: 1, price: 10, balance: 10 }),
    ],
    skipped: [],
  };
  respond = (cmd) => (cmd === 4204 ? okCart(normalized.items) : okBuy(3, 'a'));
  assert.equal(await cartFeat.cycleRun(), 5000);
  assert.deepEqual(sent[1].data.shoppingCarBuy.shopData, [
    { shopType: 3, productData: [{ productId: 'a', buyNum: 1 }] },
  ]);
  // 余额增长（服务端回读的新快照）
  normalized = {
    items: [
      item({ productId: 'a', chooseNum: 1, price: 10, balance: 20 }),
      item({ productId: 'b', chooseNum: 1, price: 10, balance: 20 }),
    ],
    skipped: [],
  };
  sent = [];
  respond = (cmd) => (cmd === 4204 ? okCart(normalized.items) : okBuy(3, 'b'));
  assert.equal(await cartFeat.cycleRun(), 5000);
  assert.deepEqual(sent[1].data.shoppingCarBuy.shopData, [
    { shopType: 3, productData: [{ productId: 'b', buyNum: 1 }] },
  ]);
  sent = [];
  await cartFeat.cycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stored.get(DAY_KEY).done, true);
});

test('只有搭车项可买：不发 4203、不落日戳、15 分钟后重看', async () => {
  normalized = { items: [rider()], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 15 * 60 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stored.size, 0);
});

test('驱动项余额不足：不发 4203、不落日戳', async () => {
  normalized = { items: [item({ balance: 9 })], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 15 * 60 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stored.size, 0);
});

test('服务端空车：落今日已解决，重载后首拍不再查询', async () => {
  normalized = { items: [], skipped: [] };
  await cartFeat.cycleRun();
  assert.equal(stored.get(DAY_KEY).done, true);
  sent = [];
  cartFeat.resetForTest();
  await cartFeat.loadStateForTest();
  await cartFeat.cycleRun();
  assert.equal(sent.length, 0);
});

test('驱动项全部达限购：落今日已解决；跳过项不再阻止落戳', async () => {
  normalized = { items: [item({ purchasedBuyNum: 5 })], skipped: [] };
  await cartFeat.cycleRun();
  assert.equal(stored.get(DAY_KEY).done, true);
  stored.clear();
  sent = [];
  cartFeat.resetForTest();
  normalized = {
    items: [item({ purchasedBuyNum: 5 })],
    skipped: [{ shopType: 13, productId: '9', reason: 'dynamic-alliance-price' }],
  };
  await cartFeat.cycleRun();
  assert.equal(stored.get(DAY_KEY).done, true);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('旧版日戳兼容：升级当日不再重复兑换', async () => {
  stored.set(LEGACY_KEY, { resetTs: nextReset() });
  cartFeat.resetForTest();
  await cartFeat.loadStateForTest();
  assert.ok((await cartFeat.cycleRun()) > 0);
  assert.deepEqual(sent, []);
});

// ---------- 失败与回执 ----------

test('4204 CODE_NOT_SENT：短重试且不发 4203、不记账', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await cartFeat.cycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stored.size, 0);
});

test('4203 CODE_NOT_SENT：确定未发出，不记账并允许重试', async () => {
  respond = (cmd) => (cmd === 4204 ? okCart(normalized.items) : { ok: false, code: CODE_NOT_SENT });
  assert.equal(await cartFeat.cycleRun(), 20000);
  assert.equal(stored.size, 0);
  sent = [];
  respond = (cmd) => (cmd === 4204 ? okCart(normalized.items) : okBuy(3, '1001'));
  assert.equal(await cartFeat.cycleRun(), 5000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204, 4203],
  );
});

test('4203 空壳成功：搭车项保守记今日已尝试，驱动项不记、20 秒后重查', async () => {
  normalized = { items: [rider(), item({ productId: 'vip', shopType: 3 })], skipped: [] };
  respond = (cmd) => (cmd === 4204 ? okCart(normalized.items) : { ok: true, code: 0, data: {} });
  assert.equal(await cartFeat.cycleRun(), 20000);
  const day = stored.get(DAY_KEY);
  assert.deepEqual(day.sold, { '2:rose': 1 });
  assert.equal(day.done, false);
});

test('4203 真业务拒绝：不记账，15 分钟后再查询', async () => {
  respond = (cmd) =>
    cmd === 4204 ? okCart(normalized.items) : { ok: false, code: 2001, reason: 'not ready' };
  assert.equal(await cartFeat.cycleRun(), 15 * 60 * 1000);
  assert.equal(stored.size, 0);
});

test('4204 在飞暂停：不继续发 4203、不记账', async () => {
  respond = () => {
    alive = false;
    abortRound.abort();
    return okCart(normalized.items);
  };
  assert.equal(await cartFeat.cycleRun(), 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stored.size, 0);
});

test('4204 应答跨午夜：丢弃旧购物车，不继续发 4203', async () => {
  const oldReset = nextReset();
  respond = () => {
    now = oldReset + 120;
    return okCart(normalized.items);
  };
  assert.equal(await cartFeat.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stored.size, 0);
});

test('成功回执跨午夜：不落旧台账，次日重新查询', async () => {
  const oldReset = nextReset();
  respond = (cmd) => {
    if (cmd === 4203) now = oldReset + 120;
    return cmd === 4204 ? okCart(normalized.items) : okBuy(3, '1001');
  };
  assert.equal(await cartFeat.cycleRun(), 1000);
  assert.equal(stored.size, 0);
  await cartFeat.cycleRun();
  assert.equal(sent.filter((s) => s.cmd === 4204).length, 2);
});

test('4203 成功回执期间暂停：仍保存台账，恢复后不重兑', async () => {
  respond = (cmd) => {
    if (cmd === 4203) alive = false;
    return cmd === 4204 ? okCart(normalized.items) : okBuy(3, '1001');
  };
  assert.equal(await cartFeat.cycleRun(), 0);
  assert.deepEqual(stored.get(DAY_KEY).sold, { '3:1001': 1 });
  alive = true;
  sent = [];
  await cartFeat.cycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});
