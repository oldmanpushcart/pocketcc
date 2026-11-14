/**
 * player/secret-weapon-drop · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.CD_SKILL_USE，使用秘密武器特技（PB V1），载荷 {header,cdSkillUse:{id,param:[x,y]}} */
export const CMD_USE_SKILL = 4170;
/** @type {number} RequestId.Get_Home_Air_Drop_Reward，收取空投建筑奖励（旧 JSON V1），载荷 {targetId} */
export const CMD_COLLECT = 4168;
/** @type {number} RequestId.CD_SKILL_INFO，查询秘密武器特技次数/冷却（PB V1），载荷 {header:{}} → pbAck.cdSkillInfo.skills[]={id,start,cnt,end}。发 4170 前的权威闸门 */
export const CMD_SKILL_INFO = 4169;
