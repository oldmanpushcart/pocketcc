/**
 * CQ26 荒芜冰原矿区 · 分层扫描引擎（feats/cq26/wl-mine/survey.js）
 *
 * 本模块是整个 feat（也是全网关）**唯一**发只读请求的地方：`2201 → 2120 → 901` 三层，
 *   与 `docs/feat-荒芜冰原-采集.md` §3.4 的链路一一对应。写动作在 act.js，判据在 legs.js，
 *   本模块不解读「能不能偷/能不能采」，只负责「把点位的标量字段从池化报文里拆出来并缓存」。
 *
 * 扫描成本纪律（用户明确要求，属结构性约束而非优化）：
 *   L0 棋盘 = 1 只读（BOARD_REFRESH_MS 节流）；对**单个**分区的精扫 = 1×2120 + 2×901 ≈ 3 只读。
 *   `scanZone` 只对**一个**分区生效，`pickStealZones` 只排序、绝不触发扫描 —— 本模块
 *   **不提供**「批量扫全部候选区」的入口；逐区惰性精扫 + 命中即停的节奏由 index.js 的 stealTick 持有。
 *   一次扫全部候选区（33 个外服分区 ≈ 99 只读）视为缺陷。
 *
 * 报文形态依据（逐字源码 / 实录，细节见 docs/acl-cq26-荒芜冰原.md §4.6 与 §2.5）：
 *   2201 req `{cid, group}`（源码 `CQ26MapData.requestData` 的第三键 `serverId` 是调用方透传的 undefined，不参与编码）
 *        resp `{maxX, maxY, group, grid[]}`；`grid[].{type, surfaceType, pos, wastelandInfo}`；
 *              `wastelandInfo.{id, wkid, sid, regions[]}`；`region.{id, mSid, showNum, wastelandType, status, pos, areaType, specId}`
 *   2120 req `{wastelandIndex}` 或 `{wastelandIndex, sid}`（源码 `jumpToWasteland(showNum, mSid)` 恒带 sid）
 *        resp `{pos:{x, y, k}}` —— **单点非数组**，`k` 即该房间 wkid（901 的窗口 `k`）
 *   901  经 `core/map.js` 的 fetchWindow，取 `pointList` 里 `pointType===316` 行的 `m` 块
 *        请求 `k` 取房间 wkid（docs §3.5 逐值实证 `k=wkid, rid=0, viewLevel=2`），缺则按游戏同款
 *        兜底退回本服号（`wl-chest.js` 在**同一片冰原**的 315 地块上就是这么发的）
 *
 * `showNum === wastelandIndex` 是 16/16 报文实证、不是源码断言（ACL §2.5），故 L0 之后保留一次
 *   与本服 `22071 wastelandList` 的 `type/status` 交叉校验：不符只 warn 并继续（不做逐房间回退路径，
 *   因为回退要 16 次 2120，成本模型不允许；真分叉时日志足以暴露、判据侧仍由 901 的 `m.specIndex` 兜底）。
 *
 * 池化对象红线：报文 `pointList` / `region` 对象一律**同帧**拆成新建标量对象，原始引用不外泄、不入缓存。
 */
import { createLog } from '../../../core/log.js';
import { bits, worldMap } from '../../../core/game-api.js';
import { fetchWindow } from '../../../core/map.js';
import { CODE_NOT_SENT } from '../../../core/util.js';
import {
  BOARD_REFRESH_MS,
  CMD_MAP_SINGLE,
  CMD_NWL_POS,
  CMD_WORLD_INFO,
  GRID_TYPE_WASTELAND,
  LAND_TYPE_GATHER,
  POINT_TYPE_RESOURCE,
  SCAN_HEIGHT,
  SCAN_VIEW_LEVEL,
  SCAN_WIDTH,
  SCAN_Y_OFFSET,
  ZONE_MEMO_TTL_MS,
} from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-MINE-SURVEY');

// ── 模块态（全部是「可重放读通道」的缓存，pause 时整片丢弃）────────────────
/**
 * @type {{ownZones:object[], stealZones:object[], regionCount:number}|null}
 * L0 棋盘骨架：只留 `(mSid, showNum, wkid, type, status)` 五个标量，612 条原始 region 用完即弃
 */
var board = null;
/** @type {number} 上次成功刷新棋盘的本地时刻（ms），0=从未 */
var boardAt = 0;
/** @type {Promise<object>|null} 2201 在途合流（并发调用复用一个 Promise，同刻至多发一发） */
var boardInFlight = null;
/**
 * @type {Object<string, {points:object[], scannedAt:number, stealable:boolean, hit:boolean}>}
 * 分区精扫缓存，键 `mSid_showNum`；`stealable=false` 即「该区本轮无目标」黑名单（TTL 内不再重扫）
 */
var memo = Object.create(null);
/**
 * @type {Object<string, Promise<object>>} 同区精扫在途合流：采集腿与协助腿吃的是同一批本服分区，
 *   不合并会让两条腿各发一遍 1×2120 + 2×901（`getZoneAnchor` 的 `isSending` 只挡 2120 那一瞬）。
 */
var scanInFlight = Object.create(null);
/** @type {number} memo 代际：reset 期间在途的扫描结果不回写新缓存 */
var memoSeq = 0;

/**
 * 分区主键（与 ACL §2.5 的 region 主键同构：`(mSid, showNum)` 唯一确定一个分区）。
 * @param {{sid:number, showNum:number}} zone 分区骨架
 * @returns {string}
 */
export function zoneKey(zone) {
  return (Number(zone && zone.sid) || 0) + '_' + (Number(zone && zone.showNum) || 0);
}

/**
 * 丢弃全部读通道缓存（feat pause / 停用时调用）：这些快照都可能被服务器推送改写，
 *   跨停用时保留会拿旧分区骨架去发写请求。
 */
export function reset() {
  board = null;
  boardAt = 0;
  boardInFlight = null;
  memo = Object.create(null);
  scanInFlight = Object.create(null);
  memoSeq++;
}

/** 棋盘骨架是否仍在节流窗内（供 index.js 的 debug 与 stealTick 的「睡到下次刷新」判据）。 */
export function boardFresh() {
  return !!board && Date.now() - boardAt < BOARD_REFRESH_MS;
}

/** 当前棋盘骨架（纯读，可能为 null=尚未刷出）。 */
export function boardState() {
  return board;
}

/** 22071（分区状态推）到达时提前失效棋盘：外部开分区没有别的可观测信号。 */
export function invalidateBoard() {
  boardAt = 0;
}

/**
 * memo 读（纯读，不触发扫描）：TTL 内命中回 entry，过期或无回 null。
 * @param {string} key zoneKey 产出
 * @param {number} [nowMs] Date.now() 基准（便于单测注入）
 * @returns {object|null}
 */
export function memoGet(key, nowMs) {
  var e = memo[key];
  if (!e) return null;
  var now = nowMs == null ? Date.now() : nowMs;
  return now - e.scannedAt < ZONE_MEMO_TTL_MS ? e : null;
}

/**
 * 记一笔「该分区这拍盗出了手」的产出标记，供下一拍 pickStealZones 把它顶到队头。
 * @param {string} key zoneKey 产出
 */
export function markZoneHit(key) {
  var e = memo[key];
  if (e) e.hit = true;
}

// ── L0：棋盘骨架（2201）──────────────────────────────────────────────────
/**
 * 刷新棋盘骨架：1 发 2201，受 BOARD_REFRESH_MS 节流，在途合流。
 * @param {{sendGuarded:Function, isSending?:Function}} net 已安装 net
 * @param {{cid:number, group:number, originSid:number|null}} q 请求参数 + 分桶基准（每次现读，ACL 坑 12）
 * @returns {Promise<{ok:boolean, cached:boolean, code:*, ownZones:object[], stealZones:object[]}>}
 */
export async function refreshBoard(net, q) {
  var now = Date.now();
  if (board && now - boardAt < BOARD_REFRESH_MS) {
    return {
      ok: true,
      cached: true,
      code: 0,
      ownZones: board.ownZones,
      stealZones: board.stealZones,
    };
  }
  var empty = { ok: false, cached: false, code: null, ownZones: [], stealZones: [] };
  if (!net) return Object.assign(empty, { code: CODE_NOT_SENT });
  // `cid`/`group` 取不到就发不出合法 2201（cid<=0 已被 ACL 侧挡成 null，这里再兜一层数值闸）
  if (!(Number(q && q.cid) > 0) || !(Number(q && q.group) > 0)) return empty;
  if (boardInFlight) return boardInFlight;
  if (net.isSending && net.isSending(CMD_MAP_SINGLE)) return empty;
  boardInFlight = (async function () {
    var ret = await net.sendGuarded(
      CMD_MAP_SINGLE,
      { cid: Number(q.cid) | 0, group: Number(q.group) | 0 },
      { protocol: 'sendPBV2' },
    );
    boardInFlight = null;
    if (!ret || !ret.ok) {
      log.debug('%d board refresh rejected. code=%s', CMD_MAP_SINGLE, ret && ret.code);
      return { ok: false, cached: false, code: ret && ret.code, ownZones: [], stealZones: [] };
    }
    var parsed = parseBoard(ret.data, q.originSid);
    board = parsed;
    boardAt = Date.now();
    log.debug(
      '%d board refreshed. regions=%d own=%d steal=%d',
      CMD_MAP_SINGLE,
      parsed.regionCount,
      parsed.ownZones.length,
      parsed.stealZones.length,
    );
    return {
      ok: true,
      cached: false,
      code: 0,
      ownZones: parsed.ownZones,
      stealZones: parsed.stealZones,
    };
  })();
  return boardInFlight;
}

/**
 * 纯函数：2201 应答 → 分区骨架两桶（不读模块态、不碰报文对象本体）。
 * 过滤链：`grid[].type===3`（棋盘上的荒芜格）→ 有 `wastelandInfo` → `region.wastelandType===3`（采集线玩法）。
 * 分桶：`region.mSid === originSid` 归本服（采集/协助腿），否则归外服（盗采腿）；
 *   `originSid` 不可得（null）时**不桶化** —— 两桶都留空并回 `regionCount`，由调用方停腿（fail-closed）。
 * @param {object} data 2201 的 PBV2 data（`{maxX, maxY, grid[]}`）
 * @param {number|null} originSid 老家服号
 * @returns {{ownZones:object[], stealZones:object[], regionCount:number}}
 */
export function parseBoard(data, originSid) {
  var ownZones = [];
  var stealZones = [];
  var grid = data && Array.isArray(data.grid) ? data.grid : [];
  var regionCount = 0;
  for (var i = 0; i < grid.length; i++) {
    var g = grid[i];
    if (!g || Number(g.type) !== GRID_TYPE_WASTELAND) continue;
    var w = g.wastelandInfo;
    if (!w || !Array.isArray(w.regions)) continue;
    // docs §4.6 字段字典：房间层 `wkid` 是独立字段，`region` 只有 `{id, mSid, showNum, wastelandType, pos, areaType, status, specId}`
    //   ——它们不同轴（实录交叉验证 `wkid=14003212 / regionId=140155`），故 `w.wkid` 优先、`w.id` 只兜底
    var roomWkid = Number(w.wkid) || Number(w.id) || 0;
    for (var j = 0; j < w.regions.length; j++) {
      var r = w.regions[j] || {};
      if (Number(r.wastelandType) !== LAND_TYPE_GATHER) continue;
      regionCount++;
      if (originSid == null) continue;
      var sid = Number(r.mSid) || 0;
      var zone = {
        // showNum 即 wastelandIndex（报文实证，非源码断言）：2120 与 2114 都用它
        showNum: Number(r.showNum) || 0,
        sid: sid,
        // 只有房间层 wkid 能兜 901 窗口的 `k`；`region.id`（regionId）不在这一轴上，绝不填进来
        wkid: roomWkid,
        type: Number(r.wastelandType) || 0,
        status: Number(r.status) || 0,
      };
      if (!zone.showNum) continue;
      if (sid === originSid) ownZones.push(zone);
      else stealZones.push(zone);
    }
  }
  return { ownZones: ownZones, stealZones: stealZones, regionCount: regionCount };
}

/**
 * 纯函数：把 L0 的本服骨架与 22071 `wastelandList` 逐条交叉校验 `showNum===wastelandIndex`。
 * 只做**日志**用途（分叉时暴露问题），不参与判据 —— 判据侧还有 901 的 `m.specIndex` 兜底。
 * @param {object[]} ownZones parseBoard 的本服桶
 * @param {Array<{index:number, status:number, type:number}>|null} lands `gameData.cq26WlLands()` 投影
 * @returns {{checked:number, mismatch:number}} 不符条数（`mismatch=0` 且 `checked>0` = 实证仍然成立）
 */
export function crossCheckLands(ownZones, lands) {
  if (!Array.isArray(lands) || !lands.length) return { checked: 0, mismatch: 0 };
  var byIndex = Object.create(null);
  for (var i = 0; i < lands.length; i++) byIndex[Number(lands[i].index) || 0] = lands[i];
  var checked = 0;
  var mismatch = 0;
  for (var j = 0; j < (ownZones || []).length; j++) {
    var z = ownZones[j];
    var l = byIndex[z.showNum];
    if (!l) continue;
    checked++;
    if (Number(l.type) !== z.type || Number(l.status) !== z.status) mismatch++;
  }
  return { checked: checked, mismatch: mismatch };
}

// ── L1：分区锚点（2120）──────────────────────────────────────────────────
/**
 * 取分区锚点（房间中心坐标 + 房间 wkid）。1 发 2120，无缓存（同一拍内锚点只用于紧接的精扫）。
 * @param {{sendGuarded:Function, isSending?:Function}} net 已安装 net
 * @param {{showNum:number, sid:number}} zone 分区骨架
 * @returns {Promise<{ok:boolean, code:*, x:number, y:number, k:number}>}
 */
export async function getZoneAnchor(net, zone) {
  var bad = { ok: false, code: null, x: 0, y: 0, k: 0 };
  if (!net || !(Number(zone && zone.showNum) > 0)) {
    return Object.assign(bad, { code: CODE_NOT_SENT });
  }
  if (net.isSending && net.isSending(CMD_NWL_POS)) return bad;
  // 逐字源码 `jumpToWasteland(region.showNum, region.mSid)`：sid 恒带（本服即本服号，非省略）
  var body = { wastelandIndex: Number(zone.showNum) | 0, sid: Number(zone.sid) || 0 };
  var ret = await net.sendGuarded(CMD_NWL_POS, body, { protocol: 'sendPBV2' });
  var pos = ret && ret.ok && ret.data ? ret.data.pos : null;
  if (!pos) {
    log.debug(
      '%d anchor unavailable. zone=%s code=%s',
      CMD_NWL_POS,
      zoneKey(zone),
      ret && ret.code,
    );
    return { ok: false, code: ret && ret.code, x: 0, y: 0, k: 0 };
  }
  return {
    ok: true,
    code: 0,
    x: Number(pos.x) || 0,
    y: Number(pos.y) || 0,
    k: Number(pos.k) || 0,
  };
}

// ── L2：矿点精扫（901 双窗）──────────────────────────────────────────────
/**
 * 精扫**单个**分区：memo TTL 内直接回缓存，否则 1×2120 + 2×901 后写入 memo。
 * 两窗 = 锚点居中 + `y - SCAN_Y_OFFSET`（单帧只在 y 向漏底部约 34 格，两帧即满覆盖；x 向偏移实测零新增）。
 * 第二窗失败不否决第一窗（已拿到的点照常入缓存，只是覆盖率打折 —— 采样口径见 §3.5 的覆盖率实证）。
 * @param {object} net 已安装 net
 * @param {{showNum:number, sid:number, wkid:number}} zone 分区骨架
 * @param {{speedOf?:Function, nowMs?:number}} [g] `speedOf(itemId)=>number|null` 采集速率兜底（RESOURCE 表）
 * @returns {Promise<{ok:boolean, code:*, fromMemo:boolean, joined:boolean, entry:object|null, key:string}>}
 *   `fromMemo`=TTL 内命中缓存；`joined`=合流到另一条腿正在发起的同一区扫描（两者都意味着零新增请求）。
 */
export async function scanZone(net, zone, g) {
  g = g || {};
  var key = zoneKey(zone);
  var now = g.nowMs == null ? Date.now() : g.nowMs;
  var hit = memo[key];
  if (hit && now - hit.scannedAt < ZONE_MEMO_TTL_MS) {
    return { ok: true, code: 0, fromMemo: true, joined: false, entry: hit, key: key };
  }
  if (scanInFlight[key]) return Object.assign({}, await scanInFlight[key], { joined: true });
  var seq = memoSeq;
  var p = doScanZone(net, zone, g, key, seq);
  scanInFlight[key] = p;
  try {
    return await p;
  } finally {
    if (scanInFlight[key] === p) delete scanInFlight[key];
  }
}

/**
 * scanZone 的实体：1×2120 + 2×901 后写 memo（并发合流与 TTL 短路都在 `scanZone` 外壳里）。
 * @param {object} net 已安装 net
 * @param {object} zone 分区骨架
 * @param {{speedOf?:Function}} g 见 `scanZone`
 * @param {string} key zoneKey 产出
 * @param {number} seq 发起时的 memo 代际
 * @returns {Promise<object>} 与 `scanZone` 同形（`joined` 由外壳补）
 */
async function doScanZone(net, zone, g, key, seq) {
  var anchor = await getZoneAnchor(net, zone);
  if (!anchor.ok) {
    return { ok: false, code: anchor.code, fromMemo: false, joined: false, entry: null, key: key };
  }
  // 逐字 docs §3.5 实证 `k=wkid`；两路 wkid 都拿不到时退回本服号（游戏同款 `t.k || UserData.ServerId`，
  //   core/map.js 注记：k 拿错会整窗 status=3 空应答）
  var winK = anchor.k || Number(zone.wkid) || worldMap.serverId() || 0;
  var seen = Object.create(null);
  var points = [];
  var code = 0;
  var windows = [anchor.y, anchor.y - SCAN_Y_OFFSET];
  for (var i = 0; i < windows.length; i++) {
    var r = await fetchWindow(net, anchor.x, windows[i], {
      k: winK,
      width: SCAN_WIDTH,
      height: SCAN_HEIGHT,
      viewLevel: SCAN_VIEW_LEVEL,
      marchInfo: false,
    });
    if (!r.ok) {
      code = r.code == null ? CODE_NOT_SENT : r.code;
      log.debug('%d scan window failed. zone=%s win=%d code=%s', CMD_WORLD_INFO, key, i, code);
      break;
    }
    var batch = ingestResourcePoints(r.points, {
      specIndex: zone.showNum,
      speedOf: g.speedOf,
    });
    for (var j = 0; j < batch.length; j++) {
      var p = batch[j];
      var pk = p.x + '_' + p.y;
      if (seen[pk]) continue;
      seen[pk] = 1;
      points.push(p);
    }
  }
  if (!points.length && code) {
    return { ok: false, code: code, fromMemo: false, joined: false, entry: null, key: key };
  }
  var entry = { points: points, scannedAt: Date.now(), stealable: true, hit: false };
  // 中途发生过 reset（pause / 停用）⇒ 这份结果照常返回，但不种进新会话的缓存
  if (seq === memoSeq) memo[key] = entry;
  log.debug('%d zone scanned. zone=%s points=%d k=%d', CMD_WORLD_INFO, key, points.length, winK);
  return { ok: true, code: 0, fromMemo: false, joined: false, entry: entry, key: key };
}

/**
 * 纯函数：901 `pointList` → 316 矿点的标量小对象数组（原始 `m` 块整包丢弃，不外泄引用）。
 * 过滤：`pointType===316`；`g.specIndex` 给定（>0）时再按 `m.specIndex` 匹配（只留该分区的点）。
 * 字段口径（`oNum=null` 表示这帧没回，不当 0 —— legs.js 与排序都要区分这两种形态）：
 *   `x/y/k` 顶层；`itemId/ownerId/initSid/specIndex/gst/gNum/oNum/stealUidList/protectUidList` 取自 `m`；
 *   `gatherSpeed` 不在 `m` 块里（游戏弹窗也是回 RESOURCE 表兜底），由 `g.speedOf` 注入。
 * @param {Array<object>} list 901 `pointList`（池化报文行）
 * @param {{specIndex?:number|null, speedOf?:(itemId:number)=>number|null}} [g]
 * @returns {object[]} 新建的标量对象数组
 */
export function ingestResourcePoints(list, g) {
  g = g || {};
  var want = Number(g.specIndex) > 0 ? Number(g.specIndex) : 0;
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var p = list[i];
    if (!p || Number(p.pointType) !== POINT_TYPE_RESOURCE) continue;
    var m = p.m;
    if (!m || typeof m !== 'object') continue;
    var x = Number(p.x) || 0;
    var y = Number(p.y) || 0;
    if (!x && !y) continue;
    var specIndex = m.specIndex == null ? null : Number(m.specIndex) || 0;
    if (want && specIndex !== want) continue;
    var itemId = Number(m.itemId) || 0;
    out.push({
      x: x,
      y: y,
      k: Number(p.k) || 0,
      itemId: itemId,
      // 报文实证 ownerId 是字符串 UID（'' / '0' / 缺失 = 无人开采）
      ownerId: m.ownerId == null ? '' : String(m.ownerId),
      initSid: Number(m.initSid) || 0,
      specIndex: specIndex,
      // 时刻/数量按 Int64 归一读（>2^53 与裸 {_low,_high} 两种形态都盖住）
      gst: bits.int64ToNum(m.gatherStartTime),
      gNum: m.gNum == null ? null : bits.int64ToNum(m.gNum),
      oNum: m.oNum == null ? null : bits.int64ToNum(m.oNum),
      gatherSpeed: g.speedOf ? g.speedOf(itemId) : null,
      stealUidList: uidStrings(m.stealUidList),
      protectUidList: uidStrings(m.protectUidList),
    });
  }
  return out;
}

/**
 * 名单 → 字符串数组标量副本（池化对象同帧拆）。
 * @param {*} list 报文里的 uid 名单（数组 / 缺失 / 空串都可能）
 * @returns {string[]}
 */
function uidStrings(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) out.push(String(list[i]));
  return out;
}

/**
 * 被动嗅探（游戏自己的 901 应答）增量并入 memo。
 * 键口径 `initSid_specIndex`：ACL §4.4 已交叉验证 2201 `region.mSid` 与 901 `m.initSid` 同语义
 *   （`wkid=14003212 / regionId=140155 / showNum=6 / mSid=4178` 正是实录被盗分区），而 `specIndex === showNum`，
 *   故嗅探行能直接落回 zoneKey 建的同一个 entry，不需要额外一发请求去对号。
 * 纪律：只改写**已存在且仍在 TTL 内**的 entry —— 嗅探窗只覆盖游戏镜头那一小块，据此新建 entry 等于把
 *   「局部可见」当成「精扫完成」，会让 `pickStealZones` 的 rank 与 `stealable` 黑名单一起失真。
 * 同点已存在则整条替换（新帧的 `gNum/oNum/名单` 是权威）；不重置 `stealable`（黑名单的语义就是「TTL 内不再重扫」，
 *   局部新帧不足以翻案）。
 * @param {Array<object>} list 901 `pointList`（池化报文行，同帧拆）
 * @param {{speedOf?:Function, nowMs?:number}} [opts]
 * @returns {number} 并入条数（0 = 这批行里没有可归属到已扫分区的点，调用方可不打日志）
 */
export function mergeSniffed(list, opts) {
  opts = opts || {};
  var now = opts.nowMs == null ? Date.now() : opts.nowMs;
  var pts = ingestResourcePoints(list, { speedOf: opts.speedOf });
  var n = 0;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    // specIndex===0 是 BWL 巨兽盛宴线的点（不属任何 NWL 分区），initSid 缺失同理无法归属
    if (!(p.initSid > 0) || !(p.specIndex > 0)) continue;
    var e = memo[p.initSid + '_' + p.specIndex];
    if (!e || now - e.scannedAt >= ZONE_MEMO_TTL_MS) continue;
    var at = -1;
    for (var j = 0; j < e.points.length; j++) {
      if (e.points[j].x === p.x && e.points[j].y === p.y) {
        at = j;
        break;
      }
    }
    if (at >= 0) e.points[at] = p;
    else e.points.push(p);
    n++;
  }
  return n;
}

/**
 * 纯函数：外服候选区排序 —— **只排序，绝不触发扫描**（惰性扫描纪律的落点）。
 * 序：上次有产出的(0) → 从未扫过的(1) → 黑名单刚过期的(3 之前但已过期)(2) → TTL 内判过「无目标」的(3)
 * 同 rank 内按 `showNum` 升序（稳定、可复跑对拍）。
 * TTL 内已判「无目标」（`stealable===false` 且未过期）的候选直接剔除 —— 本拍与 TTL 内都不再重扫。
 * @param {object[]} stealZones L0 外服桶
 * @param {{memo?:object, nowMs?:number, ttlMs?:number, statusOk?:number[]}} [g]
 * @returns {Array<{zone:object, key:string, rank:number, entry:object|null}>}
 */
export function pickStealZones(stealZones, g) {
  g = g || {};
  var now = g.nowMs == null ? Date.now() : g.nowMs;
  var ttl = g.ttlMs == null ? ZONE_MEMO_TTL_MS : g.ttlMs;
  var memoMap = g.memo || memo;
  var okStatus = g.statusOk || null;
  var out = [];
  for (var i = 0; i < (stealZones || []).length; i++) {
    var zone = stealZones[i];
    if (!zone || !zone.showNum) continue;
    if (okStatus && okStatus.indexOf(Number(zone.status)) < 0) continue;
    var key = zoneKey(zone);
    var e = memoMap[key] || null;
    var fresh = !!e && now - e.scannedAt < ttl;
    if (fresh && e.stealable === false) continue;
    var rank;
    if (fresh && e.hit) rank = 0;
    else if (!e) rank = 1;
    else if (fresh) rank = 3;
    else rank = 2;
    out.push({ zone: zone, key: key, rank: rank, entry: e });
  }
  out.sort(function (a, b) {
    return a.rank - b.rank || a.zone.showNum - b.zone.showNum;
  });
  return out;
}

/**
 * 纯函数：把「该分区本轮精扫后确认没有可盗点」写回 memo（黑名单语义，时长 = TTL）。
 * 就地改 memo entry 的 `stealable` 字段（entry 由本模块自己 new 出来，不碰报文对象）。
 * @param {string} key zoneKey 产出
 * @param {boolean} stealable true=有目标（解除黑名单）；false=无目标
 */
export function noteZoneStealable(key, stealable) {
  var e = memo[key];
  if (!e) return;
  e.stealable = !!stealable;
}
