/**
 * 海上夺宝-自动攻打世界机甲（reactor 说明书形态）
 *
 * 海上夺宝即"打航母"活动（ActivityShowUIType.FightAircraftCarrier），世界地图上刷出可攻打的 boss，
 * 每条 boss 有独立坐标与"我剩余攻打次数"（myLeftAttackTimes）。脚本自动找到并派兵攻打。
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *
 * 三条协议（见 references/海上夺宝.md）：
 *   1) push 10912（PUSH_ONE_ACTIVITYEXTRA，载荷 {aid,extra}）：活动 extra 更新（新 boss 刷出等）→ aid 反查是海上夺宝 → 触发扫描；
 *   2) req sendPBV2 3756（SEIZE_SEA_TREASURE_QUERY_WORLD_BOSS）{activityId} → resp {bossInfos:[{bossId,pointX,pointY,endTime,myLeftAttackTimes,...}]}；
 *   3) req send 902（MARCH_WORLD_POINT）{marchType:178, x, y} → 攻打该坐标 boss。与领域夺宝挖矿同为"零部队三键"派遣，不带 armyList/heroList。
 *
 * 生产端三个触发源（同领域夺宝口径）：
 *   1) 推送 10912；2) run() 启动即主动扫一次；3) 兜底定时（active/idle 两档，连续空扫降频）防漏推。
 *   触发汇入 triggerScan：扫描/消费在飞时只置 scanPending，本轮结束后补扫一次（多条推送合并成一次）。
 *   生产 doScan：找活动 → 拉 3756 → 过滤可攻打 boss（myLeftAttackTimes>0 且未过期）→ 整批替换 queue → 交消费。
 *   消费 consume：consuming 闸门保证单循环，逐条 shift → attackFlow 派 902 → 每条间 sleep(marchInterval)；排空后 afterConsume 重排。
 *   出击前闸门 hasMarchAtTarget：同一目标（x,y）同一时间只能有一个在途行军，故派 902 前查我的行军列表，
 *     目标坐标已被一条 marchType=178 行军占用时，即便 myLeftAttackTimes 仍有数值也本轮先放过，等这条行军结束再由下轮补打。
 *   零部队行军不占用全局行军队列上限，故无名额闸门（不引入 canMarch）；仅逐条间限流防 902 被服务器限流。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap。
 *   consume 有"scanPending 补扫 + afterConsume 重排"的独有逻辑，不套 createDrain，原样保留在本文件。
 *   兜底定时器是功能内部生产逻辑，pause 后 alive()=false 自然停摆，resume 时 run 复位状态并重新点火。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SEA-TREASURE） */
const log = createLog('SEA-TREASURE');

/** @type {number} ResponseId.PUSH_ONE_ACTIVITYEXTRA，活动 extra 更新推送，载荷 {aid, extra}；新 boss 刷出等会推它 */
const CMD_PUSH_ONE_ACTIVITY_EXTRA = 10912;

/** @type {number} NRequestIdV2.SEIZE_SEA_TREASURE_QUERY_WORLD_BOSS，查询当前可攻打的世界 boss，req {activityId} → resp {bossInfos} */
const CMD_QUERY_WORLD_BOSS = 3756;

/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；攻打 boss 用 marchType=178 */
const CMD_MARCH_WORLD_POINT = 902;

/**
 * 海上夺宝活动 showUiType（来源：NWorldUIActBtnSetting.js:309 世界按钮 ActivityShowUIType.FightAircraftCarrier；
 * 与本仓 CHIP_BLESSING 同口径——枚举值等于键名字符串）
 * @type {string}
 */
const SHOW_UI_TYPE_SEA_TREASURE = 'FightAircraftCarrier';

/**
 * 行军类型：攻打海上夺宝世界 boss（航母）
 * 定义：NWorldMapMarchCommon.NMarchType.FIGHT_ARICRAFT_CARRIER = 178
 * @type {number}
 */
const MARCH_TYPE = 178;

/**
 * 非服务器返回的哨兵 code：闸门未放开 / 发送异常时用，与真实 s 码区分开
 * @type {number}
 */
const CODE_NOT_SENT = -1;

/**
 * 内置调优常量（面板仅出启用开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {

    /**
     * 活跃扫描间隔：默认1分钟。本轮扫描发现可攻打 boss 时用这档，勤扫趁名额还空多打
     */
    activeScanInterval: 1000 * 60,

    /**
     * 空转扫描间隔：默认10分钟。连续 EMPTY_STREAK_IDLE 次扫描都没 boss 后降到这档，少刷 3756。
     * 推送 10912 仍是主触发源，新 boss 一刷出即被推醒，不必等这档定时
     */
    idleScanInterval: 1000 * 60 * 10,

    /**
     * 攻打间隔：默认5秒（消费逐条之间的休眠）。902 过快会被服务器限流，逐条之间休眠规避
     */
    marchInterval: 1000 * 5,

};

/** @type {number} 连续这么多次扫描都没 boss，才把扫描间隔从 active 降到 idle（去抖：单次漏扫不立即降频） */
const EMPTY_STREAK_IDLE = 2;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} 活动控制器（aid 反查活动、活动列表/开启判定） */
var activityCtl;
/** @type {object|null} 世界地图数据（读我的在途行军列表 marches） */
var mapData;
/** @type {object|null} 数据中心（取本机 UID 过滤我的行军） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞流程自然退出 */
var ctxRef = null;

/** @type {object[]} 本轮扫描过滤出的可攻打 boss（[{x,y,bossId,left}]），consume 逐条 shift */
var queue = [];
/** @type {boolean} 消费闸门：同时只有一个 consume 循环 */
var consuming = false;
/** @type {boolean} 生产闸门：同时只有一个 doScan 在飞（含 3756 await） */
var scanning = false;
/** @type {boolean} 扫描/消费在飞时来了新触发（推送/run），置位；本轮结束后补扫一次 */
var scanPending = false;
/** @type {number|null} 兜底定时器；pause 后到点空转不再自重排 */
var scanTimer = null;
/** @type {number} 连续空扫计数：发现 boss 即清零，达到 EMPTY_STREAK_IDLE 转 idle 间隔 */
var emptyStreak = 0;

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
 * 生产端：找活动 → 拉 3756 → 过滤可攻打 boss → 整批替换 queue → 交消费。永不 reject。
 * @returns {Promise<void>}
 */
async function doScan() {
    scanning = true;
    try {
        // 活动并未开启：清空队列，交 afterConsume 排兜底。算一次空扫（没 boss 可检测）
        var activity = getSeaTreasureActivity();
        if (!activity) {
            log.debug('no activity found.');
            queue.length = 0;
            emptyStreak++;
            return;
        }

        // loading 返回 Ret：code=3756 状态码，data=过滤后的可攻打 boss（失败/闸门时为 null）
        var ret = await loadingBosses(activity);
        if (!aliveFn()) return;

        if (!ret.ok || !ret.data || !ret.data.length) {
            log.debug('no boss found. code=%d', ret.code);
            queue.length = 0;
            emptyStreak++;
            return;
        }

        // 每轮 3756 是全量快照，整批替换队列（追加会累积重复 boss）
        queue = ret.data;
        emptyStreak = 0;
        log.debug('bosses loaded. count=%d', queue.length);
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
 * 消费端：串行消费队列，consuming 闸门防重入；每条之间休眠 marchInterval（队列空则不空等）。永不 reject。
 * @returns {Promise<void>}
 */
async function consume() {
    if (consuming) return;
    consuming = true;
    try {
        while (queue.length && aliveFn()) {
            var boss = queue.shift();
            try {
                await attackFlow(boss);
            } catch (err) {
                log.warn('attack flow threw.', err);
            }
            if (queue.length && aliveFn()) {
                await sleep(cfg.marchInterval);
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
 * 发现 boss 会把 emptyStreak 清零（doScan），从而回到 active 档
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
 * 10912 推送入口：aid 反查是海上夺宝、且 extra.worldUIRed >= 1（确认有 boss 可打）才触发扫描，listener 本身永不 throw。
 * 10912 任何活动的 extra 更新都会推它，故必先按 aid 认出海上夺宝
 * @param {object} ev net.on 事件 {cmd, status, data, ord, ts, raw}
 */
function onActivityExtraPush(ev) {
    if (!aliveFn()) return;

    var aid = ev && ev.data && ev.data.aid;
    if (!isSeaTreasureAid(aid)) {
        return;
    }

    // 如果有BOSS，extra.worldUIRed 大于等于1，这样判断能过滤掉一些脏数据（推送载荷里 extra 挂在 ev.data.extra 下）
    var extra = ev.data && ev.data.extra;
    var hasBoss = extra && extra.worldUIRed && extra.worldUIRed >= 1;
    if(!hasBoss) {
        return;
    }

    log.info('activity extra push received, trigger scan. aid=%d', aid);
    triggerScan();
}

/**
 * aid 是否指向一个海上夺宝活动
 * @param {number} aid 推送载荷里的活动 id
 * @returns {boolean}
 */
function isSeaTreasureAid(aid) {
    if (!aid) return false;
    var activity = activityCtl.getActivityByActivityId(aid);
    return !!activity && activity.showUiType === SHOW_UI_TYPE_SEA_TREASURE;
}

/**
 * 单条攻打流程：检查目标是否已有在途行军 → 有则跳过 → 无则派 902 → 打一条结果日志。永不 reject。
 * 与领域夺宝挖矿同为“零部队三键”派遣（{marchType,x,y}），不带 armyList/heroList，无出征消耗。
 * 日志单一出口在这里：一次攻打只打一条（成功 info、被拒 warn、已有行军 debug）。
 * @param {object} boss boss 信息 {x,y,bossId,left}
 * @returns {Promise<void>}
 */
async function attackFlow(boss) {
    // 同一目标同一时间只能有一个行军，已在途中则跳过
    if (hasMarchAtTarget(boss.x, boss.y)) {
        log.debug('target already has march in flight, skip. bossId=%d;x=%d;y=%d', boss.bossId, boss.x, boss.y);
        return;
    }

    var ret = await marchAttack(boss);
    if (!aliveFn()) return;

    if (ret.ok) {
        log.info('attack march started. bossId=%d;x=%d;y=%d', boss.bossId, boss.x, boss.y);
        return;
    }

    log.info('attack march rejected. bossId=%d;x=%d;y=%d;code=%d;data=%s',
        boss.bossId, boss.x, boss.y, ret.code, ret.data);
}

/**
 * 检查目标坐标 (x,y) 是否已被我的行军占用（同 marchType=178 且 target_tx/target_ty 匹配）。
 * 口径同领域夺宝挖矿：遍历 mapData.marches，按 realUid + marchType + target_tx/target_ty 判定。
 * @param {number} x 目标 pointX
 * @param {number} y 目标 pointY
 * @returns {boolean}
 */
function hasMarchAtTarget(x, y) {
    var uid = dataCenter.UserData && dataCenter.UserData.UID;
    if (!uid) return false;
    var marches = mapData.marches;
    if (!marches) return false;
    return Object.values(marches).some(function (march) {
        return march
            && march.realUid == uid
            && march.marchType == MARCH_TYPE
            && march.target_tx == x
            && march.target_ty == y;
    });
}

/**
 * 获取海上夺宝活动信息（要求仍在开启期——对已结束的活动发 3756/902 只会被拒）
 * @returns {object|undefined}
 */
function getSeaTreasureActivity() {
    return activityCtl.getActivityList()
        .find(function (activity) {
            return activity.showUiType === SHOW_UI_TYPE_SEA_TREASURE
                && activityCtl.checkActivityIsOpen(activity.id) === true;
        });
}

/**
 * 查询可攻打的世界 boss 列表
 * 永不 reject：闸门未放开 / 发送异常都回落到 CODE_NOT_SENT 的哨兵 Ret，调度据此按"这一跳没数据"处理
 * @param {object} activity 活动信息
 * @returns {Promise<Ret>} code=3756 状态码，data=过滤后的可攻打 boss 数组（[{x,y,bossId,left}]）或 null
 */
async function loadingBosses(activity) {
    // 闸门未放开（游戏面板也在拉）：不静默断链，回哨兵 Ret
    if (!activity || net.isSending(CMD_QUERY_WORLD_BOSS)) {
        return net.Ret.from(CODE_NOT_SENT, null);
    }

    try {
        var ret = await net.sendPBV2(CMD_QUERY_WORLD_BOSS, { activityId: activity.id });

        // 请求失败：原样带上 3756 的 code 回传，data=null，供调用方进一步判断
        if (!ret.ok || !ret.data) {
            log.info('loading bosses rejected (activity closed?). activityId=%d;code=%d', activity.id, ret.code);
            return net.Ret.from(ret.code, null);
        }

        /*
         * bossInfos 每条：{bossId, pointX, pointY, endTime, myLeftAttackTimes, attackNum, ownerUidStr, serverId, uuidStr, ...}
         * 只取我还能打、且尚未到期的 boss：myLeftAttackTimes>0 且 endTime（秒）> 当前服务器/本地时间
         */
        var nowSec = Date.now() / 1000;
        var list = ret.data.bossInfos || [];
        var bosses = list
            .filter(function (b) {
                return b && (b.myLeftAttackTimes | 0) > 0 && (!b.endTime || b.endTime > nowSec);
            })
            .map(function (b) {
                return { x: b.pointX, y: b.pointY, bossId: b.bossId, left: b.myLeftAttackTimes | 0 };
            });

        return net.Ret.from(ret.code, bosses);
    } catch (err) {
        log.warn('loading bosses error. activityId=%d', activity && activity.id, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 派兵攻打 boss（902 行军）。永不 reject：闸门未放开 / 发送异常都回落到 CODE_NOT_SENT 的哨兵 Ret
 * 零部队三键载荷（见 references/海上夺宝.md），与领域夺宝挖矿同口径，不带 armyList/heroList。
 * @param {object} boss boss 信息 {x,y,bossId}
 * @returns {Promise<Ret>} 整个 902 的 Ret，code=902 状态码，data=成功载荷或 null
 */
async function marchAttack(boss) {
    if (!boss || net.isSending(CMD_MARCH_WORLD_POINT)) {
        return net.Ret.from(CODE_NOT_SENT, null);
    }

    try {
        var ret = await net.send(CMD_MARCH_WORLD_POINT, {
            marchType: MARCH_TYPE,
            x: boss.x,
            y: boss.y,
        });

        // 被拒不在这里打日志：attackFlow 是结果的单一出口（一次攻打只打一条，带 data 错误标识）
        return ret;
    } catch (err) {
        log.warn('march attack error. x=%d;y=%d', boss.x, boss.y, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 安装：取网络底座 + 活动控制器 + 地图数据 + 数据中心。任一依赖缺失即失败（reactor 不会激活）。
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
    emptyStreak = 0;
    queue = [];
    ctx.on.push(CMD_PUSH_ONE_ACTIVITY_EXTRA, onActivityExtraPush);
    log.info('started, listening push cmd=%d.', CMD_PUSH_ONE_ACTIVITY_EXTRA);
    // 启动即主动查一次；本轮结束后 afterConsume 会武装兜底定时
    triggerScan();
}

/**
 * 向 reactor 注册本功能说明书：场景限定 Home/NWorldMap，战斗模式强制下线；
 * 面板仅出启用开关，三个间隔均为 cfg 内置常量
 */
reactor.register({
    id: 'seaTreasure',
    label: '海上夺宝',
    storageKey: 'pocketcc.feat.seaTreasure',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    // 面板仅出启用开关；三个扫描/攻打间隔均为 cfg 内置常量，不作为可持久化配置项。
    defaults: { enabled: false },
    fields: [],
    toModuleCfg: function () { return {}; },
    install: install,
    run: run,
});
