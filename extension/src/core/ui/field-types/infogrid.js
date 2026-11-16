/**
 * 只读信息表格字段类型 module（type:'infogrid'）。
 *
 * T3（架构审查候选 1）：render 迁自 fields.js infoGridInnerHTML。纯展示不写配置，故无 events；
 * 行集一律来自 fd.rows(c)，刷新由 panel.js refreshTexts 显式 querySelectorAll('.pc-igraphbox').forEach(refreshFieldBox) 驱动。
 * 空态文案 fd.emptyText（字符串或 function(c)，缺省「暂无记录」）：未读回需显 '—' 的只读列表用函数形态随 loaded 切换。
 * 一行一条记录的固定列栅格：内层 .pc-igraph 带 inline grid-template-columns，行包 .pc-igrow 用 display:contents
 * 把 .pc-igcell 直挂父栅格 → 所有行共用同一套列宽，上下严格对齐且不依赖等宽字体。
 *
 * 依赖面 = dom.js（escAttr）；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 内层 HTML：列头 + 若干记录行（行集来自 fd.rows(c)，本类型不读 val）。
 * @param {object} val 配置里的字段值（本类型不读，行集一律来自 fd.rows）
 * @param {object} fd 字段描述符（label / columns / rows / hint / emptyText）
 * @param {object} c 整个 feature 配置（回传给 fd.rows）
 * @returns {string}
 */
function infoGridInnerHTML(val, fd, c) {
  void val;
  const cols = (fd && fd.columns) || [];
  const raw = fd && typeof fd.rows === 'function' ? fd.rows(c) : [];
  const cell = (col, i, txt, head) =>
    `<span class="pc-igcell pc-igc-${i}${col.align === 'right' ? ' pc-igright' : ''}${head ? ' pc-ighead-cell' : ''}"${col.title ? ` title="${escAttr(col.title)}"` : ''}>${escAttr(txt)}</span>`;
  const head =
    `<div class="pc-igrow pc-igrowhead">` +
    cols.map((col, i) => cell(col, i, col.label || '', true)).join('') +
    `</div>`;
  const rows = (Array.isArray(raw) ? raw : [])
    .map(
      (r) =>
        `<div class="pc-igrow">` +
        cols.map((col, i) => cell(col, i, r && r[i] != null ? String(r[i]) : '', false)).join('') +
        `</div>`,
    )
    .join('');
  const emptyRaw = fd && fd.emptyText;
  const empty = typeof emptyRaw === 'function' ? emptyRaw(c) : emptyRaw || '暂无记录';
  return (
    `<div class="pc-ilisttop">` +
    `<span class="pc-rngtitle">${escAttr((fd && fd.label) || '状态')}</span>` +
    `</div>` +
    `<div class="pc-igraph" style="grid-template-columns:repeat(${Math.max(1, cols.length)},minmax(0,max-content))">` +
    head +
    (rows || `<div class="pc-ignone">${escAttr(empty)}</div>`) +
    `</div>` +
    (fd && fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/** 只读信息表格类型（box 容器，无 events；interface 形状见 index.js 头注释） */
export const infogridType = {
  type: 'infogrid',
  kind: 'box',
  cls: 'pc-igraphbox',
  render: infoGridInnerHTML,
};
