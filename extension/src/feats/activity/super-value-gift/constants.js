/**
 * 超值活动通用一键领取协议常量。
 * 源码实证：公开 H5 客户端 subpack.2b335.js / subpack2.5c3c4.js 的 RequestId 与 NET.send 调用。
 * 仅包含查询、领取；不含高级奖励解锁、翻牌、开箱、兑换或消耗道具协议。
 */

/** @type {number} GET_ACTIVITY_DATA：V1 send，{} → {alist:活动对象[]} */
export const CMD_GET_ACTIVITY_DATA = 841;
/** @type {number} GET_ACTIVITY_REWARD：V1 send，{aid,tid} → 单个已完成任务奖励与更新后的任务；ID 保留快照原始类型 */
export const CMD_GET_ACTIVITY_REWARD = 842;
/** @type {number} ACTIVITY_GET_SINGLE_INFO：V1 send，{id} → 单个活动对象 */
export const CMD_GET_ACTIVITY_SINGLE_INFO = 3103;
/** @type {number} ACTIVITY_GET_ALL_SCORE_REWARD：V1 send，{id}，聚合本活动已达成的积分档 */
export const CMD_GET_ALL_SCORE_REWARD = 1777;
/** @type {number} ACTIVITY_GET_ALL_TASK_REWARD：V1 send，{activityId,targetIds}，联盟 BP 已完成任务；targetIds 保留原始类型 */
export const CMD_GET_ALL_TASK_REWARD = 3140;
/** @type {number} MAKESHIFTBAG_RECEIVE：V1 send，{rewardCenterAid,rewardAid:-1}，应急背包全部待领奖励 */
export const CMD_MAKESHIFTBAG_RECEIVE_ALL = 3135;
/** @type {number} PIN_BALL_ACTIVITY_GET_SCORE_REWARD：V1 PB，嵌套 activityId/index:-1，弹珠循环积分奖励 */
export const CMD_PIN_BALL_GET_ALL_LOOP_REWARD = 4790;
/** @type {number} RICH_MAN_GET_ALLIANCE_BOSS_PROGRESS_REWARD：V2 PB，{activityId,index:-1}，大富翁循环伤害奖励 */
export const CMD_RICH_MAN_GET_ALL_LOOP_REWARD = 8768;
/** @type {number} LKM_BP_GET_PROGRESS_REWARD：V2 PB，{activityId,index:-1}，联盟远征循环积分奖励 */
export const CMD_TEAM_EXPEDITION_GET_ALL_LOOP_REWARD = 8795;
/** @type {number} LION_FIGHT_GET_FIRE_REWARD：V2 PB，{activityId,index:-1}，新春舞狮循环火力奖励 */
export const CMD_LION_FIGHT_GET_ALL_LOOP_REWARD = 8833;

/** @type {number} ActivityTargetState.FINISHED：任务已完成、奖励可领 */
export const TASK_STATE_FINISHED = 1;
/** @type {string} 联盟 BP 视图类型；源码中只有该视图的“全部领取”走 3140 */
export const ALLIANCE_BP_UI_TYPE = 'ActivityAllianceBP';
/** @type {string} 应急背包视图；全部领取走 3135 */
export const MAKESHIFT_BAG_UI_TYPE = 'activity_center_UI';
/** @type {string} 元旦弹珠视图；循环奖励一键领取走 4790 */
export const PIN_BALL_UI_TYPE = 'ActivityPinballGame_NY';
/** @type {string} 大富翁视图；联盟首领循环奖励一键领取走 8768 */
export const RICH_MAN_UI_TYPE = 'adventure_richman_UI';
/** @type {string} 联盟远征视图；循环积分奖励一键领取走 8795 */
export const TEAM_EXPEDITION_UI_TYPE = 'teamExpedition';
/** @type {string} 新春舞狮视图；循环火力奖励一键领取走 8833 */
export const LION_FIGHT_UI_TYPE = 'ActivityNewYear_WS';

/** @type {number} PUSH_ONE_ACTIVITY：整活动推送，仅作扫描唤醒源 */
export const CMD_PUSH_ONE_ACTIVITY = 10904;
/** @type {number} PUSH_ONE_ACTIVITY_EXTRA：活动 extra 推送，仅作扫描唤醒源 */
export const CMD_PUSH_ONE_ACTIVITY_EXTRA = 10912;
