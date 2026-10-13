// Phase 2c scoping probe: dump the FULL raw structure of every nested loadout container so we can
// (a) learn the attribute encodings (mecha chip rndAttrs, equip infos, talents, awaken, skills),
// (b) see exactly what lives in effectBuffs (the "加成" aggregate) and whether mecha/formation show
// up there again (duplicate views), and (c) gauge how much dict resolution each needs.
// Usage: node scripts/blob-dump.js [reportId]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { currentDictVersion, dictRow } from '../src/dict.js';

const cfg = loadConfig();
const db = openDb(cfg);
const rid = process.argv[2] || '4881022285854650885';
const meta = db.prepare('SELECT raw_path FROM reports WHERE report_id=?').get(rid);
const raw = JSON.parse(readFileSync(join(cfg._paths.rawDir, meta.raw_path), 'utf8'));
const DV = currentDictVersion(db);
const b = raw.battle ?? raw;

const out = [];
const log = (...a) => out.push(a.join(' '));
const J = (v) => JSON.stringify(v);
const side = b.attacker; // rich PvP side
const p = side.players[0];

log(`report ${rid}  dict=${DV}`);

log('\n===== side.effectBuffs (加成聚合) =====');
const eb = side.effectBuffs || [];
log(`count=${eb.length}`);
log('first 6: ' + J(eb.slice(0, 6)));
const stypes = {};
for (const x of eb)
  stypes[x.specialType ?? x.type ?? '(none)'] =
    (stypes[x.specialType ?? x.type ?? '(none)'] || 0) + 1;
log('specialType/value-key distribution: ' + J(stypes));
const bufids = [...new Set(eb.map((x) => x.bufid ?? x.id))];
log(`distinct bufid=${bufids.length}, sample=${J(bufids.slice(0, 10))}`);
let resolved = 0;
const ebRows = [];
for (const id of bufids.slice(0, 12)) {
  const r = dictRow(db, DV, 'effect_buff', id);
  if (r) {
    resolved++;
    ebRows.push({
      id,
      category: r.category,
      type: r.type,
      value_type: r.value_type,
      target: r.target,
      para1: r.para1,
      paraType1: r.paraType1,
      string: r.string,
    });
  }
}
log(`bufid hits effect_buff (first12)=${resolved}/12`);
for (const r of ebRows) log('  ' + J(r));

log('\n===== side.buffs =====');
log(J(side.buffs));

log('\n===== mechas[0] (机甲 + 芯片属性) =====');
const m = (side.mechas || [])[0] || {};
log(
  'mecha top keys: ' +
    J(Object.keys(m)) +
    `  mechaId=${m.mechaId} skinId=${m.skinId} skillIds=${J(m.skillIds)} parts=${J(m.parts)}`,
);
log(`chips count=${(m.chips || []).length}`);
for (const c of (m.chips || []).slice(0, 4))
  log(
    '  chip: ' +
      J(c) +
      `   [rndAttrs decoded] ${(c.rndAttrs || '')
        .split('|')
        .map((p) => p.split(';'))
        .map((a) => `${a[0]}=>${a[1]}`)
        .join(' , ')}`,
  );

log('\n===== heroList[0] (英雄：觉醒/天赋/被动/装备) =====');
const h = p.heroList[0];
log('hero keys: ' + J(Object.keys(h)));
for (const k of [
  'level',
  'star',
  'starExp',
  'awakenLevel',
  'awakenExp',
  'fullAwaken',
  'command',
  'war',
  'def',
  'skinId',
  'dressId',
  'changeId',
  'id',
])
  log(`  ${k} = ${J(h[k])}`);
log('  talents          : ' + J(h.talents));
log('  nonActiveSkills  : ' + J(h.nonActiveSkills));
log('  awakenSkillMap   : ' + J(h.awakenSkillMap));
log('  heroEquips[0]    : ' + J((h.heroEquips || [])[0]));

log('\n===== formationV2 (军阵：科技/精通) =====');
log(J(p.formationV2));

log('\n===== armyMastery (兵种精通) =====');
log(J(p.armyMastery));

log('\n===== armyEquips[0..2] / newArmyEquips.equips[0..2] =====');
log('armyEquips: ' + J((p.armyEquips || []).slice(0, 3)));
log('newArmyEquips.equips: ' + J(((p.newArmyEquips || {}).equips || []).slice(0, 3)));

log('\n===== enigmas (异能兽 + fields) =====');
log('beastDatas[0..1]: ' + J(((p.enigmas || {}).beastDatas || []).slice(0, 2)));
log('fields[0]       : ' + J(((p.enigmas || {}).fields || [])[0]));

log('\n===== CTCs / effectDecorations / elementLevels =====');
log(
  'CTCs.collects[0..3]   : ' +
    J(((p.CTCs || {}).collects || []).slice(0, 4)) +
    '  themes=' +
    J((p.CTCs || {}).themes),
);
log('effectDecorations     : ' + J(p.effectDecorations));
log('elementLevels         : ' + J(side.elementLevels));

db.close();
writeFileSync('data/blob-dump.out', out.join('\n') + '\n', 'utf8');
console.log(`wrote data/blob-dump.out (report ${rid})`);
