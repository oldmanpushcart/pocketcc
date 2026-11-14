/**
 * player/radar-task · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.RadarGetInfo：雷达主数据全量（req {clearFinishNotify:1}，真机报文实证） */
export const CMD_GET_INFO = 3504;
/** @type {number} RequestId.RadarStartTask：认领任务（req {id}，state 0→1） */
export const CMD_START_TASK = 3505;
/** @type {number} RequestId.RadarGetReward：领奖（req {id}，state=4 可用） */
export const CMD_GET_REWARD = 3508;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界图行军（零部队型 feat 直发八键 body） */
export const CMD_MARCH_POINT = 902;
/** @type {number} RequestId.ALLIANCE_Assembly_Create：创建集结（雷达集结型任务） */
export const CMD_CREATE_RALLY = 1201;
/** @type {number} RequestId.RadarDefend：一键击退雷达干扰攻击（req 恒空体，resp {sign}） */
export const CMD_DEFEND = 3515;
/** @type {number} push RADAR_STATUS_CHANGE：单任务状态变化（载荷即事件对象） */
export const PUSH_STATUS_CHANGE = 20013;
/** @type {number} push RADAR_ADD_ONE_TASK：任务池新增（{optionType,events:[]}） */
export const PUSH_ADD_ONE_TASK = 20015;
/** @type {number} push RADAR_OTHER_DATA_CHANGE：标量数据变化（taskPoolSurplusNum 等） */
export const PUSH_OTHER_DATA = 20016;
/** @type {number} push PUSH_RADAR_SIGN：信号功率与干扰攻击标记（{sign,deBeginTime}；防御闸的触发源之一） */
export const PUSH_SIGN = 20021;
/** @type {number} push RADAR_RING_CHANGE：环上任务状态变化（载荷即事件对象） */
export const PUSH_RING_CHANGE = 20025;
/** @type {number} push RADAR_DAYGROUP_EVENT_NUM_CHANGE：每日链推进（{optionType,events:[]}） */
export const PUSH_DAYGROUP_CHANGE = 20026;
/** @type {number} push PUSH_ENERGY：体力池变更（{type,point,pointMax,restoreSec,reason}），只认 type=1 且点数回升 */
export const PUSH_ENERGY = 10021;
