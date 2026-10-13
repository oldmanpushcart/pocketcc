// 一次性验证多个"未解码维度"的真实取值 vs 配置表键（决定哪些是 PK 命中、哪些要复合键、buff 列格式）。
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { decryBinary, parseTablePack, parseLocale, deriveVersion } from '../src/dict.js';

const cfg = loadConfig();
const step = Number.isFinite(cfg.dict.xorStep) ? cfg.dict.xorStep : 6;
const d = cfg._paths.dictDir;
const tables = parseTablePack(
  decryBinary(readFileSync(join(d, `table_${deriveVersion(cfg.dict.tableUrl)}.raw`)), step).split(
    '^--',
  )[1],
);
const locale = parseLocale(
  decryBinary(readFileSync(join(d, `locale_${deriveVersion(cfg.dict.localeUrl)}.raw`)), step).split(
    '^--',
  )[1],
);
const T = (n) => tables.get(n);
const row = (n, k) => T(n)?.rows.get(String(k));
const name = (id) => (id ? (locale.get(String(id)) ?? null) : null);

// 取最大 units 的一份（attacker）作为样本
const rd = cfg._paths.rawDir;
const files = [];
for (const dd of readdirSync(rd)) {
  const p = join(rd, dd);
  if (statSync(p).isDirectory())
    for (const f of readdirSync(p)) if (f.endsWith('.json')) files.push(join(p, f));
}
let P = null;
for (const f of files) {
  const b = JSON.parse(readFileSync(f, 'utf8')).battle;
  const p = b?.attacker?.players?.[0] ?? b?.defender?.players?.[0];
  if (
    p &&
    (p.effectSkins?.ownCastleEffects?.length || 0) >= 1 &&
    (p.CTCs?.collects?.length || 0) >= 5
  ) {
    P = p;
    break;
  }
}

const out = [];
const log = (...a) => out.push(a.join(' '));
const J = (v) => JSON.stringify(v);

log('== 真实样本 player uid=', P?.uid, '==');
// 1) effectSkins 取值 + 候选表 PK 命中
log('\n-- 皮肤 --');
log('effectSkins=', J(P.effectSkins));
const sk = P.effectSkins ?? {};
for (const [field, tbl] of [
  ['useCastleEffects', 'castle_effect'],
  ['ownCastleEffects', 'castle_effect'],
  ['useMarchSkins', 'march_skin'],
  ['ownMarchSkins', 'march_skin'],
  ['useHaloSkins', 'castle_halo'],
  ['ownHeadframes', 'dress_headframe'],
  ['effectIds', 'skin'],
  ['useIds', 'skin'],
  ['exhibitions', 'skin_exhibition'],
]) {
  const ids = sk[field] ?? [];
  const samples = ids.slice(0, 3);
  log(`  ${field} (${tbl}) len=${ids.length} 样本 ids=${J(samples)}`);
  for (const id of samples) {
    const r = row(tbl, id);
    if (r)
      log(
        `    ${tbl}[${id}] name=${J(name(r.name))} equip_buff=${J(r.equip_buff)} own_buff=${J(r.own_buff)} skin_level=${J(r.skin_level)} max=${J(r.max_level)}`,
      );
    else log(`    ${tbl}[${id}] MISS`);
  }
}

// 2) armyMastery → enhance_mastery（验证 value 是不是 PK id）
log('\n-- 兵种精通 armyMastery=', J(P.armyMastery), ' --');
for (const [army, val] of Object.entries(P.armyMastery ?? {})) {
  const r = row('enhance_mastery', val);
  log(`  army=${army} val=${val} → enhance_mastery[${val}]=${r ? J(r).slice(0, 200) : 'MISS'}`);
}

// 3) CTCs → cross_treasure_collection_level (collection_spec_id + level 复合键？)
log('\n-- 跨服收藏 CTCs.collects 前 5 --');
for (const c of (P.CTCs?.collects ?? []).slice(0, 5)) {
  log(
    `  collect id=${c.id} lv=${c.lv} → cross_treasure_collection[${c.id}]=${J(row('cross_treasure_collection', c.id))?.slice(0, 160)}`,
  );
  let hit = null;
  for (const r of T('cross_treasure_collection_level')?.rows.values() ?? []) {
    if (String(r.collection_spec_id) === String(c.id) && String(r.level) === String(c.lv)) {
      hit = r;
      break;
    }
  }
  log(`    level_table match=${hit ? J(hit).slice(0, 200) : 'NONE'}`);
}

// 4) 英雄觉醒技能
log('\n-- 觉醒技能 --');
const h = P.heroList?.[0];
log(`  hero id=${h?.id ?? h?.heroId} lv=${h?.level} awakenLevel=${h?.awakenLevel}`);
for (const [k, v] of Object.entries(h?.awakenSkillMap ?? {}).entries
  ? Object.entries(h?.awakenSkillMap ?? {}).slice(0, 4)
  : []) {
  log(`    skill ${k} → ${J(v)}`);
}
log('  hero_awakening_skill hdr=', J(T('hero_awakening_skill')?.header));
log('  hero_awakening_maxUpgrade hdr=', J(T('hero_awakening_maxUpgrade')?.header));
log('  hero_awakening_hero hdr=', J(T('hero_awakening_hero')?.header));
const h1 = P.heroList?.[0];
const hk = Object.keys(h1?.awakenSkillMap ?? {})[0];
if (hk) {
  log(`  lookup hero_awakening_skill[?skill=${hk}] 前 3 行样本:`);
  const rows = [...T('hero_awakening_skill').rows.values()]
    .filter((r) => String(r.awakening_skill_id) === String(hk))
    .slice(0, 3);
  for (const r of rows) log('    ', J(r).slice(0, 220));
}

// 5) 装饰物 suit/suitLevelBuff + decoration_contents
log('\n-- 装饰物 --');
log('suit=', J(P.effectDecorations?.suit));
log('suitLevelBuff=', J(P.effectDecorations?.suitLevelBuff));
for (const g of (P.effectDecorations?.suit ?? []).slice(0, 3))
  log(`  decoration_contents[${g}]=${J(row('decoration_contents', g))?.slice(0, 260)}`);
log('  ids 前5 =', J((P.effectDecorations?.ids ?? []).slice(0, 5)));

// 6) 机甲 skillIds
log('\n-- 机甲 skillIds --');
log('  mecha keys=', J(Object.keys(P.mechas?.[0] ?? {})));
log('  skillIds 样本=', J(P.mechas?.[0]?.skillIds));
if (T('mecha')) log(`  mecha[1007]=${J(row('mecha', 1007))?.slice(0, 260)}`);

// 7) traceEffectBuffs.s 取值分布 + 与 effectBuffs 对齐
log('\n-- traceEffectBuffs s 分布 (attacker) --');
const te = P.traceEffectBuffs ?? [];
const dist = {};
for (const x of te) dist[x.s] = (dist[x.s] ?? 0) + 1;
log('  s 分布:', J(dist));
log('  前 3 条:', J(te.slice(0, 3)));

// 8) effect_buff_hurts 语义：是否 buffId→累计伤害（可 PK 查 effect_buff 命名）
const fm = JSON.parse(readFileSync(files[0], 'utf8')).battle.fightMarches?.[0];
log('\n-- effect_buff_hurts 样本 keys --');
const ebh = fm?.attSkillHurts?.effect_buff_hurts ?? {};
const ek = Object.keys(ebh).slice(0, 5);
for (const id of ek) log(`  ${id}=${ebh[id]} name=${J(name(row('effect_buff', id)?.string))}`);

writeFileSync('data/gap-verify.out', out.join('\n') + '\n', 'utf8');
