// 渲染层·原语：只吃 ctx 的格式化/解名工具，不碰单场数据，也不碰字典。
// 每个原语都是纯字符串函数（同输入同输出），视图层拼装时按需取用。
/**
 * @param {ReturnType<import('./ctx.js').makeCtx>} ctx 字典上下文（见 ctx.js）
 */
export function makeUi(ctx) {
  const { esc, fmt, sumMap } = ctx;

  // 攻/守一行两值：左红右蓝，是「可对账」版面的最小单元（首页 KPI 条亦复用此结构）
  const cmpRow = (label, av, dv, f = fmt) =>
    `<div class="cmp"><span class="cn attc">${esc(f(av))}</span><span class="cl">${esc(label)}</span><span class="cn defc">${esc(f(dv))}</span></div>`;
  // 榜单名过长时截断（title 属性仍给全名）
  const shortFor = (s) => (s && s.length > 24 ? s.slice(0, 22) + '…' : s);
  // 通用加成数值格式化：p.vt 10000=万分比(÷100→%)、1=绝对值；其余回落 fmt
  const vtFmt = (v, p) =>
    p && p.vt === 10000
      ? (v / 100).toFixed(1) + '%'
      : p && p.vt === 1
        ? String(Math.round(v))
        : fmt(v);

  // ── 对比优先原语 ──
  // 共用标尺的对称蝴蝶对比行：每行 攻值 | 攻条(左红) | 名称+Δ(居中) | 守条(右蓝) | 守值，两柱从中心向两侧生长，占优侧高亮、另一侧 dim
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
  // 差值榜：按 |攻−守| 降序、分列领先方（客观归因用）
  const topDiff = (pairs, n = 6) => {
    const act = pairs
      .filter((p) => (p.att || 0) !== (p.def || 0))
      .map((p) => ({ ...p, gap: (p.att || 0) - (p.def || 0) }));
    const mx = Math.max(1, ...act.map((p) => Math.abs(p.gap)));
    const line = (p, cls) =>
      `<div class="bar"><span class="bk" title="${esc(p.name)} · 攻 ${esc(vtFmt(p.att, p))} / 守 ${esc(vtFmt(p.def, p))}">${esc(shortFor(p.name))}</span><span class="rbc"><i class="bf${cls === 'd' ? ' d' : ''}" style="width:${(Math.abs(p.gap) / mx) * 100}%"></i></span><span class="bv">Δ ${esc(vtFmt(Math.abs(p.gap), p))}</span></div>`;
    const grp = (t, arr, cls) =>
      `<div><div class="${cls === 'd' ? 'defc' : 'attc'} side-tag">${t}</div>${
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

  // ── 容器原语 ──
  // 展开卡：标题（+可选摘要 chip）直接展开、内部不收折
  const openCard = (title, summary, body) =>
    `<div class="card"><h2>${title}${summary ? ` <span class="opsum">${summary}</span>` : ''}</h2>${body}</div>`;
  // 卡内钻取明细：直接展开、无收起（原 <details> 折叠降级为常显块）
  const drill = (title, body, extraClass = '') =>
    `<div class="dnode ${extraClass}"><div class="dnode-t">${title}</div><div class="dx">${body}</div></div>`;
  // 逐件/明细折叠层：默认收起（<details>），满足“汇总为主 + 逐件可展开”
  const fold = (title, body, extraClass = '') =>
    `<details class="dnode dfold ${extraClass}"><summary class="dnode-t">${title}</summary><div class="dx">${body}</div></details>`;
  // 逐侧 detail 网格（攻/守并排），供折叠第二层
  const sideGrid = (fn) =>
    `<div class="grid2"><div><div class="attc side-tag">攻方</div>${fn('att')}</div><div><div class="defc side-tag">守方</div>${fn('def')}</div></div>`;
  // 阶段大标题
  const phaseHd = (zh, sub) => `<h1 class="phasehd">${zh}<span class="phsub">${sub}</span></h1>`;
  // 编配对比折叠卡：静态属性 diverging + 逐件明细二层折叠（detailFn(side) 走攻/守并排；opts.combined 时 detailFn() 自带对照布局）
  const cmpPanelCard = (title, pairs, detailFn, note, opts = {}) => {
    const {
      combined = false,
      detailLabel = '展开 · 逐件明细（攻/守）',
      suffix = '开局编配·静态',
    } = opts;
    const detail = detailFn ? fold(detailLabel, combined ? detailFn() : sideGrid(detailFn)) : '';
    return openCard(
      `${title}（${suffix}）`,
      cmpSummary(pairs),
      divergingRows(pairs) + detail + (note ? `<div class="note">${note}</div>` : ''),
    );
  };
  // 英雄条状徽章
  const hchip = (label, lv, cls) =>
    `<span class="chip ${cls}">${esc(label)}${lv != null ? ` <b>Lv${lv}</b>` : ''}</span>`;

  // ── 表格原语 ──
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

  return {
    cmpRow,
    shortFor,
    vtFmt,
    divergingRows,
    cmpSummary,
    topDiff,
    openCard,
    drill,
    fold,
    sideGrid,
    phaseHd,
    cmpPanelCard,
    hchip,
    heatTable,
  };
}
