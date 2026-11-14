/**
 * player/truck-intercept · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} ESCORT_TRUCK_LOOT_TRUCK_VIEW_OPEN：打开可拦截车队列表 */
export const CMD_OPEN = 6473;
/** @type {number} ESCORT_TRUCK_LOOT_TRUCK_VIEW_RELOAD：刷新（重随机）可拦截列表 */
export const CMD_RELOAD = 6474;
/** @type {number} ESCORT_TRUCK_LOOT：对某车队发起拦截掠夺（核心战斗请求） */
export const CMD_LOOT = 6476;
/** @type {number} ESCORT_TRUCK_GET_REFRESH_INFO：拉取每日次数与刷新时间点 */
export const CMD_REFRESH = 6486;
/** @type {number} ESCORT_TRUCK_REFRESH_INFO_PUSH：服务器主动推次数/刷新变化（结构同 6486） */
export const CMD_REFRESH_PUSH = 21551;
/** @type {number} GET_SINGLE_QUEUE_BATTLEPOWER：查询一支编队的实际战力（旧 send 链路，ret.data 字符串需 parse） */
export const CMD_POWER = 999;
/** @type {number} MAIL_GETREPORT：按 reportId 拉战报（旧 send 链路，reportStr 解析后含 battle.defender） */
export const CMD_REPORT = 927;
