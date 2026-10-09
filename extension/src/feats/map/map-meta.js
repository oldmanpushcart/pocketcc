/**
 * 全局地图「常量真相」：把散落在反编译源码与报文实录里的硬事实集中到一处，
 * 供 coord / terrain / scanner / render / overlay 复用。本模块是纯常量层——
 * 不触游戏符号、不依赖运行时，唯一导出给上层的「口径单一来源」。
 *
 * 数值来源（均有实证，见 references/游戏逆向/地图加载机制实录分析.md、地图模块分析报告.md）：
 *   - 瓦片 224×162、半宽高 112/81、缩放档 [1,2,4,8,16]：core/NWorldMapCommon；
 *   - 本服 cols=408/rows=952、type6/202 含 subMap：allMapInfos；
 *   - 单窗 94×99 被服务器完整受理 59 次：20260930T001240 报文实录；
 *   - pointType 分布与字段骨架：同批 pointList 实录。
 */

/** @type {{W:number,H:number,HALF_W:number,HALF_H:number}} 等距瓦片像素常量（单块菱形地块） */
export const TILE = { W: 224, H: 162, HALF_W: 112, HALF_H: 81 };

/**
 * cell 宽高比（正交俯视下还原游戏等距地皮的真实足迹）：
 *   游戏 cellToDisplay 实证——相邻 cellX 水平间距 TILE.W=224，相邻 cellY 垂直间距 TILE.H/2=81，
 *   故一个 cell 的真实占地 = 224×81（宽高比 ≈2.765）。若按正方形画 cell，本服 568×952 会错显成
 *   竖长条；按此比例则全图足迹 = 568·224 : 952·81 ≈ 1.65:1（横 landscape），与游戏一致。
 * @type {number}
 */
export const CELL_ASPECT = TILE.W / (TILE.H / 2);

/** @type {number[]} 游戏离散缩放档（zoom=1/level），自建渲染沿用语义做聚合分档 */
export const ZOOM_LEVELS = [1, 2, 4, 8, 16];

/**
 * 视口「高度/层级」档（901 请求体 viewLevel，实证 = NWorldMapComponent.getViewPortZoomLevel()）。
 * 由相机 zoomRatio 的倒数 t=1/zoomRatio 落在 ZOOM_LEVELS=[1,2,4,8,16] 的区间决定，共 0~4 五档：
 *   · 决定「视野 range」：range.w/h 每级额外 +6·2^level 格（源码 r=1<<zoomLevel），越高单请求覆盖格数越多；
 *   · 决定「返回点 LOD」：level 0 最近=全量点(nomalLayer)，level≥1 逐级拉高=服务器按层级聚合/精简(simpleLayer/zoom3)，
 *     故同一块面积在高层级下返回的点数通常更少更稀疏——本器把它做成可调项，便于对比数据量级。
 * @type {Array<{v:number,label:string}>}
 */
export const VIEW_LEVELS = [
  { v: 0, label: '0 最近·全量' },
  { v: 1, label: '1 近' },
  { v: 2, label: '2 中' },
  { v: 3, label: '3 远' },
  { v: 4, label: '4 最远·聚合' },
];

/**
 * 本服世界尺寸（cell 口径）。mapType=1/201 同尺寸。
 * game 坐标上界：x = cols·2（奇偶行错排，横向双倍编号）、y = rows。
 * @type {{cols:number, rows:number, gameXMax:number, gameYMax:number}}
 */
export const SERVER = { cols: 408, rows: 952, gameXMax: 408 * 2, gameYMax: 952 };

/**
 * 全图按 NWorldMapType 的尺寸表（v1 仅本服 world 参与扫图，其余标注供后续扩展）。
 * @type {Object<string,{name:string, rows:number, cols:number, subMap?:Array<{id:number, rect:[number,number,number,number]}>}>}
 */
export const MAP_INFOS = {
  1: { name: 'world', rows: 952, cols: 408 },
  201: { name: 'world_NTerrain', rows: 952, cols: 408 },
  6: {
    name: 'world_withBorder',
    rows: 952,
    cols: 568,
    // 边境图横向更宽：subMap 0=本服主体 [0,0,408,952]，1=右侧边境带 [408,0,160,952]
    subMap: [
      { id: 0, rect: [0, 0, 408, 952] },
      { id: 1, rect: [408, 0, 160, 952] },
    ],
  },
  202: { name: 'world_NTerrain_border', rows: 952, cols: 568 },
};

/**
 * 扫描网格（定标固定格）：按 901 回点窗实证直接标定，格尺寸≈窗口尺寸，数据严格落在自己格内。
 *   实证（dashcam 20260930 扫描 59 组 req/resp 配对，viewLevel=1，密集块 n>300）：
 *   回点窗以请求 (x,y) 为中心，y 向 ±39.2（总高 ≈78.3，与请求 height 无关的硬上限）、x 向 ±58.4（总宽 ≈117）。
 *   · 列宽 gw = 816/7 ≈ 116.57 ≤ 窗宽 117（余量 0.42；请求宽给满 117 时窗口按 1.24× 只会更大，两模型均覆盖）→ 7 列恰好铺满无横缝；
 *   · 行高 gh = 76 < 窗高 78.3（余量 2.3）→ 13 行总高 988 > 图高 952，网格顶边与地图顶部对齐（offY=0），
 *     多出的 36 全部作底部向外 padding（顶部无空带）；各行中心请求点 ry = 76j+38 ∈ [38,950] 全在图内，不被 clamp 移位；
 *   · 总块数 7×13=91（旧 9×16=144 提速 ~37%）。
 * ⚠️ 本标定绑定 viewLevel=1；换高度档位窗口尺寸会变，需按该档重标（当前 viewLevel 已固定不可切）。
 * @type {{nx:number, ny:number, gw:number, gh:number, offY:number}}
 */
export const SCAN_GRID = { nx: 7, ny: 13, gw: SERVER.gameXMax / 7, gh: 76, offY: 0 };

/** @type {number} GET_WORLD_INFO 命令号（视口拉取，客户端自报 x/y/width/height） */
export const CMD_GET_WORLD_INFO = 901;

/**
 * pointType 实体类型字典（权威源 = NWorldMapEntityType，定义于 extracted/subpack2/NWorldMapCommon.js，
 * 即 901 pointList[].pointType 的取值枚举；已用实测点反解校对：1 City/2 Monster/4 Resource/53 遗迹/132 荣誉殿 均吻合）。
 * 每项：type=服务器 pointType 值 / label=中文名 / en=枚举名 / color=渲染色 / group=筛选分组键 / field=主子对象名。
 * group 用于面板筛选与浮层图例聚合，见 POINT_GROUPS。
 * @type {Array<{type:number, label:string, en:string, color:string, group:string, field:string}>}
 */
export const POINT_TYPES = [
  // 城池
  { type: 1, label: '玩家城池', en: 'City', color: '#ff5b5b', group: 'city', field: 'p' },
  // 资源类
  { type: 4, label: '资源田', en: 'Resource', color: '#4ad07a', group: 'resource', field: 'r' },
  {
    type: 24,
    label: '资源塔',
    en: 'ResourceTower',
    color: '#35c07a',
    group: 'resource',
    field: 'b',
  },
  {
    type: 38,
    label: '要塞资源',
    en: 'FORTRESS_RESOURCE',
    color: '#5b8bff',
    group: 'alliance',
    field: 'r',
  },
  {
    type: 40,
    label: '联盟矿',
    en: 'Alliance_Mine',
    color: '#6ac25b',
    group: 'alliance',
    field: 'b',
  },
  {
    type: 82,
    label: '帝国仓库',
    en: 'WorldEmpireStorehouse',
    color: '#4ac0ff',
    group: 'alliance',
    field: 't',
  },
  // 野怪 / BOSS（含雷达怪）
  { type: 2, label: '野怪', en: 'Monster', color: '#8a93a6', group: 'monster', field: 'm' },
  { type: 12, label: '集结BOSS', en: 'RALLY_BOSS', color: '#b06cff', group: 'monster', field: 'm' },
  {
    type: 73,
    label: '雷达怪',
    en: 'RADAR_MONSTER',
    color: '#c07bd0',
    group: 'monster',
    field: 'm',
  },
  {
    type: 74,
    label: '雷达集结怪',
    en: 'RADAR_RALLY_MONSTER',
    color: '#d08be0',
    group: 'monster',
    field: 'm',
  },
  {
    type: 77,
    label: '雷达增援',
    en: 'RADAR_ASSITANCE',
    color: '#a06bb0',
    group: 'monster',
    field: 'm',
  },
  {
    type: 86,
    label: '雷神混合BOSS',
    en: 'THOR_BUFF_RALLY_MIX_BOSS',
    color: '#ff7bd0',
    group: 'monster',
    field: 'b',
  },
  // 联盟建筑 / BOSS
  { type: 13, label: '联盟领地', en: 'Territory', color: '#5b9bff', group: 'alliance', field: 'b' },
  {
    type: 17,
    label: '联盟BOSS',
    en: 'ALLIANCE_BOSS',
    color: '#ff4a4a',
    group: 'alliance',
    field: 'm',
  },
  {
    type: 116,
    label: '巨兽展台',
    en: 'ALLIANCE_BEHEMOTH_SHOW_STAND',
    color: '#d0a06a',
    group: 'alliance',
    field: 'm',
  },
  // 活动 / 特殊
  { type: 0, label: '空白', en: 'Blank', color: '#6a6a6a', group: 'activity', field: '' },
  { type: 10, label: '王座', en: 'Throne', color: '#ffd24a', group: 'activity', field: 't' },
  { type: 15, label: '世界遗迹', en: 'WorldSite', color: '#d0d06a', group: 'activity', field: 't' },
  {
    type: 53,
    label: '次元遗迹',
    en: 'NWORLD_RAISE_RELIC',
    color: '#7ad0c0',
    group: 'activity',
    field: 'm',
  },
  { type: 18, label: '难民营', en: 'RefugeeCamp', color: '#c0a0ff', group: 'activity', field: 'm' },
  {
    type: 104,
    label: '机甲小游戏',
    en: 'MECHA_MINIGAME',
    color: '#7ac0d0',
    group: 'activity',
    field: 'm',
  },
  { type: 132, label: '荣誉殿', en: 'HONOR_HALL', color: '#e0c060', group: 'activity', field: 'm' },
  {
    type: 259,
    label: '芯片祝福空投',
    en: 'CHIP_BLESSING_ITEMDROP_BUILD',
    color: '#ff9a6a',
    group: 'activity',
    field: 'm',
  },
  // 跨服夺宝（夺宝奇兵）——归活动类
  {
    type: 133,
    label: '夺宝奇兵',
    en: 'CROSS_TREASURE',
    color: '#ff5bd0',
    group: 'activity',
    field: '',
  },
  {
    type: 157,
    label: '夺宝飞船',
    en: 'CROSS_TREASURE_SHIP',
    color: '#ff2fb0',
    group: 'activity',
    field: 'm',
  },
];

/**
 * 筛选分组：由 FILTER_TREE 派生的单一真相（见下方 CAT_MAP 后的 POINT_GROUPS 定义），
 * 不再手写以免与图例分类漂移；'other' 兑底所有未收录进 POINT_TYPES 的 pointType。
 * @type {Object<string,{label:string, types:number[]}>}
 */

/**
 * pointType → 字典项索引（渲染/存档按类型取色取 label，O(1)）。
 * @type {Object<number, {label:string, color:string, group:string, field:string}>}
 */
export const POINT_TYPE_MAP = (() => {
  const m = {};
  for (const p of POINT_TYPES) m[p.type] = p;
  return m;
})();

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

/** @type {string[]} 全部细分类 key（声明序） */
export const ALL_SUB_KEYS = FILTER_TREE.reduce((a, c) => {
  for (const s of c.subs) a.push(s.key);
  return a;
}, []);

/** @type {Object<string,{key:string,label:string,subs:Array}>} 大类 key → 大类项 */
export const CAT_MAP = (() => {
  const m = {};
  for (const c of FILTER_TREE) m[c.key] = c;
  return m;
})();

/**
 * 筛选分组（由 FILTER_TREE 派生·单一真相）：cat.key → { label, types }（组内各细分类 match.types 并集）；
 * 'other' 兑底未收录类型。与图例/面板同源，改 FILTER_TREE 自动同步，两套表不再漂移。
 * @type {Object<string,{label:string, types:number[]}>}
 */
export const POINT_GROUPS = (() => {
  const g = {};
  for (const cat of FILTER_TREE) {
    const set = new Set();
    for (const s of cat.subs) for (const t of s.match.types || []) set.add(t);
    g[cat.key] = { label: cat.label, types: Array.from(set) };
  }
  g.other = { label: '其他', types: [] };
  return g;
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

/** @type {number} 玩家城池 pointType（护盾归属实体，见 POINT_TYPES） */
export const CITY_POINT_TYPE = 1;

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
 * 护盾剩余可读串（列表行/悬浮用）：无盾或已过期→「无」；否则「剩余X小时X分钟」（不足 1 小时省小时段）。
 * @param {?number} shieldSec Unix 秒到期时间戳（null/0=无）
 * @param {number} [now] 当前时刻 ms
 * @returns {string}
 */
export function shieldText(shieldSec, now) {
  const rem = shieldSec ? shieldSec * 1000 - (now || Date.now()) : -1;
  if (rem <= 0) return '无';
  const totalMin = Math.floor(rem / 60000);
  const h = Math.floor(totalMin / 60),
    m = totalMin % 60;
  return (h > 0 ? '剩余' + h + '小时' : '') + (m > 0 || h === 0 ? m + '分钟' : '');
}

/** @type {string[]} 大数字单位阶梯（与游戏 NumUtils.getLargeNumberShow 完全一致）：K,M,B,T 后接 aa..zz，每档 ×1000，共 30 档 */
const LARGE_UNITS = (() => {
  const u = ['K', 'M', 'B', 'T'];
  for (let c = 97; c <= 122; c++) u.push(String.fromCharCode(c) + String.fromCharCode(c));
  return u;
})();

/**
 * 大数字可读串（战力/兵力等）：逐字复刻游戏 NumUtils.getLargeNumberShow，与游戏内显示一字不差。
 *   单位阶梯 K(1e3)/M(1e6)/B(1e9)/T(1e12)/aa(1e15)…zz；约 3 位有效数字；默认向下截断（非四舍五入）。
 *   <1000 原样数字串；≤0 → "0"；null/空 → ""。round=true 才四舍五入（一般不传）。
 * @param {number|string} v 数值
 * @param {boolean} [round] 是否四舍五入（游戏默认 false=截断）
 * @param {boolean} [plain] <1000 时是否取整（游戏默认 false）
 * @returns {string}
 */
export function fmtLargeNum(v, round, plain) {
  if (v == null || v === '') return '';
  v = +v;
  if (!(v > 0)) return '0';
  const len = LARGE_UNITS.length;
  for (let n = 0; n < len; n++) {
    let r = 1e3;
    for (let s = n + 1; s < len; s++) r *= 1e3; // r = 1000^(len-n)，从大阈值往下扫，首个 v>=r 即当档
    if (v >= r) {
      const l = v > 100 * r ? 0 : v > 10 * r ? 1 : 2;
      const unit = LARGE_UNITS[len - n - 1];
      if (round) return (v / r).toFixed(l) + unit;
      const c = Math.pow(10, l);
      return Math.floor(v / (r / c)) / c + unit;
    }
  }
  return plain ? v.toFixed() : String(v);
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
