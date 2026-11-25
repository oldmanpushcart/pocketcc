/**
 * 修理/加速成本与折算（纯算术，无游戏态访问）。
 * 口径：
 *   - 钻石加速 = `ceil(剩余秒/60 × DATACONFIG 61017)`，至少 1（源码 getProfessionCDGold 同式）；
 *   - 无双钻石 = 上式基价 × 模式倍率、至少 1（源码 getAvaCureGoldByTime，倍率键见 index.js AVA_GOLD_CFG）；
 *   - 道具加速 = `min(ceil(Σ剩余秒/单枚秒数), 持有量, useMax)`：服务器把 amount 当时间池、按队首贪心消耗，
 *     故 ceil 即「刚好修完全部在修」的最小枚数（实证见 quick-repair/index.js 头部 815 条目）；
 *   - 修理材料 = 部队 `repair_cost`（`"resId|amount,…"`）。材料充足模式下只用于日志/统计，不作闸门。
 */

/**
 * 钻石估价（`ceil(秒/60 × 每分钟价)`，至少 1）。
 * @param {number} leftSec 在修剩余秒和
 * @param {number} ratePerMin DATACONFIG 61017（每分钟钻石价）
 * @returns {number} 估算钻石；rate 不可用（≤0）或 leftSec≤0 时返回 0（=无从判定/无需加速）
 */
export function estimateGold(leftSec, ratePerMin) {
  const rate = Number(ratePerMin) || 0;
  if (!(rate > 0) || !(leftSec > 0)) return 0;
  return Math.max(1, Math.ceil((leftSec / 60) * rate));
}

/**
 * 无双钻石估价：普通口径基价 × 模式倍率、至少 1（源码 `||1` 同口径）。
 * @param {number} leftSec 在修剩余秒和
 * @param {number} ratePerMin DATACONFIG 61017
 * @param {number} mult 模式倍率（DATACONFIG 1663543 等；≤0 按 1）
 * @returns {number} 估算钻石；rate 不可用返回 0
 */
export function estimateAvaGold(leftSec, ratePerMin, mult) {
  const base = estimateGold(leftSec, ratePerMin);
  if (!base) return 0;
  const m = Number(mult) > 0 ? Number(mult) : 1;
  return Math.max(1, Math.floor(base * m));
}

/**
 * 道具加速枚数：num = min(ceil(leftSec/secPerUse), 持有量, useMax)，useMax≤0 视为不设限。
 * @param {number} leftSec 在修剩余秒和
 * @param {number} secPerUse 单枚缩短秒数（ITEM 行 para1）
 * @param {number} held 持有枚数
 * @param {number} useMax 单次枚数上限（≤0=不限）
 * @returns {number} 0 = 不发（单枚秒数不可解/无剩余/无持有）
 */
export function speedItemNum(leftSec, secPerUse, held, useMax) {
  const spu = Number(secPerUse);
  if (!(spu > 0) || !(leftSec > 0)) return 0;
  let n = Math.ceil(leftSec / spu);
  const h = Math.floor(Number(held)) || 0;
  if (n > h) n = h;
  const cap = Number(useMax);
  if (cap > 0 && n > cap) n = Math.floor(cap);
  return n > 0 ? n : 0;
}

/**
 * 解析一条部队 `repair_cost`（游戏/竞品同格式：`"resId|amount,resId|amount"`）。
 * @param {string|number|null|undefined} cost army.Data.repair_cost
 * @returns {Array<{resId:number, amount:number}>} 非正/非法片段忽略；空串返回 []
 */
export function parseRepairCost(cost) {
  const out = [];
  if (typeof cost !== 'string' || !cost) return out;
  const parts = cost.split(',');
  for (const part of parts) {
    const kv = part.split('|');
    if (kv.length < 2) continue;
    const resId = Math.floor(Number(kv[0]));
    const amount = Math.floor(Number(kv[1]));
    if (!(resId > 0) || !(amount > 0)) continue;
    out.push({ resId, amount });
  }
  return out;
}

/**
 * 汇总一批单位的总材料成本（按 resId 累加）——材料充足模式下只用于日志/统计。
 * @param {Array<Array<{resId:number,amount:number}>|null>} costs 各单位 parseRepairCost 结果
 * @returns {Object<string, number>} resId → 总消耗
 */
export function sumCosts(costs) {
  const acc = Object.create(null);
  if (!Array.isArray(costs)) return acc;
  for (const items of costs) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      acc[it.resId] = (acc[it.resId] || 0) + it.amount;
    }
  }
  return acc;
}
