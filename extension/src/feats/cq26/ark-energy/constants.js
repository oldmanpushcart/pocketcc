/**
 * cq26/ark-energy · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 协议号 ────────────────────────────────────────────────────────────
/** @type {number} 22007 push（SERIES_FROST 状态族）：arkData{status,round,maxRound,arkArmyRed,endTimeSec}（真相源） */
export const PUSH_ARK_STATUS = 22007;
