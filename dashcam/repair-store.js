#!/usr/bin/env node
/**
 * dashcam store 修复脚本：把历史遗留的「拆散会话」合回单文件，并把孤儿 .part 定稿。
 *
 * 两类损坏（都是同一台 dashcam 服务在撞名/崩溃兜底路径下留下的）：
 *   1. 同一会话被反复定稿、每次撞名追加 -NN，拆成 base + base-01 + base-02 … 多个分片，
 *      但 index 只有最新那片（其余分片无 index 行，行数也对不上）。→ `merge`
 *   2. 会话未定稿（崩溃 / 服务停止），留下 <startLocal>-<sessionId>.part.ndjson 孤儿，
 *      既不在 index 也没转正名。→ `finalize`
 *
 * 判据纪律（动手前必查）：seq 跨分片从 1 连续铺满、无重复无空洞，且 ts 严格非降 → 同一会话、可合并；
 *   任一分片 seq 各自从 1 起（或 ts 交叠） → 不同会话、绝不并入。merge 在 --apply 前会逐组校验此不变式。
 *
 * 安全约定（与 migrate-store.js 一致）：
 *   - 默认 dry-run 只打印计划；加 --apply 才动文件。
 *   - 执行前务必确认 dashcam server 已停止（本脚本 apply 时会自动探测端口，占用则拒绝执行）。
 *   - 纯 node:fs / node:path / node:net，无三方依赖；ESM。
 *   - 分片合并 / .part 转正均先写出目标并回读校验行数，通过后才删源（tmp + rename 原子写 index）。
 *
 * 命名与派生算法逐字复刻 server.js（sanitize/deriveSlug/resolveName/NOISE_NAMES/NAME_PREFIX_RE），
 *   若 server.js 改了落盘格式，须同步本文件（与 lib/rec.js「只认格式」同理）。
 *
 * 用法：
 *   node repair-store.js merge     [--uid=<uid>] [--apply]
 *   node repair-store.js finalize  <uid> [<startLocal|sessionId>] [--note=<note>] [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 参数 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const getFlag = (name) => {
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
};
const positionals = argv.filter((a) => !a.startsWith('--'));
const CMD = positionals[0];
const OUT = process.env.DASHCAM_OUT || path.join(__dirname, 'store');
const PORT = Number(process.env.DASHCAM_PORT) || 7391;

// ── 常量与命名工具（复刻 server.js） ─────────────────────────────────
const REC_SUB = 'rec';
const LOG_SUB = 'log';
const REC_PREFIX = 'dashcam-rec-';
const INDEX_NAME = 'dashcam-rec-index.ndjson';
const NOISE_NAMES = new Set([
  'HEART',
  'NO_QUEUE_HEART',
  'PING',
  'GET_WORLD_INFO',
  'GET_MIX_TERRITORY_INFO',
  'GET_TERRITORY_INFO',
  'GET_MARCH_TIME',
  'GET_BEHEMOTH_WORLD_INFO',
  'GET_PLAYER_POINT',
]);
const NAME_PREFIX_RE = /^(GET|REQ|CMD|C2S|SEND)_/;

/** 净化字符串作文件名/目录名（逐字复刻 server.js sanitize）：[\\w.-] 保留、..→_、多下划线折叠、截断。 */
function sanitize(raw, max) {
  const s = String(raw == null ? '' : raw)
    .replace(/\.\./g, '_')
    .replace(/[^\w.-]+/g, (m) => (m.includes(' ') || m === '_' ? '_' : ''))
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return (s || '').slice(0, max || 120);
}
/** 命令名 → slug 片段（同 server.js slugPiece）：剥前缀、小写、截 24、下划线转连字符。 */
function slugPiece(name) {
  const stripped = String(name).replace(NAME_PREFIX_RE, '');
  return sanitize(stripped.toLowerCase(), 24).replace(/_/g, '-');
}
/** 报文内容派生主题 slug（同 server.js deriveSlug）：非噪声按计数降序取 2 段，'+' 连接。 */
function deriveSlug(nameCounts) {
  const ranked = [...nameCounts.entries()]
    .filter(([name]) => name && !NOISE_NAMES.has(name))
    .sort((a, b) => b[1] - a[1]);
  const pieces = [];
  for (const [name] of ranked) {
    const piece = slugPiece(name);
    if (piece && !pieces.includes(piece)) pieces.push(piece);
    if (pieces.length >= 2) break;
  }
  return pieces.join('+').slice(0, 48);
}
/** 定稿名冲突则追加 -NN（同 server.js resolveName），返回 {name, file}。 */
function resolveName(dir, startLocal, note, slug) {
  const base = REC_PREFIX + [startLocal, note, slug].filter(Boolean).join('-');
  let name = base + '.ndjson';
  if (!fs.existsSync(path.join(dir, name))) return { name, file: path.join(dir, name) };
  for (let i = 1; i < 1000; i++) {
    name = `${base}-${String(i).padStart(2, '0')}.ndjson`;
    if (!fs.existsSync(path.join(dir, name))) return { name, file: path.join(dir, name) };
  }
  name = `${base}-${Date.now()}.ndjson`;
  return { name, file: path.join(dir, name) };
}

// ── 通用小工具 ───────────────────────────────────────────────────────
const say = (...a) => console.log(...a);
const problems = [];
const stats = { groupsMerged: 0, piecesConsumed: 0, partsFinalized: 0, indexRewritten: 0 };

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
/** 读一个 ndjson 文件：非空行原文 + 解析对象（合并按原文拼接，保字节保真）。 */
function loadFile(p) {
  const lines = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((x) => x.trim() !== '');
  return { lines, objs: lines.map((l) => JSON.parse(l)) };
}
/** 回读实际写出的 ndjson 非空行数（同 migrate-store 口径）。 */
function countNdjsonLines(p) {
  const buf = fs.readFileSync(p);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0x0a && (i === 0 || buf[i - 1] === 0x0a)) n++;
  return n;
}
/** name -> 计数（键 = name 或 dir:cmd，同 server.js 统计口径）。 */
function tallyNames(objs) {
  const m = new Map();
  for (const e of objs) {
    const k = e.name || `${e.dir}:${e.cmd}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
const topOf = (nameCounts) => [...nameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

/** index 按 start 升序、tmp+rename 原子重写。 */
function writeIndexAtomic(uidDir, entries) {
  const text = entries.map((r) => JSON.stringify(r)).join('\n') + (entries.length ? '\n' : '');
  const out = path.join(uidDir, INDEX_NAME);
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, out);
  stats.indexRewritten++;
}
function readIndex(uidDir) {
  const p = path.join(uidDir, INDEX_NAME);
  const rows = [];
  if (!fs.existsSync(p)) return rows;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.file) rows.push(e);
    } catch {
      /* 坏行丢弃 */
    }
  }
  return rows;
}

/** 探测 dashcam server 是否在监听（占用→拒绝 apply）。 */
function serverRunning(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

// ── merge：同会话被拆成 base + base-NN 分片 → 合回单文件 ──────────────
/** 在某 uid 目录里找拆分组：base 存在且 base-NN 也存在（resolveName 撞名指纹）。 */
function detectGroups(uidDir) {
  if (!isDir(uidDir)) return new Map(); // 目录不存在 → 空组（不抛错）
  const files = fs
    .readdirSync(uidDir)
    .filter(
      (f) =>
        f.startsWith(REC_PREFIX) &&
        f.endsWith('.ndjson') &&
        f !== INDEX_NAME &&
        !f.endsWith('.part.ndjson'),
    );
  const set = new Set(files);
  const groups = new Map(); // base -> [base, base-01, base-02 …]（chrono 序）
  for (const f of files) {
    const m = /^(.+)-(\d{1,3})\.ndjson$/.exec(f);
    if (!m) continue;
    const base = m[1] + '.ndjson';
    if (!set.has(base)) continue; // 仅当 base 也在 → 判定为撞名分片
    if (!groups.has(base)) groups.set(base, [base]);
    groups.get(base).push(f);
  }
  for (const arr of groups.values()) {
    // base 恒为首（最早定稿），其余按 -NN 数字升序
    arr.sort((a, b) => {
      const na = /-(\d+)\.ndjson$/.exec(a);
      const nb = /-(\d+)\.ndjson$/.exec(b);
      return (na ? +na[1] : -1) - (nb ? +nb[1] : -1);
    });
  }
  return groups;
}

async function merge() {
  const recRoot = path.join(OUT, REC_SUB);
  if (!isDir(recRoot)) {
    say(`[merge] 无 ${REC_SUB} 目录：${recRoot}`);
    return;
  }
  const uidArg = getFlag('uid');
  const uids = uidArg
    ? [uidArg]
    : fs.readdirSync(recRoot).filter((n) => isDir(path.join(recRoot, n)));
  let anyGroup = false;
  for (const uid of uids) {
    const uidDir = path.join(recRoot, uid);
    if (!isDir(uidDir)) {
      say(`[merge] uid=${uid} 目录不存在：${uidDir}`);
      continue;
    }
    const groups = detectGroups(uidDir);
    if (!groups.size) continue;
    for (const [base, pieces] of groups) {
      anyGroup = true;
      // 逐片读取 + 合并校验：seq 连续铺满 1..N 无重复、ts 跨片非降
      const perPiece = pieces.map((p) => loadFile(path.join(uidDir, p)));
      const allObjs = perPiece.flatMap((x) => x.objs);
      const seqs = allObjs.map((e) => e.seq).sort((a, b) => a - b);
      const dups = [];
      for (let i = 1; i < seqs.length; i++) if (seqs[i] === seqs[i - 1]) dups.push(seqs[i]);
      const gaps = [];
      for (let i = 1; i < seqs.length; i++)
        if (seqs[i] > seqs[i - 1] + 1) gaps.push([seqs[i - 1], seqs[i]]);
      const contiguous =
        seqs[0] === 1 && seqs[seqs.length - 1] === seqs.length && !dups.length && !gaps.length;
      const pieceSeq = pieces.map((_, i) => {
        const s = perPiece[i].objs.map((e) => e.seq);
        return `${i === 0 ? 'base' : pieces[i].match(/-(\d+)\.ndjson$/)[1]}[${Math.min(...s)}..${Math.max(...s)}]`;
      });
      // ts 跨片边界非降（合并后时间线单调）
      let tsOk = true;
      let prevMaxTs = -Infinity;
      for (const pp of perPiece) {
        const ts = pp.objs.map((e) => e.ts);
        if (Math.min(...ts) < prevMaxTs) tsOk = false;
        prevMaxTs = Math.max(...ts);
      }
      const tag = `uid=${uid} ${base}`;
      if (!contiguous || !tsOk) {
        problems.push(
          `${tag} 非同一会话（seq连续=${contiguous} ts单调=${tsOk}；dup=${dups.length} gap=${gaps.length}），拒绝合并：${pieceSeq.join(' ')}`,
        );
        say(`\n[merge] ${tag}: ${pieces.length} 分片 —— 校验不通过，跳过`);
        continue;
      }
      say(
        `\n[merge] ${tag}: 合并 ${pieces.length} 分片 → ${base}（${allObjs.length} 行，seq/ts 校验通过）`,
      );
      for (let i = 0; i < pieces.length; i++)
        say(
          `    ${i === 0 ? 'base ' : '  -NN '} ${pieces[i]} ${perPiece[i].objs.length} 行 seq[${pieceSeq[i].split('[')[1]}`,
        );
      const top = topOf(tallyNames(allObjs));
      say('    top: ' + top.map(([k, v]) => `${k}:${v}`).join(', '));

      if (!APPLY) {
        stats.groupsMerged++;
        stats.piecesConsumed += pieces.length - 1;
        continue;
      }
      // 写出 tmp（原文拼接保真）→ 回读校验 → 转正 → 删源分片
      const tmpPath = path.join(uidDir, base + '.merging.tmp');
      fs.writeFileSync(tmpPath, perPiece.flatMap((x) => x.lines).join('\n') + '\n');
      const got = countNdjsonLines(tmpPath);
      if (got !== allObjs.length) {
        fs.rmSync(tmpPath);
        problems.push(`${tag} 合并回读行数 ${got} != 源 ${allObjs.length}，已放弃（未删源）`);
        continue;
      }
      // base 恒为组内首片：把 tmp 转正覆盖 base，再删其余 -NN 分片
      fs.renameSync(tmpPath, path.join(uidDir, base));
      for (const p of pieces.slice(1)) {
        try {
          fs.rmSync(path.join(uidDir, p));
          stats.piecesConsumed++;
        } catch (e) {
          problems.push(`删分片失败 ${p}: ${e.message}`);
        }
      }
      stats.groupsMerged++;
      // 改写 index：指向 base 的那条 entry 收拢整组，其余指向本组分片的行删除
      const rows = readIndex(uidDir);
      const pieceSet = new Set(pieces);
      let main = null;
      const kept = [];
      for (const e of rows) {
        const b = path.basename(String(e.file));
        if (pieceSet.has(b)) {
          if (!main) {
            main = e;
            e.file = `${REC_SUB}/${uid}/${base}`;
            e.lines = allObjs.length;
            e.top = top;
            kept.push(e);
          }
          // 其余分片即使有行也不重复收录
        } else kept.push(e);
      }
      if (!main) {
        problems.push(`${tag} index 无本组条目（分片全为孤儿），未补写——请人工确认会话归属`);
      }
      writeIndexAtomic(
        uidDir,
        kept.sort((a, b) => (a.start || 0) - (b.start || 0)),
      );
      say(`    已合并 + 更新 index${main ? '' : '（⚠ 无 index 条目）'}`);
    }
  }
  if (!anyGroup && !problems.length) say('[merge] 未发现拆分组（无 base + base-NN 撞名指纹）。');
}

// ── finalize：孤儿 .part → 转正名 + 补 index ────────────────────────
/** 从 .part 文件名解析 startLocal + sessionId（命名 = <REC_PREFIX><startLocal>-<sessionId>.part.ndjson）。 */
function parsePart(name) {
  const m = new RegExp(`^${REC_PREFIX}(\\d{8}T\\d{6})-(.+)\\.part\\.ndjson$`).exec(name);
  return m ? { startLocal: m[1], sessionId: m[2] } : null;
}

async function finalize() {
  const uid = positionals[1];
  if (!uid) {
    console.error(
      '用法: node repair-store.js finalize <uid> [<startLocal|sessionId>] [--note=<note>] [--apply]',
    );
    process.exit(2);
  }
  const token = positionals[2]; // 可选：startLocal 或 sessionId 限定
  const note = getFlag('note') ?? ''; // x-note 无法从 .part 恢复，缺省留空（不臆造）
  const uidDir = path.join(OUT, REC_SUB, uid);
  if (!isDir(uidDir)) {
    console.error(`目录不存在: ${uidDir}`);
    process.exit(1);
  }
  let parts = fs
    .readdirSync(uidDir)
    .filter((f) => f.endsWith('.part.ndjson'))
    .map((f) => ({ name: f, k: parsePart(f) }))
    .filter((x) => x.k);
  if (token) parts = parts.filter((x) => x.name.includes(token));
  if (!parts.length) {
    say(`[finalize] uid=${uid} 无匹配 .part（token=${token ?? '全部'}）`);
    return;
  }
  const rows = readIndex(uidDir);
  const bySid = new Map(rows.map((r) => [r.sessionId, r]));
  for (const { name, k } of parts) {
    const { startLocal, sessionId } = k;
    if (bySid.has(sessionId)) {
      problems.push(`uid=${uid} sessionId=${sessionId} 已在 index，拒绝重复定稿：${name}`);
      continue;
    }
    const { objs } = loadFile(path.join(uidDir, name));
    const start = Number(String(sessionId).split('-')[1]);
    const lastTs = objs.length ? Math.max(...objs.map((e) => e.ts)) : NaN;
    const nameCounts = tallyNames(objs);
    const slug = note ? '' : deriveSlug(nameCounts); // 与 server.js finalizeSession 同口径
    const top = topOf(nameCounts);
    const { name: finalName } = resolveName(uidDir, startLocal, note, slug);
    const end = Number.isFinite(lastTs) ? lastTs : Date.now();
    const entry = {
      file: `${REC_SUB}/${uid}/${finalName}`,
      uid,
      sessionId,
      start: Number.isFinite(start) ? start : undefined,
      end,
      durMs: Number.isFinite(start) ? Math.max(0, end - start) : 0,
      lines: objs.length,
      slug,
      note,
      finalized: true,
      top,
      logRef: {
        dir: `${LOG_SUB}/${sanitize(uid)}`,
        from: Number.isFinite(start) ? start : undefined,
        to: end,
      },
    };
    say(`\n[finalize] uid=${uid} ${name}`);
    say(
      `    sessionId=${sessionId} start=${start} end=${end} durMs=${entry.durMs} lines=${objs.length}`,
    );
    say(`    note=${JSON.stringify(note)}（.part 文件名不含 note，缺省留空）slug="${slug}"`);
    say(`    最终名 → ${finalName}`);
    say('    top: ' + top.map(([kk, v]) => `${kk}:${v}`).join(', '));
    if (!APPLY) {
      stats.partsFinalized++;
      continue;
    }
    fs.renameSync(path.join(uidDir, name), path.join(uidDir, finalName));
    rows.push(entry);
    writeIndexAtomic(
      uidDir,
      rows.sort((a, b) => (a.start || 0) - (b.start || 0)),
    );
    stats.partsFinalized++;
    say(`    已定稿 + 追加 index（现 ${rows.length} 条，start 升序）`);
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────
async function main() {
  say(
    `dashcam store 修复 [${CMD ?? '?'}] —— ${APPLY ? 'APPLY 执行' : 'DRY-RUN（加 --apply 执行）'}`,
  );
  say(`  OUT=${OUT}`);
  if (!CMD || (CMD !== 'merge' && CMD !== 'finalize')) {
    console.error('子命令须为 merge 或 finalize');
    console.error('  node repair-store.js merge [--uid=<uid>] [--apply]');
    console.error(
      '  node repair-store.js finalize <uid> [<startLocal|sessionId>] [--note=<note>] [--apply]',
    );
    process.exit(2);
  }
  if (!isDir(OUT)) {
    console.error('store 根目录不存在：' + OUT);
    process.exit(1);
  }
  if (APPLY && (await serverRunning(PORT))) {
    console.error(
      `dashcam server 正在监听 ${PORT}，拒绝执行——请先停止服务（避免与在线定稿打架）。`,
    );
    process.exit(1);
  }
  if (CMD === 'merge') await merge();
  else await finalize();

  say('\n== 汇总 ==');
  if (CMD === 'merge')
    say(
      `  合并会话组 ${stats.groupsMerged}，消除分片 ${stats.piecesConsumed}${APPLY ? '' : '（预演）'}`,
    );
  else
    say(
      `  定稿 .part ${stats.partsFinalized}${APPLY ? '' : '（预演）'}，索引重写 ${stats.indexRewritten}`,
    );
  if (problems.length) {
    say(`\n⚠ 问题 ${problems.length} 条：`);
    for (const p of problems) say('  - ' + p);
    process.exitCode = 2;
  } else {
    say('\n无冲突/异常。' + (APPLY ? '完成。' : '（这是预演，未改动任何文件。加 --apply 执行。）'));
  }
}

main();
