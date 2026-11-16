// 异能秘境 1115 队长场十问题修复 · 专项单测（计划 D2/C2/E/B/C1 组）。
// 覆盖：pickResource 快照新鲜度惩罚（D2）、plans shopStage 让位 BOSS 窗（C2）、
//   pilot.onPvpInfo 按场次输即逃（E）、pilot.onOwnMarch 手动接管检测（B）与两个公开访问器、
//   低保优先（C1：shopType3ItemIds 行为 + #actOnce 排序/面板配置源码契约，同 plan-socket 范式）。
// D1（pickHopTile teams>0 闸）与 A4（142 bossAreaDemoteMs）分别落在
//   secret-realm-pilot.test.js / secret-realm-rejects.test.js 的既有用例里（同表回归）。
// 桩化口径与 secret-realm-pilot.test.js 相同：先最小桩 window/document/chrome 再动态 import；
//   PilotEngine constructor 仅存 env，#kick 无 cycle 时只置位——可用 mock env 直接实例化测公开方法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const { pickResource } =
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
    driveBoss: true,
    bossMode: null,
    bossFeeding: false,
  };
  assert.equal(shopStage.when(base), true, '无 BOSS 窗 → 节拍去店照常');
  assert.equal(shopStage.when({ ...base, bossMode: 'open' }), false, '开打窗让位');
  assert.equal(shopStage.when({ ...base, bossMode: 'lead' }), false, '开台读秒窗让位');
  // 投喂窗 state23 时 bossMode=null（1115 实录 20:30 正是此形态）→ 也必须让位
  assert.equal(shopStage.when({ ...base, bossFeeding: true }), false, '投喂窗让位 bossWait');
});

test('C2 shopStage：tier0 纯采集 / driveBoss 关档不受 BOSS 闸影响；非 stage 理由不命中', () => {
  const base = {
    shopWhy: 'stage',
    teamType: 2,
    driveBoss: true,
    bossMode: 'open',
    bossFeeding: false,
  };
  assert.equal(shopStage.when({ ...base, teamType: 0 }), true, 'tier0 不挪平台，BOSS 闸不适用');
  assert.equal(shopStage.when({ ...base, driveBoss: false }), true, 'BOSS 自动驾驶关档不拦店');
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
  const drive = Object.assign({ enabled: true, pvpFleeRounds: [1] }, driveOver);
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
const lostLogs = (logs) => logs.filter((s) => s.includes('reason=pvp_round_lost'));
const takeoverLogs = (logs) => logs.filter((s) => s.includes('reason=manual_takeover'));

test('E 输即逃：第1场对手胜场+1（round1→2 且 right+1）命中勾选 [1] → 置败退并留痕', () => {
  const { eng, logs } = mkEngine();
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0)); // 首笔只记账
  assert.equal(lostLogs(logs).length, 0);
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1)); // 输掉第 1 场
  assert.equal(lostLogs(logs).length, 1, '输第 1 场应触发败退');
  // 同场结算重复推送 → 只逃一次
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  assert.equal(lostLogs(logs).length, 1, '同场去重');
});

test('E 勾选过滤：[2] 时输第1场不逃、输第2场才逃；全不勾 [] = 关闭', () => {
  const a = mkEngine({ pvpFleeRounds: [2] });
  a.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  a.eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1)); // 输第 1 场：未勾选
  assert.equal(lostLogs(a.logs).length, 0);
  a.eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2)); // 输第 2 场：勾选命中
  assert.equal(lostLogs(a.logs).length, 1);
  const b = mkEngine({ pvpFleeRounds: [] });
  b.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  b.eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  assert.equal(lostLogs(b.logs).length, 0, '全不勾 = 关闭输即逃');
});

test('E 判据边界：我方赢(left+1)不逃；right 回退(换对手)不逃；回合回退不逃；异点重开账不逃', () => {
  const { eng, logs } = mkEngine({ pvpFleeRounds: [1, 2, 3] });
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  eng.onPvpInfo(pvpEv(92, 170, 2, 1, 0)); // 我方赢第 1 场
  assert.equal(lostLogs(logs).length, 0, 'left+1 是赢不是输');
  eng.onPvpInfo(pvpEv(92, 170, 2, 1, 0)); // right 未变
  assert.equal(lostLogs(logs).length, 0);
  // 换对手：rightWinNum 回退 → 单调比较拦住，不误判
  eng.onPvpInfo(pvpEv(92, 170, 3, 1, 0));
  assert.equal(lostLogs(logs).length, 0, 'right 回退不得判输');
  // 回合回退（异常推送）→ 只记账
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  assert.equal(lostLogs(logs).length, 0);
  // 异点：上一笔在 (92,170)，本笔在 (50,50) → 新账不判输
  const c = mkEngine({ pvpFleeRounds: [1] });
  c.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  c.eng.onPvpInfo(pvpEv(50, 50, 2, 0, 1));
  assert.equal(lostLogs(c.logs).length, 0, '异点推送是新遭遇的首笔，不跨点判输');
});

test('E isEnd 复位：遭遇结束后下一场遭遇可再逃；平铺载荷（无 info 包层）兼容', () => {
  const { eng, logs } = mkEngine();
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  assert.equal(lostLogs(logs).length, 1);
  eng.onPvpInfo(pvpEv(92, 170, 3, 0, 2, 1)); // isEnd：末场结算不再逃 + 复位账
  assert.equal(lostLogs(logs).length, 1, 'isEnd 推送本身不触发败退');
  // 新遭遇（平铺载荷形态）：round 从 1 重开 → 仍可判输
  eng.onPvpInfo({ data: { x: 60, y: 60, round: 1, leftWinNum: 0, rightWinNum: 0, isEnd: 0 } });
  eng.onPvpInfo({ data: { x: 60, y: 60, round: 2, leftWinNum: 0, rightWinNum: 1, isEnd: 0 } });
  assert.equal(lostLogs(logs).length, 2, 'isEnd 复位后新遭遇可再逃');
});

test('E 关档不跟踪：drive.enabled=false 时输场也不置败退', () => {
  const { eng, logs } = mkEngine({ enabled: false });
  eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  assert.equal(lostLogs(logs).length, 0);
});

test('B 手动接管：intent 命中=扩展自身（消费不暂停）；不命中=用户手动 → 暂停并清意图', () => {
  const calls = [];
  const { eng, logs } = mkEngine(null, {
    marchIntentMatch: (x, y, ts) => {
      calls.push({ x, y, ts });
      return x === 169 && y === 193; // 只有这一笔是扩展自身发的
    },
  });
  assert.equal(eng.isManualPaused(), false);
  assert.equal(eng.steerState(), null, '空闲无在途转向');
  eng.onOwnMarch({ data: { x: 169, y: 193 }, ts: 1000 });
  assert.equal(eng.isManualPaused(), false, 'intent 命中不得误判手动');
  assert.deepEqual(calls[0], { x: 169, y: 193, ts: 1000 }, '坐标取整后连 ts 一起喂匹配器');
  eng.onOwnMarch({ data: { x: 92, y: 170 }, ts: 2000 }); // 用户手发（1115 实录 20:26:55 形态）
  assert.equal(eng.isManualPaused(), true, '不匹配 = 手动接管 → 暂停');
  assert.equal(takeoverLogs(logs).length, 1);
  // 幂等：暂停期再来的手动行军不重复留痕
  eng.onOwnMarch({ data: { x: 50, y: 50 }, ts: 3000 });
  assert.equal(takeoverLogs(logs).length, 1);
});

test('B 关档不判：drive.enabled=false 时手动行军是正常形态，不暂停', () => {
  const { eng } = mkEngine({ enabled: false });
  eng.onOwnMarch({ data: { x: 92, y: 170 }, ts: 1000 });
  assert.equal(eng.isManualPaused(), false);
});

test('B 匹配器缺席兜底：env 无 marchIntentMatch 时任何 8521 都按手动处理（保守停手）', () => {
  const { eng } = mkEngine(null, { marchIntentMatch: undefined });
  eng.onOwnMarch({ data: { x: 92, y: 170 }, ts: 1000 });
  assert.equal(eng.isManualPaused(), true);
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

test('C1 排序契约：#actOnce 缺省/已清台 → type3 先于香肠；关档回落 → 香肠先于 type3', () => {
  const src = readFileSync(path.join(featDir, 'shop.js'), 'utf8');
  const body = methodBody(src, '#actOnce(cur) {'); // 定义签名锚点：避开 #tick 里的调用点
  assert.ok(
    body.includes('drvCfg.beastBoxFirst !== false || this.#bossCleared()'),
    '优先闸条件：beastBoxFirst 缺省开 或 已清台',
  );
  const t3a = body.indexOf('#grabType3(');
  const sga = body.indexOf('#grabSausage(');
  const t3b = body.indexOf('#grabType3(', t3a + 1);
  const sgb = body.indexOf('#grabSausage(', sga + 1);
  assert.ok(t3a > 0 && sga > 0 && t3b > t3a && sgb > sga, '两档各有一笔 type3/香肠调用');
  assert.ok(t3a < sga, '缺省档：低保(type3)必须先于香肠（1115 问题1 主修）');
  assert.ok(sgb < t3b, '关档回落：香肠优先（竞品 shopConver 排序）');
});

test('C1 配置契约：面板缺省 driveBeastBoxFirst=true/drivePvpFleeRounds=[1]，归一链与字段在位', () => {
  const src = readFileSync(path.join(featDir, 'index.js'), 'utf8');
  // defaults：缺省开低保优先、缺省勾第 1 场
  assert.ok(/driveBeastBoxFirst:\s*true/.test(src), 'defaults.driveBeastBoxFirst 缺省 true');
  assert.ok(/drivePvpFleeRounds:\s*\[1\]/.test(src), 'defaults.drivePvpFleeRounds 缺省 [1]');
  // pickDriveRaw：只有显式 false 才关（缺省/undefined → true）
  assert.ok(
    src.includes('beastBoxFirst: !(c && c.driveBeastBoxFirst === false)'),
    'pickDriveRaw 映射 driveBeastBoxFirst',
  );
  // sanitizeDrive： !== false 口径（raw 缺失也回 true）
  assert.ok(
    src.includes('beastBoxFirst: e.beastBoxFirst !== false'),
    'sanitizeDrive 归一 beastBoxFirst',
  );
  // pvpFleeRounds 归一：非数组回缺省 [1]；只认 1/2/3；空数组保留（=关闭）
  assert.ok(
    src.includes('Array.isArray(e.pvpFleeRounds) ? e.pvpFleeRounds : [1]'),
    'sanitizeDrive 非数组回缺省 [1]',
  );
  assert.ok(src.includes('if (n !== 1 && n !== 2 && n !== 3) continue;'), '只认 1/2/3 场次');
  // 面板字段：低保开关 checkbox + 输即逃三场 multiopts
  assert.ok(src.includes("key: 'driveBeastBoxFirst'"), '面板低保优先开关在位');
  assert.ok(src.includes("key: 'drivePvpFleeRounds'"), '面板输即逃场次勾选在位');
  assert.ok(src.includes("key: 'driveManualStatus'"), '面板手动接管状态提示在位');
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

test('E 点型闸：BOSS 平台（176/177/178）直接战斗无场次，输不逃；井 173 照逃', () => {
  for (const pt of [176, 177, 178]) {
    const { eng, logs } = mkEngineBase({ startPoint: { x: 92, y: 170 }, pointType: pt });
    eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
    eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
    assert.equal(lostLogs(logs).length, 0, `pt${pt} BOSS 直接战斗不应跟踪场次`);
  }
  const w = mkEngineBase({ startPoint: { x: 92, y: 170 }, pointType: 173 });
  w.eng.onPvpInfo(pvpEv(92, 170, 1, 0, 0));
  w.eng.onPvpInfo(pvpEv(92, 170, 2, 0, 1));
  assert.equal(lostLogs(w.logs).length, 1, '井 173 遭遇战输即逃照旧');
});

test('E 点型闸：异点战斗读瓦片快照 pt（BOSS 点也拦）；点型读不到保持旧行为', () => {
  const { eng, logs } = mkEngineBase({ startPoint: { x: 0, y: 0 }, pointType: 173 });
  eng.onTilePush(tileEv(50, 50, 176, []));
  eng.onPvpInfo(pvpEv(50, 50, 1, 0, 0));
  eng.onPvpInfo(pvpEv(50, 50, 2, 0, 1));
  assert.equal(lostLogs(logs).length, 0, '异点 BOSS 平台快照 pt=176 也拦');
  const c = mkEngineBase({ startPoint: { x: 0, y: 0 }, pointType: 173 });
  c.eng.onPvpInfo(pvpEv(60, 60, 1, 0, 0));
  c.eng.onPvpInfo(pvpEv(60, 60, 2, 0, 1));
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

test('BOSS 平台战斗档位：与面板 warnMode 同档（stand 留台/transfer 撤离），缺省立即转移', () => {
  const src = readFileSync(path.join(featDir, 'pilot.js'), 'utf8');
  assert.ok(
    src.includes("const bossStand = !!(wCfg && wCfg.mode === 'stand');"),
    'pilot 读 warnMode 档位',
  );
  assert.ok(src.includes('isBossish(curPt) && bossStand'), 'safeHere 档位驱动（两处同口径）');
  assert.ok(!src.includes('#bossEngagedHere'), '旧交战保护已移除（改档位驱动）');
  const idx = readFileSync(path.join(featDir, 'index.js'), 'utf8');
  assert.ok(idx.includes("mode: e.mode === 'stand' ? 'stand' : 'transfer'"), '缺省立即转移');
  const wsrc = readFileSync(path.join(featDir, 'warn.js'), 'utf8');
  assert.ok(wsrc.includes('#warnNoFoeHere(base)'), 'warn 引擎同口径验真');
  assert.ok(!wsrc.includes("'bosspt'"), 'warn 引擎 BOSS 点无条件豁免已移除');
});
