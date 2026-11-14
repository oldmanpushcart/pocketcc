/**
 * player/daily-deal · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} NRequestIdV2.HERO_DAILY_EXCHANGE_GET_FREE_REWARD，领取每日特惠免费奖励（sendPBV2，空载荷） */
export const CMD_GET_FREE_REWARD = 9884;
