/**
 * cq26/energy-convoy · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 常量 ──────────────────────────────────────────────────────────────
/** SERIES_FROST_MONSTER_CLEANUP_ENERGY_SUPPLY：唯一出网动作，载荷恒为空对象 {} */
export const CMD_CLAIM = 2212;
/** push SERIES_FROST_SELF_INFO：能量补充车队亮灯位 canReplenishMonsterCleanupEnergy 的载体 */
export const PUSH_SELF_INFO = 22001;
