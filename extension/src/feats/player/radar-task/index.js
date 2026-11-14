/**
 * 雷达任务（radarTask）- 日常 feat：自动完成雷达盘任务——每日三连环（类一）+ 普通任务（类二）的「认领→执行→领奖」，同一时间只执行一个任务。
 *
 * 任务分类（实录报文实证）：
 *   类一 每日三连环 —— day_group_events（radar_group_type=3、day_group_id 非 0，录制实测 taskId 10002/10003/10004）：
 *     链式逐个解锁（打完一个领一个，push 20026 才下发下一个 state=0）；三连环各走一种执行形态（零部队援助行军 / 带兵单打 / 联盟集结）。
 *   类二 普通任务 —— events（radar_group_type=1）：
 *     10001 黑暗军团据点 —— 集结带兵（1201 marchType=8，time=60）；
 *     40001 玩家求援 —— extData.p 带被援玩家 uid，认领后 state=3 → 902 marchType=200 零部队；
 *     4178/4180/4181/10000/10022/10024/10031/10032/10034/10035 —— 即时/条件完成型，进场即 state=4，只需 3508 领奖。
 *   group_events（联盟组任务）与 act_radar_events（活动雷达）不在 v1 范围，不入账本；type=204/206/207/208/209（据点零部队/剪线/密码/搜怪/未知）
 *   属 v1 不做，跳过并首遇 warn（见 UNSUPPORTED_TYPES）。
 *
 * 状态机（任务 event.state，报文实证）：
 *   0 待认领 →(3505)→ 1 已认领（应答回填 x/y）→(派发行军)→ 2 进行中 →(部分类型经 3 需二次动作)→ 4 完成待领 →(3508)→ 移除/被新任务替换。
 *
 * 协议（全部老 send 通道，实录报文实证）：
 *   3504 RadarGetInfo —— req {clearFinishNotify:1}；resp 全量（events / day_group_events.day_group_events / group_events / act_radar_events
 *     + 标量 taskPoolSurplusNum/scaned/nexRefreshtTime/sign/radarLevel…）。
 *   3505 RadarStartTask —— req {id}（实例 id，Number）；resp 为该任务所在的 events|day_group_events|group_events 三选一数组（state 0→1、回填 x/y）。
 *   3508 RadarGetReward —— req {id}；resp 含 reward。串行 + 1.2s 间隔（NetMgr 频控吞连发，同联盟捐献教训）。
 *   3515 RadarDefend —— 一键击退黑暗军团的雷达干扰攻击：**req 空体 {}**（不带 id/坐标），resp 只有 {sign}。
 *     报文实证唯一一笔：00:26:53 最后一条 3508 领完 → 20021 `{sign:4, deBeginTime:1793896015}`
 *     （实测 40 条 20021 里唯一 deBeginTime 非 0）→ 4s 后 `3515 req {}` → `resp {sign:5}`（s=0）→ 紧接
 *     20021 `{sign:5, deBeginTime:0}`；该笔前后 ±15s 内无一条 10021 体力推送 → **击退不扣体力、不派兵**。
 *     游戏侧链路（源码实证）：`RadarMainPrefab` 见 `radarDefendStartTime` 非 0 就点亮防御入口 → `RadarDefPop`
 *     显示 `PLAYER_LEVEL[等级].att_new` 为门槛、战力不足则按钮置灰 → `radarDefCallBack()` 发这一笔空体。
 *   902 MARCH_WORLD_POINT —— 带兵单打 marchType=62（RADAR_MARCH_MONSTER）走 march.attack canonical body；
 *     零部队型八键 {marchType,x,y,armyList:[],armyListNew:[],heroList:[],trapList:[],formation:0}
 *     （marchType=64 宝藏 / 67 援助点 / 200 玩家求援；报文实证键集即此，与 march.pickUp 的九键 ext 形态不同，feat 直发）。
 *   1201 ALLIANCE_Assembly_Create —— 集结带兵 {marchType:8,x,y,time:60,armyList,armyListNew,heroList,trapList,formation:0,formationV2}
 *     （逐键同惧星据点集结实录）。
 *   推送（两类形态，不可只认数组！）：20013 状态变化 / 20025 环变化的载荷**本身就是单条任务事件**（顶层
 *     {id,taskId,state,x,y,day_group_id,…}，无 events 包装）；20015 新增任务 / 20026 每日链推进则携 events 数组。
 *     实录报文实证：前者 50 条（state=4 有 32 条、state=2 有 18 条）无一例外是裸事件，
 *     30 个不同 id 里 29 个与 3504 账本同键 —— 「任务已完成待领」这个真相几乎只从 20013/20025 下发，
 *     读成数组会全部静丢弃（已踩过：账本永停 state=1 → 不领奖 + 反复 902 被拒 code=3 死循环）；
 *     20016 杂项 / 20021 sign（仅标量刷新；**deBeginTime 在这两条与 3504 全量三处都带**，>0 即攻击进行中）。
 *   10021 PUSH_ENERGY —— 体力池（EnergyType.Action=gameData.energy(1)）变更；报文实证：只有 902/1201 那一下扣体力
 *     （reason=RADAR_MONSTER/ALLIANCE_RALLY_BATTLE 各 8、RADAR_ASSIST 跌幅观测 {4,5} 取上界 5、RADAR_RESCUE 亦有扣减），
 *     3505 认领与 3508 领奖全场无一条体力跟随（两份录制派兵与体力推送 1:1：18+3=21 条）；推送紧跟出兵 36~66ms，
 *     而 readonly 后最近一条推送至少隔 740ms（rec2 899ms）——体力闸对拍维度据此用 300ms 窄窗。
 *
 * type 反查口径（遵循本仓「游戏本地表反查而非硬编码」ADR）：**radar_event 表按「事件实例 id」索引，不是 taskId**——
 *   `l10n.tableRow('radar_event', 实例 id).type/quality`。三处独立实证同一口径：游戏 `RadarTaskPrefab.initData`
 *   （`getTableDataById(TableName.radar_event, String(this._eventId))`，_eventId 即 3505 req 里那个 id）、
 *   游戏 `RadarController.askBeginTask`（认领应答回环里同样是拿事件 id 查表）、竞品 B `server-js.js:19868`
 *   （`getTableDataById(TableName.radar_event, e["id"])`）。taskId 是**另一张表 radar_task** 的键（name/des/cost_energy/condition_num，任务内容），
 *   拿 taskId 查 radar_event 会命中「同号不同物」的槽位行：本 feat 首版就这么错查过，黑暗军团据点（taskId=10001，实例 id 1099006/7/8）
 *   被读成 type=205 而发出零部队援助 902 → 服务器 code=3 连拒（真机日志实证）。
 *   type 分派（游戏表列出的全集 + 实录报文实证）：201 带兵单打(state1) / 202 集结带兵(state1) / 203 零部队宝藏(state1,marchType64)
 *   / 204 零部队据点(state1,marchType65 RADAR_MARCH_COUNTRY) / 205 零部队援助(state1,marchType67) / 206 剪线小游戏
 *   / 207 密码验证小游戏 / 208 搜怪带兵(state3) / 209 仅倒计时规则引用 / 211 零部队求援(state3,marchType200)。
 *   v1 只发 201/202/203/205/211；204/206/207/208/209 归 unsupported（首遇 warn + 当日 latch，绝不猜 body）。
 *   读数面整体不可用（`l10n.tableReady()` 为假，游戏 bundle 未就绪的早期窗口）才回退录制经验表 TASK_TYPES；
 *   表可读而该槽位无行（活动雷达/新池）→ 视为未知，不发包（宁可不做的代价低于发错包）。
 *
 * 闸门与纪律：
 *   单飞 —— exec 锁只锁「执行」（902/1201）；随账本 state 跃迁释放（进 4 / 条目消失 / 回滚到 0/1），不轮询 marchId 确认。
 *     认领（3505）不占行军槽、不扣体力、不置锁，**exec 在途期间照旧逐拍推进**（真机实录：
 *     一条集结占锁的 11 分钟里 9 条 state=0 任务 0 笔 3505，就是被 exec 早返回吞掉的）。
 *   拒因退避 —— 三态发送结果区分「服务器拒」与「本端未发出」；同一实例同一动作连续被拒 rejectRetryLimit(2) 次
 *     即当日拉黑该实例（不再重试，但照常领奖）并立即 3504 重拍——因为「拒」最常见的成因就是本地账本陈旧。
 *   停滞止损 —— 与「被拒」并列的另一类死循环：**s=0 受理、却没做成**（集结窗 60s 到期被服务器原地解散、
 *     任务态 2→1 回滚）。这类走不到拉黑计数，故按 dispatch 收尾单独记账：rollback 达 dispatchStallLimit(2) 次
 *     即当日让位该实例（仍照常领奖），并用停滞次数作 candCmp 首键降权，杜绝 day_group_id 恒最大者霸占首位。
 *     沉降窗 dispatchSettleMs(10s) 内不判（engage 推送实测 <100ms，防与推送赛跑而假计）。
 *     真机实录：同一条 3147 在 639s 内被重派 4 次、行军态序列恒为 8→4（从未 1/3），而 0 笔认领/领奖。
 *   在途择时 —— 首次对拍按集结窗到期 execPollMs(90s) 即醒（窗一过就能发现解散并换候选），确认仍在途才降到
 *     execResyncMs(4min) 低频档；取代原先固定 240s 的「解散了也要再等 4 分钟才看见」。
 *   体力 —— 面板「体力下限」闸门：体力低于下限即暂停执行（认领+出兵一起停），领奖不受限（不扣体力）；
 *     镜像读不到则本轮不动（active 档重判）；阻塞时下拍精准睡到 nextRecoverSec 回点（自然回体不一定推 10021，不能只靠推送）；
 *     配 0 也强制至少 1 点，保证「体力耗尽必停」这一用户口径不被面板误关。
 *   派兵 —— 战斗预设单选 1~8（0=不派兵）；Battle().plan().preset().adjust().build() 出兵，无兵或 freeSlots≤0 本轮不派、等唤醒。
 *   领奖 —— 与执行解耦：任何 state=4 任务（含未知/即时型）直接 3508，不需要 type。
 *   防御 —— 面板「雷达防御」开关：`deBeginTime>0` 且 `sign<5` 且战力达 PLAYER_LEVEL 门槛时发一笔 3515，打完功率直接
 *     满格 → 下一次截取必为 5 星（字典 radar_help_4017/4022），干扰攻击每日至多 1 次。幂等键 = **触发时刻 deBeginTime
 *     本身**（落 storage.data，扩展重载不重发；deBeginTime 被推回 0 即服务器已清理该次攻击，自然停手，故不本地估窗——
 *     估窗要引配置 4000034 与服务时钟差，收益不抵风险）。战力读不到/门槛行缺失一律不发（fail-closed，宁可不做的代价
 *     低于反复撞服务器日限）。
 *   日志 —— 业务拒绝（code≠0）走 info；CODE_NOT_SENT/应答畸形走 debug/warn；每轮出口一条决策 debug（reason 归因静默）。
 *
 * 生命周期由 reactor 托管：places base/world、kinds homeland、offInCombat（自动派兵抢队列类）。
 * 触发源（run 点火 / 雷达推送 / 10021 体力回升 / 配置变更 / 兜底定时）全部汇入 cycle.kick，在飞合并为一次补扫。
 * 配置链路：registry 把 {enabled, ...toModuleCfg(c)} 推给 reactor.setConfig → configure（整体赋值、绝不二次归一）。
 */
import { parseData, CODE_NOT_SENT, sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { bus, EVT } from '../../../core/bus.js';
import { storage } from '../../../core/storage.js';
import { l10n, gameData } from '../../../core/game-api.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';
import { createCycle } from '../../../core/cycle.js';

import {
  CMD_GET_INFO,
  CMD_START_TASK,
  CMD_GET_REWARD,
  CMD_MARCH_POINT,
  CMD_CREATE_RALLY,
  CMD_DEFEND,
  PUSH_STATUS_CHANGE,
  PUSH_ADD_ONE_TASK,
  PUSH_OTHER_DATA,
  PUSH_SIGN,
  PUSH_RING_CHANGE,
  PUSH_DAYGROUP_CHANGE,
  PUSH_ENERGY,
} from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=RADAR） */
const log = createLog('RADAR');

/** @type {number} 信号功率满格值（radar_help_4017：满格后下一次截取必为 5 星，随即衰减回 1） */
const SIGN_MAX = 5;

/** @type {number} 体力池编码（EnergyType.Action，即 UserData.getEnergy(1)；雷达出兵烧这一池） */
const STAMINA_TYPE = 1;

/**
 * @type {number} 行军类型：雷达野怪单打（NMarchType.RADAR_MARCH_MONSTER=62，带兵）
 */
const MT_MONSTER = 62;
/** @type {number} 行军类型：雷达宝藏零部队行军（NMarchType.RADAR_MARCH_TREASURE=64） */
const MT_TREASURE = 64;
/** @type {number} 行军类型：雷达援助点零部队行军（NMarchType.RADAR_ASSIST_TASK=67） */
const MT_ASSIST = 67;
/** @type {number} 行军类型：玩家求援零部队行军（NMarchType.RADAR_HELP=200） */
const MT_HELP = 200;
/** @type {number} 行军类型：创建集结主行军（NMarchType.ALLIANCE_RALLY_BATTLE=8） */
const MT_RALLY = 8;
/** @type {number} 1201 集结等待时长（秒，报文实证固定 60） */
const RALLY_WAIT_TIME = 60;

/**
 * @typedef {object} RadarAction 任务一步动作描述
 * @property {string} act start|zero|attack|rally|unsupported
 * @property {number} [marchType] 902 行军类型（zero/attack 用）
 * @property {boolean} [needsTroops] 是否派兵动作（受 doMarch/preset/freeSlots 闸门）
 */

/**
 * radar_event 表 type → 动作映射（state = 该动作生效所需的任务态；游戏 `RadarController.beginMarch` 的 type→marchType 分派 + 实录报文实证）。
 * @type {Object<number,{fromState:number,action:RadarAction}>}
 */
const TYPE_ACTIONS = {
  201: { fromState: 1, action: { act: 'attack', marchType: MT_MONSTER, needsTroops: true } },
  202: { fromState: 1, action: { act: 'rally', needsTroops: true } },
  203: { fromState: 1, action: { act: 'zero', marchType: MT_TREASURE } },
  205: { fromState: 1, action: { act: 'zero', marchType: MT_ASSIST } },
  208: { fromState: 3, action: { act: 'unsupported' } }, // v1 不做：需 906 搜怪再打，实录无实证
  211: { fromState: 3, action: { act: 'zero', marchType: MT_HELP } },
};

/**
 * 游戏侧确实存在、但 v1 明确不动作的 type（宁可跳过也不猜包）：
 *   204 零部队据点（beginMarch 发 marchType=65 RADAR_MARCH_COUNTRY，实录零样本）、
 *   206 剪线小游戏（WireCutPanel）、207 密码验证小游戏（CodeCheckPanel）、209 仅倒计时规则引用。
 * @type {ReadonlySet<number>}
 */
const UNSUPPORTED_TYPES = new Set([204, 206, 207, 209]);

/**
 * 录制实证经验表（**仅在 radar_event 读数面整体不可用时**按 taskId 兜底，实录报文实证）：
 * 10001 黑暗军团据点=集结、10002 三连环集结位=集结、10003 三连环援助位=零部队援助、10004 三连环扫荡位=带兵单打、40001 求援=零部队求援。
 * ⚠ 这只是「该录制里这些内容恰好落在这些槽位」的快照，**不是 taskId→动作的权威映射**（权威口径见文件头：radar_event 按实例 id 索引）；
 *   表可读时绝不走这张表，否则会重演「据点被当成援助点发零部队 902 吃 code=3」。
 * @type {Object<number,number>}
 */
const TASK_TYPES = { 10001: 202, 10002: 202, 10003: 205, 10004: 201, 40001: 211 };

/** @type {number} 任务态：完成待领 */
const ST_FINISH = 4;
/** @type {number} 任务态：行军中（exec 锁保持） */
const ST_RUNNING = 2;
/** @type {number} 任务态：需二次动作（仅 211/208 出现；exec 锁保持） */
const ST_SECONDARY = 3;

/**
 * 发送结果三态（调用侧要靠它区分「该退避」与「不该退避」：本端没发出去不能计入拒绝次数）。
 * @type {number} 服务器受理
 */
const SEND_OK = 2;
/** @type {number} 服务器业务拒（code≠0 且非本端哨兵）：可重试，但必须退避/拉黑 */
const SEND_REJECTED = 1;
/** @type {number} 本端未发出（同号在途闸 / 桥断 / encode 失败）：不算服务器拒绝 */
const SEND_NOT_SENT = 0;

/**
 * 内置调优常量（面板不暴露；两档兜底同惧星惯例）。
 * @type {object}
 */
const cfg = {
  /** 有可推进任务/领奖未完时的兜底扫描间隔（毫秒）：15 秒 */
  activeScanMs: 1000 * 15,
  /** exec 在途（等行军回推）时的对拍间隔（毫秒）：4 分钟（正常靠 20013/20026 推送唤醒） */
  execResyncMs: 1000 * 60 * 4,
  /** 无事可做时的低频对拍（毫秒）：5 分钟（重拉 3504 防漏推） */
  idleResyncMs: 1000 * 60 * 5,
  /** 推送唤醒合并窗（毫秒） */
  pushScanMinGap: 1000 * 4,
  /** 单拍领奖封顶（条），剩余下拍继续（防一拍霸占网络通道过久） */
  claimMaxPerPass: 10,
  /**
   * 同一实例同一动作连续被服务器拒绝达此数即当日拉黑：留一次自然重试容忍真瞬时错，
   * 但不允许「15s/拍 × 整夜」的死循环（实证：一场里同一条 id=3145 被拒 12 次且把其余 10 个候选饿死）。
   * @type {number}
   */
  rejectRetryLimit: 2,
  /**
   * dispatch（902/1201）受理到「允许判定停滞」的最小沉降窗（毫秒）：派兵那一刻账本还是 state=1，
   * engage 推送（state→2）实测紧跟应答 <100ms；窗内一律不放锁、不判停滞，纯防与推送赛跑而假计。
   * @type {number}
   */
  dispatchSettleMs: 1000 * 10,
  /**
   * 首次对拍的等待上限（毫秒）= 集结窗 + 缓冲：窗到期即醒，才能在集结被解散那一刻立刻换候选，
   * 而不是让「服务器 60s 就解散了」再被 execResyncMs 压后 4 分钟
   * （实录报文实证：4 笔重派同一条集结的间隔是 73.6/300.1/300.1s）。
   * @type {number}
   */
  execPollMs: 1000 * (RALLY_WAIT_TIME + 30),
  /**
   * 同一实例「被受理却没做成」连续达此数即当日让位（不再 dispatch，仍照常领奖）。
   * 与 rejectRetryLimit 分列：那条只统计服务器拒（s≠0），这一条统计 **s=0 受理、集结窗到期却被原地解散、
   * 任务态回滚到已认领** 的死循环——这种每一次都被受理，走不到拉黑逻辑（真机实录一场 4 笔）。
   * @type {number}
   */
  dispatchStallLimit: 2,
  /** 3508 串行间隔（毫秒，NetMgr 按 cmd 频控教训） */
  claimGapMs: 1200,
  /** 体力阻塞时睡到回点后多加的缓冲（毫秒）：等 UserData 镜像落定 */
  energyWakeBufferMs: 3000,
  /** 体力回点唤醒的下限（毫秒）：nextRecoverSec 报 0/异常时不留行紧循环 */
  energyWakeMinMs: 1000 * 5,
  /** 体力回点唤醒的上限（毫秒）：异常超大 nextRecoverSec 也至少一小时重判一次 */
  energyWakeMaxMs: 1000 * 60 * 60,
  /**
   * 面板「体力下限」的上界钳：实测体力池上限 pointMax=275，配个比它大的值等于本 feat 永久停在体力闸上；
   * 正常用途 ≤10 就够（最贵一档单价 8），100 已是极端值，再大当配错处理。
   * @type {number}
   */
  minStaminaCap: 100,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {object} 模块配置（configure 灌入）：{doDaily,doEvents,doMarch,doDefend:boolean,preset:number,minStamina:number} */
var MCFG = normalize({});

/**
 * 任务账本：实例 id（字符串化）→ {id,taskId,state,x,y,dayGroupId,groupType,endTime}。
 * 真相源=3504 应答与 20013/20015/20025/20026 推送；本 feat 只读+发包，不改写游戏对象。
 * @type {Map<string,object>}
 */
var tasks = new Map();
/**
 * @type {{taskPoolSurplusNum:number,scaned:number,nexRefreshtTime:number,sign:number,deBeginTime:number}} 标量缓存
 *   （deBeginTime=本次干扰攻击的起始秒时刻，0=无攻击；3504/20016/20021 三源都会刷它）
 */
var scalars = { taskPoolSurplusNum: 0, scaned: 0, nexRefreshtTime: 0, sign: 0, deBeginTime: 0 };
/** @type {boolean} 是否已完成首拍 3504 全量同步 */
var synced = false;
/**
 * 单飞锁（用户口径：一次只能执行一个任务）。key=实例 id 串；since=置锁墙钟（永不重置，停滞判定按它算龄）；
 * engaged=服务器是否已确认该次 dispatch 成型（见过 state∈{2,3}）；resynced/resyncAt=首次对拍标记与时刻
 * （对拍档由它分两级：窗内到期用 execPollMs，确认仍在途后降到 execResyncMs）。
 * @type {{key:string,taskId:number,type:number,since:number,engaged:boolean,resynced:boolean,resyncAt:number}|null}
 */
var exec = null;
/** @type {number} 上次推送唤醒的墙钟时刻（毫秒） */
var lastPushWakeAt = 0;
/**
 * 上次看到的体力点数（10021 方向过滤用）：出兵自己会扣体并推一条 10021，
 * 若不加方向判据就变成「动一下→被推→再踢一轮」的自激；null=本场还没见过推送。
 * @type {number|null}
 */
var lastEnergyPoint = null;
/** @type {boolean} 体力镜像「读不通」本场只 warn 一次的 latch（run() 复位） */
var staminaWarned = false;
/**
 * 本次体力阻塞是否已收过一轮 pending（限制「短拍一次」只放行一次）：
 * 不加这道闸，持续高频推送会把体力长睡退化成 1s 空拍循环（虽然零发包，但日志与唤醒节奏会乱）。
 * @type {boolean}
 */
var staminaPendingDrained = false;

/**
 * 当日记账（落 storage.data，跨日归零）：claimed=今日成功领奖次数。
 * 没有每日上限语义（feat 内不存在任何按日封顶的逻辑），只作面板只读计数。
 * @type {{day:string,claimed:number,loaded:boolean}}
 */
var day = { day: '', claimed: 0, loaded: false };
/** @type {Set<string>} 当日 latch：未知/不支持 type 的 taskId 已告警集合（防刷屏，跨日清） */
var skipLatch = new Set();
/**
 * @type {Map<string,number>} 「实例 id|动作」连续被服务器拒的计数（达 rejectRetryLimit 转拉黑）
 */
var rejectCount = new Map();
/**
 * @type {Set<string>} 当日拉黑的实例 id：除防逐拍重发刷屏，更防它按 candCmp 恒排最前把其余候选饿死；跨日清
 */
var rejectBlacklist = new Set();
/**
 * @type {Map<string,number>} 同一实例「dispatch 被受理却没做成」（账本回滚到可派态、从未进 state=4）的连续次数
 *   （达 dispatchStallLimit 转当日让位）
 */
var stallCount = new Map();
/**
 * @type {Set<string>} 当日因连续停滞而让位的实例 id：与 rejectBlacklist 同档（只挡 dispatch，不挡领奖），跨日清
 */
var stallYield = new Set();
/**
 * 已处理完毕（受理成功，或该次触发连续被拒达阈而锁死）的干扰攻击触发时刻 deBeginTime；落盘跨重载不重发。0=无。
 * 幂等键用触发时刻而不是日期串：雷达自清理后若当日再触发一次（字典说至多 1 次，但这是软口径），新时刻会自然重新放行。
 * @type {number}
 */
var defendHandledKey = 0;
/** @type {number} 当前触发键连续被服务器拒的次数（达 rejectRetryLimit 即锁死该次触发） */
var defendRejects = 0;
/** @type {string} 本轮防御归因（供统一 debug 行单轨还原「为何没击退」） */
var lastDefend = '-';

/**
 * 功能是否仍在运行（在飞流程存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 本地日界串（yyyy-mm-dd），ensureDay 与 latch 键共用。
 * @returns {string}
 */
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/**
 * 跨日归零：day 变了即清计数与 latch（内存先行，落盘异步）。
 */
function ensureDay() {
  var t = todayStr();
  if (day.day === t) return;
  day.day = t;
  day.claimed = 0;
  skipLatch.clear();
  rejectBlacklist.clear();
  rejectCount.clear();
  stallCount.clear();
  stallYield.clear();
  persistStats();
}

/** 异步落盘当日记账（不阻塞决策；失败 warn 容错，循环不停摆）。defendKey 一并落盘，跨扩展重载不重发同一笔击退。 */
function persistStats() {
  storage.data
    .set('radarTask.stats', { day: day.day, claimed: day.claimed, defendKey: defendHandledKey })
    .catch(function (e) {
      log.warn('persist stats failed. %s', e && e.message);
    });
}

/**
 * 读盘恢复当日记账（run 起点异步一次；盘值日界与本地一致才采用）。永不 reject。
 * @returns {Promise<void>}
 */
async function loadStats() {
  try {
    var saved = await storage.data.get('radarTask.stats');
    if (saved && saved.day === todayStr()) {
      day.day = saved.day;
      day.claimed = Number(saved.claimed) | 0;
      defendHandledKey = Number(saved.defendKey) > 0 ? Math.floor(Number(saved.defendKey)) : 0;
    } else {
      ensureDay();
    }
    day.loaded = true;
  } catch (e) {
    log.warn('load stats failed. %s', e && e.message);
    ensureDay();
    day.loaded = true;
  }
}

/** 推一次面板刷新（刷新「今日已领」只读格）。 */
function pokePanel() {
  bus.emit(EVT.UI_REFRESH);
}

// ── 配置归一 ────────────────────────────────────────────────────────
/**
 * 面板原始配置 → 归一化运行时配置（toModuleCfg 产出；configure 只整体赋值、绝不二次归一）。
 * 四个开关缺省视为 true（defaults 即 true，旧存档缺键不误关）；preset 取整钳 [0,8]，0=不派兵；
 *   minStamina 取整钳非负并钳上界 minStaminaCap（面板可填 0，体力闸内部再抬到至少 1 点）。
 * @param {object} raw 面板 configs 快照
 * @returns {object} { doDaily, doEvents, doMarch, doDefend, preset, minStamina }
 */
function normalize(raw) {
  raw = raw || {};
  var preset = Number(raw.preset) | 0;
  if (!(preset >= 1 && preset <= 8)) preset = 0;
  var minStamina = Number(raw.minStamina) | 0;
  if (!(minStamina > 0)) minStamina = 0;
  // 上界钳：number 渲染器不吃 fd.max（core/ui/fields.js renderNumber 只吐 min/step），故只能在归一里钳
  else if (minStamina > cfg.minStaminaCap) minStamina = cfg.minStaminaCap;
  return {
    doDaily: raw.doDaily !== false,
    doEvents: raw.doEvents !== false,
    doMarch: raw.doMarch !== false,
    doDefend: raw.doDefend !== false,
    preset: preset,
    minStamina: minStamina,
  };
}

// ── 账本同步 ────────────────────────────────────────────────────────
/**
 * 单事件入账本（纯函数口径：只 upsert 报文带来的字段，state 缺省不动）。
 * @param {Map<string,object>} map 账本
 * @param {object} e 任务事件（{id,taskId,state,x,y,day_group_id,radar_group_type,endTime}）
 */
function applyEventTo(map, e) {
  if (!e || e.id == null || e.taskId == null) return;
  var key = String(e.id);
  var cur = map.get(key);
  if (!cur) {
    cur = {
      id: key,
      taskId: Number(e.taskId) | 0,
      state: -1,
      x: 0,
      y: 0,
      dayGroupId: 0,
      groupType: 0,
      endTime: 0,
    };
    map.set(key, cur);
  }
  if (e.state != null) cur.state = Number(e.state) | 0;
  if (e.x != null) cur.x = Number(e.x) | 0;
  if (e.y != null) cur.y = Number(e.y) | 0;
  if (e.day_group_id != null) cur.dayGroupId = Number(e.day_group_id) | 0;
  if (e.radar_group_type != null) cur.groupType = Number(e.radar_group_type) | 0;
  if (e.endTime != null) cur.endTime = Number(e.endTime) | 0;
}

/**
 * 事件数组批量入账本。
 * @param {Array<object>} arr
 */
function applyEvents(arr) {
  if (!Array.isArray(arr)) return;
  for (var i = 0; i < arr.length; i++) applyEventTo(tasks, arr[i]);
}

/**
 * 标量刷新（taskPoolSurplusNum/scaned/nexRefreshtTime/sign，出现才覆盖；deBeginTime 走独立归一）。
 * @param {object} d 载荷
 */
function applyScalars(d) {
  if (!d) return;
  for (var k of ['taskPoolSurplusNum', 'scaned', 'nexRefreshtTime', 'sign']) {
    if (d[k] != null) scalars[k] = Number(d[k]) | 0;
  }
  if (d.deBeginTime != null) scalars.deBeginTime = normalizeDeBeginTime(d.deBeginTime);
}

/**
 * 干扰攻击触发时刻归一（纯函数，单测与对拍共用）：非正/非有限 → 0（=无攻击）。
 * 刻意不走上面那档 `|0`：deBeginTime 是秒级 epoch（实证 1793896015，距 Int32 上界只剩 ~35 年），
 * 而时间戳一旦截断就变成「永远不触发」的静默失效（本仓踩过 ToInt32 截断坑）。
 * @param {*} v 载荷里的 deBeginTime 原值（数字或数字串）
 * @returns {number} 秒级触发时刻；0=未触发/已结束
 */
function normalizeDeBeginTime(v) {
  var n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 全量/增量载荷通用摊平：events + day_group_events（嵌套两层兼容）+ 标量。
 * group_events / act_radar_events 为 v1 范围外，不摊入账本。
 * @param {object} d 3504 应答 / 3505 应答 / 推送载荷
 */
function applyPayload(d) {
  if (!d) return;
  applyEvents(d.events);
  var dg = d.day_group_events;
  if (dg) applyEvents(Array.isArray(dg) ? dg : dg.day_group_events || []);
  applyScalars(d);
}

/**
 * 单条任务事件形态判定。
 * 报文实证：20013 状态变化 / 20025 环变化的载荷**本身**就是一条任务事件，
 * 顶层直接是 {id,taskId,state,x,y,day_group_id,…}，不套 events/day_group_events 数组；
 * 实测 50 条此类推送里 state=4（完成待领）有 32 条、state=2（行军中）有 18 条，
 * 且 30 个不同 id 里 29 个与 3504 账本同键 —— 即「任务完成」的真相几乎只走这两条通道。
 * 判据保守：必须同时带 id 与 taskId，且不是已摊好数组的集合载荷（那条优先走 applyPayload）。
 * @param {object} d 推送/应答载荷
 * @returns {boolean} 是否单条任务事件
 */
function isTaskEvent(d) {
  return (
    !!d &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    d.id != null &&
    d.taskId != null &&
    d.events == null &&
    d.day_group_events == null
  );
}

/**
 * 推送统一入账：裸事件（20013/20025）单条 upsert，其余走数组摊平（20015/20026/3504/20016）。
 * @param {object} d 推送载荷
 * @returns {boolean} 是否落了任务事件（仅刷标量的载荷返回 false，供调用侧日志与对拍）
 */
function applyPushPayload(d) {
  if (!d) return false;
  if (isTaskEvent(d)) {
    applyEventTo(tasks, d);
    return true;
  }
  applyPayload(d);
  return false;
}

/**
 * 拉一次 3504 全量对拍（只读，永不 reject）。
 * @returns {Promise<boolean>} 是否同步成功
 */
async function fetchInfo() {
  if (!net) return false;
  var ret = await net.sendGuarded(
    CMD_GET_INFO,
    { clearFinishNotify: 1 },
    {
      onError: function (err) {
        log.warn('3504 fetch threw. %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) {
    if (ret && ret.code !== CODE_NOT_SENT) log.info('3504 rejected. code=%s', ret.code);
    return false;
  }
  applyPayload(parseData(ret.data));
  synced = true;
  return true;
}

// ── 类型解析与动作决策（纯函数，供单测） ────────────────────────────
/**
 * 账本条目 → radar_event 表行（type/quality）。
 * 查表键 = **事件实例 id**（不是 taskId）：游戏 `RadarTaskPrefab.initData`/`RadarController.askBeginTask` 与竞品 B
 *   `server-js.js:19868` 三处一致都用 `e.id`；taskId 是另一张表 radar_task 的键，混用会命中同号不同物的槽位行（实证过：错查出 code=3）。
 * 兜底纪律：只有「读数面整体不可用」（tableReady=false，游戏 bundle 未就绪）才按 taskId 走录制经验表；
 *   表可读但该槽位无行 → type=0（未知），调用侧不发包。
 * @param {{id:string|number,taskId:number}} evt 账本条目（只需 id 与 taskId 两键）
 * @param {(table:string,id:*)=>object|null} tableRow 注入的查表函数（单测桩；生产传 l10n.tableRow 包装）
 * @param {boolean=} tableReady 配置表读数面是否就绪（生产传 l10n.tableReady()；缺省视为就绪，即不自动兜底）
 * @returns {{type:number,quality:number}} type=0 表示未知
 */
function resolveType(evt, tableRow, tableReady) {
  var id = evt ? evt.id : null;
  var taskId = evt ? evt.taskId : 0;
  var row;
  try {
    row = tableRow && id != null ? tableRow('radar_event', id) : null;
  } catch (e) {
    row = null;
  }
  if (row && (Number(row.type) | 0) > 0) {
    return { type: Number(row.type) | 0, quality: Number(row.quality) | 0 };
  }
  if (tableReady === false) {
    var t = TASK_TYPES[taskId] || 0;
    return { type: t, quality: 0 };
  }
  return { type: 0, quality: 0 };
}

/**
 * 任务当前态 → 一步动作（纯决策，不含闸门）。state=4 不在此处理（领奖与类型无关，走 claimable）。
 * @param {{state:number,taskId:number}} t 账本条目
 * @param {number} type resolveType 的 type
 * @returns {RadarAction|null} null=本拍无可做（含未知 type与状态不匹配）
 */
function actionFor(t, type) {
  if (t.state === 0) return { act: 'start' };
  var def = TYPE_ACTIONS[type];
  if (def) {
    if (def.fromState !== t.state) return null;
    return def.action;
  }
  // 已知但 v1 不做（204/206/207/209 与 208 的非 fromState）：归 unsupported，仅 warn 一次、绝不猜 body
  if (UNSUPPORTED_TYPES.has(type)) return { act: 'unsupported' };
  return null;
}

/**
 * 候选排序比较器：**停滞次数升序（派出去却没做成的往后靠）**→ day_group_id 降序（三连环优先）→
 * quality 降序（对齐竞品）→ id 升序（确定性）。
 * 首键专为钉住本次实证：day_group_id 恒最大的那条「集结反复被解散」会永久霸占首位、
 * 把其余 9 条饿死一整夜（实录报文实证）。调用方不带 stalls 字段（领奖排序/单测）等价于 0，口径不变。
 * @param {{dayGroupId:number,quality:number,id:string,stalls:(number|undefined)}} a
 * @param {{dayGroupId:number,quality:number,id:string,stalls:(number|undefined)}} b
 * @returns {number}
 */
function candCmp(a, b) {
  return (
    (a.stalls | 0) - (b.stalls | 0) ||
    b.dayGroupId - a.dayGroupId ||
    b.quality - a.quality ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * 挑选下一个可执行任务（纯决策，闸门以参数注入，单测可直驱）。
 * @param {Iterable<object>} all 账本全量
 * @param {object} mcfg 归一化配置 {doDaily,doEvents,doMarch,preset}
 * @param {(evt:object)=>{type:number,quality:number}} resolve 类型解析（注入，查表键为实例 id）
 * @param {string|null} execKey 当前单飞锁持有者实例 id
 * @param {Set<string>=} blacklist 当日「不再 dispatch」集合（服务器连续拒 + 受理但连续停滞两类让位实例合并而来）
 * @param {{onlyStart:boolean=,stalls:Object<string,number>=}=} opts 附加口径：onlyStart=exec 在途时只放行认领；
 *   stalls=实例停滞次数（作 candCmp 首键降权，让刚解散的那条不再顶在最前）
 * @returns {{pick:object|null, gated:boolean, unknown:boolean, unsupported:object[], blacklisted:number}} pick=选中候选；gated=存在被闸门挡住的候选；unknown=本拍首遇未知类型；unsupported=v1 不支持（208）的候选条目（供调用侧 latch 告警）；blacklisted=因拉黑而跳过数
 */
function pickCandidate(all, mcfg, resolve, execKey, blacklist, opts) {
  var out = { pick: null, gated: false, unknown: false, unsupported: [], blacklisted: 0 };
  var arr = [];
  for (var t of all) {
    if (t.state !== 0 && t.state !== 1 && t.state !== 3) continue;
    if (execKey && t.id === execKey) continue;
    if (blacklist && blacklist.has(t.id)) {
      out.blacklisted++; // 当日拉黑：不重试也不计入 gated，否则会误归因 no-preset
      continue;
    }
    if (t.dayGroupId > 0 ? !mcfg.doDaily : !mcfg.doEvents) continue;
    var info = resolve(t);
    if (info.type === 0) {
      out.unknown = true;
      continue;
    }
    var act = actionFor(t, info.type);
    if (!act) continue;
    if (opts && opts.onlyStart && act.act !== 'start') continue; // 在途只放行认领，占兵型不参评也不计 gated
    if (act.act === 'unsupported') {
      out.unsupported.push(t); // 208：v1 不做，交调用侧当日 latch 告警
      continue;
    }
    if (act.needsTroops) {
      if (!mcfg.doMarch) continue;
      if (!mcfg.preset) {
        out.gated = true; // 想动但没配预设 → no-preset 归因
        continue;
      }
    }
    arr.push({
      task: t,
      type: info.type,
      quality: info.quality,
      act: act,
      id: t.id,
      dayGroupId: t.dayGroupId,
      stalls: (opts && opts.stalls && opts.stalls[t.id] | 0) || 0,
    });
  }
  arr.sort(candCmp);
  if (arr.length) out.pick = arr[0];
  return out;
}

/**
 * 体力闸判定（纯决策，供单测直驱）。仅管「起新任务」（认领+出兵）；领奖不扣体力、不走本闸。
 * 报文实证：3505/3508 不扣体力，902/1201 才扣（实测 5~8 点/次）。
 * @param {number|null} point 体力镜像读数（gameData.energy(1).point）；null=读不到
 * @param {number} minStamina 面板体力下限（normalize 产物，0 也抬到 1）
 * @returns {{ok:boolean,need:number,reason:string}} reason: ok|mirror|below
 */
function staminaGate(point, minStamina) {
  var need = Math.max(1, Number(minStamina) | 0); // 「体力耗尽必停」不可被面板配成 0 关掉
  if (point == null || !isFinite(point)) return { ok: false, need: need, reason: 'mirror' };
  if (point >= need) return { ok: true, need: need, reason: 'ok' };
  return { ok: false, need: need, reason: 'below' };
}

/**
 * 体力阻塞后的下拍延时：精准睡到下一个回体点（自然回体不一定推 10021，不能只靠推送唤醒）。
 * @param {number} nextRecoverSec 体力池给出的距下一点回体秒数（gameData.energy().nextRecoverSec）
 * @returns {number} 毫秒；秒数不可用时回 activeScanMs 重判
 */
function energyWakeMs(nextRecoverSec) {
  var sec = Number(nextRecoverSec);
  if (!(sec > 0)) return cfg.activeScanMs;
  var ms = sec * 1000 + cfg.energyWakeBufferMs;
  if (ms < cfg.energyWakeMinMs) ms = cfg.energyWakeMinMs;
  if (ms > cfg.energyWakeMaxMs) ms = cfg.energyWakeMaxMs;
  return ms;
}

/**
 * 干扰攻击击退闸判定（纯决策，单测与对拍直驱）。
 * 口径来源：游戏 `RadarDefPop` 的门槛就是「战力 ≥ PLAYER_LEVEL[等级].att_new」，不足则按钮置灰；
 *   竞品 B `server-js.js:19892` 同条另加 `radarSignNum <= 3`——那是给 3517「免费增强信号」留位（本 feat 不做 3517），
 *   我方只按 `sign<满格` 放行：击退本身就是把功率顶满，早做晚做都是净收益。
 * @param {{open:boolean,deBeginTime:number,sign:number,maxSign:number,handled:number,rejects:number,limit:number,power:number|null,needPower:number|null}} s 快照
 * @returns {{fire:boolean,reason:string}} reason: off|no-trigger|handled|full|reject-limit|no-reading|weak|fire
 */
function defenseGate(s) {
  if (!s.open) return { fire: false, reason: 'off' };
  var key = Number(s.deBeginTime) || 0;
  if (!(key > 0)) return { fire: false, reason: 'no-trigger' };
  if (key === (Number(s.handled) || 0)) return { fire: false, reason: 'handled' };
  if ((Number(s.sign) | 0) >= (Number(s.maxSign) | 0)) return { fire: false, reason: 'full' };
  if ((Number(s.rejects) | 0) >= (Number(s.limit) | 0))
    return { fire: false, reason: 'reject-limit' };
  var pw = Number(s.power);
  var need = Number(s.needPower);
  if (!(pw > 0) || !Number.isFinite(pw) || !(need > 0) || !Number.isFinite(need)) {
    return { fire: false, reason: 'no-reading' };
  }
  if (pw < need) return { fire: false, reason: 'weak' };
  return { fire: true, reason: 'fire' };
}

/**
 * 未知/不支持类型的当日一次告警 latch（latch 键含日界，跨日自动重来）。
 * @param {object} t 账本条目
 * @param {number} type 解析出的 type（0=未知）
 * @param {boolean} unsupported type 已知但 v1 不支持（208）
 */
function latchWarn(t, type, unsupported) {
  var key = day.day + '|' + t.taskId + '|' + type;
  if (skipLatch.has(key)) return;
  skipLatch.add(key);
  if (unsupported) {
    log.warn(
      'task type %d (taskId=%d id=%s) not supported in v1, skipped today.',
      type,
      t.taskId,
      t.id,
    );
  } else {
    log.warn(
      'unknown radar task type. taskId=%d id=%d state=%d x=%d y=%d (radar_event row missing & no fallback).',
      t.taskId,
      t.id,
      t.state,
      t.x,
      t.y,
    );
  }
}

// ── 动作执行 ────────────────────────────────────────────────────────
/**
 * 认领任务 3505：req {id:Number}；应答含该任务最新态数组 → 摊平入账本（state 0→1、回填 x/y）。永不 reject。
 * @param {object} t 账本条目
 * @returns {Promise<number>} SEND_OK|SEND_REJECTED|SEND_NOT_SENT
 */
async function startTask(t) {
  var ret = await net.sendGuarded(
    CMD_START_TASK,
    { id: Number(t.id) },
    {
      fallback: net.Ret.from(CODE_NOT_SENT, null),
      onError: function (err) {
        log.warn('3505 send error. id=%s taskId=%d %s', t.id, t.taskId, err && err.message);
      },
    },
  );
  if (ret.ok) {
    applyPayload(parseData(ret.data));
    log.info('task started. taskId=%d id=%s x=%d y=%d', t.taskId, t.id, t.x, t.y);
    return SEND_OK;
  }
  if (ret.code !== CODE_NOT_SENT) {
    log.info('3505 rejected. taskId=%d id=%s code=%s', t.taskId, t.id, ret.code);
    return SEND_REJECTED;
  }
  log.debug('3505 not sent (in-flight gate). id=%s', t.id);
  return SEND_NOT_SENT;
}

/**
 * 零部队行军 902（八键 body，报文实证逐键：marchType,x,y,armyList:[],armyListNew:[],heroList:[],trapList:[],formation:0）。
 * sendGuarded 默认在途闸门（isSending 语义）去重。永不 reject。
 * @param {object} t 账本条目（取 x/y）
 * @param {number} marchType 64|67|200
 * @returns {Promise<number>} SEND_OK|SEND_REJECTED|SEND_NOT_SENT
 */
async function sendZeroMarch(t, marchType) {
  var ret = await net.sendGuarded(
    CMD_MARCH_POINT,
    {
      marchType: marchType,
      x: t.x,
      y: t.y,
      armyList: [],
      armyListNew: [],
      heroList: [],
      trapList: [],
      formation: 0,
    },
    {
      fallback: net.Ret.from(march.NOT_SENT, null),
      onError: function (err) {
        log.warn(
          '902 zero send error. marchType=%d x=%d y=%d %s',
          marchType,
          t.x,
          t.y,
          err && err.message,
        );
      },
    },
  );
  if (ret.ok) {
    log.info('radar %d march ok. taskId=%d id=%s x=%d y=%d', marchType, t.taskId, t.id, t.x, t.y);
    return SEND_OK;
  }
  if (ret.code !== CODE_NOT_SENT) {
    log.info('902 rejected. marchType=%d id=%s code=%s', marchType, t.id, ret.code);
    return SEND_REJECTED;
  }
  log.debug('902 not sent (in-flight gate). marchType=%d id=%s', marchType, t.id);
  return SEND_NOT_SENT;
}

/**
 * 从预设出单兵编队（纯本地读预设 + adjust 排除在途，零发包）。
 * @param {number} preset 战斗预设 1~8
 * @returns {object|null} MarchData 或 null（预设无兵/英雄未释放）
 */
function buildPlan(preset) {
  var plan = new Battle().plan().preset(preset).adjust().build();
  if (!plan.armyListNew.length) return null;
  if (plan.presetHasHeroes && !plan.heroList.length) return null;
  return plan;
}

/**
 * 带兵单打 902（marchType=62）：经 core/march.attack 组 canonical body + 在途去重。永不 reject。
 * @param {object} t 账本条目
 * @param {object} plan MarchData
 * @returns {Promise<number>} SEND_OK|SEND_REJECTED|SEND_NOT_SENT
 */
async function sendAttack(t, plan) {
  var ret = await march.attack({
    marchType: MT_MONSTER,
    target: { x: t.x, y: t.y },
    data: plan,
  });
  return afterMarchRet(ret, t, 'attack(62)');
}

/**
 * 创建雷达集结 1201：feat 直发，body 逐键照抄惧星实证（无 break/extraArmy）。永不 reject。
 * @param {object} t 账本条目
 * @param {object} plan MarchData
 * @returns {Promise<number>} SEND_OK|SEND_REJECTED|SEND_NOT_SENT
 */
async function sendRally(t, plan) {
  var ret = await net.sendGuarded(
    CMD_CREATE_RALLY,
    {
      marchType: MT_RALLY,
      x: t.x,
      y: t.y,
      time: RALLY_WAIT_TIME,
      armyList: plan.armyListNew,
      armyListNew: plan.armyListNew,
      heroList: plan.heroList,
      trapList: plan.trapList,
      formation: 0,
      formationV2: plan.formationV2,
    },
    {
      fallback: net.Ret.from(march.NOT_SENT, null),
      onError: function (err) {
        log.warn('1201 send error. x=%d y=%d %s', t.x, t.y, err && err.message);
      },
    },
  );
  return afterMarchRet(ret, t, 'rally(1201)');
}

/**
 * 派兵应答统一记账：受理即 info + SEND_OK；拒按 CODE_NOT_SENT/业务码分档 debug/info。
 * @param {object} ret net.Ret
 * @param {object} t 账本条目
 * @param {string} what 日志动作名
 * @returns {number} SEND_OK|SEND_REJECTED|SEND_NOT_SENT
 */
function afterMarchRet(ret, t, what) {
  if (ret && ret.ok) {
    log.info('radar %s ok. taskId=%d id=%s x=%d y=%d', what, t.taskId, t.id, t.x, t.y);
    return SEND_OK;
  }
  if (ret && ret.code !== CODE_NOT_SENT && ret.code !== march.NOT_SENT) {
    log.info('radar %s rejected. id=%s code=%s', what, t.id, ret.code);
    return SEND_REJECTED;
  }
  if (ret) log.debug('radar %s not sent (gate/bridge). id=%s', what, t.id);
  return SEND_NOT_SENT;
}

// ── 领奖 ────────────────────────────────────────────────────────────
/**
 * 领一串 state=4 任务（3508 串行 + 1.2s 间隔）。单飞锁持有的任务不领（其终态由推送认领）。
 * @returns {Promise<{claimed:number,left:number}>} claimed=本拍领取成功数；left=账本剩余待领数
 */
async function claimFinished() {
  var list = [];
  tasks.forEach(function (t) {
    if (t.state === ST_FINISH && !(exec && exec.key === t.id)) list.push(t);
  });
  list.sort(candCmp);
  var claimed = 0;
  var n = Math.min(list.length, cfg.claimMaxPerPass);
  for (var i = 0; i < n; i++) {
    if (!aliveFn()) break;
    var t = list[i];
    var ret = await net.sendGuarded(
      CMD_GET_REWARD,
      { id: Number(t.id) },
      {
        fallback: net.Ret.from(CODE_NOT_SENT, null),
        onError: function (err) {
          log.warn('3508 send error. id=%s %s', t.id, err && err.message);
        },
      },
    );
    if (ret.ok) {
      tasks.delete(t.id);
      claimed++;
      day.claimed++;
      persistStats();
      pokePanel();
      log.info('reward claimed. taskId=%d id=%s today=%d', t.taskId, t.id, day.claimed);
    } else if (ret.code !== CODE_NOT_SENT) {
      log.info('3508 rejected. taskId=%d id=%s code=%s', t.taskId, t.id, ret.code);
    } else {
      log.debug('3508 not sent (in-flight gate). id=%s', t.id);
    }
    if (i < n - 1) await sleep(cfg.claimGapMs, ctxRef && ctxRef.signal); // pause 早醒，循环头 aliveFn 闸门兜住
  }
  var left = 0;
  tasks.forEach(function (t) {
    if (t.state === ST_FINISH) left++;
  });
  return { claimed: claimed, left: left };
}

// ── 单飞锁维护 ──────────────────────────────────────────────────────
/**
 * 停滞记账的一步（纯决策，单测直驱）：只有 rollback（dispatch 被 s=0 受理、账本却回滚到可派态）计停滞；
 * finish/gone 说明该动作有下文，一律清零。
 * @param {string} kind finish|gone|rollback
 * @param {number} prev 该实例此前的连续停滞次数
 * @param {number} limit cfg.dispatchStallLimit
 * @returns {{n:number, yielded:boolean}} n=记账后的停滞次数（0=已清零）；yielded=本次达阈而当日让位
 */
function stallStep(kind, prev, limit) {
  if (kind !== 'rollback') return { n: 0, yielded: false };
  var n = (Number(prev) | 0) + 1;
  return { n: n, yielded: n >= (Number(limit) | 0) };
}

/**
 * 依据账本最新态维护 exec 锁（四种终局，口径与报文实证同步）：
 *  - state∈{2,3} → 保持锁（行军在途），并记 engaged=服务器已确认该次 dispatch 成型；
 *  - state=4 → 释放并清零（本动作已达成，下一拍领奖）；
 *  - 条目消失 → 释放并清零（完成被移除/任务过期，无停滞证据）；
 *  - 其余（回滚到 0/1）→ 释放并记一次停滞：这就是「集结窗到期被服务器原地解散」那一型。
 * 沉降窗（dispatchSettleMs）内一律不判：派兵那一刻账本还是 state=1，engage 推送要 <100ms 后才到，
 * 抢在推送前判会把正常派兵误计成停滞（保持锁等下一拍即可）。
 */
function syncExecLock() {
  if (!exec) return;
  var t = tasks.get(exec.key);
  if (!t) {
    endExec('gone');
    return;
  }
  if (t.state === ST_RUNNING || t.state === ST_SECONDARY) {
    exec.engaged = true;
    return;
  }
  if (t.state === ST_FINISH) {
    endExec('finish');
    return;
  }
  if (Date.now() - exec.since < cfg.dispatchSettleMs) return; // 等 engage 落地，不与推送赛跑
  endExec('rollback');
}

/**
 * 释放单飞锁并按收尾类型记账（详见 syncExecLock / stallStep）。让位时短拍一次，不等对拍档。
 * @param {string} kind finish|gone|rollback
 */
function endExec(kind) {
  var e = exec;
  exec = null;
  var step = stallStep(kind, stallCount.get(e.key) || 0, cfg.dispatchStallLimit);
  if (step.n > 0 && !step.yielded) {
    stallCount.set(e.key, step.n);
    log.info(
      'dispatch rolled back without progress. taskId=%d id=%s engaged=%d stalls=%d',
      e.taskId,
      e.key,
      e.engaged ? 1 : 0,
      step.n,
    );
    return;
  }
  stallCount.delete(e.key);
  if (!step.yielded) return;
  stallYield.add(e.key);
  log.info(
    'task yields today (accepted but never progressed). taskId=%d id=%s stalls=%d engaged=%d',
    e.taskId,
    e.key,
    step.n,
    e.engaged ? 1 : 0,
  );
  extraDelay = 1000; // 短拍：立刻换下一个候选，别把其余任务压到对拍档
}

/**
 * 置单飞锁（动作成功后；后续推进全靠推送/对拍改账本）。
 * @param {object} t 账本条目
 * @param {number} type 任务 type
 */
function lockExec(t, type) {
  exec = {
    key: t.id,
    taskId: t.taskId,
    type: type,
    since: Date.now(),
    engaged: false,
    resynced: false,
    resyncAt: 0,
  };
}

/**
 * 当日「不再 dispatch」的实例集合：服务器连续拒（rejectBlacklist）+ 受理但连续停滞（stallYield）合并；
 * 两者都只挡执行、不挡领奖（claimFinished 不看本集合，误伤不会锁死奖励）。
 * @returns {Set<string>}
 */
function yieldIds() {
  var s = new Set(rejectBlacklist);
  stallYield.forEach(function (id) {
    s.add(id);
  });
  return s;
}

/**
 * 停滞次数快照（喂给 candCmp 的降权键；Map → 普通对象，避开热路径逐次 Map 查找）。
 * @returns {Object<string,number>}
 */
function stallSnapshot() {
  var o = {};
  stallCount.forEach(function (n, id) {
    o[id] = n;
  });
  return o;
}

/**
 * 三态发送结果 → 归因词（debug 单轨必须能区分「服务器拒了」与「本端没发出去」）。
 * @param {number} r SEND_*
 * @param {string} okWord 受理时的归因词
 * @returns {string} dispatch/start/rejected/not-sent 之一
 */
function reasonOfSend(r, okWord) {
  if (r === SEND_OK) return okWord;
  return r === SEND_REJECTED ? 'rejected' : 'not-sent';
}

/**
 * 服务器拒的统一收尾：同一「实例 id + 动作」连续拒 rejectRetryLimit 次即当日拉黑，并立刻 3504 重拍。
 * 两道治法缺一不可：
 * 1. 拉黑：被拒任务不改变账本态，下一拍 candCmp 仍会选中同一条，不拉黑就是 15s/拍整夜死循环，
 *    且它恒排最前会把其余候选全饿死（真机实录：一场 id=3145 被拒 12 次、pending=10 全夜不动）。
 * 2. 重拍：「拒」最常见的成因是本地账本陈旧（游戏侧已完成而裸事件推送未入账），3504 权威态回来后
 *    该条会直接变 state=4 走领奖，拉黑不会误伤它（claimFinished 不看拉黑名单）。
 * @param {object} t 账本条目
 * @param {string} what 动作名
 * @returns {Promise<void>}
 */
async function latchReject(t, what) {
  var k = t.id + '|' + what;
  var n = (rejectCount.get(k) || 0) + 1;
  if (n < cfg.rejectRetryLimit) {
    rejectCount.set(k, n);
    return;
  }
  rejectCount.delete(k);
  rejectBlacklist.add(t.id);
  log.info('task blacklisted today. id=%s taskId=%d act=%s rejects=%d', t.id, t.taskId, what, n);
  extraDelay = 1000; // 短拍：尽快换下一个候选，别把其余任务压到 activeScanMs 档
  await fetchInfo(); // 读通道重拍：把可能的 state=4 权威态取回来
}

// ── 雷达防御（干扰攻击） ────────────────────────────────────
/**
 * 击退战力门槛（与游戏 `RadarDefPop.powerLabel` 同源读数）：PLAYER_LEVEL[本人等级] 的 att_new / att_old。
 * 三态收口：等级/表行取不到、值非正 → null（调用侧 fail-closed 不发）。
 * combat_power_v1 开关决定取哪一列（竞品同口径）；而 `functionOnValue` 无从判定（回 null）时按游戏面板本身取
 *   att_new——因为 RadarDefPop 里就是硬读 `o.att_new`、不做该判定，取 att_new 与真人看到的门槛同源。
 * @returns {number|null} 所需战力；null=读不到
 */
function defenseNeedPower() {
  var lv = gameData.level();
  if (!(lv > 0)) return null;
  var row = l10n.tableRow('PLAYER_LEVEL', lv);
  if (!row) return null;
  var col = gameData.functionOnValue('combat_power_v1') === false ? 'att_old' : 'att_new';
  var v = Number(row[col]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 雷达防御一步（永不 reject）：闸过则发一笔 3515 空体；受理即记幂等键并落盘；业务拒计数达阈同样锁死该次触发；
 * CODE_NOT_SENT 不计拒（本端吞包，下拍自然重来）。
 * @returns {Promise<void>}
 */
async function tryDefend() {
  var key = scalars.deBeginTime;
  var g = defenseGate({
    open: MCFG.doDefend,
    deBeginTime: key,
    sign: scalars.sign,
    maxSign: SIGN_MAX,
    handled: defendHandledKey,
    rejects: defendRejects,
    limit: cfg.rejectRetryLimit,
    power: gameData.myPower(),
    needPower: defenseNeedPower(),
  });
  lastDefend = g.reason;
  if (!g.fire) return;
  var ret = await net.sendGuarded(
    CMD_DEFEND,
    {},
    {
      fallback: net.Ret.from(CODE_NOT_SENT, null),
      onError: function (err) {
        log.warn('3515 send error. key=%d %s', key, err && err.message);
      },
    },
  );
  if (!aliveFn()) return;
  if (ret.ok) {
    defendHandledKey = key;
    defendRejects = 0;
    persistStats();
    var d = parseData(ret.data);
    var after = d && Number.isFinite(Number(d.sign)) ? Number(d.sign) : scalars.sign;
    log.info('radar defense repelled. key=%d sign=%d->%d', key, scalars.sign, after);
    return;
  }
  if (ret.code !== CODE_NOT_SENT) {
    defendRejects++;
    log.info('3515 rejected. key=%d code=%s rejects=%d', key, ret.code, defendRejects);
    if (defendRejects >= cfg.rejectRetryLimit) {
      // 锁死该次触发而不是一般重试：干扰攻击每日至多 1 次，反复撞日限只会刷日志
      defendHandledKey = key;
      persistStats();
      log.info('radar defense locked for this trigger. key=%d rejects=%d', key, defendRejects);
    }
    return;
  }
  log.debug('3515 not sent (in-flight gate). key=%d', key);
}

// ── 调度 ────────────────────────────────────────────────────────────
/** @type {string} 本轮决策归因（供统一 debug 行；quota 类 feat 同范式） */
var lastReason = 'idle';
/** @type {string} 本轮体力读数（归因行披露，单轨可判「为何不起新任务」） */
var lastStamina = '-';
/** @type {number} 本轮附加延时（0=用默认档） */
var extraDelay = 0;

/**
 * exec 在途期间的「只认领」推进（3505）：认领不占行军槽、不扣体力、不置单飞锁，
 * 所以在途时完全可以把 state=0 的任务先领到手，锁一释放就能立刻出兵。
 * 实录报文实证：一条集结被 60s 解散窗反复占锁的 11 分钟里，
 * 9 条 state=0 的普通任务 0 笔 3505、0 笔 3508，日志全刷 reason=exec —— 用户看到的
 * 「雷达久久不执行」正是被这个早返回吞掉的。单飞锁管的是「执行」，不是「认领」。
 * 每拍最多 1 条：不一次把整池领空，保留链式解锁节奏与体力闸口径（认领+出兵一起停）。
 * @returns {Promise<void>}
 */
async function claimStartsWhileExec() {
  if (!exec) return;
  var en = gameData.energy(STAMINA_TYPE);
  var pt = en ? en.point : null;
  lastStamina = pt == null ? '-' : String(pt);
  if (!staminaGate(pt, MCFG.minStamina).ok) return; // 保持 reason=exec 归因；体力读数已在本行披露
  var resolve = function (t) {
    return resolveType(t, l10n.tableRow, l10n.tableReady());
  };
  var dec = pickCandidate(tasks.values(), MCFG, resolve, exec.key, yieldIds(), {
    onlyStart: true,
    stalls: stallSnapshot(),
  });
  var p = dec.pick;
  if (!p) return;
  var rs = await startTask(p.task);
  if (!aliveFn()) return;
  if (rs === SEND_OK) {
    extraDelay = extraDelay > 0 ? Math.min(extraDelay, 1000) : 1000; // 领到一条就尽快续领
    return;
  }
  if (rs === SEND_REJECTED) await latchReject(p.task, 'start');
}

/**
 * 单拍：未同步先 3504 → 防御击退 → 领奖 → exec 在途判（在途仍推认领）→ 体力闸 → 选候选 → 执行一步。永不 reject。
 * @returns {Promise<void>}
 */
async function cyclePass() {
  lastReason = 'idle';
  lastStamina = '-';
  extraDelay = 0;
  ensureDay();
  if (!synced) {
    var ok = await fetchInfo();
    if (!aliveFn()) return;
    if (!ok) {
      lastReason = 'no-sync';
      extraDelay = cfg.activeScanMs;
      return;
    }
  }

  // 0) 雷达防御（干扰攻击）：与领奖/执行互不依赖，且触发前提就是「任务已全清」，故放在全部早返回之前，
  // 否则会被 exec 在途/体力闸那两条 return 吞掉，错过当日唯一一次机会（窗长未知，不本地估窗）。
  await tryDefend();
  if (!aliveFn()) return;

  // 1) 领奖优先（与执行解耦：即时型/未知型任务只有领这一件事可做）。
  // 先释放已完成的单飞锁再领：否则那一拍只放锁、下拍才领，白搭一个间隔（账本 state=4 即终态，释放安全）。
  syncExecLock();
  var cr = await claimFinished();
  if (!aliveFn()) return;
  if (cr.left > 0) {
    lastReason = 'claim';
    extraDelay = 2000; // 还有未领完：短间隔续拍
    return;
  }
  if (cr.claimed > 0) {
    // 领掉了任务可能连带链解锁/账本变化：立即下拍重评
    lastReason = 'claim';
    extraDelay = 0;
    return;
  }

  // 2) 单飞在途：不轮询行军细节，只按窗到期对拍；但认领（3505）不受本锁约束（见 claimStartsWhileExec）
  if (exec) {
    var age = Date.now() - exec.since;
    if (age < cfg.dispatchSettleMs) {
      // 刚受理：等 engage 推送（state→2）落地再判，窗内不放锁也不计停滞
      lastReason = 'exec';
      extraDelay = cfg.dispatchSettleMs - age;
      return;
    }
    // 对拍两档：首次按集结窗到期（execPollMs）即醒——窗一过就能发现解散并换候选；
    // 确认仍 in-flight（真在行军路上）才降到 execResyncMs 低频档，不让长行军变成频繁读接口
    var gap = exec.resynced ? cfg.execResyncMs : cfg.execPollMs;
    if (Date.now() - (exec.resyncAt || exec.since) >= gap) {
      exec.resynced = true;
      exec.resyncAt = Date.now();
      await fetchInfo(); // 漏推兜底：读通道重拍
      if (!aliveFn()) return;
      syncExecLock();
    }
    if (exec) {
      lastReason = 'exec';
      await claimStartsWhileExec();
      return;
    }
  }

  // 3) 体力闸：低于下限即暂停「起新任务」（认领+出兵）；领奖已在步骤 1 做完，不受此限
  var en = gameData.energy(STAMINA_TYPE);
  var pt = en ? en.point : null;
  lastStamina = pt == null ? '-' : String(pt);
  var gate = staminaGate(pt, MCFG.minStamina);
  if (!gate.ok) {
    lastReason = gate.reason === 'mirror' ? 'no-energy' : 'no-stamina';
    extraDelay = gate.reason === 'mirror' ? cfg.activeScanMs : energyWakeMs(en.nextRecoverSec);
    log.debug(
      'stamina gate blocked. point=%s; need=%d; wake=%dms; nextRecoverSec=%s',
      lastStamina,
      gate.need,
      extraDelay,
      en ? en.nextRecoverSec : '-',
    );
    // 真耗尽（point=0 且池存在）是用户要的正常暂停态，留 debug；下面三种「读不通」才是规范第 2 条的真异常，
    // 且本 feat 是整条玩法停摆（不是少做一个动作），本场首条升 warn 保证关 debug 也能定位：
    //   a) energy() 返回 null（userData/getEnergy 不在场） b) 池上限读成 0 c) 镜像说 0 但最近一条 10021 说 >0
    //   （c 抓住 `Number(e.Point) || 0` 把 getter 改名伪装成耗尽的情形；无推送样本时不误报）
    var unusable =
      gate.reason === 'mirror' || !(en && en.pointMax > 0) || (pt === 0 && lastEnergyPoint > 0);
    if (unusable && !staminaWarned) {
      staminaWarned = true;
      log.warn(
        'stamina mirror unusable, new tasks paused. point=%s; pointMax=%s; lastPush=%s; need=%d; reason=%s',
        pt,
        en ? en.pointMax : '-',
        lastEnergyPoint,
        gate.need,
        gate.reason,
      );
    }
    return;
  }
  staminaPendingDrained = false; // 体力闸放行：解开「短拍一次」闸，下次再阻塞仍可短拍一次

  // 4) 选下一个候选并执行一步
  var resolve = function (t) {
    return resolveType(t, l10n.tableRow, l10n.tableReady());
  };
  var dec = pickCandidate(tasks.values(), MCFG, resolve, exec && exec.key, yieldIds(), {
    stalls: stallSnapshot(),
  });
  if (dec.unknown) {
    // 未知类型：定位在可推进的账本条目上逐个 latch 告警（不执行）
    tasks.forEach(function (t) {
      if ((t.state === 0 || t.state === 1 || t.state === 3) && resolve(t).type === 0)
        latchWarn(t, 0, false);
    });
  }
  dec.unsupported.forEach(function (t) {
    latchWarn(t, resolve(t).type, true);
  });
  if (dec.gated && !dec.pick) {
    lastReason = 'no-preset';
    return;
  }
  var pick = dec.pick;
  if (!pick) {
    if (dec.unsupported.length) {
      lastReason = 'skip';
      return;
    }
    lastReason = tasks.size ? 'idle' : 'pool-empty';
    return;
  }
  var t = pick.task;
  if (pick.act.act === 'start') {
    var rs = await startTask(t);
    if (!aliveFn()) return;
    lastReason = reasonOfSend(rs, 'start');
    if (rs === SEND_OK) {
      extraDelay = 1000; // 认领后尽快推进动作步
      return;
    }
    if (rs === SEND_REJECTED) await latchReject(t, 'start');
    return;
  }
  if (pick.act.needsTroops) {
    if (march.freeSlots() <= 0) {
      log.debug('no free march slot, wait for arrival wake. id=%s', t.id);
      lastReason = 'no-queue';
      extraDelay = 0;
      return;
    }
    var plan = buildPlan(MCFG.preset);
    if (!plan) {
      log.debug('preset %d out of troops this cycle. id=%s', MCFG.preset, t.id);
      lastReason = 'no-troops';
      return;
    }
    var rs2 = pick.act.act === 'rally' ? await sendRally(t, plan) : await sendAttack(t, plan);
    if (!aliveFn()) return;
    if (rs2 === SEND_OK) lockExec(t, pick.type);
    lastReason = reasonOfSend(rs2, 'dispatch');
    if (rs2 === SEND_REJECTED) await latchReject(t, pick.act.act);
    return;
  }
  // 零部队行军
  var rs3 = await sendZeroMarch(t, pick.act.marchType);
  if (!aliveFn()) return;
  if (rs3 === SEND_OK) lockExec(t, pick.type);
  lastReason = reasonOfSend(rs3, 'dispatch');
  if (rs3 === SEND_REJECTED) await latchReject(t, 'zero' + pick.act.marchType);
}

/**
 * 单轮调度：跑 cyclePass → 返回下拍间隔毫秒（<=0 立即补扫）。
 * 择时：本轮明示附加延时 > 在飞补扫(0) > exec 对拍档 > active/idle 两档。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  await cyclePass();
  if (!aliveFn()) return cfg.idleResyncMs;
  if (extraDelay === 0 && lastReason !== 'idle' && lastReason !== 'pool-empty') {
    // 显式「立即续拍」（认领成功/领完一轮）：靠 cycle pending 合并语义自然补扫
    if (cycle.pending) return 0;
  }
  if (extraDelay > cfg.activeScanMs && cycle.pending && !staminaPendingDrained) {
    // 体力闸长睡（约 6min）不能吞掉本轮在飞期间到达的触发：内核的 kick() 只在非在飞时提前 arm，
    // 在飞时只置 pending，而 arm(delay) 不看 pending。不短拍一次的话，那拍里刚推到 state=4 的奖励
    // 要等一个回体窗才能领，偏离「体力不足期间继续领奖」口径。空拍零发包，代价可忽略；
    // 每次阻塞只放行一次（staminaPendingDrained），避免持续推送退化成 1s 空拍循环。
    staminaPendingDrained = true;
    return 1000;
  }
  if (extraDelay > 0) return extraDelay;
  if (exec) {
    // 在途唤醒节律与 cyclePass 同口径：首次睡到窗到期（execPollMs），对拍过且确认仍在途才降到 execResyncMs；
    // 下限钳到 pushScanMinGap，避开同一拍里多次重入（窗已过期时 left 可能为负）
    var left =
      (exec.resynced ? exec.resyncAt + cfg.execResyncMs : exec.since + cfg.execPollMs) - Date.now();
    return left > cfg.pushScanMinGap ? left : cfg.pushScanMinGap;
  }
  if (lastReason === 'pool-empty') return cfg.idleResyncMs;
  if (lastReason === 'idle') return cfg.idleResyncMs;
  return cfg.activeScanMs;
}

/**
 * 统一决策 debug 行（卡车拦截范式：收敛出口、含归因与关键计数，保证 debug 日志单轨可还原「为什么没动」）。
 */
function logDecision() {
  var claimable = 0;
  var pending = 0;
  tasks.forEach(function (t) {
    if (t.state === ST_FINISH) claimable++;
    else if (t.state === 0 || t.state === 1 || t.state === 3) pending++;
  });
  log.debug(
    'pass done. reason=%s; pending=%d; claimable=%d; exec=%s; pool=%d; stamina=%s; blacklist=%d; yield=%d; defend=%s; sign=%d; deBegin=%d',
    lastReason,
    pending,
    claimable,
    exec ? exec.taskId + ':' + exec.key : '-',
    scalars.taskPoolSurplusNum,
    lastStamina,
    rejectBlacklist.size,
    stallYield.size,
    lastDefend,
    scalars.sign,
    scalars.deBeginTime,
  );
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器 */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: async function () {
    try {
      return await cycleRun();
    } finally {
      logDecision();
    }
  },
  fallback: cfg.activeScanMs,
});

/**
 * 推送唤醒（去抖）：距上次补扫 < pushScanMinGap 则忽略，靠兜底定时收尾。
 */
function pushWake() {
  if (!aliveFn()) return;
  var wall = Date.now();
  if (wall - lastPushWakeAt < cfg.pushScanMinGap) return;
  lastPushWakeAt = wall;
  cycle.kick();
}

/**
 * 雷达推送统一处理：任务事件入账本 + 标量刷新 + 去抖唤醒。send 通道推送 ev.data 即载荷对象。
 * 必须走 applyPushPayload：20013/20025 是裸事件对象，旧的 applyPayload 只读 events 数组会把它们全丢，
 * 导致账本永远停在 state=1、既不领奖也不重拍（真机实录：一场 902 code=3 死循环 15s/拍）。
 * @param {object} ev bus Event
 */
function onRadarPush(ev) {
  var d = parseData(ev && ev.data);
  if (!d) return;
  applyPushPayload(d);
  pushWake();
}

/**
 * 10021 体力推送：只认体力池（type=1）且只在点数回升时唤醒。
 * 报文实证：出兵每扣一次体也推一条 10021（reason=RADAR_*），不过滤方向就会「自己动一下→被推→再踢一轮」；
 * 回体/用药才会把点数抬上去，那才是体力闸需要重判的时刻。
 * @param {object} ev bus Event
 */
function onEnergyPush(ev) {
  var d = parseData(ev && ev.data);
  if (!d || (Number(d.type) | 0) !== STAMINA_TYPE) return;
  var pt = Number(d.point);
  if (!isFinite(pt)) return;
  var rose = lastEnergyPoint == null || pt > lastEnergyPoint;
  lastEnergyPoint = pt;
  if (rose) pushWake();
}

// ── 生命周期 ────────────────────────────────────────────────────────
/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  net = ctx.net;
  if (!net.install()) {
    net = null;
    log.warn('install failed. missing=pocketcc.net');
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入：整体接收 toModuleCfg 归一化产物（绝不二次归一）；运行中即时唤醒一轮。
 * @param {object} partial reactor 推送的 { enabled, doDaily, doEvents, doMarch, doDefend, preset, minStamina }
 * @returns {object} MCFG
 */
function configure(partial) {
  MCFG = normalize(partial || {});
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：复位内存态 → 挂雷达推送 → 读盘恢复当日计数 → 点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  tasks = new Map();
  scalars = { taskPoolSurplusNum: 0, scaned: 0, nexRefreshtTime: 0, sign: 0, deBeginTime: 0 };
  synced = false;
  exec = null;
  lastPushWakeAt = 0;
  lastEnergyPoint = null;
  staminaWarned = false;
  rejectCount = new Map();
  rejectBlacklist = new Set();
  stallCount = new Map();
  stallYield = new Set();
  staminaPendingDrained = false;
  defendRejects = 0;
  lastDefend = '-';
  skipLatch.clear();
  ctx.on.push(PUSH_STATUS_CHANGE, onRadarPush);
  ctx.on.push(PUSH_ADD_ONE_TASK, onRadarPush);
  ctx.on.push(PUSH_OTHER_DATA, onRadarPush);
  ctx.on.push(PUSH_SIGN, onRadarPush);
  ctx.on.push(PUSH_RING_CHANGE, onRadarPush);
  ctx.on.push(PUSH_DAYGROUP_CHANGE, onRadarPush);
  ctx.on.push(PUSH_ENERGY, onEnergyPush);
  log.info(
    'started. doDaily=%d doEvents=%d doMarch=%d doDefend=%d preset=%d minStamina=%d',
    MCFG.doDaily ? 1 : 0,
    MCFG.doEvents ? 1 : 0,
    MCFG.doMarch ? 1 : 0,
    MCFG.doDefend ? 1 : 0,
    MCFG.preset,
    MCFG.minStamina,
  );
  loadStats().then(function () {
    if (aliveFn()) cycle.kick();
  });
}

/**
 * 停用：本 feat 无自建常驻定时器（sleepMs 仅在飞一次性、由 alive() 截断后续），无需显式收；
 * 推送退订由 reactor triggers 托管。
 */
function pause() {}

// ── 面板 descriptor ─────────────────────────────────────────────────
/**
 * 生成 defaults：四类开关全开（含雷达防御）、出兵预设未选（0=只领奖/零部队任务）；
 *   体力下限默认 8（=实测最贵一档单价：带兵单打/集结各 8，零部队求援 5），保证不会「认领了却打不起」。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
    doDaily: true,
    doEvents: true,
    doMarch: true,
    doDefend: true,
    preset: 0,
    minStamina: 8,
  };
}

/**
 * 生成 fields：四个 checkbox + 体力下限 + 一行 ctrlrow（预设下拉 | 今日已领只读）。
 * @returns {object[]}
 */
function buildFields() {
  var presetOptions = [{ value: 0, label: '不派兵' }];
  for (var i = 1; i <= 8; i++) presetOptions.push({ value: i, label: '预设 ' + i });
  return [
    {
      key: 'doDaily',
      label: '每日三连环',
      type: 'checkbox',
      title: '类一：day_group 链式三任务（零部队援助/带兵单打/集结各一），逐个解锁',
    },
    {
      key: 'doEvents',
      label: '普通任务',
      type: 'checkbox',
      title: '类二：环上普通任务（含黑暗军团据点集结、玩家求援、即时领奖型）',
    },
    {
      key: 'doMarch',
      label: '派兵任务',
      type: 'checkbox',
      title: '关闭后仍领奖与零部队行军，但不做带兵单打/集结',
    },
    {
      key: 'doDefend',
      label: '雷达防御',
      type: 'checkbox',
      title:
        '黑暗军团干扰攻击（deBeginTime>0，任务全部做完后触发）时自动发一笔 3515 击退：不派兵、不扣体力，打完信号功率满格→下一次截取必为 5 星；每日至多 1 次，战力不够则不做',
    },
    {
      // number 渲染器不吃 title/hint/max（只吐 min/step/placeholder/value），关键口径进 label（同 auto-hunt）
      key: 'minStamina',
      label: '体力下限(低于即停·0按1)',
      type: 'number',
      min: 0,
      step: 1,
      title: '出兵一次实扣 5~8 体力（3505 认领/3508 领奖不扣）；低于此值只继续领奖、不再认领与出兵',
    },
    {
      key: 'radarRow',
      label: '出兵与进度',
      type: 'ctrlrow',
      table: true,
      cells: [
        {
          key: 'preset',
          label: '战斗预设',
          title: '带兵任务用该预设（1~8）出兵；0=不派兵',
          options: presetOptions,
        },
        {
          key: 'radarStats',
          label: '今日已领',
          type: 'text',
          title: '今日雷达任务成功领奖次数（无每日上限，0 点归零）',
          get: function () {
            // 只报一个数：原先的「完成/已领」两个计数器同分支同增、恒相等，N/N 会被误读成每日配额
            return day.loaded ? String(day.claimed) : '-';
          },
        },
      ],
    },
  ];
}

reactor.register({
  id: 'radarTask',
  label: '雷达任务',
  storageKey: 'pocketcc.feat.radarTask',
  symbols: ['presetMarch', 'heroController', 'mechaController', 'formationAdv', 'marchStorage'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalize,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});

// 纯函数 + 协议字典导出（单测直驱与 replay manifest 对拍共用；同一份真相源，判据不与 feat 分叉）
export {
  normalize,
  applyEventTo,
  isTaskEvent,
  resolveType,
  actionFor,
  candCmp,
  pickCandidate,
  stallStep,
  staminaGate,
  energyWakeMs,
  defenseGate,
  normalizeDeBeginTime,
  cfg,
  TYPE_ACTIONS,
  UNSUPPORTED_TYPES,
  TASK_TYPES,
  ST_FINISH,
  ST_RUNNING,
  ST_SECONDARY,
  SEND_OK,
  SEND_REJECTED,
  SEND_NOT_SENT,
  CMD_GET_INFO,
  CMD_START_TASK,
  CMD_GET_REWARD,
  CMD_MARCH_POINT,
  CMD_CREATE_RALLY,
  CMD_DEFEND,
  SIGN_MAX,
  PUSH_STATUS_CHANGE,
  PUSH_ADD_ONE_TASK,
  PUSH_OTHER_DATA,
  PUSH_SIGN,
  PUSH_RING_CHANGE,
  PUSH_DAYGROUP_CHANGE,
  PUSH_ENERGY,
  STAMINA_TYPE,
  MT_MONSTER,
  MT_TREASURE,
  MT_ASSIST,
  MT_HELP,
  MT_RALLY,
  RALLY_WAIT_TIME,
};
