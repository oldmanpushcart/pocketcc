// Recursively harvest every distinct object key in a raw report, and flag containers whose
// keys/values hint at titan / magic-stone / socket / gem, so we can find where 泰坦装备 + 魔石
// actually live (my earlier "titan absent" call checked only a literal `titan` key — too shallow).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const rid = process.argv[2] || '4881022285854650885';
const raw = JSON.parse(
  readFileSync(join(cfg._paths.rawDir, rid.slice(0, 4), rid + '.json'), 'utf8'),
);

const keyPaths = new Map(); // key -> Set of sample paths
const interesting = []; // {path, sample} for titan/stone/socket-ish nodes
const INTPAT = /titan|stone|magic|ms|socket|gem|rune|soul|equip|mo[a-z]*shi|inlay|镶嵌|魔石|泰坦/i;

function walk(node, path) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const p = path ? `${path}.${k}` : k;
      if (!keyPaths.has(k)) keyPaths.set(k, new Set());
      if (keyPaths.get(k).size < 3) keyPaths.get(k).add(p);
      if (INTPAT.test(k)) interesting.push({ path: p, sample: preview(node[k]) });
      walk(node[k], p);
    }
  }
}
function preview(v) {
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}
walk(raw, '');

const out = [];
out.push(`report ${rid}`);
out.push('\n== distinct keys (name -> up to 3 sample paths) ==');
for (const [k, paths] of [...keyPaths.entries()].sort()) {
  out.push(`${k.padEnd(22)} ${[...paths].slice(0, 2).join(' | ')}`);
}
out.push('\n== keys matching titan/stone/socket/equip-ish ==');
for (const it of interesting) out.push(`  ${it.path}  =  ${it.sample}`);

writeFileSync('data/titan-scan.out', out.join('\n') + '\n', 'utf8');
console.log(
  'wrote data/titan-scan.out keys=' + keyPaths.size + ' interesting=' + interesting.length,
);
