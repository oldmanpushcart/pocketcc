/**
 * 协议注册表抽取器：从源码机械抽取初始表 + 增量合并（保留人工标注）。
 *
 * 运行：node scripts/protocol/extract.mjs（或 npm run protocol:extract）
 * 产物：scripts/protocol/registry/<domain>.mjs（跑完请 prettier --write 该目录）。
 *
 * 合并语义：
 * - 机器字段（usages、域归属）每次全量重建——以源码扫描为准；
 * - 人工字段（dir/note/src/fields）按协议号从旧表保留，新条目 dir 走启发式
 *   （PUSH_ 前缀或 CMD_PUSH_ → 'S2C'，其余 null 待渐进标注）；
 * - 源码已删除的号：条目移除并打印清单（人工标注随之丢弃，需要时先备份）；
 * - 域归属：号仅在一个 feat 域定义 → 该域分片；跨域或 core 基础设施 → shared。
 *
 * 闸门在 tests/protocol-registry.test.js（随 npm test）：本脚本只负责生成，
 * 一致性断言不在此处做，避免「生成即通过」的假阳性。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDefinitions } from './scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REG_DIR = path.join(HERE, 'registry');
const DOMAINS = ['shared', 'activity', 'alliance', 'battle', 'cq26', 'player', 'system'];

// ── 读旧表（首次运行无 registry/ 时为空）──────────────────────────────
/** @type {Map<number, {dir: 'C2S'|'S2C'|null, note: string, src: string, fields: string}>} */
const old = new Map();
try {
  const mod = await import('./index.mjs');
  for (const e of mod.all())
    old.set(e.cmd, { dir: e.dir, note: e.note, src: e.src, fields: e.fields });
} catch {
  // 首次生成：无旧表
}

// ── 扫描 + 按号聚合 ──────────────────────────────────────────────────
const defs = scanDefinitions();
/** @type {Map<number, import('./scan.mjs').ProtoDef[]>} */
const byCmd = new Map();
for (const d of defs) {
  if (!byCmd.has(d.cmd)) byCmd.set(d.cmd, []);
  byCmd.get(d.cmd).push(d);
}

/**
 * 域归属：单一 feat 域 → 该域；跨域 / core → shared。
 * @param {import('./scan.mjs').ProtoDef[]} ds
 * @returns {string}
 */
function domainOf(ds) {
  const doms = [...new Set(ds.map((d) => d.domain))];
  return doms.length === 1 && doms[0] !== 'core' ? doms[0] : 'shared';
}

/** @type {Map<string, object[]>} */
const files = new Map(DOMAINS.map((d) => [d, []]));
let added = 0;
let kept = 0;
for (const [cmd, ds] of [...byCmd].sort((a, b) => a[0] - b[0])) {
  const prev = old.get(cmd);
  if (prev) kept++;
  else added++;
  const names = [...new Set(ds.map((d) => d.name))];
  const dir = prev
    ? prev.dir
    : names.some((n) => n.startsWith('PUSH_') || n.startsWith('CMD_PUSH_'))
      ? 'S2C'
      : null;
  const usages = ds
    .map((d) => ({ name: d.name, feat: d.feat, file: d.file }))
    .sort((a, b) => (a.feat + a.name + a.file).localeCompare(b.feat + b.name + b.file));
  files.get(domainOf(ds)).push({
    cmd,
    dir,
    note: prev ? prev.note : '',
    src: prev ? prev.src : '',
    fields: prev ? prev.fields : '',
    usages,
  });
}
const removed = [...old.keys()].filter((c) => !byCmd.has(c)).sort((a, b) => a - b);

// ── 写分片（JSON 序列化，prettier 收尾统一风格）──────────────────────
mkdirSync(REG_DIR, { recursive: true });
const HEADER =
  '// 协议注册表 · {D} 域 —— 机械抽取 + 人工标注（dir/note/src/fields 重跑保留，usages 重跑重建）。\n' +
  '// 生成：node scripts/protocol/extract.mjs；闸门：tests/protocol-registry.test.js（npm test）。\n' +
  '// 条目键 = 协议号；名字是 feat 局部别名（同名异号是局部命名，非漂移）。只链不搬：src 指 references/ 出处。\n';
for (const [dom, entries] of files) {
  const body =
    HEADER.replace('{D}', dom) + 'export default ' + JSON.stringify(entries, null, 2) + ';\n';
  writeFileSync(path.join(REG_DIR, dom + '.mjs'), body, 'utf8');
}

console.log(
  '定义 %d 处 → 唯一号 %d 个（新增 %d / 保留标注 %d）',
  defs.length,
  byCmd.size,
  added,
  kept,
);
for (const [dom, entries] of files) console.log('  %s: %d 条', dom, entries.length);
if (removed.length) console.log('已移除（源码不再定义）:', removed.join(', '));
console.log('请跑: npx prettier --write scripts/protocol/registry/*.mjs');
