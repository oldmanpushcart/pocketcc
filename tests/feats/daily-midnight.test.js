// 每日补给 / 每日特惠 0 点判据回归单测（事故复刻：dashcam-log 20261112~14）。
// 断言的是「日切判据决策」，不含择时曲线与发包形态（后者由 replay 对拍覆盖）：
//   补给：行存在而 time=0 是 ready 不是 capped（旧实现混判 → 0 点首见 times=0 睡整天）；
//         表未加载归 idle；行缺失才 capped；镜像与权威取 rewardTime 较新者；
//         镜像跨日作废（事故复刻 dashcam-log 20261119：昨日尾档 rewardTime 压制今日 0 点重置）；
//         睡越日界的长 wait 截断到日界+缓冲再醒（罢工窗内手动领 3 次全错过）。
//   特惠：日界后字段=1 无今日新鲜回写凭证 → 照发由服务器裁决（旧实现当闸门 → 0 点漏领）；
//         今日观察到 push 翻 1 才省包；日戳抑制当日重发；被拒/成功都睡到次日日界。
// feat 模块 import 链会触到浏览器全局（reactor/storage/bus），故先最小桩化 window/document/chrome，再动态 import。
import { test, beforeEach, afterEach } from 'node:test';
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

const { gameData, l10n } = await import('../../extension/src/core/game-api.js');
const { storage } = await import('../../extension/src/core/storage.js');
const supply = await import('../../extension/src/feats/player/daily-supply/index.js');
const deal = await import('../../extension/src/feats/player/daily-deal/index.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');
const { reactor } = await import('../../extension/src/core/reactor.js');
const { dailyText } = await import('../../extension/src/core/daily-stats.js');

// ── ACL 方法桩：feat 与测试共享同一 gameData/l10n 对象引用，改方法即生效 ──
const orig = {
  timeReward: gameData.timeReward,
  serverTime: gameData.serverTime,
  nextDailyResetTs: gameData.nextDailyResetTs,
  heroDailyDealReceived: gameData.heroDailyDealReceived,
  tableReady: l10n.tableReady,
  tableRow: l10n.tableRow,
};
/** @type {{timeReward:*, serverTime:number, received:*, tableReady:boolean, rows:Object}} 桩态 */
const stub = { timeReward: null, serverTime: 0, received: null, tableReady: true, rows: {} };
/** 应用 ACL 方法桩（feat 与测试共享同一对象引用，改方法即生效）；afterEach 还原，故每测重应用 */
function applyStubs() {
  gameData.timeReward = () => stub.timeReward;
  gameData.serverTime = () => stub.serverTime;
  gameData.heroDailyDealReceived = () => stub.received;
  // 真实日界换算（GAME_DAY_RESET_OFFSET=57600），不桩逻辑只桩时钟
  gameData.nextDailyResetTs = (fromTs) => {
    const t = fromTs == null ? stub.serverTime : Number(fromTs) || 0;
    if (!t) return 0;
    return t - ((t - 57600) % 86400) + 86400;
  };
  l10n.tableReady = () => stub.tableReady;
  l10n.tableRow = (name, id) => (name === 'ONLINE_REWARD' ? stub.rows[String(id)] || null : null);
}

// ── 网络桩：记录发包、按脚本应答 ──────────────────────────────────────
/** @type {Array<{cmd:number, data:*}>} 发包流水 */
const sent = [];
/** @type {function(number):*} 应答脚本（缺省成功） */
let respond = () => ({ ok: true, code: 0, data: {} });
const fakeNet = {
  install: () => true,
  sendGuarded: async (cmd, data) => {
    sent.push({ cmd, data });
    return respond(cmd);
  },
};
// ctx.alive 恒 true：在飞流程正常走完；测试直接驱动 cycleRun/readyInfo 不经 exec，
// 看门狗扫子 60s 才跑一轮，短测内不会介入（定时器已 unref）
const fakeCtx = { alive: () => true, net: fakeNet, on: { push() {} } };
supply.installForTest(fakeCtx);
deal.installForTest(fakeCtx);

// 固定时钟：2026-11-14 00:05:00（本地 UTC+8）= 日切后 5 分钟，事故窗口
const DAY_START = 1794585600; // 11-14 00:00:00 服务器秒（与 dashcam-log-20261114 首条 ts 对齐）
const NOW = DAY_START + 300;

beforeEach(() => {
  applyStubs();
  sent.length = 0;
  respond = () => ({ ok: true, code: 0, data: {} });
  stub.timeReward = null;
  stub.serverTime = NOW;
  stub.received = null;
  stub.tableReady = true;
  stub.rows = {};
  supply.resetForTest();
  deal.resetForTest();
});
afterEach(() => {
  // 还原 ACL，避免污染同进程后续测试文件
  Object.assign(gameData, {
    timeReward: orig.timeReward,
    serverTime: orig.serverTime,
    nextDailyResetTs: orig.nextDailyResetTs,
    heroDailyDealReceived: orig.heroDailyDealReceived,
  });
  Object.assign(l10n, { tableReady: orig.tableReady, tableRow: orig.tableRow });
});

// ── 每日补给 ─────────────────────────────────────────────────────────
test('补给：times=0 且第 1 行 time=0 → ready（0 点事故复刻，旧实现误判 capped）', () => {
  stub.timeReward = { times: 0, rewardTime: DAY_START };
  stub.rows = { 1: { time: 0 }, 2: { time: 60 } };
  const info = supply.readyInfo();
  assert.equal(info.state, 'ready');
  assert.equal(info.times, 0);
});

test('补给：行缺失才 capped（times=36 无第 37 行）', () => {
  stub.timeReward = { times: 36, rewardTime: NOW - 60 };
  stub.rows = { 36: { time: 120 } };
  assert.equal(supply.readyInfo().state, 'capped');
});

test('补给：表未加载 → idle 巡检，不得混判 capped', () => {
  stub.timeReward = { times: 0, rewardTime: DAY_START };
  stub.tableReady = false;
  assert.equal(supply.readyInfo().state, 'idle');
});

test('补给：timeReward 缺失 → idle', () => {
  stub.timeReward = null;
  assert.equal(supply.readyInfo().state, 'idle');
});

test('补给：wait 档按表间隔算剩余（第 2 行 60s，已过 10s → 剩 50s）', () => {
  stub.timeReward = { times: 1, rewardTime: NOW - 10 };
  stub.rows = { 2: { time: 60 } };
  const info = supply.readyInfo();
  assert.equal(info.state, 'wait');
  assert.equal(info.waitMs, 50000);
});

test('补给：直发不回写 → 镜像兜底；权威 rewardTime 追平后镜像让位', async () => {
  stub.timeReward = { times: 0, rewardTime: DAY_START };
  stub.rows = { 1: { time: 0 }, 2: { time: 60 } };
  respond = () => ({
    ok: true,
    code: 0,
    data: JSON.stringify({ reward: {}, timeReward: { times: 1, rewardTime: NOW } }),
  });
  const res = await supply.claimOnce(0);
  assert.equal(res.claimed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cmd, 825);
  // 权威未回写（仍是 times=0）：镜像 times=1 生效 → 查第 2 行进入 wait
  const info = supply.readyInfo();
  assert.equal(info.state, 'wait');
  assert.equal(info.times, 1);
  // 权威追平（日切/重登全量下发更新 rewardTime）：镜像让位
  stub.timeReward = { times: 5, rewardTime: NOW + 10 };
  stub.rows[6] = { time: 300 };
  const info2 = supply.readyInfo();
  assert.equal(info2.times, 5);
  assert.equal(info2.state, 'wait');
});

test('补给：镜像跨日作废——昨日尾档不得压制今日 0 点重置（事故复刻 dashcam-log 20261119）', async () => {
  // 全部经服务器秒驱动（todayStr 不依本地日，依传入 epochSec 的本地字段）；
  // 写入 mirror 时 serverTime=D1+82800（“昨日” 23:00），读取时 serverTime=D1+86430（“今日” 00:00:30）：
  // mirror.day 与新的 todayStr 不同→ 跨日作废。
  const D1 = DAY_START;
  stub.serverTime = D1 + 82800 + 9; // “昨日” 23:00:09
  stub.timeReward = { times: 34, rewardTime: D1 + 82200 };
  stub.rows = { 35: { time: 3600 }, 36: { time: 7200 }, 1: { time: 0 }, 2: { time: 60 } };
  respond = () => ({
    ok: true,
    code: 0,
    data: JSON.stringify({ reward: {}, timeReward: { times: 35, rewardTime: D1 + 82809 } }),
  });
  await supply.claimOnce(34); // 领 #35，mirror={times:35, rewardTime: 昨日23:00:09, day: yesterday-str}
  // 同日内：mirror 生效，查第 36 行 (7200s) 需等，仍在 wait
  assert.equal(supply.readyInfo().state, 'wait');
  assert.equal(supply.readyInfo().times, 35);
  // 跨到今日 0 点：权威经 LOGIN 重置为 {times:0, rewardTime=日界}（时刻上早于 mirror 的昨日 23:00）
  stub.serverTime = D1 + 86430; // “今日” 00:00:30（与写入时的 todayStr 不同日）
  stub.timeReward = { times: 0, rewardTime: D1 + 86400 };
  const info = supply.readyInfo();
  // 旧实现：mirror.rewardTime(昨日 23:00) > 权威(今日 0:00) → 压制 → wait/capped 睡整天
  // 新实现：mirror.day ≠ todayStr(serverTime) → 作废 → 取权威 times=0，第 1 行 time=0 → ready
  assert.equal(info.state, 'ready');
  assert.equal(info.times, 0);
});

test('补给：不跨日的中等 wait 不截断（保护原有择时曲线）', () => {
  // delayFor 内 capAtDayRoll 仅对 >30e3ms 的睡生效；waitMs=5e3 的应原样返回 waitMs+10e3 不超过 WAIT_CAP_MS
  assert.equal(supply.delayFor({ state: 'wait', waitMs: 5000 }), 5000 + 10000);
  // idle 分支（≤30e3 不走截断）： IDLE 档 15min
  assert.equal(supply.delayFor({ state: 'idle' }), 15 * 60 * 1000);
});

// ── 每日特惠 ─────────────────────────────────────────────────────────
test('特惠：0 点字段=1 无今日新鲜凭证 → 照发 9884 由服务器裁决（事故复刻）', async () => {
  stub.received = 1; // 昨日 stale「已领」
  respond = () => ({
    ok: true,
    code: 0,
    data: { reward: { items: [{ itemId: 1, itemCount: 1 }] } },
  });
  const delay = await deal.cycleRun();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cmd, 9884);
  // 领成功后睡到次日日界 + 60s 缓冲
  assert.equal(delay, (DAY_START + 86400 - NOW) * 1000 + 60000);
});

test('特惠：日戳未过 → 零发包睡到日界（当日不重发）', async () => {
  stub.received = 1;
  await deal.cycleRun(); // 首拍领掉，落日戳
  sent.length = 0;
  const delay = await deal.cycleRun();
  assert.equal(sent.length, 0);
  assert.ok(delay > 0);
});

test('特惠：今日观察到 push 翻 1（新鲜凭证）→ 省包零发包', async () => {
  stub.received = 1;
  deal.recordWriteBack('1'); // 今日 push 10053/LOGIN 回写
  const delay = await deal.cycleRun();
  assert.equal(sent.length, 0);
  assert.ok(delay > 0);
});

test('特惠：昨日的新鲜凭证跨日失效 → 新日照发', async () => {
  stub.received = 1;
  stub.serverTime = DAY_START - 3600; // 昨日 23:00 观察到翻 1
  deal.recordWriteBack('1');
  stub.serverTime = NOW; // 跨日
  await deal.cycleRun();
  assert.equal(sent.length, 1);
});

test('特惠：日切重置 0 经迟到 LOGIN 到达 → 凭证翻 0，照发', async () => {
  stub.received = 1;
  deal.recordWriteBack('1'); // 先有昨日/今日已领凭证
  deal.recordWriteBack('0'); // 迟到同步推重置
  await deal.cycleRun();
  assert.equal(sent.length, 1);
});

test('特惠：服务器真拒绝 → 落日戳睡到次日，不逐拍重发', async () => {
  stub.received = 0;
  respond = () => ({ ok: false, code: 4, reason: 'already received' });
  const delay = await deal.cycleRun();
  assert.equal(sent.length, 1);
  assert.equal(delay, (DAY_START + 86400 - NOW) * 1000 + 60000);
  sent.length = 0;
  await deal.cycleRun();
  assert.equal(sent.length, 0);
});

test('特惠：瞬态未发出（CODE_NOT_SENT）→ 20s 短重试，不落日戳', async () => {
  stub.received = 0;
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  const delay = await deal.cycleRun();
  assert.equal(delay, 20000);
  // 未落日戳：下一拍仍尝试
  respond = () => ({ ok: true, code: 0, data: { reward: { items: [] } } });
  await deal.cycleRun();
  assert.equal(sent.length, 2);
});

test('特惠：字段 null/-1（数据未同步/玩法未开）→ 巡检不敲门', async () => {
  stub.received = null;
  assert.equal(await deal.cycleRun(), 900000);
  stub.received = -1;
  assert.equal(await deal.cycleRun(), 900000);
  assert.equal(sent.length, 0);
});

test('特惠：落盘日戳同日恢复 → 刷新首拍零发包（「奖励已领取」toast 事故修复）', async () => {
  const origGet = storage.data.get;
  const origSet = storage.data.set;
  let saved = null;
  storage.data.get = async () => saved;
  storage.data.set = async (k, v) => {
    saved = v;
  };
  try {
    stub.received = 1;
    await deal.cycleRun(); // 会话 A：领成落日戳
    assert.equal(sent.length, 1);
    assert.ok(saved && saved.resetTs > NOW && saved.claimed === true);
    // 会话 B（刷新）：内存态复位、盘保留 → 回读后首拍零发包
    deal.resetForTest();
    sent.length = 0;
    await deal.loadStampForTest();
    const delay = await deal.cycleRun();
    assert.equal(sent.length, 0);
    assert.ok(delay > 0);
    // 跨日戳过期 → 新日照旧探测（0 点漏领防护不回退）
    stub.serverTime = saved.resetTs + 60;
    deal.resetForTest();
    sent.length = 0;
    await deal.loadStampForTest();
    await deal.cycleRun();
    assert.equal(sent.length, 1);
  } finally {
    storage.data.get = origGet;
    storage.data.set = origSet;
  }
});

test('特惠：真拒绝日戳 claimed=false 恢复 → 刷新零发包', async () => {
  const origGet = storage.data.get;
  const origSet = storage.data.set;
  let saved = null;
  storage.data.get = async () => saved;
  storage.data.set = async (k, v) => {
    saved = v;
  };
  try {
    stub.received = 0;
    respond = () => ({ ok: false, code: 3, reason: 'pubilc911' });
    await deal.cycleRun();
    assert.equal(sent.length, 1);
    assert.ok(saved && saved.claimed === false);
    deal.resetForTest();
    sent.length = 0;
    await deal.loadStampForTest();
    await deal.cycleRun();
    assert.equal(sent.length, 0);
  } finally {
    storage.data.get = origGet;
    storage.data.set = origSet;
  }
});

test('特惠：拒领日戳刷新 + 字段=1 → 面板「已完成 1/1」（不再 —）', async () => {
  const origGet = storage.data.get;
  const origSet = storage.data.set;
  let saved = null;
  storage.data.get = async () => saved;
  storage.data.set = async (k, v) => {
    saved = v;
  };
  try {
    stub.received = 1;
    respond = () => ({ ok: false, code: 3, reason: 'pubilc911' });
    await deal.cycleRun(); // 拒领日戳落盘 claimed=false
    deal.resetForTest();
    sent.length = 0;
    await deal.loadStampForTest(); // 模拟刷新
    await deal.cycleRun();
    assert.equal(sent.length, 0);
    const spec = reactor.list().find((s) => s.id === 'dailyDeal');
    assert.equal(spec.fields[0].get(), dailyText(1, 1));
  } finally {
    storage.data.get = origGet;
    storage.data.set = origSet;
  }
});
