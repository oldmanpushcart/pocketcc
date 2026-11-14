/**
 * alliance/alliance-behemoth · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.ALLIANCE_BEHEMOTH_DONATE，等级捐献（type LEVEL） */
export const CMD_DONATE = 7102;
/** @type {number} ResponseId.PUSH_ENERGY(10021)，能量池变更推送；只认载荷 type=13 且只在点数回升时触发 */
export const CMD_PUSH_ENERGY = 10021;
