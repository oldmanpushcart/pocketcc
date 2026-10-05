/**
 * 遗迹奖励领取 —— 2 级道具遗迹（WorldSite / Fortress）自动领取（reactor 说明书形态，日常任务，单文件）。
 *
 * 玩法：本盟名下的 2 级道具遗迹（DistrictData.stronghold_level==2 且 function==4=ITEM）周期性开放一轮礼品，
 *   每轮从固定礼品池里开出 5 个候选（select 值为奖励配置 id，逐遗迹各异、不通用），玩家最多领 choose_num 枚；一天可开 2 轮、窗口大。
 *   礼品池以「道具 itemId」为准（攻略列出的全部奖励）：引擎对每个候选配置 id 经 rewardItems 解析出主道具 itemId 再与池比对，
 *   故同一道具在不同遗迹的不同配置 id 都能命中同一池条目。两个 2 级遗迹共用同一份 itemId 池，同轮候选可不一致但必定都在池内。
 *
 * 协议族（源码 RequestId 实证，均走 net.send 旧 JSON 链路，ret.d 为 JSON 串）：
 *   查询 1825 GET_FORTRESS_CHOOSE_ITEM_REWARD_DATA {wonderId} → {select:[奖励配置id×5], have:[已领index], id(cfgId), joinTime, endTime}；
 *   领取 1826 FORTRESS_CHOOSE_ITEM_REWARD {wonderId, index} → {reward:{...}, select, have:[更新后], id, endTime}（应答带最新 have，服务端为准）。
 *   扩展留口：军队遗迹用 1827/1828（GET/CHOOSE_ARMY_REWARD）族 + sp_fortress_army 表，加一行规格 + 对应池即可复用本引擎（本轮只做道具）。
 *
 * 判据（对齐游戏红点 getItemWorldSiteRed）：sp_fortress_item[cfgId].choose_num - have.length > 0 且
 *   ServerTime - joinTime > join_time（入盟冷却）。otherToday 仅存在于 1070 条目、1825 应答缺省视为 undefined（不拦截）。
 *   候选匹配：have 未含、且 select[idx] 解析出的主道具 itemId 在优先级池内（不在池内者不领，不当最低优先级处理），按 rank 升序逐个领。
 *   注意：getRewardsArrById().name 返回的是未翻译的本地化键（如 "107068"/"item_name3300001"）而非中文名，故匹配一律走 itemId(.id)，
 *   道具名仅用于面板/日志展示（走 core/item.js 的 label：登记表 → l10n.text(locKey) → "道具 <id>"）。
 *
 * 权威态：本地 myItemSiteData 只由游戏自身 1070/1825 应答填充（脚本直发不经游戏回调、不回写它），故每次扫描都自行
 *   发 1825 取权威 select/have（防跨设备/他人领取假象），结果落本模块 mirror（面板状态与领取循环共读它）。
 *
 * 拒绝处理：领取被非 0 码拒绝 → 该遗迹当日拉黑（落 storage.data，跨日清空），防刷屏（对齐「被拒当日拉黑」既有教训）。
 *
 * 触发：run 点火即扫一轮，随后 POLL_INTERVAL 低频轮询；并按 mirror 里最近的 endTime +FLIP_BUFFER_MS 收拢下次轮询拍，
 *   覆盖「一天开 2 次」的新窗口（不用干等整轮询拍）。单一在飞闸门 scanning 防重入；alive()=false 时循环自然退出。
 *
 * 合规：只读游戏数据（经 game-api ACL）+ 直发 1825/1826，不调用游戏 Update/Delete 改写本地态、不 OpenUI、不模拟点击。
 *   纯发包、不派行军，不受战斗模式门控（同联盟帮助口径，不设 offInCombat）；生命周期由 reactor 托管，pause 摘触发器、
 *   resume 补扫一轮。面板：整池奖励摆出，拖拽整行调先后 = 领取优先级（配置只存顺序，全员默认参与）。
 */
import { createLog } from '../../core/log.js';
import { bus } from '../../core/bus.js';
import { storage } from '../../core/storage.js';
import { reactor } from '../../core/reactor.js';
import { l10n, gameData } from '../../core/game-api.js';
import { item } from '../../core/item.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=RELIC-REWARD） */
const log = createLog('RELIC-REWARD');

/** @type {number} RequestId.GET_FORTRESS_CHOOSE_ITEM_REWARD_DATA，查询遗迹本轮候选/已领（载荷 {wonderId}） */
const CMD_QUERY = 1825;
/** @type {number} RequestId.FORTRESS_CHOOSE_ITEM_REWARD，领取一枚选定候选（载荷 {wonderId, index}） */
const CMD_CLAIM = 1826;

/** @type {number} 遗迹等级过滤：2 级道具遗迹（DistrictData.stronghold_level） */
const SITE_LEVEL = 2;
/** @type {number} WorldSiteFunType.ITEM=4（道具类遗迹；军队遗迹=3，本功能不涉及） */
const SITE_FUNTYPE_ITEM = 4;

/**
 * 2 级道具遗迹固定礼品池：攻略列出的全部奖励「道具 itemId」（默认优先级 = 攻略序号顺序，面板可 ↑/↓ 调整）。
 * 引擎对 1825 应答 select[] 的每个奖励配置 id 经 gameData.rewardItems 解析出主道具 itemId(items[0].id)，与本池精确匹配，
 * 因此不依赖逐遗迹各异、且服务器下发的不透明配置 id——同一道具在两个遗迹里的不同配置 id 都能命中同一池条目。
 * itemId 唯一且稳定（实证：cfgId 5 池 = reward 8301732..8301744、cfgId 6 池 = 8301745..8301757，两套连号逐位映射到同一 13 个 itemId）。
 * @type {number[]}
 */
const L2_ITEM_POOL = [
    600002, 3300001, 500001, 2300002, 2560001, 1700013, 323001,
    3610009, 1600029, 1700402, 99910001, 99910101, 2800000,
];

/** @type {number} 全天低频轮询间隔（毫秒）：漏扫/领取瞬断最迟一个周期内补 */
const POLL_INTERVAL = 1000 * 60 * 10;
/** @type {number} 同遗迹连领多枚的间距（毫秒，同 cmd 频控安全间距） */
const CLAIM_GAP_MS = 600;
/** @type {number} 窗口 endTime 到点后的翻轮补扫余量（毫秒），避开服务器结算时序 */
const FLIP_BUFFER_MS = 1000 * 30;
/** @type {number} 非服务器返回的哨兵 code（在途频控/发送异常，与真实 s 码区分，不当拒绝拉黑） */
const CODE_NOT_SENT = -1;
/** @type {string} 当日拉黑持久数据键（storage.data blob 内逻辑名） */
const DATA_NAME = 'relicReward.rejected';

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} reactor 上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;
/** @type {boolean} 单轮扫描在飞闸门（含 1825/1826 的 await），防重入 */
var scanning = false;
/** @type {number|null} 轮询/翻轮共用排程定时器 */
var pollTimer = null;
/** @type {number[]} 当前领取优先级顺序（道具 itemId，靠前者优先），configure 从面板配置写入 */
var order = L2_ITEM_POOL.slice();
/** @type {Map<number,number>} itemId → rank（order 下标），O(1) 匹配与排序 */
var rankMap = new Map();
/**
 * 权威遗迹态镜像（本模块自 1825/1826 应答维护，非游戏 myItemSiteData）：wonderId →
 *   {cfgId, name, select:number[], selectIds:number[], selectNames:string[], have:number[], joinTime, endTime, chooseNum, joinSec}。
 * @type {Object<string, object>}
 */
var mirror = {};
/** @type {{day:string, sites:number[]}} 当日领取被拒拉黑（跨日清空，落 storage.data） */
var rejected = { day: '', sites: [] };

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
    return ctxRef ? ctxRef.alive() : false;
}

// ── 小工具 ──────────────────────────────────────────────────────────────
/**
 * 今日日期串 YYYY-MM-DD（当地时区，跨日失效判据）
 * @returns {string}
 */
function todayStr() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 安全序列化拒绝载荷：应答 data 可能是对象，String() 退化成 [object Object] 丢失拒绝原因
 * @param {*} v ret.data
 * @returns {string}
 */
function safeStringify(v) {
    if (v == null) return String(v);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/**
 * 旧 JSON 链路应答归一化：ret.data 通常是 JSON 串（游戏侧 JSON_PARSE(t.d)），兜底已是对象
 * @param {object} ret net.Ret
 * @returns {object|null} 解析后的业务数据；非对象返回 null
 */
function payloadOf(ret) {
    var d = ret && ret.data;
    if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { return null; }
    }
    return (d && typeof d === 'object') ? d : null;
}

/**
 * 等待毫秒（裸 sleep，pause 语义由循环内 aliveFn() 检查承担）
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms | 0)); });
}

/**
 * 秒数 → hh:mm:ss（预留：当前面板不再展示窗口剩余，保留供日志/未来用）
 * @param {number} sec
 * @returns {string}
 */
function fmtHMS(sec) {
    sec = Math.max(0, sec | 0);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p(h) + ':' + p(m) + ':' + p(s);
}

// ── 优先级（configure / rankMap） ────────────────────────────────────────
/**
 * 池驱动升档迁移：保留 incoming 中仍在池内的 itemId（维持其相对顺序），再追加池中未出现的 itemId 到末尾，丢弃池中已消失的 itemId。
 * @param {*} raw 面板/存档的 order 原值（可能是非数组，或旧版字符串名——Number 转换后自然被丢弃）
 * @returns {number[]} 规范化后的完整池顺序
 */
function migrateOrder(raw) {
    var incoming = Array.isArray(raw) ? raw.map(function (x) { return Number(x); }).filter(function (n) { return isFinite(n); }) : [];
    var out = [];
    for (var i = 0; i < incoming.length; i++) {
        if (L2_ITEM_POOL.indexOf(incoming[i]) !== -1 && out.indexOf(incoming[i]) === -1) out.push(incoming[i]);
    }
    for (var j = 0; j < L2_ITEM_POOL.length; j++) {
        if (out.indexOf(L2_ITEM_POOL[j]) === -1) out.push(L2_ITEM_POOL[j]);
    }
    return out;
}

/**
 * 注入模块配置：写优先级顺序（itemId）并重建 itemId → rank Map（运行中改序下一轮扫描即生效）。
 * @param {object} partial { order: number[] }（toModuleCfg 产出）
 */
function configure(partial) {
    order = migrateOrder(partial && partial.order);
    rankMap = new Map();
    for (var i = 0; i < order.length; i++) rankMap.set(order[i], i);
}

// ── 发包 ────────────────────────────────────────────────────────────────
/**
 * 直发一条旧 JSON 请求并归一化应答，永不 reject。在途频控（同 cmd）回落 CODE_NOT_SENT 哨兵。
 * @param {number} cmd 命令号
 * @param {object} body 载荷
 * @returns {Promise<{ok:boolean, code:number, data:*, payload:object|null}>}
 */
async function sendRaw(cmd, body) {
    if (net.isSending(cmd)) return { ok: false, code: CODE_NOT_SENT, data: null, payload: null };
    var ret;
    try {
        ret = await net.send(cmd, body);
    } catch (err) {
        log.debug('cmd %d send failed: %s', cmd, err && err.message);
        return { ok: false, code: CODE_NOT_SENT, data: null, payload: null };
    }
    return { ok: ret.ok, code: ret.code, data: ret.data, payload: payloadOf(ret) };
}

// ── 当日拉黑 ─────────────────────────────────────────────────────────────
/**
 * 跨日收敛：日期一变即清空内存拉黑表（storage 侧读回时同样按 date 过滤）
 */
function ensureDay() {
    var today = todayStr();
    if (rejected.day === today) return;
    rejected = { day: today, sites: [] };
}

/**
 * 读回当日拉黑（run 启动时一次）：仅当存档 date 与今日相符才采纳，否则视为空（跨日自愈）
 * @returns {Promise<void>}
 */
async function loadRejected() {
    ensureDay();
    var saved = null;
    try { saved = await storage.data.get(DATA_NAME); } catch (e) { saved = null; }
    if (saved && typeof saved === 'object' && saved.date === todayStr() && Array.isArray(saved.sites)) {
        rejected = { day: saved.date, sites: saved.sites.map(Number).filter(isFinite) };
    }
}

/**
 * 拉黑一个遗迹至当日不再重发（落 storage.data，失败仅记日志）
 * @param {number} wonderId
 * @returns {Promise<void>}
 */
async function rejectToday(wonderId) {
    ensureDay();
    if (rejected.sites.indexOf(wonderId) === -1) rejected.sites.push(wonderId);
    try { await storage.data.set(DATA_NAME, { date: rejected.day, sites: rejected.sites }); }
    catch (err) { log.warn('persist rejected failed.', err); }
}

// ── 领取主链 ─────────────────────────────────────────────────────────────
/**
 * 领取单个遗迹一轮：发 1825 取权威 select/have → 判 ready → 按优先级领满名额或候选耗尽即止。
 * 应答合并更新 mirror.have；被非 0 码拒绝即当日拉黑该遗迹并收手。永不 reject。
 * @param {object} site gameData.relicRewardSites 产出的候选（{wonderId, name, ...}）
 * @returns {Promise<void>}
 */
async function claimSite(site) {
    var wonderId = site.wonderId;
    var q = await sendRaw(CMD_QUERY, { wonderId: wonderId });
    if (!aliveFn()) return;
    if (!q.ok || !q.payload) {
        if (q.code !== CODE_NOT_SENT) log.info('relic query rejected. site=%d;code=%d;data=%s', wonderId, q.code, safeStringify(q.data));
        return;
    }
    var d = q.payload;
    var cfgId = Number(d.id) || 0;
    var row = cfgId ? l10n.tableRow('sp_fortress_item', cfgId) : null;
    var chooseNum = row ? Number(row.choose_num) || 0 : 0;
    var joinSec = row ? Number(row.join_time) || 0 : 0;
    var have = Array.isArray(d.have) ? d.have.map(Number) : [];
    var select = Array.isArray(d.select) ? d.select.map(Number) : [];
    var joinTime = Number(d.joinTime) || 0;
    var endTime = Number(d.endTime) || 0;
    // 逐候选解析主道具 itemId + 展示名（配置 id → rewardItems → items[0]）；解析失败记 itemId=0，池外不领
    var selectIds = [];
    var selectNames = [];
    for (var si = 0; si < select.length; si++) {
        var r = item.fromReward(select[si]);
        if (!r.itemId) log.debug('reward cfg %d unresolvable item (site=%d).', select[si], wonderId);
        selectIds.push(r.itemId);
        selectNames.push(r.itemId ? item.label(r.itemId, r.rawName) : '');
    }
    mirror[wonderId] = { cfgId: cfgId, name: String(site.name || ''), select: select, selectIds: selectIds, selectNames: selectNames, have: have, joinTime: joinTime, endTime: endTime, chooseNum: chooseNum, joinSec: joinSec };

    // ready 判据（红点口径）：有空余名额 且 过入盟冷却
    if (!(chooseNum - have.length > 0)) return;
    if (joinSec > 0 && (gameData.serverTime() - joinTime) <= joinSec) {
        log.debug('relic site %d in join cooldown, skip.', wonderId);
        return;
    }

    // 候选：have 未含、且 select[idx] 解析出的主道具 itemId 在优先级池内（池外不领），按 rank 升序
    var cand = [];
    for (var idx = 0; idx < select.length; idx++) {
        if (have.indexOf(idx) !== -1) continue;
        var rank = rankMap.get(selectIds[idx]);
        if (rank === undefined) continue;
        cand.push({ idx: idx, rank: rank, rewardId: select[idx], itemId: selectIds[idx], name: selectNames[idx] });
    }
    cand.sort(function (a, b) { return a.rank - b.rank; });

    var slots = chooseNum - have.length;
    for (var k = 0; k < cand.length && slots > 0; k++) {
        if (!aliveFn()) break;
        var c = cand[k];
        var r = await sendRaw(CMD_CLAIM, { wonderId: wonderId, index: c.idx });
        if (!aliveFn()) break;
        if (r.ok) {
            // 应答带更新后的 have（服务端为准），合并进镜像
            var nh = (r.payload && Array.isArray(r.payload.have)) ? r.payload.have.map(Number) : null;
            if (nh) { have = nh; mirror[wonderId].have = have; }
            else { have.push(c.idx); mirror[wonderId].have = have; }
            slots = chooseNum - have.length;
            log.info('relic claim ok. site=%d(%s);idx=%d;reward=%d;item=%d(%s);have=%d/%d', wonderId, site.name || '', c.idx, c.rewardId, c.itemId, c.name || '?', have.length, chooseNum);
            bus.emit('ui.refresh');
        } else if (r.code === CODE_NOT_SENT) {
            break;   // 在途/超时：本轮此遗迹收手，留给下次唤醒/轮询
        } else {
            log.info('relic claim rejected, blacklist today. site=%d;idx=%d;code=%d;data=%s', wonderId, c.idx, r.code, safeStringify(r.data));
            await rejectToday(wonderId);
            return;
        }
        if (slots > 0) await sleep(CLAIM_GAP_MS);
    }
}

/**
 * 扫一轮：取本盟 2 级道具遗迹候选 → 逐个（跳过当日拉黑）发 1825 判 ready 并领取。永不 reject。
 * @returns {Promise<void>}
 */
async function scanOnce() {
    var sites = gameData.relicRewardSites(SITE_LEVEL, SITE_FUNTYPE_ITEM);
    if (!sites.length) {
        log.debug('no level-2 item relic found.');
        return;
    }
    ensureDay();
    for (var i = 0; i < sites.length; i++) {
        if (!aliveFn()) break;
        if (rejected.sites.indexOf(sites[i].wonderId) !== -1) continue;
        await claimSite(sites[i]);
    }
    bus.emit('ui.refresh');
}

/**
 * 扫描触发汇入口：run 点火 / 排程定时器到点都走这里。在飞时不并发进入。
 */
function triggerScan() {
    if (!aliveFn() || scanning) return;
    scanning = true;
    scanOnce().catch(function (err) {
        log.warn('scan threw.', err);
    }).then(function () {
        scanning = false;
        if (aliveFn()) scheduleNext();
    });
}

/**
 * 排下一轮扫描：默认 POLL_INTERVAL；若 mirror 里有更近的 endTime，收敛到「到点 +FLIP_BUFFER_MS」那拍
 *   （覆盖一天开 2 次的新窗口，不用干等整轮询）。封顶不低于 1s 防热循环。
 */
function scheduleNext() {
    if (!aliveFn()) return;
    if (pollTimer) clearTimeout(pollTimer);
    var nowMs = gameData.serverTime() * 1000;
    var ms = POLL_INTERVAL;
    for (var w in mirror) {
        var et = (Number(mirror[w].endTime) || 0) * 1000 + FLIP_BUFFER_MS;
        if (et > nowMs && et - nowMs < ms) ms = et - nowMs;
    }
    log.debug('next scan in %d s', Math.round(ms / 1000));
    pollTimer = setTimeout(function () {
        pollTimer = null;
        if (aliveFn()) triggerScan();
    }, Math.max(1000, ms));
}

// ── 生命周期 ─────────────────────────────────────────────────────────────
/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
    ctxRef = ctx;
    net = ctx.net;
    if (!net || !net.install()) {
        log.warn('install failed: pocketcc.net unavailable');
        net = null;
        return false;
    }
    log.info('installed.');
    return true;
}

/**
 * 运行：复位在飞态 → 读回当日拉黑 → 点火即扫一轮（本地多半已有遗迹态）→ 排低频轮询/翻轮。
 * pause 后 alive()=false，定时器到点空转、在飞 await 回来即止；resume 重跑本函数补扫一轮。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
    ctxRef = ctx;
    scanning = false;
    log.info('started.');
    loadRejected().then(function () {
        if (aliveFn()) triggerScan();   // 首拍立即扫；triggerScan 末尾排后续
    });
}

/**
 * 向 reactor 注册本功能说明书：场景限定 Home/NWorldMap，无 offInCombat（纯发包不派兵）；
 *   面板单字段——领取优先级 sortlist（整池拖拽调序；遗迹状态不再在面板展示）。
 *   轮询/间距/池为内置常量；优先级顺序（order）为唯一持久配置。
 */
reactor.register({
    id: 'relicReward',
    label: '遗迹奖励',
    storageKey: 'pocketcc.feat.relicReward',
    scenes: ['Home', 'NWorldMap'],
    defaults: { enabled: false, order: L2_ITEM_POOL.slice() },
    fields: [
        {
            key: 'order', type: 'sortlist', label: '远古遗迹-道具 · 领取优先级',
            hint: '拖动调整顺序，顺序靠前优先领取',
            resolve: item.sortResolve,
        },
    ],
    toModuleCfg: function (c) { return { order: Array.isArray(c.order) ? c.order.slice() : L2_ITEM_POOL.slice() }; },
    install: install,
    configure: configure,
    run: run,
});
