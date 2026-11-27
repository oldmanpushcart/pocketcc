// 夺宝奇兵事件族号纯函数测试（constants.js eventFam）：验证 eventSpecId `<套装><族><序号>` 编码下，
// 族号取百位、前缀随赛季换表（1003xx → 4003xx）仍命中同一族，防「整段前缀硬编码」回归。
// 零依赖：constants.js 无 import，node 直测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventFam } from '../../extension/src/feats/activity/cs-hunt/constants.js';

test('eventFam：旧前缀 100xxx 六族映射', () => {
  assert.equal(eventFam(100101), 1); // pickReward
  assert.equal(eventFam(100201), 2); // rollDice
  assert.equal(eventFam(100301), 3); // codeBox
  assert.equal(eventFam(100401), 4); // pickSkill
  assert.equal(eventFam(100501), 5); // defPVE
  assert.equal(eventFam(100601), 6); // nothing
});

test('eventFam：新前缀 400xxx（2026-11 实测）与旧前缀同族', () => {
  assert.equal(eventFam(400101), 1);
  assert.equal(eventFam(400201), 2);
  assert.equal(eventFam(400301), 3); // 2026-11-27 录制实际 codeBox
  assert.equal(eventFam(400304), 3); // 同族不同序号
  assert.equal(eventFam(400302), 3);
  assert.equal(eventFam(500601), 6); // 防御未来套装前缀
});

test('eventFam：非法/空值回 0，不误判成任一真实族', () => {
  for (const v of [0, -1, null, undefined, '', 'abc', NaN]) assert.equal(eventFam(v), 0);
  assert.equal(eventFam('400301'), 3); // 字符串形态（JSON 字段）同口径
});
