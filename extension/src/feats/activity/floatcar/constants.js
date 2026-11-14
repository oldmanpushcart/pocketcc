/**
 * activity/floatcar · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} NRequestIdV2.FLOAT_PARADE_QUERY_CAN_REWARD_BAG，req {queryType:1, marchType:dropType[, marchIdStr]} → resp data={x,y} */
export const CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG = 8852;
/** @type {number} push FLOAT_PARADE_REWARD_LUCKY_BAG：拾取奖励到账推送，载荷 {synType, rewardedLuckyBags:{marchId:{num}}}；
 *  synType=2 增量（当日到账计数只认它）/1 全量同步（避开）；花车奖励不走 3416 邮件（报文实证） */
export const CMD_FLOAT_PARADE_REWARD_LUCKY_BAG = 21653;
