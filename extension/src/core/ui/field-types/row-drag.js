/**
 * 整行 pointer 拖拽换位共享核（T5，架构审查候选 1 · Option A 全量收编）。
 *
 * sortlist（领取优先级）与 itemlist（物品清单）两条面板清单同源共用，逻辑一字不差。迁自 widgets.js（T5 退役）。
 * 拖拽中就地移动真实行节点、只刷序号（不整块重刷，保住被拖行的节点）；move/up 监听挂 window
 *   （指针移出面板/落到游戏画布仍持续送达）；期间置 `box.__pcRowDrag` 让面板重刷跳过（防 ui.refresh 摧毁被拖行）；
 *   松手且真移动过才把 DOM 顺序交给 commit，由调用方回写状态 → 重刷 + 重绑 → 持久化热更。
 *
 * 依赖面 = 纯 DOM + window（无 import）；commit 由调用方传入（收口 ctx.commit）。不反查 fields.js/wire.js。
 */

/** @type {string} 拖拽中被拖走的行上的视觉类（panel-css：半透明，提示「这行正跟着指针走」） */
const DRAG_ROW_CLS = 'pc-sdragging';
/** @type {string} 拖拽中行容器上的视觉类（panel-css：整块变 grabbing 光标） */
const DRAG_WRAP_CLS = 'pc-sgrabbing';
/** @type {number} 起拖位移阈值（像素）：小于它算点选，不触发起拖 */
const DRAG_START_PX = 4;

/**
 * 整行 pointer 拖拽换位的共用装配（sortlist 与 itemlist 两条面板清单同源，逻辑一字不差）。
 * `opt.handleSel` 非空时只有落点命中该选择器才起拖——itemlist 行内有数字输入框，整行起拖会抢输入与选字。
 * @param {object} opt 配置
 * @param {HTMLElement} opt.box 清单容器（拖拽标志宿主）
 * @param {string} opt.rowSel 行选择器（相对 box，如 '.pc-srows .pc-srow'）
 * @param {string} opt.wrapSel 行包装选择器（相对 box，如 '.pc-srows'）
 * @param {string} opt.rankSel 行内序号节点选择器（如 '.pc-srank' / '.pc-irank'）
 * @param {function(HTMLElement[]):void} opt.commit 松手后按 DOM 顺序回写（只在真移动过时调用，入参为当前行节点数组）
 * @param {string[]} [opt.skipCls] 落点带这些 class 即不起拖（勾选框等）
 * @param {string} [opt.handleSel] 拖拽手柄选择器（缺省 = 整行可拖）
 * @returns {function():void} 给当前行节点挂 pointerdown（每次整块重刷后需再调一次）
 */
export function attachRowDrag(opt) {
  const box = opt.box;
  const rowEls = () => Array.prototype.slice.call(box.querySelectorAll(opt.rowSel));
  // 拖拽中就地更新序号（不整块重刷，保住被拖的行节点）
  const refreshRanks = () => {
    rowEls().forEach((r, i) => {
      const rk = r.querySelector(opt.rankSel);
      if (rk) rk.textContent = String(i + 1);
    });
  };
  const onRowDown = (e) => {
    const row = e.currentTarget;
    const tgt = e.target;
    if (opt.handleSel && !(tgt && tgt.closest && tgt.closest(opt.handleSel))) return;
    const cls = (tgt && tgt.classList) || null;
    if (cls && opt.skipCls && opt.skipCls.some((c) => cls.contains(c))) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const wrap = box.querySelector(opt.wrapSel);
    if (!wrap) return;
    e.preventDefault();
    box.__pcRowDrag = true;
    const pid = e.pointerId,
      startY = e.clientY;
    let moved = false;
    try {
      row.setPointerCapture(pid);
    } catch (err) {
      /* 不支持则靠 window 冒泡兜底 */
    }
    const onMove = (ev) => {
      if (!moved) {
        if (Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
        moved = true;
        row.classList.add(DRAG_ROW_CLS);
        wrap.classList.add(DRAG_WRAP_CLS);
      }
      ev.preventDefault();
      const others = rowEls().filter((r) => r !== row);
      let placed = false;
      for (const r of others) {
        const rect = r.getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          wrap.insertBefore(row, r);
          placed = true;
          break;
        }
      }
      if (!placed) wrap.appendChild(row);
      refreshRanks();
    };
    const onUp = () => {
      try {
        row.releasePointerCapture(pid);
      } catch (err) {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      row.classList.remove(DRAG_ROW_CLS);
      wrap.classList.remove(DRAG_WRAP_CLS);
      box.__pcRowDrag = false; // 先放标志：commit 里的整块重刷要能正常走完
      if (moved) opt.commit(rowEls());
    };
    // 监听挂 window：即使指针移出面板/落到游戏画布，move/up 仍持续送达（比只挂 row 稳）
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  return function bindDrag() {
    box
      .querySelectorAll(opt.rowSel)
      .forEach((row) => row.addEventListener('pointerdown', onRowDown));
  };
}

/**
 * 行序上移/下移按钮的共用装配（2.5.7：拖拽之外的单指针/键盘等价替代）。
 * 与 attachRowDrag 同走 `commit(当前 DOM 序行数组)` 收口：点 ↑/↓ 就地换行位置后把新 DOM 序交给调用方回写（重刷 + 存档）。
 * 按钮是原生 button，Enter/Space 天然可触发；首行↑/末行↓由调用方在渲染时置 disabled（边界无需移动）。
 * @param {object} opt 配置
 * @param {HTMLElement} opt.box 清单容器
 * @param {string} opt.rowSel 行选择器（相对 box）
 * @param {string} opt.wrapSel 行包装选择器（相对 box）
 * @param {string} opt.upSel 上移按钮选择器（相对行）
 * @param {string} opt.downSel 下移按钮选择器（相对行）
 * @param {function(HTMLElement[]):void} opt.commit 按新 DOM 序回写（入参为当前行节点数组）
 * @returns {function():void} 给当前行的 ↑/↓ 按钮挂 click（每次整块重刷后需再调一次）
 */
export function attachRowMove(opt) {
  const box = opt.box;
  const rowEls = () => Array.prototype.slice.call(box.querySelectorAll(opt.rowSel));
  const move = (row, dir) => {
    const wrap = box.querySelector(opt.wrapSel);
    if (!wrap || !row) return;
    if (dir < 0) {
      const p = row.previousElementSibling;
      if (!p) return;
      wrap.insertBefore(row, p);
    } else {
      const n = row.nextElementSibling;
      if (!n) return;
      wrap.insertBefore(n, row);
    }
    opt.commit(rowEls());
  };
  return function bindMove() {
    box.querySelectorAll(opt.rowSel).forEach((row) => {
      const up = row.querySelector(opt.upSel);
      const down = row.querySelector(opt.downSel);
      if (up) up.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        move(row, -1);
      });
      if (down)
        down.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          move(row, 1);
        });
    });
  };
}
