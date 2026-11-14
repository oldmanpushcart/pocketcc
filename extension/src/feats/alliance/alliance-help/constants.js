/**
 * alliance/alliance-help · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.ALLIANCE_HELP_APPLY（RequestId.js:338），载荷 {type:4, itemId, helpNum}（AllianceHelpSelectPanel_New.js:149,179-183） */
export const CMD_ALLIANCE_HELP_APPLY = 1139;
/** @type {number} RequestId.ALLIANCE_HELP_RECEIVE（RequestId.js:340），载荷 {type: 在途申请.Type, qid:"0"}（AllianceHelpPanel_New2.js:274-279） */
export const CMD_ALLIANCE_HELP_RECEIVE = 1141;
/** @type {number} RequestId.HELP_ALL_ALLIANCE_MEMBERS（RequestId.js:1033），载荷 {type:4}（AllianceHelpPanel_New2.js:373） */
export const CMD_HELP_ALL_ALLIANCE_MEMBERS = 1195;
/** @type {number} ResponseId.PushAllianceSelfHelpList（ResponseId.js:147）：自己的帮助被盟友帮助后的自助帮助列表推送，游戏据此 UpdateSelfHelpList 刷新 _selfHelpList（PushResponse.js:3369-3374） */
export const PUSH_ALLIANCE_SELF_HELP = 10446;
/** @type {number} ResponseId.ALLIANCE_HELP_REGET：联盟帮助数据整表重取推送，Handler 调 UpdateAllianceHelpData(!0) 重建 _selfHelpList/计数（PushResponse.js:5341-5343、AllianceData.js:445） */
export const PUSH_ALLIANCE_HELP_REGET = 10453;
