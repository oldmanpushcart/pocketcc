// Loadout (养成/编配) probe: for one rich report, reveal which build dimensions actually exist in
// the raw JSON and how deep — heroes(+skill lv/awakening), mecha, titan, enigma/beast, mastery,
// formation, element attrs, equips, skins/decorations, traps. Tells P3 what the fact card can carry.
// Usage: node scripts/loadout-probe.js [reportId]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const cfg = loadConfig();
const db = openDb(cfg);
const rid = process.argv[2] || '4881022285854650885';
const row = db.prepare('SELECT raw_path FROM reports WHERE report_id=?').get(rid);
if (!row) {
  console.log('report not in db:', rid);
  process.exit(1);
}
const rawAbs = join(cfg._paths.rawDir, row.raw_path);
const raw = JSON.parse(readFileSync(rawAbs, 'utf8'));

const out = [];
const log = (...a) => out.push(a.join(' '));
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : String(typeof o));
const shape = (v, _d = 0) => {
  if (Array.isArray(v)) return v.length ? `[${v.length}] item{${keys(v[0])}}` : '[]';
  if (v && typeof v === 'object') return `{${keys(v)}}`;
  return typeof v;
};

const b = raw.battle ?? raw;
log(`report ${rid}  fightType=${b.fightType}/${b.fightType2}  result=${b.result}`);

for (const side of ['attacker', 'defender']) {
  const s = b[side];
  if (!s) continue;
  log(`\n########## ${side} (uid=${s.uid}) ##########`);
  log(`  side keys        : ${keys(s)}`);
  log(`  elementLevels    : ${shape(s.elementLevels)}`);
  log(`  mechas / mechas2 : ${shape(s.mechas)}  |  ${shape(s.mechas2)}`);
  log(`  buffs/effectBuffs: ${shape(s.buffs)}  |  ${shape(s.effectBuffs)}`);
  log(
    `  titan* present   : ${
      keys(s)
        .split(',')
        .filter((k) => /titan/i.test(k))
        .join(',') || '(none at side level)'
    }`,
  );
  const ps = s.players;
  log(`  players          : ${shape(ps)}`);
  if (!Array.isArray(ps) || !ps.length) continue;
  const p = ps[0];
  log(`  player[0] keys   : ${keys(p)}`);
  const hero0 = Array.isArray(p.heroList) ? p.heroList[0] : p.heroList;
  log(`  heroList         : ${shape(p.heroList)}`);
  if (hero0 && typeof hero0 === 'object') {
    log(`    hero[0] keys   : ${keys(hero0)}`);
    log(
      `    hero[0] sample : level=${hero0.level} star=${hero0.star} skillLv=${hero0.skillLevel ?? hero0.skillLv} awake=${hero0.awaken ?? hero0.awakening ?? hero0.awakeLevel}  quality=${hero0.quality}`,
    );
    log(`    heroEquips     : ${shape(hero0.heroEquips)}`);
    log(`    heroSkills     : ${shape(hero0.skills ?? hero0.heroSkills ?? hero0.skillList)}`);
  }
  log(
    `  formationV2      : ${shape(p.formationV2)}${p.formationV2 ? ' keys{' + keys(p.formationV2.sciences ? { sci: 1 } : p.formationV2) + '}' : ''}`,
  );
  log(`  armyMastery      : ${shape(p.armyMastery)}`);
  log(`  armyEquips       : ${shape(p.armyEquips)}`);
  log(`  newArmyEquips    : ${shape(p.newArmyEquips)}`);
  log(`  enigmas          : ${shape(p.enigmas)}`);
  const beast = p.enigmas && Array.isArray(p.enigmas.beastDatas) ? p.enigmas.beastDatas[0] : null;
  if (beast)
    log(
      `    beast[0] keys  : ${keys(beast)}  star=${beast.star} cfg=${beast.cfg} level=${beast.level} power=${beast.power}`,
    );
  log(`  CTCs             : ${shape(p.CTCs)}`);
  log(`  effectSkins      : ${shape(p.effectSkins)}`);
  log(`  effectDecorations: ${shape(p.effectDecorations)}`);
  log(`  traps            : ${shape(p.traps)}`);
  // hunt any titan-ish key anywhere in the player object
  const titanKeys = keys(p)
    .split(',')
    .filter((k) => /titan|祝福|bless/i.test(k));
  log(`  titan* in player : ${titanKeys.join(',') || '(none)'}`);
}

db.close();
writeFileSync('data/loadout-probe.out', out.join('\n') + '\n', 'utf8');
console.log(`wrote data/loadout-probe.out (report ${rid})`);
