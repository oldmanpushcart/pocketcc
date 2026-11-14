/**
 * 领取优先级清单字段类型 module（type:'sortlist'，遗迹奖励 / 卡车目标）。
 *
 * T5（架构审查候选 1 · Option A 全量收编）：render 迁自 fields.js sortListInnerHTML（连同 sortListLabel helper），
 * 有状态装配迁自 widgets.js mountSortList（该文件 T5 退役）。整行 pointer 拖拽走共享 row-drag.attachRowDrag。
 * 拖拽/勾选有闭包态与 window 监听，保留 mount* 直接绑定（决策 §3.4 / §8）；save/apply 收口 ctx.commit。
 * assemble（首次装配 / 卡重建重绑）与 sync（降级补载回写）同源 mountSortList（入口即整块重刷 + 重绑）。
 *
 * 依赖面 = dom（escAttr/findFieldDescriptor）+ row-drag（attachRowDrag）+ registry（configs/findFeature）+ ctx。
 */
import { escAttr, findFieldDescriptor } from '../dom.js';
import { configs, findFeature } from '../../registry.js';
import { attachRowDrag, attachRowMove } from './row-drag.js';

/**
 * 领取优先级清单行标签：若 fd.resolve(el) 可用则解析为道具名×数量串（与面板同源）；
 * 否则直接将元素本身作为标签（池元素为道具名/itemId 时即原样显示）。
 * @param {object} fd 字段描述符（可带 resolve(el)=>[{name,id,count}]）
 * @param {string|number} id 池元素（道具名字符串，或道具 itemId）
 * @returns {string}
 */
function sortListLabel(fd, id) {
  try {
    if (fd && typeof fd.resolve === 'function') {
      const items = fd.resolve(id);
      if (Array.isArray(items) && items.length) {
        return items
          .map(
            (it) => (it && (it.name || '#' + it.id)) + (it && it.count > 1 ? ' ×' + it.count : ''),
          )
          .join('、');
      }
    }
  } catch (e) {
    /* 符号缺失/解析异常 → 回退原值 */
  }
  return String(id);
}

/**
 * 领取优先级清单字段（type:'sortlist'）内层 HTML：标题行 + 若干 `[拖拽手柄 序号 名称]` 行 + hint。
 * 行不可增删（整池全员参与），只能整行拖拽换位，序数组下标即优先级（越靠上越优先）。
 * @param {Array<string|number>} list 当前顺序（道具名或奖励配置 id 数组）
 * @param {object} fd 字段描述符（label / hint / resolve 可选）
 * @param {Array<string|number>} [offArr] checkable 时的不参与集（fd.offKey）
 * @returns {string}
 */
function sortListInnerHTML(list, fd, offArr) {
  const arr = Array.isArray(list) ? list : [];
  const checkable = !!(fd && fd.checkable);
  const offSet = new Set(checkable && Array.isArray(offArr) ? offArr.map(String) : []);
  const total = arr.length;
  const rows = arr
    .map((id, i) => {
      const label = sortListLabel(fd, id);
      const isOff = checkable && offSet.has(String(id));
      const chk = checkable
        ? `<input type="checkbox" class="pc-scheck" data-sc="${escAttr(String(id))}" aria-label="启用「${escAttr(label)}」参与领取"${isOff ? '' : ' checked'}>`
        : '';
      // ↑↓ 按钮：拖拽之外的单指针/键盘等价替代（2.5.7）；首行无上、末行无下（边界置 disabled）
      const mv =
        `<span class="pc-rmvgrp">` +
        `<button type="button" class="pc-rmv pc-rmv-up" aria-label="上移「${escAttr(label)}」"${i === 0 ? ' disabled' : ''}>↑</button>` +
        `<button type="button" class="pc-rmv pc-rmv-down" aria-label="下移「${escAttr(label)}」"${i === total - 1 ? ' disabled' : ''}>↓</button>` +
        `</span>`;
      return (
        `<div class="pc-srow${isOff ? ' pc-srowoff' : ''}" data-skey="${escAttr(String(id))}">` +
        `<span class="pc-shandle" title="按住拖拽调整顺序">⣿</span>` +
        chk +
        `<span class="pc-srank">${i + 1}</span>` +
        `<span class="pc-sname" title="${escAttr(label)}">${escAttr(label)}</span>` +
        mv +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-slisttop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '领取优先级')}</span>` +
    `<span class="pc-rnghint">拖动或按 ↑↓ 调整顺序</span>` +
    `</div>` +
    `<div class="pc-srows">` +
    (rows || '<div class="pc-rnghint">礼品池为空</div>') +
    `</div>` +
    `<div class="pc-rnghint">${escAttr(fd.hint || '拖动或按 ↑↓ 调整顺序，顺序靠前优先领取')}</div>`
  );
}

/**
 * 装配领取优先级清单容器（.pc-slist）：整行 pointer 拖拽交换 order 位（另有 ↑/↓ 按钮作单指针/键盘等价替代）。
 * 拖拽与松手收尾的机制见 attachRowDrag；松手按 DOM 顺序回写 arr（数字 id 回写原类型，不统一转字符串）。
 * @param {HTMLElement} box .pc-slist 容器
 * @param {object} ctx 字段上下文（commit 收口 save+apply+log）
 */
function mountSortList(box, ctx) {
  const fid = box.dataset.id;
  const f = findFeature(fid);
  if (!f) return;
  const fd = findFieldDescriptor(f, box.dataset.fkey);
  if (!fd) return;
  if (box.__pcRowDrag) return; // 拖拽进行中：跳过重刷，避免 ui.refresh 摧毁被拖行
  const c = configs[fid];
  const commit = () => ctx.commit();
  // 缺失/脏数据时退回 defaults 副本（旧存档把该键存成非数组时的自愈；不带 fd.all 的清单
  //   如遗迹奖励/卡车目标会因此整块空白且无从自助恢复）。必须 .slice()：registry 只在键
  //   缺失时克隆 defaults，此处键存在但形状脏，直接取 f.defaults[key] 会把共享引用交给下面
  //   fd.all 的 arr.push()，反过来写穿 defaults。
  if (!Array.isArray(c[fd.key])) {
    c[fd.key] = Array.isArray(f.defaults[fd.key]) ? f.defaults[fd.key].slice() : [];
  }
  const arr = c[fd.key];
  // 可选迁移 fd.migrate(arr, cfg) → number[]：把历史 order 收敛到当前口径（如科技同类归并 specId→族代表 id）。
  //   放在 all 追加之前：先收敛旧项、再补新增项。就地改 arr（=c[fd.key] 同一引用），发生变化才落盘热更；
  //   幂等（迁移后的值再迁移不变），故只在真正需要收敛的那一次写盘。未声明则保持原样（向后兼容）。
  if (typeof fd.migrate === 'function') {
    const before = arr.join(',');
    const migrated = fd.migrate(arr, c);
    if (Array.isArray(migrated)) {
      arr.length = 0;
      for (let mi = 0; mi < migrated.length; mi++) arr.push(migrated[mi]);
    }
    if (arr.join(',') !== before) {
      commit();
    }
  }
  // 可选全量源 fd.all（数组或 fn(cfg)）：把全量里当前 order 数组缺失的项追加到末尾——
  //   解决「功能新增了可排序项、但老用户存档的 order 不含它 → 面板这一行不显示」。
  //   未声明 fd.all 的 sortlist（遗迹奖励/卡车）保持原样，向后兼容。
  if (fd.all != null) {
    const full = typeof fd.all === 'function' ? fd.all(c) : fd.all;
    if (Array.isArray(full)) {
      for (let ai = 0; ai < full.length; ai++) {
        if (arr.indexOf(full[ai]) < 0) arr.push(full[ai]);
      }
    }
  }
  if (fd.checkable && !Array.isArray(c[fd.offKey])) {
    c[fd.offKey] = Array.isArray(f.defaults[fd.offKey]) ? f.defaults[fd.offKey].slice() : [];
  }
  const offArr = () => (fd.checkable ? c[fd.offKey] : undefined);
  const valByStr = new Map();
  arr.forEach((v) => valByStr.set(String(v), v));

  // 松手收尾：按当前 DOM 顺序回写 arr → 重刷 + 重绑 → 持久化热更（configure 即重建优先级 Map，下一轮生效）
  const commitFromDom = (els) => {
    const order = els.map((r) => {
      const k = r.dataset.skey;
      return valByStr.has(k) ? valByStr.get(k) : isFinite(+k) ? +k : k;
    });
    arr.length = 0;
    order.forEach((v) => arr.push(v));
    box.innerHTML = sortListInnerHTML(arr, fd, offArr());
    bind();
    commit();
  };
  const bindDrag = attachRowDrag({
    box: box,
    rowSel: '.pc-srows .pc-srow',
    wrapSel: '.pc-srows',
    rankSel: '.pc-srank',
    skipCls: ['pc-scheck', 'pc-rmv'], // 勾选框/上移下移按钮点击不触发起拖
    commit: commitFromDom,
  });
  const bindMove = attachRowMove({
    box: box,
    rowSel: '.pc-srows .pc-srow',
    wrapSel: '.pc-srows',
    upSel: '.pc-rmv-up',
    downSel: '.pc-rmv-down',
    commit: commitFromDom,
  });

  const bind = () => {
    bindDrag();
    bindMove();
    // checkable 行首勾选框：切换该物品是否参与匹配（off 集按 itemId 存，与拖拽 order 解耦），改动即重刷 + 存档 + 热更
    if (fd.checkable) {
      box.querySelectorAll('.pc-srows .pc-scheck').forEach((chk) => {
        chk.addEventListener('click', (e) => e.stopPropagation());
        chk.addEventListener('change', () => {
          const idStr = chk.dataset.sc;
          const off = c[fd.offKey];
          const at = off.map(String).indexOf(idStr);
          if (chk.checked) {
            if (at !== -1) off.splice(at, 1);
          } else if (at === -1) {
            off.push(isFinite(+idStr) ? +idStr : idStr);
          }
          box.innerHTML = sortListInnerHTML(arr, fd, off);
          bind();
          commit();
        });
      });
    }
  };

  box.innerHTML = sortListInnerHTML(arr, fd, offArr());
  bind();
}

/** 领取优先级清单类型（box 容器，有状态装配 assemble/sync 同源 mountSortList；interface 形状见 index.js 头注释） */
export const sortlistType = {
  type: 'sortlist',
  kind: 'box',
  cls: 'pc-slist',
  render: (val, fd, c) => sortListInnerHTML(val, fd, fd.checkable ? c[fd.offKey] : undefined),
  assembleSel: '.pc-slist',
  assemble: mountSortList,
  sync: mountSortList,
};
