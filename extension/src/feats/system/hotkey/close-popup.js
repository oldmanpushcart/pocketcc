/**
 * 关闭当前弹窗快捷键 [Esc]（热键注册表形态）
 *
 * 在基地城市（Home）或大世界（NWorldMap）场景下按 [Esc]，关闭当前栈顶弹窗或回退：
 *   走 core/acl/ui.js 的 ui.closeTop()：CurrentUIDataInfo 非空则 CloseUI（等价面板 X），
 *   游标已空但容器面板仍在场时按渲染层序取视觉栈顶调其组件 close()（等价游戏内 `<` 回退），
 *   只触发原生关窗/回退，不改写游戏数据。
 *   无弹窗在场时 closeTop 返回 nothing，本功能仅记 debug 日志并返回 false（不消费，透传）。
 *
 * 打字让位 / 修饰键放行 / 场景门控 / preventDefault 由 core/hotkeys.js 注册表统一处理，本文件只声明绑定+动作。
 *
 * 门控分档（可行性报告 §7.2：C 档）：关弹窗与「在哪一种场景」无关（跨服图里照样有弹窗要关），
 * 只按 Place 收口——基地/别人基地/大地图可用；战斗演出、转场、征服者球体里弹窗体系不在场，不生效也不抢键。
 */
import { createLog } from '../../../core/log.js';
import { bind } from '../../../core/hotkeys.js';
import { ui } from '../../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CLOSE_POPUP） */
const log = createLog('CLOSE_POPUP');

bind({
  id: 'closePopup',
  keys: ['Escape'],
  display: 'Esc',
  label: '关闭弹窗/回退',
  where: '基地/大世界',
  scenes: ['Home', 'NWorldMap'],
  // 与 scenes 逐字等价折算（Home→base、NWorldMap→world）；scenes 仍是 hotkeys.bindingAllow 的必要条件，
  //   若给 places 多给 base_other（HomeOther 不在 scenes 里）会变成永不生效的死声明。
  places: ['base', 'world'],
  handler: function () {
    var r = ui.closeTop();
    if (!r.ok) {
      if (r.err === 'nothing') log.debug('no popup to close.');
      else log.warn('close popup failed. err=%s', r.err);
      return false;
    }
    log.info('popup closed. name=%s', r.name);
    return true;
  },
});
