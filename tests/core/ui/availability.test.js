// 面板可用性判据（feat 自有 available + world/mode 门控镜像）单测：零 DOM，只锁判据分支。
// world 门控在 node 下无游戏信号 → Kind=homeland/Place=off，故「声明 places 白名单」的 spec 必被拦，
// 这与真机在 boot/非白名单场景的判定一致；空 kinds/places 一律放行。
import { test } from 'node:test';
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

const { availabilityOf } = await import('../../../extension/src/core/ui/availability.js');
const { setCombatMode } = await import('../../../extension/src/core/mode.js');

test('未声明任何闸门 → 可用', () => {
  assert.deepEqual(availabilityOf({}), { off: false, reason: '' });
  assert.deepEqual(availabilityOf(null), { off: false, reason: '' });
});

test('available() 给出否定结论 → 置灰并带原因', () => {
  assert.deepEqual(availabilityOf({ available: () => false }), {
    off: true,
    reason: '当前条件未满足',
  });
  assert.deepEqual(availabilityOf({ available: () => ({ ok: false, reason: '活动未开启' }) }), {
    off: true,
    reason: '活动未开启',
  });
});

test('available() 返回真 / 抛错 → 放行（面板判据不因异常炸掉入口）', () => {
  assert.equal(availabilityOf({ available: () => true }).off, false);
  assert.equal(
    availabilityOf({
      available: () => {
        throw new Error('boom');
      },
    }).off,
    false,
  );
});

test('world 门控镜像：声明地图白名单而当前不在白名单内 → 置灰', () => {
  assert.deepEqual(availabilityOf({ places: ['base', 'world'] }), {
    off: true,
    reason: '当前场景/地图不适用',
  });
});

test('mode 门控镜像：战斗模式下声明 offInCombat 的功能置灰，退出战斗后恢复', () => {
  setCombatMode(true);
  assert.deepEqual(availabilityOf({ offInCombat: true }), {
    off: true,
    reason: '战斗模式下已停用',
  });
  assert.equal(availabilityOf({ offInCombat: false }).off, false);
  setCombatMode(false);
  assert.equal(availabilityOf({ offInCombat: true }).off, false);
});
