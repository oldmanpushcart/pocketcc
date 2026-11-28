import test from 'node:test';
import assert from 'node:assert/strict';

// core/net.js 在模块评估时挂 window.pocketcc，Node 测试需先提供最小 window 再动态加载。
globalThis.window = globalThis.window || {};
const { createClaimRunner } = await import('../../extension/src/core/claim-runner.js');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 假 net：记录调用与选项，按预设返回。
 * @param {object} responses cmd -> Ret | function(body, opts)->Ret
 * @returns {object}
 */
function makeNet(responses) {
  const calls = [];
  return {
    calls: calls,
    responses: responses,
    async sendGuarded(cmd, body, opts) {
      calls.push({ cmd: cmd, body: body, opts: opts });
      const r = responses[cmd];
      if (typeof r === 'function') return r(body, opts);
      return r || { ok: false, code: 1, data: null };
    },
  };
}

test('register + claim：handler 生成载荷，成功后状态 ok', async function () {
  const net = makeNet({ 9657: { ok: true, code: 0, data: { items: [{ itemId: 1 }] } } });
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
    actionGapMs: 0,
  });
  runner.register(9657, {
    label: 'city',
    body: function (item) {
      return { activityId: item.aid, targetUidStr: item.targetId };
    },
    key: function (item) {
      return item.aid + ':' + item.targetId;
    },
  });
  const r = await runner.claim({ cmd: 9657, aid: 11, targetId: 'u1' });
  assert.equal(r.status, 'ok');
  assert.equal(net.calls.length, 1);
  assert.deepEqual(net.calls[0].body, { activityId: 11, targetUidStr: 'u1' });
  assert.equal(net.calls[0].opts.protocol, 'send');
  assert.equal(net.calls[0].opts.gate, true);
});

test('未注册协议：unregistered，不发包', async function () {
  const net = makeNet({});
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
  });
  const r = await runner.claim({ cmd: 9999, aid: 1 });
  assert.equal(r.status, 'unregistered');
  assert.equal(net.calls.length, 0);
});

test('业务拒绝后固定退避；confirm 清除', async function () {
  let clock = 1000;
  const net = makeNet({ 842: { ok: false, code: 7, reason: 'no' } });
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
    actionGapMs: 0,
    businessBackoffMs: 60000,
    now: function () {
      return clock;
    },
  });
  runner.register(842, { label: 'task' });
  const first = await runner.claim({ cmd: 842, aid: 1, targetId: 2 });
  assert.equal(first.status, 'rejected');
  runner.suppress({ cmd: 842, aid: 1, targetId: 2 });
  const second = await runner.claim({ cmd: 842, aid: 1, targetId: 2 });
  assert.equal(second.status, 'suppressed');
  assert.equal(net.calls.length, 1);
  clock += 60001;
  const third = await runner.claim({ cmd: 842, aid: 1, targetId: 2 });
  assert.equal(third.status, 'rejected');
  assert.equal(net.calls.length, 2);
  runner.confirm({ cmd: 842, aid: 1, targetId: 2 });
  clock += 1;
  const fourth = await runner.claim({ cmd: 842, aid: 1, targetId: 2 });
  assert.equal(fourth.status, 'rejected');
  assert.equal(net.calls.length, 3);
});

test('not-sent 视为 transient，不进入退避', async function () {
  const net = makeNet({ 842: { ok: false, code: -1 } });
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
    actionGapMs: 0,
  });
  runner.register(842, { label: 'task' });
  const r = await runner.claim({ cmd: 842, aid: 1 });
  assert.equal(r.status, 'transient');
  assert.equal(runner.isSuppressed({ cmd: 842, aid: 1 }), false);
});

test('noProgress 指数退避：20s → 40s → 封顶 5min', async function () {
  let clock = 0;
  const net = makeNet({ 1777: { ok: true, code: 0 } });
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
    actionGapMs: 0,
    noProgressBaseMs: 20000,
    noProgressMaxMs: 300000,
    now: function () {
      return clock;
    },
  });
  runner.register(1777, { label: 'score' });
  const item = { cmd: 1777, aid: 1 };
  runner.noProgress(item);
  assert.equal(runner.isSuppressed(item), true);
  clock += 20001;
  assert.equal(runner.isSuppressed(item), false);
  runner.noProgress(item);
  clock += 20001;
  assert.equal(runner.isSuppressed(item), true);
  clock += 20000;
  assert.equal(runner.isSuppressed(item), false);
  runner.noProgress(item);
  clock += 300001;
  assert.equal(runner.isSuppressed(item), false);
});

test('ACTION_GAP：两次 claim 真实间隔不小于声明值', async function () {
  const net = makeNet({ 9657: { ok: true, code: 0 } });
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
    actionGapMs: 40,
  });
  runner.register(9657, { label: 'city' });
  const t0 = Date.now();
  await runner.claim({ cmd: 9657, aid: 1 });
  await runner.claim({ cmd: 9657, aid: 2 });
  assert.ok(Date.now() - t0 >= 40);
});

test('signal 已中止：aborted，不发包', async function () {
  const net = makeNet({});
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
  });
  runner.register(9657, { label: 'city' });
  const ac = new AbortController();
  ac.abort();
  const r = await runner.claim({ cmd: 9657, aid: 1, signal: ac.signal });
  assert.equal(r.status, 'aborted');
  assert.equal(net.calls.length, 0);
});

test('net 未就绪：transient', async function () {
  const runner = createClaimRunner({
    getNet: function () {
      return null;
    },
    log: quiet,
    actionGapMs: 0,
  });
  runner.register(9657, { label: 'city' });
  const r = await runner.claim({ cmd: 9657, aid: 1 });
  assert.equal(r.status, 'transient');
});

test('reset：清空退避表与节奏时间戳', async function () {
  let clock = 0;
  const net = makeNet({ 9657: { ok: true, code: 0 } });
  const runner = createClaimRunner({
    getNet: function () {
      return net;
    },
    log: quiet,
    actionGapMs: 0,
    now: function () {
      return clock;
    },
  });
  runner.register(9657, { label: 'city' });
  clock = 5000;
  await runner.claim({ cmd: 9657, aid: 1 });
  runner.noProgress({ cmd: 9657, aid: 1 });
  assert.equal(runner.isSuppressed({ cmd: 9657, aid: 1 }), true);
  assert.equal(runner.stats().cooldowns, 1);
  assert.ok(runner.stats().lastClaimAt > 0);
  runner.reset();
  assert.equal(runner.isSuppressed({ cmd: 9657, aid: 1 }), false);
  assert.equal(runner.stats().cooldowns, 0);
  assert.equal(runner.stats().lastClaimAt, 0);
});
