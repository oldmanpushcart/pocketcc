/**
 * ACL 域切片 · 原生 UI 面板开关（core/acl/ui.js）
 * 原 core/game-api.js 的 ui 区段，按域拆分片3逐字迁出（行为零变化）。
 * 只触游戏原生开窗/关窗，不改写游戏数据（只读+调用红线）。
 */
import { createLog } from '../log.js';
import { SYM, uiMgrClass, uiRegistry } from '../acl-engine.js';

/** @type {ReturnType<createLog>} 沿用拆分前 tag=GAMEAPI，日志口径零漂移 */
const log = createLog('GAMEAPI');

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
   * 关闭当前顶层弹窗（Q 键用）：读游戏原生 UIManager.Instance().CurrentUIDataInfo（最近打开、即栈顶的面板描述符），
   * 非空则调 CloseUI(描述符)（走面板自身关闭链路，等价 back 键/点遮罩）；回退 Close(name)。
   * 无弹窗在场（CurrentUIDataInfo 为空，如干净的大本营/世界地图）返回 {ok:false,err:'nothing'}。
   * @returns {{ok:boolean, err?:string, name?:string}}
   */
  closeTop() {
    var C = uiMgrClass();
    var mgr = C && typeof C.Instance === 'function' ? C.Instance() : null;
    if (!mgr || typeof mgr.CloseUI !== 'function') return { ok: false, err: 'unavailable' };
    var cur = mgr.CurrentUIDataInfo;
    if (!cur || !cur.name) return { ok: false, err: 'nothing' };
    var nm = cur.name;
    try {
      mgr.CloseUI(cur);
      return { ok: true, name: nm };
    } catch (e) {
      try {
        if (typeof mgr.Close === 'function') {
          mgr.Close(nm);
          return { ok: true, name: nm };
        }
      } catch (e2) {}
      log.warn('ui.closeTop(%s) failed: %s', nm, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
};
