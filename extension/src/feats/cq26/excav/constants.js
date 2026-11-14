/**
 * cq26/excav · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 常量 ──────────────────────────────────────────────────────────────
/** SERIES_FROST_EXCAV_CLAIM：唯一出网动作，载荷只有 {siteId} */
export const CMD_CLAIM = 2491;
/** push 战区宝藏开启点全量快照 */
export const PUSH_OPEN_LIST = 22062;
/** push 本人已采集合（服务端持久） */
export const PUSH_SELF = 22063;
