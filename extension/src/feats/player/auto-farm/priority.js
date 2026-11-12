/**
 * 取田优先级（priority）—— 四维 rank 的唯一真值、跨家族候选挑选与「升级换田」判定
 *
 * 排名口径（字典序，用户 2026-11-01 三刀定稿）：
 *   rank = 种类×10000 + 家族×1000 + 矿脉级×10 + 机械设施级
 *   优先级1 种类（遗迹3 > 机械2 > 普通1）> 优先级2 家族（雷神 > 石油 = 粮食 > 金矿）
 *   > 资源等级 > 机械设施级；**剩余存活时间不参与排序**（只留「快到期不下田」硬闸）。
 *   每位最大贡献（家族 3×1000 + 矿脉 6×10 + 设施 6 = 3066）小于上位 1 格，故字典序无进位串扰；
 *   层级天然成立：遗迹最低 31060 > 机械最高 23066 > 普通最高 13050（普通雷神只到 3 级，实最高 13030）。
 * 「换田」判据统一为 rank 严格大于。
 *
 * ❗家族进 rank 的代价（有意接受）：手里的石油 5 级田会被雷神 3 级田顶掉——雷神矿稀缺，稀缺性压过产量是用户的明确
 *   裁决。每次换田白扔一对 904+902 加一趟往返，靠 upgradeMaxPerPass=1 与同行 10min 冷却把成本限在可控范围。
 *
 * 机械田有两级（源码与报文双实证）：设施级（联盟记录「建造 N 级设施完毕」）与底下矿脉级（1034 应答 ext.itemId → RESOURCE.level）；
 *   生产速度 = MAP_BUILDING[bid].gather_coefficient × RESOURCE[ext.itemId].gather_speed（NWorldTowerPopup.initSpeed 逐字如此），
 *   实证规律 **设施级 ≤ 矿脉级**（40/40，见 71001 配 1603），所以矿脉级未探到时用设施级兜底（保守低估，不会因此误撤）。
 *   兜底的代价：同设施级下可能漏一档“只高在矿脉级”的升级（peek 低估→预筛拦住→不发 1034），
 *   该塔被任一行缺位派兵 pick 到时 ore 就回填进活表，偏差自动消失。
 *   注意：塔族与矿脉族**本来就不同源**（一座「采金」塔落在 floor(id/100)=1 的田上，见 core/resource.js 头注释），
 *   所以家族取塔族（采哪种资源）、等级取矿脉级（产量真相），两条轴各管各的。
 *
 * 跨族挑选按数据源能力分两条路：
 *   遗迹 / 机械 —— 有零发包本地窥视（relic.peek / tower.peek 按族查池/活表），故 kind 外层、
 *   内层跨族 peek 比 rank 选出最优族，再只对那一个族发真实校验（每 kind 仍最多 1 次探针，与单族时代持平）；
 *   普通 —— 906 没有零发包窥视，只能逐族真发、首个命中即返回，故必须受 familyBudget 闸约束。
 *
 * 同族内的排序键只需 矿脉级×10 + 设施级（种类与家族在同一 fam 参数下是常量），所以下游 scanner
 * 不需要知道 rank 全式，避免 priority ↔ tower-scanner 互相 import 成环。
 *
 * 三个来源各自带回 {x,y,level[,family]}，kind 与 marchType 在本模块统一附加，
 * 这样三个 scanner 不需要知道彼此、也不会互相 import 成环。
 *
 * 坐标黑名单（run 期）：抢占目标被 902 拒 / 已探明不可下的点进这里，由 index 每轮 run() 清空。
 * 它与遗迹池的 blockedUntil 不同——后者跨页面持久化、按田的刷新周期解禁；前者只活一次运行。
 */
import { relic } from './lvl6-scanner.js';
import { tower } from './tower-scanner.js';
import { normal, NORMAL_MAX_LEVEL } from './normal-scan.js';
import { isRelicTarget } from '../../../core/resource.js';

/** @type {{RELIC:string, TOWER:string, NORMAL:string}} 资源种类编码 */
export const KIND = { RELIC: 'relic', TOWER: 'tower', NORMAL: 'normal' };
/** @type {string[]} 种类优先级顺序（遗迹 → 机械 → 普通），面板/派兵/抢田遍历都按此序 */
export const KIND_ORDER = [KIND.RELIC, KIND.TOWER, KIND.NORMAL];
/** @type {Object<string, number>} 种类权重（乘 10000 后与家族/矿脉级/设施级拼成字典序 rank） */
const KIND_RANK = { relic: 3, tower: 2, normal: 1 };
/**
 * @type {Object<string, number>} 家族优先级（雷神 > 石油 = 粮食 > 金矿）：雷神矿稀缺，用户定稿它压过资源等级。
 * 面板 familyOptions 的展示序（金/粮/油/雷）与本表无关，两处各自独立，改展示顺序不会偷偷改掉取田优先级。
 */
export const FAMILY_RANK = { 16: 3, 1: 2, 5: 2, 7: 1 };
/**
 * @type {Object<string, number>} 各来源矿脉级上界：遗迹恒 6；机械矿脉最高 6；普通田 5 级封顶（雷神只到 3）。
 * 用于「升级判定」的零发包预筛（maxRank ≤ 当前 rank 就整类跳过，别白探）。
 */
const MAX_LEVEL = { relic: 6, tower: 6, normal: NORMAL_MAX_LEVEL };
/** @type {Object<string, number>} 设施级上界（只机械田有这一维） */
const FACILITY_MAX = { relic: 0, tower: 6, normal: 0 };
/**
 * @type {Object<string, number>} 种类 → 902 marchType：遗迹田与普通田都是 GATHER_RESOURCE(3)，
 * 机械田走 ATTACK_TOWER 复用值 26（仅影响行军类型字段，服务器按坐标定位点）。
 */
const MARCH_TYPE = { relic: 3, tower: 26, normal: 3 };

/** @type {Set<string>} run 期坐标黑名单（"x,y"）：探明不可下/抢占被拒的点，本轮不再尝试 */
var blocked = new Set();

/** 坐标黑名单读写口（run 期有效，run() 复位） */
export const blacklist = {
  /** @param {string} key "x,y" @returns {boolean} */
  has: function (key) {
    return blocked.has(key);
  },
  /** @param {number} x @param {number} y */
  add: function (x, y) {
    blocked.add((x | 0) + ',' + (y | 0));
  },
  /** @param {number} x @param {number} y */
  del: function (x, y) {
    blocked.delete((x | 0) + ',' + (y | 0));
  },
  /** 清空（run 复位） */
  clear: function () {
    blocked = new Set();
  },
  /** @returns {number} 规模（诊断用） */
  size: function () {
    return blocked.size;
  },
};

/**
 * 统一排名（四维字典序）：种类×10000 + 家族×1000 + 矿脉级×10 + 设施级。
 * @param {{kind:string, family?:number, level?:number, facility?:number}} c 候选/在途田；
 *   level = 矿脉（资源）级，facility = 机械设施级（非机械田留 0/缺省）
 * @returns {number} 越大越优；种类非法回 0
 */
export function rankOf(c) {
  var base = KIND_RANK[(c && c.kind) || ''] || 0;
  if (!base) return 0;
  var f = FAMILY_RANK[(c && c.family) | 0] || 0;
  var o = (c && c.level) | 0;
  var t = (c && c.facility) | 0;
  return base * 10000 + f * 1000 + (o > 9 ? 9 : o) * 10 + (t > 9 ? 9 : t);
}

/**
 * 某家族在某种类下能达到的最高 rank（升级预筛，零发包）：矿脉级与设施级各取上限。
 * @param {string} kind 种类编码
 * @param {number} family 家族编码
 * @returns {number} 天花板 rank
 */
function maxRankOf(kind, family) {
  var base = KIND_RANK[kind] || 0;
  return (
    base * 10000 +
    (FAMILY_RANK[family | 0] || 0) * 1000 +
    (MAX_LEVEL[kind] || 0) * 10 +
    (FACILITY_MAX[kind] || 0)
  );
}

/**
 * 同族内的低位下限（矿脉级×10 + 设施级，严格大于）：要赢过 curRank，本族候选的低位必须高于本值。
 * 种类与家族在同一 fam 参数下是常量，所以下游 scanner 只需比这个两位数、不需要知道 rank 全式（不成环）。
 * 跨种类时自动放开：机械(2) 的低位下限会算成负数 → 归 0（任何塔都压得过手里的普通田）。
 * @param {string} kind 目标种类
 * @param {number} family 目标家族
 * @param {number} curRank 当前田的 rank
 * @returns {number} 低位下限（严格大于），0 = 不限
 */
function lowFloorOf(kind, family, curRank) {
  var floor = curRank - (KIND_RANK[kind] || 0) * 10000 - (FAMILY_RANK[family | 0] || 0) * 1000;
  return floor > 0 ? floor : 0;
}

/** @type {number} 906 探测的公平轮转游标（见 pickNormalAny：预算花光时让后面的族也有机会） */
var rotCursor = 0;

/**
 * 家族入参归一：接受单值或数组（账本/旧档迁移期两者都会出现），去重 + 按 FAMILY_RANK 降序排列。
 * 排好序后 peek/pick 的遍历天然按优先级，同分挑选只需取第一个命中。
 * @param {number|number[]} raw 家族编码或编码数组
 * @returns {number[]} 有序去重的家族列表
 */
export function sortFamilies(raw) {
  var src = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  var out = [];
  for (var i = 0; i < src.length; i++) {
    var f = src[i] | 0;
    if (f > 0 && out.indexOf(f) < 0) out.push(f);
  }
  out.sort(function (a, b) {
    var fa = FAMILY_RANK[a] || 0;
    var fb = FAMILY_RANK[b] || 0;
    if (fa !== fb) return fb - fa;
    return a - b;
  });
  return out;
}

/** @param {string} kind 种类编码 @returns {number} 902 用的 marchType */
export function marchTypeOf(kind) {
  return MARCH_TYPE[kind] || MARCH_TYPE.normal;
}

/**
 * 本行实际可下的种类：行内勾选 ∩ 全局允许（时段闸），并按 KIND_ORDER 重排。
 * 时段外全局允许只有 ['relic']（遗迹田不受时段限制是固定行为），此时勾了机械/普通的行自然变空（不下田、且撤田）。
 * 一行多族后多一道闸：**一个家族都没勾 = 本行无物可下**（直接回空），否则缺位的行会被当成
 * “该派兵但永远找不到候选”每拍打一行 no candidate（真缺位与配不全混在一起，日志就没法读了）。
 * @param {{kinds?:string[], families?:number[]}} row 归一化规则行
 * @param {string[]} globalAllowed 全局允许的种类（index 的时段闸产出）
 * @returns {string[]} 有序种类数组；空数组 = 本行本轮不下田
 */
export function allowedKinds(row, globalAllowed) {
  var fams = row && Array.isArray(row.families) ? row.families : [];
  if (!fams.length) return [];
  var want = (row && Array.isArray(row.kinds) ? row.kinds : []).filter(function (k) {
    return KIND_RANK[k] != null;
  });
  var allow = Array.isArray(globalAllowed) ? globalAllowed : [];
  var out = [];
  for (var i = 0; i < KIND_ORDER.length; i++) {
    var k = KIND_ORDER[i];
    if (want.indexOf(k) >= 0 && allow.indexOf(k) >= 0) out.push(k);
  }
  return out;
}

/**
 * 由行军类型 + 目标身份 + 坐标反推在途田的种类（账本缺 kind 的旧档/重开页面时用）：
 * marchType=26 必为机械田；其余（3）先认 target 身份轴（targetType=38 / itemId 组 15 / RESOURCE level≥6，
 * 判据下沉 core/resource.isRelicTarget），再按坐标在遗迹池 → 机械活表 → 普通田依次判定。
 * ❗身份判据必须先于候选池：遗迹池靠邮件驱动扫图，刚刷新页面/还没扫过时池是空的，
 * 只靠坐标会把在途遗迹田误判成普通田而撤回（「遗迹田永不撤」是全局撤田不变量）。
 * @param {number} marchType 行军类型（3 普通/遗迹，26 机械）
 * @param {number} x 坐标
 * @param {number} y 坐标
 * @param {{itemId?:number, targetType?:number}|null} [target] 田身份载体（归一化 March.target、行军快照或账本条目；账本条目无 targetType，回 itemId 轴）
 * @returns {string} 种类编码
 */
export function inferKind(marchType, x, y, target) {
  if ((marchType | 0) === MARCH_TYPE.tower) return KIND.TOWER;
  if (isRelicTarget(target)) return KIND.RELIC;
  var key = (x | 0) + ',' + (y | 0);
  if (relic.has(key)) return KIND.RELIC;
  if (tower.has(key)) return KIND.TOWER;
  return KIND.NORMAL;
}

/**
 * 由种类 + 坐标反推在途田的矿脉级（账本缺 level 时用）：遗迹恒 6、机械查活表（未探到矿脉级时用设施级兜底，
 * 实证规律 设施级 ≤ 矿脉级 → 保守低估）、普通查 RESOURCE 反查。
 * @param {string} kind 种类编码
 * @param {number} x 坐标
 * @param {number} y 坐标
 * @param {number} [itemId] 行军 target.itemId（普通田反查家族/等级的唯一线索）
 * @returns {number} 矿脉级；推断不出回 0
 */
export function inferLevel(kind, x, y, itemId) {
  var key = (x | 0) + ',' + (y | 0);
  if (kind === KIND.RELIC) return 6;
  var e = tower.entryAt(key);
  if (e) return e.ore | 0 || e.level | 0;
  if (itemId) {
    var m = normal.resourceMeta(itemId);
    if (m && m.level) return m.level | 0;
  }
  return 0;
}

/**
 * 由种类 + 坐标反推机械设施级（非机械田恒 0）：只机械活表能给出，探不到回 0。
 * @param {string} kind 种类编码
 * @param {number} x 坐标
 * @param {number} y 坐标
 * @returns {number} 设施级
 */
export function inferFacility(kind, x, y) {
  if (kind !== KIND.TOWER) return 0;
  var e = tower.entryAt((x | 0) + ',' + (y | 0));
  return e ? e.level | 0 : 0;
}

/**
 * 单类取田（等价于「下田前信息获取」闭环）：遗迹 901 复验、机械 901+1034、普通 906 应答即校验。
 * aboveLow 是「同族内低位下限（矿脉级×10 + 设施级，严格大于）」，由 lowFloorOf 从 curRank 反推；
 * 遗迹田无下限需求（恒 6 级），普通田会把它整除成等级下限。
 * @param {string} kind 种类编码
 * @param {number} family 资源家族编码
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {number} [aboveLow] 低位下限（严格大于）：机械/普通升级探测用，0=不限
 * @returns {Promise<object|null>} {kind,x,y,level,facility,family,itemId,marchType,rank}
 */
async function pickKind(kind, family, taken, aboveLow) {
  var c;
  var above = aboveLow | 0;
  if (kind === KIND.RELIC) c = await relic.pick(family, taken, blacklist.has);
  else if (kind === KIND.TOWER) c = await tower.pick(family, taken, blacklist.has, above);
  else {
    // 普通田没有设施级，低位 = 等级×10，故整除后就是 pickHigher 要的「等级严格大于」下限
    var oreAbove = Math.floor(above / 10);
    c = oreAbove
      ? await normal.pickHigher(family, oreAbove, taken, blacklist.has)
      : await normal.pick(family, taken, blacklist.has);
  }
  if (!c) return null;
  var out = {
    kind: kind,
    x: c.x | 0,
    y: c.y | 0,
    level: c.level | 0, // 矿脉（资源）级；机械田未探到时上游已用设施级兜底
    facility: c.facility | 0, // 机械设施级，非机械田 0
    family: typeof c.family === 'number' ? c.family : family,
    itemId: c.itemId | 0, // 普通田才有（RESOURCE 行 id）；遗迹/机械靠 kind+坐标 反查，留 0
    marchType: marchTypeOf(kind),
  };
  out.rank = rankOf(out);
  return out;
}

/**
 * 跨族窥该种类内最优的家族（零发包，仅遗迹/机械）：逐族 peek 算 rank 取最大。
 * rank 已含家族权重，所以不需要额外的同分挑键（同 rank 必然同族，sortFamilies 的稳序已决定取谁）。
 * @param {string} kind 种类编码（relic | tower）
 * @param {number[]} fams 已归一排序的家族列表
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {number} minRank 只要 rank 严格大于该值的族（抢田传当前田 rank，派新田传 -1）
 * @returns {number} 选中的家族编码；0 = 该种类一个族都窥不到
 */
function bestFamilyFor(kind, fams, taken, minRank) {
  var bestFam = 0;
  var bestRank = -1;
  for (var i = 0; i < fams.length; i++) {
    var fam = fams[i];
    // 遗迹只有一维（田等级，无设施级）；机械给回 (矿脉级, 设施级) 两维，探不到族则回 null
    var cand =
      kind === KIND.RELIC
        ? { level: relic.peek(fam, taken, blacklist.has) | 0, facility: 0 }
        : tower.peek(fam, taken, blacklist.has);
    if (!cand) continue;
    if (!(cand.level | 0) && !(cand.facility | 0)) continue;
    var r = rankOf({ kind: kind, family: fam, level: cand.level, facility: cand.facility });
    if (minRank != null && r <= minRank) continue;
    if (r > bestRank) {
      bestRank = r;
      bestFam = fam;
    }
  }
  return bestFam;
}

/**
 * 普通田跨族搜索（唯一必须逐族发 906 的来源）：按公平轮转序逐族试，首个命中即返回，最多试 budget 个族。
 * 为何要轮转：家族优先级只适用于「已知候选打平时的挑选」，而这里探测顺序直接决定谁能被探到；
 * 硬守 FAMILY_RANK 序 + 预算闸会把低优先级族永久盲掉（高优先族恰好没田时，每拍都只白打前几个族）。
 * 为何要预算：一族最坏 NORMAL_MAX_LEVEL 发 906（等级缓存命中时 1~2 发），四族一行不设闸每拍能打出 20 发，
 * 撞进 cdTime「请求太频繁」会被游戏侧静默丢弃（无异常、无应答），反而全线误判无田。
 * @param {number[]} fams 已归一排序的家族列表
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {number} curRank 当前田 rank（0/缺省 = 不限，抢田专用）：每个族的下限各自反推，因家族权重不同而不同
 * @param {number} budget 本拍最多试几个族（0/超界 = 全部）
 * @returns {Promise<object|null>} 同 pickKind
 */
async function pickNormalAny(fams, taken, curRank, budget) {
  if (!fams.length) return null;
  var n = budget > 0 && budget < fams.length ? budget : fams.length;
  var start = rotCursor++ % fams.length;
  for (var i = 0; i < n; i++) {
    var fam = fams[(start + i) % fams.length];
    var low = curRank ? lowFloorOf(KIND.NORMAL, fam, curRank) : 0;
    var c = await pickKind(KIND.NORMAL, fam, taken, low);
    if (c) return c;
  }
  return null;
}

/**
 * 按优先级取最优田（缺位派兵用）：遗迹 → 机械 → 普通。
 * 遗迹/机械先跨族零发包选出最优族、再只对那个族发派前校验；普通田受 opt.familyBudget 约束。
 * @param {number|number[]} families 本行可选家族（归一化行里的 families）
 * @param {string[]} kinds 允许的种类（allowedKinds 产出，已有序）
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {{familyBudget?:number}} [opt] familyBudget = 本拍普通田最多探几个家族
 * @returns {Promise<object|null>} 同 pickKind
 */
export async function pickBest(families, kinds, taken, opt) {
  var fams = sortFamilies(families);
  var budget = (opt && opt.familyBudget) | 0;
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    if (kind === KIND.NORMAL) {
      var c = await pickNormalAny(fams, taken, 0, budget);
      if (c) return c;
      continue;
    }
    var fam = bestFamilyFor(kind, fams, taken, -1);
    if (!fam) continue; // 池/活表里该种类这些族都没货，不必发派前探针
    var v = await pickKind(kind, fam, taken, 0);
    if (v) return v;
  }
  return null;
}

/**
 * 本行「当前也是普通田且该族还有上升空间」吗（调用方的 906 节流闸用，零发包）：
 * 天花板按族算——雷神普通田只到 3 级，已顶格时 pickHigher 会零发包直回，
 * 若仍当成「还能探」就会白占本行的 5 分钟探测名额（其它族的真田反而探不到）。
 * @param {{kind:string, family:number, level:number}} cur 当前在途田
 * @returns {boolean} 发 906 探更高级普通田是否有意义
 */
export function wantsNormalProbe(cur) {
  if (!cur || cur.kind !== KIND.NORMAL) return false;
  return (cur.level | 0) < normal.familyMaxLevel(cur.family | 0);
}

/**
 * 升级判定（抢田用）：找一个 rank 严格大于当前田的可下候选。
 * 先做零发包预筛（按本行最优家族的天花板 maxRankOf ≤ 当前 rank 整类跳过），再对可能变优的种类做真实验证：
 *   遗迹 —— 跨族池内窥视压得过当前田才发派前 901；机械 —— 跨族活表窥视 (矿脉级,设施级) 压得过才发 901+1034；
 *   普通 —— **只有当前也是普通田时才发 906**（普通田的天花板压不过机械/遗迹，白探没意义）。
 * 家族已进 rank，所以**允许“为家族而换田”**（石油 5 级会被雷神 3 级顶掉）——这是用户为“雷神稀缺”定的代价；
 * 同 rank 仍严格不换（同种类同家族同级只换个坐标零收益，不白扔 904+902）。
 * @param {{kind:string, family:number, level:number, facility?:number}} cur 当前在途田（账本条目推断后）
 * @param {number|number[]} families 本行可选家族
 * @param {string[]} kinds 允许的种类（allowedKinds 产出）
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {{normalProbe?:boolean, familyBudget?:number}} [opt] normalProbe=false → 不允许发 906（由调用方的行级/拍级节流决定）
 * @returns {Promise<object|null>} 更优候选（同 pickKind）；无更优回 null
 */
export async function findUpgrade(cur, families, kinds, taken, opt) {
  var fams = sortFamilies(families);
  if (!fams.length) return null;
  var curRank = rankOf(cur);
  var noProbe = !!(opt && opt.normalProbe === false);
  var budget = (opt && opt.familyBudget) | 0;
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    // fams 已按 FAMILY_RANK 降序，fams[0] 是本行能碰到的最高家族：连它的天花板都压不过，零发包跳过整类
    if (maxRankOf(kind, fams[0]) <= curRank) continue;
    if (kind === KIND.NORMAL) {
      if (cur.kind !== KIND.NORMAL || noProbe) continue; // 906 只用于同种类提级/换更高优先家族
      var hi = await pickNormalAny(fams, taken, curRank, budget);
      if (hi && hi.rank > curRank) return hi;
      continue;
    }
    var fam = bestFamilyFor(kind, fams, taken, curRank);
    if (!fam) continue; // 本地打分都压不过，别发探针
    // 机械田带同族低位下限（与 peek 的口径同源：矿脉级×10 + 设施级）：跨种类/跨到更高优先家族时下限自动归 0
    var c = await pickKind(kind, fam, taken, lowFloorOf(kind, fam, curRank));
    if (c && c.rank > curRank) return c;
  }
  return null;
}
