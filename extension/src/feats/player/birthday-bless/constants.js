/**
 * player/birthday-bless · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** @type {number} NRequestIdV2.BIRTHDAY_RED_PACKET_INFO_OPEN，开生日红包（首次可领时打开即领） */
export const CMD_INFO_OPEN = 3567;
/** @type {number} NRequestIdV2.BIRTHDAY_BLESS，给寿星送祝福（纯社交计数，无奖励） */
export const CMD_BLESS = 3565;
