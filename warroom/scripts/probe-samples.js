// Dev probe: compare structural shape of all cached raw reports.
// Usage: node scripts/probe-samples.js
// Helps Phase 2 decide parser coverage across fight types.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

const files = walk(cfg._paths.rawDir);
const rows = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));

console.log('reportIds:');
files.forEach((f, i) => {
  const kb = (readFileSync(f).length / 1024).toFixed(0);
  console.log(`  [${i}] ${f.split(/[\\/]/).pop().replace('.json', '')}  size=${kb}KB`);
});

let header = false;
function col(label, vals) {
  if (!header) {
    console.log('\n=== scalar shape (one column per sample) ===');
    console.log(label.padEnd(20) + vals.map((_, i) => String(i).padStart(8)).join(''));
    header = true;
  }
  console.log(String(label).padEnd(20) + vals.map((v) => String(v ?? '-').padStart(8)).join(''));
}

col(
  'reportId',
  rows.map((r) => r.reportId),
);
col(
  'logtime',
  rows.map((r) => r.logtime),
);
col(
  'newFight',
  rows.map((r) => r.newFight),
);
col(
  'fightType',
  rows.map((r) => r.battle?.fightType),
);
col(
  'fightType2',
  rows.map((r) => r.battle?.fightType2),
);
col(
  'result',
  rows.map((r) => r.battle?.result),
);
col(
  'stage',
  rows.map((r) => r.battle?.stage),
);
col(
  'processLen',
  rows.map((r) => r.battle?.process?.length),
);
col(
  'marchesLen',
  rows.map((r) => r.battle?.fightMarches?.length),
);
col(
  'att.units',
  rows.map((r) => r.battle?.attacker?.units?.length),
);
col(
  'att.players',
  rows.map((r) => r.battle?.attacker?.players?.length),
);
col(
  'def.units',
  rows.map((r) => r.battle?.defender?.units?.length),
);
col(
  'def.players',
  rows.map((r) => r.battle?.defender?.players?.length),
);
col(
  'att.uid',
  rows.map((r) => String(r.battle?.attacker?.uid ?? '').slice(-6)),
);
col(
  'def.uid',
  rows.map((r) => String(r.battle?.defender?.uid ?? '').slice(-6)),
);

const union = {
  battle: new Set(),
  attacker: new Set(),
  defender: new Set(),
  march: new Set(),
  procKeysByT: new Map(),
};
const tcount = new Map();
for (const r of rows) {
  Object.keys(r.battle || {}).forEach((k) => union.battle.add(k));
  Object.keys(r.battle?.attacker || {}).forEach((k) => union.attacker.add(k));
  Object.keys(r.battle?.defender || {}).forEach((k) => union.defender.add(k));
  Object.keys(r.battle?.fightMarches?.[0] || {}).forEach((k) => union.march.add(k));
  for (const p of r.battle?.process || []) {
    tcount.set(p.t, (tcount.get(p.t) || 0) + 1);
    if (!union.procKeysByT.has(p.t)) union.procKeysByT.set(p.t, new Set());
    Object.keys(p).forEach((k) => union.procKeysByT.get(p.t).add(k));
  }
}

console.log('\n=== battle key union ===');
console.log([...union.battle].sort().join(', '));
console.log('\n=== fightMarches[0] key union ===');
console.log([...union.march].sort().join(', '));
console.log('\n=== attacker key union ===');
console.log([...union.attacker].sort().join(', '));
console.log('\n=== defender key union ===');
console.log([...union.defender].sort().join(', '));
console.log('\n=== process: keys per t ===');
for (const [t, keys] of [...union.procKeysByT.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(
    `  t=${String(t).padStart(2)} (n=${String(tcount.get(t)).padStart(3)}) : ${[...keys].sort().join(',')}`,
  );
}
