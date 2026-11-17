// 异能秘境「不抓宠」（drivePetLevel=0）意图级真相专项单测（二轮收口 §4.3）。
// pilot：moored@172 → 当拍 evade 撤往非 172 落点（beast 档零派发、更近的空闲 172 也不踩）；
//   在途（toKind 非空）不改道（158 语义）；行军中（marchState≠ARRIVED）不派发、到站 moored 后下一拍即离。
// capture：普通野宠窗拒拍（轮询/推送两路同闸，只看 petLevel、不看 drive.enabled）；
//   BOSS 窗（boss:1）不受影响——投喂/手拍是 BOSS 链默认能力，与抓宠意图无关。
// 手法：mock env + node:test mock timers（同 secret-realm-heal-default.test.js 范式），经 start() 真跑 createCycle。
//   pilot 首拍在 start() 内同步点火（kick→exec 同步段），故先以 drive.enabled=false _boot（cfg-off 早退零副作用），
//   喂瓦片/开档后经公开 onArriveWake() kick 补拍；capture 无 cfg 前置闸，首拍即按现场判定。
// 桩化口径：先最小桩 window/document/chrome 再动态 import。
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

const { PilotEngine } = await import('../../extension/src/feats/activity/secret-realm/pilot.js');
const { CaptureEngine } =
  await import('../../extension/src/feats/activity/secret-realm/capture.js');
const C = await import('../../extension/src/feats/activity/secret-realm/constants.js');

/** 微任务全 flush（setImmediate 不被 mock，落在所有 .then 之后）。 */
const flush = () => new Promise((r) => setImmediate(r));

/** 与 createLog 同口径的 printf 展开（%s/%d），否则断言抓不到日志文案。 */
function mkLog(logs) {
  return (...a) => {
    let i = 1;
    logs.push(String(a[0]).replace(/%[sd]/g, () => String(a[i++])));
  };
}

// ── pilot：不抓宠即离（beast-off-leave 档）──────────────────────────────
/** 10018 瓦片推送里的单点形态（m.teams 数组 → #putTile 折成计数）。 */
const tile = (x, y, pt, teams) => ({
  x,
  y,
  pointType: pt,
  m: { teams: teams || [], state: 0, esrId: 14 },
});

/**
 * pilot mock 底座：base/drive 可变（模拟服务器权威现场与面板意图），sent 记全部发包。
 *   drive 缺省 enabled=false——boot 首拍走 cfg-off 早退，喂料后再开档补拍（见文件头注）。
 * @param {object} [over] {drive, base, tiles}
 */
function mkPilotRig(over = {}) {
  const sent = [];
  const logs = [];
  const drive = Object.assign({ enabled: false, petLevel: 0, warnStand: false }, over.drive);
  const base = Object.assign(
    {
      teamId: '7700000012345678',
      startPoint: { x: 50, y: 50 },
      pointType: C.PAB_MONSTER,
      marchState: 2,
      fightBeginTime: 0,
      group: 1,
      members: [],
    },
    over.base || {},
  );
  const push = mkLog(logs);
  const env = {
    alive: () => true,
    realmActive: () => true,
    cfg: () => ({ drive }),
    secret: {
      getRoomBaseInfo: () => base,
      getNMarchState: () => ({ ARRIVED: 2, GATHERING: 5 }),
      teamIsMooring: () => true,
      isTeamLeader: () => true,
      getPabController: () => ({ myTeam: { group: 1 }, capturingPetPos: null }),
      getItemNumById: () => 0,
      isSecretSending: () => false,
      getBossBaseInfo: () => [],
      sendMarch: (x, y) => {
        sent.push({ cmd: C.CMD_MARCH_MOVE, data: { x, y } });
        return Promise.resolve({ ok: true, code: 0 });
      },
      sendSecret: (cmd, data) => {
        sent.push({ cmd, data });
        return Promise.resolve({ ok: false, code: 161 });
      },
    },
    l10n: { tableRows: () => [], tableRow: () => null, text: (k) => k },
    gameData: { myUidStr: () => '111', serverTime: () => Math.floor(Date.now() / 1000) },
    gameConf: { dataConfig: () => null },
    log: { info: push, debug: push, warn: push, error: push },
    marchIntentMatch: () => true,
  };
  return { env, sent, logs, drive, base };
}

/** 起 pilot：首拍 cfg-off 零副作用 → 喂瓦片 → 开档；wake()=公开 onArriveWake kick 补拍。 */
async function bootPilot(t, over) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const rig = mkPilotRig(over);
  const eng = new PilotEngine(rig.env);
  const subs = new Map();
  eng.start({ on: { push: (cmd, fn) => subs.set(cmd, fn), req: () => {} } });
  (over.tiles || []).forEach((p) => eng.onTilePush({ data: { pointInfos: [p] } }));
  rig.drive.enabled = true;
  const step = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  const wake = async () => {
    eng.onArriveWake();
    await flush();
  };
  return Object.assign(rig, { eng, subs, step, wake });
}

test('P1 petLevel=0 moored@172：当拍 8521 撤往非 172 落点（更近的空闲 172 也不踩），beast 档零派发', async (t) => {
  const rig = await bootPilot(t, {
    drive: { petLevel: 0 },
    tiles: [
      tile(50, 50, C.PAB_MONSTER, [{ uid: '111' }]), // 脚下野宠点（本队在停）
      tile(51, 50, C.PAB_MONSTER, []), // 更近的空闲野宠点：noMonster 必须排除（踏上即自动 PVE）
      tile(55, 50, C.PAB_TENT, []), // 营帐落点
    ],
  });
  try {
    await rig.wake();
    assert.equal(rig.sent.length, 1, '只发一笔 8521 撤出包（派发后立即补拍是 TO 相位，不重派）');
    assert.equal(rig.sent[0].cmd, C.CMD_MARCH_MOVE);
    assert.deepEqual(
      rig.sent[0].data,
      { x: 55, y: 50 },
      '落点=空闲营帐；更近的空闲 172 被 noMonster 排除，beast 档零派发',
    );
    assert.ok(
      rig.logs.some((s) => s.includes('goto evade|(55,50) reason=evade')),
      'evade 档发车留痕（dashcam 单轨定责）',
    );
    // 在途（toKind 非空、服务器现场未更新）再补拍：不改道（158 语义），仍是那一笔
    await rig.wake();
    assert.equal(rig.sent.length, 1, '在途不改道，不发第二笔');
  } finally {
    rig.eng.stop();
  }
});

test('P2 petLevel=0 行军中不派发，到站 moored@172 后下一拍即离', async (t) => {
  const rig = await bootPilot(t, {
    drive: { petLevel: 0 },
    base: { marchState: 1 }, // 行军中（未泊靠）：moored=false
    tiles: [tile(50, 50, C.PAB_MONSTER, [{ uid: '111' }]), tile(55, 50, C.PAB_TENT, [])],
  });
  try {
    await rig.wake();
    assert.equal(rig.sent.length, 0, '行军中（marchState≠ARRIVED）不派发');
    rig.base.marchState = 2; // 到站泊靠（仍在 172：任何原因走到都算）
    await rig.wake();
    assert.equal(rig.sent.length, 1, '到站 moored 后下一拍即离');
    assert.deepEqual(rig.sent[0].data, { x: 55, y: 50 }, '撤往非 172 落点');
  } finally {
    rig.eng.stop();
  }
});

// ── capture：不抓宠拒拍（普通野宠窗）/ BOSS 窗照拍 ──────────────────────
/**
 * capture mock 底座：pab 现场（capturingPetPos/capturingInfo）可控，ops 记 petCaptureOperation 全部动作。
 *   投喂动作（specId 5/6）按游戏回环扣背包，模拟「投完一件少一件」。
 * @param {object} [over] {drive, pos, cap, bag, behave}
 */
function mkCapRig(over = {}) {
  const ops = [];
  const logs = [];
  const drive = Object.assign({ enabled: true, petLevel: 0 }, over.drive);
  const bag = Object.assign({ 41011: 1 }, over.bag);
  const behave = over.behave || {
    4: { time: 7 },
    5: { item: 41011, favor: '400|400' },
    6: { item: 41012, favor: '800|800' },
  };
  const pab = {
    capturingPetPos: over.pos || null,
    capturingInfo: over.cap || null,
    petCaptureOperation: (spec) => {
      ops.push(spec);
      const row = behave[spec];
      if (row && row.item) bag[row.item] = Math.max(0, (bag[row.item] || 0) - 1);
    },
  };
  const push = mkLog(logs);
  const env = {
    alive: () => true,
    realmActive: () => true,
    cfg: () => ({ drive, boss: { feed: true } }),
    secret: { getPabController: () => pab, getItemNumById: (id) => bag[id] || 0 },
    gameData: { serverTime: () => Math.floor(Date.now() / 1000) },
    gameConf: { dataConfig: (k) => (k === C.CFG_TAP_LIMIT_PER_SEC ? 5 : null) },
    l10n: { tableRow: (tb, id) => (tb === C.TABLE_BEAST_BEHAVE ? behave[id] || null : null) },
    ui: { close: () => ({ ok: true }) },
    log: { info: push, debug: push, warn: push, error: push },
  };
  return { env, ops, logs, drive, bag, pab };
}

/** 起 capture：首拍即按现场判定（无 cfg 前置闸）；step(ms) 逐拍推进。 */
async function bootCap(t, over) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const rig = mkCapRig(over);
  const eng = new CaptureEngine(rig.env);
  const subs = new Map();
  eng.start({ on: { push: (cmd, fn) => subs.set(cmd, fn) } });
  await flush();
  const step = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return Object.assign(rig, { eng, subs, step });
}

const refuseLogs = (logs) => logs.filter((s) => s.includes('reason=pet_off_refuse'));

test('K1 petLevel=0 普通野宠窗拒拍：轮询零动作 + 边沿 info 一条；推送路同闸', async (t) => {
  const rig = await bootCap(t, {
    drive: { petLevel: 0 },
    pos: { x: 50, y: 50 },
    // 能量满 + 事件候选在场：拒拍闸必须先于能量/轮询兜底，证明「一律不拍」
    cap: { selfenergy: C.ENERGY_MAX, eventSpecId: [3], nowFavor: 0, allFavor: 7000 },
  });
  try {
    await rig.step(C.tuning.feedIdleMs);
    assert.equal(rig.ops.length, 0, '拒拍：能量满/事件候选也零动作（不手拍/不能量/不事件/不投喂）');
    assert.equal(refuseLogs(rig.logs).length, 1, '边沿 info 一条，同窗不逐拍刷屏');
    rig.subs.get(C.PUSH_BEAST_EVENT)({
      data: { type: C.EVT_TYPE_DRAG, specId: [3], endTime: Date.now() + 2000 },
    });
    await flush();
    assert.equal(rig.ops.length, 0, '推送路同闸：拖拽事件也不发（两路一字不差）');
  } finally {
    rig.eng.stop();
  }
});

test('K1b 拒拍只看 petLevel：drive.enabled=false（用户手动踏点）普通窗仍拒拍', async (t) => {
  const rig = await bootCap(t, {
    drive: { enabled: false, petLevel: 0 },
    pos: { x: 50, y: 50 },
    cap: { selfenergy: 0, eventSpecId: [], nowFavor: 0, allFavor: 7000 },
  });
  try {
    await rig.step(C.tuning.feedIdleMs);
    assert.equal(rig.ops.length, 0, '不抓宠是意图级真相：drive 关也拒拍普通野宠窗');
    assert.equal(refuseLogs(rig.logs).length, 1);
  } finally {
    rig.eng.stop();
  }
});

test('K2 BOSS 窗（boss:1）不受 petLevel=0 影响：投喂 specId5 + 免费手拍 specId1 照发', async (t) => {
  const rig = await bootCap(t, {
    drive: { petLevel: 0 },
    pos: { x: 92, y: 170, boss: 1 },
    cap: { selfenergy: 0, eventSpecId: [], nowFavor: 0, allFavor: 1000000 },
    bag: { 41011: 1 },
  });
  try {
    assert.ok(rig.ops.includes(C.SPEC_FEED_FIRST), 'BOSS 投喂照旧（首拍投出一件 8546 specId5）');
    await rig.step(C.tuning.tapIntervalMs + 50); // 越过节流点：道具投完 → 落回免费手拍
    assert.ok(rig.ops.includes(C.SPEC_TAP), '投喂道具用光后免费手拍打底照常');
    assert.equal(refuseLogs(rig.logs).length, 0, 'BOSS 窗不走拒拍闸');
  } finally {
    rig.eng.stop();
  }
});

test('K3 petLevel=2 普通窗照拍：免费手拍 + 推送拖拽事件都发', async (t) => {
  const rig = await bootCap(t, {
    drive: { petLevel: 2 },
    pos: { x: 50, y: 50 },
    cap: { selfenergy: 0, eventSpecId: [], nowFavor: 0, allFavor: 7000 },
  });
  try {
    assert.ok(rig.ops.includes(C.SPEC_TAP), '选抓宠（petLevel>0）普通窗手拍照常');
    rig.subs.get(C.PUSH_BEAST_EVENT)({
      data: { type: C.EVT_TYPE_DRAG, specId: [3], endTime: Date.now() + 2000 },
    });
    await flush();
    assert.ok(rig.ops.includes(3), '推送拖拽事件照发（specId 即答案）');
    assert.equal(refuseLogs(rig.logs).length, 0);
  } finally {
    rig.eng.stop();
  }
});
