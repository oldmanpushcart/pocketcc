/**
 * alliance/alliance-rally · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} ResponseId.PUSH_ALLIANCE_Assembly_Created，联盟集结创建推送 */
export const CMD_PUSH_ASSEMBLY_CREATED = 12003;
/** @type {number} RequestId.ALLIANCE_Assembly_Join，加入集结请求 */
export const CMD_ASSEMBLY_JOIN = 1204;
