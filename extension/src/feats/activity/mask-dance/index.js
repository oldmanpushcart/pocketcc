/**
 * 假面舞会 / 万圣节派对基地宝箱自动领取（MASK_DANCE / cityReward，活动设置-基础设置；无面板选项，参数全内置）
 *
 * 玩法：盟友在假面迷城活动里用掉「假面舞会 / 假面-藏宝图 / 假面-机甲 / 假面-复合资源」类道具后，
 *   其基地头顶出现一座限时宝箱（约 30 分钟），本联盟每人对每个舞会实例可点一次领奖，
 *   每日上限由配置表 `mask_mystery_party.daily_limit` **按宝箱道具逐条**决定（用户口径 10 次/天）。
 *   「假面舞会」与「万圣节派对」是同一套机制、同一张表、同一个 2503，只差道具行的
 *   `item_id / share_msg_key / msg_type / daily_limit`（客户端源码 UserItemCityRewardBtn/Panel 实证），
 *   所以本 feat 一律以配置表为准、不按道具号写死。完整协议分析与运行时缺口见 extension/docs/feat-假面舞会.md。
 *
 * 协议（报文实证；源码实证 extracted/subpack/UserItemCityReward*）：
 *   2503 DANCE_GET_REWARD  sendPBV2 {targetUidStr:"<开启者 pid 字符串>"}
 *     → {header:{s:0}, data:{rewardResult:{items:[{itemId:260617006,itemCount:1}]}}}
 *   push 10053 {danceRec:{"260617005":1}, myReceiveDance:["4909640309826248704"]}
 *     · danceRec    = 按宝箱道具 id 计的今日已领次数（**逐道具**限额的权威分子）
 *     · myReceiveDance = 今日已领过的舞会实例 id 字符串数组（幂等判据，同实例只领一次）
 *     · UserData 落地字段名已由源码坐实：itemCityRewardReceivedNum / itemCityRewardReceivedInstIds
 *   push 10018 / resp 901 玩家城 `p.cityReward = {itemId, instanceId(字符串), num, players[], endTimeMilli}`
 *     （实录报文）；`players[]` 只是展示名单**不含 uid**，不可作「我领没领」的判据
 *   聊天卡两种形态，都只保证给坐标，**给不给 pid 看发卡路径**：
 *     A. 坐标分享卡  llm={t:0, st:4, p:{x,y,z}, pid:"863595288866"}
 *     B. 活动分享卡  llm={t:48, icon, s:<share_msg_key>, p:{x,y}, extra:{btnKey:102385, aid,
 *        expireTime, contentParams:[开启者名], jumpServerId}, actt:<msg_type>}
 *        —— sendChatLinkActCommon2 源码实证**不写 pid**；「万圣节派对」分享只走这条，
 *        开启者 pid 必须由 901 按坐标反查 `p.pid`（竞对B 同思路：卡片只当坐标用）。
 *        发这条卡的客户端入口有两个，两条都不带 pid（源码实证，故 t=48 卡必做坐标反查）：
 *          · UserItemCityRewardPanel.shareCtrl——未领玩家在面板上点「分享」，
 *            p = 分享者自己的 UserData.WorldCoord，expireTime = ServerTime + cruis_times，
 *            jumpServerId = UserData.OriginServerId，频道 args[0]="1"；
 *          · UserItemCityRewardBtn.awardClick 的「已领再分享」分支——p = 舞会所在瓦片
 *            tileX/tileY，expireTime = endTimeMilli/1000，jumpServerId = extData.w，频道 args[0]="2"。
 *     实录只含 A 型（本份报文里没有 t=48 卡，用户截图那条派对分享卡在报文之后才发生），
 *     B 型的字段形状以源码为准。
 *
 * 设计要点：
 *   1) **纯发包不派行军**——客户端领奖按钮就是直发 2503（UserItemCityRewardBtn.awardClick 源码实证），
 *      实录里 117 条 marchType:321 的行军是别人「前往舞会」的图面行军，与本端领奖无关；
 *   2) **事件驱动为主、周期只做排空**——舞会只在开启者基地 + 30 分钟窗口内存在，靠 push 10018 与聊天卡
 *      两个被动通道发现（不逐拍发包查询），cycle 只负责把队列排空与日切复位，静默期零发包；
 *   3) **不做本地射程闸门**——服务端是否校验距离未实证（缺口 §4-1），本 feat 无面板项，索性交服务器裁决：
 *      真超距会被拒，收到业务拒即当日拉黑该舞会实例（一个实例最多撞一次墙），不会逐拍重发刷日志；
 *   4) **镜像记账**——直发 2503 不回写游戏本地态，故 todayByItem/claimedInstIds 走内存 + 存储镜像，
 *      push 10053 到达时以服务器权威值覆盖（对齐 daily-supply 的 mirror 范式）；
 *   5) **频道不做硬白名单**——实录里这张分享卡是发在世界频道（c=0）的（报文实证），
 *      而非玩法口径所说的联盟频道，故接全部频道的坐标卡；噪声卡由闸门链里的两道对称闸拦住：
 *      「901 实查该点基地带 cityReward」+「itemId 在 `mask_mystery_party` 有行」（代价仅一次 901 查询，不发包领取）。
 *
 * 内置参数（无面板选项，均自适应）：逐道具上限读 `mask_mystery_party.daily_limit`（读不到兜底 10）；
 *   宝箱道具 id 用假面迷城已知族兜底 + 运行期**经 `mask_mystery_party` 表核验后**学习（来年换皮号无需改码）。
 *
 * 合规：只读游戏数据（经 game-api ACL）+ 发 2503/901，不调任何 Update/Delete、不 OpenUI。
 *   生命周期由 reactor 托管；pause 只清待排空队列（不保留陈旧坐标快照）。
 */
import { CODE_NOT_SENT, todayStr, safeParse, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData, l10n, bits, worldMap } from '../../../core/game-api.js';
import { getUid } from '../../../core/player.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { map } from '../../../core/map.js';
import { storage } from '../../../core/storage.js';
import { dailyText } from '../../../core/daily-stats.js';

import { CMD_DANCE_GET_REWARD, PUSH_USER_DATA_COMMON, PUSH_TILEINFO } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MASK-DANCE） */
const log = createLog('MASK-DANCE');

/** @type {number} 玩家城 pointType（901/10018 同口径） */
const POINT_TYPE_CITY = 1;

/** @type {number} ChatShareLinkType.POSITION：坐标分享卡（舞会开启者分享基地即此型） */
const LINK_T_POSITION = 0;

/** @type {number} ChatShareLinkType.ACTIVITY_COMMON2：活动通用卡（已领玩家再分享走这型，btnKey=102385） */
const LINK_T_ACTIVITY_COMMON2 = 48;

/** @type {number} ChatShareLinkSubType 基地（t=0 卡的位置子类） */
const LINK_ST_BASE = 4;

/**
 * 已知宝箱载体道具 id（假面迷城族，字典 item_name_26061700x 实证）。
 * 内置常量只作「配置表未就绪时」的兜底；新号（如万圣节派对的道具号）一律靠 `mask_mystery_party`
 * 表核验后运行期学习，故本表不必逐年维护。
 * @type {string}
 */
const DEFAULT_BOX_ITEMS = '260617001,260617002,260617003,260617004,260617005';

/** @type {number} 配置表 `mask_mystery_party.daily_limit` 读不到时的逐道具每日上限兜底（用户口径 10 次/天） */
const DAILY_LIMIT_FALLBACK = 10;

/**
 * 901 单窗探针的 viewLevel。取 0（全量点）而非 fetchWindow 默认的 1：
 * viewLevel≥1 服务器按层级聚合精简，可能把目标城聚掉（实证：游戏自己视口的 901 请求体即 viewLevel:0）。
 * @type {number}
 */
const PROBE_VIEW_LEVEL = 0;

/** @type {number} 队列排空/数据未就绪时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 5;

/** @type {number} 有候选时的排空间隔（毫秒）：候选由推送喂，这里只兜住「在飞期间的积压」 */
const DRAIN_TICK_MS = 1000 * 20;

/** @type {number} 日切唤醒缓冲（毫秒），对齐每日补给/矿洞的日界留白口径 */
const DAY_ROLL_BUFFER_MS = 1000 * 60 * 5;

/** @type {number} 候选队列上界（超出丢最旧，防长时间挂机无界增长） */
const QUEUE_MAX = 60;

/** @type {number} 当日拉黑实例 id 上界（FIFO 淘汰） */
const BLACKLIST_MAX = 300;

/** @type {number} 同一候选的重试上界（只重试只读 901，不重发写请求），防网络抖动导致一次性聊天卡候选永久漏领 */
const CLAIM_RETRY_MAX = 3;

/** @type {string} 今日领取镜像的持久数据键（storage.data blob 内逻辑名，跨日失效） */
const MIRROR_NAME = 'maskDance.mirror';

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {Array<{key:string,pid:string,x:number,y:number,sid:number,src:string,attempts:number}>} 待领候选队列（按 key 去重：有 pid 用 pid，无 pid 用坐标） */
var queue = [];

/** @type {Set<string>} 队列内已存在的候选键（去重闸门） */
var queuedKeys = new Set();

/** @type {Set<string>} 当日拉黑的舞会实例 id（已领/过期/名额满） */
var blacklisted = new Set();

/** @type {Object<string,boolean>} 已知宝箱道具 id 集（内置假面迷城族 + 运行期学习值） */
var boxItemIds = {};
DEFAULT_BOX_ITEMS.split(/[,，\s]+/).forEach(function (t) {
  if (/^\d+$/.test(String(t).trim())) boxItemIds[String(t).trim()] = true;
});

/** @type {Object<string,number>} 逐道具的今日已领次数镜像（限额是逐道具口径，全局求和会提前封顶） */
var todayByItem = {};

/** @type {string} 镜像所属本地日期（yyyy-mm-dd），跨日即复位 */
var mirrorDay = '';

/** @type {string[]} 镜像的已领实例 id（与 todayByItem 同日生效） */
var mirrorInstIds = [];

/** @type {boolean} 今日镜像是否已读回（未读回前禁止落盘，防半截态覆盖存档） */
var mirrorLoaded = false;

/**
 * 功能是否仍在运行（在飞流程 await 回来后的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// safeParse 已收口至 core/util.js（见顶部 import）

/**
 * 当前生效的宝箱道具 id 集（内置假面迷城族 + 运行期经表核验后学习的值）
 * @returns {Set<string>}
 */
function boxItemSet() {
  return new Set(Object.keys(boxItemIds));
}

/**
 * 取「派对/舞会」道具配置行（`mask_mystery_party`）。
 * 必须按 `item_id` 列查而非按主键：客户端三处读表（UserItemCityRewardBtn/Panel、ItemData.GetDes）
 * 走的都是 `getTableByKeyFromBuffer(mask_mystery_party, "item_id", …)`，主键另有其列时
 * `tableRow`（=getTableDataById）恒返回 null，未知道具会被白名单闸误拦、限额误兜底。
 * @param {*} itemId 宝箱载体道具 id
 * @returns {object|null} 行不存在/表未就绪返回 null
 */
function partyRow(itemId) {
  if (itemId == null || itemId === '') return null;
  return l10n.tableRowByKey('maskMysteryParty', 'item_id', itemId) || null;
}

/**
 * 登记一个宝箱道具 id（只由可信来源调用：权威 danceRec 的键、或经 mask_mystery_party 表核验的 itemId）
 * @param {*} itemId 道具 id
 * @returns {boolean} 是否为本次新登记（假 = 早已在册或非数字 id）
 */
function learnBoxItem(itemId) {
  var k = itemId == null ? '' : String(itemId);
  if (!/^\d+$/.test(k) || boxItemIds[k]) return false;
  boxItemIds[k] = true;
  log.info('learned new box itemId=%s', k);
  return true;
}

/**
 * 是否舞会宝箱载体道具 id（瓦片路径与聊天路径共用的同一道白名单闸）。
 * 已知族命中即真；未知号只有在活动配置表 `mask_mystery_party` 里有行才认可——
 * 「从 cityReward.itemId 无脑学习」会让白名单形同虚设，别的玩法挂在玩家城上的 cityReward 载体
 * 会被学进来，并招致一次发给非舞会目标的 2503 写请求。
 * @param {*} itemId 道具 id
 * @returns {boolean}
 */
function isMaskDanceItem(itemId) {
  var k = itemId == null ? '' : String(itemId);
  if (boxItemIds[k]) return true;
  if (!/^\d+$/.test(k) || !partyRow(k)) return false;
  return learnBoxItem(k);
}

/**
 * 跨日复位：镜像、拉黑名单、队列一律清空（未读回前不动，防半截态）
 */
function rollDayIfNeeded() {
  if (!mirrorLoaded) return;
  var day = todayStr();
  if (day === mirrorDay) return;
  mirrorDay = day;
  todayByItem = {};
  mirrorInstIds = [];
  blacklisted.clear();
  queue = [];
  queuedKeys.clear();
  persistMirror();
}

/**
 * 当日拉黑一个舞会实例 id（已领/过期/名额满）；超 BLACKLIST_MAX 按插入序淘汰最旧
 * @param {string} instId 舞会实例 id 字符串
 */
function markBlacklist(instId) {
  if (blacklisted.has(instId)) return;
  if (blacklisted.size >= BLACKLIST_MAX) {
    var oldest = blacklisted.values().next().value;
    if (oldest != null) blacklisted.delete(oldest);
  }
  blacklisted.add(instId);
}

/**
 * 落盘今日镜像（storage.data 数据 blob，与面板配置分离；日期字段自证跨日失效）
 */
function persistMirror() {
  if (!mirrorLoaded) return;
  Promise.resolve(
    storage.data.set(MIRROR_NAME, {
      date: todayStr(),
      byItem: todayByItem,
      insts: mirrorInstIds.slice(-BLACKLIST_MAX),
    }),
  ).catch(function () {
    /* 存储不可用只降级为「重启后可能重复发一次被拒请求」，不影响循环 */
  });
}

/**
 * 读回今日镜像（run 启动时一次；存档日期不符直接丢弃）
 * @returns {Promise<void>}
 */
async function loadMirror() {
  mirrorLoaded = false;
  todayByItem = {};
  mirrorInstIds = [];
  var saved;
  try {
    saved = await storage.data.get(MIRROR_NAME);
  } catch (e) {
    saved = null;
  }
  mirrorDay = todayStr();
  if (saved && typeof saved === 'object' && saved.date === mirrorDay) {
    // 合并而非赋值：读盘窗口里 push 10053 可能已把权威值写进内存，整块赋值会把它冲回旧存档；
    // 而权威态「在场但全空」（可能是未同步）也不足以单独信，故两侧取较大者 / 求并集，幂等判据宁滥勿缺。
    // 旧版存档只有全局 `claims`（无法归到具体道具），逐道具口径下直接丢弃：
    // 多领的代价是一次被服务端拒的 2503，比把限额拍扁成全局导致整天不领可接受得多。
    var savedByItem = saved.byItem && typeof saved.byItem === 'object' ? saved.byItem : null;
    if (savedByItem) {
      for (var k in savedByItem) {
        var n = Number(savedByItem[k]) || 0;
        if (n > (todayByItem[k] || 0)) todayByItem[k] = n;
      }
    }
    for (var id of Array.isArray(saved.insts) ? saved.insts : []) {
      var s = String(id);
      if (mirrorInstIds.indexOf(s) < 0) mirrorInstIds.push(s);
    }
    log.info('mirror merged. claims=%d;insts=%d', claimedCount(), mirrorInstIds.length);
  }
  mirrorLoaded = true;
}

// ── 今日领取态 ────────────────────────────────────────────────────────
/**
 * 今日已领实例 id：优先游戏权威值，缺失回退内存镜像，两者合并（幂等判据宁滥勿缺）
 * @returns {Set<string>}
 */
function claimedInstIds() {
  var s = new Set(mirrorInstIds);
  var st = gameData.maskDanceState();
  if (st) for (var id of st.instIds) s.add(String(id));
  return s;
}

/**
 * 某个宝箱道具今日已领次数：权威值与镜像取较大者（两者描述同一件事，相加会翻倍导致误封顶）
 * @param {*} itemId 宝箱道具 id
 * @returns {number}
 */
function claimedByItem(itemId) {
  var k = String(itemId);
  var st = gameData.maskDanceState();
  var auth = st ? Number(st.byItem[k]) || 0 : 0;
  return Math.max(auth, Number(todayByItem[k]) || 0);
}

/**
 * 今日已领总次数（供日志/诊断与面板展示）：逐道具取较大者后求和。
 * 限额判定一律走 itemCapped——游戏闸门是逐道具口径，全局和不能当封顶判据，也不能当面板分母。
 * @returns {number}
 */
function claimedCount() {
  var keys = new Set(Object.keys(todayByItem));
  var st = gameData.maskDanceState();
  if (st) for (var k in st.byItem) keys.add(String(k));
  var n = 0;
  for (var key of keys) n += claimedByItem(key);
  return n;
}

/**
 * 某个宝箱道具的今日上限（无面板选项，直读活动配置表 `mask_mystery_party[itemId].daily_limit`）；
 * 表未就绪/无行则兜底 DAILY_LIMIT_FALLBACK。
 * @param {*} itemId 宝箱道具 id
 * @returns {number}
 */
function dailyLimitOf(itemId) {
  var row = partyRow(itemId);
  var n = row ? Number(row.daily_limit) || 0 : 0;
  return n > 0 ? n : DAILY_LIMIT_FALLBACK;
}

/**
 * 该道具今日是否已封顶（限额是**逐道具**口径，源码实证：`daily_limit > itemCityRewardReceivedNum[itemId]`）
 * @param {*} itemId 宝箱道具 id
 * @returns {boolean}
 */
function itemCapped(itemId) {
  return claimedByItem(itemId) >= dailyLimitOf(itemId);
}

/**
 * 家族内**每一个**能读到限额的道具是否都已封顶（cycle 的长睡判据）。
 * 逐道具口径下「总量满了」推不出「这个箱子满了」，故只有全族皆满才允许睡到日切；
 * 一条限额都读不到（表未就绪）时返回 false——宁可继续巡检也不误睡掉整天。
 * @returns {boolean}
 */
function allItemsCapped() {
  var seen = 0;
  for (var itemId of boxItemSet()) {
    var row = partyRow(itemId);
    if (!row || !(Number(row.daily_limit) > 0)) continue;
    seen++;
    if (!itemCapped(itemId)) return false;
  }
  return seen > 0;
}

/**
 * 睡到下一个本地日界 + 缓冲（封顶档）；封顶 26h 防时钟异常导致超睡
 * @returns {number} 毫秒
 */
function dayRollDelay() {
  var now = new Date();
  var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  var ms = next.getTime() - now.getTime() + DAY_ROLL_BUFFER_MS;
  return Math.min(Math.max(ms, DRAIN_TICK_MS), 1000 * 60 * 60 * 26);
}

// ── 候选入队 ──────────────────────────────────────────────────────────
/**
 * 一个候选基地入队（按候选键去重 + 镜像未就绪前置闸门）
 * @param {string} pid 舞会开启者 pid（= 2503 的 targetUidStr）；活动分享卡拿不到，传空串走坐标反查
 * @param {number} x 基地 game x
 * @param {number} y 基地 game y
 * @param {string} src 来源标记（chat/tile，日志定位用）
 * @param {number} [sid=0] 卡片声明的目标服号（0=未声明）
 */
function enqueue(pid, x, y, src, sid) {
  pid = bits.int64Str(pid);
  if (pid && !/^\d{6,}$/.test(pid)) return;
  // 镜像读回前不入队：此刻 todayByItem 仍是空，「重启前已领 N 次」会被当作没领而超发。
  // 读盘只有一个 RTT，10018 是持续增量流、同一座城随后还会再推来，代价仅漏掉这一拍的候选。
  if (!mirrorLoaded) {
    log.debug('mirror not loaded, candidate deferred. pid=%s;x=%d;y=%d;src=%s', pid, x, y, src);
    return;
  }
  // 去重键：有 pid 按 pid（同一座城只一条队），无 pid 只能按坐标（活动分享卡不给 pid）。
  var key = pid || (x | 0) + ':' + (y | 0);
  if (queuedKeys.has(key)) return;
  if (queue.length >= QUEUE_MAX) {
    var drop = queue.shift();
    if (drop) queuedKeys.delete(drop.key);
  }
  queuedKeys.add(key);
  queue.push({
    key: key,
    pid: pid,
    x: x | 0,
    y: y | 0,
    sid: Number(sid) || 0,
    src: src,
    attempts: 0,
  });
  log.info(
    'candidate queued. pid=%s;x=%d;y=%d;src=%s;qlen=%d',
    pid || '-',
    x,
    y,
    src,
    queue.length,
  );
  cycle.kick();
}

/**
 * 从一条瓦片点对象提取舞会候选（`p.cityReward` 在场即视为一场舞会）
 * @param {object} point 901/10018 的点位对象
 * @param {string} src 来源标记
 */
function offerFromPoint(point, src) {
  if (!point || point.pointType !== POINT_TYPE_CITY) return;
  var p = point.p;
  var cr = p && p.cityReward;
  if (!cr || cr.itemId == null || cr.instanceId == null) return;
  if (!isMaskDanceItem(cr.itemId)) return;
  var instId = String(cr.instanceId);
  // 已领与当日拉黑（过期/名额满/被拒）两道都要在这里拦：10018 是约 3 条/秒的视口增量流，
  // 漏掉 blacklisted 会让同一座城反复入队、每轮换走一次无谓的 901 查询（拦在 claimOne 里太晚）
  if (blacklisted.has(instId) || claimedInstIds().has(instId)) return;
  // 视口推送的城必在本服（sid 缺省 0），不传目标服号
  enqueue(bits.int64Str(p.pid), point.x, point.y, src);
}

/**
 * push 10018 瓦片增量：一条推送可能带几十个点，先做便宜的字符串预筛再解析
 * @param {object} ev bus 事件（ev.data 为推送载荷）
 */
function onTilePush(ev) {
  if (!aliveFn()) return;
  var d = ev && ev.data;
  var list = d && d.pointInfos;
  if (!Array.isArray(list)) return;
  for (var pt of list) offerFromPoint(pt, 'tile');
}

/**
 * push 10053 用户通用数据：danceRec / myReceiveDance 到达即以服务器权威值覆盖镜像
 * @param {object} ev bus 事件
 */
function onUserDataPush(ev) {
  if (!aliveFn()) return;
  var d = safeParse(ev && ev.data) || {};
  if (d.danceRec == null && d.myReceiveDance == null) return;
  var n = 0;
  var rec = d.danceRec || {};
  for (var k in rec) {
    learnBoxItem(k);
    var v = Number(rec[k]);
    if (Number.isFinite(v)) n += v;
  }
  if (n > 0 || Array.isArray(d.myReceiveDance)) {
    for (var rk in rec) {
      var rv = Number(rec[rk]);
      if (Number.isFinite(rv) && rv > (todayByItem[rk] || 0)) todayByItem[rk] = rv;
    }
    // 并集而非整体替换：文档 §2.1 记的下发口径是增量，而实录只有「首次领取后」那条单元素样本，
    // 无法证伪增量；覆盖式赋值在增量语义下会把先前记下的已领 id 全冲掉 → 同实例重复发 2503
    if (Array.isArray(d.myReceiveDance)) {
      for (var id of d.myReceiveDance) {
        var s = String(id);
        if (mirrorInstIds.indexOf(s) < 0) mirrorInstIds.push(s);
      }
    }
    persistMirror();
    log.debug('authoritative state. claims=%d;insts=%d', claimedCount(), mirrorInstIds.length);
  }
  if (allItemsCapped()) log.info('all party items capped today, idle till day roll.');
}

/**
 * 聊天卡解析：命中「基地坐标」的分享卡就入队（不限频道，见文件头要点 5）。
 * 两条发卡路径只有一条带 pid：坐标分享卡 t=0 带 pid，活动分享卡 t=48（sendChatLinkActCommon2）
 * **只有坐标**——所以 pid 不是入队前置条件，缺它时由 locateCityReward 按坐标反查。
 * @param {object} chat pocketcc.chat 底座
 * @param {object} raw 原始消息项
 * @param {string} kind 'push' | 'pm'
 */
function onChatMsg(chat, raw, kind) {
  if (!aliveFn() || !raw || typeof raw !== 'object') return;
  var norm = chat.normalize(raw, kind);
  if (!norm || norm.isSelf) return; // 自己回声不接（防自触发）
  var llm = norm.llm || safeParse(raw.llm);
  if (!llm || typeof llm !== 'object') return;
  var t = +llm.t;
  if (t !== LINK_T_POSITION && t !== LINK_T_ACTIVITY_COMMON2) return;
  if (t === LINK_T_POSITION && llm.st != null && +llm.st !== LINK_ST_BASE) return;
  var p = llm.p;
  if (!p || p.x == null || p.y == null) return;
  var extra = safeParse(llm.extra) || {};
  // 过期卡直弃：extra.expireTime 是分享时就写死的窗口末点（秒，Btn 取 endTimeMilli/1e3），省一次 901
  var exp = Number(extra.expireTime) || 0;
  if (exp > 0 && exp <= gameData.serverTime()) return;
  enqueue(llm.pid != null ? String(llm.pid) : '', +p.x, +p.y, 'chat', cardServerId(p, extra));
}

/**
 * 从聊天卡取目标服号（真机实证：t=48 活动卡的 p.z 恒为 0 假值，真实服号在 extra.jumpServerId；
 * 普通坐标分享卡才是 p:{x,y,z}）。<=0 一律视为无服号（返回 0，由调用方按本服处理）。
 * @param {object} p 卡片坐标对象
 * @param {object} extra 卡片 extra 对象（已解串）
 * @returns {number}
 */
function cardServerId(p, extra) {
  var cands = [extra && extra.jumpServerId, p.z, p.s];
  for (var c of cands) {
    var n = Number(c) || 0;
    if (n > 0) return n;
  }
  return 0;
}

/**
 * 聊天批次入口（载荷可能单项或数组，单条坏消息不拖垮批次）
 * @param {string} kind 'push' | 'pm'
 * @param {object|object[]} payload 原始消息
 */
function onMessages(kind, payload) {
  var chat = chatApiRef();
  if (!chat) return;
  var items = Array.isArray(payload) ? payload : [payload];
  for (var raw of items) {
    try {
      onChatMsg(chat, raw, kind);
    } catch (err) {
      log.warn('handle chat message threw. kind=%s', kind, err);
    }
  }
}

/**
 * 聊天底座懒取（install 可能早于底座就绪）
 * @returns {object|null}
 */
function chatApiRef() {
  return ctxRef && ctxRef.chat ? ctxRef.chat : null;
}

// ── 领取执行 ──────────────────────────────────────────────────────────
/**
 * 901 单窗定位目标基地，取回权威的 cityReward 快照与开启者 pid。
 * 失败分三档返回，因为调用方要靠它决定「值不值得重试」：一律回 null 会把确定的坏消息与抖动混为一谈。
 * @param {number} x 目标 game x
 * @param {number} y 目标 game y
 * @param {string} pid 目标开启者 pid；空串 = 卡片没给，改按坐标认城并反查 pid
 * @param {number} sid 901 请求体 k（本服服号）
 * @returns {Promise<{kind:string, loc?:{cr:object,x:number,y:number,pid:string}}>}
 *   `kind`：`ok`（带 loc）| `probe`（901 未成功，抖动可翻转、该重试）|
 *   `absent`（窗内没有目标城，可能坐标偏差/对方迁城，可重试）|
 *   `no-reward`（城在场但不带 cityReward——当日确定结论，重试无意义）
 */
async function locateCityReward(x, y, pid, sid) {
  // 901 请求体 k 口径：UserData.ServerId（非镜头服号，见 core/map.js fetchWindow 注释）；
  // viewLevel 取 0 全量点，防聚合档把目标城精简掉（见 PROBE_VIEW_LEVEL 注释）
  var r = await map.fetchWindow(net, x, y, { k: sid | 0, viewLevel: PROBE_VIEW_LEVEL });
  if (!r.ok) {
    log.debug('901 probe not ok. x=%d;y=%d;code=%s;data=%s', x, y, r.code, rejectText(r) || '-');
    return { kind: 'probe' };
  }
  for (var pt of r.points) {
    if (!pt || pt.pointType !== POINT_TYPE_CITY || !pt.p) continue;
    var ptPid = bits.int64Str(pt.p.pid);
    // 有 pid 的卡按 pid 认（迁城后卡片坐标会失效，坐标不可信）；
    // 无 pid 的卡只能按坐标认、pid 从点反查——实录实证卡片 p:{x,y} 与点位 x/y 逐等（352:474）
    if (pid) {
      if (ptPid !== pid) continue;
    } else if ((pt.x | 0) !== (x | 0) || (pt.y | 0) !== (y | 0)) {
      continue;
    }
    if (!pt.p.cityReward) return { kind: 'no-reward' };
    return {
      kind: 'ok',
      loc: { cr: pt.p.cityReward, x: pt.x | 0, y: pt.y | 0, pid: ptPid || pid || '' },
    };
  }
  return { kind: 'absent' };
}

/**
 * 处理一个候选：闸门链 → 901 定位（必要时反查 pid）→ 2503 领取 → 记账。永不 reject。
 * @param {{key:string,pid:string,x:number,y:number,sid:number,src:string,attempts:number}} cand 候选
 */
async function claimOne(cand) {
  rollDayIfNeeded();
  var own = worldMap.serverId() | 0;
  // 本服服号拿不到（UserData 未就绪）：901 的 k=0 只会换回空应答（口径见 core/map.js fetchWindow 注释），
  // 它是可翻转的「数据未就绪」，回填等下一拍而不是当作「那城没宝箱」的确定结论。
  if (own <= 0) {
    if (requeue(cand)) return;
    log.debug('serverId unavailable, cannot address 901. x=%d;y=%d', cand.x, cand.y);
    return;
  }
  // 卡片声明的目标服与本服不同：901 的 k 只能查本服图，硬查会在本服同坐标上领到一座无关的城
  if (cand.sid > 0 && cand.sid !== own) {
    log.debug(
      'card points to another server, out of reach. sid=%d;own=%d;x=%d;y=%d',
      cand.sid,
      own,
      cand.x,
      cand.y,
    );
    return;
  }
  var res = await locateCityReward(cand.x, cand.y, cand.pid, own);
  if (!aliveFn()) return;
  if (res.kind !== 'ok') {
    // 只对「结论可翻转」的失败回填重试：`no-reward` 是确定结论（那城此刻就是没宝箱），
    // 它是噪声聊天卡的常态；若也重试，等于把无效 901 的成本放大 CLAIM_RETRY_MAX 倍
    if (res.kind !== 'no-reward' && requeue(cand)) return;
    log.debug(
      'no live cityReward at target. pid=%s;x=%d;y=%d;kind=%s',
      cand.pid || '-',
      cand.x,
      cand.y,
      res.kind,
    );
    return;
  }
  var cr = res.loc.cr;
  // pid 以 901 实查为准（活动分享卡不带 pid）；拿不到 pid 就无从寻址，不能盲发 2503
  var pid = res.loc.pid;
  if (!pid) {
    log.debug('city point has no pid, cannot address. x=%d;y=%d', res.loc.x, res.loc.y);
    return;
  }
  var instId = String(cr.instanceId);
  if (blacklisted.has(instId)) return;
  // 道具白名单（与瓦片路径对称）：聊天路径绕过了 offerFromPoint，非舞会载体一律不发 2503
  if (!isMaskDanceItem(cr.itemId)) {
    markBlacklist(instId);
    log.debug(
      'cityReward carrier not in mask-dance family, skip. inst=%s;itemId=%s',
      instId,
      String(cr.itemId),
    );
    return;
  }
  if (claimedInstIds().has(instId)) {
    markBlacklist(instId);
    return;
  }
  var nowSec = gameData.serverTime();
  if (Number(cr.endTimeMilli) / 1000 <= nowSec) {
    markBlacklist(instId);
    log.debug('party expired, skip. inst=%s', instId);
    return;
  }
  // 逐道具日限（与游戏闸门同判据）：撞顶也当日拉黑，否则 10018 会反复喂同一座城刷 901
  if (itemCapped(cr.itemId)) {
    markBlacklist(instId);
    log.info(
      'item daily limit reached, skip. itemId=%s;used=%d;limit=%d',
      String(cr.itemId),
      claimedByItem(cr.itemId),
      dailyLimitOf(cr.itemId),
    );
    return;
  }
  // 每场舞会的共享名额（mask_mystery_party.reward_num - cityReward.num）：先到先得，领完即弃
  var row = partyRow(cr.itemId);
  var cap = row ? Number(row.reward_num) || 0 : 0;
  if (cap > 0 && Number(cr.num) >= cap) {
    markBlacklist(instId);
    log.info('party seats used up, skip. inst=%s;num=%d;cap=%d', instId, Number(cr.num) || 0, cap);
    return;
  }
  // 2503 在途（上一条领取还没回来）：回填本候选等下一拍，不能就地丢弃
  if (net.isSending(CMD_DANCE_GET_REWARD)) {
    requeue(cand);
    return;
  }

  var threw = false;
  var ret = await net.sendGuarded(
    CMD_DANCE_GET_REWARD,
    { targetUidStr: pid },
    {
      protocol: 'sendPBV2',
      gate: false,
      onError: function (err) {
        log.warn('cmd 2503 send threw: %s', err && err.message);
        threw = true;
      },
    },
  );
  if (threw) return;
  if (!aliveFn()) return;
  if (!ret || !ret.ok) {
    // 可预期的业务拒（射程/名额/次数）走 info，不刷 warn；随即当日拉黑，一个实例只撞一次墙
    var raw = String((ret && ret.data) == null ? '' : ret.data).trim();
    log.info(
      'claim rejected. pid=%s;inst=%s;code=%s;reason=%s',
      pid,
      instId,
      ret && ret.code,
      raw ? l10n.net(raw) : '',
    );
    if (ret && ret.code !== CODE_NOT_SENT) markBlacklist(instId);
    return;
  }
  // 记账：镜像先行（10053 权威推送随后覆盖），同实例当日不再重发；计数按宝箱道具归位
  var boxKey = String(cr.itemId);
  todayByItem[boxKey] = (todayByItem[boxKey] || 0) + 1;
  if (mirrorInstIds.indexOf(instId) < 0) mirrorInstIds.push(instId);
  markBlacklist(instId);
  persistMirror();
  var d = safeParse(ret.data) || {};
  var items = (d.rewardResult && d.rewardResult.items) || [];
  log.info(
    'box claimed. pid=%s;inst=%s;itemId=%s;today=%d/%d;items=%s',
    pid,
    instId,
    boxKey,
    claimedByItem(boxKey),
    dailyLimitOf(boxKey),
    items
      .map(function (i) {
        return i.itemId + 'x' + i.itemCount;
      })
      .join(','),
  );
}

/**
 * 只读探测失败后的回填重试（同一候选最多 CLAIM_RETRY_MAX 次）。
 * 只回填「结论可翻转」的早退（901 未成功 / 窗内未命中该城 / 2503 在途）；已领、过期、名额满、被拒、
 * 以及 `no-reward`（城在场就是没宝箱）这类当日确定结论不回填。
 * @param {{key:string,pid:string,x:number,y:number,sid:number,src:string,attempts:number}} cand 刚出队的候选
 * @returns {boolean} 是否已重新入队
 */
function requeue(cand) {
  if (!cand || !aliveFn()) return false;
  if ((cand.attempts || 0) >= CLAIM_RETRY_MAX || queue.length >= QUEUE_MAX) return false;
  cand.attempts = (cand.attempts || 0) + 1;
  queuedKeys.add(cand.key);
  queue.push(cand);
  log.debug('candidate retry queued. key=%s;attempt=%d', cand.key, cand.attempts);
  return true;
}

/**
 * 从队列取下一个仍有效的候选（已领/拉黑的就地丢弃）
 * @returns {{key:string,pid:string,x:number,y:number,sid:number,src:string,attempts:number}|null}
 */
function nextCandidate() {
  while (queue.length) {
    var cand = queue.shift();
    if (cand) queuedKeys.delete(cand.key);
    // pid 可以为空（活动分享卡只给坐标），定位时由 901 反查
    if (cand && cand.key) return cand;
  }
  return null;
}

// ── 主流程 ────────────────────────────────────────────────────────────
/** cycle 单轮：日切复位 → 全族封顶即睡到日切 → 否则排空一个候选；next-check 日志由 cycle 驱动器统一输出。 */
async function cycleRun() {
  rollDayIfNeeded();
  // 长睡判据必须是「全族皆满」：逐道具限额下，某一个道具撞顶不代表其他道具不能领
  if (allItemsCapped()) {
    log.info('all party items capped today (claims=%d), sleep till day roll.', claimedCount());
    return dayRollDelay();
  }
  var cand = nextCandidate();
  if (!cand) return IDLE_TICK_MS; // 静默期零发包：候选一律由 push 10018 / 聊天卡喂进来
  await claimOne(cand);
  if (!aliveFn()) return 0;
  return queue.length ? DRAIN_TICK_MS : IDLE_TICK_MS;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 本 feat 硬依赖的 ACL/底座成员（install 期自检）。
 * 把成员挂错了对象（实证：误写 `gameData.serverId()`，而该函数在 `worldMap` 上）静态检查看不出来，
 * 运行期则是「每一拍 cycle 抛 TypeError + 只在 warn 里一闪而过」，面板上看得见启用但实际一条包都不发。
 * 故拿不到就直拒安装（fail fast），不拿一个必碎的链路去跑整天。
 * @type {Array<[string,*]>}
 */
const HARD_DEPS = [
  ['gameData.serverTime', gameData && gameData.serverTime],
  ['gameData.maskDanceState', gameData && gameData.maskDanceState],
  ['worldMap.serverId', worldMap && worldMap.serverId],
  ['l10n.tableRowByKey', l10n && l10n.tableRowByKey],
  ['bits.int64Str', bits && bits.int64Str],
  ['map.fetchWindow', map && map.fetchWindow],
];

/**
 * 安装：自检 ACL 成员 → 取网络底座。任一缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  var missing = [];
  for (var d of HARD_DEPS) {
    if (typeof d[1] !== 'function') missing.push(d[0]);
  }
  if (missing.length) {
    log.warn('install failed: ACL member unavailable (%s)', missing.join(', '));
    return false;
  }
  net = ctx.net;
  if (
    !net ||
    !net.install() ||
    typeof net.sendPBV2 !== 'function' ||
    typeof net.isSending !== 'function'
  ) {
    log.warn('install failed: pocketcc.net unavailable (sendPBV2/isSending)');
    net = null;
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * 激活：订阅瓦片/用户态推送与聊天卡 → 读回今日镜像 → 起一拍。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  queue = [];
  queuedKeys.clear();
  ctx.on.push(PUSH_TILEINFO, onTilePush);
  ctx.on.push(PUSH_USER_DATA_COMMON, onUserDataPush);
  ctx.on.chat('push', function (p) {
    onMessages('push', p);
  });
  log.info('started. uid=%s;items=%d', String(getUid() || ''), Object.keys(boxItemIds).length);
  // 镜像读回后才起循环：未读回时 todayByItem 仍是空表，会把「重启前已领 N 次」误当没领而超发
  loadMirror().then(function () {
    if (aliveFn()) cycle.kick();
  });
}

/**
 * 暂停：清空待排空队列（cycle 睡到点会自行判 alive() 终止，不重建定时器；reactor resume 走 run() 重 kick，
 * 队列一律由推送重新喂，不保留陈旧快照以免 resume 后拿旧坐标发写请求）。
 */
function pause() {
  queue = [];
  queuedKeys.clear();
  mirrorLoaded = false; // resume 重走 run() 重新读回，不拿陈旧镜像去判限额
  log.debug('paused.');
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（901/2503 都在世界图语境）、
 * kinds 只放行本服（舞会是本联盟本服玩法）；不派兵但占网络，战斗模式让位。
 * 日常活动形态——面板出启用开关 + 一行只读当日进度（inlineStatus）：
 * 当日次数口径（定稿）：额度类读权威——分子=逐道具 max(danceRec 权威, 镜像) 求和（claimedCount，含手动）。
 * 无分母：游戏限额是逐道具口径（daily_limit 逐条独立），全局求和会编造总上限（用户否决 80 口径），
 * 故一律显示「今日 N 次」。
 */
reactor.register({
  id: 'maskDance',
  label: '假面舞会',
  storageKey: 'pocketcc.feat.maskDance',
  symbols: ['dataCenter', 'tableManager', 'localManager'],
  kinds: ['homeland'],
  places: ['base', 'world'],
  offInCombat: true,
  defaults: { enabled: false },
  fields: [
    {
      key: '_danceInfo',
      type: 'text',
      label: '今日',
      get: function () {
        // 权威与镜像都拿不到时不谎报 0（登录期是否全量下发未实证，见 maskDanceState 注释）
        if (!mirrorLoaded && !gameData.maskDanceState()) return '—';
        // 无分母：限额逐道具口径，daily_limit 全局求和是编造的总上限（见 register 注释）
        return dailyText(claimedCount());
      },
    },
  ],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
  pause: pause,
});
