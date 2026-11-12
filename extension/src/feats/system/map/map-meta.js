/**
 * 全局地图 feat 私货层：筛选树/图例配色（FILTER_TREE 家族）、扫描网格调参（SCAN_GRID）、
 * 渲染样式、面板默认值、归属过滤谓词（classifyPoint/playerPass）——只服务「全局地图」这个 feat。
 * 跨 feat 复用的地图真相（瓦片/尺寸/pointType 字典/坐标转换/901 查询）已下沉 core/map.js，本处只引用。
 *
 * SCAN_GRID 数值来源（实证，见 references/游戏逆向/全局地图知识点归档.md）：
 *   单窗 94×99 被服务器完整受理 59 次（扫描报文实录）；回点窗 x±58.4/y±39.2。
 */
import { SERVER, CITY_POINT_TYPE } from '../../../core/map.js';

/**
 * 扫描网格（定标固定格）：按 901 回点窗实证直接标定，格尺寸≈窗口尺寸，数据严格落在自己格内。
 *   实证（扫描实录 59 组 req/resp 配对，viewLevel=1，密集块 n>300）：
 *   回点窗以请求 (x,y) 为中心，y 向 ±39.2（总高 ≈78.3，与请求 height 无关的硬上限）、x 向 ±58.4（总宽 ≈117）。
 *   · 列宽 gw = 816/7 ≈ 116.57 ≤ 窗宽 117（余量 0.42；请求宽给满 117 时窗口按 1.24× 只会更大，两模型均覆盖）→ 7 列恰好铺满无横缝；
 *   · 行高 gh = 76 < 窗高 78.3（余量 2.3）→ 13 行总高 988 > 图高 952，网格顶边与地图顶部对齐（offY=0），
 *     多出的 36 全部作底部向外 padding（顶部无空带）；各行中心请求点 ry = 76j+38 ∈ [38,950] 全在图内，不被 clamp 移位；
 *   · 总块数 7×13=91（旧 9×16=144 提速 ~37%）。
 * ⚠️ 本标定绑定 viewLevel=1；换高度档位窗口尺寸会变，需按该档重标（当前 viewLevel 已固定不可切）。
 * @type {{nx:number, ny:number, gw:number, gh:number, offY:number}}
 */
export const SCAN_GRID = { nx: 7, ny: 13, gw: SERVER.gameXMax / 7, gh: 76, offY: 0 };

/**
 * ===== 筛选树（菜单结构与配色的「唯一真相」）=====
 * 玩法五大类（城池/资源/野怪BOSS/联盟/活动）→ 各自可展开的二级细分类，每个细分类自带渲染色；
 * 未收录类型走独立的「其他」chip（overlay 按 showOther 兑底），与五大类并列共 6 个可见分组。
 * 地图上的点按「命中的细分类」着色；面板图例与 POP 弹层都从本树生成，改本数组即可增删细分类或换色。
 *
 * match 谓词字段（全可选，多字段为「与」关系）：
 *   · types[]         —— 限定的 pointType 集合（必填，用于按类型建索引）；
 *   · itemIdPrefix[]  —— 资源田家族：Math.floor(itemId/100) 命中即匹配（1=石油 5=粮食 7=金矿 16=雷神，1/5/7 归属为推测，可就地改）；
 *   · bidPrefix[]     —— 资源塔家族：Math.floor(bid/1000) 命中即匹配（52=石油塔/炼油 53=粮食塔/谷仓 71=雷神塔/提纯 51=金矿塔/采金）；
 *   · rule            —— 归属判定：'local_ally'(本区联盟) / 'local_enemy'(本区敌对) / 'cross'(跨区玩家)，依赖 ctx.selfAid/selfServer。
 * 注：夺宝飞船暂映射 pointType 133/157（待实测确认）；type 0 空白等未收录类型走 showOther 灰色兜底。
 * @type {Array<{key:string, label:string, subs:Array<{key:string, label:string, color:string, match:object}>}>}
 */
export const FILTER_TREE = [
  {
    key: 'city',
    label: '城池',
    subs: [
      {
        key: 'p_ally_local',
        label: '本区联盟',
        color: '#4a9fff',
        match: { types: [1], rule: 'local_ally' },
      },
      {
        key: 'p_enemy_local',
        label: '本区敌对',
        color: '#ff5b5b',
        match: { types: [1], rule: 'local_enemy' },
      },
      { key: 'p_cross', label: '跨区玩家', color: '#ffb04a', match: { types: [1], rule: 'cross' } },
    ],
  },
  {
    key: 'resource',
    label: '资源',
    subs: [
      { key: 'r_oil', label: '石油', color: '#d9a441', match: { types: [4], itemIdPrefix: [1] } },
      { key: 'r_food', label: '粮食', color: '#7bc043', match: { types: [4], itemIdPrefix: [5] } },
      { key: 'r_gold', label: '金矿', color: '#f2d74e', match: { types: [4], itemIdPrefix: [7] } },
      { key: 'r_thor', label: '雷神', color: '#8a7bff', match: { types: [4], itemIdPrefix: [16] } },
      { key: 't_oil', label: '石油塔', color: '#b8860b', match: { types: [24], bidPrefix: [52] } },
      { key: 't_food', label: '粮食塔', color: '#5a9e36', match: { types: [24], bidPrefix: [53] } },
      { key: 't_thor', label: '雷神塔', color: '#6a5acd', match: { types: [24], bidPrefix: [71] } },
      { key: 't_gold', label: '金矿塔', color: '#c9a227', match: { types: [24], bidPrefix: [51] } },
    ],
  },
  {
    key: 'monster',
    label: '野怪BOSS',
    subs: [
      { key: 'm_wild', label: '野怪', color: '#8a93a6', match: { types: [2] } },
      { key: 'm_rally', label: '集结BOSS', color: '#b06cff', match: { types: [12] } },
      { key: 'm_radar', label: '雷达怪', color: '#c07bd0', match: { types: [73, 74, 77] } },
      { key: 'm_thor', label: '雷神混合BOSS', color: '#ff7bd0', match: { types: [86] } },
    ],
  },
  {
    key: 'alliance',
    label: '联盟',
    subs: [
      { key: 'b_territory', label: '联盟领地', color: '#5b9bff', match: { types: [13] } },
      { key: 'b_boss', label: '联盟BOSS', color: '#ff4a4a', match: { types: [17] } },
      { key: 'b_behemoth', label: '巨兽展台', color: '#d0a06a', match: { types: [116] } },
      { key: 'b_fortress', label: '要塞资源', color: '#5b8bff', match: { types: [38] } },
      { key: 'b_alli_mine', label: '联盟矿', color: '#6ac25b', match: { types: [40] } },
      { key: 'b_storehouse', label: '帝国仓库', color: '#4ac0ff', match: { types: [82] } },
    ],
  },
  {
    key: 'activity',
    label: '活动',
    subs: [
      { key: 'b_throne', label: '王座', color: '#ffd24a', match: { types: [10] } },
      { key: 'b_site', label: '世界遗迹', color: '#d0d06a', match: { types: [15] } },
      { key: 'b_relic', label: '次元遗迹', color: '#7ad0c0', match: { types: [53] } },
      { key: 'b_refugee', label: '难民营', color: '#c0a0ff', match: { types: [18] } },
      { key: 'b_mecha', label: '机甲小游戏', color: '#7ac0d0', match: { types: [104] } },
      { key: 'b_honor', label: '荣誉殿', color: '#e0c060', match: { types: [132] } },
      { key: 'b_chip', label: '芯片空投', color: '#ff9a6a', match: { types: [259] } },
      { key: 'p_treasure', label: '夺宝飞船', color: '#ff2fb0', match: { types: [133, 157] } },
    ],
  },
];

/**
 * 细分类 key → 项 索引（面板/渲染按 key 反查配色与 label）。
 * @type {Object<string,{key:string,label:string,color:string,match:object,catKey:string,catLabel:string}>}
 */
export const SUB_MAP = (() => {
  const m = {};
  for (const cat of FILTER_TREE)
    for (const sub of cat.subs)
      m[sub.key] = Object.assign({}, sub, { catKey: cat.key, catLabel: cat.label });
  return m;
})();

/**
 * pointType → 该类型候选细分类（按声明序）。classifyPoint 只遍历同类型的候选，O(命中数) 而非全树。
 * @type {Object<number, Array>}
 */
const SUBS_BY_TYPE = (() => {
  const m = {};
  for (const cat of FILTER_TREE)
    for (const sub of cat.subs) {
      for (const t of sub.match.types || []) (m[t] = m[t] || []).push(sub);
    }
  return m;
})();

/**
 * 归属谓词：sameServer 依 ctx.selfServer 与 e.k（服号）比对；selfServer 未知(0)时视作本区，按 aid 分盟/敌。
 * @param {'local_ally'|'local_enemy'|'cross'} rule
 * @param {object} e 实体
 * @param {{selfAid?:number, selfServer?:number}} ctx
 * @returns {boolean}
 */
function matchRule(rule, e, ctx) {
  const selfAid = (ctx && ctx.selfAid) || 0;
  const selfServer = (ctx && ctx.selfServer) || 0;
  const sameServer = selfServer ? e.k === selfServer : true;
  const isAlly = !!(e.aid && selfAid && e.aid === selfAid);
  if (rule === 'local_ally') return sameServer && isAlly;
  if (rule === 'local_enemy') return sameServer && !isAlly;
  if (rule === 'cross') return !sameServer;
  return false;
}

/**
 * 单条细分类匹配（types 已由 SUBS_BY_TYPE 过滤，这里只判 itemId/bid 家族与归属 rule）。
 * @param {object} sub
 * @param {object} e
 * @param {object} ctx
 * @returns {boolean}
 */
function matchSub(sub, e, ctx) {
  const m = sub.match;
  if (m.itemIdPrefix) {
    if (e.itemId == null) return false;
    if (m.itemIdPrefix.indexOf(Math.floor(e.itemId / 100)) < 0) return false;
  }
  if (m.bidPrefix) {
    if (e.bid == null) return false;
    if (m.bidPrefix.indexOf(Math.floor(e.bid / 1000)) < 0) return false;
  }
  if (m.rule) return matchRule(m.rule, e, ctx);
  return true;
}

/**
 * 把一个实体点归到 FILTER_TREE 中首个命中的细分类；无命中返回 null（走「其他」兜底）。
 * @param {object} e 实体（含 pointType/itemId/bid/aid/k）
 * @param {{selfAid?:number, selfServer?:number}} [ctx] 归属判定基准（Number，勿 |0 截断）
 * @returns {?{key:string, label:string, color:string}}
 */
export function classifyPoint(e, ctx) {
  const list = SUBS_BY_TYPE[e.pointType];
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    if (matchSub(list[i], e, ctx)) return list[i];
  }
  return null;
}

/**
 * 玩家筛选判据（渲染层与业务层共用单一真相）：一组「仅作用于玩家城池(pointType 1)」的条件。
 *   pf = { shieldMode:'off'|'has'|'none', shieldMs:number|null, levelMin:number|null }
 * 语义：任一条件生效（shieldMode≠'off' 或 levelMin≠null）即视为「玩家筛选开启」——
 *   开启时只保留命中的玩家城池（非城池一律隐藏）；全部未生效则放行一切（含非城池）。
 *   · 护盾组：'none'→仅剩余≤0；'has'→仅剩余>0，且 shieldMs 非空时再约束「剩余 ≤ shieldMs」。
 *   · 等级组：levelMin 非空时要求 e.level ≥ levelMin（e.level 为玩家城池 p.level 整数）。
 * @param {object} e 实体（含 pointType / shield=Unix 秒到期戳 / level=玩家等级整数）
 * @param {object} pf 玩家筛选条件（见上）
 * @param {number} [now] 当前时刻 ms
 * @returns {boolean}
 */
export function playerPass(e, pf, now) {
  const mode = (pf && pf.shieldMode) || 'off';
  const levelMin = pf && pf.levelMin != null ? pf.levelMin : null;
  if (mode === 'off' && levelMin == null) return true; // 未开启：放行一切
  if (e.pointType !== CITY_POINT_TYPE) return false; // 开启后只在城池内取（非城池隐藏）
  if (mode !== 'off') {
    const rem = e.shield ? e.shield * 1000 - (now || Date.now()) : -1; // 无盾/过期 → 剩余 ≤0
    if (mode === 'none') {
      if (rem > 0) return false;
    } else if (mode === 'has') {
      if (rem <= 0) return false;
      if (pf.shieldMs != null && rem > pf.shieldMs) return false;
    }
  }
  if (levelMin != null && !(e.level >= levelMin)) return false;
  return true;
}

/**
 * 底图配色（实证真相）：本服 mapType=202 走 newTerrainV2 —— 地形是一张 GPU 合成的
 * 均匀草地平面（WORLD_TERRAIN_CONFIG[0] 的 base_image + Controltexture 棋盘），
 * 全场景探针无任何地形位图/材质（terrains/newTerrains/specTerrains 节点零组件）。
 * 因此底图不烘焙“省份色块”（那是要被否掉的绿格子），而是用两档接近的草绿做低频平滑噪声
 * 抖动（landA↔landB），得到有机的、无硬边的草地观感；可读性交给 render 层的坐标网格+边界+标记。
 * @type {{landA:string, landB:string, water:string}}
 */
export const TERRAIN_COLORS = {
  landA: '#4a6a3d', // 草地低频噪声暗端
  landB: '#6e8b56', // 草地低频噪声亮端
  water: '#3f6f96', // 预留：水系（newTerrainV2 无水系数据，暂不触发）
};

/**
 * 战略网格样式（render 层屏幕空间矢量绘制，非底图位图）：
 *   网格不再按固定坐标步长（25/100），而是按扫描块均分全图（nx×ny）→ 网格与扫描块对齐、无右边/下边不均裁切。
 *   主网格=块网格亮线；次网格=块内逐轴自适应细分（块像素间距/minPx）。不再标坐标数字（用户反馈）。
 * @type {{minor:string,major:string,border:string,minPx:number}}
 */
export const GRID_STYLE = {
  minPx: 34, // 次网格目标最小像素间距（逐轴算细分份数用）
  minor: 'rgba(18,28,12,0.22)', // 次网格线
  major: 'rgba(232,240,214,0.30)', // 主网格线（=扫描块网格）
  border: 'rgba(245,205,120,0.6)', // 全图边框
};

/**
 * 面板/存储默认项（global-map spec.defaults 与运行期兜底共用同一份真相）。
 * @type {object}
 */
export const DEFAULTS = {
  enabled: false,
  dwellMs: 2200, // 每块停留毫秒（≥ 单块 RT，压总 QPS）
  jitterMs: 500, // 停留附加随机抖动上限（错峰，去机械规律）
  viewLevel: 1, // 901 视口层级（高度）：网格按 level 1 回点窗定标，固定不可切，见 SCAN_GRID
  ttlHours: 24, // 持久数据有效期（小时），超期提示重扫
  showMarch: false, // 是否绘制行军（v1 默认关，仅存关键项）
  // 默认展示的细分类（默认全开，保证扫到的数据默认可见不隐形；玩法五大类主干见 FILTER_TREE）
  subs: [
    'p_ally_local',
    'p_enemy_local',
    'p_cross',
    'p_treasure',
    'r_oil',
    'r_food',
    'r_gold',
    'r_thor',
    't_oil',
    't_food',
    't_thor',
    't_gold',
    'm_wild',
    'm_rally',
    'm_radar',
    'm_thor',
    'b_territory',
    'b_boss',
    'b_behemoth',
    'b_fortress',
    'b_alli_mine',
    'b_storehouse',
    'b_throne',
    'b_site',
    'b_relic',
    'b_refugee',
    'b_mecha',
    'b_honor',
    'b_chip',
  ],
  showOther: true, // 未收录进 FILTER_TREE 的 pointType（如 type0 空白）是否以灰色兜底展示
};
