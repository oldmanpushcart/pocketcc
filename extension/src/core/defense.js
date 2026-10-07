/**
 * core/defense.js —— 自动防御的行为/查询层（薄，与 march.js/item.js 同侧的协议就近模块）
 *
 * 职责边界：
 *   - 收口自动防御三策略共用的「道具选择 + 迁城落点搜索」两块重活，供 feats/battle/auto-defense.js 消费；
 *   - 护盾/迁城卡的 itemId 是稳定服务器内容常量（发协议就近定义，同 march.js 的 520001/520002），不归 core/item.js；
 *   - 落点合法性判定优先走游戏权威符号（gameData.canMoveCity，只读），符号漂移/未在世界图时降级为一次 901 空格判定
 *     （复刻 imperial-decree 的 901 探点口径，一次拉窗本地判，绝不为每个候选点各发一次包）。
 *
 * 合规：只读游戏数据 + 复用只读网络查询（901），不调任何游戏 Update/Delete 改写本地数据；发包动作（910/911/902）
 *   留在 feat，本模块只产出「用哪个道具 / 迁到哪个坐标」这类决策输入。
 */
import { createLog } from './log.js';
import { item } from './item.js';
import { gameData } from './game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=DEFENSE） */
const log = createLog('DEFENSE');

// ── 发协议内容常量（服务器契约，非 bundle 符号，就近收口） ─────────────
/**
 * 护盾三档（背包道具，开盾恒 isPurchase:0）：按「时长由短到长」排列，pickShieldItem 取持有者优先命中最短档。
 * 实证报文 20261007T220646：200004=4h / 200005=8h / 200006=24h。
 * @type {Array<{itemId:number, hours:number}>}
 */
const SHIELD_TIERS = [
  { itemId: 200004, hours: 4 },
  { itemId: 200005, hours: 8 },
  { itemId: 200006, hours: 24 },
];

/** @type {number} 迁城卡 itemId（背包迁城，911 单档，实证 20261007T220646；目前仅此一档） */
const ITEM_MOVE_CITY = 200003;

/** @type {number} 「贴近敌主城」的切比雪夫半径（定案：以敌基地坐标为原点周围 8 个坐标单位内取最近可落点，无则放弃顺延） */
const NEAR_RADIUS = 8;

/** @type {number} 「迁城逃避」在我方主城周围搜索的切比雪夫上限带（在此带内取背向敌、离敌更远的可落点） */
const AWAY_RADIUS = 20;

/** @type {number} RequestId.GET_WORLD_INFO：视口拉点（落点合法性 901 降级判定用，同 imperial-decree 口径） */
const CMD_GET_WORLD_INFO = 901;

/** @type {{xMax:number, yMax:number}} 本服世界坐标兜底上界（core 不回引 feats/map/map-meta，取实证常量：gameXMax=408*2、gameYMax=952） */
const WORLD_BOUNDS = { xMax: 816, yMax: 952 };

/**
 * 应答 data 归一化（旧 JSON 链路 data 常为字符串，兜底已对象化）。永不抛。
 * @param {*} s net.Ret.data / 载荷
 * @returns {object|null} 解析后的对象；空/解析失败返回 null
 */
function parseMaybe(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  if (typeof s === 'string') { try { return JSON.parse(s); } catch (e) { return null; } }
  return null;
}

/**
 * 从背包可用护盾中挑选「时长最短的那一档」（定案：200004→200005→200006 首个 item.amount>0 者）。
 * @returns {number|null} 护盾 itemId；三档皆无返回 null（→ 开盾策略判不可行）
 */
function pickShieldItem() {
  for (var i = 0; i < SHIELD_TIERS.length; i++) {
    var id = SHIELD_TIERS[i].itemId;
    if (item.amount(id) > 0) return id;
  }
  return null;
}

/** 欧氏距离平方（比较远近无需开方，避开 Math.sqrt 噪声且保序） */
function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

/**
 * 用一次 901 拉窗构建「占用格集合」（pointType≠0 视为被占，空白/无点视为可落）。
 * @param {object|null} net pocketcc.net 底座
 * @param {{x:number, y:number}} center 拉窗中心（即搜索锚点，回点窗以其为中心 ±58/±39，恒覆盖半径 ≤20 的搜索带）
 * @param {number} serverId 服号（901 body.k）
 * @returns {Promise<Set<string>|null>} 'x,y' → 占用 的集合；请求失败/结构异常返回 null（→ 无从判定，调用方判无落点）
 */
async function fetchOccupancy(net, center, serverId) {
  if (!net) return null;
  var body = { x: center.x | 0, y: center.y | 0, k: serverId | 0, rid: 0, width: 40, height: 40, marchInfo: false, viewLevel: 1 };
  var ret;
  try { ret = await net.send(CMD_GET_WORLD_INFO, body); }
  catch (err) { log.debug('findRelocatableSpot 901 send error: %s', err && err.message); return null; }
  if (!ret || !ret.ok) { log.debug('findRelocatableSpot 901 not ok. code=%s', ret && ret.code); return null; }
  var data = parseMaybe(ret.data) || {};
  var list = Array.isArray(data.pointList) ? data.pointList : [];
  var occ = new Set();
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p) continue;
    if ((p.pointType | 0) !== 0) occ.set((p.x | 0) + ',' + (p.y | 0));   // 非空白 = 被占（含玩家城/资源田/野怪/遗迹等）
  }
  return occ;
}

/**
 * 构造逐候选合法性判定器 (x,y)=>boolean：
 *   - 游戏符号可用（canMoveCity 在锚点上给出确定 true/false）→ 全程用符号权威判定；
 *   - 符号不可用（null：Home 场景无地图模型 / 符号漂移）→ 一次 901 占位图降级判定。
 * @param {{x:number, y:number}} anchor 搜索锚点
 * @param {{net?:object, serverId?:number}} opts 网络底座与服号（901 降级路径用）
 * @returns {Promise<((x:number, y:number)=>boolean)|null>} 判定器；无法建立（901 也拉不到）返回 null
 */
async function makeJudge(anchor, opts) {
  var sym = gameData.canMoveCity(anchor.x | 0, anchor.y | 0);
  if (sym === true || sym === false) {
    // 符号在场：逐候选向游戏权威判定（仍对越界做前置兜底，符号一般自拒但这里更省调用）
    return function (x, y) { return gameData.canMoveCity(x, y) === true; };
  }
  var occ = await fetchOccupancy(opts && opts.net, anchor, (opts && opts.serverId) | 0);
  if (!occ) return null;   // 既无符号也拉不到 901 → 无从判定
  return function (x, y) { return !occ.has(x + ',' + y); };
}

/** 由锚点向外按切比雪夫环逐格搜「距锚点最近的可落点」，radius 内全无 → null（不退让取更远点） */
function searchNear(anchor, judge, inBounds, radius) {
  var ax = anchor.x | 0, ay = anchor.y | 0;
  for (var r = 0; r <= radius; r++) {
    for (var dx = -r; dx <= r; dx++) {
      for (var dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 只走本环边框
        var x = ax + dx, y = ay + dy;
        if (!inBounds(x, y)) continue;
        if (judge(x, y)) return { x: x, y: y };
      }
    }
  }
  return null;
}

/** 在我方主城周围取「背向威胁、离威胁更远」的可落点：带内所有可落点里选距威胁最远者；无更远点 → null */
function searchAway(home, threat, judge, inBounds, radius) {
  var hx = home.x | 0, hy = home.y | 0;
  var thx = threat ? threat.x | 0 : hx, thy = threat ? threat.y | 0 : hy;
  var base = dist2(thx, thy, hx, hy);
  var best = null, bestD = base;
  for (var r = 1; r <= radius; r++) {
    for (var dx = -r; dx <= r; dx++) {
      for (var dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var x = hx + dx, y = hy + dy;
        if (!inBounds(x, y)) continue;
        if (!judge(x, y)) continue;
        var d = dist2(thx, thy, x, y);
        if (d > bestD) { bestD = d; best = { x: x, y: y }; }   // 严格比当前基线/已选更远
      }
    }
  }
  return best;
}

/**
 * 搜索一个合法可迁落点（迁城卡落点，B/C 两策略共用）。
 * @param {{x:number, y:number}} anchor 搜索锚点：near 模式=敌主城坐标；away 模式=我方主城坐标
 * @param {{mode:'near'|'away', radius?:number, threat?:{x:number,y:number},
 *          bounds?:{xMax:number,yMax:number}, ctx?:{net:object, serverId:number}}} [opts]
 *   near：在 anchor 周围 radius（默认 8）内取距敌最近可落点；away：在 anchor 周围 radius（默认 20）带内取背向 threat 更远可落点。
 * @returns {Promise<{x:number, y:number}|null>} 可落坐标；radius 内无落点/无从判定 → null（调用方记 fail 并顺延下一条）
 */
async function findRelocatableSpot(anchor, opts) {
  if (!anchor || anchor.x == null || anchor.y == null) return null;
  opts = opts || {};
  var bounds = opts.bounds || WORLD_BOUNDS;
  var inBounds = function (x, y) { return x >= 0 && y >= 0 && x <= bounds.xMax && y <= bounds.yMax; };
  var judge = await makeJudge(anchor, opts.ctx || {});
  if (!judge) { log.debug('findRelocatableSpot: 无从判定落点合法性（符号缺失且 901 不可用）'); return null; }
  if (opts.mode === 'away') {
    return searchAway(anchor, opts.threat, judge, inBounds, opts.radius || AWAY_RADIUS);
  }
  return searchNear(anchor, judge, inBounds, opts.radius || NEAR_RADIUS);
}

/** 自动防御行为/查询层单例 */
export const defense = {
  SHIELD_TIERS,
  ITEM_MOVE_CITY,
  NEAR_RADIUS,
  AWAY_RADIUS,
  WORLD_BOUNDS,
  pickShieldItem,
  findRelocatableSpot,
};
