/**
 * 数字字段类型 module（type:'number'，兼「未登记 type」的兜底控件）。
 *
 * T4（架构审查候选 1）：render 迁自 fields.js renderNumber，events 迁自 wire.js wireControls 的 input[type=number] 委托。
 * 兜底语义保留：buildFieldsHTML 三级查表未命中（无 type 的顶层字段）仍落本 module 渲染（决策记录 §3.2）。
 * change 钳制到 min（zeroUnlimited 时留空↔0 对称回写），存档 + 运行中热更（ctx.commit 统一管道）。
 *
 * 双轨守卫：dispatcher 内联路径仅把「顶层」数字输入归本 module（显式 type:'number' 或无 type 兜底）；
 *   rallygrid 行内延迟/上限格、itemlist 数值格等子描述符（非顶层）仍走旧绑定 / mount*（T5 迁），不被本 module 误吞。
 *
 * 依赖面 = dom.js（escAttr / PLACEHOLDER_UNLIMITED）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr, PLACEHOLDER_UNLIMITED } from '../dom.js';

/**
 * 行 HTML：label 接一枚 input[type=number]。fd.zeroUnlimited 时把「0=无限」做成与自动打野攻打数量同款的交互——
 * 值为 0 渲染成空输入 + placeholder「不限」，靠 change 委托在改值时对称回写（留空↔0）。
 * @param {number} val 配置里的字段值（本类型直接读 c[fd.key]，val 仅占位对齐 module render 签名）
 * @param {object} fd 字段描述符（label / key / min / step / placeholder / zeroUnlimited）
 * @param {object} c 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderNumber(val, fd, c, fid) {
  void val;
  if (fd.zeroUnlimited) {
    const raw = c[fd.key];
    const isZero = raw == null || Number(raw) === 0;
    return (
      `<label class="pc-row"><span>${fd.label}</span>` +
      `<input type="number" data-id="${fid}" data-key="${fd.key}" min="${fd.min}" step="${fd.step}" placeholder="${escAttr(fd.placeholder || PLACEHOLDER_UNLIMITED)}" value="${isZero ? '' : raw}" title="留空 = 不限"></label>`
    );
  }
  const v = c[fd.key];
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<input type="number" data-id="${fid}" data-key="${fd.key}" min="${fd.min}" step="${fd.step}" placeholder="${escAttr(fd.placeholder || '')}" value="${v == null ? '' : v}"></label>`
  );
}

/** 数字字段类型（inline 兜底，change 钳制 + 存档热更；interface 形状见 index.js 头注释） */
export const numberType = {
  type: 'number',
  kind: 'inline',
  render: renderNumber,
  events: [
    // 钳制到 min，存档 + 运行中热更；zeroUnlimited 留空 = 不限（0），与渲染对称
    {
      on: 'change',
      sel: 'input[type=number]',
      run(e, ctx) {
        const input = e.target;
        const fd = ctx.fd;
        const key = fd.key;
        let v = fd.float ? parseFloat(input.value) : parseInt(input.value, 10);
        if (fd.zeroUnlimited && (isNaN(v) || input.value === ''))
          v = 0; // 留空 = 不限（0），与渲染对称
        else if (isNaN(v)) v = ctx.f.defaults[key];
        v = Math.max(fd.min != null ? fd.min : 0, v);
        input.value = fd.zeroUnlimited && v === 0 ? '' : v; // 0 → 留空，placeholder「不限」
        ctx.c[key] = v;
        ctx.commit();
      },
    },
  ],
};
