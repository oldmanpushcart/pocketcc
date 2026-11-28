/**
 * 超值活动一键领取（默认关闭，活动设置 → 基础设置）。
 *
 * 源码实证（公开 H5 客户端 subpack.2b335.js / subpack2.5c3c4.js；未做账号登录抓包）：
 *   842 GET_ACTIVITY_REWARD，V1 send，{aid,tid}；ActivityController.getActivityReward 的通用任务领取。
 *     覆盖超值活动各分支 task[]/atarget[].state=1 的已完成任务；保留快照原始 ID 类型，联盟 BP 走 3140。
 *   1777 ACTIVITY_GET_ALL_SCORE_REWARD，V1 send，{id}；截图“异能兽征程”和“蛋糕等级奖励”
 *     的绿色一键领取都走该协议。请求体没有 adv，故只在本模块确认可领档后发包。
 *   3140 ACTIVITY_GET_ALL_TASK_REWARD，V1 send，{activityId,targetIds}；仅联盟 BP 任务页使用。
 *   3135 MAKESHIFTBAG_RECEIVE，V1 send，{rewardCenterAid,rewardAid:-1}；应急背包全部待领奖励。
 *   4790 PIN_BALL_ACTIVITY_GET_SCORE_REWARD，V1 PB，嵌套 activityId/index:-1；弹珠循环奖励。
 *   8768/8795/8833，V2 PB，{activityId,index:-1}；大富翁/联盟远征/舞狮循环奖励。
 *   8768 额外要求在盟且未达 bullet_boss_reward_limit[2] 的领取上限。
 *
 * 安全边界：只领 task[]/atarget[].state=1 的已完成任务、普通积分档、已解锁高级免费档，
 * 以及活动快照自带状态可证明的专用免费奖励；联盟 BP 与大富翁在明确退盟时跳过；
 * 未知联盟态沿用 ACL 三态放行惯例。
 * 不调用 1674 解锁高级奖励，不翻牌、不开箱、不兑换、不购买、不消耗道具。需要独立状态查询、
 * 本地配置表或账号道具余额的专用按钮未接入，不能仅凭按钮文案猜测可领状态。
 *
 * 感知：全部走 core/activity-hub（841 快照 + 10904/10912 合并 + 3103 重查）；本文件不再订阅推送、
 * 不再发 841/3103。attach 声明 30s 周期档，连续 IDLE_ROUNDS 轮无待领后把档位放宽到 IDLE_SCAN_MS
 * （3min）并在出现可领项时立即恢复；watch 命中任意活动变化即 cycle.kick（推送唤醒不受睡眠影响，
 * 可领判据本身就按 showUiType/分支白名单收敛在 model.js，订阅侧不做二次过滤）。
 * 领取：全部走 core/claim-runner（在途闸门/业务拒绝 15 分钟/无进展 20s–5min 指数退避）；
 * 本文件只提供可领判据（model.js）、协议载荷与阶段顺序。
 *
 * 闭环与防重：hub 快照 → 按 model.js 判据领取 → hub.refresh(aid, {force:true}) 权威确认。
 * 通用任务逐个领取并在每次重查后继续权威剩余任务；聚合/专用奖励每类每轮最多尝试一次，
 * 重查仍有可领项则下轮再试，不把 ok 回执当成“已全部领完”。
 * CODE_NOT_SENT 短重试且停止本轮后续写请求；业务拒绝按任务/活动退避后继续其它可领项。
 * 所有 await 后校验本轮 signal，pause/resume 或跨活动结束后的旧回执不会继续发包。
 */
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { activityHub } from '../../../core/activity-hub.js';
import { createClaimRunner } from '../../../core/claim-runner.js';
import { bus, EVT } from '../../../core/bus.js';
import {
  CMD_GET_ACTIVITY_REWARD,
  CMD_GET_ALL_SCORE_REWARD,
  CMD_GET_ALL_TASK_REWARD,
  CMD_LION_FIGHT_GET_ALL_LOOP_REWARD,
  CMD_MAKESHIFTBAG_RECEIVE_ALL,
  CMD_PIN_BALL_GET_ALL_LOOP_REWARD,
  CMD_RICH_MAN_GET_ALL_LOOP_REWARD,
  CMD_TEAM_EXPEDITION_GET_ALL_LOOP_REWARD,
} from './constants.js';
import {
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
/** @type {string} hub 订阅标识（attach/watch/tune 共用的引用标签） */
const TAG = 'super-value-gift';
/** @type {number} 活跃态的周期 841 档位与休息拍（毫秒） */
const SCAN_TICK_MS = 1000 * 30;
/** @type {number} 连续无待领达到该轮次后放宽周期 841 档位（空闲退避） */
const IDLE_ROUNDS = 3;
/** @type {number} 空闲期周期 841 档位（毫秒）；推送唤醒不受影响 */
const IDLE_SCAN_MS = 1000 * 60 * 3;
/** @type {number} 未发出、拒绝或重查无进展后的短重试（毫秒） */
const RETRY_TICK_MS = 1000 * 20;
/** @type {number} 服务器时钟不可用时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;
/** @type {number} 确认领取后的快速复扫间隔（毫秒） */
const RESCAN_MS = 1000;
/** @type {number} 两次领取的最小间隔；runner 统一节奏，防服务端写频控 */
const CLAIM_GAP_MS = 1500;
/** @type {number} 确定性业务拒绝的会话退避（毫秒），与 runner 默认值显式对齐 */
const BUSINESS_RETRY_MS = 1000 * 60 * 15;
/** @type {number} 成功回执但权威重查无进展的基础退避（毫秒） */
const NO_PROGRESS_BASE_MS = 1000 * 20;
/** @type {number} 重查无进展退避上限（毫秒），避免活动结束前永久不再尝试 */
const NO_PROGRESS_MAX_MS = 1000 * 60 * 5;

/** @type {object|null} reactor 上下文 */
var ctxRef = null;
/** @type {function():void|null} hub attach 的 detach */
var detachHub = null;
/** @type {function():void|null} hub watch 的退订 */
var unwatchHub = null;
/** @type {object|null} 领取执行器（install 时创建；测试可注入时钟与节奏） */
var runner = null;
/** @type {number} 本轮已由权威重查确认推进的领取批次数 */
var lastClaimed = 0;
/** @type {boolean} 最近一轮是否存在需要重试的瞬态/拒绝/无进展 */
var lastRetry = false;
/** @type {number} 最近一次扫描发现的待领活动数 */
var pendingCount = 0;
/** @type {number} 连续无待领轮次（达到 IDLE_ROUNDS 后放宽 841 档位） */
var idleStreak = 0;
/** @type {number} 当前向 hub 声明的周期 841 档位（毫秒） */
var scanTierMs = SCAN_TICK_MS;
/** @type {string} 上次 UI_REFRESH 时的面板状态签名（去抖：状态未变不重复通知） */
var lastUiState = '';

/**
 * 领取退避键；活动 ID 始终按字符串拼接，避免 Int64 精度碰撞。
 * 与迁移前 `cmd:activityId[:targetId]` 完全一致，prune 解析口径不变。
 * 通用任务 842 使用 targetId 后缀，避免单个任务拒绝冻结同活动其它任务。
 * @param {number} cmd 协议号
 * @param {string|number} aid 活动 ID
 * @param {string|number|null} [targetId] 可选任务 ID
 * @returns {string}
 */
function cooldownKey(cmd, aid, targetId) {
  const base = cmd + ':' + String(aid);
  return targetId == null ? base : base + ':' + String(targetId);
}

/**
 * 创建领取执行器并注册全部协议 handler（每进程一次）。
 * @param {object} [opt] runner 覆盖项（单测注入 actionGapMs=0 与假时钟）
 */
function ensureRunner(opt) {
  if (runner) return;
  runner = createClaimRunner(
    Object.assign(
      {
        log: log,
        actionGapMs: CLAIM_GAP_MS,
        businessBackoffMs: BUSINESS_RETRY_MS,
        noProgressBaseMs: NO_PROGRESS_BASE_MS,
        noProgressMaxMs: NO_PROGRESS_MAX_MS,
      },
      opt || {},
    ),
  );
  runner.register(CMD_GET_ALL_SCORE_REWARD, {
    label: 'score-rewards',
    protocol: 'send',
    body: function (item) {
      return { id: item.aid };
    },
    key: function (item) {
      return cooldownKey(CMD_GET_ALL_SCORE_REWARD, item.aid);
    },
  });
  runner.register(CMD_GET_ALL_TASK_REWARD, {
    label: 'alliance-tasks',
    protocol: 'send',
    body: function (item) {
      return { activityId: item.aid, targetIds: item.targetIds };
    },
    key: function (item) {
      return cooldownKey(CMD_GET_ALL_TASK_REWARD, item.aid);
    },
  });
  runner.register(CMD_GET_ACTIVITY_REWARD, {
    label: 'task',
    protocol: 'send',
    body: function (item) {
      return { aid: item.aid, tid: item.tid };
    },
    key: function (item) {
      return cooldownKey(CMD_GET_ACTIVITY_REWARD, item.aid, item.targetId);
    },
  });
  const specials = [
    { cmd: CMD_MAKESHIFTBAG_RECEIVE_ALL, label: 'makeshift-bag', protocol: 'send' },
    { cmd: CMD_PIN_BALL_GET_ALL_LOOP_REWARD, label: 'pin-ball', protocol: 'sendPB' },
    { cmd: CMD_RICH_MAN_GET_ALL_LOOP_REWARD, label: 'rich-man', protocol: 'sendPBV2' },
    {
      cmd: CMD_TEAM_EXPEDITION_GET_ALL_LOOP_REWARD,
      label: 'team-expedition',
      protocol: 'sendPBV2',
    },
    { cmd: CMD_LION_FIGHT_GET_ALL_LOOP_REWARD, label: 'lion-fight', protocol: 'sendPBV2' },
  ];
  for (const special of specials) {
    runner.register(special.cmd, {
      label: special.label,
      protocol: special.protocol,
      body: function (item) {
        return item.body || {};
      },
      key: function (item) {
        return cooldownKey(special.cmd, item.aid);
      },
    });
  }
}

/**
 * 每轮全量快照后清理已结束或已无可领项的退避，换活动/换日不残留。
 * @param {object[]} open 当前开放活动
 * @param {boolean|null} inAlliance 当前联盟状态
 */
function pruneClaimCooldowns(open, inAlliance) {
  if (!runner) return;
  runner.prune(function (key) {
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
    return pending > 0;
  });
}

/** @returns {boolean} 当前 reactor 功能是否存活 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 切换向 hub 声明的周期 841 档位（实际周期仍取全订阅者最小非零值）。
 * 只在档位变化时调 hub.tune：空闲期把全量 841 从 30s 放宽到 3min，减少大包空转。
 * @param {number} ms 目标档位（毫秒）
 */
function applyScanTier(ms) {
  if (scanTierMs === ms) return;
  scanTierMs = ms;
  const hit = activityHub.tune(TAG, ms);
  log.info('periodic scan tier -> %d sec. hubRefs=%d', ms / 1000, hit);
}

/**
 * 面板状态去抖：文案三要素（最近领取/等待重试/待领数）未变时不重复 emit。
 * 空闲期每轮都 emit 会触发面板 refreshTexts / 闸门重算等 DOM 刷新（实测约 180 次/小时）。
 */
function emitUiIfChanged() {
  const state = lastClaimed + '|' + (lastRetry ? 1 : 0) + '|' + pendingCount;
  if (state === lastUiState) return;
  lastUiState = state;
  bus.emit(EVT.UI_REFRESH);
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
 * 领取受理后的权威确认：3103 单查走 hub（force 跳过 3s 节流，单飞不动）。
 * fresh=false 表示没拿到可信的权威应答（未发出/被拒/畸形/节流），调用方按验证失败处理：
 * 仅下轮重试，不记无进展退避；fresh=true 才按权威剩余可领项判定「确认领取」或「无进展」。
 * @param {string|number} aid 活动 ID
 * @returns {Promise<{ok:boolean,activity:object|null}>}
 */
async function refreshActivity(aid) {
  const result = await activityHub.refreshEx(aid, { force: true });
  if (!result.fresh) log.warn('cmd 3103 verification unavailable. requestedId=%s', aid);
  return { ok: result.fresh, activity: result.activity };
}

/**
 * 处理一个活动：积分档 1777、联盟 BP 3140、通用任务 842、专用全部/循环全部领取逐项执行。
 * 每个写请求前重读服务器时间与联盟态；每次成功后用 hub.refresh 权威重查，不以回执认定全部领完。
 * 通用任务按权威剩余列表逐个领取；聚合奖励同一活动同一轮不重复，重查仍有待领项时下轮再试。
 * @param {object} activity hub 快照中的活动
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
  if (scores.length) {
    const item = { cmd: CMD_GET_ALL_SCORE_REWARD, aid: aid };
    log.debug('cmd 1777 claimable score tiers. activityId=%s;tiers=%s', aid, scores.join(','));
    const ret = await runner.claim(Object.assign({}, item, { signal: signal }));
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (ret.status === 'suppressed') {
      result.retry = true;
    } else if (ret.status !== 'ok') {
      result.retry = true;
      if (ret.status === 'rejected') {
        runner.suppress(item);
      } else {
        result.stop = true;
      }
      return result;
    } else {
      const after = await refreshActivity(aid);
      if (!roundAlive(signal)) {
        result.stop = true;
        return result;
      }
      if (!after.ok) {
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
        runner.confirm(item);
        log.info('cmd 1777 score rewards confirmed. activityId=%s', aid);
      } else {
        runner.noProgress(item);
        log.debug(
          'cmd 1777 accepted but score tiers remain=%d; re-scan before retry. activityId=%s',
          remaining,
          aid,
        );
        result.retry = true;
      }
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
    const item = { cmd: CMD_GET_ALL_TASK_REWARD, aid: aid, targetIds: taskTargets };
    log.debug('cmd 3140 claimable tasks. activityId=%s;count=%d', aid, taskTargets.length);
    const ret = await runner.claim(Object.assign({}, item, { signal: signal }));
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (ret.status === 'suppressed') {
      result.retry = true;
    } else if (ret.status !== 'ok') {
      result.retry = true;
      if (ret.status === 'rejected') {
        runner.suppress(item);
      } else {
        result.stop = true;
      }
      return result;
    } else {
      const after = await refreshActivity(aid);
      if (!roundAlive(signal)) {
        result.stop = true;
        return result;
      }
      if (!after.ok) {
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
        log.debug('cmd 3140 accepted; activity closed before verification. activityId=%s', aid);
        return result;
      }
      const remaining = claimableAllianceTaskIds(current, gameData.inAlliance()).length;
      if (remaining === 0) {
        result.claimed++;
        runner.confirm(item);
        log.info(
          'cmd 3140 alliance BP tasks confirmed. activityId=%s;tasks=%d',
          aid,
          taskTargets.length,
        );
      } else {
        runner.noProgress(item);
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
    if (skippedTaskKeys.has(tidKey)) {
      genericTaskTargets = genericTaskTargets.filter((id) => String(id) !== tidKey);
      continue;
    }
    const item = { cmd: CMD_GET_ACTIVITY_REWARD, aid: aid, targetId: tidKey, tid: tid };
    const pendingBefore = claimableGenericTaskIds(current).length;
    log.debug('cmd 842 claimable generic task. activityId=%s;targetId=%s', aid, tid);
    const ret = await runner.claim(Object.assign({}, item, { signal: signal }));
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (ret.status === 'suppressed') {
      skippedTaskKeys.add(tidKey);
      genericTaskTargets = genericTaskTargets.filter((id) => String(id) !== tidKey);
      result.retry = true;
      continue;
    }
    if (ret.status === 'rejected') {
      result.retry = true;
      runner.suppress(item);
      skippedTaskKeys.add(tidKey);
      genericTaskTargets = genericTaskTargets.filter((id) => String(id) !== tidKey);
      continue;
    }
    if (ret.status !== 'ok') {
      result.retry = true;
      result.stop = true;
      return result;
    }
    const afterGeneric = await refreshActivity(aid);
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!afterGeneric.ok) {
      // 842 是逐个任务领取：确认失败时只退避该任务，避免下轮对同一任务连发。
      runner.noProgress(item);
      log.warn('cmd 3103 post-842 verification unavailable. activityId=%s;targetId=%s', aid, tid);
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
      runner.confirm(item);
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
    runner.noProgress(item);
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
    const item = { cmd: plan.cmd, aid: aid, body: plan.body };
    log.debug('cmd %d special rewards claimable. activityId=%s', plan.cmd, aid);
    const ret = await runner.claim(Object.assign({}, item, { signal: signal }));
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (ret.status === 'suppressed') {
      result.retry = true;
      continue;
    }
    if (ret.status !== 'ok') {
      result.retry = true;
      if (ret.status === 'rejected') {
        runner.suppress(item);
      } else {
        result.stop = true;
      }
      return result;
    }
    const afterSpecial = await refreshActivity(aid);
    if (!roundAlive(signal)) {
      result.stop = true;
      return result;
    }
    if (!afterSpecial.ok) {
      log.warn('cmd 3103 post-%d verification unavailable. activityId=%s', plan.cmd, aid);
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
    const remaining = claimableSpecialRewards(current, gameData.inAlliance()).some(
      function (entry) {
        return entry.key === plan.key;
      },
    );
    if (!remaining) {
      result.claimed++;
      runner.confirm(item);
      log.info('cmd %d special rewards confirmed. activityId=%s', plan.cmd, aid);
    } else {
      runner.noProgress(item);
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
 * cycle 单轮：读 hub 快照 → 逐活动领取 → hub.refresh 权威确认 → 动态择时。
 * 全量 841 不再由本文件发出：hub attach(30s) 周期扫描 + 10904/10912 推送合并共同维护快照。
 * @returns {Promise<number>} 下次唤醒毫秒
 */
async function cycleRun() {
  const signal = ctxRef ? ctxRef.signal : null;
  const now = gameData.serverTime();
  if (!now) {
    log.debug('claim idle: server time unavailable.');
    return IDLE_TICK_MS;
  }
  lastClaimed = 0;
  lastRetry = false;
  const snapshotNow = gameData.serverTime();
  if (!snapshotNow) {
    log.debug('claim idle: server time unavailable after snapshot.');
    return IDLE_TICK_MS;
  }
  const allianceState = gameData.inAlliance();
  const open = activityHub.list().filter(function (activity) {
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
    idleStreak++;
    if (idleStreak >= IDLE_ROUNDS) applyScanTier(IDLE_SCAN_MS);
    log.debug(
      'claim scan skipped: no claimable reward in open activities. open=%d;idleStreak=%d',
      open.length,
      idleStreak,
    );
    emitUiIfChanged();
    return cycle.pending ? RESCAN_MS : scanTierMs;
  }
  idleStreak = 0;
  applyScanTier(SCAN_TICK_MS);
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
    emitUiIfChanged();
    return RESCAN_MS;
  }
  emitUiIfChanged();
  if (cycle.pending) return RESCAN_MS;
  return lastRetry ? RETRY_TICK_MS : SCAN_TICK_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: RETRY_TICK_MS });

/**
 * hub 订阅回调：任意活动变化（841 首扫/周期扫描、10904/10912 推送、3103 重查）只负责唤醒；
 * 可领状态仍以 cycleRun 里对 hub 快照的 model 判定为准。
 * @param {object} activity 变化的活动
 * @param {string} reason 变化来源
 */
function onActivityChange(activity, reason) {
  if (!aliveFn()) return;
  // 841 首扫/周期扫描会把快照里每个活动各回调一次（30+ 条/轮），watch 首挂同理：
  // 二者都不逐条打点，只对真正的推送/重查留痕；kick 在飞时只置 pending，本就无需逐活动记录。
  if (reason !== 'scan' && reason !== 'watch') {
    log.debug(
      'activity push woke scan. activityId=%s;reason=%s',
      activity && activity.id != null ? activity.id : '-',
      reason || '-',
    );
  }
  cycle.kick();
}

/**
 * 安装网络底座并创建领取执行器（协议注册只需一次）。
 * @param {object} ctx reactor 上下文
 * @param {object} [opt] runner 覆盖项（单测专用：注入时钟与零节奏）
 * @returns {boolean}
 */
function install(ctx, opt) {
  ctxRef = ctx;
  const net = ctx.net;
  if (!net || !net.install()) {
    log.warn('install failed: pocketcc.net unavailable.');
    return false;
  }
  ensureRunner(opt);
  log.info('installed.');
  return true;
}

/**
 * 每次激活复位展示状态、attach hub（30s 兜底档）+ watch 全活动，立即扫描；
 * pause 后旧轮由 signal 拦截。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  lastClaimed = 0;
  lastRetry = false;
  pendingCount = 0;
  idleStreak = 0;
  scanTierMs = SCAN_TICK_MS;
  lastUiState = '';
  // 每次激活清空会话退避与节奏时间戳（重新开启不应被旧拉黑压制）
  if (runner) runner.reset();
  if (detachHub) detachHub();
  if (unwatchHub) unwatchHub();
  detachHub = activityHub.attach({ label: TAG, scanIntervalMs: SCAN_TICK_MS });
  unwatchHub = activityHub.watch(
    function () {
      return true; // 分支白名单在 model.js，订阅侧不做二次过滤
    },
    onActivityChange,
    { label: TAG },
  );
  log.info('started; scan all open activities every %d sec.', SCAN_TICK_MS / 1000);
  cycle.kick();
}

/**
 * 暂停：释放 hub 引用与订阅；cycle 在 alive 检查处自然停摆。
 */
function pause() {
  if (unwatchHub) {
    unwatchHub();
    unwatchHub = null;
  }
  if (detachHub) {
    detachHub();
    detachHub = null;
  }
  log.info('paused.');
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
  pause: pause,
});

export { cycleRun, install as installForTest };
/** 单测专用：复位展示状态并清空会话退避，不启动 cycle。 */
export function resetForTest() {
  lastClaimed = 0;
  lastRetry = false;
  pendingCount = 0;
  idleStreak = 0;
  scanTierMs = SCAN_TICK_MS;
  lastUiState = '';
  if (runner) runner.reset();
}
