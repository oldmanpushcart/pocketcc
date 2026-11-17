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
      bossMode: null,
      onBossPlane: false,
      bossSameArea: false,
      bossFeeding: false,
      marchPolicy: 0,
      beastPolicy: 1,
      beastOff: false,
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

test('shopErrand 顶层旗标：default 方案含勤务；validatePlan 布尔形状检查', () => {
  assert.equal(plan.shopErrand, true, 'default 方案含大BOSS 前定点勤务（无面板子闸）');
  const { validatePlan } = mod;
  assert.deepEqual(validatePlan({ stages: [] }, []), [], '省略旗标合法（pilot 读 !== false 兜底）');
  assert.deepEqual(
    validatePlan({ stages: [], shopErrand: false }, []),
    [],
    '布尔 false 合法（方案不做勤务）',
  );
  const errs = validatePlan({ stages: [], shopErrand: 'yes' }, []);
  assert.ok(
    errs.some((s) => s.includes('shopErrand')),
    '非布尔必须报违例（启动期拒发车）',
  );
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

test('总闸关(beastOff) 日常 → 短路 beast 档，采井仍在（等价 beastPolicy=2 不打野）', () => {
  const c = mkCtx({ relax: false, beastPolicy: 1, beastOff: true });
  assert.deepStrictEqual(ids(c), ['cruiseStrict', 'cruiseLoose', 'shopTail']);
});

test('总闸关(beastOff) 百兽期 relax → 跳 beastRelax，仅 cruiseRelax', () => {
  const c = mkCtx({ relax: true, beastPolicy: 1, beastOff: true });
  assert.deepStrictEqual(ids(c), ['cruiseRelax']);
});

test('shouldExplore 日常链尾追加 explore（非 terminal，排最后）', () => {
  const c = mkCtx({ relax: false, beastPolicy: 2, shouldExplore: true });
  const got = ids(c);
  assert.equal(got[got.length - 1], 'explore');
});

// ── 三-5：解释器效果属性下沉（chain/emptyShopMark/emptyNote/explore/tailShopLog）──
test('chain 声明与旧 isChain 口径逐档等价：日常链+explore 在列，BOSS/独占/让路不在', () => {
  const chainIds = plan.stages.filter((s) => s.chain).map((s) => s.id);
  assert.deepStrictEqual(chainIds, [
    'follow',
    'beastRelax',
    'cruiseRelax',
    'beastEarly',
    'cruiseStrict',
    'beastLate',
    'cruiseLoose',
    'shopTail',
    'explore',
  ]);
  // 旧口径里 !dg 前置：登记了 STAGE_DIAG 的档（bossFight/bossPlaneOpen/bossPlaneLead/shopExit/shopStage）绝不标 chain
  for (const id of [
    'bossFight',
    'bossPlaneOpen',
    'bossPlaneLead',
    'shopExit',
    'shopStage',
    'bossWait',
  ]) {
    const s = plan.stages.find((x) => x.id === id);
    assert.ok(s, id + ' 档丢失');
    assert.ok(!s.chain, id + ' 不得标 chain（旧 isChain 口径 !dg 前置）');
  }
});

test('空候选处置属性：terminal 店档 emptyShopMark；开台读秒档 emptyNote 文案逐字保留', () => {
  for (const id of ['shopExit', 'shopStage']) {
    const s = plan.stages.find((x) => x.id === id);
    assert.equal(s.emptyShopMark, true);
  }
  const lead = plan.stages.find((x) => x.id === 'bossPlaneLead');
  assert.equal(lead.emptyNote.key, 'no-plane');
  assert.equal(
    lead.emptyNote.msg,
    'pilot: no usable platform found within BOSS open-countdown window (viewport lacks 176/174 or all occupied), give up boarding this tick. reason=no_plane',
  );
  // 其余档不得携带空候选处置属性（防静默扩散）
  for (const s of plan.stages) {
    if (s.id === 'shopExit' || s.id === 'shopStage') continue;
    assert.ok(!s.emptyShopMark, s.id + ' 不应有 emptyShopMark');
    if (s.id !== 'bossPlaneLead') assert.ok(!s.emptyNote, s.id + ' 不应有 emptyNote');
  }
});

test('探索/链尾店档属性：explore 档带 explore；shopTail 带 tailShopLog', () => {
  const ex = plan.stages.find((x) => x.id === 'explore');
  assert.equal(ex.explore, true);
  const tail = plan.stages.find((x) => x.id === 'shopTail');
  assert.equal(tail.tailShopLog, true);
});
