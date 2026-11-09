/**
 * 机械田自动建造（mechBuild）——「自动下田」的子功能：自己当「机械大师」建塔，一家族恒保 1 座
 *
 * 归属：本模块不是独立 feat，而是 autoFarm（feats/player/auto-farm/index.js）驱动的**子引擎**——
 *   生命周期（install/configure/run/pause）由 index.js 转发，共用 autoFarm 的 reactor ctx 与 alive 门控，
 *   自带一个 createCycle。与 autoFarm/tower-scanner 的关系：tower-scanner 只**采集别人建的**机械田；
 *   本引擎接管**自己建塔**。两者共用行军队列，故同样靠 march.freeSlots() 闸门，本引擎单拍最多占 1 个名额。
 *
 * 受「下田时段」控制（index.js 注入 gate 回调）：仅在「子功能勾选启用 且（未启用时段 或 落在下田时段内）」时才建；
 *   停用或时段外 → 不允许新建，**先拉到权威 1031 且确认成功**，再把**活表里确认 st=2** 的塔逐座 1032 TOWER_REMOVE
 *   取消建设（报文实证见下 ⑥）。取消对象一律以权威表为准，两种情形只摘账本、绝不发 1032：
 *   · 已建成（st=3）：保留给联盟采集（不能只靠「建成塔已离账本」：904 被拒、或建成与关窗同拍时建成塔会仍在账本里，
 *     此时误发 1032 会毁掉盟友正在采的田）；
 *   · 查无此塔：塔已从 1031 消失 = 游戏侧早已拆掉/到期/被毁（销毁实录实证）——两座塔 12:28 已被
 *     手动 1032 销毁（回执 code=0），账本却仍留着它们，于是刚进游戏就对着不存在的塔重发 1032、被服务器 code=3 拒，
 *     并因「被拒保留条目 + 30s 冷却」而无限刷屏。**写请求的取消动作必须有权威读背书，不能只信跨会话账本**。
 *
 * 玩法链路（实录报文实证：构建机械田趟的 4 次 1033 建造 + 行军状态全程 + 10182 推送、
 *   1031/1034 读侧趟、以及机械设施列表趟的 1031 权威列表）：
 *  ① 选地（规则 R2/R3）：不普查视口，改用 906（WORLD_SEARCH_MONSTER）服务端「按 (落点田组, 等级) 搜一个点」——
 *     与自动下田同源，只是把「田家族」取 mech-build 的 FIELD_GROUP_BY_FAMILY（面板家族→落点田组 floor(itemId/100)）。
 *     靠「逐级降序」（RESOURCE_MAX_LEVEL→1，R3 等级最高优先）问服务端，首个通过 isFreeField（R2：pt=4 无主普通田，
 *     遗迹田 pt≠4/他人机械田 pt=24 天然排除）的落点即返回；等级起点带 TTL 缓存避免每拍空打满档。906 每级只回一个点，
 *     故同等级被拒后靠拉黑该坐标 + 降级重试（不保证同等级换第二个点，与建塔「一族一塔」的低频场景相符）。
 *     实证田点 r={itemId,ownerId:'0',aid:'0',allianceAreaOwner:0}，与 906 应答字段面一致（报文实证见 core/resource.js）。
 *  ② 派建：net.send(1033 MARCH_WORLD_Build) 发 1 个单兵（armyNum:1，marchType=25）→ 应答 marchInfo(state=1,
 *     marchId 字符串, target.itemId=田 itemId)；服务器同时推 10182 PUSH_MY_PROFESSIONAL_TOWERS(st=2)；
 *  ③ 驻守施工：行军 state 1→11（到达开工，本 feat 命名 BUILDING）→5 GATHERING；塔 1031/10182 st 由 2→3
 *     （实证 st=3 与单兵入塔同拍，army_size 0→1）；
 *  ④ 建成立即撤回（固定行为，非可选项）：st===3 → net.send(904 {marchId}) → state 3 RETURNING → 4 ARRIVED_HOME，
 *     队列释放；塔留在原地（实证撤回后盟友照常来采，army_size 412/218），不撤不影响塔存活；
 *  ⑤ 补建：塔到期/被毁 → 1031 活表里该族条目消失 → 下一拍重新选地派建（家族唯一性靠「塔实例是否存在」
 *     判定，重启/换号天然自愈）；
 *  ⑥ 取消在建（停用 / 时段外，两趟销毁在建机械田实录报文实证）：
 *     1033 建塔(buildId,x,y) → 1034/10182 读到 st=2（在建）→ net.send(1032 TOWER_REMOVE, {id:"塔实例id 字符串"})
 *     即销毁在建塔；实证 1032 之后游戏**不再单独发 904**——服务器自动把施工单兵遣返。故取消在建只需 1032（按已认领的
 *     towerId）；若兵仍在路上塔未成形（towerId 未认领），退回 904 撤那条 marchId（实证销毁在建趟：对建造行军的 904
 *     会被服务器拒（professional_des09），游戏侧随后才改发 1032），因此本引擎只把 904 当未成形时的退路，被拒则保留账本下拍重试。
 *
 * 家族口径（三方编号不同源，已用实录报文定死唯一致口径；见下表四元组）：
 *   family(面板资源家族码) → bid 前缀 floor(bid/1000) → 落点田 itemId 组 floor(r.itemId/100) → 职业 buffId
 *   7 金矿 → 51 → 1  (106) → 1101001
 *   5 粮食 → 53 → 7  (706) → 1101003
 *   1 石油 → 52 → 5  (506) → 1101002
 *  16 雷神 → 71 → 16 (1603) → 1101072
 * 规则 R1（职业闸门，源码实证 NWorldResourcePopup）：只有机械大师才建有塔——建塔面板用
 *   UserData.Buff.getBuffDataById(resBuffId).Value 直接拿「本人可建的完整 bid」，无 Value 即不可建。
 *   本 feat 同判据：职业读数取不到（非机械大师/等级不够/Buff 未同步）就**不派建**（不兜底经验等级，
 *   兜底=明知不该发还发），四族全 0 视作职业不在场，info 级说明后按 idle 睡。
 * 单兵 armyId 不硬编码：走 core/battle.js 的 Battle().plan().minimal().build()（游戏「快速派兵」同源口径，
 *   取最低级可派遣部队 1 支），实证样本 20096/30097/20098/10097 都是该口径的自然产物。
 *
 * 闸门与限流：非 world 场景不发包；准入闸 screen(getUid()) 每拍首行；派建前先过源码实证的本地闸——
 *   DATACONFIG 11001 玩家等级门槛 + march.freeSlots() 行军队列（与游戏 attackCallBack 同判据；建塔入口源码
 *   无造价预检字段，成本由服务器拒绝兜底）。单拍 ≤1 发 1033 + 选地若干发 906（逐级降序，命中即停）+ 1 发 1034；
 *   被拒按归因分流：坐标类拒绝才拉黑落点，其余只族冷却；连续被拒达 rejectionStreakBackoff(3) 次下拍睡眠翻倍。
 *
 * 账本：storage.slot('autoFarm.mechBuild')（v2，UID 隔离；BL-4 加认领超时清理，旧 v1 档整份作废靠 1031 重建）落 family → {marchId,bid,towerId,x,y,
 *   dispatchedAt,btime,recalledAt}，跨会话重建在飞态；与 autoFarm 的田位账本分开，互不覆盖。
 *   字段口径：`btime` 取 1033 应答的 marchInfo.gatherStartTime（实证常缺省→0），仅作诊断/对拍留档，
 *   建成判定一律以活表 1031/10182 的 st 与 btime 为权威；`recalledAt` 本引擎不再写（撤回成功即摘条目），
 *   只作防御性读判据（旧档/外部档带该标记时按「已收尾」即时剔除）。
 *
 * 生命周期由宿主 autoFarm 的 reactor ctx 托管：places 限 base/world、战斗模式暂停；唤醒源（run/10182/10452 推送/配置变更/兜底定时）
 *   全部汇入本引擎的 cycle.kick；cycle 靠 alive 门控（=autoFarm.alive()），暂停自然停摆。
 *   停用口径（重要）：只有「引擎仍在运行时取消子功能勾选 / 落在下田时段外」才会走 1032 取消在建；
 *   **关掉整个「自动下田」（宿主 unconfigure/pause）不会取消**——reactor 先置 running=false（alive 变假、cycle 停摆）
 *   再调 pause，在建塔留在原地继续施工，靠下次启用时的首拍自愈（实证：塔建成后盟友照常来采，不毁不损）。
 */
import { parseData, sleep, CODE_NOT_SENT, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { storage } from '../../../core/storage.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';
import { createCycle } from '../../../core/cycle.js';
import { screen } from '../../../core/net-guard.js';
import { getUid } from '../../../core/player.js';
import { gameData, gameConf, l10n, checkCap } from '../../../core/game-api.js';
import { map } from '../../../core/map.js';
import { resource } from '../../../core/resource.js';

/** @type {ReturnType<typeof createLog>} 模块日志器（tag=MECH-BUILD） */
const log = createLog('MECH-BUILD');

/** @type {number} RequestId.GET_TOWER_LIST：本人机械设施权威列表（应答 {list:[塔对象]}，pid=自己 UID 字符串） */
const CMD_GET_TOWER_LIST = 1031;
/** @type {number} RequestId.GET_TOWERINFO：单塔详情（{id:"塔实例id 字符串"}，防 Int64 截断） */
const CMD_GET_TOWERINFO = 1034;
/** @type {number} RequestId.MARCH_WORLD_Build：建塔行军（V1 net.send，非 PB） */
const CMD_MARCH_WORLD_BUILD = 1033;
/** @type {number} RequestId.TOWER_REMOVE：销毁塔（{id:"塔实例id 字符串"}，应答 {}）——本引擎只用它取消**在建**（st=2）的塔 */
const CMD_TOWER_REMOVE = 1032;
/** @type {number} push PUSH_MY_PROFESSIONAL_TOWERS：本人塔对象整份推送（派建即 st=2，入塔转 st=3） */
const CMD_PUSH_TOWER = 10182;
/** @type {number} push PUSH_ALLIANCE_RECORD：联盟记录增量（建塔/毁塔事件），仅作 1031 重拉 kick 源 */
const CMD_PUSH_ALLIANCE_RECORD = 10452;
/** @type {number} 行军类型：建塔（NMarchType 里的 BUILD 语义，实证 1033/10019 都是 25） */
const MARCH_TYPE_BUILD = 25;
/** @type {number} TowerState.BUILDING：施工中（尚未可采） */
const TOWER_STATE_BUILDING = 2;
/** @type {number} TowerState.COMPLETE：已建成（可采，也是「建成立即撤回」的触发态） */
const TOWER_STATE_COMPLETE = 3;
/**
 * @type {number} 建塔单兵行军「到达并开工」态（实证 10019 state 1→11→5；march.js 的 State 枚举无此项，
 * 完工判定仍以塔 st===3 为准，本常量只供探针/真机对拍引用，不参与决策）。
 */
export const MARCH_STATE_BUILDING = 11;
/** @type {number} 实体类型：资源田（901/906 pointType=4，建塔落点必须是田点） */
const POINT_TYPE_FIELD = 4;
/** @type {number} 906 搜索分类 pointType：资源 tab（1野怪/2资源/3集结/4国宝），与普通田搜索同口径 */
const SEARCH_POINT_TYPE_RESOURCE = 2;

/**
 * 面板建造家族顺序（与 autoFarm 的优先级解耦；金→粮→油→雷神按用户列举序）。
 * @type {number[]}
 */
const FAMILIES = [7, 5, 1, 16];
/** @type {Object<number,string>} 家族码 → 面板文案 */
const FAMILY_LABEL = { 7: '金矿', 5: '粮食', 1: '石油', 16: '雷神' };
/** @type {Object<number,number>} 家族码 → 塔 bid 前缀（floor(bid/1000)）：51 金 / 53 粮 / 52 油 / 71 雷神 */
const TOWER_PREFIX_BY_FAMILY = { 7: 51, 5: 53, 1: 52, 16: 71 };
/** @type {Object<number,number>} 塔 bid 前缀 → 家族码（TOWER_PREFIX_BY_FAMILY 反向） */
const FAMILY_BY_TOWER_PREFIX = { 51: 7, 53: 5, 52: 1, 71: 16 };
/** @type {Object<number,number>} 家族码 → 落点田 itemId 组（floor(r.itemId/100)）：1 金 / 7 粮 / 5 油 / 16 雷神 */
const FIELD_GROUP_BY_FAMILY = { 7: 1, 5: 7, 1: 5, 16: 16 };
/** @type {Object<number,number>} 家族码 → 机械大师职业 buffId（源码实证 NWorldResourcePopup 的 ResourceType 分支） */
const BUFF_ID_BY_FAMILY = { 7: 1101001, 5: 1101003, 1: 1101002, 16: 1101072 };
/**
 * @type {number} DATACONFIG 配置 id：建塔入口的玩家等级门槛（源码实证 NWorldResourcePopup.attackCallBack：
 * `UserData.Level < getDataConfigData(11001)` → tips 100483 直接拦截，不发 1033）。取不到配置按 0（不设闸）。
 */
const BUILD_LEVEL_CFG_ID = 11001;

/**
 * @type {number} 账本结构版本：不符整份作废（字段口径变更时旧档一律丢弃，靠 1031 重建）
 */
const LEDGER_VER = 2;
/** @type {string} 账本独立存储键（storage.slot 下，UID 前缀隔离；与 autoFarm 田位账本分开） */
const LEDGER_NAME = 'autoFarm.mechBuild';

/** @type {object} 内置调优常量（面板不暴露） */
const cfg = {
  /** 1031 权威列表的重拉 TTL（毫秒）：实证本人塔低频变化，靠 10182 推送即时维持，这里兜漏推 */
  towerRefreshMs: 1000 * 60 * 3,
  /** 1031 拉取失败后的重试间隔（毫秒） */
  towerRetryMs: 1000 * 30,
  /** 在飞建造行军的轮询间隔（毫秒）：st 2→3 由 10182 推送即时反映，这里只兜漏推 */
  buildPollMs: 1000 * 60,
  /** 已建成塔「剩余寿命不足此值」（服务器秒）即视为可提前补建 */
  buildGuardSec: 600,
  /** 无任何在飞/到期事务时的兜底扫描间隔（毫秒） */
  idleScanMs: 1000 * 60 * 5,
  /** 被拒后该家族的重试冷却（毫秒） */
  familyCooldownMs: 1000 * 60 * 10,
  /** 连续被拒达此次数后触发退避（睡眠翻倍） */
  rejectStreakBackoff: 3,
  /** 选地点位的会话拉黑时长（毫秒）：同一格被拒后短期不再试 */
  pointBlacklistMs: 1000 * 60 * 30,
  /** MA-1：到期补建的最近唤醒下限（毫秒），杜绝把循环钉成亚秒空转 */
  minExpiryDelayMs: 1000 * 15,
  /** 选地等级缓存 TTL（毫秒）：同族探到的最好等级短期内作下次搜索起点，避免每拍从满档逐级空打 */
  searchTtlMs: 1000 * 60 * 2,
  /** BL-4：建造行军「塔 id 认领超时」（毫秒）——超此仍未被推送/权威读认领到塔即判失败，清账本让下一拍补建 */
  claimTimeoutMs: 1000 * 60 * 15,
  /** MA-5：同一落点连续被拒达此次数才判「坐标类拒绝」并持久拉黑；单次拒绝多为造价/上限等全局因，只族冷却 */
  rejectSamePointBlacklistAfter: 2,
  /** 时段外「睡向下个下田时段起点」的单拍上限（毫秒）：兜住时钟漂移/超大定时器（与宿主 autoFarm 同口径） */
  windowSleepMaxMs: 1000 * 60 * 60 * 6,
  /** 时段外「睡向下个下田时段起点」的单拍下限（毫秒）：防紧贴空转 */
  windowSleepMinMs: 1000 * 10,
  /** 取消在建被服务器拒绝后的族重试冷却基数（毫秒）：保留账本条目下拍重发，免每拍撞同一拒 */
  cancelRetryMs: 1000 * 30,
  /** 取消被拒的族冷却上限（毫秒）：同一座塔反复被拒时按指数退避封顶，防把 1032 钉成长频循环 */
  cancelRetryMaxMs: 1000 * 60 * 15,
  /** 10452 联盟记录推送唤醒的最小间隔（毫秒）：合并突发推送，防把 1031 全量重拉钉成高频（与宿主 autoFarm 同口径） */
  pushWakeMinGapMs: 1000 * 4,
};

/** @type {function():boolean} 运行态探针（=宿主 autoFarm 的 aliveFn；install 注入，未注入前恒 false） */
var gateAlive = function () {
  return false;
};
/**
 * @type {{active: function():boolean, isIn: function():boolean, msToStart: function():number}}
 * 「下田时段」闸回调（宿主 autoFarm 注入）：active()=时段是否生效，isIn()=当前是否落在时段内，msToStart()=距下个时段起点毫秒。
 */
var gate = {
  active: function () {
    return false;
  },
  isIn: function () {
    return true;
  },
  msToStart: function () {
    return 0;
  },
};
/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;
/** @type {object} 模块配置（configure 灌入，源自宿主 toModuleCfg 的 mechBuildEnabled/mechBuildFamilies） */
var MCFG = {
  enabled: false,
  families: [],
  buildGuardSec: cfg.buildGuardSec,
};

/**
 * @type {Object<string, object>} 本人塔活表：塔实例 id（字符串）→ {id,bid,family,st,x,y,ct,btime,dur,pid}
 */
var towers = {};
/** @type {boolean} 是否已成功拉过一次 1031（未拉通前不做家族判定，防把「有塔」误判成「无塔」重复建） */
var towersLoaded = false;
/** @type {Promise<boolean>|null} 1031 在飞 promise（单飞去重：并发 await 者共享同一等待，防「空返回」竞态） */
var towersInflight = null;
/** @type {number} 上次 1031 成功落地的墙上时刻（毫秒），0=从未 */
var towersLoadedAt = 0;
/** @type {boolean} MA-2：1031 是否在飞——在飞期间到达的 10182 推送先缓冲，整表替换后回灌，防被吞。 */
var capturing = false;
/** @type {Object<string, object>} MA-2 缓冲：塔 id（字符串）→ 在飞期间到达的归一化塔。 */
var pushedDuring = {};
/** @type {Object<string, object>} 建造账本：family（字符串键）→ 账本条目 */
var ledger = {};
/** @type {boolean} 账本是否已从盘读回（**读成功才置位**，防拿空账本覆盖盘上在飞建造） */
var ledgerLoaded = false;
/** @type {Promise<void>|null} 账本读盘在飞 promise（单飞去重，并发 await 者共享同一等待） */
var ledgerLoading = null;
/** @type {Object<string, number>} 家族 → 被拒冷却到期墙上时刻（毫秒） */
var familyCooldown = {};
/** @type {Object<number, number>} 家族 → 取消在建的连续被拒次数（成功取消/收到受理即清零，驱动冷却指数退避） */
var cancelRejectStreak = {};
/** @type {Object<string, number>} 落点键 "x,y" → 拉黑到期墙上时刻（毫秒） */
var pointBlacklist = {};
/** @type {number} 连续被拒次数（成功派建/正常一拍即清零） */
var rejectStreak = 0;
/** @type {Object<number, {level:number, at:number}>} 家族 → 906 选地最近探到的最好等级与时刻（起点缓存，非候选列表） */
var searchLevel = {};
/** @type {Object<string, number>} MA-5：落点键 "x,y" → 本会话该点被拒次数（达阈值判坐标类拒绝才持久拉黑） */
var rejectByPoint = {};
/** @type {number} 上次推送唤醒的墙钟时刻（毫秒），合并突发（P4） */
var lastPushWakeAt = 0;
/** @type {Object<string, number>} bid → 塔存活时长秒缓存（MAP_BUILDING.duration；查不到存 0） */
var lifeCache = {};

/** @returns {boolean} 功能是否仍在运行 */
function aliveFn() {
  return gateAlive();
}

// ── 纯函数（离线单测口径）─────────────────────────────────────────────
/**
 * 由家族码与等级拼 bid（bid = 塔前缀×1000 + 等级）。
 * @param {number} family 面板资源家族码（7/5/1/16）
 * @param {number} level 等级
 * @returns {number} bid；家族非法返回 0
 */
export function bidFor(family, level) {
  var prefix = TOWER_PREFIX_BY_FAMILY[family];
  if (!prefix) return 0;
  return prefix * 1000 + (level | 0);
}

/**
 * bid → 家族码（floor(bid/1000) 反查）；未知前缀返回 0。
 * @param {number} bid 塔 buildId
 * @returns {number} 家族码或 0
 */
export function familyOfBid(bid) {
  return FAMILY_BY_TOWER_PREFIX[Math.floor(Number(bid) / 1000)] || 0;
}

/**
 * 塔是否「已建成」：st===3 为权威；btime 到期仅作兜底（漏推时也不会永久占位不撤）。
 * @param {{st?:number,btime?:number}|null} tower 塔对象（1031/10182/1034 同构）
 * @param {number} serverSec 服务器当前时刻（秒）
 * @returns {boolean}
 */
export function isBuildComplete(tower, serverSec) {
  if (!tower) return false;
  if ((tower.st | 0) === TOWER_STATE_COMPLETE) return true;
  var bt = Number(tower.btime) || 0;
  return bt > 0 && Number(serverSec) >= bt;
}

/**
 * 家族覆盖判定（纯函数，供单测「家族唯一去重」口径）：逐家族给出「本轮是否需要为它派建」。
 * 已覆盖 = 活表里该族有 st∈{2,3} 的塔且剩余寿命 ≥ buildGuardSec；或账本里该族有一条尚未撤回的建造。
 * @param {Array<object>} towerList 本人塔对象数组（1031 list 形状：{id,bid,st,btime,dur,...}）
 * @param {number[]} wanted 面板勾选的家族码数组
 * @param {Object<string, object>} activeLedger family（字符串键）→ 账本条目（{recalledAt}）
 * @param {number} serverSec 服务器当前时刻（秒）
 * @param {number} guardSec 剩余寿命低于此值（秒）即视为该补建
 * @param {function(number):number} [lifespanFn] bid → 存活时长秒注入（缺省读 MAP_BUILDING.duration；单测用固定表隔离游戏符号依赖）
 * @returns {Object<number, {covered:boolean,reason:string}>} 家族 → 规划结论（只含 wanted 内的家族）
 */
export function planFamilies(towerList, wanted, activeLedger, serverSec, guardSec, lifespanFn) {
  var out = {};
  var list = Array.isArray(towerList) ? towerList : [];
  var hasTower = {}; // family -> {covered, reason}
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var fam = familyOfBid(t && t.bid);
    if (!fam) continue;
    var st = t ? t.st | 0 : 0;
    if (st !== TOWER_STATE_BUILDING && st !== TOWER_STATE_COMPLETE) continue;
    var left = remainingLifeSec(t, serverSec, lifespanFn || lifespanSec);
    if (left != null && left < (guardSec | 0)) {
      // 寿命将尽：仍可被别的家族条目覆盖（同族多塔时保守取「有健康塔者优先」）
      if (!hasTower[fam] || hasTower[fam].reason === 'expiring')
        hasTower[fam] = { covered: false, reason: 'expiring' };
      continue;
    }
    hasTower[fam] = { covered: true, reason: 'alive' };
  }
  var want = Array.isArray(wanted) ? wanted : [];
  for (var w = 0; w < want.length; w++) {
    var f = want[w] | 0;
    if (FAMILIES.indexOf(f) < 0) continue;
    var led = activeLedger && activeLedger[String(f)];
    if (hasTower[f] && hasTower[f].covered) {
      out[f] = { covered: true, reason: 'alive' };
    } else if (led && !led.recalledAt) {
      out[f] = { covered: true, reason: 'building' };
    } else {
      out[f] = hasTower[f]
        ? { covered: false, reason: hasTower[f].reason }
        : { covered: false, reason: 'none' };
    }
  }
  return out;
}

/**
 * 塔剩余寿命（服务器秒）：btime + 存活时长(bid) − serverTime。
 * 存活时长查不到（表未就绪）返回 null（调用方按「未知不拦」处理，绝不当 0 秒误判成到期）。
 * @param {object} tower 塔对象 {bid,btime}
 * @param {number} serverSec 服务器当前时刻（秒）
 * @param {function(number):number} [lifeFn] bid → 存活时长秒（缺省 lifespanSec；单测注入固定表）
 * @returns {number|null}
 */
export function remainingLifeSec(tower, serverSec, lifeFn) {
  var life = (lifeFn || lifespanSec)(Number(tower && tower.bid));
  if (!life) return null;
  var bt = Number(tower && tower.btime) || 0;
  if (!bt) return null;
  var left = bt + life - (Number(serverSec) || 0);
  // MA-1：非负化——到期(<=0)统一压到 0（仍 < guard 判 expiring 触发补建），杜绝负值把择时钉成亚秒空转。
  return left > 0 ? left : 0;
}

/**
 * 塔存活时长（秒，本地表 MAP_BUILDING[bid].duration，带缓存）。实证 dur 字段是耐久/血量、不是寿命。
 * @param {number} bid 塔 buildId
 * @returns {number} 0=查不到
 */
function lifespanSec(bid) {
  if (!bid) return 0;
  var key = String(bid);
  if (lifeCache[key] != null) return lifeCache[key];
  var sec;
  try {
    var row = l10n.tableRow('MAP_BUILDING', bid);
    sec = Number(row && row.duration) || 0;
  } catch (e) {
    sec = 0;
  }
  lifeCache[key] = sec;
  return sec;
}

/**
 * 单塔详情校准（1034 GET_TOWERINFO，id 必传字符串防 Int64 截断）：命中即并入活表。
 * 只在「账本指向的塔在活表里仍判不出建成」时作定点补读，单拍最多 1 发。
 * @param {string} towerId 塔实例 id（字符串）
 * @returns {Promise<boolean>} 是否校准成功
 */
function calibrateTower(towerId) {
  if (!towerId || net.isSending(CMD_GET_TOWERINFO)) return Promise.resolve(false);
  return net
    .send(CMD_GET_TOWERINFO, { id: String(towerId) })
    .then(function (ret) {
      if (!ret || !ret.ok) {
        log.info(
          '1034 rejected (code=%s;data=%s) tower=%s',
          ret && ret.code,
          rejectText(ret) || '-',
          towerId,
        );
        return false;
      }
      var d = parseData(ret.data);
      var t = d && (d.towerInfo || (d.id != null ? d : null));
      if (!t) return false;
      return ingestTower(t);
    })
    .catch(function (err) {
      log.warn('1034 threw. tower=%s %s', towerId, err && err.message);
      return false;
    });
}

// ── 1031 权威列表 ────────────────────────────────────────────────────
/**
 * 把一条塔对象并入活表（叠加式，不清空）。pid 非本人一律忽略（1031 只回本人塔，推送防御性复核）。
 * @param {object} t 塔对象
 * @returns {boolean} 是否并入
 */
function ingestTower(t) {
  if (!t || t.id == null) return false;
  var id = String(t.id);
  var fam = familyOfBid(t.bid);
  if (!fam) return false;
  var me = gameData.myUidStr();
  if (me && t.pid != null && String(t.pid) !== me) return false;
  var pt = t.pt || t.rpt || null;
  var rec = {
    id: id,
    bid: Number(t.bid) || 0,
    family: fam,
    st: t.st | 0,
    x: Number(pt && pt.x) || 0,
    y: Number(pt && pt.y) || 0,
    ct: Number(t.ct) || 0,
    btime: Number(t.btime) || 0,
    lrtime: Number(t.lrtime) || 0,
  };
  towers[id] = rec;
  if (capturing) pushedDuring[id] = rec; // MA-2：1031 在飞期间的推送先缓冲，落地后回灌
  return true;
}

/**
 * 全量拉 1031 → 整表替换活表（权威读；塔被毁不推「删除」，整表替换才能清僵尸条目挡住补建）。
 * MA-2：替换前先开缓冲闸门捕获在飞期间到达的 10182 推送，替换后回灌到权威快照里不存在的条目，防吞推。
 * 单飞去重；永不 reject。
 * @returns {Promise<boolean>} 是否成功落地
 */
function refreshTowers() {
  if (towersInflight) return towersInflight;
  pushedDuring = {};
  capturing = true;
  towersInflight = net
    .send(CMD_GET_TOWER_LIST, {})
    .then(function (ret) {
      capturing = false; // 同步段：置位后立即关掉，权威灌入不再进缓冲
      if (!ret || !ret.ok) {
        log.info(
          '1031 rejected (code=%s;data=%s), keep last snapshot.',
          ret && ret.code,
          rejectText(ret) || '-',
        );
        return false;
      }
      var d = parseData(ret.data) || {};
      var arr = Array.isArray(d.list) ? d.list : [];
      towers = {};
      for (var i = 0; i < arr.length; i++) ingestTower(arr[i]);
      // 回灌缓冲期内到达、却不在本次权威快照里的塔（服务器尚未把它并入 1031 的窗口）
      var pk = Object.keys(pushedDuring);
      for (var j = 0; j < pk.length; j++) if (!towers[pk[j]]) towers[pk[j]] = pushedDuring[pk[j]];
      towersLoaded = true;
      towersLoadedAt = Date.now();
      log.debug('1031 towers=%d (replayed=%d)', Object.keys(towers).length, pk.length);
      return true;
    })
    .catch(function (err) {
      capturing = false;
      log.warn('1031 load failed. %s', err && err.message);
      return false;
    })
    .finally(function () {
      towersInflight = null;
      pushedDuring = {};
    });
  return towersInflight;
}

/**
 * 按需刷新 1031：从未成功或超过 TTL 才发包（在飞复用同一 promise）。
 * @returns {Promise<boolean>}
 */
function refreshTowersIfDue() {
  if (towersLoaded && Date.now() - towersLoadedAt < cfg.towerRefreshMs)
    return Promise.resolve(true);
  return refreshTowers();
}

/**
 * 10182 塔推送（整份塔对象，派建即 st=2、入塔转 st=3）：并入活表。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 * @returns {boolean} 是否命中本人塔
 */
function onTowerPush(ev) {
  var d = ev && ev.data ? ev.data : null;
  if (!d) return false;
  if (Array.isArray(d.list)) {
    var hit = false;
    for (var i = 0; i < d.list.length; i++) hit = ingestTower(d.list[i]) || hit;
    return hit;
  }
  return ingestTower(d);
}

// ── 账本 ─────────────────────────────────────────────────────────────
/** @type {Array<object>} 账本条目数组（family 键对象落盘时的线性形状） */
function ledgerList() {
  var arr = [];
  for (var k in ledger) {
    if (Object.prototype.hasOwnProperty.call(ledger, k)) arr.push(ledger[k]);
  }
  return arr;
}

/** 账本落盘（fire-and-forget）：失败记 warn，内存账本仍是本轮真相。 */
function persistLedger() {
  Promise.resolve(storage.slot.set(LEDGER_NAME, { v: LEDGER_VER, list: ledgerList() })).catch(
    function (err) {
      log.warn('persist ledger failed. %s', err && err.message);
    },
  );
}

/**
 * 从盘回填账本（run 时一次）：版本不符整份作废；回填后由 1031 活表校正「其实早就建成/已毁」的条目。
 * P7：读成功才置 `ledgerLoaded`（失败保留下拍重试机会，防拿空账本 `persistLedger` 覆盖盘上在飞建造）；
 * 在飞 promise 单飞去重，并发 await 者共享同一等待。
 * @returns {Promise<void>}
 */
function loadLedger() {
  if (ledgerLoaded) return Promise.resolve();
  if (ledgerLoading) return ledgerLoading;
  ledgerLoading = Promise.resolve(storage.slot.get(LEDGER_NAME))
    .then(function (saved) {
      ledgerLoading = null;
      ledgerLoaded = true; // 读成功（含「盘上确实为空」）才固化，后续 persist 不再被拦
      if (!saved || typeof saved !== 'object' || saved.v !== LEDGER_VER) return;
      var arr = Array.isArray(saved.list) ? saved.list : [];
      var now = Date.now();
      for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        if (!e || e.family == null || e.marchId == null) continue;
        var ent = {
          family: e.family | 0,
          marchId: String(e.marchId),
          bid: Number(e.bid) || 0,
          towerId: e.towerId == null ? '' : String(e.towerId),
          x: Number(e.x) || 0,
          y: Number(e.y) || 0,
          dispatchedAt: Number(e.dispatchedAt) || 0,
          btime: Number(e.btime) || 0,
          recalledAt: Number(e.recalledAt) || 0,
        };
        // BL-4：回填即剔除「未认领且已超时」的旧档（塔 id 一直没被推送/权威读认领到），防跨重启永久挡住补建
        if (shouldDropLedgerEntry(ent, now, cfg.claimTimeoutMs)) {
          log.info('drop stale ledger on load (recalled/unclaimed-timeout). family=%d', ent.family);
          continue;
        }
        ledger[String(e.family)] = ent;
      }
      if (arr.length) log.debug('ledger reloaded. entries=%d', Object.keys(ledger).length);
    })
    .catch(function (err) {
      ledgerLoading = null; // 不置 ledgerLoaded：下拍重试，不把「读不到」伪装成「盘上为空」
      log.warn('load ledger failed, retry next pass. %s', err && err.message);
    });
  return ledgerLoading;
}

/**
 * 账本条目是否应剔除（纯函数，供单测）：已撤回即时清；未认领（towerId 空）且 dispatchedAt 超上限→判失败清理。
 * 已认领（towerId 非空）但活表消失的情况需 towers 参与，交调用方 reconcileLedger 另行判定。
 * @param {object|null} e 账本条目 {recalledAt,towerId,dispatchedAt}
 * @param {number} nowMs 当前墙上时刻（毫秒）
 * @param {number} timeoutMs 未认领超时上限（毫秒）
 * @returns {boolean} 是否应剔除
 */
export function shouldDropLedgerEntry(e, nowMs, timeoutMs) {
  if (!e) return false;
  if (e.recalledAt) return true;
  if (!e.towerId) {
    var d = Number(e.dispatchedAt) || 0;
    return d > 0 && nowMs - d >= (timeoutMs | 0);
  }
  return false;
}

/**
 * 活表回填后校正账本：塔已不在活表（到期/被毁）、已撤回、或未认领超时（BL-4）的条目就地清理，防账本挡住补建。
 */
function reconcileLedger() {
  var changed = false;
  var now = Date.now();
  for (var k in ledger) {
    if (!Object.prototype.hasOwnProperty.call(ledger, k)) continue;
    var e = ledger[k];
    if (shouldDropLedgerEntry(e, now, cfg.claimTimeoutMs)) {
      // BL-4：已撤回 或 未认领超时（塔 id 一直没被推送/权威读认领到）→ 清理，让下一拍补建，防永久挡
      log.info(
        'ledger dropped (%s). family=%d marchId=%s',
        e.recalledAt ? 'recalled' : 'unclaimed-timeout',
        e.family,
        e.marchId || '?',
      );
      delete ledger[k];
      changed = true;
      continue;
    }
    var t = e.towerId ? towers[e.towerId] : null;
    if (e.towerId && !t) {
      // 塔实例已从权威列表消失 → 这条建造已无意义（到期/被毁），删账本让下一拍补建
      log.info('build gone (tower %s not in 1031). family=%d', e.towerId, e.family);
      delete ledger[k];
      changed = true;
    }
  }
  if (changed) persistLedger();
}

// ── 选地与派建 ───────────────────────────────────────────────────────
/**
 * 该家族当前该建的那座 bid（BL-2 规则 R1）：只认机械大师职业读数（getBuffDataById().Value 直接给完整 bid）。
 * 取不到（非机械大师/等级不够/Buff 未同步）或前缀与家族不符（ACL 语义漂移）一律返回 0 不兼底——
 * 兼底=明知不该发还发；四族全 0 由 cyclePass 的 R1 闸按 idle 处理。
 * @param {number} family 家族码
 * @returns {number} bid；0=不可建（非机械大师/读数非法）
 */
export function buildBidFor(family) {
  var prefix = TOWER_PREFIX_BY_FAMILY[family];
  if (!prefix) return 0;
  var raw = gameData.buffValueById(BUFF_ID_BY_FAMILY[family]);
  if (!raw) return 0;
  if (Math.floor(raw / 1000) !== prefix) {
    log.warn(
      'buff value %s mismatch family %d prefix %d, refuse to build (R1).',
      raw,
      family,
      prefix,
    );
    return 0;
  }
  return raw;
}

/**
 * 落点判据（纯函数口径，规则 R2）：pointType=4 资源田 & itemId 属该家族组 & 无主（ownerId '0'/空）
 *   & 无联盟归属（aid '0'/空 && allianceAreaOwner 0）。遗迹田 pt≠4、他人机械田 pt=24 天然被排除。
 *   实证四次建塔落点全部满足该组合。
 * @param {object} p 901 pointList 单点
 * @param {number} family 家族码
 * @returns {boolean}
 */
export function isFreeField(p, family) {
  if (!p || (p.pointType | 0) !== POINT_TYPE_FIELD) return false;
  var r = p.r;
  if (!r) return false;
  var itemId = Number(r.itemId) || 0;
  if (!itemId || Math.floor(itemId / 100) !== FIELD_GROUP_BY_FAMILY[family]) return false;
  var owner = r.ownerId == null ? '0' : String(r.ownerId);
  if (owner !== '0' && owner !== '') return false;
  var aid = r.aid == null ? '0' : String(r.aid);
  if (aid !== '0' && aid !== '') return false;
  if (Number(r.allianceAreaOwner) > 0) return false;
  return true;
}

/**
 * 家族 906 选地的等级起点（纯策略）：TTL 内用缓存的最好等级，否则从 RESOURCE_MAX_LEVEL 满档起。
 * @param {number} family 家族码
 * @returns {number} 起始等级（含）
 */
function searchStartLevel(family) {
  var c = searchLevel[family];
  if (!c) return resource.RESOURCE_MAX_LEVEL;
  if (Date.now() - (c.at || 0) > cfg.searchTtlMs) return resource.RESOURCE_MAX_LEVEL;
  return Math.max(1, Math.min(resource.RESOURCE_MAX_LEVEL, c.level | 0));
}

/**
 * 为一个家族搜一个可建落点（R2/R3，906 逐级降序）：从起点等级往下问服务端，
 *   首个通过「未拉黑 + isFreeField」的点即返回并刷新等级缓存。永不 reject。
 *   906 每级只回一个点：拉黑点/isFreeField 不通过/该级无回点 → 降级重问；isSending 命中 → 本拍直接让路（不降级狂发）。
 * @param {number} family 家族码
 * @returns {Promise<{x:number,y:number,itemId:number,level:number}|null>} itemId 即 RESOURCE 行 id
 */
async function searchBuildPoint(family) {
  if (!net) return null;
  var fieldGroup = FIELD_GROUP_BY_FAMILY[family];
  var start = searchStartLevel(family);
  for (var lv = start; lv >= 1; lv--) {
    var gid = resource.groupTypeFor(fieldGroup, lv);
    if (!gid) continue; // 该族该级无 RESOURCE 行（如雷神 4/5 级）：天花板由表隐式表达，不发包
    var res = await map.searchPoint(net, {
      minLevel: lv,
      maxLevel: lv,
      groupType: gid,
      pointType: SEARCH_POINT_TYPE_RESOURCE,
    });
    var pt = res.point;
    if (!pt) {
      if (!res.sent) return null; // 906 同号在途/发送异常：本拍让路，下拍重试（不降级狂发）
      continue; // 本级无回点/业务拒绝：降一级重问
    }
    var key = (pt.x | 0) + ',' + (pt.y | 0);
    var bl = pointBlacklist[key];
    if (bl && bl > Date.now()) continue; // 该坐标已拉黑：换下一等级重搜
    if (!isFreeField(pt, family)) continue; // R2 谓词复核（ownerId/aid/allianceAreaOwner/pt）
    searchLevel[family] = { level: lv, at: Date.now() };
    return { x: pt.x | 0, y: pt.y | 0, itemId: gid, level: lv };
  }
  return null;
}

/**
 * 记一次落点被拒（MA-5）：同一坐标连续被拒达阈值才判「坐标类拒绝」并持久拉黑；单次拒绝多为全局因（造价/上限），只族冷却。
 * @param {{x:number,y:number}} pt 落点
 */
function registerRejectPoint(pt) {
  var key = pt.x + ',' + pt.y;
  var n = (rejectByPoint[key] || 0) + 1;
  rejectByPoint[key] = n;
  if (n >= cfg.rejectSamePointBlacklistAfter) {
    pointBlacklist[key] = Date.now() + cfg.pointBlacklistMs;
    log.info(
      'point (%d,%d) rejected %d×, blacklist %dms (placement-class reject).',
      pt.x,
      pt.y,
      n,
      cfg.pointBlacklistMs,
    );
  }
}

/**
 * 发 1033 建塔（报文键集与实证逐键一致：无 break/extraArmy，armyList 与 armyListNew 同引用）。
 * @param {number} family 家族码
 * @param {number} bid 塔 buildId
 * @param {{x:number,y:number}} pt 落点
 * @param {object} data Battle().plan().minimal().build() 的 MarchData
 * @returns {Promise<object>} net.Ret
 */
function sendBuild(family, bid, pt, data) {
  // MA-6：pause 后在飞流程不得再发写请求（统一用哨兵码交调用方判「未发出」）
  if (!aliveFn()) return Promise.resolve({ ok: false, code: CODE_NOT_SENT, data: null });
  var army = Array.isArray(data.armyListNew) ? data.armyListNew : [];
  var body = {
    marchType: MARCH_TYPE_BUILD,
    x: pt.x,
    y: pt.y,
    armyList: army,
    armyListNew: army,
    heroList: Array.isArray(data.heroList) ? data.heroList : [],
    trapList: Array.isArray(data.trapList) ? data.trapList : [],
    buildId: bid,
    formation: 0,
    skinId: 0,
    formationV2: data.formationV2 | 0,
  };
  if (net.isSending(CMD_MARCH_WORLD_BUILD)) {
    log.debug('1033 already in flight, skip family=%d', family);
    // MA-4：同号在途属「未发出」而非业务拒绝，用哨兵码区分，调用方不拉黑/不冷却/不计 streak
    return Promise.resolve({ ok: false, code: CODE_NOT_SENT, data: null });
  }
  return net
    .send(CMD_MARCH_WORLD_BUILD, body)
    .then(function (ret) {
      return ret || { ok: false, code: CODE_NOT_SENT, data: null };
    })
    .catch(function (err) {
      log.warn('1033 send threw. family=%d %s', family, err && err.message);
      return { ok: false, code: CODE_NOT_SENT, data: null };
    });
}

/**
 * 派建一个家族：职业等级 → 名额闸 → 906 选地 → 1033 → 记账本。
 * @param {number} family 家族码
 * @returns {Promise<'built'|'rejected'|'noop'|'blocked'>} 本派结果（built=已发 1033 且成功）
 */
function dispatchBuild(family) {
  var bid = buildBidFor(family);
  if (!bid) {
    // BL-2 R1：此家族无机械大师职业读数（非机械大师/等级不够）——不兼底盲建，info 后跳过该族（不 warn）
    log.info('no mech-master bid for family=%d (R1), skip', family);
    return Promise.resolve('blocked');
  }
  // MA-5：源码实证本地闸（NWorldResourcePopup：Level<DATACONFIG[11001].value 直接 tips 100483 不发 1033）
  var thr = Number(gameConf.dataConfig(BUILD_LEVEL_CFG_ID)) || 0;
  if (thr && (gameData.level() | 0) < thr) {
    log.info(
      'player level %d < build gate %d (cfg %d), family=%d skip',
      gameData.level() | 0,
      thr,
      BUILD_LEVEL_CFG_ID,
      family,
    );
    return Promise.resolve('blocked');
  }
  if (march.freeSlots() <= 0) {
    log.debug('no free march slot, skip family=%d', family);
    return Promise.resolve('noop');
  }
  var data = new Battle().plan().minimal().build();
  if (!data || !Array.isArray(data.armyListNew) || !data.armyListNew.length) {
    log.info('no available single army, family=%d skipped', family);
    return Promise.resolve('noop');
  }
  return searchBuildPoint(family).then(function (pt) {
    if (!pt) return 'noop';
    if (!aliveFn()) return 'noop'; // MA-6：选地是异步的，pause 后不得再发写请求
    return sendBuild(family, bid, pt, data).then(function (ret) {
      // MA-4：未发出（同号在途/发送异常）不是业务拒绝，不拉黑/不冷却/不计 streak，本拍让路下拍重试
      if (ret && ret.code === CODE_NOT_SENT) {
        log.debug('1033 not sent (in flight/failed to emit), family=%d retry next pass', family);
        return 'noop';
      }
      if (!ret || !ret.ok) {
        registerRejectPoint(pt); // MA-5：同点反复被拒才持久拉黑，令下一拍 906 搜索跳过该坐标、降级重搜
        familyCooldown[family] = Date.now() + cfg.familyCooldownMs;
        rejectStreak++;
        log.info(
          'build rejected. family=%d(%s) bid=%d at (%d,%d) code=%s streak=%d',
          family,
          FAMILY_LABEL[family],
          bid,
          pt.x,
          pt.y,
          ret && ret.code,
          rejectStreak,
        );
        return 'rejected';
      }
      var mi = (parseData(ret.data) || {}).marchInfo || {};
      var marchId = mi.marchId == null ? '' : String(mi.marchId);
      var item = (mi.target && mi.target.itemId) || 0;
      ledger[String(family)] = {
        family: family,
        marchId: marchId,
        bid: bid,
        towerId: '', // 塔 id 由 10182/1031 推送按 (x,y) 认领；BL-4：认领超时见 reconcileLedger
        x: pt.x,
        y: pt.y,
        dispatchedAt: Date.now(),
        btime: Number(mi.gatherStartTime) || 0,
        recalledAt: 0,
      };
      rejectStreak = 0;
      persistLedger();
      log.info(
        'build dispatched. family=%s bid=%d at (%d,%d) marchId=%s target.itemId=%d arrive=%s',
        FAMILY_LABEL[family],
        bid,
        pt.x,
        pt.y,
        marchId || '?',
        item,
        mi.marchArrive || 0,
      );
      return 'built';
    });
  });
}

/**
 * 按落点认领塔实例 id：活表里坐标一致、bid 家族匹配、尚未被别的账本占用的条目。
 * @param {object} e 账本条目
 * @returns {string} 塔 id（字符串），''=未认领
 */
function claimTowerId(e) {
  for (var id in towers) {
    if (!Object.prototype.hasOwnProperty.call(towers, id)) continue;
    var t = towers[id];
    if (t.x !== e.x || t.y !== e.y) continue;
    if (t.bid !== e.bid && familyOfBid(t.bid) !== e.family) continue;
    var taken = false;
    for (var k in ledger) {
      if (Object.prototype.hasOwnProperty.call(ledger, k) && ledger[k].towerId === id) taken = true;
    }
    if (taken) continue;
    return id;
  }
  return '';
}

/**
 * 建成即撤一轮：认领塔 id → 塔 st===3（或 btime 到期兜底）→ 904 撤回 → 落 recalledAt。
 * 单拍最多发 1 发 1034（只在推送/权威读都没给出 st 时用于校准）。
 * @param {number} serverSec 服务器当前时刻（秒）
 * @returns {Promise<number>} 下一次需要复查撤回的墙上间隔（毫秒），0=无在飞建造
 */
function recallPass(serverSec) {
  var keys = Object.keys(ledger);
  var inflight = 0;
  var soonest = 0;
  var jobs = [];
  var calibrate = null;
  for (var i = 0; i < keys.length; i++) {
    var e = ledger[keys[i]];
    if (!e || e.recalledAt) continue;
    inflight++;
    if (!e.towerId) {
      var claimed = claimTowerId(e);
      if (claimed) {
        e.towerId = claimed;
        persistLedger();
      }
    }
    var t = e.towerId ? towers[e.towerId] : null;
    if (!isBuildComplete(t, serverSec)) {
      // 活表/推送都没给出建成态（漏推或快照陈旧）：记一条待 1034 定点校准的塔（单拍最多 1 发）
      if (e.towerId && !calibrate) calibrate = e.towerId;
      continue;
    }
    if (!e.marchId) {
      log.warn('tower complete but marchId missing, family=%d (wait next 1031)', e.family);
      continue;
    }
    jobs.push(e);
  }
  var pre = calibrate ? calibrateTower(calibrate) : Promise.resolve(false);
  return pre.then(function (fixed) {
    if (fixed) {
      // 校准命中后重新评一轮：本拍就能把「已建成」的塔拉撤，不留到下一拍
      for (var j = 0; j < keys.length; j++) {
        var e2 = ledger[keys[j]];
        if (!e2 || e2.recalledAt || !e2.towerId || !e2.marchId) continue;
        if (jobs.indexOf(e2) >= 0) continue;
        if (isBuildComplete(towers[e2.towerId], serverSec)) jobs.push(e2);
      }
    }
    if (!jobs.length) return inflight ? cfg.buildPollMs : 0;
    var one = jobs.shift(); // 单拍最多 1 发 904，余下下拍继续
    return march.recall(one.marchId).then(function (ret) {
      if (ret && ret.ok) {
        // 塔仍留在活表（实证撤回后盟友照常来采），家族覆盖由 1031 自然维持
        delete ledger[String(one.family)];
        persistLedger();
        log.info(
          'built and recalled. family=%s tower=%s at (%d,%d) marchId=%s',
          FAMILY_LABEL[one.family],
          one.towerId || '?',
          one.x,
          one.y,
          one.marchId,
        );
      } else {
        log.info(
          'recall rejected (retry next pass). marchId=%s code=%s',
          one.marchId,
          ret && ret.code,
        );
      }
      soonest = Object.keys(ledger).length ? cfg.buildPollMs : 0;
      if (jobs.length) return Math.min(soonest || cfg.buildPollMs, 1000 * 5);
      return soonest;
    });
  });
}

/**
 * 取消全部在建塔（停用 / 时段外）。调用方必须先 `await refreshTowers()`（P3）把权威活表拉起来，再进本函数。
 *
 * 口径：
 *  • **先复核施工态**（P1）：账本指向的塔在权威活表里已建成（st=3 或 btime 到期）→ **绝不发 1032**
 *    （已建成塔要保留给联盟采集），只把条目从账本摘掉，单兵交回 recallPass 走 904；
 *  • 数据源 = 账本条目 ∪ 活表里「st=2 且家族∈勾选」的塔（P3：账本被认领超时清理、或塔在关窗前刚成形时，
 *    真相只在活表里，光追账本会漏塔）；
 *  • 逐条发包都判应答（P2）：`net.isSending` 先让路（未发出≠业务拒，不删条目不计成功）；`ret.ok` 成立才销账本
 *    并即时落盘（P8：不拖到循环末尾，免早退路径留下内存/磁盘分歧而重放）；被拒则保留条目 + 族冷却下拍重试；
 *  • 塔未成形（无 towerId）但有 marchId → 退 904 撤那条建造行军（同样判 ok）；两者皆空 → 直接清。
 * 永不 reject。逐条间隔 `sleep` 拉开，避免「操作过快」。
 * @param {number} serverSec 服务器当前时刻（秒），供建成态兜底判据
 * @returns {Promise<number>} 本轮成功发起取消的在建数（0 且账本已排空→完成）
 */
async function cancelAllBuilds(serverSec) {
  // 1) 先按权威 1031 给账本条目定性（P1/P11）：只有「权威表里确认还在、且 st=2」的塔才是取消对象。
  //    已建成（st=3）与「查无此塔」（游戏侧早已拆/到期/被毁）都只摘账本，绝不发 1032。
  var keys = Object.keys(ledger);
  for (var i = 0; i < keys.length; i++) {
    var en = ledger[keys[i]];
    if (!en || en.recalledAt || !en.towerId) continue;
    var ct = towers[en.towerId];
    if (!ct) {
      log.info(
        'tower absent from authoritative 1031 (already removed/expired) → drop ledger, no 1032. family=%s tower=%s',
        FAMILY_LABEL[en.family],
        en.towerId,
      );
      delete ledger[keys[i]];
      persistLedger();
      continue;
    }
    if (!isBuildComplete(ct, serverSec)) continue;
    log.info(
      'tower already complete (st=3) → keep for alliance gather, drop from ledger. family=%s tower=%s',
      FAMILY_LABEL[en.family],
      en.towerId,
    );
    delete ledger[keys[i]];
    persistLedger();
  }
  // 2) 构造取消清单：账本在建条目（同样需活表背书）∪ 活表内「st=2 且家族∈勾选」的塔
  var jobs = [];
  keys = Object.keys(ledger);
  for (var a = 0; a < keys.length; a++) {
    var e = ledger[keys[a]];
    if (!e || e.recalledAt) continue;
    if (!e.towerId) {
      var claimed = claimTowerId(e);
      if (claimed) {
        e.towerId = claimed;
        persistLedger();
      }
    }
    if (e.towerId) {
      var wt = towers[e.towerId];
      if (!wt) {
        // 本轮刚认领到的塔不在权威表里（塔已在游戏侧消失）：同样只摘账本，不发 1032
        log.info(
          'tower absent from authoritative 1031 right after claim → drop ledger, no 1032. family=%s tower=%s',
          FAMILY_LABEL[e.family],
          e.towerId,
        );
        delete ledger[keys[a]];
        persistLedger();
        continue;
      }
      // st=3 保留（上一步已剔），其它非在建态（如 1=拆除中）不反复销毁，交下拍权威读自然清
      if ((wt.st | 0) !== TOWER_STATE_BUILDING) continue;
    }
    jobs.push({
      key: keys[a],
      towerId: e.towerId || '',
      marchId: e.marchId || '',
      family: e.family,
    });
  }
  var held = {};
  for (var b = 0; b < jobs.length; b++) if (jobs[b].towerId) held[jobs[b].towerId] = 1;
  for (var id in towers) {
    if (!Object.prototype.hasOwnProperty.call(towers, id)) continue;
    var t = towers[id];
    if ((t.st | 0) !== TOWER_STATE_BUILDING) continue; // 只消在建；st=3 已明确保留
    if (!isWanted(t.family)) continue;
    if (held[id]) continue; // 已由账本条目代表，不重复
    jobs.push({ key: null, towerId: id, marchId: '', family: t.family });
  }
  // 3) 逐条发起取消（1032 优先；未成形退回 904 撤建造行军）
  var n = 0;
  for (var c = 0; c < jobs.length; c++) {
    if (!aliveFn()) return n; // 收手即返：已确认成功的条目已逐条落盘（P8）
    var job = jobs[c];
    // 族冷却闸：同族上一条被拒后不连发（本引擎逐条置 cooldown 于被拒分支，既拦下拍重发也拦本拍同族后继条目）
    if (familyCooldown[job.family] && familyCooldown[job.family] > Date.now()) {
      log.debug(
        'cancel deferred (family cooldown). family=%s tower=%s',
        FAMILY_LABEL[job.family],
        job.towerId || '-',
      );
      continue;
    }
    var done = await cancelOneBuild(job);
    if (!done.ok) {
      if (done.sent) {
        // 可预期业务拒（info）：保留账本条目 + 族冷却，下拍重试；不销位就不会丢跟踪（塔建成后的撤单兵靠它）
        var tries = (cancelRejectStreak[job.family] | 0) + 1;
        cancelRejectStreak[job.family] = tries;
        // 同一族反复撞同一拒时指数退避封顶（防“拆不掉的塔”把 1032 钉成高频长跑）
        familyCooldown[job.family] =
          Date.now() +
          Math.min(cfg.cancelRetryMs * (1 << Math.min(tries - 1, 9)), cfg.cancelRetryMaxMs);
        log.info(
          'cancel rejected (%s, retry after backoff). family=%s tower=%s marchId=%s code=%s msg=%s streak=%d',
          done.via,
          FAMILY_LABEL[job.family],
          job.towerId || '-',
          job.marchId || '-',
          done.ret && done.ret.code,
          rejectHint(done.ret),
          tries,
        );
      }
      if (c < jobs.length - 1) await sleep(1000 * 2);
      continue;
    }
    n++; // 只统计受理成功的（未发出/被拒已在上面分支continue）
    cancelRejectStreak[job.family] = 0;
    if (job.key != null) delete ledger[job.key]; // 活表残留的 st=2 条目交 1031/10182 自然清，不摸内存表
    persistLedger(); // P8：确认成功即落盘
    log.info(
      'cancel in-progress build (%s). family=%s tower=%s marchId=%s',
      done.via,
      FAMILY_LABEL[job.family],
      job.towerId || '-',
      job.marchId || '-',
    );
    if (c < jobs.length - 1) await sleep(1000 * 2);
  }
  return n;
}

/**
 * 取消被拒的服务器拒因 → 一行可读串（报文实证：code=0 时 1032 回执 data 为 '{}'，非零时 data 携带语言键裸串）。
 * 只走 l10n.net 译中，查不到回原文；空回执显式标出——免得到手日志只剩一个光秃秃的 code=3 而无拒因。
 * @param {object|null} ret net.Ret
 * @returns {string}
 */
function rejectHint(ret) {
  if (!ret) return '-';
  var raw =
    ret.reason != null && ret.reason !== ''
      ? String(ret.reason)
      : String(ret.data == null ? '' : ret.data).trim();
  if (!raw || raw === '{}') return '(empty payload)';
  var zh = l10n.net(raw);
  return zh && zh !== raw ? zh + '(' + raw + ')' : raw;
}

/**
 * 单条取消发起（cancelAllBuilds 的发包分派子步）：已有 towerId → 1032 TOWER_REMOVE；仅 marchId → 904 撤建造行军；
 * 两者皆空 → 不发包（由调用方直接销位）。同号在途（`net.isSending`）按「未发出」让路，不当业务拒。
 * @param {{towerId:string, marchId:string}} job 取消清单条目
 * @returns {Promise<{sent:boolean, ok:boolean, via:string, ret:object|null}>}
 */
async function cancelOneBuild(job) {
  if (job.towerId) {
    if (net.isSending(CMD_TOWER_REMOVE)) {
      log.debug('1032 already in flight, defer tower=%s to next pass', job.towerId);
      return { sent: false, ok: false, via: '1032', ret: null }; // 未发出≠业务拒：不销账本、不计成功
    }
    // 漏防修复：裸 await net.send 在投递失败/超时/回调异常时会 reject 打穿 cycle 异常路。
    // 对齐 906 路既定策略「发送异常＝本拍让路、下拍重试、不计业务拒」：sendGuarded 自愈为哨兵，threw 记号转 sent:false。
    var threw = false;
    var ret = await net.sendGuarded(
      CMD_TOWER_REMOVE,
      { id: String(job.towerId) },
      {
        gate: false,
        onError: function (err) {
          log.warn(
            '1032 send error, defer tower=%s to next pass. %s',
            job.towerId,
            err && err.message,
          );
          threw = true;
        },
      },
    );
    if (threw) return { sent: false, ok: false, via: '1032', ret: null }; // 未发出≠业务拒：不销账本、不计拒因冷却
    return { sent: true, ok: !!(ret && ret.ok), via: '1032', ret: ret };
  }
  if (job.marchId) {
    var r = await march.recall(job.marchId);
    return { sent: true, ok: !!(r && r.ok), via: '904', ret: r };
  }
  return { sent: false, ok: false, via: '-', ret: null };
}

// ── 周期主体 ─────────────────────────────────────────────────────────
/**
 * 一拍：准入/场景闸 → 1031 刷新 → 账本校正 → 建成撤回 → 家族规划 → 逐家族补建。
 * @returns {Promise<number>} 下一次睡眠毫秒（<=0 立即再跑）
 */
async function cyclePass() {
  if (!screen(getUid())) return cfg.idleScanMs;
  // 时段/启用闸（宿主 autoFarm 的「下田时段」）：子功能关闭、或时段生效且当前不在时段内 → 不新建，
  // 并把所有在建塔（st=2）逐座 1032 取消；**已建成（st=3）塔显式跳过**，保留给联盟采集。
  var allowed = MCFG.enabled && (!gate.active() || gate.isIn());
  if (!allowed) {
    // P3：先拉权威 1031（纯只读发包）再做取消判定——towers 空时 claimTowerId 恒失败，
    // 已成形塔会被错退到 904（实证对建造行军的 904 常被服务器拒），且账本外的 st=2 塔会漏消。
    // P11：且**只在 1031 成功落地的那一拍才允许取消**——刚进入游戏/网络抖动时 towers 是空表或旧表，
    // 此时按跨会话账本盲发 1032，会把服务器侧早已拆掉的僵尸条目当在建反复重发（实证被拒 code=3 刷屏）。
    var auth = await refreshTowers();
    if (!aliveFn()) return 0;
    if (!auth) {
      log.debug('cancel deferred (authoritative 1031 not landed yet).');
      return cfg.towerRetryMs;
    }
    var cancelled = await cancelAllBuilds(gameData.serverTime() | 0);
    if (!aliveFn()) return 0;
    // 仍有在建未消成（被拒/同号在途）→ 短间隔复查，别睡过整个窗口；
    // 已排空且仍启用但时段外 → 睡向下个时段起点（到点自动恢复建塔）；纯停用 → idle 兜底
    if (cancelled > 0 || Object.keys(ledger).length > 0) {
      return Math.max(cfg.windowSleepMinMs, Math.min(cfg.buildPollMs, cfg.towerRetryMs));
    }
    if (MCFG.enabled && gate.active() && !gate.isIn()) {
      var resume = gate.msToStart();
      if (resume > 0) return Math.max(cfg.windowSleepMinMs, Math.min(resume, cfg.windowSleepMaxMs));
    }
    return cfg.idleScanMs;
  }
  if (!MCFG.families.length) return cfg.idleScanMs;
  // BL-2 R1：机械大师职业闸门。软符号缺失或所选家族均无职业读数 → 整轮不派建（非机械大师/未同步），按 idle 睡。
  if (!checkCap('buffValue')) {
    log.warn('profession buff symbol unavailable (R1), mechBuild idle.');
    return cfg.idleScanMs;
  }
  var profSeen = false;
  for (var pf = 0; pf < MCFG.families.length; pf++) {
    if (gameData.buffValueById(BUFF_ID_BY_FAMILY[MCFG.families[pf]])) {
      profSeen = true;
      break;
    }
  }
  if (!profSeen) {
    // 循环态（没机械大师职业 buff 就一直建不了）：按日志规范走 debug，不占 info——面板每改一次勾选都会起一轮，info 会刷屏
    log.debug('no mech-master profession buff for selected families (R1), idle.');
    return cfg.idleScanMs;
  }
  var home = gameData.myWorldPos();
  if (!home) {
    log.debug('no world position (not in world scene), skip pass');
    return cfg.idleScanMs;
  }
  var refreshed = await refreshTowersIfDue();
  if (!aliveFn()) return 0;
  if (!refreshed && !towersLoaded) return cfg.towerRetryMs; // 权威列表还没建立：不派建，防家族唯一性误判
  reconcileLedger();
  var serverSec = gameData.serverTime() | 0;
  var recallDelay = await recallPass(serverSec);
  if (!aliveFn()) return 0;

  var list = [];
  for (var id in towers) {
    if (Object.prototype.hasOwnProperty.call(towers, id)) list.push(towers[id]);
  }
  var plan = planFamilies(list, MCFG.families, ledger, serverSec, MCFG.buildGuardSec);
  var now = Date.now();
  var expiring = nextExpiryDelayMs(list, serverSec);
  var dispatched = 0;
  for (var i = 0; i < FAMILIES.length; i++) {
    var f = FAMILIES[i];
    var p = plan[f];
    if (!p) continue;
    if (p.covered) {
      log.debug('family=%d(%s) covered: %s', f, FAMILY_LABEL[f], p.reason);
      continue;
    }
    if (dispatched) continue; // 单拍最多 1 发 1033
    if (familyCooldown[f] && familyCooldown[f] > now) {
      log.debug(
        'family=%d(%s) in cooldown until %s',
        f,
        FAMILY_LABEL[f],
        new Date(familyCooldown[f]).toLocaleTimeString(),
      );
      continue;
    }
    var r = await dispatchBuild(f);
    if (!aliveFn()) return 0;
    if (r === 'built') {
      dispatched++;
    }
    // BL-3：noop/blocked/rejected 一律 continue 试下一家族（单拍 1 发 1033 由 dispatched 闸保证），不 break 放弃后续家族。
  }
  // 睡眠 = min(撤回复查, 到期补建, 派建后立即重排, idle 兜底)；连续被拒退避翻倍
  var delay = cfg.idleScanMs;
  if (dispatched) delay = Math.min(delay, 1000 * 10);
  if (recallDelay > 0) delay = Math.min(delay, recallDelay);
  if (expiring > 0) delay = Math.min(delay, expiring);
  var hasInflight = Object.keys(ledger).length > 0;
  if (!dispatched && !hasInflight && expiring <= 0) delay = cfg.idleScanMs;
  if (rejectStreak >= cfg.rejectStreakBackoff) delay = Math.min(delay * 2, cfg.idleScanMs * 4);
  return Math.max(0, Math.floor(delay));
}

/**
 * 最近的「塔到期补建」时刻（毫秒）。剩余寿命 < buildGuardSec 的塔即刻（返回 1s，交由家族规划补建）。
 * @param {Array<object>} list 活表塔数组
 * @param {number} serverSec 服务器当前时刻（秒）
 * @returns {number} 0=没有需要盯的到期塔
 */
function nextExpiryDelayMs(list, serverSec) {
  var best = 0;
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if ((t.st | 0) !== TOWER_STATE_COMPLETE) continue;
    if (FAMILIES.indexOf(t.family) < 0) continue;
    if (!isWanted(t.family)) continue;
    var left = remainingLifeSec(t, serverSec);
    if (left == null) continue;
    if (left < MCFG.buildGuardSec) return cfg.minExpiryDelayMs;
    if (best === 0 || left < best) best = left;
  }
  return best > 0 ? Math.max(cfg.minExpiryDelayMs, (best - MCFG.buildGuardSec) * 1000) : 0;
}

/**
 * 面板家族多选 → 合法家族白名单裁剪去重（单一归一入口，由宿主 autoFarm 的 toModuleCfg 调用）。
 * @param {Array<number|string>} raw 面板原始家族数组
 * @returns {number[]} 裁剪后的家族码数组（只保留 FAMILIES 内、去重）
 */
export function normalizeMechFamilies(raw) {
  var fams = Array.isArray(raw) ? raw : [];
  var picked = [];
  for (var i = 0; i < fams.length; i++) {
    var f = fams[i] | 0;
    if (FAMILIES.indexOf(f) >= 0 && picked.indexOf(f) < 0) picked.push(f);
  }
  return picked;
}

/**
 * 家族是否被面板勾选。
 * @param {number} family 家族码
 * @returns {boolean}
 */
function isWanted(family) {
  return MCFG.families.indexOf(family) >= 0;
}

/** @type {{kick: function(), pending: boolean, wakeAt: number, inFlight: boolean}} 建造调和循环 */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.idleScanMs,
});

/**
 * 统一 kick 出口：起一轮前打一行 debug 交代触发缘由与「被掐掉的排程」（与宿主 autoFarm 同口径）。
 * 本引擎的 10182 唤醒不设去抖，「说好睡 300s 却每秒一轮」只能靠缘由看是不是推送在风暴。
 * @param {string} why 触发缘由（进日志）
 */
function kick(why) {
  var wakeIn = cycle.wakeAt ? Math.round((cycle.wakeAt - Date.now()) / 1000) : 0;
  log.debug(
    'kick: %s (%s).',
    why,
    cycle.inFlight
      ? 'in flight → pending'
      : wakeIn
        ? 'cutting sleep ' + wakeIn + 's'
        : 'no sleep armed',
  );
  cycle.kick();
}

/** @returns {Promise<number>} 循环入口（MA-3：在飞期间的触发靠返回 0 补扫） */
function cycleRun() {
  return cyclePass().then(function (delay) {
    // MA-3：本轮在飞期间若有新触发（cycle.pending），返回 0 让驱动器立即补扫，契约见 core/cycle.js L10。
    return cycle.pending ? 0 : delay;
  });
}

/**
 * 安装（宿主 autoFarm 在 install 中调用）：注入网络底座、运行态探针 alive、下田时段闸 gate。
 * 缺 net 即失败（不激活）；alive/gate 缺失时回退默认（恒不在场 / 全天在窗）。
 * @param {{net:object, alive:function():boolean, gate?:{active:Function,isIn:Function,msToStart:Function}}} o
 * @returns {boolean}
 */
function install(o) {
  if (installed) return true;
  if (!o || !o.net) {
    log.warn('install failed. missing=net');
    return false;
  }
  net = o.net;
  if (typeof o.alive === 'function') gateAlive = o.alive;
  if (o.gate) {
    if (typeof o.gate.active === 'function') gate.active = o.gate.active;
    if (typeof o.gate.isIn === 'function') gate.isIn = o.gate.isIn;
    if (typeof o.gate.msToStart === 'function') gate.msToStart = o.gate.msToStart;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入（宿主 autoFarm 在 configure 中转发）：取 toModuleCfg 产物里的 mechBuildEnabled/mechBuildFamilies；
 * 运行中即时唤醒让新配置生效。取消在建**只在引擎仍运行时发生**（宿主整卡关掉的停用路径 cycle 已停摆，不保证取消）。
 * @param {object} partial 宿主转发的已归一配置
 * @returns {object} MCFG
 */
function configure(partial) {
  if (!partial) return MCFG;
  // partial 是宿主 toModuleCfg 产物：mechBuildEnabled(bool)、mechBuildFamilies(已归一家族码数组)
  MCFG = {
    enabled: !!partial.mechBuildEnabled,
    families: Array.isArray(partial.mechBuildFamilies) ? partial.mechBuildFamilies.slice() : [],
    buildGuardSec: cfg.buildGuardSec,
  };
  if (installed && aliveFn()) kick('configure (host panel push)');
  return MCFG;
}

/**
 * 运行（宿主 autoFarm 在 run 中调用）：复位全部内存态 → 挂 10182/10452 推送 → 读回账本后点火。
 * 复用宿主 ctx：ctx.on.push 的退订由 reactor 在宿主 pause 时统一摘除（本引擎不自记 off）。
 * @param {object} ctx 宿主 autoFarm 的 reactor 上下文
 */
function run(ctx) {
  towers = {};
  towersLoaded = false;
  towersInflight = null;
  towersLoadedAt = 0;
  capturing = false;
  pushedDuring = {};
  ledger = {};
  ledgerLoaded = false;
  ledgerLoading = null;
  familyCooldown = {};
  cancelRejectStreak = {};
  pointBlacklist = {};
  rejectStreak = 0;
  searchLevel = {};
  rejectByPoint = {};
  lastPushWakeAt = 0;
  ctx.on.push(CMD_PUSH_TOWER, onTowerPushEvent);
  ctx.on.push(CMD_PUSH_ALLIANCE_RECORD, onAllianceRecordPush);
  log.info(
    'started (enabled=%s, families=%s).',
    MCFG.enabled ? 'on' : 'off',
    MCFG.families.join('/') || 'none',
  );
  loadLedger().then(function () {
    if (!aliveFn()) return;
    kick('run (ledger restored)');
  });
}

/**
 * 10182 推送处理：命中本人塔即并入活表并唤醒（建成/开工状态跃迁是撤回时机的唯一即时来源）。
 * @param {object} ev net 推送事件
 */
function onTowerPushEvent(ev) {
  if (!aliveFn()) return;
  if (onTowerPush(ev)) kick('10182 tower push (own tower)');
}

/**
 * 10452 联盟记录增量推送：只当「活表可能变了」的信号（建塔/毁塔事件），触发权威 1031 重拉。
 * P4：与宿主 autoFarm 同口径做时间去抖——战时联盟记录高频，合并突发防把 1031 全量重拉钉成每推必发
 * （TTL 作废只在真要唤醒时做；被合并掉的推送由 towerRefreshMs 兜底与 10182 推送接住）。
 * @param {object} _ev net 推送事件
 */
function onAllianceRecordPush(_ev) {
  if (!aliveFn()) return;
  var wall = Date.now();
  if (wall - lastPushWakeAt < cfg.pushWakeMinGapMs) return;
  lastPushWakeAt = wall;
  towersLoadedAt = 0; // 作废 TTL，让本拍真正重打 1031
  kick('10452 alliance record push');
}

/**
 * 暂停钩子：cycle 靠 alive 自然停摆；本引擎无自建定时器/队列需收（推送订阅由 reactor 摘宿主 ctx.on 时统一清）。
 * @param {object} _ctx reactor 上下文
 */
function pause(_ctx) {
  lastPushWakeAt = 0;
}

/**
 * 面板「建造家族」选项（供宿主 autoFarm 的面板字段取用）。
 * @returns {Array<{value:number,label:string}>}
 */
export function familyOptions() {
  var out = [];
  for (var i = 0; i < FAMILIES.length; i++) {
    var f = FAMILIES[i];
    out.push({ value: f, label: FAMILY_LABEL[f] });
  }
  return out;
}

/** 供宿主 autoFarm 转发的子引擎生命周期接口（共用 autoFarm 的 reactor ctx 与 alive 门控，自带一个 cycle） */
export const mechBuild = { install, configure, run, pause };
