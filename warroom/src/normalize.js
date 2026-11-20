// Phase 2c normalizer: turn every buff/attribute-bearing loadout view into one normalized
// row per buff in `buff_effects`, each tagged with its source_view so Phase 3 aggregation can
// split by source and never double-count the same effect that also bubbles up into
// side.effectBuffs. Numeric "attribute codes" (mecha chip rndAttrs, hero equip templateId,
// hero talent) all reduce to an effect_buff id — that unification is the whole point here.
//
// It also enriches the stored loadout JSON blobs (mechas / hero_list / enigmas /
// effect_decorations) in place with resolved Chinese names, keeping their structure.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLog } from './log.js';
import { rawRelPath } from './link.js';
import { toJson, toInt } from './db.js';
import { currentDictVersion, buffSemantics, resolveName, localeText } from './dict.js';
import { buffSourceView } from './buff-source.js';

const log = createLog('NORMALIZE');

/** source_view labels — single source of truth for the normalized buff ledger. */
export const VIEWS = {
  SIDE_EFFECT_BUFFS: 'side_effect_buffs', // 无来源标签的 effectBuffs 聚合账；仅作 traceEffectBuffs 缺失时的回退（二者按 buff_id 汇总逐 id 相等，勿与 trace:* 同时纳入聚合）
  MECHA_CHIP: 'mecha_chip',
  HERO_TALENT: 'hero_talent',
  HERO_EQUIP: 'hero_equip',
  HERO_EQUIP_STONE: 'hero_equip_stone', // 魔石：泰坦装备特殊效果 (hero_equip_skill_rd_library)
  ENIGMA_BEAST: 'enigma_beast',
  ENIGMA_FIELD: 'enigma_field',
  DECORATION_SUBLIME: 'decoration_sublime',
  DECORATION_EXP: 'decoration_exp',
  FORMATION_LEVEL: 'formation_level', // 军阵等级 → formationV2_level.buff_group_*
  FORMATION_QUALITY: 'formation_quality', // 军阵品质 → formationV2_quality.buff_group_*
  FORMATION_SCIENCE: 'formation_science', // 兵种系科技 → formationV2_science(group,level).buff_group
  FORMATION_MASTERY: 'formation_mastery', // 站位精通 → formationV2_mastery(id,position).mastery_buff 池[level]
  SKIN_CASTLE: 'skin_castle', // 城市(城堡)皮肤 → castle_effect.own_buff/equip_buff
  SKIN_MARCH: 'skin_march', // 行军皮肤 → march_skin
  SKIN_HALO: 'skin_halo', // 光环 → castle_halo
  SKIN_HEADFRAME: 'skin_headframe', // 头像框 → dress_headframe
  SKIN_EFFECT: 'skin_effect', // 特效皮肤(分等级) → skin.own_buff/equip_buff + skin_level
  SKIN_EXHIBITION: 'skin_exhibition', // 展览 → skin_exhibition.buff
  ARMY_MASTERY: 'army_mastery', // 兵种精通 armyMastery{army:id} → enhance_mastery(id).buff
  CROSS_COLLECTION: 'cross_collection', // 跨服收藏 CTCs.collects{id,lv} → cross_treasure_collection_level(spec,level).buff
  DECORATION_SUIT: 'decoration_suit', // 装饰物套装 → decoration_contents(suitId).buff/set_buff，等级取 suitLevelBuff
  MECHA_SKILL: 'mecha_skill', // 机甲技能 mechas[].skillIds → Mecha_skill.effect+para
  // 注：side.traceEffectBuffs 是服务端权威"增益表"，按来源码 s 归一为 `trace:<来源名>` 视图
  // （见 buff-source.js），Phase 3 归因优先用它；上面各配置表视图是"有哪些具体编配件"的补充。
};

/** Row cache over dict_entries for one version, so hot loops hit SQLite at most once per key. */
function makeRowGetter(db, version) {
  const stmt = db.prepare(
    'SELECT value FROM dict_entries WHERE dict_version=? AND category=? AND key=?',
  );
  /** @type {Map<string, any>} */
  const cache = new Map();
  return (table, id) => {
    if (id == null || id === '') return null;
    const ck = `${table}|${id}`;
    if (cache.has(ck)) return cache.get(ck);
    let row = null;
    const r = stmt.get(version, `table:${table}`, String(id));
    if (r) {
      try {
        row = JSON.parse(r.value);
      } catch {
        row = null;
      }
    }
    cache.set(ck, row);
    return row;
  };
}

/** Split a '|'-joined numeric pool; non-array input -> []. */
const poolOf = (s) =>
  String(s ?? '')
    .split('|')
    .filter(Boolean);

/** Defensive array coercion: report containers are not always arrays (may be {} / number). */
const arr = (x) => (Array.isArray(x) ? x : []);

/** mechas is an array; mechas2 is an OBJECT keyed by index (e.g. {"2":[mecha,...]}) — flatten both. */
function mechasFlat(s) {
  const m2 = s?.mechas2;
  const extra = Array.isArray(m2) ? m2 : m2 && typeof m2 === 'object' ? Object.values(m2) : [];
  return [...arr(s?.mechas), ...extra.flatMap(arr)];
}

/**
 * Load a whole dict table (by category) into a Map keyed by PK id, cached per table.
 * Needed for 军阵 sub-tables whose lookup key is a composite (formationV2_id + level/position),
 * not the PK, so we scan values rather than address by getRow.
 */
function makeTableLoader(db, version) {
  const stmt = db.prepare(
    'SELECT key, value FROM dict_entries WHERE dict_version = ? AND category = ?',
  );
  /** @type {Map<string, Map<string, any>>} */
  const cache = new Map();
  return (table) => {
    if (cache.has(table)) return cache.get(table);
    /** @type {Map<string, any>} */
    const map = new Map();
    for (const r of stmt.all(version, `table:${table}`)) {
      try {
        map.set(r.key, JSON.parse(r.value));
      } catch {
        /* skip malformed */
      }
    }
    cache.set(table, map);
    return map;
  };
}

/** Find the single row in a loaded table whose `match(row)` returns true. */
function findRow(tableMap, match) {
  for (const row of tableMap.values()) if (match(row)) return row;
  return null;
}

/**
 * Parse a "group" buff string → [{pos, buff, val}].
 * Format (formationV2_level/quality/science buff_group[_inside|_outside]):
 *   "pos=buffid,val|buffid,val;pos=..."  — ';' splits positions, '=' separates pos, '|' splits buffs, ',' id/val.
 * A segment without '=' (e.g. quality buff_group_outside "id,val|id,val") yields pos=null.
 */
function parseGroupBuffs(str) {
  const res = [];
  for (const seg of String(str ?? '')
    .split(';')
    .filter(Boolean)) {
    let pos = null;
    let body = seg;
    if (seg.includes('=')) {
      const [p, b] = seg.split('=');
      pos = p;
      body = b;
    }
    for (const one of body.split('|')) {
      if (!one) continue;
      const [buff, val] = one.split(',');
      res.push({ pos, buff, val });
    }
  }
  return res;
}

/**
 * Parse a "mastery" buff string → [{buff, val}].
 * Format (formationV2_mastery_buff.buff_group_inside): "buffid|val,buffid|val" — ',' splits buffs, '|' id/val.
 */
function parseMasteryBuffs(str) {
  const res = [];
  for (const one of String(str ?? '')
    .split(',')
    .filter(Boolean)) {
    const [buff, val] = one.split('|');
    res.push({ buff, val });
  }
  return res;
}

/**
 * Parse a "pair" buff string → [{buff, val}].
 * Format (skin/castle_effect/march_skin equip_buff/own_buff): "buffid,val|buffid,val" — '|' splits buffs, ',' id/val.
 * (Opposite separator to parseMasteryBuffs; using the wrong one yields swapped buff/value.)
 */
function parsePairBuffs(str) {
  const res = [];
  for (const one of String(str ?? '')
    .split('|')
    .filter(Boolean)) {
    const [buff, val] = one.split(',');
    res.push({ buff, val });
  }
  return res;
}

/** Per-(side,player_seq,source_view) sequence counter so PK stays unique. */
function makeSeq() {
  const c = new Map();
  return (key) => {
    const n = (c.get(key) ?? 0) + 1;
    c.set(key, n);
    return n;
  };
}

/**
 * Collect normalized buff rows for one report across all loadout views.
 * @returns {object[]} rows shaped for the buff_effects INSERT
 */
export function collectBuffEffects(db, version, getRow, reportId, b) {
  const rows = [];
  const nextSeq = makeSeq();
  const loadTable = makeTableLoader(db, version);
  const nameOf = (id) => (id == null ? null : (buffSemantics(db, version, id)?.name ?? null));

  /** push one row, resolving effect_buff semantics once. `over` overrides fields (e.g. 魔石). */
  const push = (side, playerSeq, view, itemRef, attrSlot, buffId, rawValue, over = {}) => {
    const sem = over.noSem || buffId == null ? null : buffSemantics(db, version, buffId);
    const key = `${side}|${playerSeq}|${view}`;
    rows.push({
      report_id: reportId,
      side,
      player_seq: playerSeq,
      source_view: view,
      seq: nextSeq(key),
      item_ref: itemRef == null ? null : String(itemRef),
      attr_slot: attrSlot == null ? null : String(attrSlot),
      buff_id: buffId == null ? null : Number(buffId),
      name: over.name !== undefined ? over.name : (sem?.name ?? nameOf(buffId)),
      raw_value: rawValue == null ? null : toInt(rawValue),
      value_type: over.value_type !== undefined ? over.value_type : (sem?.value_type ?? null),
      category: sem?.category ?? null,
      type: sem?.type ?? null,
      target: sem?.target ?? null,
      para_type1: over.para_type1 !== undefined ? over.para_type1 : (sem?.para_type1 ?? null),
      para1: over.para1 !== undefined ? over.para1 : (sem?.para1 ?? null),
      dict_version: version,
    });
  };

  for (const [sideKey, s] of [
    ['att', b.attacker],
    ['def', b.defender],
  ]) {
    if (!s) continue;

    // 服务端权威"增益表"：side.traceEffectBuffs[] = {id(effect_buff), s(来源码), val}。它是
    // side.effectBuffs 的"带来源标签完整版"——实测同一 side 内按 buff_id 聚合，两者逐 id 数值完全相等
    // (16 side 全等，无 eb_only / trace_only)，即 effectBuffs 就是 traceEffectBuffs 去掉 s 的 id 汇总。
    // 因此优先按来源码 s 归一为 `trace:<来源名>` 视图（觉醒经 need_add_buff→HERO_SKILL 落此，机甲落
    // MECHA，装饰/皮肤/精通/收藏/异能兽/军阵/科学… 各有其码）；effect_buff 的 name/type/target/para 已含
    // 按军种(陆/海/空)与进攻/防守的作用域，无需另设条件列。
    // 仅当战报缺 traceEffectBuffs 时才回退到无来源标签的 side_effect_buffs 聚合视图——否则同一数值会
    // 在两张视图里被 Phase 3 汇总重复计入(见文件头"按来源拆分不双计"契约)。
    const traceRows = arr(s.traceEffectBuffs);
    if (traceRows.length) {
      for (const t of traceRows) {
        const buffId = t?.id ?? t?.bufid;
        if (buffId == null) continue;
        // 来源码 s 恒为数字(实测 3618/3618)。防御：null/空串/纯空白不静默洗成 DONT_USE(码 0)，
        // 非整数(NaN/浮点)如实跳过；>138 的新来源仍保留为 trace:UNKNOWN_<code> 以便回溯。
        const raw = t.s;
        if (raw == null || String(raw).trim() === '') continue;
        const code = Number(raw);
        if (!Number.isInteger(code)) continue;
        push(sideKey, 0, buffSourceView(code), null, null, buffId, t.val ?? t.value);
      }
    } else {
      // 回退账：老战报/无 trace 的 side，用无来源标签的 effectBuffs 聚合（player_seq 0）。
      for (const e of arr(s.effectBuffs)) {
        const buffId = e?.bufid ?? e?.id;
        if (buffId == null) continue;
        push(sideKey, 0, VIEWS.SIDE_EFFECT_BUFFS, null, null, buffId, e.value ?? e.val);
      }
    }

    // mecha chips: rndAttrs code = index into Mecha_chip[chipId].chip_buff_rd pool
    for (const m of mechasFlat(s)) {
      for (const chip of arr(m?.chips)) {
        const pool = poolOf(getRow('Mecha_chip', chip?.chipId)?.chip_buff_rd);
        for (const pair of String(chip?.rndAttrs ?? '')
          .split('|')
          .filter(Boolean)) {
          const [code, val] = pair.split(';');
          push(sideKey, 0, VIEWS.MECHA_CHIP, chip.chipId, code, pool[Number(code)] ?? null, val);
        }
      }
    }

    // mecha skills: Mecha_skill[id].effect ('|'-joined buff ids) zipped with .para ('|'-joined values).
    // 源码实证(RealMechaController)：effect_buff_type 只是拼到 effect buff id 后的"聚合键后缀"(o[effect+type]
    // 累加)，不是跳过标志；type==4&&effect=="1" 才是维修技能。此处仅对 effect 解析不出 effect_buff 的行
    // (如 type==3 授予的 hero_skill id)跳过，避免把技能 id 误当属性 buff；机甲属性权威总账见 trace:MECHA。
    {
      const seen = new Set();
      for (const m of mechasFlat(s)) {
        for (const sid of arr(m?.skillIds)) {
          const sk = getRow('Mecha_skill', sid);
          if (!sk || Number(sk.effect_buff_type) === 3) continue;
          const buffs = poolOf(sk.effect);
          const vals = poolOf(sk.para);
          buffs.forEach((bid, i) => {
            const k = `${sid}|${bid}|${vals[i] ?? ''}`;
            if (seen.has(k)) return;
            seen.add(k);
            push(sideKey, 0, VIEWS.MECHA_SKILL, sid, null, bid, vals[i] ?? null);
          });
        }
      }
    }

    // player-level views
    arr(s.players).forEach((p, playerSeq) => {
      for (const hero of arr(p?.heroList)) {
        const hid = hero?.id ?? hero?.heroId;
        for (const t of arr(hero?.talents)) {
          const buffId = getRow('talent', t?.talentId)?.buff ?? null;
          push(sideKey, playerSeq, VIEWS.HERO_TALENT, hid, t?.talentId, buffId, t?.ttsr);
        }
        for (const eq of arr(hero?.heroEquips)) {
          for (const info of arr(eq?.infos)) {
            if (Number(info?.type) === 2) {
              // 魔石：泰坦装备特殊效果，走 hero_equip_skill_rd_library（非 effect_buff）
              const lib = getRow('hero_equip_skill_rd_library', info?.templateId);
              push(
                sideKey,
                playerSeq,
                VIEWS.HERO_EQUIP_STONE,
                eq?.equipId,
                info?.templateId,
                null,
                lib?.buff_value ?? null,
                {
                  noSem: true,
                  name: lib
                    ? resolveName(db, version, 'hero_equip_skill_rd_library', info?.templateId)
                    : null,
                  para1: lib?.skill_id != null ? String(lib.skill_id) : null,
                },
              );
              continue;
            }
            const rd = getRow('hero_equip_buff_rd', info?.templateId);
            push(
              sideKey,
              playerSeq,
              VIEWS.HERO_EQUIP,
              eq?.equipId,
              `${info?.templateId}:${info?.type}`,
              rd?.buff_id ?? null,
              info?.buffValue,
            );
          }
        }
      }
      const en = p?.enigmas;
      for (const bd of arr(en?.beastDatas)) {
        push(sideKey, playerSeq, VIEWS.ENIGMA_BEAST, bd?.cfg, 'main', bd?.mainBuff ?? null, null);
        arr(bd?.baseBuff).forEach((id, i) =>
          push(sideKey, playerSeq, VIEWS.ENIGMA_BEAST, bd.cfg, `base${i}`, id ?? null, null),
        );
      }
      for (const field of arr(en?.fields)) {
        for (const slot of arr(field?.slots)) {
          arr(slot?.buffs).forEach((bf, i) =>
            push(
              sideKey,
              playerSeq,
              VIEWS.ENIGMA_FIELD,
              slot?.id,
              i,
              bf?.id ?? null,
              bf?.val ?? bf?.value,
            ),
          );
        }
      }
      const ed = p?.effectDecorations;
      for (const sub of arr(ed?.sublimes)) {
        arr(sub?.buffs).forEach((bf, i) =>
          push(
            sideKey,
            playerSeq,
            VIEWS.DECORATION_SUBLIME,
            sub?.id,
            i,
            bf?.buffId ?? bf?.id ?? null,
            bf?.value ?? bf?.val,
          ),
        );
      }
      arr(ed?.sublimeExps).forEach((bf, i) =>
        push(
          sideKey,
          playerSeq,
          VIEWS.DECORATION_EXP,
          null,
          i,
          bf?.id ?? null,
          bf?.val ?? bf?.value,
        ),
      );

      // 军阵 formationV2: lv/quality/science/mastery 四路子表 → buff_effects。
      // 同一 buff 在多个站位重复，按 (view, scope, buff, val) 去重防膨胀。
      const fm = p?.formationV2;
      if (fm && fm.id != null) {
        const fseen = new Set();
        const fpush = (view, itemRef, scope, buffId, val) => {
          const k = `${view}|${scope ?? ''}|${buffId ?? ''}|${val ?? ''}`;
          if (fseen.has(k)) return;
          fseen.add(k);
          push(sideKey, playerSeq, view, itemRef, scope, buffId, val);
        };
        const fid = String(fm.id);
        // 1) 等级
        const lvRow = findRow(
          loadTable('formationV2_level'),
          (r) => String(r.formationV2_id) === fid && String(r.level) === String(fm.lv),
        );
        for (const src of ['buff_group_inside', 'buff_group_outside']) {
          for (const g of parseGroupBuffs(lvRow?.[src]))
            fpush(VIEWS.FORMATION_LEVEL, fid, null, g.buff, g.val);
        }
        // 2) 品质
        const qRow = findRow(
          loadTable('formationV2_quality'),
          (r) => String(r.formationV2_id) === fid && String(r.level) === String(fm.quality),
        );
        for (const src of ['buff_group_inside', 'buff_group_outside']) {
          for (const g of parseGroupBuffs(qRow?.[src]))
            fpush(VIEWS.FORMATION_QUALITY, fid, null, g.buff, g.val);
        }
        // 3) 兵种系科技：group=兵种系(ArmyType)，保留 group 作归因维度
        const sciTable = loadTable('formationV2_science');
        for (const [grp, lv] of Object.entries(fm.sciences ?? {})) {
          const sRow = findRow(
            sciTable,
            (r) => String(r.group) === String(grp) && String(r.level) === String(lv),
          );
          for (const g of parseGroupBuffs(sRow?.buff_group))
            fpush(VIEWS.FORMATION_SCIENCE, grp, grp, g.buff, g.val);
        }
        // 4) 站位精通：mastery_buff 池[level] → formationV2_mastery_buff（池下标，同芯片机制）
        const masTable = loadTable('formationV2_mastery');
        const mbTable = loadTable('formationV2_mastery_buff');
        for (const [pos, lv] of Object.entries(fm.masterys ?? {})) {
          const mRow = findRow(
            masTable,
            (r) => String(r.formationV2_id) === fid && String(r.position) === String(pos),
          );
          if (!mRow) continue;
          const pool = poolOf(mRow.mastery_buff);
          const bid = pool[Number(lv)];
          const mb = bid ? mbTable.get(String(bid)) : null;
          const masName = localeText(db, version, mRow.mastery_name) ?? mRow.mastery_name ?? pos;
          // scope = 技能名（站位只是同一技能的实例，按技能去重避免跨站位冗余）
          const scope = String(masName);
          for (const g of parseMasteryBuffs(mb?.buff_group_inside))
            fpush(VIEWS.FORMATION_MASTERY, scope, scope, g.buff, g.val);
          for (const g of parseMasteryBuffs(mb?.buff_group_outside))
            fpush(VIEWS.FORMATION_MASTERY, scope, scope, g.buff, g.val);
        }
      }

      // ---- 皮肤 / 兵种精通 / 跨服收藏 / 装饰物套装 ----
      const lseen = new Set();
      const lpush = (view, itemRef, slot, buffId, val) => {
        const k = `${view}|${itemRef ?? ''}|${slot ?? ''}|${buffId ?? ''}|${val ?? ''}`;
        if (lseen.has(k)) return;
        lseen.add(k);
        push(sideKey, playerSeq, view, itemRef, slot, buffId, val);
      };
      // 皮肤：own* 列表取 own_buff，use* 列表取 equip_buff（attr_slot 标 own/equip 供分列，避免混淆拥有/装备）
      const skin = p?.effectSkins;
      if (skin) {
        const emitSkin = (view, ids, table, kind) => {
          for (const id of arr(ids)) {
            const r = getRow(table, id);
            if (!r) continue;
            for (const g of parsePairBuffs(kind === 'own' ? r.own_buff : r.equip_buff))
              lpush(view, id, kind, g.buff, g.val);
          }
        };
        emitSkin(VIEWS.SKIN_CASTLE, skin.ownCastleEffects, 'castle_effect', 'own');
        emitSkin(VIEWS.SKIN_CASTLE, skin.useCastleEffects, 'castle_effect', 'equip');
        emitSkin(VIEWS.SKIN_MARCH, skin.ownMarchSkins, 'march_skin', 'own');
        emitSkin(VIEWS.SKIN_MARCH, skin.useMarchSkins, 'march_skin', 'equip');
        emitSkin(VIEWS.SKIN_HALO, skin.ownHaloSkins, 'castle_halo', 'own');
        emitSkin(VIEWS.SKIN_HALO, skin.useHaloSkins, 'castle_halo', 'equip');
        emitSkin(VIEWS.SKIN_HEADFRAME, skin.ownHeadframes, 'dress_headframe', 'own');
        emitSkin(VIEWS.SKIN_EFFECT, skin.effectIds, 'skin', 'own');
        emitSkin(VIEWS.SKIN_EFFECT, skin.useIds, 'skin', 'equip');
        for (const id of arr(skin.exhibitions)) {
          for (const g of parseMasteryBuffs(getRow('skin_exhibition', id)?.buff))
            lpush(VIEWS.SKIN_EXHIBITION, id, 'exhibit', g.buff, g.val);
        }
      }
      // 兵种精通 armyMastery{armyType:enhanceMasteryId}：value 即 enhance_mastery 的 PK，buff 为 mastery 式
      for (const [army, mid] of Object.entries(p?.armyMastery ?? {})) {
        const r = getRow('enhance_mastery', mid);
        for (const g of parseMasteryBuffs(r?.buff))
          lpush(VIEWS.ARMY_MASTERY, army, r?.level ?? null, g.buff, g.val);
      }
      // 跨服收藏 CTCs.collects{id,lv} → cross_treasure_collection_level(collection_spec_id,level) 复合键（全表扫描）
      {
        const clTable = loadTable('cross_treasure_collection_level');
        for (const c of arr(p?.CTCs?.collects)) {
          const r = findRow(
            clTable,
            (x) =>
              String(x.collection_spec_id) === String(c.id) && String(x.level) === String(c.lv),
          );
          for (const g of parseMasteryBuffs(r?.buff))
            lpush(VIEWS.CROSS_COLLECTION, c.id, c.lv, g.buff, g.val);
        }
      }
      // 装饰物套装 suit 列表 + suitLevelBuff 等级 → decoration_contents.buff/set_buff（mastery 式）
      {
        const lvlMap = p?.effectDecorations?.suitLevelBuff ?? {};
        for (const sid of arr(p?.effectDecorations?.suit)) {
          const r = getRow('decoration_contents', sid);
          const sLv = lvlMap[sid] ?? null;
          for (const src of ['buff', 'set_buff'])
            for (const g of parseMasteryBuffs(r?.[src]))
              lpush(VIEWS.DECORATION_SUIT, sid, sLv, g.buff, g.val);
        }
      }
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Loadout JSON enrichment — annotate the stored blobs with resolved names while
// keeping the original structure (the buff_effects table is the queryable ledger).
// ---------------------------------------------------------------------------

function enrichMechas(db, version, getRow, mechas) {
  return arr(mechas).map((m) => ({
    ...m,
    _partsNames: arr(m?.parts).map((pid) => resolveName(db, version, 'Mecha_part', pid)),
    _chips: arr(m?.chips).map((chip) => {
      const pool = poolOf(getRow('Mecha_chip', chip?.chipId)?.chip_buff_rd);
      return {
        ...chip,
        _name: resolveName(db, version, 'Mecha_chip', chip?.chipId),
        _attrs: String(chip?.rndAttrs ?? '')
          .split('|')
          .filter(Boolean)
          .map((pair) => {
            const [code, val] = pair.split(';');
            const buffId = pool[Number(code)];
            return {
              code,
              value: toInt(val),
              buff_id: buffId ? Number(buffId) : null,
              name: buffSemantics(db, version, buffId)?.name ?? null,
            };
          }),
      };
    }),
  }));
}

/** mechas2 is an OBJECT keyed by index ({"2":[mecha,...]}); preserve that shape while enriching. */
function enrichMechasMap(db, version, getRow, m2) {
  if (Array.isArray(m2)) return enrichMechas(db, version, getRow, m2);
  if (m2 && typeof m2 === 'object') {
    const o = {};
    for (const k of Object.keys(m2)) o[k] = enrichMechas(db, version, getRow, m2[k]);
    return o;
  }
  return null;
}

function enrichHeroes(db, version, getRow, loadTable, heroList) {
  // 觉醒索引：hero_awakening_skill 主键是 id，但战报 awakenSkillMap 的 key 是 awakening_skill_id 列，
  // 且每个 awakening_skill_id 按 skill_level 有多行——故按 (awakening_skill_id|skill_level) 建行→行 映射。
  const awIdx = new Map();
  for (const r of loadTable('hero_awakening_skill').values())
    awIdx.set(`${r.awakening_skill_id}|${r.skill_level}`, r);
  const skillName = (id) => resolveName(db, version, 'hero_skill', id);
  return arr(heroList).map((h) => ({
    ...h,
    _name: resolveName(db, version, 'hero', h?.id ?? h?.heroId),
    // 觉醒：awakenSkillMap{awakening_skill_id:{level}} 逐级解到 hero_awakening_skill 行。属性数值经
    // need_add_buff 授予的 hero_skill 落入权威 trace(HERO_SKILL)；此处保留"哪个觉醒技能/等级/战力/描述"。
    _awakenSkills: Object.entries(h?.awakenSkillMap ?? {}).map(([sid, v]) => {
      const r = awIdx.get(`${sid}|${v?.level}`);
      return {
        awakening_skill_id: Number(sid),
        level: v?.level ?? null,
        slot: r?.skill_num ?? null,
        hero_skill_id: r?.hero_skill_id ?? null,
        hero_skill_name: r ? skillName(r.hero_skill_id) : null,
        need_add_buff: r?.need_add_buff ?? null,
        need_add_buff_names: r ? poolOf(r.need_add_buff).map((id) => skillName(id)) : null,
        desc1: r ? (localeText(db, version, r.skill_desc1) ?? r.skill_desc1 ?? null) : null,
        num1: r?.skill_num1 ?? null,
        desc2: r ? (localeText(db, version, r.skill_desc2) ?? r.skill_desc2 ?? null) : null,
        num2: r?.skill_num2 ?? null,
        fight_pewer: r?.skill_fight_pewer ?? null,
        team_fight_pewer: r?.skill_team_fight_pewer ?? null,
      };
    }),
    _talents: arr(h?.talents).map((t) => {
      const row = getRow('talent', t?.talentId);
      return {
        ...t,
        buff_id: row?.buff ?? null,
        name:
          buffSemantics(db, version, row?.buff)?.name ??
          resolveName(db, version, 'talent', t?.talentId),
      };
    }),
    _nonActiveSkills: arr(h?.nonActiveSkills).map((s) => ({
      ...s,
      name: resolveName(db, version, 'hero_skill', s?.skillId),
    })),
    _equips: arr(h?.heroEquips).map((eq) => ({
      ...eq,
      _infos: arr(eq?.infos).map((info) => {
        if (Number(info?.type) === 2) {
          const lib = getRow('hero_equip_skill_rd_library', info?.templateId);
          return {
            ...info,
            kind: 'stone',
            skill_id: lib?.skill_id ?? null,
            // 魔石等级＝星级（lib.star，1/2/3…）；star_max 为该模板满星。切勿用 buff_value 当等级（那是技能威力参考）。
            star: lib?.star ?? null,
            starMax: lib?.star_max ?? null,
            color: lib?.buff_value_color ?? null,
            name: lib
              ? resolveName(db, version, 'hero_equip_skill_rd_library', info?.templateId)
              : null,
          };
        }
        const rd = getRow('hero_equip_buff_rd', info?.templateId);
        return {
          ...info,
          kind: 'attr',
          buff_id: rd?.buff_id ?? null,
          name: buffSemantics(db, version, rd?.buff_id)?.name ?? null,
        };
      }),
    })),
  }));
}

function enrichEnigmas(db, version, enigmas) {
  if (!enigmas) return enigmas;
  const nm = (id) => buffSemantics(db, version, id)?.name ?? null;
  return {
    ...enigmas,
    _beastDatas: arr(enigmas.beastDatas).map((bd) => ({
      ...bd,
      _mainBuffName: nm(bd?.mainBuff),
      _baseBuffNames: arr(bd?.baseBuff).map(nm),
    })),
    _fields: arr(enigmas.fields).map((f) => ({
      ...f,
      _slots: arr(f?.slots).map((sl) => ({
        ...sl,
        _buffs: arr(sl?.buffs).map((bf) => ({ ...bf, name: nm(bf?.id) })),
      })),
    })),
  };
}

/** 军阵 blob 富化：加军阵名与站位→精通技能名（保留原结构）。 */
function enrichFormation(db, version, loadTable, fm) {
  if (!fm || fm.id == null) return fm;
  const fid = String(fm.id);
  const masterys = {};
  const masTable = loadTable('formationV2_mastery');
  for (const [pos, lv] of Object.entries(fm.masterys ?? {})) {
    const mRow = findRow(
      masTable,
      (r) => String(r.formationV2_id) === fid && String(r.position) === String(pos),
    );
    const pool = poolOf(mRow?.mastery_buff);
    const bid = mRow ? pool[Number(lv)] : null;
    const mb = bid ? loadTable('formationV2_mastery_buff').get(String(bid)) : null;
    masterys[pos] = {
      level: lv,
      buff_group: mb?.buff_group_inside ?? null,
      skill: mRow ? (localeText(db, version, mRow.mastery_name) ?? mRow.mastery_name) : null,
    };
  }
  return {
    ...fm,
    _name: resolveName(db, version, 'formationV2', fm.id),
    _masterys: masterys,
  };
}

function enrichDecorations(db, version, getRow, ed) {
  if (!ed) return ed;
  const nm = (id) => buffSemantics(db, version, id)?.name ?? null;
  // 套装：suit 是 decoration_contents 的 id，等级取 suitLevelBuff[suitId]
  const lvlMap = ed.suitLevelBuff ?? {};
  return {
    ...ed,
    _sublimes: arr(ed.sublimes).map((sub) => ({
      ...sub,
      _buffs: arr(sub?.buffs).map((bf) => ({ ...bf, name: nm(bf?.buffId ?? bf?.id) })),
    })),
    _suits: arr(ed.suit).map((sid) => ({
      id: sid,
      level: lvlMap[sid] ?? null,
      _name: resolveName(db, version, 'decoration_contents', sid),
      _buff: getRow('decoration_contents', sid)?.buff ?? null,
    })),
  };
}

/** 皮肤 blob 富化：为 own 与 use 列表标注中文名与皮肤等级（skin 表有 skin_level，其余无）。 */
function enrichSkins(db, version, getRow, sk) {
  if (!sk) return sk;
  const list = (ids, table) =>
    arr(ids).map((id) => ({
      id,
      _name: resolveName(db, version, table, id),
      _level: getRow(table, id)?.skin_level ?? null,
    }));
  return {
    ...sk,
    _ownCastleEffects: list(sk.ownCastleEffects, 'castle_effect'),
    _useCastleEffects: list(sk.useCastleEffects, 'castle_effect'),
    _ownMarchSkins: list(sk.ownMarchSkins, 'march_skin'),
    _useMarchSkins: list(sk.useMarchSkins, 'march_skin'),
    _ownHaloSkins: list(sk.ownHaloSkins, 'castle_halo'),
    _useHaloSkins: list(sk.useHaloSkins, 'castle_halo'),
    _ownHeadframes: list(sk.ownHeadframes, 'dress_headframe'),
    _effectIds: list(sk.effectIds, 'skin'),
    _useIds: list(sk.useIds, 'skin'),
  };
}

/**
 * Collect per-side damage contribution from fightMarches[].{att,def}SkillHurts.
 * effect_buff_hurts{buffId:hurt} → kind 'buff'; skill_hurts{skillId:hurt}+skill_hurt_count → kind 'skill'.
 * Aggregated per (side,kind,ref) across marches. Values may be scientific-notation strings.
 * @returns {any[][]} tuples matching the damage_sources INSERT order.
 */
function collectDamageSources(db, version, reportId, b) {
  const agg = new Map(); // `${side}|${kind}|${ref}` -> { hurt, hits }
  const add = (side, kind, ref, hurt, hits) => {
    if (ref == null) return;
    const k = `${side}|${kind}|${ref}`;
    const cur = agg.get(k) ?? { hurt: 0, hits: 0 };
    cur.hurt += Number(hurt) || 0;
    if (hits != null) cur.hits += Number(hits) || 0;
    agg.set(k, cur);
  };
  for (const fm of arr(b.fightMarches)) {
    for (const [side, key] of [
      ['att', 'attSkillHurts'],
      ['def', 'defSkillHurts'],
    ]) {
      const sh = fm?.[key];
      if (!sh) continue;
      for (const [buffId, hurt] of Object.entries(sh.effect_buff_hurts ?? {}))
        add(side, 'buff', buffId, hurt, null);
      const counts = sh.skill_hurt_count ?? {};
      for (const [skillId, hurt] of Object.entries(sh.skill_hurts ?? {}))
        add(side, 'skill', skillId, hurt, counts[skillId] ?? null);
    }
  }
  const rows = [];
  for (const [k, v] of agg) {
    const [side, kind, ref] = k.split('|');
    const name =
      kind === 'buff'
        ? (buffSemantics(db, version, ref)?.name ?? null)
        : (resolveName(db, version, 'hero_skill', ref) ?? null);
    rows.push([reportId, side, kind, ref, name, v.hurt, kind === 'skill' ? v.hits : null, version]);
  }
  return rows;
}

const BUFF_INS = `INSERT INTO buff_effects (
  report_id, side, player_seq, source_view, seq, item_ref, attr_slot, buff_id, name,
  raw_value, value_type, category, type, target, para_type1, para1, dict_version)
  VALUES (@report_id,@side,@player_seq,@source_view,@seq,@item_ref,@attr_slot,@buff_id,@name,
  @raw_value,@value_type,@category,@type,@target,@para_type1,@para1,@dict_version)`;

/**
 * 富化 battle_events：把回放事件引用的 buff_id / skill / hero 反查成中文名与语义列，
 * 使增益/损益/控制状态（眩晕、沉默、虚弱等）可读、可归因。effect_buff 内部行的 `string` 常为空
 * （无展示名），此时 buff_name 留 NULL 但仍带 type/is_minus/sustained_buff 等码，信息不丢。
 * 在调用方事务内执行，假定 Phase 2a/事件行已插入；只回填 schema v4 新增的富化列。
 */
function enrichBattleEvents(db, version, getRow, reportId) {
  const rows = db
    .prepare(
      `SELECT idx, buff_id, skill, hero FROM battle_events
       WHERE report_id = ? AND (buff_id IS NOT NULL OR skill IS NOT NULL OR hero IS NOT NULL)`,
    )
    .all(reportId);
  if (!rows.length) return 0;
  const upd = db.prepare(
    `UPDATE battle_events SET buff_name=?, buff_type=?, buff_is_minus=?, buff_target=?,
       buff_value_type=?, buff_sustained=?, buff_debuff_time=?, skill_name=?, hero_name=?
     WHERE report_id=? AND idx=?`,
  );
  // 小范围本地缓存：同一 skill/hero id 在多事件里反复出现，避免重复反查。
  const skillCache = new Map();
  const heroCache = new Map();
  const nameOnce = (cache, table, id) => {
    if (id == null) return null;
    if (cache.has(id)) return cache.get(id);
    const nm = resolveName(db, version, table, id);
    cache.set(id, nm);
    return nm;
  };
  for (const r of rows) {
    let bName = null;
    let bType = null;
    let bMinus = null;
    let bTarget = null;
    let bVType = null;
    let bSust = null;
    let bDtime = null;
    if (r.buff_id != null) {
      const e = getRow('effect_buff', r.buff_id);
      if (e) {
        const key = typeof e.string === 'string' && e.string ? e.string : null;
        bName = key ? localeText(db, version, key) || key : null;
        bType = e.type ?? null;
        bMinus = e.is_minus ?? null;
        bTarget = e.target ?? null;
        bVType = e.value_type ?? null;
        bSust =
          e.sustained_buff != null && String(e.sustained_buff).trim() !== ''
            ? Number(e.sustained_buff)
            : null;
        bDtime = e.debuff_para_time ?? null;
      }
    }
    upd.run(
      bName,
      bType,
      bMinus,
      bTarget,
      bVType,
      bSust,
      bDtime,
      nameOnce(skillCache, 'hero_skill', r.skill),
      nameOnce(heroCache, 'hero', r.hero),
      reportId,
      r.idx,
    );
  }
  return rows.length;
}

/**
 * Normalize one report: rebuild its buff_effects ledger + enrich loadout JSON columns.
 * Runs inside the caller's transaction. Assumes Phase 2a rows already inserted.
 */
export function normalizeReport(db, cfg, reportId) {
  const id = String(reportId);
  const abs = join(cfg._paths.rawDir, rawRelPath(id));
  const b = JSON.parse(readFileSync(abs, 'utf8')).battle;
  const version = currentDictVersion(db);
  if (!version) {
    log.warn('no dict version loaded; skip normalize for %s', id);
    return { buffEffects: 0 };
  }
  const getRow = makeRowGetter(db, version);
  const loadTable = makeTableLoader(db, version);

  db.prepare('DELETE FROM buff_effects WHERE report_id = ?').run(id);
  const rows = collectBuffEffects(db, version, getRow, id, b);
  const ins = db.prepare(BUFF_INS);
  for (const r of rows) ins.run(r);

  // 伤害/效果贡献归因：effect_buff_hurts(按 buff) + skill_hurts/skill_hurt_count(按技能)
  db.prepare('DELETE FROM damage_sources WHERE report_id = ?').run(id);
  const dmg = collectDamageSources(db, version, id, b);
  const dIns = db.prepare(
    `INSERT INTO damage_sources (report_id, side, kind, ref, name, hurt, hits, dict_version)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const d of dmg) dIns.run(...d);

  // 回放事件语义富化：buff_id/skill/hero 反查成名称与语义列（含眩晕/沉默/虚弱等状态）
  enrichBattleEvents(db, version, getRow, id);

  // enrich + write back the loadout JSON blobs
  for (const [sideKey, s] of [
    ['att', b.attacker],
    ['def', b.defender],
  ]) {
    if (!s) continue;
    if (s.mechas || s.mechas2) {
      db.prepare('UPDATE sides SET mechas=? WHERE report_id=? AND side=?').run(
        toJson({
          mechas: enrichMechas(db, version, getRow, s.mechas),
          mechas2: enrichMechasMap(db, version, getRow, s.mechas2),
        }),
        id,
        sideKey,
      );
    }
    const upd = db.prepare(
      `UPDATE side_players SET hero_list=?, enigmas=?, effect_decorations=?, formation_v2=?, effect_skins=?
       WHERE report_id=? AND side=? AND seq=?`,
    );
    (s.players ?? []).forEach((p, seq) => {
      if (!p) return;
      upd.run(
        toJson(p.heroList ? enrichHeroes(db, version, getRow, loadTable, p.heroList) : null),
        toJson(p.enigmas ? enrichEnigmas(db, version, p.enigmas) : null),
        toJson(
          p.effectDecorations ? enrichDecorations(db, version, getRow, p.effectDecorations) : null,
        ),
        toJson(p.formationV2 ? enrichFormation(db, version, loadTable, p.formationV2) : null),
        toJson(p.effectSkins ? enrichSkins(db, version, getRow, p.effectSkins) : null),
        id,
        sideKey,
        seq,
      );
    });
  }
  return { buffEffects: rows.length, damageSources: dmg.length };
}
