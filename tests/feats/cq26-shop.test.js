// cq26-shop（CQ26 霜之密所抢购）纯函数单测：候选全序与「游戏原式闸门 + 竞品下单序」等价（三轴：商品→所→cfg 行）、
// 商品身份=品种+数量（同 item_id+同 item_num 的多档位合成一行）、总数量列口径、五闸逐条过滤、
// canBuyCnt 语义（=已用）、面板「本轮已抢」文案口径、本地镜像收敛不重发、Int64 字符串往返、活动级 fail-closed 零发包、ACL 投影形态。
// feat 模块 import 链会触到浏览器全局，故先最小桩化 window/document/chrome，再动态 import 取导出纯函数
// （桩化范式同 cq26-excav / potion-craft）。
import { test, after } from 'node:test';
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

// core 链里的常驻 setInterval 只对测试 harness unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/cq26/shop.js');
const { buildCandidates, gatedPass, productStockSum } = mod;
const { quotaText } = mod;
const { gameData, l10n } = await import('../../extension/src/core/game-api.js');

/** CQ26 货架 cfg 空间（普通城 1–11 / 高级城 101–111；实测每所随机缺 1–2 件） */
const CFGS = [1, 2, 3, 4, 5, 6, 101, 102, 103];

// ── 夹具 ──────────────────────────────────────────────────────────────
/**
 * 造货架表行（gameData.cq26ShopRows 的产物形状）。
 * @param {number} cfg cfg id
 * @param {object} o 覆盖字段
 */
function row(cfg, o) {
  return Object.assign(
    {
      itemId: 820000 + cfg,
      num: 1,
      gold: 100,
      score: 0,
      limit: 2,
      limitAll: 40,
      order: cfg,
      level: 0,
    },
    o,
  );
}

/** 默认表行集合：普通城 1–6 需分 0/低门槛，高级城 101–103 需分高、更贵 */
function defaultRows() {
  const rows = {};
  for (const cfg of CFGS) {
    rows[String(cfg)] = row(cfg, cfg >= 101 ? { gold: 500, score: 200, limit: 1 } : {});
  }
  return rows;
}

/**
 * 造密所（projectShop 产物形状：已是同帧标量副本，idStr 为十进制串）。
 * @param {string} idStr 密所 id
 * @param {object} o 覆盖字段
 */
function shop(idStr, o) {
  return Object.assign(
    {
      idStr,
      sid: 1,
      cityId: 140094,
      cityLevelId: 403,
      level: 3,
      cityShowNum: 3001,
      status: 2,
      statusEndSec: 0,
      tax: 0,
      opened: true,
      canRevRedPack: false,
      buyCnt: {},
      selfBuyCnt: {},
      ownServer: false,
    },
    o,
  );
}

/**
 * 造快照（本地镜像形状）。
 * @param {Array<object>} shops
 * @param {object} o 覆盖字段
 */
function snap(shops, o) {
  return Object.assign({ shops, cScore: 1000, canBuyCnt: 0 }, o);
}

/**
 * 造面板视图（buildCandidates 的 panel 入参：闸门全部显式传参，不读模块态）。
 * 注：不再有 maxPerBurst——单次开市上限已废弃为「本期剩余额度」（与竞品B slice(0, 额度) 同形）。
 * @param {object} o 覆盖字段
 */
function panel(o) {
  return Object.assign(
    {
      goods: {},
      goodsOrder: [],
      quotaTotal: 5,
      dispatched: 0,
      cool: {},
      reject: {},
      now: 0,
    },
    o,
  );
}

/** 候选 → 可读串（断言与调试都用这个口径） */
const seq = (list) => list.map((c) => c.shopIdStr + ':' + c.cfgStr);

/**
 * 夹具 cfg → 商品键（与 shop.js 的 productKey 同式：品种+数量）。
 * 默认表行每个 cfg 一个独立 itemId、num=1，故商品与 cfg 一一对应；需要「同货多档」时另造行。
 * @param {number|string} cfg
 */
const pk = (cfg) => 'i' + (820000 + Number(cfg)) + 'x1';

// ── 参照实现：游戏原式（CQ25CNCShopMainNode.createToggleUI / CQ25CNCShopItem.onClickBuy）──
/**
 * 游戏显示序逐字翻回：本服优先（sid===UserData.ServerId）→ cnc_city_level.level 降 → Int64.compare 升。
 * 唯一刻意偏离：level 读不到（表缺 → 0）时退到 cityLevelId 降序，而不像游戏那样 `||1` 压平，
 * 目的是「未知档不给加权」；另有专例覆盖这条偏离。
 * @param {Array<object>} shops 快照所数组（不动原数组）
 */
function gameShopOrder(shops) {
  return shops.slice().sort((a, b) => {
    if (a.ownServer !== b.ownServer) return a.ownServer ? -1 : 1;
    const la = a.level || a.cityLevelId;
    const lb = b.level || b.cityLevelId;
    if (la !== lb) return lb - la;
    if (a.idStr.length !== b.idStr.length) return a.idStr.length - b.idStr.length;
    return a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0;
  });
}

/**
 * 参照下单序：外层**商品**优先级（品种+数量，下标即优先级）、中层游戏显示序、内层该商品在这一所的 cfg 行，
 * 逐件按**游戏原式**判闸。
 * 判据写成游戏源码的字面式（售罄=buy_limit_all−buyCnt、限购=selfBuyCnt<buy_limit、门槛=need_score≤cScore、
 *   营业态=status===2、货架真源=Object.keys(buyCnt)），字段名用投影后的驼峰（与表列一一对应）。
 * 商品索引同 shop.js 口径：itemId+item_num 相同即为同一商品（普通城/高级城各占一档时合成一行、共用勾选）。
 * 注：goods 只有勾选位 on——面板的「购买上限」输入已废弃，故此处也不读 g.max（残留值两侧都当看不见）。
 * @param {object} s 快照
 * @param {object} rows 表行
 * @param {object} p 面板视图
 * @param {number|null} goldAvail 钻石可用额
 * @param {number} quotaTotal 本轮总额度
 */
function referenceCandidates(s, rows, p, goldAvail, quotaTotal) {
  const out = [];
  const used = Number(s.canBuyCnt) || 0;
  const remain = quotaTotal - used; // 主面板 updateBuyCntUI：Math.max(Number(cfg) - canBuyCnt, 0)
  if (remain <= 0) return out;
  const cap = remain - p.dispatched; // 无独立「单次」旋钮：剩多少额度就能发多少包
  if (cap <= 0) return out;
  // 商品索引（cfg 升序枚举 → 同一商品的多 cfg 行两侧同序）
  const prods = Object.create(null);
  for (const c of Object.keys(rows).sort((a, b) => Number(a) - Number(b))) {
    const r = rows[c];
    const k = 'i' + r.itemId + 'x' + (r.num || 0);
    (prods[k] || (prods[k] = [])).push(c);
  }
  const order = [];
  const seen = Object.create(null);
  for (const k of (p.goodsOrder || []).map(String)) if (!seen[k]) ((seen[k] = 1), order.push(k));
  for (const k of Object.keys(prods)) if (!seen[k]) ((seen[k] = 1), order.push(k));
  const shops = gameShopOrder((s.shops || []).filter((x) => x && x.status <= 2));
  const budget = goldAvail == null ? Infinity : goldAvail;
  let spent = 0;
  outer: for (const key of order) {
    const g = (p.goods || {})[key];
    if (g && g.on === false) continue;
    const cfgs = prods[key];
    if (!cfgs) continue; // 面板残留的商品键已不在表上：不猜货
    for (const sh of shops) {
      if (sh.status !== 2) continue; // maskNode.active = 2!==status
      for (const cfgStr of cfgs) {
        if (out.length >= cap) break outer;
        if (!(cfgStr in sh.buyCnt)) continue; // 货架真源 = Object.keys(buyCnt)
        const r = rows[cfgStr];
        const at = sh.idStr + ':' + cfgStr;
        if (((p.cool || {})[at] || 0) > p.now) continue;
        if (((p.reject || {})[at] || 0) >= 3) continue;
        if (r.limitAll - (sh.buyCnt[cfgStr] || 0) <= 0) continue; // rank_shop_05 售罄
        if ((sh.selfBuyCnt[cfgStr] || 0) >= r.limit) continue; // activity95_009
        if (r.score > (s.cScore || 0)) continue; // conqueror2025_city33/46
        if (spent + r.gold > budget) continue;
        spent += r.gold;
        out.push(at);
      }
    }
  }
  return out;
}

// ── 等价性：与「游戏原式 + 参照下单序」完全同序 ───────────────────────
test('等价性：多所多件的候选全序逐条等于参照实现（种子随机 200 组）', () => {
  let seed = 0x5eed1234;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  for (let round = 0; round < 200; round++) {
    const nShops = 1 + Math.floor(rnd() * 5);
    const shops = [];
    for (let i = 0; i < nShops; i++) {
      const buyCnt = {};
      const selfBuyCnt = {};
      for (const cfg of CFGS) {
        if (rnd() < 0.35) continue; // 每所随机缺件
        buyCnt[String(cfg)] = Math.floor(rnd() * 45); // 0..44：跨过 limitAll=40 的售罄界
        if (rnd() < 0.3) selfBuyCnt[String(cfg)] = Math.floor(rnd() * 3);
      }
      shops.push(
        shop(String(BigInt('499999999999999000') + BigInt(i) + BigInt(round * 7)), {
          sid: 3828 + Math.floor(rnd() * 3) - 1, // 大部分本服、偶尔外服
          status: pick([1, 2, 2, 2, 3]),
          cityLevelId: pick([403, 404]),
          level: pick([0, 3, 5, 9]),
          cityShowNum: pick([3001, 3003, 4001]),
          buyCnt,
          selfBuyCnt,
        }),
      );
    }
    for (const s of shops) s.ownServer = s.sid === 3828;
    const rows = defaultRows();
    if (rnd() < 0.3) delete rows['3']; // 表外 cfg 也要能撞上（fail-closed）
    const p = panel({
      quotaTotal: 1 + Math.floor(rnd() * 6),
      goods: { [pk(2)]: { on: rnd() >= 0.5, max: Math.floor(rnd() * 3) } },
      goodsOrder: rnd() < 0.5 ? [] : [pk(101), pk(5), pk(2), pk(1)],
      cool: rnd() < 0.3 ? { [shops[0].idStr + ':1']: 10 } : {},
      reject: rnd() < 0.3 ? { [shops[0].idStr + ':1']: 3 } : {},
      now: 5,
    });
    const sn = snap(shops, { cScore: pick([0, 150, 200, 2000]), canBuyCnt: Math.floor(rnd() * 6) });
    const goldAvail = pick([null, 0, 300, 1500, 99999]);
    const got = seq(buildCandidates(sn, rows, p, 1794052802, goldAvail));
    const ref = referenceCandidates(sn, rows, p, goldAvail, p.quotaTotal);
    assert.deepEqual(got, ref, 'round=' + round);
  }
});

test('等价性：本服所先于高级城外服所（面板序只决定商品轴，不越过游戏显示序）', () => {
  const shops = [
    shop('500000000000000002', { sid: 9999, ownServer: false, level: 9, cityShowNum: 4001 }),
    shop('500000000000000001', { sid: 3828, ownServer: true, level: 3, cityShowNum: 3001 }),
  ];
  for (const s of shops) s.buyCnt = { 101: 0, 1: 0 };
  const list = buildCandidates(
    snap(shops),
    defaultRows(),
    panel({ goodsOrder: [pk(101), pk(1)] }),
    1794052802,
    null,
  );
  assert.deepEqual(
    list.map((c) => c.shopIdStr + '#' + c.cfgStr),
    [
      '500000000000000001#101',
      '500000000000000002#101',
      '500000000000000001#1',
      '500000000000000002#1',
    ],
  );
});

test('刻意偏离：cnc_city_level 读不到（level=0）时按 cityLevelId 降序，而不像游戏 `||1` 压平', () => {
  const shops = [
    shop('1', { level: 0, cityLevelId: 403 }),
    shop('2', { level: 0, cityLevelId: 404 }),
  ];
  for (const s of shops) s.buyCnt = { 1: 0 };
  const list = buildCandidates(snap(shops), defaultRows(), panel(), 0, null);
  assert.deepEqual(
    list.map((c) => c.shopIdStr),
    ['2', '1'],
  );
});

// ── 闸门逐条过滤 ──────────────────────────────────────────────────────
test('闸门：非营业态（status≠2）不下单，status=1 的所进显示序但被逐件拦下', () => {
  const shops = [
    shop('1', { status: 1, buyCnt: { 1: 0 } }),
    shop('2', { status: 2, buyCnt: { 1: 0 } }),
  ];
  const list = buildCandidates(snap(shops), defaultRows(), panel(), 0, null);
  assert.deepEqual(
    list.map((c) => c.shopIdStr),
    ['2'],
  );
  for (const s of shops) s.status = 3;
  assert.deepEqual(buildCandidates(snap(shops), defaultRows(), panel(), 0, null), []);
});

test('闸门：全服库存打满（buy_limit_all − buyCnt ≤ 0）判售罄', () => {
  const shops = [shop('1', { buyCnt: { 1: 40 } }), shop('2', { buyCnt: { 1: 39 } })];
  const list = buildCandidates(snap(shops), defaultRows(), panel(), 0, null);
  assert.deepEqual(
    list.map((c) => c.key),
    ['2:1'],
  );
});

test('闸门：本人限购已达（selfBuyCnt ≥ buy_limit）不再买同一件', () => {
  const shops = [shop('1', { buyCnt: { 1: 0 }, selfBuyCnt: { 1: 2 } })]; // limit=2
  assert.deepEqual(buildCandidates(snap(shops), defaultRows(), panel(), 0, null), []);
  shops[0].selfBuyCnt = { 1: 1 };
  assert.equal(buildCandidates(snap(shops), defaultRows(), panel(), 0, null).length, 1);
});

test('闸门：积分不足（need_score > cScore）整件跳过', () => {
  const shops = [shop('1', { buyCnt: { 101: 0, 1: 0 } })];
  const list = buildCandidates(snap(shops, { cScore: 150 }), defaultRows(), panel(), 0, null);
  assert.deepEqual(
    list.map((c) => c.cfgStr),
    ['1'],
  );
});

test('闸门：钻石预算无保留额（面板项已废弃），余额无从判定时放行（以服务器拒绝为裁决）', () => {
  const shops = [shop('1', { buyCnt: { 1: 0 } }), shop('2', { buyCnt: { 1: 0 } })];
  // 每件 100 金：预算 150 → 只放行第一件
  assert.equal(buildCandidates(snap(shops), defaultRows(), panel(), 0, 150).length, 1);
  assert.equal(buildCandidates(snap(shops), defaultRows(), panel(), 0, null).length, 2);
  assert.deepEqual(buildCandidates(snap(shops), defaultRows(), panel(), 0, 0), []);
});

test('闸门：额度按 canBuyCnt（已用）扣减，配置不可得时视为 0 额度', () => {
  const shops = [shop('1', { buyCnt: { 1: 0, 2: 0, 3: 0 } })];
  assert.equal(
    buildCandidates(snap(shops), defaultRows(), panel({ quotaTotal: 5 }), 0, null).length,
    3,
  );
  // 已用 4 / 总 5 → 只剩 1 次
  const left = buildCandidates(
    snap(shops, { canBuyCnt: 4 }),
    defaultRows(),
    panel({ quotaTotal: 5 }),
    0,
    null,
  );
  assert.equal(left.length, 1);
  // 已用 ≥ 总额度 → 一票不放
  assert.deepEqual(
    buildCandidates(
      snap(shops, { canBuyCnt: 5 }),
      defaultRows(),
      panel({ quotaTotal: 5 }),
      0,
      null,
    ),
    [],
  );
  assert.deepEqual(
    buildCandidates(
      snap(shops, { canBuyCnt: 5 }),
      defaultRows(),
      panel({ quotaTotal: 0 }),
      0,
      null,
    ),
    [],
  );
});

test('面板文案 quotaText：分子是「本轮已抢」（=canBuyCnt，跟随轮次），不是剩余额度', () => {
  // 旧写法是「本轮额度 剩 0/5」+ 一行会话级「本会话已抢 0 件」：刷新就归零的那行与上行方向相反，被读成「本轮一件没抢」
  assert.equal(quotaText(5, 5), '本轮已抢 5/5'); // 额度用光（截图那种表观）
  assert.equal(quotaText(0, 5), '本轮已抢 0/5'); // 轮次刚开始
  assert.equal(quotaText(2, 5), '本轮已抢 2/5'); // 中间态
  assert.equal(quotaText(null, 5), '本轮已抢 —/5'); // 2442 快照尚未取得：不拿 0 冒充进度
  assert.equal(quotaText(6, 5), '本轮已抢 5/5'); // 已用高于配置上限 → 夹住，不冒出 6/5
  assert.equal(quotaText(-1, 5), '本轮已抢 0/5'); // 异常负值 → 夹住
  assert.equal(quotaText(2, '5'), '本轮已抢 2/5'); // 配置以文本形态回来也要能算
  assert.equal(quotaText(2, 0), '额度配置(81268)不可得'); // 没分母就不报进度
  assert.equal(quotaText(2, undefined), '额度配置(81268)不可得');
});

test('闸门：截断只看本期剩余额度与本轮已下发数（maxPerBurst 与逐件 max 均已废弃）', () => {
  const shops = [shop('1', { buyCnt: { 1: 0, 2: 0 } }), shop('2', { buyCnt: { 1: 0, 2: 0 } })];
  const rows = defaultRows();
  // 额度 5 ≥ 可售 4 件 → 全部发出：面板不再有一个能把一轮截短的「单次」旋钮
  assert.equal(buildCandidates(snap(shops), rows, panel({ quotaTotal: 5 }), 0, null).length, 4);
  // 本轮已下发 4 → 只补余下 1 件（同一拍重入不重复下单；额度 5 就是总闸门）
  assert.equal(
    buildCandidates(snap(shops), rows, panel({ quotaTotal: 5, dispatched: 4 }), 0, null).length,
    1,
  );
  // 旧存档里残留的 max=1 与已废弃的 maxPerBurst 两侧都当看不见：既不截件数也不截同件跨所
  const legacy = buildCandidates(
    snap(shops, { canBuyCnt: 0 }),
    rows,
    panel({
      goods: { [pk(1)]: { on: true, max: 1 } },
      goodsOrder: [pk(1), pk(2)],
      quotaTotal: 9,
      maxPerBurst: 2,
    }),
    0,
    null,
  );
  assert.deepEqual(
    legacy.map((c) => c.key),
    ['1:1', '2:1', '1:2', '2:2'],
  );
});

test('闸门：面板取消勾选的商品不抢；表外 cfg（行缺失）fail-closed 不买', () => {
  const shops = [shop('1', { buyCnt: { 1: 0, 2: 0 } })];
  const rows = defaultRows();
  // goods 已由 normalizeCfg 归一为 `{on:boolean}`（旧的 max 位已废弃，toModuleCfg 直接丢弃），键是商品键
  const off = buildCandidates(
    snap(shops),
    rows,
    panel({ goods: { [pk(1)]: { on: false, max: 0 } } }),
    0,
    null,
  );
  assert.deepEqual(
    off.map((c) => c.cfgStr),
    ['2'],
  );
  // 表外 cfg（行缺失）fail-closed：删掉货架行后该 cfg 不入选，其他 cfg 不受影响
  delete rows['2'];
  const after = buildCandidates(snap(shops), rows, panel(), 0, null);
  assert.deepEqual(
    after.map((c) => c.cfgStr),
    ['1'],
    '行缺失的 cfg 2 应被丢弃，行存在的 cfg 1 仍入选',
  );
});

test('闸门：被拒冷却期内跳过；连续被拒达 3 次当日拉黑', () => {
  const shops = [shop('7', { buyCnt: { 1: 0 } })];
  const rows = defaultRows();
  const p1 = panel({ cool: { '7:1': 10_000 }, now: 5_000 });
  assert.deepEqual(buildCandidates(snap(shops), rows, p1, 0, null), []);
  const p2 = panel({ cool: { '7:1': 10_000 }, now: 10_001 });
  assert.equal(buildCandidates(snap(shops), rows, p2, 0, null).length, 1);
  assert.deepEqual(
    buildCandidates(snap(shops), rows, panel({ reject: { '7:1': 3 } }), 0, null),
    [],
  );
  assert.equal(
    buildCandidates(snap(shops), rows, panel({ reject: { '7:1': 2 } }), 0, null).length,
    1,
  );
});

// ── 商品身份（品种+数量）与总数量列 ────────────────────────────────────
test('商品身份：同 item_id+同 item_num 的普通/高级城两档合成一个商品（勾选共用、下单展开两行）', () => {
  const rows = defaultRows();
  // 把高级城 cfg 101 改成与普通城 cfg 1 同一件货（同品种同数量），只是更贵、门槛更高
  rows['101'] = row(101, { itemId: rows['1'].itemId, num: rows['1'].num, gold: 300, score: 0 });
  const key = 'i' + rows['1'].itemId + 'x' + rows['1'].num;
  const shops = [shop('1', { buyCnt: { 1: 0, 101: 0 } })];
  const on = buildCandidates(snap(shops), rows, panel({ quotaTotal: 9 }), 0, null);
  assert.deepEqual(
    on.map((c) => c.productKey),
    [key, key],
    '两档属同一商品',
  );
  assert.deepEqual(
    on.map((c) => c.cfgStr),
    ['1', '101'],
    '内层按 cfg 升序展开该商品在本所上架的行',
  );
  // 取消勾选作用在整个商品上：两档一起消失（一勾即同买两档，一关即同关两档）
  const off = buildCandidates(
    snap(shops),
    rows,
    panel({ quotaTotal: 9, goods: { [key]: { on: false } } }),
    0,
    null,
  );
  assert.deepEqual(off, []);
  // 同品种不同数量是两个商品：仅 num 不同的那行不进入同一键
  rows['2'] = row(2, { itemId: rows['1'].itemId, num: 3 });
  const two = buildCandidates(
    snap([shop('1', { buyCnt: { 1: 0, 2: 0 } })]),
    rows,
    panel({ quotaTotal: 9, goods: { [key]: { on: false } } }),
    0,
    null,
  );
  assert.deepEqual(
    two.map((c) => c.cfgStr),
    ['2'],
    'x1 被关不影响 x3：它们是两个商品',
  );
});

test('总数量列：Σ 全部商店该商品剩余（status>2 不计、打满计 0、无快照显 — 不猜数）', () => {
  const rows = defaultRows();
  const key = pk(1);
  const a = shop('1', { buyCnt: { 1: 5 } }); // 40−5=35
  const b = shop('2', { buyCnt: { 1: 40 } }); // 全服打满 → 计 0
  const c = shop('3', { buyCnt: { 1: 0 }, status: 3 }); // 红包期买不到 → 不计
  assert.equal(productStockSum(rows, [a, b, c], key), '35');
  assert.equal(productStockSum(rows, null, key), '—', '尚无快照不猜数');
  assert.equal(productStockSum(null, [a], key), '—', '表不可读不猜数');
  assert.equal(productStockSum(rows, [a, b, c], 'nope'), '0', '面板残留键不在表上：无货不是未知');
  // 本人限购余量不抢窄这一列：selfBuyCnt 已达上限仍按全服剩余计入（那是「能不能买」，不是「还剩多少」）
  assert.equal(
    productStockSum(rows, [shop('1', { buyCnt: { 1: 0 }, selfBuyCnt: { 1: 2 } })], key),
    '40',
  );
});

// ── 本地镜像收敛 ──────────────────────────────────────────────────────
test('镜像收敛：候选不含重复 (所,件)；按应答整表回写 selfBuyCnt/buyCnt 后同一件不再出现', () => {
  const shops = [shop('9', { buyCnt: { 1: 0, 2: 0 }, selfBuyCnt: {} })];
  const rows = defaultRows();
  const first = buildCandidates(snap(shops), rows, panel({ quotaTotal: 5 }), 0, null);
  const keys = first.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, '不得出现重复 (所,件)');
  // 模拟 settleBuy 的整表回写：selfBuyCnt 里 cfg1 到 limit
  shops[0].selfBuyCnt = { 1: 2 };
  const second = buildCandidates(snap(shops), rows, panel({ quotaTotal: 5 }), 0, null);
  assert.deepEqual(
    second.map((c) => c.key),
    ['9:2'],
  );
});

// ── Int64 字符串往返 ──────────────────────────────────────────────────
test('Int64：Number 会碰撞的两个 id（4.99e17 邻域）仍按十进制串稳定定序且原样回传', () => {
  // 499999999999999999 与 500000000000000001 转 Number 后同为 500000000000000000（有损）
  const a = '499999999999999999';
  const b = '500000000000000001';
  assert.equal(Number(a), Number(b), '夹具前提：Number 形态已丧失区分度');
  const shops = [shop(b, { buyCnt: { 1: 0 } }), shop(a, { buyCnt: { 1: 0 } })];
  const list = buildCandidates(snap(shops), defaultRows(), panel(), 0, null);
  assert.deepEqual(
    list.map((c) => c.shopIdStr),
    [a, b],
    '字符串升序（等价 Int64.compare），且 id 不被 Number 化失真',
  );
  for (const c of list) assert.equal(c.shopIdStr.length, 18);
});

// ── 活动级 fail-closed ────────────────────────────────────────────────
test('fail-closed：cq26IsOpen=false 时整拍不执行（一个包都不发），且长睡 5 分钟', async () => {
  let sent = 0;
  const delay = await gatedPass(false, () => {
    sent++;
    return 1000;
  });
  assert.equal(sent, 0, '未开启时不得进入发包编排');
  assert.equal(delay, 5 * 60 * 1000);
  const d2 = await gatedPass(true, () => {
    sent++;
    return 60_000;
  });
  assert.equal(sent, 1);
  assert.equal(d2, 60_000);
});

test('健壮性：入参缺失/null 一律回空清单，不抛（符号漂移与空快照都要能过）', () => {
  assert.deepEqual(buildCandidates(null, null, null, 0, null), []);
  assert.deepEqual(buildCandidates(undefined, defaultRows(), panel(), 0, null), []);
  assert.deepEqual(
    buildCandidates(snap([{ status: 2, buyCnt: { 1: 0 }, idStr: '1' }]), {}, panel(), 0, null),
    [],
  );
  assert.deepEqual(buildCandidates(snap([]), defaultRows(), panel(), 0, null), []);
  assert.deepEqual(buildCandidates({ shops: null }, defaultRows(), panel(), 0, null), []);
});

// ── ACL 投影（cq26ShopRows）：字段归一与 null 语义 ─────────────────────
const realTableRows = l10n.tableRows;
after(() => {
  l10n.tableRows = realTableRows;
});

test('ACL 投影：行字段归一为 cfgId→闸门字段；数字串 id 归一为十进制键', () => {
  l10n.tableRows = () => [
    {
      id: '7',
      item_id: '820007',
      item_num: '2',
      need_gold: '1200',
      need_score: '80',
      buy_limit: '3',
      buy_limit_all: '40',
      order: '12',
    },
    { id: 101, item_id: 69459, need_gold: 500, buy_limit: 1, buy_limit_all: 40, order: 1 },
    { id: '0', item_id: 1 }, // 非法 cfg：跳过
    null, // 脏行：不抛
  ];
  const rows = gameData.cq26ShopRows();
  assert.deepEqual(Object.keys(rows), ['7', '101']);
  assert.deepEqual(rows['7'], {
    itemId: 820007,
    num: 2,
    gold: 1200,
    score: 80,
    limit: 3,
    limitAll: 40,
    order: 12,
    level: 0,
  });
  assert.equal(rows['101'].itemId, 69459);
});

test('ACL 投影：表不可读/无行回 null（区分于 {}，调用方须 fail-closed 不下单）', () => {
  l10n.tableRows = () => null;
  assert.equal(gameData.cq26ShopRows(), null);
  l10n.tableRows = () => [];
  assert.equal(gameData.cq26ShopRows(), null);
  l10n.tableRows = () => [{ id: 'x', item_id: 1 }];
  assert.equal(gameData.cq26ShopRows(), null, '全非法行等价于无数据');
});
