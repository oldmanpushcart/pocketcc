/**
 * 泰坦祝福（泰坦藏宝图）-空投拾取功能（reactor 说明书形态）
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *
 * 事件驱动，无轮询：服务器推 10904（PUSH_ONE_ACTIVITY 整条活动）→ 是泰坦祝福且 extra.hasRed
 *   → 入队 → 串行消费：9595 查箱子坐标 → 902 派拾取行军。
 * 领一个箱子后服务器会再推一条 10904（hasRed 翻 false 表示领完，见 泰坦藏宝图资料整理.md「领取前/后的回复」），
 *   靠这条再推驱动下一轮，跳过一轮不丢事件。
 * 额度上限：extra.totalNum=本期已领、extra.left=本期剩余可领（两者之和=本期总量）；left<=0 即本期触顶，打日志跳过但保留监听，等下一轮活动 left 回升后继续。
 * 与芯片祝福不同：本功能只用 push 载荷自带的 type/extra/id 判定，无需 ActivityController，故 install 只依赖 net。
 * 队列 + 消费间隔：902 过快会被服务器限流（code=3, data="march_time_control_info001"），逐条之间休眠规避。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap。
 *   run 挂 10904 监听；reactor pause 时摘监听、置 alive=false，队列保留，恢复后续跑。
 */
import { createLog } from '../../core/log.js';
import { createDrain } from '../../core/drain.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=TITAN_BLESSING） */
const log = createLog('TITAN_BLESSING');

/** @type {number} ResponseId.PUSH_ONE_ACTIVITY（ResponseId.js:158），整条活动推送，载荷含 type/extra/id */
const CMD_PUSH_ONE_ACTIVITY = 10904;

/** @type {number} NRequestIdV2.HERO_EQUIP_WISH_FIND_BOX（NRequestIdV2.js:1374），载荷 {activityId}，应答 data={serverId,x,y}（值已真机验证） */
const CMD_HERO_EQUIP_WISH_FIND_BOX = 9595;

/** @type {number} RequestId.MARCH_WORLD_POINT（RequestId.js:188），载荷 {marchType,x,y,...}，派拾取行军（值已真机验证） */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {number} 泰坦祝福活动 type；同一 push 载荷 showUiType="ActivityTitanBlessing"（见 泰坦藏宝图资料整理.md），无独立枚举，值已真机验证 */
const ACTIVITY_TYPE_TITAN_BLESSING = 271;

/** @type {number} NMarchType.Titan_Blessing_Gift（NWorldMapMarchCommon.js:141），泰坦祝福拾取行军类型，902 派遣用（值已真机验证） */
const MARCH_TYPE_TITAN_BLESSING_GIFT = 143;

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

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {object[]} 待消费的 10904 push 事件队列（pause 保留、恢复续跑） */
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
 * 10904 推送入口：同步过滤 + 入队，listener 本身永不 throw（net 封装也会兜，但不依赖它）。
 * 注意 10904 是 PUSH_ONE_ACTIVITY，任何活动都会推它，故必先按 type 认出泰坦祝福再判其余字段。
 * 三分支：非泰坦祝福→静默忽略；extra.left<=0（本期额度触顶）→打一行日志跳过（监听保留，等下一轮）；无 hasRed→跳过本轮。
 * @param {object} ev net.on 事件 {cmd, status, data, ord, ts, raw}
 */
function onActivityPush(ev) {
    if (!aliveFn()) return;

    var data = ev && ev.data;
    if (!data || data.type !== ACTIVITY_TYPE_TITAN_BLESSING) return;

    var extra = data.extra || {};

    // 本期领取额度耗尽（totalNum 已领 + left 剩余 = 本期总量）：触顶，本轮跳过。
    // 不停监听——本期结束后活动会开下一轮，届时 left 回升、hasRed 转真，仍由本监听接管
    if (extra.left <= 0) {
        log.info('period claim limit reached, skip. left=%s;totalNum=%s', extra.left, extra.totalNum);
        return;
    }

    // hasRed == false，表示这是一条领取完成的通知，可以忽略。
    if (!extra.hasRed) {
        return;
    }

    log.info('airdrop available push received, enqueue. id=%d;left=%d;pending=%d', data.id, extra.left, queue.length + 1);
    queue.push(ev);
    // 触发消费；若已有循环在跑则立即返回，由该循环兜底取走新入队事件
    drain.consume().catch(function (err) {
        log.warn('consume loop threw!', err);
    });
}

/**
 * 单条拾取流程（drain 的 process）：查箱子坐标 → 派拾取行军。永不 reject
 * @param {object} ev 入队的 10904 push 事件
 * @returns {Promise<void>}
 */
async function pickUpFlow(ev) {
    var pos = await queryBoxPosition(ev.data.id);
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
 * 查可领取的空投箱坐标（游戏 onClickTitanBlessing 同款请求，见 泰坦藏宝图资料整理.md）。
 * 永不 reject：发送异常 / 无箱子都返回 null。
 * 无箱子口径：s!=0，或 s=0 但 data={x:0,y:0}
 * @param {number} activityId push 载荷里的活动 id
 * @returns {Promise<object|null>} {x,y} 或 null
 */
async function queryBoxPosition(activityId) {
    try {
        var ret = await net.sendPBV2(CMD_HERO_EQUIP_WISH_FIND_BOX, { activityId: activityId });
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
            marchType: MARCH_TYPE_TITAN_BLESSING_GIFT,
            x: pos.x,
            y: pos.y,
            armyList: [],
            armyListNew: [],
            heroList: [],
            trapList: [],
            ext: {}
        });
        return ret;
    } catch (err) {
        log.warn('march error! x=%d;y=%d', pos.x, pos.y, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 安装：只依赖 promise 封装 pocketcc.net（send/sendPBV2/Ret 缺一即不合格）
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

    if (missing.length) {
        net = null;
        log.warn('install failed. missing=%d;deps=%s', missing.length, missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed.');

    return true;
}

/**
 * 运行：挂 10904 监听。不补查历史推送——装上之前的箱子等下一条推送或手动点游戏按钮。
 * reactor pause 会自动摘除此处登记的触发器。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    ctx.on.push(CMD_PUSH_ONE_ACTIVITY, onActivityPush);
    log.info('started, listening push cmd=%d.', CMD_PUSH_ONE_ACTIVITY);
}

/**
 * 向 reactor 注册本功能说明书：scenes 限定 Home/NWorldMap，战斗模式暂停（offInCombat）。
 */
reactor.register({
    id: 'titanBlessing',
    label: '泰坦祝福',
    storageKey: 'pocketcc.feat.titanBlessing',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: { enabled: false },
    fields: [],
    // 消费间隔不在面板配置，固定回内置常量
    toModuleCfg: function () { return { consumeInterval: CONSUME_INTERVAL_MS }; },
    install: install,
    configure: configure,
    run: run,
});
