// 统一控制台日志：[POCKETCC://<MODULE>] <message>，message 一律英文（UI 文案不在此列）。
// 三级 info/debug/warn 语义：info=生命周期与关键动作，debug=逐条调度，warn=异常/被拒。
// fmt 支持 printf 占位（%s/%d，透传给 console）或已拼好的模板串；额外参数原样透传。

/**
 * @typedef {object} Logger
 * @property {function(string, ...*):void} info 生命周期与关键动作
 * @property {function(string, ...*):void} debug 逐条调度细节
 * @property {function(string, ...*):void} warn 异常/被拒
 */

/**
 * 创建一个带模块标记的日志器
 * @param {string} module 模块标记（如 NET / BUS），输出为 [POCKETCC://<module>]
 * @returns {Logger} 三级日志器
 */
export function createLog(module) {
    const prefix = `[POCKETCC://${module}]`;
    return {
        info: (fmt, ...args) => console.info(`${prefix} ${fmt}`, ...args),
        debug: (fmt, ...args) => console.debug(`${prefix} ${fmt}`, ...args),
        warn: (fmt, ...args) => console.warn(`${prefix} ${fmt}`, ...args),
    };
}
