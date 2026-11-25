/**
 * quickRepair 配置 schema（v3）：场地 × 军种 × 类型 的修理范围 + 场地 × 类型档 的加速方式 + 钻石日上限。
 *
 * 场地（venue）：
 *   base = 基地修理厂（本地医院；普通兵免费额度、雷神吃材料）
 *   csb  = 战场抢修车间（跨服天梯赛；只收雷神、只在赛事窗口开）
 *   ava  = 无双修理厂（NewCAB/TM/Master/Legend；修理免费、只有加速计费）
 *
 * 修理范围用「类型码 1~9」表达（multiopts 字段只存 number[]）：军种×类型按 ARMS×TIERS 顺序编码，
 *   1 陆普通 … 9 空超级；战场抢修车间只提供雷神两类（2/3/5/6/8/9）。
 * 加速方式按「场地 × 类型档」：普通档（normal）与雷神档（thor+super）各一个三态（none/gold/item）；
 *   加速只作用于已开启修理且已在修（state1）的队列，故不再单独配加速范围。
 * 钻石日上限 goldDailyCap：0 = 不限；由 storage.slot 的 {day,spent} 台账在运行期扣减（见 index.js）。
 *
 * 版本迁移：v1（freeRepair/speedGold/speedItem）→ v2（commonRepair/thorRepair/speedCommon/speedThor）→ v3：
 *   四开关按「所有军种」展开到三场地；resourceRepair 废弃（普通兵超额度只排队耗时、无双修理免费）。
 */
import { ARMS, TIERS, ARM_LABEL, TIER_LABEL } from './classify.js';

/** @type {string[]} 场地枚举顺序（面板卡片顺序） */
export const VENUES = ['base', 'csb', 'ava'];

/** @type {Object<string, string>} 场地中文名 */
export const VENUE_LABEL = { base: '基地修理厂', csb: '战场抢修车间', ava: '无双修理厂' };

/** @type {Object<string, string>} 场地 → 修理范围配置键 */
export const REPAIR_KEY = { base: 'repairBase', csb: 'repairCsb', ava: 'repairAva' };

/**
 * 类型码表：code = 1..9，按 ARMS × TIERS 顺序（陆普通/陆雷神/陆超级/海普通/…/空超级）。
 * @type {Array<{code:number, arm:string, tier:string, label:string}>}
 */
export const CLASS_CODES = [];
for (const arm of ARMS) {
  for (const tier of TIERS) {
    CLASS_CODES.push({
      code: CLASS_CODES.length + 1,
      arm,
      tier,
      label: ARM_LABEL[arm] + '·' + TIER_LABEL[tier],
    });
  }
}

/** @type {Object<string, number>} `arm.tier` → 类型码 */
const CODE_BY_UNIT = Object.create(null);
for (const c of CLASS_CODES) CODE_BY_UNIT[c.arm + '.' + c.tier] = c.code;

/** 战场抢修车间只收雷神（源码 csb_hospital_info 条款）：可用类型码 = 普通雷神 + 超级雷神 */
export const CSB_CODES = CLASS_CODES.filter((c) => c.tier !== 'normal').map((c) => c.code);

/** @type {number[]} 默认修理范围：普通兵三军种（承接旧 commonRepair 默认开） */
const NORMAL_CODES = CLASS_CODES.filter((c) => c.tier === 'normal').map((c) => c.code);

/**
 * 军种 × 类型 → 类型码。
 * @param {string} arm land/navy/air
 * @param {string} tier normal/thor/super
 * @returns {number} 0 = 非法组合
 */
export function classCodeOf(arm, tier) {
  return CODE_BY_UNIT[arm + '.' + tier] || 0;
}

/**
 * 某场地可选的类型码集合（csb 仅雷神）。
 * @param {string} venue base/csb/ava
 * @returns {number[]}
 */
export function venueCodes(venue) {
  return venue === 'csb' ? CSB_CODES.slice() : CLASS_CODES.map((c) => c.code);
}

/**
 * 某场地 panel 用选项（multiopts 的 {value,label}）。
 * @param {string} venue base/csb/ava
 * @returns {Array<{value:number,label:string}>}
 */
export function venueOptions(venue) {
  const allow = new Set(venueCodes(venue));
  return CLASS_CODES.filter((c) => allow.has(c.code)).map((c) => ({
    value: c.code,
    label: c.label,
  }));
}

/**
 * 修理范围是否包含该单位类型。
 * @param {object} cfg 归一后的配置
 * @param {string} venue base/csb/ava
 * @param {string} arm 军种
 * @param {string} tier 类型
 * @returns {boolean}
 */
export function repairIncludes(cfg, venue, arm, tier) {
  const sel = cfg[REPAIR_KEY[venue]];
  const code = classCodeOf(arm, tier);
  return !!code && Array.isArray(sel) && sel.indexOf(code) >= 0;
}

/**
 * 加速方式三态归一：只认 'gold'/'item'，其余一律 'none'。
 * @param {*} v 面板原始值
 * @returns {'none'|'gold'|'item'}
 */
export function speedModeOf(v) {
  return v === 'gold' || v === 'item' ? v : 'none';
}

/**
 * 某场地某类型的加速方式配置键：csb 只有雷神队列，单键 speedCsb；base/ava 分普通档/雷神档。
 * @param {string} venue base/csb/ava
 * @param {string} tier normal/thor/super
 * @returns {string}
 */
export function speedKeyOf(venue, tier) {
  if (venue === 'csb') return 'speedCsb';
  return tier === 'normal' ? 'speed' + cap(venue) + 'Normal' : 'speed' + cap(venue) + 'Thor';
}

/**
 * 某场地某类型的加速方式。
 * @param {object} cfg 归一后的配置
 * @param {string} venue base/csb/ava
 * @param {string} tier normal/thor/super
 * @returns {'none'|'gold'|'item'}
 */
export function speedModeFor(cfg, venue, tier) {
  return speedModeOf(cfg[speedKeyOf(venue, tier)]);
}

/** @param {string} s 场地名 @returns {string} 首字母大写 */
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 默认配置（descriptor.defaults）：全部加速 none、钻石日上限 0（不限）、基地/无双默认修普通兵。
 * @returns {object}
 */
export function defaultConfig() {
  return {
    repairBase: NORMAL_CODES.slice(),
    repairCsb: [],
    repairAva: NORMAL_CODES.slice(),
    speedBaseNormal: 'none',
    speedBaseThor: 'none',
    speedCsb: 'none',
    speedAvaNormal: 'none',
    speedAvaThor: 'none',
    goldDailyCap: 0,
    pollIntervalSec: 60,
  };
}

/**
 * 旧存档四开关（v2）→ 三场地类型码集合（v3）。v1 先折成 v2 口径再走本函数。
 * @param {boolean} commonRepair 普通兵开关
 * @param {boolean} thorRepair 雷神开关
 * @returns {{base:number[], csb:number[], ava:number[]}} 各场地类型码集合
 */
function legacyRepair(commonRepair, thorRepair) {
  // 按类型码升序展开（面板多选存值顺序稳定，便于对拍/日志比对）
  const base = CLASS_CODES.filter(
    (c) => (commonRepair && c.tier === 'normal') || (thorRepair && c.tier !== 'normal'),
  ).map((c) => c.code);
  return { base, csb: thorRepair ? CSB_CODES.slice() : [], ava: base.slice() };
}

/**
 * 面板配置归一：类型码过滤到本场地可选集、加速三态、日上限/轮询钳制。
 * 旧键（commonRepair/thorRepair/speedCommon/speedThor/resourceRepair/…）不再读取——
 * 迁移由 migrateConfig 在版本升级时一次性完成；缺键回默认。
 * @param {object} raw 面板原始配置
 * @returns {object} 归一后的模块配置（默认值见 defaultConfig）
 */
export function normalize(raw) {
  const d = defaultConfig();
  raw = raw || {};
  const out = { ...d };
  for (const venue of VENUES) {
    const key = REPAIR_KEY[venue];
    const allow = new Set(venueCodes(venue));
    const sel = Array.isArray(raw[key]) ? raw[key] : Array.isArray(d[key]) ? d[key] : [];
    out[key] = [];
    for (const v of sel) {
      const code = Math.floor(Number(v));
      if (allow.has(code) && out[key].indexOf(code) < 0) out[key].push(code);
    }
  }
  for (const key of [
    'speedBaseNormal',
    'speedBaseThor',
    'speedCsb',
    'speedAvaNormal',
    'speedAvaThor',
  ]) {
    out[key] = raw[key] === undefined ? d[key] : speedModeOf(raw[key]);
  }
  const cap = Math.floor(Number(raw.goldDailyCap));
  out.goldDailyCap = cap > 0 ? cap : 0;
  let poll = Math.floor(Number(raw.pollIntervalSec));
  if (!(poll > 0)) poll = 60;
  out.pollIntervalSec = Math.min(poll, 60 * 60);
  return out;
}

/**
 * 存档迁移（descriptor.migrate，纯函数，就地改写并返回）。
 * 只在存档里确实存在旧键时才改写——fresh install（只有 defaults）保持默认值不被旧字段推断覆盖。
 * @param {object} c 合并后的配置
 * @param {number} fromVersion 存量版本（缺 _v 视为 0）
 * @returns {object}
 */
export function migrateConfig(c, fromVersion) {
  if (!(fromVersion < 3)) return c;
  const hasLegacy =
    'commonRepair' in c ||
    'thorRepair' in c ||
    'resourceRepair' in c ||
    'speedCommon' in c ||
    'speedThor' in c ||
    'freeRepair' in c ||
    'speedGold' in c ||
    'speedItem' in c;
  if (!hasLegacy) return c;
  const v1 = fromVersion < 2;
  const commonRepair = v1
    ? c.commonRepair === undefined
      ? c.freeRepair !== false
      : !!c.commonRepair
    : c.commonRepair !== false;
  const thorRepair = !!c.thorRepair;
  const legacySpeed = (which) => {
    if (which === 'normal' && c.speedCommon !== undefined) return speedModeOf(c.speedCommon);
    if (which === 'thor' && c.speedThor !== undefined) return speedModeOf(c.speedThor);
    return c.speedGold ? 'gold' : c.speedItem ? 'item' : 'none';
  };
  const mc = legacySpeed('normal');
  const mt = legacySpeed('thor');
  const rep = legacyRepair(commonRepair, thorRepair);
  c.repairBase = rep.base;
  c.repairCsb = rep.csb;
  c.repairAva = rep.ava;
  c.speedBaseNormal = mc;
  c.speedBaseThor = mt;
  c.speedCsb = mt;
  c.speedAvaNormal = mc;
  c.speedAvaThor = mt;
  delete c.commonRepair;
  delete c.thorRepair;
  delete c.resourceRepair;
  delete c.speedCommon;
  delete c.speedThor;
  delete c.freeRepair;
  delete c.speedGold;
  delete c.speedItem;
  return c;
}
