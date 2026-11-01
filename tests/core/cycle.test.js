// createCycle（电平调和循环驱动器）不变量单测：用 node:test mock timers 驱动，零真实时钟、可重复。
// 覆盖驱动器承诺的四条跨 feat 不变量：单飞闸门、触发合并(pending)、绝不停摆(异常按 fallback 重排)、
// delay<=0 立即补扫 / alive()=false 自然终止。断言的是"驱动器契约"，不含具体 feat 择时曲线。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCycle } from '../../extension/src/core/cycle.js';

/** 静音 logger：驱动器会 info/warn，测试不关心日志内容，吞掉以免刷屏 */
const silentLog = { info() {}, debug() {}, warn() {} };

/** 冲刷微任务队列（mock timers 下 setImmediate 未被劫持，可用作 tick 之间的屏障） */
function flush() {
  return new Promise((r) => setImmediate(r));
}

test('createCycle：单飞闸门 + 在飞期间 kick 合并到 pending，不并发起第二轮', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  const resolvers = [];
  let started = 0;
  let cur = 0;
  let peak = 0;
  let alive = true;

  const c = createCycle({
    alive: () => alive,
    fallback: 1000,
    log: silentLog,
    run: async () => {
      started++;
      cur++;
      peak = Math.max(peak, cur);
      await new Promise((r) => resolvers.push(r));
      cur--;
      return 500; // 本轮结束后睡 500ms
    },
  });

  c.kick(); // 起第一轮
  await flush();
  assert.equal(started, 1, 'kick 应立即起一轮');
  assert.equal(c.inFlight, true, 'run 挂起时应处于在飞态');

  c.kick(); // 在飞期间再踢两脚，应被合并而非并发
  c.kick();
  await flush();
  assert.equal(started, 1, '在飞期间 kick 不得并发起第二轮（单飞闸门）');
  assert.equal(peak, 1, '任一时刻至多一个调和轮在飞');
  assert.equal(c.pending, true, '在飞期间的 kick 应置位 pending 供 run 读取');

  resolvers.shift()(); // 放行第一轮 → 返回 delay=500 → 排程
  await flush();
  assert.equal(started, 1, 'delay>0 不应立即补扫（交由排程）');

  mock.timers.tick(500); // 到点唤醒
  await flush();
  assert.equal(started, 2, '排程到点应起下一轮');
  alive = false; // 收尾：让后续不再跑，避免悬挂
  if (resolvers.length) resolvers.shift()();
});

test('createCycle：run 抛错绝不停摆 —— 按 fallback 自动重排', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let runs = 0;
  let alive = true;
  const c = createCycle({
    alive: () => alive,
    fallback: 1000,
    log: silentLog,
    run: async () => {
      runs++;
      throw new Error('boom'); // 每轮都抛
    },
  });

  c.kick();
  await flush();
  assert.equal(runs, 1, '首轮应执行');

  mock.timers.tick(1000); // fallback 到点
  await flush();
  assert.equal(runs, 2, '抛错后不应停摆：fallback 到点须再起一轮');

  mock.timers.tick(1000);
  await flush();
  assert.equal(runs, 3, '持续抛错仍持续重排（绝不永久停摆）');

  alive = false;
});

test('createCycle：delay<=0 立即补扫；alive()=false 停止排程与 kick', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let runs = 0;
  let alive = true;
  const c = createCycle({
    alive: () => alive,
    fallback: 1000,
    log: silentLog,
    run: async () => {
      runs++;
      if (runs >= 3) alive = false; // 跑满 3 轮后关停
      return alive ? 0 : 500; // 前几轮返回 0：立即补扫
    },
  });

  c.kick();
  await flush();
  assert.equal(runs, 3, 'delay<=0 应在同一宏任务链上立即连跑，不等排程');

  // alive=false 后 kick 应为 no-op
  const before = runs;
  c.kick();
  await flush();
  assert.equal(runs, before, 'alive()=false 时 kick 不得起新轮');
});

test('createCycle：排程后 wakeAt 诊断面可读（≈ Date.now()+delay）', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let alive = true;
  let runs = 0;
  const c = createCycle({
    alive: () => alive,
    fallback: 1000,
    log: silentLog,
    run: async () => {
      runs++;
      return 800;
    },
  });
  c.kick();
  await flush();
  assert.equal(runs, 1);
  // cycle 用真实 Date.now 锚 wakeAt（未劫持 Date），给 ±50ms 容差
  assert.ok(c.wakeAt > 0, '排程后 wakeAt 应为正数');
  assert.ok(
    Math.abs(c.wakeAt - (Date.now() + 800)) <= 50,
    `wakeAt 应≈Date.now()+800，实得 ${c.wakeAt}`,
  );
  alive = false;
});
