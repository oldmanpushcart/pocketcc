/**
 * 占领发射井（GunFight / LaunchTower）- 自动驻军 + 自动领积分（reactor 说明书形态）
 *
 * 「占领发射井」是与「首府占领(Throne/Kingdom)」并列的独立活动，仅共用底层代码；内部代号 GunFight、UI 名 LaunchTower。
 * 每周二 21:00 开启、持续 2 小时：4 个发射井(id 4001~4004)由黑暗军团初始占领，联盟需先战胜才能占领；
 * 联盟按累计占领时长排行，个人按占领/杀敌/击败黑暗军团得积分，积分达档位可领奖。
 * 本功能做两件事：①把「归属本联盟」的井派最小部队入驻（不打野、不主动攻打他人井）；②按档位自动领个人积分奖励。
 *
 * 依据（反编译常量 + 三份实机报文 dashcam 双重验证，详见 references/游戏逆向/占领发射井分析报告.md）：
 *   协议（均走旧 JSON NET.send，应答 data 为 JSON 串需 parse）：
 *     1055 GET_GUN_FIGHT_INFO {} → {start,end,cur,list:[{id,owner(联盟aid),ownuid,tag,name,totem,time}]}（活动信息 + 4 井归属）
 *     1057 GET_GUN_FIGHT_USER_INFO {} → {total,os,ks,gs,us,reward:[]}（个人积分 + 已领档位 num 列表）
 *     1058 GET_GUN_FIGHT_USER_REWARD {score:num} → 实发奖励（score 即档位门槛值；积分不足时游戏客户端本地拦截、不发此包）
 *     902  MARCH_WORLD_POINT {marchType:35,x,y,armyList...} → 驻军行军；应答 marchInfo.target{itemId:4001~4004,targetType:10}
 *     904  RECALL_MARCH {marchId} → 撤回单条行军（撤田腾队列用）
 *   推送：11017 GUN_FIGHT_INFO（单井归属增量，触发重扫驻军）；10029 GUN_FIGHT_REWARD_INFO（个人积分/已领刷新，触发领奖）；
 *         10019 USER_MARCH_INFO（本人行军状态，state=4 ARRIVED_HOME 才释放名额，据此唤醒补派）。
 *   档位门槛数据源：DATACONFIG[130118].value，格式 "num,rewardId|num,rewardId|..."；面板内联兜底串见 TIERS_FALLBACK。
 *   井坐标：1055 list 不含坐标，须按 id 读配置表 tableThrone（新图 THRONE_v2、旧图 THRONE，行含 pos_x/pos_y）。
 *
 * 队列与撤田（用户明确口径）：
 *   全局行军名额读 UserData.myMarchNumMAX - myMarchNum（跨场景可靠，勿只依赖 mapData.marches）。
 *   仅当「需驻军且名额不足」才撤田；撤几个＝名额缺口（要几个撤几个）；撤回不立即释放名额，须返程 state=4 到家才释放，
 *   故本轮撤回后不阻塞等待——名额释放由下一轮扫描（10019 回城唤醒 / 兜底定时）自然补派。
 *   "田"＝资源采集行军：mapData.marches 条目由 NWorldMapMarchModel 把协议 marchInfo 摊平（状态字段 marchState、
 *   坐标扁平 target_tx/target_ty、itemId 扁平、**无 target 子对象、无 targetType**），故撤田判据以 marchType 3/26 为准
 *   （普通田 3 / 机械田 26），显式排除驻井 35 与领域寻宝挖矿 180；命中已驻井同理读扁平 itemId/target_tx/target_ty。
 *
 * 生命周期由 reactor 托管：install/run 两个钩子，scenes 门控限定 Home/NWorldMap，战斗模式暂停（offInCombat）。
 *   驻军/撤田/领积分均为内置默认行为，无面板可调项（面板仅出 enabled 勾选）。
 *   驻军/撤田需读 mapData.marches（NWorldMapData.instance.marches）：主城场景该表可能未就绪 → 判为空且有在外行军时跳过本轮写操作，避免误判重复增援。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { l10n, gameConf, gameData } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../core/battle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=LAUNCH-SILO） */
const log = createLog('LAUNCH-SILO');

/** @type {number} RequestId.GET_GUN_FIGHT_INFO：活动信息 + 4 井归属（JSON send，{}） */
const CMD_GET_GUN_FIGHT_INFO = 1055;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_INFO：个人积分与已领档位（JSON send，{}） */
const CMD_GET_GUN_FIGHT_USER_INFO = 1057;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_REWARD：领取某档位积分奖励（JSON send，{score:num}） */
const CMD_GET_GUN_FIGHT_USER_REWARD = 1058;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（驻军） */
const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} RequestId.RECALL_MARCH：撤回单条行军（{marchId}） */
const CMD_RECALL_MARCH = 904;

/** @type {number} ResponseId.PUSH_GUN_FIGHT_INFO（=11017）：单井归属/占领增量推送 */
const PUSH_GUN_FIGHT_INFO = 11017;
/** @type {number} ResponseId.PUSH_GUN_FIGHT_REWARD_INFO（=10029）：个人积分/已领档位刷新推送 */
const PUSH_GUN_FIGHT_REWARD_INFO = 10029;
/** @type {number} push USER_MARCH_INFO：本人行军状态更新（含回城 ARRIVED_HOME），作「名额释放即补派」的唤醒信号 */
const PUSH_USER_MARCH_INFO = 10019;

/**
 * 行军类型：驻军发射井（MarchType.GUN_FIGHT=35，WorldMapCommon/NWorldMapMarchCommon 枚举）。
 * PvE/PvP 占领井行军不参与跨服攻玩家城的 marchType 漂移，直接用固定值（同 domain-treasure 用 180 的口径）。
 * @type {number}
 */
const MARCH_TYPE_GUN_FIGHT = 35;
/** @type {number} 行军类型：领域寻宝挖矿（绝不纳入撤田候选） */
const MARCH_TYPE_DOMAIN_TREASURE = 180;

/** @type {number} 行军状态：ARRIVED_HOME（NMarchState=4，部队已到家、名额已释放） */
const MARCH_STATE_ARRIVED_HOME = 4;

/** @type {number} DataConfig：个人积分档位表（"num,rewardId|num,rewardId|..."，num=积分门槛） */
const CFG_TIERS_KEY = 130118;
/** @type {string} 档位兜底串：DATACONFIG 取不到时用面板内联值（实证门槛集） */
const TIERS_FALLBACK = '10,9018101|50,9018102|100,9018103|200,9018104|400,9018105|700,9018106|1200,9018107';

/** @type {number} 非服务器返回的哨兵 code：发送异常时用，与真实 s 码区分开 */
const CODE_NOT_SENT = -1;

/**
 * 内置调优常量（面板仅出功能开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {
    /** 活动期扫描间隔（毫秒）：驻军复查/领奖兜底，默认 1 分钟 */
    activeScanInterval: 1000 * 60,
    /** 非活动期扫描间隔（毫秒）：仅探活等下一轮，默认 10 分钟 */
    idleScanInterval: 1000 * 60 * 10,
    /** 逐条驻军 902 之间的休眠（毫秒）：规避 902 限流（同 titan-blessing） */
    marchInterval: 1000 * 5,
    /** 逐条撤田 904 之间的休眠（毫秒） */
    recallInterval: 1000 * 400,
    /** 逐条领 1058 之间的休眠（毫秒） */
    claimInterval: 1000 * 600,
    /** 回城/归属推送补扫的最小间隔（毫秒）：合并突发推送，免 1055 风暴 */
    pushScanMinGap: 1000 * 4,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（读 UserData 行军名额/联盟 aid/UID/服务器时间） */
var dataCenter;
/** @type {object|null} NWorldMapData.instance（读 marches：本人在外行军表，撤田/判已驻用） */
var mapData;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞流程自然退出 */
var ctxRef = null;

/** @type {boolean} 扫描在飞闸门（含 1055/902 await），防重入 */
var scanning = false;
/** @type {boolean} 在飞期间来了新触发（推送），置位，本轮结束后补扫一次 */
var scanPending = false;
/** @type {number|null} 兜底定时器；pause 后到点空转不再自重排 */
var scanTimer = null;
/** @type {number} 上次因推送补扫的墙钟时刻（毫秒），合并突发 */
var lastPushScanAt = 0;
/** @type {boolean} 当前是否在活动窗口内（决定 active/idle 扫描档） */
var inWindow = false;
/**
 * 已发 904 撤回、尚未到家（名额未释放）的行军 id 集合（键 marchId 字符串）。
 * 撤田「要几个撤几个」的去重依据：这些不再计入可撤候选、也不重复撤；返家（10019 state=4）后移除。
 * @type {Set<string>}
 */
var pendingRecall = new Set();

/** @type {boolean} install 幂等守卫 */
var installed = false;

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
 * 应答 data 归一化：旧 JSON 链路 data 常为字符串（game 侧 JSON_PARSE(t.d)），兜底已解析对象。
 * @param {*} d net.Ret.data
 * @returns {object|null} 解析后的对象；空/解析失败返回 null
 */
function parseData(d) {
    if (d == null) return null;
    if (typeof d === 'object') return d;
    if (typeof d === 'string') {
        try { return JSON.parse(d); } catch (err) { return null; }
    }
    return null;
}

/** @returns {object} DataCenter.DATA.UserData（读不到回空对象） */
function userData() {
    return (dataCenter && dataCenter.UserData) || {};
}

/** @returns {number} 服务器当前时间（秒） */
function serverNow() {
    return +(dataCenter && dataCenter.ServerTime) || 0;
}

// ── 行军表读取（本人 marches）────────────────────────────────────────
/**
 * marches 是否已就绪：NWorldMapData.instance.marches 有键即就绪。
 * 主城场景该表可能为空/未同步 → 未就绪时不做写操作（驻军/撤田），避免把「读不到自家驻军」误判成「没驻」而重复增援。
 * @returns {boolean}
 */
function marchesReady() {
    var m = mapData && mapData.marches;
    return !!(m && Object.keys(m).length);
}

/**
 * 遍历本人 marches 条目（值对象），过滤掉空/非本人。
 * 本人判定：realUid（部分活动行军被游戏改写 uid=原uid+marchId、realUid=原uid）优先，回落 uid。
 * @returns {object[]} 本人行军条目数组
 */
function myMarchList() {
    var m = mapData && mapData.marches;
    if (!m) return [];
    var uid = String(userData().UID);
    var out = [];
    for (var k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
        var march = m[k];
        if (!march) continue;
        var who = march.realUid != null ? march.realUid : march.uid;
        if (String(who) === uid) out.push(march);
    }
    return out;
}

/**
 * 行军条目目标点 (tx,ty)：mapData.marches 条目由 NWorldMapMarchModel 把 marchInfo.target 摊平成扁平
 * target_tx/target_ty（无 target 子对象）；回落嵌套 target.tx/ty（兼容直接传协议 marchInfo 的调用路径）。取不到回 null。
 * @param {object} mg 行军条目
 * @returns {{tx:number,ty:number}|null}
 */
function marchTarget(mg) {
    if (!mg) return null;
    if (mg.target_tx != null && mg.target_ty != null) return { tx: mg.target_tx | 0, ty: mg.target_ty | 0 };
    var t = mg.target;
    if (t && t.tx != null && t.ty != null) return { tx: t.tx | 0, ty: t.ty | 0 };
    return null;
}

/**
 * 行军条目目标 itemId：扁平 itemId（=marchInfo.target.itemId）优先，回落嵌套 target.itemId。命中已驻井判据用。
 * @param {object} mg 行军条目
 * @returns {number|null}
 */
function marchItemId(mg) {
    if (!mg) return null;
    if (mg.itemId != null) return Number(mg.itemId);
    var t = mg.target;
    if (t && t.itemId != null) return Number(t.itemId);
    return null;
}

/**
 * 是否已有一条驻本井的行军（marchType=35 且目标命中该井）：命中 itemId 或坐标（均走摊平字段）。
 * 关键：mapData.marches 无嵌套 target，若读 march.target.itemId/tx/ty 会恒取 undefined → 误判「没驻」而每轮重复增援。
 * @param {number} siloId 井配置 id（4001~4004）
 * @param {{x:number,y:number}} coord 井坐标
 * @returns {boolean}
 */
function hasGarrisonMarchFor(siloId, coord) {
    var list = myMarchList();
    for (var i = 0; i < list.length; i++) {
        var march = list[i];
        if ((march.marchType | 0) !== MARCH_TYPE_GUN_FIGHT) continue;
        var itemId = marchItemId(march);
        if (itemId != null && itemId === siloId) return true;
        var tgt = marchTarget(march);
        if (tgt && coord && tgt.tx === coord.x && tgt.ty === coord.y) return true;
    }
    return false;
}

/**
 * 是否"资源采集田"行军（撤田候选）：marches 摊平后无 targetType，改以 marchType 3/26 为主判据
 * （普通田 3 / 机械田 26）；显式排除驻井(35)与领域寻宝挖矿(180)；已在待撤集合(pendingRecall)的跳过。
 * @param {object} march 行军条目
 * @returns {boolean}
 */
function isRecallableFarmMarch(march) {
    var mt = march.marchType | 0;
    if (mt === MARCH_TYPE_GUN_FIGHT || mt === MARCH_TYPE_DOMAIN_TREASURE) return false;
    var mid = String(march.marchId);
    if (pendingRecall.has(mid)) return false;
    return mt === 3 || mt === 26;
}

/**
 * 取至多 limit 条可撤的田行军（marchId 原值）。
 * @param {number} limit 需要的名额缺口
 * @returns {Array<{marchId:*}>}
 */
function pickRecallableFarmMarches(limit) {
    var out = [];
    var list = myMarchList();
    for (var i = 0; i < list.length && out.length < limit; i++) {
        if (isRecallableFarmMarch(list[i])) out.push({ marchId: list[i].marchId });
    }
    return out;
}

/**
 * 全局行军名额缺口：需要 needed 条驻军时，缺几个 = needed - 当前空闲。
 * @param {number} needed 期望驻军的井数（已扣除已在驻的）
 * @returns {number} 需要腾出的名额数（<=0 表示名额够）
 */
function slotDeficit(needed) {
    var u = userData();
    var free = (u.myMarchNumMAX | 0) - (u.myMarchNum | 0);
    return needed - free;
}

// ── 井坐标（tableThrone）─────────────────────────────────────────────
/** @type {Object<string,{x:number,y:number}>} 井 id → 坐标缓存（同局活动坐标不变） */
var coordCache = {};

/**
 * 读井坐标：新图 THRONE_v2 优先、回落旧图 THRONE（对应 WorldMap2Biz.tableThrone getter）。行含 pos_x/pos_y。
 * @param {number} siloId 井 id
 * @returns {{x:number,y:number}|null}
 */
function getSiloCoord(siloId) {
    var key = String(siloId);
    if (coordCache[key]) return coordCache[key];
    var row = l10n.tableRow('THRONE_v2', siloId) || l10n.tableRow('THRONE', siloId);
    if (!row || row.pos_x == null || row.pos_y == null) return null;
    var coord = { x: Number(row.pos_x) | 0, y: Number(row.pos_y) | 0 };
    coordCache[key] = coord;
    return coord;
}

// ── 档位表（DATACONFIG 130118）───────────────────────────────────────
/**
 * 解析积分档位门槛：DATACONFIG[130118].value "num,rewardId|..." → [num,...]（升序）。取不到回落 TIERS_FALLBACK。
 * @returns {number[]} 各档位积分门槛
 */
function tierThresholds() {
    var raw;
    try { raw = gameConf.dataConfig(CFG_TIERS_KEY); } catch (err) { raw = ''; }
    var src = (raw && String(raw)) || TIERS_FALLBACK;
    var nums = [];
    src.split('|').forEach(function (seg) {
        var num = parseInt(String(seg).split(',')[0], 10);
        if (isFinite(num) && num > 0) nums.push(num);
    });
    if (!nums.length) {
        TIERS_FALLBACK.split('|').forEach(function (seg) {
            var num = parseInt(String(seg).split(',')[0], 10);
            if (isFinite(num) && num > 0) nums.push(num);
        });
    }
    return nums.sort(function (a, b) { return a - b; });
}

// ── 发包 ─────────────────────────────────────────────────────────────
/**
 * 拉活动信息（1055）。永不 reject：异常回 null。
 * @returns {Promise<object|null>} {start,end,cur,list} 或 null
 */
async function requestInfo() {
    try {
        var ret = await net.send(CMD_GET_GUN_FIGHT_INFO, {});
        if (!ret.ok) {
            log.debug('1055 not ok. code=%d', ret.code);
            return null;
        }
        return parseData(ret.data);
    } catch (err) {
        log.warn('request info error.', err);
        return null;
    }
}

/**
 * 拉个人积分信息（1057）。永不 reject：异常回 null。
 * @returns {Promise<object|null>} {total,reward:[]} 或 null
 */
async function requestUserInfo() {
    try {
        var ret = await net.send(CMD_GET_GUN_FIGHT_USER_INFO, {});
        if (!ret.ok) return null;
        return parseData(ret.data);
    } catch (err) {
        log.warn('request user info error.', err);
        return null;
    }
}

/**
 * 领取某档位积分奖励（1058 {score:num}）。永不 reject。
 * @param {number} num 档位门槛值
 * @returns {Promise<object>} net.Ret
 */
async function sendClaim(num) {
    try {
        return await net.send(CMD_GET_GUN_FIGHT_USER_REWARD, { score: Number(num) });
    } catch (err) {
        log.warn('claim send error. num=%d', num, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 驻军某井（902 marchType=35 minimal）。载荷对齐 quick-attack 的 start_commonMarch 口径。永不 reject。
 * @param {{x:number,y:number}} coord 井坐标
 * @param {object} plan MarchData（5 字段）
 * @returns {Promise<object>} net.Ret
 */
async function sendGarrison(coord, plan) {
    try {
        return await net.send(CMD_MARCH_WORLD_POINT, {
            marchType: MARCH_TYPE_GUN_FIGHT,
            x: coord.x,
            y: coord.y,
            armyList: plan.armyListNew,
            armyListNew: plan.armyListNew,
            heroList: plan.heroList,
            trapList: plan.trapList,
            formation: 0,
            formationV2: plan.formationV2,
            extraArmy: plan.extraArmy,
        });
    } catch (err) {
        log.warn('garrison send error. x=%d;y=%d', coord.x, coord.y, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 撤回一条行军（904 {marchId}）。永不 reject；成功即记入 pendingRecall（名额返程后才释放）。
 * @param {*} marchId 行军 id
 * @returns {Promise<void>}
 */
async function sendRecall(marchId) {
    try {
        var ret = await net.send(CMD_RECALL_MARCH, { marchId: marchId });
        if (ret.ok) {
            pendingRecall.add(String(marchId));
            log.info('recall farm march ok. marchId=%s', marchId);
        } else {
            log.warn('recall farm march rejected. marchId=%s;code=%d;data=%s', marchId, ret.code, ret.data);
        }
    } catch (err) {
        log.warn('recall send error. marchId=%s', marchId, err);
    }
}

// ── 领积分 ───────────────────────────────────────────────────────────
/**
 * 领一轮个人积分奖励：1057 拉 total 与已领 reward[] → 逐档「total≥门槛且未领」发 1058，串行、间隔休眠。永不 reject。
 * @returns {Promise<void>}
 */
async function claimRewards() {
    if (net.isSending(CMD_GET_GUN_FIGHT_USER_INFO)) return;
    var ui = await requestUserInfo();
    if (!aliveFn() || !ui) return;
    var total = Number(ui.total) || 0;
    var got = Array.isArray(ui.reward) ? ui.reward.map(Number) : [];
    var thresholds = tierThresholds();
    for (var i = 0; i < thresholds.length; i++) {
        var num = thresholds[i];
        if (!aliveFn()) return;
        if (total < num) continue;                 // 积分不足：游戏侧本地拦截不发 1058，这里同口径跳过
        if (got.indexOf(num) >= 0) continue;       // 已领（reward[] 幂等真相）
        if (net.isSending(CMD_GET_GUN_FIGHT_USER_REWARD)) break;
        var ret = await sendClaim(num);
        if (!aliveFn()) return;
        if (ret.ok) {
            got.push(num);                          // 本地补记，防本轮重复发同一档
            log.info('claim ok. score=%d;total=%d', num, total);
        } else {
            log.warn('claim rejected. score=%d;code=%d;data=%s', num, ret.code, ret.data);
        }
        if (i < thresholds.length - 1) await sleep(cfg.claimInterval);
    }
}

// ── 驻军（含撤田腾队列）─────────────────────────────────────────────
/**
 * 驻军一轮：找出「归属本联盟且我未驻」的井 → 名额够则逐条 minimal 入驻；名额不足且开了撤田则按需撤回采集田。
 * 撤回不立即释放名额，缺口留待下一轮（回城推送/兜底定时唤醒）补派。永不 reject。
 * @param {object[]} list 1055 应答的井列表 [{id,owner,...}]
 * @returns {Promise<void>}
 */
async function garrisonPass(list) {
    var alliance = gameData.alliance();
    var myAid = alliance && Number(alliance.Aid);
    if (!myAid) {
        log.debug('no alliance, skip garrison.');
        return;
    }
    // marches 未就绪（主城场景）：不做写操作，避免把「读不到自家驻军」误判成「没驻」而重复增援
    if (!marchesReady()) {
        log.debug('march data not ready (Home?), skip garrison this cycle.');
        return;
    }

    // 需要驻的井：归属本联盟 && 我尚无驻军行军 && 坐标可读
    var wanted = [];
    for (var i = 0; i < list.length; i++) {
        var silo = list[i];
        if (Number(silo.owner) !== myAid) continue;          // 非我盟的井：只等待，不打
        var coord = getSiloCoord(Number(silo.id));
        if (!coord) {
            log.debug('silo coord unavailable, skip. id=%s', silo.id);
            continue;
        }
        if (hasGarrisonMarchFor(Number(silo.id), coord)) continue;   // 已在驻：跳过
        wanted.push({ id: Number(silo.id), x: coord.x, y: coord.y });
    }
    if (!wanted.length) return;

    // 撤田腾队列：仅当名额不足且开启撤田。缺口 = 待驻数 - 空闲名额；要几个撤几个（已在途/返程的去重由 pendingRecall 保证）
    var deficit = slotDeficit(wanted.length);
    if (deficit > 0) {
        var picks = pickRecallableFarmMarches(deficit);
        if (picks.length) {
            log.info('slots short by %d, recalling %d farm march(s).', deficit, picks.length);
            for (var j = 0; j < picks.length; j++) {
                if (!aliveFn()) return;
                await sendRecall(picks[j].marchId);
                if (j < picks.length - 1) await sleep(cfg.recallInterval);
            }
        } else {
            log.debug('no recallable farm march, wait for free slot.');
        }
        // 撤回名额须返程后才释放，本轮不阻塞派发，留给下一轮补
        return;
    }

    // 名额够：逐条 minimal 入驻（每条前现判名额，避免入表延迟导致超发）
    for (var k = 0; k < wanted.length; k++) {
        if (!aliveFn()) return;
        if (slotDeficit(wanted.length - k) > 0) {
            log.debug('no free march slot now, stop dispatch. remaining=%d', wanted.length - k);
            return;
        }
        if (net.isSending(CMD_MARCH_WORLD_POINT)) return;

        var plan = new Battle().plan().minimal().build();
        if (!plan.armyListNew.length) {
            log.warn('no dispatchable army, skip garrison. silo=%d', wanted[k].id);
            return;
        }
        var ret = await sendGarrison(wanted[k], plan);
        if (!aliveFn()) return;
        if (ret.ok) {
            log.info('garrison ok. silo=%d;x=%d;y=%d', wanted[k].id, wanted[k].x, wanted[k].y);
        } else {
            log.warn('garrison rejected. silo=%d;x=%d;y=%d;code=%d;data=%s',
                wanted[k].id, wanted[k].x, wanted[k].y, ret.code, ret.data);
        }
        if (k < wanted.length - 1) await sleep(cfg.marchInterval);
    }
}

// ── 扫描调度 ─────────────────────────────────────────────────────────
/**
 * 兜底定时器武装：自重排一次 triggerScan；pause 后 alive()=false，到点空转不再自重排。
 * @param {number} delay 延迟（毫秒）
 */
function scheduleScan(delay) {
    if (!aliveFn()) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
        scanTimer = null;
        if (aliveFn()) triggerScan();
    }, Math.max(0, delay));
}

/**
 * 扫描触发汇入口：推送 / run / 兜底定时都走这里。在飞时不并发进入，只置 scanPending，本轮结束后补扫。
 */
function triggerScan() {
    if (!aliveFn()) return;
    if (scanning) {
        scanPending = true;
        return;
    }
    doScan().catch(function (err) {
        log.warn('scan threw.', err);
    });
}

/**
 * 单轮扫描：1055 判活动窗口 → 窗口内按需领奖 + 驻军 → 排下一次。非窗口只探活、不发写包。永不 reject。
 * @returns {Promise<void>}
 */
async function doScan() {
    scanning = true;
    try {
        var info = await requestInfo();
        if (!aliveFn()) return;

        var now = (info && Number(info.cur)) || serverNow();
        inWindow = !!(info && Number(info.start) <= now && now < Number(info.end));
        if (!inWindow) {
            log.debug('activity not open, idle.');
            return;
        }

        var list = (info && info.list) || [];
        await claimRewards();
        if (!aliveFn()) return;
        await garrisonPass(list);
    } finally {
        scanning = false;
    }

    if (!aliveFn()) return;
    if (scanPending) {
        scanPending = false;
        triggerScan();
        return;
    }
    scheduleScan(inWindow ? cfg.activeScanInterval : cfg.idleScanInterval);
}

// ── 推送入口 ─────────────────────────────────────────────────────────
/**
 * 由推送触发的补扫（去抖）：距上次补扫 < pushScanMinGap 则忽略（仅靠兜底定时收尾）。
 */
function pushWake() {
    if (!aliveFn()) return;
    var wall = Date.now();
    if (wall - lastPushScanAt < cfg.pushScanMinGap) return;
    lastPushScanAt = wall;
    triggerScan();
}

/** 11017 单井归属/占领变化：可能刚变成我盟所有 → 补扫驻军。 */
function onGunFightInfoPush() {
    pushWake();
}

/** 10029 个人积分/已领刷新：积分可能跨过新档位 → 补扫领奖。 */
function onRewardPush() {
    pushWake();
}

/**
 * 10019 本人行军状态：仅认「我方某条已撤田行军 state=4 到家」——该 marchId 出 pendingRecall，
 * 名额已释放，唤醒补扫把空出来的名额用于驻军（非回城/非撤田的推送忽略）。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 */
function onMarchUpdate(ev) {
    if (!aliveFn()) return;
    var d = ev && ev.data;
    var mi = d && d.marchInfo;
    if (!mi) return;
    if ((mi.state | 0) !== MARCH_STATE_ARRIVED_HOME) return;
    var mid = String(mi.marchId);
    if (!pendingRecall.has(mid)) return;   // 不是我们撤的田（如驻军/其它行军回城），不唤醒
    pendingRecall.delete(mid);
    log.debug('recalled farm march arrived home (marchId=%s), slot freed.', mid);
    pushWake();
}

// ── 生命周期 ─────────────────────────────────────────────────────────
/**
 * 安装：取网络底座 + 数据中心 + 地图数据。任一缺失即失败（reactor 不会激活）。
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

    var nmd = game.get('NWorldMapData');
    mapData = (nmd && nmd.default && nmd.default.instance) || (missing.push('NWorldMapData'), null);

    if (missing.length) {
        net = null; dataCenter = null; mapData = null;
        log.warn('install failed. missing=%s', missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed.');
    return true;
}

/**
 * 运行：复位状态 → 挂 11017/10029/10019 监听 → 主动扫一次。
 * pause 后 alive()=false 定时器自然停摆；resume 重新复位点火（scheduleScan 先 clearTimeout，不重复）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    scanning = false;
    scanPending = false;
    inWindow = false;
    lastPushScanAt = 0;
    pendingRecall.clear();
    coordCache = {};
    ctx.on.push(PUSH_GUN_FIGHT_INFO, onGunFightInfoPush);
    ctx.on.push(PUSH_GUN_FIGHT_REWARD_INFO, onRewardPush);
    ctx.on.push(PUSH_USER_MARCH_INFO, onMarchUpdate);
    log.info('started (驻军+领积分+撤田腾队列 内置默认).');
    triggerScan();
}

/**
 * 向 reactor 注册本功能说明书：场景限定 Home/NWorldMap，战斗模式暂停（offInCombat）。
 * 无面板可调项：驻军 / 领积分 / 队列不足撤田均为内置默认行为；面板只出 enabled 一个勾选。
 */
reactor.register({
    id: 'launchSilo',
    label: '占领发射井',
    storageKey: 'pocketcc.feat.launchSilo',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: { enabled: false },
    fields: [],
    toModuleCfg: function () { return {}; },
    install: install,
    run: run,
});
