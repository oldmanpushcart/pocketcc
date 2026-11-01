/**
 * core/map.js —— 世界地图「常量真相 + 坐标转换 + 只读查询」底座（薄，非玩法聚合层）
 *
 * 定位（对齐 item.js / march.js 的核心模块范式）：
 *   - 只收口「跨 feat 复用的地图事实与只读查询」：瓦片/尺寸口径、pointType 实体字典、三系坐标互转、
 *     大数字/护盾可读串、单窗 901（GET_WORLD_INFO）拉取、906（WORLD_SEARCH_MONSTER）按条件搜一个可交互点，
 *     以及子对象兜底取字段。901/906 都只发只读查询、回吐原始点，命中判定/黑名单/归属谓词等业务留调用方。
 *   - 不做「玩法专属」的东西：扫描块网格调参（SCAN_GRID）、筛选树/图例配色（FILTER_TREE 等）、
 *     面板默认值（DEFAULTS）、渲染样式（GRID_STYLE/TERRAIN_COLORS）、归属过滤谓词（classifyPoint/playerPass）
 *     都留在 feats/system/map/map-meta.js —— 那些是「全局地图」这个 feat 的私货，不是底座真相。
 *   - 只发 901/906 拉数据（只读查询），不改写游戏任何状态；901 的 k（服号）由调用方按 `UserData.ServerId|0` 传入
 *     （实证陷阱：viewServerId() 在 Home 返回 -1，绝不可作 k，见 fetchWindow JSDoc）。
 *     906 请求体无坐标/视口无关，groupType/pointType 的语义由各调用方决定（资源/野怪/集结/惧星…）。
 *
 * 数值来源均有实证（references/游戏逆向/全局地图知识点归档.md、地图模块分析报告.md、dashcam 报文实录）：
 *   瓦片 224×162 / 半宽高 112/81、缩放档、本服 cols=408/rows=952、单窗回点窗 x±58/y±39、pointType=NWorldMapEntityType。
 */
import { parseData } from './util.js';

/** @type {{W:number,H:number,HALF_W:number,HALF_H:number}} 等距瓦片像素常量（单块菱形地块） */
export const TILE = { W: 224, H: 162, HALF_W: 112, HALF_H: 81 };

/**
 * cell 宽高比（正交俯视下还原游戏等距地皮的真实足迹）：
 *   游戏 cellToDisplay 实证——相邻 cellX 水平间距 TILE.W=224，相邻 cellY 垂直间距 TILE.H/2=81，
 *   故一个 cell 的真实占地 = 224×81（宽高比 ≈2.765）。按此比例全图足迹 ≈1.65:1（横 landscape），与游戏一致。
 * @type {number}
 */
export const CELL_ASPECT = TILE.W / (TILE.H / 2);

/** @type {number[]} 游戏离散缩放档（zoom=1/level），自建渲染沿用语义做聚合分档 */
export const ZOOM_LEVELS = [1, 2, 4, 8, 16];

/**
 * 视口「高度/层级」档（901 请求体 viewLevel，实证 = NWorldMapComponent.getViewPortZoomLevel()）。
 * 由相机 zoomRatio 的倒数 t=1/zoomRatio 落在 ZOOM_LEVELS 区间决定，共 0~4 五档：
 *   · 决定「视野 range」：range.w/h 每级额外 +6·2^level 格；
 *   · 决定「返回点 LOD」：level 0 全量点，level≥1 逐级服务器按层级聚合精简。
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

/** @type {number} GET_WORLD_INFO 命令号（视口拉取，客户端自报 x/y/width/height） */
export const CMD_GET_WORLD_INFO = 901;
/** @type {number} WORLD_SEARCH_MONSTER 命令号（服务端按 (groupType,等级区间,pointType) 搜一个可交互点，视口无关） */
export const CMD_WORLD_SEARCH = 906;

/**
 * pointType 实体类型字典（权威源 = NWorldMapEntityType，即 901 pointList[].pointType 取值枚举；
 * 已用实测点反解校对：1 City/2 Monster/4 Resource/53 遗迹/132 荣誉殿 均吻合）。
 * 每项：type=服务器 pointType 值 / label=中文名 / en=枚举名 / color=渲染色 / group=筛选分组键 / field=主子对象名。
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
 * pointType → 字典项索引（渲染/存档按类型取色取 label，O(1)）。
 * @type {Object<number, {label:string, color:string, group:string, field:string}>}
 */
export const POINT_TYPE_MAP = (() => {
  const m = {};
  for (const p of POINT_TYPES) m[p.type] = p;
  return m;
})();

/** @type {number} 玩家城池 pointType（护盾归属实体，见 POINT_TYPES） */
export const CITY_POINT_TYPE = 1;

/** @type {number} 要塞资源（王者遗迹刷出的 6 级田）pointType（见 POINT_TYPES 38 项；报文实证 dashcam 20261016 856 遗迹田条目 target.targetType=38、普通田=4） */
export const FORTRESS_RES_POINT_TYPE = 38;

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

/* ===================== 三系坐标互转（原 feats/map/coord.js，照搬 NWorldMapUtils 已验证公式，纯函数无副作用） =====================
 *   - game：服务器 tileX/tileY（奇偶行错排，横向双倍编号），901 请求/应答、nav.flyTo 用它；
 *   - cell：紧凑网格索引（地形文件与实体表按此寻址），自建渲染与 store 用它；
 *   - display：等距像素（Cocos 坐标，y 向上为负），仅在游戏内跨服换算/命中时需要。
 * 实证回环锚点（见实录文档 §4）：game(103,33) ↔ cell(51,33)。
 */

/**
 * game → cell（NWorldMapUtils 实证）：x 为奇数先归偶再折半，y 直接透传。
 * @param {number} x game x（服务器 tileX）
 * @param {number} y game y（服务器 tileY）
 * @returns {{cellX:number, cellY:number}}
 */
export function gameToCell(x, y) {
  return { cellX: (x & 1 ? x - 1 : x) / 2, cellY: y };
}

/**
 * cell → game（NWorldMapUtils 实证）：x=2·cellX，cellY 为奇数则再 +1（奇行错位），y=cellY。
 * @param {number} cellX
 * @param {number} cellY
 * @returns {{x:number, y:number}}
 */
export function cellToGame(cellX, cellY) {
  return { x: 2 * cellX + (cellY & 1 ? 1 : 0), y: cellY };
}

/**
 * cell → display（等距像素，Cocos y 向上为负）：X=cellX·TW+HALF_W(+奇行+HALF_W)，Y=-(cellY·TH/2+HALF_H)。
 * @param {number} cellX
 * @param {number} cellY
 * @returns {{dx:number, dy:number}}
 */
export function cellToDisplay(cellX, cellY) {
  const dx = cellX * TILE.W + TILE.HALF_W + (cellY & 1 ? TILE.HALF_W : 0);
  const dy = -(cellY * (TILE.H / 2) + TILE.HALF_H);
  return { dx, dy };
}

/**
 * display → cell（cellToDisplay 的近似反算，取格心命中；等距精确四象限修正由游戏 display2Game2 负责，
 * 本模块只为跳转兜底与单测对拍，不做像素级精修）。
 * @param {number} dx
 * @param {number} dy
 * @returns {{cellX:number, cellY:number}}
 */
export function displayToCell(dx, dy) {
  const cellY = Math.round((-dy - TILE.HALF_H) / (TILE.H / 2));
  const base = dx - TILE.HALF_W - (cellY & 1 ? TILE.HALF_W : 0);
  const cellX = Math.round(base / TILE.W);
  return { cellX, cellY };
}

/**
 * cell → 朴素一维索引（自建 store/render 容器键，不复用游戏 12bit 位打包）。
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} [cols] 列数（默认本服 cols）
 * @returns {number}
 */
export function cellToIndex(cellX, cellY, cols) {
  return cellY * (cols || SERVER.cols) + cellX;
}

/**
 * 朴素一维索引 → cell。
 * @param {number} index
 * @param {number} [cols] 列数（默认本服 cols）
 * @returns {{cellX:number, cellY:number}}
 */
export function indexToCell(index, cols) {
  const c = cols || SERVER.cols;
  return { cellX: index % c, cellY: Math.floor(index / c) };
}

/**
 * game 坐标是否在合法范围内（越界仅用于本地裁剪块队列，不代表服务器一定拒绝）。
 * @param {number} x game x
 * @param {number} y game y
 * @returns {boolean}
 */
export function inGameBounds(x, y) {
  return x >= 0 && y >= 0 && x <= SERVER.gameXMax && y <= SERVER.gameYMax;
}

/**
 * cell 是否落在本服全图网格内。
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {boolean}
 */
export function inCellBounds(cellX, cellY, cols, rows) {
  return cellX >= 0 && cellY >= 0 && cellX < (cols || SERVER.cols) && cellY < (rows || SERVER.rows);
}

/* ===================== 只读查询（Phase2：收口 auto-farm / imperial-decree / defense 三处同构 901 探针骨架） ===================== */

// 应答 data 归一的 parse 兜底已上收 core/util.js（单一真相），本模块经文件头 import { parseData }。

/**
 * 从 901 点位多子对象（p/b/r/t/m）里兜底取首个非空字段（城点信息常嵌在子对象里，字段名跨版本略有漂移）。
 * 先按 subs 顺序进子对象找 keys，全落空再回到点顶层找 keys（顶层摊平形态）。
 * @param {object} p 901 pointList 单点
 * @param {string[]} subs 子对象键优先级（如 ['p','r','m','t','b']）
 * @param {string[]} keys 字段候选名（如 ['aid','allianceId']）
 * @returns {*} 首个非空值；无则 null
 */
export function pickSub(p, subs, keys) {
  for (var i = 0; i < subs.length; i++) {
    var s = p[subs[i]];
    if (s && typeof s === 'object') {
      for (var j = 0; j < keys.length; j++) {
        if (s[keys[j]] != null) return s[keys[j]];
      }
    }
  }
  for (var k = 0; k < keys.length; k++) {
    if (p[keys[k]] != null) return p[keys[k]];
  }
  return null;
}

/**
 * 单窗 901（GET_WORLD_INFO）拉取：构造请求体 → 发送 → 归一应答 → 回吐 pointList。永不 reject。
 *   只做「请求 + 解析 + 取点数组」的公共骨架；命中判定/占用建集等业务留在调用方遍历 points。
 *   窗口默认 20×20 单点探针（auto-farm 机械塔探针、imperial-decree 目标探针同形）；
 *   defense 迁城占用需大窗（x±58/y±39）+ marchInfo:true，显式传 opts 覆盖。
 * @param {{send:Function}} net 已安装 net
 * @param {number} x 请求中心 game x
 * @param {number} y 请求中心 game y
 * @param {{k:number, width?:number, height?:number, viewLevel?:number, marchInfo?:boolean}} opts
 *   k=本服服号（务必 `UserData.ServerId|0`，非 viewServerId——Home 下后者返回 -1 会致 status=3 空应答）
 * @returns {Promise<{ok:boolean, code:*, points:object[], err?:*>}>} ok=false 时 points 为空数组
 */
export async function fetchWindow(net, x, y, opts) {
  opts = opts || {};
  var body = {
    x: x,
    y: y,
    k: opts.k | 0,
    rid: 0,
    width: opts.width || 20,
    height: opts.height || 20,
    marchInfo: !!opts.marchInfo,
    viewLevel: opts.viewLevel != null ? opts.viewLevel : 1,
  };
  var ret;
  try {
    ret = await net.send(CMD_GET_WORLD_INFO, body);
  } catch (err) {
    return { ok: false, code: null, points: [], err: err };
  }
  if (!ret || !ret.ok) return { ok: false, code: ret && ret.code, points: [] };
  var d = parseData(ret.data) || {};
  var list = Array.isArray(d.pointList) ? d.pointList : [];
  return { ok: true, code: ret.code, points: list };
}

/**
 * 906（WORLD_SEARCH_MONSTER）搜索骨架：isSending 门 → 发送 → 归一 → 抽一个可交互点。永不 reject。
 *   fetchWindow 的亲兄弟：同为「请求 + 解析 + 取点」的只读骨架，命中判定/黑名单/taken/ownerId 等业务谓词全留调用方。
 *   服务端一次只按 (groupType, minLevel~maxLevel, pointType) 回一个点（应答 d.point，部分场景 d.pointList[0]），
 *   不带排序能力——“逐级降序”类策略（如普通田 5→1）由调用方循环本函数实现。
 *   isSending 命中即视为本轮无候选（回 ok:false/sent:false），调用方当 noop 处理、不排队不重发。
 * @param {{send:Function, isSending?:Function}} net 已安装 net
 * @param {{groupType:number, minLevel:number, maxLevel:number, pointType:number}} body 906 请求体（逐键对齐报文，语义由调用方定）
 * @param {{cmd?:number}} [opts] cmd=线上命令号（默认 906；次通道/换号场景才需覆盖）
 * @returns {Promise<{ok:boolean, sent:boolean, code:*, point:object|null, points:object[], err?:*}>}
 *   ok=服务端受理；point=单个归一点（含 x/y 且原始字段 r/m/b/pointType 等，未做业务过滤）；无点时 point=null、points 为空数组
 */
export async function searchPoint(net, body, opts) {
  var cmd = (opts && opts.cmd) || CMD_WORLD_SEARCH;
  if (net.isSending && net.isSending(cmd))
    return { ok: false, sent: false, code: null, point: null, points: [] };
  var ret;
  try {
    ret = await net.send(cmd, body);
  } catch (err) {
    return { ok: false, sent: false, code: null, point: null, points: [], err: err };
  }
  if (!ret || !ret.ok)
    return { ok: false, sent: true, code: ret && ret.code, point: null, points: [] };
  var d = parseData(ret.data) || {};
  var points = Array.isArray(d.pointList) ? d.pointList : d.point ? [d.point] : [];
  var point = d.point || points[0] || null;
  if (!point || point.x == null || point.y == null)
    return { ok: true, sent: true, code: ret.code, point: null, points: [] };
  return { ok: true, sent: true, code: ret.code, point: point, points: points };
}

/** 世界地图底座单例（对齐 item / march 的命名空间范式；具名导出与本体同源） */
export const map = {
  TILE,
  CELL_ASPECT,
  ZOOM_LEVELS,
  VIEW_LEVELS,
  SERVER,
  MAP_INFOS,
  CMD_GET_WORLD_INFO,
  CMD_WORLD_SEARCH,
  POINT_TYPES,
  POINT_TYPE_MAP,
  CITY_POINT_TYPE,
  shieldText,
  fmtLargeNum,
  gameToCell,
  cellToGame,
  cellToDisplay,
  displayToCell,
  cellToIndex,
  indexToCell,
  inGameBounds,
  inCellBounds,
  pickSub,
  fetchWindow,
  searchPoint,
};
