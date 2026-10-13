// Enumerate the chip-attribute vocabulary: distinct mecha_chip_draw_attr_<N> keys -> locale names,
// and how mechachip_draw.attr_type uses them. Also probe hero equipment infos (templateId) table.
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
const out = [];
const log = (...a) => out.push(a.join(' '));

log('=== distinct attr_key in mechachip_draw_attr (chip attribute vocabulary) ===');
const dAttr = tables.get('mechachip_draw_attr');
const suffixes = new Map();
for (const r of dAttr?.rows.values() ?? []) {
  const m = /^mecha_chip_draw_attr_(\d+)$/.exec(r.attr_key || '');
  if (m) suffixes.set(Number(m[1]), r.attr_key);
}
[...suffixes.keys()]
  .sort((a, b) => a - b)
  .forEach((n) =>
    log(`  attr #${n} key="${suffixes.get(n)}" -> "${locale.get(suffixes.get(n)) ?? '(MISS)'}"`),
  );

log('\n=== mechachip_draw.attr_type distinct values ===');
const d = tables.get('mechachip_draw');
const at = new Set();
for (const r of d?.rows.values() ?? [])
  for (const v of String(r.attr_type || '').split('|')) if (v !== '') at.add(Number(v));
log('  attr_type set: ' + [...at].sort((a, b) => a - b).join(','));

log('\n=== equipment infos templateId: find a table keyed by small ids w/ attr ===');
for (const cand of [
  'hero_equipment_infos',
  'hero_equip_infos',
  'equip_infos',
  'equipment_infos',
  'hero_equip_info',
  'equip_template',
  'hero_equip_template',
]) {
  if (tables.has(cand)) log(`  [HIT] ${cand} header=${tables.get(cand).header.join(',')}`);
}
log('  tables with header containing templateId/buffValue:');
for (const [n, t] of tables) {
  if (t.header.some((h) => /templateId|buffValue|template_id|buff_value/i.test(h)))
    log(`    ${n}: ${t.header.join(',')}`);
}

writeFileSync('data/chip-attr-vocab.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/chip-attr-vocab.out');
