/**
 * 打开背包快捷键 [B]（热键注册表形态）
 *
 * 在基地城市（Home）或大世界（NWorldMap）场景下按 [B]，打开道具背包面板：
 *   走 core/game-api.js 的 ui.openBag()（游戏原生 UIManager.Instance().OpenUI(UIDataInfo.BagPanel)），
 *   与主界面背包按钮同一条开窗路径，只触发原生 UI，不改写游戏数据。
 *
 * 打字让位 / 修饰键放行 / 场景门控 / preventDefault 由 core/hotkeys.js 注册表统一处理，本文件只声明绑定+动作。
 *
 * 门控分档（可行性报告 §7.2：C 档）：背包与「在哪一种场景」无关（跨服图里照样要开背包），
 * 只按 Place 收口；战斗演出/转场/征服者球体里主界面不在场，不生效也不抢键。
 */
import { createLog } from '../../core/log.js';
import { bind } from '../../core/hotkeys.js';
import { ui } from '../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=OPEN_BAG） */
const log = createLog('OPEN_BAG');

bind({
  id: 'openBag',
  keys: ['KeyB'],
  display: 'B',
  label: '打开背包',
  where: '基地/大世界',
  scenes: ['Home', 'NWorldMap'],
  // 与 scenes 逐字等价折算（Home→base、NWorldMap→world），口径同 close-popup。
  places: ['base', 'world'],
  handler: function () {
    var r = ui.openBag();
    if (r.ok) log.info('bag opened.');
    else log.warn('open bag failed. err=%s', r.err);
    return true;
  },
});
