/**
 * activity/titan-blessing · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} ResponseId.PUSH_ONE_ACTIVITY（ResponseId），整条活动推送，载荷含 type/extra/id */
export const CMD_PUSH_ONE_ACTIVITY = 10904;
/** @type {number} ResponseId.Push_Titan_Blessing_Gift=13226，新箱广播（客户端 EventId 别名 TitanBlessTreasureRefresh），载荷 {uid,playerInfo,x,y,endTime} */
export const CMD_PUSH_GIFT = 13226;
/** @type {number} ResponseId.Push_World_Titan_Blessing_Reward_Get=13227，本人领取到账，载荷 {reward,uuid} */
export const CMD_PUSH_REWARD_GET = 13227;
/** @type {number} ResponseId.Push_World_Titan_Blessing_Gift_Clear=13228，箱子消失，载荷 {uuid} */
export const CMD_PUSH_GIFT_CLEAR = 13228;
/** @type {number} NRequestIdV2.HERO_EQUIP_WISH_FIND_BOX（NRequestIdV2），载荷 {activityId}，应答 data={serverId,x,y}（值已真机验证） */
export const CMD_HERO_EQUIP_WISH_FIND_BOX = 9595;
/**
 * @type {number} RequestId.GET_ACTIVITY_DATA=841，全量活动查询（旧 JSON 主通道 api=send，空体 {}），
 * 应答 data={alist:[活动对象…]}；泰坦祝福条目 type=271/showUiType="ActivityTitanBlessing"，extra.left=本期剩余可领。
 * 报文实证 dashcam dashcam-rec-20261105T103923-我的日常.ndjson（req data={}，resp alist 含 type:271 extra.left/totalNum）。
 */
export const CMD_GET_ACTIVITY_DATA = 841;
