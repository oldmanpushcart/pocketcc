/**
 * cq26/ice-shake · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** SERIES_FROST_NWL_FIRE：荒芜冰原（NWL）融冰，resp 带 miniGameId 那一支是本 feat 的入口 */
export const CMD_FIRE_NWL = 2117;
/** SERIES_FROST_BWL_FIRE：巨熊盛宴（BWL）融冰，游戏按 `specIndex===0` 分叉到这条，resp 同形 */
export const CMD_FIRE_BWL = 2103;
/** SERIES_FROST_NWL_FIRE_MINI_GAME：唯一出网动作，载荷 `{id:Int64, index:档位}`（实录逐键） */
export const CMD_MINI_GAME = 2129;
