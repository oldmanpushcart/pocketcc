/**
 * player/daily-deal · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} NRequestIdV2.HERO_DAILY_EXCHANGE_GET_FREE_REWARD，领取每日特惠免费奖励（sendPBV2，空载荷） */
export const CMD_GET_FREE_REWARD = 9884;
/**
 * @type {number} PUSH_USER_DATA_COMMON：领取后回写 choose_hero_daily_reward="1"（今日已领的新鲜度凭证）。
 * 服务器 0 点不推重置 0（全量录制实证），故日界后字段=1 可能是昨日 stale，不得当闸门。
 */
export const PUSH_USER_DATA_COMMON = 10053;
/**
 * @type {number} push LOGIN：UserData 全量重同步，含 choose_hero_daily_reward 日切重置态（实证可迟到 50min，
 * dashcam 20261112T235237：11-13 00:50 才推 0），到即 kick 重判。
 */
export const PUSH_LOGIN = 1;
