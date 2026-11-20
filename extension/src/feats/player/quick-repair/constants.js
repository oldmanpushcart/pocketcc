/**
 * player/quick-repair · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.GET_QUICK_REPARE_INFO，快速修理额度权威读（V1 send） */
export const CMD_GET_QUICK_REPARE = 1785;
/** @type {number} RequestId.ARMY_HEAL_LIST，本地批量修理（服务器自动优先扣免费额度） */
export const CMD_ARMY_HEAL_LIST = 220;
/** @type {number} RequestId.GET_CROSS_HOSPITAL_QUEUES，跨服战场医院队列权威读 */
export const CMD_GET_CROSS_HOSPITAL_QUEUES = 1426;
/** @type {number} RequestId.ARMY_CROSS_HEAL，跨服/雷神修理（消耗材料） */
export const CMD_ARMY_CROSS_HEAL = 1427;
/** @type {number} RequestId.ORDER_QUEUE_ING_DONE，钻石加速本地全部在修队列 */
export const CMD_ORDER_QUEUE_ING_DONE = 151;
/** @type {number} RequestId.ORDER_QUEUE_SPEED_UP，钻石加速本地单条在修队列（普通/雷神加速方式不同时逐队列点名用） */
export const CMD_ORDER_QUEUE_SPEED_UP = 124;
/** @type {number} RequestId.SPEEDUP_CROSS_HOSPITAL_QUEUE_BY_GOLD，钻石加速跨服队列 */
export const CMD_SPEEDUP_CROSS_GOLD = 1428;
/** @type {number} RequestId.ITEM_USE，使用道具（医院加速道具走这一条） */
export const CMD_ITEM_USE = 815;
/**
 * 无双（AVA 族）三件套协议号（RequestId 实证；按模式整表切换，源码 StartAllQueue/_realUseCure 同款映射）。
 * @type {number} RequestId.AVA_ASK_HOSPITAL_DATA（普通无双·NewCAB 权威读，请求体恒 null）
 */
export const CMD_AVA_ASK = 6310;
/** @type {number} RequestId.AVA_CURE_ALL_ARMYS_DATA（批量修待修，{ids}） */
export const CMD_AVA_CURE = 6311;
/** @type {number} RequestId.AVA_SPEED_CURE（钻石/道具加速在修，同一命令两种 body） */
export const CMD_AVA_SPEED = 6312;
/** @type {number} RequestId.TEAM_MATCH_ASK_HOSPITAL_DATA */
export const CMD_TM_ASK = 6356;
/** @type {number} RequestId.TEAM_MATCH_CURE_ALL_ARMYS_DATA */
export const CMD_TM_CURE = 6357;
/** @type {number} RequestId.TEAM_MATCH_SPEED_CURE */
export const CMD_TM_SPEED = 6358;
/** @type {number} RequestId.MASTER_MATCH_ASK_HOSPITAL_DATA */
export const CMD_MASTER_ASK = 8403;
/** @type {number} RequestId.MASTER_MATCH_CURE_ALL_ARMYS_DATA */
export const CMD_MASTER_CURE = 8404;
/** @type {number} RequestId.MASTER_MATCH_SPEED_CURE */
export const CMD_MASTER_SPEED = 8405;
/** @type {number} RequestId.TEAM_LEGEND_ASK_HOSPITAL_DATA */
export const CMD_LEGEND_ASK = 9055;
/** @type {number} RequestId.TEAM_LEGEND_CURE_ALL_ARMYS_DATA */
export const CMD_LEGEND_CURE = 9056;
/** @type {number} RequestId.TEAM_LEGEND_SPEED_CURE */
export const CMD_LEGEND_SPEED = 9057;
/** @type {number} push ORDER_QUEUES_BATCH_INFO：本地伤兵队列入队/改态 */
export const PUSH_ORDER_QUEUES = 10120;
/** @type {number} push CSB_HOSPITAL_QUEUE_ADD：跨服战场医院队列入队 */
export const PUSH_CROSS_QUEUE_ADD = 13006;
/** @type {number} push New_CAB_HOSPITAL_CHANGE：无双医院队列变化（只当唤醒提示，载荷不入状态） */
export const PUSH_AVA_HOSPITAL_CHANGE = 21203;
/** @type {number} push TEAM_MATCH_CAB_HOSPITAL_CHANGE：TM 战场医院队列变化（ResponseId 实证） */
export const PUSH_TM_HOSPITAL_CHANGE = 21211;
/** @type {number} push MASTER_MATCH_CAB_HOSPITAL_CHANGE：Master 战场医院队列变化（ResponseId 实证） */
export const PUSH_MASTER_HOSPITAL_CHANGE = 21465;
/** @type {number} push TEAM_LEGEND_HOSPITAL_CHANGE：Legend 战场医院队列变化（ResponseId 实证；成员名无 CAB 段但指向同族 handler） */
export const PUSH_LEGEND_HOSPITAL_CHANGE = 21562;
