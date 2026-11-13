// cq26-feast（CQ26 巨兽盛宴三腿）纯函数单测：GATHER/FEED 阶段常量、
//   礼盒 claimed 合并、巨熊宝藏 endtime 到点即抢（grace=0）判定与 Int64 读侧往返、宝箱双拼写/三态分类/22072 额度回抵、日界键。
// 全部断言不发包、不摸游戏符号——feat 模块 import 链会触到浏览器全局，
// 故先最小桩化 window/document/chrome，再动态 import 取导出纯函数（同 cq26-wl-chest 口径）。
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

const mod = await import('../../extension/src/feats/cq26/feast.js');
const {
  mergeClaimed,
  pickGiftIndex,
  readGiftId,
  secretReady,
  pickSecrets,
  buildSecretTable,
  ingestSecretTiles,
  secretRewardHit,
  filterSecretsByItems,
  ingestChestTiles,
  chestBlockReason,
  pickBwlChests,
  reconcileQuota,
  cancelQuotaDebt,
  needOptimisticDeduct,
  PHASE_GATHER,
  PHASE_FEED,
  GIFT_COUNT,
  SECRET_GRACE_SEC,
  SECRET_TTL_SEC,
  TILE_TTL_MS,
  MAX_REJECT,
  POINT_TYPE_CHEST,
  POINT_TYPE_SECRET,
  SECRET_REWARD_IDS,
  GIFT_FEED_TTL_MS,
  GIFT_BUSY_BACKOFF_MS,
  ERR_BEAST_BUSY,
  REJECT_COOL_MS,
  giftGateWait,
} = mod;
// util.js 是零 import 叶子；日界滚清（rolloverState）的键就是 todayStr(服务器秒)
const { todayStr } = await import('../../extension/src/core/util.js');

// 实录 fixtures：dashcam rec 11981629951662 / dashcam-rec-20261109T205818-印石-我的日常.ndjson
//   22064 首份巨熊宝藏快照行 id={_low:-400693247,_high:1146129226} endtime=1794234712；
//   2108 首发 req id={_low:1612572678,_high:1146129367}。十进制串由 BigInt 无精度拼装独立算出。
const GIFT_ID = { lo: -400693247, hi: 1146129226, dec: '4922587546554066945' };
const SEC_ID = { lo: 1612572678, hi: 1146129367, dec: '4922588149862754310' };
const END = 1794234712; // 实录巨熊宝藏 endtime（服务器秒）
const NOW_SEC = END;
const NOW_MS = NOW_SEC * 1000;
const SID = 3828; // 实录老家服号（iceList/315 行 initSid）

/** 造一条 315 宝箱地块行（BWL 线 specIndex=0；m 形态照抄实录 315 行） */
function tileRow(x, y, m) {
  return {
    v: 37,
    x,
    y,
    k: 14002212,
    pointType: POINT_TYPE_CHEST,
    m: Object.assign(
      { itemId: 52082702, expireTime: NOW_SEC + 40000, specIndex: 0, leftTimes: 3, initSid: SID },
      m || {},
    ),
  };
}

/** 把 315 行灌成地块缓存 */
function tileMap(rows, atMs = NOW_MS) {
  const into = Object.create(null);
  ingestChestTiles(rows, into, atMs);
  return into;
}

/** 造一条 310 巨熊宝藏地块行（m.id 与 22064 gift.id 同源；rewardItemId 默认 52082911） */
function secretTileRow(x, y, m) {
  return {
    v: 1794234691,
    x,
    y,
    k: 14002212,
    pointType: POINT_TYPE_SECRET,
    m: Object.assign(
      {
        id: { _low: GIFT_ID.lo, _high: GIFT_ID.hi, _unsigned: false },
        rewardItemId: 52082911,
        endTime: END,
        curPower: 10,
        maxPower: 10,
        initSid: SID,
      },
      m || {},
    ),
  };
}

// ── 阶段常量 ────────────────────────────────────────────────────────
test('阶段常量：GATHER=1 / FEED=2（源码 CQ26BeastFeastPhase 枚举；礼盒只认 FEED，GATHER 是 cycleRun 活跃档判据）', () => {
  assert.equal(PHASE_GATHER, 1);
  assert.equal(PHASE_FEED, 2);
});

// ── 腿 1：盛宴礼盒 ────────────────────────────────────────────────────
test('mergeClaimed：权威 ∪ 乐观（Set/数组/null 都吃），不改入参、非数值过滤', () => {
  const auth = new Set([0, 1]);
  const opt = [2, 'x', 3];
  const merged = mergeClaimed(auth, opt);
  assert.deepEqual([...merged].sort(), [0, 1, 2, 3]);
  assert.equal(auth.size, 2, '入参权威集不被改');
  assert.deepEqual(mergeClaimed(null, [5]), new Set([5]));
  assert.deepEqual(mergeClaimed([1], null), new Set([1]));
  assert.deepEqual(mergeClaimed(null, null), new Set());
});

test('pickGiftIndex：0..9 首个未领；全领回 -1（GIFT_COUNT=10 与实录 claimedIndexList 满集互证）', () => {
  assert.equal(GIFT_COUNT, 10);
  assert.equal(pickGiftIndex(new Set()), 0);
  assert.equal(pickGiftIndex(new Set([0, 1, 2])), 3);
  assert.equal(pickGiftIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]), 9);
  assert.equal(pickGiftIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), -1);
});

// ── 腿 2：巨熊宝藏 ────────────────────────────────────────────────────
test('readGiftId：裸 {_low,_high} 实录 id 解出十进制串（负 _low 补回 2^32，BigInt 不经 Number）', () => {
  for (const r of [GIFT_ID, SEC_ID]) {
    const row = { id: { _low: r.lo, _high: r.hi, _unsigned: false } };
    assert.equal(readGiftId(row), r.dec, `low=${r.lo} high=${r.hi}`);
  }
});

test('readGiftId：Long 实例（toString/toNumber）与十进制串原样收下', () => {
  const longLike = { toString: () => GIFT_ID.dec, toNumber: () => Number(GIFT_ID.dec) };
  assert.equal(readGiftId({ id: longLike }), GIFT_ID.dec);
  assert.equal(readGiftId({ id: SEC_ID.dec }), SEC_ID.dec);
});

test('readGiftId：0 / 缺 id / 形态异常一律回空串（不代领）', () => {
  assert.equal(readGiftId({ id: 0 }), '');
  assert.equal(readGiftId({ id: '0' }), '');
  assert.equal(readGiftId({ id: { _low: 0, _high: 0 } }), '');
  assert.equal(readGiftId({}), '');
  assert.equal(readGiftId(null), '');
  assert.equal(readGiftId('text'), '');
});

test('secretReady：endtime 到点即抢（grace=0）、endtime+600s TTL 闭区间截止', () => {
  const g = { endtime: END };
  assert.equal(
    secretReady(g, END + SECRET_GRACE_SEC - 1),
    false,
    '早 1s 不发（endtime≤now 才可领，与游戏闸同口径）',
  );
  assert.equal(secretReady(g, END + SECRET_GRACE_SEC), true, '到点即抢');
  assert.equal(secretReady(g, END + SECRET_TTL_SEC), true, 'TTL 边界上仍发');
  assert.equal(secretReady(g, END + SECRET_TTL_SEC + 1), false, '过期不再尝试');
  assert.equal(secretReady({ endtime: 0 }, END), false);
  assert.equal(secretReady(g, 0), false, '服务器秒不可得无从判定');
  assert.equal(secretReady(null, END), false);
});

test('pickSecrets：endtime 升序先到先领；已领/未熟/过期不入队', () => {
  const mk = (dec, endtime) => ({ idStr: dec, endtime, x: 111, y: 107, k: 14002212 });
  const gifts = new Map([
    [GIFT_ID.dec, mk(GIFT_ID.dec, END)],
    [SEC_ID.dec, mk(SEC_ID.dec, END - 30)], // 更早到点 → 排队头
    ['999', mk('999', END + 100)], // 未熟（grace=0：now=END < endtime=END+100）
    ['888', mk('888', END - SECRET_TTL_SEC - 10)], // 过期
  ]);
  const ready = pickSecrets(gifts, { nowSec: END + SECRET_GRACE_SEC, claimed: new Set() });
  assert.deepEqual(
    ready.map((r) => r.idStr),
    [SEC_ID.dec, GIFT_ID.dec],
  );
  const claimed = pickSecrets(gifts, {
    nowSec: END + SECRET_GRACE_SEC,
    claimed: new Set([SEC_ID.dec]),
  });
  assert.deepEqual(
    claimed.map((r) => r.idStr),
    [GIFT_ID.dec],
    '乐观已领集挡下重发',
  );
});

test('buildSecretTable：整体替换=权威（空快照清表，不保留已抢空条目）', () => {
  // 实证：巨熊宝藏 10 槽共享，槽满即从 22064 清除；整体替换与游戏 updateSecretGiftList 一致。
  const rows = [
    { id: GIFT_ID.dec, pos: { x: 112, y: 116, k: 14002212 }, endtime: END },
    { id: SEC_ID.dec, pos: { x: 95, y: 121, k: 14002212 }, endtime: END - 30 },
  ];
  const t = buildSecretTable(rows, NOW_MS);
  assert.equal(t.size, 2);
  assert.equal(t.get(GIFT_ID.dec).endtime, END);
  assert.equal(t.get(GIFT_ID.dec).x, 112, 'pos.x 解出');
  assert.equal(t.get(SEC_ID.dec).endtime, END - 30);
  // 空快照 → 空表（槽满清除后不保留，避免对已抢空礼物空发 s=3）
  assert.equal(buildSecretTable([], NOW_MS).size, 0);
  // 到点即可领（grace=0，now=END），endtime 升序
  const ready = pickSecrets(t, { nowSec: END, claimed: new Set() });
  assert.deepEqual(
    ready.map((r) => r.idStr),
    [SEC_ID.dec, GIFT_ID.dec],
    '到点即抢，先到先领',
  );
});

test('buildSecretTable：纯 22064 全局发现即可到点领（无需 310 视口地块）', () => {
  // 用户诉求：大世界也能领。22064 全局推送（游戏世界图标同源），候选不依赖 310 视口地块。
  const t = buildSecretTable(
    [{ id: SEC_ID.dec, pos: { x: 95, y: 121, k: 14002212 }, endtime: END }],
    NOW_MS,
  );
  // 无任何 310 地块，到点（grace=0）仍入可领队列
  const ready = pickSecrets(t, { nowSec: END, claimed: new Set() });
  assert.deepEqual(
    ready.map((r) => r.idStr),
    [SEC_ID.dec],
  );
  // 白名单为空时 filterSecretsByItems 原样放行（不查地块）
  const filtered = filterSecretsByItems(ready, {}, () => [], []);
  assert.deepEqual(
    filtered.kept.map((r) => r.idStr),
    [SEC_ID.dec],
    '空白名单=全领，不需地块',
  );
});

test('buildSecretTable：非法行跳过（无 id / id=0），Int64 对象与十进制串都吃，空入参回空表', () => {
  const rows = [
    {
      id: { _low: GIFT_ID.lo, _high: GIFT_ID.hi, _unsigned: false },
      pos: { x: 1, y: 2, k: 3 },
      endtime: END,
    },
    { id: 0, pos: {}, endtime: END }, // 非法 id
    { id: '0', pos: {}, endtime: END }, // 非法 id
    { pos: {}, endtime: END }, // 缺 id
    { id: SEC_ID.dec, pos: { x: 9, y: 9, k: 3 }, endtime: END }, // 十进制串
  ];
  const t = buildSecretTable(rows, NOW_MS);
  assert.deepEqual(Array.from(t.keys()).sort(), [GIFT_ID.dec, SEC_ID.dec].sort());
  assert.equal(t.get(GIFT_ID.dec).x, 1, 'Int64 对象 id 解出十进制串');
  assert.equal(buildSecretTable(null, NOW_MS).size, 0);
  assert.equal(buildSecretTable(undefined, NOW_MS).size, 0);
});

// ── 腿 2 扩展：巨熊宝藏物品白名单（310 地块关联 + 过滤纯函数）──────────
test('巨熊宝藏常量：POINT_TYPE_SECRET=310 / SECRET_REWARD_IDS 实录 5 种礼包全集', () => {
  assert.equal(POINT_TYPE_SECRET, 310);
  assert.deepEqual(SECRET_REWARD_IDS, [52082911, 52082912, 52082913, 52082914, 52082915]);
});

test('beast_busy 拒因键 + 退避/投喂常量口径（退避 < 长冷却，否则复发「领一个就罢工」）', () => {
  // 实录 header.d 拒因键（dashcam-rec-20261113T223416 idx=2 s=3）
  assert.equal(ERR_BEAST_BUSY, 'series_frost_feast_tips_beast_busy');
  assert.ok(GIFT_BUSY_BACKOFF_MS > 0 && GIFT_BUSY_BACKOFF_MS < REJECT_COOL_MS);
  assert.ok(GIFT_FEED_TTL_MS > GIFT_BUSY_BACKOFF_MS);
});

test('giftGateWait：投喂中（feedCount 未超基线）等、超基线即放行、TTL fail-open、beast_busy 退避', () => {
  const T = 1000000;
  // 空闲：无投喂闸、无退避 → 可领
  assert.equal(giftGateWait(T, false, 0, 0, 0, 0), '');
  // 投喂中：feedCount==base 且 TTL 内 → 等（刚领完巨兽在吃，硬发会弹「忙碌中」）
  assert.equal(giftGateWait(T, true, T - 5000, 3, 3, 0), 'feeding');
  // 投喂完成：feedCount 超基线 → 立即放行（即便仍在 TTL 内，状态信号优先）
  assert.equal(giftGateWait(T, true, T - 5000, 4, 3, 0), '');
  // TTL fail-open：feedCount 未超基线但超 GIFT_FEED_TTL_MS（推送丢）→ 放行再试
  assert.equal(giftGateWait(T, true, T - GIFT_FEED_TTL_MS - 1, 3, 3, 0), '');
  // beast_busy 退避中（无投喂闸）→ 等
  assert.equal(giftGateWait(T, false, 0, 0, 0, T + 5000), 'backoff');
  // 退避到期 → 可领
  assert.equal(giftGateWait(T, false, 0, 0, 0, T - 1), '');
  // 投喂闸优先于退避：投喂中即便退避到期仍等 feedCount
  assert.equal(giftGateWait(T, true, T - 5000, 3, 3, T - 1), 'feeding');
});

test('ingestSecretTiles：键=idStr（与 22064 gift.id 同源）+ 标量副本 + 非310/非正rewardItemId/缺id 跳过', () => {
  const into = Object.create(null);
  const row = secretTileRow(111, 107);
  const n = ingestSecretTiles(
    [
      row,
      { x: 1, y: 1, pointType: POINT_TYPE_CHEST, m: { id: '5', rewardItemId: 52082911 } }, // 非 310
      secretTileRow(2, 2, { rewardItemId: 0 }), // rewardItemId 非正
      { x: 3, y: 3, pointType: POINT_TYPE_SECRET }, // 无 m
      secretTileRow(4, 4, { id: null }), // 无 id
    ],
    into,
    NOW_MS,
  );
  assert.equal(n, 1);
  assert.deepEqual(into[GIFT_ID.dec], {
    idStr: GIFT_ID.dec,
    rewardItemId: 52082911,
    endTime: END,
    x: 111,
    y: 107,
    k: 14002212,
    atMs: NOW_MS,
  });
  // 关联键一致性：22064 gift 行读出的 idStr === 310 地块缓存键
  assert.equal(readGiftId({ id: { _low: GIFT_ID.lo, _high: GIFT_ID.hi } }), GIFT_ID.dec);
  // 标量副本：池化报文被下一条刷掉后缓存仍须是本条的值
  row.m.rewardItemId = 999;
  assert.equal(into[GIFT_ID.dec].rewardItemId, 52082911);
});

test('secretRewardHit：按 .id 匹配（任一命中即 true）；空白名单/不命中/非数组恒 false', () => {
  const items = [{ id: 47007005 }, { id: 47007023 }, { id: 38006601 }];
  assert.equal(secretRewardHit(items, new Set([47007023])), true);
  assert.equal(secretRewardHit(items, new Set([999])), false);
  assert.equal(secretRewardHit(items, new Set()), false, '空白名单恒 false（全领由调用方早退）');
  assert.equal(secretRewardHit(items, null), false);
  assert.equal(secretRewardHit(null, new Set([47007005])), false);
  assert.equal(secretRewardHit([], new Set([47007005])), false);
});

test('filterSecretsByItems：空白名单=全领（kept 原样、skipped 空，返回新数组不共享引用）', () => {
  const ready = [{ idStr: 'a' }, { idStr: 'b' }];
  const r = filterSecretsByItems(ready, {}, () => [], []);
  assert.deepEqual(r.kept, ready);
  assert.deepEqual(r.skipped, []);
  assert.notEqual(r.kept, ready);
});

test('filterSecretsByItems：非空三态 fail-closed（no-tile/no-resolve/no-hit）+ 命中保留 + 保持入参序', () => {
  // 实录物品组：52082911→{47007005,47007023,38006601}；52082915→{1700403,1700402,801040}
  const resolve = (rid) =>
    ({
      52082911: [{ id: 47007005 }, { id: 47007023 }, { id: 38006601 }],
      52082915: [{ id: 1700403 }, { id: 1700402 }, { id: 801040 }],
    })[rid] || [];
  const tiles = {
    hit: { rewardItemId: 52082911 }, // 含 47007005 → kept
    miss: { rewardItemId: 52082915 }, // 不含 → no-hit
    empty: { rewardItemId: 999 }, // resolve [] → no-resolve
  };
  const ready = [
    { idStr: 'hit', endtime: 2 },
    { idStr: 'miss', endtime: 1 },
    { idStr: 'empty', endtime: 3 },
    { idStr: 'absent', endtime: 4 }, // 无地块 → no-tile
  ];
  const r = filterSecretsByItems(ready, tiles, resolve, [47007005]);
  assert.deepEqual(
    r.kept.map((g) => g.idStr),
    ['hit'],
  );
  assert.deepEqual(r.skipped, [
    { idStr: 'miss', reason: 'no-hit' },
    { idStr: 'empty', reason: 'no-resolve' },
    { idStr: 'absent', reason: 'no-tile' },
  ]);
});

test('filterSecretsByItems：Map 地块缓存与 Set 白名单都吃（与对象/数组入参同口径）', () => {
  const tiles = new Map([['a', { rewardItemId: 52082911 }]]);
  const r = filterSecretsByItems(
    [{ idStr: 'a' }],
    tiles,
    () => [{ id: 47007005 }],
    new Set([47007005]),
  );
  assert.deepEqual(
    r.kept.map((g) => g.idStr),
    ['a'],
  );
});

test('端到端：22064 快照 + 310 地块按 idStr 关联 → pickSecrets → 白名单只留含目标物品的巨熊宝藏', () => {
  const gifts = new Map([
    [GIFT_ID.dec, { idStr: GIFT_ID.dec, endtime: END, x: 111, y: 107, k: 14002212 }],
    [SEC_ID.dec, { idStr: SEC_ID.dec, endtime: END, x: 112, y: 108, k: 14002212 }],
  ]);
  const tiles = Object.create(null);
  ingestSecretTiles(
    [
      secretTileRow(111, 107), // id=GIFT_ID → 52082911（含 47007005）
      secretTileRow(112, 108, {
        id: { _low: SEC_ID.lo, _high: SEC_ID.hi },
        rewardItemId: 52082915, // 不含 47007005
      }),
    ],
    tiles,
    NOW_MS,
  );
  const resolve = (rid) => (rid === 52082911 ? [{ id: 47007005 }] : [{ id: 1700403 }]);
  const ready = pickSecrets(gifts, { nowSec: END + SECRET_GRACE_SEC, claimed: new Set() });
  assert.equal(ready.length, 2, '两枚都到点');
  const r = filterSecretsByItems(ready, tiles, resolve, [47007005]);
  assert.deepEqual(
    r.kept.map((g) => g.idStr),
    [GIFT_ID.dec],
  );
  assert.deepEqual(r.skipped, [{ idStr: SEC_ID.dec, reason: 'no-hit' }]);
});

// ── 腿 3：奖励宝箱 ────────────────────────────────────────────────────
test('ingestChestTiles：leftTimes 优先 + lefftTimes 防御回落（实证拼写为 leftTimes，回落未见于本录/源码）', () => {
  const into = Object.create(null);
  const n = ingestChestTiles(
    [
      tileRow(1, 1, { leftTimes: undefined, lefftTimes: 7 }),
      tileRow(2, 2, { leftTimes: 3, lefftTimes: 9 }),
      { x: 3, y: 3, pointType: 316, m: { specIndex: 0 } }, // 非 315 跳过
      { x: 4, y: 4, pointType: POINT_TYPE_CHEST }, // 无 m 跳过
    ],
    into,
    NOW_MS,
  );
  assert.equal(n, 2);
  assert.equal(into['1_1'].leftTimes, 7, '只有回落拼写时取 lefftTimes');
  assert.equal(into['2_2'].leftTimes, 3, '两拼写并存时正确拼写优先');
});

test('ingestChestTiles：specIndex 缺失记 -1（缺失≠0，0 才是 BWL 线）+ 标量副本', () => {
  const row = tileRow(350, 216);
  delete row.m.specIndex;
  const into = Object.create(null);
  ingestChestTiles([row], into, NOW_MS);
  assert.equal(into['350_216'].specIndex, -1);
  row.m.leftTimes = 0;
  assert.equal(into['350_216'].leftTimes, 3, '缓存是副本，不被池化报文刷掉');
});

test('chestBlockReason：not-bwl / used-up / expired / other-server；时刻/归属不可得不判对应闸', () => {
  const ok = { specIndex: 0, leftTimes: 3, expireTime: NOW_SEC + 1000, initSid: SID };
  assert.equal(chestBlockReason(ok, NOW_SEC, SID), null);
  assert.equal(
    chestBlockReason({ ...ok, specIndex: 5 }, NOW_SEC, SID),
    'not-bwl',
    'NWL 分区归 wl-chest',
  );
  assert.equal(chestBlockReason({ ...ok, specIndex: -1 }, NOW_SEC, SID), 'not-bwl', '缺失不敢猜线');
  assert.equal(chestBlockReason({ ...ok, leftTimes: 0 }, NOW_SEC, SID), 'used-up');
  assert.equal(chestBlockReason({ ...ok, expireTime: NOW_SEC - 1 }, NOW_SEC, SID), 'expired');
  assert.equal(chestBlockReason({ ...ok, initSid: 4178 }, NOW_SEC, SID), 'other-server');
  assert.equal(chestBlockReason({ ...ok, expireTime: 1 }, 0, SID), null, '服务器秒不可得不判过期');
  assert.equal(
    chestBlockReason({ ...ok, initSid: 4178 }, NOW_SEC, null),
    null,
    '老家服不可得不判归属',
  );
});

test('pickBwlChests：ready/unknown/blocked 三态；已开去重；NWL 不入视野；最早过期优先', () => {
  const tiles = tileMap([
    tileRow(1, 1, { expireTime: NOW_SEC + 2000 }),
    tileRow(2, 2, { leftTimes: 0 }),
    tileRow(3, 3), // 已开 → 整颗跳过
    tileRow(4, 4), // 冷却
    tileRow(5, 5), // 拉黑
    tileRow(7, 7, { specIndex: 5 }), // NWL → 不入任何桶
    tileRow(8, 8, { expireTime: NOW_SEC - 1 }),
    tileRow(9, 9, { expireTime: NOW_SEC + 1000 }), // 比 1_1 更早过期 → 队头
  ]);
  ingestChestTiles([tileRow(6, 6)], tiles, NOW_MS - TILE_TTL_MS - 1); // 陈旧 → unknown
  const picked = pickBwlChests(tiles, {
    opened: new Set(['3_3']),
    nowSec: NOW_SEC,
    now: NOW_MS,
    coolUntil: { 'c:4_4': NOW_MS + 60000 },
    rejectCount: { 'c:5_5': MAX_REJECT },
    originSid: SID,
  });
  assert.deepEqual(
    picked.ready.map((c) => c.key),
    ['9_9', '1_1'],
    '最早过期优先',
  );
  assert.deepEqual(
    picked.unknown.map((c) => c.key),
    ['6_6'],
    '地块过期 → 定向 901 重验',
  );
  assert.deepEqual(picked.blocked, [
    { key: '2_2', reason: 'used-up' },
    { key: '4_4', reason: 'cooling' },
    { key: '5_5', reason: 'blacklisted' },
    { key: '8_8', reason: 'expired' },
  ]);
});

// ── 额度乐观口径（与 wl-chest 同款纯函数，BWL/NWL 共享 remainChestNum）──
test('reconcileQuota：只往收紧方向偏，且永不小于 0', () => {
  assert.equal(reconcileQuota(5, 0), 5);
  assert.equal(reconcileQuota(5, 3), 2);
  assert.equal(reconcileQuota(5, 9), 0);
  assert.equal(reconcileQuota(0, 2), 0);
});

/**
 * 复刻一天的开奖励宝箱账本：每颗走「出网 → 22072 额度推送到货 → 应答结算」三步（照抄 wl-chest 单测口径）。
 * @param {object} o 口径开关
 * @param {boolean} o.pushBeforeAck 额度推送是否在应答之前到货
 * @param {boolean} o.unconditionalDeduct 结算时是否无条件 +1（旧写法反证）
 * @param {number} [o.limit] 今日额度
 * @returns {{opened:number, snap:number, spent:number}}
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
    if (reconcileQuota(snap, spent) <= 0) break;
    const snapAtSend = snap;
    if (pushBeforeAck) onPush();
    const ackSnap = snap;
    if (unconditionalDeduct || needOptimisticDeduct(snapAtSend, ackSnap)) spent++;
    opened++;
    if (!pushBeforeAck) onPush();
  }
  return { opened, snap, spent };
}

test('22072 抢在应答前（实录形状）：五颗额度就开五颗，不留在途陈账', () => {
  assert.deepEqual(runQuotaLedger({ pushBeforeAck: true, unconditionalDeduct: false }), {
    opened: 5,
    snap: 0,
    spent: 0,
  });
});

test('应答先于 22072（慢推送）：乐观账盖住在途那一窗，结果不变', () => {
  assert.deepEqual(runQuotaLedger({ pushBeforeAck: false, unconditionalDeduct: false }), {
    opened: 5,
    snap: 0,
    spent: 0,
  });
});

test('反证（旧写法）：无条件 +1 会卡在 snap=1/spent=1，第 5 颗永远开不掉', () => {
  assert.deepEqual(runQuotaLedger({ pushBeforeAck: true, unconditionalDeduct: true }), {
    opened: 4,
    snap: 1,
    spent: 1,
  });
});

test('cancelQuotaDebt：按增量回抵；持平不清账、首条清账、回升作废、缺字段不动账', () => {
  assert.equal(cancelQuotaDebt(1, 4, 4), 1);
  assert.equal(cancelQuotaDebt(1, 4, 3), 0);
  assert.equal(cancelQuotaDebt(2, 4, 3), 1);
  assert.equal(cancelQuotaDebt(3, 4, 2), 1);
  assert.equal(cancelQuotaDebt(1, 4, 5), 0);
  assert.equal(cancelQuotaDebt(0, 4, 3), 0);
  assert.equal(cancelQuotaDebt(1, null, 4), 0);
  assert.equal(cancelQuotaDebt(1, 4, null), 1);
});

test('needOptimisticDeduct：只有快照未动（或不可得）才记乐观账', () => {
  assert.equal(needOptimisticDeduct(5, 4), false);
  assert.equal(needOptimisticDeduct(5, 5), true);
  assert.equal(needOptimisticDeduct(5, 6), true);
  assert.equal(needOptimisticDeduct(5, null), true);
  assert.equal(needOptimisticDeduct(null, 5), true);
});

// ── 日界滚清 ──────────────────────────────────────────────────────────
test('日界键（rolloverState 的判据）：同日同键、跨本地午夜换键（拉黑/乐观集「当日」语义的根）', () => {
  const t = 1794234712; // 实录时刻
  assert.equal(todayStr(t), todayStr(t + 60), '同一服务器日内键不变');
  const d = new Date(t * 1000);
  const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000;
  assert.notEqual(todayStr(t), todayStr(nextMidnight + 60), '跨午夜必须换键（触发滚清）');
  assert.equal(todayStr(nextMidnight + 60), todayStr(nextMidnight + 3600), '新日内键稳定');
});
