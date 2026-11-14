/**
 * player/city-skill · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.USE_CITY_SKILL（RequestId.js），使用/赠送城市皮肤技能，载荷 {skinId,targetUid} */
export const CMD_USE_CITY_SKILL = 1753;
/** @type {number} RequestId.GET_CITY_SKILL_DATA（RequestId.js），拉取城市皮肤技能冷却数据，载荷 {}，应答 d={skinSkills:[...]} */
export const CMD_GET_CITY_SKILL_DATA = 1752;
