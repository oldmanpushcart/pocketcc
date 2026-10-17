import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveName, localeText, currentDictVersion } from './dict.js';

// 渲染单场战报的五幕式 HTML：只读 warroom.db → 写出 analysis/<reportId>.html，返回写出路径。
// 不依赖入参 R 以外的全局：db/version/here 均在本函数作，支持批量逐个调用。
export function renderReportHtml(R) {
  const here = dirname(fileURLToPath(import.meta.url));
  const db = new Database(resolve(here, '../data/warroom.db'), { readonly: true });
  const version = currentDictVersion(db);
  const J = (s) => {
    try {
      return s == null ? null : JSON.parse(s);
    } catch {
      return null;
    }
  };
  const fmt = (n) => {
    if (n == null || Number.isNaN(n)) return '-';
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  };
  const pct = (x) => (x == null || !Number.isFinite(x) ? '-' : (x * 100).toFixed(1) + '%');
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  const dictRow = (cat, key) => {
    const r = db
      .prepare(`SELECT value FROM dict_entries WHERE dict_version=? AND category=? AND key=?`)
      .get(version, 'table:' + cat, String(key));
    return r ? J(r.value) : null;
  };
  const cjk = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
  const tryLocale = (k) => {
    if (k == null) return null;
    const s = String(k);
    if (cjk(s)) return s;
    const zh = localeText(db, version, s);
    if (zh && cjk(zh)) return zh;
    // _name ↔ _desc 互换兑底（泰坦装备/英雄技能等 locale 缺 name 时 desc 一定在）
    if (/_name/.test(s)) {
      const zh2 = localeText(db, version, s.replace(/_name/, '_desc'));
      if (zh2 && cjk(zh2)) return zh2;
    }
    return null;
  };
  // 名字 vs 描述判別：带句读（，。、；：！？）或过长的是 buff 描述，不能当属性/状态名用
  const isDescName = (s) => {
    const t = String(s || '');
    return /[，。、；：！？,;:!?]/.test(t) || t.length > 14;
  };
  const okName = (s) => (s && cjk(s) && !isDescName(s) ? s : null);
  const resolveBuffName = (id) => {
    let cur = id;
    const seen = new Set();
    for (let d = 0; d < 3; d++) {
      if (cur == null || seen.has(cur)) break;
      seen.add(cur);
      const row = dictRow('effect_buff', cur);
      if (!row) break;
      const byStr = row.string && tryLocale(row.string);
      if (byStr && !isDescName(byStr)) return byStr;
      if (row.paraType1 === 'SkillId') {
        const skillName = resolveName(db, version, 'hero_skill', row.para1);
        if (skillName && cjk(skillName) && !isDescName(skillName)) return skillName;
      }
      const m =
        typeof row.string === 'string' && /^(?:buff|hero_equip_skill_name)_(\d+)$/.exec(row.string);
      if (m && Number(m[1]) !== Number(cur)) {
        cur = Number(m[1]);
        continue;
      }
      break;
    }
    return null;
  };
  // —— 扩展兜底：Mecha_skill 反向索引 + type-sibling 启发 ——
  const mechaSkillIdx = new Map(); // buff_id → 技能中文名
  for (const r of db
    .prepare(
      `SELECT key,value FROM dict_entries WHERE dict_version=? AND category='table:Mecha_skill'`,
    )
    .all(version)) {
    const row = JSON.parse(r.value);
    if (!row.effect) continue;
    const nm = tryLocale(row.name);
    if (!nm) continue;
    for (const eid of String(row.effect).split('|')) {
      if (!mechaSkillIdx.has(Number(eid))) mechaSkillIdx.set(Number(eid), nm);
    }
  }
  const typeNameCache = new Map(); // effect_buff.type → 首个可解析名
  function resolveBuffNameExt(id) {
    const nm = resolveBuffName(id);
    if (nm) return nm;
    // Mecha_skill 反查
    if (mechaSkillIdx.has(Number(id))) return mechaSkillIdx.get(Number(id));
    // type-sibling: 同 type 找有 SkillId 的兄弟行
    const row = dictRow('effect_buff', id);
    if (row && row.type) {
      const t = String(row.type);
      if (typeNameCache.has(t)) return typeNameCache.get(t);
      const siblings = db
        .prepare(
          `SELECT value FROM dict_entries WHERE dict_version=? AND category='table:effect_buff' LIMIT 2000`,
        )
        .all(version);
      for (const s of siblings) {
        const sr = JSON.parse(s.value);
        if (String(sr.type) === t && sr.paraType1 === 'SkillId') {
          const sn = resolveName(db, version, 'hero_skill', sr.para1);
          if (sn && cjk(sn) && !isDescName(sn)) {
            typeNameCache.set(t, sn);
            return sn;
          }
        }
        if (String(sr.type) === t && sr.string) {
          const sn = tryLocale(sr.string);
          if (sn && !isDescName(sn)) {
            typeNameCache.set(t, sn);
            return sn;
          }
        }
      }
      typeNameCache.set(t, null); // 缓存失败避免重复扫描
    }
    return null;
  }
  // MechaMainChipBuff: buff_id 是 Mecha_chip PK，不是 effect_buff PK
  const resolveChipName = (chipId) => {
    const chip = dictRow('Mecha_chip', chipId);
    if (chip && chip.chip_name) {
      const n = tryLocale(chip.chip_name);
      if (n) return n;
    }
    return null;
  };
  // 通用加成数值格式化：effect_buff.value_type 10000=万分比(÷100→%)、1=绝对值；其余回落原值
  const buffValText = (buffId, raw) => {
    if (raw == null) return null;
    const eb = buffId != null ? dictRow('effect_buff', buffId) : null;
    const vt = eb ? Number(eb.value_type) : null;
    if (vt === 10000) return (raw / 100).toFixed(1) + '%';
    if (vt === 1) return String(Math.round(raw));
    return String(raw);
  };
  const BR = (t) =>
    t === 201 || String(t) === '201' ? '海军' : t === 301 || String(t) === '301' ? '空军' : '陆军';
  const armyNameCache = new Map();
  const armyName = (id) => {
    if (id == null) return '-';
    if (armyNameCache.has(id)) return armyNameCache.get(id);
    const nm = resolveName(db, version, 'army', id) || '#' + id;
    armyNameCache.set(id, nm);
    return nm;
  };
  const armyBranch = (id) => {
    const a = dictRow('army', id);
    return a ? BR(a.type) : '?';
  };
  // 技能描述里的 <id=N> 占位符：复刻 LocalUtils.replaceStr → 查 hero_skill_key_id → getText(power_point)
  // type=3 的 power_point 是字面数值（"1"/"15%"，非 locale 键），type=1 是 locale 键（如 磁暴）；localeText 未命中时回落原值
  const subSkillIds = (s) => {
    if (s == null) return s;
    const str = String(s);
    if (!str.includes('<id=')) return str;
    return str.replace(/<id=(\d+)>/g, (m, id) => {
      const row = dictRow('hero_skill_key_id', id);
      if (!row || row.power_point == null || row.power_point === '') return m;
      return localeText(db, version, row.power_point) ?? String(row.power_point);
    });
  };

  // ── 技能/状态名字↔描述 双向索引 ────────────────────
  // 来源：hero_skill(name↔desc) / formationV2_mastery(mastery_name↔mastery_desc[_new]) / Mecha_skill(name↔desc)
  // 目的：榜单 label 统一展示名字；鼠标停留 title 展示描述。描述串与榜单同用 subSkillIds 回填 <id=>。
  const rowsOf = (cat) =>
    db
      .prepare(`SELECT value FROM dict_entries WHERE dict_version=? AND category=?`)
      .all(version, 'table:' + cat)
      .map((r) => J(r.value));
  const nameToDesc = new Map();
  const descToName = new Map();
  const filledByRaw = new Map(); // 原始描述串 → {n} 回填后的描述
  // 用技能基础 para 回填描述里的 {n}：紧跟 % 的按 ÷100 显示并去尾零，其余按原值；取不到值的保留 {n}
  const fmtNum = (v) => (Number.isFinite(v) ? String(Number(v.toFixed(4))) : null);
  const applyFmt = (str, para) => {
    if (str == null || !/\{\d+\}/.test(str)) return str;
    const arr = String(para ?? '')
      .split('|')
      .map((x) => Number(x));
    if (!arr.some((x) => Number.isFinite(x))) return str;
    return str.replace(/\{(\d+)\}(%?)/g, (m, i, pct) => {
      const v = arr[Number(i)];
      if (!Number.isFinite(v)) return m;
      const s = fmtNum(pct ? v / 100 : v);
      return s == null ? m : s + (pct || '');
    });
  };
  const addPair = (nm, ds, para) => {
    if (!nm || !ds) return;
    const d = subSkillIds(String(ds)).trim();
    const n = String(nm).trim();
    if (!d || !n || d === n) return;
    const filled = applyFmt(d, para);
    if (!nameToDesc.has(n)) nameToDesc.set(n, filled);
    if (!descToName.has(d)) descToName.set(d, n);
    if (!filledByRaw.has(d)) filledByRaw.set(d, filled);
  };
  const loc = (k) => (k == null ? null : localeText(db, version, k));
  for (const r of rowsOf('hero_skill')) addPair(loc(r.name), loc(r.desc), r.para);
  for (const r of rowsOf('formationV2_mastery')) {
    const nm = loc(r.mastery_name);
    addPair(nm, loc(r.mastery_desc));
    addPair(nm, loc(r.mastery_desc_new));
  }
  for (const r of rowsOf('Mecha_skill')) {
    const nm = tryLocale(r.name);
    addPair(nm, tryLocale(r.desc) || tryLocale(r.desc_new));
  }
  // 将一个已解析字符串（可能是名字也可能是描述）归一为 {name, desc}
  // —— 先用 effect_buff 自身把“展示描述”绑回“技能名”（覆盖精通基名/装备技变体等精确匹配漏网的情况）
  const masteryNameByDescKey = new Map();
  for (const r of rowsOf('formationV2_mastery')) {
    const nm = loc(r.mastery_name);
    if (!nm) continue;
    for (const k of [r.mastery_desc, r.mastery_desc_new])
      if (k) {
        const kk = String(k);
        masteryNameByDescKey.set(kk, nm);
        masteryNameByDescKey.set(kk.replace(/_new$/, ''), nm);
      }
  }
  for (const { key, value } of db
    .prepare(
      `SELECT key,value FROM dict_entries WHERE dict_version=? AND category='table:effect_buff'`,
    )
    .all(version)) {
    const row = J(value);
    if (!row || !row.string) continue;
    const disp = tryLocale(row.string);
    if (!disp || !cjk(disp) || String(disp).length <= 12) continue; // 短串视为名字，不处理
    const nm =
      (row.paraType1 === 'SkillId' ? resolveName(db, version, 'hero_skill', row.para1) : null) ||
      masteryNameByDescKey.get(String(row.string)) ||
      masteryNameByDescKey.get(String(row.string).replace(/_new$/, '')) ||
      mechaSkillIdx.get(Number(key)) ||
      null;
    if (nm && nm !== disp) addPair(nm, disp);
  }
  // 数字/标点归一的"骨架"兜底：等级变体（1个/2个、15%/30%）仍可回落到同一技能名
  const skel = (s) =>
    String(s)
      .replace(/[\d]+(?:\.\d+)?%?/g, '#')
      .replace(/[，。；、\s]/g, '');
  const descSkelToName = new Map();
  for (const [d, n] of descToName) {
    const k = skel(d);
    if (!descSkelToName.has(k)) descSkelToName.set(k, n);
  }
  const dispNameDesc = (str) => {
    if (str == null) return { name: str, desc: null };
    const s = String(str).trim();
    if (nameToDesc.has(s)) return { name: s, desc: nameToDesc.get(s) }; // 本身就是名字
    if (descToName.has(s)) return { name: descToName.get(s), desc: filledByRaw.get(s) || s }; // 是描述 → 还原名字
    const sn = descSkelToName.get(skel(s)); // 骨架回退
    if (sn && skel(s) !== skel(sn)) return { name: sn, desc: filledByRaw.get(s) || s };
    return { name: s, desc: filledByRaw.get(s) || null };
  };

  // ── 采集 ──────────────────────────────────────────────
  const rep = db.prepare(`SELECT * FROM reports WHERE report_id=?`).get(R);
  const march =
    db.prepare(`SELECT * FROM battle_marches WHERE report_id=? ORDER BY seq LIMIT 1`).get(R) || {};
  const sides = {};
  for (const s of ['att', 'def'])
    sides[s] = db.prepare(`SELECT * FROM sides WHERE report_id=? AND side=?`).get(R, s) || {};
  const players = {};
  for (const s of ['att', 'def'])
    players[s] =
      db.prepare(`SELECT * FROM side_players WHERE report_id=? AND side=? AND seq=0`).get(R, s) ||
      {};
  // 九宫格：side_units seq 0..8
  const grid = { att: Array(9).fill(null), def: Array(9).fill(null) };
  for (const r of db
    .prepare(`SELECT side, seq, army_id, uuid_count, dead_count FROM side_units WHERE report_id=?`)
    .all(R))
    if (r.seq >= 0 && r.seq < 9) grid[r.side][r.seq] = r;

  const inst = new Map();
  for (const r of db
    .prepare(`SELECT uuid, side, army_id FROM unit_instances WHERE report_id=?`)
    .all(R))
    inst.set(String(r.uuid), r);

  const evs = db
    .prepare(
      `SELECT source,val,e_type,e_value,kind,outcome,hero_name,skill_name,skill,buff_name,buff_id,buff_type,tl FROM battle_events WHERE report_id=? ORDER BY idx`,
    )
    .all(R);
  const acc = {
    att: { hit: 0, crit: 0, miss: 0, dmg: 0 },
    def: { hit: 0, crit: 0, miss: 0, dmg: 0 },
  };
  const dmgSrc = { att: new Map(), def: new Map() }; // 伤害来源类别 → (具体来源 label → {dmg, desc})
  // 伤害来源分类：普攻 / 机甲 / 军阵精通 / 装备技能 / 觉醒技能 / 英雄主动技能 / 其他
  const mechaSkillIds = new Set(
    db
      .prepare(`SELECT key FROM dict_entries WHERE dict_version=? AND category='table:Mecha_skill'`)
      .all(version)
      .map((r) => String(r.key)),
  );
  const masterySkillNames = new Set();
  for (const r of rowsOf('formationV2_mastery')) {
    const nm = loc(r.mastery_name);
    if (nm) masterySkillNames.add(String(nm).trim());
  }
  const heroSkillName = (id) => resolveName(db, version, 'hero_skill', id);
  // 装备技能：hero_skill.name 常是 locale 包缺失的键(如 hero_equip_skill_name26)，改用 hero_equip_skill_rd_library 按 skill_id 取可解析名
  const equipRdName = new Map(); // skill_id → 装备技能中文名
  for (const r of rowsOf('hero_equip_skill_rd_library')) {
    const nm = loc(r.name);
    if (nm && cjk(nm) && r.skill_id != null)
      for (const sid of String(r.skill_id).split(/[|,]/))
        if (!equipRdName.has(String(sid).trim())) equipRdName.set(String(sid).trim(), nm);
  }
  const skillNameAny = (id) => {
    const hn = heroSkillName(id);
    if (hn && cjk(hn)) return hn; // hero_skill 自带可解析名
    return (
      mechaSkillIdx.get(Number(id)) || // 机甲授予的英雄技能(name 空)→ Mecha_skill 反查
      equipRdName.get(String(id)) || // 装备技能 name 键缺失 → rd_library
      resolveName(db, version, 'Mecha_skill', id) ||
      '技能' + id
    );
  };
  const dmgCategory = (skill) => {
    if (skill == null) return '普通攻击';
    if (mechaSkillIds.has(String(skill))) return '机甲';
    const nm = heroSkillName(skill);
    if (nm && masterySkillNames.has(String(nm).trim())) return '军阵精通';
    const hs = dictRow('hero_skill', skill);
    const t = hs ? Number(hs.skill_type) : null;
    if (t === 5) return '装备技能';
    if (t === 6) return '觉醒技能';
    if (t === 1) return '英雄主动技能';
    return '其他来源';
  };
  const skillCast = { att: new Map(), def: new Map() };
  const buffApply = { att: new Map(), def: new Map() };
  // 施加状态名：hero_skill_key_id type=1 → 去括号状态名；技能 desc 里的 <id=N> 引用即该技能施加的状态
  const statusIdName = new Map();
  for (const r of rowsOf('hero_skill_key_id')) {
    if (Number(r.type) === 1 && r.power_point) {
      const v = loc(r.power_point);
      if (v && cjk(v)) statusIdName.set(String(r.id), String(v).replace(/[[\]]/g, '').trim());
    }
  }
  const statusNameSet = new Set(statusIdName.values());
  // 装备技能稀有/普通：hero_skill.quality 1=普通 2=稀有（同名不同 id 的通用装备技）
  const skillRarity = (id) => {
    const q = dictRow('hero_skill', id);
    return q ? (Number(q.quality) === 2 ? '稀有' : Number(q.quality) === 1 ? '普通' : null) : null;
  };
  const heroSkillByName = new Map();
  for (const r of rowsOf('hero_skill')) {
    const nm = loc(r.name);
    if (nm && cjk(nm)) {
      const k = String(nm).replace(/[[\]]/g, '').trim();
      if (!heroSkillByName.has(k)) heroSkillByName.set(k, r);
    }
  }
  // 技能行 → 其各 desc 字段引用的状态名（去重、按出现序）
  function skillInflictedStatuses(hsRow) {
    if (!hsRow) return [];
    const keys = [];
    const push = (f, pipe) => {
      if (!hsRow[f]) return;
      for (const seg of String(hsRow[f]).split('|')) {
        const key = pipe ? seg.split(',')[1] || seg : seg;
        for (const one of String(key).split(',')) if (one.trim()) keys.push(one.trim());
      }
    };
    push('desc', false);
    push('detail_desc', false);
    push('detail_desc_new', false);
    push('des_new', true);
    push('simple_desc', true);
    const out = [];
    for (const k of keys) {
      const t = loc(k);
      if (!t) continue;
      for (const m of subSkillIds(t).matchAll(/\[([\u4e00-\u9fff]{2,6})\]/g))
        if (statusNameSet.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }
  // buff 事件 → 源技能行（e.skill 数字 id 优先，回落 skill_name）
  function eventSkillRow(e) {
    if (e.skill != null) {
      const r = dictRow('hero_skill', e.skill);
      if (r) return r;
    }
    const raw =
      e.skill_name == null ? null : cjk(e.skill_name) ? String(e.skill_name) : loc(e.skill_name);
    if (!raw) return null;
    return heroSkillByName.get(String(raw).replace(/[[\]]/g, '').trim()) || null;
  }
  // 源技能 id → 中文名（载体/条件型 buff 回落用）：hero_skill 正查 → Mecha_skill 反向 effect 索引 → Mecha_skill 正查。
  // 只接受可解析中文名，取不到返回 null；不用 '技能'+id 兜底（那只是把旧占位换成新占位）。
  const namedSkillRef = (id) => {
    if (id == null || id === '') return null;
    for (const tok of String(id).split(/[|,]/)) {
      const t = tok.trim();
      if (!/^\d+$/.test(t)) continue;
      const n =
        okName(heroSkillName(t)) ||
        (mechaSkillIdx.has(Number(t)) ? okName(mechaSkillIdx.get(Number(t))) : null) ||
        okName(resolveName(db, version, 'Mecha_skill', t));
      if (n) return n;
    }
    return null;
  };
  // effect_buff.para1 仅在其为 SkillId 引用时给出被引技能 id（避免把 Mecha/IsSkill 的 "1"/"1,3" 误当技能号）
  const buffParaSkill = (buffId) => {
    const r = dictRow('effect_buff', buffId);
    return r && r.paraType1 === 'SkillId' ? r.para1 : null;
  };
  // 增益显示名统一命名链（主循环与回合聚合共用，避免两处分叉）：
  // 芯片名 → 施加状态名 → 扩展解析 → 事件 buff_name → skill_name → 源技能反查名(先 para1 稳定项,后事件 skill) → 装备技能回落 → 紧凑回落
  const buffDisplayName = (e) => {
    const st = skillInflictedStatuses(eventSkillRow(e));
    const keq = /^hero_equip_skill_name(\d+)$/.exec(String(e.skill_name ?? ''));
    return (
      (e.kind === 'MechaMainChipBuff' ? resolveChipName(e.buff_id) : null) ||
      (st.length ? st.join('+') : null) ||
      okName(resolveBuffNameExt(e.buff_id)) ||
      okName(tryLocale(e.buff_name)) ||
      okName(tryLocale(e.skill_name)) ||
      namedSkillRef(buffParaSkill(e.buff_id)) ||
      namedSkillRef(e.skill) ||
      (keq ? '英雄装备技能#' + keq[1] : null) ||
      (e.buff_id != null ? '增益#' + e.buff_id : null)
    );
  };
  const buffRemove = { att: 0, def: 0 };
  const elemDmg = { att: 0, def: 0, unk: 0 }; // 元素伤害 e_value 按 source→侧归属
  for (const e of evs) {
    const src = inst.get(String(e.source));
    const side = src ? src.side : null;
    if (e.e_value > 0 && e.e_type) {
      if (side) elemDmg[side] += e.e_value;
      else elemDmg.unk += e.e_value;
    }
    const isDmg = ['Attack', 'DebuffHurt', 'MissAttack', 'HeroAttack'].includes(e.kind);
    if (e.outcome && side) acc[side][e.outcome]++;
    const dealt = e.val || 0;
    if (isDmg && dealt > 0 && side) {
      acc[side].dmg += dealt;
      const cat = dmgCategory(e.skill);
      const raw = e.skill == null ? '普通攻击' : skillNameAny(e.skill);
      const { name, desc } = dispNameDesc(raw);
      let mm = dmgSrc[side].get(cat);
      if (!mm) dmgSrc[side].set(cat, (mm = new Map()));
      const cur = mm.get(name) || { dmg: 0, desc: null };
      cur.dmg += dealt;
      if (!cur.desc) cur.desc = desc || null;
      mm.set(name, cur);
    }
    if (e.kind === 'Skill' && side && e.skill_name) {
      const sn = subSkillIds(e.skill_name);
      skillCast[side].set(sn, (skillCast[side].get(sn) || 0) + 1);
    }
    if (
      [
        'AddSkillBuff',
        'ArmyAddBuff',
        'HeroAddBuff',
        'ADDMUTIBUFFS',
        'MechaMainChipBuff',
        'HeroEquipSkillBuff',
        'UPDATENUMBUFF',
        'ADD_BUFF_WITH_NUM',
      ].includes(e.kind)
    ) {
      const nm = buffDisplayName(e);
      const nmShown = nm ? subSkillIds(nm) : nm;
      if (nmShown && side) buffApply[side].set(nmShown, (buffApply[side].get(nmShown) || 0) + 1);
    }
    if (e.kind === 'RemoveSkillBuff' && side) buffRemove[side]++;
  }

  // 属性矩阵：复刻游戏 BattleReportComparisonPanel.AddOneBuffToBuffPool
  // 按 effect_buff.group 聚合；buff_divide 使「全部单位」子组回流进本军种父组；FightType_show 过滤攻守/战斗类型
  const ATTRS = ['防御加成', '生命加成', '攻击加成', '伤害加深', '伤害减免'];
  const FIGHT_TYPE = Number(rep.fight_type) || 0;
  // dividePool：子 group → [父 group…]（父的 buff_divide 列出子）
  const dividePool = new Map();
  for (const r of db
    .prepare(
      `SELECT key,value FROM dict_entries WHERE dict_version=? AND category='table:effect_buff'`,
    )
    .all(version)) {
    const bd = J(r.value).buff_divide;
    if (bd && String(bd) !== '-1')
      for (const c of String(bd).split(',')) {
        const n = Number(c);
        if (!Number.isFinite(n)) continue;
        if (!dividePool.has(n)) dividePool.set(n, []);
        dividePool.get(n).push(Number(r.key));
      }
  }
  // 面板左侧=攻方(_Attacker=true)：roleFlag1 仅攻方计入，roleFlag2 仅守方计入
  const fightFilter = (ftshow, isLeft) => {
    if (!ftshow) return false;
    const o = String(ftshow).split('|');
    const a = parseInt(o[1]);
    if (a === 1 && !isLeft) return true;
    if (a === 2 && isLeft) return true;
    return o[0] !== '0' && o[0].split(',').indexOf(String(FIGHT_TYPE)) < 0;
  };
  const pool = new Map(); // group → {att,def,data}
  const addBuff = (id, side, val, isLeft, depth = 0) => {
    if (depth > 6) return;
    let e = dictRow('effect_buff', id);
    if (!e) return;
    if (e.group && Number(id) !== Number(e.group)) {
      id = Number(e.group);
      e = dictRow('effect_buff', id);
    }
    if (!e) return;
    if (fightFilter(e.FightType_show, isLeft)) return;
    const parents = dividePool.get(Number(id));
    if (parents) for (const p of parents) addBuff(p, side, val, isLeft, depth + 1);
    if (String(e.buff_divide) === '-1') return; // 子组不单独展示，值已回流父组
    let row = pool.get(Number(id));
    if (!row) pool.set(Number(id), (row = { att: 0, def: 0, data: e }));
    row[side] += val;
  };
  for (const r of db
    .prepare(
      `SELECT side,buff_id,raw_value FROM buff_effects WHERE report_id=? AND source_view LIKE 'trace:%'`,
    )
    .all(R)) {
    if (!r.buff_id) continue;
    addBuff(Number(r.buff_id), r.side, r.raw_value || 0, r.side === 'att');
  }
  // 游戏面板每行对应一个规范 group；divide 已把「全部单位」回流进本军种父组。
  // 直接按 (属性, 军种) → 规范 group id 精确取值，避免同 type 的对军种子行（如「陆军对空军伤害加成」）被误并。
  const GROUP_CANON = {
    生命: { 陆军: 930001, 海军: 930002, 空军: 930003 },
    攻击: { 陆军: 930101, 海军: 930102, 空军: 930103 },
    伤害加深: { 陆军: 980101, 海军: 980102, 空军: 980103 },
    伤害减免: { 陆军: 980201, 海军: 980202, 空军: 980203 },
    防御: { 陆军: 990203, 海军: 990204, 空军: 990205 },
  };
  const QJ_DEF_GROUP = 990202; // 全军防御能力提升
  // 每 side × 军种的出征数（uuid_count 汇总），默认定格出征数最大的军种 TAB
  const BRANCHES = ['陆军', '海军', '空军'];
  const branchTroop = (s, br) =>
    grid[s].reduce((a, u) => a + (u && armyBranch(u.army_id) === br ? u.uuid_count || 0 : 0), 0);
  const defaultBranch = (s) =>
    BRANCHES.map((br) => [br, branchTroop(s, br)]).sort((a, b) => b[1] - a[1])[0][0];
  const A_BR = defaultBranch('att');
  // 面板每行=一个规范 group；divide 已把「全部单位」回流进本军种。防御按用户口径合并：军种防御 + 全军防御。
  const foldedAttr = (s, br) => {
    const g = (id) => {
      const r = pool.get(id);
      return r ? r[s] : 0;
    };
    return {
      防御加成: g(GROUP_CANON['防御'][br]) + g(QJ_DEF_GROUP),
      生命加成: g(GROUP_CANON['生命'][br]),
      攻击加成: g(GROUP_CANON['攻击'][br]),
      伤害加深: g(GROUP_CANON['伤害加深'][br]),
      伤害减免: g(GROUP_CANON['伤害减免'][br]),
    };
  };

  // ── 渲染 ──────────────────────────────────────────────
  const sideMeta = (s) => {
    const sd = sides[s] || {};
    const pl = players[s] || {};
    const info = J(pl.player_info) || {};
    const heroes = J(pl.hero_list) || [];
    const form = J(pl.formation_v2) || {};
    const career =
      sd.career != null ? resolveName(db, version, 'selection_v2', sd.career) || sd.career : '-';
    return { info, heroes, form, career, sd };
  };
  const A = sideMeta('att'),
    D = sideMeta('def');

  // 按 battle_events 的 IndexRound 事件切回合（val=回合号）：其后伤害事件归入该回合，直到下一个标记
  const roundBins = (() => {
    const byR = new Map();
    let cur = null;
    const get = (n) => {
      let b = byR.get(n);
      if (!b) {
        b = { round: n, att: 0, def: 0, c: 0 };
        byR.set(n, b);
      }
      cur = b;
      return b;
    };
    for (const e of evs) {
      if (e.kind === 'IndexRound') {
        get(Number(e.val) || (cur ? cur.round : 1));
        continue;
      }
      if (!cur) get(1); // 首标记前若有伤害事件，归入回合1（与后续 IndexRound(1) 同一桶）
      const isDmg = ['Attack', 'DebuffHurt', 'MissAttack', 'HeroAttack'].includes(e.kind);
      if (!isDmg || !(e.val > 0)) continue;
      const side = inst.get(String(e.source))?.side;
      if (side) {
        cur[side] += e.val;
        cur.c++;
      }
    }
    const bins = [...byR.values()].sort((a, b) => a.round - b.round);
    return { bins, N: bins.length };
  })();
  const battleMs = Math.max(0, ...evs.map((e) => e.tl || 0)); // 战斗总时长（最大 tl，毫秒）
  const cmpRow = (label, av, dv, f = fmt) =>
    `<div class="cmp"><span class="cn attc">${esc(f(av))}</span><span class="cl">${esc(label)}</span><span class="cn defc">${esc(f(dv))}</span></div>`;

  // ── 对比优先原语 ──
  // 共用标尺的对称蝴蝶对比行：每行 攻值 | 攻条(左红) | 名称+Δ(居中) | 守条(右蓝) | 守值，两柱从中心向两侧生长，占优侧高亮、另一侧 dim
  const vtFmt = (v, p) =>
    p && p.vt === 10000
      ? (v / 100).toFixed(1) + '%'
      : p && p.vt === 1
        ? String(Math.round(v))
        : fmt(v);
  const divergingRows = (pairs, opts = {}) => {
    const { fmtVal = vtFmt, empty = '<div class="mut">—</div>' } = opts;
    const act = pairs.filter((p) => (p.att || 0) !== 0 || (p.def || 0) !== 0);
    if (!act.length) return empty;
    const mx = Math.max(1, ...act.flatMap((p) => [p.att || 0, p.def || 0]));
    const sorted = act
      .map((p) => ({ ...p, _s: Math.max(p.att || 0, p.def || 0) }))
      .sort((a, b) => b._s - a._s);
    const row = (p) => {
      const a = p.att || 0;
      const d = p.def || 0;
      const aWin = a >= d;
      return (
        `<div class="vr" title="${esc(p.name)} · 攻 ${esc(fmtVal(a, p))} · 守 ${esc(fmtVal(d, p))}">` +
        `<span class="vrv l ${aWin ? 'attc' : 'mut'}">${esc(fmtVal(a, p))}</span>` +
        `<span class="vrh l"><i class="vrbar a${aWin ? '' : ' dim'}" style="width:${(a / mx) * 100}%"></i></span>` +
        `<span class="vrn"><b class="nm">${esc(shortFor(p.name))}</b><i class="dlt">Δ ${esc(fmtVal(Math.abs(a - d), p))}</i></span>` +
        `<span class="vrh r"><i class="vrbar d${aWin ? ' dim' : ''}" style="width:${(d / mx) * 100}%"></i></span>` +
        `<span class="vrv r ${aWin ? 'mut' : 'defc'}">${esc(fmtVal(d, p))}</span></div>`
      );
    };
    return sorted.map(row).join('');
  };
  // 展开卡：标题（+可选摘要 chip）直接展开、内部不收折
  const openCard = (title, summary, body) =>
    `<div class="card"><h2>${title}${summary ? ` <span class="opsum">${summary}</span>` : ''}</h2>${body}</div>`;
  // 章内钻取明细：直接展开、无收起（原 <details> 折叠降级为常显块）
  const drill = (title, body, extraClass = '') =>
    `<div class="dnode ${extraClass}"><div class="dnode-t">${title}</div><div class="dx">${body}</div></div>`;
  // 逐件/明细折叠层：默认收起（<details>），满足“汇总为主 + 逐件可展开”（需早于 entityCards 立即求值前定义）
  const fold = (title, body, extraClass = '') =>
    `<details class="dnode dfold ${extraClass}"><summary class="dnode-t">${title}</summary><div class="dx">${body}</div></details>`;
  // 摘要：取双方绝对差最大的一项，标注领先方
  const cmpSummary = (pairs, fmtVal = vtFmt) => {
    let best = null;
    let gap = -1;
    for (const p of pairs) {
      const g = Math.abs((p.att || 0) - (p.def || 0));
      if (g > gap) {
        gap = g;
        best = p;
      }
    }
    if (!best || gap <= 0) return '<span class="mut">双方持平</span>';
    const lead = (best.att || 0) >= (best.def || 0) ? '攻' : '守';
    return `最大差 ${esc(shortFor(best.name))} · ${lead}优 ${esc(fmtVal(gap, best))}`;
  };

  const DMG_CAT_ORDER = [
    '普通攻击',
    '英雄主动技能',
    '装备技能',
    '觉醒技能',
    '军阵精通',
    '机甲',
    '其他来源',
  ];
  // ④ 各来源技能明细：按来源类别分组，每类内技能做蝶形对比（攻左/守右，从中缝向两边），与主区共用 .vr 网格
  const dmgDetail = () => {
    const catRank = (c) => {
      const i = DMG_CAT_ORDER.indexOf(c);
      return i < 0 ? 99 : i;
    };
    const cats = [...new Set([...dmgSrc.att.keys(), ...dmgSrc.def.keys()])].sort(
      (a, b) => catRank(a) - catRank(b),
    );
    return (
      cats
        .map((cat) => {
          const ma = dmgSrc.att.get(cat) || new Map();
          const md = dmgSrc.def.get(cat) || new Map();
          const names = [...new Set([...ma.keys(), ...md.keys()])];
          const pairs = names.map((n) => ({
            name: n,
            att: ma.get(n)?.dmg || 0,
            def: md.get(n)?.dmg || 0,
          }));
          if (!pairs.some((p) => p.att || p.def)) return '';
          return drill(esc(cat), divergingRows(pairs), 'fgrp');
        })
        .join('') || '<div class="mut">-</div>'
    );
  };
  const shortFor = (s) => (s && s.length > 24 ? s.slice(0, 22) + '…' : s);

  // ── 军阵科技 / 站位精通 ──────────────────────────────
  // 军阵科技：formation_v2.sciences{group:level}，group → 组名（formationV2_science.group_name 是 locale 键）
  const sciNameByGroup = new Map();
  for (const r of rowsOf('formationV2_science')) {
    const g = String(r.group);
    if (!sciNameByGroup.has(g)) {
      const nm = loc(r.group_name) || loc(r.type_name);
      if (nm) sciNameByGroup.set(g, nm);
    }
  }
  const scienceList = (form) =>
    Object.entries(form?.sciences || {})
      .map(([g, lv]) => ({ name: sciNameByGroup.get(String(g)) || '科技' + g, level: lv }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const scienceHtml = (form) => {
    const sci = scienceList(form);
    if (!sci.length) return '';
    return `<div class="fsci"><span class="hlbl">军阵科技</span><span class="chips">${sci
      .map((s) => `<span class="chip sci">${esc(s.name)} <b>Lv${s.level}</b></span>`)
      .join('')}</span></div>`;
  };
  // 站位精通：九宫格 seq(0-8) → mastery position（row*10+col+1，3×3 = 1,2,3/11,12,13/21,22,23）
  const masteryPosOfSeq = (seq) => {
    const row = Math.floor(seq / 3);
    const col = seq % 3;
    return row * 10 + col + 1;
  };
  const masteryOfSeq = (form, seq) => (form?._masterys || {})[String(masteryPosOfSeq(seq))] || null;

  // 侧级伤亡汇总条（存活/受伤/阵亡，来自 sides 聚合）；单色随侧红蓝深→浅
  const casBar = (s, sd) => {
    const total = sd.total || 0;
    const sv = sd.survival || 0;
    const wd = sd.wounded || 0;
    const dd = sd.dead || 0;
    const pc = (x) => (total ? (x / total) * 100 : 0);
    return (
      `<div class="casside cas-${s}">` +
      `<div class="casbar"><span class="cb sv" style="width:${pc(sv)}%" title="存活${sv}"></span>` +
      `<span class="cb wd" style="width:${pc(wd)}%" title="受伤${wd}"></span>` +
      `<span class="cb dd" style="width:${pc(dd)}%" title="阵亡${dd}"></span></div>` +
      `<div class="caslegend"><span class="ok">存活 ${sv}</span><span class="wdl">受伤 ${wd}</span>` +
      `<span class="dead">阵亡 ${dd}</span><span class="mut">共 ${total}</span></div></div>`
    );
  };

  // ⑤基础属性对照：单一共享军种 TAB，选定后 6 项属性 + 出征数各出一行攻/守背靠背对比
  const attrCompare = () => {
    const radios = BRANCHES.map(
      (br, i) =>
        `<input type="radio" name="tab-br" id="tab-br-${i}"${br === A_BR ? ' checked' : ''}><label for="tab-br-${i}">${br}</label>`,
    ).join('');
    const pane = (br) => {
      const fa = foldedAttr('att', br);
      const fd = foldedAttr('def', br);
      const pairs = ATTRS.map((a) => ({ name: a, att: fa[a] || 0, def: fd[a] || 0, vt: 10000 }));
      pairs.push({
        name: '出征数',
        att: branchTroop('att', br),
        def: branchTroop('def', br),
        vt: 1,
      });
      return `<div class="tpane">${divergingRows(pairs, { fmtVal: vtFmt })}</div>`;
    };
    const panes = BRANCHES.map((br) => pane(br)).join('');
    return `<div class="tabs brcmp">${radios}<div class="tpanes">${panes}</div></div>`;
  };

  // 英雄卡片：名字/等级/星级/觉醒 + 觉醒技/技能/天赋（每项一个 chip 徽章，分行分区）
  const hchip = (label, lv, cls) =>
    `<span class="chip ${cls}">${esc(label)}${lv != null ? ` <b>Lv${lv}</b>` : ''}</span>`;
  const heroCard = (heroes) =>
    heroes
      .map((h) => {
        const dash = '<span class="mut">—</span>';
        const aw = (h._awakenSkills || [])
          .slice()
          .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
          .map((s) => {
            const nm = skillNameAny(s.hero_skill_id) || subSkillIds(s.hero_skill_name) || '?';
            return hchip(subSkillIds(String(nm)), s.level, 'aw');
          })
          .join('');
        const sk = (h._nonActiveSkills || [])
          .map((s) => {
            const nm = subSkillIds(String(skillNameAny(s.skillId) || s.name || '?'));
            const rq = skillRarity(s.skillId);
            return `<span class="chip sk">${esc(nm)}${s.level != null ? ` <b>Lv${s.level}</b>` : ''}${
              rq ? `<i class="rq ${rq === '稀有' ? 'rar' : 'nor'}">${rq}</i>` : ''
            }</span>`;
          })
          .join('');
        const tl = (h._talents || [])
          .map((t) => {
            const nm = subSkillIds(String(t.name ?? '?'));
            const v = buffValText(t.buff_id, t.ttsr);
            return `<span class="chip tal">${esc(nm)}${v ? ` <b>${esc(v)}</b>` : ''}</span>`;
          })
          .join('');
        const eq = (h._equips || [])
          .map((e) => {
            const stones = (e._infos || [])
              .filter((x) => x.kind === 'stone')
              .map((s) => {
                const tier = stoneTier(s.level);
                const qc = stoneQCls(s.color);
                return `<i class="stn${qc ? ' ' + qc : ''}" title="品质色码 ${esc(String(s.color ?? '-'))}">${esc(s.name || '魔石')}${tier ? `<b>Lv${tier}</b>` : ''}</i>`;
              })
              .join('');
            const star = Number(e.rateEquipId) > 0 ? ` <b>★${e.rateEquipId}</b>` : '';
            return `<span class="chip eqp">${esc(heroEquipName(e.equipId))}${
              e.level != null ? ` <b>Lv${e.level}</b>` : ''
            }${star}${stones}</span>`;
          })
          .join('');
        const grp = (lbl, inner) =>
          `<div class="hgrp"><span class="hlbl">${lbl}</span><span class="chips">${inner || dash}</span></div>`;
        return (
          `<div class="hero"><div class="hnm">${esc(h._name || h.name || '#' + h.id)}</div>` +
          `<div class="hst">Lv${h.level ?? '-'} · ★${h.star ?? '-'} · 觉醒${h.awakenLevel ?? 0}${h.fullAwaken ? '✓' : ''}</div>` +
          grp('觉醒技', aw) +
          grp('技能', sk) +
          grp('天赋', tl) +
          grp('装备', eq) +
          `</div>`
        );
      })
      .join('');

  // ── 任务③ 编配属性面板：机甲 / 兵种装备 / 装备强化 / 兵种克制 / 元素伤害 ──
  const effRows = { att: [], def: [] };
  for (const r of db
    .prepare(
      `SELECT side,source_view,item_ref,attr_slot,buff_id,name,raw_value,value_type FROM buff_effects WHERE report_id=?`,
    )
    .all(R))
    if (effRows[r.side]) effRows[r.side].push(r);
  const effValText = (r) =>
    r.value_type === 10000
      ? ((r.raw_value || 0) / 100).toFixed(1) + '%'
      : r.value_type === 1
        ? String(Math.round(r.raw_value || 0))
        : String(r.raw_value ?? '');
  // 按显示名聚合的加成对比（静态开局编配，att/def 并集各求和，产出 pairs 供 divergingRows）；views='*' 遍历全部视图
  const cmpAgg = (views, nameRe, notRe) => {
    const m = new Map();
    for (const side of ['att', 'def']) {
      for (const r of effRows[side]) {
        if (views !== '*' && !views.includes(r.source_view)) continue;
        if (
          !r.name ||
          !cjk(r.name) ||
          (nameRe && !nameRe.test(r.name)) ||
          (notRe && notRe.test(r.name))
        )
          continue;
        const cur = m.get(r.name) || { att: 0, def: 0, vt: r.value_type };
        cur[side] += r.raw_value || 0;
        m.set(r.name, cur);
      }
    }
    return [...m.entries()].map(([name, o]) => ({ name, att: o.att, def: o.def, vt: o.vt }));
  };
  const mechaList = (s) => {
    const m = J(sides[s].mechas);
    if (!m) return [];
    if (Array.isArray(m)) return m;
    if (Array.isArray(m.mechas)) return m.mechas;
    const out = [];
    for (const v of Object.values(m)) if (Array.isArray(v)) out.push(...v);
    return out;
  };
  const mechaName = (id) => {
    const row = dictRow('Mecha', id);
    return (row && (tryLocale(row.name) || loc(row.name))) || '机甲#' + id;
  };
  // 兵种装备名：新装备 eid(910xxx) → army_equip 表；旧装备 itemId(40xxxx) → item 表（name 为 locale 键）
  const equipName = (eid) => {
    const ae = dictRow('army_equip', eid);
    const aName = ae && (tryLocale(ae.name) || loc(ae.name));
    if (aName) return aName;
    const it = dictRow('item', eid);
    const iName = it && (tryLocale(it.name) || loc(it.name));
    return iName || '装备' + eid;
  };
  // 英雄泰坦装备（hero_equip 系统）名：hero_equip[equipId].name → locale
  const heroEquipName = (equipId) => {
    const row = dictRow('hero_equip', equipId);
    return (row && (tryLocale(row.name) || loc(row.name))) || '装备#' + equipId;
  };
  // 魔石等级档（buff_value 10000/20000/30000 → Lv1/Lv2/Lv3）与品质色码（buff_value_color）
  const stoneTier = (level) => {
    const n = Number(level);
    return Number.isFinite(n) && n >= 10000 ? String(Math.round(n / 10000)) : '';
  };
  const stoneQCls = (color) => {
    const n = Number(color);
    return Number.isFinite(n) && n >= 1 && n <= 9 ? 'q' + n : '';
  };
  // 异能兽名：enigma_beast[cfg].type → enigma_beast_type.name1 → locale（回落 name_type）
  const beastNameCache = new Map();
  const beastNameByCfg = (cfg) => {
    if (beastNameCache.has(cfg)) return beastNameCache.get(cfg);
    const b = dictRow('enigma_beast', cfg);
    let nm = null;
    if (b) {
      const t = dictRow('enigma_beast_type', b.type);
      if (t)
        nm = tryLocale(t.name1) || tryLocale(t.name2) || tryLocale(t.name_type) || loc(t.name_type);
    }
    nm = nm || '兽#' + cfg;
    beastNameCache.set(cfg, nm);
    return nm;
  };
  // 领域名：enigma_field[cfg].name → locale
  const fieldName = (cfg) => {
    const row = dictRow('enigma_field', cfg);
    return (row && (tryLocale(row.name) || loc(row.name))) || '领域#' + cfg;
  };
  const mechaDetail = (side) => {
    const list = mechaList(side);
    return (
      list
        .map((m) => {
          const parts = (m._partsNames || [])
            .map((p) => `<span class="chip">${esc(p)}</span>`)
            .join('');
          const skills = (m.skillIds || [])
            .map((sid) => `<span class="chip sk">${esc(skillNameAny(sid))}</span>`)
            .join('');
          const chips = (m.chips || [])
            .map((c) => {
              const cn = resolveChipName(c.chipId) || '芯片' + c.chipId;
              const attrs = effRows[side]
                .filter(
                  (r) => r.source_view === 'mecha_chip' && String(r.item_ref) === String(c.chipId),
                )
                .map((r) => `${esc(shortFor(r.name))} <b>${esc(effValText(r))}</b>`)
                .join('、');
              return `<div class="mineline"><b>${esc(cn)}</b>${c.level != null ? ` <i>Lv${c.level}</i>` : ''}：${attrs || '—'}</div>`;
            })
            .join('');
          return `<div class="mi"><div class="mihd">${esc(mechaName(m.mechaId))}</div><div class="mic"><span class="hlbl">部件</span><span class="chips">${parts || '—'}</span></div><div class="mic"><span class="hlbl">技能</span><span class="chips">${skills || '—'}</span></div><div class="mic"><span class="hlbl">芯片</span><div class="chiplist">${chips || '—'}</div></div></div>`;
        })
        .join('') || '<div class="mut">无机甲</div>'
    );
  };
  const equipDetail = (side) => {
    const eq = J(players[side].new_army_equips)?.equips || [];
    const old = J(players[side].army_equips) || [];
    const line = (e) => {
      const id = e.eid ?? e.itemId;
      // 旧装备有 armyType(101/201/301)，新装备只有 5 位 pos（前 3 位判军种）
      const bt = BR(e.armyType || Number(String(e.pos ?? '').slice(0, 3)) || 0);
      return `<span class="chip">${esc(equipName(id))} · ${bt}${e.suit ? ` · 套${e.suit}` : ''}</span>`;
    };
    const all = [...eq, ...old].filter((e) => Number(e.eid ?? e.itemId) > 0);
    return all.length
      ? `<span class="chips">${all.map(line).join('')}</span>`
      : '<div class="mut">无兵种装备</div>';
  };
  const masteryDetail = (side) => {
    const am = J(players[side].army_mastery);
    const ent = am ? Object.entries(am).filter(([, v]) => v) : [];
    return ent.length
      ? `<span class="chips">${ent
          .map(
            ([k, v]) =>
              `<span class="chip">${esc(typeof k === 'number' || /^\d+$/.test(k) ? BR(Number(k)) : String(k))} Lv${esc(String(v))}</span>`,
          )
          .join('')}</span>`
      : '<div class="mut">无（战报未下发 army_mastery）</div>';
  };
  const KEZHI_RE = /(陆军|海军|空军)对(陆军|海军|空军)|兵种克制/;
  // 增益属性总账：兵种克制（X对Y）+ 伤害加深/伤害减免（含全体/部队/前排·前二排等）
  const BUFF_ATTR_RE = /(陆军|海军|空军)对(陆军|海军|空军)|兵种克制|伤害加深|伤害减免/;
  // source_view → 中文标签（trace: 前缀去后再查，大小写兼容）
  const SRC_ZH = {
    CAREER: '兵种天赋',
    THOR_SCIENCE: '雷神科技',
    ENIGMA_BEAST: '异能兽',
    ENIGMA_FIELD: '异能领域',
    MECHA: '机甲',
    SKIN: '皮肤',
    DECORATION: '装饰',
    HERO_EQUIP: '英雄装备',
    HERO_SKILL: '英雄技能',
    HERO_BOND: '英雄羁绊',
    HERO_TALENT: '英雄天赋',
    ENHANCE_MASTERY: '装备强化',
    FORMATION_V2: '军阵',
    FORMATION_V2_TALENT: '军阵天赋',
    CASTLE_EFFECT: '城堡效果',
    CITY_SKILL: '城市技能',
    CITY_SKIN: '城市皮肤',
    CROSS_TREASURE_COLLECTION: '跨服珍宝',
    ALLIANCE: '联盟',
    ALLIANCE_BADGE: '联盟徽章',
    ALLIANCE_BEHEMOTH_TALENT: '联盟巨兽天赋',
    MATERIAL: '材料',
    MARCH_SKIN: '行军皮肤',
    SECRET_WEAPON: '秘密武器',
    STAMP: '图鉴',
    STATUS_BUFF: '状态增益',
    SCIENCE: '科技',
    ELEMENT: '元素',
    VIP: 'VIP',
    WORLD_WONDER: '世界奇观',
    ARMY_EQUIP: '兵种装备',
    INIT_ARMY_EQUIP: '兵种装备(初始)',
    TYPE_94: '类型94',
    TYPE_96: '类型96',
    UNKNOWN_139: '未知139',
    enigma_beast: '异能兽',
    enigma_field: '异能领域',
    skin_effect: '皮肤效果',
    skin_castle: '皮肤城堡',
    skin_march: '皮肤行军',
    skin_exhibition: '皮肤展览',
    skin_headframe: '皮肤头像框',
    hero_equip: '英雄装备',
    hero_equip_stone: '英雄装备魔石',
    hero_talent: '英雄天赋',
    mecha_chip: '机甲芯片',
    mecha_skill: '机甲技能',
    cross_collection: '跨服收藏',
    decoration_suit: '装饰套装',
    decoration_sublime: '装饰升华',
    decoration_exp: '装饰经验',
    formation_science: '军阵科技',
    formation_quality: '军阵品质',
    formation_mastery: '军阵精通',
    formation_level: '军阵等级',
    army_mastery: '兵种强化',
  };
  const srcLabel = (sv) => {
    const key = String(sv).replace(/^trace:/, '');
    return SRC_ZH[key] || SRC_ZH[key.toUpperCase()] || SRC_ZH[key.toLowerCase()] || key;
  };
  const buffAttrDetail = (side) => {
    const rows = effRows[side].filter((r) => r.name && BUFF_ATTR_RE.test(r.name));
    if (!rows.length) return '<div class="mut">无增益属性</div>';
    const bySrc = new Map();
    for (const r of rows) {
      if (!bySrc.has(r.source_view)) bySrc.set(r.source_view, []);
      bySrc.get(r.source_view).push(r);
    }
    const groups = [...bySrc.entries()].sort((a, b) => b[1].length - a[1].length);
    return groups
      .map(
        ([sv, rs]) =>
          `<div class="mic"><span class="hlbl" title="${esc(sv)}">${esc(srcLabel(sv))}</span><span class="chips">${rs
            .map(
              (r) =>
                `<span class="chip">${esc(shortFor(r.name))} <b>${esc(effValText(r))}</b></span>`,
            )
            .join('')}</span></div>`,
      )
      .join('');
  };
  // ── 增益生效矩阵：行=空间生效范围，列=生效时机（原型框架） ──
  // 范围(硬，写在增益名里)：兵种克制(X对Y) / 前排·前二排 / 本军种(陆海空单一) / 全局(其余)
  // 时机：静态 buff_effects 只能定「开局常驻」与「条件触发(守城/进攻/防守/限时…)」；首轮/逐回合作为动态列占位，指向 ⑥
  const RANGE_ORDER = ['兵种克制', '前排·前二排', '本军种', '全局'];
  const buffRangeOf = (name) => {
    const n = String(name || '');
    if (/(陆军|海军|空军)对(陆军|海军|空军)/.test(n)) return '兵种克制';
    if (/前排|前二排|前两排/.test(n)) return '前排·前二排';
    if (/陆军|海军|空军/.test(n)) return '本军种';
    return '全局';
  };
  const buffTimingOf = (name) =>
    /守城|进攻时|防守时|限时|被攻击|驻防|城防|受到攻击/.test(String(name || ''))
      ? '条件触发'
      : '开局常驻';
  const buffMatrix = () => {
    const pairs = cmpAgg('*', BUFF_ATTR_RE);
    if (!pairs.some((p) => p.att || p.def)) return '<div class="mut">无增益属性</div>';
    const cells = new Map(); // range → timing → pairs[]
    for (const p of pairs) {
      const rg = buffRangeOf(p.name);
      const tm = buffTimingOf(p.name);
      if (!cells.has(rg)) cells.set(rg, new Map());
      const tmap = cells.get(rg);
      if (!tmap.has(tm)) tmap.set(tm, []);
      tmap.get(tm).push(p);
    }
    const TIMINGS = ['开局常驻', '条件触发'];
    return (
      RANGE_ORDER.filter((rg) => cells.has(rg))
        .map((rg) => {
          const tmap = cells.get(rg);
          const cnt = [...tmap.values()].reduce(
            (a, l) => a + l.filter((p) => p.att || p.def).length,
            0,
          );
          let inner = '';
          for (const tm of TIMINGS) {
            if (!tmap.has(tm)) continue;
            const act = tmap.get(tm).filter((p) => p.att || p.def);
            if (!act.length) continue;
            inner += `<div class="mtkh">${esc(tm)} · ${act.length} 项</div>${divergingRows(act)}`;
          }
          inner +=
            '<div class="mtkh dyn">首轮 / 逐回合（动态列·占位）</div>' +
            '<div class="mut dynhint">静态编配 buff_effects 无回合维度，此列不做假数据；回合内实际触发/施加的增益见 ⑥ 逐回合增益活动（定性·次数）。</div>';
          return drill(`${esc(rg)} · ${cnt} 项`, inner, 'fgrp');
        })
        .join('') || '<div class="mut">无增益属性</div>'
    );
  };
  const elementDetail = (side) => {
    const el = J(sides[side].element_levels) || [];
    const lvChips = el
      .map(
        (e) =>
          `<span class="chip">${esc(BR(e.armyType))} 元素${e.elementType ?? ''} <b>Lv${e.level ?? '-'}</b></span>`,
      )
      .join('');
    return lvChips ? `<span class="chips">${lvChips}</span>` : '<div class="mut">无元素等级</div>';
  };
  // 异能兽逐领域对照：攻(左)/守(右)，中缝=领域内几号位（每个领域各自从 1 编号），行与行按号位对齐
  const enigmaCompare = () => {
    const parse = (side) => {
      const en = J(players[side].enigmas) || {};
      const beasts = en._beastDatas || en.beastDatas || [];
      const fields = en._fields || en.fields || [];
      return { fields, byId: new Map(beasts.map((b) => [String(b.id), b])) };
    };
    const S = { att: parse('att'), def: parse('def') };
    const slotBuffsText = (sl) =>
      (sl._buffs || sl.buffs || [])
        .map((bf) => {
          const nm = bf.name || okName(resolveBuffNameExt(bf.id)) || 'buff' + bf.id;
          const vt = buffValText(bf.id, bf.val);
          return `${esc(nm)} <b>${esc(vt ?? String(bf.val ?? ''))}</b>`;
        })
        .join('、');
    const cell = (sl, byId) => {
      if (!sl) return '<span class="mut">—</span>';
      const lv = sl.level != null ? `<i class="slv">位置Lv${sl.level}</i>` : '';
      const sb = slotBuffsText(sl);
      const bd = byId.get(String(sl.beastId));
      if (!bd)
        return `<div class="ecb"><span class="mut">空位</span>${lv}</div>${sb ? `<div class="ecbf">位增益 ${sb}</div>` : ''}`;
      const bb = [
        bd._mainBuffName && `主 ${esc(bd._mainBuffName)}`,
        (bd._baseBuffNames || []).length && `基 ${esc(bd._baseBuffNames.join('、'))}`,
      ]
        .filter(Boolean)
        .join('；');
      const head = `<div class="ecb"><b>${esc(beastNameByCfg(bd.cfg))}</b> <span class="chip">兽Lv${bd.level ?? '-'} ★${bd.star ?? '-'}</span>${lv}${bd.power != null ? ` <i class="slv">战力 ${fmt(bd.power)}</i>` : ''}</div>`;
      return (
        head +
        (bb ? `<div class="ecbf">${bb}</div>` : '') +
        (sb ? `<div class="ecbf">位增益 ${sb}</div>` : '')
      );
    };
    const cfgs = [
      ...new Set([...S.att.fields.map((f) => f.cfg), ...S.def.fields.map((f) => f.cfg)]),
    ].sort((a, b) => a - b);
    const slotsOf = (side, cfg) => {
      const s = S[side];
      const f = s.fields.find((x) => x.cfg === cfg);
      return {
        slots: ((f && (f._slots || f.slots)) || []).slice().sort((a, b) => a.id - b.id),
        byId: s.byId,
        inactive: f && f.active === false,
      };
    };
    return (
      cfgs
        .map((cfg) => {
          const A2 = slotsOf('att', cfg);
          const D2 = slotsOf('def', cfg);
          const n = Math.max(A2.slots.length, D2.slots.length);
          const rows = [];
          for (let i = 0; i < n; i++)
            rows.push(
              `<div class="erow"><div class="ec a">${cell(A2.slots[i], A2.byId)}</div><div class="epos">${i + 1} 号位</div><div class="ec d">${cell(D2.slots[i], D2.byId)}</div></div>`,
            );
          const inact = A2.inactive || D2.inactive ? '（未激活）' : '';
          return drill(
            `${esc(fieldName(cfg))}${inact}`,
            rows.join('') || '<div class="mut">无</div>',
            'fgrp',
          );
        })
        .join('') || '<div class="mut">无领域</div>'
    );
  };

  // ── 事件类对比 pairs ──
  const dmgPairs = () => {
    const sum = (mp, cat) => {
      const mm = mp.get(cat);
      return mm ? [...mm.values()].reduce((a, x) => a + x.dmg, 0) : 0;
    };
    const cats = new Set([...dmgSrc.att.keys(), ...dmgSrc.def.keys()]);
    return [...cats].map((cat) => ({
      name: cat,
      att: sum(dmgSrc.att, cat),
      def: sum(dmgSrc.def, cat),
    }));
  };
  const castPairs = () => {
    const names = new Set([...skillCast.att.keys(), ...skillCast.def.keys()]);
    return [...names].map((n) => ({
      name: n,
      att: skillCast.att.get(n) || 0,
      def: skillCast.def.get(n) || 0,
    }));
  };
  const buffPairs = () => {
    const names = new Set([...buffApply.att.keys(), ...buffApply.def.keys()]);
    return [...names].map((n) => ({
      name: n,
      att: buffApply.att.get(n) || 0,
      def: buffApply.def.get(n) || 0,
    }));
  };
  const elemPairs = () => [{ name: '元素伤害合计', att: elemDmg.att, def: elemDmg.def }];
  // 逐侧 detail 网格（攻/守并排），供折叠第二层
  const sideGrid = (fn) =>
    `<div class="grid2"><div><div class="attc">攻方</div>${fn('att')}</div><div><div class="defc">守方</div>${fn('def')}</div></div>`;
  // 编配对比折叠卡：静态属性 diverging + 逐件明细二层折叠（detailFn(side) 走攻/守并排；opts.combined 时 detailFn() 自带对照布局）
  const cmpPanelCard = (num, title, pairs, detailFn, note, opts = {}) => {
    const {
      combined = false,
      detailLabel = '展开 · 逐件明细（攻/守）',
      suffix = '开局编配·静态',
    } = opts;
    const detail = detailFn ? fold(detailLabel, combined ? detailFn() : sideGrid(detailFn)) : '';
    return openCard(
      `${num} ${title}（${suffix}）`,
      cmpSummary(pairs),
      divergingRows(pairs) + detail + (note ? `<div class="note">${note}</div>` : ''),
    );
  };

  // ⑥ 逐回合增益活动已由「回合时间轴」各回合卡的 roundBuffChips 承担（见 roundAgg）。

  const dynNote =
    '属性为开局编配静态值（buff_effects 无回合维度）；回合内动态增益会浮动，逐回合施加/移除见上方回合时间轴各回合卡。';
  // ── 阶段Ⅱ 二维看板：伤害/施加 沿 时间(回合) × 空间 交叉 ──
  // army_id → 阵型槽位 seq（每侧独立；同侧 army_id 若跨槽重复则剔除→该事件回退军种维）
  const armySeq = { att: new Map(), def: new Map() };
  for (const s of ['att', 'def']) {
    const seen = new Map();
    grid[s].forEach((u, i) => {
      if (!u) return;
      const k = String(u.army_id);
      seen.set(k, seen.has(k) ? null : i);
    });
    for (const [k, v] of seen) if (v != null) armySeq[s].set(k, v);
  }
  const heroLabel = (hn) => {
    if (hn == null || hn === '') return null;
    if (cjk(hn)) return subSkillIds(String(hn));
    const t = tryLocale(hn);
    return t ? subSkillIds(String(t)) : 'H' + hn;
  };
  // 逐伤害事件切桶：{round, side, branch, seq, cat, hero, val}（数值来自 battle_events.val，与 ① acc.dmg 同源）
  const DMG_KINDS = ['Attack', 'DebuffHurt', 'MissAttack', 'HeroAttack'];
  const dmgCells = (() => {
    const out = [];
    let cur = 1;
    for (const e of evs) {
      if (e.kind === 'IndexRound') {
        cur = Number(e.val) || cur || 1;
        continue;
      }
      if (!DMG_KINDS.includes(e.kind) || !(e.val > 0)) continue;
      const src = inst.get(String(e.source));
      if (!src) continue;
      out.push({
        round: cur,
        side: src.side,
        branch: armyBranch(src.army_id),
        seq: armySeq[src.side]?.get(String(src.army_id)) ?? null,
        cat: dmgCategory(e.skill),
        hero: heroLabel(e.hero_name),
        val: e.val,
      });
    }
    return out;
  })();
  const sumMap = (mp) => [...mp.values()].reduce((a, b) => a + b, 0);
  // 通用热力表：行=空间桶、列=回合，每格上暖(攻)/下冷(守)，背景 alpha 按全局单格最大值
  const heatTable = (data, rounds, unit = fmt) => {
    const cellMax = Math.max(1, ...data.flatMap(([, r]) => [...r.att.values(), ...r.def.values()]));
    const th =
      `<th class="rk">空间＼回合</th>` +
      rounds.map((rd) => `<th>回${rd}</th>`).join('') +
      '<th>行合计 攻/守</th>';
    const body = data
      .map(([k, r]) => {
        const cells = rounds
          .map((rd) => {
            const a = r.att.get(rd) || 0;
            const d = r.def.get(rd) || 0;
            const aa = a ? (0.12 + (a / cellMax) * 0.73).toFixed(3) : 0;
            const dd = d ? (0.12 + (d / cellMax) * 0.73).toFixed(3) : 0;
            return `<td class="hcell"><span class="ha" style="background:rgba(255,91,106,${aa})">${a ? unit(a) : '·'}</span><span class="hd" style="background:rgba(74,163,255,${dd})">${d ? unit(d) : '·'}</span></td>`;
          })
          .join('');
        return `<tr><td class="rk" title="${esc(k)}">${esc(k)}</td>${cells}<td class="rkt">${esc(unit(sumMap(r.att)))}/${esc(unit(sumMap(r.def)))}</td></tr>`;
      })
      .join('');
    const gA = data.reduce((x, [, r]) => x + sumMap(r.att), 0);
    const gD = data.reduce((x, [, r]) => x + sumMap(r.def), 0);
    const colTot = rounds
      .map((rd) => {
        const a = data.reduce((x, [, r]) => x + (r.att.get(rd) || 0), 0);
        const d = data.reduce((x, [, r]) => x + (r.def.get(rd) || 0), 0);
        return `<td>${esc(unit(a))}/${esc(unit(d))}</td>`;
      })
      .join('');
    return (
      `<div class="hxwrap"><table class="hx"><thead><tr>${th}</tr></thead><tbody>${body}</tbody>` +
      `<tfoot><tr><td class="rk">列合计 攻/守</td>${colTot}<td>${esc(unit(gA))}/${esc(unit(gD))}</td></tr></tfoot></table></div>`
    );
  };
  const dmgAgg = (dim) => {
    const keyOf = (c) =>
      dim === 'branch'
        ? c.branch
        : dim === 'seq'
          ? c.seq == null
            ? '（无槽位映射）'
            : '槽' + c.seq + '·' + c.branch
          : dim === 'cat'
            ? c.cat
            : c.hero || '（兵/普攻无英雄）';
    const m = new Map();
    for (const c of dmgCells) {
      const k = keyOf(c);
      if (!m.has(k)) m.set(k, { att: new Map(), def: new Map() });
      const r = m.get(k);
      r[c.side].set(c.round, (r[c.side].get(c.round) || 0) + c.val);
    }
    return m;
  };
  const dmgRoundMatrix = (dim) => {
    const m = dmgAgg(dim);
    const tot = (r) => sumMap(r.att) + sumMap(r.def);
    let order;
    if (dim === 'cat')
      order = DMG_CAT_ORDER.filter((c) => m.has(c)).concat(
        [...m.keys()].filter((k) => !DMG_CAT_ORDER.includes(k)),
      );
    else if (dim === 'branch')
      order = BRANCHES.filter((b) => m.has(b)).concat(
        [...m.keys()].filter((k) => !BRANCHES.includes(k)),
      );
    else if (dim === 'seq')
      order = [...m.keys()].sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }));
    else order = [...m.keys()].sort((a, b) => tot(m.get(b)) - tot(m.get(a)));
    const data = order.map((k) => [k, m.get(k)]);
    const rounds = roundBins.bins.map((b) => b.round);
    return data.length ? heatTable(data, rounds) : '<div class="mut">无伤害事件</div>';
  };
  // ── 阶段Ⅲ 终局结算：战损空间分布（存活/阵亡 × 军种 × seq）+ 总量收口（来源类别 × 英雄）──
  // side_units/grid 有 per-seq 存活·阵亡；受伤仅侧级汇总（unit 实例不下发 per-uuid 伤），故槽位维只呈现存活/阵亡。
  const lossTable = (side) => {
    const rows = [];
    const brAgg = new Map();
    grid[side].forEach((u, seq) => {
      if (!u) return;
      const br = armyBranch(u.army_id);
      const total = u.uuid_count ?? 0;
      const dead = u.dead_count ?? 0;
      const alive = Math.max(0, total - dead);
      rows.push({ seq, br, name: armyName(u.army_id), total, alive, dead });
      const b = brAgg.get(br) || { total: 0, alive: 0, dead: 0 };
      b.total += total;
      b.alive += alive;
      b.dead += dead;
      brAgg.set(br, b);
    });
    const rate = (a, t) => (t ? Math.round((a / t) * 100) : 100);
    const tr = rows
      .map(
        (r) =>
          `<tr><td class="mv">${r.seq}</td><td class="an"><span class="btag b${r.br}">${r.br}</span> ${esc(r.name)}</td><td class="mv">${fmt(r.total)}</td><td class="mv">${fmt(r.alive)}</td><td class="mv">${fmt(r.dead)}</td><td class="mv">${rate(r.alive, r.total)}%</td></tr>`,
      )
      .join('');
    const tf = [...brAgg.entries()]
      .sort((a, b) => BRANCHES.indexOf(a[0]) - BRANCHES.indexOf(b[0]))
      .map(
        ([br, b]) =>
          `<tr><td class="an" colspan="2">${br} 小计</td><td class="mv">${fmt(b.total)}</td><td class="mv">${fmt(b.alive)}</td><td class="mv">${fmt(b.dead)}</td><td class="mv">${rate(b.alive, b.total)}%</td></tr>`,
      )
      .join('');
    return (
      `<table class="mat"><thead><tr><th>槽</th><th class="an">军种·兵种</th><th>出征</th><th>存活</th><th>阵亡</th><th>存活率</th></tr></thead>` +
      `<tbody>${tr || '<tr><td class="mut" colspan="6">无编组</td></tr>'}</tbody><tfoot>${tf}</tfoot></table>`
    );
  };
  const lossBySpace = () =>
    `<div class="grid2">` +
    `<div><div class="attc">攻方 · 存活 ${fmt(A.sd.survival || 0)} / 受伤 ${fmt(A.sd.wounded || 0)} / 阵亡 ${fmt(A.sd.dead || 0)}</div>${lossTable('att')}</div>` +
    `<div><div class="defc">守方 · 存活 ${fmt(D.sd.survival || 0)} / 受伤 ${fmt(D.sd.wounded || 0)} / 阵亡 ${fmt(D.sd.dead || 0)}</div>${lossTable('def')}</div>` +
    `</div>`;
  // 总量收口：按侧 × 维度（来源类别 / 英雄）的伤害占比条（与 Ⅱ 看板、① acc.dmg 同源 dmgCells）
  const dmgShare = (side, dim) => {
    const m = new Map();
    let sum = 0;
    for (const c of dmgCells) {
      if (c.side !== side) continue;
      const k = (dim === 'hero' ? c.hero : c[dim]) || (dim === 'hero' ? '兵/普攻（无英雄）' : '—');
      m.set(k, (m.get(k) || 0) + c.val);
      sum += c.val;
    }
    const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const mx = Math.max(1, ...arr.map((a) => a[1]));
    if (!arr.length) return '<div class="mut">无伤害事件</div>';
    return arr
      .map(
        ([k, v]) =>
          `<div class="bar"><span class="bk" title="${esc(k)}">${esc(k)}</span><span class="rbc"><i class="bf${side === 'def' ? ' d' : ''}" style="width:${(v / mx) * 100}%"></i></span><span class="bv" title="${fmt(v)}">${pct(sum ? v / sum : null)}</span></div>`,
      )
      .join('');
  };
  // ── 回合时间轴：按 IndexRound 切回合逐回合聚合（可对账：各回合造成合计 == acc.dmg）──
  const roundAgg = (() => {
    const APPLIED = [
      'AddSkillBuff',
      'ArmyAddBuff',
      'HeroAddBuff',
      'ADDMUTIBUFFS',
      'MechaMainChipBuff',
      'HeroEquipSkillBuff',
      'UPDATENUMBUFF',
      'ADD_BUFF_WITH_NUM',
    ];
    const byR = new Map();
    const ensure = (n) => {
      if (!byR.has(n))
        byR.set(n, {
          round: n,
          dealt: { att: 0, def: 0 },
          branch: new Map(),
          cat: new Map(),
          hero: new Map(),
          casts: { att: 0, def: 0 },
          apply: { att: new Map(), def: new Map() },
          remove: { att: 0, def: 0 },
          acted: { att: new Set(), def: new Set() },
        });
      return byR.get(n);
    };
    const bump = (mp, k, side, val) => {
      if (!mp.has(k)) mp.set(k, { att: 0, def: 0 });
      mp.get(k)[side] += val;
    };
    for (const c of dmgCells) {
      const r = ensure(c.round);
      r.dealt[c.side] += c.val;
      if (c.branch) bump(r.branch, c.branch, c.side, c.val);
      bump(r.cat, c.cat, c.side, c.val);
      bump(r.hero, c.hero || '兵/普攻（无英雄）', c.side, c.val);
    }
    let cur = 1;
    ensure(1);
    for (const e of evs) {
      if (e.kind === 'IndexRound') {
        cur = Number(e.val) || cur;
        ensure(cur);
        continue;
      }
      const s = inst.get(String(e.source));
      if (!s) continue;
      if (e.kind === 'Skill') ensure(cur).casts[s.side]++;
      else if (e.kind === 'ARMYROUND') ensure(cur).acted[s.side].add(String(s.army_id));
      else if (APPLIED.includes(e.kind) && e.buff_id != null) {
        const nm = buffDisplayName(e);
        const shown = subSkillIds(String(nm));
        const r = ensure(cur);
        r.apply[s.side].set(shown, (r.apply[s.side].get(shown) || 0) + 1);
      } else if (e.kind === 'RemoveSkillBuff') ensure(cur).remove[s.side]++;
    }
    return byR;
  })();
  const roundPairs = (mp) =>
    [...mp.entries()].map(([name, v]) => ({ name, att: v.att, def: v.def }));
  const roundEmpty = () => ({
    dealt: { att: 0, def: 0 },
    branch: new Map(),
    cat: new Map(),
    hero: new Map(),
    casts: { att: 0, def: 0 },
    apply: { att: new Map(), def: new Map() },
    remove: { att: 0, def: 0 },
    acted: { att: new Set(), def: new Set() },
  });
  const roundBuffChips = (r) => {
    const col = (side) => {
      const arr = [...r.apply[side].entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      const chips = arr.length
        ? `<span class="chips">${arr
            .map(
              ([nm, c]) =>
                `<span class="chip" title="施加 ${c} 次">${esc(shortFor(nm))} <b>×${c}</b></span>`,
            )
            .join('')}</span>`
        : '<div class="mut">无施加</div>';
      return `<div><div class="${side === 'def' ? 'defc' : 'attc'}">${
        side === 'def' ? '守方' : '攻方'
      } · 施加 ${sumMap(r.apply[side])} · 移除 ${r.remove[side]}</div>${chips}</div>`;
    };
    return `<div class="grid2">${col('att')}${col('def')}</div>`;
  };
  const roundCard = (N) => {
    const r = roundAgg.get(N) || roundEmpty();
    const da = r.dealt.att;
    const dd = r.dealt.def;
    const momentum = da === dd ? '势均' : da > dd ? '攻优' : '守优';
    const domTop = (side) =>
      [...r.cat.entries()]
        .map(([k, v]) => [k, v[side] || 0])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${esc(k)} ${fmt(v)}`)
        .join(' · ') || '—';
    const inner =
      `<div class="card">` +
      `<h2>第 ${N} 回合 · 概览（可对账 · 承伤＝对侧本回合造成）</h2>` +
      cmpRow('本回合造成', da, dd) +
      cmpRow('本回合承受', dd, da) +
      `<div class="note">主导来源 攻：${domTop('att')} ｜ 守：${domTop('def')}。技能释放 攻${r.casts.att}/守${r.casts.def} · 施加 攻${sumMap(r.apply.att)}/守${sumMap(r.apply.def)} · 移除 攻${r.remove.att}/守${r.remove.def} · 行动编组(ARMYROUND) 攻${r.acted.att.size}/守${r.acted.def.size}。</div>` +
      `<h2 style="margin-top:14px">伤害空间分布 · 按军种（攻左红 / 守右蓝）</h2>` +
      (r.branch.size
        ? divergingRows(roundPairs(r.branch))
        : '<div class="mut">本回合无伤害事件</div>') +
      fold(
        '展开 · 更细切面（来源类别 / 英雄 攻守对比）',
        `<div class="attc" style="font-size:12px;margin:2px 0 4px">来源类别</div>${
          r.cat.size ? divergingRows(roundPairs(r.cat)) : '<div class="mut">—</div>'
        }<div class="defc" style="font-size:12px;margin:8px 0 4px">英雄 / 兵格</div>${
          r.hero.size ? divergingRows(roundPairs(r.hero)) : '<div class="mut">—</div>'
        }`,
      ) +
      fold('展开 · 本回合增益活动（施加 Top / 移除 · 定性次数）', roundBuffChips(r)) +
      `</div>`;
    return chapter(
      '第 ' + N + ' 回合',
      `本回合攻造成 ${fmt(da)} · 守造成 ${fmt(dd)} · ${momentum}`,
      inner,
      `round-${N}`,
    );
  };
  const roundTimeline = () => roundBins.bins.map((b) => roundCard(b.round)).join('');
  // 回合 × 军种 一览（时间轴顶部全局地图：列=回合、行=军种）
  const roundOverview = () =>
    openCard(
      '回合 × 军种 一览',
      `${roundBins.N} 回合 · 各军种逐回合造成（攻暖/守冷）· 可对账`,
      dmgRoundMatrix('branch') +
        `<div class="note">列=回合、行=军种，每格上暖=攻方造成/下冷=守方造成；“列合计攻/守”逐回合应＝下方各回合概览“本回合造成”、全场＝① 总输出伤害。站位按 army 归并不可靠，故一览到军种。</div>`,
    );
  // ── 顶部阵型位置：开局静态九宫格（不随回合切换、不钉固、随页面滚动）──
  const gridHtml = (side, form) =>
    grid[side]
      .map((u, i) => {
        if (!u) return `<div class="cell empty"><span class="cpos">${i}</span></div>`;
        const total = u.uuid_count ?? 0;
        const dead = u.dead_count ?? 0;
        const alive = Math.max(0, total - dead);
        const alivePct = total ? Math.round((alive / total) * 100) : 100;
        const mas = masteryOfSeq(form, i);
        return (
          `<div class="cell${mas ? ' mas' : ''}"><div class="crow"><span class="cpos">${i}</span>` +
          (mas
            ? `<span class="mtag" title="军阵专精 Lv${mas.level}">✦ ${esc(mas.skill || '专精')} Lv${mas.level}</span>`
            : '') +
          `</div>` +
          `<div class="cname" title="${esc(armyName(u.army_id))}">${esc(armyName(u.army_id))}</div>` +
          `<div class="cmeta"><span class="btag b${armyBranch(u.army_id)}">${armyBranch(u.army_id)}</span> 共${total}</div>` +
          `<div class="cbar"><span class="calive" style="width:${alivePct}%"></span></div>` +
          `<div class="cstat"><span class="ok">存活${alive}</span><span class="dead">阵亡${dead}</span></div></div>`
        );
      })
      .join('');
  const formationPanel = () =>
    `<section class="formbar">` +
    `<div class="rnavhd">阵型位置 · 开局编配（静态 · 随页面滚动） <span class="mut">（seq 0–8 站位 · 军阵专精加成 · 存活/受伤/阵亡）</span></div>` +
    `<div class="formlayout"><div><div class="attc">攻方</div>${casBar('att', A.sd)}<div class="grid g-att">${gridHtml('att', A.form)}</div></div>` +
    `<div><div class="defc">守方</div>${casBar('def', D.sd)}<div class="grid g-def">${gridHtml('def', D.form)}</div></div></div>` +
    `<div class="note">有军阵专精的站位格金黄映衬、✦ 显专精名与等级（站位 pos = row*10+col+1）；格内存活率条按 unit 存活/总数。受伤取侧级汇总（unit 实例仅记 isDead）。逐回合活动见下方回合时间轴各回合卡。</div>` +
    `</section>`;
  // 序·全局 静态增益总账：以 buffMatrix（空间范围 × 生效时机）为主视图，来源（旧按系统卡）降级为可追溯明细
  const buffGlobalCard = () =>
    openCard(
      '序·全局 静态增益总账（空间范围 × 生效时机）',
      '行=空间范围、列=时机；攻守数值对比 · 来源可追溯',
      '<div class="note">行=空间生效范围（兵种克制 / 前排·前二排 / 本军种 / 全局），列=生效时机（开局常驻 / 条件触发）。范围与时机取自 buff_effects 静态数据、可直接攻守数值对比；首轮/逐回合一列属回合动态（静态表无回合维度），见上方回合时间轴。旧按来源/系统的增益属性总账降级为下方“来源追溯”。</div>' +
        buffMatrix() +
        fold('展开 · 来源追溯（按系统 · 攻/守）', sideGrid(buffAttrDetail)),
    );
  // Ⅰ·单体编配（旧按来源/系统卡）——降级为单体级、置于空间轴末端，标题注明按系统追溯
  const entityCards = `
${cmpPanelCard(
  '⑨',
  '机甲（逐件：机体/部件/技能/芯片）',
  cmpAgg(['mecha_chip', 'mecha_skill', 'trace:MECHA']),
  mechaDetail,
  '聚合取 buff_effects 的 mecha_chip/mecha_skill/trace:MECHA 视图（芯片属性按名归并、万分比换算）；展开可见各机体名（Mecha 表）、部件、机甲主动技与每片芯片等级及属性。' +
    dynNote,
  { suffix: '单体编配·按系统追溯' },
)}
${cmpPanelCard(
  '⑩',
  '兵种装备（逐件：装备/部位/套装）',
  cmpAgg(['trace:ARMY_EQUIP', 'trace:INIT_ARMY_EQUIP'], null, KEZHI_RE),
  equipDetail,
  '兵种装备（army_equip 系统，非英雄装备）。聚合取 trace:ARMY_EQUIP/INIT_ARMY_EQUIP；逐件取 new_army_equips.equips + 旧 army_equips，按 pos 前 3 位判军种。' +
    dynNote,
  { suffix: '单体编配·按系统追溯' },
)}
${cmpPanelCard(
  '⑪',
  '装备强化（enhance_mastery · 军种强化精通）',
  cmpAgg(['army_mastery', 'trace:ENHANCE_MASTERY']),
  masteryDetail,
  '兵种装备强化/精通（enhance_mastery）。聚合取 army_mastery/trace:ENHANCE_MASTERY 视图；逐件取 side_players.army_mastery（若战报未下发则显示为空）。' +
    dynNote,
  { suffix: '单体编配·按系统追溯' },
)}
${cmpPanelCard(
  '⑬',
  '元素伤害（元素等级 · 实战元素伤害合计）',
  elemPairs(),
  elementDetail,
  '元素伤害合计取 battle_events.e_value 按 source→侧归属汇总（攻/守对比）；展开可见按军种的元素等级（sides.element_levels）。元素类型无干净中文战斗名，故按军种+原始 elementType 编号显示。' +
    dynNote,
  { suffix: '单体编配·按系统追溯' },
)}
${cmpPanelCard(
  '⑭',
  '异能兽（领域 · 几号位 · 兽属性/Buff）',
  cmpAgg(['enigma_beast', 'enigma_field']),
  enigmaCompare,
  '聚合取 buff_effects 的 enigma_beast/enigma_field 视图。逐领域对照：展开可见各领域（enigma_field，工/阵/兵/禁之域），领域名居中，中缝为该领域内的几号位（每个领域各自从 1 编号），攻方在左、守方在右按号位行行对齐；每格显示位上异能兽（名/兽等级/星级/战力）、位置等级、兽主/基础 buff 与该位增益（_buffs 已解名）。' +
    dynNote,
  {
    combined: true,
    detailLabel: '逐领域对照（攻/守 · 领域内几号位）',
    suffix: '单体编配·按系统追溯',
  },
)}`;
  // 阶段大标题
  const phaseHd = (zh, sub) => `<h1 class="phasehd">${zh}<span class="phsub">${sub}</span></h1>`;
  // 大章节：整章可折叠（默认展开），内部卡片直接展开不再各自收折
  const chapter = (title, sub, body, id = '') =>
    `<details class="chapter"${id ? ` id="${id}"` : ''} open><summary>${phaseHd(
      title,
      sub,
    )}</summary><div class="chapterbody">${body}</div></details>`;

  // 顶部粘性章节导航（纯锚点，无 JS）
  const SEC_ITEMS = [
    ['#a1', '① 战果总览'],
    ['#a2', '② 伤害构成'],
    ['#a3', '③ 回合分布'],
    ['#a4', '④ 属性对比'],
    ['#a5', '⑤ 差异归因'],
  ];
  const secnav = () =>
    `<nav class="secnav">${SEC_ITEMS.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>`;

  // 伤害构成：按 dmgAgg 维度（cat/branch/seq/hero）聚合成攻守 pairs
  const dmgDimPairs = (dim) => {
    const m = dmgAgg(dim);
    return [...m.entries()].map(([name, r]) => ({ name, att: sumMap(r.att), def: sumMap(r.def) }));
  };
  // 技能维度：跨来源类别把同名技能 label 的攻守伤害并起来
  const dmgSkillPairs = () => {
    const m = new Map();
    for (const side of ['att', 'def'])
      for (const [, sub] of dmgSrc[side])
        for (const [lbl, o] of sub) {
          const cur = m.get(lbl) || { att: 0, def: 0 };
          cur[side] += o.dmg;
          m.set(lbl, cur);
        }
    return [...m.entries()].map(([name, v]) => ({ name, att: v.att, def: v.def }));
  };
  // 维度可切换的伤害构成 tab（复用 .tabs + #tab-dmg CSS 联动，默认来源类别）
  const dmgTabs = () => {
    const dims = [
      ['来源类别', 'cat'],
      ['军种', 'branch'],
      ['英雄', 'hero'],
      ['技能', 'skill'],
    ];
    const radios = dims
      .map(
        ([lbl], i) =>
          `<input type="radio" name="tab-dmg" id="tab-dmg-${i}"${i === 0 ? ' checked' : ''}><label for="tab-dmg-${i}">${lbl}</label>`,
      )
      .join('');
    const panes = dims
      .map(
        ([, d]) =>
          `<div class="tpane">${divergingRows(d === 'skill' ? dmgSkillPairs() : dmgDimPairs(d))}</div>`,
      )
      .join('');
    return `<div class="tabs">${radios}<div class="tpanes">${panes}</div></div>`;
  };

  // 差值榜：按 |攻−守| 降序、分列领先方（用于第⑤幕客观归因）
  const topDiff = (pairs, n = 6) => {
    const act = pairs
      .filter((p) => (p.att || 0) !== (p.def || 0))
      .map((p) => ({ ...p, gap: (p.att || 0) - (p.def || 0) }));
    const mx = Math.max(1, ...act.map((p) => Math.abs(p.gap)));
    const line = (p, cls) =>
      `<div class="bar"><span class="bk" title="${esc(p.name)} · 攻 ${esc(vtFmt(p.att, p))} / 守 ${esc(vtFmt(p.def, p))}">${esc(shortFor(p.name))}</span><span class="rbc"><i class="bf${cls === 'd' ? ' d' : ''}" style="width:${(Math.abs(p.gap) / mx) * 100}%"></i></span><span class="bv">Δ ${esc(vtFmt(Math.abs(p.gap), p))}</span></div>`;
    const grp = (t, arr, cls) =>
      `<div><div class="${cls === 'd' ? 'defc' : 'attc'}" style="font-weight:700;margin-bottom:4px">${t}</div>${
        arr.length ? arr.map((p) => line(p, cls)).join('') : '<div class="mut">无领先项</div>'
      }</div>`;
    const attLead = act
      .filter((p) => p.gap > 0)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, n);
    const defLead = act
      .filter((p) => p.gap < 0)
      .sort((a, b) => a.gap - b.gap)
      .slice(0, n);
    return `<div class="grid2">${grp('攻方领先 Top' + n, attLead, 'a')}${grp('守方领先 Top' + n, defLead, 'd')}</div>`;
  };
  const roundDiffPairs = () =>
    [...roundAgg.entries()].map(([n, r]) => ({
      name: '第' + n + '回合',
      att: r.dealt.att,
      def: r.dealt.def,
    }));

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>战报 ${R}</title><style>
:root{--bg:#0f1420;--card:#171e2e;--line:#26324b;--txt:#dfe7f3;--mut:#7d8aa3;--att:#ff5b6a;--def:#4aa3ff;--hit:#38d39f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:20px}
.banner{background:linear-gradient(135deg,#1b2740,#141a2a);border:1px solid var(--line);border-radius:14px;padding:18px 22px;display:flex;justify-content:space-between;align-items:center}
.vs{font-size:26px;font-weight:800}.verdict{font-size:15px;color:var(--hit);font-weight:700}
.attc{color:var(--att)}.defc{color:var(--def)}
.side-h{display:flex;flex-direction:column;gap:2px}.side-h .nm{font-weight:700;font-size:16px}
.pwr{display:flex;align-items:center;gap:8px;margin-top:10px}.pwrbar{height:10px;border-radius:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-top:16px;padding:16px 18px}
.card h2{margin:0 0 12px;font-size:15px;color:var(--mut);letter-spacing:1px}
/* 时间×空间 阶段分区 */
.phase{margin-top:26px}
.phasehd{position:relative;z-index:1;margin:0 0 12px;padding:10px 16px;font-size:18px;font-weight:800;color:#fff;background:linear-gradient(135deg,#22304d,#141a2a);border:1px solid var(--line);border-left:4px solid var(--hit);border-radius:12px;display:flex;flex-direction:column;gap:2px}
.phasehd .phsub{font-size:12px;font-weight:400;color:var(--mut);letter-spacing:.3px}
/* 大章节：整章可折叠（默认展开），内部卡片直接展开 */
.chapter{margin-top:26px}
.chapter>summary{list-style:none;cursor:pointer;display:block}
.chapter>summary::-webkit-details-marker{display:none}
.chapter>summary .phasehd{position:relative;padding-right:74px}
.chapter>summary .phasehd::after{position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:400;color:var(--mut);content:'▾ 收起'}
.chapter:not([open])>summary .phasehd::after{content:'▸ 展开'}
.chapter:not([open])>summary .phasehd{margin-bottom:0}
.opsum{font-size:12px;font-weight:400;letter-spacing:0;color:var(--txt);background:#0e1524;border:1px solid var(--line);border-radius:6px;padding:1px 8px;margin-left:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.cmp{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:5px 0;border-bottom:1px dashed var(--line)}
.cmp .cl{color:var(--mut);padding:0 14px;font-size:13px}.cmp .cn{font-weight:700;text-align:center}
.heroes{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.heroes.v{flex-direction:column}
.heroes.v .hero{width:100%;flex:0 0 auto}
.hero{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-width:110px}
.hnm{font-weight:600}.hst{font-size:12px;color:var(--mut)}
.bar{display:grid;grid-template-columns:130px 1fr 56px;align-items:center;gap:8px;margin:4px 0}
.bk{font-size:12px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bf{height:12px;border-radius:6px;background:linear-gradient(90deg,#8a3b46,#ff5b6a)}
.bf.d{background:linear-gradient(90deg,#3b6ea5,#4aa3ff)}.bf.e{background:linear-gradient(90deg,#4aa36b,#38d39f)}
.bv{font-size:12px;text-align:right}
.tl{display:flex;align-items:flex-end;gap:2px;height:90px;margin-top:6px}
.tb{flex:1;background:linear-gradient(180deg,#4aa3ff,#2a5a8a);border-radius:2px 2px 0 0}
.rhythm{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.rbrow{display:grid;grid-template-columns:72px 1fr 210px 1fr 72px;align-items:center;gap:8px}
.rbl{font-size:12px;color:var(--mut);text-align:center}
.rbc{height:12px;background:#232d42;overflow:hidden;display:flex}
.rbc.a{justify-content:flex-end;border-radius:6px 0 0 6px}
.rbc.d{justify-content:flex-start;border-radius:0 6px 6px 0}
.rbc .bf{height:100%}
.rbv{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.rbv.l{text-align:right}
.rbv.r{text-align:left}
table{width:100%;border-collapse:collapse;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.cell{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:8px;min-height:62px}
.cell.empty{opacity:.35}.cpos{font-size:10px;color:var(--mut)}.cname{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmeta{font-size:11px;color:var(--mut);margin-top:4px}.dead{color:var(--mut)}
.btag{font-size:10px;padding:0 5px;border-radius:4px;background:#1a2236;color:#9aa7bd;border-left:2px solid transparent;line-height:1.6}.b陆军{border-left-color:#5a8a5a}.b海军{border-left-color:#5a86b0}.b空军{border-left-color:#a8955a}
.mat{margin-top:4px}.mat th{background:#0e1524;padding:6px;text-align:center;font-size:12px;color:var(--mut)}.mat td{border:1px solid var(--line);text-align:center;padding:6px}
.brtag{display:inline-block;font-size:12px;padding:2px 10px;border-radius:6px;margin-bottom:6px;font-weight:600;color:#fff}
.attr-list{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:6px 12px}
.arow{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--line)}
.arow:last-child{border-bottom:0}
.ak{color:var(--mut)}.av{font-weight:700;font-variant-numeric:tabular-nums}
.mat .an{text-align:left;color:var(--txt)}.mat .mv{font-variant-numeric:tabular-nums}
.mut{color:var(--mut)}.note{font-size:11px;color:var(--mut);margin-top:6px}
.hero{min-width:210px;max-width:100%;flex:1 1 210px}
.hsec{font-size:11px;color:var(--txt);margin-top:3px;line-height:1.45;word-break:break-all}
.hlbl{color:var(--mut);margin-right:5px}
.hgrp{display:flex;align-items:flex-start;gap:6px;margin-top:5px}
.hgrp .hlbl{flex:0 0 46px;padding-top:2px}
.chips{display:flex;flex-wrap:wrap;gap:4px;flex:1}
.chip{display:inline-flex;align-items:center;gap:3px;font-size:11px;line-height:1;padding:3px 7px;border-radius:6px;border:1px solid var(--line);background:#0e1524;white-space:nowrap}
.chip b{font-weight:700;color:var(--txt)}
.chip.aw{border-color:#5a4a2a;background:#241d0e}.chip.aw b{color:#e6c35c}
.chip.sk{border-color:#2a4a6a;background:#0e1a24}.chip.sk b{color:#6bb3e6}
.chip.tal{border-color:#3a5a2a;background:#12200e}.chip.tal b{color:#8fce7a}
.chip.sci{border-color:#4a3a6a;background:#181224}.chip.sci b{color:#b79ce6}
.chip.eqp{border-color:#3a4256;background:#141a28}.chip.eqp b{color:#c3cede}
.chip .stn{font-style:normal;font-size:10px;margin-left:3px;padding:0 4px;border-radius:4px;line-height:1.6;background:#2a2150;color:#c1a6ff}
.chip .rq{font-style:normal;font-size:10px;margin-left:2px;padding:0 4px;border-radius:4px;line-height:1.5}
.rq.rar{background:#2a2150;color:#c1a6ff}.rq.nor{background:#1b2740;color:#7d8aa3}
/* 对比行（攻左红/守右蓝，共用标尺） */
.vr{display:grid;grid-template-columns:72px 1fr 210px 1fr 72px;align-items:center;gap:8px;margin:4px 0}
.vrn{display:grid;grid-template-columns:1fr 72px;align-items:center;column-gap:4px;min-width:0;font-size:12px;color:var(--txt)}
.vrn .nm{font-weight:400;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35;text-align:center}
.vrh{height:12px;background:#1a2336;display:flex;overflow:hidden}
.vrh.l{justify-content:flex-end;border-radius:6px 0 0 6px}
.vrh.r{justify-content:flex-start;border-radius:0 6px 6px 0}
.vrbar{height:100%}
.vrbar.a{background:linear-gradient(90deg,#8a3b46,#ff5b6a)}
.vrbar.d{background:linear-gradient(90deg,#4aa3ff,#2f6da5)}
.vrbar.dim{opacity:.4}
.vrv{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.vrv.l{text-align:right}
.vrv.r{text-align:left}
.vrv.mut{font-weight:400}
.dlt{grid-column:2;justify-self:start;color:var(--mut);font-size:10px;font-weight:400;white-space:nowrap}
/* 增益生效矩阵：时机列表头 */
.mtkh{font-size:11px;font-weight:600;color:var(--mut);margin:9px 0 2px;padding-bottom:2px;border-bottom:1px solid var(--line);letter-spacing:.5px}
.mtkh.dyn{color:#9a8a4a}
.dynhint{font-size:11px;margin:2px 0 6px;line-height:1.5}
/* 折叠卡 */
.ccard>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ccard>summary::-webkit-details-marker{display:none}
.ccard>summary::before{content:'▸';color:var(--mut);font-size:12px}
.ccard[open]>summary::before{content:'▾'}
.ccard>summary .ctitle{font-size:15px;color:var(--mut);letter-spacing:1px;font-weight:600}
.ccard[open]>summary .ctitle{color:var(--txt)}
.ccard>summary .sm{font-size:12px;color:var(--txt);background:#0e1524;border:1px solid var(--line);border-radius:6px;padding:1px 8px}
.cbody{margin-top:12px}
/* 魔石等级/品质 */
.chip .stn b{font-weight:700;margin-left:2px}
.chip .stn.q1{background:#1b2740;color:#8aa0bd}
.chip .stn.q2{background:#2a2150;color:#c1a6ff}
.chip .stn.q3{background:#3a2a12;color:#e6c35c}
.fsci{display:flex;align-items:flex-start;gap:6px;margin:6px 0 2px}
.formband{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding-bottom:12px;margin-bottom:6px;border-bottom:1px dashed var(--line)}
.formttl{font-weight:700;font-size:14px;margin-bottom:2px}
.teamblk{margin-top:12px}
.teamhd{font-size:13px;font-weight:700;margin-bottom:4px}
.cell.mas{border-color:#e6c35c;box-shadow:inset 0 0 0 1px #e6c35c,0 0 10px #e6c35c33}
.mtag{font-size:10px;color:#e6c35c;background:#241d0e;border:1px solid #5a4a2a;border-radius:4px;padding:0 5px}
.crow{display:flex;justify-content:space-between;align-items:center;gap:4px}
.cbar{height:5px;border-radius:3px;background:#232d42;overflow:hidden;margin-top:5px}
.calive{display:block;height:100%}
.g-att .calive{background:linear-gradient(90deg,#ff6b76,#a83f4a)}
.g-def .calive{background:linear-gradient(90deg,#6bb0ff,#2f6da5)}
.cstat{display:flex;justify-content:space-between;font-size:11px;margin-top:4px}
.g-att .cstat .ok{color:var(--att)}.g-def .cstat .ok{color:var(--def)}
.cstat .dead{color:var(--mut)}
.casbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#0e1524;margin:6px 0 4px}
.casbar .cb{display:block;height:100%}
.cas-att .cb.sv{background:#ff6b76}.cas-att .cb.wd{background:#b57a55}.cas-att .cb.dd{background:#6e3a44}
.cas-def .cb.sv{background:#6bb0ff}.cas-def .cb.wd{background:#4f7ba8}.cas-def .cb.dd{background:#2c4a68}
.caslegend{display:flex;gap:12px;font-size:11px;margin-bottom:6px}
.cas-att .caslegend .ok{color:#ff6b76}.cas-att .caslegend .wdl{color:#c08a5a}.cas-att .caslegend .dead{color:#9a7070}
.cas-def .caslegend .ok{color:#6bb0ff}.cas-def .caslegend .wdl{color:#6a8fb5}.cas-def .caslegend .dead{color:#6a7a8a}
.tabs>input{display:none}
.tabs>label{display:inline-block;padding:3px 12px;border-radius:8px;background:#0e1524;border:1px solid var(--line);color:var(--mut);cursor:pointer;font-size:12px;margin:0 6px 6px 0}
.tabs>input:checked+label{color:#fff;background:#26324b;border-color:#3b6ea5}
.tpanes>.tpane{display:none;background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:6px 12px}
#tab-br-0:checked~.tpanes>.tpane:nth-child(1),#tab-br-1:checked~.tpanes>.tpane:nth-child(2),#tab-br-2:checked~.tpanes>.tpane:nth-child(3){display:block}
#tab-dmg-0:checked~.tpanes>.tpane:nth-child(1),#tab-dmg-1:checked~.tpanes>.tpane:nth-child(2),#tab-dmg-2:checked~.tpanes>.tpane:nth-child(3),#tab-dmg-3:checked~.tpanes>.tpane:nth-child(4){display:block}
/* 回合×空间 热力表 */
.hxwrap{overflow-x:auto}
.hx{border-collapse:collapse;width:100%;font-size:11px;font-variant-numeric:tabular-nums}
.hx th,.hx td{border:1px solid var(--line);padding:3px 5px;text-align:center;white-space:nowrap}
.hx th{background:#0e1524;color:var(--mut);font-weight:600}
.hx .rk{position:sticky;left:0;background:#141a2a;text-align:left;z-index:1;font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis}
.hx tfoot td{background:#0e1524;color:var(--txt);font-weight:700}
.hcell{padding:2px !important}
.ha,.hd{display:block;min-width:38px;padding:1px 4px;border-radius:3px;margin:1px auto;color:#fff;line-height:1.5}
.rkt{color:var(--mut)}
/* 顶部阵型位置面板（静态 · 随页面滚动、不钉固） */
.formbar{margin:14px 0 6px;padding:10px 14px;background:linear-gradient(135deg,#1b2740,#141a2a);border:1px solid var(--line);border-radius:12px}
.rnavhd{font-weight:700;font-size:13px;margin-bottom:6px}
.formlayout{display:grid;grid-template-columns:1fr 1fr;gap:16px}
/* 章内钻取明细：一律展开、无收起 */
.dnode{margin:8px 0;padding:6px 10px;background:#0e1524;border:1px solid var(--line);border-radius:8px}
.dnode-t{font-size:12px;color:var(--mut);font-weight:600;letter-spacing:.3px;margin-bottom:2px}
.dx{margin:4px 0 8px}
.dnode.fgrp{background:transparent;border:none;border-top:1px dashed var(--line);border-radius:0;padding:6px 0;margin:6px 0}
.dnode.fgrp .dnode-t{color:var(--txt);text-align:center}
/* 逐件/明细折叠层（默认收起） */
.dnode.dfold>summary.dnode-t{cursor:pointer;list-style:none;position:relative;padding-right:58px}
.dnode.dfold>summary.dnode-t::-webkit-details-marker{display:none}
.dnode.dfold>summary.dnode-t::after{content:'▸ 展开';position:absolute;right:2px;top:0;font-size:11px;font-weight:400;color:var(--mut)}
.dnode.dfold[open]>summary.dnode-t::after{content:'▾ 收起'}
.dnode.dfold:not([open])>.dx{display:none}
/* 顶部粘性章节导航 */
.secnav{position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;margin:0 0 6px;background:rgba(20,26,42,.96);border:1px solid var(--line);border-radius:10px;backdrop-filter:blur(3px)}
.secnav a{flex:1 1 auto;text-align:center;text-decoration:none;color:var(--mut);font-size:13px;font-weight:600;padding:5px 8px;border-radius:8px;background:#0e1524;border:1px solid var(--line)}
.secnav a:hover{color:#fff;border-color:#3b6ea5}
.erow{display:grid;grid-template-columns:1fr 210px 1fr;align-items:start;gap:10px;padding:5px 0;border-top:1px solid var(--line)}
.erow:first-child{border-top:none}
.epos{grid-column:2;text-align:center;font-weight:700;font-size:11px;color:var(--txt);padding-top:2px}
.ec{min-width:0}
.ec.a{text-align:right}
.ec.d{text-align:left}
.ecb{font-size:12px;line-height:1.5}
.ecb .chip{margin:0 2px}
.ecbf{font-size:11px;color:var(--mut);line-height:1.5;margin-top:1px}
.ecbf b{color:var(--txt);font-weight:600}
.slv{font-style:normal;color:var(--mut);font-size:11px;margin-left:4px}
.mi{background:#0e1524;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}
.mihd{font-weight:700;font-size:13px;margin-bottom:4px}
.mic{display:flex;align-items:flex-start;gap:6px;margin:3px 0;font-size:12px}
.mic>.hlbl{flex:0 0 40px;color:var(--mut);padding-top:2px}
.chiplist{flex:1;min-width:0}
.mineline{margin:2px 0;font-size:12px;color:var(--txt);word-break:break-word}
.mineline b{font-weight:700}.mineline i{font-style:normal;color:var(--mut);font-size:11px;margin-left:2px}
.chip .src{font-style:normal;font-size:10px;color:var(--mut);margin-left:4px;opacity:.8}
</style></head><body><div class="wrap">

<div class="banner">
  <div class="side-h"><span class="nm attc">${esc(A.info.username || '攻方')}</span><span class="mut">${esc(A.career)}</span></div>
  <div style="text-align:center"><div class="vs">⚔</div><div class="verdict">${rep.result === 1 ? '攻方胜' : rep.result === 2 ? '守方胜' : '平局/未知'}</div></div>
  <div class="side-h" style="align-items:flex-end"><span class="nm defc">${esc(D.info.username || '守方')}</span><span class="mut">${esc(D.career)}</span></div>
</div>
<div class="pwr"><span class="attc">${esc(march.att_battle_power || fmt(march.att_battle_power_val))}</span><span class="pwrbar" style="flex:${(march.att_battle_power_val || 1) / 1e8};background:var(--att)"></span><span class="mut">战力</span><span class="pwrbar" style="flex:${(march.def_battle_power_val || 1) / 1e8};background:var(--def)"></span><span class="defc">${esc(march.def_battle_power || fmt(march.def_battle_power_val))}</span></div>
<div class="note">fight_type=${rep.fight_type} · 超轮 att=${march.att_over_round ?? '-'}/def=${march.def_over_round ?? '-'} · 时长≈${fmt(battleMs)}ms</div>

${secnav()}

${chapter(
  '① 战果总览 · 谁赢 / 差多少 / 几个回合 / 战损几何',
  '胜负与总量、命中暴击闪避、存活受伤阵亡、阵型落点与逐槽战损',
  openCard(
    '战果一览',
    `共 ${roundBins.N} 回合 · ${rep.result === 1 ? '攻方胜' : rep.result === 2 ? '守方胜' : '平局/未知'}`,
    cmpRow('总输出伤害', acc.att.dmg, acc.def.dmg) +
      cmpRow('命中', acc.att.hit, acc.def.hit) +
      cmpRow('暴击', acc.att.crit, acc.def.crit) +
      cmpRow('闪避', acc.att.miss, acc.def.miss) +
      cmpRow('存活', A.sd.survival, D.sd.survival) +
      cmpRow('受伤', A.sd.wounded, D.sd.wounded) +
      cmpRow('阵亡', A.sd.dead, D.sd.dead) +
      `<div class="note">共 ${roundBins.N} 回合 · 战力 ${esc(march.att_battle_power || fmt(march.att_battle_power_val))} vs ${esc(march.def_battle_power || fmt(march.def_battle_power_val))} · 命中率 att=${pct(acc.att.hit / (acc.att.hit + acc.att.crit + acc.att.miss || 1))} · def=${pct(acc.def.hit / (acc.def.hit + acc.def.crit + acc.def.miss || 1))} · 超轮 att=${march.att_over_round ?? '-'}/def=${march.def_over_round ?? '-'} · 时长≈${fmt(battleMs)}ms。fight_type=${rep.fight_type}（协议码 · 非未翻译项）。</div>`,
  ) +
    formationPanel() +
    fold('展开 · 战损空间分布明细（军种 × 阵型槽位 · 存活/阵亡）', lossBySpace()),
  'a1',
)}

${chapter(
  '② 伤害构成 · 双方伤害分别由什么组成',
  '按来源类别 / 军种 / 英雄 / 技能维度攻守并排 · 可下钻到具体技能',
  openCard(
    '伤害构成（可切换维度 · 攻左红 / 守右蓝 · 共用标尺）',
    cmpSummary(dmgPairs()),
    dmgTabs() +
      `<div class="note">维度可切换：来源类别 / 军种 / 英雄 / 技能。每行两端同标尺，条长按该维度全局最大值归一；Δ 为攻守差。承伤＝对侧造成，各维度合计均＝① 总输出伤害（同源 dmgCells）。</div>` +
      fold('展开 · 各来源类别 → 具体技能明细（攻守对比）', dmgDetail()) +
      fold(
        '展开 · 各侧伤害占比（按来源类别 / 按英雄）',
        `<div class="grid2"><div><div class="attc" style="font-weight:700">攻方 · 按来源类别</div>${dmgShare('att', 'cat')}<div class="attc" style="font-weight:700;margin-top:10px">攻方 · 按英雄</div>${dmgShare('att', 'hero')}</div><div><div class="defc" style="font-weight:700">守方 · 按来源类别</div>${dmgShare('def', 'cat')}<div class="defc" style="font-weight:700;margin-top:10px">守方 · 按英雄</div>${dmgShare('def', 'hero')}</div></div>`,
      ),
  ) +
    openCard('技能释放榜（全场合计）', cmpSummary(castPairs()), divergingRows(castPairs())) +
    openCard(
      '状态 / Buff 施加 Top（全场合计）',
      cmpSummary(buffPairs()),
      divergingRows(buffPairs()) +
        `<div class="note">增益施加 攻${[...buffApply.att.values()].reduce((a, b) => a + b, 0)} / 守${[...buffApply.def.values()].reduce((a, b) => a + b, 0)} 次 · 移除 攻${buffRemove.att} / 守${buffRemove.def} 次。命名链：effect_buff.string → 递归 SkillId → Mecha_skill 反查 → type-sibling 启发 → 事件 buff_name/skill_name → _name↔_desc 互换 → Mecha_chip → 类型码。</div>`,
    ),
  'a2',
)}

${chapter(
  '③ 回合分布 · 每回合各造成多少 / 节奏',
  '回合×军种/类别热力 + 逐回合攻守造成与主导来源',
  roundOverview() +
    fold('展开 · 回合 × 来源类别 热力（高伤来自哪类·哪回合）', dmgRoundMatrix('cat')) +
    roundTimeline(),
  'a3',
)}

${chapter(
  '④ 部件属性对比 · 每个部件属性构成 + 双方差异核对',
  '军种基础 + 增益属性汇总 + 逐部件（机甲/装备/强化/元素/异能兽）与阵容',
  openCard(
    '军种基础属性（陆/海/空 TAB · 逐属性攻守对比）',
    '选定军种后六项属性 + 出征数逐行对比',
    attrCompare() +
      `<div class="note">陆/海/空共用一个军种切换（默认定格攻方出征数最大军种）。属性含全军加成回流；防御加成=本军种防御+全军防御；按万分比(÷100)显示%，出征数取 side_units.uuid_count。左红=攻、右蓝=守。</div>`,
  ) +
    openCard(
      '增益属性汇总对照（按属性名跨部件累加 · 攻守并排）',
      cmpSummary(cmpAgg('*', BUFF_ATTR_RE)),
      divergingRows(cmpAgg('*', BUFF_ATTR_RE)) +
        `<div class="note">把各部件（机甲/芯片/装备/魔石/天赋/军阵专精/异能兽）的同名增益属性累加后攻守并排，一眼看总差异；逐系统来源见下方“全局增益总账”与“逐部件”卡。</div>`,
    ) +
    buffGlobalCard() +
    openCard(
      '单体 阵容对照（军阵 + 英雄/泰坦装备/魔石）',
      `攻 ${A.heroes.length} 将 · 守 ${D.heroes.length} 将`,
      `<div class="formband">
    <div class="formcol"><div class="formttl attc">攻方 · ${esc(A.form._name || '军阵')} ${A.form.lv ? 'Lv' + A.form.lv : ''}${A.form.quality ? ' · Q' + A.form.quality : ''}</div>${scienceHtml(A.form)}</div>
    <div class="formcol"><div class="formttl defc">守方 · ${esc(D.form._name || '军阵')} ${D.form.lv ? 'Lv' + D.form.lv : ''}${D.form.quality ? ' · Q' + D.form.quality : ''}</div>${scienceHtml(D.form)}</div>
  </div>
  <div class="grid2">
    <div class="teamblk"><div class="teamhd attc">攻方英雄</div><div class="heroes v">${heroCard(A.heroes)}</div></div>
    <div class="teamblk"><div class="teamhd defc">守方英雄</div><div class="heroes v">${heroCard(D.heroes)}</div></div>
  </div>`,
    ) +
    entityCards,
  'a4',
)}

${chapter(
  '⑤ 差异归因 · 差值最大的项（客观排序）',
  '伤害来源 / 增益属性 / 回合 三张差值榜，定位高伤害成因',
  openCard('伤害来源差值榜', cmpSummary(dmgPairs()), topDiff(dmgPairs(), 6)) +
    openCard('增益属性差值榜', '', topDiff(cmpAgg('*', BUFF_ATTR_RE), 8)) +
    openCard('回合差值榜（哪个回合攻守拉开）', '', topDiff(roundDiffPairs(), 8)) +
    `<div class="note">三张表均按 |攻−守| 降序、分列领先方（Δ 为差值）；仅呈现客观差值排序，具体成因解读留 P4。</div>`,
  'a5',
)}

<div class="note" style="text-align:center;margin:20px 0">warroom 单场战报事实样张 · ${R} · 纯客观数据，解读留 P4</div>
</div></body></html>`;

  mkdirSync(resolve(here, '../analysis'), { recursive: true });
  const out = join(resolve(here, '../analysis'), R + '.html');
  writeFileSync(out, html, 'utf8');
  db.close();
  return out;
}
