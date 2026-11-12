/**
 * CQ26 荒芜冰原矿区 · 组装层（feats/cq26/wl-mine/index.js）
 *
 * 一句话：把「荒芜冰原」的三条独立收益腿（采集 / 盗采 / 协助）装进三个 createCycle，
 *   判据在 legs.js、只读在 survey.js、写动作在 act.js、行军计时在 march-loop.js —— 本文件只做
 *   「闸门序 + 择时 + 面板 + 注册」，不解析报文、不拼载荷。
 *
 * 三腿互不共享开关（用户口径：一个总闸，三腿各自受自己的日额度约束）：
 *   · 采集腿 2114：本服空闲点，派兵占行军队列，`todayCanGatherTime` 16h 按 2h 安全期切 8 轮（march-loop）；
 *   · 盗采腿 2115：外服已过安全期的点，即时结算，`remainStealNum` ≤3/日；
 *   · 协助腿 2116：本服他人正在采的点，即时结算，`remainHelpNum` ≤3/日。
 *
 * 扫描成本纪律（结构性约束，不是优化项）：
 *   L0 2201 = 1 只读（300s 节流 + 在途合流）；单区精扫 = 1×2120 + 2×901 ≈ 3 只读。
 *   盗采腿**逐区惰性精扫、命中即停**：扫一个区 → 判 → 有目标就发 2115 并结束本拍；无目标才标黑名单换下一区，
 *   单拍最多 MAX_ZONES_PER_TICK 个区。绝不存在「先扫完全部候选区再统一判断」的路径（survey.js 连批量入口都不提供）。
 *   一拍最坏 1+3×3=10 只读，命中即停时 1+3=4 只读。
 *
 * 额度唯一权威 = 22072 快照（`gameData.cq26WlInfo()`，每拍现读）：服务器额度**零本地记账**。
 *   写动作应答里那份 `remainStealNum/remainGuardNum` 只进日志，不落地（ACL 坑 3）。
 *   面板分母（16h / 3 / 3）来自「观测到的最大值」自校正 —— 22072 不带上限字段，且不得为此额外发包。
 *   分矿种「最低可盗/协量」是选点门槛（items.js），不是额度记账：只滤点、不计次，日次数总额看「今日进度」。
 *
 * fail-closed 三处（宁不动作也不猜）：
 *   身份三元组（`cq26StarLandStatus`/`cq26StarLandSelf`/`cq26OriginServerId`）任一不可得 → 三腿全停；
 *   `conf(52000364)`（单点名额上限）/`conf(52000367)`（安全期秒）不可读 → 依赖它的腿停；
 *   22072 快照未达 → 本拍不动作（「还没推」≠「额度 0」）。
 *
 * 闸门序有一条方向性铁律（与 docs/feat-荒芜冰原-采集.md §4.5 的阶段闸同律）：**额度闸只决定「要不要再开新一轮」，
 *   绝不挡「外面那一趟的认领与召回」**。`todayCanGatherTime` 归零恰是最该收兵的时刻——在采那一趟已不再产出，
 *   多留一分钟只是白占行军队列，并把已过成熟线的点整段挂在「可被盗」那侧（实录 11-12：旧序把认领挡在额度闸之后，
 *   14:29 引擎离场错过 16:21 的召回点，重开后直到 18:49 那条 315 行军仍没人收）。
 *
 * 与计划书的两处实测偏离（详见 docs/feat-荒芜冰原-采集.md §3.6 与本目录 march-loop.js 文件头）：
 *   · marchId **不来自 2114 应答**（应答只有 `{isOk}`），由 901 `marchList` 探针 + 10007/10019 推送认领；
 *   · 矿种控件：采集腿用 `multiopts`（计划书写的 `tripick` 是三态单选，与「4501/4502 可并选」不符）；
 *     盗采/协助腿 v3 起用 `itemlist`（勾选 + 分矿种最低量门槛合一，旧白名单/全局门槛由 migrate 折算）。
 *
 * 合规红线：只读游戏数据 + 发包（2201/2120/901/2114/2115/2116/2121），不调任何游戏 Update/Delete 改写本地数据。
 */
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { gameData } from '../../../core/game-api.js';
import { createCycle } from '../../../core/cycle.js';
import { march } from '../../../core/march.js';
import { todayStr } from '../../../core/util.js';
import {
  ACT_GAP_MS,
  CLAIM_GAP_MS,
  CLAIM_STALE_MAX_MS,
  CMD_GATHER,
  CMD_HELP,
  CMD_MAP_SINGLE,
  CMD_STEAL,
  CMD_WORLD_INFO,
  CONF_MATURITY,
  CONF_QUOTA,
  DAILY_GATHER_SEC,
  HELP_DAILY_MAX,
  ITEM_MINE,
  ITEM_THOR_MINE,
  LAND_STATUS_OPENED,
  LAND_STATUS_OPENING,
  MAX_REJECT,
  MAX_ZONES_PER_TICK,
  PROBE_GAP_MAX_MS,
  PROBE_GAP_MS,
  PUSH_LAND_LIST,
  PUSH_MARCH,
  PUSH_WL_INFO,
  RECALL_MARGIN_SEC,
  REJECT_COOL_MS,
  STEAL_DAILY_MAX,
  TAIL_MIN_SEC,
  WL_STAGE_CAN_OPEN,
  WL_STAGE_ENDED,
  WL_STAGE_NOT_OPEN,
} from './constants.js';
import {
  briefReasons,
  canGather,
  canHelp,
  canSteal,
  isOwnGathering,
  pickNearestFree,
  rankByValue,
  stageGate,
} from './legs.js';
import { MINE_POOL, legPlan, migrateItemLists, normalizeItemState } from './items.js';
import { dispatchGather, doHelp, doSteal, readReward } from './act.js';
import {
  boardState,
  crossCheckLands,
  invalidateBoard,
  markZoneHit,
  memoGet,
  mergeSniffed,
  noteZoneStealable,
  pickStealZones,
  refreshBoard,
  reset as resetSurvey,
  scanZone,
  zoneKey,
} from './survey.js';
import {
  advance as advanceMarch,
  beginRound as beginMarchRound,
  isBusy as marchBusy,
  onMarch as feedMarch,
  reset as resetMarch,
  setMatureSec,
  snapshot as marchSnapshot,
} from './march-loop.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-MINE');

/** 功能 id（reactor / menu / storage 三处同一拼写） */
const FEAT_ID = 'cq26WlMine';

// ── 择时档位（内置调参，不上面板）───────────────────────────────────────
const D = {
  /** 刚发过一条写动作：等回执与同秒推送落地再看下一拍 */
  chainMs: 3000,
  /** 本拍有候选但被逐点闸门（冷却/拉黑）挡住：短睡重试 */
  activeMs: 20 * 1000,
  /** 采集腿空转兜底（同时是 marchId 探针的节流基准） */
  gatherIdleMs: 60 * 1000,
  /** 即时腿（盗采/协助）空转兜底 */
  instantIdleMs: 120 * 1000,
  /** 等棋盘节流窗（2201 刚刷过、本轮无区可扫/候选耗尽） */
  boardWaitMs: 30 * 1000,
  /** run 抛错时的兜底重排 */
  fallback: 30 * 1000,
  /** 被动嗅探（游戏自己的 901 应答）触发补扫的最小间隔：嗅探频率跟随玩家镜头，不设闸会形成热循环 */
  sniffKickMs: 15 * 1000,
};

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入） */
var MCFG = buildDefaults();
/** @type {{sendGuarded:Function, isSending:Function, install:Function}|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {number} 上一条即时腿写动作的本地毫秒（D 档之外的硬串行闸） */
var lastWriteMs = 0;
/** @type {Object<string,number>} 点键 → 连续被拒次数（当日拉黑语义） */
var rejectCount = Object.create(null);
/** @type {Object<string,number>} 点键 → 冷却到期本地毫秒 */
var coolUntil = Object.create(null);
/** @type {string} 上两表所属服务器日（换日清空，使「当日拉黑」真止于当日） */
var rejectDay = '';
/**
 * @type {{gather:number, steal:number, help:number}} 面板进度分母：22072 不带上限字段，
 *   用「观测到的最大值」自校正（种子为实录满值），零额外请求、零服务器侧写入。
 */
var maxSeen = { gather: DAILY_GATHER_SEC, steal: STEAL_DAILY_MAX, help: HELP_DAILY_MAX };
/** @type {boolean} 「额度快照未达」debug 去重（快照到达后复位） */
var noSnapshotWarned = false;
/** @type {boolean} 「成熟秒不可读」warn 去重（恢复后复位） */
var matureWarned = false;
/** @type {number} 上次因嗅探补扫的本地毫秒 */
var sniffKickAt = 0;
/**
 * @type {number} 「服务器说在采、本机状态机 IDLE、认领又找不到本人的点」的起始本地毫秒（0=未计时）。
 *   在途推进、标志归 0、认领命中三处任一成立即归零。
 */
var staleSinceMs = 0;
/** @type {number} 下次允许试探性派兵的本地毫秒（0=允许） */
var probeNextAtMs = 0;
/** @type {number} 试探间隔（毫秒）：被拒翻倍至 `PROBE_GAP_MAX_MS`，被接受即复位 */
var probeGapMs = PROBE_GAP_MS;
/**
 * @type {Object<string,boolean>} 陈旧计时窗内已确认「该区点数据新鲜、且没有本人的在采点」的分区键。
 *   单拍只能扫 `MAX_ZONES_PER_TICK` 个区，故覆盖度靠累计而不是靠单拍；凑齐全集才允许把标志判为陈旧。
 */
var staleCovered = Object.create(null);
/** @type {function():void}|null} 10019 回城边沿退订句柄（run 挂、pause 摘） */
var offHomeReturn = null;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（数据全部来自推送、内存投影与自发的只读请求，安装期零发包）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  if (installed) return true;
  if (!ctx || !ctx.net) {
    log.warn('install failed. missing=net');
    return false;
  }
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
  if (installed && aliveFn()) kickAll();
  return MCFG;
}

/**
 * 运行：四路订阅 + 点火（退订由 reactor 托管；10019 边沿走 core/march.js 全局复播，自持退订）。
 * 刻意**不**在此清 rejectCount/coolUntil：places/kinds 门控会反复 pause→run，清零等于给一个服务器
 *   永久拒绝的点无限续命逐拍重撞；「当日」语义由 rollover 收。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctx.on.push(PUSH_WL_INFO, onWlInfo);
  ctx.on.push(PUSH_LAND_LIST, onLandList);
  ctx.on.push(PUSH_MARCH, onMarchPush);
  // 游戏自己视口请求的应答也走同一条 dispatch：被动嗅探 316 地块，零额外报文
  ctx.on.resp(CMD_WORLD_INFO, onTileResp);
  if (!offHomeReturn) {
    // 10007 是视口绑定推送（镜头在 Home 时不下发，auto-defense 实证），只当锦上添花；
    //   回城收尾的可靠通道是 core/march.js 常驻的 10019 边沿复播。
    offHomeReturn = march.onHomeReturn(onHomeReturnMarch);
  }
  observeMax(gameData.cq26WlInfo());
  log.info('started.');
  kickAll();
}

/**
 * 停用：丢掉全部「可重放读通道」的缓存与行军计时态——它们都可能被推送/时间改写，
 *   跨停用保留会拿旧分区骨架或旧安全期倒计时去发写请求。
 */
function pause() {
  resetSurvey();
  resetMarch('feat paused');
  if (offHomeReturn) {
    offHomeReturn();
    offHomeReturn = null;
  }
}

/** @returns {boolean} 本功能是否处于激活态 */
function aliveFn() {
  return reactor.isRunning(FEAT_ID);
}

/** 三路 cycle 的统一点火入口（配置变更 / 额度推送 / 回城都走它；在飞时由 cycle 自行合并） */
function kickAll() {
  gatherCycle.kick();
  stealCycle.kick();
  helpCycle.kick();
}

// ── 闸门序 ────────────────────────────────────────────────────────────
/**
 * 三腿共用的前置闸门序（短路返回 null=本拍不动作）：
 *   活动闸 → 身份三元组（cid/group/originSid）→ 本人 UID → 服务器时刻 → 22072 额度快照 → 日界滚清 → 两个 conf。
 * `conf` 两项刻意留在返回值里而不是就地挡：只有依赖它的腿该停（采集腿要 matureSec、即时腿要 quotaMax），
 *   在共闸里 return 会让另一条能跑的腿陪睡。
 * @returns {{cid:number, group:number, originSid:number, me:string, nowSec:number, nowMs:number,
 *            info:object, quotaMax:number|null, matureSec:number|null}|null}
 */
function commonGate() {
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    return null;
  }
  // cid / group 是 2201 的两个请求参数；两者都只在此现读，绝不缓存（group 会因每轮重排改写，ACL §5）
  var st = gameData.cq26StarLandStatus();
  if (!st) {
    log.debug('no star-land status (cid unavailable) — 2201 cannot be built, all legs hold.');
    return null;
  }
  var self = gameData.cq26StarLandSelf();
  if (!self) {
    log.debug('no star-land selfInfo (group unavailable) — 2201 cannot be built, all legs hold.');
    return null;
  }
  // 老家服号取不到时若按 0 比较，外服点会全被误判成本服点：盗采腿整条退成协助腿（ACL 坑 11）
  var originSid = gameData.cq26OriginServerId();
  if (originSid == null) {
    log.debug('OriginServerId unavailable — server-identity predicates cannot be evaluated, hold.');
    return null;
  }
  var me = gameData.strUid();
  if (!me) {
    log.debug('own StrUid unavailable — steal/help de-dup and owner match are meaningless, hold.');
    return null;
  }
  var nowSec = gameData.serverTime() | 0;
  if (!nowSec) {
    log.debug('server time unavailable — mature window cannot be evaluated, skip this pass.');
    matureWarned = false;
    return null;
  }
  var info = gameData.cq26WlInfo();
  if (!info) {
    if (!noSnapshotWarned) {
      noSnapshotWarned = true;
      log.debug('no 22072 snapshot yet, skip this pass (must not read as quota 0).');
    }
    return null;
  }
  noSnapshotWarned = false;
  observeMax(info);
  rollover(nowSec);
  return {
    cid: st.cid,
    group: self.group,
    originSid: originSid,
    me: me,
    nowSec: nowSec,
    nowMs: Date.now(),
    info: info,
    quotaMax: gameData.cq26WlConf(CONF_QUOTA),
    matureSec: gameData.cq26WlConf(CONF_MATURITY),
  };
}

/**
 * 日界滚清：以服务器秒所在日为键换日，清「当日」语义的两样（逐点拒绝计数 / 冷却）。
 * @param {number} nowSec 服务器秒（>0，调用方已过时刻闸）
 */
function rollover(nowSec) {
  var d = todayStr(nowSec);
  if (d !== rejectDay) {
    rejectDay = d;
    rejectCount = Object.create(null);
    coolUntil = Object.create(null);
  }
}

/**
 * 观测额度上限（面板分母自校正）：22072 只给剩余、不给上限，故把见过的最大值当上限。
 * 方向上只会「少报已用」而不会「多报已用」（首日第一拍读到 0 时仍留种子值，见 maxSeen 初始化）。
 * @param {object|null} info `cq26WlInfo()` 快照
 */
function observeMax(info) {
  if (!info) return;
  if (info.todayCanGatherTime > maxSeen.gather) maxSeen.gather = info.todayCanGatherTime;
  if (info.remainStealNum > maxSeen.steal) maxSeen.steal = info.remainStealNum;
  if (info.remainHelpNum > maxSeen.help) maxSeen.help = info.remainHelpNum;
}

/** 距「下一个日界线 + 1 分钟」的毫秒（额度每日整日界刷新）；不可得回 0（调用方退回兜底档）。 */
function dayBoundaryMs() {
  var nowSec = gameData.serverTime() | 0;
  var reset = gameData.nextDailyResetTs();
  if (!nowSec || !reset) return 0;
  return Math.max(0, (reset - nowSec) * 1000 + 60000);
}

/**
 * 目标时刻还剩多久（服务器秒 → 本地毫秒），并夹在兜底档以内：
 * 睡到点固然省，但兜底档保证「marchId 还没认领到」这类状态机仍能周期性重试，不会一觉到明天。
 * @param {number} targetSec 目标服务器秒（<=0 视为无从判定）
 * @param {number} nowSec 当前服务器秒
 * @param {number} capMs 兜底上限
 * @returns {number} 毫秒（>0）
 */
function untilSecDelay(targetSec, nowSec, capMs) {
  if (!(targetSec > 0)) return capMs;
  var ms = (targetSec - nowSec) * 1000;
  return ms <= 0 ? D.chainMs : Math.min(capMs, ms);
}

/** @type {number|null} 上次已报告的赛季阶段（生命周期日志去重，阶段跳变才再报） */
var stageAnnounced = null;

/**
 * 把「赛季阶段」接到一条腿上：不可动作时给出睡眠档位，可动作时返回 0（继续往下跑）。
 * 与 `untilSecDelay` 的区别：阶段结束时刻可能在几小时开外（实录见 21h+），不能被既有的 60s 档反复磨。
 * @param {object} g commonGate 产出
 * @param {number} idleMs 阶段结束时刻不可得时的兜底档
 * @returns {number} 0 = 继续往下；>0 = 本拍不出网，睡这么久
 */
function stageHoldMs(g, idleMs) {
  var gate = stageGate({
    curStage: g.info.curStage,
    curStageEndTime: g.info.curStageEndTime,
    canOpen: WL_STAGE_CAN_OPEN,
    notOpen: WL_STAGE_NOT_OPEN,
    ended: WL_STAGE_ENDED,
  });
  if (stageAnnounced !== g.info.curStage) {
    stageAnnounced = g.info.curStage;
    if (!gate.actionable) {
      log.info(
        'stage=%d (%s) — dispatch/steal/help suspended%s.',
        g.info.curStage,
        gate.why,
        gate.untilSec > 0
          ? ', resume at ' + new Date(gate.untilSec * 1000).toLocaleString()
          : ' (stage end unreadable, retrying slowly)',
      );
    }
  }
  if (gate.actionable) return 0;
  var ms = gate.untilSec > 0 ? (gate.untilSec - g.nowSec) * 1000 : 0;
  return ms > 0 ? ms : idleMs;
}

// ── 扫描与选点公共件 ──────────────────────────────────────────────────
/**
 * RESOURCE 表回查采集速率（`m` 块不带 `gatherSpeed`，游戏弹窗也是回表兜底，ACL §4.4）。
 * 只随归一点携带供观测参考：采集腿**不按速率设门槛**（11-12 废弃 `gatherMinSpeed`），选点只看矿种白名单与离主城距离。
 * @param {number} itemId 点的 `m.itemId`
 * @returns {number|null} 表不可读回 null（不当 0 速率）
 */
function speedOf(itemId) {
  var r = gameData.cq26WlResource(itemId);
  return r ? r.gatherSpeed : null;
}

/**
 * 刷棋盘骨架（L0，1 只读、300s 节流）并做一次 `showNum===wastelandIndex` 的交叉校验（纯日志）。
 * @param {object} g commonGate 产出
 * @returns {Promise<{ownZones:object[], stealZones:object[], regionCount:number}|null>} 失败回 null
 */
async function ensureBoard(g) {
  var r = await refreshBoard(net, { cid: g.cid, group: g.group, originSid: g.originSid });
  if (!r.ok) {
    log.debug('%d board refresh failed. code=%s', CMD_MAP_SINGLE, r.code);
    return null;
  }
  if (!r.cached) {
    var chk = crossCheckLands(r.ownZones, gameData.cq26WlLands());
    if (chk.mismatch) {
      log.warn(
        'showNum/wastelandIndex cross-check mismatch on %d/%d zones — 2120 may hit wrong rooms.',
        chk.mismatch,
        chk.checked,
      );
    }
  }
  return boardState();
}

/** 本服「采集线 + OPENING」分区（游戏侧 checkWlOpening 只认 status===4，严格同源）。 */
function ownGatherZones(board) {
  var out = [];
  var zones = (board && board.ownZones) || [];
  for (var i = 0; i < zones.length; i++) {
    if (Number(zones[i].status) === LAND_STATUS_OPENING) out.push(zones[i]);
  }
  return out;
}

/**
 * 纯函数：memo 里已新鲜的分区直接取点（零请求），逐点过谓词。
 * @param {object[]} zones 分区骨架
 * @param {number} nowMs 本地毫秒基准
 * @param {object} ctx 谓词上下文
 * @param {Function} fn legs.js 谓词
 * @param {Array<{why:string}>} blocked 归因收集（debug 用）
 * @returns {object[]} 过闸的点（survey.js 产出的标量小对象，本层只附一个日志用的 `zoneTag`）
 */
function pointsFromMemo(zones, nowMs, ctx, fn, blocked) {
  var out = [];
  for (var i = 0; i < zones.length; i++) {
    var key = zoneKey(zones[i]);
    var e = memoGet(key, nowMs);
    if (!e) continue;
    for (var j = 0; j < e.points.length; j++) {
      var p = e.points[j];
      var v = fn(p, ctx);
      if (v.ok) out.push(tagZone(p, key));
      else blocked.push(v);
    }
  }
  return out;
}

/**
 * 给点补一个「来自哪个分区」的标记（只为日志能定位点位归属）。
 * 分区键由 `(sid, showNum)` 唯一确定，同一个 memo entry 里的点永远得到同一个值；判据与载荷都不读这个字段，
 *   故就地写字段不构成跨腿可见的状态污染（不新增对象、每拍也不为此分配）。
 * @param {object} p 归一点
 * @param {string} key zoneKey 产出
 * @returns {object} p
 */
function tagZone(p, key) {
  if (!p.zoneTag) p.zoneTag = key;
  return p;
}

/** 点键（`k_x_y`，房间 + 坐标唯一点位） */
function pointKey(p) {
  return (Number(p.k) || 0) + '_' + (Number(p.x) || 0) + '_' + (Number(p.y) || 0);
}

/**
 * 该点当前是否可动（未被当日拉黑、未在冷却窗内）。
 * @param {object} p 点
 * @param {number} nowMs 本地毫秒
 * @returns {boolean}
 */
function actionable(p, nowMs) {
  var key = pointKey(p);
  if ((Number(rejectCount[key]) || 0) >= MAX_REJECT) return false;
  return !(Number(coolUntil[key]) > nowMs);
}

/**
 * 记一次写动作结果：成功清账，业务拒绝累加计数并设冷却，未出网不记账（网络故障不该拉黑目标）。
 * @param {object} p 目标点
 * @param {object} res act.js 归一结果
 * @param {string} tag 腿名（日志）
 * @param {boolean} withReward 是否拆即时腿应答（2115/2116 带 `rewardResult` + 额度回显；2114 只带 `{isOk}`，
 *   对它调 `readReward` 会把「应答本来就没这个字段」误报成畸形应答）
 * @param {boolean} [countReject] 是否给该点记拒绝账（缺省 true）。试探派兵必须传 false：
 *   被拒是「标志说没人采、棋盘上却没人」的预期分支，跟目标点本身好坏无关；给它累加到 `MAX_REJECT`
 *   就是把一颗本来可采的点当日拉黑，探测越多、候选池反而越小。
 * @returns {boolean} 是否成功
 */
function settleWrite(p, res, tag, withReward, countReject) {
  var key = pointKey(p);
  if (!res.sent) {
    log.debug('%s not sent (%d,%d). reason=%s', tag, p.x, p.y, res.reason);
    return false;
  }
  if (!res.ok) {
    if (countReject === false) {
      log.info(
        '%s rejected (%d,%d). code=%s reason=%s (probe, uncounted)',
        tag,
        p.x,
        p.y,
        res.code,
        res.reason,
      );
      return false;
    }
    rejectCount[key] = (Number(rejectCount[key]) || 0) + 1;
    coolUntil[key] = Date.now() + REJECT_COOL_MS;
    log.info(
      '%s rejected (%d,%d). code=%s n=%d reason=%s',
      tag,
      p.x,
      p.y,
      res.code,
      rejectCount[key],
      res.reason,
    );
    return false;
  }
  delete rejectCount[key];
  delete coolUntil[key];
  lastWriteMs = Date.now();
  if (!withReward) {
    log.info('%s ok (%d,%d).', tag, p.x, p.y);
    return true;
  }
  // 额度回显只进日志（唯一权威是 22072 快照，此处零本地记账）
  var rw = readReward(res);
  log.info(
    '%s ok (%d,%d)%s%s',
    tag,
    p.x,
    p.y,
    rw.quotaKey ? ' ' + rw.quotaKey + '=' + rw.quota : '',
    rw.malformed ? ' (no rewardResult in resp)' : '',
  );
  return true;
}

/** 即时腿串行节奏：两条即时写动作（2115/2116）共用一个最小间隔，同刻只发一条。 */
function writeGapOk(nowMs) {
  return nowMs - lastWriteMs >= (MCFG.actGapMs || ACT_GAP_MS);
}

// ── 采集腿 ────────────────────────────────────────────────────────────
/**
 * 采集腿一拍：在途则推进安全期状态机 → 服务器上那一趟先认领 → 额度够才选最近空闲点派兵。
 * 序不得改：额度闸只挡「再开一轮」，不挡认领/召回（见本文件头「闸门序铁律」）。
 * 选点两阶段：① 只吃新鲜 memo（零请求，跨分区取最近）；② 无一候选才逐区精扫，扫出一颗即停手。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function gatherTick() {
  var g = commonGate();
  if (!g) return D.gatherIdleMs;
  setMatureSec(g.matureSec);
  // 状态机在途时先推进（召回时刻与出网必须同帧），此刻额度还够不够新一轮与本拍无关
  if (marchBusy()) {
    resetStaleClaim();
    var res = await advanceMarch(net, marchArgs(g));
    if (!aliveFn()) return D.gatherIdleMs;
    if (res === 'recalled') return D.chainMs;
    // 失败两档都按退避时长睡：单次失败时 march-loop 已上退避闸（60s 内不出网），
    //   放弃本轮时它已回 IDLE，后续由额度闸 / isGathering 闸（含认领路径）收敛。
    if (res === 'recall-failed' || res === 'recall-abandoned') return D.gatherIdleMs;
    return untilSecDelay(marchSnapshot().recallAtSec, g.nowSec, D.gatherIdleMs);
  }
  if (typeof g.matureSec !== 'number') {
    if (!matureWarned) {
      matureWarned = true;
      log.warn(
        'conf %d unreadable — recall time undecidable, gather leg will not dispatch.',
        CONF_MATURITY,
      );
    }
    return D.gatherIdleMs;
  }
  matureWarned = false;
  // 一轮 = 一个安全期；剩余额度塞不满一轮时不是「睡到日切」，而是把尾轮窗长压成剩余额度。
  //   旧口径每天最多白丢一个完整安全期（实测最坏 7199s ≈ 2h）：零头本就是要作废的，短窗召回仍早于成熟线。
  var windowSec = roundWindowSec(g);
  // 服务器说本人已有采集行军在场（手操 / 上一段遗留 / pause 期间派出），本机状态机不知情。
  //   绝不无脑重复派兵，但也不能只 hold：`isGathering` 只由 22072 刷新，而 22072 仅在点写入与到家两个时刻下发
  //   （2121 召回不触发），所以 reload / 手操召回 / 分区翻 OPENED 之后它会长期停在 1，把整条采集腿锁死。
  // 【序不得改】这一段必须在额度闸之前跑完：额度归零时唯一该做的事就是把外面那一趟收回来，
  //   旧写法在这里直接 `return 睡到日切`，于是 `todayCanGatherTime=0` 反而把认领路径杀了（事故实录见文件头）。
  var probing = false;
  if (g.info.isGathering) {
    var claim = await claimInFlightRound(g);
    // 认领命中 = 状态机已进 GATHERING（额度已尽时窗长取「下一拍即召回」档）：按 chainMs 立刻推进召回
    if (claim.claimed) return claim.delayMs;
    if (!claim.stale) {
      // 本拍没命中也没判陈旧（节流未到 / 棋盘不可得 / 覆盖未全）：额度已尽时不必逐拍空转，
      //   按认领自己的节奏睡 —— 中间那些拍在 `claimInFlightRound` 首句就被拦下，本来就零请求。
      return windowSec ? claim.delayMs : Math.max(claim.delayMs, CLAIM_GAP_MS);
    }
    // 陈旧嫌疑的「试探派兵」本身就是再开一轮：额度已尽 ⇒ 无窗可下（也无需再派，真在采那趟靠上面的认领逐拍收敛），
    //   不试探也不记拒绝账，下一拍照认领节奏再来。
    if (!windowSec) {
      log.debug(
        'stale isGathering suspect but quota left %ds below the tail minimum %ds, probe withheld; claim retried each %ds.',
        g.info.todayCanGatherTime,
        TAIL_MIN_SEC,
        CLAIM_GAP_MS / 1000,
      );
      return CLAIM_GAP_MS;
    }
    // 陈旧嫌疑：走一次受退避约束的试探派兵（真在采会被 `isOk:0` 拒，不扣额度也不丢产出）
    if (g.nowMs < probeNextAtMs) return claim.delayMs;
    probing = true;
  } else {
    resetStaleClaim();
  }
  // 额度闸（只管新一轮）：上面两条在途路径都已跑完，此刻确实没有任何东西替我们收兵，才允许睡到日界。
  if (!windowSec) {
    log.debug(
      'gather quota left %ds below the tail minimum %ds, sleep to daily boundary.',
      g.info.todayCanGatherTime,
      TAIL_MIN_SEC,
    );
    var until = dayBoundaryMs();
    return until > 0 ? until : D.gatherIdleMs;
  }
  // 赛季阶段闸：「等待下次开荒 / 已结束」不再扫棋盘、不再派新兵（实录：stage=2 期间 9380 个 316 点全部无主、零写动作）。
  //   刻意放在两条在途路径之后 —— marchBusy() 的召回推进与 isGathering 的认领都必须照常走，
  //   否则阶段跳变时还在外面采的那一趟没人收，成熟产出裸奔给别人偷。
  var stageMs = stageHoldMs(g, D.instantIdleMs);
  if (stageMs) return stageMs;
  var board = await ensureBoard(g);
  if (!board) return D.boardWaitMs;
  var zones = ownGatherZones(board);
  if (!zones.length) {
    log.debug('no own OPENING gather zone on board. regions=%d', board.regionCount);
    return D.boardWaitMs;
  }
  var target = await pickGatherPoint(g, zones);
  if (!aliveFn()) return D.gatherIdleMs;
  if (!target) return lastCandidate.gather ? D.activeMs : D.gatherIdleMs;
  var ret = await dispatchGather(net, target);
  if (!aliveFn()) return D.gatherIdleMs;
  if (!settleWrite(target, ret, 'gather ' + CMD_GATHER, false, !probing)) {
    if (probing) noteProbeOutcome(false);
    return ret.ok ? D.chainMs : D.activeMs;
  }
  if (probing) noteProbeOutcome(true);
  beginMarchRound(
    { x: target.x, y: target.y, k: target.k, specIndex: target.specIndex },
    g.nowSec,
    windowSec,
    '',
    0,
  );
  log.info(
    '%d dispatched (%d,%d) zone=%s quotaLeft=%ds window=%ds recallAt pending resolve%s.',
    CMD_GATHER,
    target.x,
    target.y,
    target.zoneTag,
    g.info.todayCanGatherTime,
    windowSec,
    probing ? ' (stale isGathering probe)' : '',
  );
  return D.chainMs;
}

/**
 * 本轮窗长（秒）：标准值是一个完整安全期（`conf(52000367)`），当日额度只剩零头时压成剩余额度（尾轮）。
 * 尾轮的安全性方向与整轮一致：召回时刻 = arrive + 窗长 - 余量，窗长取剩余额度 ⇒ 必定早于成熟线，
 *   不会把产出送给偷的人；只是在采不足一个安全期，拿到的比整轮少。
 * @param {object} g commonGate 产出
 * @returns {number} 0 = 零头低于 `TAIL_MIN_SEC`，不值得为它占一趟行军队列
 */
function roundWindowSec(g) {
  if (g.info.todayCanGatherTime >= g.matureSec) return g.matureSec;
  return g.info.todayCanGatherTime >= TAIL_MIN_SEC ? g.info.todayCanGatherTime : 0;
}

/**
 * 试探性派兵的结果记账：被接受即证明 `isGathering` 是陈旧值（节奏复位，本轮照常跑完）；
 *   被拒即证明真有一趟在外面（标志只是还没刷新），把间隔翻倍直到 `PROBE_GAP_MAX_MS`。
 * 实录依据：同日已有一条采集行军在场时再发 2114，服务器回 `{isOk:0}` 业务拒绝（11-08 实测 30 连拒），
 *   既不动 `todayCanGatherTime` 也不动在采点，所以代价只是一发废券 —— 但必须自带退避才不重演那种风暴。
 * @param {boolean} ok true = 2114 被接受
 */
function noteProbeOutcome(ok) {
  if (ok) {
    probeGapMs = PROBE_GAP_MS;
    probeNextAtMs = 0;
    return;
  }
  probeGapMs = Math.min(probeGapMs * 2, PROBE_GAP_MAX_MS);
  probeNextAtMs = Date.now() + probeGapMs;
}

/**
 * @type {{gather:boolean, steal:boolean, help:boolean}} 各腿上一轮是否见过候选点（只影响择时档位，不参与判据）。
 *   必须分腿记：三条腿各自 await，共享一个布尔必然跨腿脏读 —— helpTick 见过候选会把盗采腿的 120s 空转档压成 20s。
 */
var lastCandidate = { gather: false, steal: false, help: false };

/**
 * 选一颗最近的可采空闲点：阶段①零请求（新鲜 memo 全域比较），阶段②逐区精扫、出候选即停。
 * @param {object} g commonGate 产出
 * @param {object[]} zones 本服 OPENING 采集分区
 * @returns {Promise<object|null>}
 */
async function pickGatherPoint(g, zones) {
  var ctx = {
    originSid: g.originSid,
    whitelist: MCFG.gatherItemWhitelist,
  };
  lastCandidate.gather = false;
  var blocked = [];
  var pool = pointsFromMemo(zones, g.nowMs, ctx, canGather, blocked);
  var best = nearestActionable(pool, g);
  if (best) return best;
  var scanned = 0;
  for (var i = 0; i < zones.length && scanned < MAX_ZONES_PER_TICK; i++) {
    var zone = zones[i];
    var key = zoneKey(zone);
    if (memoGet(key, g.nowMs)) continue;
    var res = await scanZone(net, zone, { speedOf: speedOf, nowMs: g.nowMs });
    if (!aliveFn()) return null;
    // 合流到另一条腿正在发起的同区扫描 = 本腿这拍没新增请求
    if (!res.joined) scanned++;
    if (!res.ok) continue;
    pool = pointsFromMemo([zone], g.nowMs, ctx, canGather, blocked);
    best = nearestActionable(pool, g);
    if (best) return best;
  }
  if (blocked.length) log.debug('gather candidates all blocked. reasons=%s', briefReasons(blocked));
  return null;
}

/** @type {number} 上次尝试认领在途轮次的本地毫秒（认领要现扫分区，逐拍扫会顶破请求预算） */
var claimAtMs = 0;

/**
 * 「服务器在采、本机状态机不知情」时的认领路径（pause 期间派出的兵 / 重启 / 纯手操的行军）。
 * 只 hold 到回城事件会让这一轮的成熟窗整段作废：兵裸奔到自然到期，产出正好便宜了别人，
 *   而安全期套利正是本 feat 的价值所在。故每 `CLAIM_GAP_MS` 主动现扫一次，找回本人那颗点续跑状态机。
 * 成本纪律：与采集腿同一预算（至多 `MAX_ZONES_PER_TICK` 个区）+ 同一份 memo，命中即停；
 *   只 `beginRound` 进 GATHERING（marchId 仍由状态机自己的探针/推送去补），arrive 取点上的 `gst`：
 *   `gatherStartTime` 就是安全期起点，比「认领秒」准，且本服点不存在跨服陈旧值问题。
 * 陈旧判定：认领连续 `CLAIM_STALE_MAX_MS` 找不到本人的点，就把 `isGathering` 当陈旧值上报（`stale:true`）。
 *   不设上限就是把这条腿锁到下一次 22072 —— 而 22072 只在点写入与到家两个时刻下发，两者都以「我们先动」为前提，
 *   构成自锁（实录：一次自锁连走 21 条 hold、白等 1h48m，靠扩展 reload 才脱困）。
 * @param {object} g commonGate 产出
 * @returns {Promise<{delayMs:number, stale:boolean, claimed:boolean}>} `claimed=true` = 已接管那颗点并进 GATHERING（上层必须立刻按 `delayMs` 推进召回）；
 *   `stale=true` = 建议上层走一次试探派兵（额度已尽时这一发无窗可下，调用方不得试探）
 */
async function claimInFlightRound(g) {
  if (Date.now() - claimAtMs < CLAIM_GAP_MS) {
    return { delayMs: D.gatherIdleMs, stale: false, claimed: false };
  }
  claimAtMs = Date.now();
  var board = await ensureBoard(g);
  if (!aliveFn()) return { delayMs: D.gatherIdleMs, stale: false, claimed: false };
  if (!board) return { delayMs: D.boardWaitMs, stale: false, claimed: false };
  var zones = ownGatherZones(board);
  if (!zones.length) {
    // 不谎报陈旧：本服已无采集分区（翻 OPENED / 赛季换阶段）时选点也无从下手，
    //   而游戏侧 `checkWlOpening` 只认 status===4 —— 这不是本 feat 能绕开的口径。
    log.debug(
      'server reports isGathering=1 while no own OPENING gather zone on board (regions=%d) - hold.',
      board.regionCount,
    );
    return { delayMs: D.gatherIdleMs, stale: false, claimed: false };
  }
  // ① 先吃新鲜 memo（零请求）；② 再逐区现扫，扫出一颗即停手
  var mine = nearestOwnPoint(zones, g);
  if (!mine) {
    var scanned = 0;
    for (var i = 0; i < zones.length && scanned < MAX_ZONES_PER_TICK; i++) {
      if (memoGet(zoneKey(zones[i]), g.nowMs)) continue;
      var res = await scanZone(net, zones[i], { speedOf: speedOf, nowMs: g.nowMs });
      if (!aliveFn()) return { delayMs: D.gatherIdleMs, stale: false, claimed: false };
      if (!res.joined) scanned++;
      if (!res.ok) continue;
      mine = nearestOwnPoint([zones[i]], g);
      if (mine) break;
    }
  }
  if (!mine) {
    // 新鲜 memo 覆盖到的区 = 本拍能确定的「该区没有我的在采点」的区（逐区扫描命中即停，剩下的下一拍接着扫）
    var excludedAll = markExcludedZones(zones, g.nowMs);
    log.debug(
      'server reports isGathering=1 while local round is IDLE, own gathering point not found ' +
        '(zones=%d, excluded=%d) - hold until a march-home event.',
      zones.length,
      Object.keys(staleCovered).length,
    );
    return { delayMs: D.gatherIdleMs, stale: noteStaleClaim(excludedAll), claimed: false };
  }
  resetStaleClaim();
  // `gst` 缺失时把召回点往前压（早召回只多付一趟 ETA；晚召回是把这一段的产出送给偷的人 ——
  //   产出按在采时长线性结算，日额度不因此少花），退化成「下一拍就召回」而不是「再等一个成熟窗」。
  var arriveAt = Number(mine.gst) > 0 ? Math.floor(mine.gst) : g.nowSec - g.matureSec;
  beginMarchRound(
    { x: mine.x, y: mine.y, k: mine.k, specIndex: mine.specIndex },
    g.nowSec,
    // 本趟是什么时候派的、用的多长窗根本不知情（纯手操 / 上一日遗留），故取「不晚于成熟线」的准则：
    //   额度还剩一轮以上 ⇒ 完整安全期；只剩零头 ⇒ 尾轮窗长；
    //   连零头都不剩（事故现场）⇒ `RECALL_MARGIN_SEC`，使 recallAt = arrive（已过或将过）⇒ 下一拍即发 2121。
    //     旧值 `TAIL_MIN_SEC` 只在 `gst` 已过期时才恰好退化成即刷；万一那一趟刚开始几分钟，它会把已不再产出的在采
    //     多留近 9 分钟，方向上虽不致被盗，但白占行军队列 —— 而日额度归零后这一分钟本来就换不到任何产出。
    roundWindowSec(g) || RECALL_MARGIN_SEC,
    '',
    arriveAt,
  );
  log.info(
    'claimed in-flight own gather march at (%d,%d) zone=%s arrive=%d - resume safe-window arbitrage.',
    mine.x,
    mine.y,
    mine.zoneTag || '-',
    arriveAt,
  );
  return { delayMs: D.chainMs, stale: false, claimed: true };
}

/**
 * 「标志说在采、这一拍认领又没找到本人的点」计时：首次只记下时刻，连续失败满 `CLAIM_STALE_MAX_MS` 判为陈旧。
 * 三条同时成立才走到这里：本机状态机 IDLE + `isGathering=1` + 棋盘/精扫里没有任一颗「owner=我」的点。
 *   真在采的那颗点必然在 `ownGatherZones` 里带 owner（`isOwnGathering` 与采集派兵用的是同一份棋盘数据），
 *   所以这个组合的唯一解释是标志没刷新。
 * @param {boolean} fullCoverage true = 全部候选分区都已排除（没有「还没扫到」的区）。
 *   覆盖不全时必须把计时推平：误判陈旧的代价是多派一支兵，而上一支没人召回、成熟产出裸奔给别人偷。
 * @returns {boolean} true = 已达陈旧阈值，建议上层放行一次受退避约束的试探派兵
 */
function noteStaleClaim(fullCoverage) {
  if (!fullCoverage) {
    // 只推平时钟，不清「已排除分区」：那是累计证据，单拍只有 3 个区的预算，
    //   连它一起清就永远攒不齐全集（反而把陈旧降级变成不可能触发）。
    staleSinceMs = 0;
    return false;
  }
  var nowMs = Date.now();
  if (!staleSinceMs) {
    staleSinceMs = nowMs;
    return false;
  }
  return nowMs - staleSinceMs >= CLAIM_STALE_MAX_MS;
}

/**
 * 累计「已排除分区」并判断是否覆盖当前全集：memo 新鲜的区就是本拍能确定的「该区没有我的在采点」的区，
 *   其余区靠陈旧计时窗内的历史累计补上。按「当前每个区都被排除」判而不是比个数，
 *   因为计时窗内分区集合会变（翻 OPENED / 新开区），比个数会把已不在集里的旧证据算成覆盖。
 * @param {object[]} zones 本服 OPENING 采集分区
 * @param {number} nowMs 与 `memoGet` 同一基准的本地毫秒
 * @returns {boolean} true = 每个候选分区都已排除
 */
function markExcludedZones(zones, nowMs) {
  var all = true;
  for (var i = 0; i < zones.length; i++) {
    var key = zoneKey(zones[i]);
    if (memoGet(key, nowMs)) staleCovered[key] = true;
    if (!staleCovered[key]) all = false;
  }
  return all;
}

/** 陈旧计时复位（在途推进 / 标志归 0 / 认领命中三处），连累计的「已排除分区」一起清。 */
function resetStaleClaim() {
  staleSinceMs = 0;
  staleCovered = Object.create(null);
}

/**
 * 从新鲜 memo 里取本人正在采的那颗点（`isOwnGathering` = 源码 `isGatheringResource`）。
 * 多点同采（手操加派）时取近家那颗，保证跨拍选择稳定、不会来回换目标。
 * @param {object[]} zones 分区骨架
 * @param {object} g commonGate 产出
 * @returns {object|null}
 */
function nearestOwnPoint(zones, g) {
  var pool = pointsFromMemo(
    zones,
    g.nowMs,
    { me: g.me, originSid: g.originSid },
    isOwnGathering,
    [],
  );
  if (!pool.length) return null;
  var home = gameData.myWorldPos();
  return pickNearestFree(pool, home ? home.x : null, home ? home.y : null)[0] || null;
}

/**
 * 近家优先取第一颗可动的点（8 轮套利要吃行军 ETA，距离直接决定一天塞得下几轮）。
 * @param {object[]} pool 已过谓词的点
 * @param {object} g commonGate 产出
 * @returns {object|null}
 */
function nearestActionable(pool, g) {
  if (!pool.length) return null;
  lastCandidate.gather = true;
  var home = gameData.myWorldPos();
  var ordered = pickNearestFree(pool, home ? home.x : null, home ? home.y : null);
  for (var i = 0; i < ordered.length; i++) {
    if (actionable(ordered[i], g.nowMs)) return ordered[i];
  }
  return null;
}

/**
 * march-loop 每拍入参（本模块负责摸 ACL，状态模块保持纯计时）。
 * @param {object} g commonGate 产出
 * @returns {{alive:Function, nowSec:number, nowMs:number, probe:object}}
 */
function marchArgs(g) {
  var home = gameData.myWorldPos();
  return {
    alive: aliveFn,
    nowSec: g.nowSec,
    nowMs: g.nowMs,
    probe: {
      me: g.me,
      homeX: home ? home.x : null,
      homeY: home ? home.y : null,
      gapMs: D.gatherIdleMs,
      nowMs: g.nowMs,
    },
  };
}

// ── 盗采腿 ────────────────────────────────────────────────────────────
/**
 * 盗采腿一拍（逐区惰性精扫、命中即停）：
 *   额度闸 → L0 棋盘 → 只排序取候选（不扫描）→ 逐区「memo 命中用缓存 / 否则精扫 1 区」→
 *   有可盗点即发 2115 并**结束本拍**；无可盗点才标黑名单换下一区；单拍最多 MAX_ZONES_PER_TICK 个区。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function stealTick() {
  var g = commonGate();
  if (!g) return D.instantIdleMs;
  if (!(g.info.remainStealNum > 0)) {
    var until = dayBoundaryMs();
    return until > 0 ? until : D.instantIdleMs;
  }
  // 矿种清单闸：全不勾 = 盗采腿不动（分矿种最低量门槛在 canSteal 谓词里逐点滤）
  var plan = legPlan(MCFG.stealItems);
  if (!plan.whitelist.length) {
    log.debug('steal leg: no mine type enabled, hold.');
    return D.instantIdleMs;
  }
  if (typeof g.quotaMax !== 'number' || typeof g.matureSec !== 'number') {
    log.debug(
      'steal leg halted: conf %d/%d unreadable (quota/mature unknown).',
      CONF_QUOTA,
      CONF_MATURITY,
    );
    return D.instantIdleMs;
  }
  var stageMs = stageHoldMs(g, D.instantIdleMs);
  if (stageMs) return stageMs;
  if (!writeGapOk(g.nowMs)) return D.chainMs;
  var board = await ensureBoard(g);
  if (!board) return D.boardWaitMs;
  if (!board.stealZones.length) {
    log.debug('no foreign gather zone on board. regions=%d', board.regionCount);
    return D.boardWaitMs;
  }
  var ctx = {
    me: g.me,
    originSid: g.originSid,
    nowSec: g.nowSec,
    matureSec: g.matureSec,
    quotaMax: g.quotaMax,
    whitelist: plan.whitelist,
    mins: plan.mins,
  };
  // 只排序，绝不触发扫描（惰性扫描纪律的落点）
  var cands = pickStealZones(board.stealZones, {
    nowMs: g.nowMs,
    statusOk: [LAND_STATUS_OPENING, LAND_STATUS_OPENED],
  });
  if (!cands.length) {
    log.debug(
      'all foreign zones blacklisted within memo TTL. stealZones=%d',
      board.stealZones.length,
    );
    return D.boardWaitMs;
  }
  var scanned = 0;
  var blocked = [];
  lastCandidate.steal = false;
  for (var i = 0; i < cands.length && scanned < MAX_ZONES_PER_TICK; i++) {
    var c = cands[i];
    // scanZone 自带 memo TTL 短路（命中零请求），故 scanned 只数「本拍真扫过的区」
    var res = await scanZone(net, c.zone, { speedOf: speedOf, nowMs: g.nowMs });
    if (!aliveFn()) return D.instantIdleMs;
    if (!res.fromMemo && !res.joined) scanned++;
    if (!res.ok || !res.entry) continue;
    var pool = pointsFromMemo([c.zone], g.nowMs, ctx, canSteal, blocked);
    // 只有「本区确实没有可盗点」才进黑名单（TTL 内 pickStealZones 不再把它排进候选）；
    //   「有目标、只是我们自己在冷却/当日拉黑」不能拉黑，否则一次网络抖动就把一个肥区挡掉整个 TTL。
    if (!pool.length) {
      noteZoneStealable(c.key, false);
      continue;
    }
    var target = bestActionable(pool, g, 'steal');
    if (!target) continue;
    var ret = await doSteal(net, target);
    if (!aliveFn()) return D.chainMs;
    settleWrite(target, ret, 'steal ' + CMD_STEAL, true);
    markZoneHit(c.key);
    // 命中即停：本拍不再扫下一个区（额度只有 3 次/日，多扫的每发都是纯成本）
    return ret.ok ? D.chainMs : D.activeMs;
  }
  if (blocked.length) {
    log.debug(
      'steal scanned %d zone(s), no target. reasons=%s remain=%d',
      scanned,
      briefReasons(blocked),
      g.info.remainStealNum,
    );
  }
  return lastCandidate.steal ? D.activeMs : D.boardWaitMs;
}

// ── 协助腿 ────────────────────────────────────────────────────────────
/**
 * 协助腿一拍：额度闸 → 复用采集腿那份本服 memo（同一 TTL、同一键，缺则精扫）→ canHelp → 发 2116。
 * 与盗采腿同为「即时结算、不派兵」，故共用 `writeGapOk` 的串行节奏。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function helpTick() {
  var g = commonGate();
  if (!g) return D.instantIdleMs;
  if (!(g.info.remainHelpNum > 0)) {
    var until = dayBoundaryMs();
    return until > 0 ? until : D.instantIdleMs;
  }
  // 矿种清单闸：全不勾 = 协助腿不动（分矿种最低量门槛在 canHelp 谓词里逐点滤）
  var plan = legPlan(MCFG.helpItems);
  if (!plan.whitelist.length) {
    log.debug('help leg: no mine type enabled, hold.');
    return D.instantIdleMs;
  }
  if (typeof g.quotaMax !== 'number' || typeof g.matureSec !== 'number') {
    log.debug(
      'help leg halted: conf %d/%d unreadable (quota/mature unknown).',
      CONF_QUOTA,
      CONF_MATURITY,
    );
    return D.instantIdleMs;
  }
  var stageMs = stageHoldMs(g, D.instantIdleMs);
  if (stageMs) return stageMs;
  if (!writeGapOk(g.nowMs)) return D.chainMs;
  var board = await ensureBoard(g);
  if (!board) return D.boardWaitMs;
  var zones = ownGatherZones(board);
  if (!zones.length) return D.boardWaitMs;
  var ctx = {
    me: g.me,
    originSid: g.originSid,
    nowSec: g.nowSec,
    matureSec: g.matureSec,
    quotaMax: g.quotaMax,
    whitelist: plan.whitelist,
    mins: plan.mins,
  };
  var blocked = [];
  lastCandidate.help = false;
  var pool = pointsFromMemo(zones, g.nowMs, ctx, canHelp, blocked);
  var target = bestActionable(pool, g, 'help');
  if (!target) {
    // 缓存里没有可协点：本腿自己扫区（与采集腿共用 memo，多数情况下这一发已被另一腿买过）
    var scanned = 0;
    for (var i = 0; i < zones.length && scanned < MAX_ZONES_PER_TICK; i++) {
      var key = zoneKey(zones[i]);
      if (memoGet(key, g.nowMs)) continue;
      var res = await scanZone(net, zones[i], { speedOf: speedOf, nowMs: g.nowMs });
      if (!aliveFn()) return D.instantIdleMs;
      if (!res.joined) scanned++;
      if (!res.ok) continue;
      pool = pointsFromMemo([zones[i]], g.nowMs, ctx, canHelp, blocked);
      target = bestActionable(pool, g, 'help');
      if (target) break;
    }
  }
  if (!target) {
    if (blocked.length) log.debug('help candidates all blocked. reasons=%s', briefReasons(blocked));
    return lastCandidate.help ? D.activeMs : D.instantIdleMs;
  }
  var ret = await doHelp(net, target);
  if (!aliveFn()) return D.chainMs;
  settleWrite(target, ret, 'help ' + CMD_HELP, true);
  return ret.ok ? D.chainMs : D.activeMs;
}

/**
 * 价值优先取第一颗可动的点（盗采/协助的日额度 ≪ 候选池，收益全在择优：`oNum` 就是这一笔的即时产出）。
 * @param {object[]} pool 已过谓词的点
 * @param {object} g commonGate 产出
 * @param {string} leg 择时档位归属腿（'steal' | 'help'）
 * @returns {object|null}
 */
function bestActionable(pool, g, leg) {
  if (!pool.length) return null;
  lastCandidate[leg] = true;
  var ordered = rankByValue(pool);
  for (var i = 0; i < ordered.length; i++) {
    if (actionable(ordered[i], g.nowMs)) return ordered[i];
  }
  return null;
}

// ── 订阅 ──────────────────────────────────────────────────────────────
/**
 * 报文载荷归一（推送外层可能再包一层 data）。
 * @param {object} ev bus 事件
 * @returns {object|null}
 */
function bodyOf(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o.data || o;
}

/**
 * 22072：额度唯一权威落地 → 刷新面板分母 + 点火三 cycle。
 * 判据侧不在这里记账：本回调只从 `cq26WlInfo()` 读投影（游戏已把同一份推送写进内存），
 *   刻意不碰 `ev.data` 里的裸字段，池化对象因此天然不会外泄。
 */
function onWlInfo() {
  observeMax(gameData.cq26WlInfo());
  if (aliveFn()) kickAll();
}

/** 22071：分区状态变更（开分区/换玩法）→ 棋盘骨架失效 + 唤醒盗采腿。 */
function onLandList() {
  invalidateBoard();
  if (aliveFn()) stealCycle.kick();
}

/**
 * 10007：视口绑定的行军推送 —— 只用来补 marchId / 校准 arrive / 兜住回城边沿。
 * 池化对象纪律：同帧 `march.decode` 拆成归一 March 再交 march-loop，不留报文引用。
 * 必须先 decode：10007 的 raw 自带 `.target{tx,ty}`，而 march-loop 只认已归一化的 March（`type/state/target.x`）。
 * @param {object} ev bus 事件
 */
function onMarchPush(ev) {
  var b = bodyOf(ev);
  if (!b) return;
  var list = Array.isArray(b) ? b : [b];
  var done = false;
  for (var i = 0; i < list.length; i++) {
    var m = march.decode(list[i]);
    if (m && feedMarch(m)) done = true;
  }
  if (done && aliveFn()) gatherCycle.kick();
}

/**
 * 10019 边沿（经 core/march.js 全局复播，比 10007 可靠）：部队到家 → 本轮收尾 → 立刻开下一轮。
 * 这里的 `m` 已由 core/march.js decode 过，直接转交（再 decode 一次会把坐标解成 0）。
 * @param {object} m 已 decode 的 March
 */
function onHomeReturnMarch(m) {
  if (!aliveFn()) return;
  if (feedMarch(m)) gatherCycle.kick();
}

/**
 * 游戏自己发的 901 应答 → 被动嗅探 316 地块，增量并入 memo（零额外报文）。
 * 只唤醒盗采/协助两条即时腿；采集腿由额度/回城事件驱动，嗅探不是它的触发源。
 * @param {object} ev bus 事件
 */
function onTileResp(ev) {
  var b = bodyOf(ev);
  var list = b && (Array.isArray(b.pointList) ? b.pointList : null);
  if (!list || !list.length) return;
  var now = Date.now();
  var n = mergeSniffed(list, { speedOf: speedOf, nowMs: now });
  if (!n || !aliveFn()) return;
  // 玩家镜头一动就有一发 901，不设闸会把即时腿拖进热循环（嗅探是「顺路捡」，不是权威刷新）
  if (now - sniffKickAt < D.sniffKickMs) return;
  sniffKickAt = now;
  stealCycle.kick();
  helpCycle.kick();
}

// ── cycle 装配 ────────────────────────────────────────────────────────
/**
 * 采集腿择时：在飞期间攒下的事件（额度/回城/配置）是权威信号，立即补一拍。
 * @returns {Promise<number>}
 */
async function gatherLoop() {
  var d = await gatherTick();
  return gatherCycle.pending ? 0 : d;
}

/**
 * 盗采腿择时（同上一句纪律；命中即停的节奏在 tick 内，不在这里）。
 * @returns {Promise<number>}
 */
async function stealLoop() {
  var d = await stealTick();
  return stealCycle.pending ? 0 : d;
}

/**
 * 协助腿择时。
 * @returns {Promise<number>}
 */
async function helpLoop() {
  var d = await helpTick();
  return helpCycle.pending ? 0 : d;
}

const gatherCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: gatherLoop,
  fallback: D.fallback,
});
const stealCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: stealLoop,
  fallback: D.fallback,
});
const helpCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: helpLoop,
  fallback: D.fallback,
});

// ── 面板 ──────────────────────────────────────────────────────────────
/** 采集腿 multiopts 选项（与盗采/协助的 itemlist 共用同一份矿种池 MINE_POOL，单一真相）。 */
const MINE_OPTIONS = MINE_POOL.map(function (it) {
  return { value: it.id, label: it.label };
});

/**
 * 面板 defaults（三腿各一组矿种/门槛，一个总开关；无子开关）。
 *   stealItems/helpItems 空对象 = 全矿种默认勾选 + 无门槛（itemlist「未登记 = on/min 0」语义）。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
    gatherItemWhitelist: [ITEM_THOR_MINE, ITEM_MINE],
    stealItems: {},
    helpItems: {},
    actGapMs: ACT_GAP_MS,
  };
}

/**
 * 秒数 → `Xh Ym`（面板进度用；不足一小时只分）。
 * @param {number} sec 秒
 * @returns {string}
 */
function fmtHM(sec) {
  var s = Math.max(0, Number(sec) || 0);
  var h = Math.floor(s / 3600);
  var m = Math.round((s % 3600) / 60);
  return h > 0 ? h + 'h' + m + 'm' : m + 'm';
}

/**
 * 面板 fields：4 行只读状态置顶（纯读 22072 快照与行军快照，零额外请求）+ 说明横幅 + 5 个可调项。
 *   状态置顶是 CQ26 家族统一口径（当前状态放卡片最前边）。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_gatherQuota',
      type: 'text',
      label: '采集额度',
      section: '今日进度',
      get: function () {
        var info = snapshotForPanel();
        if (!info) return '—';
        return '剩余 ' + fmtHM(info.todayCanGatherTime) + ' / ' + fmtHM(maxSeen.gather);
      },
    },
    {
      key: '_stealQuota',
      type: 'text',
      label: '盗采额度',
      section: '今日进度',
      get: function () {
        var info = snapshotForPanel();
        if (!info) return '—';
        return '已用 ' + (maxSeen.steal - info.remainStealNum) + '/' + maxSeen.steal;
      },
    },
    {
      key: '_helpQuota',
      type: 'text',
      label: '协助额度',
      section: '今日进度',
      get: function () {
        var info = snapshotForPanel();
        if (!info) return '—';
        return '已用 ' + (maxSeen.help - info.remainHelpNum) + '/' + maxSeen.help;
      },
    },
    {
      key: '_marchPhase',
      type: 'text',
      label: '本轮行军',
      section: '今日进度',
      get: function () {
        var s = marchSnapshot();
        if (s.phase === 'IDLE') return '空闲';
        return (
          s.phase +
          ' (' +
          s.x +
          ',' +
          s.y +
          ')' +
          (s.recallAtSec ? ' 撤回 ' + fmtClock(s.recallAtSec) : '')
        );
      },
    },
    {
      // 总开关不在这里再划一行 checkbox：面板卡片头部的 pc-en（ui/panel.js）已直驱同一个 configs[fid].enabled。
      //   说明行用 type:'note'（fields.js 的 renderCheckbox 不消费 hint，挂在开关上会静默不渲染）。
      key: '_legsNote',
      type: 'note',
      text:
        '一条总闸管三条腿（采集派兵 / 盗采 / 协助，开关在卡片头部）；' +
        '三腿无子开关，各自受自己的每日额度、矿种清单与赛季阶段约束。',
    },
    {
      key: 'gatherItemWhitelist',
      type: 'multiopts',
      label: '采集矿种',
      section: '采集腿（派兵，8 轮 × 安全期）',
      options: MINE_OPTIONS,
      hint: '勾选要派兵开采的矿种；全不勾 = 不限矿种。采集腿按「离主城最近」选点，好压进行军 ETA 以便一天塞满 8 轮',
    },
    {
      key: 'stealItems',
      type: 'itemlist',
      label: '盗采矿种',
      section: '盗采腿（外服，即时结算）',
      items: MINE_POOL,
      nameGrow: true,
      numKey: 'min',
      chkTitle: '是否自动盗采该矿种',
      numPlaceholder: '不限',
      numTitle: '该矿种最低可盗量（oNum），低于此值的点不盗；0=不限',
      head: { name: '矿种', num: '最低可盗量' },
      topHint: '取消勾选=不盗该矿种；最低可盗量 0=不限；全不勾=盗采腿不动',
      hint: '只偷外服「已过安全期且仍有存量」的点；可盗量低于该矿种门槛的点不偷，把每日 3 次额度花在肥点上',
    },
    {
      key: 'helpItems',
      type: 'itemlist',
      label: '协助矿种',
      section: '协助腿（本服他人采点）',
      items: MINE_POOL,
      nameGrow: true,
      numKey: 'min',
      chkTitle: '是否自动协助该矿种',
      numPlaceholder: '不限',
      numTitle: '该矿种最低可协量（oNum），低于此值的点不协；0=不限',
      head: { name: '矿种', num: '最低可协量' },
      topHint: '取消勾选=不协该矿种；最低可协量 0=不限；全不勾=协助腿不动',
      hint: '给本服他人正在开采的点加保护并即时领奖励（不扣对方的采集量）；可获量低于该矿种门槛的点不协',
    },
  ];
}

/**
 * 面板只读快照（额度投影；活动未开/快照未达一律 `null`，面板显 `—`，绝不显 0）。
 * @returns {object|null}
 */
function snapshotForPanel() {
  if (!gameData.cq26IsOpen()) return null;
  return gameData.cq26WlInfo();
}

/**
 * 服务器秒 → 本地 `HH:mm`（撤回时刻是服务器秒，展示要折成墙上钟才读得懂；折算是纯展示口径）。
 * @param {number} epochSec 服务器秒
 * @returns {string}
 */
function fmtClock(epochSec) {
  var lead = (gameData.serverTime() | 0) - Number(epochSec) || 0;
  var d = new Date(Date.now() - lead * 1000);
  var p = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 注册 ──────────────────────────────────────────────────────────────
/**
 * 面板 cfg → 运行时 cfg（硬契约：`core/registry.js` 对每个 reactor 功能无条件调它）。
 * 采集白名单做数值化 + 去重 + 剔除非正数；盗采/协助清单状态只收池内矿种（normalizeItemState）；
 * 未声明键不透传（历史残留不进运行时）。
 * @param {object} c 面板合并后配置
 * @returns {object}
 */
function normalizeCfg(c) {
  var o = c || {};
  return {
    enabled: !!o.enabled,
    gatherItemWhitelist: idList(o.gatherItemWhitelist),
    stealItems: normalizeItemState(o.stealItems),
    helpItems: normalizeItemState(o.helpItems),
    actGapMs: Number(o.actGapMs) > 0 ? Number(o.actGapMs) : ACT_GAP_MS,
  };
}

/**
 * 勾选值 → 合法矿种数组（去重、剔非正）。
 * @param {*} v cfg 里的数组
 * @returns {number[]}
 */
function idList(v) {
  if (!Array.isArray(v)) return [];
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var n = Number(v[i]) || 0;
    if (n <= 0 || seen[n]) continue;
    seen[n] = 1;
    out.push(n);
  }
  return out;
}

reactor.register({
  id: FEAT_ID,
  label: '荒芜冰原矿区',
  storageKey: 'pocketcc.feat.cq26_wl_mine',
  // cq26WasteLand 为软依赖（探针注册的 cap，见 core/acl-engine.js）：拿不到时三腿各自在闸门序上停摆，
  //   不阻断安装（同 wl-chest / excav 的 '?' 口径）
  symbols: ['dataCenter', 'cq26WasteLand?'],
  // 与 cq26 家族同口径：靠房间号 wkid 跨图定向发包，不依赖人真站在冰原里。
  //   服务器是否校验「视野/房间归属」未实证（零拒绝样本）；首跑若出现稳定 code≠0 即收紧到「须在冰原图内」。
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 采集腿派兵占行军队列，战斗模式必须下线（同 auto-farm 一族口径）
  offInCombat: true,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  version: 3,
  migrate: migrateItemLists,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
