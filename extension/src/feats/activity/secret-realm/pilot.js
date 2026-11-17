/**
 * 自动驾驶引擎（异能秘境唯一的「方向盘」：决定下一个去哪；其余引擎都是「到点即干活」）。
 *
 * 数据三源（候选池不靠 push 积累）：
 *   • 商店：读表 `enigma_secret_realm_building`，`build_type===3 && group===本房间`，`coords="x,y"`——
 *     四个商店是固定建筑，坐标与镜头无关（空表/读不到时 5s 后重试，表在进图后才下发）。
 *   • BOSS：服务器权威坐标 `bossBaseInfo[].pos`。
 *   • 资源/平台：901 GET_WORLD_INFO 每 `tuning.driveViewMs`(3s) 以自己（或开台中的 BOSS）为中心主动拉
 *     `{x,y,k,rid:0,width:20,height:30,marchInfo:true}`，结果并入 `#tiles`（`src:'v'` 覆盖 push 的旧值）；
 *     空闲态（WORK 驻留/bossWait 让路/无候选）自适应降频到 `driveViewIdleMs`(12s)，kick 唤醒立即恢复（四-1，判据见 view-throttle.js）；
 *     连续失败 `driveViewOffAfter` 次 → `#viewOff` 降级（仍可开商店/BOSS，巡航选点本轮停选等快照恢复），`driveViewRetryMs`(60s) 后重试。
 *   push 10018 是「镜头扫过才推」的增量包，只作兜底——候选池若只靠它，会被镜头位置限死在 2~3 个点上。
 *
 * 四层：S0 数据 `#syncAnchors`/`#awaitView`(串行 await 901→`#ingestView` 落账) → S1 阶段 `#bossWindow`（21 开打 / 22 开台读秒）/`#shopWant`
 *   → S2 动作 pilot-select 窄筛（`pickShop`/`pickBeast`/`pickResource`）/`#pickPlane`/`#pickFollow`/`#explorePoint` → `#dispatch`
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
 *   距离上限 100；巡航评分 `iNum − 距起点/2 − 距未领奖BOSS/5 − 距无香肠店/6`（pilot-select 窄筛），商店引力锚取「还没买过香肠的店里最近的一家」（空则不挂锚），
 *   已派车的点 `driveMarchedTtlMs`(60s) 内不再选。
 *   成本项缺锚时必须算 **0**（`Infinity / 5` 仍是 Infinity 且 truthy，`|| 0` 不生效 → score 恒 -Infinity，一个点都选不中）。
 *
 * 每店账本（点位键 → `{time 秒, sausage, piece}`，按场计、换场清账）：`stage` 档的 gap 从到店那一刻重算，选店先选没买过香肠的；
 *   访问记忆 = 窄筛 pickShop 三连前置（暖机 63s / 全店共享 3s 到店冷却 / 已在 161 不重派）+ `max(3000, driveShopStayMs)` 路由锁 + 「每家店都已试过却仍缺料」的白跑惩罚。
 *   到点驻留：172 → `driveStayMonsterMs` 等拍宠/交战结算；173/163 → 拿空当拍即走（无驻留地板，拿不空受 `driveWorkMaxMs` 天花板兜底）；
 *   161 → `driveShopStayMs` 让 shop.js 逐行买货。
 *
 * 其它：TO 相位短轮询（不睡满 90s）；到达双路确认（`roomBaseInfo.startPoint` 复核 + 超时兜底）；
 *   拿空双料源（21522/21532 CHANGE 按点账 + 快照 `rTime`/`iNum` 当前态）；目标 == 当前点不发 8521；
 *   在途幽灵条目自愈（`isSecretSending(8521)` 久堵且已停泊 → 绕闸发探测包）；受击逃营帐 + 回攻 / 当前点被 PVP 原地应战；
 *   战败自救：21521 落地 `deadType===1 && dataConfig(3056) > reviveNum` → 8552 `{uid}`（系统默认行为，无面板子闸）。
 *   手动接管（二轮收口）：用户手发 8521 与 intent 不匹配 → 清转向意图 + env.driveAutoOff 自动取消自动驾驶勾选
 *   （落盘持久化，再勾即恢复，无闩锁）；不抓宠（petLevel=0）已停稳 172 → beast-off-leave 档当拍 evade 撤出（不攻打/不拍）。
 *
 * 拒绝码处置（§11，真机报文验证后定稿）：157 已在该点 → 直接进 WORK；158 在途 → 正常形态不记；163 不能行军 → 60s marched 冷却（竞品语义，不永久拉黑）；
 *   159 目标点不存在 → 拉黑该点（店则从锚点表剔除）；141 请先上平台 → 本拍改选平台；
 *   142/252 平台不在同区/已被占 → 拉黑该平台；209 同区互挪 → 60s marched 冷却（拒绝取决于当前停泊位，同点稍后可成功，报文实证，不拉黑）；17 战场即将封闭 → 本场停手；159 点不存在 → 拉黑。
 *
 * 只读 + 发包红线：全程只读 ACL 快照与配置表；写动作只有 `sendMarch`（8521）与 8552 复活；901 是只读查询。
 * 仅队长发车（8521 驱动队级那一条行军）。触发：单条 createCycle + kick 源 21534/21529/21521/21535/901 应答。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import { tileKey as utilTileKey, dist as utilDist } from './util.js';
import { TtlLedger } from './ledger.js';
import { matchReject } from './rejects.js';
import { enter as workEnter, tick as workTick } from './work-mode.js';
import { viewIdleNow, viewWaitMs, viewFreshWinMs } from './view-throttle.js';
import { PLANS, matchStages, validatePlan, validateCtxKeys } from './plans.js';
import {
  pickResource,
  pickBeast,
  pickShop,
  pickHopTile,
  exitStageWant as exitStageWantPure,
  shopStageWant as shopStageWantPure,
  beastStageWant as beastStageWantPure,
} from './pilot-select.js';
import {
  CMD_MARCH_MOVE,
  CMD_REVIVE,
  CMD_POINT_INFO,
  PUSH_SELF_ATTACKED,
  PUSH_TILE_INFO,
  PUSH_BASE_INFO,
  PUSH_BOSS_STATE,
  PUSH_TEAM_ARRIVE,
  PUSH_RESOURCE_CHANGE,
  PUSH_DROP_CHANGE,
  PUSH_POINT_FIGHTING_INFO,
  PAB_SHOP,
  PAB_DROP,
  PAB_MONSTER,
  PAB_RESOURCE,
  PAB_COMMON_PLANE,
  PAB_TENT,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  ST_PVP_READY,
  ST_PVP_FIGHTING,
  ST_BOSS_FIGHTING,
  ST_PLANE_MARCH,
  ST_BOSS_FEED,
  ST_BOSS_FIGHTING_END,
  ST_BOSS_DEAD_END,
  // 拒码常量不再直引：处置全走 rejects.js 共享真相表（码义/拉黑/TTL/退避/日志模板）
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

/** 终局收场分支名（闸/lastBranch 共用同一字面量，dashcam 按 'match-over' 单 grep 定责）。 @type {string} @const */
const BR_MATCH_OVER = 'match-over';

/**
 * 点位键（与 boss.js/scout.js 同口径的本地小工具；非法坐标回 ''）。
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
 * 从 CHANGE 推送事件里取业务体（net 已剥 pbAckV2 信封，ev.data 即 {x,y,…} 本身，
 *   1115 实录 897 包无嵌套 data 包装；非 0 状态包游戏不发，我们也跳过）。
 * @param {object} ev bus 事件
 * @returns {object|null}
 */
function changeBody(ev) {
  const d = ev && ev.data;
  if (!d || typeof d !== 'object') return null;
  if (d.x == null || d.y == null) return null;
  return d;
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
   *   固定性双重确认（2026-11-04）：用户口径「4 商店坐标任何一场不换」+ 实录视口只扫到 2 家
   *   （(95,163)/(250,96)，pt=161）而表锚点给全 4 家——若从视口找店（v3 旧病）会永远缺另外两家。
   */
  #shops = [];
  /**
   * @type {Map<string,{time:number,sausage:number,piece:number,visited:number,sausageShelf:number}>}
   * 每店账本（点位键 → 该店记录）：
   *   `time`=最近一次到店（毫秒，定期轮巡与 3s 去重基准）、`sausage`/`piece`=该店货单上香肠/百兽箱货位的
   *   `getTime`（已购次数，>0 = 这家已经买过）。**按场计**：锚点装载时为空则建账（`#syncAnchors`），
   *   换场/引擎重启经 `#resetMatch` 整体清账——百兽箱 type3 全场共享额度的「本场已买」位（`isBoxBought`）
   *   也因此只在本场内有效，换场后按未买保守处理。
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
  /** @type {boolean} 外部事件 kick 唤醒位（四-1）：下一刀 #awaitView 绕过空闲降频闸立即恢复 driveViewMs 口径，消费即清 */
  #viewKick = false;
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
  /** @type {TtlLedger} 已派过车的点 → 解禁时刻（driveMarchedTtlMs） */
  #marched = new TtlLedger();
  /** @type {TtlLedger} 消费账：点位键 → 解禁时刻（driveConsumedTtlMs；-1=永久黑哨兵） */
  #consumed = new TtlLedger();
  /**
   * @type {Map<number,number>} esrId → realm.roundid（区域档位，静态配置表）memo；
   *   供 #roundTier 区分「强异能区（开放回合更晚、更靠地图中心）vs 普通/微异能区」。
   */
  #roundTierCache = new Map();
  /**
   * @type {TtlLedger} 拾取引擎判「本队对此停靠点已无可采/无需采」的点（单人开车：井里还剩别人要的/超单项上限的货，
   *   服务器看仍非空、rTime 不在未来，但我不会再来拿）。仅作 WORK「即时离站」用（喂 #isTileEmpty），
   *   **不**参与选点——防重派由离站时既有的 #consume 记账负责。
   *   值形态 `{at:ms}`（标记时刻，对象载荷避开 sweep 的数值过期语义）：#enterWork 到点只清**本次发车前**的
   *   旧标记，行军途中 pickup 写的新标记保留（否则空井白等到天花板，问题2/17）；换场/停机整体清空。
   */
  #exhausted = new TtlLedger();
  /**
   * @type {Object<string,number>} cd 账（毫秒时刻，与全局 Date.now 同口径；E 阶段迁 serverTime 时一并换）：
   *   `march`=行军最小间隔（竞品 cd_time.march：L24974 决策前 +3s，§2.3 唯一的「TO 锁」），
   *   `boss`/`beast`=对应 901 查询节流（§2.3）。闸门走 #can、记账走 #setCd，**一律先记后动**。
   */
  #cd = {};
  /** @type {TtlLedger} 当日/本场拉黑的点（159 点不存在 / 平台被占 141/142/252）；163/209 不在此列（走 marched 60s） */
  #dayBlack = new TtlLedger();
  /** @type {number} 被拒退避截止时刻 */
  #cooldownUntil = 0;
  /** @type {boolean} 战场已封闭（服务端 `enigma_realm17`）→ 本场停手，换场自动解开 */
  #realmClosed = false;
  /** @type {number} 当前场 fightBeginTime（毫秒）；变化即换场复位 */
  #matchFightBegin = 0;
  /**
   * 终局相位（大BOSS 死局→奖励弹窗 hold→最后一趟商店→done 本场永久收场）；null=未进入。
   *   phase: 'hold'|'shop'|'shop-work'|'done'；until=hold 截止时刻。转场写穿 index.js 模块级闩（活过引擎重建）。
   * @type {{phase:string, until:number}|null}
   */
  #endgame = null;
  /** @type {string} 大BOSS（177 本体）瓦片键：#tiles 首见锁存（墓碑覆盖 pt=0 后反查不到身份） */
  #bigBossKey = '';
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
  /** @type {number} 本次威胁窗首次 evading 的时刻（毫秒；0=未逃）——`driveThreatReEvadeMs` 再逃基准 */
  #threatEvadeAt = 0;
  /** @type {number} 本次威胁窗已触发的再逃次数（上限 `driveThreatReEvadeMax`，防挪车循环烧队列） */
  #threatReEvade = 0;
  /** @type {{x:number,y:number,pt:number,esrId:number|null}|null} 逃袭前的停泊现场（回攻需求源） */
  #escapeFrom = null;
  /** @type {boolean} 回攻待办 */
  #returnPending = false;
  /**
   * @type {number} evade 专属冷却截止（毫秒）。取代旧「evade 抬全局 `#cooldownUntil` 45s」——
   *   只约束下一次 evade，不拦常规选点路由（`driveEvadeCooldownMs`，承接旧 warnMoveCooldownMs 语义）。
   */
  #evadeCoolUntil = 0;
  /** @type {number} 上一次 21535 主动复拉（8522）的时刻（毫秒，`driveBossStateGapMs` 限速基准） */
  #bossStatePullAt = 0;
  /**
   * @type {Object<string,number>} `common_159995`（该点当前不可打）专属短黑：点键 → 解禁毫秒。
   *   与 #marched 分表：#pickPlane 逐块扫 #tiles、bossFight 直取权威坐标，两者都不读 #marched，
   *   共用会把「开车成本 60s」的 marched 语义扩散到平台点；本表只被 #paramBlocked 消费。
   */
  #paramBlack = new TtlLedger();
  /**
   * @type {TtlLedger} 本场已到场打过的 BOSS（21521 落地时用 `targetPoint` 对上
   *   `bossBaseInfo[].pos` 记账，供 `guard_policy==2` 过滤；键为 bossId 字符串）。
   */
  #bossDone = new TtlLedger();
  /** @type {number} 上次发 8552 复活的时刻（毫秒，driveReviveGapMs 基准） */
  #lastReviveAt = 0;
  /** @type {boolean} 8552 在途（防同一次死亡反复消耗复活次数） */
  #reviveInFlight = false;
  /** @type {{x:number,y:number,round:number,left:number,right:number,isEnd:boolean}|null} 21523 遭遇战回合账（null=无遭遇在途） */
  #pvpRound = null;
  /** @type {number} 本场遭遇连输场数（对手胜场 +1 且回合递增记一输，己方胜场 +1 清零；isEnd/异点/回合回退/stop 复位） */
  #pvpLossStreak = 0;
  /** @type {boolean} 本场遭遇是否已败退过（防同场重复推送再逃；isEnd/异点/回合回退/stop 复位） */
  #pvpFled = false;
  /** @type {boolean} 连输败退待办：21523 判连输达阈 → true，#tick 头部派 evade（8521 在飞未发出时逐拍重试） */
  #pvpFleePending = false;

  // ── S3 到点层 ────────────────────────────────────────────────────────
  /** @type {string} WORK 退出模式：''=不在 WORK；'empty'=拿空即走；'dwell'=固定驻留 */
  #workMode = '';
  /** @type {number} 固定驻留截止时刻 */
  #workUntil = 0;
  /** @type {number} 拿空兜底强制离点截止时刻 */
  #workDeadline = 0;
  /** @type {number} 进入 WORK 驻留时的点型（`#enterWork` 记录，供 `#workTick` 稳定判 BOSS/商店相位，不依赖实时 pointType） */
  #workPt = 0;
  /** @type {boolean} 刷店止损信号（四-2，仅本次 WORK）：shop.js 连续刷不中目标品 → 截短驻留且缺口不续留，当拍离店 */
  #shopGiveUp = false;
  /** @type {TtlLedger} 21522/21532 按点空位数账：点键 → {kind,bagFree,buffFree,dropFree,beastFree,at}（无 TTL 载荷） */
  #change = new TtlLedger();

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
  /** @type {number} 本场 march_timeout 兜底次数（四-4：8521 无应答/未抵达超时账，只观测不判定，换场清零） */
  #marchTimeouts = 0;
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

  /**
   * 统一唤醒入口（四-1）：kick 一拍 + 置 901 降频旁路位——外部事件（威胁/到达/BOSS 态/拒码…）
   *   唤醒后下一刀 #awaitView 立即恢复 driveViewMs 常规口径，不被空闲放宽闸拦住。
   *   引擎内部自唤醒（WORK empty 判空 kick 等）也走这里，多置一次旁路位无害（empty 相位本就不降频）。
   */
  #kick() {
    this.#viewKick = true;
    if (this.#cycle) this.#cycle.kick();
  }

  // ══════════════════════════════════════════════════════════════════════
  // 推送落地（只记账 + kick；业务态一律重读 ACL / 主动查询）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * push 21534 攻击警告：num>0 验真后置威胁并 kick；num=0 清威胁（转移即消警）。
   *   验真（1115 复核 warn-reaudit，445 条载荷恒只有 {num} 无 UID）：
   *   ① BOSS 交战期大 num=争夺计数误告（46/46 本点无敌方 UID）；
   *   ② 井位到点瞬间 num=1=到点噪声（9/10 本点无敌方 UID）。
   *   仅新鲜快照确证本点无敌方 UID 才忽略；证据不足保守置威胁（见 #warnNoFoeHere）。
   * @param {object} ev bus 事件
   */
  onWarnPush(ev) {
    const d = (ev && ev.data) || {};
    const num = Number(d.num) || 0;
    if (num > 0) {
      const noFoeKey = this.#warnNoFoeHere();
      if (noFoeKey) {
        this.#env.log.debug(
          'pilot: warn num=%d at %s ignored: no foe uid on tile (contest/arrival noise). reason=warn_no_foe',
          num,
          noFoeKey,
        );
        return;
      }
      this.#threat = true;
      this.#kick();
    } else {
      this.#threat = false;
      // 威胁解除 → 复位扎营位：下次再被盯上重新先扎一次营（v4.1 边避边工的周期单位=一次威胁窗）
      this.#threatEvaded = false;
      this.#threatEvadeAt = 0;
      this.#threatReEvade = 0;
    }
  }

  /**
   * 警告验真（1115 复核）：本点新鲜占用快照确证「无本队以外的敌方 UID」→ 返回点位键（误告可忽略）；
   *   证据不足（无 base/无快照/龄超 tuning.warnVerifyAgeMs/快照无 uid 列表/有敌方 uid）→ null，
   *   调用侧保守置威胁（fail-safe 不漏真攻击）。本队排除：本人 uid（gameData.myUidStr）+
   *   21521 members[].uid；服务端 teams 通常不含本队，双保险再排一次。
   * @returns {string|null}
   */
  #warnNoFoeHere() {
    const env = this.#env;
    const base = env.secret ? env.secret.getRoomBaseInfo() : null;
    const p = base && base.startPoint;
    if (!p) return null;
    const k = tileKey(Math.floor(toNum(p.x)), Math.floor(toNum(p.y)));
    if (!k) return null;
    const t = this.#tiles.get(k);
    if (!t || Date.now() - (t.at || 0) > tuning.warnVerifyAgeMs) return null;
    if (!Array.isArray(t.teamUids)) return null;
    const mine = new Set();
    const me = env.gameData && env.gameData.myUidStr ? env.gameData.myUidStr() : '';
    if (me) mine.add(String(me));
    const mem = base && Array.isArray(base.members) ? base.members : [];
    for (let i = 0; i < mem.length; i++) {
      if (mem[i] && mem[i].uid != null) mine.add(String(mem[i].uid));
    }
    for (let i = 0; i < t.teamUids.length; i++) {
      if (!mine.has(t.teamUids[i])) return null;
    }
    return k;
  }

  /** push 21529/21521：只 kick（到达最终判据是 `startPoint` 复核，不信事件时序）。 */
  onArriveWake() {
    if (!this.#env.alive()) return;
    this.#kick();
  }

  /**
   * push 21521 BASE_INFO 落地，两个动作：
   *   ① 记账：`targetPoint` 对上某个 BOSS → 记「这个 BOSS 我已到场打过」，供 `guard_policy==2` 以同一口径排除重复目标；
   *   ② 自救：`deadType===1` 且 `dataConfig(3056) > reviveNum` → 发 8552 `{uid}`（战败不复活 =
   *      `teamIsMooring()` 永不成立 → 本引擎卡在 not-moored 直散场）。
   *   只读 + 发包红线：8552 是写动作，系统默认行为（无面板子闸），受 `driveReviveGapMs` 限速与上限读不到/为 0 不发约束。
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
              if (bid && !this.#bossDone.has(String(bid))) {
                this.#bossDone.mark(String(bid));
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
    this.#kick();
  }

  /**
   * 复活判据与发包（deadType/reviveNum 优先读 `roomBaseInfo`，缺字段再读 push 载荷）。
   * @param {object|null} base roomBaseInfo
   * @param {object} ev bus 事件
   */
  #maybeRevive(base, ev) {
    const env = this.#env;
    // 战败复活为系统默认行为（无面板子闸）：仅受在飞/限速/上限读不到不发约束。
    if (this.#reviveInFlight) return;
    const now = Date.now();
    if (now - this.#lastReviveAt < tuning.driveReviveGapMs) return;
    const src = ev && typeof ev.data === 'object' ? ev.data : null;
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
    // 账本变更留痕：#shopAllTried（白跑惩罚长冷却）与窄筛 pickShop 的 prefer 排序都吃这几个位，
    //   事后能回答「已知这家不卖香肠/都试过了，为什么还（不）去商店」。
    this.#env.log.debug(
      'pilot: shop ledger %s -> time=%d visited=%d sausage=%d piece=%d shelf=%d.',
      key,
      cur.time,
      cur.visited,
      cur.sausage,
      cur.piece,
      cur.sausageShelf,
    );
  }

  /**
   * 拾取引擎→方向盘的「此点对我已采完/无需采」口（零引用红线：pickup 不 import pilot，经 env 惰性回调）。
   *   单人开车时一个资源井常会剩下自己勾除外/达单项上限的货——服务器看仍非空（bagFree>0 且 rTime 不在未来），
   *   双路拿空判据（CHANGE 空位数 + 10018 现状态）都抓不到，只能由 pickup 侧主动回灌。
   * 只标记「即时离站」（#isTileEmpty 认它）+ kick 重评；防重派仍靠离站时既有的 #consume（driveConsumedTtlMs 10min）。
   * @param {string} key 点位键
   */
  markTileExhausted(key) {
    if (!key) return;
    if (!this.#exhausted.has(key)) {
      // 对象载荷 {at}：#enterWork 按发车时刻区分新旧标记（在途期间写的新标记保留）；存数值会被 sweep 当过期时刻误清
      this.#exhausted.set(key, { at: Date.now() });
      this.#env.log.debug(
        'pilot: point %s marked exhausted (nothing left for me), leave ASAP.',
        key,
      );
    }
    // 当前正停靠在该点且处于「拿空即走」相位 → 踢一拍让它立刻走 empty 分支，不等 45s 兑底天花板。
    if (this.#workMode === 'empty' && key === this.#toXY) this.#kick();
  }

  /**
   * 商店引擎→方向盘的「商店止损，提前离店」口（四-2 + 问题6/20，零引用红线：shop 不 import pilot，经 env 惰性回调）。
   *   触发源：连续 driveSausageRefreshMissMax 次 8543 刷不出香肠货位 / 无刷新币 / 刷新预算尽 / 货位全降级。
   *   若正驻留该店，截短驻留并置 shopGiveUp（缺口也不续留）当拍离店。防重派靠离站时既有的 #consume（10min），
   *   「已知不卖」账本位（sausageShelf=0）由 shop.js #markLedger 按应答回写，喂 #shopAllTried 白跑惩罚。
   *   幂等：同一驻留窗多路止损信号只认第一笔（不重复截短/刷屏）。
   * @param {string} key 点位键
   */
  shopRefreshGiveUp(key) {
    if (!key || key !== this.#toXY || !this.#workMode) return;
    if (this.#shopGiveUp) return; // 幂等：本驻留窗已认过止损信号
    this.#shopGiveUp = true;
    this.#workUntil = Math.min(this.#workUntil || Date.now(), Date.now());
    this.#env.log.info(
      'pilot: shop %s give-up acknowledged, cut dwell and leave now. reason=shop_give_up',
      key,
    );
    this.#kick();
  }

  /**
   * 在途转向快照（1115 问题4②：供 boss.js 的 drive-driving 让闸经 env.pilotSteer 惰性读）。
   *   有 TO 相位时回 {tag,xy,at}，空闲回 null。boss.js 据此判「pilot 正驶向非 BOSS 目标」
   *   （evade/cruise/shop/return 等）→ 攻打行军让位，防攻打 loop 覆盖 evade 的 8521 打成乒乓。
   * @returns {{tag:string,xy:string,at:number}|null}
   */
  steerState() {
    if (!this.#toKind) return null;
    return { tag: this.#toTag, xy: this.#toXY, at: this.#toAt };
  }

  /**
   * push 21523 落地（1115 问题9）：跟踪遭遇战回合账，判**连输即逃**（系统默认 tuning.drivePvpFleeLossStreak=2）。
   *   载荷 {x,y,info:{round,leftWinNum,rightWinNum,isEnd}}；输判据（用户拍板）= 该场对手胜场 +1
   *   （round=N+1 且 rightWinNum 单调递增）→ 连输账 +1；赢（leftWinNum +1 同式）→ 连输账清零；
   *   单调比较防换对手时胜场回退异常误判。三局两胜下 LL 与 WLL 触发、LWL 不触发。
   *   仅 drive.enabled 时跟踪；isEnd/异点/回合回退 复位连输账与已逃标记（末场结算不再逃，遭遇已结束）。
   *   两种战斗模式（1115 用户域知识+复核）：BOSS 平台（176/177/178）与玩家是 1 局定胜负的直接战斗、
   *   立即判输赢（输者飞到地图边缘），无场次；只有非 BOSS 点（井 173/捕获平台 172 等）
   *   才有三局两胜遭遇战。故已知 BOSS 点的战斗不跟踪（21523 实证 21/21 全在 172/173，闸是保险）。
   * @param {object} ev bus 事件
   */
  onPvpInfo(ev) {
    const b = this.#env.cfg().drive;
    if (!b || !b.enabled) return;
    const d = ev && ev.data;
    const info = d && (d.info || d);
    if (!info || typeof info !== 'object') return;
    const x = Math.floor(toNum(d.x));
    const y = Math.floor(toNum(d.y));
    // 点型闸：战斗在本点时读 base.pointType（权威），否则读瓦片快照 pt；读不到点型保持
    //   旧行为只记账（⓪ 派发闸对 curPt 还有硬检查，不会在 BOSS 平台误逃）。
    const fightKey = tileKey(x, y);
    const base = this.#env.secret ? this.#env.secret.getRoomBaseInfo() : null;
    const bp = base && base.startPoint;
    const fightPt =
      bp && fightKey === tileKey(Math.floor(toNum(bp.x)), Math.floor(toNum(bp.y)))
        ? Number(base.pointType) || 0
        : Number((this.#tiles.get(fightKey) || {}).pt) || 0;
    if (isBossish(fightPt)) return;
    const round = Number(info.round) || 0;
    const left = Number(info.leftWinNum) || 0;
    const right = Number(info.rightWinNum) || 0;
    const isEnd = !!Number(info.isEnd);
    const prev = this.#pvpRound;
    this.#pvpRound = { x: x, y: y, round: round, left: left, right: right, isEnd: isEnd };
    if (isEnd) {
      this.#pvpLossStreak = 0;
      this.#pvpFled = false;
      this.#pvpFleePending = false;
      return;
    }
    // 新账：无上一笔/上一笔已终局/异点/回合回退（换对手异常）→ 复位连输账，只记账不判输
    if (!prev || prev.isEnd || prev.x !== x || prev.y !== y || round < prev.round) {
      this.#pvpLossStreak = 0;
      this.#pvpFled = false;
      return;
    }
    if (round !== prev.round + 1) return; // 同回合重复推送：只记账
    if (right > prev.right) {
      this.#pvpLossStreak++; // 输一场
    } else if (left > prev.left) {
      this.#pvpLossStreak = 0; // 赢一场清零
    } else {
      return;
    }
    const need = Number(tuning.drivePvpFleeLossStreak) || 2;
    if (this.#pvpLossStreak < need) return;
    if (this.#pvpFled) return; // 本场已逃过：只逃一次
    this.#pvpFled = true;
    this.#pvpFleePending = true;
    this.#env.log.info(
      'pilot: pvp loss streak %d at (%d,%d) round %d, flee now. reason=pvp_loss_streak',
      this.#pvpLossStreak,
      x,
      y,
      round,
    );
    this.#kick();
  }

  /**
   * 本端 8521 发包落地（1115 问题5/10 手动接管检测）：与 intent 队列匹配（坐标 + 2s 窗）
   *   → 扩展自身发送（pilot/boss 均经 env 双口包装记 intent），消费掉；不匹配 = 用户手动行军 → 暂停驾驶。
   *   仅 drive.enabled 时判（关档时手动行军是正常形态，不打扰）。
   * @param {object} ev bus 事件（{cmd,key,data:{x,y},ts}）
   */
  onOwnMarch(ev) {
    const b = this.#env.cfg().drive;
    if (!b || !b.enabled) return;
    const d = ev && ev.data;
    if (!d) return;
    const x = Math.floor(toNum(d.x));
    const y = Math.floor(toNum(d.y));
    const ts = Number(ev.ts) || Date.now();
    const env = this.#env;
    if (typeof env.marchIntentMatch === 'function' && env.marchIntentMatch(x, y, ts)) return;
    this.#manualTakeover(x, y);
  }

  /**
   * 手动接管（二轮收口）：清全部转向意图（TO/回攻/WORK/败退）+ 经 env.driveAutoOff 自动取消自动驾驶勾选
   *   （落盘持久化，≡ 用户手取消；再勾即恢复，无闩锁），info 留痕。幂等由 driveAutoOff 内部保证。
   */
  #manualTakeover(x, y) {
    this.#clearTo();
    this.#returnPending = false;
    this.#escapeFrom = null;
    this.#workMode = '';
    this.#pvpFleePending = false;
    this.#env.log.info(
      'pilot: manual takeover detected (user 8521 to %d,%d), drive checkbox auto-unchecked. reason=manual_takeover',
      x,
      y,
    );
    const off = this.#env.driveAutoOff;
    if (typeof off === 'function') off();
    this.#kick();
  }

  /**
   * push 10018 落地：写快照、**不 kick**（3 条/秒，kick 会把兑底拍打成 3Hz）。
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
      // pt=0 放行到 #putTile 的墓碑分支（只覆盖已记录的跟踪点，BOSS 死亡证据）；其余非跟踪点型仍跳过
      if (!TRACKED_PT[pt] && pt !== 0) continue;
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
    if (this.#workMode === 'empty' && k === this.#toXY) this.#kick();
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
    if (this.#workMode === 'empty' && k === this.#toXY) this.#kick();
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
    const prev = this.#tiles.get(k);
    if (!TRACKED_PT[type]) {
      // 墓碑（问题14/15）：901/10018 报本格 pt=0 = 服务器确认该点已移除（BOSS 死亡等，报文实证 20261114 队长场）。
      //   只覆盖「这里曾记录过跟踪点」的键——视口每刀约两百个空格子不新建条目，#tiles 不膨胀；
      //   写入后 #bossDwellLeave / #bossWindow 的瓦片否决才读得到死亡证据（旧实现 pt=0 直接跳过，陈旧快照永不被纠正）。
      if (type === 0 && prev && prev.pt) {
        this.#tiles.set(k, {
          k: k,
          pt: 0,
          x: x,
          y: y,
          state: 0,
          sET: 0,
          isFight: 0,
          esrId: null,
          teams: 0,
          rTime: 0,
          iNum: null,
          callTId: 0,
          at: now,
          src: src,
        });
      }
      return;
    }
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
      // 警告验真（1115 复核）：占用队伍 uid 列表（本队在读时排除）；缺失 null → 证据不足不忽略警告
      teamUids: Array.isArray(m.teams)
        ? m.teams.map((t) => String((t && t.uid) || '')).filter(Boolean)
        : null,
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
        // visited=0：只用于 #shopStageWant 的全局 gap 基准，不参与窄筛 pickShop 的到店冷却闸（否则开局 8min 进不了任何店）
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
   *   已在新鲜闸窗口内且未降级时**跳过重复查询**（窗口常规 driveViewMs；空闲态放宽到 driveViewIdleMs，
   *   kick 唤醒位强制恢复常规口径——四-1 自适应降频，判据见 view-throttle.js；心跳比窗口慢，正常每拍都会查；kick 抢拍则复用刚落料）。
   *   失败达 `driveViewOffAfter` 次 → 降级 `#viewOff`（`#viewPointsFresh` 随之回 null，选点自动退老 `#pickX` 池），`driveViewRetryMs` 后重试。
   * @param {number} cx 中心 x
   * @param {number} cy 中心 y
   */
  async #awaitView(cx, cy) {
    const env = this.#env;
    if (!(cx > 0) || !(cy > 0)) return;
    const now = Date.now();
    // 四-1 自适应降频：空闲态（WORK 驻留/bossWait/无候选）放宽新鲜闸；kick 唤醒位消费即清、强制常规口径
    const idle = viewIdleNow({
      workMode: this.#workMode,
      bossFeeding: this.#bossFeeding(),
      teamType: Number(tuning.driveTeamType) || 0,
      idleSince: this.#idleSince,
    });
    const forced = this.#viewKick;
    this.#viewKick = false;
    // 未降级 & 视口仍新鲜（≤窗口）→ 不重复撞 901；降级期到 driveViewRetryMs 才重试一刀
    if (!this.#viewOff && this.#viewAt && now - this.#viewAt < viewWaitMs(tuning, idle, forced))
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
   * 区域档位（需求 2：强/普通异能区区分）：`enigma_secret_realm[esrId].roundid`——值越大 = 开放回合越晚
   *   = 越靠地图中心的「强异能区」（字典 FAQ25「先开微异能区、后开强异能区」）。
   *   取不到（esrId 缺失/无该行/离线）回 0 → 该点不参与「强区优先」，退回原按产量-距离打分（安全）。
   *   roundid 对 esrId 是静态配置，按 esrId memo。
   * @param {number|null} esrId 点位所属区域行 id
   * @returns {number} 档位（0=未知）
   */
  #roundTier(esrId) {
    const rid = Number(esrId) || 0;
    if (!(rid > 0)) return 0;
    const hit = this.#roundTierCache.get(rid);
    if (hit != null) return hit;
    let tier;
    try {
      const realm = this.#env.l10n.tableRow(TABLE_REALM, rid);
      tier = realm ? Number(realm.roundid) || 0 : 0;
    } catch (e) {
      tier = 0;
    }
    this.#roundTierCache.set(rid, tier);
    return tier;
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
   *   快照超期（窗口见 view-throttle.viewFreshWinMs：盖得住空闲降频后的最老快照，与在途过滤同尺起步）时回 null
   *   → 调用方本轮不选（落链后续档，等快照恢复，不再退回累积池换语义）。非 null 时是**原样** pointList。
   * @param {number} now 毫秒
   * @returns {Array|null}
   */
  #viewPointsFresh(now) {
    if (this.#viewOff) return null;
    if (!this.#viewPointsAt) return null;
    const win = viewFreshWinMs(tuning);
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
   *   内部消费：#exitStageWant 收场判据（二轮收口后 env.shopBoxBought 透口已随 pickup 三约束移除）。
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
    return !this.#bossDone.has(String(bid));
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
    // 大BOSS 开台前预置挪台窗口毫秒：优先面板 cfg().drive.planeLeadSec（可填 30=半分钟），回落 tuning.driveBossLeadMs。
    const planeLeadMs = this.#planeLeadMs();
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
        // 现场瓦片否决（与 boss.js #liveTileBlock 同判据、同 fail-open）：21535 说 state21，
        //   但新鲜的 10018 快照证明该点已非 BOSS 本体（pt=0 或 state≠21）→ 跳过该候选（阶段切换 21535 不推、滞后）。
        //   #note 边沿去重：本函数每拍都跑（5s），同点只报一次，转正/换场（#told 清空）后可再报。
        const vt = this.#tiles.get(tileKey(bx, by));
        if (vt && now - (vt.at || 0) <= (Number(tuning.bossTileFreshMs) || 0)) {
          const vst = Number(vt.state);
          if (!vt.pt || vst !== ST_BOSS_FIGHTING) {
            this.#note(
              'boss-tile-veto|' + bx + ',' + by,
              'pilot: boss (' +
                bx +
                ',' +
                by +
                ') live tile says state=' +
                vst +
                ', drop candidate',
            );
            continue;
          }
        }
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
        if (left > planeLeadMs) continue; // 还不到该挪队的时刻（面板 drivePlaneLeadSec 可调，见 #planeLeadMs）
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
   * 缺席否决（竞品B getBossInfo `else if (n) state=28` 同源，问题14/15 残留盲区）：
   *   以 BOSS 为中心的 901 应答 OK 且新鲜、但点列里**根本没有 BOSS 格** → 视同死亡证据。
   *   活 BOSS 必在自己中心的视口里；不报格与 pt=0 墓碑同为「服务器已移除」形态，
   *   旧实现只认「有记录且新鲜」的瓦片否决，不报格时旧条目超 bossTileFreshMs 后 fail-open，hold 继续死等。
   *   写墓碑复用 #putTile 同形态（只覆盖已有跟踪点），随后 #bossWindow 的瓦片否决自然生效；
   *   中心对不上（视口被新鲜闸跳过、还是上一拍别的中心）/应答降级/不新鲜一律不判（fail-open）。
   * @param {number} bx BOSS 坐标 x
   * @param {number} by BOSS 坐标 y
   */
  #bossAbsentVeto(bx, by) {
    const dbg = this.#viewDbg;
    if (!dbg || !dbg.ok || dbg.center !== bx + ',' + by) return;
    const now = Date.now();
    if (now - (dbg.at || 0) > (Number(tuning.bossTileFreshMs) || 0)) return;
    const k = tileKey(bx, by);
    const prev = this.#tiles.get(k);
    if (!prev || !prev.pt) return; // 没跟踪过/已是墓碑 → 无陈旧态可纠
    const pts = this.#viewPoints || [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p && Math.floor(toNum(p.x)) === bx && Math.floor(toNum(p.y)) === by) return; // 格在点列里 → 交给常规瓦片否决
    }
    this.#tiles.set(k, {
      k: k,
      pt: 0,
      x: bx,
      y: by,
      state: 0,
      sET: 0,
      isFight: 0,
      esrId: null,
      teams: 0,
      rTime: 0,
      iNum: null,
      callTId: 0,
      at: now,
      src: 'v',
    });
    this.#note(
      'boss-absent-veto|' + k,
      'pilot: boss (' +
        bx +
        ',' +
        by +
        ') absent from fresh boss-centered 901 view, treat as dead. reason=boss_absent_veto',
    );
  }

  /**
   * 当前停靠点能否攻打窗口里的 BOSS：区域（esrId）一致，或任一侧 esr 取不到（缺证放行，撞 142 自会兑底）。
   *   报文实证：平台 esrId 100% 可得；#bossEsrId 决策期恒非 null（21535 已缓存）→ 跨区域能可靠判出。
   *   用途：HOLD（④ 档）与 boss 阶梯同区域分流共用——避免「钉在已清空的小BOSS平台上、为别区打不到的 open BOSS 整场死等」。
   * @param {string} curKey 当前点键
   * @param {object|null} win #bossWindow 结果
   * @returns {boolean} true=本平台可打（或未证）；false=确认跨区域、打不到
   */
  #bossEngageableHere(curKey, win) {
    if (!win || !win.boss) return false;
    const curTile = this.#tiles.get(curKey);
    const esrCur = curTile && curTile.esrId ? curTile.esrId : null;
    const esrB = this.#bossEsrId(win.boss);
    return !esrB || !esrCur || esrB === esrCur;
  }

  /**
   * 大BOSS 开台前预置挪台窗口毫秒：优先面板 `cfg().drive.planeLeadSec`（秒，可填 30=半分钟），
   *   回落 tuning `driveBossLeadMs`（旧 ms 双轨迁移入口），再缺省 60000。
   * @returns {number}
   */
  #planeLeadMs() {
    const pl = (this.#env.cfg().drive || {}).planeLeadSec;
    if (Number.isFinite(pl) && pl >= 0) return pl * 1000;
    return Number(tuning.driveBossLeadMs) || 60000;
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
    // 勤务档由开车方案顶层旗标 shopErrand 表达（default 方案含；方案不含即不做这趟勤务，无面板子闸）。
    const plan = PLANS[this.#planIdUsed] || PLANS.default;
    if (plan.shopErrand !== false && !this.#shopErrandDone) {
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
      if (t.k === curKey || self.#dayBlack.has(t.k)) return;
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
    // 目标 BOSS 必须仍活着（1115 问题4③）：已死（新鲜瓦片墓碑/终局态或权威 state28/30）不派台，
    //   治「跑回死平台发呆」；bossBaseInfo 滞后时瓦片证据先行否决（fail-open，无证据不拦）。
    if (this.#bossDeadAt(tileKey(boss.x, boss.y))) return null;
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
    //   174 兜底删除：两场实录全程 0 块，属无证据路径。
    let readyBest = null; // 硬筛集（state==22）内的最优
    let readyScore = -Infinity;
    let anyBest = null; // 兜底集（不看 state）的最优
    let anyScore = -Infinity;
    this.#tiles.forEach(function (t) {
      if (t.pt !== PAB_BOSS_PLANE) return;
      if (self.#dayBlack.has(t.k)) return;
      if (self.#paramBlocked(t.k)) return; // 159995 短黑窗内的平台不再选（该点当前不可打，窗过自然恢复）
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
   * 窄筛（§5.1）用的商店引力锚：取**「还没买过香肠的店里最近的一家」**，
   *   **空则不回退**（竞品 L24718 `t.filter(e=>0==sausage).sort(byDist)[0]`：无一家免香肠店就
   *   不挂锚，成本项计 0）。未建账的店视为 sausage=0（还没买过）。
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
      if (!k || this.#tiles.has(k) || this.#dayBlack.has(k)) continue;
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
    if (kind === 'evade') {
      // 再逃窗与 evade 冷却取 max：driveThreatReEvadeMs 只小于本值时不致形同虚设（#mayEvade 先被本闸拦）
      this.#evadeCoolUntil =
        Date.now() +
        Math.max(
          Number(tuning.driveEvadeCooldownMs) || 0,
          Number(tuning.driveThreatReEvadeMs) || 0,
        );
    }
    // 商店发车必带 #shopWant 的动机（exit/stage/errand/sausage/gap）：事后复盘「为什么冲商店」
    //   要在 info 单轨就能直接定责，不依赖下一拍的 debug 心跳（面板 minLvl=info 时收不到 debug）。
    env.log.info(
      'pilot: goto %s reason=%s%s',
      this.#toKind,
      kind,
      kind === 'shop' ? ' why=' + (this.#lastShopWhy || '-') : '',
    );
    const self = this;
    const myKey = this.#toXY;
    const wake = function () {
      self.#kick();
    };
    ret
      .then(function (r) {
        if (!env.alive()) return;
        if (self.#toXY !== myKey) return; // 相位已被后续拍替换 → 这笔应答过期
        if (r && r.code === CODE_NOT_SENT) return;
        const ok = r && (r.ok === undefined ? Number(r.code) === 0 : !!r.ok);
        if (ok) return; // 上线成功：推进交给到达复核/超时兜底
        const rej = String((r && r.reason) || '');
        // 拒码处置表化（三-3）：码义与处置参数见 rejects.js 共享真相表，与 boss.js 攻打档同源
        self.#applyReject(rej, r);
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
   * 拒码处置解释器（三-3）：读 rejects.js 共享真相表的 pilot 列，逐位执行旧 if 链的处置。
   *   顺序契约：拉黑/脱表 → 副作用（清回攻/复拉 BOSS 态）→ 日志 → 清相位 → 退避 → kick；
   *   158 keepPhase 不 kick（在途正常形态，下一拍自然重评）；157 直接进 WORK。
   *   explore 档豁免退避（问题1）：159 已拉黑该点且发车时扇区已轮转，下一拍自然换点重试，
   *   白等 rejectBackoffMs 只会把开局节奏拖过商店 warmup 窗（报文实证 20261114 队长场）。
   *   表未登记的码 → 兜底：info + 清相位 + rejectBackoffMs 退避。
   * @param {string} rej 服务端 reason
   * @param {object} r Ret（兜底日志取 code 用）
   */
  #applyReject(rej, r) {
    const env = this.#env;
    const self = this;
    const wake = function () {
      self.#kick();
    };
    const rule = matchReject(rej);
    const p = rule && rule.pilot;
    const tag0 = this.#toTag; // 拍首快照：下方 #clearTo 会清 #toTag，退避豁免判据须用清前的值
    if (!p) {
      env.log.info(
        'pilot: goto %s rejected (%s), re-evaluate after %ds.',
        this.#toKind,
        rej || 'code ' + (r && r.code),
        Math.round(tuning.rejectBackoffMs / 1000),
      );
      this.#clearTo();
      this.#cooldownUntil = Date.now() + tuning.rejectBackoffMs;
      wake();
      return;
    }
    if (p.stopMatch) this.#realmClosed = true;
    if (p.enterWork) {
      this.#enterWork(this.#toXY);
      wake();
      return;
    }
    if (p.keepPhase) return;
    // 拉黑分流：day=本场黑（onlyTag/unlessTag 按 #toTag 闸）；param=159995 专表短黑（只被 #paramBlocked 消费，
    //   不写 marched：#pickPlane/bossFight 不读它，写进去无消费者会 5s 循环不断）
    if (p.black === 'day') {
      const tagOk = p.onlyTag
        ? this.#toTag === p.onlyTag
        : p.unlessTag
          ? this.#toTag !== p.unlessTag
          : true;
      if (tagOk) this.#dayBlack.mark(this.#toXY);
    }
    if (p.black === 'param') this.#paramBlack.set(this.#toXY, Date.now() + tuning.paramBlacklistMs);
    if (p.dropShop) this.#dropShopAt(this.#toXY);
    if (p.clearReturn && this.#toTag === 'return') {
      this.#returnPending = false;
      this.#escapeFrom = null;
    }
    if (p.refreshBoss) {
      const tp = String(this.#toXY || '').split(',');
      this.#refreshBossState(Number(tp[0]), Number(tp[1]));
    }
    if (p.log) this.#rejectLog(p.log, rej, r);
    if (p.clearTo) this.#clearTo();
    // explore 档不抬退避锁：被拒点已进 dayBlack、#exploreSpin 已轮转，下拍 #explorePoint 必换扇区，
    //   无需 5s 空等（问题1：开局 159 退避把首次有效派发拖到链尾商店窗）
    if (p.backoff && tag0 !== 'explore')
      this.#cooldownUntil = Date.now() + Number(tuning[p.backoff]);
    if (tag0 === 'explore') {
      // 探索拒后回拨闲逛起表（问题1）：发车时 #idleSince 刚重置，不回拨则换点重试要再等满
      //   driveIdleExploreMs(30s)；被拒点已拉黑、扇区已轮转，下拍 #shouldExplore 即真 → 立即换扇区再探
      this.#idleSince = Date.now() - Number(tuning.driveIdleExploreMs);
    }
    wake();
  }

  /**
   * 拒码日志模板渲染（表内文案逐字保留，dashcam grep 契约）：
   *   note 档走 #told 一次性边沿（固定键或前缀拼 toXY），其余按 lvl 直出。
   * @param {object} spec rejects.js 的 RejectLogSpec
   * @param {string} rej 服务端 reason
   * @param {object} r Ret
   */
  #rejectLog(spec, rej, r) {
    const toks = spec.args || [];
    const args = [];
    for (let i = 0; i < toks.length; i++) args.push(this.#rejectToken(toks[i], rej, r));
    if (spec.lvl === 'note') {
      const key = spec.keyPrefix ? spec.keyPrefix + this.#toXY : spec.key;
      if (!this.#told[key]) {
        this.#told[key] = 1;
        this.#env.log.info(spec.tpl, ...args);
      }
      return;
    }
    this.#env.log[spec.lvl](spec.tpl, ...args);
  }

  /**
   * 拒码日志 token → 实参（未知 token 原样返回，不静默吞）。
   * @param {string} tok token 名
   * @param {string} rej 服务端 reason
   * @param {object} r Ret
   * @returns {*}
   */
  #rejectToken(tok, rej, r) {
    switch (tok) {
      case 'xy':
        return this.#toXY;
      case 'kind':
        return this.#toKind;
      case 'rej':
        return rej;
      case 'codeOrRej':
        return rej || 'code ' + (r && r.code);
      case 'marchedSec':
        return Math.round(tuning.driveMarchedTtlMs / 1000);
      case 'paramSec':
        return Math.round(tuning.paramBlacklistMs / 1000);
      case 'backoffSec':
        return Math.round(tuning.rejectBackoffMs / 1000);
      default:
        return tok;
    }
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
   *   173/163 → 'empty'（拿空当拍即走，无驻留地板）；161 → 'dwell'（让 shop.js 逐行买货）；
   *   176/174/其余 → 'dwell'（driveWorkDwellMs，让 boss.js 打仗）。
   * @param {string} key 到达点位键
   */
  #enterWork(key) {
    const marchStart = this.#toAt; // 清相位前先捕获：下方区分 exhausted 新旧标记用
    this.#toKind = '';
    this.#toXY = key;
    this.#toAt = 0;
    // 到点重评：只清**本次发车前**的「对我已采完」旧标记（若因面板/上限变了这次可能又要采）；
    //   行军途中 pickup 经 markTileExhausted 写的新标记（at≥发车时刻）说明「路上已确认没得采」，必须保留——
    //   旧实现无条件删会在到点那一刻把它抹掉，empty 相位白等到 45s 天花板（问题2/17）。
    const ex = this.#exhausted.get(key);
    if (!ex || typeof ex !== 'object' || !(ex.at >= marchStart)) this.#exhausted.delete(key);
    const env = this.#env;
    const base = env.secret.getRoomBaseInfo();
    const pt = Number((base && base.pointType) || 0);
    const now = Date.now();
    this.#workPt = pt; // 驻留相位锁存点型，#workTick 据此判 BOSS/商店相位（不依赖实时 pointType）
    // 点型策略纯决策（三-4，work-mode.js）：状态补丁逐位应用，副作用（账本/冷却/kickShop）随后执行
    const patch = workEnter(pt, {
      now: now,
      key: key,
      d: env.cfg().drive || {},
      t: tuning,
      change: this.#change.get(key) || null,
      tile: this.#tiles.get(key) || null,
      sausageHave: env.secret.getItemNumById(ITEM_SAUSAGE) || 0,
      shopLedgerEntry: this.#shopLedger.get(key) || null,
    });
    this.#workMode = patch.workMode;
    this.#workUntil = patch.workUntil;
    this.#workDeadline = patch.workDeadline;
    this.#shopGiveUp = false; // 新一次驻留不带上一站的止损信号
    if (patch.shopErrandDone) this.#shopErrandDone = true;
    if (patch.shopLastAt) this.#shopLastAt = patch.shopLastAt;
    if (patch.shopLedgerEntry) this.#shopLedger.set(key, patch.shopLedgerEntry);
    if (patch.shopCoolUntil) this.#shopCoolUntil = patch.shopCoolUntil;
    if (patch.kickShop && typeof env.kickShop === 'function') env.kickShop();
    if (this.#escapeFrom && key === tileKey(this.#escapeFrom.x, this.#escapeFrom.y)) {
      this.#escapeFrom = null;
    }
    env.log.info('pilot: arrived %s (pt=%s), enter %s phase.', key, pt, this.#workMode);
  }

  /**
   * 账本口径的「白跑惩罚」：锚点里**每家店都已试过**却仍判「缺香肠」
   *   → 说明缺口补不满（买不起/额度买完/缺刷新币），商店档先进长冷却（driveShopGapCooldownMs）；
   *   否则会形成「离店→缺口仍在→又开回同一家店」的永动。
   * 旧的判据是「每家 `sausage>0`」（四家都真买到过香肠），因老选店当时不换店而**永不成立**（根因 D）；
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
   * WORK 相位一拍推进：事实预采（判空/拍宠让路/BOSS 提前离点判据）→ work-mode.js 纯决策 → 补丁/日志落地。
   * @param {number} now 毫秒
   * @returns {{leave:boolean,sleep:number}}
   */
  #workTick(now) {
    const env = this.#env;
    const pt = this.#workPt;
    const f = {
      now: now,
      key: this.#toXY,
      d: env.cfg().drive || {},
      t: tuning,
      isEmpty: this.#workMode === 'empty' ? this.#isTileEmpty(this.#toXY) : false,
      captureBusy: false,
      bossLeaveWhy: null,
      bossWin: null,
      bossLiveHere: false,
      sausageHave: env.secret.getItemNumById(ITEM_SAUSAGE) || 0,
      shopGiveUp: this.#shopGiveUp,
    };
    if (this.#workMode !== 'empty' && isBossish(pt)) {
      f.captureBusy = this.#captureBusy();
      if (!f.captureBusy) {
        const bp = String(this.#toXY || '').split(',');
        const bxy = { x: Number(bp[0]), y: Number(bp[1]) };
        this.#refreshBossState(bxy.x, bxy.y); // 21535 只读复拉（限速），让 BOSS 阶段态尽快转正
        f.bossLeaveWhy = this.#bossDwellLeave(this.#toXY);
        if (!f.bossLeaveWhy) {
          f.bossWin = this.#bossWindow(now, bxy);
          f.bossLiveHere = this.#bossLiveHere(this.#toXY);
        }
      }
    }
    if (this.#workMode === 'empty') {
      // BOSS 窗中断（问题21②）：井/掉落箱采集中 BOSS 窗开了 → 立即离点让路（work-mode empty 分支消费 f.bossWin）。
      //   只在 teamType>0 且当前方案含 BOSS 档时算（obj 基判定，与 BOSS 档 when 同口径，不按阶段 id 特判），
      //   不打扰单人只拿百兽箱模式；拍宠中不中断（同威胁块让路语义）。
      const plan = PLANS[this.#planIdUsed] || PLANS.default;
      const hasBossStage = (plan.stages || []).some(
        (s) =>
          s &&
          (s.obj === 'bossFight' ||
            (s.obj === 'plane' && s.params && s.params.source === 'bossWindow')),
      );
      if ((Number(tuning.driveTeamType) || 0) > 0 && hasBossStage && !this.#captureBusy()) {
        const ep = String(this.#toXY || '').split(',');
        f.bossWin = this.#bossWindow(now, { x: Number(ep[0]), y: Number(ep[1]) });
      }
    }
    const r = workTick(
      pt,
      {
        workMode: this.#workMode,
        workUntil: this.#workUntil,
        workDeadline: this.#workDeadline,
      },
      f,
    );
    if (r.log) env.log.info(r.log.tpl, ...r.log.args);
    return { leave: r.leave, sleep: r.sleep };
  }

  /**
   * BOSS 驻留点的提前离点判据（计划 B.3）：现场瓦片证明 BOSS 已终局（`state∈{28,30}` 或点已移除 pt=0），
   *   或**本点这只** BOSS 进入投喂窗（state23）且石头账本无它的可领条目 → 交回 boss.js/capture，车不留。
   *   投喂判据只看本点：`#bossFeeding()` 是「任一 BOSS state23」的全局口径，别区开台会把
   *   本点仍在 state21 交战（石头尚未产出、账本必无条目）的车赶下点，白丢攻打进度。
   *   与 boss.js #liveTileBlock 同 fail-open 语义：证据超龄（>`bossTileFreshMs`）或读不到一律不据此判死。
   * @param {string} key 当前驻留点键 'x,y'
   * @returns {string|null} 离点理由（null=不提前离）
   */
  #bossDwellLeave(key) {
    const now = Date.now();
    const t = this.#tiles.get(key);
    if (t && now - (t.at || 0) <= (Number(tuning.bossTileFreshMs) || 0)) {
      if (!t.pt) return 'point removed (tile pt=0)';
      const st = Number(t.state);
      if (st === ST_BOSS_FIGHTING_END || st === ST_BOSS_DEAD_END) return 'tile says state=' + st;
    }
    const bid = this.#bossIdAtKey(key);
    if (bid) {
      const list = this.#env.secret.getBossBaseInfo();
      const cur = Array.isArray(list)
        ? list.find(function (s) {
            return s && Number(s.bossId) === bid;
          })
        : null;
      // 本点这只进投喂窗且石头未产出 → 攻打/投喂已交接 boss.js，车不留；别区投喂不干涉本点
      if (cur && Number(cur.state) === ST_BOSS_FEED && !this.#stoneEntryFor(bid)) {
        return 'feed window, no claimable stone (bossId=' + bid + ')';
      }
    }
    return null;
  }

  /** 当前点的 BOSS 本体 bossId（getBossBaseInfo pos 对账；无匹配回 0）。 */
  #bossIdAtKey(key) {
    if (!key) return 0;
    const parts = String(key).split(',');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !s.pos) continue;
      if (Math.floor(toNum(s.pos.x)) === x && Math.floor(toNum(s.pos.y)) === y)
        return Number(s.bossId) || 0;
    }
    return 0;
  }

  /**
   * 本点自己那只 BOSS 是否仍未终局（state 21 交战 / 22 开台读秒 / 23 投喂窗）。
   *   供 #workTick 平台无窗出口兜闸：#bossWindow 不建模 state23、且对 state22 在 lead 窗外会 continue，
   *   二者都会让 win=null 但本点其实还有仗要打/有石头要领——此时不得据 win=null 赶车。
   * @param {string} key 当前驻留点键 'x,y'
   * @returns {boolean} true=本点 BOSS 仍存活未终局
   */
  #bossLiveHere(key) {
    const bid = this.#bossIdAtKey(key);
    if (!bid) return false;
    const list = this.#env.secret.getBossBaseInfo();
    if (!Array.isArray(list)) return false;
    const cur = list.find(function (s) {
      return s && Number(s.bossId) === bid;
    });
    if (!cur) return false;
    const st = Number(cur.state) || 0;
    return st === ST_BOSS_FIGHTING || st === ST_PLANE_MARCH || st === ST_BOSS_FEED;
  }

  /**
   * 本点 BOSS 是否已确证死亡（1115 问题4③）：新鲜瓦片墓碑（pt=0）或终局态（28/30），
   *   或权威 bossBaseInfo state28/30。fail-open：无证据/证据超龄一律回 false（不误清回攻/不拦派台）。
   * @param {string} key 点位键
   * @returns {boolean}
   */
  #bossDeadAt(key) {
    if (!key) return false;
    const now = Date.now();
    const t = this.#tiles.get(key);
    if (t && now - (t.at || 0) <= (Number(tuning.bossTileFreshMs) || 0)) {
      if (!t.pt) return true;
      const st = Number(t.state);
      if (st === ST_BOSS_FIGHTING_END || st === ST_BOSS_DEAD_END) return true;
    }
    const bid = this.#bossIdAtKey(key);
    if (bid) {
      const list = this.#env.secret.getBossBaseInfo();
      const cur = Array.isArray(list)
        ? list.find(function (s) {
            return s && Number(s.bossId) === bid;
          })
        : null;
      if (cur) {
        const st = Number(cur.state);
        if (st === ST_BOSS_FIGHTING_END || st === ST_BOSS_DEAD_END) return true;
      }
    }
    return false;
  }

  /**
   * 锁存大BOSS（177 本体）瓦片键：#tiles 首见即记（一场只有一只 177）。
   *   墓碑会把 pt 覆盖成 0、反查不到身份，故必须活着时先记键；没扫到＝不锁存
   *   （开局视口未扫到大BOSS 区不影响：死亡检测还有权威 pos 对账兜底，但身份仍需瓦片首见）。
   */
  #syncBigBossKey() {
    if (this.#bigBossKey) return;
    for (const t of this.#tiles.values()) {
      if (t && t.pt === PAB_BOSS) {
        this.#bigBossKey = t.k;
        return;
      }
    }
  }

  /**
   * 大BOSS 死局证据（终局触发判据）：新鲜瓦片墓碑（pt=0）或 state30，或权威 bossBaseInfo state30。
   *   **不认 28**：28=战斗结算，大BOSS 其后还有投喂/拍宠窗（23）——认 28 会把最后一趟商店
   *   派进 23 窗连吃 159995 且丢己方投喂分；30=投喂窗收、死局（奖励弹窗同拍弹出）才起 hold。
   *   fail-open 同 #bossDeadAt：无证据/证据超龄一律回 false（不误收场）。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #bigBossEnded(now) {
    const t = this.#tiles.get(this.#bigBossKey);
    if (t && now - (t.at || 0) <= (Number(tuning.bossTileFreshMs) || 0)) {
      if (!t.pt) return true;
      if (Number(t.state) === ST_BOSS_DEAD_END) return true;
    }
    const bid = this.#bossIdAtKey(this.#bigBossKey);
    if (!bid) return false;
    const list = this.#env.secret.getBossBaseInfo();
    const cur = Array.isArray(list)
      ? list.find(function (s) {
          return s && Number(s.bossId) === bid;
        })
      : null;
    return !!cur && Number(cur.state) === ST_BOSS_DEAD_END;
  }

  /**
   * 终局最后一趟商店选点：最近店锚点，**不看访问记忆/消费账/revisit 冷却**（收场车语义同 shopExit
   *   urgent：四家都去过也必须再走一趟把余晶花掉）；只排当前点与两类拉黑账。
   * @param {string} curKey 当前停泊键
   * @param {{x:number,y:number}} cur 当前停泊坐标
   * @returns {{x:number,y:number}|null}
   */
  #pickFinalShop(curKey, cur) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this.#shops.length; i++) {
      const s = this.#shops[i];
      const k = tileKey(s.x, s.y);
      if (!k || k === curKey) continue;
      if (this.#dayBlack.has(k) || this.#paramBlocked(k)) continue;
      const d = dist(cur.x, cur.y, s.x, s.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** 终局相位转场写穿模块级闩（index.js matchOver）：引擎重建后同场恢复靠它；fb 非法不写。 */
  #noteMatchOver() {
    const env = this.#env;
    if (typeof env.noteMatchOver !== 'function' || !this.#endgame) return;
    if (!(this.#matchFightBegin > 1e11)) return;
    env.noteMatchOver({
      fb: this.#matchFightBegin,
      phase: this.#endgame.phase,
      until: this.#endgame.until,
    });
  }

  /** 本点是否处在 159995 短黑窗内（TtlLedger 惰性过期模板：读时判、到期删，不单独清扫；窗口仅 paramBlacklistMs）。 */
  #paramBlocked(key) {
    if (!key) return false;
    const until = this.#paramBlack.get(key);
    if (!(until > 0)) return false;
    if (Date.now() >= until) {
      this.#paramBlack.delete(key);
      return false;
    }
    return true;
  }

  /** 石头账本里是否有该 bossId 的可领条目（存在即视为有可领）。 */
  #stoneEntryFor(bid) {
    const reward = this.#env.secret.getBossGuardRewardInfo();
    if (!Array.isArray(reward)) return false;
    for (let i = 0; i < reward.length; i++) {
      if (reward[i] && Number(reward[i].bossId) === bid) return true;
    }
    return false;
  }

  /**
   * 21535 主动复拉（计划 B.2）：驻留点是 BOSS 点或 return 档被拒时，发一次 8522 POINT_INFO（只读）
   *   触发服务端刷新 bossBaseInfo（阶段切换 21535 不推、滞后）；按 `driveBossStateGapMs` 限速，避免逐拍敲。
   *   fail-open：坐标非法/发不出去都静默跳过，不伤主逻辑。
   * @param {number} x BOSS 点 x
   * @param {number} y BOSS 点 y
   */
  #refreshBossState(x, y) {
    const now = Date.now();
    const gap = Number(tuning.driveBossStateGapMs) || 15000;
    if (this.#bossStatePullAt && now - this.#bossStatePullAt < gap) return;
    if (!(x > 0) || !(y > 0)) return;
    this.#bossStatePullAt = now;
    try {
      const ret = this.#env.secret.sendSecret(CMD_POINT_INFO, {
        x: Math.floor(x),
        y: Math.floor(y),
      });
      // 应答落地唤醒一拍：21535 阶段切换不推、10018 到达也不 kick，不主动唤醒就只能等分段轮询那一拍
      if (ret && typeof ret.then === 'function') {
        const self = this;
        ret.then(function () {
          self.#kick();
        });
      }
    } catch (e) {
      /* 只读复拉失败不影响主逻辑，下一窗再试 */
    }
  }

  /**
   * 本拍是否允许逃袭（计划 D.2：「一次威胁窗只逃一次」改为可再逃）。
   *   未逃过→放行；已扎过一次营但 num>0 仍持续超 `driveThreatReEvadeMs` 且未超整场上限 `driveThreatReEvadeMax` → 允许再挪。
   * @param {number} now 毫秒
   * @returns {boolean}
   */
  #mayEvade(now) {
    // evade 专属冷却（D.4）：上一次逃后 driveEvadeCooldownMs 内不再重发 evade（不抬全局路由锁，不拦常规选点）
    if (this.#evadeCoolUntil && now < this.#evadeCoolUntil) return false;
    if (!this.#threatEvaded) return true; // 首逃
    const reMs = Number(tuning.driveThreatReEvadeMs) || 0;
    const max = Number(tuning.driveThreatReEvadeMax) || 0;
    if (!(reMs > 0) || !(max > 0)) return false;
    return this.#threatReEvade < max && now - this.#threatEvadeAt >= reMs;
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
    // 第三路（本队口径）：拾取引擎已判此点对我无可采/无需采（单人开车剩下的都是不要的）。
    //   前两条（CHANGE 空位数 / 10018 rTime·iNum 现状态）只看服务器全局态，抓不到「有货但我不要」。
    if (this.#exhausted.has(key)) return true;
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
    // 区域一致判定：交给 #bossEngageableHere（见其注释）——缺证放行，撞 142 拒码分流自会兑底。
    const sameArea = this.#bossEngageableHere(curKey, win);
    return {
      snap: { cur: cur, curKey: curKey, curPt: curPt, boss: win ? win.boss : null },
      shopWhy: this.#lastShopWhy,
      teamType: Number(tuning.driveTeamType) || 0,
      bossMode: win ? win.mode : null,
      onBossPlane: curPt === PAB_BOSS_PLANE,
      bossSameArea: sameArea,
      bossFeeding: this.#bossFeeding(),
      marchPolicy: Number(tuning.driveMarchPolicy) || 0,
      beastPolicy: Number(tuning.driveBeastPolicy) || 0,
      // 面板抓宠等级（drivePetLevel）：0=不抓宠，等价「完全不打野」——plans 打野三 stage 的 when 见 !c.beastOff 短路（不改 tuning 值）。
      beastOff: !(Number(b.petLevel) > 0),
      relax: !!this.#beastStageWant(now),
      beastLock: !!this.#beastLockNow(now),
      // ⚠ 纯读不起表：现状 #shouldExplore 的「未起表先起表(now)」副作用只发生在链全空走到梯尾
      //   那一拍（L2391/2465-2468）；eager 调用会让 BOSS 让位/收场独占拍提前起表、把探索档
      //   早开 ~30s（真实报文差分回放实钉）。起表改由 #runStages 尾部补。
      shouldExplore: this.#shouldExplore(now),
    };
  }

  /**
   * 目标原语 `Objectives[obj]`：把方案里的目标名翻成**选点调用**（resource/beast/shop 一律走
   * pilot-select 窄筛，料源不可用时本轮不选，不再回退累积池老语义）。纯选择：不发 8521、
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
      case 'bossFight': {
        // 现状 L2358-2360：已停 BOSS 平台且与目标 BOSS 同区域 → 发 8521 打本体。
        //   ⚠ 这不是 boss.js 的活：它只接管**已停 BOSS 相关点**后的打仗/投喂/石头（isBossish 让位），
        //   「从平台开上本体」这一笔行军仍归方向盘；§14.2 方案①的让位到点层是 Phase C 的事。
        if (!snap.boss) return null;
        const bk = tileKey(snap.boss.x, snap.boss.y);
        // 159995 短黑窗内的本体不再直冲（否则每 rejectBackoffMs 重撞同点）；
        //   当日黑（159 点不存在）同样拦（问题13 附带：与回攻档同闸）。
        if (this.#paramBlocked(bk) || this.#dayBlack.has(bk)) return null;
        return { x: snap.boss.x, y: snap.boss.y };
      }
      case 'plane':
        // win=null（quiet 拍）时 snap.boss 为空：回 null 让引擎落后续档，不踩空
        return snap.boss ? this.#pickPlane(snap.boss, snap.curKey) : null;
      case 'shop': {
        const p = params || {};
        // 优先级：exit（收场只拿货）=不优先香肠 / preferNoSausage（高光）=优先 / 链尾兜底=有去店理由时优先。
        const prefer = p.exit ? false : p.preferNoSausage ? true : !!ctx.shopWhy;
        // 商店坐标来自权威表（非 901 快照）→ 不受新鲜度闸限；表未下发 → 本轮不选，等表下发（不再退视口 161 兜底）。
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
        // 权威表未下发：本轮不选，落链后续档等表（不再读累积 #tiles 池换语义）
        return null;
      }
      case 'beast': {
        // 禁走窗（开台读秒后 0~180s 不拍野）：窗内这一档直接跳过（§5.3 L24780 提前放弃）
        if (ctx.beastLock) return null;
        // 品质门槛：优先面板 cfg().drive.petLevel（夹 [1,4]），回落 tuning.driveBeastMinQuality。
        const bq = (this.#env.cfg().drive || {}).petLevel;
        const minQ =
          Number.isFinite(bq) && bq >= 1 && bq <= 4 ? bq : Number(tuning.driveBeastMinQuality) || 4;
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
        // 901 快照不可用（降级/未起/超期）：本轮不选，落链后续档等快照恢复
        return null;
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
        // 单跳车程封顶（需求 B/3：避免长途直冲被守株待兔）：车程秒上限 × 地图速度 → 距离格。
        //   秒上限取面板可配 cfg.drive.hopMaxSec（缺省回落 tuning.driveHopMaxSec）；严格档 maxDist(100) 更紧时以其为准。
        const dCfg = this.#env.cfg().drive || {};
        const hopSec = Number.isFinite(dCfg.hopMaxSec)
          ? dCfg.hopMaxSec
          : Number(tuning.driveHopMaxSec) || 10;
        const hopMaxDist = hopSec * (Number(tuning.driveMapUPS) || 2.8);
        // 窄筛（§5.1 四道闸）唯一选点路：只吃本刀 901 原样快照，不读累积 `#tiles` 池，
        //   也**不**看 `rTime>now` 判空 / `consumed` 10min 黑名单 / 当日拉黑（竞品无此三闸，§5.1 实证）。
        //   唯一本地附加：exhausted 对我已采完账（isExhausted，问题19）——pickup 已判没我得采的井去了白跑。
        //   快照不可用（901 降级/未起/超期）→ 本轮不选，落链后续档等快照恢复。
        const now = Date.now();
        const pts = this.#viewPointsFresh(now);
        if (pts) {
          const mkCtx = (hop) => ({
            startPoint: snap.cur,
            serverTimeSec: Math.floor(now / 1000),
            minNum,
            maxDist,
            hopMaxDist: hop,
            isRoundOpen: (id) => this.#roundOpen(id),
            preferStrong: !!Number(tuning.driveStrongPull),
            roundTier: (id) => this.#roundTier(id),
            marches: this.#viewMarchList,
            marchedList: this.#marchedListArr(),
            marchPolicy: Number(tuning.driveMarchPolicy) || 0,
            firstUnrewardedBoss: bossA,
            nearestNoSausageShop: this.#nearestNoSausageShop(snap.cur),
            // 对我已采完账（问题19）：pickup 回灌「没我得采」的井不再选（与 consumed 防重派不同，此闸防白跑）
            isExhausted: (x, y) => this.#exhausted.has(tileKey(x, y)),
            // 快照新鲜度惩罚（1115 问题2）：瓦片上次更新越旧扣分越多，优先近期视口井；
            //   逐瓦片读 #tiles.at（10018 push 可刷单瓦片，比整刀共享的 #viewPointsAt 更有区分度）
            nowMs: now,
            tileAt: (x, y) => {
              const t = this.#tiles.get(tileKey(x, y));
              return t ? t.at || 0 : 0;
            },
            staleScorePerSec: Number(tuning.driveStaleScorePerSec) || 0,
          });
          const sel = pickResource(pts, mkCtx(hopMaxDist));
          this.#pickDbg = {
            src: 'view901',
            seen: pts.length,
            hopMaxDist,
            best: sel
              ? tileKey(sel.x, sel.y) +
                ' score=' +
                sel.score.toFixed(2) +
                (sel.waypoint ? ' via→' + tileKey(sel.goal.x, sel.goal.y) : '')
              : '',
          };
          if (sel) return { x: sel.x, y: sel.y };
          // 需求 3/4：窗内无「最合理井」落脚跳板 → 取不封顶时的打分最优井作 goal，向它跳最近资源/平台/宠物。
          const far = pickResource(pts, mkCtx(Infinity));
          if (far) {
            const hop = this.#hopTowardGoal(
              snap.curKey,
              snap.cur,
              { x: far.x, y: far.y },
              hopMaxDist,
            );
            if (hop) {
              this.#pickDbg.hop = tileKey(hop.x, hop.y) + ' →' + tileKey(far.x, far.y);
              return { x: hop.x, y: hop.y };
            }
          }
          return null;
        }
        // 901 快照不可用（降级/未起/超期）：本轮不选，落链后续档等快照恢复
        return null;
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
    //   BOSS 档/①②独占/读秒让路/lead短睡全程不碰。链成员资格由 stage.chain 声明（三-5 下沉，
    //   plans.js 契约 4），标志位把这条「到哪拍才赋值」的时序保住。
    let chainMarked = false;
    const list = matchStages(plan, ctx);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const dg = STAGE_DIAG[s.id] || null;
      if (s.chain && !chainMarked) {
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
          //   两者都不清零闲逛计时。空候选处置由 stage 属性声明（三-5）：
          //   emptyShopMark=记到店防重评+scan 短睡；其余 terminal 档走常规派发后睡眠。
          if (s.emptyShopMark) this.#shopLastAt = now;
          this.#stage = dg.stage;
          if (s.obj === 'shop') this.#stageWhy = why; // BOSS 拍不碰 why（现状⑤从头到尾不赋）
          this.#lastBranch = branch;
          this.#dispatch(kind, null);
          this.#heartbeat(now);
          return s.emptyShopMark ? tuning.driveScanMs : this.#sleepAfterDispatch();
        }
        if (s.emptyNote) {
          // 空候选边沿 info（三-5 下沉：文案/键名归方案声明）。串行模型下 901 已由
          //   #autoLeader await 拉完（以 BOSS 为中心），不存在「在途未回」可等：选不到就是真没有
          //   → 记一笔后落回后续档（这就是开台读秒档不标 terminal 的原因）。
          this.#note(s.emptyNote.key, s.emptyNote.msg);
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
      if (s.explore) {
        // 探索档发车副作用（三-5：由 stage.explore 声明，不再按 obj 名特判）
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
        if (s.tailShopLog && why) {
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
    const now = Date.now();
    // 全局路由锁快照（闸已下移到②回攻之前，见下方注释）：本拍「离店」抬的锁不挡本拍发车，
    //   保住旧「驻留满→立即派下一站」节拍；只挡后续拍的重路由。
    const coolUntil0 = this.#cooldownUntil;

    const base = env.secret.getRoomBaseInfo();
    this.#gateState('no-base', !base || !base.startPoint, 'no roomBaseInfo/startPoint');
    if (!base || !base.startPoint) {
      this.#lastBranch = 'no-base';
      this.#heartbeat(now);
      return tuning.driveScanMs;
    }

    // 换场复位：fightBeginTime 变化 = 新一场秘境（全部场级状态走单一 #resetMatch，见该方法注释）
    const fb = toNum(base.fightBeginTime);
    if (fb > 1e11 && fb !== this.#matchFightBegin) {
      this.#resetMatch(fb);
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

    // ── 终局检测/恢复（独立于 drive 开关）：大BOSS（177）确证死局 → hold→最后一趟商店→done ──
    //   检测置于 cfg-off 闸之前：drive 关着也观测死局落闩，同场晚些再勾启用直接走终局不复活巡航。
    //   死局＝新鲜瓦片墓碑/state30 或权威 state30（**不认 28**：大BOSS 28 后还有投喂窗，见 #bigBossEnded）。
    //   模块级闩（index.js matchOver）活过 pause/resume/开关翻转的引擎重建：恢复时 fb 对上才认。
    this.#syncBigBossKey();
    const mo = typeof env.getMatchOver === 'function' ? env.getMatchOver() : null;
    if (!this.#endgame && mo && mo.fb === fb) {
      this.#endgame = { phase: mo.phase, until: mo.until || 0 };
    }
    if (!this.#endgame && this.#bigBossKey && this.#bigBossEnded(now)) {
      const hold = Number(tuning.driveEndgameHoldMs) || 5000;
      this.#endgame = { phase: 'hold', until: now + hold };
      env.log.info(
        'pilot: final BOSS dead-end confirmed at %s, hold reward popup %dms then one final shop trip; autopilot ends for this match afterwards. reason=endgame_begin',
        this.#bigBossKey,
        hold,
      );
      this.#noteMatchOver();
    }
    if (this.#endgame && this.#endgame.phase === 'done') {
      this.#gateState(BR_MATCH_OVER, true, 'final BOSS dead, autopilot ended for this match');
      this.#lastBranch = BR_MATCH_OVER;
      this.#heartbeat(now);
      return tuning.driveScanMs * 4;
    }
    this.#gateState(BR_MATCH_OVER, false, '');
    const b = env.cfg().drive;
    this.#gateState('cfg-off', !b || !b.enabled, 'drive.enabled=false');
    if (!b || !b.enabled) {
      this.#lastBranch = 'cfg-off';
      this.#heartbeat(now);
      return tuning.driveScanMs;
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

    // ── ⓪ 遭遇战连输即逃（1115 问题9，系统默认连输 2 场）：21523 判连输达阈 → 当拍派 evade ────────
    //   置于威胁块/在途相位之前：败退优先。8521 在途不能改道（158），故仅 TO 空时派发；
    //   未真发出（包在飞）保持 pending 逐拍重试。落点走 #pickFleeTarget（D1 后 teams=0 全空井）。
    //   仅非 BOSS 点适用：BOSS 平台与玩家是 1 局定胜负，处置由 driveWarnStand 档定（onPvpInfo 点型闸已拦，此处 curPt 硬检查兑底）。
    if (
      this.#pvpFleePending &&
      !this.#toKind &&
      !isBossish(curPt) &&
      env.secret.isTeamLeader() &&
      this.#pvpRound &&
      tileKey(this.#pvpRound.x, this.#pvpRound.y) === curKey
    ) {
      const flee = this.#pickFleeTarget(curKey, cur) || this.#explorePoint(cur);
      if (flee) {
        this.#lastBranch = 'pvp-flee';
        this.#stage = 'evade';
        this.#dispatch('evade', flee);
        // 遭遇输 = 弃战：清 evade 可能为 BOSS 点记下的回攻意图，不再回攻
        this.#returnPending = false;
        this.#escapeFrom = null;
        if (this.#toKind) this.#pvpFleePending = false; // 真发出才销账；未发出保持 pending 下拍重试
        this.#heartbeat(now);
        return this.#sleepAfterDispatch();
      }
      // 无落点（全占用/无探索）：保持 pending，等下拍快照刷新
    }

    // ── ①′ 不抓宠即离（二轮收口）：petLevel=0 时若已停稳在 172 野宠点（任何原因走到：开局即在/
    //   手动撤到/旧配置残留），当拍派 evade 撤往非 172 安全点——不攻打（beast 档已短路）、不拍
    //   （capture 拒拍普通野宠窗）、切断踏点触发的游戏原生自动 PVE。硬刚 stand 不豁免本分支。
    //   在途（#toKind 非空）不改道（158），到站 moored 后下一拍即离；无落点记边沿、下拍重试。
    const petOff = !(Number(b.petLevel) > 0);
    if (petOff && moored && curPt === PAB_MONSTER && env.secret.isTeamLeader() && !this.#toKind) {
      const out = this.#pickFleeTarget(curKey, cur) || this.#explorePoint(cur);
      if (out) {
        this.#lastBranch = 'beast-off-leave';
        this.#stage = 'evade';
        this.#dispatch('evade', out);
        // 弃战口径同败退：清回攻意图，不再回攻野宠点
        this.#returnPending = false;
        this.#escapeFrom = null;
        this.#heartbeat(now);
        return this.#sleepAfterDispatch();
      }
      this.#note(
        'beast-off-noflee',
        'pilot: petLevel=0 but moored on beast tile ' +
          curKey +
          ', no free flee target yet, retry next tick. reason=beast_off_noflee',
      );
    }

    // ── ① 受击威胁处置（v4.1 边避边工 + 计划 D：上移到在途/驻留相位之前）════
    //   上移目的：行军/驻留途中被盯上（21534 num>0）也当拍即挪——旧实现把本块放在 TO/WORK 相位
    //   return 之后，导致「在途被打完全不逃」（实证：首警到首次 evade 晚 170s）。
    //   竞品语义：威胁拍并非全停——扎营避过一次后落回常规阶梯继续收益（avoid_attacked 同旨），
    //   但跳过 BOSS 档（`quiet` 位向下传导）；当前瓦片正处 PVP 交战（state 11/12）则原地全停。
    let quiet = false;
    // 攻击警告硬刚到底（面板 driveWarnStand，仅队长自动驾驶生效，1115 用户拍板全点位口径）：
    //   勾=任何点位（含资源井/捕获平台/BOSS 平台）原地应战不自动撤离、照常干活（quiet=false）；
    //   未勾（缺省）=验真后的攻击警告即撤往就近安全点（BOSS 平台不再豁免，1 局定胜负真攻击即撤）。
    //   误告（本点无敌方 UID）已在 onWarnPush 验真层忽略，不会走到这里。
    const stand = !!((env.cfg().drive || {}).warnStand === true);
    // 1115 问题7：WORK 相位已判 leave（拿空/exhausted/驻留满）→ 本拍 leave-ASAP 豁免全局路由锁
    let workLeft = false;
    // 四-5：本拍威胁块是否判「该扎营」（hold）并落回常规链——供 TO 到点首拍 evade 优先闸复用。
    let threatHold = false;
    if (this.#threat && env.secret.isTeamLeader()) {
      if (this.#captureBusy()) {
        // 拍宠中不打断：保持让路（等本次拍完），仅记一次「threat during capture」
        this.#note(
          'threat-capture',
          'pilot: threat while capturing enigma-beast/BOSS, do not interrupt capture. reason=threat_during_capture',
        );
      } else {
        // 战力差探针已废弃（检查方式未定案）：威胁档恒按保守照逃（hold 恒 true）。
        threatHold = true;
        this.#lastBranch = 'threat';
        // 硬刚到底（见上 stand）：全点位视同安全点原地应战；未勾 → 仅营帐/普通平台算安全，其余撤离（回攻档威胁解除后返台）。
        const safeHere = stand ? true : curPt === PAB_TENT || curPt === PAB_COMMON_PLANE;
        // 可再逃（D.2）+ 落点回退（D.3）：首逃一次；持续威胁可再挪（上限内）；#pickFleeTarget 返 null 时回退 #explorePoint 当跳板。
        if (!safeHere && this.#mayEvade(now)) {
          const tent = this.#pickFleeTarget(curKey, cur) || this.#explorePoint(cur);
          if (tent) {
            if (this.#toKind) {
              // 在途不改相位：行军中另发 8521 必吃 158「在途未到」，而 158 分支不回滚相位——
              //   旧「改道」写法会把 #toXY 指向从未成行的逃袭点：到站不进 work、超时还把逃袭点白拉黑 10min。
              //   让原路走完，到达后 dwell 拍威胁块仍每拍重评（受击块上移已解决「驻留被打不逃」）。
              this.#note(
                'threat-inflight',
                'pilot: threat while marching to ' +
                  this.#toKind +
                  ', keep current march (158 would reject reroute), re-evaluate on arrival. reason=threat_inflight',
              );
            } else {
              this.#stage = 'evade';
              this.#dispatch('evade', tent);
              // 记账以「真发出」为准：sendMarch 在 8521 包在飞时返回 false（#dispatch 直接 return），
              //   此时不烧再逃额度、不置扎营位，下一拍重评。
              if (this.#toKind) {
                if (this.#threatEvaded) this.#threatReEvade++;
                this.#threatEvaded = true;
                this.#threatEvadeAt = now;
              } else {
                this.#note(
                  'threat-evade-unsent',
                  'pilot: evade not sent (8521 packet in flight), retry next tick. reason=evade_unsent',
                );
              }
              this.#heartbeat(now);
              return this.#sleepAfterDispatch();
            }
          }
          this.#note(
            'threat-noflee',
            'pilot: threat but no flee/explore hop available, fall through to normal ladder. reason=no_flee_target',
          );
        }
        // 交战中挪队只会把部队撒在路上：原地驻守等本窗结束（竞品 L24906 state==12 同语义，两档都保留）
        const ct0 = this.#tiles.get(curKey);
        if (ct0 && (ct0.state === ST_PVP_READY || ct0.state === ST_PVP_FIGHTING)) {
          this.#stage = 'evade';
          this.#heartbeat(now);
          return tuning.driveScanMs;
        }
        // 边避边工：不 return，落回常规阶梯；transfer 档置 quiet 使 ②回攻 与 ⑤⑥⑦ BOSS 档让路，
        //   stand 档照常干活含 BOSS 档（quiet=false）。
        quiet = !stand;
        this.#stage = 'evade-work';
        this.#gateState(
          'threat',
          true,
          'evaded=' + (this.#threatEvaded ? 1 : 0) + ' safe=' + (safeHere ? 1 : 0),
        );
      }
    }

    // ── ①″ 终局执行：奖励弹窗 hold → 最后一趟商店（驻留买货照旧）→ 离店结算落 done ────────
    //   置于威胁块之后：hold 期间被打仍先逃（生存 > 弹窗）；hold 只冻路由/驻留推进，不冻生存闸。
    //   在途不改道（158）：触发时已在行军则 hold 冻住到达复核≤5s，窗满原路走完再进商店段。
    if (this.#endgame && this.#endgame.phase !== 'done') {
      const eg = this.#endgame;
      if (eg.phase === 'hold') {
        if (now < eg.until) {
          this.#lastBranch = 'endgame-hold';
          this.#heartbeat(now);
          return Math.min(eg.until - now, tuning.driveScanMs);
        }
        eg.phase = 'shop';
        this.#noteMatchOver();
        env.log.info(
          'pilot: endgame reward hold elapsed, dispatch final shop trip. reason=endgame_shop',
        );
      }
      if ((eg.phase === 'shop' || eg.phase === 'shop-work') && !this.#toKind && !this.#workMode) {
        const cand = this.#pickFinalShop(curKey, cur);
        if (cand) {
          this.#lastBranch = 'endgame-shop';
          this.#stage = 'shop';
          this.#dispatch('shop', cand);
          if (this.#toKind || this.#workMode) {
            eg.phase = 'shop-work'; // 同点派发直进 WORK 也算在途段
            this.#noteMatchOver();
          }
          this.#heartbeat(now);
          return this.#sleepAfterDispatch();
        }
        this.#note(
          'endgame-noshop',
          'pilot: endgame final shop trip has no usable shop anchor (table missing or all blacklisted), end autopilot now. reason=endgame_no_shop',
        );
        eg.phase = 'done';
        this.#noteMatchOver();
        // 落 done 当拍即收场：不再落常规阶梯补派一笔（下一拍起由 match-over 闸统一早退）
        this.#lastBranch = BR_MATCH_OVER;
        this.#heartbeat(now);
        return tuning.driveScanMs * 4;
      }
    }

    // ── 在途相位：只推进「到达复核 / 超时兜底」，绝不重评路由 ──────────────
    if (this.#toKind) {
      this.#lastBranch = 'to';
      this.#stage = 'to';
      if (Number(base.marchState) === arrived && curKey && curKey === this.#toXY) {
        // 四-5：威胁到点首拍 evade 优先——本拍威胁块已判 hold 且可再逃、非安全点、有逃袭落点时，
        //   不进 WORK（免 kickShop/BOSS 驻留设置抢在 evade 前），清 TO 返 0：下一拍①威胁块
        //   无在途标记即派 evade。条件与威胁块派发闸同口径（hold 复用本拍判定，落点两函数均纯读）；
        //   在途 threat-inflight 不改相位、安全点/可再逃额度耗尽时的边避边工收益均不变。
        const safeHere = stand ? true : curPt === PAB_TENT || curPt === PAB_COMMON_PLANE;
        if (
          threatHold &&
          !safeHere &&
          this.#mayEvade(now) &&
          (this.#pickFleeTarget(curKey, cur) || this.#explorePoint(cur))
        ) {
          env.log.debug(
            'pilot: arrived %s (%s) under threat, defer work for evade-first. reason=threat_arrive_evade_first',
            curKey,
            this.#toKind,
          );
          this.#clearTo();
          this.#heartbeat(now);
          return 0;
        }
        this.#enterWork(curKey);
        this.#heartbeat(now);
        return 0; // 到点当拍即重评：空井可立刻走
      }
      if (now - this.#toAt > tuning.driveMarchTimeoutMs) {
        this.#lastBranch = 'to-timeout';
        this.#marchTimeouts++;
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
      // B4 离站后发呆：empty（资源/掉落井）相位未判空时，先以本点为中心拉一刃新鲜视口（复用 #awaitView
      //   →  #ingestView，自带 driveViewMs 新鲜闸与 viewOff 降级）——否则只靠外部 push 刷新，一口真空的
      //   井因快照陈旧会白等到 driveWorkMaxMs=45s ceiling。拉到新鲜数据后 #isTileEmpty 当拍即可 settle 离点。
      if (this.#workMode === 'empty' && !this.#isTileEmpty(this.#toXY)) {
        const ep = String(this.#toXY || '').split(',');
        await this.#awaitView(Number(ep[0]), Number(ep[1]));
      }
      const w = this.#workTick(now);
      if (!w.leave) {
        this.#heartbeat(now);
        return w.sleep;
      }
      workLeft = true; // 已判 leave：下方 cooldown 闸本拍豁免（1115 问题7，离死井不被离店锁拦）
      const wk = this.#toXY;
      // 终局：最后一趟商店驻留结算（leave）＝本场自动驾驶收场；再勾启用也不复活（闩见 index.js matchOver）。
      //   只认商店点离站：终局途中被威胁逃袭的离站不算收场，下一拍回 shop 段重派商店。
      if (this.#endgame && this.#endgame.phase === 'shop-work' && curPt === PAB_SHOP) {
        this.#endgame.phase = 'done';
        this.#noteMatchOver();
        env.log.info(
          'pilot: final shop trip settled at %s, autopilot ended for this match (re-enable will not resume). reason=endgame_done',
          wk,
        );
      }
      // 到点即锁：离店后 `driveShopStayMs` 内整条路由链不重评——
      //   治「25s 驻留满 → 下一拍又被电平理由开回商店」。#consume 的 10min 只黑那一个点，
      //   本闸黑的是**全部**候选（含另三家店）。
      if (curPt === PAB_SHOP) {
        const stay = Math.max(0, Number(tuning.driveShopStayMs) || 0);
        if (stay) this.#cooldownUntil = now + stay;
      }
      this.#toXY = '';
      this.#workMode = '';
      this.#workDeadline = 0;
      this.#workUntil = 0;
      this.#shopGiveUp = false;
      // BOSS 相关点（176/177/178）驻留满**不记消费**：攻打未完时走人等于把平台弃在战斗中，
      //   且它们不靠消费账防重派（下一拍由 #bossWindow 决定去留，窗口散了自然落下去巡航）。
      let bossPoint = false;
      if (wk) {
        const wt = this.#tiles.get(wk);
        bossPoint = !!wt && isBossish(wt.pt);
      }
      if (!bossPoint) this.#consume(wk);
      // 终局收场：离店结算落 done 的当拍即早退，不落常规阶梯再派一笔车（「至此自动驾驶结束」）。
      if (this.#endgame && this.#endgame.phase === 'done') {
        this.#lastBranch = BR_MATCH_OVER;
        this.#heartbeat(now);
        return tuning.driveScanMs * 4;
      }
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
      // B5 冷启动死区：未泊靠时每拍在上方早退，走不到 #autoLeader 的 #awaitView——若此时 #tiles 为空
      //   （开局尚无任何 push），就会「无候选→hold→直到手动发车喂进 push」长期趴窝。护栏：仅 #tiles 空且未
      //   viewOff 时以自身为中心主动补一刃 901（#awaitView 自带新鲜闸与 driveViewOffAfter 降级），填充 #tiles。
      if (this.#tiles.size === 0 && !this.#viewOff) await this.#awaitView(cur.x, cur.y);
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
        // 探测包目标走窄筛唯一选点路（快照不可用时只剩探索落点）——只为清幽灵在途标记，不挑丰景
        const probe =
          this.#objective('resource', undefined, { snap: { cur: cur, curKey: curKey } }) ||
          this.#explorePoint(cur);
        this.#dispatch('cruise', probe, true);
        this.#heartbeat(now);
        return this.#sleepAfterDispatch();
      }
      this.#heartbeat(now);
      return 200;
    }
    this.#inflightStuckSince = 0;

    // ── 全局路由锁（离店/拒码退避）：只挡「新派发」，不挡到达确认/驻留干活 ──────────
    //   从 #tick 头部下移到此（问题2/7/21①）：旧位置连在途相位的到达确认都挡——离店后 15s 锁
    //   会把下一站的 #enterWork 拖到 15s 后，pickup 在途写的 exhausted 标记又被迟到的到点抹掉，空井白等天花板。
    //   现在在途/驻留相位照常推进，本闸只挡②回攻与驾驶阶梯；读拍首快照 coolUntil0，
    //   本拍「离店」抬的锁不挡本拍发车。威胁拍不压：①威胁块已先于本闸跑过（evade 派发不受影响），
    //   quiet 落回常规链时保留原豁免语义。
    //   workLeft 豁免（1115 问题7）：WORK 已判 leave-ASAP（空井/exhausted）时不拦——离店锁只禁「重路由回店」，
    //   不禁离死井；否则 driveShopStayMs 15s 全局锁会把下一口井的发车拖十几秒。
    if (
      now < coolUntil0 &&
      !workLeft &&
      !(this.#threat && env.secret.isTeamLeader() && this.#mayEvade(now))
    ) {
      this.#lastBranch = 'cooldown';
      this.#gateState('cooldown', true, 'left=' + (coolUntil0 - now) + 'ms');
      this.#heartbeat(now);
      return Math.min(coolUntil0 - now, tuning.driveScanMs);
    }
    this.#gateState('cooldown', false, '');

    // ① 受击威胁处置已上移到在途/驻留相位之前（计划 D），`quiet` 位由那里声明并向下传导。
    // ── ② 回攻（威胁解除且逃离点是 BOSS 相关点）——quiet 拍不让路 ─────────────
    if (this.#returnPending && !quiet) {
      this.#lastBranch = 'return';
      this.#stage = 'return';
      const win = this.#bossWindow(now, cur);
      // 回攻目标也过黑名单闸（问题13 附带）：逃离的 BOSS 本体可能已被 159 当日黑/159995 短黑，
      //   不查会每 rejectBackoffMs 重撞同点。命中即清回攻意图，落回常规重评。
      const rk = win && win.mode === 'open' ? tileKey(win.boss.x, win.boss.y) : '';
      // BOSS 已死（state28/30/墓碑）→ 同样清回攻意图：止住 5s 一发的 return spam，不跑回死平台发呆（1115 问题4③）
      const dead = !!rk && this.#bossDeadAt(rk);
      if (!win || win.mode !== 'open' || this.#dayBlack.has(rk) || this.#paramBlocked(rk) || dead) {
        if (win && win.mode === 'open') {
          this.#note(
            (dead ? 'return-dead|' : 'return-black|') + rk,
            'pilot: counter-attack target ' +
              rk +
              (dead ? ' is dead' : ' is blacklisted') +
              ', drop return intent. reason=' +
              (dead ? 'return_dead' : 'return_black'),
          );
        }
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
    let win = this.#bossWindow(now, cur);
    // 901 视口改由 #autoLeader await 串行拉取（决策吃本应答快照，修旧「同拍派发吃陈旧池」）

    // ── ④ 已停 BOSS 相关点：窗口还开着才 HOLD（攻打/投喂/石头归 boss.js）──
    //   ⚠ HOLD 必须有出口：窗口一散就落下去巡航，否则 BOSS 窗散了车还钉在平台上「整场不动」。
    if (isBossish(curPt)) {
      // HOLD 必须有出口，且出口要区得清「本平台真能打」：win 是全图最近 open，跨区域时不能照 hold（否则
      //   小BOSS 清完、只剩别区的 open BOSS 时，车会钉在已清空平台上整场不动，直到那个 BOSS 自己散场）。
      if (win && this.#bossEngageableHere(curKey, win)) {
        // hold 期间主动刷新（问题14/15）：21535 阶段切换不推、BOSS 死亡可滞后 bossBaseInfo 数分钟，
        //   不复拉则陈旧 state21 一直让窗「开着」，车在平台死等（实测 364s）。8522 按 driveBossStateGapMs 限速，
        //   901 走 #awaitView 新鲜闸以 BOSS 为中心（墓碑 pt=0 / state=30 / 点列缺席都会触发瓦片否决）；拉完当拍重评，窗散即落阶梯。
        this.#refreshBossState(win.boss.x, win.boss.y);
        await this.#awaitView(win.boss.x, win.boss.y);
        this.#bossAbsentVeto(win.boss.x, win.boss.y);
        win = this.#bossWindow(Date.now(), cur);
      }
      if (win && this.#bossEngageableHere(curKey, win)) {
        this.#lastBranch = 'hold';
        this.#stage = 'hold';
        this.#gateState('hold', true, 'pt=' + curPt + ' mode=' + win.mode);
        this.#heartbeat(now);
        return tuning.driveScanMs;
      }
      // 本平台打不到窗口里的 BOSS（win=null 无 open 窗 / 跨区域：已清小BOSS、只剩别区 open）→ 绝不 HOLD，落到驾驶阶梯：
      //   boss 档的 plane 目标会挪到对应区域平台（同区域、距 BOSS 最近），无解则落巡航/收场。
      this.#env.log.debug(
        win
          ? 'pilot: on plane ' +
              curKey +
              ' (' +
              curPt +
              ') but open BOSS ' +
              win.boss.x +
              ',' +
              win.boss.y +
              ' is other-area → leave, do not hold.'
          : 'pilot: on plane ' + curKey + ' (' + curPt + ') with no open BOSS window → leave.',
      );
      this.#gateState('hold', false, win ? 'not-here' : 'no-window');
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
   * 选逃袭落点（需求 1/5：立即转移=向**任意可行军的就近点**发 8521 脱离）。
   *   旧版只认 174 平台 / 175 营帐，而录制实证 174 在视口快照里几乎不出现、车又多停在 173 资源点/172 野怪点
   *   上被打 → 快照里没有 174/175 就「不逃」，是「被拉线攻击却没逃走」的直接根因。现把落点扩到
   *   {175 营帐, 174 平台, 173 资源点, 172 野怪点}：受击档（evade）不发打野/攻打包，只是**走过去挪开**
   *   即脱离拉线（需求 4：攻击宠物只当跳板、不攻击）。
   *   安全过滤沿用：排除当前点 / 当日拉黑 / 正被 PVP(state 11/12) / 已交战 / 驻军>1（至少留一个位）。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @returns {{x:number,y:number}|null}
   */
  #pickFleeTarget(curKey, cur) {
    const self = this;
    return pickHopTile(Array.from(this.#tiles.values()), {
      cur: cur,
      curKey: curKey,
      requireFreeSlot: true,
      // 面板「不抓宠」（petLevel=0）时 172 不能当落脚位（踏上去即自动 PVE，问题4/5/8/10/12）
      noMonster: !(Number((this.#env.cfg().drive || {}).petLevel) > 0),
      isBlack: function (k) {
        return self.#dayBlack.has(k);
      },
    });
  }

  /**
   * 向目标跳板（需求 3/4：附近无满足单跳车程的「最合理井」时，走最近的资源点/停泊平台/攻击宠物作跳板逼近）。
   *   与 #pickFleeTarget 同一候选点集，但带一个 `goal` 方向：在单跳可达窗（hopMaxD）内挑**最能缩短到 goal 距离**的
   *   落脚点（同逼近度取更近的）；窗内无任何落脚点回 null（交回探索档换视野，不发不可取消的长途）。
   *   攻击宠物(172) 在此仅作位移跳板——本函数不发打野/攻打包。
   * @param {string} curKey 当前点键
   * @param {{x:number,y:number}} cur 当前坐标
   * @param {{x:number,y:number}} goal 要逼近的目标（打分最优井坐标）
   * @param {number} hopMaxD 单跳最大距离（格）
   * @returns {{x:number,y:number,pt:number}|null}
   */
  #hopTowardGoal(curKey, cur, goal, hopMaxD) {
    if (!goal) return null;
    const self = this;
    return pickHopTile(Array.from(this.#tiles.values()), {
      cur: cur,
      curKey: curKey,
      goal: goal,
      hopMaxD: hopMaxD,
      // 面板「不抓宠」（petLevel=0）时 172 不能当跳板（踏上去即自动 PVE，问题4/5/8/10/12）
      noMonster: !(Number((this.#env.cfg().drive || {}).petLevel) > 0),
      isBlack: function (k) {
        return self.#dayBlack.has(k);
      },
    });
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

  /**
   * 场级状态单一复位点：换场（`#tick` fightBeginTime 变化）/`start()`/`stop()` 三处共用，
   *   新增场级账本/相位只改这一处（历史三处手工清单各自漂移，已有跨场预算爆账前科，shop.js #syncMatch 同旨）。
   *   范围 = 一切「按场计」的状态：锚点/账本族/冷却/威胁伴生位/901 视口/TO 与 WORK 相位/一次性提示。
   *   **不含**生命周期与诊断位（#active/#cycle/#planIdUsed/#contractErrs/#ticks/#gateNow/心跳采样位），
   *   那些归 start/stop 各自收口；#roundTierCache 是静态配置 memo，跨场无害不清。
   * @param {number} [fb] 新场 fightBeginTime（毫秒）；换场传入，start/stop 缺省 → 时间锚归零
   */
  #resetMatch(fb) {
    // 时间锚：换场钉到 fightBeginTime；start/stop 归零（首拍兜底见 #tick 的 matchStartAt 补位）
    this.#matchFightBegin = fb || 0;
    this.#matchStartAt = fb || 0;
    // S0 数据层：锚点与视口全部作废，新场重新拉表/拉 901（旧场瓦片状态不得喂新场选点）
    this.#tiles = new Map();
    this.#shops = [];
    this.#shopsAt = 0;
    this.#group = 0;
    this.#viewAt = 0;
    this.#viewKick = false;
    this.#viewBusy = false;
    this.#viewMiss = 0;
    this.#viewOff = false;
    this.#viewDbg = null;
    this.#viewMarch = new Set();
    this.#viewMarchAt = 0;
    this.#viewPoints = [];
    this.#viewPointsAt = 0;
    this.#viewMarchList = [];
    // S2 账本族与冷却（七账本统一 TtlLedger 原语，TTL 语义见 ledger.js 文件头）
    this.#marched = new TtlLedger();
    this.#consumed = new TtlLedger();
    this.#exhausted = new TtlLedger();
    this.#cd = {};
    this.#dayBlack = new TtlLedger();
    this.#paramBlack = new TtlLedger();
    this.#bossDone = new TtlLedger();
    this.#change = new TtlLedger();
    this.#cooldownUntil = 0;
    this.#realmClosed = false;
    // 终局相位按场复位；模块级闩不清（换场 fb 不同自然失效，同场引擎重建靠它恢复）
    this.#endgame = null;
    this.#bigBossKey = '';
    // 商店相位与每店账本（按场计，见 #shopLedger 字段注）
    this.#shopLedger = new Map();
    this.#shopLastAt = 0;
    this.#shopCoolUntil = 0;
    this.#lastShopWhy = '';
    this.#shopErrandDone = false;
    this.#idleSince = 0;
    this.#exploreSpin = 0;
    this.#inflightStuckSince = 0;
    // 威胁伴生位显式配对复位：防旧威胁窗的扎营位残留使新场首次威胁不再避让
    this.#threat = false;
    this.#threatEvaded = false;
    this.#threatEvadeAt = 0;
    this.#threatReEvade = 0;
    this.#evadeCoolUntil = 0;
    this.#bossStatePullAt = 0;
    this.#escapeFrom = null;
    this.#returnPending = false;
    // 遭遇战回合账（1115 问题9）：换场复位；手动接管暂停位刻意不在此复位（仅 drive 重开复位，见 #tick）
    this.#pvpRound = null;
    this.#pvpLossStreak = 0;
    this.#pvpFled = false;
    this.#pvpFleePending = false;
    this.#lastReviveAt = 0;
    this.#reviveInFlight = false;
    // TO/WORK 相位：旧场在途/驻留对新场无意义，一并清（#workPt 由 #enterWork 重新锁存）
    this.#clearTo();
    this.#marchTimeouts = 0;
    this.#workMode = '';
    this.#workUntil = 0;
    this.#workDeadline = 0;
    this.#shopGiveUp = false;
    this.#told = {};
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
    // 消费账是「离店后同点 10min 不再重选 / 为什么不去那家店」的唯一判据落点，必须留痕：
    //   没有这条，日志里只能看到「去/不去」，看不到防重派窗口从何时起算。
    this.#env.log.debug(
      'pilot: point %s consumed, no re-pick for %ds.',
      key,
      Math.round((Number(tuning.driveConsumedTtlMs) || 0) / 1000),
    );
    // ⚠ 惰性清扫收口 TtlLedger.sweep：-1 永久哨兵不碰（旧 forEach 手写同口径）；
    //   旧 function 回调 this=undefined 的潜伏崩溃随原语内箭头实现一并消除。
    this.#consumed.sweep(now);
    this.#marched.sweep(now);
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
   *   使「方向盘这一拍为什么没动」事后可在日志流按 'pilot: tick' 过滤单轨还原。
   *   调用点：`#tick` 内**每个 return 前**（早退分支不会比主链少信息）。
   *   节律：每 6 拍一条（driveScanMs=5000 → 约 30s）或分支跳变当拍一条；同一拍只落一次。
   *   长度纪律：主行与 census 副行均 ≤ 200 字符（日志流非 JSON 输出按 200 截断）。
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
      'pilot: tick#%d branch=%s stage=%s why=%s cd[march=%d,beast=%d] phase=%s tl=%d idle=%d plan=%s mto=%d',
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
      this.#marchTimeouts,
    );
    // 梯尾空派发拍（= 全链无候选）补一行筛除普查：字段名直接从 #pickDbg 的键取，
    //   窄筛统一形状 {src,seen,best,hopMaxDist?,hop?}，泛型遍历兼容后续加键。
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
   * 启动：订阅 21534/10018/21529/21521/21535/21522/21532/21523（退订由 reactor 托管）+ 本端 8521 发包识别 + 建循环并点火。
   * @param {object} ctx reactor 上下文
   */
  start(ctx) {
    const env = this.#env;
    const self = this;
    this.#active = true;
    // 场级状态单一复位点（换场/start/stop 共用）；诊断位另归本方法收口
    this.#resetMatch();
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
        if (self.#active && env.realmActive()) self.#kick();
      });
      ctx.on.push(PUSH_RESOURCE_CHANGE, function (ev) {
        const body = changeBody(ev);
        if (body && self.#active && env.realmActive()) self.onResChange(body);
      });
      ctx.on.push(PUSH_DROP_CHANGE, function (ev) {
        const body = changeBody(ev);
        if (body && self.#active && env.realmActive()) self.onDropChange(body);
      });
      ctx.on.push(PUSH_POINT_FIGHTING_INFO, function (ev) {
        if (self.#active && env.realmActive()) self.onPvpInfo(ev);
      });
    } else {
      // error 级：无 21534/10018 推送 ⇒ 受击逃帐与瓦片现场永远拿不到，方向盘整场空转（core/log.js 第 1) 条）。
      env.log.error('pilot: ctx.on.push unavailable, cannot subscribe 21534/10018 (engine idle).');
    }
    // 手动接管检测（1115 问题5/10）：订阅本端 8521 发包（包真上线才派发），与 env intent 队列匹配
    //   区分扩展自身发送与用户手动行军；feat-ctx 无 on.req 时静默降级（不检测不暂停）。
    if (ctx && ctx.on && typeof ctx.on.req === 'function') {
      ctx.on.req(CMD_MARCH_MOVE, function (ev) {
        if (self.#active && env.realmActive()) self.onOwnMarch(ev);
      });
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
    this.#kick();
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
        endgame: this.#endgame ? this.#endgame.phase : '',
        bigBossKey: this.#bigBossKey,
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
        // 四-4：本场行军超时兜底计数（观察次通道抖动是否集中引发 no-resp）
        marchTimeouts: this.#marchTimeouts,
        marchIn: this.#viewMarch.size,
        marchInAgeMs: this.#viewMarchAt ? now - this.#viewMarchAt : null,
        bossFeeding: this.#bossFeeding(),
        beastStage: this.#beastStageWant(now),
        reviveInFlight: this.#reviveInFlight,
        lastReviveAgoMs: this.#lastReviveAt ? now - this.#lastReviveAt : null,
        // 遭遇败退（1115 问题9；手动接管二轮收口改 driveAutoOff 自动取消勾选，无暂停位）
        pvpRound: this.#pvpRound,
        pvpLossStreak: this.#pvpLossStreak,
        pvpFled: this.#pvpFled,
        pvpFleePending: this.#pvpFleePending,
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
        // 四-1 降频观测面：本拍是否空闲态（可降频）与 kick 旁路位是否待消费
        idle: viewIdleNow({
          workMode: this.#workMode,
          bossFeeding: this.#bossFeeding(),
          teamType: Number(tuning.driveTeamType) || 0,
          idleSince: this.#idleSince,
        }),
        kickPending: this.#viewKick,
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
      dayBlack: this.#dayBlack.keys(),
      // 到场打过的 BOSS 跳过账
      bossDone: this.#bossDone.keys(),
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
    // 场级状态单一复位点（换场/start/stop 共用）
    this.#resetMatch();
  }
}
