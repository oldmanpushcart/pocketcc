/**
 * 花车空投-按车定向探测领取（reactor 说明书形态）
 *
 * 覆盖"花车行军投放空投箱"这一类玩法（芯片祝福 256/257 起步，配置表可扩到其他花车活动）。
 * 与 chip-blessing.js 的差异：那个是"活动推送 10912 叫醒 → 全局 8852 拿任意一个可领箱"，
 * 本 feat 是"联盟聊天发车卡叫醒 → 按该台花车的 marchIdStr 定向 8852 逐拍探测"，一台车一条流程。
 *
 * 玩法节奏（现场核对）：**每 30 秒投一箱**，首箱不特殊（它就是这个 30 秒节拍的第一格，发车后 30 秒落地）；
 * 一台车可投多箱，但**只发一条**聊天卡；卡片 `expirationTime - t` = 箱数 × 180 秒（即该车窗口长度）。
 * 箱落在地图上活 1830 秒（瓦片 startSecsTime→endSecsTime 实测），所以逼我们快的是"共享次数被抢"，不是过期。
 *
 * 流程状态机（一 push 一流程，流程间互不干扰——8852 带 marchIdStr 定向，数据也独立）：
 *   发车卡到达 → 定锚 S（把服务器发车秒 t 折算成本地时刻，用 ServerTime 补推送延迟）与硬止 E（窗口长度）
 *   → 第 k 箱的落地时刻 = S + F + P·(k−1)（P=30s 箱间隔；F=30s 首箱延迟，现与 P 同值）
 *   → 第 k 拍的探测窗口 = 落地时刻前 L(=2s) 开探，带宽 Y(=10s)，即 [S + F + P·(k−1) − L, 起点 + Y]
 *   → 窗口内每 1s 发一次 8852；命中新箱立即入队派 902 并收拍，本拍记"有收获"；
 *   → 拍结算：无收获且没被"已派箱遮蔽" → missStreak++（被遮蔽时中性，见 probe 注释）；
 *   → missStreak ≥ 阈值 或 now ≥ E → 流程出队。停止判据用的是服务器"真·空"语义：
 *     阈值默认 M(=3)，但已派出的唯一箱数达到卡片推算值 N=(exp−t)/180 后降为 1（真空一拍即收摊）；
 *     没领满 N 时阈值不变，所以"漏领一箱"仍享有 M 拍保守容错——N 只做快车道，不做硬终止。
 *
 * 时间环：不为每条流程各挂 setTimeout 链，而是**一个 1s 全局 driver 扫 flows 表**（单层、步长 1s 的退化时间轮）。
 *   收益：只有一处定时器（pause/flows 空即停）、后台节流时所有流程一起延后而不是各自错乱、
 *   "每 1s 重试"就是 driver 的 tick 本身、flows 为空时零开销。
 *
 * 幂等（无需自建 TTL 记账）：
 *   1) 流程内已派坐标集合 `dispatched`——行军在路上时 8852 仍会返回同一箱，不去重就会 1s 一次连环重复派；
 *      902 被服务器拒时把坐标退回集合，留给后续拍重试。
 *   2) `mapData.marches` 在途行军判重（同坐标 + realUid==我 + marchType==getType）。
 *      ⚠️ 只瞬时让路、不把坐标写进 dispatched：一格同时只有一物但坐标会被后续箱复用（前一箱被领满
 *      20 次会提前消失），而定向 8852 回了这个坐标就说明此刻这格的箱属于本流程。
 *      ⚠️ marches 是 `new Map`，Object.values() 对 Map 返回空数组，必须走 marches.values()。
 *   3) 队列内同坐标去重 + drain 条间 1s 休眠避 902 限流（march_time_control_info001）。
 *   257 是无 armyList 的非部队行军、不占全局行军位，故不引入 canMarch 名额闸。
 *
 * ⚠️ marchId 是 64 位雪花 id（真机样本 4857138598478209026 > 2^53），任何 Number() 转换都会静默丢精度、
 *   把查询打到别的行军上——全链路只以 string 传递（8852 请求体的字段名本身就是 marchIdStr）。
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 * 8852 应答：net 封装已剥到内层，ret.data 就是 {x,y}；"无箱"有两种服务器口径（s!=0 被拒 / s=0 但 {x:0,y:0}）。
 *
 * 生命周期由 reactor 托管：install/run 两个钩子（无可调面板项，故不写 configure），scenes 门控限定 Home/NWorldMap。
 *   run 挂 newChatPush 监听；pause 摘监听、alive()=false 让 driver 与在飞流程自然收手，flows 表保留，resume 续跑。
 * 类型级当日熔断：某类花车的 902 回 `mysterioustriangle_10`（今日剩余次数不足）即记该类“今日已满”，
 *   当场收掉同类型全部流程 + 滤掉同类型待派项，后续该类型的发车卡不再建流程（跨类型互不影响，跨日自动失效）。
 * 被拒退避：同一坐标被 902 拒后按指数退避再试（上限键走熔断、不走到这里），否则会被拒的坐标每秒重派一遍。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { createDrain } from '../../core/drain.js';
import { reactor } from '../../core/reactor.js';
import { l10n } from '../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=FLOAT_CAR） */
const log = createLog('FLOAT_CAR');

/** @type {number} NRequestIdV2.FLOAT_PARADE_QUERY_CAN_REWARD_BAG，req {queryType:1, marchType:dropType[, marchIdStr]} → resp data={x,y} */
const CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG = 8852;

/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军，拾取空投用 {marchType:getType, x, y} 三键（无 armyList） */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {number} ChatShareLinkType.PARADE_FLOAT_MARCH_SHARE，花车行军分享卡（llm.t），卡片只带 marchId + expirationTime，不带坐标 */
const SHARE_LINK_PARADE_FLOAT_MARCH = 38;

/** @type {number} 非服务器返回的哨兵 code：发送异常时用，与真实 s 码区分开 */
const CODE_NOT_SENT = -1;

/** @type {number} 每箱摊到的窗口秒数：真机三点吻合（1 箱=180s / 2 箱=360s / 8 箱=1440s） */
const BOX_WINDOW_SEC = 180;

/** @type {number} 卡片没给 expirationTime（或没给 t）时的兜底窗口长度：180 秒 = 单箱车 */
const DEFAULT_LIFE_MS = 1000 * BOX_WINDOW_SEC;

/**
 * 902 拒绝载荷里“该花车类型今日领取次数已用完”的文案键（字典表：mysterioustriangle_10=今日剩余次数不足）。
 * ⚠️ 这一族键是服务端**跨活动复用**的（同族 _01 属“神秘三角”抽奖），所以：
 * ① 只认这个精确键，其它拒绝（目标被占 / 发得太密）一律不当作上限；
 * ② 只认它出现在**本类型自己那支拾取行军的 902** 上——发车、空查、收摊都不构成上限证据
 * （每箱只有 20 次、先到先得，抢不过别人时也是 0 收获，但那不是上限）
 */
const ERR_FLOAT_DAILY_LIMIT = 'mysterioustriangle_10';

/**
 * 花车活动配置表：DROP（投放/查询用）与 GET（派遣用）是**配对关系**，必须成对写死。
 * 源码里三组恰好都是 +1（256/257 芯片祝福、285/286 圣诞弹珠、287/288 新年弹珠），
 * 但那是命名约定不是推导依据，禁止写成 dropType + 1。
 * @type {object[]}
 */
const FLOATS = [
    { id: 'CHIP_BLESSING', label: '芯片祝福', dropType: 256, getType: 257 },
    { id: 'NEWYEAR2026_PINBALL', label: '2026新年弹珠', dropType: 287, getType: 288 },
];

/** @type {Object<number,object>} dropType → 配置项；聊天卡 extra.marchType 与 8852 请求都只认 DROP 值，故以它建索引 */
const FLOAT_BY_DROP = {};
for (var i = 0; i < FLOATS.length; i++) FLOAT_BY_DROP[FLOATS[i].dropType] = FLOATS[i];

/**
 * 内置调优常量（面板只出启用开关，不暴露这些）
 * @type {object}
 */
const cfg = {

    /**
     * F 首箱延迟：收到发车卡（= 瓦片 startSecsTime = 服务器 t）之后 30 秒才投第一箱
     */
    firstBoxDelayMs: 1000 * 30,

    /**
     * L 提前开探量：相对每箱落地时刻提前多久开始问（吸收服务器与客户端的时间抖动）
     */
    probeLeadMs: 1000 * 2,

    /**
     * Y 容差带：一拍窗口内允许向后探多久，期间每 retryMs 查一次（吸收服务器与客户端的时间抖动）
     */
    probeBandMs: 1000 * 10,

    /**
     * 拍内重试间隔
     */
    retryMs: 1000,

    /**
     * P 箱间隔：相邻两箱的投放间隔 30 秒（首箱也走这同一节拍，所以 F 与 P 当前同值）
     */
    boxPeriodMs: 1000 * 30,

    /**
     * M 停止阈值：连续这么多拍"真·空"（既没新箱也没被已派箱遮蔽）就判定这台车没有我能领的箱了。
     * 取 3 不取 1：拍窗口是刚性网格，服务器某箱晚落几秒就会错过一拍，M≥2 才有容错；
     * 代价是尾部空转 M×P 的墙钟（当前 90 秒），但查询次数不随 P 变大（每空拍固定 Y/1s+1 次）；
     * 已派箱数达到卡片推算值后本阈值自动降为 1（见 stopThreshold），8 箱车实测可省掉尾部 3 拍里的 2 拍
     */
    emptyPeriodStop: 3,

    /**
     * driver 步长：一个全局定时器扫全部流程，"每 1 秒重试"就是这一拍
     */
    tickMs: 1000,

    /**
     * 队列逐条消费之间的休眠毫秒：规避 902 限流（march_time_control_info001）
     */
    consumeInterval: 1000,

    /**
     * 同一坐标被拒后的重试退避基数：第 n 次被拒后等 base × 2^(n-1)（封顶 rejectBackoffMaxMs）再派。
     * 没退避时回放实测：一个整窗不消失的拒绝会让同一坐标撞 151 次 902；而限流类拒绝（march_time_control_info001=操作太频繁）
     * 最怕的正是打得更密。退避到封顶后每 60 秒试一次，既不给服务器加压也不会错过恢复时机
     */
    rejectBackoffBaseMs: 1000 * 5,

    /**
     * 重试退避封顶
     */
    rejectBackoffMaxMs: 1000 * 60,

};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} 世界地图数据（读我的在途行军列表 marches，是 Map） */
var mapData;
/** @type {object|null} 数据中心（DATA.ServerTime 秒 + UserData.UID） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让 driver 与在飞流程自然退出 */
var ctxRef = null;

/** @type {Map<string,object>} 活跃探测流程：marchIdStr → flow */
var flows = new Map();

/** @type {Set<string>} 已见过的 8852 "无箱"文案键（全局而非每流程：每拍首查必空，按车去重会把 info 刷成 debug 的量） */
var seenEmptyKeys = new Set();

/**
 * @type {Map<string,string>} floatId → 被服务器判为“今日已满”的日期。
 * 上限是**按花车类型各自计**的（现每类 10 次），跨类型不共用，故按类型记账。
 * 故意不落盘（口径同 alliance-help）：刷新页面后同类型第一台车会再撞一次（约 12 次查询 + 1 支必被拒的行军），
 * 换来的是“绝不因为一条脏记录整天停摆”
 */
var capReachedOn = new Map();

/** @type {object[]} 待派遣队列（[{x,y,getType,marchId,flow}]，pause 保留、恢复续跑） */
var queue = [];

/** @type {number|null} 唯一 driver 定时器（自重排；flows 空或 pause 即停） */
var driverTimer = null;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（driver 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

/** @type {object} 串行消费器（派遣逐条 + 间隔休眠避限流） */
var drain = createDrain({
    log: log,
    queue: { get: function () { return queue; } },
    alive: aliveFn,
    process: pickUpFlow,
    interval: function () { return cfg.consumeInterval; },
});

/**
 * 当前服务器秒时刻（与聊天卡 t/expirationTime 同域，同源字段 DataCenter.DATA.ServerTime）；探不到回落到本地秒
 * @returns {number}
 */
function serverTimeSec() {
    var st = dataCenter && dataCenter.ServerTime;
    if (st != null && +st) return +st;
    return Date.now() / 1000;
}

/**
 * 我的在途行军列表。⚠️ NWorldMapData.marches 是 `new Map`，
 * 对 Map 用 Object.values() 会拿到空数组、判重永远不命中，故先走可迭代接口。
 * 这里用鸭子类型（有 values() 且有 size）而不是 instanceof Map：跨 realm 的 Map 实例过不了 instanceof
 * @returns {object[]}
 */
function listMarches() {
    var marches = mapData && mapData.marches;
    if (!marches) return [];
    if (typeof marches.values === 'function' && typeof marches.size === 'number') {
        var out = [];
        var it = marches.values();
        for (var step = it.next(); !step.done; step = it.next()) out.push(step.value);
        return out;
    }
    var list = [];
    for (var k in marches) {
        if (Object.prototype.hasOwnProperty.call(marches, k)) list.push(marches[k]);
    }
    return list;
}

/**
 * 该坐标上是否已有我的一条 getType 行军在路上（同一目标同时只允许一支；行军回程后游戏自动清除，无需自记账）
 * @param {number} x 目标横坐标
 * @param {number} y 目标纵坐标
 * @param {number} getType 拾取行军类型
 * @returns {boolean}
 */
function hasMarchAtTarget(x, y, getType) {
    var uid = dataCenter.UserData && dataCenter.UserData.UID;
    if (!uid) return false;
    return listMarches().some(function (march) {
        return march
            && march.realUid == uid
            && march.marchType == getType
            && march.target_tx == x
            && march.target_ty == y;
    });
}

/**
 * 这条聊天推送是不是"某台花车的发车分享卡"，是则解出建流程所需的种子值。
 * 判据只用 m 以 "link" 开头 + llm.t=38 + llm.extra.marchType 命中配置表；
 * 普通位置分享卡的 llm.t=0 且带 p{x,y,z}，天然不命中（真机对照组已验）
 * @param {object} msg newChatPush 载荷（单项对象，非数组）
 * @returns {object|null} {floatId, marchId, dropType, getType, tSec, expSec} 或 null
 */
function parseParadeShare(msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (typeof msg.m !== 'string' || msg.m.indexOf('link') !== 0) return null;
    if (msg.llm == null || msg.llm === '') return null;

    var payload = msg.llm;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (err) { return null; }
    }
    if (!payload || payload.t !== SHARE_LINK_PARADE_FLOAT_MARCH) return null;

    var extra = payload.extra;
    if (!extra) return null;
    var float = FLOAT_BY_DROP[extra.marchType];
    if (!float) return null;

    // 64 位 id 只能以 string 流转，禁止 Number()
    var marchId = extra.marchId != null && extra.marchId !== '' ? String(extra.marchId) : '';
    if (!marchId) return null;

    return {
        floatId: float.id,
        marchId: marchId,
        dropType: float.dropType,
        getType: float.getType,
        tSec: +msg.t || 0,
        expSec: +extra.expirationTime || 0,
    };
}

/**
 * 按种子建一条探测流程并算出本地锚点。
 * 时间基准只用"服务器域内的相对差"折算到本地轴，绝对时钟偏差被整个消掉：
 *   delay = ServerTime − t   → 推送在服务器侧滞留了多久（补上"push 晚到、箱已落地"）
 *   S = 本地收到时刻 − delay → 发车那一刻对应的本地时刻
 *   E = S + (exp − t)        → 窗口硬止（exp−t = 箱数×180，白送的车窗长度）
 * @param {object} seed parseParadeShare 的产出
 * @param {number} nowMs 本地收到推送的时刻
 * @returns {object} flow
 */
function newFlow(seed, nowMs) {
    var tSec = seed.tSec;
    var nowSec = serverTimeSec();
    var delaySec = tSec ? Math.max(0, nowSec - tSec) : 0;
    // exp−t = 箱数 × 180（真机 1/2/8 箱三点吻合）；缺字段或非 180 整倍时不推算，避免拿脏值当判据
    var spanSec = (tSec && seed.expSec > tSec) ? seed.expSec - tSec : 0;
    var lifeMs = spanSec ? spanSec * 1000 : DEFAULT_LIFE_MS;
    var expect = (spanSec && spanSec % BOX_WINDOW_SEC === 0) ? spanSec / BOX_WINDOW_SEC : 0;

    var flow = {
        marchId: seed.marchId,
        floatId: seed.floatId,
        dropType: seed.dropType,
        getType: seed.getType,
        S: nowMs - delaySec * 1000,
        E: nowMs - delaySec * 1000 + lifeMs,
        k: 0,
        bandStart: 0,
        bandEnd: 0,
        nextQueryAt: 0,
        inFlight: false,
        missStreak: 0,
        periodGotBox: false,
        periodShadowed: false,
        /** @type {Set<string>} 本流程已派出的坐标（"x,y"）；902 被拒时退回。size 即已拿到的唯一箱数 */
        dispatched: new Set(),
        /** @type {number} 卡片推算的箱数（0=未能推算），只用于放宽收摊阈值与事后对账 */
        expect: expect,
        /** @type {Set<string>} 本流程 902 被拒的服务器文案键（收摊时汇总，每日上限就靠它露面） */
        rejects: new Set(),
        /** @type {Map<string,{untilMs:number,tries:number}>} 被拒坐标的重试退避（key → 下次可派时刻与已试次数） */
        rejectBackoff: new Map(),
        queries: 0,
    };
    openPeriod(flow, 1, nowMs);
    return flow;
}

/**
 * 打开第 k 拍的探测窗口：以第 k 箱的落地时刻为轴，提前 L 开探、向后带宽 Y
 * @param {object} flow 目标流程
 * @param {number} k 拍序号（1 起）
 * @param {number} nowMs 当前本地时刻（后台节流导致窗口起点已过时，首查直接落在 now）
 */
function openPeriod(flow, k, nowMs) {
    flow.k = k;
    flow.bandStart = flow.S + cfg.firstBoxDelayMs + cfg.boxPeriodMs * (k - 1) - cfg.probeLeadMs;
    flow.bandEnd = flow.bandStart + cfg.probeBandMs;
    flow.nextQueryAt = Math.max(flow.bandStart, nowMs);
    flow.periodGotBox = false;
    flow.periodShadowed = false;
}

/**
 * 本拍结算时应比对的收摊阈值：已拿下的唯一箱数达到卡片推算值后，只需 1 个真空拍确认；
 * 推算不可用（缺 t/exp 或非 180 整倍）或尚未领满时，仍按 M 拍保守停止。
 * 这里刻意用 dispatched.size（唯一坐标）而不是命中事件数：902 被拒会让同一箱再次命中，事件数会虚高
 * @param {object} flow 目标流程
 * @returns {number} 需要的连续真空拍数
 */
function stopThreshold(flow) {
    return (flow.expect > 0 && flow.dispatched.size >= flow.expect) ? 1 : cfg.emptyPeriodStop;
}

/**
 * 结算一拍并推进到下一拍：本拍没新箱也没被遮蔽 → missStreak++。达阈值则出队
 * @param {object} flow 目标流程
 * @param {number} nowMs 当前本地时刻
 * @param {number} guard 循环安全上限（防 P≤Y 之类的病态配置死循环）
 * @returns {boolean} 该流程是否还活着
 */
function advancePeriods(flow, nowMs, guard) {
    while (guard-- > 0 && nowMs > flow.bandEnd) {
        if (flow.periodGotBox) flow.missStreak = 0;
        else if (!flow.periodShadowed) flow.missStreak++;

        if (flow.missStreak >= stopThreshold(flow)) {
            dropFlow(flow, 'empty ' + flow.missStreak + ' periods');
            return false;
        }
        openPeriod(flow, flow.k + 1, nowMs);
    }
    return true;
}

/**
 * 结束一条流程：出队 + 打一行对账日志（真机看这里判断 M/P/Y 是否合适）
 * @param {object} flow 目标流程
 * @param {string} reason 结束原因
 */
function dropFlow(flow, reason) {
    flows.delete(flow.marchId);
    log.info('flow end. marchId=%s;float=%s;reason=%s;periods=%d;boxes=%d;expect=%d;queries=%d;marchRejects=%s;pendingFlows=%d',
        flow.marchId, flow.floatId, reason, flow.k, flow.dispatched.size, flow.expect, flow.queries,
        flow.rejects.size ? Array.from(flow.rejects).join('|') : '-', flows.size);
    // 只对"实领多于推算"告警：少于推算是正常的没抢过别人（这种情况下阈值本就未被放宽，流程会走完 M 拍），
    // 而多于推算意味着 exp−t=箱数×180 这条关系改了，我们的拍网格与阈值都得重看
    if (flow.expect > 0 && flow.dispatched.size > flow.expect) {
        log.warn('more boxes than card prediction. marchId=%s;got=%d;expect=%d;life=%ds',
            flow.marchId, flow.dispatched.size, flow.expect, Math.round((flow.E - flow.S) / 1000));
    }
    if (!flows.size) stopDriver();
}

/**
 * 今日日期串（口径同 alliance-help：只用它做“跨日自动失效”，不追求服务器日界到小时）
 * @returns {string} "YYYY-MM-DD"
 */
function todayStr() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 该花车类型今天是否已被服务器判满（只能由 902 的显式文案键置位，不会因空查/收摊而误判）
 * @param {string} floatId 花车类型 id
 * @returns {boolean}
 */
function isCapReached(floatId) {
    return capReachedOn.get(floatId) === todayStr();
}

/**
 * 记下“该类型今日已满”，并当场收掉同类型的全部在飞流程与待派项：
 * 上限是类型级的，再探下去每台车只会得到同一个拒绝，纯属空转。
 * 只动同类型——其他花车类型的上限各自独立
 * @param {object} flow 触发本次判定的流程
 * @param {*} data 902 拒绝载荷原文
 */
function markCapReached(flow, data) {
    capReachedOn.set(flow.floatId, todayStr());
    queue = queue.filter(function (item) { return item.flow.floatId !== flow.floatId; });
    var closed = 0;
    for (var entry of Array.from(flows)) {
        if (entry[1].floatId === flow.floatId) {
            dropFlow(entry[1], 'daily limit reached');
            closed++;
        }
    }
    log.info('float type daily pickup limit reached. float=%s;date=%s;resp=%s;why=%s;flows closed=%d;queue left=%d',
        flow.floatId, todayStr(), respText(data), whyText(data), closed, queue.length);
}

/**
 * newChatPush 入口：同步过滤 + 建流程。永不 throw（net/event 封装也会兜，但不依赖它）
 * @param {object} msg newChatPush 载荷（游戏 NetChatClient 把 socket "chatpush" 单参转出来）
 */
function onChatPush(msg) {
    if (!aliveFn()) return;

    var seed = parseParadeShare(msg);
    if (!seed) return;

    // 类型级当日已满：这台车的每次探测都会撞到同一个拒绝，直接不建流程（其他类型照常）
    if (isCapReached(seed.floatId)) {
        log.debug('float type daily limit reached today, skip parade. float=%s;marchId=%s', seed.floatId, seed.marchId);
        return;
    }

    var nowMs = Date.now();
    var nowSec = serverTimeSec();
    if (seed.expSec && nowSec >= seed.expSec) {
        log.debug('stale parade share skipped. marchId=%s;lag=%ds', seed.marchId, Math.round(nowSec - seed.expSec));
        return;
    }
    if (flows.has(seed.marchId)) {
        log.debug('flow exists for this parade. marchId=%s', seed.marchId);
        return;
    }

    var flow = newFlow(seed, nowMs);
    flows.set(flow.marchId, flow);
    log.info('parade flow started. marchId=%s;float=%s;delay=%ds;life=%ds;expect=%d;firstProbeIn=%ds;flows=%d',
        flow.marchId, flow.floatId, Math.round((nowMs - flow.S) / 1000),
        Math.round((flow.E - flow.S) / 1000), flow.expect, Math.round((flow.bandStart - nowMs) / 1000), flows.size);
    ensureDriver();
}

/**
 * driver 点火：已有活跃流程就必须在跑。重复调用 no-op
 */
function ensureDriver() {
    if (driverTimer != null || !flows.size) return;
    driverTimer = setTimeout(tick, cfg.tickMs);
}

/**
 * driver 熄火：唯一定时器只有一处要清，pause / flows 空都走这里
 */
function stopDriver() {
    if (driverTimer == null) return;
    clearTimeout(driverTimer);
    driverTimer = null;
}

/**
 * 时间环的一格：扫一遍全部流程，到点该查的就查、窗口过期的就结算，然后自重排。
 * 单条流程抛错不影响其他流程（逐条 try）
 */
function tick() {
    driverTimer = null;
    if (!aliveFn()) {
        // pause 后不重排；resume 时 run() 会重新点火，flows 表原地保留
        return;
    }

    var nowMs = Date.now();
    for (var entry of flows) {
        var flow = entry[1];
        try {
            if (nowMs >= flow.E) {
                dropFlow(flow, 'window expired');
                continue;
            }
            if (nowMs > flow.bandEnd && !advancePeriods(flow, nowMs, 64)) continue;
            if (!flow.inFlight && nowMs >= flow.nextQueryAt) probe(flow);
        } catch (err) {
            log.warn('tick threw. marchId=%s', flow.marchId, err);
        }
    }

    if (flows.size) driverTimer = setTimeout(tick, cfg.tickMs);
}

/**
 * 反查“这个坐标上的在途行军是哪条流程派的”。游戏侧 march 记录不带发车 marchIdStr
 * （902 本身只带 {marchType,x,y}，服务器无从回写），归属只能靠各流程自己的 dispatched 集合。本函数纯为诊断：
 * 让路日志能指出挡路者，才能分清“另一台活跃车占位”与“已收摊流程的遗留行军”这两种完全不同性质的情形
 * @param {string} key 坐标键 "x,y"
 * @param {string} selfId 本流程 marchIdStr（不算自己）
 * @returns {string} 归属流程的 marchIdStr，查不到回 'stale'（其流程已收摊，行军还在路上）
 */
function marchOwnerAt(key, selfId) {
    for (var entry of flows) {
        var other = entry[1];
        if (other.marchId !== selfId && other.dispatched.has(key)) return other.marchId;
    }
    return 'stale';
}

/**
 * 一拍内的一次定向探测：发 8852 问"这台车我现在能领哪箱"。
 * 三种结果分别记账：命中新箱 → 入队派遣；命中已派箱 → 本拍记"被遮蔽"（中性）；真·空 → 什么都不做，交给拍结算计数
 * @param {object} flow 目标流程
 */
async function probe(flow) {
    flow.inFlight = true;
    flow.queries++;
    // 重试节拍以"发出时刻"为起点算：若从应答到达起算，单次往返耗时会叠加进间隔（真机 RTT≈1s，
    // 设计里的 1s 采样实测退化成 2s，10 秒容差带只采到 5 次，后半拍几乎不采样）
    var sentAt = Date.now();
    var res = await queryBox(flow.dropType, flow.marchId);
    flow.inFlight = false;

    // await 期间流程可能已被结算/过期出队，也可能整个功能已 pause
    if (!aliveFn() || flows.get(flow.marchId) !== flow) return;

    flow.nextQueryAt = sentAt + cfg.retryMs;

    if (res.state === 'hit') {
        var key = res.x + ',' + res.y;
        // 行军在路上、还没领到手时，8852 会持续返回同一箱：这是"被遮蔽"，不代表这台车没箱了，
        // 也不代表该再派一次——既不能重复派遣，也不该因此累加 missStreak
        if (flow.dispatched.has(key)) {
            flow.periodShadowed = true;
            log.debug('box shadowed by own march. marchId=%s;x=%d;y=%d', flow.marchId, res.x, res.y);
            return;
        }
        // 被拒过的坐标按退避时间再试：服务器回“操作太频繁”时，正确的响应是放慢而不是每秒重派。
        // 记 periodShadowed（中性）：这格确实有箱，只是在等退避，不能当作“本拍真空”去推进收摊
        var back = flow.rejectBackoff.get(key);
        if (back && Date.now() < back.untilMs) {
            flow.periodShadowed = true;
            log.debug('pickup in backoff. marchId=%s;x=%d;y=%d;retryIn=%ds;tries=%d',
                flow.marchId, res.x, res.y, Math.round((back.untilMs - Date.now()) / 1000), back.tries);
            return;
        }
        if (hasMarchAtTarget(res.x, res.y, flow.getType)) {
            // 走到这里说明坐标不在本流程 dispatched 里（上一分支已判），那支在途行军是别的流程发的。
            // 此刻只能判定"同一目标不能同时两支行军"，不能判定"这箱会被那条行军领到手"：
            // 一格同时只有一物，但前一箱被领满 20 次提前消失后，坐标会被交叉时间段的另一箱复用，
            // 而 8852 是按本流程 marchIdStr 定向查询的——它回了 (x,y) 就是"这格现在的箱属于我这台车"。
            // 所以这里只瞬时让路（不写进 dispatched）：行军一落地/一消失，下一次探测（≤1s）就能补派。
            // 写成永久认账会让本流程再也不派这个坐标，那种情形下是真丢一箱
            flow.periodShadowed = true;
            log.debug('box occupied by another march, yield this tick. marchId=%s;owner=%s;x=%d;y=%d',
                flow.marchId, marchOwnerAt(key, flow.marchId), res.x, res.y);
            return;
        }
        flow.periodGotBox = true;
        flow.missStreak = 0;
        flow.dispatched.add(key);
        // 本拍收获即收拍：下一箱最早也在 30 秒后落地，窗口剩下的几秒只会反复取回自己那支在途行军的同一箱，白查。
        // ⚠️ 必须用发出时刻 sentAt 而不是 Date.now()（应答到达时刻）：后者总晚一个 RTT，与 nextQueryAt=sentAt+retryMs
        // 差不多落在同一个瞬间，于是“下一 tick 才结算”永远等不到（nowMs > bandEnd 恒为假），
        // 只要服务器还在回这个坐标就会每秒重命中一次：回放实测拍号卡在 1、整窗撞 151 次 902
        flow.bandEnd = sentAt;
        log.info('box found. marchId=%s;float=%s;x=%d;y=%d;period=%d', flow.marchId, flow.floatId, res.x, res.y, flow.k);
        enqueuePickUp(flow, res.x, res.y, key);
        return;
    }

    if (res.state === 'empty') {
        // 空因文案键只在本次会话首次出现时报一行 info：它才能分辨"没箱"与"今日 10 次已满"
        if (res.key && !seenEmptyKeys.has(res.key)) {
            seenEmptyKeys.add(res.key);
            log.info('new 8852 empty reason. marchId=%s;period=%d;code=%d;resp=%s;why=%s', flow.marchId, flow.k, res.code, res.resp, res.why);
        } else {
            log.debug('no box for this parade. marchId=%s;period=%d;code=%d', flow.marchId, flow.k, res.code);
        }
    }
    // state==='error'：网络异常，本 tick 放弃，不改动任何计数——下一次 tick 自然兜底
}

/**
 * 拒绝应答里的文案键（真机口径："<语言键>,<参数>"，如 "alliance_120503,10"，与 alliance-help 同源处理）。
 * code=3 本身只代表“被拒”、不携带业务含义，“今日 10 次已满”还是“没箱”只可能从这个键区分
 * @param {*} data Ret.data
 * @returns {string|null} 不是字符串形态（空/对象）时不猜
 */
function rejectErrKey(data) {
    if (typeof data !== 'string' || !data) return null;
    var comma = data.indexOf(',');
    return comma >= 0 ? data.slice(0, comma) : data;
}

/**
 * 服务器文案键 → 游戏当前语言文本（走 ACL 的 l10n.net，与游戏自己弹的 toast 同源）。
 * 真机实例：902 撞每日上限回的是 `mysterioustriangle_10`——“神秘三角”活动的文案族被服务端跨活动复用了，
 * 光看键名无法定性；而误把未知键当“今日已满”做熔断，代价是当天从此不再领，不可逆。
 * 查不到译文（或 l10n 不可用）回 '-'，不重复打原文
 * @param {*} data Ret.data
 * @returns {string}
 */
function whyText(data) {
    if (typeof data !== 'string' || !data) return '-';
    try {
        var t = l10n.net(data);
        return (t && t !== data) ? t.slice(0, 60) : '-';
    } catch (err) {
        // 翻译只是附加信息，绝不能吃掉整条被拒日志（回放实测：这里抛异常时 warn 根本打不出去）
        return '-';
    }
}

/**
 * 应答载荷的一行文本形态（截断，避免对象载荷刷屏）
 * @param {*} data Ret.data
 * @returns {string}
 */
function respText(data) {
    if (data == null || data === '') return '-';
    var s;
    try {
        s = typeof data === 'string' ? data : JSON.stringify(data);
    } catch (err) {
        return '[unserializable]';
    }
    return s.slice(0, 60);
}

/**
 * 查这台花车当前我能领的箱坐标（游戏"查看花车附近奖励"同款请求）。
 * 永不 reject：发送异常回 error，服务器"无箱"两种口径（s!=0 被拒 / s=0 但 {x:0,y:0}）都回 empty
 * @param {number} dropType 投放行军类型（查询吃 DROP 值，不是 GET）
 * @param {string} marchIdStr 花车行军 id（string，64 位精度）
 * @returns {Promise<object>} {state:'hit',x,y} | {state:'empty',code,key,resp} | {state:'error',code}
 */
async function queryBox(dropType, marchIdStr) {
    try {
        var ret = await net.sendPBV2(CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG, {
            queryType: 1,
            marchType: dropType,
            marchIdStr: marchIdStr
        });
        var pos = ret.data;
        // 被拒时把原载荷留下来：这是“为什么没箱”的唯一线索（每日上限？被别人领完？箱确实不在）
        if (!ret.ok) return { state: 'empty', code: ret.code, key: rejectErrKey(pos), resp: respText(pos), why: whyText(pos) };
        if (!pos) return { state: 'empty', code: ret.code, key: null, resp: '-' };
        if (!pos.x || !pos.y) return { state: 'empty', code: ret.code, key: null, resp: respText(pos) };
        return { state: 'hit', x: pos.x, y: pos.y, code: ret.code };
    } catch (err) {
        log.warn('query box error! marchId=%s', marchIdStr, err);
        return { state: 'error', code: CODE_NOT_SENT };
    }
}

/**
 * 入队一支拾取派遣并点火消费。同坐标已在队列里则不重复入队（同箱两次返回的去重兜底）
 * @param {object} flow 所属流程
 * @param {number} x 箱横坐标
 * @param {number} y 箱纵坐标
 * @param {string} key 坐标键 "x,y"
 */
function enqueuePickUp(flow, x, y, key) {
    if (queue.some(function (item) { return item.key === key; })) {
        log.debug('pickup already queued. x=%d;y=%d', x, y);
        return;
    }
    queue.push({ x: x, y: y, key: key, getType: flow.getType, marchId: flow.marchId, flow: flow });
    drain.consume().catch(function (err) {
        log.warn('consume loop threw!', err);
    });
}

/**
 * 单条派遣流程（drain 的 process）：派 902。被拒时把坐标从已派集合退回，留给后续拍重试。永不 reject
 * @param {object} item 队列项 {x,y,key,getType,marchId,flow}
 * @returns {Promise<void>}
 */
async function pickUpFlow(item) {
    var ret = await marchPickUp(item);
    if (ret.ok) {
        log.info('pick up march started. marchId=%s;x=%d;y=%d;code=%d', item.marchId, item.x, item.y, ret.code);
        return;
    }
    item.flow.dispatched.delete(item.key);
    var errKey = rejectErrKey(ret.data);
    if (errKey) item.flow.rejects.add(errKey);
    // resp 是服务器拒绝原文（形如 "<文案键>,<参数>"）：每日上限、目标被占、发得太密均靠它区分，不可漏打
    log.warn('pick up march rejected! marchId=%s;x=%d;y=%d;code=%d;resp=%s;why=%s',
        item.marchId, item.x, item.y, ret.code, respText(ret.data), whyText(ret.data));
    // 只这个精确键才算上限，且只归给发出这支行军的花车类型（同族键被其他活动复用，不能跨类污染）
    if (errKey === ERR_FLOAT_DAILY_LIMIT) { markCapReached(item.flow, ret.data); return; }
    // 其余拒绝：同一坐标指数退避后再试（上限键已整天收摊，不需要退避）
    var tries = ((item.flow.rejectBackoff.get(item.key) || {}).tries || 0) + 1;
    var wait = Math.min(cfg.rejectBackoffBaseMs * (1 << Math.min(tries - 1, 5)), cfg.rejectBackoffMaxMs);
    item.flow.rejectBackoff.set(item.key, { untilMs: Date.now() + wait, tries: tries });
    log.debug('pickup retry scheduled. marchId=%s;x=%d;y=%d;tries=%d;backoff=%ds',
        item.marchId, item.x, item.y, tries, Math.round(wait / 1000));
}

/**
 * 派拾取行军。永不 reject：发送异常回落到 CODE_NOT_SENT 的哨兵 Ret
 * @param {object} item 队列项 {x,y,getType}
 * @returns {Promise<Ret>} code=902 状态码
 */
async function marchPickUp(item) {
    try {
        return await net.send(CMD_MARCH_WORLD_POINT, {
            marchType: item.getType,
            x: item.x,
            y: item.y
        });
    } catch (err) {
        log.warn('march error! x=%d;y=%d', item.x, item.y, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 安装：取网络底座 + 世界地图数据 + 数据中心。任一依赖缺失即失败（reactor 不会激活）
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

    var mods = game.requireAll(['NWorldMapData', 'DataCenter']);

    mapData = mods.NWorldMapData
        && mods.NWorldMapData.default
        && mods.NWorldMapData.default.instance
        || missing.push('NWorldMapData');

    dataCenter = mods.DataCenter
        && mods.DataCenter.DATA
        || missing.push('DataCenter');

    if (missing.length) {
        net = null; mapData = null; dataCenter = null;
        log.warn('install failed. missing=%d;deps=%s', missing.length, missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed. floats=%s', FLOATS.map(function (f) { return f.id + '(' + f.dropType + '/' + f.getType + ')'; }).join(','));

    return true;
}

/**
 * 运行：挂聊天推送监听，driver 原位重启（pause 期间 flows 表保留，resume 后继续未探完的车）。
 * reactor pause 会自动摘除此处登记的触发器
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    ctx.on.event('newChatPush', onChatPush);
    ensureDriver();
    log.info('started, listening event=newChatPush;flows=%d.', flows.size);
}

/**
 * 向 reactor 注册本功能说明书：场景限定 Home/NWorldMap，战斗模式暂停（offInCombat）。
 * 面板只出启用开关，探测节奏全部为 cfg 内置常量。
 * ⚠️ 与 chipBlessing 同开会双派（那边没有任何判重），二者取一
 */
reactor.register({
    id: 'floatCar',
    label: '花车空投',
    storageKey: 'pocketcc.feat.floatCar',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: { enabled: false },
    fields: [],
    toModuleCfg: function () { return {}; },
    install: install,
    run: run,
});
