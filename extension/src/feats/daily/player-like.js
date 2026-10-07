/**
 * 日常-玩家点赞（reactor 说明书形态）
 *
 * 每人每天可给别人点赞 LIKE_DAILY_MAX(10) 次，两次点赞发送间隔须 ≥5 秒。用户在面板上配一份好友清单
 *   （最多 10 个，动态增删，添加方式同城市技能：UID 复合行 + 失焦用 PLAYER_INFO(630) 反查名字），
 *   功能每天 0 点次数重置后按清单循环逐个点赞，直到当日次数用尽。
 *
 * 网络一律走 promise 封装 window.pocketcc.net：sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>，
 *   isSending(cmd) 查在途。三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net
 *   封装内部固定，这里不再关心。注意：ret.data 可能是原始 JSON 字符串，也可能已是对象，需兜底 parse。
 *
 * 协议（见 references/历史文档/玩家点赞.md）：
 *   req sendPBV2 LIKE_OTHER(3821) {uid:"<字符串>", type:1, instanceIdStr:""}
 *   → 正常 header.s=0；示例给出的是 s=3（超过点赞上限）的错误应答，d 里带 selfTodayCanLikeNum。
 *
 * 计数口径（服务器为真相）：玩家可能与脚本一起点，这 10 次是共享额度。每次应答都读
 *   data.selfTodayCanLikeNum（今日剩余），把「已用 = 上限 - 剩余」钳制区间后落盘并显示（N / 10）；
 *   命中上限（code===LIKE_CODE_LIMIT 或剩余<=0，含成功应答里剩余归零）即直接置满，停到下次重置。
 *   当日已用计数另落 storage 数据 blob（按日期跳日归零），跨页重载不失忆。
 *
 * 触发模型（轮询为主，点赞无专用推送可依赖）：
 *   1) 当日额度未满且有好友 → 发一个赞 → 固定 LIKE_GAP_MS（≥5秒）后点下一个；
 *   2) 额度已满 → 精确排到次日 SystemZeroTime+86400 复查（夹在 idleInterval 兜底防空转）；
 *   3) 清单为空 / 全是空 UID → 降 idleInterval 兜底复查（清单随时会加上）；
 *   4) 被拒 / 异常 → 按阶梯退避（UID 填错等永久性失败不再无限狂发），改配置即清零复活。
 *
 * 调度由 core/cycle.js 提供：单飞闸门、configure 推触合并、异常 fallback 重排均内置；
 *   pause 后 alive()=false，cycle 自然停摆，resume 时 run 重新 kick。当日计数的读盘/落盘单飞闸门与本块无关，保留在 feat 侧。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap，战斗态暂停。
 *   合规：只读 + 发包，绝不改写游戏本地数据（点赞回执由游戏自身经 push 落地）。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';
import { storage } from '../../core/storage.js';
import { bus } from '../../core/bus.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=PLAYER_LIKE） */
const log = createLog('PLAYER_LIKE');

/** @type {number} RequestId.LIKE_OTHER，给某玩家点赞，载荷 {uid,type,instanceIdStr} */
const CMD_LIKE_OTHER = 3821;

/** @type {number} 点赞类型（抓包报文口径，固定 1） */
const LIKE_TYPE = 1;

/** @type {number} 每日可给他人点赞的次数上限 */
const LIKE_DAILY_MAX = 10;

/** @type {number} 超过点赞上限的应答状态码（正常为 0） */
const LIKE_CODE_LIMIT = 3;

/** @type {number} 两次点赞发送的最小间隔（游戏规则：≥5 秒） */
const LIKE_GAP_MS = 1000 * 5;

/** @type {number} 跨日后 0 点重置点的复查余量（毫秒），避免贴着边界秒被服务器判还在今日 */
const CD_BUFFER_MS = 1000 * 5;

/** @type {number} 排程唤醒的最小间隔（毫秒），防 0 延迟忙循环 */
const MIN_WAKE_MS = 1000 * 1;

/** @type {number} 距下次重置的排程硬顶：点赞无 CD、每日 10 次零点重置，重置点必 <24h，故直接睡到下次重置；此顶仅兜住 SystemZeroTime 语义漂移/时钟异常导致的异常超长休眠 */
const MAX_RESET_WAKE_MS = 24 * 3600 * 1000;

/** @type {number} 当日计数持久化到数据 blob 的逻辑键 */
const DAILY_STATE_NAME = 'pocketcc.feat.playerLike.daily';

/** @type {number} 落盘单飞看门狗超时（毫秒）：回执丢失会让闸门永久卡死（之后再也不落盘），到点强制复位 */
const SAVE_STUCK_MS = 1000 * 10;

/** @type {number} 读盘单飞的超时（毫秒）：bridge 回执丢失会让读永远不 settle，到点放开闸门重开一笔读 */
const LOAD_STUCK_MS = 1000 * 8;

/**
 * 失败退避阶梯（毫秒）：连续失败按此递增，末项封顶（=idleInterval，最慢也就 10 分钟再试）。
 * 用途：UID 填错等永久性失败不再无限狂发；改配置（configure）即清零复活。
 * @type {number[]}
 */
const BACKOFF_MS = [1000 * 30, 1000 * 60, 1000 * 180, 1000 * 60 * 10];

/**
 * 内置调优常量（面板仅出启用开关与好友清单，不暴露这些项）
 * @type {object}
 */
const cfg = {

    /** 无可点（清单空/全是空 UID/等待额度重置）时的兜底复查间隔 */
    idleInterval: 1000 * 60 * 10,

    /** 当日计数还没读回盘上数据时的重试间隔：宁可晚几秒开点，也不拿内存初值 0 当账去超点 */
    retryInterval: 1000 * 3,

};

/**
 * 好友清单（由 configure 从面板配置产出）：{uid, name} 数组，name 仅面板展示用
 * @type {Array<{uid:string, name:string}>}
 */
var friends = [];

/** @type {object|null} DataCenter.DATA */
var data;
/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {{count:number, notBeforeMs:number}|null} 失败退避态：连续失败次数 + 下次可重试的墙上时刻(毫秒) */
var failState = null;

/** @type {number} 清单轮转下标：循环清单直到当日额度用尽 */
var cursor = 0;

/** @type {{date:string, used:number}} 当日已用计数（按日期跳日归零，落数据 blob） */
var daily = { date: '', used: 0 };

/** @type {boolean} 当日计数是否已成功从盘上读回（未读回前绝不写盘、也绝不发包，见 tick 闸门） */
var dailyLoaded = false;

/** @type {boolean} 当日计数读盘是否在途（单飞；带 LOAD_STUCK_MS 超时放开） */
var dailyLoading = false;

/** @type {number} 本次读盘开跑时刻（毫秒）：看门狗据此判是否该放开闸门重试 */
var loadStartedAt = 0;

/** @type {number} 读盘世代号：超时放开后迟到的旧回执不得再置 loaded / 覆写内存计数 */
var loadSeq = 0;

/** @type {boolean} 落盘单飞闸门 */
var dailySaving = false;

/** @type {number} 落盘世代号：迟到的旧回执不得去动新一轮的闸门 */
var saveSeq = 0;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

/**
 * 注入模块配置（来自 toModuleCfg）：好友清单 {uid, name}。运行中改动即热更。
 * 任何配置变更都清空失败退避，并 kick cycle 把睡梦中的下一拍提前：否则「先开功能、后加好友」时，
 *   清单为空那一轮已排到 idleInterval（最长 10 分钟）兜底复查，新加的好友要干等到点才开点。
 * 在飞的那一轮由 cycle 内部单飞闸门自动合并（cycle.pending=true → 本轮结束后 tick 返 0 立即补扫）。
 * @param {object} partial {friends:Array<{uid:string, name:string}>}
 * @returns {object} 当前 {friends}
 */
function configure(partial) {
    if (partial && Array.isArray(partial.friends)) {
        friends = partial.friends.slice(0, LIKE_DAILY_MAX).map(function (f) {
            return { uid: f && f.uid != null ? String(f.uid).trim() : '', name: f && f.name ? String(f.name) : '' };
        });
    }
    failState = null;
    cursor = 0;
    if (aliveFn()) cycle.kick();
    return { friends: friends };
}

// ─────────────────────────── 当日计数（按日归零 + 持久化） ───────────────────────────

/**
 * 今日日期串 YYYY-MM-DD，以服务器时钟为准（缺 DataCenter 时回落本地时间）
 * @returns {string}
 */
function todayStr() {
    var d = new Date(((data && data.ServerTime) || 0) * 1000);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 跳日自动归零：服务器日期与持久态不同则 used=0 并落盘。
 * 未成功读回盘上数据前不动内存 date：此时 date='' 必然≠today，照跑会把内存日期抢先改成今天、
 * 却不落盘（persistDaily 有 loaded 闸门），留下 date/used 不一致的半截状态。
 */
function rollDateIfNeeded() {
    if (!dailyLoaded) return;
    var today = todayStr();
    if (daily.date !== today) {
        daily.date = today;
        daily.used = 0;
        persistDaily();
    }
}

/**
 * 当日计数是否已可用（读回成功才算）。未读回前内存那份 used 很可能是初值 0，
 *   既不能拿来写盘（会覆掉盘上真值），也不能拿来判额度（刷新后盘上已点到 7、内存还是 0，
 *   闸门形同虚设 → 每次刷新都会多冲一次赞）。
 * @returns {boolean}
 */
function dailyReady() {
    return dailyLoaded;
}

/**
 * 异步加载持久化的当日计数（单飞；未读回前 tick 会暂缓发包，不拿初值当账）。
 * 读失败不置 loaded：读不到 ≠ 盘上没数据（storage.data.get 在 UID 前缀未设时是 reject），
 *   保留下次重试的机会；未 loaded 期间 persistDaily 会挡住写盘，不会拿内存全 0 覆掉盘上真值。
 * 看门狗：bridge 回执丢失会让读永远不 settle、单飞闸门永久卡住（功能就一直不发），
 *   超时后放开闸门重开一笔读，并用世代号丢弃迟到的旧回执（不得覆写新一轮的内存计数）。
 * @returns {void}
 */
function ensureDailyLoaded() {
    if (dailyLoaded) { rollDateIfNeeded(); return; }
    if (dailyLoading) {
        if (Date.now() - loadStartedAt < LOAD_STUCK_MS) return;
        log.warn('daily state load pending over %dms, reset latch.', LOAD_STUCK_MS);
    }
    var seq = ++loadSeq;
    dailyLoading = true;
    loadStartedAt = Date.now();
    Promise.resolve(storage.data.get(DAILY_STATE_NAME)).then(function (saved) {
        if (seq !== loadSeq) return;          // 迟到的旧回执（看门狗已开新一轮），丢弃
        dailyLoading = false;
        dailyLoaded = true;
        if (saved && typeof saved === 'object' && typeof saved.date === 'string') {
            daily.date = saved.date;
            daily.used = Number(saved.used) || 0;
        }
        rollDateIfNeeded();
        // 读回完成把面板上的 '-' 占位刷成真实计数（ui.refresh 仅在面板打开时扫 DOM，开销可忽略）
        bus.emit('ui.refresh');
    }).catch(function (err) {
        if (seq !== loadSeq) return;
        dailyLoading = false;
        log.warn('daily state load failed, will retry on next tick. %s', err && err.message);
    });
}

/**
 * 保存当日计数（单飞：上一次未写完时不叠加，后续修改会合并到下一笔写入）。两道保险：
 *   1) 未成功读回盘上数据前绝不写盘——内存这份 used 很可能是 0，整块写回会把盘上真值覆掉；
 *   2) 单飞闸门带看门狗——写入靠 bridge 回执落定，回执丢失会让闸门永久卡死（之后再也不落盘），
 *      超时强制复位，后续修改照常重试。
 */
function persistDaily() {
    if (dailySaving) return;
    if (!dailyLoaded) {
        log.warn('skip daily state save: disk state not loaded yet (in-memory used is not authoritative).');
        return;
    }
    dailySaving = true;
    var seq = ++saveSeq;
    var snapshot = { date: daily.date, used: daily.used | 0 };
    var watchdog = setTimeout(function () {
        log.warn('daily state save pending over %dms, reset latch.', SAVE_STUCK_MS);
        releaseSaveLatch(seq);
    }, SAVE_STUCK_MS);
    Promise.resolve(storage.data.set(DAILY_STATE_NAME, snapshot)).catch(function (err) {
        log.warn('daily state save failed.', err);
    }).then(function () {
        clearTimeout(watchdog);
        releaseSaveLatch(seq);
    });
}

/**
 * 释放落盘单飞闸门（带世代校验）：看门狗已复位且被新一轮接管后，迟到的旧回执不得再去动新那笔的闸门。
 * @param {number} seq 本次写入的世代号
 */
function releaseSaveLatch(seq) {
    if (seq !== saveSeq) return;
    dailySaving = false;
}

/**
 * 用服务器口径同步当日已用次数：max(本地, 上限-剩余)，玩家手动点掉的那几次也一并计入。
 * 纯展示记账，永不越界 [0, LIKE_DAILY_MAX]；值真变了才落盘 + 推面板刷新。
 * @param {number} remaining 应答里的 selfTodayCanLikeNum（今日剩余）
 * @returns {void}
 */
function syncUsedFromServer(remaining) {
    rollDateIfNeeded();
    var used = Math.min(Math.max(LIKE_DAILY_MAX - remaining, 0), LIKE_DAILY_MAX);
    if (used <= daily.used) return;
    daily.used = used;
    persistDaily();
    bus.emit('ui.refresh');
}

/**
 * 本地 +1 兜底：成功应答里带不出 selfTodayCanLikeNum 时用它保证「已用」单调递增、循环终能停在 10，
 *   不至于每 5 秒狂发到永远不满足的额度条件。仍取 max 与服务器口径并存的那份更大值。
 * @returns {void}
 */
function bumpLocalUsed() {
    rollDateIfNeeded();
    if (daily.used >= LIKE_DAILY_MAX) return;
    daily.used = (daily.used | 0) + 1;
    persistDaily();
    bus.emit('ui.refresh');
}

/**
 * 当日额度直接置满（命中上限错误时用）：额度是共享的，玩家可能已经点掉了其余次数，
 *   游戏不保证服务器还会把剩余次数报回来，见错即认账，不再去猜具体数字。
 * @returns {void}
 */
function markUsedUp() {
    rollDateIfNeeded();
    if (daily.used >= LIKE_DAILY_MAX) return;
    daily.used = LIKE_DAILY_MAX;
    persistDaily();
    bus.emit('ui.refresh');
}

/**
 * 当前面板展示的「今日已赞」文本：N / 10。
 * 纯展示函数：不触发日期改写与落盘；未读回时借这次渲染补发一次加载并显示占位符。
 * @returns {string}
 */
function formatToday() {
    if (!dailyLoaded) {
        ensureDailyLoaded();
        return '-';
    }
    return (daily.used | 0) + ' / ' + LIKE_DAILY_MAX;
}

// ─────────────────────────── 调度 ───────────────────────────

/**
 * 距下次每日重置（SystemZeroTime+86400）的毫秒数；取不到重置点时回 idleInterval。
 * 用 serverSec 与墙上 now 的差值换算，规避客户端时钟漂移。
 * @returns {number}
 */
function msToNextReset() {
    var serverSec = (data && data.ServerTime) || 0;
    var zero = data && data.UserData && data.UserData.SystemZeroTime;
    if (!serverSec || !zero) return cfg.idleInterval;
    var ms = (zero + 86400 - serverSec) * 1000 + CD_BUFFER_MS;
    if (!(ms > 0)) return cfg.idleInterval;
    return Math.min(ms, MAX_RESET_WAKE_MS);
}

// (cycle 直接接 tick()) —— 旧 单定时器武装器 schedule(delay) 已删

// ─────────────────────────── 发包 ───────────────────────────

/**
 * 字符串载荷尝试 JSON.parse；非串或失败原样返回
 * @param {*} s 原值
 * @returns {*} 解析结果
 */
function parseMaybe(s) {
    if (typeof s !== 'string' || !s) return s;
    try { return JSON.parse(s); } catch (err) { return s; }
}

/**
 * 给一个好友点赞（3821）。永不 reject；返回结果状态，供 tick 决定节奏/退避/置满。
 * isSending 去重闸门：3821 在途时返回 'inflight'（瞬态，不计失败退避）。
 * 只要应答带得出 selfTodayCanLikeNum 就先按它同步计数（成功/被拒都同步，服务器口径优先）。
 * @param {string} uid 目标玩家 UID
 * @returns {Promise<'ok'|'limit'|'rejected'|'error'|'inflight'>} 点赞结果状态
 */
async function sendLike(uid) {
    if (net.isSending(CMD_LIKE_OTHER)) {
        log.debug('skip like: 3821 in flight. uid=%s', uid);
        return 'inflight';
    }
    try {
        var ret = await net.sendPBV2(CMD_LIKE_OTHER, { uid: String(uid), type: LIKE_TYPE, instanceIdStr: '' });
        var d = parseMaybe(ret.data) || {};
        var remain = Number(d.selfTodayCanLikeNum);
        if (ret.ok && !isFinite(remain)) bumpLocalUsed();   // 成功但服务器没回报剩余：本地 +1 兜住进度
        else if (isFinite(remain)) syncUsedFromServer(remain);
        if (ret.ok) {
            if (isFinite(remain) && remain <= 0) {
                markUsedUp();
                log.info('like accepted but no times left today, stop till reset. uid=%s', uid);
                return 'limit';
            }
            failState = null;
            log.info('like ok. uid=%s%s', uid, isFinite(remain) ? ';selfTodayCanLikeNum=' + remain : '');
            return 'ok';
        }
        if (ret.code === LIKE_CODE_LIMIT) {
            markUsedUp();
            log.info('like daily limit reached, stop till reset. uid=%s;selfTodayCanLikeNum=%s', uid, d.selfTodayCanLikeNum);
            return 'limit';
        }
        log.info('like rejected. uid=%s;code=%d', uid, ret.code);
        return 'rejected';
    } catch (err) {
        log.warn('like error.', err);
        return 'error';
    }
}

/**
 * 记一次失败并推后退避：连续失败次数 +1，按 BACKOFF_MS 阶梯取下次可重试的墙上时刻（末项封顶）。
 * @returns {number} 下次可重试的墙上时刻(毫秒)
 */
function bumpFail() {
    var fs = failState || (failState = { count: 0, notBeforeMs: 0 });
    fs.count++;
    var idx = Math.min(fs.count - 1, BACKOFF_MS.length - 1);
    fs.notBeforeMs = Date.now() + BACKOFF_MS[idx];
    return fs.notBeforeMs;
}

// ─────────────────────────── 检查 + 点赞 ───────────────────────────

/**
 * cycle 单轮：跳日归零 → 判额度/清单/退避 → 给轮转到的好友发一个赞 → 按结果返回下拍 delay。
 * 异常不会报出：sendLike/bumpFail 都已自堆；cycle 另兜一层 fallback(idle) 作为防御护栏。
 * @returns {Promise<number>} 下拍 delay（毫秒）；0 = 立即再跑（alive=false 或 pending 补扫）。
 */
async function tick() {
    ensureDailyLoaded();
    rollDateIfNeeded();
    if (!aliveFn()) return 0;

    // 清单为空（或全是空 UID）：本轮不点，降 idle 兜底复查（清单随时会加上）
    var hasUid = false;
    for (var i = 0; i < friends.length; i++) {
        if (friends[i] && friends[i].uid) { hasUid = true; break; }
    }
    if (!hasUid) return cfg.idleInterval;

    // 当日计数读盘闸门：未读回前 daily.used 还是内存初值，拿去判额度形同虚设
    //（刷新后盘上已点到 7、内存 0 → 每次刷新都会多冲一次赞），暂缓发包并短间隔重试
    if (!dailyReady()) {
        log.debug('hold like: daily state not loaded from disk yet (memory used is not authoritative).');
        return cfg.retryInterval;
    }

    // 当日额度已用尽（含玩家自己点掉的）：无 CD、零点重置，直接睡到下次重置（醒后 rollDateIfNeeded 归零），不再每 10min 提前醒重复轮询
    if (daily.used >= LIKE_DAILY_MAX) {
        log.debug('daily like quota used (%d/%d), sleep to next reset.', daily.used, LIKE_DAILY_MAX);
        return msToNextReset();
    }

    // 退避闸门：上次失败后未到重试点，本轮不碰
    var now = Date.now();
    if (failState && now < failState.notBeforeMs) {
        return Math.min(failState.notBeforeMs - now, cfg.idleInterval);
    }

    // 轮转取下一个有 UID 的好友（清单一律以面板配置为准，cursor 只决定起点）
    var idx = -1;
    for (var j = 0; j < friends.length; j++) {
        var k = (cursor + j) % friends.length;
        if (friends[k] && friends[k].uid) { idx = k; break; }
    }
    if (idx < 0) return cfg.idleInterval;
    cursor = (idx + 1) % friends.length;

    var r = await sendLike(friends[idx].uid);
    if (!aliveFn()) return 0;
    if (cycle.pending) return 0;   // 本轮在飞时又触发了 configure→立即补扫

    switch (r) {
        case 'ok': return LIKE_GAP_MS;
        case 'limit': return msToNextReset();
        case 'inflight':
            // 同一次点赞的应答还在途（多半是游戏自己在发）：等满最小唤醒间隔再来看结果，不计失败退避
            return MIN_WAKE_MS;
        default: {
            // rejected / error：按阶梯退避（UID 填错等永久性失败不再无限狂发）
            var retryAt = bumpFail();
            var wait = Math.max(0, retryAt - Date.now());
            log.warn('like failed, backoff %dms.', wait);
            return Math.min(wait, cfg.idleInterval);
        }
    }
}

const cycle = createCycle({ log: log, alive: aliveFn, run: tick, fallback: cfg.idleInterval });

// ─────────────────────────── 生命周期 ───────────────────────────

/**
 * 安装：取网络底座 + 数据中心（必需）。必需依赖缺失即失败（reactor 不会激活）。
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

    var mods = game.requireAll(['DataCenter']);

    data = mods.DataCenter
        && mods.DataCenter.DATA
        || missing.push('DataCenter');

    if (missing.length) {
        net = null; data = null;
        log.warn('install failed. missing=%s', missing.join(';'));
        return false;
    }

    installed = true;
    log.info('installed.');

    return true;
}

/**
 * 运行：复位闸门与轮转下标，读回当日计数后立即跑一轮（之后由 5 秒节奏 / 重置点 / 退避驱动）。
 * reactor pause 会自动摘除此处登记的触发器并置 alive=false，定时器自然停摆；resume 重新点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    cursor = 0;
    failState = null;
    ensureDailyLoaded();
    // 计数不在这里打：读盘异步、此刻 daily.used 仍是初值，报了会误导；真实额度首 tick 闸门自会核
    log.info('started, %d friend(s).', friends.length);
    // 启动即查一次；本轮结束后 tick 末尾按节奏 / 重置点 / idle 返给 cycle arm
    cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：scenes 限定 Home/NWorldMap，战斗态暂停（offInCombat）。
 */
reactor.register({
    id: 'playerLike',
    label: '玩家点赞',
    storageKey: 'pocketcc.feat.playerLike',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: {
        enabled: false,
        friends: [],
    },
    fields: [
        { key: 'friends', label: '好友清单', type: 'uidlist', max: LIKE_DAILY_MAX, placeholder: '请输入玩家UID', hint: '每天 0 点重置后按清单逐个点赞，每日共 ' + LIKE_DAILY_MAX + ' 次、间隔 5 秒' },
        { key: 'todayLike', label: '今日已赞', type: 'text', get: function () { return formatToday(); } },
    ],
    toModuleCfg: function (c) {
        return { friends: c.friends };
    },
    install: install,
    configure: configure,
    run: run,
});
