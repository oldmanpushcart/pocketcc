/**
 * cq26/train · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 协议号 ────────────────────────────────────────────────────────────
/** @type {number} 2365 SERIES_FROST_TRAIN_OPEN：读列车权威快照（req {}） */
export const CMD_OPEN = 2365;
/** @type {number} 2367 SERIES_FROST_TRAIN_MARCH：上车派兵（req {uuid,troop}，仅 state=10） */
export const CMD_MARCH = 2367;
/** @type {number} 2369 SERIES_FROST_TRAIN_LOOT_VIEW_RELOAD：刷可掠列表 + 权威配额（req {}） */
export const CMD_LIST = 2369;
/** @type {number} 2370 SERIES_FROST_TRAIN_LOOT：对某辆列车掠夺（req {uuid,troop}） */
export const CMD_LOOT = 2370;
/** @type {number} 2375 SERIES_FROST_TRAIN_OTHER_GET_INFO：单车详情（防守名单 + 奖池，req {uuid}，数 KB） */
export const CMD_INFO = 2375;
/** @type {number} 2373 SERIES_FROST_TRAIN_GET_REWARD：领到站基础奖励（req {uuid}，仅 state=30） */
export const CMD_REWARD = 2373;
/** @type {number} 2385 SERIES_FROST_TRAIN_CARD_INFO：翻卡奖池分页（req {uuid,pageId,needEmpty}，每页 32 个卡位） */
export const CMD_CARD_LIST = 2385;
/** @type {number} 2386 SERIES_FROST_TRAIN_CARD_REWARD：翻一张卡（req {uuid,index}） */
export const CMD_CARD_FLIP = 2386;
/** @type {number} 22095 PUSH SERIES_FROST_TRAIN_INFO：发车推送（state→20 的边沿信号） */
export const PUSH_TRAIN_INFO = 22095;
/** @type {number} 22096 PUSH SERIES_FROST_TRAIN_DATA：领奖/翻卡后的全量列车态（带 baseRewardGet / shareRewardHaveNum） */
export const PUSH_TRAIN_DATA = 22096;
/** @type {number} 22010 PUSH SERIES_FROST_RED_POINTS：印石红点，id=101 携带剩余可掠次数 */
export const PUSH_RED_POINTS = 22010;
