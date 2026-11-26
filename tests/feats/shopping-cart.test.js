// 金融中心购物车一键兑换离线回归：4204 查询 → 差值规划 → 4203 → 服务端计数收尾（本地无台账）。
// 不连接游戏服务器：用「已买计数只在成交时累加」的迷你服务端验证不超买、乒乓刹车与退避择时。
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
const { MENU, collectFeatureIds } = await import('../../extension/src/core/menu.js');
const { reactor } = await import('../../extension/src/core/reactor.js');
const cartFeat = await import('../../extension/src/feats/player/shopping-cart/index.js');
const { planShoppingCart, shoppingCartKey } =
  await import('../../extension/src/feats/player/shopping-cart/plan.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const orig = {
  serverTime: gameData.serverTime,
  nextDailyResetTs: gameData.nextDailyResetTs,
  shoppingCart: gameData.shoppingCart,
};
const NOW = 1794585900; // 2026-11-14 00:05 UTC+8（日界后 5 分钟）
const MIN = 60 * 1000;
let now;
let sent;
let respond;
let alive;
let abortRound;
/** @type {{items:object[], skipped:object[]}} 迷你服务端的唯一真相：purchasedBuyNum 只在成交时累加 */
let server;

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  return t ? t - ((t - 57600) % 86400) + 86400 : 0;
}
/** 有界货架商品（默认军级商店 shopType=3，限购 5 次，金币）。 */
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
/** 道具商店无日限购货架（buyLimit=-1：只能靠 chooseNum 差值收敛，回归 11-26 10:08 超买）。 */
function rose(over) {
  return item({ shopType: 2, productId: 'rose', buyLimit: -1, chooseNum: 1, ...over });
}
function cartGroups(items) {
  const byShop = new Map();
  for (const it of items) {
    let g = byShop.get(it.shopType);
    if (!g) {
      g = { shopType: it.shopType, productPurchasedData: [] };
      byShop.set(it.shopType, g);
    }
    g.productPurchasedData.push({
      productId: it.productId,
      chooseNum: it.chooseNum,
      purchasedBuyNum: it.purchasedBuyNum,
    });
  }
  return [...byShop.values()];
}
/** 投影桩：只按报文里带的 purchasedBuyNum/chooseNum 还原，其余配置/余额取货架模板。 */
function project(groups) {
  const items = [];
  for (const g of groups || []) {
    for (const p of g.productPurchasedData || []) {
      const src = server.items.find(
        (x) => x.shopType === g.shopType && String(x.productId) === String(p.productId),
      );
      if (!src) continue;
      items.push({ ...src, purchasedBuyNum: p.purchasedBuyNum, chooseNum: p.chooseNum });
    }
  }
  return { items, skipped: server.skipped };
}
function okCart() {
  return {
    ok: true,
    code: 0,
    data: { shoppingCarInfo: { singleShopData: cartGroups(server.items) } },
  };
}
/** 真实回执形态：reward + 成交后的全量购物车（报文实证 26 项与查询一一对应）。 */
function okBuy(shopData) {
  for (const g of shopData) {
    for (const p of g.productData) {
      const it = server.items.find(
        (x) => x.shopType === g.shopType && String(x.productId) === String(p.productId),
      );
      if (it) it.purchasedBuyNum += Number(p.buyNum);
    }
  }
  return {
    ok: true,
    code: 0,
    data: {
      shoppingCarBuy: {
        reward: { items: [{ itemId: 800002, itemCount: 1 }] },
        shopPurchasedInfo: { singleShopData: cartGroups(server.items) },
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
  alive = true;
  abortRound = new AbortController();
  fakeCtx.signal = abortRound.signal;
  server = { items: [item()], skipped: [] };
  gameData.serverTime = () => now;
  gameData.nextDailyResetTs = nextReset;
  gameData.shoppingCart = (groups) => (Array.isArray(groups) ? project(groups) : null);
  respond = (cmd, data) => (cmd === 4204 ? okCart() : okBuy(data.shoppingCarBuy.shopData));
  cartFeat.resetForTest();
});

afterEach(() => {
  Object.assign(gameData, orig);
});

// ---------- 纯规划：应买 = chooseNum，已买 = purchasedBuyNum ----------

test('纯规划：差值即本轮数量，同货币共享余额按原序消耗', () => {
  const plan = planShoppingCart({
    items: [
      rose({ balance: 60, price: 10, chooseNum: 2, purchasedBuyNum: 1 }),
      item({ productId: 'b', chooseNum: 5, purchasedBuyNum: 2, balance: 60 }),
    ],
    skipped: [],
  });
  assert.deepEqual(plan.shopData, [
    { shopType: 2, productData: [{ productId: 'rose', buyNum: 1 }] },
    { shopType: 3, productData: [{ productId: 'b', buyNum: 3 }] },
  ]);
  assert.deepEqual(plan.entries, ['2:rose', '3:b']);
  assert.equal(plan.pending, 0);
  assert.equal(plan.done, 0);
});

test('纯规划：已买达到应买即收敛，无限购项也不会重复成交', () => {
  // 报文实证 11-26 10:08：2:28 的 chooseNum=1、purchasedBuyNum=1，旧台账口径又买了一次
  const plan = planShoppingCart({ items: [rose({ purchasedBuyNum: 1 })], skipped: [] });
  assert.deepEqual(plan.shopData, []);
  assert.equal(plan.done, 1);
  assert.equal(plan.pending, 0);
});

test('纯规划：限购天花板压住的项记 capped，不算欠账、不进包', () => {
  const plan = planShoppingCart({
    items: [
      item({ productId: 'a', chooseNum: 9, purchasedBuyNum: 5, buyLimit: 5 }),
      item({ productId: 'b', chooseNum: 2, purchasedBuyNum: 0, buyLimit: -99 }),
      rose({ purchasedBuyNum: 3, chooseNum: 1 }),
    ],
    skipped: [],
  });
  assert.deepEqual(plan.shopData, []);
  assert.equal(plan.capped, 2);
  assert.equal(plan.done, 1);
  assert.equal(plan.pending, 0);
});

test('纯规划：余额只够一部分则部分购买（能买几个买几个）', () => {
  const plan = planShoppingCart({
    items: [
      item({ productId: 'a', chooseNum: 4, price: 30, balance: 100 }), // 整项 120 买不起 → 补 3 个
      item({ productId: 'b', chooseNum: 1, price: 10, balance: 100 }), // 剩 10 金币刚好 1 个
      item({ productId: 'c', chooseNum: 1, price: 50, balance: 100 }), // 真买不起 → pending
    ],
    skipped: [],
  });
  assert.deepEqual(plan.shopData, [
    {
      shopType: 3,
      productData: [
        { productId: 'a', buyNum: 3 },
        { productId: 'b', buyNum: 1 },
      ],
    },
  ]);
  assert.equal(plan.planned, 2);
  assert.equal(plan.partial, 1);
  assert.equal(plan.pending, 1);
});

test('纯规划：整项全买得起时不拆单，等价游戏一键口径', () => {
  const plan = planShoppingCart({
    items: [item({ productId: 'a', chooseNum: 2, price: 10, balance: 1000 })],
    skipped: [],
  });
  assert.deepEqual(plan.shopData, [{ shopType: 3, productData: [{ productId: 'a', buyNum: 2 }] }]);
  assert.equal(plan.partial, 0);
});

// ---------- 调度 ----------

test('买齐一轮：4204 + 4203 各一次，回执已了结则直接睡到日界，不再追加 4204', async () => {
  server = {
    items: [rose({ balance: 60, price: 10 }), item({ productId: 'vip', balance: 60 })],
    skipped: [],
  };
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204, 4203],
  );
  assert.deepEqual(sent[0].data, { header: {} });
  assert.deepEqual(sent[1].data, {
    header: {},
    shoppingCarBuy: {
      shopData: [
        { shopType: 2, productData: [{ productId: 'rose', buyNum: 1 }] },
        { shopType: 3, productData: [{ productId: 'vip', buyNum: 3 }] },
      ],
    },
  });
  assert.equal(sent[1].protocol, 'sendPB');
  assert.equal(server.items[0].purchasedBuyNum, 1);
  assert.equal(server.items[1].purchasedBuyNum, 3);
});

test('已买计数够了就不发包：全项了结只查询一次，睡到日界', async () => {
  server = { items: [rose({ purchasedBuyNum: 1 }), item({ purchasedBuyNum: 3 })], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('跨拍自愈：重启后仍以服务端计数为准，不重复成交', async () => {
  server = { items: [rose()], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.equal(server.items[0].purchasedBuyNum, 1);
  cartFeat.resetForTest();
  sent = [];
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
  assert.equal(server.items[0].purchasedBuyNum, 1);
});

test('服务端只成交一部分：5 秒后复检，靠新查询补齐剩余差值', async () => {
  server = { items: [item({ chooseNum: 3, price: 10, balance: 100 })], skipped: [] };
  // 回执只 +1（模拟服务端限购/库存压制）
  let first = true;
  respond = (cmd, data) => {
    if (cmd !== 4204) {
      if (first) {
        first = false;
        server.items[0].purchasedBuyNum += 1;
        return {
          ok: true,
          code: 0,
          data: {
            shoppingCarBuy: {
              reward: { items: [] },
              shopPurchasedInfo: { singleShopData: cartGroups(server.items) },
            },
          },
        };
      }
      return okBuy(data.shoppingCarBuy.shopData);
    }
    return okCart();
  };
  assert.equal(await cartFeat.cycleRun(), 5000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204, 4203],
  );
  sent = [];
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.deepEqual(sent[1].data.shoppingCarBuy.shopData, [
    { shopType: 3, productData: [{ productId: '1001', buyNum: 2 }] },
  ]);
});

test('买不起：不发 4203，15 分钟后等余额增长', async () => {
  server = { items: [rose({ balance: 9 })], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('等余额巡检步进退避：15 分钟起步每轮 +5 分钟、60 分钟封顶，成交后回首档', async () => {
  server = { items: [item({ productId: 'a', balance: 0 })], skipped: [] };
  const curve = [15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  for (const m of curve) assert.equal(await cartFeat.cycleRun(), m * MIN);
  assert.equal(await cartFeat.cycleRun(), 60 * MIN);
  // 余额到账：成交一轮后回到 15 分钟档
  server.items[0].balance = 100;
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  server = { items: [item({ productId: 'b', balance: 0 })], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
});

test('等余额退避不跨日：最晚 0 点 + 5 分钟醒一次', async () => {
  server = { items: [rose({ balance: 0 })], skipped: [] };
  const reset = nextReset();
  now = reset - 3600;
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
  now = reset - 300;
  assert.equal(await cartFeat.cycleRun(), 10 * MIN);
});

test('服务端空车：不发包，睡到日界', async () => {
  server = { items: [], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('只剩限购项与非代兑项：视为今日已了结，睡到日界', async () => {
  server = {
    items: [item({ purchasedBuyNum: 5 })],
    skipped: [{ shopType: 13, productId: '9', reason: 'alliance-not-limit-commodity' }],
  };
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

// ---------- 失败与回执 ----------

test('4204 CODE_NOT_SENT：短重试且不发 4203', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await cartFeat.cycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('4204 业务拒绝：15 分钟后再查询', async () => {
  respond = () => ({ ok: false, code: 1001, reason: 'locked' });
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
});

test('4204 应答缺数组：投影不可用则不发 4203', async () => {
  respond = () => ({ ok: true, code: 0, data: { shoppingCarInfo: {} } });
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('4203 CODE_NOT_SENT：确定未发出，20 秒后重查（服务端计数未动）', async () => {
  respond = (cmd) => (cmd === 4204 ? okCart() : { ok: false, code: CODE_NOT_SENT });
  assert.equal(await cartFeat.cycleRun(), 20000);
  assert.equal(server.items[0].purchasedBuyNum, 0);
  sent = [];
  respond = (cmd, data) => (cmd === 4204 ? okCart() : okBuy(data.shoppingCarBuy.shopData));
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204, 4203],
  );
});

test('4203 业务拒绝：什么都没买，退避首档由下一轮重新判定', async () => {
  respond = (cmd) => (cmd === 4204 ? okCart() : { ok: false, code: 2001, reason: 'not enough' });
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
  assert.equal(server.items[0].purchasedBuyNum, 0);
});

test('4203 成功但回执没带购物车：5 秒后回读 4204 再判', async () => {
  respond = (cmd) => (cmd === 4204 ? okCart() : { ok: true, code: 0, data: {} });
  assert.equal(await cartFeat.cycleRun(), 5000);
});

test('4203 成功但已买计数不涨：连踩两轮转退避，不打乒乓', async () => {
  respond = (cmd) =>
    cmd === 4204
      ? okCart()
      : {
          ok: true,
          code: 0,
          data: {
            shoppingCarBuy: {
              reward: { items: [] },
              shopPurchasedInfo: { singleShopData: cartGroups(server.items) },
            },
          },
        };
  assert.equal(await cartFeat.cycleRun(), 5000);
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
  assert.equal(await cartFeat.cycleRun(), 20 * MIN);
});

test('4204 在飞暂停：不继续发 4203', async () => {
  respond = () => {
    alive = false;
    abortRound.abort();
    return okCart();
  };
  assert.equal(await cartFeat.cycleRun(), 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('4204 应答跨午夜：丢弃旧购物车，不发 4203', async () => {
  const oldReset = nextReset();
  respond = () => {
    now = oldReset + 120;
    return okCart();
  };
  assert.equal(await cartFeat.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [4204],
  );
});

test('4203 回执跨午夜：不落旧结论，下一拍重查', async () => {
  const oldReset = nextReset();
  respond = (cmd, data) => {
    if (cmd === 4203) now = oldReset + 120;
    return cmd === 4204 ? okCart() : okBuy(data.shoppingCarBuy.shopData);
  };
  assert.equal(await cartFeat.cycleRun(), 1000);
  sent = [];
  await cartFeat.cycleRun();
  assert.equal(sent.filter((s) => s.cmd === 4204).length, 1);
});

// ---------- 面板 ----------

test('面板文案：已完成 x/y 口径，欠账与不代兑分别披露', async () => {
  cartFeat.resetForTest();
  assert.equal(cartFeat.statusText(), '等待检测');
  server = { items: [rose(), item()], skipped: [] };
  respond = (cmd) => (cmd === 4204 ? okCart() : { ok: false, code: CODE_NOT_SENT });
  // 本拍有可买项 → 发了 4203 但未上线：瞬态重试，面板仍按差值如实计数
  assert.equal(await cartFeat.cycleRun(), 20000);
  assert.equal(cartFeat.statusText(), '已完成 0/2');
  server = {
    items: [rose({ purchasedBuyNum: 1 }), item({ purchasedBuyNum: 0, balance: 5 })],
    skipped: [{ shopType: 13, productId: '9', reason: 'alliance-discount-unavailable' }],
  };
  assert.equal(await cartFeat.cycleRun(), 15 * MIN);
  assert.equal(cartFeat.statusText(), '已完成 1/2，1 项等余额（1 项不代兑）');
});

test('面板文案：全项了结显示今日已完成', async () => {
  server = { items: [rose({ purchasedBuyNum: 1 })], skipped: [] };
  assert.equal(await cartFeat.cycleRun(), 24 * 3600 * 1000);
  assert.equal(cartFeat.statusText(), '今日已完成');
});

test('面板集成：功能已注册、挂入玩家基础设置且默认关闭、配置仍只有 enabled', () => {
  assert.ok(collectFeatureIds({ children: MENU }).includes('shoppingCart'));
  const spec = reactor.list().find((s) => s.id === 'shoppingCart');
  assert.ok(spec);
  assert.equal(spec.defaults.enabled, false);
  assert.deepEqual(spec.toModuleCfg({ enabled: true }), { enabled: true });
});

test('本 feat 不再落任何当日台账键：只读服务端计数', async () => {
  server = { items: [rose()], skipped: [] };
  await cartFeat.cycleRun();
  assert.equal(typeof cartFeat.loadStateForTest, 'undefined');
  assert.equal(shoppingCartKey({ shopType: 2, productId: 28 }), '2:28');
});
