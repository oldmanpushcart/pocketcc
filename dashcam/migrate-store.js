#!/usr/bin/env node
/**
 * dashcam store 归档迁移：旧布局 → 新规范（一次性、幂等、默认 dry-run）。
 *
 * 新规范：
 *   报文  store/rec/<uid>/dashcam-rec-<startLocal>[-<note>][-<slug>].ndjson
 *         store/rec/<uid>/dashcam-rec-<startLocal>-<sessionId>.part.ndjson
 *         store/rec/<uid>/dashcam-rec-index.ndjson   （索引重写：file→rec/<uid>/dashcam-rec-*, logRef.dir→log/<uid>）
 *   日志  store/log/<uid>/dashcam-log-<YYYYMMDD>[-NN].ndjson   （小时段并入按天，单段超 LOG_MAX_SEG 滚序号段）
 *
 * 旧布局（迁移源）：
 *   store/<uid>/*.ndjson + store/<uid>/index.ndjson
 *   store/_log/<uid>/<YYYYMMDDTHH>[-NN].ndjson
 *
 * 用法：
 *   node migrate-store.js            # dry-run：只打印计划与校验数，不落任何改动
 *   node migrate-store.js --apply    # 真正执行改名/合并/重写索引/删旧
 * 迁移前务必确认 dashcam server 已停止（否则会与运行中的 .part/索引写入打架）。
 * 纯 node:fs/node:path，ESM，无三方依赖，与 server.js 一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const OUT = process.env.DASHCAM_OUT || path.join(__dirname, 'store');

const REC_SUB = 'rec';
const LOG_SUB = 'log';
const REC_PREFIX = 'dashcam-rec-';
const LOG_PREFIX = 'dashcam-log-';
const INDEX_NAME = 'dashcam-rec-index.ndjson';
const OLD_INDEX_NAME = 'index.ndjson';
const LOG_MAX_SEG = Number(process.env.DASHCAM_LOG_MAXSEG) || 32 * 1024 * 1024;

/** 统计动作计数，末尾汇总；错误项收集后非零退码。 */
const stats = {
  recMoved: 0,
  recPartMoved: 0,
  auxMoved: 0,
  indexRewritten: 0,
  logDaysMerged: 0,
  logSegWritten: 0,
  logFilesDeleted: 0,
};
const problems = [];
const say = (...a) => console.log(...a);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 顶层遗留 uid 目录 = 数字名目录（排除新 rec/log 与 _log）。 */
function legacyUidDirs(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+$/.test(n))
    .filter((n) => isDir(path.join(root, n)))
    .filter((n) => n !== REC_SUB && n !== LOG_SUB);
}

// ── 报文迁移：store/<uid>/*  →  store/rec/<uid>/dashcam-rec-* ────────
function migrateRec() {
  const dirs = legacyUidDirs(OUT);
  say(`\n[rec] 发现 ${dirs.length} 个遗留 uid 目录`);
  for (const uid of dirs) {
    const oldDir = path.join(OUT, uid);
    const newDir = path.join(OUT, REC_SUB, uid);
    const files = fs.readdirSync(oldDir);
    const recFiles = files.filter(
      (f) => f.endsWith('.ndjson') && f !== OLD_INDEX_NAME && !f.startsWith(REC_PREFIX),
    );
    const partFiles = recFiles.filter((f) => f.endsWith('.part.ndjson'));
    const bldFiles = recFiles.filter((f) => !f.endsWith('.part.ndjson'));
    const auxFiles = files.filter((f) => !f.endsWith('.ndjson'));

    say(
      `  uid=${uid}: 定稿 ${bldFiles.length}、.part ${partFiles.length}、杂项 ${auxFiles.length}`,
    );

    // 目标名 = REC_PREFIX + 原名（原名唯一，加前缀后仍唯一，无冲突）
    const moves = [];
    for (const f of bldFiles) moves.push({ from: f, to: REC_PREFIX + f, kind: 'rec' });
    for (const f of partFiles) moves.push({ from: f, to: REC_PREFIX + f, kind: 'part' });
    for (const f of auxFiles) moves.push({ from: f, to: f, kind: 'aux' }); // 非 ndjson 原样搬，保持可发现

    if (APPLY) fs.mkdirSync(newDir, { recursive: true });
    let dirFailed = false;
    for (const m of moves) {
      const src = path.join(oldDir, m.from);
      const dst = path.join(newDir, m.to);
      if (APPLY) {
        if (fs.existsSync(dst)) {
          problems.push(`rec 目标已存在，跳过改名：${dst}`);
          dirFailed = true;
          continue;
        }
        try {
          fs.renameSync(src, dst);
        } catch (e) {
          problems.push(`rec 改名失败 ${m.from}: ${e.message}`);
          dirFailed = true;
          continue;
        }
      }
      if (m.kind === 'rec') stats.recMoved++;
      else if (m.kind === 'part') stats.recPartMoved++;
      else stats.auxMoved++;
    }

    rewriteIndex(uid, oldDir, newDir, bldFiles, partFiles);

    // 旧目录若已空则删除；非空（改名失败/残留）保留并报告
    if (APPLY && !dirFailed) {
      const rest = fs.readdirSync(oldDir).filter((f) => f !== OLD_INDEX_NAME);
      if (rest.length === 0) {
        // 索引原件也一并清掉（已重写进 rec/<uid>/dashcam-rec-index.ndjson）
        try {
          fs.rmSync(path.join(oldDir, OLD_INDEX_NAME));
          fs.rmdirSync(oldDir);
          say(`    清理空目录 store/${uid}`);
        } catch (e) {
          problems.push(`清理旧目录 store/${uid} 失败: ${e.message}`);
        }
      } else {
        say(`    保留 store/${uid}（仍有 ${rest.length} 项未迁移）`);
      }
    }
  }
}

/**
 * 重写某 uid 的索引：旧 index.ndjson → rec/<uid>/dashcam-rec-index.ndjson。
 * 逐条 entry：file 由 <uid>/<name>.ndjson 改写为 rec/<uid>/dashcam-rec-<name>.ndjson；
 * logRef.dir 由 _log/<uid> 改写为 log/<uid>；其余字段原样。
 */
function rewriteIndex(uid, oldDir, newDir, movedBld, movedPart) {
  const oldIdx = path.join(oldDir, OLD_INDEX_NAME);
  if (!fs.existsSync(oldIdx)) {
    say(`    uid=${uid} 无 ${OLD_INDEX_NAME}（跳过索引重写）`);
    return;
  }
  const raw = fs.readFileSync(oldIdx, 'utf8');
  const rows = [];
  let dropped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      dropped++;
      continue;
    }
    if (e && e.file) {
      const base = path.basename(String(e.file)); // <name>.ndjson（无 REC_PREFIX）
      e.file = `${REC_SUB}/${uid}/${base.startsWith(REC_PREFIX) ? base : REC_PREFIX + base}`;
      if (e.logRef && typeof e.logRef.dir === 'string') {
        e.logRef.dir = e.logRef.dir.replace(/^_log\//, `${LOG_SUB}/`);
      }
      // 校验被引用的定稿文件确实在新位置：APPLY 时查 rec/<uid>/ 下的加前缀新名；dry-run 时文件未动、查旧目录原名
      const newBase = base.startsWith(REC_PREFIX) ? base : REC_PREFIX + base;
      const chk = APPLY ? path.join(newDir, newBase) : path.join(oldDir, base);
      if (!fs.existsSync(chk)) problems.push(`索引引用文件缺失: uid=${uid} base=${base}`);
    }
    rows.push(e);
  }
  if (dropped) problems.push(`索引含 ${dropped} 条坏行已丢弃 uid=${uid}`);
  const outIdx = path.join(newDir, INDEX_NAME);
  say(
    `    重写索引 → ${path.relative(OUT, outIdx)}（${rows.length} 行${movedPart ? `，含 ${movedPart.length} 个 .part 未入索引` : ''}）`,
  );
  if (APPLY) {
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    const tmp = outIdx + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, outIdx);
  }
  stats.indexRewritten++;
}

// ── 日志迁移：store/_log/<uid>/YYYYMMDDTHH[-NN] → store/log/<uid>/dashcam-log-YYYYMMDD[-NN] ──
/** 从段文件名剥可选前缀，解析（时间键 t，序号 seq，天 day）。兼容天/小时两种历史粒度。 */
function parseSeg(name) {
  const m = /^(?:dashcam-log-)?(\d{8}(?:T\d{2})?)(?:-(\d{2}))?\.ndjson$/.exec(name);
  if (!m) return null;
  return { t: m[1], seq: m[2] === undefined ? -1 : Number(m[2]), day: m[1].slice(0, 8) };
}

function migrateLog() {
  const logRoot = path.join(OUT, '_log');
  if (!isDir(logRoot)) {
    say('\n[log] 无 store/_log 目录（日志已迁移或从未产生）');
    return;
  }
  const uids = fs.readdirSync(logRoot).filter((n) => isDir(path.join(logRoot, n)));
  say(`\n[log] 发现 ${uids.length} 个日志 uid 目录`);
  for (const uid of uids) {
    const srcDir = path.join(logRoot, uid);
    const dstDir = path.join(OUT, LOG_SUB, uid);
    const names = fs.readdirSync(srcDir).filter((n) => n.endsWith('.ndjson'));
    const parsed = names.map((n) => ({ name: n, k: parseSeg(n) })).filter((x) => x.k);
    // 按天分组
    const byDay = new Map();
    for (const x of parsed) {
      if (!byDay.has(x.k.day)) byDay.set(x.k.day, []);
      byDay.get(x.k.day).push(x);
    }
    let uidIn = 0;
    let uidOut; // 由下方按 APPLY/dry-run 分别赋值后再参与比对
    const consumedSrc = [];
    const outPaths = []; // 本 uid 写出的日志段（用于回读校验）
    if (APPLY && parsed.length) fs.mkdirSync(dstDir, { recursive: true });
    for (const [day, items] of [...byDay.entries()].sort()) {
      // 天内按（时间键，序号）升序拼接，还原真实时间线
      items.sort((a, b) => (a.k.t < b.k.t ? -1 : a.k.t > b.k.t ? 1 : a.k.seq - b.k.seq));
      let seq = 0;
      let curBytes = 0;
      let outPath = path.join(dstDir, `${LOG_PREFIX}${day}.ndjson`);
      let open = null; // fs.openSync 返回的数字 fd
      let dayLines = 0;
      let dayBytes = 0;
      const daySegs = [outPath];
      const roll = () => {
        if (open != null) {
          fs.closeSync(open);
          open = null;
        }
      };
      for (const it of items) {
        const src = path.join(srcDir, it.name);
        const buf = fs.readFileSync(src); // 单小时段通常远小于内存上限
        let lineStart = 0;
        for (let i = 0; i <= buf.length; i++) {
          if (i < buf.length && buf[i] !== 0x0a) continue;
          const line = buf.slice(lineStart, i); // 不含换行
          lineStart = i + 1;
          if (line.length === 0) continue; // 跳过空行（含文件尾换行产生的空段）
          const lineBytes = line.length + 1; // + 换行
          if (curBytes > 0 && curBytes + lineBytes > LOG_MAX_SEG) {
            roll();
            seq++;
            curBytes = 0;
            outPath = path.join(
              dstDir,
              `${LOG_PREFIX}${day}-${String(seq).padStart(2, '0')}.ndjson`,
            );
            daySegs.push(outPath);
          }
          if (APPLY) {
            if (open == null) {
              open = fs.openSync(outPath, curBytes === 0 && seq === 0 ? 'w' : 'a');
              stats.logSegWritten++;
            }
            fs.writeSync(open, line);
            fs.writeSync(open, '\n');
          }
          curBytes += lineBytes;
          dayLines++;
          dayBytes += lineBytes;
        }
        consumedSrc.push(src);
      }
      roll();
      outPaths.push(...daySegs);
      uidIn += dayLines;
      stats.logDaysMerged++;
      say(
        `    uid=${uid} ${day}: ${items.length} 段并入 → ${LOG_PREFIX}${day}${seq ? `-${String(seq).padStart(2, '0')}` : ''}.ndjson（${dayLines} 行 / ${(dayBytes / 1024 / 1024).toFixed(2)}MB）`,
      );
    }
    // 校验：APPLY 时回读实际写出的段文件行数（而非自比自），与源行数比对
    if (APPLY) uidOut = countNdjsonLines(outPaths);
    else uidOut = uidIn; // dry-run 预演：假设写侧不丢失
    say(
      `  uid=${uid} 源 ${uidIn} 行 → 目标 ${uidOut} 行（${uidIn === uidOut ? '一致' : '不一致!'}${APPLY ? '' : '，预演'}）`,
    );
    if (uidIn !== uidOut) problems.push(`日志行数不一致 uid=${uid}：源 ${uidIn} 目标 ${uidOut}`);
    // 校验通过才删旧
    if (APPLY) {
      if (uidIn !== uidOut) {
        problems.push(`uid=${uid} 行数不一致，已保留旧 _log 不删`);
      } else {
        for (const src of consumedSrc) {
          try {
            fs.rmSync(src);
            stats.logFilesDeleted++;
          } catch (e) {
            problems.push(`删旧日志段失败 ${src}: ${e.message}`);
          }
        }
      }
      const left = fs.readdirSync(srcDir);
      if (left.length === 0) {
        fs.rmdirSync(srcDir);
        say(`    清理空目录 store/_log/${uid}`);
      } else {
        say(`    保留 store/_log/${uid}（${left.length} 项未迁移/校验未过）`);
      }
    } else {
      stats.logFilesDeleted += parsed.length; // dry-run 预估可删数
    }
  }
  if (APPLY && isDir(logRoot) && fs.readdirSync(logRoot).length === 0) {
    fs.rmdirSync(logRoot);
    say('    清理空目录 store/_log');
  }
}

/** 回读一批 ndjson 文件的非空行总数（与迁移写入口径一致：只计非空行）。 */
function countNdjsonLines(paths) {
  let n = 0;
  for (const p of paths) {
    const buf = fs.readFileSync(p);
    for (let i = 0; i < buf.length; i++) {
      // 每个非 '\n' 且（行首或前一字节为 '\n'）的字节即一行的开始：统计非空行行数
      if (buf[i] !== 0x0a && (i === 0 || buf[i - 1] === 0x0a)) n++;
    }
  }
  return n;
}

function main() {
  say(`dashcam store 迁移 —— ${APPLY ? 'APPLY 执行' : 'DRY-RUN（仅计划，加 --apply 执行）'}`);
  say(`  OUT=${OUT}  LOG_MAX_SEG=${(LOG_MAX_SEG / 1024 / 1024).toFixed(0)}MB`);
  if (!isDir(OUT)) {
    console.error('store 根目录不存在：' + OUT);
    process.exit(1);
  }
  migrateRec();
  migrateLog();
  say('\n== 汇总 ==');
  say(
    `  报文定稿改名 ${stats.recMoved}，.part 改名 ${stats.recPartMoved}，杂项搬运 ${stats.auxMoved}，索引重写 ${stats.indexRewritten}`,
  );
  say(
    `  日志并天段 ${stats.logDaysMerged} 天，写出段 ${stats.logSegWritten}，旧小时文件删除 ${APPLY ? stats.logFilesDeleted : '≈' + stats.logFilesDeleted + '(待删)'} `,
  );
  if (problems.length) {
    say(`\n⚠ 问题 ${problems.length} 条：`);
    for (const p of problems) say('  - ' + p);
    process.exitCode = 2;
  } else {
    say(
      '\n无冲突/异常。' +
        (APPLY ? '迁移完成。' : '（这是预演，实际未改动任何文件。加 --apply 执行。）'),
    );
  }
}

main();
