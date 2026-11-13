/**
 * 单下拉字段类型 module（type:'select'，如战争之源按形态选预设部队）。
 *
 * T4（架构审查候选 1）：render 迁自 fields.js renderSelect，events 迁自 wire.js wireControls 的 select.pc-fsel 委托。
 * 值按 descriptor 的 option **原类型**回写：字符串档（如卡车「时段模板」、目标模式 random/specify）过去被 parseInt
 * 成 NaN → 静默回落 defaults，用户选完像没生效；没命中 option 才走旧的整数解析（保留非法值兜底）。
 * fd.options 支持数组与函数（开面板时现形现扫配置表），与 multiopts 同源口径。
 *
 * 双轨守卫：dispatcher 内联路径仅接「顶层」type:'select' 字段；tripick.parts / ctrlrow.cells 的子下拉
 *   （.pc-fsel.pc-ftri，data-key 是 part/cell.key，反查到的子描述符非顶层）仍走旧绑定（T5 迁），不被本 module 误吞。
 *
 * 依赖面 = ctx；不反查 fields.js/wire.js。
 */

/**
 * 行 HTML：label 接一枚 select.pc-fsel，选项现值 = String(c[fd.key])。
 * @param {*} val 配置里的字段值（本类型直接读 c[fd.key]，val 仅占位对齐 module render 签名）
 * @param {object} fd 字段描述符（label / key / options）
 * @param {object} c 该功能当前配置（透传给 fd.options 函数）
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderSelect(val, fd, c, fid) {
  void val;
  const cur = String(c[fd.key]);
  // fd.options 既可以是数组也可以是函数（开面板时现形现扫配置表）。
  //   不先判类型直接 .map 会在游戏表未就绪时抛「(fd.options || []).map is not a function」。
  const opts = (typeof fd.options === 'function' ? fd.options(c) : fd.options) || [];
  const html = opts
    .map(
      (o) =>
        `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`,
    )
    .join('');
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<select class="pc-fsel" data-id="${fid}" data-key="${fd.key}">${html}</select></label>`
  );
}

/** 单下拉类型（inline，change 按 option 原类型回写 + 存档热更；interface 形状见 index.js 头注释） */
export const selectType = {
  type: 'select',
  kind: 'inline',
  render: renderSelect,
  events: [
    // 存档 + 运行中热更：命中 option 取其原类型值，没命中才整数解析（非法值回落 defaults）
    {
      on: 'change',
      sel: '.pc-fsel',
      run(e, ctx) {
        const sel = e.target;
        const fd = ctx.fd;
        const key = fd.key;
        const opts = (typeof fd.options === 'function' ? fd.options(ctx.c) : fd.options) || [];
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
