#!/usr/bin/env node
/**
 * 异能秘境自动驾驶 · pilot-select 真实录制重放器（先证后接的规模化验证）。
 *
 * 把整份 901 录制（默认 20261101T200401-异能秘境-我是队长.ndjson）逐帧喂给
 * extension/src/feats/activity/secret-realm/pilot-select.js 的纯函数，做两件事：
 *   1) 不变量体检：选点结果必须满足窄闸（类型/回合/state/占用/iNum/距离），
 *      且绝不把 161 商店（如 95,163）当井/兽选中；违例即红。
 *   2) 归属闸机制实证：从录制里取一个真实 172.callTId 当 myTeamIdNum，
 *      证明「带该 callTId 的兽从被排除翻转为可选、其余带别的 callTId 仍排除」——
 *      即在真实 19 位大整数上证成 Number()===Number() 的 double 等值口径（§5.3/G6）。
 *
 * 与 CI 单测（tests/feats/secret-realm-pilot.test.js）的分工：单测跑仓内夹具、确定性、随时可跑；
 * 本器跑**仓外 146MB 录制**、规模化（上千帧）、非 CI（依赖本地录制路径），错归因时反推报文。
 *
 * 用法：node scripts/secret-realm-replay.mjs [录制.ndjson]
 *   录制不入仓，默认取 ~/Desktop/口袋奇兵/20261101T200401-异能秘境-我是队长.ndjson。
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const REC =
  process.argv[2] ||
  path.join(os.homedir(), 'Desktop/口袋奇兵/20261101T200401-异能秘境-我是队长.ndjson');

// pilot-select import 链会触到浏览器全局（constants.js re-export core/util 的 CODE_NOT_SENT），
// 与单测同法：先最小桩化，再动态 import——不 stub 任何游戏符号。
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
  runtime: { id: 'replay', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};

const { pickResource, pickBeast, beastOwnedByMeOrFree } = await import(
  pathToFileURL(path.join(here, '../extension/src/feats/activity/secret-realm/pilot-select.js'))
    .href
);

const PAB_RESOURCE = 173;
const PAB_MONSTER = 172;
const PAB_SHOP = 161;
const MIN_NUM = 5; // driveResMinNum 现网口径

/** 901 应答体：data 直接含 pointList，或双信封 data.data */
function payloadOf(r) {
  const d = r && r.data;
  if (d && typeof d === 'object' && Array.isArray(d.pointList)) return d;
  if (d && typeof d === 'object' && d.data && Array.isArray(d.data.pointList)) return d.data;
  return null;
}

/** api.js 同法把 marchList 归一成 {tx,ty,state}（hasMarchTargeting 只用这三项） */
function mapMarches(marchList) {
  if (!Array.isArray(marchList)) return [];
  const out = [];
  for (const m of marchList) {
    if (!m || typeof m !== 'object') continue;
    const t = (m.target && typeof m.target === 'object' && m.target) || {};
    out.push({ tx: t.tx, ty: t.ty, state: Number(m.state) || 0 });
  }
  return out;
}

const biz = (p) => (p && typeof p.m === 'object' && p.m) || {};

const stats = {
  frames: 0,
  resHit: 0,
  beastHitFree: 0,
  beastHitMine: 0,
  n172: 0,
  n172Call: 0,
  callTidDistinct: new Set(),
  gateChecked: 0,
  gateMineIncluded: 0,
  gateOtherExcluded: 0,
};
const violations = [];

let pendingReq = null; // 901 请求 {x,y}，与下一条 901 应答配对作 startPoint

// 第一趟：扫出最高频 callTId 当「己方队 ID」（归属闸翻转正证用；本局未必真召唤，取同量级真实值即可）
const ctFreq = new Map();
{
  const rl0 = createInterface({ input: createReadStream(REC), crlfDelay: Infinity });
  for await (const line of rl0) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.cmd !== 901 || (r.dir || '').startsWith('req')) continue;
    const p = payloadOf(r);
    if (!p) continue;
    for (const pt of p.pointList || []) {
      if (Number(pt.pointType) !== PAB_MONSTER) continue;
      const ct = biz(pt).callTId;
      if (ct == null || ct === 0) continue;
      const k = Number(ct);
      ctFreq.set(k, (ctFreq.get(k) || 0) + 1);
    }
  }
}
let mine;
{
  let best = -1;
  for (const [k, c] of ctFreq) if (c > best) ((best = c), (mine = k));
}

const rl = createInterface({ input: createReadStream(REC), crlfDelay: Infinity });
for await (const line of rl) {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.cmd !== 901) continue;
  const dir = r.dir || '';
  if (dir.startsWith('req') && r.data && r.data.x != null) {
    pendingReq = { x: Number(r.data.x), y: Number(r.data.y) };
    continue;
  }
  const p = payloadOf(r);
  if (!p) continue;
  const points = p.pointList || [];
  const startPoint = pendingReq || { x: 0, y: 0 };
  pendingReq = null;
  const marches = mapMarches(p.marchList);
  stats.frames++;

  // 172 归属数据体检
  for (const pt of points) {
    if (Number(pt.pointType) === PAB_MONSTER) {
      stats.n172++;
      const ct = biz(pt).callTId;
      if (ct != null && ct !== 0) {
        stats.n172Call++;
        stats.callTidDistinct.add(Number(ct));
      }
    }
  }

  const baseCtx = {
    startPoint,
    serverTimeSec: 0, // marchedList 为空 → inMarchedList 恒 false，时钟不参与
    minNum: MIN_NUM,
    maxDist: Infinity, // 无世界边界，不裁距；rank 仍按 iNum-cost
    isRoundOpen: () => true, // 回合表离线不可得，全开以聚焦「窄闸+归属+占用」验证
    marches,
    marchedList: [],
    marchPolicy: 0,
    firstUnrewardedBoss: null,
    nearestNoSausageShop: null,
  };

  // 选井不变量
  const well = pickResource(points, baseCtx);
  if (well) {
    stats.resHit++;
    const m = well.m || {};
    if (
      Number(well.pointType) !== PAB_RESOURCE ||
      Number(m.state) !== 0 ||
      (Array.isArray(m.teams) && m.teams.length > 0) ||
      !(Number(m.iNum || 0) >= MIN_NUM)
    ) {
      violations.push({ kind: 'resource', at: `${well.x},${well.y}`, m });
    }
    if (Number(well.pointType) === PAB_SHOP) violations.push({ kind: 'shop-as-resource' });
  }

  // 抓兽不变量（自由模式 myTeamIdNum=null：只应选中无主兽）
  const beastFree = pickBeast(points, { ...baseCtx, myTeamIdNum: null, minQuality: 1 });
  if (beastFree) {
    stats.beastHitFree++;
    const m = beastFree.m || {};
    if (Number(beastFree.pointType) !== PAB_MONSTER || Number(m.state) !== 0) {
      violations.push({ kind: 'beast-state', at: `${beastFree.x},${beastFree.y}`, m });
    }
    if (m.callTId != null && m.callTId !== 0) {
      violations.push({ kind: 'beast-owned-leak', at: `${beastFree.x},${beastFree.y}`, m });
    }
  }

  // 归属闸正证（全帧）：对每头 state0+teams空+带callTId 的兽，核对 eq ⟺ double 等值
  for (const pt of points) {
    if (Number(pt.pointType) !== PAB_MONSTER) continue;
    const m = biz(pt);
    if (Number(m.state) !== 0 || (Array.isArray(m.teams) && m.teams.length > 0)) continue;
    if (m.callTId == null || m.callTId === 0) continue;
    stats.gateChecked++;
    const eq = beastOwnedByMeOrFree(m.callTId, mine);
    const shouldEq = Number(m.callTId) === Number(mine);
    if (eq && shouldEq) stats.gateMineIncluded++;
    if (!eq && !shouldEq) stats.gateOtherExcluded++;
    if (eq !== shouldEq)
      violations.push({ kind: 'gate-mismatch', callTId: m.callTId, mine, eq, shouldEq });
  }

  // 抓兽（己方视角 myTeamIdNum=mine）：应能选中带该 callTId 的兽
  const beastMine = pickBeast(points, { ...baseCtx, myTeamIdNum: mine, minQuality: 1 });
  if (beastMine) stats.beastHitMine++;
}

console.log('════ pilot-select 录制重放 · ' + path.basename(REC) + ' ════');
console.log(`处理 901 帧: ${stats.frames}`);
console.log(
  `选井命中帧率: ${stats.resHit}/${stats.frames} (${((stats.resHit / stats.frames) * 100).toFixed(1)}%)`,
);
console.log(`抓兽命中(自由/仅无主): ${stats.beastHitFree}`);
console.log(
  `172 总数: ${stats.n172}  带callTId: ${stats.n172Call} (${((stats.n172Call / stats.n172) * 100).toFixed(1)}%)  去重callTId: ${stats.callTidDistinct.size}`,
);
console.log(
  `归属闸实证(mine=${mine}, 最高频): 已方纳入 ${stats.gateMineIncluded} / 他家排除 ${stats.gateOtherExcluded} / 归属兽核对 ${stats.gateChecked}`,
);
console.log(`抓兽命中(己方视角,可含召唤兽): ${stats.beastHitMine}`);
console.log(`不变量违例: ${violations.length}`);
if (violations.length) {
  console.log(JSON.stringify(violations.slice(0, 10), null, 2));
  process.exit(1);
}
console.log('✅ 全部帧通过窄闸不变量 + 归属闸 double 等值实证');
