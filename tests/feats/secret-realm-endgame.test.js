// 异能秘境自动驾驶「终局状态机」专项单测（用户拍板 2026-11-17）：
//   大BOSS（177）确证死局 → 奖励弹窗 hold 5s（冻路由不冻生存）→ 最后一趟商店（最近店锚，不看账本）
//   → 到店驻留买货 → 离店结算落 done＝本场永久收场（再勾启用/引擎重建都不复活，模块级闩恢复）。
// 判据口径：死局只认 state30/墓碑，**不认 28**（28 后还有 23 投喂窗，认 28 会把商店车派进投喂窗）。
// 手法：mock env + node:test mock timers（同 secret-realm-petoff.test.js 范式），经 start() 真跑 createCycle。
//   mock timers 的 Date 从 0 起 → base.fightBeginTime 必须 >1e11（#noteMatchOver 写闩守卫 + 换场复位守卫）。
//   boot 先 drive.enabled=false（cfg-off 早退零副作用）喂瓦片；终局检测在 cfg-off 闸之前，关着也落闩。
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

/** 本场 fightBeginTime（毫秒，>1e11：写闩/换场复位双守卫都认它）。 */
const FB = 1700000000000;

/** 10018 瓦片推送里的单点形态（state 可控：21 活 / 28 战斗结算 / 30 死局）。 */
const tile = (x, y, pt, state) => ({
  x,
  y,
  pointType: pt,
  m: { teams: [], state: state || 0, esrId: 14 },
});

/**
 * 终局 mock 底座：sent 记全部发包；latch 闭包模拟 index.js 模块级 matchOver（活过引擎重建）；
 *   商店锚点走 TABLE_BUILDING 表行（60,50 近 / 10,10 远）；香肠持有 10=目标 → 驻留不续留。
 * @param {object} [over] {drive, base, tiles, bossList}
 */
function mkRig(over = {}) {
  const sent = [];
  const logs = [];
  const kicks = [];
  let latch = null;
  const drive = Object.assign(
    { enabled: false, petLevel: 2, warnStand: false, shopDwellMs: 2000 },
    over.drive,
  );
  const base = Object.assign(
    {
      teamId: '7700000012345678',
      startPoint: { x: 50, y: 50 },
      pointType: C.PAB_BOSS, // 打完大BOSS 停在平台
      marchState: 2,
      fightBeginTime: FB,
      group: 1,
      members: [],
    },
    over.base || {},
  );
  const bossList = over.bossList || [];
  const items = { 41011: 10 };
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
      getItemNumById: (id) => items[id] || 0,
      isSecretSending: () => false,
      getBossBaseInfo: () => bossList,
      sendMarch: (x, y) => {
        sent.push({ cmd: C.CMD_MARCH_MOVE, data: { x, y } });
        return Promise.resolve({ ok: true, code: 0 });
      },
      sendSecret: (cmd, data) => {
        sent.push({ cmd, data });
        return Promise.resolve({ ok: false, code: 161 });
      },
    },
    l10n: {
      tableRows: (tb) =>
        tb === C.TABLE_BUILDING
          ? [
              { build_type: 3, group: 1, coords: '60,50' },
              { build_type: 3, group: 1, coords: '10,10' },
            ]
          : [],
      tableRow: () => null,
      text: (k) => k,
    },
    gameData: { myUidStr: () => '111', serverTime: () => Math.floor(Date.now() / 1000) },
    gameConf: { dataConfig: () => null },
    log: { info: push, debug: push, warn: push, error: push },
    marchIntentMatch: () => true,
    kickShop: () => kicks.push(Date.now()),
    // 模块级闩三口（与 index.js buildEnv 同形）：闭包活过引擎重建
    getMatchOver: () => latch,
    noteMatchOver: (mo) => {
      latch = mo || null;
    },
    endgameActive: () => !!latch,
  };
  return { env, sent, logs, kicks, drive, base, bossList, getLatch: () => latch };
}

/** 起 pilot：首拍 cfg-off 零副作用 → 喂瓦片（drive 开关由用例自行拨）；wake()=公开 onArriveWake kick 补拍。 */
async function boot(t, over) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const rig = mkRig(over);
  const eng = new PilotEngine(rig.env);
  const subs = new Map();
  eng.start({ on: { push: (cmd, fn) => subs.set(cmd, fn), req: () => {} } });
  (over.tiles || []).forEach((p) => eng.onTilePush({ data: { pointInfos: [p] } }));
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

test('E1 终局全链：死局→hold 5s 零发包→窗满恰一笔 8521 去最近店→驻留→离店 done→再勾启用零发包', async (t) => {
  const rig = await boot(t, { tiles: [tile(50, 50, C.PAB_BOSS, 21)] });
  try {
    // 大BOSS 死局推送（state30）后开档：hold 开始，奖励弹窗窗内零发包
    rig.eng.onTilePush({ data: { pointInfos: [tile(50, 50, C.PAB_BOSS, 30)] } });
    rig.drive.enabled = true;
    await rig.wake();
    assert.equal(rig.sent.length, 0, 'hold 窗内冻路由：一笔不发');
    assert.equal(rig.eng.debugState().phase.endgame, 'hold');
    assert.ok(
      rig.logs.some((s) => s.includes('reason=endgame_begin')),
      '死局确证留痕（dashcam 单轨定责）',
    );
    assert.equal(rig.getLatch().phase, 'hold', 'hold 转场写穿模块级闩');
    // 窗满（5s）：恰一笔 8521 开向最近店锚 (60,50)（不看访问记忆/消费账）
    await rig.step(C.tuning.driveEndgameHoldMs + 100);
    assert.equal(rig.sent.length, 1, '窗满只派最后一趟商店车');
    assert.equal(rig.sent[0].cmd, C.CMD_MARCH_MOVE);
    assert.deepEqual(rig.sent[0].data, { x: 60, y: 50 }, '最近店锚（60,50 距 10 < 10,10 距 56）');
    assert.ok(rig.logs.some((s) => s.includes('reason=endgame_shop')));
    assert.equal(rig.getLatch().phase, 'shop-work');
    // 到站（服务器权威现场更新）→ 进驻留让 shop.js 买货（kickShop 叫醒）
    rig.base.startPoint = { x: 60, y: 50 };
    rig.base.pointType = C.PAB_SHOP;
    await rig.wake();
    assert.equal(rig.sent.length, 1, '到站进驻留，不重派');
    assert.ok(rig.kicks.length >= 1, '到店叫醒商店引擎');
    assert.ok(rig.logs.some((s) => s.includes('enter dwell phase')));
    // 驻留满（shopDwellMs=2000，香肠已满不续留）→ 离店结算＝done 本场收场
    await rig.step(2500);
    assert.equal(rig.sent.length, 1, '离店结算当拍即收场，不落常规阶梯补派一笔');
    assert.equal(rig.eng.debugState().phase.endgame, 'done');
    assert.equal(rig.getLatch().phase, 'done');
    assert.ok(rig.logs.some((s) => s.includes('reason=endgame_done')));
    // 再勾启用（开关翻转）+ 长时间推进：零发包，永不复活
    rig.drive.enabled = false;
    await rig.wake();
    rig.drive.enabled = true;
    await rig.wake();
    await rig.step(30000);
    assert.equal(rig.sent.length, 1, 'done 后哪怕再勾启用也不复活');
  } finally {
    rig.eng.stop();
  }
});

test('E2 引擎重建恢复：done 闩活过 pause/resume（新建 PilotEngine 同 env），同场零发包', async (t) => {
  const rig = await boot(t, { tiles: [tile(50, 50, C.PAB_BOSS, 30)] });
  let eng2 = null;
  try {
    rig.drive.enabled = true;
    await rig.wake();
    assert.equal(rig.getLatch().phase, 'hold');
    // 直接拨闩到 done（等价 E1 走完离店结算），模拟 reactor resume 重跑 run() 重建引擎
    rig.env.noteMatchOver({ fb: FB, phase: 'done', until: 0 });
    rig.eng.stop();
    eng2 = new PilotEngine(rig.env);
    eng2.start({ on: { push: () => {}, req: () => {} } });
    eng2.onArriveWake();
    await flush();
    assert.equal(
      eng2.debugState().phase.endgame,
      'done',
      '新引擎从模块级闩恢复 done（fb 对上才认）',
    );
    assert.equal(rig.sent.length, 0, '重建后同场零发包');
    await rig.step(20000);
    assert.equal(rig.sent.length, 0, '重建后长跑也不复活');
  } finally {
    rig.eng.stop();
    if (eng2) eng2.stop();
  }
});

test('E3 drive 关着也落闩：死局观测独立于开关，晚些再勾启用直接走终局不巡航', async (t) => {
  const rig = await boot(t, { tiles: [tile(50, 50, C.PAB_BOSS, 21)] });
  try {
    rig.eng.onTilePush({ data: { pointInfos: [tile(50, 50, C.PAB_BOSS, 30)] } });
    await rig.wake(); // drive.enabled 仍 false
    assert.equal(rig.getLatch().phase, 'hold', 'cfg-off 闸之前检测：关着也落闩');
    assert.equal(rig.sent.length, 0);
    await rig.step(10000); // 关着长睡：hold 不执行（执行在 cfg-off 之后），零发包
    assert.equal(rig.sent.length, 0);
    rig.drive.enabled = true;
    await rig.wake(); // hold 窗早已过期 → 当拍直接派商店车，不巡航
    assert.equal(rig.sent.length, 1, '晚开档直接走终局商店段');
    assert.deepEqual(rig.sent[0].data, { x: 60, y: 50 });
    assert.ok(rig.logs.some((s) => s.includes('reason=endgame_shop')));
  } finally {
    rig.eng.stop();
  }
});

test('E4 state28 不触发终局：瓦片 28 与权威 28 都不认（28 后还有 23 投喂窗）', async (t) => {
  const rig = await boot(t, {
    tiles: [tile(50, 50, C.PAB_BOSS, 28)],
    bossList: [{ bossId: 9, pos: { x: 50, y: 50 }, state: 28 }],
  });
  try {
    rig.drive.enabled = true;
    await rig.wake();
    assert.equal(rig.eng.debugState().phase.endgame, '', '28=战斗结算不是死局：不进终局');
    assert.equal(rig.getLatch(), null, '不落闩');
    assert.ok(!rig.logs.some((s) => s.includes('reason=endgame_begin')));
  } finally {
    rig.eng.stop();
  }
});

test('E5 权威死局兜底：瓦片仍 21 但 bossBaseInfo state30（pos 对账 bossId）→ 触发终局', async (t) => {
  const rig = await boot(t, {
    tiles: [tile(50, 50, C.PAB_BOSS, 21)],
    bossList: [{ bossId: 9, pos: { x: 50, y: 50 }, state: 30 }],
  });
  try {
    rig.drive.enabled = true;
    await rig.wake();
    assert.equal(rig.eng.debugState().phase.endgame, 'hold', '权威 state30 兜底确证死局');
    assert.ok(rig.logs.some((s) => s.includes('reason=endgame_begin')));
    assert.equal(rig.getLatch().phase, 'hold');
  } finally {
    rig.eng.stop();
  }
});

test('E6 换场闩失效：latch.fb 与本场 fightBeginTime 不同 → 不恢复终局（新场重新巡航）', async (t) => {
  const rig = await boot(t, { tiles: [tile(50, 50, C.PAB_BOSS, 21)] });
  try {
    rig.env.noteMatchOver({ fb: FB + 7, phase: 'done', until: 0 }); // 别场的闩
    rig.drive.enabled = true;
    await rig.wake();
    assert.equal(rig.eng.debugState().phase.endgame, '', 'fb 对不上不认：新场不受旧场闩约束');
    assert.ok(!rig.logs.some((s) => s.includes('reason=endgame_done')));
  } finally {
    rig.eng.stop();
  }
});
