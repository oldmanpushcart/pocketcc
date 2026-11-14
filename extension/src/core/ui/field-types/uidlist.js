/**
 * 好友清单字段类型 module（type:'uidlist'，玩家点赞 / 奉旨出征）。
 *
 * T5（架构审查候选 1 · Option A 全量收编）：render 迁自 fields.js uidListInnerHTML，
 * 有状态装配迁自 widgets.js mountUidList（该文件 T5 退役）。行状态机（显示↔输入、失焦反查名字）
 * 有闭包态，保留 mount* 直接绑定（决策 §3.4 / §8：不外置委托化）；save/apply 收口 ctx.commit。
 * assemble（首次装配 / 卡重建重绑）与 sync（降级补载回写）同源 mountUidList。
 *
 * 依赖面 = dom（escAttr/findFieldDescriptor）+ uid-core（setupUidListRow）+ registry（configs/findFeature）+ ctx。
 */
import { escAttr, findFieldDescriptor } from '../dom.js';
import { configs, findFeature } from '../../registry.js';
import { setupUidListRow } from './uid-core.js';

/**
 * 好友清单字段（type:'uidlist'）内层 HTML：标题行（含右上＋，达上限置 disabled）+ 若干 UID 行 + 上限 hint。
 * 每行是一个 .pc-uidwrap.pc-uli[data-idx=i]（复用城市技能 UID 控件的视觉与显示↔输入态），行尾带 × 删除；
 * 与标量 UID 行的区别：值落在 configs[fid].friends[i].{uid,name}，故行不带 data-ukey/nkey，靠 data-idx 定位。
 * 行的称呼名词由 fd.itemLabel 定制（玩家点赞缺省「好友」，奉旨出征为「执政官」）。
 * fd.itemCheck=true 时每行前置勾选框（.pc-ulichk，写回行对象 .on）：未勾行由 feat 侧自行排除，
 *   存量行无 on 视为已勾（向后兼容，缺省不改变既有行为）。
 * @param {Array<{uid:string, name:string, on?:boolean}>} list 当前好友清单
 * @param {object} fd 字段描述符（label / max / placeholder / hint / itemLabel / itemCheck 可选；itemLabel 行的称呼名词，缺省「好友」）
 * @returns {string}
 */
function uidListInnerHTML(list, fd) {
  const arr = Array.isArray(list) ? list : [];
  const max = fd.max || 10;
  const ph = escAttr(fd.placeholder || '');
  const item = escAttr(fd.itemLabel || '好友');
  const rows = arr
    .map((it, i) => {
      const uidV = String((it && it.uid) || '');
      const nmV = String((it && it.name) || '');
      const chk = fd.itemCheck
        ? `<input type="checkbox" class="pc-ulichk" data-idx="${i}" title="勾选才入池"${it && it.on === false ? '' : ' checked'}>`
        : '';
      return (
        `<div class="pc-uidwrap pc-uli" data-idx="${i}">` +
        `<div class="pc-row">${chk}<span>${item} ${i + 1}</span>` +
        `<button type="button" class="pc-udisp" title="点击编辑 UID" aria-label="编辑${item} ${i + 1} 的 UID"><span class="pc-uedit">✎</span><span class="pc-uname">${escAttr(nmV || uidV)}</span></button>` +
        `<input type="text" class="pc-uinput" inputmode="numeric" hidden placeholder="${ph}">` +
        `<button class="pc-udel" type="button" title="删除此${item}" aria-label="删除${item} ${i + 1}">×</button>` +
        `</div><div class="pc-uhint" hidden></div></div>`
      );
    })
    .join('');
  return (
    `<div class="pc-ulisttop">` +
    `<span class="pc-rngtitle">${fd.label || item + '清单'}</span>` +
    `<button class="pc-ulistadd" type="button" title="添加${item}" aria-label="添加${item}"${arr.length >= max ? ' disabled' : ''}>＋</button>` +
    `</div>` +
    (rows || `<div class="pc-rnghint">无${item}，点右上＋添加</div>`) +
    `<div class="pc-rnghint">${fd.hint || '最多 ' + max + ' 个；点＋添加，×删除'}</div>`
  );
}

/**
 * 装配好友清单容器（.pc-ulist）：为每个 UID 行绑显示态↔输入态状态机（失焦反查名字，写入 friends[idx]），
 * 并接＋/×（结构性改动 → 整块重刷 + 重绑）。bind-only：假定 buildFieldsHTML 已渲染 HTML，只绑监听。
 * @param {HTMLElement} box .pc-ulist 容器
 * @param {object} ctx 字段上下文（commit 收口 save+apply+log）
 */
function mountUidList(box, ctx) {
  const fid = box.dataset.id;
  const f = findFeature(fid);
  if (!f) return;
  const fd = findFieldDescriptor(f, box.dataset.fkey);
  if (!fd) return;
  const c = configs[fid];
  if (!Array.isArray(c[fd.key])) c[fd.key] = [];
  const arr = c[fd.key];
  const max = fd.max || 10;
  const commit = () => ctx.commit();

  const rerender = () => {
    box.innerHTML = uidListInnerHTML(arr, fd);
    mountUidList(box, ctx);
  };

  // ＋ / ×：结构性改动后整块重刷（索引会变，故重绑而非逐控件）
  // ＋新行带 on：itemCheck 字段缺省勾选=入池
  const newRow = () => (fd.itemCheck ? { uid: '', name: '', on: true } : { uid: '', name: '' });
  const add = box.querySelector('.pc-ulistadd');
  if (add)
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      if (arr.length >= max) return;
      arr.push(newRow());
      rerender();
      const rows = box.querySelectorAll('.pc-uli');
      const last = rows[rows.length - 1];
      if (last && last.__pcEnterEdit) last.__pcEnterEdit();
      commit();
    });
  box.querySelectorAll('.pc-udel').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = +btn.closest('.pc-uli').dataset.idx;
      if (i >= 0 && i < arr.length) arr.splice(i, 1);
      rerender();
      commit();
    });
  });

  // 行首勾选框（fd.itemCheck）：就地写回行对象 .on，无结构变化不重刷（勾选态由 DOM 自持）
  if (fd.itemCheck)
    box.querySelectorAll('.pc-ulichk').forEach((chk) => {
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        const i = +chk.dataset.idx;
        if (i >= 0 && i < arr.length) arr[i].on = chk.checked;
        commit();
      });
    });

  // 每行 UID 控件：走 bindUidRow 共用的状态机，只是值的落点在 friends[idx].{uid,name}
  box.querySelectorAll('.pc-uli').forEach((wrap) => setupUidListRow(wrap, arr, commit));
}

/** 好友清单类型（box 容器，有状态装配 assemble/sync 同源 mountUidList；interface 形状见 index.js 头注释） */
export const uidlistType = {
  type: 'uidlist',
  kind: 'box',
  cls: 'pc-ulist',
  render: uidListInnerHTML,
  assembleSel: '.pc-ulist',
  assemble: mountUidList,
  sync: mountUidList,
};
