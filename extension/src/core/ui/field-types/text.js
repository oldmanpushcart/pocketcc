/**
 * 只读惰性求值文本字段类型 module（type:'text'，如卡车「今日刷新 / 今日攻击」、自动打野「今日进度」）。
 *
 * T4（架构审查候选 1）：render 迁自 fields.js renderText。值来自 fd.get(cfg)，无控件不写配置故无 events；
 * 随 panel.js refreshTexts 重算——经本 module 的 refreshText 钩子就地改文本（决策记录 §3.5：refreshTexts 查类型调钩子）。
 * 三种排版变体（inline 双列 / 多行整列 / 单行）严格继承旧 renderText 输出。
 *
 * 边界：refreshTexts 里只读格全走 module.refreshText 钩子（T5 终态）——huntlist「已打」(hlstat) / itemlist「总数量·已抢」(istock/ibought)
 *   各由所属 module 自持；ctrlrow text cell（子描述符 type='text'）走本 module 钩子，rallygrid count（子描述符无 type）走 refreshTexts 的 fd.get 兜底。
 *
 * 依赖面 = ctx（refreshText 钩子）；不反查 fields.js/wire.js。
 */

/**
 * 行 HTML：label 接一枚只读 .pc-fval（data-fid/data-fkey 供 refreshTexts 反查），值 = fd.get(c)。
 * @param {*} val 配置里的字段值（本类型不读 val，值一律来自 fd.get(c)）
 * @param {object} fd 字段描述符（label / key / get / multiline / inline）
 * @param {object} c 该功能当前配置（回传给 fd.get）
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderText(val, fd, c, fid) {
  void val;
  const v = fd.get ? String(fd.get(c)) : '';
  if (fd.multiline && fd.inline) {
    // 同行多行变体（如卡车「今日刷新 / 今日攻击」）：标签与值同一行、值靠右 pre-line 换行，顶对齐使首行与标签齐平
    return (
      `<div class="pc-row pc-rowtop"><span>${fd.label}</span>` +
      `<span class="pc-fval pc-fvalhl" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></div>`
    );
  }
  if (fd.multiline) {
    // 多行只读值（如「今日进度」一长串统计）：标签在上、值整行，pre-line 保留 \n 换行不截断
    return (
      `<div class="pc-row pc-rowcol"><span>${fd.label}</span>` +
      `<span class="pc-fval pc-fvalml" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></div>`
    );
  }
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<span class="pc-fval" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></label>`
  );
}

/** 只读惰性求值文本类型（inline，无 events，refreshText 钩子就地重算；interface 形状见 index.js 头注释） */
export const textType = {
  type: 'text',
  kind: 'inline',
  render: renderText,
  /**
   * 只读格钩子：按 fd.get(cfg) 重算当前值，就地改文本（值未变不写，避免无谓 DOM 抖动）。
   * @param {Element} el .pc-fval 只读格
   * @param {object} ctx { f, fd, c }（refreshTexts 传入的最小集）
   */
  refreshText(el, ctx) {
    const fd = ctx.fd;
    if (!fd.get) return;
    const next = String(fd.get(ctx.c) || '');
    if (el.textContent !== next) el.textContent = next;
  },
};
