// 快捷攻击「出征自动切城皮」（feats/battle/quick-attack/skin-swap.js）单测。
// 覆盖三层：① planSwaps 纯函数决策矩阵（待机档 × 当前皮 × 相位 × 满编/陪跑）；
// ② ensureSkin 的零发包 skip / 节流 / 在途 / 被拒 / 落地轮询分支（注入假 net + 假 gameData）；
// ③ 未启用（零回归）路径：整条链不碰 castleFaces()、不探兵数、不发包、不入在途账本。
// feat 模块的 import 链会触到浏览器全局，故先最小桩化 window/document/chrome 再动态 import（同 potion-craft 口径）。
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

// core 链里的 session/scene-watcher 等模块在 import 期就挂常驻 setInterval（Node 里会把测试进程拖住不退出）
// ——只对 harness 的定时器 unref，不参与被测逻辑。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const m = await import('../../extension/src/feats/battle/quick-attack/skin-swap.js');
const {
  CMD_USE_CASTLE_FACE,
  PHASE,
  IDLE_MODE,
  SKIN_UNSET,
  normalizeSkinSwapCfg,
  planSwaps,
  ensureSkin,
  msSinceLastSkinSend,
  ownedSkinIds,
  loadOf,
  preMarchSwap,
  afterMarchSwap,
  restoreIdleSkin,
  trackMarch,
  pendingCount,
  arm,
  disarm,
  selfHeal,
  resetThrottle,
} = m;

const CODE_NOT_SENT = -1;
const MARCH_SKIN = 1719000; // 出征皮（每格出征数↑）
const BATTLE_SKIN = 1719100; // 主战皮（防御 buff↑）
const THIRD_SKIN = 1719200; // 第三方皮（既非出征也非主战，用于「当前穿的是别的」）

/** march.State 替身（arm() 只认 core/march.js 的 State 语义数值，本模块不写死） */
const MARCH_STATE = { RETURNING: 3, ARRIVED_HOME: 4 };
const EDGE_NAME = { 1: 'MARCHING', 2: 'ARRIVED', 3: 'RETURNING', 4: 'ARRIVED_HOME' };

/**
 * 伪造一条 10019 行军边沿的回调参数：形状与 core/march.js 的 decode() 产出一致
 * （主键 `id` 为字符串，线上原字段只留在 `raw.marchInfo.marchId`）。
 * @param {string|number} id marchId
 * @param {number} [state] 迁到的 state（缺省 3=开始返程，即相位 D 的主触发点）
 * @returns {object} March
 */
const marchEdge = (id, state) => {
  const st = state == null ? 3 : state;
  return {
    id: String(id),
    state: st,
    stateName: EDGE_NAME[st] || String(st),
    raw: { marchInfo: { marchId: id } },
  };
};

/** 典型可用配置（两皮已选、开关开）；@param {object} over 覆盖项 @returns {object} */
const cfg = (over) =>
  Object.assign(
    { enabled: true, marchSkin: MARCH_SKIN, battleSkin: BATTLE_SKIN, idleMode: IDLE_MODE.BATTLE },
    over || {},
  );

// ── 假件面 ────────────────────────────────────────────────────────────
/**
 * 假 gameData 读数面：usingCastleFace 可被写（切换成功即换皮），castleFaces 记录被碰次数（零回归断言用）。
 * @param {{using?:number|null, faces?:Array<{skinId:number}>|null}} [o]
 */
function fakeGameData(o) {
  o = o || {};
  const state = {
    using: o.using === undefined ? BATTLE_SKIN : o.using,
    facesTouched: 0,
    sends: 0,
  };
  const gd = {
    state,
    usingCastleFace: () => state.using,
    castleFaces: () => {
      state.facesTouched++;
      return o.faces || [{ skinId: 0 }, { skinId: MARCH_SKIN }, { skinId: BATTLE_SKIN }];
    },
  };
  return gd;
}

/**
 * 假 net 底座：记录每次 sendGuarded 的 {cmd, body}；`land` 为真时把当前皮写成目标皮（模拟 10905 推送回写）。
 * @param {{land?:boolean, ok?:boolean, code?:number, sending?:boolean, gameData?:object}} [o]
 */
function fakeNet(o) {
  o = o || {};
  const calls = [];
  const net = {
    calls,
    isSending: () => !!o.sending,
    async sendGuarded(cmd, body) {
      calls.push({ cmd, body });
      if (o.ok === false) return { ok: false, code: o.code == null ? 7 : o.code, data: '{}' };
      if (o.land !== false && o.gameData) o.gameData.state.using = body.skinId;
      return { ok: true, code: 0, data: '{"ret":0}' };
    },
  };
  return net;
}

/** 可控时钟 + 零耗时轮询（把 ensureSkin/preMarchSwap 的 sleep 预算压到 1ms，测试仍走真实轮询分支） */
const fast = { stepMs: 1, settleMs: 2, loadBudgetMs: 2 };

/**
 * 按序取值的假时钟：依次返回给定毫秒（用尽后恒返回最后一个）。
 * 注意 ensureSkin 里 now() 的调用序：① 节流窗判定 ② t0 ③ 算 RT——所以首值必须 ≥ gapMs + lastSendAt。
 * @param {number[]} vals @returns {function():number}
 */
function clock(vals) {
  let i = 0;
  return () => (i < vals.length ? vals[i++] : vals[vals.length - 1]);
}

// ── normalizeSkinSwapCfg：面板键 ⇄ 归一区段双形态 ──────────────────────
test('normalizeSkinSwapCfg：面板四键归一，且绝不把面板「enabled」（快捷攻击总开关）当切皮子开关', () => {
  assert.deepEqual(
    normalizeSkinSwapCfg({
      enabled: true, // 总开关开着，但切皮子开关没开
      skinSwapEnabled: false,
      swapSkinMarch: MARCH_SKIN,
      swapSkinBattle: BATTLE_SKIN,
      swapIdleMode: IDLE_MODE.MARCH,
    }),
    { enabled: false, marchSkin: MARCH_SKIN, battleSkin: BATTLE_SKIN, idleMode: IDLE_MODE.MARCH },
  );
  // 缺省：关 + 两皮未选 + 待机=主战
  assert.deepEqual(normalizeSkinSwapCfg({}), {
    enabled: false,
    marchSkin: SKIN_UNSET,
    battleSkin: SKIN_UNSET,
    idleMode: IDLE_MODE.BATTLE,
  });
  // 幂等：已归一的区段原样读回（configure 热更走这条）
  const once = normalizeSkinSwapCfg({
    skinSwapEnabled: true,
    swapSkinMarch: MARCH_SKIN,
    swapSkinBattle: BATTLE_SKIN,
    swapIdleMode: IDLE_MODE.MARCH,
  });
  assert.deepEqual(normalizeSkinSwapCfg(once), once);
  // 非法待机档回落到 1（主战）
  assert.equal(normalizeSkinSwapCfg({ swapIdleMode: 99 }).idleMode, IDLE_MODE.BATTLE);
});

test('normalizeSkinSwapCfg：skinId 0（默认城皮）是合法值，不被当成「未选择」', () => {
  const c = normalizeSkinSwapCfg({
    skinSwapEnabled: true,
    swapSkinMarch: 0,
    swapSkinBattle: BATTLE_SKIN,
  });
  assert.equal(c.marchSkin, 0);
  assert.equal(c.enabled, true);
  assert.equal(planSwaps(c, BATTLE_SKIN, PHASE.pre, true, null).targetSkin, 0);
});

// ── planSwaps：决策矩阵 ────────────────────────────────────────────────
test('planSwaps：短路序——disabled / 陪跑波 / 未选皮 / 两皮相同 / 未知相位各有各的 reason', () => {
  const cases = [
    [cfg({ enabled: false }), BATTLE_SKIN, PHASE.pre, true, 'disabled'],
    [cfg(), BATTLE_SKIN, PHASE.pre, false, 'not-full-wave'],
    [cfg({ post: 0, marchSkin: SKIN_UNSET }), BATTLE_SKIN, PHASE.pre, true, 'skin-unset'],
    [cfg({ battleSkin: SKIN_UNSET }), BATTLE_SKIN, PHASE.post, true, 'skin-unset'],
    [cfg({ battleSkin: MARCH_SKIN }), BATTLE_SKIN, PHASE.pre, true, 'same-skin'],
    [cfg(), BATTLE_SKIN, 'whatever', true, 'unknown-phase'],
  ];
  for (const [c, cur, phase, full, reason] of cases) {
    const p = planSwaps(c, cur, phase, full, null);
    assert.equal(p.send, false, `send=${phase}/${reason}`);
    assert.equal(p.reason, reason);
    assert.equal(p.targetSkin, SKIN_UNSET);
  }
});

test('planSwaps：未拥有的皮（不在 castleFaces 清单）不切，两个方向各自点名', () => {
  const owned = [0, BATTLE_SKIN]; // 没买出征皮
  assert.equal(
    planSwaps(cfg(), BATTLE_SKIN, PHASE.pre, true, owned).reason,
    'march-skin-not-owned',
  );
  const owned2 = [0, MARCH_SKIN]; // 没买主战皮
  assert.equal(
    planSwaps(cfg(), MARCH_SKIN, PHASE.post, true, owned2).reason,
    'battle-skin-not-owned',
  );
  // owned=null（清单取不到）= 无从判定：只降级不校验，绝不拦切皮
  assert.equal(planSwaps(cfg(), BATTLE_SKIN, PHASE.pre, true, null).send, true);
});

test('planSwaps 矩阵（待机=主战皮）：A 穿出征皮、C 回主战皮、D 零发包 no-op', () => {
  const c = cfg({ idleMode: IDLE_MODE.BATTLE });
  // 当前在主战皮
  assert.deepEqual(
    { send: true, target: planSwaps(c, BATTLE_SKIN, PHASE.pre, true, null) },
    {
      send: true,
      target: { send: true, targetSkin: MARCH_SKIN, reason: 'switch' },
    },
  );
  assert.deepEqual(planSwaps(c, MARCH_SKIN, PHASE.post, true, null), {
    send: true,
    targetSkin: BATTLE_SKIN,
    reason: 'switch',
  });
  const home = planSwaps(c, BATTLE_SKIN, PHASE.home, true, null);
  assert.equal(home.send, false);
  assert.equal(home.reason, 'already-on-target');
  assert.equal(home.targetSkin, BATTLE_SKIN);
});

test('planSwaps 矩阵（待机=出征皮）：A 是 no-op（省预切），D 才切回出征皮', () => {
  const c = cfg({ idleMode: IDLE_MODE.MARCH });
  const pre = planSwaps(c, MARCH_SKIN, PHASE.pre, true, null);
  assert.equal(pre.send, false);
  assert.equal(pre.reason, 'already-on-target');
  assert.equal(pre.targetSkin, MARCH_SKIN);
  assert.equal(planSwaps(c, MARCH_SKIN, PHASE.post, true, null).targetSkin, BATTLE_SKIN);
  const home = planSwaps(c, BATTLE_SKIN, PHASE.home, true, null);
  assert.equal(home.send, true);
  assert.equal(home.targetSkin, MARCH_SKIN);
});

test('planSwaps：当前穿第三方皮 / 读数缺失（null）都必须切，不许判成「已在目标皮」', () => {
  assert.equal(planSwaps(cfg(), THIRD_SKIN, PHASE.home, true, null).send, true);
  assert.equal(planSwaps(cfg(), THIRD_SKIN, PHASE.home, true, null).targetSkin, BATTLE_SKIN);
  assert.equal(planSwaps(cfg(), null, PHASE.pre, true, null).send, true);
  assert.equal(planSwaps(cfg(), undefined, PHASE.post, true, null).send, true);
});

// ── ownedSkinIds / loadOf ──────────────────────────────────────────────
test('ownedSkinIds：清单为空 = 无从判定（null，不校验所有权）；有清单则出 skinId 数组', () => {
  assert.equal(ownedSkinIds(fakeGameData({ faces: [] })), null);
  assert.deepEqual(ownedSkinIds(fakeGameData({ faces: [{ skinId: 0 }, { skinId: MARCH_SKIN }] })), [
    0,
    MARCH_SKIN,
  ]);
});

test('loadOf：armyListNew 求和含补位 extraArmy，缺形回 0', () => {
  assert.equal(
    loadOf({ armyListNew: [{ armyNum: 10 }, { armyNum: 5 }], extraArmy: { armyNum: 3 } }),
    18,
  );
  assert.equal(loadOf({ armyListNew: [{ armyNum: 10 }] }), 10);
  assert.equal(loadOf(null), 0);
  assert.equal(loadOf({}), 0);
});

// ── ensureSkin：唯一发 855 的口子 ──────────────────────────────────────
test('ensureSkin：已在目标皮 → skipped 零发包；哨兵/负数一律不发包（NOT_SENT）', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: MARCH_SKIN });
  const net = fakeNet({ gameData: gd });
  const r = await ensureSkin(MARCH_SKIN, { net, gameData: gd, now: () => 0 });
  assert.deepEqual(r, { ok: true, landed: true, code: 0, rtMs: 0, skipped: true });
  assert.equal(net.calls.length, 0);

  resetThrottle();
  const bad = await ensureSkin(SKIN_UNSET, { net, gameData: gd, now: () => 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, CODE_NOT_SENT);
  assert.equal(net.calls.length, 0, '哨兵皮绝不能上线');
});

test('ensureSkin：报文形态逐键 {skinId, special:0}，cmd=855；应答后 10905 回写即首轮命中 landed', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  const r = await ensureSkin(MARCH_SKIN, {
    net,
    gameData: gd,
    now: clock([1000, 1061, 1122]),
    ...fast,
  });
  assert.equal(r.ok, true);
  assert.equal(r.landed, true);
  assert.equal(r.skipped, false);
  assert.deepEqual(net.calls, [
    { cmd: CMD_USE_CASTLE_FACE, body: { skinId: MARCH_SKIN, special: 0 } },
  ]);
});

test('ensureSkin：同皮最小间隔内第二次不发包（NOT_SENT），过窗口才再发', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  let t = 1000;
  const o = { net, gameData: gd, gapMs: 250, now: () => t, ...fast };
  assert.equal((await ensureSkin(MARCH_SKIN, o)).ok, true);
  gd.state.using = BATTLE_SKIN; // 模拟「切回来了，马上又想切」
  t = 1100;
  const gated = await ensureSkin(MARCH_SKIN, o);
  assert.equal(gated.ok, false);
  assert.equal(gated.code, CODE_NOT_SENT);
  assert.equal(net.calls.length, 1, '节流窗口内不得上线第二个 855');
  t = 1400;
  assert.equal((await ensureSkin(MARCH_SKIN, o)).ok, true);
  assert.equal(net.calls.length, 2);
});

test('ensureSkin：节流只卡同皮——A 切出征皮后紧接着 C 切主战皮必须放行（被吞掉就等于部队带着出征皮到达）', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  let t = 1000;
  const now = () => (t += 20) - 20; // 每调一次走 20ms
  const o = { net, gameData: gd, gapMs: 250, now, ...fast };

  // 相位 A：切出征皮（时刻 1020 入逐皮账）
  assert.equal((await ensureSkin(MARCH_SKIN, o)).ok, true);
  // 相位 C：1080ms —— 与上一发只隔 60ms，但是另一张皮，不能被同一个闸门吞掉
  gd.state.using = MARCH_SKIN;
  assert.equal((await ensureSkin(BATTLE_SKIN, o)).ok, true);
  assert.deepEqual(
    net.calls.map((c) => c.body.skinId),
    [MARCH_SKIN, BATTLE_SKIN],
    '异皮连发不得被节流',
  );

  // 同皮重发：1120ms 距上一发朝 MARCH 的 1020ms 只过 100ms → 依旧拦
  gd.state.using = BATTLE_SKIN;
  const gated = await ensureSkin(MARCH_SKIN, o);
  assert.equal(gated.ok, false);
  assert.equal(gated.code, CODE_NOT_SENT);
  assert.equal(net.calls.length, 2, '同皮窗口内不得上线第三个 855');
});

test('ensureSkin：855 已在途（isSending）→ NOT_SENT 不排队、不阻塞出征', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd, sending: true });
  // 时钟给到 1000：先让节流窗判定通过，才能证到被拦的是 isSending 而非 gap
  const r = await ensureSkin(MARCH_SKIN, { net, gameData: gd, now: clock([1000]) });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODE_NOT_SENT);
  assert.equal(net.calls.length, 0);
});

test('ensureSkin：服务器拒绝（ret.ok=false）永不 reject，带回 code 与 RT', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd, ok: false, code: 5002 });
  const r = await ensureSkin(MARCH_SKIN, {
    net,
    gameData: gd,
    now: clock([1000, 1061, 1122]),
    ...fast,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 5002);
  assert.equal(r.landed, false);
  assert.equal(r.rtMs, 61);
});

test('ensureSkin：应答成功但推送没落地 → 轮询到预算上限后 landed:false（调用方仍照常出征）', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd, land: false });
  const r = await ensureSkin(MARCH_SKIN, {
    net,
    gameData: gd,
    now: clock([1000, 1061, 1122]),
    stepMs: 1,
    settleMs: 3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.landed, false);
  assert.equal(net.calls.length, 1);
});

test('ensureSkin：settle:false 应答后立即返回（不睡落地轮询）——相位 C 靠它把回切压到最早', async (t) => {
  // 假定时器：一旦代码走了 sleep 分支就永不 resolve（测试会超时失败），因此本例同当「零额外等待」的闸门
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    resetThrottle();
    const gd = fakeGameData({ using: BATTLE_SKIN });
    const net = fakeNet({ gameData: gd, land: false }); // 推送不回写：只能拿应答后那一次复读
    const r = await ensureSkin(MARCH_SKIN, {
      net,
      gameData: gd,
      settle: false,
      now: clock([1000]),
    });
    assert.equal(r.ok, true);
    assert.equal(r.landed, false);
    assert.equal(net.calls.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('ensureSkin：net 缺失/形态不符（无 sendGuarded）→ NOT_SENT，不抛异常', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  assert.equal((await ensureSkin(MARCH_SKIN, { net: null, gameData: gd })).code, CODE_NOT_SENT);
  assert.equal((await ensureSkin(MARCH_SKIN, { net: {}, gameData: gd })).code, CODE_NOT_SENT);
});

// ── preMarchSwap（相位 A）─────────────────────────────────────────────
test('preMarchSwap：未启用（零回归）不碰 castleFaces()、不探兵数、一个包都不发', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  let built = 0;
  const Battle = function () {
    built++;
  };
  const r = await preMarchSwap({
    cfg: cfg({ enabled: false }),
    net,
    gameData: gd,
    presetIndex: 1,
    Battle,
    signal: null,
    ...fast,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'disabled');
  assert.equal(net.calls.length, 0);
  assert.equal(gd.state.facesTouched, 0, '零回归路径上连清单遍历都不该发生');
  assert.equal(built, 0, '不该做兵数探针');
  assert.equal(r.base, null);
});

test('preMarchSwap：切成功后兵数探针显示膨胀 → landed:true 且带 base/load', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  const seq = [100, 150]; // 基线 100 → 切皮后 150（每格上限膨胀）
  let i = 0;
  const Battle = function () {
    this.plan = () => ({
      preset: () => this.plan2(),
      adjust: () => this.plan2(),
      build: () => ({ armyListNew: [{ armyNum: seq[Math.min(i++, seq.length - 1)] }] }),
    });
    this.plan2 = () => this.plan();
  };
  const r = await preMarchSwap({
    cfg: cfg(),
    net,
    gameData: gd,
    presetIndex: 2,
    Battle,
    signal: null,
    ...fast,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, 'switched');
  assert.equal(r.base, 100);
  assert.equal(r.load, 150);
  assert.equal(r.landed, true);
  assert.equal(net.calls[0].body.skinId, MARCH_SKIN);
});

test('preMarchSwap：855 被拒也照常给出征前的决定（reason=send-rejected，不阻断出征）', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd, ok: false, code: 5002 });
  const Battle = function () {
    this.plan = () => ({
      preset: () => this.p,
      adjust: () => this.p,
      build: () => ({ armyListNew: [{ armyNum: 80 }] }),
    });
    this.p = this.plan();
  };
  const r = await preMarchSwap({
    cfg: cfg(),
    net,
    gameData: gd,
    presetIndex: 1,
    Battle,
    signal: null,
    ...fast,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, 'send-rejected');
  assert.equal(r.code, 5002);
  assert.equal(r.landed, false);
  assert.equal(r.base, 80);
});

test('preMarchSwap：待机=出征皮时当前已在出征皮 → skip(already-on-target)，零发包', async () => {
  resetThrottle();
  const gd = fakeGameData({ using: MARCH_SKIN });
  const net = fakeNet({ gameData: gd });
  const r = await preMarchSwap({
    cfg: cfg({ idleMode: IDLE_MODE.MARCH }),
    net,
    gameData: gd,
    presetIndex: 1,
    signal: null,
    ...fast,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'already-on-target');
  assert.equal(net.calls.length, 0);
});

// ── afterMarchSwap（相位 C）+ 在途账本（相位 D）────────────────────────
test('afterMarchSwap：切回主战皮并把 902 的 marchId 记进在途账本', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: MARCH_SKIN });
  const net = fakeNet({ gameData: gd });
  const r = await afterMarchSwap({
    cfg: cfg(),
    net,
    gameData: gd,
    signal: null,
    marchId: '4945946073029043205',
    ...fast,
  });
  assert.equal(r.reason, 'switched');
  assert.equal(r.tracked, true);
  assert.equal(net.calls[0].body.skinId, BATTLE_SKIN);
  assert.equal(pendingCount(), 1);
  disarm();
});

test('afterMarchSwap：链不在场（未启用 / 未选皮）一律不发包也不入账（零回归）', async () => {
  for (const c of [cfg({ enabled: false }), cfg({ marchSkin: SKIN_UNSET })]) {
    resetThrottle();
    disarm();
    const gd = fakeGameData({ using: MARCH_SKIN });
    const net = fakeNet({ gameData: gd });
    const r = await afterMarchSwap({
      cfg: c,
      net,
      gameData: gd,
      signal: null,
      marchId: '1',
      ...fast,
    });
    assert.equal(r.tracked, false, 'reason=' + r.reason);
    assert.equal(net.calls.length, 0);
    assert.equal(pendingCount(), 0);
  }
  disarm();
});

test('afterMarchSwap：回切被拒仍要入账——相位 D 的待机归位必须发生', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: MARCH_SKIN });
  const net = fakeNet({ gameData: gd, ok: false, code: 5002 });
  const r = await afterMarchSwap({
    cfg: cfg(),
    net,
    gameData: gd,
    signal: null,
    marchId: '77',
    ...fast,
  });
  assert.equal(r.reason, 'send-rejected');
  assert.equal(r.tracked, true);
  assert.equal(pendingCount(), 1);
  disarm();
});

test('trackMarch：空/缺失 marchId 不入账（应答畸形不背永挂的账）', () => {
  disarm();
  assert.equal(trackMarch(null), false);
  assert.equal(trackMarch(undefined), false);
  assert.equal(trackMarch(''), false);
  assert.equal(pendingCount(), 0);
  assert.equal(trackMarch('123', BATTLE_SKIN), true);
  assert.equal(pendingCount(), 1);
  disarm();
});

test('相位 D：部队开始返程把账本里的行军销掉，账本清空才按待机档归位', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  let edgeCb = null;
  const march = {
    State: MARCH_STATE,
    onStateChange: (cb) => ((edgeCb = cb), () => (edgeCb = null)),
  };
  const ctx = { setTimeout: () => 11, clearTimeout() {}, signal: null };
  arm({
    net,
    ctx,
    cfg: () => cfg({ idleMode: IDLE_MODE.MARCH }),
    alive: () => true,
    gameData: gd,
    march,
  });

  trackMarch('501', MARCH_SKIN);
  assert.equal(edgeCb != null, true, 'arm 必须挂上 march.onStateChange');
  edgeCb(marchEdge(501)); // 数字 id 也要能对上字符串键
  assert.equal(pendingCount(), 0);
  assert.equal(net.calls.length, 1, '待机=出征皮：账本清空才切出征皮');
  assert.equal(net.calls[0].body.skinId, MARCH_SKIN);
  disarm();
});

test('相位 D 主键契约：10019 回调给的是 core/march.js decode() 的 March（主键在 .id，线上 marchId 只在 .raw 里）', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  let edgeCb = null;
  arm({
    net,
    ctx: { setTimeout: () => 11, clearTimeout() {}, signal: null },
    cfg: () => cfg({ idleMode: IDLE_MODE.MARCH }),
    alive: () => true,
    gameData: gd,
    march: { State: MARCH_STATE, onStateChange: (cb) => ((edgeCb = cb), () => (edgeCb = null)) },
  });

  // 报文实证 dashcam 20261126T025211-城皮切换：902 resp 与 10019 push 的 marchId 同为字符串，超 2^53
  trackMarch('4946043221380850741', MARCH_SKIN);
  edgeCb(marchEdge('4946043221380850741'));
  assert.equal(pendingCount(), 0, '按 .id 必须销账');
  assert.equal(net.calls.length, 1, '销账即归位（这一发就是旧实现整场没打的那发）');

  // 只带 raw（无 .id）也要能回落对上；两者都缺则静默跳过不崩
  // 相位 D 走的是 arm 时抓住的那对 net/gameData，所以先把现场拨回「还在主战皮」并清空记录
  resetThrottle();
  gd.state.using = BATTLE_SKIN;
  net.calls.length = 0;
  trackMarch('7788', MARCH_SKIN);
  edgeCb({ state: 3, raw: { marchInfo: { marchId: '7788' } } });
  assert.equal(pendingCount(), 0);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].body.skinId, MARCH_SKIN);

  resetThrottle();
  trackMarch('99', MARCH_SKIN);
  edgeCb({ state: 4 }); // 无从判定：不得误销别人的账
  assert.equal(pendingCount(), 1);
  edgeCb({ id: '别的行军', state: 3 }); // 账本里没这条：不动账
  assert.equal(pendingCount(), 1);
  assert.equal(net.calls.length, 1, '账没对上就不归位');
  disarm();
});

test('相位 D：待机=主战皮且已在主战皮 → 销账但零发包（debug no-op）', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  let edgeCb = null;
  const march = {
    State: MARCH_STATE,
    onStateChange: (cb) => ((edgeCb = cb), () => (edgeCb = null)),
  };
  const ctx = { setTimeout: () => 11, clearTimeout() {}, signal: null };
  arm({ net, ctx, cfg: () => cfg(), alive: () => true, gameData: gd, march });

  trackMarch('502', MARCH_SKIN);
  edgeCb(marchEdge('502'));
  assert.equal(pendingCount(), 0);
  assert.equal(net.calls.length, 0);
  // 账本里还有别的波次时不收尾（三连并发下不能被第一波返程提前归位）
  trackMarch('503', MARCH_SKIN);
  trackMarch('504', MARCH_SKIN);
  edgeCb(marchEdge('503'));
  assert.equal(pendingCount(), 1);
  assert.equal(net.calls.length, 0);
  disarm();
});

test('restoreIdleSkin：本波没打出去时的归位入口——账本非空让位相位 D，空则按待机档切', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: MARCH_SKIN }); // 停在出征皮（A 相切完但 902 被拒）

  // 账本非空：自己的波次还在路上，绝不能抢在它的返程归位（相位 D）之前换皮
  const netA = fakeNet({ gameData: gd });
  trackMarch('600', MARCH_SKIN);
  let r = await restoreIdleSkin({ cfg: cfg(), net: netA, gameData: gd });
  assert.equal(r.send, false);
  assert.equal(r.reason, 'pending-in-flight');
  assert.equal(netA.calls.length, 0);
  disarm(); // 清账本

  // 账本空 + 待机=主战皮：切回主战皮
  resetThrottle();
  const netB = fakeNet({ gameData: gd });
  r = await restoreIdleSkin({ cfg: cfg(), net: netB, gameData: gd });
  assert.equal(r.send, true);
  assert.equal(r.reason, m.REASON.SWITCH);
  assert.equal(netB.calls.length, 1);
  assert.equal(netB.calls[0].body.skinId, BATTLE_SKIN);

  // 零回归：未启用时一个包都不发
  resetThrottle();
  const netC = fakeNet({ gameData: gd });
  r = await restoreIdleSkin({ cfg: cfg({ enabled: false }), net: netC, gameData: gd });
  assert.equal(r.send, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(netC.calls.length, 0);
});

test('arm 可重入（resume 重跑 run）：先摘旧订阅再挂，不重复注册', () => {
  disarm();
  let offs = 0;
  const march = { State: MARCH_STATE, onStateChange: () => () => offs++ };
  const ctx = { setTimeout: () => 1, clearTimeout() {}, signal: null };
  const h = {
    net: fakeNet({}),
    ctx,
    cfg: () => cfg(),
    alive: () => true,
    gameData: fakeGameData({}),
    march,
  };
  arm(h);
  arm(h);
  assert.equal(offs, 1, '第二次 arm 必须先退订第一条');
  disarm();
});

test('disarm：清账本 + 摘订阅，停用后不再按陈旧配置切皮', () => {
  disarm();
  let offs = 0;
  const march = { State: MARCH_STATE, onStateChange: () => () => offs++ };
  const ctx = { setTimeout: () => 1, clearTimeout() {}, signal: null };
  arm({
    net: fakeNet({}),
    ctx,
    cfg: () => cfg(),
    alive: () => true,
    gameData: fakeGameData({}),
    march,
  });
  trackMarch('900', MARCH_SKIN);
  assert.equal(pendingCount(), 1);
  disarm();
  assert.equal(pendingCount(), 0);
  assert.equal(offs, 1);
});

// ── selfHeal（run 期自愈）──────────────────────────────────────────────
test('selfHeal：刷新页面时停在出征皮 → 切回主战皮；在途账本非空 / 待机=出征皮时不抢切', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: MARCH_SKIN });
  const net = fakeNet({ gameData: gd });
  const ctx = { setTimeout: () => 1, clearTimeout() {}, signal: null };
  const h = { net, ctx, cfg: () => cfg(), alive: () => true, gameData: gd };
  await selfHeal(h);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].body.skinId, BATTLE_SKIN);

  // 账本非空：自己的波次还在路上，交给相位 D
  resetThrottle();
  const net2 = fakeNet({ gameData: gd });
  trackMarch('901', MARCH_SKIN);
  await selfHeal({ ...h, net: net2 });
  assert.equal(net2.calls.length, 0);
  disarm();

  // 待机=出征皮：停在出征皮是正确状态，不该自愈
  resetThrottle();
  const gd3 = fakeGameData({ using: MARCH_SKIN });
  const net3 = fakeNet({ gameData: gd3 });
  await selfHeal({
    net: net3,
    ctx,
    cfg: () => cfg({ idleMode: IDLE_MODE.MARCH }),
    alive: () => true,
    gameData: gd3,
  });
  assert.equal(net3.calls.length, 0);

  // 未启用：一个包都不发
  resetThrottle();
  const net4 = fakeNet({ gameData: gd });
  await selfHeal({
    net: net4,
    ctx,
    cfg: () => cfg({ enabled: false }),
    alive: () => true,
    gameData: gd,
  });
  assert.equal(net4.calls.length, 0);
});

// ── 行军节奏时钟（attackFlow 靠它决定 902 前要不要等）──────────────────────
test('msSinceLastSkinSend：只有真上线的 855 才占拍（零发包/未发出都不占），resetThrottle 一并复位', async () => {
  resetThrottle();
  disarm();
  assert.equal(msSinceLastSkinSend(), Infinity, '从未发过 855 → Infinity（未启用切皮时零等待）');

  // net 形态不符 = 根本没上线：不得假装「刚发过一发」
  const gd = fakeGameData({ using: BATTLE_SKIN });
  await ensureSkin(MARCH_SKIN, { net: {}, gameData: gd, ...fast });
  assert.equal(msSinceLastSkinSend(), Infinity, '未上线的 855 不记节奏');

  // 已在目标皮的 no-op：零发包，同样不占服务器那条时钟
  await ensureSkin(BATTLE_SKIN, { net: fakeNet({ gameData: gd }), gameData: gd, ...fast });
  assert.equal(msSinceLastSkinSend(), Infinity, '零发包的 no-op 不占拍');

  // 真发一发 → 时钟就位
  const net = fakeNet({ gameData: gd });
  await ensureSkin(MARCH_SKIN, { net, gameData: gd, ...fast });
  const since = msSinceLastSkinSend();
  assert.equal(Number.isFinite(since), true, '真发过就必须是个真实时刻');
  assert.equal(since < 1000, true, `刚发过 → 距上一发近乎 0，实得 ${since}ms`);

  resetThrottle();
  assert.equal(msSinceLastSkinSend(), Infinity, '复位节流也要复位节奏');
});

// ── 相位 D 的触发时机（返程 vs 到家）───────────────────────────────────
test('相位 D 触发时机：state 3（开始返程）即归位；去程/到达边沿不销账，到家(4) 只作漏推兜底', async () => {
  resetThrottle();
  disarm();
  const gd = fakeGameData({ using: BATTLE_SKIN });
  const net = fakeNet({ gameData: gd });
  let edgeCb = null;
  arm({
    net,
    ctx: { setTimeout: () => 11, clearTimeout() {}, signal: null },
    cfg: () => cfg({ idleMode: IDLE_MODE.MARCH }),
    alive: () => true,
    gameData: gd,
    march: { State: MARCH_STATE, onStateChange: (cb) => ((edgeCb = cb), () => (edgeCb = null)) },
  });

  // 报文实证 dashcam 20261126T025211 / 031109：state 迁移是 1→3→4，3 比 4 早 6–15s，且 3 与 marchArrive 同刻
  trackMarch('3001', MARCH_SKIN);
  edgeCb(marchEdge('3001', 1)); // 去程
  assert.equal(pendingCount(), 1, '去程边沿不得销账');
  edgeCb(marchEdge('3001', 2)); // 到达目标（战斗结算就在这一刻）
  assert.equal(pendingCount(), 1, '到达边沿不得提前归位（结算还没做完）');
  assert.equal(net.calls.length, 0);

  edgeCb(marchEdge('3001', 3)); // 开始返程
  assert.equal(pendingCount(), 0, '返程即销账归位');
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].body.skinId, MARCH_SKIN);

  // 同一行的到家边沿随后也到：账已销清，不得重复发包
  edgeCb(marchEdge('3001', 4));
  assert.equal(net.calls.length, 1, '到家只是兜底，不重复归位');

  // 返程漏推时，到家兜底仍能收尾（把现场拨回「还在主战皮」并清掉同皮节流）
  resetThrottle();
  gd.state.using = BATTLE_SKIN;
  trackMarch('3002', MARCH_SKIN);
  edgeCb(marchEdge('3002', 4));
  assert.equal(pendingCount(), 0);
  assert.equal(net.calls.length, 2, '只见到家边沿也必须归位');
  disarm();
});

test('arm 契约：march 底座缺 onStateChange 或缺 State → 明确放弃挂载（相位 D 不允许静默失效）', () => {
  disarm();
  let edgeCb = null;
  const base = {
    net: fakeNet({}),
    ctx: { setTimeout: () => 1, clearTimeout() {}, signal: null },
    cfg: () => cfg(),
    alive: () => true,
    gameData: fakeGameData({}),
  };
  // 有 onStateChange 但没 State：无法判定哪条边沿算返程，不得留下半截订阅
  arm({ ...base, march: { onStateChange: (cb) => ((edgeCb = cb), () => (edgeCb = null)) } });
  assert.equal(edgeCb, null, 'State 缺失时不得只挂订阅');
  // 还只提供旧 onHomeReturn 的底座：不算可用
  arm({ ...base, march: { State: MARCH_STATE, onHomeReturn: (cb) => ((edgeCb = cb), () => {}) } });
  assert.equal(edgeCb, null, 'onHomeReturn 不再是被依赖的入口');
  disarm();
});
