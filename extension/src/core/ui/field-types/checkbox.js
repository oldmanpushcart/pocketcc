/**
 * 开关行字段类型 module（type:'checkbox'，如按集结目标单独开关）。
 *
 * T4（架构审查候选 1）：render 迁自 fields.js renderCheckbox，events 迁自 wire.js wireControls 的 input.pc-fchk 委托。
 * 改动即存档 + 热更（ctx.commit 统一管道）；click 仅 stopPropagation（不触发卡片折叠，沿用旧逐元素绑定口径）。
 * 内联型（kind:'inline'）：无 fieldBox 外壳，dispatcher 走内联路径（e.target[data-id][data-key]）按 fd.type 分发。
 *
 * 双轨守卫：wireControls 仅对「顶层且 type 已注册」的 .pc-fchk 跳过旧绑定；uid 复合行 / rallygrid 行内的
 *   enableKey 勾选框（data-key 反查不到顶层 descriptor）仍走旧绑定（T5 迁），故本 module 只接 type:'checkbox' 字段。
 *
 * 依赖面 = ctx（dispatcher 传入）；不反查 fields.js/wire.js。
 */

/**
 * 行 HTML：label 接一枚 .pc-fchk（data-id/data-key 镜像旧 schema），现值 = c[fd.key]。
 * @param {boolean} val 配置里的字段值（本类型直接读 c[fd.key]，val 仅占位对齐 module render 签名）
 * @param {object} fd 字段描述符（label / key）
 * @param {object} c 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderCheckbox(val, fd, c, fid) {
  void val;
  return (
    `<label class="pc-row"><span>${fd.label}</span>` +
    `<input type="checkbox" class="pc-fchk" data-id="${fid}" data-key="${fd.key}" ${c[fd.key] ? 'checked' : ''}></label>`
  );
}

/** 开关行类型（inline，click 止折叠 + change 写勾选态；interface 形状见 index.js 头注释） */
export const checkboxType = {
  type: 'checkbox',
  kind: 'inline',
  render: renderCheckbox,
  events: [
    // 点输入框不触发卡片折叠（沿用旧逐元素 click 监听口径）
    {
      on: 'click',
      sel: '.pc-fchk',
      run(e) {
        e.stopPropagation();
      },
    },
    // 改动即存档 + 热更：勾选态落 configs[fid][fd.key]，commit 统一管道（save+apply+debug 日志）
    {
      on: 'change',
      sel: '.pc-fchk',
      run(e, ctx) {
        const cb = e.target;
        ctx.c[ctx.fd.key] = cb.checked;
        ctx.commit();
      },
    },
  ],
};
