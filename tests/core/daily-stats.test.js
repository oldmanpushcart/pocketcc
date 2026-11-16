// daily-stats 日账原语离线单测：countOnce 多计数键（同一去重事件计「总 + 分类型」）与读回前对账。
// 背景：花车空投面板分类型行改以成功到账为准（21653 去重归型），总与分类型须同 id 同事件入账、
//   跨页重推逐键回抵不重计；单键旧调用形态保持兼容。
// feat/core 模块 import 链会触到浏览器全局（storage/bus/game-api），故先最小桩化 window/document/chrome，再动态 import。
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

// core 链里的 session/net-guard 等模块在 import 期就挂常驻 setInterval——只对测试 harness 的定时器
// unref（否则 node --test 进程永不退出），不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { gameData } = await import('../../extension/src/core/game-api.js');
const { storage } = await import('../../extension/src/core/storage.js');
const { todayStr } = await import('../../extension/src/core/util.js');
const { createDailyLedger } = await import('../../extension/src/core/daily-stats.js');

// 固定服务器秒：日界键稳定，saved.date 可用 todayStr 同式构造
const FIXED_SEC = 1763000000;
gameData.serverTime = () => FIXED_SEC;
const TODAY = todayStr(FIXED_SEC);

/** 读回微任务落地（ensureLoaded 走 Promise.resolve(storage.data.get).then） */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * 桩 storage.data：get 回 saved，set 记录落盘流水；restore 还原。
 * @param {*} saved 盘上日账快照（null=空盘）
 */
function stubStorage(saved) {
  const origGet = storage.data.get;
  const origSet = storage.data.set;
  const writes = [];
  storage.data.get = async () => saved;
  storage.data.set = async (k, v) => {
    writes.push({ key: k, value: v });
  };
  return {
    writes,
    restore() {
      storage.data.get = origGet;
      storage.data.set = origSet;
    },
  };
}

test('countOnce 多键：同 id 总+分类型各计一次，重推不重计；单键旧形态兼容', async () => {
  const s = stubStorage(null);
  try {
    const l = createDailyLedger('pocketcc.daily.test.multi');
    l.ensureLoaded();
    await tick();
    assert.equal(l.loaded(), true);
    assert.equal(l.countOnce('m1', ['arrive', 'arrive_CHIP']), true);
    assert.equal(l.get('arrive'), 1);
    assert.equal(l.get('arrive_CHIP'), 1);
    // 同 id 重推（跨页重推形态）：false 且两键都不动
    assert.equal(l.countOnce('m1', ['arrive', 'arrive_CHIP']), false);
    assert.equal(l.get('arrive'), 1);
    assert.equal(l.get('arrive_CHIP'), 1);
    // 单键旧调用形态不受影响
    assert.equal(l.countOnce('m2', 'arrive'), true);
    assert.equal(l.get('arrive'), 2);
    assert.equal(l.get('arrive_CHIP'), 1);
    // 落盘快照含两键（persist 尾笔即最终值）
    const last = s.writes[s.writes.length - 1];
    assert.equal(last.value.counts.arrive, 2);
    assert.equal(last.value.counts.arrive_CHIP, 1);
  } finally {
    s.restore();
  }
});

test('countOnce 多键读回前：新 id 读回后逐键补算（盘值 + 增量）', async () => {
  const saved = { date: TODAY, counts: { arrive: 5, arrive_CHIP: 3 }, seen: ['old1'] };
  const s = stubStorage(saved);
  try {
    const l = createDailyLedger('pocketcc.daily.test.preload');
    // 读回前到账：先计内存，读回时补算
    assert.equal(l.countOnce('m9', ['arrive', 'arrive_CHIP']), true);
    assert.equal(l.loaded(), false);
    l.ensureLoaded();
    await tick();
    assert.equal(l.loaded(), true);
    assert.equal(l.get('arrive'), 6);
    assert.equal(l.get('arrive_CHIP'), 4);
  } finally {
    s.restore();
  }
});

test('countOnce 多键读回前：盘上 seen 已见的 id 重推，读回逐键回抵不重计', async () => {
  const saved = { date: TODAY, counts: { arrive: 5, arrive_CHIP: 3 }, seen: ['m1'] };
  const s = stubStorage(saved);
  try {
    const l = createDailyLedger('pocketcc.daily.test.reconcile');
    // 读回前重推 m1（盘上已计）+ 新 id m9：读回后 m1 两键回抵、m9 两键补算
    assert.equal(l.countOnce('m1', ['arrive', 'arrive_CHIP']), true);
    assert.equal(l.countOnce('m9', ['arrive', 'arrive_CHIP']), true);
    l.ensureLoaded();
    await tick();
    assert.equal(l.get('arrive'), 6); // 5 + m9，m1 回抵
    assert.equal(l.get('arrive_CHIP'), 4); // 3 + m9，m1 回抵
    // 读回后再推 m1：seen 已含，false 不动
    assert.equal(l.countOnce('m1', ['arrive', 'arrive_CHIP']), false);
    assert.equal(l.get('arrive'), 6);
    assert.equal(l.get('arrive_CHIP'), 4);
  } finally {
    s.restore();
  }
});

test('countOnce 多键跳日：新的一天 counts/seen 全清，旧 id 可再计', async () => {
  const saved = { date: '2000-01-01', counts: { arrive: 5, arrive_CHIP: 3 }, seen: ['m1'] };
  const s = stubStorage(saved);
  try {
    const l = createDailyLedger('pocketcc.daily.test.roll');
    l.ensureLoaded();
    await tick();
    assert.equal(l.get('arrive'), 0);
    assert.equal(l.get('arrive_CHIP'), 0);
    assert.equal(l.countOnce('m1', ['arrive', 'arrive_CHIP']), true);
    assert.equal(l.get('arrive'), 1);
    assert.equal(l.get('arrive_CHIP'), 1);
  } finally {
    s.restore();
  }
});
