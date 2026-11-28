/**
 * quickRepair 配置 schema（v5）：场地 × 军种 × 类型 的每格维修模式 + 钻石日上限。
 *
 * 场地（venue）：
 *   base = 基地修理厂（本地医院；普通兵免费额度、雷神吃材料）
 *   csb  = 战场抢修车间（跨服天梯赛；只收雷神、只在赛事窗口开）
 *   ava  = 无双修理厂（NewCAB/TM/Master/Legend；修理免费、只有加速计费）
 *
 * 每格模式（mode）：类型码 1~6 对应 陆普通/陆雷神/海普通/海雷神/空普通/空雷神，
 *   配置值 = {code: mode} 对象：
 *     0 = 不维修
 *     1 = 普通维修（不加速）
 *     2 = 道具维修
 *     3 = 钻石维修
 *   雷神与超级雷神在游戏中不会同时存在，已合并为单一「雷神」类型。
 *
 * 钻石日上限 goldDailyCap：0 = 不限；由 storage.slot 的 {day,spent} 台账在运行期扣减（见 index.js）。
 *
 * 版本迁移：v1→v2→v3→v4→v5：
 *   v4→v5 把 repairX: number[] + speedXxx 合并为每格 mode 对象。
 */
import { ARMS, TIERS, ARM_LABEL, TIER_LABEL } from './classify.js';

/** @type {string[]} 场地枚举顺序（面板卡片顺序） */
export const VENUES = ['base', 'csb', 'ava'];

/** @type {Object<string, string>} 场地 → 修理模式配置键 */
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

/** @type {number[]} 默认修理模式：普通兵三军种 mode=1，其余 mode=0 */
const NORMAL_CODES = CLASS_CODES.filter((c) => c.tier === 'normal').map((c) => c.code);

/**
 * 默认每格模式对象：普通兵三格 mode=1，其余 mode=0。
 * @param {number[]} codes 可选码集
 * @returns {Object<number,number>}
 */
function defaultModeMap(codes) {
  const map = {};
  for (const c of codes) map[c] = NORMAL_CODES.indexOf(c) >= 0 ? 1 : 0;
  return map;
}

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
 * 矩阵下拉字段描述符数据（type:'matrixselect'）：每格 select。
 * @param {string} venue base/csb/ava
 * @returns {{codes:number[], matrix:{cols:string[],rows:string[]}}}
 */
export function venueMatrixSelectField(venue) {
  const allow = new Set(venueCodes(venue));
  const codes = [];
  for (const tier of TIERS) {
    for (const arm of ARMS) {
      const code = classCodeOf(arm, tier);
      if (code && allow.has(code)) codes.push(code);
    }
  }
  const rows = venue === 'csb' ? MATRIX_ROWS_CSB : MATRIX_ROWS;
  return { codes, matrix: { cols: MATRIX_COLS, rows } };
}

/**
 * 某格模式（0~3）。
 * @param {object} cfg 归一后的配置
 * @param {string} venue base/csb/ava
 * @param {number} code 类型码
 * @returns {number}
 */
export function cellMode(cfg, venue, code) {
  const map = cfg[REPAIR_KEY[venue]];
  return (map && map[code]) || 0;
}

/**
 * 修理范围是否包含该单位类型（mode > 0）。
 * @param {object} cfg 归一后的配置
 * @param {string} venue base/csb/ava
 * @param {string} arm 军种
 * @param {string} tier 类型
 * @returns {boolean}
 */
export function repairIncludes(cfg, venue, arm, tier) {
  const code = classCodeOf(arm, tier);
  return !!code && cellMode(cfg, venue, code) > 0;
}

/**
 * 某格加速方式（从 mode 派生：mode 2→'item', 3→'gold', 其余→'none'）。
 * @param {object} cfg 归一后的配置
 * @param {string} venue base/csb/ava
 * @param {string} arm 军种
 * @param {string} tier 类型
 * @returns {'none'|'gold'|'item'}
 */
export function cellSpeedMode(cfg, venue, arm, tier) {
  const mode = cellMode(cfg, venue, classCodeOf(arm, tier));
  if (mode === 3) return 'gold';
  if (mode === 2) return 'item';
  return 'none';
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
 * 加速方式配置键（v4 遗留，仅供迁移用）。
 * @param {string} venue base/csb/ava
 * @param {string} tier normal/thor
 * @returns {string}
 */
export function speedKeyOf(venue, tier) {
  if (venue === 'csb') return 'speedCsb';
  return tier === 'normal' ? 'speed' + cap(venue) + 'Normal' : 'speed' + cap(venue) + 'Thor';
}

/** @param {string} s 场地名 @returns {string} 首字母大写 */
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 默认配置（descriptor.defaults）：全部格 mode=0、钻石日上限 0、基地/无双默认修普通兵 mode=1。
 * @returns {object}
 */
export function defaultConfig() {
  return {
    repairBase: defaultModeMap(CLASS_CODES.map((c) => c.code)),
    repairCsb: defaultModeMap(CSB_CODES),
    repairAva: defaultModeMap(CLASS_CODES.map((c) => c.code)),
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
 * 面板配置归一：每格模式过滤到本场地可选集、mode 限制 0~3、日上限/轮询钳制。
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
    const src =
      raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key]) ? raw[key] : d[key];
    const map = {};
    for (const code of allow) {
      const mode = Math.floor(Number(src[code]));
      map[code] = mode >= 0 && mode <= 3 ? mode : 0;
    }
    out[key] = map;
  }
  const cap = Math.floor(Number(raw.goldDailyCap));
  out.goldDailyCap = cap > 0 ? cap : 0;
  let poll = Math.floor(Number(raw.pollIntervalSec));
  if (!(poll > 0)) poll = 60;
  out.pollIntervalSec = Math.min(poll, 60 * 60);
  return out;
}

/**
 * v4 格式（repairX: number[] + speedXxx 键）就地转 v5 每格 mode 对象。
 * 勾选的码按该 venue×tier 的速度键映射：gold→3、item→2、none→1；未勾选→0。
 * 转完删除全部遗留速度键。
 * @param {object} c 合并后的配置（就地改写）
 */
function arrToModeMap(c) {
  for (const venue of VENUES) {
    const key = REPAIR_KEY[venue];
    const oldArr = Array.isArray(c[key]) ? c[key] : [];
    const allow = venueCodes(venue);
    const map = {};
    for (const code of allow) {
      if (oldArr.indexOf(code) < 0) {
        map[code] = 0;
        continue;
      }
      const entry = CLASS_CODES.find((x) => x.code === code);
      const tier = entry ? entry.tier : 'normal';
      const spd = speedModeOf(c[speedKeyOf(venue, tier)]);
      map[code] = spd === 'gold' ? 3 : spd === 'item' ? 2 : 1;
    }
    c[key] = map;
  }
  delete c.speedBaseNormal;
  delete c.speedBaseThor;
  delete c.speedCsb;
  delete c.speedAvaNormal;
  delete c.speedAvaThor;
}

/**
 * 存档迁移（descriptor.migrate，纯函数，就地改写并返回）。
 * 只在存档里确实存在旧键时才改写——fresh install（只有 defaults）保持默认值不被旧字段推断覆盖。
 * 所有旧版本最终统一产出 v5 格式（{code: mode} 对象）。
 * @param {object} c 合并后的配置
 * @param {number} fromVersion 存量版本（缺 _v 视为 0）
 * @returns {object}
 */
export function migrateConfig(c, fromVersion) {
  // v4→v5：数组 + 速度键 → 每格 mode 对象
  if (fromVersion === 4) {
    arrToModeMap(c);
    return c;
  }
  // v3→v4→v5：类型码 9→6 后转 mode
  if (fromVersion === 3) {
    for (const venue of VENUES) {
      const key = REPAIR_KEY[venue];
      if (Array.isArray(c[key])) c[key] = migrateCodes(c[key]);
    }
    arrToModeMap(c);
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
  arrToModeMap(c);
  return c;
}
