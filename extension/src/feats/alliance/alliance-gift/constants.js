/**
 * alliance/alliance-gift · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.Receive_Alliance_Gift_Small_All（RequestId.js:408），一键领取某类联盟礼物，载荷 {type} */
export const CMD_RECEIVE_GIFT_ALL = 1177;
/** @type {number} RequestId.Receive_Alliance_Gift_Big（RequestId.js:409），领 1 箱联盟珍藏礼物，载荷 {} */
export const CMD_RECEIVE_GIFT_BIG = 1178;
/** @type {number} ResponseId.PUSH_ALLIANCE_GIFT_INFO（ResponseId.js:192），联盟礼物信息更新推送；仅作唤醒源，不读载荷 */
export const CMD_PUSH_ALLIANCE_GIFT_INFO = 10442;
