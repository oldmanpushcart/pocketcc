/**
 * 超值活动一键领取（默认关闭，活动设置 → 基础设置）。
 *
 * 源码实证（公开 H5 客户端 subpack.2b335.js / subpack2.5c3c4.js；未做账号登录抓包）：
 *   841 GET_ACTIVITY_DATA，V1 send，{} → {alist:[活动对象]}。
 *   842 GET_ACTIVITY_REWARD，V1 send，{aid,tid}；ActivityController.getActivityReward 的通用任务领取。
 *     覆盖超值活动各分支 task[]/atarget[].state=1 的已完成任务；保留快照原始 ID 类型，联盟 BP 走 3140。
 *   3103 ACTIVITY_GET_SINGLE_INFO，V1 send，{id} → 单个活动对象。
 *   1777 ACTIVITY_GET_ALL_SCORE_REWARD，V1 send，{id}；截图“异能兽征程”和“蛋糕等级奖励”
 *     的绿色一键领取都走该协议。请求体没有 adv，故只在本模块确认可领档后发包。
 *   3140 ACTIVITY_GET_ALL_TASK_REWARD，V1 send，{activityId,targetIds}；仅联盟 BP 任务页使用。
 *   3135 MAKESHIFTBAG_RECEIVE，V1 send，{rewardCenterAid,rewardAid:-1}；应急背包全部待领奖励。
 *   4790 PIN_BALL_ACTIVITY_GET_SCORE_REWARD，V1 PB，嵌套 activityId/index:-1；弹珠循环奖励。
 *   8768/8795/8833，V2 PB，{activityId,index:-1}；大富翁/联盟远征/舞狮循环奖励。
 *   8768 额外要求在盟且未达 bullet_boss_reward_limit[2] 的领取上限。
 *
 * 安全边界：只领 task[]/atarget[].state=1 的已完成任务、普通积分档、已解锁高级免费档，
 * 以及 841/3103 自带状态可证明的专用免费奖励；联盟 BP 与大富翁在明确退盟时跳过；
 * 未知联盟态沿用 ACL 三态放行惯例。
 * 不调用 1674 解锁高级奖励，不翻牌、不开箱、不兑换、不购买、不消耗道具。需要独立状态查询、
 * 本地配置表或账号道具余额的专用按钮未接入，不能仅凭按钮文案猜测可领状态。
 *
 * 闭环与防重：841 动态扫描全部开放活动 → 按 model.js 判据领取 → 3103 重查确认。
 * 通用任务逐个领取并在每次重查后继续权威剩余任务；聚合/专用奖励每类每轮最多尝试一次，
 * 重查仍有可领项则下轮再试，不把 ok 回执当成“已全部领完”。
 * 10904 整活动推送/10912 extra 推送只触发 kick，在飞时合并；30 秒兜底扫描解决不刷新不领取。
 * CODE_NOT_SENT 短重试且停止本轮后续写请求；业务拒绝按任务/活动退避后继续其它可领项。
 * 所有 await 后校验本轮 signal，pause/resume 或跨活动结束后的旧回执不会继续发包。
 */
import { CODE_NOT_SENT, parseData, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { bus, EVT } from '../../../core/bus.js';
import {
  CMD_GET_ACTIVITY_DATA,
  CMD_GET_ACTIVITY_REWARD,
  CMD_GET_ACTIVITY_SINGLE_INFO,
  CMD_GET_ALL_SCORE_REWARD,
  CMD_GET_ALL_TASK_REWARD,
  CMD_PUSH_ONE_ACTIVITY,
  CMD_PUSH_ONE_ACTIVITY_EXTRA,
} from './constants.js';
import {
  activityFromAck,
  activityListFromAck,
  claimableAllianceTaskIds,
  claimableAllianceTaskTargets,
  claimableGenericTaskIds,
  claimableGenericTaskTargets,
  claimableScoreTiers,
  claimableSpecialRewards,
  isActivityOpen,
} from './model.js';

/** @type {ReturnType<createLog>} 模块日志器 */
const log = createLog('SUPER-VALUE-GIFT');
/** @type {number} 无待领项时的兜底扫描间隔（毫秒） */
const SCAN_TICK_MS = 1000 * 30;
/** @type {number} 未发出、拒绝或重查无进展后的短重试（毫秒） */
const RETRY_TICK_MS = 1000 * 20;
/** @type {number} 服务器时钟不可用时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 确认领取后的快速复扫间隔（毫秒） */
const RESCAN_MS = 1000;
/** @type {number} 确定性业务拒绝的会话退避（秒） */
const BUSINESS_RETRY_SEC = 15 * 60;
/** @type {number} 成功回执但重查无进展的基础退避（秒） */
const NO_PROGRESS_BASE_SEC = 20;
/** @type {number} 重查无进展退避上限（秒），避免活动结束前永久不再尝试 */
const NO_PROGRESS_MAX_SEC = 5 * 60;

/** @type {object|null} pocketcc.net 网络底座 */
var net = null;
/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {number} 本轮已由 3103 确认推进的领取批次数 */
var lastClaimed = 0;
/** @type {boolean} 最近一轮是否存在需要重试的瞬态/拒绝/无进展 */
var lastRetry = false;
/** @type {number} 最近一次扫描发现的待领活动数 */
var pendingCount = 0;
/** @type {Map<string,{until:number,streak:number}>} 会话级领取退避；键为 cmd:activityId[:targetId]，不持久化 */
var claimCooldowns = new Map();

/**
 * 领取退避键；活动 ID 始终按字符串拼接，避免 Int64 精度碰撞。
 * 通用任务 842 使用 targetId 后缀，避免单个任务拒绝冻结同活动其它任务。
 * @param {number} cmd 协议号
 * @param {string|number} aid 活动 ID
 * @param {string|number|null} [targetId] 可选任务 ID
 * @returns {string}
 */
function cooldownKey(cmd, aid, targetId = null) {
  const base = cmd + ':' + String(aid);
  return targetId == null ? base : base + ':' + String(targetId);
}

/**
 * 业务拒绝退避；仅在服务器明确拒绝成形请求时调用。
 * @param {number} cmd 协议号
 * @param {string|number} aid 活动 ID
 * @param {number} now 服务器时间（秒）
 * @param {string|number|null} [targetId] 可选任务 ID
 */
function suppressBusinessClaim(cmd, aid, now, targetId = null) {
  claimCooldowns.set(cooldownKey(cmd, aid, targetId), {
    until: now + BUSINESS_RETRY_SEC,
    streak: 0,
  });
}

/**
 * 成功回执但权威重查无进展：指数退避，避免每 20 秒重复直发与刷日志。
 * @param {number} cmd 协议号
 * @param {string|number} aid 活动 ID
 * @param {number} now 服务器时间（秒）
 * @param {string|number|null} [targetId] 可选任务 ID
 */
function suppressNoProgress(cmd, aid, now, targetId = null) {
  const key = cooldownKey(cmd, aid, targetId);
  const prev = claimCooldowns.get(key);
  const streak = prev ? prev.streak + 1 : 1;
  const delay = Math.min(NO_PROGRESS_BASE_SEC * 2 ** (streak - 1), NO_PROGRESS_MAX_SEC);
  claimCooldowns.set(key, { until: now + delay, streak: streak });
}

/**
 * 领取是否处于会话退避中；过期条目不立即删除，以保留无进展的指数退避轮次，
 * 待权威快照确认无可领项、活动结束或功能重置时再由 prune/clear 清理。
 * @param {number} cmd 协议号
 * @param {string|number} aid 活动 ID
 * @param {number} now 服务器时间（秒）
 * @param {string|number|null} [targetId] 可选任务 ID
 * @returns {boolean}
 */
function claimSuppressed(cmd, aid, now, targetId = null) {
  const key = cooldownKey(cmd, aid, targetId);
  const entry = claimCooldowns.get(key);
  if (!entry || entry.until <= now) return false;
  log.debug(
    'cmd %d claim skipped by cooldown. activityId=%s;targetId=%s;retryAfter=%ds',
    cmd,
    aid,
    targetId == null ? '-' : targetId,
    entry.until - now,
  );
  return true;
}

/**
 * 权威状态确认已无该项后解除退避；活动关闭/消失的条目由 prune 清理。
 * @param {number} cmd 协议号
 * @param {string|number} aid 活动 ID
 * @param {string|number|null} [targetId] 可选任务 ID
 */
function clearClaimCooldown(cmd, aid, targetId = null) {
  claimCooldowns.delete(cooldownKey(cmd, aid, targetId));
}

/**
 * 每轮全量快照后清理已结束或已无可领项的退避，换活动/换日不残留。
 * @param {object[]} open 当前开放活动
 * @param {boolean|null} inAlliance 当前联盟状态
 */
function pruneClaimCooldowns(open, inAlliance) {
  if (!claimCooldowns.size) return;
  for (const key of claimCooldowns.keys()) {
    const parts = key.split(':');
    const cmd = Number(parts[0]);
    const aid = parts[1];
    const targetId = parts.length > 2 ? parts.slice(2).join(':') : null;
    const activity = open.find(function (item) {
      return String(item.id) === aid;
    });
    let pending = 0;
    if (activity) {
      if (cmd === CMD_GET_ALL_SCORE_REWARD) {
        pending = claimableScoreTiers(activity, inAlliance).length;
      } else if (cmd === CMD_GET_ALL_TASK_REWARD) {
        pending = claimableAllianceTaskIds(activity, inAlliance).length;
      } else if (cmd === CMD_GET_ACTIVITY_REWARD) {
        pending = targetId != null && claimableGenericTaskIds(activity).includes(targetId) ? 1 : 0;
      } else {
        pending = claimableSpecialRewards(activity, inAlliance).filter(function (plan) {
          return plan.key === cmd;
        }).length;
      }
    }
    if (!pending) claimCooldowns.delete(key);
  }
}

/** @returns {boolean} 当前 reactor 功能是否存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 本轮是否仍属于当前激活代次；旧 signal 不随 resume 复活。
 * @param {AbortSignal|null} signal 本轮取消信号
 * @returns {boolean}
 */
function roundAlive(signal) {
  return aliveFn() && !(signal && signal.aborted);
}

/**
 * 发送查询；读取可重放，绕过在途闸门，避免游戏面板正在查询时本功能永久饥饿。
 * @param {number} cmd 协议号
 * @param {object} body 请求体
 * @returns {Promise<{ok:boolean,code:number,data:*,reason?:string}>}
 */
async function query(cmd, body) {
  if (!net) return { ok: false, code: CODE_NOT_SENT, data: null };
  try {
    const ret = await net.sendGuarded(cmd, body, {
      protocol: 'send',
      gate: false,
      onError: function (err) {
        log.warn('cmd %d query threw: %s', cmd, err && err.message);
      },
    });
    return ret || { ok: false, code: CODE_NOT_SENT, data: null };
  } catch (err) {
    log.warn('cmd %d query threw outside net guard: %s', cmd, err && err.message);
    return { ok: false, code: CODE_NOT_SENT, data: null };
  }
}

/**
 * 发送领取；保留在途闸门，避免与游戏 UI 或上一轮重复直发。
 * @param {number} cmd 协议号
 * @param {object} body 请求体
 * @param {'send'|'sendPB'|'sendPBV2'} [protocol] 客户端真实按钮使用的发送通道
 * @returns {Promise<{ok:boolean,code:number,data:*,reason?:string}>}
 */
async function claim(cmd, body, protocol = 'send') {
  if (!net) return { ok: false, code: CODE_NOT_SENT, data: null };
  try {
    const ret = await net.sendGuarded(cmd, body, {
      protocol: protocol,
      onError: function (err) {
        log.warn('cmd %d claim threw: %s', cmd, err && err.message);
      },
    });
    return ret || { ok: false, code: CODE_NOT_SENT, data: null };
  } catch (err) {
    log.warn('cmd %d claim threw outside net guard: %s', cmd, err && err.message);
    return { ok: false, code: CODE_NOT_SENT, data: null };
  }
}

/**
 * 领取失败分类；真正业务拒绝与未发出分开，日志带活动与协议上下文。
 * @param {number} cmd 协议号
 * @param {string|number} aid 活动 ID
 * @param {{ok:boolean,code:number,reason?:string}} ret 网络结果
 * @param {string|number|null} [targetId] 可选任务 ID
 * @returns {'transient'|'rejected'} 调度分类
 */
function classifyClaimFailure(cmd, aid, ret, targetId = null) {
  if (ret.code === CODE_NOT_SENT) {
    log.warn(
      'cmd %d transient (not sent/in-flight), retry soon. activityId=%s;targetId=%s',
      cmd,
      aid,
      targetId == null ? '-' : targetId,
    );
    return 'transient';
  }
  log.info(
    'cmd %d claim rejected, poll later. activityId=%s;targetId=%s;code=%s;data=%s',
    cmd,
    aid,
    targetId == null ? '-' : targetId,
    ret.code,
    rejectText(ret) || '-',
  );
  return 'rejected';
}

/**
 * 3103 重查单个活动；无进展也返回权威快照，由调用方决定是否下轮再试。
 * @param {string|number} aid 活动 ID
 * @returns {Promise<{ok:boolean,activity?:object,code:number,reason?:string}>}
 */
async function refreshActivity(aid) {
  const ret = await query(CMD_GET_ACTIVITY_SINGLE_INFO, { id: aid });
  if (!ret.ok) return { ok: false, code: ret.code, reason: ret.reason };
  const data = parseData(ret.data);
  const activity = activityFromAck(data, aid);
  if (!activity) {
    log.warn('cmd 3103 ack malformed or id mismatch. requestedId=%s', aid);
    return { ok: false, code: -2 };
  }
  return { ok: true, activity: activity, code: 0 };
}

/**
 * 处理一个活动：积分档 1777、联盟 BP 3140、通用任务 842、专用全部/循环全部领取逐项执行。
 * 每个写请求前重读服务器时间与联盟态；每次成功后用 3103 权威重查，不以回执认定全部领完。
 * 通用任务按权威剩余列表逐个领取；聚合奖励同一活动同一轮不重复，重查仍有待领项时下轮再试。
 * @param {object} activity 841 快照中的活动
 * @param {AbortSignal|null} signal 本轮取消信号
 * @returns {Promise<{claimed:number,retry:boolean,stop:boolean}>}
 */
async function processActivity(activity, signal) {
  const aid = activity.id;
  const result = { claimed: 0, retry: false, stop: false };
  if (!roundAlive(signal)) {
    result.stop = true;
    return result;
  }
  let current = activity;
  let actionNow = gameData.serverTime();
  if (!actionNow) {
    log.debug('activity claim idle: server time unavailable. activityId=%s', aid);
    result.stop = true;
    return result;
  }
  if (!isActivityOpen(current, actionNow)) {
    log.debug('activity claim skipped: closed before send. activityId=%s', aid);
    return result;
  }

  const scores = claimableScoreTiers(current, gameData.inAlliance());
  if (scores.length && claimSuppressed(CMD_GET_ALL_SCORE_REWARD, aid, actionNow)) {
    result.retry = true;
  } else if (scores.length) {
    log.debug('cmd 1777 claimable score tiers. activityId=%s;tiers=%s', aid, scores.join(','));
    const ret = await claim(CMD_GET_ALL_SCORE_REWARD, { id: aid });
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!ret.ok) {
      result.retry = true;
      const failure = classifyClaimFailure(CMD_GET_ALL_SCORE_REWARD, aid, ret);
      if (failure === 'rejected') {
        suppressBusinessClaim(CMD_GET_ALL_SCORE_REWARD, aid, gameData.serverTime());
      }
      result.stop = failure === 'transient';
      return result;
    }
    const after = await refreshActivity(aid);
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!after.ok) {
      log.warn(
        'cmd 3103 post-1777 verification failed. activityId=%s;code=%s;reason=%s',
        aid,
        after.code,
        after.reason || '-',
      );
      result.retry = true;
      return result;
    }
    current = after.activity;
    actionNow = gameData.serverTime();
    if (!actionNow) {
      result.stop = true;
      return result;
    }
    if (!isActivityOpen(current, actionNow)) {
      log.debug('cmd 1777 accepted; activity closed before verification. activityId=%s', aid);
      return result;
    }
    const remaining = claimableScoreTiers(current, gameData.inAlliance()).length;
    if (remaining === 0) {
      result.claimed++;
      clearClaimCooldown(CMD_GET_ALL_SCORE_REWARD, aid);
      log.info('cmd 1777 score rewards confirmed. activityId=%s', aid);
    } else {
      suppressNoProgress(CMD_GET_ALL_SCORE_REWARD, aid, actionNow);
      log.debug(
        'cmd 1777 accepted but score tiers remain=%d; re-scan before retry. activityId=%s',
        remaining,
        aid,
      );
      result.retry = true;
    }
  }

  actionNow = gameData.serverTime();
  if (!actionNow || !isActivityOpen(current, actionNow)) {
    if (!actionNow) result.stop = true;
    else log.debug('activity claim skipped: closed before next request. activityId=%s', aid);
    return result;
  }
  const taskTargets = claimableAllianceTaskTargets(current, gameData.inAlliance());
  if (taskTargets.length) {
    if (claimSuppressed(CMD_GET_ALL_TASK_REWARD, aid, actionNow)) {
      result.retry = true;
    } else {
      log.debug('cmd 3140 claimable tasks. activityId=%s;count=%d', aid, taskTargets.length);
      const taskRet = await claim(CMD_GET_ALL_TASK_REWARD, {
        activityId: aid,
        targetIds: taskTargets,
      });
      if (!roundAlive(signal)) {
        result.stop = true;
        return result;
      }
      if (!taskRet.ok) {
        result.retry = true;
        const failure = classifyClaimFailure(CMD_GET_ALL_TASK_REWARD, aid, taskRet);
        if (failure === 'rejected') {
          suppressBusinessClaim(CMD_GET_ALL_TASK_REWARD, aid, gameData.serverTime());
        }
        result.stop = failure === 'transient';
        return result;
      }
      const afterTasks = await refreshActivity(aid);
      if (!roundAlive(signal)) {
        result.stop = true;
        return result;
      }
      if (!afterTasks.ok) {
        log.warn(
          'cmd 3103 post-3140 verification failed. activityId=%s;code=%s;reason=%s',
          aid,
          afterTasks.code,
          afterTasks.reason || '-',
        );
        result.retry = true;
        return result;
      }
      current = afterTasks.activity;
      actionNow = gameData.serverTime();
      if (!actionNow) {
        result.stop = true;
        return result;
      }
      if (!isActivityOpen(current, actionNow)) {
        log.debug('cmd 3140 accepted; activity closed before verification. activityId=%s', aid);
        return result;
      }
      const remaining = claimableAllianceTaskIds(current, gameData.inAlliance()).length;
      if (remaining === 0) {
        result.claimed++;
        clearClaimCooldown(CMD_GET_ALL_TASK_REWARD, aid);
        log.info(
          'cmd 3140 alliance BP tasks confirmed. activityId=%s;tasks=%d',
          aid,
          taskTargets.length,
        );
      } else {
        suppressNoProgress(CMD_GET_ALL_TASK_REWARD, aid, actionNow);
        log.debug(
          'cmd 3140 accepted but tasks remain=%d; re-scan before retry. activityId=%s',
          remaining,
          aid,
        );
        result.retry = true;
      }
    }
  }

  const skippedTaskKeys = new Set();
  let genericTaskTargets = claimableGenericTaskTargets(current);
  while (genericTaskTargets.length) {
    actionNow = gameData.serverTime();
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!actionNow || !isActivityOpen(current, actionNow)) {
      if (!actionNow) result.stop = true;
      else log.debug('cmd 842 skipped: activity closed. activityId=%s', aid);
      return result;
    }
    const tid = genericTaskTargets[0];
    const tidKey = String(tid);
    if (claimSuppressed(CMD_GET_ACTIVITY_REWARD, aid, actionNow, tidKey)) {
      skippedTaskKeys.add(tidKey);
      genericTaskTargets = genericTaskTargets.filter((id) => String(id) !== tidKey);
      result.retry = true;
      continue;
    }
    const pendingBefore = claimableGenericTaskIds(current).length;
    log.debug('cmd 842 claimable generic task. activityId=%s;targetId=%s', aid, tid);
    const genericRet = await claim(CMD_GET_ACTIVITY_REWARD, { aid: aid, tid: tid });
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!genericRet.ok) {
      result.retry = true;
      const failure = classifyClaimFailure(CMD_GET_ACTIVITY_REWARD, aid, genericRet, tid);
      if (failure === 'rejected') {
        const rejectedAt = gameData.serverTime();
        if (rejectedAt) {
          suppressBusinessClaim(CMD_GET_ACTIVITY_REWARD, aid, rejectedAt, tidKey);
        }
        skippedTaskKeys.add(tidKey);
        genericTaskTargets = genericTaskTargets.filter((id) => String(id) !== tidKey);
        continue;
      }
      result.stop = true;
      return result;
    }
    const afterGeneric = await refreshActivity(aid);
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!afterGeneric.ok) {
      const verificationNow = gameData.serverTime();
      if (verificationNow) {
        suppressNoProgress(CMD_GET_ACTIVITY_REWARD, aid, verificationNow, tidKey);
      }
      log.warn(
        'cmd 3103 post-842 verification failed. activityId=%s;targetId=%s;code=%s;reason=%s',
        aid,
        tid,
        afterGeneric.code,
        afterGeneric.reason || '-',
      );
      result.retry = true;
      return result;
    }
    current = afterGeneric.activity;
    actionNow = gameData.serverTime();
    if (!actionNow) {
      result.stop = true;
      return result;
    }
    if (!isActivityOpen(current, actionNow)) {
      log.debug('cmd 842 accepted; activity closed before verification. activityId=%s', aid);
      return result;
    }
    const remainingTaskIds = claimableGenericTaskIds(current);
    if (remainingTaskIds.length < pendingBefore && !remainingTaskIds.includes(tidKey)) {
      result.claimed++;
      clearClaimCooldown(CMD_GET_ACTIVITY_REWARD, aid, tidKey);
      genericTaskTargets = claimableGenericTaskTargets(current).filter(function (id) {
        return !skippedTaskKeys.has(String(id));
      });
      if (!remainingTaskIds.length) {
        log.info('cmd 842 activity tasks confirmed. activityId=%s;targetId=%s', aid, tid);
      } else {
        log.debug(
          'cmd 842 task claim confirmed; remaining=%d. activityId=%s;targetId=%s',
          remainingTaskIds.length,
          aid,
          tid,
        );
      }
      continue;
    }
    suppressNoProgress(CMD_GET_ACTIVITY_REWARD, aid, actionNow, tidKey);
    log.debug(
      'cmd 842 accepted but requested task claim not confirmed. activityId=%s;targetId=%s;remaining=%d',
      aid,
      tid,
      remainingTaskIds.length,
    );
    result.retry = true;
    break;
  }

  const specialPlans = claimableSpecialRewards(current, gameData.inAlliance());
  for (const plan of specialPlans) {
    actionNow = gameData.serverTime();
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!actionNow || !isActivityOpen(current, actionNow)) {
      if (!actionNow) result.stop = true;
      else log.debug('cmd %d skipped: activity closed. activityId=%s', plan.cmd, aid);
      return result;
    }
    if (claimSuppressed(plan.cmd, aid, actionNow)) {
      result.retry = true;
      continue;
    }
    log.debug('cmd %d special rewards claimable. activityId=%s', plan.cmd, aid);
    const specialRet = await claim(plan.cmd, plan.body, plan.protocol);
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!specialRet.ok) {
      result.retry = true;
      const failure = classifyClaimFailure(plan.cmd, aid, specialRet);
      if (failure === 'rejected') {
        suppressBusinessClaim(plan.cmd, aid, gameData.serverTime());
      }
      result.stop = failure === 'transient';
      return result;
    }
    const afterSpecial = await refreshActivity(aid);
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!afterSpecial.ok) {
      log.warn(
        'cmd 3103 post-%d verification failed. activityId=%s;code=%s;reason=%s',
        plan.cmd,
        aid,
        afterSpecial.code,
        afterSpecial.reason || '-',
      );
      result.retry = true;
      return result;
    }
    current = afterSpecial.activity;
    actionNow = gameData.serverTime();
    if (!actionNow) {
      result.stop = true;
      return result;
    }
    if (!isActivityOpen(current, actionNow)) {
      log.debug(
        'cmd %d accepted; activity closed before verification. activityId=%s',
        plan.cmd,
        aid,
      );
      return result;
    }
    const remaining = claimableSpecialRewards(current, gameData.inAlliance()).some(function (item) {
      return item.key === plan.key;
    });
    if (!remaining) {
      result.claimed++;
      clearClaimCooldown(plan.cmd, aid);
      log.info('cmd %d special rewards confirmed. activityId=%s', plan.cmd, aid);
    } else {
      suppressNoProgress(plan.cmd, aid, actionNow);
      log.debug(
        'cmd %d accepted but rewards remain; re-scan before retry. activityId=%s',
        plan.cmd,
        aid,
      );
      result.retry = true;
    }
  }
  return result;
}

/**
 * cycle 单轮：全量活动查询 → 逐活动领取 →  authoritative 重查 → 动态择时。
 * @returns {Promise<number>} 下次唤醒毫秒
 */
async function cycleRun() {
  const signal = ctxRef ? ctxRef.signal : null;
  const now = gameData.serverTime();
  if (!now) {
    log.debug('cmd 841 idle: server time unavailable.');
    return IDLE_TICK_MS;
  }
  lastClaimed = 0;
  lastRetry = false;
  const listRet = await query(CMD_GET_ACTIVITY_DATA, {});
  if (!roundAlive(signal)) return 0;
  if (!listRet.ok) {
    lastRetry = true;
    if (listRet.code === CODE_NOT_SENT) {
      log.warn('cmd 841 transient (not sent/in-flight), retry soon.');
    } else {
      log.info(
        'cmd 841 query rejected, poll later. code=%s;data=%s',
        listRet.code,
        rejectText(listRet) || '-',
      );
    }
    return cycle.pending ? RESCAN_MS : RETRY_TICK_MS;
  }
  const list = activityListFromAck(parseData(listRet.data));
  if (!list) {
    lastRetry = true;
    log.warn('cmd 841 ack missing alist array; retry later.');
    return cycle.pending ? RESCAN_MS : RETRY_TICK_MS;
  }
  const allianceState = gameData.inAlliance();
  const snapshotNow = gameData.serverTime();
  if (!snapshotNow) {
    log.debug('cmd 841 idle: server time unavailable after query.');
    return IDLE_TICK_MS;
  }
  const open = list.filter(function (activity) {
    return isActivityOpen(activity, snapshotNow);
  });
  pruneClaimCooldowns(open, allianceState);
  pendingCount = open.filter(function (activity) {
    return (
      claimableScoreTiers(activity, allianceState).length ||
      claimableAllianceTaskIds(activity, allianceState).length ||
      claimableGenericTaskIds(activity).length ||
      claimableSpecialRewards(activity, allianceState).length
    );
  }).length;
  if (!pendingCount) {
    log.debug(
      'cmd 841 claim scan skipped: no claimable reward in open activities. open=%d',
      open.length,
    );
    bus.emit(EVT.UI_REFRESH);
    return cycle.pending ? RESCAN_MS : SCAN_TICK_MS;
  }
  let stop = false;
  for (const activity of open) {
    if (!roundAlive(signal)) return 0;
    const itemAlliance = gameData.inAlliance();
    if (
      !claimableScoreTiers(activity, itemAlliance).length &&
      !claimableAllianceTaskIds(activity, itemAlliance).length &&
      !claimableGenericTaskIds(activity).length &&
      !claimableSpecialRewards(activity, itemAlliance).length
    ) {
      continue;
    }
    const result = await processActivity(activity, signal);
    lastClaimed += result.claimed;
    lastRetry = lastRetry || result.retry;
    if (result.stop) {
      stop = true;
      break;
    }
  }
  if (!roundAlive(signal)) return 0;
  if (stop) return cycle.pending ? RESCAN_MS : RETRY_TICK_MS;
  if (lastClaimed) {
    log.info('super-value rewards confirmed. batches=%d', lastClaimed);
    bus.emit(EVT.UI_REFRESH);
    return RESCAN_MS;
  }
  bus.emit(EVT.UI_REFRESH);
  if (cycle.pending) return RESCAN_MS;
  return lastRetry ? RETRY_TICK_MS : SCAN_TICK_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: RETRY_TICK_MS });

/**
 * 活动推送仅唤醒扫描；具体可领状态仍以 841/3103 为准。
 * @param {object} ev 网络推送事件
 */
function onActivityPush(ev) {
  if (!aliveFn()) return;
  const aid = ev && ev.data && (ev.data.id != null ? ev.data.id : ev.data.aid);
  log.debug('activity push received, trigger scan. activityId=%s', aid == null ? '-' : aid);
  cycle.kick();
}

/**
 * 安装网络底座与服务器时间能力。
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
  log.info('installed.');
  return true;
}

/**
 * 每次激活重置展示状态、挂推送并立即扫描；pause 后旧轮由 signal 拦截。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  lastClaimed = 0;
  lastRetry = false;
  pendingCount = 0;
  claimCooldowns.clear();
  ctx.on.push(CMD_PUSH_ONE_ACTIVITY, onActivityPush);
  ctx.on.push(CMD_PUSH_ONE_ACTIVITY_EXTRA, onActivityPush);
  log.info('started; scan all open activities every %d sec.', SCAN_TICK_MS / 1000);
  cycle.kick();
}

reactor.register({
  id: 'superValueGift',
  label: '超值活动一键领取',
  storageKey: 'pocketcc.feat.superValueGift',
  symbols: ['dataCenter'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_superValueGiftInfo',
      type: 'text',
      label: '状态',
      get: function () {
        if (lastClaimed > 0) return '最近领取 ' + lastClaimed + ' 组奖励';
        if (lastRetry) return '等待重试';
        if (pendingCount > 0) return '待领 ' + pendingCount + ' 个活动';
        return '暂无待领';
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
/** 单测专用：复位展示状态，不启动 cycle。 */
export function resetForTest() {
  lastClaimed = 0;
  lastRetry = false;
  pendingCount = 0;
  claimCooldowns.clear();
}
