// createSnapshotPool（快照池 D 原语）不变量单测：用 node:test mock timers（含 Date）驱动，零真实时钟、可重复。
// 覆盖池承诺的四条跨 feat 不变量：键控去重（拒入不续命）、TTL 惰性过期、wake.at 托管唤醒、一次性消耗（抛错也出池），
// 外加 pause 清定时器保留条目 / resume reschedule 重排续跑。断言的是"池契约"，不含具体 feat 业务闸门。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotPool } from '../../extension/src/core/snapshot-pool.js';

/** 静音 logger：池会 warn，测试不关心日志内容，吞掉以免刷屏 */
const silentLog = { info() {}, debug() {}, warn() {} };

/** 冲刷微任务队列（mock timers 下 setImmediate 未被劫持，可用作 tick 之间的屏障） */
function flush() {
  return new Promise((r) => setImmediate(r));
}

/**
 * 仿 reactor ctx 的定时器托管面：running=false 时 setTimeout 返 -1；pause() 清光全部托管定时器。
 * @returns {object} {running, setTimeout, clearTimeout, pause}
 */
function makeCtx() {
  const timers = new Map();
  let nextId = 1;
  const ctx = {
    running: true,
    setTimeout: function (fn, ms) {
      if (!ctx.running) return -1;
      const id = nextId++;
      const handle = setTimeout(function () {
        timers.delete(id);
        fn();
      }, ms);
      timers.set(id, handle);
      return id;
    },
    clearTimeout: function (id) {
      const h = timers.get(id);
      if (h == null) return;
      clearTimeout(h);
      timers.delete(id);
    },
    pause: function () {
      ctx.running = false;
      timers.forEach(function (h) {
        clearTimeout(h);
      });
      timers.clear();
    },
  };
  return ctx;
}

test('createSnapshotPool：键控去重 —— 同键在池拒入，消耗后可再入', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  const wakes = [];
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: (key, payload) => wakes.push({ key, payload }),
  });

  const now = Date.now();
  assert.equal(pool.offer('t1', { v: 1 }, { wakeAt: now + 1000 }), true, '首次入池应成功');
  assert.equal(pool.offer('t1', { v: 2 }, { wakeAt: now + 1000 }), false, '同键在池应拒入');
  assert.equal(pool.size(), 1, '拒入不得新增条目');

  mock.timers.tick(1000);
  await flush();
  assert.deepEqual(wakes, [{ key: 't1', payload: { v: 1 } }], '只消耗首次入池的载荷');
  assert.equal(pool.size(), 0, '消耗后应出池');

  assert.equal(pool.offer('t1', { v: 3 }, { wakeAt: Date.now() + 1000 }), true, '出池后同键可再入');
  ctx.pause(); // 收尾：清掉在飞定时器
});

test('createSnapshotPool：拒入不续命 —— 重复 offer 不得重置唤醒时刻', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  const wakes = [];
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: (key) => wakes.push(key),
  });

  const now = Date.now();
  pool.offer('t1', null, { wakeAt: now + 1000 });
  pool.offer('t1', null, { wakeAt: now + 100 }); // 更短的延迟不得生效

  mock.timers.tick(100);
  await flush();
  assert.equal(wakes.length, 0, '重复 offer 不得把唤醒提前');
  mock.timers.tick(900);
  await flush();
  assert.deepEqual(wakes, ['t1'], '仍按首次入池的时刻唤醒一次');
});

test('createSnapshotPool：TTL 惰性过期 —— 已过期拒入、延迟期内过期到点剔除', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  const wakes = [];
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: (key) => wakes.push(key),
  });

  // mock 时钟从 0 起算：先 tick 到正时刻再取 now，用 now-500 构造「已过期」（避免负值被当「不过期」哨兵）
  mock.timers.tick(1000);
  const now = Date.now();
  assert.equal(pool.offer('dead', null, { expireAt: now - 500 }), false, 'expireAt 已过应拒入');
  assert.equal(pool.size(), 0);

  pool.offer('late', null, { wakeAt: now + 500, expireAt: now + 300 });
  mock.timers.tick(500);
  await flush();
  assert.equal(wakes.length, 0, '延迟期内过期：到点不得调 onWake');
  assert.equal(pool.size(), 0, '过期条目应被剔除');

  pool.offer('ok', null, { wakeAt: now + 1000, expireAt: now + 2000 });
  mock.timers.tick(1000);
  await flush();
  assert.deepEqual(wakes, ['ok'], '未过期条目正常消耗');
});

test('createSnapshotPool：wake.at 时序 —— 缺省立即、到点才醒', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  const wakes = [];
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: (key) => wakes.push(key),
  });

  pool.offer('soon', null, {}); // wakeAt 缺省 → 0ms 立即（让同步栈先落地）
  assert.equal(wakes.length, 0, '0ms 也要走定时器，同步栈内不得抢跑');
  mock.timers.tick(0);
  await flush();
  assert.deepEqual(wakes, ['soon']);

  pool.offer('later', null, { wakeAt: Date.now() + 1000 });
  mock.timers.tick(999);
  await flush();
  assert.equal(wakes.length, 1, '未到点不得醒');
  mock.timers.tick(1);
  await flush();
  assert.deepEqual(wakes, ['soon', 'later'], '到点即醒');
});

test('createSnapshotPool：一次性消耗 —— onWake 抛错也出池，同键可再入', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  let calls = 0;
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: () => {
      calls++;
      throw new Error('boom');
    },
  });

  pool.offer('t1', null, {});
  mock.timers.tick(0);
  await flush();
  assert.equal(calls, 1);
  assert.equal(pool.size(), 0, '抛错也必须出池（已处理不可回滚）');
  assert.equal(pool.offer('t1', null, {}), true, '出池后同键可再入（重试归调用方）');
  mock.timers.tick(0);
  await flush();
  assert.equal(calls, 2);
});

test('createSnapshotPool：非运行态/无 ctx/托管失败一律拒入，不留孤儿条目', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: () => {},
  });

  ctx.pause(); // running=false
  assert.equal(pool.offer('t1', null, {}), false, '非运行态拒入');
  ctx.running = true;

  const noCtxPool = createSnapshotPool({
    alive: () => true,
    ctx: () => null,
    log: silentLog,
    onWake: () => {},
  });
  assert.equal(noCtxPool.offer('t1', null, {}), false, '无 ctx 拒入');

  // 托管失败（alive 谎报 true 但 ctx 非激活返 -1）：不得留无唤醒的孤儿条目
  const lyingPool = createSnapshotPool({
    alive: () => true,
    ctx: () => ctx,
    log: silentLog,
    onWake: () => {},
  });
  ctx.pause();
  assert.equal(lyingPool.offer('t2', null, {}), false, '托管失败拒入');
  assert.equal(lyingPool.size(), 0, '不得留孤儿条目');
});

test('createSnapshotPool：pause 清定时器保留条目，resume reschedule 重排续跑', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  const wakes = [];
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: (key) => wakes.push(key),
  });

  const now = Date.now();
  pool.offer('past', null, { wakeAt: now + 500, expireAt: now + 10000 });
  pool.offer('future', null, { wakeAt: now + 5000, expireAt: now + 10000 });
  pool.offer('expired', null, { wakeAt: now + 500, expireAt: now + 800 });

  ctx.pause(); // reactor pause：托管定时器清光，池条目保留
  assert.equal(pool.size(), 3, 'pause 不清池');
  mock.timers.tick(2000);
  await flush();
  assert.equal(wakes.length, 0, 'pause 期间不得唤醒');

  ctx.running = true; // resume
  pool.reschedule();
  assert.equal(pool.size(), 2, 'reschedule 剔除已过期条目（expired）');
  mock.timers.tick(0);
  await flush();
  assert.deepEqual(wakes, ['past'], 'wakeAt 已过的条目立即补跑');
  mock.timers.tick(3000);
  await flush();
  assert.deepEqual(wakes, ['past', 'future'], '未到期条目按剩余时长续跑（5000-2000）');
});

test('createSnapshotPool：has/size 诊断面与 reschedule 幂等', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());

  const ctx = makeCtx();
  const wakes = [];
  const pool = createSnapshotPool({
    alive: () => ctx.running,
    ctx: () => ctx,
    log: silentLog,
    onWake: (key) => wakes.push(key),
  });

  const now = Date.now();
  pool.offer('t1', null, { wakeAt: now + 1000 });
  assert.equal(pool.has('t1'), true);
  assert.equal(pool.has('nope'), false);
  assert.equal(pool.size(), 1);

  pool.reschedule(); // 未 pause 直接重排：不得重复唤醒
  pool.reschedule();
  mock.timers.tick(1000);
  await flush();
  assert.deepEqual(wakes, ['t1'], '重复 reschedule 不得造成重复消耗');
  assert.equal(pool.size(), 0);
});
