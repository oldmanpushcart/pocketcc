/**
 * core/resource.js —— 资源田「编号真相 + 纯查询」薄底座（对齐 map / item / march 的核心模块范式）
 *
 * 定位：只收口「跨 feat 复用的 RESOURCE 配置表事实与只读查询」，不做玩法聚合。
 * 目前唯一的复用者是「按 (家族, 等级) 用 906 搜普通田」这条链路——自动下田（auto-farm/normal-scan）
 * 与机械田建造（mech-build）都要把「田家族 + 等级」翻译成 906 的 groupType（RESOURCE 行 id），
 * 也都要把应答/账本里的 itemId 反查回家族/等级。这段翻译是纯查表、无副作用、跨 feat 同口径，
 * 故从 normal-scan 抽出下沉；此前两处各抄一份是隐患，收口后单一真相。
 *
 * ⚠ 编号轴隔离（历史上踩过的坑，务必读）：
 *  本模块只服务「资源田 / RESOURCE 行」这一条编号轴——family = Math.floor(RESOURCE.id / 100)，
 *  实证 1=石油 / 5=粮食 / 7=金矿 / 16=雷神（906 的 groupType、落点田 itemId 都在此轴）。
 *  机械田「塔」是另一条轴：bid 前缀 floor(bid/1000)（51 金 / 52 油 / 53 粮 / 71 雷神），
 *  以及职业 buffId（1101001 采金…）——那是建塔玩法私货，只有 mech-build 用，**不在本模块**，
 *  由 mech-build 自持「面板家族 ↔ 塔 bid 前缀 ↔ 落点田组(FLOOR(id/100) 轴) ↔ buff」四元组表。
 *  两条轴绝不可当作恒等合并：一座「采金」塔落在 floor(id/100)=1 的田上（实录报文实证），
 *  而 floor(id/100)=1 在采集侧叫石油——「建塔落点」与「田本身叫什么」本就是两回事。
 *  RESOURCE 表的 resource_type 字段又是第三套（游戏 ResourceType 枚举），本模块不碰。
 *
 * 等级天花板：906 只能搜到 1~5 级普通田；6 级田非 906 可达，只由「遗迹区域刷新」邮件开出
 *  （pointType 恒 38，即 core/map.js 的 FORTRESS_RES_POINT_TYPE），故本模块把通用起始上界钉为 RESOURCE_MAX_LEVEL=5。雷神族无 4/5 级行，
 *  groupTypeFor(16, 4|5) 自然返回 0，调用方据此跳过发包——天花板由「表里有没有这一行」隐式表达，
 *  无需为每族另立硬编码上限（实证金/油/粮到 5、雷神到 3，全量查询普通田实测）。
 *  逐档下探的调用方拿不到「该族到几级」会白撞空行，故本模块另外提供 maxLevelForFamily(family) 作为族级上界查询。
 *
 * 依赖方向：core → game-api（只经 l10n 能力 API 读 RESOURCE 表，不 game.get、不摸 window.pocketcc）；
 * core → core/map.js（只取 pointType=38 这一常量真相，地图字典本身归 map）。
 */
import { l10n } from './game-api.js';
import { FORTRESS_RES_POINT_TYPE } from './map.js';

/** @type {number} 906 可搜的普通田通用等级上界（6 级非 906 可达，见文件头） */
export const RESOURCE_MAX_LEVEL = 5;
/** @type {number} 遗迹田（6 级田）itemId 的组前缀：floor(id/100)=15（报文实证 itemId 1514/1515），与家族编码轴（1 油/5 粮/7 金/16 雷神）不相交 */
export const RELIC_ITEM_GROUP = 15;
/** @type {number} 遗迹田矿脉级（普通田到不了这一级） */
export const RELIC_LEVEL = 6;
/** @type {number} 遗迹田 pointType 别名（单一真相在 core/map.js 的 POINT_TYPES，本模块只做语义转名） */
export const RELIC_POINT_TYPE = FORTRESS_RES_POINT_TYPE;

/** @type {Object<string, number>} `${family}_${level}` → groupType（RESOURCE 行 id）缓存：页面生命周期内表不变 */
var groupTypeCache = {};
/** @type {Object<string, number>} family → 该族在 RESOURCE 表里的最高等级缓存（一次扫表定终页，页面内表不变） */
var familyMaxCache = {};

/**
 * 资源家族（floor(id/100) 轴）在 RESOURCE 表里存在的最高等级：等级天花板由「表里有没有这一行」隐式表达，
 * 但调用方需要它做「不必逐档试」的预筛——实证雷神族无 4/5 级行，从 5 级逐档下探会每拍撞两次注定查不到的行
 * （既刷日志白循环，pickHigher 还会多发几发等级注定不够的 906）。
 * @param {number} family 资源家族编码（1 油 / 5 粮 / 7 金 / 16 雷神）
 * @returns {number} 该族最高等级；表未就绪/该族无行回 0（调用方应 fail-open 退回通用上界，别把取田锁死）
 */
export function maxLevelForFamily(family) {
  var fk = 'f' + (family | 0);
  if (familyMaxCache[fk] != null) return familyMaxCache[fk];
  var rows = l10n.tableRows('RESOURCE') || [];
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var id = Number(row.id) || 0;
    if (!id || Math.floor(id / 100) !== (family | 0)) continue;
    var lv = Number(row.level) || 0;
    if (lv > max) max = lv;
  }
  if (max) familyMaxCache[fk] = max;
  return max;
}

/**
 * (田家族, 等级) → groupType（RESOURCE 表行 id）：家族 = floor(id/100)，等级取该行 .level 字段（非 id%100）。
 * 实证：id 506 的 level=5、1603 的 level=3。首次扫表命中即缓存；该族该级无行（如雷神 4/5 级）返回 0。
 * @param {number} fieldFamily 资源田家族编码（1 油 / 5 粮 / 7 金 / 16 雷神，即 floor(itemId/100)）
 * @param {number} level 田等级（1~5）
 * @returns {number} RESOURCE 行 id（906 的 groupType），未命中 0
 */
export function groupTypeFor(fieldFamily, level) {
  var ck = fieldFamily + '_' + level;
  if (groupTypeCache[ck] != null) return groupTypeCache[ck];
  var rows = l10n.tableRows('RESOURCE') || [];
  var gid = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var id = Number(row.id) || 0;
    if (!id || Math.floor(id / 100) !== fieldFamily) continue;
    if ((Number(row.level) || 0) !== level) continue;
    gid = id;
    break;
  }
  if (gid) groupTypeCache[ck] = gid;
  return gid;
}

/**
 * itemId → 田元数据（反查家族/等级）：itemId 即 RESOURCE 行 id（军团 856 的 target.itemId、
 * 906/901 应答的 r.itemId 同源）。家族回 floor(id/100) 轴，等级回该行 .level。
 * 6 级田的 itemId（1514/1515）floor(id/100)=15 不是家族编码，故本函数只服务普通田（1~5 级）的家族反查；
 * 6 级田家族真值以 auto-farm/lvl6-scanner 池内 resource_type 换算结果为准，不在本底座职责内。
 * @param {number|string} itemId RESOURCE 行 id
 * @returns {{family:number, level:number}|null} 查不到行回 null
 */
export function resourceMeta(itemId) {
  var id = Number(itemId) || 0;
  if (!id) return null;
  var row = l10n.tableRow('RESOURCE', String(id));
  if (!row) return null;
  return { family: Math.floor(id / 100), level: Number(row.level) || 0 };
}

/**
 * itemId 是否指向遗迹田（6 级田）：跨 feat 的单一判据，**不依赖任何玩法的候选池是否已加载**。
 * 两条轴任一命中即为真：① floor(id/100)=15（纯 id 轴，RESOURCE 表未就绪也成立）；
 * ② 该行 .level ≥ 6（6 级田只由遗迹刷新邮件开出，普通田 906 搜不到）。
 * itemId 缺失或查不到行回 false（按「非遗迹」处理）：采集行军的 target.itemId 由军团 856 恒带，
 * 缺号只在进场极早期，此时宁可放行撤回，也不把普通田误锁成不可撤的遗迹田。
 * @param {number|string} itemId RESOURCE 行 id（856 target.itemId 与 901/906 应答 r.itemId 同源）
 * @returns {boolean}
 */
export function isRelicItemId(itemId) {
  var id = Number(itemId) || 0;
  if (!id) return false;
  if (Math.floor(id / 100) === RELIC_ITEM_GROUP) return true;
  var row = l10n.tableRow('RESOURCE', String(id));
  return !!(row && (Number(row.level) || 0) >= RELIC_LEVEL);
}

/**
 * 行军/点目标是否为遗迹田（6 级田）：「遗迹田永不撤回」全局不变量的单一判据。
 * 三条轴任一命中即为真（按硬度排序，不依赖任何玩法的候选池是否已加载）：
 *   ① targetType === 38（与 901 pointType 同轴，报文实证 856 条目恒带：普通田 4 / 遗迹田 38，不靠 RESOURCE 表）；
 *   ② itemId 组前缀 floor(id/100)=15（纯 id 轴）；③ RESOURCE 该行 .level ≥ 6。
 * 都取不到时回 false（按「非遗迹」处理）：宁可放行撤回，也不把普通田误锁成不可撤的遗迹田。
 * @param {{itemId?:number|string, targetType?:number}|null} target 归一化 March.target 或含 itemId/targetType 的行军快照
 * @returns {boolean}
 */
export function isRelicTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if ((Number(target.targetType) || 0) === RELIC_POINT_TYPE) return true;
  return isRelicItemId(target.itemId);
}

/** 清空缓存（页面级优化，跨会话/复位时不保留） */
export function resetCache() {
  groupTypeCache = {};
  familyMaxCache = {};
}

/** 资源田查询底座单例（对齐 map / item / march 的命名空间范式；具名导出与本体同源） */
export const resource = {
  RESOURCE_MAX_LEVEL,
  RELIC_ITEM_GROUP,
  RELIC_LEVEL,
  RELIC_POINT_TYPE,
  groupTypeFor,
  maxLevelForFamily,
  resourceMeta,
  isRelicItemId,
  isRelicTarget,
  resetCache,
};
