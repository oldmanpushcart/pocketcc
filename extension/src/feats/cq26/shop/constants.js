/**
 * cq26/shop · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 常量 ──────────────────────────────────────────────────────────────
/** SHOP_VIEW_OR_GET_RED_PACK：req {id, get}，get=true 即领 */
export const CMD_RED_PACK = 2441;
/** SHOP_GET_INFO：全量快照（唯一权威读通道） */
export const CMD_GET_INFO = 2442;
/** SHOP_GET_SINGLE_INFO：单所补查（带 canRevRedPack） */
export const CMD_SINGLE = 2443;
/** SHOP_BUY：本 feat 唯一写动作 */
export const CMD_BUY = 2444;
// CMD_OPEN=2445（城主宣布开市）/ 2446 发红包 / 2447 流水 —— 登记不接线，理由见文件头「刻意不做」
/** push NEUTRAL_CITY_SHOP_ICON：{type:1 开市 | 2 红包, id}，与 status 1→2 翻转同秒 */
export const PUSH_SHOP_ICON = 22030;
