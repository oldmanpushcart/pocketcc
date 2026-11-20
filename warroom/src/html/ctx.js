// 渲染层·字典上下文：只依赖 (db, dictVersion) 的名称解析与技能/增益命名链。
// 与「单场取数」（data.js）分离，便于视图层只接一个 ctx 就能解名、不必回头碰 db。
import { resolveName, localeText } from '../dict.js';

/**
 * @param {import('better-sqlite3').Database} db 只读 warroom.db
 * @param {string} version 该场解析所用字典版本（reports.dict_version）
 * @returns 名称解析与格式化工具集
 */
export function makeCtx(db, version) {
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
  // Map<数值> 求和（攻守并排的行列合计原语，数据层与热力表共用）
  const sumMap = (mp) => [...mp.values()].reduce((a, b) => a + b, 0);
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
  const dictName = (table, id) => resolveName(db, version, table, id);
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
        const skillName = dictName('hero_skill', row.para1);
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
      // 兄弟行必须全表扫：当前字典 effect_buff 有 2,792 行，加过 `LIMIT 2000` 时同 type 的兄弟落在
      // 截断区外就解不出名（实测少解 1 个觉醒授予增益），是一类静默假阴性；typeNameCache 已保证每种 type 只扫一次。
      const siblings = db
        .prepare(
          `SELECT value FROM dict_entries WHERE dict_version=? AND category='table:effect_buff'`,
        )
        .all(version);
      for (const s of siblings) {
        const sr = JSON.parse(s.value);
        if (String(sr.type) === t && sr.paraType1 === 'SkillId') {
          const sn = dictName('hero_skill', sr.para1);
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
    const nm = dictName('army', id) || '#' + id;
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
  const loc = (k) => (k == null ? null : localeText(db, version, k));
  const rowsOf = (cat) =>
    db
      .prepare(`SELECT value FROM dict_entries WHERE dict_version=? AND category=?`)
      .all(version, 'table:' + cat)
      .map((r) => J(r.value));

  // ── 通用「表 → 中文名」解析（装饰/皮肤/军阵等新建模块共用）──
  // 各表名字字段名不统一（name / chip_name / group_name / mastery_name / exhibition_name…），
  // 故按候选字段依次取值，再走 tryLocale（含 _name↔_desc 兑底）→ loc；全失败返回 null 由调用方回落 #id。
  const nameOf = (table, id, fields = ['name']) => {
    const row = dictRow(table, id);
    if (!row) return null;
    for (const f of fields) {
      const v = row[f];
      if (v == null || v === '') continue;
      const n = tryLocale(v) || loc(v);
      if (n && cjk(n) && !isDescName(n)) return n;
    }
    return null;
  };
  /** nameOf 的带兜底版本：解不到中文名时显示 `<prefix>#<id>`，绝不显示裸 locale 键。 */
  const namedOr = (table, id, prefix, fields) => nameOf(table, id, fields) || `${prefix}#${id}`;

  // ── 技能/状态名字↔描述 双向索引 ────────────────────
  // 来源：hero_skill(name↔desc) / formationV2_mastery(mastery_name↔mastery_desc[_new]) / Mecha_skill(name↔desc)
  // 目的：榜单 label 统一展示名字；鼠标停留 title 展示描述。描述串与榜单同用 subSkillIds 回填 <id=>。
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
    return str.replace(/\{(\d+)\}(%?)/g, (m, i, pc) => {
      const v = arr[Number(i)];
      if (!Number.isFinite(v)) return m;
      const s = fmtNum(pc ? v / 100 : v);
      return s == null ? m : s + (pc || '');
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
      (row.paraType1 === 'SkillId' ? dictName('hero_skill', row.para1) : null) ||
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

  // 伤害来源分类所需的技能索引（纯字典，不含单场数据）
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
  const heroSkillName = (id) => dictName('hero_skill', id);
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
      dictName('Mecha_skill', id) ||
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
        okName(dictName('Mecha_skill', t));
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

  // 军种基础属性表：面板每行对应一个规范 group（divide 已把「全部单位」回流进本军种父组）
  const ATTRS = ['防御加成', '生命加成', '攻击加成', '伤害加深', '伤害减免'];
  const GROUP_CANON = {
    生命: { 陆军: 930001, 海军: 930002, 空军: 930003 },
    攻击: { 陆军: 930101, 海军: 930102, 空军: 930103 },
    伤害加深: { 陆军: 980101, 海军: 980102, 空军: 980103 },
    伤害减免: { 陆军: 980201, 海军: 980202, 空军: 980203 },
    防御: { 陆军: 990203, 海军: 990204, 空军: 990205 },
  };
  const QJ_DEF_GROUP = 990202; // 全军防御能力提升
  const BRANCHES = ['陆军', '海军', '空军'];
  const DMG_KINDS = ['Attack', 'DebuffHurt', 'MissAttack', 'HeroAttack'];
  const DMG_CAT_ORDER = [
    '普通攻击',
    '英雄主动技能',
    '装备技能',
    '觉醒技能',
    '军阵精通',
    '机甲',
    '其他来源',
  ];
  const APPLIED_KINDS = [
    'AddSkillBuff',
    'ArmyAddBuff',
    'HeroAddBuff',
    'ADDMUTIBUFFS',
    'MechaMainChipBuff',
    'HeroEquipSkillBuff',
    'UPDATENUMBUFF',
    'ADD_BUFF_WITH_NUM',
  ];
  const KEZHI_RE = /(陆军|海军|空军)对(陆军|海军|空军)|兵种克制/;
  // 增益属性总账：兵种克制（X对Y）+ 伤害加深/伤害减免（含全体/部队/前排·前二排等）
  const BUFF_ATTR_RE = /(陆军|海军|空军)对(陆军|海军|空军)|兵种克制|伤害加深|伤害减免/;

  return {
    db,
    version,
    // 基础格式化
    J,
    fmt,
    pct,
    sumMap,
    esc,
    cjk,
    okName,
    isDescName,
    // 字典访问
    dictRow,
    dictName,
    rowsOf,
    loc,
    tryLocale,
    nameOf,
    namedOr,
    // 兵种
    BR,
    BRANCHES,
    armyName,
    armyBranch,
    // 属性口径常量
    ATTRS,
    GROUP_CANON,
    QJ_DEF_GROUP,
    DMG_KINDS,
    DMG_CAT_ORDER,
    APPLIED_KINDS,
    KEZHI_RE,
    BUFF_ATTR_RE,
    // 技能 / 增益命名链
    subSkillIds,
    dispNameDesc,
    mechaSkillIdx,
    mechaSkillIds,
    resolveBuffName,
    resolveBuffNameExt,
    resolveChipName,
    buffValText,
    heroSkillName,
    skillNameAny,
    skillRarity,
    dmgCategory,
    namedSkillRef,
    buffDisplayName,
    eventSkillRow,
    skillInflictedStatuses,
  };
}
