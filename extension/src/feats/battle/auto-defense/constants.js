/**
 * battle/auto-defense · 协议号常量（B6 就近收编：原散在 feat 实现文件的 CMD_/PUSH_ 定义 verbatim 迁入）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 */

// ── 协议命令号（服务器契约常量，就近定义） ──────────────────────────────
/** @type {number} ResponseId.PUSH_ATTACK_ARMIES：被攻击军队推送（来袭预警）；{uid,attackState(1来袭/0结束),level,arrivalTime,marchId} */
export const CMD_PUSH_ATTACK_ARMIES = 10167;
/** @type {number} RequestId.PLAYER_INFO：按 uid 查玩家基础信息；req {uid:String}，应答顶层含 x/y(主城坐标)/power/level/allianceName（真机实证，见 chat-window 630 口径），与视口/场景无关，Home 亦可查 */
export const CMD_PLAYER_INFO = 630;
/** @type {number} RequestId.PEACE_SHIELD：开护盾（背包道具，isPurchase:0）；拒 status=3+war_fever_003/kingdom_077 */
export const CMD_PEACE_SHIELD = 910;
/** @type {number} RequestId.MOVE_CITY_POSITION：迁城到指定坐标（背包迁城卡，isPurchase:0）；req {itemId,amount:1,isPurchase:0,x,y} */
export const CMD_MOVE_CITY_POSITION = 911;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（发）；仅用于发攻前的同 cmd 在途频控（发送走 march.attack） */
export const CMD_MARCH_WORLD_POINT = 902;
