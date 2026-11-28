/**
 * 联盟保卫战（allianceDefender）：开战前 5 分钟单兵驻防 + 结束后三奖批量领取（个人/联盟/排行）。
 *
 * 玩法（源码 `AllianceDefense` / `prefabActivitydefenderMonster` 组件族 + i18n `defend_alliance_*`）：
 *   联盟管理选定开战时刻（邮件只通知、不含具体时刻），到点服务器逐波攻打联盟驻防点。
 *   参与 = 把自己的部队派到驻防点（902 marchType30 驻防行军，**不是**加入集结 1204）。
 *   奖励三组：targetType42 个人积分（defend_alliance_01，8 档）/ targetType47 联盟累计（defend_alliance_02，16 档）/
 *   排行奖（联盟积分排名，独立协议 1355，活动结束后才放出）。
 *
 * 用户口径（硬约束）：
 *   - 派兵 = 开战前 5 分钟派一个单兵（无英雄、无军阵、最低等级部队 ×1），迟到可补派；
 *   - 领奖 = 保卫战结束后**个人 + 联盟 + 排行三个奖励都领**（2026-11-16 用户补口径：排行奖原被排除，
 *     实证手动 1355 可领且 redDot[43] 服务器权威，改为自动领；排行奖只在活动结束后放出，battleOver 闸天然对齐）；
 *   - 面板纯 checkbox，不需玩家指定任何参数。
 *
 * 协议清单（载荷形态逐键抄自实录，标注见 constants.js）：
 *   1353 GET_ALLIANCE_DISPLAY_TIME req `{}` resp `{st,et,det,siegeStatus,actSpec,redDot}`
 *        —— st 活动开始 / et 活动展示结束（**非战斗结束**）/ det 领奖截止；actSpec 是 POJO 枚举读不到 id；
 *        redDot[42]=个人可领档数（领后归 0），**redDot[47] 实证全程不出现**（联盟奖不能以红点为闸）。
 *   841  GET_ACTIVITY_DATA —— 活动感知归 core/activity-hub（全仓共享快照）：取 type26 条目：`.id`=活动 aid、`.alMonsterSiege`=战斗快照。
 *        startTime 开战前数小时即暴露（实证提前 1838s），派兵窗口据此提前锚定。
 *   1792 ACTIVITY_GET_REWARD req `{aid,type}` —— type42 个人 / type47 联盟，均**批量**一次领完该组全部可领行。
 *   1355 AWARD_AL_MONSTER_SIEGE_RANK req `{}` —— 排行奖（联盟积分排名），活动结束后放出，redDot[43]>0 为闸。
 *   11104 push ALLIANCE_MONSTER_SIEGE_INFO `{alMonsterSiege}` —— 战斗态实时合并源 + 唤醒源（isEnd/endTime 收尾）。
 *   10007 push MARCH_INFO —— 驻防 type30 生命周期**只走这条**（856/10019 对 type30 全盲），联盟广播须按 uid 过滤。
 *   902  MARCH_WORLD_POINT marchType30 —— 走 core/march.attack() 组 canonical body（minimal 单兵）。
 *
 * 关键纠错（实录对拍定稿，详见 .reviewtmp/adp/probe-rec*.cjs）：
 *   1 1353/841 只有 NetMgr 内联回调、无全局 handler → 自查询不刷游戏内存，feat 自查询自解析维护本地 SNAP（841 现由 activity-hub 代发共享）；
 *   2 aid 只能从 841 type26.id 取（1353 actSpec 读不到、11104 的 aid 是联盟 ID 非活动 ID）；
 *   3 战斗结束判据 = siege.isEnd==1 || siege.endTime>0（et 是展示结束，晚于战斗结束数小时，仅作兜底）；
 *   4 派兵锚点 = siege.startTime − 300（不是活动 st）；
 *   5 type30 占位/边沿自订 10007（uid+marchType30 过滤），不用 march.list/onStateChange（对 type30 全盲）。
 *
 * 闸门判据（按序短路）：
 *   派兵腿：siege.startTime>0 && 未结束 && targetId>0 && now≥startTime−300 && 本轮未封顶 && 无冷却 &&
 *           无本人 type30 在场（10007 本地跟踪）&& march.canMarch(1) && 坐标可解码 && minimal 能出兵。
 *   领奖腿：battleOver && now<det && aid>0；type42 以 redDot42>0 为闸；type47 无红点、每场 latch+冷却重试；
 *           排行奖以 redDot43>0 为闸（1355 无参数，同 latch+冷却重试）。
 *
 * 触发源：createCycle 档位择时 + ctx.on.push(11104) 战斗态唤醒 + ctx.on.push(10007) 驻防返航/到家边沿补派。
 *
 * 报文实证 dashcam-rec-20261115T183001-14179309129759-1794738601093.part.ndjson（一场完整保卫战 + 双 type 领奖）。
 */
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { gameData, bits } from '../../../core/game-api.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';
import { createCycle } from '../../../core/cycle.js';
import { createDailyLedger } from '../../../core/daily-stats.js';
import { activityHub } from '../../../core/activity-hub.js';
import { CODE_NOT_SENT, parseData, rejectText } from '../../../core/util.js';

import { defenderApi } from './api.js';
import {
  CMD_GET_ALLIANCE_DISPLAY_TIME,
  CMD_ACTIVITY_GET_REWARD,
  CMD_AWARD_SIEGE_RANK,
  CMD_PUSH_ALLIANCE_MONSTER_SIEGE,
  CMD_PUSH_MARCH_INFO,
} from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('ALLIANCE_DEFENDER');

/** @type {string} reactor 功能 id（面板挂载见 core/menu.js 联盟基础设置组） */
const FEAT_ID = 'allianceDefender';

/** @type {number} 活动 type（实证 841 alist / hub 快照 type26） */
const ACTIVITY_TYPE = 26;
/** @type {number} 902 的 marchType：保卫战驻防（实证 marchType30） */
const MARCH_TYPE_DEFEND = 30;
/** @type {number} 1792 个人积分奖励 type（targetType42，defend_alliance_01） */
const REWARD_PERSONAL = 42;
/** @type {number} 1792 联盟累计奖励 type（targetType47，defend_alliance_02） */
const REWARD_ALLIANCE = 47;
/** @type {number} 排行奖（联盟积分排名，独立协议 1355；复用领奖记账骨架的 type 标识，非 1792 参数） */
const REWARD_RANK = 43;

/** @type {number} 派兵提前量（秒）：开战前 5 分钟（用户口径） */
const LEAD_SEC = 300;
/** @type {number} 同一场最多派几次（驻防被打光后补派用；封顶防逐拍撞队列） */
const MAX_DISPATCH = 5;
/** @type {number} 同一场单 type 领奖最多试几次（被拒多为「无可领」，封顶防刷屏） */
const MAX_CLAIM_TRIES = 3;
/** @type {number} 派兵/领奖被拒后的冷却毫秒 */
const REJECT_COOL_MS = 60 * 1000;
/** @type {number} 两次 1353 读 / hub 补扫 841 的最小间隔毫秒（领奖相强制每拍刷 redDot，不受此闸） */
const READ_GAP_MS = 60 * 1000;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入；本 feat 仅 enabled） */
var MCFG = { enabled: false };
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {function():void|null} hub 引用计数 detach（pause 释放） */
var detachHub = null;

/**
 * @typedef {object} AdpSnap
 * @property {number} st 活动开始（服务器秒）
 * @property {number} et 活动展示结束（服务器秒，非战斗结束）
 * @property {number} det 领奖截止（服务器秒）
 * @property {number} siegeStatus 1353 展示状态（2→3）
 * @property {number} redDot42 个人积分可领档数（领后归 0）
 * @property {number} redDot47 联盟红点（实证恒 0，仅防御性解析）
 * @property {number} redDot43 排行奖可领标记（活动结束后出现，领后不再下发）
 * @property {number} aid 活动 aid（841 type26.id，1792 领奖用）
 * @property {object|null} siege 战斗快照（841 播种 + 11104 实时合并）
 */
/** @type {AdpSnap|null} 本地权威快照（1353/841 自解析 + 11104 合并；null=尚未读达） */
var SNAP = null;
/** @type {number} 上次成功读达 1353 的本地毫秒 */
var lastRead1353 = 0;
/** @type {number} 上次因快照缺 type26 而请求 hub 补扫 841 的本地毫秒（失败也推进，兜住重试频率） */
var lastRead841 = 0;

/** @type {string} 当前场次键（siege.startTime）；换场即复位派兵/领奖记账 */
var curKey = '';
/** @type {number} 本场已派次数 */
var dispatchTries = 0;
/** @type {number} 派兵冷却到期时刻（Date.now() 基准） */
var coolUntilMs = 0;
/** @type {{done:boolean,tries:number,cool:number}} 本场个人奖（type42）记账 */
var claim42 = { done: false, tries: 0, cool: 0 };
/** @type {{done:boolean,tries:number,cool:number}} 本场联盟奖（type47）记账 */
var claim47 = { done: false, tries: 0, cool: 0 };
/** @type {{done:boolean,tries:number,cool:number}} 本场排行奖（1355）记账 */
var claim43 = { done: false, tries: 0, cool: 0 };
/** @type {Map<string,number>} 本人 type30 行军 marchId→state（10007 本地跟踪，占位闸） */
var ownMarches = new Map();

/** @type {boolean} 本拍刚派兵（择时切到点复核档） */
var justDispatched = false;
/** @type {boolean} 本拍刚领奖成功（择时切短巡补领另一 type） */
var justClaimed = false;
/** @type {boolean} 派兵窗口已到且仍待动手（择时切短巡档） */
var pendingDispatch = false;
/** @type {number} legs 写就的「下一次值得醒来的服务器秒」（0=无指定） */
var wakeAtSec = 0;
/** @type {boolean} 「坐标解不出」warn 去重（恢复后复位） */
var posWarned = false;

/**
 * 今日动作日账（派兵 / 个人领奖 / 联盟领奖 / 排行领奖各一键，经 inlineStatus 内联到开关行）。
 * @type {import('../../../core/daily-stats.js').DailyLedger}
 */
const dailyLedger = createDailyLedger('pocketcc.daily.allianceDefender');

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（判据全来自 1353/841 读与推送，安装期不发任何请求）。
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
 * 运行：订阅 11104 战斗态 + 10007 驻防行军广播 + 点火（push 退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  if (detachHub) detachHub();
  // 841 感知归 activity-hub：本 feat 无周期刷新需求，scanIntervalMs=0 只声明共享引用
  detachHub = activityHub.attach({ label: FEAT_ID, scanIntervalMs: 0 });
  ctx.on.push(CMD_PUSH_ALLIANCE_MONSTER_SIEGE, onSiegePush);
  ctx.on.push(CMD_PUSH_MARCH_INFO, onMarchInfoPush);
  dailyLedger.ensureLoaded();
  log.info('started, listening push=%d,%d.', CMD_PUSH_ALLIANCE_MONSTER_SIEGE, CMD_PUSH_MARCH_INFO);
  cycle.kick();
}

/**
 * 停用：丢掉不该跨暂停持有的陈旧判据（快照/占位/本拍决策位/场次记账），
 *   避免 resume 后拿上一场的 startTime/aid 去发写请求。日账保留。
 */
function pause() {
  if (detachHub) {
    detachHub();
    detachHub = null;
  }
  SNAP = null;
  lastRead1353 = 0;
  lastRead841 = 0;
  curKey = '';
  dispatchTries = 0;
  coolUntilMs = 0;
  claim42 = { done: false, tries: 0, cool: 0 };
  claim47 = { done: false, tries: 0, cool: 0 };
  claim43 = { done: false, tries: 0, cool: 0 };
  ownMarches.clear();
  justDispatched = false;
  justClaimed = false;
  pendingDispatch = false;
  wakeAtSec = 0;
  posWarned = false;
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
 * 取业务体：net 已剥信封，ev.data 即内层业务体；仅做对象形态守卫。
 * @param {object} ev 推送事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o;
}

/**
 * 11104：战斗态推送。整体替换 siege 快照（每条都是全量），随即 kick 让 cycle 重判派兵/领奖。
 * @param {object} ev 推送事件
 */
function onSiegePush(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var sg = b.alMonsterSiege;
  if (!sg || typeof sg !== 'object') return;
  if (SNAP) SNAP.siege = normalizeSiege(sg);
  if (aliveFn()) cycle.kick();
}

/**
 * 10007：联盟行军广播（含他人）。只认本人 type30：state 1/11 记占位，3/4 清占位并 kick（补派）。
 *   驻防生命周期只走这条（856/10019 对 type30 全盲），故占位闸完全依赖此本地跟踪。
 * @param {object} ev 推送事件
 */
function onMarchInfoPush(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var mi = b.marchInfo || b; // 实证体扁平，兼容嵌套形态
  if (Number(mi.marchType) !== MARCH_TYPE_DEFEND) return;
  var my = gameData.myUidStr();
  if (!my || String(mi.uid) !== my) return;
  var id = mi.marchId != null ? String(mi.marchId) : '';
  if (!id) return;
  var st = Number(mi.state);
  if (st === 1 || st === 11) {
    ownMarches.set(id, st);
  } else if (st === 3 || st === 4) {
    if (ownMarches.delete(id)) {
      log.debug('10007 type30 returned state=%d id=%s, kick.', st, id);
      if (aliveFn()) cycle.kick();
    }
  }
}

// ── 快照：自查询自解析 ────────────────────────────────────────────────
/**
 * 服务器秒（派兵/领奖窗口以服务器钟为准）。读不到回 0（调用方本拍不动作）。
 * @returns {number}
 */
function serverNow() {
  return Math.floor(gameData.serverTime() || 0);
}

/**
 * 战斗态字段归一（841/11104 的 alMonsterSiege → 本地 siege）。
 * @param {object} g 报文 alMonsterSiege
 * @returns {object}
 */
function normalizeSiege(g) {
  return {
    startTime: Number(g.startTime) || 0,
    endTime: Number(g.endTime) || 0,
    isEnd: Number(g.isEnd) || 0,
    nextTime: Number(g.nextTime) || 0,
    targetId: Number(g.targetId) || 0,
    round: Number(g.round) || 0,
  };
}

/**
 * 战斗是否结束：isEnd==1 或 endTime>0 为权威；et（展示结束）仅作兜底（晚于战斗结束数小时）。
 * @param {AdpSnap} s 快照
 * @param {number} nowSec 服务器秒
 * @returns {boolean}
 */
function battleOver(s, nowSec) {
  var sg = s.siege;
  if (sg && (sg.isEnd === 1 || sg.endTime > 0)) return true;
  return s.et > 0 && nowSec >= s.et;
}

/**
 * 换场复位：siege.startTime 变化即清派兵/领奖记账与占位（每场独立，防跨场串账）。
 * @param {string} key 场次键（String(startTime)）
 */
function ensureBattle(key) {
  if (key === curKey) return;
  curKey = key;
  dispatchTries = 0;
  coolUntilMs = 0;
  claim42 = { done: false, tries: 0, cool: 0 };
  claim47 = { done: false, tries: 0, cool: 0 };
  claim43 = { done: false, tries: 0, cool: 0 };
  ownMarches.clear();
}

/**
 * 读一次 1353 并合并展示态（st/et/det/siegeStatus/redDot），保留 aid/siege。
 *   非 force 时受 READ_GAP_MS 闸；领奖相 force=true 每拍刷 redDot。
 * @param {boolean} force 是否绕过读闸
 * @returns {Promise<boolean>} true=本拍可继续（含沿用旧快照）；false=读失败需短巡重试
 */
async function readDisplayTime(force) {
  if (!net) {
    log.warn('net unavailable, skip 1353.');
    return false;
  }
  if (!force && SNAP && Date.now() - lastRead1353 < READ_GAP_MS) return true;
  if (net.isSending(CMD_GET_ALLIANCE_DISPLAY_TIME)) return !!SNAP;
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_GET_ALLIANCE_DISPLAY_TIME,
    {},
    {
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) return false;
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn('1353 not sent%s.', sendErr ? ' (threw: ' + sendErr + ')' : ' (gate/timeout)');
    return false;
  }
  if (!ret || !ret.ok) {
    // 活动未开：服务器拒绝，清快照转 idle（不是故障，info 带 code）
    log.info(
      '1353 rejected (activity closed?). code=%s reason=%s',
      ret ? ret.code : '?',
      rejectText(ret),
    );
    SNAP = null;
    return true;
  }
  var d = parseData(ret.data);
  if (!d || typeof d !== 'object') {
    log.warn('1353 ack malformed, ignore.');
    return false;
  }
  applyDisplay(d);
  lastRead1353 = Date.now();
  return true;
}

/**
 * 1353 应答 → 合并展示态（保留 841/11104 来的 aid/siege）。
 * @param {object} d 应答业务体
 */
function applyDisplay(d) {
  var red = d.redDot || {};
  var prev = SNAP || {};
  SNAP = {
    st: Number(d.st) || 0,
    et: Number(d.et) || 0,
    det: Number(d.det) || 0,
    siegeStatus: Number(d.siegeStatus) || 0,
    redDot42: Number(red['42']) || 0,
    redDot47: Number(red['47']) || 0,
    redDot43: Number(red['43']) || 0,
    aid: prev.aid || 0,
    siege: prev.siege || null,
  };
}

/**
 * 从 activity-hub 快照补 aid + siege（仅当缺失/未排期时调）。
 * 841 由 hub 代发并全仓共享（单飞 + 2s 最小间隔）；本函数只在快照缺 type26 条目时才请求补扫，
 * 且本地保留 READ_GAP_MS 闸，避免活动未上线期间每拍白打 841。
 * type26 条目字段：`.id`=活动 aid（1792 用）、`.alMonsterSiege`=战斗快照（startTime 开战前数小时即暴露）。
 * 10904 等推送可能只带 extra 而不含 alMonsterSiege，故快照命中但缺战斗态时保留 SNAP.siege 旧值，等 11104 推送合并。
 * @returns {Promise<boolean>} true=aid/siege 已就绪
 */
async function readActivityData() {
  var ready = !!(SNAP && SNAP.aid > 0 && SNAP.siege && SNAP.siege.startTime > 0);
  var hit = activityHub.getByType(ACTIVITY_TYPE);
  if (!hit) {
    if (Date.now() - lastRead841 < READ_GAP_MS) return ready;
    lastRead841 = Date.now();
    await activityHub.scan();
    if (!aliveFn()) return false;
    hit = activityHub.getByType(ACTIVITY_TYPE);
  }
  if (!hit) {
    log.debug('activity snapshot has no type26 entry (defender not in activity list).');
    return ready;
  }
  if (!SNAP) {
    SNAP = {
      st: 0,
      et: 0,
      det: 0,
      siegeStatus: 0,
      redDot42: 0,
      redDot47: 0,
      redDot43: 0,
      aid: 0,
      siege: null,
    };
  }
  SNAP.aid = Number(hit.id) || 0;
  if (hit.alMonsterSiege) SNAP.siege = normalizeSiege(hit.alMonsterSiege);
  return !!(SNAP.aid > 0 && SNAP.siege);
}

// ── 派兵腿 ────────────────────────────────────────────────────────────
/**
 * 驻防派兵（占 1 条行军队列）。锚定 siege.startTime−300，迟到可补派；任一闸门不过只打日志不动作。
 * @param {number} nowSec 服务器秒
 * @returns {Promise<void>}
 */
async function dispatchLeg(nowSec) {
  pendingDispatch = false;
  var s = SNAP;
  if (!s || !s.siege) return;
  var sg = s.siege;
  if (!(sg.startTime > 0)) return;
  if (sg.isEnd === 1 || sg.endTime > 0) {
    log.debug('battle over, no dispatch. isEnd=%d endTime=%d', sg.isEnd, sg.endTime);
    return;
  }
  if (!(sg.targetId > 0)) return;
  var at = sg.startTime - LEAD_SEC;
  if (nowSec < at) {
    wakeAtSec = Math.max(wakeAtSec, at);
    log.debug(
      'dispatch window opens in %ds (start=%d lead=%ds).',
      at - nowSec,
      sg.startTime,
      LEAD_SEC,
    );
    return;
  }
  pendingDispatch = true;
  if (dispatchTries >= MAX_DISPATCH) {
    pendingDispatch = false;
    log.debug('dispatch tries capped (%d) this battle, hold.', MAX_DISPATCH);
    return;
  }
  if (Date.now() < coolUntilMs) {
    log.debug('dispatch cooling after reject (%dms left).', coolUntilMs - Date.now());
    return;
  }
  // 占位闸：本人 type30 已在场（在途/驻防）就不重复占队列（10007 本地跟踪 + 902 受理乐观播种）
  if (ownMarches.size > 0) {
    pendingDispatch = false;
    log.debug('type30 already out (%d march), hold the slot.', ownMarches.size);
    return;
  }
  if (!march.canMarch(1)) {
    log.debug('no free march slot (used=%d), skip dispatch.', gameData.marchCount().used);
    return;
  }
  var pos = defenderApi.decodePointId(sg.targetId);
  if (!pos) {
    if (!posWarned) {
      posWarned = true;
      log.warn('target pos unreadable (stub/missing), cannot dispatch. targetId=%d', sg.targetId);
    }
    return;
  }
  posWarned = false;
  var plan = new Battle().plan().minimal().build();
  if (!plan.armyListNew || !plan.armyListNew.length) {
    log.info('no dispatchable troops (minimal), skip dispatch.');
    return;
  }
  dispatchTries++;
  var ret = await march.attack({
    marchType: MARCH_TYPE_DEFEND,
    target: { x: pos.x, y: pos.y },
    data: plan,
  });
  if (!aliveFn()) return;
  pendingDispatch = false;
  if (ret && ret.code === CODE_NOT_SENT) {
    coolUntilMs = Date.now() + REJECT_COOL_MS;
    log.warn('902(30) not sent (gate/send error). try=%d', dispatchTries);
    return;
  }
  if (!ret || !ret.ok) {
    coolUntilMs = Date.now() + REJECT_COOL_MS;
    log.info(
      '902(30) rejected. code=%s reason=%s try=%d',
      ret ? ret.code : '?',
      rejectText(ret),
      dispatchTries,
    );
    return;
  }
  justDispatched = true;
  var mi = (parseData(ret.data) || {}).marchInfo || {};
  // marchId 是 64 位雪花 id，按字符串读；乐观播种占位，10007 到达后确认/更新
  var mid = mi.marchId != null ? bits.int64Str(mi.marchId) : '';
  if (mid) ownMarches.set(mid, 1);
  dailyLedger.bump('dispatch', 1);
  log.info(
    'garrison dispatched. pos=%d,%d targetId=%d try=%d marchId=%s',
    pos.x,
    pos.y,
    sg.targetId,
    dispatchTries,
    mid || '?',
  );
}

// ── 领奖腿 ────────────────────────────────────────────────────────────
/**
 * 结束后三奖领取。type42 以 redDot42>0 为闸；type47 无红点、每场 latch+冷却重试；
 *   排行奖（1355）活动结束后才放出，以 redDot43>0 为闸（服务器权威，与游戏原版 1354 status==0 同效）。
 *   一拍最多发一条（各奖由 justClaimed 短巡自然隔开 ≥20s，规避同刻连发限流）。
 * @param {number} nowSec 服务器秒
 * @returns {Promise<void>}
 */
async function claimLeg(nowSec) {
  var s = SNAP;
  if (!s || !(s.aid > 0)) return;
  if (!battleOver(s, nowSec)) return;
  if (nowSec >= s.det) return;
  // 个人积分（redDot 权威闸）
  if (!claim42.done && s.redDot42 > 0) {
    var r = await tryClaim(REWARD_PERSONAL, claim42);
    if (r === 'ok') return; // 本拍已发一条，另一奖下拍再领
    if (r === 'reject') return;
  }
  // 联盟累计（无红点，battleOver 后试领）
  if (!claim47.done) {
    var r47 = await tryClaim(REWARD_ALLIANCE, claim47);
    if (r47 === 'ok' || r47 === 'reject') return;
  }
  // 排行奖（活动结束后放出，redDot43 权威闸；独立协议 1355 无参数）
  if (!claim43.done && s.redDot43 > 0) await tryClaim(REWARD_RANK, claim43);
}

/**
 * 发一条领奖请求并按结果记账：type42/47 走 1792 {aid,type}，排行奖走 1355 {}。永不 reject。
 * @param {number} type 42/47/43（43 仅作记账标识，非 1792 参数）
 * @param {{done:boolean,tries:number,cool:number}} st 该奖本场记账
 * @returns {Promise<'ok'|'reject'|'skip'>} ok=领到 / reject=发出但被拒或未发出 / skip=本拍不发
 */
async function tryClaim(type, st) {
  if (st.done) return 'skip';
  if (Date.now() < st.cool) return 'skip';
  if (st.tries >= MAX_CLAIM_TRIES) {
    st.done = true;
    log.debug('claim type=%d tries capped, nothing to claim this battle.', type);
    return 'skip';
  }
  var isRank = type === REWARD_RANK;
  var cmd = isRank ? CMD_AWARD_SIEGE_RANK : CMD_ACTIVITY_GET_REWARD;
  var body = isRank ? {} : { aid: SNAP.aid, type: type };
  if (!net || net.isSending(cmd)) return 'skip';
  var sendErr = '';
  var ret = await net.sendGuarded(cmd, body, {
    onError: function (err) {
      sendErr = (err && err.message) || String(err);
    },
  });
  if (!aliveFn()) return 'skip';
  if (ret && ret.code === CODE_NOT_SENT) {
    st.cool = Date.now() + REJECT_COOL_MS;
    log.warn(
      '%d type=%d not sent%s.',
      cmd,
      type,
      sendErr ? ' (threw: ' + sendErr + ')' : ' (gate/timeout)',
    );
    return 'reject';
  }
  if (!ret || !ret.ok) {
    st.tries++;
    st.cool = Date.now() + REJECT_COOL_MS;
    log.info(
      '%d type=%d rejected. code=%s reason=%s try=%d',
      cmd,
      type,
      ret ? ret.code : '?',
      rejectText(ret),
      st.tries,
    );
    if (st.tries >= MAX_CLAIM_TRIES) st.done = true;
    return 'reject';
  }
  st.done = true;
  justClaimed = true;
  dailyLedger.bump(type === REWARD_PERSONAL ? 'claim42' : isRank ? 'claim43' : 'claim47', 1);
  log.info('reward claimed. cmd=%d type=%d aid=%d', cmd, type, SNAP.aid);
  return 'ok';
}

// ── 调度 ──────────────────────────────────────────────────────────────
/**
 * 档位（毫秒）。主触发是 11104/10007 推送，轮询兜「漏推 + 到点复核」：
 *   activeMs 窗内短巡 / arriveMs 派兵后复核 / idleMs 无事长睡 / farMs 远窗哨兵 / backoffMs 抛错兜底。
 */
const cfg = {
  activeMs: 20 * 1000,
  arriveMs: 30 * 1000,
  idleMs: 30 * 60 * 1000,
  farMs: 30 * 60 * 1000,
  backoffMs: 60 * 1000,
};

/**
 * 领奖是否仍待办（battleOver && 窗内 && 有奖未领完）→ 择时切短巡。
 * @param {number} nowSec 服务器秒
 * @returns {boolean}
 */
function claimPending(nowSec) {
  var s = SNAP;
  if (!s || !(s.aid > 0) || !battleOver(s, nowSec) || nowSec >= s.det) return false;
  return (!claim42.done && s.redDot42 > 0) || !claim47.done || (!claim43.done && s.redDot43 > 0);
}

/**
 * 单拍：读快照 → 派兵腿 → 领奖腿 → 择时。
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
  var inA = gameData.inAlliance();
  if (inA === false) {
    log.debug('not in alliance, idle.');
    return cfg.idleMs;
  }
  var nowSec = serverNow();
  if (!(nowSec > 0)) {
    log.warn('server time unreadable, skip this pass.');
    return cfg.activeMs;
  }
  // 领奖相强制每拍刷 1353（redDot 权威）；其余受读闸
  var force = !!(SNAP && battleOver(SNAP, nowSec) && SNAP.det > 0 && nowSec < SNAP.det);
  var ok = await readDisplayTime(force);
  if (!aliveFn()) return cfg.activeMs;
  if (!ok) return cfg.activeMs;
  var s = SNAP;
  if (!s || !(s.st > 0)) {
    log.debug('no defender activity, idle.');
    return cfg.idleMs;
  }
  if (nowSec >= s.det) {
    log.debug('claim deadline passed (det=%d), idle.', s.det);
    return cfg.idleMs;
  }
  // 补 aid/siege（缺失或尚未排期 startTime=0 时）
  if (!(s.aid > 0) || !s.siege || !(s.siege.startTime > 0)) {
    await readActivityData();
    if (!aliveFn()) return cfg.activeMs;
    s = SNAP;
  }
  if (s && s.siege && s.siege.startTime > 0) ensureBattle(String(s.siege.startTime));
  await dispatchLeg(nowSec);
  if (!aliveFn()) return cfg.activeMs;
  await claimLeg(nowSec);
  if (!aliveFn()) return cfg.activeMs;
  if (justDispatched) return cfg.arriveMs;
  if (justClaimed) return cfg.activeMs;
  if (pendingDispatch) return cfg.activeMs;
  if (claimPending(nowSec)) return cfg.activeMs;
  if (wakeAtSec > nowSec) {
    var remSec = wakeAtSec - nowSec;
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
 * 面板 fields：单行只读今日进度（派兵 + 三奖领奖次数），纯 checkbox 无可调参数。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_adpInfo',
      type: 'text',
      label: '今日',
      get: function () {
        if (!dailyLedger.loaded()) return '—';
        var d = dailyLedger.get('dispatch');
        var c =
          dailyLedger.get('claim42') + dailyLedger.get('claim47') + dailyLedger.get('claim43');
        return '派兵 ' + d + ' 次 · 领奖 ' + c + ' 次';
      },
    },
  ];
}

// ── 注册 ──────────────────────────────────────────────────────────────
reactor.register({
  id: FEAT_ID,
  label: '联盟保卫战',
  storageKey: 'pocketcc.feat.allianceDefender',
  // dataCenter 硬依赖（serverTime 窗口基准）；gameTools 软依赖（坐标解码 stub 期降级为不派兵，仍可领奖）
  symbols: ['dataCenter', 'gameTools?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 驻防真实占用行军队列 ⇒ 战斗模式强制下线
  offInCombat: true,
  defaults: { enabled: false },
  fields: buildFields(),
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  version: 1,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
