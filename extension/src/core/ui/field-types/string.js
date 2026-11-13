/**
 * 可编辑文本字段类型 module（type:'string'，如城市技能目标 UID）。
 *
 * T4（架构审查候选 1）：render 迁自 fields.js renderString，events 迁自 wire.js wireControls 的 input.pc-fstr 委托。
 * 按字符串存档，change 时 trim 落盘 + 热更（ctx.commit 统一管道）；click 仅 stopPropagation（不触发卡片折叠）。
 * .pc-fstr 类名为本类型独有（无其它渲染器复用），故 wireControls 旧 input.pc-fstr 分支整段退役（干净删旧）。
 *
 * 依赖面 = dom.js（escAttr）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 行 HTML：label 接一枚 input.pc-fstr（type=text），现值 = c[fd.key]。
 * @param {string} val 配置里的字段值（本类型直接读 c[fd.key]，val 仅占位对齐 module render 签名）
 * @param {object} fd 字段描述符（label / key / placeholder）
 * @param {object} c 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderString(val, fd, c, fid) {
  void val;
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<input type="text" class="pc-fstr" data-id="${fid}" data-key="${fd.key}" placeholder="${escAttr(fd.placeholder)}" value="${escAttr(c[fd.key])}"></label>`
  );
}

/** 可编辑文本类型（inline，click 止折叠 + change trim 存档热更；interface 形状见 index.js 头注释） */
export const stringType = {
  type: 'string',
  kind: 'inline',
  render: renderString,
  events: [
    // 点输入框不触发卡片折叠（沿用旧逐元素 click 监听口径）
    {
      on: 'click',
      sel: '.pc-fstr',
      run(e) {
        e.stopPropagation();
      },
    },
    // 改动 trim 后按字符串存档 + 热更
    {
      on: 'change',
      sel: '.pc-fstr',
      run(e, ctx) {
        const input = e.target;
        const v = input.value.trim();
        input.value = v;
        ctx.c[ctx.fd.key] = v;
        ctx.commit();
      },
    },
  ],
};
