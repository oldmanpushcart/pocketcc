/**
 * 领域夺宝-挖矿功能（reactor 说明书形态）
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *
 * 生产端有三个触发源：
 *   1) 推送 10912（PUSH_ONE_ACTIVITYEXTRA，载荷 {aid,extra}）：新矿脉诞生时服务器推它 → aid 反查是领域寻宝 → 触发扫描；
 *   2) run() 启动即主动扫描一次；
 *   3) 兜底定时（active/idle 两档：发现矿脉用 active 短间隔，连续 EMPTY_STREAK_IDLE 次空扫降到 idle 长间隔）：防止服务器漏推。
 *   触发一律汇入 triggerScan：扫描/消费在飞时只置 scanPending，不并发改 queue，本轮结束后再补扫一次（多条推送合并成一次）。
 *   生产 doScan：找活动 → 名额够 → 拉 8623 → 过滤 gatherStatus===0 → 整批替换 queue → 交消费。
 *   消费 consume：consuming 闸门保证单循环，逐条 shift → digFlow 派 902 → 每条间 sleep(digInterval)；排空/名额满/退让后 afterConsume 重排。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap。
 *   consume 有"名额满即停 + afterConsume 重排"的独有逻辑，不套 createDrain，原样保留在本文件。
 *   兜底定时器是功能内部生产逻辑，pause 后 alive()=false 自然停摆，resume 时 run 复位状态并重新点火。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=DOMAIN-TREASURE-MINER） */
const log = createLog('DOMAIN-TREASURE-MINER');

/** @type {number} ResponseId.PUSH_ONE_ACTIVITYEXTRA（ResponseId.js:229），活动 extra 更新推送，载荷 {aid, extra}；新矿脉诞生时推它 */
const CMD_PUSH_ONE_ACTIVITY_EXTRA = 10912;

/** @type {number} 矿脉列表查询（应答 data.otherKuangList，gatherStatus 标可挖状态） */
const CMD_GET_KUANG_LIST = 8623;

/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军请求（挖矿派 902） */
const CMD_MARCH_WORLD_POINT = 902;

/**
 * 领域寻宝活动 type（来源：实际观察；与 showUiType="domainTreasure" 同指一个活动）
 * @type {number}
 */
const ACTIVITY_TYPE_DOMAIN_TREASURE = 279;

/**
 * 行军类型：挖掘领域夺宝矿脉行军
 * 定义：NWorldMapMarchCommon.NMarchType.DOMAIN_TREASURE
 * @type {number}
 */
const MARCH_TYPE = 180;

/**
 * 非服务器返回的哨兵 code：闸门未放开 / 发送异常时用，与真实 s 码区分开
 * @type {number}
 */
const CODE_NOT_SENT = -1;

/** @type {string} 902 被拒的服务器错误标识：矿脉剩余时间不足以支撑行军。拉黑该矿，直到它从 8623 名单消失 */
const ERR_MINE_TIME_NOT_ENOUGH = 'field_lottery_37';

/** @type {string} 902 被拒的服务器错误标识：活动行军队列已满。清空本轮队列退让 */
const ERR_MARCH_QUEUE_FULL = 'summer_error_01';

/**
 * 内置调优常量（面板仅出启用开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {

    /**
     * 活跃扫描间隔：默认1分钟。本轮扫描发现了可派矿时用这档，勤扫趁名额还空多挖
     */
    activeScanInterval: 1000 * 60,

    /**
     * 空转扫描间隔：默认10分钟。连续 EMPTY_STREAK_IDLE 次扫描都没矿脉后降到这档，少刷 8623。
     * 推送 10912 仍是主触发源，新矿脉一诞生即被推醒，不必等这档定时
     */
    idleScanInterval: 1000 * 60 * 10,

    /**
     * 挖矿间隔：默认5秒（消费逐条之间的休眠）
     * 承重约束：必须大于"行军入表延迟"。每条派前现判名额读的是 marches，刚派那条要等游戏写进 marches 才数得到。
     * 调太小会在入表前连派、尝试超过 para6——超出的会被服务器拒（领域寻宝 902 被拒零成本），不会真超发，只多刷 rejected 日志。
     */
    digInterval: 1000 * 5,

};

/** @type {number} 连续这么多次扫描都没矿脉，才把扫描间隔从 active 降到 idle（去抖：单次漏扫不立即降频） */
const EMPTY_STREAK_IDLE = 2;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} 活动控制器（aid 反查活动、活动列表/开启判定） */
var activityCtl;
/** @type {object|null} 地图数据（NWorldMapData.instance.marches，判在途行军数） */
var mapData;
/** @type {object|null} 数据中心（UID） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞流程自然退出 */
var ctxRef = null;

/** @type {object[]} 本轮扫描过滤出的可派矿（gatherStatus===0），consume 逐条 shift */
var queue = [];
/** @type {boolean} 消费闸门：同时只有一个 consume 循环 */
var consuming = false;
/** @type {boolean} 生产闸门：同时只有一个 doScan 在飞（含 8623 await） */
var scanning = false;
/** @type {boolean} 扫描/消费在飞时来了新触发（推送/run），置位；本轮结束后补扫一次 */
var scanPending = false;
/** @type {number|null} 兜底定时器；pause 后到点空转不再自重排 */
var scanTimer = null;
/** @type {object|null} 当前轮活动信息，消费段每条派前现判名额（para6）用 */
var scanActivity = null;
/** @type {number} 连续空扫计数：发现矿脉/名额满即清零，达到 EMPTY_STREAK_IDLE 转 idle 间隔 */
var emptyStreak = 0;

/**
 * 异常矿脉黑名单，键 "x,y"（8623 不返回矿脉唯一 id，坐标即身份）。
 * 剩余时间不足以行军的矿被服务器拒派后，仍会以 gatherStatus===0 留在后续快照里，
 * 不拉黑就每轮白派一次；由 pruneBlacklist 在每次 8623 成功返回后按全量名单解禁。
 * @type {Set<string>}
 */
var blacklist = new Set();

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
 * 等待毫秒
 * @param {number} ms 时长
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * 矿脉身份键（黑名单用）
 * @param {number} x 横坐标
 * @param {number} y 纵坐标
 * @returns {string} "x,y"
 */
function mineKey(x, y) {
    return x + ',' + y;
}

/**
 * 兜底定时器武装器：自重排一次 triggerScan；pause 后 alive()=false，到点空转不再自重排
 * @param {number} delay 延迟(毫秒)
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
 * 扫描触发汇入口：推送 / run / 兜底定时都走这里。
 * 扫描或消费在飞时不并发进入，只置 scanPending，由本轮 afterConsume 补扫（多条触发合并成一次）
 */
function triggerScan() {
    if (!aliveFn()) return;
    if (scanning || consuming) {
        scanPending = true;
        return;
    }
    doScan().catch(function (err) {
        log.warn('scan threw.', err);
    });
}

/**
 * 生产端：找活动 → 名额够 → 拉 8623 → 过滤可派 → 整批替换 queue → 交消费。永不 reject。
 * @returns {Promise<void>}
 */
async function doScan() {
    scanning = true;
    try {
        // 活动并未开启：清空队列，交 afterConsume 排兜底。算一次空扫（没矿可检测）
        var activity = getDomainTreasureActivity();
        if (!activity) {
            log.debug('no activity found.');
            queue.length = 0;
            emptyStreak++;
            return;
        }

        // 活动行军队列不足：满员就不必白发一个 8623。这是"有活干、暂时派不下"，非空扫，清零保持活跃档勤复查名额
        if (!isDomainTreasureActivityMarchEnough(activity)) {
            log.debug('not enough march slots.');
            queue.length = 0;
            emptyStreak = 0;
            return;
        }

        // loading 返回 Ret：code=8623 状态码，data=过滤后的可派矿（失败/闸门时为 null）
        var ret = await loadingDomainTreasureActivityMines(activity);
        if (!aliveFn()) return;

        if (!ret.ok || !ret.data || !ret.data.length) {
            log.debug('no mines found. code=%d', ret.code);
            queue.length = 0;
            emptyStreak++;
            return;
        }

        // 每轮 8623 是全量快照，整批替换队列（追加会累积重复矿）；scanActivity 留给消费段判名额
        scanActivity = activity;
        queue = ret.data;
        emptyStreak = 0;
        log.debug('mines loaded. count=%d', queue.length);
    } catch (err) {
        log.warn('scan error.', err);
        queue.length = 0;
        emptyStreak++;
    } finally {
        scanning = false;
    }

    if (!aliveFn()) return;
    // 即便队列空也进 consume：它空转一圈后由 afterConsume 统一重排，触发源单一
    consume().catch(function (err) {
        log.warn('consume loop threw.', err);
    });
}

/**
 * 消费端：串行消费队列，consuming 闸门防重入；每条之间休眠 digInterval（队列空则不空等）。永不 reject。
 * @returns {Promise<void>}
 */
async function consume() {
    if (consuming) return;
    consuming = true;
    try {
        while (queue.length && aliveFn()) {
            // 名额满：停止本轮消费，等下一轮扫描重新判
            if (!isDomainTreasureActivityMarchEnough(scanActivity)) {
                log.debug('march slots full, drain stopped.');
                queue.length = 0;
                break;
            }
            var mine = queue.shift();
            try {
                await digFlow(mine);
            } catch (err) {
                log.warn('dig flow threw.', err);
            }
            if (queue.length && aliveFn()) {
                await sleep(cfg.digInterval);
            }
        }
    } finally {
        consuming = false;
    }
    if (!aliveFn()) return;
    afterConsume();
}

/**
 * 下一轮兜底扫描间隔：连续空扫达到 EMPTY_STREAK_IDLE 次 → idle 长间隔（降频空转），否则 active 短间隔。
 * 发现矿脉/名额满会把 emptyStreak 清零（doScan），从而回到 active 档
 * @returns {number} 毫秒
 */
function nextScanInterval() {
    return emptyStreak >= EMPTY_STREAK_IDLE ? cfg.idleScanInterval : cfg.activeScanInterval;
}

/**
 * 一轮消费收尾：在飞期间攒下的触发（scanPending）优先补扫，否则武装兜底定时
 */
function afterConsume() {
    if (scanPending) {
        scanPending = false;
        triggerScan();
        return;
    }
    scheduleScan(nextScanInterval());
}

/**
 * 10912 推送入口：aid 反查是领域寻宝就触发扫描，listener 本身永不 throw。
 * 10912 任何活动的 extra 更新都会推它，故必先按 aid 认出领域寻宝
 * @param {object} ev net.on 事件 {cmd, status, data, ord, ts, raw}
 */
function onActivityExtraPush(ev) {
    if (!aliveFn()) return;

    var aid = ev && ev.data && ev.data.aid;
    if (!isDomainTreasureAid(aid)) {
        return;
    }

    log.info('new mine push received, trigger scan. aid=%d', aid);
    triggerScan();
}

/**
 * aid 是否指向一个领域寻宝活动
 * @param {number} aid 推送载荷里的活动 id
 * @returns {boolean}
 */
function isDomainTreasureAid(aid) {
    if (!aid) return false;
    var activity = activityCtl.getActivityByActivityId(aid);
    return !!activity && activity.type === ACTIVITY_TYPE_DOMAIN_TREASURE;
}

/**
 * 单条派遣流程：派 902 → 打一条结果日志 → 按服务器错误标识分流。永不 reject。
 * 日志单一出口在这里：一次派遣只打一条（成功 debug、被拒 warn），发包函数不再自己打被拒日志。
 * @param {object} mine 矿洞信息 {x,y}
 * @returns {Promise<void>}
 */
async function digFlow(mine) {
    var ret = await diggingDomainTreasureActivityMine(mine);
    if (!aliveFn()) return;

    if (ret.ok) {
        log.debug('dig ok. x=%d;y=%d', mine.x, mine.y);
        return;
    }

    /*
     * 矿脉剩余时间不足以行军：服务器拒派，但这条矿还会以 gatherStatus===0 留在后续 8623 快照里，
     * 不拉黑就每轮白派一次。拉黑到它从名单消失为止（pruneBlacklist 解禁），本轮队列其余矿照派。
     */
    if (ret.code === 3 && ret.data === ERR_MINE_TIME_NOT_ENOUGH) {
        blacklist.add(mineKey(mine.x, mine.y));
        log.info('dig rejected, mine blacklisted. x=%d;y=%d;code=%d;data=%s',
            mine.x, mine.y, ret.code, ret.data);
        return;
    }

    /*
     * 服务器主动返回：活动行军队列到达上限
     * 这种情况是因为主界面在主城区，导致地图数据中拿不到活动行军队列数量，让脚本进行了误判。
     * 遇到这种情况，主动退让：清空队列，consume 循环随即结束 → afterConsume 重排。
     */
    if (ret.code === 3 && ret.data === ERR_MARCH_QUEUE_FULL) {
        log.info('dig rejected, march queue full (server), retreat. x=%d;y=%d;code=%d;data=%s',
            mine.x, mine.y, ret.code, ret.data);
        queue.length = 0;
        return;
    }

    log.info('dig rejected. x=%d;y=%d;code=%d;data=%s', mine.x, mine.y, ret.code, ret.data);
}


/**
 * 获取活动信息（领域寻宝且仍在期，多个时取第一个）
 * @returns {object|undefined} 活动对象，未开启时 undefined
 */
function getDomainTreasureActivity() {
    return activityCtl.getActivityList()
        .find(function (activity) {

            /*
             * 还要求在期——getActivityList 不保证只返回开着的，对已结束的活动发 8623/902 只会被拒
             */
            return activity.type === ACTIVITY_TYPE_DOMAIN_TREASURE
                && activityCtl.checkActivityIsOpen(activity.id) === true;

        });
}

/**
 * 加载矿洞列表
 * 永不 reject：闸门未放开 / 发送异常都回落到 CODE_NOT_SENT 的哨兵 Ret，调度据此按"这一跳没数据"处理
 * @param {object} activity 活动信息
 * @returns {Promise<Ret>} code=8623 状态码，data=过滤后的可派矿数组（[{x,y}]）或 null
 */
async function loadingDomainTreasureActivityMines(activity) {
    // 闸门未放开（游戏面板也在拉）：不静默断链，回哨兵 Ret
    if (!activity || net.isSending(CMD_GET_KUANG_LIST)) {
        return net.Ret.from(CODE_NOT_SENT, null);
    }

    try {
        // type:2 见知识文档；ensureServerResponse=false 由 net 封装固定（心跳会重发）
        var ret = await net.sendPBV2(CMD_GET_KUANG_LIST, { activityId: activity.id, type: 2 });

        // 请求失败：原样带上 8623 的 code 回传，data=null，供调用方进一步判断
        if (!ret.ok || !ret.data) {
            log.info('loading mines rejected (activity closed?). activityId=%d;code=%d', activity.id, ret.code);
            return net.Ret.from(ret.code, null);
        }

        /*
         * 只取可挖掘的矿洞：gatherStatus 0=可挖掘、1=挖掘中、2=已挖掘、3=行军中，只有 0 能派
         * x,y : 矿洞坐标
         * 黑名单里的矿（剩余时间不足以行军）一并跳过，不再白派 902
         */
        var list = ret.data.otherKuangList || [];

        pruneBlacklist(list);

        var mines = list
            .filter(function (mine) {
                return mine.gatherStatus === 0 && !blacklist.has(mineKey(mine.x, mine.y));
            })
            .map(function (mine) { return { x: mine.x, y: mine.y }; });

        // 带上 8623 的 code 一起回传
        return net.Ret.from(ret.code, mines);

    } catch (err) {
        log.warn('loading mines error. activityId=%d', activity && activity.id, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 按本次 8623 全量快照清理黑名单：已从名单消失（过期 / 被挖完）的矿解禁。
 * 必须用全量名单而不是 gatherStatus===0 的过滤结果——被拉黑的矿可能状态变了但仍在名单里，那不该解禁。
 * @param {object[]} list otherKuangList 原始数组
 */
function pruneBlacklist(list) {
    if (!blacklist.size) return;

    var present = new Set();
    for (var i = 0; i < list.length; i++) {
        present.add(mineKey(list[i].x, list[i].y));
    }

    blacklist.forEach(function (key) {
        if (present.has(key)) return;
        blacklist.delete(key);
        log.debug('blacklist pruned. key=%s', key);
    });
}


/**
 * 挖矿
 * 永不 reject：闸门未放开 / 发送异常都回落到 CODE_NOT_SENT 的哨兵 Ret，调度靠它排下一条，不回调就整链停摆
 * @param {object} mine 矿洞信息
 * @returns {Promise<Ret>} 整个 902 的 Ret，code=902 状态码，data=成功载荷或 null
 */
async function diggingDomainTreasureActivityMine(mine) {
    if (!mine || net.isSending(CMD_MARCH_WORLD_POINT)) {
        return net.Ret.from(CODE_NOT_SENT, null);
    }

    try {
        // 8 键载荷见知识文档；ensureServerResponse=false 由 net 封装固定（902 重发＝重复派遣白吃名额）
        var ret = await net.send(CMD_MARCH_WORLD_POINT, {
            marchType: MARCH_TYPE,
            x: mine.x,
            y: mine.y,
            armyList: [],
            armyListNew: [],
            heroList: [],
            trapList: [],
            ext: {}
        });

        // 被拒不在这里打日志：digFlow 是结果的单一出口（一次派遣只打一条，带 data 错误标识）
        return ret;

    } catch (err) {
        log.warn('digging error. x=%d;y=%d', mine.x, mine.y, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 活动行军名额是否还够派一条：上限 para6 > 我在途的领域寻宝行军数
 * 扫描前作闸门、消费段每条派前现判，直到 false（满员）或矿列表派空
 * @param {object} activity 活动信息
 * @returns {boolean}
 */
function isDomainTreasureActivityMarchEnough(activity) {
    var maxMarchNum = Number(activity && activity.para6) || 0;
    var marcheNum = Object.values(mapData.marches)
        .filter(function (march) {
            return march
                && march.marchType == MARCH_TYPE
                && march.realUid == dataCenter.UserData.UID;
        })
        .length;
    return marcheNum < maxMarchNum;
}

/**
 * 安装：取网络底座 + 活动控制器/地图数据/数据中心。任一依赖缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
    ctxRef = ctx;
    if (installed) {
        return true;
    }

    var missing = [];

    net = ctx.net;
    if (!net.install()) {
        missing.push('pocketcc.net');
        net = null;
    }

    var mods = game.requireAll(['ActivityController', 'NWorldMapData', 'DataCenter']);

    activityCtl = mods.ActivityController
        && mods.ActivityController.ActivityController
        && mods.ActivityController.ActivityController.Instance
        || missing.push('ActivityController');

    mapData = mods.NWorldMapData
        && mods.NWorldMapData.default
        && mods.NWorldMapData.default.instance
        || missing.push('NWorldMapData');

    dataCenter = mods.DataCenter
        && mods.DataCenter.DATA
        || missing.push('DataCenter');

    if (missing.length) {
        net = null; activityCtl = null; mapData = null; dataCenter = null;
        log.warn('install failed. missing=%d;deps=%s', missing.length, missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed.');

    return true;
}

/**
 * 运行：复位调度状态，挂 10912 监听，主动扫一次（之后由推送 / 兜底定时驱动）。
 * reactor pause 置 alive=false 后定时器自然停摆；resume 重新复位点火（scheduleScan 先 clearTimeout 单定时器，不会重复）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    consuming = false;
    scanning = false;
    scanPending = false;
    scanActivity = null;
    emptyStreak = 0;
    queue = [];
    // 黑名单也一并复位：换活动实例后老坐标可能与新矿重合；代价只是解禁后再被拒一次（902 被拒零成本）
    blacklist.clear();
    ctx.on.push(CMD_PUSH_ONE_ACTIVITY_EXTRA, onActivityExtraPush);
    log.info('started, listening push cmd=%d.', CMD_PUSH_ONE_ACTIVITY_EXTRA);
    // 启动即主动查一次；本轮结束后 afterConsume 会武装兜底定时
    triggerScan();
}

/**
 * 向 reactor 注册本功能说明书：scenes 限定 Home/NWorldMap，战斗模式暂停（offInCombat）。
 */
reactor.register({
    id: 'domainTreasure',
    label: '领域寻宝',
    storageKey: 'pocketcc.feat.domainTreasure',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    // 面板仅出启用开关；三个扫描/挖矿间隔均为上方 cfg 的内置常量，不作为可持久化配置项。
    defaults: { enabled: false },
    fields: [],
    toModuleCfg: function () { return {}; },
    install: install,
    run: run,
});
