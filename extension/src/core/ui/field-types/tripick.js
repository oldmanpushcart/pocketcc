/**
 * 行内多下拉字段类型 module（type:'tripick'，如异能兽培育「派出的兽 [属相][品种][品质]」）。
 *
 * T5（架构审查候选 1 · Option A 全量收编）：render 迁自 fields.js renderTriPick，
 * 子下拉 change 迁自 wire.js wireControls 的 select.pc-fsel 委托（该通用 handler T5 整段退役）。
 * 一个 label 接 N 个 select，每 part 自己一个 data-key（= 存档键，与 field.key 不同）；
 *   dispatcher 内联路径经 findFieldOwner(f, part.key) 路由到本 module，handler 再经 findFieldDescriptor 下探 parts 取子描述符。
 * 值按 option **原类型**回写（字符串档不被 parseInt 成 NaN），没命中 option 才整数解析（非法值回落 defaults），与 select 同口径。
 *
 * 依赖面 = dom（escAttr/findFieldDescriptor）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr, findFieldDescriptor } from '../dom.js';

/**
 * 行内多下拉 HTML：一个 label 接 N 个 select.pc-fsel.pc-ftri，每 part 一个 data-key。
 * 选项支持数组与函数两种形式（同 select 口径，函数在渲染时求值一次）。
 * 签名照 module render (val, fd, c, fid)，本类型直接读 c[p.key]（val 仅占位对齐）。
 * @param {*} val 配置里的字段值（占位，不读）
 * @param {object} fd 字段描述符（label / parts:[{key,options,title?}]）
 * @param {object} c 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderTriPick(val, fd, c, fid) {
  void val;
  const cells = (fd.parts || [])
    .map((p) => {
      const cur = String(c[p.key]);
      const opts = (typeof p.options === 'function' ? p.options(c) : p.options) || [];
      const inner = opts
        .map(
          (o) =>
            `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`,
        )
        .join('');
      const title = p.title ? ` title="${escAttr(p.title)}"` : '';
      return `<select class="pc-fsel pc-ftri" data-id="${fid}" data-key="${escAttr(p.key)}"${title}>${inner}</select>`;
    })
    .join('');
  return (
    `<label class="pc-row"><span class="pc-triolab">${fd.label}</span>` +
    `<span class="pc-trio">${cells}</span></label>`
  );
}

/** 行内多下拉类型（inline，子下拉 change 按 option 原类型回写 + 存档热更；interface 形状见 index.js 头注释） */
export const tripickType = {
  type: 'tripick',
  kind: 'inline',
  render: renderTriPick,
  events: [
    // 子下拉改动：data-key 是 part.key（≠ 顶层 fd.key），下探 parts 取子描述符，选项取该 part 自己的口径
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
