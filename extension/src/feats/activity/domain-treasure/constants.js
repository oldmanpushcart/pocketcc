/**
 * activity/domain-treasure · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} 矿脉列表查询（应答 data.otherKuangList，gatherStatus 标可挖状态） */
export const CMD_GET_KUANG_LIST = 8623;
/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军请求（挖矿派 902） */
export const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} push PUSH_SINGLE_MAIL：单封邮件推送；开采奖励邮件（mail_title_3245）经它实时下发，当日到账计数订阅用 */
export const PUSH_SINGLE_MAIL = 10264;
