// 字段全量盘点：递归 harvest 所有 raw 战报的键路径（数组折叠 []），记录跨报告频次 + 样本值。
// 目的：对照 parse.js/normalize.js 已消费的字段，找出"还没弄清楚的字段"。
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const rd = cfg._paths.rawDir;
const files = [];
for (const d of readdirSync(rd)) {
  const p = join(rd, d);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) if (f.endsWith('.json')) files.push(join(p, f));
}

// path -> {count, types:Set, sample, depth}
const stats = new Map();
function note(path, val) {
  let s = stats.get(path);
  if (!s) {
    s = { count: 0, types: new Set(), sample: null };
    stats.set(path, s);
  }
  s.count++;
  const t = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
  s.types.add(t);
  if (s.sample === null && (t === 'number' || t === 'string' || t === 'boolean')) s.sample = val;
  else if (s.sample === null && t === 'array' && Array.isArray(val) && val.length)
    s.sample = `array[${val.length}]`;
}

function walk(node, prefix) {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      note(prefix + k, v);
      if (v && typeof v === 'object') {
        const arrKey = Array.isArray(v) ? `${prefix}${k}[]` : `${prefix}${k}.`;
        if (Array.isArray(v)) {
          for (const el of v) if (el && typeof el === 'object') walk(el, arrKey);
        } else walk(v, arrKey);
      }
    }
  }
}

for (const f of files) {
  const body = JSON.parse(readFileSync(f, 'utf8'));
  walk(body, '');
}

const out = [];
const log = (...a) => out.push(a.join(' '));
log(`== 全量键路径盘点，${files.length} 份战报 ==`);
log('');
for (const [path, s] of [...stats].sort((a, b) => a[0].localeCompare(b[0]))) {
  log(
    `${String(s.count).padStart(4)}  [${[...s.types].join('/')}]  ${path}   eg=${JSON.stringify(s.sample)}`,
  );
}
writeFileSync('data/field-audit.out', out.join('\n') + '\n', 'utf8');
