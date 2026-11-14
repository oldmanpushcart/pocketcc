/**
 * activity/launch-silo · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.GET_GUN_FIGHT_INFO：活动信息 + 4 井归属（JSON send，{}） */
export const CMD_GET_GUN_FIGHT_INFO = 1055;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_INFO：个人积分与已领档位（JSON send，{}） */
export const CMD_GET_GUN_FIGHT_USER_INFO = 1057;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_REWARD：领取某档位积分奖励（JSON send，{score:num}） */
export const CMD_GET_GUN_FIGHT_USER_REWARD = 1058;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（驻军）——仅用于发驻军前的同 cmd 在途频控 */
export const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} ResponseId.PUSH_GUN_FIGHT_INFO（=11017）：单井归属/占领增量推送 */
export const PUSH_GUN_FIGHT_INFO = 11017;
/** @type {number} ResponseId.PUSH_GUN_FIGHT_REWARD_INFO（=10029）：个人积分/已领档位刷新推送 */
export const PUSH_GUN_FIGHT_REWARD_INFO = 10029;
