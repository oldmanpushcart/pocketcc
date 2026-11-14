/**
 * activity/mecha-treasure · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} ResponseId.PUSH_ONE_ACTIVITYEXTRA，活动 extra 更新推送，载荷 {aid,extra}；新使徒刷出等会推它 */
export const CMD_PUSH_ONE_ACTIVITY_EXTRA = 10912;
/** @type {number} NRequestIdV2.PINK_MECHA_MONSTER_LIST，查询使徒列表，req {aid,type} */
export const CMD_MONSTER_LIST = 8802;
/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；攻打使徒用 marchType=189，仅用于在途闸门 */
export const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} ResponseId.USER_MARCH_INFO，本人行军状态推送；到家（state=4）即补扫一轮 */
export const CMD_USER_MARCH_INFO = 10019;
