/**
 * 队列 → 单位条目（纯函数）：把三个场地的原始队列数组统一成「带军种/类型的条目」。
 *
 * 条目形状：
 *   wait      {id, key, orderId, arm, tier}  —— state0 待修；key 是同拍去重令牌
 *   repairing {id, arm, tier, left}          —— state1 在修；left = 剩余秒（serverTime 不可判定时 0）
 *
 * 分类注入 unitOf(orderId) → {arm,tier,f?}：index 侧用 UserData.getArmyByArmyUuid 包一层 classifyUnit。
 * 战场抢修车间只收雷神：跨服队列取不到部队对象时按「雷神」兜底（classifyUnit 的 fallback），
 * 否则会被归成普通兵、从该场地「只修雷神」的可选集里漏掉。本地/无双兜底仍是「陆·普通」（不漏修普通兵）。
 */

/** @type {number} 本地伤兵队列在 OrderQueues 里的 type 值（源码 getOrderQueuesByType(1)） */
export const ORDER_TYPE_HEAL = 1;

/**
 * 受伤事件标记：数值取整、否则取串（令牌区分同槽再次受伤 vs 陈旧幻影）。
 * @param {number|string|null|undefined} v endTime / et
 * @returns {string}
 */
function markOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v)) : '';
  return v == null ? '' : String(v);
}

/** @param {*} v @returns {string} 十进制串（null → ''） */
function str(v) {
  return v == null ? '' : String(v);
}

/** 战场抢修车间兜底归类：拿不到部队对象按雷神（该场地只收雷神） */
const CSB_FALLBACK = { arm: 'land', tier: 'thor' };

/**
 * 本地待修条目（state0）：`type===1 && orderId!=="0" && state===0`。
 * @param {Array<object>|null} queues 本地 OrderQueues
 * @param {function(string):{arm:string,tier:string}} unitOf orderId → 分类
 * @returns {Array<{id:string, key:string, orderId:string, arm:string, tier:string}>}
 */
export function baseWaitEntries(queues, unitOf) {
  const out = [];
  if (!Array.isArray(queues)) return out;
  for (const q of queues) {
    if (!q || typeof q !== 'object') continue;
    if (Number(q.type) !== ORDER_TYPE_HEAL) continue;
    const orderId = str(q.orderId);
    if (!orderId || orderId === '0') continue;
    if (Number(q.state) !== 0) continue;
    const id = str(q.id);
    if (!id) continue;
    const u = unitOf(orderId);
    out.push({
      id,
      key: id + '#' + orderId + '#' + markOf(q.endTime),
      orderId,
      arm: u.arm,
      tier: u.tier,
    });
  }
  return out;
}

/**
 * 本地在修条目（state1；tolerate 缺失 type）。
 * @param {Array<object>|null} queues 本地 OrderQueues
 * @param {number} serverTime 服务器秒
 * @param {function(string):{arm:string,tier:string}} unitOf orderId → 分类
 * @returns {Array<{id:string, arm:string, tier:string, left:number}>}
 */
export function baseRepairEntries(queues, serverTime, unitOf) {
  const out = [];
  if (!Array.isArray(queues)) return out;
  const st = Number(serverTime) > 0 ? Number(serverTime) : 0;
  for (const q of queues) {
    if (!q || typeof q !== 'object') continue;
    if (q.type != null && Number(q.type) !== ORDER_TYPE_HEAL) continue;
    const orderId = str(q.orderId);
    if (!orderId || orderId === '0') continue;
    if (Number(q.state) !== 1) continue;
    const id = str(q.id);
    if (!id) continue;
    const u = unitOf(orderId);
    const left = st > 0 ? Math.max(0, (Number(q.endTime) || 0) - st) : 0;
    out.push({ id, arm: u.arm, tier: u.tier, left });
  }
  return out;
}

/**
 * 跨服待修条目（1426 `queues[]` 里 st===0）。
 * @param {object|null} data 1426 应答载荷
 * @param {function(string):{arm:string,tier:string}} unitOf army uuid → 分类
 * @returns {Array<{id:string, key:string, arm:string, tier:string}>}
 */
export function csbWaitEntries(data, unitOf) {
  const out = [];
  const qs = data && data.queues;
  if (!Array.isArray(qs)) return out;
  for (const q of qs) {
    if (!q || typeof q !== 'object') continue;
    if (Number(q.st) !== 0) continue;
    const id = str(q.id);
    if (!id) continue;
    const army = str(q.army);
    const u = army ? unitOf(army) : CSB_FALLBACK;
    out.push({ id, key: id + '#' + army + '#' + markOf(q.et), arm: u.arm, tier: u.tier });
  }
  return out;
}

/**
 * 跨服在修条目（1426 `queues[]` 里 st>0；st 是开修 epoch）。
 * @param {object|null} data 1426 应答载荷
 * @param {number} serverTime 服务器秒
 * @param {function(string):{arm:string,tier:string}} unitOf army uuid → 分类
 * @returns {Array<{id:string, arm:string, tier:string, left:number}>}
 */
export function csbRepairEntries(data, serverTime, unitOf) {
  const out = [];
  const qs = data && data.queues;
  if (!Array.isArray(qs)) return out;
  const st = Number(serverTime) > 0 ? Number(serverTime) : 0;
  for (const q of qs) {
    if (!q || typeof q !== 'object') continue;
    if (!(Number(q.st) > 0)) continue;
    const id = str(q.id);
    if (!id) continue;
    const army = str(q.army);
    const u = army ? unitOf(army) : CSB_FALLBACK;
    const left = st > 0 ? Math.max(0, (Number(q.et) || 0) - st) : 0;
    out.push({ id, arm: u.arm, tier: u.tier, left });
  }
  return out;
}

/**
 * 无双条目（6310 list）：state0 → wait、state1 → repairing（id 即部队 uuid）。
 * @param {Array<object>|null} list 6310 应答 list
 * @param {number} serverTime 服务器秒
 * @param {function(string):{arm:string,tier:string}} unitOf orderId → 分类
 * @returns {{wait:Array<{id:string, orderId:string, arm:string, tier:string}>, repairing:Array<{id:string, arm:string, tier:string, left:number}>}}
 */
export function avaEntries(list, serverTime, unitOf) {
  const out = { wait: [], repairing: [] };
  if (!Array.isArray(list)) return out;
  const st = Number(serverTime) > 0 ? Number(serverTime) : 0;
  for (const q of list) {
    if (!q || typeof q !== 'object') continue;
    const orderId = str(q.orderId);
    if (!orderId || orderId === '0') continue;
    const id = str(q.id);
    if (!id) continue;
    const u = unitOf(orderId);
    const state = Number(q.state);
    if (state === 0) out.wait.push({ id, orderId, arm: u.arm, tier: u.tier });
    else if (state === 1) {
      const left = st > 0 ? Math.max(0, (Number(q.endTime) || 0) - st) : 0;
      out.repairing.push({ id, arm: u.arm, tier: u.tier, left });
    }
  }
  return out;
}

/** @param {Array<{left:number}>} entries 在修条目 @returns {number} 正剩余秒和 */
export function sumLeft(entries) {
  let total = 0;
  for (const e of entries) if (e.left > 0) total += e.left;
  return total;
}

/**
 * 是否雷神档（普通雷神 + 超级雷神）：无双 6311/6312 的动作 kind 后缀按此分档。
 * @param {string} tier normal/thor/super
 * @returns {boolean}
 */
export function isThorBand(tier) {
  return tier === 'thor' || tier === 'super';
}
