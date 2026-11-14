/**
 * cq26/wl-chest · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 常量 ──────────────────────────────────────────────────────────────
/** SERIES_FROST_NWL_GET_CHEST：唯一出网的写动作，载荷 `{wastelandIndex, x, y}`（实录逐键） */
export const CMD_GET_CHEST = 2118;
/** 901 GET_WORLD_INFO：唯一能拿到 315 地块 `m.specIndex/leftTimes` 的通道（经 core/map.js fetchWindow） */
export const CMD_WORLD_INFO = 901;
/** push 22077：未开箱全量快照（开过的点从下一份消失） */
export const PUSH_CHEST_POS = 22077;
/** push 22072：额度唯一权威 */
export const PUSH_WL_INFO = 22072;
/** push 22071：分区状态（只做唤醒，不参与判据） */
export const PUSH_LAND_LIST = 22071;
/** push 10018：单 tile 变更（写完即推，顺带刷新地块真相） */
export const PUSH_TILE = 10018;
