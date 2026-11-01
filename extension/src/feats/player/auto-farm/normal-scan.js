/**
 * 普通田扫描（normal-scan）—— WORLD_SEARCH_MONSTER(906) 服务端搜索 + 应答即校验
 *
 * 为什么只搜 1~5 级：6 级田不是 906 能搜出来的普通资源点，它只由「遗迹区域刷新」邮件开出
 * （pointType 恒 38、r.itemId 如 1514/1515），故本模块 NORMAL_MAX_LEVEL=5；6 级候选一律走 lvl6-scanner。
 *
 * 优先等级高的田靠「逐级降序」保证：906 一次只按 (家族, 等级) 返回一个可采点，不带排序能力，
 * 故 pick() 从 5 级往下逐级问，首个命中即返回（旧实现固定单一等级，无法表达"优选高级田"）。
 *
 * 应答即下田前信息获取：906 应答的 point.r 自带 ownerId('0'=无主) / amount，足以判定"可下"，
 * 不再额外发 901（与机械田必须 901+1034、遗迹田必须 901 的差别见 priority.js）。
 *
 * 等级缓存（levelCache）：同一家族 3 分钟内探到的最好等级会作为下一次搜索的起点，
 * 避免「实际只有 1 级田」的行每拍白打 5 发 906；TTL 到期或失败即回退满档重探。
 *
 * 族级天花板（familyMaxLevel）：通用上界 5 是「所有族」的上界，个别族更低——实证雷神族无 4/5 级行（只到 3 级），
 * 所以逐档下探的起点要夹到该族真实上界，否则会每拍撞两次 RESOURCE 表里根本不存在的行（白循环 + 刷日志），
 * 而 pickHigher 还会多发几发等级注定不够的 906（低于下限的档探回来也要丢弃）。
 * 表未就绪时 fail-open 退回通用上界：宁可多探几档，不可因查不到表而锁死取田。
 *
 * 下沉core：906 只读发包骨架走 core/map.searchPoint，RESOURCE 表查询（groupTypeFor/resourceMeta/等级上界）走 core/resource.js；
 * 本模块只留「逐级降序 + 田专属落点谓词（ownerId/amount/taken/黑名单）」这类玩法私货。
 */
import { gameData } from '../../../core/game-api.js';
import { map } from '../../../core/map.js';
import {
  groupTypeFor,
  resourceMeta,
  maxLevelForFamily,
  RESOURCE_MAX_LEVEL,
  resetCache,
} from '../../../core/resource.js';
import { createLog } from '../../../core/log.js';

/** @type {ReturnType<typeof createLog>} 模块日志器（tag=AUTO-FARM） */
const log = createLog('AUTO-FARM');

/** @type {number} 906 搜索分类 pointType：资源 tab（1野怪/2资源/3集结/4国宝） */
const SEARCH_POINT_TYPE_RESOURCE = 2;
/** @type {number} 普通田最高可搜等级（真相下沉 core/resource.js，本模块透传供 priority 消费；6 级田只能由遗迹刷新邮件开出，906 搜不到） */
export const NORMAL_MAX_LEVEL = RESOURCE_MAX_LEVEL;
/** @type {number} 等级缓存有效期（毫秒）：过期后重新从最高档探，覆盖田被采光/新刷出的变化 */
const LEVEL_CACHE_MS = 3 * 60 * 1000;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {Object<number, {level:number, at:number}>} family → 最近探到的最好等级与时刻 */
var levelCache = {};

// groupTypeFor / resourceMeta 已下沉 core/resource.js（跨 feat 单一真相，mech-build 同用），
// 本模块经 import 取用，并在 normal 单例上透传 resourceMeta 供 index/priority 消费。

/**
 * 单级 906 搜索：命中即可采点（ownerId==='0' 且 amount>0），否则 null。
 * 并发门（isSending）命中即视为本轮无候选（下拍再试），不排队不重发。
 * @param {number} family 资源家族编码
 * @param {number} level 目标等级
 * @param {Set<string>} taken 本轮已占/已派点键
 * @param {function(string):boolean} isBlocked 坐标是否在黑名单
 * @returns {Promise<{x:number,y:number,level:number,itemId:number}|null>} itemId 即 RESOURCE 行 id（田位身份线索，记账本供反查）
 */
async function probeLevel(family, level, taken, isBlocked) {
  var gid = groupTypeFor(family, level);
  if (!gid) {
    // 该族这一级在 RESOURCE 表里没有行（如雷神 4/5 级）：没发包、可预期分支，故留 debug；
    // 起搜档已由 familyMaxLevel 夹住族上界，这条只在「表中途就绪/逐档越界」时当哨兵用
    log.debug('no RESOURCE row for family=%d level=%d, skip normal search.', family, level);
    return null;
  }
  if (!net) return null;
  // 906 只读骨架（isSending 门 / 异常吞掉 / 取点）下沉 map.searchPoint；本处只留田专属业务谓词
  var res = await map.searchPoint(net, {
    minLevel: level,
    maxLevel: level,
    groupType: gid,
    pointType: SEARCH_POINT_TYPE_RESOURCE,
  });
  var pt = res.point;
  if (!pt) return null;
  var key = (pt.x | 0) + ',' + (pt.y | 0);
  if (isBlocked && isBlocked(key)) return null;
  if (taken && taken.has(key)) {
    log.debug('point occupied by my march(856), skip. normal x=%d y=%d', pt.x | 0, pt.y | 0);
    return null;
  }
  var r = pt.r || {};
  if (r.ownerId != null && String(r.ownerId) !== '0') return null;
  if ((Number(r.amount) || 0) <= 0) return null;
  return { x: pt.x | 0, y: pt.y | 0, level: level, itemId: gid };
}

/**
 * 该族在本模块可用范围内的最高等级（零发包查表）：未探到时（表未就绪/该族无行）回通用上界。
 * @param {number} family 资源家族编码
 * @returns {number}
 */
function familyMaxLevel(family) {
  var m = maxLevelForFamily(family);
  return m > 0 ? Math.min(NORMAL_MAX_LEVEL, m) : NORMAL_MAX_LEVEL;
}

/**
 * 逐级降序搜索（[fromLevel → toLevel] 两端含）：首个命中即返回，并刷新该家族的等级缓存。
 * 起点自动夹到族级天花板（见 familyMaxLevel），所以雷神族不会再从 5 档起撞空行。
 * @param {number} family 资源家族编码
 * @param {number} fromLevel 起始等级（高，含）
 * @param {number} toLevel 终止等级（低，含；<1 归 1）
 * @param {Set<string>} taken 本轮已占用点键
 * @param {function(string):boolean} isBlocked 坐标黑名单判定
 * @returns {Promise<{x:number,y:number,level:number}|null>}
 */
async function searchDown(family, fromLevel, toLevel, taken, isBlocked) {
  var hi = Math.min(familyMaxLevel(family), fromLevel | 0);
  var lo = Math.max(1, toLevel | 0);
  for (var lv = hi; lv >= lo; lv--) {
    var c = await probeLevel(family, lv, taken, isBlocked);
    if (c) {
      levelCache[family] = { level: lv, at: Date.now() };
      return c;
    }
  }
  return null;
}

/** @returns {number} 本家族本次搜索的起点等级（缓存未过期时用缓存值，否则满档） */
function startLevel(family) {
  var c = levelCache[family];
  if (!c) return NORMAL_MAX_LEVEL;
  if (Date.now() - (c.at || 0) > LEVEL_CACHE_MS) return NORMAL_MAX_LEVEL;
  return Math.max(1, Math.min(NORMAL_MAX_LEVEL, c.level | 0));
}

/**
 * 普通田候选（按等级从高到低取第一个可下的）。
 * @param {number} family 资源家族编码
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {function(string):boolean} isBlocked 坐标黑名单判定
 * @returns {Promise<{x:number,y:number,level:number}|null>}
 */
function pick(family, taken, isBlocked) {
  return searchDown(family, startLevel(family), 1, taken, isBlocked);
}

/**
 * 只找「严格高于 aboveLevel」的普通田（升级抢田专用）：逐级降序、不读缓存起点，
 * 但只探 (aboveLevel, 族上界] 这些档——低于下限的档探回来也会因「不够高」丢弃，白掷 906。
 * 代价是每次最多 (族上界−aboveLevel) 发 906（金/油/粮最多 5−above，雷神封顶 3）；
 * 调用方（priority.findUpgrade）已按「当前也是普通田 + 每行 5 分钟一次 + 单拍最多 1 行」限流。
 * @param {number} family 资源家族编码
 * @param {number} aboveLevel 当前田等级（返回值必 > 该值）
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {function(string):boolean} isBlocked 坐标黑名单判定
 * @returns {Promise<{x:number,y:number,level:number}|null>}
 */
function pickHigher(family, aboveLevel, taken, isBlocked) {
  var above = aboveLevel | 0;
  var hi = familyMaxLevel(family);
  if (above >= hi) return Promise.resolve(null); // 该族已顶格（雷神普通田 3 级封顶）：零发包直回
  return searchDown(family, hi, above + 1, taken, isBlocked);
}

/** @param {object} n 网络底座（ctx.net） */
function install(n) {
  net = n;
}

/** 清空模块态（run 复位：缓存是页面级优化，跨会话不保留） */
function reset() {
  resetCache();
  levelCache = {};
}

/** @returns {number} 本服服务器时间（秒；读不到 0，本模块不依赖它，仅供诊断） */
function serverNow() {
  return gameData.serverTime() || 0;
}

/** 普通田扫描单例 */
export const normal = {
  install,
  reset,
  pick,
  pickHigher,
  familyMaxLevel,
  resourceMeta,
  serverNow,
};
