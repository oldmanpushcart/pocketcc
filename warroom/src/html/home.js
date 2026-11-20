// 渲染层·伤害汇总 TAB：战果简介（结果/总览/阵型落点/逐槽战损）+ 伤害构成（主轴本体）。
// 只拼 HTML 字符串；一切取数与归因来自 data.js，格式化原语来自 ui.js，TAB 规则来自 shell.js。
// 增益对比与属性模块构成（基本信息 TAB）在 attrs.js；本文件末尾的 overview/damage 由 summary.js 组装为伤害汇总 TAB。
/**
 * @param {ReturnType<import('./ctx.js').makeCtx>} ctx 字典上下文
 * @param {ReturnType<import('./data.js').makeData>} data 单场取数
 * @param {ReturnType<import('./ui.js').makeUi>} ui 渲染原语
 * @param {ReturnType<import('./shell.js').makeShell>} shell TAB 外壳（收集显示规则）
 */
export function makeHome(ctx, data, ui, shell) {
  const { esc, fmt, pct, DMG_CAT_ORDER, BRANCHES, armyName, armyBranch } = ctx;
  const {
    rep,
    march,
    acc,
    A,
    D,
    grid,
    troops,
    slotTaken,
    takenUnresolved,
    dmgSrc,
    dmgCells,
    roundBins,
    battleMs,
    masteryOfSeq,
    dmgPairs,
    dmgDimPairs,
    dmgSkillPairs,
  } = data;
  const { cmpRow, openCard, drill, fold, divergingRows, cmpSummary, topDiff, phaseHd } = ui;

  // ── ① 战果总览 ─────────────────────────────────────────
  // 一句话战果摘要：回合数 / 战力比 / 超轮 / 时长，置于 KPI 之上
  const verdictLine = () => {
    const pa = march.att_battle_power_val || 0;
    const pd = march.def_battle_power_val || 0;
    const ratio = pd ? (pa / pd).toFixed(3) : '—';
    return `<div class="vline">共 ${roundBins.N} 回合 · ${
      rep.result === 1 ? '攻方胜' : rep.result === 2 ? '守方胜' : '平局/未知'
    } · 战力 ${esc(march.att_battle_power || fmt(pa))} vs ${esc(
      march.def_battle_power || fmt(pd),
    )}（比 ${ratio}）· 超轮 att=${march.att_over_round ?? '-'} / def=${
      march.def_over_round ?? '-'
    } · 时长≈${(battleMs / 1000).toFixed(1)}s（最大结算拍） · fight_type=${rep.fight_type}（协议码 · 非未翻译项）</div>`;
  };
  // KPI 徽章行：横向七枚，每枚左红右蓝两值（沿用 cmpRow 结构，只加修饰类，保证跨版面对账）
  const kpiStrip = () =>
    `<div class="kpis">` +
    [
      cmpRow('总输出伤害', acc.att.dmg, acc.def.dmg),
      cmpRow('命中', acc.att.hit, acc.def.hit),
      cmpRow('暴击', acc.att.crit, acc.def.crit),
      cmpRow('闪避', acc.att.miss, acc.def.miss),
      cmpRow('存活', A.sd.survival, D.sd.survival),
      cmpRow('受伤', A.sd.wounded, D.sd.wounded),
      cmpRow('阵亡', A.sd.dead, D.sd.dead),
    ].join('') +
    `</div><div class="note">命中率 att=${pct(
      acc.att.hit / (acc.att.hit + acc.att.crit + acc.att.miss || 1),
    )} · def=${pct(acc.def.hit / (acc.def.hit + acc.def.crit + acc.def.miss || 1))}。</div>`;
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
  // 开局静态九宫格（不随回合切换、不钉固、随页面滚动）
  // 承伤热区：slotTaken 按 target→side_units.uuids 归位，格内只显占本侧承伤的百分比，金额在战损明细表给。
  // extra(格号) 由调用方追加格内内容：回合 TAB 用它插入「本回合末剩余战力条」，伤害汇总页不传即维持开局形态。
  const takenSide = { att: 0, def: 0 };
  for (const [k, c] of slotTaken) takenSide[k.split('|')[0]] += c.hurt;
  const gridHtml = (side, form, extra = null) =>
    grid[side]
      .map((u, i) => {
        if (!u) return `<div class="cell empty"><span class="cpos">${i}</span></div>`;
        const total = u.uuid_count ?? 0;
        const dead = u.dead_count ?? 0;
        const alive = Math.max(0, total - dead);
        const alivePct = total ? Math.round((alive / total) * 100) : 100;
        const mas = masteryOfSeq(form, i);
        const tk = slotTaken.get(`${side}|${i}`);
        const tkPct = tk && takenSide[side] ? pct(tk.hurt / takenSide[side]) : null;
        return (
          `<div class="cell${mas ? ' mas' : ''}"><div class="crow"><span class="cpos">${i}</span>` +
          (mas
            ? `<span class="mtag" title="军阵专精 Lv${mas.level}">✦ ${esc(mas.skill || '专精')} Lv${mas.level}</span>`
            : '') +
          `</div>` +
          `<div class="cname" title="${esc(armyName(u.army_id))}">${esc(armyName(u.army_id))}</div>` +
          `<div class="cmeta"><span class="btag b${armyBranch(u.army_id)}">${armyBranch(u.army_id)}</span> 共${total}` +
          (tk && tkPct
            ? ` · <span title="本格承受伤害 ${fmt(tk.hurt)} · ${tk.hits} 下">承伤${tkPct}</span>`
            : '') +
          `</div>` +
          `<div class="cbar"><span class="calive" style="width:${alivePct}%"></span></div>` +
          `<div class="cstat"><span class="ok">存活${alive}</span><span class="dead">阵亡${dead}</span></div>` +
          (extra ? extra(i, u) : '') +
          `</div>`
        );
      })
      .join('');
  const formationPanel = () =>
    `<section class="formbar">` +
    `<div class="rnavhd">阵型位置 · 开局编配（静态 · 随页面滚动） <span class="mut">（seq 0–8 站位 · 军阵专精加成 · 存活/受伤/阵亡 · 承伤占比）</span></div>` +
    `<div class="formlayout"><div><div class="attc side-tag">攻方</div>${casBar('att', A.sd)}<div class="grid g-att">${gridHtml('att', A.form)}</div></div>` +
    `<div><div class="defc side-tag">守方</div>${casBar('def', D.sd)}<div class="grid g-def">${gridHtml('def', D.form)}</div></div></div>` +
    `<div class="note">有军阵专精的站位格金黄映衬、✦ 显专精名与等级（站位 pos = row*10+col+1）；格内存活率条按 unit 存活/总数，“承伤 X%”＝该格承受伤害占本侧承伤合计的比例（金额见下方战损明细表）。受伤（伤兵数）取侧级汇总——<code>side_units</code> 每格只有 <code>uuid_count·dead_count</code>，无 wounded 列。逐回合活动见「回合伤害」TAB 各回合卡。</div>` +
    `</section>`;
  // 战损空间分布：槽位维给存活/阵亡（side_units）+ 承受伤害金额（伤害事件 target 归位）。
  // 伤兵数仍只到侧级（无 wounded 列），与承伤金额不同量纲、故各占一列不相加。
  // 行源用 troops 而非 grid：troops 含 seq 9/10 的增援溢出格（全库 12 行），否则那部分承伤无处可归。
  const lossTable = (side) => {
    const rows = [];
    const brAgg = new Map();
    for (const u of troops[side]) {
      const seq = u.seq;
      const br = armyBranch(u.army_id);
      const total = u.uuid_count ?? 0;
      const dead = u.dead_count ?? 0;
      const alive = Math.max(0, total - dead);
      const tk = slotTaken.get(`${side}|${seq}`) || { hurt: 0, hits: 0 };
      rows.push({ seq, br, name: armyName(u.army_id), total, alive, dead, tk, extra: u.is_extra });
      const b = brAgg.get(br) || { total: 0, alive: 0, dead: 0, hurt: 0, hits: 0 };
      b.total += total;
      b.alive += alive;
      b.dead += dead;
      b.hurt += tk.hurt;
      b.hits += tk.hits;
      brAgg.set(br, b);
    }
    const rate = (a, t) => (t ? Math.round((a / t) * 100) : 100);
    const tkCell = (hurt, hits) =>
      `<td class="mv" title="承受 ${hits} 下">${hurt ? fmt(hurt) : '<span class="mut">—</span>'}</td>`;
    const tr = rows
      .map(
        (r) =>
          `<tr><td class="mv">${r.seq}</td><td class="an"><span class="btag b${r.br}">${r.br}</span> ${esc(r.name)}${
            r.seq >= 9 || r.extra ? '<span class="mut"> · 增援溢出格</span>' : ''
          }</td><td class="mv">${fmt(r.total)}</td><td class="mv">${fmt(r.alive)}</td><td class="mv">${fmt(
            r.dead,
          )}</td>${tkCell(r.tk.hurt, r.tk.hits)}<td class="mv">${rate(r.alive, r.total)}%</td></tr>`,
      )
      .join('');
    const tf = [...brAgg.entries()]
      .sort((a, b) => BRANCHES.indexOf(a[0]) - BRANCHES.indexOf(b[0]))
      .map(
        ([br, b]) =>
          `<tr><td class="an" colspan="2">${br} 小计</td><td class="mv">${fmt(b.total)}</td><td class="mv">${fmt(
            b.alive,
          )}</td><td class="mv">${fmt(b.dead)}</td>${tkCell(b.hurt, b.hits)}<td class="mv">${rate(
            b.alive,
            b.total,
          )}%</td></tr>`,
      )
      .join('');
    const sumOf = (k) => rows.reduce((a, r) => a + r[k], 0);
    const hurtAll = rows.reduce((a, r) => a + r.tk.hurt, 0);
    const hitsAll = rows.reduce((a, r) => a + r.tk.hits, 0);
    const tfAll = `<tr><td class="an" colspan="2">本侧合计</td><td class="mv">${fmt(
      sumOf('total'),
    )}</td><td class="mv">${fmt(sumOf('alive'))}</td><td class="mv">${fmt(
      sumOf('dead'),
    )}</td>${tkCell(hurtAll, hitsAll)}<td class="mv">${rate(sumOf('alive'), sumOf('total'))}%</td></tr>`;
    return (
      `<table class="mat"><thead><tr><th>槽</th><th class="an">军种·兵种</th><th>出征</th><th>存活</th><th>阵亡</th><th>承伤</th><th>存活率</th></tr></thead>` +
      `<tbody>${tr || '<tr><td class="mut" colspan="7">无编组</td></tr>'}</tbody><tfoot>${tf}${tfAll}</tfoot></table>`
    );
  };
  const lossBySpace = () =>
    `<div class="grid2">` +
    `<div><div class="attc side-tag">攻方 · 存活 ${fmt(A.sd.survival || 0)} / 受伤 ${fmt(A.sd.wounded || 0)} / 阵亡 ${fmt(A.sd.dead || 0)} / 承伤 ${fmt(takenSide.att)}</div>${lossTable('att')}</div>` +
    `<div><div class="defc side-tag">守方 · 存活 ${fmt(D.sd.survival || 0)} / 受伤 ${fmt(D.sd.wounded || 0)} / 阵亡 ${fmt(D.sd.dead || 0)} / 承伤 ${fmt(takenSide.def)}</div>${lossTable('def')}</div>` +
    `</div>` +
    `<div class="note"><b>承伤</b>列＝该槽位上单位实例承受的伤害金额合计：取四类伤害事件（Attack / HeroAttack / DebuffHurt / MissAttack、val&gt;0）的 <code>target</code>，按 <code>side_units.uuids</code> 归到 (side, seq)；全库 31,672 条伤害事件金额 100% 归位（本侧归不上槽的 ${fmt(takenUnresolved.amt)}）。<b>受伤（伤兵数）</b>只到侧级：<code>side_units</code> 每格只给 <code>uuid_count·dead_count</code>，无 wounded 列，与承伤金额不同量纲，故两列各自成立、不相加也不换算。行源含 seq 9/10 增援溢出格（全库 12 行），故本侧合计可能大于上方九宫格目测之和。<b>与对侧造成的对账</b>：本表承伤合计一般等于对面那侧的造成合计，但全库有 9 条伤害事件的 <code>source</code> 解不到侧（集中在 1 场、金额 6.59T），那部分进不了“造成”口径、只能进“承受”口径。</div>`;
  const overview = () =>
    `<section class="phase">` +
    phaseHd(
      '战果总览 · 谁赢 / 差多少 / 几个回合 / 战损几何',
      '胜负与总量、命中暴击闪避、存活受伤阵亡、逐槽战损（含逐槽承伤金额）；阵型位置与开局编配见「基本信息」TAB',
    ) +
    openCard(
      '战果一览',
      `共 ${roundBins.N} 回合 · ${rep.result === 1 ? '攻方胜' : rep.result === 2 ? '守方胜' : '平局/未知'}`,
      verdictLine() + kpiStrip(),
    ) +
    fold('展开 · 战损空间分布明细（军种 × 阵型槽位 · 存活/阵亡/承伤）', lossBySpace()) +
    `</section>`;

  // ── ② 伤害构成 ─────────────────────────────────────────
  // 各来源技能明细：按来源类别分组，每类内技能做蝶形对比（攻左/守右，从中缝向两边），与主区共用 .vr 网格
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
  // 总量收口：按侧 × 维度（来源类别 / 英雄）的伤害占比条（与看板、acc.dmg 同源 dmgCells）
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
  // 维度可切换的伤害构成 TAB（来源类别 / 军种 / 英雄 / 技能；规则由 shell 生成，默认来源类别）
  const dmgTabs = () =>
    shell.tabs(
      'tab-dmg',
      [
        ['cat', '来源类别'],
        ['branch', '军种'],
        ['hero', '英雄'],
        ['skill', '技能'],
      ].map(([d, lbl]) => ({
        key: d,
        label: lbl,
        body: divergingRows(d === 'skill' ? dmgSkillPairs() : dmgDimPairs(d)),
      })),
      { paneCls: 'tpane' },
    );
  const damage = () =>
    `<section class="phase">` +
    phaseHd(
      '伤害构成 · 双方伤害分别由什么组成（主轴）',
      '按来源类别 / 军种 / 英雄 / 技能维度攻守并排 · 可下钻到具体技能',
    ) +
    openCard(
      '伤害构成（可切换维度 · 攻左红 / 守右蓝 · 共用标尺）',
      cmpSummary(dmgPairs()),
      dmgTabs() +
        `<div class="note">维度可切换：来源类别 / 军种 / 英雄 / 技能。每行两端同标尺，条长按该维度全局最大值归一；Δ 为攻守差。<b>对账</b>：承伤＝对侧造成，四个维度的合计均＝上方「战果总览」的「总输出伤害」（同源 <code>dmgCells</code>，取自 battle_events.val）。</div>` +
        fold('展开 · 各来源类别 → 具体技能明细（攻守对比）', dmgDetail()) +
        fold(
          '展开 · 各侧伤害占比（按来源类别 / 按英雄）',
          `<div class="grid2"><div><div class="attc side-tag">攻方 · 按来源类别</div>${dmgShare('att', 'cat')}<div class="attc side-tag" style="margin-top:10px">攻方 · 按英雄</div>${dmgShare('att', 'hero')}</div><div><div class="defc side-tag">守方 · 按来源类别</div>${dmgShare('def', 'cat')}<div class="defc side-tag" style="margin-top:10px">守方 · 按英雄</div>${dmgShare('def', 'hero')}</div></div>`,
        ),
    ) +
    openCard(
      '伤害差值榜（哪些来源把差距拉开）',
      cmpSummary(dmgPairs()),
      topDiff(dmgPairs(), 8) +
        `<div class="note">按 |攻−守| 降序、分列领先方；口径与本节「伤害构成」一致（同源 dmgPairs）。增益属性差值榜见「基本信息」的增益对比、回合差值榜见「回合伤害」TAB。</div>`,
    ) +
    `</section>`;

  const home = () => overview() + damage();
  return {
    home,
    gridHtml,
    verdictLine,
    kpiStrip,
    formationPanel,
    lossBySpace,
    dmgTabs,
    overview,
    damage,
  };
}
