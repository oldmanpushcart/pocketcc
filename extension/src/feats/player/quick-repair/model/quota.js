/**
 * 免费快速修理额度（1785 GET_QUICK_REPARE_INFO 应答投影，纯判据）。
 *
 * 应答形态（实录）：`{common_max,common_use, landThor_max/use, navyThor_max/use, airThor_max/use,
 *   thor_max/use, ret:[{id:10001|10002|10003, num}]}`。
 * 池位：普通兵 1 池（common）；雷神按军种 3 池（landThor/navyThor/airThor）+ 合计池（thor）。
 * `ret[].id` 是额度来源（rapid_repair 表）：10001 英雄107（普通全兵种）、10002 职业「超级修理」、
 * 10003 英雄321（雷神·空军）——只作日志归因，不参与发包决策。
 *
 * 注意：普通兵超出免费额度只是排队耗时、不扣材料（repair_cost 全空）；雷神线无免费额度时直接吃材料。
 * 材料充足模式下本模块的输出只用于日志/统计，不再作修理闸门。
 */

/** @type {Object<number, string>} rapid_repair 来源 id → 语义（日志归因用） */
export const RAPID_REPAIR_SOURCE = {
  10001: 'hero107',
  10002: 'career_8005000',
  10003: 'hero321',
};

/**
 * 1785 应答 → 免费额度视图。
 * @param {object|null} info 1785 应答载荷
 * @returns {{ok:boolean, commonMax:number, commonUse:number, commonFreeLeft:number, thorMax:number, thorUse:number, thorFreeLeft:number, landThorFreeLeft:number, navyThorFreeLeft:number, airThorFreeLeft:number, groupNum:Object<number,number>}|null}
 */
export function parseQuota(info) {
  if (!info || typeof info !== 'object') return null;
  if (typeof info.common_max !== 'number' && typeof info.common_use !== 'number') return null;
  const commonMax = Number(info.common_max) || 0;
  const commonUse = Number(info.common_use) || 0;
  const thorMax = Number(info.thor_max) || 0;
  const thorUse = Number(info.thor_use) || 0;
  const groupNum = Object.create(null);
  if (Array.isArray(info.ret)) {
    for (const r of info.ret) {
      if (!r || typeof r !== 'object') continue;
      const id = Number(r.id) || 0;
      if (id) groupNum[id] = Number(r.num) || 0;
    }
  }
  const left = (maxKey, useKey) =>
    Math.max(0, (Number(info[maxKey]) || 0) - (Number(info[useKey]) || 0));
  return {
    ok: true,
    commonMax,
    commonUse,
    commonFreeLeft: Math.max(0, commonMax - commonUse),
    thorMax,
    thorUse,
    thorFreeLeft: Math.max(0, thorMax - thorUse),
    landThorFreeLeft: left('landThor_max', 'landThor_use'),
    navyThorFreeLeft: left('navyThor_max', 'navyThor_use'),
    airThorFreeLeft: left('airThor_max', 'airThor_use'),
    groupNum,
  };
}

/**
 * 指定类型的免费额度剩余：普通兵取 common 池，雷神两点取对应军种的雷神池；军种缺失回退合计池。
 * @param {object|null} quota parseQuota 产物
 * @param {string} tier normal/thor
 * @param {string} arm land/navy/air
 * @returns {number} 剩余额度；quota 缺失返回 0
 */
export function freeLeftFor(quota, tier, arm) {
  if (!quota) return 0;
  if (tier === 'normal') return quota.commonFreeLeft || 0;
  if (arm === 'land') return quota.landThorFreeLeft || 0;
  if (arm === 'navy') return quota.navyThorFreeLeft || 0;
  if (arm === 'air') return quota.airThorFreeLeft || 0;
  return quota.thorFreeLeft || 0;
}

/**
 * 免费额度是否覆盖全部待修（源码 getQuickRepairTipsType 的 AllCanRepair 判据，日志用）。
 * @param {object|null} quota parseQuota 产物
 * @param {number} waitN 待修单位数
 * @returns {boolean}
 */
export function allFreeCovered(quota, waitN) {
  return !!quota && !!quota.ok && Number(waitN) > 0 && quota.commonFreeLeft >= Number(waitN);
}
