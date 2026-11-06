/**
 * 自动驾驶引擎（异能秘境唯一的「方向盘」：决定下一个去哪；其余引擎都是「到点即干活」）。
 *
 * 数据三源（候选池不靠 push 积累）：
 *   • 商店：读表 `enigma_secret_realm_building`，`build_type===3 && group===本房间`，`coords="x,y"`——
 *     四个商店是固定建筑，坐标与镜头无关（空表/读不到时 5s 后重试，表在进图后才下发）。
 *   • BOSS：服务器权威坐标 `bossBaseInfo[].pos`。
 *   • 资源/平台：901 GET_WORLD_INFO 每 `tuning.driveViewMs`(3s) 以自己（或开台中的 BOSS）为中心主动拉
 *     `{x,y,k,rid:0,width:20,height:30,marchInfo:true}`，结果并入 `#tiles`（`src:'v'` 覆盖 push 的旧值）；
 *     连续失败 `driveViewOffAfter` 次 → `#viewOff` 降级（仍可开商店/BOSS，巡航退回 push+探索），`driveViewRetryMs`(60s) 后重试。
 *   push 10018 是「镜头扫过才推」的增量包，只作兜底——候选池若只靠它，会被镜头位置限死在 2~3 个点上。
 *
 * 四层：S0 数据 `#syncAnchors`/`#awaitView`(串行 await 901→`#ingestView` 落账) → S1 阶段 `#bossWindow`（21 开打 / 22 开台读秒）/`#shopWant`
 *   → S2 动作 `#pickBoss`/`#pickShop`/`#pickPlane`/`#pickResource`/`#pickExplore` → `#dispatch`
 *   → S3 到点 `#enterWork`（161 驻留让 shop.js 买货；173/163 拿空即走；176/177 交给 boss.js）。
 *
 * 阶段网关链（互斥短路）：收场/拍宠高光窗去店 → 跟人 → 打野 → 采井（严格/宽松）→ 链尾兜底去店。
 *   去店理由共五档：`exit`（该收场，只拿货，抢在链前且不吃到店冷却）、`stage`（距上次到店 8min；读秒结束后
 *   120~180s 的拍宠高光期砍到 2min）两档拦路；`errand`（大BOSS 前定点勤务）、`sausage`（41011 < `driveSausageTarget`）、
 *   `gap`（用户持有清单有缺口）三档是**电平理由**，只喂给链尾那一下的选店排序与日志，不拦路——
 *   拦路则每拍赢过采井（「缺香肠」在 BOSS 投喂后长期成立），车就出不来商店。
 *   前置闸：开局 warmup（`fightBegin + 63s`）、开台前 0~120s 禁店窗、到店冷却（不拦 `exit`）；
 *   `team_type > 0` 且有 BOSS 正在开台（state23）→ 本拍不派日常车；拍宠中（`#captureBusy()`）一律不挪队。
 *
 * 选点判据：回合开门 `enigma_secret_realm[esrId].roundid → enigma_secret_realm_timer.start`，未到
 *   `fightBegin+start` 的点不算候选；别人的在途行军（`marchList[].state==1`，`march_policy==1` 时不查）指向的点不算候选；
 *   BOSS 候选过 `guard_policy` 四档过滤，到场打过即记账（本场不再选），巡航的 BOSS 引力锚恒取「第一个石头奖励还没人领的
 *   BOSS」；野怪品质取 scout.js 情报账，未侦察到按 2 计；严格档产出下限 `driveResourceMinYield(5) + ceil(队伍人数/2)`、
 *   距离上限 100；巡航评分 `iNum − 距起点/2 − 距无香肠店/5`，商店引力锚取「还没买过香肠的店里最近的一家」，
 *   已派车的点 `driveMarchedTtlMs`(60s) 内不再选。
 *   成本项缺锚时必须算 **0**（`Infinity / 5` 仍是 Infinity 且 truthy，`|| 0` 不生效 → score 恒 -Infinity，一个点都选不中）。
 *
 * 每店账本（点位键 → `{time 秒, sausage, piece}`，跨场保留）：`stage` 档的 gap 从到店那一刻重算，选店先选没买过香肠的；
 *   访问记忆三道闸 = 60s 防手抖 + `max(3000, driveShopStayMs)` 同点去重 + 「每家店都已试过却仍缺料」的白跑惩罚。
 *   到点驻留：172 → `driveStayMonsterMs` 等拍宠/交战结算；173/163 → 拿空即走，地板 `min(res_stay_time, 未拿件数×0.8+1.1)` 秒；
 *   161 → `driveShopStayMs` 让 shop.js 逐行买货。
 *
 * 其它：TO 相位短轮询（不睡满 90s）；到达双路确认（`roomBaseInfo.startPoint` 复核 + 超时兜底）；
 *   拿空双料源（21522/21532 CHANGE 按点账 + 快照 `rTime`/`iNum` 当前态）；目标 == 当前点不发 8521；
 *   在途幽灵条目自愈（`isSecretSending(8521)` 久堵且已停泊 → 绕闸发探测包）；受击逃营帐 + 回攻 / 当前点被 PVP 原地应战；
 *   战败自救：21521 落地 `deadType===1 && dataConfig(3056) > reviveNum` → 8552 `{uid}`（面板可关）。
 *
 * 拒绝码处置（§11，20261101T200401 真机报文验证后定稿）：157 已在该点 → 直接进 WORK；158 在途 → 正常形态不记；163 不能行军 → 60s marched 冷却（竞品语义，不永久拉黑）；
 *   159 目标点不存在 → 拉黑该点（店则从锚点表剔除）；141 请先上平台 → 本拍改选平台；
 *   142/252 平台不在同区/已被占 → 拉黑该平台；209 同区互挪 → 60s marched 冷却（拒绝取决于当前停泊位，同点稍后可成功，报文实证，不拉黑）；17 战场即将封闭 → 本场停手；159 点不存在 → 拉黑。
 *
 * 只读 + 发包红线：全程只读 ACL 快照与配置表；写动作只有 `sendMarch`（8521）与 8552 复活；901 是只读查询。
 * 仅队长发车（8521 驱动队级那一条行军）。触发：单条 createCycle + kick 源 21534/21529/21521/21535/901 应答。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import { tileKey as utilTileKey, dist as utilDist } from './util.js';
import { PLANS, matchStages, validatePlan, validateCtxKeys } from './plans.js';
import {
  pickResource,
  pickBeast,
  pickShop,
  exitStageWant as exitStageWantPure,
  shopStageWant as shopStageWantPure,
  beastStageWant as beastStageWantPure,
} from './pilot-select.js';
import {
  CMD_MARCH_MOVE,
  CMD_REVIVE,
  CMD_ATTACK_SELF_TEAM,
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
  REJ_NOT_ARRIVED,
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

/**
 * 阶段 id → 本拍诊断面/发车 kind（只用于 `stage`/`lastBranch`/`lastDispatch` 与 #dispatch 的 `#toTag`）。
 * ⚠ 这张表是 probe 判读面的契约：`secret-realm-drive-probe.devtools.js` 靠
 *   `lastBranch` 的 `cruise/explore/shop/work/to` 分正常空转与卡点、靠
 *   `lastDispatch` 的 `shop|same` 认到店同点，改名就会把误判捧给使用者。
 * ⚠ `kind` 是 #dispatch 的 `#toTag`：拒码处理靠 `#toTag !== 'boss'`（159 不黑 BOSS 本体）与
 *   `#toTag === KIND_BOSS_PLANE`（只黑平台）分流，所以 bossFight 的 kind 必须仍是 `'boss'`
 *   （真实报文差分回放 2026-11-03 实钉：写成 obj 名 'bossFight'/'plane' 会同时破拒码语义与指纹对拍）。
 * ⚠ 粒度必须是**阶段 id**而非 obj 名：开台(lead)与开打(open)的平台档历史档位名不同
 *   （`boss-lead` vs `boss-plane`）、且 lead 命中不清闲逛计时（`noIdle`），obj 级映射给不了。
 * 未登记阶段：kind = obj 名（resource 归 'cruise'），branch 跟 kind；新增 BOSS/独占类阶段时先登记再接线。
 * @type {Object<string,{stage:string,branch:string,kind?:string,noIdle?:boolean}>}
 */
const STAGE_DIAG = {
  bossFight: { stage: 'boss-open', branch: 'boss-fight', kind: 'boss' },
  bossPlaneOpen: { stage: 'boss-open', branch: 'boss-plane', kind: KIND_BOSS_PLANE },
  bossPlaneLead: { stage: 'boss-lead', branch: 'boss-lead', kind: KIND_BOSS_PLANE, noIdle: true },
  shopExit: { stage: 'shop', branch: 'shop', kind: 'shop' },
  shopStage: { stage: 'shop', branch: 'shop', kind: 'shop' },
};

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
 * 欧氏格距。
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
 * 「读秒窗」判据的复用形（三处同式）：`abs(stateEndTime - now - base) < win`（毫秒）。
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
   *   固定性双重确认（2026-11-04）：用户口径「4 商店坐标任何一场不换」+ 本录制视口只扫到 2 家
   *   （(95,163)/(250,96)，pt=161）而表锚点给全 4 家——若从视口找店（v3 旧病）会永远缺另外两家。
   */
  #shops = [];
  /**
   * @type {Map<string,{time:number,sausage:number,piece:number,visited:number,sausageShelf:number}>}
   * 每店账本（点位键 → 该店记录）：
   *   `time`=最近一次到店（毫秒，定期轮巡与 3s 去重基准）、`sausage`/`piece`=该店货单上香肠/百兽箱货位的
   *   `getTime`（已购次数，>0 = 这家已经买过）。**跨场保留**（账本落盘持久化，只在为空时重建），
   *   因为百兽箱是 type3 全场共享额度，换场不会把已买记录洗掉。
   *   两个访问记忆字段（去店理由走链尾兜底，必须自带防重复）：`visited`=真到店服务过
   *   （0=锚点建账时播的初值，不吃 revisit 闸）；
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
   * @type {Set<string>} 最近一刀 901 里**在途行军（state==1）指向的点键**。
   *   本引擎自己那笔也算在内（在途时本就处 TO 相位不重评，不伤判定）；`march_policy==1`（跟队派）时不参与过滤。
   */
  #viewMarch = new Set();
  /** @type {number} `#viewMarch` 的采集时刻（毫秒）；超过 `driveMarchStaleMs` 未刷新就不参与在途过滤（防 901 掉线后集合永久毒化） */
  #viewMarchAt = 0;
  /**
   * @type {Array} 最近一刀 901 的**原样 pointList**（每点带 `m` 载荷）。
   *   窄筛（pilot-select）只吃本应答快照（§3.1/§5.1「不读累积池」），`#tiles` 归一会摊平 m，喂不得。
   */
  #viewPoints = [];
  /** @type {number} `#viewPoints` 的采集时刻（毫秒，0=未起） */
  #viewPointsAt = 0;
  /**
   * @type {Array<{bx:number,by:number,tx:number,ty:number,state:number,leaderUid:*}>}
   *   最近一刀 901 的**归一化行军清单**（api.queryWorldView 产物）：窄筛在途闸直接吃它，
   *   不读全局 marchList（§5.1「来源改为本应答的 marchList」）。
   */
  #viewMarchList = [];

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
  /** @type {Map<string,number>} 已派过车的点 → 解禁时刻（driveMarchedTtlMs） */
  #marched = new Map();
  /** @type {Map<string,number>} 消费账：点位键 → 解禁时刻（driveConsumedTtlMs） */
  #consumed = new Map();
  /**
   * @type {Object<string,number>} cd 账（毫秒时刻，与全局 Date.now 同口径；E 阶段迁 serverTime 时一并换）：
   *   `march`=行军最小间隔（竞品 cd_time.march：L24974 决策前 +3s，§2.3 唯一的「TO 锁」），
   *   `boss`/`beast`=对应 901 查询节流（§2.3）。闸门走 #can、记账走 #setCd，**一律先记后动**。
   */
  #cd = {};
  /** @type {Object<string,1>} 当日/本场拉黑的点（159 点不存在 / 平台被占 141/142/252）；163/209 不在此列（走 marched 60s） */
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
   *   到店时置 `now + max(3000, driveShopStayMs)`（3s 同点去重与驻留时长取大者）；
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
  /** @type {boolean} 本次威胁期内是否已扎过一次营（v4.1「边避边工」：扎营后落回常规阶梯继续收益，竞品 avoid_attacked 同旨） */
  #threatEvaded = false;
  /** @type {number} 战力差探针缓存有效时刻（毫秒绝对；到期重探，防威胁窗逐拍烧 8549） */
  #powerGapAt = 0;
  /** @type {number|null} 战力差探针缓存值（本队−来犯总和；null=证据不足） */
  #powerGapVal = null;
  /** @type {{x:number,y:number,pt:number,esrId:number|null}|null} 逃袭前的停泊现场（回攻需求源） */
  #escapeFrom = null;
  /** @type {boolean} 回攻待办 */
  #returnPending = false;
  /**
   * @type {Object<number,1>} 本场已到场打过的 BOSS（21521 落地时用 `targetPoint` 对上
   *   `bossBaseInfo[].pos` 记账，供 `guard_policy==2` 过滤）。
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
  /** @type {string} 本次 start 锁定的开车方案 id（§15.10 P2：首拍读 config.drive.drivePlan，整场不热切；未知 id 回落 'default'） */
  #planIdUsed = '';
  /** @type {string} 上次心跳落日志时的分支（分支跳变当拍立刻补一条，防 30s 采样漏掉相位跳变） */
  #lastLoggedBranch = '';
  /** @type {number} 上次心跳落日志的拍号（同拍多个 return 点只落一条） */
  #hbTick = 0;
  /** @type {string} 上次 census 副行全文（内容相同即抑制，与 log-collect 的折叠互补） */
  #lastCensusLine = '';
  /**
   * 方案↔引擎契约校验结果（三态）：
   *   `[]`＝未校验（构造/stop 复位后、首拍前）
   *   `null`＝首拍校验通过
   *   `string[]`＝违例列表（非空 → #tick 头部拒发车、长睡早退；probe 面板可见）
   * 违例不抛：createCycle 会 catch run() 抛错并 warn+fallback 重排，抛错=每拍刷屏噪音；
   * 改成「存违例 + 头部早退」，让下一拍也不再决策、把矛盾顶到面板上。
   * @type {string[]|null}
   */
  #contractErrs = [];
  /** @type {string[]} 本拍方案链命中的阶段与空/中记号（probe 对拍用） */
  #lastStageIds = [];
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
   * push 21534 攻击警告：num>0 置威胁并 kick；num=0 清威胁（转移即消警）。
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
      // 威胁解除 → 复位扎营位：下次再被盯上重新先扎一次营（v4.1 边避边工的周期单位=一次威胁窗）
      this.#threatEvaded = false;
    }
  }

  /** push 21529/21521：只 kick（到达最终判据是 `startPoint` 复核，不信事件时序）。 */
  onArriveWake() {
    if (!this.#env.alive()) return;
    if (this.#cycle) this.#cycle.kick();
  }

  /**
   * push 21521 BASE_INFO 落地，两个动作：
   *   ① 记账：`targetPoint` 对上某个 BOSS → 记「这个 BOSS 我已到场打过」，供 `guard_policy==2` 以同一口径排除重复目标；
   *   ② 自救：`deadType===1` 且 `dataConfig(3056) > reviveNum` → 发 8552 `{uid}`（战败不复活 =
   *      `teamIsMooring()` 永不成立 → 本引擎卡在 not-moored 直散场）。
   *   只读 + 发包红线：8552 是写动作，所以受面板 `driveRevive` 子闸与 `driveReviveGapMs` 限速双重约束。
   * @param {object} ev bus 事件（载荷仅作 base 读不到时的兼容路径）
   */
  onBasePush(ev) {
    const env = this.#env;
    if (!env.alive()) return;
    const base = env.secret.getRoomBaseInfo();
    if (base) {
      // ① 到场打过的 BOSS 记账（pos 全等比对）
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
                env.log.info(
                  'pilot: BOSS %d arrived on site, counted in skip ledger (guard_policy).',
                  bid,
                );
              }
              break;
            }
          }
        }
      }
    }
    // ② 战败自动复活
    this.#maybeRevive(base, ev);
    if (this.#cycle) this.#cycle.kick();
  }

  /**
   * 复活判据与发包（deadType/reviveNum 优先读 `roomBaseInfo`，缺字段再读 push 载荷）。
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
    if (deadType !== 1) return; // 1 = 战败待复活
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
    // §9.5 竞品发 8552 后 cd.march=now+2：复活落地前锁住行军，防同拍又发 8521 把刚复活的队拖走（先记后动）。
    this.#setCd('march', Number(tuning.driveReviveLockSec) || 2);
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
          'pilot: defeat, 8552 revive sent (attempt %d/%d, code=%s).',
          reviveNum + 1,
          limit,
          String(code),
        );
      })
      .catch(function (e) {
        self.#reviveInFlight = false;
        env.log.warn('pilot: 8552 revive threw: %s', (e && e.message) || e);
      });
  }

  /**
   * 账本写入口（由 shop.js 在 8540/8542/8543 应答后回调）：记本店的 `time/sausage/piece`。
   *   用应答 items 反查表回写同名字段：
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
      // 172 野怪已被哪一队号召集结（`!callTId || callTId == myTeamId` 闸：别人的集结兽不抢）
      callTId: m.callTId == null ? 0 : toNum(m.callTId),
      at: now,
      src: src,
    });
  }

  /**
   * 装锚点：**商店坐标读表**（`enigma_secret_realm_building`，`build_type===3 && group===本房间`，`coords="x,y"`）。
   *   四个商店是固定建筑，坐标与镜头无关，表里就有（游戏侧 initMiniMapBuildingItem 也用它画小地图图标）。
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
        'pilot: building table enigma_secret_realm_building not delivered yet, shop anchors pending retry.',
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
        'pilot: building table has no shop row for this group (build_type=3, group=' +
          g +
          '), shop tier falls back to viewport 161.',
      );
      return;
    }
    this.#shops = out;
    // 建账时把 `time` 播成当前时刻（秒）→ 开场首轮巡的计时基准是「建账那一刻」而不是 0
    //   （否则 gap 恒为天文数字，一进场就直奔商店）。
    const sec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < out.length; i++) {
      const sk = tileKey(out[i].x, out[i].y);
      if (sk && !this.#shopLedger.has(sk)) {
        // visited=0：只用于 #shopStageWant 的全局 gap 基准，不参与 #pickShop 的 revisit 闸（否则开局 8min 进不了任何店）
        this.#shopLedger.set(sk, { time: sec, sausage: 0, piece: 0, visited: 0, sausageShelf: 0 });
      }
    }
    env.log.info(
      'pilot: shop anchors loaded: %d (group=%d) -> %s',
      out.length,
      g,
      JSON.stringify(out),
    );
  }

  /**
   * 消化一刀 901 应答：并入 `#tiles`（归一）、留档原样 pointList/行军（喂 pilot-select 窄筛）、更新降级/诊断面。
   *   纯同步落账，无副作用外溢——`#awaitView` 与任何异步 901 回路都调它，保证「窄筛料源」只有一条写入口径。
   * @param {object} v queryWorldView 归一产物 {points,marches}
   * @param {number} cx 中心 x
   * @param {number} cy 中心 y
   */
  #ingestView(v, cx, cy) {
    const pts = Array.isArray(v.points) ? v.points : [];
    const t1 = Date.now();
    const byPt = {};
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p) continue;
      const pt = Number(p.pointType) || 0;
      this.#putTile(p, pt, t1, 'v');
      if (TRACKED_PT[pt]) byPt[pt] = (byPt[pt] || 0) + 1;
    }
    // 在途过滤的数据源：本刀视口里**所有在途行军（state==1）指向的点**
    //   （含我们自己那笔——在途时本就处于 TO 相位不重评，不伤判定）。
    const ms = Array.isArray(v.marches) ? v.marches : [];
    const vm = new Set();
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m || Number(m.state) !== 1) continue;
      const mk = tileKey(m.tx, m.ty);
      if (mk) vm.add(mk);
    }
    this.#viewMarch = vm;
    this.#viewMarchAt = t1;
    // 窄筛料源留档：原样 pointList + 本应答行军（#objective/#marchX 的 pilot-select 只吃这份快照）
    this.#viewPoints = pts;
    this.#viewPointsAt = t1;
    this.#viewMarchList = ms;
    this.#viewDbg = {
      at: t1,
      ok: true,
      center: cx + ',' + cy,
      points: pts.length,
      marches: ms.length,
      marchIn: vm.size,
      byPt: byPt,
    };
  }

  /**
   * 主动拉视口（**await 串行**，§0 竞品的灵魂）：以 (cx,cy) 为中心发 901，**拉完才回**，
   *   使紧随其后的 #runStages/#marchX 决策吃的是本应答快照，而非上一拍旧池（修旧「同拍 fire-and-forget 决策吃陈旧池」）。
   *   已在 `driveViewMs` 窗口内且未降级时**跳过重复查询**（心跳比窗口慢，正常每拍都会查；kick 抢拍则复用刚落料）。
   *   失败达 `driveViewOffAfter` 次 → 降级 `#viewOff`（`#viewPointsFresh` 随之回 null，选点自动退老 `#pickX` 池），`driveViewRetryMs` 后重试。
   * @param {number} cx 中心 x
   * @param {number} cy 中心 y
   */
  async #awaitView(cx, cy) {
    const env = this.#env;
    if (!(cx > 0) || !(cy > 0)) return;
    const now = Date.now();
    // 未降级 & 视口仍新鲜（≤driveViewMs）→ 不重复撞 901；降级期到 driveViewRetryMs 才重试一刀
    if (!this.#viewOff && this.#viewAt && now - this.#viewAt < (Number(tuning.driveViewMs) || 3000))
      return;
    if (
      this.#viewOff &&
      this.#viewAt &&
      now - this.#viewAt < (Number(tuning.driveViewRetryMs) || 60000)
    )
      return;
    this.#viewAt = now;
    let v = null;
    try {
      v = await env.secret.queryWorldView(cx, cy, { width: 20, height: 30, viewLevel: 1 });
    } catch (e) {
      env.log.debug('pilot: 901 threw: %s', (e && e.message) || e);
    }
    if (!env.alive()) return;
    if (!v) {
      this.#viewMiss++;
      this.#viewDbg = { at: now, ok: false, miss: this.#viewMiss, center: cx + ',' + cy };
      if (!this.#viewOff && this.#viewMiss >= tuning.driveViewOffAfter) {
        this.#viewOff = true;
        env.log.warn(
          'pilot: 901 GET_WORLD_INFO got no ack %d times in a row -> active view deemed unavailable, degrade to push+anchor mode (shops/BOSS still open, cruise falls back to push+explore). retry after %ds.',
          this.#viewMiss,
          Math.round(tuning.driveViewRetryMs / 1000),
        );
      }
      return;
    }
    this.#viewMiss = 0;
    if (this.#viewOff) {
      this.#viewOff = false;
      env.log.info('pilot: 901 active view recovered.');
    }
    this.#ingestView(v, cx, cy);
  }

  /**
   * 回合开门闸（打野/巡航/跟人共用同一个判据）：
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
   * 行军指向过滤：
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

  /**
   * 窄筛料源新鲜度闸（§3.1「决策只吃本应答快照」）：901 降级（`#viewOff`）/从未起过/
   *   快照超期（阀值取 `max(driveViewMs*3, driveMarchStaleMs)`，与在途过滤同尺）时回 null
   *   → 调用方降级走老 `#pickResource`（读累积 `#tiles` 池）。非 null 时是**原样** pointList。
   * @param {number} now 毫秒
   * @returns {Array|null}
   */
  #viewPointsFresh(now) {
    if (this.#viewOff) return null;
    if (!this.#viewPointsAt) return null;
    const win = Math.max(
      (Number(tuning.driveViewMs) || 3000) * 3,
      Number(tuning.driveMarchStaleMs) || 15000,
    );
    if (now - this.#viewPointsAt > win) return null;
    return this.#viewPoints;
  }

  /**
   * `#marched`（点键→过期毫秒）→ 竞品 `marched_list` 形状 `[{x,y,t:秒}]`（§5.1 闸 3a）。
   *   注意口径差：我方存的是「过期时刻」（`toAt + driveMarchedTtlMs`），竞品存的是「派发时刻」
   *   （L24717 `ServerTime - e.t < 60`）→ `t = (until - driveMarchedTtlMs) / 1000`。driveMarchedTtlMs=60000 恰等于竞品 60s 窗。
   * @returns {Array<{x:number,y:number,t:number}>}
   */
  #marchedListArr() {
    const out = [];
    this.#marched.forEach((until, k) => {
      if (!(until > 0)) return;
      const parts = String(k).split(',');
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      out.push({ x: x, y: y, t: Math.floor((until - tuning.driveMarchedTtlMs) / 1000) });
    });
    return out;
  }

  /** 是否有一个 BOSS 正处于 state23（开台读秒中）——日常链的让路闸。 */
  #bossFeeding() {
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return false;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].state) === ST_BOSS_FEED) return true;
    }
    return false;
  }

  /**
   * 打野档开头的禁走窗：任一 BOSS state22 且 `|end - now - 90s| < 90s`（读秒结束后
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
   * 任一店账本 `piece>0`（本场已买到过百兽箱）。竞品口径 `state.shops.find(piece==1)`，我方取 `>0` 超集（piece 只会 0/1，同效）。
   *   公开给 env.shopBoxBought（index.js）供 pickup §9.2 约束1 惰性读，免得两处各维护一套读账循环。
   * @returns {boolean}
   */
  isBoxBought() {
    let boxGot = false;
    this.#shopLedger.forEach(function (v) {
      if (v && Number(v.piece) > 0) boxGot = true;
    });
    return boxGot;
  }

  /**
   * 百兽期补给/状态闸（只用于「日常链走宽松档还是严格档」）。
   *   前置：任一店账本 `piece>0`（本组已买到过百兽箱）；否则不构成百兽期。
   *   `team_type==0` 直接为真；否则「所有 BOSS 都已 28/30 终局」为真，再否则过一长串备货闸：
   *   41002/41003 达到面板目标（面板未配 = 无要求）、香肠 ≥ `driveSausageTarget`、已装增益里
   *   至少 3 个 5 色（rss_station.buff_color）、背包高品质未拿满、且不在开台读秒后 0~180s 窗内。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #beastStageWant(now) {
    const env = this.#env;
    // 外部料预解析（引擎侧只读取数），判据公式一律交给 pilot-select 纯函数（§4.3）。
    const boxGot = this.isBoxBought();
    const list = env.secret.getBossBaseInfo();
    // 空清单 = 无 BOSS 未终局（vacuous true），与竞品「所有 state∈{28,30}」同口径（不再像旧实现那样早返 true 跳过备货闸）。
    let allCleared = true;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const st = s ? Number(s.state) || 0 : 0;
        if (st !== ST_BOSS_DEAD_END && st !== ST_BOSS_FIGHTING_END) {
          allCleared = false;
          break;
        }
      }
    }
    const items = env.cfg().pickItems || {};
    const probes = [ITEM_BANDAGE, ITEM_MEDKIT];
    let cureOk = true;
    let bandageOk = true;
    for (let i = 0; i < probes.length; i++) {
      const id = probes[i];
      const row = items[KEY_ITEM + id];
      const target = row ? Number(row.max) || 0 : 0;
      if (!(target > 0)) continue; // 面板未配该项 = 无要求（放行）
      const ok = env.secret.getItemNumById(id) >= target;
      if (id === ITEM_BANDAGE) bandageOk = ok;
      else cureOk = ok;
    }
    const sausageOk =
      env.secret.getItemNumById(ITEM_SAUSAGE) >= (Number(tuning.driveSausageTarget) || 10);
    const c5 = this.#buffColor5Count();
    const full = typeof env.petPackFull === 'function' ? env.petPackFull() : false;
    return beastStageWantPure({
      teamType: Number(tuning.driveTeamType) || 0,
      pieceShop: boxGot,
      allBossCleared: allCleared,
      cureOk: cureOk,
      bandageOk: bandageOk,
      sausageOk: sausageOk,
      // #buffColor5Count 回 -1 = 表行读不到/不参与（旧实现据此不拦），映成纯函数域的「已满足」：
      color5Count: c5 < 0 ? 3 : c5,
      beastsNotFull: !full,
      bossIn90sWindow: this.#beastLockNow(now),
    });
  }

  /**
   * 已装增益里的 5 色个数（逐项查 `roomBaseInfo.buffMap` 对应 `enigma_secret_realm_rss_station.buff_color==5`）。
   *   表行读不到（或行里没有 buff_color 字段）时回 -1 = **不参与判定**（宁可不拦，也不把整条链锁死）。
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

  /**
   * 禁店窗（到店节拍的第一道闸）：任一 BOSS 处于 state22 且 `|end - now - 60s| < 60s`，
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
   * 「该收场」三级判据：
   *   `i` = 任一店账本 `piece>0`（本组已在某店买到过百兽箱）；
   *   `a` = 有 BOSS 进入 state30（已被打死，本场 BOSS 收益已落袋）；
   *   `r` = 背包高品质（quality≥4）宠物数 ≥ 携带容量；
   *   `team_type` 取 0=i / 1=i&&a / 2=i&&a&&r，**任一档为假再用「本场战斗窗口已过」兜底**（`ServerMSTime >= fightEndTime`）。
   * @returns {boolean} true=该收场了（只去店拿货，不再采井/打野）
   */
  #exitStageWant() {
    const env = this.#env;
    let boxGot = false;
    this.#shopLedger.forEach(function (v) {
      if (v && v.piece > 0) boxGot = true;
    });
    const list = env.secret.getBossBaseInfo();
    const boss30 =
      Array.isArray(list) &&
      !!list.find(function (s) {
        return s && Number(s.state) === ST_BOSS_DEAD_END;
      });
    const beastsFull = typeof env.petPackFull === 'function' ? env.petPackFull() : false;
    // fightEndTime 读不到（非合法毫秒绝对时刻）时喂 Infinity，使纯函数的「serverMSTime>=end」兵底永不误触（对齐旧 #fightOver 的 `end>1e11` 闸）。
    const base = env.secret.getRoomBaseInfo();
    const end = toNum(base && base.fightEndTime);
    return exitStageWantPure({
      teamType: Number(tuning.driveTeamType) || 0,
      pieceShop: boxGot,
      boss30: !!boss30,
      beastsFull: !!beastsFull,
      serverMSTime: Date.now(),
      fightEndTime: end > 1e11 ? end : Infinity,
    });
  }

  /**
   * 收场判据的对外口（leave.js 复用同一份三级判据，避免两套「该收场」逻辑漂移）。
   * @returns {boolean}
   */
  exitStageWant() {
    return this.#exitStageWant();
  }

  /**
   * 到店节拍的 `gap`（秒）：`now秒 − max(各店账本 time)`。
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
   * 到店节拍的时间语义（`gap = now秒 − max(各店账本 time)`，节拍 `i = driveShopIntervalMs/1000`）：
   *   ① 任一 BOSS 处于「读秒**开始前** 0~120s」（state22 且 `abs(end-now-60s) < 60s`）→ 一律不去店（这段车要空出来挪平台）；
   *   ② `team_type==0`：只看 `gap > i`；
   *   ③ `team_type>0`：`gap > i` **或**「读秒结束后 120~180s 的拍宠高光窗且 `gap > 120s`」——
   *      这段拍宠高光窗的到店节拍砍到 2min（店里会刷出百兽箱/香肠）。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #shopStageWant(now) {
    const gap = this.#shopGapSec(now);
    if (gap == null) return false; // 锚点未建账 → 无法算 gap，不当「到轮了」（防每拍空转想去店）
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
    // 判据公式交给 pilot-select（§4.2）：高光窗子条件取纯函数内定的 120s（≡ driveShopNearEndGapMs/1000 默认值）。
    //   ⚠ 语义对齐竞品：team_type==0（纯采集不挪平台）只看节拍、不受禁店窗拦（旧实现对所有 tier 都先挡 lock）。
    return shopStageWantPure({
      teamType: Number(tuning.driveTeamType) || 0,
      sinceShopSec: gap,
      shopIntervalSec: Math.round((Number(tuning.driveShopIntervalMs) || 0) / 1000),
      bossOpeningSoon: this.#shopLockNow(now),
      nearEndWindow:
        nearEnd > 1e11 &&
        inOffsetWindow(nearEnd, now, tuning.driveShopNearEndMs, tuning.driveShopNearEndWinMs),
    });
  }

  /**
   * `guard_policy` 四档过滤（BOSS 候选）：
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
   * 巡航评分的 BOSS 引力锚：**第一个「石头奖励还没人领」的 BOSS**（不是当前窗口 BOSS）。
   *   评分里「距 BOSS/5」用它，于是即使眼下没开台，车也会往「还有石头可抢」的 BOSS 方向贴。
   *   全部都有记录 → 回 null，调用方退化用当前窗口 BOSS 或 0 成本。
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
   *   候选先过 `#bossGuardOk`（guard_policy 四档）；读秒过期且仍在宽限窗内的 state22 也产 `open` 候选
   *   （由调用方按「已上平台没」决定打 BOSS 还是先上平台），而不是直接 continue 把整场让掉。
   * @param {number} now 毫秒
   * @param {{x:number,y:number}} cur 当前停泊坐标
   * @returns {{boss:{x:number,y:number,bossId:number,state:number,endTime:number},mode:'open'|'lead',leftMs:number}|null}
   */
  #bossWindow(now, cur) {
    const env = this.#env;
    const list = env.secret.getBossBaseInfo();
    if (!Array.isArray(list) || !list.length) return null;
    // guard_policy 参照系：同一批对象引用按 pos.x 升序
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
      if (!this.#bossGuardOk(s, byX, rewardList)) continue; // 策略过滤
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
        //   判据是 `state==22 && stateEndTime < now` 即照打；开台档对这种 BOSS：**已上平台→打 BOSS，未上平台→先上平台**。
        //   不做「不在平台就 continue」（那等于把整场 BOSS 让掉）——交给 ⑥ 档的
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
   * 商店阶段判据（命中返回理由键供日志/诊断）。五档去店理由：前两档拦路，后三档只喂给链尾排序：
   *   ① `exit`：该收场了（**抢在链前**，收场只去拿货）；
   *   ② `stage`：到店节拍（距上次到店超 8min，或读秒结束后的拍宠高光窗且超 2min）（**抢在链前**）；
   *   ③ `errand`：大BOSS 前那趟定点勤务（elapsed ≥ driveShopPointsSec[0]，本场未办）；
   *   ④ `sausage`：香肠 41011 < tuning.driveSausageTarget；
   *   ⑤ `gap`：用户勾选的持有清单有缺口。
   * ⚠ ③④⑤ 不抢在日常链之前（#runStages 只用它们做**链尾兜底**的选店排序与日志）：
   *   这三档是**电平闸**（不受 shopStage 节拍约束），一旦拦路就每拍赢过采井——「缺香肠」在 BOSS 投喂后
   *   会长期成立，车一进秘境就直冲商店、驻留满又被拉回去。
   *   定期去店仍由 ② `stage`（8min 节拍）保证。
   * 前置闸：开局 warmup（`fightBegin + 63s`）、开台前 0~120s 禁店窗、到店冷却（不拦 exit）。
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
    // 到店节拍的第一道闸：任一 BOSS 开台前 0~120s → 这段路车要空出来挪平台，一律不去店
    if (this.#shopLockNow(now)) return '';
    if (this.#exitStageWant()) return 'exit';
    // 到店即进冷却：缺口补不满（无货/额度空/缺刷新币）时，否则会「离店→缺口仍在→又开回同一家店」永动。
    //   ⚠ 位置在 exit 之后：收场档只拿货、不吃永动风险（也不受商店冷却约束）。
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
          'pilot: pre-bigBOSS shop errand window passed (elapsed ' +
            Math.round(elapsedSec) +
            's > ' +
            Math.round(last * 1.5) +
            's), no more driving for it this match. reason=shop_expired',
        );
      } else {
        return 'errand';
      }
    }
    if (env.secret.getItemNumById(ITEM_SAUSAGE) < tuning.driveSausageTarget) {
      // 白跑惩罚：锚点里每家店都已**试过**（都买到过香肠，或货单上根本没香肠）却仍缺料 → 本拍补不满（买不起/
      //   额度买完/缺刷新币），进长冷却；否则会形成「离店→缺口仍在→又开回同一家店」的永动。
      if (this.#shopAllTried()) {
        const coolMs = Number(tuning.driveShopGapCooldownMs) || 600000;
        this.#shopCoolUntil = now + coolMs;
        this.#note(
          'shop-all-tried',
          'pilot: all four shops already tried (bought sausage or known not sold) yet still short on material, enter ' +
            Math.round(coolMs / 1000) +
            's long cooldown. reason=shop_all_tried',
        );
        return '';
      }
      return 'sausage';
    }
    // 用户配置的「持有清单有缺口」也算理由（让勾选立刻生效）
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
   *   排序口径：`e && i.sausage - a.sausage || dist(i) - dist(a)`——
   *   即「高光窗/轮巡档（e=1）」先选**本店还没买过香肠**的，同档才比距离；纯应急去店（e 未传）只看距离。
   * ⚠ 访问记忆闸（本函数必须自带记忆，否则会反复敲最近那一家）：
   *   已派车（#marched）/ 已消费（#consumed，离店即记 driveConsumedTtlMs）/ 真服务过且仍在 revisit 窗内的店
   *   先跳过，试下一家；四家都在闸内时自然回 null → 链尾不拦路，交给巡航/探索
   *   （去店理由走链尾兜底，所以必须自己记住访问过哪家：driveShopRevisitMs）。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {boolean} [bySausage=false] 按香肠账排序
   * @param {boolean} [urgent=false] 收场档：不吃 #consumed/revisit 长记忆，
   *   只留 60s 的 #marched 防手抖（收场本来就该反复回店拿货）
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
   * 打野档：172 野怪点，回合已开门 + 空闲置 + 没被别人的在途行军指向（`march_policy==1` 不查）
   *   + 不是别人的集结兽（`callTId`）+ 情报品质≥minQ + 距 0<d≤maxDist；
   *   排序：品质降序→距离升序。品质口径：**未侦察到回 2**，所以
   *   `driveBeastMinQuality` 默认 4 意味着**没囤到情报的野怪不去**（这就是 scout.js 存图的下游）。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {number} minQ 最小品质
   * @param {number} maxDist 距离上限（99999=不限）
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
      // 只去空闲野怪（`state == 0 && teams.length == 0`）且不是别人的集结目标
      if (t.state !== ST_NORMAL || t.teams > 0 || (t.callTId && myTeam && t.callTId !== myTeam)) {
        dbg.busy++;
        return;
      }
      if (self.#marchBlocked(t.x, t.y)) {
        dbg.march++;
        return;
      }
      const qRaw = typeof env.scoutQuality === 'function' ? env.scoutQuality(t.x, t.y) : null;
      const q = Number.isFinite(qRaw) ? Number(qRaw) : 2; // 未知品质当 2（默认闸 4 就筛掉）
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
   * 跟人档：在 173 井 / 172 野怪里找**已有人驻军、或有人在途飞向它**
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
   * 选 BOSS 邻域的平台（只认 176；esr 真值判区；驻军/在战斗/被他人在途指向的剔除，
   *   `state==22` 硬筛优先；占用三筛与远近向由 `drivePlanePolicy` 定，对齐竞品 plane_policy）。
   *   平台坐标只能从视口（901 以 BOSS 为中心拉的那一刀）或 push 拿——但 BOSS 本体坐标来自权威态，
   *   所以**再也不用"等镜头扫到 BOSS"**，只要 BOSS 已知，就以它为中心主动问一次。
   * @param {{x:number,y:number}} boss BOSS 坐标
   * @param {string} curKey 当前点键
   * @returns {object|null} 点位
   */
  #pickPlane(boss, curKey) {
    // esr 真值判定：本体瓦片的 esrId 在 lead 窗内首次 901 即缓存进 #tiles（实测 fight 前 105~522s），
    //   所以 #bossEsrId() 在做决策时永远非 null。服务器推送的直接归属关系，无需几何推断。
    const esr = this.#bossEsrId(boss);
    const self = this;
    // drivePlanePolicy（v4.1 实装，对齐竞品 plane_policy L24867-24868）：
    //   0=近优先（缺省，占用/在途三筛全开） / 1=无视占用与在途硬占（竞品 `plane_policy==1 ||` 短路同位） /
    //   2=远优先（竞品 `(policy < 2 ? 1 : -1)` 的距离方向位，打分取正）。
    const pol = Number(tuning.drivePlanePolicy) || 0;
    // §11（竞品 L24623）：平台候选**硬筛** `state===22`（可派兵/读秒窗）。报文实证：区域可判时
    //   关键相位（lead60/fight）同区 176 平台恒 state=22 → 硬筛不会把机会筛空；anyBest 兜底仅留给
    //   「判区失效」的改版退路。
    //   174 兜底删除：两场录制（20261011、20261101）全程 0 块，属无证据路径。
    let readyBest = null; // 硬筛集（state==22）内的最优
    let readyScore = -Infinity;
    let anyBest = null; // 兜底集（不看 state）的最优
    let anyScore = -Infinity;
    this.#tiles.forEach(function (t) {
      if (t.pt !== PAB_BOSS_PLANE) return;
      if (self.#dayBlack[t.k]) return;
      if (t.k === curKey) return; // 同点短路由 #dispatch 处理，这里只需给出目标
      // 占用三筛：policy==1（硬占派）整体短路（竞品 L24867 同位；到达可能撞 252/217 拒码，由拒码分流兜底）
      if (pol !== 1) {
        if (t.isFight) return; // 平台在战斗中（enigma_realm217）
        if (t.teams > 0) return; // 已有队伍驻军（enigma_realm252）
        // 差异B补齐（对齐竞品 L24867 `marches.find(target_tx/ty 命中)`）：别人的在途行军已指向该平台 → 不选，
        //   否则到达必撞 REJ_PLANE_TAKEN。复用巡航/打野同款闸：`driveMarchPolicy==1` 跟队派豁免、
        //   快照陈旧（driveMarchStaleMs）自动脱闸，不会因 901 降级而一锁锁死全部平台。
        if (self.#marchBlocked(t.x, t.y)) return;
      }
      // 区域硬筛：esr 真值判定（平台 esrId 100% 可得，BOSS esrId fight 前已缓存恒非 null）。
      //   缺证放行（防御：换图改版或极端时序，宁不拦不误拦，撞 142 拒码分流自会兜底）。
      if (esr && t.esrId && t.esrId !== esr) return;
      const d = dist(t.x, t.y, boss.x, boss.y);
      const score = pol >= 2 ? d : -d; // 0/1=近优先，2=远优先（竞品 L24868 方向位）
      if (t.state === ST_PLANE_MARCH && score > readyScore) {
        readyScore = score;
        readyBest = t;
      }
      if (score > anyScore) {
        anyScore = score;
        anyBest = t;
      }
    });
    return readyBest || anyBest;
  }

  /**
   * BOSS 本体所在区域的 esrId（从累积 #tiles 里取本体瓦片(177/178) 的 esrId；取不到回 null = 不做区域过滤）。
   *   报文实证：本体瓦片在 lead 窗内首次 901 即缓存（实测 fight 前 105~522s），所以决策时恒非 null。
   * @param {{x:number,y:number}} boss 坐标
   * @returns {number|null}
   */
  #bossEsrId(boss) {
    const t = this.#tiles.get(tileKey(boss.x, boss.y));
    return t && t.esrId ? t.esrId : null;
  }

  /**
   * 巡航选点（评分制）：
   *   `score = iNum − 距当前点/2 − 距 BOSS 引力锚/5 − 距香肠没买过的店/6`，取最高。
   *   过滤：只看 173/163；已消费/已派车/本场拉黑的剔除；`state` 非 0（非空闲）或 `teams>0`（有队伍）剔除；
   *   回合已开门（`#roundOpen(esrId)`）、没被别人的在途行军指向（`#marchBlocked`）；
   *   173 还要求 `iNum >= minNum` 且 `rTime` 不在未来（井已被抽空、正在刷新）；距当前点 ∈ (0, maxDist]。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {{x:number,y:number}|null} bossA BOSS 引力锚（由调用方传 `#bossScoutAnchor()`）
   * @param {number} [minNum=0] 最小产出（严格档 `5 + ceil(队伍人数/2)`）
   * @param {number} [maxDist=99999] 距离上限（严格档 100）
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
      // 回合开门闸：未刷出来的区域不算候选
      if (!self.#roundOpen(t.esrId)) {
        dbg.round++;
        return;
      }
      // 别人的在途行军已飞向该点 → 不抢（`march_policy==1` 时不查）
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
      //   bestScore 初值也是 -Infinity、`>` 恒假 → 一个点都选不中。
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
   * 评分用的商店引力锚：取**「还没买过香肠的店里最近的一家」**
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
   * 窄筛（§5.1）用的商店引力锚：取**「还没买过香肠的店里最近的一家」**，与 `#nearestShopA` 的
   *   关键差异 = **空则不回退**（竞品 L24718 `t.filter(e=>0==sausage).sort(byDist)[0]`：无一家免香肠店就
   *   不挂锚（成本项计 0），而 `#nearestShopA` 会退化成「全体最近一家」）。未建账的店视为 sausage=0（还没买过）。
   * @param {{x:number,y:number}} cur 当前坐标
   * @returns {{x:number,y:number}|null}
   */
  #nearestNoSausageShop(cur) {
    const self = this;
    let best = null;
    let bestD = Infinity;
    this.#shops.forEach(function (s) {
      const k = tileKey(s.x, s.y);
      const led = k ? self.#shopLedger.get(k) : null;
      if (led && Number(led.sausage) > 0) return; // 只留「还没买过香肠」的店
      const d = dist(cur.x, cur.y, s.x, s.y);
      if (d < bestD) {
        bestD = d;
        best = { x: s.x, y: s.y };
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
   * cd 闸门（§2.3 统一写法，纯读）：当前是否已过 `key` 的解禁时刻。true=可执行。
   *   账本空（未记）视为已过（放行）。时钟口径与 #setCd 一致（Date.now，E 阶段迁 serverTime 一并换）。
   * @param {string} key cd 键（'march'/'boss'/'beast'…）
   * @returns {boolean} true=已到点可执行
   */
  #can(key) {
    const until = this.#cd[key] || 0;
    return !(until > 0) || Date.now() >= until;
  }

  /**
   * cd 记账（§2.3：先赋后动，绝不「成功后才记」——超时/抛错时也不会把节拍打成一秒一发乱撞）。
   * @param {string} key cd 键
   * @param {number} sec 锁定时长（秒）
   */
  #setCd(key, sec) {
    if (!(sec > 0)) return;
    this.#cd[key] = Date.now() + sec * 1000;
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
        this.#note(
          'return-none',
          'pilot: counter-attack has no landable platform, switch to regular re-eval. reason=no_platform',
        );
      } else {
        this.#note(
          'none|' + kind,
          'pilot: ' +
            kind +
            ' tier has no usable point in candidate pool, hold and rescan. reason=no_candidate',
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
        'pilot: ' +
          kind +
          ' tier picked the current location (' +
          curKey +
          '), already in place, do not send 8521, go straight to dwell.',
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
    // 先记 cd 后发 8521（§2.3 硬要求：竞品 L24974 决策前即写 cd_time.march）——行军最小间隔的唯一「TO 锁」。
    //   对所有发车档统一记（BOSS/逃袭/回攻也顺带抬一次 march cd，与竞品 cd 语义一致，不单独网开一面）。
    this.#setCd('march', Number(tuning.driveMarchCdSec) || 3);
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
    // 派过车的点 60s 内不再选：治「到点没拿到→下一拍又选同一点」
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
            'pilot: realm entered closing phase (server returned ' +
              REJ_BATTLEFIELD_CLOSING +
              ' "battlefield closing soon"), all marches rejected, this match stops driving. reason=realm_closed',
          );
          wake();
          return;
        }
        if (rej === REJ_ALREADY_THERE) {
          self.#enterWork(self.#toXY);
          wake();
          return;
        }
        if (rej === REJ_NOT_ARRIVED) {
          // §11 158 在途未到=正常形态（上一笔 8521 还没落地，服务端拒绝新指令）：不记退避、不改相位，下一拍自然重评。
          return;
        }
        if (rej === REJ_POINT_NOT_EXIST) {
          // 目标点不存在（数据陈旧）→ 拉黑该点；若是商店锚点则一并脱表，下次选别家
          //   ⚠ BOSS 本体坐标来自权威态，撞 159 并不代表「BOSS 不存在」→ 只黑平台/巡航点，不黑 BOSS
          if (self.#toTag !== 'boss') self.#dayBlack[self.#toXY] = 1;
          self.#dropShopAt(self.#toXY);
          env.log.info(
            'pilot: (%s) target point not exist (159), blacklisted for this match.',
            self.#toXY,
          );
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          wake();
          return;
        }
        if (rej === REJ_NO_MARCH_TARGET) {
          // §11 163 不可行军：竞品语义「写 cd + 60s marched 冷却」而非“本场拉黑”。
          //   #marched 已在 #dispatch 前写入（L2002），60s 内自然不重选同点；不再写 #dayBlack。
          env.log.info(
            'pilot: (%s) cannot march (163), no re-pick for %ds.',
            self.#toXY,
            Math.round(tuning.driveMarchedTtlMs / 1000),
          );
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          wake();
          return;
        }
        if (rej === REJ_SAME_AREA_PLANE) {
          // §11 209「同一区域核心停泊平台之间不允许相互行军」：拒绝情境取决于**本队当前停泊位**，不是目标点固有属性。
          //   真机报文（20261101T200401）：998.7s (230,226) 吃 209 → 挪到 (238,216) → 1010.2s **同点行军成功**，
          //   故与 163 同档「60s marched 冷却」（#marched 已在派发前写入）而非本场拉黑；
          //   #pickPlane 只滤「与 BOSS 不同区域」，不防「与当前停泊同区域」，拉黑会白丢一个稍后即可用的平台。
          env.log.info(
            'pilot: (%s) same-area platform move forbidden (209), no re-pick for %ds (not blacklisted, may turn favorable after moving).',
            self.#toXY,
            Math.round(tuning.driveMarchedTtlMs / 1000),
          );
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          wake();
          return;
        }
        if (rej === REJ_NEED_PLANE || rej === REJ_BOSS_AREA || rej === REJ_PLANE_TAKEN) {
          // 平台侧问题：不黑 BOSS 本体，只黑这个平台，下一拍会选另一个平台
          if (self.#toTag === KIND_BOSS_PLANE) self.#dayBlack[self.#toXY] = 1;
          env.log.info(
            'pilot: (%s) platform unavailable (%s), blacklist this platform for this match, pick another.',
            self.#toXY,
            rej,
          );
          self.#clearTo();
          self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
          wake();
          return;
        }
        env.log.info(
          'pilot: goto %s rejected (%s), re-evaluate after %ds.',
          self.#toKind,
          rej || 'code ' + (r && r.code),
          Math.round(tuning.rejectBackoffMs / 1000),
        );
        self.#clearTo();
        self.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
        wake();
      })
      .catch(function (e) {
        env.log.warn('pilot: 8521 ack threw: %s', (e && e.message) || e);
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
      self.#env.log.info('pilot: shop anchor removed (%s), %d left.', key, this.#shops.length);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // S3 到点层
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 进入 WORK 相位（到达确认那一刻置位）；按到达点 pointType 选退出模式：
   *   172 → 'dwell'（驻留 driveStayMonsterMs 等拍宠/交战结算）；
   *   173/163 → 'empty'（拿空即走，但不少于动态驻留地板）；161 → 'dwell'（让 shop.js 逐行买货）；
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
      // 到 172 后本拍不重路由，等拍宠/交战把点数结算完
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
      // 账本：到店就记 `time`（秒）——到店节拍的 gap 就从这一刻重算
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
      // 去重窗 + 路由锁：到店后 driveShopStayMs 内整条链不重评，取 max(3000, driveShopStayMs)。
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
    env.log.info('pilot: arrived %s (pt=%s), enter %s phase.', key, pt, this.#workMode);
  }

  /**
   * 账本口径的「白跑惩罚」：锚点里**每家店都已试过**却仍判「缺香肠」
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
   * 173 井的最短驻留地板（`min(res_stay_time, 未拿件数 × 0.8 + 1.1)` 秒）：
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
        // 动态驻留作**地板**：拿空了也至少给 8527/8538 把这一批结算完
        const readyAt = Math.max(this.#workEmptyAt + settle, this.#workUntil || 0);
        if (now >= readyAt) return { leave: true, sleep: 0 };
        return { leave: false, sleep: readyAt - now };
      }
      this.#workEmptyAt = 0;
      if (now >= this.#workDeadline) {
        env.log.info(
          'pilot: %s scouted empty, hit fallback ceiling, leave point. reason=empty_ceiling',
          this.#toXY,
        );
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
   * 严格档产出下限：
   *   基础值取 `driveResourceMinYield`（默认 5）+ 队伍人数一半向上取整，距离上限 100。
   * @returns {number}
   */
  #strictResMinNum() {
    const base = this.#env.secret.getRoomBaseInfo();
    const mem = base && Array.isArray(base.members) ? base.members.length : 0;
    return (Number(tuning.driveResourceMinYield) || 5) + Math.ceil(mem / 2);
  }

  /**
   * 组装本拍只读上下文（plans.js 的 `Ctx` typedef）。**必须无副作用**：判据层只读这里。
   * 字段来源逐个对照 pilot.js 现状取数点，行为等价搬迁。
   * ⚠ 契约新增/删除字段必须同步 plans.js `CTX_KEYS`（首拍 validateCtxKeys 会卡，
   *   违例 → #tick 头部拒发车）。只改本函数不上清单 = 启动期报错。
   * @param {number} now
   * @param {{x:number,y:number}} cur
   * @param {string} curKey
   * @param {number} curPt
   * @param {object|null} win 本拍 BOSS 窗口
   * @returns {object} ctx
   */
  #buildCtx(now, cur, curKey, curPt, win) {
    const env = this.#env;
    const b = env.cfg().drive || {};
    const curTile = this.#tiles.get(curKey) || null;
    const esrB = win ? this.#bossEsrId(win.boss) : null;
    const esrCur = curTile && curTile.esrId ? curTile.esrId : null;
    // 区域一致判定：双方 esrId 真值比较（报文实证 esrB 在 fight 前已缓存恒非 null，平台 esrId 100% 可得）。
    //   缺证放行（防御性，撞 142 拒码分流自会兜底）。
    const sameArea = !esrB || !esrCur || esrB === esrCur;
    return {
      snap: { cur: cur, curKey: curKey, curPt: curPt, boss: win ? win.boss : null },
      shopWhy: this.#lastShopWhy,
      teamType: Number(tuning.driveTeamType) || 0,
      driveBoss: b.boss !== false,
      bossMode: win ? win.mode : null,
      onBossPlane: curPt === PAB_BOSS_PLANE,
      bossSameArea: sameArea,
      bossFeeding: this.#bossFeeding(),
      marchPolicy: Number(tuning.driveMarchPolicy) || 0,
      beastPolicy: Number(tuning.driveBeastPolicy) || 0,
      relax: !!this.#beastStageWant(now),
      beastLock: !!this.#beastLockNow(now),
      // ⚠ 纯读不起表：现状 #shouldExplore 的「未起表先起表(now)」副作用只发生在链全空走到梯尾
      //   那一拍（L2391/2465-2468）；eager 调用会让 BOSS 让位/收场独占拍提前起表、把探索档
      //   早开 ~30s（真实报文差分回放实钉）。起表改由 #runStages 尾部补。
      shouldExplore: this.#shouldExplore(now),
    };
  }

  /**
   * 目标原语 `Objectives[obj]`：把方案里的目标名翻成**选点调用**（B1 仍包老的 #pickX，
   * resource/beast/shop 换成 pilot-select 真窄筛是下一拍的事）。纯选择：不发 8521、
   * 不记账、不设冷却——那些一律留在引擎解释器里，保证「方案层可离线换方案」时引擎侧口径不变。
   * ⚠ 本 switch 的 case 名清单 = plans.js `OBJECTIVES`。新增/删除 case 请同步该清单，
   *   首拍 validatePlan 会卡住不一致的修改（违例 → #tick 头部拒发车）。
   * @param {string} obj
   * @param {object|undefined} params 方案语义参数
   * @param {object} ctx
   * @returns {object|{wait:boolean}|null} 候选点 / 让位标记 / 无
   */
  #objective(obj, params, ctx) {
    const snap = ctx.snap;
    switch (obj) {
      case 'bossFight':
        // 现状 L2358-2360：已停 BOSS 平台且与目标 BOSS 同区域 → 发 8521 打本体。
        //   ⚠ 这不是 boss.js 的活：它只接管**已停 BOSS 相关点**后的打仗/投喂/石头（isBossish 让位），
        //   「从平台开上本体」这一笔行军仍归方向盘；§14.2 方案①的让位到点层是 Phase C 的事。
        return snap.boss ? { x: snap.boss.x, y: snap.boss.y } : null;
      case 'plane':
        // win=null（quiet 拍/check_power 未命中）时 snap.boss 为空：回 null 让引擎落后续档，不踩空
        return snap.boss ? this.#pickPlane(snap.boss, snap.curKey) : null;
      case 'shop': {
        const p = params || {};
        // 优先级：exit（收场只拿货）=不优先香肠 / preferNoSausage（高光）=优先 / 链尾兜底=有去店理由时优先。
        const prefer = p.exit ? false : p.preferNoSausage ? true : !!ctx.shopWhy;
        // 商店坐标来自权威表（非 901 快照）→ 不受新鲜度闸限；表未下发时才退老路（视口 161 兜底）。
        if (this.#shops.length) {
          const now = Date.now();
          const self = this;
          const shops = this.#shops.map(function (s) {
            const k = tileKey(s.x, s.y);
            const led = k ? self.#shopLedger.get(k) : null;
            return {
              pos: { x: s.x, y: s.y },
              time: led ? Number(led.time) || 0 : 0, // 秒：最近一次真到店
              sausage: led ? Number(led.sausage) || 0 : 0, // >0 = 这家已买过香肠
            };
          });
          // §5.2 三连前置（暖机 63s / 全店共享 3s 冷却 / 已在 161 不重派）——链尾兜底同受此约束（本次最直接补丁点）。
          const sel = pickShop(shops, {
            serverMSTime: now,
            fightBeginTime:
              this.#matchFightBegin > 1e11 ? this.#matchFightBegin : this.#matchStartAt,
            curPointType: snap.curPt,
            preferNoSausage: prefer,
            startPoint: snap.cur,
          });
          this.#pickDbg = {
            src: 'table',
            seen: shops.length,
            best: sel ? tileKey(sel.x, sel.y) : '',
          };
          return sel ? { x: sel.x, y: sel.y } : null;
        }
        return this.#pickShop(snap.curKey, snap.cur, prefer, !!p.exit);
      }
      case 'beast': {
        // 禁走窗（开台读秒后 0~180s 不拍野）：窗内这一档直接跳过（§5.3 L24780 提前放弃）
        if (ctx.beastLock) return null;
        const minQ = Number(tuning.driveBeastMinQuality) || 4;
        const now = Date.now();
        const pts = this.#viewPointsFresh(now);
        if (pts) {
          const env = this.#env;
          const base = env.secret.getRoomBaseInfo();
          // 归属闸（§5.3）：teamId 是 Int64，经 toNum(→bits.int64ToNum) 取 double 后与 901 里被抹零的 callTId 同转 double 比。
          const sel = pickBeast(pts, {
            startPoint: snap.cur,
            minQuality: minQ,
            maxDist: 99999,
            isRoundOpen: (id) => this.#roundOpen(id),
            myTeamIdNum: toNum(base && base.teamId),
            qualityFor: (x, y) => {
              const r = typeof env.scoutQuality === 'function' ? env.scoutQuality(x, y) : null;
              return Number.isFinite(r) ? Number(r) : null;
            },
            marches: this.#viewMarchList,
            marchPolicy: Number(tuning.driveMarchPolicy) || 0,
          });
          this.#pickDbg = {
            src: 'view901',
            seen: pts.length,
            best: sel ? tileKey(sel.x, sel.y) + ' q=' + sel.quality : '',
          };
          return sel ? { x: sel.x, y: sel.y } : null;
        }
        return this.#pickBeast(snap.curKey, snap.cur, minQ, 99999);
      }
      case 'resource': {
        const bossA = this.#bossScoutAnchor() || snap.boss || null;
        const y = (params || {}).yield;
        // 三档只差选点参数：严格=产出下限+距离上限100，宽松=不允许「快照明确 0 件」的空井（几秒往返会白烧一整趟 31~44s 行军），默认=不限。
        let minNum;
        let maxDist;
        if (y === 'strict') {
          minNum = this.#strictResMinNum();
          maxDist = Number(tuning.driveStrictResMaxDist) || 100;
        } else if (y === 'loose') {
          minNum = Number(tuning.driveCruiseMinYield) || 0;
          maxDist = 99999;
        } else {
          minNum = 0;
          maxDist = 99999;
        }
        // 窄筛（§5.1 四道闸）优先：本刀 901 快照新鲜时只吃这份原样信封，不再读累积 `#tiles` 池，
        //   也**不**看 `rTime>now` 判空 / `consumed` 10min 黑名单 / 当日拉黑（竞品无此三闸，§5.1 实证）。
        //   快照不可用（901 降级/未起/超期）→ 降级走老 `#pickResource`（读累积 `#tiles` 池，保留 push 兑底）。
        const now = Date.now();
        const pts = this.#viewPointsFresh(now);
        if (pts) {
          const sel = pickResource(pts, {
            startPoint: snap.cur,
            serverTimeSec: Math.floor(now / 1000),
            minNum,
            maxDist,
            isRoundOpen: (id) => this.#roundOpen(id),
            marches: this.#viewMarchList,
            marchedList: this.#marchedListArr(),
            marchPolicy: Number(tuning.driveMarchPolicy) || 0,
            firstUnrewardedBoss: bossA,
            nearestNoSausageShop: this.#nearestNoSausageShop(snap.cur),
          });
          this.#pickDbg = {
            src: 'view901',
            seen: pts.length,
            best: sel ? tileKey(sel.x, sel.y) + ' score=' + sel.score.toFixed(2) : '',
          };
          return sel ? { x: sel.x, y: sel.y } : null;
        }
        return this.#pickResource(snap.curKey, snap.cur, bossA, minNum, maxDist);
      }
      case 'follow':
        return this.#pickFollow(snap.curKey, snap.cur);
      case 'explore':
        return this.#explorePoint(snap.cur);
      case 'wait':
        return { wait: true };
      default:
        return null;
    }
  }

  /**
   * 驾驶阶梯解释器（B1：取代原 #stageChain，并把 #tick 的 BOSS 档/日常链/探索档收成一趟）。
   * 三层切分：判据与顺序 = plans.js 方案数据；选点 = #objective；发包/记账/闸门/睡眠 = 本函数。
   * ⚠ 本拍必须复位 #gateNow 与各闸（原 #tick 头部职责挪到此处）：方案链每拍重写各闸状态，
   *   否则上一拍的 feed23/hold 残留会被 probe 读成「本拍还堵着」。
   * @param {number} now 毫秒
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {string} curKey 当前点键
   * @param {number} curPt 当前点型
   * @param {object|null} win 本拍 BOSS 窗口
   * @returns {number|null} 数字=本拍已决策（下拍睡眠）；null=链上无动作，交给兜底档
   */
  #runStages(now, cur, curKey, curPt, win) {
    const env = this.#env;
    this.#gateNow = {};
    this.#stage = '';
    this.#stageWhy = '';
    const why = this.#shopWant(now, this.#elapsedSec(now), curPt);
    this.#lastShopWhy = why;
    const ctx = this.#buildCtx(now, cur, curKey, curPt, win);
    // §15.10 P2 配置期选定：方案 id 只在**本次 start 后首拍**读一次 config.drive.drivePlan，整场不热切
    //   （防开跑中途换链把 mooring/#cd/防重派语义跨方案撕裂）；stop() 复位后下次 start 重读。
    //   E1 接面板下拉时仍走同一路径（改 config 后需重启驾驶才生效）。
    if (!this.#planIdUsed) {
      this.#planIdUsed = (env.cfg().drive || {}).drivePlan || 'default';
      env.log.info(
        'pilot: this drive plan=%s (picked at config time, no hot-switch during the match)',
        this.#planIdUsed,
      );
      // 方案↔引擎契约启动校验（剥 crystal_then_skill 后新增）。违例＝本场拒发车：
      //   不抛（createCycle 会 catch+warn+fallback 重排 → 每拍刷屏噪音），改存 #contractErrs，由 #tick 头部早退。
      //   修宪纪律见 plans.js 文件头「方案↔引擎契约」三条。
      const planErrs = validatePlan(PLANS[this.#planIdUsed], Object.keys(STAGE_DIAG));
      const ctxErrs = validateCtxKeys(ctx);
      if (planErrs.length || ctxErrs.length) {
        this.#contractErrs = planErrs.concat(ctxErrs);
        // errs 只打前 8 条：整串超长会被 log-collect 截到 MAX_MSG=2048，截断后反而看不清违例项。
        // 级判据：属「不变量违例 + 本场拒发车」，非偶发抛错 → error（见 core/log.js 第 1) 条）。
        env.log.error(
          'pilot: plan/contract violation, refuse to dispatch this match. plan=%s errs=%s total=%d',
          this.#planIdUsed,
          JSON.stringify(this.#contractErrs.slice(0, 8)),
          this.#contractErrs.length,
        );
        // 本拍不往下走（首拍也要拒发车）：与 #tick 头部早退保持同一语义、同一睡眠。
        this.#lastBranch = 'contract-violation';
        return tuning.driveScanMs * 8;
      } else {
        this.#contractErrs = null;
      }
    }
    const plan = PLANS[this.#planIdUsed] || PLANS.default;
    this.#lastStageIds = [];
    // 现状只有真走到⑥⑦日常链的那拍才落 stage='cruise/beast-stage' + why（L2082-2083）；
    //   BOSS 档/①②独占/读秒让路/lead短睡全程不碰。标志位把这条「到哪拍才赋值」的时序保住。
    let chainMarked = false;
    const list = matchStages(plan, ctx);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const dg = STAGE_DIAG[s.id] || null;
      const isChain =
        !dg &&
        (s.obj === 'follow' ||
          s.obj === 'beast' ||
          s.obj === 'resource' ||
          s.obj === 'explore' ||
          (s.obj === 'shop' && !s.terminal));
      if (isChain && !chainMarked) {
        this.#stage = ctx.relax ? 'beast-stage' : 'cruise';
        this.#stageWhy = ctx.relax ? 'beastStage' : 'daily';
        chainMarked = true;
      }
      // 严格/宽松档只是选点参数不同，发车档位名仍归 `cruise`（拉黑/消费账共用一套口径）
      const kind = dg && dg.kind ? dg.kind : s.obj === 'resource' ? 'cruise' : s.obj;
      const branch = dg && dg.branch ? dg.branch : kind;
      let cand;
      try {
        cand = this.#objective(s.obj, s.params, ctx);
      } catch (e) {
        env.log.warn(
          'pilot: objective primitive %s threw, defer to next tier. err=%s',
          s.obj,
          String((e && e.message) || e),
        );
        cand = null;
      }
      this.#lastStageIds.push(s.id + (cand && !cand.wait ? '=hit' : '=empty'));
      if (!cand) {
        if (s.terminal) {
          // ①②收场/高光独占拍：选不到店也不回落采井打野，只记防重评（L2043-2051）；
          //   BOSS 开打拍：找不到平台也发一笔 `boss-plane|none` 记账就终拍（L2357-2364），
          //   两者都不清零闲逛计时。
          if (s.obj === 'shop') this.#shopLastAt = now;
          this.#stage = dg.stage;
          if (s.obj === 'shop') this.#stageWhy = why; // BOSS 拍不碰 why（现状⑤从头到尾不赋）
          this.#lastBranch = branch;
          this.#dispatch(kind, null);
          this.#heartbeat(now);
          return s.obj === 'shop' ? tuning.driveScanMs : this.#sleepAfterDispatch();
        }
        if (s.id === 'bossPlaneLead') {
          // 串行模型下 901 已由 #autoLeader await 拉完（以 BOSS 为中心），不存在「在途未回」可等：
          //   #pickPlane 仍选不到平台就是真没有 → 记一笔后落回日常链（这就是它不标 terminal 的原因）。
          //   （旧「短睡 400 等一刀」在 fire-and-forget 时代防白睡 5s，串行 await 后既无在途可等、
          //     其 `viewAt` 判据又会恒真导致无限空转，故删除。）
          this.#note(
            'no-plane',
            'pilot: no usable platform found within BOSS open-countdown window (viewport lacks 176/174 or all occupied), give up boarding this tick. reason=no_plane',
          );
        }
        continue;
      }
      if (cand.wait) {
        // BOSS 开台读秒让路（现状 L2056-2061）：本拍不派日常车，也不发 8521
        this.#gateState('feed23', true, 'boss state=23');
        this.#stage = 'boss-wait';
        this.#lastBranch = 'boss-wait';
        this.#heartbeat(now);
        return tuning.driveScanMs;
      }
      if (s.terminal) {
        // ①②/BOSS 开打命中：本拍发完即终，**不清**闲逛计时（现状 L2043-2051/L2357-2360 无 `idleSince=0`）
        this.#stage = dg.stage;
        if (s.obj === 'shop') this.#stageWhy = why;
        this.#lastBranch = branch;
        this.#dispatch(kind, cand);
        this.#heartbeat(now);
        return this.#sleepAfterDispatch();
      }
      // §6.6 常规期行军 cd 前置（消费 #can，唯一 TO 锁的兑底）：日常链/探索档发车前须过 cd.march。
      //   串行模型下 TO 相位已在 #tick 头部挡住重评，本门只兜「拒码清相位后立刻被 kick 抢拍」这窗——
      //   紧邻上一笔 8521 未满 driveMarchCdSec(3s) 时先短睡等 cd 到点，别把节拍打成一秒一发乱撞。
      //   受约束档：resource/beast/shopTail/follow/explore；BOSS/收场/独占 terminal 档已提前 return，
      //   逃袭/回攻走 #tick 各自时序，梯尾空派发（无 cand、不发包）也不经此门。
      if (!this.#can('march')) {
        const cdLeft = Math.max(0, (this.#cd.march || 0) - Date.now());
        this.#lastBranch = branch + '-cd';
        this.#heartbeat(now);
        return Math.min(cdLeft + 50, tuning.driveScanMs);
      }
      if (s.obj === 'explore') {
        this.#idleSince = now;
        this.#exploreSpin++;
        this.#stage = 'explore';
        this.#lastBranch = 'explore';
        this.#note(
          'explore',
          'pilot: no go-to point in viewport for over ' +
            Math.round(tuning.driveIdleExploreMs / 1000) +
            's, proactively drive to (' +
            cand.x +
            ',' +
            cand.y +
            ') to refresh view. reason=idle_explore',
        );
      } else {
        if (dg) this.#stage = dg.stage; // bossPlaneLead 命中：stage='boss-lead'（L2368-2373）
        this.#lastBranch = branch;
        if (!dg || !dg.noIdle) this.#idleSince = 0; // 日常链命中才清；开台拍不清（现状如此）
        if (s.id === 'shopTail' && why) {
          env.log.info(
            'pilot: chain-tail go-shop reason=%s gap=%ss (do not preempt mine/wild)',
            why,
            String(this.#shopGapSec(now)),
          );
        }
      }
      this.#dispatch(kind, cand);
      this.#heartbeat(now);
      return this.#sleepAfterDispatch();
    }
    // 链全空走到梯尾的拍（＝现状落到⑧/⑨的那拍；任何命中/独占/让路路径都已提前 return）：
    //   先补旧实现⑧ `#shouldExplore` 当年的「未起表就起表」副作用（L2465-2468，含开关闸），
    //   再按⑨发一笔空派发记账、看 901 是否还在途决定短睡/长睡。
    if (tuning.driveIdleExploreMs > 0 && !this.#idleSince) this.#idleSince = now;
    // ⑨ 梯尾空派发记账（串行模型下 901 已 await 完，不再「短睡等在途」）：无候选记一笔、按常规睡眠。
    this.#dispatch('cruise', null);
    this.#heartbeat(now);
    return this.#sleepAfterDispatch();
  }

  /**
   * 一拍决策阶梯（引擎安全前置 + 主树 await）。永不 reject。
   * @returns {Promise<number>} 下拍睡眠（毫秒）
   */
  async #tick() {
    const env = this.#env;
    this.#ticks++;
    this.#lastTickAt = Date.now();
    this.#lastBranch = '';
    this.#stage = '';
    this.#stageWhy = '';
    // 契约违例 → 拒发车：不做任何决策、不派 8521，长睡避免空转；probe 面板 contractErrs 可见。
    //   修宪路径：同步 plans.js CTX_KEYS/OBJECTIVES/STAGE_DIAG 或回滚方案侧改动，然后重启驾驶。
    if (this.#contractErrs && this.#contractErrs.length) {
      this.#lastBranch = 'contract-violation';
      this.#heartbeat(Date.now());
      return tuning.driveScanMs * 8;
    }
    if (!env.alive()) {
      this.#lastBranch = 'dead';
      this.#heartbeat(Date.now());
      return 0;
    }
    // 早退闸边沿日志（realm-off/cfg-off/no-base）：使「一次都没动」在日志里必然是某条
    //   gate blocked/passed，而不是空白；#gateState 只记跳变，不逐拍刷屏。
    this.#gateState('realm-off', !env.realmActive(), '');
    if (!env.realmActive()) {
      this.#lastBranch = 'realm-off';
      this.#heartbeat(Date.now());
      return tuning.driveScanMs;
    }
    const b = env.cfg().drive;
    this.#gateState('cfg-off', !b || !b.enabled, 'drive.enabled=false');
    if (!b || !b.enabled) {
      this.#lastBranch = 'cfg-off';
      this.#heartbeat(Date.now());
      return tuning.driveScanMs;
    }
    const now = Date.now();
    if (now < this.#cooldownUntil) {
      this.#lastBranch = 'cooldown';
      this.#gateState('cooldown', true, 'left=' + (this.#cooldownUntil - now) + 'ms');
      this.#heartbeat(now);
      return Math.min(this.#cooldownUntil - now, tuning.driveScanMs);
    }
    this.#gateState('cooldown', false, '');

    const base = env.secret.getRoomBaseInfo();
    this.#gateState('no-base', !base || !base.startPoint, 'no roomBaseInfo/startPoint');
    if (!base || !base.startPoint) {
      this.#lastBranch = 'no-base';
      this.#heartbeat(now);
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
      this.#cd = {};
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
      this.#threatEvaded = false;
      this.#powerGapAt = 0;
      this.#powerGapVal = null;
      this.#viewMarch = new Set();
      this.#viewMarchAt = 0;
      this.#viewPoints = [];
      this.#viewPointsAt = 0;
      this.#viewMarchList = [];
      this.#realmClosed = false;
      this.#idleSince = 0;
      this.#viewAt = 0;
      this.#viewMiss = 0;
      this.#viewOff = false;
      this.#told = {};
      // 场次时间锚：换场当拍落一条 info，把日志时间轴钉到 fightBeginTime（= 整场 +0min）。
      //   字段全部取自已在手的 base，不新增读取；配合文档里 BOSS 排期（小 +23min / 大 +40min）换算。
      env.log.info(
        'pilot: new match anchor fightBeginTime=%d teamId=%d leader=%s marchState=%d at (%d,%d) pt=%d.',
        fb,
        toNum(base.teamId),
        String(base.leaderUid == null ? '-' : base.leaderUid),
        toNum(base.marchState),
        Math.floor(toNum((base.startPoint || {}).x)),
        Math.floor(toNum((base.startPoint || {}).y)),
        toNum(base.pointType),
      );
    }
    // 计时基准兜底：fightBeginTime 缺失时用首拍时刻，否则「开局暖机/大BOSS 前勤务」永远不触发
    if (!(this.#matchStartAt > 1e11)) this.#matchStartAt = now;
    if (this.#realmClosed) {
      this.#lastBranch = 'realm-closed';
      this.#heartbeat(now);
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
        this.#heartbeat(now);
        return 0; // 到点当拍即重评：空井可立刻走
      }
      if (now - this.#toAt > tuning.driveMarchTimeoutMs) {
        this.#lastBranch = 'to-timeout';
        env.log.info(
          'pilot: goto %s timed out without arriving, record spend and re-evaluate. reason=march_timeout',
          this.#toKind,
        );
        this.#consume(this.#toXY);
        this.#clearTo();
        this.#heartbeat(now);
        return tuning.driveScanMs;
      }
      // ⚠ 不按剩余超时睡满 90s：到达/被拒可能靠 push 或异步应答回来，而那一拍已返回、无人唤醒
      //   → 只睡到 min(剩余超时, 2 个兜底拍)：睡满本拍就没人唤醒；短轮询的代价可忽略。
      this.#heartbeat(now);
      return Math.min(this.#toAt + tuning.driveMarchTimeoutMs - now, tuning.driveScanMs * 2);
    }

    // ── 驻留相位：让到点引擎（拾取/商店/攻打/拍宠）干活 ──────────────────
    if (this.#workMode) {
      this.#lastBranch = 'work';
      this.#stage = 'work';
      const w = this.#workTick(now);
      if (!w.leave) {
        this.#heartbeat(now);
        return w.sleep;
      }
      const wk = this.#toXY;
      // 到点即锁：离店后 `driveShopStayMs` 内整条路由链不重评——
      //   治「25s 驻留满 → 下一拍又被电平理由开回商店」。#consume 的 10min 只黑那一个点，
      //   本闸黑的是**全部**候选（含另三家店）。
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
      this.#heartbeat(now);
      return tuning.driveScanMs;
    }
    if (!moored) {
      this.#lastBranch = 'not-moored';
      this.#gateState('notarrived', true, 'marchState=' + base.marchState);
      this.#heartbeat(now);
      return tuning.driveScanMs;
    }
    this.#gateState('notarrived', false, '');
    if (this.#captureBusy()) {
      this.#lastBranch = 'capture';
      this.#note(
        'capturing',
        'pilot: capturing enigma-beast/BOSS now, wait until capture done before relocating.',
      );
      this.#heartbeat(now);
      return 3000;
    }
    if (env.secret.isSecretSending(CMD_MARCH_MOVE)) {
      this.#lastBranch = 'inflight';
      if (!this.#inflightStuckSince) this.#inflightStuckSince = now;
      const stuck = now - this.#inflightStuckSince;
      if (stuck >= tuning.driveMarchTimeoutMs) {
        // 幽灵条目自愈：NetMgrSimple 只在收到同 cmd 应答时清缓存，应答丢失即永堵
        env.log.warn(
          'pilot: 8521 in-flight marker stuck %ds while already docked (suspected ghost entry), bypass gate and send one probe packet to self-heal.',
          Math.round(stuck / 1000),
        );
        this.#inflightStuckSince = 0;
        const probe = this.#pickResource(curKey, cur, null) || this.#explorePoint(cur);
        this.#dispatch('cruise', probe, true);
        this.#heartbeat(now);
        return this.#sleepAfterDispatch();
      }
      this.#heartbeat(now);
      return 200;
    }
    this.#inflightStuckSince = 0;

    // ── ① 受击威胁处置（v4.1 边避边工，对齐竞品 L24906/L24915-24916）════════
    //   竞品语义：威胁拍并非全停——扎营避过一次后落回常规阶梯继续收益（avoid_attacked 同旨），
    //   但跳过 BOSS 档（`quiet` 位向下传导）；当前瓦片正处 PVP 交战（state 11/12）则原地全停。
    //   check_power 闸（面板 driveCheckPower，缺省关）：战力差>0 判「打得过」→ 不扎营、不 quiet，全速含 BOSS 档。
    let quiet = false;
    if (this.#threat) {
      const dvT = env.cfg().drive || {};
      let hold = true;
      if (dvT.checkPower) {
        const gap = await this.#powerGap(now);
        hold = !(gap != null && gap > 0); // 证据不足（null）保守按「打不过」处理
      }
      if (hold) {
        this.#lastBranch = 'threat';
        const safeHere = curPt === PAB_TENT || curPt === PAB_COMMON_PLANE;
        // 一次威胁期只扎一次营；无安全营可选不白驻留，直接落工（竞品无营时同样继续派发）
        if (!safeHere && !this.#threatEvaded) {
          const tent = this.#pickSafeTent(curKey, cur);
          if (tent) {
            this.#threatEvaded = true;
            this.#stage = 'evade';
            this.#dispatch('evade', tent);
            this.#heartbeat(now);
            return this.#sleepAfterDispatch();
          }
        }
        // 交战中挪队只会把部队撒在路上：原地驻守等本窗结束（竞品 L24906 state==12 同语义）
        const ct0 = this.#tiles.get(curKey);
        if (ct0 && (ct0.state === ST_PVP_READY || ct0.state === ST_PVP_FIGHTING)) {
          this.#stage = 'evade';
          this.#heartbeat(now);
          return tuning.driveScanMs;
        }
        // 边避边工：不 return，落回常规阶梯，但置 quiet 使 ②回攻 与 ⑤⑥⑦ BOSS 档让路
        quiet = true;
        this.#stage = 'evade-work';
        this.#gateState(
          'threat',
          true,
          'evaded=' + (this.#threatEvaded ? 1 : 0) + ' safe=' + (safeHere ? 1 : 0),
        );
      }
    }
    // ── ② 回攻（威胁解除且逃离点是 BOSS 相关点）——quiet 拍不让路 ─────────────
    if (this.#returnPending && !quiet) {
      this.#lastBranch = 'return';
      this.#stage = 'return';
      const win = this.#bossWindow(now, cur);
      if (!win || win.mode !== 'open') {
        this.#returnPending = false;
        this.#escapeFrom = null;
      } else {
        this.#dispatch('return', win.boss);
        this.#heartbeat(now);
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
      this.#heartbeat(now);
      return tuning.driveScanMs;
    }

    // ══ S0：主动视口（本拍的候选池）══════════════════════════════════════
    const win = this.#bossWindow(now, cur);
    // 901 视口改由 #autoLeader await 串行拉取（决策吃本应答快照，修旧「同拍派发吃陈旧池」）

    // ── ④ 已停 BOSS 相关点：窗口还开着才 HOLD（攻打/投喂/石头归 boss.js）──
    //   ⚠ HOLD 必须有出口：窗口一散就落下去巡航，否则 BOSS 窗散了车还钉在平台上「整场不动」。
    if (isBossish(curPt)) {
      if (win) {
        this.#lastBranch = 'hold';
        this.#stage = 'hold';
        this.#gateState('hold', true, 'pt=' + curPt + ' mode=' + win.mode);
        this.#heartbeat(now);
        return tuning.driveScanMs;
      }
      this.#gateState('hold', false, '');
    } else {
      this.#gateState('hold', false, '');
    }

    // ── ⑤⑥⑦⑧ 驾驶阶梯（BOSS 档 / 收场店 / 日常链 / 探索档）：判据与顺序在 plans.js，
    //   选点在 #objective，发包/记账/睡眠在 #runStages（现经 #autoLeader await 串行驱动）。
    //   quiet（威胁边避边工拍）喂 win=null → BOSS 档 when 自然不命中，只走日常链/探索档。──
    // ⚠ 心跳不能放在本行之后：#autoLeader 一路 await 到链尾（#runStages 的每个 return 都在那里），
    //   放在这只会恒落 branch='inflight/hold/…' 之外的上一拍形态——故各 return 点各自调 #heartbeat。
    return this.#autoLeader(now, cur, curKey, curPt, quiet ? null : win);
  }

  /**
   * 主决策树（§6 竞品 autoLeader 的等价落点，跑在引擎安全前置之后）：
   *   ① await 串行 901（以 BOSS/自身为中心，修「同拍派发吃陈旧池」）→ ② await 驾驶阶梯 #runStages
   *   → ③ 链全空发一笔空派发记账 + 兑底睡眠。永不 reject。
   * @param {number} now 毫秒
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {string} curKey 当前点键
   * @param {number} curPt 当前点型
   * @param {object|null} win 本拍 BOSS 窗口
   * @returns {Promise<number>} 下拍睡眠（毫秒）
   */
  async #autoLeader(now, cur, curKey, curPt, win) {
    const bossAnchor = win ? win.boss : null;
    // ① 串行 await 901（以 BOSS/自身为中心）→ 决策吃本应答快照；② await 驾驶阶梯。
    //   #runStages 每拍必有返回（梯尾空派发记账即⑨兜底），故直接 return、无需判 null；永不 reject。
    await this.#awaitView(bossAnchor ? bossAnchor.x : cur.x, bossAnchor ? bossAnchor.y : cur.y);
    return await this.#runStages(now, cur, curKey, curPt, win);
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
   * check_power 战力差探针（v4.1，竞品 checkPowerGap L24695-24706 等价，但**不依赖 `TEAM_INFO`**——
   *   该协议号本局录制 0 出现未证实；本队战力直读 21521 落地的本地 `roomBaseInfo.members[].powerInfos[].power`
   *   （heal.js 文件头已证同一料源），来犯战力按需查 8549 ATTACK_SELF_TEAM（源码已证的只读查询））。
   *   结果缓存 `drivePowerGapTtlMs`，威胁窗连续命中不逐拍烧协议。永不 reject：
   *   members 缺失/uid 取不到/应答未落 → 回 null（调用侧保守照逃）。
   * @param {number} now 毫秒
   * @returns {Promise<number|null>} 本队−来犯 总战力（>0=不亏）；null=证据不足
   */
  async #powerGap(now) {
    const env = this.#env;
    if (this.#powerGapAt > now) return this.#powerGapVal;
    const base = env.secret.getRoomBaseInfo();
    const members = base && base.members;
    if (!Array.isArray(members) || !members.length) return null;
    let mine = 0;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (!m) continue;
      if (Array.isArray(m.powerInfos)) {
        for (let j = 0; j < m.powerInfos.length; j++) {
          const p = m.powerInfos[j];
          mine += p ? toNum(p.power) || 0 : 0;
        }
      } else {
        mine += toNum(m.power) || 0;
      }
    }
    const uid = env.gameData && env.gameData.myUidStr ? env.gameData.myUidStr() : '';
    if (!uid) return null;
    const ttl = Number(tuning.drivePowerGapTtlMs) || 4000;
    const r = await env.secret.sendSecret(CMD_ATTACK_SELF_TEAM, { uid: uid });
    const ok = !!r && (r.ok === undefined ? Number(r.code) === 0 : !!r.ok);
    if (!ok) {
      // 应答未落（未发出/被拒）：只短缓存 1s，下一拍再试，不让整段 ttl 全盲
      this.#powerGapAt = now + Math.min(1000, ttl);
      this.#powerGapVal = null;
      return null;
    }
    const d = (r && r.data) || {};
    // 缺字段=证据不足（竞品 checkPowerGap L24701-24703 同旨：waitTeams/fightTeams 任一缺失即回保守值）：
    //   不能把「字段不存在」压成空数组求和→ foe=0 → gap>0 → 反而不逃（fail-open）。
    if (!Array.isArray(d.fightTeams) || !Array.isArray(d.waitTeams)) {
      this.#powerGapAt = now + Math.min(1000, ttl);
      this.#powerGapVal = null;
      return null;
    }
    let foe = 0;
    const teams = d.waitTeams.concat(d.fightTeams);
    for (let i = 0; i < teams.length; i++) {
      const ms = teams[i] && teams[i].members;
      if (!Array.isArray(ms)) continue;
      for (let j = 0; j < ms.length; j++) {
        const p = ms[j];
        foe += p ? toNum(p.power) || 0 : 0;
      }
    }
    this.#powerGapAt = now + ttl;
    this.#powerGapVal = mine - foe;
    env.log.info(
      'pilot: check_power power-delta=%d (ours %d vs invader %d, cached %dms).',
      mine - foe,
      mine,
      foe,
      ttl,
    );
    return this.#powerGapVal;
  }

  /**
   * 是否在拍异能兽/**大BOSS**（`capturingPetPos.x>0`，push 21530 写、结束推 `{x:-1,y:-1}`）——拍宠中一律不挪点。
   *   ⚠ **拍大BOSS 的窗同样拦路**（`boss===1`、瓦片 `state=23`，窗长 39.2s）：把队伍开走会丢掉己方
   *   这一窗的捕获进度，与「任一 BOSS state==23 不派日常车」的让路闸一致（见本文件阶段网关链注）。
   *   不依赖额外兜底：游戏侧每 10s 自愈把 capturingPetPos 打回 `{x:-1,y:-1}`
   *   （PabWorldUINew.updateCapturingData），收窗后 drive 在 `tuning.driveScanMs` 内恢复。
   * @returns {boolean}
   */
  #captureBusy() {
    const pab = this.#env.secret.getPabController();
    const cap = pab && pab.capturingPetPos;
    if (!cap) return false;
    return toNum(cap.x) > 0;
  }

  /**
   * 闲逛超时纯读（已起表且走满 tuning.driveIdleExploreMs）。
   * ⚠ B1 差分回放后改为**无副作用**：旧实现的「未起表先起表」副作用只该在梯尾发生
   *   （#runStages 尾部），这里一旦带副作用就不再是 ctx 的 eager 字段（会让让位/独占拍提前起表）。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #shouldExplore(now) {
    if (!(tuning.driveIdleExploreMs > 0)) return false;
    return this.#idleSince !== 0 && now - this.#idleSince >= tuning.driveIdleExploreMs;
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
    // ⚠ 必须箭头函数：`function` 回调在 ESM 严格模式下 this=undefined（真实报文回放抓到的潜伏崩溃，
    //   仅当账本里存在已过期条目时触发）→ 离店记账会整拍炸掉。
    this.#consumed.forEach((until, k) => {
      if (until !== -1 && until <= now) this.#consumed.delete(k);
    });
    this.#marched.forEach((until, k) => {
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
      this.#env.log.info('pilot: gate[%s] blocked, hold steering. reason=%s%s', name, name, tail);
    } else if (!on && this.#told[k]) {
      delete this.#told[k];
      this.#env.log.info('pilot: gate[%s] passed. reason=%s%s', name, name, tail);
    }
  }

  /**
   * 决策心跳（纯读，不参与任何判定）：把 `debugState()` 的关键字段按节律送进日志流，
   *   使「方向盘这一拍为什么没动」事后可用 `cli.js log --grep='pilot: tick'` 单轨还原。
   *   调用点：`#tick` 内**每个 return 前**（早退分支不会比主链少信息）。
   *   节律：每 6 拍一条（driveScanMs=5000 → 约 30s）或分支跳变当拍一条；同一拍只落一次。
   *   长度纪律：主行与 census 副行均 ≤ 200 字符（`cli.js log` 非 --json 按 200 截断）。
   * @param {number} now 毫秒
   */
  #heartbeat(now) {
    const env = this.#env;
    const branchChanged = this.#lastBranch !== this.#lastLoggedBranch;
    if (!branchChanged && this.#ticks % 6 !== 0) return;
    this.#lastLoggedBranch = this.#lastBranch;
    if (this.#hbTick === this.#ticks) return;
    this.#hbTick = this.#ticks;
    // cd 剩余一律走与 debugState 同一纯读表达式（直接读 #cd 存的是绝对解禁时刻）
    const left = (k) => (this.#cd[k] ? Math.max(0, this.#cd[k] - now) : 0);
    env.log.debug(
      'pilot: tick#%d branch=%s stage=%s why=%s cd[march=%d,beast=%d] phase=%s tl=%d idle=%d plan=%s',
      this.#ticks,
      this.#lastBranch || '-',
      this.#stage || '-',
      this.#stageWhy || '-',
      left('march'),
      left('beast'),
      this.#toKind || 'idle',
      this.#tiles.size,
      this.#idleSince ? now - this.#idleSince : 0,
      this.#planIdUsed || '-',
    );
    // 梯尾空派发拍（= 全链无候选）补一行筛除普查：字段名直接从 #pickDbg 的键取，
    //   因 beast/资源/商店三套计数键集不同，硬编会漏。
    if (this.#lastBranch === 'cruise') {
      const dbg = this.#pickDbg;
      if (dbg) {
        const parts = [];
        for (const k in dbg) {
          if (k === 'best') continue;
          parts.push(k + '=' + dbg[k]);
        }
        parts.push('best=' + (dbg.best || '-'));
        const line = 'pilot: pick census ' + parts.join(' ');
        if (line !== this.#lastCensusLine) {
          this.#lastCensusLine = line;
          env.log.debug('%s', line.length > 200 ? line.slice(0, 200) : line);
        }
      }
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
    this.#viewPoints = [];
    this.#viewPointsAt = 0;
    this.#viewMarchList = [];
    this.#exploreSpin = 0;
    this.#inflightStuckSince = 0;
    this.#threat = false;
    // 威胁伴生位显式配对复位：防引擎复用/换场首拍读不到 fightBeginTime 时，旧威胁窗的扎营位残留使下一次威胁不再避让
    this.#threatEvaded = false;
    this.#powerGapAt = 0;
    this.#powerGapVal = null;
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
      // error 级：无 21534/10018 推送 ⇒ 受击逃帐与瓦片现场永远拿不到，方向盘整场空转（core/log.js 第 1) 条）。
      env.log.error('pilot: ctx.on.push unavailable, cannot subscribe 21534/10018 (engine idle).');
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
      'pilot started (anchor-table shops + BOSS authoritative coords + 901 active view; boss/shop/cruise/explore; leader-only).',
    );
  }

  /**
   * 调试快照（只读，不参与判定）：`pocketcc.secretRealmDrive.debugState()`。
   *   含 `anchors`（表商店坐标）/ `view`（901 状态）/ `pick`（选点计数）/ `stage`（本拍阶段）。
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
      planId: this.#planIdUsed,
      stageIds: this.#lastStageIds.slice(0, 8),
      // 契约三态：[] 未校验 / null 通过 / [...] 违例（非空 → #tick 头部拒发车）
      contractErrs: this.#contractErrs,
      gate: Object.assign({}, this.#gateNow),
      // cd 账本剩余（毫秒，纯读）：march=行军最小间隔（§2.3 唯一 TO 锁）；>0 时日常链发车会被 #can('march') 短睡拦一拍。
      cd: {
        marchLeftMs: this.#cd.march ? Math.max(0, this.#cd.march - now) : 0,
        bossLeftMs: this.#cd.boss ? Math.max(0, this.#cd.boss - now) : 0,
        beastLeftMs: this.#cd.beast ? Math.max(0, this.#cd.beast - now) : 0,
      },
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
      // 每店账本（time 秒 / sausage / piece）
      shopLedger: shopLedger,
      view: {
        off: this.#viewOff,
        // 串行 await 模型下 901 不再 fire-and-forget，恒 false（保留字段仅为 probe 形状兼容）
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
      // 到场打过的 BOSS 跳过账
      bossDone: Object.keys(this.#bossDone),
      told: Object.keys(this.#told),
      change: change,
    };
  }

  /** 停止：置死 #active、收循环与全部本地账（事件退订由 reactor 统一摘）。 */
  stop() {
    this.#active = false;
    this.#planIdUsed = ''; // §15.10 P2：解锁方案，下次 start 重读 config.drive.drivePlan（probe 停驶后 planId 显空属预期）
    this.#contractErrs = []; // 复位为「未校验」三态，允许下次 start 重跑校验
    // 心跳诊断位一并复位（不参与判定，留着只会让下次 start 首拍少一条）
    this.#lastLoggedBranch = '';
    this.#hbTick = 0;
    this.#lastCensusLine = '';
    if (this.#cycle) this.#cycle.dispose();
    this.#cycle = null;
    this.#tiles = new Map();
    this.#shops = [];
    this.#marched = new Map();
    this.#consumed = new Map();
    this.#cd = {};
    this.#dayBlack = {};
    this.#threat = false;
    this.#threatEvaded = false;
    this.#powerGapAt = 0;
    this.#powerGapVal = null;
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
