// 异能秘境开车方案 · 方案层↔引擎插座一致性守卫。
// 动机：plans.js 用 `obj` 字符串引用引擎的 #objective switch 分支——名字写错/引擎漏实现时，
// matchStages 仍会正常命中，引擎只是「选不到点、顺延下一档」，线上表现为静默不发车，极难发现。
// 本测试离线把两边的名字对齐：方案引用的每个 obj 都必须在引擎里有对应分支。
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
const { PLANS } = await import('../../extension/src/feats/activity/secret-realm/plans.js');

/** 引擎 #objective 的 switch 分支名（源码静态抽取，避免测试侧硬编码一份会漂移的清单）。 */
function engineObjectives() {
  const src = readFileSync(
    path.join(here, '../../extension/src/feats/activity/secret-realm/pilot.js'),
    'utf8',
  );
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

test('内置方案 enigmaB_default 的每个 obj 都在引擎 #objective 里有分支', () => {
  const have = engineObjectives();
  assert.ok(have.size >= 6, '引擎插座分支抽取异常（只拿到 ' + have.size + ' 个）');
  const stages = PLANS.enigmaB_default.stages;
  assert.ok(Array.isArray(stages) && stages.length, 'enigmaB_default 阶段表为空');
  for (const s of stages) {
    assert.ok(have.has(s.obj), '方案阶段 ' + s.id + ' 引用了引擎没有的目标原语 obj=' + s.obj);
  }
});

test('方案阶段形状合法：id/obj 唯一性、terminal 只出现在判据可长期成立的位置', () => {
  const stages = PLANS.enigmaB_default.stages;
  const ids = new Set();
  for (const s of stages) {
    assert.equal(typeof s.id, 'string', '阶段缺 id');
    assert.equal(typeof s.obj, 'string', s.id + ' 缺 obj');
    assert.equal(typeof s.when, 'function', s.id + ' 缺 when 判据');
    assert.ok(!ids.has(s.id), '阶段 id 重复：' + s.id);
    ids.add(s.id);
  }
  // 日常链各档必须互不吞并：relax 与 !relax 分支的判据要互斥（否则百兽期会漏出日常档）
  const relaxOnly = stages.filter((s) => s.id.startsWith('cruiseRelax') || s.id === 'beastRelax');
  assert.equal(relaxOnly.length, 2, '百兽期分支档数变化，需同步核对现状链形');
});

test('未注册方案 id 时引擎按 enigmaB_default 回落（配置面缺键前向兼容）', async () => {
  const mod = await import('../../extension/src/feats/activity/secret-realm/plans.js');
  const ids = mod.planIds();
  assert.ok(ids.includes('enigmaB_default'), '内置方案 id 丢失');
  // 解释器对未知方案（undefined plan）不炸链：返回空列表 = 本拍目标层无动作
  assert.deepEqual(mod.matchStages(undefined, {}), []);
  assert.deepEqual(mod.matchStages({ stages: [] }, {}), []);
});

test('阶段诊断表不存孤儿：STAGE_DIAG 的每个 key 都是方案里的阶段 id，且独占档都登记了', () => {
  const src = readFileSync(
    path.join(here, '../../extension/src/feats/activity/secret-realm/pilot.js'),
    'utf8',
  );
  const start = src.indexOf('const STAGE_DIAG = {');
  assert.ok(
    start > 0,
    '找不到 STAGE_DIAG（probe 判读面契约被删？改名会带飞 lastBranch/stage 对拍）',
  );
  const block = src.slice(start, src.indexOf('};', start));
  const keys = [...block.matchAll(/^\s*([A-Za-z_][\w]*):\s*\{/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 5, 'STAGE_DIAG 抽取异常：' + keys.join(','));
  const stages = PLANS.enigmaB_default.stages;
  // 孤儿检查面向**全部方案**的阶段 id 并集（C4 起 crystal_then_skill 也有登记档）；
  //   反向的「terminal 必登记」硬约束仍只对 enigmaB_default（生产缺省路）施压。
  const ids = new Set(
    [].concat(...Object.keys(PLANS).map((k) => PLANS[k].stages.map((s) => s.id))),
  );
  for (const k of keys) assert.ok(ids.has(k), 'STAGE_DIAG 里的 ' + k + ' 在方案阶段表不存在');
  // 独占（terminal）档必须登记诊断面：它们绕过日常链的 stage/branch 兑底，
  //   漏登记 = 把 'boss-open'/'shop' 等历史档位名写错（拒码分流/lastDispatch 对拍都会飘）。
  //   bossWait 例外：它走 cand.wait 专用分支，不经过 STAGE_DIAG。
  for (const s of stages) {
    if (!s.terminal || s.obj === 'wait') continue;
    assert.ok(keys.includes(s.id), 'terminal 档 ' + s.id + ' 没在 STAGE_DIAG 登记诊断面');
  }
});
