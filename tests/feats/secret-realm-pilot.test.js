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

test('resourceCost：打分随"距起点/未领奖BOSS/无香肠店"三锚加权（竞品 L24712）', () => {
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
