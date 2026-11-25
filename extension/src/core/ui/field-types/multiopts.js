/**
 * 多选开关组字段类型 module（type:'multiopts'，次元矿洞矿种、快速修理矩阵）。
 *
 * T3（架构审查候选 1）：render 迁自 fields.js multiOptsInnerHTML，events 迁自 wire.js multiopts 委托。
 * 勾选/取消整批重存 number[]；maxSelect>0 时满额回弹（只 refresh 不提交，恢复 disabled 口径，不静默改配置），
 * 「全选」有上限时退化为「取前 N 项」。options 可为运行时函数 fd.options(cfg)。
 * 矩阵布局（fd.matrix）：用行列头代替平铺标签，options 按行优先排列（每行 cols.length 项）。
 *
 * 依赖面 = dom.js（escAttr）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 内层 HTML：标题行（计数 + 全选/清空）+ 选项栅格（每项 checkbox）或矩阵布局。
 * @param {number[]} selected 当前选中值数组
 * @param {object} fd 字段描述符（label / options / hint / gridMin / stack / maxSelect / matrix）
 * @param {object} cfg 该功能当前配置（透传给 fd.options 函数）
 * @returns {string}
 */
function multiOptsInnerHTML(selected, fd, cfg) {
  const opts = (typeof fd.options === 'function' ? fd.options(cfg) : fd.options) || [];
  const sel = Array.isArray(selected) ? selected : [];
  const cap = Math.max(0, Math.floor(Number(fd.maxSelect) || 0));
  // 旧存档可能已超额：满额判定用 >=，超额时已勾项仍可取消（只锁未勾的）
  const full = cap > 0 && sel.length >= cap;
  const top =
    `<div class="pc-mopstop">` +
    `<span class="pc-mopttitle">${escAttr(fd.label || '多选')}</span>` +
    `<span class="pc-moptacts">` +
    (cap > 0 ? `<span class="pc-moptcount">${sel.length}/${cap}</span>` : '') +
    `<button class="pc-moptall" type="button">全选</button>` +
    `<button class="pc-moptnone" type="button">清空</button></span>` +
    `</div>`;
  const hint = fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '';

  // 矩阵布局：带行列头的 grid
  if (fd.matrix && Array.isArray(fd.matrix.cols) && Array.isArray(fd.matrix.rows)) {
    return top + matrixInnerHTML(opts, sel, full, fd.matrix) + hint;
  }

  // 平铺布局（原有）
  const cells = opts
    .map((o) => {
      const on = sel.indexOf(o.value) >= 0;
      const dis = full && !on ? ' disabled' : '';
      return (
        `<label class="pc-mopt${full && !on ? ' pc-moptdis' : ''}">` +
        `<input type="checkbox" class="pc-moptchk" value="${o.value}"${on ? ' checked' : ''}${dis}>` +
        `${escAttr(String(o.label))}</label>`
      );
    })
    .join('');
  const gridStyle = fd.stack
    ? 'grid-template-columns:1fr'
    : fd.gridMin
      ? `grid-template-columns:repeat(auto-fill,minmax(${+fd.gridMin || 72}px,1fr))`
      : '';
  return (
    top +
    `<div class="pc-moptgrid"${gridStyle ? ` style="${gridStyle}"` : ''}>${cells || '<div class="pc-rnghint">暂无可选项</div>'}</div>` +
    hint
  );
}

/**
 * 矩阵布局内部 HTML：用 <table> 渲染带行列头的 checkbox 矩阵。
 * options 按行优先排列（每行 cols.length 项）。
 * @param {Array<{value:number, label:string}>} opts 选项数组（行优先）
 * @param {number[]} sel 已选值
 * @param {boolean} full 是否达上限
 * @param {{cols:string[], rows:string[]}} matrix 矩阵配置
 * @returns {string}
 */
function matrixInnerHTML(opts, sel, full, matrix) {
  const colCount = matrix.cols.length;
  const rowCount = matrix.rows.length;
  let html = '<table class="pc-mmtx"><thead><tr><th class="pc-mmtx-corner"></th>';
  for (const col of matrix.cols) {
    html += `<th class="pc-mmtx-col">${escAttr(col)}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (let r = 0; r < rowCount; r++) {
    html += `<tr><td class="pc-mmtx-row">${escAttr(matrix.rows[r])}</td>`;
    for (let c = 0; c < colCount; c++) {
      const idx = r * colCount + c;
      const o = opts[idx];
      if (!o) {
        html += '<td class="pc-mmtx-cell"></td>';
        continue;
      }
      const on = sel.indexOf(o.value) >= 0;
      const dis = full && !on ? ' disabled' : '';
      html +=
        `<td class="pc-mmtx-cell"><label class="pc-mopt${full && !on ? ' pc-moptdis' : ''}">` +
        `<input type="checkbox" class="pc-moptchk" value="${o.value}"${on ? ' checked' : ''}${dis}>` +
        '</label></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

/** 取本字段配置数组（镜像旧 boxTarget：非数组就地置 []） */
function listOf(ctx) {
  const c = ctx.c;
  const k = ctx.fd.key;
  if (!Array.isArray(c[k])) c[k] = [];
  return c[k];
}

/** 多选开关组类型（box 容器，change 勾选 + click 全选/清空；interface 形状见 index.js 头注释） */
export const multioptsType = {
  type: 'multiopts',
  kind: 'box',
  cls: 'pc-mopts',
  render: multiOptsInnerHTML,
  events: [
    // 勾选/取消：整批重存 number[]；满额回弹只 refresh 不提交（恢复 disabled 口径，不静默改配置）
    {
      on: 'change',
      sel: '.pc-moptchk',
      run(e, ctx) {
        const inp = e.target;
        const list = listOf(ctx);
        const val = parseInt(inp.value, 10);
        const i = list.indexOf(val);
        const cap = Math.max(0, Math.floor(Number(ctx.fd.maxSelect) || 0));
        if (inp.checked && i < 0) {
          if (cap > 0 && list.length >= cap) {
            ctx.refresh(); // 已达上限：回弹该框并重刷，不静默改配置
            return;
          }
          list.push(val);
        } else if (!inp.checked && i >= 0) list.splice(i, 1);
        if (cap > 0) ctx.refresh();
        ctx.commit();
      },
    },
    // 全选/清空：有上限时「全选」退化为「取前 N 项」
    {
      on: 'click',
      sel: '.pc-moptall,.pc-moptnone',
      run(e, ctx) {
        const el = e.target;
        const all = el.closest ? el.closest('.pc-moptall') : null;
        const none = el.closest ? el.closest('.pc-moptnone') : null;
        if (!all && !none) return;
        const list = listOf(ctx);
        const fd = ctx.fd;
        if (all) {
          const opts = (typeof fd.options === 'function' ? fd.options(ctx.c) : fd.options) || [];
          const cap = Math.max(0, Math.floor(Number(fd.maxSelect) || 0));
          const pick = cap > 0 ? opts.slice(0, cap) : opts;
          list.length = 0;
          pick.forEach((o) => list.push(o.value));
        } else {
          list.length = 0;
        }
        ctx.refresh();
        ctx.commit();
      },
    },
  ],
};
