/**
 * 沙盘演习每日最多五次（默认关闭， homeland，单链，真实 UI 战斗链）。
 *
 * 协议/链路（公开 H5 源码实证）：
 *   1661 ARENA_PVE_MAIN_REQUEST，V1 NET.send，{} → d JSON 串，time 为服务器权威剩余次数。
 *   挑战由真实 UI 生成：ArenaTablePvePanel.onChanllengeClick 恢复 PVE 军队/英雄并打开
 *   NBattleMain；NBattleEmPanelNew.StartFight 经 RealNBattleModel 生成实际 payload 后发
 *   1660（旧）或 3223（新）。本功能绝不读取 UserData.Armys/Heros 自行拼装。
 *   完成以 NBattle_Result 打开沙盘结算面板为准，再关闭本功能打开的结算页并重查 1661。
 *
 * 安全：challenge=1 无尽模式拒绝；真实 attackers 为空拒绝；原生陷阱确认弹窗不绕过。
 * StartFight 返回不等于请求上线：只有 ctx.on.req 观察到 1660/3223 才视为已发，并按 Event.reqTime
 * 精确配对应答。未发包不计数；拒绝不计数；请求已发但应答未知时只用 1661 核对余额，余额未下降绝不重发。
 * 每次激活最多主动发起 5 次，服务器 time 为最终余额，time=0 或已确认消耗五次才落 UID 日戳。
 * 空/拒绝/CODE_NOT_SENT 不谎报完成；刷新后无法证明归属的结算页不关闭、也不在其上叠开新挑战。
 */
import { CODE_NOT_SENT, parseData, rejectText, sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { dailyText } from '../../../core/daily-stats.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';
import { sandboxArena } from './api.js';
import {
  CMD_SANDBOX_INFO,
  CMD_SANDBOX_FIGHT,
  CMD_SANDBOX_FIGHT_NEW,
  DAILY_CHALLENGE_LIMIT,
} from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('SANDBOX-DRILL');
/** @type {number} 战斗/结算等待与发起后的观察间隔（毫秒） */
const POLL_MS = 5000;
/** @type {number} 查询失败/业务拒绝后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 瞬态未发出的短重试（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {number} UI 异步打开沙盘面板的等待（毫秒） */
const PANEL_LOAD_MS = 1500;
/** @type {string} UID 隔离运行数据中的每日已解决日戳键 */
const STAMP_KEY = 'sandboxDrill.resolved';
/** @type {number} 本地哨兵：1661 应答缺少 time */
const MALFORMED_RESPONSE = -2;

/** @type {object|null} pocketcc.net */
var net = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 今日已解决对应的下一服务器日界 */
var resolvedResetTs = 0;
/** @type {number} 当前内存态所属的下一服务器日界；跨日重置 attempts/ours/未知请求闸 */
var activeResetTs = 0;
/** @type {number} 今日已由应答或服务器余额确认消耗的次数（拒绝/未发包不计） */
var attempts = 0;
/** @type {boolean} 当前战斗/结算是否由本功能发起（避免关闭玩家手动打开的结算页） */
var ours = false;
/** @type {number} 观测到的原生挑战 req 总数 */
var nativeReqs = 0;
/** @type {boolean} 正在调用原生 StartFight；仅此窗口内的 req 才归属本功能 */
var nativeLaunchExpected = false;
/** @type {boolean} 本功能请求已上线，但尚未确认应答/余额消耗 */
var nativePending = false;
/** @type {boolean} 本次 nativePending 是否已计过 confirmed attempts */
var nativeCounted = false;
/** @type {number} 本功能最近一条原生 req 的 ts；0=尚未观察到 */
var ownNativeReqTs = 0;
/** @type {number[]} 原生 req ts 小窗，用于按 Event.reqTime 精确配对，不靠 FIFO 猜 */
var nativeReqTimes = [];
/** @type {number} 发起本次原生请求前的服务器剩余次数 */
var nativeRemainingBefore = 0;
/** @type {number|null} 最近一次与本功能 req 精确配对的原生挑战应答状态；未收到为 null */
var lastNativeStatus = null;
/** @type {Promise<void>|null} 首拍日戳回读 */
var stampLoad = null;

/** @returns {boolean} 当前激活是否存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * @param {AbortSignal|null} signal 本轮取消信号
 * @returns {boolean}
 */
function roundAlive(signal) {
  return aliveFn() && !(signal && signal.aborted);
}

/**
 * 睡到下一日界；时钟不可用退巡检。
 * @param {number} resetTs 下一服务器日界
 * @returns {number}
 */
function sleepToReset(resetTs) {
  var now = gameData.serverTime();
  return resetTs && now ? Math.max((resetTs - now) * 1000, 1000) : IDLE_TICK_MS;
}

/** 清掉一条原生请求的配对/未知闸；不动已确认次数与 UID 日戳。 */
function resetNativeAttempt() {
  nativeLaunchExpected = false;
  nativePending = false;
  nativeCounted = false;
  ownNativeReqTs = 0;
  nativeReqTimes = [];
  nativeRemainingBefore = 0;
  lastNativeStatus = null;
}

/**
 * 按服务器日界切换内存态；pause/resume 同日保留安全闸，跨日才清。
 * @param {number} now 当前服务器秒
 * @returns {number} 下一服务器日界；不可用为 0
 */
function syncDay(now) {
  var resetTs = gameData.nextDailyResetTs(now);
  if (resetTs && resetTs !== activeResetTs) {
    if (activeResetTs) resolvedResetTs = 0;
    activeResetTs = resetTs;
    attempts = 0;
    ours = false;
    resetNativeAttempt();
  }
  return resetTs;
}

/**
 * 关闭本功能刚打开/发起的沙盘准备页；已自行关闭视为成功，其余失败必须留痕。
 * @param {string} context 调用原因（日志定位）
 */
function closeOwnPreparation(context) {
  var closed = sandboxArena.closePreparation();
  if (!closed.ok && closed.reason !== 'battle-prep-not-open') {
    log.warn('sandbox close preparation skipped: context=%s reason=%s.', context, closed.reason);
  }
}

/**
 * 原生请求应答未知时只读 1661 对账；余额确实下降才放行下一轮，否则保持未知锁。
 * @param {AbortSignal|null} signal 本轮取消信号
 * @param {number} resetTs 本轮日界
 * @returns {Promise<{ok:boolean,confirmed:boolean,time:number,code:number}>}
 */
async function reconcileNative(signal, resetTs) {
  var cur = await fetchInfo();
  if (!roundAlive(signal)) return { ok: false, confirmed: false, time: -1, code: CODE_NOT_SENT };
  if (gameData.nextDailyResetTs() !== resetTs) {
    syncDay();
    return { ok: false, confirmed: false, time: -1, code: CODE_NOT_SENT };
  }
  if (!cur.ok) return { ok: false, confirmed: false, time: -1, code: cur.code };
  if (cur.time >= nativeRemainingBefore) {
    return { ok: true, confirmed: false, time: cur.time, code: 0 };
  }
  if (!nativeCounted) {
    attempts++;
    nativeCounted = true;
  }
  log.info(
    'sandbox native challenge consumption confirmed by cmd 1661: remaining %d -> %d.',
    nativeRemainingBefore,
    cur.time,
  );
  resetNativeAttempt();
  return { ok: true, confirmed: true, time: cur.time, code: 0 };
}

/** @returns {Promise<void>} 回读当日日戳 */
function loadStamp() {
  return storage.data
    .get(STAMP_KEY)
    .then(function (v) {
      var ts = Number(v && v.resetTs) || 0;
      var now = gameData.serverTime();
      if (ts > 0 && now > 0 && now < ts) {
        resolvedResetTs = ts;
        bus.emit(EVT.UI_REFRESH);
        log.debug('restored sandbox-drill day-stamp, resetTs=%d.', ts);
      }
    })
    .catch(function (err) {
      log.warn('cmd 1661 day-stamp load failed: %s', err && err.message);
    });
}

/**
 * @param {number} resetTs 下一日界
 */
function saveStamp(resetTs) {
  resolvedResetTs = resetTs;
  storage.data.set(STAMP_KEY, { resetTs: resetTs, claimed: true }).catch(function (err) {
    log.warn('cmd 1661 day-stamp persist failed: %s', err && err.message);
  });
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 查询服务器剩余次数，保留原始业务体供真实沙盘面板使用。
 * @returns {Promise<{ok:boolean,time:number,info:object|null,code:number,reason?:string}>}
 */
async function fetchInfo() {
  if (!net) return { ok: false, time: -1, info: null, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_SANDBOX_INFO,
    {},
    {
      protocol: 'send',
      onError: function (err) {
        log.warn('cmd 1661 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) {
    return {
      ok: false,
      time: -1,
      info: null,
      code: ret ? ret.code : CODE_NOT_SENT,
      reason: ret && ret.reason,
    };
  }
  var info = parseData(ret.data);
  var n = info && Number(info.time);
  if (!info || !Number.isFinite(n) || n < 0) {
    log.warn('cmd 1661 ack missing valid time.');
    return { ok: false, time: -1, info: null, code: MALFORMED_RESPONSE };
  }
  return { ok: true, time: Math.floor(n), info: info, code: 0 };
}

/**
 * cycle 单轮：结算/战斗闸 → 1661 → 真实开面板/准备/StartFight → 下一拍核对余额与结算。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (stampLoad) await stampLoad;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  if (!now) {
    log.debug('cmd 1661 idle: server clock unavailable.');
    return IDLE_TICK_MS;
  }
  var roundResetTs = syncDay(now);
  if (!roundResetTs) {
    log.debug('cmd 1661 idle: next daily reset unavailable.');
    return IDLE_TICK_MS;
  }
  if (resolvedResetTs > now) {
    log.debug('cmd 1661 skipped: today resolved until resetTs=%d.', resolvedResetTs);
    return sleepToReset(resolvedResetTs);
  }
  if (sandboxArena.resultPresent()) {
    if (!ours) {
      log.debug('sandbox result panel belongs to player/unknown session; leave it open and wait.');
      return POLL_MS;
    }
    if (nativePending && !nativeCounted) attempts++;
    if (!sandboxArena.closeResult()) {
      log.debug('sandbox result panel closed concurrently before closeResult.');
    }
    ours = false;
    resetNativeAttempt();
    log.debug('sandbox result panel closed; re-query remaining next round.');
    return 1000;
  }
  if (nativePending) {
    if (net && (net.isSending(CMD_SANDBOX_FIGHT) || net.isSending(CMD_SANDBOX_FIGHT_NEW))) {
      log.debug('sandbox waiting: native challenge request still in flight, no duplicate send.');
      return POLL_MS;
    }
    if (lastNativeStatus != null && lastNativeStatus !== 0) {
      log.info(
        'sandbox native challenge rejected: status=%s remainingBefore=%d; no attempt counted.',
        lastNativeStatus,
        nativeRemainingBefore,
      );
      closeOwnPreparation('native-challenge-rejected');
      ours = false;
      resetNativeAttempt();
      return TRANSIENT_RETRY_MS;
    }
    if (sandboxArena.battleActive()) {
      log.debug('sandbox waiting: native battle/preparation panel still active, no new challenge.');
      return POLL_MS;
    }
    if (lastNativeStatus === 0 && !nativeCounted) {
      attempts++;
      nativeCounted = true;
      log.info('sandbox native challenge accepted: status=0 confirmedAttempts=%d/5.', attempts);
    }
    var reconciled = await reconcileNative(signal, roundResetTs);
    if (!roundAlive(signal)) return 0;
    if (reconciled.confirmed) return 1000;
    if (!reconciled.ok) {
      log.warn(
        'sandbox native result reconciliation failed: code=%s; keep duplicate-send lock.',
        reconciled.code,
      );
    } else if (lastNativeStatus === 0) {
      log.debug(
        'sandbox accepted but cmd 1661 remaining=%d (before=%d); await result/server deduction.',
        reconciled.time,
        nativeRemainingBefore,
      );
    } else {
      log.warn(
        'sandbox native request has no matching response; remaining=%d (before=%d), keep duplicate-send lock.',
        reconciled.time,
        nativeRemainingBefore,
      );
    }
    return lastNativeStatus === 0 ? POLL_MS : TRANSIENT_RETRY_MS;
  }
  if (net && (net.isSending(CMD_SANDBOX_FIGHT) || net.isSending(CMD_SANDBOX_FIGHT_NEW))) {
    log.debug('sandbox waiting: native challenge request still in flight, no duplicate send.');
    return POLL_MS;
  }
  if (sandboxArena.battleActive()) {
    log.debug('sandbox waiting: native battle/preparation panel still active, no new challenge.');
    return POLL_MS;
  }
  if (attempts >= DAILY_CHALLENGE_LIMIT) {
    var doneReset = gameData.nextDailyResetTs(now);
    if (doneReset) saveStamp(doneReset);
    log.info(
      'sandbox daily challenge limit reached: attempts=%d/%d.',
      attempts,
      DAILY_CHALLENGE_LIMIT,
    );
    return sleepToReset(doneReset);
  }
  var cur = await fetchInfo();
  if (!roundAlive(signal)) return 0;
  if (gameData.nextDailyResetTs() !== roundResetTs) {
    syncDay();
    log.debug('cmd 1661 response crossed midnight; discard stale daily state.');
    return 1000;
  }
  if (!cur.ok) {
    if (cur.code === CODE_NOT_SENT) {
      log.warn('cmd 1661 transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    if (cur.code === MALFORMED_RESPONSE) return IDLE_TICK_MS;
    log.info(
      'cmd 1661 query rejected, retry later. code=%s;data=%s',
      cur.code,
      rejectText(cur) || '-',
    );
    return IDLE_TICK_MS;
  }
  if (cur.time <= 0) {
    saveStamp(roundResetTs);
    ours = false;
    log.info('sandbox daily challenges complete; server remaining=0.');
    return sleepToReset(roundResetTs);
  }
  var opened = sandboxArena.open(cur.info);
  if (!opened.ok) {
    log.warn('sandbox open skipped: reason=%s remaining=%d.', opened.reason, cur.time);
    return IDLE_TICK_MS;
  }
  await sleep(PANEL_LOAD_MS, signal);
  if (!roundAlive(signal)) return 0;
  var prepared = sandboxArena.prepare();
  if (!prepared.ok) {
    log.warn('sandbox prepare skipped: reason=%s remaining=%d.', prepared.reason, cur.time);
    return IDLE_TICK_MS;
  }
  await sleep(PANEL_LOAD_MS, signal);
  if (!roundAlive(signal)) return 0;

  // 先开观测窗再调原生按钮：req 在真实 send 成功后才派发，且可能与 StartFight 同步返回。
  nativeLaunchExpected = true;
  nativePending = true;
  nativeCounted = false;
  ownNativeReqTs = 0;
  nativeReqTimes = [];
  nativeRemainingBefore = cur.time;
  lastNativeStatus = null;
  var started = sandboxArena.start();
  nativeLaunchExpected = false;
  if (!ownNativeReqTs) {
    resetNativeAttempt();
    ours = false;
    if (!started.ok) {
      log.warn(
        'sandbox native start refused: reason=%s remaining=%d; no fabricated request.',
        started.reason,
        cur.time,
      );
    } else {
      log.warn(
        'sandbox StartFight returned but no native req was observed; remaining=%d, no attempt counted.',
        cur.time,
      );
    }
    closeOwnPreparation('native-request-not-observed');
    return TRANSIENT_RETRY_MS;
  }
  ours = true;
  if (!started.ok) {
    log.warn(
      'sandbox native start reported reason=%s after req was sent; keep result lock.',
      started.reason,
    );
  }
  log.info(
    'sandbox native challenge request observed; awaiting matching response; remaining before=%d.',
    cur.time,
  );
  return POLL_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  net = ctx.net;
  if (!net || !net.install()) {
    net = null;
    log.warn('install failed: pocketcc.net unavailable.');
    return false;
  }
  // req/resp 订阅必须放 run：reactor pause 会统一摘除 entry.triggers，install 只执行一次。
  log.info('installed; challenge payload comes only from native UI chain.');
  return true;
}

/**
 * 原生挑战发包观测：只记录当前 StartFight 窗口内真正上线的请求。
 * @param {{ts?:number}} ev net.req 事件
 */
function onNativeReq(ev) {
  nativeReqs++;
  if (!nativeLaunchExpected) return;
  var ts = Number(ev && ev.ts) || Date.now();
  if (ownNativeReqTs && ownNativeReqTs !== ts) {
    log.warn('sandbox duplicate native req observed in one StartFight: ts=%d.', ts);
  }
  ownNativeReqTs = ts;
  nativeReqTimes.push(ts);
  if (nativeReqTimes.length > 16) nativeReqTimes.shift();
}

/**
 * 按 Event.reqTime 选 ts <= reqTime 的最大 req，只有精确命中本功能请求才记应答状态。
 * @param {{reqTime?:number,status?:number}} ev net.resp 事件
 */
function onNativeResp(ev) {
  var reqTime = ev && ev.reqTime;
  var matched = 0;
  if (typeof reqTime === 'number') {
    for (var i = 0; i < nativeReqTimes.length; i++) {
      if (nativeReqTimes[i] <= reqTime && nativeReqTimes[i] > matched) matched = nativeReqTimes[i];
    }
  }
  if (!ownNativeReqTs || matched !== ownNativeReqTs) {
    log.debug(
      'sandbox ignored unmatched native response: reqTime=%s ownReqTs=%d matched=%d.',
      reqTime,
      ownNativeReqTs,
      matched,
    );
    return;
  }
  var status = ev && ev.status != null ? Number(ev.status) : NaN;
  // 非有限 status 不是业务拒绝：保持未知锁，只能靠 1661 余额下降解除，绝不据此重发。
  lastNativeStatus = Number.isFinite(status) ? status : null;
  log.debug(
    'sandbox native challenge response observed: status=%s reqTotal=%d.',
    lastNativeStatus,
    nativeReqs,
  );
}

/**
 * 每次激活重新登记原生 req/resp 观测；pause 时由 reactor 统一摘除。
 * @param {object} ctx reactor 上下文
 */
function subscribe(ctx) {
  ctx.on.req(CMD_SANDBOX_FIGHT, onNativeReq);
  ctx.on.req(CMD_SANDBOX_FIGHT_NEW, onNativeReq);
  ctx.on.resp(CMD_SANDBOX_FIGHT, onNativeResp);
  ctx.on.resp(CMD_SANDBOX_FIGHT_NEW, onNativeResp);
}

/** @param {object} ctx reactor 上下文 */
function run(ctx) {
  ctxRef = ctx;
  syncDay(gameData.serverTime());
  stampLoad = loadStamp();
  subscribe(ctx);
  log.info('started; daily limit=5, server time is authoritative.');
  cycle.kick();
}

reactor.register({
  id: 'sandboxDrill',
  label: '沙盘演习每日挑战',
  storageKey: 'pocketcc.feat.sandboxDrill',
  symbols: ['dataCenter', 'sandboxArena?', 'sandboxModel?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_sandboxInfo',
      type: 'text',
      label: '今日',
      get: function () {
        var done = resolvedResetTs > 0 && gameData.serverTime() < resolvedResetTs;
        return done ? dailyText(5, 5) : dailyText(attempts, DAILY_CHALLENGE_LIMIT);
      },
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
});

export { cycleRun, install as installForTest, run as runForTest, subscribe as subscribeForTest };
/** 单测专用：复位内存态，不启动 cycle。 */
export function resetForTest() {
  resolvedResetTs = 0;
  activeResetTs = 0;
  attempts = 0;
  ours = false;
  nativeReqs = 0;
  resetNativeAttempt();
  stampLoad = null;
}
/** 单测专用：发起日戳回读。 */
export function loadStampForTest() {
  stampLoad = loadStamp();
  return stampLoad;
}
