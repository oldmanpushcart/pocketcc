// quickRepair（快速修理）纯函数单测：配置归一 + 1785/1426 权威读投影 + 择时判据（源码 getQuickRepairTipsType 镜像）
// + 雷神判定 + 待修拆分 + 在修剩余秒 + 钻石估价 + 加速道具挑选 + 815 param 编码 + 分层决策 + 下拍择时。
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

const mod = await import('../../extension/src/feats/player/quick-repair.js');
const {
  normalize,
  quickFields,
  isThorArmy,
  splitWaitIds,
  localWaitTokenSet,
  localRepairingIdSet,
  crossWaitIds,
  crossWaitKeySet,
  crossRepairingIds,
  crossRepairingIdSet,
  isParamErrorRet,
  isHealBatchCmd,
  LOCAL_SYNC_KINDS,
  FP_FAMILY,
  isPending,
  markPending,
  prunePendingByExit,
  repairingLeftSec,
  crossRepairingLeftSec,
  estimateGold,
  parseRepairCost,
  filterAffordable,
  pickSpeedItem,
  itemSpeedParam,
  goldPlannedFor,
  planActions,
  planHealActions,
  planSpeedActions,
  nextDelayMs,
  cfg,
  CMD_ARMY_HEAL_LIST,
  CMD_ARMY_CROSS_HEAL,
  CMD_ORDER_QUEUE_ING_DONE,
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
  avaWaitIds,
  avaRepairingIds,
  avaWaitIdSet,
  avaRepairingIdSet,
  avaRepairingLeftSec,
  estimateAvaGold,
  speedItemNum,
  HEAL_LANES,
  ORDER_TYPE_HEAL,
  ITEM_TYPE_HOSPITAL_SPEED,
} = mod;

// ─────────────────────────── normalize ───────────────────────────
test('协议常量字面（对拍/单测共用单一真相）：医院加速道具 type=12、伤兵队列 type=1', () => {
  assert.equal(ITEM_TYPE_HOSPITAL_SPEED, 12);
  assert.equal(ORDER_TYPE_HEAL, 1);
});

test('normalize：freeRepair/resourceRepair 缺键恒视为 true（已不放面板），付费/带材料项缺省 false；goldDailyCap/keepItemNum 已废弃不再输出；poll 钳上下界', () => {
  const d = normalize({});
  assert.equal(d.freeRepair, true);
  assert.equal(d.resourceRepair, true);
  assert.equal(d.thorRepair, false);
  assert.equal(d.speedGold, false);
  assert.equal(d.speedItem, false);
  assert.equal(d.goldDailyCap, undefined);
  assert.equal(d.keepItemNum, undefined);
  assert.equal(d.pollIntervalSec, 60);

  // poll 上界钳到 cfg.maxPollSec；非法值回默认 60
  assert.equal(normalize({ pollIntervalSec: 999999 }).pollIntervalSec, cfg.maxPollSec);
  assert.equal(normalize({ pollIntervalSec: 'x' }).pollIntervalSec, 60);
  // 显式 false 不被缺省 true 覆盖
  assert.equal(normalize({ freeRepair: false }).freeRepair, false);
  assert.equal(normalize({ resourceRepair: false }).resourceRepair, false);
  assert.equal(normalize({ thorRepair: true, speedGold: true, speedItem: true }).thorRepair, true);
  assert.equal(normalize({ resourceRepair: true }).resourceRepair, true);
  // 即便旧存档带 cap/keep，也一律不透传
  assert.equal(normalize({ goldDailyCap: 999, keepItemNum: 5 }).goldDailyCap, undefined);
  assert.equal(normalize({ goldDailyCap: 999, keepItemNum: 5 }).keepItemNum, undefined);
});

// ─────────────────────────── quickFields（1785 投影）───────────────────────────
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
  assert.equal(quickFields({}), null); // 两个关键键都缺 → 判为不可用
});

// ─────────────────────────── isThorArmy ───────────────────────────
test('isThorArmy：Data.thor_group>0 为雷神；拿不到部队/无 Data 保守 false（漏修不可因判据缺失）', () => {
  assert.equal(isThorArmy({ Data: { thor_group: 2 } }), true);
  assert.equal(isThorArmy({ Data: { thor_group: 0 } }), false);
  assert.equal(isThorArmy({ Data: {} }), false);
  assert.equal(isThorArmy(null), false);
});

// ─────────────────────────── splitWaitIds ───────────────────────────
test('splitWaitIds：type===1 && orderId!=="0" && state===0 计入待修；thorOf 分流雷神/普通；keys=id#orderId#endTime 与 ids 对齐', () => {
  const queues = [
    { id: '11', orderId: 'a', endTime: 100, type: ORDER_TYPE_HEAL, state: 0 },
    { id: '22', orderId: 'b', endTime: 200, type: ORDER_TYPE_HEAL, state: 0 },
    { id: '33', orderId: 'c', endTime: 300, type: ORDER_TYPE_HEAL, state: 1 }, // 在修，不待修
    { id: '44', orderId: '0', type: ORDER_TYPE_HEAL, state: 0 }, // orderId=0 跳过
    { id: '55', orderId: 'e', type: 2, state: 0 }, // 非伤兵 type 跳过
    null,
  ];
  const thorOf = (oid) => oid === 'b';
  const r = splitWaitIds(queues, thorOf);
  assert.deepEqual(r.commonIds, ['11']);
  assert.deepEqual(r.thorIds, ['22']);
  assert.deepEqual(r.commonKeys, ['11#a#100']);
  assert.deepEqual(r.commonOrders, ['a']); // 与 commonIds 同序的 orderId（供 repair_cost 查 army）
  assert.deepEqual(r.thorKeys, ['22#b#200']);
  assert.equal(r.waitTotal, 2);
  assert.equal(r.malformed, 1); // null 行记 malformed

  // 无 thorOf：全部当普通兵
  const r2 = splitWaitIds(queues);
  assert.deepEqual(r2.commonIds, ['11', '22']);
  assert.deepEqual(r2.commonOrders, ['a', 'b']);
  assert.deepEqual(r2.thorIds, []);
  assert.deepEqual(r2.commonKeys, ['11#a#100', '22#b#200']);
  assert.deepEqual(r2.thorKeys, []);
  // 非数组 → 空态
  assert.deepEqual(splitWaitIds(null), {
    commonIds: [],
    thorIds: [],
    commonKeys: [],
    thorKeys: [],
    commonOrders: [],
    waitTotal: 0,
    malformed: 0,
  });
});

test('splitWaitIds：同一槽 id 复用不同伤兵（orderId 变）→ 去重键不同（偶发漏修根因之一）', () => {
  // 槽 815 先伤兵 59752、后伤兵 59753：若去重只按槽 id，第二个会被误抑制；含 orderId 后互不干扰
  const queues = [
    { id: '815', orderId: '59752', endTime: 1000, type: ORDER_TYPE_HEAL, state: 0 },
    { id: '815', orderId: '59753', endTime: 1000, type: ORDER_TYPE_HEAL, state: 0 },
  ];
  const r = splitWaitIds(queues);
  assert.deepEqual(r.commonIds, ['815', '815']);
  assert.deepEqual(r.commonKeys, ['815#59752#1000', '815#59753#1000']);
  assert.equal(new Set(r.commonKeys).size, 2); // 两伤兵去重键相异
});

test('splitWaitIds：同一部队（id+orderId 相同）再次受伤（endTime 变）→ 去重键不同（不重复漏修）', () => {
  // 真机 20261108T020420：槽 353344/orderId 59752 治好（endTime E1）后又被打伤（同 orderId、endTime E2）；
  // 若去重键不含 endTime，同队新伤会被误当陈旧幻影抑制→漏修 1 个（在途令牌 pending 模型：再受伤产生新令牌→即时放行）
  const first = splitWaitIds([
    { id: '344', orderId: '59752', endTime: 1794074009, type: ORDER_TYPE_HEAL, state: 0 },
  ]);
  const again = splitWaitIds([
    { id: '344', orderId: '59752', endTime: 1794074689, type: ORDER_TYPE_HEAL, state: 0 },
  ]);
  assert.deepEqual(first.commonKeys, ['344#59752#1794074009']);
  assert.deepEqual(again.commonKeys, ['344#59752#1794074689']);
  assert.notEqual(first.commonKeys[0], again.commonKeys[0]); // 再次受伤→新令牌→即时放行
  // 陈旧幻影（同 orderId 且 endTime 不变）→ 令牌相同→可被命中抑制（防 param error）
  const stale = splitWaitIds([
    { id: '344', orderId: '59752', endTime: 1794074009, type: ORDER_TYPE_HEAL, state: 0 },
  ]);
  assert.equal(stale.commonKeys[0], first.commonKeys[0]);
});

// ─────────────────── isParamErrorRet / isHealBatchCmd（治疗批量 param error 隔离触发的纯判据）───────────────────
test('isParamErrorRet：拒绝原因含 common_159995 → true（无论落在 reason 还是 data）；其他错误码/空 → false', () => {
  assert.equal(isParamErrorRet({ reason: 'common_159995' }), true);
  assert.equal(isParamErrorRet({ data: 'common_159995' }), true);
  assert.equal(isParamErrorRet({ reason: 'item_124017' }), false); // 其他业务拒绝
  assert.equal(isParamErrorRet({ reason: 'common_1599950' }), true); // 子串命中（保守）
  assert.equal(isParamErrorRet(null), false);
  assert.equal(isParamErrorRet({}), false);
});

test('isHealBatchCmd：220/1427 为原子批量治疗（需隔离）；其余写命令不是', () => {
  assert.equal(isHealBatchCmd(CMD_ARMY_HEAL_LIST), true);
  assert.equal(isHealBatchCmd(CMD_ARMY_CROSS_HEAL), true);
  assert.equal(isHealBatchCmd(CMD_ITEM_USE), false);
  assert.equal(isHealBatchCmd(CMD_ORDER_QUEUE_ING_DONE), false);
});

test('LOCAL_SYNC_KINDS：仅本地 220/151 流回灌 UpdateOrderQueues（除幻影）；本地道具 815 应答不含队列不在表内；跨服流也不在', () => {
  // 本地流：治疗 220 / 钻石全量加速 151
  assert.equal(LOCAL_SYNC_KINDS['heal-local'], true);
  assert.equal(LOCAL_SYNC_KINDS['heal-local-thor'], true);
  assert.equal(LOCAL_SYNC_KINDS['heal-local-resource'], true);
  assert.equal(LOCAL_SYNC_KINDS['speed-gold-local'], true);
  // 本地道具 815（speed-item-local）应答仅 {itemId,amount}、不含队列，无东西可回灌——幻影靠下拍 push 10120 确认读
  assert.equal(LOCAL_SYNC_KINDS['speed-item-local'], undefined);
  // 跨服流：战场队列由 1426/push 权威刷新，绝不回灌本地 OrderQueues
  assert.equal(LOCAL_SYNC_KINDS['heal-cross'], undefined);
  assert.equal(LOCAL_SYNC_KINDS['speed-gold-cross'], undefined);
  assert.equal(LOCAL_SYNC_KINDS['speed-item-cross'], undefined);
});

test('FP_FAMILY：三场景 × 治疗/加速 全族登记（治疗族 lw/cw/aw，加速族 lr/cr/ar）', () => {
  assert.equal(FP_FAMILY['heal-local'], 'lw');
  assert.equal(FP_FAMILY['heal-local-thor'], 'lw');
  assert.equal(FP_FAMILY['heal-local-resource'], 'lw');
  assert.equal(FP_FAMILY['heal-cross'], 'cw');
  assert.equal(FP_FAMILY['heal-ava'], 'aw');
  assert.equal(FP_FAMILY['speed-gold-local'], 'lr');
  assert.equal(FP_FAMILY['speed-item-local'], 'lr');
  assert.equal(FP_FAMILY['speed-gold-cross'], 'cr');
  assert.equal(FP_FAMILY['speed-item-cross'], 'cr');
  assert.equal(FP_FAMILY['speed-gold-ava'], 'ar');
  assert.equal(FP_FAMILY['speed-item-ava'], 'ar');
});

test('markPending 恒在途（无 TTL）+ prunePendingByExit 仅按本族活跃集遗忘、他族不误删', () => {
  const fp = 'heal-local';
  markPending(fp, ['900#A#111', '901#B#222']);
  // 登记即恒在途（无任何到期时刻）
  assert.equal(isPending(fp + '|900#A#111'), true);
  assert.equal(isPending(fp + '|901#B#222'), true);
  // 加速族令牌（lr）独立登记
  markPending('speed-gold-local', ['950']);
  assert.equal(isPending('speed-gold-local|950'), true);
  // 确认清除治疗族 lw：state0 活跃集只剩 900 → 901 退出 state0 即遗忘；900 保留抑制（绝不第二枪）
  prunePendingByExit('lw', new Set(['900#A#111']));
  assert.equal(isPending(fp + '|900#A#111'), true);
  assert.equal(isPending(fp + '|901#B#222'), false);
  // 加速族 lr 不受治疗族 prune 影响（他族不误删）
  assert.equal(isPending('speed-gold-local|950'), true);
  // 再对 lr 以空活跃集 prune（加速确认集=state1）→ 950 退出 state1 → 遗忘
  prunePendingByExit('lr', new Set());
  assert.equal(isPending('speed-gold-local|950'), false);
});

test('活跃令牌集纯函数：localWaitTokenSet/localRepairingIdSet 同 splitWaitIds 形；cross/ava 各 state0/state1 集', () => {
  const queues = [
    { id: '1', orderId: '59752', endTime: 1000, type: ORDER_TYPE_HEAL, state: 0 },
    { id: '2', orderId: '59753', endTime: 2000, type: ORDER_TYPE_HEAL, state: 1 },
    { id: '3', orderId: '0', endTime: 3000, type: ORDER_TYPE_HEAL, state: 0 },
    { id: '4', orderId: '9', endTime: 4000, type: 2, state: 0 },
  ];
  assert.deepEqual([...localWaitTokenSet(queues)], ['1#59752#1000']);
  assert.deepEqual([...localRepairingIdSet(queues)], ['2']);
  // 与 splitWaitIds 去重令牌逐字同形（治疗族 lw 确认集口径一致）
  assert.deepEqual(splitWaitIds(queues).commonKeys, ['1#59752#1000']);
  const crossData = {
    queues: [
      { id: '10', army: 'a', st: 0, et: 5 },
      { id: '20', army: 'b', st: 100, et: 200 },
    ],
  };
  assert.deepEqual([...crossWaitKeySet(crossData)], ['10#a#5']);
  assert.deepEqual(crossRepairingIds(crossData), ['20']);
  assert.deepEqual([...crossRepairingIdSet(crossData)], ['20']);
  const list = [
    { id: 'a1', orderId: '100', state: 0 },
    { id: 'b1', orderId: '200', state: 1 },
    { id: 'c1', orderId: '0', state: 0 },
  ];
  assert.deepEqual([...avaWaitIdSet(list)], ['a1']);
  assert.deepEqual([...avaRepairingIdSet(list)], ['b1']);
  // null 容错
  assert.equal(localWaitTokenSet(null).size, 0);
  assert.equal(crossWaitKeySet(null).size, 0);
  assert.equal(avaWaitIdSet(null).size, 0);
});

// ─────────────────── parseRepairCost / filterAffordable（用资源续修预算）───────────────────
test('parseRepairCost："resId|amt,resId|amt" → [{resId,amount}]；非法/非正片段忽略，非串→[]', () => {
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

test('filterAffordable：累计不超持有则纳入；超了跳过且不累加；null 成本（不可判定）跳过；[]=零成本纳入', () => {
  const hold = { 1: 100, 2: 60 };
  const holdingOf = (r) => hold[r] || 0;
  const costs = [
    [{ resId: 1, amount: 60 }], // 60<=100 → ok
    [{ resId: 1, amount: 60 }], // 累计120>100 → 跳过（不累加）
    [{ resId: 2, amount: 60 }], // 60<=60 → ok
    null, // 不可判定 → 跳过
    [], // 零成本 → ok
    [{ resId: 2, amount: 5 }], // 前一 ok 已用满 2=60；本项 65>60 → 跳过
  ];
  assert.deepEqual(filterAffordable(costs, holdingOf), [true, false, true, false, true, false]);
  assert.deepEqual(filterAffordable([], holdingOf), []);
});

// ─────────────────────────── crossWaitIds ───────────────────────────
test('crossWaitIds：1426 queues[] 里 st===0 且 id 非空即跨服待修', () => {
  const data = {
    queues: [
      { id: '100', st: 0 },
      { id: '200', st: 1 },
      { id: '', st: 0 },
      { id: '300', st: 0 },
    ],
  };
  assert.deepEqual(crossWaitIds(data), ['100', '300']);
  assert.deepEqual(crossWaitIds(null), []);
  assert.deepEqual(crossWaitIds({ queues: [] }), []);
});

// ─────────────────────────── repairingLeftSec / crossRepairingLeftSec ───────────────────────────
test('repairingLeftSec：state===1 且 orderId!=="0" 累加 endTime-serverTime（不为负）', () => {
  const queues = [
    { orderId: 'a', state: 1, endTime: 1000 },
    { orderId: 'b', state: 1, endTime: 800 },
    { orderId: 'c', state: 1, endTime: 100 }, // 已过期，负值不计
    { orderId: '0', state: 1, endTime: 9999 }, // orderId=0 跳过
    { orderId: 'd', state: 0, endTime: 5000 }, // 非在修
  ];
  assert.equal(repairingLeftSec(queues, 500), 1000 - 500 + (800 - 500));
  assert.equal(repairingLeftSec(null, 500), 0);
});

test('crossRepairingLeftSec：跨服 st 为开修时间戳（非枚举 1），st>0 且 et>serverTime 累加', () => {
  // 实测录制形态：待修 st=0/et=0；在修 st=开修 epoch、et=结束 epoch
  const serverTime = 1794112470;
  const data = {
    queues: [
      { army: 'a', id: '1', st: 0, et: 0 }, // 待修，不计
      { army: 'b', id: '2', st: 1794112460, et: 1794125551 }, // 在修，计 et-serverTime
      { army: 'c', id: '3', st: 1794112460, et: 1794112400 }, // 在修但已过期（负）不计
    ],
  };
  assert.equal(crossRepairingLeftSec(data, serverTime), 1794125551 - serverTime);
  // 旧假设 st===1 仍能兼容（st=1>0）；仅 st=0 归为待修
  assert.equal(
    crossRepairingLeftSec(
      {
        queues: [
          { st: 1, et: 1000 },
          { st: 0, et: 9999 },
        ],
      },
      500,
    ),
    500,
  );
  assert.equal(crossRepairingLeftSec(null, 500), 0);
});

test('serverTime 不可判定（0/undefined/NaN）⇒ 在修秒和恒归零（评审 M1：防 endTime-0 退化成 epoch 秒灌进枚数折算、一笔烧光背包道具）', () => {
  // 真机形态：endTime 是绝对 epoch 秒，减 0 后单条就 ≈1.79e9
  const queues = [{ orderId: 'a', state: 1, endTime: 1794125551 }];
  assert.equal(repairingLeftSec(queues, 0), 0);
  assert.equal(repairingLeftSec(queues, undefined), 0);
  assert.equal(repairingLeftSec(queues, NaN), 0);
  // 时刻可得时仍按旧口径累加（不能把正常路径一起抹掉）
  assert.equal(repairingLeftSec(queues, 1794125551 - 60), 60);

  const cross = { queues: [{ army: 'b', id: '2', st: 1794112460, et: 1794125551 }] };
  assert.equal(crossRepairingLeftSec(cross, 0), 0);
  assert.equal(crossRepairingLeftSec(cross, 1794125551 - 60), 60);
});

// ─────────────────────────── estimateGold（源码 getProfessionCDGold 公式）───────────────────────────
test('estimateGold：ceil(秒/60×rate) 至少 1；rate<=0 或 leftSec<=0 返回 0（无从判定）', () => {
  assert.equal(estimateGold(120, 2), 4);
  assert.equal(estimateGold(30, 2), 1); // ceil(1)=1，且不足也至少 1
  assert.equal(estimateGold(61, 1), 2); // ceil(1.016)=2
  assert.equal(estimateGold(0, 5), 0);
  assert.equal(estimateGold(100, 0), 0);
  assert.equal(estimateGold(100, -3), 0);
});

// ─────────────────────────── pickSpeedItem ───────────────────────────
test('pickSpeedItem：仅在 amount>keep 候选间取持有最多者，并列取 id 小；无候选返回 null', () => {
  const held = [
    { id: 920002, amount: 10 },
    { id: 920001, amount: 10 },
    { id: 920003, amount: 3 },
  ];
  const r = pickSpeedItem(held, 1);
  assert.equal(r.itemId, 920001); // 并列 10，取 id 小
  assert.equal(r.amount, 10);
  assert.equal(r.usable, 9);
  // keep 抬高到全部不超过 → 无候选
  assert.equal(pickSpeedItem(held, 10), null);
  assert.equal(pickSpeedItem([], 0), null);
  assert.equal(pickSpeedItem(null, 0), null);
});

// ─────────────────────────── itemSpeedParam（源码 hospitalUseItemSpeed + 真人成功样本）───────────────────
test('itemSpeedParam：本地全量=null（"0|0" 被服务器拒）、本地单条=id、跨服全量="1|0"/"1,type"、跨服单条="1|"+id', () => {
  assert.equal(itemSpeedParam(false, '555'), '555');
  assert.equal(itemSpeedParam(true, '555'), '1|555');
  assert.equal(itemSpeedParam(false, null, -1), null); // 本地全量：实证 param=null
  assert.equal(itemSpeedParam(false, null, 101), null); // 本地不按兵种细分，恒 null
  assert.equal(itemSpeedParam(true, null, -1), '1|0');
  assert.equal(itemSpeedParam(true, null, 201), '1,201');
});

// ─────────────────────────── planActions（分层决策）───────────────────────────
function baseSnap(over) {
  return Object.assign(
    {
      quotas: quickFields({ common_max: 77, common_use: 0 }),
      commonIds: [],
      thorIds: [],
      crossIds: [],
      localRepairing: 0,
      crossRepairing: 0,
      repairing: 0,
      gold: 0,
      ratePerMin: 2,
      speedItem: null,
      goldSpentToday: 0,
      mcfg: normalize({}),
    },
    over,
  );
}

test('planActions：freeRepair 开且额度充足 → 发 220 全量 ids；额度不足截断到 commonFreeLeft', () => {
  const snap = baseSnap({
    quotas: quickFields({ common_max: 77, common_use: 70 }), // 剩 7
    commonIds: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  });
  const { actions } = planActions(snap);
  const heal = actions.find((a) => a.cmd === CMD_ARMY_HEAL_LIST);
  assert.ok(heal);
  assert.deepEqual(heal.body.ids, ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(heal.body.ids.length, 7);
});

test('planActions：freeRepair 关 → reason 记录、无 220；额度耗尽 → reason 不误发', () => {
  const off = planActions(baseSnap({ commonIds: ['1'], mcfg: normalize({ freeRepair: false }) }));
  assert.equal(
    off.actions.find((a) => a.cmd === CMD_ARMY_HEAL_LIST),
    undefined,
  );
  assert.ok(off.reasons.some((r) => /freeRepair off/.test(r)));

  const exhausted = planActions(
    baseSnap({
      quotas: quickFields({ common_max: 77, common_use: 77 }),
      commonIds: ['1'],
      mcfg: normalize({ resourceRepair: false }),
    }),
  );
  assert.equal(
    exhausted.actions.find((a) => a.cmd === CMD_ARMY_HEAL_LIST),
    undefined,
  );
  assert.ok(exhausted.reasons.some((r) => /exhausted/.test(r)));
});

test('planActions：额度耗尽且 resourceRepair 开 → 发可负担集 220；无买得起者 → reason 不误发', () => {
  const m = normalize({ resourceRepair: true });
  const pay = baseSnap({
    quotas: quickFields({ common_max: 77, common_use: 77 }),
    commonIds: ['1', '2', '3'],
    payIds: ['1', '3'],
    payKeys: ['1#a#100', '3#c#300'],
    mcfg: m,
  });
  const got = planActions(pay);
  const act = got.actions.find((a) => a.kind === 'heal-local-resource');
  assert.ok(act);
  assert.equal(act.cmd, CMD_ARMY_HEAL_LIST);
  assert.deepEqual(act.ids, ['1', '3']);
  assert.deepEqual(act.dedup, ['1#a#100', '3#c#300']);

  // 无买得起（payIds 为空数组）→ 不发、记 no affordable
  const broke = planActions(
    baseSnap({
      quotas: quickFields({ common_max: 77, common_use: 77 }),
      commonIds: ['1'],
      payIds: [],
      payKeys: [],
      mcfg: m,
    }),
  );
  assert.equal(
    broke.actions.find((a) => a.cmd === CMD_ARMY_HEAL_LIST),
    undefined,
  );
  assert.ok(broke.reasons.some((r) => /no affordable/.test(r)));

  // 额度仍有余 → 走免费路径（不受 resourceRepair 影响）
  const freeFirst = planActions(
    baseSnap({
      quotas: quickFields({ common_max: 77, common_use: 70 }),
      commonIds: ['1', '2'],
      payIds: ['1', '2'],
      mcfg: m,
    }),
  );
  const fa = freeFirst.actions.find((a) => a.cmd === CMD_ARMY_HEAL_LIST);
  assert.equal(fa.kind, 'heal-local');
});

test('planActions：thorRepair 开 → 本地雷神走 220、跨服走 1427（不混批）', () => {
  const snap = baseSnap({
    thorIds: ['t1'],
    crossIds: ['c1', 'c2'],
    mcfg: normalize({ thorRepair: true }),
  });
  const { actions } = planActions(snap);
  const localThor = actions.find((a) => a.kind === 'heal-local-thor');
  assert.ok(localThor);
  assert.equal(localThor.cmd, CMD_ARMY_HEAL_LIST);
  assert.deepEqual(localThor.body.ids, ['t1']);
  const cross = actions.find((a) => a.cmd === CMD_ARMY_CROSS_HEAL);
  assert.ok(cross);
  assert.deepEqual(cross.body.ids, ['c1', 'c2']);
});

test('planActions：speedGold 开且余额足够 → 本地 151 + 跨服 1428（各自估价）；余额不足 → 静默（日预算闸门已废弃）', () => {
  const okSnap = baseSnap({
    repairing: 120,
    localRepairing: 60,
    crossRepairing: 60,
    gold: 9999,
    ratePerMin: 2,
    mcfg: normalize({ speedGold: true }),
  });
  const ok = planActions(okSnap);
  const gl = ok.actions.find((a) => a.cmd === CMD_ORDER_QUEUE_ING_DONE);
  const gc = ok.actions.find((a) => a.cmd === CMD_SPEEDUP_CROSS_GOLD);
  assert.ok(gl);
  assert.ok(gc);
  // 分域估价：本地 ceil(60/60*2)=2、跨服=2（不再双计全量 4）
  assert.equal(gl.goldCost, 2);
  assert.equal(gc.goldCost, 2);

  const poor = planActions(
    baseSnap({
      repairing: 120,
      localRepairing: 120,
      gold: 1,
      mcfg: normalize({ speedGold: true }),
    }),
  );
  assert.equal(
    poor.actions.find((a) => a.cmd === CMD_ORDER_QUEUE_ING_DONE),
    undefined,
  );
  assert.ok(poor.reasons.some((r) => /gold .* < estimate/.test(r)));

  // 日预算已废弃：即使余额足够也不再因「超预算」静默（旧 cap 传入也不再拦截）
  const nocap = planActions(
    baseSnap({
      repairing: 120,
      localRepairing: 120,
      gold: 9999,
      ratePerMin: 2,
      mcfg: normalize({ speedGold: true }),
    }),
  );
  assert.ok(nocap.actions.find((a) => a.cmd === CMD_ORDER_QUEUE_ING_DONE));
  assert.equal(
    nocap.reasons.find((r) => /daily gold cap/.test(r)),
    undefined,
  );
});

test('planActions：speedItem 开且有可动用道具 → 本地优先发 815 ITEM_USE（param 本地全量 null）', () => {
  const snap = baseSnap({
    repairing: 100,
    localRepairing: 100,
    speedItem: { itemId: 510002, amount: 5, usable: 4 },
    mcfg: normalize({ speedItem: true }),
  });
  const { actions } = planActions(snap);
  const use = actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.ok(use);
  assert.equal(use.body.itemid, 510002);
  assert.equal(use.body.param, null); // 本地全量：实证 null（"0|0" 被服务器拒）
  assert.equal(use.body.amount, 1); // secPerUse 不可解（表列漂移）→ 回退单枚旧口径
  // param 键恒在（评审 m2）：录制里无 param 的 {amount,itemid} 与非医院道具不可区分，对拍不能兜这类回归
  assert.deepEqual(Object.keys(use.body).sort(), ['amount', 'itemid', 'param']);
});

test('planActions：speedItem 仅跨服在修 → param "1|0"（本地不在修则走跨服）', () => {
  const snap = baseSnap({
    repairing: 100,
    localRepairing: 0,
    crossRepairing: 100,
    speedItem: { itemId: 510002, amount: 5, usable: 4 },
    mcfg: normalize({ speedItem: true }),
  });
  const use = planActions(snap).actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.equal(use.body.param, '1|0');
  assert.deepEqual(Object.keys(use.body).sort(), ['amount', 'itemid', 'param']);
});

test('planActions：全量钻石加速动作带 all:true + pendingTokens=该域 state1 活跃 id 集（供逐项确认清除）', () => {
  const snap = baseSnap({
    repairing: 180,
    localRepairing: 120,
    crossRepairing: 60,
    localRepairingIds: ['11', '12'],
    crossRepairingIds: ['21'],
    gold: 9999,
    ratePerMin: 2,
    mcfg: normalize({ speedGold: true }),
  });
  const { actions } = planActions(snap);
  const gl = actions.find((a) => a.cmd === CMD_ORDER_QUEUE_ING_DONE);
  assert.equal(gl.all, true);
  assert.deepEqual(gl.pendingTokens, ['11', '12']);
  const gc = actions.find((a) => a.cmd === CMD_SPEEDUP_CROSS_GOLD);
  assert.equal(gc.all, true);
  assert.deepEqual(gc.pendingTokens, ['21']);
});

test('planActions：全量道具加速（钻石关）pendingTokens 取同域 state1 活跃集', () => {
  const snap = baseSnap({
    repairing: 120,
    localRepairing: 120,
    localRepairingIds: ['11', '12'],
    speedItem: { itemId: 510002, amount: 5, usable: 4, secPerUse: 600 },
    mcfg: normalize({ speedItem: true }),
  });
  const use = planActions(snap).actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.equal(use.all, true);
  assert.deepEqual(use.pendingTokens, ['11', '12']);
});

test('planActions：speedItem 开但背包无医院加速道具 → reason 记录、无 815', () => {
  const snap = baseSnap({
    repairing: 100,
    speedItem: null,
    mcfg: normalize({ speedItem: true }),
  });
  const { actions, reasons } = planActions(snap);
  assert.equal(
    actions.find((a) => a.cmd === CMD_ITEM_USE),
    undefined,
  );
  assert.ok(reasons.some((r) => /no hospital speed item in bag/.test(r)));
});

test('planActions：para1 不可解（secPerUse 0）且持有 0 → 不发必拒的空包，num=0 记 reason（评审 m1）', () => {
  const snap = baseSnap({
    repairing: 100,
    localRepairing: 100,
    speedItem: { itemId: 510002, amount: 0, usable: 0, secPerUse: 0, useMax: 10000 },
    mcfg: normalize({ speedItem: true }),
  });
  const { actions, reasons } = planActions(snap);
  assert.equal(
    actions.find((a) => a.cmd === CMD_ITEM_USE),
    undefined,
  );
  assert.ok(reasons.some((r) => /item speed num=0/.test(r)));

  // 同一形态但确有持有：回退单枚旧口径（宁少花不空转），且仍受 param 编码约束
  const heldSnap = baseSnap({
    repairing: 100,
    localRepairing: 100,
    speedItem: { itemId: 510002, amount: 3, usable: 3, secPerUse: 0, useMax: 10000 },
    mcfg: normalize({ speedItem: true }),
  });
  const use = planActions(heldSnap).actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.equal(use.body.amount, 1);
});

// ─────────────────── 批量道具加速（修正十四①：服务器按「时间池」消耗 amount）───────────────────
// 单枚 510002 = ITEM 行 para1 = 28800s（实测：录制 20261108T173210 逐笔 1 枚的 endTime 差分、
// 20261107T203829 真人一笔 amount=9 清空 15 条在修）。
const SI8H = { itemId: 510002, amount: 100, usable: 100, secPerUse: 28800, useMax: 10000 };

test('planActions：道具加速一次发足——ceil(Σ在修剩余秒/para1) 枚（真人 9 枚样本同口径）', () => {
  const local = baseSnap({
    repairing: 255000,
    localRepairing: 255000,
    speedItem: SI8H,
    mcfg: normalize({ speedItem: true }),
  });
  const use = planActions(local).actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.equal(use.body.amount, 9); // ceil(255000/28800)=9
  assert.equal(use.body.param, null);
  assert.ok(/x9/.test(use.label));

  // 跨服域（本地不在修）同样折算，param="1|0"
  const cross = baseSnap({
    repairing: 51030,
    localRepairing: 0,
    crossRepairing: 51030,
    speedItem: SI8H,
    mcfg: normalize({ speedItem: true }),
  });
  const cu = planActions(cross).actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.equal(cu.kind, 'speed-item-cross');
  assert.equal(cu.body.amount, 2); // ceil(51030/28800)=2
  assert.equal(cu.body.param, '1|0');
});

test('planActions：枚数受持有量与单次上限夹取；持不足时按持有发、算出 0 则静默带 reason', () => {
  const few = planActions(
    baseSnap({
      repairing: 255000,
      localRepairing: 255000,
      speedItem: { itemId: 510002, amount: 3, usable: 3, secPerUse: 28800, useMax: 10000 },
      mcfg: normalize({ speedItem: true }),
    }),
  ).actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.equal(few.body.amount, 3); // 持有量封顶

  const capped = planActions(
    baseSnap({
      repairing: 28800 * 50,
      localRepairing: 28800 * 50,
      speedItem: { itemId: 510002, amount: 100, usable: 100, secPerUse: 28800, useMax: 20 },
      mcfg: normalize({ speedItem: true }),
    }),
  ).actions.find((a) => a.cmd === CMD_ITEM_USE);
  assert.equal(capped.body.amount, 20); // 单次上限封顶

  const empty = planActions(
    baseSnap({
      repairing: 100,
      localRepairing: 100,
      speedItem: { itemId: 510002, amount: 0, usable: 0, secPerUse: 28800, useMax: 10000 },
      mcfg: normalize({ speedItem: true }),
    }),
  );
  assert.equal(
    empty.actions.find((a) => a.cmd === CMD_ITEM_USE),
    undefined,
  );
  assert.ok(empty.reasons.some((r) => /item speed num=0/.test(r)));
});

test('planActions：同域钻石全量完成已排入 → 道具线让位（同拍双花防护）', () => {
  const { actions, reasons } = planActions(
    baseSnap({
      repairing: 51030,
      localRepairing: 51030,
      gold: 999999,
      ratePerMin: 2,
      speedItem: SI8H,
      mcfg: normalize({ speedGold: true, speedItem: true }),
    }),
  );
  assert.ok(actions.find((a) => a.kind === 'speed-gold-local'));
  assert.equal(
    actions.find((a) => a.kind === 'speed-item-local'),
    undefined,
  );
  assert.ok(reasons.some((r) => /item speed local skipped \(gold done this tick\)/.test(r)));

  // 跨服域钻石不影响本地道具线（分域判定：本地估价超余额 → 本地钻石不排，道具线照发）
  const split = planActions(
    baseSnap({
      repairing: 51130,
      localRepairing: 51030,
      crossRepairing: 100,
      gold: 100,
      ratePerMin: 2,
      speedItem: SI8H,
      mcfg: normalize({ speedGold: true, speedItem: true }),
    }),
  );
  assert.ok(split.actions.find((a) => a.kind === 'speed-gold-cross'));
  assert.equal(
    split.actions.find((a) => a.kind === 'speed-gold-local'),
    undefined,
  );
  assert.equal(split.actions.find((a) => a.kind === 'speed-item-local').body.amount, 2);
});

test('goldPlannedFor：按域判定钻石动作是否已排入', () => {
  const acts = [{ kind: 'speed-gold-local' }];
  assert.equal(goldPlannedFor(acts, false), true);
  assert.equal(goldPlannedFor(acts, true), false);
  assert.equal(goldPlannedFor([], false), false);
});

test('planHealActions/planSpeedActions：拆层不串货——治疗层只出 220/1427，加速层只出 151/1428/815', () => {
  const snap = baseSnap({
    quotas: quickFields({ common_max: 77, common_use: 0 }),
    commonIds: ['1', '2'],
    commonKeys: ['1#a', '2#b'],
    payIds: ['1', '2'],
    repairing: 255000,
    localRepairing: 255000,
    speedItem: SI8H,
    gold: 999999,
    mcfg: normalize({ speedItem: true }),
  });
  const heal = [];
  const healReasons = [];
  // 契约钉住：两层函数是「累加容器」语义、自无返回值（运行时崩溃回归：planOnce 曾误取返回值读 .actions）
  assert.equal(planHealActions(snap, normalize({ speedItem: true }), heal, healReasons), undefined);
  assert.ok(heal.length > 0);
  assert.ok(heal.every((a) => a.cmd === CMD_ARMY_HEAL_LIST || a.cmd === CMD_ARMY_CROSS_HEAL));

  // 治疗落地后的同拍二次决策：只跑加速层，不能再把同一批 ids 重修一遍
  const speed = [];
  const speedReasons = [];
  assert.equal(
    planSpeedActions(snap, normalize({ speedItem: true }), speed, speedReasons),
    undefined,
  );
  assert.equal(speed.length, 1);
  assert.equal(speed[0].kind, 'speed-item-local');
  assert.equal(speed[0].body.amount, 9);
});

test('HEAL_LANES：四类治疗动作触发同拍二次加速；加速类与无双 cure 不触发', () => {
  assert.equal(HEAL_LANES['heal-local'], true);
  assert.equal(HEAL_LANES['heal-local-resource'], true);
  assert.equal(HEAL_LANES['heal-local-thor'], true);
  assert.equal(HEAL_LANES['heal-cross'], true);
  assert.equal(HEAL_LANES['heal-ava'], undefined);
  assert.equal(HEAL_LANES['speed-item-local'], undefined);
  assert.equal(HEAL_LANES['speed-gold-local'], undefined);
});

// ─────────────────────────── nextDelayMs（下拍择时：去勤扫、恒慢心跳）───────────────────────────
test('nextDelayMs：去勤扫后无论忙闲一律慢心跳（>=IDLE）；被拒达阈退避×2；snap 不再参与判定', () => {
  const m = normalize({ pollIntervalSec: 60 });
  const idle = Math.max(60000, m.pollIntervalSec * 1000);
  const idleSnap = baseSnap({ commonIds: [], thorIds: [], crossIds: [], repairing: 0 });
  const busySnap = baseSnap({ commonIds: ['1'] });
  // 忙闲同档：不再出现旧的 5s 勤扫
  assert.equal(nextDelayMs(busySnap, m, 0), idle);
  assert.equal(nextDelayMs(idleSnap, m, 0), idle);
  // 被拒退避：达阈一律×2（忙/静默一致）
  assert.equal(nextDelayMs(busySnap, m, 3), idle * 2);
  assert.ok(nextDelayMs(idleSnap, m, 3) > nextDelayMs(idleSnap, m, 0));
  // 快照缺失（权威读失败）也走慢心跳
  assert.equal(nextDelayMs(null, m, 0), idle);
});

test('nextDelayMs：本地无活但无双忙碌（avaBusy>0）不再勤扫，同样走慢心跳', () => {
  const m = normalize({ pollIntervalSec: 60 });
  const idle = Math.max(60000, m.pollIntervalSec * 1000);
  const snap = baseSnap({ commonIds: [], thorIds: [], crossIds: [], repairing: 0, avaBusy: 3 });
  assert.equal(nextDelayMs(snap, m, 0), idle);
});

// ─────────────────────────── 无双（AVA 族）───────────────────────────
test('无双协议常量字面（RequestId 实证）：三件套与模式映射表/推攖/道具专行', () => {
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
test('avaWaitIds/avaRepairingIds：orderId!="0" 且 state 分集（源码 StartAllQueue/_realUseCure 逐字）', () => {
  assert.deepEqual(avaWaitIds(AVA_LIST_REC), ['4323070633691856392', '4330888570024771087']);
  assert.deepEqual(avaRepairingIds(AVA_LIST_REC), ['9000000000000000001']);
  assert.deepEqual(avaWaitIds(null), []);
  assert.deepEqual(avaRepairingIds([]), []);
});

test('avaRepairingLeftSec：state===1 累加 endTime-serverTime（不为负），待修/空槽不计', () => {
  assert.equal(avaRepairingLeftSec(AVA_LIST_REC, 1794160415 - 3600), 3600);
  assert.equal(avaRepairingLeftSec(AVA_LIST_REC, 1794160415), 0);
  assert.equal(avaRepairingLeftSec(AVA_LIST_REC, 1794160415 + 10), 0);
  assert.equal(avaRepairingLeftSec(null, 0), 0);
  // 评审 M1：时刻不可判定时不能把 endTime 当剩余秒（6312 枚数也吃这个值）
  assert.equal(avaRepairingLeftSec(AVA_LIST_REC, 0), 0);
});

test('estimateAvaGold：基价 ceil(秒/60×rate) × 倍率后 floor、至少 1；rate 不可用回 0；倍率非法按 1', () => {
  assert.equal(estimateAvaGold(3600, 2, 3), 360); // ceil(60×2)=120 → ×3
  assert.equal(estimateAvaGold(90, 2, 1.5), Math.max(1, Math.floor(Math.ceil(1.5 * 2) * 1.5))); // 3×1.5=4.5→4
  assert.equal(estimateAvaGold(3600, 0, 3), 0); // rate 取不到 → 无从判定
  assert.equal(estimateAvaGold(3600, 2, 0), 120); // 倍率≤0 按 1（源码 ||1）
  assert.equal(estimateAvaGold(0, 2, 3), 0); // 不在修 → 无从判定
});

test('speedItemNum：ceil(秒/para1) 受持有量与单次上限双封顶；非法要素回 0', () => {
  assert.equal(speedItemNum(3600, 600, 10, 0), 6); // 无上限时按折算
  assert.equal(speedItemNum(3600, 600, 4, 0), 4); // 持有量封顶
  assert.equal(speedItemNum(72000, 600, 100, 20), 20); // 单次上限封顶
  assert.equal(speedItemNum(3600, 0, 10, 5), 0); // para1 非法不发
  assert.equal(speedItemNum(0, 600, 10, 5), 0); // 不在修不发
  assert.equal(speedItemNum(3600, 600, 0, 5), 0); // 无持有不发
});

function avaSnap(over) {
  return baseSnap(
    Object.assign(
      {
        avaMode: 'ava',
        avaReadOk: true,
        avaWaitIds: ['a1', 'a2'],
        avaRepairingIds: ['b1'],
        avaRepairingLeftSec: 3600,
        avaBusy: 3,
        avaGoldMult: 1,
        avaSpeedItem: null,
      },
      over,
    ),
  );
}

test('planActions 无双：批量修走模式 cure 命令（6311 {ids}），与本地 220/跨服 1427 互不串道；钻石加速走 speed 命令 {ids,useGold:1}', () => {
  const m = normalize({ speedGold: true });
  const snap = avaSnap({ gold: 99999, ratePerMin: 2, mcfg: m });
  const { actions } = planActions(snap);
  const cure = actions.find((a) => a.kind === 'heal-ava');
  assert.ok(cure);
  assert.equal(cure.cmd, CMD_AVA_CURE);
  assert.deepEqual(cure.body, { ids: ['a1', 'a2'] });
  assert.deepEqual(cure.dedup, ['a1', 'a2']); // heal-ava 逐队列 id 令牌（新部队即时放行、同 id 在途不双花）
  const gold = actions.find((a) => a.kind === 'speed-gold-ava');
  assert.ok(gold);
  assert.equal(gold.cmd, CMD_AVA_SPEED);
  assert.deepEqual(gold.body, { ids: ['b1'], useGold: 1 });
  assert.deepEqual(gold.dedup, ['b1']); // speed-gold-ava 逐队列 id 令牌，不再走整批键
  assert.equal(gold.goldCost, estimateAvaGold(3600, 2, 1));
  // 本地/跨服链路未被无双快照误发（repairing=0）
  assert.equal(
    actions.find((a) => a.cmd === CMD_ORDER_QUEUE_ING_DONE),
    undefined,
  );
});

test('planActions 无双：道具加速走 speed 命令 {ids,itemId,num,useGold:0}；钻石余额不足/无持有都静默记 reason', () => {
  const m = normalize({ speedItem: true, speedGold: true });
  const itemSnap = avaSnap({
    gold: 0,
    ratePerMin: 2,
    avaGoldMult: 1,
    avaSpeedItem: { itemId: AVA_HOSPITAL_SPEED_ITEM, amount: 10, secPerUse: 600, useMax: 0 },
    mcfg: m,
  });
  const got = planActions(itemSnap);
  const use = got.actions.find((a) => a.kind === 'speed-item-ava');
  assert.ok(use);
  assert.equal(use.cmd, CMD_AVA_SPEED);
  assert.deepEqual(use.body, { ids: ['b1'], itemId: AVA_HOSPITAL_SPEED_ITEM, num: 6, useGold: 0 });
  assert.deepEqual(use.dedup, ['b1']); // speed-item-ava 并入逐令牌（ar 族）：令牌=state1 在修 id，在退出 state1 前恒 pending 防重烧
  assert.equal(use.atomic, true); // 道具 num 池级折算→atomic：任一在途即整域跳过，不可拆子集（防超烧）
  assert.ok(got.reasons.some((r) => /gold 0 < estimate/.test(r))); // 钻石余额不足 → 只拒 gold 线
  assert.equal(
    got.actions.find((a) => a.kind === 'speed-gold-ava'),
    undefined,
  );

  const nobag = planActions(avaSnap({ mcfg: m, avaSpeedItem: null }));
  assert.equal(
    nobag.actions.find((a) => a.kind === 'speed-item-ava'),
    undefined,
  );
  assert.ok(nobag.reasons.some((r) => /no ava hospital speed item|item speed skipped/.test(r)));
});

// ─────────────────────── 无双同拍双发互斥（review 修正一）───────────────────────
test('planActions 无双：钻石+道具同时可行动时只发钻石（同一 cmds.speed 目标同集，二选一钻石优先），道具记 skipped reason', () => {
  const m = normalize({ speedGold: true, speedItem: true });
  const snap = avaSnap({
    gold: 99999,
    ratePerMin: 2,
    avaGoldMult: 1,
    avaSpeedItem: { itemId: AVA_HOSPITAL_SPEED_ITEM, amount: 10, secPerUse: 600, useMax: 0 },
    mcfg: m,
  });
  const { actions, reasons } = planActions(snap);
  assert.ok(actions.find((a) => a.kind === 'speed-gold-ava'));
  assert.equal(
    actions.find((a) => a.kind === 'speed-item-ava'),
    undefined,
  );
  assert.ok(reasons.some((r) => /ava item speed skipped \(gold done this tick\)/.test(r)));
});

// ─────────────────────── 1426 门控归因（review 修正四）───────────────────────
test('planActions：crossSkipped=true → 记 reason「cross hospital gate closed」，与「读了但无待修」区分', () => {
  const { reasons } = planActions(baseSnap({ crossSkipped: true }));
  assert.ok(reasons.some((r) => /cross hospital gate closed \(1426 skipped\)/.test(r)));
  // 未跳过时不产生该 reason（旧快照无此键同样不触发）
  assert.equal(
    planActions(baseSnap()).reasons.find((r) => /gate closed/.test(r)),
    undefined,
  );
});

test('planActions 无双：resourceRepair 关→不修；无待修/无在修记 reason；读失败整层静默；不串入本地免费线', () => {
  const off = planActions(avaSnap({ mcfg: normalize({ resourceRepair: false }) }));
  assert.equal(
    off.actions.find((a) => a.kind === 'heal-ava'),
    undefined,
  );
  assert.ok(off.reasons.some((r) => /resourceRepair off \(ava cure\)/.test(r)));

  const idle = planActions(
    avaSnap({
      avaWaitIds: [],
      avaRepairingIds: [],
      avaRepairingLeftSec: 0,
      avaBusy: 0,
      mcfg: normalize({ speedGold: true, speedItem: true }),
    }),
  );
  assert.ok(idle.reasons.some((r) => /no ava wait/.test(r)));
  assert.ok(idle.reasons.some((r) => /no ava under repair/.test(r)));

  const badRead = planActions(avaSnap({ avaReadOk: false }));
  assert.equal(badRead.actions.filter((a) => /ava/.test(a.kind)).length, 0);
  assert.ok(badRead.reasons.some((r) => /ava hospital read failed/.test(r)));

  // TM 模式同一决策链切到 6357/6358（AVA_MODE_CMDS.tm）
  const tm = planActions(
    avaSnap({ avaMode: 'tm', mcfg: normalize({ speedGold: true }), gold: 99999 }),
  );
  assert.equal(tm.actions.find((a) => a.kind === 'heal-ava').cmd, CMD_TM_CURE);
  assert.equal(tm.actions.find((a) => a.kind === 'speed-gold-ava').cmd, AVA_MODE_CMDS.tm.speed);
});
