// 每周免费套装金币离线回归：3963 查询 → 3965 免费载荷 → 3963 权威归零 → UID 周戳。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

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
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { gameData } = await import('../../extension/src/core/game-api.js');
const { storage } = await import('../../extension/src/core/storage.js');
const { MENU, collectFeatureIds } = await import('../../extension/src/core/menu.js');
const { reactor } = await import('../../extension/src/core/reactor.js');
const feat = await import('../../extension/src/feats/player/decoration-free-gift/index.js');
const { CODE_NOT_SENT } = await import('../../extension/src/core/util.js');

const orig = {
  serverTime: gameData.serverTime,
  nextWeeklyResetTs: gameData.nextWeeklyResetTs,
  decorationFreeGift: gameData.decorationFreeGift,
  dataGet: storage.data.get,
  dataSet: storage.data.set,
};
const NOW = 1794585900; // 2026-11-14 周六 UTC+8
let now;
let sent;
let respond;
let stamps;
let alive;
let queries;

function nextReset(from) {
  const t = from == null ? now : Number(from) || 0;
  const day = Math.floor((t - 57600) / 86400);
  return (day - ((((day - 3) % 7) + 7) % 7)) * 86400 + 57600 + 7 * 86400;
}
const fakeNet = {
  install: () => true,
  sendGuarded: async (cmd, data, opts) => {
    sent.push({ cmd, data, protocol: opts.protocol });
    return respond(cmd, data);
  },
};
feat.installForTest({ alive: () => alive, net: fakeNet });

beforeEach(() => {
  now = NOW;
  sent = [];
  stamps = new Map();
  alive = true;
  queries = 0;
  gameData.serverTime = () => now;
  gameData.nextWeeklyResetTs = nextReset;
  gameData.decorationFreeGift = (info) =>
    info && info.canGetFreeNum != null ? { canGetFreeNum: Number(info.canGetFreeNum) } : null;
  storage.data.get = async (key) => stamps.get(key);
  storage.data.set = async (key, value) => stamps.set(key, value);
  respond = (cmd) => {
    if (cmd === 3963) {
      queries++;
      return {
        ok: true,
        code: 0,
        data: {
          decorationContentShopGetInfo: { canGetFreeNum: queries > 1 ? 0 : 1 },
        },
      };
    }
    return {
      ok: true,
      code: 0,
      data: { decorationContentShopFreeGet: { reward: { items: [] } } },
    };
  };
  feat.resetForTest();
});
afterEach(() => {
  Object.assign(gameData, {
    serverTime: orig.serverTime,
    nextWeeklyResetTs: orig.nextWeeklyResetTs,
    decorationFreeGift: orig.decorationFreeGift,
  });
  storage.data.get = orig.dataGet;
  storage.data.set = orig.dataSet;
});

test('面板集成：玩家基础设置、注册、默认关闭', () => {
  assert.ok(collectFeatureIds({ children: MENU }).includes('decorationFreeGift'));
  const spec = reactor.list().find((s) => s.id === 'decorationFreeGift');
  assert.equal(spec.defaults.enabled, false);
});

test('3963→3965→3963：精确 PB 外形，免费领取只发 header，权威归零落周戳', async () => {
  assert.ok((await feat.cycleRun()) > 0);
  assert.deepEqual(sent, [
    {
      cmd: 3963,
      data: { header: {}, decorationContentShopGetInfo: { reqType: 1 } },
      protocol: 'sendPB',
    },
    { cmd: 3965, data: { header: {} }, protocol: 'sendPB' },
    {
      cmd: 3963,
      data: { header: {}, decorationContentShopGetInfo: { reqType: 1 } },
      protocol: 'sendPB',
    },
  ]);
  assert.deepEqual(stamps.get('decorationFreeGift.resolved'), {
    resetTs: nextReset(),
    claimed: true,
  });
  await feat.cycleRun();
  assert.equal(sent.length, 3);
});

test('3963 额度为 0：不发 3965，直接落已解决周戳', async () => {
  respond = () => ({
    ok: true,
    code: 0,
    data: { decorationContentShopGetInfo: { canGetFreeNum: 0 } },
  });
  await feat.cycleRun();
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [3963],
  );
  assert.deepEqual(stamps.get('decorationFreeGift.resolved'), {
    resetTs: nextReset(),
    claimed: false,
  });
});

test('3963 CODE_NOT_SENT：短重试，不发 3965、不落周戳', async () => {
  respond = () => ({ ok: false, code: CODE_NOT_SENT });
  assert.equal(await feat.cycleRun(), 20000);
  assert.deepEqual(
    sent.map((s) => s.cmd),
    [3963],
  );
  assert.equal(stamps.size, 0);
});

test('3965 业务拒绝：不落周戳，15 分钟后再查', async () => {
  respond = (cmd) =>
    cmd === 3963
      ? { ok: true, code: 0, data: { decorationContentShopGetInfo: { canGetFreeNum: 1 } } }
      : { ok: false, code: 3001, reason: 'not ready' };
  assert.equal(await feat.cycleRun(), 15 * 60 * 1000);
  assert.equal(stamps.size, 0);
});

test('3965 后额度仍大于 0：不谎报完成，20 秒后重新查询', async () => {
  respond = (cmd) =>
    cmd === 3965
      ? { ok: true, code: 0, data: { decorationContentShopFreeGet: { reward: {} } } }
      : { ok: true, code: 0, data: { decorationContentShopGetInfo: { canGetFreeNum: 1 } } };
  assert.equal(await feat.cycleRun(), 20000);
  assert.equal(stamps.size, 0);
});

test('3965 回执缺少业务体：仍重查 3963，不依赖空 reward 判成功', async () => {
  respond = (cmd) => {
    if (cmd === 3965) return { ok: true, code: 0, data: {} };
    queries++;
    return {
      ok: true,
      code: 0,
      data: { decorationContentShopGetInfo: { canGetFreeNum: queries > 1 ? 0 : 1 } },
    };
  };
  await feat.cycleRun();
  assert.equal(stamps.get('decorationFreeGift.resolved').claimed, true);
});

test('领取后重查 CODE_NOT_SENT：不落周戳，避免空应答假完成', async () => {
  respond = (cmd) => {
    if (cmd === 3965) return { ok: true, code: 0, data: { decorationContentShopFreeGet: {} } };
    if (queries++) return { ok: false, code: CODE_NOT_SENT };
    return { ok: true, code: 0, data: { decorationContentShopGetInfo: { canGetFreeNum: 1 } } };
  };
  assert.equal(await feat.cycleRun(), 20000);
  assert.equal(stamps.size, 0);
});

test('跨周回执丢弃旧周戳，新周重新查询', async () => {
  const oldReset = nextReset();
  respond = (cmd) => {
    if (cmd === 3963) {
      queries++;
      if (queries > 1) now = oldReset + 120;
      return {
        ok: true,
        code: 0,
        data: { decorationContentShopGetInfo: { canGetFreeNum: queries > 1 ? 0 : 1 } },
      };
    }
    return { ok: true, code: 0, data: { decorationContentShopFreeGet: { reward: {} } } };
  };
  assert.equal(await feat.cycleRun(), 1000);
  assert.equal(stamps.size, 0);
});

test('成功回执期间暂停仍保存，恢复后不重复领取', async () => {
  respond = (cmd) => {
    if (cmd === 3965) alive = false;
    if (cmd === 3963) {
      queries++;
      return {
        ok: true,
        code: 0,
        data: { decorationContentShopGetInfo: { canGetFreeNum: queries > 1 ? 0 : 1 } },
      };
    }
    return { ok: true, code: 0, data: { decorationContentShopFreeGet: { reward: {} } } };
  };
  assert.equal(await feat.cycleRun(), 0);
  assert.equal(stamps.size, 1);
  alive = true;
  await feat.cycleRun();
  assert.equal(sent.length, 3);
});

test('刷新后回读周戳，首拍零发包', async () => {
  await feat.cycleRun();
  sent = [];
  feat.resetForTest();
  await feat.loadStampForTest();
  await feat.cycleRun();
  assert.equal(sent.length, 0);
});
