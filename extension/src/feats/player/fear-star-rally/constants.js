/**
 * player/fear-star-rally · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.ALLIANCE_Assembly_Create：创建集结（惧星集结，feat 直发） */
export const CMD_CREATE_RALLY = 1201;
/**
 * @type {number} RequestId.GET_JION_ALL_RCTIME：查惧星当日计数（应答 d 含 thorSearchNum=今日已搜惧星次数）。
 * 报文实证：下田撤田趟实录 resp cmd 1026 data {thorSearchNum,...}。
 */
export const CMD_GET_JION_ALL_RCTIME = 1026;
/** @type {number} push PUSH_USER_ENERGY：体力变化推送（唤醒重判体力粗闸） */
export const PUSH_ENERGY = 10021;
