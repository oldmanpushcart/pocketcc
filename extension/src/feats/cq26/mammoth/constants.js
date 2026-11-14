/**
 * cq26/mammoth · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 协议号 ────────────────────────────────────────────────────────────
/** @type {number} 2171 SERIES_FROST_MONSTER_STRIKE_DEF_INFO_OPEN：本场权威快照（req {}） */
export const CMD_INFO = 2171;
/** @type {number} 2178 SERIES_FROST_MONSTER_STRIKE_WAVE_REWARD_GAIN：批量领波次奖励 */
export const CMD_CLAIM = 2178;
/** @type {number} 22031 push SERIES_FROST_MONSTER_STRIKE_INFO_CHANGE：阶段/波次跃迁广播（只作唤醒） */
export const PUSH_DB_INFO = 22031;
