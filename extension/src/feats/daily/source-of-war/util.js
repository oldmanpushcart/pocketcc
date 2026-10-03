/**
 * 战争之源 feat 内部共享小工具（仅本目录自用，不外提到工程 utils/，口径同 mine-cave/util.js）。
 * todayStr 被攻打额度与领奖镜像共用于跨日失效；safeStringify 被两链的拒绝日志共用。
 */

/**
 * 今日日期字符串 YYYY-MM-DD（当地时区，与面板展示一致）。
 * @returns {string}
 */
export function todayStr() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 安全序列化拒绝载荷：PB 应答的 data 是对象，String() 会退化成 [object Object] 丢失拒绝原因。
 * @param {*} v ret.data
 * @returns {string}
 */
export function safeStringify(v) {
    if (v == null) return String(v);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch (err) { return String(v); }
}
