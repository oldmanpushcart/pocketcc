// cq26-wl-mine（CQ26 荒芜冰原矿区）纯函数单测：三腿谓词闸序、选点排序、2201 棋盘桶化、
// 901 地块归一与分区精扫（含去重/黑名单/惰性扫描纪律）、被动嗅探增量、安全期召回时刻、315 行军认领、
// 分矿种最低量门槛（items.js：清单语义 / 门槛计划 / v1+v2→v3 迁移）。
// 全部不摸游戏符号（除 `march.State` 常量），也不发真包：网络一律走桩 net。
// feat 模块 import 链会触到浏览器全局，故先最小桩化 window/document/chrome，再动态 import（同 cq26-wl-chest 口径）。
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

// core 链里的常驻模块在 import 期就挂 setInterval——只对测试 harness 的定时器 unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const legs = await import('../../extension/src/feats/cq26/wl-mine/legs.js');
const survey = await import('../../extension/src/feats/cq26/wl-mine/survey.js');
const marchLoop = await import('../../extension/src/feats/cq26/wl-mine/march-loop.js');
const { march } = await import('../../extension/src/core/march.js');
const C = await import('../../extension/src/feats/cq26/wl-mine/constants.js');
const items = await import('../../extension/src/feats/cq26/wl-mine/items.js');

/** 基准时刻：服务器秒 / 本地毫秒（以真实墙钟为基准，memo TTL 用的是 Date.now()，两者必须同轴） */
const NOW_MS = Date.now();
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** 老家服号与本人 UID（逐形状照实录：uid 是字符串，服号是小整数） */
const ORIGIN_SID = 4178;
const ME = '11981629951662';

/** 成熟秒与安全期（conf 52000367 实测 7200；单点名额 conf 52000364 实测 3） */
const MATURE_SEC = 7200;
const QUOTA_MAX = 3;

/**
 * 造一个 901 归一点（survey.js `ingestResourcePoints` 的产出形状，字段口径见 ACL §4.4）。
 * @param {object} [o] 覆盖项
 * @returns {object}
 */
function point(o) {
  return Object.assign(
    {
      x: 682,
      y: 384,
      k: 14011512,
      itemId: C.ITEM_THOR_MINE,
      ownerId: '',
      initSid: ORIGIN_SID,
      specIndex: 9,
      gst: NOW_SEC - MATURE_SEC - 100,
      gNum: 500,
      oNum: 120,
      gatherSpeed: 240,
      stealUidList: [],
      protectUidList: [],
    },
    o || {},
  );
}

/** 盗采腿 ctx（外服点） */
const FOREIGN = 9999;

/**
 * 造一条 901 `pointList` 报文行（池化形态：316 点 + `m` 块 extData，Int64 字段裸数字）。
 * @param {number} x
 * @param {number} y
 * @param {object} [m] `m` 块覆盖项
 * @returns {object}
 */
function tileRow(x, y, m) {
  return {
    v: 37,
    x: x,
    y: y,
    k: 14011512,
    pointType: C.POINT_TYPE_RESOURCE,
    m: Object.assign(
      {
        itemId: C.ITEM_THOR_MINE,
        ownerId: '',
        initSid: ORIGIN_SID,
        specIndex: 9,
        gatherStartTime: NOW_SEC - MATURE_SEC - 100,
        gNum: 500,
        oNum: 120,
        stealUidList: [],
        protectUidList: [],
      },
      m || {},
    ),
  };
}

/**
 * 造一条 901 `marchList` / 10007 报文条目（`march.decode` 的入参形态）。
 * @param {object} [o] 覆盖项
 * @returns {object}
 */
function marchRaw(o) {
  return Object.assign(
    {
      marchId: '1234567890123456789',
      marchType: C.MARCH_TYPE_GATHER,
      marchState: 2,
      target: { tx: 682, ty: 384, itemId: C.ITEM_THOR_MINE, targetType: C.POINT_TYPE_RESOURCE },
      marchArrive: NOW_SEC + 600,
      uid: ME,
      begin: { bx: 700, by: 400 },
    },
    o || {},
  );
}

// ── legs.js：采集腿 ───────────────────────────────────────────────────
test('canGather: 本服无主点放行，缺 originSid / 有主 / 外服 / 矿种 / 无 specIndex 逐闸挡下', () => {
  const ctx = { originSid: ORIGIN_SID, whitelist: [C.ITEM_THOR_MINE, C.ITEM_MINE] };
  assert.equal(legs.canGather(point(), ctx).ok, true);
  // fail-closed：originSid 不可得（null）不得退化成「和 0 比较」
  assert.equal(legs.canGather(point(), { ...ctx, originSid: null }).why, 'no-origin-sid');
  assert.equal(legs.canGather(point({ ownerId: ME }), ctx).why, 'occupied');
  assert.equal(legs.canGather(point({ ownerId: '0' }), ctx).ok, true, "'0' 与缺失同为无主");
  assert.equal(legs.canGather(point({ initSid: FOREIGN }), ctx).why, 'not-own-server');
  assert.equal(legs.canGather(point({ specIndex: null }), ctx).why, 'no-spec-index');
  assert.equal(legs.canGather(point({ itemId: 4600 }), ctx).why, 'item-filtered');
  // 速率不参与判据（11-12 废弃 gatherMinSpeed 门槛）：低速 / 速率不可得都照常放行
  assert.equal(legs.canGather(point({ gatherSpeed: 10 }), ctx).ok, true);
  assert.equal(legs.canGather(point({ gatherSpeed: null }), ctx).ok, true);
  // 白名单空数组 = 不限矿种（面板全不勾的语义）
  assert.equal(legs.canGather(point({ itemId: 4600 }), { ...ctx, whitelist: [] }).ok, true);
});

// ── legs.js：盗采腿 ───────────────────────────────────────────────────
test('canSteal: 外服已过安全期且有存量放行；成熟判定 gst+7200 与 gNum>0 双闸（跨服 gStart 可陈旧）', () => {
  const ctx = {
    me: ME,
    originSid: ORIGIN_SID,
    nowSec: NOW_SEC,
    matureSec: MATURE_SEC,
    quotaMax: QUOTA_MAX,
    whitelist: [C.ITEM_THOR_MINE],
    mins: {},
  };
  const foreign = { initSid: FOREIGN };
  assert.equal(legs.canSteal(point(foreign), ctx).ok, true);
  assert.equal(legs.canSteal(point(), ctx).why, 'not-foreign', '本服点不是盗采目标');
  assert.equal(
    legs.canSteal(point({ ...foreign, gst: NOW_SEC - 10 }), ctx).why,
    'immature',
    '安全期内不可盗',
  );
  assert.equal(legs.canSteal(point({ ...foreign, gNum: 0 }), ctx).why, 'nothing-to-take');
  assert.equal(
    legs.canSteal(point({ ...foreign, gNum: null }), ctx).why,
    'nothing-to-take',
    '这帧没回 gNum 也不当有存量',
  );
  assert.equal(legs.canSteal(point({ ...foreign, stealUidList: [ME] }), ctx).why, 'already-stolen');
  assert.equal(
    legs.canSteal(point({ ...foreign, stealUidList: ['a', 'b'], protectUidList: ['c'] }), ctx).why,
    'point-quota-full',
    'steal+protect 合并算名额',
  );
  assert.equal(legs.canSteal(point(foreign), { ...ctx, matureSec: null }).why, 'no-mature-conf');
  assert.equal(legs.canSteal(point(foreign), { ...ctx, quotaMax: null }).why, 'point-quota-full');
  assert.equal(legs.canSteal(point({ ...foreign, oNum: null }), ctx).why, 'no-onum');
  assert.equal(
    legs.canSteal(point({ ...foreign, oNum: 5 }), { ...ctx, mins: { [C.ITEM_THOR_MINE]: 10 } }).why,
    'onum-below-min',
  );
  // 分矿种门槛（用户口径实例：雷神矿脉 1400、矿山 78）：各矿种只跟自己的门槛比，达标即放行
  const perType = {
    ...ctx,
    whitelist: [C.ITEM_THOR_MINE, C.ITEM_MINE],
    mins: { [C.ITEM_THOR_MINE]: 1400, [C.ITEM_MINE]: 78 },
  };
  const mine = { ...foreign, itemId: C.ITEM_MINE };
  assert.equal(
    legs.canSteal(point({ ...foreign, oNum: 1500 }), perType).ok,
    true,
    '雷神 1500 ≥ 1400',
  );
  assert.equal(
    legs.canSteal(point({ ...foreign, oNum: 1000 }), perType).why,
    'onum-below-min',
    '雷神 1000 < 1400 挡下（矿山门槛不适用它）',
  );
  assert.equal(legs.canSteal(point({ ...mine, oNum: 100 }), perType).ok, true, '矿山 100 ≥ 78');
  assert.equal(
    legs.canSteal(point({ ...mine, oNum: 50 }), perType).why,
    'onum-below-min',
    '矿山 50 < 78 挡下',
  );
});

// ── legs.js：协助腿 ───────────────────────────────────────────────────
test('canHelp: 本服他人正采放行；自己的点/未协过/名额；未开采（gst=0）按源码放行', () => {
  const ctx = {
    me: ME,
    originSid: ORIGIN_SID,
    nowSec: NOW_SEC,
    matureSec: MATURE_SEC,
    quotaMax: QUOTA_MAX,
    whitelist: [C.ITEM_THOR_MINE],
    mins: {},
  };
  const other = { ownerId: '11999999999999' };
  assert.equal(legs.canHelp(point(other), ctx).ok, true);
  assert.equal(legs.canHelp(point(), ctx).why, 'no-other-owner', '空点不是协助目标');
  assert.equal(legs.canHelp(point({ ownerId: ME }), ctx).why, 'no-other-owner');
  assert.equal(legs.canHelp(point({ ownerId: '0' }), ctx).why, 'no-other-owner');
  assert.equal(legs.canHelp(point({ ...other, initSid: FOREIGN }), ctx).why, 'not-own-server');
  assert.equal(legs.canHelp(point({ ...other, protectUidList: [ME] }), ctx).why, 'already-helped');
  // 源码原文：gatherStartTime 未起也放行（与盗采腿刻意不对称，不得对齐）
  assert.equal(legs.canHelp(point({ ...other, gst: 0 }), ctx).ok, true);
  assert.equal(legs.canHelp(point({ ...other, gst: NOW_SEC - 10 }), ctx).why, 'immature');
  // 分矿种最低可协量门槛（同盗采腿口径）：本点矿种不在 mins 里 = 不限
  assert.equal(
    legs.canHelp(point({ ...other, oNum: 5 }), { ...ctx, mins: { [C.ITEM_THOR_MINE]: 10 } }).why,
    'onum-below-min',
  );
  assert.equal(
    legs.canHelp(point({ ...other, oNum: 100 }), { ...ctx, mins: { [C.ITEM_MINE]: 78 } }).ok,
    true,
    '雷神点不吃矿山门槛',
  );
});

test('rankByValue: oNum 降序、缺失沉底、不改入参', () => {
  const a = point({ x: 1, oNum: 10 });
  const b = point({ x: 2, oNum: 90 });
  const c = point({ x: 3, oNum: null });
  const src = [a, b, c];
  const out = legs.rankByValue(src);
  assert.deepEqual(
    out.map((p) => p.x),
    [2, 1, 3],
  );
  assert.equal(src[0], a, '入参顺序不得被改动');
});

test('pickNearestFree: 近家优先；home 不可得保持原序（不猜坐标）', () => {
  const near = point({ x: 705, y: 402 });
  const far = point({ x: 1000, y: 900 });
  const home = { x: 700, y: 400 };
  assert.deepEqual(
    legs.pickNearestFree([far, near], home.x, home.y).map((p) => p.x),
    [near.x, far.x],
  );
  const src = [far, near];
  assert.deepEqual(legs.pickNearestFree(src, null, null), src, 'home 不可得时不排序');
});

test('briefReasons: 同一原因折叠成 reason×n', () => {
  assert.equal(
    legs.briefReasons([{ why: 'immature' }, { why: 'immature' }, { why: 'no-onum' }]),
    'immature×2,no-onum×1',
  );
  assert.equal(legs.briefReasons([]), '-');
});

test('isOwnGathering: 逐字 isGatheringResource — 本服 + ownerId===本人 + specIndex 可得', () => {
  const ctx = { me: ME, originSid: ORIGIN_SID };
  const base = { initSid: ORIGIN_SID, ownerId: ME, specIndex: 9, x: 1, y: 2 };
  assert.equal(legs.isOwnGathering(base, ctx).ok, true);
  assert.equal(legs.isOwnGathering({ ...base, initSid: FOREIGN }, ctx).why, 'not-own-server');
  assert.equal(
    legs.isOwnGathering({ ...base, ownerId: '' }, ctx).why,
    'idle-point',
    '空闲点不算「本人正在采」，与 canGather 的「无主即空闲」不重叠',
  );
  assert.equal(legs.isOwnGathering({ ...base, ownerId: '0' }, ctx).why, 'idle-point');
  assert.equal(legs.isOwnGathering({ ...base, ownerId: '11999999999999' }, ctx).why, 'not-mine');
  assert.equal(legs.isOwnGathering({ ...base, specIndex: null }, ctx).why, 'no-spec-index');
  assert.equal(legs.isOwnGathering(null, ctx).why, 'no-point');
  assert.equal(legs.isOwnGathering(base, { me: '', originSid: ORIGIN_SID }).why, 'no-me');
  assert.equal(legs.isOwnGathering(base, { me: ME, originSid: null }).why, 'no-origin-sid');
});

test('stageGate: 只有开荒中(1) 放行；等待开荒(2)/已结束(3) 挡下并给出恢复秒', () => {
  const thr = {
    canOpen: C.WL_STAGE_CAN_OPEN,
    notOpen: C.WL_STAGE_NOT_OPEN,
    ended: C.WL_STAGE_ENDED,
  };
  const end = NOW_SEC + 21 * 3600;
  assert.deepEqual(legs.stageGate({ ...thr, curStage: 1, curStageEndTime: end }), {
    actionable: true,
    why: '',
    untilSec: 0,
  });
  // 快照在场但缺 curStage 键（ACL 回 null）⇒「无从判定」不得折成 0 再被判成已结束
  assert.deepEqual(legs.stageGate({ ...thr, curStage: null, curStageEndTime: end }), {
    actionable: true,
    why: 'unknown',
    untilSec: 0,
  });
  assert.deepEqual(legs.stageGate({ ...thr, curStage: 2, curStageEndTime: end }), {
    actionable: false,
    why: 'not-open',
    untilSec: end,
  });
  assert.deepEqual(legs.stageGate({ ...thr, curStage: 3, curStageEndTime: end }), {
    actionable: false,
    why: 'ended',
    untilSec: end,
  });
  // 枚举之外的取值（版本漂移）保守挡下，但仍把恢复时刻交回去
  assert.deepEqual(legs.stageGate({ ...thr, curStage: 7, curStageEndTime: end }), {
    actionable: false,
    why: 'other',
    untilSec: end,
  });
  // 阶段结束时刻读不到 ⇒ untilSec=0，由调用方兜底档收敛（不得回一个过去时刻让人空转）
  assert.deepEqual(legs.stageGate({ ...thr, curStage: 2, curStageEndTime: null }), {
    actionable: false,
    why: 'not-open',
    untilSec: 0,
  });
});

// ── survey.js：L0 棋盘 ────────────────────────────────────────────────
test('parseBoard: 只收 grid.type=3 且 region.wastelandType=3，按 mSid 分本服/外服桶', () => {
  const data = {
    grid: [
      {
        type: C.GRID_TYPE_WASTELAND,
        wastelandInfo: {
          id: 14011512,
          wkid: 14003212,
          regions: [
            { id: 140155, mSid: ORIGIN_SID, showNum: 9, wastelandType: 3, status: 4 },
            { id: 140156, mSid: FOREIGN, showNum: 10, wastelandType: 3, status: 5 },
            { id: 140157, mSid: ORIGIN_SID, showNum: 11, wastelandType: 2, status: 4 },
          ],
        },
      },
      {
        type: 1,
        wastelandInfo: {
          regions: [{ mSid: ORIGIN_SID, showNum: 12, wastelandType: 3, status: 4 }],
        },
      },
      { type: C.GRID_TYPE_WASTELAND, wastelandInfo: null },
    ],
  };
  const r = survey.parseBoard(data, ORIGIN_SID);
  assert.equal(r.regionCount, 2, '只统计 type=3 grid 下 wastelandType=3 的分区');
  assert.deepEqual(
    r.ownZones.map((z) => z.showNum),
    [9],
  );
  assert.deepEqual(
    r.stealZones.map((z) => z.showNum),
    [10],
  );
  // docs §4.6 实证 `wkid=14003212 / regionId=140155` 是两个轴：wkid 只能取房间层
  assert.equal(r.ownZones[0].wkid, 14003212, 'wkid 取房间层字段，绝不用 region.id');
  assert.equal(r.stealZones[0].wkid, 14003212);
  // 房间层没回 wkid 时退到 w.id；region.id 任何时候都不进这个槽
  const noRoomWkid = survey.parseBoard(
    {
      grid: [
        {
          type: C.GRID_TYPE_WASTELAND,
          wastelandInfo: {
            id: 14011512,
            regions: [{ id: 140155, mSid: ORIGIN_SID, showNum: 9, wastelandType: 3, status: 4 }],
          },
        },
      ],
    },
    ORIGIN_SID,
  );
  assert.equal(noRoomWkid.ownZones[0].wkid, 14011512, '兜底走房间 id，不落到 region.id');
  assert.equal(r.ownZones[0].sid, ORIGIN_SID);
  // fail-closed：originSid 不可得 ⇒ 不桶化（两桶空），但 regionCount 照常
  const blind = survey.parseBoard(data, null);
  assert.deepEqual(blind.ownZones, []);
  assert.deepEqual(blind.stealZones, []);
  assert.equal(blind.regionCount, 2);
});

test('crossCheckLands: showNum===wastelandIndex 的 22071 交叉校验只报数不改判据', () => {
  const zones = [
    { showNum: 9, type: 3, status: 4 },
    { showNum: 10, type: 3, status: 4 },
  ];
  const lands = [
    { index: 9, type: 3, status: 4 },
    { index: 10, type: 3, status: 5 },
  ];
  assert.deepEqual(survey.crossCheckLands(zones, lands), { checked: 2, mismatch: 1 });
  assert.deepEqual(survey.crossCheckLands(zones, null), { checked: 0, mismatch: 0 });
});

// ── survey.js：L2 地块归一 ─────────────────────────────────────────────
test('ingestResourcePoints: 只留 316、按 specIndex 精筛，m 块拆成标量且原始行不被引用', () => {
  const rows = [
    tileRow(100, 200),
    tileRow(101, 201, { specIndex: 10 }),
    { x: 102, y: 202, pointType: 315, m: { specIndex: 9 } },
    { x: 103, y: 203, pointType: C.POINT_TYPE_RESOURCE, m: null },
    { x: 0, y: 0, pointType: C.POINT_TYPE_RESOURCE, m: { specIndex: 9 } },
  ];
  const speedOf = (id) => (id === C.ITEM_THOR_MINE ? 240 : null);
  const out = survey.ingestResourcePoints(rows, { specIndex: 9, speedOf });
  assert.equal(out.length, 1, 'specIndex 精筛 + pointType + 空 m + 零坐标各掉一条');
  assert.equal(out[0].x, 100);
  assert.equal(out[0].ownerId, '', 'ownerId 缺失归一为空串（不是 0）');
  assert.equal(out[0].gatherSpeed, 240, 'gatherSpeed 由 RESOURCE 表回查注入');
  assert.deepEqual(out[0].stealUidList, []);
  assert.equal(out[0].specIndex, 9);
  // oNum/gNum 缺失 = 这帧没回，必须留 null 而非 0
  const bare = survey.ingestResourcePoints(
    [{ x: 1, y: 2, pointType: C.POINT_TYPE_RESOURCE, m: { specIndex: 9, itemId: 4502 } }],
    { specIndex: 9 },
  );
  assert.equal(bare[0].oNum, null);
  assert.equal(bare[0].gNum, null);
  assert.equal(bare[0].gatherSpeed, null);
  // specIndex 不给（<=0）时不做分区精筛（被动嗅探跨分区场景）
  assert.equal(survey.ingestResourcePoints(rows, {}).length, 2);
});

// ── survey.js：L1+L2 精扫（桩 net，逐区惰性）───────────────────────────
/**
 * 造一个只认 2120 / 901 的桩 net。
 * @param {{anchor?:object, windows?:object[], recallOk?:boolean}} h 各协议应答（`recallOk` 缺省 false = 2121 被拒）
 * @param {{calls:object}} [sink] 记录出网次数
 * @returns {object} net 桩
 */
function stubNet(h, sink) {
  const calls = { guarded: [], send: [] };
  if (sink) sink.calls = calls;
  let win = 0;
  return {
    calls: calls,
    install: () => true,
    isSending: () => false,
    async sendGuarded(cmd, body) {
      calls.guarded.push({ cmd, body });
      if (cmd === C.CMD_NWL_POS) return { ok: true, code: 0, data: h.anchor || { pos: null } };
      if (cmd === C.CMD_MAP_SINGLE) return { ok: true, code: 0, data: h.board || {} };
      if (cmd === C.CMD_RECALL && h.recallOk) return { ok: true, code: 0, data: {} };
      return { ok: false, code: 9, data: null };
    },
    async send(cmd, body) {
      calls.send.push({ cmd, body });
      if (cmd === C.CMD_WORLD_INFO) {
        const list = h.windows ? h.windows[Math.min(win++, h.windows.length - 1)] : [];
        return { ok: true, code: 0, data: { pointList: list } };
      }
      return { ok: false, code: 9, data: null };
    },
  };
}

test('scanZone: 单区精扫恰为 1×2120 + 2×901，两窗重叠点去重，结果进 memo', async () => {
  survey.reset();
  const zone = { sid: ORIGIN_SID, showNum: 9, wkid: 140155, type: 3, status: 4 };
  const net = stubNet({
    anchor: { pos: { x: 713, y: 356, k: 14011512 } },
    windows: [
      [tileRow(100, 200), tileRow(101, 201)],
      [tileRow(100, 200), tileRow(102, 202)],
    ],
  });
  const r = await survey.scanZone(net, zone, { nowMs: NOW_MS });
  assert.equal(r.ok, true);
  assert.equal(r.fromMemo, false);
  assert.equal(r.key, survey.zoneKey(zone));
  assert.equal(r.entry.points.length, 3, '两窗并集去重');
  assert.equal(net.calls.guarded.length, 1, '一发 2120');
  assert.equal(net.calls.send.length, 2, '两发 901（居中 + y-60）');
  assert.equal(net.calls.send[1].body.y, 356 - C.SCAN_Y_OFFSET);
  assert.equal(net.calls.send[0].body.k, 14011512, 'k=锚点房间 wkid');
  assert.equal(survey.memoGet(r.key, NOW_MS), r.entry, 'memo 命中同一 entry');
  // TTL 内重扫零出网（惰性扫描纪律的地基）
  const again = await survey.scanZone(net, zone, { nowMs: NOW_MS + 1000 });
  assert.equal(again.fromMemo, true);
  assert.equal(net.calls.guarded.length, 1, '未新增 2120');
  assert.equal(net.calls.send.length, 2, '未新增 901');
  survey.reset();
  assert.equal(survey.memoGet(r.key, NOW_MS), null, 'reset 丢全部读通道缓存');
});

test('scanZone: 2120 无应答即整区失败且不写 memo（不把「扫不动」伪装成「没有点」）', async () => {
  survey.reset();
  const net = stubNet({ anchor: { pos: null } });
  const r = await survey.scanZone(net, { sid: ORIGIN_SID, showNum: 9, wkid: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.entry, null);
  assert.equal(net.calls.send.length, 0, '锚点都拿不到就不该发 901');
  assert.equal(survey.memoGet(r.key, Date.now()), null);
});

test('pickStealZones: 只排序不扫描；TTL 内黑名单剔除；产出区顶到队头', () => {
  survey.reset();
  const zones = [
    { sid: FOREIGN, showNum: 10, wkid: 1, type: 3, status: 4 },
    { sid: FOREIGN, showNum: 11, wkid: 2, type: 3, status: 5 },
    { sid: FOREIGN, showNum: 12, wkid: 3, type: 3, status: 1 },
    { sid: FOREIGN, showNum: 13, wkid: 4, type: 3, status: 4 },
  ];
  // 纯排序：一个请求都不该发（本函数连 net 参数都没有）
  const fresh = survey.pickStealZones(zones, { nowMs: NOW_MS, statusOk: [4, 5] });
  assert.deepEqual(
    fresh.map((c) => c.rank),
    [1, 1, 1],
    '从未扫过 ⇒ 同 rank，按 showNum 稳定序',
  );
  assert.equal(fresh.length, 3, 'status=1 的分区不进候选');
  const memoMap = Object.create(null);
  const hitKey = survey.zoneKey(zones[0]);
  const dryKey = survey.zoneKey(zones[1]);
  const neverKey = survey.zoneKey(zones[3]);
  memoMap[hitKey] = { points: [], scannedAt: NOW_MS - 1000, stealable: true, hit: true };
  memoMap[dryKey] = { points: [], scannedAt: NOW_MS - 1000, stealable: false, hit: false };
  const ranked = survey.pickStealZones(zones, { nowMs: NOW_MS, memo: memoMap, statusOk: [4, 5] });
  assert.deepEqual(
    ranked.map((c) => c.key),
    [hitKey, neverKey],
    'TTL 内 stealable=false 的区直接剔除（不再重扫）；有产出的排最前',
  );
  assert.deepEqual(
    ranked.map((c) => c.rank),
    [0, 1],
  );
  // 过期后黑名单翻案，且 rank 低于「有产出」与「从未扫过」
  const later = survey.pickStealZones(zones, {
    nowMs: NOW_MS + C.ZONE_MEMO_TTL_MS,
    memo: memoMap,
    statusOk: [4, 5],
  });
  assert.deepEqual(
    later.map((c) => c.rank),
    [1, 2, 2],
    '未扫过的(1) 优先于刚过期的(2)',
  );
});

test('scanZone: 同区并发合流为一次扫描（第二腿 joined，零新增请求）', async () => {
  survey.reset();
  const zone = { sid: ORIGIN_SID, showNum: 9, wkid: 14003212, type: 3, status: 4 };
  const net = stubNet({
    anchor: { pos: { x: 713, y: 356, k: 14011512 } },
    windows: [[tileRow(100, 200)], []],
  });
  const [a, b] = await Promise.all([
    survey.scanZone(net, zone, { nowMs: NOW_MS }),
    survey.scanZone(net, zone, { nowMs: NOW_MS }),
  ]);
  assert.equal(a.joined, false, '发起方不标 joined');
  assert.equal(b.joined, true, '后到的一条腿合流，不重发 2120/901');
  assert.equal(a.entry, b.entry, '同一份 entry');
  assert.equal(net.calls.guarded.length, 1, '整个并发窗口只发一发 2120');
  assert.equal(net.calls.send.length, 2, '整个并发窗口只发两发 901');
  // 完成后清除在途标记：reset 后同一区可以再扫
  survey.reset();
  const net2 = stubNet({ anchor: { pos: { x: 713, y: 356, k: 1 } }, windows: [[], []] });
  await survey.scanZone(net2, zone, { nowMs: NOW_MS });
  await survey.scanZone(net2, zone, { nowMs: NOW_MS });
  assert.equal(net2.calls.guarded.length, 1);
});

test('scanZone: reset 期间在途的扫描不回写新 memo（旧世界的点不得喂给新会话）', async () => {
  survey.reset();
  const zone = { sid: ORIGIN_SID, showNum: 9, wkid: 14003212, type: 3, status: 4 };
  const net = stubNet({
    anchor: { pos: { x: 713, y: 356, k: 14011512 } },
    windows: [[tileRow(100, 200)], []],
  });
  const p = survey.scanZone(net, zone, { nowMs: NOW_MS });
  survey.reset();
  const r = await p;
  assert.equal(r.ok, true, '本次结果照常返回（数据是刚从服务器取回的）');
  assert.equal(survey.memoGet(r.key, NOW_MS), null, '但不种进 reset 之后的新缓存');
});

test('noteZoneStealable/markZoneHit: 只影响已存在的 entry，不给未知分区凭空建账', async () => {
  survey.reset();
  const zone = { sid: FOREIGN, showNum: 21, wkid: 1, type: 3, status: 4 };
  const net = stubNet({
    anchor: { pos: { x: 500, y: 500, k: 14000001 } },
    windows: [[], []],
  });
  const r = await survey.scanZone(net, zone);
  survey.noteZoneStealable(r.key, false);
  survey.markZoneHit(r.key);
  const e = survey.memoGet(r.key, Date.now());
  assert.equal(e.stealable, false);
  assert.equal(e.hit, true);
  survey.noteZoneStealable('0_0', false);
  survey.markZoneHit('0_0');
  assert.equal(survey.memoGet('0_0', Date.now()), null);
});

test('mergeSniffed: 嗅探只增量并入已存在的 entry，绝不据局部可见新建缓存', async () => {
  survey.reset();
  const zone = { sid: ORIGIN_SID, showNum: 9, wkid: 140155, type: 3, status: 4 };
  const net = stubNet({
    anchor: { pos: { x: 713, y: 356, k: 14011512 } },
    windows: [[tileRow(100, 200)], []],
  });
  const r = await survey.scanZone(net, zone, { nowMs: NOW_MS });
  assert.equal(r.entry.points.length, 1);
  const before = net.calls.send.length;
  // initSid + specIndex 正好落回同一分区键（ACL §4.4 交叉验证的口径）
  const n = survey.mergeSniffed(
    [tileRow(100, 200, { oNum: 7 }), tileRow(105, 210), tileRow(300, 300, { initSid: FOREIGN })],
    { nowMs: NOW_MS },
  );
  assert.equal(n, 2, '同分区两点并入；外服 initSid 那点在 memo 里没有对应 entry，丢弃');
  assert.equal(r.entry.points.length, 2);
  const same = r.entry.points.find((p) => p.x === 100 && p.y === 200);
  assert.equal(same.oNum, 7, '同点整条替换（新帧是权威）');
  assert.equal(net.calls.send.length, before, '嗅探路径零出网');
  // TTL 过期后不再吸收（否则「局部可见」会被当成「精扫完成」）
  assert.equal(
    survey.mergeSniffed([tileRow(400, 400)], { nowMs: Date.now() + C.ZONE_MEMO_TTL_MS }),
    0,
  );
  // specIndex===0 是 BWL 巨兽盛宴线的点，不属任何 NWL 分区
  assert.equal(survey.mergeSniffed([tileRow(401, 401, { specIndex: 0 })], { nowMs: NOW_MS }), 0);
});

// ── march-loop.js：安全期套利 ──────────────────────────────────────────
test('computeRecallAt: arrive+成熟-余量；arrive 或成熟秒不可得一律回 0（不拍脑袋召回）', () => {
  assert.equal(
    marchLoop.computeRecallAt(1000, MATURE_SEC),
    1000 + MATURE_SEC - C.RECALL_MARGIN_SEC,
  );
  assert.equal(marchLoop.computeRecallAt(1000, MATURE_SEC, 0), 1000 + MATURE_SEC);
  assert.equal(marchLoop.computeRecallAt(0, MATURE_SEC), 0);
  assert.equal(marchLoop.computeRecallAt(1000, null), 0);
  assert.equal(marchLoop.computeRecallAt(1000, 0), 0);
});

test('pickGatherMarch: 315 + 目标坐标 + 本人（uid 或出发地）三条件缺一不可', () => {
  const g = { x: 682, y: 384, me: ME, homeX: 700, homeY: 400 };
  const hit = marchLoop.pickGatherMarch([marchRaw({ begin: { bx: 1, by: 1 } })], g);
  assert.equal(hit.id, '1234567890123456789', 'marchId 按字符串取，19 位不 Number 化');
  assert.equal(hit.arrive, NOW_SEC + 600);
  assert.equal(
    marchLoop.pickGatherMarch([marchRaw({ uid: '11999999999999', begin: { bx: 1, by: 1 } })], g),
    null,
    'uid 与出发地双双不匹配 ⇒ 不认领',
  );
  assert.equal(
    marchLoop.pickGatherMarch([marchRaw({ uid: '11999999999999' })], g).id,
    '1234567890123456789',
    '出发地命中即可认领（uid 缺省/不符时的兜底同序证据）',
  );
  assert.equal(marchLoop.pickGatherMarch([marchRaw({ marchType: 3 })], g), null);
  assert.equal(marchLoop.pickGatherMarch([marchRaw({ target: { tx: 1, ty: 1 } })], g), null);
  assert.equal(marchLoop.pickGatherMarch([], g), null);
});

test('march-loop 状态机: 派兵→GATHERING；异目标推送不改态；state=ARRIVED_HOME 才收尾', () => {
  marchLoop.setMatureSec(MATURE_SEC);
  marchLoop.reset('test init');
  assert.equal(marchLoop.isBusy(), false);
  marchLoop.beginRound({ x: 682, y: 384, k: 14011512, specIndex: 9 }, NOW_SEC, MATURE_SEC, '', 0);
  let s = marchLoop.snapshot();
  assert.equal(s.phase, marchLoop.PHASE_GATHERING);
  assert.equal(s.recallAtSec, NOW_SEC + MATURE_SEC - C.RECALL_MARGIN_SEC);
  // 已 decode 的 March（index.js 的转交口径）
  const home = march.State.ARRIVED_HOME;
  assert.equal(
    marchLoop.onMarch(march.decode(marchRaw({ target: { tx: 999, ty: 999 } }))),
    false,
    '不是本轮目标的行军不认领',
  );
  assert.equal(marchLoop.onMarch(march.decode(marchRaw({ marchState: 2 }))), false);
  assert.equal(marchLoop.snapshot().marchId, '1234567890123456789', '在途推送补 marchId');
  assert.equal(
    marchLoop.onMarch(march.decode(marchRaw({ marchState: home }))),
    true,
    '只有 ARRIVED_HOME 认定回城收尾',
  );
  assert.equal(marchLoop.isBusy(), false, '收尾即回 IDLE，下一轮由额度闸重新收敛');
  marchLoop.reset('test end');
});

test('advance: 召回失败留退避，连续 RECALL_FAIL_MAX 次即放弃本轮（不逐拍重发废券）', async () => {
  marchLoop.setMatureSec(MATURE_SEC);
  marchLoop.reset('test init');
  const net = stubNet({});
  // arrive 取过去时刻 ⇒ recallAt 已过，本拍就该召回；marchId 直接给到位（绕开探针路径）
  const arrive = NOW_SEC - MATURE_SEC;
  marchLoop.beginRound(
    { x: 682, y: 384, k: 14011512, specIndex: 9 },
    arrive,
    MATURE_SEC,
    '12345',
    arrive,
  );
  const gAt = (ms) => ({
    alive: () => true,
    nowSec: NOW_SEC,
    nowMs: ms,
    probe: { me: ME, homeX: null, homeY: null, gapMs: 60 * 1000, nowMs: ms },
  });
  const recalled = () => net.calls.guarded.filter((c) => c.cmd === C.CMD_RECALL).length;
  assert.equal(await marchLoop.advance(net, gAt(NOW_MS)), 'recall-failed');
  assert.equal(recalled(), 1, '第一次被拒发了一发 2121');
  assert.equal(await marchLoop.advance(net, gAt(NOW_MS + 3000)), 'gathering', '退避期内不出网');
  assert.equal(recalled(), 1, '3s 档不再重发');
  assert.equal(
    await marchLoop.advance(net, gAt(NOW_MS + C.RECALL_FAIL_BACKOFF_MS + 1000)),
    'recall-failed',
  );
  assert.equal(
    await marchLoop.advance(net, gAt(NOW_MS + 2 * C.RECALL_FAIL_BACKOFF_MS + 1000)),
    'recall-abandoned',
  );
  assert.equal(recalled(), C.RECALL_FAIL_MAX, '总共只试 ' + C.RECALL_FAIL_MAX + ' 次');
  assert.equal(marchLoop.isBusy(), false, '放弃本轮即回 IDLE');
  assert.equal(marchLoop.snapshot().recallAtSec, 0);
  marchLoop.reset('test end');
});

test('onMarch 只认已归一化 March：报文 raw（带 .target.tx）不得被当成 decoded 吞下', () => {
  marchLoop.reset('test init');
  marchLoop.beginRound({ x: 682, y: 384, k: 1, specIndex: 9 }, NOW_SEC, MATURE_SEC, '', 0);
  // 直接把 10007 的原始条目递进来：type/state 都在报文字段上，decoded 口径下不该命中
  assert.equal(marchLoop.onMarch(marchRaw({ marchState: march.State.ARRIVED_HOME })), false);
  assert.equal(marchLoop.isBusy(), true, '未收尾则仍占着本轮');
  marchLoop.reset('test end');
});

test('尾轮短窗属于本轮：arrive 被推送校准后仍按短窗重算 recallAt，不升级回 conf 原值', () => {
  // index.js 每拍都会把 conf 原值注入一次，所以「注入值」与「本轮窗长」必须分开
  marchLoop.setMatureSec(MATURE_SEC);
  marchLoop.reset('test init');
  const TAIL_SEC = 1800;
  marchLoop.beginRound({ x: 682, y: 384, k: 14011512, specIndex: 9 }, NOW_SEC, TAIL_SEC, '', 0);
  assert.equal(
    marchLoop.snapshot().recallAtSec,
    NOW_SEC + TAIL_SEC - C.RECALL_MARGIN_SEC,
    'arrive 未知时以派兵秒兜底 + 本轮短窗',
  );
  const arrive = NOW_SEC + 600;
  marchLoop.onMarch(march.decode(marchRaw({ marchArrive: arrive })));
  const s = marchLoop.snapshot();
  assert.equal(s.arriveAtSec, arrive, '去程推送校准 arrive');
  assert.equal(
    s.recallAtSec,
    arrive + TAIL_SEC - C.RECALL_MARGIN_SEC,
    '窗长仍取本轮短窗（用 conf 原值重算会把召回点推过成熟线）',
  );
  assert.ok(s.recallAtSec < arrive + MATURE_SEC - C.RECALL_MARGIN_SEC, '短窗召回必早于成熟线');
  // 换轮即恢复完整窗（窗长不跨轮残留）
  marchLoop.reset('test end');
  marchLoop.beginRound({ x: 682, y: 384, k: 14011512, specIndex: 9 }, NOW_SEC, MATURE_SEC, '', 0);
  assert.equal(
    marchLoop.snapshot().recallAtSec,
    NOW_SEC + MATURE_SEC - C.RECALL_MARGIN_SEC,
    'reset 后本轮窗长清零，回落 conf 现读值',
  );
  marchLoop.reset('test end');
});

test('零额度认领下发的窗长 = RECALL_MARGIN_SEC：recallAt 落在过去，首拍即 2121', async () => {
  // 事故现场（11-12）：日额度归零后重启，认领命中一颗早已过成熟线的点。`index.js` 此刻下发
  //   `RECALL_MARGIN_SEC`（窗长 = 余量 ⇒ recallAt = arrive），不再是 `TAIL_MIN_SEC`。
  //   本条只锁定状态机端的后果：无论 `gst` 距今多久，都不存在「再等几分钟才收兵」的空窗。
  marchLoop.setMatureSec(MATURE_SEC);
  marchLoop.reset('test init');
  const net = stubNet({ recallOk: true });
  const arrive = NOW_SEC - 2 * MATURE_SEC;
  marchLoop.beginRound(
    { x: 188, y: 182, k: 14011512, specIndex: 9 },
    NOW_SEC,
    C.RECALL_MARGIN_SEC,
    '12345',
    arrive,
  );
  assert.equal(marchLoop.snapshot().recallAtSec, arrive, '窗长=余量 ⇒ recallAt 恰等于 arrive');
  assert.ok(arrive + MATURE_SEC < NOW_SEC, '前置：该点已过成熟线（可被盗侧）');
  assert.equal(
    await marchLoop.advance(net, { alive: () => true, nowSec: NOW_SEC, nowMs: NOW_MS }),
    'recalled',
    '首拍即召回，不排任何等待',
  );
  assert.equal(net.calls.guarded.filter((c) => c.cmd === C.CMD_RECALL).length, 1);
  assert.equal(marchLoop.snapshot().phase, marchLoop.PHASE_RECALLING);
  // 旧值的真实缺陷在「那一趟刚开始几分钟」时：零产出却把兵留到 +9min（已不再花额度，白占行军队列）
  const fresh = NOW_SEC - 120;
  assert.equal(
    marchLoop.computeRecallAt(fresh, C.RECALL_MARGIN_SEC),
    fresh,
    '新口径：下一拍即召回',
  );
  assert.ok(
    marchLoop.computeRecallAt(fresh, C.TAIL_MIN_SEC) > NOW_SEC,
    '旧口径：召回被排到未来（本例 +7min）',
  );
  marchLoop.reset('test end');
});

// ── 分矿种最低量门槛（items.js 纯策略层）──────────────────────────────

test('normalizeItemState：只收池内矿种，on/min 归一，未登记项不落键', () => {
  assert.deepEqual(items.normalizeItemState(null), {});
  assert.deepEqual(items.normalizeItemState([C.ITEM_THOR_MINE]), {}, '数组不是清单状态');
  assert.deepEqual(items.normalizeItemState({ 9999: { on: 0, min: 5 } }), {}, '池外 id 丢弃');
  assert.deepEqual(
    items.normalizeItemState({ 4501: { on: 0, min: '1400' }, 4502: { on: 1, min: -3 } }),
    { 4501: { on: 0, min: 1400 }, 4502: { on: 1, min: 0 } },
  );
});

test('legPlan：未登记 = 默认勾选 + 不限；取消勾选 = 排除；全不勾 = 空白名单', () => {
  const all = items.legPlan({});
  assert.deepEqual(all.whitelist, [C.ITEM_THOR_MINE, C.ITEM_MINE]);
  assert.equal(all.mins[C.ITEM_THOR_MINE], 0);
  assert.equal(all.mins[C.ITEM_MINE], 0);
  const partial = items.legPlan({ 4502: { on: 0, min: 0 }, 4501: { on: 1, min: 1400 } });
  assert.deepEqual(partial.whitelist, [C.ITEM_THOR_MINE]);
  assert.equal(partial.mins[C.ITEM_THOR_MINE], 1400);
  const none = items.legPlan({ 4501: { on: 0, min: 0 }, 4502: { on: 0, min: 0 } });
  assert.deepEqual(none.whitelist, [], '全不勾 = 腿不动（不得喂给 inWhitelist 当「不限」）');
});

test('migrateItemLists：v1 白名单 + 全局门槛 → 分矿种 {on,min}，旧键删除', () => {
  const v1 = {
    enabled: true,
    gatherItemWhitelist: [C.ITEM_THOR_MINE, C.ITEM_MINE],
    stealItemWhitelist: [C.ITEM_THOR_MINE],
    helpItemWhitelist: [],
    stealMinONum: 78,
    helpMinONum: 0,
  };
  const out = items.migrateItemLists(v1, 1);
  // 旧全局门槛是「所有矿种共用」，折算成每个矿种的初始门槛（被排除矿种也带上，重新勾选即恢复旧行为）
  assert.deepEqual(out.stealItems, {
    4501: { on: 1, min: 78 },
    4502: { on: 0, min: 78 },
  });
  assert.deepEqual(out.helpItems, {}, '旧「空=不限」+ 门槛 0 折算为全默认 on + 不限');
  assert.equal(out.stealItemWhitelist, undefined, '旧键删除');
  assert.equal(out.helpItemWhitelist, undefined);
  assert.equal(out.stealMinONum, undefined);
  assert.equal(out.helpMinONum, undefined);
  assert.deepEqual(out.gatherItemWhitelist, [C.ITEM_THOR_MINE, C.ITEM_MINE], '采集腿不动');
  assert.equal(out.enabled, true);
  // 迁移后行为与旧配置逐字等价：只偷 4501 且门槛 78、协助不限矿种
  const plan = items.legPlan(out.stealItems);
  assert.deepEqual(plan.whitelist, [C.ITEM_THOR_MINE]);
  assert.equal(plan.mins[C.ITEM_THOR_MINE], 78);
  assert.deepEqual(items.legPlan(out.helpItems).whitelist, [C.ITEM_THOR_MINE, C.ITEM_MINE]);
  assert.deepEqual(v1.stealItemWhitelist, [C.ITEM_THOR_MINE], '入参不被改动');
});

test('migrateItemLists：v2 {on,max} + 全局门槛 → {on,min}（max 丢弃），重跑收敛', () => {
  const v2 = {
    stealItems: { 4501: { on: 1, max: 2 }, 4502: { on: 0, max: 5 } },
    helpItems: {},
    stealMinONum: 78,
    helpMinONum: 30,
  };
  const out = items.migrateItemLists(v2, 2);
  assert.deepEqual(out.stealItems, { 4501: { on: 1, min: 78 }, 4502: { on: 0, min: 78 } });
  assert.deepEqual(
    out.helpItems,
    { 4501: { on: 1, min: 30 }, 4502: { on: 1, min: 30 } },
    'v2 空清单 + 旧全局门槛 30 → 两矿种默认勾选 + 门槛 30',
  );
  assert.equal(out.stealItems['4501'].max, undefined, 'v2 每日上限语义丢弃');
  assert.equal(out.stealMinONum, undefined);
  assert.equal(out.helpMinONum, undefined);
  assert.deepEqual(items.migrateItemLists(out, 2), out, '重跑收敛（registry 落盘前每次读盘重跑）');
});

test('migrateItemLists：幂等（落盘前每次读盘重跑收敛同一结果）；v3 存档不再动', () => {
  const v1 = {
    stealItemWhitelist: [C.ITEM_MINE],
    helpItemWhitelist: [C.ITEM_THOR_MINE, C.ITEM_MINE],
  };
  const once = items.migrateItemLists(v1, 0);
  assert.deepEqual(items.migrateItemLists(once, 0), once, '重复迁移收敛同一结果');
  const v3 = {
    stealItems: { 4501: { on: 1, min: 1400 }, 4502: { on: 1, min: 78 } },
    helpItems: {},
  };
  assert.deepEqual(items.migrateItemLists(v3, 3), v3, 'v3 存档原样透传');
  const noOld = { stealItems: { 4501: { on: 0, min: 0 } }, helpItems: {} };
  assert.deepEqual(items.migrateItemLists(noOld, 1), noOld, '旧键缺席时不触碰新键');
});
