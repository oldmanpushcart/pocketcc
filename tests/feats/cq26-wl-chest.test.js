// cq26-wl-chest（CQ26 遗失之箱）纯函数单测：icon 判据三态、候选过滤序、分区号只认地块（含 2120 冲突回归）、
// 额度乐观口径。全部断言的是「开哪一颗、用哪个 wastelandIndex」，不发包、不摸游戏符号——feat 模块 import
// 链会触到浏览器全局，故先最小桩化 window/document/chrome，再动态 import 取导出纯函数（同 cq26-excav 口径）。
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

const mod = await import('../../extension/src/feats/cq26/wl-chest.js');
const { iconShow, reconcileQuota, pickChests, chestBlockReason, ingestChestTiles } = mod;
const { cancelQuotaDebt, needOptimisticDeduct, quotaText } = mod;

/** 服务器秒与 Date.now() 基准（固定值，判据全部显式传参，不靠墙钟） */
const NOW_SEC = 1793955600;
const NOW_MS = NOW_SEC * 1000;

/**
 * 造一条 901/10018 的 315 宝箱地块行（字段形态逐键照抄实录
 * dashcam/store/11981629951662/20261106T165849-印石-我的日常.ndjson 的 pointList 条目）。
 * @param {number} x
 * @param {number} y
 * @param {object} [m] extData 覆盖项
 * @returns {object} 报文行（**每次新造**：测试里会就地篡改它来验证「缓存存的是副本」）
 */
function tileRow(x, y, m) {
  return {
    v: 37,
    x: x,
    y: y,
    k: 14001012,
    pointType: 315,
    m: Object.assign(
      { itemId: 52082702, expireTime: NOW_SEC + 40000, specIndex: 5, leftTimes: 3, initSid: 3828 },
      m || {},
    ),
  };
}

/** pickChests 的默认闸门（只保留本组用例关心的那几项） */
function gates(extra) {
  return Object.assign(
    {
      now: NOW_MS,
      nowSec: NOW_SEC,
      tileTtlMs: 300000,
      opened: new Set(),
      coolUntil: {},
      rejectCount: {},
      originSid: 3828,
    },
    extra || {},
  );
}

/** 把若干报文行灌成地块缓存 */
function tileMap(rows) {
  const into = Object.create(null);
  ingestChestTiles(rows, into, NOW_MS);
  return into;
}

// ── icon 判据（源码 CQ26WLWorldUIRewardIcon.updateIconShow 的三态复刻）──
test('icon 判据：活动未开一律灭（哪怕本服且有快照）', () => {
  assert.equal(iconShow(false, 3828, 3828, 17), false);
});

test('icon 判据：本服图 + 快照非空 = 亮；快照空集 = 灭', () => {
  assert.equal(iconShow(true, 3828, 3828, 17), true);
  assert.equal(iconShow(true, 3828, 3828, 0), false);
});

test('icon 判据：OriginServerId!==ServerId（跨服态）= 灭，与快照无关', () => {
  assert.equal(iconShow(true, 3828, 30652, 17), false);
  assert.equal(iconShow(true, 3828, 30652, 0), false);
});

test('icon 判据：输入取不到时回 null（无从判定，调用方不得当「灭」）', () => {
  assert.equal(iconShow(true, null, 3828, 5), null);
  assert.equal(iconShow(true, 3828, 0, 5), null);
  assert.equal(iconShow(true, 3828, 3828, null), null);
});

// ── 分区号只认地块 ────────────────────────────────────────────────────
test('回归：2120 反查给 9、地块 specIndex 给 11 时，必须取 11（实录 20261108T111129）', () => {
  // 同场实录：`2120{wastelandIndex:9}` 的应答锚点 k=14002112，而该房间里 315 地块 specIndex=11；
  //   真人走进这格点「领取」，游戏发的是 2118{wastelandIndex:11,…} —— 取 9 必被服务器拒。
  const rows = [{ x: 639, y: 279, k: 14002112 }];
  const tiles = tileMap([tileRow(639, 279, { specIndex: 11 })]);
  const picked = pickChests(rows, gates({ tiles }));
  assert.equal(picked.ready.length, 1);
  assert.equal(picked.ready[0].idx, 11);
  assert.equal(picked.unknown.length, 0);
});

test('地块缺失 → 进 unknown（等定向 901 定号），绝不带 null idx 出网', () => {
  const picked = pickChests([{ x: 350, y: 216, k: 14001012 }], gates({ tiles: {} }));
  assert.equal(picked.ready.length, 0);
  assert.equal(picked.unknown.length, 1);
  assert.equal(picked.unknown[0].key, '350_216');
  assert.equal(picked.unknown[0].idx, null);
});

test('地块过期（TTL）→ 重新算 unknown，不拿陈旧 specIndex 出网', () => {
  const tiles = tileMap([tileRow(350, 216, { specIndex: 5 })]);
  const picked = pickChests(
    [{ x: 350, y: 216, k: 14001012 }],
    gates({ tiles, now: NOW_MS + 10 * 60 * 1000 }),
  );
  assert.equal(picked.ready.length, 0);
  assert.equal(picked.unknown.length, 1);
});

test('specIndex 缺失（-1）按「定不出号」处理，缺失≠0（0 是巨兽盛宴线）', () => {
  const rows = [{ x: 350, y: 216, k: 14001012 }];
  const noKey = Object.create(null);
  ingestChestTiles(
    [{ x: 350, y: 216, k: 14001012, pointType: 315, m: { leftTimes: 3 } }],
    noKey,
    NOW_MS,
  );
  assert.equal(noKey['350_216'].specIndex, -1);
  const p1 = pickChests(rows, gates({ tiles: noKey }));
  assert.equal(p1.ready.length, 0);
  assert.deepEqual(p1.blocked, [{ key: '350_216', reason: 'no-specindex' }]);
  // 显式 0 = BWL 巨兽盛宴线的箱子（游戏分叉到 2104）：本 feat 不接，当日跳过
  const p2 = pickChests(rows, gates({ tiles: tileMap([tileRow(350, 216, { specIndex: 0 })]) }));
  assert.deepEqual(p2.blocked, [{ key: '350_216', reason: 'bwl-line' }]);
});

// ── 逐点闸序（与游戏 refreshUI / onClickGetReward 的显示闸对齐）──────────
test('chestBlockReason：leftTimes<=0 / 已过期 / 外服归属 三类不可开', () => {
  const ok = { specIndex: 5, leftTimes: 3, expireTime: NOW_SEC + 1000, initSid: 3828 };
  assert.equal(chestBlockReason(ok, NOW_SEC, 3828), null);
  assert.equal(chestBlockReason({ ...ok, leftTimes: 0 }, NOW_SEC, 3828), 'used-up');
  assert.equal(chestBlockReason({ ...ok, expireTime: NOW_SEC - 1 }, NOW_SEC, 3828), 'expired');
  assert.equal(chestBlockReason({ ...ok, initSid: 4178 }, NOW_SEC, 3828), 'other-server');
  // 服务器秒/老家服取不到时**不判**对应闸（无从判定 ≠ 不可开）
  assert.equal(chestBlockReason({ ...ok, expireTime: 1 }, 0, 3828), null);
  assert.equal(chestBlockReason({ ...ok, initSid: 4178 }, NOW_SEC, null), null);
});

test('过滤序：已开 > 冷却 > 拉黑 > 地块闸 > unknown（同一颗只归一类）', () => {
  const tiles = tileMap([
    tileRow(1, 1),
    tileRow(2, 2, { leftTimes: 0 }),
    tileRow(3, 3),
    tileRow(4, 4),
    tileRow(5, 5),
  ]);
  const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ x: n, y: n, k: 14001012 }));
  const picked = pickChests(rows, {
    ...gates({ tiles }),
    opened: new Set(['1_1']),
    coolUntil: { '3_3': NOW_MS + 60000 },
    rejectCount: { '4_4': 3, '2_2': 3 },
    maxReject: 3,
  });
  assert.deepEqual(
    picked.ready.map((c) => c.key),
    ['5_5'],
    '只有 5_5 全闸通过',
  );
  assert.deepEqual(
    picked.unknown.map((c) => c.key),
    ['6_6'],
    '6_6 没地块 → 待定号',
  );
  assert.deepEqual(
    picked.blocked,
    [
      { key: '2_2', reason: 'blacklisted' },
      { key: '3_3', reason: 'cooling' },
      { key: '4_4', reason: 'blacklisted' },
    ],
    '2_2 的 leftTimes=0 不报名：拉黑/冷却闸排在地块闸之前（4_4 没地块也照样按拉黑归类）',
  );
});

test('同房间的点排在一起，一发定向 901 能顺带解掉同窗其它箱', () => {
  const rows = [
    { x: 380, y: 230, k: 14002212 },
    { x: 350, y: 216, k: 14001012 },
    { x: 356, y: 234, k: 14001012 },
    { x: 346, y: 204, k: 14001012 },
  ];
  const picked = pickChests(rows, gates({ tiles: {} }));
  assert.deepEqual(
    picked.unknown.map((c) => c.k),
    [14001012, 14001012, 14001012, 14002212],
  );
  assert.deepEqual(
    picked.unknown.map((c) => c.x),
    [346, 350, 356, 380],
    '房间内按 x 升序（与 22077 快照原序无关，稳定可复现）',
  );
});

// ── ingest ───────────────────────────────────────────────────────────
test('ingest 只认 315 行、跳过无 m 的行，且缓存里存的是标量副本', () => {
  const row = tileRow(346, 204);
  const into = Object.create(null);
  const n = ingestChestTiles(
    [row, { x: 1, y: 1, pointType: 316, m: { specIndex: 5 } }, { x: 2, y: 2, pointType: 315 }],
    into,
    NOW_MS,
  );
  assert.equal(n, 1);
  assert.deepEqual(Object.keys(into), ['346_204']);
  // 报文对象是池化复用的：下一条报文刷掉 m 之后，缓存仍须是本条的值
  row.m.specIndex = 999;
  row.m.leftTimes = 0;
  assert.equal(into['346_204'].specIndex, 5);
  assert.equal(into['346_204'].leftTimes, 3);
  assert.equal(into['346_204'].atMs, NOW_MS);
});

// ── 额度乐观口径 ─────────────────────────────────────────────────────
test('reconcileQuota：只往收紧方向偏，且永不小于 0', () => {
  assert.equal(reconcileQuota(5, 0), 5);
  assert.equal(reconcileQuota(5, 3), 2);
  assert.equal(reconcileQuota(5, 9), 0);
  assert.equal(reconcileQuota(0, 2), 0);
});

// ── 乐观额度账与报文序（实录 dashcam 20261108T172032：`2118 req → 22072(remain−1) → 22077 → 2118 resp`）──
/**
 * 复刻一天的开箱账本：每颗走「出网 → 额度推送到货 → 应答结算」三步，返回实际开成的颗数。
 * @param {object} o 口径开关
 * @param {boolean} o.pushBeforeAck 额度推送是否在应答**之前**到货（实录形状=true）
 * @param {boolean} o.unconditionalDeduct 结算时是否无条件 +1（旧写法）
 * @param {number} [o.limit] 今日额度
 * @returns {{opened:number, snap:number, spent:number}} 账本终态
 */
function runQuotaLedger({ pushBeforeAck, unconditionalDeduct, limit = 5 }) {
  let snap = limit;
  let prev = null;
  let spent = 0;
  let opened = 0;
  const onPush = () => {
    const next = snap - 1;
    spent = cancelQuotaDebt(spent, prev, next);
    prev = next;
    snap = next;
  };
  for (let i = 0; i < limit + 2; i++) {
    if (reconcileQuota(snap, spent) <= 0) break; // 额度闸（权威见底另走「睡到日界」，这里只考乐观闸）
    const snapAtSend = snap;
    if (pushBeforeAck) onPush(); // 实录形状：额度推送抢在应答前
    const ackSnap = snap;
    if (unconditionalDeduct || needOptimisticDeduct(snapAtSend, ackSnap)) spent++; // settleClaim
    opened++;
    if (!pushBeforeAck) onPush(); // 慢推送分支：应答之后额度快照才到货
  }
  return { opened, snap, spent };
}

test('额度推送抢在应答前（实录形状）：五颗额度就开五颗，不留在途陈账', () => {
  const r = runQuotaLedger({ pushBeforeAck: true, unconditionalDeduct: false });
  assert.deepEqual(r, { opened: 5, snap: 0, spent: 0 });
});

test('应答先于额度推送（慢推送）：乐观账盖住在途那一窗，结果不变', () => {
  const r = runQuotaLedger({ pushBeforeAck: false, unconditionalDeduct: false });
  assert.deepEqual(r, { opened: 5, snap: 0, spent: 0 });
});

test('反证（旧写法）：应答里无条件 +1 会卡在 snap=1/spent=1，第 5 颗永远开不掉', () => {
  // 日志实证 20261108T17：`optimistic quota 0 (snap=1 spent=1), wait next 22072` 从此每 20s 空转到日界，
  //   而 22072 只在额度真变化时才推 ⇒ 这条推送永无下文。面板表观：游戏里还剩 1 颗，面板却显示「已领 5/5」（乐观 -1 顶到底）。
  const r = runQuotaLedger({ pushBeforeAck: true, unconditionalDeduct: true });
  assert.deepEqual(r, { opened: 4, snap: 1, spent: 1 });
});

test('cancelQuotaDebt：按额度增量回抵，持平的推送不得清账（抹掉在途那笔就可能超发一条 2118）', () => {
  assert.equal(cancelQuotaDebt(1, 4, 4), 1); // 持平：这条推送不带额度信息 → 保留
  assert.equal(cancelQuotaDebt(1, 4, 3), 0); // 降一格 → 抵一笔
  assert.equal(cancelQuotaDebt(2, 4, 3), 1); // 降一格但有两笔在途 → 只抵一笔
  assert.equal(cancelQuotaDebt(3, 4, 2), 1); // 一笔推送抵两格
  assert.equal(cancelQuotaDebt(1, 4, 5), 0); // 额度回升（日界刷新）→ 乐观作废
  assert.equal(cancelQuotaDebt(0, 4, 3), 0); // 无账可抵也不会变负
  assert.equal(cancelQuotaDebt(1, null, 4), 0); // 本会话首条快照：无可比基线 → 按已对齐清账
  assert.equal(cancelQuotaDebt(1, 4, null), 1); // 载荷里没这个字段 → 不动账
});

test('needOptimisticDeduct：只有快照未动（或不可得）才记乐观账', () => {
  assert.equal(needOptimisticDeduct(5, 4), false); // 推送已抢跑（实录形状）→ 再扣就是扣两遍
  assert.equal(needOptimisticDeduct(5, 5), true); // 应答先到 → 需收紧
  assert.equal(needOptimisticDeduct(5, 6), true); // 日界刷新途中 → 保守收紧
  assert.equal(needOptimisticDeduct(5, null), true); // 投影不可得 → 保守收紧
  assert.equal(needOptimisticDeduct(null, 5), true);
});

test('quotaText：面板分子是「已领」不是「剩余」（旧写法 0/5 会被读成今日一颗没开）', () => {
  assert.equal(quotaText(5, 5), '已领 0/5'); // 刚过日界：一次没领
  assert.equal(quotaText(3, 5), '已领 2/5'); // 典型中间态
  assert.equal(quotaText(0, 5), '已领 5/5'); // 用光（含乐观顶到底）
  assert.equal(quotaText(-1, 5), '已领 5/5'); // 剩余额度不会为负，夹到上限
  assert.equal(quotaText(6, 5), '已领 0/5'); // 快照高于日限（配置中途调低）→ 不倒挂成负数
  assert.equal(quotaText(3, 0), '—'); // 日限配置读不到：没分母就不报进度
  assert.equal(quotaText(3, undefined), '—');
  assert.equal(quotaText(3, '5'), '已领 2/5'); // 配置以文本形态回来也要能算
});
