/**
 * 大地图 TAB 飞回基地（热键注册表形态）
 *
 * 在世界地图（NWorldMap 场景）下按 [TAB]，让镜头飞到玩家自己的基地坐标：
 *   坐标取 core/game-api.js 的 gameData.myWorldPos()（= UserData.WorldCoord），
 *   飞行走现成的 nav.flyTo({x,y,z,click:false})（MOVE_TO：只飞 + 标记，不弹城市弹窗）。
 *
 * 打字让位 / 修饰键放行 / 场景门控 / preventDefault+stopPropagation 全部由 core/hotkeys.js 注册表统一处理，
 * 本文件只声明「绑定 + 动作」。TAB 默认会移动 DOM 焦点：坐标取不到时 handler 返回 false（不消费，
 * 让 TAB 走默认焦点移动，与改造前一致）；取到则飞行并返回 true（消费，注册表拦截默认行为）。
 */
import { createLog } from '../../core/log.js';
import { bind } from '../../core/hotkeys.js';
import { nav, worldMap, gameData } from '../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=FLY_HOME） */
const log = createLog('FLY_HOME');

bind({
    id: 'flyHome',
    keys: ['Tab'],
    display: 'Tab',
    label: '飞回基地',
    where: '大世界',
    scenes: ['NWorldMap'],
    handler: function () {
        var pos = gameData.myWorldPos();
        if (!pos) {
            log.warn('base coordinate unavailable (UserData.WorldCoord), skip TAB fly.');
            return false;   // 不消费：让 TAB 走默认焦点移动
        }
        var r = nav.flyTo({ x: pos.x, y: pos.y, z: worldMap.viewServerId() || worldMap.serverId(), click: false });
        if (r.ok) log.info('fly to base. x=%d;y=%d', pos.x, pos.y);
        else log.warn('fly to base failed. err=%s', r.err);
        return true;
    },
});
