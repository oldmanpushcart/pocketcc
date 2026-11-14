/**
 * player/source-of-war · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.GET_BOSS_INFO_V2，查询当前战争之源 BOSS（旧 JSON send）→ {bossId,id,x,y,reason} */
export const CMD_GET_BOSS_INFO_V2 = 9956;
/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；仅用于发攻前的同 cmd 在途频控（发送走 core/march.attack） */
export const CMD_MARCH_WORLD_POINT = 902;
/**
 * 攻击次数奖励领取（sendPBV2）：请求 {attackCount:门槛}，应答 data={attackCount,reward}。
 * 定义：NRequestIdV2.WORLD_BOSS_V2_CLAIM_ATTACK_COUNT_REWARD = 9952（真机录像实证 1/3/5 三档逐个发出）
 * @type {number}
 */
export const CMD_CLAIM_ATTACK_REWARD = 9952;
/**
 * push WORLD_BOSS_V2_ATTACK_COUNT_UPDATE：今日攻打次数更新（源码实证只 updateAttackBossCnt，不带已领列表）。
 * 定义：NResponseIdV2（游戏 PushResponse nm 处理器）
 * @type {number}
 */
export const PUSH_SOW_ATTACK_COUNT_UPDATE = 21923;
/** @type {number} push WORLD_BOSS_V2_DAY_RESET：每日重置/登录全量（覆写 attackCount + claimedAttackCountRewardList），唤醒重判即自愈 */
export const PUSH_SOW_DAY_RESET = 21924;
