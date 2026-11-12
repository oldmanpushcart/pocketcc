/**
 * ACL 域切片 · 原生 UI 面板开关（core/acl/ui.js）
 * 原 core/game-api.js 的 ui 区段，按域拆分片3逐字迁出（行为零变化）。
 * 只触游戏原生开窗/关窗，不改写游戏数据（只读+调用红线）。
 */
import { createLog } from '../log.js';
import { SYM, uiMgrClass, uiRegistry } from '../acl-engine.js';

/** @type {ReturnType<createLog>} 沿用拆分前 tag=GAMEAPI，日志口径零漂移 */
const log = createLog('GAMEAPI');

/**
 * 触发面板"回退"：在面板脚本组件上调用 close()（+ closeBtnClick()），
 * 等价于用户点击游戏内 `<` 回退按钮。
 * 实证：UIManager 层面的 CloseUI / LastCloseUI 只修改 DataPool 状态，
 *   不会触发某些复合面板（如邮件）的内部视图切换；只有组件自身的 close 才能走完整回退链。
 * @param {*} mgr UIManager 实例
 * @param {string} name 面板节点名（DataPool key）
 * @returns {boolean} 是否成功触发
 */
function backPanel(mgr, name) {
  if (!mgr || !name) return false;
  var node = mgr.DataPool && mgr.DataPool[name];
  if (!node) return false;
  var comps = node._components || node.components;
  if (!comps) return false;
  for (var i = 0; i < comps.length; i++) {
    var comp = comps[i];
    if (comp && typeof comp.close === 'function') {
      try {
        comp.close();
        if (typeof comp.closeBtnClick === 'function') comp.closeBtnClick();
        return true;
      } catch (e) {
        log.debug('backPanel comp.close(%s) failed: %s', name, e && e.message);
        return false;
      }
    }
  }
  return false;
}

export const ui = {
  /**
   * 按语义面板名打开面板（semantic 经 SYM.uiPanels 映射到 UIDataInfo 注册表成员名）。
   * @param {string} semantic 语义名（如 'bag'）
   * @param {...*} args 传给游戏 OpenUI 的后续参数（如背包分页 index、目标道具）
   * @returns {{ok:boolean, err?:string}}
   */
  open(semantic) {
    var reg = uiRegistry();
    var member = reg && SYM.uiPanels[semantic];
    var info = member && reg[member];
    if (!info) return { ok: false, err: 'unavailable' };
    var C = uiMgrClass();
    var mgr = C && typeof C.Instance === 'function' ? C.Instance() : null;
    if (!mgr || typeof mgr.OpenUI !== 'function') return { ok: false, err: 'unavailable' };
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      mgr.OpenUI.apply(mgr, [info].concat(args));
      return { ok: true };
    } catch (e) {
      log.warn('ui.open(%s) failed: %s', semantic, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
  /** 打开道具背包（B 键用） */
  openBag() {
    return this.open('bag');
  },
  /**
   * 按语义面板名关闭指定面板（与面板自身关闭链路同源：BaseUI.close → UIManager.Instance().CloseUI(描述符)）。
   * **先验在场再调 CloseUI**：实证 UIManagerImpl.CloseUI 对不在场面板仍会 `EVENT.emit(CLOSEUI)` 并走 LastCloseUI
   *   （无条件 `delete LoadingPanel[name]`、改写 CurrentUIDataInfo）——空手调用有副作用，所以在场外直接返回。
   * 在场判据含「正在异步加载」：dealOpenUI 同步置 `LoadingPanel[name]=!0` 后才 load 预制体，加载回调只在
   *   `LoadingPanel[name]` 仍为真时才 ShowUI → 此时 CloseUI（LastCloseUI 删标记）等于把还没露脸的窗口收掉。
   * @param {string} semantic 语义名（SYM.uiPanels 键，如 'bag' / 'pabFeedPopup'）
   * @returns {{ok:boolean, err?:string, name?:string}} err: unavailable=符号漂移/缺方法，not_open=不在场，failed=游戏侧抛错
   */
  close(semantic) {
    var reg = uiRegistry();
    var member = reg && SYM.uiPanels[semantic];
    var info = member && reg[member];
    if (!info || !info.name) return { ok: false, err: 'unavailable' };
    var C = uiMgrClass();
    var mgr = C && typeof C.Instance === 'function' ? C.Instance() : null;
    if (!mgr || (typeof mgr.CloseUI !== 'function' && typeof mgr.Close !== 'function'))
      return { ok: false, err: 'unavailable' };
    var pool = mgr.DataPool;
    var loading = mgr.LoadingPanel;
    if ((!pool || pool[info.name] == null) && (!loading || !loading[info.name]))
      return { ok: false, err: 'not_open', name: info.name };
    try {
      if (typeof mgr.CloseUI === 'function') mgr.CloseUI(info);
      else mgr.Close(info.name);
      return { ok: true, name: info.name };
    } catch (e) {
      try {
        if (typeof mgr.Close === 'function') {
          mgr.Close(info.name);
          return { ok: true, name: info.name };
        }
      } catch (e2) {}
      log.warn('ui.close(%s) failed: %s', semantic, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
  /**
   * 关闭当前顶层弹窗或回退（Esc 键用）。
   *
   * 第一层：读 CurrentUIDataInfo → CloseUI（等价于点 X 关闭弹窗）。
   *   若 CloseUI 后面板仍在 DataPool（回退型全屏面板），触发其组件 close()。
   * 第二层：CurrentUIDataInfo 为 null（游标已清空但容器面板仍在场），
   *   从 DataPool 取视觉栈顶面板并触发其组件 close()（等价于游戏内 `<` 回退）。
   *
   * @returns {{ok:boolean, err?:string, name?:string}}
   */
  closeTop() {
    var C = uiMgrClass();
    var mgr = C && typeof C.Instance === 'function' ? C.Instance() : null;
    if (!mgr) return { ok: false, err: 'unavailable' };
    var canCloseUI = typeof mgr.CloseUI === 'function';
    var canClose = typeof mgr.Close === 'function';
    if (!canCloseUI && !canClose) return { ok: false, err: 'unavailable' };

    // 主路径：CurrentUIDataInfo 指向栈顶
    var cur = mgr.CurrentUIDataInfo;
    if (cur && cur.name) {
      var nm = cur.name;
      try {
        if (canCloseUI) mgr.CloseUI(cur);
        else mgr.Close(nm);
        // CloseUI 后检查面板是否仍在场（回退型面板不响应 CloseUI，走组件 close）
        if (mgr.DataPool && mgr.DataPool[nm] && mgr.DataPool[nm].active !== false) {
          if (backPanel(mgr, nm)) return { ok: true, name: nm };
        }
        return { ok: true, name: nm };
      } catch (e) {
        try {
          if (canClose) { mgr.Close(nm); return { ok: true, name: nm }; }
        } catch (e2) {}
        log.warn('ui.closeTop(%s) failed: %s', nm, e && e.message);
        return { ok: false, err: 'failed' };
      }
    }

    // 兜底路径：CurrentUIDataInfo 为 null 但 DataPool 仍有在场面板
    //   典型场景：关闭子弹窗后游标清空，但父容器面板仍在场，需要回退
    //   策略：按渲染层序（同父下 siblingIndex 越大 = 越上层）找视觉栈顶，
    //   然后调用其脚本组件的 close()（等价于游戏内 `<` 回退按钮）
    var pool = mgr.DataPool;
    if (!pool) return { ok: false, err: 'nothing' };
    var keys = Object.keys(pool);
    if (!keys.length) return { ok: false, err: 'nothing' };
    // 找 active 面板中 siblingIndex 最大的（视觉栈顶）
    var topName = null;
    var topIdx = -1;
    for (var ki = 0; ki < keys.length; ki++) {
      var name = keys[ki];
      var node = pool[name];
      if (!node || node.active === false) continue;
      var idx = typeof node.getSiblingIndex === 'function' ? node.getSiblingIndex() : ki;
      if (idx > topIdx) { topIdx = idx; topName = name; }
    }
    if (topName && backPanel(mgr, topName)) return { ok: true, name: topName };
    return { ok: false, err: 'nothing' };
  },
};
