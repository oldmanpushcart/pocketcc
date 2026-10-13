// Scan ALL decoded config tables (offline, from cached .raw) and dump header + 1 sample row for
// tables matching a regex — to locate the missing dictionaries Phase 2c needs: attribute-code table,
// mecha_chip, enigma/beast cfg, hero talent, formation science/mastery, equip infos template,
// buff/effect type enum, ctc/collect, decoration/sublime, skin.
// Usage: node scripts/table-scan.js <regex>   (default: broad loadout set)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { decryBinary, parseTablePack } from '../src/dict.js';

const cfg = loadConfig();
const dictDir = cfg._paths.dictDir;
const rawFile = readdirSync(dictDir).find((f) => /^table_.*\.raw$/.test(f));
if (!rawFile) {
  console.log('no cached table_*.raw in', dictDir);
  process.exit(1);
}
const step = Number.isFinite(cfg.dict?.xorStep) ? cfg.dict.xorStep : 6;
const decoded = decryBinary(readFileSync(join(dictDir, rawFile)), step);
const body = decoded.split('^--')[1] ?? decoded;
const tables = parseTablePack(body);

const re = new RegExp(
  process.argv[2] ||
    'attr|proper|score|chip|mecha|enigma|beast|talent|science|mastery|formation|equip|template|buff|effect|decoration|sublime|ctc|collect|skin|relic|army_type',
  'i',
);
const out = [];
const log = (...a) => out.push(a.join(' '));
log(`cached=${rawFile}  total tables=${tables.size}`);
const names = [...tables.keys()].filter((n) => re.test(n)).sort();
log(`matched ${names.length} candidate tables\n`);
for (const n of names) {
  const t = tables.get(n);
  const first = t.rows.size ? t.rows.values().next().value : null;
  log(`### ${n}  (rows=${t.rows.size})`);
  log(`    header : ${t.header.join(',')}`);
  log(`    types  : ${(t.coltype || []).join(',')}`);
  if (first) {
    const sample = JSON.stringify(first);
    log(`    row[0] : ${sample.length > 400 ? sample.slice(0, 400) + '…' : sample}`);
  }
}
writeFileSync('data/table-scan.out', out.join('\n') + '\n', 'utf8');
console.log(`wrote data/table-scan.out  (${names.length} candidate tables)`);
