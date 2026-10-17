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

// ─────────── 秘境推送号（走 watch 通道下行，主 NetReciver 汇聚后由 core/net.js 派 `net.<cmd>`）───────────
/**
 * ENIGMA_SECRET_ROOM_BEAST_EVENT：捕获事件（心动时刻/投喂弹窗）下发。
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
 * 实证 dashcam 20261011T203911：本会话 44 条，切出 7 个在拍窗口，**83/83 条 type=2 心动时刻推送全部落在这些窗口内**
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

// ─────────── PAB 地图实体类型（NWorldMapCommon，瓦片 type；仅作点位类型留档）───────────
/** @type {number} PAB_DROP：掉落箱点位 */
export const PAB_DROP = 163;
/** @type {number} PAB_MONSTER：异能兽点位 */
export const PAB_MONSTER = 172;
/** @type {number} PAB_RESOURCE：资源/增益井点位 */
export const PAB_RESOURCE = 173;

// ─────────── DataConfig 限额键（TableUtils.getDataConfigData）───────────
/** @type {number} 掉落箱可领总量上限（_itemGetMax = Number(dataConfig(3021))；bagGetNum+beastGetNum 计入） */
export const CFG_DROP_ITEM_MAX = 3021;
/** @type {number} 掉落箱宠物已领上限（checkPetIdGeted：已含我 uid 的 dropBeast 数 >= Number(dataConfig(3061)) 即满） */
export const CFG_DROP_PET_MAX = 3061;
/** @type {number} 资源/增益上限串（dataConfig(3013) → "itemMax|buffMax"，split('|') 取 [0]=bag 上限、[1]=buff 上限） */
export const CFG_RES_LIMITS = 3013;
/** @type {number} 手拍每秒次数上限（dataConfig(630027)；实证 RealPabController.checkCaptureOperationCd 用它做 `_touchOperateMaxNum`） */
export const CFG_TAP_LIMIT_PER_SEC = 630027;

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
//   4 能量满释放（chg 300/390、能量归 0）；7/8/9/10 投喂弹窗选项（chg 50/100/200/500）。
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
 *   2 = 心动时刻/拖拽事件（PetCaptureDragNodeNew，**窗口 2.0s**：源码 `_eventEndTime = ClientTime + 2e3`，
 *     报文实证全库 349/349 条 `endTime(Int64 ms) − header.ts×1000 ≡ 2000ms`（跨 4 个会话）；此前记的
 *     「3.2~3.4s」与「0.8~1.3s」都是 endTime 的 Int64 口径读错所致，均已推翻。
 *     成功 → `petCaptureOperation(specId[0])`，能量 +1 且 changeScore=0）；
 *   5 = 投喂弹窗（PabPetFeedEventPopup，选项 = specId 数组即 enigma_beast_behave 行 7..10，
 *     **窗口实测 25.0s**（25/25）；报文实证 changeScore 200~650 档，择优即多拿分。
 *     **发号口径差异**：游戏发的是 `7 + 选项下标`（位置映射），本 feat 发的是候选值本身 ——
 *     实证 25/25 条 specId 恒为满四元 [7,8,9,10]，两者等价；若服务器改为下发子集则会错位）；
 *   3 = 能量爆发演出（specId=[4] + points 数组、endTime 为哨兵值 ≈ Long.MAX/1000，43/43 实证），
 *     客户端无任何消费者，本 feat 也不直接响应它，由 selfenergy 闸覆盖。
 * @type {number}
 */
export const EVT_TYPE_DRAG = 2;
/** @type {number} 捕获事件类型：投喂弹窗（择优选项，见 EVT_TYPE_DRAG 说明） */
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
};

/** @type {number} 未真正发出的哨兵码（sendSecret 超时/异常回此值；与 game-api SECRET_NOT_SENT 同义） */
export const CODE_NOT_SENT = -1;
