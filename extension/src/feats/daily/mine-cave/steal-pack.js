/**
 * 次元矿洞 · ② 盗窃与封存引擎（StealEngine）
 *
 * 职责：只在「裂隙矿场」(7415) 里——偷取(7419) / 封存(7420) / 加速帮忙(7418)。
 *   - 检测(读池 refresh:0)与刷新(换矿 refresh:1)解耦：
 *       刷新按冷热权重把每日预算(≈30)均铺到 20:00；检测按事件(刷新点/矿就绪/兜底 5min)驱动。
 *   - 偷/封/加速都依「已勾选规则」过滤目标；无规则则不换矿（不白耗每日预算），仍可免费读池观测。
 * 有自己的队列/drain/定时器/刷新预算，与 ① 挖矿完全独立。
 * 注：盟友矿「帮忙封存」已按需求取消，封存只发生在裂隙矿场，故 packLeft 名额专属于本引擎。
 */
import { createLog } from '../../../core/log.js';
import { createDrain } from '../../../core/drain.js';
import { gameData } from '../../../core/game-api.js';
import { idKey, int64ToNum, rejectText } from './util.js';
import { activeRules, matchSpec, specStar } from './match.js';

const log = createLog('MINE-CAVE/STEAL');

// ── ② 盗窃封存：本引擎独占的协议号（无跨文件复用，故就近私有）──
const CMD_WORLD_INFO = 7415;   // 裂隙矿场（refresh:0 读 / refresh:1 换矿）
const CMD_STEAL = 7419;        // 偷取
const CMD_HELP_PACK = 7420;    // 封存/帮打包
const CMD_HELP = 7418;         // 加速帮忙
const ACTION_GAP_MS = 1200;    // drain 相邻两次动作的最小间隔（本引擎发送节奏，与 ① 各自独立）

// ── ② 专属调度阈值 ──
const WORLD_HOURS_END = 20;              // 每日刷新须在 20:00 前用完；间隔按剩余次数+冷热权重分配到此时刻
const WORLD_MIN_REFRESH_GAP_MS = 60_000; // 动态刷新节流下限，避免临近截止时密集触发频控
const WORLD_HOT_W = 2.5;                 // 热点时段每小时刷新权重（更密）
const WORLD_COLD_W = 1.41;               // 冷时段每小时刷新权重
const WORLD_CHECK_MAX_MS = 300_000;      // 无待办事件时，检测最迟每 5min 一次（兜底捕捉矿池变化）
const WORLD_TARGET_JITTER_MS = 15_000;   // 矿就绪时刻后延迟一点再检测，避免边界未刷新
const WORLD_READ_MIN_GAP_MS = 60_000;    // 世界池最小读取间隔

/**
 * ② 盗窃与封存引擎：只在裂隙矿场(7415) 偷取/封存/加速帮忙。
 * 拥有独立的队列 / drain / 定时器 / 世界刷新预算，与 ① 挖矿解耦。
 * （盟友矿“帮忙封存”已按需求取消，封存只发生在裂隙，故 packLeft 名额专属本引擎。）
 */
export class StealEngine {
    #env;

    #queue = [];
    #scanning = false; #consuming = false; #scanPending = false;
    #scanTimer = null;

    #lastWorldTs = 0;
    #worldBudgetTotal = 0;
    #worldCanRefreshLeft = 0;    // 服务器剩余可刷新次数（权威硬停）
    #nextWorldRefreshAt = 0;     // 下次「换矿刷新」时刻（冷热加权均分到 20:00）
    #nextWorldCheckAt = 0;       // 下次「检测读池」时刻（综合刷新点/矿就绪/兜底）
    #worldEndTs = 0;             // 当日裂隙活动结束时刻（日界/额度重置参考）
    #stealDoneNum = 0; #stealMaxNum = 0;
    #packDoneNum = 0; #packMaxNum = 0; #packLeft = 0;
    #blockedToday = new Set();
    #drain;

    /** @param {import('./mining.js').MineEngineEnv} env 共享运行环境 */
    constructor(env) {
        this.#env = env;
        this.#drain = createDrain({
            log: log,
            queue: { get: () => this.#queue },
            alive: () => this.#env.alive(),
            process: (t) => this.#execTask(t),
            interval: () => ACTION_GAP_MS,
        });
    }

    // ─────────── 生命周期 ───────────
    /**
     * 启动引擎：重置状态并触发首轮扫描（世界刷新靠自身预算定时器，不订阅推送）。
     * @param {*} ctx reactor 运行上下文
     */
    start(ctx) {
        this.#reset();
        log.info('steal-pack started.');
        this.#triggerScan();
    }

    #reset() {
        if (this.#scanTimer) { clearTimeout(this.#scanTimer); this.#scanTimer = null; }
        this.#scanning = false; this.#consuming = false; this.#scanPending = false;
        this.#queue = [];
        this.#blockedToday.clear();
        this.#lastWorldTs = 0;
        this.#worldBudgetTotal = 0; this.#worldCanRefreshLeft = 0;
        this.#nextWorldRefreshAt = 0; this.#nextWorldCheckAt = 0; // 归零→启动先 refresh:0 读 canRefreshNum 重建计划
        this.#worldEndTs = 0;
        this.#stealDoneNum = 0; this.#stealMaxNum = 0; this.#packDoneNum = 0; this.#packMaxNum = 0; this.#packLeft = 0;
    }

    kick() { if (this.#env.alive()) this.#triggerScan(); }

    // ─────────── 规则匹配包装 ───────────
    #match(specId) { return matchSpec(specId, this.#env.getRules()); }
    #activeRuleCount() { return activeRules(this.#env.getRules()).length; }

    // ─────────── 世界刷新/检测调度（冷热加权铺到 20:00；检测事件驱动） ───────────
    #worldHourWeight(h) {
        var slots = this.#env.tuning.hotSlots;
        for (var i = 0; i < slots.length; i++) { if (h >= slots[i][0] && h < slots[i][1]) return WORLD_HOT_W; }
        return WORLD_COLD_W;
    }
    #todayHourTs(ts, h) {
        var d = new Date(ts);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0, 0).getTime();
    }
    #worldWeightBetween(t0, t1) {
        var sum = 0, cur = t0;
        while (cur < t1) {
            var h = new Date(cur).getHours();
            var segEnd = Math.min(this.#todayHourTs(cur, h + 1), t1);
            sum += (segEnd - cur) / 3_600_000 * this.#worldHourWeight(h);
            cur = segEnd;
        }
        return sum;
    }
    #worldTimeToWeight(t0, target, endTs) {
        var cur = t0, acc = 0;
        while (acc < target) {
            var h = new Date(cur).getHours();
            var w = this.#worldHourWeight(h);
            var segEnd = Math.min(this.#todayHourTs(cur, h + 1), endTs);
            var avail = (segEnd - cur) / 3_600_000 * w;
            if (acc + avail >= target) return (cur - t0) + (target - acc) / w * 3_600_000;
            acc += avail; cur = segEnd;
            if (cur >= endTs) return Infinity;
        }
        return cur - t0;
    }
    // 下次刷新时刻：剩余权重/剩余次数=单次权重，再按当前起的小时密度换算成时间。每轮刷新后重算。
    #planWorldRefresh(now) {
        var end = this.#todayHourTs(now, WORLD_HOURS_END);
        if (end <= now || this.#worldCanRefreshLeft <= 0) { this.#nextWorldRefreshAt = Infinity; return; }
        var perRefresh = this.#worldWeightBetween(now, end) / this.#worldCanRefreshLeft;
        var delay = this.#worldTimeToWeight(now, perRefresh, end);
        this.#nextWorldRefreshAt = delay === Infinity ? Infinity : now + Math.max(WORLD_MIN_REFRESH_GAP_MS, delay);
    }
    // 下次检测时刻：取「下次刷新 / 最近的矿就绪时刻+抖动 / 兜底上限」三者最早。
    #planWorldCheck(now, world) {
        var next = Math.min(this.#nextWorldRefreshAt, now + WORLD_CHECK_MAX_MS);
        if (world && world.infos) {
            for (var i = 0; i < world.infos.length; i++) {
                var si = (world.infos[i] || {}).simpleInfo || {};
                var ge = int64ToNum(si.gatherEndTime);
                if (ge > now && ge + WORLD_TARGET_JITTER_MS < next) next = ge + WORLD_TARGET_JITTER_MS;
            }
        }
        this.#nextWorldCheckAt = next;
    }
    // 偷/封双满 → 换矿已无收益，停止刷新的依据。
    #worldRefreshBenefit() {
        return !(this.#stealMaxNum > 0 && this.#stealDoneNum >= this.#stealMaxNum && this.#packMaxNum > 0 && this.#packDoneNum >= this.#packMaxNum);
    }

    // ─────────── 调度器（仅世界：检测点 + 最小读间隔，无盟友/自矿） ───────────
    #nextWakeDelay() {
        var now = Date.now();
        var worldWake = Math.max(this.#nextWorldCheckAt, this.#lastWorldTs + WORLD_READ_MIN_GAP_MS);
        var min = worldWake <= now ? 1000 : (worldWake - now);
        if (this.#worldEndTs > 0 && this.#worldEndTs > now) min = Math.min(min, this.#worldEndTs - now);
        min = Math.min(min, 300_000); // 保底 5min
        return Math.max(5000, min);
    }
    #scheduleScan(delay) {
        if (!this.#env.alive()) return;
        if (this.#scanTimer) clearTimeout(this.#scanTimer);
        var d = Math.max(0, delay);
        if (this.#worldEndTs > 0) {
            var toEnd = this.#worldEndTs - Date.now();
            if (toEnd > 0 && toEnd < d) d = Math.max(15000, toEnd);
        }
        this.#scanTimer = setTimeout(() => {
            this.#scanTimer = null;
            if (this.#env.alive()) this.#triggerScan();
        }, d);
    }
    #triggerScan() {
        if (!this.#env.alive()) return;
        if (this.#scanning || this.#consuming) { this.#scanPending = true; return; }
        this.#doScan().catch((err) => { log.warn('scan threw.', err); this.#afterRound(); });
    }
    #afterRound() {
        if (!this.#env.alive()) return;
        if (this.#scanPending) { this.#scanPending = false; this.#triggerScan(); return; }
        this.#scheduleScan(this.#nextWakeDelay());
    }

    // ─────────── 主扫描 ───────────
    async #doScan() {
        this.#scanning = true;
        this.#queue = [];
        try {
            if (this.#env.getData() && this.#env.inAlliance()) {
                // 过当日结束点：清拉黑 + 重置刷新/检测计划，等下一次读池重建预算
                if (this.#worldEndTs && Date.now() > this.#worldEndTs) {
                    this.#blockedToday.clear(); this.#worldEndTs = 0;
                    this.#nextWorldRefreshAt = 0; this.#nextWorldCheckAt = 0;
                }
                var now = Date.now();
                var tasks = [];
                if (now >= this.#nextWorldCheckAt && now - this.#lastWorldTs >= WORLD_READ_MIN_GAP_MS) {
                    // 无已勾选规则=不采，不发换矿刷新(refresh:1 耗每日预算)；仍走 refresh:0 免费读维持 canRefreshNum 观测
                    var doRefresh = this.#activeRuleCount() > 0 && this.#worldCanRefreshLeft > 0
                        && now >= this.#nextWorldRefreshAt && this.#worldRefreshBenefit();
                    var world = await this.#fetchWorldInfo(doRefresh);
                    if (world && this.#env.alive()) {
                        this.#lastWorldTs = Date.now();
                        this.#worldTasks(world, tasks);
                        var n2 = Date.now();
                        this.#planWorldRefresh(n2);        // 依服务器回传 canRefreshNum 重排下次刷新
                        this.#planWorldCheck(n2, world);   // 综合刷新点/矿就绪/兜底重排下次检测
                    }
                }
                this.#queue = tasks;
            }
        } catch (err) { log.warn('scan error.', err); this.#queue = []; }
        finally { this.#scanning = false; }

        if (!this.#env.alive()) return;
        this.#consuming = true;
        this.#drain.consume().then(
            () => { this.#consuming = false; this.#afterRound(); },
            (err) => { this.#consuming = false; log.warn('consume threw.', err); this.#afterRound(); },
        );
    }

    // ─────────── 数据拉取 ───────────
    async #fetchWorldInfo(refresh) {
        var ret = await this.#env.ask(CMD_WORLD_INFO, { refresh: refresh ? 1 : 0 }, refresh ? 'world-refresh' : 'world-info');
        if (ret.ok && ret.data) { this.#updateWorldSnap(ret.data); return ret.data; }
        return null;
    }

    // 依服务器回传复位偷/封/刷新日额与当日结束点（每次读池权威刷新）。
    #updateWorldSnap(world) {
        this.#stealDoneNum = Number(world.stealNum) || 0; this.#stealMaxNum = Number(world.stealAllNum) || 0;
        this.#packDoneNum = Number(world.packNum) || 0; this.#packMaxNum = Number(world.packAllNum) || 0;
        this.#worldBudgetTotal = this.#env.cfgSeg(1062, 0); // 每日总预算（常量口径）
        this.#worldCanRefreshLeft = (world.canRefreshNum != null && !isNaN(Number(world.canRefreshNum)))
            ? Math.max(0, Number(world.canRefreshNum)) : this.#worldBudgetTotal;
        this.#packLeft = this.#packMaxNum > 0 ? Math.max(0, this.#packMaxNum - this.#packDoneNum) : 0;
        var endMs = int64ToNum(world.endTime);
        this.#worldEndTs = endMs > 1e11 ? endMs : endMs * 1000;
    }

    // ─────────── 任务生成 ───────────
    #minePerStealCap() {
        var row = gameData.mineInteraction(3);
        var v = row ? Number(row.help_accept) : 0;
        return v > 0 ? v : Infinity;
    }

    #worldTasks(world, tasks) {
        var infos = world.infos || [];
        var stealMax = Number(world.stealAllNum) || 0;
        var stealDone = Number(world.stealNum) || 0;
        var perMineCap = this.#minePerStealCap();
        var stealLine = [];
        for (var i = 0; i < infos.length; i++) {
            var e = infos[i], si = e.simpleInfo || {};
            if (si.id == null) continue;
            var uid = e.ownerUid != null ? e.ownerUid : (e.uid != null ? e.uid : 0);
            var specOk = this.#match(si.specId);
            var key = idKey(si.id) + '|' + uid;
            var blocked = this.#blockedToday.has(key);
            if (specOk && Number(si.canSteal) === 1 && (Number(e.stealNum) || 0) < perMineCap && !blocked) {
                stealLine.push({ k: 'steal', id: si.id, uid: uid, serverId: e.serverId, specId: si.specId });
            }
            if (specOk && Number(si.canPack) === 1 && this.#packLeft > 0 && !blocked) {
                tasks.push({ k: 'pack', id: si.id, uid: uid }); this.#packLeft--;
            }
            if (Number(si.canHelp) === 1) tasks.push({ k: 'help', id: si.id, uid: uid });
        }
        stealLine.sort(function (a, b) { return specStar(b.specId) - specStar(a.specId); });
        for (var s = 0; s < stealLine.length && stealDone < stealMax; s++) { tasks.push(stealLine[s]); stealDone++; }
    }

    // ─────────── 执行器 ───────────
    async #execTask(task) {
        switch (task.k) {
            case 'steal': await this.#execSteal(task); break;
            case 'pack': await this.#execPack(task); break;
            case 'help': await this.#execHelp(task); break;
        }
    }

    async #execSteal(task) {
        var ret = await this.#env.ask(CMD_STEAL, { id: task.id, uid: task.uid, serverId: task.serverId }, 'steal');
        // 业务规则：每个裂隙矿自己只能偷 1 次（下次刷新可能再遇到），无论成败当日都拉黑不再偷。
        this.#blockedToday.add(idKey(task.id) + '|' + task.uid);
        if (ret.ok) { log.info('steal ok. id=%s', idKey(task.id)); }
        // 被拒多为良性（今日已偷/被偷满，服务器回 code=3+全零体），无诊断价值 → 降 debug 不打载荷。
        else { log.debug('steal rejected code=%d (already stolen / full), skip. id=%s', ret.code, idKey(task.id)); }
    }
    async #execPack(task) {
        var ret = await this.#env.ask(CMD_HELP_PACK, { id: task.id, uid: task.uid }, 'pack');
        if (ret.ok) { log.debug('pack ok. id=%s', idKey(task.id)); }
        else { this.#blockedToday.add(idKey(task.id) + '|' + task.uid); log.warn('pack rejected. code=%d;msg=%s', ret.code, rejectText(ret.data)); }
    }
    async #execHelp(task) {
        var ret = await this.#env.ask(CMD_HELP, { id: task.id, uid: task.uid }, 'help');
        log.debug(ret.ok ? 'help ok.' : 'help rejected. code=%d', ret.code);
    }
}
