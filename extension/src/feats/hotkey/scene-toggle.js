/**
 * 基地↔大世界切换快捷键 [H]（热键注册表形态）
 *
 * 在基地城市（Home 场景）或大世界（NWorldMap 场景）下按 [H]，在两者之间切换：
 *   当前在大世界 → 回基地；当前在基地 → 进大世界。
 * 切换走 core/game-api.js 的 scene.toggleHomeWorld()（游戏原生 ProcedureManager.PROCE.Run，
 * 与主界面「世界 / 回城」按钮同一条路径），只触发场景切换、不改写游戏数据。
 *
 * 打字让位 / 修饰键放行 / 场景门控 / preventDefault 由 core/hotkeys.js 注册表统一处理，本文件只声明绑定+动作。
 */
import { createLog } from '../../core/log.js';
import { bind } from '../../core/hotkeys.js';
import { scene } from '../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SCENE_TOGGLE） */
const log = createLog('SCENE_TOGGLE');

bind({
    id: 'sceneToggle',
    keys: ['KeyH'],
    display: 'H',
    label: '基地 ↔ 大世界',
    where: '基地/大世界',
    scenes: ['Home', 'NWorldMap'],
    handler: function () {
        var r = scene.toggleHomeWorld();
        if (r.ok) log.info('toggled. now scene=%s', scene.name());
        else if (r.err === 'wrongscene') log.debug('not in home/world scene, ignore. scene=%s', r.scene);
        else log.warn('toggle home/world failed. err=%s', r.err);
        return true;
    },
});
