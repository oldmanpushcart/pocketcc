// 901 视口自适应降频离线单测（四-1：view-throttle.js 纯判据层契约）。
// 零 import 叶子，静态 import 即可（无需浏览器桩）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewIdleNow,
  viewWaitMs,
  viewFreshWinMs,
} from '../../extension/src/feats/activity/secret-realm/view-throttle.js';

const T = { driveViewMs: 3000, driveViewIdleMs: 12000, driveMarchStaleMs: 15000 };

test('viewIdleNow：WORK 驻留/bossWait 让路/无候选静默 → 空闲；empty 判空与决策拍不空闲', () => {
  const base = { workMode: '', bossFeeding: false, teamType: 1, idleSince: 0 };
  assert.equal(viewIdleNow(base), false); // 常规决策拍
  assert.equal(viewIdleNow({ ...base, workMode: 'dwell' }), true); // WORK 驻留
  assert.equal(viewIdleNow({ ...base, workMode: 'empty' }), false); // B4 判空要新鲜视口，不降频
  assert.equal(viewIdleNow({ ...base, bossFeeding: true }), true); // bossWait（teamType>0）
  assert.equal(viewIdleNow({ ...base, bossFeeding: true, teamType: 0 }), false); // 与 plans bossWait.when 同口径
  assert.equal(viewIdleNow({ ...base, idleSince: 123 }), true); // 无候选静默期
});

test('viewWaitMs：决策拍 3s；空闲 12s；kick 旁路位强制恢复 3s', () => {
  assert.equal(viewWaitMs(T, false, false), 3000);
  assert.equal(viewWaitMs(T, true, false), 12000);
  assert.equal(viewWaitMs(T, true, true), 3000); // kick 立即恢复
  assert.equal(viewWaitMs(T, false, true), 3000);
  // 配置防御：idle 配得比 base 小不得把决策拍口径拉低
  assert.equal(viewWaitMs({ driveViewMs: 3000, driveViewIdleMs: 1000 }, true, false), 3000);
  // 缺省回退与旧口径一致
  assert.equal(viewWaitMs({}, false, false), 3000);
  assert.equal(viewWaitMs({}, true, false), 12000);
});

test('viewFreshWinMs：盖得住降频最老快照（idle+base），且不低于旧口径 max(3×base, marchStale)', () => {
  assert.equal(viewFreshWinMs(T), 15000); // max(9000, 15000, 12000+3000)
  assert.equal(viewFreshWinMs({ ...T, driveViewIdleMs: 15000 }), 18000); // 15s 降频 → 18s 窗
  assert.equal(viewFreshWinMs({ ...T, driveMarchStaleMs: 30000 }), 30000); // 在途过滤尺更大时跟它
  assert.equal(viewFreshWinMs({}), 15000); // 全缺省回退旧口径
  // 降频间隔再大，窗口也必须 >= idle+base（窄筛不全空的硬保证）
  const big = { ...T, driveViewIdleMs: 60000 };
  assert.ok(viewFreshWinMs(big) >= 60000 + 3000);
});
