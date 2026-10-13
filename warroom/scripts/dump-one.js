// Dev probe #2: deep-dump one report's sub-structures to design column mapping.
// Usage: node scripts/dump-one.js <reportId>
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { rawRelPath } from '../src/link.js';
import { join } from 'node:path';

const cfg = loadConfig();
const id = process.argv[2];
if (!id) throw new Error('usage: node scripts/dump-one.js <reportId>');
const body = JSON.parse(readFileSync(join(cfg._paths.rawDir, rawRelPath(id)), 'utf8'));
const b = body.battle;
const cut = (v, n = 600) => {
  const s = JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + `...(+${s.length - n})` : s;
};

console.log('== attacker.units[0] ==', cut(b.attacker.units[0], 700));
console.log('\n== attacker.players[0].heroList ==', cut(b.attacker.players[0].heroList, 400));
console.log(
  '\n== attacker.players[0].playerInfo (keys) ==',
  b.attacker.players[0].playerInfo && Object.keys(b.attacker.players[0].playerInfo).join(','),
);
console.log('   playerInfo sample:', cut(b.attacker.players[0].playerInfo, 400));
console.log('\n== players[0].armyEquips ==', cut(b.attacker.players[0].armyEquips, 300));
console.log('== players[0].newArmyEquips ==', cut(b.attacker.players[0].newArmyEquips, 300));
console.log('== players[0].formationV2 ==', cut(b.attacker.players[0].formationV2, 300));
console.log('== players[0].enigmas ==', cut(b.attacker.players[0].enigmas, 300));
console.log('== players[0].CTCs ==', cut(b.attacker.players[0].CTCs, 300));
console.log('== players[0].armyMastery ==', cut(b.attacker.players[0].armyMastery, 300));
console.log('== players[0].effectSkins ==', cut(b.attacker.players[0].effectSkins, 200));
console.log('== players[0].traps ==', cut(b.attacker.players[0].traps, 200));

console.log('\n== attacker.effectBuffs[0..2] ==', cut(b.attacker.effectBuffs?.slice(0, 3), 400));
console.log('== attacker.buffs ==', cut(b.attacker.buffs, 300));
console.log('== attacker.elementLevels ==', cut(b.attacker.elementLevels, 300));
console.log('== attacker.mechas2 ==', cut(b.attacker.mechas2, 300));
console.log('== attacker.allStandings ==', cut(b.attacker.allStandings, 200));
console.log('== attacker.armyUuids[0..1] ==', cut(b.attacker.armyUuids?.slice(0, 2), 300));

const fm = b.fightMarches[0];
console.log(
  '\n== fightMarches[0] scalar ==',
  cut(
    {
      attArmyNum: fm.attArmyNum,
      defArmyNum: fm.defArmyNum,
      attExtraArmyNum: fm.attExtraArmyNum,
      defExtraArmyNum: fm.defExtraArmyNum,
      attPower: fm.attPower,
      defPower: fm.defPower,
      attBattlePower: fm.attBattlePower,
      attBattlePowerVal: fm.attBattlePowerVal,
      attMaxPower: fm.attMaxPower,
      attPutArmy: fm.attPutArmy,
      attPutArmyV2: fm.attPutArmyV2,
      attSpecialBuff: fm.attSpecialBuff,
    },
    800,
  ),
);
console.log('\n== attSkillHurts ==', cut(fm.attSkillHurts, 500));

console.log('\n== defender pveId? ==', b.defender.pveId, ' def.uid=', b.defender.uid);
console.log('== reportComparison ==', cut(b.reportComparison, 200));
console.log('== extraFlag ==', cut(b.extraFlag, 200));
