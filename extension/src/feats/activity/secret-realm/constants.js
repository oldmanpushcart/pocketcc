/**
 * 异能秘境（Pab / 字典 enigma_realm01）feat 私货常量：协议号、PAB 实体类型、DataConfig 键、
 * EventCenter 事件名、拍宠物投喂行映射与节奏调参。均为「服务器↔客户端契约 + feat 调参」，
 * 不下沉 core（core/game-api.js 只收口运行时游戏符号名，此处是报文线路格式与玩法参数）。
 *
 * 报文实证：dashcam 20261004T202430-异能秘境-我是队长-发车.ndjson（战场包仅 resp、无 req，
 *   证实秘境 req 走未 hook 的 watch 独立 socket、resp 回主 NetReciver）；req 载荷形态取自源码 verbatim
 *   （PabRewardBoxNode / PabResLibraryNode / RealPabController / PabPetCaptureNodeNew / NRequestIdV2）。
 *   **次通道 outbound 已打通后的实战样本**：dashcam 20261011T195811（8546/8527/8526/8538 均出现
 *   `dir:"req:sendPBV2"`，心跳 0 条），本轮的节拍与拒绝码语义全部以该会话为准。
 *   **商店 / 攻击警告 / 行军闭环的实战样本**：dashcam 20261018T200040-异能秘境-我是队长.ndjson
 *   （8540/8542/8543 四条商店链路、21534 攻击警告 591 条、8521→8522→21529→21522→8527→8526 开车闭环
 *   均在这一份里首次录到）。
 *   **本轮被新证据推翻的旧结论**（改代码前先读这几条，别按旧口径写注释）：
 *   • 「8521 全部 s=0、零拒绝」错 —— 本份 8521 有 80 条 `enigma_realm158` + 3 条 163 + 1 条 common_159995；
 *   • 「178 小BOSS 本体瓦片 0 条、区域闸只对大BOSS 成立」错 —— 10018 是**视口增量**，去重后 178@(230,234)
 *     实有 664 条且带 `esrId:22 state:21`；
 *   • `enigma_realm142 / 141` 在**全部 19 份录音里 0 命中** → 这两条分支是「字典 + 源码文案」推出的**未观测
 *     预防性代理**，不是实测行为（旧注释把它写成实测结论，已降级）；
 *   • 172/173 曾被标反 —— verbatim `NWorldMapEntityType`：**172 = PAB_MONSTER 异能兽、173 = PAB_RESOURCE 资源点**。
 */

// ─────────── 秘境协议号（NRequestIdV2.ENIGMA_SECRET_ROOM_*，均走 watch 通道 85xx）───────────
/** @type {number} ENIGMA_SECRET_ROOM_DROP_INFO：拉某掉落箱明细（req {x,y} → {info[],dropBeastInfo[],bagGetNum,beastGetNum,endTime}） */
export const CMD_DROP_INFO = 8532;
/** @type {number} ENIGMA_SECRET_ROOM_DROP_GET：领取一个掉落项/宠物（req {x,y,rId}，rId=dropId 字符串） */
export const CMD_DROP_GET = 8533;
/** @type {number} ENIGMA_SECRET_ROOM_RESOURCE_INFO：拉资源点明细（req {x,y} → {bagInfo[],buffInfo[],bagGetNum,buffGetNum,refreshTime}） */
export const CMD_RESOURCE_INFO = 8526;
/** @type {number} ENIGMA_SECRET_ROOM_RESOURCE_GET：领一个资源 bag（req {rId}，无 x,y） */
export const CMD_RESOURCE_GET = 8527;
/** @type {number} ENIGMA_SECRET_ROOM_RESOURCE_GET_BUFF：领一个增益 buff（req {rId,pos}，pos 语义待设备核验） */
export const CMD_RESOURCE_GET_BUFF = 8538;
/** @type {number} ENIGMASECRET_ROOM_BEAST_OPERATE：拍宠物投喂一拍（req {specId}；本 feat 走原生 petCaptureOperation，不直发此号，仅留档） */
export const CMD_BEAST_OPERATE = 8546;
/**
 * ENIGMA_SECRET_ROOM_MARCH_MOVE：行军到某瓦片（req `{x,y}`）——「上临时停泊平台」/「攻打 BOSS」/「撤离受击点」
 *   都是这一个入口（**全仓唯一能主动挪队伍的口**，游戏侧攻击警告面板没有「撤离」按钮）。
 * 报文实证 dashcam 20261017T210400：攻打 boss12@(230,234) 发的是 `8521 {x:230,y:234}`（起点必须是同区域平台），
 *   源码 verbatim RealPabController.sendToBuildingMarch = `checkRequestIdNoRes(8521) || sendPBV2(8521,{x:e,y:t},…)`。
 * 在位闸 verbatim：`isCanMarch() = !!roomBaseInfo && teamIsMooring()`，而
 *   `teamIsMooring() = !roomBaseInfo || marchState ∈ {ARRIVED(2), FIGHTING(12), PAB_FEED(21)}`（ACL 已包 teamIsMooring）。
 * 拒绝实测（dashcam 20261018T200040，共 310 次）：158×80「小队尚未抵达」/163×3「目标点不能行军」
 *   /17×1「战场即将封闭」/common_159995×1「param error」——**并非旧注释写的「零拒绝」**。
 * @type {number}
 */
export const CMD_MARCH_MOVE = 8521;
/**
 * ENIGMA_SECRET_ROOM_POINT_INFO：拉某点位驻军明细（req `{x,y}` → `{type, teams:[{teamId,sid,aid,allianceTag,playerNum,power,leaderPlayerInfo,…}]}`）。
 * 源码侧证（RealPabController.requestBuildingTeamsInfo）；报文实证它是面板「前往」按钮的前置查询：
 *   `8522{x,y} → 8521{x,y}` 同点配对 **131 组、延迟 0.5~1.0s**（个别 1.7/5.5s）→ 人工点流就是「查驻军 → 点前往」，
 *   自动开车可直接复刻这一对（不需要猜）。
 * @type {number}
 */
export const CMD_POINT_INFO = 8522;
/**
 * ENIGMA_SECRET_ROOM_BAG_USE：使用秘境背包道具（req `{info:{itemId,itemCount}, marchId}`）——编队治疗的动作口。
 * 源码 verbatim NWorldPabTeamSelfItem.useItem；报文实证同一会话 `itemCount` 恒为 1、marchId 是 8584 应答里那个
 *   Int64 对象的原样回传（`{_low,_high,_unsigned}`），不 Number 化、不转字符串。
 * @type {number}
 */
export const CMD_BAG_USE = 8534;
/**
 * ENIGMA_SECRET_ROOM_SHARE_BAG_USE：共享背包版（载荷同上，多一个 `pabBagItemUse(itemId,share,marchId,…)` 分叉）。
 * 源码侧证（RealPabController.pabBagItemUse：`t ? SHARE_BAG_USE : BAG_USE`）；本期治疗只用私有背包，留档不接入。
 * @type {number}
 */
export const CMD_SHARE_BAG_USE = 8535;
/**
 * ENIGMASECRET_ROOM_BOSS_RANK：BOSS 伤害榜（PabWorldUINew 每 5s 拉一次，排行面板料源）。
 * 注：成员名游戏侧就漏了下划线（verbatim `ENIGMASECRET_ROOM_BOSS_RANK`），不是笔误。
 * @type {number}
 */
export const CMD_BOSS_RANK = 8544;
/**
 * ENIGMA_SECRET_ROOM_BOSS_GUARD_REWARD_INFO：小BOSS 石头奖励的主动查询口。
 * **客户端全仓 0 调用方、四份录音 0 条**（石头账本全靠 push 21539 下发）→ 只登记，不接进链路。
 * @type {number}
 */
export const CMD_BOSS_GUARD_REWARD_INFO = 8547;
/**
 * ENIGMA_SECRET_ROOM_BOSS_GUARD_REWARD_GET：领取一颗石头（req `{x,y}`，**不带 bossId**，服务器按坐标反推）。
 * 源码 verbatim requestBossGuardRewardGet；报文实证同一会话：在平台 (237,229) 领到了石头点 (230,228)
 *   → **不要求队伍站在石头点位上**（与采集/拾取族的 158「小队尚未抵达」完全不同；158 在 8527/8538/8546/8521
 *   上都观测过、就是没在 8548 上观测过，四份录音 8548 只有 1 条拒绝且是 enigma_realm60）。
 * @type {number}
 */
export const CMD_BOSS_GUARD_GET = 8548;
/**
 * ENIGMA_SECRET_ROOM_SHOP_INFO：拉某商店点位货单（req `{x,y}` → `{items:[{specId,getTime}], readyList:[{uid,playerInfo(JSON 字符串),ready}]}`）。
 * 报文实证 dashcam 20261018T200040：9 个货位恒为 `specId ∈ {11,12,13,14,15,16,17,19,20}`（**18 缺席**，1011/1017/1018 三份一致）；
 *   **应答不带 x,y** → 点位身份只能从 req 侧取，req↔resp 按 `Event.reqTime` 配对。
 * ⚠ **本查询会把本店的非 type3 货位 `getTime` 归零**（实证同一店 19:1 → 再发一次 8540 → 19:0）：
 *   所以「还能买几次」只能以**本次应答为基准**做增量，不能拿上一次应答的 getTime 当现状。
 * @type {number}
 */
export const CMD_SHOP_INFO = 8540;
/**
 * ENIGMA_SECRET_ROOM_SHOP_READY_CHANGE：商店集合就绪开关（req `{x,y,ready:0|1}`）——**与补货无关**，
 *   是面板上的「我已就绪」勾选（verbatim PabShopPanel.onReadyToggleClick，应答侧对应 `readyList[{uid,ready}]`）。
 *   19 份录音 0 条（玩家从未点过）→ 本 feat 不接，只登记防误用。
 * @type {number}
 */
export const CMD_SHOP_READY_CHANGE = 8541;
/**
 * ENIGMA_SECRET_ROOM_SHOP_BUY：买一件（req `{specId,num}`，**无坐标** → 商店身份由服务器自持）。
 * 报文实证：`{specId:19,num:1}` / `{specId:16,num:1}` / `{specId:20,num:1}`；应答只带新的 `{items}`。
 *   `getTime` 语义 = **该 specId 已购次数**：BUY → +1；REFRESH → 归零（非 type3）。
 * @type {number}
 */
export const CMD_SHOP_BUY = 8542;
/**
 * ENIGMA_SECRET_ROOM_SHOP_REFRESH：刷新货单额度（req `{x,y}`）——**额度用完后唯一的重开手段**。
 * 报文实证（dashcam 20261018T200040）：每次恰好扣 **1 个 41010 人造水晶**（余量 10→9→…→1，与用户口径一致），
 *   且只把**非 type3** 货位的 getTime 归零（实测 19:1 →刷新→ 19:0，而同拍 type3 的 20 仍为 20:1）。
 * 源码 verbatim PabShopPanel.onRefreshClick：余量 < `_shopRefreshCost`（dataConfig 3029）即 tips enigma_realm74 开不了口。
 * @type {number}
 */
export const CMD_SHOP_REFRESH = 8543;
/**
 * ENIGMA_SECRET_ROOM_MARCH_ARMY_INFO：拉编队各支军队的血量（req `{uid}`，**uid 是字符串**）。
 * 报文实证 req = `{"uid":"14913381732485"}`；resp = `{playerInfo, infos:[{armyPower,maxArmyPower,power,marchId:{_low,_high,_unsigned},heros,armys}]}`。
 * 源码 verbatim NWorldPabTeamSelfPopup.updateView，且治疗成功后游戏自己会再发一条（报文里 8584↔8534 严格交替、间隔 0.5~0.6s）。
 * @type {number}
 */
export const CMD_MARCH_ARMY_INFO = 8584;
/**
 * ENIGMA_SECRET_ROOM_ATTACK_SELF_TEAM：「谁在打我」的**只读查询**（req `{uid:String(UID)}` → `{fightTeams[],waitTeams[]}`）。
 * 源码 verbatim（由攻击警告弹窗调用）；本份录音 **0 条** = 玩家从未打开过该面板
 *   → 不能拿它当「有攻击警告」的价判据（计数只看 push 21534），它只能当「按需拉详情」的候选料源。
 * @type {number}
 */
export const CMD_ATTACK_SELF_TEAM = 8549;
/**
 * ENIGMA_SECRET_ROOM_CALL_HELP：求援（req `{uid:String(UID)}` → resp `{x,y}`）。
 * 源码 verbatim：**不是战斗动作**，而是拿应答坐标拼 `ELEMENT_MONSTER+",-1,"+viewId` 向联盟频道发一条
 *   CHAT_PAB_ALLIANCE 链接消息 + tips enigma_realm218 → 「抗争到底」档若开求援就是一条聊天，需按聊天侧规范走。
 * @type {number}
 */
export const CMD_CALL_HELP = 8551;
/**
 * ENIGMA_SECRET_ROOM_REVIVE：战败复活（req `{uid}`，`ok===1` 后游戏 `jumpToTarget(roomBaseInfo.startPoint)`）。
 * 消费口在战败面板 PabWorldDefeatPanel（tips enigma_realm198 带 reviveNum+1）；本 feat 不代答（属越权），只登记。
 * @type {number}
 */
export const CMD_REVIVE = 8552;
/**
 * ENIGMA_SECRET_ROOM_LEAVE：退出 BOSS 战区（req `{uid:UID+""}`，`ok===1` 后游戏 `pabFightQuit()`）。
 * verbatim：`baseActivityInfo.type===1 && isPABServer()` 时额外 `leaveObserve()+purge()+emit(UPDATE_PAB_SELF_ATTACK,0)`；
 *   未选完 options 时 tips enigma_realm203。**整场退出、不是「换个点」** → 不作为「立即转移」手段。
 * @type {number}
 */
export const CMD_LEAVE_AREA = 8589;

// ─────────── 秘境推送号（走 watch 通道下行，主 NetReciver 汇聚后由 core/net.js 派 `net.<cmd>`）───────────
/**
 * ENIGMA_SECRET_ROOM_BEAST_EVENT：捕获事件（拖拽 / 心动时刻投喂弹窗）下发。
 * 载荷 verbatim `{type, specId[], endTime(Int64 毫秒), points[]}`。
 * **推送不会被游戏写进 capturingInfo**：8546 应答回写的 feedInfo 实测键仅
 *   `allFavor/selfenergy/endTime/stateEndTime/nowFavor/selfFavor/eventSpecId/eventRatio`——
 *   **没有 eventType、也没有 eventEndTime**（旧注释误记，实证 dashcam 20261011T203911 全 8546 应答逐键）；
 *   而 `eventSpecId` 会在 feedInfo 上连续挂十几秒（实证 ev=[3] 从 t+113.96 挂到 t+133+），**不能当事件身份**
 *   → 只能作轮询兜底的候选来源（见 capture.js #pollEvent）。
 * @type {number}
 */
export const PUSH_BEAST_EVENT = 21527;
/**
 * ENIGMA_SECRET_ROOM_FEED_BEAST：**「正在拍哪只宠物」的唯一真相**下发。
 * 载荷 verbatim `{x,y[,boss:1]}`，结束推 `{x:-1,y:-1}`；游戏 Handler 就一句
 *   `PabController.getInstance().capturingPetPos = o.data` + emit PabPetCaptureStateUpdate。
 * 实证 dashcam 20261011T203911：本会话 44 条，切出 7 个在拍窗口，**83/83 条 type=2 拖拽推送全部落在这些窗口内**
 *   （旧 `marchState===PAB_FEED` 判据下这些推送 0 条能被响应）；6 个已收窗每个都有明确的 {x:-1,y:-1} 结束推送
 *   → 收尾不靠「已喂满」估计。**但窗口起点不保证带 feedInfo**（7 个窗口里只有 5 个的起点有一条带 feedInfo 的
 *   21524，两个 BOSS 窗口 108.03/115.57 没有）→ capturingInfo 可能是上一只残留，不能拿它做在拍闸门。
 *   **BOSS 走同一条推送与同一个闸门**（实证 boss:1 那两窗，其中 (203,203) 长 41.4s 内人手发了
 *   100 次免费手拍 + 拖拽答案 + 能量拍，specId 集与普通宠完全一致）→ 自动拍不需为 BOSS 分叉。
 *   游戏 UI 侧每 10s 用它自愈（PabWorldUINew.updateCapturingData：瓦片 extData.state 不是
 *   PabFightStageState.FEED(5)/BOSS_FEED(23) 时把 capturingPetPos 打回 {x:-1,y:-1}）。
 * 本 feat 订阅它，但不拿它做闸门（闸门是直接读游戏现场的 `pab.capturingPetPos`，开局前已在拍也能立刻识别）：
 *   只用它识别换宠/收尾（清上一只残留的静默窗 + 打一条 info 供实录对账）。
 * @type {number}
 */
export const PUSH_FEED_BEAST = 21530;
/**
 * ENIGMA_SECRET_ROOM_BASE_INFO：**roomBaseInfo 全量快照**下推（载荷 `{info:{teamId,leaderUid,marchState,startPoint,pointType,targetPoint,fightEndTime,buffMap,members[…powerInfos],…}}` 共 24 键）。
 * 实测 210400 会话 239 条 ≈ 每 17s 一条 + 行军状态变化时补发 → **稀疏，不能当唯一唤醒源**，只用作现场校验与 Int64 料源。
 * `startPoint` 是**当前所在点**（ARRIVED 时 sp==tp），实测一整套四段式（文件头 boss.js §②）。
 * `marchState` 的全枚举 verbatim `NMarchState`（Script 侧，共 20 项）：
 *   INIT 0、MARCHING 1、ARRIVED 2、RETURNING 3、ARRIVED_HOME 4、GATHERING 5、ENCAMPING 6、RALLY_ASSEMBLING 7、
 *   RALLY_ASSEMBLED 8、REINFORCING 9、GARRISON 10、OCCUPY 11、**FIGHTING 12**、BATTLING 13、WAITINGRETURN 14、
 *   BEHEMOTH_MONSTER_ATTACK 15、EXPLOREING 18、GVE_ARRIVED 19、CROSS_TREASURE_TEAM_HOLDING 20、**PAB_FEED 21**、
 *   ACTIVITY_GATHERING 22、PAUSED 23。
 *   → 秘境侧实际只观测到 1（行军中）/ 2（到达）/ 21（在拍）；旧注释只列了这三个，本处补全以防误把 12 当未知值。
 *   ⚠ 与瓦片 `m.state` 用的 **PabFightStageState** 是两套枚举（那里 11/12 = PVP_READY/PVP_FIGHTING、22 = PALNE_MARCH），
 *     数值重叠但语义无关，不要互用。
 * @type {number}
 */
export const PUSH_BASE_INFO = 21521;
/** ENIGMA_SECRET_ROOM_BAG_INFO：秘境房间背包刷新（游戏侧 updateRoomBagInfo 写 roomBagInfo）；治疗余量随它变 @type {number} */
export const PUSH_BAG_INFO = 21525;
/**
 * ENIGMA_SECRET_ROOM_BOSS_STATE：**三个 BOSS 的状态机**下推，载荷 `{stateInfo:[{bossId,pos{x,y,k,rid},state,stateEndTime}]}`。
 * 游戏 Handler：`bossBaseInfo = a.stateInfo` + emit UPDATE_PAB_BOSS_STATE_CHANGE（header.s 必须为 0）。
 * `state` 见 ST_BOSS_FIGHTING 那族枚举。
 * **`stateEndTime` 是 Int64 毫秒**（旧笔记记的「秒」已推翻：417×2^32+1243037568 = 1792244400000），语义是
 *   「**当前阶段**结束时刻」：state22 时它等于转 21 的时刻（boss9 set=1792244400 与实测翻转时刻精确对齐）、
 *   state21 时是战斗窗口结束（实证 boss11/12 +420s、boss9 +600s）。
 * 一场只推 5 条（+37.6 全 22 → +1139.1 先 12/11 同时进 21 → +2159.1 boss9 进 21且 11/12 转 28 → +2303.4 boss9 转 30）
 *   → 稀疏，BOSS 引擎只拿它当 kick 源，业务态重读 ACL getBossBaseInfo()。
 * @type {number}
 */
export const PUSH_BOSS_STATE = 21535;
/**
 * ENIGMA_SECRET_ROOM_BOSS_GUARD_REWARD_INFO_PUSH：小BOSS 石头点位账本（**全量**下发）——**「能不能领」的唯一判据**。
 * 载荷 `{rewardInfo:[{bossId,fightTime:Int64,rewardInfo:[{pos{x,y,k,rid},rewardNum,rewardMaxNum,isFight}]}]}`；
 *   游戏 Handler：`bossGurardRewardInfo = a.rewardInfo`（源码拼写就是 Gurard）+ emit UPDATE_PAB_BOSS_GURARD_REWARD。
 * 报文实证时间线（210400）：初始 `0/0` 无 F → 参战后 `0/0F` → **账本给点时 `0/1F`** → 逐点 8548 → `1/1F`；
 *   **每个小BOSS 固定 5 个点位、每人每点位限领 1 次**（rewardMaxNum 只到 1）。
 * ⚠ 旧结论「石头 = 小BOSS 死后掉落的石头」已被推翻（实证 dashcam 20261018T200040）：
 *   boss12 仍 `state:21`（21535 里未收场）时 +1510.9s 就已经能领它那 5 个点 →
 *   **石头能不能领只能看本账本（`rewardNum<rewardMaxNum && isFight===1`），不能拿 BOSS 死亡/state 做前置条件**。
 * @type {number}
 */
export const PUSH_BOSS_GUARD_REWARD = 21539;
/**
 * ENIGMA_SECRET_ROOM_BOSS_FEED_OTHER_VIEW_INFO：大BOSS 投喂阶段的他人视图（载荷含 `pos` + `infos[]`）。
 * 实测 210400 共 76 条、最早 t+2227.3（比 boss9 进 state21 晚约 68s）、pos 恒 (203,203)；
 *   **本会话没有一条落到 state=23**，故大BOSS拍宠物环节在这四份录音里未被录到（旧会话 20261011T203911 只录到 boss:1 的拍宠窗）。
 *   本期只登记留档，链路未接入。
 * @type {number}
 */
export const PUSH_BOSS_FEED_VIEW = 21540;
/**
 * PUSH_TILEINFO（NResponseIdV2）：世界/秘境地图的**视口内瓦片增量刷新**下推，秘境图内载荷逐条形如
 *   `{v,x,y,k,id,pointType,m:{viewId,sET,sBT,teams[],esrId,state,iNum,bid,camp,isFight,fTeamIds,…}}`，
 *   `m` 即 extData（实证 210400 会话 7733 条、20261018T200040 会话更多）。
 *   **这是 BOSS 攻打侧取「平台↔区域配对键 esrId」与自动开车侧取「资源点档位 iNum / 在试点 state」的唯一本地料源**：
 *   ACL 不提供瓦片查询（游戏侧 tile getter 的调用方式未实证，不猜符号链），引擎直接订阅本推送自己按 `x,y` 建快照。
 * ⚠ **本推送是「进视口才推」的增量，不是全域快照**（旧结论「178 小BOSS 本体瓦片 0 条」就是把它当成了全域）：
 *   镜头没到那块区域就一条不会有 → 「快照里没有某点」不等于「该点不存在」，只能当「无证据」、不能当反证。
 * `m.state` 的口径是 **PabFightStageState**（不是 NMarchState）：verbatim WIPabResource.updateTileState 对
 *   `state===11||12` 走 `getRoomPointFightingPVPInfoByXY` + dataConfig(3018) 算战斗倒计时（tips enigma_realm110/139）
 *   → **瓦片 state 11/12 就是「本点正在被 PVP」的本地判据**（攻击警告侧的点位级证据）。
 * @type {number}
 */
export const PUSH_TILE_INFO = 10018;
/**
 * ENIGMA_SECRET_ROOM_TEAM_ARRIVE：行军到达目标点的推送（载荷 `{x,y,pointType}`）。
 * 报文实证（dashcam 20261018T200040）在闭环里的位置：
 *   `8521{x,y}req → 10007(state1) → 8521 resp{ok:1} → 8522{x,y}req → **21529{x,y,pointType}** → 10007(state2→12)
 *   → 8522 resp{type,teams[]} → 21522 RESOURCE_CHANGE → 8527{rId}×N → 8526/8532 → 下一条 8521`（单轮实测 +31~44.2s）。
 *   → **它是「已到达」最及时的信号**，也是 8521 撞 `enigma_realm158`（小队尚未抵达）的唯一解除信号。
 * @type {number}
 */
export const PUSH_TEAM_ARRIVE = 21529;
/**
 * ENIGMA_SECRET_ROOM_MARCH_INFO：**行车记录**下推（玩家地图上的行军线就靠它）。
 * 载荷 verbatim：`{marchArrive, lv, returnStartTime, target:{itemId,tx,ty,tk,w,h,targetType}, marchType,
 *   marchStartTime, returnArriveTime, marchIcon, state, marchId:"字符串", aid, begin:{bx,by}}`；
 *   `state` 实测 1（行军）/2（到达）/12（交战）；资源点目标 `target.itemId=15`、`target.targetType` 即目标 pointType。
 *   → 「自动开车」的进度料源（不必等 21521 那 17s 一条的稀疏快照）。
 * @type {number}
 */
export const PUSH_MARCH_INFO = 10007;
/**
 * ENIGMA_SECRET_ROOM_SELF_ATTACKED：**「有多少队正在打我」的计数**下推（载荷仅 `{num}`）。
 * 游戏侧链路 verbatim：`PushResponse` → `PabController.attackWarnNum = a.num` + emit UPDATE_PAB_SELF_ATTACK →
 *   **唯一消费者 PabWorldUINew.updateAttackWarnState**：`attackWarnNode.active = e>0`、红点数字 `Math.max(0,e)`、
 *   `e<=0` 时清空弹窗——**纯展示，游戏没有给玩家任何「撤离/应战」按钮** → 「立即转移 vs 抗争到底」必须由本 feat 实装。
 * 报文实证（dashcam 20261018T200040，591 条）：`0×525 / 1..14 / 42×1`；
 *   **转移即消警**（全库只有 3 例警告期转移，其中一例 `+424.6s 8521 resp{ok:1}` 与 `21534 num=0` 同拍）。
 * @type {number}
 */
export const PUSH_SELF_ATTACKED = 21534;
/**
 * ENIGMA_SECRET_ROOM_POINT_FIGHTING_INFO：某点位「谁在打 / 谁在驻」的战斗信息下推（载荷含 x,y 与队伍列表）。
 * 游戏侧写进 `roomPointFightingPVPInfo`/`roomPointFightingPVEInfo`（verbatim RealPabController 的
 *   updatePvpPanelInfo/getPvpPanelInfo 以 `NWorldMapUtils.getCellIndex(x,y,serverId)` 为键）
 *   → 它是「本点正在被 PVP」的**按点详情料源**（与瓦片 `m.state 11/12` 互为佐证）。
 * @type {number}
 */
export const PUSH_POINT_FIGHTING_INFO = 21523;
/**
 * ENIGMA_SECRET_ROOM_RESOURCE_CHANGE：资源点 bag 变动下推（载荷带 `uid`/`playerInfo`）。
 * ⚠ 与 8526 RESOURCE_INFO 的口径差异已实证：**应答条目不带 uid，而本推送带**
 *   → 「谁已领过」只能从推送侧拿，INFO 侧必须自己记账（见 REJ_SAME_ITEM_ONCE 注）。
 * @type {number}
 */
export const PUSH_RESOURCE_CHANGE = 21522;
/**
 * ENIGMA_SECRET_ROOM_DROP_CHANGE：掉落箱变动下推（载荷 `{x,y,dropInfo:[{dropId,info{itemId,itemCount},uid,hide}],beastGetNum,bagGetNum}`）。
 * @type {number}
 */
export const PUSH_DROP_CHANGE = 21532;
/**
 * ENIGMA_SECRET_ROOM_OTHER_ATTACK_ON_FEED：「拍宠物时被他人攻击」推送（理论上属攻击警告一族）。
 * **19 份录音 0 条** → 只登记，链路不依赖它（计数只看 21534）。
 * @type {number}
 */
export const PUSH_OTHER_ATTACK_ON_FEED = 21536;

// ─────────── PAB 地图实体类型（verbatim NWorldMapCommon.NWorldMapEntityType 全 PAB 段，瓦片 pointType）───────────
/**
 * PAB 全段枚举（verbatim，不再凭报文目测排序）：
 *   160 ALLY_HELP / **161 SHOP** / 162 BOSS_GUARD_REWARD / 163 DROP / 172 MONSTER / 173 RESOURCE /
 *   174 COMMON_PLANE / 175 TENT / 176 BOSS_PLANE / 177 BOSS / 178 BOSS_GUARD / 179 TEAM /
 *   186 EMERGENCY / 187 CNC_MAP_BUILDING / 188 LANDSCAPE。
 *   ⚠ **172 = 异能兽、173 = 资源点**（旧注释把两者标反过，已按枚举纠正）。
 * 各型瓦片 `m` 实测样本（dashcam 20261018T200040，顶层恒 `{v,x,y,k,id,pointType,m}`）：
 *   • 161 商店 `{viewId:22, esrId:2}`（**全库只有这两个字段** → 商店身份只能靠 pointType+坐标）
 *   • 162 石头 `{viewId:10, bossId, fTime:"毫秒字符串", indexId:1..5, rank, sET, esrId:0, state:0}`
 *   • 163 掉落 `{viewId:9, teamId, playerInfo, esrId:0, iNum}`
 *   • 172 野怪 `{viewId:4, fTeamIds[], sET, sBT, teams[], esrId:15, state:0/1/2/5}`
 *   • 173 资源 `{viewId:14, sET:"0", sBT:"0", teams[], esrId:15, state:0, iNum:2|3|5|10}`
 *   • 175 帐篷 `{viewId:7, sET:"0", sBT:"0", teams[], esrId:0, state:0}`
 *   • 176 平台 `{isFight, viewId:11, sET, teams[], esrId, state, bid:11, camp}`
 *   • 179 玩家 `{uid, aTag, playerInfo, esrId:0, aId, sid}`
 */
/** @type {number} PAB_SHOP：商店点位（四条 854x 协议的目标点） */
export const PAB_SHOP = 161;
/** @type {number} PAB_BOSS_GUARD_REWARD：小BOSS 石头点位（领取 req 8548；能不能领看 21539 账本，不看 BOSS 死活） */
export const PAB_BOSS_GUARD_REWARD = 162;
/** @type {number} PAB_DROP：掉落箱点位 */
export const PAB_DROP = 163;
/** @type {number} PAB_MONSTER：异能兽点位（**不是资源点**） */
export const PAB_MONSTER = 172;
/** @type {number} PAB_RESOURCE：资源/增益井点位（`m.iNum` = 资源点档位，可作选点排序键） */
export const PAB_RESOURCE = 173;
/** @type {number} PAB_COMMON_PLANE：普通停泊平台 */
export const PAB_COMMON_PLANE = 174;
/** @type {number} PAB_TENT：帐篷点（实测本份录音 8521 有 24+1 次打向它） */
export const PAB_TENT = 175;
/**
 * @type {number} PAB_BOSS_PLANE：临时停泊平台（tileArea=1；「攻打 BOSS」必须从这里出发）
 * 瓦片 extData 关键字段：`esrId`（区域配对键）/`state`/`sET`/`teams[]`/`isFight`。
 * **`bid` 与 `viewId` 恒为 11，不是 bossId**（曾据此误判配对关系）。
 * 实测去重 253 个平台，esrId 分**三桶** 20/21/22（旧注记的「134 个分两桶」是因为把视口增量当全域快照统计）。
 */
export const PAB_BOSS_PLANE = 176;
/** @type {number} PAB_BOSS：大BOSS 本体瓦片（tileArea=9） */
export const PAB_BOSS = 177;
/** @type {number} PAB_BOSS_GUARD：小BOSS 本体瓦片（tileArea=9；**并非「整份录音 0 条」**，178@(230,234) 实有 664 条带 esrId:22 state:21） */
export const PAB_BOSS_GUARD = 178;
/** @type {number} PAB_TEAM：玩家小队坐标点（瓦片 m 带 uid/aTag/playerInfo/aId/sid） */
export const PAB_TEAM = 179;

// ─────────── BOSS 阶段（PabFightStageState，实证 Script/PabController__PabController.js 全枚举）───────────
/** @type {number} ST_NORMAL：常规阶段 */
export const ST_NORMAL = 0;
/** @type {number} ST_PVE：PVE 阶段 */
export const ST_PVE = 1;
/** @type {number} ST_PVE_RESULT：PVE 结算 */
export const ST_PVE_RESULT = 2;
/** @type {number} ST_FEED：拍普通异能兽阶段 */
export const ST_FEED = 5;
/** @type {number} ST_PVP_READY：PVP 准备 */
export const ST_PVP_READY = 11;
/** @type {number} ST_PVP_FIGHTING：PVP 交战中 */
export const ST_PVP_FIGHTING = 12;
/**
 * @type {number} ST_BOSS_FIGHTING：**BOSS 可攻打**（NWorldPabBossPopup 只有在这个值才点亮攻击按钮）
 * 与「开启争夺倒计时」（ST_PLANE_MARCH 的 sET）互斥：21 是即刻能打，22 还在读秒。
 */
export const ST_BOSS_FIGHTING = 21;
/** @type {number} ST_PLANE_MARCH：平台可派兵、BOSS 在读秒（`enigma_realm10`「{0}后开启争夺」） */
export const ST_PLANE_MARCH = 22;
/**
 * @type {number} ST_BOSS_FEED：**大BOSS 死后进入拍宠物阶段**（WIPabBoss 的 feedNode 闸门：
 *   `state===23 && extData.fTeamIds.includes(roomBaseInfo.teamId.toString())`）。
 *   **源码侧证、报文未录**：四份录音里 boss9 只见 21→30，没有 23。
 */
export const ST_BOSS_FEED = 23;
/** @type {number} ST_BOSS_FIGHTING_END：BOSS 战斗结束 */
export const ST_BOSS_FIGHTING_END = 28;
/** @type {number} ST_BOSS_FEED_END：BOSS 拍宠物结束 */
export const ST_BOSS_FEED_END = 29;
/** @type {number} ST_BOSS_DEAD_END：BOSS 死亡收场 */
export const ST_BOSS_DEAD_END = 30;

// ─────────── 平台↔BOSS 的区域配对（取自 push 10018 PUSH_TILEINFO 的 `m` 字段，实证 dashcam 20261017T210400）───────────
/**
 * 瓦片 extData（= push 10018 的 `m` 子对象，**不是顶层**）里标识「属于哪个 BOSS 区域」的键。
 * 实证（dashcam 20261018T200040 + 20261017T210400，注意 10018 是视口增量、只能统计到“看到过的”）：
 *   • 176 平台去重 253 个，esrId 分三桶 20/21/22（旧记录“134 个分两桶”是把增量当全域统计所致）；
 *   • **178 小BOSS 本体瓦片确实带 esrId**（178@(230,234) 实有 664 条 `esrId:22 state:21`）
 *     → 旧结论「读 BOSS 本体 esrId 只对大BOSS 成立」**已被推翻**，只是它依赖镜头是否扫到那块区域；
 *   • **162 石头瓦片的 esrId 恒为 0** → 石头点位不能用作区域配对（这一条仍成立）；
 *   • 172/173 两型的 esrId 实测恒为 15、175/179/163 恒为 0 → **它们不参与区域配对**；
 *   • 全库键频：`esrId 57916 / sET 56905 / sBT 34779 / iNum 15937 / fTeamIds 892`（无 `esrIId` 这个拼法，0 命中）。
 *   ⚠ 客户端攻打入口 `NWorldPabBossPopup.marchClick` **完全不查 esrId** → 区域是**服务器独占判据**，
 *     本键只是「避免撞 142」的本地优化，不是硬闸（且 142 本身在 19 份录音里 0 命中，属未观测分支）。
 * @type {string}
 */
export const TILE_KEY_ESR_ID = 'esrId';
/**
 * 瓦片 extData 里「开启争夺/可派兵」倒计时的绝对秒键（`sET/1e3` 与 ServerTime 比）。
 * `sET > roomBaseInfo.fightEndTime/1e3` 视为本场已结束（游戏 tips `cab_ui_info_065`）。
 * @type {string}
 */
export const TILE_KEY_SET = 'sET';

// ─────────── DataConfig 限额键（TableUtils.getDataConfigData）───────────
/** @type {number} 掉落箱可领总量上限（_itemGetMax = Number(dataConfig(3021))；bagGetNum+beastGetNum 计入） */
export const CFG_DROP_ITEM_MAX = 3021;
/** @type {number} 掉落箱宠物已领上限（checkPetIdGeted：已含我 uid 的 dropBeast 数 >= Number(dataConfig(3061)) 即满） */
export const CFG_DROP_PET_MAX = 3061;
/** @type {number} 资源/增益上限串（dataConfig(3013) → "itemMax|buffMax"，split('|') 取 [0]=bag 上限、[1]=buff 上限） */
export const CFG_RES_LIMITS = 3013;
/** @type {number} 手拍每秒次数上限（dataConfig(630027)；实证 RealPabController.checkCaptureOperationCd 用它做 `_touchOperateMaxNum`） */
export const CFG_TAP_LIMIT_PER_SEC = 630027;
/**
 * 编队治疗道具白名单（dataConfig(3035) → "itemId|itemId|…"）。
 * 源码 verbatim NWorldPabTeamSelfItem.updateUseItem：`getDataConfigData(3035).split('|')` 逐个
 *   `getItemNumById(id)>0` 才画道具按钮 → **白名单不硬编码，运行时读**（本仓实证用到的两个是
 *   41002 急救绷带 / 41003 全科医疗包，仅作兜底参考值）。
 * @type {number}
 */
export const CFG_PAB_HEAL_ITEMS = 3035;
/**
 * 商店货币对（dataConfig(3028) → `"购买币|刷新币"`，split('|')）：[0]=41009 异能晶块、[1]=41010 人造水晶。
 * 源码 verbatim PabShopPanel.initView / PabShopItem.updateShopItem（`_costItemCfg = ITEM[t[0]]`，图标与预检都用它）。
 * @type {number}
 */
export const CFG_SHOP_CURRENCY = 3028;
/**
 * 单次刷新消耗（dataConfig(3029)，verbatim `_shopRefreshCost = Number(getDataConfigData(3029))`）。
 * **报文实证值 = 1**（dashcam 20261018T200040：18 次 8543 → 41010 余量 10→9→…→1，每次恰好扣 1），
 *   与用户口径「消耗 1 个人造水晶」一致；但仍**运行时读本键**，不把 1 写死。
 * @type {number}
 */
export const CFG_SHOP_REFRESH_COST = 3029;
/** @type {number} 资源点档位名串（dataConfig(630002) → `"min,max,loc|min,max,loc|…"`，verbatim getResBuildingNameByItemNum 拿 `m.iNum` 查区间） */
export const CFG_RES_BUILDING_NAME = 630002;
/** @type {number} 点位 PVP 战斗时长串（dataConfig(3018)，verbatim WIPabResource.updateTileState 用它给瓦片 state 11/12 算倒计时） */
export const CFG_PVP_FIGHT_TIME = 3018;

// ─────────── EventCenter 事件名（EventId 值 == 成员名；net 应答/推送处理器全局 emit，载荷含 x,y 与完整数据）───────────
/**
 * 掉落箱某点位数据刷新事件（载荷 {x,y,dropInfo,dropBeastInfo,bagGetNum,beastGetNum}）。
 * 游戏 PabRewardBoxNode 靠它按 x,y 匹配刷新面板；本 feat 订阅后仅对「当前到达点」发 GET，不做 INFO 扫描。
 * @type {string}
 */
export const EVT_REWARD_BOX_UPDATE = 'PabRoomRewardBoxDataUpdate';
/**
 * 资源/增益井某点位数据刷新事件（载荷 {x,y,bagInfo,buffInfo,bagGetNum,buffGetNum,refreshTime}）。
 * @type {string}
 */
export const EVT_RES_LIBRARY_UPDATE = 'PabRoomResLibraryDataUpdate';

// ─────────── 拍宠物动作与节奏（RealPabController / PetCaptureTouchNodeNew / PetCaptureDragNodeNew / PabPetFeedEventPopup verbatim）───────────
/** @type {string} 投喂物/动作配置表名（TableName.enigma_beast_behave；行 id 即 BEAST_OPERATE 的 specId，字段 item/time/favor/bar_pers/pai_times） */
export const TABLE_BEAST_BEHAVE = 'enigma_beast_behave';
/**
 * 投喂道具的**首格 specId**（enigma_beast_behave 行 5/6 的 `item` = 可投喂的秘境背包道具）。
 * 源码 verbatim PabPetCaptureNodeNew：`init` 取行 `(t+5).toString()`（**`for(t=0;t<2;t++)` → 只有 2 格**）填 `_captureItemIds`，
 *   即 `_captureItemIds[t] = ITEM[behave[t+5].item].id`；`onItemFeedClick(e,t)` → `getItemNumById(_captureItemIds[o])>0
 *   && petCaptureOperation(o+5)` → **specId = 格子下标 + 5**，且游戏自己先查背包余量。
 *   `RealPabController.petCaptureOperation` 的载荷只有 `{specId}`（报文实证：8546 全库请求形态仅此一种，
 *   `checkCaptureOperationCd` 首行只拦 specId===1 → 投喂不受每秒限额约束）。
 * 道具身份闭环实证（dashcam 20261018T200040）：`8542{specId:19}×10 → 21525 里 41011 +10 → 8546{specId:5}×10`
 *   → **behave[5].item = 41011 全素香肠**（就是商店 specId 19 的货，单价 500 晶块）。
 * 为什么要投：大BOSS 的 `allFavor=1000000`，而免费手拍 changeScore 实测仅 6~11（≈4 拍/秒）
 *   → 光靠手拍不可能拍满，behave 行的 `favor` 才是这一阶段的加分主力（单件投喂实测 changeScore=400）。
 * @type {number}
 */
export const SPEC_FEED_FIRST = 5;
/** @type {number} 投喂格子数（behave 行 5、6 —— 实证 PabPetCaptureNodeNew `for(t=0;t<2;t++)`，**不是 6 档**） */
export const SPEC_FEED_COUNT = 2;
// 8546 specId 全谱（报文实证 dashcam 20261011T203911，跨 3 份录音的完整请求序列）：
//   1 免费手拍（chg 5~9）；2/3 拖拽事件答案（chg=0 但 selfenergy +1，即 behave 表行号本身就是拖拽答案）；
//   4 能量满释放（chg 300/390、能量归 0）；7/8/9/10 心动时刻（投喂弹窗）选项（chg 50/100/200/500）。
//   **BOSS 与普通异能兽同协议同 specId 集**（BOSS 窗 41.4s 内请求直方图 {1:100, 2:1, 3:2, 4:1}），
//   差别只在 allFavor（BOSS 1000000 / 普通宠 7000~5000）与 21530 载荷多一个 boss:1。
/**
 * 免费手拍 specId（PetCaptureTouchNodeNew.petCaptureTouch → `petCaptureOperation(1)`，无消耗）。
 * 唯一受客户端每秒限额约束的 specId（实证 RealPabController.checkCaptureOperationCd 首行 `!(1!=e||…)`，
 *   限额 = Number(dataConfig(630027))/秒；超限该调用被游戏静默丢弃，不发包）。
 * @type {number}
 */
export const SPEC_TAP = 1;
/**
 * 能量满释放 specId（PetCaptureTouchNodeNew.onEnergyUseClick → `petCaptureOperation(4)`）。
 * 报文实证（同一会话，14/14 次能量周期完全复现）：selfenergy 攒到 3 后该拍 changeScore=390（普通拍 6~11），
 *   且能量归 0；随后 6.4~10.2s 无下一拍（游戏侧 behave[4].time 持续演出 + 6s energyMaxProtectNode 保护）
 *   ——即用户所述「凑够 3 次小节奏触发一段时间高分值持续的拍」。
 * @type {number}
 */
export const SPEC_ENERGY_USE = 4;
/** @type {number} 能量格数上限（实证 PetCaptureDragNodeNew `progress=selfenergy/3`、PetCaptureTouchNodeNew `btnEnergyMax.active = 3==selfenergy`） */
export const ENERGY_MAX = 3;
/**
 * 捕获事件类型（唯一来源是 push 21527 的 `type`——capturingInfo 里没有 eventType，见 PUSH_BEAST_EVENT 注）：
 *   2 = 拖拽事件（PetCaptureDragNodeNew，**窗口 2.0s**：源码 `_eventEndTime = ClientTime + 2e3`，
 *     报文实证全库 349/349 条 `endTime(Int64 ms) − header.ts×1000 ≡ 2000ms`（跨 4 个会话）；此前记的
 *     「3.2~3.4s」与「0.8~1.3s」都是 endTime 的 Int64 口径读错所致，均已推翻。
 *     成功 → `petCaptureOperation(specId[0])`，能量 +1 且 changeScore=0）；
 *   5 = **心动时刻**（界面标题即此，投喂弹窗 PabPetFeedEventPopup；选项 = specId 数组即 enigma_beast_behave 行 7..10，
 *     **服务器窗口实测 25.0s**（25/25）；报文实证 changeScore 200~650 档，择优即多拿分。
 *     **发号口径差异**：游戏发的是 `7 + 选项下标`（位置映射），本 feat 发的是候选值本身——
 *     实证 25/25 条 specId 恒为满四元 [7,8,9,10]，两者等价；若服务器改为下发子集则会错位。
 *     **弹窗必须主动关掉**：开窗方是 PabPetCaptureNodeNew.pabPetCaptureEvent（`5==e.type` 即
 *     `OpenUI(UIDataInfo.PabPetFeedEventPopup, e, tileInfo)`，与我们的推送回调同一个派发链），而它自己不知道
 *     票已被我方投掉，会按 `_endTime = ServerFloatTime + behave[specId[0]].time` 倒数到 0 后自动 `onFeedClick()`
 *     再随机发一发（报文实证 dashcam 20261017T210400：4/4 次我方 0ms 发出且结算 500 分后，弹窗仍在 +5.24~18.60s
 *     补发 `7+下标`，3/4 被接受）→ 见 capture.js #closeFeedPop；
 *   3 = 能量爆发演出（specId=[4] + points 数组、endTime 为哨兵值 ≈ Long.MAX/1000，43/43 实证），
 *     客户端无任何消费者，本 feat 也不直接响应它，由 selfenergy 闸覆盖。
 * @type {number}
 */
export const EVT_TYPE_DRAG = 2;
/** @type {number} 捕获事件类型：心动时刻（投喂弹窗，择优选项，见 EVT_TYPE_DRAG 说明） */
export const EVT_TYPE_FEED_POP = 5;

// ────────── 资源/增益井 item 映射（PabBagItem.updateResourceItem verbatim）─────────
/**
 * 资源站配置表名（TableName.enigma_secret_realm_rss_station）。
 * 源码实证：PabBagItem.updateResourceItem(e) 用 `getTableDataById(enigma_secret_realm_rss_station, e.specId)` → `.item` 得 itemId
 *   （供 checkItemNumMax 背包上限拦截）；`_uuid = e.dropId`（RESOURCE_GET 的 rId）、`_specId = e.specId`。
 * 运行时 dump 实证（tools/pab-pickpool-dump.devtools.js）：该表按**点位**分行（差异仅 id/region/piece/power/group），
 *   同一个产出道具对应几十行（如 item=41001 有 44 个 specId）→ 面板拾取清单必须按 itemId 聚合，不能逐 specId 列行。
 * @type {string}
 */
export const TABLE_RSS_STATION = 'enigma_secret_realm_rss_station';
/**
 * buff 槽位范围（实证 PabBuffEquipNode.initNode）：`for(n=1;n<=3;n++) { …getTeamBuffCfgByPos(n)… }`，
 *   对应 `roomBaseInfo.buffMap[pos] = rss_station specId`，pos 为 1-based。上限 = buffGetMax（dataConfig 3013 拆分位 [1]）。
 * @type {number}
 */
export const BUFF_SLOT_MIN = 1;
/** @type {number} buff 槽位上界（含），与 PabBuffEquipNode initNode 的 `n<=3` 同口径 */
export const BUFF_SLOT_MAX = 3;

// ────────── 增益 buff 类（effect_buff）与默认选择 ──────────
/**
 * 秘境增益站共 **6 个类**（运行时 dump 实证 tools/pab-pickpool-dump.devtools.js：rss_station 里 effect_buff!=0 的行
 *   按类去重得 6 组，每组 75 个 specId、buff_para 4 档），槽位只有 3 个 → 必须挑三。
 * 类名取 `EFFECTBUFF[effect_buff].string` 的 loc 译文（同 PabBuffItem.updateBuffNode）：
 *   9200001 全部单位攻击加成 / 9200002 全军防御能力提升 / 9200003 全部单位生命加成
 *   9200004 伤害加深 / 9200005 伤害减免 / 9200006 野外行军速度提高。
 * @type {number}
 */
export const EFFECT_ATK = 9200001;
/** @type {number} buff 类：伤害加深（buff_para 档位 1300/1900/3100/5000） */
export const EFFECT_DMG_DEEP = 9200004;
/** @type {number} buff 类：野外行军速度提高（即用户口径的「行军加速」，档位 2000/3000/5000/8000） */
export const EFFECT_MARCH_SPEED = 9200006;
/**
 * 默认要拿的三类（用户口径：行军加速、伤害加深、攻击增强）。
 * 面板仍可改；**全不勾 = 不限**（6 类里来者不拒，靠槽位先到先得）。
 * @type {number[]}
 */
export const DEFAULT_BUFF_EFFECTS = [EFFECT_ATK, EFFECT_DMG_DEEP, EFFECT_MARCH_SPEED];

// ────────── 可选拾取池枚举表（面板 itemlist / multiopts 数据源）──────────
/**
 * ITEM 主表名（l10n.tableRows 的 semantic，会解为 TableName.ITEM→'item'）。
 * 掉落箱物品 = type==171 行（RealPabController.checkItemNumMax 与 PabShopItem 均以 type==171 作为「秘境背包可持有物品」的牌干）。
 * 运行时 dump 实证：type==171 只有 2 行（全素香肠/豪华牛排），而资源点产出道具的 type 是 33/166/167 等
 *   → 拾取清单池 = type==171 行 ∪ rss_station 各行的 `.item`，统一按 itemId 一行。
 * @type {string}
 */
export const TABLE_ITEM = 'ITEM';
/** @type {number} 秘境背包可持有物品的 type 代号（checkItemNumMax 仅对 type==171 行判 para1_v1）*/
export const ITEM_TYPE_PAB = 171;
/** @type {string} 异能兽主表名（TableName.enigma_beast）；掉落箱宠物池 = 全表行、主键 cfgId */
export const TABLE_BEAST = 'enigma_beast';
/**
 * 异能兽物种表名（TableName.enigma_beast_type）。
 * 源码实证：enigma_beast 行**没有 name 字段**，宠物显示名 = resCfg.getTypeCommonName(cfg.type, star)
 *   → `enigma_beast_type[type].name1`（星级 < growUpStar）或 `.name2` 再过 LOCAL.getText。
 * @type {string}
 */
export const TABLE_BEAST_TYPE = 'enigma_beast_type';
/**
 * buff 效果表名（TableName 成员 EFFECTBUFF → 'effect_buff'）。
 * 源码实证：PabBuffItem.updateBuffNode 用 `getTableDataById(EFFECTBUFF, row.effect_buff)` → `.string` 作 loc 键显示 buff 名，
 *   `.value_type` 决定 buff_para 的展示口径。秘境三类增益（行军加速/伤害加深/攻击增强）即三个不同 effect_buff。
 * @type {string}
 */
export const TABLE_EFFECT_BUFF = 'EFFECTBUFF';
/**
 * 商店货表名（TableName.enigma_secret_realm_shop）。
 * 源码 verbatim PabShopItem.updateShopItem：`getTableDataById(enigma_secret_realm_shop, specId)` →
 *   字段 `id / item_id / item_num / cost / buy_times / type`（`_lastNum = max(buy_times - getTime, 0)`，
 *   `type===3` 时显示 `enigma_realm242`「本期所有商店限量」）。
 * ⚠ **本表离线无数据**（references/游戏逆向/{extracted,raw} 全查过，只有 TableName 枚举与两处 UI 引用）
 *   → **商品全量只能运行时 `l10n.tableRows(TABLE_SHOP)` 枚举**，不能写死。（specId→itemId 的已实测部分见 SHOP_SPEC_ECONOMY）
 * @type {string}
 */
export const TABLE_SHOP = 'enigma_secret_realm_shop';
/**
 * 报文反出的商店经济映射（**只能反出用户买过的 3 项**，其余必须运行时读表）。
 * 反法：对每次 8542/8543 后的 21525 背包快照做差分（两份不同日期录音交叉验证）：
 *   • specId 19 → **41011 全素香肠**，单价 41009 扣 500/件（买 10 次 → 41011 +10、41009 −5000）；
 *   • specId 16 → **41006 强异能诱饵**（8534 造点用），单价扣 3000；
 *   • specId 20 → **38006601 传奇百兽箱碎片自选箱**（×40，名字取 references/字典表.txt `item_name_38006601`），
 *     单价扣 2000、且 41009 总扣 2000 = `cost`；本项 `type===3` → **跨店共享额度**。
 *   未反出的：specId 11/12/13/14/15/17（本份录音里 getTime 始终 0 = 从未买过）。
 * @type {Object<number,{itemId:number,price:number,note:string}>}
 */
export const SHOP_SPEC_ECONOMY = {
  16: { itemId: 41006, price: 3000, note: '强异能诱饵（8534 造点材料）' },
  19: {
    itemId: 41011,
    price: 500,
    note: '全素香肠（behave[5] 投喂道具，游戏携带上限 para1_v1=10）',
  },
  20: {
    itemId: 38006601,
    price: 2000,
    note: '传奇百兽箱碎片自选箱（一次给 40 个，type=3 全店共享限量）',
  },
};
/**
 * 商店点位（用户口径「一共 4 个商店」，地图核对 verbatim：push 10018 里 `pointType===161` 的瓦片）。
 * 实测四项（dashcam 20261018T200040 + 发车会话，同一 `k=30911` 服务器）：
 *   `(95,163) id=41776`、`(250,96) id=24702`、`(315,255) id=65438`、`(154,314) id=80462`；
 *   本次用户只去了 (95,163) 与 (315,255)。**id 跨 k 稳定、坐标随图而异** → 本常量只作默认候选，
 *   **主料源必须是运行时 10018 的 161 型瓦片快照**（不要把这四个坐标当硬码）。
 * @type {Array<{x:number,y:number}>}
 */
export const SHOP_POINTS_SEED = [
  { x: 95, y: 163 },
  { x: 250, y: 96 },
  { x: 315, y: 255 },
  { x: 154, y: 314 },
];

// ─────────── 服务器拒绝原因键（pbAckV2.header.d，经 game-api sendSecret 的 Ret.reason 透传；实证 dashcam 20261011T195811 的 8527 应答）───────────
/**
 * 同一资源点内相同道具只能获取 1 次（字典表 loc 键）。
 * 游戏自己在面板侧也有同判据（实证 PabResLibraryNode.pabBagItemOperate：`checkItemIdGeted(specId)` 命中即 ShowTips(enigma_realm119)），
 *   但它要求 bagInfo 条目 `uid==me`，而 **8526 INFO 载荷的条目不带 uid** → 对 INFO 数据恒为假，只能由本 feat 自己记账。
 * @type {string}
 */
export const REJ_SAME_ITEM_ONCE = 'enigma_realm119';
/**
 * 小队尚未抵达目标点（**服务器独占**判据：客户端 pabBagItemOperate 只看限额/已领/背包上限，不查在位）。
 * 撞到即说明「点位明细已陈旧、队伍已开走」→ 该点位本轮不再发。
 * **命中的 cmd 族已实测**（dashcam 20261018T200040 / 20261011T195811）：
 *   8527×16（领资源 bag）/ 8538×2（领 buff）/ 8546×1（拍宠物投喂）/ **8521×80（行军，本份最多的一条拒绝码）**；
 *   唯独 8548（石头）从未撞过 → 「石头不要求在位」仍成立。
 * **解除信号 = push 21529 TEAM_ARRIVE**（载荷带 x,y,pointType）；8521 撞它时语义是「我正在行军、
 *   尚未到位」→ 不烧配对/区域账、不拉黑目标，只退避等到达推送。
 * @type {string}
 */
export const REJ_NOT_ARRIVED = 'enigma_realm158';
/** @type {string} 已被其他指挥官拿走（队友抢先，实证 8527 应答 57 条里 17 条） */
export const REJ_TAKEN_BY_OTHER = 'enigma_realm161';
/** @type {string} 异常操作，请再次尝试（服务器抖动的形态；实证录音 8546 被拒 13 次，重试即过 → **不拉黑**） */
export const REJ_RETRY = 'enigma_realm162';
/** @type {string} 当前已在该位置，无需行军（正常语义 → 静默处理，**不拉黑**） */
export const REJ_ALREADY_THERE = 'enigma_realm157';
/** @type {string} 目标点不能行军 → 该点当日拉黑 */
export const REJ_NO_MARCH_TARGET = 'enigma_realm163';
/**
 * 只能攻击当前所在停泊平台对应区域内的极异能兽（**服务器独占判据**：全仓客户端源码 0 引用，
 *   只会以 `s=3 d=enigma_realm142` 的拒绝形态出现）→ 撞到即说明我所在平台的 esrId 与目标 BOSS 不同区域。
 * ⚠ **未观测**：19 份录音里 **0 命中** → 本分支是「字典文案 + 客户端不查 esrId」推出来的**预防性代理**，
 *   不是实测行为（旧注释把它当实测结论写，已降级）。保留的理由：它不会错杀——真撞到只会降级那一对。
 * @type {string}
 */
export const REJ_BOSS_AREA = 'enigma_realm142';
/**
 * @type {string} 请先行军到对应区域的临时停泊平台（我不在 176 平台上，NWorldPabBossPopup.marchClick 同口径 tips）。
 * ⚠ **同样未观测**（19 份录音 0 命中）；且它本质是「本地 roomBaseInfo 滞后」，而实测 21521 一场≈17s 一条
 *   → 退一个推送周期再评的处置仍合理，但不要当已验证行为写注释。
 */
export const REJ_NEED_PLANE = 'enigma_realm141';
/** @type {string} 当前资源点内获取物品次数已用完（石头点位已领满，实证重复领同点 8548 回此码）→ 该点位永久拉黑 */
export const REJ_STONE_USED_UP = 'enigma_realm60';
/**
 * 目标点不存在，请拖动地图刷新数据并重试（字典 verbatim）。
 * **报文实证**：8527×3（dashcam 20261011T195811）——语义是「我手里的瓦片/点位数据陈旧」，
 *   与 158（人在路上）不同 → 处置应「重拉该点 INFO / 等 10018 刷新」，不能复用 158 的静默窗。
 * @type {string}
 */
export const REJ_POINT_NOT_EXIST = 'enigma_realm159';
/**
 * 战场即将封闭，请指挥官尽快选择带出秘境战场的物资（字典 verbatim）。
 * **报文实证**：8521×2（20261018T200040 / 发车那份各 1）→ 这是**收场期信号**，
 *   撞到应停掉一切行军/攻打类动作（再发只会连续吃拒），不能当普通拒绝重试。
 * @type {string}
 */
export const REJ_BATTLEFIELD_CLOSING = 'enigma_realm17';
/**
 * param error（通用参数错，字典 verbatim）。**报文实证**：8521×1 / 8527×9 / 8538×4。
 * 形态与「载荷不完整/坐标越界」一致 → 属**我们的包形态问题**信号（不拉黑目标，但要打 info 供排查）。
 * @type {string}
 */
export const REJ_PARAM_ERROR = 'common_159995';
/**
 * BOSS 已被击杀（字典 verbatim）。**报文实证**：8546×3（拍 BOSS 时撞上）→ 目标已消失，不重试、整只降级。
 * @type {string}
 */
export const REJ_BOSS_KILLED = 'enigma_realm_new_1';
/**
 * 异能兽已被捕获（字典 verbatim）。**报文实证**：8546×1 → 拍宠目标已被抢，静默换下一只。
 * @type {string}
 */
export const REJ_BEAST_CAPTURED = 'enigma_realm_new_2';
/**
 * 操作错误，请点击交互区域（字典 verbatim）。**报文实证**：8546×1 → 与「在拍闸门与服务器现场不一致」同形，
 *   不重试（重试只会撞同一堵），等 21530 刷正 capturingPetPos。
 * @type {string}
 */
export const REJ_BAD_INTERACT = 'enigma_realm_new_3';
/** @type {string} 没有参与本次战斗，不能领取奖励（`isFight!==1`）→ 该 bossId 整组跳过 */
export const REJ_NOT_IN_FIGHT = 'enigma_realm179';
/** @type {string} 该位置已有友军占用，请选择其他位置（平台 extData.teams 命中友军，NWorldPabBossPlanePopup 同口径） */
export const REJ_PLANE_TAKEN = 'enigma_realm252';
/** @type {string} 战斗已开启，暂停行军（平台 extData.isFight===1，本平台在战斗中不重派） */
export const REJ_FIGHT_ONGOING = 'enigma_realm217';
/** @type {string} 同一区域核心停泊平台之间不允许相互行军（挪台路径约束） */
export const REJ_SAME_AREA_PLANE = 'enigma_realm209';
/** @type {string} 离开后当前异能兽捕获进度将被清空，是否确定？（在拍普通宠时挪点需确认 → 自动化默认放弃本轮挪台） */
export const REJ_LEAVE_CAPTURE_CONFIRM = 'enigma_realm208';
/** @type {string} 战斗已结束（`sET > roomBaseInfo.fightEndTime/1e3`，游戏侧 cab_ui_info_065）→ 该 BOSS 放弃 */
export const REJ_FIGHT_ENDED = 'cab_ui_info_065';

// ─────────── 节奏 / 去抖调参（内置，不暴露面板）───────────
/**
 * 引擎内置调优常量。
 * @type {object}
 */
export const tuning = {
  /** 拍宠物：不在拍（capturingPetPos 未置位 / 已收尾）时的长睡（毫秒） */
  feedIdleMs: 5000,
  /**
   * 拍宠物：推送通道**存活判定窗**（毫秒）。窗内收到过任何一条 21527 就认为通道活着，事件全靠推送直达；
   *   连续静默超过本窗才启用 capturingInfo.eventSpecId 轮询兜底（防两条路对同一事件双发——
   *   两边的身份口径不同：推送是 `type:endTime`，轮询只有 eventSpecId，去重集互不认识）。
   */
  pushAliveMs: 30000,
  /**
   * 拾取：同一点位两批 GET 之间的去抖（毫秒），合并突发刷新事件、防逐拍重发。
   * 从 800 降到 250：异能井是一群人抢的，去抖窗直接叠加到首次发包延迟上（实测一帧 8526 应答 44~75ms 就回）。
   */
  pickupDebounceMs: 250,
  /** 拍宠物：免费手拍两拍之间的最小间隔（毫秒），报文实证人手连点中位 222ms，此处保守取 250（≈4 拍/秒） */
  tapIntervalMs: 250,
  /** 拍宠物：dataConfig(630027) 取不到时的每秒手拍兜底上限（与游戏 checkCaptureOperationCd 同语义） */
  tapMaxPerSecFallback: 4,
  /** 拍宠物：能量满释放（specId=4）之后的静默（毫秒），behave[4].time 读不到时的兜底；实证报文该窗口 6.4~10.2s */
  energyBurstFallbackMs: 7000,
  /**
   * 拍宠物：大BOSS 环节两次投喂道具（8546 specId 5/6）之间的最小间隔（毫秒）。
   * **实证人手节奏**（dashcam 20261018T200040，首次录到投喂包）：10 件落在 2.5s 内，
   *   逐件间隔 100/200/200/300/600ms，单件 changeScore=400（免费手拍只 6~11）。
   *   旧值 3000 是在「全库没一次投喂包」的假设下拍的保守数（注释自己标了无实证），现已有实测→ 取 200。
   *   不取 100：两件之间还夹着商店补货（香肠携带上限 para1_v1=10）与手拍，留一档余量防吃频控。
   */
  bossFeedGapMs: 200,
  /** 拾取：被拒 dropId 的当日拉黑存活（毫秒），过期后允许再试（防永久误拉黑） */
  rejectBlacklistMs: 6 * 3600 * 1000,
  /**
   * 拾取：相邻两条 GET 的最小间隔（毫秒）——流水线发送的节拍初值。
   * 必要性实证（dashcam 20261011T195811）：次通道 NetMgrSimple.send 有**按 cmd 的 MsgIdSettings.cdTime 频控**，
   *   命中即 `return !1` 不上线也不报错；门面 TMWatchNetMgr.sendPBV2 **无 return**（verbatim）→ 我们拿不到那个 false，
   *   只能靠超时感知。实测同一轮里 44~75ms 的连发全部没应答（8527：9 req / 5 resp），串行 await 把它们空等满
   *   15s → 一个点位吃 62s。取 250ms 既避开已知拦截区（>75ms）又不白等。
   */
  getGapMs: 250,
  /** 拾取：被拦（未上线）时自适应翻倍的上限（毫秒），避免把频控窗越撞越密 */
  getGapMaxMs: 2000,
  /**
   * 拾取：连续成功时节拍回落的步长（毫秒），每中一条向 getGapMs 靠近一档（撞拦→退避→再试探的循环）。
   */
  getGapStepMs: 100,
  /**
   * 拾取：点位载荷的**最长可用年龄**（毫秒）。超出即作废整批，不再拿陈旧明细发 GET。
   * 必要性：旧实现一个点位吃 62s，队伍早开走了还在发 → 撞 8527 `s=3 d=enigma_realm158`「小队尚未抵达目标点」；
   *   而客户端有坐标级在位判据（roomBaseInfo 带 `startPoint`/`targetPoint`，实证 21521 载荷 +
   *   NWorldPabCommonPopup.marchClick 就用 `startPoint.x!==tileX` 判「已在该点」）→ 时效只作兜底，主判据见 #tileGate。
   */
  staleMaxMs: 6000,
  /**
   * 拾取：撞 158（小队尚未抵达目标点）后该点位的**静默时长**（毫秒）。
   * 不拉黑 rId（回队重试还能拿）但短时间不再发；取 60s：同一轮里不会马上又到达同一点。
   */
  tileDeadMs: 60000,
  /**
   * 拾取：掉落箱 DROP_INFO 配对队列的**兜底档**存活窗口（毫秒）——只在应答拿不到 reqTime 时才用它。
   * 主路径是按 reqTime 精确配对（core/net.js Event.reqTime = 该应答那条请求的发出时刻），不需 TTL；
   *   本窗口仅在兜底时生效，取 5s 而不再给 20s：实证应答 1~2s 回，窗开得宽只会把错配窗口一起放大。
   */
  dropPairTtlMs: 5000,
  /**
   * 拾取：待配对坐标队列上限。溢出**不是丢最旧而是整窗作废**（连点面板时 FIFO 已不可信，
   *   留着半队坐标去猜只会把错点写进 DROP_GET，被拒后还会误拉黑本来能拾的 dropId）。
   */
  dropPairQueueMax: 8,
  /**
   * 拾取：「本会话在该点位已拿到/已发过」账的点位条数上限（Map 保持插入序，溢出丢最早一点位）。
   * 必要性：8526 RESOURCE_INFO 的 bagInfo 条目**不带 uid**（实测 keys 仅 dropId/specId/likeUids）→
   *   游戏侧「我已领」判据对 INFO 载荷完全失效，只能由本 feat 自己按点位记账（否则撞 8527 s=3 d=enigma_realm119）。
   */
  tileAccMax: 32,
  /**
   * 治疗：无伤（或无可用道具）时的扫描间隔（毫秒）。
   * 8584 是一个「拉全编队血量」的查询包，没伤也不需要频；实测游戏弹层只在玩家开窗时才发。
   */
  healScanMs: 4000,
  /**
   * 治疗：相邻两次动作（8584 快照 / 8534 用道具）的最小间隔（毫秒）。
   * 实证人手链路：8534 成功后 0.5~0.6s 游戏自己补一条 8584（弹层刷新）→ 取 600 与之一致。
   */
  healGapMs: 600,
  /**
   * 治疗：快照的**最长可用年龄**（毫秒）。超出即作废重拉 —— 血量会被战斗实时改掉，
   *   拿陈旧快照决定给哪支军队用道具属于「拿旧数据发写请求」（与拾取的 staleMaxMs 同理）。
   */
  healStaleMs: 6000,
  /** BOSS：状态机重扫间隔（毫秒）。21535/21521 都是 kick 唤醒源，本值只作推送漏拍的兜底 */
  bossScanMs: 2000,
  /** BOSS：一次 8521 发出后等待 21521 刷新的**确认超时**（毫秒）；实测小BOSS 一轮 4.3s、大BOSS 一轮 8s */
  marchConfirmMs: 8000,
  /**
   * BOSS 攻打：任一 `s≠0` 被拒后的**最小静默**（毫秒）。
   * 必要性：本地闸门是 `pointType===176 + marchState===ARRIVED`，而「本地态与服务端态不一致」正是 141 的定义
   *   → 被拒那一刻本地闸已不可信；又因「一拍只发一枪 + 应答几十毫秒就回」，没有退避就会把被拒的写请求
   *   打成 ≈5 条/秒的风暴（与拾取侧「自动化撞限额的目标当日拉黑，防止逐拍重发刷屏」同一口径，只是攻打
   *   不能拉黑 bossId：区域是服务器独占判据，见 boss.js 文件头 §③）。
   */
  rejectBackoffMs: 5000,
  /**
   * BOSS 攻打：撞 141（服务端认为我不在 176 平台上）后的专用静默（毫秒）——等 push 21521 把 roomBaseInfo 刷正。
   * 取 15000：实测 21521 一场 239 条 ≈17s 一条（行军状态变化时补发，但被拒这一路没有行军可触发），
   *   给一个「≈一条推送周期」的窗；用通用 5s 会在刷正前多撞两枪。
   */
  planeRefreshMs: 15000,
  /**
   * BOSS 攻打：「近区候选」的判定半径（欧氏格数，与 #platformCandidates 同口径）。
   * 实证（全库 15 份秘境录音的 10018 的 176 平台 `m.esrId` × 21535 的 bossBaseInfo.pos 对账）：
   *   每只 BOSS 到**它自己区域**平台最近 1.4~7.1 格（boss9 2.0 / boss10 1.4 / boss11 7.1 / boss12 2.0），
   *   而到**跨区域**平台最近 19.8~63.9 格 → 12 落在两档实测值的空档里。
   *   注意这是**排序档而不是过滤闸**（远档仍留在队尾，否则近处全被区域闸拦下时我们会罢工），
   *   真正的判据仍是服务器的 esrId 比对；本档的作用是把「同一平台上该先撞哪一枪」从试探改成就近，
   *   避开 142（竞对脚本用的就是纯就近排序，无 esrId 配对）。
   */
  bossNearRadius: 12,
  /**
   * 拾取：掉落宠物的**品质筛选阈值**（enigma_beast 行 `quality`，低于它的不占配额）。
   * 借鉴竞对口径（他写死 >=4）；读不到行或行无该字段一律放行（fail-open，不把低品质当高品质拦死）。
   */
  dropPetQualityMin: 4,
  /** 石头：相邻两条 8548 的节拍初值（毫秒），沿用 getGapMs 同曲线退避 */
  stoneGapMs: 250,
  /** 石头：同一 bossId 撞 `isFight!==1`（未参战）后的组级静默（毫秒）——不可恢复，但防改版后变成可领时永久锁死 */
  stoneSkipMs: 600000,
  /** 瓦片 extData 快照的条目上限（Map 保持插入序，溢出丢最早一项；与 tileAccMax 同手法） */
  tileExtMax: 256,
  /**
   * 商店：相邻两条 854x 的最小间隔（毫秒）。沿用次通道频控同口径（getGapMs 250）：
   *   实证人手就是 250ms 量级（dashcam 20261018T200040：8542→8543 平均间隔 1.0~1.3s，但那是人在选数量）。
   */
  shopGapMs: 250,
  /**
   * 商店：同一店两条 BUY 之间的额外静默（毫秒）。
   * 必要性：BUY 无坐标、应答只回 `{items}`，**多店轮巡时同拍两笔会串号**（req↔resp 靠 reqTime 配对能分清身份，
   *   但服务器侧「上一笔未结算」形态实测会出 enigma_realm162）→ 串行 + 小静默。
   *   实施点：shop.js 以 #lastBuyEndAt（上一笔 8542 应答落地时刻）在 #tick 夹住下一笔动作。
   */
  shopBuyGapMs: 600,
  /**
   * 商店：进图后首次扫商店的延迟（毫秒）。太早会撞上玩家自己的操作窗（面板也发 8540，会互刷 getTime 基准）。
   */
  shopFirstDelayMs: 15000,
  /**
   * 商店：两次完整轮巡（4 个点位逐个 8540）之间的最小间隔（毫秒）。取 10 分：
   *   实证人手一局只在 +1975s / +2525s 进了两次店（间隔 550s），补货不是高频动作。
   */
  shopSweepMs: 600000,
  /**
   * 攻击警告：判定「我确实被盯上」的**连续存活窗**（毫秒）。21534 实测 591 条里 525 条是 0（频繁跳变），
   *   单条 num>0 就转走会把玩家自己“手操撤离”变成抽风；本窗内无新的 num>0 即认为警报解除。
   */
  warnAliveMs: 8000,
  /**
   * 攻击警告：转点后的**再评估静默**（毫秒）。转移本身要 31~44s（实测一整套 8521→采集→8526 闭环），
   *   且 8521 在行军途中必吃 158×80 的教训在这里同样适用 → 不到达就不重评。
   *   取 45000：比实测闭环上限（44.2s）多一档。
   */
  warnMoveCooldownMs: 45000,
  /**
   * 攻击警告：转移引擎的空闲轮询兑底（毫秒）。用户档定为「num>0 立即转移」（不做存活窗去抖），
   *   故触发主要靠 push 21534 事件 kick；本值只用于「警告挂起但快照里暂无就近营帐」时的重扫间隔。
   */
  warnScanMs: 3000,
  // ── 自动驾驶（drive.js）──
  /**
   * 驾驶：状态机空闲轮询兜底（毫秒）。kick 源是 21534/21529/21535/21521（10018 只写快照不 kick），
   *   本值只兜「推送漏拍 + 驻留/冷却计时到点」的重评节奏。
   */
  driveScanMs: 5000,
  /**
   * 驾驶：一笔 8521 发出后到 21529 到达推送之间的**确认超时**（毫秒）。
   * 实测一整套开车闭环 31~44.2s（dashcam 20261018T200040），取 90s 给两档余量；
   *   超时即放弃该目标记消费转重评（防「目的地永远到不了」把状态机锁死在 TO 相位）。
   */
  driveMarchTimeoutMs: 90000,
  /**
   * 驾驶：到点 WORK 相位的**固定驻留时长**（毫秒），驻留满即记消费走人。
   * 现仅用于「无采集进度信号」的点（BOSS 平台 176 让 boss.js 打仗、其余非资源/掉落点）；
   *   资源点 173 / 掉落箱 163 改走「拿空即走」（driveEmptyDwellMs + driveWorkMaxMs），不再吃本值。
   *   取 45s：覆盖实测到点后 BOSS 攻打/一整套采集闭环上限 44.2s（dashcam 20261018T200040）。
   */
  driveWorkDwellMs: 45000,
  /**
   * 驾驶：**资源点/掉落箱「拿空」后**再多驻留的 settle（毫秒，面板可配，可 0=拿空立即走）。
   * 拿空判据有**两路料源任一命中即走**（见 drive.js #isTileEmpty）：
   *   ① 过渡路（独立订阅 21522/21532 按点记账，零耦合 pickup）：173 bag 空闲==0 且 buff 空闲==0；163 drop 空闲==0 且 beast 空闲==0；
   *   ② 当前态路（读 10018 快照，到点即判，解决「到点前已被别人采空、之后无人再碰→无 CHANGE」的死等）：
   *      173 `m.rTime` 落在未来=井已被抽空（rTime 只覆盖 bag，若 CHANGE 显示 buffFree>0 则不据此判空）；163 `m.iNum`==0=无可拾条目。
   *   报文实证 dashcam 20261004T202430 / 20261018T200040（三份完整录像交叉：大量 173 首帧视口即带 rTime 且本队从未采集）。
   */
  driveEmptyDwellMs: 0,
  /**
   * 驾驶：**商店到店驻留**（毫秒，面板可配）。到店后 shop.js 逐行补货（8540/8542/8543），
   *   驻留满即离店；与「大BOSS 前定点勤务」和 reactive 补货共用本值。默认 25s。
   */
  driveShopDwellMs: 25000,
  /**
   * 驾驶：资源/掉落点「拿空即走」的**安全兜底上限**（毫秒，不露面板）。
   * 到点判空已有两路（CHANGE 过渡 + 10018 当前态 rTime/iNum），「到点即空」由当前态路当拍即判即走、不吃本值；
   *   本上限只兜「两路都探不到拿空」（真满载且我们的拾取清单拾不完、或快照与 CHANGE 双缺）的极端形态，防死守。
   */
  driveWorkMaxMs: 45000,
  /**
   * 驾驶：消费点（去过的资源/掉落/商店点）的**解禁 TTL**（毫秒）。
   * 取 10 分钟：与资源点 refreshTime 的刷新量级、商店轮巡 shopSweepMs 同档（补货不是高频动作）；
   *   过期后允许重去（资源点会刷新、商店额度会回补），防「快照里的点被一次性烧完」后永久罢工。
   */
  driveConsumedTtlMs: 600000,
  /**
   * 驾驶：**大BOSS 前定点商店勤务**的触发时刻（相对整场 `fightBeginTime` 的秒数组）。
   * 报文实证（20261004T202430 / 20261011T203911 / 20261018T200040，同 UID）：整场 fightEnd−fightBegin=3300s(55min)；
   *   小BOSS 攻打窗开 ≈ +1380s(23min)、**大BOSS 攻打窗开 ≈ +2400s(40min)**（两份独立录像吻合）。
   *   三只 BOSS 在 0~23min 全是 state22（不可开打）→ 这段是纯巡航空档，把「大BOSS 前必去的一趟商店」办掉最安全。
   *   取 [600,900,1200]（10/15/20min）：任一时刻命中即发 8521 去就近 161，未真上线则每拍重试、天然覆盖后两点，
   *   到店（进 WORK）即置本场勤务完成、不再重复；late-entry（elapsed 已过 20min）也会立刻触发。
   * @type {number[]}
   */
  driveShopPointsSec: [600, 900, 1200],
};

/** @type {number} 未真正发出的哨兵码（sendSecret 超时/异常回此值；与 game-api SECRET_NOT_SENT 同义） */
export const CODE_NOT_SENT = -1;
