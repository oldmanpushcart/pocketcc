/**
 * quickRepair 配置 schema（v4）：场地 × 军种 × 类型 的修理范围 + 场地 × 类型档 的加速方式 + 钻石日上限。
 *
 * 场地（venue）：
 *   base = 基地修理厂（本地医院；普通兵免费额度、雷神吃材料）
 *   csb  = 战场抢修车间（跨服天梯赛；只收雷神、只在赛事窗口开）
 *   ava  = 无双修理厂（NewCAB/TM/Master/Legend；修理免费、只有加速计费）
 *
 * 修理范围用「类型码 1~6」表达（multiopts 字段只存 number[]）：军种×类型按 ARMS×TIERS 顺序编码，
 *   1 陆普通 / 2 陆雷神 / 3 海普通 / 4 海雷神 / 5 空普通 / 6 空雷神。
 *   雷神与超级雷神在游戏中不会同时存在，已合并为单一「雷神」类型。
 * 加速方式按「场地 × 类型档」：普通档（normal）与雷神档（thor）各一个三态（none/gold/item）；
 *   加速只作用于已开启修理且已在修（state1）的队列，故不再单独配加速范围。
 * 钻石日上限 goldDailyCap：0 = 不限；由 storage.slot 的 {day,spent} 台账在运行期扣减（见 index.js）。
 *
 * 版本迁移：v1（freeRepair/speedGold/speedItem）→ v2（commonRepair/thorRepair/speedCommon/speedThor）→ v3（9码）→ v4（6码）：
 *   v3→v4 把「普通雷神」与「超级雷神」合并为单一「雷神」码。
 */
import { ARMS, TIERS, ARM_LABEL, TIER_LABEL } from './classify.js';

/** @type {string[]} 场地枚举顺序（面板卡片顺序） */
export const VENUES = ['base', 'csb', 'ava'];

/** @type {Object<string, string>} 场地中文名 */
export const VENUE_LABEL = { base: '基地修理厂', csb: '战场抢修车间', ava: '无双修理厂' };

/** @type {Object<string, string>} 场地 → 修理范围配置键 */
export const REPAIR_KEY = { base: 'repairBase', csb: 'repairCsb', ava: 'repairAva' };

/**
 * 类型码表：code = 1..6，按 ARMS × TIERS 顺序（陆普通/陆雷神/海普通/海雷神/空普通/空雷神）。
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

/** 战场抢修车间只收雷神（源码 csb_hospital_info 条款）：可用类型码 = 雷神（含超级） */
export const CSB_CODES = CLASS_CODES.filter((c) => c.tier !== 'normal').map((c) => c.code);

/** @type {number[]} 默认修理范围：普通兵三军种（承接旧 commonRepair 默认开） */
const NORMAL_CODES = CLASS_CODES.filter((c) => c.tier === 'normal').map((c) => c.code);

/**
 * 军种 × 类型 → 类型码。
 * @param {string} arm land/navy/air
 * @param {string} tier normal/thor
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

/** 矩阵布局配置：列头 = 军种，行头 = 类型 */
const MATRIX_COLS = ['陆军', '海军', '空军'];
const MATRIX_ROWS = ['普通', '雷神'];
const MATRIX_ROWS_CSB = ['雷神'];

/**
 * 某场地 panel 用矩阵选项（multiopts fd.matrix 布局，按行优先排列：每行 = 同类型跨三军种）。
 * @param {string} venue base/csb/ava
 * @returns {{options:Array<{value:number,label:string}>, matrix:{cols:string[],rows:string[]}}}
 */
export function venueMatrixField(venue) {
  const allow = new Set(venueCodes(venue));
  // 行优先：按 TIERS 外层、ARMS 内层遍历
  const options = [];
  for (const tier of TIERS) {
    for (const arm of ARMS) {
      const code = classCodeOf(arm, tier);
      if (code && allow.has(code)) {
        options.push({ value: code, label: ARM_LABEL[arm] + '·' + TIER_LABEL[tier] });
      }
    }
  }
  const rows = venue === 'csb' ? MATRIX_ROWS_CSB : MATRIX_ROWS;
  return { options, matrix: { cols: MATRIX_COLS, rows } };
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
 * @param {string} tier normal/thor
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
 * @param {string} tier normal/thor
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
 * v3 旧码（1~9，3军种×3类型）→ v4 新码（1~6，3军种×2类型）映射。
 * 旧码结构：armIdx*3 + tierIdx + 1（tierIdx: 0=normal,1=thor,2=super）
 * 新码结构：armIdx*2 + tierIdx + 1（tierIdx: 0=normal,1=thor）
 * super 合并到 thor。
 * @param {number} oldCode
 * @returns {number} 新码；0 = 无效
 */
function migrateCode(oldCode) {
  if (oldCode < 1 || oldCode > 9) return 0;
  const armIdx = Math.floor((oldCode - 1) / 3);
  const tierIdx = (oldCode - 1) % 3;
  const newTier = tierIdx === 0 ? 0 : 1; // normal→normal, thor/super→thor
  return armIdx * 2 + newTier + 1;
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
 * v3 存档的 9 码集合 → v4 的 6 码集合（合并 super 到 thor，去重）。
 * @param {number[]} codes v3 类型码数组
 * @returns {number[]} v4 类型码数组（升序去重）
 */
function migrateCodes(codes) {
  const set = new Set();
  for (const c of codes) {
    const newC = migrateCode(c);
    if (newC) set.add(newC);
  }
  return [...set].sort((a, b) => a - b);
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
 * v3→v4：把 repairBase/repairCsb/repairAva 的 9 码映射为 6 码。
 * @param {object} c 合并后的配置
 * @param {number} fromVersion 存量版本（缺 _v 视为 0）
 * @returns {object}
 */
export function migrateConfig(c, fromVersion) {
  // v3→v4：类型码 9→ 6（合并 super 到 thor）
  if (fromVersion === 3) {
    for (const venue of VENUES) {
      const key = REPAIR_KEY[venue];
      if (Array.isArray(c[key])) c[key] = migrateCodes(c[key]);
    }
    return c;
  }
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
