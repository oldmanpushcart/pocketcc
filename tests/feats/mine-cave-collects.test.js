// mine-cave 挖矿引擎回收通道回归：collects[]（自家采集行军礼包）必须生成 7422 领取任务。
// 背景：#collectTasks 曾漏遍历 collects[]（只拿它算行军名额），礼包红点常亮却永不自动领。
//  fixture 形状取自实录 dashcam-rec-20261116T000925（uid=15596140531952）：t+3728s 的 7428 应答
//  collects 三条 state=4，用户手动逐条 7422 {id} 领讫（雷神元素+紫色经验书/钻石50）。
// 口径对齐游戏 RealMineCaveController.getIsHasReward（末条判据=collects 非空）；
// state∈{3,4} 才领（与 toOthers/toOtherCollects 同构），state=2 采集中不领（负例）。
// 全部不摸游戏符号、不发真包：env.ask 走桩；浏览器全局最小桩化后动态 import（同 cq26-wl-mine 口径）。
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
// 引擎自调度 setTimeout 登记在册：用例收尾统一清掉，防扫描链把测试进程挂住。
const realSetTimeout = globalThis.setTimeout;
const pendingTimers = new Set();
globalThis.setTimeout = (fn, ms, ...rest) => {
  const h = realSetTimeout(fn, ms, ...rest);
  pendingTimers.add(h);
  return h;
};
const realClearTimeout = globalThis.clearTimeout;
globalThis.clearTimeout = (h) => {
  pendingTimers.delete(h);
  return realClearTimeout(h);
};

const { MiningEngine } = await import('../../extension/src/feats/player/mine-cave/mining.js');

// ── 实录形状 fixture（Int64 原样 {_low,_high}，id 逐位取自 7428 应答 collects[]）──
const ID_A = { _low: 1402724918, _high: 284191480, _unsigned: false }; // pos1 specId72 state4
const ID_B = { _low: 1402069554, _high: 284191480, _unsigned: false }; // pos5 specId72 state4
const ID_C = { _low: 1401086496, _high: 284191480, _unsigned: false }; // pos3 specId72 state4
const ID_GATHERING = { _low: 1403000000, _high: 284191480, _unsigned: false }; // 负例：state2 采集中

function collectEntry(id, state, pos) {
  return {
    simpleInfo: {
      id,
      specId: 72,
      state,
      pos,
      gatherType: 0,
      canHelp: 0,
      canSteal: 0,
      canPack: 0,
      lock: 0,
    },
    ownerUid: '15596140531952',
    serverId: 4336,
    helpNum: 0,
    stealNum: 0,
    shareHelp: 0,
    sameAlliance: 0,
  };
}

/** 组装 7428 应答：infos 无 state=3（不产生自矿领取），其余通道全空，礼包只走 collects。 */
function selfInfo(collects) {
  return {
    open: 1,
    infos: [
      {
        simpleInfo: { id: { _low: -685220621, _high: 284191481 }, specId: 72, state: 1, pos: 1 },
        ownerUid: '15596140531952',
      },
    ],
    logNum: 144,
    collects,
    todayRefreshNum: 10,
    haveStealNum: 1,
    canScienceLevelUp: 0,
    toOtherCollects: [],
    toOthers: [],
    todayOccupyNum: 0,
    otherGatherRewardNum: {},
    levelUp: 0,
    haveAllianceReward: 0,
    allianceRewardFirst: 0,
  };
}

/** 桩 env：ask 记录全部发包；7428 回 fixture；无采集规则→占领/探测线不动。 */
function makeEnv(data) {
  const calls = [];
  let alive = true;
  const env = {
    ask: async (cmd, payload) => {
      calls.push({ cmd, payload });
      if (cmd === 7428) return { ok: true, code: 0, data };
      return { ok: true, code: 0, data: {} };
    },
    cfgSeg: () => 0,
    alive: () => alive,
    getRules: () => [],
    getData: () => ({ UserData: { myMarchNumMAX: 5 } }),
    inAlliance: () => true,
    myUid: () => 15596140531952,
    tuning: { hotSlots: [] },
  };
  return { env, calls, stop: () => (alive = false) };
}

/** 轮询等待谓词成立（drain 条间 1200ms 限流，3 条约 2.4s；上限 8s 足够宽）。 */
async function waitUntil(pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => realSetTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

function cleanup() {
  for (const h of pendingTimers) realClearTimeout(h);
  pendingTimers.clear();
}

test('collects 礼包回收：state∈{3,4} 逐条 7422 {id}，state=2 采集中不领', async () => {
  const data = selfInfo([
    collectEntry(ID_A, 4, 1),
    collectEntry(ID_GATHERING, 2, 2), // 负例夹在中间：不得被领
    collectEntry(ID_B, 4, 5),
    collectEntry(ID_C, 3, 3), // state=3 同样可领（与 toOthers 口径同构）
  ]);
  const { env, calls, stop } = makeEnv(data);
  const engine = new MiningEngine(env);
  try {
    engine.start({ on: { push() {} } });
    await waitUntil(() => calls.filter((c) => c.cmd === 7422).length >= 3);
    stop(); // 停 alive：drain 收尾后不再重排扫描
    const rewards = calls.filter((c) => c.cmd === 7422);
    assert.equal(rewards.length, 3, '恰领 3 条礼包（state=2 那条不领）');
    assert.deepEqual(
      rewards.map((c) => c.payload.id),
      [ID_A, ID_B, ID_C],
      '7422 请求 id 与 collects 条目逐位一致（Int64 原样透传）',
    );
    assert.ok(!calls.some((c) => c.cmd === 7424 || c.cmd === 7429), '无他人来采/联盟产出时不误发');
  } finally {
    stop();
    cleanup();
  }
});

test('collects 全为采集中（state=2）：一条 7422 都不发', async () => {
  const data = selfInfo([collectEntry(ID_GATHERING, 2, 2)]);
  const { env, calls, stop } = makeEnv(data);
  const engine = new MiningEngine(env);
  try {
    engine.start({ on: { push() {} } });
    // 等首轮扫描+消费完整跑完（无任务时 consume 立即收尾），再静候一段确认无追加发包。
    await waitUntil(() => calls.some((c) => c.cmd === 7428));
    await new Promise((r) => realSetTimeout(r, 500));
    stop();
    assert.equal(calls.filter((c) => c.cmd === 7422).length, 0);
  } finally {
    stop();
    cleanup();
  }
});

test('panelStatus 只读快照：探测/占领/待领口径与回收同源，零额外发包', async () => {
  const data = selfInfo([
    collectEntry(ID_A, 4, 1),
    collectEntry(ID_GATHERING, 2, 2), // 采集中：不算待领
    collectEntry(ID_B, 4, 5),
    collectEntry(ID_C, 3, 3),
  ]);
  const { env, calls, stop } = makeEnv(data);
  const engine = new MiningEngine(env);
  try {
    // 未启动：无快照，不抛错
    const cold = engine.panelStatus();
    assert.equal(cold.hasSnap, false);
    assert.equal(cold.pending, 0);
    engine.start({ on: { push() {} } });
    await waitUntil(() => calls.filter((c) => c.cmd === 7422).length >= 3);
    await waitUntil(() => !engine.panelStatus().running); // drain 收尾
    const s = engine.panelStatus();
    assert.equal(s.hasSnap, true);
    assert.equal(s.pending, 3, '待领 3 份（state=2 不算；infos 无 state=3）');
    assert.equal(s.refreshUsed, 10, '探测已用读 7428 todayRefreshNum');
    assert.equal(s.occUsed, 0, '占领已用读 7428 todayOccupyNum');
    const n = calls.length;
    engine.panelStatus();
    assert.equal(calls.length, n, 'panelStatus 纯读不发包');
  } finally {
    stop();
    cleanup();
  }
});
