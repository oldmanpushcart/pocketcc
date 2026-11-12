/**
 * CQ26 印石·荒芜冰原「遗失之箱」自动开启（cq26WlChest）
 *
 * 玩法：冰原各分区房间里散落「遗失之箱」（世界地图实体 pointType 315）。玩家侧的入口是世界地图左缘的
 * 宝箱 icon（`CQ26WLWorldUIRewardIcon`）：亮 = 有可开的箱。点 icon → 镜头跳到某颗箱 → 点地块开面板 →
 * 「领取」发一条 **不占行军名额**的 2118，奖励直接进背包（`resp.rewardResult.items`），同时服务器派一条
 * marchType 328 的**表演行军**（宝箱→城，约 10 分钟；实测不挡连开：真人 11 秒内连开 5 箱）。
 * 本 feat 与玩家看到的 icon 严格同源：有可开点就发一条 2118，**不动镜头、不派兵、不扫全图**。
 *
 * 协议清单（报文实证：印石-我的日常趟实录（2118×5 连开、
 *   同秒 22072 `remainChestNum 4→3→2→1→0`）与另一趟未定稿会话实录
 *   （`2120{9}` 与 315 地块 `specIndex=11` 同房间冲突的样本））：
 *   2118 SERIES_FROST_NWL_GET_CHEST  req `{wastelandIndex, x, y}`
 *                                    resp `{rewardResult:{resource(全 0), items:[{itemId,itemCount}]}}`
 *   22077 push NWL_WASTELAND_CHEST_POS_PUSH `{pos:[{x,y,k}]}` 未开箱**全量**快照，
 *       本人开过的点从下一份快照里消失（实录两份快照之间正好少了刚开那颗）；全库出现的 `k` 只有
 *       14001012 / 14002112 / 14002212 三个房间号
 *   22072 push SERIES_FROST_NWL_INFO_PUSH   额度唯一权威（`remainChestNum`，每个写动作同秒下发）
 *   22071 push NWL_LIST_PUSH                16 分区状态（`wastelandList[].{wastelandIndex,status,wastelandType}`）
 *   901 GET_WORLD_INFO / 10018 PUSH_TILEINFO 的 `pointType===315` 地块：
 *       `m.{specIndex, leftTimes, expireTime, initSid, uidList, itemId, playerInfo}`
 *   2119 NWL_OPENED_CHEST_LIST（已开列表）、2104/2105 BWL_*（巨兽盛宴线箱子）：**登记不接线**（见文末「刻意不做」）
 *
 * 分区号只认地块 —— 对设计稿 §3.2「用 2120 建 k→idx 映射表」的实证修订（三条互相独立的反证）：
 *   ① 未定稿会话趟实录：`2120{wastelandIndex:9}` 的应答锚点 `k=14002112`，而**同一房间**里 315 宝箱地块的
 *      `m.specIndex=11`（真人若点图标走进这格，游戏发的就是 `2118{11,…}`）⇒ k→idx 是 1:N，按映射表反查会拿
 *      错误的 wastelandIndex 出网，被拒还会把有效目标误计进拉黑；同场 `14012612` 一个房间更对应到 8 与 15 两个分区号。
 *   ② 印石-我的日常趟实录：宝箱地块 `specIndex=5` 所属分区 `wastelandType=2`（不是采集线的 3）⇒ 按 type 粗筛整片漏箱。
 *   ③ 同一场本服只有一个 status=4 的分区，22077 却覆盖 14001012 与 14002212 两个房间 ⇒「房间唯一 ⇒ 分区唯一」不成立。
 *   ⇒ 分区号（=2118 的 `wastelandIndex`）**只有一个真相源：315 地块的 `m.specIndex`**（源码逐字：
 *      `CQ26WLWorldRewardBoxPop.onClickGetReward` 取 `extData.specIndex` 当 `wastelandIndex`）。取到它有两条通道：
 *      A. 被动嗅探 901/10018 里的 315 行（真人玩冰原时几乎每拍都有，零额外请求）；
 *      B. 队头定不出号时，以**该箱自己的坐标为窗心**发一发定向 901 —— 与游戏「点 icon 跳图后客户端发出的那发」
 *         同形（实录 8679/8679 全部走 `api:"send"`，请求体 `{x,y,k,rid,width,height,marchInfo,viewLevel}`），
 *         一次应答可顺带缓存同窗（18×30）内其它宝箱 ⇒ 均摊 ≤1 发/颗、且镜头一毫米都不动。
 *
 * 触发源（全部经 `ctx.on.*` 登记，退订由 reactor 托管）：push 22077（快照，同时是投影不可用时的回落数据源）/
 *   22072（额度，到货按**额度增量**回抵乐观扣减；持平的推送不清账，见坑 15）/22071（分区状态）/10018 + resp 901（地块真相）。
 *   设计稿 §3.1 列的三路 `ctx.on.event`（CQ26_WL_CHEST_POS_UPDATE / _OPENED_CHEST_UPDATE / _LIST_INFO_CHANGE）
 *   与这三路 push **同源同时刻**：源码 `CQ26WasteLandData.onWastelandChestPosPush/onNWLInfoPush/onNWlListPush`
 *   逐字就是在各自 push 的 handler 里 `EVENT.emit(...)` ⇒ 订 push 等价且自带回落副本，不额外开 ACL 事件面。
 *
 * 闸门（按序短路，每口一条 debug/warn，见 cyclePass）：
 *   1 活动闸 cq26IsOpen → 2 本服图闸 OriginServerId===ServerId（icon 判据第二项，取不到则降级放行）
 *   → 3 额度闸 cq26WlInfo() 三态（null=本拍不动作，0=睡到日界线）→ 4 数据源闸（22077 快照 ∪ push 回落副本）
 *   → 5 时刻闸（serverTime 不可得则过期闸无从求值，本拍跳过）→ 6 日界滚清 → 7 逐点闸（pickChests：
 *      乐观已开 → 冷却/当日拉黑 → 地块 leftTimes/expire/initSid/specIndex）→ 8 sendGuarded 在途串行闸
 *      （等价游戏侧 `checkRequestIdNoRes(2118)`）。
 *
 * 刻意不做：
 *   · BWL 巨兽盛宴线的箱子（`specIndex===0` 在游戏里分叉到 2104，属另一条活动线，本 feat 只跳过并当日拉黑）；
 *   · 2119 已开列表（22077 天然排除已开点，乐观集足以盖住「已发成功、快照还没回」那一窗）；
 *   · 主动扫图 / 逐分区 2120 / 移动镜头（成本与打扰都不必要，见上文修订）；
 *   · 额度本地记账（权威只有 22072；乐观减 1 只用于**收紧**自己的出网节奏，且只覆盖「应答已到、额度推送还没来」那一小窗）。
 *     实录报文序 `2118 req → 22072(remain−1) → 22077 → 2118 resp`：额度推送**先于应答**，
 *     故乐观扣减只在结算时确认快照未动才记，且只按「这条 22072 把额度往下带了几格」回抵 —— 否则会把服务器已扣的那格
 *     扣两遍，乐观值常挂 1 ⇒ 当天最后一颗永远开不掉（卡在 wait next 22072，而它只在额度变化时才推）。
 */
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { gameData, worldMap } from '../../core/game-api.js';
import { item } from '../../core/item.js';
import { createCycle } from '../../core/cycle.js';
import { fetchWindow } from '../../core/map.js';
import { CODE_NOT_SENT, rejectText, todayStr } from '../../core/util.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-CHEST');

// ── 常量 ──────────────────────────────────────────────────────────────
/** SERIES_FROST_NWL_GET_CHEST：唯一出网的写动作，载荷 `{wastelandIndex, x, y}`（实录逐键） */
const CMD_GET_CHEST = 2118;
/** 901 GET_WORLD_INFO：唯一能拿到 315 地块 `m.specIndex/leftTimes` 的通道（经 core/map.js fetchWindow） */
const CMD_WORLD_INFO = 901;
/** push 22077：未开箱全量快照（开过的点从下一份消失） */
const PUSH_CHEST_POS = 22077;
/** push 22072：额度唯一权威 */
const PUSH_WL_INFO = 22072;
/** push 22071：分区状态（只做唤醒，不参与判据） */
const PUSH_LAND_LIST = 22071;
/** push 10018：单 tile 变更（写完即推，顺带刷新地块真相） */
const PUSH_TILE = 10018;
/** NWorldMapEntityType.CQ_26_WL_REWARD_BOX = 315（遗失之箱地块；与 marchType 315 不同源，不得互推） */
const POINT_TYPE_CHEST = 315;
/** 定向 901 的窗尺寸：逐值照抄游戏「跳图后那一发」的实录 `{width:18,height:30,viewLevel:0}` */
const PROBE_W = 18;
/** 定向 901 窗高（同上） */
const PROBE_H = 30;
/** 定向 901 视口层级（0=最近·全量；level≥1 服务器按层级精简，实证 315 行只在 viewLevel 0 的窗里稳定出现） */
const PROBE_VIEW_LEVEL = 0;
/** 地块真相 TTL（毫秒）：过期即重新定向查询；`leftTimes` 是别人的消耗，不宜信太久前的快照 */
const TILE_TTL_MS = 5 * 60 * 1000;
/** 定向查询「窗里没有找到这颗箱」后的重试冷却（毫秒）：不挡就会每拍重发同一发只读请求 */
const MISS_COOL_MS = 10 * 60 * 1000;
/** 同一点连续被拒达此次数即**当日**拉黑（防逐拍重发刷屏；日界滚清见 rolloverState） */
const MAX_REJECT = 3;
/** 单次被拒后的冷却毫秒（时序竞争类拒绝留自愈窗口，不直接拉黑） */
const REJECT_COOL_MS = 5 * 60 * 1000;
/** 乐观扣减的寿命（毫秒）：超此仍未被任何 22072 回抵 ⇒ 当作那条推送丢了，不再计入（见 quotaDebt/effectiveSpent） */
const OPT_DEBT_TTL_MS = 10 * 1000;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {Array<{x:number,y:number,k:number}>|null} 22077 的同帧标量副本（ACL 投影不可用时的回落数据源） */
var pushPos = null;
/** @type {Object<string, {x:number,y:number,k:number,specIndex:number,leftTimes:number,expireTime:number,initSid:number,atMs:number}>}
 *  地块真相缓存，键 `x_y`（只由 901/10018 的 315 行写入，是 wastelandIndex 的唯一来源） */
var tiles = Object.create(null);
/** @type {Set<string>} 已开乐观集（键 `x_y`；2118 成功即加，日界滚清，权威以 22077 下一份快照为准） */
var opened = new Set();
/** @type {Object<string,number>} `x_y` → 连续被拒次数 */
var rejectCount = Object.create(null);
/** @type {Object<string,number>} `x_y` → 冷却到期时刻（Date.now() 基准） */
var coolUntil = Object.create(null);
/** @type {Object<string,number>} `x_y` → 上次定向查询「没找到这颗箱」的时刻 */
var missAt = Object.create(null);
/** @type {string} 上三表所属服务器日（换日清空，使「当日拉黑」真止于当日） */
var rejectDay = '';
/** @type {number} 尚未被额度快照回抵的成功开箱数（乐观收紧额度，见 reconcileQuota） */
var localSpent = 0;
/** @type {number} 最后一笔乐观扣减的记账时刻（Date.now() 基准，仅用于 OPT_DEBT_TTL_MS 清陈账） */
var localSpentAt = 0;
/** @type {number|null} 上一条 22072 的 `remainChestNum`（求额度增量、判断这条推送带不带额度信息） */
var lastSnapRemain = null;
/** @type {boolean} 定向 901 在途（同刻至多发一发） */
var probeInFlight = false;
/** @type {boolean} 本轮是否开成一颗（决定下一拍用 chainMs 续开还是降频） */
var justClaimed = false;
/** @type {boolean} 上一拍是否存在可开候选（决定无动作时的降频档位） */
var lastHadCandidate = false;
/** @type {boolean} 本拍额度闸是否判为「今日已开完」（决定睡到日界线而不是 idleMs） */
var quotaZero = false;
/** @type {boolean} 「投影不可用、降级用 22077 缓存」的 warn 去重（恢复后复位） */
var aclDegradedWarned = false;
/** @type {boolean} 「额度快照不可得」debug 去重 */
var noSnapshotWarned = false;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（数据全部来自推送与内存投影，安装期不发任何请求）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  if (installed) return true;
  net = ctx.net;
  if (!net.install()) {
    net = null;
    log.warn('install failed. missing=net');
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行：订阅四路推送 + 一路应答嗅探，然后点火（退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  // 刻意**不**在此清 rejectCount/coolUntil/opened：places/kinds 门控会反复 pause→run（base/world 来回跳、
  //   进出 homeland），清零等于给一个服务器侧永久拒绝的点无限续命逐拍重撞；「当日」语义由 rolloverState 收。
  // 乐观账的推送基线从投影播种（握手期那份 22072 早已写好）：不播种则本 feat 收到的第一条推送永远
  //   `prevRemain==null` → 被当作「已与服务器对齐」清账，恰好破了下文「持平的推送不得清账」那条纪律。
  var seed = gameData.cq26WlInfo();
  lastSnapRemain = seed && seed.remainChestNum != null ? Number(seed.remainChestNum) : null;
  ctx.on.push(PUSH_CHEST_POS, onChestPosPush);
  ctx.on.push(PUSH_WL_INFO, onWlInfoPush);
  ctx.on.push(PUSH_LAND_LIST, onLandListPush);
  ctx.on.push(PUSH_TILE, onTileInfo);
  // 游戏自己视口请求的应答也走同一条 dispatch：被动嗅探 315 地块，零额外报文
  ctx.on.resp(CMD_WORLD_INFO, onTileInfo);
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉全部「可重放读通道」的缓存，避免 resume 后拿陈旧快照发写请求。
 * cycle 的自重排由 alive() 自守，push 退订由 reactor 托管；本模块无自建定时器。
 */
function pause() {
  pushPos = null;
  tiles = Object.create(null);
  missAt = Object.create(null);
  probeInFlight = false;
}

/**
 * 存活判定（cycle 与所有 await 之后的记账都过这一闸）。
 * @returns {boolean}
 */
function aliveFn() {
  return reactor.isRunning('cq26WlChest');
}

// ── 推送/应答入口 ─────────────────────────────────────────────────────
/**
 * PBV2 报文取业务体：整包是 `{header,data}`，下钻一层；平铺载荷（旧 JSON 形态、以及 901 应答）原样回落。
 * @param {object} ev bus 事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o.data || o;
}

/** 22077：未开箱全量快照（投影可用时只是冗余副本，不可用时是唯一数据源） */
function onChestPosPush(ev) {
  var b = pushBody(ev);
  var pos = b && b.pos;
  if (!Array.isArray(pos)) {
    log.warn('22077 malformed (no pos array).');
    return;
  }
  // 报文对象是池化复用的（Event.raw 只读），必须**同帧**拆成标量副本才能活到下一拍
  pushPos = pos.map(function (r) {
    return { x: Number(r && r.x) || 0, y: Number(r && r.y) || 0, k: Number(r && r.k) || 0 };
  });
  log.debug('22077 received. chests=%d', pushPos.length);
  if (aliveFn()) cycle.kick();
}

/**
 * 22072：额度快照（唯一权威）→ 按「这条推送把额度往下带了几格」回抵乐观扣减 + 唤醒（长睡中的「睡到日界线」也在此打断）。
 * 不可无条件清账：额度不变的推送（同包里 elecPower/采集态等变了）不带额度信息，抹掉在途那笔就会多撞一条被拒。
 */
function onWlInfoPush(ev) {
  var b = pushBody(ev);
  var v = b ? b.remainChestNum : null;
  // 键缺失/null/空串 与「额度掉到 0」不是一回事：Number(null)===0 会把无数据误读成见底，按 NaN 归到 null
  var raw = v == null || v === '' ? NaN : Number(v);
  var r = Number.isFinite(raw) ? raw : null;
  if (r != null) {
    localSpent = cancelQuotaDebt(localSpent, lastSnapRemain, r);
    lastSnapRemain = r;
  }
  noSnapshotWarned = false;
  if (aliveFn()) cycle.kick();
}

/** 22071：分区状态变更（只影响 icon 语境，不参与判据，纯唤醒） */
function onLandListPush() {
  if (aliveFn()) cycle.kick();
}

/**
 * 901 应答 / 10018 推送 → 把里面的 315 宝箱地块并入地块真相缓存。
 * 两条通道的行形状一致（`{x,y,k,pointType,m}`），共用一个 ingest。
 * @param {object} ev bus 事件
 */
function onTileInfo(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var list = Array.isArray(b.pointList) ? b.pointList : b.pointInfos;
  if (!Array.isArray(list) || !list.length) return;
  var n = ingestChestTiles(list, tiles, Date.now());
  if (n && aliveFn()) cycle.kick();
}

/**
 * 纯函数：报文行数组 → 315 宝箱地块并入缓存（就地改 `into`，只写自己 new 出来的对象，绝不碰报文对象本体）。
 * @param {Array<object>} list 901 `pointList` / 10018 `pointInfos`
 * @param {object} into 目标缓存（键 `x_y`）
 * @param {number} nowMs Date.now() 基准（写入 atMs）
 * @returns {number} 并入的条数（0 = 这批行里没有宝箱，调用方可不打日志）
 */
export function ingestChestTiles(list, into, nowMs) {
  var n = 0;
  for (var i = 0; i < (list || []).length; i++) {
    var p = list[i];
    if (!p || Number(p.pointType) !== POINT_TYPE_CHEST) continue;
    var m = p.m;
    if (!m || typeof m !== 'object') continue;
    var x = Number(p.x) | 0;
    var y = Number(p.y) | 0;
    if (!x && !y) continue;
    into[x + '_' + y] = {
      x: x,
      y: y,
      k: Number(p.k) || 0,
      // 缺失与 0 不是一回事：0 = 巨兽盛宴线的箱子（游戏分叉到 2104），缺失 = 这行不可用 ⇒ 都当「定不出号」
      specIndex: m.specIndex == null ? -1 : Number(m.specIndex) || 0,
      leftTimes: Number(m.leftTimes) || 0,
      expireTime: Number(m.expireTime) || 0,
      initSid: Number(m.initSid) || 0,
      atMs: nowMs,
    };
    n++;
  }
  return n;
}

// ── 数据源与候选序（纯函数层，单测逐条对拍）────────────────────────────
/**
 * 纯函数：复刻 icon 判据（源码 `CQ26WLWorldUIRewardIcon.updateIconShow` 逐字：
 * `isOpen() && OriginServerId===ServerId ? (wlBossRewardPos.length<=0 ? 灭 : 亮) : 灭`）。
 * @param {boolean} isOpen 活动是否开启
 * @param {number|null} originSid `UserData.OriginServerId`（null=取不到）
 * @param {number} curSid `UserData.ServerId`（0=取不到）
 * @param {number|null} posCount 快照里的未开箱数（null=快照未达）
 * @returns {boolean|null} null=输入不全、无从判定（调用方须按「未知」处理，不得当灭）
 */
export function iconShow(isOpen, originSid, curSid, posCount) {
  if (!isOpen) return false;
  if (originSid == null || !curSid || posCount == null) return null;
  return originSid === curSid && posCount > 0;
}

/**
 * 纯函数：额度读数 = 服务器快照 − 尚未被回抵的乐观扣减（**只往收紧的方向偏**）。
 * @param {number} snapRemain 快照 `remainChestNum`
 * @param {number} spentSinceSnapshot 快照尚未反映的本模块成功开箱条数
 * @returns {number} >=0
 */
export function reconcileQuota(snapRemain, spentSinceSnapshot) {
  return Math.max(0, (Number(snapRemain) || 0) - (Number(spentSinceSnapshot) || 0));
}

/**
 * 纯函数：一条 22072 到货后还剩几笔乐观陈账（按额度**增量**回抵，不是无脑清零）。
 * 报文实证：`2118 req → 22072(remain−1) → 22077 → 2118 resp`。
 * @param {number} spent 到货前的乐观条数
 * @param {number|null} prevRemain 上一条 22072 的 `remainChestNum`（null=本会话首条，无可比基线）
 * @param {number} curRemain 本条 22072 的 `remainChestNum`
 * @returns {number} >=0
 */
export function cancelQuotaDebt(spent, prevRemain, curRemain) {
  var s = Math.max(0, Number(spent) || 0);
  if (curRemain == null || !Number.isFinite(curRemain)) return s;
  if (prevRemain == null) return 0; // 首条快照：安装期本就没有在途笔，按「服务器已对齐」清账
  if (curRemain < prevRemain) return Math.max(0, s - (prevRemain - curRemain)); // 往下带了几格就抵几笔
  if (curRemain > prevRemain) return 0; // 额度回升（日界刷新）⇒ 乐观作废
  return s; // 持平：这条推送不带额度信息，在途扣减必须保留
}

/**
 * 纯函数：这一笔成功开箱还需不需要记乐观扣减。
 * @param {number|null} snapAtSend 出网时读到的 `remainChestNum`
 * @param {number|null} snapNow 结算时读到的 `remainChestNum`
 * @returns {boolean} true=权威快照还没反映这次开箱（需收紧）；false=已反映，再扣就是扣两遍
 */
export function needOptimisticDeduct(snapAtSend, snapNow) {
  if (snapAtSend == null || snapNow == null) return true; // 权威值不可得 → 保守收紧
  return snapNow >= snapAtSend;
}

/**
 * 当前生效的乐观扣减（**纯读**，无副作用）：超 OPT_DEBT_TTL_MS 仍未被任何 22072 回抵 ⇒ 当作那条推送丢了，不再计入。
 * @param {number} nowMs Date.now()
 * @returns {number}
 */
function quotaDebt(nowMs) {
  if (localSpent <= 0) return 0;
  return nowMs - localSpentAt >= OPT_DEBT_TTL_MS ? 0 : localSpent;
}

/**
 * 决策侧取乐观账：与 quotaDebt 同判据，但账一过期就**就地清账并留一行 debug**。
 * 宁可多撞一次被拒（info 级），也绝不因为一笔陈账把当天的最后一颗箱饿死到日界。
 * 写回只允许 cyclePass 这一个调用点；面板渲染走纯读的 quotaDebt，避免展示层改动调度账本。
 * @param {number} nowMs Date.now()
 * @returns {number}
 */
function effectiveSpent(nowMs) {
  var d = quotaDebt(nowMs);
  if (d === 0 && localSpent > 0) {
    log.debug(
      'optimistic quota debt expired (spent=%d age=%dms), drop it.',
      localSpent,
      nowMs - localSpentAt,
    );
    localSpent = 0;
  }
  return d;
}

/**
 * 纯函数：22077 快照行 → 本轮可开队列（不读模块态，闸门全部显式传参）。
 * 逐点闸序：乐观已开 → 冷却 → 当日拉黑 → 地块新鲜度 → `leftTimes`/`expireTime`/`initSid`/`specIndex`。
 * @param {Array<{x:number,y:number,k:number}>} rows 快照行
 * @param {object} g 闸门入参
 * @param {object} [g.tiles] 地块真相缓存（`x_y` → tile）
 * @param {Set<string>|Object<string,boolean>} [g.opened] 乐观已开集
 * @param {number} [g.nowSec] 服务器秒（过期闸用）
 * @param {number} [g.now] Date.now() 基准（TTL/冷却用）
 * @param {number} [g.tileTtlMs] 地块 TTL 毫秒
 * @param {Object<string,number>} [g.coolUntil] `x_y` → 冷却到期毫秒
 * @param {Object<string,number>} [g.rejectCount] `x_y` → 连续被拒次数
 * @param {number} [g.maxReject] 达此次数当日拉黑
 * @param {number|null} [g.originSid] 老家服号（null=无从校验 `initSid`，跳过该闸）
 * @returns {{ready:Array<object>, unknown:Array<object>, blocked:Array<{key:string,reason:string}>}}
 *   `ready`=地块在手、可直接发 2118；`unknown`=无新鲜地块、需定向 901 定号；`blocked`=本轮确定不开
 */
export function pickChests(rows, g) {
  var o = g || {};
  var tilesMap = o.tiles || {};
  var openedSet = o.opened || {};
  var now = o.now == null ? Date.now() : o.now;
  var nowSec = Number(o.nowSec) || 0;
  var ttl = o.tileTtlMs == null ? TILE_TTL_MS : o.tileTtlMs;
  var cool = o.coolUntil || {};
  var rej = o.rejectCount || {};
  var maxRej = o.maxReject == null ? MAX_REJECT : o.maxReject;
  var ready = [];
  var unknown = [];
  var blocked = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i] || {};
    var x = Number(r.x) | 0;
    var y = Number(r.y) | 0;
    if (!x && !y) continue;
    var key = x + '_' + y;
    if (openedSet.has ? openedSet.has(key) : openedSet[key]) continue;
    if ((cool[key] || 0) > now) {
      blocked.push({ key: key, reason: 'cooling' });
      continue;
    }
    if ((rej[key] || 0) >= maxRej) {
      blocked.push({ key: key, reason: 'blacklisted' });
      continue;
    }
    var t = tilesMap[key];
    if (!t || now - t.atMs > ttl) {
      unknown.push({ key: key, x: x, y: y, k: Number(r.k) || 0, idx: null });
      continue;
    }
    var bad = chestBlockReason(t, nowSec, o.originSid);
    if (bad) {
      blocked.push({ key: key, reason: bad });
      continue;
    }
    ready.push({
      key: key,
      x: x,
      y: y,
      // 22077 的 k 与地块的 k 同源（房间号）；地块更权威（就在同一份 m 的上下文里），故以地块为准
      k: t.k || Number(r.k) || 0,
      idx: t.specIndex,
      leftTimes: t.leftTimes,
      expireTime: t.expireTime,
    });
  }
  // 定号成本优先：同一房间（k）的箱排在一起，一发定向 901 可顺带解掉同窗多颗
  unknown.sort(function (a, b) {
    return a.k - b.k || a.x - b.x || a.y - b.y;
  });
  return { ready: ready, unknown: unknown, blocked: blocked };
}

/**
 * 纯函数：一颗箱的地块级不可开判据（源码 `CQ26WLWorldRewardBoxBuilding.refreshUI` 的显示闸逐字对齐）。
 * @param {object} t 地块（ingestChestTiles 产出的形状）
 * @param {number} nowSec 服务器秒（<=0 = 无从判过期，跳过过期闸）
 * @param {number|null} originSid 老家服号（null = 无从校验归属）
 * @returns {string|null} 不可开原因；null=可开
 */
export function chestBlockReason(t, nowSec, originSid) {
  if (!t) return 'no-tile';
  // 0 = 巨兽盛宴（BWL）线的箱子，游戏分叉到 2104；-1 = 本行 m.specIndex 缺失（形态漂移，不敢猜号）
  if (t.specIndex === 0) return 'bwl-line';
  if (t.specIndex < 0) return 'no-specindex';
  if (t.leftTimes <= 0) return 'used-up';
  if (nowSec > 0 && t.expireTime > 0 && t.expireTime <= nowSec) return 'expired';
  if (originSid != null && t.initSid > 0 && t.initSid !== originSid) return 'other-server';
  return null;
}

// ── 数据源（投影优先 / push 回落，口径同 excav.js）──────────────────────
/**
 * 当前未开箱快照：优先游戏内存投影（与 icon 同源），不可用时回落自订 22077 的标量副本。
 * @returns {Array<{x:number,y:number,k:number}>|null} null=两路都没有（本轮无事可做）
 */
function currentRows() {
  var acl = gameData.cq26WlChestPos();
  if (acl) {
    aclDegradedWarned = false;
    return acl;
  }
  if (!Array.isArray(pushPos)) return null;
  if (!aclDegradedWarned) {
    aclDegradedWarned = true;
    log.warn('chest acl projection unavailable, degrade to 22077 cache.');
  }
  return pushPos;
}

/**
 * 日界滚清：以服务器秒所在日为键，换日清「当日」语义的三样（乐观已开 / 拒绝计数 / 冷却）。
 * 口径同 excav.js 的 `rolloverReject`（日界键，不靠重启动清零）。
 * @param {number} nowSec 服务器秒（>0，调用方已过时刻闸）
 */
function rolloverState(nowSec) {
  var d = todayStr(nowSec);
  if (d === rejectDay) return;
  rejectDay = d;
  rejectCount = Object.create(null);
  coolUntil = Object.create(null);
  missAt = Object.create(null);
  opened = new Set();
  localSpent = 0;
}

// ── 调度 cycle ────────────────────────────────────────────────────────
const cfg = { activeMs: 20000, chainMs: 1500, idleMs: 300000, fallback: 30000 };

/**
 * 单拍择时：开成一颗就按真人连开节奏续（串行，每拍只发一条 2118）；今日额度见底则睡到日界线 +1 分钟；
 * 其余按上一拍有无候选分档。在飞期间攒下的 push（新快照/额度/地块）是权威信号，立即补一拍。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  await cyclePass();
  if (cycle.pending) return 0;
  if (justClaimed) return cfg.chainMs;
  if (quotaZero) {
    var until = dayBoundaryMs();
    return until > 0 ? until : cfg.idleMs;
  }
  return lastHadCandidate ? cfg.activeMs : cfg.idleMs;
}

/**
 * 距「下一个日界线 + 1 分钟」的毫秒（额度每日 00:00 刷新，实录 22072 `curStageEndTime` 落在整日界）。
 * @returns {number} 不可得回 0（调用方退回 idleMs）
 */
function dayBoundaryMs() {
  var nowSec = gameData.serverTime() | 0;
  var reset = gameData.nextDailyResetTs();
  if (!nowSec || !reset) return 0;
  return Math.max(0, (reset - nowSec) * 1000 + 60000);
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.fallback,
});

// ── 核心 cyclePass ───────────────────────────────────────────────────
async function cyclePass() {
  justClaimed = false;
  quotaZero = false;
  // 1. 活动闸
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    lastHadCandidate = false;
    return;
  }
  // 2. 本服图闸（icon 判据第二项）：老家服≠当前服时游戏侧 icon 恒灭，硬发只会白撞
  var originSid = gameData.cq26OriginServerId();
  var curSid = worldMap.serverId();
  if (originSid != null && curSid > 0 && originSid !== curSid) {
    log.debug(
      'not on origin server (origin=%d cur=%d), chests hidden by icon rule.',
      originSid,
      curSid,
    );
    lastHadCandidate = false;
    return;
  }
  // 3. 额度闸（三态：null=快照未达 → 本拍不动作；0=今日开完 → 睡到日界线）
  var info = gameData.cq26WlInfo();
  if (!info) {
    if (!noSnapshotWarned) {
      noSnapshotWarned = true;
      log.debug('no 22072 snapshot yet, skip this pass (must not read as quota 0).');
    }
    lastHadCandidate = false;
    return;
  }
  // 权威快照见底才叫「今日开完」（睡到日界线）
  if (info.remainChestNum <= 0) {
    quotaZero = true;
    lastHadCandidate = false;
    log.debug('chest quota used up today (limit=%d).', info.chestDailyLimit);
    return;
  }
  // 乐观扣减见底只说明「刚发的那一条 22072 还没回」，按有候选档短等即可，绝不许睡到明天
  var spent = effectiveSpent(Date.now());
  var remain = reconcileQuota(info.remainChestNum, spent);
  if (remain <= 0) {
    lastHadCandidate = true;
    log.debug(
      'optimistic quota 0 (snap=%d spent=%d), wait next 22072.',
      info.remainChestNum,
      spent,
    );
    return;
  }
  // 4. 数据源闸
  var rows = currentRows();
  if (!rows) {
    log.debug('no chest snapshot (projection unavailable & no 22077 yet).');
    lastHadCandidate = false;
    return;
  }
  // 5. 时刻闸：过期判据离不开服务器秒（拿不到就当「无从判定」跳过整拍，与 excav 同口径）
  var nowSec = gameData.serverTime() | 0;
  if (nowSec <= 0) {
    log.debug('server time unavailable, skip this pass (expiry gate undecidable).');
    return;
  }
  // 6. 日界滚清
  rolloverState(nowSec);
  // 7. 逐点闸
  var picked = pickChests(rows, {
    tiles: tiles,
    opened: opened,
    nowSec: nowSec,
    now: Date.now(),
    coolUntil: coolUntil,
    rejectCount: rejectCount,
    originSid: originSid,
  });
  var head = picked.ready[0] || null;
  // 队头定不出号 → 一发定向 901（每拍最多一发；解出来的地块顺带覆盖同窗其它箱）
  if (!head && picked.unknown.length) {
    var target = picked.unknown[0];
    if (canProbe(target.key)) {
      var got = await probeChestTile(target);
      if (!aliveFn()) return;
      if (got) {
        picked = pickChests(rows, {
          tiles: tiles,
          opened: opened,
          nowSec: nowSec,
          now: Date.now(),
          coolUntil: coolUntil,
          rejectCount: rejectCount,
          originSid: originSid,
        });
        head = picked.ready[0] || null;
      }
    }
  }
  lastHadCandidate = !!head || picked.unknown.length > 0;
  if (!head) {
    log.debug(
      'no openable chest. snapshot=%d unknown=%d blocked=%d reasons=%s',
      rows.length,
      picked.unknown.length,
      picked.blocked.length,
      briefReasons(picked.blocked),
    );
    return;
  }
  if (!net) {
    log.warn('net unavailable, skip open. chest=%s', head.key);
    return;
  }
  // 8. 队头出网（sendGuarded 的在途闸等价游戏侧 checkRequestIdNoRes(2118)）
  await claimChest(head, remain, info.remainChestNum);
}

/**
 * 该点现在能不能发定向 901（在途单发 + 「上次这扇窗里没找到它」的冷却）。
 * @param {string} key `x_y`
 * @returns {boolean}
 */
function canProbe(key) {
  if (probeInFlight || !net) return false;
  // 901 是全网最大宗的只读请求，游戏自己的视口查询也在发它：在途就不撞第二发
  if (net.isSending && net.isSending(CMD_WORLD_INFO)) return false;
  return Date.now() - (missAt[key] || 0) >= MISS_COOL_MS;
}

/**
 * 以该箱坐标为窗心发一发 901，把应答里的 315 行并入地块缓存，回吐这一颗的地块。
 * 请求体与游戏「点 icon 跳图后客户端发的那发」逐键一致（`{x,y,k,rid,width,height,marchInfo,viewLevel}`），
 *   镜头不动；`marchInfo` 取 false（我们不消费 marchList，省一屏无用载荷；键仍在、只是值为假）。
 * @param {{key:string,x:number,y:number,k:number}} c 候选（unknown 项）
 * @returns {Promise<object|null>} 地块；没查到/被闸门挡下回 null
 */
async function probeChestTile(c) {
  probeInFlight = true;
  var r = await fetchWindow(net, c.x, c.y, {
    // 游戏同款兜底：`s: t.k || UserData.ServerId`（22077 行缺 k 时退回本服号）
    k: c.k || worldMap.serverId(),
    width: PROBE_W,
    height: PROBE_H,
    viewLevel: PROBE_VIEW_LEVEL,
    marchInfo: false,
  });
  probeInFlight = false;
  if (!r.ok) {
    // 只读请求失败/被在途闸挡下：可自愈，debug 归位即可（下一拍重试），不占拒绝计数
    log.debug('%d probe failed. chest=%s code=%s', CMD_WORLD_INFO, c.key, r.code);
    return null;
  }
  ingestChestTiles(r.points, tiles, Date.now());
  var t = tiles[c.key];
  if (!t) {
    missAt[c.key] = Date.now();
    log.debug('%d window has no chest tile. chest=%s k=%d', CMD_WORLD_INFO, c.key, c.k);
  } else {
    delete missAt[c.key];
    log.debug(
      '%d resolved chest %s → idx=%d left=%d',
      CMD_WORLD_INFO,
      c.key,
      t.specIndex,
      t.leftTimes,
    );
  }
  return t || null;
}

/**
 * 发一条 2118 并结算（每拍只调一次，串行）。
 * @param {object} c 候选（ready 项）
 * @param {number} remain 本轮出网前的乐观剩余额度（只进日志，出网前不再自查）
 * @param {number} snapAtSend 出网时读到的权威 `remainChestNum`（结算时用它判断额度推送是否已抢跑）
 * @returns {Promise<void>}
 */
async function claimChest(c, remain, snapAtSend) {
  var t0 = Date.now();
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_GET_CHEST,
    { wastelandIndex: c.idx, x: c.x, y: c.y },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  // 停用期间的应答不记账（快照已随 pause 丢弃，resume 后重读）
  if (!aliveFn()) {
    log.debug('2118 ack after pause, drop bookkeeping. chest=%s', c.key);
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn(
      '2118 not sent%s. chest=%s idx=%d',
      sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)',
      c.key,
      c.idx,
    );
    return;
  }
  if (!ret || !ret.ok) {
    noteReject(c, ret);
    return;
  }
  settleClaim(c, ret, remain, Date.now() - t0, snapAtSend);
}

/**
 * 成功结算：乐观去重 + 乐观扣额 + 面板记账。
 * 权威仍以 22077（该点从快照消失）与 22072（`remainChestNum` 递减）为准；乐观两份账都只是盖住「应答已到、推送未回」那一窗。
 * @param {object} c 候选
 * @param {object} ret Ret{ok,code,data}
 * @param {number} remain 出网前乐观剩余额度（日志用）
 * @param {number} costMs 往返耗时
 * @param {number} snapAtSend 出网时读到的权威 `remainChestNum`
 */
function settleClaim(c, ret, remain, costMs, snapAtSend) {
  opened.add(c.key);
  // 报文实证：`2118 req → 22072(remain−1) → 22077 → 2118 resp` —— 额度推送**先于应答**到达。
  //   旧写法在这里无条件 localSpent++，等于把服务器已经扣掉的那格再扣一遍 ⇒ 乐观值常挂 1，
  //   而 22072 只在额度真变化时才推 ⇒ 「等下一条 22072」永无下文 ⇒ 当天最后一颗箱永远开不掉。
  var snapNow = gameData.cq26WlInfo();
  if (needOptimisticDeduct(snapAtSend, snapNow ? snapNow.remainChestNum : null)) {
    localSpent++;
    localSpentAt = Date.now();
  }
  rejectCount[c.key] = 0;
  delete coolUntil[c.key];
  justClaimed = true;
  var d = (ret && ret.data) || {};
  var items = (d.rewardResult && d.rewardResult.items) || [];
  var got = items
    .map(function (it) {
      return item.label(it.itemId) + '×' + (Number(it.itemCount) || 0);
    })
    .join(', ');
  log.info(
    'chest opened idx=%d (%d,%d) k=%d quota=%d→%d left=%d cost=%dms → %s',
    c.idx,
    c.x,
    c.y,
    c.k,
    remain,
    Math.max(0, remain - 1),
    c.leftTimes - 1,
    costMs,
    got || 'empty reward',
  );
}

/**
 * 业务拒绝：属可预期闸门类（额度/时序竞争/目标被抢），info 级不升 warn；
 * 单次留冷却自愈，连续 MAX_REJECT 次当日拉黑该点（防逐拍重发刷屏）。
 * @param {object} c 候选
 * @param {object} ret Ret{code,data}
 */
function noteReject(c, ret) {
  var n = (rejectCount[c.key] = (rejectCount[c.key] || 0) + 1);
  coolUntil[c.key] = Date.now() + REJECT_COOL_MS;
  log.info(
    '2118 rejected. chest=%s idx=%d code=%s reason=%s streak=%d%s',
    c.key,
    c.idx,
    ret ? ret.code : 'unknown',
    rejectText(ret),
    n,
    n >= MAX_REJECT ? ' (blacklisted today)' : '',
  );
}

/**
 * blocked 原因折叠成一行 `reason×n`（debug 用，保证「为什么没动」单轨可诊断，又不逐点刷屏）。
 * @param {Array<{key:string,reason:string}>} blocked pickChests 产出
 * @returns {string}
 */
function briefReasons(blocked) {
  var m = Object.create(null);
  for (var i = 0; i < blocked.length; i++) m[blocked[i].reason] = (m[blocked[i].reason] || 0) + 1;
  return (
    Object.keys(m)
      .map(function (k) {
        return k + '×' + m[k];
      })
      .join(',') || '-'
  );
}

/**
 * 纯函数：面板进度文案（**分子是已完成**，口径同 wl-mine 的「已用 x/y」）。
 * 「剩余 x/y」会被读成「今日一颗都没开」，而它其实是「已用光」，方向刚好相反。
 * @param {number} remain 收紧后的剩余额度（reconcileQuota 之值）
 * @param {number} limit 每日上限（`chestDailyLimit`；<=0 = 配置读不到）
 * @returns {string}
 */
export function quotaText(remain, limit) {
  var l = Number(limit) || 0;
  if (l <= 0) return '—'; // 日限配置（dataConfig 52000426）读不到：没有分母就无从谈「已领几成」
  var left = Math.min(l, Math.max(0, Number(remain) || 0)); // 夹进 [0, 日限]：分子既不为负、也不冒出「已领 6/5」
  return '已领 ' + (l - left) + '/' + l;
}

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 面板 defaults（唯一交互项是开关：串行连开/不跳图是行为纪律，不做勾选）。
 * @returns {object}
 */
function buildDefaults() {
  return { enabled: false };
}

/**
 * 面板 fields：单行内联状态（组卡片 inlineStatus 取第一个 type:'text' 的 get() 结果）。
 * 口径与同家族 wl-mine 的「已用 x/y」一致：**分子是已完成**，见 quotaText。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_chestInfo',
      type: 'text',
      label: '额度',
      get: function () {
        if (!gameData.cq26IsOpen()) return '—';
        var info = gameData.cq26WlInfo();
        if (!info) return '—';
        var spent = quotaDebt(Date.now());
        return quotaText(reconcileQuota(info.remainChestNum, spent), info.chestDailyLimit);
      },
    },
  ];
}

// ── 注册 ──────────────────────────────────────────────────────────────
/**
 * toModuleCfg：面板 cfg → 运行时配置。
 * 本玩法刻意**无可调参数**（串行连开 / 不跳图 / 不扫图是行为纪律，不做勾选），只吐 `enabled`；
 *   但声明本身是硬性契约：`core/registry.js` 的 applyFeature 对**每个** reactor 功能无条件调
 *   `f.toModuleCfg(cfg)`（全仓 46 个 register 全部声明），缺声明会在面板翻开关时抛
 *   `TypeError: f.toModuleCfg is not a function`，且抛在 DOM change 回调里不经 createLog ⇒ 日志流零痕迹。
 * @param {object} c 面板合并后配置
 * @returns {{enabled:boolean}} 运行时配置（历史残留键不透传）
 */
function normalizeCfg(c) {
  return { enabled: !!(c && c.enabled) };
}

reactor.register({
  id: 'cq26WlChest',
  label: '遗失之箱',
  storageKey: 'pocketcc.feat.cq26_wl_chest',
  // cq26WasteLand 为软依赖（探针注册的 cap，见 core/acl-engine.js）：拿不到时降级为
  //   「只信自订 22077/10018 的标量副本」，不阻断安装（同 excav 的 cq26NeutralCtrl? 口径）
  symbols: ['dataCenter', 'cq26WasteLand?'],
  // 与 cq26 家族同口径：靠房间号 k 跨图定向发包，不依赖人真站在冰原里。服务器是否校验「视野/房间归属」
  //   未实证（零拒绝样本），首跑若出现稳定 code≠0 即回灌 ACL §3.1 并把本 feat 收紧到「须在冰原图内」。
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 开箱不派兵、不占行军名额（328 是纯表演行军，实测 11s 连开 5 箱），战斗态无需下线
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  run: run,
  pause: pause,
});
