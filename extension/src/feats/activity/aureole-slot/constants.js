/**
 * activity/aureole-slot · 协议号常量。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 *
 * 平铺定义而非内联数字，是 protocol/scan.mjs 的扫描口径（只认 `CMD_/PUSH_ NAME = 数字;`，
 * 不扫对象字面量）——下面的 SLOT_FAMILIES 一律引用这些常量，注册表才能收到这四个号。
 */

/** HAPPY_GO_GET_WORLD_LIST：req {activityId} → {worldList:[…]}（摇摇机世界页列表） */
export const CMD_AUREOLE_WORLD_LIST = 9630;
/** HAPPY_GO_BUILDING_DRAW：本 feat 唯一出网动作，req {activityId,instanceIdStr} → {resultId,reward} */
export const CMD_AUREOLE_DRAW = 9628;
/** CQ_MINE_TIGER_GET_WORLD_LIST：摇摇机孪生（宝藏幸运机）世界页列表，req/resp 与 9630 同形 */
export const CMD_EXCAVATE_WORLD_LIST = 2509;
/** CQ_MINE_TIGER_DRAW：孪生支路的抽取，req/resp 与 9628 同形 */
export const CMD_EXCAVATE_TIGER_DRAW = 2507;
/** PUSH_ONE_ACTIVITYEXTRA：两套皮共用的活动 extra 更新（worldUIRed / buildDrawNumMap 权威位） */
export const CMD_PUSH_ONE_ACTIVITY_EXTRA = 10912;

/**
 * 两套皮共用同一份游戏面板代码（AureoleWorldSlotMachinePanel / AureoleSlotListPanel），
 * cmd 与取参字段按 showUiType 切换；NRequestIdV2 号段逐条镜像。
 *
 * - capField：「每台抽取上限」从哪个活动字段取。摇摇机读 `type_para1`、幸运机读 `para6`
 *   —— 源码逐字实证（AureoleWorldSlotMachinePanel.refreshDrawBtnState / onClickStartCallback）：
 *   `cap = (showUiType===ActivityExcavate ? para6 : type_para1).split('|').map(Number)[2] || 1`，
 *   这是两套皮唯一的非对称点，其余判据（红点、buildDrawNumMap、expireTimeMilli）完全同形。
 * - requireField：该字段缺位 = 本期活动没挂摇摇机支路（印石挖掘的另一条支路是传说宝藏
 *   ExcavateBuildListPanel，9821-9828，需派兵），整条不入选。
 *
 * @type {Array<{showUiType: string, label: string, worldListCmd: number, drawCmd: number, capField: string, requireField?: string}>}
 */
export const SLOT_FAMILIES = [
  {
    showUiType: 'ActAureole',
    label: '情报摇摇机',
    worldListCmd: CMD_AUREOLE_WORLD_LIST,
    drawCmd: CMD_AUREOLE_DRAW,
    capField: 'type_para1',
  },
  {
    showUiType: 'ActivityExcavate',
    label: '宝藏幸运机',
    worldListCmd: CMD_EXCAVATE_WORLD_LIST,
    drawCmd: CMD_EXCAVATE_TIGER_DRAW,
    capField: 'para6',
    requireField: 'para6',
  },
];
