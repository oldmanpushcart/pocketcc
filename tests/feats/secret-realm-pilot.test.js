// 异能秘境自动驾驶 · 选点纯函数层回放测试（§5.1/§5.3，先证后接）。
// 夹具 tests/fixtures/secret-realm-901.json 的 liveSnap/reps 逐字取自录制 20261101T200401 的 901 应答；
// 合成点仅用于「隔离单条闸」，字段形态严格照真实 m（见夹具 _note）。
// feat 模块 import 链会触到浏览器全局（constants.js 末尾 re-export core/util.js 的 CODE_NOT_SENT），
// 故测试内先最小桩化 window/document/chrome，再动态 import 纯函数——不 stub 任何游戏符号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(here, '../fixtures/secret-realm-901.json'), 'utf8'));
const mod = await import('../../extension/src/feats/activity/secret-realm/pilot-select.js');
const {
  pickResource,
  pickBeast,
  beastOwnedByMeOrFree,
  resourceCost,
  exitStageWant,
  shopStageWant,
  beastStageWant,
  pickShop,
  pickHopTile,
} = mod;

const PAB_RESOURCE = 173;
const PAB_MONSTER = 172;

test('夹具真实性：liveSnap 是含活井(173 iNum>=5 state0 teams空)的真实 901 点子集', () => {
  assert.ok(
    fx.liveSnap && Array.isArray(fx.liveSnap.points) && fx.liveSnap.points.length > 0,
    '夹具缺 liveSnap',
  );
  const wells = fx.liveSnap.points.filter((p) => {
    const m = p.m || {};
    return (
      p.pointType === PAB_RESOURCE &&
      Number(m.iNum || 0) >= 5 &&
      Number(m.state) === 0 &&
      !(m.teams || []).length
    );
  });
  assert.ok(wells.length >= 1, '真实快照里应至少有一口活井');
});

test('归属闸：callTId(抹零数) 与 teamId(精确串) 必须 double 比才命中（字符串比会漏判）', () => {
  const { teamIdStr, callTIdNum } = fx.matchPair;
  assert.equal(fx.matchPair.equalAsDouble, true, '夹具正样本对应当 double 相等');
  // double 比 → 命中己方
  assert.equal(beastOwnedByMeOrFree(callTIdNum, Number(teamIdStr)), true);
  // 若按字符串比会 false —— 锁定"不能用字符串"这条教训
  assert.equal(
    String(callTIdNum) === teamIdStr,
    false,
    '字符串本就不等（这正是禁止字符串比的原因）',
  );
  // 别的队 → 不可打
  assert.equal(beastOwnedByMeOrFree(callTIdNum, Number('4910814660135067000')), false);
  // 无归属 → 可打
  assert.equal(beastOwnedByMeOrFree(undefined, 123), true);
  assert.equal(beastOwnedByMeOrFree(0, 123), true);
  // 拿不到己方队 ID 但有归属 → 保守不可打
  assert.equal(beastOwnedByMeOrFree(callTIdNum, null), false);
});

test('pickResource：真实活井快照能选出 173 井（窄 4 筛，minNum=5）', () => {
  const pts = fx.liveSnap.points;
  // 起点取快照里一口活井，使其它点 dd>0（排除脚下）
  const start = pts.find((p) => p.pointType === PAB_RESOURCE);
  const ctx = {
    startPoint: { x: start.x, y: start.y },
    serverTimeSec: Math.floor(fx.liveSnap.ts / 1000),
    minNum: 5,
    maxDist: Infinity,
    isRoundOpen: () => true,
    marches: [],
    marchedList: [],
    marchPolicy: 0,
  };
  const best = pickResource(pts, ctx);
  assert.ok(best, '真实快照应能选出井（旧实现链尾被商店抢占的反例根因）');
  assert.equal(best.pointType, PAB_RESOURCE);
  assert.ok(Number(best.m.iNum) >= 5);
  assert.notEqual(best.x + ',' + best.y, '95,163', '资源选择器绝不返回商店(95,163)');
});

test('pickResource：rTime 落在未来不再判空（证明被删的 v3 闸确会误拦、新代码不看它）', () => {
  const future = String(Date.now() + 9_999_999);
  const pts = [
    {
      x: 10,
      y: 10,
      pointType: PAB_RESOURCE,
      m: { iNum: 8, state: 0, teams: [], esrId: 14, rTime: future },
    },
  ];
  const ctx = {
    startPoint: { x: 0, y: 0 },
    serverTimeSec: Math.floor(Date.now() / 1000),
    minNum: 5,
    maxDist: Infinity,
    isRoundOpen: () => true,
    marches: [],
    marchedList: [],
    marchPolicy: 0,
  };
  const best = pickResource(pts, ctx);
  assert.ok(best && best.x === 10 && best.y === 10, 'rTime>now 的井在新口径下仍应被选中');
});

test('pickResource：60s 内派过的点被 marchedList 拦下（等价竞品 marched_list）', () => {
  const now = Math.floor(Date.now() / 1000);
  const pts = [
    { x: 10, y: 10, pointType: PAB_RESOURCE, m: { iNum: 8, state: 0, teams: [], esrId: 14 } },
  ];
  const ctx = {
    startPoint: { x: 0, y: 0 },
    serverTimeSec: now,
    minNum: 5,
    maxDist: Infinity,
    isRoundOpen: () => true,
    marches: [],
    marchedList: [{ x: 10, y: 10, t: now - 30 }], // 30s 前派过 → 拦
    marchPolicy: 0,
  };
  assert.equal(pickResource(pts, ctx), null);
  // 90s 前的记录不再拦（>60s 窗）
  ctx.marchedList = [{ x: 10, y: 10, t: now - 90 }];
  assert.ok(pickResource(pts, ctx), '超 60s 窗应解禁可重选');
});

test('pickResource：强区牵引——存在更高档位(tier)时 goal 收敛到强区（哪怕打分更低、更远）', () => {
  const now = Math.floor(Date.now() / 1000);
  // 微区井 A：近且高产（原始打分高）；强区井 B：远且低产（原始打分低）
  const pts = [
    { x: 10, y: 10, pointType: PAB_RESOURCE, m: { iNum: 8, state: 0, teams: [], esrId: 15 } },
    { x: 60, y: 60, pointType: PAB_RESOURCE, m: { iNum: 1, state: 0, teams: [], esrId: 16 } },
  ];
  const base = {
    startPoint: { x: 0, y: 0 },
    serverTimeSec: now,
    minNum: 0,
    maxDist: Infinity,
    hopMaxDist: Infinity, // 不封顶，直接拿 goal 便于验证 tier 分流
    isRoundOpen: () => true,
    marches: [],
    marchedList: [],
    marchPolicy: 0,
    roundTier: (id) => (id === 16 ? 2 : id === 15 ? 1 : 0), // esrId16=强区（开放回合更晚）
  };
  const off = pickResource(pts, { ...base, preferStrong: false });
  assert.equal(off.x + ',' + off.y, '10,10', '关闭牵引：应按打分选近且高产的微区井 A');
  const on = pickResource(pts, { ...base, preferStrong: true });
  assert.equal(on.x + ',' + on.y, '60,60', '开启牵引：goal 应收敛到更高档位的强区井 B');
});

test('pickResource：只有微区开放（全候选同档）时牵引不改变打分最优；tier 未知(0)也不牵引', () => {
  const now = Math.floor(Date.now() / 1000);
  const pts = [
    { x: 10, y: 10, pointType: PAB_RESOURCE, m: { iNum: 8, state: 0, teams: [], esrId: 15 } },
    { x: 40, y: 40, pointType: PAB_RESOURCE, m: { iNum: 1, state: 0, teams: [], esrId: 15 } },
  ];
  const same = pickResource(pts, {
    startPoint: { x: 0, y: 0 },
    serverTimeSec: now,
    maxDist: Infinity,
    hopMaxDist: Infinity,
    isRoundOpen: () => true,
    marches: [],
    marchedList: [],
    preferStrong: true,
    roundTier: () => 1, // 两井同档
  });
  assert.equal(same.x + ',' + same.y, '10,10', '同档不应改变打分最优');
  const unknown = pickResource(pts, {
    startPoint: { x: 0, y: 0 },
    serverTimeSec: now,
    maxDist: Infinity,
    hopMaxDist: Infinity,
    isRoundOpen: () => true,
    marches: [],
    marchedList: [],
    preferStrong: true,
    roundTier: () => 0, // 取不到 roundid（离线/无该行）
  });
  assert.equal(unknown.x + ',' + unknown.y, '10,10', 'tier 全 0 时不牵引，退回打分最优');
});

test('pickBeast：己方召唤兽(callTId double 命中)且空位可选；他队召唤兽被归属闸拦；无主兽可选', () => {
  const mineTidNum = Number('4910819285328331784');
  const pts = [
    {
      x: 20,
      y: 20,
      pointType: PAB_MONSTER,
      m: { callTId: 4910819285328332000, state: 0, teams: [], esrId: 2 },
    }, // 己方
    {
      x: 30,
      y: 30,
      pointType: PAB_MONSTER,
      m: { callTId: 4910814660135067000, state: 0, teams: [], esrId: 2 },
    }, // 他队
    { x: 40, y: 40, pointType: PAB_MONSTER, m: { state: 0, teams: [], esrId: 2 } }, // 无主
  ];
  const ctx = {
    startPoint: { x: 0, y: 0 },
    minQuality: 4,
    maxDist: Infinity,
    isRoundOpen: () => true,
    myTeamIdNum: mineTidNum,
    qualityFor: () => 5,
    marches: [],
    marchPolicy: 0,
  };
  const best = pickBeast(pts, ctx);
  assert.ok(best, '应选出可打的兽');
  assert.notEqual(best.x + ',' + best.y, '30,30', '他队召唤兽必须被归属闸排除');
  // 己方(20,20) 与 无主(40,40) 都可打；quality 相同按距离近优先 → 20,20
  assert.equal(best.x, 20);
  assert.equal(best.quality, 5);
});

test('pickBeast：占用中的兽(teams 非空)即使归属通过也不选（两条闸独立）', () => {
  const pts = [fx.reps.beast_mine].filter(Boolean); // 真实点：callTId=己方，但 teams 非空（正被打）
  assert.ok(pts.length === 1, '夹具缺 beast_mine');
  const ctx = {
    startPoint: { x: 0, y: 0 },
    minQuality: 1,
    maxDist: Infinity,
    isRoundOpen: () => true,
    myTeamIdNum: Number('4910819285328331784'),
    qualityFor: () => 5,
    marches: [],
    marchPolicy: 0,
  };
  // 归属通过（callTId 命中），但 teams 非空 → 不选
  assert.ok(pts[0].m.teams && pts[0].m.teams.length > 0, '夹具前提：beast_mine 处于被占');
  assert.equal(pickBeast(pts, ctx), null);
});

const { resolveHop } = mod;

test('resolveHop：目标在单跳窗内→直冲打分最优目标（不挂 waypoint）', () => {
  const goal = { x: 0, y: 10, d0: 10, gain: 100, score: 95 };
  const cands = [{ x: 0, y: 3, d0: 3, gain: 1, score: 1 }, goal];
  const got = resolveHop(cands, goal, 20);
  assert.equal(got, goal, 'goal.d0<=hopMaxDist 应原样返回 goal');
  assert.ok(!got.waypoint, 'goal.d0<=hopMaxDist 不应挂 waypoint');
});

test('resolveHop：目标太远→窗内挑最能逼近目标的近点作跳板', () => {
  const goal = { x: 0, y: 100, d0: 100, gain: 999, score: 900 }; // 丰盛但远
  const near = { x: 0, y: 5, d0: 5, gain: 1, score: 1 }; // 可达但反方向，不选
  const step = { x: 0, y: 15, d0: 15, gain: 1, score: 1 }; // 可达且最接近 goal
  const cands = [goal, near, step];
  const got = resolveHop(cands, goal, 20);
  assert.equal(got.x + ',' + got.y, '0,15', '应选最能缩短到 goal 距离的跳板');
  assert.ok(got.waypoint, '走跳板需挂 waypoint');
  assert.deepEqual(got.goal, { x: 0, y: 100 }, 'goal 作为最终目标随行');
});

test('resolveHop：目标太远且窗内无可落脚→null（宁不长途也不盲开）', () => {
  const goal = { x: 0, y: 100, d0: 100, gain: 999, score: 900 };
  const alsoFar = { x: 0, y: 50, d0: 50, gain: 5, score: 5 }; // 超出 hopMaxDist=20
  const got = resolveHop([goal, alsoFar], goal, 20);
  assert.equal(got, null);
});

test('resolveHop：hopMaxDist=Infinity 时不封顶→任何距离都直冲（向后兼容旧行为）', () => {
  const goal = { x: 0, y: 999, d0: 999, gain: 1, score: 1 };
  const got = resolveHop([goal], goal, Infinity);
  assert.equal(got, goal);
  assert.ok(!got.waypoint, 'goal.d0<=hopMaxDist 不应挂 waypoint');
});

test('resourceCost：打分随"距起点/未领奖BOSS/无香肠店"三锚加权（竞品口径）', () => {
  const p = { x: 10, y: 0 };
  const base = resourceCost(p, { startPoint: { x: 0, y: 0 } });
  const withBoss = resourceCost(p, {
    startPoint: { x: 0, y: 0 },
    firstUnrewardedBoss: { x: 10, y: 0 },
  });
  const withShop = resourceCost(p, {
    startPoint: { x: 0, y: 0 },
    nearestNoSausageShop: { x: 0, y: 0 },
  });
  // 起点距离项 = 10/2 = 5
  assert.ok(Math.abs(base - 5) < 1e-9, 'd(p,起点)/2');
  // BOSS 与 p 同格 → +0；应等于 base
  assert.ok(Math.abs(withBoss - base) < 1e-9);
  // 店在原点 → +10/6
  assert.ok(Math.abs(withShop - (5 + 10 / 6)) < 1e-9);
});

test('exitStageWant：team_type 分级 + 整场到点兜底（§4.1）', () => {
  const base = { serverMSTime: 1000, fightEndTime: 9_999_999 };
  // tier0：只要买到过百兽箱(pieceShop)
  assert.equal(
    exitStageWant({ ...base, teamType: 0, pieceShop: true, boss30: false, beastsFull: false }),
    true,
  );
  assert.equal(exitStageWant({ ...base, teamType: 0, pieceShop: false }), false);
  // tier1：需 pieceShop && boss30
  assert.equal(
    exitStageWant({ ...base, teamType: 1, pieceShop: true, boss30: false, beastsFull: true }),
    false,
  );
  assert.equal(
    exitStageWant({ ...base, teamType: 1, pieceShop: true, boss30: true, beastsFull: false }),
    true,
  );
  // tier2：三者齐
  assert.equal(
    exitStageWant({ ...base, teamType: 2, pieceShop: true, boss30: true, beastsFull: false }),
    false,
  );
  assert.equal(
    exitStageWant({ ...base, teamType: 2, pieceShop: true, boss30: true, beastsFull: true }),
    true,
  );
  // 兜底：到 fightEndTime 一律收场
  assert.equal(
    exitStageWant({
      teamType: 2,
      pieceShop: false,
      boss30: false,
      beastsFull: false,
      serverMSTime: 5000,
      fightEndTime: 5000,
    }),
    true,
  );
});

test('shopStageWant：节拍/禁店窗/高光窗加密（§4.2）', () => {
  // tier0 只看节拍
  assert.equal(shopStageWant({ teamType: 0, sinceShopSec: 500, shopIntervalSec: 480 }), true);
  assert.equal(shopStageWant({ teamType: 0, sinceShopSec: 100, shopIntervalSec: 480 }), false);
  // tier>0：台前 0~120s 禁店窗(bossOpeningSoon)一票否决
  assert.equal(
    shopStageWant({
      teamType: 2,
      sinceShopSec: 600,
      shopIntervalSec: 480,
      bossOpeningSoon: true,
      nearEndWindow: false,
    }),
    false,
  );
  // 超节拍→去；未超节拍但在开台后 120~180s 高光窗且 since>120→去
  assert.equal(
    shopStageWant({
      teamType: 2,
      sinceShopSec: 600,
      shopIntervalSec: 480,
      bossOpeningSoon: false,
      nearEndWindow: false,
    }),
    true,
  );
  assert.equal(
    shopStageWant({
      teamType: 2,
      sinceShopSec: 150,
      shopIntervalSec: 480,
      bossOpeningSoon: false,
      nearEndWindow: true,
    }),
    true,
  );
  assert.equal(
    shopStageWant({
      teamType: 2,
      sinceShopSec: 100,
      shopIntervalSec: 480,
      bossOpeningSoon: false,
      nearEndWindow: true,
    }),
    false,
  ); // since<=120 不够
});

test('beastStageWant：buff_color==5 增益数≥3 等六项齐才安心（§4.3）', () => {
  const ok = {
    teamType: 2,
    pieceShop: true,
    allBossCleared: true,
    cureOk: true,
    bandageOk: true,
    sausageOk: true,
    color5Count: 3,
    beastsNotFull: true,
    bossIn90sWindow: false,
  };
  assert.equal(beastStageWant(ok), true);
  assert.equal(beastStageWant({ ...ok, color5Count: 2 }), false, '5色增益数<3 不安心');
  assert.equal(beastStageWant({ ...ok, pieceShop: false }), false, '没买到百兽箱直接否');
  assert.equal(beastStageWant({ ...ok, bossIn90sWindow: true }), false);
  // tier0：只要 pieceShop
  assert.equal(beastStageWant({ teamType: 0, pieceShop: true }), true);
});

test('pickShop：链尾兜底店必过三连前置（本次核心补丁，§5.2）', () => {
  const shops = [{ pos: { x: 95, y: 163 }, time: 0, sausage: 0 }]; // 真实那家店
  const fightBegin = 1_000_000;
  // 前置①暖机：<63s 不去（即使有店）
  assert.equal(
    pickShop(shops, {
      serverMSTime: fightBegin + 10000,
      fightBeginTime: fightBegin,
      curPointType: 173,
    }),
    null,
  );
  // 暖机过 + 无近期到店 + 不在店 → 选中
  assert.deepEqual(
    pickShop(shops, {
      serverMSTime: fightBegin + 70000,
      fightBeginTime: fightBegin,
      curPointType: 173,
    }),
    { x: 95, y: 163 },
  );
  // 前置②全店共享 3s 冷却：time 很新(time*1000+3000>now) → 不去
  const recentTimeSec = Math.floor((fightBegin + 70000) / 1000); // ≈now 秒
  assert.equal(
    pickShop([{ pos: { x: 95, y: 163 }, time: recentTimeSec, sausage: 0 }], {
      serverMSTime: fightBegin + 70000,
      fightBeginTime: fightBegin,
      curPointType: 173,
    }),
    null,
  );
  // 前置③已在 161 → 不重派
  assert.equal(
    pickShop(shops, {
      serverMSTime: fightBegin + 70000,
      fightBeginTime: fightBegin,
      curPointType: 161,
    }),
    null,
  );
  // preferNoSausage：sausage 升序优先（先挑没香肠的店）
  const two = [
    { pos: { x: 10, y: 10 }, time: 0, sausage: 5 },
    { pos: { x: 95, y: 163 }, time: 0, sausage: 0 },
  ];
  assert.deepEqual(
    pickShop(two, {
      serverMSTime: fightBegin + 70000,
      fightBeginTime: fightBegin,
      curPointType: 173,
      preferNoSausage: true,
      startPoint: { x: 0, y: 0 },
    }),
    { x: 95, y: 163 },
  );
});

test('pickHopTile 逃袭档（无 goal）：就近任意可行军点作落点，173/174/175/172 全纳候选', () => {
  // 需求 1/5：被拉线立即转移，离当前最近的合法落脚位即取——不再只认 174/175。
  const cur = { x: 100, y: 100 };
  const tiles = [
    { k: '100,100', x: 100, y: 100, pt: 173, state: 0 }, // 当前点，排除
    { k: '110,100', x: 110, y: 100, pt: 173, state: 0 }, // 近处资源井（10 格）
    { k: '100,140', x: 100, y: 140, pt: 175, state: 0 }, // 远处营帐（40 格）
    { k: '100,115', x: 100, y: 115, pt: 172, state: 0 }, // 中距野怪（15 格）
  ];
  const got = pickHopTile(tiles, { cur, curKey: '100,100', requireFreeSlot: true });
  assert.deepEqual({ x: got.x, y: got.y, pt: got.pt }, { x: 110, y: 100, pt: 173 });
});

test('pickHopTile 逃袭档：PVP/交战/任何驻军(teams>0)/拉黑点全排除，仅留全空落点', () => {
  // 1115 问题8：teams=1 的井仍会触发遭遇战（实录逃到 (92,170) 三场全败）→ requireFreeSlot 收紧到 teams>0 即排。
  const cur = { x: 100, y: 100 };
  const tiles = [
    { k: '105,100', x: 105, y: 100, pt: 174, state: 12 }, // PVP 交战中 → 排除
    { k: '106,100', x: 106, y: 100, pt: 173, state: 0, isFight: true }, // 已交战 → 排除
    { k: '107,100', x: 107, y: 100, pt: 173, state: 0, teams: 2 }, // 驻军 2 → 排除
    { k: '109,100', x: 109, y: 100, pt: 173, state: 0, teams: 1 }, // 驻军 1（更近）→ 也排除（旧闸 teams>1 的漏网反例）
    { k: '108,100', x: 108, y: 100, pt: 175, state: 0, teams: 0 }, // 拉黑 → 排除
    { k: '120,100', x: 120, y: 100, pt: 173, state: 0, teams: 0 }, // 唯一全空安全落点
    { k: '300,300', x: 300, y: 300, pt: 161, state: 0 }, // 商店（非候选点类型）→ 排除
  ];
  const got = pickHopTile(tiles, {
    cur,
    curKey: '100,100',
    requireFreeSlot: true,
    isBlack: (k) => k === '108,100',
  });
  assert.deepEqual({ x: got.x, y: got.y }, { x: 120, y: 100 });
  // 全部候选都有队 → null（宁不逃也不进遭遇战；交回探索档）
  const none = pickHopTile([tiles[3]], { cur, curKey: '100,100', requireFreeSlot: true });
  assert.equal(none, null, 'teams=1 唯一候选时不得选中');
});

test('pickHopTile 跳板档（有 goal）：单跳窗内挑最能逼近 goal 者，窗内无落脚回 null', () => {
  // 需求 3/4：附近无满足单跳车程的合理井时，向打分最优井逼近一个资源/平台/宠物跳板（只挪位、不打野）。
  const cur = { x: 100, y: 100 };
  const goal = { x: 200, y: 100 }; // 远井方向
  const tiles = [
    { k: '110,100', x: 110, y: 100, pt: 173, state: 0 }, // 逼近 10 格（窗内，最逼近）
    { k: '108,120', x: 108, y: 120, pt: 174, state: 0 }, // 逼近较少（斜向）
    { k: '98,100', x: 98, y: 100, pt: 172, state: 0 }, // 反方向，远离 goal
    { k: '190,100', x: 190, y: 100, pt: 173, state: 0 }, // 逼近最多但距 cur 90 格 > 窗 → 排除
  ];
  const hopMaxD = 30;
  const got = pickHopTile(tiles, { cur, curKey: '100,100', goal, hopMaxD });
  assert.deepEqual({ x: got.x, y: got.y, pt: got.pt }, { x: 110, y: 100, pt: 173 });
  // 窗内无任何落脚点 → null（交回探索档，不发不可取消的长途）
  const none = pickHopTile([{ k: '190,100', x: 190, y: 100, pt: 173, state: 0 }], {
    cur,
    curKey: '100,100',
    goal,
    hopMaxD,
  });
  assert.equal(none, null);
});

test('pickHopTile 跳板档：不施驻军>1 约束（仅作位移跳板，非抢占落点）', () => {
  const cur = { x: 100, y: 100 };
  const goal = { x: 200, y: 100 };
  const tiles = [{ k: '120,100', x: 120, y: 100, pt: 173, state: 0, teams: 3 }];
  const got = pickHopTile(tiles, { cur, curKey: '100,100', goal, hopMaxD: 30 });
  assert.deepEqual({ x: got.x, y: got.y }, { x: 120, y: 100 });
});

test('pickHopTile 跳板档：必须严格前进——无任何点比当前更逼近 goal 则回 null（社绝 A↔B 往复）', () => {
  // 站在 A(100,100)，goal 在 (200,100)；唯一候选 (90,100) 反而更远离 goal → 不挪，交回探索档。
  const cur = { x: 100, y: 100 };
  const goal = { x: 200, y: 100 };
  const tiles = [{ k: '90,100', x: 90, y: 100, pt: 174, state: 0 }];
  assert.equal(pickHopTile(tiles, { cur, curKey: '100,100', goal, hopMaxD: 30 }), null);
  // 等距也不前进：(100,110) 到 goal 距离与当前相等（均 √(100²+10²)）→ 拒绝。
  assert.equal(
    pickHopTile([{ k: '100,110', x: 100, y: 110, pt: 173, state: 0 }], {
      cur,
      curKey: '100,100',
      goal,
      hopMaxD: 30,
    }),
    null,
  );
});

test('pickHopTile：pt 为字符串时经 Number 兑底仍可命中候选（防静默全 drop）', () => {
  const cur = { x: 100, y: 100 };
  const tiles = [{ k: '110,100', x: 110, y: 100, pt: '173', state: 0 }];
  const got = pickHopTile(tiles, { cur, curKey: '100,100', requireFreeSlot: true });
  assert.deepEqual({ x: got.x, y: got.y, pt: got.pt }, { x: 110, y: 100, pt: 173 });
});
