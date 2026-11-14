/**
 * player/potion-craft · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.getStrengthenMakingData，制药队列唯一权威读（恒含 {making, unlock}） */
export const CMD_INFO = 1387;
/** @type {number} RequestId.MAKE_FORMULA，排一条配方进制药队列（载荷 {id}） */
export const CMD_MAKE = 1388;
/** @type {number} RequestId.ProductionReward，领取已完成的产物（载荷 {type}，制药 lane 恒 1） */
export const CMD_CLAIM = 1397;
/** @type {number} push FORMULA_MAKE_COMPLETE（只当唤醒提示，不解析载荷入状态） */
export const PUSH_MAKE = 10722;
