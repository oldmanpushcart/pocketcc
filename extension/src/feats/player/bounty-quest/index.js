/**
 * 悬赏任务自动领取（每日任务奖励 + 进度宝箱，reactor 说明书形态，玩家基础设置）
 *
 * 状态与协议（公开游戏客户端源码；未做账号登录抓包）：
 *   UserData.DailyQuests 元素 Id/Num/State；QuestState.CAN_REWARD=1。
 *   UserData.dailyQuestBoxStateArray 索引 0 对应 boxId=1；DailyQuestBoxState.CAN_REWARD=1。
 *   任务一键领取：315 GET_DAILY_QUEST_REWAR_ALL，V1 send，{}；应答 d 为 JSON 串，含
 *     dailyQuestDelIds/newDailyQuests/dailyQuestFinishCount/box1..box4/reward。
 *   宝箱一键领取：FunctionOn(dailytask_one_click) 时走 316 DAILY_QUEST_GET_ALL_BOX_REWARD，
 *     PBV2，{}；应答 data.rewardInfos=[{boxId,boxStatus}]。否则逐箱走 304
 *     GET_DAILY_QUEST_BOX_REWARD，V1 send，{boxId}；应答 d 含 boxId/status/reward。
 *
 * 直发防重领：上述请求不经游戏 UI 回调，UserData 不会由本功能回写。模块内按服务器日界/UID 保存
 *   已领任务 key（id:progress）与 boxId，并用应答里的新任务/box1..box4 状态补出本地盲区；
 *   仅当应答明确删除任务或把宝箱推进到 FINISHED 才抑制，删除列表缺失/为空、状态仍为
 *   CAN_REWARD 均留待重试；仅应答完全无法解析时按发包前快照兜底抑制。
 *   宝箱覆盖态与本地单向态取较大值，避免旧本地态造成重复直发。刷新扩展后以登录下发的服务端状态为准，
 *   不持久化“已领”集合，避免错误日戳压住新一天或换号漏领。
 *   CODE_NOT_SENT 短重试且不标记；真正业务拒绝按 info 记录并退避；跨午夜应答丢弃旧日结果。
 *
 * 调度：createCycle 单飞；每 30 秒检查本地只读态，有可领项立即发，成功后 1 秒内复扫 newly-ready。
 *
 * 面板口径（inlineStatus）：「任务 x/N · 奖励 y/4」。
 *   x=今日已领取任务数（服务端 dailyQuestFinishCount，含手动领取，钳进 [0,N]），
 *     N=当天任务条数（UserData.DailyQuests 长度，随账号/版本变化，不写死）；
 *   y=已领宝箱数（dailyQuestBoxStateArray 与领取应答覆盖取 max 后计 FINISHED），分母=宝箱数（当前 4）。
 */
import { CODE_NOT_SENT, parseData, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { bus, EVT } from '../../../core/bus.js';

import {
  BOX_STATE_CAN_REWARD,
  BOX_STATE_FINISHED,
  CMD_GET_ALL_DAILY_QUEST_BOX_REWARD,
  CMD_GET_DAILY_QUEST_BOX_REWARD,
  CMD_GET_DAILY_QUEST_REWARD_ALL,
  QUEST_STATE_CAN_REWARD,
} from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('BOUNTY-QUEST');
/** @type {number} 本地状态巡检间隔（毫秒） */
const SCAN_TICK_MS = 1000 * 30;
/** @type {number} 瞬态未发出/业务拒绝后的退避间隔（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;
/** @type {number} 服务器时间不可用时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 成功后的快速复扫间隔（毫秒） */
const RESCAN_MS = 1000;

/** @type {object|null} pocketcc.net 网络底座 */
var net = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 当前抑制集合所属的下一服务器日界 */
var activeResetTs = 0;
/** @type {string} 当前抑制集合所属账号；换号即清空，避免跨 UID 漏领 */
var activeUid = '';
/** @type {Set<string>} 今日已成功领取的任务 key（id:progress） */
var resolvedTasks = new Set();
/** @type {Set<number>} 今日已成功领取的宝箱 boxId */
var resolvedBoxes = new Set();
/** @type {Map<string,{id:string,progress:number,state:number}>} 任务领取应答携带的 newly-ready 任务 */
var readyTasks = new Map();
/** @type {Map<number,number>} 领取应答暴露的宝箱状态覆盖（与本地单调态取较大值） */
var boxOverrides = new Map();
/** @type {number} 315 应答携带的今日完成数，供面板即时展示 */
var finishCountOverride = 0;

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
 * 任务防重领 key；progress 参与键值，使同日同 ID 任务刷新后仍可再次领取。
 * @param {{id:string,progress:number}} quest 任务标量投影
 * @returns {string}
 */
function taskKey(quest) {
  return quest.id + ':' + quest.progress;
}

/**
 * 今日已领取任务数：取服务端权威值与本功能应答覆盖的较大值（直发不驱动游戏 UserData 自更新）。
 * @returns {number}
 */
function claimedCount() {
  return Math.max(gameData.dailyQuestFinishCount(), finishCountOverride);
}

/**
 * 今日已领取宝箱数：本地态与领取应答覆盖取较大值后计 FINISHED（宝箱状态 0→1→2 单向推进）。
 * @returns {{claimed:number,total:number}}
 */
function boxProgress() {
  var states = gameData.dailyQuestBoxStates();
  var claimed = 0;
  for (var i = 0; i < states.length; i++) {
    var state = Math.max(Number(states[i]) || 0, boxOverrides.get(i + 1) || 0);
    if (state === BOX_STATE_FINISHED) claimed++;
  }
  return { claimed: claimed, total: states.length };
}

/**
 * 面板内联状态文案：任务 已领/当天任务数 · 奖励 已领宝箱/宝箱数；两边都读不到回 '—'。
 * @returns {string}
 */
function todayText() {
  var total = gameData.dailyQuests().length;
  var boxes = boxProgress();
  if (!total && !boxes.total) return '—';
  var taskText = total > 0 ? '任务 ' + Math.min(total, claimedCount()) + '/' + total : '任务 —';
  var boxText = boxes.total > 0 ? '奖励 ' + boxes.claimed + '/' + boxes.total : '奖励 —';
  return taskText + ' · ' + boxText;
}

/**
 * 日界或账号变化时清空会话内防重领集合。刷新扩展不恢复集合，直接以服务端登录态为准。
 * @param {number} resetTs 当前下一服务器日界
 * @param {string} uid 当前账号 UID
 */
function syncDay(resetTs, uid) {
  if (activeResetTs === resetTs && activeUid === uid) return;
  activeResetTs = resetTs;
  activeUid = uid;
  resolvedTasks = new Set();
  resolvedBoxes = new Set();
  readyTasks = new Map();
  boxOverrides = new Map();
  finishCountOverride = 0;
}

/**
 * 当前本地可领且未被本轮会话抑制的任务列表。
 * @returns {{id:string,progress:number,state:number,key:string}[]}
 */
function pendingTasks() {
  var out = [];
  var seen = new Set();
  var localByKey = new Map();
  var list = gameData.dailyQuests();
  for (var i = 0; i < list.length; i++) {
    var q = list[i];
    var localKey = taskKey(q);
    localByKey.set(localKey, q);
    if (q.state !== QUEST_STATE_CAN_REWARD) continue;
    if (resolvedTasks.has(localKey) || seen.has(localKey)) continue;
    seen.add(localKey);
    out.push({ id: q.id, progress: q.progress, state: q.state, key: localKey });
  }
  readyTasks.forEach(function (q, key) {
    var local = localByKey.get(key);
    // 游戏 UI/推送若已把该任务推进到非可领态，删除应答遗留覆盖，避免重复直发。
    if (local && local.state !== QUEST_STATE_CAN_REWARD) {
      readyTasks.delete(key);
      return;
    }
    if (resolvedTasks.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ id: q.id, progress: q.progress, state: q.state, key: key });
  });
  return out;
}

/**
 * 当前可领宝箱：本地状态与领取应答覆盖取单调较大值，再扣除今日已领。
 * DailyQuestBoxState 0→1→2 单向推进，取 max 可避免本地旧态覆盖应答新态，也可被后续 UI 完成态纠正。
 * @returns {number[]}
 */
function pendingBoxes() {
  var out = [];
  var seen = new Set();
  var states = gameData.dailyQuestBoxStates();
  for (var i = 0; i < states.length; i++) {
    var boxId = i + 1;
    var override = boxOverrides.get(boxId) || 0;
    var state = Math.max(states[i], override);
    if (state !== BOX_STATE_CAN_REWARD || resolvedBoxes.has(boxId) || seen.has(boxId)) continue;
    seen.add(boxId);
    out.push(boxId);
  }
  boxOverrides.forEach(function (state, boxId) {
    if (state !== BOX_STATE_CAN_REWARD || resolvedBoxes.has(boxId) || seen.has(boxId)) return;
    seen.add(boxId);
    out.push(boxId);
  });
  return out.sort(function (a, b) {
    return a - b;
  });
}

/**
 * 标记任务领取成功；仅按应答实际删除 ID 标记。字段缺失/空数组均视为本轮未领取到任务，
 * 不标记、下一轮继续重试；仅应答完全无法解析时按发包前快照兜底抑制。
 * @param {{id:string,progress:number,state:number,key:string}[]} snapshot 发包前可领任务
 * @param {*} data 315 应答 data
 * @returns {number} 本次标记的任务数
 */
function applyTaskAck(snapshot, data) {
  var d = parseData(data);
  if (!d) {
    log.warn('cmd 315 ack malformed; suppress request snapshot to avoid duplicate claims.');
    for (var i = 0; i < snapshot.length; i++) resolvedTasks.add(snapshot[i].key);
    return snapshot.length;
  }
  var byId = new Map();
  for (var j = 0; j < snapshot.length; j++) byId.set(snapshot[j].id, snapshot[j]);
  var marked = 0;
  var delIds = Array.isArray(d.dailyQuestDelIds) ? d.dailyQuestDelIds : [];
  for (var k = 0; k < delIds.length; k++) {
    var q = byId.get(String(delIds[k]));
    if (!q || resolvedTasks.has(q.key)) continue;
    resolvedTasks.add(q.key);
    marked++;
  }
  if (!marked && snapshot.length) {
    // 游戏源码同样按 dailyQuestDelIds||[] 消费；字段缺失/空数组都表示本轮未领取到任务。
    log.debug('cmd 315 ack deleted no snapshot task; retry later. snapshot=%d', snapshot.length);
  }
  if (Array.isArray(d.newDailyQuests)) {
    for (var n = 0; n < d.newDailyQuests.length; n++) {
      var item = d.newDailyQuests[n] || {};
      if (Number(item.status) !== QUEST_STATE_CAN_REWARD || item.id == null) continue;
      var id = String(item.id);
      var progress = Number(item.progress) || 0;
      readyTasks.set(id + ':' + progress, { id: id, progress: progress, state: item.status });
    }
  }
  var finishCount = Number(d.dailyQuestFinishCount);
  if (isFinite(finishCount)) finishCountOverride = Math.max(finishCountOverride, finishCount);
  for (var b = 1; b <= 4; b++) {
    if (d['box' + b] == null) continue;
    boxOverrides.set(b, Number(d['box' + b]) || 0);
  }
  return marked;
}

/**
 * 直发 315 一键领取全部已完成每日任务。
 * @param {{id:string,progress:number,state:number,key:string}[]} snapshot 发包前可领任务
 * @returns {Promise<{ok:boolean,claimed:number,code:number,reason?:string}>}
 */
async function claimTasks(snapshot) {
  if (!net) return { ok: false, claimed: 0, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_GET_DAILY_QUEST_REWARD_ALL,
    {},
    {
      protocol: 'send',
      onError: function (err) {
        log.warn('cmd 315 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok)
    return {
      ok: false,
      claimed: 0,
      code: ret ? ret.code : CODE_NOT_SENT,
      reason: ret && ret.reason,
    };
  return { ok: true, claimed: applyTaskAck(snapshot, ret.data), code: 0 };
}

/**
 * 直发 316 一键领取全部可领宝箱（dailytask_one_click 开启时与游戏 UI 同链路）。
 * @param {number[]} snapshot 发包前可领 boxId
 * @returns {Promise<{ok:boolean,claimed:number,code:number,reason?:string}>}
 */
async function claimBoxesAll(snapshot) {
  if (!net) return { ok: false, claimed: 0, code: CODE_NOT_SENT };
  var ret = await net.sendGuarded(
    CMD_GET_ALL_DAILY_QUEST_BOX_REWARD,
    {},
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        log.warn('cmd 316 sendPBV2 threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok)
    return {
      ok: false,
      claimed: 0,
      code: ret ? ret.code : CODE_NOT_SENT,
      reason: ret && ret.reason,
    };
  var d = parseData(ret.data);
  var infos = d && Array.isArray(d.rewardInfos) ? d.rewardInfos : null;
  if (!infos) {
    log.warn('cmd 316 ack has no rewardInfos; suppress request snapshot to avoid duplicates.');
    for (var i = 0; i < snapshot.length; i++) {
      resolvedBoxes.add(snapshot[i]);
      boxOverrides.set(snapshot[i], BOX_STATE_FINISHED);
    }
    return { ok: true, claimed: snapshot.length, code: 0 };
  }
  var wanted = new Set(snapshot);
  var marked = 0;
  for (var j = 0; j < infos.length; j++) {
    var info = infos[j] || {};
    var boxId = Number(info.boxId) || 0;
    if (!boxId) continue;
    var boxStatus = Number(info.boxStatus) || 0;
    boxOverrides.set(boxId, boxStatus);
    if (!wanted.has(boxId) || resolvedBoxes.has(boxId)) continue;
    // 只有服务端明确推进到 FINISHED 才算领取成功；空列表/仍为 CAN_REWARD 都留待下一轮。
    if (boxStatus !== BOX_STATE_FINISHED) continue;
    resolvedBoxes.add(boxId);
    marked++;
  }
  if (!marked) {
    log.debug(
      'cmd 316 ack claimed no snapshot box; retry later. snapshot=%d;infos=%d',
      snapshot.length,
      infos.length,
    );
  }
  return { ok: true, claimed: marked, code: 0 };
}

/**
 * 旧链路逐箱领取；单箱业务拒绝不阻断其余箱，CODE_NOT_SENT 立即停止本轮。
 * @param {number[]} snapshot 发包前可领 boxId
 * @returns {Promise<{ok:boolean,claimed:number,code:number,reason?:string,rejected:boolean}>}
 */
async function claimBoxesSingle(snapshot) {
  if (!net) return { ok: false, claimed: 0, code: CODE_NOT_SENT, rejected: false };
  var claimed = 0;
  var rejected = false;
  for (var i = 0; i < snapshot.length; i++) {
    var boxId = snapshot[i];
    var ret = await net.sendGuarded(
      CMD_GET_DAILY_QUEST_BOX_REWARD,
      { boxId: boxId },
      {
        protocol: 'send',
        onError: function (err) {
          log.warn('cmd 304 boxId=%d send threw: %s', boxId, err && err.message);
        },
      },
    );
    if (!ret || !ret.ok) {
      var code = ret ? ret.code : CODE_NOT_SENT;
      if (code === CODE_NOT_SENT)
        return { ok: false, claimed: claimed, code: code, rejected: rejected };
      rejected = true;
      log.info(
        'cmd 304 boxId=%d claim rejected, continue other boxes. code=%s;data=%s',
        boxId,
        code,
        rejectText(ret) || '-',
      );
      continue;
    }
    var d = parseData(ret.data);
    if (!d) {
      log.warn('cmd 304 boxId=%d ack unparseable; suppress this box.', boxId);
      resolvedBoxes.add(boxId);
      boxOverrides.set(boxId, BOX_STATE_FINISHED);
      claimed++;
      continue;
    }
    var status = d.status != null ? Number(d.status) : null;
    // 成功应答但缺少状态或仍为 CAN_REWARD（或其它非 FINISHED 态）不代表已领，留待下一轮重试。
    if (status == null || !isFinite(status) || status !== BOX_STATE_FINISHED) {
      log.debug('cmd 304 boxId=%d not finished; retry later. status=%s', boxId, String(status));
      continue;
    }
    resolvedBoxes.add(boxId);
    boxOverrides.set(boxId, status);
    claimed++;
  }
  return { ok: true, claimed: claimed, code: 0, rejected: rejected };
}

/**
 * cycle 单轮：日界同步 → 315 → 按功能开关选 316/304 → 快速复扫。
 * @returns {Promise<number>} 下次唤醒毫秒
 */
async function cycleRun() {
  var signal = ctxRef ? ctxRef.signal : null;
  var now = gameData.serverTime();
  if (!now) {
    log.debug('cmd 315/316 idle: server time unavailable.');
    return IDLE_TICK_MS;
  }
  var roundResetTs = gameData.nextDailyResetTs(now);
  if (!roundResetTs) {
    log.debug('cmd 315/316 idle: next daily reset unavailable.');
    return IDLE_TICK_MS;
  }
  syncDay(roundResetTs, gameData.myUidStr());
  if (!roundAlive(signal)) return 0;

  var tasks = pendingTasks();
  var didClaim = false;
  var rejected = false;
  if (tasks.length) {
    var taskRet = await claimTasks(tasks);
    var pausedAfterTask = !roundAlive(signal);
    if (gameData.nextDailyResetTs() !== roundResetTs) {
      log.debug('cmd 315 response crossed midnight; discard stale daily result.');
      return pausedAfterTask ? 0 : RESCAN_MS;
    }
    if (!taskRet.ok) {
      if (taskRet.code === CODE_NOT_SENT) {
        if (pausedAfterTask) return 0;
        log.warn('cmd 315 transient (not sent/in-flight), retry soon.');
        return TRANSIENT_RETRY_MS;
      }
      rejected = true;
      log.info(
        'cmd 315 daily-quest claim rejected, poll later. code=%s;data=%s',
        taskRet.code,
        rejectText(taskRet) || '-',
      );
    } else {
      didClaim = taskRet.claimed > 0;
      log.info('daily-quest rewards claimed (tasks=%d).', taskRet.claimed);
      bus.emit(EVT.UI_REFRESH);
    }
    if (pausedAfterTask) return 0;
  }

  var boxes = pendingBoxes();
  if (boxes.length) {
    var boxRet = gameData.functionOn('dailytask_one_click')
      ? await claimBoxesAll(boxes)
      : await claimBoxesSingle(boxes);
    var pausedAfterBoxes = !roundAlive(signal);
    if (gameData.nextDailyResetTs() !== roundResetTs) {
      log.debug('daily-quest box response crossed midnight; discard stale daily result.');
      return pausedAfterBoxes ? 0 : RESCAN_MS;
    }
    if (!boxRet.ok) {
      if (boxRet.code === CODE_NOT_SENT) {
        if (pausedAfterBoxes) return 0;
        log.warn('daily-quest box claim transient (not sent/in-flight), retry soon.');
        return TRANSIENT_RETRY_MS;
      }
      rejected = true;
      log.info(
        'daily-quest box claim rejected, poll later. code=%s;data=%s',
        boxRet.code,
        rejectText(boxRet) || '-',
      );
    } else {
      didClaim = didClaim || boxRet.claimed > 0;
      rejected = rejected || !!boxRet.rejected;
      log.info('daily-quest boxes claimed (boxes=%d).', boxRet.claimed);
      bus.emit(EVT.UI_REFRESH);
    }
    if (pausedAfterBoxes) return 0;
  }

  if (!tasks.length && !boxes.length) {
    log.debug('cmd 315/316 skipped: no claimable daily quest or box.');
    return SCAN_TICK_MS;
  }
  if (didClaim) return RESCAN_MS;
  if (rejected) return IDLE_TICK_MS;
  return SCAN_TICK_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: SCAN_TICK_MS });

/**
 * 安装网络底座。
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
 * 启动：清空会话内防重领集合并立即扫描。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  activeResetTs = 0;
  activeUid = '';
  resolvedTasks = new Set();
  resolvedBoxes = new Set();
  readyTasks = new Map();
  boxOverrides = new Map();
  finishCountOverride = 0;
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：玩家基础设置子项（无 places/kinds 限定）。
 */
reactor.register({
  id: 'bountyQuest',
  label: '悬赏任务自动领取',
  storageKey: 'pocketcc.feat.bountyQuest',
  symbols: ['dataCenter'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_bountyInfo',
      type: 'text',
      label: '今日',
      get: function () {
        return todayText();
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
/** 单测专用：清空会话内防重领集合，不启动 cycle。 */
export function resetForTest() {
  activeResetTs = 0;
  activeUid = '';
  resolvedTasks = new Set();
  resolvedBoxes = new Set();
  readyTasks = new Map();
  boxOverrides = new Map();
  finishCountOverride = 0;
}
