// 异能秘境开车方案 · 方案层↔引擎插座一致性守卫。
// 动机：plans.js 用 `obj` 字符串引用引擎 #objective switch 分支、用 ctx 字段引用 #buildCtx 产物——
//   名字写错/引擎漏实现时，matchStages 仍会正常命中，引擎只是「选不到点、顺延下一档」，
//   线上表现为静默不发车，极难发现。剥 crystal_then_skill 后加契约（CTX_KEYS/OBJECTIVES），
//   本测试是启动期 validatePlan/validateCtxKeys 之外的**离线第二道闸**。
// 分工：
//   1) validatePlan 主守卫：plans.js 层所有形状/清单一致性（obj 在 OBJECTIVES、terminal 在 STAGE_DIAG 等）。
//   2) 源码扫描防漂移：plans.js 里 CTX_KEYS/OBJECTIVES 是否与 pilot.js 实际 #buildCtx 返回字段、
//      #objective switch case 一字对应——防「改了引擎没同步清单」或反之。
// ⚠ 只匹配 `#objective` 函数体（用方法名定界），别误吞文件里其他 switch 的 case。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
};
globalThis.chrome = globalThis.chrome || {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: { id: 'test', getURL: (s) => s, onMessage: { addListener() {} } },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const pilotPath = path.join(here, '../../extension/src/feats/activity/secret-realm/pilot.js');
const plansMod = await import('../../extension/src/feats/activity/secret-realm/plans.js');
const { PLANS, CTX_KEYS, OBJECTIVES, validatePlan } = plansMod;

/** 引擎 #objective 的 switch 分支名（源码静态抽取，避免测试侧硬编码一份会漂移的清单）。 */
function engineObjectives() {
  const src = readFileSync(pilotPath, 'utf8');
  const start = src.indexOf('#objective(');
  assert.ok(start > 0, 'pilot.js 里找不到 #objective（引擎插座被改名/删除？）');
  const swStart = src.indexOf('switch (obj)', start);
  assert.ok(swStart > start, '#objective 里找不到 switch (obj)');
  const swEnd = src.indexOf('\n  }', swStart);
  assert.ok(swEnd > swStart, '#objective switch 体定界失败');
  const body = src.slice(swStart, swEnd);
  const names = new Set();
  const re = /case\s+['"]([A-Za-z_][\w]*)['"]\s*:/g;
  let m;
  while ((m = re.exec(body)) !== null) names.add(m[1]);
  return names;
}

/** 引擎 #buildCtx 的返回字段名（源码静态抽取 return { ... } 里的顶层 key）。 */
function engineCtxKeys() {
  const src = readFileSync(pilotPath, 'utf8');
  const start = src.indexOf('#buildCtx(');
  assert.ok(start > 0, 'pilot.js 里找不到 #buildCtx');
  const ret = src.indexOf('return {', start);
  assert.ok(ret > start, '#buildCtx 里找不到 return {');
  // 粗略定界：从 return { 起找到匹配的顶层 };
  let depth = 0;
  let i = ret + 'return '.length;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(ret, i);
  // 顶层 key：匹配换行+2 空格缩进+标识符+冒号
  const keys = [];
  const re = /\n\s{6}([A-Za-z_][\w]*):/g;
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1]);
  return new Set(keys);
}

/** STAGE_DIAG 的 key 清单（源码静态抽取）。 */
function engineStageDiagKeys() {
  const src = readFileSync(pilotPath, 'utf8');
  const start = src.indexOf('const STAGE_DIAG = {');
  assert.ok(
    start > 0,
    '找不到 STAGE_DIAG（probe 判读面契约被删？改名会带飞 lastBranch/stage 对拍）',
  );
  const block = src.slice(start, src.indexOf('};', start));
  return [...block.matchAll(/^\s*([A-Za-z_][\w]*):\s*\{/gm)].map((m) => m[1]);
}

// ── 主守卫：validatePlan 一次性把 default 方案的所有契约项跑齐 ─────────────
test('validatePlan(default) 无违例——契约清单与阶段表一致', () => {
  const errs = validatePlan(PLANS.default, engineStageDiagKeys());
  assert.deepEqual(errs, [], 'default 方案契约违例：\n  ' + errs.join('\n  '));
});

// ── 三-5：解释器效果属性形状违例必被卡住（防「属性写错档 → 引擎静默不生效」）──
test('validatePlan 卡效果属性违例：emptyShopMark/tailShopLog/explore/emptyNote/chain', () => {
  const diag = engineStageDiagKeys();
  const mk = (over) => ({
    stages: [Object.assign({ id: 'x', obj: 'shop', when: () => true }, over)],
  });
  assert.ok(
    validatePlan(mk({ emptyShopMark: true }), diag).length > 0,
    '非 terminal 店档不得 emptyShopMark',
  );
  assert.ok(
    validatePlan(mk({ terminal: true, obj: 'resource', emptyShopMark: true }), diag).length > 0,
    '非店档不得 emptyShopMark',
  );
  assert.ok(
    validatePlan(mk({ terminal: true, tailShopLog: true }), diag).length > 0,
    'terminal 店档不得 tailShopLog',
  );
  assert.ok(
    validatePlan(mk({ obj: 'resource', explore: true }), diag).length > 0,
    '非 explore 档不得 explore 属性',
  );
  assert.ok(
    validatePlan(mk({ emptyNote: { key: '', msg: 'x' } }), diag).length > 0,
    'emptyNote 空 key 必卡',
  );
  assert.ok(
    validatePlan(mk({ emptyNote: { key: 'k' } }), diag).length > 0,
    'emptyNote 缺 msg 必卡',
  );
  assert.ok(validatePlan(mk({ chain: 'yes' }), diag).length > 0, 'chain 非布尔必卡');
  // 合法形状不报：非 terminal 店档带 tailShopLog + chain
  assert.deepEqual(validatePlan(mk({ chain: true, tailShopLog: true }), diag), []);
});

// ── 防漂移：plans.js 声明的清单 = pilot.js 引擎实际 ────────────────────────
test('OBJECTIVES 清单 = 引擎 #objective switch 实际 case 名（双向）', () => {
  const have = engineObjectives();
  assert.ok(have.size >= 6, '引擎插座分支抽取异常（只拿到 ' + have.size + ' 个）');
  // 方向 A：清单里每一项引擎都要有对应 case（否则方案写它 = 静默顺延）
  for (const name of OBJECTIVES) {
    assert.ok(
      have.has(name),
      'plans.js OBJECTIVES 里的 ' + name + ' 在引擎 #objective 无对应 case',
    );
  }
  // 方向 B：引擎 case 名字都登记到清单（否则引擎加了 case 但方案侧无法引用）
  for (const name of have) {
    assert.ok(
      OBJECTIVES.includes(name),
      '引擎 #objective 出现清单外 case：' + name + '（请同步 plans.js OBJECTIVES）',
    );
  }
});

test('CTX_KEYS 清单 = 引擎 #buildCtx return 对象字段（双向）', () => {
  const have = engineCtxKeys();
  assert.ok(have.size >= 10, '#buildCtx 字段抽取异常（只拿到 ' + have.size + ' 个）');
  for (const k of CTX_KEYS) {
    assert.ok(have.has(k), 'plans.js CTX_KEYS 里的 ' + k + ' 在 #buildCtx 未产出');
  }
  for (const k of have) {
    assert.ok(
      CTX_KEYS.includes(k),
      '#buildCtx 出现清单外字段：' + k + '（请同步 plans.js CTX_KEYS 或从引擎删除）',
    );
  }
});

// ── 阶段形状：id/obj 唯一性、relax 分支档数（防日常链被单方案吞并） ────────
test('方案阶段形状合法：id/obj 唯一、relax 分支档数守恒', () => {
  const stages = PLANS.default.stages;
  const ids = new Set();
  for (const s of stages) {
    assert.equal(typeof s.id, 'string', '阶段缺 id');
    assert.equal(typeof s.obj, 'string', s.id + ' 缺 obj');
    assert.equal(typeof s.when, 'function', s.id + ' 缺 when 判据');
    assert.ok(!ids.has(s.id), '阶段 id 重复：' + s.id);
    ids.add(s.id);
  }
  const relaxOnly = stages.filter((s) => s.id.startsWith('cruiseRelax') || s.id === 'beastRelax');
  assert.equal(relaxOnly.length, 2, '百兽期分支档数变化，需同步核对现状链形');
});

// ── 未知方案回落：配置面缺键前向兼容 ────────────────────────────────────
test('未注册方案 id 时引擎按 default 回落（配置面缺键前向兼容）', () => {
  const ids = plansMod.planIds();
  assert.ok(ids.includes('default'), '内置方案 id 丢失');
  assert.deepEqual(plansMod.matchStages(undefined, {}), []);
  assert.deepEqual(plansMod.matchStages({ stages: [] }, {}), []);
});

// ── P2 双轨收一轨：legacy 选点器不得回潮 ────────────────────────────────
// 动机：shop/beast/resource 三 objective 已收进 pilot-select 窄筛唯一选点路，料源不可用时
//   本轮不选（落链后续档）；若有人把读累积 #tiles 池的老选点器加回来当兜底，会静默换回
//   「降级时另一套筛子」语义（rTime/consumed/当日拉黑三闸回潮）——源码层直接卡死。
test('pilot.js 无 legacy 选点器残留（#pickShop/#pickBeast/#pickResource/#nearestShopA）', () => {
  const src = readFileSync(pilotPath, 'utf8');
  for (const name of ['#pickShop(', '#pickBeast(', '#pickResource(', '#nearestShopA(']) {
    assert.ok(
      !src.includes(name),
      'legacy 选点器回潮：pilot.js 出现 ' + name + '（窄筛唯一选点路，兜底=本轮不选）',
    );
  }
  // resolveHop 只该在 pilot-select 内部用（pickResource 自己调），引擎不再直接 import
  assert.ok(
    !src.includes('resolveHop'),
    'pilot.js 重新引用 resolveHop（单跳裁决已收进 pilot-select）',
  );
});

// ── STAGE_DIAG 不存孤儿：key 必须是方案阶段 id 之一 ──────────────────────
test('STAGE_DIAG 无孤儿 key；terminal 档全登记（wait 例外）', () => {
  const keys = engineStageDiagKeys();
  assert.ok(keys.length >= 5, 'STAGE_DIAG 抽取异常：' + keys.join(','));
  const stages = PLANS.default.stages;
  const ids = new Set(
    [].concat(...Object.keys(PLANS).map((k) => PLANS[k].stages.map((s) => s.id))),
  );
  for (const k of keys) assert.ok(ids.has(k), 'STAGE_DIAG 里的 ' + k + ' 在方案阶段表不存在');
  for (const s of stages) {
    if (!s.terminal || s.obj === 'wait') continue;
    assert.ok(keys.includes(s.id), 'terminal 档 ' + s.id + ' 没在 STAGE_DIAG 登记诊断面');
  }
});
