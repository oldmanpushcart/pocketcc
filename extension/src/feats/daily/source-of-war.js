/**
 * 战争之源-自动攻打（Source of War / WorldBossV2，reactor 说明书形态）
 *
 * 战争之源是世界地图上的全服共享 PvE 世界 BOSS（世界 BOSS 二期改造，代码代号 SOW）：
 * 每日固定时段刷出，按「陆 / 海 / 空」三形态轮替，所有人派兵打单次最高伤害排名。
 * 本功能在各刷新窗口内自动派兵攻打，三形态可各自选用不同的预设部队（1-8），每天定额攻打 5 次。
 *
 * 命名与换代（详见 references/游戏逆向/战争之源模块分析报告.md）：
 *   总开关 UserData.bossV2Open（push 21922）为真时走 SOW 新链路，行军类型
 *   NMarchType.ATTACK_WORLD_BOSS_V2 = 298，经 MARCH_WORLD_POINT(902) 派遣；旧链路（=false）用 14。
 *   本功能只在 SOW 生效时工作——非二期时 GET_BOSS_INFO_V2(9956) 无有效应答，自然空转。
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 * 两条协议（均为旧 JSON NET.send）：
 *   1) req send 9956（GET_BOSS_INFO_V2）{} → resp（data 为 JSON 串，需 parse）：
 *      {reason, finishTime, alive, bossId, x, y, lv, id, power, initPower, pveId, costEnergy}；
 *      `alive=1` 才是「当前有可打 BOSS」的权威信号（非窗口期/目标已消失时 alive 不为 1，上一版只看 bossId 会拿到残留 id 误打），
 *      `reason>0` 跨服战期禁止攻打；`id`(spawn)/`finishTime` 为本波起止（服务器毫秒，实证单波 2 小时）；`costEnergy` 为每次体力消耗（实证=5）；
 *      形态 type 应答不带，仍从 BOSS 表读；坐标 x,y 为 902 目标。
 *   2) req send 902（MARCH_WORLD_POINT）{marchType:298,x,y,armyList...} → 派该预设部队攻打。
 *      载荷构造与「快捷攻击」同源：Battle().plan().preset(1..8).build() 出部队数据（见 utils/battle.js）。
 *
 * 调度（不轮询）：分两段——
 *   在场期间（上次 9956 回 alive=1）：以回包 finishTime 为在场截止（liveUntil），每 TICK_INTERVAL 慢扫一次并尝试补一派，
 *     直到打满当日额度或过 finishTime（不再依赖本地窗口表——其 life_time 推导不可靠，会把 2 小时长窗口误算成短窗口而睡过）；
 *     tick 只是兜底节奏；另订阅本人行军推送 10019（USER_MARCH_INFO），只认 state===4（ARRIVED_HOME 回城）那一条，
 *     在场窗口内上一队一回到家就立即补扫补派（非回城状态的推送忽略，多条回城推送按 PUSH_SCAN_MIN_GAP 合并），不等下一个 tick；补扫不满足出征条件则自然跳过、回落 tick；
 *   不在场时：靠本地推导的确定性日程排睡——窗口起 = SystemZeroTime + 3600 * DataConfig[82000003] 各小时点，
 *     未到窗口 → 睡到「窗口起点 + WARMUP_DELAY(5 分钟)」再开扫；当日窗口跑完 → 睡到次日零点后重算。
 *   无论哪段，真正攻打与否只由 9956 回包 alive 决定（fail-closed）；配置取不到时退化为同节奏的兜底定时，不静默停摆。
 *
 * 每日定额：DAILY_LIMIT = 5 次，跨所有窗口累计（不分形态、不分时段）。客户端不校验每日次数上限
 *   （旧链路的 919 + DataConfig 15001 只存在于 WorldBossDetailPanel，SOW 新弹窗没有这段），
 *   故自行计数并持久化到 storage.data（跳日自动归零）。打满即整日不再攻打，也不再排扫描。
 *
 * BOSS 形态来自配置表 BOSS[bossId].type：0=陆军 / 1=海军 / 2=空军（banner 数组 [army,ocean,air][type] 实证），
 *   据此从面板配置的 presets[type] 取该形态的预设部队号（0=不攻打该形态）。
 *
 * 攻打前闸门（口径同游戏 WorldSOWBossBuildPop.onClickAtkBtn）：
 *   在场：9956 回包 alive=1（requestBoss 内拦，非在场不往下走）；等级：UserData.Level >= BOSS.player_level；
 *   体力：getEnergy(Action=1).Point >= 应答 costEnergy（兜底 BOSS 表/DEFAULT_COST_ENERGY）；
 *   行军槽：myMarchNumMAX - myMarchNum >= 1；9956 / 902 在途去重（isSending）；当日额度未打满。
 *   允许对同一 BOSS 连续派多队（多队同时攻打本就是该玩法核心），故不做「目标已占位」去重。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap，战斗模式暂停。
 *   单一在飞闸门 scanning 防重入；pause 后 alive()=false 让定时器到点空转、在飞流程自然退出，resume 重新排程。
 *
 * 攻击次数奖励（同面板三箱，本功能一并自动领取）：
 *   档位表 DataConfig[82000001]（"1|道具;3|道具;5|道具"，取每段首数字为攻打次数门槛，共 3 档）；
 *   req sendPBV2 9952（WORLD_BOSS_V2_CLAIM_ATTACK_COUNT_REWARD）{attackCount:门槛} → pbAckV2.data={attackCount,reward}。
 *   领取判定全走本地（口径同游戏 PrefabActivitySourceOfWar.onClickBox）：UserData.attackBossCnt >= 门槛 且
 *   门槛不在 UserData.worldBossV2ClaimedAttackCountRewardIds 里才发 9952；领成功即镜像并入已领集合，零额外查询。
 *   另订阅 push 21923（WORLD_BOSS_V2_ATTACK_COUNT_UPDATE，{attackCount, claimedAttackCountRewardList} 覆写态）
 *   与 21924（WORLD_BOSS_V2_DAY_RESET 每日重置）即时刷新镜像并即时补领；21923 未推时靠攻打成功点与兜底轮询驱动。
 *   每日只能领 1 轮共 3 个：3 个全领完 → 今日收摊不再为该事轮询（睡到次日）；还有未达标档位 → 每 CLAIM_POLL_INTERVAL 兜底轮询一次。
 */
import { createLog } from '../../core/log.js';
import { bus } from '../../core/bus.js';
import { game } from '../../core/game.js';
import { storage } from '../../core/storage.js';
import { l10n, gameConf } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../utils/battle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SOURCE-OF-WAR） */
const log = createLog('SOURCE-OF-WAR');

/** @type {number} RequestId.GET_BOSS_INFO_V2，查询当前战争之源 BOSS（旧 JSON send）→ {bossId,id,x,y,reason} */
const CMD_GET_BOSS_INFO_V2 = 9956;

/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；攻打 BOSS_V2 用 marchType=298 */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {number} push USER_MARCH_INFO：本人行军状态更新（含到/回城 ARRIVED_HOME），作「回城即补派」的唤醒信号 */
const PUSH_USER_MARCH_INFO = 10019;

/**
 * push WORLD_BOSS_V2_ATTACK_COUNT_UPDATE：今日攻打次数 + 已领档位列表整体覆写
 * 定义：NResponseIdV2（游戏 PushResponse 同款 Handler：updateAttackBossCnt + updateWorldBossV2ClaimedAttackCountRewardIds(全量)）
 * @type {number}
 */
const PUSH_SOW_ATTACK_COUNT_UPDATE = 21923;

/** @type {number} push WORLD_BOSS_V2_DAY_RESET：每日重置（攻打计数归零、已领清空），唤醒重判 */
const PUSH_SOW_DAY_RESET = 21924;

/**
 * 攻击次数奖励领取（sendPBV2）：请求 {attackCount:门槛}，应答 data={attackCount,reward}。
 * 定义：NRequestIdV2.WORLD_BOSS_V2_CLAIM_ATTACK_COUNT_REWARD = 9952（真机录像实证 1/3/5 三档逐个发出）
 * @type {number}
 */
const CMD_CLAIM_ATTACK_REWARD = 9952;

/** @type {number} DataConfig：攻击次数奖励档位表 "门槛|道具;门槛|道具;门槛|道具"（游戏面板同键取法） */
const CFG_KEY_REWARD_TIERS = 82000001;

/** @type {number} 奖励兜底轮询间隔（毫秒）：本会话还有可领/待领档位但未搭到攻打点时的低频复查 */
const CLAIM_POLL_INTERVAL = 1000 * 60 * 10;

/**
 * 行军状态：ARRIVED_HOME（部队已回到家、重新可派）。
 * 定义：NMarchState（subpack2/NWorldMapMarchCommon）：INIT0/MARCHING1/ARRIVED2/RETURNING3/ARRIVED_HOME4…
 * 10019 在出发/到达/返程都会推，只有 state===4 才是「回城可再派」，其余状态补扫只会空跑。
 * @type {number}
 */
const MARCH_STATE_ARRIVED_HOME = 4;

/**
 * 行军类型：ATTACK_WORLD_BOSS_V2（战争之源二期世界 BOSS）
 * 定义：NMarchType.ATTACK_WORLD_BOSS_V2 = 298（WorldMapCommon / NWorldMapMarchCommon 枚举）
 * PvE 世界 BOSS 不参与跨服攻玩家城的 marchType 漂移（march.resolve 只换 attackPlayer），故直接用固定值。
 * @type {number}
 */
const MARCH_TYPE = 298;

/** @type {number} EnergyType.Action（GameDefine：e[e.Action=1]），攻打消耗的体力类型 */
const ENERGY_ACTION = 1;

/**
 * BOSS 形态数（0陆/1海/2空），与面板三个预设选择器一一对应
 * @type {number}
 */
const FORM_COUNT = 3;

/** @type {number} DataConfig：每日刷新小时点 "h1|h2|..."（相对系统日零点的小时偏移） */
const CFG_KEY_HOURS = 82000003;

/** @type {number} DataConfig：BOSS 存在时长（秒）所在配置表字段 */
const BOSS_LIFE_FIELD = 'life_time';

/**
 * BOSS 存在时长兜底值（秒）：仅供本地窗口表排程粗估用（在场期间实际排程由 9956 回包 finishTime 驱动）。
 * 实证单波 BOSS 可长达 2 小时（id 与 finishTime 差 7200000ms）；此兜底值只在无回包 finishTime 且 BOSS 表 life_time 读不到时生效。
 * @type {number}
 */
const DEFAULT_LIFE = 60 * 30;

/** @type {number} 每天攻打总次数上限（跨所有窗口累计，打满即收工） */
const DAILY_LIMIT = 5;

/** @type {number} 窗口起点后延迟开扫（毫秒）：起始扫描错开刷新瞬间，默认 5 分钟 */
const WARMUP_DELAY = 1000 * 60 * 5;

/** @type {number} 窗口内的慢扫间隔（毫秒）：只查 9956 + 尝试补一派，默认 3 分钟 */
const TICK_INTERVAL = 1000 * 60 * 3;

/** @type {number} 回城推送补扫的最小间隔（毫秒）：合并一场行军的多条 10019 状态推送，避免 9956 突发 */
const PUSH_SCAN_MIN_GAP = 1000 * 5;

/** @type {number} 跨日重排余量（毫秒）：零点后半小时再看当日日程，避开零点数据未就绪 */
const DAY_ROLL_BUFFER = 1000 * 60 * 30;

/** @type {number} 非服务器返回的哨兵 code（预留，与真实 s 码区分） */
const CODE_NOT_SENT = -1;

/**
 * 攻打一次战争之源的体力消耗兜底值（最后兜底）。
 * 实证优先取 9956 应答的 costEnergy（普遍=5），其次 BOSS 表 cost_energy；两者都取不到才用此值。
 * @type {number}
 */
const DEFAULT_COST_ENERGY = 5;

/**
 * 体力不足的应答 data 键集合（字典表实证四键均=「体力不足」）。
 * 服务器攻打拒绝（应答 code≠0）里 data 命中其一即判定体力不足 → 放弃本轮、不扣当日额度。
 * @type {string[]}
 */
const ENERGY_SHORT_KEYS = ['100182', 'army_123560', 'world_130507', 'battle_121508'];

/** @type {string} storage.data 分片名：当日攻打计数持久态 */
const DAILY_STATE_NAME = 'sourceOfWar.daily';

/**
 * 三形态各选的预设部队号：index = BOSS.type（0陆/1海/2空），value = 预设队号 1-8，0=不攻打该形态
 * @type {number[]}
 */
var presets = [0, 0, 0];

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（读 UserData 等级/体力/行军槽/系统零点/服务器时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {boolean} 扫描在飞闸门（含 9956 await），防并发进入 */
var scanning = false;
/**
 * 当前在场 BOSS 的消失时刻（服务器秒）：由 9956 回包 finishTime 驱动。
 * now < liveUntil 表示已知 BOSS 在场，排程按 tick 慢扫而非依赖本地窗口表；无在场 BOSS 置 0。
 * @type {number}
 */
var liveUntil = 0;
/** @type {number|null} 排程定时器（窗口睡眠 / 窗口内慢扫共用一个）；pause 后到点空转不再自重排 */
var scanTimer = null;
/** @type {number} 上次因行军回城推送补扫的墙钟时刻（毫秒），用于合并突发 */
var lastPushScanAt = 0;

/**
 * 当日攻打计数持久态：{ date:'YYYY-MM-DD', count:number }。
 * 读回完成前不落盘（内存 0 很可能是假象，整块写回会覆掉盘上真值），见 persistDaily。
 * @type {{date:string, count:number}}
 */
var dailyState = { date: '', count: 0 };
/** @type {boolean} 持久态是否已读回 */
var dailyStateLoaded = false;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

// ── 当日定额 ──────────────────────────────────────────────────────────
/**
 * 今日日期字符串 YYYY-MM-DD（当地时区，与面板展示一致）
 * @returns {string}
 */
function todayStr() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 当日剩余攻打额度（未读回盘上数据前按 0 已攻打处理，最坏是多打几次，不会漏打）
 * @returns {number}
 */
function quotaLeft() {
    if (dailyState.date !== todayStr()) return DAILY_LIMIT;   // 跳日归零（读回回调里也会整体覆写）
    return Math.max(0, DAILY_LIMIT - (dailyState.count | 0));
}

/**
 * 异步读回当日计数（每轮 run 调一次）。读失败不置 loaded：读不到 ≠ 盘上没数据，留给下次 run 重试。
 * @returns {Promise<void>}
 */
async function loadDaily() {
    try {
        var saved = await storage.data.get(DAILY_STATE_NAME);
        dailyStateLoaded = true;
        if (saved && typeof saved === 'object' && saved.date === todayStr()) {
            dailyState.date = saved.date;
            dailyState.count = saved.count | 0;
        } else {
            dailyState.date = todayStr();
            dailyState.count = 0;
        }
    } catch (err) {
        log.warn('daily state load failed, retry next run. %s', err && err.message);
    }
}

/**
 * 攻打成功后计数 +1 并落盘（写失败不阻断主流程），顺带推面板刷新今日计数
 */
function bumpDailyCount() {
    if (dailyState.date !== todayStr()) {
        dailyState.date = todayStr();
        dailyState.count = 0;
    }
    dailyState.count = (dailyState.count | 0) + 1;
    if (dailyStateLoaded) {
        Promise.resolve(storage.data.set(DAILY_STATE_NAME, { date: dailyState.date, count: dailyState.count }))
            .catch(function (err) { log.warn('daily state save failed.', err); });
    }
    bus.emit('ui.refresh');
}

/**
 * 面板展示的「今日已攻打」：N / 上限。纯展示函数，未读回时显示占位符。
 * @returns {string}
 */
function formatToday() {
    if (!dailyStateLoaded) return '-';
    return (dailyState.count | 0) + ' / ' + DAILY_LIMIT;
}

/**
 * 面板展示的「次数奖励」：已领 / 总档位（纯本地读 UserData，不发请求）；档位表不可用显占位符。
 * @returns {string}
 */
function formatRewardToday() {
    var tiers = rewardTiers();
    if (!tiers) return '-';
    var claimed = claimedIdsNow();
    var n = 0;
    for (var i = 0; i < tiers.length; i++) {
        if (claimed.indexOf(tiers[i]) !== -1) n++;
    }
    return n + ' / ' + tiers.length;
}

// ── 攻击次数奖励 ──────────────────────────────────────────────────────
/**
 * 本地镜像的攻打计数（仅 UserData.attackBossCnt 读不到时兜底）：
 * 由 push 21923 覆写与 9952 领成后的应答同步，不另发查询。
 * @type {number}
 */
var sowAttackCnt = 0;
/**
 * 本地镜像的已领档位集合（仅 UserData.worldBossV2ClaimedAttackCountRewardIds 读不到时兜底），元素为门槛数字。
 * @type {number[]}
 */
var sowClaimedIds = [];

/**
 * 攻打次数门槛档位表：DataConfig[82000001] "门槛|道具;门槛|道具;…" 取每段首数字，升序去重。
 * 每次现读不缓存（配置随登录刷新）；读不到/格式不合返 null，调用方 fail-closed 不盲发领取。
 * @returns {number[]|null} 如 [1,3,5]；不可用返回 null
 */
function rewardTiers() {
    var raw = gameConf.dataConfig(CFG_KEY_REWARD_TIERS);
    var parts = String(raw == null ? '' : raw).split(';').filter(function (s) { return s; });
    if (!parts.length) return null;
    var tiers = [];
    for (var i = 0; i < parts.length; i++) {
        var n = Number(String(parts[i]).split('|')[0]);
        if (isFinite(n) && n > 0 && tiers.indexOf(n) === -1) tiers.push(n);
    }
    if (!tiers.length) return null;
    return tiers.sort(function (a, b) { return a - b; });
}

/**
 * 读当前累计攻打次数：权威源是游戏 UserData.attackBossCnt（push 21923 会直接更新它，热 getter 随读随新），
 * 字段未初始化（缺失/非数字）时回退本地镜像。注意读到 0 是合法值（今日未攻打），只有读不到才兜底。
 * @returns {number}
 */
function attackCountNow() {
    var v = dataCenter && dataCenter.UserData && dataCenter.UserData.attackBossCnt;
    return (typeof v === 'number' && isFinite(v)) ? v : sowAttackCnt;
}

/**
 * 读已领档位列表：同样优先 UserData（push 21923 / 领成功应答都会写回），取不到回退镜像。
 * @returns {number[]}
 */
function claimedIdsNow() {
    var v = dataCenter && dataCenter.UserData && dataCenter.UserData.worldBossV2ClaimedAttackCountRewardIds;
    return Array.isArray(v) ? v : sowClaimedIds;
}

/**
 * 同步本地镜像（push 21923 载荷 / 9952 领成后的档位）：UserData 会由游戏自身处理器更新，
 * 镜像只作读不到字段时的兜底，不反向写游戏数据（feat 脚本只读 + 发包红线）。
 * @param {number} [count] 新的累计攻打次数（缺省不动）
 * @param {number[]} [claimed] 新的已领全量列表（缺省不动）
 */
function syncClaimMirror(count, claimed) {
    if (typeof count === 'number' && isFinite(count)) sowAttackCnt = count;
    if (Array.isArray(claimed)) {
        sowClaimedIds = claimed.map(function (x) { return Number(x); }).filter(function (x) { return isFinite(x); });
    }
}

/**
 * 待领档位：达标（attackBossCnt >= 门槛）且未领。纯本地判断，不发任何请求。
 * 档位表不可用时返回 null（无法判定，调用方不盲发）。
 * @returns {number[]|null}
 */
function pendingTiers() {
    var tiers = rewardTiers();
    if (!tiers) return null;
    var cnt = attackCountNow();
    var claimed = claimedIdsNow();
    return tiers.filter(function (t) { return cnt >= t && claimed.indexOf(t) === -1; });
}

/**
 * 奖励是否已全部领完：档位表可用且每个档位都已领。未达标不算领完（返回 false 继续等）。
 * @returns {boolean}
 */
function claimAllDone() {
    var tiers = rewardTiers();
    if (!tiers) return false;
    var claimed = claimedIdsNow();
    for (var i = 0; i < tiers.length; i++) {
        if (claimed.indexOf(tiers[i]) === -1) return false;
    }
    return true;
}

/**
 * 领一轮攻击次数奖励：本地发现有待领档位才逐个发 9952（同面板点箱链路）。
 * 单个领成即并入镜像、刷新面板；被拒/异常只记日志继续下一档（档位间互不依赖，不因此放弃其余）。
 * 永不 reject。
 * @returns {Promise<void>}
 */
async function claimAttackRewards() {
    var pend = pendingTiers();
    if (!pend || !pend.length) return;
    if (net.isSending(CMD_CLAIM_ATTACK_REWARD)) return;
    var changed = false;
    for (var i = 0; i < pend.length; i++) {
        var tier = pend[i];
        var ret;
        try {
            ret = await net.sendPBV2(CMD_CLAIM_ATTACK_REWARD, { attackCount: tier });
        } catch (err) {
            log.warn('claim send error. tier=%d', tier, err);
            break;   // 链路异常（超时/断线）不再续发，留给下次唤醒/轮询
        }
        if (!aliveFn()) return;
        if (ret.ok) {
            // 应答 data.attackCount 即所领档位（口径同游戏成功后 updateWorldBossV2ClaimedAttackCountRewardIds）
            var claimedId = (ret.data && Number(ret.data.attackCount)) || tier;
            if (sowClaimedIds.indexOf(claimedId) === -1) sowClaimedIds.push(claimedId);
            changed = true;
            log.info('claim reward ok. tier=%d', claimedId);
        } else {
            log.warn('claim reward rejected. tier=%d;code=%d;data=%s', tier, ret.code, ret.data);
        }
    }
    if (changed) bus.emit('ui.refresh');
}

/**
 * push 21923/21924 回调：游戏处理器已把计数/已领列表写回 UserData，这里只同步镜像并即时补领，
 * 不另查询。21924（每日重置）载荷无计数字段，不覆写镜像，下轮重读 UserData 自然归零。
 * @param {object} ev net 推送事件（PB 推送的 data 已由桥接层解析为对象）
 */
function onSowCountUpdate(ev) {
    if (!aliveFn()) return;
    var d = ev && ev.data;
    if (d && typeof d.attackCount === 'number') {
        syncClaimMirror(d.attackCount, d.claimedAttackCountRewardList);
    }
    claimAttackRewards().catch(function (err) { log.warn('claim flow threw.', err); });
}

// ── 窗口排表 ──────────────────────────────────────────────────────────
/**
 * 当日 BOSS 刷新窗口表：起 = SystemZeroTime + 3600*小时点，止 = 起 + BOSS.life_time。
 * 口径与游戏活动面板 setupDisplay / 地图弹窗 reBuildBossTimeTable / 图标 checkBossCanAttack 三处一致。
 * life_time 各小时点可能不同（取决于该槽刷出的 bossId），这里取白名单里第一个可用 BOSS 行的值；
 * 取不到时长时按窗口无限长处理（由 9956 的「有没有 BOSS」实际兜底）。
 * @returns {Array<{start:number, end:number}>|null} 升序窗口表；配置不可用返回 null（调用方走兜底定时）
 */
function buildWindows() {
    var zero = +(dataCenter && dataCenter.UserData && dataCenter.UserData.SystemZeroTime) || 0;
    var now = +(dataCenter && dataCenter.ServerTime) || 0;
    if (!zero || !now) return null;

    var raw = gameConf.dataConfig(CFG_KEY_HOURS);
    var hours = String(raw == null ? '' : raw).split('|')
        .map(function (h) { return parseInt(h, 10); })
        .filter(function (h) { return isFinite(h); })
        .sort(function (a, b) { return a - b; });
    if (!hours.length) return null;

    var windows = hours.map(function (h) {
        var start = zero + 3600 * h;
        return { start: start, end: start + bossLifeSeconds() };
    });
    // 已过完的今天窗口不留（否则"下一窗口"会指向过去的槽）；全过完则由调用方推到晚点后重算
    return windows.filter(function (w) { return w.end > now; });
}

/**
 * BOSS 存在时长兜底值（秒）：供排程用的粗估窗口长。优先读代表 bossId 的 life_time，
 * 取不到时回退 DEFAULT_LIFE（不再返 0——返 0 会让窗口退化为零长、把今天所有槽都过滤掉，scheduleNext 无法排程）。
 * @returns {number}
 */
function bossLifeSeconds() {
    // 三个形态各有一个代表 bossId（101/201/301，活动 type_para2 白名单口径），取首个读到的 life_time
    var probes = [101, 201, 301];
    for (var i = 0; i < probes.length; i++) {
        var row = l10n.tableRow('BOSS', probes[i]);
        var life = row && Number(row[BOSS_LIFE_FIELD]);
        if (life > 0) return life;
    }
    return DEFAULT_LIFE;
}

/**
 * 当前时刻相对当日窗口表的位置。
 * @param {Array<{start:number, end:number}>} windows 升序窗口表
 * @param {number} now 当前服务器时间（秒）
 * @returns {{kind:string, window?:{start:number, end:number}, at?:number}}
 *   kind：'in'（窗口内，window=当前窗口）| 'wait'（窗口前，at=建议开扫时刻）| 'gone'（表内窗口都已结束）
 */
function locateWindow(windows, now) {
    var nextStart = Infinity;
    for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (now < w.start) {
            if (w.start < nextStart) nextStart = w.start;
        } else if (now < w.end) {
            return { kind: 'in', window: w };
        }
    }
    if (nextStart < Infinity) return { kind: 'wait', at: nextStart + WARMUP_DELAY / 1000 };
    return { kind: 'gone' };
}

/**
 * 排下一次扫描：攻打额度与奖励都收摊即收工；否则睡到窗口开扫点 / 窗口内慢扫 / 次日重算。
 * 排表不可用时降级为窗口内节奏的兜底定时（宁可慢，不静默停摆）。
 * @param {number} [delayMs] 显式延迟（毫秒）；缺省据当前窗口位置推导
 */
function scheduleNext(delayMs) {
    if (!aliveFn()) return;
    if (scanTimer) clearTimeout(scanTimer);

    if (quotaLeft() <= 0) {
        // 攻打额度打满：若 3 个奖励也已全领完，今日彻底收摊（不再排扫）；否则降频轮询把剩余奖励领掉
        if (claimAllDone()) {
            log.info('daily quota used up and all attack-count rewards claimed, stop until tomorrow.');
            scanTimer = null;
            return;
        }
        log.info('daily attack quota used up, keep low-freq poll for pending rewards.');
        var pollMs = delayMs == null ? CLAIM_POLL_INTERVAL : delayMs;
        scanTimer = setTimeout(function () {
            scanTimer = null;
            if (aliveFn()) triggerScan();
        }, Math.max(0, pollMs));
        return;
    }

    var ms = delayMs;
    if (ms == null) {
        var now = +(dataCenter && dataCenter.ServerTime) || 0;
        if (liveUntil > now && now > 0) {
            // 已知当前 BOSS 在场（上次 9956 回 alive=1 且未到 finishTime）：按 tick 慢扫用满额度，
            // 不再依赖本地窗口表（其 life_time 推导不可靠，会把 2 小时长窗口误算成短窗口而睡过）。
            ms = TICK_INTERVAL;
        } else {
            var windows = buildWindows();
            if (!windows || !windows.length || !now) {
                ms = TICK_INTERVAL;
            } else {
                var pos = locateWindow(windows, now);
                if (pos.kind === 'in') {
                    ms = TICK_INTERVAL;
                } else if (pos.kind === 'wait') {
                    ms = Math.max(0, (pos.at - now) * 1000);
                } else {
                    // 今天窗口跑完：睡到零点后（加余量）再重算——届时 SystemZeroTime 已翻新的一天
                    var dayEnd = ((+(dataCenter && dataCenter.UserData && dataCenter.UserData.SystemZeroTime) || 0)) + 86400;
                    ms = Math.max(TICK_INTERVAL, (dayEnd - now) * 1000 + DAY_ROLL_BUFFER);
                }
            }
        }
    }

    // 有「达标未领」档位时，把休眠上限压到 CLAIM_POLL_INTERVAL：让本条扫描循环兼职做奖励兜底轮询，
    // 不把正确性全押在 push 21923（手动攻打时若推送漏收/当刻领取瞬断，最迟一个轮询周期内补领）。
    // 纯本地判据（pendingTiers 只读 UserData，不发请求）：领完后 pendingTiers 空 → 自动回落原窗口节奏。
    if (delayMs == null) {
        var pend = pendingTiers();
        if (pend && pend.length && ms > CLAIM_POLL_INTERVAL) ms = CLAIM_POLL_INTERVAL;
    }

    log.debug('next scan in %d min', Math.round(ms / 60000));
    scanTimer = setTimeout(function () {
        scanTimer = null;
        if (aliveFn()) triggerScan();
    }, Math.max(0, ms));
}

// ── 扫描与攻打 ────────────────────────────────────────────────────────
/**
 * 扫描触发汇入口：run 点火 / 排程定时器都走这里。扫描在飞时不并发进入
 */
function triggerScan() {
    if (!aliveFn() || scanning) return;
    scanOnce().catch(function (err) {
        log.warn('scan threw.', err);
    });
}

/**
 * 判断一条 10019 USER_MARCH_INFO 推送是否是「我方战争之源 BOSS 行军刚刚回到家」。
 * 真机报文实证结构：{ marchInfo:{ state, marchType:298, uid, marchId, armyType, ... }, heroStateInfo:{ state, marchType }, target, armyInfoList, ... }。
 * 权威位取 marchInfo：state===4(ARRIVED_HOME) 才是回城可再派，marchType===298 才属本玩法（其它行军回城不唤醒，免空跑）。
 * 读不到（结构漂移）即返回 false，回落常规 tick，绝不错触发攻打。
 * @param {object} d ev.data（已 JSON 解析）
 * @returns {boolean}
 */
function isBossMarchArrivedHome(d) {
    var mi = d && d.marchInfo;
    if (!mi) return false;
    return (mi.state | 0) === MARCH_STATE_ARRIVED_HOME && (mi.marchType | 0) === MARCH_TYPE;
}

/**
 * 本人行军状态推送（10019）回调：部队回城（state===4）即补派下一次，省掉干等 tick。
 * 只在场窗口（liveUntil 未到）且额度未满、无扫描在飞时才补扫；非回城状态（出发/到达/返程）直接忽略。
 * 补扫仍走 scanOnce 全套闸门（alive/体力/行军槽/可派兵），不满足就自然跳过、回落到常规 tick。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 */
function onMarchUpdate(ev) {
    if (!aliveFn() || scanning) return;
    var now = +(dataCenter && dataCenter.ServerTime) || 0;
    if (!(now > 0 && liveUntil > now)) return;   // 不在场窗口，不因无关行军空转
    if (quotaLeft() <= 0) return;
    if (!isBossMarchArrivedHome(ev && ev.data)) return;   // 只认 marchInfo.marchType===298 && state===4（本玩法行军回城），其余推送忽略
    var wall = Date.now();
    if (wall - lastPushScanAt < PUSH_SCAN_MIN_GAP) return;
    lastPushScanAt = wall;
    log.debug('march arrived home (state=4) in live window, early re-scan.');
    triggerScan();
}

/**
 * 单轮：额度/窗口判位 → 有 BOSS 且闸门放开即打一波 → 排下一次。永不 reject。
 * @returns {Promise<void>}
 */
async function scanOnce() {
    if (quotaLeft() <= 0) {
        // 攻打额度打满后的收摊轮里仍搭一次奖励领取（本地判定，无待领不发请求）
        await claimAttackRewards();
        if (aliveFn()) scheduleNext();
        return;
    }

    scanning = true;
    var boss = null;
    try {
        boss = await requestBoss();
    } catch (err) {
        log.warn('request boss error.', err);
    } finally {
        scanning = false;
    }
    if (!aliveFn()) return;

    if (boss) {
        // 回包 alive=1 且带 finishTime：记下在场截止，驱动后续排程（秒）
        liveUntil = (boss.finishTime > 0) ? Math.floor(boss.finishTime / 1000) : liveUntil;
        try {
            await attackOnce(boss);
        } catch (err) {
            log.warn('attack flow threw.', err);
        }
        // 攻打已落账（服务端先加 attackBossCnt 再推 21923，push 未到时本地 UserData 也是当前态）：就地领掉达标档位
        await claimAttackRewards();
    } else {
        // 无在场 BOSS（含 alive≠1）：清除在场标记，排程回到本地窗口表等下一刷新点；
        // 若有达标未领档位（早先攻打落账但 push 未到）也在此补领，不额外加请求
        liveUntil = 0;
        log.debug('no alive boss, wait next tick.');
        await claimAttackRewards();
    }

    if (aliveFn()) scheduleNext();
}

/**
 * 查询当前战争之源 BOSS（9956，旧 JSON send，应答 data 为 JSON 串需 parse）。
 * 在场判定的权威信号是应答里的 `alive`（=1 才有可打 BOSS）：非窗口期/目标已消失时 alive 不为 1，
 * 据此拦住攻打（上一版只看 bossId 会在非窗口期拿到残留 id 误打被拒 csb_tips_012）。另需 reason<=0。
 * 每次消耗体力直接取应答 `costEnergy`（回包为准，普遍 5）；形态 type 仍从 BOSS 表读（应答无该字段）。
 * 永不 reject：闸门未放开 / 发送异常 / 无在场 BOSS 均回 null。
 * @returns {Promise<object|null>} {bossId,x,y,type,costEnergy,playerLevel,finishTime} 或 null
 */
async function requestBoss() {
    if (net.isSending(CMD_GET_BOSS_INFO_V2)) return null;

    var ret = await net.send(CMD_GET_BOSS_INFO_V2, {});
    if (!ret.ok) return null;

    // 旧 JSON 链路：ret.data 通常是 JSON 串（game 侧 JSON_PARSE(t.d)），兜底已解析对象
    var d = ret.data;
    if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (err) { return null; }
    }
    if (!d || !(d.bossId > 0)) return null;
    // 在场权威位：alive 非 1 即无可打 BOSS（含字段缺失，fail-closed）
    if (!(d.alive > 0)) {
        log.debug('boss not alive (alive=%s), skip. bossId=%d', d.alive, d.bossId);
        return null;
    }
    if (d.reason > 0) {
        log.debug('boss in KVK, banned. reason=%d', d.reason);
        return null;
    }

    // BOSS 表：仅取形态 type(0陆/1海/2空) 与 player_level；应答不带 type，取不到行无法选预设→不攻打
    var row = l10n.tableRow('BOSS', d.bossId);
    if (!row) {
        log.debug('boss row missing, skip. bossId=%d', d.bossId);
        return null;
    }

    // 体力消耗优先取应答 costEnergy（实证普遍 5），缺失/非法再退 BOSS 表、最后兜底 DEFAULT_COST_ENERGY
    var cost = Number(d.costEnergy);
    if (!(cost > 0)) cost = Number(row.cost_energy);
    if (!(cost > 0)) cost = DEFAULT_COST_ENERGY;

    return {
        bossId: d.bossId,
        x: d.x,
        y: d.y,
        type: (row.type | 0),
        costEnergy: cost,
        playerLevel: Number(row.player_level) || 0,
        // 本波 BOSS 消失时刻（服务器毫秒），供排程：在场期间按 tick 慢扫、过 finishTime 再等下一窗口
        finishTime: Number(d.finishTime) || 0,
    };
}

/**
 * 判定一条攻打应答是否为「体力不足」拒绝。服务器拒绝码固定含义不唯一，以 data 命中的
 * 字典键为准（ENERGY_SHORT_KEYS 四键均=体力不足）。用子串匹配兼容 data 为裸键或被包裹两种形态。
 * @param {object} ret net.Ret（code≠0）
 * @returns {boolean}
 */
function isEnergyShort(ret) {
    var d = ret && ret.data;
    if (d == null) return false;
    var s = String(d);
    for (var i = 0; i < ENERGY_SHORT_KEYS.length; i++) {
        if (s.indexOf(ENERGY_SHORT_KEYS[i]) !== -1) return true;
    }
    return false;
}

/**
 * 攻打一波：剩余额度 → 形态预设（0 即该形态不攻打）→ 等级/体力/行军槽闸门 → 构造部队 → 派 902。永不 reject。
 * @param {object} boss {bossId,x,y,type,costEnergy,playerLevel}
 * @returns {Promise<void>}
 */
async function attackOnce(boss) {
    if (quotaLeft() <= 0) {
        log.info('daily quota used up, skip attack.');
        return;
    }

    // 在场门禁已在 requestBoss 里以权威位 alive 完成（非在场根本不会传到这），无需再本地推窗口。

    var preset = (boss.type >= 0 && boss.type < FORM_COUNT) ? (presets[boss.type] | 0) : 0;
    if (preset <= 0) {
        log.debug('form not configured, skip. bossId=%d;type=%d', boss.bossId, boss.type);
        return;
    }

    var u = (dataCenter && dataCenter.UserData) || {};

    // 等级门槛（不足游戏提示键 100270，这里只跳过等待升级）
    if ((u.Level | 0) < boss.playerLevel) {
        log.debug('level not enough, skip. level=%d<%d', u.Level | 0, boss.playerLevel);
        return;
    }

    // 体力门槛：不足游戏会弹购买面板（BuyEnergyPanel），脚本只放过等体力回满
    var energy = 0;
    try { energy = (u.getEnergy(ENERGY_ACTION) || {}).Point || 0; } catch (err) { energy = 0; }
    if (energy < boss.costEnergy) {
        log.debug('energy not enough, skip. energy=%d<%d', energy, boss.costEnergy);
        return;
    }

    // 全局行军槽：无空位则本轮放过（在途行军会占位），下个 tick 再补
    if ((u.myMarchNumMAX | 0) - (u.myMarchNum | 0) < 1) {
        log.debug('no free march slot, wait next tick.');
        return;
    }

    if (net.isSending(CMD_MARCH_WORLD_POINT)) return;

    // 预设部队 → 5 字段行军数据（armyListNew/heroList/trapList/formationV2/extraArmy），已按可派额度过滤
    var plan = new Battle().plan().preset(preset).build();
    if (!plan.armyListNew.length) {
        log.warn('preset %d has no dispatchable army, skip. bossId=%d', preset, boss.bossId);
        return;
    }

    var ret = await sendMarch(boss, plan);
    if (!aliveFn()) return;

    if (ret.ok) {
        bumpDailyCount();
        log.info('attack ok. bossId=%d;type=%d;preset=%d;left=%d;x=%d;y=%d',
            boss.bossId, boss.type, preset, quotaLeft(), boss.x, boss.y);
    } else if (isEnergyShort(ret)) {
        // 服务器判定的体力不足（本地 getEnergy 值可能滞后）：放弃本轮，不扣当日额度，等体力回满后下个 tick 再试
        log.info('energy insufficient (server), abandon this round. bossId=%d;code=%d;data=%s',
            boss.bossId, ret.code, ret.data);
    } else {
        log.warn('attack rejected. bossId=%d;x=%d;y=%d;code=%d;data=%s', boss.bossId, boss.x, boss.y, ret.code, ret.data);
    }
}

/**
 * 派兵攻打 BOSS（902 行军）。载荷对齐「快捷攻击」的 start_commonMarch 口径。永不 reject。
 * @param {object} boss {x,y}
 * @param {object} d MarchData（5 字段）
 * @returns {Promise<object>} net.Ret
 */
async function sendMarch(boss, d) {
    try {
        return await net.send(CMD_MARCH_WORLD_POINT, {
            marchType: MARCH_TYPE,
            x: boss.x,
            y: boss.y,
            armyList: d.armyListNew,
            armyListNew: d.armyListNew,
            heroList: d.heroList,
            trapList: d.trapList,
            formation: 0,
            formationV2: d.formationV2,
            extraArmy: d.extraArmy,
        });
    } catch (err) {
        log.warn('march send error. x=%d;y=%d', boss.x, boss.y, err);
        return net.Ret.from(CODE_NOT_SENT, null);
    }
}

/**
 * 注入模块配置：三形态预设队号（面板选择器产出的 0-8）。非法值忽略，运行中改选下一轮扫描即生效。
 * @param {object} partial { presets: number[] }（toModuleCfg 产出）
 * @returns {number[]} 当前 presets
 */
function configure(partial) {
    if (partial && Array.isArray(partial.presets)) {
        for (var i = 0; i < FORM_COUNT; i++) {
            var v = partial.presets[i] | 0;
            presets[i] = (v >= 0 && v <= 8) ? v : 0;
        }
    }
    return presets;
}

/**
 * 安装：取网络底座 + 数据中心。任一缺失即失败（reactor 不会激活）。
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
 * 运行：复位状态 → 读回当日计数 → 按当前窗口位置排程点火。
 * pause 后 alive()=false 定时器到点空转；resume 重新读计数并排程（每日额度是持久值，跨暂停有效）。
 * @param {object} ctx reactor 上下文
 */
async function run(ctx) {
    ctxRef = ctx;
    scanning = false;
    liveUntil = 0;   // 清在场标记，首次扫描重新以 9956 回包 alive/finishTime 认定
    lastPushScanAt = 0;
    log.info('started, marchType=%d;dailyLimit=%d', MARCH_TYPE, DAILY_LIMIT);
    // 订阅本人行军状态推送：在场窗口内部队一回城就补派下一次（退订由 reactor 在 pause 统一摘除）
    ctx.on.push(PUSH_USER_MARCH_INFO, onMarchUpdate);
    // 订阅攻打计数/每日重置推送：计数一变就地重判待领档位，把达标奖励即时领掉
    ctx.on.push(PUSH_SOW_ATTACK_COUNT_UPDATE, onSowCountUpdate);
    ctx.on.push(PUSH_SOW_DAY_RESET, onSowCountUpdate);
    await loadDaily();
    if (!aliveFn()) return;
    if (quotaLeft() <= 0) {
        log.info('daily attack quota already used up today (%d/%d), only check pending rewards.', dailyState.count | 0, DAILY_LIMIT);
    }
    // 首个 tick 立即跑一次（判位 + 打日志 + 搭一轮奖励领取），之后由 scheduleNext 按窗口睡/慢扫。
    // 即便攻打额度已满也要跑：scheduleNext 会据奖励是否领完决定降频轮询还是直接收摊到次日。
    scheduleNext(0);
}

/**
 * 向 reactor 注册本功能说明书：场景限定 Home/NWorldMap，战斗模式暂停；
 * 面板带三形态预设选择器（各 0-8，0=不攻打该形态）+ 今日已攻打计数；
 * 窗口/定额/间隔均为本文件内置常量（DAILY_LIMIT / WARMUP_DELAY / TICK_INTERVAL）。
 */
reactor.register({
    id: 'sourceOfWar',
    label: '战争之源',
    storageKey: 'pocketcc.feat.sourceOfWar',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: {
        enabled: false,
        armyPreset: 0,   // 陆军形态（BOSS.type=0）预设队号 0-8
        oceanPreset: 0,  // 海军形态（BOSS.type=1）预设队号 0-8
        airPreset: 0,    // 空军形态（BOSS.type=2）预设队号 0-8
    },
    fields: (function () {
        // 0-8 下拉选项：0=不攻打该形态，1-8=预设部队 N。形态名直接做行标签、不分组（pc-row 就是标签靠左+控件靠右的一行）。
        var options = [{ value: 0, label: '不攻打' }];
        for (var i = 1; i <= 8; i++) options.push({ value: i, label: '预设部队 ' + i });
        var mk = function (key, label) {
            return { key: key, label: label, type: 'select', options: options };
        };
        return [
            mk('armyPreset', '陆军形态'),
            mk('oceanPreset', '海军形态'),
            mk('airPreset', '空军形态'),
            {
                key: 'todayCount', label: '今日已打', type: 'text',
                get: function () { return formatToday(); },
            },
            {
                key: 'todayReward', label: '次数奖励', type: 'text',
                get: function () { return formatRewardToday(); },
            },
        ];
    })(),
    toModuleCfg: function (c) {
        return { presets: [c.armyPreset | 0, c.oceanPreset | 0, c.airPreset | 0] };
    },
    install: install,
    configure: configure,
    run: run,
});
