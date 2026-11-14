/**
 * battle/imperial-decree · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军；仅用于发攻前的同 cmd 在途频控（发送走 core/march.attack） */
export const CMD_MARCH_WORLD_POINT = 902;
