// 渲染层·逐件明细片段：机甲 / 兵种装备 / 装备强化 / 元素 / 英雄 / 军阵 / 装饰 / 皮肤 / 跨服收藏 / 异能兽。
// 这些片段只产 HTML 块，不再自带一级 TAB 外壳——外壳由 attrs.js 的「属性模块构成」（基本信息 TAB 下半）按模块组装配，
// 使「组级属性对比 + 该组逐件明细（默认折叠）」成为全版统一读法。三级 TAB（英雄 hy / 军阵 fm）仍由本文件产出。
/**
 * @param {ReturnType<import('./ctx.js').makeCtx>} ctx 字典上下文
 * @param {ReturnType<import('./data.js').makeData>} data 单场取数
 * @param {ReturnType<import('./ui.js').makeUi>} ui 渲染原语
 * @param {ReturnType<import('./shell.js').makeShell>} shell TAB 外壳（收集显示规则）
 */
export function makeParts(ctx, data, ui, shell) {
  const {
    J,
    BR,
    fmt,
    esc,
    okName,
    cjk,
    BRANCHES,
    ATTRS,
    BUFF_ATTR_RE,
    resolveChipName,
    resolveBuffNameExt,
    buffValText,
    skillNameAny,
    skillRarity,
    subSkillIds,
    armyName,
    armyBranch,
  } = ctx;
  const {
    A,
    D,
    sides,
    players,
    troops,
    effRows,
    effValText,
    cmpAgg,
    foldedAttr,
    branchTroop,
    A_BR,
    grid,
    scienceList,
    masteryPosOfSeq,
    masteryOfSeq,
    decoBlob,
    decoItem,
    suitInfo,
    decoOwned,
    heroActive,
    skillUse,
    skinExhibition,
    skinBlob,
    ctcBlob,
    ctcInfo,
    mechaList,
    mechaName,
    equipName,
    heroEquipName,
    stoneQCls,
    elemPairs,
    dynNote,
    srcLabel,
    beastNameByCfg,
    fieldName,
  } = data;
  const { openCard, drill, fold, phaseHd, divergingRows, cmpSummary, shortFor, vtFmt } = ui;

  // ── 军种基础属性（部队维：三军种 TAB × 六项属性 + 出征数）──────
  // 单一共享军种 TAB：选定军种后 6 项属性 + 出征数各出一行攻/守背靠背对比（共用一把标尺）
  const attrCompare = () =>
    shell.tabs(
      'tab-br',
      BRANCHES.map((br) => {
        const fa = foldedAttr('att', br);
        const fd = foldedAttr('def', br);
        const pairs = ATTRS.map((a) => ({ name: a, att: fa[a] || 0, def: fd[a] || 0, vt: 10000 }));
        pairs.push({
          name: '出征数',
          att: branchTroop('att', br),
          def: branchTroop('def', br),
          vt: 1,
        });
        return { key: br, label: br, body: divergingRows(pairs, { fmtVal: vtFmt }) };
      }),
      { cls: 'brcmp', paneCls: 'tpane', checked: A_BR },
    );
  const troopAttrsCard = () =>
    openCard(
      '军种基础属性（陆/海/空 TAB · 逐属性攻守对比）',
      '选定军种后六项属性 + 出征数逐行对比',
      attrCompare() +
        `<div class="note">陆/海/空共用一个军种切换（默认定格攻方出征数最大军种）。属性含全军加成回流；防御加成=本军种防御+全军防御；按万分比(÷100)显示%，出征数取 side_units.uuid_count。左红=攻、右蓝=守。</div>`,
    );

  // ── 机甲 ──────────────────────────────────────────────
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
          const chipRows = (m.chips || [])
            .map((c) => {
              const cn = resolveChipName(c.chipId) || '芯片' + c.chipId;
              const attrs = effRows[side]
                .filter(
                  (r) => r.source_view === 'mecha_chip' && String(r.item_ref) === String(c.chipId),
                )
                .map((r) => `${esc(shortFor(r.name))} <b>${esc(effValText(r))}</b>`)
                .join('、');
              return `<tr><td class="an">${esc(cn)}</td><td class="mv">${c.level != null ? 'Lv' + c.level : '—'}</td><td class="an">${attrs || '<span class="mut">—</span>'}</td></tr>`;
            })
            .join('');
          const chipTbl = (m.chips || []).length
            ? `<table class="mat"><thead><tr><th class="an">芯片</th><th>等级</th><th class="an">属性</th></tr></thead><tbody>${chipRows}</tbody></table>`
            : '<span class="mut">—</span>';
          return `<div class="mi"><div class="mihd">${esc(mechaName(m.mechaId))}</div><div class="mic"><span class="hlbl">部件</span><span class="chips">${parts || '—'}</span></div><div class="mic"><span class="hlbl">技能</span><span class="chips">${skills || '—'}</span></div><div class="mic mic-chip"><span class="hlbl">芯片</span>${chipTbl}</div></div>`;
        })
        .join('') || '<div class="mut">无机甲</div>'
    );
  };

  // ── 兵种装备 / 装备强化 / 元素 / 异能兽 逐件 ──────────────────
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
      : '<div class="mut">该侧 army_mastery 为空</div>';
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
  // 逐兵种台账（side_units 全列 · 攻左守右）
  const troopTable = (side) => {
    const rows = troops[side] || [];
    const tr = rows
      .map(
        (u) =>
          `<tr><td class="mv">${u.seq}</td><td class="an"><span class="btag b${armyBranch(u.army_id)}">${armyBranch(u.army_id)}</span> ${esc(armyName(u.army_id))}</td><td class="mv">${fmt(u.max_power || 0)}</td><td class="mv">${fmt(u.max_shield || 0)}</td><td class="mv">${fmt(u.max_element_power || 0)}</td><td class="mv">${u.uuid_count ?? 0}</td><td class="mv">${u.dead_count ?? 0}</td><td class="mv">${u.is_extra ? '增援' : '—'}</td></tr>`,
      )
      .join('');
    return (
      `<table class="mat"><thead><tr><th>槽</th><th class="an">军种·兵种</th><th>战力</th><th>护盾</th><th>元素战力</th><th>出征</th><th>阵亡</th><th>来源</th></tr></thead>` +
      `<tbody>${tr || '<tr><td class="mut" colspan="8">无编组</td></tr>'}</tbody></table>`
    );
  };
  const troopLedger = () =>
    openCard(
      '逐兵种台账（side_units · 攻左 / 守右）',
      `攻 ${(troops.att || []).length} 组 · 守 ${(troops.def || []).length} 组`,
      `<div class="grid2"><div><div class="attc side-tag">攻方</div>${troopTable('att')}</div><div><div class="defc side-tag">守方</div>${troopTable('def')}</div></div><div class="note">战力 / 护盾 / 元素战力取该兵种各实例的最大值（max_power·max_shield·max_element_power），出征与阵亡取 uuid_count·dead_count，「增援」为 is_extra（非本阵编成）。槽位 seq 0–8 为九宫格站位，≥9 为追加编组。</div>`,
    );
  // 按系统追溯的增益属性来源分组（属性模块展开明细）：传 views 则只列本组 source_view、否则跨全部。
  const buffAttrDetail = (side, views) => {
    const scoped = Array.isArray(views);
    const rows = effRows[side].filter(
      (r) => r.name && BUFF_ATTR_RE.test(r.name) && (!scoped || views.includes(r.source_view)),
    );
    if (!rows.length) return '<div class="mut">本组无增益属性</div>';
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

  // ── 英雄（花名册 + 三级子模块：技能 | 天赋 | 觉醒 | 泰坦）──────
  const heroKey = (h) => String(h._name || h.name || '#' + h.id);
  const heroHead = (h) =>
    `Lv${h.level ?? '-'} · ★${h.star ?? '-'} · 觉醒${h.awakenLevel ?? 0}${h.fullAwaken ? '✓' : ''}`;
  // 攻守同名英雄配对（按攻方顺序，再补守方独有）
  const heroPairs = () => {
    const keys = [...new Set([...A.heroes, ...D.heroes].map(heroKey))];
    return keys.map((key) => ({
      key,
      att: A.heroes.find((h) => heroKey(h) === key) || null,
      def: D.heroes.find((h) => heroKey(h) === key) || null,
    }));
  };
  const emptyRow = (cols, msg) => `<tr><td class="mut" colspan="${cols}">${msg}</td></tr>`;
  // 通用矩阵表（表头 + 行 + 空态占位）：英雄 / 军阵 / 装饰 子模块共用
  const kvTable = (heads, rows, empty) =>
    `<table class="mat"><thead><tr>${heads}</tr></thead><tbody>${rows || emptyRow(heads.split('<th').length - 1, empty)}</tbody></table>`;
  // 逐将攻守并排：每一将一块，左攻右守，块内由 fn(hero) 产出该侧明细
  const heroSplit = (fn) => {
    const pairs = heroPairs();
    if (!pairs.length) return '<div class="mut">无英雄</div>';
    return pairs
      .map((p) => {
        const col = (side) => {
          const h = p[side];
          const zh = side === 'def' ? '守方' : '攻方';
          return `<div><div class="${side === 'def' ? 'defc' : 'attc'} side-tag">${zh} · ${h ? esc(heroHead(h)) : '未上阵'}</div>${
            h ? fn(h, side) : '<div class="mut">—</div>'
          }</div>`;
        };
        return drill(esc(p.key), `<div class="grid2">${col('att')}${col('def')}</div>`, 'fgrp');
      })
      .join('');
  };
  const heroRoster = () => {
    const cell = (h) => (h ? esc(heroHead(h)) : '<span class="mut">未上阵</span>');
    const rows = heroPairs()
      .map(
        (p) =>
          `<tr><td class="an">${esc(p.key)}</td><td>${cell(p.att)}</td><td>${cell(p.def)}</td></tr>`,
      )
      .join('');
    return openCard(
      '英雄花名册（攻守同名并列 · 等级/星级/觉醒）',
      `攻 ${A.heroes.length} 将 · 守 ${D.heroes.length} 将`,
      kvTable(
        '<th class="an">英雄</th><th class="attc">攻方</th><th class="defc">守方</th>',
        rows,
        '无英雄',
      ) +
        `<div class="note">同名英雄按 _name（hero 表解名）配对，仅一方上阵时另一侧记「未上阵」。等级/星级/觉醒取 side_players.hero_list 的 level·star·awakenLevel·fullAwaken。</div>`,
    );
  };
  // 主动技行：战报 hero_list 不下发主动技字段（全库 254 个 hero 实例字段枚举里无任何 active 列），
  // 但技能身份走字典 hero.skill（上场 22/22 英雄有值且 22/22 解出中文名）、本场结算走同侧
  // skill_hurts（damage_sources kind='skill'，25 个去重 ref 100% 解名且 100% skill_type=1）。
  // 真正缺的只有玩家侧主动技等级/加成，故等级列明写「未下发」，不臆造。
  const activeSkillRow = (h, side) => {
    const act = heroActive(h.id);
    if (!act) return '';
    const use = skillUse(side, act.id);
    const title = `字典 table:hero.skill=${act.id}；本场该技能造成 ${fmt(use ? use.hurt : 0)}${
      use && use.hits != null ? '、命中 ' + use.hits + ' 次' : ''
    }（战报 fightMarches.skill_hurts）`;
    return `<tr><td class="an" title="${esc(title)}">${esc(act.name || '主动技#' + act.id)}<span class="mut"> 本场 ${
      use ? fmt(use.hurt) + (use.hits ? ' / ' + use.hits + ' 次' : '') : '无释放记录'
    }</span></td><td class="mv"><span class="mut">未下发</span></td><td class="mv"><i class="rq nor">主动</i></td><td class="mv">#${act.id}</td></tr>`;
  };
  // 技能：hero_list.nonActiveSkills（被动 + 英雄专属技）逐将列表；首行为字典+skill_hurts 合成的主动技
  const skillTable = (h, side) => {
    const act = heroActive(h.id); // 主动技 id（字典 hero.skill）；nonActiveSkills 里常有同 id 的 Lv0 影子行，去重免「错乱」
    const rows = (h._nonActiveSkills || [])
      .filter((s) => !(act && String(s.skillId) === String(act.id)))
      .map((s) => {
        const nm = subSkillIds(String(skillNameAny(s.skillId) || s.name || '?'));
        const rq = skillRarity(s.skillId);
        return `<tr><td class="an">${esc(nm)}</td><td class="mv">${s.level != null ? 'Lv' + s.level : '—'}</td><td class="mv">${rq ? `<i class="rq ${rq === '稀有' ? 'rar' : 'nor'}">${rq}</i>` : '—'}</td><td class="mv">#${s.skillId}</td></tr>`;
      })
      .join('');
    return kvTable(
      '<th class="an">技能</th><th>等级</th><th>稀有度</th><th>技能 id</th>',
      activeSkillRow(h, side) + rows,
      '无被动/专属技',
    );
  };
  const heroSkillPane = () =>
    openCard(
      '技能（主动 / 被动 / 专属 · 逐将攻守并排）',
      `共 ${heroPairs().reduce((a, p) => a + ((p.att?._nonActiveSkills || []).length + (p.def?._nonActiveSkills || []).length), 0)} 条技能等级`,
      heroSplit(skillTable) +
        fold(
          '展开 · 英雄技能相关属性对照（trace:HERO_SKILL）',
          divergingRows(cmpAgg(['trace:HERO_SKILL'])),
        ) +
        `<div class="note">主动技已列入首行。口径：战报 <code>hero_list</code> 确实不下发主动技字段（全库 254 个 hero 实例的字段枚举里只有 nonActiveSkills 与 awakenSkillMap，无任何 active 列），但主动技身份与本场结算两处可得：名字走字典 <code>table:hero.skill</code> → hero_skill 解名（上场 22 个英雄 22/22 有值、22/22 解出中文），本场伤害/释放次数走战报 <code>fightMarches[].skill_hurts</code>（parse 落 <code>damage_sources kind='skill'</code>：25 个去重 ref 100% 解名、100% 为 skill_type=1；按侧对账 254/254 个「英雄×侧」的主动技 id 均能在同侧 skill_hurts 找到对应 ref，因此不谎称「无主动技数据」）。<b>唯一真缺的是玩家侧主动技等级/加成</b>，故等级列明写「未下发」。<br>被动/专属技名走 hero_skill 解名（回落 Mecha_skill / 装备 rd_library），稀有度取 hero_skill.quality（1=普通 / 2=稀有）；右侧属性对照为觉醒技/装备技经 need_add_buff 落入的权威 trace 数值。</div>`,
    );
  // 天赋：hero_list.talents[].talentId → talent.buff → effect_buff 语义名 + ttsr 生效值
  const talentTable = (h) => {
    const rows = (h._talents || [])
      .map((t) => {
        const nm = subSkillIds(String(t.name ?? '?'));
        const v = buffValText(t.buff_id, t.ttsr);
        return `<tr><td class="an">${esc(nm)}</td><td class="mv">${esc(v ?? String(t.ttsr ?? '—'))}</td></tr>`;
      })
      .join('');
    return kvTable('<th class="an">天赋</th><th>生效值</th>', rows, '无天赋');
  };
  const heroTalentPane = () =>
    openCard(
      '天赋（逐将攻守并排 · talent → effect_buff）',
      `共 ${heroPairs().reduce((a, p) => a + ((p.att?._talents || []).length + (p.def?._talents || []).length), 0)} 条天赋`,
      heroSplit(talentTable) +
        fold(
          '展开 · 天赋属性对照（hero_talent + trace:HERO_TALENT）',
          divergingRows(cmpAgg(['hero_talent', 'trace:HERO_TALENT'])),
        ) +
        `<div class="note">天赋名走 talent.buff → effect_buff 语义名（回落 talent 表解名）；生效值取战报 ttsr 经 buffValText 按 value_type 换算（万分比→%）。属性对照为静态编配汇入的 hero_talent 视图 + 权威 trace。</div>`,
    );
  // 觉醒：awakenSkillMap{awakening_skill_id:{level}} 逐级解到 hero_awakening_skill 行
  const awakenTable = (h) => {
    const list = (h._awakenSkills || []).slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const rows = list
      .map((s) => {
        const nm =
          skillNameAny(s.hero_skill_id) || subSkillIds(String(s.hero_skill_name ?? '')) || '?';
        // need_add_buff 是 effect_buff id 列表。实测部分 id 为纯内部载体 buff（string 空、同 type 无带名兄弟、
        // locale 无条目），无法从字典解出中文名——它们只是觉醒技 hero_skill 效果的数据实现层，
        // 用户可见信息已在「觉醒技」列体现。故只展示可解析名、过滤无名行（不再显示「N 项未解名」噪声）。
        const toks = String(s.need_add_buff ?? '')
          .split(/[|,]/)
          .map((t) => t.trim())
          .filter((t) => /^\d+$/.test(t));
        const grants = [...new Set(toks.map((t) => okName(resolveBuffNameExt(t))).filter(Boolean))];
        const grantTxt = grants.length
          ? `<span class="chips">${grants.map((g) => `<span class="chip tal">${esc(subSkillIds(String(g)))}</span>`).join('')}</span>`
          : '<span class="mut">—</span>';
        return `<tr><td class="mv">${s.slot ?? '—'}</td><td class="an">${esc(nm)}</td><td class="mv">${s.level != null ? 'Lv' + s.level : '—'}</td><td class="mv">${s.fight_pewer != null ? fmt(s.fight_pewer) : '—'}</td><td class="an">${grantTxt}</td></tr>`;
      })
      .join('');
    return kvTable(
      '<th>槽</th><th class="an">觉醒技</th><th>等级</th><th>战力</th><th class="an">授予增益</th>',
      rows,
      '无觉醒技',
    );
  };
  const heroAwakenPane = () =>
    openCard(
      '觉醒（逐级觉醒表 · awakenSkillMap → hero_awakening_skill）',
      `攻 ${A.heroes.reduce((a, h) => a + (h._awakenSkills || []).length, 0)} 级 · 守 ${D.heroes.reduce((a, h) => a + (h._awakenSkills || []).length, 0)} 级`,
      heroSplit(awakenTable) +
        `<div class="note">每行一个觉醒槽：槽位=skill_num，等级=战报 awakenSkillMap 的 level（按 (awakening_skill_id|skill_level) 命中配置行，实测全库 70 个去重槽 100% 命中）；战力=skill_fight_pewer。授予增益列解 <code>need_add_buff</code>：这些 id 命中 effect_buff 行，但部分为纯内部载体 buff（字典 string 列空、同 type 无带名兄弟），无法解出中文名——它们只是觉醒技效果的数据实现层，用户可见信息已在「觉醒技」列体现，故只展示可解析名、无名行静默过滤。（觉醒技的描述文本按需求不再展示。）</div>`,
    );
  // 泰坦（泰坦装备 hero_equip 系统 + 魔石 hero_equip_skill_rd_library）
  const titanTable = (h) => {
    const rows = (h._equips || [])
      .map((e) => {
        const infos = e._infos || [];
        const attrs = infos.filter((x) => x.kind === 'attr');
        const stones = infos.filter((x) => x.kind === 'stone');
        const attrTxt = attrs.length
          ? attrs
              .map(
                (x) =>
                  `${esc(shortFor(x.name || '属性#' + x.buff_id))} <b>${esc(buffValText(x.buff_id, x.buffValue) ?? String(x.buffValue ?? ''))}</b>`,
              )
              .join('、')
          : '<span class="mut">—</span>';
        const stoneTxt = stones.length
          ? `<span class="chips">${stones
              .map((x) => {
                const star = x.star != null && Number(x.star) > 0 ? Number(x.star) : null;
                const smax = x.starMax != null && Number(x.starMax) > 0 ? Number(x.starMax) : null;
                const qc = stoneQCls(x.color);
                const stTxt =
                  star != null ? `★${star}${smax && smax !== star ? '/' + smax : ''}` : '';
                return `<span class="chip">${esc(x.name || '魔石')}${stTxt ? `<i class="stn${qc ? ' ' + qc : ''}"><b>${stTxt}</b></i>` : ''}</span>`;
              })
              .join('')}</span>`
          : '<span class="mut">—</span>';
        const star = Number(e.rateEquipId) > 0 ? ` ☆${e.rateEquipId}` : '';
        return `<tr><td class="an">${esc(heroEquipName(e.equipId))}${e.level != null ? ` <b>Lv${e.level}</b>` : ''}${star}</td><td class="an">${attrTxt}</td><td class="an">${stoneTxt}</td></tr>`;
      })
      .join('');
    return kvTable(
      '<th class="an">泰坦装备</th><th class="an">随机属性</th><th class="an">魔石</th>',
      rows,
      '无泰坦装备',
    );
  };
  const heroTitanPane = () =>
    openCard(
      '泰坦（泰坦装备 hero_equip · 随机属性 + 魔石）',
      `共 ${heroPairs().reduce((a, p) => a + ((p.att?._equips || []).length + (p.def?._equips || []).length), 0)} 件装备`,
      heroSplit(titanTable) +
        fold(
          '展开 · 泰坦装备/魔石属性对照（hero_equip + hero_equip_stone + trace）',
          divergingRows(
            cmpAgg(['hero_equip', 'hero_equip_stone', 'trace:HERO_EQUIP', 'trace:HERO_BOND']),
          ),
        ) +
        `<div class="note">本游戏的「泰坦」即泰坦装备系统（heroEquips）：装备名走 hero_equip 解名，Lv=装备等级，☆=rateEquipId（进阶，常为 0 故不显）。随机属性 infos.type=1 → hero_equip_buff_rd；魔石 type=2 → hero_equip_skill_rd_library（★=魔石星级 <code>lib.star</code>、斜杠后为满星 <code>star_max</code>；此前误把 buff_value÷10000 当等级已修正——buff_value 是技能威力参考、非等级）；颜色 tint 取 buff_value_color 品质码，无干净中文品质名不臆造。</div>`,
    );
  const heroPane = () =>
    heroRoster() +
    shell.tabs(
      'hy',
      [
        { key: 'skill', label: '技能', body: heroSkillPane() },
        { key: 'talent', label: '天赋', body: heroTalentPane() },
        { key: 'awaken', label: '觉醒', body: heroAwakenPane() },
        { key: 'titan', label: '泰坦', body: heroTitanPane() },
      ],
      { cls: 'snav' },
    );

  // ── 军阵（本体 + 三级子模块：专精 | 科技 | 等级品质）───────────
  // 「buff_id|值」原串 → 增益名 + 按 value_type 归一的数（军阵专精 / 装饰套装 / 收藏档位共用）
  const buffPairTxt = (str) =>
    String(str || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const [bid, raw] = t.split('|');
        const nm = okName(resolveBuffNameExt(Number(bid)));
        if (!nm) return `<span class="mut">${esc(t)}</span>`;
        const val =
          raw == null || raw === ''
            ? ''
            : ` <b>${esc(buffValText(Number(bid), Number(raw)) ?? raw)}</b>`;
        return `${esc(nm)}${val}`;
      })
      .join(' · ');
  const scienceHtml = (form) => {
    const sci = scienceList(form);
    if (!sci.length) return '';
    return `<div class="fsci"><span class="hlbl">军阵科技</span><span class="chips">${sci
      .map((s) => `<span class="chip sci">${esc(s.name)} <b>Lv${s.level}</b></span>`)
      .join('')}</span></div>`;
  };
  const kvRow = (label, ...cells) =>
    `<tr><td class="an">${label}</td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  // normalize 的 _name 在 locale 缺词时会回落原键（dict.js resolveName 的 zh || key），故只按「含中文」判定；
  // 不能走 okName（其标点规则会误杀「军阵：战鹰」一类的正式名）。
  const zhName = (v, fallback) => (v && cjk(v) ? String(v) : fallback);
  const formSide = (side) => (side === 'def' ? D.form : A.form);
  const formCell = (side, fn) => {
    const f = formSide(side);
    return f && f.id != null ? fn(f) : '<span class="mut">无军阵</span>';
  };
  const formRoster = () => {
    const name = (f) => esc(zhName(f._name, '军阵#' + f.id));
    const rows = [
      kvRow('军阵（formationV2 解名）', formCell('att', name), formCell('def', name)),
      kvRow(
        '等级 lv',
        formCell('att', (f) => `<b>Lv${f.lv ?? '-'}</b>`),
        formCell('def', (f) => `<b>Lv${f.lv ?? '-'}</b>`),
      ),
      kvRow(
        '品质 quality',
        formCell('att', (f) => `<b>Q${f.quality ?? '-'}</b>`),
        formCell('def', (f) => `<b>Q${f.quality ?? '-'}</b>`),
      ),
      kvRow(
        '专精站位数',
        formCell('att', (f) => `${Object.keys(f._masterys || {}).length} 个`),
        formCell('def', (f) => `${Object.keys(f._masterys || {}).length} 个`),
      ),
      kvRow(
        '科技组数',
        formCell('att', (f) => `${scienceList(f).length} 组`),
        formCell('def', (f) => `${scienceList(f).length} 组`),
      ),
    ].join('');
    return openCard(
      '军阵本体对照（formation_v2 · 名称 / 等级 / 品质）',
      `攻 ${A.form.id ? '已装配' : '无'} · 守 ${D.form.id ? '已装配' : '无'}`,
      kvTable(
        '<th class="an">项目</th><th class="attc">攻方</th><th class="defc">守方</th>',
        rows,
        '无军阵',
      ) +
        `<div class="note">lv/quality 为战报直报值（非字典推算）；军阵名走 formationV2 解名。专精见「专精」子页、科技逐组见「科技」子页、等级/品质下发的属性见「等级品质」子页。</div>`,
    );
  };
  // 站位×专精 3×3 矩阵（seq 0-8 → pos row*10+col+1，与首页九宫格金黄标记同源）
  const masteryCell = (side, seq) => {
    const f = formSide(side);
    const mas = f && f.id != null ? masteryOfSeq(f, seq) : null;
    const u = grid[side][seq];
    return (
      `<td${mas ? ' class="mas"' : ''}><div class="mp">pos ${masteryPosOfSeq(seq)} · seq ${seq}${
        u ? ` · ${esc(armyName(u.army_id))}` : ''
      }</div>` +
      (mas
        ? `<div class="msk">✦ ${esc(mas.skill || '专精')} <b>Lv${mas.level}</b></div>`
        : '<div class="mut">无专精</div>') +
      (mas && mas.buff_group ? `<div class="mbg">${buffPairTxt(mas.buff_group)}</div>` : '') +
      `</td>`
    );
  };
  const masteryMatrix = (side) =>
    `<table class="mat fmg"><tbody>${[0, 1, 2]
      .map((row) => `<tr>${[0, 1, 2].map((col) => masteryCell(side, row * 3 + col)).join('')}</tr>`)
      .join('')}</tbody></table>`;
  const fmMastery = () =>
    openCard(
      '专精矩阵（站位 × 军阵专精 · 3×3 · 与首页九宫格同源）',
      `攻 ${Object.keys(A.form._masterys || {}).length} 位 · 守 ${Object.keys(D.form._masterys || {}).length} 位`,
      `<div class="grid2"><div><div class="attc side-tag">攻方</div>${masteryMatrix('att')}</div><div><div class="defc side-tag">守方</div>${masteryMatrix('def')}</div></div>` +
        fold(
          '展开 · 军阵专精属性对照（formation_mastery + trace:FORMATION_V2_TALENT）',
          divergingRows(cmpAgg(['formation_mastery', 'trace:FORMATION_V2_TALENT'])),
        ) +
        `<div class="note">pos = row*10+col+1（前排 1/2/3、中排 11/12/13、后排 21/22/23），seq 为九宫格 0–8 站位；专精名与等级取 formation_v2.masterys 经 formationV2_mastery 富化。下方为格（前排）在左、上方为格（后排）在右。专精下发的加成组 buff_group 原串「buff_id|值」按 effect_buff.value_type 归一。</div>`,
    );
  const sciTable = (side) => {
    const rows = scienceList(formSide(side))
      .map(
        (s) => `<tr><td class="an">${esc(s.name)}</td><td class="mv"><b>Lv${s.level}</b></td></tr>`,
      )
      .join('');
    return kvTable('<th class="an">科技组</th><th>等级</th>', rows, '无军阵科技');
  };
  const fmScience = () =>
    openCard(
      '军阵科技（formation_v2.sciences · 逐组等级）',
      `攻 ${scienceList(A.form).length} 组 · 守 ${scienceList(D.form).length} 组`,
      `<div class="grid2"><div><div class="attc side-tag">攻方</div>${scienceHtml(A.form)}${sciTable('att')}</div><div><div class="defc side-tag">守方</div>${scienceHtml(D.form)}${sciTable('def')}</div></div>` +
        fold(
          '展开 · 科技属性对照（formation_science + trace:THOR_SCIENCE / SCIENCE）',
          divergingRows(cmpAgg(['formation_science', 'trace:THOR_SCIENCE', 'trace:SCIENCE'])),
        ) +
        `<div class="note">组名取 formationV2_science.group_name（locale 键）解中文，解不到回落「科技&lt;group&gt;」；等级直取 formation_v2.sciences{group:level}。</div>`,
    );
  const fmLvq = () => {
    const pairs = cmpAgg(['formation_level', 'formation_quality', 'trace:FORMATION_V2']);
    return openCard(
      '等级 · 品质加成对照（formation_level / formation_quality / trace:FORMATION_V2）',
      cmpSummary(pairs),
      divergingRows(pairs) +
        `<div class="note">本视图只陈列 buff_effects 中军阵等级/品质两路实际下发的加成属性（同名累加、攻守并排）；等级与品质数值本身见上方「军阵本体对照」。</div>`,
    );
  };
  const formPane = () =>
    formRoster() +
    shell.tabs(
      'fm',
      [
        { key: 'mastery', label: '专精', body: fmMastery() },
        { key: 'science', label: '科技', body: fmScience() },
        { key: 'lvq', label: '等级品质', body: fmLvq() },
      ],
      { cls: 'snav' },
    );

  // ── 装饰 / 皮肤 / 跨服收藏（三个模块组各自的逐件台账）──────────
  const suitTable = (side) => {
    const rows = (decoBlob(side)._suits || [])
      .map((su) => {
        const info = suitInfo(su.id);
        const mem = info.members.length
          ? `<td class="mv" title="${esc(info.members.join('、'))}${
              info.maxLevel ? '（最高 Lv' + info.maxLevel + '）' : ''
            }">${info.members.length} 件</td>`
          : '<td class="mv">—</td>';
        const buff = info.mechDesc
          ? `<td class="an" title="${esc(info.mechDesc)}｜原串 ${esc(String(su._buff))}">机制增益 · 集齐激活</td>`
          : `<td class="an">${buffPairTxt(su._buff) || '<span class="mut">—</span>'}</td>`;
        return `<tr><td class="an">${esc(zhName(su._name, '套装#' + su.id))}</td><td class="mv">${
          su.level != null ? 'Lv' + su.level : '—'
        }</td>${mem}${buff}</tr>`;
      })
      .join('');
    return kvTable(
      '<th class="an">套装</th><th>等级</th><th>成员</th><th class="an">套装增益</th>',
      rows,
      '无套装',
    );
  };
  const sublimeTable = (side) => {
    const rows = (decoBlob(side)._sublimes || [])
      .map((sb) => {
        const it = decoItem(sb.id);
        const bs = (sb._buffs || [])
          .map(
            (bf) =>
              `${esc(zhName(bf.name, '增益#' + bf.buffId))} <b>${esc(buffValText(bf.buffId, bf.value) ?? bf.value)}</b>`,
          )
          .join(' · ');
        const put = it.buff ? buffPairTxt(it.buff) : '';
        // 不再过 zhName（含中文判据）：building 里确有一批纯代号名（如「F-1」），nameOf 已把过关
        return `<tr><td class="an">${esc(it.name || '装饰#' + sb.id)}</td><td class="mv">${
          it.level != null ? 'Lv' + it.level : '—'
        }</td><td class="an">${bs || '<span class="mut">无升华增益</span>'}</td><td class="an">${
          put || '<span class="mut">—</span>'
        }</td></tr>`;
      })
      .join('');
    return kvTable(
      '<th class="an">升华装饰物</th><th>形态</th><th class="an">升华增益</th><th class="an">该形态摆放增益</th>',
      rows,
      '无升华',
    );
  };
  const ownedCell = (side) => {
    const list = decoOwned(side);
    return (
      `<div class="note">${(decoBlob(side).ids || []).length} 件 · 去重 ${list.length} 种（按份数降序）</div>` +
      (list.length
        ? `<span class="chips">${list
            .map(([nm, c]) => `<span class="chip">${esc(nm)}${c > 1 ? ' ×' + c : ''}</span>`)
            .join('')}</span>`
        : '<span class="mut">—</span>')
    );
  };
  const decoLedger = () => {
    const cnt = (side) => {
      const ed = decoBlob(side);
      return {
        suits: (ed._suits || []).length,
        subs: (ed._sublimes || []).length,
        ids: (ed.ids || []).length,
      };
    };
    const ca = cnt('att'),
      cd = cnt('def');
    const col = (side) => {
      const n = cnt(side);
      return (
        `<div class="note">拥有装饰件 ${n.ids} · 激活套装 ${n.suits} · 升华 ${n.subs}</div>` +
        suitTable(side) +
        sublimeTable(side)
      );
    };
    return openCard(
      '装饰台账（套装 decoration_contents / 升华与拥有件 building）',
      `攻 ${ca.suits} 套/${ca.ids} 件 · 守 ${cd.suits} 套/${cd.ids} 件`,
      `<div class="grid2"><div><div class="attc side-tag">攻方</div>${col('att')}</div><div><div class="defc side-tag">守方</div>${col('def')}</div></div>` +
        fold(
          '展开 · 拥有装饰件清单（building 解名 · 同名归并份数）',
          `<div class="grid2"><div><div class="attc side-tag">攻方</div>${ownedCell('att')}</div><div><div class="defc side-tag">守方</div>${ownedCell('def')}</div></div>`,
        ) +
        `<div class="note">套装名走 decoration_contents 解名；升华装饰物与拥有件一律是 <code>table:building</code> 主键——实测全库 44,179 个拥有件 id 100% 命中该表并解出名（含 43400..43403 一类纯代号名「F-1」）；同族 15 个 id 共用一个名字键，<code>building.level</code> 即形态等级（1..15）。「升华增益」取 sublimes[].buffs（升华养成产出），「摆放增益」取该形态的 building.buff_id，两者不同维度、不合并。套装增益列：全字典 23 个套装的 buff 字段一律为 <code>123014|1</code>、set_buff 全空——123014 在 effect_buff 里是 type=406 的机制型 buff（无 para，其 string 键 buff_123014 在 locale 无条目，故无属性名可显），可读说明在 decoration_contents.buff_desc（已挂在本列单元格 title），因此该列对所有套装相同、无区分度；套装真正下发的属性见本模块上方的属性对照。升华经验（sublimeExps）亦已在 decoration_exp 对照中。字段 <code>boxMaxIds</code> 的语义未考证，故本模块不呈现、不臆造。</div>`,
    );
  };
  // 皮肤各子类的拥有/使用列表（effect_skins 只给 id 列表，无玩家级等级）
  const SKIN_KINDS = [
    { zh: '皮肤效果', own: 'effectIds', use: 'useIds', eown: '_effectIds', euse: '_useIds' },
    {
      zh: '城堡效果',
      own: 'ownCastleEffects',
      use: 'useCastleEffects',
      eown: '_ownCastleEffects',
      euse: '_useCastleEffects',
    },
    {
      zh: '行军皮肤',
      own: 'ownMarchSkins',
      use: 'useMarchSkins',
      eown: '_ownMarchSkins',
      euse: '_useMarchSkins',
    },
    {
      zh: '城堡光环',
      own: 'ownHaloSkins',
      use: 'useHaloSkins',
      eown: '_ownHaloSkins',
      euse: '_useHaloSkins',
    },
    { zh: '头像框', own: 'ownHeadframes', use: null, eown: '_ownHeadframes', euse: null },
    {
      zh: '迁城特效',
      own: 'ownMoveCityEffects',
      use: 'useMoveCityEffects',
      eown: null,
      euse: null,
    },
    { zh: '皮肤展览', own: 'exhibitions', use: null, eown: null, euse: null, exh: true },
    { zh: '秘法物品', own: 'magicIds', use: null, eown: null, euse: null },
  ];
  const skinNameChips = (list) =>
    list && list.length
      ? `<span class="chips">${list
          .map((it) => `<span class="chip">${esc(zhName(it._name, '#' + it.id))}</span>`)
          .join('')}</span>`
      : '<span class="mut">—</span>';
  const skinTable = (side) => {
    const sk = skinBlob(side);
    const n = (key) => (key && Array.isArray(sk[key]) ? sk[key].length : null);
    const rows = SKIN_KINDS.map((k) => {
      const useList = k.euse ? sk[k.euse] : null;
      // 展览没有 normalize 富化列（名字在 skin_exhibition 独有的 exhibition_name 列），现解。
      const chipList = k.exh
        ? (sk[k.own] || []).map((e) => {
            const id = e && typeof e === 'object' ? e.id : e;
            const info = skinExhibition(id);
            return { id, _name: info && info.name };
          })
        : useList || (k.eown ? sk[k.eown] : null);
      return kvRow(
        k.zh,
        `${n(k.own) ?? 0} 项`,
        n(k.use) === null ? '<span class="mut">无使用中列表</span>' : `${n(k.use)} 项`,
        skinNameChips(chipList),
      );
    }).join('');
    return kvTable(
      '<th class="an">类别</th><th>拥有</th><th>使用中</th><th class="an">名称（使用中优先，无使用列表则列拥有）</th>',
      rows,
      '无皮肤数据',
    );
  };
  const skinLedger = () =>
    openCard(
      '皮肤台账（effect_skins · 拥有 / 使用中计数）',
      `攻 ${(skinBlob('att').effectIds || []).length} 皮 · 守 ${(skinBlob('def').effectIds || []).length} 皮`,
      `<div class="grid2"><div><div class="attc side-tag">攻方</div>${skinTable('att')}</div><div><div class="defc side-tag">守方</div>${skinTable('def')}</div></div>` +
        `<div class="note">无玩家养成度——该断言已拿到更硬的证据：<code>effect_skins</code> 里唯一可能承载玩家侧信息的字段 <code>useInfos</code> 在全部 88 个 side 上恒为空数组 <code>[]</code>，字典侧 skin/castle_effect 等表的 <code>skin_level·max_level·use_power·have_power</code> 都是皮肤自身的定位属性而非玩家养成度，故不取用。名称解名口径逐类实证的：skin 特效 198 个去重 id、使用中 22 个，castle_effect 拥有 57 / 使用 20，march_skin 拥有 11 / 使用 20 —— 均 100% 命中对应表并解出中文；<b>皮肤展览</b>（27 个去重 id）此前只给计数，现按 <code>skin_exhibition.exhibition_name</code>（该表独有列、不在通用名字字段清单内）100% 解名。恒为空数组的四类（拥有光环 / 两类迁城特效 / 秘法物品）只记 0 项，不臆造。</div>`,
    );
  const ctcTable = (side) => {
    const rows = (ctcBlob(side).collects || [])
      .map((col) => {
        const info = ctcInfo(col.id, col.lv);
        return `<tr><td class="an">${esc((info && info.name) || '珍宝#' + col.id)}</td><td class="mv">Lv${col.lv ?? '-'}</td><td class="mv">${
          info && info.quality != null ? 'Q' + info.quality : '—'
        }</td><td class="mv">${info && info.score != null ? info.score : '—'}</td><td class="an">${
          (info && buffPairTxt(info.buff)) || '<span class="mut">—</span>'
        }</td></tr>`;
      })
      .join('');
    return kvTable(
      '<th class="an">珍宝</th><th>档位</th><th>品质</th><th>字典单件积分</th><th class="an">该档增益</th>',
      rows,
      '无跨服收藏',
    );
  };
  const ctcLedger = () =>
    openCard(
      '跨服收藏台账（ctc.collects · 珍宝 / 档位 / 品质）',
      `攻 ${(ctcBlob('att').collects || []).length} 件 · 守 ${(ctcBlob('def').collects || []).length} 件`,
      `<div class="grid2"><div><div class="attc side-tag">攻方</div>${ctcTable('att')}</div><div><div class="defc side-tag">守方</div>${ctcTable('def')}</div></div>` +
        `<div class="note">档位 lv 直取战报 collects[{id,lv}]；名称/品质/积分走 cross_treasure_collection 解名（实测全场 100% 解到），增益按 (collection_spec_id, level) 命中 cross_treasure_collection_level.buff 原串。「字典单件积分」是该珍宝定义的 score 字段、不累加成本场总分（战报未下发总分字段，故不臆造）。</div>`,
    );

  // 元素伤害卡（蝴蝶取实战元素合计，明细给按军种元素等级）
  const elementCard = () =>
    openCard(
      '元素伤害（实战元素伤害合计 · 攻守并排）',
      cmpSummary(elemPairs()),
      divergingRows(elemPairs()) +
        `<div class="grid2" style="margin-top:8px"><div><div class="attc side-tag">攻方 · 元素等级</div>${elementDetail('att')}</div><div><div class="defc side-tag">守方 · 元素等级</div>${elementDetail('def')}</div></div>` +
        `<div class="note">元素伤害合计取 battle_events.e_value 按 source→侧归属汇总（攻/守对比）；元素等级取 sides.element_levels。元素类型无干净中文战斗名，故按军种+原始 elementType 编号显示。</div>`,
    );

  /** 模块组 id → 逐件明细描述（供 attrs.js 装配）：
   *  { kind: 'side', fn }  → fn(side) 出单侧明细，调用方 sideGrid 并排；
   *  { kind: 'block', html } → 已成形的富面板（自带攻守布局/子 TAB），调用方整体折叠。 */
  const DETAILS = {
    equip: () => ({ kind: 'side', fn: equipDetail }),
    enhance: () => ({ kind: 'side', fn: masteryDetail }),
    element: () => ({ kind: 'side', fn: elementDetail }),
    deco: () => ({ kind: 'block', html: decoLedger() }),
    skin: () => ({ kind: 'block', html: skinLedger() }),
    ctc: () => ({ kind: 'block', html: ctcLedger() }),
    enigma: () => ({ kind: 'block', html: enigmaCompare() }),
  };
  /** 取某模块组的逐件明细描述（无对应片段时返回 null，由调用方回落 buffAttrDetail）。
   *  注：mecha / hero / formation 的富配置面板已由 attrs.staticConfig() 提为常显卡片，
   *  不再列入本表（避免与静态编配区重复），兵种克制/英雄/军阵/其他编配系统这几组回落为按本组 views 域化的属性行明细。 */
  const modDetail = (id) => {
    const d = DETAILS[id];
    return d ? d() : null;
  };

  return {
    troopAttrsCard,
    troopLedger,
    mechaDetail,
    equipDetail,
    masteryDetail,
    elementDetail,
    elementCard,
    enigmaCompare,
    buffAttrDetail,
    heroPane,
    formPane,
    decoLedger,
    skinLedger,
    ctcLedger,
    modDetail,
    phaseHd,
    dynNote,
  };
}
