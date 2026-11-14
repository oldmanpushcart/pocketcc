// 异能秘境拒码共享真相表离线单测（三-3：pilot/boss 处置参数同源契约）。
// rejects.js 只 import constants.js 的 REJ_* 字符串常量；constants.js 末尾 re-export
// core/util.js 会触浏览器全局，故先最小桩化再动态 import（与 secret-realm-pilot.test.js 同法）。
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

const { REJECT_RULES, matchReject } =
  await import('../../extension/src/feats/activity/secret-realm/rejects.js');
const C = await import('../../extension/src/feats/activity/secret-realm/constants.js');

test('matchReject：全等命中 / 17 子串命中 / 未登记回 null', () => {
  assert.equal(matchReject(C.REJ_PARAM_ERROR).name, 'param-error');
  assert.equal(
    matchReject('prefix_' + C.REJ_BATTLEFIELD_CLOSING + '_suffix').name,
    'realm-closing',
  );
  assert.equal(matchReject(C.REJ_NOT_ARRIVED).name, 'in-flight');
  assert.equal(matchReject('enigma_realm999'), null);
  assert.equal(matchReject(''), null);
});

test('共享真相：159995 两引擎同 TTL（paramBlacklistMs 短黑），绝不走 6h 长黑', () => {
  const ru = REJECT_RULES[C.REJ_PARAM_ERROR];
  assert.equal(ru.pilot.black, 'param');
  assert.equal(ru.boss.black, 'target');
  assert.equal(ru.boss.ttl, 'paramBlacklistMs');
  assert.notEqual(ru.boss.ttl, 'rejectBlacklistMs');
  // pilot 侧清回攻待办 + 复拉 BOSS 态（return 死循环修复的表内定稿）
  assert.equal(ru.pilot.clearReturn, true);
  assert.equal(ru.pilot.refreshBoss, true);
});

test('刻意差异：163 pilot 不拉黑（marched 预付）vs boss 长黑；142 pilot 黑平台 vs boss 降级配对', () => {
  const r163 = REJECT_RULES[C.REJ_NO_MARCH_TARGET];
  assert.equal(r163.pilot.black, undefined);
  assert.equal(r163.boss.ttl, 'rejectBlacklistMs');
  const r142 = REJECT_RULES[C.REJ_BOSS_AREA];
  assert.equal(r142.pilot.black, 'day');
  assert.equal(r142.pilot.onlyTag, 'boss-plane');
  assert.equal(r142.boss.area, 'demote');
  assert.equal(r142.boss.black, undefined);
});

test('瞬态与到达：158 两引擎不拉黑；157 pilot 进 WORK / boss 认区域正常', () => {
  const r158 = REJECT_RULES[C.REJ_NOT_ARRIVED];
  assert.equal(r158.pilot.keepPhase, true);
  assert.equal(r158.pilot.black, undefined);
  assert.equal(r158.boss.keepPhase, true);
  const r157 = REJECT_RULES[C.REJ_ALREADY_THERE];
  assert.equal(r157.pilot.enterWork, true);
  assert.equal(r157.boss.area, 'ok');
});

test('141 boss 退避专用 planeRefreshMs；pilot 平台三码同处置（只黑 boss-plane 档）', () => {
  assert.equal(REJECT_RULES[C.REJ_NEED_PLANE].boss.backoff, 'planeRefreshMs');
  for (const code of [C.REJ_NEED_PLANE, C.REJ_BOSS_AREA, C.REJ_PLANE_TAKEN]) {
    const p = REJECT_RULES[code].pilot;
    assert.equal(p.black, 'day');
    assert.equal(p.onlyTag, 'boss-plane');
    assert.equal(p.clearTo, true);
    assert.equal(p.backoff, 'rejectBackoffMs');
  }
});

test('159 不黑 BOSS 本体（unlessTag=boss）且脱商店锚点；17 本场停手', () => {
  const r159 = REJECT_RULES[C.REJ_POINT_NOT_EXIST];
  assert.equal(r159.pilot.unlessTag, 'boss');
  assert.equal(r159.pilot.dropShop, true);
  const r17 = REJECT_RULES[C.REJ_BATTLEFIELD_CLOSING];
  assert.equal(r17.match, 'contains');
  assert.equal(r17.pilot.stopMatch, true);
  assert.equal(r17.boss, undefined); // boss 攻打链未登记 → 兜底
});

test('表完整性：每条规则有 name/match；pilot 处置的退避键与日志 lvl 合法', () => {
  for (const ru of Object.values(REJECT_RULES)) {
    assert.ok(ru.name, 'rule has name');
    assert.ok(ru.match === 'exact' || ru.match === 'contains');
    for (const col of [ru.pilot, ru.boss]) {
      if (!col) continue;
      if (col.backoff) assert.ok(['rejectBackoffMs', 'planeRefreshMs'].includes(col.backoff));
      if (col.log) assert.ok(['info', 'debug', 'note'].includes(col.log.lvl));
    }
  }
});
