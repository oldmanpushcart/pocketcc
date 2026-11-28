/**
 * activity/sea-treasure · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} NRequestIdV2.SEIZE_SEA_TREASURE_QUERY_WORLD_BOSS，查询当前可攻打的世界 boss，req {activityId} → resp {bossInfos} */
export const CMD_QUERY_WORLD_BOSS = 3756;
/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；攻打 boss 用 marchType=178 */
export const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} push PUSH_SINGLE_MAIL：单封邮件推送；攻打奖励邮件（mail_title_3243）经它实时下发，当日到账计数订阅用 */
export const PUSH_SINGLE_MAIL = 10264;
