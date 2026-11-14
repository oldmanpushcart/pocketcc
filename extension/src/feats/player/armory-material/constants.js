/**
 * player/armory-material · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.ARMYEQUIP_NEW_MATERIAL_PRODUCE，排一条材料进生产队列 */
export const CMD_PRODUCE = 1643;
/** @type {number} RequestId.ARMYEQUIP_NEW_MATERIAL_PRODUCE_GET，收割已到期的产物 */
export const CMD_PRODUCE_GET = 1645;
