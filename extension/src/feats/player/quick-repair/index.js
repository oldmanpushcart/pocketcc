/**
 * 快速修理（三场地医院自动修理 + 加速，reactor 说明书形态，日常任务，多分支单链）
 *
 * 玩法：进医院后自动修理伤兵并对在修队列按配置加速，覆盖三场地（面板按场地分段全配）：
 *   - 基地修理厂：本地伤兵队列（220 修 / 151·124 钻石 / 815 道具）；普通兵先扣英雄每日免费额度、
 *     超出扣材料，雷神兵直接扣材料；
 *   - 战场抢修车间：跨服天梯赛战场医院（1427 修 / 1428·815 加速），只收雷神；受赛事窗口门控，
 *     关闸前 10 分钟优先加速本场地；
 *   - 无双修理厂：AVA/TM/大师赛/传奇小队（6310 族），修理免费（只按勾选集合排队），四模式择表。
 *   每场地「修理范围 = 军种×类型多选」+「加速方式 = 不加速/钻石/道具」（基地与无双分普通档/雷神档）。
 *   钻石加速共享用户设定的当日上限（服务器日界归零），默认一律不加速。
 *
 * 协议字典（实录报文实证；源码锚点
 *   `WareHouseControllerNew` / `HospitalComponentNew` / `SpeedCDPanel` / `UserData` / `RequestId`）：
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
 *     124  ORDER_QUEUE_SPEED_UP {id,useGold:1} 钻石加速本地单条在修队列（普通/雷神加速方式不同时逐队列点名用）
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
 * 三场景统一去重（无抑制时钟）：本 feat 发 220/1427/151/124/1428/815/6311/6312 都不经游戏回调，
 *   无去重即会逐拍撞同一批队列。策略：不用任何抑制墙钟，改为「在途令牌 pending，仅由权威读确认清除、无 TTL」。
 *   不变式：新令牌（从没在途过的队列）即时放行；已发未确认的令牌绝不第二枪；钻石/治疗令牌只在其「目标 state 退出权威读」时遗忘；
 *   道具线令牌以应答为权威消耗确认（登记时记确认时刻），经应答之后的一次权威队列读由 `prunePendingConfirmed` 放行——
 *   截断批（useMax/持有修不完全部队列）下拍可续发、不锁整域；确认时刻只用于读序先后，不作 TTL 抑制窗。
 *   原语：execAction 成功后 `markPending`（逐令牌动作记实发令牌；全量 body={{}} 动作记该域活跃令牌集 pendingTokens，
 *   任一受影响令牌仍在途即整域跳过、不拆子集）；snapshot 每拍权威读后 `prunePendingByExit(族, 活跃集)` 按族确认清除——
 *   治疗族（lw/cw/aw）确认集=state0 待处理令牌、加速族（lr/cr/ar）确认集=state1 在修令牌（令牌口径逐族严格同形）。
 * 节拍（去勤扫）：取消 5s 忙时勤扫，只在 push 事件（10120/13006/AVA change×4 → kick）跑一拍 + 一个很慢心跳兜底丢推；
 *   任一写动作成功后同样 kick()，尽早拿到「确认读」缩小在途窗。连续被拒达阈时心跳×2 退避。
 *
 * 幻影回灌（quickRepair 专属例外，是本地流的「确认」源而非时钟）：本地治疗/钻石加速（heal-local / speed-gold-local）
 *   成功后，借用游戏官方应答回调同款 `UserData.UpdateOrderQueues(resp.queues/orderQueues)`
 *   （见源码 HospitalComponentNew/HospitalArmySelectPopup 与竞品 B hospitalStart/hospitalEnd；220/151 本地应答带 orderQueues，
 *   实录 “… (queues synced)” 佐证；本地道具 815 应答仅 {itemId,amount}、不含队列，本例外不适用于它）把服务器权威队列
 *   按 id 回灌本地态，从根消除「已治好/已加速槽滞留成陈旧幻影 → 重发 common_159995」；回灌后该队列退出 state0/state1，
 *   正是 prunePendingByExit 遗忘其本地在途令牌的确认来源。本地道具/跨服/无双无此回灌，靠每拍 push 10120 / 1426 / 6310 权威读确认。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发上述协议。除上述「幻影回灌」借用游戏自带 UpdateOrderQueues
 *   （把服务器已下发的权威队列就地覆盖，非自造增删、不弹 UI）外，不调 StartAllQueue/OpenUI/Delete 等改写本地态
 *   或弹 UI 的原生方法（「feat 只读+发包」红线；UpdateOrderQueues 为 quickRepair 经用户批准的唯一例外）。
 * 普通兵单笔 220 全发：服务器内部优先扣「英雄免费额度」（common_max-common_use）、超出扣材料。
 *   修理范围只按勾选集合过滤（repairBase/repairCsb/repairAva 的军种×类型码集合），不按材料持有量预算
 *   （服务器超限会拒绝且日志可见，少一层「买不起静默跳过」的隐式闸）。
 * 面板形态（场地 × 军种 × 类型全配）：基地修理厂段 = repairBase 多选（六类码 1..6）+ 普通档/雷神档加速；
 *   战场抢修车间段 = repairCsb 多选（仅雷神档码）+ 单键加速；无双修理厂段 = repairAva 多选 + 普通档/雷神档加速；
 *   加速预算段 = goldDailyCap（钻石日上限，0/空 = 不限，跨场地共享、日账按服务器日界归零）。
 *   加速执行口径：同场地同档方式相同 → 全量一笔（151/815 全量，道具时间池不浪费）；方式混排 → 逐队列点名
 *   （124 钻石单条 / 815 param=队列 id），道具逐队列各自向上取整会比时间池多耗几枚，只在该场景付。
 *   存档 _v=4：migrate 把 v1 三开关 / v2 四字段 / v3 九码映射到类型码集合与五键加速方式（钻石优先/道具/不加速）。
 *   生命周期由 reactor 托管：places base/world、kinds homeland、不行军不参战故 offInCombat:false；
 *   pause 后 ctx.alive()=false，cycle 与在飞 await 自然停摆。
 */
import { CODE_NOT_SENT, parseData, rejectText, sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { game } from '../../../core/game.js';
import { l10n, gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { createDailyLedger } from '../../../core/daily-stats.js';

import {
  CMD_GET_QUICK_REPARE,
  CMD_ARMY_HEAL_LIST,
  CMD_GET_CROSS_HOSPITAL_QUEUES,
  CMD_ARMY_CROSS_HEAL,
  CMD_ORDER_QUEUE_ING_DONE,
  CMD_ORDER_QUEUE_SPEED_UP,
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
  PUSH_ORDER_QUEUES,
  PUSH_CROSS_QUEUE_ADD,
  PUSH_AVA_HOSPITAL_CHANGE,
  PUSH_TM_HOSPITAL_CHANGE,
  PUSH_MASTER_HOSPITAL_CHANGE,
  PUSH_LEGEND_HOSPITAL_CHANGE,
} from './constants.js';
// 领域模型（P1 拆出，纯判据无副作用；本文件保留同名导出以满足既有单测口径）
import { classifyUnit } from './model/classify.js';
import { estimateGold, estimateAvaGold, speedItemNum, parseRepairCost } from './model/cost.js';
import { parseQuota } from './model/quota.js';
import {
  pickAvaMode,
  csbDeadlineSec as deadlineOf,
  csbOpen,
  csbClosingSoon,
} from './model/gates.js';
import {
  normalize,
  migrateConfig,
  defaultConfig,
  venueOptions,
  venueMatrixSelectField,
} from './model/schema.js';
import {
  avaEntries,
  baseRepairEntries,
  baseWaitEntries,
  csbRepairEntries,
  csbWaitEntries,
  sumLeft,
} from './model/entries.js';
import { FP_FAMILY, HEAL_LANES, ITEM_SPEED_KINDS, KIND, LOCAL_SYNC_KINDS } from './model/kinds.js';
import { makeBudget, itemSpeedParam } from './venues/shared.js';
import { planBase } from './venues/base.js';
import { planCsb } from './venues/csb.js';
import { planAva } from './venues/ava.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=QUICK-REPAIR） */
const log = createLog('QUICK-REPAIR');

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
 * @type {{csbClosingSoonSec:number}}
 */
const cfg = {
  /** 战场抢修车间关闸前优先窗口（秒）：剩余时间进入该阈值即把抢修车间排到决策最前 */
  csbClosingSoonSec: 600,
};

/** 钻石日上限日账（服务器日界归日）：键 'goldSpent' = 当日已花钻石估算值 */
const goldLedger = createDailyLedger('pocketcc.daily.quickRepair', { seenCap: 0 });

/** @type {object} 面板配置（configure 灌入 toModuleCfg 产物） */
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
 * 1785 应答 → 免费额度（普通兵 + 雷神族按海陆空分档）。
 * @param {object|null} info 1785 应答载荷
 * @returns {{ok:boolean, commonMax:number, commonUse:number, commonFreeLeft:number, thorMax:number, thorUse:number, thorFreeLeft:number, landThorFreeLeft:number, navyThorFreeLeft:number, airThorFreeLeft:number, groupNum:Object<number,number>}|null}
 */
function quickFields(info) {
  return parseQuota(info);
}

/**
 * 待修条目 → 去重令牌集（治疗族 lw/cw/aw 的确认清除集）：令牌由 entries.js 统一产出，
 * 这里只做投影，不再各场地各写一遍队列形态。
 * @param {Array<{key:string}>} entries 待修条目
 * @returns {Set<string>}
 */
function tokenSet(entries) {
  var s = new Set();
  for (var i = 0; i < entries.length; i++) s.add(entries[i].key);
  return s;
}

/**
 * 在修条目 → id 集（加速族 lr/cr/ar 的确认清除集）。
 * @param {Array<{id:string}>} entries 在修条目
 * @returns {Set<string>}
 */
function idSet(entries) {
  var s = new Set();
  for (var i = 0; i < entries.length; i++) s.add(entries[i].id);
  return s;
}

/**
 * 挑一枚医院加速道具：持有最多者，并列取 id 小者（确定性）；无持有返回 null。
 * @param {Array<{id:number, amount:number}>} held 候选道具（ITEM 表 type=12 的持有行）
 * @returns {{itemId:number, amount:number, usable:number}|null}
 */
function pickSpeedItem(held) {
  var best = null;
  if (!Array.isArray(held)) return null;
  for (var i = 0; i < held.length; i++) {
    var it = held[i];
    if (!it || !(Number(it.id) > 0)) continue;
    var amount = Number(it.amount) || 0;
    if (!(amount > 0)) continue;
    if (!best || amount > best.amount || (amount === best.amount && Number(it.id) < best.itemId)) {
      best = { itemId: Number(it.id), amount: amount, usable: amount };
    }
  }
  return best;
}

/**
 * 决策一轮：三个场地（基地 / 战场抢修车间 / 无双）各自产修理+加速动作，累加进同一容器。
 * 纯判据、无副作用；去重与发包在 execAction。共享一份钻石/道具预算投影（同拍累计扣减防超支）。
 * 决策顺序：默认 基地 → 抢修车间 → 无双；抢修车间关闸前（deadline ≤ 阈值）置顶，先加速避免随关闸损毁。
 * @param {object} snap 快照（baseWait/baseRepair/csbWait/csbRepair/avaWait/avaRepair/…）
 * @returns {{actions:Array<{kind:string, body:object, fp:string, goldCost?:number, label:string}>, reasons:string[]}}
 */
function planActions(snap) {
  var m = snap.mcfg || normalize({});
  var actions = [];
  var reasons = [];
  var budget = makeBudget(snap);
  var order = snap.csbClosingSoon ? ['csb', 'base', 'ava'] : ['base', 'csb', 'ava'];
  if (snap.csbClosingSoon) reasons.push('csb closing soon → prioritized');
  for (var i = 0; i < order.length; i++) {
    var venue = order[i];
    if (venue === 'base') planBase(snap, m, budget, actions, reasons);
    else if (venue === 'csb') planCsb(snap, m, budget, actions, reasons);
    else if (snap.avaMode) planAva(snap, m, AVA_MODE_CMDS[snap.avaMode], budget, actions, reasons);
  }
  return { actions: actions, reasons: reasons };
}

/**
 * 同域钻石加速是否已在本拍排入全量完成动作（纯查询，供单测/对拍断言）。
 * @param {Array<object>} actions 已规划动作
 * @param {boolean} cross 目标域是否跨服
 * @returns {boolean}
 */
function goldPlannedFor(actions, cross) {
  var want = cross ? KIND.SPEED_GOLD_CSB : KIND.SPEED_GOLD_BASE;
  for (var i = 0; i < actions.length; i++) {
    if (actions[i].kind === want) return true;
  }
  return false;
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
 * 方法缺失时回退直读 `UserData.OrderQueues` 数组（条目层仍按 type===1 过滤）。
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
 * 每一拍的分类解析器（带缓存）：orderId/部队 uuid → {arm,tier,exact}。
 * 同一部队在一拍里会被等待/在修/多场地反复查询，缓存避免重复走 getArmyByArmyUuid；
 * 部队对象取不到时 classifyUnit 按「陆·普通」兜底（战场抢修车间在 entries 层另按雷神兜底）。
 * @returns {function(string):{arm:string,tier:string,exact:boolean}}
 */
function unitResolver() {
  var u = userData();
  var cache = Object.create(null);
  return function (orderId) {
    var k = orderId == null ? '' : String(orderId);
    if (k in cache) return cache[k];
    var army = null;
    if (u && typeof u.getArmyByArmyUuid === 'function') {
      try {
        army = u.getArmyByArmyUuid(k);
      } catch (e) {
        army = null;
      }
    }
    cache[k] = classifyUnit(army);
    return cache[k];
  };
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
  var picked = pickSpeedItem(heldSpeedItems(hospitalSpeedItemIds()));
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
/**
 * 战场抢修车间开窗的关闸时刻（epoch 秒）：战场模型 HospitalEndTime / CQ25 stormData 二者取有值者。
 * @returns {number} 0=判据缺失
 */
function csbEndTime() {
  var et = 0;
  try {
    var w = game.get('WorldMapCrossServerModel');
    var M =
      w && (w.WorldMapCrossServerModel || w.default) ? w.WorldMapCrossServerModel || w.default : w;
    var inst = M && (M.instance || M);
    et = Number(inst && inst.HospitalEndTime) || 0;
  } catch (e) {}
  if (!(et > 0)) {
    try {
      var q = game.get('CQ25Controller');
      var Q = q && (q.CQ25Controller || q.default) ? q.CQ25Controller || q.default : q;
      var one = Q && typeof Q.getInstance === 'function' ? Q.getInstance() : Q && (Q.instance || Q);
      var storm = one && one.stormData;
      et = Number(storm && storm.HospitalEndTime) || 0;
    } catch (e) {}
  }
  return et;
}

/**
 * 「战场抢修车间」开窗判定（1426 族门控，源码锚点 WareHouseControllerNew.isBattleFieldHospitalValid）：
 * 优先借游戏自带权威判据；符号不可用时按 FunctionOn(cross_server_battle_hospital) + HospitalEndTime 窗口
 * （csbOpen：功能开关关 → 关；窗口到期 → 关；判据缺失 → 开，宁多读一笔不漏修）。
 * deadline 同时供「关闸前优先加速」排序（csbClosingSoon）。
 * @returns {{open:boolean, deadline:number, closingSoon:boolean}}
 */
function csbGate() {
  var serverTime = gameData.serverTime ? gameData.serverTime() : 0;
  var et = csbEndTime();
  var deadline = deadlineOf(et, serverTime);
  var open = null;
  try {
    var m = game.get('WareHouseControllerNew');
    var C =
      m && (m.WareHouseControllerNew || m.default) ? m.WareHouseControllerNew || m.default : m;
    var inst = C && typeof C.isBattleFieldHospitalValid === 'function' ? C : C && C.instance;
    if (inst && typeof inst.isBattleFieldHospitalValid === 'function') {
      open = !!inst.isBattleFieldHospitalValid();
    }
  } catch (e) {}
  if (open === null) {
    var fo = null;
    try {
      fo = gameData.functionOnValue(FUNC_KEY_CROSS_BATTLE_HOSPITAL);
    } catch (e) {}
    open = csbOpen(fo, et, serverTime);
  }
  return {
    open: open,
    deadline: deadline,
    closingSoon: csbClosingSoon(deadline, cfg.csbClosingSoonSec),
  };
}

// ─────────────────────────── 在途令牌（无抑制时钟） ───────────────────────────

/**
 * 在途令牌是否仍在途（无 TTL：钻石/治疗线仅当 prunePendingByExit 观测到其目标 state 退出权威读后才删除；
 * 道具线经应答后一次权威队列读由 prunePendingConfirmed 放行）。
 * @param {string} k 指纹键（`动作名|去重令牌`）
 * @returns {boolean}
 */
function isPending(k) {
  return k in sentFp;
}

/**
 * 登记在途令牌：逐令牌动作登记实际发送的去重令牌，全量动作登记该域活跃令牌集（act.pendingTokens）。
 * 钻石/治疗线值恒 Infinity（永不到期，待 state 退出遗忘）；道具线值=应答确认时刻（读序戳，供 prunePendingConfirmed 放行）。
 * 同槽再次受伤产生新令牌→新键→即时放行，旧令牌待其 state 退出时由 prune 遗忘。
 * @param {string} key 动作名
 * @param {string[]} [tokens] 去重令牌列表
 * @param {number} [confirmedTs] 道具线应答确认时刻（Date.now()）；缺省 Infinity
 */
function markPending(key, tokens, confirmedTs) {
  if (!tokens || !tokens.length) return;
  var v = confirmedTs == null ? Infinity : confirmedTs;
  for (var i = 0; i < tokens.length; i++) sentFp[key + '|' + tokens[i]] = v;
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

/**
 * 确认放行（道具线）：删除族代号 `tag` 下「值为有限确认时刻且早于本次读时刻」的在途项。
 * 道具应答是权威消耗确认，但队列态刷新滞后应答一个 push（实录 40-65ms），故仅在「应答之后的一次权威队列读」
 * （snapshot 按域守卫调用）才放行，防陈旧态重排重烧时间池；确认时刻只用于读序先后，不作 TTL 抑制窗。
 * 钻石/治疗线值为 Infinity，不受本函数影响；同拍内（post-heal 二次决策）不调用，未读不放行。
 * @param {string} tag FP_FAMILY 族代号（lr/cr/ar）
 * @param {number} now 本次权威读时刻（Date.now()）
 */
function prunePendingConfirmed(tag, now) {
  for (var k in sentFp) {
    var i = k.indexOf('|');
    if (i < 0) continue;
    if (FP_FAMILY[k.slice(0, i)] !== tag) continue;
    var v = sentFp[k];
    if (v !== Infinity && v < now) delete sentFp[k];
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
  // 钻石花销记入当天日账（服务器日界归日）：面板「钻石日上限」>0 时，下一拍预算按此扣减。
  //   记的是估价（实际扣费由服务器决定），作为软上限足够；日账未读回前 bump 会被补算，不丢计。
  if (act.goldCost > 0 && Number(MCFG.goldDailyCap) > 0) {
    goldLedger.bump('goldSpent', Math.ceil(act.goldCost));
  }
  // 成功：登记在途令牌（逐令牌=已发送 tokens；全量=该域活跃令牌集 pendingTokens）。
  //   钻石/治疗线待其目标 state 退出权威读时由 prunePendingByExit 遗忘；道具线记应答确认时刻，
  //   经应答后一次权威队列读由 prunePendingConfirmed 放行（截断批下拍续发、不锁整域）。
  var confTs = ITEM_SPEED_KINDS.has(act.kind) ? Date.now() : null;
  if (act.all) markPending(act.fp, act.pendingTokens, confTs);
  else markPending(act.fp, tokens, confTs);
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
      await sleep(INTER_SEND_MS, ctxRef && ctxRef.signal); // pause 早醒，下方 aliveFn 闸门兜住不再出网
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
  var gate = { open: false, deadline: -1, closingSoon: false };
  if (!mode) {
    gate = csbGate();
    if (gate.open) {
      crossRet = await net.sendGuarded(
        CMD_GET_CROSS_HOSPITAL_QUEUES,
        {},
        {
          onError: function (err) {
            log.warn('cmd %d send threw: %s', CMD_GET_CROSS_HOSPITAL_QUEUES, err && err.message);
          },
        },
      );
    } else {
      crossSkipped = true;
    }
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
  var unitOf = unitResolver();
  var baseWait = baseWaitEntries(queues, unitOf);
  var baseRepair = baseRepairEntries(queues, serverTime, unitOf);
  var csbWait = csbWaitEntries(crossData, unitOf);
  var csbRepair = csbRepairEntries(crossData, serverTime, unitOf);
  var localRepairing = sumLeft(baseRepair);
  var crossRepairing = sumLeft(csbRepair);
  var avaData = avaRet && avaRet.ok ? parseData(avaRet.data) : null;
  var avaList = avaData && Array.isArray(avaData.list) ? avaData.list : null;
  // 6310 应答 OK 但 list 缺席/非数组（形态漂移或空医院省略键）：不 prune（宁不整清、避免误删在途令牌），无双层由 avaReadOk=false 自然静默；待下一次有效读回归时再观测离队。
  if (mode && avaRet && avaRet.ok && avaData && !Array.isArray(avaData.list)) {
    log.debug('ava 6310 ok but list absent/not-array (mode %s); skip prune this tick.', mode);
  }
  var ava = avaEntries(avaList, serverTime, unitOf);
  // 确认清除（无抑制时钟）：各场景按「目标 state 退出权威读」遗忘在途令牌——治疗族确认集=state0、加速族确认集=state1。
  //   本地：queues 为有效数组才 prune；跨服：1426 读 OK 且未门控跳过才 prune；无双：6310 list 为有效数组才 prune。
  if (Array.isArray(queues)) {
    prunePendingByExit('lw', tokenSet(baseWait));
    prunePendingByExit('lr', idSet(baseRepair));
    prunePendingConfirmed('lr', Date.now());
  }
  if (crossRet && crossRet.ok && !crossSkipped) {
    prunePendingByExit('cw', tokenSet(csbWait));
    prunePendingByExit('cr', idSet(csbRepair));
    prunePendingConfirmed('cr', Date.now());
  }
  if (avaList) {
    prunePendingByExit('aw', idSet(ava.wait));
    prunePendingByExit('ar', idSet(ava.repairing));
    prunePendingConfirmed('ar', Date.now());
  }
  // 钻石预算：面板「钻石日上限」为 0 时只受余额约束；>0 时按服务器日界的日账扣减（未读回前不发钻石动作）。
  var gold = goldBalance();
  var goldCap = Number(MCFG.goldDailyCap) || 0;
  var goldBudgetKnown = true;
  if (goldCap > 0) {
    goldLedger.ensureLoaded();
    if (goldLedger.loaded()) {
      gold = Math.min(gold, Math.max(0, goldCap - goldLedger.get('goldSpent')));
    } else {
      gold = 0;
      goldBudgetKnown = false;
    }
  }
  return {
    ok: true,
    serverTime: serverTime,
    quotas: quotas,
    baseWait: baseWait,
    baseRepair: baseRepair,
    csbWait: csbWait,
    csbRepair: csbRepair,
    csbSkipped: crossSkipped,
    csbDeadline: gate.deadline,
    csbClosingSoon: gate.closingSoon,
    localRepairing: localRepairing,
    crossRepairing: crossRepairing,
    repairing: localRepairing + crossRepairing + sumLeft(ava.repairing),
    gold: gold,
    goldCap: goldCap,
    goldBudgetKnown: goldBudgetKnown,
    ratePerMin: goldRatePerMin(),
    speedItem: hospitalSpeedItemInfo(),
    mcfg: MCFG,
    avaMode: mode,
    avaReadOk: !!avaList,
    avaWait: ava.wait,
    avaRepair: ava.repairing,
    avaGoldMult: mode ? avaGoldMultOf(mode) : 0,
    avaSpeedItem: mode ? avaSpeedItemInfo() : null,
  };
}

/**
 * 逐条发一组已规划动作（拍内 1s 节流、pause 即时中止）。
 * @param {Array<object>} actions planActions 的 actions 或加速二次 pass 的动作容器
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
    if (j < actions.length - 1) await sleep(INTER_SEND_MS, ctxRef && ctxRef.signal); // pause 早醒，下轮 execAction 前 aliveFn 闸门兜住
  }
  return out;
}

/**
 * 治疗落地后的「只重读在修态」轻量快照（纯本地、零网络）：本地流 220 成功已回灌权威队列，
 * 故此处 healQueues() 即时能看到刚开修的队列；跨服/无双在修秒和沿用本拍权威读（只能等下拍刷新）。
 * @param {object} snap 本轮权威读快照
 * @returns {object|null} 供二次决策的快照；本地队列读不到返回 null
 */
function speedSnapshotAfterHeal(snap) {
  var queues = healQueues();
  if (!queues) return null;
  var serverTime = gameData.serverTime ? gameData.serverTime() : 0;
  var unitOf = unitResolver();
  var baseRepair = baseRepairEntries(queues, serverTime, unitOf);
  var local = sumLeft(baseRepair);
  return Object.assign({}, snap, {
    serverTime: serverTime,
    // 与 localRepairing 同源同拍重算 state1 条目：刚治好转入 state1 的队列必须进入全量加速动作的
    //   pendingTokens，否则成功后 markPending 漏登记它们 → 下拍仍见其 state1 即第二枪（双花钻石/重烧道具）。
    baseRepair: baseRepair,
    localRepairing: local,
    repairing: local + (Number(snap.crossRepairing) || 0) + sumLeft(snap.avaRepair || []),
  });
}

/**
 * 一拍：快照 → 决策 → 逐条发包；治疗层有落地时同拍重读本地在修态补跑一次加速。
 * 二次决策复用 planActions（治疗动作按在途令牌自然 skipped），发包前只保留加速类动作。
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
  var speedActions = planActions(snap2).actions.filter(function (a) {
    return a.kind.indexOf('heal-') !== 0;
  });
  if (!speedActions.length) return first.sent;
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
  goldLedger.ensureLoaded(); // 预热日账，首拍即可按「钻石日上限」扣减（未读回前钻石分支静默一拍，安全优先）
  log.info(
    'started. base=%s;csb=%s;ava=%s;speed=%s/%s/%s/%s/%s;goldCap=%d;poll=%ds',
    JSON.stringify(MCFG.repairBase),
    JSON.stringify(MCFG.repairCsb),
    JSON.stringify(MCFG.repairAva),
    MCFG.speedBaseNormal,
    MCFG.speedBaseThor,
    MCFG.speedCsb,
    MCFG.speedAvaNormal,
    MCFG.speedAvaThor,
    MCFG.goldDailyCap,
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

/** @type {object} descriptor 默认配置（全场地所有加速默认不加速；基地/无双默认修普通兵） */
const DEFAULT_CFG = defaultConfig();

/**
 * 向 reactor 注册本功能说明书：战斗设置类，跟随战斗设置生效（不声明 offInCombat，战斗模式下照常修）。
 * kinds 覆盖本服 + 无双峡谷（AVA/TM/大师赛/传奇小队）+ 天梯三国 + 征服者 + 盟决，跨服战场图内持续自动修理；
 * 秘境（pab）由 world 门控隔离，不放行。places 限 base/world（医院 UI 所在场景）。
 * 面板按场地分三段：基地修理厂 / 战场抢修车间 / 无双修理厂——每段「维修矩阵（每格 select: 不维修/普通/道具/钻石）」；
 * 「加速预算」段为钻石日上限（0=不限）。
 * 存档版本 5：migrate 把 v4 数组+速度键合并为每格 mode 对象。
 */
reactor.register({
  id: 'quickRepair',
  label: '快速修理',
  storageKey: 'pocketcc.feat.quickRepair',
  symbols: ['dataCenter', 'gameTools', 'tableManager'],
  places: ['base', 'world'],
  kinds: ['homeland', 'wushuang', 'kvk', 'sphere', 'adp_war'],
  offInCombat: false,
  version: 5,
  migrate: migrateConfig,
  defaults: Object.assign({ enabled: false }, DEFAULT_CFG),
  fields: [
    {
      key: 'repairBase',
      label: '维修矩阵',
      section: '基地修理厂',
      type: 'matrixselect',
      codes: venueMatrixSelectField('base').codes,
      matrix: venueMatrixSelectField('base').matrix,
      hint: '每格选「不维修/普通维修/道具维修/钻石维修」。普通兵优先扣免费额度、超出扣材料；雷神兵直接扣材料。',
    },
    {
      key: 'repairCsb',
      label: '维修矩阵（仅雷神）',
      section: '战场抢修车间',
      type: 'matrixselect',
      codes: venueMatrixSelectField('csb').codes,
      matrix: venueMatrixSelectField('csb').matrix,
      hint: '跨服天梯赛战场医院，只收雷神。加速协议为全量，取各格最高档。',
    },
    {
      key: 'repairAva',
      label: '维修矩阵',
      section: '无双修理厂',
      type: 'matrixselect',
      codes: venueMatrixSelectField('ava').codes,
      matrix: venueMatrixSelectField('ava').matrix,
      hint: '无双四模式（AVA/TM/大师赛/传奇小队）。修理免费、不耗材料，只按档位排队。',
    },
    {
      key: 'goldDailyCap',
      label: '钻石日上限',
      section: '加速预算',
      type: 'number',
      min: 0,
      step: 100,
      zeroUnlimited: true,
      placeholder: '不限',
      hint: '所有场地钻石加速共享的当日花销上限；留空或 0 = 不限。按服务器日界每日归零。',
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
  migrateConfig,
  defaultConfig,
  venueOptions,
  venueMatrixSelectField,
  quickFields,
  isParamErrorRet,
  isHealBatchCmd,
  LOCAL_SYNC_KINDS,
  pickAvaMode,
  estimateAvaGold,
  speedItemNum,
  estimateGold,
  parseRepairCost,
  pickSpeedItem,
  itemSpeedParam,
  goldPlannedFor,
  planActions,
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
  prunePendingConfirmed,
  HEAL_LANES,
  ITEM_TYPE_HOSPITAL_SPEED,
  ORDER_TYPE_HEAL,
  CFG_GOLD_PER_MIN,
  CMD_ORDER_QUEUE_SPEED_UP,
};
// 领域模型直出（场地适配器与纯判据，供单测与对拍引用）
export {
  classifyUnit,
  tierOf,
  ARMS,
  TIERS,
  armOf,
  isThorTier,
  unitClassKey,
} from './model/classify.js';
export {
  classCodeOf,
  venueCodes,
  repairIncludes,
  cellMode,
  cellSpeedMode,
} from './model/schema.js';
export {
  baseWaitEntries,
  baseRepairEntries,
  csbWaitEntries,
  csbRepairEntries,
  avaEntries,
  sumLeft,
  isThorBand,
} from './model/entries.js';
export { KIND, ITEM_SPEED_KINDS } from './model/kinds.js';
export { csbDeadlineSec, csbOpen, csbClosingSoon } from './model/gates.js';
export { makeBudget, takeItem } from './venues/shared.js';
export { planBase } from './venues/base.js';
export { planCsb } from './venues/csb.js';
export { planAva } from './venues/ava.js';
