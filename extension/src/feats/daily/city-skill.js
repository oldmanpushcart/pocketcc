/**
 * 城市技能-皮肤技能赠送（reactor 说明书形态）
 *
 * 两个橙色城市皮肤技能：玫花幽香(skinId 1771000) / 芳心萌动(skinId 1772000)。冷却到点后，
 *   可向用户输入的指定 UID 玩家赠送物品（USE_CITY_SKILL 1753）。两个技能各自独立开关、可赠不同的人。
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 *   三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *   注意：net.send 的 ret.data 是原始 JSON 字符串 d（Ret 不再自动 parse），需自行 JSON.parse。
 *
 * 判据（口径同游戏 PlayerSkillCastleItem，见 references/游戏逆向/extracted）：
 *   读 DataCenter.DATA：
 *     - DATA.ServerTime：服务器时钟，单位「秒」。
 *     - DATA.UserData.MyCastleFace[skinId]：皮肤是否拥有且生效——d && (d.endTime > ServerTime || d.endTime === -1)。
 *     - getCitySkillDataById(skinId) / GET_CITY_SKILL_DATA(1752) 应答：{skinId, endTime(冷却到,秒), dailyCnt(仅统计，不门控)}。
 *   就绪 = 已拥有 && endTime <= ServerTime。
 *     这两个技能无每日次数限制，只有冷却（CD）限制——同日可用多次，两次使用之间仅受 CD 约束。
 *
 * 赠送（见 PlayerSkillCastleItem skill_type=7 分支）：
 *   req send USE_CITY_SKILL(1753) {skinId, targetUid:"<字符串>"} → 应答 d={skinId,endTime,dailyCnt,reward?}。
 *   两技能各一个开关，独立判定、独立发送；纯协议发包，绝不改写本地游戏数据（feat 只读+发包铁律）。
 *
 * 触发模型（轮询为主，无可靠专用推送）：
 *   1) 每轮先 1752 拉最新冷却（读请求，幂等）；
 *   2) 就绪即赠；未就绪按冷却到期点(endTime)精确排下一次复查（无每日次数概念，不看次日重置）；
 *   3) 未拥有 / UID 未填 → 本轮跳过，降 idleInterval 兜底复查（皮肤随时可能购买）；
 *   4) 本轮真赠出去 → busy 短间隔续跑（另一技能可能也待赠）。
 *
 * 重入闸门：单定时器 + ticking 标志保证同一时刻只有一轮检查在飞（含 1752/1753 await）；
 *   pause 后 alive()=false，挂着的定时器到点空转一次不再自重排，resume 时 run 复位并重新点火。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子，scenes 门控限定 Home/NWorldMap，战斗态暂停。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CITY_SKILL） */
const log = createLog('CITY_SKILL');

/** @type {number} 玫花幽香 skinId（用户提供，与抓包报文一致） */
const SKILL_ROSE = 1771000;

/** @type {number} 芳心萌动 skinId（用户提供） */
const SKILL_HEART = 1772000;

/** @type {number} RequestId.USE_CITY_SKILL（RequestId.js），使用/赠送城市皮肤技能，载荷 {skinId,targetUid} */
const CMD_USE_CITY_SKILL = 1753;

/** @type {number} RequestId.GET_CITY_SKILL_DATA（RequestId.js），拉取城市皮肤技能冷却数据，载荷 {}，应答 d={skinSkills:[...]} */
const CMD_GET_CITY_SKILL_DATA = 1752;

/** @type {number} 冷却/重置到点后的复查余量（毫秒），避免贴着边界秒被服务器判未到期 */
const CD_BUFFER_MS = 1000 * 3;

/** @type {number} 两技能连发之间的间隔，规避 1753 过快被服务器限流 */
const GIFT_GAP_MS = 1000 * 2;

/**
 * 赠送失败退避阶梯（毫秒）：连续失败按此递增，末项封顶（=idleInterval，最慢也就 10 分钟一轮）。
 * 用途：UID 填错等永久性失败不再无限狂发；改配置（configure）即清零复活。
 * @type {number[]}
 */
const BACKOFF_MS = [1000 * 30, 1000 * 60, 1000 * 180, 1000 * 60 * 10];

/** @type {number} 排程唤醒的最小间隔（毫秒），防 0 延迟忙循环 */
const MIN_WAKE_MS = 1000 * 5;

/**
 * 内置调优常量（面板仅出启用开关与 UID 输入，不暴露这些项）
 * @type {object}
 */
const cfg = {

    /** 本轮真赠出去后的勤扫间隔（另一技能可能也待赠） */
    busyInterval: 1000 * 15,

    /** 无可赠（未拥有/UID 未填/都在冷却但取不到精确点）时的兜底复查间隔 */
    idleInterval: 1000 * 60 * 10,

};

/**
 * 待办技能项（由 toModuleCfg 从面板配置产出）：{skinId, enabled, uid}
 * @type {Array<{skinId:number, enabled:boolean, uid:string}>}
 */
var skills = [];

/** @type {object|null} DataCenter.DATA */
var data;
/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞检查自然退出 */
var ctxRef = null;

/** @type {number|null} 单定时器句柄；pause 后到点空转一次不再自重排 */
var timer = null;

/** @type {boolean} 检查闸门：同时只跑一轮 tick（含 1752/1753 await），防重入 */
var ticking = false;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {Object<number, {count:number, notBeforeMs:number}>} 各技能失败退避态：连续失败次数 + 下次可重试的墙上时刻(毫秒) */
var failState = Object.create(null);

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
 * 注入模块配置（来自 toModuleCfg）：技能列表 {skinId, enabled, uid}。运行中改动即热更（下一轮 tick 生效）。
 * 任何配置变更都清空失败退避：用户把 UID 改对/开关一翻，下一轮立即重试，不必干等退避窗口。
 * @param {object} partial {skills:Array<{skinId:number, enabled:boolean, uid:string}>}
 * @returns {object} 当前 {skills}
 */
function configure(partial) {
    if (partial && Array.isArray(partial.skills)) {
        skills = partial.skills.map(function (s) {
            return { skinId: s.skinId | 0, enabled: !!s.enabled, uid: s.uid == null ? '' : String(s.uid).trim() };
        });
    }
    failState = Object.create(null);
    return { skills: skills };
}

// ─────────────────────────── 数据读取 ───────────────────────────

/**
 * 某皮肤是否拥有且生效（口径同 PlayerSkillCastleItem._skillOpen）
 * @param {number} skinId 皮肤 id
 * @param {number} serverTime DATA.ServerTime（秒）
 * @returns {boolean}
 */
function ownsSkin(skinId, serverTime) {
    var ud = data && data.UserData;
    var face = ud && ud.MyCastleFace && ud.MyCastleFace[skinId];
    return !!(face && (face.endTime > serverTime || face.endTime === -1));
}

/**
 * 拉取最新冷却数据，建 skinId → {endTime, dailyCnt} 映射。永不 reject：失败返回空表（调用方回落 getCitySkillDataById）
 * @returns {Promise<Object<number, {endTime:number, dailyCnt:number}>>}
 */
async function refreshSkillData() {
    var map = Object.create(null);
    try {
        var ret = await net.send(CMD_GET_CITY_SKILL_DATA, {});
        var d = ret.ok && typeof ret.data === 'string' ? JSON.parse(ret.data) : (ret.data || null);
        var list = d && d.skinSkills;
        if (Array.isArray(list)) {
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                if (it && it.skinId != null) {
                    map[it.skinId] = { endTime: Number(it.endTime) || 0, dailyCnt: Number(it.dailyCnt) || 0 };
                }
            }
        }
    } catch (err) {
        log.warn('refresh city skill data error, fallback to cached.', err);
    }
    return map;
}

/**
 * 取某技能当前冷却/次数（1752 表优先，缺失回落内存 getCitySkillDataById）。无数据视为从未用过（endTime=0,count=0）
 * @param {number} skinId 皮肤 id
 * @param {Object<number, object>} map 1752 拉回的映射
 * @returns {{endTime:number, dailyCnt:number}}
 */
function skillState(skinId, map) {
    var hit = map[skinId];
    if (hit) return hit;
    var ud = data && data.UserData;
    var obj = ud && ud.getCitySkillDataById ? ud.getCitySkillDataById(skinId) : null;
    if (obj) return { endTime: Number(obj.CDTime) || 0, dailyCnt: Number(obj.Count) || 0 };
    return { endTime: 0, dailyCnt: 0 };
}

// ─────────────────────────── 调度 ───────────────────────────

/**
 * 单定时器武装器：到点跑一次 tick；pause 后 alive()=false 不再武装
 * @param {number} delay 延迟(毫秒)
 */
function schedule(delay) {
    if (!aliveFn()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
        timer = null;
        if (!aliveFn()) return;
        tick().catch(function (err) {
            log.warn('tick threw, reschedule.', err);
            schedule(cfg.idleInterval);
        });
    }, Math.max(0, delay));
}

// ─────────────────────────── 检查 + 赠送 ───────────────────────────

/**
 * 一轮检查：1752 拉冷却 → 逐个启用的技能判拥有/就绪 → 就绪则赠 → 按最近唤醒点(冷却/退避)重排。永不 reject。
 * 排程统一到「墙上毫秒」口径（wakes 数组）：冷却/次数用 (serverSec - serverTime)*1000 + now 换算，退避直接取 notBeforeMs。
 * @returns {Promise<void>}
 */
async function tick() {
    if (ticking) return;
    ticking = true;
    var now = Date.now();
    var serverTime = (data && data.ServerTime) || 0;
    var wakes = [];        // 各技能下次应复查的绝对墙上时刻(毫秒)
    var didGift = false;
    try {
        var map = await refreshSkillData();
        if (!aliveFn()) return;

        for (var i = 0; i < skills.length; i++) {
            var s = skills[i];
            // 未启用 / 未填 UID → 本轮跳过（降 idle）。这两行是静默分支，补日志便于定位「配置没填上」。
            if (!s.enabled) {
                log.debug('skip skin %d: disabled.', s.skinId);
                continue;
            }
            if (!s.uid) {
                log.debug('skip skin %d: uid empty.', s.skinId);
                continue;
            }

            // 退避闸门：上次赠送失败后未到重试点，本轮不碰，只把重试点纳入排程
            var fs = failState[s.skinId];
            if (fs && now < fs.notBeforeMs) { wakes.push(fs.notBeforeMs); continue; }

            if (!ownsSkin(s.skinId, serverTime)) {
                log.debug('skip skin %d: not owned.', s.skinId);
                continue;
            }

            var st = skillState(s.skinId, map);
            var cdOver = st.endTime <= serverTime;

            // 就绪只看冷却：无每日次数限制，同日可用多次（dailyCnt 不参与门控）
            if (cdOver) {
                var r = await gift(s.skinId, s.uid, map);
                now = Date.now();
                if (r === 'ok') {
                    didGift = true;
                    await sleep(GIFT_GAP_MS);
                    if (!aliveFn()) return;
                    now = Date.now();
                    serverTime = (data && data.ServerTime) || serverTime;
                    continue;
                }
                if (r === 'inflight') { wakes.push(now + GIFT_GAP_MS); continue; }
                // rejected / error：gift() 已按阶梯 bumpFail，把退避重试点纳入排程（不再无限狂发）
                var fs2 = failState[s.skinId];
                if (fs2) wakes.push(fs2.notBeforeMs);
                continue;
            }

            // 未就绪：仅冷却未到，按 endTime 精确排下次复查。server 秒差换算成墙上毫秒
            log.debug('skin %d owned but cooling down: endTime=%d > serverTime=%d (in %ds).',
                s.skinId, st.endTime, serverTime, Math.max(0, st.endTime - serverTime));
            wakes.push(now + Math.max(0, (st.endTime - serverTime)) * 1000 + CD_BUFFER_MS);
        }
    } finally {
        ticking = false;
    }

    if (!aliveFn()) return;
    now = Date.now();

    if (didGift) {
        schedule(cfg.busyInterval);
        return;
    }
    if (wakes.length) {
        var minWake = Math.min.apply(null, wakes);
        var delay = minWake - now;
        // 夹在 [MIN_WAKE_MS, idleInterval]：长冷却/长退避也至少每 idleInterval 复查一次（读请求，兜住时钟漂移/状态变化）
        schedule(Math.min(Math.max(delay, MIN_WAKE_MS), cfg.idleInterval));
        return;
    }
    schedule(cfg.idleInterval);
}

/**
 * 赠送一个技能给指定 UID（1753）。永不 reject；返回结果状态，供 tick 决定是否退避。
 * isSending 去重闸门：1753 在途时返回 'inflight'（瞬态，不计失败退避）。
 * 成功清退避并用应答回读 endTime/dailyCnt 更新本轮 map；被拒/异常按阶梯 bumpFail（不写游戏本地数据）。
 * @param {number} skinId 皮肤 id
 * @param {string} uid 目标玩家 UID
 * @param {Object<number, object>} map 本轮冷却映射（成功时就地刷新）
 * @returns {Promise<'ok'|'rejected'|'error'|'inflight'>} 赠送结果状态
 */
async function gift(skinId, uid, map) {
    if (net.isSending(CMD_USE_CITY_SKILL)) {
        log.debug('skip gift: 1753 in flight. skinId=%d', skinId);
        return 'inflight';
    }
    try {
        var ret = await net.send(CMD_USE_CITY_SKILL, { skinId: skinId, targetUid: String(uid) });
        if (ret.ok) {
            var d = typeof ret.data === 'string' ? JSON.parse(ret.data) : (ret.data || null);
            if (d && d.skinId != null) {
                map[d.skinId] = { endTime: Number(d.endTime) || 0, dailyCnt: Number(d.dailyCnt) || 0 };
            }
            delete failState[skinId];
            log.info('gift city skin ok. skinId=%d;targetUid=%s', skinId, uid);
            return 'ok';
        }
        bumpFail(skinId);
        log.info('gift city skin rejected, backoff. skinId=%d;targetUid=%s;code=%d', skinId, uid, ret.code);
        return 'rejected';
    } catch (err) {
        bumpFail(skinId);
        log.warn('gift city skin error, backoff. skinId=%d;targetUid=%s', skinId, uid, err);
        return 'error';
    }
}

/**
 * 记一次赠送失败并推后退避：连续失败次数 +1，按 BACKOFF_MS 阶梯取下次可重试的墙上时刻（末项封顶）。
 * @param {number} skinId 皮肤 id
 * @returns {void}
 */
function bumpFail(skinId) {
    var fs = failState[skinId] || (failState[skinId] = { count: 0, notBeforeMs: 0 });
    fs.count++;
    var idx = Math.min(fs.count - 1, BACKOFF_MS.length - 1);
    fs.notBeforeMs = Date.now() + BACKOFF_MS[idx];
}

// ─────────────────────────── 生命周期 ───────────────────────────

/**
 * 安装：取网络底座 + 数据中心（必需）。技能无每日次数限制，就绪只看冷却，不再需要 GameTools。
 * 必需依赖缺失即失败（reactor 不会激活）。
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
 * 运行：复位闸门，立即跑一轮（之后由冷却/次数到期点驱动）。
 * reactor pause 会自动摘除此处登记的触发器并置 alive=false，定时器自然停摆；resume 重新点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    ticking = false;
    log.info('started, %d skill(s).', skills.length);
    // 启动即查一次；本轮结束后 tick 末尾按到期点 / idle 武装下一轮
    schedule(0);
}

/**
 * 向 reactor 注册本功能说明书：scenes 限定 Home/NWorldMap，战斗态暂停（offInCombat）。
 */
reactor.register({
    id: 'citySkill',
    label: '城市技能',
    storageKey: 'pocketcc.feat.citySkill',
    scenes: ['Home', 'NWorldMap'],
    offInCombat: true,
    defaults: {
        enabled: false,
        roseEnabled: false, roseUid: '', roseName: '',
        heartEnabled: false, heartUid: '', heartName: '',
    },
    fields: [
        { key: 'roseUid', nameKey: 'roseName', enableKey: 'roseEnabled', label: '赠送玩家', type: 'uid', placeholder: '请输入玩家UID', section: '玫花幽香' },
        { key: 'heartUid', nameKey: 'heartName', enableKey: 'heartEnabled', label: '赠送玩家', type: 'uid', placeholder: '请输入玩家UID', section: '芳心萌动' },
    ],
    toModuleCfg: function (c) {
        return {
            skills: [
                { skinId: SKILL_ROSE, enabled: c.roseEnabled, uid: c.roseUid },
                { skinId: SKILL_HEART, enabled: c.heartEnabled, uid: c.heartUid },
            ],
        };
    },
    install: install,
    configure: configure,
    run: run,
});
