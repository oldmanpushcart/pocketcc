// 渲染层·基本信息 TAB：增益对比（解释伤害差从哪来）+ 属性模块构成（最详细一层，按来源模块拆分）。
// 上半是「全场聚合视图」（跨模块按属性名累加 + 范围×时机矩阵 + 战斗内施加对比 + 本场增益台账），
// 下半是「分源视图」（按 source_view 归入模块组，逐组给组级蝴蝶 + 该组逐件明细，默认折叠）。
// 逐件明细片段来自 parts.js（modDetail），台账渲染从 round.js 提为可共享的 ledgerBooks()。
// 三级子 TAB（英雄 hy / 军阵 fm）在 parts.js 内部产出，本模块不需要 shell。
/**
 * @param {ReturnType<import('./ctx.js').makeCtx>} ctx 字典上下文
 * @param {ReturnType<import('./data.js').makeData>} data 单场取数
 * @param {ReturnType<import('./ui.js').makeUi>} ui 渲染原语
 * @param {ReturnType<import('./parts.js').makeParts>} parts 逐件明细片段
 */
export function makeAttrs(ctx, data, ui, parts) {
  const { esc, BUFF_ATTR_RE } = ctx;
  const {
    cmpAgg,
    buffPairs,
    castPairs,
    buffApply,
    buffRemove,
    modAgg,
    attrCatAgg,
    RANGE_ORDER,
    buffRangeOf,
    buffTimingOf,
    sustainRows,
    sustainByCarrier,
  } = data;
  const { openCard, drill, fold, phaseHd, divergingRows, cmpSummary, topDiff, sideGrid } = ui;

  // ── 增益对比（基本信息上半） ────────────────────────────
  // 2. 开局编配增益总账（范围 × 时机）：行=生效范围、列=时机；数据源静态 buff_effects，判据按名称正则。
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
            '<div class="mut dynhint">静态编配 buff_effects 无回合维度，此列不做假数据；回合内实际触发/施加的增益见「回合伤害」TAB 各回合卡的增益活动（定性·次数）。</div>';
          return drill(`${esc(rg)} · ${cnt} 项`, inner, 'fgrp');
        })
        .join('') || '<div class="mut">无增益属性</div>'
    );
  };

  // 3-c. 本场增益台账（按携带者分三本）：从 round.js 提为共享函数，基本信息页 fold 内调用，回合 TAB 不再整本重复。
  const ledgerBooks = () => {
    if (!sustainRows.length) return '';
    const cell = (v) => (v == null || v === '' ? '<span class="mut">—</span>' : esc(String(v)));
    const wd = (s) => (s === 'def' ? '守方' : '攻方');
    const other = (s) => (s === 'def' ? 'att' : 'def');
    const durCell = (r) =>
      r.dur
        ? `<span title="${r.dur.n} 条严格配对 · 最窄 ${(r.dur.min / 1000).toFixed(1)}s · 最宽 ${(r.dur.max / 1000).toFixed(1)}s">${(r.dur.med / 1000).toFixed(1)}s<span class="mut"> · ${r.dur.n} 条</span></span>`
        : '<span class="mut">—</span>';
    const nameCell = (r) =>
      `<td class="an">${esc(r.name)}<span class="mut"> · ${esc(r.kindMain || '仅摘除')}${
        r.carrierTag === 'both' ? ' · 双方互挂' : ''
      }</span></td>`;
    const casterCell = (r) =>
      `<td class="mv">${
        r.applies
          ? `${r.apply.att} / ${r.apply.def}`
          : '<span class="mut">仅摘除 · 无在先的施加行</span>'
      }</td>`;
    const bookRow = (r, side) =>
      `<tr><td class="mv">${esc(r.id)}</td>` +
      nameCell(r) +
      casterCell(r) +
      `<td class="mv"${
        r.carry.att + r.carry.def
          ? ` title="点名里 ${r.strong} 次由施加事件本身点名（强判据）、${
              r.carry.att + r.carry.def - r.strong
            } 次由 debuff 命中等事件顺带点名（弱判据）"`
          : ''
      }>点名 ${r.carry[side] || '<span class="mut">—</span>'} · 摘 ${r.remove[side]}${
        r.remove.nosrc
          ? `<span class="mut" title="另有 ${r.remove.nosrc} 条移除事件的 source 解不到侧"> +${r.remove.nosrc} 无源</span>`
          : ''
      }</td>` +
      `<td class="mv">${cell([...r.vals].join(','))} / ${cell(r.cfg)}</td>` +
      `<td class="mv">${durCell(r)}</td></tr>`;
    const book = (side) => {
      const rows = sustainByCarrier[side];
      if (!rows.length) return '';
      const shared = rows.filter((r) => r.carrierTag === 'both').length;
      const removed = rows.reduce((a, r) => a + r.remove[side], 0);
      const hasDur = rows.filter((r) => r.dur).length;
      const distinct =
        sustainByCarrier.att.length + sustainByCarrier.def.length - sustainByCarrier.both;
      const oneSided = rows
        .filter((r) => r.applies && (!r.apply.att || !r.apply.def))
        .sort((a, b) => b.applies - a.applies)[0];
      const egTxt = oneSided
        ? `例如 <b>${esc(oneSided.name)}</b> 的「${oneSided.apply.att} / ${oneSided.apply.def}」读作${
            oneSided.apply.att ? '攻方' : '守方'
          }往${wd(side)}身上挂了 ${oneSided.applies} 次、${oneSided.apply.att ? '守方' : '攻方'}一次没挂。`
        : '两格相加＝该 buff 在本方身上的被挂上总次数。';
      return fold(
        `展开 · 挂在${wd(side)}身上的增益台账（${rows.length} 项 · 被摘除 ${removed} 次${
          hasDur ? ` · 实测时长 ${hasDur} 项` : ''
        }）`,
        `<div class="tscroll"><table class="mat"><thead><tr><th>buff_id</th><th class="an">名称 · 施加 kind</th><th>谁挂的 攻/守</th><th>${wd(side)} 被点名挂上 / 被摘除</th><th>持续值 战报/字典</th><th>实测时长</th></tr></thead><tbody>${rows
          .map((r) => bookRow(r, side))
          .join('')}</tbody></table></div>` +
          `<div class="note">本台账按<b>携带者</b>归类：表里的 buff 全部落在${wd(side)}单位身上（不管是${wd(other(side))}挂的还是自己挂的），所以「挂在谁身上」不再占一列。` +
          `「谁挂的 攻/守」是施加事件 <code>source</code> 侧的<b>被挂上次数</b>，不是技能释放次数（释放数看「战斗内增益施加对比」下方）；` +
          egTxt +
          `${
            shared
              ? `其中 <b>${shared} 项双方互挂</b>（双方身上都有、两本各列一份），所以攻本 ${sustainByCarrier.att.length} + 守本 ${sustainByCarrier.def.length} − 互挂 ${sustainByCarrier.both} = 可分侧 ${distinct} 项。`
              : '本台账无双方互挂项。'
          }` +
          `全场 ${sustainRows.length} 个 buff_id，可分侧 ${distinct} 个，另有 ${sustainByCarrier.none.length} 个携带者未点名（见第三本）。</div>`,
      );
    };
    const noneBook = () => {
      const rows = sustainByCarrier.none;
      if (!rows.length) return '';
      const tr = rows
        .map(
          (r) =>
            `<tr><td class="mv">${esc(r.id)}</td>` +
            nameCell(r) +
            casterCell(r) +
            `<td class="mv">${cell([...r.vals].join(','))} / ${cell(r.cfg)}</td></tr>`,
        )
        .join('');
      return fold(
        `展开 · 携带者未点名的增益（${rows.length} 项 · 战报只给了谁挂的）`,
        `<table class="mat"><thead><tr><th>buff_id</th><th class="an">名称 · 施加 kind</th><th>谁挂的 攻/守</th><th>持续值 战报/字典</th></tr></thead><tbody>${tr}</tbody></table>` +
          `<div class="note">这些行不并进上面两本，因为<b>战报没说它们挂在谁身上</b>：它们的施加 kind 不写 <code>target</code>（占施加类多数的 <code>ADDMUTIBUFFS</code> 7,607 条 <b>target 0 条有值</b>），本场也没有能把携带者落到某一侧的 <code>RemoveSkillBuff</code>。这是数据下发的硬边界，不是实现遗漏。</div>`,
      );
    };
    const hasVal = sustainRows.filter((r) => r.vals.size).length;
    const hasDur = sustainRows.filter((r) => r.dur).length;
    const noteBook = () =>
      fold(
        '展开 · 台账口径说明（三本共用 · 分侧依据 / source 语义 / 时长配对 / 单位）',
        `<div class="note"><b>为何按携带者分三本</b>：一个 buff 有三个角色位——施加事件的 <code>source</code>（谁挂的）、施加事件的 <code>target</code>（挂在谁身上，只有 ArmyAddBuff/HeroAddBuff/AddSkillBuff/ADD_BUFF_WITH_NUM 带）、<code>RemoveSkillBuff.source</code>（从谁身上摘）。只有第二个能干净分侧，所以前两本主台账以携带者划分（全库 1,566 组：攻 557 / 守 599 / 互挂 286 / 未点名 124）；若改按施加者拆，会有 799 组（51%）无处可放。<br>` +
          `<b>一处易读错的地方已纠正</b>：<code>RemoveSkillBuff</code> 的 <code>source</code> <b>不是当初的施加者、而是 buff 从谁身上消失的携带者</b>——全库 21,100 条移除事件的 <code>target</code> 100% 为空、<code>source</code> 全有值，在携带者可区分的样本里 source 落在「该 buff_id 点名的携带者侧」8,908 条、落在「施加者侧」仅 1,034 条（约 9:1）。所以「被摘除」列读作「从本方单位身上摘掉了多少次」。<br>` +
          `两个持续口径并排不做换算：「战报持续」＝施加事件回显的 <code>buff_sustained</code>，「字典持续」＝<code>effect_buff.sustained_buff</code>；本场 ${sustainRows.length} 个 buff_id，其中 ${hasVal} 个带战报持续值。<b>实测时长</b>列（全场 ${hasDur} 个有值）只认「同一携带者 + 同一 buff_id + 施加事件本身点名了该携带者」的严格配对；空着不代表「没有时长」，只代表没有证据。<b>持续值单位已被实测证死</b>：既不是秒也不是拍，故三本都只报原始配置值、不换算。</div>`,
      );
    return book('att') + book('def') + noneBook() + noteBook();
  };

  // 增益对比主体（基本信息上半）：静态属性总账 → 开局编配范围×时机 → 战斗内施加对比（含台账 fold）。
  const buffCompare = () => {
    const attrPairs = cmpAgg('*', BUFF_ATTR_RE);
    const applyTotal = (mp) => [...mp.values()].reduce((a, b) => a + b, 0);
    return (
      `<section class="phase">` +
      phaseHd(
        '增益对比 · 造成差别的属性与增益',
        '静态属性总账 → 开局编配（范围 × 时机）→ 战斗内施加对比（含本场增益台账）',
      ) +
      // 0. 按属性大类累加（生命/攻击/防御/加深/减免/克制）——展开属性时的粗粒度攻守总账
      openCard(
        '按属性大类累加（生命/攻击/防御/伤害加深/伤害减免/兵种克制 · 攻守并排）',
        cmpSummary(attrCatAgg()),
        divergingRows(attrCatAgg()) +
          `<div class="note">把全部来源视图（机甲/装备/天赋/军阵/英雄/皮肤…）的增益按属性大类求和：万分比÷100→%、绝对值另起一行不混算；同一类同名跨来源合并，Δ 为攻守差（占优侧高亮）。逐属性名/逐来源的细粒度见下方「增益属性对比」与「属性模块构成」。</div>`,
      ) +
      // 1. 增益属性对比（全场聚合视图）
      openCard(
        '增益属性对比（按属性名跨模块累加 · 攻守并排）',
        cmpSummary(attrPairs),
        divergingRows(attrPairs) +
          `<div class="note">把各来源模块（机甲/芯片/装备/魔石/天赋/军阵专精/异能兽…）的同名增益属性累加后攻守并排，一眼看总差异；<b>差值榜定位是哪几项属性把差距拉开</b>（客观排序，不臆造因果）。各属性的逐来源归属见下方「属性模块构成」（本 TAB 下半，分源视图，与本卡聚合视图口径互补、不重复计数）。</div>` +
          `<h2 style="margin-top:14px">增益属性差值榜</h2>` +
          topDiff(attrPairs, 8) +
          `<div class="note">按 |攻−守| 降序、分列领先方；Δ 为差值。</div>`,
      ) +
      // 2. 开局编配增益总账（范围 × 时机）
      openCard(
        '开局编配增益总账（生效范围 × 生效时机）',
        '行=生效范围、列=时机 · 攻守数值对比',
        '<div class="note">行=空间生效范围（兵种克制 / 前排·前二排 / 本军种 / 全局），列=生效时机（开局常驻 / 条件触发）。范围与时机取自 buff_effects 静态数据、按增益名称正则判定（<code>buffRangeOf</code>/<code>buffTimingOf</code>），可直接攻守数值对比；首轮/逐回合一列属回合动态（静态表无回合维度），见「回合伤害」TAB。</div>' +
          buffMatrix() +
          fold('展开 · 来源追溯（按系统 · 攻/守）', sideGrid(parts.buffAttrDetail)),
      ) +
      // 3. 战斗内增益施加对比（本场动态）
      openCard(
        '战斗内增益施加对比（本场实际施加 · 攻守并排）',
        cmpSummary(buffPairs()),
        divergingRows(buffPairs()) +
          `<div class="note">增益施加 攻${applyTotal(buffApply.att)} / 守${applyTotal(buffApply.def)} 次 · 移除 攻${buffRemove.att} / 守${buffRemove.def} 次。施加按施加者侧（source）、移除按携带者侧，是两个角色、不相减。命名链：effect_buff.string → 递归 SkillId → Mecha_skill 反查 → type-sibling 启发 → 事件 buff_name/skill_name → Mecha_chip → 类型码。</div>` +
          `<div class="note">本卡是「本场总账」，故台账放基本信息页；逐回合只留活动线与时长条子集（见「回合伤害」TAB 各回合卡）。</div>` +
          ledgerBooks(),
      ) +
      openCard('技能释放榜（全场合计）', cmpSummary(castPairs()), divergingRows(castPairs())) +
      `</section>`
    );
  };

  // ── 属性模块构成（基本信息下半 · 分源视图）──────────────────
  // 每个模块组一张卡：组级属性蝴蝶（可对账）+ 该组逐件明细（默认折叠，来自 parts.js）。
  const modCard = (m) => {
    if (m.id === 'element') return parts.elementCard(); // 元素：蝴蝶直取 elemPairs（实战元素伤害合计），明细给按军种元素等级
    const d = parts.modDetail(m.id);
    // 有专属配置明细的组（装备/强化走 side、装饰/皮肤/收藏/异能兽走 block）用其明细；
    // 其余组（兵种克制/英雄/军阵/其他编配系统）按本组 source_view 域化列出属性行，不再全局倾倒。
    let detail;
    if (d && d.kind === 'block') detail = fold('展开 · 逐件明细', d.html);
    else if (d && d.kind === 'side') detail = fold('展开 · 逐件明细（攻/守）', sideGrid(d.fn));
    else
      detail = fold(
        '展开 · 本组属性来源追溯（攻/守）',
        sideGrid((side) => parts.buffAttrDetail(side, m.views)),
      );
    const viewTxt = m.views.length > 6 ? `${m.views.length} 个 source_view` : m.views.join(' / ');
    return openCard(
      `${m.label} · 属性构成（${m.rowCnt} 行）`,
      cmpSummary(m.pairs),
      divergingRows(m.pairs) +
        detail +
        `<div class="note">来源视图：<code>${esc(viewTxt)}</code>。组级蝴蝶＝本组各 source_view 的增益属性按名累加（与上半「增益对比」全场聚合同原语、不同口径：那里跨全部视图、这里只本组）；逐件明细默认折叠。本组命中 buff_effects ${m.rowCnt} 行（蝴蝶中 pairs 只 sum 有中文名且匹配 BUFF_ATTR_RE 的属性行，所以卡片标题行数和蝴蝶行数可以不一致，属数据特性）。</div>`,
    );
  };
  const attrModules = () => {
    const mods = modAgg();
    const sumRows = mods.reduce((a, m) => a + m.rowCnt, 0);
    const allRows = mods.length ? mods[0].allRowCnt : 0;
    const cover =
      sumRows === allRows
        ? `Σ 各组命中行 ${sumRows} == 本场 buff_effects 总行 ${allRows}（覆盖不变量成立，无静默丢行）`
        : `覆盖异常：Σ 各组命中行 ${sumRows} ≠ 本场总行 ${allRows}`;
    return (
      `<section class="phase">` +
      phaseHd(
        '属性模块构成 · 按来源模块拆分（最详细一层）',
        '每组：组级属性蝴蝶（可对账）+ 该组逐件明细（默认折叠）',
      ) +
      mods.map(modCard).join('') +
      `<div class="note">分组口径：按 <code>source_view</code> 精确枚举到「机甲 / 兵种装备 / 装备强化 / 兵种克制 / 元素伤害 / 英雄 / 军阵 / 装饰 / 皮肤 / 异能兽 / 跨服收藏」，未列中的 view 一律落入「其他编配系统」（旧名「其他来源」，实际包含联盟/VIP/材料/图鉴/秘密武器/城市技能/世界奇观/type:94/96 一类未归入 11 大独立模块组的游戏系统 buff，不是「查不到来源」），禁止静默丢行。对账：${esc(cover)}。属性为开局静态编配量（<code>buff_effects</code> 无回合维度），逐回合动态增益见「回合伤害」TAB。</div>` +
      `</section>`
    );
  };

  // ── 静态编配总览（基本信息上半：把英雄/机甲/军阵的富配置面板提为常显卡片）──
  // 这些面板原折叠在「属性模块构成」各卡片的明细 fold 内（现 parts.DETAILS 已撤出对应项，避免重复渲染）。
  const staticConfig = () => {
    const mechaBlock =
      `<div class="grid2"><div><div class="attc side-tag">攻方</div>${parts.mechaDetail('att')}</div>` +
      `<div><div class="defc side-tag">守方</div>${parts.mechaDetail('def')}</div></div>`;
    return (
      `<section class="phase">` +
      phaseHd(
        '静态编配 · 英雄 / 机甲 / 军阵（开局基础信息）',
        '英雄花名册 + 技能 / 天赋 / 觉醒 / 泰坦 · 机甲部件 / 技能 / 芯片（内置表） · 军阵专精 / 科技 / 等级品质（均取战报静态编配，可对账）',
      ) +
      parts.heroPane() +
      openCard('机甲 · 编配（部件 / 技能 / 芯片）', '攻守并排 · sides.mechas[]', mechaBlock) +
      parts.formPane() +
      `<div class="note">本节把英雄 / 机甲 / 军阵的等级、技能、天赋、觉醒、泰坦装备与魔石、芯片、专精、科技等基础配置提为常显卡片（原折叠在「属性模块构成」明细内，现已移出、不重复）；这些卡的<b>属性蝴蝶</b>仍在下方「属性模块构成」按来源分组保留。</div>` +
      `</section>`
    );
  };

  return { buffCompare, staticConfig, attrModules };
}
