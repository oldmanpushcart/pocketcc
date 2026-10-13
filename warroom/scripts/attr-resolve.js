// Final attribute-code + residual-id resolution probe (offline).
// Pin chip rndAttrs attrCode (0/2/3/4/5/11/30/32) source; dump proper rows for talent / Mecha_part;
// check element type & formation science/mastery naming. Reuses locale + mechachip_draw_attr/buff_show.
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
const rowOf = (tn, id) => tables.get(tn)?.rows.get(String(id));
const resolve = (name, id) => {
  const r = rowOf(name, id);
  if (!r) return `${name}[${id}]=(no row)`;
  const k = r.attr_key ?? r.name ?? r.string;
  return `${name}[${id}] key="${k}" -> "${locale.get(k) ?? '(MISS)'}"`;
};

log('=== chip attrCode via candidate tables ===');
const codes = [0, 2, 3, 4, 5, 11, 30, 32];
for (const c of codes) log('  ' + resolve('mechachip_draw_attr', c));
log('  --- buff_show ---');
for (const c of codes)
  log('  ' + resolve('buff_show', c) + `  type=${rowOf('buff_show', c)?.type ?? ''}`);

log('\n=== talent rows (id,name->locale,buff) ===');
for (const t of [3, 4, 7, 8]) {
  const r = rowOf('talent', t);
  log(`  talent[${t}] name="${r?.name}" -> "${locale.get(r?.name) ?? '(MISS)'}"  buff=${r?.buff}`);
}

log('\n=== Mecha_part rows ===');
for (const t of [61, 64]) {
  const r = rowOf('Mecha_part', t);
  log(
    `  part[${t}] name="${r?.name}" -> "${locale.get(r?.name) ?? '(MISS)'}"  buff=${r?.buff} set=${r?.set_id}`,
  );
}

log('\n=== element type names? try locale keys + tables with id1..3 ===');
for (const tn of ['element', 'element_type', 'battle_element', 'attr_element']) {
  if (tables.has(tn)) log(`  found table ${tn}: header=${tables.get(tn).header.join(',')}`);
}
log('  locale keys matching element/elementType:');
for (const k of [...locale.keys()].filter((x) => /element/i.test(x)).slice(0, 15))
  log(`    ${k} = ${locale.get(k)}`);

log('\n=== formation science (formationV2.sciences key->?) & science table ===');
log('  science table present=' + tables.has('science'));
if (tables.has('science')) log('  science header=' + tables.get('science').header.join(','));
for (const s of [1, 2, 3]) {
  const r = rowOf('science', s);
  if (!r) {
    log(`  science[${s}]=(no row)`);
    continue;
  }
  log(`  science[${s}] = ${JSON.stringify(r).slice(0, 160)}  name->"${locale.get(r?.name) ?? ''}"`);
}

writeFileSync('data/attr-resolve.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/attr-resolve.out');
