/**
 * alliance/alliance-science · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.ALLIANCE_DOANTE_SCIENCE，捐赠科技（源码拼写即 DOANTE） */
export const CMD_DONATE = 1144;
/** @type {number} RequestId.WORLDSITE_DONATE，捐赠遗迹（要塞），载荷 {id,type}，无批量字段 */
export const CMD_DONATE_RELIC = 1067;
/** @type {number} ResponseId.PUSH_ENERGY(10021)，能量池变更推送；只认载荷 type∈{4,7} 两个捐赠池且只在点数回升时触发 */
export const CMD_PUSH_ENERGY = 10021;
