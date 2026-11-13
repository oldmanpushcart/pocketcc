// cq26-ice-shake（CQ26 开荒融冰：融冰腿 2103 + 摇一摇腿 2129）纯函数单测：
//   miniGameId 句柄读取（两种 Int64 形态 + 直接给奖那一支 + 被拒应答）、提交计划（过期闸与选档）、
//   重投判定（在途闸挡下的不重投）、奖励面板实参归一、档位展示名；
//   融冰腿（从 cq26-feast 迁来）：冰缓存重建、逐等级消耗表求值、候选分线/预算/冷却过滤。
// 全部断言不发包、不摸游戏符号——feat 模块 import 链会触到浏览器全局，
// 故先最小桩化 window/document/chrome，再动态 import 取导出纯函数（同 cq26-excav 口径）。
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

const mod = await import('../../extension/src/feats/cq26/ice-shake.js');
const {
  readMiniGameId,
  tierText,
  planSubmit,
  shouldResubmit,
  rewardPanelArgs,
  TIER_HIGH,
  SUBMIT_EXPIRE_MS,
  MAX_TRIES,
  // 融冰腿（2103）纯函数与常量：从 cq26-feast 迁来，与摇一摇腿共用同一份 feat 导出面
  ingestIceList,
  iceCost,
  pickIce,
  PHASE_GATHER,
  ICE_TTL_MS,
  MAX_REJECT,
} = mod;

// 实录 fixtures：本场 rec 11981629951662 / dashcam-rec-20261112T011559…-1794417359392 里
// 2117 应答给出的四枚 miniGameId（`{_low,_high}` 是报文序列化形态，等价裸 POJO 输入），
// 十进制串由 BigInt 无精度拼装独立算出（19 位雪花 id，绝不经 Number）。
const RECORDED = [
  { lo: -1155667960, hi: 1146845447, dec: '4925663691570800648' },
  { lo: 522053634, hi: 1146845483, dec: '4925663843572377602' },
  { lo: 488499207, hi: 1146845513, dec: '4925663972387842055' },
  { lo: -635574271, hi: 1146845531, dec: '4925664052868147201' },
];

// ── 融冰腿 fixtures（从 cq26-feast 迁来：冰缓存重建/消耗表/候选过滤）──────────
const SID = 3828; // 实录老家服号（iceList 行 initSid）
const NOW_MS = 1794234712000; // 任取基准毫秒（与服务器秒同源即可）

/** 造一条 901/10018 的 iceList 行（逐键照抄实录：行内不带 k，k 在 body 顶层） */
function iceRow(x, y, over) {
  return Object.assign({ level: 3, v: 3397, x, y, specIndex: 0, initSid: SID }, over || {});
}

/** 把 iceList 行灌成冰缓存（k 从 body 顶层传入） */
function iceMap(rows, k = 14002212, atMs = NOW_MS) {
  const into = Object.create(null);
  ingestIceList(rows, k, into, atMs);
  return into;
}

test('裸 {_low,_high} 形态：四枚实录句柄逐枚解出十进制串（负 _low 补回 2^32）', () => {
  for (const r of RECORDED) {
    const body = { isOk: 1, miniGameId: { _low: r.lo, _high: r.hi, _unsigned: false } };
    assert.equal(readMiniGameId(body, 0), r.dec, `low=${r.lo} high=${r.hi}`);
  }
});

test('Long 实例形态（自带 toString/toNumber）走 int64Str，与 POJO 形态同串', () => {
  const r = RECORDED[0];
  const longLike = {
    toString: () => r.dec,
    toNumber: () => Number(r.dec),
  };
  assert.equal(readMiniGameId({ isOk: 1, miniGameId: longLike }, 0), r.dec);
});

test('字符串句柄原样收下（服务器偶发以十进制串下发）', () => {
  assert.equal(readMiniGameId({ miniGameId: RECORDED[2].dec }, 0), RECORDED[2].dec);
});

test('直接给奖那一支（只有 rewardResult、无 miniGameId）读成空串', () => {
  const body = { isOk: 1, rewardResult: { items: [{ itemId: 62909, itemCount: 1 }] } };
  assert.equal(readMiniGameId(body, 0), '');
});

test('句柄为 0（数字/串/全零高低位三种形态）一律视为无小游戏', () => {
  assert.equal(readMiniGameId({ miniGameId: 0 }, 0), '');
  assert.equal(readMiniGameId({ miniGameId: '0' }, 0), '');
  assert.equal(readMiniGameId({ miniGameId: { _low: 0, _high: 0, _unsigned: false } }, 0), '');
});

test('应答被拒（status≠0）时不代摇，哪怕载荷里挂着句柄', () => {
  const body = { miniGameId: { _low: RECORDED[0].lo, _high: RECORDED[0].hi } };
  assert.equal(readMiniGameId(body, 1), '');
  assert.equal(readMiniGameId(body, 500), '');
  // status 缺省（取不到）时不作为拒绝判据
  assert.equal(readMiniGameId(body), RECORDED[0].dec);
});

test('形态异常载荷不抛异常、回空串', () => {
  assert.equal(readMiniGameId(null, 0), '');
  assert.equal(readMiniGameId(undefined, 0), '');
  assert.equal(readMiniGameId('text payload', 0), '');
  assert.equal(readMiniGameId(0, 0), '');
  assert.equal(readMiniGameId({ miniGameId: { _low: 1, _high: -1 } }, 0), ''); // 拼出负数，非合法句柄
  assert.equal(readMiniGameId({ miniGameId: {} }, 0), '');
});

test('档位展示名：0/1/2 = 低温/中温/高温，未知号回退「档 n」', () => {
  assert.equal(tierText(0), '低温档');
  assert.equal(tierText(1), '中温档');
  assert.equal(tierText(2), '高温档');
  assert.equal(tierText('2'), '高温档');
  assert.equal(tierText(5), '档 5');
  assert.equal(tierText(NaN), '档 NaN');
});

test('提交计划：合法句柄且窗内→只两键且恒发高温档（id 保持十进制串，不预先装箱）', () => {
  const p = planSubmit(RECORDED[0].dec, 0);
  assert.deepEqual(Object.keys(p).sort(), ['id', 'index']);
  assert.equal(p.id, RECORDED[0].dec);
  assert.equal(p.index, TIER_HIGH);
  assert.equal(TIER_HIGH, 2, '高温档就是本 feat 恒发的那一档');
});

test('提交计划：过期边界按闸值取闭区间（= SUBMIT_EXPIRE_MS 仍发，再 +1ms 不发）', () => {
  assert.ok(planSubmit(RECORDED[1].dec, SUBMIT_EXPIRE_MS), '边界上应仍可提交');
  assert.equal(planSubmit(RECORDED[1].dec, SUBMIT_EXPIRE_MS + 1), null);
  assert.equal(planSubmit(RECORDED[1].dec, 9001), null);
});

test('提交计划：不合法句柄（非纯数字/空/0/负数/带小数/null）一律不发', () => {
  for (const bad of [
    '',
    ' 4925663691570800648',
    '492566369157080064a',
    '1.5',
    '-1',
    '0',
    null,
    undefined,
    NaN,
  ]) {
    assert.equal(planSubmit(bad, 0), null, 'bad=' + JSON.stringify(bad));
  }
});

test('提交计划：耗时不可信（负数/NaN）不发（时钟回跳或调用方传错）', () => {
  assert.equal(planSubmit(RECORDED[2].dec, -1), null);
  assert.equal(planSubmit(RECORDED[2].dec, NaN), null);
  assert.equal(planSubmit(RECORDED[2].dec, undefined), null);
});

// 报文实证 dashcam rec 11981629951662 / dashcam-rec-20261112T021006…-1794420606597：
//   同一枚 id 的第二发 2129 撞回 header.s=3 / d=activity_120002（字典表：参数错误），
//   而 NetMgr 对外层 s===3 无条件 ShowTips ⇒ 重投不给奖只在玩家脸上弹错误。
test('重投判定：被在途闸挡下（无抛错文案）绝不重投', () => {
  assert.equal(shouldResubmit('', 1), false);
  assert.equal(shouldResubmit('', 0), false);
  assert.equal(shouldResubmit(undefined, 1), false);
  assert.equal(shouldResubmit(null, 1), false);
});

test('重投判定：发送本身抛错才重试，且不越过 MAX_TRIES 上限', () => {
  assert.equal(shouldResubmit('encode failed', 1), true);
  assert.equal(shouldResubmit('boom', MAX_TRIES - 1), true);
  assert.equal(shouldResubmit('boom', MAX_TRIES), false);
  assert.equal(shouldResubmit('boom', 99), false);
  assert.ok(MAX_TRIES >= 2, '至少给抛错一次重投机会');
});

// 游戏原生成功回调那句 OpenUI(CommonRewardPanel,{serverReward:o.rewardResult}) 的实参口径：
//   应答里 rewardResult 是 `{items,resource}` 对象，原样透传；没有载荷时不开空窗。
test('奖励面板实参：只把非空对象包成 {serverReward}', () => {
  const rr = { items: [{ itemId: 47007004, itemCount: 3 }], resource: {} };
  assert.deepEqual(rewardPanelArgs(rr), { serverReward: rr });
  assert.equal(rewardPanelArgs({}), null);
  assert.equal(rewardPanelArgs([]), null);
  assert.equal(rewardPanelArgs(null), null);
  assert.equal(rewardPanelArgs(undefined), null);
  assert.equal(rewardPanelArgs('47007004'), null);
});

// ── 融冰腿（2103）：冰缓存重建 / 消耗表求值 / 候选过滤（从 cq26-feast 迁来）──────
test('阶段常量：GATHER=1（融冰腿只在集结期发 2103，比真人保守）', () => {
  assert.equal(PHASE_GATHER, 1);
});

test('ingestIceList：upsert + level=0 删格 + k 取 body 顶层 + 缓存存标量副本', () => {
  const row = iceRow(46, 144);
  const into = Object.create(null);
  assert.equal(ingestIceList([row], 14002212, into, NOW_MS), 1);
  assert.deepEqual(into['46_144'], {
    x: 46,
    y: 144,
    k: 14002212,
    level: 3,
    specIndex: 0,
    initSid: SID,
    atMs: NOW_MS,
  });
  // 报文对象池化复用：原行被下一条报文刷掉后，缓存仍须是本条的值
  row.level = 9;
  row.specIndex = 7;
  assert.equal(into['46_144'].level, 3);
  assert.equal(into['46_144'].specIndex, 0);
  // 10018 增量：level=0 = 已融 → 删格（双保险，2103 成功也会本地删）
  assert.equal(ingestIceList([iceRow(46, 144, { level: 0 })], 14002212, into, NOW_MS + 1), 1);
  assert.equal(into['46_144'], undefined);
  // 删不存在的格不计变更
  assert.equal(ingestIceList([iceRow(99, 99, { level: 0 })], 0, into, NOW_MS), 0);
});

test('iceCost：逐等级消耗表求值（level 从 1 起），缺表/越界/非数值回 null 不得按 0 白送', () => {
  const table = [1, 2, 3];
  assert.equal(iceCost(table, 1), 1);
  assert.equal(iceCost(table, 3), 3);
  assert.equal(iceCost(table, 0), null);
  assert.equal(iceCost(table, 4), null);
  assert.equal(iceCost(null, 1), null);
  assert.equal(iceCost(['x'], 1), null);
  assert.equal(iceCost([0], 1), 0, '0 消耗是合法配置（免费冰）');
});

test('pickIce：闸序 not-bwl > other-server > stale > cooling > blacklisted > no-cost-cfg > no-fire', () => {
  const tiles = iceMap([
    iceRow(1, 1, { level: 1 }),
    iceRow(2, 2, { specIndex: 1 }), // NWL 冰归别处
    iceRow(3, 3, { initSid: 4178 }), // 外服
    iceRow(4, 4, { level: 9 }), // 消耗表越界
  ]);
  // 单独造陈旧格（ingest 时刻早于 TTL）
  ingestIceList([iceRow(5, 5, { level: 1 })], 0, tiles, NOW_MS - ICE_TTL_MS - 1);
  const picked = pickIce(tiles, {
    costTable: [1, 2, 3],
    fireAmount: 10,
    originSid: SID,
    now: NOW_MS,
    coolUntil: { 'i:6_6': NOW_MS + 60000 },
    rejectCount: { 'i:7_7': MAX_REJECT },
  });
  // 6_6/7_7 没灌地块，补上才能走到冷却/拉黑闸
  ingestIceList([iceRow(6, 6, { level: 1 }), iceRow(7, 7, { level: 1 })], 0, tiles, NOW_MS);
  const p2 = pickIce(tiles, {
    costTable: [1, 2, 3],
    fireAmount: 10,
    originSid: SID,
    now: NOW_MS,
    coolUntil: { 'i:6_6': NOW_MS + 60000 },
    rejectCount: { 'i:7_7': MAX_REJECT },
  });
  assert.deepEqual(
    p2.ready.map((c) => c.key),
    ['1_1'],
  );
  const reasons = Object.fromEntries(p2.blocked.map((b) => [b.key, b.reason]));
  assert.equal(reasons['2_2'], 'not-bwl');
  assert.equal(reasons['3_3'], 'other-server');
  assert.equal(reasons['4_4'], 'no-cost-cfg');
  assert.equal(reasons['5_5'], 'stale');
  assert.equal(reasons['6_6'], 'cooling');
  assert.equal(reasons['7_7'], 'blacklisted');
  assert.equal(picked.ready.length, 1, '冷却/拉黑键对应的格不在场时不影响其它候选');
});

test('pickIce：level 升序（先便宜）+ 火种预算边界（>= cost 才发）', () => {
  const tiles = iceMap([
    iceRow(46, 144, { level: 3 }),
    iceRow(47, 145, { level: 1 }),
    iceRow(48, 146, { level: 2 }),
  ]);
  const g = { costTable: [1, 2, 3], originSid: SID, now: NOW_MS };
  const rich = pickIce(tiles, { ...g, fireAmount: 6 });
  assert.deepEqual(
    rich.ready.map((c) => c.level),
    [1, 2, 3],
  );
  assert.deepEqual(
    rich.ready.map((c) => c.cost),
    [1, 2, 3],
  );
  const poor = pickIce(tiles, { ...g, fireAmount: 2 });
  assert.deepEqual(
    poor.ready.map((c) => c.level),
    [1, 2],
    'lv3 要 3 个火种，只有 2 个 → no-fire',
  );
  assert.deepEqual(poor.blocked, [{ key: '46_144', reason: 'no-fire' }]);
  const exact = pickIce(tiles, { ...g, fireAmount: 1 });
  assert.deepEqual(
    exact.ready.map((c) => c.level),
    [1],
    '预算恰等于消耗仍发（闭区间）',
  );
});
