/**
 * 泰坦祝福（泰坦藏宝图）-空投拾取功能（reactor 说明书形态）
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *
 * 报文事实（实证 20261005T005510-泰坦祝福.ndjson + 客户端 WorldTiTanBlessingTreasurePop / NWorldMapTileClickUtils）：
 *   13226 PUSH_TITAN_BLESSING_GIFT = 新箱广播，载荷 {uid(字符串), playerInfo, x, y, endTime(ms)}，一次送礼成簇推 3 条（3 只箱）。
 *     ⚠️ 自己发出的箱也照样推给自己（实录 uid 即本人），故必须自己判归属，否则 902 必被服务器拒 → 死循环刷屏。
 *   13227 PUSH_WORLD_TITAN_BLESSING_REWARD_GET = 本人领取到账，载荷 {reward, uuid}（有 uuid 无坐标）。
 *   13228 PUSH_WORLD_TITAN_BLESSING_GIFT_CLEAR = 箱子消失，载荷 {uuid}（有 uuid 无坐标，被本盟任何人领走/到期都推）。
 *   10904 PUSH_ONE_ACTIVITY = 整条活动推送，extra 是对象（非字符串），含 hasRed/left/totalNum/rec_other_record{uuid:领取ms}。
 *   9595 HERO_EQUIP_WISH_FIND_BOX = 查一只可领箱，应答仅 {serverId,x,y}，不带归属信息 → 单靠它无法滤掉自己的箱。
 *   三条推送的字段互斥（uuid 与坐标从不同时出现），因此「哪只箱领过了」只能由本模块按 "x,y" 自建台账。
 *   时间线实证：每簇「13226×3 → 902×3」中 902 的坐标与 13226 逐条相等（主链无需 9595）；
 *   且同一簇会伴随 3 条 10904 hasRed=true（活动推送按箱计数），故兜底链必须自带去重与冷却，否则每簇白打 3 次 9595。
 *   另有独立的 10904 hasRed=false（left 逐次 -1）＝本人领取到账通知，不驱动流程。
 *
 * 游戏侧本地闸（我们裸发包不走，能纯客户端复刻的就自己复刻，否则白派 + 刷屏）：
 *   ① uid ≠ 本人 → 主链入口直接拦（已证实自己发的也推给自己）；
 *   ② 箱子属本盟（allianceId == 本人 Aid）→ 13226/9595 载荷里都没有盟信息，不预探；
 *     真越了界服务器会拒，由「连拒 3 次即拉黑该坐标」兜住，不会刷屏；
 *   ③ 同一只箱 10 秒内只能点一次 → 消费间隔 1s + 台账一次一派已天然满足。
 *
 * 两链驱动：
 *   主链：13226 → 判本人/判台账/判拉黑 → 坐标现成，直接 902（不再发 9595）；入队即记台账。
 *   兜底链：10904 且 extra.hasRed → 单槽去重 + 冷却 → 入队 → 9595 查坐标 → 过台账闸 → 902。
 *     保留只为覆盖「脚本启动前联盟已有的箱」；activityId 从 10904 载荷里锁存（实录 81200400，9595 必需）。
 *   台账清理：13228（箱子消失）推来时按 uuid 精确出队、无 uuid 时按派兵顺序 FIFO 出一条，
 *     兜底 TTL 用 13226 的 endTime 到期自动剔除。这样即便 9595 反复报同一只不可领的箱，也不会重复派。
 *
 * 额度上限：extra.totalNum=本期已领、extra.left=本期剩余可领；left<=0 即本期触顶，置 claimLimitReached 闸门，
 *   主链/兜底链/消费三处一并停派并清空残留队列（否则领满后盟友每发一只箱都会被派出去又被服务器拒 → 死循环刷屏）；
 *   触顶日志只在 false→true 转变时打一行（一簇 3 条 10904 不再刷 3 行），下一轮 left 回升自动复位续领。
 * 队列 + 消费间隔：902 过快会被服务器限流（code=3, data="march_time_control_info001"），逐条之间休眠规避。
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap。
 *   run 挂 10904/13226/13227/13228 监听；reactor pause 时摘监听、置 alive=false，队列保留，恢复后续跑。
 */
import { createLog } from '../../core/log.js';
import { createDrain } from '../../core/drain.js';
import { reactor } from '../../core/reactor.js';
import { getUid } from '../../core/player.js';
import { march } from '../../core/march.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=TITAN_BLESSING） */
const log = createLog('TITAN_BLESSING');

/** @type {number} ResponseId.PUSH_ONE_ACTIVITY（ResponseId.js:158），整条活动推送，载荷含 type/extra/id */
const CMD_PUSH_ONE_ACTIVITY = 10904;

/** @type {number} ResponseId.Push_Titan_Blessing_Gift=13226，新箱广播（客户端 EventId 别名 TitanBlessTreasureRefresh），载荷 {uid,playerInfo,x,y,endTime} */
const CMD_PUSH_GIFT = 13226;

/** @type {number} ResponseId.Push_World_Titan_Blessing_Reward_Get=13227，本人领取到账，载荷 {reward,uuid} */
const CMD_PUSH_REWARD_GET = 13227;

/** @type {number} ResponseId.Push_World_Titan_Blessing_Gift_Clear=13228，箱子消失，载荷 {uuid} */
const CMD_PUSH_GIFT_CLEAR = 13228;

/** @type {number} NRequestIdV2.HERO_EQUIP_WISH_FIND_BOX（NRequestIdV2.js:1374），载荷 {activityId}，应答 data={serverId,x,y}（值已真机验证） */
const CMD_HERO_EQUIP_WISH_FIND_BOX = 9595;

/** @type {number} 泰坦祝福活动 type；同一 push 载荷 showUiType="ActivityTitanBlessing"（见 泰坦藏宝图资料整理.md），无独立枚举，值已真机验证 */
const ACTIVITY_TYPE_TITAN_BLESSING = 271;

/** @type {number} NMarchType.Titan_Blessing_Gift（NWorldMapMarchCommon.js:141），泰坦祝福拾取行军类型，902 派遣用（值已真机验证） */
const MARCH_TYPE_TITAN_BLESSING_GIFT = 143;

/** @type {number} 队列逐条消费之间的休眠毫秒（固定调优常量，不在面板暴露）：规避 902 限流（march_time_control_info001） */
const CONSUME_INTERVAL_MS = 1000;

/** @type {number} 同一坐标连续被拒达此数即本会话拉黑（防字段口径意外导致重复派） */
const REJECT_STREAK_BLACKLIST = 3;

/** @type {number} 台账 TTL 兜底毫秒：13226 未到 endTime 前的最长保留（箱到期消失却漏收 13228 时用） */
const LEDGER_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {number} 兜底链（9595）两次查箱之间的最小间隔毫秒：活动推送按箱计数，一簇能推 3 条 */
const FALLBACK_SCAN_COOLDOWN_MS = 5000;

/**
 * 模块内部配置：{ consumeInterval:number(ms) }。面板仅出启用开关，此值为内置常量。
 * @type {object}
 */
var cfg = { consumeInterval: CONSUME_INTERVAL_MS };

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {object[]} 待消费的拾取事件队列（pause 保留、恢复续跑）：{src:'gift'|'activity', x?, y?, activityId?} */
var queue = [];

/**
 * 坐标台账："x,y" → {uuid:string|null, endTime:number(ms,0=未知), sent:boolean}。
 * 语义 = 「这只箱本会话已处理过，不再重复派」。清理靠 13228（按 uuid 精确，无 uuid 时 FIFO 出队）与 TTL 到期。
 * ⚠️ uuid 是雪花量级（>2^53），只按字符串存，绝不做 Number()。
 * @type {Map<string, object>}
 */
var ledger = new Map();

/** @type {string[]} 已派兵但尚未确认消失的坐标键，按入队顺序（13228 不带坐标，只能靠它做 FIFO 出队） */
var pendingKeys = [];

/** @type {Object<string, number>} 坐标键 → 连续被拒次数（达 REJECT_STREAK_BLACKLIST 即转写进 rejected） */
var rejectStreak = {};

/** @type {Object<string, number>} 坐标键 → 拉黑时刻（连续被拒达阈后本会话不再重派，直到台账项被 13228/TTL 清掉时一并解除） */
var rejected = {};

/** @type {number} 最近一次从 10904 锁存到的活动 id（9595 必需参数；实录 81200400），0=还没见过泰坦祝福推送 */
var activityId = 0;

/** @type {boolean} 兜底链单槽去重：已有一颗「待查箱」种子在队里就不再重复入队 */
var fallbackPending = false;

/** @type {number} 兜底链上次实际查箱的时刻（ms），配合 FALLBACK_SCAN_COOLDOWN_MS 限频 */
var fallbackScanAt = 0;

/**
 * 本期领取额度是否已触顶（由 10904 的 extra.left 驱动：<=0 置真、>0 复位）。
 * 为真时主链/兜底链/消费三处一律不再派兵——领满后服务器对每只箱都拒，不拦就是死循环刷屏。
 * @type {boolean}
 */
var claimLimitReached = false;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（在飞流程的 await 回来后的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

/** @type {string} 本人 UID（字符串口径，与 13226 载荷的 uid 同源；未就绪为 ''） */
function myUid() {
    return String(getUid() || '');
}

/**
 * 坐标键
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
function posKey(x, y) {
    return (x | 0) + ',' + (y | 0);
}

/**
 * 台账是否已含该坐标（已派过/已领/已拉黑）
 * @param {string} key
 * @returns {boolean}
 */
function seenPos(key) {
    return ledger.has(key);
}

/**
 * 剔除到期与无主条目：箱endTime（13226 带来）已过即删；未知 endTime 的按兜底 TTL 老化。
 * 顺带清掉已不在台账里的 pendingKeys，防数组无界增长。
 * @returns {void}
 */
function purgeLedger() {
    var now = Date.now();
    var alive = {};
    ledger.forEach(function (rec, key) {
        var expiry = rec.endTime > 0 ? rec.endTime : rec.at + LEDGER_FALLBACK_TTL_MS;
        if (now < expiry) alive[key] = 1;
        else ledger.delete(key);
    });
    pendingKeys = pendingKeys.filter(function (k) { return !!alive[k]; });
    Object.keys(rejectStreak).forEach(function (k) { if (!alive[k]) delete rejectStreak[k]; });
    Object.keys(rejected).forEach(function (k) { if (!alive[k]) delete rejected[k]; });
}

/**
 * 记入台账并登记待消失队列（主链入队时就调，让后续重复推送/兜底链查回同一坐标能被立即拦住）
 * @param {string} key "x,y"
 * @param {number} endTime 箱到期毫秒时间戳（13226 的 endTime；未知传 0）
 * @param {boolean} sent 是否已派过兵（派兵后置真，仅供日志与 FIFO 优先级参考）
 * @returns {void}
 */
function markLedger(key, endTime, sent) {
    var rec = ledger.get(key) || {};
    rec.endTime = endTime > 0 ? endTime : (rec.endTime || 0);
    rec.at = rec.at || Date.now();
    if (sent) rec.sent = true;
    ledger.set(key, rec);
    if (pendingKeys.indexOf(key) < 0) pendingKeys.push(key);
}

/**
 * 13228 到账的清理：uuid 已知就精确删，未知按最早入队的已派坐标 FIFO 出一条。
 * 泰坦祝福的箱一次只会被一只行军领走，我们的派兵顺序与服务器消失顺序实践中一致；
 * 错位只会让某只箱少一次重试机会，TTL 与下一条推送都会自愈，不影响正确性。
 * @param {string} uuid 箱子唯一标识（字符串，勿转数字）
 * @returns {void}
 */
function clearByUuid(uuid) {
    if (uuid) {
        var hitKey = null;
        ledger.forEach(function (rec, key) { if (rec.uuid === uuid) hitKey = key; });
        if (hitKey) {
            ledger.delete(hitKey);
            pendingKeys = pendingKeys.filter(function (k) { return k !== hitKey; });
            delete rejectStreak[hitKey];
            delete rejected[hitKey];
            log.debug('box cleared by uuid. key=%s;uuid=%s', hitKey, uuid);
            return;
        }
    }
    var key = pendingKeys.shift();
    if (key) {
        ledger.delete(key);
        delete rejectStreak[key];
        delete rejected[key];
        log.debug('box cleared by fifo. key=%s;uuid=%s', key, uuid || 'n/a');
    }
}

/**
 * 10904 推送入口（兜底链 + 额度信号源）：同步过滤 + 入队，listener 本身永不 throw。
 * 注意 10904 是 PUSH_ONE_ACTIVITY，任何活动都会推它，故必先按 type 认出泰坦祝福再判其余字段。
 * 分支：非泰坦祝福→静默忽略；锁存 activityId；用 extra.left 刷新额度闸门（触顶清队列、只在 false→true 转变打一行日志）；
 * hasRed=false＝本人领取到账通知，忽略；hasRed=true 且额度未满 → 单槽 + 冷却后入队（实录一簇推 3 条，不去重就白打 3 次 9595）。
 * @param {object} ev net.on 事件 {cmd, status, data, ord, ts, raw}
 */
function onActivityPush(ev) {
    if (!aliveFn()) return;

    var data = ev && ev.data;
    if (!data || data.type !== ACTIVITY_TYPE_TITAN_BLESSING) return;

    if (data.id) activityId = data.id;

    var extra = data.extra || {};

    // 本期领取额度闸门：left<=0 即触顶。仅在状态翻转时打日志（否则一簇 3 条推=刷 3 行）。
    // 触顶即清空残留队列（已入队但未派的箱不再派），并置闸让主链/消费一并停手；
    // 不停监听——下一轮活动 left 回升，闸门自动复位
    var reached = extra.left <= 0;
    if (reached !== claimLimitReached) {
        claimLimitReached = reached;
        if (reached) {
            log.info('period claim limit reached, stop picking. left=%s;totalNum=%s', extra.left, extra.totalNum);
            queue.length = 0;
            fallbackPending = false;
        } else {
            log.info('claim quota refreshed, resume picking. left=%s', extra.left);
        }
    }
    if (reached) return;

    // hasRed == false，表示这是一条领取完成的通知，可以忽略。
    if (!extra.hasRed) {
        return;
    }

    if (fallbackPending || Date.now() - fallbackScanAt < FALLBACK_SCAN_COOLDOWN_MS) return;
    fallbackPending = true;

    log.debug('activity push (fallback), enqueue. id=%d;left=%s', data.id, extra.left);
    queue.push({ src: 'activity' });
    kick();
}

/**
 * 13226 新箱广播入口（主链）：坐标与发送人都在载荷里，判完直接入队，省掉一次 9595。
 * 两道闸：本人发的箱 → 丢（实录证实自己发的也推给自己，不拦就是 902 被拒死循环）；台账已有该坐标 → 丢。
 * 入队即记台账（不等到派兵）：同一坐标紧随其后的重复推送、以及兜底链 9595 查回同一只箱，都会被这道闸拦住。
 * @param {object} ev net 事件，ev.data={uid:string, playerInfo:string, x, y, endTime:ms}
 */
function onGiftPush(ev) {
    if (!aliveFn()) return;

    var d = ev && ev.data;
    if (!d || !isFinite(d.x) || !isFinite(d.y)) return;

    // 额度闸门：本期已领满，任何新箱派过去都会被服务器拒（left 由 10904 刷新，一簇必到，够及时）
    if (claimLimitReached) return;

    var key = posKey(d.x, d.y);
    // 两侧都 String()：推送里 uid 是字符串，getUid() 也是字符串口径；切勿用 gameData.myPid()（Number 会丢精度）
    if (String(d.uid) === myUid()) {
        log.debug('gift skip. reason=self; key=%s;uid=%s', key, d.uid);
        return;
    }
    if (seenPos(key)) {
        log.debug('gift skip. reason=already-handled; key=%s', key);
        return;
    }
    // 被服务器连拒达阈的坐标本会话不再重派（防字段口径意外退化成刷屏）
    if (rejected[key]) {
        log.debug('gift skip. reason=blacklisted; key=%s', key);
        return;
    }

    markLedger(key, d.endTime > 0 ? d.endTime : 0, false);
    log.debug('gift push received (main), enqueue. key=%s;from=%s', key, d.uid);
    queue.push({ src: 'gift', x: d.x | 0, y: d.y | 0 });
    kick();
}

/**
 * 13227 本人领取到账：仅作日志对账，不驱动流程（领取确认已由 13228 负责台账出队）。
 * @param {object} ev net 事件，ev.data={reward, uuid}
 */
function onRewardPush(ev) {
    var d = ev && ev.data;
    if (!d || !d.uuid) return;
    var items = (d.reward && d.reward.items) || [];
    log.info('reward received. uuid=%s;items=%d', d.uuid, items.length);
}

/**
 * 13228 箱子消失：台账出队，该坐标重新允许被派（本盟盟友领走也算，消失即腾位）。
 * @param {object} ev net 事件，ev.data={uuid}
 */
function onGiftClearPush(ev) {
    if (!aliveFn()) return;
    var d = ev && ev.data;
    clearByUuid(d && d.uuid ? String(d.uuid) : '');
}

/**
 * 触发消费；若已有循环在跑则立即返回，由该循环兜底取走新入队事件
 * @returns {void}
 */
function kick() {
    drain.consume().catch(function (err) {
        log.warn('consume loop threw!', err);
    });
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
 * 单条拾取流程（drain 的 process）：主链直接用坐标派兵；兜底链先 9595 查坐标再派。永不 reject
 * @param {object} ev 入队事件 {src:'gift'|'activity', x?, y?}
 * @returns {Promise<void>}
 */
async function pickUpFlow(ev) {
    purgeLedger();
    if (!aliveFn()) return;
    // 额度闸门（与入队闸双保险）：入队后、派兵前才收到 left<=0 的竞态靠这道拦住
    if (claimLimitReached) return;

    var key, endTime = 0;
    if (ev.src === 'gift') {
        key = posKey(ev.x, ev.y);
        var rec = ledger.get(key);
        endTime = (rec && rec.endTime) || 0;
        if (rejected[key]) {
            log.debug('pick up skip. reason=blacklisted; key=%s', key);
            return;
        }
    } else {
        // 兜底链：本簇新箱已由主链处理时，9595 查回的坐标会被下面的台账闸拦住（不派、不刷屏）
        fallbackPending = false;
        fallbackScanAt = Date.now();
        if (!activityId) {
            log.debug('find box skip. reason=no-activity-id');
            return;
        }
        var pos = await queryBoxPosition();
        if (!aliveFn() || !pos) return;
        key = posKey(pos.x, pos.y);
        ev.x = pos.x;
        ev.y = pos.y;
    }

    // 台账闸只拦兜底链（它无坐标、靠 9595 反查，可能查回主链已处理的箱）；
    // 主链在入队时已记台账并过了闸，这里再查会把自己拦住
    if (ev.src !== 'gift' && seenPos(key)) {
        log.debug('pick up skip. reason=already-handled; key=%s;src=%s', key, ev.src);
        return;
    }

    markLedger(key, endTime, true);
    var ret = await marchPickUp(ev.x, ev.y);
    if (!aliveFn()) return;

    if (ret.ok) {
        log.info('pick up march started. key=%s;src=%s;code=%d', key, ev.src, ret.code);
        delete rejectStreak[key];
        return;
    }
    log.info('pick up march rejected. key=%s;src=%s;reason=code-%d;streak=%d',
        key, ev.src, ret.code, bumpReject(key));
}

/**
 * 被拒计数：达阈值即拉黑本会话不再重派（箱消失或 TTL 到期时随台账一起解除）
 * @param {string} key "x,y"
 * @returns {number} 当前连续被拒次数
 */
function bumpReject(key) {
    var n = (rejectStreak[key] || 0) + 1;
    rejectStreak[key] = n;
    if (n >= REJECT_STREAK_BLACKLIST) {
        rejected[key] = Date.now();
        log.info('coordinate blacklisted for this session. key=%s;streak=%d', key, n);
    }
    return n;
}

/**
 * 查可领取的空投箱坐标（兜底链专用；游戏 onClickTitanBlessing 同款请求，见 泰坦藏宝图资料整理.md）。
 * 永不 reject：发送异常 / 无箱子都返回 null。
 * 无箱子口径：s!=0，或 s=0 但 data={x:0,y:0}
 * @returns {Promise<object|null>} {x,y,serverId} 或 null
 */
async function queryBoxPosition() {
    try {
        var ret = await net.sendPBV2(CMD_HERO_EQUIP_WISH_FIND_BOX, { activityId: activityId });
        var pos = ret.data;
        if (!ret.ok || !pos || (pos.x === 0 && pos.y === 0)) {
            log.debug('find box empty. reason=no-box; activityId=%d;code=%d', activityId, ret.code);
            return null;
        }
        log.debug('box found. x=%d;y=%d;serverId=%s', pos.x, pos.y, pos.serverId);
        return pos;
    } catch (err) {
        log.warn('query box error!', err);
        return null;
    }
}

/**
 * 派拾取行军（零部队九键 body，含 ext:{}）→ 走 core/march.pickUp；永不 reject（异常回 Ret(NOT_SENT)）
 * @param {number} x 箱子坐标
 * @param {number} y 箱子坐标
 * @returns {Promise<Ret>} code=902 状态码
 */
async function marchPickUp(x, y) {
    return march.pickUp({ marchType: MARCH_TYPE_TITAN_BLESSING_GIFT, target: { x: x, y: y }, ext: {} });
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
 * 运行：挂 13226（主链）+ 10904（兜底）+ 13227/13228（到账日志与台账清理）监听。
 * 不做启动补查：9595 需要 activityId（只从 10904 载荷锁存），而联盟已有箱必然伴随 hasRed=true 的活动推送，
 * 兜底链会在那条推送上自动跑一次——所覆盖的正是「脚本启动前联盟已有的箱」。
 * reactor pause 会自动摘除此处登记的触发器。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    ctx.on.push(CMD_PUSH_GIFT, onGiftPush);
    ctx.on.push(CMD_PUSH_ONE_ACTIVITY, onActivityPush);
    ctx.on.push(CMD_PUSH_REWARD_GET, onRewardPush);
    ctx.on.push(CMD_PUSH_GIFT_CLEAR, onGiftClearPush);

    ledger = new Map();
    pendingKeys = [];
    rejectStreak = {};
    rejected = {};
    fallbackPending = false;
    fallbackScanAt = 0;
    claimLimitReached = false;

    log.info('started, listening push cmd=%d(main);%d(fallback);%d;%d(ledger).',
        CMD_PUSH_GIFT, CMD_PUSH_ONE_ACTIVITY, CMD_PUSH_REWARD_GET, CMD_PUSH_GIFT_CLEAR);
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
