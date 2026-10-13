// Pre-normalizer mapping probe: confirm the exact structure of every buff/attr-bearing container
// so the归一化器 resolves each view correctly instead of guessing. Uses offline-decoded tables.
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
const L = (k) => (typeof k === 'string' ? (locale.get(k) ?? `(no-locale ${k})`) : k);
const out = [];
const log = (...a) =>
  out.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));

const hdr = (tn) => {
  const t = tables.get(tn);
  return t ? { header: t.header, rows: t.rows.size } : null;
};

log('== effect_buff: does enigma 520xxx exist? ==');
const EB = tables.get('effect_buff');
for (const id of [520010, 520113, 520123, 520112, 520142, 520100, 520012]) {
  const r = EB?.rows.get(String(id));
  log(
    `  effect_buff[${id}]`,
    r ? `name="${L(r.string)}" type=${r.type} value_type=${r.value_type}` : '(absent)',
  );
}

log('\n== talent row (id 3..8) ==');
const T = tables.get('talent');
log('  header', hdr('talent')?.header);
for (const id of [3, 4, 7, 8]) {
  const r = T?.rows.get(String(id));
  if (r)
    log(
      `  talent[${id}] name-key=${r.name}->"${L(r.name)}" buffId=${r.buffId} col?=${r.buff ?? r.buff_id ?? '?'}`,
    );
}

log('\n== enigma_beast row (cfg 50) ==');
const EB2 = tables.get('enigma_beast');
log('  header', hdr('enigma_beast')?.header);
const beast = EB2?.rows.get('50');
if (beast) log('  enigma_beast[50]', beast);

log('\n== hero_equip_buff_rd (equip infos.templateId 4/6/10206) ==');
const HEB = tables.get('hero_equip_buff_rd');
log('  header', hdr('hero_equip_buff_rd')?.header);
log('  sample row[0]', HEB ? [...HEB.rows.values()][0] : null);
for (const id of [4, 6, 10206]) {
  const r = HEB?.rows.get(String(id));
  log(`  hero_equip_buff_rd[${id}]`, r ?? '(absent)');
}

log('\n== army_equip_suit (equip_attr) ==');
const AES = tables.get('army_equip_suit');
log('  header', hdr('army_equip_suit')?.header);
const s0 = AES ? [...AES.rows.values()][0] : null;
log('  sample', s0);

log('\n== army_equip (itemId 403100) ==');
const AE = tables.get('army_equip');
log('  header', hdr('army_equip')?.header);
for (const id of [403100, 403000]) {
  const r = AE?.rows.get(String(id));
  log(`  army_equip[${id}]`, r ? `name-key=${r.name}->"${L(r.name)}"` : '(absent)', r ?? '');
}

log('\n== Mecha_part (id 64) ==');
const MP = tables.get('Mecha_part');
log('  header', hdr('Mecha_part')?.header);
const mp = MP?.rows.get('64');
if (mp) log('  Mecha_part[64]', mp);

writeFileSync('data/loadout-map.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/loadout-map.out');
