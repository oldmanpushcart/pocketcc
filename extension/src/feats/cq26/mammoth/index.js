/**
 * CQ26 印石·猛犸突袭：赛前驻防 + 结算批量领奖（cq26Mammoth）
 *
 * 玩法（源码 `CQ26DefenseBossData` / `CQ26DB*` 组件族 + i18n `series_frost_soil2_*`，中文面板名「猛犸突袭」）：
 *   一轮内按 turn 开「防守 BOSS」战役，阶段机 `ICQ26DefenseBossStatus`：
 *   None0 → Preview1 → Prepare2 → **Fight3（服务器逐波攻打 BOSS）** → Settlement4 → Over5。
 *   参与资格只有一个动作能拿到：**在突袭期间把自己的部队派到 BOSS 点驻防**（游戏面板「布防」按钮 =
 *   CQ26DBTroopsInfoPanel.onFightClick：`getTowerPos(CQ26TOWERID.DEFENSE_BOSS)` + `MarchType.CQ26_DB_DEFEND`
 *   → 打开出征面板）。驻防部队在 BOSS 点逐波损耗，服务器把 `selfDefTroopJoin` 置 1 = 「本场已参与」；
 *   参与是领奖的硬门槛（源码 CQ26DBMainRewardCell.refreshShow：`selfDefTroopJoin > 0` 才亮红点，
 *   text_115 的提示正是「未参与不能领」）。
 *
 * 用户口径（本 feat 的硬约束）：**驻防会真实占用 1 条行军队列，一直持续到驻防结束**。
 *   故不得提前派兵压队列 —— 派兵时刻锚定 `timeStrikeStart − leadMin`（默认 2 分钟）。
 *   报文实证 dashcam-rec-2026110*-印石-我的日常.ndjson：902 受理回包 `marchInfo.marchStartTime=1794068238`
 *   / `marchArrive=1794068261` → **基础行军仅 23 秒**，2 分钟提前量足够进驻，无需 920 加速（省道具）。
 *
 * 协议清单（NRequestIdV2 / NResponseIdV2，载荷形态逐键抄自实录报文，标注见各常量注释）：
 *   2171 SERIES_FROST_MONSTER_STRIKE_DEF_INFO_OPEN  req `{}`（实证 req 段就是空对象）
 *       resp `{turnStatus, prevTurnInfo, thisTurnInfo, energyProgress, selfServerScopeServerRankMap}`
 *       thisTurnInfo 关键字段（本地时刻 11-07 00:25 与 11-08 21:52 两条全字段 dump）：
 *         `round/turn/specId`、`timeTurnStart/timeTurnEnd/timeStrikeStart`（Int64 **毫秒**裸 Long，
 *         源码 CQ26DefenseBossData 逐字 `timeStrikeStart.toNumber()/1e3` 折秒）、
 *         `selfServerDefWave`（本服守住波数 = 奖励门槛比的分）、`selfDefTroopJoin`（参与位）、
 *         `selfGainWaveRewardSpecIdList`（已领 id 列表）、`selfServerDefFailureCount/selfServerDefFailureWaveList`。
 *       **唯一权威真相源**：本 feat 每拍读它一次（游戏侧只在开面板时读，频率由我们的档位兜住）。
 *   2178 SERIES_FROST_MONSTER_STRIKE_WAVE_REWARD_GAIN req `{round,turn,waveRewardSpecIdList:[3001..3007]}`
 *       resp `{round,turn,gainWaveRewardSpecIdList,rewardResult}`（实证一次领 7 档，逐键同录制 11-08 21:52:11）
 *   22031 push SERIES_FROST_MONSTER_STRIKE_INFO_CHANGE `{turnStatus, turnInfo:{round,turn,specId,time*,...}, strikeInfo:{wave,waveWeakenCount,time*}}`
 *       录制内 117 条（阶段跃迁 + 逐波广播）。**只作唤醒不作判据**：turnInfo 不带 selfServerDefWave/
 *       selfDefTroopJoin（实证 Preview 那条只有时刻类字段），资格与波数一律回到 2171。
 *   22002 / 22003 / 22008 push SERIES_FROST_INIT / _INFO / _INFO_CHANGE：都带 `towerInfoList`
 *       （实证 22002 push 内 `{cfg,roundCfg,info:{towerInfoList:[{towerId:2,sfBid:1002,pos:{x:378,y:478}},…]}}`），
 *       是 BOSS 坐标的**纯报文回落副本**（ACL 内存投影 `cq26DbTowerPos()` 不可用时用）。
 *   902 MARCH_WORLD_POINT `marchType=308`（CQ26_DB_DEFEND）驻防派兵 —— 走 `core/march.attack()` 组 canonical body，
 *       与录制逐键一致：`{marchType,x,y,armyList,armyListNew,heroList,trapList,break:0,formation:0,formationV2,extraArmy}`
 *       （实证 11-08 三条 308 请求：目标 378,478、9 支部队 pos 1/2/3/11/12/13/21/22/23、heroList 3 个、extraArmy 带满编）。
 *       10019 USER_MARCH_INFO 的 state 序列实证：1 在途 → 11 到达驻防 → 3 返航 → 4 到家（三波连败熔断即自动返航）。
 *
 * 闸门判据（按序短路，见 cyclePass）：
 *   1 活动闸 `gameData.cq26IsOpen()`；
 *   2 快照闸 2171 读达（读不到只短巡自愈，绝不用旧快照发写请求）；
 *   3 派兵腿：`turnStatus ∈ {1,2,3}` && `selfDefTroopJoin===0`（达标即收手，不再多占队列）&&
 *      `now ≥ timeStrikeStart − leadMin` && `now < timeTurnEnd` && 本轮重试未封顶 &&
 *      无本人 308 行军在场（`march.list({cache:true})`）&& `march.canMarch(1)` 队列闸 && 坐标可读 && 预设能出兵；
 *   4 领奖腿：`turnStatus===4`（Settlement，实证 11-08 21:52 就在此刻领）&& `selfDefTroopJoin>0` &&
 *      奖励表可读（不可读 fail-closed）&& 存在 `wave ≤ selfServerDefWave 且未领` 的行。
 *
 * 触发源：`createCycle` 档位择时（远窗长睡、窗内 20s 短巡、派兵后 30s 复核、领奖后 20s 补领复核）
 *   + `ctx.on.push(22031)` 抢跑唤醒
 *   + `march.onStateChange` 的 308 边沿（返航/到家即 kick，参与还没达标就赶在 Fight 内补派）。
 *
 * 刻意不做：
 *   不发 2176 SKIP / 2175 TIME_MODIFY / 2174 TIME_VOTE（改突袭时刻属玩家决策，自动化不替用户投票）；
 *   不发 2172 ATK_INFO_OPEN / 2177 DEF_TROOP_INFO_OPEN（面板明细，自动化零收益）；
 *   不做 920 加速（23 秒基础行军，提前 2 分钟足够）；不做「打完自动补兵续驻防」——
 *   驻防部队被波次消耗是玩法本意，续派只会反复占队列，与「不影响日常游戏」的用户口径相反。
 */
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { gameData, bits } from '../../../core/game-api.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';
import { createCycle } from '../../../core/cycle.js';
import { CODE_NOT_SENT, parseData, rejectText } from '../../../core/util.js';

import { CMD_INFO, CMD_CLAIM, PUSH_DB_INFO } from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-MAMMOTH');

/** @type {string} reactor 功能 id（面板挂载见 core/menu.js 的 cq26 类别） */
const FEAT_ID = 'cq26Mammoth';

/**
 * @type {number[]} 带 towerInfoList 的印石通用推送（22002 SERIES_FROST_INIT / 22003 / 22008 SERIES_FROST_INFO_CHANGE）
 * 报文实证：22002 是 **push**（不是应答），登录/进活动图各来一条；22008 随分钟级信息刷新高频下发。
 */
const PUSH_FROST_INFO = [22002, 22003, 22008];
/** @type {number} 902 的 marchType：猛犸突袭驻防（游戏侧 MarchType.CQ26_DB_DEFEND，报文实证 308） */
const MARCH_TYPE_DEFEND = 308;

/**
 * @type {Object<string,number>} 阶段机 ICQ26DefenseBossStatus 的本地副本（源码 CQ26Controller 枚举，
 *   稳定契约值；符号漂移时不至于全线读错阶段）
 */
const ST = { NONE: 0, PREVIEW: 1, PREPARE: 2, FIGHT: 3, SETTLEMENT: 4, OVER: 5 };

/** @type {number} 同一 turn 内最多派几次（部队被波次打光后补派用；封顶防逐拍撞队列） */
const MAX_DISPATCH_PER_TURN = 3;
/** @type {number} 单次派兵被拒后的冷却毫秒 */
const REJECT_COOL_MS = 60 * 1000;
/**
 * @type {number} 两次 2171 读的最小间隔毫秒。主触发是 22031 push 与 308 行军边沿，
 *   而突袭期每波一条 push（录制实证 117 条）会逐条 kick —— 不加这层闸就等于「每波白读一次权威」，
 *   比游戏自己（只在开面板时读）密得多。10s 已覆盖「阶段跃迁后立刻重判」的需要。
 */
const MIN_READ_GAP_MS = 10 * 1000;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入） */
var MCFG = buildDefaults();
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/**
 * @typedef {object} DbSnap
 * @property {number} status turnStatus
 * @property {number} round 轮
 * @property {number} turn 场
 * @property {number} specId 时刻方案 id
 * @property {number} strikeStartSec 突袭开始（服务器秒，0=未知）
 * @property {number} turnEndSec 本场结束（服务器秒，0=未知）
 * @property {number} wave selfServerDefWave（奖励门槛比的分）
 * @property {number} join selfDefTroopJoin（>0 = 本场已参与）
 * @property {number[]} gained selfGainWaveRewardSpecIdList（已领奖 id）
 */
/** @type {DbSnap|null} 2171 权威快照（每拍整体替换；null=尚未读达） */
var SNAP = null;
/** @type {{x:number,y:number}|null} BOSS 坐标的纯报文回落副本（ACL 投影不可用时用） */
var posCache = null;
/** @type {Object<string,number>} `round:turn` → 本 feat 已派次数 */
var dispatchTries = Object.create(null);
/** @type {Object<string,boolean>} `round:turn` → 两次权威读之间已成功领奖（只防重发；2171 读达即清除，见 applyInfo） */
var claimDone = Object.create(null);
/** @type {number} 派兵冷却到期时刻（Date.now() 基准） */
var coolUntilMs = 0;
/** @type {boolean} 本拍是否刚发出驻防（择时切到「到点复核」档） */
var justDispatched = false;
/** @type {boolean} 本拍是否刚领奖成功（择时切短巡：结算抢跑时旧快照 wave 可能滞后，读达后补领剩余档） */
var justClaimed = false;
/** @type {boolean} 派兵窗口已到且仍待动手（择时切到短巡档） */
var pendingDispatch = false;
/** @type {number} legs 写就的「下一次值得醒来的服务器秒」（0=无指定） */
var wakeAtSec = 0;
/** @type {number} 上次成功读达 2171 的本地毫秒（0=从未） */
var lastReadMs = 0;
/** @type {boolean} 「坐标两路都取不到」的 warn 去重（恢复后复位） */
var posWarned = false;
/** @type {boolean} 「奖励表不可读」的 warn 去重 */
var rowsWarned = false;
/** @type {function|null} march.onStateChange 退订句柄（模块级单挂，pause 不摘，回调自判 alive） */
var offMarch = null;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（判据全来自 2171 读与推送，安装期不发任何请求）。
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
 * 配置灌入（reactor → 本模块）。翻开关即抢跑一拍，让「刚打开就赶上窗口」不必等整档睡眠。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (partial) MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：订阅 22031/通用印石推送 + 行军边沿 + 点火（push 退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctx.on.push(PUSH_DB_INFO, onDbInfoPush);
  for (var i = 0; i < PUSH_FROST_INFO.length; i++) ctx.on.push(PUSH_FROST_INFO[i], onFrostInfoPush);
  // 行军边沿只用来「醒得快」：驻防被打通（返航/到家）而参与还没达标时，趁 Fight 还没结束补派一次。
  //   march.js 的生命周期是全局单点复播，退订管不到 reactor 之外 ⇒ 自己存句柄、只挂一次；
  //   按规范在回调内自判 alive，不在 pause 里摘（摘了 resume 会重挂成两份）。
  if (!offMarch) offMarch = march.onStateChange(onMarchEdge);
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉不该跨暂停持有的陈旧判据（快照/坐标副本/本拍决策位），
 *   避免 resume 后拿上一场的 `timeStrikeStart`/`join` 去发写请求。
 *   派兵计数与领奖幂等键刻意保留（同一场重挂不该再多撞一次队列）。
 */
function pause() {
  SNAP = null;
  posCache = null;
  lastReadMs = 0;
  justDispatched = false;
  justClaimed = false;
  pendingDispatch = false;
  wakeAtSec = 0;
}

/**
 * 存活判定（cycle 与所有 await 之后的记账都过这一闸）。
 * @returns {boolean}
 */
function aliveFn() {
  return reactor.isRunning(FEAT_ID);
}

// ── 推送入口 ──────────────────────────────────────────────────────────
/**
 * 取业务体：net 已剥 pbAckV2 信封，ev.data 即内层业务体（与 Ret 同口径）；此处仅做对象形态守卫。
 * @param {object} ev 推送事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o;
}

/**
 * 22031：阶段跃迁/逐波广播。只取 `turnStatus` 与时刻类字段刷新快照的「新鲜度提示」，
 *   随即 kick 让 cycle 去 2171 取权威（实证 turnInfo 不带 join/wave）。
 * @param {object} ev 推送事件
 */
function onDbInfoPush(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var st = Number(b.turnStatus);
  if (st >= 0 && st <= ST.OVER && (!SNAP || SNAP.status !== st)) {
    log.debug('22031 turnStatus %s -> %s', SNAP ? SNAP.status : '?', st);
    if (SNAP) SNAP.status = st;
  }
  if (aliveFn()) cycle.kick();
}

/**
 * 22002/22003/22008：印石通用信息推送，都可能在 `info.towerInfoList` 或顶层 `towerInfoList` 里带 BOSS 塔坐标。
 *   只服务「ACL 内存投影读不到时的回落副本」这一件事，取到就缓存，取不到不改旧值。
 * @param {object} ev 推送事件
 */
function onFrostInfoPush(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var list = b.towerInfoList || (b.info && b.info.towerInfoList);
  var pos = pickBossPos(list);
  if (pos) {
    posCache = pos;
    posWarned = false;
  }
}

/**
 * 从 towerInfoList 里挑防守 BOSS 塔（towerId=2 = CQ26TOWERID.DEFENSE_BOSS）的坐标。
 * @param {*} list 报文里的 towerInfoList（形态不受控，非法即回 null）
 * @returns {{x:number,y:number}|null}
 */
function pickBossPos(list) {
  if (!Array.isArray(list)) return null;
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t || Number(t.towerId) !== 2) continue;
    var p = t.pos;
    if (!p || typeof p !== 'object') return null;
    var x = Number(p.x) || 0;
    var y = Number(p.y) || 0;
    return x > 0 && y > 0 ? { x: x, y: y } : null;
  }
  return null;
}

/**
 * 308 行军的边沿回调：只在「驻防让出行军队列」（返航/到家）时唤醒重判，其余状态忽略。
 * @param {object} m March（归一化纯数据）
 */
function onMarchEdge(m) {
  if (!aliveFn()) return;
  if (!m || m.type !== MARCH_TYPE_DEFEND) return;
  if (m.state !== march.State.RETURNING && m.state !== march.State.ARRIVED_HOME) return;
  log.debug('march 308 edge state=%s id=%s, kick.', m.state, m.id);
  cycle.kick();
}

// ── 快照：2171 权威读 ──────────────────────────────────────────────────
/**
 * 服务器秒（与 `Date.now()` 解耦，派兵窗口以服务器钟为准 —— `timeStrikeStart` 本身就是服务器时刻）。
 * @returns {number} 读不到回 0（调用方本拍不动作）
 */
function serverNow() {
  return Math.floor(gameData.serverTime() || 0);
}

/**
 * Int64 毫秒 → 服务器秒（源码 `timeStrikeStart.toNumber()/1e3` 同构；`bits.int64ToNum` 兜裸 Long/POJO 三形态）。
 * @param {*} v Long / 裸 {_low,_high} / 数字
 * @returns {number} 秒（无值回 0）
 */
function msToSec(v) {
  var ms = bits.int64ToNum(v);
  return ms > 0 ? Math.floor(ms / 1000) : 0;
}

/**
 * 读一次 2171 并整体替换快照（`MIN_READ_GAP_MS` 内的重复唤醒直接沿用旧快照，零网络）。
 * @returns {Promise<boolean>} true=本拍拿到可用快照（含「在途合流、沿用旧快照」）
 */
async function readStrikeInfo() {
  if (!net) {
    log.warn('net unavailable, skip 2171.');
    return false;
  }
  if (SNAP && Date.now() - lastReadMs < MIN_READ_GAP_MS) return true;
  // 在途合流：游戏自己也在读 2171（开面板），不重复发；旧快照够用一拍
  if (net.isSending(CMD_INFO)) return !!SNAP;
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_INFO,
    {},
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) return false;
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn(
      '2171 not sent%s.',
      sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)',
    );
    return false;
  }
  if (!ret || !ret.ok) {
    log.info('2171 rejected. code=%s reason=%s', ret ? ret.code : 'unknown', rejectText(ret));
    return false;
  }
  var d = parseData(ret.data);
  if (!d || typeof d !== 'object' || !d.thisTurnInfo) {
    log.warn('2171 ack without thisTurnInfo, ignore.');
    return false;
  }
  applyInfo(d);
  lastReadMs = Date.now();
  posWarned = false;
  return true;
}

/**
 * 2171 应答 → DbSnap（整体替换；`gained` 做正整数清洗，服务器可能下发字符串形态 id）。
 * @param {object} d 应答业务体
 */
function applyInfo(d) {
  var ti = d.thisTurnInfo || {};
  SNAP = {
    status: Number(d.turnStatus) || 0,
    round: Number(ti.round) || 0,
    turn: Number(ti.turn) || 0,
    specId: Number(ti.specId) || 0,
    strikeStartSec: msToSec(ti.timeStrikeStart),
    turnEndSec: msToSec(ti.timeTurnEnd),
    wave: Number(ti.selfServerDefWave) || 0,
    join: Number(ti.selfDefTroopJoin) || 0,
    gained: idArr(ti.selfGainWaveRewardSpecIdList),
  };
  // 权威读达即解除重发闸：gained 已是服务器真相。若结算抢跑时首条 2178 用了滞后 wave（10s 读闸内
  //   沿用旧快照），读达后 wave 补齐，剩余未领行必须允许再发一条，不能被幂等键锁死本场。
  delete claimDone[SNAP.round + ':' + SNAP.turn];
}

/**
 * 任意数组 → 正整数 id 数组（去非正、去 NaN）。
 * @param {*} v 报文里的 id 列表
 * @returns {number[]}
 */
function idArr(v) {
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var n = Number(v[i]) || 0;
    if (n > 0) out.push(n);
  }
  return out;
}

// ── 派兵腿 ────────────────────────────────────────────────────────────
/**
 * 驻防派兵（占 1 条行军队列，直到驻防结束）。任一闸门不过只打日志、不动作。
 * @param {number} nowSec 服务器秒
 * @returns {Promise<void>}
 */
async function dispatchLeg(nowSec) {
  pendingDispatch = false;
  if (!MCFG.autoDispatch) return;
  var s = SNAP;
  if (!s) return;
  // 阶段闸：Settlement/Over 之后再派毫无收益（参与位已定局），Preview/Prepare/Fight 才管
  if (s.status !== ST.PREVIEW && s.status !== ST.PREPARE && s.status !== ST.FIGHT) return;
  // 参与闸：已达标就收手，不再多占队列（用户口径「不影响日常游戏」）
  if (s.join > 0) {
    log.debug('already joined (join=%d), no more dispatch. wave=%d', s.join, s.wave);
    return;
  }
  if (!(s.strikeStartSec > 0)) {
    log.debug('no timeStrikeStart in snapshot, nothing to anchor.');
    return;
  }
  var leadSec = Math.max(1, MCFG.leadMin) * 60;
  var at = s.strikeStartSec - leadSec;
  if (nowSec < at) {
    wakeAtSec = Math.max(wakeAtSec, at);
    log.debug(
      'dispatch window opens in %ds (strike at %d, lead %dm).',
      at - nowSec,
      s.strikeStartSec,
      MCFG.leadMin,
    );
    return;
  }
  if (s.turnEndSec > 0 && nowSec >= s.turnEndSec) {
    log.debug('turn already over (turnEnd=%d now=%d), skip dispatch.', s.turnEndSec, nowSec);
    return;
  }
  pendingDispatch = true;
  var key = s.round + ':' + s.turn;
  if ((dispatchTries[key] || 0) >= MAX_DISPATCH_PER_TURN) {
    log.debug('dispatch tries capped (%d) for %s, wait next turn.', MAX_DISPATCH_PER_TURN, key);
    pendingDispatch = false;
    return;
  }
  if (Date.now() < coolUntilMs) {
    log.debug('dispatch cooling after reject (until %dms left).', coolUntilMs - Date.now());
    return;
  }
  // 已有一支 308 在外（在途或驻防中）就不重复占队列；读缓存快照（856 播种 + 10019 边沿维护），稳态零网络
  var ms = await march.list({ cache: true });
  if (!aliveFn()) return;
  for (var i = 0; i < ms.length; i++) {
    if (ms[i].type === MARCH_TYPE_DEFEND && ms[i].isOccupying) {
      // 队列已被自己占着：不再动手，也不把本拍标成「待办」（否则逐拍短巡空转）。
      //   下一次重判由 308 的返航/到家边沿或 22031 的阶段跃迁唤醒，都不会漏。
      pendingDispatch = false;
      log.debug('308 already out (id=%s state=%s), hold the slot.', ms[i].id, ms[i].stateName);
      return;
    }
  }
  if (!march.canMarch(1)) {
    log.debug('no free march slot (used=%d), skip dispatch.', gameData.marchCount().used);
    return;
  }
  var pos = gameData.cq26DbTowerPos();
  if (pos) posWarned = false;
  if (!pos) pos = posCache;
  if (!pos) {
    if (!posWarned) {
      posWarned = true;
      log.warn('boss pos unavailable (acl projection + frost push both empty), cannot dispatch.');
    }
    return;
  }
  var plan = new Battle().plan().preset(MCFG.preset).adjust().build();
  if (!plan.armyListNew || !plan.armyListNew.length) {
    log.info('preset #%d has no dispatchable troops, skip dispatch.', MCFG.preset);
    return;
  }
  if (plan.presetHasHeroes && (!plan.heroList || !plan.heroList.length)) {
    log.debug('preset #%d heroes not released, skip dispatch.', MCFG.preset);
    return;
  }
  dispatchTries[key] = (dispatchTries[key] || 0) + 1;
  var ret = await march.attack({
    marchType: MARCH_TYPE_DEFEND,
    target: { x: pos.x, y: pos.y },
    data: plan,
  });
  if (!aliveFn()) return;
  pendingDispatch = false;
  if (ret && ret.code === CODE_NOT_SENT) {
    coolUntilMs = Date.now() + REJECT_COOL_MS;
    log.warn(
      '902(308) not sent (in-flight gate or send error). key=%s try=%d',
      key,
      dispatchTries[key],
    );
    return;
  }
  if (!ret || !ret.ok) {
    coolUntilMs = Date.now() + REJECT_COOL_MS;
    log.info(
      '902(308) rejected. code=%s reason=%s key=%s try=%d',
      ret ? ret.code : 'unknown',
      rejectText(ret),
      key,
      dispatchTries[key],
    );
    return;
  }
  justDispatched = true;
  var mi = (parseData(ret.data) || {}).marchInfo || {};
  log.info(
    'garrison dispatched. pos=%d,%d troops=%d key=%s try=%d marchId=%s',
    pos.x,
    pos.y,
    plan.armyListNew.length,
    key,
    dispatchTries[key],
    // marchId 是 64 位雪花 id（实证 4920991173899577378）：只能按字符串读，Number 会丢精度
    mi.marchId != null ? bits.int64Str(mi.marchId) : '?',
  );
}

// ── 领奖腿 ────────────────────────────────────────────────────────────
/**
 * 结算期批量领波次奖励。门槛口径逐字抄源码 CQ26DBMainRewardCell.sendToGetReward：
 *   `wave>0 && wave<=selfServerDefWave && 未领` 的行 id 全入一条 2178。
 * @returns {Promise<void>}
 */
async function claimLeg() {
  var s = SNAP;
  if (!s || !MCFG.claim) return;
  if (s.status !== ST.SETTLEMENT) return;
  // 参与位是服务器硬闸（源码红点判据 + text_115 提示），join=0 发过去只会被拒
  if (!(s.join > 0)) {
    log.debug('settlement but join=0 (no garrison this turn), skip claim. wave=%d', s.wave);
    return;
  }
  var rows = gameData.cq26DbWaveRewardRows();
  if (!rows) {
    if (!rowsWarned) {
      rowsWarned = true;
      log.warn('series_frost_monsterReward unreadable, fail-closed (no claim).');
    }
    return;
  }
  rowsWarned = false;
  var ids = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.wave > s.wave) continue;
    if (s.gained.indexOf(r.id) >= 0) continue;
    ids.push(r.id);
  }
  if (!ids.length) {
    log.debug('nothing to claim (wave=%d gained=%d).', s.wave, s.gained.length);
    return;
  }
  var key = s.round + ':' + s.turn;
  if (claimDone[key]) {
    log.debug('claim already sent for %s this pass, wait 2171 to refresh gained.', key);
    return;
  }
  if (!net) {
    log.warn('net unavailable, skip claim.');
    return;
  }
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_CLAIM,
    { round: s.round, turn: s.turn, waveRewardSpecIdList: ids },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) return;
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn(
      '2178 not sent%s.',
      sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)',
    );
    return;
  }
  if (!ret || !ret.ok) {
    log.info(
      '2178 rejected. code=%s reason=%s ids=%d',
      ret ? ret.code : 'unknown',
      rejectText(ret),
      ids.length,
    );
    return;
  }
  var d = parseData(ret.data) || {};
  var got = idArr(d.gainWaveRewardSpecIdList);
  claimDone[key] = true;
  if (got.length) justClaimed = true;
  // 以应答为准合并进快照（下一拍 2171 会给出服务器真相）
  for (var j = 0; j < got.length; j++)
    if (SNAP.gained.indexOf(got[j]) < 0) SNAP.gained.push(got[j]);
  log.info('wave rewards claimed. key=%s ids=%d gained=%d', key, ids.length, got.length);
}

// ── 调度 ──────────────────────────────────────────────────────────────
/**
 * 档位（毫秒）。主触发是 22031 push 与 308 行军边沿，轮询只兜「漏推送 + 到点复核」：
 *   activeMs 窗内短巡 / arriveMs 派兵后复核进驻 / idleMs 无事长睡（靠推送唤醒）/
 *   farMs 距突袭尚远（>10min）时的哨兵心跳（录制实证 Prepare 可长达 18h，不能每 5min 白读一次权威）/
 *   backoffMs 抛错兜底。
 */
const cfg = {
  activeMs: 20 * 1000,
  arriveMs: 30 * 1000,
  idleMs: 5 * 60 * 1000,
  farMs: 30 * 60 * 1000,
  backoffMs: 60 * 1000,
};

/**
 * 单拍：取权威快照 → 派兵腿 → 领奖腿 → 择时。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  var ms = await cyclePass();
  if (cycle.pending) return 0;
  return ms;
}

/**
 * @returns {Promise<number>} 下拍睡眠毫秒
 */
async function cyclePass() {
  justDispatched = false;
  justClaimed = false;
  pendingDispatch = false;
  wakeAtSec = 0;
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    return cfg.idleMs;
  }
  var ok = await readStrikeInfo();
  if (!ok) return cfg.activeMs;
  var nowSec = serverNow();
  if (!(nowSec > 0)) {
    log.warn('server time unreadable, skip this pass.');
    return cfg.activeMs;
  }
  var s = SNAP;
  log.debug(
    'snap status=%d round=%d turn=%d wave=%d join=%d strike=%s',
    s.status,
    s.round,
    s.turn,
    s.wave,
    s.join,
    s.strikeStartSec ? new Date(s.strikeStartSec * 1000).toLocaleString() : '-',
  );
  await dispatchLeg(nowSec);
  if (!aliveFn()) return cfg.activeMs;
  await claimLeg();
  if (justDispatched) return cfg.arriveMs;
  // 领奖后短巡复核：首条 2178 可能用了滞后 wave（结算推送抢跑），20s 后权威读达补领剩余档
  if (justClaimed) return cfg.activeMs;
  if (pendingDispatch) return cfg.activeMs;
  if (wakeAtSec > nowSec) {
    var remSec = wakeAtSec - nowSec;
    // 远窗（>10min）把睡帽抬到 farMs：到点本身由 22031 的阶段跃迁推送抢跑，轮询只作漏推兼底
    var cap = remSec > 10 * 60 ? cfg.farMs : cfg.idleMs;
    return Math.max(cfg.activeMs, Math.min(remSec * 1000 + 15 * 1000, cap));
  }
  return cfg.idleMs;
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.backoffMs,
});

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 面板 defaults。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
    autoDispatch: true,
    preset: 1,
    leadMin: 2,
    claim: true,
  };
}

/** @type {object[]} 战斗预设下拉项（1~8；与 cq26/train.js、alliance-boss.js 同口径，select 回写保留原类型） */
var presetOptions = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
  return { value: i, label: '预设部队 ' + i };
});

/**
 * 面板 fields：2 行只读状态置顶（纯读 2171 快照，零额外请求）+ 4 个可调项。
 *   状态置顶是 CQ26 家族统一口径（当前状态放卡片最前边）。
 * 刻意**不列 `enabled` 字段**：功能卡片标题行已有一个直驱 `enabled` 的开关（core/ui/panel.js 的
 *   renderFeatureCard），再出一行同义 checkbox 属重复控件，两个入口易被读成两个独立闸门。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_turn',
      type: 'text',
      label: '本场',
      section: '今日进度',
      get: function () {
        var s = SNAP;
        if (!s) return '—';
        // round=活动轮次（实证每天一轮、间隔数日），turn=本轮场次（实证恒 1，多场才补「第N场」）
        var head = '第' + s.round + '轮';
        if (s.turn > 1) head += ' 第' + s.turn + '场';
        var txt = head + ' · ' + statusName(s.status);
        // 突袭时刻只在「还没开打」时有意义（准备期锚定派兵窗口）；开打后是历史噪音，不再挂尾
        if ((s.status === ST.PREVIEW || s.status === ST.PREPARE) && s.strikeStartSec) {
          txt += '，' + strikeText(s.strikeStartSec);
        }
        return txt;
      },
    },
    {
      key: '_join',
      type: 'text',
      label: '参与 / 波数',
      section: '今日进度',
      get: function () {
        var s = SNAP;
        if (!s) return '—';
        return (s.join > 0 ? '已参与' : '未参与') + ' · 守住 ' + s.wave + ' 波';
      },
    },
    {
      key: 'autoDispatch',
      type: 'checkbox',
      label: '突袭前自动派兵驻防',
      section: '驻防（占 1 条行军队列）',
      hint: '关掉则只领奖不派兵（参与位由你自己手动布防拿到）。驻防会真实占用一条行军队列直到驻防结束，故只在窗口内动手',
    },
    {
      key: 'leadMin',
      type: 'number',
      label: '提前派兵（分钟）',
      section: '驻防（占 1 条行军队列）',
      min: 1,
      max: 30,
      step: 1,
      hint: '锚定「突袭开始−此值」提前进驻；默认 2 分钟已足够，调大只会白压队列。',
    },
    {
      key: 'preset',
      type: 'select',
      label: '驻防预设队伍',
      section: '驻防（占 1 条行军队列）',
      options: presetOptions,
      hint: '部队会在逐波防守中被消耗，选一支「愿意交出去」的队伍',
    },
    {
      key: 'claim',
      type: 'checkbox',
      label: '结算自动领波次奖励',
      section: '领奖',
      hint: '门槛 = 本服守住波数；未拿到「参与」的场次不发（服务器必拒）',
    },
  ];
}

/**
 * 阶段号 → 用户视角短语（面板展示；未知号如实给数字，不臆造语义）。
 * 措辞对齐游戏主面板（CQ26DBMainComponent.refreshCdTime）：准备期=待突袭、结算=「本轮已结束」。
 * @param {number} st turnStatus
 * @returns {string}
 */
function statusName(st) {
  switch (st) {
    case ST.PREVIEW:
      return '预告';
    case ST.PREPARE:
      return '准备中';
    case ST.FIGHT:
      return '突袭进行中';
    case ST.SETTLEMENT:
      return '突袭结束，结算中';
    case ST.OVER:
      return '已结束';
    default:
      return '阶段' + st;
  }
}

/**
 * 服务器秒 → 本地 `HH:mm`（派兵窗口是服务器时刻，折墙上钟才读得懂；纯展示口径）。
 * @param {number} epochSec 服务器秒
 * @returns {string}
 */
function fmtClock(epochSec) {
  var lead = serverNow() - (Number(epochSec) || 0);
  var d = new Date(Date.now() - lead * 1000);
  var p = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 突袭时刻 → 用户视角短语（含日界限定）。准备期可跨天（实证第4轮 11/11 就在准备 11/12 的突袭），
 * 只给 HH:mm 会把「明天 20:00」误读成今天，故按本地日历天补「今天/明天/M/D」。
 * @param {number} epochSec 突袭开始服务器秒
 * @returns {string} 如「20:00 突袭」「明天 20:00 突袭」「11/12 20:00 突袭」
 */
function strikeText(epochSec) {
  var lead = serverNow() - (Number(epochSec) || 0);
  var d = new Date(Date.now() - lead * 1000);
  var now = new Date();
  var dayNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var dayHit = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  var diff = Math.round((dayHit - dayNow) / 86400000);
  var hm = fmtClock(epochSec);
  if (diff === 0) return hm + ' 突袭';
  if (diff === 1) return '明天 ' + hm + ' 突袭';
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + hm + ' 突袭';
}

/**
 * 面板 cfg → 运行时 cfg（硬契约：`core/registry.js` 的 applyFeature 对每个 reactor 功能无条件调它）。
 * 未声明键不透传（历史残留不进运行时）；数值做区间钳制，派兵提前量至少 1 分钟（用户口径：别提前压队列）。
 * @param {object} c 面板合并后配置
 * @returns {object}
 */
function normalizeCfg(c) {
  var o = c || {};
  var lead = Math.round(Number(o.leadMin) || 0);
  var preset = Math.round(Number(o.preset) || 0);
  return {
    enabled: !!o.enabled,
    autoDispatch: o.autoDispatch !== false,
    preset: preset >= 1 && preset <= 8 ? preset : 1,
    leadMin: lead >= 1 && lead <= 30 ? lead : 2,
    claim: o.claim !== false,
  };
}

// ── 注册 ──────────────────────────────────────────────────────────────
reactor.register({
  id: FEAT_ID,
  label: '猛犸突袭',
  storageKey: 'pocketcc.feat.cq26_mammoth',
  // dataCenter 硬依赖（serverTime 是派兵窗口基准）；坐标走 ACL 投影 cq26DbTowerPos，
  //   拿不到时自带 22002/22003/22008 推送的纯报文回落副本，故不作为符号依赖声明
  symbols: ['dataCenter'],
  // 与 cq26 家族同口径：靠 2171 权威读 + 902 定向出网，不依赖人真站在印石图里
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 面板可用性：活动未开启时整卡置灰（只影响面板观感，运行期仍由 run 内的活动闸把关）
  available: () => (gameData.cq26IsOpen() ? true : { ok: false, reason: 'CQ26 印石活动未开启' }),
  // 驻防真实占用行军队列 ⇒ 战斗模式强制下线（同 wl-mine 采集腿口径）
  offInCombat: true,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  version: 1,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
