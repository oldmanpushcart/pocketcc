/**
 * 芯片祝福-空投拾取功能（reactor 说明书形态）
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *
 * 事件驱动，无轮询：服务器推 10912（活动 extra 更新）→ 是芯片祝福且 extra.hasCanRevBag
 *   → 入队 → 串行消费：8852 查箱子坐标 → 902 派拾取行军。
 * 队列项仅作触发器：8852 载荷无 activityId（全局查询），多条推送=多轮"查箱+派"；
 *   若两条推送对应同一个箱，后一轮查询返回无箱自然跳过，幂等。
 * 与泰坦祝福的差异：10912 是 PUSH_ONE_ACTIVITYEXTRA，载荷只有 {aid, extra}，
 *   没有 type/showUiType，必须 aid 反查 ActivityController，故 install 多这一个依赖。
 * 队列 + 消费间隔：902 过快会被服务器限流（code=3, data="march_time_control_info001"），逐条之间休眠规避。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap。
 *   run 挂 10912 监听；reactor pause 时摘监听、置 alive=false，队列保留，恢复后续跑。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { createDrain } from '../../core/drain.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CHIP_BLESSING） */
const log = createLog('CHIP_BLESSING');

/** @type {number} ResponseId.PUSH_ONE_ACTIVITYEXTRA（ResponseId.js:229），活动 extra 更新推送，载荷 {aid, extra} */
const CMD_PUSH_ONE_ACTIVITY_EXTRA = 10912;

/** @type {number} NRequestIdV2.FLOAT_PARADE_QUERY_CAN_REWARD_BAG（NRequestIdV2.js:1033），载荷 {queryType:1, marchType:256}（NWorldUIActBtnSetting.js:71-80），应答 data={x,y} */
const CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG = 8852;

/** @type {number} RequestId.MARCH_WORLD_POINT（RequestId.js:188），载荷 {marchType:257, x, y}（录制"芯片祝福-领取宝箱-001"WorldItemDropPop 实测三键，无 armyList、非部队行军、无消耗） */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {string} GameDefine.ActivityShowUIType.CHIP_BLESSING（游戏同口径判定见 RealActivityController.js:2432；值已真机验证） */
const SHOW_UI_TYPE_CHIP_BLESSING = 'CHIP_BLESSING';

/** @type {number} NMarchType.CHIP_BLESSING_ITEM_DROP（NWorldMapMarchCommon.js:203），花车空投行军类型，8852 查询用（值已真机验证） */
const MARCH_TYPE_ITEM_DROP = 256;

/** @type {number} NMarchType.CHIP_BLESSING_GET_ITEM_DROP_REWARD（NWorldMapMarchCommon.js:204），拾取空投行军类型，902 派遣用（值已真机验证） */
const MARCH_TYPE_GET_ITEM_DROP_REWARD = 257;

/** @type {number} 非服务器返回的哨兵 code：发送异常时用，与真实 s 码区分开 */
const CODE_NOT_SENT = -1;

/** @type {number} 队列逐条消费之间的休眠毫秒（固定调优常量，不在面板暴露）：规避 902 限流（march_time_control_info001） */
const CONSUME_INTERVAL_MS = 1000;

/**
 * 模块内部配置：{ consumeInterval:number(ms) }。面板仅出启用开关，此值为内置常量。
 * @type {object}
 */
var cfg = { consumeInterval: CONSUME_INTERVAL_MS };

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} ActivityController 单例（aid 反查活动） */
var activityCtl;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {object[]} 待消费的 10912 push 事件队列（pause 保留、恢复续跑） */
var queue = [];

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（在飞流程的 await 回来后的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

/** @type {object} 串行消费器（队列逐条拾取 + 间隔休眠避限流） */
var drain = createDrain({
    log: log,
    queue: { get: function () { return queue; } },
    alive: aliveFn,
    process: pickUpFlow,
    interval: function () { return cfg.consumeInterval; },
});

/**
 * 注入模块配置（来自 toModuleCfg 的内置常量，非面板可调项）。只接受合法数值，运行中调用下一轮消费即生效
 * @param {object} partial {consumeInterval:number(ms)}
 * @returns {object} 当前 cfg
 */
function configure(partial) {
    if (partial && typeof partial.consumeInterval === 'number' && partial.consumeInterval >= 0) {
        cfg.consumeInterval = partial.consumeInterval;
    }
    return cfg;
}

/**
 * 10912 推送入口：同步过滤 + 入队，listener 本身永不 throw（net 封装也会兜，但不依赖它）。
 * 10912 任何活动的 extra 更新都会推它，故必先按 aid 反查出芯片祝福再判其余字段
 * @param {object} ev net.on 事件 {cmd, status, data, ord, ts, raw}
 */
function onActivityExtraPush(ev) {
    if (!aliveFn()) return;

    if (!isChipBlessingCanReceive(ev)) {
        return;
    }

    log.info('airdrop available push received, enqueue. aid=%d;pending=%d', ev.data.aid, queue.length + 1);
    queue.push(ev);
    // 触发消费；若已有循环在跑则立即返回，由该循环兜底取走新入队事件
    drain.consume().catch(function (err) {
        log.warn('consume loop threw!', err);
    });
}

/**
 * 推送是否是"芯片祝福且有可领取的空投箱"
 * @param {object} ev net.on 事件
 * @returns {boolean}
 */
function isChipBlessingCanReceive(ev) {
    var aid = ev && ev.data && ev.data.aid;
    if (!aid) return false;
    var activity = activityCtl.getActivityByActivityId(aid);
    if (!activity || activity.showUiType !== SHOW_UI_TYPE_CHIP_BLESSING) return false;
    return !!(ev.data.extra && ev.data.extra.hasCanRevBag);
}

/**
 * 单条拾取流程（drain 的 process）：查箱子坐标 → 派拾取行军。永不 reject
 * @returns {Promise<void>}
 */
async function pickUpFlow() {
    var pos = await queryBoxPosition();
    if (!aliveFn() || !pos) return;

    var ret = await marchPickUp(pos);
    if (!aliveFn()) return;
    if (ret.ok) {
        log.info('pick up march started. x=%d;y=%d;code=%d', pos.x, pos.y, ret.code);
    } else {
        log.warn('pick up march rejected! x=%d;y=%d;code=%d', pos.x, pos.y, ret.code);
    }
}

/**
 * 查可领取的空投箱坐标（游戏世界按钮同款请求，NWorldUIActBtnSetting.js:71-94）。
 * 永不 reject：发送异常 / 无箱子都返回 null。
 * 无箱子的两种服务器口径（录制已见）：s!=0 被拒（样本 s=3, data="marble_lottery_037"），或 s=0 但 data={x:0,y:0}
 * @returns {Promise<object|null>} {x,y} 或 null
 */
async function queryBoxPosition() {
    try {
        var ret = await net.sendPBV2(CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG, {
            queryType: 1,
            marchType: MARCH_TYPE_ITEM_DROP
        });
        var pos = ret.data;
        if (!ret.ok || !pos || (pos.x === 0 && pos.y === 0)) {
            log.debug('no box to receive. code=%d', ret.code);
            return null;
        }
        log.info('box found. x=%d;y=%d', pos.x, pos.y);
        return pos;
    } catch (err) {
        log.warn('query box error!', err);
        return null;
    }
}

/**
 * 派拾取行军。永不 reject：发送异常回落到 CODE_NOT_SENT 的哨兵 Ret
 * @param {object} pos 箱子坐标 {x,y}
 * @returns {Promise<Ret>} code=902 状态码
 */
async function marchPickUp(pos) {
    try {
        var ret = await net.send(CMD_MARCH_WORLD_POINT, {
            marchType: MARCH_TYPE_GET_ITEM_DROP_REWARD,
            x: pos.x,
            y: pos.y
        });
        return ret;
    } catch (err) {
        log.warn('march error! x=%d;y=%d', pos.x, pos.y, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 安装：取网络底座 + 反查活动控制器。任一依赖缺失即失败（reactor 不会激活）。
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

    var mods = game.requireAll(['ActivityController']);

    activityCtl = mods.ActivityController
        && mods.ActivityController.ActivityController
        && mods.ActivityController.ActivityController.Instance
        || missing.push('ActivityController');

    if (missing.length) {
        net = null; activityCtl = null;
        log.warn('install failed. missing=%d;deps=%s', missing.length, missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed.');

    return true;
}

/**
 * 运行：挂 10912 监听。不补查历史推送——装上之前的箱子等下一条推送或手动点游戏按钮。
 * reactor pause 会自动摘除此处登记的触发器。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    ctx.on.push(CMD_PUSH_ONE_ACTIVITY_EXTRA, onActivityExtraPush);
    log.info('started, listening push cmd=%d.', CMD_PUSH_ONE_ACTIVITY_EXTRA);
}

/**
 * 向 reactor 注册本功能说明书：scenes 限定 Home/NWorldMap，战斗模式暂停（offInCombat）。
 */
reactor.register({
    id: 'chipBlessing',
    label: '芯片祝福',
    storageKey: 'pocketcc.feat.chipBlessing',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: { enabled: false },
    fields: [],
    // 消费间隔不在面板配置，固定回内置常量（秒→毫秒换算已无面板输入，直接给 ms）
    toModuleCfg: function () { return { consumeInterval: CONSUME_INTERVAL_MS }; },
    install: install,
    configure: configure,
    run: run,
});
