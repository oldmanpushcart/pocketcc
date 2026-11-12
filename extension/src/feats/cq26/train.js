/**
 * CQ26 印石·雪原列车（印石专列）自动上车 + 拦截骨架（cq26Train）
 *
 * 玩法链路（与「卡车争夺」是两套独立协议族，别混）：
 *   每日三态窗口（times 以 2365 应答 baseInfo.times 为权威，顶层 data.times 实测恒为 []）：
 *     state=10 GET_ON  上车窗（实测当日 00:00→18:00）→ 本 feat 发 2367 把一队兵挂上专列
 *     state=20 ON_THE_ROAD 行驶段（18:00→22:30）→ 全服互相掠夺，本 feat 走 2369/2375/2370
 *     state=30 REWARD  到站结算（22:30→次日 12:00）→ lane 3 走 2373 领基础奖励 + 2385/2386 翻卡
 *   实测时刻基准（本地墙钟，实录报文的 baseInfo.times）：
 *     1793980800=11-07 00:00 窗开 → 1794045600=18:00 发车 → 1794061800=22:30 到站 → 1794110400=11-08 12:00 结算窗止。
 *
 * 协议（NRequestIdV2 实证，载荷形态逐键抄自实录报文，标注见各常量注释）：
 *   2365 SERIES_FROST_TRAIN_OPEN        req {}                resp {towerId,sfBid,allLootNum,lootNum,towerEnergy,energyProgress,lastTrain,curTrain,times:[]}
 *   2367 SERIES_FROST_TRAIN_MARCH       req {uuid,troop}      resp {isOk:1,troopView}（仅 state=10 允许，实证 RealNBattleModel.startWarTruckFight 与游戏侧按钮闸）
 *   2369 SERIES_FROST_TRAIN_LOOT_VIEW_RELOAD req {}           resp {allLootNum,lootNum,trains:[{uuid,specId,sid,percent,canLoot,uidNumber}]}
 *   2375 SERIES_FROST_TRAIN_OTHER_GET_INFO  req {uuid}        resp {truckView:{selfArmyInfo[],lootRewardResult[],beLootRewardResult[],percent,uidNumber,lootNum,myLootNum,allLootNum,endTime,…}}
 *   2370 SERIES_FROST_TRAIN_LOOT        req {uuid,troop}      resp {uuid,isWin,winNum,lootNum,lootTruckView,rewardResult(胜才带),reportId,reportUrl}
 *   2373 SERIES_FROST_TRAIN_GET_REWARD  req {uuid}            resp {uuid,rewardResult:{resource,items[],goldBrick,exp,armys[],hero[],…}}（uuid = 结算主体 lastTrain.baseInfo.uuid）
 *   2385 SERIES_FROST_TRAIN_CARD_INFO   req {uuid,pageId?,needEmpty:0} resp {uuid,shareRewardHaveNum,cardInfoList[{index,reward,userView}],pageId,pageSize:32,selfRewardAllNum,emptyRewardNum,allRewardNum}
 *   2386 SERIES_FROST_TRAIN_CARD_REWARD req {uuid,index}      resp {uuid,index,shareRewardHaveNum,rewardResult,cardInfo:{index,reward,userView}}
 *   22095 PUSH SERIES_FROST_TRAIN_INFO  {trainList:[{uuid,specId,state:20,stateEndTime,times}],lootNum} —— 发车信号（实证 18:00:00 整点推 1 条）
 *   22096 PUSH SERIES_FROST_TRAIN_DATA  {train:{baseInfo,selfOn,userNumber,lootedNum,rewardGrade,selfRewardRefreshNum,baseRewardGet,shareRewardHaveNum,selfBaseReward[],selfArmyInfo}} —— 每次领奖/翻卡后推 1 条（实测 2373、2386 之后各一条）
 *   22010 PUSH SERIES_FROST_RED_POINTS  {redPoints:[{id:101,num:剩余次数}]} —— 只作唤醒，不作判据（配额以 2369 为准）
 *
 * 闸门判据（实证来源：上车趟与发车+两次拦截趟实录报文）：
 *   - 前置：CQ26 活动开启 + 专列塔(id=4)已激活（游戏按钮闸 isTowerActivated，未激活连面板入口都没有）。
 *     掠夺 lane 同样过塔闸，但**只挡轮询**（塔未激活时 2365/2369 属空转流量）；攻打资格由服务器终裁，不把塔闸当硬禁。
 *   - 上车：state 必须 ===10；selfOn===1 视为已在车上，**同窗绝不重发 2367**（应答 isOk=1 后即乐观置位并睡到窗末，防服务器滞后回读导致二次派兵）。
 *   - 配额：2369 应答自带权威 `allLootNum`(今日上限)/`lootNum`(今日已用)，实测上限 2；打一次即烧一次，**输了也烧**（2370 战败应答 lootNum 照加、rewardResult 键整个缺失）。
 *     配额**缺失**（allLootNum<=0）与配额耗尽同向处理：睡到日界线，绝不把「没读到上限」当成「无限可掠」而空烧 2375/2370。
 *   - 拦截选车：canLoot===1 且 0<percent≤上限（percent 是「车上剩余货物比例」，不是行程进度：命中后 73→70）；
 *     再对 Top-1 发 2375 精判 rank1 防守战力与乘客数（2369 列表项没名单也没奖池，逐车 2375 是数 KB 载荷，故设「每轮精判辆数」上限省钱）。
 *   - 掠夺 troop 与上车 troop 同形（同一份 buildTrainTroop 喂 2367/2370，实测真人两处报文逐字节相同）。
 *   - 列车行军是 MarchType 314，**不进 856 GET_ALL_MY_MARCH_INFO 常驻列表**（实录二十二次应答零命中），但**上车这条路要占行军队列**：
 *     真人手动上车（实证 dashcam 20261111 ts=1794329618637，发包前 856 仅 3 条在途）被服务器拒 `world_130516`=行军队列已满，
 *     即「占用发生在把兵挂上列车这段行军里，挂上去之后不再占」。故 2367 之前设名额闸（读 UserData used/max），
 *     且 856 看不到 314 的占用，**不能拿 856 条数当名额依据**（旧结论「不占名额、不设闸」由此作废）。
 *   - 结算主体是 **lastTrain**（不是 curTrain）：00:00 后 curTrain 翻成今日新车（state=10），而昨日那辆的结算窗开到 12:00，
 *     游侧结算闸读的就是 lastTrain.baseInfo.state===30；因此 settle lane 只看 settleState/settleSelfOn/settleUuid，且额外要求
 *     **窗未过**（主体车在窗止后仍可能报 state=30，只看枚举会成 20s 一次的 2373 空转）。
 *     基础奖励闸 `baseRewardGet!==1`，翻卡闸 `shareRewardHaveNum>保留数`（实测每日 3 次，2386 应答自带权威剩余次数，以其回填内存值）。
 *   - 翻卡是**盲翻**：实证 2385 的 cardInfoList 里未翻位**只有 {index}**（reward/userView 整个缺失），已翻位才带奖品与翻卡人，
 *     故「未翻位判据」取 `!reward.itemId`；挑哪一个在期望值上等价（奖池按车随机分配、270 张全服共享），实现按 index 升序取，
 *     且未翻位列表按**列车 uuid + TTL** 缓存复用（每翻一张重拉 1~9 页属纯浪费），被抢时靠 2386 被拒后摘掉该位自愈。
 *   - 2373 连续被拒 `REWARD_FAIL_MAX` 次即睡到窗末：这是「自己的车」，没有可拉黑的目标，只能靠次数闸止住空发
 *     （记账按列车 uuid，换车归零，否则上一车的失败会永久抵住后面的每一车）。
 *   - 2367 被拒按 `header.d` 的**原始多语言 key** 分三档（`rejectText()` 给的是 key 原文不是译文，按文案子串匹配会恒不命中）：
 *     1) `common_159995` 在本 cmd 语境 = **编队/参数类确定性拒绝**（实证：三连发同 key、逐字节相同，面板把预设队伍换一支即通过）。
 *        同窗重试无意义 → 按列车 uuid 记账，连续达 BOARD_FAIL_MAX 即停发本窗；只短歇**不睡窗末**，用户改面板预设后重启即生效。
 *     2) `world_130516`（行军队列已满）与 CODE_NOT_SENT（在途去重/投递抖动）= **分钟级自愈的可重试态** → 短歇重试；
 *        睡到窗末等于用一个瞬态排队问题烧掉整个 18h 上车窗。
 *     3) 其余/未知 key（窗已过、已在车上等本窗终结态）→ 睡到窗末，并留 reason 供日后录制再分档。
 *   - 编队**忠实投影、不设满编闸**：`buildTrainTroop` 走 `plan().preset(idx).adjust({ ignoreMarched: true }).build()`（**上车 2367 与拦截 2370 共用同一 adjust 口径**，实测两处 troop 逐字节相同）。
 *     重算器在场时每格数被游戏侧 `checkArmyNum` 三重钳制（格容量 ∧ 该兵种持有数 ∧ 按实例展开的可派池逐只扣、跨格共享），
 *     兵不够就自然出**残阵**；重算器不可用则降级为满编原样（这层钳制整体消失，可能超库存）。两种结果**都照发**——
 *     用户决策（2026-11-11）：残阵上车也可以接受，不上车错过得更多。故此处不判 `recalcDegraded`、不加「凑不齐完整预设就顺延」，
 *     降级的可诊断性由 `core/battle.js` 那条 warn 负责，不在 feat 侧改变发送行为。
 *
 * 拦截选目标：物品兴趣驱动（录制实证，uid 11981629951662 两场 4 次 2370）：
 *   4 次攻打 `isWin` 全 false（以我方战力从未能整辆清台，真正收益是 winNum/抢到件数，每攻 0~1 件）；
 *   rank1 战力不预测结果（486.7M 的车抢到货、139.2M 的车空手），乘客数/percent 亦无可辨规律（样本仅 4）——
 *   故**不设 rank1/乘客数/保留次数/精判辆数 数字闸**（这些既不预测战果又属多余设置），用满每日服务器配额。
 *   唯一可读且有用的信号是 2375 的 `truckView.lootRewardResult`（奖池 {itemId,itemCount}，2369 列表不含），
 *   故策略为：2369 免费粗筛（canLoot/货物余量/当日拉黑）→ 按序逐个发 2375，**奖池含「关注物品」才打**、否则换下一辆（内置 PROBE_MAX 防狂刷）。
 *   「关注物品」候选清单取自游戏「奖励预览」表（rewardPoolIds：data_config[REWARD_PREVIEW_CFG]→REWARD 行→道具清单，面板同源），非报文逆推；TRAIN_ITEM_POOL 仅表读不到时兑底。
 *   ① 拦截默认关闭，勾选才生效；② 每次攻打把决策上下文写进本地样本表（cq26Train.samples），胜率仍靠真人次数喂出经验门槛后再谈模型；
 *   ③ 真·拒绝码（header.s≠0）目前零样本，「被拒即当日拉黑」是临时纪律，待录制细分「当日拉黑 vs 本轮跳过」；
 *     例外已先拆一个：`world_130516`（行军队列已满）属我方自身瞬态，**不拉黑**、短歇重试（与 2367 同口径）。
 *
 * 同帧取值与写盘纪律（应答对象池化，代码级红线）：
 *   - 任何跨 await 持有的应答字段必须拆成标量或克隆（uuid 走 cloneInt64）：2375 的 truckView 与 2370 的结算
 *     都**不带引用下传**（detail/res 只装标量），否则写样本表时读到的是被池复用后的错值（静默污染唯一产出物）。
 *   - rejectText(ret) 必须同帧取：reason 为空时回落 safeStringify(ret.data)，而 ret.data 是池化载体。
 *   - 当日表（拉黑/样本）回读**失败** = 禁止整体覆盖写盘（fail-closed）：宁可不记一条，也不能用内存空表抹掉历史；
 *     闸门在 run() 首句建立，waitLoads() 在闸门缺失时就地补建并返回「可否写盘」。
 *   - 三条 lane 的每个 await 之后、任何写请求之前必须复查 aliveFn()：reactor 的 pause 只摘触发器，
 *     不复查则 offInCombat:true 在战斗模式翻转后仍会把真兵派出去。
 *
 * 结算链已补录（报文实证：真人到站后领基础奖励 + 连翻 3 张卡的实录）：
 *   时序 22095(state→30) → 2373{uuid} → 22096(baseRewardGet 0→1) → 2385{uuid,needEmpty:0} → 2386{uuid,index}×3（每次跟一条 22096 + 全服 22097）；
 *   实测本人翻卡 index 12/14/17、shareRewardHaveNum 3→2→1→0、emptyRewardNum 258→255、allRewardNum 270、pageSize 32（即 9 页）。
 *   不做 2377 SERIES_FROST_TRAIN_DEF_INFO：req {uuid}、应答 172KB 的防守名单，属面板「查看防守详情」动作，自动化零收益。
 *   同理不做 2384 刷新奖励：只在 state=10 可刷、每次花钻石、rewardGrade 封顶 5 后再刷属纯亏（实测 11 次 -1100 Gold 且服务端无次数上限），用户已定案不做。
 *
 * 合规：只读游戏数据（经 game-api ACL）+ 直发协议；troop 走 core/battle.js 从预设实时算，不 OpenUI、不碰游戏本地态。
 *   2367/2370 均派真实部队 → 受战斗模式门控 offInCombat:true。
 *   结算 lane 不发 troop，但仍逐 await 复查 aliveFn（暂停语义统一，见上「同帧取值与写盘纪律」第 4 条）。
 *   日志模板一律英文（面板 UI 文案不在此列）；分级按 core/log.js 判据：可预期业务拒绝走 info、
 *   应答畸形/读失败走 warn、循环态不可动作走 debug 且必带 cmd/sid/uuid/state 上下文。
 */
import { CODE_NOT_SENT, todayStr, rejectText } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { storage } from '../../core/storage.js';
import { reactor } from '../../core/reactor.js';
import { netApi } from '../../core/net.js';
import { Battle } from '../../core/battle.js';
import { bits, gameData, gameConf } from '../../core/game-api.js';
import { item } from '../../core/item.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CQ26-TRAIN） */
const log = createLog('CQ26-TRAIN');

// ── 协议号 ────────────────────────────────────────────────────────────
/** @type {number} 2365 SERIES_FROST_TRAIN_OPEN：读列车权威快照（req {}） */
const CMD_OPEN = 2365;
/** @type {number} 2367 SERIES_FROST_TRAIN_MARCH：上车派兵（req {uuid,troop}，仅 state=10） */
const CMD_MARCH = 2367;
/** @type {number} 2369 SERIES_FROST_TRAIN_LOOT_VIEW_RELOAD：刷可掠列表 + 权威配额（req {}） */
const CMD_LIST = 2369;
/** @type {number} 2370 SERIES_FROST_TRAIN_LOOT：对某辆列车掠夺（req {uuid,troop}） */
const CMD_LOOT = 2370;
/** @type {number} 2375 SERIES_FROST_TRAIN_OTHER_GET_INFO：单车详情（防守名单 + 奖池，req {uuid}，数 KB） */
const CMD_INFO = 2375;
/** @type {number} 2373 SERIES_FROST_TRAIN_GET_REWARD：领到站基础奖励（req {uuid}，仅 state=30） */
const CMD_REWARD = 2373;
/** @type {number} 2385 SERIES_FROST_TRAIN_CARD_INFO：翻卡奖池分页（req {uuid,pageId,needEmpty}，每页 32 个卡位） */
const CMD_CARD_LIST = 2385;
/** @type {number} 2386 SERIES_FROST_TRAIN_CARD_REWARD：翻一张卡（req {uuid,index}） */
const CMD_CARD_FLIP = 2386;
/** @type {number} 22095 PUSH SERIES_FROST_TRAIN_INFO：发车推送（state→20 的边沿信号） */
const PUSH_TRAIN_INFO = 22095;
/** @type {number} 22096 PUSH SERIES_FROST_TRAIN_DATA：领奖/翻卡后的全量列车态（带 baseRewardGet / shareRewardHaveNum） */
const PUSH_TRAIN_DATA = 22096;
/** @type {number} 22010 PUSH SERIES_FROST_RED_POINTS：印石红点，id=101 携带剩余可掠次数 */
const PUSH_RED_POINTS = 22010;
/** @type {number} 红点 id：雪原列车可掠次数（实证 22010 redPoints[{id:101,num}]，胜后 1→耗尽 0） */
const RED_POINT_LOOT = 101;

// ── 枚举 ──────────────────────────────────────────────────────────────
/** @type {number} CQ26TrainStatus.GET_ON 上车窗 */
const ST_GET_ON = 10;
/** @type {number} CQ26TrainStatus.ON_THE_ROAD 行驶段 */
const ST_ROAD = 20;
/** @type {number} CQ26TrainStatus.REWARD 到站结算 */
const ST_REWARD = 30;
/** @type {number} CQ26TOWERID.TRANSPORT 专列塔 id（isTowerActivated 入参） */
const TOWER_TRANSPORT = 4;

// ── 择时常量 ──────────────────────────────────────────────────────────
/** @type {number} 窗口边界提前唤醒余量（秒）：到点前后服务器状态切换有秒级抖动，提早一点重读 */
const LEAD_SEC = 20;
/** @type {number} 单拍睡眠硬顶（毫秒）：跨日/超长窗按此封顶，靠后续拍再排 */
const MAX_SLEEP_MS = 6 * 3600 * 1000;
/** @type {number} 快照 TTL（毫秒）：窗内复用，过期才重发 2365 */
const SNAP_TTL_MS = 60 * 1000;
/** @type {number} 写动作成功后的最小间隔（毫秒）：不用 return 0 紧密自旋，留配额与频控余量；实测真人连翻三卡的间隔 2.4~4.3s，5s 偏保守 */
const HIT_GAP_MS = 5000;
/** @type {number} 2373 连续被拒上限：达阈即睡到窗末（自己的车无可拉黑对象，只能靠次数闸止住空发） */
const REWARD_FAIL_MAX = 3;
/** @type {number} 2367 同一列车 param 类（确定性编队配置）连续被拒上限：达阈停发本窗，换车/重启用归零 */
const BOARD_FAIL_MAX = 3;
/**
 * @type {string} 2367「编队/参数类」拒绝 key（header.d 原文；同一 key 在别的 cmd 语境语义不同，此处只按 2367 的实证处置）
 * 实证 dashcam 20261111：三连发逐字节相同皆吃它，换一支预设队伍即通过 → 判为配置/编队超库存的确定性拒绝。
 */
const ERR_BOARD_PARAM = 'common_159995';
/** @type {string} 「行军队列已满」全局通用拒绝 key（实证真人手动 2367 也吃它；队列分钟级回收 → 可重试） */
const ERR_QUEUE_FULL = 'world_130516';
/** @type {number} 未翻卡位列表缓存 TTL（毫秒）：全服都在翻，陈旧列表只会多挨几次 2386 被拒，但重拉 9 页代价更高 */
const CARD_CACHE_TTL_MS = 10 * 60 * 1000;
/** @type {number} 2385 每页卡位数（实测应答 pageSize=32、allRewardNum=270 即 9 页） */
const CARD_PAGE_SIZE = 32;
/**
 * @type {number} 雪原列车「奖励预览」配置 id：data_config[此值] → REWARD 表行键，该行 item/num 列即列车可掠奖池物品清单。
 * 实证 extracted/subpack/CQ26TransportData.getPreviewRewardItems（面板 CQ26TrainRewardPreviewPop.onShow 同源调用）。
 */
const REWARD_PREVIEW_CFG = 52000030;
/**
 * @type {number[]} 「关注物品」候选池的**兜底**（仅在奖励列表表读不到时启用）：录制 uid 11981629951662 奖池实证、均在 ITEM_NAMES 有登记。
 * 权威源是 rewardPoolIds()（走游戏奖励列表）；本常量只作表缺失时的 fail-safe，不作默认判定依据。
 */
const TRAIN_ITEM_POOL = [820016, 820015, 69359, 2300003, 23044402, 62908];
/** @type {number} 拦截每轮 2375 精判的内置安全上限（非面板项）：2369 返回抽样窗口且逐车 2375 数 KB，防对上百候选狂刷 */
const PROBE_MAX = 3;

/** @type {object} 择时参数（activeMs 即「刷 2369 找车」的节奏，实测真人 5 分钟发 6 次） */
const cfg = { activeMs: 60000, idleMs: 10 * 60 * 1000, backoffMs: 20000 };

// ── 持久化键 ──────────────────────────────────────────────────────────
/** @type {string} 当日被拒列车拉黑（storage.data blob 内逻辑名，跨日清空） */
const DATA_NAME_BLOCK = 'cq26Train.blocked';
/** @type {string} 攻打决策样本表（storage.data blob 内逻辑名，跨日重置，供事后回推胜率门槛） */
const DATA_NAME_SAMPLES = 'cq26Train.samples';
/** @type {number} 样本表条数上限（超出丢最旧，防 blob 无界增长） */
const SAMPLE_CAP = 200;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入） */
var MCFG = buildDefaults();
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/**
 * 2365 权威快照（同帧抽取的标量副本；应答对象池化，跨拍持有必须走 clone/拆字段）。
 * @type {{localMs:number,towerId:number,dailyMax:number,dailyUsed:number,state:number,stateEndTime:number,
 *          selfOn:number,userNumber:number,lootedNum:number,rewardGrade:number,refreshNum:number,
 *          baseRewardGet:number,shareHave:number,settleState:number,settleEndTime:number,settleSelfOn:number,
 *          settleTimes:object,uuid:*,settleUuid:*,times:object}|null}
 */
var snap = null;
/** @type {{day:string, uuids:string[]}} 当日被拒列车拉黑 */
var blocked = { day: '', uuids: [] };
/** @type {{day:string, list:object[]}} 攻打决策样本 */
var samples = { day: '', list: [] };
/**
 * 当日攻打次数的**内存计数**（与 2369/2370 的权威 lootNum 取小使用，作第二道闸）。
 * 必要性：若碰上「打了但不烧配额」这一未实证分支（ack.lootNum 不推进），
 *   仅靠权威配额会形成 HIT_GAP_MS 死循环；自计数不依赖服务器就能封顶。
 * @type {number}
 */
var hitsToday = 0;
/** @type {string} hitsToday 所属日子（与 ensureDay 同口径重置）*/
var hitsDay = '';
/** @type {number} 2373 连续被拒次数（成功归零；按列车 uuid 重置，防上一车的失败记账抵住下一车） */
var rewardFails = 0;
/** @type {string} rewardFails 所属列车（bits.int64Key） */
var rewardFailKey = '';
/** @type {number} 2367 ERR_BOARD_PARAM 类（确定性编队配置）连续被拒次数，同窗重试无意义；按列车 uuid 记账 */
var boardParamFails = 0;
/** @type {string} boardParamFails 所属列车（bits.int64Key） */
var boardParamKey = '';
/**
 * 未翻卡位列表缓存（同一列车窗内复用，避免每翻一张重拉分页）。
 * @type {{localMs:number, uuidKey:string, list:number[]}|null}
 */
var cardCache = null;
/**
 * 当日持久化回读闸门：写盘（拉黑/样本）前必须 await 它。
 * 必要性：run() 的回读是异步的，而 cycle 可能当场就打完一次 2370 并 set；
 *   不等完就会用内存里的空表覆盖 blob，把重载页面前累积的历史样本丢光。
 * @type {Promise<void>|null}
 */
var loadGate = null;
/**
 * 当日回读是否**成功落定**（fail-closed：false 时一律禁止写盘）。
 * 必要性：闸门只保证「回读结束」不保证「回读成功」——storage 在命名空间未就绪/桥接异常时**刻意 reject**
 *   （空值与「盘上没数据」同形，会把「还没法读」误判成「没数据」），
 *   若把 reject 当空表放过，第一次写盘就会用空表覆盖整个逻辑键、抹掉历史。
 * @type {boolean}
 */
var loadsOk = false;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 并发回读当日拉黑表与样本表，并把汇合后的 promise 存为写盘闸门、结果存为 loadsOk。
 */
function startLoads() {
  loadsOk = false;
  loadGate = Promise.all([loadBlocked(), loadSamples()]).then(
    function (rs) {
      loadsOk = rs[0] === true && rs[1] === true;
    },
    function (e) {
      log.warn('load daily tables rejected: %s', e && e.message);
      loadsOk = false;
    },
  );
}

/**
 * 等当日回读落定并给出「可否写盘」结论（写盘前必须调用并判返回值）。
 * 闸门缺失时**就地补建**，绝不放行裸写：run() 若在建闸门之前抛错，reactor 只 warn 不阻断，
 *   60s 看门狗会 kick 出一条无闸门的流程，那时只能走 fail-closed。
 * @returns {Promise<boolean>} true = 当日表已回读成功，可安全整体覆盖写盘
 */
async function waitLoads() {
  if (!loadGate) startLoads();
  try {
    await loadGate;
  } catch (e) {
    /* 抛错已在 startLoads 的 reject 分支 warn，这里只保证不向上炸掉 cycle */
  }
  return loadsOk;
}

/**
 * 安装：取网络底座。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  if (installed) return true;
  net = ctx.net;
  if (!net.install()) {
    net = null;
    log.warn('install failed. missing=net');
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入（reactor → 本模块）。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (!partial) return MCFG;
  MCFG = partial;
  if (installed && aliveFn()) {
    boardCycle.kick();
    lootCycle.kick();
    settleCycle.kick();
  }
  return MCFG;
}

/**
 * 运行：读当日拉黑 + 挂推送唤醒 + 点火三条 lane。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  startLoads(); // 必须是首句：写盘闸门要先于任何 kick / 看门狗路径建立（见 waitLoads 的 fail-closed）
  snap = null; // 每次启用重读权威，不复用上一窗陈旧值
  rewardFails = 0; // 被拒计数属本次运行的局部事实，重启即归零
  rewardFailKey = '';
  boardParamFails = 0; // 同上：重启后允许用新配置再试本窗
  boardParamKey = '';
  cardCache = null; // 未翻卡位不得跳运行复用（上一场可能已被人翻空）
  ctx.on.push(PUSH_TRAIN_INFO, onTrainInfoPush);
  ctx.on.push(PUSH_TRAIN_DATA, onTrainDataPush);
  ctx.on.push(PUSH_RED_POINTS, onRedPointsPush);
  log.info(
    'started. board=%s boardPreset=%d loot=%s lootPreset=%d lootItems=%d settle=%s',
    MCFG.boardEnabled,
    MCFG.boardPreset,
    MCFG.lootEnabled,
    MCFG.lootPreset,
    MCFG.lootItems.length,
    MCFG.settleEnabled,
  );
  boardCycle.kick();
  lootCycle.kick();
  settleCycle.kick();
}

// ── 推送入口（只唤醒，不在推送里做业务：三条 lane 都有可重放权威读通道）────
/**
 * 22095 发车推送：state 10→20 的边沿，两条 lane 都重读。
 * @param {object} ev bus 事件
 */
function onTrainInfoPush(ev) {
  if (!aliveFn()) return;
  var d = (ev && ev.data && ev.data.data) || null;
  var st = d && d.trainList && d.trainList[0] ? Number(d.trainList[0].state) || 0 : 0;
  log.debug('22095 push state=%s, invalidate snapshot and kick lanes.', st);
  snap = null;
  boardCycle.kick();
  lootCycle.kick();
  settleCycle.kick();
}

/**
 * 22096 列车全量态推送（实测跟在每次 2373/2386 后面）：把结算两个闸字段并入快照并唤醒结算 lane。
 * 纪律：并入的必须是**同帧拆好的标量**（train 载体池化，不得下传引用）；状态段已变则直接丢弃旧快照，
 *   交由下拍 2365 重读（避免用新窗的 baseRewardGet 配旧窗的 state/times）。
 * @param {object} ev bus 事件
 */
function onTrainDataPush(ev) {
  if (!aliveFn()) return;
  var t = (ev && ev.data && ev.data.data && ev.data.data.train) || null;
  if (!t) {
    log.debug('22096 push has no train payload, ignore.');
    return;
  }
  var bi = t.baseInfo || null;
  var st = Number(bi && bi.state) || 0;
  // 实测本推送只跟在 2373/2386 后面（带的全是结算主体车的字段）：状态段就应是 30，
  //   而 snap.state 跨日后已翻成今日新车的 10，故**不能拿 snap.state 做比较**（否则每天 00:00 后都要白重读一次 2365）。
  if (snap && st === ST_REWARD) {
    snap.baseRewardGet = Number(t.baseRewardGet) || 0;
    snap.shareHave = Number(t.shareRewardHaveNum) || 0;
    snap.lootedNum = Number(t.lootedNum) || 0;
  } else {
    snap = null;
  }
  log.debug(
    '22096 push state=%s baseRewardGet=%s share=%s, kick settle lane.',
    st,
    t.baseRewardGet,
    t.shareRewardHaveNum,
  );
  settleCycle.kick();
}

/**
 * 22010 红点推送：id=101 的 num 变化说明可掠次数被消耗/刷新，唤醒拦截 lane。
 * @param {object} ev bus 事件
 */
function onRedPointsPush(ev) {
  if (!aliveFn() || !MCFG.lootEnabled) return; // 22010 高频推送，未开启/已暂停时不日志以免刷屏；lane 自身仍有节奏
  var ps = (ev && ev.data && ev.data.data && ev.data.data.redPoints) || [];
  for (var i = 0; i < ps.length; i++) {
    if (Number(ps[i].id) === RED_POINT_LOOT) {
      log.debug('22010 redPoint id=%d num=%s, kick loot lane.', RED_POINT_LOOT, ps[i].num);
      lootCycle.kick();
      return;
    }
  }
}

// ── 存活判定 ──────────────────────────────────────────────────────────
/** @returns {boolean} */
function aliveFn() {
  return reactor.isRunning('cq26Train');
}

/**
 * 在飞流程的暂停出口（每个 await 之后、任何写请求之前必须复查）。
 * 必要性：reactor 的 pause 只摘触发器，在飞 await 必须自查 alive；本 feat 又声明了
 *   offInCombat:true，不复查就会在战斗模式翻转后把真兵派出去，门控在最该生效的路径上失效。
 * @param {string} lane 出口名（诊断定位用）
 * @returns {number} 下一拍睡眠（resume 时 configure/推送 会重新 kick）
 */
function pausedExit(lane) {
  log.debug('%s pass aborted: feat paused (combat gate flipped), skip dispatch.', lane);
  return cfg.idleMs;
}

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 直发一条 PBV2 请求，永不 reject；同 cmd 在途回落 CODE_NOT_SENT 哨兵。
 * 透出 net 的 Ret 实例（ok 为原型 getter，勿 spread/序列化）。
 * @param {number} cmd 协议号
 * @param {object} body 载荷（形态逐键见文件头协议清单）
 * @returns {Promise<object>} Ret{ok,code,data,reason}
 */
async function send(cmd, body) {
  var n = ensureNet();
  if (!n) return { ok: false, code: CODE_NOT_SENT, data: null };
  return await n.sendGuarded(cmd, body, {
    protocol: 'sendPBV2',
    onError: function (err) {
      log.warn('cmd %d send threw: %s', cmd, err && err.message);
    },
  });
}

/**
 * 取网络底座：运行中用 install 注入的 ctx.net；功能未启用时（面板「探测」按钮）懒取全局并 install。
 * @returns {object|null}
 */
function ensureNet() {
  if (net) return net;
  var g = netApi;
  if (g && g.install && g.install()) net = g;
  return net || null;
}

// ── 快照 ──────────────────────────────────────────────────────────────
/**
 * Int64 字段的跨拍安全副本：保留原型与自有字段（_low/_high/_unsigned）。
 * 必要性：应答对象池化复用，而 uuid 要活到下一拍原样回传（服务器要的是 Int64 型，
 *   既不能 Number 化（精度陷阱）也不能转字符串（类型不符），实证游戏侧就是直传 baseInfo.uuid）。
 * @param {*} v 应答里的 Int64 原值
 * @returns {*} 同原型浅副本（原始类型原样回）
 */
function cloneInt64(v) {
  if (v == null || typeof v !== 'object') return v;
  try {
    return Object.assign(Object.create(Object.getPrototypeOf(v)), v);
  } catch (e) {
    return v; // 原型取不到（异常形状）→ 宁可拿引用也不能发不出包
  }
}

/**
 * 把 2365 应答 data 拆成快照（必须与应答同帧调用：字段全部拷成标量、uuid 取副本）。
 * @param {object} d 2365 应答 data
 * @returns {object} 快照
 */
function readSnapshot(d) {
  var ct = d.curTrain || null;
  var bi = (ct && ct.baseInfo) || {};
  var lt = d.lastTrain || null;
  var lbi = (lt && lt.baseInfo) || null;
  // 结算主体取 lastTrain（游侧结算按钮闸就读 lastTrain.baseInfo.state===30）：00:00 后 curTrain 会翻成今日新车，
  //   而昨日那辆的结算窗一直开到 12:00，只有 lastTrain 还看得见它（实测 22:30→00:00 两者同一对象，取哪个都一样）。
  var sl = lbi ? lt : ct;
  var sbi = lbi || bi;
  return {
    localMs: Date.now(),
    towerId: Number(d.towerId) || TOWER_TRANSPORT,
    dailyMax: Number(d.allLootNum) || 0,
    dailyUsed: Number(d.lootNum) || 0,
    state: Number(bi.state) || 0,
    stateEndTime: Number(bi.stateEndTime) || 0,
    selfOn: Number(ct && ct.selfOn) || 0,
    userNumber: Number(ct && ct.userNumber) || 0,
    lootedNum: Number(ct && ct.lootedNum) || 0,
    rewardGrade: Number(ct && ct.rewardGrade) || 0,
    refreshNum: Number(ct && ct.selfRewardRefreshNum) || 0,
    // 结算三个权威字段一律来自主体车（baseRewardGet=1 代表已领；shareHave 是本人**剩余**可翻次数，实测 3→2→1→0）
    baseRewardGet: Number(sl && sl.baseRewardGet) || 0,
    shareHave: Number(sl && sl.shareRewardHaveNum) || 0,
    settleState: Number(sbi.state) || 0,
    settleEndTime: Number(sbi.stateEndTime) || 0,
    settleSelfOn: Number(sl && sl.selfOn) || 0,
    settleTimes: readTimes(sbi.times),
    // 上车/掠夺发的是**当前车**的 uuid（不给 lastTrain 回落，否则会误把兵派上昨日那辆）；
    //   结算发主体车的 uuid，两者跨日会不同，不能混用。
    uuid: bi.uuid ? cloneInt64(bi.uuid) : null,
    settleUuid: sbi.uuid ? cloneInt64(sbi.uuid) : null,
    times: readTimes(bi.times), // 顶层 d.times 实测为 []，权威只在 baseInfo.times
  };
}

/**
 * baseInfo.times → {10:{b,e},20:{b,e},30:{b,e}}（state 为键，秒）。
 * @param {Array<{state:number,bTime:number,eTime:number}>|null} arr
 * @returns {object}
 */
function readTimes(arr) {
  var out = {};
  if (!Array.isArray(arr)) return out;
  for (var i = 0; i < arr.length; i++) {
    var t = arr[i];
    if (!t) continue;
    var s = Number(t.state) || 0;
    if (!s) continue;
    out[s] = { b: Number(t.bTime) || 0, e: Number(t.eTime) || 0 };
  }
  return out;
}

/**
 * 读 2365 权威快照（TTL 内复用；在途/异常回旧值或 null，调用方据此择时，不抛不停摆）。
 * @param {boolean} [force] 忽略 TTL 强制重读
 * @returns {Promise<object|null>}
 */
async function refreshSnapshot(force) {
  if (!force && snap && Date.now() - snap.localMs < SNAP_TTL_MS) return snap;
  var r = await send(CMD_OPEN, {});
  if (r.code === CODE_NOT_SENT) {
    // 只剩「同号在途去重」这一支（真·未发出/超时已由 send 的 onError 打 warn），属随回收自愈的跳过
    log.debug('2365 in-flight dedupe, keep previous snapshot. hasSnap=%s', !!snap);
    return snap;
  }
  if (!r.ok) {
    // 可预期业务拒绝（活动未开 / 阶段锁 / 塔未激活）：判据第 3 条属 info，被拒路径不得打 warn
    log.info('2365 rejected. code=%s reason=%s', r.code, rejectText(r));
    return snap;
  }
  if (!r.data || typeof r.data !== 'object') {
    log.warn('2365 malformed ack, data not object. code=%s type=%s', r.code, typeof r.data);
    return snap;
  }
  snap = readSnapshot(r.data);
  return snap;
}

// ── 择时换算 ──────────────────────────────────────────────────────────
/**
 * 目标服务器秒时刻 → 距今毫秒（<=0 表示已过）。时钟基准走 ACL 的 DataCenter.ServerTime，取不到回墙上钟。
 * @param {number} targetSec 绝对服务器秒
 * @returns {number}
 */
function msUntilSec(targetSec) {
  if (!targetSec) return 0;
  var srv = gameData.serverTime() || Math.floor(Date.now() / 1000);
  return (targetSec - srv) * 1000;
}

/**
 * 睡到「当前状态段的边界」：优先 baseInfo.times[state].e，缺则 stateEndTime。
 * 边界已过 → 回 backoffMs 短歇重读（状态该前进了，不能按陈旧边界长睡）；两者都缺 → 回 fallbackMs。
 * @param {object} s 快照
 * @param {number} fallbackMs 无时刻信息时的兜底睡眠
 * @returns {number} 本轮睡眠毫秒
 */
function sleepToWindowEnd(s, fallbackMs) {
  var win = s.times[s.state];
  var end = (win && win.e) || s.stateEndTime || 0;
  if (!end) return fallbackMs;
  var d = msUntilSec(end + LEAD_SEC);
  return d > 0 ? Math.min(d, MAX_SLEEP_MS) : cfg.backoffMs;
}

/**
 * 睡到「下一个游戏日 0 点」（配额耗尽后的休眠，实证配额跨日刷新）。
 * @returns {number}
 */
function sleepToDailyReset() {
  var ts = gameData.nextDailyResetTs();
  var d = ts ? msUntilSec(ts + 60) : 0;
  return d > 0 ? Math.min(d, MAX_SLEEP_MS) : cfg.idleMs;
}

// ── 编队（2367 上车与 2370 掠夺共用）───────────────────────────────────
/**
 * 从预设队伍造列车 troop（实证报文形态：armyPosList 每项**只有** {pos,armyId,armyNum} 三键，
 *   比卡车 6476 少 heroCap/skinId；补位走 extraArmyPos 单对象 {pos:0,armyId,armyNum}）。
 * 组装口径对齐游戏侧 RealNBattleModel.startWarTruckFight（2367/2370 两处共用同一段代码）。
 * 只问「有没有兵可派」，不问「是不是满编」：残阵与降级满编都照发（理由见文件头闸门判据）。
 * @param {number} presetIdx 战斗预设 1~8
 * @returns {object|null} 无兵可派回 null
 */
function buildTrainTroop(presetIdx) {
  var data = new Battle().plan().preset(presetIdx).adjust({ ignoreMarched: true }).build();
  if (!data || !data.armyListNew || !data.armyListNew.length) return null;
  if (data.presetHasHeroes && (!data.heroList || !data.heroList.length)) return null;
  var troop = {
    heroList: (data.heroList || []).map(function (id) {
      return { heroId: id };
    }),
    armyPosList: data.armyListNew.map(function (a) {
      return { pos: a.pos | 0, armyId: a.armyId, armyNum: a.armyNum | 0 };
    }),
    formationV2: data.formationV2 | 0,
  };
  if (data.extraArmy && data.extraArmy.armyId) {
    troop.extraArmyPos = {
      pos: 0,
      armyId: data.extraArmy.armyId,
      armyNum: data.extraArmy.armyNum | 0,
    };
  }
  return troop;
}

// ── lane 1：自动上车 ───────────────────────────────────────────────────
/**
 * 上车一拍：前置闸 → 2365 权威 → state/窗/selfOn 判 → 2367 派兵。
 * @returns {Promise<number>} 下一拍睡眠毫秒
 */
async function boardPass() {
  if (!MCFG.boardEnabled) {
    log.debug('board lane disabled by cfg, idle.');
    return cfg.idleMs;
  }
  if (!gameData.cq26IsOpen()) {
    log.debug('cq26 activity not open, board lane idle.');
    return cfg.idleMs;
  }
  if (!gameData.cq26TransportTowerReady(TOWER_TRANSPORT)) {
    log.debug(
      'transport tower(id=%d) not activated, no boarding eligibility, idle.',
      TOWER_TRANSPORT,
    );
    return cfg.idleMs;
  }
  var s = await refreshSnapshot(false);
  if (!aliveFn()) return pausedExit('board');
  if (!s) {
    log.debug('board pass has no 2365 snapshot (in-flight dedupe or rejected), backoff.');
    return cfg.backoffMs;
  }
  if (s.state !== ST_GET_ON) {
    log.debug('state=%d not GET_ON(10), wait window end. selfOn=%d', s.state, s.selfOn);
    return sleepToWindowEnd(s, cfg.idleMs);
  }
  if (s.selfOn === 1) {
    log.debug('already boarded (selfOn=1), sleep to window end. userNumber=%d', s.userNumber);
    return sleepToWindowEnd(s, cfg.idleMs);
  }
  var toStart = s.times[ST_GET_ON] ? msUntilSec(s.times[ST_GET_ON].b) : 0;
  if (toStart > 0) {
    log.debug('GET_ON window starts in %ds, wake at boundary.', Math.round(toStart / 1000));
    return Math.min(toStart + 5000, MAX_SLEEP_MS);
  }
  if (!s.uuid) {
    log.warn('2367 not sent: snapshot missing curTrain.baseInfo.uuid. state=%d', s.state);
    return cfg.backoffMs;
  }
  var bkey = bits.int64Key(s.uuid);
  if (boardParamKey !== bkey) {
    boardParamKey = bkey;
    boardParamFails = 0; // 换车即新一窗记账：否则上一车的 param 拒绝会永久抵住后面的每一车
  }
  if (boardParamFails >= BOARD_FAIL_MAX) {
    // param 类被拒达阈：同窗不再重发（确定性编队/配置拒绝，重试无意义）；但只短歇不睡窗末，
    // 面板改预设/代码修复后重启本能力即可用新配置再试，18h 上车窗不被一次误判烧掉。
    log.debug(
      '2367 skipped: param-class rejections reached %d for this train, stop boarding this window.',
      boardParamFails,
    );
    return cfg.backoffMs;
  }
  // 上车要把兵挂上列车 → 占一条行军队列（实证见文件头：真人手动 2367 被 world_130516 拒）。
  // max<=0 = UserData 名额主数据读不到，按「未知不拦」放过（与 march.list 同口径），由服务器终裁 + 下面的队满可重试兜底。
  var mc = gameData.marchCount();
  if (mc.max > 0 && mc.used >= mc.max) {
    log.debug('no free march slot (used=%d/max=%d), 2367 not sent, short retry.', mc.used, mc.max);
    return cfg.backoffMs;
  }
  var troop = buildTrainTroop(MCFG.boardPreset);
  if (!troop) {
    log.debug(
      'board preset %d has no dispatchable army (or formation dropped), short retry.',
      MCFG.boardPreset,
    );
    return cfg.backoffMs;
  }
  if (!aliveFn()) return pausedExit('board'); // 派真兵前最后一道复查（troop 组装不跨帧，守的是上面几次 await 的窗口）
  var ret = await send(CMD_MARCH, { uuid: s.uuid, troop: troop });
  if (ret.code === CODE_NOT_SENT) {
    log.debug('2367 in-flight dedupe (preset=%d), retry next round.', MCFG.boardPreset);
    return cfg.backoffMs;
  }
  if (!ret.ok) {
    var rej = rejectText(ret); // header.d 的**原始多语言 key**（不是译文），必须同帧取
    var isParam = rej === ERR_BOARD_PARAM;
    if (isParam) boardParamFails++;
    // 可预期业务拒绝走 info（判据第 3 条），不升 warn
    log.info('2367 rejected. code=%s reason=%s paramFails=%d', ret.code, rej, boardParamFails);
    // 三档处置见文件头：param 类短歇计数（达阈由上面的闸停发本窗）；队满短歇重试（分钟级回收）；
    // 其余/未知 key 属本窗终结态，睡到窗末。CODE_NOT_SENT 已在上面走短歇。
    if (isParam || rej === ERR_QUEUE_FULL) {
      if (!isParam) log.debug('march queue full, 2367 will retry after a short rest.');
      return cfg.backoffMs;
    }
    return sleepToWindowEnd(s, cfg.backoffMs);
  }
  boardParamFails = 0; // 服务器受理即清零（param 记账只认连续串）
  var d = ret.data || {};
  if (Number(d.isOk) !== 1) {
    log.warn('2367 ack isOk=%s (not 1, boarding unconfirmed).', d.isOk);
    return cfg.backoffMs;
  }
  log.info(
    'boarded ok. preset=%d heroes=%d slots=%d extra=%d',
    MCFG.boardPreset,
    troop.heroList.length,
    troop.armyPosList.length,
    troop.extraArmyPos ? troop.extraArmyPos.armyNum : 0,
  );
  s.selfOn = 1; // 乐观置位：同窗绝不重发 2367（应答 isOk=1 即权威），避免服务器滞后回读致二次派兵
  return sleepToWindowEnd(s, cfg.idleMs);
}

var boardCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: boardPass,
  fallback: cfg.activeMs,
});

// ── lane 2：拦截（物品兴趣驱动）─────────────────────────────────
/**
 * 列表项 sid 的日志形态：字段缺失时 `%d` 会输出 NaN（无法 grep 定位），统一转字符串占位。
 * @param {*} v 原始 sid
 * @returns {string}
 */
function sidOf(v) {
  return v == null ? '?' : String(v);
}

/** @type {Object<number,string>|null} 最近一次 rewardPoolIds 解析出的 itemId→展示名缓存（面板 resolve 用，可展示 ITEM_NAMES 未登记项） */
var rewardNameCache = null;

/**
 * 从游戏「奖励列表」提取雪原列车可掠物品（itemId 有序去重）：
 *   data_config[REWARD_PREVIEW_CFG] → REWARD 行键 → gameData.rewardItems(id) 的道具清单（.id=itemId、.name=未译 loc 键）。
 *   口径同 extracted CQ26TransportData.getPreviewRewardItems（面板奖励预览同源）。表读不到则回 TRAIN_ITEM_POOL 兑底。
 *   顺带回填 rewardNameCache（itemId→展示名），供面板 sortlist resolve 使用。
 * @returns {number[]} 可掠奖池的 itemId 列表（读不到时回录兑底池）
 */
function rewardPoolIds() {
  var out = [];
  var names = {};
  try {
    var rewardId = Number(gameConf.dataConfig(REWARD_PREVIEW_CFG)) || 0;
    var arr = rewardId > 0 ? gameData.rewardItems(rewardId) : [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      var id = Number(it && it.id) || 0;
      if (id > 0 && out.indexOf(id) < 0) {
        out.push(id);
        names[id] = item.label(id, it && it.name);
      }
    }
  } catch (e) {
    out = [];
  }
  if (!out.length) {
    out = TRAIN_ITEM_POOL.slice();
    for (var j = 0; j < out.length; j++) names[out[j]] = item.label(out[j]);
  }
  rewardNameCache = names;
  return out;
}

/**
 * 面板 sortlist resolve：优先用奖励列表解析出的名称（可展示 ITEM_NAMES 未登记项），回退 item.sortResolve。
 * @param {number|string} itemId 道具 id
 * @returns {Array<{id:number,name:string}>|null}
 */
function lootItemResolve(itemId) {
  var id = Number(itemId);
  var nm = rewardNameCache && rewardNameCache[id];
  return nm ? [{ id: id, name: nm }] : item.sortResolve(id);
}

/**
 * 奖池里是否含「关注物品」（且尚有存货 itemCount>0）；命中回该 itemId，否则回 0。
 * 口径同卡车争夺：槽位被抢后 itemId 仍留在 lootRewardResult、只有 itemCount 归 0，空槽不算命中。
 * @param {object[]} pool truckView.lootRewardResult
 * @param {number[]} watch MCFG.lootItems（已勾选参与的 itemId）
 * @returns {number} 命中的 itemId；无命中回 0
 */
function matchWatchedItem(pool, watch) {
  if (!pool || !pool.length || !watch || !watch.length) return 0;
  for (var i = 0; i < pool.length; i++) {
    var it = pool[i];
    if (!it) continue;
    var id = Number(it.itemId) || 0;
    if (id > 0 && (Number(it.itemCount) || 0) > 0 && watch.indexOf(id) >= 0) return id;
  }
  return 0;
}

/**
 * 拦截一拍：行驶段闸 → 2369（列表 + 权威配额）→ 免费粗筛 → 按序逐个 2375 精判（奖池含关注物品才打）→ 2370 掠夺 + 采样。
 * @returns {Promise<number>} 下一拍睡眠毫秒
 */
async function lootPass() {
  if (!MCFG.lootEnabled) {
    log.debug('loot lane disabled by cfg (skeleton, no win-rate model yet), idle.');
    return cfg.idleMs;
  }
  if (!gameData.cq26IsOpen()) {
    log.debug('cq26 activity not open, loot lane idle.');
    return cfg.idleMs;
  }
  // 塔闸只挡轮询：掠夺资格由服务器终裁（state=20 + 2369 的 canLoot/配额），塔未激活时连面板入口都没有，
  //   继续刷 2365/2369 只是空转流量（且会叠成 C1 那条拒绝日志的循环刷屏），故这里 idle。
  if (!gameData.cq26TransportTowerReady(TOWER_TRANSPORT)) {
    log.debug(
      'transport tower(id=%d) not activated, skip 2365/2369 polling, idle.',
      TOWER_TRANSPORT,
    );
    return cfg.idleMs;
  }
  var s = await refreshSnapshot(false);
  if (!aliveFn()) return pausedExit('loot');
  if (!s) {
    log.debug('loot pass has no 2365 snapshot (in-flight dedupe or rejected), backoff.');
    return cfg.backoffMs;
  }
  if (s.state !== ST_ROAD) {
    log.debug('state=%d not ON_THE_ROAD(20), wait departure boundary.', s.state);
    return sleepToWindowEnd(s, cfg.idleMs);
  }
  var r = await send(CMD_LIST, {});
  if (!aliveFn()) return pausedExit('loot');
  if (r.code === CODE_NOT_SENT) {
    log.debug('2369 in-flight dedupe (state=%d), short retry.', s.state);
    return cfg.backoffMs;
  }
  if (!r.ok) {
    // 可预期业务拒绝（阶段锁 / 无掠夺资格）：判据第 3 条属 info
    log.info('2369 rejected. code=%s reason=%s', r.code, rejectText(r));
    return cfg.activeMs;
  }
  if (!r.data || typeof r.data !== 'object') {
    log.warn('2369 malformed ack, data not object. code=%s type=%s', r.code, typeof r.data);
    return cfg.activeMs;
  }
  var d = r.data;
  var cap = Number(d.allLootNum) || 0;
  var used = Number(d.lootNum) || 0;
  s.dailyMax = cap;
  s.dailyUsed = used; // 2369 自带权威配额，就地并入快照
  ensureDay(); // 先对齐日界（hitsToday/拉黑/样本同一口径），再读配额闸
  var left = cap > 0 ? Math.max(0, cap - used) : 0;
  // 配额缺失（cap<=0）与配额耗尽同向处理：宁可不掠，也不能把「没读到上限」判成「无限可掠」而空烧 2375/2370；
  //   再加一道自计数闸 hitsToday>=left，防「打了不烧 lootNum」的未实证分支形成 5s 死循环。
  if (!(cap > 0) || left <= 0 || hitsToday >= left) {
    log.debug(
      'daily loot quota unavailable or exhausted (server %d/%d, hits %d), sleep to day boundary.',
      used,
      cap,
      hitsToday,
    );
    return sleepToDailyReset();
  }
  var cands = [];
  var skipNoLoot = 0; // 列表里多数项都不可掠，逐条 debug 会按拍刷屏，故折叠成一条汇总
  var trains = Array.isArray(d.trains) ? d.trains : [];
  for (var i = 0; i < trains.length; i++) {
    var t = trains[i];
    if (!t) continue;
    var pct = Number(t.percent) || 0;
    var key = bits.int64Key(t.uuid);
    if (Number(t.canLoot) !== 1) {
      skipNoLoot++;
      continue;
    }
    if (pct <= 0 || pct > MCFG.maxPercent) {
      log.debug(
        'candidate %s skipped: percent=%s out of (0,%d].',
        sidOf(t.sid),
        pct,
        MCFG.maxPercent,
      );
      continue;
    }
    if (blocked.uuids.indexOf(key) >= 0) {
      log.debug('candidate %s skipped: blocked today. uuid=%s', sidOf(t.sid), key);
      continue;
    }
    // 列表项 uuid 必须同帧克隆（应答对象池化，跨 await 后不可靠）
    cands.push({
      key: key,
      uuid: cloneInt64(t.uuid),
      sid: Number(t.sid) || 0,
      specId: Number(t.specId) || 0,
      percent: pct,
      uidNumber: Number(t.uidNumber) || 0,
    });
  }
  if (skipNoLoot > 0) {
    log.debug('2369: %d trains skipped in bulk (canLoot!=1).', skipNoLoot);
  }
  if (!cands.length) {
    log.debug(
      '2369 returned %d trains, 0 after filter (percent/blocked), re-poll by rhythm.',
      trains.length,
    );
    return cfg.activeMs;
  }
  // 骨架排序：货余量升序（已被推进过＝有车打得动）→ 乘客数升序（阶梯浅）；属未证实经验，样本表攒够后重定
  cands.sort(function (x, y) {
    return x.percent - y.percent || x.uidNumber - y.uidNumber;
  });
  var target = null;
  var detail = null;
  for (var j = 0; j < cands.length && j < PROBE_MAX; j++) {
    if (!aliveFn()) return pausedExit('loot'); // 已 pause：未处理的下轮 rebuild
    var c = cands[j];
    var g = await send(CMD_INFO, { uuid: c.uuid });
    if (g.code === CODE_NOT_SENT) {
      log.debug('2375 in-flight dedupe. S%s uuid=%s, stop this round.', c.sid, c.key);
      break;
    }
    if (!g.ok) {
      // 可预期拒绝（目标刚被抢空/时序竞争）：info 带 code 与文案并当日拉黑；文案必须同帧取
      //   （rejectText 在 reason 为空时回落 safeStringify(ret.data)，而 ret.data 是池化载体）
      var grej = rejectText(g);
      log.info('2375 rejected. S%s uuid=%s code=%s reason=%s', c.sid, c.key, g.code, grej);
      await markBlocked(c.key, 2375, g);
      continue;
    }
    if (!g.data || !g.data.truckView) {
      log.warn('2375 malformed ack, truckView missing. S%s uuid=%s', c.sid, c.key);
      continue;
    }
    var tv = g.data.truckView;
    // 奖池条目数必须**同帧**拆成标量：detail 会活到 2370 应答之后才写样本表，跨拍读 tv 会取到池复用后的错值
    var poolLeft = (tv.lootRewardResult || []).length;
    var poolTaken = (tv.beLootRewardResult || []).length;
    // 物品兴趣驱动：奖池含「关注物品」才打，否则换下一辆（rank1/乘客数经录制证明不预测战果，不设战力闸）
    var matched = matchWatchedItem(tv.lootRewardResult, MCFG.lootItems);
    if (!matched) {
      log.debug('S%s skipped: loot pool has no watched item.', c.sid);
      continue;
    }
    target = c;
    detail = { matchedItem: matched, poolLeft: poolLeft, poolTaken: poolTaken };
    break;
  }
  if (!target) {
    log.debug(
      'no watched-item target after probing %d trains, re-poll by rhythm.',
      Math.min(cands.length, PROBE_MAX),
    );
    return cfg.activeMs;
  }
  var troop = buildTrainTroop(MCFG.lootPreset);
  if (!troop) {
    log.debug('loot preset %d has no dispatchable army, short retry.', MCFG.lootPreset);
    return cfg.backoffMs;
  }
  if (!aliveFn()) return pausedExit('loot'); // 发 2370（真兵）前最后一道复查
  var ret = await send(CMD_LOOT, { uuid: target.uuid, troop: troop });
  if (ret.code === CODE_NOT_SENT) {
    log.debug(
      '2370 in-flight dedupe. S%s uuid=%s preset=%d, retry next round.',
      target.sid,
      target.key,
      MCFG.lootPreset,
    );
    return cfg.backoffMs;
  }
  if (!ret.ok) {
    var lrej = rejectText(ret); // 同帧取 key 原文再进 await（rejectText 可能回落读池化 data）
    // 队满是我方自身的瞬态（分钟级回收），**不拉黑目标**：每日配额只有 2 次，
    // 拿自己的排队问题去烧掉一个可掠目标属误伤（拉黑仅留给目标侧/业务性拒绝）。
    if (lrej === ERR_QUEUE_FULL) {
      log.info(
        '2370 rejected by queue full. S%s uuid=%s keep target, short retry.',
        target.sid,
        target.key,
      );
      return cfg.backoffMs;
    }
    await markBlocked(target.key, 2370, ret);
    log.info(
      '2370 rejected. S%s uuid=%s code=%s reason=%s',
      target.sid,
      target.key,
      ret.code,
      lrej,
    );
    return cfg.activeMs;
  }
  var ack = ret.data || {};
  // 应答对象池化：recordSample 内部要 await 写盘闸门，所有结算字段必须**同帧**拆成标量再传下去
  var res = {
    win: Number(ack.isWin) === 1,
    winNum: Number(ack.winNum) || 0,
    lootToday: Number(ack.lootNum) || 0,
    percentAfter: (ack.lootTruckView && Number(ack.lootTruckView.percent)) || target.percent,
    reportId: ack.reportId ? bits.int64Decimal(ack.reportId) : '',
  };
  s.dailyUsed = res.lootToday || s.dailyUsed + 1; // lootNum = 今日已用（权威，胜负都会 +1）
  hitsToday++; // 自计数不依赖服务器，作为上面那道配额闸的第二只眼
  log.info(
    '2370 result. S%s win=%s winNum=%d lootNum=%d today=%d/%d percent=%d->%d',
    target.sid,
    res.win ? 'yes' : 'no',
    res.winNum,
    res.lootToday,
    s.dailyUsed,
    cap,
    target.percent,
    res.percentAfter,
  );
  await recordSample(target, detail, res, troop);
  return HIT_GAP_MS;
}

var lootCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: lootPass,
  fallback: cfg.activeMs,
});

// ── lane 3：到站结算（领基础奖励 2373 + 翻卡 2385/2386）───────
/**
 * 拉未翻卡位（2385 分页，只取标量 index，按列车 uuid + TTL 缓存）。
 * 未翻位判据（报文实证）：cardInfoList 里已翻项带 reward{itemId,itemCount}+userView，
 *   未翻项**只有 {index}**；盲翻下挑哪个 index 期望值等价，故只关心「哪些位还没人翻」。
 * 缓存必要性：奖池实测 270 张/9 页，每翻一张重拉分页属纯浪费；列表陈旧只会让 2386 被拒一次（被拒后该位已摘掉，下拍自然换下一个）。
 * @param {object} s 快照（用 uuid 发包、shareHave 决定够用即止）
 * @returns {Promise<number[]>} 升序未翻 index；空数组 = 本轮没读到可用卡位（不写缓存）
 */
async function loadUnflipped(s) {
  var key = bits.int64Key(s.settleUuid);
  var now = Date.now();
  // 命中条件必须带 `list.length`：上一拍摘完候选后缓存会变成空数组，若仍按命中返回就形成「TTL 内再也不重拉」的死区
  if (
    cardCache &&
    cardCache.uuidKey === key &&
    cardCache.list.length > 0 &&
    now - cardCache.localMs < CARD_CACHE_TTL_MS
  ) {
    return cardCache.list;
  }
  var out = [];
  var pages = 0;
  // 无页数上限（用户设置已移除）：扫到奖池末尾（p >= ceil(total/size)）或够翻即停；异常/在途仍 break
  for (var p = 1; ; p++) {
    // 第 1 页不发 pageId（实测真人就是省略，服务端默认回 pageId=1）；其余页带 {uuid,pageId,needEmpty}，与录制逐键一致
    var body =
      p === 1
        ? { uuid: s.settleUuid, needEmpty: 0 }
        : { uuid: s.settleUuid, pageId: p, needEmpty: 0 };
    var r = await send(CMD_CARD_LIST, body);
    if (!aliveFn()) return out; // 已 pause：不再拉页，调用方统一走 pausedExit
    if (r.code === CODE_NOT_SENT) {
      log.debug('2385 in-flight dedupe. page=%d, stop paging.', p);
      break;
    }
    if (!r.ok) {
      // 可预期业务拒绝（阶段锁 / 奖池未开）：文案必须同帧取（rejectText 会回落读池化 data）
      log.info('2385 rejected. page=%d code=%s reason=%s', p, r.code, rejectText(r));
      break;
    }
    if (!r.data || typeof r.data !== 'object') {
      log.warn('2385 malformed ack, data not object. page=%d type=%s', p, typeof r.data);
      break;
    }
    var d = r.data;
    var list = Array.isArray(d.cardInfoList) ? d.cardInfoList : [];
    pages++;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var idx = c && Number(c.index) ? Number(c.index) : 0;
      if (idx && !(c.reward && (Number(c.reward.itemId) || 0) > 0)) out.push(idx);
    }
    var total = Number(d.allRewardNum) || 0;
    var size = Number(d.pageSize) || CARD_PAGE_SIZE;
    if (total > 0 && p >= Math.ceil(total / size)) break; // 奖池已扫完
    if (out.length >= s.shareHave) break; // 够翻就停，省分页流量
  }
  if (!pages) return out; // 一页都没读成：不能把「读失败」缓存成「没卡位」
  if (out.length) {
    cardCache = { localMs: now, uuidKey: key, list: out };
    log.debug('2385 paged %d page(s), unflipped slots=%d.', pages, out.length);
  } else {
    log.info('2385 scanned %d page(s), all slots in range already flipped.', pages);
  }
  return out;
}

/**
 * 睡到「主体车结算窗止」（结算窗可跨到次日 12:00，不能用 curTrain 的 times，跨日后它已是今日新车的窗）。
 * @param {number} settleEndSec 结算窗止（服务器秒）
 * @param {number} fallbackMs 无时刻信息时的兜底睡眠
 * @returns {number}
 */
function sleepToSettleEnd(settleEndSec, fallbackMs) {
  var d = settleEndSec ? msUntilSec(settleEndSec + LEAD_SEC) : 0;
  return d > 0 ? Math.min(d, MAX_SLEEP_MS) : fallbackMs;
}

/**
 * 结算未开时的睡点：醒在「今日那辆到站时刻」（curTrain 的 times[20].e）。
 * 必要性：主体车（lastTrain）在结算窗止后仍可能报 state=30（状态未翻）且边界已过，
 *   走 sleepToWindowEnd/sleepToSettleEnd 的「边界已过→backoff」分支就变成 20s 一次的 2373 空转。
 * @param {object} s 快照
 * @returns {number}
 */
function sleepToNextArrival(s) {
  var win = s.times[ST_ROAD];
  var end = (win && win.e) || s.stateEndTime || 0;
  var d = end ? msUntilSec(end + LEAD_SEC) : 0;
  return d > 0 ? Math.min(d, MAX_SLEEP_MS) : cfg.idleMs;
}

/**
 * 结算一拍：主体车（lastTrain）state=30 且窗未过 → 未领则 2373 领基础奖励 → 有次数则取位后 2386 翻一张。
 * 单拍只做一件事（与 lootPass 同一口径）：翻成功后回 HIT_GAP_MS，靠 cycle 自然拉开真人级间隔。
 * @returns {Promise<number>} 下一拍睡眠毫秒
 */
async function settlePass() {
  if (!MCFG.settleEnabled) {
    log.debug('settle lane disabled by cfg, idle.');
    return cfg.idleMs;
  }
  if (!gameData.cq26IsOpen()) {
    log.debug('cq26 activity not open, settle lane idle.');
    return cfg.idleMs;
  }
  if (!gameData.cq26TransportTowerReady(TOWER_TRANSPORT)) {
    log.debug(
      'transport tower(id=%d) not activated, skip 2365/2385 polling, idle.',
      TOWER_TRANSPORT,
    );
    return cfg.idleMs;
  }
  var s = await refreshSnapshot(false);
  if (!aliveFn()) return pausedExit('settle');
  if (!s) {
    log.debug('settle pass has no 2365 snapshot (in-flight dedupe or rejected), backoff.');
    return cfg.backoffMs;
  }
  if (s.settleState !== ST_REWARD) {
    log.debug('settle subject state=%d not REWARD(30), wait next arrival.', s.settleState);
    return sleepToNextArrival(s);
  }
  var sEnd = (s.settleTimes[ST_REWARD] && s.settleTimes[ST_REWARD].e) || s.settleEndTime || 0;
  if (!sEnd || msUntilSec(sEnd) <= 0) {
    // 窗已过（或时刻读不到）：不能拿陈旧的 state=30 当资格，否则成 20s 一次的 2373 空转
    log.debug(
      'settle window closed or unreadable (end=%s state=%d), wait next arrival.',
      sEnd,
      s.settleState,
    );
    return sleepToNextArrival(s);
  }
  if (s.settleSelfOn !== 1) {
    log.debug(
      'settleSelfOn=%d (not boarded that train), nothing to settle, sleep to window end.',
      s.settleSelfOn,
    );
    return sleepToSettleEnd(sEnd, cfg.idleMs);
  }
  if (!s.settleUuid) {
    log.warn('2373/2386 not sent: snapshot missing settle subject uuid. state=%d', s.settleState);
    return cfg.backoffMs;
  }
  // ① 基础奖励：一次性闸，领成功即乐观置位（防 22096 回推之前重发）
  if (s.baseRewardGet !== 1) {
    var tkey = bits.int64Key(s.settleUuid);
    if (rewardFailKey !== tkey) {
      rewardFailKey = tkey;
      rewardFails = 0; // 换车即新一窗记账：否则上一车的 3 次拒绝会永久抵住后面的每一车
    }
    if (rewardFails >= REWARD_FAIL_MAX) {
      log.info('2373 gave up after %d consecutive rejections, sleep to window end.', rewardFails);
      return sleepToSettleEnd(sEnd, cfg.backoffMs);
    }
    if (!aliveFn()) return pausedExit('settle'); // 写请求前最后一道复查
    var rr = await send(CMD_REWARD, { uuid: s.settleUuid });
    if (rr.code === CODE_NOT_SENT) {
      log.debug('2373 in-flight dedupe, short retry.');
      return cfg.backoffMs;
    }
    if (!rr.ok) {
      rewardFails++;
      log.info('2373 rejected. code=%s reason=%s fails=%d', rr.code, rejectText(rr), rewardFails);
      return cfg.activeMs;
    }
    var rrd = rr.data || {};
    if (!rrd.rewardResult || typeof rrd.rewardResult !== 'object') {
      log.warn(
        '2373 malformed ack, rewardResult missing. code=%s keys=%s',
        rr.code,
        Object.keys(rrd).join(','),
      );
      return cfg.activeMs;
    }
    rewardFails = 0;
    s.baseRewardGet = 1;
    log.info('2373 base reward claimed. items=%d', (rrd.rewardResult.items || []).length);
    return cfg.backoffMs; // 短歇后重入走翻卡分支
  }
  // ② 翻卡：配额闸取服务器权威值，不靠本地计数（保留翻卡次数已移除，自动翻完）
  var want = s.shareHave;
  if (want <= 0) {
    log.debug('flip quota %d exhausted, sleep to window end.', s.shareHave);
    return sleepToSettleEnd(sEnd, cfg.idleMs);
  }
  var slots = await loadUnflipped(s);
  if (!aliveFn()) return pausedExit('settle');
  var idx = slots.length ? Number(slots[0]) : 0;
  if (!idx) {
    log.debug('no unflipped slot in reward pool, retry by rhythm.');
    return cfg.activeMs;
  }
  if (cardCache && cardCache.list === slots) cardCache.list = slots.slice(1); // 先摘掉本位，防下拍重点同位或被拒后死回同一位
  if (!aliveFn()) return pausedExit('settle'); // 发 2386 前最后一道复查
  var fr = await send(CMD_CARD_FLIP, { uuid: s.settleUuid, index: idx });
  if (fr.code === CODE_NOT_SENT) {
    log.debug('2386 in-flight dedupe. index=%d, short retry.', idx);
    return cfg.backoffMs;
  }
  if (!fr.ok) {
    // 极可能是该位刚被全服其他人翻走（未翻位列表是缓存值）：可预期业务拒绝走 info，位已摘掉，下拍换下一个
    log.info('2386 rejected. index=%d code=%s reason=%s', idx, fr.code, rejectText(fr));
    return cfg.backoffMs;
  }
  var fd = fr.data || {};
  // 应答对象池化：结算字段全部同帧拆成标量（本拍之后才 return，不能留引用）
  var left = Number(fd.shareRewardHaveNum);
  var rw = fd.cardInfo && fd.cardInfo.reward;
  var ritems = (fd.rewardResult && fd.rewardResult.items) || [];
  var got =
    rw && Number(rw.itemId)
      ? Number(rw.itemId) + 'x' + (Number(rw.itemCount) || 0)
      : ritems.length
        ? Number(ritems[0].itemId) + 'x' + (Number(ritems[0].itemCount) || 0)
        : '-';
  s.shareHave = Number.isFinite(left) && left >= 0 ? left : Math.max(0, s.shareHave - 1);
  log.info('2386 flipped. index=%d reward=%s left=%d', idx, got, s.shareHave);
  return HIT_GAP_MS;
}

var settleCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: settlePass,
  fallback: cfg.activeMs,
});

// ── 当日拉黑 / 样本表 ─────────────────────────────────────────────────
/**
 * 跨日归零：拉黑表与样本表都按游戏日重置，并返回**同一个**日串供回读比较。
 * 日界口径取服务器秒（与 sleepToDailyReset 同源），避免「睡到的日界线」与「表清零的日界线」
 *   在非 UTC+8 客户端上不是同一天（否则拉黑会在游戏日内被提前清空）。
 * @returns {string} 当日子（YYYY-MM-DD）
 */
function ensureDay() {
  var day = todayStr(gameData.serverTime() || undefined);
  if (blocked.day !== day) blocked = { day: day, uuids: [] };
  if (samples.day !== day) samples = { day: day, list: [] };
  if (hitsDay !== day) {
    hitsDay = day;
    hitsToday = 0;
  }
  return day;
}

/**
 * 读当日拉黑表。
 * @returns {Promise<boolean>} true = 读通道可用（含「键确实不存在」）；false = 读失败，调用方必须禁写盘
 */
async function loadBlocked() {
  var day = ensureDay();
  var saved;
  try {
    saved = await storage.data.get(DATA_NAME_BLOCK);
  } catch (e) {
    log.warn('load cq26Train.blocked failed: %s', e && e.message);
    return false;
  }
  if (saved && typeof saved === 'object' && saved.date === day && Array.isArray(saved.trucks)) {
    blocked = { day: day, uuids: saved.trucks.map(String) };
  }
  return true;
}

/**
 * 回读当日样本表（必须做：不回读则页面重载后 recordSample 会用短列表直接覆盖 blob，历史样本静默丢光）。
 * @returns {Promise<boolean>} true = 读通道可用；false = 读失败（fail-closed，后续写盘会被跳过）
 */
async function loadSamples() {
  var day = ensureDay();
  var saved;
  try {
    saved = await storage.data.get(DATA_NAME_SAMPLES);
  } catch (e) {
    log.warn('load cq26Train.samples failed: %s', e && e.message);
    return false;
  }
  if (saved && typeof saved === 'object' && saved.date === day && Array.isArray(saved.rows)) {
    samples = { day: day, list: saved.rows.slice(-SAMPLE_CAP) };
  }
  log.debug('sample table loaded: rows=%d day=%s.', samples.list.length, day);
  return true;
}

/**
 * 真拒绝（code≠0）→ 该列车当日拉黑并落盘。
 * 纪律：s≠0 的真实样本目前零录制，故一律按「当日拉黑」处理；待补录后按 reason 细分「当日拉黑 vs 本轮跳过」。
 * @param {string} key uuid 的稳定串键（bits.int64Key）
 * @param {number} cmd 被拒协议号
 * @param {object} ret net Ret
 * @returns {Promise<void>}
 */
async function markBlocked(key, cmd, ret) {
  if (!key) {
    log.warn('markBlocked skipped: empty uuid key. cmd=%d code=%s', cmd, ret && ret.code);
    return;
  }
  if (blocked.uuids.indexOf(key) >= 0) return;
  if (!(await waitLoads())) {
    // 回读未成功：整体覆盖写会抹掉当日已有拉黑，宁可不拉黑（下拍仍会重试）
    log.warn('blacklist persist skipped: daily table unreadable. uuid=%s cmd=%d', key, cmd);
    return;
  }
  if (blocked.uuids.indexOf(key) >= 0) return; // 回读期间可能已被另一条 lane 记入
  blocked.uuids.push(key);
  log.debug('blocked uuid=%s cmd=%d code=%s', key, cmd, ret && ret.code);
  try {
    await storage.data.set(DATA_NAME_BLOCK, {
      date: blocked.day,
      trucks: blocked.uuids.slice(-200),
    });
  } catch (err) {
    log.warn('persist blocked failed.', err);
  }
}

/**
 * 记一条攻打决策样本（选目标维度 + 结果维度），供事后回推胜率门槛。
 * 入参已全部是**同帧拆好的标量**：本函数会先 await 写盘闸门，任何池化应答引用都不能带进来。
 * @param {object} c 候选（2369 侧字段，uuid 已同帧克隆）
 * @param {object} det 2375 精判产出 {matchedItem,poolLeft,poolTaken}
 * @param {object} res 2370 结算标量快照 {win,winNum,lootToday,percentAfter,reportId}
 * @param {object} troop 实际发出的 troop
 * @returns {Promise<void>}
 */
async function recordSample(c, det, res, troop) {
  if (!(await waitLoads())) {
    // 回读未成功：整体覆盖写会抹掉当日历史样本（本 feat 唯一产出物），宁可不记这一条
    log.warn('sample persist skipped: daily table unreadable. uuid=%s sid=%s', c.key, c.sid);
    return;
  }
  var row = {
    ts: Date.now(),
    uuidKey: c.key,
    sid: c.sid,
    percent: c.percent,
    uidNumber: c.uidNumber,
    matchedItem: det.matchedItem,
    poolLeft: det.poolLeft,
    poolTaken: det.poolTaken,
    heroes: troop.heroList.length,
    slots: troop.armyPosList.length,
    extraNum: troop.extraArmyPos ? troop.extraArmyPos.armyNum : 0,
    isWin: res.win ? 1 : 0,
    winNum: res.winNum,
    lootNumToday: res.lootToday,
    reportId: res.reportId,
  };
  ensureDay();
  samples.list.push(row);
  if (samples.list.length > SAMPLE_CAP) samples.list = samples.list.slice(-SAMPLE_CAP);
  try {
    await storage.data.set(DATA_NAME_SAMPLES, { date: samples.day, rows: samples.list });
  } catch (err) {
    log.warn('persist samples failed.', err);
  }
}

// ── 面板 ──────────────────────────────────────────────────────────────
/** @type {object[]} 战斗预设下拉项（1~8） */
var presetOptions = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
  return { value: i, label: '预设部队 ' + i };
});

/**
 * 「秒距今」换算成人话（供状态行展示窗口倒计时）。
 * @param {number} sec 距今秒（<=0 回「已到」）
 * @returns {string}
 */
function fmtLeft(sec) {
  if (!(sec > 0)) return '已到';
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + '时' + m + '分' : m + '分';
}

/**
 * 面板状态行：优先本模块权威快照，其次游戏侧缓存 mainData（功能未启用时也能看），都没有回未探测。
 * @returns {string}
 */
function stateText() {
  var s = snap;
  if (!s) {
    var md = gameData.cq26TrainMainData(); // ACL 已投影成标量，不持游戏对象图
    if (!md || !md.state) return '未探测（启用后自动读，或点下方按钮）';
    return (
      '游戏缓存\n状态 ' +
      md.state +
      ' 已上车 ' +
      (md.selfOn === 1 ? '是' : '否') +
      '\n今日可掠 ' +
      md.lootNum +
      '/' +
      md.allLootNum +
      '\n基础奖励 ' +
      (md.baseRewardGet === 1 ? '已领' : '未领') +
      ' 可翻卡 ' +
      md.shareHave +
      '次'
    );
  }
  var label =
    s.state === ST_GET_ON
      ? '上车窗'
      : s.state === ST_ROAD
        ? '行驶中'
        : s.state === ST_REWARD
          ? '已到站'
          : 'state=' + s.state;
  var win = s.times[s.state];
  var srv = gameData.serverTime() || Math.floor(Date.now() / 1000);
  var lines = [label + '（' + fmtLeft(win && win.e ? win.e - srv : 0) + '后切换）'];
  lines.push(
    '上车 ' + (s.selfOn === 1 ? '已上' : '未上') + ' 乘客 ' + s.userNumber + ' 被掠 ' + s.lootedNum,
  );
  lines.push(
    '今日可掠 ' +
      s.dailyUsed +
      '/' +
      s.dailyMax +
      ' 奖档 ' +
      s.rewardGrade +
      ' 已刷 ' +
      s.refreshNum,
  );
  if (s.settleState === ST_REWARD) {
    lines.push(
      '到站结算 基础奖励 ' +
        (s.baseRewardGet === 1 ? '已领' : '未领') +
        ' 可翻卡 ' +
        s.shareHave +
        '次 未翻位 ' +
        (cardCache ? cardCache.list.length : '?'),
    );
  }
  return lines.join('\n');
}

/**
 * 面板 defaults。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
    boardEnabled: true,
    boardPreset: 1,
    lootEnabled: false,
    lootPreset: 1,
    maxPercent: 95,
    lootItems: TRAIN_ITEM_POOL.slice(),
    lootItemsOff: [],
    settleEnabled: true,
  };
}

/**
 * 面板 fields。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_state',
      type: 'text',
      label: '列车状态',
      multiline: true,
      inline: true,
      get: stateText,
    },
    {
      key: 'probeBtn',
      type: 'button',
      label: '↻ 探测列车状态（发一条 2365）',
      busyText: '探测中…',
      onClick: async function () {
        snap = null;
        var s = await refreshSnapshot(true);
        return s ? '已读取：state=' + s.state : '读取失败（在途或应答异常），详见日志';
      },
    },
    {
      key: 'settleEnabled',
      type: 'checkbox',
      section: '到站结算',
      label: '到站自动领奖 + 翻卡',
    },
    {
      key: '_settleNote',
      type: 'note',
      section: '到站结算',
      text:
        '实测每日到站后可翻 3 次（2385 里未翻的卡面不露奖品，属盲翻，挑哪一张期望值相同）；' +
        '基础奖励（2373）只在未领时发一次，翻卡每 5 秒一张、自动扫完全部奖池页，不派兵也不花钻石。',
    },
    {
      key: 'boardEnabled',
      type: 'checkbox',
      section: '自动上车',
      label: '窗内自动上车',
    },
    {
      key: 'boardPreset',
      type: 'select',
      section: '自动上车',
      label: '上车预设',
      options: presetOptions,
      hint: '上车兵在整个行驶段挂在车上，被掠夺时也用它守',
    },
    {
      key: 'lootEnabled',
      type: 'checkbox',
      section: '自动拦截',
      label: '自动拦截',
    },
    {
      key: '_lootNote',
      type: 'note',
      section: '自动拦截',
      text:
        '录制实证：4 次攻打 isWin 全 false，rank1 战力/乘客数/percent 都不预测战果（486.7M 的车抢到货、139.2M 的车空手），故不设这些数字闸。' +
        '策略为物品兴趣驱动：2369 粗筛后逐辆发 2375，奖池含下方「关注物品」才打（用满每日配额）；关注物品清单取自游戏奖励预览表（data_config→REWARD），非报文逆推。每次攻打写本地样本表，攻够再谈胜率模型。',
    },
    {
      key: 'lootPreset',
      type: 'select',
      section: '自动拦截',
      label: '拦截预设',
      options: presetOptions,
      showIf: function (c) {
        return !!c.lootEnabled;
      },
    },
    {
      key: 'maxPercent',
      type: 'number',
      section: '自动拦截',
      label: '货物余量上限 %',
      min: 1,
      max: 100,
      step: 1,
      topHint: '只打已被推进过的车；实测赢的那辆 73%',
      showIf: function (c) {
        return !!c.lootEnabled;
      },
    },
    {
      key: 'lootItems',
      type: 'sortlist',
      checkable: true,
      offKey: 'lootItemsOff',
      section: '自动拦截',
      label: '关注物品（池内含这些才打）',
      hint: '清单取自游戏「雪原列车奖励预览」（data_config→REWARD 表，与面板同源）；勾选要关注的物品，2375 的 lootRewardResult 命中其一即视为可打目标（命中任一即打、列表顺序不影响判定；全不勾=不拦）',
      resolve: lootItemResolve,
      all: rewardPoolIds,
      showIf: function (c) {
        return !!c.lootEnabled;
      },
    },
  ];
}

/**
 * toModuleCfg：面板 cfg → 运行时归一化 MCFG。
 * @param {object} c 面板合并后配置
 * @returns {object}
 */
function normalizeCfg(c) {
  return {
    boardEnabled: c.boardEnabled !== false,
    boardPreset: Math.min(8, Math.max(1, Number(c.boardPreset) || 1)),
    lootEnabled: !!c.lootEnabled,
    lootPreset: Math.min(8, Math.max(1, Number(c.lootPreset) || 1)),
    maxPercent: Math.min(100, Math.max(1, Number(c.maxPercent) || 95)),
    // sortlist：cfg.lootItems=拖拽序、cfg.lootItemsOff=未勾项；MCFG.lootItems 取「已勾且按序去重」的有效集（供 matchWatchedItem 直接消费）
    lootItems: (function () {
      var off = new Set((Array.isArray(c.lootItemsOff) ? c.lootItemsOff : []).map(String));
      var arr = Array.isArray(c.lootItems) ? c.lootItems : [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var n = Number(arr[i]);
        if (!(n > 0) || off.has(String(n)) || out.indexOf(n) >= 0) continue;
        out.push(n);
      }
      return out;
    })(),
    settleEnabled: c.settleEnabled !== false,
  };
}

// ── 注册 ──────────────────────────────────────────────────────────────
reactor.register({
  id: 'cq26Train',
  label: '雪原列车',
  storageKey: 'pocketcc.feat.cq26_train',
  symbols: [
    'dataCenter',
    'presetMarch',
    'heroController',
    'mechaController',
    'formationAdv',
    'marchStorage',
  ],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  configure: configure,
  run: run,
});
