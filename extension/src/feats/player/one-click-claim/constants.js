/**
 * player/one-click-claim · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} NRequestIdV2.TASK_RELAX_ONE_CLICK_GET_INFO，查询集中领取态（sendPBV2） */
export const CMD_INFO = 5684;
/** @type {number} NRequestIdV2.TASK_RELAX_ONE_CLICK_GET_REWARD，一键领取全部可用行（sendPBV2） */
export const CMD_REWARD = 5685;
