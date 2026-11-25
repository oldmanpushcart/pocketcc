// 金融中心购物车一键兑换离线回归：4204 查询 → 同款限购/余额规划 → 4203 → 明确回执落日戳。
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
let now;
let sent;
let respond;
let stamps;
let alive;
let abortRound;
let normalized;

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  return t ? t - ((t - 57600) % 86400) + 86400 : 0;
}
function item(over) {
  return Object.assign(
    {
      shopType: 2,
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
function okCart(items, skipped) {
  return { ok: true, code: 0, data: { shoppingCarInfo: { singleShopData: { items, skipped } } } };
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
  stamps = new Map();
  alive = true;
  abortRound = new AbortController();
  fakeCtx.signal = abortRound.signal;
  normalized = { items: [item()], skipped: [] };
  gameData.serverTime = () => now;
  gameData.nextDailyResetTs = nextReset;
  gameData.shoppingCart = () => normalized;
  storage.data.get = async (key) => stamps.get(key);
  storage.data.set = async (key, value) => stamps.set(key, value);
  respond = (cmd) =>
    cmd === 4204
      ? okCart(normalized.items, normalized.skipped)
      : {
          ok: true,
          code: 0,
          data: {
            shoppingCarBuy: {
              shopPurchasedInfo: {
                singleShopData: [
                  {
                    shopType: 2,
                    productPurchasedData: [{ productId: '1001', purchasedBuyNum: 3 }],
                  },
                ],
              },
              reward: { items: [] },
            },
          },
        };
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

test('纯规划：限购余量、chooseNum、同货币顺序扣减与分组均与游戏一致', () => {
  const plan = planShoppingCart({
    items: [
      item({ productId: '1', chooseNum: 9, purchasedBuyNum: 2, balance: 50 }),
      item({ productId: '2', shopType: 3, chooseNum: 2, balance: 50 }),
      item({ productId: '3', shopType: 2, currencyKey: '1:0', balance: 50, price: 15 }),
    ],
    skipped: [],
  });
  assert.deepEqual(plan.shopData, [
    { shopType: 2, productData: [{ productId: '1', buyNum: 3 }] },
    { shopType: 3, productData: [{ productId: '2', buyNum: 2 }] },
  ]);
  assert.equal(plan.affordable, 2);
  assert.equal(plan.insufficient, 1);
});

test('面板集成：功能已注册、挂入玩家基础设置且默认关闭', () => {
  assert.ok(collectFeatureIds({ children: MENU }).includes('shoppingCart'));
  const spec = reactor.list().find((s) => s.id === 'shoppingCart');
  assert.ok(spec);
  assert.equal(spec.defaults.enabled, false);
  assert.deepEqual(spec.toModuleCfg({ enabled: true }), { enabled: true });
});

test('4204→4203：精确 PB 外层载荷，明确购买回执后落日戳且同日不再发包', async () => {
  assert.ok((await cartFeat.cycleRun()) > 0);
  assert.deepEqual(sent, [
    { cmd: 4204, data: { header: {} }, protocol: 'sendPB' },
    {
      cmd: 4203,
      data: {
        header: {},
        shoppingCarBuy: {
          shopData: [{ shopType: 2, productData: [{ productId: '1001', buyNum: 3 }] }],
        },
      },
      protocol: 'sendPB',
    },
  ]);
  assert.equal(stamps.get('shoppingCart.resolved').resetTs, nextReset());
  await cartFeat.cycleRun();
  assert.equal(sent.length, 2);
});

test('4204 CODE_NOT_SENT：短重试且不发 4203、不落日戳', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await cartFeat.cycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stamps.size, 0);
});

test('4203 空壳成功回执：空 reward/空商品/零购买量均不落戳，继续重查', async () => {
  const shells = [
    {},
    { reward: {} },
    { reward: { items: [] } },
    { reward: { items: [{}] } },
    { shopPurchasedInfo: { singleShopData: [{ shopType: 2, productPurchasedData: [] }] } },
    {
      shopPurchasedInfo: {
        singleShopData: [
          { shopType: 2, productPurchasedData: [{ productId: '1001', purchasedBuyNum: 0 }] },
        ],
      },
    },
  ];
  for (const shell of shells) {
    sent = [];
    cartFeat.resetForTest();
    respond = (cmd) =>
      cmd === 4204
        ? okCart(normalized.items)
        : { ok: true, code: 0, data: { shoppingCarBuy: shell } };
    assert.equal(await cartFeat.cycleRun(), 20000);
    assert.equal(stamps.size, 0);
    assert.deepEqual(
      sent.map((s) => s.cmd),
      [4204, 4203],
    );
  }
});

test('4204 在飞暂停：不继续发 4203、不落日戳', async () => {
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
  assert.equal(stamps.size, 0);
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
  assert.equal(stamps.size, 0);
});

test('4203 CODE_NOT_SENT：20 秒后先重查，不直接重发购买', async () => {
  respond = (cmd) => (cmd === 4204 ? okCart(normalized.items) : { ok: false, code: CODE_NOT_SENT });
  assert.equal(await cartFeat.cycleRun(), 20000);
  assert.equal(stamps.size, 0);
  sent = [];
  normalized = { items: [], skipped: [] };
  respond = (cmd) => (cmd === 4204 ? okCart([]) : { ok: true, code: 0 });
  await cartFeat.cycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('4203 真业务拒绝：不落日戳，15 分钟后再查询', async () => {
  respond = (cmd) =>
    cmd === 4204 ? okCart(normalized.items) : { ok: false, code: 2001, reason: 'not ready' };
  assert.equal(await cartFeat.cycleRun(), 15 * 60 * 1000);
  assert.equal(stamps.size, 0);
});

test('货币不足：不发 4203、不睡整天', async () => {
  normalized = { items: [item({ balance: 9 })], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 15 * 60 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(stamps.size, 0);
});

test('服务端空车：日落戳，刷新后回读同抑制首拍', async () => {
  normalized = { items: [], skipped: [] };
  await cartFeat.cycleRun();
  assert.equal(stamps.get('shoppingCart.resolved').resetTs, nextReset());
  sent = [];
  cartFeat.resetForTest();
  await cartFeat.loadStampForTest();
  await cartFeat.cycleRun();
  assert.equal(sent.length, 0);
});

test('全部达限购：落日戳；存在动态跳过快照不谎报完整解决', async () => {
  normalized = { items: [item({ purchasedBuyNum: 5 })], skipped: [] };
  await cartFeat.cycleRun();
  assert.equal(stamps.size, 1);
  stamps.clear();
  sent = [];
  cartFeat.resetForTest();
  normalized.skipped = [{ shopType: 13, productId: '9', reason: 'dynamic-alliance-price' }];
  await cartFeat.cycleRun();
  assert.equal(stamps.size, 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('成功回执跨午夜：不落旧日戳，次日重新查询', async () => {
  const oldReset = nextReset();
  respond = (cmd) => {
    if (cmd === 4203) now = oldReset + 120;
    return cmd === 4204
      ? okCart(normalized.items)
      : {
          ok: true,
          code: 0,
          data: { shoppingCarBuy: { reward: { items: [{ id: '1', num: 1 }] } } },
        };
  };
  assert.equal(await cartFeat.cycleRun(), 1000);
  assert.equal(stamps.size, 0);
  await cartFeat.cycleRun();
  assert.equal(sent.filter((s) => s.cmd === 4204).length, 2);
});

test('4203 成功回执期间暂停：仍保存回执，恢复后不重兑', async () => {
  respond = (cmd) => {
    if (cmd === 4203) alive = false;
    return cmd === 4204
      ? okCart(normalized.items)
      : {
          ok: true,
          code: 0,
          data: { shoppingCarBuy: { reward: { items: [{ id: '1', num: 1 }] } } },
        };
  };
  assert.equal(await cartFeat.cycleRun(), 0);
  assert.equal(stamps.size, 1);
  alive = true;
  await cartFeat.cycleRun();
  assert.equal(sent.length, 2);
});
