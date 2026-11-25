/** @type {number} V1 GET_DAILY_QUEST_REWAR_ALL：一次领取全部已完成每日任务（源码枚举名保留 REWAR 拼写） */
export const CMD_GET_DAILY_QUEST_REWARD_ALL = 315;
/** @type {number} V1 GET_DAILY_QUEST_BOX_REWARD：领取单个每日任务宝箱，载荷 {boxId} */
export const CMD_GET_DAILY_QUEST_BOX_REWARD = 304;
/** @type {number} PBV2 DAILY_QUEST_GET_ALL_BOX_REWARD：一键领取全部可领每日任务宝箱 */
export const CMD_GET_ALL_DAILY_QUEST_BOX_REWARD = 316;

/** @type {number} QuestState.CAN_REWARD：任务已完成且奖励可领 */
export const QUEST_STATE_CAN_REWARD = 1;
/** @type {number} DailyQuestBoxState.CAN_REWARD：宝箱已完成且奖励可领 */
export const BOX_STATE_CAN_REWARD = 1;
/** @type {number} DailyQuestBoxState.FINISHED：宝箱奖励已领取 */
export const BOX_STATE_FINISHED = 2;
