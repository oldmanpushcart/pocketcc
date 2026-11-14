/**
 * player/auto-coin-collect · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.GET_ORDER，收取主城建筑产出（V1 send，载荷 {id:建筑实例id}） */
export const CMD_GET_ORDER = 102;
