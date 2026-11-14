/**
 * CQ26 印石·巨兽盛宴三腿自动化（cq26Feast）
 *
 * 玩法：BWL（巨兽盛宴）线阶段机 push 22032：NONE(0)→GATHER(1)→FEED(2)→SHOW(3)→END(4)。
 *   FEED 期领盛宴礼盒（2106，0-9 共 10 箱，需已加入派系）；
 *   巨熊宝藏（2108，协议 SECRET_GIFT，旧称「密礼」）倒计时结束（endtime≤服务器秒）即按 id 抢（日上限配置 52000078）；
 *   它是 10 槽共享抢夺（310 地块 playerList 累积至 10、curPower/maxPower=10），槽满即从 22064 快照清除、再领 s=3，故到点要快；
 *   候选来自 22064 全局快照（大世界亦达，游戏 CQ26BeastSecretGiftWorldUIIcon 同源），整体替换与游戏 updateSecretGiftList 一致；
 *   领取只发 {id,received:true} 无坐标，无需站在盛宴图/盯视口（同礼盒跨图）。领取前可知礼品内容
 *   （310 地块 m.rewardItemId，经 RewardController 解成物品组），可选物品白名单只领含指定物品的巨熊宝藏；BWL 奖励宝箱（2104）是
 *   BWL 线宝箱（315 地块 specIndex=0），与 NWL 遗失之箱**共享 remainChestNum 日额度**（22072 权威）。
 *   融冰（2103）由玩家手动，本 feat 不再管；急速解冻（2129，原「摇一摇」）已拆出为独立 feat（ice-shake.js，挂基础设置组）。
 *
 * 协议清单（报文实证 dashcam rec 11981629951662 / dashcam-rec-20261109T205818-印石-我的日常.ndjson）：
 *   2104 BWL_GET_CHEST       req `{x,y}` → resp `{rewardResult}`（**本录零样本**，形态按源码 CQ26WLWorldRewardBoxPop）
 *   2105 BWL_OPENED_CHEST_LIST req `{}` → resp `{posList:[{x,y}]}`（1 发，空表）
 *   2106 FEAST_GET_GIFT      req `{pointIndex:0-9}` → resp 空体（header.s===0 即成功，18 发）；发奖明细走 22075
 *   2108 SECRET_GIFT         req `{id:Int64,received:true}` → resp `{id,rewardId,playerInfo,record}`（12 发）
 *   22032 push `{feastPhase:{state,gatherTime,beginTime,endTime,displayEndTime}}`（4 条，GATHER 窗 300s）
 *   22064 push `{gift:[{id:Int64,pos:{x,y,k},endtime}]}` 巨熊宝藏倒计时态全局快照（41 条，含空表；礼物 endtime 前 ~32s 出现、槽满即清除，整体替换=权威）
 *   22073 push `{player:{giftCount,blue,feedCount,claimedIndexList,secretGiftCount}}`（25 条）
 *   22075 push `{pointIndex,blue,claimedIndexList,rewardResult:{items,…}}` 礼盒发奖（10 条）
 *   22072 push 额度权威 `remainChestNum`（与 wl-chest 同源；BWL/NWL 共享，源码 onClickGetReward 两分支都查它）
 *   901 resp / 10018 push：315 地块 `m.{specIndex,leftTimes,expireTime,initSid,…}`（剩余次数实证拼写 leftTimes；另留 lefftTimes 防御回落，本录/源码均未见）
 *     + 310 巨熊宝藏地块 `m.{id:Int64,rewardItemId,endTime,curPower,maxPower,initSid}`（id 与 22064 gift.id 同源，按十进制串关联；
 *       rewardItemId 实录 5 种 52082911~52082915，2108 resp receiveReward 实证其物品组）
 *
 * 闸门（每腿按序短路，每个 skip 出口一条 debug 带上下文）：
 *   礼盒：cq26IsOpen → phase===FEED → faction 非 0（null=未知跳过；0=未加入派系 info 一条后停腿，不代选）
 *     → 玩家快照在场 → claimed（投影∪22073/22075∪乐观）有未领 idx → 每拍一发。
 *     忙碌状态闸：刚领过→投喂中（feedCount 未超基线）等喂完再领；beast_busy 被拒（他人投喂）退避不拉黑。
 *   巨熊宝藏：cq26IsOpen → 日上限配置可读 → secretGiftCount<cap → 快照内 endtime≤now≤endtime+600s 且未领（到点即抢，10 槽共享）
 *     → 物品白名单（空=全领；非空只领含勾选物品的巨熊宝藏，310 地块缺失/解析不到 fail-closed 跳过）→ Int64 装箱往返自校验
 *     → 每拍一发。**不做阶段闸**（源码点击处理只查 endtime/额度/playerList）。
 *   奖励宝箱：cq26IsOpen → originSid 可知 → cq26WlInfo() 三态（null 跳过/0 睡到日界）→ 乐观额度 → 2105 已开表（每日一读）
 *     → 逐点（specIndex=0、本服、未过期、leftTimes>0、未开、未拉黑）→ 每拍一发。
 *
 * 纪律：三腿串行、每腿每拍至多一发写（sendGuarded 在途闸）；日界滚清（服务器日 todayStr）；
 *   逐目标被拒冷却 5min、连续 3 次当日拉黑；与 wl-chest **不做中央额度账本**（项目既有「抢占式、服务器权威」
 *   决策：双方各自每拍读 22072、串行出网，极端并发下服务器拒绝一方按可预期业务拒绝 info 处理）。
 *
 * 导出面：协议号/配置号/阈值常量 + 全部决策纯函数，供单测（tests/feats/cq26-feast.test.js）与
 *   replay 对拍（scripts/verify-manifests/cq26-feast.mjs）复用同一份字典，判据不另抄。
 *
 * 刻意不做：不代选派系、不发 2455 技能、不做排行查询、不动镜头、不派兵（三动作均不占行军名额）；
 *   不主动扫全图（宝箱候选纯被动嗅探，unknown 箱才定向 901 重验）。
 */
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { gameData, gameConf, bits, worldMap } from '../../../core/game-api.js';
import { item } from '../../../core/item.js';
import { createCycle } from '../../../core/cycle.js';
import { fetchWindow } from '../../../core/map.js';
import { CODE_NOT_SENT, rejectText, todayStr } from '../../../core/util.js';

import {
  CMD_GET_CHEST,
  CMD_OPENED_LIST,
  CMD_GET_GIFT,
  CMD_SECRET_GIFT,
  PUSH_PHASE,
  PUSH_SECRET,
  PUSH_PLAYER,
  PUSH_GIFT_REWARD,
  PUSH_WL_INFO,
  PUSH_TILE,
  CMD_WORLD_INFO,
} from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-FEAST');

// ── 常量 ──────────────────────────────────────────────────────────────
/** 功能 id（register / aliveFn / 日志共用一处字面量） */
const FEAT_ID = 'cq26Feast';
/** NWorldMapEntityType.CQ_26_WL_REWARD_BOX = 315（BWL/NWL 宝箱共用地块类型，按 specIndex 分线） */
const POINT_TYPE_CHEST = 315;
/** 巨熊宝藏世界地块点型 = 310（m.rewardItemId 是领取前可见的礼品配置 id；m.id 与 22064 gift.id 同源） */
const POINT_TYPE_SECRET = 310;
/** CQ26BeastFeastPhase.GATHER：集结期（cycle 活跃档判据之一；融冰已迁出本 feat） */
const PHASE_GATHER = 1;
/** CQ26BeastFeastPhase.FEED：礼盒唯一窗口 */
const PHASE_FEED = 2;
/** 礼盒点位总数（idx 0..9，源码 claim 循环与实录 claimedIndexList 满集 [0..9] 互证） */
const GIFT_COUNT = 10;
/** 巨熊宝藏领取时钟余量（秒）：0=到点（endtime≤服务器秒）即抢，与游戏点击闸 endTime≤ServerTime 同口径
 *  （feat 直接读 DATA.ServerTime，与游戏同一时钟，无客户端录制 ts 的 skew）。实证 dashcam-rec-20261109T205818 /
 *  20261113T224228：礼物 endtime 前 ~32-37s 出现，10 槽共享抢夺（310 playerList 0→10、maxPower=10），真人成功领取
 *  集中在 endtime 当口；槽满即从 22064 快照清除、再领 s=3，故不留余量、到点即抢。 */
const SECRET_GRACE_SEC = 0;
/** 巨熊宝藏过期闸（秒）：endtime+600s 后不再尝试（快照未刷新的陈旧条目防误发；正常槽满即被快照清除） */
const SECRET_TTL_SEC = 600;
/** 配置：巨熊宝藏日上限（实录 5） */
const CFG_SECRET_CAP = 52000078;
/** 巨熊宝藏礼品配置 id 全集（实录 5 种礼包 52082911~52082915；面板候选池据此解析，过滤本身按地块 rewardItemId 不钉死此表） */
const SECRET_REWARD_IDS = [52082911, 52082912, 52082913, 52082914, 52082915];
/** 定向 901 窗宽（照抄游戏跳图那一发的实录 {width:18,height:30,viewLevel:0}） */
const PROBE_W = 18;
/** 定向 901 窗高 */
const PROBE_H = 30;
/** 定向 901 视口层级（0=最近·全量，315/310 行只在此层级稳定下发） */
const PROBE_VIEW_LEVEL = 0;
/** 宝箱地块 TTL（毫秒）：leftTimes 是别人的消耗，不宜信太久前的快照（同 wl-chest） */
const TILE_TTL_MS = 5 * 60 * 1000;
/** 定向查询「窗里没找到目标」后的重试冷却（毫秒） */
const MISS_COOL_MS = 10 * 60 * 1000;
/** 同一目标连续被拒达此次数即当日拉黑 */
const MAX_REJECT = 3;
/** 单次被拒后的冷却毫秒 */
const REJECT_COOL_MS = 5 * 60 * 1000;
/** 礼盒投喂完成等待的兜底 TTL（毫秒）：2106 成功后置投喂闸，正常由 22073 feedCount 超基线提前清；
 *  超此仍未喂完（推送丢失/投喂上限）fail-open 放行再试，不至永挂 */
const GIFT_FEED_TTL_MS = 60 * 1000;
/** beast_busy 被拒（多因他人投喂/领奖竞争）的 reactive 退避毫秒：不拉黑、不计 streak，歇一阵再试
 *  （busy 窗实录 ~15-25s，5s 连重试会频繁弹「冰魄之灵正在忙碌中」） */
const GIFT_BUSY_BACKOFF_MS = 20 * 1000;
/** 2106 拒绝载荷 header.d「巨兽忙」文案键（sendPBV2 拒因落 ret.reason；瞬时态，非目标无效，同 auto-farm ERR_HERO_BUSY 口径） */
const ERR_BEAST_BUSY = 'series_frost_feast_tips_beast_busy';
/** 乐观额度扣减的寿命（毫秒）：超此仍未被 22072 回抵 ⇒ 当推送丢了，不再计入（同 wl-chest） */
const OPT_DEBT_TTL_MS = 10 * 1000;
/** 阶段号 → 面板展示名 */
const PHASE_LABELS = { 0: '未开始', 1: '集结', 2: '投喂', 3: '展示', 4: '结束' };

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {object} 运行时配置（configure 灌入） */
var MCFG = buildDefaults();
/** @type {boolean} 定向 901 在途（宝箱腿探针，同刻至多一发） */
var probeInFlight = false;
/** @type {Object<string,number>} 箱键 → 上次「窗里没找到」时刻 */
var missAt = Object.create(null);
/** @type {Set<number>} 礼盒已领权威集（22073/22075/投影整体替换） */
var claimedAuth = new Set();
/** @type {Set<number>} 礼盒已领乐观集（2106 成功即加，权威到达后剪枝、日界滚清） */
var claimedOpt = new Set();
/** @type {object|null} 22073 player 的同帧标量副本 */
var playerSnap = null;
/** @type {string} faction=0 的 info 去重日键（每日一条，不刷屏） */
var factionNoWarnDay = '';
/** @type {Map<string,{idStr:string,x:number,y:number,k:number,endtime:number,atMs:number}>}
 *  巨熊宝藏表（22064 全局快照整体替换，与游戏 updateSecretGiftList 一致；槽满即清除，不保留已抢空条目；
 *  键=十进制串 id，19 位雪花绝不经 Number。详见 buildSecretTable） */
var secretGifts = new Map();
/** @type {Set<string>} 巨熊宝藏已领乐观集（idStr；领成功即入集、日界滚清；pickSecrets 据此挡重发） */
var claimedSecret = new Set();
/** @type {Object<string,{idStr:string,rewardItemId:number,endTime:number,x:number,y:number,k:number,atMs:number}>}
 *  巨熊宝藏地块缓存（键=十进制串 id，与 secretGifts 同键；只由 901/10018 的 310 行写入，供白名单解析礼品内容） */
var secretTiles = Object.create(null);
/** @type {boolean} 「Int64 装箱不可靠」warn 去重（恢复后复位） */
var boxDegradedWarned = false;
/** @type {Object<string,{x:number,y:number,k:number,specIndex:number,leftTimes:number,expireTime:number,initSid:number,atMs:number}>}
 *  宝箱地块缓存（键 x_y；只由 901/10018 的 315 行写入） */
var chestTiles = Object.create(null);
/** @type {Set<string>} 已开权威集（2105 posList，每日一读） */
var openedAuth = new Set();
/** @type {Set<string>} 已开乐观集（2104 成功即加，日界滚清） */
var openedOpt = new Set();
/** @type {string} 2105 已读表的服务器日键（换日重读） */
var openedLoadedDay = '';
/** @type {number} 尚未被 22072 回抵的成功开箱数（乐观收紧额度，同 wl-chest） */
var localSpent = 0;
/** @type {number} 最后一笔乐观扣减的记账时刻 */
var localSpentAt = 0;
/** @type {number|null} 上一条 22072 的 remainChestNum（求增量回抵） */
var lastSnapRemain = null;
/** @type {object|null} 22032 feastPhase 的同帧标量副本 */
var phaseSnap = null;
/** @type {Object<string,number>} 目标键（i:/c:/g:/s: 前缀）→ 连续被拒次数 */
var rejectCount = Object.create(null);
/** @type {Object<string,number>} 目标键 → 冷却到期时刻（Date.now() 基准） */
var coolUntil = Object.create(null);
/** @type {string} 上三表所属服务器日（换日清空，使「当日拉黑」真止于当日） */
var dayKey = '';
/** @type {boolean} 本拍是否有腿成功出网（决定 chainMs 续发） */
var justActed = false;
/** @type {boolean} 礼盒投喂进行中闸：2106 成功即置位（刚领→巨兽必在吃/311 行军投喂中），feedCount 超基线即清 */
var giftFeedPending = false;
/** @type {number} 置位投喂闸时的 feedCount 基线；22073 feedCount 超此值＝本次投喂完成（权威信号，相对增量免竞态） */
var giftFeedBase = 0;
/** @type {number} 投喂闸置位时刻（ms）：超 GIFT_FEED_TTL_MS 仍未喂完 fail-open 放行 */
var giftFeedSince = 0;
/** @type {number} 巨兽忙 reactive 退避到期时刻（ms）：beast_busy 被拒（多为他人投喂）短歇，不拉黑 */
var giftBusyUntil = 0;
/** @type {boolean} 本拍是否存在候选/探针工作（决定 activeMs 档） */
var hadCandidate = false;
/** @type {boolean} 宝箱额度权威见底（决定睡到日界线） */
var chestQuotaZero = false;
/** @type {number} 最近一枚未熟巨熊宝藏的 endtime+余量（服务器秒；0=无，决定择时唤醒） */
var nextSecretSec = 0;
/** @type {boolean} 「额度快照不可得」debug 去重 */
var noSnapshotWarned = false;
/** @type {boolean} 「巨熊宝藏上限配置不可读」warn 去重 */
var secretCapWarned = false;
/** @type {number} 本场成功开奖励宝箱数（面板状态用） */
var chestOpenedCount = 0;

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
 * 运行：从投影播种各快照基线 + 订阅七路推送/应答，然后点火（退订由 reactor 托管）。
 * 刻意不在此清 rejectCount/coolUntil/乐观集：places/kinds 门控会反复 pause→run，
 *   清零等于给服务器永久拒绝的目标无限续命；「当日」语义由 rolloverState 收。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  var seed = gameData.cq26WlInfo();
  lastSnapRemain = seed && seed.remainChestNum != null ? Number(seed.remainChestNum) : null;
  var pl = gameData.cq26FeastPlayer();
  if (pl) {
    playerSnap = pl;
    claimedAuth = new Set(pl.claimedIndexList);
  }
  var fp = gameData.cq26FeastPhase();
  if (fp) phaseSnap = fp;
  ctx.on.push(PUSH_PHASE, onPhasePush);
  ctx.on.push(PUSH_SECRET, onSecretPush);
  ctx.on.push(PUSH_PLAYER, onPlayerPush);
  ctx.on.push(PUSH_GIFT_REWARD, onGiftRewardPush);
  ctx.on.push(PUSH_WL_INFO, onWlInfoPush);
  ctx.on.push(PUSH_TILE, onTileInfo);
  // 游戏自己视口请求的应答也走同一条 dispatch：被动嗅探 315/310 地块，零额外报文
  ctx.on.resp(CMD_WORLD_INFO, onTileInfo);
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉全部「可重放读通道」的缓存，避免 resume 后拿陈旧快照发写请求。
 * cycle 自重排由 alive() 自守，push 退订由 reactor 托管；本模块无自建定时器。
 */
function pause() {
  chestTiles = Object.create(null);
  secretTiles = Object.create(null);
  secretGifts = new Map();
  phaseSnap = null;
  playerSnap = null;
  probeInFlight = false;
  giftFeedPending = false;
  giftBusyUntil = 0;
}

/**
 * 存活判定（cycle 与所有 await 之后的记账都过这一闸）。
 * @returns {boolean}
 */
function aliveFn() {
  return reactor.isRunning(FEAT_ID);
}

// ── 推送/应答入口 ─────────────────────────────────────────────────────
/**
 * PBV2 报文取业务体：整包 {header,data} 下钻一层；平铺载荷（901 应答/旧 JSON）原样回落。
 * @param {object} ev bus 事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o.data || o;
}

/** 22032：阶段机快照（同帧拆标量副本；报文对象池化复用，不得存引用） */
function onPhasePush(ev) {
  var b = pushBody(ev);
  var fp = b && b.feastPhase;
  if (!fp || typeof fp !== 'object') {
    log.warn('22032 malformed (no feastPhase).');
    return;
  }
  phaseSnap = {
    state: Number(fp.state) || 0,
    gatherTime: bits.int64ToNum(fp.gatherTime),
    beginTime: bits.int64ToNum(fp.beginTime),
    endTime: bits.int64ToNum(fp.endTime),
    displayEndTime: bits.int64ToNum(fp.displayEndTime),
  };
  log.debug('22032 phase=%d', phaseSnap.state);
  if (aliveFn()) cycle.kick();
}

/** 22064：巨熊宝藏倒计时态全局快照 → 整体替换本地表（权威；槽满即清除，详见 buildSecretTable） */
function onSecretPush(ev) {
  var b = pushBody(ev);
  var list = b && b.gift;
  if (!Array.isArray(list)) {
    log.warn('22064 malformed (no gift array).');
    return;
  }
  secretGifts = buildSecretTable(list, Date.now());
  log.debug('22064 snapshot. gifts=%d', secretGifts.size);
  if (aliveFn()) cycle.kick();
}

/** 22073：玩家快照 → 额度/已领权威（claimedIndexList 是满集，整体替换后剪枝乐观集） */
function onPlayerPush(ev) {
  var b = pushBody(ev);
  var pl = b && b.player;
  if (!pl || typeof pl !== 'object') {
    log.warn('22073 malformed (no player).');
    return;
  }
  playerSnap = {
    giftCount: Number(pl.giftCount) || 0,
    blue: Number(pl.blue) || 0,
    feedCount: Number(pl.feedCount) || 0,
    claimedIndexList: Array.isArray(pl.claimedIndexList)
      ? pl.claimedIndexList.map(function (v) {
          return Number(v) || 0;
        })
      : [],
    secretGiftCount: Number(pl.secretGiftCount) || 0,
  };
  claimedAuth = new Set(playerSnap.claimedIndexList);
  pruneClaimedOpt();
  // 投喂完成权威信号：feedCount 超基线＝刚领的礼盒喂完了→巨兽空闲，清投喂闸（下方 kick 唤醒领下一箱）
  if (giftFeedPending && playerSnap.feedCount > giftFeedBase) {
    giftFeedPending = false;
    log.debug('2106 feeding done. feed=%d base=%d', playerSnap.feedCount, giftFeedBase);
  }
  log.debug('22073 player. claimed=%d secret=%d', claimedAuth.size, playerSnap.secretGiftCount);
  if (aliveFn()) cycle.kick();
}

/** 22075：礼盒发奖明细（rewardResult.items 才是奖励本体；claimedIndexList 同为满集权威） */
function onGiftRewardPush(ev) {
  var b = pushBody(ev);
  if (!b || b.pointIndex == null) {
    log.warn('22075 malformed (no pointIndex).');
    return;
  }
  if (Array.isArray(b.claimedIndexList)) {
    claimedAuth = new Set(
      b.claimedIndexList.map(function (v) {
        return Number(v) || 0;
      }),
    );
    pruneClaimedOpt();
  }
  var rr = b.rewardResult || {};
  var items = Array.isArray(rr.items) ? rr.items : [];
  var got = items
    .map(function (it) {
      return item.label(it.itemId) + '×' + (Number(it.itemCount) || 0);
    })
    .join(', ');
  log.info(
    '22075 gift reward. idx=%d blue=%d → %s',
    Number(b.pointIndex),
    Number(b.blue) || 0,
    got || 'empty reward',
  );
  if (aliveFn()) cycle.kick();
}

/**
 * 22072：额度快照（唯一权威）→ 按增量回抵乐观扣减 + 唤醒。
 * 持平的推送不清账（同包里别的字段变了不带额度信息，抹掉在途那笔就会多撞一条被拒）。
 */
function onWlInfoPush(ev) {
  var b = pushBody(ev);
  var v = b ? b.remainChestNum : null;
  var raw = v == null || v === '' ? NaN : Number(v);
  var r = Number.isFinite(raw) ? raw : null;
  if (r != null) {
    localSpent = cancelQuotaDebt(localSpent, lastSnapRemain, r);
    lastSnapRemain = r;
  }
  noSnapshotWarned = false;
  if (aliveFn()) cycle.kick();
}

/**
 * 901 应答 / 10018 推送 → 315 行并入宝箱地块缓存 + 310 行并入巨熊宝藏地块缓存。
 * 两条通道的行形状一致，共用一个 ingest。
 * @param {object} ev bus 事件
 */
function onTileInfo(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var nowMs = Date.now();
  var n = 0;
  var list = Array.isArray(b.pointList) ? b.pointList : b.pointInfos;
  if (Array.isArray(list)) {
    n += ingestChestTiles(list, chestTiles, nowMs);
    n += ingestSecretTiles(list, secretTiles, nowMs);
  }
  if (n && aliveFn()) cycle.kick();
}

// ── 纯函数层（单测与 replay 对拍共用，判据不另起炉灶）────────────────────

/**
 * 纯函数：礼盒已领合并（权威 ∪ 乐观，产出新 Set，不改入参）。
 * @param {Set<number>|number[]|null} auth 权威集（投影/22073/22075）
 * @param {Set<number>|number[]|null} opt 乐观集
 * @returns {Set<number>}
 */
export function mergeClaimed(auth, opt) {
  var out = new Set();
  var srcs = [auth, opt];
  for (var s = 0; s < srcs.length; s++) {
    var src = srcs[s];
    if (!src) continue;
    var arr = src instanceof Set ? Array.from(src) : Array.isArray(src) ? src : [];
    for (var i = 0; i < arr.length; i++) {
      var n = Number(arr[i]);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

/**
 * 纯函数：0..9 里第一个未领的礼盒点位（全领回 -1）。
 * @param {Set<number>|number[]} claimed 已领合并集
 * @returns {number}
 */
export function pickGiftIndex(claimed) {
  var s = claimed instanceof Set ? claimed : new Set(claimed || []);
  for (var i = 0; i < GIFT_COUNT; i++) if (!s.has(i)) return i;
  return -1;
}

/**
 * 纯函数：礼盒腿忙碌状态闸判据（实证「领奖中/投喂中/活动行军队列进行中都得等」，硬发会频弹「冰魄之灵正在忙碌中」）。
 * 投喂中（pending）以 feedCount 超基线为「投喂完成」权威信号（相对增量免 giftCount 滞后竞态）；
 * 超 GIFT_FEED_TTL_MS 仍未喂完（推送丢/上限）fail-open；beast_busy reactive 退避中亦等。不拉黑（点位有效）。
 * @param {number} nowMs 当前本地时刻（ms）
 * @param {boolean} pending 投喂闸是否置位（2106 成功后置位）
 * @param {number} since 投喂闸置位时刻（ms）
 * @param {number} feedCount 当前 22073 feedCount
 * @param {number} base 置位时 feedCount 基线
 * @param {number} busyUntil beast_busy reactive 退避到期时刻（ms）
 * @returns {string} ''=可领；'feeding'=投喂中；'backoff'=忙碌退避中
 */
export function giftGateWait(nowMs, pending, since, feedCount, base, busyUntil) {
  if (pending) {
    if (feedCount > base) return '';
    if (nowMs - since < GIFT_FEED_TTL_MS) return 'feeding';
    return '';
  }
  if (nowMs < busyUntil) return 'backoff';
  return '';
}

/**
 * 纯函数：巨熊宝藏行读 Int64 id（两种形态都吃：Long 实例 → int64Str；裸 {_low,_high} → int64Decimal
 * 用 BigInt 拼装，19 位雪花全程不经 Number；同 ice-shake readMiniGameId 口径）。
 * @param {object|null} g 22064 gift 行
 * @returns {string} 十进制串；无 id/形态异常/0 回空串
 */
export function readGiftId(g) {
  if (!g || typeof g !== 'object') return '';
  var v = g.id;
  if (v == null) return '';
  var s = bits.int64Str(v);
  if (!/^\d+$/.test(s)) s = bits.int64Decimal(v);
  if (!/^\d+$/.test(s) || s === '0') return '';
  return s;
}

/**
 * 纯函数：巨熊宝藏到点判定（endtime≤now≤endtime+600s TTL；余量 SECRET_GRACE_SEC=0 到点即抢）。
 * 与游戏点击闸 endTime≤ServerTime 同口径；10 槽共享抢夺，晚发槽被抢空→s=3，故不留余量（实证见常量注释）。
 * @param {object|null} g 巨熊宝藏行（含 endtime 服务器秒）
 * @param {number} nowSec 服务器秒（<=0 = 无从判定）
 * @returns {boolean}
 */
export function secretReady(g, nowSec) {
  if (!g || !(Number(g.endtime) > 0) || !(nowSec > 0)) return false;
  var end = Number(g.endtime);
  return nowSec >= end + SECRET_GRACE_SEC && nowSec <= end + SECRET_TTL_SEC;
}

/**
 * 纯函数：巨熊宝藏表 → 本轮可领队列（endtime 升序，先到先领；已领/未熟/过期不入队）。
 * @param {Map<string,object>|object} giftMap 巨熊宝藏表
 * @param {object} g 闸门入参
 * @param {number} g.nowSec 服务器秒
 * @param {Set<string>|string[]} g.claimed 已领乐观集
 * @returns {Array<object>}
 */
export function pickSecrets(giftMap, g) {
  var o = g || {};
  var claimed = o.claimed instanceof Set ? o.claimed : new Set(o.claimed || []);
  var rows = giftMap instanceof Map ? Array.from(giftMap.values()) : Object.values(giftMap || {});
  var ready = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || claimed.has(r.idStr)) continue;
    if (!secretReady(r, o.nowSec)) continue;
    ready.push(r);
  }
  ready.sort(function (a, b) {
    return a.endtime - b.endtime;
  });
  return ready;
}

/**
 * 纯函数：22064 全局快照 gift 行 → 巨熊宝藏表（整体替换，与游戏 updateSecretGiftList 的 `_secretGiftList = n` 一致）。
 * 巨熊宝藏（2108）是 10 槽共享抢夺：快照只列仍有空槽的礼物，槽满即从快照清除（再领 s=3）。故整体替换=权威，
 *   不保留已清除条目（保留只会对已抢空的礼物空发 s=3）。22064 全局推送（大世界亦达，游戏 CQ26BeastSecretGiftWorldUIIcon
 *   同源），到点按 id 领即可（同礼盒 pointIndex 跨图），无需站在盛宴图/盯视口；310 地块只供白名单解析礼品内容。
 * 实证 dashcam-rec-20261109T205818：礼物 endtime 前 ~32s 出现，成功领取全在 endtime 当口且仍在快照内，槽满清除后领→s=3。
 * @param {Array<object>} list 22064 快照 gift 行（{id:Int64,pos:{x,y,k},endtime}）
 * @param {number} nowMs Date.now() 基准（atMs 戳）
 * @returns {Map<string,object>} 新表（键=十进制串 id，19 位雪花不经 Number）
 */
export function buildSecretTable(list, nowMs) {
  var out = new Map();
  var rows = Array.isArray(list) ? list : [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var idStr = readGiftId(r);
    if (!idStr) continue;
    var pos = (r && r.pos) || {};
    out.set(idStr, {
      idStr: idStr,
      x: Number(pos.x) || 0,
      y: Number(pos.y) || 0,
      k: Number(pos.k) || 0,
      endtime: Number(r.endtime) || 0,
      atMs: nowMs,
    });
  }
  return out;
}

/**
 * 纯函数：礼品物品组是否命中白名单（任一 .id 在 wlSet 即 true）。
 * 匹配走 itemId（.id）；rewardItems().name 是未翻译 loc 键，不参与匹配。空白名单恒 false（全领由调用方早退处理）。
 * @param {Array<{id:number}>|null} items gameData.rewardItems(rewardItemId) 产出
 * @param {Set<number>|null} wlSet 物品白名单（itemId 数集）
 * @returns {boolean}
 */
export function secretRewardHit(items, wlSet) {
  if (!wlSet || wlSet.size === 0) return false;
  for (var i = 0; i < (items || []).length; i++) {
    var id = Number(items[i] && items[i].id) || 0;
    if (id > 0 && wlSet.has(id)) return true;
  }
  return false;
}

/**
 * 纯函数：到点巨熊宝藏队列 → 按物品白名单过滤（默认全领；fail-closed）。
 * 白名单空 → 原样返回（kept=全部，skipped=空，向后兼容「到点就领」）；非空 → 逐个查 310 地块拿 rewardItemId
 *   再 resolve 成物品组：地块缺失（no-tile，视口外）/解析为空（no-resolve，RewardController 不可用）/不命中（no-hit）一律跳过。
 * resolve 注入（运行时=gameData.rewardItems）保纯函数可测；kept 保持入参 endtime 升序。
 * @param {Array<object>} ready pickSecrets 产出的到点队列
 * @param {Object<string,{rewardItemId:number}>|Map<string,object>} tileMap 310 地块缓存（键 idStr）
 * @param {function(number):Array<{id:number}>} resolve 奖励配置 id → 物品组
 * @param {Set<number>|number[]|null} whitelist 物品白名单
 * @returns {{kept:Array<object>, skipped:Array<{idStr:string,reason:string}>}}
 */
export function filterSecretsByItems(ready, tileMap, resolve, whitelist) {
  var wl = whitelist instanceof Set ? whitelist : new Set(whitelist || []);
  var list = ready || [];
  if (wl.size === 0) return { kept: list.slice(), skipped: [] };
  var kept = [];
  var skipped = [];
  for (var i = 0; i < list.length; i++) {
    var g = list[i];
    var t = tileMap instanceof Map ? tileMap.get(g.idStr) : (tileMap || {})[g.idStr];
    var rid = t ? Number(t.rewardItemId) || 0 : 0;
    if (!(rid > 0)) {
      skipped.push({ idStr: g.idStr, reason: 'no-tile' });
      continue;
    }
    var items = resolve(rid);
    if (!Array.isArray(items) || items.length === 0) {
      skipped.push({ idStr: g.idStr, reason: 'no-resolve' });
      continue;
    }
    if (secretRewardHit(items, wl)) kept.push(g);
    else skipped.push({ idStr: g.idStr, reason: 'no-hit' });
  }
  return { kept: kept, skipped: skipped };
}

/**
 * 纯函数：报文行数组 → 315 宝箱地块并入缓存（同 wl-chest ingestChestTiles）。
 * 剩余次数字段实证拼写为 `leftTimes`（dashcam-rec-20261109T205818 的 315 行 ×272、源码
 * CQ26WLWorldRewardBoxPop 均如此）；另留 `lefftTimes` 防御回落（本录与反编译源码均未出现该笔误形态）。
 * @param {Array<object>} list 901 pointList / 10018 pointInfos
 * @param {object} into 目标缓存（键 x_y）
 * @param {number} nowMs Date.now() 基准
 * @returns {number} 并入条数
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
    var left = m.leftTimes != null ? m.leftTimes : m.lefftTimes;
    into[x + '_' + y] = {
      x: x,
      y: y,
      k: Number(p.k) || 0,
      specIndex: m.specIndex == null ? -1 : Number(m.specIndex) || 0,
      leftTimes: Number(left) || 0,
      expireTime: Number(m.expireTime) || 0,
      initSid: Number(m.initSid) || 0,
      atMs: nowMs,
    };
    n++;
  }
  return n;
}

/**
 * 纯函数：报文行数组 → 310 巨熊宝藏地块并入缓存（键=十进制串 id，与 22064 gift.id 同源）。
 * m.id 走 readGiftId（19 位雪花不经 Number）；rewardItemId 非正跳过（无礼品内容无从过滤）。
 * 只写自己 new 的标量副本，绝不存报文本体引用（对象池化复用）。
 * @param {Array<object>} list 901 pointList / 10018 pointInfos
 * @param {object} into 目标缓存（键 idStr）
 * @param {number} nowMs Date.now() 基准
 * @returns {number} 并入条数
 */
export function ingestSecretTiles(list, into, nowMs) {
  var n = 0;
  for (var i = 0; i < (list || []).length; i++) {
    var p = list[i];
    if (!p || Number(p.pointType) !== POINT_TYPE_SECRET) continue;
    var m = p.m;
    if (!m || typeof m !== 'object') continue;
    var idStr = readGiftId(m);
    if (!idStr) continue;
    var rid = Number(m.rewardItemId) || 0;
    if (!(rid > 0)) continue;
    into[idStr] = {
      idStr: idStr,
      rewardItemId: rid,
      endTime: Number(m.endTime) || 0,
      x: Number(p.x) | 0,
      y: Number(p.y) | 0,
      k: Number(p.k) || 0,
      atMs: nowMs,
    };
    n++;
  }
  return n;
}

/**
 * 纯函数：一颗 BWL 箱的地块级不可开判据（源码 clickCQ26WLRewardBox 显示闸对齐）。
 * @param {object} t 地块（ingestChestTiles 产出形状）
 * @param {number} nowSec 服务器秒（<=0 = 跳过过期闸）
 * @param {number|null} originSid 老家服号（null = 跳过归属闸）
 * @returns {string|null} 不可开原因；null=可开
 */
export function chestBlockReason(t, nowSec, originSid) {
  if (!t) return 'no-tile';
  // 0 = BWL 盛宴线（本 feat）；>0 = NWL 分区（归 wl-chest）；-1 = specIndex 缺失（不敢猜线）
  if (t.specIndex !== 0) return 'not-bwl';
  if (t.leftTimes <= 0) return 'used-up';
  if (nowSec > 0 && t.expireTime > 0 && t.expireTime <= nowSec) return 'expired';
  if (originSid != null && t.initSid > 0 && t.initSid !== originSid) return 'other-server';
  return null;
}

/**
 * 纯函数：宝箱地块缓存 → 本轮可开队列（只认 specIndex=0；最早过期优先）。
 * @param {object} tilesMap 地块缓存（键 x_y）
 * @param {object} g 闸门入参（opened/nowSec/now/ttlMs/coolUntil/rejectCount/keyPrefix/originSid/maxReject）
 * @returns {{ready:Array<object>, unknown:Array<object>, blocked:Array<{key:string,reason:string}>}}
 *   ready=地块新鲜可直接发 2104；unknown=地块过期需定向 901 重验；blocked=本轮确定不开
 */
export function pickBwlChests(tilesMap, g) {
  var o = g || {};
  var openedSet = o.opened || new Set();
  var now = o.now == null ? Date.now() : o.now;
  var nowSec = Number(o.nowSec) || 0;
  var ttl = o.ttlMs == null ? TILE_TTL_MS : o.ttlMs;
  var cool = o.coolUntil || {};
  var rej = o.rejectCount || {};
  var prefix = o.keyPrefix == null ? 'c:' : o.keyPrefix;
  var maxRej = o.maxReject == null ? MAX_REJECT : o.maxReject;
  var ready = [];
  var unknown = [];
  var blocked = [];
  var keys = Object.keys(tilesMap || {});
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var t = tilesMap[key];
    if (t.specIndex !== 0) continue; // NWL 箱归 wl-chest，不入本腿视野
    var rk = prefix + key;
    if (openedSet.has ? openedSet.has(key) : openedSet[key]) continue;
    if ((cool[rk] || 0) > now) {
      blocked.push({ key: key, reason: 'cooling' });
      continue;
    }
    if ((rej[rk] || 0) >= maxRej) {
      blocked.push({ key: key, reason: 'blacklisted' });
      continue;
    }
    if (now - t.atMs > ttl) {
      unknown.push({ key: key, x: t.x, y: t.y, k: t.k });
      continue;
    }
    var bad = chestBlockReason(t, nowSec, o.originSid);
    if (bad) {
      blocked.push({ key: key, reason: bad });
      continue;
    }
    ready.push({
      key: key,
      x: t.x,
      y: t.y,
      k: t.k,
      leftTimes: t.leftTimes,
      expireTime: t.expireTime,
    });
  }
  ready.sort(function (a, b) {
    return a.expireTime - b.expireTime || a.x - b.x || a.y - b.y;
  });
  unknown.sort(function (a, b) {
    return a.k - b.k || a.x - b.x || a.y - b.y;
  });
  return { ready: ready, unknown: unknown, blocked: blocked };
}

/**
 * 纯函数：额度读数 = 服务器快照 − 尚未回抵的乐观扣减（只往收紧方向偏；照抄 wl-chest 模式）。
 * @param {number} snapRemain 快照 remainChestNum
 * @param {number} spentSinceSnapshot 快照尚未反映的本模块成功开箱数
 * @returns {number} >=0
 */
export function reconcileQuota(snapRemain, spentSinceSnapshot) {
  return Math.max(0, (Number(snapRemain) || 0) - (Number(spentSinceSnapshot) || 0));
}

/**
 * 纯函数：一条 22072 到货后还剩几笔乐观陈账（按额度增量回抵，不是无脑清零；照抄 wl-chest）。
 * @param {number} spent 到货前的乐观条数
 * @param {number|null} prevRemain 上一条 22072 的 remainChestNum（null=首条，清账）
 * @param {number} curRemain 本条 22072 的 remainChestNum
 * @returns {number} >=0
 */
export function cancelQuotaDebt(spent, prevRemain, curRemain) {
  var s = Math.max(0, Number(spent) || 0);
  if (curRemain == null || !Number.isFinite(curRemain)) return s;
  if (prevRemain == null) return 0;
  if (curRemain < prevRemain) return Math.max(0, s - (prevRemain - curRemain));
  if (curRemain > prevRemain) return 0;
  return s;
}

/**
 * 纯函数：这一笔成功开箱还需不需要记乐观扣减（照抄 wl-chest，防双扣）。
 * @param {number|null} snapAtSend 出网时读到的 remainChestNum
 * @param {number|null} snapNow 结算时读到的 remainChestNum
 * @returns {boolean}
 */
export function needOptimisticDeduct(snapAtSend, snapNow) {
  if (snapAtSend == null || snapNow == null) return true;
  return snapNow >= snapAtSend;
}

// ── 数据源与日界 ──────────────────────────────────────────────────────
/**
 * 当前阶段快照：投影优先（与游戏内存同源），不可用时回落自订 22032 副本。
 * @returns {object|null} null=两路都没有（各阶段闸跳过本拍）
 */
function currentPhase() {
  return gameData.cq26FeastPhase() || phaseSnap;
}

/**
 * 当前玩家快照：投影优先，回落自订 22073 副本。
 * @returns {object|null}
 */
function currentPlayer() {
  return gameData.cq26FeastPlayer() || playerSnap;
}

/** 权威已领集到货后剪掉乐观集里已被覆盖的条目（乐观只盖「应答已到、推送未回」那一窗） */
function pruneClaimedOpt() {
  claimedOpt.forEach(function (v) {
    if (claimedAuth.has(v)) claimedOpt.delete(v);
  });
}

/**
 * 两个字符串集求并（已开权威 ∪ 乐观）。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {Set<string>}
 */
function unionSets(a, b) {
  var s = new Set(a);
  b.forEach(function (v) {
    s.add(v);
  });
  return s;
}

/**
 * 日界滚清：以服务器秒所在日为键，换日清「当日」语义的各账（拉黑/冷却/乐观集/已开表）。
 * claimedAuth 也清：投影/22073 下一拍即重新播种，服务器日界后 claimedIndexList 归零。
 * @param {number} nowSec 服务器秒（>0，调用方已过时刻闸）
 */
function rolloverState(nowSec) {
  var d = todayStr(nowSec);
  if (d === dayKey) return;
  dayKey = d;
  rejectCount = Object.create(null);
  coolUntil = Object.create(null);
  giftFeedPending = false;
  giftBusyUntil = 0;
  missAt = Object.create(null);
  claimedAuth = new Set();
  claimedOpt = new Set();
  claimedSecret = new Set();
  openedAuth = new Set();
  openedOpt = new Set();
  openedLoadedDay = '';
  localSpent = 0;
  factionNoWarnDay = '';
  log.debug('day rollover. day=%s', d);
}

/**
 * 当前生效的乐观扣减（纯读）：超 OPT_DEBT_TTL_MS 未被回抵 ⇒ 当推送丢了，不再计入。
 * @param {number} nowMs Date.now()
 * @returns {number}
 */
function quotaDebt(nowMs) {
  if (localSpent <= 0) return 0;
  return nowMs - localSpentAt >= OPT_DEBT_TTL_MS ? 0 : localSpent;
}

/**
 * 决策侧取乐观账：账一过期就地清账并留一行 debug（宁多撞一次被拒，不饿死最后一颗箱）。
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
 * 距「下一个日界线 + 1 分钟」的毫秒（额度每日刷新；同 wl-chest）。
 * @returns {number} 不可得回 0
 */
function dayBoundaryMs() {
  var nowSec = gameData.serverTime() | 0;
  var reset = gameData.nextDailyResetTs();
  if (!nowSec || !reset) return 0;
  return Math.max(0, (reset - nowSec) * 1000 + 60000);
}

// ── 调度 cycle ────────────────────────────────────────────────────────
/** 择时档位：活动期 ~5s 一拍（GATHER 窗仅 300s，push 唤醒兜底）；成功续发 1.5s；闲时 60s */
const cfg = { activeMs: 5000, chainMs: 1500, idleMs: 60000, fallback: 30000 };

/**
 * 单拍择时：成功出网 → chainMs 续发；阶段活跃/有候选 → activeMs；未熟巨熊宝藏 → 锤到 endtime+余量；
 * 宝箱额度见底且全场无事 → 睡到日界线（22032/22064/22072 push 随时 kick 打断）。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  await cyclePass();
  if (cycle.pending) return 0;
  if (justActed) return cfg.chainMs;
  var phase = currentPhase();
  var phaseActive = !!phase && (phase.state === PHASE_GATHER || phase.state === PHASE_FEED);
  var delay = hadCandidate || phaseActive ? cfg.activeMs : cfg.idleMs;
  if (nextSecretSec > 0) {
    var nowSec = gameData.serverTime() | 0;
    if (nowSec > 0) {
      var wait = (nextSecretSec - nowSec) * 1000;
      if (wait > 0 && wait < delay) delay = Math.max(cfg.chainMs, wait);
    }
  }
  if (chestQuotaZero && !hadCandidate && !phaseActive && nextSecretSec <= 0) {
    var until = dayBoundaryMs();
    if (until > 0) delay = until;
  }
  return delay;
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.fallback,
});

/**
 * 单拍：活动闸 → 时刻闸 → 日界滚清 → 三腿串行（每腿至多一发写 + 至多一发只读探针）。
 * @returns {Promise<void>}
 */
async function cyclePass() {
  justActed = false;
  hadCandidate = false;
  chestQuotaZero = false;
  nextSecretSec = 0;
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    return;
  }
  var nowSec = gameData.serverTime() | 0;
  if (nowSec <= 0) {
    log.debug('server time unavailable, skip this pass (expiry gates undecidable).');
    return;
  }
  rolloverState(nowSec);
  var phase = currentPhase();
  var originSid = gameData.cq26OriginServerId();
  if (MCFG.gift) await legGift(phase);
  if (!aliveFn()) return;
  if (MCFG.secret) await legSecret(nowSec);
  if (!aliveFn()) return;
  if (MCFG.chest) await legChest(originSid, nowSec);
}

// ── 腿 1：盛宴礼盒 2106（仅 FEED）──────────────────────────────────────
/**
 * 礼盒腿：faction 闸（0=未加入派系，info 一条后停腿，不代选）→ claimed 合并 → 逐 idx 每拍一发。
 * @param {object|null} phase 阶段快照
 * @returns {Promise<void>}
 */
async function legGift(phase) {
  if (!phase) {
    log.debug('2106 skip: no feast phase snapshot yet.');
    return;
  }
  if (phase.state !== PHASE_FEED) {
    log.debug('2106 skip: phase=%d (FEED only).', phase.state);
    return;
  }
  var faction = gameData.cq26Faction();
  if (faction == null) {
    log.debug('2106 skip: faction unknown.');
    return;
  }
  if (faction === 0) {
    if (factionNoWarnDay !== dayKey) {
      factionNoWarnDay = dayKey;
      log.info('2106 leg halt: faction not joined (NONE), manual choice required.');
    }
    return;
  }
  var pl = currentPlayer();
  if (!pl) {
    log.debug('2106 skip: no player snapshot yet (claimed unknown).');
    return;
  }
  claimedAuth = new Set(pl.claimedIndexList);
  pruneClaimedOpt();
  var claimed = mergeClaimed(claimedAuth, claimedOpt);
  var idx = pickGiftIndex(claimed);
  if (idx < 0) {
    log.debug('2106 skip: all %d gifts claimed.', GIFT_COUNT);
    return;
  }
  var gk = 'g:' + idx;
  if ((coolUntil[gk] || 0) > Date.now()) {
    log.debug('2106 cooling. idx=%d', idx);
    return;
  }
  if ((rejectCount[gk] || 0) >= MAX_REJECT) {
    log.debug('2106 blacklisted today. idx=%d', idx);
    return;
  }
  // 巨兽忙碌状态闸（纯函数判据，详见 giftGateWait）：投喂中等 feedCount 超基线，beast_busy 退避中亦等。
  var plGate = currentPlayer();
  var wait = giftGateWait(
    Date.now(),
    giftFeedPending,
    giftFeedSince,
    (plGate && Number(plGate.feedCount)) || 0,
    giftFeedBase,
    giftBusyUntil,
  );
  if (wait) {
    log.debug('2106 wait: %s. idx=%d', wait, idx);
    return;
  }
  giftFeedPending = false; // 投喂完成（feedCount 超基线）或 TTL fail-open → 清闸
  hadCandidate = true;
  if (!net) {
    log.warn('net unavailable, skip 2106. idx=%d', idx);
    return;
  }
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_GET_GIFT,
    { pointIndex: idx },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) {
    log.debug('2106 ack after pause, drop bookkeeping. idx=%d', idx);
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn('2106 not sent%s. idx=%d', notSentSuffix(sendErr), idx);
    return;
  }
  if (!ret || !ret.ok) {
    if (ret && ret.reason === ERR_BEAST_BUSY) {
      // 巨兽忙（多因他人投喂/领奖竞争，点位本身有效）：不拉黑、不计 streak，退避一阵再试。
      // 不 5s 连重试——busy 窗实录 ~15-25s，连重试会频繁弹「冰魄之灵正在忙碌中」（用户实证）。
      giftBusyUntil = Date.now() + GIFT_BUSY_BACKOFF_MS;
      log.info(
        '2106 beast busy, back off. idx=%d code=%s cool=%dms',
        idx,
        ret.code,
        GIFT_BUSY_BACKOFF_MS,
      );
      return;
    }
    noteReject(gk, CMD_GET_GIFT, ret, 'idx=' + idx);
    return;
  }
  // resp 是空体（header.s===0 即成功）；发奖明细只从 22075 push 读
  claimedOpt.add(idx);
  justActed = true;
  // 刚领→巨兽开始吃（投喂中/311 行军队列进行中）：置忙碌闸，记 feedCount 基线，等 22073 feedCount 超基线再领下一箱
  giftFeedPending = true;
  var plNow = currentPlayer();
  giftFeedBase = (plNow && Number(plNow.feedCount)) || 0;
  giftFeedSince = Date.now();
  log.info('2106 gift claimed. idx=%d (reward detail via 22075)', idx);
}

// ── 腿 2：巨熊宝藏 2108（endtime 到点抢，不做阶段闸）────────────────────
/**
 * 巨熊宝藏腿：额度闸（secretGiftCount<cap）→ 到点候选（endtime≤now≤endtime+600s）→ 装箱自校验 → 每拍一发。
 * @param {number} nowSec 服务器秒
 * @returns {Promise<void>}
 */
async function legSecret(nowSec) {
  var cap = Number(gameConf.dataConfig(CFG_SECRET_CAP)) || 0;
  if (!(cap > 0)) {
    if (!secretCapWarned) {
      secretCapWarned = true;
      log.warn('2108 leg halt: secret cap config %d unreadable.', CFG_SECRET_CAP);
    }
    return;
  }
  secretCapWarned = false;
  var pl = currentPlayer();
  if (!pl) {
    log.debug('2108 skip: no player snapshot (secretGiftCount unknown).');
    return;
  }
  if (pl.secretGiftCount >= cap) {
    log.debug('2108 skip: daily cap reached (%d/%d).', pl.secretGiftCount, cap);
    return;
  }
  // 未熟巨熊宝藏的最近到点时刻（择时唤醒用；已领/过期不计）
  nextSecretSec = 0;
  secretGifts.forEach(function (g) {
    if (claimedSecret.has(g.idStr)) return;
    var ripe = Number(g.endtime) + SECRET_GRACE_SEC;
    if (ripe > nowSec && (nextSecretSec === 0 || ripe < nextSecretSec)) nextSecretSec = ripe;
  });
  var ready = pickSecrets(secretGifts, { nowSec: nowSec, claimed: claimedSecret });
  // 物品白名单（空=全领，向后兼容）：非空只领含勾选物品的巨熊宝藏，310 地块缺失/解析不到 fail-closed 跳过
  if (MCFG.secretItems && MCFG.secretItems.length > 0) {
    var filtered = filterSecretsByItems(
      ready,
      secretTiles,
      function (rid) {
        return gameData.rewardItems(rid);
      },
      MCFG.secretItems,
    );
    if (filtered.skipped.length) {
      log.debug(
        '2108 item filter. kept=%d skipped=%d reasons=%s',
        filtered.kept.length,
        filtered.skipped.length,
        briefReasons(filtered.skipped),
      );
    }
    ready = filtered.kept;
  }
  var head = ready[0] || null;
  if (!head) {
    log.debug('2108 skip: no ripe secret gift. gifts=%d now=%d', secretGifts.size, nowSec);
    return;
  }
  var sk = 's:' + head.idStr;
  if ((coolUntil[sk] || 0) > Date.now()) {
    log.debug('2108 cooling. id=%s', head.idStr);
    return;
  }
  if ((rejectCount[sk] || 0) >= MAX_REJECT) {
    log.debug('2108 blacklisted today. id=%s', head.idStr);
    return;
  }
  hadCandidate = true;
  if (!net) {
    log.warn('net unavailable, skip 2108. id=%s', head.idStr);
    return;
  }
  var idVal = boxId(head.idStr);
  if (idVal == null) return; // boxId 自带 warn，不重试
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_SECRET_GIFT,
    { id: idVal, received: true },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) {
    log.debug('2108 ack after pause, drop bookkeeping. id=%s', head.idStr);
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn('2108 not sent%s. id=%s', notSentSuffix(sendErr), head.idStr);
    return;
  }
  if (!ret || !ret.ok) {
    noteReject(sk, CMD_SECRET_GIFT, ret, 'id=' + head.idStr);
    return;
  }
  claimedSecret.add(head.idStr);
  justActed = true;
  var d = (ret && ret.data) || {};
  log.info(
    '2108 secret claimed. id=%s rewardId=%s',
    head.idStr,
    d.rewardId != null ? d.rewardId : '?',
  );
}

/**
 * 装箱并往返自校验（同 ice-shake boxId）：十进制串 → 游戏 Long → 读回必须逐字相等，
 * 失配放弃代领（玩家自己点仍能领）并首遇一条 warn。
 * @param {string} idStr 巨熊宝藏 id 十进制串
 * @returns {*|null} 可出网的 Int64；不可安全装箱时 null
 */
function boxId(idStr) {
  var boxed;
  try {
    boxed = bits.int64(idStr);
  } catch (e) {
    boxed = null;
  }
  if (boxed == null || bits.int64Str(boxed) !== idStr) {
    if (!boxDegradedWarned) {
      boxDegradedWarned = true;
      log.warn('2108 skip: Int64 boxing unreliable (round-trip mismatch). id=%s', idStr);
    }
    return null;
  }
  boxDegradedWarned = false;
  return boxed;
}

// ── 腿 3：奖励宝箱 2104（BWL 线宝箱，与 wl-chest 共享额度）──────────────
/**
 * 奖励宝箱腿：额度三态 → 2105 已开表（每日一读）→ 逐点闸 → 队头出网；地块过期以该箱坐标定向 901 重验。
 * @param {number|null} originSid 老家服号
 * @param {number} nowSec 服务器秒
 * @returns {Promise<void>}
 */
async function legChest(originSid, nowSec) {
  if (originSid == null) {
    log.debug('2104 skip: origin server id unknown.');
    return;
  }
  var info = gameData.cq26WlInfo();
  if (!info) {
    if (!noSnapshotWarned) {
      noSnapshotWarned = true;
      log.debug('no 22072 snapshot yet, skip chest leg (must not read as quota 0).');
    }
    return;
  }
  if (info.remainChestNum <= 0) {
    chestQuotaZero = true;
    log.debug('chest quota used up today (limit=%d).', info.chestDailyLimit);
    return;
  }
  var spent = effectiveSpent(Date.now());
  var remain = reconcileQuota(info.remainChestNum, spent);
  if (remain <= 0) {
    hadCandidate = true;
    log.debug(
      'optimistic quota 0 (snap=%d spent=%d), wait next 22072.',
      info.remainChestNum,
      spent,
    );
    return;
  }
  if (!net) {
    log.warn('net unavailable, skip chest leg.');
    return;
  }
  // 已开表每日读一发 2105（权威），乐观集盖「应答已到、表未刷」那一窗
  if (openedLoadedDay !== dayKey) {
    if (net.isSending && net.isSending(CMD_OPENED_LIST)) return;
    var sendErr = '';
    var ret = await net.sendGuarded(
      CMD_OPENED_LIST,
      {},
      {
        protocol: 'sendPBV2',
        onError: function (err) {
          sendErr = (err && err.message) || String(err);
        },
      },
    );
    if (!aliveFn()) return;
    if (ret && ret.code === CODE_NOT_SENT) {
      log.warn('2105 not sent%s.', notSentSuffix(sendErr));
      return;
    }
    if (!ret || !ret.ok) {
      log.debug('2105 read failed, retry next pass. code=%s', ret ? ret.code : 'unknown');
      return;
    }
    var posList = (ret.data && ret.data.posList) || [];
    openedAuth = new Set(
      posList.map(function (r) {
        return (Number(r && r.x) | 0) + '_' + (Number(r && r.y) | 0);
      }),
    );
    openedLoadedDay = dayKey;
    log.debug('2105 opened list loaded. n=%d', openedAuth.size);
  }
  var picked = pickBwlChests(chestTiles, {
    opened: unionSets(openedAuth, openedOpt),
    nowSec: nowSec,
    now: Date.now(),
    coolUntil: coolUntil,
    rejectCount: rejectCount,
    originSid: originSid,
  });
  var head = picked.ready[0] || null;
  if (!head && picked.unknown.length) {
    var target = picked.unknown[0];
    if (canProbe('c:' + target.key)) {
      await probeChestTile(target);
      if (!aliveFn()) return;
      picked = pickBwlChests(chestTiles, {
        opened: unionSets(openedAuth, openedOpt),
        nowSec: nowSec,
        now: Date.now(),
        coolUntil: coolUntil,
        rejectCount: rejectCount,
        originSid: originSid,
      });
      head = picked.ready[0] || null;
    }
  }
  hadCandidate = !!head || picked.unknown.length > 0;
  if (!head) {
    log.debug(
      'no openable bwl chest. tiles=%d unknown=%d blocked=%d reasons=%s',
      Object.keys(chestTiles).length,
      picked.unknown.length,
      picked.blocked.length,
      briefReasons(picked.blocked),
    );
    return;
  }
  await claimBwlChest(head, remain, info.remainChestNum);
}

/**
 * 该目标现在能不能发定向 901（在途单发 + miss 冷却；宝箱腿探针用）。
 * @param {string} key 探针窗心键或 'c:'+箱键
 * @returns {boolean}
 */
function canProbe(key) {
  if (probeInFlight || !net) return false;
  if (net.isSending && net.isSending(CMD_WORLD_INFO)) return false;
  return Date.now() - (missAt[key] || 0) >= MISS_COOL_MS;
}

/**
 * 以该箱坐标为窗心发一发定向 901 重验地块（照抄 wl-chest 探针形态，镜头不动）。
 * @param {{key:string,x:number,y:number,k:number}} c unknown 项
 * @returns {Promise<void>}
 */
async function probeChestTile(c) {
  probeInFlight = true;
  var r = await fetchWindow(net, c.x, c.y, {
    k: c.k || worldMap.serverId(),
    width: PROBE_W,
    height: PROBE_H,
    viewLevel: PROBE_VIEW_LEVEL,
    marchInfo: false,
  });
  probeInFlight = false;
  if (!aliveFn()) return;
  if (!r.ok) {
    log.debug('901 chest probe failed. chest=%s code=%s', c.key, r.code);
    return;
  }
  ingestChestTiles(r.points, chestTiles, Date.now());
  var t = chestTiles[c.key];
  if (!t || Date.now() - t.atMs > TILE_TTL_MS) {
    missAt['c:' + c.key] = Date.now();
    log.debug('901 window has no fresh chest tile. chest=%s k=%d', c.key, c.k);
  } else {
    delete missAt['c:' + c.key];
    log.debug('901 resolved chest %s → left=%d', c.key, t.leftTimes);
  }
}

/**
 * 发一条 2104 并结算（每拍至多一次）：乐观已开 + 乐观扣额（22072 增量回抵防双扣）。
 * @param {object} c 候选（ready 项）
 * @param {number} remain 出网前乐观剩余额度（日志用）
 * @param {number} snapAtSend 出网时的权威 remainChestNum
 * @returns {Promise<void>}
 */
async function claimBwlChest(c, remain, snapAtSend) {
  var t0 = Date.now();
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_GET_CHEST,
    { x: c.x, y: c.y },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) {
    log.debug('2104 ack after pause, drop bookkeeping. chest=%s', c.key);
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn('2104 not sent%s. chest=%s', notSentSuffix(sendErr), c.key);
    return;
  }
  if (!ret || !ret.ok) {
    noteReject('c:' + c.key, CMD_GET_CHEST, ret, 'chest=' + c.key);
    return;
  }
  openedOpt.add(c.key);
  var snapNow = gameData.cq26WlInfo();
  if (needOptimisticDeduct(snapAtSend, snapNow ? snapNow.remainChestNum : null)) {
    localSpent++;
    localSpentAt = Date.now();
  }
  rejectCount['c:' + c.key] = 0;
  delete coolUntil['c:' + c.key];
  justActed = true;
  chestOpenedCount++;
  var d = (ret && ret.data) || {};
  var items = (d.rewardResult && d.rewardResult.items) || [];
  var got = items
    .map(function (it) {
      return item.label(it.itemId) + '×' + (Number(it.itemCount) || 0);
    })
    .join(', ');
  log.info(
    '2104 bwl chest opened (%d,%d) k=%d quota=%d→%d cost=%dms → %s',
    c.x,
    c.y,
    c.k,
    remain,
    Math.max(0, remain - 1),
    Date.now() - t0,
    got || 'empty reward',
  );
}

// ── 共用记账 ──────────────────────────────────────────────────────────
/**
 * CODE_NOT_SENT 的文案后缀：带抛错文案 vs 在途闸/超时（六个 not-sent 出口共用，文案零漂移）。
 * @param {string} sendErr onError 捕获的异常文案（空串=非抛错）
 * @returns {string}
 */
function notSentSuffix(sendErr) {
  return sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)';
}

/**
 * 业务拒绝：可预期闸门类（额度/时序竞争/目标被抢），info 级不升 warn；
 * 单次留冷却自愈，连续 MAX_REJECT 次当日拉黑（防逐拍重发刷屏）。
 * @param {string} key 带前缀目标键
 * @param {number} cmd 协议号
 * @param {object} ret Ret{code,data}
 * @param {string} ctx 定位上下文（坐标/idx/id）
 */
function noteReject(key, cmd, ret, ctx) {
  var n = (rejectCount[key] = (rejectCount[key] || 0) + 1);
  coolUntil[key] = Date.now() + REJECT_COOL_MS;
  log.info(
    '%d rejected. %s code=%s reason=%s streak=%d%s',
    cmd,
    ctx,
    ret ? ret.code : 'unknown',
    rejectText(ret),
    n,
    n >= MAX_REJECT ? ' (blacklisted today)' : '',
  );
}

/**
 * blocked 原因折叠成一行 reason×n（debug 用，单轨可诊断又不逐点刷屏）。
 * @param {Array<{key:string,reason:string}>} blocked
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

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 巨熊宝藏物品候选池：5 种已知礼包（SECRET_REWARD_IDS）经 RewardController 实时解析、按 itemId 去重。
 * 与游戏面板同源（gameData.rewardItems）；名称走 item.label 三级回退（登记表→loc 翻译→道具 <id>）。
 * RewardController 不可用时回空数组（面板显「暂无可选项」，过滤腿不受影响——它按地块 rewardItemId 逐个解析）。
 * @returns {Array<{id:number,label:string}>}
 */
function secretRewardPool() {
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < SECRET_REWARD_IDS.length; i++) {
    var arr = gameData.rewardItems(SECRET_REWARD_IDS[i]);
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j];
      var id = Number(it && it.id) || 0;
      if (id <= 0 || seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, label: item.label(id, it.name) });
    }
  }
  return out;
}

/**
 * 面板 defaults：总开关默认关，三腿默认全开（启用即三腿齐跑，可单独关）；
 *   secretItems 空对象 = 巨熊宝藏全领（itemlist「全不勾=不过滤」语义，显式勾选物品才启用白名单）。
 * @returns {object}
 */
function buildDefaults() {
  return { enabled: false, gift: true, secret: true, chest: true, secretItems: {} };
}

/**
 * 面板 fields：状态 text 置顶（多行内联，每腿一行）+ 三腿开关行 + 巨熊宝藏物品白名单（itemlist 动态池）。
 *   状态读起来是「阶段 X / 礼盒 x/10 / 巨熊宝藏 y/上限[（过滤 n 物）] / 奖励宝箱 本场 z · 已领 d/limit」。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_feastInfo',
      type: 'text',
      label: '状态',
      multiline: true,
      inline: true,
      get: function () {
        if (!gameData.cq26IsOpen()) return '—';
        var phase = currentPhase();
        var ph = phase ? PHASE_LABELS[phase.state] || '阶段' + phase.state : '阶段未知';
        var pl = currentPlayer();
        var claimed = mergeClaimed(claimedAuth, claimedOpt);
        var cap = Number(gameConf.dataConfig(CFG_SECRET_CAP)) || 0;
        var wl = MCFG.secretItems || [];
        var secretPart =
          '巨熊宝藏 ' +
          (pl ? pl.secretGiftCount : '?') +
          '/' +
          (cap > 0 ? cap : '?') +
          (wl.length > 0 ? '（过滤 ' + wl.length + ' 物）' : '');
        // 奖励宝箱额度与「遗失之箱」共享（22072 权威）：已领 = 日上限 − 剩余（夹 [0,上限]）；
        //   快照未达 / 上限不可读只显本场开箱数，不拿 0 冒充已领（额度已完成口径）
        var wi = gameData.cq26WlInfo();
        var chestPart = '奖励宝箱 本场 ' + chestOpenedCount;
        var limit = wi ? Number(wi.chestDailyLimit) || 0 : 0;
        var remain = wi && wi.remainChestNum != null ? Number(wi.remainChestNum) : NaN;
        if (limit > 0 && Number.isFinite(remain)) {
          var done = Math.max(0, Math.min(limit, limit - remain));
          chestPart += ' · 已领 ' + done + '/' + limit;
        }
        return (
          '阶段 ' +
          ph +
          '\n礼盒 ' +
          claimed.size +
          '/' +
          GIFT_COUNT +
          '\n' +
          secretPart +
          '\n' +
          chestPart
        );
      },
    },
    { key: 'gift', type: 'checkbox', label: '自动礼盒' },
    { key: 'secret', type: 'checkbox', label: '自动巨熊宝藏' },
    { key: 'chest', type: 'checkbox', label: '自动奖励宝箱' },
    {
      key: 'secretItems',
      type: 'itemlist',
      label: '巨熊宝藏物品白名单',
      items: function () {
        return secretRewardPool();
      },
      nameGrow: true,
      defaultOff: true,
      hideNumCol: true,
      chkTitle: '勾选=只领含此物品的巨熊宝藏',
      topHint: '全不勾 = 全领（默认）；勾选物品 → 只领含这些物品的巨熊宝藏',
      hint: '内容解析不到的巨熊宝藏（地块在视口外 / RewardController 不可用）跳过不领。候选由 5 种已知礼包实时解析。',
      summary: function (items, state) {
        var keys = Object.keys(state || {});
        var n = 0;
        for (var i = 0; i < keys.length; i++) {
          var e = state[keys[i]];
          if (e && e.on !== 0) n++;
        }
        return n > 0 ? '已勾选 ' + n + ' 物（只领含这些物品的巨熊宝藏）' : '全不勾 = 全领';
      },
    },
    {
      type: 'note',
      text: '礼盒仅投喂期且需已加入派系（不代选）；巨熊宝藏到点自动抢（10 槽共享、可按物品白名单过滤，大世界也能领）；奖励宝箱与「遗失之箱」共享日额度。融冰请手动；急速解冻（原摇一摇）已独立到基础设置组。',
    },
  ];
}

/**
 * toModuleCfg：面板 cfg → 运行时配置（三腿开关缺省按 true，历史残留键不透传）。
 * secretItems 兼容两形态：旧 multiopts 存档 = number[]（勾选 id）；新 itemlist 存档 = {[idStr]:{on:0|1}}
 *   （收集 on!==0 的 key）。归一为正整数 itemId 数组（去重/去非数）；空数组 = 巨熊宝藏全领。
 * @param {object} c 面板合并后配置
 * @returns {{enabled:boolean,gift:boolean,secret:boolean,chest:boolean,secretItems:number[]}}
 */
function normalizeCfg(c) {
  var o = c || {};
  var raw = o.secretItems;
  var ids = [];
  if (Array.isArray(raw)) {
    ids = raw;
  } else if (raw && typeof raw === 'object') {
    var ks = Object.keys(raw);
    for (var j = 0; j < ks.length; j++) {
      if (raw[ks[j]] && raw[ks[j]].on !== 0) ids.push(ks[j]);
    }
  }
  var seen = Object.create(null);
  var items = [];
  for (var i = 0; i < ids.length; i++) {
    var id = Number(ids[i]) || 0;
    if (id > 0 && !seen[id]) {
      seen[id] = true;
      items.push(id);
    }
  }
  return {
    enabled: !!o.enabled,
    gift: o.gift !== false,
    secret: o.secret !== false,
    chest: o.chest !== false,
    secretItems: items,
  };
}

/**
 * configure：registry 每次推配置灌入运行时 cfg，运行中变更立即补一拍。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (!partial) return MCFG;
  MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

// 协议号/配置号/阈值/纯函数导出给单测与 replay 对拍（scripts/verify-manifests/cq26-feast.mjs）复用同一份字典
export {
  CMD_GET_CHEST,
  CMD_OPENED_LIST,
  CMD_GET_GIFT,
  CMD_SECRET_GIFT,
  PUSH_PHASE,
  PUSH_SECRET,
  PUSH_PLAYER,
  PUSH_GIFT_REWARD,
  PUSH_WL_INFO,
  PUSH_TILE,
  CMD_WORLD_INFO,
  POINT_TYPE_CHEST,
  POINT_TYPE_SECRET,
  PHASE_GATHER,
  PHASE_FEED,
  GIFT_COUNT,
  SECRET_GRACE_SEC,
  SECRET_TTL_SEC,
  CFG_SECRET_CAP,
  SECRET_REWARD_IDS,
  PROBE_W,
  PROBE_H,
  PROBE_VIEW_LEVEL,
  TILE_TTL_MS,
  MAX_REJECT,
  REJECT_COOL_MS,
  GIFT_FEED_TTL_MS,
  GIFT_BUSY_BACKOFF_MS,
  ERR_BEAST_BUSY,
};

reactor.register({
  id: FEAT_ID,
  label: '巨兽盛宴',
  storageKey: 'pocketcc.feat.cq26_feast',
  // dataCenter 硬依赖（活动闸/阶段/玩家投影）；long64Bit 硬依赖（巨熊宝藏 19 位雪花 id 装箱，
  //   缺失时 bits.int64 退成 Number 丢精度 ⇒ 由 boxId 往返校验兜住并放弃代领）
  symbols: ['dataCenter', 'long64Bit'],
  // 与 cq26 家族同口径：靠房间号 k 跨图定向发包，不依赖人真站在盛宴图里
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 三动作均不派兵、不占行军名额，战斗态无需下线
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
