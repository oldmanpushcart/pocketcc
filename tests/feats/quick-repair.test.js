// quickRepair（快速修理）纯函数单测：v3 三场地配置归一 + 单位分类 + 队列投影/条目 + 场地决策
// （基地/战场抢修车间/无双）+ 1785/1426/6310 读投影 + 钻石/道具预算 + 下拍择时。
// 断言的是「计划决策/纯判据」，不含发包形态与真实网络（后者由 replay 对拍覆盖）。
// feat 模块 import 链会触到浏览器全局（reactor/storage/net），故先最小桩化 window/document/chrome，再动态 import 取导出纯函数。
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

// core 链里的常驻 setInterval 只对测试 harness unref（否则 node --test 进程不退出）。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/player/quick-repair/index.js');
const {
  normalize,
  migrateConfig,
  defaultConfig,
  venueOptions,
  classCodeOf,
  venueCodes,
  repairIncludes,
  cellSpeedMode,
  cellMode,
  classifyUnit,
  tierOf,
  unitClassKey,
  baseWaitEntries,
  baseRepairEntries,
  csbWaitEntries,
  csbRepairEntries,
  avaEntries,
  sumLeft,
  isThorBand,
  csbOpen,
  csbClosingSoon,
  csbDeadlineSec,
  makeBudget,
  takeItem,
  planBase,
  planCsb,
  planAva,
  KIND,
  quickFields,
  isParamErrorRet,
  isHealBatchCmd,
  LOCAL_SYNC_KINDS,
  FP_FAMILY,
  isPending,
  markPending,
  prunePendingByExit,
  prunePendingConfirmed,
  estimateGold,
  parseRepairCost,
  pickSpeedItem,
  itemSpeedParam,
  goldPlannedFor,
  planActions,
  nextDelayMs,
  cfg,
  CMD_ARMY_HEAL_LIST,
  CMD_ARMY_CROSS_HEAL,
  CMD_ORDER_QUEUE_ING_DONE,
  CMD_ORDER_QUEUE_SPEED_UP,
  CMD_SPEEDUP_CROSS_GOLD,
  CMD_ITEM_USE,
  CMD_AVA_ASK,
  CMD_AVA_CURE,
  CMD_AVA_SPEED,
  CMD_TM_CURE,
  AVA_MODE_CMDS,
  AVA_GOLD_CFG,
  AVA_HOSPITAL_SPEED_ITEM,
  PUSH_AVA_HOSPITAL_CHANGE,
  pickAvaMode,
  estimateAvaGold,
  speedItemNum,
  HEAL_LANES,
  ORDER_TYPE_HEAL,
  ITEM_TYPE_HOSPITAL_SPEED,
} = mod;

// ─────────────────────────── 协议常量 ───────────────────────────
test('协议常量字面（对拍/单测共用单一真相）：医院加速道具 type=12、伤兵队列 type=1', () => {
  assert.equal(ITEM_TYPE_HOSPITAL_SPEED, 12);
  assert.equal(ORDER_TYPE_HEAL, 1);
  // 关闸前优先窗口：内置 10 分钟，不出面板
  assert.equal(cfg.csbClosingSoonSec, 600);
});

// ─────────────────────────── 单位分类（classify.js）───────────────────────────
test('classifyUnit：军种按 Data.type 101/201/301；类型按 thor_group/glorious_science_group 两档', () => {
  assert.deepEqual(classifyUnit({ Data: { type: 101, thor_group: 0 } }), {
    arm: 'land',
    tier: 'normal',
    exact: true,
  });
  assert.deepEqual(classifyUnit({ Data: { type: 201, thor_group: 2 } }), {
    arm: 'navy',
    tier: 'thor',
    exact: true,
  });
  assert.deepEqual(classifyUnit({ Data: { type: 301, thor_group: 120 } }), {
    arm: 'air',
    tier: 'thor',
    exact: true,
  });
  // 超级雷神判据合并到 thor：glorious_science_group>0
  assert.equal(tierOf({ Data: { thor_group: 0, glorious_science_group: 1 } }), 'thor');
  // 判据缺失按兜底（缺省陆·普通；csb 可传雷神兜底）；Data 在但 type 非法 → 军种兜底、类型照判
  assert.deepEqual(classifyUnit(null), { arm: 'land', tier: 'normal', exact: false });
  assert.deepEqual(classifyUnit({ Data: { type: 999 } }, { arm: 'land', tier: 'thor' }), {
    arm: 'land',
    tier: 'normal',
    exact: true,
  });
  assert.equal(unitClassKey('base', 'navy', 'thor'), 'base.navy.thor');
});

// ─────────────────────────── 配置 schema（v5）───────────────────────────
test('defaultConfig：基地/无双默认修三军种普通兵 mode=1、抢修车间全 0、日上限 0（不限）', () => {
  assert.deepEqual(defaultConfig(), {
    repairBase: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 1, 6: 0 },
    repairCsb: { 2: 0, 4: 0, 6: 0 },
    repairAva: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 1, 6: 0 },
    goldDailyCap: 0,
    pollIntervalSec: 60,
  });
});

test('类型码 1..6 按 军种×类型 排列；抢修车间只给雷神档码', () => {
  assert.equal(classCodeOf('land', 'normal'), 1);
  assert.equal(classCodeOf('land', 'thor'), 2);
  assert.equal(classCodeOf('navy', 'normal'), 3);
  assert.equal(classCodeOf('navy', 'thor'), 4);
  assert.equal(classCodeOf('air', 'normal'), 5);
  assert.equal(classCodeOf('air', 'thor'), 6);
  assert.equal(classCodeOf('land', 'bogus'), 0);
  assert.deepEqual(venueCodes('base'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(venueCodes('csb'), [2, 4, 6]);
  assert.deepEqual(
    venueOptions('csb').map((o) => o.value),
    [2, 4, 6],
  );
  assert.equal(venueOptions('csb')[0].label, '陆·雷神');
});

test('normalize：每格 mode 过滤到场地可选集、mode 限制 0~3、日上限/轮询钳制；数组回默认', () => {
  const d = normalize({});
  assert.deepEqual(d, defaultConfig());
  // 抢修车间过滤普通兵码（1/3/5）与越界码；mode 超范围回 0
  const csb = normalize({ repairCsb: { 2: 3, 4: 1, 6: 0, 1: 2, 99: 3 } });
  assert.deepEqual(csb.repairCsb, { 2: 3, 4: 1, 6: 0 });
  // 数组回默认（v4 格式残留）
  assert.deepEqual(normalize({ repairBase: [1, 3, 5] }).repairBase, {
    1: 1,
    2: 0,
    3: 1,
    4: 0,
    5: 1,
    6: 0,
  });
  // mode 非法值回 0
  assert.equal(normalize({ repairBase: { 1: 9, 2: -1, 3: 'x' } }).repairBase[1], 0);
  assert.equal(normalize({ repairBase: { 1: 9, 2: -1, 3: 'x' } }).repairBase[2], 0);
  assert.equal(normalize({ repairBase: { 1: 9, 2: -1, 3: 'x' } }).repairBase[3], 0);
  // 日上限：<=0/非法 → 0（不限）；正数取整
  assert.equal(normalize({ goldDailyCap: -5 }).goldDailyCap, 0);
  assert.equal(normalize({ goldDailyCap: 'x' }).goldDailyCap, 0);
  assert.equal(normalize({ goldDailyCap: 500.9 }).goldDailyCap, 500);
  // 轮询：非法回 60；上界 3600
  assert.equal(normalize({ pollIntervalSec: 0 }).pollIntervalSec, 60);
  assert.equal(normalize({ pollIntervalSec: 999999 }).pollIntervalSec, 3600);
});

test('repairIncludes/cellSpeedMode：按格 mode 判选中与加速档', () => {
  const c = normalize({
    repairBase: { 1: 3, 2: 2, 3: 1, 4: 0, 5: 0, 6: 0 },
    repairCsb: { 2: 3, 4: 3, 6: 3 },
  });
  assert.equal(repairIncludes(c, 'base', 'land', 'normal'), true); // mode 3
  assert.equal(repairIncludes(c, 'base', 'land', 'thor'), true); // mode 2
  assert.equal(repairIncludes(c, 'base', 'navy', 'normal'), true); // mode 1
  assert.equal(repairIncludes(c, 'base', 'navy', 'thor'), false); // mode 0
  assert.equal(repairIncludes(c, 'base', 'air', 'normal'), false); // mode 0
  assert.equal(cellSpeedMode(c, 'base', 'land', 'normal'), 'gold'); // mode 3
  assert.equal(cellSpeedMode(c, 'base', 'land', 'thor'), 'item'); // mode 2
  assert.equal(cellSpeedMode(c, 'base', 'navy', 'normal'), 'none'); // mode 1
  assert.equal(cellSpeedMode(c, 'csb', 'land', 'thor'), 'gold'); // mode 3
  assert.equal(cellMode(c, 'base', 4), 0);
});

test('migrateConfig：v1/v2 旧开关 + v3 九码 + v4 六码数组 → v5 每格 mode；fresh install 不动', () => {
  // v1：freeRepair/speedGold/speedItem（钻石优先），thor 关 → 普通兵三格 gold=3
  const v1 = {
    freeRepair: true,
    speedGold: true,
    speedItem: true,
    pollIntervalSec: 60,
  };
  migrateConfig(v1, 1);
  assert.deepEqual(v1.repairBase, { 1: 3, 2: 0, 3: 3, 4: 0, 5: 3, 6: 0 });
  assert.deepEqual(v1.repairAva, { 1: 3, 2: 0, 3: 3, 4: 0, 5: 3, 6: 0 });
  assert.deepEqual(v1.repairCsb, { 2: 0, 4: 0, 6: 0 });
  assert.equal(v1.speedBaseNormal, undefined);
  assert.equal(v1.speedCsb, undefined);
  assert.equal(v1.freeRepair, undefined);
  assert.equal(v1.speedGold, undefined);
  assert.equal(v1.speedItem, undefined);
  // v1 freeRepair=false → 全格不修 mode 0
  const v1off = { freeRepair: false };
  migrateConfig(v1off, 1);
  assert.deepEqual(v1off.repairBase, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 });
  // v2：普通+雷神全开、方式 item/gold → 普通 item=2、雷神 gold=3
  const v2 = {
    commonRepair: true,
    thorRepair: true,
    speedCommon: 'item',
    speedThor: 'gold',
  };
  migrateConfig(v2, 2);
  assert.deepEqual(v2.repairBase, { 1: 2, 2: 3, 3: 2, 4: 3, 5: 2, 6: 3 });
  assert.deepEqual(v2.repairCsb, { 2: 3, 4: 3, 6: 3 });
  assert.deepEqual(v2.repairAva, { 1: 2, 2: 3, 3: 2, 4: 3, 5: 2, 6: 3 });
  assert.equal(v2.speedBaseThor, undefined);
  assert.equal(v2.commonRepair, undefined);
  assert.equal(v2.thorRepair, undefined);
  // v3→v5：九码映射为六码（super合并到 thor），无速度键 → 选中档 mode 1
  const v3 = { repairBase: [1, 2, 3, 4, 5, 6, 7, 8, 9], repairCsb: [2, 3, 5, 6, 8, 9] };
  migrateConfig(v3, 3);
  assert.deepEqual(v3.repairBase, { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 });
  assert.deepEqual(v3.repairCsb, { 2: 1, 4: 1, 6: 1 });
  // v4→v5：数组 + speedCsb gold → 雷神档 gold=3
  const v4 = {
    repairBase: [1, 3, 5],
    repairCsb: [2, 4, 6],
    speedBaseNormal: 'item',
    speedCsb: 'gold',
  };
  migrateConfig(v4, 4);
  assert.deepEqual(v4.repairBase, { 1: 2, 2: 0, 3: 2, 4: 0, 5: 2, 6: 0 });
  assert.deepEqual(v4.repairCsb, { 2: 3, 4: 3, 6: 3 });
  // fresh install（fromVersion 0 无旧键）不动
  const fresh = { repairBase: [1] };
  migrateConfig(fresh, 0);
  assert.deepEqual(fresh, { repairBase: [1] });
});

// ─────────────────────────── 队列 → 条目（entries.js）───────────────────────────
test('baseWaitEntries：type===1 && orderId!=="0" && state===0；key=id#orderId#endTime；unitOf 分类', () => {
  const queues = [
    { id: '11', orderId: 'a', endTime: 100, type: ORDER_TYPE_HEAL, state: 0 },
    { id: '22', orderId: 'b', endTime: 200, type: ORDER_TYPE_HEAL, state: 1 },
    { id: '33', orderId: '0', endTime: 300, type: ORDER_TYPE_HEAL, state: 0 },
    { id: '44', orderId: 'd', endTime: 400, type: 2, state: 0 },
    null,
  ];
  const unitOf = (oid) => ({
    arm: oid === 'a' ? 'navy' : 'land',
    tier: oid === 'b' ? 'thor' : 'normal',
  });
  const r = baseWaitEntries(queues, unitOf);
  assert.deepEqual(r, [{ id: '11', key: '11#a#100', orderId: 'a', arm: 'navy', tier: 'normal' }]);
  // 同槽再次受伤（endTime 变）→ 新令牌
  const again = baseWaitEntries(
    [{ id: '11', orderId: 'a', endTime: 101, type: ORDER_TYPE_HEAL, state: 0 }],
    unitOf,
  );
  assert.equal(again[0].key, '11#a#101');
  assert.deepEqual(baseWaitEntries(null, unitOf), []);
});

test('baseRepairEntries：state1 逐队列剩余秒，type 缺失容忍；serverTime 不可判定回 0', () => {
  const queues = [
    { id: '1', orderId: 'a', state: 1, endTime: 1000 },
    { id: '2', orderId: 'b', state: 1, endTime: 800, type: ORDER_TYPE_HEAL },
    { id: '3', orderId: '0', state: 1, endTime: 9999, type: ORDER_TYPE_HEAL },
    { id: '4', orderId: 'd', state: 0, endTime: 5000, type: ORDER_TYPE_HEAL },
  ];
  const unitOf = (oid) => ({ arm: 'land', tier: oid === 'b' ? 'thor' : 'normal' });
  const r = baseRepairEntries(queues, 500, unitOf);
  assert.deepEqual(r, [
    { id: '1', arm: 'land', tier: 'normal', left: 500 },
    { id: '2', arm: 'land', tier: 'thor', left: 300 },
  ]);
  const z = baseRepairEntries(queues, 0, unitOf);
  assert.equal(z[0].left, 0);
  assert.equal(z[1].left, 0);
  assert.deepEqual(baseRepairEntries(null, 500, unitOf), []);
});

test('csb 条目：st===0 待修 / st>0 在修；army 缺失按雷神兜底；key=id#army#et', () => {
  const data = {
    queues: [
      { army: 'a', id: '10', st: 0, et: 0 },
      { id: '11', st: 0, et: 0 }, // 无 army（判据缺失）→ 雷神兜底
      { army: 'b', id: '20', st: 1794112460, et: 1794125551 },
      { army: 'c', id: '21', st: 1794112460, et: 1794112400 }, // 已过期 → left 0 仍列
    ],
  };
  const unitOf = (uuid) =>
    uuid === 'a' ? { arm: 'navy', tier: 'thor' } : { arm: 'air', tier: 'thor' };
  const wait = csbWaitEntries(data, unitOf);
  assert.deepEqual(wait, [
    { id: '10', key: '10#a#0', arm: 'navy', tier: 'thor' },
    { id: '11', key: '11##0', arm: 'land', tier: 'thor' },
  ]);
  const repair = csbRepairEntries(data, 1794125551 - 3600, unitOf);
  assert.deepEqual(repair, [
    { id: '20', arm: 'air', tier: 'thor', left: 3600 },
    { id: '21', arm: 'air', tier: 'thor', left: 0 },
  ]);
  assert.deepEqual(csbWaitEntries(null, unitOf), []);
  assert.deepEqual(csbRepairEntries({ queues: null }, 1, unitOf), []);
});

test('avaEntries：6310 list 按 state 拆 wait/repairing，orderId=0 空槽跳过；sumLeft/isThorBand', () => {
  const list = [
    { id: 'a1', orderId: 'a1', state: 0, endTime: 0 },
    { id: 't1', orderId: 't1', state: 0, endTime: 0 },
    { id: 'x1', orderId: 'x1', state: 1, endTime: 1000 },
    { id: 'slot', orderId: '0', state: 0, endTime: 0 },
  ];
  const unitOf = (oid) => ({ arm: 'land', tier: oid === 't1' ? 'thor' : 'normal' });
  const r = avaEntries(list, 500, unitOf);
  assert.deepEqual(r.wait, [
    { id: 'a1', orderId: 'a1', arm: 'land', tier: 'normal' },
    { id: 't1', orderId: 't1', arm: 'land', tier: 'thor' },
  ]);
  assert.deepEqual(r.repairing, [{ id: 'x1', arm: 'land', tier: 'normal', left: 500 }]);
  assert.equal(sumLeft(r.repairing), 500);
  assert.equal(sumLeft([{ left: 0 }, { left: -3 }]), 0);
  assert.equal(isThorBand('thor'), true);
  assert.equal(isThorBand('normal'), false);
  assert.deepEqual(avaEntries(null, 0, unitOf), { wait: [], repairing: [] });
});

// ─────────────────────────── 1785 额度投影 ───────────────────────────
test('quickFields：录制实证载荷 → commonFreeLeft=common_max-common_use，thor 族 *_max=0 归零', () => {
  const q = quickFields({
    common_max: 77,
    common_use: 59,
    thor_max: 0,
    thor_use: 0,
    landThor_max: 0,
    landThor_use: 0,
    navyThor_max: 0,
    navyThor_use: 0,
    airThor_max: 0,
    airThor_use: 0,
    ret: [
      { num: 47, id: 10001 },
      { num: 30, id: 10002 },
      { num: 0, id: 10003 },
    ],
  });
  assert.equal(q.ok, true);
  assert.equal(q.commonMax, 77);
  assert.equal(q.commonUse, 59);
  assert.equal(q.commonFreeLeft, 18);
  assert.equal(q.thorFreeLeft, 0);
  assert.equal(q.landThorFreeLeft, 0);
  assert.equal(q.groupNum[10001], 47);
  assert.equal(q.groupNum[10002], 30);
  assert.equal(q.groupNum[10003], 0);
});

test('quickFields：额度取负钳 0；非对象/键缺失返回 null', () => {
  assert.equal(quickFields({ common_max: 10, common_use: 30 }).commonFreeLeft, 0);
  assert.equal(quickFields(null), null);
  assert.equal(quickFields({}), null);
});

// ─────────────────── 拒绝判据 / 动作族表 ───────────────────
test('isParamErrorRet：拒绝原因含 common_159995 → true；其他错误码/空 → false', () => {
  assert.equal(isParamErrorRet({ reason: 'common_159995' }), true);
  assert.equal(isParamErrorRet({ data: 'common_159995' }), true);
  assert.equal(isParamErrorRet({ reason: 'item_124017' }), false);
  assert.equal(isParamErrorRet({ reason: 'common_1599950' }), true);
  assert.equal(isParamErrorRet(null), false);
  assert.equal(isParamErrorRet({}), false);
});

test('isHealBatchCmd：220/1427 为原子批量治疗；其余写命令不是', () => {
  assert.equal(isHealBatchCmd(CMD_ARMY_HEAL_LIST), true);
  assert.equal(isHealBatchCmd(CMD_ARMY_CROSS_HEAL), true);
  assert.equal(isHealBatchCmd(CMD_ITEM_USE), false);
  assert.equal(isHealBatchCmd(CMD_ORDER_QUEUE_ING_DONE), false);
});

test('LOCAL_SYNC_KINDS：仅本地 220/151 流回灌 UpdateOrderQueues；本地道具 815 与跨服/无双不在', () => {
  assert.equal(LOCAL_SYNC_KINDS[KIND.HEAL_BASE], true);
  assert.equal(LOCAL_SYNC_KINDS[KIND.SPEED_GOLD_BASE], true);
  assert.equal(LOCAL_SYNC_KINDS[KIND.SPEED_ITEM_BASE], undefined);
  assert.equal(LOCAL_SYNC_KINDS[KIND.HEAL_CSB], undefined);
  assert.equal(LOCAL_SYNC_KINDS[KIND.SPEED_GOLD_CSB], undefined);
  assert.equal(LOCAL_SYNC_KINDS[KIND.HEAL_AVA], undefined);
});

test('FP_FAMILY：三场地 × 治疗/加速 全族登记（lw/cw/aw 与 lr/cr/ar）', () => {
  assert.equal(FP_FAMILY[KIND.HEAL_BASE], 'lw');
  assert.equal(FP_FAMILY[KIND.HEAL_CSB], 'cw');
  assert.equal(FP_FAMILY[KIND.HEAL_AVA], 'aw');
  assert.equal(FP_FAMILY[KIND.HEAL_AVA_THOR], 'aw');
  assert.equal(FP_FAMILY[KIND.SPEED_GOLD_BASE], 'lr');
  assert.equal(FP_FAMILY[KIND.SPEED_ITEM_BASE], 'lr');
  assert.equal(FP_FAMILY[KIND.SPEED_GOLD_CSB], 'cr');
  assert.equal(FP_FAMILY[KIND.SPEED_ITEM_CSB], 'cr');
  assert.equal(FP_FAMILY[KIND.SPEED_GOLD_AVA], 'ar');
  assert.equal(FP_FAMILY[KIND.SPEED_GOLD_AVA_THOR], 'ar');
  assert.equal(FP_FAMILY[KIND.SPEED_ITEM_AVA], 'ar');
  assert.equal(FP_FAMILY[KIND.SPEED_ITEM_AVA_THOR], 'ar');
});

test('HEAL_LANES：基地/抢修车间治疗触发同拍二次加速；无双 cure 与加速类不触发', () => {
  assert.equal(HEAL_LANES[KIND.HEAL_BASE], true);
  assert.equal(HEAL_LANES[KIND.HEAL_CSB], true);
  assert.equal(HEAL_LANES[KIND.HEAL_AVA], undefined);
  assert.equal(HEAL_LANES[KIND.SPEED_GOLD_BASE], undefined);
  assert.equal(HEAL_LANES[KIND.SPEED_ITEM_BASE], undefined);
});

// ─────────────────────────── 在途令牌模型 ───────────────────────────
test('markPending 恒在途（无 TTL）+ prunePendingByExit 仅按本族活跃集遗忘、他族不误删', () => {
  const fp = KIND.HEAL_BASE;
  markPending(fp, ['900#A#111', '901#B#222']);
  assert.equal(isPending(fp + '|900#A#111'), true);
  assert.equal(isPending(fp + '|901#B#222'), true);
  markPending(KIND.SPEED_GOLD_BASE, ['950']);
  assert.equal(isPending(KIND.SPEED_GOLD_BASE + '|950'), true);
  prunePendingByExit('lw', new Set(['900#A#111']));
  assert.equal(isPending(fp + '|900#A#111'), true);
  assert.equal(isPending(fp + '|901#B#222'), false);
  assert.equal(isPending(KIND.SPEED_GOLD_BASE + '|950'), true);
  prunePendingByExit('lr', new Set());
  assert.equal(isPending(KIND.SPEED_GOLD_BASE + '|950'), false);
});

test('道具线 pending 读序放行：prunePendingConfirmed 只清早于本次读的有限确认时刻、按族隔离', () => {
  markPending(KIND.SPEED_ITEM_BASE, ['q1', 'q2'], 1000);
  markPending(KIND.SPEED_ITEM_CSB, ['x1'], 1000);
  markPending(KIND.SPEED_GOLD_BASE, ['q1']);
  markPending(KIND.HEAL_BASE, ['t1']);
  assert.equal(isPending(KIND.SPEED_ITEM_BASE + '|q1'), true);
  prunePendingConfirmed('lr', 999);
  assert.equal(isPending(KIND.SPEED_ITEM_BASE + '|q1'), true);
  prunePendingConfirmed('lr', 1500);
  assert.equal(isPending(KIND.SPEED_ITEM_BASE + '|q1'), false);
  assert.equal(isPending(KIND.SPEED_ITEM_BASE + '|q2'), false);
  assert.equal(isPending(KIND.SPEED_ITEM_CSB + '|x1'), true);
  assert.equal(isPending(KIND.SPEED_GOLD_BASE + '|q1'), true);
  assert.equal(isPending(KIND.HEAL_BASE + '|t1'), true);
  prunePendingByExit('lr', new Set());
  assert.equal(isPending(KIND.SPEED_GOLD_BASE + '|q1'), false);
  prunePendingConfirmed('cr', 1500);
  assert.equal(isPending(KIND.SPEED_ITEM_CSB + '|x1'), false);
  prunePendingByExit('lw', new Set());
  assert.equal(isPending(KIND.HEAL_BASE + '|t1'), false);
});

test('道具线逐队列令牌同享读序放行：截断的单队列下拍可重试、不永久锁', () => {
  markPending(KIND.SPEED_ITEM_BASE, ['huge'], 2000);
  prunePendingByExit('lr', new Set(['huge']));
  assert.equal(isPending(KIND.SPEED_ITEM_BASE + '|huge'), true);
  prunePendingConfirmed('lr', 2500);
  assert.equal(isPending(KIND.SPEED_ITEM_BASE + '|huge'), false);
});

// ─────────────────────────── 成本/道具纯函数 ───────────────────────────
test('parseRepairCost："resId|amt,…" → [{resId,amount}]；非法片段忽略', () => {
  assert.deepEqual(parseRepairCost('1|50,2|30'), [
    { resId: 1, amount: 50 },
    { resId: 2, amount: 30 },
  ]);
  assert.deepEqual(parseRepairCost('1|50,0|9,2|-3,x|7,3|5'), [
    { resId: 1, amount: 50 },
    { resId: 3, amount: 5 },
  ]);
  assert.deepEqual(parseRepairCost(''), []);
  assert.deepEqual(parseRepairCost(null), []);
  assert.deepEqual(parseRepairCost(123), []);
});

test('estimateGold：ceil(秒/60×rate) 至少 1；rate<=0 或 leftSec<=0 返回 0', () => {
  assert.equal(estimateGold(120, 2), 4);
  assert.equal(estimateGold(30, 2), 1);
  assert.equal(estimateGold(61, 1), 2);
  assert.equal(estimateGold(0, 5), 0);
  assert.equal(estimateGold(100, 0), 0);
  assert.equal(estimateGold(100, -3), 0);
});

test('pickSpeedItem：取持有最多者，并列取 id 小；无持有/非法行跳过，空则 null', () => {
  const held = [
    { id: 920002, amount: 10 },
    { id: 920001, amount: 10 },
    { id: 920003, amount: 3 },
    { id: 0, amount: 99 },
    { id: 920004, amount: 0 },
    null,
  ];
  const r = pickSpeedItem(held);
  assert.equal(r.itemId, 920001);
  assert.equal(r.amount, 10);
  assert.equal(r.usable, 10);
  assert.equal(pickSpeedItem([{ id: 920005, amount: 0 }]), null);
  assert.equal(pickSpeedItem([]), null);
  assert.equal(pickSpeedItem(null), null);
});

test('itemSpeedParam：本地全量=null、本地单条=id、跨服全量="1|0"/"1,type"、跨服单条="1|"+id', () => {
  assert.equal(itemSpeedParam(false, '555'), '555');
  assert.equal(itemSpeedParam(true, '555'), '1|555');
  assert.equal(itemSpeedParam(false, null, -1), null);
  assert.equal(itemSpeedParam(false, null, 101), null);
  assert.equal(itemSpeedParam(true, null, -1), '1|0');
  assert.equal(itemSpeedParam(true, null, 201), '1,201');
});

test('takeItem：时间池折算受持有量与单次上限双封顶；para1 不可解回退 1 枚；池空/缺失记 err', () => {
  const si = { itemId: 510002, secPerUse: 600, useMax: 0 };
  const pool = { si, left: 10 };
  assert.deepEqual(takeItem(pool, 3600), { num: 6, si });
  assert.equal(pool.left, 4);
  // 持有量封顶
  const p2 = { si, left: 4 };
  assert.equal(takeItem(p2, 3600).num, 4);
  assert.equal(p2.left, 0);
  // 单次上限封顶
  const p3 = { si: { itemId: 510002, secPerUse: 600, useMax: 3 }, left: 100 };
  assert.equal(takeItem(p3, 3600).num, 3);
  // para1 不可解 → 回退单枚
  const p4 = { si: { itemId: 510002, secPerUse: 0 }, left: 5 };
  assert.equal(takeItem(p4, 3600).num, 1);
  // 池空 / 缺失 → err（不发必拒空包）
  assert.ok(takeItem(null, 100).err);
  assert.ok(takeItem({ si, left: 0 }, 100).err);
  assert.ok(takeItem({ si: { itemId: 1, secPerUse: 600 }, left: 0 }, 100).err);
});

test('makeBudget：钻石原值、普通医院道具池取 usable、无双道具池取 amount', () => {
  assert.deepEqual(makeBudget({ gold: '7' }), { gold: 7, h: null, a: null });
  const b = makeBudget({
    gold: 3,
    speedItem: { itemId: 510002, amount: 10, usable: 8, secPerUse: 600 },
    avaSpeedItem: { itemId: 15100046, amount: 4, secPerUse: 3600 },
  });
  assert.equal(b.gold, 3);
  assert.equal(b.h.left, 8);
  assert.equal(b.a.left, 4);
  assert.equal(b.h.si.itemId, 510002);
});

// ─────────────────────────── 场地闸门（csb 开窗）───────────────────────────
test('csb 闸门：deadline 可判定/不可判定区分；开关关→关；关闸前阈值判定', () => {
  assert.equal(csbDeadlineSec(1000, 900), 100);
  assert.equal(csbDeadlineSec(1000, 1000), 0);
  assert.equal(csbDeadlineSec(0, 900), -1);
  assert.equal(csbDeadlineSec(1000, 0), -1);
  assert.equal(csbOpen(false, 1000, 900), false);
  assert.equal(csbOpen(true, 1000, 900), true);
  assert.equal(csbOpen(true, 900, 900), false);
  assert.equal(csbOpen(true, 0, 0), true); // 判据缺失：宁多读一笔
  assert.equal(csbClosingSoon(100, 600), true);
  assert.equal(csbClosingSoon(1000, 600), false);
  assert.equal(csbClosingSoon(-1, 600), false);
  assert.equal(csbClosingSoon(10, 0), false);
});

// ─────────────────────────── 基地修理厂 ───────────────────────────
const SI8H = { itemId: 510002, amount: 100, usable: 100, secPerUse: 28800, useMax: 10000 };

function snapOf(over) {
  return Object.assign(
    {
      quotas: quickFields({ common_max: 77, common_use: 0 }),
      baseWait: [],
      baseRepair: [],
      csbWait: [],
      csbRepair: [],
      csbSkipped: false,
      csbDeadline: -1,
      csbClosingSoon: false,
      localRepairing: 0,
      crossRepairing: 0,
      repairing: 0,
      gold: 0,
      goldCap: 0,
      goldBudgetKnown: true,
      ratePerMin: 2,
      speedItem: null,
      mcfg: normalize({}),
      avaMode: null,
      avaReadOk: false,
      avaWait: [],
      avaRepair: [],
      avaGoldMult: 1,
      avaSpeedItem: null,
    },
    over,
  );
}

test('planBase heal：按 repairBase 选中类型过滤，一笔 220 全发（dedup=条目 key）', () => {
  const snap = snapOf({
    baseWait: [
      { id: '11', key: '11#a#100', orderId: 'a', arm: 'land', tier: 'normal' },
      { id: '22', key: '22#b#200', orderId: 'b', arm: 'land', tier: 'thor' },
    ],
  });
  const actions = [];
  const reasons = [];
  planBase(snap, normalize({}), makeBudget(snap), actions, reasons);
  const heal = actions.find((a) => a.kind === KIND.HEAL_BASE);
  assert.ok(heal);
  assert.equal(heal.cmd, CMD_ARMY_HEAL_LIST);
  assert.deepEqual(heal.body, { ids: ['11'] });
  assert.deepEqual(heal.dedup, ['11#a#100']);
  assert.equal(heal.label, 'base heal 1/2');
  assert.equal(heal.all, undefined); // 逐令牌动作，不走 pendingTokens 全量语义
});

test('planBase heal：全不选 → 记 reason 不发包；雷神码选中 → 雷神队列发出', () => {
  const snap = snapOf({
    baseWait: [{ id: '22', key: '22#b#200', orderId: 'b', arm: 'land', tier: 'thor' }],
  });
  const actions = [];
  const reasons = [];
  planBase(
    snap,
    normalize({ repairBase: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } }),
    makeBudget(snap),
    actions,
    reasons,
  );
  assert.equal(actions.length, 0);
  assert.ok(reasons.some((r) => /no selected class/.test(r)));

  const actions2 = [];
  const reasons2 = [];
  planBase(
    snap,
    normalize({ repairBase: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 } }),
    makeBudget(snap),
    actions2,
    reasons2,
  );
  assert.deepEqual(actions2[0].body, { ids: ['22'] });
});

test('planBase speed 钻石（同档一致）：一笔 151 全量，估价扣预算，pendingTokens=该域 state1 id', () => {
  const snap = snapOf({
    gold: 10,
    baseRepair: [
      { id: '1', arm: 'land', tier: 'normal', left: 60 },
      { id: '2', arm: 'navy', tier: 'normal', left: 60 },
    ],
  });
  const actions = [];
  const reasons = [];
  planBase(
    snap,
    normalize({ repairBase: { 1: 3, 2: 0, 3: 3, 4: 0, 5: 3, 6: 0 } }),
    makeBudget(snap),
    actions,
    reasons,
  );
  const sp = actions.find((a) => a.kind === KIND.SPEED_GOLD_BASE);
  assert.ok(sp);
  assert.equal(sp.cmd, CMD_ORDER_QUEUE_ING_DONE);
  assert.deepEqual(sp.body, {});
  assert.equal(sp.all, true);
  assert.deepEqual(sp.pendingTokens, ['1', '2']);
  assert.equal(sp.goldCost, 4); // ceil(120/60×2)
  assert.ok(goldPlannedFor(actions, false));
});

test('planBase speed 钻石余额不足 → 记 reason 不发包；rate 不可用同理', () => {
  const snap = snapOf({
    gold: 1,
    baseRepair: [{ id: '1', arm: 'land', tier: 'normal', left: 600 }],
  });
  const actions = [];
  const reasons = [];
  planBase(
    snap,
    normalize({ repairBase: { 1: 3, 2: 0, 3: 3, 4: 0, 5: 3, 6: 0 } }),
    makeBudget(snap),
    actions,
    reasons,
  );
  assert.equal(actions.length, 0);
  assert.ok(reasons.some((r) => /gold 1 < estimate 20/.test(r)));

  const actions2 = [];
  const reasons2 = [];
  planBase(
    snapOf({
      gold: 999,
      ratePerMin: 0,
      baseRepair: [{ id: '1', arm: 'land', tier: 'normal', left: 60 }],
    }),
    normalize({ repairBase: { 1: 3, 2: 0, 3: 3, 4: 0, 5: 3, 6: 0 } }),
    makeBudget(snapOf({ gold: 999 })),
    actions2,
    reasons2,
  );
  assert.equal(actions2.length, 0);
  assert.ok(reasons2.some((r) => /gold estimate unavailable/.test(r)));
});

test('planBase speed 道具（同档一致）：815 全量 param=null，枚数=ceil(Σ剩余/para1)', () => {
  const snap = snapOf({
    speedItem: SI8H,
    baseRepair: [
      { id: '1', arm: 'land', tier: 'normal', left: 72000 },
      { id: '2', arm: 'land', tier: 'normal', left: 0 },
    ],
  });
  const budget = makeBudget(snap);
  const actions = [];
  const reasons = [];
  planBase(
    snap,
    normalize({ repairBase: { 1: 2, 2: 0, 3: 2, 4: 0, 5: 2, 6: 0 } }),
    budget,
    actions,
    reasons,
  );
  const sp = actions.find((a) => a.kind === KIND.SPEED_ITEM_BASE);
  assert.ok(sp);
  assert.equal(sp.cmd, CMD_ITEM_USE);
  assert.deepEqual(sp.body, { itemid: 510002, amount: 3, param: null });
  assert.equal(sp.all, true);
  assert.deepEqual(sp.pendingTokens, ['1', '2']);
  assert.equal(budget.h.left, 97);
});

test('planBase speed 方式混排：普通钻石逐队列 124、雷神道具逐队列 815 param=队列id（不走全量）', () => {
  const snap = snapOf({
    gold: 100,
    speedItem: SI8H,
    baseRepair: [
      { id: '1', arm: 'land', tier: 'normal', left: 60 },
      { id: '2', arm: 'land', tier: 'thor', left: 7200 },
    ],
  });
  const actions = [];
  const reasons = [];
  planBase(
    snap,
    normalize({ repairBase: { 1: 3, 2: 2, 3: 3, 4: 2, 5: 3, 6: 2 } }),
    makeBudget(snap),
    actions,
    reasons,
  );
  assert.equal(
    actions.some((a) => a.cmd === CMD_ORDER_QUEUE_ING_DONE),
    false,
  );
  const gold = actions.find((a) => a.kind === KIND.SPEED_GOLD_BASE);
  assert.equal(gold.cmd, CMD_ORDER_QUEUE_SPEED_UP);
  assert.deepEqual(gold.body, { id: '1', useGold: 1 });
  assert.deepEqual(gold.dedup, ['1']);
  const item = actions.find((a) => a.kind === KIND.SPEED_ITEM_BASE);
  assert.equal(item.cmd, CMD_ITEM_USE);
  assert.deepEqual(item.body, { itemid: 510002, amount: 1, param: '2' });
});

test('planBase speed none：在修也不发，记 reason', () => {
  const snap = snapOf({ baseRepair: [{ id: '1', arm: 'land', tier: 'normal', left: 60 }] });
  const actions = [];
  const reasons = [];
  planBase(snap, normalize({}), makeBudget(snap), actions, reasons);
  assert.equal(actions.length, 0);
  assert.ok(reasons.some((r) => /base: speed none/.test(r)));
});

// ─────────────────────────── 战场抢修车间 ───────────────────────────
test('planCsb：门控跳过 → 只记 reason，不读不修不加速', () => {
  const snap = snapOf({
    csbSkipped: true,
    csbWait: [{ id: '10', key: '10#a#0', arm: 'land', tier: 'thor' }],
  });
  const actions = [];
  const reasons = [];
  planCsb(snap, normalize({ repairCsb: { 2: 1, 4: 0, 6: 0 } }), makeBudget(snap), actions, reasons);
  assert.equal(actions.length, 0);
  assert.ok(reasons.some((r) => /gate closed/.test(r)));
});

test('planCsb heal：按 repairCsb 过滤，一笔 1427（dedup=id#army#et）', () => {
  const snap = snapOf({
    csbWait: [
      { id: '10', key: '10#a#0', arm: 'navy', tier: 'thor' },
      { id: '11', key: '11#b#0', arm: 'land', tier: 'thor' },
    ],
  });
  const actions = [];
  const reasons = [];
  planCsb(snap, normalize({ repairCsb: { 2: 0, 4: 1, 6: 0 } }), makeBudget(snap), actions, reasons);
  const heal = actions.find((a) => a.kind === KIND.HEAL_CSB);
  assert.ok(heal);
  assert.equal(heal.cmd, CMD_ARMY_CROSS_HEAL);
  assert.deepEqual(heal.body, { ids: ['10'] });
  assert.deepEqual(heal.dedup, ['10#a#0']);
});

test('planCsb speed 钻石：1428 全量 {}；道具：815 param="1|0"（跨服全量）', () => {
  const snap = snapOf({
    gold: 100,
    ratePerMin: 2,
    csbRepair: [{ id: '20', arm: 'land', tier: 'thor', left: 120 }],
  });
  const a1 = [];
  const r1 = [];
  planCsb(snap, normalize({ repairCsb: { 2: 3, 4: 3, 6: 3 } }), makeBudget(snap), a1, r1);
  const g = a1.find((a) => a.kind === KIND.SPEED_GOLD_CSB);
  assert.ok(g);
  assert.equal(g.cmd, CMD_SPEEDUP_CROSS_GOLD);
  assert.deepEqual(g.body, {});
  assert.equal(g.all, true);
  assert.deepEqual(g.pendingTokens, ['20']);
  assert.equal(g.goldCost, 4);

  const snap2 = snapOf({
    speedItem: SI8H,
    csbRepair: [{ id: '20', arm: 'land', tier: 'thor', left: 57600 }],
  });
  const a2 = [];
  const r2 = [];
  planCsb(snap2, normalize({ repairCsb: { 2: 2, 4: 2, 6: 2 } }), makeBudget(snap2), a2, r2);
  const it = a2.find((a) => a.kind === KIND.SPEED_ITEM_CSB);
  assert.ok(it);
  assert.equal(it.cmd, CMD_ITEM_USE);
  assert.deepEqual(it.body, { itemid: 510002, amount: 2, param: '1|0' });
});

// ─────────────────────────── 无双修理厂 ───────────────────────────
test('planAva：读失败 → 只记 reason；全选待修 → 一笔 6311 批量', () => {
  const snap = snapOf({ avaMode: 'ava', avaReadOk: false });
  const a1 = [];
  const r1 = [];
  planAva(snap, normalize({}), AVA_MODE_CMDS.ava, makeBudget(snap), a1, r1);
  assert.equal(a1.length, 0);
  assert.ok(r1.some((r) => /hospital read failed/.test(r)));

  const snap2 = snapOf({
    avaMode: 'ava',
    avaReadOk: true,
    avaWait: [
      { id: 'a1', orderId: 'a1', arm: 'land', tier: 'normal' },
      { id: 'a2', orderId: 'a2', arm: 'navy', tier: 'normal' },
    ],
  });
  const a2 = [];
  const r2 = [];
  planAva(snap2, normalize({}), AVA_MODE_CMDS.ava, makeBudget(snap2), a2, r2);
  const cure = a2.find((a) => a.kind === KIND.HEAL_AVA);
  assert.ok(cure);
  assert.equal(cure.cmd, CMD_AVA_CURE);
  assert.deepEqual(cure.body, { ids: ['a1', 'a2'] });
  assert.deepEqual(cure.dedup, ['a1', 'a2']);
});

test('planAva heal 部分选择：按类型档分批（雷神子集走 heal-ava-thor；无双修理免费不看额度）', () => {
  const snap = snapOf({
    avaMode: 'tm',
    avaReadOk: true,
    avaWait: [
      { id: 'c1', orderId: 'c1', arm: 'land', tier: 'normal' },
      { id: 't1', orderId: 't1', arm: 'land', tier: 'thor' },
      { id: 't2', orderId: 't2', arm: 'air', tier: 'thor' },
    ],
  });
  const actions = [];
  const reasons = [];
  planAva(
    snap,
    normalize({ repairAva: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 6: 1 } }),
    AVA_MODE_CMDS.tm,
    makeBudget(snap),
    actions,
    reasons,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, KIND.HEAL_AVA_THOR);
  assert.equal(actions[0].cmd, CMD_TM_CURE);
  assert.deepEqual(actions[0].body, { ids: ['t1', 't2'] });
});

test('planAva speed 钻石：6312 {ids,useGold:1}，估价=基价×模式倍率；雷神批带 -thor 后缀', () => {
  const snap = snapOf({
    avaMode: 'ava',
    avaReadOk: true,
    gold: 1000,
    ratePerMin: 2,
    avaGoldMult: 3,
    avaRepair: [{ id: 'x1', arm: 'land', tier: 'normal', left: 3600 }],
  });
  const actions = [];
  const reasons = [];
  planAva(
    snap,
    normalize({ repairAva: { 1: 3, 2: 0, 3: 3, 4: 0, 5: 3, 6: 0 } }),
    AVA_MODE_CMDS.ava,
    makeBudget(snap),
    actions,
    reasons,
  );
  const sp = actions.find((a) => a.kind === KIND.SPEED_GOLD_AVA);
  assert.ok(sp);
  assert.equal(sp.cmd, CMD_AVA_SPEED);
  assert.deepEqual(sp.body, { ids: ['x1'], useGold: 1 });
  assert.equal(sp.goldCost, 360); // ceil(60×2)×3
  assert.equal(goldPlannedFor(actions, true), false); // 无双不算跨服域

  const snap2 = snapOf({
    avaMode: 'ava',
    avaReadOk: true,
    gold: 1000,
    ratePerMin: 2,
    avaGoldMult: 1,
    avaRepair: [{ id: 't1', arm: 'land', tier: 'thor', left: 60 }],
  });
  const a2 = [];
  planAva(
    snap2,
    normalize({ repairAva: { 1: 0, 2: 3, 3: 0, 4: 3, 5: 0, 6: 3 } }),
    AVA_MODE_CMDS.ava,
    makeBudget(snap2),
    a2,
    [],
  );
  assert.equal(a2[0].kind, KIND.SPEED_GOLD_AVA_THOR);
});

test('planAva speed 道具：专行 15100046，枚数池级折算，atomic=true（整批跳过不可拆）', () => {
  const snap = snapOf({
    avaMode: 'master',
    avaReadOk: true,
    avaSpeedItem: { itemId: 15100046, amount: 10, secPerUse: 3600, useMax: 0 },
    avaRepair: [{ id: 'x1', arm: 'land', tier: 'normal', left: 7200 }],
  });
  const budget = makeBudget(snap);
  const actions = [];
  planAva(
    snap,
    normalize({ repairAva: { 1: 2, 2: 0, 3: 2, 4: 0, 5: 2, 6: 0 } }),
    AVA_MODE_CMDS.master,
    budget,
    actions,
    [],
  );
  const sp = actions.find((a) => a.kind === KIND.SPEED_ITEM_AVA);
  assert.ok(sp);
  assert.deepEqual(sp.body, { ids: ['x1'], itemId: 15100046, num: 2, useGold: 0 });
  assert.equal(sp.atomic, true);
  assert.equal(budget.a.left, 8);
  assert.equal(sp.cmd, AVA_MODE_CMDS.master.speed);
});

test('planAva speed 混排：普通钻石 / 雷神道具 各一笔；none 档记 reason', () => {
  const snap = snapOf({
    avaMode: 'legend',
    avaReadOk: true,
    gold: 1000,
    ratePerMin: 2,
    avaGoldMult: 1,
    avaSpeedItem: { itemId: 15100046, amount: 10, secPerUse: 3600, useMax: 0 },
    avaRepair: [
      { id: 'c1', arm: 'land', tier: 'normal', left: 60 },
      { id: 't1', arm: 'land', tier: 'thor', left: 7200 },
    ],
  });
  const actions = [];
  const reasons = [];
  planAva(
    snap,
    normalize({ repairAva: { 1: 3, 2: 2, 3: 3, 4: 2, 5: 3, 6: 2 } }),
    AVA_MODE_CMDS.legend,
    makeBudget(snap),
    actions,
    reasons,
  );
  assert.equal(actions.length, 2);
  assert.deepEqual(
    actions.map((a) => a.kind),
    [KIND.SPEED_GOLD_AVA, KIND.SPEED_ITEM_AVA_THOR],
  );
  assert.equal(actions[0].cmd, AVA_MODE_CMDS.legend.speed);
  assert.deepEqual(actions[1].body.ids, ['t1']);

  const a2 = [];
  const r2 = [];
  planAva(
    snapOf({
      avaMode: 'ava',
      avaReadOk: true,
      avaRepair: [{ id: 'c1', arm: 'land', tier: 'normal', left: 60 }],
    }),
    normalize({}),
    AVA_MODE_CMDS.ava,
    makeBudget(snapOf({})),
    a2,
    r2,
  );
  assert.equal(a2.length, 0);
  assert.ok(r2.some((r) => /speed none/.test(r)));
});

// ─────────────────────────── planActions（三场地编排）───────────────────────────
test('planActions：三场地同拍各出各道（220/1427/6311 互不串货），默认不加速', () => {
  const snap = snapOf({
    mcfg: normalize({ repairCsb: { 2: 1, 4: 0, 6: 0 } }),
    baseWait: [{ id: 'b1', key: 'b1#o#1', orderId: 'o', arm: 'land', tier: 'normal' }],
    csbWait: [{ id: 'c1', key: 'c1#a#0', arm: 'land', tier: 'thor' }],
    avaMode: 'ava',
    avaReadOk: true,
    avaWait: [{ id: 'a1', orderId: 'a1', arm: 'land', tier: 'normal' }],
  });
  const { actions, reasons } = planActions(snap);
  const kinds = actions.map((a) => a.kind);
  assert.deepEqual(kinds, [KIND.HEAL_BASE, KIND.HEAL_CSB, KIND.HEAL_AVA]);
  assert.equal(actions[0].cmd, CMD_ARMY_HEAL_LIST);
  assert.equal(actions[1].cmd, CMD_ARMY_CROSS_HEAL);
  assert.equal(actions[2].cmd, CMD_AVA_CURE);
  assert.equal(
    reasons.some((r) => /speed/.test(r)),
    false,
  );
});

test('planActions：csb 关闸前优先 → reason + 抢修车间动作排最前', () => {
  const snap = snapOf({
    mcfg: normalize({ repairCsb: { 2: 1, 4: 0, 6: 0 } }),
    csbClosingSoon: true,
    baseWait: [{ id: 'b1', key: 'b1#o#1', orderId: 'o', arm: 'land', tier: 'normal' }],
    csbWait: [{ id: 'c1', key: 'c1#a#0', arm: 'land', tier: 'thor' }],
  });
  const { actions, reasons } = planActions(snap);
  assert.ok(reasons.some((r) => /csb closing soon/.test(r)));
  assert.equal(actions[0].kind, KIND.HEAL_CSB);
  assert.equal(actions[1].kind, KIND.HEAL_BASE);
});

test('planActions：钻石预算三场地共享——基地先扣后抢修车间余额不足即静默', () => {
  const snap = snapOf({
    mcfg: normalize({
      repairBase: { 1: 3, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      repairCsb: { 2: 3, 4: 0, 6: 0 },
    }),
    gold: 5,
    ratePerMin: 2,
    baseRepair: [{ id: 'b1', arm: 'land', tier: 'normal', left: 120 }],
    csbRepair: [{ id: 'c1', arm: 'land', tier: 'thor', left: 120 }],
  });
  const { actions, reasons } = planActions(snap);
  assert.ok(actions.find((a) => a.kind === KIND.SPEED_GOLD_BASE));
  assert.equal(
    actions.some((a) => a.kind === KIND.SPEED_GOLD_CSB),
    false,
  );
  assert.ok(reasons.some((r) => /gold 1 < estimate 4 \(csb\)/.test(r)));
});

test('planActions：无快照活态时各场地记 reason，不误发', () => {
  const { actions, reasons } = planActions(snapOf({ mcfg: normalize({}) }));
  assert.equal(actions.length, 0);
  assert.ok(reasons.some((r) => /base: no wait/.test(r)));
  assert.ok(reasons.some((r) => /csb: no wait/.test(r)));
});

// ─────────────────────────── nextDelayMs（下拍择时：去勤扫、恒慢心跳）───────────────────────────
test('nextDelayMs：去勤扫后无论忙闲一律慢心跳（>=IDLE）；被拒达阈退避×2；snap 不参与判定', () => {
  const m = normalize({ pollIntervalSec: 60 });
  const idle = Math.max(60000, m.pollIntervalSec * 1000);
  const idleSnap = snapOf({ baseWait: [] });
  const busySnap = snapOf({ baseWait: [{ id: '1', key: '1#o#1', orderId: 'o' }] });
  assert.equal(nextDelayMs(busySnap, m, 0), idle);
  assert.equal(nextDelayMs(idleSnap, m, 0), idle);
  assert.equal(nextDelayMs(busySnap, m, 3), idle * 2);
  assert.ok(nextDelayMs(idleSnap, m, 3) > nextDelayMs(idleSnap, m, 0));
  assert.equal(nextDelayMs(null, m, 0), idle);
});

// ─────────────────────────── 无双协议 / 投影 ───────────────────────────
test('无双协议常量字面（RequestId 实证）：三件套与模式映射表/推送/道具专行', () => {
  assert.equal(CMD_AVA_ASK, 6310);
  assert.equal(CMD_AVA_CURE, 6311);
  assert.equal(CMD_AVA_SPEED, 6312);
  assert.deepEqual(AVA_MODE_CMDS.ava, { ask: 6310, cure: 6311, speed: 6312 });
  assert.deepEqual(AVA_MODE_CMDS.tm, { ask: 6356, cure: 6357, speed: 6358 });
  assert.deepEqual(AVA_MODE_CMDS.master, { ask: 8403, cure: 8404, speed: 8405 });
  assert.deepEqual(AVA_MODE_CMDS.legend, { ask: 9055, cure: 9056, speed: 9057 });
  assert.deepEqual(AVA_GOLD_CFG, { ava: 1663543, tm: 1663622, master: 168036, legend: 1670027 });
  assert.equal(AVA_HOSPITAL_SPEED_ITEM, 15100046);
  assert.equal(PUSH_AVA_HOSPITAL_CHANGE, 21203);
});

test('pickAvaMode：源码 StartAllQueue 同款优先级（AVA→TM→Master→Legend），皆非回 null', () => {
  assert.equal(pickAvaMode({ isNewCAB: true, isTM: true }), 'ava');
  assert.equal(pickAvaMode({ isNewCAB: false, isTM: true, isMaster: true }), 'tm');
  assert.equal(pickAvaMode({ isTM: false, isMaster: true, isLegend: true }), 'master');
  assert.equal(pickAvaMode({ isLegend: true }), 'legend');
  assert.equal(
    pickAvaMode({ isNewCAB: false, isTM: false, isMaster: false, isLegend: false }),
    null,
  );
  assert.equal(pickAvaMode(null), null);
});

// 录制实证形态（20261108T180936-普通无双 6310 resp）：id 与 orderId 同值、十进制串；待修 startTime/endTime=0。
const AVA_LIST_REC = [
  {
    itemId: 0,
    durationTime: 27325,
    orderId: '4323070633691856392',
    startTime: 0,
    id: '4323070633691856392',
    endTime: 0,
    state: 0,
    type: 1,
  },
  {
    itemId: 0,
    durationTime: 27325,
    orderId: '4330888570024771087',
    startTime: 0,
    id: '4330888570024771087',
    endTime: 0,
    state: 0,
    type: 1,
  },
  {
    itemId: 0,
    durationTime: 0,
    orderId: '9000000000000000001',
    startTime: 1794133090,
    id: '9000000000000000001',
    endTime: 1794160415,
    state: 1,
    type: 1,
  },
  {
    itemId: 0,
    durationTime: 27325,
    orderId: '0',
    startTime: 0,
    id: '8888',
    endTime: 0,
    state: 0,
    type: 1,
  },
];
test('avaEntries（录制形态）：state 分集、orderId="0" 空槽跳过；在修秒和按 serverTime 折算', () => {
  const unitOf = () => ({ arm: 'land', tier: 'normal' });
  const r = avaEntries(AVA_LIST_REC, 1794160415 - 3600, unitOf);
  assert.deepEqual(
    r.wait.map((e) => e.id),
    ['4323070633691856392', '4330888570024771087'],
  );
  assert.deepEqual(
    r.repairing.map((e) => e.id),
    ['9000000000000000001'],
  );
  assert.equal(sumLeft(r.repairing), 3600);
  assert.equal(sumLeft(avaEntries(AVA_LIST_REC, 1794160415, unitOf).repairing), 0);
  assert.equal(sumLeft(avaEntries(AVA_LIST_REC, 0, unitOf).repairing), 0);
});

test('estimateAvaGold：基价 ceil(秒/60×rate) × 倍率后 floor、至少 1；rate 不可用回 0；倍率非法按 1', () => {
  assert.equal(estimateAvaGold(3600, 2, 3), 360);
  assert.equal(estimateAvaGold(90, 2, 1.5), Math.max(1, Math.floor(Math.ceil(1.5 * 2) * 1.5)));
  assert.equal(estimateAvaGold(3600, 0, 3), 0);
  assert.equal(estimateAvaGold(3600, 2, 0), 120);
  assert.equal(estimateAvaGold(0, 2, 3), 0);
});

test('speedItemNum：ceil(秒/para1) 受持有量与单次上限双封顶；非法要素回 0', () => {
  assert.equal(speedItemNum(3600, 600, 10, 0), 6);
  assert.equal(speedItemNum(3600, 600, 4, 0), 4);
  assert.equal(speedItemNum(72000, 600, 100, 20), 20);
  assert.equal(speedItemNum(3600, 0, 10, 5), 0);
  assert.equal(speedItemNum(0, 600, 10, 5), 0);
  assert.equal(speedItemNum(3600, 600, 0, 5), 0);
});

// ─────────────────────────── 在修剩余秒（entries 投影） ───────────────────────────
test('在修秒和：csb 按 st>0/et-serverTime、本地按 state1；serverTime 不可判定恒归零', () => {
  const unitOf = () => ({ arm: 'land', tier: 'thor' });
  const serverTime = 1794112470;
  const cross = {
    queues: [
      { army: 'a', id: '1', st: 0, et: 0 },
      { army: 'b', id: '2', st: 1794112460, et: 1794125551 },
      { army: 'c', id: '3', st: 1794112460, et: 1794112400 },
    ],
  };
  assert.equal(sumLeft(csbRepairEntries(cross, serverTime, unitOf)), 1794125551 - serverTime);
  assert.equal(sumLeft(csbRepairEntries(cross, 1794125551 - 60, unitOf)), 60);
  assert.equal(sumLeft(csbRepairEntries(cross, 0, unitOf)), 0);
  const queues = [
    { id: '1', orderId: 'a', type: 1, state: 1, endTime: 1000 },
    { id: '2', orderId: 'b', state: 1, endTime: 800 },
    { id: '3', orderId: '0', state: 1, endTime: 9999 },
    { id: '4', orderId: 'd', state: 0, endTime: 5000 },
  ];
  assert.equal(sumLeft(baseRepairEntries(queues, 500, unitOf)), 500 + 300);
  assert.equal(sumLeft(baseRepairEntries(queues, undefined, unitOf)), 0);
  assert.equal(sumLeft(baseRepairEntries(queues, NaN, unitOf)), 0);
});
