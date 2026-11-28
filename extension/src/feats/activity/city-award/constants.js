/**
 * activity/city-award · 协议号与活动常量（服务器 ↔ 客户端契约）。
 * 口径纪律：只收服务器合同号与 showUiType；调参/队列阈值留在实现文件。
 */

/**
 * @type {number} NRequestIdV2.CITY_GET_REWARD
 * 城市庆典宝箱领取：sendPBV2，body {activityId, targetUidStr} → {reward:{...}}。
 * 无前置坐标查询（9655 不走），点击城市气泡即发。
 */
export const CMD_CITY_GET_REWARD = 9657;

/** @type {string} 胜利庆典（钢铁对决）showUiType，额外要求 extra.state===3 才出领奖按钮 */
export const SHOW_UI_TYPE_KING_DUEL = 'DragonKingDuel';
/** @type {string} 军事演习 showUiType */
export const SHOW_UI_TYPE_JM_FIRST_PART = 'JMFirstPart';
/** @type {string} 势力检阅 showUiType */
export const SHOW_UI_TYPE_REVIEW_TROOPS = 'ActReviewTroops';

/**
 * @type {string[]} 复用 ActivityWorldCityAwardNode 的活动集合（官方组件按
 * extra.can_receive_uid_list / extra.reward_received_list 数据驱动，无活动专属分支）。
 */
export const CITY_AWARD_UI_TYPES = [
  SHOW_UI_TYPE_KING_DUEL,
  SHOW_UI_TYPE_JM_FIRST_PART,
  SHOW_UI_TYPE_REVIEW_TROOPS,
];
