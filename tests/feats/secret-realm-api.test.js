// secret-realm api.js 发包守卫取消语义契约单测：sendSecret/sendSecretJson 的可选 signal 参——
// abort 即收口（哨兵/null，与超时同口径）、已 aborted 信号立即收口、正常应答先 settle 后 abort 无副作用、
// 收口后移除 abort 监听（不泄漏）、无 signal 向后兼容。
// ACL 经 game.get 取 TMWatchNetMgr 单例，猴补注入假通道（同 cq26-excav 口径）；不发包、不摸真实游戏符号。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// ── 浏览器全局最小桩（模块加载期需要，函数体不触碰）─────────────────────
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

const { game } = await import('../../extension/src/core/game.js');
const { secretRealm } = await import('../../extension/src/feats/activity/secret-realm/api.js');

// ── 假次通道：sendPBV2/send 只捕获回调不上线，应答由用例手动触发 ─────────
/** @type {Function|null} 最近一次 sendPBV2 的应答回调 */
let pbCb = null;
/** @type {Function|null} 最近一次 send(JSON) 的应答回调 */
let jsonCb = null;
const fakeMgr = {
  sendPBV2(cmd, data, target, cb) {
    pbCb = cb;
  },
  send(cmd, data, target, cb) {
    jsonCb = cb;
  },
};
const realGameGet = game.get;
game.get = (name) =>
  name === 'TMWatchNetMgr' ? { __esModule: true, default: { Instance: fakeMgr } } : null;
after(() => {
  game.get = realGameGet;
});

/** 计 abort 监听挂/摘次数，验证收口后不泄漏 */
function spySignal() {
  const ac = new AbortController();
  const counts = { add: 0, remove: 0 };
  const realAdd = ac.signal.addEventListener.bind(ac.signal);
  const realRemove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = (t, fn, o) => {
    if (t === 'abort') counts.add++;
    return realAdd(t, fn, o);
  };
  ac.signal.removeEventListener = (t, fn, o) => {
    if (t === 'abort') counts.remove++;
    return realRemove(t, fn, o);
  };
  return { ac, counts };
}

test('sendSecret：在飞时 abort 即收口回哨兵 -1，并摘除监听', async () => {
  const { ac, counts } = spySignal();
  const p = secretRealm.sendSecret(8521, { x: 1, y: 2 }, ac.signal);
  assert.equal(counts.add, 1);
  ac.abort();
  const r = await p;
  assert.equal(r.code, -1);
  assert.equal(counts.remove, 1);
  // 迟到的应答不得二次 settle（settled 闸）
  pbCb({ pbAckV2: { header: { s: 0 }, data: { late: 1 } } });
  assert.equal((await p).code, -1);
});

test('sendSecret：已 aborted 的信号立即收口，不挂监听', async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await secretRealm.sendSecret(8521, null, ac.signal);
  assert.equal(r.code, -1);
});

test('sendSecret：正常应答先 settle，其后 abort 无副作用且监听已摘', async () => {
  const { ac, counts } = spySignal();
  const p = secretRealm.sendSecret(8521, null, ac.signal);
  pbCb({ pbAckV2: { header: { s: 0 }, data: { ok: 1 } } });
  const r = await p;
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(counts.remove, 1);
  ac.abort(); // 已 settle：不得改写结果
  assert.equal((await p).code, 0);
});

test('sendSecret：无 signal 向后兼容（应答/超时口径不变）', async () => {
  const p = secretRealm.sendSecret(8521, null);
  pbCb({ pbAckV2: { header: { s: 3, d: 'key.rejected' }, data: null } });
  const r = await p;
  assert.equal(r.code, 3);
  assert.equal(r.reason, 'key.rejected');
});

test('sendSecretJson：在飞时 abort 即收口回 null，并摘除监听', async () => {
  const { ac, counts } = spySignal();
  const p = secretRealm.sendSecretJson(901, {}, ac.signal);
  ac.abort();
  assert.equal(await p, null);
  assert.equal(counts.remove, 1);
});

test('sendSecretJson：正常应答解析 JSON 串，settle 后监听已摘', async () => {
  const { ac, counts } = spySignal();
  const p = secretRealm.sendSecretJson(901, {}, ac.signal);
  jsonCb({ s: 0, d: '{"pointList":[]}' });
  assert.deepEqual(await p, { pointList: [] });
  assert.equal(counts.remove, 1);
});
