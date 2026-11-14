/**
 * 一行多控件字段类型 module（type:'ctrlrow'，如惧星集结「等级▾ | 方式▾ | 预设队伍▾ | 今日已打」）。
 *
 * T5（架构审查候选 1 · Option A 全量收编）：render 迁自 fields.js renderCtrlRow，
 * 子下拉 change 迁自 wire.js wireControls 的 select.pc-fsel 委托（该通用 handler T5 整段退役）。
 * 一个标签接 N 个控件，每 cell 自己一个 data-key（= 存档键，与 field.key 不同，同 tripick.parts 口径）：
 *   非表格变体（div.pc-row）无 data-fkey 容器 → dispatcher 内联路径经 findFieldOwner(f, cell.key) 路由到本 module；
 *   表格变体（fd.table=true，.pc-hl.pc-ct 带 data-fkey）→ dispatcher 容器路径直接命中本 module。
 *   两路 handler 都经 findFieldDescriptor 下探 cells 取子描述符，选项取该 cell 自己的口径。
 * cell.type='text' 的只读格（.pc-fval）随 refreshTexts 重算：其子描述符 type='text' → 走 text module 的 refreshText 钩子，
 *   故本 module 无需自持 refreshText（与 rallygrid count 走 fd.get 兜底同理，只读格各有归属）。
 *
 * 依赖面 = dom（escAttr/findFieldDescriptor）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr, findFieldDescriptor } from '../dom.js';

/**
 * 一行多控件 HTML：一个标签接 N 个控件；fd.table=true 走表格式排版（与自动打野怪物清单同外观）。
 * 非表格变体不用 label 包裹（label 只关联首个可标签控件，会污染首个 select 的可访问名），每个 select 自带 aria-label。
 * cell.type 只区分 'text'（只读值 .pc-fval，随 refreshTexts 重算）与否（下拉 .pc-fsel）；
 *   下拉选项支持数组与函数（同 select 口径），只读值取 cell.get(cfg)。
 * 表格变体控件类改用 .pc-hlmode/.pc-hlstat 与怪物清单对齐，但 data-key/data-fkey 不变 → wire/refreshTexts 同一条 cells 通路。
 * 签名照 module render (val, fd, c, fid)，本类型直接读 c[p.key]（val 仅占位对齐）。
 * @param {*} val 配置里的字段值（占位，不读）
 * @param {object} fd 字段描述符（label / table / cells:[{key,type?,options,get?,title?,label?}]）
 * @param {object} c 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderCtrlRow(val, fd, c, fid) {
  void val;
  const table = !!fd.table;
  const cells = (fd.cells || [])
    .map((p) => {
      const title = p.title ? ` title="${escAttr(p.title)}"` : '';
      if (p.type === 'text') {
        const v = p.get ? String(p.get(c) || '') : '';
        const cls = table ? 'pc-fval pc-hlstat' : 'pc-fval pc-ftri';
        return `<span class="${cls}"${title} data-fid="${fid}" data-fkey="${escAttr(p.key)}">${v}</span>`;
      }
      const cur = String(c[p.key]);
      const opts = (typeof p.options === 'function' ? p.options(c) : p.options) || [];
      const inner = opts
        .map(
          (o) =>
            `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`,
        )
        .join('');
      const cls = table ? 'pc-fsel pc-hlmode' : 'pc-fsel pc-ftri';
      // 可访问名：表格变体取列头（与可见列名一致），非表格取 cell.title，缺省回落行标签
      const aria = ` aria-label="${escAttr((table ? p.label : '') || p.title || fd.label || '')}"`;
      return `<select class="${cls}" data-id="${fid}" data-key="${escAttr(p.key)}"${title}${aria}>${inner}</select>`;
    })
    .join('');
  if (table) {
    const n = (fd.cells || []).length;
    const cols = `style="grid-template-columns:repeat(${n},minmax(0,1fr))"`;
    const head =
      `<div class="pc-hlrow pc-hlhead" ${cols}>` +
      (fd.cells || [])
        .map((p) => `<span class="pc-cthd">${escAttr(String(p.label || ''))}</span>`)
        .join('') +
      `</div>`;
    return (
      `<div class="pc-hl pc-ct" data-id="${fid}" data-fkey="${escAttr(fd.key)}">` +
      (fd.label
        ? `<div class="pc-hltop"><span class="pc-rngtitle">${escAttr(fd.label)}</span></div>`
        : '') +
      head +
      `<div class="pc-hlrow" ${cols}>${cells}</div>` +
      `</div>`
    );
  }
  // fd.label 缺位时不出标签格（整行宽度给控件），行名交 section 小标题承担
  return (
    `<div class="pc-row">` +
    (fd.label ? `<span class="pc-triolab">${fd.label}</span>` : '') +
    `<span class="pc-trio">${cells}</span></div>`
  );
}

/** 一行多控件类型（inline，子下拉 change 按 option 原类型回写 + 存档热更；interface 形状见 index.js 头注释） */
export const ctrlrowType = {
  type: 'ctrlrow',
  kind: 'inline',
  render: renderCtrlRow,
  events: [
    // 子下拉改动：data-key 是 cell.key（≠ 顶层 fd.key），下探 cells 取子描述符，选项取该 cell 自己的口径
    {
      on: 'change',
      sel: '.pc-fsel',
      run(e, ctx) {
        const sel = e.target;
        const src = findFieldDescriptor(ctx.f, sel.dataset.key);
        if (!src) return;
        const key = src.key;
        const opts = (typeof src.options === 'function' ? src.options(ctx.c) : src.options) || [];
        const hit = opts.find((o) => String(o.value) === sel.value);
        let v = hit ? hit.value : parseInt(sel.value, 10);
        if (!hit && isNaN(v)) v = ctx.f.defaults[key];
        sel.value = String(v);
        ctx.c[key] = v;
        ctx.commit();
      },
    },
  ],
};
