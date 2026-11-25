/**
 * 场地规划共用件：钻石/道具预算池、道具枚数折算、param 编码、reason 措辞。
 * 纯判据无副作用（预算池对象由调用方持有并就地扣减）。
 */
import { speedItemNum } from '../model/cost.js';

/**
 * 一轮决策的共享预算：
 *   gold  —— 钻石余额（已被面板「钻石日上限」钳过，见 index.js 的日账）
 *   h     —— 普通医院加速道具池 {si, left}（基地 + 战场抢修车间共用背包同一行）
 *   a     —— 无双医院加速道具池 {si, left}（专行 15100046）
 * 三池在 base/csb/ava 三个场地规划间共享投影，同拍多笔累计扣减防超支。
 * @param {object} snap 快照
 * @returns {{gold:number, h:{si:object,left:number}|null, a:{si:object,left:number}|null}}
 */
export function makeBudget(snap) {
  const h = snap.speedItem;
  const a = snap.avaSpeedItem;
  return {
    gold: Number(snap.gold) || 0,
    h: h ? { si: h, left: Math.max(Number(h.usable == null ? h.amount : h.usable) || 0, 0) } : null,
    a: a ? { si: a, left: Math.max(Number(a.amount) || 0, 0) } : null,
  };
}

/**
 * 钻石不足 reason（全场地共用同一措辞）。
 * @param {number} gold 可用钻石
 * @param {number} est 估算花费
 * @param {string} where 域标签
 * @returns {string}
 */
export function goldShortReason(gold, est, where) {
  return 'gold ' + gold + ' < estimate ' + est + ' (' + where + ')';
}

/**
 * 从道具池取一次枚数：时间池折算（ceil(Σ剩余/para1)），受持有量与单次上限夹取；
 * para1 不可解时回退单枚，池空则 num=0。失败返回 {err} 供调用方记 reason（不发必拒的空包）。
 * @param {{si:object,left:number}|null} pool 道具池
 * @param {number} leftSec 目标域在修剩余秒和
 * @returns {{num:number, si:object}|{err:string}}
 */
export function takeItem(pool, leftSec) {
  if (!pool) return { err: 'no hospital speed item in bag' };
  const si = pool.si;
  const spu = Number(si.secPerUse) || 0;
  const num =
    spu > 0 ? speedItemNum(leftSec, spu, pool.left, Number(si.useMax)) : pool.left > 0 ? 1 : 0;
  if (!(num > 0)) {
    return {
      err:
        'item speed num=0 (secPerUse ' + spu + '; held ' + pool.left + '; leftSec ' + leftSec + ')',
    };
  }
  pool.left -= num;
  return { num, si };
}

/**
 * 815 ITEM_USE 的 param 编码（源码 SpeedCDPanel.hospitalUseItemSpeed + 真人成功样本实证）。
 * 本地全量：param 恒 `null`（实证 "0|0" 被服务器拒 s=3/item_124017）；本地单条 = 队列 id；
 * 跨服全量：指定兵种 `"1,"+armyType`、否则 `"1|0"`；跨服单条 `"1|"+queueId`。
 * @param {boolean} cross 是否跨服战场医院
 * @param {string|number|null} [queueId] 单条队列 id（不传=全量）
 * @param {number} [armyType] 跨服全量时限定兵种（-1/缺省=不限）
 * @returns {string|null} 本地全量返回 null（与成功样本逐键一致）
 */
export function itemSpeedParam(cross, queueId, armyType) {
  const qid = queueId == null ? '' : String(queueId);
  if (qid) return cross ? '1|' + qid : qid;
  if (!cross) return null;
  const type = Number(armyType);
  return type > 0 ? '1,' + type : '1|0';
}
