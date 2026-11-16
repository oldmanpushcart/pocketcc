// 异能秘境 1115 · 攻击警告引擎（warn.js）验真 + BOSS 平台档位专项单测。
// 域知识（用户拍板）：BOSS 平台与玩家是 1 局定胜负——面板「警告处置方式」warnMode 决定：
//   立即转移(transfer，缺省)=验真后的攻击警告即撤离（不再无条件豁免 BOSS 点）；抗争到底(stand)=不动作。
//   误告（本点新鲜快照确证无敌方 UID）两档都忽略（与 pilot#warnNoFoeHere 同口径）。
// 桩化口径同 secret-realm-pilot-1115.test.js：最小桩 window/document/chrome 再动态 import。
import { test } from 'node:test';
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

// core/cycle.js 在 import 期挂模块级看门狗 setInterval（浏览器里常驻、Node 里会把测试进程拖到永不退出）
//   ——只对测试 harness 的定时器 unref，不参与被测逻辑（同 auto-farm-mech-build.test.js 范式）。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { WarnEngine } = await import('../../extension/src/feats/activity/secret-realm/warn.js');
const C = await import('../../extension/src/feats/activity/secret-realm/constants.js');

/** 造一台 warn 引擎：base/瓦片/档位可控，sendMarch 记 sent；push 经收集的 handler 直灌。 */
function mkWarn({ mode = 'transfer', base, tiles = [] }) {
  const sent = [];
  const logs = [];
  const log = {};
  for (const lvl of ['info', 'warn', 'error', 'debug']) {
    log[lvl] = (...a) => logs.push(lvl + ': ' + a.join(' '));
  }
  const handlers = new Map();
  const env = {
    alive: () => true,
    realmActive: () => true,
    cfg: () => ({ warn: { enabled: true, mode }, drive: { enabled: false } }),
    secret: {
      getRoomBaseInfo: () => base,
      getNMarchState: () => ({ ARRIVED: 2 }),
      teamIsMooring: () => true,
      isTeamLeader: () => true,
      sendMarch: (x, y) => {
        sent.push({ x, y });
        return Promise.resolve({ ok: true });
      },
    },
    gameData: { myUidStr: () => '111' },
    log,
  };
  const eng = new WarnEngine(env);
  eng.start({ on: { push: (cmd, fn) => handlers.set(cmd, fn) } });
  for (const t of tiles) {
    handlers.get(C.PUSH_TILE_INFO)({ data: { pointInfos: [t] } });
  }
  return {
    eng,
    sent,
    logs,
    warn: (num) => handlers.get(C.PUSH_SELF_ATTACKED)({ data: { num } }),
  };
}
/** 轮询等待（createCycle kick 异步落拍）；超时回 false 不抛，由断言定胜负。 */
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}
const bossBase = {
  startPoint: { x: 100, y: 100 },
  pointType: 176,
  marchState: 2,
  members: [{ uid: '111' }],
};
const bossTile = (teams) => ({ x: 100, y: 100, pointType: 176, m: { state: 0, esrId: 5, teams } });
const tentTile = { x: 110, y: 100, pointType: 175, m: { state: 0, esrId: 5, teams: [] } };

test('warn 验真：BOSS 平台本点无敌 UID 的大 num 警告 → 误告忽略不转移', async () => {
  const w = mkWarn({ base: bossBase, tiles: [bossTile([]), tentTile] });
  try {
    w.warn(25);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.sent.length, 0, '误告不得发 8521');
    assert.ok(
      w.logs.some((s) => s.includes('reason=warn_no_foe')),
      '忽略留痕',
    );
  } finally {
    w.eng.stop();
  }
});

test('warn 立即转移档：BOSS 平台真攻击（本点有敌 UID）→ 撤离到就近营帐（旧 bosspt 豁免已移除）', async () => {
  const w = mkWarn({ base: bossBase, tiles: [bossTile([{ uid: '999' }]), tentTile] });
  try {
    w.warn(3);
    assert.ok(await until(() => w.sent.length >= 1), '真攻击应触发转移');
    assert.deepEqual(w.sent[0], { x: 110, y: 100 }, '落点=就近营帐');
  } finally {
    w.eng.stop();
  }
});

test('warn 抗争到底档：真攻击也不动作（引擎 cfg-off 长睡）', async () => {
  const w = mkWarn({
    mode: 'stand',
    base: bossBase,
    tiles: [bossTile([{ uid: '999' }]), tentTile],
  });
  try {
    w.warn(3);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.sent.length, 0, '抗争到底档不发任何转移包');
  } finally {
    w.eng.stop();
  }
});

test('warn 落点闸：BOSS 点只作验真料不作转移落点（视口全 BOSS 点 → 不转移）', async () => {
  const w = mkWarn({
    base: bossBase,
    tiles: [
      bossTile([{ uid: '999' }]),
      { x: 105, y: 100, pointType: 177, m: { state: 0, esrId: 5, teams: [] } },
    ],
  });
  try {
    w.warn(3);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.sent.length, 0, '无营帐/资源落点 → 不凭空造目标');
  } finally {
    w.eng.stop();
  }
});

test('warn 验真 fail-safe：本点无快照 → 证据不足照常转移；仅本队 uid 不算敌', async () => {
  const bare = mkWarn({ base: bossBase, tiles: [tentTile] }); // 本点(100,100)无快照
  try {
    bare.warn(3);
    assert.ok(await until(() => bare.sent.length >= 1), '无快照 fail-safe 照转');
  } finally {
    bare.eng.stop();
  }
  const mine = mkWarn({ base: bossBase, tiles: [bossTile([{ uid: '111' }]), tentTile] });
  try {
    mine.warn(3);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mine.sent.length, 0, '本队成员 uid 不算敌 → 误告忽略');
  } finally {
    mine.eng.stop();
  }
});
