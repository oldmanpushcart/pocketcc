/**
 * activity/mask-dance · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} NRequestIdV2.DANCE_GET_REWARD：领取某场假面舞会的基地宝箱（sendPBV2） */
export const CMD_DANCE_GET_REWARD = 2503;
/** @type {number} PUSH_USER_DATA_COMMON：增量下发 danceRec / myReceiveDance（今日领取权威态） */
export const PUSH_USER_DATA_COMMON = 10053;
/** @type {number} PUSH_TILEINFO：瓦片增量，玩家城 p.cityReward 挂在 pointType=1 的点上 */
export const PUSH_TILEINFO = 10018;
