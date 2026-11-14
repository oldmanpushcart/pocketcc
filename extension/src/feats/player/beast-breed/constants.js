/**
 * player/beast-breed · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ─────────────────────────── 协议常量（全部 net.sendPBV2） ───────────────────────────
/** @type {number} ENIGMA_BEAST_GET_INFO：我的兽池全量，req {} → resp {infos:[{id,cfgId,level,star,potential,breeding,show,lock,…}],expPool,fields} */
export const CMD_GET_INFO = 1570;
// 1578 ENIGMA_BEAST_BREEDING_RECORD_LIST：培育日志，req {} → resp {record:[{type,msg,time,gotoUid,id,result}]}（协议族备查，本 feat 未调用）
/** @type {number} ENIGMA_BEAST_BREEDING_MAIN_SET：设我家主宠，req {id:Int64}（Int64(0) 撤除） */
export const CMD_MAIN_SET = 1579;
/** @type {number} ENIGMA_BEAST_BREEDING_OTHER_APPLY：申请把我的兽放到 uid 家 / apply:false 撤回，req {uid,id:Int64,apply} */
export const CMD_OTHER_APPLY = 1580;
/** @type {number} ENIGMA_BEAST_BREEDING_OTHER_APPLY_OP：处理别人对我家的申请，req {uid,id:Int64,agree} */
export const CMD_OTHER_APPLY_OP = 1581;
/** @type {number} ENIGMA_BEAST_BREEDING_OTHER_APPLY_LIST：待我处理的申请，req {} → resp {apply:[{id,cfgId,level,star,uid,playerInfo,allianceTag}]} */
export const CMD_OTHER_APPLY_LIST = 1582;
/** @type {number} ENIGMA_BEAST_BREEDING_MAIN_LIST：与我相关的培育家列表，req {} → resp {info:[{apply?,info:{ownerUid,breedingStatus,breedingEndTimeSec,main,other,helpUid}}]} */
export const CMD_MAIN_LIST = 1583;
/** @type {number} ENIGMA_BEAST_BREEDING_BORN：领取该家培育产出，req {uid} */
export const CMD_BREEDING_BORN = 1584;
/** @type {number} ENIGMA_BEAST_BREEDING_VISIT_LIST：可拜访全量列表，req {} → resp {visit:[{ownerUid,breedingStatus,breedingEndTimeSec,main,other,helpUid,lastOfflineTime,ownerAllianceTag,…}]} */
export const CMD_VISIT_LIST = 1585;
// 1586 ENIGMA_BEAST_BREEDING_CANCEL：培育中提前撤，req {uid}（协议族备查，本 feat 未调用）
/** @type {number} ENIGMA_BEAST_BREEDING_HELP：帮盟友加速，req {uid} */
export const CMD_BREEDING_HELP = 1587;
/** @type {number} ENIGMA_BEAST_GET_HELP_BORN_REWARD：领取「帮助培育」的累计奖励，req {} */
export const CMD_HELP_BORN_REWARD = 1599;
/** @type {number} ResponseId.ENIGMA_BEAST_CHANGE：兽池单条变更推送（仅作唤醒） */
export const PUSH_BEAST_CHANGE = 10130;
/** @type {number} ResponseId.ENIGMA_BEAST_BREEDING_CHANGE：整包 breedData 推送（唤醒 + 每日配额唯一来源） */
export const PUSH_BREEDING_CHANGE = 10132;
/** @type {number} ResponseId.ENIGMA_BEAST_OTHER_BREEDING_CHANGE：别人家培育变更推送（仅作唤醒） */
export const PUSH_OTHER_BREEDING = 10133;
