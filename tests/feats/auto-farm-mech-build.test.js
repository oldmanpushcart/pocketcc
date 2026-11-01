// mechBuild（机械田自动建造）纯函数单测：家族唯一去重 + 完工判定→撤回口径。
// 这两个判据是从 cyclePass 里抽出来的纯函数（不发包、不摸游戏符号），断言的是"计划决策"，不含择时曲线。
// 说明：feat 模块的 import 链会触到浏览器全局（reactor/net-guard 等），故测试内先最小桩化 window/document/chrome，
// 再用动态 import 取纯函数——不 stub 任何游戏符号（lifespanSec 在游戏表缺席时按「未知不拦」回 null，正是被测降级路径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 浏览器全局最小桩（模块加载期需要，函数体不触碰）─────────────────────
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

// core 链里的 session/player/scene-watcher 等模块在 import 期就挂常驻 setInterval（浏览器里常驻、
// Node 里会把测试进程拖到永不退出）——只对测试 harness 的定时器 unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/player/auto-farm/mech-build.js');
const {
  bidFor,
  familyOfBid,
  isBuildComplete,
  planFamilies,
  remainingLifeSec,
  isFreeField,
  shouldDropLedgerEntry,
} = mod;

/** @param {number} bid @returns {number} 单测固定寿命表：一律 8000s（实证普通塔 duration），雷神 2000s */
const fixedLife = (bid) => (Math.floor(bid / 1000) === 71 ? 2000 : 8000);

test('bidFor/familyOfBid：bid = 家族前缀×1000 + 等级，反查同表（实证 53006 粮6 / 52006 油6 / 51006 金6 / 71001 雷神1）', () => {
  assert.equal(bidFor(5, 6), 53006);
  assert.equal(bidFor(1, 6), 52006);
  assert.equal(bidFor(7, 6), 51006);
  assert.equal(bidFor(16, 1), 71001);
  assert.equal(familyOfBid(53006), 5);
  assert.equal(familyOfBid(52006), 1);
  assert.equal(familyOfBid(51006), 7);
  assert.equal(familyOfBid(71001), 16);
  assert.equal(familyOfBid(99001), 0); // 未知前缀
  assert.equal(bidFor(99, 6), 0); // 未知家族
});

test('isBuildComplete：st===3 权威；btime 到期仅作漏推兜底', () => {
  assert.equal(isBuildComplete({ st: 3, btime: 1000 }, 900), true); // st 优先，未到 btime 也算建成（实证 st=3 与单兵入塔同拍）
  assert.equal(isBuildComplete({ st: 2, btime: 1000 }, 1000), true); // 漏推时按 btime 兜底
  assert.equal(isBuildComplete({ st: 2, btime: 1000 }, 999), false); // 施工中且未到期 → 不撤
  assert.equal(isBuildComplete(null, 999), false);
  assert.equal(isBuildComplete({ st: 2 }, 999), false); // 无 btime 不猜
});

test('planFamilies：同族已有活塔即覆盖（唯一性），未勾选家族不参与规划', () => {
  const towers = [{ id: '1', bid: 53006, st: 3, btime: 1000 }];
  const now = 2000;
  const plan = planFamilies(towers, [5, 7], {}, now, 600, fixedLife);
  assert.deepEqual(plan[5], { covered: true, reason: 'alive' }); // 粮已有塔
  assert.deepEqual(plan[7], { covered: false, reason: 'none' }); // 金无塔 → 该建
  assert.equal(plan[1], undefined); // 油没勾选，不出现在结论里
});

test('planFamilies：在飞建造（账本未撤回）也算覆盖，撤回后塔消失才补建', () => {
  const now = 2000;
  const ledger = { 7: { family: 7, marchId: 'm1', recalledAt: 0 } };
  const building = planFamilies([], [7], ledger, now, 600, fixedLife);
  assert.deepEqual(building[7], { covered: true, reason: 'building' });

  // 撤回后账本清掉（recallPass 的落账动作），1031 里也没有塔 → 下一拍补建
  const afterRecall = planFamilies([], [7], {}, now, 600, fixedLife);
  assert.deepEqual(afterRecall[7], { covered: false, reason: 'none' });
});

test('planFamilies：剩余寿命不足 guard 的塔判「该补建」，查不到寿命按「未知不拦」放行', () => {
  const now = 8600;
  const expiring = [{ id: '1', bid: 53006, st: 3, btime: 1000 }]; // 1000+8000-8600 = 400 < guard(600)
  assert.deepEqual(
    planFamilies(expiring, [5], {}, now, 600, fixedLife)[5],
    { covered: false, reason: 'expiring' },
    '到期前 guard 秒即允许补建',
  );
  // 同塔但寿命表查不到（游戏表未就绪）→ 不做剔除，仍算覆盖
  assert.deepEqual(planFamilies(expiring, [5], {}, now, 600, () => 0)[5], {
    covered: true,
    reason: 'alive',
  });
});

test('planFamilies：施工中(st=2)的塔同样占住家族名额，不重复发 1033', () => {
  const towers = [{ id: '9', bid: 51006, st: 2, btime: 5000 }];
  const plan = planFamilies(towers, [7], {}, 4000, 600, fixedLife);
  assert.deepEqual(plan[7], { covered: true, reason: 'alive' });
});

// ── 本轮修复回归：R1/R2/R3 与账本/寿命（BL-1/2/3/4 · MA-1）──────────────
test('isFreeField（R2）：只认无主普通田；他人机械田/遗迹田/有主田/异族田一律否', () => {
  const mk = (itemId, over) =>
    Object.assign(
      { pointType: 4, r: { itemId, ownerId: '0', aid: '0', allianceAreaOwner: 0 } },
      over || {},
    );
  // 金家族(7) 落点组 floor(itemId/100)=1 → 106 命中
  assert.equal(isFreeField(mk(106), 7), true);
  // 他人机械田 pointType=24（R2 排除）
  assert.equal(isFreeField({ pointType: 24, r: { itemId: 106, ownerId: '0' } }, 7), false);
  // 有主普通田 ownerId≠0（R2 排除）
  assert.equal(
    isFreeField(mk(106, { r: { itemId: 106, ownerId: '5', aid: '0', allianceAreaOwner: 0 } }), 7),
    false,
  );
  // 异族田（油 itemId 506 组=5）对金家族不匹配
  assert.equal(isFreeField(mk(506), 7), false);
});

// rankCandidates/surveyCenters 随 901 普查选地一起下线（选地改 906 服务端搜索，见 core/map.searchPoint + core/resource.js）；
// R3「等级最高优先」现由 searchBuildPoint 逐级降序在运行时实现（依赖 net/map，非纯函数），不再单测。

test('shouldDropLedgerEntry（BL-4 未认领超时）：已撤回即时清；未认领超时判清；已认领交活表另判', () => {
  const to = 15 * 60 * 1000;
  assert.equal(shouldDropLedgerEntry(null, 0, to), false);
  assert.equal(
    shouldDropLedgerEntry({ recalledAt: 1, towerId: 't1', dispatchedAt: 0 }, 1e9, to),
    true,
  );
  // 未认领且已超时 → 清
  assert.equal(shouldDropLedgerEntry({ towerId: '', dispatchedAt: 1000 }, 1000 + to, to), true);
  // 未认领但仍在窗口内 → 留
  assert.equal(
    shouldDropLedgerEntry({ towerId: '', dispatchedAt: 1000 }, 1000 + to - 1, to),
    false,
  );
  // 已认领（towerId 非空）→ 本函数不动，交 reconcile 按活表判
  assert.equal(shouldDropLedgerEntry({ towerId: 't9', dispatchedAt: 0 }, 1e9, to), false);
});

test('remainingLifeSec（MA-1 非负化）：查不到寿命/btime 回 null；到期负值压 0；正常正值原样', () => {
  const life8 = () => 8000;
  assert.equal(remainingLifeSec({ bid: 53006, btime: 0 }, 100, life8), null); // 无 btime
  assert.equal(
    remainingLifeSec({ bid: 53006, btime: 1000 }, 100, () => 0),
    null,
  ); // 寿命查不到
  assert.equal(remainingLifeSec({ bid: 53006, btime: 1000 }, 2000, life8), 7000); // 1000+8000-2000
  assert.equal(remainingLifeSec({ bid: 53006, btime: 1000 }, 10000, life8), 0); // -1000 压 0（仍 < guard 判 expiring）
});
