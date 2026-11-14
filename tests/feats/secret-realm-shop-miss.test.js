// 刷店命中率止损离线单测（四-2：shop.js refreshMissStep 纯函数契约）。
// shop.js import 链触到 constants（浏览器全局），与 rejects 测试同法先桩再动态 import。
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

const { refreshMissStep } = await import('../../extension/src/feats/activity/secret-realm/shop.js');

test('命中（目标品在架）清零重计，绝不触发止损', () => {
  assert.deepEqual(refreshMissStep(2, true, 3), { miss: 0, giveUp: false });
  assert.deepEqual(refreshMissStep(0, true, 3), { miss: 0, giveUp: false });
});

test('连续未命中累加，达阈当次触发（11-07 场 refresh=6 buys=0 的止损形态）', () => {
  assert.deepEqual(refreshMissStep(0, false, 3), { miss: 1, giveUp: false });
  assert.deepEqual(refreshMissStep(1, false, 3), { miss: 2, giveUp: false });
  assert.deepEqual(refreshMissStep(2, false, 3), { miss: 3, giveUp: true });
  // 超阈后继续刷（理论上已停刷，防御性）仍报 giveUp，由调用方 #refreshGaveUp 去重
  assert.deepEqual(refreshMissStep(3, false, 3), { miss: 4, giveUp: true });
});

test('max<=0 = 关止损：只计数不触发；prev 缺省按 0', () => {
  assert.deepEqual(refreshMissStep(undefined, false, 0), { miss: 1, giveUp: false });
  assert.deepEqual(refreshMissStep(9, false, 0), { miss: 10, giveUp: false });
  assert.deepEqual(refreshMissStep(undefined, false, 3), { miss: 1, giveUp: false });
});
