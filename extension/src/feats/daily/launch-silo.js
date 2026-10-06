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
 *   全局行军名额读 UserData.myMarchNumMAX - myMarchNum（跨场景可靠，走 core/march.freeSlots）。
 *   仅当「需驻军且名额不足」才撤田；撤几个＝名额缺口（要几个撤几个）；撤回不立即释放名额，须返程 state=4 到家才释放，
 *   故本轮撤回后不阻塞等待——名额释放由下一轮扫描（march.onHomeReturn 回城唤醒 / 兜底定时）自然补派。
 *   "田"＝资源采集行军：判据以 marchType 3/26 为准（普通田 3 / 机械田 26），显式排除驻井 35 与领域寻宝挖矿 180；
 *   命中已驻井同理取归一化 March.target.itemId/x/y（摊平/嵌套差异已由 march.js 抹平）。
 *
 * 生命周期由 reactor 托管：install/run 两个钩子，scenes 门控限定 Home/NWorldMap，战斗模式暂停（offInCombat）。
 *   驻军/撤田/领积分均为内置默认行为，无面板可调项（面板仅出 enabled 勾选）。
 *   驻军/撤田读本人行军走 core/march.list()（封装 856 GET_ALL_MY_MARCH_INFO，视口无关、Home 亦有全量；不再依赖 mapData.marches）。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { l10n, gameConf, gameData } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=LAUNCH-SILO） */
const log = createLog('LAUNCH-SILO');

/** @type {number} RequestId.GET_GUN_FIGHT_INFO：活动信息 + 4 井归属（JSON send，{}） */
const CMD_GET_GUN_FIGHT_INFO = 1055;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_INFO：个人积分与已领档位（JSON send，{}） */
const CMD_GET_GUN_FIGHT_USER_INFO = 1057;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_REWARD：领取某档位积分奖励（JSON send，{score:num}） */
const CMD_GET_GUN_FIGHT_USER_REWARD = 1058;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（驻军）——仅用于发驻军前的同 cmd 在途频控 */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {number} ResponseId.PUSH_GUN_FIGHT_INFO（=11017）：单井归属/占领增量推送 */
const PUSH_GUN_FIGHT_INFO = 11017;
/** @type {number} ResponseId.PUSH_GUN_FIGHT_REWARD_INFO（=10029）：个人积分/已领档位刷新推送 */
const PUSH_GUN_FIGHT_REWARD_INFO = 10029;

/**
 * 行军类型：驻军发射井（MarchType.GUN_FIGHT=35，WorldMapCommon/NWorldMapMarchCommon 枚举）。
 * PvE/PvP 占领井行军不参与跨服攻玩家城的 marchType 漂移，直接用固定值（同 domain-treasure 用 180 的口径）。
 * @type {number}
 */
const MARCH_TYPE_GUN_FIGHT = 35;
/** @type {number} 行军类型：领域寻宝挖矿（永不纳入撤田候选） */
const MARCH_TYPE_DOMAIN_TREASURE = 180;

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
/** @type {object|null} DataCenter.DATA（读 UserData 联盟 aid/UID/服务器时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞流程自然退出 */
var ctxRef = null;

/**
 * 扫描单飞闸门 / 触发合并 / 兜底定时器均收口到 core/cycle（见下方 cycle 实例）；
 * feat 只保留活动窗口态 inWindow（决定 active/idle 两档）供 cycleRun 返回下拍间隔。
 */
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
// 本人行军统一走 core/march.list()（856 权威源，返回归一化 March[]，视口无关、Home 亦有全量）：
//   March = { id:str, type, state, isOccupying, target:{x,y,itemId}, raw }。摊平/嵌套/Int64 三坑已由 march.js 抹平。
/**
 * 是否已有一条驻本井的行军（marchType=35 且目标命中该井）：命中 itemId 或坐标。
 * @param {number} siloId 井配置 id（4001~4004）
 * @param {{x:number,y:number}} coord 井坐标
 * @param {object[]} myMarches march.list() 结果
 * @returns {boolean}
 */
function hasGarrisonMarchFor(siloId, coord, myMarches) {
    for (var i = 0; i < myMarches.length; i++) {
        var m = myMarches[i];
        if ((m.type | 0) !== MARCH_TYPE_GUN_FIGHT) continue;
        if (m.target.itemId && m.target.itemId === siloId) return true;
        if (coord && m.target.x === coord.x && m.target.y === coord.y) return true;
    }
    return false;
}

/**
 * 是否"资源采集田"行军（撤田候选）：以 marchType 3/26 为主判据（普通田 3 / 机械田 26）；
 * 显式排除驻井(35)与领域寻宝挖矿(180)；已在待撤集合(pendingRecall)的跳过。
 * @param {object} m 归一化 March
 * @returns {boolean}
 */
function isRecallableFarmMarch(m) {
    var mt = m.type | 0;
    if (mt === MARCH_TYPE_GUN_FIGHT || mt === MARCH_TYPE_DOMAIN_TREASURE) return false;
    if (pendingRecall.has(m.id)) return false;
    return mt === 3 || mt === 26;
}

/**
 * 取至多 limit 条可撤的田行军（marchId 字符串，已 >2^53 安全）。
 * @param {number} limit 需要的名额缺口
 * @param {object[]} myMarches march.list() 结果
 * @returns {Array<{marchId:string}>}
 */
function pickRecallableFarmMarches(limit, myMarches) {
    var out = [];
    for (var i = 0; i < myMarches.length && out.length < limit; i++) {
        if (isRecallableFarmMarch(myMarches[i])) out.push({ marchId: myMarches[i].id });
    }
    return out;
}

/**
 * 全局行军名额缺口：需要 needed 条驻军时，缺几个 = needed - 当前空闲（core/march.freeSlots，读 UserData）。
 * @param {number} needed 期望驻军的井数（已扣除已在驻的）
 * @returns {number} 需要腾出的名额数（<=0 表示名额够）
 */
function slotDeficit(needed) {
    return needed - march.freeSlots();
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
    return await march.attack({ marchType: MARCH_TYPE_GUN_FIGHT, target: { x: coord.x, y: coord.y }, data: plan });
}

/**
 * 撤回一条行军（core/march.recall → 904 {marchId}）。永不 reject；成功即记入 pendingRecall（名额返程后才释放）。
 * @param {string} marchId 行军 id
 * @returns {Promise<void>}
 */
async function sendRecall(marchId) {
    var ret = await march.recall(marchId);
    if (ret.ok) {
        pendingRecall.add(String(marchId));
        log.info('recall farm march ok. marchId=%s', marchId);
    } else {
        log.info('recall farm march rejected. marchId=%s;code=%d;data=%s', marchId, ret.code, ret.data);
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
            log.info('claim rejected. score=%d;code=%d;data=%s', num, ret.code, ret.data);
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
    // 本人行军权威源（core/march.list 封装 856）：视口无关、Home 亦有全量，取代旧 mapData.marches（Home 读空会误判「没驻」而重复增援）
    var myMarches = await march.list();
    if (!aliveFn()) return;

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
        if (hasGarrisonMarchFor(Number(silo.id), coord, myMarches)) continue;   // 已在驻：跳过
        wanted.push({ id: Number(silo.id), x: coord.x, y: coord.y });
    }
    if (!wanted.length) return;

    // 撤田腾队列：仅当名额不足且开启撤田。缺口 = 待驻数 - 空闲名额；要几个撤几个（已在途/返程的去重由 pendingRecall 保证）
    var deficit = slotDeficit(wanted.length);
    if (deficit > 0) {
        var picks = pickRecallableFarmMarches(deficit, myMarches);
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
            log.debug('no dispatchable army, skip garrison. silo=%d', wanted[k].id);
            return;
        }
        var ret = await sendGarrison(wanted[k], plan);
        if (!aliveFn()) return;
        if (ret.ok) {
            log.info('garrison ok. silo=%d;x=%d;y=%d', wanted[k].id, wanted[k].x, wanted[k].y);
        } else {
            log.info('garrison rejected. silo=%d;x=%d;y=%d;code=%d;data=%s',
                wanted[k].id, wanted[k].x, wanted[k].y, ret.code, ret.data);
        }
        if (k < wanted.length - 1) await sleep(cfg.marchInterval);
    }
}

// ── 扫描调度 ─────────────────────────────────────────────────────────
/**
 * 单轮扫描主体（core/cycle 调和循环：单飞闸门 + 触发合并 + 绝不停摆均由 cycle 承载）：
 * 1055 判活动窗口 → 窗口内按需领奖 + 驻军 → 返回下拍间隔（毫秒；<=0=立即补扫）。
 * 非窗口只探活、不发写包；与旧 doScan 末尾同序：在飞期间有补扫→立即再扫；否则按窗口档位兜底。
 * @returns {Promise<number>}
 */
async function cycleRun() {
    var info = await requestInfo();
    if (!aliveFn()) return 0;   // pause 中途：cycle 会在 alive 检查处自然停摆
    var now = (info && Number(info.cur)) || serverNow();
    inWindow = !!(info && Number(info.start) <= now && now < Number(info.end));
    if (!inWindow) {
        log.debug('activity not open, idle.');
    } else {
        var list = (info && info.list) || [];
        await claimRewards();
        if (!aliveFn()) return 0;
        await garrisonPass(list);
    }
    if (cycle.pending) return 0;
    return inWindow ? cfg.activeScanInterval : cfg.idleScanInterval;
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取 active 档，防异常停摆） */
const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: cfg.activeScanInterval });

// ── 推送入口 ─────────────────────────────────────────────────────────
/**
 * 由推送触发的补扫（去抖）：距上次补扫 < pushScanMinGap 则忽略（仅靠兜底定时收尾）。
 */
function pushWake() {
    if (!aliveFn()) return;
    var wall = Date.now();
    if (wall - lastPushScanAt < cfg.pushScanMinGap) return;
    lastPushScanAt = wall;
    cycle.kick();
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
 * 行军到家（march.onHomeReturn 复播，state→ARRIVED_HOME 边沿）：仅认「我方某条已撤田行军」——
 * 该 marchId 出 pendingRecall，名额已释放，唤醒补扫把空出的名额用于驻军。
 * 全局单点订阅的代价：march.js 常驻 10019，feat 暂停仍会收到复播 → 回调内自判 alive 为硬约束。
 * @param {object} m 归一化 March
 */
function onMarchArrivedHome(m) {
    if (!aliveFn()) return;
    var mid = m && m.id;
    if (!mid || !pendingRecall.has(mid)) return;   // 不是我们撤的田（如驻军/其它行军回城），不唤醒
    pendingRecall.delete(mid);
    log.debug('recalled farm march arrived home (marchId=%s), slot freed.', mid);
    pushWake();
}

/** @type {Function|null} march.onHomeReturn 退订句柄（防 resume 重激活重复注册） */
var offHomeReturn = null;

// ── 生命周期 ─────────────────────────────────────────────────────────
/**
 * 安装：取网络底座 + 数据中心。任一缺失即失败（reactor 不会激活）。
 * 本人行军改走 core/march.list()（856），不再依赖 NWorldMapData。
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
 * 运行：复位状态 → 挂 11017/10029/10019 监听 → 主动扫一次。
 * pause 后 alive()=false 定时器自然停摆；resume 重新复位点火（cycle.kick 内部先清旧定时器，不重复）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    inWindow = false;
    lastPushScanAt = 0;
    pendingRecall.clear();
    coordCache = {};
    ctx.on.push(PUSH_GUN_FIGHT_INFO, onGunFightInfoPush);
    ctx.on.push(PUSH_GUN_FIGHT_REWARD_INFO, onRewardPush);
    if (offHomeReturn) offHomeReturn();   // 先退再挂，防 resume 重激活重复注册
    offHomeReturn = march.onHomeReturn(onMarchArrivedHome);
    log.info('started (驻军+领积分+撤田腾队列 内置默认).');
    cycle.kick();
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
