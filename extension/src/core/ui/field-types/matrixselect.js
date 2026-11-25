/**
 * 矩阵下拉字段类型 module（type:'matrixselect'，快速修理每格选「不维修/普通/道具/钻石」）。
 *
 * 渲染为带行列头的 <table>，每格一枚 <select>；配置值 = {code: mode}（对象）。
 * fd.codes 按行优先排列（每行 cols.length 项），fd.matrix = {cols, rows}，
 * fd.cellOptions = [{value,label}]（每格下拉选项，默认四档）。
 * 全选 → 所有格 mode=1（普通维修），清空 → 所有格 mode=0（不维修）。
 *
 * 依赖面 = dom.js（escAttr）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/** 默认四档选项 */
const DEFAULT_CELL_OPTS = [
  { value: 0, label: '不维修' },
  { value: 1, label: '普通维修' },
  { value: 2, label: '道具维修' },
  { value: 3, label: '钻石维修' },
];

/**
 * 内层 HTML：标题行（全选/清空）+ 矩阵表格（每格 select）。
 * @param {object} val 当前配置值 {code: mode}
 * @param {object} fd 字段描述符
 * @param {object} cfg 该功能当前配置
 * @returns {string}
 */
function render(val, fd, cfg) {
  void cfg;
  const map = val && typeof val === 'object' ? val : {};
  const matrix = fd.matrix;
  const codes = fd.codes || [];
  const cellOpts = fd.cellOptions || DEFAULT_CELL_OPTS;
  const colCount = matrix.cols.length;

  // 标题行
  const top =
    `<div class="pc-mopstop">` +
    `<span class="pc-mopttitle">${escAttr(fd.label || '矩阵选择')}</span>` +
    `<span class="pc-moptacts">` +
    `<button class="pc-moptall" type="button">全选</button>` +
    `<button class="pc-moptnone" type="button">清空</button></span>` +
    `</div>`;

  // 表头
  let html = '<table class="pc-mmtx"><thead><tr><th class="pc-mmtx-corner"></th>';
  for (const col of matrix.cols) {
    html += `<th class="pc-mmtx-col">${escAttr(col)}</th>`;
  }
  html += '</tr></thead><tbody>';

  // 数据行
  const rowCount = matrix.rows.length;
  for (let r = 0; r < rowCount; r++) {
    html += `<tr><td class="pc-mmtx-row">${escAttr(matrix.rows[r])}</td>`;
    for (let c = 0; c < colCount; c++) {
      const idx = r * colCount + c;
      const code = codes[idx];
      const cur = map[code] != null ? map[code] : 0;
      // select
      html += '<td class="pc-mmtx-cell"><select class="pc-mmtx-sel" data-code="' + code + '">';
      for (const o of cellOpts) {
        html += `<option value="${o.value}"${o.value === cur ? ' selected' : ''}>${escAttr(o.label)}</option>`;
      }
      html += '</select></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';

  const hint = fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '';
  return top + html + hint;
}

/** 取本字段的 {code:mode} 映射对象（确保存在） */
function mapOf(ctx) {
  const c = ctx.c;
  const k = ctx.fd.key;
  if (!c[k] || typeof c[k] !== 'object') c[k] = {};
  return c[k];
}

/** 矩阵下拉类型（box 容器，change 逐格回写 + click 全选/清空） */
export const matrixselectType = {
  type: 'matrixselect',
  kind: 'box',
  cls: 'pc-mopts',
  render,
  events: [
    {
      on: 'change',
      sel: '.pc-mmtx-sel',
      run(e, ctx) {
        const sel = e.target;
        const code = parseInt(sel.getAttribute('data-code'), 10);
        const mode = parseInt(sel.value, 10);
        if (!code || isNaN(mode)) return;
        const map = mapOf(ctx);
        map[code] = mode;
        ctx.commit();
      },
    },
    {
      on: 'click',
      sel: '.pc-moptall,.pc-moptnone',
      run(e, ctx) {
        const el = e.target;
        const all = el.closest ? el.closest('.pc-moptall') : null;
        const none = el.closest ? el.closest('.pc-moptnone') : null;
        if (!all && !none) return;
        const map = mapOf(ctx);
        const codes = ctx.fd.codes || [];
        const mode = all ? 1 : 0;
        for (const code of codes) map[code] = mode;
        ctx.refresh();
        ctx.commit();
      },
    },
  ],
};
