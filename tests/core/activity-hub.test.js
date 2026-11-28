import test from 'node:test';
import assert from 'node:assert/strict';

// core/net.js 在模块评估时挂 window.pocketcc，Node 测试需先提供最小 window 再动态加载。
globalThis.window = globalThis.window || {};
const { createActivityHub } = await import('../../extension/src/core/activity-hub.js');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 假事件总线：记录订阅并在 emit 时同步派发。
 * @returns {object} bus 桩
 */
function makeBus() {
  const handlers = new Map();
  return {
    on(type, fn) {
      handlers.set(type, fn);
      return function () {
        handlers.delete(type);
      };
    },
    emit(type, ev) {
      const fn = handlers.get(type);
      if (fn) fn(ev);
    },
    has(type) {
      return handlers.has(type);
    },
  };
}

/**
 * 假 net：按 cmd 返回预设应答，记录调用。
 * @param {object} responses cmd -> Ret | function(body)->Ret
 * @returns {object} net 桩
 */
function makeNet(responses) {
  const calls = [];
  return {
    calls: calls,
    responses: responses,
    async sendGuarded(cmd, body) {
      calls.push({ cmd: cmd, body: body });
      const r = responses[cmd];
      if (typeof r === 'function') return r(body);
      return r || { ok: false, code: 1, data: null };
    },
  };
}

/**
 * 等待一轮宏任务，让 hub 的异步扫描落地。
 * @returns {Promise<void>}
 */
function flush() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

/**
 * 造一个已启动的 hub（841 返回两条活动）。
 * @returns {object} {hub, bus, net, detach}
 */
async function setup() {
  const bus = makeBus();
  const net = makeNet({
    841: {
      ok: true,
      code: 0,
      data: {
        alist: [
          { id: 1, type: 335, showUiType: 'X', extra: { a: 1 } },
          { id: '2', type: 336, showUiType: 'Y' },
        ],
      },
    },
  });
  const hub = createActivityHub({
    getBus: function () {
      return bus;
    },
    getNet: function () {
      return net;
    },
    log: quiet,
    scanMinGapMs: 0,
    refreshMinGapMs: 0,
  });
  const detach = hub.attach({ label: 'test' });
  await flush();
  return { hub: hub, bus: bus, net: net, detach: detach };
}

test('attach 首扫 841，String(id) 索引，detach 清空', async function () {
  const s = await setup();
  assert.equal(s.net.calls.filter((c) => c.cmd === 841).length, 1);
  assert.equal(s.hub.list().length, 2);
  assert.equal(s.hub.get(1).showUiType, 'X');
  assert.equal(s.hub.get('2').type, 336);
  assert.equal(s.hub.getByType(335).id, 1);
  assert.equal(s.hub.getByUiType('Y').id, '2');
  s.detach();
  assert.equal(s.hub.stats().activities, 0);
  assert.equal(s.hub.stats().refs, 0);
});

test('10912 命中快照：合并 extra 并分发', async function () {
  const s = await setup();
  const seen = [];
  s.hub.watch(
    function (a) {
      return a.showUiType === 'X';
    },
    function (a, reason) {
      seen.push({ extra: a.extra, reason: reason });
    },
    { label: 'w' },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'watch');
  s.bus.emit('net.10912', { data: { aid: 1, extra: { b: 2 } } });
  assert.deepEqual(s.hub.get(1).extra, { a: 1, b: 2 });
  assert.equal(seen[seen.length - 1].reason, 'push-extra');
  assert.equal(seen[seen.length - 1].extra.b, 2);
  s.detach();
});

test('10912 未知活动：3103 单查后入快照', async function () {
  const bus = makeBus();
  const net = makeNet({
    841: { ok: true, code: 0, data: { alist: [] } },
    3103: function (body) {
      return {
        ok: true,
        code: 0,
        data: { id: body.id, type: 335, showUiType: 'X', extra: { b: 9 } },
      };
    },
  });
  const hub = createActivityHub({
    getBus: function () {
      return bus;
    },
    getNet: function () {
      return net;
    },
    log: quiet,
    scanMinGapMs: 0,
    refreshMinGapMs: 0,
  });
  const detach = hub.attach({ label: 'test' });
  await flush();
  bus.emit('net.10912', { data: { aid: '99', extra: { b: 9 } } });
  await flush();
  assert.equal(net.calls.filter((c) => c.cmd === 3103).length, 1);
  assert.equal(hub.get('99').extra.b, 9);
  detach();
});

test('10912 先于 841：extra 暂存，下一轮 841 合并', async function () {
  const bus = makeBus();
  const net = makeNet({
    841: { ok: true, code: 0, data: { alist: [] } },
    3103: { ok: false, code: 1, data: null },
  });
  const hub = createActivityHub({
    getBus: function () {
      return bus;
    },
    getNet: function () {
      return net;
    },
    log: quiet,
    scanMinGapMs: 0,
    refreshMinGapMs: 0,
  });
  const detach = hub.attach({ label: 'test' });
  await flush();
  bus.emit('net.10912', { data: { aid: '7', extra: { b: 2 } } });
  await flush();
  assert.equal(hub.stats().pending, 1);
  net.responses[841] = { ok: true, code: 0, data: { alist: [{ id: '7', extra: { a: 1 } }] } };
  await hub.scan();
  assert.deepEqual(hub.get('7').extra, { a: 1, b: 2 });
  assert.equal(hub.stats().pending, 0);
  detach();
});

test('订阅者抛错隔离：坏订阅不拖垮好订阅', async function () {
  const s = await setup();
  const seen = [];
  s.hub.watch(
    function () {
      return true;
    },
    function () {
      throw new Error('boom');
    },
    { label: 'bad' },
  );
  s.hub.watch(
    function () {
      return true;
    },
    function (a) {
      seen.push(a.id);
    },
    { label: 'good' },
  );
  s.bus.emit('net.10912', { data: { aid: 1, extra: { b: 2 } } });
  assert.ok(seen.length > 0);
  s.detach();
});

test('引用计数：末个 detach 退订清快照，再次 attach 重扫', async function () {
  const s = await setup();
  const second = s.hub.attach({ label: 'second', scanIntervalMs: 1000 });
  await flush();
  assert.equal(s.net.calls.filter((c) => c.cmd === 841).length, 1);
  s.detach();
  assert.equal(s.hub.stats().refs, 1);
  second();
  assert.equal(s.hub.stats().refs, 0);
  assert.equal(s.hub.stats().activities, 0);
  assert.equal(s.bus.has('net.10912'), false);
  const third = s.hub.attach({ label: 'third' });
  await flush();
  assert.equal(s.net.calls.filter((c) => c.cmd === 841).length, 2);
  third();
});

test('tune：只改目标订阅者档位，实际周期取全订阅者最小非零档', async function () {
  const s = await setup();
  assert.equal(s.hub.stats().scanEveryMs, 0);
  const a = s.hub.attach({ label: 'a', scanIntervalMs: 1000 });
  assert.equal(s.hub.stats().scanEveryMs, 1000);
  const b = s.hub.attach({ label: 'b', scanIntervalMs: 0 });
  assert.equal(s.hub.stats().scanEveryMs, 1000);
  // 放宽 b 不影响 a 的 1s 档
  assert.equal(s.hub.tune('b', 3000), 1);
  assert.equal(s.hub.stats().scanEveryMs, 1000);
  // 放宽 a 后周期落到 b 的 3s
  assert.equal(s.hub.tune('a', 30000), 1);
  assert.equal(s.hub.stats().scanEveryMs, 3000);
  // 未命中不报错、不改周期
  assert.equal(s.hub.tune('missing', 100), 0);
  assert.equal(s.hub.stats().scanEveryMs, 3000);
  // 回到 0=不声明：周期只剩 b
  assert.equal(s.hub.tune('a', 0), 1);
  assert.equal(s.hub.stats().scanEveryMs, 3000);
  a();
  b();
  assert.equal(s.hub.stats().scanEveryMs, 0);
  s.detach();
});

test('841 最小间隔：第二次 scan 被节流', async function () {
  const bus = makeBus();
  const net = makeNet({ 841: { ok: true, code: 0, data: { alist: [] } } });
  const hub = createActivityHub({
    getBus: function () {
      return bus;
    },
    getNet: function () {
      return net;
    },
    log: quiet,
  });
  const detach = hub.attach({ label: 'test' });
  await flush();
  const before = net.calls.filter((c) => c.cmd === 841).length;
  const ok = await hub.scan();
  assert.equal(ok, false);
  assert.equal(net.calls.filter((c) => c.cmd === 841).length, before);
  detach();
});

test('3103 单飞：同活动并发 refresh 只发一次', async function () {
  const s = await setup();
  let resolveRefresh = null;
  s.net.responses[3103] = function () {
    return new Promise(function (resolve) {
      resolveRefresh = resolve;
    });
  };
  const p1 = s.hub.refresh(1);
  const p2 = s.hub.refresh(1);
  resolveRefresh({
    ok: true,
    code: 0,
    data: { id: 1, type: 335, showUiType: 'X', extra: { z: 3 } },
  });
  await Promise.all([p1, p2]);
  assert.equal(s.net.calls.filter((c) => c.cmd === 3103).length, 1);
  assert.equal(s.hub.get(1).extra.z, 3);
  s.detach();
});

test('refresh force：跳过 3s 节流窗，仍不绕过单飞', async function () {
  const bus = makeBus();
  const net = makeNet({
    841: {
      ok: true,
      code: 0,
      data: { alist: [{ id: 1, type: 335, showUiType: 'X', extra: { a: 1 } }] },
    },
    3103: function (body) {
      return {
        ok: true,
        code: 0,
        data: { id: body.id, type: 335, showUiType: 'X', extra: { a: 2 } },
      };
    },
  });
  const hub = createActivityHub({
    getBus: function () {
      return bus;
    },
    getNet: function () {
      return net;
    },
    log: quiet,
    scanMinGapMs: 0,
  });
  const detach = hub.attach({ label: 'test' });
  await flush();
  await hub.refresh(1);
  assert.equal(net.calls.filter((c) => c.cmd === 3103).length, 1);
  // 3s 节流窗内不带 force：直接返回当前快照，不发 3103
  await hub.refresh(1);
  assert.equal(net.calls.filter((c) => c.cmd === 3103).length, 1);
  // force：跳过时间窗
  const again = await hub.refresh(1, { force: true });
  assert.equal(net.calls.filter((c) => c.cmd === 3103).length, 2);
  assert.equal(again.extra.a, 2);
  // force 仍需遵守单飞：在飞时复用同一 promise
  let resolveRefresh = null;
  net.responses[3103] = function () {
    return new Promise(function (resolve) {
      resolveRefresh = resolve;
    });
  };
  const p1 = hub.refresh(1, { force: true });
  const p2 = hub.refresh(1, { force: true });
  resolveRefresh({
    ok: true,
    code: 0,
    data: { id: 1, type: 335, showUiType: 'X', extra: { a: 3 } },
  });
  await Promise.all([p1, p2]);
  assert.equal(net.calls.filter((c) => c.cmd === 3103).length, 3);
  detach();
});

test('841 整表替换保留旧 extra 增量字段（裁剪版 extra 不洗掉 10912 合并值）', async function () {
  const s = await setup();
  s.bus.emit('net.10912', { data: { aid: 1, extra: { state: 3, can_receive_uid_list: ['u1'] } } });
  assert.equal(s.hub.get(1).extra.state, 3);
  // 模拟第二轮 841：该活动的 extra 是裁剪版，只带 a（不携带 state/can_receive_uid_list）
  s.net.responses[841] = {
    ok: true,
    code: 0,
    data: { alist: [{ id: 1, type: 335, showUiType: 'X', extra: { a: 2 } }] },
  };
  await s.hub.scan();
  assert.equal(s.hub.get(1).extra.a, 2, '新值覆盖同键');
  assert.equal(s.hub.get(1).extra.state, 3, '旧增量字段保留');
  assert.deepEqual(s.hub.get(1).extra.can_receive_uid_list, ['u1']);
  s.detach();
});

test('stop 后旧 3103 应答不写入新快照', async function () {
  const s = await setup();
  let resolveRefresh = null;
  s.net.responses[3103] = function () {
    return new Promise(function (resolve) {
      resolveRefresh = resolve;
    });
  };
  const p = s.hub.refresh(1);
  s.detach();
  resolveRefresh({
    ok: true,
    code: 0,
    data: { id: 1, type: 335, showUiType: 'X', extra: { z: 3 } },
  });
  const got = await p;
  assert.equal(got, null);
  assert.equal(s.hub.get(1), undefined);
});
