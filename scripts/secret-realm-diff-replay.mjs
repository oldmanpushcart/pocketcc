#!/usr/bin/env node
/**
 * 异能秘境自动驾驶 · B1v 差分回放仿真器（真实录制 → 两引擎同拍对比）。
 *
 * 目的：证明「#tick 目标梯换成 plans.js + #runStages 解释器」是**行为等价重构**，而不是只靠
 *   注释与合成单测。做法：把真实录制（20261101T200401 队长场）抽成场景时间线，在同一虚拟时钟
 *   下分别喂给 git HEAD（旧实现）与工作区（解释器实现）两份 pilot.js，逐拍对比诊断面指纹
 *   （lastBranch/lastDispatch/stage/stageWhy）与本拍写动作（8521 目标序列）。任何分叉＝红。
 *
 * 已知刻意偏离（两引擎同等承受，不影响差分结论）：
 *   - 时钟：虚拟推进（每步走到录制那条报文的 ts），非墙上钟；
 *   - 应答：8521 一律回成功（真实到达由后续 21521 的 marchState/startPoint 复核驱动）；
 *   - 表格：enigma_secret_realm_building 的商店锚点从录制 901 视口里出现过的 161 点合成；
 *     REALM/TIMER/ITEM 表回 null（收场/缺口判据走保守支）；
 *   - 在途闸 isSecretSending 恒 false；901 回最近一帧视口（中心无关，两边同数据）。
 *
 * 用法：node scripts/secret-realm-diff-replay.mjs [录制.ndjson] [--frames=2500] [--verbose]
 *   退出码：0=完全等价；1=存在分叉；2=场景抽取失败。
 */
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REC =
  process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : path.join(os.homedir(), 'Desktop/口袋奇兵/20261101T200401-异能秘境-我是队长.ndjson');
const args = process.argv.slice(process.argv[2] === REC ? 3 : 2);
const FRAMES = Number((args.find((a) => a.startsWith('--frames=')) || '--frames=2500').slice(9));
const VERBOSE = args.includes('--verbose');

// ── 虚拟时钟：必须在 import 引擎之前装好（引擎只认 Date.now）────────────
let VCLOCK = 0;
const realNow = Date.now.bind(Date);
void realNow; // 保留墙上钟引用（调试用），回放期一律走虚拟钟
Date.now = function () {
  return VCLOCK;
};

// ── 最小浏览器全局（constants→core/util 链与 feat 模块级代码需要）──────
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
  runtime: {
    id: 'diff-replay',
    sendMessage() {},
    getURL: (s) => s,
    onMessage: { addListener() {} },
  },
};

const SR = path.join(ROOT, 'extension/src/feats/activity/secret-realm');
const TMP = path.join(ROOT, '.replaytmp');
const {
  PUSH_BASE_INFO,
  PUSH_TILE_INFO,
  PUSH_TEAM_ARRIVE,
  PUSH_BOSS_STATE,
  PUSH_SELF_ATTACKED,
  PUSH_RESOURCE_CHANGE,
  PUSH_DROP_CHANGE,
  TABLE_BUILDING,
} = await import(pathToFileURL(path.join(SR, 'constants.js')).href);
const PUSH_SET = new Set([
  PUSH_BASE_INFO,
  PUSH_TILE_INFO,
  PUSH_TEAM_ARRIVE,
  PUSH_BOSS_STATE,
  PUSH_SELF_ATTACKED,
  PUSH_RESOURCE_CHANGE,
  PUSH_DROP_CHANGE,
]);

// ── 1. 抽场景：21521→base 快照 / 21535→boss / 901 resp→视口 / 其它 push→事件 ──
function payloadOf(r) {
  const d = r && r.data;
  if (d && typeof d === 'object' && Array.isArray(d.pointList)) return d;
  if (d && typeof d === 'object' && d.data && Array.isArray(d.data.pointList)) return d.data;
  return null;
}
/** 逐字复刻 api.js#queryWorldView 的归一（marches 字段名映射） */
function normalizeView(p) {
  const pts = Array.isArray(p.pointList) ? p.pointList : [];
  const ms = Array.isArray(p.marchList) ? p.marchList : [];
  return {
    points: pts,
    marches: ms.map(function (m) {
      const bb = m.begin || {};
      const tt = m.target || {};
      const inf = m.info || {};
      return {
        bx: Number(bb.bx != null ? bb.bx : bb.tx) || 0,
        by: Number(bb.by != null ? bb.by : bb.ty) || 0,
        tx: Number(tt.tx != null ? tt.tx : m.target_tx) || 0,
        ty: Number(tt.ty != null ? tt.ty : m.target_ty) || 0,
        state: Number(m.state != null ? m.state : m.marchState) || 0,
        leaderUid: inf.leaderUid != null ? String(inf.leaderUid) : '',
      };
    }),
  };
}

const steps = []; // {ts, base?, boss?, view?, events:[{cmd,data}]}
let cur = null;
function ensureStep(ts) {
  if (!cur || cur.ts !== ts) {
    cur = { ts, events: [] };
    steps.push(cur);
  }
  return cur;
}
await new Promise((resolve, reject) => {
  const rl = createInterface({ input: createReadStream(REC), crlfDelay: Infinity });
  rl.on('line', (l) => {
    if (steps.length > FRAMES) return;
    let o;
    try {
      o = JSON.parse(l);
    } catch (e) {
      return;
    }
    const cmd = Number(o.cmd);
    const ts = Number(o.ts) || 0;
    if (cmd === PUSH_BASE_INFO) {
      const d = o.data && o.data.data;
      const info = d && d.info ? d.info : d;
      if (info && info.startPoint) ensureStep(ts).base = info;
    } else if (cmd === PUSH_BOSS_STATE) {
      const d = o.data && o.data.data;
      const list = d && d.stateInfo ? d.stateInfo : Array.isArray(d) ? d : null;
      if (Array.isArray(list)) ensureStep(ts).boss = list;
    } else if (cmd === 901 && o.dir !== 'req:send') {
      const p = payloadOf(o);
      if (p) ensureStep(ts).view = normalizeView(p);
    } else if (PUSH_SET.has(cmd) && o.data) {
      ensureStep(ts).events.push({ cmd, data: o.data });
    }
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});
if (steps.length < 50) {
  console.error('场景抽取失败：有效步数 ' + steps.length + '（检查录制路径/格式）');
  process.exit(2);
}
// 商店锚点：从所有视口里出现过的 161 点合成（两引擎同一份表）
const shopSet = new Map();
for (const s of steps) {
  if (!s.view) continue;
  for (const p of s.view.points) {
    if (Number(p.pointType) === 161) shopSet.set(p.x + ',' + p.y, { x: p.x, y: p.y });
  }
}
const buildingRows = [...shopSet.values()].map(function (v, i) {
  return { id: i + 1, build_type: 3, group: 1, coords: v.x + ',' + v.y };
});
console.log(
  '场景：%d 步（base=%d boss=%d view=%d），商店锚点 %d 个（从视口 161 合成）',
  steps.length,
  steps.filter((s) => s.base).length,
  steps.filter((s) => s.boss).length,
  steps.filter((s) => s.view).length,
  buildingRows.length,
);

// ── 2. 两份实现：git HEAD（旧）与工作区（解释器），import 均改指到 .replaytmp 桩 ──
const OLD = path.join(TMP, 'pilot.old.js');
const NEW = path.join(TMP, 'pilot.new.js');
/** 桩 createCycle 把每个新建的 cycle 登记到这里（harness 唯一能驱动私有引擎的通道） */
const CYCLES = [];
globalThis.__REPLAY_CYCLES = CYCLES;
function rewriteImports(src) {
  return src
    .replace(/'\.\.\/\.\.\/\.\.\/core\/cycle\.js'/g, JSON.stringify(path.join(TMP, 'cycle.js')))
    .replace(
      /'\.\.\/\.\.\/\.\.\/core\/game-api\.js'/g,
      JSON.stringify(path.join(TMP, 'game-api.js')),
    )
    .replace(
      /'\.\/(util|constants|pilot-select|plans|boss|shop|pickup|scout|capture|heal|leave|warn)\.js'/g,
      (_m, n) => JSON.stringify(path.join(SR, n + '.js')),
    );
}
{
  let src;
  try {
    src = execFileSync('git', ['show', 'HEAD:extension/src/feats/activity/secret-realm/pilot.js'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error('git show HEAD pilot.js 失败：' + e.message);
    process.exit(2);
  }
  src = rewriteImports(src);
  // 崩溃等价补丁（与工作区同修，非决策逻辑）：HEAD 的 #consume 里 forEach(function) 回调丢 this，
  //   账本有过期条目即 TypeError。不修则 A 引擎跑不下去，与差分结论无关。
  src = src
    .replace(
      'this.#consumed.forEach(function (until, k) {',
      'this.#consumed.forEach((until, k) => {',
    )
    .replace(
      'this.#marched.forEach(function (until, k) {',
      'this.#marched.forEach((until, k) => {',
    );
  fs.writeFileSync(OLD, src);
  fs.writeFileSync(NEW, rewriteImports(fs.readFileSync(path.join(SR, 'pilot.js'), 'utf8')));
}

// ── 3. 引擎驱动 ────────────────────────────────────────────────────────
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const ENUM_NM = { ARRIVED: 2, FIGHTING: 12, PAB_FEED: 21 };

async function runEngine(mod, _label) {
  const PilotEngine = mod.PilotEngine;
  const actions = []; // 本拍写动作（8521 目标 / 其它 cmd）
  const state = { base: null, boss: null, reward: null, view: null };
  let narrowHits = 0; // B 引擎窄筛（src:'view901'）实际生效拍数；A 恒 0
  const listeners = [];
  const env = {
    alive: () => true,
    realmActive: () => true,
    cfg: () => ({
      drive: {
        enabled: true,
        boss: true,
        revive: false, // 关 8552 自救：避免 fake uid 分支引发明细差异（与决策链无关）
        shop: true,
        beast: true,
      },
    }),
    secret: {
      getPabController: () => ({
        roomBaseInfo: state.base,
        bossBaseInfo: state.boss,
        bossGurardRewardInfo: state.reward,
        teamIsMooring: () => {
          const b = state.base;
          if (!b) return true;
          const s = Number(b.marchState);
          return s === 2 || s === 12 || s === 21;
        },
      }),
      getRoomBaseInfo: () => state.base,
      getBossBaseInfo: () => state.boss,
      getBossGuardRewardInfo: () => state.reward,
      getNMarchState: () => ENUM_NM,
      teamIsMooring: () => {
        const b = state.base;
        if (!b) return true;
        const s = Number(b.marchState);
        return s === 2 || s === 12 || s === 21;
      },
      isTeamLeader: () => true,
      isSecretSending: () => false,
      getItemNumById: () => 0,
      sendMarch: (x, y) => {
        actions.push({ t: VCLOCK, kind: 'march', x: Number(x), y: Number(y) });
        return Promise.resolve({ ok: true, code: 0 });
      },
      sendSecret: (cmd, data) => {
        actions.push({
          t: VCLOCK,
          kind: 'cmd',
          cmd: Number(cmd),
          x: data && data.x,
          y: data && data.y,
        });
        return Promise.resolve({ ok: true, code: 0 });
      },
      queryWorldView: () => Promise.resolve(state.view),
    },
    gameData: { myUidStr: () => '14179309129759' },
    gameConf: { dataConfig: () => 0 },
    l10n: {
      tableRow: () => null,
      tableRows: function (t) {
        return t === TABLE_BUILDING ? buildingRows : [];
      },
    },
    ui: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    kickShop() {},
    markShopLedger() {},
  };
  const eng = new PilotEngine(env);
  const cycBefore = CYCLES.length;
  eng.start({
    on: {
      push: function (cmd, fn) {
        listeners.push([cmd, fn]);
      },
    },
  });
  const c = CYCLES[cycBefore];
  if (!c) throw new Error('cycle 桩未被引擎创建');
  const fp = [];
  for (const s of steps) {
    VCLOCK = s.ts;
    if (s.base) state.base = s.base;
    if (s.boss) state.boss = s.boss;
    if (s.view) state.view = s.view;
    for (const ev of s.events) {
      for (const [cmd, fn] of listeners) {
        if (cmd === ev.cmd) {
          try {
            fn(ev);
          } catch (e) {
            if (VERBOSE) console.error('listener threw', cmd, e.message);
          }
        }
      }
    }
    // 每步显式跑一拍 run（两引擎同拍数，确定性对比；pending 只影响 run 内部补扫判据）
    await c.__opts.run();
    c.pending = false;
    await flush();
    const d = eng.debugState();
    if (d.pick && d.pick.src === 'view901') narrowHits++;
    fp.push([d.lastBranch || '', d.lastDispatch || '', d.stage || '', d.stageWhy || '']);
  }
  eng.stop();
  return { fp, actions, narrowHits };
}

// ── 4. 两边各跑一遍，逐拍对比 ─────────────────────────────────────────
const [oldMod, newMod] = await Promise.all([
  import(pathToFileURL(OLD).href),
  import(pathToFileURL(NEW).href),
]);

function summarize(tag, r) {
  const dist = {};
  for (const f of r.fp) dist[f[0] || '(empty)'] = (dist[f[0] || '(empty)'] || 0) + 1;
  const marches = r.actions.filter((a) => a.kind === 'march').length;
  console.log(
    tag +
      ' 指纹 ' +
      r.fp.length +
      ' 拍｜8521=' +
      marches +
      ' 笔｜窄筛生效=' +
      (r.narrowHits || 0) +
      ' 拍｜档位分布：' +
      Object.entries(dist)
        .sort((a, b) => b[1] - a[1])
        .map((e) => e[0] + ':' + e[1])
        .join(' '),
  );
}

VCLOCK = 0;
CYCLES.length = 0;
const A = await runEngine(oldMod, 'A(HEAD旧实现)');
VCLOCK = 0;
CYCLES.length = 0;
const B = await runEngine(newMod, 'B(方案解释器)');
summarize('A(HEAD旧实现)', A);
summarize('B(方案解释器)', B);

let diverge = 0;
const n = Math.min(A.fp.length, B.fp.length);
for (let i = 0; i < n; i++) {
  const a = A.fp[i].join('|');
  const b = B.fp[i].join('|');
  if (a !== b) {
    diverge++;
    if (diverge <= (VERBOSE ? Infinity : 20)) {
      console.log('✗ 步%d ts=%d\n    A: %s\n    B: %s', i, steps[i].ts, a, b);
    }
  }
}
if (A.actions.length !== B.actions.length) {
  console.log('✗ 写动作笔数不同：A=%d B=%d', A.actions.length, B.actions.length);
  diverge++;
} else {
  for (let i = 0; i < A.actions.length; i++) {
    const x = A.actions[i];
    const y = B.actions[i];
    if (x.kind !== y.kind || x.x !== y.x || x.y !== y.y || x.cmd !== y.cmd) {
      diverge++;
      if (diverge <= (VERBOSE ? Infinity : 20))
        console.log('✗ 动作%d A=%s B=%s', i, JSON.stringify(x), JSON.stringify(y));
    }
  }
}
console.log(
  diverge === 0
    ? '✅ 完全等价：' + n + ' 拍逐拍一致，' + A.actions.length + ' 笔写动作逐笔一致'
    : '❌ 分叉 ' + diverge + ' 处',
);
process.exit(diverge === 0 ? 0 : 1);
