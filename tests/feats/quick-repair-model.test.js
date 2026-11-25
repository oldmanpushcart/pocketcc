// quickRepair 领域模型（P1 拆出的 model/ 纯判据）单测：军种×类型分类、成本折算、免费额度池、场地闸门。
// 这些模块不触游戏态/浏览器全局，直接 import 即可（与 index.js 的单测 harness 分离）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARMS,
  TIERS,
  armOf,
  tierOf,
  classifyUnit,
  isThorTier,
  unitClassKey,
} from '../../extension/src/feats/player/quick-repair/model/classify.js';
import {
  estimateGold,
  estimateAvaGold,
  speedItemNum,
  parseRepairCost,
  sumCosts,
} from '../../extension/src/feats/player/quick-repair/model/cost.js';
import {
  parseQuota,
  freeLeftFor,
  allFreeCovered,
  RAPID_REPAIR_SOURCE,
} from '../../extension/src/feats/player/quick-repair/model/quota.js';
import {
  pickAvaMode,
  csbDeadlineSec,
  csbOpen,
  csbClosingSoon,
} from '../../extension/src/feats/player/quick-repair/model/gates.js';

const army = (type, thorGroup, glorious) => ({
  Data: { type, thor_group: thorGroup, glorious_science_group: glorious },
});

test('classify：军种取 army.Data.type 101/201/301，缺失或非法归陆', () => {
  assert.deepEqual(ARMS, ['land', 'navy', 'air']);
  assert.equal(armOf(army(101)), 'land');
  assert.equal(armOf(army(201)), 'navy');
  assert.equal(armOf(army(301)), 'air');
  assert.equal(armOf(army(999)), null);
  assert.equal(armOf(null), null);
  assert.equal(classifyUnit(army(999)).arm, 'land');
});

test('classify：类型按 thor_group / glorious_science_group 分普通/雷神（超级合并）', () => {
  assert.deepEqual(TIERS, ['normal', 'thor']);
  assert.equal(tierOf(army(101, 0)), 'normal');
  assert.equal(tierOf({ Data: { type: 101 } }), 'normal');
  assert.equal(tierOf(army(101, 1)), 'thor');
  assert.equal(tierOf(army(101, 15)), 'thor');
  assert.equal(tierOf(army(101, 100)), 'thor');
  assert.equal(tierOf(army(101, 600)), 'thor');
  assert.equal(tierOf(army(101, 0, 10000)), 'thor');
  assert.equal(tierOf(army(101, 0, 20000)), 'thor');
  assert.equal(tierOf(null), 'normal');
});

test('classify：classifyUnit 判据缺失走「陆·普通」兜底并标 exact=false', () => {
  assert.deepEqual(classifyUnit(army(201, 5)), { arm: 'navy', tier: 'thor', exact: true });
  assert.deepEqual(classifyUnit(null), { arm: 'land', tier: 'normal', exact: false });
  assert.deepEqual(classifyUnit({}), { arm: 'land', tier: 'normal', exact: false });
});

test('classify：isThorTier / unitClassKey 口径', () => {
  assert.equal(isThorTier('normal'), false);
  assert.equal(isThorTier('thor'), true);
  assert.equal(unitClassKey('base', 'land', 'normal'), 'base.land.normal');
  assert.equal(unitClassKey('csb', 'air', 'thor'), 'csb.air.thor');
});

test('cost：钻石估价 = ceil(秒/60×价) 且至少 1；费率不可用归 0', () => {
  assert.equal(estimateGold(0, 10), 0);
  assert.equal(estimateGold(30, 0), 0);
  assert.equal(estimateGold(1, 10), 1);
  assert.equal(estimateGold(60, 10), 10);
  assert.equal(estimateGold(61, 10), 11);
  assert.equal(estimateGold(3600, 2), 120);
});

test('cost：无双钻石 = 基价×模式倍率向下取整、至少 1；倍率≤0 按 1', () => {
  assert.equal(estimateAvaGold(600, 10, 2), 200);
  assert.equal(estimateAvaGold(60, 10, 1.5), 15);
  assert.equal(estimateAvaGold(1, 1, 0), 1);
  assert.equal(estimateAvaGold(0, 10, 2), 0);
  assert.equal(estimateAvaGold(60, 0, 2), 0);
});

test('cost：道具枚数 = min(ceil(秒/单枚秒), 持有, useMax)；要素非法归 0', () => {
  assert.equal(speedItemNum(28800, 28800, 9, 0), 1);
  assert.equal(speedItemNum(86400, 28800, 9, 0), 3);
  assert.equal(speedItemNum(86400, 28800, 2, 0), 2);
  assert.equal(speedItemNum(86400, 28800, 9, 1), 1);
  assert.equal(speedItemNum(86400, 28800, 0, 0), 0);
  assert.equal(speedItemNum(86400, 0, 9, 0), 0);
  assert.equal(speedItemNum(0, 28800, 9, 0), 0);
  assert.equal(speedItemNum(86400, 28800, 9, -1), 3);
});

test('cost：repair_cost 解析与批量累加（非法片段忽略、空串=[]）', () => {
  assert.deepEqual(parseRepairCost('20|400,5|250000'), [
    { resId: 20, amount: 400 },
    { resId: 5, amount: 250000 },
  ]);
  assert.deepEqual(parseRepairCost(''), []);
  assert.deepEqual(parseRepairCost(undefined), []);
  assert.deepEqual(parseRepairCost('0|400,20|0,abc|x,7|9'), [{ resId: 7, amount: 9 }]);
  assert.deepEqual(
    { ...sumCosts([[{ resId: 20, amount: 400 }], null, [{ resId: 20, amount: 100 }]]) },
    { 20: 500 },
  );
});

test('quota：1785 应答 → 普通/雷神（按军种）池 + 额度来源归因', () => {
  const q = parseQuota({
    common_max: 77,
    common_use: 59,
    thor_max: 0,
    thor_use: 0,
    landThor_max: 3,
    landThor_use: 1,
    navyThor_max: 2,
    navyThor_use: 2,
    airThor_max: 5,
    airThor_use: 0,
    ret: [{ id: 10001, num: 47 }, { id: 10002, num: 30 }, { id: 10003, num: 0 }, 'bad'],
  });
  assert.equal(q.commonFreeLeft, 18);
  assert.equal(q.thorFreeLeft, 0);
  assert.equal(q.landThorFreeLeft, 2);
  assert.equal(q.navyThorFreeLeft, 0);
  assert.equal(q.airThorFreeLeft, 5);
  assert.deepEqual({ ...q.groupNum }, { 10001: 47, 10002: 30, 10003: 0 });
  assert.equal(RAPID_REPAIR_SOURCE[10001], 'hero107');
});

test('quota：空载荷/非法载荷返回 null；额度不会为负', () => {
  assert.equal(parseQuota(null), null);
  assert.equal(parseQuota({}), null);
  assert.equal(parseQuota({ common_max: 5, common_use: 9 }).commonFreeLeft, 0);
});

test('quota：freeLeftFor 按 类型×军种 取池，军种缺失回退合计池；allFreeCovered 镜像 AllCanRepair', () => {
  const q = parseQuota({
    common_max: 77,
    common_use: 59,
    thor_max: 10,
    thor_use: 4,
    landThor_max: 3,
    landThor_use: 1,
  });
  assert.equal(freeLeftFor(q, 'normal', 'land'), 18);
  assert.equal(freeLeftFor(q, 'thor', 'land'), 2);
  assert.equal(freeLeftFor(q, 'thor', 'navy'), 0);
  assert.equal(freeLeftFor(q, 'thor', null), 6);
  assert.equal(freeLeftFor(null, 'normal', 'land'), 0);
  assert.equal(allFreeCovered(q, 18), true);
  assert.equal(allFreeCovered(q, 19), false);
  assert.equal(allFreeCovered(q, 0), false);
});

test('gates：无双模式择表按 AVA→TM→Master→Legend，皆非 null', () => {
  assert.equal(pickAvaMode({ isLegend: true, isMaster: true }), 'master');
  assert.equal(pickAvaMode({ isNewCAB: true, isTM: true, isMaster: true, isLegend: true }), 'ava');
  assert.equal(pickAvaMode({ isTM: true }), 'tm');
  assert.equal(pickAvaMode({}), null);
  assert.equal(pickAvaMode(null), null);
});

test('gates：抢修车间窗口 = HospitalEndTime-ServerTime，不可判定与关闸可区分', () => {
  assert.equal(csbDeadlineSec(1000, 400), 600);
  assert.equal(csbDeadlineSec(400, 400), 0);
  assert.equal(csbDeadlineSec(300, 400), 0);
  assert.equal(csbDeadlineSec(0, 400), -1);
  assert.equal(csbDeadlineSec(1000, 0), -1);
});

test('gates：csbOpen 功能开关关→false；窗口到期→false；判据缺失→照旧开（宁多读一笔）', () => {
  assert.equal(csbOpen(false, 1000, 400), false);
  assert.equal(csbOpen(true, 1000, 400), true);
  assert.equal(csbOpen(true, 400, 400), false);
  assert.equal(csbOpen(null, 0, 400), true);
  assert.equal(csbOpen(undefined, 1000, 0), true);
});

test('gates：关闸前优先档阈值判定（-1 不可判定不算临近）', () => {
  assert.equal(csbClosingSoon(300, 600), true);
  assert.equal(csbClosingSoon(600, 600), true);
  assert.equal(csbClosingSoon(601, 600), false);
  assert.equal(csbClosingSoon(-1, 600), false);
  assert.equal(csbClosingSoon(100, 0), false);
});
