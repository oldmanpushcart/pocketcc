/**
 * 广告特权每日 x2（广告月卡有效期内全领，reactor 说明书形态，玩家基础设置，单链）
 *
 * 状态与协议（公开游戏客户端源码；未做账号登录抓包）：
 *   UserData.TimeCards 中 cardId=5003 为广告月卡，endTime>ServerTime 才在 ADRewardItem 中启用
 *   月卡免费入口与 x2 标记。游戏 getAdRewardAll 发送：
 *     9708 GET_ALL_AD_MONTH_CARD_REWARD，PBV2，空载荷 {}，一次领取当前全部 ready 奖励；
 *     应答 data={adMonthCardWatchInfos:[{adNewId,viewCount,lastViewTime}],reward:{items,resource}}。
 *   9706 GET_AD_MONTH_CARD_WATCH_INFO，PBV2，{} 读取服务器权威每日进度。
 *   与「广告领钻石」9707 逐槽领取不同，本功能刻意不按奖励种类过滤，覆盖钻石/体力/英雄/强化等全部 x2 档。
 *
 * 可领判据：公开客户端 MonthCardController.getAdRewardCount 以 times-viewCount 计算剩余次数，
 *   getAdRewardList 只按 level 过滤可见行；vip_level 仅用于月卡失效时的入口兜底，有效月卡不额外筛它。
 *   每行 remaining=times-viewCount>0 且 ServerTime>=floor(lastViewTime/1000)+cd 即 ready。
 *   广告月卡过期时不发 9706/9708；有 ready 才发一次 9708，由服务器统一裁决额外门槛。
 *
 * 防重领：9708 成功后用应答 adMonthCardWatchInfos 合并本地态；仅全部 capped 才落服务器日界日戳，
 *   仍有冷却槽时继续按 cd 排程，不能漏领后续档。真正业务拒绝落日戳避免逐拍敲门；
 *   CODE_NOT_SENT 短重试且不落日戳。日戳存 storage.data（UID 隔离），同日刷新后零发包；日界后自动解禁。
 */
import { CODE_NOT_SENT, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { bits, gameData, l10n } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { dailyText } from '../../../core/daily-stats.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';

import {
  CARD_ID_AD_MONTH_CARD,
  CMD_GET_AD_MONTH_CARD_WATCH_INFO,
  CMD_GET_ALL_AD_MONTH_CARD_REWARD,
} from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('AD-PRIVILEGE');
/** @type {string} AD_NEW 奖励配置表 */
const TABLE_AD_NEW = 'AD_NEW';
/** @type {number} 未生效/数据未就绪/业务拒绝巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 瞬态未发出短重试（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {number} cd 到点缓冲（毫秒） */
const READY_BUFFER_MS = 1000 * 3;
/** @type {number} 单睡上界（毫秒）；本地读零发包，防超长定时器漂移 */
const WAIT_CAP_MS = IDLE_TICK_MS * 8;
/** @type {number} 择时下界（毫秒），防 cd=0 时空转 */
const MIN_WAKE_MS = 1000 * 5;
/** @type {number} 日界缓冲（毫秒） */
const DAY_ROLL_BUFFER_MS = 1000 * 60;
/** @type {string} UID 隔离运行数据中的当日已解决日戳键 */
const STAMP_KEY = 'adPrivilege.resolved';
/** @type {number} 本地哨兵：9706 应答畸形，区别于服务器业务拒绝 */
const MALFORMED_RESPONSE = -2;

/** @type {object|null} pocketcc.net 网络底座 */
var net = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {Map<number,{viewCount:number,lastSec:number}>} 9706/9708 权威槽位态 */
var stateById = new Map();
/** @type {boolean} 是否成功读过服务器进度 */
var infoReady = false;
/** @type {number} 今日已解决对应的下一服务器日界 */
var resolvedResetTs = 0;
/** @type {Promise<void>|null} 首拍等待的日戳回读 */
var stampLoad = null;

/**
 * @returns {boolean} 当前 reactor 功能是否仍存活
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 本轮是否仍属于当前激活代次；pause 后即使 resume，旧 signal 也不会复活。
 * @param {AbortSignal|null} signal 本轮开始时捕获的取消信号
 * @returns {boolean}
 */
function roundAlive(signal) {
  return aliveFn() && !(signal && signal.aborted);
}

/**
 * 当前等级可见的 AD_NEW 全奖励槽位（不筛钻石/buff）。
 * @returns {{id:number,times:number,cd:number}[]}
 */
function slots() {
  var rows = l10n.tableRows(TABLE_AD_NEW);
  var level = gameData.level();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var id = Number(r.id) || 0;
    var times = Number(r.times) || 0;
    if (!id || times <= 0) continue;
    if (Number(r.level) > 0 && level < Number(r.level)) continue;
    out.push({ id: id, times: times, cd: Number(r.cd) || 0 });
  }
  return out;
}

/**
 * 合并本地槽位态；lastViewTime 是 Int64 毫秒时刻，按 bits 的时间戳特例读 Number。
 * 9706 整表覆盖，9708 只合并应答携带的槽位，避免丢掉未返回槽位的进度。
 * @param {*} list 应答 adMonthCardWatchInfos
 * @param {boolean} replace 是否整表覆盖
 * @returns {Set<number>} 应答实际携带的槽位 ID
 */
function applyInfo(list, replace) {
  var next = replace ? new Map() : new Map(stateById);
  var seen = new Set();
  if (Array.isArray(list)) {
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var id = Number(it.adNewId) || 0;
      if (!id) continue;
      seen.add(id);
      next.set(id, {
        viewCount: Number(it.viewCount) || 0,
        lastSec: Math.floor(bits.int64ToNum(it.lastViewTime) / 1000),
      });
    }
  }
  stateById = next;
  infoReady = true;
  return seen;
}

/**
 * 9708 成功但应答漏带某槽位时，对发包前仍 ready 的槽位做一次乐观推进，
 * 防止同拍误判仍可领而连发；下一轮 9706 会以服务器权威态校正。
 * @param {{id:number,times:number,cd:number}[]} list 槽位
 * @param {Set<number>} returned 应答携带的槽位 ID
 * @param {number} now 服务器秒
 */
function applyMissingClaim(list, returned, now) {
  for (var i = 0; i < list.length; i++) {
    var slot = list[i];
    if (returned.has(slot.id) || slotState(slot, now).state !== 'ready') continue;
    var st = stateById.get(slot.id);
    stateById.set(slot.id, {
      viewCount: (st ? st.viewCount : 0) + 1,
      lastSec: now,
    });
  }
}

/**
 * 单槽位 ready/wait/capped。
 * @param {{id:number,times:number,cd:number}} slot 槽位
 * @param {number} now 服务器秒
 * @returns {{state:string,waitSec?:number}}
 */
function slotState(slot, now) {
  var st = stateById.get(slot.id);
  var used = st ? st.viewCount : 0;
  if (used >= slot.times) return { state: 'capped' };
  var readyAt = (st ? st.lastSec : 0) + slot.cd;
  if (now < readyAt) return { state: 'wait', waitSec: readyAt - now };
  return { state: 'ready' };
}

/**
 * 全槽位进度摘要。
 * @param {{id:number,times:number,cd:number}[]} list 槽位
 * @returns {{done:number,total:number,ready:boolean,waitSec:number}}
 */
function progress(list) {
  var done = 0;
  var total = 0;
  var ready = false;
  var waitSec = 0;
  var now = gameData.serverTime();
  for (var i = 0; i < list.length; i++) {
    var slot = list[i];
    var st = stateById.get(slot.id);
    done += Math.min(st ? st.viewCount : 0, slot.times);
    total += slot.times;
    var s = slotState(slot, now);
    if (s.state === 'ready') ready = true;
    if (s.state === 'wait' && (!waitSec || s.waitSec < waitSec)) waitSec = s.waitSec;
  }
  return { done: done, total: total, ready: ready, waitSec: waitSec };
}

/**
 * 睡到下一服务器日界；时钟缺失退巡检，最长 26 小时。
 * @returns {number} 毫秒
 */
function dayRollDelay() {
  var next = gameData.nextDailyResetTs();
  var now = gameData.serverTime();
  if (!next || !now) return IDLE_TICK_MS;
  return Math.min(
    Math.max((next - now) * 1000 + DAY_ROLL_BUFFER_MS, IDLE_TICK_MS),
    1000 * 60 * 60 * 26,
  );
}

/**
 * 按全奖励态择时；wait 若跨日则截到日界，避免错过重置。
 * @param {{id:number,times:number,cd:number}[]} list 槽位
 * @returns {number} 毫秒
 */
function delayFor(list) {
  var p = progress(list);
  if (!p.total) return IDLE_TICK_MS;
  if (p.ready) return MIN_WAKE_MS;
  if (p.done >= p.total) return dayRollDelay();
  var ms = Math.min(Math.max(p.waitSec * 1000 + READY_BUFFER_MS, MIN_WAKE_MS), WAIT_CAP_MS);
  var next = gameData.nextDailyResetTs();
  if (next) ms = Math.min(ms, (next - gameData.serverTime()) * 1000 + DAY_ROLL_BUFFER_MS);
  return Math.max(ms, MIN_WAKE_MS);
}

/**
 * 直发 9706 拉权威进度，整表覆盖。
 * @returns {Promise<{ok:boolean,code:number,reason?:string}>}
 */
async function fetchInfo() {
  if (!net) return { ok: false, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_GET_AD_MONTH_CARD_WATCH_INFO,
    {},
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        log.warn('cmd 9706 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok)
    return { ok: false, code: ret ? ret.code : CODE_NOT_SENT, reason: ret && ret.reason };
  if (!ret.data || !Array.isArray(ret.data.adMonthCardWatchInfos)) {
    log.warn('cmd 9706 ack has no adMonthCardWatchInfos.');
    return { ok: false, code: MALFORMED_RESPONSE };
  }
  applyInfo(ret.data.adMonthCardWatchInfos, true);
  return { ok: true, code: 0 };
}

/**
 * 直发 9708 全领当前 ready 奖励，并用应答进度合并本地态。
 * @returns {Promise<{ok:boolean,claimed:boolean,code:number,reason?:string}>}
 */
async function claimAll() {
  if (!net) return { ok: false, claimed: false, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_GET_ALL_AD_MONTH_CARD_REWARD,
    {},
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        log.warn('cmd 9708 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok)
    return {
      ok: false,
      claimed: false,
      code: ret ? ret.code : CODE_NOT_SENT,
      reason: ret && ret.reason,
    };
  var returned = new Set();
  if (ret.data && Array.isArray(ret.data.adMonthCardWatchInfos))
    returned = applyInfo(ret.data.adMonthCardWatchInfos, false);
  else log.warn('cmd 9708 ack has no adMonthCardWatchInfos; use optimistic slot state.');
  applyMissingClaim(slots(), returned, gameData.serverTime());
  var reward = (ret.data && ret.data.reward) || {};
  var items = Array.isArray(reward.items) ? reward.items.length : 0;
  log.info('ad privilege x2 rewards claimed (items=%d).', items);
  return { ok: true, claimed: true, code: 0 };
}

/**
 * cycle 单轮：日戳 → 广告月卡有效期 → 表/9706 → 有 ready 发 9708 → 落日戳择时。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  if (stampLoad) await stampLoad;
  if (!roundAlive(signal)) return 0;
  var now = gameData.serverTime();
  if (!now) {
    log.debug('cmd 9706/9708 idle: server time unavailable.');
    return IDLE_TICK_MS;
  }
  if (resolvedResetTs > now) {
    log.debug('cmd 9706/9708 skipped: today resolved until resetTs=%d.', resolvedResetTs);
    return dayRollDelay();
  }
  var card = gameData.monthlyCard(CARD_ID_AD_MONTH_CARD);
  if (!card || now >= card.endTime) {
    log.debug('cmd 9706/9708 skipped: cardId=%d inactive or expired.', CARD_ID_AD_MONTH_CARD);
    return IDLE_TICK_MS;
  }
  if (!l10n.tableReady()) {
    log.debug('cmd 9706/9708 idle: AD_NEW table not ready.');
    return IDLE_TICK_MS;
  }
  var list = slots();
  if (!list.length) {
    log.debug('cmd 9706/9708 idle: no visible AD_NEW slots at level=%d.', gameData.level());
    return IDLE_TICK_MS;
  }
  var roundResetTs = gameData.nextDailyResetTs(now);
  if (!roundResetTs) {
    log.debug('cmd 9706/9708 idle: next daily reset unavailable.');
    return IDLE_TICK_MS;
  }

  var info = await fetchInfo();
  if (!roundAlive(signal)) return 0;
  // 查询跨越午夜时丢弃旧日进度，下一拍重读，避免把昨日 viewCount 当今日额度。
  if (gameData.nextDailyResetTs() !== roundResetTs) {
    log.debug('cmd 9706 response crossed midnight; discard stale daily progress.');
    return 1000;
  }
  if (!info.ok) {
    if (info.code === CODE_NOT_SENT) {
      log.warn('cmd 9706 transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    if (info.code === MALFORMED_RESPONSE) return IDLE_TICK_MS;
    log.info(
      'cmd 9706 ad-privilege info rejected, poll later. code=%s;data=%s',
      info.code,
      rejectText(info) || '-',
    );
    return IDLE_TICK_MS;
  }
  var p = progress(list);
  if (!p.ready) {
    if (p.done >= p.total) {
      resolvedResetTs = roundResetTs;
      saveStamp(false);
    }
    log.debug('cmd 9708 waiting: done=%d/%d, nextWaitSec=%d.', p.done, p.total, p.waitSec);
    return delayFor(list);
  }

  var ret = await claimAll();
  var paused = !roundAlive(signal);
  if (!ret.ok) {
    if (ret.code === CODE_NOT_SENT) {
      if (paused) return 0;
      log.warn('cmd 9708 transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    if (gameData.nextDailyResetTs() !== roundResetTs) {
      log.debug('cmd 9708 rejection crossed midnight; discard stale day-stamp.');
      return paused ? 0 : 1000;
    }
    resolvedResetTs = roundResetTs;
    saveStamp(false);
    if (paused) return 0;
    log.info(
      'cmd 9708 ad-privilege claim rejected, retry after midnight. code=%s;data=%s',
      ret.code,
      rejectText(ret) || '-',
    );
    return dayRollDelay();
  }
  // 9708 只领当前 ready；若其余槽位仍在冷却，必须继续按 cd 排程，不能整日封存。
  // 回执跨午夜时先丢弃旧日结果，不能把昨日 capped/拒领取记成次日已解决。
  if (gameData.nextDailyResetTs() !== roundResetTs) {
    log.debug('cmd 9708 response crossed midnight; discard stale daily result.');
    return paused ? 0 : 1000;
  }
  var after = progress(list);
  if (after.done >= after.total) {
    resolvedResetTs = roundResetTs;
    saveStamp(true);
  }
  if (paused) return 0;
  return delayFor(list);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 回读当日日戳。
 * @returns {Promise<void>}
 */
function loadStamp() {
  return storage.data
    .get(STAMP_KEY)
    .then(function (v) {
      var ts = Number(v && v.resetTs) || 0;
      var now = gameData.serverTime();
      if (now > 0 && ts > now) {
        resolvedResetTs = ts;
        bus.emit(EVT.UI_REFRESH);
      }
    })
    .catch(function (err) {
      log.warn('ad-privilege day-stamp load failed: %s', err && err.message);
    });
}

/**
 * 落盘当日已解决日戳。
 * @param {boolean} claimed 是否领成
 */
function saveStamp(claimed) {
  storage.data
    .set(STAMP_KEY, { resetTs: resolvedResetTs, claimed: !!claimed })
    .catch(function (err) {
      log.warn('ad-privilege day-stamp save failed: %s', err && err.message);
    });
  bus.emit(EVT.UI_REFRESH);
}

/**
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  net = ctx.net;
  if (!net || !net.install()) {
    net = null;
    log.warn('install failed: pocketcc.net unavailable');
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  stateById = new Map();
  infoReady = false;
  resolvedResetTs = 0;
  stampLoad = loadStamp();
  log.info('started.');
  cycle.kick();
}

reactor.register({
  id: 'adPrivilege',
  label: '广告特权每日x2',
  storageKey: 'pocketcc.feat.adPrivilege',
  symbols: ['dataCenter', 'tableManager', 'tableName'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_adPrivilegeInfo',
      type: 'text',
      label: '今日',
      get: function () {
        var now = gameData.serverTime();
        var card = gameData.monthlyCard(CARD_ID_AD_MONTH_CARD);
        if (!now || !card || now >= card.endTime) return '未生效';
        if (!infoReady) return '—';
        var p = progress(slots());
        if (!p.total) return '—';
        return dailyText(p.done, p.total);
      },
    },
  ],
  toModuleCfg: function (c) {
    return { enabled: !!(c && c.enabled) };
  },
  install: install,
  run: run,
});

export { cycleRun, install as installForTest };
/** 单测专用：复位内存态，不启动 cycle。 */
export function resetForTest() {
  stateById = new Map();
  infoReady = false;
  resolvedResetTs = 0;
  stampLoad = null;
}
/** 单测专用：发起日戳回读。 */
export function loadStampForTest() {
  stampLoad = loadStamp();
  return stampLoad;
}
