/**
 * alliance/alliance-defender · 协议号常量（B6 就近收编）。
 * 口径纪律：只收「服务器 ↔ 客户端契约」cmd 号；调参与面板项留在实现文件。
 * 注册表：scripts/protocol/（开发期单一真相）；改动后须重跑 npm run protocol:extract。
 * 报文实证 dashcam-rec-20261115T183001-14179309129759-1794738601093.part.ndjson（一场完整保卫战 + 双 type 领奖）；
 * 排行奖实证 dashcam-rec-20261116T023232-15596140531952-1794767552259.part.ndjson（手动 1355 领取 + 1311 快照）。
 */

/**
 * @type {number} RequestId.GET_ALLIANCE_DISPLAY_TIME（RequestId），联盟保卫战展示时刻查询。
 * req `{}`（JSON send，实证 req:send data={}）；resp `{st,et,det,siegeStatus,actSpec,redDot}`：
 *   st=活动开始 / et=活动展示结束（**非战斗结束**）/ det=领奖截止 / siegeStatus 2→3（战斗收尾后跃迁）；
 *   actSpec 是 POJO 枚举 `{empty,keys}`（wire 上读不到 .id，活动 aid 只能从 841 取）；
 *   redDot 形如 `{"42":8}`（个人积分可领档数，领后归 0；**47 键实证全程不出现**，联盟奖不能以红点为闸）；
 *   **43 键=排行奖可领标记**（实证活动结束后出现 {"43":1}，领后不再下发；排行奖以红点为闸）。
 */
export const CMD_GET_ALLIANCE_DISPLAY_TIME = 1353;

/**
 * @type {number} RequestId.GET_ACTIVITY_DATA（RequestId），活动数据总查询。
 * req `{}`（JSON send）；resp `{alist:[…]}`，取 `type===26` 条目：
 *   `.id`=活动 aid（实证 153，1792 领奖载荷用）；`.alMonsterSiege`=战斗快照
 *   `{startTime,endTime,isEnd,nextTime,targetId,realTargetId,round,maxRound,aid(联盟ID,非活动aid),…}`；
 *   `.atarget`=奖励行（targetType42 个人积分 ×8 / targetType47 联盟累计 ×16，state 0→1→2）。
 *   startTime 开战前数小时即暴露（实证开战前 1838s 已带），派兵窗口可提前锚定。
 */
export const CMD_GET_ACTIVITY_DATA = 841;

/**
 * @type {number} RequestId.ACTIVITY_GET_REWARD（RequestId），活动奖励批量领取。
 * req `{aid,type}`（JSON send，实证两条：`{aid:153,type:47}` 联盟累计 / `{aid:153,type:42}` 个人积分）；
 * 一次领完该 type 全部可领行（type42 领后 redDot[42] 8→0、type47 领后 atarget 16 行 state→2，均批量语义）。
 */
export const CMD_ACTIVITY_GET_REWARD = 1792;

/**
 * @type {number} RequestId.AWARD_AL_MONSTER_SIEGE_RANK（RequestId），联盟保卫战排行奖领取（联盟积分排名奖）。
 * req `{}`（JSON send，实证 req:send data={}）；resp `{reward:{items:[…]}}`。
 * 闸门：活动结束后才放出（用户口径 + 实证：战斗结束前 redDot[43] 不出现）；
 * 游戏原版以 1354 排行查询 status==0 为按钮闸（1=已领），本 feat 用 1353 redDot[43]>0 同效为闸（服务器权威）。
 * 与 1792 双 type 无关：排行奖是独立协议，无 aid/type 参数。
 */
export const CMD_AWARD_SIEGE_RANK = 1355;

/**
 * @type {number} ResponseId.ALLIANCE_MONSTER_SIEGE_INFO（ResponseId），保卫战战斗态推送。
 * 载荷 `{alMonsterSiege:{…同 841}}`；收尾序列实证 nextTime=2147483647 → `{isEnd:1,result:2,endTime,nextTime:0}`。
 * 战斗中高频下发（实证 1477 条/19min），作 siege 快照的实时合并源与唤醒源。
 */
export const CMD_PUSH_ALLIANCE_MONSTER_SIEGE = 11104;

/**
 * @type {number} ResponseId.MARCH_INFO（ResponseId），联盟行军信息广播（含他人行军，须按 uid 过滤）。
 * 驻防 marchType30 的生命周期**只走这条**（实证 856 应答零 type30、10019 零 type30）：
 * 体扁平 `{marchId(字符串),marchType,state,uid,begin:{bx,by},target:{tx,ty},marchStartTime,marchArrive,…}`，
 * state 序列实证 1 在途 / 11 到达驻防 / 3 返航 / 4 到家。
 */
export const CMD_PUSH_MARCH_INFO = 10007;
