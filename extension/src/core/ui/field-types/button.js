/**
 * 动作按钮字段类型 module（type:'button'，如卡车拦截「刷新我方战力」）。
 *
 * T4（架构审查候选 1）：render 迁自 fields.js renderButton，events 迁自 wire.js wireControls 的 .pc-fbtn 委托。
 * 点击调 fd.onClick(cfg)，返回 Promise 则禁用 + 文案反馈（busyText），不写配置不触发折叠（故不调 ctx.commit）。
 * 按钮用 data-bkey（非 data-key，Q1 红线不改 DOM schema）：dispatcher 内联路径按 data-key ?? data-bkey 解析。
 * .pc-fbtn 类名为本类型独有，故 wireControls 旧 .pc-fbtn 分支整段退役（干净删旧）。
 *
 * 依赖面 = ctx；不反查 fields.js/wire.js。
 */

/**
 * 行 HTML：整行一个 .pc-btn.pc-fbtn（data-id/data-bkey 镜像旧 schema）。
 * @param {*} val 配置里的字段值（本类型不读 val，按钮无现值）
 * @param {object} fd 字段描述符（label / key）
 * @param {object} c 该功能当前配置（本类型渲染不读 c）
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderButton(val, fd, c, fid) {
  void val;
  void c;
  return `<button class="pc-btn pc-fbtn" type="button" data-id="${fid}" data-bkey="${fd.key}">${fd.label}</button>`;
}

/** 动作按钮类型（inline，click 调 onClick + busy 态反馈，不写配置；interface 形状见 index.js 头注释） */
export const buttonType = {
  type: 'button',
  kind: 'inline',
  render: renderButton,
  events: [
    // 点击调 fd.onClick(cfg)，返回 Promise 则禁用 + 文案反馈；不触发卡片折叠，不写配置（无 commit）
    {
      on: 'click',
      sel: '.pc-fbtn',
      run(e, ctx) {
        e.stopPropagation();
        const btn = e.target.closest('.pc-fbtn');
        const fd = ctx.fd;
        if (typeof fd.onClick !== 'function') return;
        const restore = () => {
          if (btn.isConnected) {
            btn.disabled = false;
            btn.textContent = fd.label;
          }
        };
        btn.disabled = true;
        btn.textContent = fd.busyText || '处理中…';
        try {
          Promise.resolve(fd.onClick(ctx.c)).then(restore, restore);
        } catch (err) {
          restore();
        }
      },
    },
  ],
};
