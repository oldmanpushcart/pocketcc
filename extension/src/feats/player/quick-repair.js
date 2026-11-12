/**
 * 快速修理（英雄免费快速修理 + 医院加速，reactor 说明书形态，日常任务，多分支单链）
 *
 * 玩法：进医院（本地伤兵队列 / 跨服战场医院队列）后自动执行「英雄免费快速修理」
 *   （每日 77 个普通单位、零材料、零钻石），并按开关可选追加：钻石加速在修队列、
 *   医院加速道具加速、雷神兵修理（带材料）。免费线永远优先，付费线默认关闭并各带闸门。
 *
 * 协议字典（实录报文实证；源码 references/游戏逆向/extracted/
 *   subpack2/WareHouseControllerNew / HospitalComponentNew / Script/SpeedCDPanel / Script/UserData / Script/RequestId）：
 *   读（V1 send 旧 JSON 链路，ret.data 为原始 JSON 串需自 parse）
 *     1785 GET_QUICK_REPARE_INFO {} →
 *       {common_max,common_use,landThor_max/use,navyThor_max/use,airThor_max/use,thor_max/use,
 *        ret:[{id:10001|10002|10003,num}]}
 *       实测本号 {common_max:77, common_use:59, thor_*:0, ret:[{num:47,id:10001},{num:30,id:10002},{num:0,id:10003}]}
 *       —— 普通兵每日免费额度 = common_max-common_use；雷神族 *_max=0 ⇒ 雷神不可免费修（与用户口径吻合）。
 *     1426 GET_CROSS_HOSPITAL_QUEUES {} → {queues:[{army,id,st,et,func}]}；`st` 非枚举而是「开修时刻」：
 *       `st===0 && et===0` = 跨服待修；`st>0`（修理开始 epoch 秒）且 `et`（结束 epoch 秒）> ServerTime = 跨服在修
 *       （id 为十进制串，直用作 1427/1428 的 ids 元素）。
 *     1426 门控（源码锚点 WareHouseControllerNew.isBattleFieldHospitalValid，「战场抢修车间」并非常驻）：
 *       FunctionOn(cross_server_battle_hospital) 且战场 HospitalEndTime 未到期（CQ25/CQ26 stormData 同闸）才轮询；
 *       判据取不到（符号漂移）时回退「无从判定=照旧轮询」，宁多读一笔不漏修。无双四模式在场时该族队列整体让位 6310 族。
 *   无双（NewCAB/AVA 族，普通无双趟实录报文实证；源码锚点 AVAHospitalComponent.StartAllQueue·
 *   _realUseCure·SpeedCDPanel.getAvaCureGoldByTime + NewCABController.askHospitalArmyData·hospitalSpeed，
 *   与普通医院协议完全独立、无免费额度概念，修伤兵吃资源与 ~7.6h 时长）：
 *     6310 AVA_ASK_HOSPITAL_DATA null → {list:[{orderId,id,state,durationTime,startTime,endTime,type,itemId}]}
 *       （state 0=待修/1=在修；id 即部队 uuid 与 orderId 同值；在修 endTime=完成 epoch 秒、待修 durationTime≈27325）；
 *     6311 AVA_CURE_ALL_ARMYS_DATA {ids:[待修 id…]} → {ret:0}（批量；源码 StartAllQueue 取 `orderId!=="0" && state===0` 全量）；
 *     6312 AVA_SPEED_CURE 钻石 {ids:[在修 id…],useGold:1} / 道具 {ids,itemId,num,useGold:0} → {ret:0}
 *       （源码 _realUseCure/hospitalUseItemSpeed 取 `orderId!=="0" && state===1`；无双道具=ITEM 表专行 15100046，
 *       单次缩短秒数=ITEM 行 para1、枚数 use_max 或 DATACONFIG 18002 封顶；钻石估价=GetCDGold 基价×模式倍率，
 *       倍率键 NewCAB 1663543 / TM 1663622 / Master 168036 / Legend 1670027——与普通医院 61017 口径不同）；
 *     push 21203 New_CAB_HOSPITAL_CHANGE（无双医院队列变化，只当唤醒提示；无双写动作不回灌本地队列、靠下拍 6310 权威读）；
 *     模式→三件套映射（StartAllQueue 同款顺序，判定源 CrossUtils）：isNewCAB→6310/6311/6312；isTMServer→6356/6357/6358；
 *       isMasterMatch→8403/8404/8405；isTeamLegendServer→9055/9056/9057；皆非=不在无双战场，不发该族。
 *   写（一律 net.sendGuarded，永不 reject）
 *     220  ARMY_HEAL_LIST {ids:[本地待修队列 id…]}：服务器自动优先扣免费额度（超出免费额度才吃材料）。
 *          应答 {free_common_repair_num,free_thor_repair_num,queues:[…]}。单条 = 206 ARMY_HEAL {id}。
 *          本地雷神兵亦走 220（与竞对 B/源码一致：getOrderQueuesByType(1) 的本地队列全量 → 220；本号 thor 免费额度=0 ⇒ 超出的自然扣材料）。
 *     1427 ARMY_CROSS_HEAL {ids:[跨服战场队列 id…]}：仅承载 getBattleFieldOrderQueue（跨服），实测伴随 thor_elements/oila 扣减 ⇒ 消耗材料。本地 id 混入必被服务器拒。
 *     151  ORDER_QUEUE_ING_DONE {armyType?}   钻石加速本地全部在修队列（源码 EndAllQueue：armyType=-1 时不带该键）
 *     124  ORDER_QUEUE_SPEED_UP {id,useGold:1} 钻石加速本地单条在修队列
 *     1428 SPEEDUP_CROSS_HOSPITAL_QUEUE_BY_GOLD {} 全量 / {id} 单条（跨服）
 *     815  ITEM_USE {itemid,amount,param}：param 编码加速目标（源码 SpeedCDPanel.hospitalUseItemSpeed + 真人 510002 成功样本实证）
 *          本地全量 param=null（"0|0" 被服务器拒 s=3/item_124017，实录实证）；本地单条 = 队列 id；跨服全量 "1,"+armyType 或 "1|0"；跨服单条 "1|"+queueId
 *          `amount` = 道具枚数，服务器把它当「时间池」按槽位顺序**贪心消耗**（单枚 = ITEM 行 para1 秒：510002=28800/8h、
 *          510001=3600、510000=300）：池子先修完队首、余额顺延下一条 ⇒ 全部在修一次发包即需枚数 = ceil(Σ剩余秒/para1)。
 *          实证：实录逐笔 1 枚（首条清空、次条 endTime 恰减 28800-其剩余）、另一趟真人一笔
 *          amount=9 清空 15 条在修（15×≈17000s ≈ 9×28800）、还有一趟真人跨服 amount=43 ⇒ 多枚同发被服务器接受。
 *   判据镜像（源码 WareHouseControllerNew.getQuickRepairTipsType / HospitalComponentNew.StartAllQueue·EndAllQueue·btnToggle）
 *     tipsType(wait,max,use)：取不到 max/use ⇒ NoCanRepair；wait<=0 || max<=0 || max-use<=0 ⇒ NoCanRepair；
 *       max-use>=wait ⇒ AllCanRepair；否则 PartCanRepair。
 *     待修 = UserData.getOrderQueuesByType(1) 里 `orderId!=="0" && state===0`；雷神兵 = 部队 Data.thor_group>0
 *       （源码锚点 FlameController.isFlameArmyById 即此判据，故不另依赖 FlameController 单例）。
 *     钻石估价 = ceil(在修剩余秒和 / 60 × DATACONFIG 61017) 取 max(1,·)（同源码 getProfessionCDGold 公式）。
 *     医院加速道具 = ITEM 表 type=12（ItemType.HospitalSpeedItem）。
 *   触发 push
 *     10120 ORDER_QUEUES_BATCH_INFO {orderQueues:[{id,orderId,state,itemId,type:1,endTime}]}（本地伤兵入队/改态）
 *     13006 CSB_HOSPITAL_QUEUE_ADD {queues:[{army,id,st,et}]}（跨服入队，辅以 13007 MODIFY / 13005 DELETE）
 *
 * 三场景统一去重（无抑制时钟，与竞品 B 事件驱动同构）：本 feat 发 220/1427/151/1428/815/6311/6312 都不经游戏回调，
 *   无去重即会逐拍撞同一批队列。策略：所有抑制墙钟全废（旧 speedGateMsFor 的 45s/10s 整批窗、markHealed/markDeadSlot
 *   的 5min/30min），改为「在途令牌 pending，仅由权威读确认清除、无 TTL」。
 *   不变式：新令牌（从没在途过的队列）即时放行；已发未确认的令牌绝不第二枪；令牌只在其「目标 state 退出权威读」时遗忘。
 *   原语：execAction 成功后 `markPending`（逐令牌动作记实发令牌；全量 body={{}} 动作记该域活跃令牌集 pendingTokens，
 *   任一受影响令牌仍在途即整域跳过、不拆子集）；snapshot 每拍权威读后 `prunePendingByExit(族, 活跃集)` 按族确认清除——
 *   治疗族（lw/cw/aw）确认集=state0 待处理令牌、加速族（lr/cr/ar）确认集=state1 在修令牌（令牌口径逐族严格同形）。
 * 节拍（去勤扫）：取消 5s 忙时勤扫，只在 push 事件（10120/13006/AVA change×4 → kick）跑一拍 + 一个很慢心跳兜底丢推；
 *   任一写动作成功后同样 kick()，尽早拿到「确认读」缩小在途窗。连续被拒达阈时心跳×2 退避。
 *
 * 幻影回灌（quickRepair 专属例外，是本地流的「确认」源而非时钟）：本地治疗/钻石加速（heal-local / heal-local-thor /
 *   heal-local-resource / speed-gold-local）成功后，借用游戏官方应答回调同款 `UserData.UpdateOrderQueues(resp.queues/orderQueues)`
 *   （见源码 HospitalComponentNew/HospitalArmySelectPopup 与竞品 B hospitalStart/hospitalEnd；220/151 本地应答带 orderQueues，
 *   实录 “… (queues synced)” 佐证；本地道具 815 应答仅 {itemId,amount}、不含队列，本例外不适用于它）把服务器权威队列
 *   按 id 回灌本地态，从根消除「已治好/已加速槽滞留成陈旧幻影 → 重发 common_159995」；回灌后该队列退出 state0/state1，
 *   正是 prunePendingByExit 遗忘其本地在途令牌的确认来源。本地道具/跨服/无双无此回灌，靠每拍 push 10120 / 1426 / 6310 权威读确认。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发上述协议。除上述「幻影回灌」借用游戏自带 UpdateOrderQueues
 *   （把服务器已下发的权威队列就地覆盖，非自造增删、不弹 UI）外，不调 StartAllQueue/OpenUI/Delete 等改写本地态
 *   或弹 UI 的原生方法（「feat 只读+发包」红线；UpdateOrderQueues 为 quickRepair 经用户批准的唯一例外）。
 * 免费 vs 资源续修：普通伤兵先修「英雄免费额度」（common_max-common_use）内（`freeRepair` 恒开）；额度耗尽后默认继续
 *   花资源续修（`resourceRepair` 恒开，两者均不放面板），按部队 `repair_cost` 累计持有量筛「买得起」的伤兵发 220（服务器先扣免费、超出扣
 *   材料，与游戏一键修理/竞品 B hospitalStart 一致）；买不起的静默跳过、不告警不进退避。
 * 日常任务形态：面板只暴露 3 个付费/带材料开关（雷神/钻石/道具）；免费修/资源续修恒开、自愈轮询间隔为系统内置，
 *   均不出现在面板。钻石日预算与道具保留下限两个闸门已废弃（钻石只受余额约束、道具持有即动用）。
 *   生命周期由 reactor 托管：places base/world、kinds homeland、不行军不参战故 offInCombat:false；
 *   pause 后 ctx.alive()=false，cycle 与在飞 await 自然停摆。
 */
import { CODE_NOT_SENT, parseData, rejectText } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { l10n, gameData } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=QUICK-REPAIR） */
const log = createLog('QUICK-REPAIR');

/** @type {number} RequestId.GET_QUICK_REPARE_INFO，快速修理额度权威读（V1 send） */
const CMD_GET_QUICK_REPARE = 1785;
/** @type {number} RequestId.ARMY_HEAL_LIST，本地批量修理（服务器自动优先扣免费额度） */
const CMD_ARMY_HEAL_LIST = 220;
/** @type {number} RequestId.GET_CROSS_HOSPITAL_QUEUES，跨服战场医院队列权威读 */
const CMD_GET_CROSS_HOSPITAL_QUEUES = 1426;
/** @type {number} RequestId.ARMY_CROSS_HEAL，跨服/雷神修理（消耗材料） */
const CMD_ARMY_CROSS_HEAL = 1427;
/** @type {number} RequestId.ORDER_QUEUE_ING_DONE，钻石加速本地全部在修队列 */
const CMD_ORDER_QUEUE_ING_DONE = 151;
// CMD_ORDER_QUEUE_SPEED_UP(124) RequestId.ORDER_QUEUE_SPEED_UP：钻石加速本地单条在修队列（本 feat 全量 151 口径，不适用单条，备查）。
/** @type {number} RequestId.SPEEDUP_CROSS_HOSPITAL_QUEUE_BY_GOLD，钻石加速跨服队列 */
const CMD_SPEEDUP_CROSS_GOLD = 1428;
/** @type {number} RequestId.ITEM_USE，使用道具（医院加速道具走这一条） */
const CMD_ITEM_USE = 815;

/**
 * 无双（AVA 族）三件套协议号（RequestId 实证；按模式整表切换，源码 StartAllQueue/_realUseCure 同款映射）。
 * @type {number} RequestId.AVA_ASK_HOSPITAL_DATA（普通无双·NewCAB 权威读，请求体恒 null）
 */
const CMD_AVA_ASK = 6310;
/** @type {number} RequestId.AVA_CURE_ALL_ARMYS_DATA（批量修待修，{ids}） */
const CMD_AVA_CURE = 6311;
/** @type {number} RequestId.AVA_SPEED_CURE（钻石/道具加速在修，同一命令两种 body） */
const CMD_AVA_SPEED = 6312;
/** @type {number} RequestId.TEAM_MATCH_ASK_HOSPITAL_DATA */
const CMD_TM_ASK = 6356;
/** @type {number} RequestId.TEAM_MATCH_CURE_ALL_ARMYS_DATA */
const CMD_TM_CURE = 6357;
/** @type {number} RequestId.TEAM_MATCH_SPEED_CURE */
const CMD_TM_SPEED = 6358;
/** @type {number} RequestId.MASTER_MATCH_ASK_HOSPITAL_DATA */
const CMD_MASTER_ASK = 8403;
/** @type {number} RequestId.MASTER_MATCH_CURE_ALL_ARMYS_DATA */
const CMD_MASTER_CURE = 8404;
/** @type {number} RequestId.MASTER_MATCH_SPEED_CURE */
const CMD_MASTER_SPEED = 8405;
/** @type {number} RequestId.TEAM_LEGEND_ASK_HOSPITAL_DATA */
const CMD_LEGEND_ASK = 9055;
/** @type {number} RequestId.TEAM_LEGEND_CURE_ALL_ARMYS_DATA */
const CMD_LEGEND_CURE = 9056;
/** @type {number} RequestId.TEAM_LEGEND_SPEED_CURE */
const CMD_LEGEND_SPEED = 9057;

/**
 * 无双模式 → {ask,cure,speed} 命令三件套（顺序映射表，判定在 avaModeNow）。
 * @type {Object<string, {ask:number, cure:number, speed:number}>}
 */
const AVA_MODE_CMDS = {
  ava: { ask: CMD_AVA_ASK, cure: CMD_AVA_CURE, speed: CMD_AVA_SPEED },
  tm: { ask: CMD_TM_ASK, cure: CMD_TM_CURE, speed: CMD_TM_SPEED },
  master: { ask: CMD_MASTER_ASK, cure: CMD_MASTER_CURE, speed: CMD_MASTER_SPEED },
  legend: { ask: CMD_LEGEND_ASK, cure: CMD_LEGEND_CURE, speed: CMD_LEGEND_SPEED },
};

/**
 * 无双钻石倍率 DATACONFIG 键（源码 getAvaCureGoldByTime 逐字：NewCAB 1663543 / TM 1663622 /
 * Master 168036 / Legend 1670027；取不到按 1，与源码 `||1` 同口径）。
 * @type {Object<string, number>}
 */
const AVA_GOLD_CFG = { ava: 1663543, tm: 1663622, master: 168036, legend: 1670027 };

/** @type {number} 无双医院加速道具 ITEM 专行 id（竞品 B/源码 setCDItem(ItemType.HospitalSpeedItem) 在 AVA 域仅此一行） */
const AVA_HOSPITAL_SPEED_ITEM = 15100046;

/**
 * @type {number} DATACONFIG 键 useItem_num（实测值 10000）：单次使用道具枚数上限。
 * 医院 815 的枚数上限**只取该键**——ITEM 行 `use_max=1` 是背包「使用」按钮的单次上限，不约束医院面板的 N 枚同发
 * （真人 amount=9/43 均 s=0 落地，见头部 815 实证）。无双 6312 无同量样本，仍按源码口径 `use_max || cfg(18002)`。
 */
const CFG_ITEM_SPEED_USE_MAX = 18002;

/** @type {string} FunctionKey.cross_server_battle_hospital 值串（成员名与值串同字，GameDefine 实证） */
const FUNC_KEY_CROSS_BATTLE_HOSPITAL = 'cross_server_battle_hospital';

/** @type {number} push ORDER_QUEUES_BATCH_INFO：本地伤兵队列入队/改态 */
const PUSH_ORDER_QUEUES = 10120;
/** @type {number} push CSB_HOSPITAL_QUEUE_ADD：跨服战场医院队列入队 */
const PUSH_CROSS_QUEUE_ADD = 13006;
/** @type {number} push New_CAB_HOSPITAL_CHANGE：无双医院队列变化（只当唤醒提示，载荷不入状态） */
const PUSH_AVA_HOSPITAL_CHANGE = 21203;
/** @type {number} push TEAM_MATCH_CAB_HOSPITAL_CHANGE：TM 战场医院队列变化（ResponseId 实证） */
const PUSH_TM_HOSPITAL_CHANGE = 21211;
/** @type {number} push MASTER_MATCH_CAB_HOSPITAL_CHANGE：Master 战场医院队列变化（ResponseId 实证） */
const PUSH_MASTER_HOSPITAL_CHANGE = 21465;
/** @type {number} push TEAM_LEGEND_HOSPITAL_CHANGE：Legend 战场医院队列变化（ResponseId 实证；成员名无 CAB 段但指向同族 handler） */
const PUSH_LEGEND_HOSPITAL_CHANGE = 21562;
// AVA_MODE_PUSH 聚合表未使用（run 期直接 ctx.on.push 四个 PUSH_* 周flag，不需要模式→push 映射）。
//   ava→21203 / tm→21211 / master→21465 / legend→21562（与上行同名同值，备查）。

/** @type {number} ItemType.HospitalSpeedItem（ITEM 表 type 列）：医院加速道具 */
const ITEM_TYPE_HOSPITAL_SPEED = 12;

// GameDefine.ArmyType 三值（Land:101 / Sea:201 / Air:301）——本 feat 不拆军种发包（全量加速不带 armyType），仅备查。

/** @type {number} 本地伤兵队列在 OrderQueues 里的 type 值（源码 getOrderQueuesByType(1)） */
const ORDER_TYPE_HEAL = 1;

/** @type {number} DATACONFIG 键：钻石加速每分钟单价（源码 getProfessionCDGold 同款费率） */
const CFG_GOLD_PER_MIN = 61017;

/** @type {number} 心跳兜底巡检间隔下限（毫秒）；面板 pollIntervalSec 小于此值也按本值走。
 *  无抑制时钟：节拍只由 push 边沿（kick）+ 本慢心跳驱动，新伤兵即时由 push 放行、丢推最坏等一个心跳。 */
const IDLE_TICK_MS = 1000 * 60;

/**
 * 治疗批量（220/1427）被服务器整批拒绝时的固定错误码：`param error`。
 * 原子批量里只要混入一个无效/空槽（客户端 OrderQueues 滞后产生的陈旧幻影），整批都会被此码拒绝，
 * 连累同批本可修的伤兵（偶发漏修）。据此码触发「逐 id 单发隔离」与确认幻影的延长抑制。
 */
const ERR_PARAM_HEAL = 'common_159995';

/** @type {number} 一轮内连发多包时的间隔（毫秒），避免同一宏任务撞车 */
const INTER_SEND_MS = 1000;

/** @type {number} 连续被服务器拒绝多少次后退巡检档 */
const REJECT_STREAK_LIMIT = 3;

/**
 * 内置调优常量（面板不出这些项）
 * @type {object}
 */
const cfg = {
  /** 兜底轮询上限（秒）：面板填得再大也不超这个值，防「填 1 天」把 push 唤醒之外的自愈读彻底睡死 */
  maxPollSec: 60 * 60,
};

/** @type {{freeRepair:boolean, resourceRepair:boolean, thorRepair:boolean, speedGold:boolean, speedItem:boolean, pollIntervalSec:number}} 面板配置（configure 灌入 toModuleCfg 产物） */
var MCFG = normalize({});

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {object|null} reactor 上下文；alive() 反映运行态，pause 后在飞流程自然退出 */
var ctxRef = null;

/** @type {object|null} DataCenter.DATA（UserData / ServerTime 只读入口，install 期取符号） */
var dataCenter = null;
/** @type {object|null} GameTools（getDataConfigData 读钻石加速每分钟费率 61017） */
var gameTools = null;
/** @type {object|null} CrossUtils 静态判据（isNewCAB/isTMServer/isMasterMatch/isTeamLegendServer）；软依赖，缺失=无双分支整体禁用 */
var crossUtils = null;
/** @type {boolean} install 幂等位 */
var installed = false;

/** @type {Object<string,number>} 在途令牌表：`动作名|去重令牌` → Infinity（无 TTL，仅由 prunePendingByExit 在目标 state 退出权威读时删除） */
var sentFp = Object.create(null);

/** @type {number} 连续被服务器拒绝次数；任一成功即清零 */
var rejectStreak = 0;

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ─────────────────────────── 纯判据函数（单测/对拍直接消费） ───────────────────────────

/**
 * 面板配置归一：每个键各自取字面语义，不做区间合并。
 * 免费线 boolean 缺省口径：freeRepair / resourceRepair 缺键一律视为 true（零成本/续修恒开，不再放面板）；
 * 其余付费/带材料项（thorRepair/speedGold/speedItem）缺省视为 false。
 * @param {object} raw 面板原始配置
 * @returns {object} 归一后的模块配置
 */
function normalize(raw) {
  raw = raw || {};
  var poll = Math.floor(Number(raw.pollIntervalSec));
  if (!(poll > 0)) poll = 60;
  poll = Math.min(poll, cfg.maxPollSec);
  return {
    freeRepair: raw.freeRepair === undefined ? true : !!raw.freeRepair,
    resourceRepair: raw.resourceRepair === undefined ? true : !!raw.resourceRepair,
    thorRepair: !!raw.thorRepair,
    speedGold: !!raw.speedGold,
    speedItem: !!raw.speedItem,
    pollIntervalSec: poll,
  };
}

/**
 * 1785 应答 → 免费额度（普通兵 + 雷神族按海陆空分档）。
 * @param {object|null} info 1785 应答载荷
 * @returns {{ok:boolean, commonMax:number, commonUse:number, commonFreeLeft:number, thorMax:number, thorUse:number, thorFreeLeft:number, landThorFreeLeft:number, navyThorFreeLeft:number, airThorFreeLeft:number, groupNum:Object<number,number>}|null}
 */
function quickFields(info) {
  if (!info || typeof info !== 'object') return null;
  if (typeof info.common_max !== 'number' && typeof info.common_use !== 'number') return null;
  var commonMax = Number(info.common_max) || 0;
  var commonUse = Number(info.common_use) || 0;
  var thorMax = Number(info.thor_max) || 0;
  var thorUse = Number(info.thor_use) || 0;
  var groupNum = Object.create(null);
  if (Array.isArray(info.ret)) {
    for (var i = 0; i < info.ret.length; i++) {
      var r = info.ret[i];
      if (!r || typeof r !== 'object') continue;
      var id = Number(r.id) || 0;
      if (id) groupNum[id] = Number(r.num) || 0;
    }
  }
  var left = function (maxKey, useKey) {
    return Math.max(0, (Number(info[maxKey]) || 0) - (Number(info[useKey]) || 0));
  };
  return {
    ok: true,
    commonMax: commonMax,
    commonUse: commonUse,
    commonFreeLeft: Math.max(0, commonMax - commonUse),
    thorMax: thorMax,
    thorUse: thorUse,
    thorFreeLeft: Math.max(0, thorMax - thorUse),
    landThorFreeLeft: left('landThor_max', 'landThor_use'),
    navyThorFreeLeft: left('navyThor_max', 'navyThor_use'),
    airThorFreeLeft: left('airThor_max', 'airThor_use'),
    groupNum: groupNum,
  };
}

/**
 * 是否雷神（flame）部队：源码锚点 FlameController.isFlameArmyById = `Data.thor_group>0`。
 * @param {object|null} army UserData.getArmyByArmyUuid(orderId) 结果
 * @returns {boolean} 拿不到部队返回 false（保守当普通兵，绝不因判据缺失而漏修）
 */
function isThorArmy(army) {
  var d = army && army.Data;
  return !!(d && Number(d.thor_group) > 0);
}

/**
 * 待修队列 id 拆分（本地伤兵）：`type===1 && orderId!=="0" && state===0`。
 * 同时产出与 ids 同序对齐的去重令牌（commonKeys/thorKeys）= `id#orderId#endTime`：
 * - 带 orderId：医院队列槽 id 会被复用到不同伤兵（orderId 变），只按槽 id 去重会误抑制刚进同槽的新伤兵；
 * - 带 endTime：同一部队（orderId 不变）会被反复打伤，每次受伤事件 endTime 变；陈旧幻影（服务器已清、
 *   客户端未同步）endTime 不变。故 endTime 是区分「需立修的再次受伤」与「须抑制的陈旧幻影」的关键。
 * 雷神兵与判定解耦在本函数之外（注入的 thorOf 由调用方提供），本函数只管形态过滤。
 * @param {Array<object>|null} queues DATA.UserData.OrderQueues（或 getOrderQueuesByType(1) 结果）
 * @param {function(string):boolean} [thorOf] orderId → 是否雷神（缺省全部当普通兵）
 * @returns {{commonIds:string[], thorIds:string[], commonKeys:string[], thorKeys:string[], commonOrders:string[], waitTotal:number, malformed:number}}
 */
function splitWaitIds(queues, thorOf) {
  var out = {
    commonIds: [],
    thorIds: [],
    commonKeys: [],
    thorKeys: [],
    commonOrders: [],
    waitTotal: 0,
    malformed: 0,
  };
  if (!Array.isArray(queues)) return out;
  for (var i = 0; i < queues.length; i++) {
    var q = queues[i];
    if (!q || typeof q !== 'object') {
      out.malformed++;
      continue;
    }
    if (Number(q.type) !== ORDER_TYPE_HEAL) continue;
    var orderId = q.orderId == null ? '' : String(q.orderId);
    if (!orderId || orderId === '0') continue;
    if (Number(q.state) !== 0) continue;
    var id = q.id == null ? '' : String(q.id);
    if (!id) {
      out.malformed++;
      continue;
    }
    out.waitTotal++;
    var tok = id + '#' + orderId + '#' + markOf(q.endTime);
    if (thorOf && thorOf(orderId)) {
      out.thorIds.push(id);
      out.thorKeys.push(tok);
    } else {
      out.commonIds.push(id);
      out.commonKeys.push(tok);
      out.commonOrders.push(orderId);
    }
  }
  return out;
}

/**
 * 受伤事件标记（用于去重令牌区分同 orderId 的再次受伤 vs 陈旧幻影）：数值取整、否则取串。
 * @param {number|string|null|undefined} v 队列 endTime / et
 * @returns {string}
 */
function markOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v)) : '';
  return v == null ? '' : String(v);
}

/**
 * 本地 state0 待修活跃令牌集（治疗族 lw 确认清除用）：`type===1 && orderId!=="0" && state===0` → `id#orderId#markOf(endTime)`，
 * 与 `splitWaitIds` 的去重令牌严格同形（同一批伤兵在两处算出的令牌逐字相等）。
 * @param {Array<object>|null} queues 本地伤兵队列
 * @returns {Set<string>}
 */
function localWaitTokenSet(queues) {
  var s = new Set();
  if (!Array.isArray(queues)) return s;
  for (var i = 0; i < queues.length; i++) {
    var q = queues[i];
    if (!q || typeof q !== 'object') continue;
    if (Number(q.type) !== ORDER_TYPE_HEAL) continue;
    var orderId = q.orderId == null ? '' : String(q.orderId);
    if (!orderId || orderId === '0') continue;
    if (Number(q.state) !== 0) continue;
    var id = q.id == null ? '' : String(q.id);
    if (!id) continue;
    s.add(id + '#' + orderId + '#' + markOf(q.endTime));
  }
  return s;
}

/**
 * 本地 state1 在修活跃 id 集（加速族 lr 确认清除/pendingTokens 用）：与 `repairingLeftSec` 同过滤口径
 * （`orderId!=="0" && state===1`，tolerate 缺失 type）→ plain id。
 * @param {Array<object>|null} queues 本地伤兵队列
 * @returns {Set<string>}
 */
function localRepairingIdSet(queues) {
  var s = new Set();
  if (!Array.isArray(queues)) return s;
  for (var i = 0; i < queues.length; i++) {
    var q = queues[i];
    if (!q || typeof q !== 'object') continue;
    if (q.type != null && Number(q.type) !== ORDER_TYPE_HEAL) continue;
    var orderId = q.orderId == null ? '' : String(q.orderId);
    if (!orderId || orderId === '0') continue;
    if (Number(q.state) !== 1) continue;
    var id = q.id == null ? '' : String(q.id);
    if (id) s.add(id);
  }
  return s;
}

/**
 * 跨服待修队列去重令牌：与 `crossWaitIds` 同序（`st===0 && id` 非空），令牌 = `id#army#et`（战场部队 uuid + 受伤时刻）。
 * @param {object|null} data 1426 应答载荷
 * @returns {string[]}
 */
function crossWaitKeys(data) {
  var out = [];
  var qs = data && data.queues;
  if (!Array.isArray(qs)) return out;
  for (var i = 0; i < qs.length; i++) {
    var q = qs[i];
    if (!q || typeof q !== 'object') continue;
    if (Number(q.st) !== 0) continue;
    var id = q.id == null ? '' : String(q.id);
    if (!id) continue;
    out.push(id + '#' + (q.army == null ? '' : String(q.army)) + '#' + markOf(q.et));
  }
  return out;
}

/**
 * 跨服待修队列 id：1426 应答 `queues[]` 里 `st===0` 且 id 非空。
 * @param {object|null} data 1426 应答载荷
 * @returns {string[]}
 */
function crossWaitIds(data) {
  var out = [];
  var qs = data && data.queues;
  if (!Array.isArray(qs)) return out;
  for (var i = 0; i < qs.length; i++) {
    var q = qs[i];
    if (!q || typeof q !== 'object') continue;
    if (Number(q.st) !== 0) continue;
    var id = q.id == null ? '' : String(q.id);
    if (id) out.push(id);
  }
  return out;
}

/**
 * 跨服 state0 待修活跃令牌集（治疗族 cw 确认清除用）：与 `crossWaitKeys` 同形（`id#army#et`）的 Set。
 * @param {object|null} data 1426 应答载荷
 * @returns {Set<string>}
 */
function crossWaitKeySet(data) {
  return new Set(crossWaitKeys(data));
}

/**
 * 跨服 state1 在修 id 集（加速族 cr 确认清除/pendingTokens 用）：1426 `queues[]` 里 `st>0`（已开修）且 id 非空 → plain id。
 * @param {object|null} data 1426 应答载荷
 * @returns {string[]}
 */
function crossRepairingIds(data) {
  var out = [];
  var qs = data && data.queues;
  if (!Array.isArray(qs)) return out;
  for (var i = 0; i < qs.length; i++) {
    var q = qs[i];
    if (!q || typeof q !== 'object') continue;
    if (!(Number(q.st) > 0)) continue;
    var id = q.id == null ? '' : String(q.id);
    if (id) out.push(id);
  }
  return out;
}

/**
 * 跨服 state1 在修 id 集（cr 确认清除用）的 Set 形式。
 * @param {object|null} data 1426 应答载荷
 * @returns {Set<string>}
 */
function crossRepairingIdSet(data) {
  return new Set(crossRepairingIds(data));
}

/**
 * 在修剩余秒和（本地）：`orderId!=="0" && state===1` 的 Σ(endTime - serverTime)。
 * 源码锚点 HospitalComponentNew.getUnderRepairTime（逐队列累加，单条加速时以 e.id 提前截断，本处取全量口径）。
 * @param {Array<object>|null} queues 本地伤兵队列
 * @param {number} serverTime DATA.ServerTime（秒）
 * @returns {number} 秒；不为负；serverTime 不可判定时恒 0
 */
function repairingLeftSec(queues, serverTime) {
  if (!Array.isArray(queues)) return 0;
  // serverTime 取不到（符号漂移/尚未同步）时 endTime-0 会退化成 epoch 秒，高估的在修秒和
  // 会灌进道具枚数折算 `ceil(Σ/para1)` → 一笔打光背包道具。时间不可判定一律视为「不在修」。
  if (!(Number(serverTime) > 0)) return 0;
  var total = 0;
  for (var i = 0; i < queues.length; i++) {
    var q = queues[i];
    if (!q || typeof q !== 'object') continue;
    if (q.type != null && Number(q.type) !== ORDER_TYPE_HEAL) continue;
    var orderId = q.orderId == null ? '' : String(q.orderId);
    if (!orderId || orderId === '0') continue;
    if (Number(q.state) !== 1) continue;
    var left = (Number(q.endTime) || 0) - (Number(serverTime) || 0);
    if (left > 0) total += left;
  }
  return total;
}

/**
 * 跨服在修剩余秒和：1426 `queues[]` 里 `st>0`（已开修，st 记开修 epoch）且 `et>serverTime`。
 * 注意与本地 repairingLeftSec 的差异：本地队列 state 是枚举 0/1，跨服 st 却是「开修时刻」时间戳
 * （实测待修 st=0/et=0，在修 st=1794112460/et=1794125551），故此处判 `st>0` 而非 `st===1`。
 * @param {object|null} data 1426 应答载荷
 * @param {number} serverTime DATA.ServerTime（秒）
 * @returns {number}
 */
function crossRepairingLeftSec(data, serverTime) {
  var qs = data && data.queues;
  if (!Array.isArray(qs)) return 0;
  if (!(Number(serverTime) > 0)) return 0; // 同 repairingLeftSec：时刻不可判定 = 不在修，防枚数高估烧道具
  var st0 = Number(serverTime);
  var total = 0;
  for (var i = 0; i < qs.length; i++) {
    var q = qs[i];
    if (!q || typeof q !== 'object') continue;
    if (!(Number(q.st) > 0)) continue;
    var left = (Number(q.et) || 0) - st0;
    if (left > 0) total += left;
  }
  return total;
}

/**
 * 无双模式择表（纯判据，源码 StartAllQueue 同款顺序）：AVA → TM → Master → Legend；皆非返回 null（不在无双战场）。
 * @param {{isNewCAB:boolean, isTM:boolean, isMaster:boolean, isLegend:boolean}} flags CrossUtils 四判据布尔集
 * @returns {string|null} 'ava' | 'tm' | 'master' | 'legend' | null
 */
function pickAvaMode(flags) {
  if (!flags) return null;
  if (flags.isNewCAB) return 'ava';
  if (flags.isTM) return 'tm';
  if (flags.isMaster) return 'master';
  if (flags.isLegend) return 'legend';
  return null;
}

/**
 * 6310 应答 list → 待修 id 集（源码 StartAllQueue 逐字：`orderId!=="0" && state===0`；id 即部队 uuid 十进制串）。
 * @param {Array<object>|null} list 6310 应答 list 数组
 * @returns {string[]}
 */
function avaWaitIds(list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length; i++) {
    var q = list[i];
    if (!q || typeof q !== 'object') continue;
    var oid = q.orderId == null ? '' : String(q.orderId);
    if (!oid || oid === '0') continue;
    if (Number(q.state) !== 0) continue;
    var id = q.id == null ? '' : String(q.id);
    if (id) out.push(id);
  }
  return out;
}

/**
 * 6310 应答 list → 在修 id 集（源码 _realUseCure/hospitalUseItemSpeed 逐字：`orderId!=="0" && state===1`）。
 * @param {Array<object>|null} list 6310 应答 list 数组
 * @returns {string[]}
 */
function avaRepairingIds(list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length; i++) {
    var q = list[i];
    if (!q || typeof q !== 'object') continue;
    var oid = q.orderId == null ? '' : String(q.orderId);
    if (!oid || oid === '0') continue;
    if (Number(q.state) !== 1) continue;
    var id = q.id == null ? '' : String(q.id);
    if (id) out.push(id);
  }
  return out;
}

/**
 * 6310 应答 list → state0 待修活跃 id 集（治疗族 aw 确认清除用）：与 `avaWaitIds` 同集（plain id）。
 * @param {Array<object>|null} list 6310 应答 list
 * @returns {Set<string>}
 */
function avaWaitIdSet(list) {
  return new Set(avaWaitIds(list));
}

/**
 * 6310 应答 list → state1 在修活跃 id 集（加速族 ar 确认清除用）：与 `avaRepairingIds` 同集（plain id）。
 * @param {Array<object>|null} list 6310 应答 list
 * @returns {Set<string>}
 */
function avaRepairingIdSet(list) {
  return new Set(avaRepairingIds(list));
}

/**
 * 无双在修剩余秒和：state===1 队列 Σ(endTime - serverTime)，单条不为负、取不到 endTime 记 0。
 * 源码锚点 AVAHospitalComponent 逐队列 `C=m.endTime-DataCenter.DATA.ServerTime` 累加口径。
 * @param {Array<object>|null} list 6310 应答 list 数组
 * @param {number} serverTime DATA.ServerTime（秒）
 * @returns {number}
 */
function avaRepairingLeftSec(list, serverTime) {
  if (!Array.isArray(list)) return 0;
  if (!(Number(serverTime) > 0)) return 0; // 同上：6312 枚数也吃这个秒和，时刻不可判定时不折算
  var st0 = Number(serverTime);
  var total = 0;
  for (var i = 0; i < list.length; i++) {
    var q = list[i];
    if (!q || typeof q !== 'object') continue;
    var oid = q.orderId == null ? '' : String(q.orderId);
    if (!oid || oid === '0') continue;
    if (Number(q.state) !== 1) continue;
    var left = (Number(q.endTime) || 0) - st0;
    if (left > 0) total += left;
  }
  return total;
}

/**
 * 无双钻石估价（源码 getAvaCureGoldByTime 口径：基价 GetCDGold(leftSec) × 模式倍率，至少 1）。
 * 诚实边界：GetCDGold 本体在逆向抽取里是空桩，此处以普通医院同款基价 ceil(leftSec/60×61017) 代估（与
 * getProfessionCDGold 同公式），仅用于「余额不够就跳过」的保守闸门；真实扣费由服务器裁决。
 * @param {number} leftSec 在修剩余秒和
 * @param {number} ratePerMin DATACONFIG 61017 每分钟钻石价（取不到=0，无从判定）
 * @param {number} mult 模式倍率（DATACONFIG 1663543 等；≤0 按 1，同源码 `||1`）
 * @returns {number} 估算钻石；rate 不可用时返回 0 表示「无从判定」
 */
function estimateAvaGold(leftSec, ratePerMin, mult) {
  var base = estimateGold(leftSec, ratePerMin);
  if (!base) return 0;
  var m = Number(mult) > 0 ? Number(mult) : 1;
  return Math.max(1, Math.floor(base * m));
}

/**
 * 道具加速枚数（源码 SpeedCDPanel 滑条上限/竞品 B avaHospitalEnd 同款）：
 * num = min(ceil(leftSec/secPerUse), 持有量, useMax)，useMax≤0 视为不设限；任一要素非法返回 0（不发）。
 * 普通医院（815）与无双（6312）共用：服务器的消耗模型是「amount×单枚秒数」汇成时间池、按队列顺序贪心扣减，
 * 故 ceil(Σ剩余秒/单枚秒数) 就是「刚好修完全部在修」的最小枚数，不会多花。
 * @param {number} leftSec 在修剩余秒和
 * @param {number} secPerUse 单枚缩短秒数（ITEM 行 para1）
 * @param {number} held 持有枚数
 * @param {number} useMax 单次枚数上限（行 use_max 或 DATACONFIG 18002；≤0=不限）
 * @returns {number}
 */
function speedItemNum(leftSec, secPerUse, held, useMax) {
  var spu = Number(secPerUse);
  if (!(spu > 0) || !(leftSec > 0)) return 0;
  var n = Math.ceil(leftSec / spu);
  var h = Math.floor(Number(held)) || 0;
  if (n > h) n = h;
  var cap = Number(useMax);
  if (cap > 0 && n > cap) n = Math.floor(cap);
  return n > 0 ? n : 0;
}

/**
 * 钻石估价（源码 GameTimeTools.getProfessionCDGold 同款公式：ceil(秒/60 × 每分钟价)，至少 1）。
 * @param {number} leftSec 在修剩余秒和
 * @param {number} ratePerMin DATACONFIG 61017（每分钟钻石价）
 * @returns {number} 估算钻石；rate 不可用（≤0）时返回 0 表示「无从判定」
 */
function estimateGold(leftSec, ratePerMin) {
  var rate = Number(ratePerMin) || 0;
  if (!(rate > 0) || !(leftSec > 0)) return 0;
  return Math.max(1, Math.ceil((leftSec / 60) * rate));
}

/**
 * 解析一条部队 `repair_cost`（源码/竞品同格式：`"resId|amount,resId|amount"`）。
 * @param {string|number|null|undefined} cost army.Data.repair_cost
 * @returns {Array<{resId:number, amount:number}>} 非正/非法片段忽略；空串返回 []
 */
function parseRepairCost(cost) {
  var out = [];
  if (typeof cost !== 'string' || !cost) return out;
  var parts = cost.split(',');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split('|');
    if (kv.length < 2) continue;
    var resId = Math.floor(Number(kv[0]));
    var amount = Math.floor(Number(kv[1]));
    if (!(resId > 0) || !(amount > 0)) continue;
    out.push({ resId: resId, amount: amount });
  }
  return out;
}

/**
 * 贪心筛选「按累计 repair_cost 花资源负担得起」的伤兵（对齐竞品 B hospitalStart）：
 * 逐单位累加其成本到各资源，只要每个资源累计仍 ≤ 当前持有量就纳入（并入累加），否则跳过该单位
 * （不回补、不精确，保守避免超支）。成本未知（null，拿不到 army）的单位一律跳过。
 * @param {Array<Array<{resId:number, amount:number}>|null>} costs 与待修同序；[]=零成本、null=不可判定
 * @param {function(number):number} holdingOf resId → 当前持有量
 * @returns {boolean[]} 与 costs 同序，true=纳入
 */
function filterAffordable(costs, holdingOf) {
  var acc = Object.create(null);
  var res = [];
  for (var i = 0; i < costs.length; i++) {
    var items = costs[i];
    if (!items) {
      res.push(false);
      continue;
    }
    var ok = true;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var next = (acc[it.resId] || 0) + it.amount;
      if (next > (Number(holdingOf(it.resId)) || 0)) {
        ok = false;
        break;
      }
    }
    res.push(ok);
    if (ok) {
      for (var k = 0; k < items.length; k++) {
        acc[items[k].resId] = (acc[items[k].resId] || 0) + items[k].amount;
      }
    }
  }
  return res;
}

/**
 * 挑一枚医院加速道具：只在持有量 > keepItemNum 的候选间比较，取持有最多者，并列取 id 小者（确定性）。
 * ⚠ 面板「道具保留下限」闸门已废弃（见头部“日常任务形态”条目），生产调用恒传 0；形参与分支保留仅供测试与向后兼容。
 * @param {Array<{id:number, amount:number}>} held 候选道具（ITEM 表 type=12 的持有行）
 * @param {number} keepItemNum 保留下限（低于/等于该值不动用）
 * @returns {{itemId:number, amount:number, usable:number}|null}
 */
function pickSpeedItem(held, keepItemNum) {
  var keep = Number(keepItemNum) > 0 ? Math.floor(Number(keepItemNum)) : 0;
  var best = null;
  if (!Array.isArray(held)) return null;
  for (var i = 0; i < held.length; i++) {
    var it = held[i];
    if (!it || !(Number(it.id) > 0)) continue;
    var amount = Number(it.amount) || 0;
    if (amount <= keep) continue;
    if (!best || amount > best.amount || (amount === best.amount && Number(it.id) < best.itemId)) {
      best = { itemId: Number(it.id), amount: amount, usable: amount - keep };
    }
  }
  return best;
}

/**
 * 815 ITEM_USE 的 param 编码（源码 SpeedCDPanel.hospitalUseItemSpeed + 真人成功样本实证）。
 * 本地全量：param 恒 `null`（实证 "0|0" 被服务器拒 s=3/item_124017，成功样本 {itemid:510002,amount:9,param:null} s=0）；
 * 本地单条 = 队列 id；跨服全量：指定兵种 `"1,"+armyType`、否则 `"1|0"`；跨服单条 `"1|"+queueId`。
 * @param {boolean} cross 是否跨服战场医院
 * @param {string|number|null} [queueId] 单条队列 id（不传=全量）
 * @param {number} [armyType] 跨服全量时限定兵种（-1/缺省=不限）
 * @returns {string|null} 本地全量返回 null（与成功样本逐键一致）
 */
function itemSpeedParam(cross, queueId, armyType) {
  var qid = queueId == null ? '' : String(queueId);
  if (qid) return cross ? '1|' + qid : qid;
  if (!cross) return null;
  var type = Number(armyType);
  return type > 0 ? '1,' + type : '1|0';
}

/**
 * 决策一轮：按开关分层产出「要发的写动作」，不过的分支带 reason（供静默期归因）。
 * 本函数纯判据、无副作用；去重与发包在 execAction。治疗层与加速层拆开（planHealActions/planSpeedActions），
 * 便于治疗落地后在同一拍内重读在修态只补跑加速层（见 planOnce 修正十四②）。
 * @param {object} snap {quotas, commonIds, thorIds, crossIds, repairing, localRepairing, crossRepairing, gold, speedItem, ratePerMin, mcfg, avaMode, avaWaitIds, avaRepairingIds, …}
 * @returns {{actions:Array<{kind:string, body:object, fp:string, goldCost?:number, label:string}>, reasons:string[]}}
 */
function planActions(snap) {
  var m = snap.mcfg || normalize({});
  var actions = [];
  var reasons = [];
  planHealActions(snap, m, actions, reasons);
  planSpeedActions(snap, m, actions, reasons);
  // 5) 无双（AVA 族）：独立三件套决策，跟随同一套面板开关（详注见 planAvaActions）
  if (snap.avaMode) planAvaActions(snap, m, actions, reasons);
  return { actions: actions, reasons: reasons };
}

/**
 * 治疗层（1 免费/资源续修 + 2 雷神/跨服）：纯判据产出 220/1427，累加进调用方容器。
 * 无返回值：结果只写进传入的 actions/reasons（调用方不得取返回值）。
 * @param {object} snap 快照
 * @param {object} m 归一后的模块配置
 * @param {Array} actions 累加容器
 * @param {Array} reasons 累加容器
 */
function planHealActions(snap, m, actions, reasons) {
  var q = snap.quotas || quickFields(null);

  // 1) 英雄免费快速修理（普通兵，零消耗）——服务器自动优先扣免费额度
  if (!m.freeRepair) {
    reasons.push('freeRepair off');
  } else if (!q) {
    reasons.push('quota unknown (1785 not parsed)');
  } else if (snap.commonIds.length === 0) {
    reasons.push('no common wait');
  } else if (q.commonFreeLeft > 0) {
    var ids = snap.commonIds.slice(0, q.commonFreeLeft);
    var idKeys = (snap.commonKeys || snap.commonIds).slice(0, q.commonFreeLeft);
    actions.push({
      kind: 'heal-local',
      cmd: CMD_ARMY_HEAL_LIST,
      body: { ids: ids },
      fp: 'heal-local',
      ids: ids,
      dedup: idKeys,
      label: 'free heal ' + ids.length + '/' + snap.commonIds.length,
    });
  } else if (!m.resourceRepair) {
    // 免费额度耗尽且未开「用资源续修」：保持零消耗，不花材料修普通兵。
    reasons.push('common free quota exhausted (' + q.commonUse + '/' + q.commonMax + ')');
  } else if (snap.payIds && snap.payIds.length) {
    // 用资源续修：发快照预算出的「买得起」伤兵（服务器先扣免费额度、超出扣材料）。
    actions.push({
      kind: 'heal-local-resource',
      cmd: CMD_ARMY_HEAL_LIST,
      body: { ids: snap.payIds },
      fp: 'heal-local-resource',
      ids: snap.payIds,
      dedup: snap.payKeys || snap.payIds,
      label: 'resource heal ' + snap.payIds.length + '/' + snap.commonIds.length,
    });
  } else if (snap.payIds) {
    reasons.push('no affordable common repair (materials short)');
  } else {
    reasons.push('resource repair: cost pending (snapshot not ready)');
  }

  // 2) 雷神/跨服修理（带材料，默认关）：本地雷神队列并入 220（超免费额度自然扣材料），跨服队列走 1427
  if (snap.crossSkipped) {
    // 战场抢修车间门控关闭/不可判定跳过 1426：与「读了但无待修」区分开，供静默期归因（修正十一）
    reasons.push('cross hospital gate closed (1426 skipped)');
  }
  if (!m.thorRepair) {
    reasons.push('thorRepair off');
  } else {
    if (snap.thorIds.length) {
      actions.push({
        kind: 'heal-local-thor',
        cmd: CMD_ARMY_HEAL_LIST,
        body: { ids: snap.thorIds },
        fp: 'heal-local-thor',
        ids: snap.thorIds,
        dedup: snap.thorKeys || snap.thorIds,
        label: 'local thor heal ' + snap.thorIds.length,
      });
    }
    if (snap.crossIds.length) {
      actions.push({
        kind: 'heal-cross',
        cmd: CMD_ARMY_CROSS_HEAL,
        body: { ids: snap.crossIds },
        fp: 'heal-cross',
        ids: snap.crossIds,
        dedup: snap.crossKeys || snap.crossIds,
        label: 'cross heal ' + snap.crossIds.length,
      });
    }
    if (!snap.thorIds.length && !snap.crossIds.length) reasons.push('no thor/cross wait');
  }
}

/**
 * 加速层（3 钻石 + 4 道具）：纯判据产出 151/1428/815，累加进调用方容器。
 * 单独成函数是为了「同拍二次决策」：治疗层落地后就地重读在修秒和，只补跑本层（见 planOnce）。
 * 无返回值：结果只写进传入的 actions/reasons（调用方不得取返回值）。
 * 第 4 层道具按「时间池」模型折算枚数一次发足（服务器把 amount 当 Σ(枚数×para1) 的时间池、
 * 按队首顺序贪心消耗，实证见头部 815 条目）；同域钻石线本拍已排全量完成时道具线让位（同拍双花防护，同无双 5c）。
 * @param {object} snap 快照
 * @param {object} m 归一后的模块配置
 * @param {Array} actions 累加容器
 * @param {Array} reasons 累加容器
 */
function planSpeedActions(snap, m, actions, reasons) {
  // 3) 钻石加速在修队列（本地 151 + 跨服 1428）：本地/跨服各自按 leftSec 估价，只带余额闸（日预算闸门已废弃）
  if (!m.speedGold) {
    reasons.push('speedGold off');
  } else if (snap.repairing <= 0) {
    reasons.push('nothing under repair');
  } else {
    if (snap.localRepairing > 0) {
      var lc = estimateGold(snap.localRepairing, snap.ratePerMin);
      if (!lc) {
        reasons.push('local gold estimate unavailable (rate ' + snap.ratePerMin + ')');
      } else if (Number(snap.gold) < lc) {
        reasons.push('gold ' + snap.gold + ' < estimate ' + lc + ' (local)');
      } else {
        actions.push({
          kind: 'speed-gold-local',
          cmd: CMD_ORDER_QUEUE_ING_DONE,
          body: {},
          fp: 'speed-gold-local',
          all: true,
          pendingTokens: snap.localRepairingIds || [],
          goldCost: lc,
          label: 'gold speed local (leftSec ' + snap.localRepairing + ')',
        });
      }
    }
    if (snap.crossRepairing > 0) {
      var cc = estimateGold(snap.crossRepairing, snap.ratePerMin);
      if (!cc) {
        reasons.push('cross gold estimate unavailable (rate ' + snap.ratePerMin + ')');
      } else if (Number(snap.gold) < cc) {
        reasons.push('gold ' + snap.gold + ' < estimate ' + cc + ' (cross)');
      } else {
        actions.push({
          kind: 'speed-gold-cross',
          cmd: CMD_SPEEDUP_CROSS_GOLD,
          body: {},
          fp: 'speed-gold-cross',
          all: true,
          pendingTokens: snap.crossRepairingIds || [],
          goldCost: cc,
          label: 'gold speed cross (leftSec ' + snap.crossRepairing + ')',
        });
      }
    }
  }

  // 4) 加速道具加速在修队列（815 ITEM_USE）：本地优先（param=null），否则跨服（param="1|0"）
  if (!m.speedItem) {
    reasons.push('speedItem off');
  } else if (snap.repairing <= 0) {
    reasons.push('nothing under repair for item speed');
  } else if (!snap.speedItem) {
    reasons.push('no hospital speed item in bag');
  } else {
    var x = snap.localRepairing <= 0 && snap.crossRepairing > 0;
    var si = snap.speedItem;
    if (goldPlannedFor(actions, x)) {
      // 同域钻石全量完成已排在前面：道具再打同一批在修队列即同拍双花（钻石侧被拒/跳过时下一拍道具线照常补上）
      reasons.push('item speed ' + (x ? 'cross' : 'local') + ' skipped (gold done this tick)');
    } else {
      var spu = Number(si.secPerUse) || 0;
      var leftSec = x ? snap.crossRepairing : snap.localRepairing;
      var held = Math.max(Number(si.usable == null ? si.amount : si.usable) || 0, 0);
      // para1 不可解（表列漂移）时回退单枚旧口径：宁少花不空转；无持有则归 0 走 reason，不发必拒的 amount:0/1 空包
      var num = spu > 0 ? speedItemNum(leftSec, spu, held, Number(si.useMax)) : held > 0 ? 1 : 0;
      if (!(num > 0)) {
        reasons.push(
          'item speed num=0 (secPerUse ' + spu + '; held ' + held + '; leftSec ' + leftSec + ')',
        );
      } else {
        actions.push({
          kind: x ? 'speed-item-cross' : 'speed-item-local',
          cmd: CMD_ITEM_USE,
          body: {
            itemid: si.itemId,
            amount: num,
            param: itemSpeedParam(x, null, -1),
          },
          fp: x ? 'speed-item-cross' : 'speed-item-local',
          all: true,
          pendingTokens: (x ? snap.crossRepairingIds : snap.localRepairingIds) || [],
          label:
            'item speed ' +
            (x ? 'cross' : 'local') +
            ' #' +
            si.itemId +
            ' x' +
            num +
            ' (held ' +
            si.amount +
            '; leftSec ' +
            leftSec +
            ')',
        });
      }
    }
  }
}

/**
 * 同域钻石加速是否已在本拍排入全量完成动作（供道具线让位判定）。
 * @param {Array<object>} actions 已规划动作
 * @param {boolean} cross 目标域是否跨服
 * @returns {boolean}
 */
function goldPlannedFor(actions, cross) {
  var want = cross ? 'speed-gold-cross' : 'speed-gold-local';
  for (var i = 0; i < actions.length; i++) {
    if (actions[i].kind === want) return true;
  }
  return false;
}

/**
 * 无双（AVA 族）决策层：吃同一套面板开关（修伤兵跟 resourceRepair、加速跟 speedGold/speedItem），
 * 但走独立三件套：6311 批量修 state0、6312 钻石 {ids,useGold:1} / 道具 {ids,itemId,num,useGold:0} 加速 state1。
 * 无双无免费额度概念；余额闸用模式倍率估价（estimateAvaGold）；道具加速需持有专行 15100046 且 para1 可解。
 * 本函数纯判据、无副作用；去重与发包在 execAction（无双动作不入 LOCAL_SYNC_KINDS、不回灌，靠 push 21203/下拍 6310 刷新）。
 * 去重口径（与本地/跨服同构、无抑制时钟）：heal-ava（state0）与 speed-gold-ava/speed-item-ava（state1）均走逐队列 id 令牌：
 *   新令牌（从没在途过的部队）即时放行，同 id 在途未确认绝不第二枪；令牌只在其目标 state 退出 6310 权威读时由
 *   `prunePendingByExit('aw'/'ar', …)` 遗忘（aw=state0 待修集、ar=state1 在修集）。无双 id≡orderId、state0 endTime=0，字段无法
 *   区分再受伤、故靠“退出目标 state 即遗忘”保证同一部队修完再伤即时放行（写成功后另由 execAction 的 kick 催一次确认读）。
 * @param {object} snap 快照（含 avaMode/avaWaitIds/avaRepairingIds/avaGoldMult/avaSpeedItem 等）
 * @param {object} m 归一后的模块配置
 * @param {Array} actions 累加容器
 * @param {Array} reasons 累加容器
 */
function planAvaActions(snap, m, actions, reasons) {
  var cmds = AVA_MODE_CMDS[snap.avaMode];
  if (!cmds) return;
  if (!snap.avaReadOk) {
    reasons.push('ava hospital read failed (' + snap.avaMode + ')');
    return;
  }
  // 5a) 批量修待修（吃资源/时长，归「用资源续修」闸）
  if (!m.resourceRepair) {
    reasons.push('resourceRepair off (ava cure)');
  } else if (!snap.avaWaitIds.length) {
    reasons.push('no ava wait');
  } else {
    actions.push({
      kind: 'heal-ava',
      cmd: cmds.cure,
      body: { ids: snap.avaWaitIds },
      fp: 'heal-ava',
      ids: snap.avaWaitIds,
      dedup: snap.avaWaitIds,
      label: 'ava heal(' + snap.avaMode + ') ' + snap.avaWaitIds.length,
    });
  }
  // 5b) 钻石加速全部在修
  if (!m.speedGold) {
    reasons.push('speedGold off (ava)');
  } else if (!snap.avaRepairingIds.length) {
    reasons.push('no ava under repair');
  } else {
    var gc = estimateAvaGold(snap.avaRepairingLeftSec, snap.ratePerMin, snap.avaGoldMult);
    if (!gc) {
      reasons.push('ava gold estimate unavailable (rate ' + snap.ratePerMin + ')');
    } else if (Number(snap.gold) < gc) {
      reasons.push('gold ' + snap.gold + ' < estimate ' + gc + ' (ava)');
    } else {
      actions.push({
        kind: 'speed-gold-ava',
        cmd: cmds.speed,
        body: { ids: snap.avaRepairingIds, useGold: 1 },
        fp: 'speed-gold-ava',
        ids: snap.avaRepairingIds,
        dedup: snap.avaRepairingIds,
        goldCost: gc,
        label:
          'gold speed ava(' +
          snap.avaMode +
          ') ' +
          snap.avaRepairingIds.length +
          ' (leftSec ' +
          snap.avaRepairingLeftSec +
          ')',
      });
    }
  }
  // 5c) 道具加速全部在修（专行 15100046，枚数按 para1 折算）；与 5b 互斥：同一 cmds.speed 目标同集，
  // 钻石全额完成已覆盖时再发道具属同拍双花（游戏 UI 本身也是二选一），钻石优先、道具兑底。
  var avaGoldPlanned = false;
  for (var ag = 0; ag < actions.length; ag++) {
    if (actions[ag].kind === 'speed-gold-ava') avaGoldPlanned = true;
  }
  if (!m.speedItem) {
    reasons.push('speedItem off (ava)');
  } else if (avaGoldPlanned) {
    reasons.push('ava item speed skipped (gold done this tick)');
  } else if (!snap.avaRepairingIds.length) {
    reasons.push('no ava under repair for item speed');
  } else if (!snap.avaSpeedItem) {
    reasons.push('no ava hospital speed item in bag');
  } else {
    var num = speedItemNum(
      snap.avaRepairingLeftSec,
      snap.avaSpeedItem.secPerUse,
      snap.avaSpeedItem.amount,
      snap.avaSpeedItem.useMax,
    );
    if (num <= 0) {
      reasons.push(
        'ava item speed: num=0 (secPerUse ' +
          snap.avaSpeedItem.secPerUse +
          '; held ' +
          snap.avaSpeedItem.amount +
          ')',
      );
    } else {
      actions.push({
        kind: 'speed-item-ava',
        cmd: cmds.speed,
        body: { ids: snap.avaRepairingIds, itemId: snap.avaSpeedItem.itemId, num: num, useGold: 0 },
        fp: 'speed-item-ava',
        ids: snap.avaRepairingIds,
        dedup: snap.avaRepairingIds,
        // 道具 num 按全集 Σleft 池级折算、不可拆子集：任一在途即整域跳过（否则会按全集 num 只加速部分队列→超烧非幂等道具）
        atomic: true,
        label:
          'item speed ava(' +
          snap.avaMode +
          ') #' +
          snap.avaSpeedItem.itemId +
          ' x' +
          num +
          ' (held ' +
          snap.avaSpeedItem.amount +
          ')',
      });
    }
  }
}

/**
 * 下拍择时（无抑制时钟、去勤扫）：无论忙闲一律返回慢心跳（只靠 push 边沿即时、心跳兜底丢推）；
 * 连续被拒达阈时×2（保留退避）。snap 保留形参但不再参与判定（免为「有没有活」再花一发读）。
 * @param {object} [snap] 快照（当前忽略，兼容调用方形态）
 * @param {object} m 归一后的模块配置
 * @param {number} streak 当前连续被拒次数
 * @returns {number} 毫秒
 */
function nextDelayMs(snap, m, streak) {
  var idle = Math.max(IDLE_TICK_MS, (m.pollIntervalSec || 60) * 1000);
  return streak >= REJECT_STREAK_LIMIT ? idle * 2 : idle;
}

// ─────────────────────────── 游戏态只读访问（try/catch 降级） ───────────────────────────

/**
 * UserData 只读入口（现读不缓存：切图/进战场时 UserData 被整体替换，缓存会读到过期队列）。
 * @returns {object|null} dataCenter 未就绪/取不到返回 null
 */
function userData() {
  try {
    return (dataCenter && dataCenter.UserData) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 本地伤兵队列（只读）。优先走游戏 `UserData.getOrderQueuesByType(1)`（源码同款口径），
 * 方法缺失时回退直读 `UserData.OrderQueues` 数组（splitWaitIds 仍按 type===1 过滤）。
 * @returns {Array<object>|null} 拿不到返回 null（本轮不发任何写动作）
 */
function healQueues() {
  var u = userData();
  if (!u) return null;
  try {
    if (typeof u.getOrderQueuesByType === 'function') {
      var qs = u.getOrderQueuesByType(ORDER_TYPE_HEAL);
      if (Array.isArray(qs)) return qs;
    }
  } catch (e) {}
  try {
    var arr = u.OrderQueues;
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

/**
 * orderId → 是否雷神部队（Data.thor_group>0）。部队对象取不到时返回 false。
 * 源码锚点 FlameController.isFlameArmyById = `UserData.getArmyByArmyUuid(orderId).Data.thor_group>0`。
 * @param {string} orderId 部队 uuid（十进制串）
 * @returns {boolean}
 */
function thorOfOrderId(orderId) {
  var u = userData();
  if (!u || typeof u.getArmyByArmyUuid !== 'function') return false;
  var army;
  try {
    army = u.getArmyByArmyUuid(orderId);
  } catch (e) {
    army = null;
  }
  return isThorArmy(army);
}

/** @returns {number} 钻石余额（UserData.Resource.Gold）；取不到 0（=钻石分支因余额不足自然跳过） */
function goldBalance() {
  try {
    var r = userData().Resource;
    return Number(r && r.Gold) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * resId（ResourceType 枚举号）→ 当前持有量（源码 ResourceData.getResource）；取不到 0。
 * @param {number} resId
 * @returns {number}
 */
function resourceHolding(resId) {
  try {
    var r = userData().Resource;
    if (r && typeof r.getResource === 'function') return Number(r.getResource(resId)) || 0;
    return 0;
  } catch (e) {
    return 0;
  }
}

/**
 * orderId → 该伤兵部队 repair_cost 解析后的成本项。拿不到 army 或无 repair_cost 字段时
 * 返回 null（不可判定，调用方据此跳过、不盲发），army 在但零成本时返回 []。
 * @param {string} orderId 部队 uuid（十进制串）
 * @returns {Array<{resId:number, amount:number}>|null}
 */
function repairCostOfOrderId(orderId) {
  var u = userData();
  if (!u || typeof u.getArmyByArmyUuid !== 'function') return null;
  var army;
  try {
    army = u.getArmyByArmyUuid(orderId);
  } catch (e) {
    army = null;
  }
  var cost = army && army.Data && army.Data.repair_cost;
  if (cost == null || cost === '') return cost === '' ? [] : null;
  return parseRepairCost(cost);
}

/**
 * ITEM 表 type=12 的候选道具 id 集（源码 SpeedCDPanel.setCDItem → getTableIdByKeyValue(ITEM,'type',12)）。
 * @returns {number[]}
 */
function hospitalSpeedItemIds() {
  try {
    var rows = l10n.tableRows(ITEM_TABLE_SEMANTIC);
    if (Array.isArray(rows) && rows.length) {
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r && Number(r.type) === ITEM_TYPE_HOSPITAL_SPEED && Number(r.id) > 0) {
          out.push(Number(r.id));
        }
      }
      if (out.length) return out;
    }
  } catch (e) {}
  return [];
}

/** @type {string} ITEM 表语义名（l10n.tableRow/tableRows 的键） */
const ITEM_TABLE_SEMANTIC = 'item';

/**
 * 候选道具的背包持有量视图。
 * @param {number[]} ids 候选 itemId
 * @returns {Array<{id:number, amount:number}>}
 */
function heldSpeedItems(ids) {
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    out.push({ id: ids[i], amount: gameData.itemAmount(ids[i]) });
  }
  return out;
}

/**
 * 道具加速元数据（ITEM 行）：`para1`=单枚缩短秒数（510002=28800）、`use_max`=背包「使用」按钮的单次上限。
 * 表行不可用（符号漂移/缺行）时两项皆 0，调用方自行降级。
 * @param {number} itemId 道具 id
 * @returns {{secPerUse:number, useMaxRow:number}}
 */
function itemSpeedRow(itemId) {
  var out = { secPerUse: 0, useMaxRow: 0 };
  try {
    var row = l10n.tableRow(ITEM_TABLE_SEMANTIC, itemId);
    if (row) {
      out.secPerUse = Number(row.para1) || 0;
      out.useMaxRow = Number(row.use_max) || 0;
    }
  } catch (e) {}
  return out;
}

/**
 * 单次道具枚数上限（DATACONFIG 18002 useItem_num，实测 10000）；取不到返回 0=不设限。
 * @returns {number}
 */
function cfgItemSpeedUseMax() {
  try {
    return Number(gameTools && gameTools.getDataConfigData(CFG_ITEM_SPEED_USE_MAX)) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 普通医院加速道具持有视图：候选（ITEM type=12）里挑持有最多者，再补上枚数决策要素。
 * 上限只取 cfg(18002)——ITEM 行 `use_max=1` 是背包单次上限，不约束医院 815 的多枚同发（实证见头部）。
 * @returns {{itemId:number, amount:number, usable:number, secPerUse:number, useMax:number}|null} 无候选返回 null
 */
function hospitalSpeedItemInfo() {
  var picked = pickSpeedItem(heldSpeedItems(hospitalSpeedItemIds()), 0);
  if (!picked) return null;
  var row = itemSpeedRow(picked.itemId);
  return {
    itemId: picked.itemId,
    amount: picked.amount,
    usable: picked.usable,
    secPerUse: row.secPerUse,
    useMax: cfgItemSpeedUseMax(),
  };
}

/**
 * 钻石加速每分钟单价（DATACONFIG 61017，走 GameTools.getDataConfigData）；取不到返回 0（=无从判定，钻石分支跳过）。
 * @returns {number}
 */
function goldRatePerMin() {
  try {
    return Number(gameTools && gameTools.getDataConfigData(CFG_GOLD_PER_MIN)) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * CrossUtils 惰性解析（软依赖：首次启用可能尚未被 __require 填充，失败不落永久缓存，
 * 每拍重试可自愈；解析成功后模块对象稳定，后续不再走 game.get）。同 battleFieldHospitalOpen 的每拍实时口径。
 * @returns {object|null} 含 isNewCAB 静态判据的模块对象
 */
function resolveCrossUtils() {
  if (crossUtils) return crossUtils;
  var cuMod = game.get('CrossUtils');
  if (cuMod && typeof cuMod.isNewCAB === 'function') crossUtils = cuMod;
  else if (cuMod && cuMod.default && typeof cuMod.default.isNewCAB === 'function')
    crossUtils = cuMod.default;
  return crossUtils;
}

/**
 * 当前无双模式（只读探测 CrossUtils 四判据，逐判据 try/catch，单点抛错不影响其余）。
 * @returns {string|null} 'ava'|'tm'|'master'|'legend'|null（null=不在无双战场/符号缺失）
 */
function avaModeNow() {
  var cu = resolveCrossUtils();
  if (!cu) return null;
  var flags = { isNewCAB: false, isTM: false, isMaster: false, isLegend: false };
  try {
    flags.isNewCAB = !!cu.isNewCAB();
  } catch (e) {}
  try {
    flags.isTM = !!cu.isTMServer();
  } catch (e) {}
  try {
    flags.isMaster = !!cu.isMasterMatch();
  } catch (e) {}
  try {
    flags.isLegend = !!cu.isTeamLegendServer();
  } catch (e) {}
  return pickAvaMode(flags);
}

/**
 * 无双钻石倍率（模式对应 DATACONFIG 键；取不到按 1，同源码 `||1`）。
 * @param {string} mode avaModeNow 产出的模式名
 * @returns {number}
 */
function avaGoldMultOf(mode) {
  var key = AVA_GOLD_CFG[mode];
  if (!key) return 1;
  try {
    return Number(gameTools && gameTools.getDataConfigData(key)) || 1;
  } catch (e) {
    return 1;
  }
}

/**
 * 无双医院加速道具持有视图（专行 15100046：持有量走 gameData.itemAmount，secPerUse/useMax 查 ITEM 表行，
 * use_max 缺行时回退 DATACONFIG 18002，同竞品 B）。不要求行 type=12：即便表列漂移，服务器才是持有与可用的真相。
 * @returns {{itemId:number, amount:number, secPerUse:number, useMax:number}|null} 背包无持有返回 null
 */
function avaSpeedItemInfo() {
  var amount = 0;
  try {
    amount = Number(gameData.itemAmount(AVA_HOSPITAL_SPEED_ITEM)) || 0;
  } catch (e) {}
  if (!(amount > 0)) return null;
  var row = itemSpeedRow(AVA_HOSPITAL_SPEED_ITEM);
  var secPerUse = row.secPerUse;
  var useMax = row.useMaxRow || cfgItemSpeedUseMax();
  return {
    itemId: AVA_HOSPITAL_SPEED_ITEM,
    amount: amount,
    secPerUse: secPerUse,
    useMax: useMax,
  };
}

/**
 * 「战场抢修车间」是否开启（1426 族门控，源码锚点 WareHouseControllerNew.isBattleFieldHospitalValid：
 * FunctionOn(cross_server_battle_hospital) 且战场 HospitalEndTime 窗口未到期）。优先借游戏自带权威判据，
 * 符号不可用时降级只查功能开关（gameData.functionOnValue 三态）；两者都取不到回 true（无从判定=照旧轮询，
 * 宁多读一笔不漏修）。
 * @returns {boolean}
 */
function battleFieldHospitalOpen() {
  try {
    var m = game.get('WareHouseControllerNew');
    var C =
      m && (m.WareHouseControllerNew || m.default) ? m.WareHouseControllerNew || m.default : m;
    var inst = C && typeof C.isBattleFieldHospitalValid === 'function' ? C : C && C.instance;
    if (inst && typeof inst.isBattleFieldHospitalValid === 'function') {
      return !!inst.isBattleFieldHospitalValid();
    }
  } catch (e) {}
  var fo = null;
  try {
    fo = gameData.functionOnValue(FUNC_KEY_CROSS_BATTLE_HOSPITAL);
  } catch (e) {}
  return fo === null ? true : fo;
}

// ─────────────────────────── 在途令牌（无抑制时钟） ───────────────────────────

/**
 * 动作名 → 在途族代号（供 prunePendingByExit 按族确认清除）：
 *   lw=本地治疗族（state0 待修令牌 `id#orderId#endTime`）；cw=跨服治疗族（state0 `id#army#et`）；
 *   aw=无双治疗族（state0 plain id）；lr=本地加速族（state1 plain id）；cr=跨服加速族（state1 plain id）；
 *   ar=无双加速族（state1 plain id）。治疗族确认集=该域 state0 活跃令牌，加速族确认集=该域 state1 活跃令牌。
 * @type {Object<string, string>}
 */
var FP_FAMILY = {
  'heal-local': 'lw',
  'heal-local-thor': 'lw',
  'heal-local-resource': 'lw',
  'heal-cross': 'cw',
  'heal-ava': 'aw',
  'speed-gold-local': 'lr',
  'speed-item-local': 'lr',
  'speed-gold-cross': 'cr',
  'speed-item-cross': 'cr',
  'speed-gold-ava': 'ar',
  'speed-item-ava': 'ar',
};

/**
 * 在途令牌是否仍在途（无 TTL：仅当 prunePendingByExit 观测到其目标 state 退出权威读后才删除）。
 * @param {string} k 指纹键（`动作名|去重令牌`）
 * @returns {boolean}
 */
function isPending(k) {
  return k in sentFp;
}

/**
 * 登记在途令牌：逐令牌动作登记实际发送的去重令牌，全量动作登记该域活跃令牌集（act.pendingTokens）。
 * 值恒 Infinity（永不到期）；同槽再次受伤产生新令牌→新键→即时放行，旧令牌待其 state 退出时由 prune 遗忘。
 * @param {string} key 动作名
 * @param {string[]} [tokens] 去重令牌列表
 */
function markPending(key, tokens) {
  if (!tokens || !tokens.length) return;
  for (var i = 0; i < tokens.length; i++) sentFp[key + '|' + tokens[i]] = Infinity;
}

/**
 * 确认清除：删除族代号 `tag` 下所有「令牌已不在当前该 state 活跃集」的在途项（目标 state 退出权威读 ⇒ 遗忘）。
 * activeSet 为 null/无 has（读失败/形态漂移）时整体不动，宁不清不误删在途令牌。
 * @param {string} tag FP_FAMILY 族代号（lw/cw/aw/lr/cr/ar）
 * @param {Set<string>} activeSet 当前该 state 的活跃令牌集
 */
function prunePendingByExit(tag, activeSet) {
  if (!tag || !activeSet || typeof activeSet.has !== 'function') return;
  for (var k in sentFp) {
    var i = k.indexOf('|');
    if (i < 0) continue;
    if (FP_FAMILY[k.slice(0, i)] !== tag) continue;
    if (!activeSet.has(k.slice(i + 1))) delete sentFp[k];
  }
}

// ─────────────────────────── 发包 ───────────────────────────

/**
 * 判定一个失败应答是否为治疗批量的 `param error`（common_159995）。
 * 220/1427 原子批量含无效/空槽（陈旧幻影）时整批被此码拒绝。用于触发逐 id 隔离重发与幻影延长抑制。
 * @param {object|null} ret net.sendGuarded 结果（失败态）
 * @returns {boolean}
 */
function isParamErrorRet(ret) {
  return (rejectText(ret) || '').indexOf(ERR_PARAM_HEAL) >= 0;
}

/**
 * 是否为批量治疗写命令（220 ARMY_HEAL_LIST / 1427 ARMY_CROSS_HEAL）——两者都以 ids 数组批量、且原子。
 * @param {number} cmd 命令号
 * @returns {boolean}
 */
function isHealBatchCmd(cmd) {
  return cmd === CMD_ARMY_HEAL_LIST || cmd === CMD_ARMY_CROSS_HEAL;
}

/**
 * 本地队列类动作 ⇒ 成功后需把服务器应答的权威队列回灌 `UserData`（消除幻影）。
 * 仅覆盖本地流：220（heal-local / heal-local-thor / heal-local-resource）、151 钻石全量（speed-gold-local）。
 * 本地道具 815（speed-item-local）不在表内：其实应答仅 {itemId,amount}、不含队列，无东西可回灌，幻影靠下拍 push 10120 确认读。
 * 跨服流（heal-cross / speed-gold-cross / speed-item-cross）不回灌——战场队列由 1426/push 权威刷新。
 * @type {Object<string, true>}
 */
var LOCAL_SYNC_KINDS = {
  'heal-local': true,
  'heal-local-thor': true,
  'heal-local-resource': true,
  'speed-gold-local': true,
};

/**
 * 治疗类动作（产出 220/1427）：落地后触发同拍「加速二次决策」（修正十四②）——本地流成功已把权威
 * 队列回灌 UserData.OrderQueues，就地重读即能看到刚开修的队列，不必等到下一拍。
 * 无双 heal-ava 不在此列：其队列态只能靠下拍 6310 权威读（不回灌本地队列）。
 * @type {Object<string, true>}
 */
var HEAL_LANES = {
  'heal-local': true,
  'heal-local-resource': true,
  'heal-local-thor': true,
  'heal-cross': true,
};

/**
 * 治疗/加速成功后，借用游戏官方 sanctioned 的 `UserData.UpdateOrderQueues(respQueues)` 把服务器
 * 权威队列按 id 回灌本地态（源码 `HospitalComponentNew`/`HospitalArmySelectPopup` 与竞品 B
 * `hospitalStart`/`hospitalEnd` 同款）。direct-send 原本不回写客户端 OrderQueues，已治好/已加速的
 * 槽会以陈旧“幻影”滞留显示待修，诱发下一拍重发 → common_159995；quickRepair 破例用此入口从根消除幻影
 * （不改其它 feat 的只读红线；UpdateOrderQueues 只按 id 覆盖为服务器版本，非自造增删）。符号缺失/异常静默降级。
 * @param {object} act 已成功的本地队列类动作
 * @param {object} ret net.sendGuarded 成功结果
 * @returns {boolean} 是否成功回灌（供日志；失败不改变发送结果判定）
 */
function syncLocalQueues(act, ret) {
  if (!act || !LOCAL_SYNC_KINDS[act.kind]) return false;
  var u = userData();
  if (!u || typeof u.UpdateOrderQueues !== 'function') return false;
  var d = parseData(ret && ret.data);
  var qs =
    d && Array.isArray(d.queues)
      ? d.queues
      : d && Array.isArray(d.orderQueues)
        ? d.orderQueues
        : null;
  if (!qs || !qs.length) return false;
  try {
    u.UpdateOrderQueues(qs);
    return true;
  } catch (e) {
    log.debug('UpdateOrderQueues sync failed (%s): %s', act.kind, (e && e.message) || e);
    return false;
  }
}

/**
 * 直发一个已规划动作（带在途令牌闸门与确认清除去重）；永不 reject。
 * @param {object} act planActions 产出的一项
 * @returns {Promise<string>} 'sent' | 'skipped' | 'rejected' | 'not-sent'
 */
async function execAction(act) {
  if (!act || typeof act.cmd !== 'number') return 'skipped';
  var body = act.body;
  var ids = act.ids;
  var dedup = act.dedup || ids;
  var tokens = dedup;
  var sentIds = ids;
  if (act.all) {
    // 全量不点名动作（body={} 的 151/1428/815 本地/跨服）：不可拆子集，任一受影响令牌仍在途即整域跳过（绝不第二枪）
    var pt = act.pendingTokens || [];
    for (var p = 0; p < pt.length; p++) {
      if (isPending(act.fp + '|' + pt[p])) {
        log.debug('action %s pending token %s in flight, skip whole batch.', act.kind, pt[p]);
        return 'skipped';
      }
    }
  } else if (dedup && dedup.length) {
    // 逐去重令牌只补发未在途项（令牌含 orderId/endTime，同一槽新进的伤兵即时放行）
    var keep = [];
    for (var i = 0; i < dedup.length; i++) {
      if (!isPending(act.fp + '|' + dedup[i])) keep.push(i);
    }
    if (!keep.length) {
      log.debug('action %s all pending (in flight), skip.', act.kind);
      return 'skipped';
    }
    // 池级折算动作（道具 num 按全集算）不可拆子集：任一在途即整域跳过，避免超烧非幂等道具（钻石 useGold 逐队列计费不受此限）
    if (act.atomic && keep.length !== dedup.length) {
      log.debug('action %s partially in flight (atomic pool), skip whole batch.', act.kind);
      return 'skipped';
    }
    if (keep.length !== dedup.length) {
      tokens = [];
      if (ids) {
        var subIds = [];
        for (var j = 0; j < keep.length; j++) {
          subIds.push(ids[keep[j]]);
          tokens.push(dedup[keep[j]]);
        }
        // 部分过滤时只替换 ids，保留 body 其余键（如 206 单条形态/无双道具的 itemId/num/useGold）
        body = Object.assign({}, body, { ids: subIds });
        sentIds = subIds;
      } else {
        for (var k = 0; k < keep.length; k++) tokens.push(dedup[keep[k]]);
      }
    }
  }
  var ret = await net.sendGuarded(act.cmd, body, {
    onError: function (err) {
      log.warn('cmd %d send threw: %s', act.cmd, err && err.message);
    },
  });
  if (!aliveFn()) return 'skipped';
  var code = ret ? ret.code : CODE_NOT_SENT;
  if (!ret || !ret.ok) {
    if (code === CODE_NOT_SENT) {
      // 真异常：没能发出去（闸门在途/超时/socket）——不登记指纹，下一拍重试
      log.warn('cmd %d not sent (%s).', act.cmd, act.kind);
      return 'not-sent';
    }
    // 治疗批量 param error：原子 220/1427 被批内某个无效/空槽（陈旧幻影）连累整批被拒，
    // 同批真伤会漏修 → 逐 id 单发隔离：真伤即时补修，确认幻影单独 param error 后延长抑制。
    if (isHealBatchCmd(act.cmd) && sentIds && sentIds.length > 1 && isParamErrorRet(ret)) {
      log.info(
        'cmd %d param error (%s, batch %d) → bisect per-id.',
        act.cmd,
        act.kind,
        sentIds.length,
      );
      return await bisectHeal(act, sentIds, tokens);
    }
    // 单条治疗仍 param error ⇒ 该 id 当前为陈旧幻影（客户端 OrderQueues 滞后）：依「全废时钟」不登记任何抑制，
    // 不计 rejectStreak（非真业务故障）；回灌能确认其退出 state0 则自然遗忘，否则下次事件重试（风险已接受）。
    if (isHealBatchCmd(act.cmd) && isParamErrorRet(ret)) {
      log.debug('cmd %d stale-phantom param error (%s); retry on next event.', act.cmd, act.kind);
      return 'rejected';
    }
    rejectStreak++;
    // 其余可预期业务拒绝（无伤兵/额度耗尽/材料不足）：依「全废时钟」不登记抑制，由 kick/心跳自然重试。
    log.info(
      'cmd %d rejected (%s, streak #%d). code=%s;data=%s',
      act.cmd,
      act.kind,
      rejectStreak,
      code,
      rejectText(ret) || '-',
    );
    return 'rejected';
  }
  rejectStreak = 0;
  // 成功：登记在途令牌（逐令牌=已发送 tokens；全量=该域活跃令牌集 pendingTokens），待其目标 state 退出权威读时由 prunePendingByExit 遗忘。
  if (act.all) markPending(act.fp, act.pendingTokens);
  else markPending(act.fp, tokens);
  // 破例借用游戏官方 UpdateOrderQueues 把权威队列回灌本地态（从根消除幻影）：本地钻石 151/治疗 220 应答带 orderQueues，
  //   回灌成功后刚处理队列在下一读即消失，作为本地流在途令牌的「确认」源（配合 prunePendingByExit 遗忘）。
  var synced = syncLocalQueues(act, ret);
  log.info(
    '%s sent. cmd=%d;body=%s%s',
    act.label,
    act.cmd,
    JSON.stringify(body),
    synced ? ' (queues synced)' : '',
  );
  // 任一写动作成功 → 催一拍尽早拿「确认读」，缩小在途窗（createCycle 单飞，kick 仅置 pending、不打断本拍连发）。
  kick();
  return 'sent';
}

/**
 * 治疗批量被 param error 整批拒绝后的「逐 id 隔离重发」。原子 220/1427 只要混入一个无效/空槽
 * （客户端 OrderQueues 滞后产生的陈旧幻影），同批真伤会被连累一起被拒→偶发漏修。逐条单发后：
 *   - 单发成功 ⇒ 真伤已治好，markPending 登记该令牌（待其退出 state0 时由 prune 遗忘）；
 *   - 单发仍 param error ⇒ 该 id 确为陈旧幻影，依「全废时钟」不登记任何抑制（下次事件重试，风险已接受）；
 *   - 其他业务拒绝（额度/材料）⇒ 同样不登记，仅计入退避依据；没发出去（CODE_NOT_SENT）⇒ 不登记，下次再判。
 * 仅由 execAction 在批量 param error 时调用（已确认至少一个 id 无效）。
 * @param {object} act planActions 的一项（治疗批量命令）
 * @param {string[]} sentIds 实际发送过的 id 列表
 * @param {string[]} tokens 与 sentIds 同序的去重令牌
 * @returns {Promise<string>} 'sent'（至少治好一个）| 'rejected'
 */
async function bisectHeal(act, sentIds, tokens) {
  var anySent = false;
  var sawRealReject = false;
  for (var i = 0; i < sentIds.length; i++) {
    if (!aliveFn()) break;
    if (i > 0) {
      await new Promise(function (r) {
        setTimeout(r, INTER_SEND_MS);
      });
    }
    if (!aliveFn()) break;
    var id = sentIds[i];
    var tok = (tokens && tokens[i]) || id;
    var one = await net.sendGuarded(
      act.cmd,
      { ids: [id] },
      {
        onError: function (err) {
          log.warn('cmd %d bisect send threw: %s', act.cmd, err && err.message);
        },
      },
    );
    if (!aliveFn()) break;
    if (!one || !one.ok) {
      if (one && one.code === CODE_NOT_SENT) continue;
      // 单发仍 param error ⇒ 确认幻影，不登记抑制（下次事件重试）；其他业务拒绝 ⇒ 计入退避依据，同样不登记。
      if (!isParamErrorRet(one)) sawRealReject = true;
      continue;
    }
    anySent = true;
    rejectStreak = 0;
    markPending(act.fp, [tok]);
    syncLocalQueues(act, one);
    log.info('%s sent (bisect). cmd=%d;body=%s', act.label, act.cmd, JSON.stringify({ ids: [id] }));
  }
  if (!anySent && sawRealReject) rejectStreak++;
  // 任一单发落地 → 催一拍取确认读（回灌/prune），使真伤确认即时生效。
  if (anySent) kick();
  return anySent ? 'sent' : 'rejected';
}

// ─────────────────────────── 主流程 ───────────────────────────

/**
 * 现场快照：1785 额度权威读 + 无双/跨服二选一队列读（无双模式在场走 6310 族、不发 1426；
 * 非无双时 1426 受 battleFieldHospitalOpen 门控）+ 本地伤兵队列只读投影。
 * 任一读失败都如实带 null/false 下来，由 planOnce 的 reason 分支静默。
 * @returns {Promise<object|null>} 快照；本地队列与无双模式都拿不到（游戏态未就绪）返回 null
 */
async function snapshot() {
  var queues = healQueues();
  var mode = avaModeNow();
  if (!queues && !mode) return null;
  var quotaRet = await net.sendGuarded(
    CMD_GET_QUICK_REPARE,
    {},
    {
      onError: function (err) {
        log.warn('cmd %d send threw: %s', CMD_GET_QUICK_REPARE, err && err.message);
      },
    },
  );
  var crossRet = null;
  var crossSkipped = false;
  if (!mode && queues && battleFieldHospitalOpen()) {
    crossRet = await net.sendGuarded(
      CMD_GET_CROSS_HOSPITAL_QUEUES,
      {},
      {
        onError: function (err) {
          log.warn('cmd %d send threw: %s', CMD_GET_CROSS_HOSPITAL_QUEUES, err && err.message);
        },
      },
    );
  } else if (!mode && queues) {
    crossSkipped = true;
  }
  var avaRet = null;
  if (mode) {
    // 无双权威读请求体恒 null（游戏 NET.send(6310,null) 同款，录制实证 req.data=null）；不兜底 {}
    avaRet = await net.sendGuarded(AVA_MODE_CMDS[mode].ask, null, {
      onError: function (err) {
        log.warn('ava cmd %d ask send threw: %s', AVA_MODE_CMDS[mode].ask, err && err.message);
      },
    });
  }
  if (!aliveFn()) return null;
  var serverTime = gameData.serverTime ? gameData.serverTime() : 0;
  var quotas = quickFields(parseData(quotaRet && quotaRet.data));
  var crossData = parseData(crossRet && crossRet.data);
  var split = splitWaitIds(queues, thorOfOrderId);
  var crossIds = crossWaitIds(crossData);
  var localRepairing = repairingLeftSec(queues, serverTime);
  var crossRepairing = crossRepairingLeftSec(crossData, serverTime);
  // queues 非有效数组（游戏态未就绪）时不置空集（会误清全部本地在途），置 null 供下方门控：
  var localWaitTokens = Array.isArray(queues) ? localWaitTokenSet(queues) : null;
  var localRepairingSet = Array.isArray(queues) ? localRepairingIdSet(queues) : new Set();
  var localRepairingIds = Array.from(localRepairingSet);
  var crossRepairingIdArr = crossRepairingIds(crossData);
  var avaData = avaRet && avaRet.ok ? parseData(avaRet.data) : null;
  var avaList = avaData && Array.isArray(avaData.list) ? avaData.list : null;
  // 6310 应答 OK 但 list 缺席/非数组（形态漂移或空医院省略键）：不 prune（宁不整清、避免误删在途令牌），无双层由 avaReadOk=false 自然静默；待下一次有效读回归时再观测离队。
  if (mode && avaRet && avaRet.ok && avaData && !Array.isArray(avaData.list)) {
    log.debug('ava 6310 ok but list absent/not-array (mode %s); skip prune this tick.', mode);
  }
  var avaW = avaWaitIds(avaList);
  var avaR = avaRepairingIds(avaList);
  // 确认清除（无抑制时钟）：各场景按「目标 state 退出权威读」遗忘在途令牌——治疗族确认集=state0、加速族确认集=state1。
  //   本地：queues 为有效数组才 prune；跨服：1426 读 OK 且未门控跳过才 prune；无双：6310 list 为有效数组才 prune。
  if (localWaitTokens) {
    prunePendingByExit('lw', localWaitTokens);
    prunePendingByExit('lr', localRepairingSet);
  }
  if (crossRet && crossRet.ok && !crossSkipped) {
    prunePendingByExit('cw', crossWaitKeySet(crossData));
    prunePendingByExit('cr', new Set(crossRepairingIdArr));
  }
  if (avaList) {
    prunePendingByExit('aw', avaWaitIdSet(avaList));
    prunePendingByExit('ar', avaRepairingIdSet(avaList));
  }
  // 「用资源续修」仅在开关开、免费额度耗尽且有普通待修时预算：逐伤兵取 repair_cost，按累计持有量筛可负担集（同竞品 B）。
  var payIds = null;
  var payKeys = null;
  if (MCFG.resourceRepair && quotas && quotas.commonFreeLeft <= 0 && split.commonIds.length) {
    var costs = [];
    for (var ci = 0; ci < split.commonOrders.length; ci++) {
      costs.push(repairCostOfOrderId(split.commonOrders[ci]));
    }
    var aff = filterAffordable(costs, resourceHolding);
    payIds = [];
    payKeys = [];
    for (var pi = 0; pi < split.commonIds.length; pi++) {
      if (aff[pi]) {
        payIds.push(split.commonIds[pi]);
        payKeys.push(split.commonKeys[pi]);
      }
    }
  }
  return {
    ok: true,
    quotas: quotas,
    commonIds: split.commonIds,
    commonKeys: split.commonKeys,
    thorIds: split.thorIds,
    thorKeys: split.thorKeys,
    resourceRepair: MCFG.resourceRepair,
    payIds: payIds,
    payKeys: payKeys,
    crossIds: crossIds,
    crossKeys: crossWaitKeys(crossData),
    crossSkipped: crossSkipped,
    localRepairing: localRepairing,
    crossRepairing: crossRepairing,
    repairing: localRepairing + crossRepairing,
    localRepairingIds: localRepairingIds,
    crossRepairingIds: crossRepairingIdArr,
    gold: goldBalance(),
    ratePerMin: goldRatePerMin(),
    speedItem: hospitalSpeedItemInfo(),
    mcfg: MCFG,
    avaMode: mode,
    avaReadOk: !!avaList,
    avaWaitIds: avaW,
    avaRepairingIds: avaR,
    avaRepairingLeftSec: avaRepairingLeftSec(avaList, serverTime),
    avaGoldMult: mode ? avaGoldMultOf(mode) : 0,
    avaSpeedItem: mode ? avaSpeedItemInfo() : null,
  };
}

/**
 * 逐条发一组已规划动作（拍内 1s 节流、pause 即时中止）。
 * @param {Array<object>} actions planActions 的 actions 或 planHealActions/planSpeedActions 的累加容器
 * @returns {Promise<{sent:boolean, healLanded:boolean, aborted:boolean}>} 是否真发过、是否有治疗层落地、是否中辍
 */
async function execActions(actions) {
  var out = { sent: false, healLanded: false, aborted: false };
  for (var j = 0; j < actions.length; j++) {
    var st = await execAction(actions[j]);
    if (st === 'sent') {
      out.sent = true;
      if (HEAL_LANES[actions[j].kind]) out.healLanded = true;
    }
    if (!aliveFn()) {
      out.aborted = true;
      return out;
    }
    if (j < actions.length - 1)
      await new Promise(function (r) {
        setTimeout(r, INTER_SEND_MS);
      });
  }
  return out;
}

/**
 * 治疗落地后的「只重读在修态」轻量快照（纯本地、零网络）：本地流 220 成功已回灌权威队列，
 * 故此处 healQueues() 即时能看到刚开修的队列；跨服在修秒和沿用本拍 1426 读数（战场队列只能等下拍权威读）。
 * @param {object} snap 本轮权威读快照
 * @returns {object|null} 供 planSpeedActions 的快照；本地队列读不到返回 null
 */
function speedSnapshotAfterHeal(snap) {
  var queues = healQueues();
  if (!queues) return null;
  var serverTime = gameData.serverTime ? gameData.serverTime() : 0;
  var local = repairingLeftSec(queues, serverTime);
  return Object.assign({}, snap, {
    localRepairing: local,
    // 与 localRepairing 同源同拍重算 state1 活跃 id 集：刚治好转入 state1 的队列必须进入全量加速动作的 pendingTokens，
    //   否则成功后 markPending 漏登记它们→下拍仍见其 state1 即第二枪（双花钻石/重烧道具）。
    localRepairingIds: Array.from(localRepairingIdSet(queues)),
    repairing: local + (Number(snap.crossRepairing) || 0),
  });
}

/**
 * 一拍：快照 → 决策 → 逐条发包；治疗层有落地时同拍再重读在修态补跑一次加速层。
 * 返回是否真发出去过东西（供择时）。
 * @returns {Promise<boolean>} 有写动作落地返回 true
 */
async function planOnce() {
  var snap = await snapshot();
  if (!snap) {
    log.debug('game state not ready (OrderQueues unavailable), idle.');
    return false;
  }
  var plan = planActions(snap);
  for (var i = 0; i < plan.reasons.length; i++) log.debug('silent: %s', plan.reasons[i]);
  var first = await execActions(plan.actions);
  // 同拍串联修理→加速：加速层原本只能看「heal 之前」的在修态（实测因此白等 5.1s）
  if (!first.healLanded || first.aborted) return first.sent;
  var snap2 = speedSnapshotAfterHeal(snap);
  if (!snap2) return first.sent;
  // planSpeedActions 是「累加容器」语义（写进传入的 actions/reasons，本身无返回值）
  var speedActions = [];
  var speedReasons = [];
  planSpeedActions(snap2, snap2.mcfg || normalize({}), speedActions, speedReasons);
  if (!speedActions.length) {
    for (var r = 0; r < speedReasons.length; r++)
      log.debug('silent(post-heal): %s', speedReasons[r]);
    return first.sent;
  }
  log.debug(
    'post-heal speed pass: %d action(s), repairing %ds.',
    speedActions.length,
    snap2.repairing,
  );
  var second = await execActions(speedActions);
  return first.sent || second.sent;
}

/**
 * cycle 单轮：跑一拍，再返下拍慢心跳（去勤扫：节拍只靠 push 边沿 kick + 心跳兜底）。next-check 日志由 cycle 驱动器统一输出。
 * 在飞期间攒下的触发（写成功后的通用 kick、10120/13006/AVA change push）是权威信号：读 cycle.pending 立即补一拍取确认读、缩小在途窗（createCycle 合并语义，不自激：补扫里同令牌已被 isPending 挡成 skipped）。
 * @returns {Promise<number>} 下一拍间隔（毫秒）
 */
async function cycleRun() {
  await planOnce();
  if (!aliveFn()) return 0;
  if (cycle.pending) return 0;
  return nextDelayMs(null, MCFG, rejectStreak);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * push 唤醒：10120/13006 只当「醒一拍去重读」的提示，载荷不入状态（丢推由兜底轮询自愈）。
 */
function kick() {
  cycle.kick();
}

/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  var missing = [];
  net = ctx.net;
  if (!net || !net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }
  var dcMod = game.get('DataCenter');
  dataCenter = (dcMod && dcMod.DATA) || null;
  if (!dataCenter) missing.push('DataCenter.DATA');
  var gtMod = game.get('GameTools');
  gameTools = (gtMod && gtMod.default) || gtMod || null;
  if (!gameTools || typeof gameTools.getDataConfigData !== 'function') missing.push('GameTools');
  // CrossUtils 软依赖不在 install 期解析（首次启用可能尚未被 __require 填充，钉死会永久禁用无双层）；
  // 由 resolveCrossUtils() 每拍惰性重试，缺失只禁用无双分支、不进 missing 清单、不阻断激活。
  if (missing.length) {
    net = null;
    dataCenter = null;
    gameTools = null;
    log.warn('install failed. missing=%s', missing.join(';'));
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行：复位页内态（被拒计数/指纹）→ 挂 push 唤醒（本地/跨服/无双四模式队列变化）→ 点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  sentFp = Object.create(null);
  ctx.on.push(PUSH_ORDER_QUEUES, kick);
  ctx.on.push(PUSH_CROSS_QUEUE_ADD, kick);
  // 无双四模式队列变化 push 全订（仅唤醒提示、载荷不入状态，非本场模式的号不会到达，多订无副作用）：
  // 否则 TM/Master/Legend 战场只能等轮询兜底，伤兵入队最长近一分钟才开始修（review 修正）
  ctx.on.push(PUSH_AVA_HOSPITAL_CHANGE, kick);
  ctx.on.push(PUSH_TM_HOSPITAL_CHANGE, kick);
  ctx.on.push(PUSH_MASTER_HOSPITAL_CHANGE, kick);
  ctx.on.push(PUSH_LEGEND_HOSPITAL_CHANGE, kick);
  log.info(
    'started. free=%s;res=%s;thor=%s;gold=%s;item=%s;poll=%ds',
    MCFG.freeRepair,
    MCFG.resourceRepair,
    MCFG.thorRepair,
    MCFG.speedGold,
    MCFG.speedItem,
    MCFG.pollIntervalSec,
  );
  cycle.kick();
}

/**
 * 配置灌入：整体接收 toModuleCfg 产物。运行中改动即热更（清掉旧动作指纹，新开关下一拍生效）。
 * @param {object} partial normalize 产物
 * @returns {object} MCFG
 */
function configure(partial) {
  if (partial) MCFG = partial;
  sentFp = Object.create(null);
  if (net && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 向 reactor 注册本功能说明书：places 限定 base/world（Home/NWorldMap），不行军不参战故不设战斗门控。
 * 字段只暴露需用户决策的 3 个付费/带材料开关（雷神/钻石/道具）；钻石只受余额约束、道具持有即动用（日预算/保留下限闸门已废弃）。
 * 免费修理（freeRepair）与超额花资源续修（resourceRepair）恒开、自愈轮询间隔（pollIntervalSec）为系统内置，均不进面板。
 */
reactor.register({
  id: 'quickRepair',
  label: '快速修理',
  storageKey: 'pocketcc.feat.quickRepair',
  symbols: ['dataCenter', 'gameTools', 'tableManager'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: {
    enabled: false,
    freeRepair: true,
    resourceRepair: true,
    thorRepair: false,
    speedGold: false,
    speedItem: false,
    pollIntervalSec: 60,
  },
  fields: [
    {
      key: 'thorRepair',
      label: '修理雷神兵',
      type: 'checkbox',
      hint: '雷神兵与跨服医院伤兵：修理真花材料（无免费额度），默认关。',
    },
    {
      key: 'speedGold',
      label: '使用钻石修',
      type: 'checkbox',
      hint: '对「修理中」队列一键全额完成；花费按每分钟价估算，钻石不足即跳过。',
    },
    {
      key: 'speedItem',
      label: '使用道具修',
      type: 'checkbox',
      hint: '用医院加速道具缩短在修队列：按剩余时间一次折算发足，不必逐枚连点；只要背包持有即动用。',
    },
  ],
  toModuleCfg: function (c) {
    return normalize(c);
  },
  install: install,
  configure: configure,
  run: run,
});

export {
  normalize,
  quickFields,
  isThorArmy,
  splitWaitIds,
  localWaitTokenSet,
  localRepairingIdSet,
  crossWaitIds,
  crossWaitKeys,
  crossWaitKeySet,
  crossRepairingIds,
  crossRepairingIdSet,
  isParamErrorRet,
  isHealBatchCmd,
  LOCAL_SYNC_KINDS,
  repairingLeftSec,
  crossRepairingLeftSec,
  pickAvaMode,
  avaWaitIds,
  avaRepairingIds,
  avaWaitIdSet,
  avaRepairingIdSet,
  avaRepairingLeftSec,
  estimateAvaGold,
  speedItemNum,
  estimateGold,
  parseRepairCost,
  filterAffordable,
  pickSpeedItem,
  itemSpeedParam,
  goldPlannedFor,
  planActions,
  planHealActions,
  planSpeedActions,
  nextDelayMs,
  cfg,
  CMD_GET_QUICK_REPARE,
  CMD_ARMY_HEAL_LIST,
  CMD_GET_CROSS_HOSPITAL_QUEUES,
  CMD_ARMY_CROSS_HEAL,
  CMD_ORDER_QUEUE_ING_DONE,
  CMD_SPEEDUP_CROSS_GOLD,
  CMD_ITEM_USE,
  CMD_AVA_ASK,
  CMD_AVA_CURE,
  CMD_AVA_SPEED,
  CMD_TM_ASK,
  CMD_TM_CURE,
  CMD_TM_SPEED,
  CMD_MASTER_ASK,
  CMD_MASTER_CURE,
  CMD_MASTER_SPEED,
  CMD_LEGEND_ASK,
  CMD_LEGEND_CURE,
  CMD_LEGEND_SPEED,
  AVA_MODE_CMDS,
  AVA_GOLD_CFG,
  AVA_HOSPITAL_SPEED_ITEM,
  CFG_ITEM_SPEED_USE_MAX,
  FUNC_KEY_CROSS_BATTLE_HOSPITAL,
  PUSH_ORDER_QUEUES,
  PUSH_CROSS_QUEUE_ADD,
  PUSH_AVA_HOSPITAL_CHANGE,
  PUSH_TM_HOSPITAL_CHANGE,
  PUSH_MASTER_HOSPITAL_CHANGE,
  PUSH_LEGEND_HOSPITAL_CHANGE,
  FP_FAMILY,
  isPending,
  markPending,
  prunePendingByExit,
  HEAL_LANES,
  ITEM_TYPE_HOSPITAL_SPEED,
  ORDER_TYPE_HEAL,
  CFG_GOLD_PER_MIN,
};
