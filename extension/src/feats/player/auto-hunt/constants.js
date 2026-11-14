/**
 * player/auto-hunt · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（打野/5连，经 march.attack） */
export const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} RequestId.ALLIANCE_Assembly_Create：创建集结（战锤集结，feat 直发） */
export const CMD_CREATE_RALLY = 1201;
/** @type {number} RequestId.ITEM_USE：使用道具（补充体力，req {itemid,amount}） */
export const CMD_ITEM_USE = 815;
/** @type {number} push PUSH_USER_ENERGY：体力变化推送（唤醒重判体力闸） */
export const PUSH_ENERGY = 10021;
/** @type {number} push PUSH_FIND_REFUGEECAMP：用求救信开营后服务器回推营地坐标 {x,y}（难民营落点唯一来源，非 906 搜索） */
export const PUSH_FIND_REFUGEECAMP = 10802;
