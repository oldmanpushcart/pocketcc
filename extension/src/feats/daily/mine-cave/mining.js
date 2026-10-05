/**
 * 次元矿洞 · ① 挖矿引擎（MiningEngine）
 *
 * 职责：只管「挖矿」——自家矿脉 + 盟友列表。
 *   - 拉自矿聚合 7428（独立缓存/节奏）
 *   - 回收：自矿采完 / toOthers / toOtherCollects / 他人来采 / 联盟产出
 *   - 占领 7417（自矿 occ_self + 盟友 occ_ally），带自动布阵
 *   - 探测换矿 7416（0 点优先耗免费）
 *   - 盟友线 7425/7414 只取「占领」目标（不做帮忙封存——那是②之外、且已按需求取消）
 * 有自己的队列/drain/定时器/刷新节奏，与 ② 盗窃封存完全独立。
 * 无「已勾选」规则 = 不采（不占领、不探测）。
 */
import { createLog } from '../../../core/log.js';
import { createDrain } from '../../../core/drain.js';
import { gameData } from '../../../core/game-api.js';
import { idKey, rejectText } from './util.js';
import { activeRules, matchSpec, specStar } from './match.js';

const log = createLog('MINE-CAVE/MINE');

// ── ① 挖矿：本引擎独占的协议号 / 状态枚举（无跨文件复用，故就近私有）──
const CMD_SELF_INFO2 = 7428;            // 自矿聚合（SELF_MINE_CAVE_INFO2）
const CMD_REFRESH = 7416;               // 能量裂隙探测换矿
const CMD_OCCUPY = 7417;                // 占领/下矿
const CMD_SINGLE_INFO = 7421;           // 单矿详情（布阵前置查询）
const CMD_CHECK_SHARE = 7427;           // 盟友矿可占校验
const CMD_OTHER_INFO2 = 7425;           // 盟友矿概览列表
const CMD_OTHER_INFO = 7414;            // 单个盟友矿详情
const CMD_REWARD = 7422;                // 采集/行军产出领取
const CMD_OTHER_GATHER_REWARD = 7424;   // 他人来采我的产出领取
const CMD_ALLIANCE_REWARD = 7429;       // 联盟矿洞产出领取
const PUSH_MINE_CAVE_CHANGE = 21351;    // 单矿变更推送（自矿/行军）

const STATE_NO_GATHER = 1;    // 有矿、无人采（可占领/可分享）
const STATE_GATHERING = 2;    // 正在被采集
const STATE_FINISH = 3;       // GATHER_FINISH 采集完成待领取
const STATE_STEAL_FINISH = 4; // STEAL_FINISH 已被偷取/打包完毕（行军项仍可在 7422 领）

const ACTION_GAP_MS = 1200;   // drain 相邻两次动作的最小间隔（本引擎发送节奏，与 ② 各自独立）

// ── ① 专属调度阈值 ──
const HOT_ALLY_BASE_MS = 30_000;
const HOT_ALLY_MAX_MS = 60_000;
const COLD_ALLY_BASE_MS = 60_000;
const COLD_ALLY_MAX_MS = 300_000;
const ALLY_UNCHANGED_TRIGGER = 2;
const ALLY_DEGRADE_FACTOR = 1.5;
// 单轮最多探查多少个盟友矿（7414）：候选按星降序取前 N，防连发几十个 7414 压垮服务器。
const ALLY_PROBE_MAX = 8;
// 自矿信息(7428)独立节奏：脏(push/自身动作后)或超过最长复用期才重取，否则复用缓存。
const SELF_MAX_AGE_MS = 300_000;
const PUSH_DEBOUNCE_MS = 3000;

/**
 * @typedef {Object} MineEngineEnv 两引擎共享的运行环境（由 index.js 注入）
 * @property {function(number,object,string):Promise<{ok:boolean,code:number,data:*}>} ask 统一发包壳
 * @property {function(number,number):number} cfgSeg 读 dataConfig 分段值
 * @property {function():boolean} alive 当前是否应继续运行
 * @property {function():Array<{type:number,level:number,star:number}>} getRules 当前采集规则集（行存在即生效）
 * @property {function():*} getData DataCenter.DATA 持有者
 * @property {function():boolean} inAlliance 是否结在同盟
 * @property {function():number} myUid 自己 UID（数字）
 * @property {{hotSlots:Array<Array<number>>}} tuning 跨引擎领域调参：hotSlots=每日热点时段 [start,end) 小时
 */

/**
 * ① 挖矿引擎：自家矿脉占领 + 盟友列表占领 + 探测换矿 + 产出回收。
 * 拥有独立的队列 / drain / 定时器 / 刷新节奏，与 ② 盗窃封存解耦。
 */
export class MiningEngine {
    #env;
    #ctx = null;

    // 队列 / 调度
    #queue = [];
    #scanning = false; #consuming = false; #scanPending = false;
    #scanTimer = null; #pushTimer = null;

    // 自矿缓存
    #cachedSelf = null; #lastSelfTs = 0; #selfDirty = true;

    // 盟友频率
    #allyIntervalMs = HOT_ALLY_BASE_MS;
    #allyUnchanged = 0; #lastAllyStats = ''; #lastAllyTs = 0;

    // 拉黑 / 放弃本轮占领 / 当日界标
    #blockedToday = new Set();
    #abandonOccupy = false;
    #dayStr = '';

    #drain;
    #pushHandler = () => this.#onPush();

    /** @param {MineEngineEnv} env 共享运行环境 */
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
     * 启动引擎：重置状态、订阅矿洞变更推送(21351)、触发首轮扫描。
     * @param {*} ctx reactor 运行上下文
     */
    start(ctx) {
        this.#ctx = ctx;
        this.#reset();
        ctx.on.push(PUSH_MINE_CAVE_CHANGE, this.#pushHandler);
        log.info('mining started.');
        this.#triggerScan();
    }

    #reset() {
        if (this.#scanTimer) { clearTimeout(this.#scanTimer); this.#scanTimer = null; }
        if (this.#pushTimer) { clearTimeout(this.#pushTimer); this.#pushTimer = null; }
        this.#scanning = false; this.#consuming = false; this.#scanPending = false;
        this.#abandonOccupy = false; this.#queue = [];
        this.#blockedToday.clear();
        this.#cachedSelf = null; this.#lastSelfTs = 0; this.#selfDirty = true;
        this.#lastAllyTs = 0; this.#allyUnchanged = 0; this.#lastAllyStats = '';
        this.#allyIntervalMs = this.#isHotPeriod() ? HOT_ALLY_BASE_MS : COLD_ALLY_BASE_MS;
        this.#dayStr = '';
    }

    // 配置变更后即时唤醒（rules 变→重扫一遍以生效新筛选）
    kick() { if (this.#env.alive()) this.#triggerScan(); }

    // ─────────── 规则匹配包装 ───────────
    #match(specId) { return matchSpec(specId, this.#env.getRules()); }
    #activeRuleCount() { return activeRules(this.#env.getRules()).length; }

    // ─────────── 时段/频率 ───────────
    #isHotPeriod() {
        var h = new Date().getHours();
        var slots = this.#env.tuning.hotSlots;
        for (var i = 0; i < slots.length; i++) { if (h >= slots[i][0] && h < slots[i][1]) return true; }
        return false;
    }
    #isZeroHourPriority() {
        var now = new Date();
        return now.getHours() === 0 && now.getMinutes() < 30;
    }
    #computeAllyStats(infos) {
        var tc = {}, lc = {};
        for (var i = 0; i < infos.length; i++) {
            var list = infos[i].list || [];
            for (var j = 0; j < list.length; j++) {
                var spec = gameData.mineSpec(list[j].specId);
                if (!spec) continue;
                var t = String(spec.type); tc[t] = (tc[t] || 0) + 1;
                var l = String(spec.level); lc[l] = (lc[l] || 0) + 1;
            }
        }
        var ts = '', ls = '';
        for (var k in tc) ts += k + ':' + tc[k] + ',';
        for (var k2 in lc) ls += k2 + ':' + lc[k2] + ',';
        return 't{' + ts + '}l{' + ls + '}';
    }
    #applyAllyCadence(statsSig) {
        if (statsSig && statsSig === this.#lastAllyStats) {
            this.#allyUnchanged++;
            if (this.#allyUnchanged >= ALLY_UNCHANGED_TRIGGER) {
                var max = this.#isHotPeriod() ? HOT_ALLY_MAX_MS : COLD_ALLY_MAX_MS;
                this.#allyIntervalMs = Math.min(max, Math.round(this.#allyIntervalMs * ALLY_DEGRADE_FACTOR));
            }
        } else {
            this.#allyUnchanged = 0;
            this.#allyIntervalMs = this.#isHotPeriod() ? HOT_ALLY_BASE_MS : COLD_ALLY_BASE_MS;
        }
        if (statsSig) this.#lastAllyStats = statsSig;
    }

    // ─────────── 调度器（仅 盟友频率 + 自矿兜底，无世界预算） ───────────
    #nextWakeDelay() {
        var now = Date.now();
        var delays = [];
        if (now - this.#lastAllyTs >= this.#allyIntervalMs) delays.push(1000);
        else delays.push(this.#allyIntervalMs - (now - this.#lastAllyTs));
        if (this.#selfDirty) delays.push(1000);
        else delays.push(SELF_MAX_AGE_MS - (now - this.#lastSelfTs));
        delays.push(300_000); // 保底 5min
        var min = Infinity;
        for (var i = 0; i < delays.length; i++) if (delays[i] > 0 && delays[i] < min) min = delays[i];
        return Math.max(5000, Math.min(min, 300_000));
    }
    #scheduleScan(delay) {
        if (!this.#env.alive()) return;
        if (this.#scanTimer) clearTimeout(this.#scanTimer);
        this.#scanTimer = setTimeout(() => {
            this.#scanTimer = null;
            if (this.#env.alive()) this.#triggerScan();
        }, Math.max(0, delay));
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
        this.#abandonOccupy = false;
        this.#queue = [];
        try {
            // 所有守卫写成嵌套 if 而非 try 内 return：reactor.activate 幂等，早退会漏掉
            // 底部 consume()+afterRound() 重排，一旦早退整条定时器链永久断裂。
            if (this.#env.getData() && this.#env.inAlliance()) {
                var selfNow = Date.now();
                var selfDue = !this.#cachedSelf || this.#selfDirty || (selfNow - this.#lastSelfTs >= SELF_MAX_AGE_MS);
                var self = selfDue ? await this.#fetchSelfInfo() : this.#cachedSelf;
                if (self && this.#env.alive()) {
                    // 当日界翻转：清空当日拉黑（占领/联盟产出拒绝不再跨日重试）
                    var d = new Date();
                    var ds = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
                    if (this.#dayStr !== ds) { this.#dayStr = ds; this.#blockedToday.clear(); }
                    var tasks = [];
                    this.#collectTasks(self, tasks);                                   // 1. 回收
                    try { await this.#occupyTasks(self, tasks); } catch (e) { log.warn('occupy error.', e); } // 2. 占领线
                    if (this.#env.alive()) this.#refreshTask(self, tasks, this.#isZeroHourPriority());        // 3. 探测换矿
                    this.#queue = tasks;
                }
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
    async #fetchSelfInfo() {
        var ret = await this.#env.ask(CMD_SELF_INFO2, { openPanel: 0 }, 'self-info');
        if (ret.ok && ret.data) {
            this.#cachedSelf = ret.data; this.#lastSelfTs = Date.now(); this.#selfDirty = false;
            return ret.data;
        }
        return this.#cachedSelf; // 失败退回上次快照，selfDirty 保持→下轮重试
    }

    // ─────────── 任务生成 ───────────
    // 回收：7422 领取「采集/行军产出」+ 7424 他人来采 + 7429 联盟。
    // 修正（对齐游戏 getIsHasReward + MineCaveToOtherItem）：
    //   - infos[]（自矿非盟友槽）：state===3 才领（自矿只认 GATHER_FINISH）
    //   - toOthers[]（我分享出去被采的行军项）：state∈{3,4} 才领（此前整块漏遍历）
    //   - toOtherCollects[]（我在他人矿上的行军项）：state∈{3,4} 才领（此前只认 3、漏 4）
    #collectTasks(self, tasks) {
        var infos = self.infos || [];
        for (var i = 0; i < infos.length; i++) {
            var si = infos[i].simpleInfo || {};
            var slot = gameData.mineSlotPos(Number(si.pos));
            if (slot && Number(slot.is_ally) === 1) continue;
            if (si.state === STATE_FINISH && si.id != null) tasks.push({ k: 'reward_self', id: si.id });
        }
        var tos = self.toOthers || [];
        for (var a = 0; a < tos.length; a++) {
            var ti = tos[a].simpleInfo || {};
            if ((ti.state === STATE_FINISH || ti.state === STATE_STEAL_FINISH) && ti.id != null) tasks.push({ k: 'reward_self', id: ti.id });
        }
        var ocs = self.toOtherCollects || [];
        for (var j = 0; j < ocs.length; j++) {
            var osi = ocs[j].simpleInfo || {};
            if (osi.state === STATE_FINISH || osi.state === STATE_STEAL_FINISH) { if (osi.id != null) tasks.push({ k: 'reward_self', id: osi.id }); }
        }
        var og = self.otherGatherRewardNum || {};
        for (var p in og) { if (Number(og[p]) > 0) tasks.push({ k: 'reward_other', pos: Number(p) }); }
        if (Number(self.haveAllianceReward) === 1 && !this.#blockedToday.has('alliance-reward')) tasks.push({ k: 'reward_alliance' });
    }

    #occupyCap(self) {
        var occMax = this.#env.cfgSeg(1051, 0);
        var leftOcc = occMax > 0 ? occMax - (Number(self.todayOccupyNum) || 0) : 0;
        var marchMax = Number((this.#env.getData().UserData || {}).myMarchNumMAX) || 0;
        var marchUsed = (self.collects || []).length + (self.toOthers || []).length + (self.toOtherCollects || []).length;
        var infos = self.infos || [];
        for (var i = 0; i < infos.length; i++) { if ((infos[i].simpleInfo || {}).state === STATE_GATHERING) marchUsed++; }
        var leftMarch = marchMax > 0 ? marchMax - marchUsed : 0;
        return Math.max(0, Math.min(leftOcc, leftMarch));
    }

    async #occupyTasks(self, tasks) {
        if (!this.#activeRuleCount()) return; // 无已勾选规则=不采，跳过占领线（含盟友 7425/7414 探测）
        var cap = this.#occupyCap(self);
        // 自矿占领
        var infos = self.infos || [], myUidV = this.#env.myUid();
        for (var i = 0; i < infos.length && cap > 0; i++) {
            var si = infos[i].simpleInfo || {};
            if (si.id == null || si.state !== STATE_NO_GATHER) continue;
            if (Number(infos[i].ownerUid) !== myUidV) continue;
            var slot = gameData.mineSlotPos(Number(si.pos));
            if (slot && Number(slot.is_ally) === 1) continue;
            if (!this.#match(si.specId)) continue;
            var _sp = gameData.mineSpec(si.specId) || {};
            log.debug('occ_self pick: pos=%s specId=%s type=%s level=%s star=%s', si.pos, si.specId, _sp.type, _sp.level, _sp.star);
            // uid 用响应里的 ownerUid 原值（字符串），勿 Number() 转换，否则 7421/7417 被拒。
            tasks.push({ k: 'occ_self', id: si.id, uid: String(infos[i].ownerUid), pos: Number(si.pos), specId: si.specId });
            cap--;
        }
        // 盟友线（仅占领）
        if (Date.now() - this.#lastAllyTs < this.#allyIntervalMs) return;
        // 越过间隔门就立刻推进 lastAllyTs（无论随后是否真发 7425）：否则名额已满/拉取失败时
        // lastAllyTs 永不更新，#nextWakeDelay 持续判盟友到点压到 5s 下限，导致 7428 每 5s 空刷。
        this.#lastAllyTs = Date.now();
        if (cap <= 0) return;
        var ally = await this.#buildAllyTasks(cap);
        if (!this.#env.alive()) return;
        for (var o = 0; o < ally.occupy.length; o++) tasks.push(ally.occupy[o]);
    }

    // 盟友概览 7425 → 候选按星降序 → 逐个 7414 补 id → 只产出「占领」任务（不封存）。
    async #buildAllyTasks(occCap) {
        var out = { occupy: [] };
        var ret = await this.#env.ask(CMD_OTHER_INFO2, {}, 'ally-overview');
        if (!ret.ok || !ret.data || !ret.data.infos) return out;
        this.#applyAllyCadence(this.#computeAllyStats(ret.data.infos));
        var byUid = {}, infos = ret.data.infos;
        for (var i = 0; i < infos.length; i++) {
            var m = infos[i], list = m.list || [];
            for (var j = 0; j < list.length; j++) {
                var s = list[j];
                if (!this.#match(s.specId)) continue;
                var rec = byUid[m.uid];
                if (!rec) rec = byUid[m.uid] = { uid: m.uid, star: 0, hasOcc: false };
                var st = specStar(s.specId); if (st > rec.star) rec.star = st;
                // 只有共享格（is_ally=1，实测 pos 2/4）且空位才是可占目标；私有格占了会被拒。
                var sslot = gameData.mineSlotPos(Number(s.pos));
                if (Number(s.state) === STATE_NO_GATHER && sslot && Number(sslot.is_ally) === 1) rec.hasOcc = true;
            }
        }
        var cands = [];
        for (var k in byUid) { var c = byUid[k]; if (c.hasOcc) cands.push(c); }
        cands.sort(function (a, b) { return b.star - a.star; });
        var probed = 0;
        for (var p = 0; p < cands.length; p++) {
            if (!this.#env.alive()) break;
            if (out.occupy.length >= occCap) break;
            if (probed >= ALLY_PROBE_MAX) break;
            probed++;
            var full = await this.#probeAllyMine(cands[p].uid);
            if (!full) continue;
            var gotOcc = false;
            for (var f = 0; f < full.length; f++) {
                var si = full[f].simpleInfo || {};
                if (si.id == null || !this.#match(si.specId)) continue;
                var uid = String(full[f].ownerUid != null ? full[f].ownerUid : cands[p].uid);
                var aslot = gameData.mineSlotPos(Number(si.pos));
                if (!gotOcc && out.occupy.length < occCap && si.state === STATE_NO_GATHER
                    && aslot && Number(aslot.is_ally) === 1) {
                    out.occupy.push({ k: 'occ_ally', id: si.id, uid: uid, serverId: full[f].serverId, pos: Number(si.pos), specId: si.specId });
                    gotOcc = true;
                }
            }
        }
        return out;
    }

    async #probeAllyMine(uid) {
        var ret = await this.#env.ask(CMD_OTHER_INFO, { uid: uid }, 'ally-mine');
        if (ret.ok && ret.data && ret.data.infos) return ret.data.infos;
        return [];
    }

    // 探测换矿 7416：有空自矿槽且不匹配规则、且免费额度未尽时摇一次新矿。0 点优先耗免费；
    // 平时仅当本轮无其它待办任务时才探（避免占行军名额）。无已勾选规则则不探。
    #refreshTask(self, tasks, priority) {
        if (!this.#activeRuleCount()) return;
        var freeMax = this.#env.cfgSeg(1051, 1);
        if (freeMax <= 0) return;
        if ((Number(self.todayRefreshNum) || 0) >= freeMax) return;
        if (!priority && tasks.length > 0) return;
        var infos = self.infos || [];
        for (var i = 0; i < infos.length; i++) {
            var si = infos[i].simpleInfo || {};
            var slot = gameData.mineSlotPos(Number(si.pos));
            if (slot && Number(slot.is_ally) === 1) continue;
            if (si.state === STATE_NO_GATHER && !this.#match(si.specId)) { tasks.push({ k: 'refresh' }); return; }
        }
    }

    // ─────────── 执行器 ───────────
    async #execTask(task) {
        if (this.#abandonOccupy && (task.k === 'occ_self' || task.k === 'occ_ally')) return;
        switch (task.k) {
            case 'reward_self': await this.#execRewardSelf(task); break;
            case 'reward_other': await this.#execRewardOther(task); break;
            case 'reward_alliance': await this.#execRewardAlliance(); break;
            case 'occ_self': await this.#execOccupy(task, false); break;
            case 'occ_ally': await this.#execOccupy(task, true); break;
            case 'refresh': await this.#execRefresh(task); break;
        }
        this.#selfDirty = true; // 任何写动作都可能改变自矿快照，标脏让下轮重取 7428
    }

    async #execRewardSelf(task) {
        var ret = await this.#env.ask(CMD_REWARD, { id: task.id }, 'reward-self');
        log.debug(ret.ok ? 'reward-self ok.' : 'reward-self rejected. code=%d', ret.code);
    }
    async #execRewardOther(task) {
        var ret = await this.#env.ask(CMD_OTHER_GATHER_REWARD, { pos: task.pos }, 'reward-other');
        log.debug(ret.ok ? 'reward-other ok.' : 'reward-other rejected. code=%d', ret.code);
    }
    async #execRewardAlliance() {
        var ret = await this.#env.ask(CMD_ALLIANCE_REWARD, {}, 'alliance-reward');
        if (ret.ok) log.debug('alliance-reward ok.');
        else { this.#blockedToday.add('alliance-reward'); log.debug('alliance-reward rejected. code=%d', ret.code); }
    }

    async #execOccupy(task, ally) {
        if (ally) {
            var chk = await this.#env.ask(CMD_CHECK_SHARE, { uid: task.uid, id: task.id }, 'check-share');
            if (!this.#env.alive()) return;
            if (!chk.ok || !chk.data || Number(chk.data.isOk) !== 1) { log.debug('ally mine unavailable.'); return; }
        }
        var sel = await this.#pickHeroesFor(task);
        if (!this.#env.alive()) return;
        if (!sel || !sel.ok || !sel.heroes.length) { log.info('occupy skip: %s', sel ? sel.reason : '详情不可用'); return; }
        var ret = await this.#env.ask(CMD_OCCUPY, { id: task.id, pos: task.pos, heroIds: sel.heroes, specId: task.specId, uid: task.uid }, 'occupy');
        if (ret.ok && ret.data && Number(ret.data.isOk) === 1) {
            log.info('occupy ok. id=%s heroes=%s', idKey(task.id), sel.heroes.join(','));
        } else if (ret.code === 3 && ret.data) {
            log.info('occupy business-rejected code=3 msg=%s; abandon occupy this round.', rejectText(ret.data));
            this.#abandonOccupy = true;
        } else {
            this.#blockedToday.add(idKey(task.id) + '|' + task.uid);
            log.info('occupy rejected code=%d msg=%s', ret.code, rejectText(ret.data));
        }
    }

    async #execRefresh() {
        var ret = await this.#env.ask(CMD_REFRESH, { isAll: 1 }, 'refresh');
        if (ret.ok && ret.data) log.info('refresh ok. todayRefreshNum=%s', ret.data.todayRefreshNum);
        else log.info('refresh rejected. code=%d msg=%s', ret.code, rejectText(ret.data));
    }

    async #pickHeroesFor(task) {
        var infoRet = await this.#env.ask(CMD_SINGLE_INFO, { id: task.id, uid: task.uid }, 'single-info');
        if (!infoRet.ok || !infoRet.data) return null;
        var spec = gameData.mineSpec(task.specId);
        if (!spec) return null;
        var used = infoRet.data.allUsedHeroIds || infoRet.data.usedHeroIds || [];
        var usedSet = {}; for (var i = 0; i < used.length; i++) usedSet[Number(used[i])] = 1;
        var pool = gameData.heroPool().filter(function (h) { return !usedSet[h.id]; });
        return this.#autoSelectHeros(spec, pool);
    }

    // ── 占领自动布阵（纯算法，游戏 MineCaveHomeMineItem 口径）──
    #autoSelectHeros(spec, pool) {
        var e = [], t = [], o = [];
        this.#expandThresholds(spec.hero_color, e); this.#expandThresholds(spec.hero_level, t); this.#expandThresholds(spec.hero_star, o);
        e.sort(numAsc); t.sort(numAsc); o.sort(numAsc);
        var a = pool.slice().sort(function (x, y) { return (x.level - y.level) || (x.star - y.star) || (x.quality - y.quality) || (x.id - y.id); });
        var i = [];
        for (var s = 0; s < a.length; s++) {
            if (i.indexOf(a[s].id) >= 0) continue;
            if (!(t.length || o.length || e.length)) break;
            var h = a[s];
            if (h.level >= (t.length ? t[0] : -1) && h.star >= (o.length ? o[0] : -1) && h.quality >= (e.length ? e[0] : -1)) {
                i.push(h.id); if (t.length) t.shift(); if (o.length) o.shift(); if (e.length) e.shift();
            }
        }
        var r = false, n = false, guard = 0;
        for (var s2 = 0; s2 < a.length && guard++ < 1000; s2++) {
            if (i.indexOf(a[s2].id) >= 0) continue;
            var h2 = a[s2];
            if (t.length) { if (h2.level >= t[0]) { i.push(h2.id); if (e[0] && h2.quality >= e[0]) e.shift(); if (o[0] && h2.star >= o[0]) o.shift(); s2 = 0; t.shift(); r = true; } }
            else if (o.length) { if (h2.star >= o[0]) { i.push(h2.id); if (e[0] && h2.quality >= e[0]) e.shift(); s2 = 0; o.shift(); n = true; } }
            else if (e.length) { if (h2.quality >= e[0]) { i.push(h2.id); e.shift(); } }
            if (s2 === a.length - 1) { if (!r && t.length) { t.length = 0; s2 = 0; } else if (!n && o.length) { o.length = 0; s2 = 0; } }
        }
        i.length = Math.min(3, i.length);
        return { heroes: i, ok: this.#conditionsMet(spec, i, pool), reason: '英雄条件未满足' };
    }
    #expandThresholds(str, arr) { this.#parseReqStr(str, '').forEach(function (rq) { for (var k = 0; k < rq.count; k++) arr.push(rq.threshold); }); }
    #conditionsMet(spec, chosenIds, pool) {
        var conds = [];
        this.#parseReqStr(spec.hero_color, 'quality').forEach(function (r) { conds.push({ type: 1, value: r.threshold, need: r.count }); });
        this.#parseReqStr(spec.hero_star, 'star').forEach(function (r) { conds.push({ type: 2, value: r.threshold, need: r.count }); });
        this.#parseReqStr(spec.hero_level, 'level').forEach(function (r) { conds.push({ type: 3, value: r.threshold, need: r.count }); });
        if (!conds.length) return chosenIds.length > 0;
        var map = {}; pool.forEach(function (h) { map[h.id] = h; });
        var curs = conds.map(function () { return 0; });
        for (var hi = 0; hi < chosenIds.length; hi++) {
            var h = map[chosenIds[hi]]; if (!h) continue;
            var seen = {};
            for (var ci = 0; ci < conds.length; ci++) {
                var cd = conds[ci]; if (curs[ci] >= cd.need || seen[cd.type]) continue;
                if ((cd.type === 1 && h.quality >= cd.value) || (cd.type === 2 && h.star >= cd.value) || (cd.type === 3 && h.level >= cd.value)) { curs[ci]++; seen[cd.type] = 1; }
            }
        }
        for (var k = 0; k < conds.length; k++) if (curs[k] < conds[k].need) return false;
        return true;
    }
    #parseReqStr(str, dim) {
        var out = []; if (!str) return out;
        String(str).split('|').forEach(function (seg) { var p = seg.split(','); if (p.length < 2) return; var cnt = parseInt(p[0], 10), th = parseInt(p[1], 10); if (!isNaN(cnt) && !isNaN(th) && cnt > 0) out.push({ dim: dim, count: cnt, threshold: th }); });
        return out;
    }

    // ─────────── 推送 ───────────
    #onPush() {
        if (!this.#env.alive()) return;
        this.#selfDirty = true; // 矿洞变更推送：标记自矿需重取，去抖后唤醒
        if (this.#pushTimer) clearTimeout(this.#pushTimer);
        this.#pushTimer = setTimeout(() => { this.#pushTimer = null; if (this.#env.alive()) this.#triggerScan(); }, PUSH_DEBOUNCE_MS);
    }
}

function numAsc(a, b) { return a - b; }
