// 至尊月卡（每日礼包 + 广告特权 x2 双链）/ 每日与每周服务器日界刷新回归测试。
// 使用公开客户端源码确认的协议形态，不连接游戏服务器；重点锁定跨日防重领与未发出重试。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '', reload() {} },
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

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { gameData, l10n } = await import('../../extension/src/core/game-api.js');
const { storage } = await import('../../extension/src/core/storage.js');
const { MENU, collectFeatureIds } = await import('../../extension/src/core/menu.js');
const { reactor } = await import('../../extension/src/core/reactor.js');
const reactorIsRunning = reactor.isRunning;
const monthly = await import('../../extension/src/feats/player/monthly-card/index.js');
const refresh = await import('../../extension/src/feats/system/daily-refresh/index.js');
const weeklyRefresh = await import('../../extension/src/feats/system/weekly-refresh/index.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const orig = {
  serverTime: gameData.serverTime,
  nextDailyResetTs: gameData.nextDailyResetTs,
  nextWeeklyResetTs: gameData.nextWeeklyResetTs,
  monthlyCard: gameData.monthlyCard,
  level: gameData.level,
  tableReady: l10n.tableReady,
  tableRows: l10n.tableRows,
  dataGet: storage.data.get,
  dataSet: storage.data.set,
};

const DAY_START = 1794585600; // 2026-11-14 00:00:00 服务器秒（UTC+8）
const NOW = DAY_START + 300;
const MONTHLY_CARD = { cardId: '5003', endTime: DAY_START + 30 * 86400, nextRewardTime: DAY_START };
const ROWS = [
  { id: 1, times: 2, cd: 60, level: 1 },
  { id: 2, times: 1, cd: 600, level: 1 },
  { id: 3, times: 1, cd: 0, level: 99 },
];

let now;
let cards;
let sent;
let respond;
let stampMap;
let alive;
let roundController;

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  return t ? t - ((t - 57600) % 86400) + 86400 : 0;
}

function nextWeek(from) {
  const t = from == null ? now : Number(from) || 0;
  if (!t) return 0;
  const day = Math.floor((t - 57600) / 86400);
  const sinceMonday = (((day - 3) % 7) + 7) % 7;
  return (day - sinceMonday) * 86400 + 57600 + 7 * 86400;
}

function applyStubs() {
  gameData.serverTime = () => now;
  gameData.nextDailyResetTs = nextReset;
  gameData.nextWeeklyResetTs = nextWeek;
  gameData.monthlyCard = (id) => cards[String(id)] || null;
  gameData.level = () => 10;
  l10n.tableReady = () => true;
  l10n.tableRows = (name) => (name === 'AD_NEW' ? ROWS : []);
  storage.data.get = async (key) => stampMap.get(key);
  storage.data.set = async (key, value) => stampMap.set(key, value);
}

const fakeNet = {
  install: () => true,
  sendGuarded: async (cmd, data, opts) => {
    sent.push({ cmd, data, protocol: opts && opts.protocol });
    return respond(cmd, data);
  },
};
const fakeCtx = {
  alive: () => alive,
  get signal() {
    return roundController ? roundController.signal : null;
  },
  net: fakeNet,
  on: { push() {} },
};
monthly.installForTest(fakeCtx);

function cappedInfo() {
  return [
    { adNewId: 1, viewCount: 2, lastViewTime: now * 1000 },
    { adNewId: 2, viewCount: 1, lastViewTime: now * 1000 },
  ];
}

beforeEach(() => {
  applyStubs();
  now = NOW;
  cards = { 5003: { ...MONTHLY_CARD } };
  sent = [];
  stampMap = new Map();
  alive = true;
  roundController = new AbortController();
  respond = (cmd) => {
    if (cmd === 750) return { ok: true, code: 0, data: JSON.stringify({ reward: {} }) };
    if (cmd === 9706) return { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
    if (cmd === 9708)
      return {
        ok: true,
        code: 0,
        data: { adMonthCardWatchInfos: cappedInfo(), reward: { items: [] } },
      };
    return { ok: true, code: 0, data: {} };
  };
  monthly.resetForTest();
  refresh.resetForTest();
  weeklyRefresh.resetForTest();
  reactor.isRunning = reactorIsRunning;
});

afterEach(() => {
  Object.assign(gameData, {
    serverTime: orig.serverTime,
    nextDailyResetTs: orig.nextDailyResetTs,
    nextWeeklyResetTs: orig.nextWeeklyResetTs,
    monthlyCard: orig.monthlyCard,
    level: orig.level,
  });
  Object.assign(l10n, { tableReady: orig.tableReady, tableRows: orig.tableRows });
  storage.data.get = orig.dataGet;
  storage.data.set = orig.dataSet;
  reactor.isRunning = reactorIsRunning;
});

test('面板集成：至尊月卡与两个日界刷新已注册且挂入对应菜单分组', () => {
  const ids = new Set(collectFeatureIds({ children: MENU }));
  const specs = new Map(reactor.list().map((spec) => [spec.id, spec]));
  assert.ok(!ids.has('adPrivilege'), '广告特权应并入至尊月卡，不再独立挂菜单');
  assert.ok(!specs.has('adPrivilege'), '广告特权应并入至尊月卡，不再独立注册');
  for (const id of ['monthlyCard', 'dailyRefresh', 'weeklyRefresh']) {
    assert.ok(ids.has(id), `${id} 未挂入菜单`);
    const spec = specs.get(id);
    assert.ok(spec, `${id} 未注册 reactor`);
    assert.equal(spec.defaults.enabled, false);
    if (id === 'dailyRefresh' || id === 'weeklyRefresh') {
      assert.equal(spec.places, undefined, '定时刷新不应被场景 places 门控挡住');
      assert.equal(spec.kinds, undefined, '定时刷新不应被秘境等 kind 门控挡住');
    }
    assert.equal(typeof spec.toModuleCfg, 'function');
    assert.deepEqual(spec.toModuleCfg({ enabled: true }), { enabled: true });
    assert.deepEqual(spec.toModuleCfg({ enabled: false }), { enabled: false });
  }
});

test('面板状态行：礼包与广告进度合并为一行，双未生效收敛', () => {
  const spec = reactor.list().find((s) => s.id === 'monthlyCard');
  const text = () => spec.fields[0].get();
  assert.equal(text(), '礼包 0/1 · 广告 —');
  cards['5003'].endTime = now;
  assert.equal(text(), '未生效');
});

test('至尊月卡：active+ready 发送 750/{cardId}，成功落日戳后同日不重发', async () => {
  const delay = await monthly.giftCycleRun();
  assert.ok(delay > 0);
  assert.deepEqual(sent, [{ cmd: 750, data: { cardId: 5003 }, protocol: 'send' }]);
  assert.equal(stampMap.get('monthlyCard.resolved').cardId, 5003);
  await monthly.giftCycleRun();
  assert.equal(sent.length, 1);
});

test('至尊月卡：空/畸形成功回执不落日戳，20 秒后重试', async () => {
  respond = () => ({ ok: true, code: 0, data: '{}' });
  assert.equal(await monthly.giftCycleRun(), 20000);
  assert.equal(stampMap.size, 0);
  respond = () => ({ ok: true, code: 0, data: 'not-json' });
  assert.equal(await monthly.giftCycleRun(), 20000);
  assert.equal(stampMap.size, 0);
  respond = () => ({ ok: true, code: 0, data: JSON.stringify({ reward: {} }) });
  await monthly.giftCycleRun();
  assert.equal(sent.length, 3);
  assert.equal(stampMap.get('monthlyCard.resolved').claimed, true);
});

test('至尊月卡：旧 cardId 或缺失 cardId 的日戳不抑制当前 5003 领取', async () => {
  const legacyStamps = [
    { resetTs: nextReset(), cardId: 15001, claimed: true },
    { resetTs: nextReset(), claimed: true },
  ];
  for (const legacy of legacyStamps) {
    monthly.resetForTest();
    stampMap.set('monthlyCard.resolved', legacy);
    await monthly.loadStampForTest();
    await monthly.giftCycleRun();
  }
  assert.deepEqual(
    sent.map((item) => item.data),
    [{ cardId: 5003 }, { cardId: 5003 }],
  );
});

test('至尊月卡：过期或 nextRewardTime 未到都不发包', async () => {
  cards['5003'].endTime = now;
  assert.ok((await monthly.giftCycleRun()) > 0);
  cards['5003'].endTime = now + 86400;
  cards['5003'].nextRewardTime = now + 60;
  assert.ok((await monthly.giftCycleRun()) > 0);
  assert.equal(sent.length, 0);
});

test('至尊月卡：CODE_NOT_SENT 短重试且不落日戳', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await monthly.giftCycleRun(), 20000);
  assert.equal(stampMap.size, 0);
  await monthly.giftCycleRun();
  assert.equal(sent.length, 2);
});

test('至尊月卡：真正业务拒绝落日戳，避免当天反复敲门', async () => {
  respond = () => ({ ok: false, code: 1001, reason: 'already claimed' });
  await monthly.giftCycleRun();
  await monthly.giftCycleRun();
  assert.equal(sent.length, 1);
  assert.equal(stampMap.get('monthlyCard.resolved').claimed, false);
});

test('至尊月卡：刷新后回读今日日戳可抑制首拍发包', async () => {
  stampMap.set('monthlyCard.resolved', { resetTs: nextReset(), cardId: 5003, claimed: true });
  await monthly.loadStampForTest();
  await monthly.giftCycleRun();
  assert.equal(sent.length, 0);
});

test('至尊月卡：跨日日戳自动解禁', async () => {
  await monthly.giftCycleRun();
  now = nextReset() + 120;
  cards['5003'].nextRewardTime = now - 10;
  await monthly.giftCycleRun();
  assert.equal(sent.length, 2);
});

test('至尊月卡：发包后暂停仍保存成功回执，恢复后不重发', async () => {
  respond = (cmd) => {
    if (cmd === 750) alive = false;
    return { ok: true, code: 0, data: JSON.stringify({ reward: {} }) };
  };
  assert.equal(await monthly.giftCycleRun(), 0);
  assert.equal(stampMap.get('monthlyCard.resolved').claimed, true);
  alive = true;
  await monthly.giftCycleRun();
  assert.equal(sent.length, 1);
});

test('至尊月卡：750 在飞时关闭再开启，旧轮回执仍落盘但不继续调度', async () => {
  const stale = roundController;
  respond = () => {
    alive = false;
    stale.abort();
    alive = true;
    roundController = new AbortController();
    return { ok: true, code: 0, data: JSON.stringify({ reward: {} }) };
  };
  assert.equal(await monthly.giftCycleRun(), 0);
  assert.equal(stampMap.get('monthlyCard.resolved').claimed, true);
  assert.equal(sent.length, 1);
});

test('至尊月卡：成功回执跨午夜时旧日戳不压制次日领取', async () => {
  const roundReset = nextReset();
  respond = (cmd) => {
    if (cmd === 750) {
      now = roundReset + 120;
      cards['5003'].nextRewardTime = now - 10;
    }
    return { ok: true, code: 0, data: JSON.stringify({ reward: {} }) };
  };
  assert.equal(await monthly.giftCycleRun(), 1000);
  assert.equal(stampMap.get('monthlyCard.resolved').resetTs, roundReset);
  await monthly.giftCycleRun();
  assert.equal(sent.length, 2);
});

test('广告特权：广告月卡过期时不发 9706/9708', async () => {
  cards['5003'].endTime = now;
  await monthly.adCycleRun();
  assert.equal(sent.length, 0);
});

test('广告特权：有 ready 奖励时先读 9706，再一次 9708 全领', async () => {
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => [s.cmd, s.protocol]),
    [
      [9706, 'sendPBV2'],
      [9708, 'sendPBV2'],
    ],
  );
  assert.deepEqual(sent[1].data, {});
  await monthly.adCycleRun();
  assert.equal(sent.length, 2);
});

test('广告特权：全部在冷却时只读 9706，不提前全领', async () => {
  respond = (cmd) =>
    cmd === 9706
      ? {
          ok: true,
          code: 0,
          data: {
            adMonthCardWatchInfos: [
              { adNewId: 1, viewCount: 0, lastViewTime: now * 1000 },
              { adNewId: 2, viewCount: 0, lastViewTime: now * 1000 },
            ],
          },
        }
      : { ok: true, code: 0, data: {} };
  const delay = await monthly.adCycleRun();
  assert.ok(delay > 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
});

test('广告特权：兼容合并前 adPrivilege.resolved 日戳，同日不再全领', async () => {
  stampMap.set('adPrivilege.resolved', { resetTs: nextReset(), claimed: false });
  await monthly.loadStampForTest();
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  assert.equal(stampMap.get('monthlyCard.adResolved'), undefined, '只读补读不得改写日戳');
});

test('广告特权：当日已解决时启动补读一次 9706，面板显示权威进度且不再全领', async () => {
  stampMap.set('monthlyCard.adResolved', { resetTs: nextReset(), claimed: true });
  await monthly.loadStampForTest();
  respond = (cmd) => {
    if (cmd === 9706) return { ok: true, code: 0, data: { adMonthCardWatchInfos: cappedInfo() } };
    return { ok: true, code: 0, data: {} };
  };
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  const spec = reactor.list().find((s) => s.id === 'monthlyCard');
  assert.equal(spec.fields[0].get(), '礼包 0/1 · 广告 3/3');
  await monthly.adCycleRun();
  assert.equal(sent.length, 1, '同会话已读回后不再重复补读');
});

test('广告特权：全部 capped 落日戳，同会话同日不再查询', async () => {
  respond = () => ({
    ok: true,
    code: 0,
    data: { adMonthCardWatchInfos: cappedInfo() },
  });
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  assert.equal(stampMap.get('monthlyCard.adResolved').claimed, false);
  await monthly.adCycleRun();
  assert.equal(sent.length, 1);
});

test('广告特权：9708 CODE_NOT_SENT 不落日戳，下一拍重读重试', async () => {
  respond = (cmd) =>
    cmd === 9708
      ? { ok: false, code: CODE_NOT_SENT }
      : { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
  assert.equal(await monthly.adCycleRun(), 20000);
  assert.equal(stampMap.size, 0);
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9708, 9706, 9708],
  );
});

test('广告特权：9706 瞬态未发出只短重试，不发 9708', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await monthly.adCycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  assert.equal(stampMap.size, 0);
});

test('广告特权：业务拒绝落日戳，同日不再查询', async () => {
  respond = (cmd) =>
    cmd === 9708
      ? { ok: false, code: 2001, reason: 'not ready' }
      : { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
  await monthly.adCycleRun();
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9708],
  );
});

test('广告特权：9706 返回期间暂停则不继续发 9708', async () => {
  let first = true;
  respond = (cmd) => {
    if (cmd === 9706) {
      if (first) {
        first = false;
        alive = false;
      }
      return { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
    }
    return { ok: true, code: 0, data: { adMonthCardWatchInfos: cappedInfo() } };
  };
  assert.equal(await monthly.adCycleRun(), 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  assert.equal(stampMap.size, 0);
  alive = true;
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9706, 9708],
  );
});

test('广告特权：9706 在飞时关闭再开启，旧轮应答不继续发 9708', async () => {
  const stale = roundController;
  respond = (cmd) => {
    if (cmd === 9706) {
      alive = false;
      stale.abort();
      alive = true;
      roundController = new AbortController();
    }
    return { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
  };
  assert.equal(await monthly.adCycleRun(), 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  assert.equal(stampMap.size, 0);
});

test('广告特权：9706 畸形应答按本地解析失败巡检，不当成服务器拒绝', async () => {
  respond = () => ({ ok: true, code: 0, data: {} });
  assert.equal(await monthly.adCycleRun(), 15 * 60 * 1000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  assert.equal(stampMap.size, 0);
});

test('广告特权：9708 只领当前 ready，剩余冷却槽继续排程且不落日戳', async () => {
  respond = (cmd) => {
    if (cmd === 9706) {
      return {
        ok: true,
        code: 0,
        data: {
          adMonthCardWatchInfos: [
            { adNewId: 1, viewCount: 0, lastViewTime: (now - 60) * 1000 },
            { adNewId: 2, viewCount: 0, lastViewTime: now * 1000 },
          ],
        },
      };
    }
    return {
      ok: true,
      code: 0,
      data: {
        adMonthCardWatchInfos: [{ adNewId: 1, viewCount: 1, lastViewTime: now * 1000 }],
        reward: { items: [] },
      },
    };
  };
  assert.equal(await monthly.adCycleRun(), 63000);
  assert.equal(stampMap.size, 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9708],
  );
});

test('广告特权：9708 应答缺少进度时乐观推进，下轮权威读取纠正且不连发', async () => {
  let reads = 0;
  respond = (cmd) => {
    if (cmd === 9706) {
      reads++;
      return {
        ok: true,
        code: 0,
        data: {
          adMonthCardWatchInfos:
            reads === 1
              ? []
              : [
                  { adNewId: 1, viewCount: 1, lastViewTime: now * 1000 },
                  { adNewId: 2, viewCount: 1, lastViewTime: now * 1000 },
                ],
        },
      };
    }
    return { ok: true, code: 0, data: { reward: { items: [] } } };
  };
  assert.equal(await monthly.adCycleRun(), 63000);
  assert.equal(stampMap.size, 0);
  assert.equal(await monthly.adCycleRun(), 63000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9708, 9706],
  );
});

test('广告特权：9708 成功后暂停仍保存已解决日戳，恢复后只读不重领', async () => {
  respond = (cmd) => {
    if (cmd === 9706) return { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
    alive = false;
    return { ok: true, code: 0, data: { adMonthCardWatchInfos: cappedInfo() } };
  };
  assert.equal(await monthly.adCycleRun(), 0);
  assert.equal(stampMap.get('monthlyCard.adResolved').claimed, true);
  alive = true;
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9708],
  );
});

test('广告特权：9706 查询跨午夜时丢弃旧日进度，下一拍重读', async () => {
  const roundReset = nextReset();
  let first = true;
  respond = (cmd) => {
    if (cmd === 9706) {
      if (first) {
        first = false;
        now = roundReset + 120;
      }
      return { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
    }
    return { ok: true, code: 0, data: { adMonthCardWatchInfos: cappedInfo() } };
  };
  assert.equal(await monthly.adCycleRun(), 1000);
  assert.equal(stampMap.size, 0);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706],
  );
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9706, 9708],
  );
});

test('广告特权：9708 成功回执跨午夜时不落旧日戳，次日可重新领取', async () => {
  const roundReset = nextReset();
  let claims = 0;
  respond = (cmd) => {
    if (cmd === 9706) return { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
    claims++;
    if (claims === 1) now = roundReset + 120;
    return { ok: true, code: 0, data: { adMonthCardWatchInfos: cappedInfo() } };
  };
  assert.equal(await monthly.adCycleRun(), 1000);
  assert.equal(stampMap.size, 0);
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9708, 9706, 9708],
  );
});

test('广告特权：9708 业务拒绝跨午夜时不把旧日拒领取记成次日已解决', async () => {
  const roundReset = nextReset();
  let claims = 0;
  respond = (cmd) => {
    if (cmd === 9708) {
      claims++;
      if (claims === 1) now = roundReset + 120;
      return { ok: false, code: 2001, reason: 'not ready' };
    }
    return { ok: true, code: 0, data: { adMonthCardWatchInfos: [] } };
  };
  assert.equal(await monthly.adCycleRun(), 1000);
  assert.equal(stampMap.size, 0);
  await monthly.adCycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [9706, 9708, 9706, 9708],
  );
});

test('每日刷新：未到服务器零点只排程，不刷新', () => {
  let reloads = 0;
  refresh.resetForTest(
    () => reloads++,
    () => true,
  );
  const delay = refresh.cycleRun();
  assert.ok(delay > 0 && delay <= 2 * 60 * 60 * 1000);
  assert.equal(reloads, 0);
});

test('每日刷新：零点缓冲到达后刷新一次，同拍不重复', () => {
  let reloads = 0;
  refresh.resetForTest(
    () => reloads++,
    () => true,
  );
  refresh.cycleRun(); // 先锚定今日日界，模拟 cycle 已睡到 00:01
  now = nextReset() + 60;
  assert.ok(refresh.cycleRun() > 0);
  assert.equal(reloads, 1);
  assert.ok(refresh.cycleRun() > 0);
  assert.equal(reloads, 1);
});

test('每日刷新：pause 后到点不刷新', () => {
  let reloads = 0;
  refresh.resetForTest(
    () => reloads++,
    () => false,
  );
  refresh.cycleRun();
  now = nextReset() + 60;
  assert.equal(refresh.cycleRun(), 0);
  assert.equal(reloads, 0);
});

test('每日刷新：服务器时钟不可用时安全巡检', () => {
  let reloads = 0;
  refresh.resetForTest(
    () => reloads++,
    () => true,
  );
  now = 0;
  assert.equal(refresh.cycleRun(), 15 * 60 * 1000);
  assert.equal(reloads, 0);
});

test('每周刷新：未到服务器周一零点只排程，不刷新', () => {
  let reloads = 0;
  weeklyRefresh.resetForTest(
    () => reloads++,
    () => true,
  );
  const delay = weeklyRefresh.cycleRun();
  assert.ok(delay > 0 && delay <= 2 * 60 * 60 * 1000);
  assert.equal(reloads, 0);
});

test('每周刷新：周一缓冲到达后刷新一次，同拍不重复', () => {
  let reloads = 0;
  weeklyRefresh.resetForTest(
    () => reloads++,
    () => true,
  );
  weeklyRefresh.cycleRun(); // 锚定下周界，模拟已睡到周一 00:01
  now = nextWeek() + 60;
  assert.ok(weeklyRefresh.cycleRun() > 0);
  assert.equal(reloads, 1);
  assert.ok(weeklyRefresh.cycleRun() > 0);
  assert.equal(reloads, 1);
});

test('每周刷新：暂停后到点不刷新', () => {
  let reloads = 0;
  weeklyRefresh.resetForTest(
    () => reloads++,
    () => false,
  );
  weeklyRefresh.cycleRun();
  now = nextWeek() + 60;
  assert.equal(weeklyRefresh.cycleRun(), 0);
  assert.equal(reloads, 0);
});

test('每周刷新：每日刷新同拍运行时让位，不重复触发整页导航', () => {
  let reloads = 0;
  weeklyRefresh.resetForTest(
    () => reloads++,
    () => true,
  );
  reactor.isRunning = (id) => id === 'dailyRefresh';
  weeklyRefresh.cycleRun();
  now = nextWeek() + 60;
  assert.ok(weeklyRefresh.cycleRun() > 0);
  assert.equal(reloads, 0);
});

test('每周刷新：服务器时钟不可用时安全巡检', () => {
  let reloads = 0;
  weeklyRefresh.resetForTest(
    () => reloads++,
    () => true,
  );
  now = 0;
  assert.equal(weeklyRefresh.cycleRun(), 15 * 60 * 1000);
  assert.equal(reloads, 0);
});
