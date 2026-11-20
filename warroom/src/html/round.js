// 渲染层·回合 TAB：一级 rd TAB 组（总览 + 第 1..N 回合），每回合卡按伤害汇总同款五段读法组织：
// ① 本回合兵力分布（九宫格 · 回合末剩余战力）② 本回合伤害构成（主轴）③ 本回合增益活动 ④ 本回合节奏（结算拍轴）⑤ 数据边界固定句。
// 九宫格版面复用伤害汇总页的 home.gridHtml（由入口 opts 注入），只在格内追加剩余战力条。
// 主轴纪律：一律攻守并排（divergingRows）、合计可回该回合 dealt 对账、明细默认折叠。
// 增益台账（整本三册）已上移至基本信息 TAB（attrs.js），本 TAB 每回合只留活动线与严格配对时长条子集。
/**
 * @param {ReturnType<import('./ctx.js').makeCtx>} ctx 字典上下文
 * @param {ReturnType<import('./data.js').makeData>} data 单场取数
 * @param {ReturnType<import('./ui.js').makeUi>} ui 渲染原语
 * @param {ReturnType<import('./shell.js').makeShell>} shell TAB 外壳（rd 一级组）
 * @param {{gridHtml?:Function,formAtt?:any,formDef?:any}} opts 九宫格版面与两侧阵型（入口注入）
 */
export function makeRound(ctx, data, ui, shell, opts = {}) {
  const { fmt, esc, pct, sumMap, BRANCHES, DMG_CAT_ORDER } = ctx;
  const { gridHtml = () => '', formAtt = null, formDef = null } = opts;
  const {
    roundBins,
    dmgAgg,
    roundAgg,
    forceAgg,
    roundPairs,
    roundEmpty,
    tickBins,
    sustainDurByRound,
    roundDiffPairs,
    RANGE_ORDER,
    buffRangeOf,
    buffTimingOf,
  } = data;
  const { openCard, fold, phaseHd, cmpRow, divergingRows, topDiff, heatTable, shortFor } = ui;

  // 回合 × 维度 热力（列=回合、行=维度值）；dim: cat/branch/seq/其余按总量降序
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
    const rows = order.map((k) => [k, m.get(k)]);
    const rounds = roundBins.bins.map((b) => b.round);
    return rows.length ? heatTable(rows, rounds) : '<div class="mut">无伤害事件</div>';
  };

  // 本回合增益活动：攻守两列「施加 Top + 移除计数」。施加按施加者侧（source），移除按携带者侧——两个角色、不相减。
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
      return `<div><div class="${side === 'def' ? 'defc' : 'attc'} side-tag">${
        side === 'def' ? '守方' : '攻方'
      } · 施加 ${sumMap(r.apply[side])} · 移除 ${r.remove[side]}</div>${chips}</div>`;
    };
    return `<div class="grid2">${col('att')}${col('def')}</div>`;
  };
  // 施加活动按 keyFn 归桶为攻守并排 pairs（次数口径与 r.apply 一致）
  const applyBuckets = (r, keyFn) => {
    const m = new Map();
    for (const side of ['att', 'def'])
      for (const [nm, c] of r.apply[side]) {
        const k = keyFn(nm);
        if (!m.has(k)) m.set(k, { att: 0, def: 0 });
        m.get(k)[side] += c;
      }
    return [...m.entries()].map(([name, v]) => ({ name, att: v.att, def: v.def }));
  };
  // 按属性维度分组直接吃 roundAgg.applyAttr（已在 data 层用 ATTR_NAME_RE 反解属性名过滤）
  const applyAttrPairs = (r) => {
    const m = new Map();
    for (const side of ['att', 'def'])
      for (const [nm, c] of r.applyAttr[side]) {
        if (!m.has(nm)) m.set(nm, { att: 0, def: 0 });
        m.get(nm)[side] += c;
      }
    return [...m.entries()].map(([name, v]) => ({ name, att: v.att, def: v.def }));
  };

  // ── 结算拍轴（battle_events.tl）：列=拍、行=造成/释放/增益活动，每格上攻下守 ──
  const TICK_CHIP_MAX = 6;
  const tickSec = (tl) => `+${(tl / 1000).toFixed(1)}s`;
  const alpha = (v, mx) => (v ? (0.12 + (v / mx) * 0.73).toFixed(3) : 0);
  const tickCols = (N) => {
    const rb = tickBins.get(N);
    return rb ? rb.order.map((k) => rb.ticks.get(k)) : [];
  };
  const castCell = (t) => {
    const zone = (side) => {
      const c = t.cast[side];
      const m = t.bySkill[side];
      if (!c) return '<div class="tza"></div>';
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
      const full = esc(sorted.map(([nm, n]) => `${nm} ×${n}`).join(' / '));
      const shown = sorted
        .slice(0, TICK_CHIP_MAX)
        .map(
          ([nm, n]) =>
            `<span class="tkc" title="${esc(nm)} 释放 ${n} 次">${esc(shortFor(nm))}${n > 1 ? ` <b>×${n}</b>` : ''}</span>`,
        )
        .join('');
      const more =
        sorted.length > TICK_CHIP_MAX
          ? `<span class="tkc" title="${full}">+${sorted.length - TICK_CHIP_MAX} 种</span>`
          : '';
      return `<div class="tza ${side}" title="${side === 'def' ? '守方' : '攻方'}本拍共释放 ${c} 次">${shown}${more}</div>`;
    };
    return `<td class="hcell">${zone('att')}${zone('def')}</td>`;
  };
  const tickAxis = (N) => {
    const cols = tickCols(N);
    if (cols.length < 2)
      return '<div class="mut">本回合结算全落在同一拍（tl 为 1.2s 定拍），拍内先后不可辨，故无轴可画。</div>';
    const mxD = Math.max(1, ...cols.flatMap((t) => [t.dmg.att, t.dmg.def]));
    const sumD = (s) => cols.reduce((x, t) => x + t.dmg[s], 0);
    const mxB = Math.max(
      1,
      ...cols.flatMap((t) => [t.apply.att + t.remove.att, t.apply.def + t.remove.def]),
    );
    const sumB = (s) => cols.reduce((x, t) => x + t.apply[s] + t.remove[s], 0);
    const sumC = (s) => cols.reduce((x, t) => x + t.cast[s], 0);
    const heatCell = (va, vd, ca, cd) =>
      `<td class="hcell"><span class="ha" style="background:rgba(255,91,106,${ca})">${va}</span><span class="hd" style="background:rgba(74,163,255,${cd})">${vd}</span></td>`;
    const rows =
      `<tr><td class="rk" title="本拍造成的伤害（攻上/守下）">造成 攻/守</td>` +
      cols
        .map((t) =>
          heatCell(
            t.dmg.att ? fmt(t.dmg.att) : '·',
            t.dmg.def ? fmt(t.dmg.def) : '·',
            alpha(t.dmg.att, mxD),
            alpha(t.dmg.def, mxD),
          ),
        )
        .join('') +
      `<td class="rkt">${esc(fmt(sumD('att')))}/${esc(fmt(sumD('def')))}</td></tr>` +
      `<tr><td class="rk" title="本拍技能释放数（攻上/守下）">释放 攻/守</td>` +
      cols.map(castCell).join('') +
      `<td class="rkt">${sumC('att')}/${sumC('def')}</td></tr>` +
      `<tr><td class="rk" title="本拍施加次数按施加者侧、移除次数按携带者侧（RemoveSkillBuff.source 实测为携带者）：两个角色不同，故不相减">增益 +施/-移</td>` +
      cols
        .map((t) =>
          heatCell(
            `+${t.apply.att}/-${t.remove.att}`,
            `+${t.apply.def}/-${t.remove.def}`,
            alpha(t.apply.att + t.remove.att, mxB),
            alpha(t.apply.def + t.remove.def, mxB),
          ),
        )
        .join('') +
      `<td class="rkt">+${sumB('att')}/-${sumB('def')}</td></tr>`;
    return (
      `<div class="hxwrap"><table class="hx tk"><thead><tr><th class="rk">量＼拍</th>` +
      cols.map((t) => `<th title="结算拍 tl=${t.tl}ms">${tickSec(t.tl)}</th>`).join('') +
      `<th>回合合计</th></tr></thead><tbody>${rows}</tbody></table></div>`
    );
  };
  const tickNote = (N) => {
    const cols = tickCols(N);
    if (cols.length < 2) return '';
    return (
      `<div class="note">横轴是 <code>battle_events.tl</code>：45 场全库 166 个取值、步长以 1.2s 为主（154 档，另 0.6s×10、1.8s×1），是<b>结算定拍</b>而非真实耗时，` +
      `同一拍内先后不可还原（只能退回结算序号）。本回合跨 ${tickSec(cols[0].tl)} → ${tickSec(cols[cols.length - 1].tl)}、共 ${cols.length} 拍。` +
      `「造成」行合计＝上方「本回合造成」（同一判据）。` +
      `「增益」行两个数字分属两个角色：<b>+施</b>按施加者侧（施加事件 source）、<b>-移</b>按携带者侧` +
      `（<code>RemoveSkillBuff.source</code> 实测是「buff 从谁身上消失」的单位，不是当初的施加者），所以同格里的 +施 与 -移 一般对不上、也不该互抵。` +
      `本拍轴上不画时长条；能严格配上的实例时长列在本段之后。</div>`
    );
  };

  // 实例时长条：只画「同一携带者 + 同一 buff_id + 施加事件本身点名了该携带者」的严格配对；配不到的不出现（是缺证据、非无时长）。
  const durStrip = (N) => {
    const arr = sustainDurByRound.get(N);
    if (!arr || !arr.length) return '';
    const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
    const mx = Math.max(...arr.map((x) => x.med));
    return (
      `<div class="side-tag">实例时长 · 仅严格配对（同携带者 · 施加事件点名）</div>` +
      arr
        .map(
          (x) =>
            `<div class="bar" title="buff_id ${esc(x.id)} · ${x.n} 条配对 · 最窄 ${sec(x.min)} · 最宽 ${sec(
              x.max,
            )} · 从${x.side === 'def' ? '守' : '攻'}方单位身上摘除"><span class="bk">${esc(
              shortFor(x.name),
            )} · ${x.side === 'def' ? '守方身上' : '攻方身上'}</span>` +
            `<span class="rbc"><i class="bf${x.side === 'def' ? ' d' : ''}" style="width:${
              mx ? (x.med / mx) * 100 : 0
            }%"></i></span><span class="bv">${sec(x.med)}</span></div>`,
        )
        .join('') +
      `<div class="mut">条长＝同一单位身上从「点名挂上」到「摘除」的实测间隔中位（<code>tl</code> 定拍差、步长 1.2s）。只含可严格配对的实例，不是全量增益时长。</div>`
    );
  };

  // ── 逐回合剩余战力（兵力）：判据是伤害事件 power 列＝被击方结算后的剩余战力快照 ──
  // 总览给「战力衰减走势」（每回合末、按对局起始总量归一的并排柱），回合卡给「九宫格逐格残力」。
  const forceTrend = () => {
    const fa = forceAgg || { rounds: [], base: { att: [], def: [] }, gridMax: { att: 0, def: 0 } };
    if (!fa.rounds.length)
      return `<div class="card"><h2>兵力衰减走势（逐回合末剩余战力）</h2><div class="mut">本战报伤害事件不带 <code>power</code> 列（早期结算阶段场次的报文不下发逐次剩余战力快照），无走势可画。</div></div>`;
    const tot0 = fa.gridMax.att + fa.gridMax.def || 1;
    const at = fa.base.att;
    const df = fa.base.def;
    const cols = fa.rounds
      .map((n) => {
        const a = at.find((x) => x.round === n);
        const d = df.find((x) => x.round === n);
        const va = a ? a.end : 0;
        const vd = d ? d.end : 0;
        const bar = (cls, v, t) =>
          `<span class="fbar ${cls}" style="height:${Math.max(
            0,
            Math.min(100, (v / tot0) * 100),
          )}%" title="${t}"></span>`;
        return `<div class="fcol"><div class="fbarwrap">${bar(
          'a',
          va,
          `第 ${n} 回合末 攻方剩余 ${fmt(va)} · 占对局起始总量 ${pct(va / tot0)}`,
        )}${bar(
          'd',
          vd,
          `第 ${n} 回合末 守方剩余 ${fmt(vd)} · 占对局起始总量 ${pct(vd / tot0)}`,
        )}</div><div class="fx">${n}</div></div>`;
      })
      .join('');
    const line = (s, zh, cls) =>
      `${zh} ` +
      fa.rounds
        .map((n) => {
          const e = s.find((x) => x.round === n);
          return `<span class="${cls}" title="第 ${n} 回合末">${pct((e ? e.end : 0) / tot0)}</span>`;
        })
        .join(' ');
    return (
      `<div class="card"><h2>兵力衰减走势（逐回合末剩余战力 · 柱高按对局起始双方总量归一）</h2>` +
      `<div class="ftrend">${cols}</div>` +
      `<div class="note">${line(at, '攻方剩余占比走势', 'attc')}<br>${line(df, '守方剩余占比走势', 'defc')}</div>` +
      `<div class="note"><b>判据</b>：<code>battle_events.power</code> 在被击方（<code>target</code>）的伤害事件上＝该次结算后的剩余战力快照；` +
      `按 <code>side_units.uuids</code> 归到槽位、按 IndexRound 切回合，取回合内最小值即该回合末残力（实测沿结算序单调不增、槽首值≈<code>max_power</code>）。` +
      `柱高把双方放在同一把尺上（分母＝开局双方 <code>max_power</code> 之和），所以两根柱之和会随歼敌递减、可读作“此消彼长”。` +
      `<b>口径边界</b>：快照只在该单位被击时刷新，整回合未被击的格沿用上一次快照值（图上不另作标记，故柱高是“已知残力”而非精确定时采样）；` +
      `战力可被增援/补给抬高，故不作为“累计承伤”使用，累计承伤一律看伤害构成节。</div>` +
      `</div>`
    );
  };
  // 回合卡 · 本回合九宫格逐格残力（复用伤害汇总页九宫格版面，extra 只加一条战力条）
  const forceGrid = (N) => {
    const fa = forceAgg;
    if (!fa || !fa.rounds.length)
      return '<div class="mut">本战报无逐次剩余战力快照（power 列未下发）。</div>';
    const sideBlock = (side, form) => {
      const mx = fa.gridMax[side] || 1;
      return (
        `<div class="${side === 'def' ? 'defc' : 'attc'} side-tag">${side === 'def' ? '守方' : '攻方'} · 回合末剩余战力（占开局 ${pct(
          (fa.base[side].find((x) => x.round === N) || { end: mx }).end / mx,
        )}）</div>` +
        `<div class="grid g-${side}">${gridHtml(side, form, (i, u) => {
          const max = Number(u.max_power) || 0;
          const byR = fa.slot.get(`${side}|${i}`);
          const v = byR ? byR.get(N) : undefined;
          if (v == null) return '<div class="fpow mut">本回合未被击 · 无新快照</div>';
          return (
            `<div class="fpow"><span>${fmt(v)} / ${fmt(max)} · ${pct(max ? v / max : 0)}</span>` +
            `<span class="fpbar"><span style="width:${Math.max(
              0,
              Math.min(100, (v / (max || 1)) * 100),
            )}%"></span></span></div>`
          );
        })}</div>`
      );
    };
    return (
      `<div class="formlayout"><div>${sideBlock('att', formAtt)}</div><div>${sideBlock(
        'def',
        formDef,
      )}</div></div>` +
      `<div class="note">格内条长与百分数＝该槽位<b>本回合末</b>剩余战力占其开局 <code>max_power</code> 的比例（同一 <code>power</code> 判据，未被击的格给“无新快照”而不是补 0）。` +
      `增援溢出格（seq 9/10）不在九宫格内，其残力只计入上方侧级合计与该侧走势柱。</div>`
    );
  };

  // ── 每回合卡：五段（兵力分布 / 伤害构成 / 增益活动 / 节奏 / 边界）──
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
    // 段 1 · 本回合伤害构成（主轴 · 与伤害汇总同款：四维常显 + 逐技能 + 槽位折叠）
    const dimBlock = (label, mp) =>
      `<div class="side-tag">${label}</div>` +
      (mp.size ? divergingRows(roundPairs(mp)) : '<div class="mut">—</div>');
    const noDmg = !da && !dd;
    const segDmg =
      cmpRow('本回合造成', da, dd) +
      cmpRow('本回合承受', dd, da) +
      `<div class="note">主导来源 攻：${domTop('att')} ｜ 守：${domTop('def')}。承伤＝对侧本回合造成。技能释放 攻${r.casts.att}/守${r.casts.def} · 施加 攻${sumMap(r.apply.att)}/守${sumMap(r.apply.def)} · 移除 攻${r.remove.att}/守${r.remove.def} · 行动编组(ARMYROUND) 攻${r.acted.att.size}/守${r.acted.def.size}。</div>` +
      (noDmg
        ? '<div class="mut">本回合无伤害事件</div>'
        : dimBlock('按来源类别（攻左红 / 守右蓝）', r.cat) +
          dimBlock('按军种', r.branch) +
          dimBlock('按英雄 / 兵格', r.hero) +
          dimBlock('按技能（逐技能蝴蝶）', r.skill) +
          fold(
            '展开 · 按槽位',
            dimBlock('槽位', r.seq) +
              `<div class="note"><b>对账</b>：本回合各维合计（来源类别 / 军种 / 英雄 / 技能 / 槽位）均＝本回合「造成」（同一 <code>dmgCells</code> 按 IndexRound 切回合），Σ 各回合＝伤害汇总页 KPI「总输出伤害」。</div>`,
          ));
    // 段 2 · 本回合增益活动
    const rangePairs = applyBuckets(r, buffRangeOf);
    const rangeOrdered = RANGE_ORDER.map((k) => rangePairs.find((p) => p.name === k)).filter(
      (p) => p && (p.att || p.def),
    );
    const timingPairs = applyBuckets(r, buffTimingOf);
    const attrPairs = applyAttrPairs(r);
    const segBuff =
      `<div class="side-tag">施加 Top / 移除计数（攻左 · 守右）</div>` +
      roundBuffChips(r) +
      fold(
        '展开 · 三维分组（按生效范围 / 按属性维度 / 按时机 · 均为施加次数）',
        `<div class="attc side-tag">按生效范围</div>${
          rangeOrdered.length ? divergingRows(rangeOrdered) : '<div class="mut">—</div>'
        }<div class="defc side-tag" style="margin-top:8px">按属性维度（增益名反解属性）</div>${
          attrPairs.length ? divergingRows(attrPairs) : '<div class="mut">—</div>'
        }<div class="attc side-tag" style="margin-top:8px">按时机</div>${
          timingPairs.length ? divergingRows(timingPairs) : '<div class="mut">—</div>'
        }` +
          `<div class="note">范围/时机判据同基本信息「开局编配增益总账」（<code>buffRangeOf</code>/<code>buffTimingOf</code> 按增益名正则）；属性维度取 <code>ATTR_NAME_RE</code> 能反解出属性名的施加项。分桶合计＝该侧本回合施加总数。</div>`,
      ) +
      durStrip(N);
    // 段 3 · 本回合节奏
    const segTick = tickAxis(N) + tickNote(N);
    return openCard(
      `第 ${N} 回合 · 兵力分布 / 伤害构成 / 增益活动 / 节奏`,
      `攻造成 ${fmt(da)} · 守造成 ${fmt(dd)} · ${momentum}`,
      `<h2 style="margin-top:2px">① 本回合兵力分布（九宫格 · 回合末剩余战力）</h2>` +
        forceGrid(N) +
        `<h2 style="margin-top:14px">② 本回合伤害构成（主轴）</h2>` +
        segDmg +
        `<h2 style="margin-top:14px">③ 本回合增益活动</h2>` +
        segBuff +
        `<h2 style="margin-top:14px">④ 本回合节奏 · 按结算拍（攻上红 / 守下蓝）</h2>` +
        segTick +
        `<div class="note"><b>⑤ 数据边界</b>：属性为开局静态编配量，战报无逐回合属性快照（判据：<code>buff_effects</code> 无回合/时间列），故本回合不给属性对比，只给增益活动；静态属性总账见「基本信息」TAB。逐回合兵力只到“回合末”粒度（ power 快照在被击时刷新），见本回合 ① 节注。</div>`,
    );
  };

  // ── 总览子页：回合×军种热力 + 来源类别热力 + 回合差值榜 + 数据边界卡 ──
  const roundOverview = () =>
    openCard(
      '回合 × 军种 一览',
      `${roundBins.N} 回合 · 各军种逐回合造成（攻暖/守冷）· 可对账`,
      dmgRoundMatrix('branch') +
        `<div class="note">列=回合、行=军种，每格上暖=攻方造成/下冷=守方造成；“列合计攻/守”逐回合＝对应回合卡「本回合造成」、全场＝伤害汇总页 KPI「总输出伤害」。站位按 army 归并不可靠，故一览到军种。</div>`,
    );
  const roundDiffBoard = () =>
    openCard(
      '回合差值榜（哪个回合攻守拉开）',
      '',
      topDiff(roundDiffPairs(), 8) +
        `<div class="note">按 |攻−守| 降序、分列领先方（Δ 为该回合造成之差）；口径＝各回合卡「本回合造成」。主轴是回合，故差值榜放本 TAB 顶部。</div>`,
    );
  // 数据边界卡：两件「看着该有、但战报给不出」的事，附实测判据（写进产物而非只写 README）。
  const roundBoundary = () =>
    `<div class="card"><h2>本模块的数据边界（两件做不出的事 · 已实测）</h2>` +
    `<ul class="bound">` +
    `<li><b>逐回合兵力只到「回合末」粒度、且只在被击时刷新</b>：剩余战力本身拿得到——` +
    `伤害事件的 <code>power</code> 列在<b>被击方</b>（<code>target</code>）上就是该次结算后的剩余战力快照（41/45 场下发，同一槽位沿结算序单调不增、槽首值≈<code>side_units.max_power</code>），` +
    `走势与九宫格即用此列。但 <code>IndexRound</code> 标记落在<b>回合末尾</b>（实测 idx 2 / 1007 / 1966 / 2487），` +
    `回合起点没有独立快照，所以<b>“本回合未被击”与“被击但未掉战力”不可区分</b>：前者沿用上一回合末值、九宫格显式标为「无新快照」，走势柱则按携带前值画。` +
    `另：战力可被增援/补给抬高（故不把它当累计承伤），<code>seq</code> 9/10 的增援溢出格不在九宫格内、只进侧级合计。</li>` +
    `<li><b>全量增益时长条</b>（只做了严格配对子集，见各回合卡末尾时长条）：卡住它的不在移除侧而在施加侧——` +
    `<code>RemoveSkillBuff</code> 21,100 条 <code>target</code> 列 <b>100% 为空</b>，携带者只能靠它的 <code>source</code>（实测语义）拿；` +
    `而占施加类多数的 <code>ADDMUTIBUFFS</code> 7,607 条 <b>target 0 条有值</b>。全库时长只能严格配到 843 条（4.0%）/ 23 个 buff_id，跨度中位 16.8s；` +
    `整本增益台账（按携带者分三本）在「基本信息」TAB「战斗内增益施加对比」内，本 TAB 只留逐回合活动线与时长条子集。</li>` +
    `<li><b>拍内精确先后</b>：<code>tl</code> 是 1.2s 定拍（45 场全库 166 个取值），一拍内最多堆过 337 个事件，同拍先后只能退回结算序号；` +
    `故本轴<b>不声称能还原“谁先出手”</b>。</li>` +
    `</ul></div>`;

  const overviewSub = () =>
    forceTrend() +
    roundOverview() +
    roundDiffBoard() +
    fold('展开 · 回合 × 来源类别 热力（高伤来自哪类·哪回合）', dmgRoundMatrix('cat')) +
    roundBoundary();

  /** 回合 TAB 主体：一级 rd TAB 组（总览 + 第 1..N 回合），默认选中总览。 */
  const round = () =>
    `<section class="phase">` +
    phaseHd(
      '回合 · 每一回合各造成多少 / 差在哪一回合拉开',
      '总览（战力衰减走势 + 回合×军种热力 + 回合差值榜）+ 逐回合五段（兵力分布 / 伤害构成 / 增益活动 / 节奏 / 边界）',
    ) +
    shell.tabs(
      'rd',
      [
        { key: 'ov', label: '总览', body: overviewSub() },
        ...roundBins.bins.map((b) => ({
          key: String(b.round),
          label: `第 ${b.round} 回合`,
          body: roundCard(b.round),
        })),
      ],
      { cls: 'snav', checked: 'ov' },
    ) +
    `</section>`;

  return { round };
}
