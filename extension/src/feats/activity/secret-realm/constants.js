/**
 * 异能秘境（Pab / 字典 enigma_realm01）feat 私货常量：协议号、PAB 实体类型、DataConfig 键、
 * EventCenter 事件名、拍宠物投喂行映射与节奏调参。均为「服务器↔客户端契约 + feat 调参」，
 * 不下沉 core（core/game-api.js 只收口运行时游戏符号名，此处是报文线路格式与玩法参数）。
 *
 * 线路契约：秘境 req 走未 hook 的 watch 独立 socket（TMWatchNetMgr.sendPBV2），resp 回主 NetReciver；
 *   req 载荷形态取自游戏源码（PabRewardBoxNode / PabResLibraryNode / RealPabController /
 *   PabPetCaptureNodeNew / NRequestIdV2）。
 * 两条读法口径：
 *   • push 10018 PUSH_TILEINFO 是**视口增量**、不是全域快照——「快照里没有某点」只代表镜头没扫到，不能当反证；
 *   • `enigma_realm142 / 141` 是「字典 + 源码文案」推出来的**预防性分支**（客户端不查 esrId，区域只在服务器判），
 *     命中时只降级那一对 (esrId, bossId)，不会错杀。
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
 * 攻打 boss12@(230,234) 实际发的是 `8521 {x:230,y:234}`（起点必须是同区域平台），
 *   游戏侧入口 RealPabController.sendToBuildingMarch = `checkRequestIdNoRes(8521) || sendPBV2(8521,{x:e,y:t},…)`。
 * 在位闸：`isCanMarch() = !!roomBaseInfo && teamIsMooring()`，而
 *   `teamIsMooring() = !roomBaseInfo || marchState ∈ {ARRIVED(2), FIGHTING(12), PAB_FEED(21)}`（ACL 已包 teamIsMooring）。
 * 被拒是常态，不是零拒绝：158×80「小队尚未抵达」/163×3「目标点不能行军」
 *   /17×1「战场即将封闭」/common_159995×1「param error」。
 * @type {number}
 */
export const CMD_MARCH_MOVE = 8521;
/**
 * ENIGMA_SECRET_ROOM_POINT_INFO：拉某点位驻军明细（req `{x,y}` → `{type, teams:[{teamId,sid,aid,allianceTag,playerNum,power,leaderPlayerInfo,…}]}`）。
 * 游戏侧入口 RealPabController.requestBuildingTeamsInfo；它是面板「前往」按钮的前置查询：
 *   `8522{x,y} → 8521{x,y}` 同点配对 **131 组、延迟 0.5~1.0s**（个别 1.7/5.5s）→ 人工点流就是「查驻军 → 点前往」，
 *   自动开车可直接复刻这一对（不需要猜）。
 * @type {number}
 */
export const CMD_POINT_INFO = 8522;
/**
 * ENIGMA_SECRET_ROOM_BAG_USE：使用秘境背包道具（req `{info:{itemId,itemCount}, marchId}`）——编队治疗的动作口。
 * 游戏侧入口 NWorldPabTeamSelfItem.useItem；同一会话里 `itemCount` 恒为 1、marchId 是 8584 应答里那个
 *   Int64 对象的原样回传（`{_low,_high,_unsigned}`），不 Number 化、不转字符串。
 * @type {number}
 */
export const CMD_BAG_USE = 8534;
/**
 * ENIGMA_SECRET_ROOM_SHARE_BAG_USE：共享背包版（载荷同上，多一个 `pabBagItemUse(itemId,share,marchId,…)` 分叉）。
 * 源码侧证（RealPabController.pabBagItemUse：`t ? SHARE_BAG_USE : BAG_USE`）；治疗只用私有背包，本键留档不接入。
 * @type {number}
 */
export const CMD_SHARE_BAG_USE = 8535;
/**
 * ENIGMASECRET_ROOM_BOSS_RANK：BOSS 伤害榜（PabWorldUINew 每 5s 拉一次，排行面板料源）。
 * 注：成员名游戏侧就漏了下划线（`ENIGMASECRET_ROOM_BOSS_RANK`），不是笔误。
 * @type {number}
 */
export const CMD_BOSS_RANK = 8544;
/**
 * ENIGMA_SECRET_ROOM_BOSS_GUARD_REWARD_INFO：小BOSS 石头奖励的主动查询口。
 * **客户端全仓 0 调用方**（石头账本全靠 push 21539 下发）→ 只登记，不接进链路。
 * @type {number}
 */
export const CMD_BOSS_GUARD_REWARD_INFO = 8547;
/**
 * ENIGMA_SECRET_ROOM_BOSS_GUARD_REWARD_GET：领取一颗石头（req `{x,y}`，**不带 bossId**，服务器按坐标反推）。
 * 游戏侧入口 requestBossGuardRewardGet；领石头点 (230,228) 时队伍可停在平台 (237,229)。
 *   → **不要求队伍站在石头点位上**（与采集/拾取族的 158「小队尚未抵达」不同：158 会出现在 8527/8538/8546/8521
 *   上，从不出现在 8548；8548 的拒绝码只有 enigma_realm60「获取次数已用完」）。
 * @type {number}
 */
export const CMD_BOSS_GUARD_GET = 8548;
/**
 * ENIGMA_SECRET_ROOM_SHOP_INFO：拉某商店点位货单（req `{x,y}` → `{items:[{specId,getTime}], readyList:[{uid,playerInfo(JSON 字符串),ready}]}`）。
 * 9 个货位恒为 `specId ∈ {11,12,13,14,15,16,17,19,20}`（**18 缺席**，多会话一致）；
 *   **应答不带 x,y** → 点位身份只能从 req 侧取，req↔resp 按 `Event.reqTime` 配对。
 * ⚠ **本查询会把本店的非 type3 货位 `getTime` 归零**（同一店 19:1 → 再发一次 8540 → 19:0）：
 *   所以「还能买几次」只能以**本次应答为基准**做增量，不能拿上一次应答的 getTime 当现状。
 * @type {number}
 */
export const CMD_SHOP_INFO = 8540;
/**
 * ENIGMA_SECRET_ROOM_SHOP_READY_CHANGE：商店集合就绪开关（req `{x,y,ready:0|1}`）——**与补货无关**，
 *   是面板上的「我已就绪」勾选（PabShopPanel.onReadyToggleClick，应答侧对应 `readyList[{uid,ready}]`）。
 *   游戏侧只在玩家勾选「我已就绪」时发 → 本 feat 不代点，只登记防误用。
 * @type {number}
 */
export const CMD_SHOP_READY_CHANGE = 8541;
/**
 * ENIGMA_SECRET_ROOM_SHOP_BUY：买一件（req `{specId,num}`，**无坐标** → 商店身份由服务器自持）。
 * 请求形态：`{specId:19,num:1}` / `{specId:16,num:1}` / `{specId:20,num:1}`；应答只带新的 `{items}`。
 *   `getTime` 语义 = **该 specId 已购次数**：BUY → +1；REFRESH → 归零（非 type3）。
 * @type {number}
 */
export const CMD_SHOP_BUY = 8542;
/**
 * ENIGMA_SECRET_ROOM_SHOP_REFRESH：刷新货单额度（req `{x,y}`）——**额度用完后唯一的重开手段**。
 * 每次恰好扣 **1 个 41010 人造水晶**（余量 10→9→…→1），
 *   且只把**非 type3** 货位的 getTime 归零（19:1 →刷新→ 19:0，而同拍 type3 的 20 仍为 20:1）。
 * 源码 PabShopPanel.onRefreshClick：余量 < `_shopRefreshCost`（dataConfig 3029）即 tips enigma_realm74 开不了口。
 * @type {number}
 */
export const CMD_SHOP_REFRESH = 8543;
/**
 * ENIGMA_SECRET_ROOM_MARCH_ARMY_INFO：拉编队各支军队的血量（req `{uid}`，**uid 是字符串**）。
 * req = `{"uid":"14913381732485"}`；resp = `{playerInfo, infos:[{armyPower,maxArmyPower,power,marchId:{_low,_high,_unsigned},heros,armys}]}`。
 * 源码 NWorldPabTeamSelfPopup.updateView，且治疗成功后游戏自己会再发一条（报文里 8584↔8534 严格交替、间隔 0.5~0.6s）。
 * @type {number}
 */
export const CMD_MARCH_ARMY_INFO = 8584;
/**
 * ENIGMA_SECRET_ROOM_ATTACK_SELF_TEAM：「谁在打我」的**只读查询**（req `{uid:String(UID)}` → `{fightTeams[],waitTeams[]}`）。
 * 源码（由攻击警告弹窗调用），玩家不开面板就不发；
 *   → 不能拿它当「有攻击警告」的价判据（计数只看 push 21534），它只能当「按需拉详情」的候选料源。
 * @type {number}
 */
export const CMD_ATTACK_SELF_TEAM = 8549;
/**
 * ENIGMA_SECRET_ROOM_CALL_HELP：求援（req `{uid:String(UID)}` → resp `{x,y}`）。
 * 源码：**不是战斗动作**，而是拿应答坐标拼 `ELEMENT_MONSTER+",-1,"+viewId` 向联盟频道发一条
 *   CHAT_PAB_ALLIANCE 链接消息 + tips enigma_realm218 → 「抗争到底」档若开求援就是一条聊天，需按聊天侧规范走。
 * @type {number}
 */
export const CMD_CALL_HELP = 8551;
/**
 * ENIGMA_SECRET_ROOM_REVIVE：战败复活（req `{uid}`，`ok===1` 后游戏 `jumpToTarget(roomBaseInfo.startPoint)`）。
 * 消费口在战败面板 PabWorldDefeatPanel（tips enigma_realm198 带 reviveNum+1）。本 feat 在自动驾驶下
 *   代答一条 8552（判据 `deadType==1 && dataConfig(3056) > reviveNum`，见 pilot.js #maybeRevive）——
 *   系统默认行为（无面板子闸），受 `driveReviveGapMs` 限速 + 上限读不到/为 0 一律不发 两重约束。
 * @type {number}
 */
export const CMD_REVIVE = 8552;
/**
 * ENIGMA_SECRET_ROOM_LEAVE：退出 BOSS 战区（req `{uid:UID+""}`，`ok===1` 后游戏 `pabFightQuit()`）。
 *：`baseActivityInfo.type===1 && isPABServer()` 时额外 `leaveObserve()+purge()+emit(UPDATE_PAB_SELF_ATTACK,0)`；
 *   未选完 options 时 tips enigma_realm203。**整场退出、不是「换个点」** → 不作为「立即转移」手段。
 * @deprecated 二轮收口废弃拿满自动离场（leave.js 已删）：停止读取，键保留供旧录制对拍/注册表兼容。
 * @type {number}
 */
export const CMD_LEAVE_AREA = 8589;
/**
 * ENIGMA_SECRET_ROOM_BAG_GET_SET：撤离前**选定带出内容**（req `{itemIds:[], uuIds:[宠物id]}`）。
 * 用法：把 `roomBagInfo.beastInfo` 按品质降序取前「背包容量」只的
 *   `id`（protobuf Int64）填进 `uuIds`、`itemIds` 留空，`ok===1` 后才发 8589 LEAVE → 它是「只带最好的走」的预选项，
 *   不是背包写入（配合 21521 段 `roomBagInfo.backItemIds/backBeasts` = 撤离带出选择结果）。
 * ⚠ **8581 的线路形态只有源码级依据**（游戏侧那条自动离场路径不由本 feat 走），逐键形态未经报文核对，
 *   且宠物清单键 `beastInfo` 未实机确认存在。
 * @deprecated 二轮收口废弃拿满自动离场（leave.js 已删）：停止读取，键保留供旧录制对拍/注册表兼容。
 * @type {number}
 */
export const CMD_BAG_GET_SET = 8581;
/**
 * ENIGMA_SECRET_ROOM_BEAST_INFO：查某野怪点（172）的异能兽信息（req `{x,y}`）。
 * 应答逐键形态：
 *   • 侦察**前** 8536 应答 = `{beastType,pveId}`（**无 beastId**）——即点上有兽、但品质未知；
 *   • 侦察**后**再发 8536 应答 = `{beastType,pveId,beastId}`（beastId = enigma_beast 主键，可查 quality）。
 *   → 「应答带不带 beastId」就是「本点是否已侦察」的**免费**判据（不花道具即可复用他人/自己已侦察结果）。
 * @type {number}
 */
export const CMD_BEAST_INFO = 8536;
/**
 * ENIGMA_SECRET_ROOM_BEAST_SCOUT：勘察某野怪点（172），**每次消耗 1 个 41001 全地形勘察车**（req `{x,y}`）。
 * 源码 NWorldPabElementMonsterPopup.spyonClick：`getItemNumById(41001)<=0 ? ShowTips('101064') : sendPBV2(8537,{x,y})`；
 *   道具身份：ITEM["41001"] 为该 popup 的勘察花费图标、`spyonCostLab="-1"`（每次扣 1）。
 * 8537 应答 = `{beastType,pveId,beastId:39}`（比 8536 侦察前多一个 beastId）。
 * ⚠ 41001 是消耗品（可从秘境产出拾取，非商店货）→ 侦察侧必须先 8536 免费预检、仅对「未侦察且道具充足」的点花道具；
 *   消费口见 scout.js，读不到现场/道具不足一律不发（fail-safe）。
 * @type {number}
 */
export const CMD_BEAST_SCOUT = 8537;

// ─────────── 秘境推送号（走 watch 通道下行，主 NetReciver 汇聚后由 core/net.js 派 `net.<cmd>`）───────────
/**
 * ENIGMA_SECRET_ROOM_BEAST_EVENT：捕获事件（拖拽 / 心动时刻投喂弹窗）下发。
 * 载荷 `{type, specId[], endTime(Int64 毫秒), points[]}`。
 * **推送不会被游戏写进 capturingInfo**：8546 应答回写的 feedInfo 只有这些键
 *   `allFavor/selfenergy/endTime/stateEndTime/nowFavor/selfFavor/eventSpecId/eventRatio`——
 *   **没有 eventType、也没有 eventEndTime**（8546 应答逐键）；
 *   而 `eventSpecId` 会在 feedInfo 上连续挂十几秒，**不能当事件身份**
 *   → 只能作轮询兜底的候选来源（见 capture.js #pollEvent）。
 * @type {number}
 */
export const PUSH_BEAST_EVENT = 21527;
/**
 * ENIGMA_SECRET_ROOM_FEED_BEAST：**「正在拍哪只宠物」的唯一真相**下发。
 * 载荷 `{x,y[,boss:1]}`，结束推 `{x:-1,y:-1}`；游戏 Handler 就一句
 *   `PabController.getInstance().capturingPetPos = o.data` + emit PabPetCaptureStateUpdate。
 * 在拍窗口与拖拽推送同源：每条 type=2 拖拽推送都落在 capturingPetPos 的在拍窗口内，
 *   且每个已收窗都有明确的 `{x:-1,y:-1}` 结束推送 → 收尾不靠「已喂满」估计。
 * ⚠ 窗口起点不保证带 feedInfo → capturingInfo 可能是上一只残留，不能拿它做在拍闸门。
 * **BOSS 走同一条推送与同一个闸门**（boss:1 的窗内手拍/拖拽/能量拍 specId 集与普通宠一致）→ 自动拍不为 BOSS 分叉。
 *   游戏 UI 侧每 10s 用它自愈（PabWorldUINew.updateCapturingData：瓦片 extData.state 不是
 *   PabFightStageState.FEED(5)/BOSS_FEED(23) 时把 capturingPetPos 打回 {x:-1,y:-1}）。
 * 本 feat 订阅它，但不拿它做闸门（闸门是直接读游戏现场的 `pab.capturingPetPos`，开局前已在拍也能立刻识别）：
 *   只用它识别换宠/收尾（清上一只残留的静默窗 + 打一条 info 供实录对账）。
 * @type {number}
 */
export const PUSH_FEED_BEAST = 21530;
/**
 * ENIGMA_SECRET_ROOM_BASE_INFO：**roomBaseInfo 全量快照**下推（载荷 `{info:{teamId,leaderUid,marchState,startPoint,pointType,targetPoint,fightEndTime,buffMap,members[…powerInfos],…}}` 共 24 键）。
 * 一场约 239 条 ≈ 每 17s 一条 + 行军状态变化时补发 → **稀疏，不能当唯一唤醒源**，只用作现场校验与 Int64 料源。
 * `startPoint` 是**当前所在点**（ARRIVED 时 sp==tp），行军四段式见 boss.js 文件头。
 * `marchState` 的全枚举 `NMarchState`（Script 侧，共 20 项）：
 *   INIT 0、MARCHING 1、ARRIVED 2、RETURNING 3、ARRIVED_HOME 4、GATHERING 5、ENCAMPING 6、RALLY_ASSEMBLING 7、
 *   RALLY_ASSEMBLED 8、REINFORCING 9、GARRISON 10、OCCUPY 11、**FIGHTING 12**、BATTLING 13、WAITINGRETURN 14、
 *   BEHEMOTH_MONSTER_ATTACK 15、EXPLOREING 18、GVE_ARRIVED 19、CROSS_TREASURE_TEAM_HOLDING 20、**PAB_FEED 21**、
 *   ACTIVITY_GATHERING 22、PAUSED 23。
 *   → 秘境侧只会出现 1（行军中）/ 2（到达）/ 21（在拍）；其余值列出以防误把 12 当未知值。
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
 * **`stateEndTime` 是 Int64 毫秒**（例：417×2^32+1243037568 = 1792244400000），语义是
 *   「**当前阶段**结束时刻」：state22 时它等于转 21 的时刻（boss9 set=1792244400 与翻转时刻对齐）、
 *   state21 时是战斗窗口结束（boss11/12 +420s、boss9 +600s）。
 * 一场只推 5 条（+37.6 全 22 → +1139.1 先 12/11 同时进 21 → +2159.1 boss9 进 21且 11/12 转 28 → +2303.4 boss9 转 30）
 *   → 稀疏，BOSS 引擎只拿它当 kick 源，业务态重读 ACL getBossBaseInfo()。
 * @type {number}
 */
export const PUSH_BOSS_STATE = 21535;
/**
 * ENIGMA_SECRET_ROOM_BOSS_GUARD_REWARD_INFO_PUSH：小BOSS 石头点位账本（**全量**下发）——**「能不能领」的唯一判据**。
 * 载荷 `{rewardInfo:[{bossId,fightTime:Int64,rewardInfo:[{pos{x,y,k,rid},rewardNum,rewardMaxNum,isFight}]}]}`；
 *   游戏 Handler：`bossGurardRewardInfo = a.rewardInfo`（源码拼写就是 Gurard）+ emit UPDATE_PAB_BOSS_GURARD_REWARD。
 * 时间线：初始 `0/0` 无 F → 参战后 `0/0F` → **账本给点时 `0/1F`** → 逐点 8548 → `1/1F`；
 *   **每个小BOSS 固定 5 个点位、每人每点位限领 1 次**（rewardMaxNum 只到 1）。
 * ⚠ 石头**不是「小BOSS 死后掉落的石头」**：
 *   boss12 仍 `state:21`（21535 里未收场）时就已经能领它那 5 个点 →
 *   **石头能不能领只能看本账本（`rewardNum<rewardMaxNum && isFight===1`），不能拿 BOSS 死亡/state 做前置条件**。
 * @type {number}
 */
export const PUSH_BOSS_GUARD_REWARD = 21539;
/**
 * ENIGMA_SECRET_ROOM_BOSS_FEED_OTHER_VIEW_INFO：大BOSS 投喂阶段的他人视图（载荷含 `pos` + `infos[]`）。
 * 一场共 76 条、最早 t+2227.3（比 boss9 进 state21 晚约 68s）、pos 恒 (203,203)；
 *   本推送未覆盖大BOSS 拍宠阶段（state=23）的切换，该阶段形态见 ST_BOSS_FEED 注。
 *   只登记留档，链路未接入。
 * @type {number}
 */
export const PUSH_BOSS_FEED_VIEW = 21540;
/**
 * PUSH_TILEINFO（NResponseIdV2）：世界/秘境地图的**视口内瓦片增量刷新**下推，秘境图内载荷逐条形如
 *   `{v,x,y,k,id,pointType,m:{viewId,sET,sBT,teams[],esrId,state,iNum,bid,camp,isFight,fTeamIds,…}}`，
 *   `m` 即 extData（单场 7733 条 ≈ 3 条/秒，密度随视口变化）。
 *   **这是 BOSS 攻打侧取「平台↔区域配对键 esrId」与自动开车侧取「资源点档位 iNum / 在试点 state」的唯一本地料源**：
 *   ACL 不提供瓦片查询（游戏侧 tile getter 的调用方式未知，不猜符号链），引擎直接订阅本推送自己按 `x,y` 建快照。
 * ⚠ **本推送是「进视口才推」的增量，不是全域快照**：
 *   镜头没到那块区域就一条不会有 → 「快照里没有某点」不等于「该点不存在」，只能当「无证据」、不能当反证。
 * `m.state` 的口径是 **PabFightStageState**（不是 NMarchState）：游戏侧 WIPabResource.updateTileState 对
 *   `state===11||12` 走 `getRoomPointFightingPVPInfoByXY` + dataConfig(3018) 算战斗倒计时（tips enigma_realm110/139）
 *   → **瓦片 state 11/12 就是「本点正在被 PVP」的本地判据**（攻击警告侧的点位级证据）。
 * @type {number}
 */
export const PUSH_TILE_INFO = 10018;
/**
 * ENIGMA_SECRET_ROOM_TEAM_ARRIVE：行军到达目标点的推送（载荷 `{x,y,pointType}`）。
 * 在开车闭环里的位置：
 *   `8521{x,y}req → 10007(state1) → 8521 resp{ok:1} → 8522{x,y}req → **21529{x,y,pointType}** → 10007(state2→12)
 *   → 8522 resp{type,teams[]} → 21522 RESOURCE_CHANGE → 8527{rId}×N → 8526/8532 → 下一条 8521`（单轮 +31~44.2s）。
 *   → **它是「已到达」最及时的信号**，也是 8521 撞 `enigma_realm158`（小队尚未抵达）的唯一解除信号。
 * @type {number}
 */
export const PUSH_TEAM_ARRIVE = 21529;
/**
 * ENIGMA_SECRET_ROOM_MARCH_INFO：**行车记录**下推（玩家地图上的行军线就靠它）。
 * 载荷：`{marchArrive, lv, returnStartTime, target:{itemId,tx,ty,tk,w,h,targetType}, marchType,
 *   marchStartTime, returnArriveTime, marchIcon, state, marchId:"字符串", aid, begin:{bx,by}}`；
 *   `state` 取 1（行军）/2（到达）/12（交战）；资源点目标 `target.itemId=15`、`target.targetType` 即目标 pointType。
 *   → 「自动开车」的进度料源（不必等 21521 那 17s 一条的稀疏快照）。
 * @type {number}
 */
export const PUSH_MARCH_INFO = 10007;
/**
 * ENIGMA_SECRET_ROOM_SELF_ATTACKED：**「有多少队正在打我」的计数**下推（载荷仅 `{num}`）。
 * 游戏侧链路：`PushResponse` → `PabController.attackWarnNum = a.num` + emit UPDATE_PAB_SELF_ATTACK →
 *   **唯一消费者 PabWorldUINew.updateAttackWarnState**：`attackWarnNode.active = e>0`、红点数字 `Math.max(0,e)`、
 *   `e<=0` 时清空弹窗——**纯展示，游戏没有给玩家任何「撤离/应战」按钮** → 「立即转移 vs 抗争到底」必须由本 feat 实装。
 * 一场 591 条的分布：`0×525 / 1..14 / 42×1`；
 *   **转移即消警**（警告期转移后 `8521 resp{ok:1}` 与 `21534 num=0` 同拍）。
 * @type {number}
 */
export const PUSH_SELF_ATTACKED = 21534;
/**
 * ENIGMA_SECRET_ROOM_POINT_FIGHTING_INFO：某点位「谁在打 / 谁在驻」的战斗信息下推（载荷含 x,y 与队伍列表）。
 * 游戏侧写进 `roomPointFightingPVPInfo`/`roomPointFightingPVEInfo`（RealPabController 的
 *   updatePvpPanelInfo/getPvpPanelInfo 以 `NWorldMapUtils.getCellIndex(x,y,serverId)` 为键）
 *   → 它是「本点正在被 PVP」的**按点详情料源**（与瓦片 `m.state 11/12` 互为佐证）。
 * @type {number}
 */
export const PUSH_POINT_FIGHTING_INFO = 21523;
/**
 * ENIGMA_SECRET_ROOM_RESOURCE_CHANGE：资源点 bag 变动下推（载荷带 `uid`/`playerInfo`）。
 * ⚠ 与 8526 RESOURCE_INFO 的口径差异：**应答条目不带 uid，而本推送带**
 *   → 「谁已领过」只能从推送侧拿，INFO 侧必须自己记账（见 REJ_SAME_ITEM_ONCE 注）。
 * 投递：`ctx.on.push(21522)`，业务体在 `ev.data`（net 已剥 pbAckV2 信封 `{header,data}` 到内层，
 *   与游戏侧事件 PabRoomResLibraryDataUpdate 的载荷是**同一对象引用**）。
 * @type {number}
 */
export const PUSH_RESOURCE_CHANGE = 21522;
/**
 * ENIGMA_SECRET_ROOM_DROP_CHANGE：掉落箱变动下推（载荷 `{x,y,dropInfo:[{dropId,info{itemId,itemCount},uid,hide}],beastGetNum,bagGetNum}`）。
 * 投递：`ctx.on.push(21532)`，业务体同样在 `ev.data`（游戏侧事件 PabRoomRewardBoxDataUpdate）。
 * @type {number}
 */
export const PUSH_DROP_CHANGE = 21532;
/**
 * ENIGMA_SECRET_ROOM_OTHER_ATTACK_ON_FEED：「拍宠物时被他人攻击」推送（理论上属攻击警告一族）。
 * 游戏侧没有它的消费者 → 只登记，链路不依赖它（计数只看 21534）。
 * @type {number}
 */
export const PUSH_OTHER_ATTACK_ON_FEED = 21536;

// ─────────── PAB 地图实体类型（NWorldMapCommon.NWorldMapEntityType 全 PAB 段，瓦片 pointType）───────────
/**
 * PAB 全段枚举（游戏侧 `NWorldMapEntityType`，按枚举定义排序）：
 *   160 ALLY_HELP / **161 SHOP** / 162 BOSS_GUARD_REWARD / 163 DROP / 172 MONSTER / 173 RESOURCE /
 *   174 COMMON_PLANE / 175 TENT / 176 BOSS_PLANE / 177 BOSS / 178 BOSS_GUARD / 179 TEAM /
 *   186 EMERGENCY / 187 CNC_MAP_BUILDING / 188 LANDSCAPE。
 *   ⚠ **172 = 异能兽、173 = 资源点**（以枚举为准，勿凭报文目测）。
 * 各型瓦片 `m` 样本（顶层恒 `{v,x,y,k,id,pointType,m}`）：
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
/** @type {number} PAB_TENT：帐篷点（8521 会打向它，一局 24+1 次） */
export const PAB_TENT = 175;
/**
 * @type {number} PAB_BOSS_PLANE：临时停泊平台（tileArea=1；「攻打 BOSS」必须从这里出发）
 * 瓦片 extData 关键字段：`esrId`（区域配对键）/`state`/`sET`/`teams[]`/`isFight`。
 * **`bid` 与 `viewId` 恒为 11，不是 bossId**（勿用它反推 BOSS 身份）。
 * 全域去重 253 个平台，esrId 分**三桶** 20/21/22（全域统计口径，不是视口增量）。
 */
export const PAB_BOSS_PLANE = 176;
/** @type {number} PAB_BOSS：大BOSS 本体瓦片（tileArea=9） */
export const PAB_BOSS = 177;
/** @type {number} PAB_BOSS_GUARD：小BOSS 本体瓦片（tileArea=9；178@(230,234) 带 esrId:22 state:21，视口扫到才会推） */
export const PAB_BOSS_GUARD = 178;
/** @type {number} PAB_TEAM：玩家小队坐标点（瓦片 m 带 uid/aTag/playerInfo/aId/sid） */
export const PAB_TEAM = 179;

// ─────────── BOSS 阶段（PabFightStageState，游戏侧全枚举）───────────
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
 *   形态：大BOSS (203,203) 的 `state 21→23` 与 push 21530 `{x:203,y:203,boss:1}` 同毫秒到达，
 *   窗内 10018 持续维持 23，收窗时 21530 回 `{x:-1,y:-1}` 且 21535 推 state30。
 *   → 该阶段**服务器不接受对该点的攻打行军**（8521 连吃 `common_159995`），且 21535 不在切换那一刻推
 *   → 只能靠 10018 的瓦片 state 或 21530 的 capturingPetPos 识别（见 boss.js 的两条实时闸）。
 */
export const ST_BOSS_FEED = 23;
/** @type {number} ST_BOSS_FIGHTING_END：BOSS 战斗结束 */
export const ST_BOSS_FIGHTING_END = 28;
/** @type {number} ST_BOSS_FEED_END：BOSS 拍宠物结束 */
export const ST_BOSS_FEED_END = 29;
/** @type {number} ST_BOSS_DEAD_END：BOSS 死亡收场 */
export const ST_BOSS_DEAD_END = 30;

// ─────────── 平台↔BOSS 的区域配对（取自 push 10018 PUSH_TILEINFO 的 `m` 字段）───────────
/**
 * 瓦片 extData（= push 10018 的 `m` 子对象，**不是顶层**）里标识「属于哪个 BOSS 区域」的键。
 * 统计口径：10018 是视口增量，只能统计到「看到过的」瓦片。
 *   • 176 平台去重 253 个，esrId 分三桶 20/21/22；
 *   • **178 小BOSS 本体瓦片同样带 esrId**（178@(230,234) 有 `esrId:22 state:21`）
 *     → 读 BOSS 本体 esrId 对大小BOSS 都成立，只是依赖镜头是否扫到那块区域；
 *   • **162 石头瓦片的 esrId 恒为 0** → 石头点位不能用作区域配对；
 *   • 172/173 两型的 esrId 恒为 15、175/179/163 恒为 0 → **它们不参与区域配对**；
 *   • 全库键频：`esrId 57916 / sET 56905 / sBT 34779 / iNum 15937 / fTeamIds 892`（无 `esrIId` 这个拼法，0 命中）。
 *   ⚠ 客户端攻打入口 `NWorldPabBossPopup.marchClick` **完全不查 esrId** → 区域是**服务器独占判据**，
 *     本键只是「避免撞 142」的本地优化，不是硬闸（142 是预防性分支，见 REJ_BOSS_AREA）。
 * @type {string}
 */
export const TILE_KEY_ESR_ID = 'esrId';
/**
 * 瓦片 extData 里「开启争夺/可派兵」倒计时的绝对秒键（`sET/1e3` 与 ServerTime 比）。
 * `sET > roomBaseInfo.fightEndTime/1e3` 视为本场已结束（游戏 tips `cab_ui_info_065`）。
 * @type {string}
 */
export const TILE_KEY_SET = 'sET';
/**
 * 异能秘境三个 BOSS 的区域锚点（**活动固定坐标/类型，跨场实测不换**；保留作参考记录，当前 pilot 不 import）：
 *   实测 esrId 在 lead 窗内已缓存进 #tiles，#bossEsrId() 决策时恒非 null，几何判区已删。
 *   • 大BOSS (203,203)（型别 177）：三场实录（boss9×2、boss8）同位；
 *   • 小BOSS-B (230,234)（型别 178）：两场实录（boss12 esr22）同位；
 *   • 小BOSS-A (175,177)（型别 178）：boss11（esr21）单场报文证据 + 用户跨场确认。
 * 实测时间轴参考（**仅诊断对照用，决策链不消费**——进房首帧 21535 即带全量权威 stateEndTime，
 *   硬编码排期会造出会过期的第二真值源）：以本场实录起点计，两小BOSS 同刻 +1137s 开打（21 窗约 7min），
 *   大BOSS +2157s 开打（21 窗排定 10min）；历史场次大BOSS 21 时刻≈+2159s，两场差 2s（入场偏移量级）。
 * 区域形状（实录实测，901 应答去重 260 个平台格）：176 平台散布在自家锚点周围 1.4~21.2 格的圆环内，
 *   三区互不重叠；「取最近锚点」判区与服务器 esrId 归属 **0/260 不一致** → 几何判区可完全替代 esr 对照
 *   （连 esr 编号都不依赖，服务端改编号也不影响）。
 * 历史用途（已废弃）：曾用于 #zoneAnchor 几何判区，但实测累积池 esrId 恒可用，几何从未触发，代码已删。
 *   保留本表仅作坐标参考（探针工具、未来换图改版时的备用记录）。
 * @type {Array<{x:number,y:number,big:boolean,label:string}>}
 */
export const PAB_BOSS_ZONES = [
  { x: 203, y: 203, big: true, label: '大BOSS' },
  { x: 175, y: 177, big: false, label: '小BOSS-A' },
  { x: 230, y: 234, big: false, label: '小BOSS-B' },
];
/** @type {number} 判 BOSS 落在哪个区容差：本体 pos 就是锚点格本身，实测偏差 0，4 格防坐标取整/改版微动 */
export const PAB_BOSS_ZONE_TOL = 4;
/** @type {number} 判平台落在哪个区容差：实测平台距自家锚点最大 21.2，24 留余量；超出则不当本区候选（宁不挪不坐错区） */
export const PAB_PLANE_ZONE_TOL = 24;

// ─────────── DataConfig 限额键（TableUtils.getDataConfigData）───────────
/** @type {number} 掉落箱可领总量上限（_itemGetMax = Number(dataConfig(3021))；bagGetNum+beastGetNum 计入） */
export const CFG_DROP_ITEM_MAX = 3021;
/** @type {number} 掉落箱宠物已领上限（checkPetIdGeted：已含我 uid 的 dropBeast 数 >= Number(dataConfig(3061)) 即满） */
export const CFG_DROP_PET_MAX = 3061;
/**
 * 宠物携带背包**基础格数**（dataConfig(3017)）——同 PabBagItem 领取选择器的格子数
 *   （`for(g=0; g<3017+PabExtraPackItemNum; g++)`，见 pickup.js 文件头），
 *   再叠加增益 `BuffType.PabExtraPackItemNum` 的扩容才是总容量。拿满自动离场（leave.js）的「拿满」判据用它算容量。
 * @type {number}
 */
export const CFG_PET_PACK_BASE = 3017;
/** @type {number} 资源/增益上限串（dataConfig(3013) → "itemMax|buffMax"，split('|') 取 [0]=bag 上限、[1]=buff 上限） */
export const CFG_RES_LIMITS = 3013;
/** @type {number} 手拍每秒次数上限（dataConfig(630027)；游戏侧 RealPabController.checkCaptureOperationCd 用它做 `_touchOperateMaxNum`） */
export const CFG_TAP_LIMIT_PER_SEC = 630027;
/**
 * 编队治疗道具白名单（dataConfig(3035) → "itemId|itemId|…"）。
 * 源码 NWorldPabTeamSelfItem.updateUseItem：`getDataConfigData(3035).split('|')` 逐个
 *   `getItemNumById(id)>0` 才画道具按钮 → **白名单不硬编码，运行时读**（本仓用到的两个是
 *   41002 急救绷带 / 41003 全科医疗包，仅作兜底参考值）。
 * @type {number}
 */
export const CFG_PAB_HEAL_ITEMS = 3035;
/**
 * 商店货币对（dataConfig(3028) → `"购买币|刷新币"`，split('|')）：[0]=41009 异能晶块、[1]=41010 人造水晶。
 * 源码 PabShopPanel.initView / PabShopItem.updateShopItem（`_costItemCfg = ITEM[t[0]]`，图标与预检都用它）。
 * @type {number}
 */
export const CFG_SHOP_CURRENCY = 3028;
/**
 * 单次刷新消耗（dataConfig(3029)，`_shopRefreshCost = Number(getDataConfigData(3029))`）。
 * **当前配置值 = 1**（一次 8543 恰好扣 1 个 41010：余量 10→9→…→1），
 *   但仍**运行时读本键**，不把 1 写死。
 * @type {number}
 */
export const CFG_SHOP_REFRESH_COST = 3029;
/** @type {number} 资源点档位名串（dataConfig(630002) → `"min,max,loc|min,max,loc|…"`，getResBuildingNameByItemNum 拿 `m.iNum` 查区间） */
export const CFG_RES_BUILDING_NAME = 630002;
/** @type {number} 点位 PVP 战斗时长串（dataConfig(3018)，WIPabResource.updateTileState 用它给瓦片 state 11/12 算倒计时） */
export const CFG_PVP_FIGHT_TIME = 3018;
/**
 * 本场复活次数上限（dataConfig(3056)；复活判据：
 *   `deadType==1 && Number(getDataConfigData(3056)) > reviveNum` → 发 8552 REVIVE）。
 * 读不到/为 0 → 一律不自动复活（闭开：宁可不复活，也不盲目消耗次数）。
 * @type {number}
 */
export const CFG_REVIVE_LIMIT = 3056;

// ─────────── 点位刷新推送的投递口径 ───────────
// 游戏侧对这两条推送只在 PushResponse 里做一次转译：
//   ENIGMA_SECRET_ROOM_RESOURCE_CHANGE(21522).Handler → EVENT.emit(EventId.PabRoomResLibraryDataUpdate, o.data)
//   ENIGMA_SECRET_ROOM_DROP_CHANGE(21532).Handler     → EVENT.emit(EventId.PabRoomRewardBoxDataUpdate, o.data)
// 本 feat 直连 `ctx.on.push`，拿到的包体与那条事件载荷是**同一对象引用**（不另订 EventCenter 事件）。
//   21522 → PUSH_RESOURCE_CHANGE（= 原 PabRoomResLibraryDataUpdate）
//   21532 → PUSH_DROP_CHANGE（= 原 PabRoomRewardBoxDataUpdate）

// ─────────── 拍宠物动作与节奏（RealPabController / PetCaptureTouchNodeNew / PetCaptureDragNodeNew / PabPetFeedEventPopup）───────────
/** @type {string} 投喂物/动作配置表名（TableName.enigma_beast_behave；行 id 即 BEAST_OPERATE 的 specId，字段 item/time/favor/bar_pers/pai_times） */
export const TABLE_BEAST_BEHAVE = 'enigma_beast_behave';
/**
 * 投喂道具的**首格 specId**（enigma_beast_behave 行 5/6 的 `item` = 可投喂的秘境背包道具）。
 * 源码 PabPetCaptureNodeNew：`init` 取行 `(t+5).toString()`（**`for(t=0;t<2;t++)` → 只有 2 格**）填 `_captureItemIds`，
 *   即 `_captureItemIds[t] = ITEM[behave[t+5].item].id`；`onItemFeedClick(e,t)` → `getItemNumById(_captureItemIds[o])>0
 *   && petCaptureOperation(o+5)` → **specId = 格子下标 + 5**，且游戏自己先查背包余量。
 *   `RealPabController.petCaptureOperation` 的载荷只有 `{specId}`（8546 全库请求形态仅此一种，
 *   `checkCaptureOperationCd` 首行只拦 specId===1 → 投喂不受每秒限额约束）。
 * 道具身份闭环：`8542{specId:19}×10 → 21525 里 41011 +10 → 8546{specId:5}×10`
 *   → **behave[5].item = 41011 全素香肠**（就是商店 specId 19 的货，单价 500 晶块）。
 * 为什么要投：大BOSS 的 `allFavor=1000000`，而免费手拍 changeScore 只 6~11（≈4 拍/秒）
 *   → 光靠手拍不可能拍满，behave 行的 `favor` 才是这一阶段的加分主力（单件投喂 changeScore=400）。
 * @type {number}
 */
export const SPEC_FEED_FIRST = 5;
/** @type {number} 投喂格子数（behave 行 5、6 —— PabPetCaptureNodeNew `for(t=0;t<2;t++)`，**不是 6 档**） */
export const SPEC_FEED_COUNT = 2;
// 8546 specId 全谱（一局里的完整请求序列）：
//   1 免费手拍（chg 5~9）；2/3 拖拽事件答案（chg=0 但 selfenergy +1，即 behave 表行号本身就是拖拽答案）；
//   4 能量满释放（chg 300/390、能量归 0）；7/8/9/10 心动时刻（投喂弹窗）选项（chg 50/100/200/500）。
//   **BOSS 与普通异能兽同协议同 specId 集**（BOSS 窗 41.4s 内请求直方图 {1:100, 2:1, 3:2, 4:1}），
//   差别只在 allFavor（BOSS 1000000 / 普通宠 7000~5000）与 21530 载荷多一个 boss:1。
/**
 * 免费手拍 specId（PetCaptureTouchNodeNew.petCaptureTouch → `petCaptureOperation(1)`，无消耗）。
 * 唯一受客户端每秒限额约束的 specId（RealPabController.checkCaptureOperationCd 首行 `!(1!=e||…)`，
 *   限额 = Number(dataConfig(630027))/秒；超限该调用被游戏静默丢弃，不发包）。
 * @type {number}
 */
export const SPEC_TAP = 1;
/**
 * 能量满释放 specId（PetCaptureTouchNodeNew.onEnergyUseClick → `petCaptureOperation(4)`）。
 * 同一会话 14/14 次能量周期完全复现：selfenergy 攒到 3 后该拍 changeScore=390（普通拍 6~11），
 *   且能量归 0；随后 6.4~10.2s 无下一拍（游戏侧 behave[4].time 持续演出 + 6s energyMaxProtectNode 保护）
 *   ——即「凑够 3 格能量，触发一段时间的高分值持续拍」。
 * @type {number}
 */
export const SPEC_ENERGY_USE = 4;
/** @type {number} 能量格数上限（PetCaptureDragNodeNew `progress=selfenergy/3`、PetCaptureTouchNodeNew `btnEnergyMax.active = 3==selfenergy`） */
export const ENERGY_MAX = 3;
/**
 * 捕获事件类型（唯一来源是 push 21527 的 `type`——capturingInfo 里没有 eventType，见 PUSH_BEAST_EVENT 注）：
 *   2 = 拖拽事件（PetCaptureDragNodeNew，**窗口 2.0s**：源码 `_eventEndTime = ClientTime + 2e3`，
 *     全库 349/349 条 `endTime(Int64 ms) − header.ts×1000 ≡ 2000ms`（endTime 是 Int64 毫秒口径）。
 *     成功 → `petCaptureOperation(specId[0])`，能量 +1 且 changeScore=0）；
 *   5 = **心动时刻**（界面标题即此，投喂弹窗 PabPetFeedEventPopup；选项 = specId 数组即 enigma_beast_behave 行 7..10，
 *     **服务器窗口 25.0s**（25/25 条一致）；changeScore 200~650 档，择优即多拿分。
 *     **发号口径差异**：游戏发的是 `7 + 选项下标`（位置映射），本 feat 发的是候选值本身——
 *     25/25 条 specId 恒为满四元 [7,8,9,10]，两者等价；若服务器改为下发子集则会错位。
 *     **弹窗必须主动关掉**：开窗方是 PabPetCaptureNodeNew.pabPetCaptureEvent（`5==e.type` 即
 *     `OpenUI(UIDataInfo.PabPetFeedEventPopup, e, tileInfo)`，与我们的推送回调同一个派发链），而它自己不知道
 *     票已被我方投掉，会按 `_endTime = ServerFloatTime + behave[specId[0]].time` 倒数到 0 后自动 `onFeedClick()`
 *     再随机发一发（4/4 次：我方 0ms 发出、结算 500 分后，弹窗仍在 +5.24~18.60s
 *     补发 `7+下标`，3/4 被接受）→ 见 capture.js #closeFeedPop；
 *   3 = 能量爆发演出（specId=[4] + points 数组、endTime 为哨兵值 ≈ Long.MAX/1000，43/43 命中），
 *     客户端无任何消费者，本 feat 也不直接响应它，由 selfenergy 闸覆盖。
 * @type {number}
 */
export const EVT_TYPE_DRAG = 2;
/** @type {number} 捕获事件类型：心动时刻（投喂弹窗，择优选项，见 EVT_TYPE_DRAG 说明） */
export const EVT_TYPE_FEED_POP = 5;

// ────────── 资源/增益井 item 映射（PabBagItem.updateResourceItem）─────────
/**
 * 资源站配置表名（TableName.enigma_secret_realm_rss_station）。
 * 游戏侧 PabBagItem.updateResourceItem(e) 用 `getTableDataById(enigma_secret_realm_rss_station, e.specId)` → `.item` 得 itemId
 *   （供 checkItemNumMax 背包上限拦截）；`_uuid = e.dropId`（RESOURCE_GET 的 rId）、`_specId = e.specId`。
 * 运行时 dump（tools/pab-pickpool-dump.devtools.js）：该表按**点位**分行（差异仅 id/region/piece/power/group），
 *   同一个产出道具对应几十行（如 item=41001 有 44 个 specId）→ 面板拾取清单必须按 itemId 聚合，不能逐 specId 列行。
 * @type {string}
 */
export const TABLE_RSS_STATION = 'enigma_secret_realm_rss_station';
/**
 * buff 槽位范围（PabBuffEquipNode.initNode）：`for(n=1;n<=3;n++) { …getTeamBuffCfgByPos(n)… }`，
 *   对应 `roomBaseInfo.buffMap[pos] = rss_station specId`，pos 为 1-based。上限 = buffGetMax（dataConfig 3013 拆分位 [1]）。
 * @type {number}
 */
export const BUFF_SLOT_MIN = 1;
/** @type {number} buff 槽位上界（含），与 PabBuffEquipNode initNode 的 `n<=3` 同口径 */
export const BUFF_SLOT_MAX = 3;

// ────────── 增益 buff 类（effect_buff）与默认选择 ──────────
/**
 * 秘境增益站共 **6 个类**（运行时 dump tools/pab-pickpool-dump.devtools.js：rss_station 里 effect_buff!=0 的行
 *   按类去重得 6 组，每组 75 个 specId、buff_para 4 档），槽位只有 3 个 → 必须挑三。
 * 类名取 `EFFECTBUFF[effect_buff].string` 的 loc 译文（同 PabBuffItem.updateBuffNode）：
 *   9200001 全部单位攻击加成 / 9200002 全军防御能力提升 / 9200003 全部单位生命加成
 *   9200004 伤害加深 / 9200005 伤害减免 / 9200006 野外行军速度提高。
 * @type {number}
 */
export const EFFECT_ATK = 9200001;
/** @type {number} buff 类：伤害加深（buff_para 档位 1300/1900/3100/5000） */
export const EFFECT_DMG_DEEP = 9200004;
/** @type {number} buff 类：野外行军速度提高（面板所称「行军加速」，档位 2000/3000/5000/8000） */
export const EFFECT_MARCH_SPEED = 9200006;
/**
 * 默认要拿的三类（行军加速、伤害加深、攻击增强）。
 * 面板仍可改；**全不勾 = 不限**（6 类里来者不拒，靠槽位先到先得）。
 * @type {number[]}
 */
export const DEFAULT_BUFF_EFFECTS = [EFFECT_ATK, EFFECT_DMG_DEEP, EFFECT_MARCH_SPEED];

// ────────── 可选拾取池枚举表（面板 itemlist / multiopts 数据源）──────────
/**
 * ITEM 主表名（l10n.tableRows 的 semantic，会解为 TableName.ITEM→'item'）。
 * 掉落箱物品 = type==171 行（RealPabController.checkItemNumMax 与 PabShopItem 均以 type==171 作为「秘境背包可持有物品」的牌干）。
 * 运行时 dump：type==171 只有 2 行（全素香肠/豪华牛排），而资源点产出道具的 type 是 33/166/167 等
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
 * enigma_beast 行**没有 name 字段**，宠物显示名 = resCfg.getTypeCommonName(cfg.type, star)
 *   → `enigma_beast_type[type].name1`（星级 < growUpStar）或 `.name2` 再过 LOCAL.getText。
 * @type {string}
 */
export const TABLE_BEAST_TYPE = 'enigma_beast_type';
/**
 * buff 效果表名（TableName 成员 EFFECTBUFF → 'effect_buff'）。
 * PabBuffItem.updateBuffNode 用 `getTableDataById(EFFECTBUFF, row.effect_buff)` → `.string` 作 loc 键显示 buff 名，
 *   `.value_type` 决定 buff_para 的展示口径。秘境三类增益（行军加速/伤害加深/攻击增强）即三个不同 effect_buff。
 * @type {string}
 */
export const TABLE_EFFECT_BUFF = 'EFFECTBUFF';
/**
 * 商店货表名（TableName.enigma_secret_realm_shop）。
 * 源码 PabShopItem.updateShopItem：`getTableDataById(enigma_secret_realm_shop, specId)` →
 *   字段 `id / item_id / item_num / cost / buy_times / type`（`_lastNum = max(buy_times - getTime, 0)`，
 *   `type===3` 时显示 `enigma_realm242`「本期所有商店限量」）。
 * ⚠ **本表离线无数据**（游戏反编译源码全查过，只有 TableName 枚举与两处 UI 引用）
 *   → **商品全量只能运行时 `l10n.tableRows(TABLE_SHOP)` 枚举**，不能写死。（specId→itemId 的已反出部分见 SHOP_SPEC_ECONOMY）
 * @type {string}
 */
export const TABLE_SHOP = 'enigma_secret_realm_shop';
/**
 * 秘境建筑表名（TableName.enigma_secret_realm_building）——**四个商店的权威坐标就存在这张表里**。
 * 游戏侧两处用法交叉证实：
 *   • PabWorldUINew.initMiniMapBuildingItem：`getTableGroupArray(enigma_secret_realm_building)` 逐行
 *     `if (3 !== t[o].build_type || t[o].group !== getPabGroupId()) continue;` → 用行里的坐标画小地图商店图标；
 *   • 本 feat 的读法：过滤 `build_type===3 && group===本房间`，
 *     `coords.split(',')` 得 (x,y)——pilot.js 的商店锚点就来自这里（见 pilot.js 文件头）。
 * → 字段：`build_type`(3=商店) / `group`(房间分组) / `coords`("x,y" 字符串) / `map_zoom`(小地图图标)。
 *   本表在线下发（`getTableGroupArray` 可枚），**离线无数据**，只能在秘境里读。
 * @type {string}
 */
export const TABLE_BUILDING = 'enigma_secret_realm_building';
/**
 * 秘境回合表名（TableName.enigma_secret_realm_timer）：`realm roundid` → 回合开放时刻。
 * 「回合已开放」的算法是 `ServerTime > fightBegin/1000 + timer[realm[esrId].roundid].start`。
 * ✔ 实录报文实证：172/173 的 esrId **按区域分档**（观测到 12~19），并非恒 15；
 *   故本表既当「回合是否已开放」闸（pilot #roundOpen），也供「强/普通异能区」档位（realm[esrId].roundid，pilot #roundTier）。
 * @type {string}
 */
export const TABLE_TIMER = 'enigma_secret_realm_timer';
/**
 * 秘境主表名（TableName.enigma_secret_realm）：esrId → roundid / 区域归属，回合表的外键来源。
 * roundid 越大=开放回合越晚=越靠地图中心的「强异能区」（字典 FAQ25）；供 #roundOpen 开放闸与 #roundTier 档位。
 * @type {string}
 */
export const TABLE_REALM = 'enigma_secret_realm';
/**
 * 已反出的商店经济映射（**只反出了买过的 3 项**，其余必须运行时读表）。
 * 反法：对每次 8542/8543 后的 21525 背包快照做差分（多会话交叉验证）：
 *   • specId 19 → **41011 全素香肠**，单价 41009 扣 500/件（买 10 次 → 41011 +10、41009 −5000）；
 *   • specId 16 → **41006 强异能诱饵**（8534 造点用），单价扣 3000；
 *   • specId 20 → **38006601 传奇百兽箱碎片自选箱**（×40，名字取游戏本地化字典 `item_name_38006601`），
 *     单价扣 2000、且 41009 总扣 2000 = `cost`；本项 `type===3` → **跨店共享额度**。
 *   未反出的：specId 11/12/13/14/15/17（getTime 始终 0 = 从未买过）。
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
 * 野怪点勘察消耗的道具 id（**全地形勘察车**，非香肠）。
 * 源码 NWorldPabElementMonsterPopup.spyonClick 花 `getItemNumById(41001)` 做门槛、refreshUI 取 ITEM["41001"]
 *   作花费图标、spyonCostLab="-1"（每次侦察扣 1）；道具由秘境野怪点产出（rss_station 里 item=41001 有 44 个 specId），
 *   **不经商店售卖**→ 只能用多少侦察多少，余量运行时读 getItemNumById(41001)，不写死。
 * @type {number}
 */
export const ITEM_SCOUT_TOOL = 41001;
/**
 * 全素香肠（投喂 BOSS 的道具，商店 specId 19 的产出，携带上限 10）。
 * 购买规则取「41011 < 10 才买」，并把它兼作「该去商店了」的信号之一。
 * @type {number}
 */
export const ITEM_SAUSAGE = 41011;
/**
 * 急救绷带（补给判据之一：本道具数量达标才算「备货够，可以去拍百兽」）。
 * @type {number}
 */
export const ITEM_BANDAGE = 41002;
/**
 * 全科医疗包（治疗白名单另一件，判据同 41002）。
 * @type {number}
 */
export const ITEM_MEDKIT = 41003;
/**
 * 高品质线（enigma_beast.quality ≥ 本值算「拿得出手的宠」）：「背包拿满」（收场判据）与
 *   择优带出共用同一个阈值 `quality >= 4`。
 * @type {number}
 */
export const QUALITY_HIGH = 4;
/**
 * 购买币（异能晶块）道具 id：8542/8543 的计价单位（dataConfig 3028 的 [0]）。
 * @type {number}
 */
export const ITEM_BUY_CURRENCY = 41009;
/**
 * 刷新币（人造水晶）道具 id：8543 SHOP_REFRESH 的计价单位（dataConfig 3028 的 [1]，每次恰好扣 1 个）。
 *   竞品 §9.2 的 `ids` 购物清单约束直接按本 id 计数（刷新币可作资源/掉落产出采集）。
 * @type {number}
 */
export const ITEM_REFRESH_CURRENCY = 41010;
/**
 * 商店点位（一共 4 个；地图核对 = push 10018 里 `pointType===161` 的瓦片）。
 * 同一 `k=30911` 服务器上的四项：
 *   `(95,163) id=41776`、`(250,96) id=24702`、`(315,255) id=65438`、`(154,314) id=80462`；
 *   **id 跨 k 稳定、坐标随图而异** → 本常量只作默认候选，
 *   **主料源必须是运行时 10018 的 161 型瓦片快照**（不要把这四个坐标当硬码）。
 * @type {Array<{x:number,y:number}>}
 */
export const SHOP_POINTS_SEED = [
  { x: 95, y: 163 },
  { x: 250, y: 96 },
  { x: 315, y: 255 },
  { x: 154, y: 314 },
];

// ─────────── 服务器拒绝原因键（pbAckV2.header.d，经 game-api sendSecret 的 Ret.reason 透传）───────────
/**
 * 同一资源点内相同道具只能获取 1 次（字典表 loc 键）。
 * 游戏自己在面板侧也有同判据（PabResLibraryNode.pabBagItemOperate：`checkItemIdGeted(specId)` 命中即 ShowTips(enigma_realm119)），
 *   但它要求 bagInfo 条目 `uid==me`，而 **8526 INFO 载荷的条目不带 uid** → 对 INFO 数据恒为假，只能由本 feat 自己记账。
 * @type {string}
 */
export const REJ_SAME_ITEM_ONCE = 'enigma_realm119';
/**
 * 小队尚未抵达目标点（**服务器独占**判据：客户端 pabBagItemOperate 只看限额/已领/背包上限，不查在位）。
 * 撞到即说明「点位明细已陈旧、队伍已开走」→ 该点位本轮不再发。
 * **命中的 cmd 族**：
 *   8527×16（领资源 bag）/ 8538×2（领 buff）/ 8546×1（拍宠物投喂）/ **8521×80（行军，最多的一条拒绝码）**；
 *   唯独 8548（石头）从未撞过 → 「石头不要求在位」。
 * **解除信号 = push 21529 TEAM_ARRIVE**（载荷带 x,y,pointType）；8521 撞它时语义是「我正在行军、
 *   尚未到位」→ 不烧配对/区域账、不拉黑目标，只退避等到达推送。
 * @type {string}
 */
export const REJ_NOT_ARRIVED = 'enigma_realm158';
/** @type {string} 已被其他指挥官拿走（队友抢先；8527 应答 57 条里 17 条是它） */
export const REJ_TAKEN_BY_OTHER = 'enigma_realm161';
/** @type {string} 异常操作，请再次尝试（服务器抖动的形态；8546 被拒 13 次、重试即过 → **不拉黑**） */
export const REJ_RETRY = 'enigma_realm162';
/** @type {string} 当前已在该位置，无需行军（正常语义 → 静默处理，**不拉黑**） */
export const REJ_ALREADY_THERE = 'enigma_realm157';
/** @type {string} 目标点不能行军 → 该点当日拉黑 */
export const REJ_NO_MARCH_TARGET = 'enigma_realm163';
/**
 * 只能攻击当前所在停泊平台对应区域内的极异能兽（**服务器独占判据**：全仓客户端源码 0 引用，
 *   只会以 `s=3 d=enigma_realm142` 的拒绝形态出现）→ 撞到即说明我所在平台的 esrId 与目标 BOSS 不同区域。
 * ⚠ **预防性代理**（由「字典文案 + 客户端不查 esrId」推出，不依赖服务器是否真下发该码）；
 *   保留理由：它不会错杀——真撞到只会降级那一对。
 * @type {string}
 */
export const REJ_BOSS_AREA = 'enigma_realm142';
/**
 * @type {string} 请先行军到对应区域的临时停泊平台（我不在 176 平台上，NWorldPabBossPopup.marchClick 同口径 tips）。
 * ⚠ **同样是预防性代理**；它本质是「本地 roomBaseInfo 滞后」，而 21521 一场≈17s 一条
 *   → 处置取「退一个推送周期再评」。
 */
export const REJ_NEED_PLANE = 'enigma_realm141';
/** @type {string} 当前资源点内获取物品次数已用完（石头点位已领满，重复领同点 8548 回此码）→ 该点位永久拉黑 */
export const REJ_STONE_USED_UP = 'enigma_realm60';
/**
 * 目标点不存在，请拖动地图刷新数据并重试（字典文案）。
 * 命中在 8527（×3）→ 语义是「我手里的瓦片/点位数据陈旧」，
 *   与 158（人在路上）不同 → 处置应「重拉该点 INFO / 等 10018 刷新」，不能复用 158 的静默窗。
 * @type {string}
 */
export const REJ_POINT_NOT_EXIST = 'enigma_realm159';
/**
 * 战场即将封闭，请指挥官尽快选择带出秘境战场的物资（字典文案）。
 * 命中在 8521（×2）→ 这是**收场期信号**，
 *   撞到应停掉一切行军/攻打类动作（再发只会连续吃拒），不能当普通拒绝重试。
 * @type {string}
 */
export const REJ_BATTLEFIELD_CLOSING = 'enigma_realm17';
/**
 * param error（通用参数错，字典文案）。
 * ⚠ 不是包形态问题：9/9 命中全在 8521 MARCH_MOVE，
 *   而它的 req 无论成功还是被拒都是同一副 `{x,y}` 两键（284 条逐键一致）→ 真因是**阶段态**：
 *   8 连发生在大BOSS 投喂/拍宠窗（push 21530 `{x,y,boss:1}` 且瓦片 `state 21→23`，窗长 39.2s），
 *   1 发发生在小BOSS 本体瓦片已 `pointType→0`（点消失）之后一秒。
 *   8527×9 / 8538×4 属载荷不完整/`pos` 语义未核（与攻打档不同源）。
 * 处置：攻打侧短拉黑该坐标（`tuning.paramBlacklistMs`，见 boss.js #handleMarchReject），不烧配对试探额度；
 *   主防线是两条实时闸（capturingPetPos 在拍窗 + 现场瓦片 state），见 boss.js 文件头。
 * @type {string}
 */
export const REJ_PARAM_ERROR = 'common_159995';
/**
 * BOSS 已被击杀（字典文案）。命中在 8546×3（拍 BOSS 时撞上）→ 目标已消失，不重试、整只降级。
 * @type {string}
 */
export const REJ_BOSS_KILLED = 'enigma_realm_new_1';
/**
 * 异能兽已被捕获（字典文案）。命中在 8546×1 → 拍宠目标已被抢，静默换下一只。
 * @type {string}
 */
export const REJ_BEAST_CAPTURED = 'enigma_realm_new_2';
/**
 * 操作错误，请点击交互区域（字典文案）。命中在 8546×1 → 与「在拍闸门与服务器现场不一致」同形，
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
/**
 * @type {string} 同一区域核心停泊平台之间不允许相互行军（挪台路径约束）
 *   真机报文：拒绝情境取决于**本队当前停泊位**（同区平台之间）而非目标点固有属性，
 *   报文里同点挪开后再行军 11.5s 后即成功 → pilot.js 处置为 60s marched 冷却，不做本场拉黑。
 */
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
   * 取 250：异能井是一群人抢的，去抖窗直接叠加到首次发包延迟上（一帧 8526 应答 44~75ms 就回）。
   */
  pickupDebounceMs: 250,
  /** 拍宠物：免费手拍两拍之间的最小间隔（毫秒），人手连点中位 222ms，此处保守取 250（≈4 拍/秒） */
  tapIntervalMs: 250,
  /** 拍宠物：dataConfig(630027) 取不到时的每秒手拍兜底上限（与游戏 checkCaptureOperationCd 同语义） */
  tapMaxPerSecFallback: 4,
  /** 拍宠物：能量满释放（specId=4）之后的静默（毫秒），behave[4].time 读不到时的兜底；该窗口 6.4~10.2s */
  energyBurstFallbackMs: 7000,
  /**
   * 拍宠物：大BOSS 环节两次投喂道具（8546 specId 5/6）之间的最小间隔（毫秒）。
   * 人手节奏：10 件落在 2.5s 内，
   *   逐件间隔 100/200/200/300/600ms，单件 changeScore=400（免费手拍只 6~11）。
   *   取 200：按人手间隔定档（逐件 100~600ms，单件 changeScore=400）。
   *   不取 100：两件之间还夹着商店补货（香肠携带上限 para1_v1=10）与手拍，留一档余量防吃频控。
   */
  bossFeedGapMs: 200,
  /**
   * 拍宠物（B3）：投喂路窗内预检失败（feedInfo 尚未就绪/全 0、或 nowFavor>=allFavor）时的退避间隔（毫秒）。
   *   这类时刻发 8546 易撞服务端 `s=3`（异常操作请稍后再试）；拉长下次尝试以降频，不影响正常逐件投喂（bossFeedGapMs）。
   */
  bossFeedRejectMs: 1500,
  /** 拾取：被拒 dropId 的当日拉黑存活（毫秒），过期后允许再试（防永久误拉黑） */
  rejectBlacklistMs: 6 * 3600 * 1000,
  /**
   * 拾取：相邻两条 GET 的最小间隔（毫秒）——流水线发送的节拍初值。
   * 必要性：次通道 NetMgrSimple.send 有**按 cmd 的 MsgIdSettings.cdTime 频控**，
   *   命中即 `return !1` 不上线也不报错；门面 TMWatchNetMgr.sendPBV2 **无 return** → 我们拿不到那个 false，
   *   只能靠超时感知。同一轮里 44~75ms 的连发会全部没应答（8527：9 req / 5 resp），串行 await 把它们空等满
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
   * 必要性：点位明细吃满 62s 时队伍早已开走，继续发就撞 8527 `s=3 d=enigma_realm158`「小队尚未抵达目标点」；
   *   而客户端有坐标级在位判据（roomBaseInfo 带 `startPoint`/`targetPoint`，21521 载荷 +
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
   *   本窗口仅在兜底时生效，取 5s：应答 1~2s 回，窗开得宽只会把错配窗口一起放大。
   */
  dropPairTtlMs: 5000,
  /**
   * 拾取：待配对坐标队列上限。溢出**不是丢最旧而是整窗作废**（连点面板时 FIFO 已不可信，
   *   留着半队坐标去猜只会把错点写进 DROP_GET，被拒后还会误拉黑本来能拾的 dropId）。
   */
  dropPairQueueMax: 8,
  /**
   * 拾取：「本会话在该点位已拿到/已发过」账的点位条数上限（Map 保持插入序，溢出丢最早一点位）。
   * 必要性：8526 RESOURCE_INFO 的 bagInfo 条目**不带 uid**（keys 仅 dropId/specId/likeUids）→
   *   游戏侧「我已领」判据对 INFO 载荷完全失效，只能由本 feat 自己按点位记账（否则撞 8527 s=3 d=enigma_realm119）。
   */
  tileAccMax: 32,
  /**
   * 治疗：**掉血阈值**（百分比，系统常量不露面板）：某支军队 `armyPower/maxArmyPower <= 1 - 本值/100`
   *   即算伤员（达阈即伤；不写 `1 - ratio >= need`，浮点上恰好掉血 10% 会被误判无伤）。
   *   预筛（21521 powerInfos）与 8584 权威路逐位同式共用（夹 [0,100] 口径在 heal.js）。
   * @type {number}
   */
  healLossPct: 10,
  /**
   * 治疗：无伤（或无可用道具）时的扫描间隔（毫秒）。
   * 8584 是一个「拉全编队血量」的查询包，没伤也不需要频；游戏弹层只在玩家开窗时才发。
   */
  healScanMs: 4000,
  /**
   * 治疗：相邻两次动作（8584 快照 / 8534 用道具）的最小间隔（毫秒）。
   * 人手链路：8534 成功后 0.5~0.6s 游戏自己补一条 8584（弹层刷新）→ 取 600 与之一致。
   */
  healGapMs: 600,
  /**
   * 治疗：快照的**最长可用年龄**（毫秒）。超出即作废重拉 —— 血量会被战斗实时改掉，
   *   拿陈旧快照决定给哪支军队用道具属于「拿旧数据发写请求」（与拾取的 staleMaxMs 同理）。
   */
  healStaleMs: 6000,
  /** BOSS：状态机重扫间隔（毫秒）。21535/21521 都是 kick 唤醒源，本值只作推送漏拍的兜底 */
  bossScanMs: 2000,
  /** BOSS：一次 8521 发出后等待 21521 刷新的**确认超时**（毫秒）；小BOSS 一轮 4.3s、大BOSS 一轮 8s */
  marchConfirmMs: 8000,
  /**
   * BOSS 攻打：任一 `s≠0` 被拒后的**最小静默**（毫秒）。
   * 必要性：本地闸门是 `pointType===176 + marchState===ARRIVED`，而「本地态与服务端态不一致」正是 141 的定义
   *   → 被拒那一刻本地闸已不可信；又因「一拍只发一枪 + 应答几十毫秒就回」，没有退避就会把被拒的写请求
   *   打成 ≈5 条/秒的风暴（与拾取侧「自动化撞限额的目标当日拉黑，防止逐拍重发刷屏」同一口径，只是攻打
   *   不能拉黑 bossId：区域是服务器独占判据，见 boss.js 文件头）。
   */
  rejectBackoffMs: 5000,
  /**
   * BOSS 攻打：撞 142（平台区域 ≠ BOSS 区域）后的**降级短退避**（毫秒）。
   * 取 1000：142 只烧「当前平台×该 BOSS」这一对区域配对（不拉黑 bossId），同区域的下一个 BOSS
   *   紧接着就该打；用通用 5s 会把「可攻打倒计时已结束」的同区域攻打拖成原地发呆（1115 实录 20:22:55→20:23:00）。
   *   仍留 1s 而非 0：防降级账未落时同一对被重评打成风暴。
   */
  bossAreaDemoteMs: 1000,
  /**
   * BOSS 攻打：撞 141（服务端认为我不在 176 平台上）后的专用静默（毫秒）——等 push 21521 把 roomBaseInfo 刷正。
   * 取 15000：21521 一场 239 条 ≈17s 一条（行军状态变化时补发，但被拒这一路没有行军可触发），
   *   给一个「≈一条推送周期」的窗；用通用 5s 会在刷正前多撞两枪。
   */
  planeRefreshMs: 15000,
  /**
   * BOSS 攻打：撞 `common_159995`（该点当前不可打）后对**该坐标**的短拉黑存活（毫秒）。
   * 取 60000：大BOSS 投喂窗长 39.2s（21530 开 boss:1 → 收窗），
   *   60s 能盖住整窗；到期后 21535 早已被推正（收窗即推 state30），不会把能打的点锁死。
   *   不用 rejectBlacklistMs（6h）：那是 163「目标点不能行军」的永久错，而本码是阶段态，窗过即可打。
   */
  paramBlacklistMs: 60000,
  /**
   * BOSS 攻打：现场瓦片闸（boss.js #liveTileBlock）认 10018 快照的**最长可用年龄**（毫秒）。
   * 必要性：21535 在阶段切换那一刻不推（21→23 时下一条 21535 晚 39.2s；小BOSS 瓦片
   *   `pointType→0` 时它的 state28 晚 400s），而 10018 ≈3 条/秒的视口增量会先看到现场。
   * 取 60000：与一次行军四段式（≈4~11s）同量级；超龄的证据不参与拦停（fail-open）。
   */
  bossTileFreshMs: 60000,
  /**
   * 驾驶：**21535 BOSS 快照主动复拉**的最小间隔（毫秒）。
   *   本拍出现「驻留点是 BOSS 点」或「return 档被拒」时，发一次 8522 POINT_INFO（只读）刷新 bossBaseInfo，
   *   避免逐拍敲；取 15000（driveScanMs 量级）。应答落地会 kick 一拍使「提前离点」判据立即重评。
   * @type {number}
   */
  driveBossStateGapMs: 15000,
  /**
   * BOSS 攻打：「近区候选」的判定半径（欧氏格数，与 #platformCandidates 同口径）。
   * 口径（10018 里 176 平台 `m.esrId` × 21535 的 bossBaseInfo.pos 对账）：
   *   每只 BOSS 到**它自己区域**平台最近 1.4~7.1 格（boss9 2.0 / boss10 1.4 / boss11 7.1 / boss12 2.0），
   *   而到**跨区域**平台最近 19.8~63.9 格 → 12 落在两档距离的空档里。
   *   注意这是**排序档而不是过滤闸**（远档仍留在队尾，否则近处全被区域闸拦下时我们会罢工），
   *   真正的判据仍是服务器的 esrId 比对；本档的作用是把「同一平台上该先撞哪一枪」从试探改成就近，
   *   避开 142。
   */
  bossNearRadius: 12,
  /**
   * 拾取：掉落宠物的**品质筛选阈值**（enigma_beast 行 `quality`，低于它的不占配额）。
   * 阈值取 >=4；读不到行或行无该字段一律放行（fail-open，不把低品质当高品质拦死）。
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
   *   人手节奏在 250ms 量级（8542→8543 平均间隔 1.0~1.3s，但那是人在选数量）。
   */
  shopGapMs: 250,
  /**
   * 商店：同一店两条 BUY 之间的额外静默（毫秒）。
   * 必要性：BUY 无坐标、应答只回 `{items}`，**多店轮巡时同拍两笔会串号**（req↔resp 靠 reqTime 配对能分清身份，
   *   但服务器侧「上一笔未结算」形态会出 enigma_realm162）→ 串行 + 小静默。
   *   实施点：shop.js 以 #lastBuyEndAt（上一笔 8542 应答落地时刻）在 #tick 夹住下一笔动作。
   */
  shopBuyGapMs: 600,
  /**
   * 商店：相邻两条 8543（刷新）之间的最小间隔（毫秒）。
   * 必要性：刷新只由 `#refreshFor` 触发，其预算按店独立、不在 8540 INFO 时归零，节拍又只受
   *   shopGapMs(250) 约束 → 一秒内能连发 6 条 8543，把 `driveSausageRefreshMax` 和刷新币 41010 一起烧光。
   *   取 2000：一店一次停靠最多 3 刷，留出应答 items 落地的时间，也不至于把「刷出货」的机会全让掉。
   */
  shopRefreshGapMs: 2000,
  /**
   * 商店：进图后首次扫商店的延迟（毫秒）。太早会撞上玩家自己的操作窗（面板也发 8540，会互刷 getTime 基准）。
   */
  shopFirstDelayMs: 15000,
  /**
   * 商店：两次完整轮巡（4 个点位逐个 8540）之间的最小间隔（毫秒）。取 10 分：
   *   一局人手只进两次店（间隔 550s），补货不是高频动作。
   */
  shopSweepMs: 600000,
  /**
   * 商店：**自动驾驶开着或低保（type3）还欠**时的短轮询间隔（毫秒）。
   *   到店驻留窗只有 driveShopDwellMs（25s），队员被队长带到店也是同一个窗：睡满 shopSweepMs（10min）
   *   就错过整个驻留窗；低保停购期也要短轮询赶上「离店→换店再到店」。取 3000：赶得上驻留窗，
   *   又不至 shopGapMs(250) 节拍空转（取代本引擎对已废 driveScanMs 的读）。
   * @type {number}
   */
  shopWatchMs: 3000,
  /**
   * 攻击警告：判定「我确实被盯上」的**连续存活窗**（毫秒）。
   * @deprecated 面板档定为「num>0 立即转移」后本键已无消费者；warn.js 并入自动驾驶后停止读取，仅留 storage 兼容。
   */
  warnAliveMs: 8000,
  /**
   * 攻击警告：转点后的**再评估静默**（毫秒）。
   * @deprecated warn.js 并入自动驾驶后停止读取；pilot evade 冷却改读 driveEvadeCooldownMs，仅留 storage 兼容。
   */
  warnMoveCooldownMs: 45000,
  /**
   * 驾驶：**evade 专属冷却**（毫秒）：上一次逃后本值内不再重发 evade（不抬全局路由锁，不拦常规选点）。
   *   承接旧 warnMoveCooldownMs(45s) 语义：转移闭环 31~44s，不到达不重评；
   *   pilot #dispatch 取 `max(本值, driveThreatReEvadeMs)`，两键任何相对大小都不互相遮蔽。
   * @type {number}
   */
  driveEvadeCooldownMs: 45000,
  /**
   * 驾驶：**威胁窗内可再逃**的触发阈值（毫秒）。首次逃后，若 21534 num>0 仍持续超过本值
   *   → 复位 `#threatEvaded` 允许再挪一次（原「一次威胁窗只逃一次」在持续抓车时会困死）。
   *   ⚠ 耦合：evade 冷却（pilot #dispatch）取 `max(本值, driveEvadeCooldownMs)`，本值小于 45s 时
   *   实际再逃时刻由 driveEvadeCooldownMs 决定（取 max 是为两键任何相对大小都不互相遮蔽）。
   * @type {number}
   */
  driveThreatReEvadeMs: 30000,
  /**
   * 驾驶：**整场再逃次数上限**（次）。防「挪车循环烧队列」，与 `driveThreatReEvadeMs` 配合。
   * @type {number}
   */
  driveThreatReEvadeMax: 2,
  /**
   * 攻击警告：转移引擎的空闲轮询兑底（毫秒）。
   * @deprecated warn.js 并入自动驾驶（pilot 威胁块）后停止读取，仅留 storage 兼容。
   */
  warnScanMs: 3000,
  /**
   * 驾驶：21534 警告验真的本点占用快照新鲜窗（毫秒）。
   *   1115 复核（warn-reaudit）：21534 恒只有 {num} 无 UID——BOSS 交战期大 num=争夺计数
   *   （46/46 本点无 enemy UID）、井位到点 num=1=到点噪声（9/10）。仅「快照够新鲜且带 uid 列表」
   *   才敢判误告忽略；超窗按证据不足保守置威胁。实录 62 条警告快照龄均 ≤1.2s，取 15s 留足余量。
   */
  warnVerifyAgeMs: 15000,
  // ── 自动驾驶（pilot.js）──
  /**
   * 驾驶：状态机空闲轮询兜底（毫秒）。kick 源是 21534/21529/21535/21521（10018 只写快照不 kick），
   *   本值只兜「推送漏拍 + 驻留/冷却计时到点」的重评节奏。
   * @deprecated v4 重写作废：相位推进改由 cd 账本（driveMarchCdSec）驱动，本键停止读取，仅留 storage 兼容。
   */
  driveScanMs: 5000,
  /**
   * 驾驶：一笔 8521 发出后到 21529 到达推送之间的**确认超时**（毫秒）。
   * 一整套开车闭环 31~44.2s，取 90s 给两档余量；
   *   超时即放弃该目标记消费转重评（防「目的地永远到不了」把状态机锁死在 TO 相位）。
   * @deprecated v4 重写作废：确认超时并入 cd.march 账本（driveMarchCdSec），本键停止读取。
   */
  driveMarchTimeoutMs: 90000,
  /**
   * 驾驶：到点 WORK 相位的**固定驻留时长**（毫秒），驻留满即记消费走人。
   * 现仅用于「无采集进度信号」的点（BOSS 平台 176 让 boss.js 打仗、其余非资源/掉落点）；
   *   资源点 173 / 掉落箱 163 走「拿空当拍即走」（拿不空受 driveWorkMaxMs 天花板兜底），不吃本值。
   *   取 45s：覆盖到点后 BOSS 攻打/一整套采集闭环上限 44.2s。
   * @deprecated v4 重写作废：到点驻留改由 driveResStaySec +「拿空即走」判定，本键停止读取。
   */
  driveWorkDwellMs: 45000,
  /**
   * 驾驶：**资源点/掉落箱「拿空」后**再多驻留的 settle（毫秒）。
   * @deprecated 判空两路料源（21522/21532 账归零、10018 rTime/iNum）皆为服务器结算后权威态，
   *   拿空当拍即走不再留 settle 地板，本键停止读取，仅留 storage 兼容。
   */
  driveEmptyDwellMs: 0,
  /**
   * 驾驶：**终局奖励弹窗保持窗**（毫秒）。大BOSS 确证死局（state30/墓碑）后先冻住路由/驻留本值时长，
   *   让游戏奖励弹窗完整展示/领取；窗满派最后一趟商店，驻留结算后本场自动驾驶永久收场
   *   （再勾启用也不复活，换场 fightBeginTime 变化才复位）。用户拍板 2026-11-17 固定 5s，不上面板。
   * @type {number}
   */
  driveEndgameHoldMs: 5000,
  /**
   * 驾驶：**商店到店驻留**（毫秒，面板可配）。到店后 shop.js 逐行补货（8540/8542/8543），
   *   驻留满即离店；与「大BOSS 前定点勤务」和 reactive 补货共用本值。默认 25s。
   */
  driveShopDwellMs: 25000,
  /**
   * 驾驶：**商店每补一件**的驻留预算（毫秒）。到店驻留时长按 `待补件数 × 本值` 动态放宽，
   *   取 3000：覆盖一次 buy(shopBuyGapMs=600) + 一次 refresh(shopRefreshGapMs=2000) + RTT。
   */
  driveShopUnitMs: 3000,
  /**
   * 驾驶：**缺口未补时的续留上限**（毫秒）。WORK 相位到点但 `#shopWant` 仍返回 sausage（缺口未补）时，
   *   在 `#workUntil` 之上最多再延本值后强制离店（防新永动：仍受 `#shopAllTried` + `driveShopStayMs`
   *   全局路由锁 + 窄筛 pickShop 到店冷却约束）。
   */
  driveShopExtraMs: 20000,
  /**
   * 驾驶：**到店即锁路由**的时长（毫秒）——这是一道**全局路由锁**：停靠期内阶段网关链一次都跑不到日常档，
   *   于是「在店里把货扫完」不会被下一拍的选点逻辑打断，离店后还额外有 15s 不许再被拉回任何店。
   *   取 15000（同时用作 #enterWork 的 shopCoolUntil 下限）：只靠 3s 同点去重时，
   *   25s 驻留满即完全解锁 → 表现为「自己不出来、手动拉出去又自动回商店」，一局能回同一家店 11 次。
   */
  driveShopStayMs: 15000,
  /**
   * 驾驶：**同一家店两次到店的**最小间隔（毫秒）。
   *   ⚠ P2 双轨收一轨后无代码消费者（老 #pickShop 的 revisit 闸已删）：窄筛 pickShop 用全店共享
   *   3s 到店冷却 + `driveShopIntervalMs` 节拍，不再吃每店 revisit 窗。保留键位防面板/存档引用断裂。
   */
  driveShopRevisitMs: 480000,
  /**
   * 驾驶：**商店补货到店后的冷却**（毫秒）。
   *   ⑥ 补货档是纯电平闸（背包缺口 = 去商店），而缺口很可能“永远补不满”（商店无货/额度空/刷新币不足），
   *   且到店后本档没有「已办」概念，容易形成「车在商店→驻留 25s→离店→缺口仍在→又开回同一商店」的永动，
   *   手动拉出去也会被拉回。故到店即计冷却，冷却期内不再因缺口派车。
   *   取 10 分钟：与 driveConsumedTtlMs / 资源点刷新量级同档，足够让人手动接管，也不至于永不补货。
   */
  driveShopGapCooldownMs: 600000,
  /**
   * 驾驶：资源/掉落点「拿空即走」的**安全兜底上限**（毫秒，不露面板）。
   * 到点判空已有两路（CHANGE 过渡 + 10018 当前态 rTime/iNum），「到点即空」由当前态路当拍即判即走、不吃本值；
   *   本上限只兜「两路都探不到拿空」（真满载且我们的拾取清单拾不完、或快照与 CHANGE 双缺）的极端形态，防死守。
   * @deprecated v4 重写作废：兜底上限并入 driveResStaySec，本键停止读取。
   */
  driveWorkMaxMs: 45000,
  /**
   * 驾驶：消费点（去过的资源/掉落/商店点）的**解禁 TTL**（毫秒）。
   * 取 10 分钟：与资源点 refreshTime 的刷新量级、商店轮巡 shopSweepMs 同档（补货不是高频动作）；
   *   过期后允许重去（资源点会刷新、商店额度会回补），防「快照里的点被一次性烧完」后永久罢工。
   * @deprecated v4 重写作废：消费点解禁改由 cd 账本管理，本键停止读取。
   */
  driveConsumedTtlMs: 600000,
  /**
   * 驾驶：**大BOSS 前定点商店勤务**的触发时刻（相对整场 `fightBeginTime` 的秒数组）。
   * 整场口径：fightEnd−fightBegin=3300s(55min)；
   *   小BOSS 攻打窗开 ≈ +1380s(23min)、**大BOSS 攻打窗开 ≈ +2400s(40min)**。
   *   三只 BOSS 在 0~23min 全是 state22（不可开打）→ 这段是纯巡航空档，把「大BOSS 前必去的一趟商店」办掉最安全。
   *   取 [600,900,1200]（10/15/20min）：任一时刻命中即把「去一家 161」排进**链尾兜底**（不抢采井/打野），
   *   未真上线则每拍重试、天然覆盖后两点，到店（进 WORK）即置本场勤务完成、不再重复；
   *   late-entry（elapsed 已过 20min）也会立刻进入候选（定期去店仍主要靠 driveShopIntervalMs 的 8min 节拍）。
   * @type {number[]}
   */
  driveShopPointsSec: [600, 900, 1200],
  /**
   * 驾驶：**BOSS 开台前预置窗口**（毫秒，不露面板）：
   *   state22 的 `stateEndTime` = 转 21（开启争夺）的**绝对毫秒时刻**（见 21535 段的 `stateEndTime` 口径），
   *   距开启 ≤ 本值即提前把队伍挪到就近可用 176 平台——行军本身要 31~44s（见 driveMarchTimeoutMs），
   *   等 21 推送到了再挪必然把开台前几十秒的争夺窗烧在腿上。
   *   取 60000：行军上限 44.2s + 一拍兜底 5s，60s 恰好覆盖。
   * @deprecated v4 双轨迁移入口：读取以 drivePlaneLeadSec（秒）为准，本键仅用于 load 时 ms/1000 换算。
   */
  driveBossLeadMs: 60000,
  /**
   * 驾驶：**无候选静默上限**（毫秒）。视口快照里连续这么久没有任何可去的 173/163（全被抽空、等别人用完刷新）时，
   *   方向盘不再原地等：主动朝未覆盖方向开一段，用行军把新视口的 10018 推出来。
   * 若视口内 173 全被别队抽空、rTime 落在 2~3 分钟后，原地等就是干等 3 分钟；
   *   而 10018 只覆盖视口，不移动就永远看不到别处的井。取 30s（≈6 拍）：给「马上刷新」留耐心，又不至于长期停摆。
   *   0 = 关闭探索（无货就原地等）。
   * @deprecated v4 重写作废（探索档见文档 §10，本次不入）：本键停止读取。
   */
  driveIdleExploreMs: 30000,
  /**
   * 驾驶：**探索步长**（格）。无候选时朝 8 扇区轮转方向各走这么远，落在已见点位上就换下一个方向。
   *   取 12：约一个视口半径量级，既能推出新点位，又不至于把一趟行军拉成两百格长跑（行军 31~44s 是硬成本）。
   * @deprecated v4 重写作废（探索档见文档 §10，本次不入）：本键停止读取。
   */
  driveExploreStep: 12,
  // ── pilot 主动视口 / 表格锚点 / 到点分派 ──
  /**
   * pilot：**901 主动拉视口的最小间隔**（毫秒）。
   * 候选池不靠 10018 push 积累（push 只在镜头扫过时来，
   *   tiles.size 常年 2~3），而是每 3s 以自己（或开台中的 BOSS）为中心主动拉一刀（20×30 格）。
   * 取 3000。
   */
  driveViewMs: 3000,
  /**
   * pilot：**空闲态 901 拉视口的放宽间隔**（毫秒，四-1 自适应降频）。
   * WORK 驻留/bossWait 让路/无候选静默期不做选点决策，每 3s 一刀纯属烧查询
   *   （24 场实证整场 900~1075 次）→ 这些拍放宽到 12s；决策拍仍走 driveViewMs，
   *   外部事件 kick 经 #viewKick 位立即恢复常规口径（判据见 view-throttle.js）。
   */
  driveViewIdleMs: 12000,
  /**
   * pilot：901 连续失败多少次后判定「秘境里这条通道不可用」，退回 push+锚点模式（仍能开商店/BOSS）。
   * 退避重试间隔 driveViewRetryMs（不因一次抖动就永久关掉）。
   */
  driveViewOffAfter: 3,
  /** @type {number} pilot：901 判定不可用后的重试间隔（毫秒） */
  driveViewRetryMs: 60000,
  /**
   * pilot：同一目标点「已派过车」的冷却（毫秒）——
   *   治「到点拿不到东西→下一拍又选中同一个点」的原地打转。
   */
  driveMarchedTtlMs: 60000,
  /**
   * pilot：资源点选点的最小产出（固定 5，不读队伍人数）；
   *   低于这个数的井坑收益抵不上 31~44s 行军成本。
   */
  driveResourceMinYield: 5,
  /**
   * pilot：**宽松档（巡航兜底）采井的产出下限**（件数）。
   *   宽松档传 0 时 `iNum==0` 的空井也会入选 → 出现「4 秒到点即判空走人，下一拍又被缺香肠档拉回商店」
   *   的空点—商店秒级往返。
   *   取 1：只排除「快照里明确为 0 件」的点（`iNum` 读不到仍放行，保持宽松档的探索用途）。
   */
  driveCruiseMinYield: 1,
  /**
   * pilot：**巡航选点的快照新鲜度惩罚**（分/秒，1115 问题2）：pickResource 打分按瓦片上次更新距今的秒数
   *   线性扣分（`score -= ageSec × 本值`），优先近期被 10018 push/视口更新的井——陈旧快照 teams=0
   *   可能已被他人抢先占领（到点即 PVP）。取 0.1：3min 陈旧扣 18 分，足以让位近期视口井，
   *   又不致把视口外高产井一棍打死（视口外陈旧不可完全消除，到点占用即 evade 兑底仍在）。0=关闭惩罚。
   */
  driveStaleScorePerSec: 0.1,
  /**
   * pilot：**商店勤务的定期节拍**（毫秒）：距上次到店超过本值且当前点不是商店 → 再去一家
   *   （#shopWant 的 `stage` 档，抢在日常链前）。「勤务/缺香肠/持有缺口」三档**不拦路**，只作链尾兜底那一下的选店排序。
   * 取 8 分钟（5 分钟会把手上的百兽箱/香肠额度提前榨干，且和到店冷却打架）。
   * @deprecated v4 双轨迁移入口：读取以 driveShopIntervalSec（秒）为准，本键仅用于 load 时 ms/1000 换算。
   */
  driveShopIntervalMs: 480000,
  /**
   * pilot：开局多久之后才把商店列为待办（毫秒，相对 fightBeginTime）。
   * 刚进场那半分钟落地/开镜都没稳 → 开局 63s 内不把商店列为待办。
   */
  driveShopWarmupMs: 63000,
  /**
   * pilot：香肠携带目标（`41011 < 本值`）——兼作「链尾兜底有理由再去一家店」的排序依据。
   *   ⚠ 它**不抢在采井/打野之前**（那是拦路电平闸，一局能开出 11 次回店）。
   */
  driveSausageTarget: 10,
  /**
   * pickup §9.3/§9.4 **自愈补拉的点位静默窗**（毫秒，键 `r@x,y`/`d@x,y`）。
   *   竞品语义：`drop_list` 按箱 `endTime` 去重（未过期不再主动 8532），到点 8526 由 `onPabTeamMarchArrive` 触发一次；
   *   我方 8532 应答若带回 `endTime` 会**覆盖**本 TTL 改为按箱到期日静默，取不到才退回本窗。
   *   取 30s：与驻留窗（173/163 拿空即走）同量纲，宁可慢一轮也不拿视口内的远点刷查询包。
   * @type {number}
   */
  selfFetchTtlMs: 30000,
  /**
   * pilot：BOSS 读秒（state22）**结束后的宽限窗**（毫秒）。读秒一结束 BOSS 就转 21 可打，但 21 的推送可能迟到、
   *   而 `stateEndTime` 已过期——若此时窗口判 null，车会从平台上落下去巡航，把整场 BOSS 让掉。
   * 读秒已过期（`state==22 && stateEndTime < now`）仍照打，不做硬筛。
   *   取 90s：覆盖大BOSS 一轮 8~11s + 返航 + 推送延迟，且远小于下一轮开台间隔。
   */
  driveBossGraceMs: 90000,
  // ── pilot 策略档位（玩法分层与各策略开关）──
  /**
   * pilot/leave：玩法分层（0 只拿百兽箱 / 1 加打 BOSS / 2 全都要）。
   *   它决定 `exitStage`（该收场）的三级判据取哪一级，以及是否走 BOSS 档。取 2。
   */
  driveTeamType: 2,
  /**
   * pilot 行军策略：0 避让优先 / 1 跟队集结优先 / 2 摇人优先。
   *   0：被锁定或在途时改道去「野怪/井/店」；1：不查别人在途行军（跟队派）；2：在途即静止等待。
   */
  driveMarchPolicy: 0,
  /**
   * pilot 打野策略：0 打野优先于采井 / 1 采井优先于打野 / 2 完全不打野。
   *   ⚠ v4.2 起面板抓宠等级 `drivePetLevel`（0=不抓宠，1~4=至少 N 星）为上层开关：0 时 pilot 直接把打野三档
   *   短路（beastOff，等价本值=2），本 tuning 仅决定「开启抓宠时打野与采井的先后」。
   */
  driveBeastPolicy: 0,
  /**
   * pilot BOSS 挑选策略：0 跳过第 3 近的 BOSS / 1 跳过最近的 /
   *   2 跳过「石头奖励已领过且我到场打过」的 / 3 跳过任何有石头记录的。
   */
  driveGuardPolicy: 0,
  /** @type {number} pilot 打野档的最小品质（enigma_beast 行 quality ≥ 本值才去）。作面板 drivePetLevel 的回落缺省 */
  driveBeastMinQuality: 4,
  /**
   * pilot：读秒**开始前**的禁店窗（毫秒）与窗宽（毫秒）。判据
   *   `!bossBaseInfo.find(state==22 && abs(stateEndTime - now - 60000) < 60000)` → 即开台前 0~120s 一律不去店
   *   （这段路上车必须空出来挪平台）。
   */
  driveShopBossLockMs: 60000,
  driveShopBossLockWinMs: 60000,
  /**
   * pilot：读秒**结束后**的高光窗（毫秒基准 + 窗宽）与窗内节拍。判据
   *   `abs(stateEndTime - now - 150000) < 30000 && gap > 120` → 即开台后 120~180s（拍宠/结算高光期）
   *   把到店间隔从 8 分钟砍到 2 分钟：这段时间店里会刷出百兽箱与牛排。
   */
  driveShopNearEndMs: 150000,
  driveShopNearEndWinMs: 30000,
  driveShopNearEndGapMs: 120000,
  /**
   * pilot：打野档的禁走窗（毫秒）。判据
   *   `team_type>0 && bossBaseInfo.find(state==22 && abs(stateEndTime - now - 90000) < 90000)` → return
   *   （读秒结束后 0~180s 留给拍宠与平台，不把车撒去野怪点）。
   */
  driveBeastNoMarchMs: 180000,
  /**
   * pilot：在途行军集合的保鲜期（毫秒）。901 每 3s 一刀，本值只兜「901 降级/长时间未刷新」：
   *   集合过期就不再用它筛候选，否则旧快照会把所有点永久标成「别人在途」，车一个点都选不中。
   */
  driveMarchStaleMs: 15000,
  /**
   * pilot：井/箱严格档的产出下限增量与距离上限（距离上限 100 格）。
   *   「该收场」阶段只打**近处大井**，别为远处的井跑 40s。
   */
  driveStrictResMaxDist: 100,
  /**
   * pilot：巡航资源档「单跳车程上限」（秒）。远于此的丰盛井不直冲，改在近处挑跳板点一步步挪过去。
   *   动机：8521 行军一旦发出不可取消，长途＝把后背亮给守株待兔的人（实测案例：直冲 38 格外的井，
   *   落地即被围、井还是空的，14s 车程足够敌人赶到，最终战败 8552 复活）。逐跳逼近把每趟车程压到可反悔的量级。
   *   实际最大距离 = 本值 × driveMapUPS（换算成格）。默认 10 ≈ 28 格：只拆掉偶发的长途（本场 p90≈44），
   *   常规 hop（p50≈25）基本不受影响。离线回落：本值设 0 / 非正数 = 不封顶（退回旧行为，直冲打分最优）；
   *   但面板 driveHopSec（min 1、sanitizeDrive clamp [1,120]）在线时恒 ≥1，故经面板驱动的实跑不会出现不封顶。
   *   需求 3：面板「最长单跳车程(秒)」(cfg.drive.hopMaxSec) 缺省覆盖本值（本值仅作缺省/离线回落）。
   *   需求 3/4：窗内无「最合理井」落脚跳板时，pilot #hopTowardGoal 改就近向打分最优井逼近一个资源点/平台/野怪(172)作跳板（只挪位、不打野）。
   * @type {number}
   */
  driveHopMaxSec: 10,
  /**
   * pilot：秘境地图行军速度换算（格/秒），供 driveHopMaxSec 把「车程秒」折算成选点用的「距离格」闸。
   *   取自真人录制的 dispatch→arrive 实测中位数（约 2.8 格/秒，稳定）。仅作换算系数，不做 ETA 预测。
   * @type {number}
   */
  driveMapUPS: 2.8,
  /**
   * pilot：巡航资源选点「强异能区牵引」开关。开启后，当候选井里存在「开放回合更晚」的区域（realm[esrId].roundid
   *   取最大值 = 强异能区，字典 FAQ25「先开微异能区、后开强异能区」）时，goal 优先从该区取（哪怕更远），
   *   再经 driveHopMaxSec 的单跳跳板步步逼近——解决「长时间在普通/微异能区随缘逛」。
   *   只微区开放（全候选同档）或取不到 roundid（离线/无该行）时不改变原打分，向后安全。
   *   默认 1=开启；设 0 = 关闭分区牵引（退回纯按产量-距离打分）。
   * @type {number}
   */
  driveStrongPull: 1,
  /** @type {number} pilot：停在 172 野怪点的驻留（毫秒）（等拍宠/交战结算） */
  driveStayMonsterMs: 20000,
  /**
   * pilot：173 井的动态驻留（`min(res_stay_time, 未拿件数 × 0.8 + 1.1)` 秒）。
   *   主判据仍是「拿空即走」，本组值只作**兜底上限**（推送缺件时不至于无限占坑）。
   * @deprecated v4 合并迁移入口：驻留上限读取以 driveResStaySec（秒）为准，本组三键仅作 load 换算。
   */
  driveResStayPerBagMs: 800,
  driveResStayBaseMs: 1100,
  driveResStayMaxMs: 8000,
  // ── v4 竞品B（enigmaSecret）对齐新增（见文档 §8；旧键不删、只停读，`load` 里做双轨换算）──
  /**
   * pilot：**心跳/行军到点重评的最小间隔**（秒，对齐竞品 `march_cd`）。
   *   取代旧 `driveScanMs`(5000ms)+`driveMarchTimeoutMs`(90000ms)：新 pilot 的相位推进由 cd 账本驱动，
   *   本值只是「一笔 8521 发出后到下一拍重评」的最短冷却。
   * @type {number}
   */
  driveMarchCdSec: 3,
  /**
   * pilot：**战败复活(8552)后的行军锁定**（秒，对齐竞品 §9.5 「发 8552 后 cd.march=now+2」）。
   *   给复活落地留窗，防同拍又发 8521 把刚复活的队再拖走。
   * @type {number}
   */
  driveReviveLockSec: 2,
  /**
   * pilot：**打野（拍宠/讨伐异能兽）动作冷却**（秒，对齐竞品 `beast_cd`）。
   * @type {number}
   */
  driveBeastCdSec: 10,
  /**
   * pilot：**BOSS 相关动作冷却**（秒，对齐竞品 `boss_cd`）。
   *   ⚠ 方案①下 pilot 只负责「选 BOSS + 开上 176 平台」，打 BOSS 的 8521 让位 boss.js；
   *   本值约束的是 pilot 侧的挪台/选台节拍，不是攻打节拍。
   * @type {number}
   */
  driveBossCdSec: 1,
  /**
   * pilot：**平台（176）挑选策略**（对齐竞品 `plane_policy`，v4.1 已在 pilot.js #pickPlane 实装）。
   * 0=近优先（缺省，含占用/在途筛） / 1=无视占用与在途硬占（竞品 `plane_policy==1 ||` 短路同位） /
   * 2=远优先（竞品 `(policy < 2 ? 1 : -1)` 的距离排序方向位）。
   * @type {number}
   */
  drivePlanePolicy: 0,
  /**
   * pilot：**大BOSS 开台前预置挪台窗口**（秒，对齐竞品 `plane_time`，双轨于旧 `driveBossLeadMs`）。
   *   取 60 ≡ `driveBossLeadMs:60000`；`load` 时若 storage 只有旧 ms 键则 `ms/1000` 换算入本键。
   *   ⚠ v4.2 起本值作面板 `drivePlaneLeadSec` 的回落缺省：pilot #bossWindow lead 档优先读 cfg().drive.planeLeadSec。
   * @type {number}
   */
  drivePlaneLeadSec: 60,
  /**
   * pilot：**资源/掉落点到点驻留上限**（秒，对齐竞品 `res_stay_time`）。
   * @deprecated 拿空当拍即走、不再加动态驻留地板（work-mode.js resDwellMs 已删），本键停止读取，仅留 storage 兼容。
   */
  driveResStaySec: 8,
  /**
   * pilot：**商店勤务定期节拍**（秒，对齐竞品 `shop_interval`，双轨于旧 `driveShopIntervalMs`）。
   *   取 480 ≡ `driveShopIntervalMs:480000`（8 分钟）。
   * @type {number}
   */
  driveShopIntervalSec: 480,
  /**
   * pilot：**战力差预检开关**（对齐竞品 `option.check_power`）。
   * @deprecated 检查方式未定案，先废弃：威胁档恒按保守照逃（hold 恒 true），8549 探针已删，本键停止读取，仅留 storage 兼容。
   */
  driveCheckPower: false,
  /**
   * pilot：**战力差探针结果缓存**（毫秒）。
   * @deprecated 随 driveCheckPower 一并废弃（8549 探针已删），本键停止读取，仅留 storage 兼容。
   */
  drivePowerGapTtlMs: 4000,
  /**
   * pilot：**遭遇战连输即逃**的连输场数阈值（系统默认不露面板）。三局两胜口径：
   *   连输达到本值（21523 对手胜场 +1 且回合递增记一输，己方胜场 +1 清零）且本场未逃过 → 逃往无队资源井。
   *   LL 与 WLL 触发、LWL 不触发；isEnd/异点/回合回退/stop 复位连输账。
   * @type {number}
   */
  drivePvpFleeLossStreak: 2,
  /**
   * pilot：本场已到场打过的 BOSS 是否计入跳过账（与 `guard_policy==2` 联动）。
   *   true=跳过重复目标；false=只按石头奖励记录判（更激进，会重打同一个）。
   */
  driveBossDedupe: true,
  /**
   * shop：为「刷出香肠」而连续刷店的上限（次/每次到店）。
   *   香肠 `specId=19` 的 `buy_times=1`——一根一次刷新，买 N 根需 N−1 次刷，故本值必须按
   *   `driveSausageTarget − 1 + 冗余` 取、**勿低于目标数**（取 12 ≡ 目标 10 需 9 刷 + 冗余 3）。
   *   真实成本闸门是刷新币 41010 余额预检（shop.js #refreshFor 已有，与游戏 tips enigma_realm74 同口径），
   *   本预算只是防「余额充足却永不刷新」的兜底上限，本身不是成本闸门。
   */
  driveSausageRefreshMax: 12,
  /**
   * shop：香肠刷店**连续未命中止损**（四-2）：连续这么多次 8543 刷新后货单上仍无香肠货位
   *   → 本店本场不再刷并通知 pilot 提前离店（实证 11-07 场 (154,314) refresh=6 buys=0：
   *   货单随机不含目标品时逐次刷纯烧币）。命中（刷出香肠货位）即清零重计；0=关止损。
   *   与 driveSausageRefreshMax 总量闸互补：总量闸防「刷到买满」无限刷，本闸防「永不命中」白刷。
   */
  driveSausageRefreshMissMax: 3,
  /**
   * pilot：两次复活的最小间隔（毫秒）。8552 应答可能迟到，本值防同一次死亡反复消耗复活次数。
   */
  driveReviveGapMs: 15000,
  /**
   * 拿满自动离场（leave.js）：扫描间隔（毫秒）。
   * @deprecated 二轮收口废弃拿满自动离场（leave.js 已删）：停止读取，键保留供旧配置/注册表兼容。
   */
  leaveScanMs: 3000,
  // ── 侦察囤情报（scout.js）──
  /**
   * 侦察：扫描间隔（毫秒）。情报囤积非高频动作，本值只兜「快照新增野怪点/重扫冷却到点」的重评节奏。
   */
  scoutScanMs: 5000,
  /**
   * 侦察：相邻两次花道具 8537 的最小间隔（毫秒）——控 41001 消耗速率的主闸。
   * 拍宠窗内可密、窗外应稀疏；本引擎只囤情报、不派兵，取中档 15s：
   *   既不至于把一背包勘察车一口气烧光，又能在整场（~55min）里陆续铺满视野。
   */
  scoutGapMs: 15000,
  /**
   * 侦察：8536 免费预检的两道闸——全局最小间隔（毫秒）与同一点位重查冷却（毫秒）。
   * 8536 不耗道具、可多发，但次通道有按 cmd 的 cdTime 频控（命中静默不上线），故留全局间隔；
   *   同一点位「查到无 beastId」后不立刻再查（等 scoutReQueryMs 后刷新，兼顾新生野怪）。
   */
  scoutInfoGapMs: 2000,
  /** @type {number} 侦察：同一点位 8536 查到未侦察后的重查冷却（毫秒） */
  scoutReQueryMs: 600000,
  /**
   * 侦察：172 候选快照的新鲜度上限（毫秒）。#tiles 只由 10018 视口增量 push 写、车离开后不再刷新，
   *   陈旧快照里的点可能已被拍掉/移走，拿去发 8537 会撞 enigma_realm159（报文实证 20261114 队长场
   *   同一点 41s 内两拒）；超过本窗的候选不进择优序，等下次进视口 push 刷新后再探。取 60s 与 pilot bossTileFreshMs 同量级。
   */
  scoutTileFreshMs: 60000,
  /**
   * 侦察：为背包勘察车保留的最低余量（个数）——`getItemNumById(41001) <= 本值` 即不再花道具侦察。
   * 默认 0=有多少探多少（勘察车非商店货、只能从野怪点产出拾取，无「留货打关键兽」的既有语义）；
   *   若日后要把勘察车留给手动择宠，调高本值即可（面板不暴露，内置调参）。
   */
  scoutItemReserve: 0,
};

// 未真正发出的哨兵码：单一真相在 core/util.js，此处按玩法聚合面 re-export，子 feat 仍从 './constants.js' 取。
export { CODE_NOT_SENT } from '../../../core/util.js';
