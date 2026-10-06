# feat 控制模式归类与重构指引

> 定位：全 feat「控制结构该用哪种抽象」的**单一真相**，供逐条重构对照。与 [`docs/core/cycle.md`](core/cycle.md)（A 原语详设）、`.qoder` 框架 ADR（调和循环 5 能力+3 原语+双 lane）配套。
> 判据经 43 个 feat 文件的 grep 实证 + 真机录制记忆交叉，非纸面推演。

## 1. 三种控制模式（本质判据）

抽象候选就三个原语，**按「系统信任模型」分**，不是按「代码像不像」分：

### A — Reconcile Loop（`createCycle`，调和循环驱动器）

> 语义：**持续把现实拉向期望态**，周期自查、不重叠、不停摆。

同时满足三条才归 A：
1. **单一收敛态**：一个 feat 维护一份「期望 vs 实际」，不是 N 个各自独立计时的实例；
2. **有可重放读通道**（level-triggered）：错过这次触发，下一轮全量重读仍是真相（856 全量行军、901 点位、1752 冷却、池查询）；
3. **可合并**：多次外部刺激塌成「再补扫一轮」不丢信息。

⚠️ **常见误判**：A **不等于「相对两档延时」**。`run()` 返回的 delay 可以是 `active/idle`，也可以是 `endTime − now`（绝对点减出相对值）——只要满足上面三条，**预测到点仍属 A**（如 city-skill、player-like）。

### B — Producer→Drain（`createDrain`，入队消费）

> 语义：**离散任务入队、串行逐条消化**，突发靠队列深度吸收，条间 sleep 天然限流。

判据：每条 push 带**独立载荷**、需**逐条处理不去抖不合并**、消费是 fire-and-forget 异步。`createDrain` 已在库。

### C — Time-Wheel / wake.at(t)（`createEventHeap`，预测唤醒）

> 语义：**N 个各自独立自定时的并发实例**，或**无可重放读通道的边沿事件**——合并即丢信息。

判据（满足其一即 C，**绝不能套 A**）：
1. **多实例并发各自计时**：如 floatcar 每台花车一条 flow、各自 30s 落地网格——单个 `pending` 布尔无法承载 N 条独立时刻；
2. **边沿载荷 / 无重查通道**：如 alliance-rally 的 `12003`「推送即事实、错过即错过」——A 的「下轮重读补回」前提不成立。

### E — 模型外（框架「双 lane」，不套 reconcile）

- **交互命令**：期望态由用户逐次即时给出（quick-attack / imperial-decree / hotkey/*），只吃生命周期托管 + 动作管线。
- **信息浮层**：事件订阅 + 自绘（chat-window / global-map / map-overlay / render）。

## 2. 30 秒决策树

```
Q1 期望态谁给？ 用户逐次给 / 纯渲染 ──▶ E（模型外，别套任何 reconcile）
      │ 系统维持在 S
      ▼
Q2 是「一个收敛态」还是「N 个各自独立计时的实例」？
      N 个独立实例并发 ────────────────▶ C（时间轮/EventHeap）
      一个收敛态 ┐
                 ▼
Q3 错过这次触发，下一轮全量重读能补回吗？
      能（有 856/901/池查询等重放读）──▶ A（createCycle）
      不能（推送即事实）──────────────▶ C（wake.at + 快照观测池）
      （离散逐条、要即时不合并）───────▶ B（createDrain）
```

**核心口诀**：`合并只在有可重放全量读时无损`——A 靠这条立足，破坏它的（多实例 / 边沿载荷 / 低延迟漏领）走 B 或 C。

## 3. 全 feat 归类总表

优先级：P0=骨架完全同构、迁移最直接零风险；P1=需拆复合/调契约；P2=需先核实触发形态。

### A 族（→ `createCycle`）

| feat | 现状触发结构 | 重构动作 | 优先级 |
|---|---|---|---|
| **launch-silo 占领发射井** | 已迁 createCycle：单 `scanning` 闸交 cycle 内部单飞；`cycleRun` 返 `inWindow?active:idle` | ✅ 已迁：`cycle.kick()` 收口 run/pushWake/configure（非窗口期现按 idle 档兜底轮询，旧仅推送唤醒） | **P0** |
| **auto-farm 自动下田** | 已迁 createCycle（本模式参照实现）：`cycleRun` 返回下拍（限流退避>0 / `cycle.pending` 立即补扫 / active-idle 两档） | ✅ 已迁：旧 `scanning/scanPending/scanTimer/scheduleCycle/triggerCycle/doCycle` 全删，账本 bootstrap 与退避优先级保留，见 cycle.md §4 | **P0** |
| **domain-treasure 领域寻宝** | 已迁 createCycle：三段折叠为 `cycleRun` 一轮（doScan→consume），consume 逐条限流+名额满即停原样保留 | ✅ 已迁：`scanning||consuming` 双闸→cycle 内部单飞，8623 整批替换 queue 不变 | **P0** |
| **sea-treasure 海上夺宝** | 已迁 createCycle（同 domain，更简单）：无名额复查/无黑名单 | ✅ 已迁：同 domain-treasure，consume 逐条 `sleep(marchInterval)` 保留 | **P0** |
| **alliance-boss 联盟机甲** | `triggerTick`+`ticking`+`scheduleNext`（busy/idle/cold×3）+push 10435 | ✅ 已迁：`nextTickDelay()` 返 delay，`coldMisses` 留 feat；push 在飞时由旧丢弃改为 cycle.pending 立即补扫 | **P1** |
| **relic-reward 遗迹奖励** | 单飞 `scanning`+新窗唤醒+兜底（无退避） | ✅ 已迁：`scheduleNext` 的 min(POLL_INTERVAL, endTime+FLIP) 择时→`nextPollDelay()` 返回值 | **P1** |
| **truck-intercept 卡车争夺** | 已迁 createCycle：三段折叠为 cycleRun 一轮（doScan→consume→planNextRefresh），consume 逐条限流+rejectStreak 全局闸保留 | ✅ 已迁（所谓双闸坑为伪坑）：`scanning\|\|consuming` 在 cycle 内部单飞下自然折叠，无需扩 busy()；afterConsume 的 scanPending 补刷→cycle.pending→返 0 | **P1** |
| **alliance-science 联盟科技** | 已迁 createCycle：`nextTickDelay(snap)` 返 delay，`rejectStreak`/`honorCappedDay`/`relicBanUntil` 留 feat 侧 | ✅ 已迁：旧 `triggerTick/tickOnce/tickTimer/ticking` 全删；run 点火与 push 10021 回升均 `cycle.kick()` | **P1** |
| **city-skill 城市技能** | 已迁 createCycle：`tick()` 直接作为 run，尾部 `didGift/wakes/idle` 三分支搬至返回值 | ✅ 已迁：“绝对点仍属 A”判据活教材（`wakes.push(now+(endTime-serverTime)*1000+CD_BUFFER)` → `min(wakes)-now`）；旧 `schedule/timer/ticking` 全删 | **P1** |
| **player-like 玩家点赞** | 已迁 createCycle：`tick()` 作为 run，尾部 8 处 `schedule(…)` 全换为 `return …` | ✅ 已迁：daily 落盘闸门（`dailyLoaded/dailySaving/LOAD_STUCK_MS`）与调度无关、保留 feat 侧；旧 `schedule/timer/ticking` 全删 | **P1** |
| **alliance-help 联盟帮助** | 生产 `runTick` busy/idle（A）+ 消费 `createDrain`（B） | **半迁**：producer 换 cycle，drain 不动 | **P1** |
| **source-of-war 战争之源** | 固定窗口 4/12/20 + 每日 5 次配额 | **P2 核实**：有可重放读→A(delay=窗口−now)；队长侧状态别名才涉 workflow | **P2** |
| **alliance-gift 联盟礼物** | 触发形态待核 | **P2 核实**后归类（疑 A 或 D） | **P2** |

### B 族（→ `createDrain`，保持现状）

| feat | 现状 | 重构动作 |
|---|---|---|
| **titan-blessing 泰坦祝福** | `13226` push 逐条入台账 → drain；**不去抖**（去抖即漏领） | 已是 B，**不迁 A 主链**；可选把 `10904` 兜底链叠 cycle 当唤醒器 |
| **map/scanner 全局地图扫描器** | 扫块任务队列 + `createDrain` 串行 + 条间休眠 | 保持 B，不动 |

### C 族（→ `createEventHeap` / 快照池，绝不迁 A）

| feat | 现状 | 重构动作 |
|---|---|---|
| **floatcar 花车空投** | 已 `createEventHeap`，每台一 flow 各自 30s 网格 | **维持 C**；硬套 A 会丢可回放性 + RTT 叠拍 |
| **mine-cave 次元矿洞** | 裂隙广场 `nextWorldCheckAt/RefreshAt` 绝对时刻 + 冷热加权 | **P1 大改单列**：裂隙检测/刷新=C(wake.at)，下矿/偷/封配额=A-ish，两引擎拆开 |
| **alliance-rally 联盟集结** | `12003` 快照观测(无重放读)+`joinDelayMs` wakeAt+`pendingTeamIds` 消耗池 | D+C 样板；是抽「**快照池原语**」(入池带 TTL+一次性消耗)的首个消费者，不迁 A |

### E 族（模型外，别套 reconcile）

| feat | lane |
|---|---|
| **quick-attack / imperial-decree / hotkey/\*** | 交互命令（期望态用户给） |
| **chat-window / chat-overlay / global-map / map-overlay / render / terrain** | 信息浮层（订阅+自绘） |
| **classify / coord / map-meta / store / util / match** | 纯模块/数据层，非 feat |

## 4. 建议重构顺序（按收益/风险）

> **进度（2026-10-06，新一批后）**：第 1–7 步（P0 四家 + P1 八家 relic/alliance-boss/truck-intercept/alliance-science/city-skill/player-like）**已全部落地**，`npm run build` 三 bundle 通过（content 从 859.5kb → **856.8kb**）。第 8 步 alliance-help 半迁（producer 换 cycle、drain 保留）为待做的户后收尾项；mine-cave（拆两引擎）、source-of-war/alliance-gift（P2 核实形态）仍待评估。

1. **落地 `core/cycle.js`**（cycle.md §3）+ **auto-farm 参照迁移**（零行为改动，`npm run build` + 「下田和撤田」ndjson 回放对拍）。 ✅ 已完成
2. **launch-silo**（P0，骨架与 auto-farm 逐字相同，几乎复制粘贴）。 ✅ 已完成
3. **domain-treasure → sea-treasure**（P0，同 `triggerScan` 家族）。 ✅ 已完成
4. **relic-reward → alliance-boss**（P1，单飞简化版）。 ✅ 已完成
5. **truck-intercept**（P1，先解双闸门坑）。 ✅ 已完成（双闸门坑经证实为伪坑，与 domain/sea 同构折叠）
6. **alliance-help 半迁**（P1，producer 换 cycle，drain 保留）。
7. **city-skill / player-like**（P1，示范「绝对点仍属 A」——用它们做判据回归测试）。 ✅ 已完成（一并迁了 alliance-science）
8. **抽「快照池原语」**（C/D，由 alliance-rally 驱动，A 之外的下一个 core）。
9. **mine-cave / source-of-war / alliance-gift**（P1/P2，先核实形态再动）。

**红线**（继承框架 ADR）：迁移中不得在 cycle 内引入流程 DSL；不为单一实现套 `BackoffStrategy`/`DelayPolicy` 接口；floatcar/titan/rally **不因「看起来也是周期跑」而被误迁 A**。

## 5. 复合形态拆解原则

一个 feat 常占两模式，**分段各用其对**，别塞进单一原语：

- **A 产 → B 消**（alliance-help、titan 兜底）：外层 `createCycle` 管「何时重扫+下拍多久」，`run()` 里把候选**入队**，逐条执行交 `createDrain`。
- **A(delay=绝对点−now) 而非 C**（city-skill、player-like、alliance-science）：只要是单收敛态+有重放读，预测到点只是 `run()` 返回值的算法，不换原语。
- **C + A**（mine-cave、source-of-war）：多实例精确打点用时间轮，「能不能派」的配额收敛仍像 reconcile。
- **D + C**（alliance-rally）：push 入池是快照观测，`joinDelayMs` 错峰是 action 级 wakeAt。

## 6. 变更记录

- **2026-10-06**：**评审订正（四家 cycle 迁移 CodeReview 落地）**——truck-intercept `configure` 时刻表变更分支经评审确认保留 `cycle.kick()`（改 cap/模板时期望即时落到新节奏），注释订正为真实语义：kick 即时跑一轮、格点仍幂等不回填，多出的一次往返由 reloadGap 节流 + refreshUsed≥cap 总闸封顶；pending 补扫不破坏时刻表密度。另将文档/注释中把 `cycle.running` 当公开 API 的表述（cycle.md §4、归类表、truck/player-like 注释共 5 处）统一改为「cycle 内部单飞闸门（对外仅 kick/pending）」。构建通过。

- **2026-10-06**：**P1 第 5–7 步落地（truck-intercept / alliance-science / city-skill / player-like）**——四家一次性迁移到 createCycle，`npm run build` content 856.8kb。truck-intercept 所谓“双闸门坑”经实读代码证实为伪坑——与 domain/sea 同构，三段折叠成 `cycleRun` 一轮（doScan→consume→`if(cycle.pending)return 0; return planNextRefresh()`），`scanning\|\|consuming` 双闸自然被 cycle 内部单飞吸收，无需扩 busy() 契约；`rejectStreak`、`afterConsume` 中的 scanPending 补刷、`scheduleScan`、`triggerScan` 均删。alliance-science 与 boss/relic 同构，`nextTickDelay(snap)` 搬回 feat 侧择时（捐后 CHAIN_GAP / 池有余量 BUSY / 回点精准唤醒 / rejectStreak×3 退巡检 / 回点封顶 8×IDLE 夹块），push 10021 回升与 run 点火统一 `cycle.kick()`；`ticking/tickTimer/triggerTick/tickOnce` 全删。city-skill / player-like 作为“绝对点仍属 A”判据的活教材（`endTime - serverTime` / `SystemZeroTime+86400 - serverSec`），tick 尾部 `schedule(…)` 换 `return …`；player-like 的 daily 落盘闸门（`dailyLoaded/dailySaving/LOAD_STUCK_MS`）与调度无关、保留在 feat 侧。行为变化同 P0：run 抛异常由旧不重排→cycle 按 `fallback` 重排（truck=activeRefresh、science/city/player-like=IDLE或idleInterval），消除停摆隐患；pending 补扫语义从“旧在飞时 push/配置直接丢”→“下拍立即补扫”。

- **2026-10-06**：**P1 第 4 步落地（relic-reward / alliance-boss）**——两家均为单闸门纯 A（体内无 consume），删各自 `triggerScan/triggerTick`+`scheduleNext`+`ticking/scanning/tickTimer/pollTimer` 样板，改 `cycleRun` 返回 `nextPollDelay()`/`nextTickDelay()` 择时（relic 的 endTime+FLIP 翻窗拍、boss 的 busy/flip/cold×3/idle 选档均搬回 feat 侧返回值）。差异点：alliance-boss 有 push 10435 触发源，旧代码在飞时丢弃→现 `cycle.pending` 立即补扫（状态翻转不再干等整轮询）；relic 无 push（仅 run 点火+轮询），pending 恒不置位、行为等价。`fallback`：relic=POLL_INTERVAL、boss=IDLE_TICK_MS。`npm run build` 三 bundle 通过。

- **2026-10-06**：**P0 四家落地**——`core/cycle.js`（A 原语）+ 详设 [`docs/core/cycle.md`](core/cycle.md) 就位；auto-farm（参照）/ launch-silo（最纯 A）/ domain-treasure / sea-treasure（后两家 A 产 B 消，三段折叠成一轮、consume 逐条限流原样保留）均删除各自手写调度样板、`import createCycle` 并以 `cycle.kick()` 收口全部触发源。行为变化：run 抛异常由「`.catch` 后不重排」改为「按 `fallback`（active 档）重排」，消除永久停摆隐患。`npm run build` 三 bundle 通过。

- **2026-10-06**：首次全 feat 归类。确立 A/B/C/E 四族与「合并只在有可重放全量读时无损」的核心判据；修正「A=相对 delay、C=绝对时刻」的早期简化——**A/C 真实分界是「单收敛态+可重放读」vs「多独立自定时实例/边沿无重放读」**。source-of-war、alliance-gift 标 P2 待核实。
