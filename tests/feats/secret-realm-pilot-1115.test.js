// 异能秘境 1115 队长场十问题修复 · 专项单测（计划 D2/C2/E/B/C1 组）。
// 覆盖：pickResource 快照新鲜度惩罚（D2）、plans shopStage 让位 BOSS 窗（C2）、
//   pilot.onPvpInfo 连输 2 场即逃（E，系统默认 tuning.drivePvpFleeLossStreak）、pilot.onOwnMarch 手动接管检测（B，二轮收口=driveAutoOff 自动取消勾选）与 steerState 访问器、
//   低保系统默认闸（C1：shopType3ItemIds 行为 + #tick 前置闸/面板配置源码契约，同 plan-socket 范式；
//   闸行为见 secret-realm-shop-floor.test.js）。
// D1（pickHopTile teams>0 闸）与 A4（142 bossAreaDemoteMs）分别落在
//   secret-realm-pilot.test.js / secret-realm-rejects.test.js 的既有用例里（同表回归）。
// 桩化口径与 secret-realm-pilot.test.js 相同：先最小桩 window/document/chrome 再动态 import；
//   PilotEngine constructor 仅存 env，#kick 无 cycle 时只置位——可用 mock env 直接实例化测公开方法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const { pickResource, pickHopTile } =
  await import('../../extension/src/feats/activity/secret-realm/pilot-select.js');
const { PLANS } = await import('../../extension/src/feats/activity/secret-realm/plans.js');
const { PilotEngine } = await import('../../extension/src/feats/activity/secret-realm/pilot.js');
const { shopType3ItemIds } =
  await import('../../extension/src/feats/activity/secret-realm/shop.js');
const C = await import('../../extension/src/feats/activity/secret-realm/constants.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const featDir = path.join(here, '../../extension/src/feats/activity/secret-realm');

// ── D2：pickResource 快照新鲜度惩罚 ──────────────────────────────────────
// 两口对称井（距起点同 10 格、同产 8）：无新鲜度料时打分平手取先见者 A；
//   喂入 tileAt/nowMs 后陈旧井 A（3min 前快照）扣 18 分，让位近期视口井 B。
const PAB_RESOURCE = 173;
function wellPts() {
  return [
    { x: 10, y: 0, pointType: PAB_RESOURCE, m: { iNum: 8, state: 0, teams: [], esrId: 14 } },
    { x: 0, y: 10, pointType: PAB_RESOURCE, m: { iNum: 8, state: 0, teams: [], esrId: 14 } },
  ];
}
function wellCtx(over) {
  return Object.assign(
    {
      startPoint: { x: 0, y: 0 },
      serverTimeSec: Math.floor(Date.now() / 1000),
      minNum: 5,
      maxDist: Infinity,
      isRoundOpen: () => true,
      marches: [],
      marchedList: [],
      marchPolicy: 0,
    },
    over,
  );
}

test('D2 新鲜度：陈旧快照井让位近期视口井（3min 陈旧扣 18 分 > 平手差）', () => {
  const now = 1_000_000_000_000;
  const at = { '10,0': now - 180_000, '0,10': now - 1_000 }; // A 陈旧 3min / B 1s 前刚更新
  const got = pickResource(
    wellPts(),
    wellCtx({
      nowMs: now,
      tileAt: (x, y) => at[x + ',' + y] || 0,
      staleScorePerSec: 0.1,
    }),
  );
  assert.ok(got, '应能选出井');
  assert.equal(got.x + ',' + got.y, '0,10', '陈旧井 A 必须让位新鲜井 B');
});

test('D2 向后兼容：未喂 tileAt/nowMs 不扣分（平手取先见者）；tileAt 回 0 也不扣', () => {
  const bare = pickResource(wellPts(), wellCtx());
  assert.equal(bare.x + ',' + bare.y, '10,0', '无新鲜度料 → 旧行为不变');
  const now = 1_000_000_000_000;
  const unknown = pickResource(
    wellPts(),
    wellCtx({ nowMs: now, tileAt: () => 0, staleScorePerSec: 0.1 }),
  );
  assert.equal(unknown.x + ',' + unknown.y, '10,0', '快照时刻未知(0) 不惩罚');
  const off = pickResource(
    wellPts(),
    wellCtx({
      nowMs: now,
      tileAt: (x, _y) => (x === 10 ? now - 180_000 : now),
      staleScorePerSec: 0, // 配置 0 = 关闭惩罚
    }),
  );
  assert.equal(off.x + ',' + off.y, '10,0', 'staleScorePerSec=0 时陈旧不扣分');
});

test('D2 常量：tuning.driveStaleScorePerSec 缺省 0.1（3min 陈旧扣 18 分的口径来源）', () => {
  assert.equal(C.tuning.driveStaleScorePerSec, 0.1);
});

// ── C2：plans shopStage 让位 BOSS 窗 ─────────────────────────────────────
const shopStage = PLANS.default.stages.find((s) => s.id === 'shopStage');

test('C2 shopStage：BOSS 窗活跃(open/lead)或投喂窗 → 不命中，让位 boss 链', () => {
  assert.ok(shopStage && shopStage.terminal, 'shopStage 仍是 terminal 店档');
  const base = {
    shopWhy: 'stage',
    teamType: 2,
    bossMode: null,
    bossFeeding: false,
  };
  assert.equal(shopStage.when(base), true, '无 BOSS 窗 → 节拍去店照常');
  assert.equal(shopStage.when({ ...base, bossMode: 'open' }), false, '开打窗让位');
  assert.equal(shopStage.when({ ...base, bossMode: 'lead' }), false, '开台读秒窗让位');
  // 投喂窗 state23 时 bossMode=null（1115 实录 20:30 正是此形态）→ 也必须让位
  assert.equal(shopStage.when({ ...base, bossFeeding: true }), false, '投喂窗让位 bossWait');
});

test('C2 shopStage：tier0 纯采集不受 BOSS 闸影响；非 stage 理由不命中', () => {
  const base = {
    shopWhy: 'stage',
    teamType: 2,
    bossMode: 'open',
    bossFeeding: false,
  };
  assert.equal(shopStage.when({ ...base, teamType: 0 }), true, 'tier0 不挪平台，BOSS 闸不适用');
  assert.equal(shopStage.when({ ...base, bossMode: null, shopWhy: '' }), false, '无去店理由不命中');
  assert.equal(
    shopStage.when({ ...base, bossMode: null, shopWhy: 'exit' }),
    false,
    'exit 归 shopExit 档',
  );
});

test('C2 阶段顺序：shopStage 让位后 bossWait（投喂窗短睡）仍在链上接得住', () => {
  const ids = PLANS.default.stages.map((s) => s.id);
  assert.ok(ids.indexOf('shopStage') < ids.indexOf('bossWait'), 'bossWait 必须排在 shopStage 之后');
});

// ── E/B：PilotEngine 公开方法（mock env 实例化，不 start、不触网）──────────
/** 造一台只带最小 env 的引擎：cfg/log/marchIntentMatch 全可控，logs 收 info 文案。 */
function mkEngine(driveOver, envOver) {
  const logs = [];
  const drive = Object.assign({ enabled: true }, driveOver);
  const env = Object.assign(
    {
      cfg: () => ({ drive }),
      log: {
        info: (...a) => logs.push(a.join(' ')),
        warn: () => {},
        error: () => {},
        debug: (...a) => logs.push(a.join(' ')),
      },
      marchIntentMatch: () => false,
    },
    envOver,
  );
  return { eng: new PilotEngine(env), logs, drive };
}
/** 21523 推送事件（实录载荷 {x,y,info:{round,leftWinNum,rightWinNum,isEnd}}）。 */
function pvpEv(x, y, round, left, right, isEnd) {
  return {
    data: { x, y, info: { round, leftWinNum: left, rightWinNum: right, isEnd: isEnd || 0 } },
  };
}
const lostLogs = (logs) => logs.filter((s) => s.includes('reason=pvp_loss_streak'));
const takeoverLogs = (logs) => logs.filter((s) => s.includes('reason=manual_takeover'));

test('E 连输即逃：LL（连输 2 场）触发败退并留痕；单输不逃；同回合重复推送只记账', () => {
  const { eng, logs } = mkEngine();
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0)); // 首笔只记账
  assert.equal(lostLogs(logs).length, 0);
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1)); // 输第 1 场：streak=1 未达阈
  assert.equal(lostLogs(logs).length, 0, '单输不逃（系统默认连输 2 场）');
  eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2)); // 输第 2 场：streak=2 → 逃
  assert.equal(lostLogs(logs).length, 1, '连输 2 场应触发败退');
  eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2)); // 同回合重复推送
  assert.equal(lostLogs(logs).length, 1, '同场去重');
});

test('E WLL 逃 / LWL 不逃：赢一场清零连输账', () => {
  const a = mkEngine();
  a.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  a.eng.onPvpInfo(pvpEv(92, 170, 2, 1, 0)); // 赢
  a.eng.onPvpInfo(pvpEv(92, 170, 3, 1, 1)); // 输 streak=1
  assert.equal(lostLogs(a.logs).length, 0);
  a.eng.onPvpInfo(pvpEv(92, 170, 4, 1, 2)); // 输 streak=2 → 逃
  assert.equal(lostLogs(a.logs).length, 1, 'WLL 触发');
  const b = mkEngine();
  b.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  b.eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1)); // 输 1
  b.eng.onPvpInfo(pvpEv(92, 170, 3, 1, 1)); // 赢清零
  b.eng.onPvpInfo(pvpEv(92, 170, 4, 1, 2)); // 输 1
  assert.equal(lostLogs(b.logs).length, 0, 'LWL 不触发');
});

test('E 判据边界：right 回退(换对手)不判输；回合回退复位连输账；异点重开账不跨点判输', () => {
  const { eng, logs } = mkEngine();
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1)); // 输 1
  eng.onPvpInfo(pvpEv(92, 170, 3, 0, 0)); // right 回退：不输不赢不动账
  assert.equal(lostLogs(logs).length, 0, 'right 回退不得判输');
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0)); // 回合回退（异常推送）→ 复位连输账
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1)); // 复位后只连输 1 场
  assert.equal(lostLogs(logs).length, 0, '回合回退复位后不跨异常判输');
  const c = mkEngine();
  c.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  c.eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  c.eng.onPvpInfo(pvpEv(50, 50, 3, 0, 2)); // 异点：新遭遇首笔
  assert.equal(lostLogs(c.logs).length, 0, '异点推送是新遭遇的首笔，不跨点判输');
});

test('E 本场只逃一次 + isEnd 复位：逃过后连输不再逃；isEnd 后新遭遇可再逃（平铺载荷兼容）', () => {
  const { eng, logs } = mkEngine();
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2)); // 逃
  assert.equal(lostLogs(logs).length, 1);
  eng.onPvpInfo(pvpEv(92, 170, 4, 0, 3)); // 异常续推（无 isEnd）：已逃过不再逃
  assert.equal(lostLogs(logs).length, 1, '本场已逃过：只逃一次');
  eng.onPvpInfo(pvpEv(92, 170, 4, 0, 3, 1)); // isEnd：末场结算不再逃 + 复位账
  assert.equal(lostLogs(logs).length, 1, 'isEnd 推送本身不触发败退');
  // 新遭遇（平铺载荷形态）：round 从 1 重开 → 连输 2 场仍可逃
  eng.onPvpInfo({ data: { x: 60, y: 60, round: 1, leftWinNum: 0, rightWinNum: 0, isEnd: 0 } });
  eng.onPvpInfo({ data: { x: 60, y: 60, round: 2, leftWinNum: 0, rightWinNum: 1, isEnd: 0 } });
  eng.onPvpInfo({ data: { x: 60, y: 60, round: 3, leftWinNum: 0, rightWinNum: 2, isEnd: 0 } });
  assert.equal(lostLogs(logs).length, 2, 'isEnd 复位后新遭遇可再逃');
});

test('E 关档不跟踪：drive.enabled=false 时连输也不置败退', () => {
  const { eng, logs } = mkEngine({ enabled: false });
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2));
  assert.equal(lostLogs(logs).length, 0);
});

test('B 手动接管：intent 命中=扩展自身（不调 driveAutoOff）；不命中=用户手动 → 清意图 + 自动取消勾选', () => {
  const calls = [];
  let offCalls = 0;
  const h = mkEngine(null, {
    marchIntentMatch: (x, y, ts) => {
      calls.push({ x, y, ts });
      return x === 169 && y === 193; // 只有这一笔是扩展自身发的
    },
    // ≡ index.js buildEnv.driveAutoOff：置 driveEnabled=false（落盘持久化），cfg-off 闸自然停摆
    driveAutoOff: () => {
      offCalls++;
      h.drive.enabled = false;
    },
  });
  assert.equal(h.eng.steerState(), null, '空闲无在途转向');
  h.eng.onOwnMarch({ data: { x: 169, y: 193 }, ts: 1000 });
  assert.equal(offCalls, 0, 'intent 命中不得误判手动');
  assert.deepEqual(calls[0], { x: 169, y: 193, ts: 1000 }, '坐标取整后连 ts 一起喂匹配器');
  h.eng.onOwnMarch({ data: { x: 92, y: 170 }, ts: 2000 }); // 用户手发（1115 实录 20:26:55 形态）
  assert.equal(offCalls, 1, '不匹配 = 手动接管 → 自动取消自动驾驶勾选');
  assert.equal(h.drive.enabled, false, 'spy 落盘后 drive.enabled=false');
  assert.equal(takeoverLogs(h.logs).length, 1);
  assert.equal(h.eng.steerState(), null, '接管清转向意图');
  // 取消后再来的手动行军：cfg-off 闸直接 return，不重复调/不重复留痕（幂等）
  h.eng.onOwnMarch({ data: { x: 50, y: 50 }, ts: 3000 });
  assert.equal(offCalls, 1);
  assert.equal(takeoverLogs(h.logs).length, 1);
});

test('B 关档不判：drive.enabled=false 时手动行军是正常形态，不调 driveAutoOff', () => {
  let offCalls = 0;
  const { eng } = mkEngine(
    { enabled: false },
    {
      driveAutoOff: () => {
        offCalls++;
      },
    },
  );
  eng.onOwnMarch({ data: { x: 92, y: 170 }, ts: 1000 });
  assert.equal(offCalls, 0);
});

test('B 匹配器缺席兜底：env 无 marchIntentMatch 时任何 8521 都按手动处理（保守停手）', () => {
  let offCalls = 0;
  const { eng, logs } = mkEngine(null, {
    marchIntentMatch: undefined,
    driveAutoOff: () => {
      offCalls++;
    },
  });
  eng.onOwnMarch({ data: { x: 92, y: 170 }, ts: 1000 });
  assert.equal(offCalls, 1, '匹配器缺席按手动调 driveAutoOff');
  assert.equal(takeoverLogs(logs).length, 1);
});

test('B driveAutoOff 缺席静默降级：env 无该函数时接管只清意图留痕，不抛错', () => {
  const { eng, logs } = mkEngine(null, { marchIntentMatch: undefined });
  assert.doesNotThrow(() => eng.onOwnMarch({ data: { x: 92, y: 170 }, ts: 1000 }));
  assert.equal(takeoverLogs(logs).length, 1);
});

// ── C1：低保（type3 传奇百兽箱碎片自选箱）优先 ───────────────────────
test('C1 低保识别：shopType3ItemIds 只收 type===3 行；表未就绪/抛错回空对象', () => {
  const l10n = {
    tableRows: (t) => {
      assert.equal(t, C.TABLE_SHOP, '只查货表');
      return [
        { id: 1, type: 3, item_id: 38006601 }, // 低保
        { id: 2, type: 1, item_id: 41011 }, // 香肠非 type3
        { id: 3, type: '3', item_id: 38006602 }, // 字符串 type 兼容
        { id: 4, type: 3, item_id: 0 }, // 非法 itemId 不收
        null,
      ];
    },
  };
  assert.deepEqual(shopType3ItemIds(l10n), { 38006601: 1, 38006602: 1 });
  assert.deepEqual(shopType3ItemIds({ tableRows: () => null }), {});
  assert.deepEqual(
    shopType3ItemIds({
      tableRows: () => {
        throw new Error('table not ready');
      },
    }),
    {},
    '表未就绪不得抛错，回空集',
  );
});

test('C1 低保经济常量：spec20 = 38006601 传奇百兽箱碎片自选箱，单价 2000 晶块', () => {
  assert.equal(C.SHOP_SPEC_ECONOMY[20].itemId, 38006601);
  assert.equal(C.SHOP_SPEC_ECONOMY[20].price, 2000);
});

/** 源码方法体定界（同 plan-socket 范式）：从方法名起找到首个 2 空格缩进的闭合行。 */
function methodBody(src, name) {
  const start = src.indexOf(name);
  assert.ok(start > 0, '源码里找不到 ' + name);
  const end = src.indexOf('\n  }', start);
  assert.ok(end > start, name + ' 方法体定界失败');
  return src.slice(start, end);
}

test('C1 低保系统默认闸契约：#tick 前置闸先于补货动作；停购出口有边沿日志；玩家开关已移除', () => {
  const src = readFileSync(path.join(featDir, 'shop.js'), 'utf8');
  const tick = methodBody(src, '#tick() {'); // 定义签名锚点：避开 start 里的调用点
  const act = methodBody(src, '#actOnce(cur) {');
  const fi = tick.indexOf('#floorOwedWhy(');
  const ai = tick.indexOf('#actOnce(cur)');
  assert.ok(fi > 0 && ai > fi, '低保闸在 #tick 里先于 #actOnce 求值（系统默认优先）');
  assert.ok(/g\.edge\(\s*'floor-block'/.test(tick), '停购闸有边沿日志（dashcam 单轨定责）');
  assert.ok(tick.includes('hold ALL other purchases'), '停购语义：欠低保且不可得时本轮什么都不买');
  assert.ok(tick.includes('#floorOwedQuick()'), '未到店轮询择时看低保欠位（队员到店窗不漏）');
  assert.ok(!act.includes('#grabType3('), 'type3 购买只经前置闸，不在补货排序里');
  assert.ok(!src.includes('beastBoxFirst'), '玩家开关已移除（系统默认行为）');
  assert.ok(!src.includes('#bossCleared'), '清台排序回落已移除（低保无条件优先）');
  assert.ok(src.includes('this.#floorGot = false'), '「买到」位按场复位在位');
});

test('C1 配置契约：面板二轮收口——展示行/离场/侦察开关删除，抓宠合并 drivePetLevel select + v2 migrate', () => {
  const src = readFileSync(path.join(featDir, 'index.js'), 'utf8');
  // 低保是系统默认行为：面板/defaults/归一链不得再有任何开关痕迹
  assert.ok(!src.includes('driveBeastBoxFirst'), '面板/defaults/归一链不得再有低保开关');
  // 二轮收口：展示行与废弃开关不得再有 field/defaults 形态（migrate 里读/删旧键属合法兼容路径）
  for (const k of [
    'floorStatus',
    'driveManualStatus',
    'autoLeaveEnabled',
    'scoutEnabled',
    'driveBeast',
    'driveBeastQuality',
  ]) {
    assert.ok(!src.includes("key: '" + k + "'"), '面板收口：field ' + k + ' 不得再出现');
    assert.ok(!src.includes(k + ':'), '面板收口：defaults/归一链键 ' + k + ' 不得再出现');
  }
  // 面板收口：可系统化的行为一律默认生效或收进开车方案/系统常量，field/defaults/归一链无残留
  for (const k of [
    'healEnabled',
    'healThreshold',
    'healMaxPerTick',
    'healItems',
    'warnEnabled',
    'warnMode',
    'driveBoss',
    'driveRevive',
    'driveCheckPower',
    'driveShopTime',
    'drivePvpFleeRounds',
    'driveEmptyDwell',
  ]) {
    assert.ok(!src.includes(k), '面板收口：' + k + ' 不得再出现');
  }
  assert.ok(src.includes("key: 'driveWarnStand'"), '攻击警告硬刚到底 checkbox 在位');
  assert.ok(src.includes('driveWarnStand: false'), 'defaults 硬刚到底缺省关（=立即转移）');
  assert.ok(src.includes('warnStand: e.warnStand === true'), 'sanitizeDrive 归布尔');
  // 抓宠单键 select：不抓宠/至少1~4星五档，defaults 4，v2 migrate 保留旧抓宠意图
  assert.ok(src.includes("key: 'drivePetLevel'"), '抓宠等级 select 在位');
  assert.ok(src.includes("label: '不抓宠'"), 'select 含不抓宠档');
  assert.ok(src.includes("label: '至少4星'"), 'select 含至少4星档');
  assert.ok(src.includes('drivePetLevel: 4'), 'defaults 抓宠等级缺省 4');
  assert.ok(src.includes('version: 2'), '配置版本 v2');
  assert.ok(src.includes('migrate: function (c, from)'), 'v2 migrate 在位（旧档保留抓宠意图）');
  // 拿满自动离场废弃：leave.js 删除；侦察改派生闸（drive.enabled && petLevel>0，无面板开关）
  assert.ok(!existsSync(path.join(featDir, 'leave.js')), 'leave.js 已删除（拿满自动离场废弃）');
  const scout = readFileSync(path.join(featDir, 'scout.js'), 'utf8');
  assert.ok(scout.includes('const dv = env.cfg().drive || {};'), 'scout 读运行时 drive 配置');
  assert.ok(
    scout.includes('!(dv.enabled && Number(dv.petLevel) > 0)'),
    'scout 派生闸：自动驾驶开启且抓宠等级>0 才侦察',
  );
  // 系统常量：治疗掉血阈值 10% / 连输 2 场即逃
  assert.equal(C.tuning.healLossPct, 10, 'healLossPct 系统常量 10%');
  assert.equal(C.tuning.drivePvpFleeLossStreak, 2, '系统默认连输 2 场逃');
});

// ── 两种战斗模式 + 警告验真（1115 复核 warn-reaudit）─────────────────────
// 域知识（用户拍板）：BOSS 平台（176/177/178）与玩家是 1 局定胜负的直接战斗、立即判输赢，无场次；
//   非 BOSS 点（井 173/捕获平台 172）才有三局两胜。21534 恒只有 {num}：BOSS 交战期大 num
//   =争夺计数误告（46/46 本点无敌 UID）；井位到点 num=1 多为噪声（9/10）。
/** 带 secret ACL 的引擎：base（点型/坐标/members）可控；其余 ACL 方法一律回 null（debugState 只读兼容）。 */
function mkEngineBase(base, driveOver) {
  const secret = new Proxy(
    { getRoomBaseInfo: () => base },
    { get: (t, k) => (k in t ? t[k] : () => null) },
  );
  return mkEngine(driveOver, { secret });
}
/** 10018 瓦片推送事件（teams 带 uid，验真料源）。 */
function tileEv(x, y, pt, teams) {
  return { data: { pointInfos: [{ x, y, pointType: pt, m: { teams, state: 0, esrId: 14 } }] } };
}
const noFoeLogs = (logs) => logs.filter((s) => s.includes('reason=warn_no_foe'));

test('E 点型闸：BOSS 平台（176/177/178）直接战斗无场次，不跟踪连输；井 173 连输 2 场照逃', () => {
  for (const pt of [176, 177, 178]) {
    const { eng, logs } = mkEngineBase({ startPoint: { x: 92, y: 170 }, pointType: pt });
    eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
    eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
    eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2));
    assert.equal(lostLogs(logs).length, 0, `pt${pt} BOSS 直接战斗不应跟踪场次`);
  }
  const w = mkEngineBase({ startPoint: { x: 92, y: 170 }, pointType: 173 });
  w.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  w.eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  w.eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2));
  assert.equal(lostLogs(w.logs).length, 1, '井 173 遭遇战连输 2 场即逃');
});

test('E 点型闸：异点战斗读瓦片快照 pt（BOSS 点也拦）；点型读不到保持旧行为', () => {
  const { eng, logs } = mkEngineBase({ startPoint: { x: 0, y: 0 }, pointType: 173 });
  eng.onTilePush(tileEv(50, 50, 176, []));
  eng.onPvpInfo(pvpEv(50, 50, 1, 0, 0));
  eng.onPvpInfo(pvpEv(50, 50, 2, 0, 1));
  eng.onPvpInfo(pvpEv(50, 50, 3, 0, 2));
  assert.equal(lostLogs(logs).length, 0, '异点 BOSS 平台快照 pt=176 也拦');
  const c = mkEngineBase({ startPoint: { x: 0, y: 0 }, pointType: 173 });
  c.eng.onPvpInfo(pvpEv(60, 60, 1, 0, 0));
  c.eng.onPvpInfo(pvpEv(60, 60, 2, 0, 1));
  c.eng.onPvpInfo(pvpEv(60, 60, 3, 0, 2));
  assert.equal(lostLogs(c.logs).length, 1, '点型读不到保持旧行为（⓪ 还有硬检查）');
});

test('警告验真：新鲜快照确证本点无敌方 UID → 忽略（BOSS 争夺计数/到点噪声）', () => {
  const { eng, logs } = mkEngineBase({
    startPoint: { x: 175, y: 177 },
    pointType: 178,
    members: [],
  });
  eng.onTilePush(tileEv(175, 177, 178, []));
  eng.onWarnPush({ data: { num: 25 } });
  assert.equal(noFoeLogs(logs).length, 1, '空队快照 → 判误告忽略');
  assert.equal(eng.debugState().phase.threat, false, '威胁位不得置起');
});

test('警告验真：本点有敌方 UID → 真攻击照置威胁；仅本队 uid（members）不算敌', () => {
  const foe = mkEngineBase({ startPoint: { x: 92, y: 170 }, pointType: 173, members: [] });
  foe.eng.onTilePush(tileEv(92, 170, 173, [{ uid: '11919925022368' }]));
  foe.eng.onWarnPush({ data: { num: 1 } });
  assert.equal(noFoeLogs(foe.logs).length, 0);
  assert.equal(foe.eng.debugState().phase.threat, true, '有敌 UID 必须置威胁');
  const mine = mkEngineBase({
    startPoint: { x: 92, y: 170 },
    pointType: 173,
    members: [{ uid: '222' }],
  });
  mine.eng.onTilePush(tileEv(92, 170, 173, [{ uid: '222' }]));
  mine.eng.onWarnPush({ data: { num: 1 } });
  assert.equal(noFoeLogs(mine.logs).length, 1, '本队成员 uid 不算敌');
  assert.equal(mine.eng.debugState().phase.threat, false);
});

test('警告验真 fail-safe：无快照/快照超龄 → 证据不足保守置威胁；num=0 清威胁', () => {
  const bare = mkEngineBase({ startPoint: { x: 92, y: 170 }, pointType: 173 });
  bare.eng.onWarnPush({ data: { num: 1 } });
  assert.equal(bare.eng.debugState().phase.threat, true, '无快照不得忽略');
  // 超龄：先喂快照再把时钟拨过 tuning.warnVerifyAgeMs
  const stale = mkEngineBase({ startPoint: { x: 92, y: 170 }, pointType: 173 });
  const realNow = Date.now;
  let fake = realNow();
  try {
    Date.now = () => fake;
    stale.eng.onTilePush(tileEv(92, 170, 173, []));
    fake += C.tuning.warnVerifyAgeMs + 5000;
    stale.eng.onWarnPush({ data: { num: 1 } });
  } finally {
    Date.now = realNow;
  }
  assert.equal(noFoeLogs(stale.logs).length, 0, '超龄快照不得判误告');
  assert.equal(stale.eng.debugState().phase.threat, true);
  stale.eng.onWarnPush({ data: { num: 0 } });
  assert.equal(stale.eng.debugState().phase.threat, false, 'num=0 转移即消警');
});

test('攻击警告档位：pilot 读 drive.warnStand（stand 全点位硬刚 / transfer 仅营帐/普通平台安全），warn.js 已删', () => {
  const src = readFileSync(path.join(featDir, 'pilot.js'), 'utf8');
  assert.ok(
    src.includes('const stand = !!((env.cfg().drive || {}).warnStand === true);'),
    'pilot 读 driveWarnStand 档位',
  );
  const safeExpr =
    'const safeHere = stand ? true : curPt === PAB_TENT || curPt === PAB_COMMON_PLANE;';
  assert.equal(src.split(safeExpr).length - 1, 2, '威胁块与 TO 到点 evade-first 两处同式');
  assert.ok(src.includes('quiet = !stand;'), 'stand 档照常干活含 BOSS 档；transfer 档让路');
  assert.ok(
    !src.includes('isBossish(curPt) && bossStand'),
    '旧 BOSS 平台豁免已移除（transfer 真攻击即撤）',
  );
  assert.ok(!src.includes('cfg().warn'), '不再读 warn 面板配置');
  assert.ok(!existsSync(path.join(featDir, 'warn.js')), 'warn.js 已删除（并入 pilot 威胁块）');
  const idx = readFileSync(path.join(featDir, 'index.js'), 'utf8');
  assert.ok(idx.includes("key: 'driveWarnStand'"), '面板只留硬刚到底 checkbox');
  assert.ok(idx.includes('driveWarnStand: false'), '缺省立即转移');
});

test('硬刚到底 stand 档：井位 173/捕获平台 172 也不逃（safeHere=stand?true 无点型限定）', () => {
  const src = readFileSync(path.join(featDir, 'pilot.js'), 'utf8');
  // stand 分支 safeHere 恒 true：无任何 pt 守卫（含资源井/捕获平台/BOSS 平台，1115 用户拍板全点位口径）
  assert.ok(
    src.includes('stand ? true : curPt === PAB_TENT || curPt === PAB_COMMON_PLANE'),
    'stand 全点位不逃同式（井位/捕获平台不再例外）',
  );
  assert.ok(!/stand \? true : [^;]*isBossish/.test(src), 'stand 判定不得掺点型特判');
  assert.ok(!/stand \? true : [^;]*PAB_RESOURCE/.test(src), 'stand 判定不得掺井位特判');
});

test('evade 落点闸：全 BOSS 点视口 → 不凭空造目标；真攻击转移落点=就近营帐（pickHopTile 同口径）', () => {
  // pilot #pickFleeTarget 委托 pickHopTile（requireFreeSlot）：BOSS 点不在候选点集，无安全落点回 null
  const tiles = [
    { k: '100,100', x: 100, y: 100, pt: 176, state: 0, teams: 1 },
    { k: '105,100', x: 105, y: 100, pt: 177, state: 0, teams: 0 },
  ];
  const ctx = { cur: { x: 100, y: 100 }, curKey: '100,100', requireFreeSlot: true };
  assert.equal(pickHopTile(tiles, ctx), null, 'BOSS 点不作 evade 落点，不凭空造目标');
  const withTent = tiles.concat([{ k: '110,100', x: 110, y: 100, pt: 175, state: 0, teams: 0 }]);
  assert.deepEqual(
    pickHopTile(withTent, ctx),
    { x: 110, y: 100, pt: 175 },
    'transfer 档真攻击撤离落点=就近营帐',
  );
});
