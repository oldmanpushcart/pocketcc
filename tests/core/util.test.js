// core/util.js 的 createWaker（可提前结束的休眠原语）单测：
// 到点自然醒 vs 被叫醒的返回值口径、无在飞等待时 wake 空操作、叫醒后不留悬挂 timer、
// 违反单飞约定（并发 pause）时旧等待按「被叫醒」收口而非永挂。
// util.js 是零 import 叶子，无需桩化浏览器全局。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWaker } from '../../extension/src/core/util.js';

/** 当前事件循环上的 Timer 句柄数（断言 wake 把原 timer 清掉了） */
const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

/** 让出若干个宏任务 tick（不引入被测模块之外的依赖） */
const tick = (n = 1) =>
  new Promise((resolve) => {
    let i = n;
    const step = () => (i-- > 0 ? setTimeout(step, 0) : resolve());
    step();
  });

test('createWaker：睡满到点 resolve(false)，句柄随之清空', async () => {
  const w = createWaker();
  const t0 = Date.now();
  const woken = await w.pause(20);
  assert.equal(woken, false, '没人叫醒就是「睡满」，不是被提前结束');
  assert.ok(Date.now() - t0 >= 15, '未到点不得提前 resolve');
  assert.equal(w.wake(), false, '到点后 wake 应为空操作');
});

test('createWaker：wake 提前结束等待并 resolve(true)', async () => {
  const w = createWaker();
  const before = timers();
  const p = w.pause(5000);
  const during = timers();
  assert.ok(during >= before + 1, '在飞等待应挂着一个 timer');
  assert.equal(w.wake(), true, '有人在等，wake 须报告真的叫醒了');
  assert.equal(await p, true, '被提前叫醒时 pause resolve(true)');
  assert.ok(timers() <= during - 1, 'wake 必须 clearTimeout，不留 5s 空转 timer');
});

test('createWaker：没有在飞等待时 wake 返回 false（不抛、不记仇）', async () => {
  const w = createWaker();
  assert.equal(w.wake(), false);
  // 空 wake 之后仍可正常排一次短睡
  assert.equal(await w.pause(0), false);
});

test('createWaker：并发 pause 时旧等待按被叫醒收口（不留永挂 Promise）', async () => {
  const w = createWaker();
  const first = w.pause(5000);
  const second = w.pause(10);
  assert.equal(await first, true, '被第二次 pause 收口为「提前结束」');
  assert.equal(await second, false, '第二次自己睡满');
  await tick();
  assert.equal(w.wake(), false, '两次都结束后不残留句柄');
});
