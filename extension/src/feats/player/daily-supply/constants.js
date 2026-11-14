/**
 * player/daily-supply · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.GetTimeReward，领取每日补给免费计时奖励（V1 send） */
export const CMD_GET_TIME_REWARD = 825;
/**
 * @type {number} push LOGIN：UserData 全量重同步，含 timeReward 日切重置态 {times:0,rewardTime=日界}。
 * 0 点重置不保证即时推送（实证 dashcam 20261112T235237：11-13 00:50 才到，迟到 50min），到即 kick 重判。
 */
export const PUSH_LOGIN = 1;
