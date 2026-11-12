/**
 * CQ26 印石·荒芜冰原「冰原巨熊」（世界挑战巨兽）自动攻打（cq26WlBeast）
 *
 * 玩法：冰原的「挑战巨兽」分区（wastelandType=1 BOSS_SKILL）开战后，玩家进入 `CQ26WLWorldChallengeBossPop`
 * → 「攻打」→ 组兵面板出征 → `RealNBattleModel` 拦截 marchType 327 **不另发 902 行军包**，改发一条
 * **2125 即时结算的 PVE**（伤害计入个人/全区进度，奖励按个人累计伤害档发放）。本 feat 与玩家点「攻打」
 * 严格同形：校准好的队伍投影成 2125 的 troop 直发，**不动镜头、不需要坐标、不消耗体力**。
 * ⚠️ 虽无独立 902，但 2125 **照样占一个行军队列名额（myMarchNum）且只能动用当前空闲（未外派）的
 *   英雄/军阵/机甲/单位**——源码 onClickAttackBtn 发前先过 `CheckMarchNumEnough()`，队列满即弹
 *   「队列条件不满足」（实录 dashcam-rec-20261112T011559：idx 7 成功、4s 后 idx 10 被 code 3 拒），
 *   故本 feat 也照抄队列名额闸 + 用「排除在途」的普通派兵口径组兵，多只熊**串行、一只打完再打下只**。
 *
 * 三条硬约束（用户复盘定档）：
 *   ① **不切图也能打**：发现腿走 `2111 SERIES_FROST_NWL_INFO`（活动面板/内存即可回的全分区快照，与
 *      「人是否在冰原视口」无关），不再被动嗅探 901/10018 的 317 地块（那要求切到巨熊地图才采得到）；
 *   ② **同一只每天打一次 + 多只串行（一只打完再打下只）**：一只巨熊 = 一个 `wastelandIndex`（分区号），
 *      无论打几次只算个人最高伤害（`selfFightValue` 跨日累计、单场有效攻打约 2 次后归零），故每个分区
 *      **当日只发一次 2125**；又因 2125 占队列名额+吃空闲部队，**无论有几只熊都按同一预设逐只串行**
 *      （每拍至多发一只，待其名额/部队释放再打下只）；已删除「同点攻击间隔」这类无意义设定；
 *   ③ **不消耗体力**：攻打冰原巨熊不吃行动体力（服务器口径为准），已删除体力闸与 MONSTER_GROUP 查表。
 *
 * 协议清单（载荷形态逐键抄自实录报文，实证 dashcam-rec-20261112T003043-…-1794414643763.part.ndjson：
 *   真人对 wastelandIndex 7 三条 2125 → `{isOk:1}/{isOk:0}/{isOk:1}`，其间 2124 selfFightValue 510T→633T）：
 *   2111 SERIES_FROST_NWL_INFO  req `{}`  resp `{curStage,…,wastelandList:[{wastelandIndex,status,wastelandType,wastelandCondition,endTime},…]}`
 *       可打判据（源码 `CQ26WastelandOverviewPop` 口径）：`wastelandType===BOSS_SKILL(1) && status===OPENING(4) && endTime>now`
 *   2125 SERIES_FROST_NWL_BEAST_SKILL_ACTIVATE  req `{wastelandIndex, troop}` resp `{isOk}`
 *       troop（实录逐键）`{heroList:[{heroId},…], armyPosList:[{pos,armyId,armyNum},…],
 *         formationV2:1001, extraArmyPos:{pos:0,armyId,armyNum}}`（extraArmyPos 仅在有额外部队时出现）
 *   2124 SERIES_FROST_NWL_BEAST_SKILL_ACTIVATE_INFO  req `{wastelandIndex}` resp `{fightValue,timeIndex,selfFightValue}`
 *       （只作面板展示：攻打成功后刷一次读数，不作任何判据）
 *   2126 SERIES_FROST_NWL_BEAST_SKILL_CHANGE_TIME_INDEX（切攻击时段，玩家决策，**登记不接线**）
 *
 * wastelandIndex 唯一真相源：2111 `wastelandList[].wastelandIndex` = 分区 `showNum` = 317 地块 `m.specIndex`
 *   （源码 `CQ26WastelandOverviewPop` 逐字把 `region.showNum` 当 wastelandIndex 发 2112/2113；实录一致）。
 *
 * 闸门（按序短路，见 cyclePass/candidateBeasts/pickBeasts，每口一条 debug/info/warn）：
 *   1 活动闸 cq26IsOpen → 2 时刻闸 serverTime 不可得则过期闸无从求值（本拍跳过）→ 3 回读完成闸（当日已打表
 *      读盘成功前不出写请求，避免页面重载后重复撞同一只）→ 4 日界滚清 → 5 发现（2111 快照，scanMs 缓存）
 *   → 6 逐点闸（当日已打 → 冷却 → 连续被拒当日拉黑）→ 7 队列闸（`march.canMarch(1)`：无空闲行军队列名额
 *      就本拍跳过，对齐源码 `CheckMarchNumEnough`，免白撞「队列条件不满足」code 3；名额随在途行军回城自
 *      愈）→ 8 组兵闸（`new Battle().plan().preset(n).adjust().build()` **普通派兵口径**——容量校准 + **排除
 *      已外派**的英雄/军阵/机甲/单位，只用当前空闲兵力；派空（含该预设都在途）/重算降级 ⇒ 不发，天然串行
 *      「一只打完再打下只」）→ 9 每拍至多发一只（串行，多只靠 chainMs 快速续）。
 *   失败处理：CODE_NOT_SENT → warn + 短冷却；服务器拒绝（code≠0，如队列刚被抢占/未到窗口）→ info + 冷却，
 *   连续 MAX_REJECT 次当日拉黑（防逐拍重发刷屏）；应答成形但 `isOk=0`（本场已无增量）→ 记为当日已打、不再撞。
 *
 * 刻意不做：
 *   · 不发 2126 切时段（攻击时段属玩家决策）、不碰 2103 融冰揭示（另一条腿，攻打不依赖）；
 *   · 不再嗅探 901/10018 的 317 地块（发现腿已改 2111，跨图可用；POINT_TYPE_BEAST 仅作对拍真值保留）。
 */
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { gameData } from '../../core/game-api.js';
import { storage } from '../../core/storage.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { createCycle } from '../../core/cycle.js';
import { fmtLargeNum } from '../../core/map.js';
import { CODE_NOT_SENT, parseData, rejectText, todayStr } from '../../core/util.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-BEAST');

/** @type {string} reactor 功能 id（面板挂载见 core/menu.js 的 cq26 类别） */
const FEAT_ID = 'cq26WlBeast';

// ── 常量 ──────────────────────────────────────────────────────────────
/** @type {number} 2125 SERIES_FROST_NWL_BEAST_SKILL_ACTIVATE：唯一写动作（攻打，即时结算） */
const CMD_ATTACK = 2125;
/** @type {number} 2124 SERIES_FROST_NWL_BEAST_SKILL_ACTIVATE_INFO：单点伤害读数（只作展示刷新） */
const CMD_INFO = 2124;
/** @type {number} 2111 SERIES_FROST_NWL_INFO：全分区快照（发现腿真相源，不依赖地图视口） */
const CMD_WORLD_INFO = 2111;
/** @type {number} NWorldMapEntityType.CQ_26_WL_CHALLENGE_BOSS = 317（对拍真值；发现腿已改走 2111） */
const POINT_TYPE_BEAST = 317;
/** @type {number} CQ26WLLandType.BOSS_SKILL = 1（挑战巨兽分区类型，源码 CQ26Common 稳定契约值） */
const LAND_TYPE_BOSS_SKILL = 1;
/** @type {number} CQ26WLLandStatus.OPENING = 4（分区开战态；LOCKED1/CAN_OPEN2/WAIT_START3/OPENING4/OPENED5/CAN_REOPEN6） */
const LAND_STATUS_OPENING = 4;
/** @type {number} 同一分区连续被拒达此次数即**当日**拉黑（防逐拍重发刷屏；日界滚清见 rolloverState） */
const MAX_REJECT = 3;
/** @type {number} 服务器拒绝后的冷却毫秒（未到窗口/时序竞争类拒绝留自愈窗口，不直接拉黑） */
const REJECT_COOL_MS = 5 * 60 * 1000;
/** @type {number} CODE_NOT_SENT（没发出去）后的短冷却毫秒 */
const NOT_SENT_COOL_MS = 30 * 1000;
/** @type {string} 当日已打表（storage.data blob 内逻辑名，跨日清空） */
const DATA_NAME_DONE = 'cq26WlBeast.done';

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入，= toModuleCfg 产出） */
var MCFG = normalizeCfg(null);
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {Array<{idx:number,endTime:number}>} 2111 快照过滤出的可打分区（scanMs 缓存） */
var cachedCands = [];
/** @type {number} 上次 2111 发现请求时刻（Date.now()，缓存闸） */
var lastScanAt = 0;
/** @type {Object<number,number>} wastelandIndex → 冷却到期时刻（Date.now()） */
var coolUntil = Object.create(null);
/** @type {Object<number,number>} wastelandIndex → 连续被拒次数 */
var rejectCount = Object.create(null);
/** @type {Object<number,{fightValue:number,selfFightValue:number,atMs:number}>} 2124 展示缓存（攻后刷新） */
var infoByIndex = Object.create(null);
/** @type {string} 当日账本所属服务器日（换日滚清） */
var day = '';
/** @type {Set<number>} 当日已打（成功或 isOk=0）的 wastelandIndex（"同一只每天打一次"的账） */
var doneSet = new Set();
/** @type {number[]} doneSet 的落盘镜像（顺序数组，写盘用） */
var doneIdxs = [];
/** @type {boolean} 当日已打表回读已完成（不论成败；完成前不出写请求） */
var loaded = false;
/** @type {boolean} 回读是否成功（false=写盘会整体覆盖，宁可跳过持久化） */
var loadOk = false;
/** @type {Promise<void>|null} 回读 promise（markDone 前 wait） */
var loadPromise = null;
/** @type {boolean} 本拍是否打出一条成功（择时切连攻档） */
var justAttacked = false;
/** @type {boolean} 在途串行闸（同刻至多一条 2125 在飞） */
var attackInFlight = false;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（发现/攻打全走主动请求，安装期不发请求）。
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
 * 配置灌入（reactor → 本模块）。翻开关即抢跑一拍。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (partial) MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：回读当日已打表（跨页面重载守住"每天一次"），然后点火。无 push/resp 订阅（发现腿主动请求）。
 */
function run() {
  // 刻意**不**在此清 coolUntil/rejectCount：places/kinds 门控会反复 pause→run，清零等于给一个持续被拒的
  //   分区无限续命；「当日已打」账本由 doneSet（回读 + rollover）管，与门控翻转解耦。
  //   发现腿走主动 2111（不订阅 push/resp），故本 feat 无 ctx.on.* 登记。
  startLoad();
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉发现缓存与展示缓存，避免 resume 后拿陈旧分区表出写请求。
 *   「当日已打」账本刻意保留（同场重挂不该对刚打过的分区立刻再撞）。cycle 自重排由 alive() 自守。
 */
function pause() {
  cachedCands = [];
  lastScanAt = 0;
  infoByIndex = Object.create(null);
  attackInFlight = false;
}

/**
 * 存活判定（cycle 与所有 await 之后的记账都过这一闸）。
 * @returns {boolean}
 */
function aliveFn() {
  return reactor.isRunning(FEAT_ID);
}

// ── 当日已打表持久化（同 train.js 的每日表口径：回读成功才写，避免覆盖丢账）──
/**
 * 启动当日回读：date 命中今日才把已打分区灌进 doneSet。
 */
function startLoad() {
  loaded = false;
  loadOk = false;
  loadPromise = (async function () {
    var saved;
    try {
      saved = await storage.data.get(DATA_NAME_DONE);
    } catch (e) {
      log.warn('load cq26WlBeast.done failed: %s', (e && e.message) || e);
      loaded = true;
      return;
    }
    if (saved && typeof saved === 'object' && saved.date === day && Array.isArray(saved.idxs)) {
      for (var i = 0; i < saved.idxs.length; i++) {
        var n = Number(saved.idxs[i]);
        if (n > 0) doneSet.add(n);
      }
      doneIdxs = Array.from(doneSet);
      log.debug('beast done-table loaded. idxs=%s day=%s', doneIdxs.join(','), day);
    }
    loaded = true;
    loadOk = true;
  })();
}

/**
 * 等回读完成（完成前禁写盘：整体覆盖会抹掉当日已打账）。
 * @returns {Promise<boolean>} true = 可安全写盘
 */
async function waitLoad() {
  if (loadPromise) {
    try {
      await loadPromise;
    } catch (e) {
      /* 回读异常已在 startLoad 内降级，这里只保证不阻塞 */
    }
  }
  return loadOk;
}

/**
 * 记某分区当日已打并进账本、落盘。
 * @param {number} idx wastelandIndex
 */
function markDone(idx) {
  if (!(idx > 0) || doneSet.has(idx)) return;
  doneSet.add(idx);
  doneIdxs.push(idx);
  persistDone();
}

/**
 * 落盘当日已打表（fire-and-forget：读盘失败则跳过整体覆盖写）。
 */
function persistDone() {
  waitLoad().then(function (ok) {
    if (!ok) {
      log.warn('persist done skipped: daily table unreadable (avoid overwrite).');
      return;
    }
    return storage.data.set(DATA_NAME_DONE, { date: day, idxs: doneIdxs.slice(-64) });
  });
}

// ── 候选序（纯函数层，单测逐条对拍）────────────────────────────────────
/**
 * 纯函数：2111 `wastelandList` → 可打的挑战巨兽分区（BOSS_SKILL 且 OPENING 且未过期）。
 * 判据逐字对齐源码 `CQ26WastelandOverviewPop`（region.wastelandType===BOSS_SKILL / status===OPENING），
 *   过期以 `endTime>nowSec`（缺 endTime=0 视作无截止，交给 status 兜底；被拒路径由 attack 侧冷却/拉黑收）。
 * @param {Array<object>} rows 2125 应答里的 `wastelandList`（行 `{wastelandIndex,wastelandType,status,endTime}`）
 * @param {number} nowSec 服务器秒（<=0 = 不做过期判定）
 * @returns {Array<{idx:number,endTime:number}>} 去重后的候选（不排序，交由 pickBeasts 统一升序）
 */
export function candidateBeasts(rows, nowSec) {
  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (!r) continue;
    var idx = Number(r.wastelandIndex != null ? r.wastelandIndex : r.idx) || 0;
    var type = Number(r.wastelandType != null ? r.wastelandType : r.type) || 0;
    var st = Number(r.status) || 0;
    var end = Number(r.endTime) || 0;
    if (idx <= 0) continue;
    if (type !== LAND_TYPE_BOSS_SKILL || st !== LAND_STATUS_OPENING) continue;
    if (end > 0 && nowSec > 0 && end <= nowSec) continue;
    if (seen[idx]) continue;
    seen[idx] = true;
    out.push({ idx: idx, endTime: end });
  }
  return out;
}

/**
 * 纯函数：候选分区 → 本轮可打队列（不读模块态，闸门全部显式传参）。
 * 逐点闸序：当日已打 → 冷却 → 连续被拒当日拉黑。
 * @param {Array<{idx:number,endTime:number}>} cands candidateBeasts 产出
 * @param {object} g 闸门入参
 * @param {number} [g.now] Date.now() 基准
 * @param {function(number):boolean} [g.isDone] 当日已打判定
 * @param {Object<number,number>} [g.coolUntil] idx → 冷却到期毫秒
 * @param {Object<number,number>} [g.rejectCount] idx → 连续被拒次数
 * @param {number} [g.maxReject] 达此次数当日拉黑
 * @returns {{ready:Array<{idx:number,endTime:number}>, blocked:Array<{idx:number,reason:string}>}}
 */
export function pickBeasts(cands, g) {
  var o = g || {};
  var now = o.now == null ? Date.now() : o.now;
  var cool = o.coolUntil || {};
  var rej = o.rejectCount || {};
  var maxRej = o.maxReject == null ? MAX_REJECT : o.maxReject;
  var isDone = o.isDone;
  var ready = [];
  var blocked = [];
  for (var i = 0; i < (cands || []).length; i++) {
    var c = cands[i];
    if (!c || !(c.idx > 0)) continue;
    if (isDone && isDone(c.idx)) {
      blocked.push({ idx: c.idx, reason: 'done-today' });
      continue;
    }
    if ((cool[c.idx] || 0) > now) {
      blocked.push({ idx: c.idx, reason: 'cooling' });
      continue;
    }
    if ((rej[c.idx] || 0) >= maxRej) {
      blocked.push({ idx: c.idx, reason: 'blacklisted' });
      continue;
    }
    ready.push({ idx: c.idx, endTime: c.endTime });
  }
  // 先到先得：按分区号升序，保证多点同开时口径稳定（便于对拍）
  ready.sort(function (a, b) {
    return a.idx - b.idx;
  });
  return { ready: ready, blocked: blocked };
}

/**
 * 纯函数：build() 产出的 MarchData → 2125 的 troop（实录逐键）。
 * 差异只有两处投影：`heroList` 数字数组 → `[{heroId}]`；`extraArmy{armyId,armyNum}` → `{pos:0,…}`（无则整键省略）。
 * armyPosList 只保留 pos/armyId/armyNum 三键（实录 troop 行不带 heroCap/skinId，逐键一致红线）。
 * @param {object} plan `new Battle().plan()…build()` 输出
 * @returns {object} troop
 */
export function toTroop(plan) {
  var troop = {
    heroList: (plan.heroList || []).map(function (id) {
      return { heroId: id };
    }),
    armyPosList: (plan.armyListNew || []).map(function (a) {
      return { pos: a.pos, armyId: a.armyId, armyNum: a.armyNum };
    }),
    formationV2: plan.formationV2 | 0,
  };
  if (plan.extraArmy && plan.extraArmy.armyId) {
    troop.extraArmyPos = {
      pos: 0,
      armyId: plan.extraArmy.armyId,
      armyNum: plan.extraArmy.armyNum | 0,
    };
  }
  return troop;
}

/**
 * 日界滚清：以服务器秒所在日为键，换日清「当日」语义的账（已打表/拒绝计数/冷却/今日计数/发现缓存）。
 * 口径同 train.js 的每日表（日界键，不靠重启动清零）。
 * @param {number} nowSec 服务器秒（>0，调用方已过时刻闸）
 */
function rolloverState(nowSec) {
  var d = todayStr(nowSec);
  if (d === day) return;
  day = d;
  doneSet = new Set();
  doneIdxs = [];
  rejectCount = Object.create(null);
  coolUntil = Object.create(null);
  infoByIndex = Object.create(null);
  cachedCands = [];
  lastScanAt = 0;
  startLoad();
}

// ── 调度 cycle ────────────────────────────────────────────────────────
/**
 * 档位（毫秒）：chainMs 打出一条后短歇续攻下一分区 / activeMs 有待试分区但本拍被闸门挡下 /
 * idleMs 无可打分区（长睡，scanMs 到点再发一条 2111 复探）。scanMs=2111 发现快照缓存时长。
 */
const cfg = { chainMs: 4000, activeMs: 20 * 1000, idleMs: 5 * 60 * 1000, scanMs: 60 * 1000 };

/**
 * 单拍择时：打出成功走连攻档；有待试分区被闸门挡下走短巡档；无事长睡。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  var r = await cyclePass();
  if (cycle.pending) return 0;
  return r;
}

/**
 * @returns {Promise<number>} 下拍睡眠毫秒
 */
async function cyclePass() {
  justAttacked = false;
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    return cfg.idleMs;
  }
  // 时刻闸：过期判据离不开服务器秒（拿不到就当「无从判定」跳过整拍，与 wl-chest 同口径）
  var nowSec = Math.floor(gameData.serverTime() || 0);
  if (nowSec <= 0) {
    log.debug('server time unavailable, skip this pass (expiry gate undecidable).');
    return cfg.activeMs;
  }
  rolloverState(nowSec);
  // 回读完成闸：当日已打表读盘成功前不出写请求（避免页面重载后重复撞同一只）
  if (!loaded) return cfg.activeMs;
  await ensureScan(nowSec);
  var picked = pickBeasts(cachedCands, {
    now: Date.now(),
    isDone: function (idx) {
      return doneSet.has(idx);
    },
    coolUntil: coolUntil,
    rejectCount: rejectCount,
  });
  if (!picked.ready.length) {
    var cooling = picked.blocked.some(function (b) {
      return b.reason === 'cooling';
    });
    log.debug(
      'no attackable beast. cands=%d blocked=%s',
      cachedCands.length,
      briefReasons(picked.blocked),
    );
    return cooling ? cfg.activeMs : cfg.idleMs;
  }
  // 队列闸（对齐源码 onClickAttackBtn 的 CheckMarchNumEnough）：2125 占一个行军队列名额，无空闲名额就
  //   本拍跳过（名额随在途行军回城自愈），绝不白撞「队列条件不满足」code 3。
  if (!march.canMarch(1)) {
    log.debug('no free march queue slot (myMarchNum full), wait. ready=%d', picked.ready.length);
    return cfg.activeMs;
  }
  // 串行攻打：每拍至多发一只（打完一只、其名额/部队释放后由 chainMs 快速续下只）——多只并发会互抢
  //   同一预设的空闲兵力与队列名额，与真人「一个个打」口径相悖。
  await attackBeast(picked.ready[0]);
  return justAttacked ? cfg.chainMs : cfg.activeMs;
}

/**
 * 发现腿（主动、跨图可用）：距上次 2111 超过 scanMs 就发一条，刷新区可打分区缓存。
 * 失败（应答无 wastelandList）保持旧缓存、下拍再试，不判死（活动未就绪属可自愈）。
 * @param {number} nowSec 服务器秒（过期判定基准）
 * @returns {Promise<void>}
 */
async function ensureScan(nowSec) {
  if (!net || Date.now() - lastScanAt < cfg.scanMs) return;
  if (net.isSending && net.isSending(CMD_WORLD_INFO)) return;
  lastScanAt = Date.now();
  var ret = await net.sendGuarded(CMD_WORLD_INFO, {}, { protocol: 'sendPBV2' });
  if (!aliveFn()) return;
  var p = ret && ret.ok ? parseData(ret.data) : null;
  var list = p && Array.isArray(p.wastelandList) ? p.wastelandList : null;
  if (!list) {
    log.debug('2111 wastelandList unavailable, keep cache. code=%s', ret ? ret.code : 'unknown');
    return;
  }
  cachedCands = candidateBeasts(list, nowSec);
  log.debug('scan 2111. lands=%d bossSkillOpening=%d', list.length, cachedCands.length);
}

/**
 * blocked 原因折叠成一行 `reason×n`（debug 用，保证「为什么没动」单轨可诊断，又不逐点刷屏）。
 * @param {Array<{idx:number,reason:string}>} blocked pickBeasts 产出
 * @returns {string}
 */
function briefReasons(blocked) {
  var m = Object.create(null);
  for (var i = 0; i < blocked.length; i++) m[blocked[i].reason] = (m[blocked[i].reason] || 0) + 1;
  return (
    Object.keys(m)
      .map(function (k) {
        return k + '×' + m[k];
      })
      .join(',') || '-'
  );
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.activeMs,
});

// ── 攻打腿 ────────────────────────────────────────────────────────────
/**
 * 组兵（**普通派兵口径**：容量校准 + **排除已外派**的英雄/军阵/机甲/单位——2125 占行军队列且只能动用
 * 当前空闲兵力，与真人组兵面板一致）并投影成 troop。任一闸不过只打日志、不动作。
 * @returns {object|null} troop；不可用时 null（调用方本拍跳过该分区）
 */
function buildTroop() {
  var plan = new Battle().plan().preset(MCFG.preset).adjust().build();
  if (!plan.armyListNew || !plan.armyListNew.length) {
    // 该预设的兵此刻都在途（多半是上一只熊还没打完）——串行信号，属高频自愈，debug 不刷屏
    log.debug(
      'preset #%d troops all dispatched (finish prev bear first), skip attack.',
      MCFG.preset,
    );
    return null;
  }
  // 重算器不可用 ⇒ 没经游戏实时校准的满编载荷，宁可不发（用户硬约束：攻打队伍必须校准）
  if (plan.recalcDegraded) {
    log.warn(
      'battle recalc unavailable (uncalibrated payload), skip attack. preset=#%d',
      MCFG.preset,
    );
    return null;
  }
  if (plan.presetHasHeroes && (!plan.heroList || !plan.heroList.length)) {
    log.debug('preset #%d heroes not released, skip attack.', MCFG.preset);
    return null;
  }
  return toTroop(plan);
}

/**
 * 发一条 2125 并结算（每拍至多一条，串行：一只打完、名额/部队释放后由 chainMs 续下只）。
 * @param {{idx:number,endTime:number}} c 候选（ready 项）
 * @returns {Promise<void>}
 */
async function attackBeast(c) {
  if (attackInFlight || !net) {
    log.debug('attack in flight or net unavailable, skip. idx=%d', c.idx);
    return;
  }
  var troop = buildTroop();
  if (!troop) return;
  attackInFlight = true;
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_ATTACK,
    { wastelandIndex: c.idx, troop: troop },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  attackInFlight = false;
  // 停用期间的应答不记账（分区缓存已随 pause 丢弃，resume 后重读）
  if (!aliveFn()) {
    log.debug('2125 ack after pause, drop bookkeeping. idx=%d', c.idx);
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    coolUntil[c.idx] = Date.now() + NOT_SENT_COOL_MS;
    log.warn(
      '2125 not sent%s. idx=%d',
      sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)',
      c.idx,
    );
    return;
  }
  if (!ret || !ret.ok) {
    noteReject(c, ret);
    return;
  }
  var d = parseData(ret.data) || {};
  if (!d.isOk) {
    // 应答成形但 isOk 非真：本场已无增量伤害（重复攻打/窗口尾），按「同一只每天一次」记为当日已打，不再撞
    markDone(c.idx);
    log.info(
      '2125 no incremental damage (isOk=%s), mark done today. idx=%d',
      String(d.isOk),
      c.idx,
    );
    return;
  }
  markDone(c.idx);
  rejectCount[c.idx] = 0;
  delete coolUntil[c.idx];
  justAttacked = true;
  readInfo(c.idx);
  log.info(
    'beast attacked. idx=%d troops=%d heroes=%d doneToday=%d',
    c.idx,
    troop.armyPosList.length,
    troop.heroList.length,
    doneSet.size,
  );
}

/**
 * 业务拒绝：属可预期闸门类（未到攻击窗口/时段锁/时序竞争），info 级不升 warn；
 * 单次留冷却自愈，连续 MAX_REJECT 次当日拉黑该分区（防逐拍重发刷屏）。
 * @param {{idx:number}} c 候选
 * @param {object} ret Ret{code,data}
 */
function noteReject(c, ret) {
  var n = (rejectCount[c.idx] = (rejectCount[c.idx] || 0) + 1);
  coolUntil[c.idx] = Date.now() + REJECT_COOL_MS;
  log.info(
    '2125 rejected. idx=%d code=%s reason=%s streak=%d%s',
    c.idx,
    ret ? ret.code : 'unknown',
    rejectText(ret),
    n,
    n >= MAX_REJECT ? ' (blacklisted today)' : '',
  );
}

// ── 2124 展示刷新（fire-and-forget：不阻塞 cycle，失败只 debug）───────
/**
 * 攻打成功后刷一次该分区伤害读数（面板展示用，不作判据；同点 60s 内不重复读）。
 * @param {number} idx wastelandIndex
 */
function readInfo(idx) {
  if (!net || !aliveFn()) return;
  var prev = infoByIndex[idx];
  if (prev && Date.now() - prev.atMs < 60 * 1000) return;
  if (net.isSending && net.isSending(CMD_INFO)) return;
  net
    .sendGuarded(CMD_INFO, { wastelandIndex: idx }, { protocol: 'sendPBV2' })
    .then(function (ret) {
      if (!aliveFn()) return;
      var d = ret && ret.ok ? parseData(ret.data) : null;
      if (!d) {
        log.debug('2124 refresh skipped. idx=%d code=%s', idx, ret ? ret.code : 'unknown');
        return;
      }
      infoByIndex[idx] = {
        fightValue: Number(d.fightValue) || 0,
        selfFightValue: Number(d.selfFightValue) || 0,
        atMs: Date.now(),
      };
    })
    .catch(function () {
      /* 展示读数失败可自愈（下一轮攻打再刷），空 catch 降级不停摆 */
    });
}

// ── descriptor ────────────────────────────────────────────────────────
/** @type {object[]} 战斗预设下拉项（1~8；与 cq26/mammoth.js、train.js 同口径，select 回写保留原类型） */
var presetOptions = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
  return { value: i, label: '预设部队 ' + i };
});

/**
 * 面板 defaults。
 * @returns {object}
 */
function buildDefaults() {
  return { enabled: false, preset: 1 };
}

/**
 * 面板 fields：1 个可调项 + 2 行只读状态（纯读内存账本与 2124 展示缓存，零额外请求）。
 * 刻意**不列 `enabled` 字段**：功能卡片标题行已有直驱 `enabled` 的开关（口径逐字同 mammoth.js）。
 * 也**不列“单轮攻打数”**：2125 占队列且吃空闲部队，多只熊必须串行（一只打完再打下只），无可调并发度。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: 'preset',
      type: 'select',
      label: '攻打预设队伍',
      section: '攻打（占行军队列·用空闲部队·一只打完再下一只）',
      options: presetOptions,
      hint: '出征前按可派容量实时校准，且排除已外派的兵（普通派兵口径）；队列满或该预设兵力都在途则等待',
    },
    {
      key: '_today',
      type: 'text',
      label: '今日攻打',
      section: '进度',
      get: function () {
        // 每只当日只打一次 ⇒ 只数即次数；取持久化的 doneSet（跨页面重载不丢），不再用会归零的内存计数
        return gameData.cq26IsOpen() ? doneSet.size + ' 只' : '—';
      },
    },
    {
      key: '_damage',
      type: 'text',
      label: '各熊个人伤害',
      section: '进度',
      get: function () {
        var keys = Object.keys(infoByIndex);
        if (!keys.length) return '—（攻打后刷新）';
        keys.sort(function (a, b) {
          return Number(a) - Number(b);
        });
        // 逐只列出（wastelandIndex : 个人累计伤害），大数走与游戏一字不差的 fmtLargeNum
        return keys
          .map(function (k) {
            return k + ':' + fmtLargeNum(infoByIndex[k].selfFightValue);
          })
          .join(' ｜ ');
      },
    },
  ];
}

/**
 * 面板 cfg → 运行时 cfg（硬契约：`core/registry.js` 的 applyFeature 对每个 reactor 功能无条件调它）。
 * 未声明键不透传；数值做区间钳制（预设 1~8）。
 * @param {object} c 面板合并后配置
 * @returns {object}
 */
function normalizeCfg(c) {
  var o = c || {};
  var preset = Math.round(Number(o.preset) || 0);
  return {
    enabled: !!o.enabled,
    preset: preset >= 1 && preset <= 8 ? preset : 1,
  };
}

// ── 注册 ──────────────────────────────────────────────────────────────
// 协议常量导出面：供离线 replay 对拍 manifest（scripts/verify-manifests/cq26-wl-beast.mjs）import，
//   守住「判据与 feat 共用同一份字典、不另起炉灶」红线（同 radar-task.js 的 export 口径）。
export { CMD_ATTACK, CMD_INFO, CMD_WORLD_INFO, POINT_TYPE_BEAST };

reactor.register({
  id: FEAT_ID,
  label: '冰原巨熊',
  storageKey: 'pocketcc.feat.cq26_wl_beast',
  // dataCenter 硬依赖（serverTime 是过期闸基准）；发现/攻打全走主动 2111/2125，不摸控制器 ⇒ 无 cq26WasteLand 依赖
  symbols: ['dataCenter'],
  // 发现腿走 2111 全分区快照（活动面板/内存即可得）⇒ 不必身处冰原图，base/world 皆可自动打（用户①）
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 2125 占一个行军队列名额、动用真实空闲兵力（虽不发 902 行军包），语义同派兵类玩法 → 战斗模式强制下线
  offInCombat: true,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  version: 3,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
