/**
 * 自动驾驶引擎 **v3「领航员」**（异能秘境：主动视口 + 权威锚点 + 阶段网关 + 到点分派）。
 *
 * ═══ 为什么推翻 v2（drive.js）═══
 * v2 的目的地候选**只有一个来源**：push 10018 累积的 `#tiles` 视口快照。而 10018 是「镜头扫过才推」的
 *   增量包 —— 实战三份探针实测 `tiles.size = 3`、`byPt = {172:1, 173:2}`。这决定了四条用户不满：
 *   ① 开车开不动：候选池只有 2~3 个点，全被别队占用/抽空后就是 `no_candidate`；
 *   ② 到不了商店：四个商店是**固定建筑**（161），镜头永远扫不到 → 商店档永远无候选；
 *   ③ 打不了 BOSS：平台（176）坐标同样靠视口找，而服务器其实早给了 BOSS 权威坐标；
 *   ④ 到店不买货：上游从没把车开到店里，shop.js 的买货链（8540/8542/8543）一次都没被触发。
 *   → 四条不满是**同一行代码的下游**：`候选 ← 10018`。v3 换掉的就是这一行。
 *
 * ═══ 竞品B（helper.pro.misc.enigmaSecret）怎么做的 ═══
 * 三源合一 + 100ms 分频 + 阶段网关 + 单引擎全包：
 *   • **数据源**：商店坐标读表 `enigma_secret_realm_building`（`build_type==3 && group==getPabGroupId()`，
 *     字段 `coords="x,y"`）；BOSS 坐标读服务器态 `bossBaseInfo[i].pos`；资源/平台靠 **901 GET_WORLD_INFO 主动拉**
 *     （`{x,y,k,rid:0,width:20,height:30,marchInfo:true}`，3s 一次）。**只有它主动问，不等推送。**
 *   • **节拍**：`setInterval(...,100)` + `counter % N` 分频 + `busy` 锁 + `cd_time`（服务器秒）节流。
 *   • **阶段网关**：`exitStage`（收场）/ `shopStage`（该去商店）/ `beastStage`（可以抓百兽）。
 *   • **动作**：`marchShop`（表坐标，按「香肠剩量→距离」排序）/ `marchPlane`（BOSS 邻域 176 平台）/
 *     `marchBoss`（state21 直接打 BOSS 坐标）/ `marchResource`（901 视口 20×30，评分
 *     `iNum − 距起点/2 − 距无香肠店/5`，`marched_list` 60s 防重派）。
 *   • **到点分派**：到 161 → `shopConver` 买货（`getTime==0` 才可买，41009 够付才发 8542，
 *     无目标品且 41010>0 → 8543 刷新）；到 173/163 → `getResItem` 拾取；到 176 → 攻打。
 *
 * ═══ v3 四层 ═══
 *   S0 数据层 `#syncAnchors` + `#refreshView` + 10018 push 兜底
 *      · 锚点：表格四店坐标（权威、与镜头无关）+ `bossBaseInfo[].pos`（权威、与镜头无关）
 *      · 视口：901 每 `tuning.driveViewMs`(3s) 以自己（或开台中的 BOSS）为中心主动拉一刀，
 *        结果并入 `#tiles`（`src:'v'` 覆盖 push 的旧值）。901 连续失败 3 次 → `#viewOff` 降级
 *        （仍能开商店/BOSS，只是巡航回到 push+探索），60s 后重试。
 *   S1 阶段层 `#bossWindow`（21 开打 / 22 开台读秒）/ `#shopWant`（缺香肠 / 大BOSS 前勤务 / 定期轮巡）
 *   S2 动作层 `#pickBoss` / `#pickShop` / `#pickPlane` / `#pickResource` / `#pickExplore` → `#dispatch`
 *   S3 到点层 `#enterWork`（161 驻留让 shop.js 买货；173/163 拿空即走；176/177 交给 boss.js）
 *
 * ═══ 从 v2 继承下来、被实战验证过的部分（不推翻）═══
 *   · TO 相位短轮询（不睡满 90s，否则「42s 零 tick、车不动」）；
 *   · 到达双路确认（`roomBaseInfo.startPoint` 复核 + 超时兜底）；
 *   · 拿空双料源（21522/21532 CHANGE 按点账 + 快照 `rTime`/`iNum` 当前态）；
 *   · 同点短路（目标 == 当前点不发 8521，否则空等 90s 再派回同点）；
 *   · 在途幽灵条目自愈（`isSecretSending(8521)` 久堵且已停泊 → 绕闸发探测包）；
 *   · `enigma_realm17`（战场即将封闭）识别 → 本场停手；
 *   · 受击逃营帐 + 回攻 / 当前点被 PVP 原地应战。
 *
 * ═══ 拒绝码处置（v3 比 v2 多认三条）═══
 *   157 已在该点 → 直接进 WORK；158 在途 → 正常形态不记；163 不能行军 → 当日拉黑；
 *   **159 目标点不存在 → 拉黑该点（店则从锚点表剔除）**；**141 请先上平台 → 本拍改选平台**；
 *   **142/209/252 平台不在同区/同区互挪/已被占 → 拉黑该平台**；17 战场封闭 → 本场停手。
 *
 * ═══ v3.1：把竞品B 的九处业务判据补齐（G1–G9，与竞品同逻辑）═══
 *   G1 战败自动复活：21521 落地时 `deadType==1 && dataConfig(3056) > reviveNum` → 8552 `{uid}`（L25320）；
 *   G2 打野档 + 跟人档：`marchBeast(4)`（品质闸来自 scout.js 情报账）与 `marchTeam()`（最近已有驻军/在途指向的 172/173）；
 *   G3 回合开门闸：`enigma_secret_realm[esrId].roundid → enigma_secret_realm_timer.start`，未到 `fightBegin+start` 的点不算候选（L24729）；
 *   G4 别人在途的行军指向点不算候选（`marchList[].state==1`，`march_policy==1` 时不查，L24747）；
 *   G5 「香肠不在架就刷店」在 shop.js（本文件只提供账本写入口）；
 *   G6 `shopStage` 时间语义：开台前 0~120s 禁店、开台后 120~180s（拍宠高光期）把到店间隔从 8min 砍到 2min（L24576）；
 *   G7 `exitStage` 三级判据（百兽箱 piece / +BOSS 已死 / +背包拿满）+ 每店 `time/sausage/piece` 账本，选店先选「没买过香肠」的（L24843）；
 *   G8 读秒过期但没上平台 → 仍认窗口（改出 `lead` 去上平台，而不是把整场 BOSS 让掉，L24926）；
 *   G9 `guard_policy` 过滤 + 到场打过即记账（`state.boss[bossId]=1`，L25317），巡航的 BOSS 引力锚恒取「第一个无石头记录的 BOSS」。
 *
 * 只读 + 发包红线：全程只读 ACL 快照与配置表；写动作只有 `sendMarch`（8521）与 8552 复活（战败自救，面板可关）；901 是只读查询。
 * 仅队长发车（8521 驱动队级那一条行军）。触发：单条 createCycle + kick 源 21534/21529/21521/21535/901 应答。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import { tileKey as utilTileKey, dist as utilDist } from './util.js';
import {
  CMD_MARCH_MOVE,
  CMD_REVIVE,
  PUSH_SELF_ATTACKED,
  PUSH_TILE_INFO,
  PUSH_BASE_INFO,
  PUSH_BOSS_STATE,
  PUSH_TEAM_ARRIVE,
  PUSH_RESOURCE_CHANGE,
  PUSH_DROP_CHANGE,
  PAB_SHOP,
  PAB_DROP,
  PAB_MONSTER,
  PAB_RESOURCE,
  PAB_COMMON_PLANE,
  PAB_TENT,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  ST_NORMAL,
  ST_PVP_READY,
  ST_PVP_FIGHTING,
  ST_BOSS_FIGHTING,
  ST_PLANE_MARCH,
  ST_BOSS_FEED,
  ST_BOSS_FIGHTING_END,
  ST_BOSS_DEAD_END,
  REJ_ALREADY_THERE,
  REJ_NO_MARCH_TARGET,
  REJ_BATTLEFIELD_CLOSING,
  REJ_POINT_NOT_EXIST,
  REJ_NEED_PLANE,
  REJ_BOSS_AREA,
  REJ_PLANE_TAKEN,
  REJ_SAME_AREA_PLANE,
  CODE_NOT_SENT,
  TABLE_BUILDING,
  TABLE_ITEM,
  TABLE_TIMER,
  TABLE_REALM,
  TABLE_RSS_STATION,
  ITEM_SAUSAGE,
  ITEM_BANDAGE,
  ITEM_MEDKIT,
  CFG_REVIVE_LIMIT,
  tuning,
} from './constants.js';

/** @type {string} 档位名：BOSS 邻域平台（被拒时只黑平台、不黑 BOSS 本体） */
const KIND_BOSS_PLANE = 'boss-plane';

/** @type {string} 持有清单行 key 的道具维度前缀（`item:{itemId}`，与 index.js/pickup.js/shop.js 同口径） */
const KEY_ITEM = 'item:';

/**
 * 需要进快照的点型（其余点型与方向盘无关）。
 * @type {Object<number,1>}
 */
const TRACKED_PT = {};
[
  PAB_SHOP,
  PAB_DROP,
  PAB_MONSTER,
  PAB_RESOURCE,
  PAB_COMMON_PLANE,
  PAB_TENT,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
].forEach(function (pt) {
  TRACKED_PT[pt] = 1;
});

/**
 * 点位键（与 boss.js/warn.js/scout.js 同口径的本地小工具；非法坐标回 ''）。
 * @param {number} x 横号
 * @param {number} y 纵号
 * @returns {string}
 */
function tileKey(x, y) {
  return utilTileKey(x, y, true);
}

/**
 * 欧氏格距（与竞品 `helper.tools.distance` 同一把尺子；v2 同款）。
 * @param {number} ax 起点 x
 * @param {number} ay 起点 y
 * @param {number} bx 终点 x
 * @param {number} by 终点 y
 * @returns {number}
 */
function dist(ax, ay, bx, by) {
  return utilDist(ax, ay, bx, by);
}

/**
 * Int64 / `{_low,_high}` / number / 字符串 → 数值，统一委托 bits.int64ToNum
 *   （含裸 {_low,_high} POJO 拼装分支，与 boss/scout/heal/leave/capture 同口径），
 *   再补一道非有限值归 0（bits 对 number 入参原样返回，可能带 NaN/Infinity）。
 * 注：主要用于时间戳等 <2^53 量纲；64 位 id（teamId/callTId）也经本函数化整（见 631/1390 行），超过 2^53 会按 double 截断，
 *   但比较双方同走本函数、同表口径，截断后仍一致（只求同源相等、不求全局唯一）；需逐位严格区分的场景应改走 bits.int64Str/int64Decimal 字符串口径。
 * @param {*} v 原值
 * @returns {number} 取不到回 0
 */
function toNum(v) {
  const n = bits.int64ToNum(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 点型是否 BOSS 相关（177 BOSS 本体 / 178 小BOSS / 176 BOSS 平台）——停在这些点上时方向盘让给 boss.js。
 * @param {number} pt 点型
 * @returns {boolean}
 */
function isBossish(pt) {
  return pt === PAB_BOSS || pt === PAB_BOSS_GUARD || pt === PAB_BOSS_PLANE;
}

/**
 * 竞品B 的「读秒窗」判据复用三次的形：`abs(stateEndTime - now - base) < win`（毫秒）。
 *   `shopStage` 用 (60000,60000) 禁店、用 (150000,30000) 认高光窗、`marchBeast`/`beastStage` 用 (90000,90000)。
 * @param {number} end 读秒结束绝对毫秒
 * @param {number} now 当前毫秒
 * @param {number} base 基准偏移（毫秒）
 * @param {number} win 窗半宽（毫秒）
 * @returns {boolean}
 */
function inOffsetWindow(end, now, base, win) {
  if (!(end > 1e11)) return false;
  return Math.abs(end - now - base) < win;
}

/**
 * 数「还有多少人能来拿」：条目 `uid` 为空 = 空闲（21522/21532 载荷同口径）。
 * @param {Array|null} arr 条目数组
 * @returns {number}
 */
function freeCount(arr) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it) continue;
    if (it.uid == null || it.uid === '' || toNum(it.uid) === 0) n++;
  }
  return n;
}

/**
 * 从 CHANGE 推送事件里取业务体（游戏 PushResponse 的转译层；非 0 状态包游戏不发，我们也跳过）。
 * @param {object} ev bus 事件
 * @returns {object|null}
 */
function changeBody(ev) {
  const d = ev && ev.data;
  if (!d) return null;
  const inner = d.data && typeof d.data === 'object' ? d.data : d;
  if (!inner || typeof inner !== 'object') return null;
  if (inner.x == null || inner.y == null) return null;
  return inner;
}

export class PilotEngine {
  #env;
  /** @type {{kick:Function}|null} */
  #cycle = null;
  /** @type {boolean} 引擎存活位 */
  #active = false;

  // ── S0 数据层 ────────────────────────────────────────────────────────
  /**
   * @type {Map<string,{k:string,pt:number,x:number,y:number,state:number,sET:number,isFight:number,
   *   esrId:number|null,teams:number,callTId:number,rTime:number,iNum:number|null,at:number,src:string}>}
   * 点位快照：**10018 push ∪ 901 主动视口**（`src` 区分 `p`/`v`，v 覆盖 p）。本引擎唯一的目的地料源。
   */
  #tiles = new Map();
  /**
   * @type {Array<{x:number,y:number}>} 四个商店的**权威坐标**（表 `enigma_secret_realm_building`
   *   `build_type===3 && group===#group` 的 `coords` 拆分）。与镜头位置完全无关 → 商店档永远有候选。
   */
  #shops = [];
  /**
   * @type {Map<string,{time:number,sausage:number,piece:number,visited:number,sausageShelf:number}>}
   * 每店账本（点位键 → 竞品 `state.shops[]` 同形）：
   *   `time`=最近一次到店（毫秒，定期轮巡与 3s 去重基准）、`sausage`/`piece`=该店货单上香肠/百兽箱货位的
   *   `getTime`（已购次数，>0 = 这家已经买过）。**跨场保留**（竞品 `this.save()` 落盘、只在 length==0 时重建），
   *   因为百兽箱是 type3 全场共享额度，换场不会把已买记录洗掉。
   *   我方额外两字段（竞品没有访问记忆，靠 `cd_time.march` 全局锁就够了；我方把去店理由改到链尾兜底后
   *   必须自己防「每拍敲同一家」）：`visited`=真到店服务过（0=锚点建账时播的初值，不吃 revisit 闸）；
   *   `sausageShelf`=本次货单上到底有没有香肠货位（1/0，供 #shopAllTried 判「已知不卖」）。
   */
  #shopLedger = new Map();
  /** @type {number} 锚点装载时刻（0=未装；group 变了或为空且过期才重装） */
  #shopsAt = 0;
  /** @type {number} 当前房间分组（`roomBaseInfo.group`，缺失回退 `myTeam.group`） */
  #group = 0;
  /** @type {number} 最近一次 901 的**发起**时刻（节流基准） */
  #viewAt = 0;
  /** @type {boolean} 901 在途 */
  #viewBusy = false;
  /** @type {number} 901 连续无应答次数（达 tuning.driveViewOffAfter 即降级） */
  #viewMiss = 0;
  /** @type {boolean} 901 判定不可用（降级为 push+锚点；driveViewRetryMs 后重试） */
  #viewOff = false;
  /** @type {object|null} 最近一刀 901 的诊断面（只读，不参与判定） */
  #viewDbg = null;
  /**
   * @type {Set<string>} 最近一刀 901 里**在途行军（state==1）指向的点键**（G4：竞品 `marchList.find(state==1)` 同款）。
   *   本引擎自己那笔也算在内（在途时本就处 TO 相位不重评，不伤判定）；`march_policy==1`（跟队派）时不参与过滤。
   */
  #viewMarch = new Set();
  /** @type {number} `#viewMarch` 的采集时刻（毫秒）；超过 `driveMarchStaleMs` 未刷新就不参与 G4 过滤（防 901 掉线后集合永久毒化） */
  #viewMarchAt = 0;

  // ── S1 阶段层（本拍缓存，仅诊断）─────────────────────────────────────
  /** @type {string} 本拍阶段名：realm-closed/to/work/boss-open/boss-lead/shop/cruise/explore/hold */
  #stage = '';
  /** @type {string} 本拍阶段附注（比如 `shop:sausage`） */
  #stageWhy = '';

  // ── S2 动作层 ────────────────────────────────────────────────────────
  /** @type {string} 在途相位标记（''=空闲；否则 `kind|(x,y)`） */
  #toKind = '';
  /** @type {string} 在途目标键 */
  #toXY = '';
  /** @type {string} 在途档位名（`cruise`/`shop`/`boss`/`boss-plane`/`evade`/`return`/`explore`；被拒处置按它分流） */
  #toTag = '';
  /** @type {number} 本笔 8521 发出时刻 */
  #toAt = 0;
  /** @type {Map<string,number>} 已派过车的点 → 解禁时刻（driveMarchedTtlMs，竞品 marched_list 同源） */
  #marched = new Map();
  /** @type {Map<string,number>} 消费账：点位键 → 解禁时刻（driveConsumedTtlMs） */
  #consumed = new Map();
  /** @type {Object<string,1>} 当日/本场拉黑的点（163 不能行军 / 159 点不存在 / 平台被占） */
  #dayBlack = {};
  /** @type {number} 被拒退避截止时刻 */
  #cooldownUntil = 0;
  /** @type {boolean} 战场已封闭（服务端 `enigma_realm17`）→ 本场停手，换场自动解开 */
  #realmClosed = false;
  /** @type {number} 当前场 fightBeginTime（毫秒）；变化即换场复位 */
  #matchFightBegin = 0;
  /** @type {number} 最近一次到店（或派车去店）的时刻（商店定期轮巡基准） */
  #shopLastAt = 0;
  /**
   * @type {number} 商店档的**去重/惩罚冷却截止**（毫秒）。
   *   到店时置 `now + max(3000, driveShopStayMs)`（竞品的 `shops[].time*1000+3000` 同点去重 + `shop_stay_time` 路由锁取大者）；
   *   但若到店后**四家店都已试过**（都买到过香肠，或已知不卖）却仍缺料 → 置 `now + driveShopGapCooldownMs` 长冷却，
   *   否则会形成「缺口在 → 每拍开回店」的烧油永动。
   *   ⚠ 本冷却不拦 `exit`（该收场了）档——收场车只拿货、不吃永动风险，见 #shopWant 里的顺序。
   */
  #shopCoolUntil = 0;
  /** @type {string} 最近一次 #shopWant 给出的理由（''=不去店；链尾兜底选店排序与诊断用） */
  #lastShopWhy = '';
  /** @type {boolean} 大BOSS 前定点商店勤务本场是否已办 */
  #shopErrandDone = false;
  /** @type {number} 本场计时基准（= fightBeginTime；缺失时退化为引擎首拍时刻，见 #elapsedSec） */
  #matchStartAt = 0;
  /** @type {number} 无候选静默起点（0=本拍有候选/已派车） */
  #idleSince = 0;
  /** @type {number} 探索方向轮转（0..7 扇区） */
  #exploreSpin = 0;
  /** @type {number} 通道在途闸（`isSecretSending(8521)`）连续为真的起始时刻 */
  #inflightStuckSince = 0;
  /** @type {boolean} 21534 存活威胁位 */
  #threat = false;
  /** @type {{x:number,y:number,pt:number,esrId:number|null}|null} 逃袭前的停泊现场（回攻需求源） */
  #escapeFrom = null;
  /** @type {boolean} 回攻待办 */
  #returnPending = false;
  /**
   * @type {Object<number,1>} 本场已到场打过的 BOSS（竞品 `state.boss[bossId]=1`，在
   *   `onPabRoomBaseInfoChange` 里用 `targetPoint` 对上 `bossBaseInfo[].pos` 记账，供 `guard_policy==2` 过滤）。
   */
  #bossDone = {};
  /** @type {number} 上次发 8552 复活的时刻（毫秒，driveReviveGapMs 基准） */
  #lastReviveAt = 0;
  /** @type {boolean} 8552 在途（防同一次死亡反复消耗复活次数） */
  #reviveInFlight = false;

  // ── S3 到点层 ────────────────────────────────────────────────────────
  /** @type {string} WORK 退出模式：''=不在 WORK；'empty'=拿空即走；'dwell'=固定驻留 */
  #workMode = '';
  /** @type {number} 固定驻留截止时刻 */
  #workUntil = 0;
  /** @type {number} 拿空计时起点 */
  #workEmptyAt = 0;
  /** @type {number} 拿空兜底强制离点截止时刻 */
  #workDeadline = 0;
  /** @type {Map<string,{kind:string,bagFree:number,buffFree:number,dropFree:number,beastFree:number,at:number}>} */
  #change = new Map();

  // ── 诊断面（不参与任何判定）─────────────────────────────────────────
  /** @type {number} */
  #ticks = 0;
  /** @type {number} */
  #lastTickAt = 0;
  /** @type {string} */
  #lastBranch = '';
  /** @type {Object<string,number|string>} */
  #gateNow = {};
  /** @type {string} */
  #lastDispatch = '';
  /** @type {object|null} 最近一次选点的筛除计数 */
  #pickDbg = null;
  /** @type {Object<string,1>} 已打过的 info 提示键 */
  #told = {};

  /** @param {object} env 注入底座 {alive, realmActive, cfg, secret, gameConf, l10n, log} */
  constructor(env) {
    this.#env = env;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 推送落地（只记账 + kick；业务态一律重读 ACL / 主动查询）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * push 21534 攻击警告：num>0 置威胁并 kick；num=0 清威胁（实证「转移即消警」）。
   * @param {object} ev bus 事件
   */
  onWarnPush(ev) {
    const d = (ev && ev.data && ev.data.data) || {};
    const num = Number(d.num) || 0;
    if (num > 0) {
      this.#threat = true;
      if (this.#cycle) this.#cycle.kick();
    } else {
      this.#threat = false;
    }
  }

  /** push 21529/21521：只 kick（到达最终判据是 `startPoint` 复核，不信事件时序）。 */
  onArriveWake() {
    if (!this.#env.alive()) return;
    if (this.#cycle) this.#cycle.kick();
  }

  /**
   * push 21521 BASE_INFO 落地（竞品 `onPabRoomBaseInfoChange` 的三个动作我方对应两个）：
   *   ① G9 记账：`targetPoint` 对上某个 BOSS → 记「这个 BOSS 我已到场打过」（`state.boss[bossId]=1`），
   *      供 `guard_policy==2` 以同一口径排除重复目标；
   *   ② G1 自救：`deadType===1` 且 `dataConfig(3056) > reviveNum` → 发 8552 `{uid}`（战败不复活 =
   *      `teamIsMooring()` 永不成立 → 本引擎卡在 not-moored 直散场，是实机「不开车」的真因之一）。
   *      竞品随后还调 `jumpToTarget(startPoint)` 拉镜头——**我方不需要**：候选池靠 901 主动拉，不依赖镜头扫过。
   *   只读 + 发包红线：8552 是写动作，所以受面板 `driveRevive` 子闸与 `driveReviveGapMs` 限速双重约束。
   * @param {object} ev bus 事件（载荷仅作 base 读不到时的兼容路径）
   */
  onBasePush(ev) {
    const env = this.#env;
    if (!env.alive()) return;
    const base = env.secret.getRoomBaseInfo();
    if (base) {
      // ① G9：到场打过的 BOSS 记账（逐字对齐竞品的 pos 全等比对）
      const tp = base.targetPoint;
      if (tp) {
        const list = env.secret.getBossBaseInfo();
        if (Array.isArray(list)) {
          const tx = Math.floor(toNum(tp.x));
          const ty = Math.floor(toNum(tp.y));
          for (let i = 0; i < list.length; i++) {
            const s = list[i];
            if (!s || !s.pos) continue;
            if (Math.floor(toNum(s.pos.x)) === tx && Math.floor(toNum(s.pos.y)) === ty) {
              const bid = Number(s.bossId) || 0;
              if (bid && !this.#bossDone[bid]) {
                this.#bossDone[bid] = 1;
                env.log.info('pilot: BOSS %d 已到场，计入跳过账（guard_policy 口径）。', bid);
              }
              break;
            }
          }
        }
      }
    }
    // ② G1：战败自动复活
    this.#maybeRevive(base, ev);
    if (this.#cycle) this.#cycle.kick();
  }

  /**
   * G1 的复活判据与发包（deadType/reviveNum 优先读 `roomBaseInfo`，缺字段再读 push 载荷）。
   * @param {object|null} base roomBaseInfo
   * @param {object} ev bus 事件
   */
  #maybeRevive(base, ev) {
    const env = this.#env;
    const dv = env.cfg().drive || {};
    if (dv.revive === false) return; // 面板关了 → 完本交给人（复活会消耗本场次数，不越权替用户花）
    if (this.#reviveInFlight) return;
    const now = Date.now();
    if (now - this.#lastReviveAt < tuning.driveReviveGapMs) return;
    const src =
      (ev && ev.data && typeof ev.data === 'object' ? ev.data.data || ev.data : null) || null;
    const deadType = Number(
      (base && base.deadType != null ? base.deadType : src && src.deadType) || 0,
    );
    if (deadType !== 1) return; // 1 = 战败待复活（竞品 verbatim）
    let limit = 0;
    try {
      limit = Number(env.gameConf.dataConfig(CFG_REVIVE_LIMIT)) || 0;
    } catch (e) {
      limit = 0;
    }
    if (!(limit > 0)) return; // 读不到上限 → 不盲目消耗次数（闭开）
    const reviveNum = Number(
      (base && base.reviveNum != null ? base.reviveNum : src && src.reviveNum) || 0,
    );
    if (!(limit > reviveNum)) return; // 次数已用尽
    const me = env.gameData && env.gameData.myUidStr ? env.gameData.myUidStr() : '';
    if (!me) return;
    this.#reviveInFlight = true;
    this.#lastReviveAt = now;
    const self = this;
    env.secret
      .sendSecret(CMD_REVIVE, { uid: me })
      .then(function (r) {
        self.#reviveInFlight = false;
        if (!env.alive()) return;
        const code = r && r.code;
        if (code === CODE_NOT_SENT || code == null) {
          self.#lastReviveAt = 0; // 未上线（频控/超时）→ 下拍可重评，不白占限速窗
          return;
        }
        env.log.info(
          'pilot: 战败已发 8552 复活（第 %d/%d 次，code=%s）。',
          reviveNum + 1,
          limit,
          String(code),
        );
      })
      .catch(function (e) {
        self.#reviveInFlight = false;
        env.log.debug('pilot: 8552 复活抛出：%s', (e && e.message) || e);
      });
  }

  /**
   * G7 账本写入口（由 shop.js 在 8540/8542/8543 应答后回调）：记本店的 `time/sausage/piece`。
   *   竞品在 `onPabRoomShopDataUpdate` 里用应答 items 反查表回写同名字段（L25294），语义一致：
   *   `sausage`/`piece` = 该货位的 `getTime`（已购次数），`time` = 本次服务时刻。
   *   写 time 即视为「这家真被服务过」（`visited=1`），锚点建账时播的初值不会误开 revisit 闸。
   * @param {string} key 点位键 `x,y`
   * @param {{time?:number,sausage?:number,piece?:number,sausageShelf?:number}} patch 只写传入的字段
   */
  markShopLedger(key, patch) {
    if (!key) return;
    const p = patch || {};
    const cur = this.#shopLedger.get(key) || {
      time: 0,
      sausage: 0,
      piece: 0,
      visited: 0,
      sausageShelf: 0,
    };
    if (p.time != null) {
      cur.time = Number(p.time) || 0;
      cur.visited = 1; // 真到店服务过（区别于 #syncAnchors 播的建账初值）
    }
    if (p.sausage != null) cur.sausage = Number(p.sausage) || 0;
    if (p.piece != null) cur.piece = Number(p.piece) || 0;
    if (p.sausageShelf != null) cur.sausageShelf = Number(p.sausageShelf) ? 1 : 0;
    this.#shopLedger.set(key, cur);
  }

  /**
   * push 10018 落地：写快照、**不 kick**（3 条/秒，kick 会把兜底拍打成 3Hz）。
   * @param {object} ev bus 事件（`ev.data.pointInfos = [{x,y,pointType,m}]`）
   */
  onTilePush(ev) {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    const list = Array.isArray(d.pointInfos) ? d.pointInfos : null;
    if (!list) return;
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const pt = Number(p.pointType) || 0;
      if (!TRACKED_PT[pt]) continue;
      this.#putTile(p, pt, now, 'p');
    }
  }

  /**
   * push 21522 资源点变动：按点记剩余空闲数（bag/buff）。
   * @param {object} e 业务体
   */
  onResChange(e) {
    if (!e) return;
    const k = tileKey(e.x, e.y);
    if (!k) return;
    this.#change.set(k, {
      kind: 'res',
      bagFree: freeCount(e.bagInfo),
      buffFree: freeCount(e.buffInfo),
      dropFree: 0,
      beastFree: 0,
      at: Date.now(),
    });
    if (this.#workMode === 'empty' && k === this.#toXY && this.#cycle) this.#cycle.kick();
  }

  /**
   * push 21532 掉落箱变动：按点记剩余空闲数（drop/beast）。
   * @param {object} e 业务体
   */
  onDropChange(e) {
    if (!e) return;
    const k = tileKey(e.x, e.y);
    if (!k) return;
    this.#change.set(k, {
      kind: 'drop',
      bagFree: 0,
      buffFree: 0,
      dropFree: freeCount(e.dropInfo),
      beastFree: freeCount(e.dropBeastInfo),
      at: Date.now(),
    });
    if (this.#workMode === 'empty' && k === this.#toXY && this.#cycle) this.#cycle.kick();
  }

  // ══════════════════════════════════════════════════════════════════════
  // S0 数据层
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 归一并写入一个点位（`src`：`p`=10018 push / `v`=901 主动视口）。
   *   901 的点位是**实时真相**，覆盖 push 的旧值；反之 push 不得覆盖 v 的新值（`at` 更早则跳过）。
   * @param {object} p 原始点位（10018 或 901 pointList 元素）
   * @param {number} pt 点型（0=从载荷里取）
   * @param {number} now 毫秒
   * @param {string} src 来源标记
   */
  #putTile(p, pt, now, src) {
    const x = Math.floor(toNum(p.x));
    const y = Math.floor(toNum(p.y));
    const k = tileKey(x, y);
    if (!k) return;
    const m =
      (p.m && typeof p.m === 'object' ? p.m : null) ||
      (p.extData && typeof p.extData === 'object' ? p.extData : {}) ||
      {};
    const type = pt || Number(p.pointType != null ? p.pointType : m.type) || 0;
    if (!TRACKED_PT[type]) return;
    const prev = this.#tiles.get(k);
    if (this.#tiles.size >= tuning.tileExtMax && !prev) {
      const first = this.#tiles.keys().next();
      if (!first.done) this.#tiles.delete(first.value);
    }
    const esr = m.esrId == null ? null : Number(m.esrId);
    this.#tiles.set(k, {
      k: k,
      pt: type,
      x: x,
      y: y,
      state: Number(m.state) || 0,
      sET: toNum(m.sET),
      isFight: Number(m.isFight) || 0,
      // 162/175 等 esrId 恒 0 的型别：0 不算区域证据（与 boss.js 同口径，防「同区域」误判）
      esrId: esr == null || Number.isNaN(esr) || esr === 0 ? null : esr,
      teams: Array.isArray(m.teams) ? m.teams.length : Number(m.teams) || 0,
      // 到点判空/选点收益的两个字段：173 抽空 → rTime 是未来刷新时刻；163/173 余量 → iNum
      rTime: toNum(m.rTime),
      iNum: m.iNum == null ? null : Number(m.iNum) || 0,
      // 172 野怪已被哪一队号召集结（竞品 marchBeast 的 `!callTId || callTId == myTeamId` 闸：别人的集结兽不抢）
      callTId: m.callTId == null ? 0 : toNum(m.callTId),
      at: now,
      src: src,
    });
  }

  /**
   * 装锚点：**商店坐标读表**（`enigma_secret_realm_building`，`build_type===3 && group===本房间`，`coords="x,y"`）。
   *   这是 v3 与 v2 的分水岭之一：四个商店是固定建筑，坐标与镜头无关，表里就有。
   *   源码两处交叉证实用法（PabWorldUINew.initMiniMapBuildingItem / 竞品B onPabRoomBaseInfoChange）。
   *   空表/读不到时 5s 后重试（表在进图后才下发）。
   * @param {object} base roomBaseInfo
   */
  #syncAnchors(base) {
    const env = this.#env;
    const now = Date.now();
    const pab = env.secret.getPabController();
    const g = Number(base && base.group) || Number(pab && pab.myTeam && pab.myTeam.group) || 0;
    const need = !this.#shops.length || (g > 0 && g !== this.#group);
    if (!need) return;
    if (this.#shopsAt && now - this.#shopsAt < 5000) return;
    this.#shopsAt = now;
    this.#group = g;
    let rows;
    try {
      rows = env.l10n.tableRows(TABLE_BUILDING) || [];
    } catch (e) {
      rows = [];
    }
    if (!rows.length) {
      this.#note(
        'no-building-table',
        'pilot: 建筑表 enigma_secret_realm_building 尚未下发，商店锚点待重试。',
      );
      return;
    }
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || Number(r.build_type) !== 3) continue;
      if (g > 0 && Number(r.group) !== g) continue;
      const parts = String(r.coords || r.coord || '').split(',');
      const x = Math.floor(Number(parts[0]));
      const y = Math.floor(Number(parts[1]));
      if (!(x > 0) || !(y > 0)) continue;
      out.push({ x: x, y: y });
    }
    if (!out.length) {
      this.#note(
        'no-shop-anchor',
        'pilot: 建筑表里没有本组(build_type=3, group=' + g + ')的商店行，商店档退回视口 161。',
      );
      return;
    }
    this.#shops = out;
    // G7 竞品 onPabRoomBaseInfoChange 建 state.shops 时把 `time` 播成当前时刻（ServerTime，秒）
    //   → 开场首轮巡的计时基准是「建账那一刻」，而不是 0（否则 gap 恒为天文数字，一进场就直奔商店）。
    const sec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < out.length; i++) {
      const sk = tileKey(out[i].x, out[i].y);
      if (sk && !this.#shopLedger.has(sk)) {
        // visited=0：只用于 #shopStageWant 的全局 gap 基准，不参与 #pickShop 的 revisit 闸（否则开局 8min 进不了任何店）
        this.#shopLedger.set(sk, { time: sec, sausage: 0, piece: 0, visited: 0, sausageShelf: 0 });
      }
    }
    env.log.info('pilot: 商店锚点已装载 %d 个（group=%d）→ %s', out.length, g, JSON.stringify(out));
  }

  /**
   * 主动拉视口（v3 的地基）：以 (cx,cy) 为中心发 901，拿回 20×30 格的点位与行军，并入 `#tiles`。
   *   节流 `tuning.driveViewMs`(3s)；失败达 `driveViewOffAfter` 次即降级（`driveViewRetryMs` 后重试）。
   *   注意：这是**异步**的，本拍决策可能还看不到新点位 → 调用方在「无候选」时应给一拍短睡眠等 kick。
   * @param {number} cx 中心 x
   * @param {number} cy 中心 y
   * @param {boolean} [force=false] 忽略节流（换了中心点时用）
   */
  #refreshView(cx, cy, force) {
    const env = this.#env;
    const now = Date.now();
    if (this.#viewBusy) return;
    const gap = this.#viewOff ? tuning.driveViewRetryMs : tuning.driveViewMs;
    if (!force && now - this.#viewAt < gap) return;
    if (!(cx > 0) || !(cy > 0)) return;
    this.#viewAt = now;
    this.#viewBusy = true;
    const self = this;
    env.secret
      .queryWorldView(cx, cy, { width: 20, height: 30, viewLevel: 1 })
      .then(function (v) {
        self.#viewBusy = false;
        if (!env.alive()) return;
        if (!v) {
          self.#viewMiss++;
          self.#viewDbg = { at: now, ok: false, miss: self.#viewMiss, center: cx + ',' + cy };
          if (!self.#viewOff && self.#viewMiss >= tuning.driveViewOffAfter) {
            self.#viewOff = true;
            env.log.warn(
              'pilot: 901 GET_WORLD_INFO 连续 %d 次无应答 → 判定主动视口不可用，降级为 push+锚点模式（商店/BOSS 仍可开，巡航退回 push+探索）。%ds 后重试。',
              self.#viewMiss,
              Math.round(tuning.driveViewRetryMs / 1000),
            );
          }
          return;
        }
        self.#viewMiss = 0;
        if (self.#viewOff) {
          self.#viewOff = false;
          env.log.info('pilot: 901 主动视口已恢复。');
        }
        const pts = Array.isArray(v.points) ? v.points : [];
        const t1 = Date.now();
        const byPt = {};
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (!p) continue;
          const pt = Number(p.pointType) || 0;
          self.#putTile(p, pt, t1, 'v');
          if (TRACKED_PT[pt]) byPt[pt] = (byPt[pt] || 0) + 1;
        }
        // G4 竞品 `march_policy == 1 || !marchList.find(target==该点 && state==1)` 的数据源：
        //   本刀视口里**所有在途行军指向的点**（含我们自己那笔——在途时本就足 TO 相位不重评，不伤判定）。
        const ms = Array.isArray(v.marches) ? v.marches : [];
        const vm = new Set();
        for (let i = 0; i < ms.length; i++) {
          const m = ms[i];
          if (!m || Number(m.state) !== 1) continue;
          const mk = tileKey(m.tx, m.ty);
          if (mk) vm.add(mk);
        }
        self.#viewMarch = vm;
        self.#viewMarchAt = t1;
        self.#viewDbg = {
          at: t1,
          ok: true,
          center: cx + ',' + cy,
          points: pts.length,
          marches: ms.length,
          marchIn: vm.size,
          byPt: byPt,
        };
        // 拉到新点：本拍可能正睡在兜底拍上，踢一脚让决策立刻重跑
        if (self.#cycle) self.#cycle.kick();
      })
      .catch(function (e) {
        self.#viewBusy = false;
        self.#viewMiss++;
        env.log.debug('pilot: 901 threw: %s', (e && e.message) || e);
      });
  }

  /**
   * G3 回合开门闸（竞品 marchResource/marchBeast/scoutBeast 三处 verbatim 同一个 `r(esrId)`）：
   *   `enigma_secret_realm[esrId].roundid → enigma_secret_realm_timer[roundid].start`，
   *   `本场开战秒 + start` 之后该区域的点才算「已刷出来」。
   *   没区域证据（esrId 缺失/为 0）或表行读不到一律当**未开门**（闭开：宁可不派车，也不去摸一个未刷的点）。
   * @param {number|null} esrId 点位所属区域行 id
   * @returns {boolean}
   */
  #roundOpen(esrId) {
    const rid = Number(esrId) || 0;
    if (!(rid > 0)) return false;
    const begin = this.#matchStartAt;
    if (!(begin > 1e11)) return false;
    const env = this.#env;
    let timer;
    try {
      const realm = env.l10n.tableRow(TABLE_REALM, rid);
      const round = realm ? Number(realm.roundid) || 0 : 0;
      timer = round > 0 ? env.l10n.tableRow(TABLE_TIMER, round) : null;
    } catch (e) {
      timer = null;
    }
    if (!timer) return false;
    const start = Number(timer.start) || 0;
    return Math.floor(Date.now() / 1000) > Math.floor(begin / 1000) + start;
  }

  /**
   * G4 行军指向过滤：竞品 `march_policy == 1 || !marchList.find(...state==1)`——
   *   `march_policy==1`（跟队派）时不查在途（本来就要往有人的地方扎）；901 不可用/无在途 → 集合为空自然放行。
   * @param {number} x 候选点 x
   * @param {number} y 候选点 y
   * @returns {boolean} true=被别人的在途行军占了，不算候选
   */
  #marchBlocked(x, y) {
    if (Number(tuning.driveMarchPolicy) === 1) return false;
    if (!this.#viewMarch.size) return false;
    // 901 降级/长时间没刷 → 集合是旧快照，拿它拦人会把所有点都判成「别人在途」（一锁锁死）
    if (Date.now() - this.#viewMarchAt > (Number(tuning.driveMarchStaleMs) || 15000)) return false;
    const k = tileKey(x, y);
    return !!k && this.#viewMarch.has(k);
  }

  /** 是否有一个 BOSS 正处于 state23（开台读秒中）——竞品日常链的让路闸。 */
  #bossFeeding() {
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return false;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].state) === ST_BOSS_FEED) return true;
    }
    return false;
  }

  /**
   * 竞品 `marchBeast` 开头的禁走窗 verbatim：任一 BOSS state22 且 `|end - now - 90s| < 90s`（读秒结束后
   *   0~180s）→ 这段路留给拍宠与平台，不派车去野怪点。窗宽取 `driveBeastNoMarchMs / 2`（默认 180s ⇒ 90s/90s）。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #beastLockNow(now) {
    const half = Math.round((Number(tuning.driveBeastNoMarchMs) || 180000) / 2);
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return false;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || Number(s.state) !== ST_PLANE_MARCH) continue;
      if (inOffsetWindow(toNum(s.stateEndTime), now, half, half)) return true;
    }
    return false;
  }

  /**
   * 竞品 `beastStage` verbatim 的补给/状态闸（我方只把它用于「日常链走宽松档还是严格档」）。
   *   前置：任一店账本 `piece>0`（本组已买到过百兽箱）；否则不构成百兽期。
   *   `team_type==0` 直接为真；否则「所有 BOSS 都已 28/30 终局」为真，再否则过一长串备货闸：
   *   41002/41003 达到面板目标（面板未配 = 无要求）、香肠 ≥ `driveSausageTarget`、已装增益里
   *   至少 3 个 5 色（rss_station.buff_color）、背包高品质未拿满、且不在开台读秒后 0~180s 窗内。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #beastStageWant(now) {
    const env = this.#env;
    let boxGot = false;
    this.#shopLedger.forEach(function (v) {
      if (v && Number(v.piece) > 0) boxGot = true;
    });
    if (!boxGot) return false;
    if (!(Number(tuning.driveTeamType) || 0)) return true;
    const list = env.secret.getBossBaseInfo();
    if (!Array.isArray(list) || !list.length) return true;
    let anyActive = false;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s) continue;
      const st = Number(s.state) || 0;
      if (st !== ST_BOSS_DEAD_END && st !== ST_BOSS_FIGHTING_END) {
        anyActive = true;
        break;
      }
    }
    if (!anyActive) return true; // 竞品 `!bossBaseInfo.find(state!=28 && state!=30)`
    if (this.#beastLockNow(now)) return false;
    const items = env.cfg().pickItems || {};
    const probes = [ITEM_BANDAGE, ITEM_MEDKIT];
    for (let i = 0; i < probes.length; i++) {
      const id = probes[i];
      const row = items[KEY_ITEM + id];
      const target = row ? Number(row.max) || 0 : 0;
      if (!(target > 0)) continue; // 面板未配该项 = 竞品口径的 999999（无要求）
      if (env.secret.getItemNumById(id) < target) return false;
    }
    if (env.secret.getItemNumById(ITEM_SAUSAGE) < (Number(tuning.driveSausageTarget) || 10)) {
      return false;
    }
    const c5 = this.#buffColor5Count();
    if (c5 >= 0 && c5 < 3) return false;
    if (typeof env.petPackFull === 'function' && env.petPackFull()) return false;
    return true;
  }

  /**
   * 已装增益里的 5 色个数（竞品 `roomBaseInfo.buffMap` 逐项查 `enigma_secret_realm_rss_station.buff_color==5`）。
   *   表行读不到（buff_color 字段未实证）时回 -1 = **不参与判定**（宁可不拦，也不把整条链锁死）。
   * @returns {number}
   */
  #buffColor5Count() {
    const env = this.#env;
    const base = env.secret.getRoomBaseInfo();
    const bm = base && base.buffMap;
    if (!bm || typeof bm !== 'object') return 0;
    const keys = Object.keys(bm);
    let n = 0;
    let unreadable = 0;
    for (let i = 0; i < keys.length; i++) {
      const specId = toNum(bm[keys[i]]);
      if (!(specId > 0)) continue;
      let row;
      try {
        row = env.l10n.tableRow(TABLE_RSS_STATION, specId);
      } catch (e) {
        row = null;
      }
      if (!row || row.buff_color == null) {
        unreadable++;
        continue;
      }
      if (Number(row.buff_color) === 5) n++;
    }
    return unreadable && !n ? -1 : n;
  }

  /** 本场战斗窗口是否已过（`roomBaseInfo.fightEndTime` 毫秒绝对时刻；读不到当未过）。 */
  #fightOver() {
    const base = this.#env.secret.getRoomBaseInfo();
    const end = toNum(base && base.fightEndTime);
    return end > 1e11 && Date.now() >= end;
  }

  /**
   * G6 禁店窗（竞品 shopStage 的第一道闸）：任一 BOSS 处于 state22 且 `|end - now - 60s| < 60s`，
   *   即读秒**开始前** 0~120s——这整段路车要空出来挪平台，不去店。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #shopLockNow(now) {
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return false;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || Number(s.state) !== ST_PLANE_MARCH) continue;
      if (
        inOffsetWindow(
          toNum(s.stateEndTime),
          now,
          tuning.driveShopBossLockMs,
          tuning.driveShopBossLockWinMs,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * G7 「该收场」三级判据（竞品 exitStage verbatim）：
   *   `i` = 任一店账本 `piece>0`（本组已在某店买到过百兽箱）；
   *   `a` = 有 BOSS 进入 state30（已被打死，本场 BOSS 收益已落袋）；
   *   `r` = 背包高品质（quality≥4）宠物数 ≥ 携带容量；
   *   `team_type` 取 0=i / 1=i&&a / 2=i&&a&&r，**任一档为假再用「本场战斗窗口已过」兜底**（竞品 `|| ServerMSTime >= fightEndTime`）。
   * @returns {boolean} true=该收场了（只去店拿货，不再采井/打野）
   */
  #exitStageWant() {
    const env = this.#env;
    const tier = Number(tuning.driveTeamType) || 0;
    let boxGot = false;
    this.#shopLedger.forEach(function (v) {
      if (v && v.piece > 0) boxGot = true;
    });
    if (!boxGot) return this.#fightOver();
    if (tier < 1) return true;
    const list = env.secret.getBossBaseInfo();
    const bossDead =
      Array.isArray(list) &&
      !!list.find(function (s) {
        return s && Number(s.state) === ST_BOSS_DEAD_END;
      });
    if (!bossDead) return this.#fightOver();
    if (tier < 2) return true;
    const full = typeof env.petPackFull === 'function' ? env.petPackFull() : false;
    if (full) return true;
    return this.#fightOver();
  }

  /**
   * G7 收场判据的对外口（leave.js 复用同一份三级判据，避免两套「该收场」逻辑漂移）。
   * @returns {boolean}
   */
  exitStageWant() {
    return this.#exitStageWant();
  }

  /**
   * G6 竞品 shopStage 的时间口径里那个 `gap`（秒）：`now秒 − max(各店账本 time)`。
   *   抽成**纯读**函数（无任何副作用），供 #shopStageWant 判定与「缺香肠/持有缺口」两档的日志共用一份口径，
   *   避免 debugState 想看一眼 gap 就顺手改了冷却时刻。
   * @param {number} now 毫秒
   * @returns {number|null} null=账本未建（算不出 gap）
   */
  #shopGapSec(now) {
    if (!this.#shopLedger.size) return null;
    let last = 0;
    this.#shopLedger.forEach(function (v) {
      if (v && v.time > last) last = v.time;
    });
    return Math.floor(now / 1000) - last;
  }

  /**
   * G6 竞品 shopStage 的时间语义（`gap = now秒 − max(各店账本 time)`，节拍 `i = driveShopIntervalMs/1000`）：
   *   ① 任一 BOSS 处于「读秒**开始前** 0~120s」（state22 且 `abs(end-now-60s) < 60s`）→ 一律不去店（这段车要空出来挪平台）；
   *   ② `team_type==0`：只看 `gap > i`；
   *   ③ `team_type>0`：`gap > i` **或**「读秒结束后 120~180s 的拍宠高光窗且 `gap > 120s`」——
   *      竞品把这段时间的到店节拍从 8min 砍到 2min（店里会刷出百兽箱/香肠）。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #shopStageWant(now) {
    if (this.#shopLockNow(now)) return false;
    const list = this.#env.secret.getBossBaseInfo();
    let nearEnd = 0;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || Number(s.state) !== ST_PLANE_MARCH) continue;
        const end = toNum(s.stateEndTime);
        if (end > nearEnd) nearEnd = end;
      }
    }
    const gap = this.#shopGapSec(now);
    if (gap == null) return false; // 锚点未建账 → 无法算 gap，不当「到轮了」（防每拍空转想去店）
    const iv = Math.round((Number(tuning.driveShopIntervalMs) || 0) / 1000);
    if (gap > iv) return true;
    if (!(Number(tuning.driveTeamType) || 0)) return false;
    if (!(nearEnd > 1e11)) return false;
    return (
      inOffsetWindow(nearEnd, now, tuning.driveShopNearEndMs, tuning.driveShopNearEndWinMs) &&
      gap > Math.round((Number(tuning.driveShopNearEndGapMs) || 0) / 1000)
    );
  }

  /**
   * G9 `guard_policy` 四档过滤（竞品 autoLeader 里 BOSS 候选的 switch，verbatim）：
   *   0 跳过按 x 升序**第三近**的 BOSS / 1 跳过按 x 升序**最近**的 /
   *   2 跳过「石头奖励已有人领 且 我已到场打过」（`driveBossDedupe===false` 时退化为只看奖励记录）/
   *   3 跳过任何有石头奖励记录的。
   * @param {object} s 候选 BOSS 条目
   * @param {Array} byX 同一清单按 pos.x 升序的副本（身份比对用，必须是同一批对象引用）
   * @param {Array|null} rewardList 小BOSS 石头奖励账（getBossGuardRewardInfo）
   * @returns {boolean} true=本候选可用
   */
  #bossGuardOk(s, byX, rewardList) {
    const policy = Number(tuning.driveGuardPolicy) || 0;
    if (policy === 0) return s !== byX[2];
    if (policy === 1) return s !== byX[0];
    const bid = Number(s && s.bossId) || 0;
    let hasReward = false;
    if (Array.isArray(rewardList)) {
      for (let i = 0; i < rewardList.length; i++) {
        if (rewardList[i] && Number(rewardList[i].bossId) === bid) {
          hasReward = true;
          break;
        }
      }
    }
    if (!hasReward) return true;
    if (policy === 3) return false;
    if (tuning.driveBossDedupe === false) return false;
    return !this.#bossDone[bid];
  }

  /**
   * G9 竞品 `marchResource` 的 BOSS 引力锚：**第一个「石头奖励还没人领」的 BOSS**（不是当前窗口 BOSS）。
   *   评分里「距 BOSS/5」用它，于是即使眼下没开台，车也会往「还有石头可抢」的 BOSS 方向贴。
   *   全部都有记录（竞品会因 `i["pos"]` 报错）→ 我方回 null，调用方退化用当前窗口 BOSS 或 0 成本。
   * @returns {{x:number,y:number}|null}
   */
  #bossScoutAnchor() {
    const env = this.#env;
    const list = env.secret.getBossBaseInfo();
    if (!Array.isArray(list) || !list.length) return null;
    const reward = env.secret.getBossGuardRewardInfo();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !s.pos) continue;
      const bid = Number(s.bossId) || 0;
      let claimed = false;
      if (Array.isArray(reward)) {
        for (let j = 0; j < reward.length; j++) {
          if (reward[j] && Number(reward[j].bossId) === bid) {
            claimed = true;
            break;
          }
        }
      }
      if (claimed) continue;
      const x = Math.floor(toNum(s.pos.x));
      const y = Math.floor(toNum(s.pos.y));
      if (x > 0 && y > 0) return { x: x, y: y };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // S1 阶段层
  // ══════════════════════════════════════════════════════════════════════

  /**
   * BOSS 阶段：先找 state21（开打中且未散场）→ 再找 state22 且距开启 ≤ driveBossLeadMs（开台读秒窗）。
   *   两者的读法都只依赖 `bossBaseInfo[].pos`（**服务器权威坐标，与镜头无关**）→ 打 BOSS 不再需要先"看见" BOSS。
   *   G9：候选先过 `#bossGuardOk`（guard_policy 四档）；G8：读秒过期且仍在宽限窗内的 state22 也产 `open` 候选
   *   （由调用方按「已上平台没」决定打 BOSS 还是先上平台），而不是直接 continue 把整场让掉。
   * @param {number} now 毫秒
   * @param {{x:number,y:number}} cur 当前停泊坐标
   * @returns {{boss:{x:number,y:number,bossId:number,state:number,endTime:number},mode:'open'|'lead',leftMs:number}|null}
   */
  #bossWindow(now, cur) {
    const env = this.#env;
    const list = env.secret.getBossBaseInfo();
    if (!Array.isArray(list) || !list.length) return null;
    // G9 guard_policy 参照系：同一批对象引用按 pos.x 升序（竞品 `s.sort((a,b)=>a.pos.x-b.pos.x)`）
    const byX = list.slice().sort(function (a, b) {
      return toNum(a && a.pos && a.pos.x) - toNum(b && b.pos && b.pos.x);
    });
    const rewardList = env.secret.getBossGuardRewardInfo();
    let open = null;
    let openD = Infinity;
    let lead = null;
    let leadLeft = Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !s.pos) continue;
      if (!this.#bossGuardOk(s, byX, rewardList)) continue; // G9 策略过滤
      const bx = Math.floor(toNum(s.pos.x));
      const by = Math.floor(toNum(s.pos.y));
      if (!(bx > 0) || !(by > 0)) continue;
      const st = Number(s.state) || 0;
      const end = toNum(s.stateEndTime);
      if (st === ST_BOSS_FIGHTING) {
        if (end > 1e11 && now > end) continue; // 已散场
        const d = dist(cur.x, cur.y, bx, by);
        if (d < openD) {
          openD = d;
          open = { x: bx, y: by, bossId: Number(s.bossId) || 0, state: st, endTime: end };
        }
        continue;
      }
      if (st === ST_PLANE_MARCH) {
        if (!(end > 1e11)) continue; // 读不到开启时刻 → 不拿猜测赌行程
        const left = end - now;
        if (left > tuning.driveBossLeadMs) continue; // 还不到该挪队的时刻
        if (left > 0) {
          if (left < leadLeft) {
            leadLeft = left;
            lead = { x: bx, y: by, bossId: Number(s.bossId) || 0, state: st, endTime: end };
          }
          continue;
        }
        // 读秒已过但服务端还没推 21（stateEndTime 过期、state 仍 22）：BOSS 事实上已可打。
        //   竞品B `marchBoss` 就是 `state==22 && stateEndTime < now` 照打（server-js.js L24874）；
        //   而它的 `autoLeader` 开台档对这种 BOSS：**已上平台→ marchBoss，未上平台→ marchPlane**。
        //   G8：我方同理不再「不在平台就 continue」（那等于把整场 BOSS 让掉）——交给 ⑥ 档的
        //   `onPlane ? 打BOSS : 先选平台` 分流，读秒过期但在平途的车依旧往 BOSS 靠。
        //   `driveBossGraceMs` 仍作上限：超过宽限期仍没收到 21 推送 → 当它已散场，不追一个看不见的目标。
        if (now - end > tuning.driveBossGraceMs) continue;
        const dl = dist(cur.x, cur.y, bx, by);
        if (dl < openD) {
          openD = dl;
          open = { x: bx, y: by, bossId: Number(s.bossId) || 0, state: st, endTime: end };
        }
      }
    }
    if (open)
      return { boss: open, mode: 'open', leftMs: open.endTime > 1e11 ? open.endTime - now : 0 };
    if (lead) return { boss: lead, mode: 'lead', leftMs: leadLeft };
    return null;
  }

  /**
   * 商店阶段判据（命中返回理由键供日志/诊断）。**竞品只有三处去店理由**：exitStage / shopStage / 链尾兜底
   *   （`buy_sausage` 是「进了店买不买」的阈值，不是「为什么开车去店里」），我方对应关系：
   *   ① `exit`：G7 该收场了（竞品 exitStage → marchShop，**抢在链前**，收场只去拿货）；
   *   ② `stage`：G6 shopStage（距上次到店超 8min，或读秒结束后的拍宠高光窗且超 2min）（**抢在链前**）；
   *   ③ `errand`：大BOSS 前那趟定点勤务（elapsed ≥ driveShopPointsSec[0]，本场未办）；
   *   ④ `sausage`：香肠 41011 < tuning.driveSausageTarget；
   *   ⑤ `gap`：用户勾选的持有清单有缺口。
   * ⚠ ③④⑤ 不再抢在日常链之前（#stageChain 只用它们做**链尾兜底**的选店排序与日志）：
   *   实战 20261101T200401 把这三档放在采井/打野前面，于是「缺香肠」这条**电平闸**（不受 shopStage 节拍约束）
   *   每拍赢过采井 → 一进秘境就直冲商店、25s 驻留满又被拉回去，一局 11 次开同一家店。
   *   定期去店仍由 ② shopStage（8min 节拍）保证，与竞品一致。
   * 前置闸：开局 warmup（`fightBegin + 63s`，竞品同值）、G6 开台前 0~120s 禁店窗、到店冷却（不拦 exit）。
   * @param {number} now 毫秒
   * @param {number} elapsedSec 本场已过秒数
   * @param {number} curPt 当前点型
   * @returns {string} ''=不需要去店
   */
  #shopWant(now, elapsedSec, curPt) {
    const env = this.#env;
    if (!(this.#matchStartAt > 1e11)) return ''; // 本场计时基准还没建立 → 不猜
    if (elapsedSec * 1000 < tuning.driveShopWarmupMs) return '';
    if (curPt === PAB_SHOP) return ''; // 已在店里，交给 shop.js
    // G6 竞品 shopStage 的第一道闸：任一 BOSS 开台前 0~120s → 这段路车要空出来挪平台，一律不去店
    if (this.#shopLockNow(now)) return '';
    if (this.#exitStageWant()) return 'exit';
    // 到店即进冷却：缺口补不满（无货/额度空/缺刷新币）时，否则会「离店→缺口仍在→又开回同一家店」永动。
    //   ⚠ 位置在 exit 之后：收场档只拿货、不吃永动风险（竞品的 exitStage 也不受商店冷却约束）。
    if (now < this.#shopCoolUntil) return '';
    if (this.#shopStageWant(now)) return 'stage';
    const d = env.cfg().drive || {};
    if (d.shopTime !== false && !this.#shopErrandDone) {
      const pts = tuning.driveShopPointsSec;
      const first = Array.isArray(pts) && pts.length ? Number(pts[0]) || 600 : 600;
      const last = Array.isArray(pts) && pts.length ? Number(pts[pts.length - 1]) || first : first;
      if (elapsedSec < first) {
        /* 还没到勤务时刻：继续往下判香肠/轮巡 */
      } else if (elapsedSec > last * 1.5) {
        // 过了「大BOSS 前」的窗口：本场不再为它补做（重载扩展会重置标记，否则车会被拉回商店一次）
        this.#shopErrandDone = true;
        this.#note(
          'shop-expired',
          'pilot: 大BOSS 前商店勤务已过窗口（elapsed ' +
            Math.round(elapsedSec) +
            's > ' +
            Math.round(last * 1.5) +
            's），本场不再为它开车。reason=shop_expired',
        );
      } else {
        return 'errand';
      }
    }
    if (env.secret.getItemNumById(ITEM_SAUSAGE) < tuning.driveSausageTarget) {
      // G7 白跑惩罚：锚点里每家店都已**试过**（都买到过香肠，或货单上根本没香肠）却仍缺料 → 本拍补不满（买不起/
      //   额度买完/缺刷新币），进长冷却；否则会形成「离店→缺口仍在→又开回同一家店」的永动。
      if (this.#shopAllTried()) {
        const coolMs = Number(tuning.driveShopGapCooldownMs) || 600000;
        this.#shopCoolUntil = now + coolMs;
        this.#note(
          'shop-all-tried',
          'pilot: 四家店都已试过（买到过香肠或已知不卖）却仍缺料，进 ' +
            Math.round(coolMs / 1000) +
            's 长冷却。reason=shop_all_tried',
        );
        return '';
      }
      return 'sausage';
    }
    // 用户配置的「持有清单有缺口」也算理由（与 v2 #shopGapWanted 同口径，让勾选立刻生效）
    if (this.#shopGapWanted()) return 'gap';
    return '';
  }

  /**
   * 本场已过秒数：基准 = `roomBaseInfo.fightBeginTime`；缺失（异常房间/刚进图）时退化为引擎首拍时刻。
   *   没有这层兜底，`#shopWant` 的「开局暖机 / 大BOSS 前勤务」两档在 fightBeginTime 为 0 时永不触发。
   * @param {number} now 毫秒
   * @returns {number} 秒
   */
  #elapsedSec(now) {
    const base = this.#matchStartAt;
    return base > 1e11 ? Math.max(0, (now - base) / 1000) : 0;
  }

  /**
   * 持有清单里勾了「店」渠道的道具是否有缺口（轻量预筛，不复刻 shop.js 的进度账）。
   * @returns {boolean}
   */
  #shopGapWanted() {
    const env = this.#env;
    const items = env.cfg().pickItems || {};
    const keys = Object.keys(items);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf(KEY_ITEM) !== 0) continue;
      const row = items[k];
      if (!row || Number(row.shop) !== 1) continue;
      const itemId = Number(k.slice(KEY_ITEM.length));
      if (!(itemId > 0)) continue;
      let cap = Number(row.max) || 0;
      if (cap <= 0) {
        let r = null;
        try {
          r = env.l10n.tableRow(TABLE_ITEM, itemId);
        } catch (e) {
          /* 行读不到 = 无上限语义，该行不算缺口 */
        }
        cap = Number(r && r.para1_v1) || 0;
      }
      if (!(cap > 0)) continue;
      if (env.secret.getItemNumById(itemId) < cap) return true;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════
  // S2 动作层（选点纯函数：无证据即回 null，绝不凭空造坐标）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 选一家商店（**表锚点优先**，锚点缺失才退回视口里的 161）。
   *   G7 竞品 `marchShop(e)` 的排序口径 verbatim：`e && i.sausage - a.sausage || dist(i) - dist(a)`——
   *   即「高光窗/轮巡档（e=1）」先选**本店还没买过香肠**的，同档才比距离；纯应急去店（e 未传）只看距离。
   * ⚠ 访问记忆闸（实战 20261101T200401 的根因 C：此前本函数**不查任何记忆**，11 次全敲最近那家 (95,163)）：
   *   已派车（#marched）/ 已消费（#consumed，离店即记 driveConsumedTtlMs）/ 真服务过且仍在 revisit 窗内的店
   *   先跳过，试下一家；四家都在闸内时自然回 null → 链尾不拦路，交给巡航/探索。竞品靠 `cd_time.march` 全局锁
   *   不连续敲同一家，我方把去店理由改到链尾后必须自己记住（driveShopRevisitMs）。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {boolean} [bySausage=false] 按香肠账排序（竞品 marchShop(1)）
   * @param {boolean} [urgent=false] 收场档（竞品 exitStage → marchShop）：不吃 #consumed/revisit 长记忆，
   *   只留 60s 的 #marched 防手抖（竞品那段只有 15s 路由锁 + 3s 同点去重，收场本来就该反复回店拿货）
   * @returns {{x:number,y:number}|null}
   */
  #pickShop(curKey, cur, bySausage, urgent) {
    const now = Date.now();
    const stay = Math.max(3000, Number(tuning.driveShopStayMs) || 0);
    const revisit = Number(tuning.driveShopRevisitMs) || 0;
    const revisitWin = revisit > 0 ? Math.max(revisit, stay) : stay;
    let best = null;
    let bestS = 1;
    let bestD = Infinity;
    for (let i = 0; i < this.#shops.length; i++) {
      const s = this.#shops[i];
      const k = tileKey(s.x, s.y);
      if (!k) continue;
      if (this.#dayBlack[k]) continue;
      if (k === curKey) return { x: s.x, y: s.y }; // 已在店里 → 同点短路，直接进 WORK
      const cu = this.#consumed.get(k);
      if (cu != null && (cu === -1 || (!urgent && cu > now))) continue;
      const ma = this.#marched.get(k);
      if (ma != null && ma > now) continue;
      const led = this.#shopLedger.get(k);
      if (!urgent && led && led.visited) {
        const lt = Number(led.time) || 0;
        if (lt > 0 && now < lt * 1000 + revisitWin) continue;
      }
      const sa = bySausage && led && Number(led.sausage) > 0 ? 1 : 0;
      const d = dist(cur.x, cur.y, s.x, s.y);
      const better = bySausage ? sa < bestS || (sa === bestS && d < bestD) : d < bestD;
      if (better) {
        bestS = sa;
        bestD = d;
        best = { x: s.x, y: s.y };
      }
    }
    if (best) return best;
    // 退路：视口里出现过的 161（表未下发/无本组行时才走到这里）——同样过访问记忆闸
    const self = this;
    this.#tiles.forEach(function (t) {
      if (t.pt !== PAB_SHOP) return;
      if (self.#dayBlack[t.k]) return;
      const cu = self.#consumed.get(t.k);
      if (cu != null && (cu === -1 || (!urgent && cu > now))) return;
      const ma = self.#marched.get(t.k);
      if (ma != null && ma > now) return;
      const d = dist(cur.x, cur.y, t.x, t.y);
      if (d < bestD) {
        bestD = d;
        best = { x: t.x, y: t.y };
      }
    });
    return best;
  }

  /**
   * G2 打野档（竞品 `marchBeast(4)` verbatim）：172 野怪点，回合已开门（G3）+ 空闲置 + 没被别人的在途行军
   *   指向（G4，`march_policy==1` 不查）+ 不是别人的集结兽（`callTId`）+ 情报品质≥minQ + 距 0<d≤maxDist；
   *   排序：品质降序→距离升序。品质口径 verbatim：**未侦察到回 2**（竞品 `quality || 2`），所以
   *   `driveBeastMinQuality` 默认 4 意味着**没囤到情报的野怪不去**（这就是 scout.js 存图的下游）。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {number} minQ 最小品质（竞品传 4）
   * @param {number} maxDist 距离上限（竞品 99999=不限）
   * @returns {{x:number,y:number}|null}
   */
  #pickBeast(curKey, cur, minQ, maxDist) {
    const env = this.#env;
    const now = Date.now();
    const self = this;
    const base = env.secret.getRoomBaseInfo();
    const myTeam = base && base.teamId != null ? toNum(base.teamId) : 0;
    const dbg = {
      seen: 0,
      type: 0,
      closed: 0,
      round: 0,
      busy: 0,
      march: 0,
      poor: 0,
      far: 0,
      pass: 0,
      best: '',
    };
    let best = null;
    let bestQ = -1;
    let bestD = Infinity;
    this.#tiles.forEach(function (t) {
      dbg.seen++;
      if (t.pt !== PAB_MONSTER) {
        dbg.type++;
        return;
      }
      if (!self.#roundOpen(t.esrId)) {
        dbg.round++;
        return;
      }
      if (t.k === curKey || self.#dayBlack[t.k]) {
        dbg.closed++;
        return;
      }
      const cu = self.#consumed.get(t.k);
      const ma = self.#marched.get(t.k);
      if ((cu != null && (cu === -1 || cu > now)) || (ma != null && ma > now)) {
        dbg.closed++;
        return;
      }
      // 只去空闲野怪（竞品 `state == 0 && teams.length == 0`）且不是别人的集结目标
      if (t.state !== ST_NORMAL || t.teams > 0 || (t.callTId && myTeam && t.callTId !== myTeam)) {
        dbg.busy++;
        return;
      }
      if (self.#marchBlocked(t.x, t.y)) {
        dbg.march++;
        return;
      }
      const qRaw = typeof env.scoutQuality === 'function' ? env.scoutQuality(t.x, t.y) : null;
      const q = Number.isFinite(qRaw) ? Number(qRaw) : 2; // 竞品口径：未知品质当 2（默认闸 4 就筛掉）
      if (q < minQ) {
        dbg.poor++;
        return;
      }
      const d = dist(t.x, t.y, cur.x, cur.y);
      if (!(d > 0) || d > maxDist) {
        dbg.far++;
        return;
      }
      dbg.pass++;
      if (q > bestQ || (q === bestQ && d < bestD)) {
        bestQ = q;
        bestD = d;
        best = { x: t.x, y: t.y };
      }
    });
    if (best) dbg.best = tileKey(best.x, best.y) + ' q=' + bestQ + ' d=' + bestD.toFixed(1);
    this.#pickDbg = dbg;
    return best;
  }

  /**
   * G2 跟人档（竞品 `marchTeam()` verbatim）：在 173 井 / 172 野怪里找**已有人驻军、或有人在途飞向它**
   *   且距本点不为 0 的最近一个（摇人/跟队语义：往扎堆的地方靠，不自己探新点）。
   *   `march_policy==2`（摇人优先）时在日常链最前面试这一档。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @returns {{x:number,y:number}|null}
   */
  #pickFollow(curKey, cur) {
    const self = this;
    const now = Date.now();
    let best = null;
    let bestD = Infinity;
    this.#tiles.forEach(function (t) {
      if (t.pt !== PAB_RESOURCE && t.pt !== PAB_MONSTER) return;
      if (t.k === curKey || self.#dayBlack[t.k]) return;
      const cu = self.#consumed.get(t.k);
      const ma = self.#marched.get(t.k);
      if (cu != null && (cu === -1 || cu > now)) return;
      if (ma != null && ma > now) return;
      const hot = t.teams > 0 || (self.#viewMarch.size && self.#viewMarch.has(t.k));
      if (!hot) return;
      const d = dist(t.x, t.y, cur.x, cur.y);
      if (!(d > 0)) return;
      if (d < bestD) {
        bestD = d;
        best = { x: t.x, y: t.y };
      }
    });
    return best;
  }

  /**
   * 选 BOSS 邻域的平台（176 优先，174 兜底；同 `esrId` 区域优先、已有驻军/在战斗的剔除）。
   *   平台坐标只能从视口（901 以 BOSS 为中心拉的那一刀）或 push 拿——但 BOSS 本体坐标来自权威态，
   *   所以**再也不用"等镜头扫到 BOSS"**，只要 BOSS 已知，就以它为中心主动问一次。
   * @param {{x:number,y:number}} boss BOSS 坐标
   * @param {string} curKey 当前点键
   * @returns {object|null} 点位
   */
  #pickPlane(boss, curKey) {
    const esr = this.#bossEsrId(boss);
    const self = this;
    let best = null;
    let bestScore = -Infinity;
    this.#tiles.forEach(function (t) {
      if (t.pt !== PAB_BOSS_PLANE && t.pt !== PAB_COMMON_PLANE) return;
      if (self.#dayBlack[t.k]) return;
      if (t.k === curKey) return; // 同点短路由 #dispatch 处理，这里只需给出目标
      if (t.isFight) return; // 平台在战斗中（enigma_realm217）
      if (t.teams > 0) return; // 已有队伍驻军（enigma_realm252）
      // 区域证据只在两边都有时才拦（缺一边 = 不拦，避免误杀）
      if (esr && t.esrId && t.esrId !== esr) return;
      const d = dist(t.x, t.y, boss.x, boss.y);
      // 平台自身 `state===22`（可派兵/读秒中）加权优先：竞品 getBossInfo 只认这种平台（server-js.js L24625）。
      //   这里做成**加权**而不是硬过滤：176/174 的 state 语义在实战里还有未证形态，硬筛会把机会直接筛没。
      const ready = t.state === ST_PLANE_MARCH ? 200 : 0;
      const score = ready - d - (t.pt === PAB_COMMON_PLANE ? 30 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    });
    return best;
  }

  /**
   * BOSS 本体所在区域的 esrId（从快照里 BOSS 坐标那条瓦片取；取不到回 null = 不做区域过滤）。
   * @param {{x:number,y:number}} boss 坐标
   * @returns {number|null}
   */
  #bossEsrId(boss) {
    const t = this.#tiles.get(tileKey(boss.x, boss.y));
    return t && t.esrId ? t.esrId : null;
  }

  /**
   * 巡航选点（竞品B `marchResource` 同款评分制）：
   *   `score = iNum − 距当前点/2 − 距 BOSS 引力锚/5 − 距香肠没买过的店/6`，取最高。
   *   过滤：只看 173/163；已消费/已派车/本场拉黑的剔除；`state` 非 0（非空闲）或 `teams>0`（有队伍）剔除；
   *   G3 回合已开门（`#roundOpen(esrId)`）、G4 没被别人的在途行军指向（`#marchBlocked`）；
   *   173 还要求 `iNum >= minNum` 且 `rTime` 不在未来（井已被抽空、正在刷新）；距当前点 ∈ (0, maxDist]。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {{x:number,y:number}|null} bossA 竞品口径的 BOSS 引力锚（由调用方传 `#bossScoutAnchor()`）
   * @param {number} [minNum=0] 最小产出（竞品严格档 `5 + ceil(队伍人数/2)`）
   * @param {number} [maxDist=99999] 距离上限（竞品严格档 100）
   * @returns {object|null}
   */
  #pickResource(curKey, cur, bossA, minNum, maxDist) {
    const now = Date.now();
    const minYield = Number.isFinite(minNum) && minNum > 0 ? minNum : 0;
    const maxD = Number.isFinite(maxDist) && maxDist > 0 ? maxDist : 99999;
    const shopA = this.#shops.length ? this.#nearestShopA(cur) : null;
    const dbg = {
      seen: 0,
      cur: 0,
      type: 0,
      pvp: 0,
      empty: 0,
      black: 0,
      consumed: 0,
      bad: 0,
      round: 0,
      march: 0,
      far: 0,
      pass: 0,
      best: '',
      anchors: (bossA ? 'B' : '-') + (shopA ? 'S' : '-'),
    };
    const self = this;
    let best = null;
    let bestScore = -Infinity;
    this.#tiles.forEach(function (t) {
      dbg.seen++;
      if (t.pt !== PAB_RESOURCE && t.pt !== PAB_DROP) {
        dbg.type++;
        return;
      }
      if (t.k === curKey) {
        dbg.cur++;
        return;
      }
      if (self.#dayBlack[t.k]) {
        dbg.black++;
        return;
      }
      const cu = self.#consumed.get(t.k);
      if (cu != null && (cu === -1 || cu > now)) {
        dbg.consumed++;
        return;
      }
      const ma = self.#marched.get(t.k);
      if (ma != null && ma > now) {
        dbg.consumed++;
        return;
      }
      if (t.state === ST_PVP_READY || t.state === ST_PVP_FIGHTING) {
        dbg.pvp++;
        return;
      }
      if (t.state !== ST_NORMAL) {
        dbg.bad++;
        return;
      }
      if (t.teams > 0) {
        dbg.bad++;
        return;
      }
      if (t.pt === PAB_RESOURCE) {
        if (t.rTime > now) {
          dbg.empty++;
          return;
        }
        if (t.iNum != null && t.iNum < minYield) {
          dbg.empty++;
          return;
        }
      } else if (t.iNum != null && t.iNum <= 0) {
        dbg.empty++;
        return;
      }
      // G3 回合开门闸：未刷出来的区域不算候选（竞品对 173 verbatim 同一个 `r(esrId)`）
      if (!self.#roundOpen(t.esrId)) {
        dbg.round++;
        return;
      }
      // G4 别人的在途行军已飞向该点 → 不抢（`march_policy==1` 时不查）
      if (self.#marchBlocked(t.x, t.y)) {
        dbg.march++;
        return;
      }
      const d0 = dist(t.x, t.y, cur.x, cur.y);
      if (d0 > maxD) {
        dbg.far++;
        return;
      }
      dbg.pass++;
      const gain = t.iNum == null ? 0 : t.iNum;
      const dCur = d0;
      // ⚠ 成本项缺锚时必须算 **0**，不能拿 Infinity 去参与减法：
      //   `Infinity / 5` 仍是 Infinity，而 Infinity 是 truthy，`|| 0` 不生效 → score 恒 -Infinity，
      //   bestScore 初值也是 -Infinity、`>` 恒假 → 一个点都选不中（v2 实战 20261031 的死因）。
      const dBoss = bossA ? dist(t.x, t.y, bossA.x, bossA.y) : NaN;
      const dShop = shopA ? dist(t.x, t.y, shopA.x, shopA.y) : NaN;
      const score =
        gain -
        dCur / 2 -
        (Number.isFinite(dBoss) ? dBoss / 5 : 0) -
        (Number.isFinite(dShop) ? dShop / 6 : 0);
      if (score > bestScore || (score === bestScore && best && t.at > best.at)) {
        bestScore = score;
        best = t;
      }
    });
    if (best) dbg.best = best.k + ' score=' + bestScore.toFixed(2);
    this.#pickDbg = dbg;
    if (!best) return null;
    return { x: best.x, y: best.y };
  }

  /**
   * 评分用的商店引力锚：竞品 `marchResource` 取的是**「还没买过香肠的店里最近的一家」**
   *   （`shops.filter(s => s.sausage == 0).sort(dist)[0]`）——于是车会往「还有香肠可拿」的店那边靠。
   *   香肠账全 >0（或锚点未建账）时退化为全体最近的一家。
   * @param {{x:number,y:number}} cur 当前坐标
   * @returns {{x:number,y:number}|null}
   */
  #nearestShopA(cur) {
    const self = this;
    let best = null;
    let bestD = Infinity;
    let bestS = 1;
    this.#shops.forEach(function (s) {
      const k = tileKey(s.x, s.y);
      const led = k ? self.#shopLedger.get(k) : null;
      const sa = led && Number(led.sausage) > 0 ? 1 : 0;
      const d = dist(cur.x, cur.y, s.x, s.y);
      if (sa < bestS || (sa === bestS && d < bestD)) {
        bestS = sa;
        bestD = d;
        best = s;
      }
    });
    return best;
  }

  /**
   * 探索落点：8 扇区轮转、步长 `driveExploreStep`，必选快照里**没有**的格子（已知点去了也白跑）。
   * @param {{x:number,y:number}} cur 当前坐标
   * @returns {{x:number,y:number}|null}
   */
  #explorePoint(cur) {
    const step = Number(tuning.driveExploreStep) || 0;
    if (!(step > 0)) return null;
    for (let i = 0; i < 8; i++) {
      const sec = (this.#exploreSpin + i) % 8;
      const x = Math.round(cur.x + Math.cos((sec * Math.PI) / 4) * step);
      const y = Math.round(cur.y + Math.sin((sec * Math.PI) / 4) * step);
      if (x < 1 || x > 1023 || y < 1 || y > 1023) continue;
      const k = tileKey(x, y);
      if (!k || this.#tiles.has(k) || this.#dayBlack[k]) continue;
      return { x: x, y: y };
    }
    return null;
  }

  /**
   * 发一笔 8521（唯一写动作）。应答异步回来，改变相位时主动 kick 一拍。
   * @param {string} kind 档位名（日志/诊断用；被拒处置按它分流：平台类只黑平台，不黑 BOSS 本体）
   * @param {{x:number,y:number}|null} cand 目标（null=本档无候选）
   * @param {boolean} [bypassGate=false] 绕过 `isSecretSending` 闸（幽灵条目自愈专用）
   */
  #dispatch(kind, cand, bypassGate) {
    const env = this.#env;
    this.#lastDispatch = kind + '|' + (cand ? cand.x + ',' + cand.y : 'none');
    if (!cand) {
      if (kind === 'return') {
        this.#returnPending = false;
        this.#note('return-none', 'pilot: 回攻无可落平台，转常规重评。reason=no_platform');
      } else {
        this.#note(
          'none|' + kind,
          'pilot: ' + kind + ' 档在候选池内无可用点，驻留重扫。reason=no_candidate',
        );
      }
      return;
    }
    const base = env.secret.getRoomBaseInfo();
    const curKey = base && base.startPoint ? tileKey(base.startPoint.x, base.startPoint.y) : '';
    // 目标就是当前所在点：**不发同点 8521**（同点包只会进 TO 空等 90s 再重派），直接按到达进驻留
    if (curKey && tileKey(cand.x, cand.y) === curKey) {
      this.#lastDispatch = kind + '|same(' + curKey + ')';
      this.#note(
        'same|' + kind,
        'pilot: ' + kind + ' 档选中了当前所在点 (' + curKey + ')，已在位，不发 8521，直接进驻留。',
      );
      this.#enterWork(curKey);
      return;
    }
    // 逃袭时把停泊现场留档给回攻档（仅 BOSS 相关点会用到）
    if (kind === 'evade') {
      const curPt = Number((base && base.pointType) || 0);
      const t = (curKey && this.#tiles.get(curKey)) || null;
      this.#escapeFrom = isBossish(curPt)
        ? {
            x: Number(base.startPoint.x),
            y: Number(base.startPoint.y),
            pt: curPt,
            esrId: t ? t.esrId : null,
          }
        : null;
      this.#returnPending = isBossish(curPt);
    }
    const ret = bypassGate
      ? env.secret.sendSecret(CMD_MARCH_MOVE, { x: cand.x, y: cand.y })
      : env.secret.sendMarch(cand.x, cand.y);
    if (!ret || typeof ret.then !== 'function') {
      env.log.debug('pilot: 8521 not sent (in-flight/invalid coords), retry next tick.');
      return;
    }
    this.#toKind = kind + '|(' + cand.x + ',' + cand.y + ')';
    this.#toTag = kind;
    this.#toXY = tileKey(cand.x, cand.y);
    this.#toAt = Date.now();
    // 派过车的点 60s 内不再选（竞品 marched_list 同源）：治「到点没拿到→下一拍又选同一点」
    this.#marched.set(this.#toXY, this.#toAt + tuning.driveMarchedTtlMs);
    if (kind === 'shop') this.#shopLastAt = this.#toAt;
    this.#idleSince = 0;
    if (kind === 'evade') this.#cooldownUntil = Date.now() + tuning.warnMoveCooldownMs;
    env.log.info('pilot: goto %s reason=%s', this.#toKind, kind);
    const self = this;
    const myKey = this.#toXY;
    const wake = function () {
      if (self.#cycle) self.#cycle.kick();
    };
    ret
      .then(function (r) {
        if (!env.alive()) return;
        if (self.#toXY !== myKey) return; // 相位已被后续拍替换 → 这笔应答过期
        if (r && r.code === CODE_NOT_SENT) return;
        const ok = r && (r.ok === undefined ? Number(r.code) === 0 : !!r.ok);
        if (ok) return; // 上线成功：推进交给到达复核/超时兜底
        const rej = String((r && r.reason) || '');
        if (rej.indexOf(REJ_BATTLEFIELD_CLOSING) >= 0) {
          self.#realmClosed = true;
          self.#clearTo();
          self.#note(
            'realm-closed',
            'pilot: 秘境已进入封闭阶段（服务端回 ' +
              REJ_BATTLEFIELD_CLOSING +
              '「战场即将封闭」），行军一律不受理，本场驱动停手。reason=realm_closed',
          );
          wake();
          return;
        }
        if (rej === REJ_ALREADY_THERE) {
          self.#enterWork(self.#toXY);
          wake();
          return;
        }
        if (rej === REJ_POINT_NOT_EXIST) {
          // 目标点不存在（数据陈旧）→ 拉黑该点；若是商店锚点则一并脱表，下次选别家
          //   ⚠ BOSS 本体坐标来自权威态，撞 159 并不代表「BOSS 不存在」→ 只黑平台/巡航点，不黑 BOSS
          if (self.#toTag !== 'boss') self.#dayBlack[self.#toXY] = 1;
          self.#dropShopAt(self.#toXY);
          env.log.info('pilot: (%s) 目标点不存在(159)，本场拉黑。', self.#toXY);
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          wake();
          return;
        }
        if (rej === REJ_NO_MARCH_TARGET) {
          self.#dayBlack[self.#toXY] = 1;
          env.log.info('pilot: (%s) 不可行军(163)，本场拉黑。', self.#toXY);
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          wake();
          return;
        }
        if (
          rej === REJ_NEED_PLANE ||
          rej === REJ_BOSS_AREA ||
          rej === REJ_PLANE_TAKEN ||
          rej === REJ_SAME_AREA_PLANE
        ) {
          // 平台侧问题：不黑 BOSS 本体，只黑这个平台，下一拍会选另一个平台
          if (self.#toTag === KIND_BOSS_PLANE) self.#dayBlack[self.#toXY] = 1;
          env.log.info('pilot: (%s) 平台不可用(%s)，本场拉黑该平台，改选别的。', self.#toXY, rej);
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          wake();
          return;
        }
        env.log.info(
          'pilot: goto %s 被拒 (%s)，%ds 后重评。',
          self.#toKind,
          rej || 'code ' + (r && r.code),
          Math.round(tuning.rejectBackoffMs / 1000),
        );
        self.#clearTo();
        self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
        wake();
      })
      .catch(function (e) {
        env.log.debug('pilot: 8521 ack threw: %s', (e && e.message) || e);
        if (self.#toXY === myKey) {
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
        }
        wake();
      });
  }

  /**
   * 把某个坐标从商店锚点表里剔除（该店本场不可用：159 点不存在）。
   * @param {string} key 点位键
   */
  #dropShopAt(key) {
    if (!key || !this.#shops.length) return;
    const self = this;
    const before = this.#shops.length;
    this.#shops = this.#shops.filter(function (s) {
      return tileKey(s.x, s.y) !== key;
    });
    if (this.#shops.length !== before) {
      self.#env.log.info('pilot: 商店锚点剔除 (%s)，剩 %d 家。', key, this.#shops.length);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // S3 到点层
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 进入 WORK 相位（到达确认那一刻置位）；按到达点 pointType 选退出模式：
   *   172 → 'dwell'（G2 竞品 `cd_time.march = now + 20`：驻留 driveStayMonsterMs 等拍宠/交战结算）；
   *   173/163 → 'empty'（拿空即走，但不少于竞品口径的动态驻留）；161 → 'dwell'（让 shop.js 逐行买货）；
   *   176/174/其余 → 'dwell'（driveWorkDwellMs，让 boss.js 打仗）。
   * @param {string} key 到达点位键
   */
  #enterWork(key) {
    this.#toKind = '';
    this.#toXY = key;
    this.#toAt = 0;
    this.#workEmptyAt = 0;
    this.#workDeadline = 0;
    const env = this.#env;
    const base = env.secret.getRoomBaseInfo();
    const pt = Number((base && base.pointType) || 0);
    const d = env.cfg().drive || {};
    const now = Date.now();
    if (pt === PAB_MONSTER) {
      // G2 竞品到 172 后 `cd_time.march = ServerTime + 20`：本拍不重路由，等拍宠/交战把点数结算完
      this.#workMode = 'dwell';
      this.#workUntil = now + (Number(tuning.driveStayMonsterMs) || 0);
    } else if (pt === PAB_RESOURCE || pt === PAB_DROP) {
      this.#workMode = 'empty';
      this.#workUntil = pt === PAB_RESOURCE ? this.#resDwellMs(key) : 0;
      this.#workDeadline = now + tuning.driveWorkMaxMs;
    } else if (pt === PAB_SHOP) {
      const ms = Number.isFinite(d.shopDwellMs) ? d.shopDwellMs : tuning.driveShopDwellMs;
      this.#workMode = 'dwell';
      this.#workUntil = now + ms;
      this.#shopErrandDone = true;
      this.#shopLastAt = now;
      // G7 账本：到店就记 `time`（竞品 `shops[].time = ServerTime`，秒）——#shopStageWant 的 gap 就从这一刻重算
      const led = this.#shopLedger.get(key) || {
        time: 0,
        sausage: 0,
        piece: 0,
        visited: 0,
        sausageShelf: 0,
      };
      led.time = Math.floor(now / 1000);
      led.visited = 1; // 真到店（锚点建账播的初值不算）→ #pickShop 的 revisit 闸从这里开始生效
      this.#shopLedger.set(key, led);
      // G7 去重窗 + 竞品 `shop_stay_time` 路由锁：竞品到店就 `cd_time.march = ServerTime + 15`（L25268），
      //   停靠期内一次都不重评路由；我方此前只置 3s → 25s 驻留满即完全解锁，玩家手动拉出去的车会被开回同一家店
      //   （实战 20261101T200401 的根因 B：一局 11 次回店、另三家从未访问）。取 max(3000, driveShopStayMs)。
      this.#shopCoolUntil = now + Math.max(3000, Number(tuning.driveShopStayMs) || 0);
      // 到店第一件事：**把商店引擎从 10 分钟轮巡里叫醒**。它只在被唤醒时才看「现在是否在店里」，
      //   而本车只停 driveShopDwellMs（默认 25s）——不叫醒就是「到店也不买货」。
      if (typeof env.kickShop === 'function') env.kickShop();
    } else {
      this.#workMode = 'dwell';
      this.#workUntil = now + tuning.driveWorkDwellMs;
    }
    if (this.#escapeFrom && key === tileKey(this.#escapeFrom.x, this.#escapeFrom.y)) {
      this.#escapeFrom = null;
    }
    env.log.info('pilot: arrived %s (pt=%s)，进入 %s 相位。', key, pt, this.#workMode);
  }

  /**
   * G7 账本口径的「白跑惩罚」：锚点里**每家店都已试过**却仍判「缺香肠」
   *   → 说明缺口补不满（买不起/额度买完/缺刷新币），商店档先进长冷却（driveShopGapCooldownMs）；
   *   否则会形成「离店→缺口仍在→又开回同一家店」的永动。
   * 旧的判据是「每家 `sausage>0`」（四家都真买到过香肠），因 #pickShop 当时不换店而**永不成立**（根因 D）；
   *   现按「去过了就算试过」算：真服务过（visited）且（买到过 或 货单上根本没香肠）。
   * @returns {boolean}
   */
  #shopAllTried() {
    if (!this.#shops.length || !this.#shopLedger.size) return false;
    for (let i = 0; i < this.#shops.length; i++) {
      const k = tileKey(this.#shops[i].x, this.#shops[i].y);
      const led = k ? this.#shopLedger.get(k) : null;
      if (!led || !led.visited) return false; // 还有没去过的店 → 该换下一家，不是「都试尽」
      if (Number(led.sausage) > 0) continue; // 这家买到过香肠
      if (Number(led.sausageShelf) === 0) continue; // 货单上根本没香肠（刷过也没有）→ 视为已试尽
      return false; // 在架却还没买到（买不起/额度未刷新）→ 保留重试理由
    }
    return true;
  }

  /**
   * 173 井的竞品口径驻留（verbatim `min(res_stay_time, 未拿件数 × 0.8 + 1.1)` 秒）：
   *   「未拿件数」优先取 21522 按点记账的空位数（bagFree+buffFree），没记账就用快照 iNum 兜底。
   *   我方主判据仍是「拿空即走」，本值作**最短驻留**（给 8527/8538 应答落地留时间），
   *   并以 driveWorkMaxMs 为天花板，避免「到点秒走 → 拾取动作还没发出就离点」。
   * @param {string} key 点位键
   * @returns {number} 毫秒（0=不加下限）
   */
  #resDwellMs(key) {
    let n = 0;
    const c = this.#change.get(key);
    if (c) n = Math.max(0, (Number(c.bagFree) || 0) + (Number(c.buffFree) || 0));
    if (!n) {
      const t = this.#tiles.get(key);
      n = t && t.iNum != null ? Math.max(0, Number(t.iNum) || 0) : 0;
    }
    const dyn =
      n * (Number(tuning.driveResStayPerBagMs) || 0) + (Number(tuning.driveResStayBaseMs) || 0);
    const cap = Number(tuning.driveResStayMaxMs) || 0;
    const ms = cap > 0 ? Math.max(cap, dyn) : dyn;
    return Math.max(0, Math.min(tuning.driveWorkMaxMs, ms));
  }

  /**
   * WORK 相位一拍推进。
   * @param {number} now 毫秒
   * @returns {{leave:boolean,sleep:number}}
   */
  #workTick(now) {
    const env = this.#env;
    if (this.#workMode === 'empty') {
      if (this.#isTileEmpty(this.#toXY)) {
        if (!this.#workEmptyAt) this.#workEmptyAt = now;
        const d = env.cfg().drive || {};
        const settle = Number.isFinite(d.emptyDwellMs) ? d.emptyDwellMs : tuning.driveEmptyDwellMs;
        // G2 竞品口径的动态驻留作**地板**：拿空了也至少给 8527/8538 把这一批结算完
        const readyAt = Math.max(this.#workEmptyAt + settle, this.#workUntil || 0);
        if (now >= readyAt) return { leave: true, sleep: 0 };
        return { leave: false, sleep: readyAt - now };
      }
      this.#workEmptyAt = 0;
      if (now >= this.#workDeadline) {
        env.log.info('pilot: %s 未探到拿空、兜底上限离点。reason=empty_ceiling', this.#toXY);
        return { leave: true, sleep: 0 };
      }
      return { leave: false, sleep: Math.min(tuning.driveScanMs, this.#workDeadline - now) };
    }
    if (this.#workUntil && now < this.#workUntil)
      return { leave: false, sleep: this.#workUntil - now };
    return { leave: true, sleep: 0 };
  }

  /**
   * 点位是否已「拿空」：
   *   ① 过渡路：21522/21532 按点记账，res → bagFree==0 且 buffFree==0；drop → dropFree==0 且 beastFree==0；
   *   ② 当前态路：快照 173 的 `rTime` 落在未来（井已被抽空、正在刷新）或 163 的 `iNum<=0`。
   * @param {string} key 点位键
   * @returns {boolean}
   */
  #isTileEmpty(key) {
    if (!key) return false;
    const c = this.#change.get(key);
    if (c) {
      if (c.kind === 'res' && c.bagFree <= 0 && c.buffFree <= 0) return true;
      if (c.kind === 'drop' && c.dropFree <= 0 && c.beastFree <= 0) return true;
    }
    const t = this.#tiles.get(key);
    if (t) {
      if (t.pt === PAB_RESOURCE) return t.rTime > Date.now() && !(c && c.buffFree > 0);
      if (t.pt === PAB_DROP) return t.iNum != null && t.iNum <= 0;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 一拍决策
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 严格档产出下限（竞品 `marchResource(5 + Math.ceil(o.members.length / 2), 100)`）：
   *   基础值取 `driveResourceMinYield`（默认 5，与竞品同值）+ 队伍人数一半向上取整。
   * @returns {number}
   */
  #strictResMinNum() {
    const base = this.#env.secret.getRoomBaseInfo();
    const mem = base && Array.isArray(base.members) ? base.members.length : 0;
    return (Number(tuning.driveResourceMinYield) || 5) + Math.ceil(mem / 2);
  }

  /**
   * 阶段网关链（竞品B `autoLeader` 日常段 L24972-24980 的互斥四分支）：
   *   ① `exitStage` → `marchShop()`（收场档：只回店拿货，**不回落**到采井/打野）
   *   ② `shopStage` → `marchShop(1)`（高光窗档：同上，选店按「香肠还没买过」优先）
   *   ③ `beastStage` → `i==2 && marchTeam() || a<2 && marchBeast(4) || marchResource()`
   *   ④ 日常 → `i==2 && marchTeam() || a==1 && marchBeast(4) || marchResource(5+ceil(人数/2), 100)
   *        || a==0 && marchBeast(4) || marchResource() || marchShop()`
   *   竞品在 ③④ 前还有一道 `team_type>0 && 任一 BOSS state==23` 的让路闸（开台读秒中不派日常车）；
   *   「正停在 172 且还在拍宠」的让路闸我方由 `#captureBusy()` 常闭闸承担（更严：不看点型，**拍普通宠与拍大BOSS
   *   一律不挪**；旧口径「boss===1 不让路」已被 dashcam 20261101T200401 推翻，见该方法注）。
   *   商店的另外三档理由（勤务/缺香肠/持有缺口）是我方扩展，但只作为**链尾 `marchShop()` 那一下的选店排序与
   *   日志理由**，不拦路（以前提到 ③④ 之前先判，结果是「一进秘境就冲商店、出不来」，见 #shopWant 注）；
   *   定期去店由 ② shopStage 的 8min 节拍保证，与竞品一致。
   * @param {number} now 毫秒
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {string} curKey 当前点键
   * @param {number} curPt 当前点型
   * @param {object|null} win 本拍 BOSS 窗口
   * @returns {number|null} 数字=本拍已决策（下拍睡眠）；null=链上无动作，交给探索/兜底档
   */
  #stageChain(now, cur, curKey, curPt, win) {
    const why = this.#shopWant(now, this.#elapsedSec(now), curPt);
    this.#lastShopWhy = why;
    // ①② 竞品互斥档：命中就只去店（候选为空也只记一笔防重评，不去采井/打野——收场车不该再吃井）
    if (why === 'exit' || why === 'stage') {
      this.#stage = 'shop';
      this.#stageWhy = why;
      this.#lastBranch = 'shop';
      const at = this.#pickShop(curKey, cur, why === 'stage', why === 'exit');
      if (!at) this.#shopLastAt = now;
      this.#dispatch('shop', at);
      return at ? this.#sleepAfterDispatch() : tuning.driveScanMs;
    }
    // ③④⑤ 我方扩展档（勤务/缺香肠/持有缺口）**不再抢在日常链之前**：竞品把它们折进链尾 `marchShop()`，
    //   而我方实测（20261101T200401）这三档都是**电平理由**，一旦拦路就每拍赢过采井——「缺香肠」在 BOSS 投喂后
    //   会长期成立，于是车怎么都出不来商店。现在理由只喂给链尾那一下的选店排序与日志，不拦路。
    //   （旧口径「链尾永远轮不到」的成因是当时链尾那一次不查访问记忆，现由 #pickShop 的三道闸 + 链尾兜底共同保证）
    // 竞品日常链前置闸：`team_type>0` 且有 BOSS 正在开台（state23）→ 本拍不派日常车
    if ((Number(tuning.driveTeamType) || 0) && this.#bossFeeding()) {
      this.#stage = 'boss-wait';
      this.#lastBranch = 'boss-wait';
      this.#gateState('feed23', true, 'boss state=23');
      return tuning.driveScanMs;
    }
    this.#gateState('feed23', false, '');
    const marchPolicy = Number(tuning.driveMarchPolicy) || 0;
    const beastPolicy = Number(tuning.driveBeastPolicy) || 0;
    const minQ = Number(tuning.driveBeastMinQuality) || 4;
    const maxD = Number(tuning.driveStrictResMaxDist) || 100;
    const bossA = this.#bossScoutAnchor() || (win ? win.boss : null);
    const relax = this.#beastStageWant(now);
    // 把两档链拼成有序动作表（竞品的 `||` 短路就是按此顺序逐个试）
    const acts = [];
    if (marchPolicy === 2) acts.push('follow');
    if (relax) {
      if (beastPolicy < 2) acts.push('beast');
      acts.push('cruise');
    } else {
      if (beastPolicy === 1) acts.push('beast');
      acts.push('cruise-strict');
      if (beastPolicy === 0) acts.push('beast');
      acts.push('cruise');
      acts.push('shop');
    }
    this.#stage = relax ? 'beast-stage' : 'cruise';
    this.#stageWhy = relax ? 'beastStage' : 'daily';
    for (let i = 0; i < acts.length; i++) {
      const act = acts[i];
      // 严格档只是选点参数不同，发车档位名仍归 `cruise`（拉黑/消费账与宽松档共用一套口径）
      const kind = act === 'cruise-strict' ? 'cruise' : act;
      let cand;
      if (act === 'follow') cand = this.#pickFollow(curKey, cur);
      else if (act === 'beast') {
        // 竞品 marchBeast 开头的禁走窗（开台读秒后 0~180s 不拍野）：窗内直接跳过这一档
        cand = this.#beastLockNow(now) ? undefined : this.#pickBeast(curKey, cur, minQ, 99999);
      } else if (act === 'cruise-strict')
        cand = this.#pickResource(curKey, cur, bossA, this.#strictResMinNum(), maxD);
      // ④ 宽松档不再允许「快照里明确 0 件」的空井（竞品只有严格档）：实战 04:08 到 107,161、04:12 即判空走人，
      //   4 秒往返把一整趟 31~44s 的行军成本白烧掉，下一拍又被电平理由开回商店
      else if (act === 'cruise')
        cand = this.#pickResource(
          curKey,
          cur,
          bossA,
          Number(tuning.driveCruiseMinYield) || 0,
          99999,
        );
      // 链尾兜底去店（竞品 `|| marchShop()`）：有扩展理由时按「香肠还没买过」优先（marchShop(1) 口径）
      else cand = this.#pickShop(curKey, cur, !!why);
      if (!cand) continue;
      if (kind === 'shop' && why) {
        this.#env.log.info(
          'pilot: 链尾去店 reason=%s gap=%ss（不抢采井/打野，竞品口径）',
          why,
          String(this.#shopGapSec(now)),
        );
      }
      this.#lastBranch = kind;
      this.#idleSince = 0;
      this.#dispatch(kind, cand);
      return this.#sleepAfterDispatch();
    }
    return null;
  }

  /**
   * 一拍决策阶梯（顺序即优先级；一拍最多发一笔 8521）。永不 reject。
   * @returns {number} 下拍睡眠（毫秒）
   */
  #tick() {
    const env = this.#env;
    this.#ticks++;
    this.#lastTickAt = Date.now();
    this.#lastBranch = '';
    this.#stage = '';
    this.#stageWhy = '';
    if (!env.alive()) {
      this.#lastBranch = 'dead';
      return 0;
    }
    if (!env.realmActive()) {
      this.#lastBranch = 'realm-off';
      return tuning.driveScanMs;
    }
    const b = env.cfg().drive;
    if (!b || !b.enabled) {
      this.#lastBranch = 'cfg-off';
      return tuning.driveScanMs;
    }
    const now = Date.now();
    if (now < this.#cooldownUntil) {
      this.#lastBranch = 'cooldown';
      this.#gateState('cooldown', true, 'left=' + (this.#cooldownUntil - now) + 'ms');
      return Math.min(this.#cooldownUntil - now, tuning.driveScanMs);
    }
    this.#gateState('cooldown', false, '');

    const base = env.secret.getRoomBaseInfo();
    if (!base || !base.startPoint) {
      this.#lastBranch = 'no-base';
      return tuning.driveScanMs;
    }

    // 换场复位：fightBeginTime 变化 = 新一场秘境
    const fb = toNum(base.fightBeginTime);
    if (fb > 1e11 && fb !== this.#matchFightBegin) {
      this.#matchFightBegin = fb;
      this.#matchStartAt = fb;
      this.#shops = [];
      this.#shopsAt = 0;
      this.#group = 0;
      this.#consumed = new Map();
      this.#marched = new Map();
      this.#change = new Map();
      this.#dayBlack = {};
      this.#shopErrandDone = false;
      this.#shopLastAt = 0;
      this.#shopCoolUntil = 0;
      this.#lastShopWhy = '';
      this.#shopLedger = new Map();
      this.#bossDone = {};
      this.#lastReviveAt = 0;
      this.#reviveInFlight = false;
      this.#viewMarch = new Set();
      this.#viewMarchAt = 0;
      this.#realmClosed = false;
      this.#idleSince = 0;
      this.#viewAt = 0;
      this.#viewMiss = 0;
      this.#viewOff = false;
      this.#told = {};
    }
    // 计时基准兜底：fightBeginTime 缺失时用首拍时刻，否则「开局暖机/大BOSS 前勤务」永远不触发
    if (!(this.#matchStartAt > 1e11)) this.#matchStartAt = now;
    if (this.#realmClosed) {
      this.#lastBranch = 'realm-closed';
      return tuning.driveScanMs * 4;
    }

    // S0：锚点（表格商店坐标，与镜头无关）
    this.#syncAnchors(base);

    const S = env.secret.getNMarchState();
    const arrived = S && S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    const cur = {
      x: Math.floor(toNum(base.startPoint.x)),
      y: Math.floor(toNum(base.startPoint.y)),
    };
    const curKey = tileKey(cur.x, cur.y);
    const curPt = Number(base.pointType) || 0;
    const moored = Number(base.marchState) === arrived && env.secret.teamIsMooring();

    // ── 在途相位：只推进「到达复核 / 超时兜底」，绝不重评路由 ──────────────
    if (this.#toKind) {
      this.#lastBranch = 'to';
      this.#stage = 'to';
      if (Number(base.marchState) === arrived && curKey && curKey === this.#toXY) {
        this.#enterWork(curKey);
        return 0; // 到点当拍即重评：空井可立刻走
      }
      if (now - this.#toAt > tuning.driveMarchTimeoutMs) {
        this.#lastBranch = 'to-timeout';
        env.log.info('pilot: goto %s 超时未到，记消费重评。reason=march_timeout', this.#toKind);
        this.#consume(this.#toXY);
        this.#clearTo();
        return tuning.driveScanMs;
      }
      // ⚠ 不按剩余超时睡满 90s：到达/被拒可能靠 push 或异步应答回来，而那一拍已返回、无人唤醒
      //   → 实测「42s 零 tick、相位已清空却仍在睡」。短轮询（≤2 个兜底拍）代价可忽略。
      return Math.min(this.#toAt + tuning.driveMarchTimeoutMs - now, tuning.driveScanMs * 2);
    }

    // ── 驻留相位：让到点引擎（拾取/商店/攻打/拍宠）干活 ──────────────────
    if (this.#workMode) {
      this.#lastBranch = 'work';
      this.#stage = 'work';
      const w = this.#workTick(now);
      if (!w.leave) return w.sleep;
      const wk = this.#toXY;
      // 竞品到点即锁：离店后 `cd_time.march`（shop_stay_time=15s）内整条路由链不重评——
      //   治「25s 驻留满 → 下一拍又被电平理由开回商店」（根因 B）。#consume 的 10min 只黑那一个点，
      //   本闸黑的是**全部**候选（含另三家店），语义与竞品的全局路由锁一致。
      if (curPt === PAB_SHOP) {
        const stay = Math.max(0, Number(tuning.driveShopStayMs) || 0);
        if (stay) this.#cooldownUntil = now + stay;
      }
      this.#toXY = '';
      this.#workMode = '';
      this.#workEmptyAt = 0;
      this.#workDeadline = 0;
      this.#workUntil = 0;
      // BOSS 相关点（176/177/178）驻留满**不记消费**：攻打未完时走人等于把平台弃在战斗中，
      //   且它们不靠消费账防重派（下一拍由 #bossWindow 决定去留，窗口散了自然落下去巡航）。
      let bossPoint = false;
      if (wk) {
        const wt = this.#tiles.get(wk);
        bossPoint = !!wt && isBossish(wt.pt);
      }
      if (!bossPoint) this.#consume(wk);
    }

    // ── 常闭闸 ────────────────────────────────────────────────────────────
    this.#gateState('leader', !env.secret.isTeamLeader(), '');
    if (!env.secret.isTeamLeader()) {
      this.#lastBranch = 'not-leader';
      return tuning.driveScanMs;
    }
    if (!moored) {
      this.#lastBranch = 'not-moored';
      this.#gateState('notarrived', true, 'marchState=' + base.marchState);
      return tuning.driveScanMs;
    }
    this.#gateState('notarrived', false, '');
    if (this.#captureBusy()) {
      this.#lastBranch = 'capture';
      this.#note('capturing', 'pilot: 正在拍异能兽/BOSS，等拍完再挪点。');
      return 3000;
    }
    if (env.secret.isSecretSending(CMD_MARCH_MOVE)) {
      this.#lastBranch = 'inflight';
      if (!this.#inflightStuckSince) this.#inflightStuckSince = now;
      const stuck = now - this.#inflightStuckSince;
      if (stuck >= tuning.driveMarchTimeoutMs) {
        // 幽灵条目自愈：NetMgrSimple 只在收到同 cmd 应答时清缓存，应答丢失即永堵
        env.log.warn(
          'pilot: 8521 通道在途标记堵塞 %ds 且已停泊（疑似幽灵条目），绕闸发一笔探测包自愈。',
          Math.round(stuck / 1000),
        );
        this.#inflightStuckSince = 0;
        const probe = this.#pickResource(curKey, cur, null) || this.#explorePoint(cur);
        this.#dispatch('cruise', probe, true);
        return this.#sleepAfterDispatch();
      }
      return 200;
    }
    this.#inflightStuckSince = 0;

    // ── ① 受击逃袭（保命先于一切收益）────────────────────────────────────
    if (this.#threat) {
      this.#lastBranch = 'threat';
      this.#stage = 'evade';
      if (curPt !== PAB_TENT && curPt !== PAB_COMMON_PLANE) {
        this.#dispatch('evade', this.#pickSafeTent(curKey, cur));
        return this.#sleepAfterDispatch();
      }
      return tuning.driveScanMs;
    }
    // ── ② 回攻（威胁解除且逃离点是 BOSS 相关点）─────────────────────────
    if (this.#returnPending) {
      this.#lastBranch = 'return';
      this.#stage = 'return';
      const win = this.#bossWindow(now, cur);
      if (!win || win.mode !== 'open') {
        this.#returnPending = false;
        this.#escapeFrom = null;
      } else {
        this.#dispatch('return', win.boss);
        return this.#sleepAfterDispatch();
      }
    }
    // ── ③ 当前点正被 PVP → 原地应战（交战中挪队只会把部队撒在路上）─────────
    const curTile = this.#tiles.get(curKey);
    const curPvp =
      !!curTile && (curTile.state === ST_PVP_READY || curTile.state === ST_PVP_FIGHTING);
    this.#gateState('curpvp', curPvp, curPvp ? '(' + curKey + ') state=' + curTile.state : '');
    if (curPvp) {
      this.#lastBranch = 'curpvp';
      return tuning.driveScanMs;
    }

    // ══ S0：主动视口（本拍的候选池）══════════════════════════════════════
    const win = this.#bossWindow(now, cur);
    const bossAnchor = win ? win.boss : null;
    // 开台/开打期间以 BOSS 为中心拉（要它邻域的平台）；否则以自己为中心
    if (bossAnchor) this.#refreshView(bossAnchor.x, bossAnchor.y);
    else this.#refreshView(cur.x, cur.y);

    // ── ④ 已停 BOSS 相关点：窗口还开着才 HOLD（攻打/投喂/石头归 boss.js）──
    //   ⚠ v2 的 HOLD 没有出口 → BOSS 窗散了车还钉在平台上「整场不动」。这里窗口一散就落下去巡航。
    if (isBossish(curPt)) {
      if (win) {
        this.#lastBranch = 'hold';
        this.#stage = 'hold';
        this.#gateState('hold', true, 'pt=' + curPt + ' mode=' + win.mode);
        return tuning.driveScanMs;
      }
      this.#gateState('hold', false, '');
    } else {
      this.#gateState('hold', false, '');
    }

    // ── ⑤ BOSS 档：state21 开打 → 直接打 BOSS 本体；state22 读秒窗 → 先上邻域平台 ──
    //   G7：竞品 `if (team_type > 0)` 才走 BOSS 档（team_type==0 = 只拿百兽箱，不碰 BOSS）
    if (win && b.boss !== false && (Number(tuning.driveTeamType) || 0) > 0) {
      if (win.mode === 'open') {
        const onPlane = curPt === PAB_BOSS_PLANE;
        const esrB = this.#bossEsrId(win.boss);
        const esrCur = curTile && curTile.esrId ? curTile.esrId : null;
        const sameArea = !esrB || !esrCur || esrB === esrCur;
        this.#stage = 'boss-open';
        if (onPlane && sameArea) {
          this.#lastBranch = 'boss-fight';
          this.#dispatch('boss', { x: win.boss.x, y: win.boss.y });
        } else {
          this.#lastBranch = 'boss-plane';
          this.#dispatch(KIND_BOSS_PLANE, this.#pickPlane(win.boss, curKey));
        }
        return this.#sleepAfterDispatch();
      }
      if (win.mode === 'lead' && curPt !== PAB_BOSS_PLANE) {
        this.#stage = 'boss-lead';
        this.#lastBranch = 'boss-lead';
        const plane = this.#pickPlane(win.boss, curKey);
        if (plane) {
          this.#dispatch(KIND_BOSS_PLANE, { x: plane.x, y: plane.y });
          return this.#sleepAfterDispatch();
        }
        // 平台还没进来（901 在途）→ 短睡等一刀，别白睡 5s
        if (this.#viewBusy || (this.#viewAt && now - this.#viewAt < tuning.driveViewMs * 2)) {
          return 400;
        }
        this.#note(
          'no-plane',
          'pilot: BOSS 开台读秒窗内找不到可用平台（视口无 176/174 或全被占），本拍放弃上平台。reason=no_plane',
        );
      }
    }

    // ── ⑥⑦ 阶段网关链（竞品 autoLeader 四分支）：收场/高光窗去店 → 跟人 → 打野 → 采井（严格/宽松）→ 链尾去店 ──
    const chainSleep = this.#stageChain(now, cur, curKey, curPt, win);
    if (chainSleep != null) return chainSleep;

    // ── ⑧ 探索档：视口里连续无货 → 主动开一段换视野（原地等刷新 = 替别人排队）──
    if (this.#shouldExplore(now)) {
      const spot = this.#explorePoint(cur);
      if (spot) {
        this.#idleSince = now;
        this.#exploreSpin++;
        this.#stage = 'explore';
        this.#lastBranch = 'explore';
        this.#note(
          'explore',
          'pilot: 视口内无可去点已超 ' +
            Math.round(tuning.driveIdleExploreMs / 1000) +
            's，主动开往 (' +
            spot.x +
            ',' +
            spot.y +
            ') 换视野。reason=idle_explore',
        );
        this.#dispatch('explore', spot);
        return this.#sleepAfterDispatch();
      }
    }

    // ── ⑨ 真的没点：若 901 在途，短睡等它 ──────────────────────────────────
    this.#dispatch('cruise', null);
    if (this.#viewBusy) return 400;
    return this.#sleepAfterDispatch();
  }

  /**
   * 选逃袭落点：就近未被 PVP 的营帐（175）/通用平台（174）。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @returns {{x:number,y:number}|null}
   */
  #pickSafeTent(curKey, cur) {
    const self = this;
    let best = null;
    let bestD = Infinity;
    this.#tiles.forEach(function (t) {
      if (t.pt !== PAB_TENT && t.pt !== PAB_COMMON_PLANE) return;
      if (t.k === curKey) return;
      if (self.#dayBlack[t.k]) return;
      if (t.state === ST_PVP_READY || t.state === ST_PVP_FIGHTING) return;
      if (t.isFight) return;
      if (t.teams > 1) return; // 至少留一个位
      const d = dist(t.x, t.y, cur.x, cur.y);
      if (d < bestD) {
        bestD = d;
        best = { x: t.x, y: t.y };
      }
    });
    return best;
  }

  /**
   * 是否在拍异能兽/**大BOSS**（`capturingPetPos.x>0`，push 21530 写、结束推 `{x:-1,y:-1}`）——拍宠中一律不挪点。
   *   ⚠ **旧口径「只拦拍普通宠（`boss!==1`）」已被 dashcam 20261101T200401 推翻**：大BOSS 投喂/拍宠窗
   *   （`boss===1`、瓦片 `state=23`，实测窗长 39.2s）把队伍开走同样会丢掉己方这一窗的捕获进度，
   *   且竞品的「任一 BOSS state==23 不派日常车」让路闸与之一致（见本文件阶段网关链注）。
   *   不依赖额外兜底：游戏侧每 10s 自愈把 capturingPetPos 打回 `{x:-1,y:-1}`（verbatim
   *   PabWorldUINew.updateCapturingData），收窗后 drive 在 `tuning.driveScanMs` 内恢复。
   * @returns {boolean}
   */
  #captureBusy() {
    const pab = this.#env.secret.getPabController();
    const cap = pab && pab.capturingPetPos;
    if (!cap) return false;
    return toNum(cap.x) > 0;
  }

  /**
   * 无候选静默计时：首拍只记起点，满 tuning.driveIdleExploreMs 才返回真。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #shouldExplore(now) {
    if (!(tuning.driveIdleExploreMs > 0)) return false;
    if (!this.#idleSince) {
      this.#idleSince = now;
      return false;
    }
    return now - this.#idleSince >= tuning.driveIdleExploreMs;
  }

  /** 清除 TO 相位标记。 */
  #clearTo() {
    this.#toKind = '';
    this.#toTag = '';
    this.#toXY = '';
    this.#toAt = 0;
  }

  /**
   * 记一次消费（点位解禁 = now + TTL）。
   * @param {string} key 点位键
   */
  #consume(key) {
    if (!key) return;
    const now = Date.now();
    this.#consumed.set(key, now + tuning.driveConsumedTtlMs);
    this.#consumed.forEach(function (until, k) {
      if (until !== -1 && until <= now) this.#consumed.delete(k);
    });
    this.#marched.forEach(function (until, k) {
      if (until <= now) this.#marched.delete(k);
    });
  }

  /**
   * 发完一笔后的下拍睡眠：发出 → 0（由 TO 相位接住）；没发出 → 兜底。
   * @returns {number}
   */
  #sleepAfterDispatch() {
    return this.#toKind ? 0 : tuning.driveScanMs;
  }

  /**
   * 一次性 info 提示（同 key 只打一次，防逐拍刷屏）。
   * @param {string} key 提示键
   * @param {string} msg 文本
   */
  #note(key, msg) {
    if (this.#told[key]) return;
    this.#told[key] = 1;
    this.#env.log.info(msg);
  }

  /**
   * 闸门状态边沿日志（进入/恢复各一条 info），让「一次都没动」可从日志定责。
   * @param {string} name 闸名
   * @param {boolean} on 本拍是否被拦
   * @param {string} detail 附注
   */
  #gateState(name, on, detail) {
    this.#gateNow[name] = on ? detail || 1 : 0;
    const k = 'gate|' + name;
    const tail = detail ? ' ' + detail : '';
    if (on && !this.#told[k]) {
      this.#told[k] = 1;
      this.#env.log.info('pilot: 闸[%s]拦住，方向盘不动。reason=%s%s', name, name, tail);
    } else if (!on && this.#told[k]) {
      delete this.#told[k];
      this.#env.log.info('pilot: 闸[%s]放行。reason=%s%s', name, name, tail);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 启动：订阅 21534/10018/21529/21521/21535/21522/21532（退订由 reactor 托管）+ 建循环并点火。
   * @param {object} ctx reactor 上下文
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    this.#tiles = new Map();
    this.#shops = [];
    this.#shopsAt = 0;
    this.#group = 0;
    this.#viewAt = 0;
    this.#viewBusy = false;
    this.#viewMiss = 0;
    this.#viewOff = false;
    this.#viewDbg = null;
    this.#marched = new Map();
    this.#consumed = new Map();
    this.#dayBlack = {};
    this.#cooldownUntil = 0;
    this.#realmClosed = false;
    this.#matchFightBegin = 0;
    this.#matchStartAt = 0;
    this.#shopLastAt = 0;
    this.#shopCoolUntil = 0;
    this.#lastShopWhy = '';
    this.#shopErrandDone = false;
    this.#idleSince = 0;
    this.#shopLedger = new Map();
    this.#bossDone = {};
    this.#lastReviveAt = 0;
    this.#reviveInFlight = false;
    this.#viewMarch = new Set();
    this.#viewMarchAt = 0;
    this.#exploreSpin = 0;
    this.#inflightStuckSince = 0;
    this.#threat = false;
    this.#escapeFrom = null;
    this.#returnPending = false;
    this.#clearTo();
    this.#workMode = '';
    this.#workUntil = 0;
    this.#workEmptyAt = 0;
    this.#workDeadline = 0;
    this.#change = new Map();
    this.#ticks = 0;
    this.#lastTickAt = 0;
    this.#lastBranch = '';
    this.#lastDispatch = '';
    this.#pickDbg = null;
    this.#gateNow = {};
    this.#told = {};
    if (ctx && ctx.on && typeof ctx.on.push === 'function') {
      ctx.on.push(PUSH_SELF_ATTACKED, function (ev) {
        if (self.#active && env.realmActive()) self.onWarnPush(ev);
      });
      ctx.on.push(PUSH_TILE_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onTilePush(ev);
      });
      ctx.on.push(PUSH_TEAM_ARRIVE, function () {
        if (self.#active && env.realmActive()) self.onArriveWake();
      });
      ctx.on.push(PUSH_BASE_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onBasePush(ev);
      });
      ctx.on.push(PUSH_BOSS_STATE, function () {
        if (self.#active && env.realmActive() && self.#cycle) self.#cycle.kick();
      });
      ctx.on.push(PUSH_RESOURCE_CHANGE, function (ev) {
        const body = changeBody(ev);
        if (body && self.#active && env.realmActive()) self.onResChange(body);
      });
      ctx.on.push(PUSH_DROP_CHANGE, function (ev) {
        const body = changeBody(ev);
        if (body && self.#active && env.realmActive()) self.onDropChange(body);
      });
    } else {
      env.log.warn('pilot: ctx.on.push unavailable, cannot subscribe 21534/10018 (engine idle).');
    }
    this.#cycle = createCycle({
      log: env.log,
      alive: function () {
        return self.#active && env.alive();
      },
      run: function () {
        return self.#tick();
      },
      fallback: tuning.driveScanMs,
    });
    this.#cycle.kick();
    env.log.info(
      'pilot v3 started (锚点表商店 + BOSS 权威坐标 + 901 主动视口; boss/shop/cruise/explore; leader-only).',
    );
  }

  /**
   * 调试快照（只读，不参与判定）：`pocketcc.secretRealmDrive.debugState()`。
   *   v3 新增 `anchors`（表商店坐标）/ `view`（901 状态）/ `pick`（选点计数）/ `stage`（本拍阶段）。
   * @returns {object}
   */
  debugState() {
    const now = Date.now();
    const tiles = [];
    this.#tiles.forEach(function (t) {
      tiles.push({
        key: t.k,
        pt: t.pt,
        x: t.x,
        y: t.y,
        state: t.state,
        iNum: t.iNum,
        rTime: t.rTime,
        teams: t.teams,
        esrId: t.esrId,
        src: t.src,
        ageMs: t.at ? now - t.at : null,
      });
    });
    const byPt = {};
    tiles.forEach(function (t) {
      byPt[t.pt] = (byPt[t.pt] || 0) + 1;
    });
    const consumed = [];
    this.#consumed.forEach(function (until, k) {
      consumed.push({ key: k, until: until });
    });
    const marched = [];
    this.#marched.forEach(function (until, k) {
      marched.push({ key: k, until: until });
    });
    const change = [];
    this.#change.forEach(function (v, k) {
      change.push({
        key: k,
        kind: v.kind,
        bagFree: v.bagFree,
        buffFree: v.buffFree,
        dropFree: v.dropFree,
        beastFree: v.beastFree,
        ageMs: v.at ? now - v.at : null,
      });
    });
    const shopLedger = [];
    this.#shopLedger.forEach(function (v, k) {
      shopLedger.push({
        key: k,
        time: v.time,
        sausage: v.sausage,
        piece: v.piece,
        visited: v.visited,
        sausageShelf: v.sausageShelf,
      });
    });
    let cfgDrive;
    try {
      cfgDrive = this.#env.cfg().drive;
    } catch (e) {
      cfgDrive = '(threw: ' + ((e && e.message) || e) + ')';
    }
    let sausage = null;
    try {
      sausage = this.#env.secret.getItemNumById(ITEM_SAUSAGE);
    } catch (e) {
      /* 读不到就只在诊断面显示 null */
    }
    return {
      version: 3,
      active: this.#active,
      ticks: this.#ticks,
      lastTickAgoMs: this.#lastTickAt ? now - this.#lastTickAt : null,
      lastBranch: this.#lastBranch,
      lastDispatch: this.#lastDispatch,
      stage: this.#stage,
      stageWhy: this.#stageWhy,
      gate: Object.assign({}, this.#gateNow),
      phase: {
        toKind: this.#toKind,
        toXY: this.#toXY,
        toAgoMs: this.#toAt ? now - this.#toAt : 0,
        workMode: this.#workMode,
        workLeftMs: this.#workUntil ? this.#workUntil - now : 0,
        workDeadlineLeftMs: this.#workDeadline ? this.#workDeadline - now : 0,
        returnPending: this.#returnPending,
        threat: this.#threat,
        cooldownLeftMs: this.#cooldownUntil ? Math.max(0, this.#cooldownUntil - now) : 0,
        realmClosed: this.#realmClosed,
        shopErrandDone: this.#shopErrandDone,
        shopCoolLeftMs: this.#shopCoolUntil ? Math.max(0, this.#shopCoolUntil - now) : 0,
        // 商店判决链的快照（全部纯读，不拨冷却）：上一拍的 #shopWant 理由 + gap/节拍 + 两道封顶闸
        shopWhy: this.#lastShopWhy,
        shopGapSec: this.#shopGapSec(now),
        shopIntervalSec: Math.round((Number(tuning.driveShopIntervalMs) || 0) / 1000),
        shopStageWanted: this.#shopStageWant(now),
        shopAllTried: this.#shopAllTried(),
        shopLastLeftMs: this.#shopLastAt
          ? Math.max(0, this.#shopLastAt + (Number(tuning.driveShopIntervalMs) || 0) - now)
          : 0,
        inflightStuckSinceAgoMs: this.#inflightStuckSince ? now - this.#inflightStuckSince : 0,
        marchIn: this.#viewMarch.size,
        marchInAgeMs: this.#viewMarchAt ? now - this.#viewMarchAt : null,
        bossFeeding: this.#bossFeeding(),
        beastStage: this.#beastStageWant(now),
        reviveInFlight: this.#reviveInFlight,
        lastReviveAgoMs: this.#lastReviveAt ? now - this.#lastReviveAt : null,
      },
      cfgDrive: cfgDrive,
      anchors: {
        shops: this.#shops.slice(),
        group: this.#group,
        atAgoMs: this.#shopsAt ? now - this.#shopsAt : null,
      },
      // G7 每店账本（竞品 state.shops 同口径：time 秒 / sausage / piece）
      shopLedger: shopLedger,
      view: {
        off: this.#viewOff,
        busy: this.#viewBusy,
        lastAgoMs: this.#viewAt ? now - this.#viewAt : null,
        miss: this.#viewMiss,
        last: this.#viewDbg,
      },
      pick: this.#pickDbg,
      sausage: sausage,
      matchFightBegin: this.#matchFightBegin,
      matchStartAt: this.#matchStartAt,
      elapsedSec: this.#matchStartAt ? Math.round((now - this.#matchStartAt) / 1000) : null,
      idleSec: this.#idleSince ? Math.round((now - this.#idleSince) / 1000) : 0,
      tiles: { size: tiles.length, byPt: byPt, detail: tiles },
      consumed: consumed,
      marched: marched,
      dayBlack: Object.keys(this.#dayBlack),
      // G9 到场打过的 BOSS 跳过账（竞品 state.boss）
      bossDone: Object.keys(this.#bossDone),
      told: Object.keys(this.#told),
      change: change,
    };
  }

  /** 停止：置死 #active、收循环与全部本地账（事件退订由 reactor 统一摘）。 */
  stop() {
    this.#active = false;
    this.#cycle = null;
    this.#tiles = new Map();
    this.#shops = [];
    this.#marched = new Map();
    this.#consumed = new Map();
    this.#dayBlack = {};
    this.#threat = false;
    this.#escapeFrom = null;
    this.#returnPending = false;
    this.#clearTo();
    this.#workMode = '';
    this.#workUntil = 0;
    this.#workEmptyAt = 0;
    this.#workDeadline = 0;
    this.#change = new Map();
  }
}
