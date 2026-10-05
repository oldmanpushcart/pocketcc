/**
 * 自动下田（autoFarm）- 日常 feat：按规则行维持「普通资源田 + 联盟机械田（资源塔）」的在途采集
 *
 * 用户口径（一行 = 一个田位）：选田类型(金/粮/油/雷神) + 田等级 + ☑只下机械田 + 预设部队(1~16：1~8 战斗预设、9~16 采集预设)。
 * 取田优先级：田等级 <6 时一律优先机械田（6 级田没有机械田）——先从「联盟机械田活表」按家族命中、按「剩余存活时间」降序（充足优先），并定点 901 确认仍在才下田。
 *   ☐只下机械田（未勾）→ 机械田没有（未命中/快结束/已毁/探针失败）时回退按类型+等级搜普通田；☑只下机械田 → 只看机械田，没有则本行不下（绝不回退普通田）。
 * 雷神矿(family16) 田等级上限 3 级（面板联动封顶）。每行维持 1 条在途采集；缺位（到家/被撤/阵亡）即唤醒补派。
 * 一个矿（含机械田）只能一支部队驻扎：探索到的候选点若已在本人行军表中（去程/到达/采集中）则跳过（返程已让出矿位、不计）。
 * 补派前查全局出征队列名额，不足只等待、不主动撤田（撤田语义保留给「占领发射井」feat，
 * 其撤田造成的缺位会由 10019 回城唤醒自动补回）。本轮无合格候选 → 空闲降频等下个唤醒周期。
 *
 * 候选来源（两份 dashcam 录制 + extracted 逆向源码交叉实证）：
 *   普通田 —— 服务端搜索 WORLD_SEARCH_MONSTER(906)：请求 {minLevel, maxLevel, groupType, pointType:2}，
 *        应答 {point:{r:{itemId,amount,expireTime,ownerId('0'=无主),aid}, x, y, pointType:4}}，服务端直接返回一个可采点。
 *        groupType = RESOURCE 表里 (家族, 等级) 对应行的 id；家族 = floor(id/100)（1油/5粮/7金/16雷神），
 *        等级取该行 .level 字段（实证：id 506 的 level=5、1603 的 level=3——不是 itemId%100）。
 *   机械田 —— 联盟记录发现（视口无关，覆盖全联盟任意地点）：一次性发 ALLIANCE_RECORD_DATA(1193) 全量 +
 *        订阅 push PUSH_ALLIANCE_RECORD(10452)，把「建造 N级<设施>完毕」记录解析成 {x,y,family,level,ts(建成时刻≈btime)}（设施名→家族：
 *        采金=金7/炼油=油1/谷仓=粮5/提纯=雷神16，与 RES_FAMILY_BY_TOWER 的 bid 家族一致；坐标取渲染文本末个 "(x,y)"）灌进活表；
 *        实证塔存活 <10h，故只收 10h 内记录、超期老化剔除。剩余存活时间 = ts + MAP_BUILDING[bid].duration − serverTime（零额外发包）。
 *        摧毁无记录 → 下田前按剩余时间降序对候选定点 901 GET_WORLD_INFO 确认该点仍是本盟已建成资源塔
 *        （pointType24 & st=3 & aid=本盟 & bid 家族匹配）才发 902；剩余不足 MECH_MIN_REMAIN_SEC 的「快结束」塔直接剔除；探到已毁即移出活表+拉黑、换下一候选。
 *        容量闸：901 无驻军字段，故对存在性通过的候选再发 1034 GET_TOWERINFO{id} 取 army_size，配 MAP_BUILDING[bid].force_capacity 判满
 *        （army_size≥上限=已采满、与游戏 NWorldTowerPopup 同口径 force_capacity−army_size≤0）→ 跳过换下一候选（不拉黑，稍后可能有队返采腾出空间），避免向满塔发 902 吃拒。
 *   902  MARCH_WORLD_POINT 下田：普通田 marchType=3，机械田 marchType=26；载荷只需 {marchType,x,y,army…}（服务器按坐标定位点），
 *        形状照抄录制（含 break:0）。902 被拒零成本，拉黑该点换下一候选；但限流类拒（march_time_control_info001）例外：
 *        田点本身有效、不拉黑，改为中止本轮剩余行 + 指数退避重排下轮（启动多行连发时尤其易撞，操作过快）。
 *   10019 USER_MARCH_INFO push：state=4（ARRIVED_HOME）到家才释放名额，作「缺位即唤醒」的触发源。
 *
 * 账本：storage.data['autoFarm'] 按 UID 隔离，rowIdx → [{marchId,x,y,marchType}]，每行至多 1 条；902 成功即记、
 * 在途消失即销；重开页面后认领 856 GET_ALL_MY_MARCH_INFO 的现存采集行军（坐标取 marchInfo.target.tx/ty、状态取 state）回填账本，避免重复下田。
 * 在途核对 / 占用判定均以 856 全量本人行军为权威源（视口无关，Home 场景亦有；mapData.marches 在 Home 为空、进出世界地图被清空重建，故不作真相）。
 *
 * 生命周期由 reactor 托管：scenes 限定 Home/NWorldMap，战斗模式暂停（offInCombat）；
 * 触发源（run 点火 / 10019 回城 / 配置变更 / 兜底定时）全部汇入 triggerCycle，在飞合并为一次补扫。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { gameData, l10n } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { storage } from '../../core/storage.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { CMD_GET_WORLD_INFO } from '../map/map-meta.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=AUTO-FARM） */
const log = createLog('AUTO-FARM');

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（下田） */
const CMD_MARCH_WORLD_POINT = 902;
/**
 * @type {string} 902 拒绝载荷里“操作过快”的服务器全局限流文案键（字典：march_time_control_info001=操作过快，请重新尝试）。
 * 与“点被抢/已失效”的真拒不同：田点本身有效，不应拉黑；命中即中止本轮剩余行、按指数退避重排下轮。
 */
const ERR_RATE_LIMIT = 'march_time_control_info001';
/** @type {number} RequestId.WORLD_SEARCH_MONSTER：服务端按 (家族,等级) 搜索一个可采资源点 */
const CMD_WORLD_SEARCH_MONSTER = 906;

/** @type {number} 行军类型：普通资源田采集（NMarchType.GATHER_RESOURCE） */
const KIND_FARM = 3;
/** @type {number} 行军类型：联盟机械田（资源塔）采集（枚举名 ATTACK_TOWER，复用值 26） */
const KIND_TOWER = 26;
/** @type {number} 实体类型：资源塔（NWorldMapEntityType.ResourceTower = 901 pointType = 24） */
const POINT_TYPE_TOWER = 24;
/** @type {number} TowerState.COMPLETE：塔建造完成、可采集 */
const TOWER_STATE_COMPLETE = 3;
/** @type {number} 906 搜索分类 pointType：资源 tab（1野怪/2资源/3集结/4国宝） */
const SEARCH_POINT_TYPE_RESOURCE = 2;
/** @type {number} RequestId.ALLIANCE_RECORD_DATA：全量拉联盟记录（含「建筑」机械田建造事件，视口无关） */
const CMD_ALLIANCE_RECORD_DATA = 1193;
/** @type {number} RequestId.GET_TOWERINFO：查资源塔详情（应答 army_size=当前驻军兵力，配 MAP_BUILDING[bid].force_capacity 判满） */
const CMD_GET_TOWERINFO = 1034;
/** @type {number} push PUSH_ALLIANCE_RECORD：联盟记录增量推送（新建成机械田即时并入活表） */
const PUSH_ALLIANCE_RECORD = 10452;
/** @type {number} 机械田记录/活表最大年龄（秒）：实证塔存活 <10h，超期视为已毁不再下田 */
const MECH_MAX_AGE_SEC = 10 * 3600;
/** @type {number} 单轮每行机械田存在性探针上限（候选过多时限流，超出本轮回退普通田、下轮再试） */
const MECH_PROBE_CAP = 6;
/**
 * @type {number} 机械田最小剩余存活时间（秒）：排序后剩余不足此值的塔视为「快结束」直接剔除，
 * 免得派兵跑到一个将到期（甚至往返路上就消失）的田上。仅在能查到存活时长时生效。
 */
const MECH_MIN_REMAIN_SEC = 10 * 60;

/** @type {number[]} 合法资源家族编码：1 石油 / 5 粮食 / 7 金矿 / 16 雷神 */
const RES_FAMILIES = [1, 5, 7, 16];
/**
 * 塔家族（floor(bid/1000)）→ 资源家族编码反查表（51 金塔 / 52 油塔 / 53 粮塔 / 71 雷神塔）。
 * @type {Object<number,number>}
 */
const RES_FAMILY_BY_TOWER = { 51: 7, 52: 1, 53: 5, 71: 16 };
/**
 * 联盟记录文本里的设施名 → 资源家族编码（与 RES_FAMILY_BY_TOWER 的 bid 家族口径一致）：
 * 采金=金矿(7) / 炼油=石油(1) / 谷仓=粮食(5) / 提纯=雷神(16)。仅匹配中文（本工具面向国服）。
 * @type {Object<string,number>}
 */
const FACILITY_FAMILY = { '采金': 7, '炼油': 1, '谷仓': 5, '提纯': 16 };
/**
 * 资源家族编码 → 塔 bid 前缀（RES_FAMILY_BY_TOWER 的反向）：金(7)→51 / 油(1)→52 / 粮(5)→53 / 雷神(16)→71，
 * 供由 (family,level) 反推 bid（= 前缀·1000+等级）去 MAP_BUILDING 表查存活时长 duration。
 * @type {Object<number,number>}
 */
const TOWER_PREFIX_BY_FAMILY = { 7: 51, 1: 52, 5: 53, 16: 71 };

/** @type {string} 账本逻辑键（storage.data 下，UID 前缀隔离） */
const LEDGER_NAME = 'autoFarm';

/**
 * 内置调优常量（面板不暴露；active/idle 两档兜底定时同 domain-treasure 惯例）
 * @type {object}
 */
const cfg = {
    /** 仍有缺位未补上时的兜底扫描间隔（毫秒）：1 分钟 */
    activeScanInterval: 1000 * 60,
    /** 全部田位都在途时的兜底间隔（毫秒）：10 分钟（正常靠 10019 唤醒，这里只是断推兜底） */
    idleScanInterval: 1000 * 60 * 10,
    /** 逐条 902 之间的休眠（毫秒）：防 marches 入表延迟导致同轮超发，同时拉开间隔规避服务器行军时间限流 */
    marchInterval: 1000 * 8,
    /** 推送唤醒补扫的最小间隔（毫秒）：合并突发回城推送 */
    pushScanMinGap: 1000 * 4,
    /** 撞 902 全局限流（march_time_control_info001）后的退避基数（毫秒）：按 streak 指数退避重排下轮 */
    rateLimitBackoffMs: 1000 * 15,
    /** 限流退避封顶（毫秒）：退避到此值后每轮最多等这么久，既不给服务器加压也不错过恢复 */
    rateLimitBackoffMaxMs: 1000 * 60,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（UserData 名额/等级/服务器时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {boolean} 周期在飞闸门，防重入 */
var scanning = false;
/** @type {boolean} 在飞期间来了新触发，置位，本轮结束后补扫一次 */
var scanPending = false;
/** @type {number|null} 兜底定时器；pause 后 alive()=false，到点空转不再自重排 */
var scanTimer = null;
/** @type {number} 上次推送唤醒的墙钟时刻（毫秒），合并突发 */
var lastPushWakeAt = 0;
/** @type {boolean} 上轮是否仍有缺位未补（决定 active/idle 两档兜底间隔） */
var backlogActive = false;
/** @type {number} 连续撞 902 限流的次数（用于指数退避）；任一条 902 成功受理即归零 */
var rateLimitStreak = 0;

/**
 * 本地被拒/不合格点黑名单（"x,y" 键，run 时清空）：902 被拒零成本，拉黑后换下一候选，
 * 避免每个周期都在同一个不可下点上吃拒。
 * @type {Set<string>}
 */
var blacklist = new Set();

/**
 * 联盟机械田活表：坐标键 "x,y" → {x,y,family,level,ts(秒)}。
 * 来源 = 1193 全量 + 10452 推送解析出的「建造 N级设施完毕」记录；下田前逐个定点 901 确认仍在，
 * 探到已毁即移出并拉黑；每条 ts 超 MECH_MAX_AGE_SEC 由 pruneMechLive 老化剔除（塔存活 <10h）。
 * @type {Map<string, {x:number,y:number,family:number,level:number,ts:number}>}
 */
var mechLive = new Map();
/** @type {boolean} 是否已跑过一次 1193 全量（未跑前机械田本轮回退普通田） */
var mechLoaded = false;
/** @type {Promise|null} 1193 全量在飞 promise（单飞去重；await 者共享同一 promise，确保首轮真正等到机械田落地再选点，不再空返回） */
var mechLoading = null;

/**
 * 本地账本：rowIdx（字符串键）→ [{marchId:string, x:number, y:number, marchType:number}]，每行至多 1 条。
 * 902 成功即记；在途核对发现 marchId 消失/坐标无对应行军即销。storage.data 持久化，跨页面刷新认领回填。
 * @type {Object<string, Array<object>>}
 */
var ledger = {};
/** @type {boolean} 账本是否已从盘读回（未读回前不做写操作，防拿空账本重复下田） */
var ledgerLoaded = false;
/** @type {boolean} 账本读盘在飞标记（单飞，防并发触发重复读盘） */
var ledgerLoading = false;

/** @type {Object<string, number>} (family_level) → groupType 缓存（RESOURCE 表页面生命周期内不变） */
var groupTypeCache = {};
/** @type {Object<number, number>} bid → 塔存活时长秒缓存（MAP_BUILDING.duration，页面生命周期内不变；查不到存 0） */
var towerLifeCache = {};
/** @type {Object<number, number>} bid → 塔驻军容量上限缓存（MAP_BUILDING.force_capacity，页面生命周期内不变；查不到存 0） */
var towerCapCache = {};

/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {object} 模块配置（configure 灌入）：rules 为归一化后的行数组 */
var MCFG = { rules: [] };

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

/**
 * 等待毫秒（负值钳到 0）
 * @param {number} ms 时长
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms | 0)); });
}

/**
 * 应答 data 归一化：旧 JSON 链路 data 常为字符串，兜底已解析对象。
 * @param {*} d net.Ret.data
 * @returns {object|null}
 */
function parseData(d) {
    if (d == null) return null;
    if (typeof d === 'object') return d;
    if (typeof d === 'string') {
        try { return JSON.parse(d); } catch (err) { return null; }
    }
    return null;
}

/**
 * 902 被拒裸串 → 语言键：被拒时 data 是 "语言键,参数" 形式的裸串（受理才是整包 JSON），
 * 取首个逗号前作为键。非字符串/空回 null。口径照抄 floatcar。
 * @param {*} data net.Ret.data
 * @returns {string|null}
 */
function rejectErrKey(data) {
    if (typeof data !== 'string' || !data) return null;
    var comma = data.indexOf(',');
    return comma >= 0 ? data.slice(0, comma) : data;
}

/** @returns {object} DataCenter.DATA.UserData（读不到回空对象） */
function userData() {
    return (dataCenter && dataCenter.UserData) || {};
}

/**
 * 取本人全部采集行军（marchType 3/26）作为占用/账本核对的权威源。
 * 走 core/march.list()（封装 856 GET_ALL_MY_MARCH_INFO）：服务端全量、视口无关，Home 场景同样返回。
 * 归一化：marchId 一律字符串（>2^53 安全），占用判定取 m.isOccupying（state 非返程/到家）。
 * 永不 reject：失败时 march.list() 回 []（本轮视作无在途，由 freeSlots/preset-out 闸门兼底）。
 * @returns {Promise<Array<{marchId:string,x:number,y:number,marchType:number,state:number,occupying:boolean}>>}
 */
async function fetchMyFarmMarches() {
    var ms = await march.list();
    var out = [];
    for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        var mt = m.type | 0;
        if (mt !== KIND_FARM && mt !== KIND_TOWER) continue;
        out.push({
            marchId: m.id,
            x: m.target.x,
            y: m.target.y,
            marchType: mt,
            state: m.state,
            occupying: m.isOccupying,
        });
    }
    return out;
}

/**
 * 本人全部「非返程/到家」行军已占用的目标点集合（"x,y" 键，来自 856 权威行军）。
 * 普通田只能一支部队驻扎、机械田虽允许多队驻采，但本器不让自己的两支队伍抢同一塔，故一律把本人已在途点预规为占用：
 * 去程/到达/采集中都算占位，唯返程（RETURNING=3）与到家（ARRIVED_HOME=4）已让出矿位不计。
 * @param {object[]} marches fetchMyFarmMarches() 结果（条目自带 x/y/state）
 * @returns {Set<string>} 占用点键集合
 */
function occupiedPointSet(marches) {
    var s = new Set();
    for (var i = 0; i < marches.length; i++) {
        var mg = marches[i];
        if (!mg.occupying) continue;
        if (mg.x == null || mg.y == null) continue;
        s.add(mg.x + ',' + mg.y);
    }
    return s;
}

// ── 规则归一 ────────────────────────────────────────────────────────
/**
 * 面板原始 rules → 归一化行数组（钳值 + 类型对齐）。行存在即生效（无行级 enabled 字段）。
 * @param {Array<object>} raw
 * @returns {Array<{family:number,level:number,mechOnly:boolean,preset:number}>}
 */
function normalizeRules(raw) {
    var out = [];
    var list = Array.isArray(raw) ? raw : [];
    for (var i = 0; i < list.length; i++) {
        var r = list[i] || {};
        var fam = RES_FAMILIES.indexOf(r.family | 0) >= 0 ? r.family | 0 : 7;
        var maxLv = fam === 16 ? 3 : 6;   // 雷神矿最高 3 级，其余 1~6
        out.push({
            family: fam,
            level: Math.max(1, Math.min(maxLv, r.level | 0)) || 5,
            mechOnly: !!r.mechOnly,
            preset: Math.max(1, Math.min(16, r.preset | 0) || 1),
        });
    }
    return out;
}

/**
 * 面板预设号（1~16）→ Battle 预设 (index, type)：1~8 为战斗预设（type=0，index=本身），
 * 9~16 为采集预设（type=1，index=预设号-8）。与 battle.js 的 getPreMarchByIndex(index-1, type) 口径对齐。
 * @param {number} p 面板预设号（1~16）
 * @returns {{index:number,type:number}}
 */
function presetArgs(p) {
    var n = p | 0;
    if (n >= 9) return { index: n - 8, type: 1 };
    return { index: Math.max(1, n), type: 0 };
}

// ── 账本持久化 ──────────────────────────────────────────────────────
/**
 * 从盘读回账本（单飞；读失败不置 loaded、保留下次重试机会——同 alliance-rally dailyState 语义）。
 * @returns {Promise<void>}
 */
function loadLedger() {
    if (ledgerLoaded || ledgerLoading) return Promise.resolve();
    ledgerLoading = true;
    return Promise.resolve(storage.data.get(LEDGER_NAME)).then(function (saved) {
        ledgerLoading = false;
        if (saved && typeof saved === 'object') ledger = saved;
        ledgerLoaded = true;
    }).catch(function (err) {
        ledgerLoading = false;
        log.warn('load ledger failed, retry next cycle. %s', err && err.message);
    });
}

/** 账本落盘（fire-and-forget，失败仅 warn，内存账本仍是本轮真相） */
function persistLedger() {
    if (!ledgerLoaded) return;
    Promise.resolve(storage.data.set(LEDGER_NAME, ledger)).catch(function (err) {
        log.warn('persist ledger failed.', err);
    });
}

// ── 在途核对 ────────────────────────────────────────────────────────
/**
 * 用 856 权威行军修剪/回填账本（视口无关，Home 亦可）：
 *   1) 行号越界（规则行被删/改）→ 该键整体作废；
 *   2) 条目 marchId 在 856 中命中且仍占用（非返程/到家）→ 保留；命中但已返程/到家，或 856 全量里缺席
 *      （856 是全量真相，缺席即代表该队已回家/消失）→ 移除，该行随之变回缺位（marchId 缺失时按坐标兜底）；
 *   3) 认领孤儿：856 中存在（在途/在采）但未被任何账本行引用的采集行军（marchType 3/26）→ 回填到第一个缺位行
 *      （跨页面刷新/重启不重复下田；手动下的田也算数）。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @param {object[]} allRules 全部规则行（含未启用，下标即规则行 rowIdx）
 * @returns {boolean} 账本是否发生变化（需要落盘）
 */
function reconcileLedger(marches, allRules) {
    var changed = false;
    var liveIds = {};
    var liveCoord = {};
    for (var i = 0; i < marches.length; i++) {
        var mg = marches[i];
        if (!mg.occupying) continue;  // 已让位（返程/到家），不计在途
        if (mg.marchId) liveIds[mg.marchId] = mg;
        if (mg.x != null && mg.y != null) liveCoord[mg.x + ',' + mg.y] = mg;
    }
    var isGather = function (mt) { return mt === KIND_FARM || mt === KIND_TOWER; };
    // 1)+2) 逐行修剪：marchId 命中且仍占用则保留，否则（已回家 / 856 全量缺席）删除
    for (var key in ledger) {
        if (!Object.prototype.hasOwnProperty.call(ledger, key)) continue;
        var idx = +key;
        if (!(idx >= 0 && idx < allRules.length)) { delete ledger[key]; changed = true; continue; }
        var keep = [];
        var arr = Array.isArray(ledger[key]) ? ledger[key] : [];
        for (var n = 0; n < arr.length; n++) {
            var e = arr[n] || {};
            var mg2 = (e.marchId && liveIds[String(e.marchId)]) || liveCoord[(e.x + ',' + e.y)];
            if (mg2 && isGather(mg2.marchType | 0)) keep.push(e);
        }
        if (keep.length !== arr.length) changed = true;
        if (keep.length) ledger[key] = keep; else delete ledger[key];
    }
    // 3) 认领孤儿采集行军
    var claimed = {};
    for (var k2 in ledger) {
        var a2 = ledger[k2] || [];
        for (var q = 0; q < a2.length; q++) if (a2[q].marchId) claimed[String(a2[q].marchId)] = 1;
    }
    for (var s = 0; s < marches.length; s++) {
        var ms = marches[s];
        if (!ms.occupying) continue;
        var mt = ms.marchType | 0;
        if (!isGather(mt)) continue;   // 856 条目按 marchType 3/26 判定采集行军
        if (ms.x == null || ms.y == null) continue;
        var mid = String(ms.marchId);
        if (claimed[mid]) continue;
        var filled = -1;
        for (var r2 = 0; r2 < allRules.length; r2++) {
            if (!(ledger[r2] && ledger[r2].length)) { filled = r2; break; }   // 行存在即生效，所有行都可认领孤儿
        }
        if (filled < 0) continue;
        ledger[filled] = [{ marchId: mid, x: ms.x, y: ms.y, marchType: mt }];
        claimed[mid] = 1;
        changed = true;
        log.debug('adopt orphan gather march. row=%d marchId=%s mt=%d x=%d y=%d', filled, mid, mt, ms.x, ms.y);
    }
    return changed;
}

// ── 候选来源 ────────────────────────────────────────────────────────
/**
 * (家族, 等级) → groupType（RESOURCE 表行 id）：家族 = floor(id/100)，等级取该行 .level 字段（非 id%100）。
 * 首次扫表命中即缓存；找不到返回 0（调用方据此放弃本行普通田搜索）。
 * @param {number} family 资源家族编码（1油/5粮/7金/16雷神）
 * @param {number} level 田等级（1~6）
 * @returns {number} RESOURCE 行 id，未命中 0
 */
function findGroupType(family, level) {
    var ck = family + '_' + level;
    if (groupTypeCache[ck] != null) return groupTypeCache[ck];
    var rows = l10n.tableRows('RESOURCE') || [];
    var gid = 0;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row) continue;
        var id = Number(row.id) || 0;
        if (!id || Math.floor(id / 100) !== family) continue;
        if ((Number(row.level) || 0) !== level) continue;
        gid = id;
        break;
    }
    if (gid) groupTypeCache[ck] = gid;
    return gid;
}

// ── 联盟机械田发现（记录解析 + 存在性探针） ──────────────────────────
/**
 * 复刻联盟记录文本渲染（AllianceRecordController.dealOneObj 口径）：
 *   按 specId 查 alliance_information 表拿模板 .text，params 里含 RS(0x1e) 的子参数各自 getText(d[1])，
 *   再交给 l10n.text（LOCAL.getText）拼成最终中文串。失败回空串（调用方据此跳过）。
 * @param {object} e 记录对象 {specId, params[]}
 * @returns {string} 渲染后的记录文本
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
    try { return String(l10n.text.apply(null, [o.text].concat(args)) || ''); } catch (err) { return ''; }
}

/**
 * 单条联盟记录 → 机械田活表条目：只收「建造 N级<设施>完毕」且 sendTime 在 10h 内的记录，
 * 从渲染文本提 family/level/坐标（末个 "(x,y)"）灌进 mechLive。命中返回 true。
 * @param {object} e 记录对象 {specId, params[], sendTime(秒)}
 * @returns {boolean} 是否并入了一条机械田
 */
function ingestMechRecord(e) {
    if (!e || e.specId == null) return false;
    var ts = Number(e.sendTime) || 0;
    if (ts > 1e11) ts = Math.floor(ts / 1000);   // ms→s 兜底
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
    var x = Number(last[1]) || 0, y = Number(last[2]) || 0;
    if (!x && !y) return false;
    mechLive.set(x + ',' + y, { x: x, y: y, family: family, level: level, ts: ts });
    return true;
}

/**
 * 全量拉联盟记录（1193，视口无关）→ 解析灌入活表。单飞（mechLoading），永不 reject。
 * @returns {Promise<void>}
 */
function loadMechRecords() {
    if (mechLoading) return mechLoading;   // 已在飞：返回同一 promise，让 await 的调用方（cyclePass 首轮）真正等到落地，而非空返回
    mechLoading = net.send(CMD_ALLIANCE_RECORD_DATA, {}).then(function (ret) {
        mechLoading = null;
        if (!ret || !ret.ok) return;
        var d = parseData(ret.data) || {};
        var arr = Array.isArray(d.ret) ? d.ret : (Array.isArray(d.list) ? d.list : null);
        if (!arr) return;
        var added = 0;
        for (var i = 0; i < arr.length; i++) { try { if (ingestMechRecord(arr[i])) added++; } catch (err) { } }
        mechLoaded = true;
        log.info('alliance mech records loaded: %d tower hit, live=%d.', added, mechLive.size);
    }).catch(function (err) { mechLoading = null; log.debug('1193 load failed, retry next cycle. %s', err && err.message); });
    return mechLoading;
}

/** 老化剔除：活表里 ts 超 MECH_MAX_AGE_SEC 的条目（塔存活 <10h，超期视为已毁）。 */
function pruneMechLive() {
    var now = gameData.serverTime(); if (!now) return;
    mechLive.forEach(function (c, key) { if (now - (c.ts || 0) > MECH_MAX_AGE_SEC) mechLive.delete(key); });
}

/**
 * (家族,等级) → 塔 bid：前缀·1000 + 等级（实证 71003=雷神 3 级、52006=油 6 级）。无对应前缀回 0。
 * @param {number} family 资源家族编码
 * @param {number} level 塔等级
 * @returns {number}
 */
function towerBidForLevel(family, level) {
    var pre = TOWER_PREFIX_BY_FAMILY[family];
    return pre ? (pre * 1000 + (level | 0)) : 0;
}

/**
 * 资源塔存活时长（秒）：MAP_BUILDING[bid].duration——游戏 NWorldTowerPopup 的 leftTime 同源字段
 * （leftTime = duration − (serverTime − btime)）。表未就绪/字段缺失回 0（调用方降级按 ts 新度排）。
 * @param {number} family 资源家族编码
 * @param {number} level 塔等级
 * @returns {number}
 */
function towerLifespanSec(family, level) {
    var bid = towerBidForLevel(family, level);
    if (!bid) return 0;
    if (towerLifeCache[bid] != null) return towerLifeCache[bid];
    var r = l10n.tableRow('MAP_BUILDING', bid);
    var life = r ? Number(r.duration) || 0 : 0;
    towerLifeCache[bid] = life;
    return life;
}

/**
 * 定点 901 存在性探针：查 (x,y) 是否仍是「本盟已建成、家族匹配」的资源塔。
 * 命中时一并带回塔 id（b.id 字符串，防 Int64 截断）与 bid，供调用方发 1034 查容量。
 * 永不 reject。@returns {Promise<{status:'ok'|'gone'|'error', id?:string, bid?:number}>} error=请求失败（本行本轮回退普通田）
 */
function probeMechTower(x, y, wantFamily) {
    var u = userData();
    var body = { x: x, y: y, k: u.ServerId | 0, rid: 0, width: 20, height: 20, marchInfo: false, viewLevel: 1 };
    return net.send(CMD_GET_WORLD_INFO, body).then(function (ret) {
        if (!ret || !ret.ok) return { status: 'error' };
        var d = parseData(ret.data) || {};
        var list = Array.isArray(d.pointList) ? d.pointList : [];
        var myAid = gameData.myAid();
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (!p || (p.x | 0) !== x || (p.y | 0) !== y) continue;
            if ((p.pointType | 0) !== POINT_TYPE_TOWER) return { status: 'gone' };
            var b = p.b || {};
            if ((Number(b.st) || 0) !== TOWER_STATE_COMPLETE) return { status: 'gone' };
            if (myAid && Number(b.aid) !== myAid) return { status: 'gone' };
            if (wantFamily && RES_FAMILY_BY_TOWER[Math.floor((Number(b.bid) || 0) / 1000)] !== wantFamily) return { status: 'gone' };
            return { status: 'ok', id: b.id != null ? String(b.id) : null, bid: Number(b.bid) || 0 };
        }
        return { status: 'gone' };
    }).catch(function () { return { status: 'error' }; });
}

/**
 * 资源塔驻军容量上限（force_capacity）：MAP_BUILDING[bid].force_capacity（游戏 NWorldTowerPopup 判满同源字段，
 * 满判据 = force_capacity − army_size ≤ 0）。表未就绪/字段缺失回 0（调用方据此跳过容量闸）。
 * @param {number} bid 塔 bid（901 的 b.bid）
 * @returns {number}
 */
function towerForceCapacity(bid) {
    if (!bid) return 0;
    if (towerCapCache[bid] != null) return towerCapCache[bid];
    var r = l10n.tableRow('MAP_BUILDING', bid);
    var cap = r ? Number(r.force_capacity) || 0 : 0;
    towerCapCache[bid] = cap;
    return cap;
}

/**
 * 资源塔当前驻军兵力 army_size（1034 GET_TOWERINFO {id}，id 取 901 的 b.id 字符串，防 Int64 截断）。
 * 永不 reject；请求失败/无字段回 -1（调用方按「未知」不拦，交由 902 结果兜底）。
 * @param {string} id 塔 id（字符串）
 * @returns {Promise<number>}
 */
function towerArmySize(id) {
    if (!id) return Promise.resolve(-1);
    return net.send(CMD_GET_TOWERINFO, { id: id }).then(function (ret) {
        if (!ret || !ret.ok) return -1;
        var d = parseData(ret.data) || {};
        var n = Number(d.army_size);
        return isFinite(n) ? n : -1;
    }).catch(function () { return -1; });
}

/**
 * 为一行挑联盟机械田：活表按家族命中 → 按「剩余存活时间」降序（充足优先，等级高作次键）
 *   ——剩余时间 = 建成时刻 ts(≈btime) + 存活时长 duration − serverTime，均本地算、零额外发包；
 * → 剔除剩余 < MECH_MIN_REMAIN_SEC 的「快结束」塔（仅存活时长可查时生效）→ 逐个定点 901 确认仍在，
 * 再对存在性通过的候选发 1034 查 army_size 配 force_capacity 过容量闸（满则跳过、不拉黑）才返回；
 * 探到已毁即移出活表+拉黑换下一候选；探针失败/容量未知不拦/超上限/无候选回 null（调用方回退普通田）。
 * @param {object} row 归一化规则行
 * @param {Set<string>} taken 本轮已派点键
 * @returns {Promise<{x:number,y:number,marchType:number}|null>}
 */
async function pickMechTower(row, taken) {
    var now = gameData.serverTime();
    var scored = [];
    mechLive.forEach(function (c) {
        if (c.family !== row.family) return;
        var key = c.x + ',' + c.y;
        if (blacklist.has(key)) return;
        if (taken.has(key)) { log.debug('point occupied by my march(856), skip. mech x=%d y=%d', c.x, c.y); return; }
        var life = towerLifespanSec(c.family, c.level);
        var hasLife = life > 0 && !!now;
        // 剩余时间（秒）：能查到存活时长则用 ts+life-now；否则退化为 ts 新度（大=新建=剩余多）
        var remain = hasLife ? (c.ts + life - now) : (c.ts || 0);
        scored.push({ c: c, remain: remain, hasLife: hasLife });
    });
    // 存活时长全可查时才按绝对剩余剔除快结束的塔；部分不可查时不误杀（仅靠排序优先）
    if (scored.length && scored.every(function (s) { return s.hasLife; })) {
        scored = scored.filter(function (s) { return s.remain >= MECH_MIN_REMAIN_SEC; });
    }
    scored.sort(function (a, b) { return (b.remain - a.remain) || (b.c.level - a.c.level); });
    var probed = 0;
    for (var i = 0; i < scored.length; i++) {
        var c = scored[i].c; var key = c.x + ',' + c.y;
        if (probed >= MECH_PROBE_CAP) break;
        probed++;
        var pr = await probeMechTower(c.x, c.y, row.family);
        if (pr.status === 'error') return null;
        if (pr.status === 'gone') { mechLive.delete(key); blacklist.add(key); continue; }
        // 容量闸：塔存在且已建成，但可能已被采满（army_size ≥ force_capacity）→ 902 必被拒。
        // 本地查 force_capacity，可查则发 1034 取 army_size 比对；满则跳过本候选（不拉黑——稍后可能有队返采腾出空间）。
        var cap = towerForceCapacity(pr.bid);
        if (cap > 0 && pr.id) {
            var cur = await towerArmySize(pr.id);
            if (!aliveFn()) return null;
            if (cur >= 0 && cur >= cap) {
                log.debug('mech tower full, skip. x=%d y=%d army=%d cap=%d', c.x, c.y, cur, cap);
                continue;
            }
        }
        return { x: c.x, y: c.y, marchType: KIND_TOWER };
    }
    return null;
}

/**
 * 为一行搜一个普通田（906，服务端返回一个可采点）。永不 reject。
 * @param {object} row 归一化规则行
 * @param {Set<string>} taken 本轮已派点键
 * @returns {Promise<{x:number,y:number,marchType:number}|null>}
 */
async function pickNormalFarm(row, taken) {
    var gid = findGroupType(row.family, row.level);
    if (!gid) {
        log.warn('no RESOURCE row for family=%d level=%d, skip normal search.', row.family, row.level);
        return null;
    }
    var ret;
    try {
        ret = await net.send(CMD_WORLD_SEARCH_MONSTER, {
            minLevel: row.level, maxLevel: row.level, groupType: gid, pointType: SEARCH_POINT_TYPE_RESOURCE,
        });
    } catch (err) {
        log.debug('906 search send failed. %s', err && err.message);
        return null;
    }
    if (!ret || !ret.ok) return null;
    var d = parseData(ret.data) || {};
    var pt = d.point || (Array.isArray(d.pointList) ? d.pointList[0] : null);
    if (!pt || pt.x == null || pt.y == null) return null;
    var key = (pt.x | 0) + ',' + (pt.y | 0);
    if (blacklist.has(key)) return null;
    if (taken.has(key)) { log.debug('point occupied by my march(856), skip. normal x=%d y=%d', pt.x | 0, pt.y | 0); return null; }
    var r = pt.r || {};
    if (r.ownerId != null && String(r.ownerId) !== '0') return null;
    if ((Number(r.amount) || 0) <= 0) return null;
    return { x: pt.x | 0, y: pt.y | 0, marchType: KIND_FARM };
}

// ── 派发 ────────────────────────────────────────────────────────────
/**
 * 下田 902：marchType=候选带回来的类型（3 普通田 / 26 机械田），经 core/march.attack 统一发送。
 * 永不 reject（march.attack 内部 catch → code=NOT_SENT）。
 * @param {{x:number,y:number}} coord 目标点
 * @param {number} marchType 行军类型（3 普通田 / 26 机械田）
 * @param {object} plan MarchData（5 字段）
 * @returns {Promise<object>} net.Ret
 */
async function sendFarm(coord, marchType, plan) {
    return await march.attack({ marchType: marchType, target: { x: coord.x, y: coord.y }, data: plan });
}

// ── 周期引擎 ────────────────────────────────────────────────────────
/**
 * 兜底定时器武装：自重排一次 triggerCycle；pause 后 alive()=false，到点空转不再自重排。
 * @param {number} delay 延迟（毫秒）
 */
function scheduleCycle(delay) {
    if (!aliveFn()) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
        scanTimer = null;
        if (aliveFn()) triggerCycle();
    }, Math.max(0, delay));
}

/**
 * 周期触发汇入口：run 点火 / 10019 回城 / 配置变更 / 兜底定时都走这里。
 * 在飞时不并发进入，只置 scanPending，本轮结束后补扫一次。
 */
function triggerCycle() {
    if (!aliveFn()) return;
    if (!ledgerLoaded) {   // 账本未从盘读回前不派：防拿空账本重复下田；读回成功后自会续一轮
        loadLedger().then(function () {
            if (!aliveFn()) return;
            if (ledgerLoaded) triggerCycle();
            else scheduleCycle(cfg.activeScanInterval);  // 读回失败：降速重试，不留紧密循环
        });
        return;
    }
    if (scanning) {
        scanPending = true;
        return;
    }
    doCycle().catch(function (err) {
        log.warn('cycle threw.', err);
    });
}

/**
 * 单轮周期主体：在途核对 → 找缺位行 → 名额闸门 → 逐行取田（☑机械田先本地机械、无则搜普通田）→ 派发。
 * 早退路径只置 backlogActive 后正常返回（分档重排由 doCycle 末尾统一做，绝不能在定时重排前 return）。
 * @returns {Promise<void>}
 */
async function cyclePass() {
    var all = MCFG.rules || [];
    var rules = [];
    var ruleIdx = [];
    for (var i = 0; i < all.length; i++) { rules.push(all[i]); ruleIdx.push(i); }   // 行存在即生效，无行级 enabled 过滤
    if (!rules.length) { backlogActive = false; return; }

    // 权威行军源：core/march.list()（封装 856，视口无关、Home 亦有全量）。march.list() 失败回 []（「未知不拦」）：
    // 即便瞬时拉空，预设部队已在外者 armyListNew 为空会静默跳过，不会重复下田；回城后自然补齐。
    var marches = await fetchMyFarmMarches();
    if (!aliveFn()) return;

    // 在途核对 + 缺位行（账本键=规则行原始下标，锚定 856 权威行军：marchId 缺席即已回家/消失 → 销位）
    if (reconcileLedger(marches, all)) persistLedger();
    var missingPos = [];  // 缺位行在 rules（启用行数组）中的下标
    for (var m = 0; m < rules.length; m++) {
        if (!(ledger[ruleIdx[m]] && ledger[ruleIdx[m]].length)) missingPos.push(m);
    }
    if (!missingPos.length) {
        backlogActive = false;
        return;
    }

    // 名额闸门（core/march.freeSlots，读 UserData 服务端同步、跨场景可靠）：无空位只等下个唤醒周期（不主动撤田——撤田语义保留给占领发射井 feat）
    var free = march.freeSlots();
    if (free <= 0) {
        log.debug('no free march slot, wait for arrival wake. missing=%d', missingPos.length);
        backlogActive = true;
        return;
    }

    // 点占用表（来自 856 权威行军）：把本人全部「非返程/到家」行军的目标点预规为占用（种子进 taken），
    // Home 场景也能识别自家在田队；pickMechTower/pickNormalFarm 的 taken 过滤自动跳过（本轮派成的点也并入）。
    var taken = occupiedPointSet(marches);
    pruneMechLive();
    var dispatched = 0;
    for (var t = 0; t < missingPos.length; t++) {
        if (!aliveFn()) return;
        if (free <= 0) { log.debug('slot exhausted mid-cycle, remaining=%d', missingPos.length - t); break; }
        var row = rules[missingPos[t]];
        var rawIdx = ruleIdx[missingPos[t]];

        // 先算该行预设部队可用否（纯本地读预设 + 剔除已出征，零发包）：armyListNew 为空多半意味着
        // 这支部队已在外（正是在下田/采集中）——本行其实已被占用，静默 debug 跳过，既不发 901/906 徒劳搜田、
        // 也不刷 ⚠️；部队回城后 armyListNew 复出不空，下一轮自然补派。
        var pa = presetArgs(row.preset);
        var plan = new Battle().plan().preset(pa.index, pa.type).adjust().build();
        if (!plan.armyListNew.length) {
            log.debug('row %d preset #%d(%s#%d) army already out (farming?), skip without searching.',
                rawIdx, row.preset, pa.type ? '采集' : '战斗', pa.index);
            continue;
        }
        // 英雄就绪守卫：预设原本配了英雄、但当前可派英雄列表为空——这是 10019 回城推送后
        // 兵池（UserData）已刷新、而英雄释放推送（HeroController）尚未到达时的竞争窗口。
        // 若此时发 902，英雄列表将为空（部队无英雄出征），故本轮跳过，等英雄推送到达后的
        // 兵池刷新唤醒或兜底定时器重试。
        if (plan.presetHasHeroes && !plan.heroList.length) {
            log.debug('row %d preset #%d(%s#%d) heroes not yet released, skip this cycle.',
                rawIdx, row.preset, pa.type ? '采集' : '战斗', pa.index);
            backlogActive = true;
            continue;
        }
        if (net.isSending(CMD_MARCH_WORLD_POINT)) { backlogActive = true; break; }

        // 取田：6 级田没有机械田（不涉机械，直接搜普通田）；其余等级一律优先机械田——先从联盟机械田活表按家族命中、
        // 按剩余存活时间降序、定点 901 确认仍在才下；☑只下机械田(row.mechOnly) 则机械田没有即跳过本行、绝不回退普通田，未☑则没有再搜普通田（906）。
        var cand = null;
        var mechApplicable = row.level < 6;
        if (mechApplicable) {
            if (!mechLoaded) { await loadMechRecords(); if (!aliveFn()) return; }
            cand = await pickMechTower(row, taken);
            if (!aliveFn()) return;
        }
        if (!cand && (!mechApplicable || !row.mechOnly)) {
            if (net.isSending(CMD_WORLD_SEARCH_MONSTER)) { backlogActive = true; break; }
            cand = await pickNormalFarm(row, taken);
            if (!aliveFn()) return;
        }
        if (!cand) {
            log.debug('no candidate for row %d (family=%d level=%d mechOnly=%s).', rawIdx, row.family, row.level, !!row.mechOnly);
            continue;
        }

        var ck = cand.x + ',' + cand.y;
        var ret = await sendFarm(cand, cand.marchType, plan);
        if (!aliveFn()) return;
        if (ret.ok) {
            taken.add(ck);
            rateLimitStreak = 0;   // 成功受理即解除限流退避压力
            var d = parseData(ret.data) || {};
            var mid = d.marchInfo && d.marchInfo.marchId != null ? String(d.marchInfo.marchId)
                : (d.marchId != null ? String(d.marchId) : '');
            ledger[rawIdx] = [{ marchId: mid, x: cand.x, y: cand.y, marchType: cand.marchType }];
            persistLedger();
            free--;
            dispatched++;
            log.info('farm march ok. row=%d kind=%d x=%d y=%d marchId=%s', rawIdx, cand.marchType, cand.x, cand.y, mid || '?');
        } else {
            var errKey = rejectErrKey(ret.data);
            if (errKey === ERR_RATE_LIMIT) {
                // 服务器 902 全局限流（操作过快）：田点本身有效，绝不拉黑。
                // 中止本轮剩余行（不再向后续行继续加压），按 streak 指数退避重排下轮补派。
                rateLimitStreak++;
                log.info('farm march rate-limited, stop burst and back off. row=%d kind=%d x=%d y=%d streak=%d', rawIdx, cand.marchType, cand.x, cand.y, rateLimitStreak);
                break;
            }
            blacklist.add(ck);   // 其余被拒（点被别人抢/已失效等）零成本：拉黑换下一候选
            // 下田 902 被服务器拒（非限流类）属采集循环里的预期竞争态，非错误 → info
            log.info('farm march rejected. row=%d kind=%d x=%d y=%d code=%s why=%s', rawIdx, cand.marchType, cand.x, cand.y, ret.code, errKey || '-');
        }
        if (t < missingPos.length - 1) await sleep(cfg.marchInterval);
    }
    backlogActive = missingPos.length > dispatched;
}

/**
 * 单轮周期外壳：在飞标记 + 主体 + 分档重排（主体任何早退/抛异常都会走到这里重排，绝不停摆）。
 * 永不 reject。
 * @returns {Promise<void>}
 */
async function doCycle() {
    scanning = true;
    try {
        await cyclePass();
    } finally {
        scanning = false;
    }

    if (!aliveFn()) return;
    // 撞限流退避优先：连续 streak 次指数退避（封顶）。中止后不因在飞期间排队的 push 唤醒立刻再 burst，
    // 故丢弃 scanPending、交给退避定时统一重试；成功受理后 streak 归零才回到常规两档。
    if (rateLimitStreak > 0) {
        scanPending = false;
        var wait = Math.min(cfg.rateLimitBackoffMs * (1 << Math.min(rateLimitStreak - 1, 5)), cfg.rateLimitBackoffMaxMs);
        scheduleCycle(wait);
        return;
    }
    if (scanPending) {
        scanPending = false;
        triggerCycle();
        return;
    }
    scheduleCycle(backlogActive ? cfg.activeScanInterval : cfg.idleScanInterval);
}

// ── 推送入口 ────────────────────────────────────────────────────────
/**
 * 推送唤醒（去抖）：距上次补扫 < pushScanMinGap 则忽略，靠兜底定时收尾。
 */
function pushWake() {
    if (!aliveFn()) return;
    var wall = Date.now();
    if (wall - lastPushWakeAt < cfg.pushScanMinGap) return;
    lastPushWakeAt = wall;
    triggerCycle();
}

/**
 * 采集行军到家（march.onHomeReturn 复播，state→ARRIVED_HOME 边沿）→ 该行缺位 → 唤醒补派。
 * 全局单点订阅的代价：march.js 常驻 10019，feat 暂停仍会收到复播 → 回调内自判 alive 为硬约束；
 * 只认采集类行军（marchType 3/26）回城，其它行军回城不唤醒（免空跑）。
 *
 * 副防线（英雄释放延迟）：回城复播时 UserData 兵池已立即刷新，但
 * HeroController.getHaveHeroCanMarchList() 依赖独立的英雄释放推送，通常晚 1~2s 到达。
 * 此处故意延迟 1.5s 再唤醒，给英雄推送落地的时间窗口；主防线见 cyclePass 的 presetHasHeroes 守卫。
 * @param {object} m 归一化 March
 */
function onFarmMarchHome(m) {
    if (!aliveFn()) return;
    var mt = m && (m.type | 0);
    if (mt !== KIND_FARM && mt !== KIND_TOWER) return;   // 只认采集行军回城
    setTimeout(function () { if (aliveFn()) pushWake(); }, 1500);
}

/** @type {Function|null} march.onHomeReturn 退订句柄（防 resume 重激活重复注册） */
var offHomeReturn = null;

/**
 * 10452 联盟记录增量推送：新建成机械田即时入活表；命中则唤醒补扫（新田可能填补某行缺位）。
 * payload 外层结构未知，做容错：d / d.ret / 单条（d.specId）/ d.data。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 */
function onAllianceRecordPush(ev) {
    if (!aliveFn()) return;
    var d = ev && ev.data; if (!d) return;
    var arr = Array.isArray(d) ? d : (Array.isArray(d.ret) ? d.ret : [d.specId != null ? d : (d.data || d)]);
    var hit = false;
    for (var i = 0; i < arr.length; i++) { try { if (ingestMechRecord(arr[i])) hit = true; } catch (err) { } }
    if (hit) pushWake();
}

// ── 生命周期 ────────────────────────────────────────────────────────
/**
 * 安装：取网络底座 + 数据中心（本人行军改走 core/march.list()，不再依赖 NWorldMapData）。
 * 任一缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
    ctxRef = ctx;
    if (installed) return true;

    var missing = [];

    net = ctx.net;
    if (!net.install()) {
        missing.push('pocketcc.net');
        net = null;
    }

    var dc = game.get('DataCenter');
    dataCenter = (dc && dc.DATA) || (missing.push('DataCenter'), null);

    if (missing.length) {
        net = null; dataCenter = null;
        log.warn('install failed. missing=%s', missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed.');
    return true;
}

/**
 * 配置灌入：归一化 rules；规则行删减后同步作废越界账本行；运行中即时唤醒一轮让新规则生效。
 * @param {object} partial reactor 推送的面板配置
 * @returns {object} MCFG
 */
function configure(partial) {
    if (!partial) return MCFG;
    if (partial.rules != null) MCFG.rules = normalizeRules(partial.rules);
    if (ledgerLoaded) {
        var pruned = false;
        for (var key in ledger) {
            if (Object.prototype.hasOwnProperty.call(ledger, key) && !(+key >= 0 && +key < MCFG.rules.length)) {
                delete ledger[key];
                pruned = true;
            }
        }
        if (pruned) persistLedger();
    }
    if (installed && aliveFn()) triggerCycle();
    return MCFG;
}

/**
 * 运行：复位状态 → 挂 10019 监听 → 账本读回后点火。
 * pause 后 alive()=false 定时器自然停摆；resume（scene/mode 恢复）重新点火补扫。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    scanning = false;
    scanPending = false;
    backlogActive = false;
    rateLimitStreak = 0;
    lastPushWakeAt = 0;
    ledgerLoaded = false;
    ledgerLoading = false;
    ledger = {};
    blacklist = new Set();
    mechLive = new Map();
    mechLoaded = false;
    mechLoading = null;
    ctx.on.push(PUSH_ALLIANCE_RECORD, onAllianceRecordPush);
    if (offHomeReturn) offHomeReturn();   // 先退再挂，防 resume 重激活重复注册
    offHomeReturn = march.onHomeReturn(onFarmMarchHome);
    log.info('started (rules=%d rows).', MCFG.rules.length);
    loadMechRecords();
    triggerCycle();
}

/**
 * 田位规则字段选项（farmrules 控件的下拉数据源）。
 * familyOptions 顺序按用户列举（金/粮/油/雷神）；level 1~6；preset 1~16（1~8 战斗预设 / 9~16 采集预设，调 API 时拆回 index+type）。
 * @type {object}
 */
var RULE_OPTS = {
    familyOptions: [
        { value: 7, label: '金矿' },
        { value: 5, label: '粮食' },
        { value: 1, label: '石油' },
        { value: 16, label: '雷神' },
    ],
    levelOptions: (function () {
        var a = [];
        for (var lv = 1; lv <= 6; lv++) a.push({ value: lv, label: lv + ' 级' });
        return a;
    })(),
    presetOptions: (function () {
        var a = [];
        for (var n = 1; n <= 8; n++) a.push({ value: n, label: '战斗' + n });
        for (var g = 9; g <= 16; g++) a.push({ value: g, label: '采集' + (g - 8) });
        return a;
    })(),
};

reactor.register({
    id: 'autoFarm',
    label: '自动下田',
    storageKey: 'pocketcc.feat.autoFarm',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: { enabled: false, rules: [] },
    fields: [
        {
            key: 'rules', label: '下田规则', type: 'farmrules', section: '规则',
            familyOptions: RULE_OPTS.familyOptions,
            levelOptions: RULE_OPTS.levelOptions,
            presetOptions: RULE_OPTS.presetOptions,
        },
    ],
    toModuleCfg: function (c) {
        return { rules: normalizeRules(c.rules) };
    },
    install: install,
    configure: configure,
    run: run,
});
