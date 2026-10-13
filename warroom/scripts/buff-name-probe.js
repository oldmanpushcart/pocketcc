// Buff/attribute semantics probe (offline from cached .raw):
//  (a) can effect_buff.string (a locale key like "buff_921016") resolve to a Chinese display name?
//  (b) dump the newly-discovered semantic tables that resolve still-unknown ids: talent,
//      hero_awakening_skill, Mecha_part, army_equip_suit, system_enhancement, building_buff_type,
//      hero_experiment_mecha_chip_opt, mechachip_draw_attr.
//  (c) enumerate effect_buff.type distinct values (the effect-type enum we still need names for).
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
const dumpTable = (name, ids) => {
  const t = tables.get(name);
  if (!t) return log(`[MISS] ${name}`);
  log(`\n### ${name} (rows=${t.rows.size}) header=${t.header.join(',')}`);
  const pick =
    ids && ids.length ? ids.filter((i) => t.rows.has(String(i))) : [...t.rows.values()].slice(0, 3);
  for (const r of pick) log('  ' + JSON.stringify(r).slice(0, 240));
};

log('=== (a) buff display-name via locale(string col) ===');
const eb = tables.get('effect_buff');
const ebIds = [
  '921016',
  '960012',
  '1003021',
  '990208',
  '9301160',
  '9301170',
  '1131001',
  '520010',
  '520113',
];
for (const id of ebIds) {
  const r = eb?.rows.get(id);
  if (!r) {
    log(`  ${id}: (no row)`);
    continue;
  }
  const key = r.string;
  log(
    `  ${id}: type=${r.type} valType=${r.value_type} target=${r.target} string="${key}" -> locale="${locale.get(key) ?? '(MISS)'}"`,
  );
}

log('\n=== (c) effect_buff distinct type values (top by count) ===');
const tc = {};
for (const r of eb?.rows.values() ?? []) tc[r.type] = (tc[r.type] || 0) + 1;
const top = Object.entries(tc)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30);
log(
  '  distinct types=' +
    Object.keys(tc).length +
    '  top30: ' +
    top.map(([k, v]) => `${k}:${v}`).join(' '),
);

log('\n=== (b) newly-discovered semantic tables ===');
dumpTable('talent', [3, 4, 7, 8]);
dumpTable('hero_awakening_skill', []);
dumpTable('Mecha_part', [61, 64, 65]);
dumpTable('army_equip_suit', []);
dumpTable('army_equip_buff', []);
dumpTable('system_enhancement', []);
dumpTable('building_buff_type', []);
dumpTable('hero_experiment_mecha_chip_opt', []);
dumpTable('mechachip_draw_attr', [1]);

writeFileSync('data/buff-name.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/buff-name.out');
