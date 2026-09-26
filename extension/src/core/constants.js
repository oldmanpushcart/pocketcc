// pocketcc 两个 world（MAIN / ISOLATED）之间 postMessage 协议的命名空间。
// 两边必须同值，否则 storage 代理静默失效；故集中一处，content.js 与 bridge.js 各自打包内联。
/** @type {string} 协议命名空间标识（消息体 __ns 字段） */
export const NS = 'pocketcc';
