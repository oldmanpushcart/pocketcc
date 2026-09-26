/**
 * 联盟帮助（reactor 说明书形态）
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *
 * 架构：
 *   生产者 runTick 定时轮询（两档间隔：当天还有事可做 busyInterval，荣誉分与申请次数都满 idleInterval），
 *     无状态条件扫描 → 按 kind 去重入队任务（HELP_ALL / RECEIVE / APPLY），申请闸门：
 *     计数通道已同步（AllianceHelpMax>0）、未被服务器显式标记当日已满、本地计数未达上限（同步前不发申请）；
 *   消费者（createDrain）串行取任务，执行前重判前置条件（条件没了就地丢弃），每条之间休眠 consumeInterval。
 *   与泰坦祝福不同：联盟帮助没有可靠的"集齐"推送（10446 语义未验证），生产者不能纯事件驱动。
 *   数据来源：自己的自助帮助进度靠游戏 push（10446 自助帮助列表 / 10453 帮助重取）写进 _selfHelpList，
 *     面板正是监听 AllianceHelpUpdate 事件即时刷新——所以面板能秒显、只靠轮询的脚本却迟迟读不到。
 *     脚本不解析 push 载荷（10446 语义未验证），只订阅这两条 push 的“到达”当唤醒信号（net.recvMine
 *     先跑游戏处理器再派发，唤醒时本地数据已新鲜），到达即 scheduling(0) 抢跑一轮生产消除空档；轮询仍作兜底。
 *
 * 只读 + 发包：本脚本不调用游戏任何 Update、Delete 等改写本地数据的内部方法——
 *   发包后的数据变更全部交给游戏自身的 push 通知维护，下一轮轮询读到的即是新状态。
 * 协议出处与设计台账见同目录《联盟帮助资料整理.md》。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子。无推送，run 直接点火自重排定时器；
 *   定时器是功能内部的生产逻辑，pause 后 alive()=false，挂着的定时器到点空转一次不再自重排，resume 时 run 重新点火。
 *   未声明 scenes → scene 门控默认放行，任何场景都跑（与重构前一致）。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { createDrain } from '../../core/drain.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ALLIANCE_HELP） */
const log = createLog('ALLIANCE_HELP');

/** @type {number} RequestId.ALLIANCE_HELP_APPLY（RequestId.js:338），载荷 {type:4, itemId, helpNum}（AllianceHelpSelectPanel_New.js:149,179-183） */
const CMD_ALLIANCE_HELP_APPLY = 1139;

/** @type {number} RequestId.ALLIANCE_HELP_RECEIVE（RequestId.js:340），载荷 {type: 在途申请.Type, qid:"0"}（AllianceHelpPanel_New2.js:274-279） */
const CMD_ALLIANCE_HELP_RECEIVE = 1141;

/** @type {number} RequestId.HELP_ALL_ALLIANCE_MEMBERS（RequestId.js:1033），载荷 {type:4}（AllianceHelpPanel_New2.js:373） */
const CMD_HELP_ALL_ALLIANCE_MEMBERS = 1195;

/** @type {number} ResponseId.PushAllianceSelfHelpList（ResponseId.js:147）：自己的帮助被盟友帮助后的自助帮助列表推送，游戏据此 UpdateSelfHelpList 刷新 _selfHelpList（PushResponse.js:3369-3374） */
const PUSH_ALLIANCE_SELF_HELP = 10446;

/** @type {number} ResponseId.ALLIANCE_HELP_REGET：联盟帮助数据整表重取推送，Handler 调 UpdateAllianceHelpData(!0) 重建 _selfHelpList/计数（PushResponse.js:5341-5343、AllianceData.js:445） */
const PUSH_ALLIANCE_HELP_REGET = 10453;

/** @type {string} 1139 拒绝应答 data 里的“超过每日联盟帮助请求上限”文案键（真机样本 data="alliance_120503,10"，
 *  逗号后参数 {0}=上限值；字典表.txt:1588）。code=3 本身只代表服务器拒绝、不携带业务含义，
 *  “当日已满”只认这个显式标记 */
const ERR_ALLIANCE_DAILY_HELP_LIMIT = 'alliance_120503';

/** @type {string} TableName.ALLIANCE_HELP（TableName.js:29），helpNum 运行时读表行 rewards_num */
const TABLE_NAME_ALLIANCE_HELP = 'alliance_help';

/** @type {number} 申请帮助载荷/表行的 type 固定为 4（AllianceHelpSelectPanel_New.js:180） */
const HELP_TYPE_ITEM = 4;

/** @type {string} 任务种类：帮助全员（1195） */
const TASK_HELP_ALL = 'HELP_ALL';

/** @type {string} 任务种类：领取已集齐的自助帮助（1141） */
const TASK_RECEIVE = 'RECEIVE';

/** @type {string} 任务种类：发起自助帮助申请（1139） */
const TASK_APPLY = 'APPLY';

/** @type {number} 非服务器返回的哨兵 code：闸门未放开 / 发送异常时用，与真实 s 码区分开 */
const CODE_NOT_SENT = -1;

/**
 * 配置项
 * @type {object}
 */
const cfg = {

    /**
     * 忙碌生产间隔：当天荣誉分或申请次数还没满时用，默认10秒
     */
    busyInterval: 1000 * 10,

    /**
     * 空转生产间隔：荣誉分与申请次数都到当日上限后用，默认10分钟（等次日重置）
     */
    idleInterval: 1000 * 60 * 10,

    /**
     * 队列逐条消费之间的休眠毫秒。1139/1141/1195 暂无限流实锤，2秒起步
     * （真机所见：code=3 为业务拒绝而非限流——首发未带任何前序请求也回此码）
     */
    consumeInterval: 1000 * 2,

    /**
     * 申请帮助候选物品：只在这4个石头里选持有数量最少的。
     * id=alliance_help 表行 id；reward=行内 reward_param，用于 getItemAmount 读持有量
     * （对应关系见《联盟帮助资料整理.md》，已对过游戏面板取值路径 AllianceHelpSelectPanel_New.js:70,177）
     */
    items: [
        { id: 10005, reward: 3500005, name: '玛瑙石' },
        { id: 10006, reward: 3500006, name: '黑曜石' },
        { id: 10003, reward: 3500007, name: '月亮石' },
        { id: 10004, reward: 3500008, name: '翡翠石' }
    ]
};

/**
 * 脚本依赖：net 网络（promise 封装 pocketcc.net）、table 表管理器、data 数据中心、tableUtils 表工具（读 DATACONFIG 配置值）
 * @type {object|null}
 */
var net;
/** @type {object|null} TableManager.TABLE */
var table;
/** @type {object|null} DataCenter.DATA */
var data;
/** @type {object|null} TableUtils 默认导出 */
var tableUtils;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞任务自然退出 */
var ctxRef = null;

/** @type {string|null} 服务器显式标记“当日申请已满”（alliance_120503）的日期：拒绝应答不更新本地计数，
 *  收到该标记后当日不再申请，跨日自动失效 */
var quotaSaturatedToday = null;

/** @type {number|null} 生产轮询单定时器句柄 */
var timer = null;

/** @type {object[]} 待消费任务队列（pause 保留、恢复续跑；execTask 执行前重判前置条件，陈旧任务自动丢弃） */
var queue = [];

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

/** @type {object} 串行消费器（逐条执行任务 + 间隔休眠） */
var drain = createDrain({
    log: log,
    queue: { get: function () { return queue; } },
    alive: aliveFn,
    process: execTask,
    interval: function () { return cfg.consumeInterval; },
});

/**
 * 单定时器武装器：每个 tick 跑一次 runTick
 * runTick 为 async，用 Promise 兜住意外 reject——断链就重排一次，链不死
 * @param {number} delay 延迟(毫秒)
 * @param {function} fn 到点执行的下一步
 */
function scheduling(delay, fn) {
    if (!aliveFn()) return false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
        timer = null;
        if (!aliveFn()) return;
        Promise.resolve()
            .then(fn)
            .catch(function (err) {
                log.warn('scheduled step threw, reschedule.', err);
                scheduling(nextInterval(), runTick);
            });
    }, Math.max(0, delay));
    return true;
}

// ─────────────────────────── 生产者 ───────────────────────────

/**
 * 生产轮询：无状态条件扫描 → 按 kind 去重入队 → 触发消费 → 重排下一轮
 */
function runTick() {
    produce();
    if (!aliveFn()) return;
    drain.consume().catch(function (err) {
        log.warn('consume loop threw!', err);
    });
    scheduling(nextInterval(), runTick);
}

/**
 * 条件扫描入队。帮助全员与自己申请是两条独立业务流，各自判定、各自入队，互不抢占——
 * 早期版本帮助段命中就 return，联盟请求源源不断时自己申请被饿死（真机已证）。
 * 任务按 kind 去重：队列里或在消费中的同类任务已存在就不重复入队
 */
function produce() {

    var alliance = data.UserData.Alliance;

    // 不在联盟：什么都不入队
    if (!alliance.isInAlliance()) {
        log.debug('not in alliance, wait next tick.');
        return;
    }

    // 流程1：有盟员请求帮助，且荣誉分没满 → 帮助全员
    if (needHelpAll()) {
        enqueue({ kind: TASK_HELP_ALL });
    }

    // 计数未落地前绝不发申请：盲发会因占位 0 被判“未满”而撞墙（真机：启动即申请 code=3、data=alliance_120503）。
    // 口径同游戏 canAskHelp（AllianceController.js:133-138）的 !!UpdatedSelfHelp 且 AllianceHelpMax 已填。
    if (!alliance.UpdatedSelfHelp) {
        log.debug('help data not synced by game yet (UpdatedSelfHelp=false), wait next tick.');
        return;
    }

    // 流程2：自己的申请（在途领取 / 无在途申请 / 次数用完空转）
    // “申请次数已同步”与“自助帮助列表已同步”是两条不同通道：UpdatedSelfHelp 仅由 UpdateSelfHelpList 置真，
    // push 10446（只带 selfHelps、不带计数）就能触发它；而 AllianceHelpCount 只有 UpdateAllianceHelpCountAndHonor
    // 收到含 alhtdcnt 的下发（10453 整表重取 / 1138 拉取 / 任一申请应答）才填。同一函数会把
    // AllianceHelpMax 从占位 0 惰性填成真实上限，故 AllianceHelpMax>0 等价于“计数通道同步过”（见 isHelpCountSynced）。

    // 不直接用 getSelfHelpData()（恒取 _selfHelpList[0]）：表按 Type upsert 去重，不同 Type 可并存，
    // 我们申请满进度的那条（物品类 Type4）若不在 [0]，盲取 [0] 会漏判、永不入队 RECEIVE。
    // 故全表扫描定位满进度条目；“表非空”仍作为“是否发起新申请”的闸门（口径同面板 btnAskHelp 要求 getSelfHelpData()==null）。
    var selfHelpList = alliance.SelfHelpList;

    if (selfHelpList.length > 0) {
        var full = findFullSelfHelp(selfHelpList);
        if (full) {
            // 集齐判据同游戏排序器（AllianceHelpPanel_New2.js:127）：HelpCount >= MaxCount。
            // 用 >= 不用 ===：盟友可超量帮（样本见 count:16/max:10），HelpCount 会越过 MaxCount，
            // 严格相等会漏判满进度、永不领取（真机：第10次求助集齐后不领）。
            // 入队只存 Type，不存对象引用——push 10453 会整体重建 _selfHelpList，旧引用执行前必失效（真机：满进度迟迟不领）
            enqueue({ kind: TASK_RECEIVE, type: full.Type });
        } else {
            var inflight = selfHelpList[0];
            log.debug('self help in progress, wait next tick. progress=%s/%s',
                inflight.HelpCount, inflight.MaxCount);
        }
        return;
    }

    // 自帮助列表已同步（UpdatedSelfHelp）不等于申请次数已同步：未过这道闸门时不入 APPLY 任务
    // （与 execTask 重判一致，避免入队后又被当陈旧丢弃的无谓 churn）。
    if (!isHelpCountSynced(alliance)) {
        log.debug('help count not synced yet (AllianceHelpMax=0), skip applying, wait for authoritative count.');
        return;
    }

    if (isQuotaReached(alliance)) {
        log.debug('self help quota used (local count or server explicit saturation), idle.');
        return;
    }

    var picked = pickLeastItem();
    if (!picked) {
        log.warn('no selectable item (table row missing?), wait next tick.');
        return;
    }

    enqueue({ kind: TASK_APPLY, item: picked.item, helpNum: picked.helpNum });
}

/**
 * 入队（同 kind 去重）并打日志
 * @param {object} task 任务对象 {kind, ...载荷}
 */
function enqueue(task) {
    if (hasQueued(task.kind)) {
        log.debug('task already queued, skip. kind=%s', task.kind);
        return;
    }
    queue.push(task);
    // item id 放末位：%d 对 undefined 输出 NaN；type 无值时传 '-' 直出，不走 typeToName（其入参是类型码）
    log.info('task enqueued. kind=%s;type=%s;helpNum=%d;pending=%d;item=%d',
        task.kind, task.type == null ? '-' : typeToName(task.type), task.helpNum || 0, queue.length,
        task.item ? task.item.id : 0);
}

/**
 * 帮助类型码转可读名。type 取自入队时记录的 task.type（数字，口径同游戏 requestHelp.type）；
 * 非 RECEIVE 任务无 type（undefined）不在此列表，回退占位符，避免误报“未知类型”
 * @param {number} type 帮助类型码
 * @returns {string}
 */
function typeToName(type) {
    switch (type) {
        case 1: return '科技';
        case 2: return '建筑';
        case 3: return '医院';
        case 4: return '石头';
        default: return '-';
    }
}

/**
 * 队列里是否已有同 kind 任务。消费循环在首个 await 前就 shift 走了当前任务，
 * 故"在消费中"表现为队列里同类缺席——生产者下一轮按最新状态重新入队即可，这里无需追踪在飞任务
 * @param {string} kind 任务种类
 * @returns {boolean}
 */
function hasQueued(kind) {
    return queue.some(function (task) { return task.kind === kind; });
}

/**
 * 下一轮生产间隔：当天还有事可做（荣誉分未满 或 申请次数未用完 或 有在途自助帮助待领）→ busyInterval；
 * 三者都不成立 → idleInterval（等次日重置）。
 * “有在途待领”必须计入 busy：最后一次申请用满当天次数、荣誉分也满时，若只看两个配额会掉进
 * idleInterval（默认10分钟），而进度是在这一次轮询之间的空档里才被盟友填满的，
 * 下一次 runTick 要等满 10 分钟才探测到满进度并领取（真机：“最后一个 help 进度满了迟迟不领”）。
 * 服务器标记“当日已满”后不再申请，但他人求助仍会 push 唤醒（10446/10453），
 * 在途领取流不依赖本轮询兼顾，故此处按“非 busy”处理掉进 idleInterval 可接受。
 * @returns {number} 毫秒
 */
function nextInterval() {
    var alliance = data.UserData.Alliance;
    var pendingSelfHelp = alliance.SelfHelpList.length > 0;
    var busy = pendingSelfHelp
        || alliance.AllianceHelpHonorCount < getHonorMax(alliance)
        || !isQuotaReached(alliance);
    return busy ? cfg.busyInterval : cfg.idleInterval;
}

/**
 * 帮助全部是否值得发：荣誉分未到当日上限（到了再帮零收益），且本地列表里确有人可帮。
 * 列表判空口径与游戏 helpAllClick 一致（AllianceHelpPanel_New2.js:369-371）。
 * @returns {boolean}
 */
function needHelpAll() {
    var alliance = data.UserData.Alliance;
    if (alliance.AllianceHelpHonorCount >= getHonorMax(alliance)) return false;
    // 可帮判据直接复用游戏口径：AllianceHelpList（自己/他人的物品类求助）非空，
    // 或 getOtherCanHelpAssistList()（他人的援助请求，已排除我自己、以及我已帮过的）非空。
    // 与游戏 helpAllClick 的判空逻辑一一对应（AllianceHelpPanel_New2.js:369-371）
    return alliance.AllianceHelpList.length > 0
        || alliance.getOtherCanHelpAssistList().length > 0;
}

/**
 * 申请次数是否按"已用完"处理：本地计数达上限（alhtdcnt），或当日收到过服务器显式的“已满”标记。
 * 调用前应已过 isHelpCountSynced 闸门，故此处 AllianceHelpCount 为可信真值（非占位 0）。
 * code=3 只代表拒绝，本身不作任何依据；只有解析拒绝载荷命中 alliance_120503 文案键才记当日饱和。
 * @param {object} alliance DATA.UserData.Alliance
 * @returns {boolean}
 */
function isQuotaReached(alliance) {
    if (quotaSaturatedToday === todayStr()) return true;
    return alliance.AllianceHelpCount >= getHelpMax(alliance);
}

/**
 * 计数通道是否已同步：alliance.AllianceHelpMax（原始值，不走兜底读表）> 0。
 * 该字段仅由 UpdateAllianceHelpCountAndHonor 惰性填充（==0 时读配置 130062，AllianceData.js:463），
 * 而该函数只在游戏收到含 alhtdcnt 的下发（10453 / 1138 / 任一申请应答）时被调——故它≠0 说明
 * AllianceHelpCount 已被同步为真值；而 push 10446（只更新 selfHelps）不碰此字段，无法误开这道闸门。
 * @param {object} alliance DATA.UserData.Alliance
 * @returns {boolean}
 */
function isHelpCountSynced(alliance) {
    return alliance.AllianceHelpMax > 0;
}

/**
 * 本地日期（YYYY-MM-DD，口径同联盟集结），仅用于“当日已满”显式标记的跨日失效
 * @returns {string} YYYY-MM-DD
 */
function todayStr() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 解析拒绝应答的 data（真机口径："<文案键>,<参数,...>"，如 "alliance_120503,10"）取文案键部分。
 * data 不是该形态（空/对象/无逗号键）时返回 null，不猜测。
 * @param {*} data Ret.data（send 通道为字符串原文）
 * @returns {string|null}
 */
function rejectErrKey(data) {
    if (typeof data !== 'string' || !data) return null;
    var comma = data.indexOf(',');
    var key = comma >= 0 ? data.slice(0, comma) : data;
    return /^[a-z][a-z0-9_]*$/i.test(key) ? key : null;
}

/**
 * 荣誉分当日上限。AllianceHelpHonorMax 只在收到相关应答时才被游戏填上，
 * 为 0 时按游戏同款口径惰性读配置 9910（AllianceData.js:464），读不到返回 Infinity（判"未满"，不拦正常流程）
 * @param {object} alliance DATA.UserData.Alliance
 * @returns {number}
 */
function getHonorMax(alliance) {
    if (alliance.AllianceHelpHonorMax) return alliance.AllianceHelpHonorMax;
    var v = parseInt(tableUtils.getDataConfigData(9910), 10);
    return isNaN(v) ? Infinity : v;
}

/**
 * 申请帮助次数当日上限。AllianceHelpMax 为 0 时按游戏同款口径惰性读配置 130062（AllianceData.js:463），
 * 读不到返回 0（判"次数已用完"，宁可不发申请）
 * @param {object} alliance DATA.UserData.Alliance
 * @returns {number}
 */
function getHelpMax(alliance) {
    if (alliance.AllianceHelpMax) return alliance.AllianceHelpMax;
    var v = parseInt(tableUtils.getDataConfigData(130062), 10);
    return isNaN(v) ? 0 : v;
}

/**
 * 在 cfg.items 里选持有数量最少的物品；helpNum 运行时读表行 rewards_num，读不到即弃选该行。
 * 未达解锁条件的行直接弃选（口径同游戏申请面板 initAwardItem，见 rowSelectable）。
 * 持有量口径同游戏面板：getItemAmount(row.reward_param)（AllianceHelpSelectPanel_New.js:70,177）
 * @returns {object|null} {item, amount, helpNum}；没有可选行时返回 null
 */
function pickLeastItem() {
    var picked = null;
    for (var i = 0; i < cfg.items.length; i++) {
        var item = cfg.items[i];
        var row = table.getTableDataById(TABLE_NAME_ALLIANCE_HELP, String(item.id));
        if (!row) {
            log.warn('alliance_help table row missing, skip. itemId=%d', item.id);
            continue;
        }
        if (!rowSelectable(row)) {
            log.debug('item locked by unlock condition, skip. itemId=%d', item.id);
            continue;
        }
        var amount = getItemAmount(item);
        if (!picked || amount < picked.amount) {
            picked = { item: item, amount: amount, helpNum: row.rewards_num };
        }
    }
    return picked;
}

/**
 * 表行是否达到解锁条件（同游戏申请面板 initAwardItem 的过滤，AllianceHelpSelectPanel_New.js:166）：
 * unlock_type=1 需等级 ≥ unlock_level；unlock_type=2 需等级恰等于 unlock_level；其余取值视为不可选——
 * 不发面板上根本申请不到的东西
 * @param {object} row alliance_help 表行
 * @returns {boolean}
 */
function rowSelectable(row) {
    var level = data.UserData.Level;
    if (row.unlock_type === 1) return level >= row.unlock_level;
    if (row.unlock_type === 2) return level === row.unlock_level;
    return false;
}

/**
 * 全表扫描找第一条已集齐的在途自助帮助（HelpCount >= MaxCount）。
 * getSelfHelpData() 恒取 [0]，多条在途时满进度那条未必在首位，故这里遍历整表。
 * @param {Array} selfHelpList alliance.SelfHelpList（_selfHelpList）
 * @returns {object|null} 命中的条目（可读 Type/HelpCount/MaxCount），无则 null
 */
function findFullSelfHelp(selfHelpList) {
    for (var i = 0; i < selfHelpList.length; i++) {
        if (selfHelpList[i].HelpCount >= selfHelpList[i].MaxCount) return selfHelpList[i];
    }
    return null;
}

/**
 * 按 Type 在整表里定位当初入队的那条在途条目（表按 Type upsert 去重，同 Type 唯一）。
 * @param {Array} selfHelpList alliance.SelfHelpList
 * @param {number} type 入队时记录的 Type
 * @returns {object|null} 命中的条目，无则 null
 */
function findSelfHelpByType(selfHelpList, type) {
    for (var i = 0; i < selfHelpList.length; i++) {
        if (selfHelpList[i].Type === type) return selfHelpList[i];
    }
    return null;
}

/**
 * 获取物品持有数量
 * @param {object} item cfg.items 里的物品对象
 * @returns {number}
 */
function getItemAmount(item) {
    return data.UserData.getItemAmount(item.reward);
}

// ─────────────────────────── 消费者 ───────────────────────────

/**
 * 执行单条任务：前置条件在入队到执行之间可能已失效（被上一轮任务改变），执行前重判，条件没了就地丢弃。
 * 永不 reject
 * @param {object} task 任务对象
 * @returns {Promise<void>}
 */
async function execTask(task) {

    var alliance = data.UserData.Alliance;
    var ret;

    if (task.kind === TASK_HELP_ALL) {
        if (!needHelpAll()) return dropStale(task);
        ret = await helpAll();
        if (!aliveFn()) return;
        log.info('helpAll done. code=%d;honor=%s/%s',
            ret.code, alliance.AllianceHelpHonorCount, getHonorMax(alliance));
    } else if (task.kind === TASK_RECEIVE) {
        // 重判：仍按 Type 在全表里定位当初那条（getSelfHelpData 恒取 [0]，多条在途时可能不是它），且该条仍在、仍集齐（HelpCount >= MaxCount，口径同 produce）。
        // 不能用对象引用比较：push 会重建 _selfHelpList，引用必然失效导致任务被当陈旧丢弃、反复入队却永不领取
        var selfHelp = findSelfHelpByType(alliance.SelfHelpList, task.type);
        if (!selfHelp || selfHelp.HelpCount < selfHelp.MaxCount) return dropStale(task);
        ret = await receiveSelfHelp(selfHelp);
        if (!aliveFn()) return;
        log.info('receive done. code=%d;progress=%s/%s',
            ret.code, selfHelp.HelpCount, selfHelp.MaxCount);
    } else if (task.kind === TASK_APPLY) {
        // 重判：计数通道已同步（防在入队到执行之间才首次同步好）、仍无在途、次数仍未用完（口径同 produce）
        if (!alliance.UpdatedSelfHelp || !isHelpCountSynced(alliance) || alliance.getSelfHelpData() || isQuotaReached(alliance)) return dropStale(task);
        ret = await requestSelfHelp(task.item, task.helpNum);
        if (!aliveFn()) return;
        // 拒绝时解析载荷里的显式文案键：命中 alliance_120503（超过每日上限）才记当日饱和、停止申请；
        // 其他拒绝（如 120501 不属该盟、120504 类型不存在）不记不满、下轮按最新同步状态重判。
        // 拒绝应答不更新本地计数，此标记是防反复撞墙的唯一依据（真机：启动即申请被拒后循环重试）
        if (!ret.ok && rejectErrKey(ret.data) === ERR_ALLIANCE_DAILY_HELP_LIMIT) {
            quotaSaturatedToday = todayStr();
            log.info('server marked daily help limit reached (data=%s), stop applying today.', String(ret.data));
        }
        log.info('apply done. code=%d;item=%s(%d);helpNum=%d',
            ret.code, task.item.name, task.item.id, task.helpNum);
    } else {
        log.warn('unknown task kind, dropped. kind=%s', task.kind);
    }
}

/**
 * 前置条件失效：就地丢弃陈旧任务
 * @param {object} task 被丢弃的任务
 */
function dropStale(task) {
    log.info('task stale, dropped. kind=%s', task.kind);
}

// ─────────────────────────── 发包（只读+发，不改本地数据） ───────────────────────────

/**
 * 发包统一壳：isSending 闸门 → send → 失败打日志 → 返回 Ret。
 * 三个业务发包共用此壳，只在 payload / label 上有差异；ok 后不改本地数据，交给游戏 push 维护。
 * 永不 reject：闸门未放开 / 发送异常都回落到 CODE_NOT_SENT 的哨兵 Ret
 * @param {number} cmd 请求号
 * @param {object} payload 请求载荷
 * @param {string} label 日志前缀（含业务标识，如 apply(itemId=10005)）
 * @returns {Promise<Ret>}
 */
async function guardedSend(cmd, payload, label) {
    if (net.isSending(cmd)) {
        return net.Ret.from(CODE_NOT_SENT, null);
    }
    try {
        var ret = await net.send(cmd, payload);
        if (!ret.ok) {
            log.warn('%s rejected! code=%d', label, ret.code);
        }
        return ret;
    } catch (err) {
        log.warn('%s error!', label, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 帮助所有联盟成员。成功后的本地变更（清列表/计数）交给游戏 push，脚本只发不改。
 * @returns {Promise<Ret>} code=1195 状态码
 */
function helpAll() {
    return guardedSend(CMD_HELP_ALL_ALLIANCE_MEMBERS, { type: HELP_TYPE_ITEM }, 'helpAll');
}

/**
 * 领取已集齐的自助帮助。selfHelp 为空即不发（回哨兵）。
 * @param {object} selfHelp findSelfHelpByType 定位的在途条目（用其 Type）
 * @returns {Promise<Ret>} code=1141 状态码
 */
function receiveSelfHelp(selfHelp) {
    if (!selfHelp) {
        return Promise.resolve(net.Ret.from(CODE_NOT_SENT, null));
    }
    // 领取成功后的删条目/计数由游戏 push 维护；脚本不手动 DeleteSelfHelpList
    return guardedSend(
        CMD_ALLIANCE_HELP_RECEIVE,
        { type: selfHelp.Type, qid: '0' },
        'receive(type=' + selfHelp.Type + ')'
    );
}

/**
 * 申请联盟帮助。item 必须显式传入（cfg.items 之一），不传即 abort——申请次数每日有限，不发糊里糊涂的请求
 * @param {object} item cfg.items 里的物品对象
 * @param {number} helpNum 帮助数量，生产侧传 pickLeastItem 读到的表行 rewards_num
 * @returns {Promise<Ret>} code=1139 状态码
 */
function requestSelfHelp(item, helpNum) {
    if (!item) {
        log.warn('requestSelfHelp aborted: item is required.');
        return Promise.resolve(net.Ret.from(CODE_NOT_SENT, null));
    }
    // 申请成功后的计数/在途条目由游戏 push 维护；脚本不手动 Update
    return guardedSend(
        CMD_ALLIANCE_HELP_APPLY,
        { type: HELP_TYPE_ITEM, itemId: item.id, helpNum: helpNum },
        'apply(itemId=' + item.id + ')'
    );
}

// ─────────────────────────── 生命周期 ───────────────────────────

/**
 * 安装：取网络底座 + 表/数据/表工具。任一依赖缺失即失败（reactor 不会激活）。
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

    var mods = game.requireAll(['TableManager', 'DataCenter', 'TableUtils']);

    table = mods.TableManager
        && mods.TableManager.TABLE
        || missing.push('TableManager');

    data = mods.DataCenter
        && mods.DataCenter.DATA
        || missing.push('DataCenter');

    tableUtils = mods.TableUtils
        && mods.TableUtils.default
        || missing.push('TableUtils');

    if (missing.length) {
        net = null; table = null; data = null; tableUtils = null;
        log.warn('install failed. missing=%s', missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed.');

    return true;
}

/**
 * push 唤醒：联盟帮助数据（含自己自助帮助进度）由游戏 push 写进 _selfHelpList 后，
 * net.recvMine 先跑游戏自己的处理器、再派发到本回调（net.js:212-225），故此刻本地数据已新鲜。
 * 不解析 push 载荷（10446 语义未验证），只把“到达”当作“立即重跑一轮生产”的信号：
 * 用 scheduling(0, runTick) 把下一轮提前到当前宏任务——既避开在游戏入站回调里同步发包的重入，
 * 又靠单定时器语义自然合并频繁 push（多条连到也只抢跑一次）。轮询仍是兜底。
 */
function onHelpUpdate() {
    if (!aliveFn()) return;
    scheduling(0, runTick);
}

/**
 * 运行：订阅自助帮助 push、立刻跑一轮生产，之后按 nextInterval 档位自续。
 * reactor pause 置 alive=false 后定时器自然停摆；resume 重新点火（scheduling 先 clearTimeout 单定时器，不会重复）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    ctx.on.push(PUSH_ALLIANCE_SELF_HELP, onHelpUpdate);
    ctx.on.push(PUSH_ALLIANCE_HELP_REGET, onHelpUpdate);
    scheduling(0, runTick);
    log.info('started.');
}

/**
 * 向 reactor 注册本功能说明书：纯发包（不派行军、不抢队列），不声明 scenes / offInCombat。
 */
reactor.register({
    id: 'allianceHelp',
    label: '联盟帮助',
    storageKey: 'pocketcc.feat.allianceHelp',
    // 无 scenes、无 offInCombat：纯发包（不派行军、不抢队列），全场景 + 战斗态下都继续跑。
    // 面板仅出启用开关；busy/idle/consume 间隔与 items 候选均为上方 cfg 的内置常量，不作为可持久化配置项。
    defaults: { enabled: false },
    fields: [],
    toModuleCfg: function () { return {}; },
    install: install,
    run: run,
});
