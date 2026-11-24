# cycle.js — 电平调和循环驱动器（A 原语）

> 源码：[`src/core/cycle.js`](../../src/core/cycle.js)　·　日志 tag：`[POCKETCC://CYCLE]`（feat 迁移时通常注入各自 feat 的 log）
> 选型上下文见 [`feat-控制模式归类.md`](../feat-控制模式归类.md)：本模块承载其中的 **A — Reconcile Loop**，与 `createDrain`（B）、`createEventHeap`/`wake.at`（C）并列。

## 1. 职责与边界

**适用**：有「可重放权威读通道」的 feat——错过一次触发，下一轮全量重读仍是真相，故可把多次外部刺激合并为「再补扫一轮」而不丢信息（如 856 全量行军、901 点位、8623/3756 列表）。判据三条须同时满足（单一收敛态 + 有可重放读 + 可合并），详见归类文档 §1-A。

**管什么**（只兜三件跨 feat 共同的不变量）：

- **单飞闸门 `running`**：同一时刻至多一个调和轮在飞，杜绝重入；
- **触发合并 `pending`**：在飞期间的外部 `kick()` 只置位一次，本轮结束后由调用方 `run()` 读 `cycle.pending` 自行决定是否立即补扫（多条刺激塌成一次）；
- **绝不停摆**：每轮结束（正常返回 / 抛错）都按 `run()` 返回的 delay 择时重排；即便 `run` 抛异常也按 `fallback` 重排，消除「早退忘重排 → 永久停摆」这类隐患。

**不管什么**（刻意单薄，铁律）：

- **「下一拍睡多久」的决策全归调用方**：退避曲线 / 静默冷却 / 时段表 / active-idle 选档 / `endTime−now` 预测——一律由 `run()` 的返回值表达，cycle 只照返回值择时，不解读其含义。
- **不拥有队列、不做逐条消费**：队列的创建/替换/清空/去重是 feat 业务，归 [`drain.js`](../../src/core/drain.js) 或 feat 自持（见 §2 与归类文档 §5「A 产 B 消」）。
- **不含流程 DSL**：不引入状态机 / 步骤编排（`BackoffStrategy`/`DelayPolicy` 等抽象）——上一轮重型 `reconcile.js` 正因吞下这些被整量回滚。

**对外契约**：`createCycle(o)` 返回 `{ kick, pending }`——`kick()` 是外部触发汇入口，`pending` 为只读属性。无任何可变状态对外暴露。

## 2. 设计思路与取舍

### 2.1 为什么这么薄：只兜「择时重排」这一个不变量

四个 P0 feat（auto-farm / launch-silo / domain-treasure / sea-treasure）迁移前各自手写 `scanning`/`scanPending`/`scanTimer`/`scheduleScan`/`triggerScan`/`doCycle` 一整套样板，且逐字重复。抽出来后发现**真正跨 feat 一致的部分只有三件事**：单飞、合并、择时重排（含异常兜底）。其余（睡多久、怎么算间隔、队列怎么消费）每个 feat 都不同。故 cycle 只收口前三个不变量，把「间隔决策」用「`run()` 返回一个数字」这一极简契约交回调用方——这是本模块的价值边界。

### 2.2 被否决的方案

- **重型 reconcile 框架**（引入 `BackoffStrategy`/`DelayPolicy`/退避曲线/时段表内聚）：**否决**。上一轮 `reconcile.js`/`pipeline.js`/`wheeltimer.js` 因「过重、吞掉 feat 业务」被全量回滚。退避等特性以「`run()` 返回不同 delay」即可零成本表达，无需接口化。
- **给 cycle 加 `busy()`/冷却/队列钩子**：**否决**。会把 feat 特例反向灌进 core，复杂度回流，违背「薄」初衷。P1 若出现真需要，另议，不为单一实现扩接口。
- **cycle 直接持有队列 + 逐条消费**（把 B 也吞进来）：**否决**。队列归属权是 feat 业务且各家 pause 语义相反（保留 vs 清空），合并会造成虚假内聚与竞态。逐条串行是 `createDrain`（B）的职责，与择时重排（A）是两个原语。
- **把绝对时刻打点（`endTime−now`）也当成 C 走时间轮**：**否决**。只要仍是单收敛态 + 有重放读，`run()` 返回 `endTime−now` 依旧属 A（如 city-skill/player-like）；A/C 的真实分界是「单收敛态+可重放读」vs「N 独立自定时实例/边沿无重放读」，不是「相对 delay vs 绝对时刻」。

## 3. API 契约

```js
import { createCycle } from '../../core/cycle.js';

const cycle = createCycle({
    run:      async () => number,   // 执行一轮，返回「下一拍间隔（毫秒）」。<=0 立即再跑一轮，>0 睡这么久
    alive:    () => boolean,        // 运行态闸门（通常接 reactor ctx.alive()）；false 即不启动、睡醒也不再重排
    fallback: number,               // run 抛错时的兜底重排间隔（毫秒），防异常导致停摆或紧密空转（各 feat 取其 active 档）
    log:      logger,               // 可选，缺省 createLog('CYCLE')；迁移时一般注入 feat 自己的 log
});

cycle.kick();        // 外部触发汇入口：启动 / 回城唤醒 / 配置变更 / 兜底到点 / 推送都调它；在飞时自动合并成置 pending
cycle.pending;       // 只读：本轮在飞期间是否有新触发；供 run() 末尾判断「是否立即补扫」
```

**`run()` 返回值的优先级语义由调用方自行编排**（cycle 只认 `<=0 / >0`），典型三段式：

1. 需要「睡觉并丢弃在飞合并」的场景（如限流退避）：返回 `>0`——cycle 只睡不清 pending，而 pending 只有在 `delay<=0` 那条路径才会被下轮读到，退避睡醒后是一次干净兜底重扫；
2. 需要「立即补扫攒下的触发」：`if (cycle.pending) return 0;`
3. 常规择档：返回 active/idle/自定义间隔。

**内部时序不变量**：`arm()` 只在 `running=false` 后调用；`exec()` 入口先 `clearTimer()`。故「定时器在飞」与「running」二者互斥，至多其一存在。`delay` 非有限数（NaN/Infinity/非数）一律回落 `fallback`；`Math.max(0, delay)` 兜负值。

## 4. 场景用法（P0 四家迁移形状）

### 4.1 auto-farm — 参照实现（限流退避 + 账本 bootstrap）

```js
async function cycleRun() {
    if (!ledgerLoaded) {                        // 账本未读回不派兵；读回失败降 active 档重试，不留紧密循环
        await loadLedger();
        if (!ledgerLoaded) return cfg.activeScanInterval;
    }
    await cyclePass();
    if (rateLimitStreak > 0) {                  // 撞 902 全局限流 → 指数退避（返回 >0 睡觉，天然丢弃在飞 push）
        return Math.min(cfg.rateLimitBackoffMs * (1 << Math.min(rateLimitStreak - 1, 5)), cfg.rateLimitBackoffMaxMs);
    }
    if (cycle.pending) return 0;                // 退避未触发 + 在飞攒了触发 → 立即补扫
    return backlogActive ? cfg.activeScanInterval : cfg.idleScanInterval;
}
const cycle = createCycle({ log, alive: aliveFn, run: cycleRun, fallback: cfg.activeScanInterval });
```

推送回城唤醒 / `configure` / `run` 点火处一律 `cycle.kick()`。旧 `scanning/scanPending/scanTimer/scheduleCycle/triggerCycle/doCycle` 全删。

### 4.2 launch-silo — 最纯 A（单闸，体内无 consume）

`run()` 里 1055 判活动窗口 → 窗口内按需领奖+驻军 → 返回 `inWindow ? active : idle`。无退避支路。**行为增强**：非窗口期旧 `doScan` 直接 `return` 跳过重排、只靠推送唤醒；迁移后落到 `run()` 返回 idle(10min) 档兜底轮询——属「绝不停摆」不变量下的有意增强，取值合理。

### 4.3 domain-treasure / sea-treasure — A 产 B 消（三段折叠成一轮）

这两家原为「`doScan` 生产 → `consume` 逐条消费 → `afterConsume` 重排」三段、带 `scanning || consuming` 双闸。迁移把三段**折叠成 `cycleRun` 的一轮**，`consume` 不再是独立循环入口（故 `consuming` 消失），其**逐条限流逻辑原样保留**（不套 `createDrain`）：

```js
async function cycleRun() {
    await doScan();                 // 拉全量快照（8623 / 3756）→ 整批替换 queue
    if (!aliveFn()) return 0;       // pause 中途：consume 不再进入，cycle 在 alive 检查处自然停摆
    await consume();                // 逐条 shift 派 902；domain 每条前判名额（满即 queue.length=0; break）；每条间 sleep
    if (cycle.pending) return 0;
    return nextScanInterval();      // emptyStreak 达阈值转 idle 降频，否则 active
}
```

cycle 内部单飞闸门（running 为私有闭包，对外契约仅 `kick`/`pending` 两个成员）取代旧双闸：`doScan`/`consume` 仅被 `cycleRun` 串行调用，queue 只在这一轮内被 mutate，外部触发只置 pending，无并发/重入触碰队列的风险。

## 5. 数据流与降级

```
外部刺激(推送/回城/配置/run点火) ──▶ kick()
   ├─ running=true ──▶ pending=true（合并，本轮结束后 run() 读到 → 返回 0 立即补扫）
   └─ running=false ─▶ exec()
exec(): running=true; pending=false; clearTimer(); → await run()
   ├─ run() 正常返回 delay
   ├─ run() 抛异常 ─▶ log.warn('cycle run threw.') → delay = fallback   ← 绝不停摆的兜底
   └─ running=false 后：
        alive()=false ──▶ return（pause：不重排、不残留；旧 armed timer 到点因 alive=false 空转自清）
        delay 非有限数 ─▶ delay = fallback
        delay <= 0 ──▶ exec()（微任务边界，同步栈不累积）
        delay > 0 ──▶ arm(delay)
```

**降级**：`run()` 抛异常或返回非法 delay → 按 `fallback` 重排（取各 feat 的 active 档，60s，非 0，既不忙循环也只约每分钟一条 warn）。`alive()` 覆盖 pause/resume 全生命周期，无独立降级档。

## 6. 坑与边界

- **退避期丢弃在飞 push 是设计如此**：`run()` 返回 `>0` 睡觉时不清 pending，但 pending 只在 `delay<=0` 路径被读；睡醒是一次**全量重读**兜底扫（前提：该 feat 有可重放读通道）。这正是 A 的合并语义——别指望退避期间攒的每条推送都单独触发一轮。
- **cycle 绝不拥有队列**：`consume`/逐条派遣留 feat（domain/sea）或走 `createDrain`（B 族）。误把队列塞进 cycle 会重演「core 被 20+ feat 业务遥控」的虚假内聚。
- **多实例并发各自计时不能套 A**：如 floatcar 每台花车一条独立 30s 网格——单个 `pending` 布尔承载不了 N 条独立时刻，那是 C（`createEventHeap`）。
- **边沿推送即事实不能套 A**：如 alliance-rally 的 12003、titan-blessing 的去抖即漏领——无重放读通道，合并/去抖会永久丢信息，走 B/C。
- **早退断链隐患已被 fallback 根治**：`mine-cave` 那类「`doScan` 体内 early-return 跳过底部重排 → 定时器链断裂、feat 假运行」的坑，A 迁移后由「每轮必按返回值/fallback 重排」这一不变量消除，调用方无需再手动保证每条出口都重排。
- **`fallback` 必须 >0**：传 0 会让 run 抛异常变成紧密忙循环刷 warn。各 feat 取 `cfg.activeScanInterval`。

## 7. 调试面

- 日志 tag：独立使用时 `[POCKETCC://CYCLE]`；四家迁移均注入 feat 自己的 log（如 `[POCKETCC://SEA-TREASURE]`），故异常重排在 feat 日志里看 `cycle run threw.`。
- 无可控制台直戳的可变状态（`running/pending/timer` 均私有）；观测靠 `run()` 内的 debug 日志与各 feat 的真人报文实录回放对拍。

## 8. 变更记录

- **2026-10-06**：首落地。抽出 A 原语 `createCycle`，只兜单飞/合并/绝不停摆三不变量，间隔决策全归 `run()` 返回值。P0 四家迁移：auto-farm（参照实现，保留限流退避优先级 + 账本 bootstrap）、launch-silo（最纯 A，单闸）、domain-treasure/sea-treasure（A 产 B 消，三段折叠成一轮、consume 逐条限流原样保留）。行为变化：旧 `.catch(log)` 后不重排 → 现按 `fallback` 择时重排，消除永久停摆隐患；launch-silo 非窗口期由「仅推送唤醒」改为「idle 档兜底轮询」。`npm run build` 三 bundle 通过，CodeReview 静态核对四重点通过。
