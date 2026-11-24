// cq26-excav（CQ26 战区宝藏）纯函数单测：候选序与游戏 getFirstOpenEnableSite 原式等价、闸门过滤。
// 全部断言的是「选哪个点」，不发包、不摸游戏符号——feat 模块 import 链会触到浏览器全局，
// 故先最小桩化 window/document/chrome，再动态 import 取导出纯函数（同 potion-craft 口径）。
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

// core 链里的 session/player/scene-watcher 等模块在 import 期就挂常驻 setInterval——只对测试
// harness 的定时器 unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/cq26/excav/index.js');
const { pickOpen, orderLikeGame } = mod;
const { gameData } = await import('../../extension/src/core/game-api.js');
const { game } = await import('../../extension/src/core/game.js');

/**
 * 游戏原式（CQ26NeutralController.prototype.getFirstOpenEnableSite 逐字翻回）：
 * 跳过已采 → 命中本服的第一个即 break → 否则取 endTime 最小者。作为等价性参照实现。
 * 归属比较刻意保留游戏的**松散相等**（`n.ownerSid == o`）：ACL 投影侧已把两侧 Number 化，
 *   故 mSid 为字符串形态时两实现结论仍一致（另有专例校验）。
 * @param {Array<object>} list 全量点
 * @param {string[]} claimed 已采 siteId
 * @param {number|string|null} selfSid _selfInfo.mSid
 * @returns {object|null}
 */
function gamePick(list, claimed, selfSid) {
  let t = null;
  let a = null;
  const o = selfSid;
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (claimed.indexOf(n.siteId) >= 0) continue;
    // 参照实现刻意保留游戏原式的松散相等（`==`），不改成 ===
    if (o != null && n.ownerSid == o) {
      a = n;
      break;
    }
    if (!t || t.endTime > n.endTime) t = n;
  }
  return a || t;
}

/**
 * 走 feat 侧管线（闸门用默认口径：无冷却、无拉黑、剩余下限 0）后取队头。
 * @param {Array<object>} list 全量点（claimed 标志需与传入的 claimed 数组一致）
 * @param {number} nowSec
 */
function featPick(list, nowSec) {
  const open = pickOpen(list, nowSec, { safeRemainSec: 0, now: 0, coolUntil: {}, rejectCount: {} });
  const q = orderLikeGame(open);
  return q.length ? q[0] : null;
}

/** 造一个点：siteId / ownerSid / endTime / claimed */
const site = (id, ownerSid, endTime, claimed) => ({
  siteId: id,
  ownerSid,
  endTime,
  claimed: !!claimed,
  ownServer: false,
});

// ── 等价性：队头 === 游戏 icon 会选中的那一个 ─────────────────────────
test('等价性：无本服点时取 endTime 最小者（报文实证 20:14:56 那场两点皆外服）', () => {
  const list = [
    site('140138_1794053696', 3281, 1794060896),
    site('140064_1794052915', 3765, 1794060115, true),
  ];
  const ref = gamePick(list, ['140064_1794052915'], 3828);
  assert.equal(ref.siteId, '140138_1794053696');
  assert.equal(featPick(list, 1794054944).siteId, ref.siteId);
});

test('等价性：本服点优先，且多个本服点时取**列表原序**第一个（游戏 break 语义，非按 endTime）', () => {
  const list = [
    site('a', 3828, 1794070000), // 本服、更晚过期
    site('b', 3828, 1794060000), // 本服、更早过期
    site('c', 9999, 1794050000), // 外服、最早过期
  ];
  for (const s of list) s.ownServer = s.ownerSid === 3828;
  const ref = gamePick(list, [], 3828);
  assert.equal(ref.siteId, 'a');
  assert.equal(featPick(list, 1794049000).siteId, ref.siteId);
  // 队头之后的次序按 endTime 升序（外服 c 应排在 b 之前）
  const q = orderLikeGame(pickOpen(list, 1794049000, { safeRemainSec: 0, now: 0 }));
  assert.deepEqual(
    q.map((s) => s.siteId),
    ['a', 'b', 'c'],
  );
});

test('等价性：selfSid 不可得（未知归属）时退化为其外服分支，仍取 endTime 最小者', () => {
  const list = [site('x', 1, 1794070000), site('y', 2, 1794060000)];
  const ref = gamePick(list, [], null);
  assert.equal(ref.siteId, 'y');
  // feat 侧降级路径：ownServer 全 false（读不到 _selfInfo.mSid），排序只剩 endTime 升序
  const q = orderLikeGame(pickOpen(list, 1794050000, { safeRemainSec: 0, now: 0 }));
  assert.equal(q[0].siteId, ref.siteId);
});

test('等价性：全部已采 → 两实现都给 null（icon 灭，feat 零发包）', () => {
  const list = [site('a', 3828, 1794070000, true), site('b', 9, 1794060000, true)];
  assert.equal(gamePick(list, ['a', 'b'], 3828), null);
  assert.equal(featPick(list, 1794050000), null);
});

test('等价性：随机 200 组对拍（LCG 定种，覆盖本服有无/已采比例/过期次序）', () => {
  let seed = 20261107;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 200; k++) {
    const selfSid = 3828;
    const nowSec = 1794050000 + Math.floor(rnd() * 1000);
    const n = 1 + Math.floor(rnd() * 6);
    const list = [];
    for (let i = 0; i < n; i++) {
      const own = rnd() < 0.4;
      list.push({
        siteId: 's' + i + '_' + (nowSec + i),
        ownerSid: own ? selfSid : 1000 + Math.floor(rnd() * 5000),
        endTime: nowSec + 1 + Math.floor(rnd() * 7200),
        claimed: false,
        ownServer: false,
      });
    }
    const claimedArr = list.filter(() => rnd() < 0.3).map((s) => s.siteId);
    for (const s of list) s.claimed = claimedArr.indexOf(s.siteId) >= 0;
    for (const s of list) s.ownServer = s.ownerSid === selfSid;
    const ref = gamePick(list, claimedArr, selfSid);
    const got = featPick(list, nowSec);
    assert.equal(
      got && got.siteId,
      ref && ref.siteId,
      '第 ' + k + ' 组不一致 ref=' + (ref && ref.siteId) + ' got=' + (got && got.siteId),
    );
  }
});

// ── 闸门过滤 ─────────────────────────────────────────────────────────
test('过期闸：剩余 <= safeRemainSec 的点不入队（发了也是白撞）', () => {
  const list = [site('soon', 9, 1000 + 20), site('later', 9, 1000 + 3600)];
  const open = pickOpen(list, 1000, { safeRemainSec: 30, now: 0 });
  assert.deepEqual(
    open.map((s) => s.siteId),
    ['later'],
  );
});

test('过期闸：生产口径（不传 safeRemainSec → 默认 30s）与显式传值同结论', () => {
  const list = [site('soon', 9, 1000 + 29), site('just', 9, 1000 + 31)];
  assert.deepEqual(
    pickOpen(list, 1000, { now: 0 }).map((s) => s.siteId),
    ['just'],
  );
  assert.deepEqual(
    pickOpen(list, 1000, { safeRemainSec: 30, now: 0 }).map((s) => s.siteId),
    ['just'],
  );
});

test('去重闸：claimed 标志与空 siteId 都被滤掉', () => {
  const list = [site('done', 9, 99999, true), { siteId: '', ownerSid: 9, endTime: 99999 }];
  assert.deepEqual(pickOpen(list, 1000, { safeRemainSec: 0, now: 0 }), []);
});

test('冷却闸：单次被拒进 coolUntil（不拉黑），到期后重新入队', () => {
  const s = site('a', 9, 99999);
  const gated = pickOpen([s], 1000, { safeRemainSec: 0, now: 5000, coolUntil: { a: 6000 } });
  assert.deepEqual(gated, []);
  const freed = pickOpen([s], 1000, { safeRemainSec: 0, now: 7000, coolUntil: { a: 6000 } });
  assert.equal(freed.length, 1);
});

test('拉黑闸：连续被拒达 maxReject 次即当日不再尝试（防逐拍重发刷屏）', () => {
  const s = site('a', 9, 99999);
  assert.deepEqual(
    pickOpen([s], 1000, { safeRemainSec: 0, now: 0, rejectCount: { a: 3 }, maxReject: 3 }),
    [],
  );
  assert.equal(
    pickOpen([s], 1000, { safeRemainSec: 0, now: 0, rejectCount: { a: 2 }, maxReject: 3 }).length,
    1,
  );
});

test('串行排空：每采一个就重算队列，直至为空（claimAll 续采的收敛性）', () => {
  const list = [site('a', 3828, 1794060000), site('b', 9, 1794059000), site('c', 9, 1794058000)];
  for (const s of list) s.ownServer = s.ownerSid === 3828;
  const done = [];
  let guard = 0;
  for (;;) {
    const q = orderLikeGame(
      pickOpen(list, 1794050000, { safeRemainSec: 0, now: 0 }).filter(
        (s) => done.indexOf(s.siteId) < 0,
      ),
    );
    if (!q.length) break;
    done.push(q[0].siteId);
    assert.ok(++guard < 10, '未收敛');
  }
  assert.deepEqual(done, ['a', 'c', 'b']);
});

test('健壮性：入参为 null/undefined 不抛（符号漂移与空列表都要能过）', () => {
  assert.deepEqual(pickOpen(null, 0, null), []);
  assert.deepEqual(orderLikeGame(undefined), []);
});

// ── ACL 投影层（cq26ExcavSites）：字段形态与单例重建 ────────────────────
/**
 * 造一个假 CQ26NeutralController 类：只提供 getInstance 与三个私有态字段，
 * 让投影里「claimed 命中、mSid 归属、cityConfigId 取名」这几行真跑一遍。
 * @param {object} state 初始实例态（_excavOpenSiteList / _claimedSiteIds / _selfInfo）
 * @returns {Function} 类（getInstance 返回当前实例；__setInst 换实例 = 模拟游戏侧 purge 重建）
 */
function fakeCtrl(state) {
  let inst = Object.assign({}, state);
  const C = function () {};
  C.getInstance = () => inst;
  C.__setInst = (s) => {
    inst = Object.assign({}, s);
  };
  return C;
}

// probe 命中即永久缓存「类」，故本段全部用例共用同一个类对象（实例可随时重建，类不能换）。
const fakeCtor = fakeCtrl({
  _excavOpenSiteList: [],
  _claimedSiteIds: [],
  _selfInfo: { mSid: 3828 },
});
const realGameGet = game.get;
game.get = (name) =>
  name === 'CQ26NeutralController' ? { __esModule: true, default: fakeCtor } : null;
after(() => {
  game.get = realGameGet;
});

test('ACL 投影：claimed 命中/mSid 为字符串时的本服归属/cityConfigId 取名均正确', () => {
  fakeCtor.__setInst({
    _excavOpenSiteList: [
      {
        siteId: 'a_1',
        cityId: 140138,
        cityConfigId: 1015,
        ownerSid: 3828,
        endTime: 200,
        pos: { x: 3, y: 4, k: 1 },
      },
      {
        siteId: 'b_2',
        cityId: 140064,
        cityCfgId: 1018,
        ownerSid: 3281,
        endTime: 100,
        pos: { x: 5, y: 6, k: 2 },
      },
    ],
    _claimedSiteIds: ['b_2'],
    // mSid 故意给字符串：游戏原式用 ==，投影侧必须 Number 化后才能与 ownerSid 比得出
    _selfInfo: { mSid: '3828' },
  });
  const sites = gameData.cq26ExcavSites();
  assert.equal(sites.length, 2);
  const a = sites[0];
  const b = sites[1];
  assert.equal(a.claimed, false);
  assert.equal(a.ownServer, true, 'mSid 字符串形态下仍要判为本服');
  assert.equal(a.cfgId, 1015, '22062 行里叫 cityConfigId');
  assert.equal(b.claimed, true, '_claimedSiteIds 命中');
  assert.equal(b.ownServer, false);
  assert.equal(b.cfgId, 1018, '地图地块那套叫 cityCfgId，两个名字都要接');
  assert.deepEqual([a.x, a.y, a.k], [3, 4, 1]);
});

test('ACL 投影：游戏侧 purge 重建单例后，投影必须跟上新实例（不得钉在僵尸对象上）', () => {
  // 回归护栏：ResetGame.purgeData() 里 `He.default.getInstance().purge()` 会把静态 instance 置 null。
  //   若 probe 缓存的是**实例**，此后投影永远读旧对象（且非 null → 直接屏蔽 22062 回落通道）。
  fakeCtor.__setInst({
    _excavOpenSiteList: [{ siteId: 'old_1', ownerSid: 1, endTime: 100, pos: {} }],
    _claimedSiteIds: [],
    _selfInfo: { mSid: 3828 },
  });
  assert.equal(gameData.cq26ExcavSites()[0].siteId, 'old_1');
  fakeCtor.__setInst({
    _excavOpenSiteList: [
      { siteId: 'new_9', ownerSid: 3828, endTime: 900, pos: { x: 7, y: 8, k: 3 } },
    ],
    _claimedSiteIds: [],
    _selfInfo: { mSid: 3828 },
  });
  const after2 = gameData.cq26ExcavSites();
  assert.equal(after2.length, 1, '投影应只看到新单例的点');
  assert.equal(after2[0].siteId, 'new_9');
  assert.equal(after2[0].ownServer, true);
});
