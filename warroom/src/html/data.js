// 渲染层·取数与归因：单场战报的 DB 读取、battle_events 累加、字典解名与攻守 pairs 归因。
// 只产出数据（对象 / 数组 / 名称 / 数值），不产出 HTML 字符串；视图层（home / battle / round）按需取用。
/**
 * @param {ReturnType<import('./ctx.js').makeCtx>} ctx 字典上下文（见 ctx.js）
 * @param {string|number} R report_id
 */
export function makeData(ctx, R) {
  const {
    db,
    version,
    J,
    sumMap,
    cjk,
    dictRow,
    dictName,
    rowsOf,
    loc,
    tryLocale,
    isDescName,
    nameOf,
    BRANCHES,
    armyBranch,
    GROUP_CANON,
    QJ_DEF_GROUP,
    DMG_KINDS,
    APPLIED_KINDS,
    subSkillIds,
    dispNameDesc,
    skillNameAny,
    dmgCategory,
    buffDisplayName,
    BUFF_ATTR_RE,
    KEZHI_RE,
  } = ctx;
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
  // 九宫格：side_units seq 0..8；troops 保留逐兵种全列（出征/阵亡/战力/护盾/元素战力/是否增援）
  // uuids 列另用来建「槽位 ↔ 单位实例」映射（逐槽承伤归位），故一并取出。
  const grid = { att: Array(9).fill(null), def: Array(9).fill(null) };
  const troops = { att: [], def: [] };
  const seqByUuid = new Map(); // uuid -> {side, seq}；只在单场范围内建（uuid 跨场会数字碰撞）
  for (const r of db
    .prepare(
      `SELECT side,seq,army_id,is_extra,max_power,max_shield,max_element_power,uuid_count,dead_count,uuids FROM side_units WHERE report_id=? ORDER BY side,seq`,
    )
    .all(R)) {
    if (troops[r.side]) troops[r.side].push(r);
    if (r.seq >= 0 && r.seq < 9) grid[r.side][r.seq] = r;
    for (const u of J(r.uuids)) {
      if (u && u.uuid != null) seqByUuid.set(String(u.uuid), { side: r.side, seq: r.seq });
    }
  }

  const inst = new Map();
  for (const r of db
    .prepare(`SELECT uuid, side, army_id FROM unit_instances WHERE report_id=?`)
    .all(R))
    inst.set(String(r.uuid), r);

  const evs = db
    .prepare(
      `SELECT idx,tl,power,source,target,val,e_type,e_value,kind,outcome,hero_name,skill_name,skill,buff_name,buff_id,buff_type,buff_sustained FROM battle_events WHERE report_id=? ORDER BY idx`,
    )
    .all(R);
  const acc = {
    att: { hit: 0, crit: 0, miss: 0, dmg: 0 },
    def: { hit: 0, crit: 0, miss: 0, dmg: 0 },
  };
  // 逐槽承伤金额：伤害事件按 target -> side_units.uuids 归到 (side, seq)。
  // 键取 `side|seq`：side_units 除了 seq 0..8 还有 seq 9/10 的增援溢出格（12 行），用数组会静默溢出成 NaN。
  // 归不到槽位的那部分单列出来（不静默归入 0），汇总时用作对账差额。
  const slotTaken = new Map(); // `side|seq` -> { hurt, hits }
  const takenUnresolved = { n: 0, amt: 0 };
  const dmgSrc = { att: new Map(), def: new Map() }; // 伤害来源类别 → (具体来源 label → {dmg, desc})
  const skillCast = { att: new Map(), def: new Map() }; // 技能释放次数（按显示名）
  const buffApply = { att: new Map(), def: new Map() }; // 增益施加次数（按命名链显示名）
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
    if (isDmg && dealt > 0 && e.target != null) {
      const slot = seqByUuid.get(String(e.target));
      if (slot) {
        const k = `${slot.side}|${slot.seq}`;
        let cell = slotTaken.get(k);
        if (!cell) slotTaken.set(k, (cell = { hurt: 0, hits: 0 }));
        cell.hurt += dealt;
        cell.hits++;
      } else {
        takenUnresolved.n++;
        takenUnresolved.amt += dealt;
      }
    }
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
    if (APPLIED_KINDS.includes(e.kind)) {
      const nm = buffDisplayName(e);
      const nmShown = nm ? subSkillIds(nm) : nm;
      if (nmShown && side) buffApply[side].set(nmShown, (buffApply[side].get(nmShown) || 0) + 1);
    }
    if (e.kind === 'RemoveSkillBuff' && side) buffRemove[side]++;
  }

  // 属性矩阵：复刻游戏 BattleReportComparisonPanel.AddOneBuffToBuffPool
  // 按 effect_buff.group 聚合；buff_divide 使「全部单位」子组回流进本军种父组；FightType_show 过滤攻守/战斗类型
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
  // 每 side × 军种的出征数（uuid_count 汇总），默认定格出征数最大的军种 TAB
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

  const sideMeta = (s) => {
    const sd = sides[s] || {};
    const pl = players[s] || {};
    const info = J(pl.player_info) || {};
    const heroes = J(pl.hero_list) || [];
    const form = J(pl.formation_v2) || {};
    const career = sd.career != null ? dictName('selection_v2', sd.career) || sd.career : '-';
    return { info, heroes, form, career, sd };
  };
  const A = sideMeta('att'),
    D = sideMeta('def');

  // ── 装饰 / 皮肤 / 跨服收藏 blob（战斗·装饰子模块）──────────────
  // normalize 已把 _suits/_sublimes/_own*/_use* 解好名；ctc 与装饰件 id 未富化，由本层按需解名。
  const decoBlob = (s) => J(players[s].effect_decorations) || {};
  const skinBlob = (s) => J(players[s].effect_skins) || {};
  const ctcBlob = (s) => J(players[s].ctc) || {};
  // 跨服收藏：collects[{id,lv}] → cross_treasure_collection（名称/品质/积分）+ 该档位的 buff 原串
  // 档位表 key 为自增 id，故按 collection_spec_id|level 建索引
  const ctcLevelRows = new Map();
  for (const r of rowsOf('cross_treasure_collection_level')) {
    const k = `${r.collection_spec_id}|${r.level}`;
    if (!ctcLevelRows.has(k)) ctcLevelRows.set(k, r);
  }
  const ctcInfo = (id, lv) => {
    const r = dictRow('cross_treasure_collection', id);
    if (!r) return null;
    const lr = ctcLevelRows.get(`${id}|${lv}`);
    return {
      name: nameOf('cross_treasure_collection', id),
      quality: r.quality,
      score: r.score,
      buff: lr ? lr.buff : null,
    };
  };
  // 装饰件解名：`sublimes[].id`、`ids[]`、套装 `content` 成员一律是 table:building 主键
  // （实测全库 44,179 个拥有件 id 100% 命中 building、99.9% 解出中文名）。
  // 同一装饰的 15 个等级形态共用一个 name 键、id 连号递增，故 building.level 就是形态等级（1..15）；
  // building.buff_id 是该形态的摆放增益原串（如 930001|600），与 sublimes[].buffs（升华增益）两个维度。
  // building 的 name 键偶有纯代号名（实测 43400..43403 → locale「F-1」，不含中文），而 nameOf/tryLocale
  // 的「含中文」判据会误杀，故另走一次 locale 直查：解出的文本与原键不同且非长描述即认。
  const buildingName = (row) => {
    for (const f of ['name', 'desc']) {
      const v = row?.[f];
      if (v == null || v === '') continue;
      const t = loc(v);
      if (t && String(t) !== String(v) && !isDescName(t)) return String(t);
    }
    return null;
  };
  const decoItem = (id) => {
    const r = dictRow('building', id);
    return {
      id,
      name: nameOf('building', id) || buildingName(r),
      level: r ? (r.level ?? null) : null,
      buff: r ? (r.buff_id ?? null) : null,
    };
  };
  // 套装：decoration_contents.content = 成员 building id 串（|分隔）。全字典 23 行的 buff
  // 一律为「123014|1」、set_buff 全空 —— 123014 是 effect_buff 里的机制型 buff（type=406、
  // 无 para，其 string=buff_123014 在 locale 无条目，故根本没有属性名可显示），人话说明在
  // 本行 buff_desc 键（实测：集齐所有{0}系列装饰物后，无需摆放即可永久激活{1}系列装饰物属性）。
  const suitInfo = (sid) => {
    const r = dictRow('decoration_contents', sid);
    return {
      members: String(r?.content || '')
        .split('|')
        .filter(Boolean)
        .map((x) => decoItem(x).name || String(x)),
      maxLevel: r?.max_level ?? null,
      mechDesc: r?.buff_desc ? loc(r.buff_desc) : null,
    };
  };
  // 拥有装饰件：同 id 可拥有多份，按解名后的名称归并计数（解不到名则保留 #id，不臆造）
  const decoOwned = (s) => {
    const m = new Map();
    for (const id of decoBlob(s).ids || []) {
      const nm = decoItem(id).name || '装饰#' + id;
      m.set(nm, (m.get(nm) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  };
  // ── 英雄主动技：战报 hero_list 确实不下发主动技字段（全库 254 个 hero 实例的字段枚举里无任何
  // active/skill 列，只有 nonActiveSkills 与 awakenSkillMap），但主动技本身两处可得：
  //   ① 字典侧 table:hero.skill 给出该英雄的主动技 hero_skill id（实测上场 22 个英雄 22/22 有值、
  //      22/22 解出中文名，如 169→10169 超视制导）；
  //   ② 战报侧 fightMarches[].{att,def}SkillHurts.skill_hurts（parse 落 damage_sources kind='skill'）
  //      按侧带 hurt/hits（实测 25 个去重 id 100% 解名且 100% 为 hero_skill.skill_type=1）。
  // 两处合起来：按侧对账 254/254 个「英雄×侧」的主动技 id 都能在同侧 skill_hurts 找到对应 ref。
  // 真正缺的只有玩家侧主动技等级/加成，故只报「技能名 + 本场伤害/释放次数」，不报等级。
  const heroActive = (heroId) => {
    const sid = dictRow('hero', heroId)?.skill;
    if (sid == null || sid === '' || sid === 0) return null;
    return { id: Number(sid), name: nameOf('hero_skill', sid) };
  };
  const skillHurts = new Map();
  for (const r of db
    .prepare('SELECT side, ref, hurt, hits FROM damage_sources WHERE report_id=? AND kind=?')
    .all(R, 'skill')) {
    skillHurts.set(`${r.side}|${r.ref}`, r);
  }
  const skillUse = (side, skillId) => skillHurts.get(`${side}|${skillId}`) || null;
  // 觉醒配置行索引：主键是自增 id，而战报 awakenSkillMap 的 key 是 awakening_skill_id，
  // 故按 (awakening_skill_id|skill_level) 建索引（与 normalize 的 awIdx 同判据）。
  const awakeRows = new Map();
  for (const r of rowsOf('hero_awakening_skill')) {
    const k = `${r.awakening_skill_id}|${r.skill_level}`;
    if (!awakeRows.has(k)) awakeRows.set(k, r);
  }
  // skill_effect_add 形如「hero_awake_skill_234_106_fix|1.5%」：键侧实测 16 个去重 locale 键 100% 可译
  // （例：6阶解锁：该英雄主动技能伤害提升{0}），值侧是紧跟键后的百分比/倍数。normalize 未富化该列，故在此现解。
  const awakeEffectAdd = (sid, level) => {
    const raw = awakeRows.get(`${sid}|${level}`)?.skill_effect_add;
    if (!raw) return null;
    const segs = String(raw)
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean);
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const t = segs[i];
      if (/^[\d.%,]+$/.test(t)) continue; // 值片段已随前一条键一起产出
      const zh = loc(t);
      const nxt = segs[i + 1] || '';
      out.push({
        text: zh && String(zh) !== t ? String(zh) : t,
        val: /^[\d.%,]+$/.test(nxt) ? nxt : null,
      });
    }
    return out.length ? out : null;
  };
  // 皮肤展览：exhibitions[] 是 table:skin_exhibition 主键，其名在该表独有的 exhibition_name 列
  // （不在通用 NAME_COLS 里，故此前只给计数不给名）。实测 27 个去重 id 行命中 100%、解名 100%。
  const skinExhibition = (id) => {
    const r = dictRow('skin_exhibition', id);
    if (!r) return null;
    return {
      id,
      name: nameOf('skin_exhibition', id, ['exhibition_name', 'name']),
      buff: r.buff ?? null,
      power: r.power ?? null,
    };
  };

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

  // 站位精通：九宫格 seq(0-8) → mastery position（row*10+col+1，3×3 = 1,2,3/11,12,13/21,22,23）
  const masteryPosOfSeq = (seq) => {
    const row = Math.floor(seq / 3);
    const col = seq % 3;
    return row * 10 + col + 1;
  };
  const masteryOfSeq = (form, seq) => (form?._masterys || {})[String(masteryPosOfSeq(seq))] || null;

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
  // ── 属性模块分组（汇总第 4 部分的主轴）：按 source_view 精确枚举到「模块组」──
  // 纪律：未列中的 view 一律落入 catchAll「其他编配系统」（旧名「其他来源」易被误解为「查不到来源」，
  // 实为「未归入 11 大独立模块组的 buff 视图」，如联盟/VIP/天赋材料/兵种图鉴/秘密武器/城市技能/世界奇观/
  // type:94/96 一类的游戏系统）；modAgg() 给出的 rowCnt 供「Σ 各组 rowCnt == buff_effects 该场行数」
  // 这条不变量对账（全库实测 60 个 distinct source_view）。
  // 注意：rowCnt 是本组 views 的全部行数（含无名行、非属性 buff），而 pairs 只 sum 有中文名
  // 且匹配 BUFF_ATTR_RE 的属性行——两者数量不等是数据本身的特性，非渲染 bug。
  const ATTR_MODULES = [
    { id: 'mecha', label: '机甲', views: ['mecha_chip', 'mecha_skill', 'trace:MECHA'] },
    {
      id: 'equip',
      label: '兵种装备',
      views: ['trace:ARMY_EQUIP', 'trace:INIT_ARMY_EQUIP'],
      notRe: 'KEZHI',
    },
    { id: 'enhance', label: '装备强化', views: ['army_mastery', 'trace:ENHANCE_MASTERY'] },
    { id: 'kezhi', label: '兵种克制', views: ['trace:CAREER'], nameRe: 'KEZHI' },
    { id: 'element', label: '元素伤害', views: ['trace:ELEMENT'] },
    {
      id: 'hero',
      label: '英雄',
      views: [
        'hero_equip',
        'hero_equip_stone',
        'hero_talent',
        'trace:HERO_EQUIP',
        'trace:HERO_BOND',
        'trace:HERO_TALENT',
        'trace:HERO_SKILL',
      ],
    },
    {
      id: 'formation',
      label: '军阵',
      views: [
        'formation_mastery',
        'formation_science',
        'formation_level',
        'formation_quality',
        'trace:FORMATION_V2',
        'trace:FORMATION_V2_TALENT',
        'trace:THOR_SCIENCE',
        'trace:SCIENCE',
      ],
    },
    {
      id: 'deco',
      label: '装饰',
      views: ['decoration_suit', 'decoration_sublime', 'decoration_exp', 'trace:DECORATION'],
    },
    {
      id: 'skin',
      label: '皮肤',
      views: [
        'skin_effect',
        'skin_castle',
        'skin_march',
        'skin_exhibition',
        'skin_headframe',
        'trace:SKIN',
        'trace:MARCH_SKIN',
        'trace:CASTLE_EFFECT',
        'trace:CITY_SKIN',
      ],
    },
    {
      id: 'enigma',
      label: '异能兽',
      views: ['enigma_beast', 'enigma_field', 'trace:ENIGMA_BEAST', 'trace:ENIGMA_FIELD'],
    },
    {
      id: 'ctc',
      label: '跨服收藏',
      views: ['cross_collection', 'trace:CROSS_TREASURE_COLLECTION'],
    },
  ];
  // 旧名「其他来源」→「其他编配系统」：避免用户误读为「查不到来源」；实际是「不属于 11 大独立模块组的其他游戏系统 buff」。
  const MOD_OTHER = { id: 'other', label: '其他编配系统', catchAll: true };
  // 增益名 → 属性维度判据（回合卡「按属性维度」分组用）：ATTRS 基础属性名 + 克制/加深/减免类。
  // 注：它比 BUFF_ATTR_RE（静态属性总账的口径）宽，因为施加事件的名字常写「生命提升」而不带「加成」。
  const ATTR_NAME_RE = /(防御|生命|攻击|伤害加深|伤害减免|兵种克制|陆军对|海军对|空军对)/;
  const modPairsOf = (views, nameRe, notRe) =>
    cmpAgg(views, nameRe ? BUFF_ATTR_RE : null, notRe ? KEZHI_RE : null);
  /** 属性模块组清单（含兜底「其他编配系统」）：{id,label,pairs,views,rowCnt,allRowCnt} */
  const modAgg = () => {
    const listed = new Set(ATTR_MODULES.flatMap((m) => m.views));
    const defs = ATTR_MODULES.concat([MOD_OTHER]);
    return defs
      .map((m) => {
        const views = m.catchAll
          ? [...new Set([...effRows.att, ...effRows.def].map((r) => r.source_view))].filter(
              (v) => !listed.has(v),
            )
          : m.views;
        const rows = [...effRows.att, ...effRows.def].filter((r) => views.includes(r.source_view));
        const pairs = modPairsOf(views, m.nameRe, m.notRe);
        return {
          id: m.id,
          label: m.label,
          views,
          pairs,
          rowCnt: rows.length,
          allRowCnt: effRows.att.length + effRows.def.length,
        };
      })
      .filter((m) => m.rowCnt > 0);
  };
  // 属性大类累加（request3：展开属性明细时按「生命/攻击/防御/伤害加深/伤害减免/兵种克制」归类求和）。
  // 口径：同一收益若既有万分比又有绝对值，按 value_type 拆两行（避免两种量纲相加）；万分比为主流。
  const ATTR_CAT_ORDER = ['生命', '攻击', '防御', '伤害加深', '伤害减免', '兵种克制'];
  const attrCatOf = (name) => {
    const n = String(name || '');
    if (/伤害加深/.test(n)) return '伤害加深';
    if (/伤害减免/.test(n)) return '伤害减免';
    if (/(陆军|海军|空军)对|兵种克制/.test(n)) return '兵种克制';
    if (/生命/.test(n)) return '生命';
    if (/攻击/.test(n)) return '攻击';
    if (/防御/.test(n)) return '防御';
    return null;
  };
  /** 按属性大类（× value_type）累加全部视图的增益数值，产出 pairs 供 divergingRows 攻守对比。 */
  const attrCatAgg = (views = '*') => {
    const m = new Map(); // `${cat}|${vt}` -> {name, att, def, vt}
    for (const side of ['att', 'def']) {
      for (const r of effRows[side]) {
        if (views !== '*' && !views.includes(r.source_view)) continue;
        if (!r.name || !cjk(r.name)) continue;
        const cat = attrCatOf(r.name);
        if (!cat) continue;
        const vt = r.value_type == null ? 10000 : r.value_type;
        const key = `${cat}|${vt}`;
        const cur = m.get(key) || { name: vt === 1 ? `${cat} · 绝对值` : cat, att: 0, def: 0, vt };
        cur[side] += r.raw_value || 0;
        m.set(key, cur);
      }
    }
    return [...m.values()].sort(
      (a, b) =>
        ATTR_CAT_ORDER.indexOf(a.name.replace(' · 绝对值', '')) -
          ATTR_CAT_ORDER.indexOf(b.name.replace(' · 绝对值', '')) ||
        Math.max(b.att, b.def) - Math.max(a.att, a.def),
    );
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
  // 魔石品质色码 → CSS 类（q1..q9）；魔石等级已改由 lib.star 直给（见 titanTable），不再从 buff_value 折算
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
  // 逐伤害事件切桶：{round, side, branch, seq, cat, hero, skill, val}（数值来自 battle_events.val，与 ① acc.dmg 同源）
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
        skill: dispNameDesc(e.skill == null ? '普通攻击' : skillNameAny(e.skill)).name,
        val: e.val,
      });
    }
    return out;
  })();
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

  // ── 回合时间轴：按 IndexRound 切回合逐回合聚合（可对账：各回合造成合计 == acc.dmg）──
  const roundAgg = (() => {
    const byR = new Map();
    const ensure = (n) => {
      if (!byR.has(n))
        byR.set(n, {
          round: n,
          dealt: { att: 0, def: 0 },
          branch: new Map(),
          cat: new Map(),
          hero: new Map(),
          skill: new Map(),
          seq: new Map(),
          casts: { att: 0, def: 0 },
          apply: { att: new Map(), def: new Map() },
          applyAttr: { att: new Map(), def: new Map() },
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
      bump(r.skill, c.skill || '（未署名）', c.side, c.val);
      bump(r.seq, c.seq == null ? '（无槽位映射）' : '槽' + c.seq + '·' + c.branch, c.side, c.val);
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
      else if (APPLIED_KINDS.includes(e.kind) && e.buff_id != null) {
        const nm = buffDisplayName(e);
        const shown = subSkillIds(String(nm));
        const r = ensure(cur);
        r.apply[s.side].set(shown, (r.apply[s.side].get(shown) || 0) + 1);
        // 属性维度（ATTR_NAME_RE 反解属性名）：仅供回合卡的「按属性维度」分组，次数口径与 apply 一致
        if (ATTR_NAME_RE.test(String(shown))) {
          r.applyAttr[s.side].set(shown, (r.applyAttr[s.side].get(shown) || 0) + 1);
        }
      } else if (e.kind === 'RemoveSkillBuff') ensure(cur).remove[s.side]++;
    }
    return byR;
  })();
  // ── 逐槽・逐回合剩余战力：伤害事件的 power 列＝被击方(target)该次结算后的剩余战力快照 ──
  // 实测判据（4883545741242523653）：同一槽位取到的 power 沿 idx 单调不增，槽首值≈side_units.max_power、
  // 终值≈终局残力，与回放「每格每回合的消耗」同源。快照只在该单位被击时刷新，故回合值取「≤该回合的最近快照」；
  // 首快照之前的回合视为满战力（尚未被击）。归位沿用 seqByUuid（side_units.uuids）：seq 9/10 增援溢出格不在九宫格、但计入侧合计。
  const forceAgg = (() => {
    const slotPower = new Map(); // `side|seq` -> round -> 该回合内最小 power（回合末残力）
    let cur = 0;
    for (const e of evs) {
      if (e.kind === 'IndexRound') {
        cur = Number(e.val) || cur;
        continue;
      }
      if (!(e.power > 0) || e.target == null) continue;
      const slot = seqByUuid.get(String(e.target));
      if (!slot) continue;
      const k = `${slot.side}|${slot.seq}`;
      if (!slotPower.has(k)) slotPower.set(k, new Map());
      const byR = slotPower.get(k);
      const prev = byR.get(cur);
      if (prev === undefined || e.power < prev) byR.set(cur, e.power);
    }
    const hasPower = slotPower.size > 0;
    // 回合全集用 roundBins 实际回合号（升序）；无 power 时置空，渲染层据此回落「无走势」。
    const rounds = hasPower ? roundBins.bins.map((b) => b.round).sort((a, b) => a - b) : [];
    const slotMax = new Map(); // `side|seq` -> 开局 max_power（troops 全 seq，含增援溢出格）
    for (const side of ['att', 'def'])
      for (const u of troops[side]) slotMax.set(`${side}|${u.seq}`, Number(u.max_power) || 0);
    const gridMax = { att: 0, def: 0 };
    for (const side of ['att', 'def'])
      for (let i = 0; i < 9; i++) gridMax[side] += slotMax.get(`${side}|${i}`) || 0;
    // 某槽在回合 n 的残力：≤n 的最近快照；若首快照在 n 之后（或从无快照）→ 开局 max_power（此时尚未被击）。
    const atRound = (k, n) => {
      const mx = slotMax.get(k) || 0;
      const byR = slotPower.get(k);
      if (!byR) return mx;
      let bestR;
      let bestV;
      for (const [r, v] of byR)
        if (r <= n && (bestR === undefined || r > bestR)) ((bestR = r), (bestV = v));
      return bestR === undefined ? mx : bestV;
    };
    const overSeqs = { att: new Set(), def: new Set() };
    for (const k of slotPower.keys()) {
      const [side, seq] = k.split('|');
      if (Number(seq) >= 9) overSeqs[side].add(seq);
    }
    const base = { att: [], def: [] };
    const overflow = { att: [], def: [] };
    for (const side of ['att', 'def']) {
      for (const n of rounds) {
        let g = 0; // 九宫格（seq 0..8）该回合末剩余
        let o = 0; // 增援溢出格同回合末剩余
        for (let i = 0; i < 9; i++) g += atRound(`${side}|${i}`, n);
        for (const seq of overSeqs[side]) o += atRound(`${side}|${seq}`, n);
        base[side].push({ round: n, end: g, prev: o });
        overflow[side].push(o);
      }
    }
    return { rounds, base, overflow, gridMax, slot: slotPower, hasPower };
  })();

  const roundPairs = (mp) =>
    [...mp.entries()].map(([name, v]) => ({ name, att: v.att, def: v.def }));
  const roundEmpty = () => ({
    dealt: { att: 0, def: 0 },
    branch: new Map(),
    cat: new Map(),
    hero: new Map(),
    skill: new Map(),
    seq: new Map(),
    casts: { att: 0, def: 0 },
    apply: { att: new Map(), def: new Map() },
    applyAttr: { att: new Map(), def: new Map() },
    remove: { att: 0, def: 0 },
    acted: { att: new Set(), def: new Set() },
  });

  // ── 回合内结算拍（battle_events.tl）分桶 ──
  // tl 不是真实时间戳：45 场全库仅 166 个 distinct 取值，相邻步长 1.2s×154 档（另 0.6s×10、1.8s×1），
  // 是定拍推进的战斗毫秒数。同拍内的事件先后只能靠 idx（结算序号），此处不假装能还原。
  // 每拍四量：造成（与 dmgCells/roundAgg 同判据，故逐拍合计＝该回合造成）· 释放（按技能名可折叠）
  // · 施加 / 移除 次数。两者角色不同：施加按 source（施加者侧），移除按 source（实测为携带者侧）；
  // 统一画在拍轴上会误读，所以时长不画在拍轴上，只把严格配对（sustainDurByRound）列到回合卡末尾。
  const tickBins = (() => {
    const byR = new Map();
    const ensureR = (n) => {
      if (!byR.has(n)) byR.set(n, { round: n, ticks: new Map() });
      return byR.get(n);
    };
    const ensureT = (rn, tl) => {
      const r = ensureR(rn);
      if (!r.ticks.has(tl))
        r.ticks.set(tl, {
          tl,
          dmg: { att: 0, def: 0 },
          cast: { att: 0, def: 0 },
          bySkill: { att: new Map(), def: new Map() },
          apply: { att: 0, def: 0 },
          remove: { att: 0, def: 0 },
        });
      return r.ticks.get(tl);
    };
    let cur = 1;
    ensureR(1);
    for (const e of evs) {
      if (e.kind === 'IndexRound') {
        cur = Number(e.val) || cur;
        ensureR(cur);
        continue;
      }
      const s = inst.get(String(e.source))?.side;
      if (!s) continue;
      const t = ensureT(cur, e.tl ?? 0);
      if (DMG_KINDS.includes(e.kind) && e.val > 0) t.dmg[s] += e.val;
      else if (e.kind === 'Skill') {
        t.cast[s]++;
        const nm = e.skill_name ? subSkillIds(String(e.skill_name)) : '（未名技能）';
        t.bySkill[s].set(nm, (t.bySkill[s].get(nm) || 0) + 1);
      } else if (APPLIED_KINDS.includes(e.kind) && e.buff_id != null) t.apply[s]++;
      else if (e.kind === 'RemoveSkillBuff') t.remove[s]++;
    }
    // 拍按 tl 升序定列；全回合只有 ≤1 拍时轴无信息量，由视图层降级为一句说明
    for (const r of byR.values()) r.order = [...r.ticks.keys()].sort((a, b) => a - b);
    return byR;
  })();
  const tickEmpty = () => ({
    dmg: { att: 0, def: 0 },
    cast: { att: 0, def: 0 },
    bySkill: { att: new Map(), def: new Map() },
    apply: { att: 0, def: 0 },
    remove: { att: 0, def: 0 },
  });

  // ── 增益台账：本场出现过的 buff_id 逐个列全，三个「角色」分列不混用 ──
  // apply  = 谁挂上去的（施加事件 source，即施加者侧；计数口径是「获得次数」，不是技能释放次数）
  // carry  = 挂在谁身上（带 target 的点名事件按 target 侧；施加类点名算强判据、debuff 命中算弱判据）
  // remove = 从谁身上摘的（RemoveSkillBuff.source）——实测该 source 是携带者而非施加者：
  //          全库 21,100 条移除事件里角色可区分的样本中，source 落在「该 buff_id 点名的携带者侧」8,908 条、
  //          落在「施加者侧」仅 1,034 条（约 9:1）；而它们的 target 列 100% 为空，所以携带者只能靠 source 拿。
  // 持续值两口径并排、不做换算：战报回显 buff_sustained（施加事件带回的配置值）与字典 effect_buff.sustained_buff。
  // 单位仍未考证：time_limit / once_limit / cost_use_time_type 三列几乎恒 0；且下面 dur 实测到的时长
  // 与字典配置值不成比例（如 400404 配置 29 实测中位 18.0s、992232 配置 4 实测中位 13.2s），故只报数值不标单位。
  // dur = 实例级实测时长：只认「同一携带者 + 同一 buff_id + 施加事件本身点名了该携带者」的严格配对，
  //       且一次施加最多配一次移除（配完即消费）。全库 21,100 条移除里严格配到 843 条（4.0%、23 个 buff_id），
  //       跨度中位 16.8s、无 0 跨无负跨；配不到就留空，不用 buff_id 同池撞。
  // byCarrier = 台账分三本的依据（全库 1,566 个 (场, buff_id) 组：攻 557 / 守 599 / 互挂 286 / 未点名 124）：
  //       只能按携带者拆——按施加者拆会有 799 组（51%）无处可放，因为一半 buff_id 本场只被摘除过、没有在先的施加行。
  const {
    rows: sustainRows,
    byCarrier: sustainByCarrier,
    durByRound: sustainDurByRound,
  } = (() => {
    const m = new Map();
    const ensure = (id) => {
      if (!m.has(id))
        m.set(id, {
          id,
          name: null,
          apply: { att: 0, def: 0 },
          carry: { att: 0, def: 0 },
          strong: 0,
          remove: { att: 0, def: 0, nosrc: 0 },
          kinds: new Map(),
          vals: new Set(),
          cfg: null,
          spans: [],
        });
      return m.get(id);
    };
    const durPairs = []; // { round, id, side（携带者侧）, span }
    const lastApply = new Map(); // `携带者uuid|buff_id` -> { tl, side }；只由施加类点名事件写入
    let rn = 1;
    const sideOf = (u) => (u == null ? null : inst.get(String(u))?.side || null);
    for (const e of evs) {
      if (e.kind === 'IndexRound') {
        rn = Number(e.val) || rn;
        continue;
      }
      if (e.buff_id == null) continue;
      const id = String(e.buff_id);
      const isRemove = e.kind === 'RemoveSkillBuff';
      const isApply = APPLIED_KINDS.includes(e.kind);
      const s = sideOf(e.source);
      const t = sideOf(e.target);
      // 携带者点名：非移除事件带 target 才算；行不存在且又不是施加类就不建行（避免伤害噪声）
      if (!isRemove && t && (isApply || m.has(id))) {
        const r = m.get(id) || ensure(id);
        r.carry[t]++;
        if (isApply) {
          r.strong++;
          lastApply.set(`${e.target}|${id}`, { tl: e.tl || 0, side: t });
        }
      }
      if (!isApply && !isRemove) continue; // 其余 kind 只是顺手带了 buff_id，不算台账行
      const r = ensure(id);
      if (!r.name || /^增益#/.test(r.name)) {
        // 命名链对施加/移除两类事件都能跑；只被移除过的 buff_id（没有在先的施加行）靠这里拿到名。
        // 「增益#id」是命名链兜底，不能先占位就把后面能解到的真名锁死。
        const nm = buffDisplayName(e);
        if (nm) {
          const shown = subSkillIds(String(nm));
          if (!r.name || !/^增益#/.test(shown)) r.name = shown;
        }
      }
      if (isApply) {
        if (s) r.apply[s]++;
        r.kinds.set(e.kind, (r.kinds.get(e.kind) || 0) + 1);
        if (e.buff_sustained != null && String(e.buff_sustained) !== '')
          r.vals.add(Number(e.buff_sustained));
      } else {
        if (s) r.remove[s]++;
        else r.remove.nosrc++;
        const k = `${e.source}|${id}`;
        const L = lastApply.get(k);
        if (L !== undefined) {
          lastApply.delete(k);
          const span = (e.tl || 0) - L.tl;
          r.spans.push(span);
          durPairs.push({ round: rn, id, side: s || L.side, span });
        }
      }
    }
    for (const r of m.values()) {
      const cf = dictRow('effect_buff', r.id);
      r.cfg =
        cf && cf.sustained_buff != null && String(cf.sustained_buff) !== ''
          ? String(cf.sustained_buff)
          : null;
      if (!r.name) r.name = '增益#' + r.id;
      r.kindMain = [...r.kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      r.applies = r.apply.att + r.apply.def;
      r.removes = r.remove.att + r.remove.def + r.remove.nosrc;
      r.carried = r.carry.att + r.carry.def;
      // 台账按携带者拆三本，所以分侧在这里定一次（视图层不再各自猜）：
      // 两侧都有量且少数侧达多数侧 25% 时记作 both（否则 4/4、5/4 这种“双方各有”会被抛硬币归一边）。
      const tag = (o) => {
        const mx = Math.max(o.att, o.def);
        const mn = Math.min(o.att, o.def);
        if (!mx) return null;
        return mn && mn / mx >= 0.25 ? 'both' : o.att >= o.def ? 'att' : 'def';
      };
      // 携带侧优先取点名（carry），没点名才退回摘除侧（remove 的 source 同样落在携带者身上）
      r.carrierTag = tag(r.carry.att + r.carry.def ? r.carry : r.remove);
      r.hasCarrier = Boolean(r.carrierTag);
      if (r.spans.length) {
        const d = [...r.spans].sort((a, b) => a - b);
        r.dur = { n: d.length, med: d[d.length >> 1], min: d[0], max: d[d.length - 1] };
      }
    }
    // 逐回合时长条：按 (回合, buff_id, 携带者侧) 归并严格配对结果
    const grouped = new Map();
    for (const p of durPairs) {
      const k = `${p.round}|${p.id}|${p.side}`;
      if (!grouped.has(k))
        grouped.set(k, { id: p.id, side: p.side, name: m.get(p.id).name, spans: [] });
      grouped.get(k).spans.push(p.span);
    }
    const byRound = new Map();
    for (const [k, v] of grouped) {
      const round = Number(k.split('|')[0]);
      const d = [...v.spans].sort((a, b) => a - b);
      const row = {
        id: v.id,
        side: v.side,
        name: v.name,
        n: d.length,
        med: d[d.length >> 1],
        min: d[0],
        max: d[d.length - 1],
      };
      if (!byRound.has(round)) byRound.set(round, []);
      byRound.get(round).push(row);
    }
    for (const arr of byRound.values()) arr.sort((a, b) => b.med - a.med);
    const rows = [...m.values()].sort(
      (a, b) => b.applies - a.applies || b.removes - a.removes || Number(b.id) - Number(a.id),
    );
    // 三本台账的分组：挂在攻方身上 / 挂在守方身上 / 携带者未点名。
    // both 行（双方互挂）在两本各列一份，所以三本行数之和≠去重 buff_id 数，视图页脚要给出 overlap 校正。
    const byCarrier = { att: [], def: [], both: 0, none: [] };
    for (const r of rows) {
      if (!r.hasCarrier) {
        byCarrier.none.push(r);
        continue;
      }
      if (r.carrierTag === 'both') {
        byCarrier.both++;
        byCarrier.att.push(r);
        byCarrier.def.push(r);
      } else byCarrier[r.carrierTag].push(r);
    }
    return {
      rows,
      byCarrier,
      durByRound: byRound,
    };
  })();

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

  const roundDiffPairs = () =>
    [...roundAgg.entries()].map(([n, r]) => ({
      name: '第' + n + '回合',
      att: r.dealt.att,
      def: r.dealt.def,
    }));
  return {
    rep,
    march,
    sides,
    players,
    grid,
    troops,
    slotTaken,
    takenUnresolved,
    sustainRows,
    sustainByCarrier,
    sustainDurByRound,
    inst,
    evs,
    acc,
    dmgSrc,
    skillCast,
    buffApply,
    buffRemove,
    elemDmg,
    FIGHT_TYPE,
    dividePool,
    fightFilter,
    pool,
    addBuff,
    branchTroop,
    defaultBranch,
    A_BR,
    foldedAttr,
    sideMeta,
    A,
    roundBins,
    battleMs,
    sciNameByGroup,
    scienceList,
    masteryPosOfSeq,
    masteryOfSeq,
    decoBlob,
    decoItem,
    suitInfo,
    decoOwned,
    heroActive,
    skillUse,
    awakeEffectAdd,
    skinExhibition,
    skinBlob,
    ctcBlob,
    ctcInfo,
    effRows,
    effValText,
    cmpAgg,
    modAgg,
    attrCatAgg,
    attrCatOf,
    ATTR_CAT_ORDER,
    ATTR_NAME_RE,
    mechaList,
    mechaName,
    equipName,
    heroEquipName,
    stoneQCls,
    beastNameCache,
    beastNameByCfg,
    fieldName,
    SRC_ZH,
    srcLabel,
    RANGE_ORDER,
    buffRangeOf,
    buffTimingOf,
    dmgPairs,
    castPairs,
    buffPairs,
    elemPairs,
    dynNote,
    armySeq,
    heroLabel,
    dmgCells,
    dmgAgg,
    roundAgg,
    forceAgg,
    roundPairs,
    roundEmpty,
    tickBins,
    tickEmpty,
    dmgDimPairs,
    dmgSkillPairs,
    roundDiffPairs,
    D,
  };
}
