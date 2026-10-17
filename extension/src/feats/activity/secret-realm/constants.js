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
 * ENIGMA_SECRET_ROOM_MARCH_MOVE：行军到某瓦片（req {x,y}）——「上临时停泊平台」与「攻打 BOSS」是同一个入口。
 * 报文实证 dashcam 20261017T210400：攻打 boss12@(230,234) 发的是 `8521 {x:230,y:234}`（起点必须是同区域平台），
 *   源码 verbatim RealPabController.sendToBuildingMarch = `checkRequestIdNoRes(8521) || sendPBV2(8521,{x:e,y:t},…)`。
 * @type {number}
 */
export const CMD_MARCH_MOVE = 8521;
/**
 * ENIGMA_SECRET_ROOM_POINT_INFO：拉某点位驻军明细（req {x,y}）。
 * 源码侧证（RealPabController.requestBuildingTeamsInfo）；本期 BOSS 攻打只用 21535/瓦片 extData，未接入。
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
 *   → **不要求队伍站在石头点位上**（与掉落箱/资源点的 158「小队尚未抵达」那族完全不同）。
 * @type {number}
 */
export const CMD_BOSS_GUARD_GET = 8548;
/**
 * ENIGMA_SECRET_ROOM_MARCH_ARMY_INFO：拉编队各支军队的血量（req `{uid}`，**uid 是字符串**）。
 * 报文实证 req = `{"uid":"14913381732485"}`；resp = `{playerInfo, infos:[{armyPower,maxArmyPower,power,marchId:{_low,_high,_unsigned},heros,armys}]}`。
 * 源码 verbatim NWorldPabTeamSelfPopup.updateView，且治疗成功后游戏自己会再发一条（报文里 8584↔8534 严格交替、间隔 0.5~0.6s）。
 * @type {number}
 */
export const CMD_MARCH_ARMY_INFO = 8584;

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
 * ENIGMA_SECRET_ROOM_BASE_INFO：**roomBaseInfo 全量快照**下推（载荷 `{info:{teamId,leaderUid,marchState,startPoint,pointType,targetPoint,fightEndTime,buffMap,…}}` 共 24 键）。
 * 实测 210400 会话 239 条 ≈ 每 17s 一条 + 行军状态变化时补发 → **稀疏，不能当唯一唤醒源**，只用作现场校验与 Int64 料源。
 * `marchState` 观测：1=MARCHING（在飞）2=ARRIVED（到达）21=PAB_FEED；`startPoint` 是**当前所在点**（ARRIVED 时 sp==tp）。
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
 * ENIGMA_SECRET_ROOM_BOSS_GUARD_REWARD_INFO_PUSH：小BOSS 死后掉落的石头点位账本（**全量**下发）。
 * 载荷 `{rewardInfo:[{bossId,fightTime:Int64,rewardInfo:[{pos{x,y,k,rid},rewardNum,rewardMaxNum,isFight}]}]}`；
 *   游戏 Handler：`bossGurardRewardInfo = a.rewardInfo`（源码拼写就是 Gurard）+ emit UPDATE_PAB_BOSS_GURARD_REWARD。
 * 报文实证时间线（210400）：初始 `0/0` 无 F → 参战后 `0/0F` → **BOSS 死亡时 `0/1F`** → 逐点 8548 → `1/1F`；
 *   **每个小BOSS 固定 5 个点位、每人每点位限领 1 次**（rewardMaxNum 只到 1）。
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
 * PUSH_TILEINFO（NResponseIdV2）：世界/秘境地图的**瓦片刷新**下推，秘境图内载荷逐条形如
 *   `{v,x,y,k,id,pointType,m:{viewId,sET,sBT,teams[],esrId,state,iNum,bid,camp,isFight,bPower,ePower,allPower,fTeamIds,…}}`，
 *   `m` 即 extData（实证 210400 会话 7733 条）。**这是 BOSS 攻打侧取「平台↔区域配对键 esrId」的唯一料源**：
 *   ACL 不提供瓦片查询（游戏侧 tile getter 的调用方式未实证，不猜符号链），BOSS 引擎直接订阅本推送自己按 `x,y` 建快照。
 * @type {number}
 */
export const PUSH_TILE_INFO = 10018;

// ─────────── PAB 地图实体类型（NWorldMapCommon，瓦片 type；仅作点位类型留档）───────────
/** @type {number} PAB_BOSS_GUARD_REWARD：小BOSS 死后掉落的石头点位（领取 req 8548） */
export const PAB_BOSS_GUARD_REWARD = 162;
/** @type {number} PAB_DROP：掉落箱点位 */
export const PAB_DROP = 163;
/** @type {number} PAB_MONSTER：异能兽点位 */
export const PAB_MONSTER = 172;
/** @type {number} PAB_RESOURCE：资源/增益井点位 */
export const PAB_RESOURCE = 173;
/**
 * @type {number} PAB_BOSS_PLANE：临时停泊平台（tileArea=1；「攻打 BOSS」必须从这里出发）
 * 瓦片 extData 关键字段：`esrId`（区域配对键）/`state`/`sET`/`teams[]`/`isFight`。
 * **`bid` 与 `viewId` 恒为 11，不是 bossId**（曾据此误判配对关系）。
 */
export const PAB_BOSS_PLANE = 176;
/** @type {number} PAB_BOSS：大BOSS 本体瓦片（tileArea=9） */
export const PAB_BOSS = 177;
/** @type {number} PAB_BOSS_GUARD：小BOSS 本体瓦片（tileArea=9） */
export const PAB_BOSS_GUARD = 178;

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
 * 瓦片 extData 里标识「属于哪个 BOSS 区域」的键（**这是唯一的本地配对判据，但料源残缺**）。
 * 实证（dashcam 20261017T210400）：
 *   • 176 平台共 134 个按 esrId 分两桶（esrId=20 有 78 个、含攻打大BOSS 实用 (208,192)；
 *     esrId=22 有 56 个、含打 boss12 实用 (237,229)、(236,232)）；
 *   • boss9@(203,203) 的 **177 大BOSS 瓦片** esrId=20、boss12 半径 12 内平台全 esrId=22 —— 与所用平台完全对应；
 *   • **178 小BOSS 本体瓦片在整份录音里 0 条**（boss12 本体 (230,234) 的瓦片是 `pointType:0, m:null`，
 *     boss11@(175,177) 干脆 ABSENT）→ 「读 BOSS 本体 esrId」**只对大BOSS 成立**；
 *   • **162 石头瓦片的 esrId 恒为 0** → 石头点位也不能用作区域配对；
 *   • boss11 半径 12 内 0 个平台 = **无任何本地区域证据** → 只能靠「试探一次 + 撞 142 记错区域」学习。
 *   ⚠ 客户端攻打入口 `NWorldPabBossPopup.marchClick` **完全不查 esrId** → 区域是**服务器独占判据**，
 *     本键只是「避免撞 142」的本地优化，不是硬闸。
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
// 投喂道具 specId 5/6（enigma_beast_behave 行 5/6 的 .item → 秘境背包道具，实证 PabPetCaptureNodeNew 取行 (t+5) → `petCaptureOperation(o+5)`）：
//   报文实证同一会话普通拍 changeScore 恒落在 6~11 区间（1451/1517 条），投喂道具与免费手拍同量级却要消耗秘境背包道具
//   → 本 feat 基础拍走免费手拍（SPEC_TAP），不主动投喂，故不导出可投喂集合。
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
 * @type {string}
 */
export const REJ_BOSS_AREA = 'enigma_realm142';
/** @type {string} 请先行军到对应区域的临时停泊平台（我不在 176 平台上，NWorldPabBossPopup.marchClick 同口径 tips） */
export const REJ_NEED_PLANE = 'enigma_realm141';
/** @type {string} 当前资源点内获取物品次数已用完（石头点位已领满，实证重复领同点 8548 回此码）→ 该点位永久拉黑 */
export const REJ_STONE_USED_UP = 'enigma_realm60';
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
  /** 石头：相邻两条 8548 的节拍初值（毫秒），沿用 getGapMs 同曲线退避 */
  stoneGapMs: 250,
  /** 石头：同一 bossId 撞 `isFight!==1`（未参战）后的组级静默（毫秒）——不可恢复，但防改版后变成可领时永久锁死 */
  stoneSkipMs: 600000,
  /** 瓦片 extData 快照的条目上限（Map 保持插入序，溢出丢最早一项；与 tileAccMax 同手法） */
  tileExtMax: 256,
};

/** @type {number} 未真正发出的哨兵码（sendSecret 超时/异常回此值；与 game-api SECRET_NOT_SENT 同义） */
export const CODE_NOT_SENT = -1;
