// Phase 2a parser: decode a raw report body into the structured tables WITHOUT
// depending on the data dictionary — dictionary ids (armyId/career/skill/hero/
// buffId/...) are stored as raw integers; name-decoding is the separate 2b layer.
//
// Idempotent: re-parsing a report first clears its prior child rows, then rewrites
// in one transaction. Precision: JSON.parse already rounds >2^53 ints inside the
// body (hero equip id, enigma id) — for stats that is acceptable; the untouched
// original is always on disk, and battle_events/side_players keep raw JSON blobs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLog } from './log.js';
import { rawRelPath } from './link.js';
import { toInt, toReal, toJson } from './db.js';
import { normalizeReport } from './normalize.js';
import { currentDictVersion } from './dict.js';
import { kindOf, outcomeOf, buffRefOf } from './event-semantics.js';

const log = createLog('PARSE');

/** playerInfo arrives as a double-encoded JSON string -> object (or null). */
function parsePlayerInfo(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/** Delete this report's previously parsed child rows (re-parse idempotency). */
function clearParsed(db, reportId) {
  for (const t of [
    'battle_marches',
    'sides',
    'side_players',
    'side_units',
    'unit_instances',
    'battle_events',
  ]) {
    db.prepare(`DELETE FROM ${t} WHERE report_id = ?`).run(reportId);
  }
}

function insertMarches(db, reportId, marches) {
  const stmt = db.prepare(`INSERT INTO battle_marches (
    report_id, seq, att_march_id, def_march_id, att_fight_team_id, def_fight_team_id,
    att_power, def_power, att_max_power, def_max_power,
    att_battle_power, def_battle_power, att_battle_power_val, def_battle_power_val,
    att_over_round, def_over_round, att_army_num, def_army_num,
    skill_hurts, traps, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  marches.forEach((fm, seq) => {
    stmt.run(
      reportId,
      seq,
      fm.attMarchId != null ? String(fm.attMarchId) : null,
      fm.defMarchId != null ? String(fm.defMarchId) : null,
      toInt(fm.attFightTeamId),
      toInt(fm.defFightTeamId),
      toReal(fm.attPower),
      toReal(fm.defPower),
      toReal(fm.attMaxPower),
      toReal(fm.defMaxPower),
      typeof fm.attBattlePower === 'string' ? fm.attBattlePower : null,
      typeof fm.defBattlePower === 'string' ? fm.defBattlePower : null,
      toInt(fm.attBattlePowerVal),
      toInt(fm.defBattlePowerVal),
      toInt(fm.attOverRoundNum),
      toInt(fm.defOverRoundNum),
      toInt(fm.attArmyNum),
      toInt(fm.defArmyNum),
      toJson({ att: fm.attSkillHurts ?? null, def: fm.defSkillHurts ?? null }),
      toJson({ att: fm.attTraps ?? null, def: fm.defTraps ?? null }),
      toJson({
        attPutArmy: fm.attPutArmy ?? null,
        attPutArmyV2: fm.attPutArmyV2 ?? null,
        defPutArmy: fm.defPutArmy ?? null,
        defPutArmyV2: fm.defPutArmyV2 ?? null,
        attExtraArmyNum: fm.attExtraArmyNum ?? null,
        defExtraArmyNum: fm.defExtraArmyNum ?? null,
        attSpecialBuff: fm.attSpecialBuff ?? null,
        defSpecialBuff: fm.defSpecialBuff ?? null,
      }),
    );
  });
}

function insertSide(db, reportId, sideKey, s) {
  if (!s) return;
  const st = s.allStandings || {};
  db.prepare(
    `INSERT INTO sides (
    report_id, side, uid, march_id, career, al_tag, fight_team_id,
    total, survival, dead, wounded, element_levels, buffs, mechas, isolated, stamp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    reportId,
    sideKey,
    s.uid != null ? String(s.uid) : null,
    s.marchId != null ? String(s.marchId) : null,
    toInt(s.career),
    s.alTag ?? null,
    toInt(s.fightTeamId),
    toInt(st.total),
    toInt(st.survival),
    toInt(st.dead),
    toInt(st.wounded),
    toJson(s.elementLevels ?? null),
    toJson({
      buffs: s.buffs ?? null,
      effectBuffs: s.effectBuffs ?? null,
      traceEffectBuffs: s.traceEffectBuffs ?? null,
    }),
    toJson({ mechas: s.mechas ?? null, mechas2: s.mechas2 ?? null }),
    toInt(s.isolated),
    toInt(s.stamp),
  );

  // players (each side hosts N players)
  const pStmt = db.prepare(`INSERT INTO side_players (
    report_id, side, seq, uid, player_info, hero_list, formation_v2, army_equips,
    new_army_equips, enigmas, ctc, army_mastery, effect_skins, effect_decorations, traps, standings)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  (s.players || []).forEach((p, seq) => {
    pStmt.run(
      reportId,
      sideKey,
      seq,
      p.uid != null ? String(p.uid) : null,
      toJson(parsePlayerInfo(p.playerInfo)),
      toJson(p.heroList ?? null),
      toJson(p.formationV2 ?? null),
      toJson(p.armyEquips ?? null),
      toJson(p.newArmyEquips ?? null),
      toJson(p.enigmas ?? null),
      toJson(p.CTCs ?? null),
      toJson(p.armyMastery ?? null),
      toJson(p.effectSkins ?? null),
      toJson(p.effectDecorations ?? null),
      toJson(p.traps ?? null),
      toJson(p.allStandings ?? null),
    );
  });

  // units + unit_instances
  const uStmt = db.prepare(`INSERT INTO side_units (
    report_id, side, seq, army_id, is_extra, max_power, max_shield, max_element_power,
    uuid_count, dead_count, is_dead, uid_owner, uuids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const iStmt = db.prepare(
    `INSERT OR IGNORE INTO unit_instances (uuid, report_id, side, army_id, is_dead) VALUES (?,?,?,?,?)`,
  );
  (s.units || []).forEach((u, seq) => {
    const uuids = u.uuids || [];
    const deadCount = uuids.filter((x) => x && x.isDead).length;
    uStmt.run(
      reportId,
      sideKey,
      seq,
      toInt(u.armyId),
      toInt(u.isExtra),
      toReal(u.maxPower),
      toReal(u.maxShield),
      toInt(u.maxElementPower),
      uuids.length,
      deadCount,
      toInt(u.isDead),
      u.uid != null ? String(u.uid) : null,
      toJson(uuids),
    );
    for (const x of uuids)
      if (x && x.uuid != null)
        iStmt.run(String(x.uuid), reportId, sideKey, toInt(u.armyId), toInt(x.isDead));
  });
}

function insertEvents(db, reportId, process) {
  const stmt = db.prepare(`INSERT INTO battle_events (
    report_id, idx, t, source, target, val, self_val, power, skill, hero, buff_id, tl, raw,
    kind, outcome, act_type, e_type, e_value, old_hit, trigger_type, ev_id, targets, nums, buff_src)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  process.forEach((p, idx) => {
    const ref = buffRefOf(p);
    stmt.run(
      reportId,
      idx,
      toInt(p.t),
      p.source != null ? String(p.source) : null,
      p.target != null ? String(p.target) : null,
      toInt(p.val),
      toInt(p.selfVal),
      toInt(p.power),
      toInt(p.skill),
      toInt(p.hero),
      toInt(ref.id), // buff_id：字段优先、val 兜底解析出的正确 effect_buff id（含漏收的增益/损益/控制状态）
      toInt(p.tl),
      toJson(p),
      kindOf(p.t),
      outcomeOf(p.actType),
      toInt(p.actType),
      toInt(p.eType),
      toInt(p.eValue),
      toInt(p.oldHit),
      toInt(p.triggerType),
      toInt(p.id),
      // targets/nums 在实测战报里是逗号分隔字符串（targets 是 64 位单位 uuid，必须按 TEXT 保真，
      // 绝不能 Number 洗精度）；也兼容数组形态（则 JSON 落库）。缺省则 null。
      p.targets != null ? (Array.isArray(p.targets) ? toJson(p.targets) : String(p.targets)) : null,
      p.nums != null ? (Array.isArray(p.nums) ? toJson(p.nums) : String(p.nums)) : null,
      ref.src,
    );
  });
}

/** Accumulate per-player profile (no win/loss attribution until result semantics confirmed). */
function upsertPlayers(db, reportId, b, logtime) {
  const stmt = db.prepare(`INSERT INTO players (
    uid, name, first_seen, last_seen, power_latest, power_peak,
    battles_att, battles_def, troops_dead, troops_wounded)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET
      name=COALESCE(excluded.name, players.name),
      first_seen=MIN(COALESCE(players.first_seen, excluded.first_seen), excluded.first_seen),
      last_seen=MAX(COALESCE(players.last_seen, 0), excluded.last_seen),
      power_latest=excluded.power_latest,
      power_peak=MAX(COALESCE(players.power_peak, 0), excluded.power_peak),
      battles_att=players.battles_att + excluded.battles_att,
      battles_def=players.battles_def + excluded.battles_def,
      troops_dead=players.troops_dead + excluded.troops_dead,
      troops_wounded=players.troops_wounded + excluded.troops_wounded`);
  const nameOf = (s) => {
    const pi = s?.players?.[0] && parsePlayerInfo(s.players[0].playerInfo);
    return pi && (pi.username || pi.nickname) ? String(pi.username || pi.nickname) : null;
  };
  const upd = (s, isAtt, power) => {
    if (!s || s.uid == null || String(s.uid) === '0') return;
    const st = s.allStandings || {};
    stmt.run(
      String(s.uid),
      nameOf(s),
      toInt(logtime),
      toInt(logtime),
      toReal(power),
      toReal(power),
      isAtt ? 1 : 0,
      isAtt ? 0 : 1,
      toInt(st.dead) || 0,
      toInt(st.wounded) || 0,
    );
  };
  const fm = (b.fightMarches || [])[0] || {};
  upd(b.attacker, true, fm.attPower ?? b.attacker?.units?.[0]?.maxPower ?? null);
  upd(b.defender, false, fm.defPower ?? b.defender?.units?.[0]?.maxPower ?? null);
}

/**
 * Parse one already-fetched report into the structured tables.
 * @param {import('better-sqlite3').Database} db
 * @param {any} cfg
 * @param {string} reportId
 * @returns {{ reportId:string, counts:object }}
 */
export function parseReport(db, cfg, reportId) {
  const id = String(reportId);
  const abs = join(cfg._paths.rawDir, rawRelPath(id));
  const body = JSON.parse(readFileSync(abs, 'utf8'));
  const b = body.battle;
  if (!b) throw new Error(`report ${id} has no battle object`);

  const run = db.transaction(() => {
    clearParsed(db, id);
    insertMarches(db, id, b.fightMarches || []);
    insertSide(db, id, 'att', b.attacker);
    insertSide(db, id, 'def', b.defender);
    insertEvents(db, id, b.process || []);
    upsertPlayers(db, id, b, body.logtime);
    normalizeReport(db, cfg, id);
    // 解析所用字典版本随行（schema 原则：每个解析产物都带 dict_version）。
    // 不补这一笔，新解析的场次会一直是 NULL，要到下一次 `cli.js dict` 才被回填，中间无法复现解码口径。
    const ver = currentDictVersion(db);
    db.prepare(
      'UPDATE reports SET parsed_at = ?, dict_version = COALESCE(?, dict_version) WHERE report_id = ?',
    ).run(Date.now(), ver, id);
  });
  run();

  const c = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE report_id = ?`).get(id).c;
  const counts = {
    marches: c('battle_marches'),
    sides: c('sides'),
    players: c('side_players'),
    units: c('side_units'),
    instances: c('unit_instances'),
    events: c('battle_events'),
    buffEffects: c('buff_effects'),
  };
  log.info('parsed %s -> %j', id, counts);
  return { reportId: id, counts };
}
