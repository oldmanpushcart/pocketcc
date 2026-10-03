/**
 * 战争之源 —— 领奖动作（RewardFlow，一套独立动作一个文件）。
 *
 * 职责：领取「攻击次数奖励」（面板三箱），是与攻打完全独立的全天流程——与打不打得到 BOSS、当攻打额度无关。
 *   档位表 DataConfig[82000001]（"1|道具;3|道具;5|道具"，取每段首数字为攻打次数门槛，共 3 档，打满 5 次才领得全 3 个）。
 *   req sendPBV2 9952（WORLD_BOSS_V2_CLAIM_ATTACK_COUNT_REWARD）{attackCount:门槛} → pbAckV2.data={attackCount,reward}。
 *
 * 领取判定全走本地（无独立奖励查询接口）：达标（UserData.attackBossCnt >= 门槛）且未领才发 9952，三档各一发、有哪个领哪个。
 *   关键陷阱：脚本直发 9952 绕过面板 onClickBox 的 per-call 回调，游戏不会把自领档位写回
 *   UserData.worldBossV2ClaimedAttackCountRewardIds（该列表仅 push 21924 登录/日重置时全量覆写）；
 *   故"已领"判据取 UserData ∪ 本地镜像 sowClaimedIds 的并集，领成功即并入镜像（否则逐拍重发被 code=3 刷屏，历史 bug）。
 *
 * push 语义（源码实证）：21923 只 updateAttackBossCnt（攻打计数，不带已领列表）→ 计数一变即时重判补领；
 *   21924 同时覆写 attackCount + claimedAttackCountRewardList（登录/日重置全量）→ 并入镜像即自愈。
 *
 * 拒绝处理：被服务器以 code=3（已领/重复）拒绝的档位视为已领并入镜像、停止重发；其余拒绝码当日拉黑不再续发。
 *   领奖链每 CLAIM_POLL_INTERVAL 低频轮询兜底；3 个全领完（并集判据）→ claimTimer 收摊到次日（下轮 21924/日切再判）。
 *
 * 运行时单例（net/dataCenter/alive）由 index.js 经 env 注入（引擎不反向 import index，避免循环依赖）。
 * 只读 + 发包：镜像仅内存、不落盘，重启后最坏重复领一次被 code=3 拒且被"视为已领"吞掉、无害。
 */
import { createLog } from '../../../core/log.js';
import { bus } from '../../../core/bus.js';
import { gameConf } from '../../../core/game-api.js';
import { todayStr, safeStringify } from './util.js';

/** @type {ReturnType<createLog>} 模块日志器（tag 与攻打链一致） */
const log = createLog('SOURCE-OF-WAR');

/**
 * 攻击次数奖励领取（sendPBV2）：请求 {attackCount:门槛}，应答 data={attackCount,reward}。
 * 定义：NRequestIdV2.WORLD_BOSS_V2_CLAIM_ATTACK_COUNT_REWARD = 9952（真机录像实证 1/3/5 三档逐个发出）
 * @type {number}
 */
const CMD_CLAIM_ATTACK_REWARD = 9952;

/**
 * push WORLD_BOSS_V2_ATTACK_COUNT_UPDATE：今日攻打次数更新（源码实证只 updateAttackBossCnt，不带已领列表）。
 * 定义：NResponseIdV2（游戏 PushResponse nm 处理器）
 * @type {number}
 */
const PUSH_SOW_ATTACK_COUNT_UPDATE = 21923;

/** @type {number} push WORLD_BOSS_V2_DAY_RESET：每日重置/登录全量（覆写 attackCount + claimedAttackCountRewardList），唤醒重判即自愈 */
const PUSH_SOW_DAY_RESET = 21924;

/** @type {number} DataConfig：攻击次数奖励档位表 "门槛|道具;门槛|道具;门槛|道具"（游戏面板同键取法） */
const CFG_KEY_REWARD_TIERS = 82000001;

/** @type {number} 领奖独立链的全天低频轮询间隔（毫秒）：push 漏收/领取瞬断时最迟一个周期内补领 */
const CLAIM_POLL_INTERVAL = 1000 * 60 * 10;

/**
 * 领奖动作引擎：由 index.js 装配层实例化并注入 env。
 * env = { getNet, getData, alive }（惰性读取，install 前 getData 返回 null 时展示函数亦安全）。
 */
export class RewardFlow {
    /** @param {{getNet:Function, getData:Function, alive:Function}} env */
    constructor(env) {
        this.env = env;
        /** @type {number|null} 领奖独立链定时器（全天低频轮询）；与攻打窗口/额度无关，3 档领完即收摊到次日 */
        this.claimTimer = null;
        /**
         * 本地镜像的攻打计数（仅 UserData.attackBossCnt 读不到时兜底）：
         * 由 push 21923 覆写与 9952 领成后的应答同步，不另发查询。
         * @type {number}
         */
        this.sowAttackCnt = 0;
        /**
         * 本地镜像的已领档位集合：脚本直发 9952 领成功的档位（游戏不会回写 UserData，需靠它收敛），元素为门槛数字。
         * 与 UserData.worldBossV2ClaimedAttackCountRewardIds 取并集作为"已领"权威（见 claimedIdsNow）。按日失效（sowClaimedDay）。
         * @type {number[]}
         */
        this.sowClaimedIds = [];
        /** @type {string} 本地已领镜像所属日期串（YYYY-MM-DD），跨日清空防把昨日档位算进今日 */
        this.sowClaimedDay = '';
        /**
         * 当日领奖拒绝拉黑：非 code=3 的拒绝档当日不再续发（code=3 视为已领直接并入镜像，不进此表）。
         * @type {{day:string, tiers:number[]}}
         */
        this.claimRejected = { day: '', tiers: [] };
        // push 回调需绑 this（ctx.on.push 传入的即此绑定引用）
        this.onSowCountUpdate = this.onSowCountUpdate.bind(this);
        this.onSowDayReset = this.onSowDayReset.bind(this);
    }

    /** @returns {object} 网络底座 */ get net() { return this.env.getNet(); }
    /** @returns {object} DataCenter.DATA */ get dc() { return this.env.getData(); }
    /** @returns {boolean} 功能是否仍在运行 */ alive() { return this.env.alive(); }

    /**
     * 跨日收敛：日期一变即清空本地已领镜像与拉黑表（UserData 侧由 push 21924 自然刷新）。
     */
    ensureClaimDay() {
        var today = todayStr();
        if (this.sowClaimedDay === today) return;
        this.sowClaimedDay = today;
        this.sowClaimedIds = [];
        this.claimRejected = { day: today, tiers: [] };
    }

    /**
     * 攻打次数门槛档位表：DataConfig[82000001] "门槛|道具;门槛|道具;…" 取每段首数字，升序去重。
     * 每次现读不缓存（配置随登录刷新）；读不到/格式不合返 null，调用方 fail-closed 不盲发领取。
     * @returns {number[]|null} 如 [1,3,5]；不可用返回 null
     */
    rewardTiers() {
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
    attackCountNow() {
        var v = this.dc && this.dc.UserData && this.dc.UserData.attackBossCnt;
        return (typeof v === 'number' && isFinite(v)) ? v : this.sowAttackCnt;
    }

    /**
     * 读已领档位列表：取 UserData 权威列表 ∪ 本地自领镜像 的并集（脚本直发不回写 UserData，必须并入镜像）。
     * @returns {number[]}
     */
    claimedIdsNow() {
        this.ensureClaimDay();
        var v = this.dc && this.dc.UserData && this.dc.UserData.worldBossV2ClaimedAttackCountRewardIds;
        var merged = Array.isArray(v) ? v.slice() : [];
        for (var i = 0; i < this.sowClaimedIds.length; i++) {
            if (merged.indexOf(this.sowClaimedIds[i]) === -1) merged.push(this.sowClaimedIds[i]);
        }
        return merged;
    }

    /**
     * 同步本地镜像（push 21923 载荷 / 9952 领成后的档位）：UserData 会由游戏自身处理器更新，
     * 镜像只作读不到字段时的兜底，不反向写游戏数据（feat 脚本只读 + 发包红线）。
     * @param {number} [count] 新的累计攻打次数（缺省不动）
     * @param {number[]} [claimed] 新的已领全量列表（缺省不动）
     */
    syncClaimMirror(count, claimed) {
        if (typeof count === 'number' && isFinite(count)) this.sowAttackCnt = count;
        if (Array.isArray(claimed)) {
            this.sowClaimedIds = claimed.map(function (x) { return Number(x); }).filter(function (x) { return isFinite(x); });
        }
    }

    /**
     * 待领档位：达标（attackBossCnt >= 门槛）、未领（并集判据）、且未被当日拒绝拉黑。纯本地判断，不发任何请求。
     * 档位表不可用时返回 null（无法判定，调用方不盲发）。
     * @returns {number[]|null}
     */
    pendingTiers() {
        var tiers = this.rewardTiers();
        if (!tiers) return null;
        this.ensureClaimDay();
        var cnt = this.attackCountNow();
        var claimed = this.claimedIdsNow();
        var rejected = this.claimRejected;
        return tiers.filter(function (t) {
            return cnt >= t && claimed.indexOf(t) === -1 && rejected.tiers.indexOf(t) === -1;
        });
    }

    /**
     * 奖励是否已全部领完：档位表可用且每个档位都已领。未达标不算领完（返回 false 继续等）。
     * @returns {boolean}
     */
    claimAllDone() {
        var tiers = this.rewardTiers();
        if (!tiers) return false;
        var claimed = this.claimedIdsNow();
        for (var i = 0; i < tiers.length; i++) {
            if (claimed.indexOf(tiers[i]) === -1) return false;
        }
        return true;
    }

    /**
     * 领一轮攻击次数奖励：本地判出「达标未领」档位才逐个发 9952（同面板点箱链路，档位间互不依赖）。
     * 领成/code=3 均并入本地已领镜像（前者所领档、后者服务器判已领）；其余拒绝码当日拉黑不再续发；链路异常即止。
     * 永不 reject。
     * @returns {Promise<void>}
     */
    async claimAttackRewards() {
        var self = this;
        var pend = this.pendingTiers();
        if (!pend || !pend.length) return;
        if (this.net.isSending(CMD_CLAIM_ATTACK_REWARD)) return;
        var changed = false;
        for (var i = 0; i < pend.length; i++) {
            var tier = pend[i];
            var ret;
            try {
                ret = await this.net.sendPBV2(CMD_CLAIM_ATTACK_REWARD, { attackCount: tier });
            } catch (err) {
                log.warn('claim send error. tier=%d', tier, err);
                break;   // 链路异常（超时/断线）不再续发，留给下次唤醒/轮询
            }
            if (!this.alive()) return;
            if (ret.ok) {
                // 应答 data.attackCount 即所领档位；脚本直发不回写 UserData，并入本地镜像收敛
                var claimedId = (ret.data && Number(ret.data.attackCount)) || tier;
                if (self.sowClaimedIds.indexOf(claimedId) === -1) self.sowClaimedIds.push(claimedId);
                var ri = self.claimRejected.tiers.indexOf(tier);
                if (ri !== -1) self.claimRejected.tiers.splice(ri, 1);
                changed = true;
                log.info('claim reward ok. tier=%d', claimedId);
            } else if (ret.code === 3) {
                // 服务器判「已领/重复」：信任权威，视为已领并入镜像、停止重发（防逐拍 code=3 刷屏）
                if (self.sowClaimedIds.indexOf(tier) === -1) self.sowClaimedIds.push(tier);
                changed = true;
                log.info('claim reward already-claimed (code=3), mark claimed. tier=%d;data=%s', tier, safeStringify(ret.data));
            } else {
                if (self.claimRejected.tiers.indexOf(tier) === -1) self.claimRejected.tiers.push(tier);
                log.info('claim reward rejected. tier=%d;code=%d;data=%s', tier, ret.code, safeStringify(ret.data));
            }
        }
        if (changed) bus.emit('ui.refresh');
    }

    /**
     * 立即尝试领一轮奖励（push 唤醒 / 定时器到点 / run 启动都走这里），失败仅记日志。
     */
    triggerClaim() {
        var self = this;
        this.claimAttackRewards().catch(function (err) { log.warn('claim flow threw.', err); });
    }

    /**
     * 排领奖链的下一次轮询：与攻打窗口/额度无关的全天低频兜底；3 档领完即收摊（claimTimer 停摆到次日/登录自愈）。
     */
    scheduleClaim() {
        var self = this;
        if (!this.alive()) return;
        if (this.claimTimer) clearTimeout(this.claimTimer);
        if (this.claimAllDone()) {
            log.info('all attack-count rewards claimed, claim loop idle until tomorrow.');
            this.claimTimer = null;
            return;
        }
        this.claimTimer = setTimeout(function () {
            self.claimTimer = null;
            if (!self.alive()) return;
            self.triggerClaim();
            self.scheduleClaim();
        }, CLAIM_POLL_INTERVAL);
    }

    /**
     * push 21923 回调：源码实证只 updateAttackBossCnt（覆盖计数，不带已领列表）。计数一变即就地重判并补领。
     * @param {object} ev net 推送事件（PB 推送的 data 已由桥接层解析为对象）
     */
    onSowCountUpdate(ev) {
        if (!this.alive()) return;
        var d = ev && ev.data;
        if (d && typeof d.attackCount === 'number') this.syncClaimMirror(d.attackCount, undefined);
        this.triggerClaim();
        this.scheduleClaim();
    }

    /**
     * push 21924 回调（登录/每日重置）：全量覆写 attackCount + claimedAttackCountRewardList，是脚本直发漏写
     * UserData 的自愈点。镜像同步后即时补领并重启领奖节律（日切后可能已收摊，此处再排）。
     * @param {object} ev net 推送事件
     */
    onSowDayReset(ev) {
        if (!this.alive()) return;
        var d = ev && ev.data;
        if (d && typeof d.attackCount === 'number') this.syncClaimMirror(d.attackCount, d.claimedAttackCountRewardList);
        this.triggerClaim();
        this.scheduleClaim();
    }

    /**
     * 面板展示的「次数奖励」：已领 / 总档位（纯本地读 UserData∪镜像，不发请求）；档位表不可用显占位符。
     * @returns {string}
     */
    formatRewardToday() {
        var tiers = this.rewardTiers();
        if (!tiers) return '-';
        var claimed = this.claimedIdsNow();
        var n = 0;
        for (var i = 0; i < tiers.length; i++) {
            if (claimed.indexOf(tiers[i]) !== -1) n++;
        }
        return n + ' / ' + tiers.length;
    }

    /**
     * 起领奖链：订阅攻打计数(21923)/每日重置(21924)推送 → 跨日收敛 → 启动即试领一轮（本地判据，无待领不发请求）
     *   → 排全天低频轮询。与攻打窗口/额度无关，全天独立。
     * @param {object} ctx reactor 上下文
     */
    start(ctx) {
        // 21923 计数一变就地重判补领；21924 全量覆写是直发漏写 UserData 的自愈点（退订由 reactor 在 pause 统一摘除）
        ctx.on.push(PUSH_SOW_ATTACK_COUNT_UPDATE, this.onSowCountUpdate);
        ctx.on.push(PUSH_SOW_DAY_RESET, this.onSowDayReset);
        this.ensureClaimDay();
        this.triggerClaim();
        this.scheduleClaim();
    }
}
