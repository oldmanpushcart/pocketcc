/**
 * 超值活动快照的纯状态投影；不访问游戏符号、不发包、不持久化。
 *
 * 积分档判据逐项对齐公开客户端 DoubleBpModel.getBpRewardRedNum：
 *   type 0：普通积分 extra.sc 达到 pt，且 pt 不在 extra.rp；
 *   type 1：adv>0（仅领取已解锁档），且 pt 不在 extra.rap；
 *   type 2/6：super_adv>0（仅领取已解锁档），且 pt 不在 extra.receive_super_adv_point。
 * 客户端把 type 6 归一为 type 2；其余类型不是 1777 的通用积分档，保守跳过。
 * 1777 请求体没有 adv 参数，高级档筛选只能由发包方完成，绝不能为了领免费档发送解锁请求。
 * ActivityAllianceBP 的积分/任务入口在明确退盟时跳过；未知联盟态沿用 ACL 三态放行惯例。
 * 其他分支活动的 task[]/atarget[].state=1 任务统一走公开客户端 ActivityController.getActivityReward
 * 的 842 {aid,tid}；联盟 BP 仍优先使用其任务页专用的 3140 批量请求。请求中的任务 ID 保留线路
 * 原始类型：公开客户端直接推送快照里的 id，数字 ID 不得先转字符串，否则服务端会按参数错误拒绝。
 *
 * 时间、分数、计数与字符串配置均做严格类型校验；null/布尔/数组/负数计数不按客户端默认值兜底。
 * 8768 的循环项对齐公开客户端 updateMonsterRewardProgeress：需在盟、伤害达标、仍有轮次，
 * 且 a_reward_num < act_paras.bullet_boss_reward_limit[2]；配置缺失时 fail-closed。
 */

import {
  ALLIANCE_BP_UI_TYPE,
  CMD_LION_FIGHT_GET_ALL_LOOP_REWARD,
  CMD_MAKESHIFTBAG_RECEIVE_ALL,
  CMD_PIN_BALL_GET_ALL_LOOP_REWARD,
  CMD_RICH_MAN_GET_ALL_LOOP_REWARD,
  CMD_TEAM_EXPEDITION_GET_ALL_LOOP_REWARD,
  LION_FIGHT_UI_TYPE,
  MAKESHIFT_BAG_UI_TYPE,
  PIN_BALL_UI_TYPE,
  RICH_MAN_UI_TYPE,
  TASK_STATE_FINISHED,
  TEAM_EXPEDITION_UI_TYPE,
} from './constants.js';

/**
 * 活动/任务 ID 的线路形态；保留原始类型，但拒绝布尔、对象、负数与已溢出 Number。
 * @param {*} value 原始 ID
 * @returns {boolean}
 */
function isValidId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 活动是否处于客户端使用的严格开放窗口。
 * @param {object} activity 841/3103 原始活动对象
 * @param {number} now 服务器时间（秒）
 * @returns {boolean}
 */
export function isActivityOpen(activity, now) {
  if (!activity || !isValidId(activity.id)) return false;
  const begin = finiteNumber(activity.begintime);
  const end = finiteNumber(activity.endtime);
  const current = finiteNumber(now);
  return Number.isFinite(begin) && Number.isFinite(end) && current > begin && current < end;
}

/**
 * 列表成员按字符串归一，兼容 Int64 的数值/字符串两种线路形态。
 * 缺失列表按客户端默认空列表处理；已存在但不是合法数组时 fail-closed。
 * @param {*} value 原始列表
 * @returns {Set<string>|null}
 */
function stringSet(value) {
  if (value == null) return new Set();
  if (!Array.isArray(value)) return null;
  const out = new Set();
  for (const item of value) {
    const num = finiteCount(item);
    if (!Number.isFinite(num)) return null;
    out.add(String(num));
  }
  return out;
}

/**
 * 当前可由 1777 安全领取的积分档分数；只返回分数，不在请求体里额外添加客户端没有的字段。
 * @param {object} activity 活动快照
 * @param {boolean|null} [inAlliance] 联盟状态；联盟 BP 在明确退盟时跳过，null 表示 ACL 无从判定
 * @returns {number[]} 已达成且未领取的 pt，按配置顺序
 */
export function claimableScoreTiers(activity, inAlliance = null) {
  if (inAlliance === false && activity && activity.showUiType === ALLIANCE_BP_UI_TYPE) return [];
  if (!activity || !Array.isArray(activity.point)) return [];
  const extra = activity.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return [];
  const score = finiteNumber(extra.sc);
  if (!Number.isFinite(score) || score < 0) return [];
  const normalReceived = stringSet(extra.rp);
  const advancedReceived = stringSet(extra.rap);
  const superReceived = stringSet(extra.receive_super_adv_point);
  if (!normalReceived || !advancedReceived || !superReceived) return [];
  const advancedUnlocked = finiteCount(activity.adv) > 0;
  const superUnlocked = finiteCount(activity.super_adv) > 0;
  const out = [];
  const seen = new Set();
  for (const tier of activity.point) {
    if (!tier || tier.pt == null || tier.type == null) continue;
    const pt = finiteNumber(tier.pt);
    const type = finiteNumber(tier.type);
    if (!Number.isFinite(pt) || pt < 0 || !Number.isFinite(type)) continue;
    const key = String(pt);
    if (seen.has(key)) continue;
    seen.add(key);
    const claimable =
      score >= pt &&
      ((type === 0 && !normalReceived.has(key)) ||
        (type === 1 && advancedUnlocked && !advancedReceived.has(key)) ||
        ((type === 2 || type === 6) && superUnlocked && !superReceived.has(key)));
    if (claimable) out.push(pt);
  }
  return out;
}

/**
 * 提取指定任务列表中已完成的原始任务 ID；保留数字/字符串线路类型，不做 Number/String 转换。
 * 公开客户端 842/3140 都直接发送快照中的 id；数字 ID 转字符串会触发服务端参数校验。
 * @param {object} activity 841/3103 活动快照
 * @param {'task'|'atarget'} field 客户端任务列表字段
 * @returns {Array<string|number>} 已完成任务 ID，按配置顺序并以字符串键去重
 */
export function claimableTaskTargets(activity, field) {
  if (!activity || (field !== 'task' && field !== 'atarget')) return [];
  const tasks = activity[field];
  if (!Array.isArray(tasks)) return [];
  const out = [];
  const seen = new Set();
  for (const task of tasks) {
    if (!task || !isValidId(task.id) || finiteCount(task.state) !== TASK_STATE_FINISHED) continue;
    const key = String(task.id);
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(task.id);
  }
  return out;
}

/**
 * 通用已完成任务的规范化键；退避/去重按字符串比较，发包仍使用 claimableTaskTargets 的原始 ID。
 * @param {object} activity 841/3103 活动快照
 * @returns {string[]} 已完成 task 任务 ID 的字符串键
 */
export function claimableTaskIds(activity) {
  return claimableTaskTargets(activity, 'task').map(String);
}

/**
 * 联盟 BP 任务页“全部领取”对应的原始任务 ID。
 * @param {object} activity 活动快照
 * @param {boolean|null} [inAlliance] 联盟状态；false 明确不在盟时跳过，null 表示 ACL 无从判定
 * @returns {Array<string|number>} 按配置顺序且去重后的 targetIds
 */
export function claimableAllianceTaskTargets(activity, inAlliance = null) {
  if (inAlliance === false || !activity || activity.showUiType !== ALLIANCE_BP_UI_TYPE) {
    return [];
  }
  return claimableTaskTargets(activity, 'task');
}

/**
 * 联盟 BP 任务页“全部领取”对应的规范化任务键。
 * @param {object} activity 活动快照
 * @param {boolean|null} [inAlliance] 联盟状态；false 明确不在盟时跳过，null 表示 ACL 无从判定
 * @returns {string[]} 按配置顺序且去重后的任务键
 */
export function claimableAllianceTaskIds(activity, inAlliance = null) {
  return claimableAllianceTaskTargets(activity, inAlliance).map(String);
}

/**
 * 除联盟 BP 专用批量入口外，所有分支活动的原始通用任务 ID。
 * 旧版分支使用 atarget，新版任务页使用 task；两者都是 842 的真实按钮数据源，合并后按字符串键去重。
 * 联盟 BP 不落入 842，避免与其任务页 3140 的语义和退避键重复。
 * @param {object} activity 活动快照
 * @returns {Array<string|number>} 按 task → atarget 配置顺序且去重后的任务 ID
 */
export function claimableGenericTaskTargets(activity) {
  if (!activity || activity.showUiType === ALLIANCE_BP_UI_TYPE) return [];
  const targets = claimableTaskTargets(activity, 'task');
  const seen = new Set(targets.map(String));
  for (const id of claimableTaskTargets(activity, 'atarget')) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(id);
  }
  return targets;
}

/**
 * 所有分支通用已完成任务的规范化键，用于计数、比较和退避。
 * @param {object} activity 活动快照
 * @returns {string[]} 按 task → atarget 配置顺序且去重后的任务键
 */
export function claimableGenericTaskIds(activity) {
  return claimableGenericTaskTargets(activity).map(String);
}

/**
 * 读取有限数值；仅接受 JSON 数值或非空数字串，拒绝 null、布尔、数组和对象。
 * @param {*} value 原始字段
 * @returns {number} 有限数值，非法时 NaN
 */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

/**
 * 读取非负安全整数；计数与轮次不得出现负数、小数或溢出。
 * @param {*} value 原始字段
 * @returns {number} 合法计数，非法时 NaN
 */
function finiteCount(value) {
  const num = finiteNumber(value);
  return Number.isSafeInteger(num) && num >= 0 ? num : NaN;
}

/**
 * 拆分客户端字符串配置；数组、布尔和对象不得通过 String() 伪装成合法配置。
 * @param {*} value 原始配置
 * @param {string} separator 分隔符
 * @returns {string[]}
 */
function configParts(value, separator) {
  return typeof value === 'string' ? value.split(separator) : [];
}

/**
 * 活动 extra 对象；数组和标量不是有效状态投影。
 * @param {object} activity 活动快照
 * @returns {object}
 */
function extraObject(activity) {
  const extra = activity && activity.extra;
  return extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
}

/**
 * 3135 的未领状态必须显式存在；缺失字段不能按 falsy 误判为待领。
 * @param {*} rewarded 原始领取标记
 * @returns {boolean}
 */
function isUnrewarded(rewarded) {
  return rewarded === false || rewarded === 0 || rewarded === '0';
}

/**
 * 专用“全部/循环全部”领取计划；请求形态与协议通道均来自公开 H5 客户端真实按钮。
 * 仅使用 841/3103 自带状态，不读账号道具、不调本地配置表、不发送解锁/消耗请求。
 * 每个 showUiType 至多产生一个计划；配置缺失或状态非法时 fail-closed。
 * @param {object} activity 活动快照
 * @param {boolean|null} [inAlliance] 联盟状态；false 时跳过有联盟入口门控的弹珠活动
 * @returns {Array<{key:number,cmd:number,protocol:string,body:object}>}
 */
export function claimableSpecialRewards(activity, inAlliance = null) {
  if (!activity || !isValidId(activity.id)) return [];
  const aid = String(activity.id);
  const extra = extraObject(activity);
  const type = activity.showUiType;

  if (type === MAKESHIFT_BAG_UI_TYPE) {
    let pending = false;
    for (const key of Object.keys(extra)) {
      if (!/^\d+$/.test(key)) continue;
      const entry = extra[key];
      if (
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        isUnrewarded(entry.rewarded)
      ) {
        pending = true;
        break;
      }
    }
    return pending
      ? [
          {
            key: CMD_MAKESHIFTBAG_RECEIVE_ALL,
            cmd: CMD_MAKESHIFTBAG_RECEIVE_ALL,
            protocol: 'send',
            body: { rewardCenterAid: aid, rewardAid: -1 },
          },
        ]
      : [];
  }

  if (type === PIN_BALL_UI_TYPE) {
    if (inAlliance === false) return [];
    const cfg = configParts(activity.type_para9, '|');
    const needScore = finiteNumber(cfg[0]);
    const step = finiteNumber(cfg[1]);
    const max = finiteCount(cfg[3]);
    const tasks = Array.isArray(extra.task_info) ? extra.task_info : [];
    const last = tasks[tasks.length - 1];
    const lastTarget = last ? finiteNumber(last.t_a_score) : NaN;
    const score = finiteNumber(extra.score);
    const allianceScore = finiteNumber(extra.a_score);
    const received = finiteCount(extra.has_receive_loop_num);
    const claimable =
      step > 0 &&
      Number.isFinite(max) &&
      Number.isFinite(needScore) &&
      needScore >= 0 &&
      Number.isFinite(lastTarget) &&
      lastTarget >= 0 &&
      Number.isFinite(score) &&
      score >= 0 &&
      Number.isFinite(allianceScore) &&
      allianceScore >= 0 &&
      Number.isFinite(received) &&
      score >= needScore &&
      allianceScore >= lastTarget &&
      received < max &&
      Math.floor((allianceScore - lastTarget) / step) - received > 0;
    return claimable
      ? [
          {
            key: CMD_PIN_BALL_GET_ALL_LOOP_REWARD,
            cmd: CMD_PIN_BALL_GET_ALL_LOOP_REWARD,
            protocol: 'sendPB',
            body: {
              header: {},
              pinBallActivityGetScoreReward: { activityId: aid, index: -1 },
            },
          },
        ]
      : [];
  }

  if (type === RICH_MAN_UI_TYPE) {
    if (inAlliance === false) return [];
    const needDamage = finiteNumber(activity.type_para9);
    const weakTimes = finiteCount(extra.a_boss_weak_times);
    const received = finiteCount(extra.a_reward_num);
    const damage = finiteNumber(extra.a_boss_damage);
    const actParas = activity.act_paras;
    const limits =
      actParas && typeof actParas === 'object' && !Array.isArray(actParas)
        ? configParts(actParas.bullet_boss_reward_limit, '|')
        : [];
    const max = finiteCount(limits[2]);
    const claimable =
      Number.isFinite(needDamage) &&
      needDamage >= 0 &&
      Number.isFinite(weakTimes) &&
      Number.isFinite(received) &&
      Number.isFinite(damage) &&
      damage >= 0 &&
      Number.isFinite(max) &&
      received < max &&
      weakTimes - received - 1 > 0 &&
      damage >= needDamage;
    return claimable
      ? [
          {
            key: CMD_RICH_MAN_GET_ALL_LOOP_REWARD,
            cmd: CMD_RICH_MAN_GET_ALL_LOOP_REWARD,
            protocol: 'sendPBV2',
            body: { activityId: aid, index: -1 },
          },
        ]
      : [];
  }

  if (type === TEAM_EXPEDITION_UI_TYPE) {
    const targets = configParts(activity.para6, '|');
    const loop = configParts(activity.type_para10, '|');
    const lastTarget = finiteNumber(targets[targets.length - 1]);
    const step = finiteNumber(loop[0]);
    const teamScore = finiteNumber(extra.teamScore);
    const received = finiteCount(extra.overRewardNum);
    const claimable =
      extra.haveTeam === true &&
      step > 0 &&
      Number.isFinite(lastTarget) &&
      lastTarget >= 0 &&
      Number.isFinite(teamScore) &&
      teamScore >= 0 &&
      Number.isFinite(received) &&
      teamScore > lastTarget &&
      Math.floor((teamScore - lastTarget) / step) - received > 0;
    return claimable
      ? [
          {
            key: CMD_TEAM_EXPEDITION_GET_ALL_LOOP_REWARD,
            cmd: CMD_TEAM_EXPEDITION_GET_ALL_LOOP_REWARD,
            protocol: 'sendPBV2',
            body: { activityId: aid, index: -1 },
          },
        ]
      : [];
  }

  if (type === LION_FIGHT_UI_TYPE) {
    const tiers = configParts(activity.type_para9, '|');
    const last = finiteNumber(configParts(tiers[tiers.length - 1], ',')[0]);
    const loop = configParts(activity.type_para10, ',');
    const step = finiteNumber(loop[0]);
    const max = finiteCount(loop[2]);
    const fireScore = finiteNumber(extra.fireScore);
    const received = finiteCount(extra.fireOverNum);
    const claimable =
      step > 0 &&
      Number.isFinite(last) &&
      last >= 0 &&
      Number.isFinite(max) &&
      Number.isFinite(fireScore) &&
      fireScore >= 0 &&
      Number.isFinite(received) &&
      fireScore >= last &&
      fireScore - last >= step * (received + 1) &&
      received < max;
    return claimable
      ? [
          {
            key: CMD_LION_FIGHT_GET_ALL_LOOP_REWARD,
            cmd: CMD_LION_FIGHT_GET_ALL_LOOP_REWARD,
            protocol: 'sendPBV2',
            body: { activityId: aid, index: -1 },
          },
        ]
      : [];
  }

  return [];
}
