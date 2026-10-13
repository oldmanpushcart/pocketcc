// Attribute-code hunt (offline, from cached table_*.raw): find config tables whose row-id set
// covers the attr codes observed in chip rndAttrs / equip infos / element types, and that carry a
// name-ish column. Also list locale keys matching attr/property prefixes. Goal: pin the "属性码→名"
// master table (or prove it's a code-side enum, not config).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { decryBinary, parseTablePack, parseLocale } from '../src/dict.js';

const cfg = loadConfig();
const dictDir = cfg._paths.dictDir;
const tFile = readdirSync(dictDir).find((f) => /^table_.*\.raw$/.test(f));
const lFile = readdirSync(dictDir).find((f) => /^locale_.*\.raw$/.test(f));
const step = Number.isFinite(cfg.dict?.xorStep) ? cfg.dict.xorStep : 6;
const decode = (f) => decryBinary(readFileSync(join(dictDir, f)), step).split('^--')[1] ?? '';
const tables = parseTablePack(decode(tFile));
const locale = parseLocale(decode(lFile));

const codes = ['0', '2', '3', '4', '5', '11', '30', '32']; // attr codes seen in chip rndAttrs
const out = [];
const log = (...a) => out.push(a.join(' '));
log('=== tables whose id-set covers ALL codes ' + codes.join(',') + ' ===');
let hits = 0;
for (const [n, t] of tables) {
  if (!codes.every((c) => t.rows.has(c))) continue;
  const nameCol = t.header.find((h) => /name|attr|desc|show|key|word|title/i.test(h));
  if (!nameCol) continue;
  hits++;
  log(`### ${n} (rows=${t.rows.size}) nameCol=${nameCol}  header=${t.header.join(',')}`);
  for (const c of codes) {
    const r = t.rows.get(c);
    log(`    ${c} -> ${JSON.stringify(r).slice(0, 160)}`);
  }
}
log(`(covered-all candidate tables: ${hits})`);

log('\n=== tables whose id-set covers MOST codes (>=5) with a name col ===');
for (const [n, t] of tables) {
  const cover = codes.filter((c) => t.rows.has(c)).length;
  if (cover < 5 || cover === codes.every((c) => t.rows.has(c))) continue;
  const nameCol = t.header.find((h) => /name|attr|desc|show|key|word|title/i.test(h));
  if (!nameCol) continue;
  log(`### ${n} covers ${cover}/8 nameCol=${nameCol} header=${t.header.join(',')}`);
}

log('\n=== locale keys matching attr/property/battle_attr prefixes (sample) ===');
const lkeys = [...locale.keys()].filter((k) =>
  /^(attr|battle_attr|property|prop_|unit_attr|army_attr)/i.test(k),
);
log(`count=${lkeys.length}`);
for (const k of lkeys.slice(0, 40)) log(`  ${k} = ${locale.get(k)}`);

writeFileSync('data/attr-hunt.out', out.join('\n') + '\n', 'utf8');
console.log(`wrote data/attr-hunt.out  (covered-all hits=${hits}, localeAttrKeys=${lkeys.length})`);
