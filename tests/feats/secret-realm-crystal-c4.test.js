// C4 · crystal_then_skill 新原语夹具单测（pilot-select.pickBuffDrop / areaByStart / pickResource zone 闸）。
// 口径与 pilot-select 既有回放测同源：真实 901 夹具 + 合成补料，只断言纯函数选择结果，不摸引擎/不发协议。
// 报文订正前提（先证）：buff 只存在于 173 资源点明细（8526/21522 的 buffInfo），163 掉落箱无 buff 字段
//   且 esrId 恒 0——所以 pickBuffDrop 选的是「带 buff 位的 173 井」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// feat 模块 import 链会触到浏览器全局（constants re-export core/util），先最小桩化再动态 import。
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

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(here, '../fixtures/secret-realm-901.json'), 'utf8'));
const { pickBuffDrop, areaByStart, pickResource } =
  await import('../../extension/src/feats/activity/secret-realm/pilot-select.js');

/** 合成 173 井：只带选点闸需要的字段（m 形态与夹具 liveSnap 的 173 同形）。 */
function well(x, y, esrId, over = {}) {
  return {
    v: 1,
    x,
    y,
    k: 1000 + x * 100 + y,
    id: 1000 + x * 100 + y,
    pointType: 173,
    m: { viewId: 9, esrId, state: 0, teams: [], iNum: 5, rTime: 0, ...over },
  };
}
const SP = { x: 100, y: 100 };

test('pickBuffDrop：无 21522 记账（buffFreeAt→null）乐观可选，按距离最近优先；脚下点(d=0)剔除', () => {
  const pts = [well(110, 100, 14), well(130, 100, 14), well(100, 100, 14), well(95, 95, 12)];
  const sel = pickBuffDrop(pts, {
    startPoint: SP,
    isRoundOpen: () => true,
    buffFreeAt: () => null,
  });
  assert.ok(sel);
  // 脚下 (100,100) d=0 被剔；(95,95) d≈7.07 是最近的非脚下点（斜向比正东的 (110,100) d=10 近）
  assert.deepEqual([sel.x, sel.y], [95, 95], '最近的非脚下井胜出（esrId 不参与排序，跨区也可选）');
});

test('pickBuffDrop：记账 buffFree==0 的点被剔；未知(null)与有值(>0)放行（三态语义）', () => {
  const pts = [well(105, 100, 14), well(108, 100, 14)];
  const sel = pickBuffDrop(pts, {
    startPoint: SP,
    isRoundOpen: () => true,
    buffFreeAt: (x) => (x === 105 ? 0 : null), // 近的探明无 buff 位 → 退而求其次选远的未知点
  });
  assert.equal(sel.x, 108);
  const none = pickBuffDrop(pts, {
    startPoint: SP,
    isRoundOpen: () => true,
    buffFreeAt: () => 0,
  });
  assert.equal(none, null, '全部探明无位 → 整档空');
});

test('pickBuffDrop：归属/占用闸与回合闸同 pickResource 口径（state!=0 / teams 非空 / 未开门 / 在途指向都不派）', () => {
  const busy = well(104, 100, 14, { state: 1 });
  const teamed = well(106, 100, 14, { teams: [1] });
  const locked = well(108, 100, 15);
  const incoming = well(110, 100, 14);
  const pts = [busy, teamed, locked, incoming];
  const sel = pickBuffDrop(pts, {
    startPoint: SP,
    isRoundOpen: (id) => id === 14, // 15 未开门
    buffFreeAt: () => null,
    marches: [{ tx: 110, ty: 100, state: 1 }], // 已有在途指向最后一口
  });
  assert.equal(sel, null, '四口全被各自闸拦下');
});

test('pickBuffDrop：zone 过滤（strong 只留强区 esrId；zoneOf 缺省/any 恒放行）——夹具 esrId=14 当强区', () => {
  const real = (fx.liveSnap.pointList || fx.liveSnap.points || []).filter(
    (p) => Number(p.pointType) === 173,
  );
  const zoneOf = (id) => (Number(id) === 14 ? 'strong' : 'normal');
  const strong = pickBuffDrop(real, {
    startPoint: { x: 1, y: 1 },
    isRoundOpen: () => true,
    buffFreeAt: () => null,
    zoneOf,
    zone: 'strong',
  });
  assert.ok(strong, '强区路可选');
  assert.equal(Number(strong.m.esrId), 14);
  const other = pickBuffDrop(real, {
    startPoint: { x: 1, y: 1 },
    isRoundOpen: () => true,
    buffFreeAt: () => null,
    zoneOf,
    zone: 'normal',
  });
  assert.equal(other, null, '夹具 173 全在 esrId=14，普通区路应为空');
  const loose = pickBuffDrop(real, {
    startPoint: { x: 1, y: 1 },
    isRoundOpen: () => true,
    buffFreeAt: () => null,
    zoneOf,
    zone: 'any',
  });
  assert.ok(loose, 'zone=any 不拦');
});

test('pickResource：zone 闸只对显式 zoneOf+具体 zone 生效，缺省调用与旧行为逐字一致', () => {
  const pts = [well(105, 100, 14, { iNum: 9 }), well(106, 100, 12, { iNum: 50 })];
  const base = { startPoint: SP, serverTimeSec: 1e9, isRoundOpen: () => true };
  assert.equal(pickResource(pts, base).x, 106, '不传 zone：按 iNum-cost 打分，与改前同结果');
  const strongOnly = pickResource(pts, {
    ...base,
    zoneOf: (id) => (Number(id) === 14 ? 'strong' : 'normal'),
    zone: 'strong',
  });
  assert.equal(strongOnly.x, 105, 'strong 过滤后只剩 esrId=14 的井（哪怕产出低）');
  const anyZone = pickResource(pts, {
    ...base,
    zoneOf: () => 'any',
    zone: 'any',
  });
  assert.equal(anyZone.x, 106, 'zone=any 恒放行');
});

test('areaByStart：开窗公式 now > begin + timer.start（强区 roundPick 命中才认；表缺行闭开 false）', () => {
  const timerRows = { 3: { start: 600 }, 5: { start: 3600 } };
  const realmRows = { 14: { roundid: 5 }, 12: { roundid: 3 } };
  const timerRow = (r) => timerRows[r] || null;
  const realmRow = (e) => realmRows[e] || null;
  const strong = (round) => round >= 5;
  // 开战 10:00:00，now=+3700s → 强区 round5(start 3600) 已开
  assert.equal(
    areaByStart({ beginSec: 100000, serverTimeSec: 103700 }, timerRow, realmRow, strong, [12, 14]),
    true,
  );
  // now=+3500s → 未到 start，未开
  assert.equal(
    areaByStart({ beginSec: 100000, serverTimeSec: 103500 }, timerRow, realmRow, strong, [12, 14]),
    false,
  );
  // 普通区谓词（round<5）在 +601s 已开
  assert.equal(
    areaByStart(
      { beginSec: 100000, serverTimeSec: 100601 },
      timerRow,
      realmRow,
      (r) => r < 5,
      [12],
    ),
    true,
  );
  // esrId 无 realm 行 / round 无 timer 行 → 闭开
  assert.equal(
    areaByStart({ beginSec: 100000, serverTimeSec: 199999 }, timerRow, realmRow, strong, [99]),
    false,
  );
  assert.equal(
    areaByStart({ beginSec: 0, serverTimeSec: 199999 }, timerRow, realmRow, strong, [14]),
    false,
    '时钟无效恒 false',
  );
});
