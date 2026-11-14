/**
 * alliance/alliance-boss · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} ResponseId.PUSH_ALLIANCE_BOSS(10435)，联盟机甲状态推送（游戏自己已刷新本地数据） */
export const CMD_PUSH_ALLIANCE_BOSS = 10435;
/** @type {number} RequestId.ALLIANCE_BOSS_GET_INFO，主动查机甲全量信息 */
export const CMD_GET_INFO = 1160;
/** @type {number} RequestId.ALLIANCE_BOSS_DONATE，捐献机甲碎片（count:0 为每日免费一枚） */
export const CMD_DONATE = 1161;
/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；攻打机甲用 marchType=18 */
export const CMD_MARCH_WORLD_POINT = 902;
