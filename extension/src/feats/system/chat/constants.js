/**
 * system/chat · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.ALLIANCE_GET_MEMBER_LIST（RequestId.js:315），联盟成员列表只读查询；应答 schema 未实证，尽力解析+日志定稿 */
export const CMD_ALLIANCE_MEMBERS = 1132;
/** @type {number} RequestId.AddFriend（RequestId.js:150），发起好友申请；载荷按 {uid} 尽力口径（真机待验） */
export const CMD_ADD_FRIEND = 501;
/** @type {number} RequestId.PLAYER_INFO（RequestId.js:207），查玩家基础信息；游戏内聊天点名字同源用法 {uid}，应答 parse 后取 .playerInfo（ChatTools.showPrivateView 口径） */
export const CMD_PLAYER_INFO = 630;
/** @type {number} NRequestIdV2.RECALL_CHAT_MESSAGE（NRequestIdV2.js:25），撤回自己消息；游戏 revokeMsg 同源：sendPBV2 {roomId, uuid, channel, toUid}，时限配置 630061（默认 60s） */
export const CMD_RECALL_CHAT = 254;
/** @type {number} RequestId.MAIL_QUERY（RequestId.js：e[e.MAIL_QUERY=929]），查战报邮件详情；游戏 shareLinkBattleClick 同源 {uid,mailId}，
 *  纯只读查询（同 630 的 net.send 通道），应答体 .d 串再 parse 取 .mail */
export const CMD_MAIL_QUERY = 929;
/** @type {number} CHAT_INFO_LIST（服务器主动推），GET_CHAT_PUSH_LIST(≈954) 的实时对应物：被攻击/主动攻击等
 *  系统战报类消息经此推下（载荷 {header, data:{infos:[{uuid,content,roomId,time,channel,params}]}}，
 *  infos 项与 systemMessages 拉取同构）。原仅靠进频道时 systemMessages 拉一次，故实时看不到——这里订阅补上。 */
export const CMD_CHAT_INFO_LIST = 10919;
