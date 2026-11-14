/**
 * alliance/relic-reward · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} RequestId.GET_FORTRESS_CHOOSE_ITEM_REWARD_DATA，查询遗迹本轮候选/已领（载荷 {wonderId}） */
export const CMD_QUERY = 1825;
/** @type {number} RequestId.FORTRESS_CHOOSE_ITEM_REWARD，领取一枚选定候选（载荷 {wonderId, index}） */
export const CMD_CLAIM = 1826;
