/**
 * UID 复合行字段类型 module（type:'uid'，城市技能）。
 *
 * T5（架构审查候选 1 · Option A 全量收编）：render 迁自 fields.js renderUid，
 * 显示态↔输入态状态机迁自 widgets.js setupUidField（收进共享 uid-core.bindUidScalar，该文件 T5 退役）。
 * 行内 enableKey 勾选框（.pc-fchk）原由 wire.js wireControls 通用 checkbox 委托处理，T5 收进本 module events：
 *   dispatcher 内联路径经 findFieldOwner(f, enableKey) 路由到本 module（uid 行无 data-fkey 容器外壳）。
 * 状态机有闭包态（editing/lastBad），保留 assemble 直接绑定（决策 §3.4 / §8：不外置委托化）；save/apply 收口 ctx.commit。
 * assemble（首次装配 / 卡重建重绑）= bindUidScalar；sync（降级补载回写）= __pcUidRefresh（只回显示态，绝不重绑，避免重复监听）。
 *
 * 依赖面 = dom（escAttr）+ uid-core（bindUidScalar）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';
import { bindUidScalar } from './uid-core.js';

/**
 * UID 复合行 HTML：显示态「✎ 玩家名」点击转输入态，失焦用 PLAYER_INFO(630) 反查名字。
 * 名字随 UID 一起持久化（fd.nameKey），开面板直接显缓存名、零查询；仅 UID 变了才查。失败留框+红字不提交。
 * 签名照 module render (val, fd, c, fid)，本类型直接读 c[fd.key]/c[fd.nameKey]（val 仅占位对齐）。
 * @param {*} val 配置里的字段值（占位，不读）
 * @param {object} fd 字段描述符（label / key / nameKey / enableKey / placeholder）
 * @param {object} c 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
function renderUid(val, fd, c, fid) {
  void val;
  const uidV = String(c[fd.key] || '');
  const nmV = String(c[fd.nameKey] || '');
  return (
    `<div class="pc-uidwrap" data-id="${fid}" data-ukey="${fd.key}" data-nkey="${fd.nameKey}" data-ekey="${fd.enableKey}">` +
    `<div class="pc-row"><span>${fd.label}</span>` +
    `<button type="button" class="pc-udisp" title="点击编辑 UID" aria-label="编辑目标 UID"><span class="pc-uedit">✎</span><span class="pc-uname">${escAttr(nmV || uidV)}</span></button>` +
    `<input type="text" class="pc-uinput" inputmode="numeric" hidden placeholder="${escAttr(fd.placeholder)}">` +
    `<input type="checkbox" class="pc-fchk" data-id="${fid}" data-key="${fd.enableKey}" aria-label="启用 ${escAttr(fd.label)}" ${c[fd.enableKey] ? 'checked' : ''}>` +
    `</div><div class="pc-uhint" hidden></div></div>`
  );
}

/** UID 复合行类型（inline，enableKey 勾选 events + 状态机 assemble/sync；interface 形状见 index.js 头注释） */
export const uidType = {
  type: 'uid',
  kind: 'inline',
  render: renderUid,
  assembleSel: '.pc-uidwrap:not(.pc-uli)',
  // 首次装配 / 卡重建重绑：绑显示态↔输入态状态机（值落 configs[fid] 的 ukey/nkey 标量键）
  assemble: (box, ctx) => bindUidScalar(box, () => ctx.commit()),
  // 降级补载回写：只按最新 configs 回显示态名字/UID（输入态下不打断编辑），绝不重绑（重复绑定 = 双监听）
  sync: (box) => {
    if (box.__pcUidRefresh) box.__pcUidRefresh();
  },
  events: [
    // 行内 enableKey 勾选框：点选不触发卡片折叠（与 T4 checkbox 同口径，stopPropagation 收进 dispatcher）
    {
      on: 'click',
      sel: '.pc-fchk',
      run(e) {
        e.stopPropagation();
      },
    },
    // 勾选改动即存档 + 热更（key = enableKey，dispatcher 内联路径经 findFieldOwner 路由到本 module）
    {
      on: 'change',
      sel: '.pc-fchk',
      run(e, ctx) {
        ctx.c[e.target.dataset.key] = e.target.checked;
        ctx.commit();
      },
    },
  ],
};
