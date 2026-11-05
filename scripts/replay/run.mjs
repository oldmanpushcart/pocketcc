#!/usr/bin/env node
/**
 * 录制仿真对拍 · 统一 CLI（replay 内核入口）。
 *
 * 内核只负责「怎么读 + 怎么回溯 + 怎么出报告 + 怎么退码」；
 * 具体 feat 的规则全在一张 manifest（scripts/verify-manifests/<id>.mjs）里。
 *
 * 用法：
 *   node scripts/replay/run.mjs --manifest <id> [录制1.ndjson ...] [--verbose]
 *   # <id> 对应 scripts/verify-manifests/<id>.mjs；缺省录制由 manifest.defaultRecs 提供
 *
 * 退出码：0=全部 HARD 不变量通过；1=存在 HARD 违例；2=输入/manifest 加载失败。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport, printReport } from './report.mjs';
import { engineSmoke } from './engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');

function argFlag(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : null;
}

async function loadManifest(idOrPath) {
  if (!idOrPath) {
    console.error('用法: node scripts/replay/run.mjs --manifest <id|path> [录制...] [--verbose]');
    process.exit(2);
  }
  const p = idOrPath.endsWith('.mjs')
    ? path.resolve(ROOT, idOrPath)
    : path.join(ROOT, 'scripts', 'verify-manifests', idOrPath + '.mjs');
  if (!fs.existsSync(p)) {
    console.error('找不到 manifest: ' + p);
    process.exit(2);
  }
  const mod = await import(pathToFileURL(p).href);
  if (!mod.default || typeof mod.default.buildScan !== 'function') {
    console.error('manifest 需默认导出 { buildScan, runVerify, ... }: ' + p);
    process.exit(2);
  }
  return mod.default;
}

const manifest = await loadManifest(argFlag('manifest'));

// 录制：位置参数优先，否则用 manifest.defaultRecs（相对 ROOT 解析）
const posArgs = argv.filter((a) => !a.startsWith('--') && a !== argFlag('manifest'));
const recs = posArgs.length
  ? posArgs.map((r) => path.resolve(ROOT, r))
  : (manifest.defaultRecs || []).map((r) => path.resolve(ROOT, r));
if (!recs.length) {
  console.error('无录制可跑（位置参数与 manifest.defaultRecs 均空）');
  process.exit(2);
}

// 引擎装配冒烟（各 feat 声明模块目录 + 期望导出面）：engineMods 缺省则跳过
let smoke = null;
if (manifest.engineMods) {
  if (!manifest.featDir) {
    console.error('manifest 声明了 engineMods 但缺 featDir');
    process.exit(2);
  }
  smoke = await engineSmoke(path.resolve(ROOT, manifest.featDir), manifest.engineMods);
}

let allOk = true;
for (const rec of recs) {
  let scan;
  try {
    scan = await manifest.buildScan(rec);
  } catch (e) {
    console.error('扫描失败：' + e.message);
    allOk = false;
    continue;
  }
  if (!scan.writes || scan.writes.length === 0) {
    console.error('录制 ' + path.basename(rec) + ' 未抽到任何写动作，检查格式/路径');
    allOk = false;
    continue;
  }
  const rep = makeReport(VERBOSE);
  manifest.runVerify(scan, rep);
  const ok = printReport(path.basename(rec), scan, rep, smoke);
  if (!ok) allOk = false;
}

console.log('\n' + (allOk ? '✅ 全部关键不变量通过' : '⚠️  存在违例/无法判定项，见上'));
process.exit(allOk ? 0 : 1);
