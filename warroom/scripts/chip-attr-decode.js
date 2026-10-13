// Test the hypothesis: chip rndAttrs "<code>;<value>" means code = INDEX into Mecha_chip[chipId].chip_buff_rd
// (a '|'-joined buffid pool), value = rolled amount. For each chip in a report, resolve pool[code] ->
// effect_buff -> locale name. If names come out as real chip attributes, the enum is settled.
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
const MC = tables.get('Mecha_chip');
const EB = tables.get('effect_buff');
const buffName = (id) => {
  const r = EB?.rows.get(String(id));
  return r ? (locale.get(r.string) ?? `(no-locale ${r.string})`) : `(no-buff ${id})`;
};

const rid = process.argv[2] || '4881022285854650885';
const rawAbs = join(cfg._paths.rawDir, rid.slice(0, 4), rid + '.json');
const raw = JSON.parse(readFileSync(rawAbs, 'utf8'));
const b = raw.battle ?? raw;

const out = [];
const log = (...a) => out.push(a.join(' '));
for (const side of ['attacker', 'defender']) {
  for (const m of b[side]?.mechas ?? []) {
    for (const chip of m.chips ?? []) {
      const row = MC?.rows.get(String(chip.chipId));
      const pool = String(row?.chip_buff_rd ?? '')
        .split('|')
        .filter(Boolean);
      log(
        `\n[${side}] mechaId=${m.mechaId} chipId=${chip.chipId} lvl=${chip.level} poolLen=${pool.length} chip_buff=${row?.chip_buff} core=${row?.core_chip_skill}`,
      );
      if (!row) {
        log('   (chipId not in Mecha_chip)');
        continue;
      }
      for (const pair of String(chip.rndAttrs ?? '')
        .split('|')
        .filter(Boolean)) {
        const [code, val] = pair.split(';');
        const buffId = pool[Number(code)];
        log(
          `   code=${code} val=${val}  -> pool[${code}]=${buffId ?? '(OOB)'} -> "${buffId ? buffName(buffId) : '?'}"`,
        );
      }
      // also show fixed chip_buff resolved
      const fixed = String(row.chip_buff ?? '')
        .split('|')
        .filter(Boolean);
      if (fixed.length)
        log(`   fixed chip_buff: ${fixed.map((id) => `${id}="${buffName(id)}"`).join(' , ')}`);
    }
  }
}
writeFileSync('data/chip-decode.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/chip-decode.out (report ' + rid + ')');
