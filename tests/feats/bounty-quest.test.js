// 悬赏任务/进度宝箱自动领取回归测试。
// 协议形态来自公开游戏客户端源码；不连接服务器，重点锁定直发防重领、跨日与 pause/resume。
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

const { gameData } = await import('../../extension/src/core/game-api.js');
const { MENU, collectFeatureIds } = await import('../../extension/src/core/menu.js');
const { reactor } = await import('../../extension/src/core/reactor.js');
const bounty = await import('../../extension/src/feats/player/bounty-quest/index.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const orig = {
  serverTime: gameData.serverTime,
  nextDailyResetTs: gameData.nextDailyResetTs,
  dailyQuests: gameData.dailyQuests,
  dailyQuestFinishCount: gameData.dailyQuestFinishCount,
  dailyQuestBoxStates: gameData.dailyQuestBoxStates,
  myUidStr: gameData.myUidStr,
  functionOn: gameData.functionOn,
};

const DAY_START = 1794585600; // 2026-11-14 00:00:00 服务器秒（UTC+8）
const NOW = DAY_START + 300;

let now;
let quests;
let boxes;
let oneClick;
let uid;
let sent;
let respond;
let alive;
let roundController;

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  return t ? t - ((t - 57600) % 86400) + 86400 : 0;
}

function applyStubs() {
  gameData.serverTime = () => now;
  gameData.nextDailyResetTs = nextReset;
  gameData.dailyQuests = () => quests;
  gameData.dailyQuestFinishCount = () => 10;
  gameData.dailyQuestBoxStates = () => boxes;
  gameData.myUidStr = () => uid;
  gameData.functionOn = (key) => (key === 'dailytask_one_click' ? oneClick : false);
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
};
bounty.installForTest(fakeCtx);

function task(id, progress = 1, state = 1) {
  return { id: String(id), progress, state };
}

function taskAck(ids, extra = {}) {
  return {
    ok: true,
    code: 0,
    data: JSON.stringify({
      dailyQuestDelIds: ids,
      newDailyQuests: [],
      dailyQuestFinishCount: 10,
      box1: 2,
      box2: 2,
      box3: 2,
      box4: 2,
      ...extra,
    }),
  };
}

beforeEach(() => {
  applyStubs();
  now = NOW;
  quests = [];
  boxes = [0, 0, 0, 0];
  oneClick = false;
  uid = 'uid-a';
  sent = [];
  alive = true;
  roundController = new AbortController();
  respond = (cmd, data) => {
    if (cmd === 315) return taskAck(quests.filter((q) => q.state === 1).map((q) => q.id));
    if (cmd === 316)
      return {
        ok: true,
        code: 0,
        data: { rewardInfos: [{ boxId: 1, boxStatus: 2 }], rewardResult: {} },
      };
    if (cmd === 304)
      return { ok: true, code: 0, data: JSON.stringify({ boxId: data.boxId, status: 2 }) };
    return { ok: true, code: 0, data: {} };
  };
  bounty.resetForTest();
});

afterEach(() => {
  Object.assign(gameData, {
    serverTime: orig.serverTime,
    nextDailyResetTs: orig.nextDailyResetTs,
    dailyQuests: orig.dailyQuests,
    dailyQuestFinishCount: orig.dailyQuestFinishCount,
    dailyQuestBoxStates: orig.dailyQuestBoxStates,
    myUidStr: orig.myUidStr,
    functionOn: orig.functionOn,
  });
});

test('面板集成：悬赏任务自动领取已注册并挂入玩家基础设置', () => {
  const ids = new Set(collectFeatureIds({ children: MENU }));
  const spec = reactor.list().find((item) => item.id === 'bountyQuest');
  assert.ok(ids.has('bountyQuest'));
  assert.ok(spec);
  assert.equal(spec.defaults.enabled, false);
  assert.equal(spec.places, undefined);
  assert.equal(spec.kinds, undefined);
  assert.equal(spec.offInCombat, false);
  assert.deepEqual(spec.toModuleCfg({ enabled: true }), { enabled: true });
});

test('没有可领任务或宝箱时不发包', async () => {
  quests = [task(101, 0, 0), task(102, 1, 2)];
  assert.equal(await bounty.cycleRun(), 30 * 1000);
  assert.equal(sent.length, 0);
});

test('已完成任务走 315/{}，成功后同一状态不重复领取', async () => {
  quests = [task(101), task(102, 0, 0)];
  assert.equal(await bounty.cycleRun(), 1000);
  assert.deepEqual(sent, [{ cmd: 315, data: {}, protocol: 'send' }]);
  await bounty.cycleRun();
  assert.equal(sent.length, 1);
});

test('315 应答暴露新可领宝箱时，同一轮继续按 316 一键领取', async () => {
  quests = [task(101)];
  oneClick = true;
  respond = (cmd) =>
    cmd === 315
      ? taskAck(['101'], { box1: 1 })
      : {
          ok: true,
          code: 0,
          data: { rewardInfos: [{ boxId: 1, boxStatus: 2 }], rewardResult: {} },
        };
  await bounty.cycleRun();
  assert.deepEqual(
    sent.map((item) => [item.cmd, item.data, item.protocol]),
    [
      [315, {}, 'send'],
      [316, {}, 'sendPBV2'],
    ],
  );
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('dailytask_one_click 未开启时逐箱走 304/{boxId}，成功后不重复', async () => {
  boxes = [1, 0, 1, 0];
  await bounty.cycleRun();
  assert.deepEqual(sent, [
    { cmd: 304, data: { boxId: 1 }, protocol: 'send' },
    { cmd: 304, data: { boxId: 3 }, protocol: 'send' },
  ]);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('304 应答仍为可领态时不伪标已领，下一轮继续重试', async () => {
  boxes = [1, 0, 0, 0];
  respond = () => ({ ok: true, code: 0, data: JSON.stringify({ boxId: 1, status: 1 }) });
  assert.equal(await bounty.cycleRun(), 30 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.cmd === 304 && item.data.boxId === 1));
});

test('304 应答缺少 status 时不伪标已领，下一轮继续重试', async () => {
  boxes = [1, 0, 0, 0];
  respond = () => ({ ok: true, code: 0, data: JSON.stringify({ boxId: 1 }) });
  assert.equal(await bounty.cycleRun(), 30 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.cmd === 304 && item.data.boxId === 1));
});

test('315 部分删除应答只标记实际返回的任务，剩余任务下一拍继续领取', async () => {
  quests = [task(101), task(102)];
  respond = (cmd) =>
    cmd === 315 ? taskAck(['101']) : taskAck(quests.filter((q) => q.state === 1).map((q) => q.id));
  await bounty.cycleRun();
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.cmd === 315));
});

test('315 成功但删除列表为空时不伪标已领，下一轮继续重试', async () => {
  quests = [task(101)];
  respond = () => taskAck([]);
  assert.equal(await bounty.cycleRun(), 30 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.cmd === 315));
});

test('315 应答缺少删除列表时不伪标已领，下一轮继续重试', async () => {
  quests = [task(101)];
  respond = () => ({ ok: true, code: 0, data: JSON.stringify({}) });
  assert.equal(await bounty.cycleRun(), 30 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.cmd === 315));
});

test('315 应答中的 newly-ready 任务会在快速复扫时继续领取', async () => {
  quests = [task(101)];
  let round = 0;
  respond = (cmd) => {
    if (cmd !== 315) return { ok: true, code: 0, data: {} };
    round++;
    return round === 1
      ? taskAck(['101'], { newDailyQuests: [{ id: 103, progress: 1, status: 1 }] })
      : taskAck(['103']);
  };
  assert.equal(await bounty.cycleRun(), 1000);
  assert.equal(await bounty.cycleRun(), 1000);
  assert.equal(sent.length, 2);
});

test('315 CODE_NOT_SENT 短重试且不标记已领', async () => {
  quests = [task(101)];
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await bounty.cycleRun(), 20 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('316 CODE_NOT_SENT 短重试且不标记宝箱', async () => {
  boxes = [1, 0, 0, 0];
  oneClick = true;
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await bounty.cycleRun(), 20 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('任务真正业务拒绝按 info 语义退避，不伪标已领', async () => {
  quests = [task(101)];
  respond = () => ({ ok: false, code: 2001, reason: 'not ready' });
  assert.equal(await bounty.cycleRun(), 15 * 60 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('单箱业务拒绝不阻断其余宝箱领取', async () => {
  boxes = [1, 1, 0, 0];
  respond = (cmd, data) =>
    data.boxId === 1
      ? { ok: false, code: 2001, reason: 'not ready' }
      : { ok: true, code: 0, data: JSON.stringify({ boxId: 2, status: 2 }) };
  assert.equal(await bounty.cycleRun(), 1000);
  assert.deepEqual(
    sent.map((item) => item.data.boxId),
    [1, 2],
  );
});

test('315 成功但应答畸形时按发包快照抑制重复直发', async () => {
  quests = [task(101)];
  respond = () => ({ ok: true, code: 0, data: 'not-json' });
  await bounty.cycleRun();
  await bounty.cycleRun();
  assert.equal(sent.length, 1);
});

test('316 成功但缺少 rewardInfos 时按发包快照抑制重复直发', async () => {
  boxes = [1, 0, 0, 0];
  oneClick = true;
  respond = () => ({ ok: true, code: 0, data: {} });
  await bounty.cycleRun();
  await bounty.cycleRun();
  assert.equal(sent.length, 1);
});

test('316 成功但 rewardInfos 为空时不伪标已领，下一轮继续重试', async () => {
  boxes = [1, 0, 0, 0];
  oneClick = true;
  respond = () => ({ ok: true, code: 0, data: { rewardInfos: [] } });
  assert.equal(await bounty.cycleRun(), 30 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.cmd === 316));
});

test('316 应答仍为可领态时不伪标已领，下一轮继续重试', async () => {
  boxes = [1, 0, 0, 0];
  oneClick = true;
  respond = () => ({
    ok: true,
    code: 0,
    data: { rewardInfos: [{ boxId: 1, boxStatus: 1 }] },
  });
  assert.equal(await bounty.cycleRun(), 30 * 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.cmd === 316));
});

test('315 在飞时暂停仍保存成功回执，但不继续领取应答暴露的宝箱', async () => {
  quests = [task(101)];
  oneClick = true;
  respond = (cmd) => {
    if (cmd === 315) {
      alive = false;
      return taskAck(['101'], { box1: 1 });
    }
    return { ok: true, code: 0, data: { rewardInfos: [{ boxId: 1, boxStatus: 2 }] } };
  };
  assert.equal(await bounty.cycleRun(), 0);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [315],
  );
  alive = true;
  await bounty.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [315, 316],
  );
});

test('315 在飞时关闭再开启，旧轮回执不继续发宝箱请求', async () => {
  quests = [task(101)];
  oneClick = true;
  const stale = roundController;
  respond = (cmd) => {
    if (cmd === 315) {
      alive = false;
      stale.abort();
      alive = true;
      roundController = new AbortController();
      return taskAck(['101'], { box1: 1 });
    }
    return { ok: true, code: 0, data: { rewardInfos: [{ boxId: 1, boxStatus: 2 }] } };
  };
  assert.equal(await bounty.cycleRun(), 0);
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [315],
  );
});

test('315 回执跨午夜时丢弃旧日结果，次日重新扫描', async () => {
  quests = [task(101)];
  const roundReset = nextReset();
  respond = (cmd) => {
    if (cmd === 315) now = roundReset + 120;
    return taskAck(['101']);
  };
  assert.equal(await bounty.cycleRun(), 1000);
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('服务器日界变化后清空会话防重领集合', async () => {
  quests = [task(101)];
  await bounty.cycleRun();
  now = nextReset() + 120;
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('账号切换后清空会话防重领集合，避免跨 UID 漏领', async () => {
  quests = [task(101)];
  await bounty.cycleRun();
  uid = 'uid-b';
  await bounty.cycleRun();
  assert.equal(sent.length, 2);
});

test('315 应答把宝箱推进为已领态时，本地旧的可领态不会触发 304', async () => {
  quests = [task(101)];
  boxes = [1, 0, 0, 0];
  await bounty.cycleRun();
  assert.deepEqual(
    sent.map((item) => item.cmd),
    [315],
  );
});

test('315 应答暴露本地数组之外的宝箱时仍按 boxId 领取', async () => {
  quests = [task(101)];
  boxes = [0, 0];
  respond = (cmd) =>
    cmd === 315
      ? taskAck(['101'], { box3: 1 })
      : { ok: true, code: 0, data: JSON.stringify({ boxId: 3, status: 2 }) };
  await bounty.cycleRun();
  assert.deepEqual(
    sent.map((item) => [item.cmd, item.data]),
    [
      [315, {}],
      [304, { boxId: 3 }],
    ],
  );
});
