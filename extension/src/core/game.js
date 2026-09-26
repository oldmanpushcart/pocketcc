// 游戏模块访问 hub：集中 MAIN world 的 __require，消除各文件重复直引。
// 保持 thin —— __require 自身就是游戏的模块缓存，这里不再二次缓存。
// 软失败语义：缺失返回 null + 一条 debug（模块名记在这里；调用方 install 的 missing 清单才是 warn 级业务结论）。
//   get        单取。直链 .X 的调用点（main/session/ui）模块保证在场，不另加 null 守卫，真缺失即崩。
//   requireAll 批量取成 {name: module|null}，供各功能 install 组 missing 清单。
// 调试面：window.pocketcc.game.get('DataCenter') 直接在控制台取游戏单例。
import { createLog } from './log.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=GAME） */
const log = createLog('GAME');

/**
 * 单取游戏模块（软失败）：__require 抛错时记 debug 并返回 null
 * @param {string} name 游戏模块名
 * @returns {object|null} 模块导出，缺失为 null
 */
function requireOne(name) {
    try {
        return __require(name);
    } catch (err) {
        log.debug('require module failed. module=%s', name, err);
        return null;
    }
}

/** 游戏模块访问入口，挂到 window.pocketcc.game（调试面可直接控制台取单例） */
export const game = {
    /** 单取模块，缺失返回 null */
    get: requireOne,
    /**
     * 批量取模块成 {name: module|null}，供各功能 install 组 missing 清单
     * @param {string[]} names 模块名列表
     * @returns {Object<string, object|null>}
     */
    requireAll: function (names) {
        var mods = {};
        for (var i = 0; i < names.length; i++) {
            mods[names[i]] = requireOne(names[i]);
        }
        return mods;
    },
};
