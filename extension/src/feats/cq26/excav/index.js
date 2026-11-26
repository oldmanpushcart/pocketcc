/**
 * CQ26 印石·战区宝藏自动发掘（cq26Excav）
 *
 * 玩法：CQ26 期间各战区（含外服）中立 3 级城随机开「宝藏点」（地图实体 311，存在 7200s）。
 * 玩家在世界地图点地块 → 面板「开采」→ 一条**不占行军名额**的幽灵行军（marchType 332，10s 后到账），
 * 奖励直接进背包，每个点全场限采一次（采后面板按钮本地置灰，无需撞错误码）。
 * 本 feat 只做一件事：与玩家看到的世界地图宝藏 icon 严格同源，有可采点就发一条 2491。
 *
 * 协议清单（报文实证两趟印石-我的日常实录）：
 *   2491 SERIES_FROST_EXCAV_CLAIM  req {siteId:"{cityCfgId}_{openTs}"}（实测只有这一个键）
 *                                  resp {reward:{rewardId,items:[{itemId,itemCount}]},marchEndTime:=header.ts+10s}
 *   22062 push EXCAV_OPEN_LIST      {list:[{siteId,cityId,ownerSid,endTime,pos:{x,y,k}}]}；开启瞬间即推
 *                                  （实测两次推送时刻精确==openTs），**全量快照、不按已采过滤** → 候选须自己减 claimed
 *   22063 push EXCAV_SELF           {claimedSiteIds:[…]}；服务端持久（刷新页面后仍含 33min 前采的点）
 *   22061 push EXCAV_OWNED_LIST     {list:[…带 totalRemainCount]}；全部录制零出现，**登记不接线**
 *   2490 EXCAV_OPEN / 2492 EXCAV_RECORD_LIST；客户端零调用（NRequestIdV2 里有号但无调用点），**登记不接线**
 *
 * 判据（与游戏严格同源，不扫图、不加请求频次）：
 *   世界地图宝藏 icon 显隐 = NWorldUIActBtnSetting.checkCQ26NeutralExcavShow
 *     = CQ26NeutralController.getFirstOpenEnableSite() != null，纯客户端推导、零报文。该方法选择规则（逐行对齐）：
 *     ① 跳过 _claimedSiteIds 命中的点；② 命中本服（ownerSid==_selfInfo.mSid）的第一个即返回（A 档：开启战区）；
 *     ③ 否则取 endTime 最小者（B 档：其他战区）。本 feat 经 ACL 投影 gameData.cq26ExcavSites() 复刻同规则。
 *   为什么不靠 push 单打：实录实证 net-collect 的 hook 晚于游戏登录握手（两场冷启动首包都是
 *     7428/7415/9706… 一串登录后初始化报文，且另一场实录全程无 22062 却照常点得开面板、采得到点），
 *     说明**22062 全量快照在登录握手期送达、录制看不见**。实时性靠 ctx.on.push(22062/22063)（与游戏同源：
 *     core/net.js 先 recvOrig 跑完游戏 handler 再 dispatch 给我们，不存在脏读）；握手期那一次漏收则靠
 *     每拍读一次内存投影自愈 —— 无需主动请求，也就无需拉全图报文。
 *   投影取器只缓存**类**、单例每次现取（gameData._cq26Neutral）：ResetGame.purgeData() 会 purge 掉本控制器单例，
 *   缓存实例会让投影永远停在一个僵尸对象上（非 null 的陈旧数组会结构性屏蔽 22062 回落通道）。
 *
 * 闸门（按序）：活动闸 cq26IsOpen → 数据源可用闸 → 时刻闸（serverTime 不可得整拍跳过）→ 日界滚清（拉黑计数只属当日）
 *   → pickOpen 内逐点过：去重闸（本地乐观 Set ∪ 游戏侧 claimed 标志）→ 过期闸（remain <= SAFE_REMAIN_SEC 跳过）
 *   → 冷却闸 → 拉黑闸（达 MAX_REJECT）→ sendGuarded 在途串行闸（等价游戏侧 checkRequestIdNoRes(2491)）。
 *
 * 刻意不做：不嗅探 901/10018 里的 311 地块（要拉全图报文，打扰服务器且不及时）；不发 2490/2492；
 *   不派兵、不校验行军名额（332 为幽灵行军，实测 4 次 856 行军列表零命中 332，不占名额）。
 */
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { gameData } from '../../../core/game-api.js';
import { item } from '../../../core/item.js';
import { createCycle } from '../../../core/cycle.js';
import { CODE_NOT_SENT, rejectText, todayStr } from '../../../core/util.js';

import { CMD_CLAIM, PUSH_OPEN_LIST, PUSH_SELF } from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-EXCAV');

/** 剩余存在时间低于此秒数不再发掘（发了也是白撞） */
const SAFE_REMAIN_SEC = 30;
/** 同一 siteId 连续被拒达此次数即**当日**拉黑（防逐拍重发刷屏；日界滚清见 rolloverReject） */
const MAX_REJECT = 3;
/** 单次被拒后的冷却毫秒（时序竞争类拒绝留自愈窗口，不直接拉黑） */
const REJECT_COOL_MS = 5 * 60 * 1000;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入） */
var MCFG = buildDefaults();
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {Array<object>|null} 22062 投影后的全量点（ACL 投影不可用时的回落数据源；存标量副本而非报文对象） */
var pushList = null;
/** @type {Set<string>} 已采乐观集（2491 成功后即加，22063 到达后整体覆盖为权威值） */
var claimed = new Set();
/** @type {Object<string,number>} siteId → 连续被拒次数 */
var rejectCount = {};
/** @type {Object<string,number>} siteId → 冷却到期时刻（Date.now() 基准） */
var coolUntil = {};
/** @type {string} rejectCount/coolUntil 所属服务器日（换日清空，使「当日拉黑」真止于当日） */
var rejectDay = '';
/** @type {boolean} 「服务器时刻不可得」warn 去重（时刻恢复后复位，不每拍刷一条） */
var serverTimeWarned = false;
/** @type {boolean} 本轮是否完成了一次发掘（决定下一拍用 chainMs 续采还是降频） */
var justClaimed = false;
/** @type {boolean} 上一拍是否存在可采候选（决定无动作时的降频档位） */
var lastHadCandidate = false;
/** @type {boolean} 「投影不可用、降级用 22062 缓存」的 warn 去重（恢复后复位） */
var aclDegradedWarned = false;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：取网络底座（游戏内存投影与 push 都不需要额外 install）。
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
 * 配置灌入（reactor → 本模块）。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (!partial) return MCFG;
  MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：订阅两路推送 + 点火（退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  // 刻意**不**在此清 rejectCount/coolUntil：places/kinds 门控会反复 pause→run（base/world 来回跳、进出 homeland），
  //   清零等于给一个服务器侧永久拒绝的点无限续命逐拍重撞；「当日拉黑」必须跨 activate 成立，日界由 rolloverReject 收。
  ctx.on.push(PUSH_OPEN_LIST, onOpenListPush);
  ctx.on.push(PUSH_SELF, onSelfPush);
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉缓存快照，避免 resume 后拿陈旧列表发写请求。
 * cycle 的自重排由 alive() 自守，push 退订由 reactor 托管，本处无自建定时器。
 */
function pause() {
  pushList = null;
}

// ── 存活判定 ──────────────────────────────────────────────────────────
function aliveFn() {
  return reactor.isRunning('cq26Excav');
}

// ── 推送入口 ──────────────────────────────────────────────────────────
/**
 * 取业务体：net 已剥 pbAckV2 信封，ev.data 即内层业务体（与 Ret 同口径）；此处仅做对象形态守卫。
 * @param {object} ev 推送事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o;
}

/** 22062：全量开启点快照（含已采点，故只当数据源，不当判据） */
function onOpenListPush(ev) {
  var b = pushBody(ev);
  var list = b && b.list;
  if (!Array.isArray(list)) {
    log.warn('22062 malformed (no list array).');
    return;
  }
  // 报文对象被池复用（Event.raw 只读），必须**同帧**拆成标量副本再存活到下一拍，
  //   否则降级路径读到的是被下一条报文刷过的脏值（与 train.js cloneInt64 / readSnapshot 同一口径）。
  pushList = list.map(projectSite);
  log.debug('22062 received. sites=%d', list.length);
  if (aliveFn()) cycle.kick();
}

/** 22063：已采集合（服务端权威，整表覆盖本地乐观集） */
function onSelfPush(ev) {
  var b = pushBody(ev);
  var ids = b && b.claimedSiteIds;
  if (!Array.isArray(ids)) {
    log.warn('22063 malformed (no claimedSiteIds array).');
    return;
  }
  claimed = new Set(ids.map(String));
  log.debug('22063 received. claimed=%d', ids.length);
  if (aliveFn()) cycle.kick();
}

// ── 数据源与候选序 ────────────────────────────────────────────────────
/**
 * 22062 行 / 游戏内存行的同帧标量副本（字段名口径见 core/acl/game-data.js 的 cq26ExcavSites）。
 * @param {object} s 报文行（池化，不可跨帧保留）
 * @returns {object} 新造的纯标量对象（ownServer 留 false，只有 ACL 投影能判归属）
 */
function projectSite(s) {
  var pos = (s && s.pos) || {};
  var siteId = s && s.siteId != null ? String(s.siteId) : '';
  return {
    siteId: siteId,
    cityId: Number(s && s.cityId) || 0,
    // 22062 行里叫 cityConfigId（地图 901 地块的 m 里叫 cityCfgId），两个名字都接
    cfgId: Number(s && (s.cityConfigId != null ? s.cityConfigId : s.cityCfgId)) || 0,
    ownerSid: Number(s && s.ownerSid) || 0,
    endTime: Number(s && s.endTime) || 0,
    x: Number(pos.x) || 0,
    y: Number(pos.y) || 0,
    k: Number(pos.k) || 0,
    claimed: false,
    ownServer: false,
  };
}

/**
 * 当前可采点集合：优先游戏内存投影（与 icon 同源、含权威 claimed 与本服归属），
 * 投影不可用（符号漂移/子包未载）时回落 22062 投影副本 + 本地 claimed 集，此时**无法判本服归属**，
 * 排序退化为「endTime 升序」（B 档口径），首遇打一条 warn。
 * @returns {Array<{siteId:string,cityId:number,cfgId:number,ownerSid:number,endTime:number,x:number,y:number,k:number,claimed:boolean,ownServer:boolean}>|null} null=两路都没有
 */
function currentSites() {
  var acl = gameData.cq26ExcavSites();
  if (acl) {
    // 游戏侧 claimed 为权威；本地乐观集只用来盖掉「已发成功但 22063 还没回」的窗口
    for (var i = 0; i < acl.length; i++) {
      if (claimed.has(acl[i].siteId)) acl[i].claimed = true;
    }
    aclDegradedWarned = false;
    return acl;
  }
  if (!Array.isArray(pushList)) return null;
  if (!aclDegradedWarned) {
    aclDegradedWarned = true;
    log.warn('excav acl projection unavailable, degrade to 22062 cache (no own-server priority).');
  }
  return pushList.map(function (s) {
    var o = Object.assign({}, s);
    o.claimed = o.siteId ? claimed.has(o.siteId) : true;
    return o;
  });
}

/**
 * 纯函数：从全量点里筛出「本轮可发 2491」的开放点（不读模块态，闸门全部显式传参）。
 * @param {Array<object>} sites currentSites 产出
 * @param {number} nowSec 服务器秒
 * @param {object} gates 闸门参数
 * @param {number} [gates.safeRemainSec] 剩余存在时间下限（低于此不入队）
 * @param {number} [gates.now] Date.now() 基准时刻（比对 coolUntil）
 * @param {Object<string,number>} [gates.coolUntil] siteId → 冷却到期毫秒
 * @param {Object<string,number>} [gates.rejectCount] siteId → 连续被拒次数
 * @param {number} [gates.maxReject] 达此次数即本场拉黑
 * @returns {Array<object>} 未排序的开放点
 */
export function pickOpen(sites, nowSec, gates) {
  var g = gates || {};
  var safe = g.safeRemainSec == null ? SAFE_REMAIN_SEC : g.safeRemainSec;
  var now = g.now == null ? Date.now() : g.now;
  var cool = g.coolUntil || {};
  var rej = g.rejectCount || {};
  var maxRej = g.maxReject == null ? MAX_REJECT : g.maxReject;
  var open = [];
  for (var i = 0; i < (sites || []).length; i++) {
    var s = sites[i];
    if (!s || !s.siteId || s.claimed) continue;
    if (s.endTime <= nowSec + safe) continue;
    if ((cool[s.siteId] || 0) > now) continue;
    if ((rej[s.siteId] || 0) >= maxRej) continue;
    open.push(s);
  }
  return open;
}

/**
 * 纯函数：复刻 getFirstOpenEnableSite 的选择序并扩成可排空的队列 —— 本服点按列表原序在前，
 * 其余按 endTime 升序。**队列头即游戏 icon 会选中的那一个**（单测逐条对拍游戏原式）。
 * @param {Array<object>} open pickOpen 产出（已经去过 claimed/过期/冷却）
 * @returns {Array<object>}
 */
export function orderLikeGame(open) {
  var own = [];
  var rest = [];
  for (var j = 0; j < (open || []).length; j++) {
    (open[j].ownServer ? own : rest).push(open[j]);
  }
  rest.sort(function (a, b) {
    return a.endTime - b.endTime;
  });
  return own.concat(rest);
}

/**
 * 本轮候选队列（按游戏选择序）。
 * @param {Array<object>} sites currentSites 产出
 * @param {number} nowSec 服务器秒
 * @returns {Array<object>}
 */
function buildQueue(sites, nowSec) {
  return orderLikeGame(
    pickOpen(sites, nowSec, {
      coolUntil: coolUntil,
      rejectCount: rejectCount,
    }),
  );
}

/**
 * 日界滚清：以服务器时刻所在日为键，换日则清空拒绝计数与冷却表（报文实证 siteId 内嵌开启秒，跨日旧点不会再出现）。
 * 口径同 feats/activity/floatcar/index.js 的 `capReachedOn.get(id) === todayStr()`（日界键，不靠重启动清零）。
 * @param {number} nowSec 服务器秒（>0，调用方已过时刻闸）
 */
function rolloverReject(nowSec) {
  var d = todayStr(nowSec);
  if (d === rejectDay) return;
  rejectDay = d;
  rejectCount = {};
  coolUntil = {};
}

// ── 调度 cycle ────────────────────────────────────────────────────────
const cfg = { activeMs: 20000, idleMs: 120000, backoffMs: 30000, chainMs: 800 };

/**
 * 单拍延迟决策：本轮采到了就短间隔续采（默认一轮采完：串行、每拍只发一条 2491，
 * claimed 逐件增长自然收敛，不会无限自激）；本轮没采到则按上一拍有无候选分档。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  await cyclePass();
  // 在飞期间攒下的 push（新点列表 / 已采集合变化）是权威信号，立即补一拍，不等整档睡眠
  if (cycle.pending) return 0;
  if (justClaimed) return cfg.chainMs;
  return lastHadCandidate ? cfg.activeMs : cfg.idleMs;
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.backoffMs,
});

// ── 核心 cyclePass ───────────────────────────────────────────────────
async function cyclePass() {
  justClaimed = false;
  // 1. 活动闸（宝藏点的开关由服务端 22062 决定，本闸只挡「活动整体不在」时的白撞）
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    lastHadCandidate = false;
    return;
  }
  // 2. 数据源：内存投影优先（漏收 22062 也在此自愈），回落 push 缓存
  var sites = currentSites();
  if (!sites) {
    log.debug('no site source yet (projection unavailable & no 22062).');
    lastHadCandidate = false;
    return;
  }
  var nowSec = gameData.serverTime() | 0;
  // 2b. 服务器时刻不可得时不做过期判定（endTime 与 0 比较会把全部点当成有效，白撞过期点）；
  //   去重 warn（时刻恢复后复位），否则跨服登录窗里会每拍一条刷屏。
  if (nowSec <= 0) {
    if (!serverTimeWarned) {
      serverTimeWarned = true;
      log.warn('ServerTime unavailable, skip this pass (expiry gate undecidable).');
    }
    return;
  }
  serverTimeWarned = false;
  // 2c. 日界滚清拉黑/冷却计数（当日语义）
  rolloverReject(nowSec);
  var q = buildQueue(sites, nowSec);
  lastHadCandidate = q.length > 0;
  if (!q.length) {
    log.debug(
      'no excavable site. total=%d claimed=%d',
      sites.length,
      sites.filter(function (s) {
        return s.claimed;
      }).length,
    );
    return;
  }
  // 3. 队头发 2491（串行：sendGuarded 的在途闸门等价游戏侧 checkRequestIdNoRes）
  if (!net) {
    log.warn('net unavailable, skip claim. site=%s', q[0].siteId);
    return;
  }
  var s = q[0];
  var t0 = Date.now();
  // 发送抛错只留一条 warn：onError 把 err 存进 sendErr，与「在途闸命中/超时」共用同一条 CODE_NOT_SENT 出口分叉
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_CLAIM,
    { siteId: s.siteId },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  // 停用期间的应答不记账（快照已随 pause 丢弃，resume 后重读）
  if (!aliveFn()) {
    log.debug('2491 ack after pause, drop bookkeeping. site=%s', s.siteId);
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn(
      '2491 not sent%s. site=%s',
      sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)',
      s.siteId,
    );
    return;
  }
  if (!ret || !ret.ok) {
    noteReject(s, ret);
    return;
  }
  settleClaim(s, ret, Date.now() - t0);
}

/**
 * 成功结算：乐观去重 + 面板记账 + 逐件日志。奖励在 header.ts+10s 的幽灵行军到账，实测直接进背包，
 * 故这里不等 marchEndTime、也不查行军名额。
 * @param {object} s 点位
 * @param {object} ret Ret{ok,code,data}
 * @param {number} costMs 往返耗时
 */
function settleClaim(s, ret, costMs) {
  claimed.add(s.siteId);
  rejectCount[s.siteId] = 0;
  delete coolUntil[s.siteId];
  justClaimed = true;
  var d = (ret && ret.data) || {};
  var items = (d.reward && d.reward.items) || [];
  var got = items
    .map(function (it) {
      return item.label(it.itemId) + '×' + (Number(it.itemCount) || 0);
    })
    .join(', ');
  log.info(
    'excavated S%d site=%s (%d,%d) k=%d remain=%ds cost=%dms → %s',
    s.ownerSid,
    s.siteId,
    s.x,
    s.y,
    s.k,
    Math.max(0, s.endTime - (gameData.serverTime() | 0)),
    costMs,
    got || 'empty reward',
  );
}

/**
 * 业务拒绝：属可预期闸门类（已采/过期/时序竞争），info 级不升 warn；
 * 单次留冷却自愈，连续 MAX_REJECT 次当日拉黑该点（防逐拍重发刷屏）。
 * @param {object} s 点位
 * @param {object} ret Ret{code,data}
 */
function noteReject(s, ret) {
  var code = ret ? ret.code : 'unknown';
  var n = (rejectCount[s.siteId] = (rejectCount[s.siteId] || 0) + 1);
  coolUntil[s.siteId] = Date.now() + REJECT_COOL_MS;
  log.info(
    '2491 rejected. site=%s code=%s reason=%s streak=%d%s',
    s.siteId,
    code,
    rejectText(ret),
    n,
    n >= MAX_REJECT ? ' (blacklisted today)' : '',
  );
}

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 面板 defaults。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
  };
}

/**
 * 面板 fields：单行内联状态（组卡片 inlineStatus 取第一个 type:'text' 的 get() 结果）。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_excavInfo',
      type: 'text',
      label: '可采',
      get: function () {
        if (!gameData.cq26IsOpen()) return '—';
        var sites = currentSites();
        if (!sites) return '—';
        var nowSec = gameData.serverTime() | 0;
        var q = nowSec > 0 ? buildQueue(sites, nowSec) : [];
        return String(q.length);
      },
    },
  ];
}

/**
 * toModuleCfg：面板 cfg → 运行时归一化 MCFG。本玩法已无可调参数（「一轮采完」是默认行为，
 * 不再是开关），仍必须声明：registry 的 applyFeature 对每个 reactor 功能无条件调它。
 * @returns {object}
 */
function normalizeCfg() {
  return {};
}

// ── 注册 ──────────────────────────────────────────────────────────────
reactor.register({
  id: 'cq26Excav',
  label: '战区宝藏发掘',
  storageKey: 'pocketcc.feat.cq26_excav',
  // cq26NeutralCtrl 为软依赖：投影拿不到时降级为「只信 22062/22063 推送」，不阻断安装（见 core/acl-engine.js CAPS）
  symbols: ['dataCenter', 'cq26NeutralCtrl?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 面板可用性：活动未开启时整卡置灰（只影响面板观感，运行期仍由 run 内的活动闸把关）
  available: () => (gameData.cq26IsOpen() ? true : { ok: false, reason: 'CQ26 印石活动未开启' }),
  // 发掘不派兵、不占行军名额（marchType 332 为幽灵行军，实测 856 列表零命中），战斗态无需下线
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
