/**
 * createCycle — 电平调和循环驱动器（A 原语）
 *
 * 适用：有「可重放权威读通道」的 feat——错过一次触发，下一轮全量重读仍是真相，故可把多次外部刺激
 *   合并为「再补扫一轮」而不丢信息（如 856 全量行军、901 点位、8623/3756 列表）。反之，边沿推送即事实、
 *   错过即丢失的场景（titan-blessing）绝不能用本原语，应走 createDrain。
 *
 * 本模块只兜三件跨 feat 共同的不变量：
 *   1) 单飞闸门 running：同一时刻至多一个调和轮在飞；
 *   2) 触发合并 pending：在飞期间的外部 kick 只置位一次，本轮结束后由调用方 run() 读 cycle.pending 自行决定是否立即补扫；
 *   3) 绝不停摆：每轮结束（正常返回 / 抛错）都按 run() 返回的 delay 择时重排；pause（alive()=false）自然终止，
 *      即便 run 抛异常也按 fallback 重排（消除「早退忘重排 → 永久停摆」这类隐患）。
 *
 * 契约刻意单薄——不含退避曲线 / 冷却 / 时段表 / 流程 DSL，「下一拍睡多久」的决策全归调用方：
 *   run():     async () => number  执行一轮，返回「下一次兜底扫描的间隔（毫秒）」。<=0 表示立即再跑一轮，>0 表示睡这么久。
 *   alive:     () => boolean       运行态闸门（通常接 reactor ctx.alive）；false 即不启动、睡醒也不再重排。
 *   fallback:  number              run 抛错时的兜底重排间隔（毫秒），防异常导致停摆或紧密空转。
 *   log:       logger（缺省 createLog('CYCLE')）
 * 返回：{ kick, pending } —— kick() 是外部触发汇入口（启动 / 回城唤醒 / 配置变更 / 兜底定时都调它），
 *   在飞时自动合并；pending 为只读属性，供 run() 判断「本轮在飞期间是否有新触发」。
 */
import { createLog } from './log.js';

/**
 * 创建一个调和循环驱动器。
 * @param {{run: () => Promise<number>, alive: () => boolean, fallback: number, log?: object}} o
 * @returns {{kick: () => void, readonly pending: boolean}}
 */
export function createCycle(o) {
    const log = o.log || createLog('CYCLE');
    const run = o.run;
    const alive = o.alive;
    const fallback = o.fallback;
    let running = false;
    let pending = false;
    let timer = null;

    function clearTimer() {
        if (timer) { clearTimeout(timer); timer = null; }
    }

    /** 睡 delay 毫秒后择机起一轮；睡期间可能 pause，故到点仍要复查 alive。 */
    function arm(delay) {
        clearTimer();
        if (!alive()) return;
        timer = setTimeout(function () {
            timer = null;
            if (alive()) exec();
        }, Math.max(0, delay));
    }

    /** 外部触发汇入口：非在飞则立即起一轮，在飞则置 pending（本轮结束后由 run() 决定补扫）。 */
    function kick() {
        if (!alive()) return;
        if (running) { pending = true; return; }
        exec();
    }

    /** 单轮外壳：置在飞 → 跑 run → 按返回的 delay 重排。任何抛错都落到 fallback，绝不因一次异常停摆。 */
    async function exec() {
        running = true;
        pending = false;
        clearTimer();
        let delay;
        try {
            delay = await run();
        } catch (err) {
            log.warn('cycle run threw.', err);
            delay = fallback;
        }
        running = false;
        if (!alive()) return;
        if (typeof delay !== 'number' || !isFinite(delay)) delay = fallback;
        if (delay <= 0) { exec(); return; }
        arm(delay);
    }

    return {
        kick: kick,
        get pending() { return pending; },
    };
}
