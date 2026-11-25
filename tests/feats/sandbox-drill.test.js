// 沙盘演习离线回归：只发 1661 查询，挑战参数由注入的原生 UI 链生成，绝不自行拼阵容。
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
const { sandboxArena } = await import('../../extension/src/feats/player/sandbox-drill/api.js');
const feat = await import('../../extension/src/feats/player/sandbox-drill/index.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const orig = {
  serverTime: gameData.serverTime,
  nextDailyResetTs: gameData.nextDailyResetTs,
  dataGet: storage.data.get,
  dataSet: storage.data.set,
  open: sandboxArena.open,
  prepare: sandboxArena.prepare,
  start: sandboxArena.start,
  battleActive: sandboxArena.battleActive,
  resultPresent: sandboxArena.resultPresent,
  closeResult: sandboxArena.closeResult,
  closePreparation: sandboxArena.closePreparation,
};
const NOW = 1794585900;
let now;
let sent;
let respond;
let stamps;
let alive;
let inFlight;
let actions;
let remaining;
let battleActive;
let resultPresent;
let reqClock;
const subscribed = [];
const reqHandlers = new Map();
const respHandlers = new Map();

function emitReq(cmd = 1660, ts = reqClock) {
  for (const fn of reqHandlers.get(cmd) || []) fn({ cmd, ts });
}
function emitResp(status, cmd = 1660, reqTime = reqClock) {
  for (const fn of respHandlers.get(cmd) || []) fn({ cmd, status, reqTime });
}

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  return t ? t - ((t - 57600) % 86400) + 86400 : 0;
}
const fakeNet = {
  install: () => true,
  isSending: () => inFlight,
  sendGuarded: async (cmd, data, opts) => {
    sent.push({ cmd, data, protocol: opts.protocol });
    return respond(cmd, data);
  },
};
const fakeCtx = {
  alive: () => alive,
  signal: new AbortController().signal,
  net: fakeNet,
  on: {
    req: (cmd, fn) => {
      subscribed.push(['req', cmd]);
      if (!reqHandlers.has(cmd)) reqHandlers.set(cmd, []);
      reqHandlers.get(cmd).push(fn);
    },
    resp: (cmd, fn) => {
      subscribed.push(['resp', cmd]);
      if (!respHandlers.has(cmd)) respHandlers.set(cmd, []);
      respHandlers.get(cmd).push(fn);
    },
  },
};
feat.installForTest(fakeCtx);

beforeEach(() => {
  now = NOW;
  sent = [];
  stamps = new Map();
  alive = true;
  inFlight = false;
  actions = [];
  remaining = 5;
  battleActive = false;
  resultPresent = false;
  reqClock = 1000;
  reqHandlers.clear();
  respHandlers.clear();
  subscribed.length = 0;
  gameData.serverTime = () => now;
  gameData.nextDailyResetTs = nextReset;
  storage.data.get = async (key) => stamps.get(key);
  storage.data.set = async (key, value) => stamps.set(key, value);
  respond = () => ({ ok: true, code: 0, data: '{"time":5,"type":101,"rankArray":[]}' });
  sandboxArena.open = (info) => (actions.push(['open', info]), { ok: true });
  sandboxArena.prepare = () => (actions.push(['prepare']), { ok: true });
  sandboxArena.start = () => {
    actions.push(['start']);
    emitReq();
    return { ok: true };
  };
  sandboxArena.battleActive = () => battleActive;
  sandboxArena.resultPresent = () => resultPresent;
  sandboxArena.closeResult = () => (actions.push(['closeResult']), true);
  sandboxArena.closePreparation = () => (actions.push(['closePreparation']), { ok: true });
  feat.resetForTest();
  feat.subscribeForTest(fakeCtx);
});
afterEach(() => {
  Object.assign(gameData, { serverTime: orig.serverTime, nextDailyResetTs: orig.nextDailyResetTs });
  storage.data.get = orig.dataGet;
  storage.data.set = orig.dataSet;
  Object.assign(sandboxArena, {
    open: orig.open,
    prepare: orig.prepare,
    start: orig.start,
    battleActive: orig.battleActive,
    resultPresent: orig.resultPresent,
    closeResult: orig.closeResult,
    closePreparation: orig.closePreparation,
  });
});

test('面板集成：注册、默认关闭、只观测原生 1660/3223 req/resp', () => {
  assert.ok(collectFeatureIds({ children: MENU }).includes('sandboxDrill'));
  const spec = reactor.list().find((s) => s.id === 'sandboxDrill');
  assert.equal(spec.defaults.enabled, false);
  assert.ok(subscribed.some(([kind, cmd]) => kind === 'req' && cmd === 1660));
  assert.ok(subscribed.some(([kind, cmd]) => kind === 'req' && cmd === 3223));
});

test('1661 V1 空载荷：只经真实 open→prepare→start，不直发 1660/3223', async () => {
  assert.equal(await feat.cycleRun(), 5000);
  assert.deepEqual(sent, [{ cmd: 1661, data: {}, protocol: 'send' }]);
  assert.deepEqual(
    actions.map((a) => a[0]),
    ['open', 'prepare', 'start'],
  );
  assert.equal(actions[0][1].time, 5);
});

test('time=0：落日戳且不打开战斗 UI', async () => {
  respond = () => ({ ok: true, code: 0, data: { time: 0 } });
  assert.ok((await feat.cycleRun()) > 0);
  assert.equal(stamps.get('sandboxDrill.resolved').resetTs, nextReset());
  assert.equal(actions.length, 0);
});

test('CODE_NOT_SENT/畸形应答：不打开 UI、不落成功日戳', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await feat.cycleRun(), 20000);
  respond = () => ({ ok: true, code: 0, data: '{}' });
  assert.equal(await feat.cycleRun(), 15 * 60 * 1000);
  assert.equal(stamps.size, 0);
  assert.equal(actions.length, 0);
});

test('业务拒绝：带 code 重试，不谎报完成', async () => {
  respond = () => ({ ok: false, code: 1001, data: '<not_open>' });
  assert.equal(await feat.cycleRun(), 15 * 60 * 1000);
  assert.equal(stamps.size, 0);
});

test('战斗面板仍在场/挑战在途：不查询也不重复发起', async () => {
  battleActive = true;
  assert.equal(await feat.cycleRun(), 5000);
  battleActive = false;
  inFlight = true;
  assert.equal(await feat.cycleRun(), 5000);
  assert.equal(sent.length, 0);
});

test('本功能结算页：关闭后下一拍重查，不直接连发', async () => {
  await feat.cycleRun();
  resultPresent = true;
  sent = [];
  assert.equal(await feat.cycleRun(), 1000);
  assert.ok(actions.some((a) => a[0] === 'closeResult'));
  assert.equal(sent.length, 0);
});

test('native start 拒绝：不伪造挑战载荷、不增加次数、不落日戳', async () => {
  sandboxArena.start = () => ({ ok: false, reason: 'real-attackers-unavailable' });
  assert.equal(await feat.cycleRun(), 20000);
  assert.equal(stamps.size, 0);
  assert.equal(sent.filter((s) => s.cmd === 1660 || s.cmd === 3223).length, 0);
  assert.ok(actions.some((a) => a[0] === 'closePreparation'));
});

test('StartFight 返回成功但未观察到 req：不计次数、关准备页、20 秒后重试', async () => {
  sandboxArena.start = () => (actions.push(['start']), { ok: true });
  assert.equal(await feat.cycleRun(), 20000);
  assert.equal(stamps.size, 0);
  assert.ok(actions.some((a) => a[0] === 'closePreparation'));
  assert.equal(actions.filter((a) => a[0] === 'start').length, 1);
});

test('原生应答按 reqTime 精确配对：错配不解除未知锁，余额不降绝不重发', async () => {
  await feat.cycleRun();
  const ownReqTs = reqClock;
  emitResp(0, 1660, ownReqTs - 1);
  sent = [];
  actions.length = 0;
  assert.equal(await feat.cycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [1661],
  );
  assert.equal(actions.length, 0);
  assert.equal(stamps.size, 0);
});

test('原生应答 status 非有限值：视为未知，保持防重发锁且不关准备页', async () => {
  await feat.cycleRun();
  emitResp(Number.NaN);
  sent = [];
  actions.length = 0;
  assert.equal(await feat.cycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [1661],
  );
  assert.equal(actions.length, 0);
  assert.equal(stamps.size, 0);
  sent = [];
  assert.equal(await feat.cycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [1661],
  );
});

test('原生业务拒绝：不计次数、关准备页，下一轮可重新查询发起', async () => {
  await feat.cycleRun();
  emitResp(1001);
  sent = [];
  actions.length = 0;
  assert.equal(await feat.cycleRun(), 20000);
  assert.ok(actions.some((a) => a[0] === 'closePreparation'));
  assert.equal(stamps.size, 0);
  await feat.cycleRun();
  assert.equal(actions.filter((a) => a[0] === 'start').length, 1);
});

test('原生应答未知但 1661 余额下降：确认消耗后放行下一轮', async () => {
  respond = () => ({ ok: true, code: 0, data: { time: remaining } });
  await feat.cycleRun();
  remaining = 4;
  sent = [];
  actions.length = 0;
  assert.equal(await feat.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [1661],
  );
  assert.equal(actions.length, 0);
  await feat.cycleRun();
  assert.equal(actions.filter((a) => a[0] === 'start').length, 1);
});

test('完整五次循环：只确认服务器余额消耗，第五次后落当日日戳', async () => {
  respond = () => ({ ok: true, code: 0, data: { time: remaining } });
  for (let i = 0; i < 5; i++) {
    assert.equal(await feat.cycleRun(), 5000);
    remaining--;
    reqClock++;
    emitResp(0);
    assert.equal(await feat.cycleRun(), 1000);
  }
  assert.ok((await feat.cycleRun()) > 0);
  assert.equal(actions.filter((a) => a[0] === 'start').length, 5);
  assert.equal(stamps.get('sandboxDrill.resolved').resetTs, nextReset());
  assert.equal(sent.filter((s) => s.cmd === 1660 || s.cmd === 3223).length, 0);
});

test('刷新后归属未知的结算页：不关闭、不叠开挑战', async () => {
  resultPresent = true;
  assert.equal(await feat.cycleRun(), 5000);
  assert.equal(sent.length, 0);
  assert.equal(actions.length, 0);
});

test('刷新回读日戳后首拍零查询；跨日自动解禁', async () => {
  respond = () => ({ ok: true, code: 0, data: { time: 0 } });
  await feat.cycleRun();
  sent = [];
  feat.resetForTest();
  await feat.loadStampForTest();
  await feat.cycleRun();
  assert.equal(sent.length, 0);
  now = nextReset() + 120;
  respond = () => ({ ok: true, code: 0, data: { time: 5 } });
  sent = [];
  feat.resetForTest();
  await feat.cycleRun();
  assert.equal(sent[0].cmd, 1661);
});
