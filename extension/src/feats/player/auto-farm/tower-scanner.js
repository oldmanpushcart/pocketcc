/**
 * 机械田扫描器（tower-scanner）—— 联盟「记录-建筑」的机械田发现与存活/容量校验
 *
 * 数据源（报文实证，不新增协议）：
 *   ① 一次性全量 ALLIANCE_RECORD_DATA(1193)：{ret:[{specId,params[],sendTime,id}]}，把
 *      「建造 N级<设施>完毕」记录解析成 {x,y,family,level,ts(≈建成时刻 btime)} 灌进活表；
 *      设施名→家族：采金=金7 / 炼油=油1 / 谷仓=粮5 / 提纯=雷神16（与 MAP_BUILDING bid 家族一致），
 *      坐标取渲染文本末个 "(x,y)"（记录里没有塔 id，塔 id 只能靠定点 901 拿 b.id）。
 *   ② 增量 push PUSH_ALLIANCE_RECORD(10452)：新建成塔即时并入（不唤醒派兵，由 feat 决定是否 kick）。
 *
 * 活表维护三件套（缺一必坍缩为空，真机踩过）：
 *   全量重拉（MECH_REFRESH_MS=20min 节流，自愈漏推）+ 增量推送（即时补新）+ 老化剔除（ts 超 10h，
 *   实证塔存活 <10h）。此外整表落 storage.slot('autoFarm.tower')：页面刷新先用盘上数据选点，
 *   不必等 1193 回来；扫描时刻 scannedAt 一并落盘，跨会话也能判断"该重扫了"。
 *
 * 下田前信息获取（本模块的 verify 闭环）：
 *   901 定点确认该点仍是「本盟已建成、家族匹配」的资源塔（pointType24 & b.st=3 & b.aid=本盟 & bid 家族），
 *   再用 1034 GET_TOWERINFO{id} 取 army_size，配 MAP_BUILDING[bid].force_capacity 判满
 *   （army_size >= force_capacity 即已采满、与游戏 NWorldTowerPopup 同口径）→ 满塔跳过换下一候选（不拉黑）。
 *   剩余存活时间 = ts + MAP_BUILDING[bid].duration − serverTime（零额外发包，901 没有 btime）。
 *
 * 机械田有两级（本模块只存两级、不排优先级，排序口径在 priority.js）：
 *   设施级 level（联盟记录「建造 N 级设施完毕」，也等于 bid%1000）
 *   矿脉级 ore（1034 应答 ext.itemId → RESOURCE 行 .level；未探到回 0）。
 *   生产速度 = gather_coefficient[设施级] × gather_speed[矿脉级]（逆向 NWorldTowerPopup.initSpeed 逐字如此），
 *   所以两个都是产量真相；一次 1034 同时拿 army_size 与 ext.itemId，零额外发包地回填 ore。
 *   ❗塔家族（采哪种资源）与矿脉家族本来就不同源（实证一座采金塔 51006 落在 106 号田上），
 *   所以本模块的 family 永远指塔族，ore 只取等级、绝不拿矿脉的 id 前缀当家族。
 */
import { gameData, l10n, worldMap } from '../../../core/game-api.js';
import { resourceMeta } from '../../../core/resource.js';
import { parseData } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { storage } from '../../../core/storage.js';
import { map } from '../../../core/map.js';

import { CMD_ALLIANCE_RECORD_DATA, CMD_GET_TOWERINFO, PUSH_ALLIANCE_RECORD } from './constants.js';

/** @type {ReturnType<typeof createLog>} 模块日志器（tag=AUTO-FARM） */
const log = createLog('AUTO-FARM');

/** @type {number} 实体类型：资源塔（NWorldMapEntityType.ResourceTower = 901 pointType = 24） */
const POINT_TYPE_TOWER = 24;
/** @type {number} TowerState.COMPLETE：塔建造完成、可采集 */
const TOWER_STATE_COMPLETE = 3;
/** @type {number} 机械田记录/活表最大年龄（秒）：实证塔存活 <10h，超期视为已毁不再下田 */
const MECH_MAX_AGE_SEC = 10 * 3600;
/** @type {number} 剩余存活不足此值（秒）的塔直接剔除，免得往返路上就到期 */
const MECH_MIN_REMAIN_SEC = 10 * 60;
/** @type {number} 单轮存在性探针上限（候选过多时限流，超出的下轮再试） */
const MECH_PROBE_CAP = 6;
/**
 * @type {number} 全量重拉最小间隔（毫秒，漏推自愈）：活表靠 10452 增量维持，而推送可能整批漏达
 * （MV3 休眠/网络抖动/切场景），条目又被 10h 老化——长时间挂机后只减不增会清空。
 */
const MECH_REFRESH_MS = 20 * 60 * 1000;
/** @type {number} 全量拉取失败后的重试间隔（毫秒） */
const MECH_RETRY_MS = 60 * 1000;
/** @type {string} 机械田活表独立存储键（storage.slot 下、UID 前缀隔离） */
const TOWER_STORE_KEY = 'autoFarm.tower';
/** @type {number} 机械田活表存储结构版本：不符整份丢弃（字段口径变更时作废旧档） */
const TOWER_STORE_VER = 1;
/**
 * 塔家族（floor(bid/1000)）→ 资源家族编码反查表（51 金塔 / 52 油塔 / 53 粮塔 / 71 雷神塔）。
 * @type {Object<number,number>}
 */
const RES_FAMILY_BY_TOWER = { 51: 7, 52: 1, 53: 5, 71: 16 };
/**
 * 联盟记录文本里的设施名 → 资源家族编码（与 RES_FAMILY_BY_TOWER 的 bid 家族口径一致）。
 * @type {Object<string,number>}
 */
const FACILITY_FAMILY = { 采金: 7, 炼油: 1, 谷仓: 5, 提纯: 16 };
/**
 * 资源家族编码 → 塔 bid 前缀（RES_FAMILY_BY_TOWER 反向），用于由 (family,level) 反推 bid 查 MAP_BUILDING。
 * @type {Object<number,number>}
 */
const TOWER_PREFIX_BY_FAMILY = { 7: 51, 1: 52, 5: 53, 16: 71 };

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {function():boolean} 运行态闸门 */
var aliveFn = function () {
  return false;
};

/**
 * 机械田活表：坐标键 "x,y" → {x,y,family,level,ts(建成时刻·服务器秒),seenAt(并入时刻·墙上毫秒)}。
 * @type {Map<string, {x:number,y:number,family:number,level:number,ts:number,seenAt:number}>}
 */
var live = new Map();
/** @type {boolean} 是否已成功拉过一次 1193（未拉前 pick 会先 await 全量，避免首轮降级） */
var loaded = false;
/** @type {Promise<boolean>|null} 1193 全量在飞 promise（单飞去重：并发 await 者共享同一等待，防「空返回」竞态） */
var inFlight = null;
/** @type {number} 上次 1193 成功落地的墙上时刻（毫秒），0=从未 */
var loadedAt = 0;
/** @type {boolean} 活表是否已从盘回填（读盘只做一次） */
var diskLoaded = false;
/** @type {boolean} 活表有变更未落盘 */
var dirty = false;
/** @type {Object<string, number>} bid → 塔存活时长秒缓存（MAP_BUILDING.duration；查不到存 0） */
var lifeCache = {};
/** @type {Object<string, number>} bid → 塔驻军容量上限缓存（MAP_BUILDING.force_capacity；查不到存 0） */
var capCache = {};
/**
 * 本拍被「自己行军已占用」挡掉的机械田坐标键（score 累计、调用方每拍 drain 后汇总一行，免逐点刷屏）。
 * @type {Set<string>}
 */
var occupiedSkipped = new Set();

/**
 * 复刻联盟记录文本渲染（AllianceRecordController.dealOneObj 口径）：按 specId 查 alliance_information
 * 表拿模板 .text，params 里含 RS(0x1e) 的子参数各自 getText(d[1])，再交给 l10n.text 拼成最终中文串。
 * @param {object} e 记录对象 {specId, params[]}
 * @returns {string} 渲染后的记录文本（失败回空串）
 */
function renderRecordMsg(e) {
  var o = l10n.tableRow('alliance_information', e.specId);
  if (!o || !o.text) return '';
  var raw = Array.isArray(e.params) ? e.params : [];
  var RS = String.fromCharCode(30);
  var args = [];
  for (var i = 0; i < raw.length; i++) {
    var p = String(raw[i] == null ? '' : raw[i]);
    var d = p.indexOf(RS) >= 0 ? p.split(RS) : null;
    args.push(d && d.length > 1 ? l10n.text(d[1]) : p);
  }
  try {
    return String(l10n.text.apply(null, [o.text].concat(args)) || '');
  } catch (err) {
    return '';
  }
}

/**
 * 单条联盟记录 → 机械田活表条目：只收「建造 N级<设施>完毕」且 sendTime 在 10h 内的记录。
 * @param {object} e 记录对象 {specId, params[], sendTime(秒)}
 * @returns {boolean} 是否并入了一条机械田
 */
function ingestRecord(e) {
  if (!e || e.specId == null) return false;
  var ts = Number(e.sendTime) || 0;
  if (ts > 1e11) ts = Math.floor(ts / 1000); // ms→s 兜底
  var now = gameData.serverTime();
  if (!ts || (now && now - ts > MECH_MAX_AGE_SEC)) return false;
  var msg = renderRecordMsg(e);
  if (!msg || msg.indexOf('建造') < 0 || msg.indexOf('完毕') < 0) return false;
  var fm = msg.match(/(\d+)\s*级\s*(采金|炼油|谷仓|提纯)\s*设施/);
  if (!fm) return false;
  var family = FACILITY_FAMILY[fm[2]];
  if (!family) return false;
  var level = Number(fm[1]) || 0;
  var cm = msg.match(/\((\d+)\s*[，,]\s*(\d+)\)/g);
  if (!cm || !cm.length) return false;
  var last = cm[cm.length - 1].match(/(\d+)\s*[，,]\s*(\d+)/);
  var x = Number(last[1]) || 0;
  var y = Number(last[2]) || 0;
  if (!x && !y) return false;
  live.set(x + ',' + y, {
    x: x,
    y: y,
    family: family,
    level: level,
    ore: 0, // 矿脉级靠 1034 ext.itemId 回填（记录文本里没有），0 = 未知
    ts: ts,
    seenAt: Date.now(),
  });
  dirty = true;
  return true;
}

/**
 * 全量拉联盟记录（1193）→ 解析合并进活表（叠加式，不清空）。单飞；永不 reject。
 * @returns {Promise<boolean>} 是否成功落地
 */
function pull() {
  if (inFlight) return inFlight; // 在飞：返回同一 promise，await 者真正等到落地而非空返回
  inFlight = net
    .send(CMD_ALLIANCE_RECORD_DATA, {})
    .then(function (ret) {
      inFlight = null;
      if (!ret || !ret.ok) return false;
      var d = parseData(ret.data) || {};
      var arr = Array.isArray(d.ret) ? d.ret : Array.isArray(d.list) ? d.list : null;
      if (!arr) return false;
      var added = 0;
      for (var i = 0; i < arr.length; i++) {
        try {
          if (ingestRecord(arr[i])) added++;
        } catch (err) {}
      }
      loaded = true;
      loadedAt = Date.now();
      dirty = true;
      log.info('tower scan(1193). hits=%d live=%d', added, live.size);
      return true;
    })
    .catch(function (err) {
      inFlight = null;
      log.warn('1193 load failed, retry later. %s', err && err.message);
      return false;
    });
  return inFlight;
}

/**
 * 按需刷新：从未成功拉过或距上次超过 MECH_REFRESH_MS 才打 1193（单飞复用）。
 * @returns {Promise<boolean>} 刷新后活表是否可用
 */
function refreshIfDue() {
  if (loaded && Date.now() - loadedAt < MECH_REFRESH_MS) return Promise.resolve(true);
  if (!net) return Promise.resolve(loaded);
  return pull();
}

/** 老化剔除：ts 超 MECH_MAX_AGE_SEC 的条目（塔存活 <10h，超期视为已毁）。 */
function prune() {
  var now = gameData.serverTime();
  if (!now) return;
  live.forEach(function (c, key) {
    if (now - (c.ts || 0) > MECH_MAX_AGE_SEC) {
      live.delete(key);
      dirty = true;
    }
  });
}

/**
 * 活表落盘（fire-and-forget）：{v, scannedAt, list}。失败记 warn（内存活表仍是本轮真相）。
 */
function persist() {
  dirty = false;
  var arr = [];
  live.forEach(function (c) {
    arr.push(c);
  });
  Promise.resolve(
    storage.slot.set(TOWER_STORE_KEY, { v: TOWER_STORE_VER, scannedAt: loadedAt, list: arr }),
  ).catch(function (err) {
    log.warn('persist tower store failed. %s', err && err.message);
  });
}

/**
 * 从盘回填活表（run 时一次）：版本不符整份丢弃；回填后 scannedAt 作为下次"该重扫了"的基准。
 * @returns {Promise<void>}
 */
function load() {
  if (diskLoaded) return Promise.resolve();
  diskLoaded = true;
  return Promise.resolve(storage.slot.get(TOWER_STORE_KEY))
    .then(function (saved) {
      if (!saved || typeof saved !== 'object' || saved.v !== TOWER_STORE_VER) return;
      if (Array.isArray(saved.list)) {
        for (var i = 0; i < saved.list.length; i++) {
          var c = saved.list[i];
          if (!c || c.x == null || c.y == null) continue;
          live.set((c.x | 0) + ',' + (c.y | 0), {
            x: c.x | 0,
            y: c.y | 0,
            family: c.family | 0,
            level: c.level | 0,
            ore: c.ore | 0, // 旧档无此字段回 0（未探到矿脉级），不拆旧档：塔信息重建要等 1193，拆了会整晚无候选
            ts: Number(c.ts) || 0,
            seenAt: Number(c.seenAt) || 0,
          });
        }
      }
      loadedAt = Number(saved.scannedAt) || 0;
      prune();
      log.info('tower store restored from disk. live=%d scannedAt=%s', live.size, loadedAt || '-');
    })
    .catch(function (err) {
      log.warn('load tower store failed. %s', err && err.message);
    });
}

/** @returns {number} 距下次全量重扫的毫秒数（cycle 择时用；失败退 60s 重试） */
async function scanPass() {
  prune();
  var ok = await refreshIfDue();
  if (!aliveFn()) return MECH_REFRESH_MS;
  if (dirty) persist();
  return ok ? MECH_REFRESH_MS : MECH_RETRY_MS;
}

/**
 * 10452 增量推送处理：新建成机械田即时并入活表（容错外层结构：数组 / d.ret / 单条）。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 * @returns {boolean} 是否并入过至少一条（供调用方决定是否唤醒派兵）
 */
function onRecordPush(ev) {
  var d = ev && ev.data;
  if (!d) return false;
  var arr = Array.isArray(d) ? d : Array.isArray(d.ret) ? d.ret : [d];
  var hit = false;
  for (var i = 0; i < arr.length; i++) {
    try {
      if (ingestRecord(arr[i])) hit = true;
    } catch (err) {}
  }
  if (hit) persist();
  return hit;
}

/**
 * (家族,等级) → 塔 bid：前缀·1000 + 等级（实证 71003=雷神 3 级、52006=油 6 级）。
 * @param {number} family 资源家族编码
 * @param {number} level 塔等级
 * @returns {number}
 */
function bidFor(family, level) {
  var pre = TOWER_PREFIX_BY_FAMILY[family];
  return pre ? pre * 1000 + (level | 0) : 0;
}

/**
 * 资源塔存活时长（秒）：MAP_BUILDING[bid].duration（NWorldTowerPopup 的 leftTime 同源字段）。
 * @param {number} family 资源家族编码
 * @param {number} level 塔等级
 * @returns {number} 秒；表未就绪/字段缺失回 0
 */
function lifespanSec(family, level) {
  var bid = bidFor(family, level);
  if (!bid) return 0;
  if (lifeCache[bid] != null) return lifeCache[bid];
  var r = l10n.tableRow('MAP_BUILDING', bid);
  var life = r ? Number(r.duration) || 0 : 0;
  lifeCache[bid] = life;
  return life;
}

/**
 * 资源塔驻军容量上限（force_capacity）：满判据 = force_capacity − army_size ≤ 0。
 * @param {number} bid 塔 bid（901 的 b.bid）
 * @returns {number}
 */
function forceCapacity(bid) {
  if (!bid) return 0;
  if (capCache[bid] != null) return capCache[bid];
  var r = l10n.tableRow('MAP_BUILDING', bid);
  var cap = r ? Number(r.force_capacity) || 0 : 0;
  capCache[bid] = cap;
  return cap;
}

/**
 * 定点 901 存在性探针：查 (x,y) 是否仍是「本盟已建成、家族匹配」的资源塔。
 * 永不 reject。@returns {Promise<{status:'ok'|'gone'|'error', id?:string, bid?:number}>}
 */
function probeTower(x, y, wantFamily) {
  return map
    .fetchWindow(net, x, y, { k: worldMap.serverId() })
    .then(function (r) {
      if (!r.ok) return { status: 'error' };
      var list = r.points;
      var myAid = gameData.myAid();
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || (p.x | 0) !== x || (p.y | 0) !== y) continue;
        if ((p.pointType | 0) !== POINT_TYPE_TOWER) return { status: 'gone' };
        var b = p.b || {};
        if ((Number(b.st) || 0) !== TOWER_STATE_COMPLETE) return { status: 'gone' };
        if (myAid && Number(b.aid) !== myAid) return { status: 'gone' };
        if (
          wantFamily &&
          RES_FAMILY_BY_TOWER[Math.floor((Number(b.bid) || 0) / 1000)] !== wantFamily
        )
          return { status: 'gone' };
        return { status: 'ok', id: b.id != null ? String(b.id) : null, bid: Number(b.bid) || 0 };
      }
      return { status: 'gone' };
    })
    .catch(function () {
      return { status: 'error' };
    });
}

/**
 * 资源塔详情（1034）：一次请求拿两个真相 —— 当前驻军兵力 army_size 与底下矿脉的 itemId（应答 ext.itemId）。
 * id 取 901 的 b.id 字符串（Int64 不截断）。
 * @param {string} id 塔 id（字符串）
 * @returns {Promise<{army:number, itemId:number}>} army 失败/无字段回 -1（「未知不拦」，由 902 结果兜底）；itemId 查不到回 0
 */
function towerInfo(id) {
  if (!id) return Promise.resolve({ army: -1, itemId: 0 });
  return net
    .send(CMD_GET_TOWERINFO, { id: id })
    .then(function (ret) {
      if (!ret || !ret.ok) return { army: -1, itemId: 0 };
      var d = parseData(ret.data) || {};
      var n = Number(d.army_size);
      var ext = d.ext || d.extData || {}; // 报文实证是 ext；extData 为竞对口径兼容
      return { army: isFinite(n) ? n : -1, itemId: Number(ext.itemId) || 0 };
    })
    .catch(function () {
      return { army: -1, itemId: 0 };
    });
}

/**
 * 同族内低位值（矿脉级×10 + 设施级）：上游把从 curRank 反推的低位下限直接拿来比（种类与家族在同一 fam 下是常量）。
 * 矿脉级未探到时用设施级兜底（实证规律 设施级 ≤ 矿脉级 → 保守低估，宁可少换不误换）。
 * @param {object} c 活表条目
 * @returns {number}
 */
function lowValue(c) {
  var fac = c.level | 0;
  return (c.ore | 0 || fac) * 10 + fac;
}

/**
 * 候选打分（本地、零发包）：按 (矿脉级, 设施级) 字典序降序；**剩余存活不参与排序**（用户定稿），
 * 只在完全同档时当 tiebreak（同 O 同 T 选剩得多的，免把行军浪费在快到期塔上），且仍剔除「快结束」的塔。
 * @param {number} family 资源家族编码
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {function(string):boolean} isBlocked 坐标黑名单判定
 * @returns {Array<{c:object, remain:number, hasLife:boolean, low:number}>}
 */
function score(family, taken, isBlocked) {
  var now = gameData.serverTime();
  var out = [];
  live.forEach(function (c) {
    if (c.family !== family) return;
    var key = c.x + ',' + c.y;
    if (isBlocked && isBlocked(key)) return;
    if (taken && taken.has(key)) {
      // 逐点打日志会被「规则行 × 候选塔」乘性放大（真机 3 行 × 3 塔 = 9 行同文刷屏），只累计、由调用方每拍汇总一行
      occupiedSkipped.add(key);
      return;
    }
    var life = lifespanSec(c.family, c.level);
    var hasLife = life > 0 && !!now;
    out.push({
      c: c,
      low: lowValue(c),
      remain: hasLife ? c.ts + life - now : c.ts || 0,
      hasLife: hasLife,
    });
  });
  if (
    out.length &&
    out.every(function (s) {
      return s.hasLife;
    })
  ) {
    out = out.filter(function (s) {
      return s.remain >= MECH_MIN_REMAIN_SEC;
    });
  }
  out.sort(function (a, b) {
    return b.low - a.low || b.remain - a.remain;
  });
  return out;
}

/**
 * 升级/选族用的廉价窥视：返回该家族当前可下（未拉黑/未占用/未快结束）低位最优条目的两维等级。
 * 只读活表、不发任何请求；实际取田由 pick(…, aboveLow) 的同口径下限保证。
 * @param {number} family 资源家族编码
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {function(string):boolean} isBlocked 坐标黑名单判定
 * @returns {{level:number, facility:number}|null} 矿脉级/设施级（矿脉级未探到时已兜底为设施级）；无候选回 null
 */
function peek(family, taken, isBlocked) {
  var list = score(family, taken, isBlocked);
  if (!list.length) return null;
  var best = list[0].c; // score 已按 low 降序，首条即该族天花板
  return { level: best.ore | 0 || best.level | 0, facility: best.level | 0 };
}

/**
 * 取一个可下的机械田：本地按 (矿脉级,设施级) 打分排序 → 逐个定点 901 确认仍在 → 1034 过容量闸并顺手回填矿脉级。
 * 探到已毁即移出活表并拉黑、换下一候选；满塔跳过不拉黑（可能有队返采腾出空间）。
 *
 * aboveLow（升级抢田专用）：只返「同族低位值 矿脉级×10+设施级 严格高于 aboveLow」的塔，且这类候选**不消耗 901 额度**。
 * 必须与 peek 的口径同源（两者都走 lowValue）：若 peek 放行而 pick 拿回一栋低位并不更高的塔，就白跑一轮 901+1034。
 * 该下限由 priority.lowFloorOf 从 curRank 反推（已扣掉种类与家族权重），跨种类/跨到更高优先家族时自然归 0。
 * @param {number} family 资源家族编码
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @param {function(string):boolean} isBlocked 坐标黑名单判定
 * @param {number} [aboveLow] 低位下限（严格大于；0/缺省 = 不限：缺位派兵与跨种类升级都走这条）
 * @returns {Promise<{x:number,y:number,level:number,facility:number,family:number}|null>} level=矿脉级（未探到时为设施级兜底）
 */
async function pick(family, taken, isBlocked, aboveLow) {
  await refreshIfDue();
  if (!aliveFn()) return null;
  var scored = score(family, taken, isBlocked);
  var above = aboveLow | 0;
  var probed = 0;
  for (var i = 0; i < scored.length; i++) {
    var c = scored[i].c;
    if (above && lowValue(c) <= above) continue; // 低位不够就不必发探针（也不计额度）
    if (probed >= MECH_PROBE_CAP) break;
    probed++;
    var key = c.x + ',' + c.y;
    var pr = await probeTower(c.x, c.y, family);
    if (!aliveFn()) return null;
    if (pr.status === 'error') return null;
    if (pr.status === 'gone') {
      live.delete(key);
      dirty = true;
      continue;
    }
    var cap = forceCapacity(pr.bid);
    // 1034 该发的两种理由：要判满（cap 可查），或本塔还没探到过矿脉级（cap 查不到也得取一次，取到就长期免探）
    if (pr.id && (cap > 0 || !(c.ore | 0))) {
      var info = await towerInfo(pr.id);
      if (!aliveFn()) return null;
      if (cap > 0 && info.army >= 0 && info.army >= cap) {
        log.debug('tower full, skip. x=%d y=%d army=%d cap=%d', c.x, c.y, info.army, cap);
        continue;
      }
      if (info.itemId) {
        var meta = resourceMeta(info.itemId);
        if (meta && meta.level) {
          c.ore = meta.level | 0; // 矿脉级回填活表（一塔只需 1034 一次）：peek/pick 下拍就能按真实两维排
          dirty = true;
        }
      }
    }
    if (dirty) persist(); // 前面剔过已毁条目或回填过矿脉级：命中前先落盘，免刷新页把旧快照读回来
    return {
      x: c.x,
      y: c.y,
      level: c.ore | 0 || c.level | 0,
      facility: c.level | 0,
      family: c.family,
    };
  }
  if (dirty) persist();
  return null;
}

/** @param {string} key "x,y" @returns {object|undefined} 活表条目 */
function entryAt(key) {
  return live.get(key);
}

/** @param {string} key "x,y" @returns {boolean} 该坐标是否在活表（用于判断在途田是否为机械田） */
function has(key) {
  return live.has(key);
}

/** @returns {number} 活表规模（诊断用） */
function size() {
  return live.size;
}

/** @returns {number} 上次全量扫描的墙上毫秒（0=从未） */
function scannedAt() {
  return loadedAt;
}

/**
 * 安装：绑定网络底座与运行态闸门。
 * @param {{net:object, alive:function():boolean}} o
 */
function install(o) {
  net = o.net;
  aliveFn = o.alive;
}

/** run 复位：清空内存活表与全部闸门（盘上数据由 load() 重新回填） */
function reset() {
  live = new Map();
  loaded = false;
  inFlight = null;
  loadedAt = 0;
  diskLoaded = false;
  dirty = false;
  lifeCache = {};
  capCache = {};
  occupiedSkipped.clear();
}

/**
 * 取走并清空「本拍被自己行军占用挡掉的机械田坐标」累计（Set 天然按坐标去重，多行扫同一份活表只算一次）。
 * @returns {string[]} 坐标键数组（'x,y'）
 */
function drainOccupiedSkipped() {
  var keys = Array.from(occupiedSkipped);
  occupiedSkipped.clear();
  return keys;
}

/** 机械田扫描器单例 */
export const tower = {
  CMD_PUSH_RECORD: PUSH_ALLIANCE_RECORD,
  MECH_REFRESH_MS,
  drainOccupiedSkipped,
  install,
  reset,
  load,
  persist,
  prune,
  scanPass,
  refreshIfDue,
  onRecordPush,
  pick,
  peek,
  entryAt,
  has,
  size,
  scannedAt,
};
