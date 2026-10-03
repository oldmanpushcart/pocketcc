/**
 * 关闭当前弹窗快捷键 [Q]（热键注册表形态）
 *
 * 在基地城市（Home）或大世界（NWorldMap）场景下按 [Q]，关闭当前栈顶弹窗：
 *   走 core/game-api.js 的 ui.closeTop()（游戏原生：读 UIManager.Instance().CurrentUIDataInfo，非空则 CloseUI 关掉），
 *   等价面板的 back 键 / 点遮罩关闭，只触发原生关窗，不改写游戏数据。
 *   无弹窗在场时 closeTop 返回 nothing，本功能仅记 debug 日志（与改造前一致：Q 命中即消费）。
 *
 * 打字让位 / 修饰键放行 / 场景门控 / preventDefault 由 core/hotkeys.js 注册表统一处理，本文件只声明绑定+动作。
 */
import { createLog } from '../../core/log.js';
import { bind } from '../../core/hotkeys.js';
import { ui } from '../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CLOSE_POPUP） */
const log = createLog('CLOSE_POPUP');

bind({
    id: 'closePopup',
    keys: ['KeyQ'],
    display: 'Q',
    label: '关闭当前弹窗',
    where: '基地/大世界',
    scenes: ['Home', 'NWorldMap'],
    handler: function () {
        var r = ui.closeTop();
        if (r.ok) log.info('popup closed. name=%s', r.name);
        else if (r.err === 'nothing') log.debug('no popup to close.');
        else log.warn('close popup failed. err=%s', r.err);
        return true;
    },
});
