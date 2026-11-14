/**
 * cq26/feast · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

/** SERIES_FROST_BWL_GET_CHEST：BWL 奖励宝箱（315 specIndex=0），req {x,y} */
export const CMD_GET_CHEST = 2104;
/** SERIES_FROST_BWL_OPENED_CHEST_LIST：已开宝箱表，req {} → posList（只读，每日一发） */
export const CMD_OPENED_LIST = 2105;
/** SERIES_FROST_BWL_FEAST_GET_GIFT：盛宴礼盒，req {pointIndex} */
export const CMD_GET_GIFT = 2106;
/** SERIES_FROST_BWL_FEAST_GET_SECRET_GIFT：巨熊宝藏（旧称密礼），req {id:Int64,received:true}（无坐标，跨图可领） */
export const CMD_SECRET_GIFT = 2108;
/** push 阶段机（CQ26BeastFeastPhase） */
export const PUSH_PHASE = 22032;
/** push 巨熊宝藏全量快照 */
export const PUSH_SECRET = 22064;
/** push 玩家快照（礼盒/巨熊宝藏额度） */
export const PUSH_PLAYER = 22073;
/** push 礼盒发奖明细 */
export const PUSH_GIFT_REWARD = 22075;
/** push 额度权威（BWL/NWL 共享 remainChestNum） */
export const PUSH_WL_INFO = 22072;
/** push 地块增量（315 宝箱行 + 310 巨熊宝藏行） */
export const PUSH_TILE = 10018;
/** GET_WORLD_INFO：315/310 地块真相的只读通道 */
export const CMD_WORLD_INFO = 901;
