/**
 * activity/city-award · 可领判定（纯函数，单测直驱）。
 *
 * 对齐官方 subpack/ActivityWorldCityAwardNode：
 *   can_receive_uid_list  → 可领城市玩家 uid 列表（服务端权威）
 *   reward_received_list  → 已领 uid 列表
 *   可领 = can − recv；paramData.allAwardCount > 0 时再受「已领数 < 上限」约束。
 * 三个复用活动只有胜利庆典额外要求 extra.state===3（组件由 createActDragonkingDuelAwardNode 挂载时先判结算态），
 * 军事演习 / 势力检阅 无结算态判据，只认差集。
 */
import { CITY_AWARD_UI_TYPES, SHOW_UI_TYPE_KING_DUEL } from './constants.js';

/**
 * 归一 uid 列表：去空、去重、统一字符串（Int64 精度只保字符串形态）。
 * @param {*} v 原始数组
 * @returns {string[]}
 */
function uidList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const uid = v[i] == null ? '' : String(v[i]);
    if (uid && out.indexOf(uid) < 0) out.push(uid);
  }
  return out;
}

/**
 * 是否本框架负责的活动（showUiType 命中三选一）。
 * @param {object} activity 活动对象
 * @returns {boolean}
 */
export function isCityAwardActivity(activity) {
  return !!activity && CITY_AWARD_UI_TYPES.indexOf(activity.showUiType) >= 0;
}

/**
 * 每人可领城市数上限：官方从挂载参数 paramData.allAwardCount 读，三活动挂载时都没传（=0 无上限）；
 * 兼容把参数平铺到活动对象的未来形态，两处都认，非法值回 0。
 * @param {object} activity 活动对象
 * @returns {number} 0=无上限
 */
export function awardUpperLimit(activity) {
  const src = activity && (activity.paramData || activity);
  const n = Number(src && src.allAwardCount);
  return n > 0 ? n : 0;
}

/**
 * 胜利庆典是否已进入可领结算态，且本服是获胜服。
 * 「无从判定」一律放行（state/winSid/my.sid 缺失时不误杀），只拦实证反例：
 * state 存在且 != 3；或 winSid 与 my.sid 都存在且不等（本服未获胜）。
 * @param {object} activity 活动对象
 * @returns {boolean}
 */
export function kingDuelSettled(activity) {
  const extra = (activity && activity.extra) || {};
  if (extra.state != null && Number(extra.state) !== 3) return false;
  const winSid = Number(extra.winSid);
  const mySid = Number(extra.my && extra.my.sid);
  if (winSid > 0 && mySid > 0 && winSid !== mySid) return false;
  return true;
}

/**
 * 计算某活动当前可领城市 uid（去重后的差集，顺序沿用服务端列表）。
 * @param {object} activity 活动对象
 * @returns {string[]} 可领 uid 列表；不可领时为空数组
 */
export function collectTargets(activity) {
  if (!isCityAwardActivity(activity)) return [];
  if (activity.showUiType === SHOW_UI_TYPE_KING_DUEL && !kingDuelSettled(activity)) return [];
  const extra = activity.extra || {};
  const can = uidList(extra.can_receive_uid_list);
  if (!can.length) return [];
  const recv = uidList(extra.reward_received_list);
  const limit = awardUpperLimit(activity);
  if (limit > 0 && recv.length >= limit) return [];
  const recvSet = new Set(recv);
  const out = [];
  for (let i = 0; i < can.length; i++) {
    if (!recvSet.has(can[i])) out.push(can[i]);
  }
  return out;
}

/**
 * 权威快照里该 uid 是否已记为领取（确认退避清账用）。
 * @param {object} activity 活动对象
 * @param {string|number} uid 城市玩家 uid
 * @returns {boolean}
 */
export function isReceived(activity, uid) {
  const recv = uidList(activity && activity.extra && activity.extra.reward_received_list);
  return recv.indexOf(String(uid)) >= 0;
}

/**
 * 全量待领数（面板只读状态行用）。
 * @param {object[]} activities 活动快照
 * @returns {number}
 */
export function countPending(activities) {
  if (!Array.isArray(activities)) return 0;
  let n = 0;
  for (let i = 0; i < activities.length; i++) n += collectTargets(activities[i]).length;
  return n;
}
