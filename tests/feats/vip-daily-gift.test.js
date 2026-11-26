// 军级宝箱（每日免费礼包）离线回归：军级/冷却判据、V1 字符串应答、freeFlag 锚点与防重领。
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
const feat = await import('../../extension/src/feats/player/vip-daily-gift/index.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const orig = {
  serverTime: gameData.serverTime,
  nextDailyResetTs: gameData.nextDailyResetTs,
  vipDailyGift: gameData.vipDailyGift,
  dataGet: storage.data.get,
  dataSet: storage.data.set,
};
const NOW = 1794585900;
let now;
let vip;
let sent;
let respond;
let stamps;
let alive;
let subscribed = [];

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  return t ? t - ((t - 57600) % 86400) + 86400 : 0;
}
const fakeNet = {
  install: () => true,
  sendGuarded: async (cmd, data, opts) => {
    sent.push({ cmd, data, protocol: opts.protocol });
    return respond(cmd, data);
  },
};
const fakeCtx = {
  alive: () => alive,
  net: fakeNet,
  on: { push: (cmd) => (subscribed.push(cmd), () => {}) },
};
feat.installForTest(fakeCtx);

beforeEach(() => {
  now = NOW;
  vip = { level: 8, cooldownTs: 0 };
  sent = [];
  stamps = new Map();
  alive = true;
  subscribed = [];
  gameData.serverTime = () => now;
  gameData.nextDailyResetTs = nextReset;
  gameData.vipDailyGift = () => vip;
  storage.data.get = async (key) => stamps.get(key);
  storage.data.set = async (key, value) => stamps.set(key, value);
  respond = () => ({ ok: true, code: 0, data: '{"freeFlag":1794672300,"reward":{"items":[]}}' });
  feat.resetForTest();
  feat.subscribeForTest(fakeCtx);
});
afterEach(() => {
  Object.assign(gameData, {
    serverTime: orig.serverTime,
    nextDailyResetTs: orig.nextDailyResetTs,
    vipDailyGift: orig.vipDailyGift,
  });
  storage.data.get = orig.dataGet;
  storage.data.set = orig.dataSet;
});

test('面板集成：注册、玩家基础设置、默认关闭、每次激活订阅 20011', () => {
  assert.ok(collectFeatureIds({ children: MENU }).includes('vipDailyGift'));
  const spec = reactor.list().find((s) => s.id === 'vipDailyGift');
  assert.equal(spec.defaults.enabled, false);
  assert.deepEqual(spec.toModuleCfg({ enabled: true }), { enabled: true });
  assert.deepEqual(subscribed, [20011]);
});

test('2002：V1 空载荷、字符串应答解析成功，按服务器 freeFlag 落日戳且同日不再发包', async () => {
  assert.ok((await feat.cycleRun()) > 0);
  assert.deepEqual(sent, [{ cmd: 2002, data: {}, protocol: 'send' }]);
  // freeFlag 是服务器权威冷却（游戏 updateVipRewardCdTime），优先于本地日界。
  assert.deepEqual(stamps.get('vipDailyGift.resolved'), { resetTs: 1794672300, claimed: true });
  await feat.cycleRun();
  assert.equal(sent.length, 1);
});

test('冷却中/状态未就绪：不发 2002', async () => {
  vip = { level: 8, cooldownTs: now + 60 };
  // 60s 冷却 + 10s 日界静置（sleepToReset 统一加 RESET_SETTLE_MS）
  assert.equal(await feat.cycleRun(), 70000);
  vip = null;
  assert.equal(await feat.cycleRun(), 15 * 60 * 1000);
  assert.equal(sent.length, 0);
});

test('军级 0（VIP0）不断链：游戏宝箱按钮按 1 级归一，仍发 2002', async () => {
  vip = { level: 0, cooldownTs: 0 };
  assert.ok((await feat.cycleRun()) > 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [2002],
  );
  assert.equal(stamps.get('vipDailyGift.resolved').claimed, true);
});

test('CODE_NOT_SENT：20 秒短重试且不落日戳', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await feat.cycleRun(), 20000);
  assert.equal(stamps.size, 0);
});

test('ok 但无 freeFlag/reward：不谎报领取成功，20 秒后重查', async () => {
  respond = () => ({ ok: true, code: 0, data: '{}' });
  assert.equal(await feat.cycleRun(), 20000);
  assert.equal(stamps.size, 0);
});

test('freeFlag=0 或空/零数量奖励：均无实际领取凭证，不落 claimed 日戳', async () => {
  const shells = [
    { freeFlag: 0 },
    { reward: {} },
    { reward: { items: [] } },
    { reward: { items: [{}] } },
    { reward: { items: [{ id: '1', num: 0 }] } },
    { reward: { items: [{ id: '1' }] } },
  ];
  for (const shell of shells) {
    sent = [];
    feat.resetForTest();
    respond = () => ({ ok: true, code: 0, data: shell });
    assert.equal(await feat.cycleRun(), 20000);
    assert.equal(stamps.size, 0);
    assert.deepEqual(
      sent.map((s) => s.cmd),
      [2002],
    );
  }
});

test('日界同秒（0 点整）先静置 10 秒再发：实证 00:00:00.592 被 code=3 拒', async () => {
  const dayStart = nextReset() - 86400;
  now = dayStart; // 恰在日界整秒，上一日 freeFlag 锚点正是此刻
  vip = { level: 13, cooldownTs: dayStart };
  assert.equal(await feat.cycleRun(), 10200);
  assert.equal(sent.length, 0);
  now = dayStart + 10; // 服务器秒数已严格越过锚点
  respond = () => ({ ok: true, code: 0, data: { freeFlag: dayStart + 86400 } });
  assert.ok((await feat.cycleRun()) > 0);
  assert.equal(sent.length, 1);
  assert.equal(stamps.get('vipDailyGift.resolved').claimed, true);
});

test('真业务拒绝：按 1/5/15/30 分钟阶梯重试，耗尽才按日抑制', async () => {
  respond = () => ({ ok: false, code: 2001, data: '<not_ready>' });
  const waits = [];
  for (let i = 0; i < 5; i++) waits.push(await feat.cycleRun());
  assert.deepEqual(waits, [60000, 300000, 900000, 1800000, 86110000]);
  assert.equal(sent.length, 5);
  assert.deepEqual(stamps.get('vipDailyGift.resolved'), { resetTs: nextReset(), claimed: false });
  await feat.cycleRun();
  assert.equal(sent.length, 5);
});

test('跨午夜成功回执不落旧日戳，次日照新状态领取', async () => {
  const oldReset = nextReset();
  respond = () => {
    now = oldReset + 120;
    vip = { level: 8, cooldownTs: 0 };
    return { ok: true, code: 0, data: { freeFlag: oldReset } };
  };
  assert.equal(await feat.cycleRun(), 1000);
  assert.equal(stamps.size, 0);
  await feat.cycleRun();
  assert.equal(sent.length, 2);
});

test('成功回执期间暂停仍保存，恢复后不重复领取', async () => {
  respond = () => {
    alive = false;
    return { ok: true, code: 0, data: { reward: { items: [{ id: '1', num: 1 }] } } };
  };
  assert.equal(await feat.cycleRun(), 0);
  assert.equal(stamps.size, 1);
  alive = true;
  await feat.cycleRun();
  assert.equal(sent.length, 1);
});

test('刷新后回读 claimed 日戳，首拍零发包', async () => {
  await feat.cycleRun();
  sent = [];
  feat.resetForTest();
  await feat.loadStampForTest();
  await feat.cycleRun();
  assert.equal(sent.length, 0);
});
