// createDrain（串行消费器）不变量单测：mock timers 驱动条间 sleep，零真实时钟。
// 覆盖：逐条按序消费 + 条间 interval、alive()=false 边界自然收手且不清空队列、
// 单条 process 抛错不中断整轮、consuming 单入闸门（重入不并发起第二个循环）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDrain } from '../../extension/src/core/drain.js';

const silentLog = { info() {}, debug() {}, warn() {} };

function flush() {
  return new Promise((r) => setImmediate(r));
}

test('createDrain：按序逐条消费，条间按 interval 排程', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  const arr = [1, 2, 3];
  const seen = [];
  const d = createDrain({
    log: silentLog,
    queue: { get: () => arr },
    alive: () => true,
    interval: () => 100,
    process: async (id) => {
      seen.push(id);
    },
  });

  const p = d.consume();
  await flush();
  assert.deepEqual(seen, [1], '首条应被消费，随后进入条间 sleep');

  mock.timers.tick(100);
  await flush();
  assert.deepEqual(seen, [1, 2], 'interval 到点消费第二条');

  mock.timers.tick(100);
  await flush();
  assert.deepEqual(seen, [1, 2, 3], '消费第三条后队列空、循环自然结束');

  await p;
  assert.equal(arr.length, 0, '全部出队');
});

test('createDrain：alive()=false 在当前条边界收手，且不清空剩余队列', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  const arr = [1, 2, 3];
  const seen = [];
  let alive = true;
  const d = createDrain({
    log: silentLog,
    queue: { get: () => arr },
    alive: () => alive,
    interval: () => 100,
    process: async (id) => {
      seen.push(id);
    },
  });

  d.consume();
  await flush(); // 消费 1，进入 sleep
  assert.deepEqual(seen, [1]);

  alive = false; // sleep 期间关停
  mock.timers.tick(100);
  await flush();
  assert.deepEqual(seen, [1], 'alive 置否后不再消费下一条');
  assert.deepEqual(arr, [2, 3], '剩余项留在队列（pause 不清空）');
});

test('createDrain：单条 process 抛错不中断整轮消费', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  const arr = [1, 2, 3];
  const seen = [];
  const d = createDrain({
    log: silentLog,
    queue: { get: () => arr },
    alive: () => true,
    interval: () => 100,
    process: async (id) => {
      seen.push(id);
      if (id === 2) throw new Error('boom'); // 中间条抛错
    },
  });

  const p = d.consume();
  await flush();
  mock.timers.tick(100);
  await flush();
  mock.timers.tick(100);
  await flush();

  await p; // consume 应正常 resolve，不被单条异常打断
  assert.deepEqual(seen, [1, 2, 3], '抛错条之后仍继续消费');
});

test('createDrain：consuming 单入闸门 —— 在飞期间重入不并发起第二个循环', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  const arr = [1, 2];
  const seen = [];
  const d = createDrain({
    log: silentLog,
    queue: { get: () => arr },
    alive: () => true,
    interval: () => 100,
    process: async (id) => {
      seen.push(id);
    },
  });

  d.consume();
  await flush(); // 消费 1，进入 sleep（consuming 仍为真）
  d.consume(); // 重入应立即返回，不并发
  await flush();
  assert.deepEqual(seen, [1], '重入 consume 不得并发处理（单入闸门）');

  mock.timers.tick(100);
  await flush();
  assert.deepEqual(seen, [1, 2], '原循环继续，最终全部消费');
});
