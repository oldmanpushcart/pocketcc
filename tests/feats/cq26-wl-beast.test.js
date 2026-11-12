// cq26-wl-beast（CQ26 冰原巨熊）纯函数单测：2111 分区快照过滤、当日闸门序、2125 troop 投影。
// 全部断言的是「打哪个分区、载荷长什么样」，不发包、不摸游戏符号——feat 模块 import 链会触到浏览器
// 全局，故先最小桩化 window/document/chrome，再动态 import 取导出纯函数（同 cq26-wl-chest 口径）。
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

// core 链里的 session/player/scene-watcher 等模块在 import 期就挂常驻 setInterval——只对测试
// harness 的定时器 unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/cq26/wl-beast.js');
const { candidateBeasts, pickBeasts, toTroop } = mod;
const { CMD_ATTACK, CMD_INFO, CMD_WORLD_INFO, POINT_TYPE_BEAST } = mod;

/** 服务器秒基准（录制内的真实时刻，判据全部显式传参，不靠墙钟） */
const NOW_SEC = 1794416158;
const NOW_MS = NOW_SEC * 1000;
/** 本活动分区统一到期时刻（实录 endTime） */
const DAY_END = 1794585600;

test('协议常量与实录对齐（2111 发现 / 2124 展示 / 2125 攻打 / 317 真值）', () => {
  assert.equal(CMD_WORLD_INFO, 2111);
  assert.equal(CMD_INFO, 2124);
  assert.equal(CMD_ATTACK, 2125);
  assert.equal(POINT_TYPE_BEAST, 317);
});

test('candidateBeasts：2111 wastelandList → 只留 BOSS_SKILL(1) 且 OPENING(4) 且未过期的分区', () => {
  // 行形态逐字照抄实录 dashcam-rec-20261112T003043-…-1794414643763.part.ndjson 的 2111 resp
  const rows = [
    { wastelandIndex: 16, status: 2, wastelandType: 3, wastelandCondition: 3, endTime: DAY_END },
    { wastelandIndex: 7, status: 4, wastelandType: 1, wastelandCondition: 1, endTime: DAY_END }, // ✓
    { wastelandIndex: 10, status: 4, wastelandType: 1, wastelandCondition: 2, endTime: DAY_END }, // ✓
    { wastelandIndex: 1, status: 6, wastelandType: 1, wastelandCondition: 0, endTime: 0 }, // 类型对但 CAN_REOPEN
    { wastelandIndex: 11, status: 4, wastelandType: 2, wastelandCondition: 2, endTime: DAY_END }, // ICE 非巨兽
    { wastelandIndex: 12, status: 4, wastelandType: 3, wastelandCondition: 2, endTime: DAY_END }, // GATHER 非巨兽
  ];
  const out = candidateBeasts(rows, NOW_SEC);
  assert.deepEqual(
    out.map((c) => c.idx),
    [7, 10],
  );
});

test('candidateBeasts：去重、endTime=0 不误杀、endTime≤now 过期剔除', () => {
  const rows = [
    { wastelandIndex: 7, status: 4, wastelandType: 1, endTime: DAY_END },
    { wastelandIndex: 7, status: 4, wastelandType: 1, endTime: DAY_END }, // 重复分区
    { wastelandIndex: 8, status: 4, wastelandType: 1, endTime: 0 }, // 无截止 → 交给 status 兜底，留
    { wastelandIndex: 9, status: 4, wastelandType: 1, endTime: NOW_SEC - 1 }, // 已过期 → 剔除
    { wastelandIndex: 0, status: 4, wastelandType: 1, endTime: DAY_END }, // 非法分区号 → 剔除
  ];
  assert.deepEqual(
    candidateBeasts(rows, NOW_SEC).map((c) => c.idx),
    [7, 8],
  );
  // nowSec<=0（无从判过期）时不因 endTime 剔除
  assert.deepEqual(
    candidateBeasts(
      [{ wastelandIndex: 9, status: 4, wastelandType: 1, endTime: NOW_SEC - 1 }],
      0,
    ).map((c) => c.idx),
    [9],
  );
});

test('pickBeasts：闸门序（当日已打→冷却→黑名单）、按 idx 升序、ready 只带 idx/endTime', () => {
  const cands = [
    { idx: 12, endTime: DAY_END },
    { idx: 7, endTime: DAY_END },
    { idx: 3, endTime: DAY_END }, // 当日已打
    { idx: 10, endTime: DAY_END }, // 冷却中
    { idx: 5, endTime: DAY_END }, // 连续被拒达上限
  ];
  const g = {
    now: NOW_MS,
    isDone: function (i) {
      return i === 3;
    },
    coolUntil: { 10: NOW_MS + 5000 },
    rejectCount: { 5: 3 },
    maxReject: 3,
  };
  const r = pickBeasts(cands, g);
  assert.deepEqual(r.ready, [
    { idx: 7, endTime: DAY_END },
    { idx: 12, endTime: DAY_END },
  ]);
  const reasons = {};
  for (const b of r.blocked) reasons[b.idx] = b.reason;
  assert.equal(reasons[3], 'done-today');
  assert.equal(reasons[10], 'cooling');
  assert.equal(reasons[5], 'blacklisted');
});

test('pickBeasts：闸门全放开 → 全分区升序 ready；无入参不炸', () => {
  assert.deepEqual(pickBeasts([], {}), { ready: [], blocked: [] });
  const r = pickBeasts([{ idx: 2 }, { idx: 1 }], { now: NOW_MS });
  assert.deepEqual(
    r.ready.map((c) => c.idx),
    [1, 2],
  );
});

test('连续被拒未到上限仍可进 ready（不误拉黑）', () => {
  const r = pickBeasts([{ idx: 7, endTime: DAY_END }], {
    now: NOW_MS,
    rejectCount: { 7: 2 },
    maxReject: 3,
  });
  assert.deepEqual(
    r.ready.map((c) => c.idx),
    [7],
  );
});

test('toTroop：build() 投影成实录 2125 的 troop 形态（heroList 对象化、行只三键、extraArmyPos pos=0）', () => {
  const troop = toTroop({
    heroList: [170, 174, 169],
    armyListNew: [
      { pos: 1, armyId: 901103, armyNum: 18, heroCap: 5, skinId: 9 }, // heroCap/skinId 不进 troop
      { pos: 11, armyId: 10101, armyNum: 17 },
    ],
    formationV2: 1001,
    extraArmy: { armyId: 10101, armyNum: 24 },
  });
  assert.deepEqual(Object.keys(troop), ['heroList', 'armyPosList', 'formationV2', 'extraArmyPos']);
  assert.deepEqual(troop.heroList, [{ heroId: 170 }, { heroId: 174 }, { heroId: 169 }]);
  assert.deepEqual(troop.armyPosList, [
    { pos: 1, armyId: 901103, armyNum: 18 },
    { pos: 11, armyId: 10101, armyNum: 17 },
  ]);
  assert.equal(troop.formationV2, 1001);
  assert.deepEqual(troop.extraArmyPos, { pos: 0, armyId: 10101, armyNum: 24 });
});

test('toTroop：无额外部队/无英雄 ⇒ 省略 extraArmyPos，heroList 出空数组', () => {
  const troop = toTroop({ armyListNew: [{ pos: 2, armyId: 504401, armyNum: 17 }], extraArmy: {} });
  assert.equal('extraArmyPos' in troop, false);
  assert.deepEqual(troop.heroList, []);
  assert.equal(troop.formationV2, 0);
});

test('toTroop 反喂实录样本：真人 2125 的 troop 与投影逐键等值', () => {
  // 实录 req（dashcam-rec-20261112T003043…part.ndjson，dir=req:sendPBV2）
  const recorded = {
    heroList: [{ heroId: 170 }, { heroId: 174 }, { heroId: 169 }],
    armyPosList: [
      { pos: 1, armyId: 901103, armyNum: 18 },
      { pos: 2, armyId: 504401, armyNum: 17 },
      { pos: 3, armyId: 901103, armyNum: 17 },
      { pos: 11, armyId: 10101, armyNum: 17 },
      { pos: 12, armyId: 10101, armyNum: 17 },
      { pos: 13, armyId: 10101, armyNum: 17 },
      { pos: 21, armyId: 10101, armyNum: 17 },
      { pos: 22, armyId: 10101, armyNum: 17 },
      { pos: 23, armyId: 10101, armyNum: 17 },
    ],
    formationV2: 1001,
    extraArmyPos: { pos: 0, armyId: 10101, armyNum: 24 },
  };
  const troop = toTroop({
    heroList: recorded.heroList.map((h) => h.heroId),
    armyListNew: recorded.armyPosList,
    formationV2: recorded.formationV2,
    extraArmy: { armyId: recorded.extraArmyPos.armyId, armyNum: recorded.extraArmyPos.armyNum },
  });
  assert.deepEqual(troop, recorded);
});
