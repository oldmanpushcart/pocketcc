/**
 * cq26/wl-beast · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 常量 ──────────────────────────────────────────────────────────────
/** @type {number} 2125 SERIES_FROST_NWL_BEAST_SKILL_ACTIVATE：唯一写动作（攻打，即时结算） */
export const CMD_ATTACK = 2125;
/** @type {number} 2124 SERIES_FROST_NWL_BEAST_SKILL_ACTIVATE_INFO：单点伤害读数（只作展示刷新） */
export const CMD_INFO = 2124;
/** @type {number} 2111 SERIES_FROST_NWL_INFO：全分区快照（发现腿真相源，不依赖地图视口） */
export const CMD_WORLD_INFO = 2111;
