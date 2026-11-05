// 异能秘境开车方案 · Plan 层排序回放测试（§15.6：default 方案逐字复刻现状 #tick 目标梯）。
// 只测**顺序与 terminal 语义**（哪个阶段赢、独占/回落），不测选点内部（选点由 pilot-select 各自的
// 夹具/录制重放覆盖）。合成 ctx 覆盖 BOSS 档 / 收场店 / 开台让路 / relax 与日常分支 / 禁走窗。
// plans.js import 链触到 constants（浏览器全局），与 pilot 测试同法先桩 window/document/chrome 再动态 import。
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

const mod = await import('../../extension/src/feats/activity/secret-realm/plans.js');
const { PLANS, matchStages, planIds } = mod;
const plan = PLANS.default;

/** 安全缺省 ctx（对应「日常非 relax、无 BOSS、不去店」的空链），按需覆盖。 */
function mkCtx(over) {
  return Object.assign(
    {
      shopWhy: null,
      teamType: 0,
      driveBoss: true,
      bossMode: null,
      onBossPlane: false,
      bossSameArea: false,
      bossFeeding: false,
      marchPolicy: 0,
      beastPolicy: 1,
      relax: false,
      beastLock: false,
      shouldExplore: false,
      snap: { points: [], marches: [], cur: { x: 0, y: 0 }, curKey: '', curPt: 0 },
    },
    over,
  );
}
const ids = (c) => matchStages(plan, c).map((s) => s.id);

test('planIds 暴露内置方案且 default 在列', () => {
  assert.ok(planIds().includes('default'));
});

test('BOSS 开打且已停同区平台 → bossFight 独占（terminal，不回落后续）', () => {
  const c = mkCtx({
    teamType: 1,
    bossMode: 'open',
    onBossPlane: true,
    bossSameArea: true,
    relax: true,
  });
  assert.deepStrictEqual(ids(c), ['bossFight']);
});

test('BOSS 开打但未停平台 → bossPlaneOpen 排首，截断后续（开打期间不去商店）', () => {
  const c = mkCtx({ teamType: 1, bossMode: 'open', shopWhy: 'exit' });
  assert.deepStrictEqual(ids(c), ['bossPlaneOpen']);
});

test('stopNext 与 terminal 的差别在引擎侧：matchStages 两者都截断，引擎只在有目标时才截断', () => {
  // 方案层（纯判据）：stopNext 命中同样只返一条，证明「独占与否」由引擎按实不空决定
  const open = mkCtx({ teamType: 1, bossMode: 'open', relax: false });
  assert.deepStrictEqual(ids(open), ['bossPlaneOpen']);
  // 而 lead 档没标 stopNext → 后续日常档应被收集（选不到平台就落回采井）
  const lead = mkCtx({ teamType: 1, bossMode: 'lead', relax: false });
  const got = ids(lead);
  assert.equal(got[0], 'bossPlaneLead');
  assert.ok(got.includes('cruiseStrict'), 'lead 档应可落回日常采井');
});

test('BOSS 开台读秒(lead)且不在平台 → 先试 plane，非 terminal 可落回日常', () => {
  const c = mkCtx({ teamType: 1, bossMode: 'lead' });
  const got = ids(c);
  assert.equal(got[0], 'bossPlaneLead');
  assert.ok(got.length > 1, 'bossPlaneLead 非 terminal，后续日常档应被收集');
});

test('收场(shopWhy=exit) → shopExit 独占，绝不再吃井/打野（L2043 收场车语义）', () => {
  const c = mkCtx({ shopWhy: 'exit', relax: true });
  assert.deepStrictEqual(ids(c), ['shopExit']);
});

test('高光窗(shopWhy=stage) → shopStage 独占', () => {
  const c = mkCtx({ shopWhy: 'stage' });
  assert.deepStrictEqual(ids(c), ['shopStage']);
});

test('开台读秒(state23)且 team_type>0 → bossWait 让路独占，不派日常车', () => {
  const c = mkCtx({ teamType: 2, bossFeeding: true });
  assert.deepStrictEqual(ids(c), ['bossWait']);
});

test('日常非 relax + 跟人 + beastPolicy=1 → 顺序：follow,beastEarly,cruiseStrict,cruiseLoose,shopTail', () => {
  const c = mkCtx({ marchPolicy: 2, beastPolicy: 1, relax: false });
  assert.deepStrictEqual(ids(c), [
    'follow',
    'beastEarly',
    'cruiseStrict',
    'cruiseLoose',
    'shopTail',
  ]);
});

test('日常非 relax + beastPolicy=0 → beast 排在采井后(beastLate)，且严格/宽松两采井俱在', () => {
  const c = mkCtx({ beastPolicy: 0, relax: false });
  assert.deepStrictEqual(ids(c), ['cruiseStrict', 'beastLate', 'cruiseLoose', 'shopTail']);
});

test('百兽期 relax + beastPolicy=2 → 跳打野，仅 cruiseRelax', () => {
  const c = mkCtx({ relax: true, beastPolicy: 2 });
  assert.deepStrictEqual(ids(c), ['cruiseRelax']);
});

test('百兽期 relax + beastPolicy=1 → beastRelax 先于 cruiseRelax', () => {
  const c = mkCtx({ relax: true, beastPolicy: 1 });
  assert.deepStrictEqual(ids(c), ['beastRelax', 'cruiseRelax']);
});

test('禁走窗(beastLock) 日常 → 跳过 beast 档，采井仍在', () => {
  const c = mkCtx({ relax: false, beastPolicy: 1, beastLock: true });
  assert.deepStrictEqual(ids(c), ['cruiseStrict', 'cruiseLoose', 'shopTail']);
});

test('shouldExplore 日常链尾追加 explore（非 terminal，排最后）', () => {
  const c = mkCtx({ relax: false, beastPolicy: 2, shouldExplore: true });
  const got = ids(c);
  assert.equal(got[got.length - 1], 'explore');
});
