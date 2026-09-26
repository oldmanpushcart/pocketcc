import { createLog } from './log.js';

// 全局唯一事件总线（不建第二个游戏消息总线——net 仍是游戏报文的唯一出入口，bus 只承载内部事件）。
// 事件类：net.<cmd>（游戏推送）、session.*、scene.*、mode.*、tick.*（后四者由后续步骤接入）。
// emit 恒同步：net 事件的 raw 是池化复用对象，延迟派发会读到脏数据；
//   需要延迟的只有 reactor 合成的 tick 载荷 {}，那由 scheduler 负责，不进 bus。
/** @type {ReturnType<createLog>} 模块日志器（tag=BUS） */
const log = createLog('BUS');

/** @type {Map<string, Set<Function>>} type -> Set<handler> */
const map = new Map();

/**
 * 订阅事件
 * @param {string} type 事件名
 * @param {Function} handler 回调（同 type 同引用只登记一次，Set 天然去重）
 * @returns {Function} unsubscribe；入参非法时为空操作函数
 */
function on(type, handler) {
    if (typeof type !== 'string' || typeof handler !== 'function') return () => {};
    let set = map.get(type);
    if (!set) map.set(type, set = new Set());
    set.add(handler);
    return () => off(type, handler);
}

/**
 * 退订事件
 * @param {string} type 事件名
 * @param {Function} [handler] 省略则删除该 type 下的全部订阅
 */
function off(type, handler) {
    const set = map.get(type);
    if (!set) return;
    if (handler === undefined) { map.delete(type); return; }
    set.delete(handler);
    if (!set.size) map.delete(type);
}

/**
 * 同步派发事件（快照迭代，handler 内部 on/off 不影响本轮），单个 handler 抛错只记 warn 不中断其余
 * @param {string} type 事件名
 * @param {*} payload 载荷
 */
function emit(type, payload) {
    const set = map.get(type);
    if (!set || !set.size) return;
    // 快照迭代：handler 内部 on/off（如 pause 时退订）不影响本轮派发
    for (const h of [...set]) {
        try { h(payload); } catch (err) { log.warn('handler for %s threw', type, err); }
    }
}

/**
 * 该 type 是否有订阅（net 据此懒构造 Event，无人订阅就不解析载荷）
 * @param {string} type 事件名
 * @returns {boolean}
 */
function has(type) {
    const set = map.get(type);
    return !!(set && set.size);
}

/** 全局唯一内部事件总线，挂到 window.pocketcc.bus */
export const bus = { on, off, emit, has };
