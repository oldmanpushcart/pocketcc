# snapshot-pool.js — 快照池（D 原语）

> 源码：[`src/core/snapshot-pool.js`](../../src/core/snapshot-pool.js)　·　日志 tag：`[POCKETCC://SNAPSHOT_POOL]`（feat 迁移时通常注入各自 feat 的 log）
> 选型上下文见 [`feat-控制模式归类.md`](../feat-控制模式归类.md)：本模块承载其中的 **D — 快照观测池**（C 族「边沿推送即事实」一侧的入池/消耗原语），与 `createCycle`（A）、`createDrain`（B）、`createEventHeap`（C，尚在 floatcar 内部）并列。

## 1. 职责与边界

**适用**：边沿推送即事实、**无重放读通道**的 feat——每条推送是一份独立快照，错过即丢失（如 12003 集结创建），绝不能套 A 的「下轮全量重读补回」合并语义。推送过完业务闸后把快照入池，延迟到点一次性消耗。

**管什么**（只兜四件跨 feat 共同的不变量）：

- **键控去重**：同键在池期间再 `offer` 一律拒入（返 `false`），不替换载荷、**不续命 TTL**——池内快照以首次入池为准，重复推送不得重置唤醒时刻；
- **TTL 惰性过期**：`expireAt` 已过的快照 offer 拒入、到点剔除；不挂后台扫子（池规模小，offer/wake/reschedule 三个触点顺带清即可）；
- **wake.at 托管唤醒**：每条目一个 `ctx.setTimeout`（reactor pause 统一清），到点先复查 TTL 再出池调 `onWake`；`wakeAt` 缺省/已过 → 0ms 立即（让同步栈先落地）；
- **一次性消耗**：`onWake` 调用前条目已出池，抛错也出池（warn 兜底）——「已处理」不可回滚，重试与否是调用方业务，池不拥有重试。

**不管什么**（刻意单薄，铁律，同 cycle/drain 的薄契约纪律）：

- **入池前的业务闸门全归调用方**：家族/行军/配额/在盟判定等逐条闸在 feat 侧过完才 offer，池不解读载荷；
- **到点后的动作编排全归调用方**：`onWake(key, payload)` 里发什么包、复查什么条件、计什么数，池一概不知；
- **不含优先级堆 / 批量弹出 / 流程 DSL**：多实例各自计时的复杂排程（同刻优先级、driver 单定时器睡堆顶）是 `createEventHeap`（C）的活，两个原语是不同的缝。

**对外契约**：`createSnapshotPool(o)` 返回 `{ offer, reschedule, size, has }`——`size/has` 为只读诊断面，无可变状态对外暴露。

## 2. 设计思路与取舍

### 2.1 为什么是「池+唤醒一体」而不是纯键控池

grilling 定稿（2026-11-14）：alliance-rally 现状的「池」只有 `pendingTeamIds` Set + `ctx.setTimeout` + 过期复查共 ~20 行，若只抽「键控去重+TTL」纯池，rally 侧只省 ~10 行，删除测试勉强及格、深度有限。把「入池→延迟→到点一次性消耗」整条收进原语后，删掉它复杂度集中回 rally 且未来同形消费者可复用——是深模块。四件不变量（去重/TTL/wake.at/一次性消耗）恰是跨 feat 一致的部分，其余（闸门、动作、计数）每家都不同，交回调用方。

### 2.2 被否决的方案

- **纯键控池（唤醒留 feat）**：**否决**。太浅，rally 只省 ~10 行，且「一次性出池」与「唤醒」分家会让调用方重新手搓 finally 清标记样板。
- **同键覆盖刷新（替换载荷+重置定时器）**：**否决**。rally 用不上（重复 push 直接丢），且重置定时器会让旧唤醒回调持有过期闭包，复杂度陡增。语义定为「拒入不续命」。
- **rally+titan 双迁**：**否决**。titan-blessing 台账是「已处理永不重派」的会话台账（uuid/坐标双键 + 13228 显式出队 + FIFO + 拉黑），与 rally 的「在途去重+到点消耗」语义不同形；为假想消费者加宽接口违背「一个适配器=假想缝，两个=真缝」。等第二个真实同形消费者出现再谈泛化。
- **run 期创建+dispose 重建**：**否决**。与「pause 保留条目、resume 续跑」定案矛盾（条目随旧池丢失）。采模块级创建 + `ctx: () => ctxRef` 热读访问器（与 createCycle 同形态）。
- **createEventHeap 同刀提取**：**否决**（本轮）。heap 服务 floatcar 多实例计时，与快照池是不同的缝；floatcar 刚做完 pause/resume 实机验证，少动一家降回归面。另立任务。

## 3. API 契约

```js
import { createSnapshotPool } from '../../core/snapshot-pool.js';

const pool = createSnapshotPool({
    alive:  () => boolean,          // 运行态闸门（通常接 reactor ctx.alive()）；false 时 offer/reschedule 拒动
    ctx:    () => object | null,    // reactor ctx 访问器（热读）；null 或托管失败（setTimeout 返 -1）时 offer 拒入
    onWake: (key, payload) => void | Promise<void>,  // 到点消耗回调；抛错由池兜住（warn），条目不回池
    log:    logger,                 // 可选，缺省 createLog('SNAPSHOT_POOL')；迁移时一般注入 feat 自己的 log
});

pool.offer(key, payload, { wakeAt, expireAt });  // → boolean。同键拒入不续命 / expireAt 已过拒入 / 非运行态或无 ctx 拒入
pool.reschedule();   // resume 后由 run() 调：过期者剔除，未过期者重排唤醒（wakeAt 已过 → 立即）
pool.size();         // 只读诊断：池内条目数
pool.has(key);       // 只读诊断：键是否在池（不做惰性过期判定）
```

**时刻口径**：`wakeAt`/`expireAt` 均为 `Date.now()` 基准的**毫秒**时刻；`expireAt` 0/缺省 = 不过期。调用方拿到的服务器秒级时间戳须自行 `×1000`（rally 的 `expireTime` 即如此）。

**内部时序不变量**：`onWake` 调用前条目已 `entries.delete`（一次性消耗，抛错不回池）；到点先复查 TTL 再回调（延迟期内过期静默剔除，动作日志归调用方）；`arm()` 先清旧句柄再排新（reschedule 幂等，不重复唤醒）。

## 4. 场景用法（首个消费者：alliance-rally）

```js
const pool = createSnapshotPool({
    log, alive: aliveFn,
    ctx: () => ctxRef,
    onWake: (key, payload) => joinFlow(payload.key, key, payload.expireTime)
        .catch((err) => log.warn('join flow threw!', err)),
});

// push  handler：业务闸（目录/启用/家族/在盟/余位/成员上限/行军/每日上限）全过后——
const accepted = pool.offer(teamId, { key: target.key, expireTime: d.expireTime }, {
    wakeAt: Date.now() + Math.max(0, tcfg.joinDelayMs | 0),   // 错峰加入
    expireAt: d.expireTime > 0 ? d.expireTime * 1000 : 0,     // 集结过期 TTL
});
if (!accepted) return;   // 同键在池（重复 push）或已过期

// run(ctx)：resume 续跑 pause 保留的未过期条目（首轮池空 no-op）
pool.reschedule();
```

旧 `pendingTeamIds` Set + `scheduleJoin` + joinFlow 尾部 `finally` 清标记全删；joinFlow 的 expireTime 复查留作双保险（时钟漂移边界）。源码守卫见 `tests/feats/alliance-rally-pool.test.js`。

**行为差异（有意增强）**：旧 `run()` 会 `pendingTeamIds.clear()`——pause 再 resume 后已延迟的集结被放弃；新语义 pause 清定时器保留条目、resume 重排续跑（与 titan/floatcar「pause 保留、恢复续跑」同口径），未过期集结不再因暂停丢失。

## 5. 数据流与降级

```
边沿推送(12003) ──▶ feat 业务闸（逐条，不过即丢）──▶ offer(key, payload, {wakeAt, expireAt})
   ├─ 同键在池 / expireAt 已过 / 非运行态 / 无 ctx ──▶ false（拒入）
   └─ 入池 ──▶ ctx.setTimeout(wakeAt − now)（托管，pause 统一清）
到点：
   ├─ alive()=false ──▶ 静默（pause 竞态双保险）
   ├─ entries.delete(key)（一次性消耗，先出池）
   ├─ expireAt 已过 ──▶ 静默剔除（不调 onWake）
   └─ onWake(key, payload) ──▶ 抛错/拒 Promise 均 warn 兜底，条目不回池
pause：reactor 清光托管定时器，池条目保留
resume：run() ──▶ reschedule()（过期剔除 + 未过期重排，wakeAt 已过→立即）
```

**降级**：无独立降级档——`onWake` 抛错只 warn 不重试（重试归调用方）；托管失败（ctx 非激活返 -1）拒入不留孤儿条目。TTL 无后台扫子，极端情况下过期条目滞留到下一个 offer/wake/reschedule 触点才清（`has/size` 诊断面可能短暂含过期条目，属设计如此）。

## 6. 坑与边界

- **拒入不续命是设计如此**：重复推送不得重置唤醒时刻——否则「不断被推的集结永远加不进去」。需要「后续推送更新状态」的场景不适用本原语。
- **expireAt 负值/0 = 不过期哨兵**：调用方不得拿负时间戳当「已过期」传入（会被当不过期）；「已过期」判定只在 `expireAt > 0` 分支生效。
- **一次性消耗不可回滚**：`onWake` 抛错条目也出池——「已处理」语义优先于「重试」。需要重试的 feat 自己在回调里编排（池不拥有重试策略）。
- **reschedule 必须由 run() 调**：池不自动感知 resume（无 reactor 钩子依赖，薄契约）；忘调则 pause 保留的条目永不唤醒。rally 有源码守卫断言此调用存在。
- **不与 A 混用**：有可重放读通道的 feat 走 createCycle；本原语只服务「推送即事实」的边沿场景。也不吞 C 的活：N 实例各自计时+同刻优先级排程走 createEventHeap。
- **mock 时钟测试注意**：node:test mock timers 的 Date 从 0 起算，构造「已过期」用例须先 tick 到正时刻再取 now（负 expireAt 会命中「不过期」哨兵）。

## 7. 调试面

- 日志 tag：独立使用时 `[POCKETCC://SNAPSHOT_POOL]`；rally 迁移注入 feat 自己的 log（`[POCKETCC://ALLIANCE_RALLY]`），故 onWake 异常在 feat 日志里看 `snapshot pool onWake threw!`。
- 诊断面 `size()/has(key)` 只读；池内条目（payload/wakeAt/expireAt/timer）均私有闭包，观测靠 feat 侧入池/消耗日志。
- 契约测试：`tests/core/snapshot-pool.test.js`（8 例，mock timers 含 Date，零真实时钟）；迁移守卫：`tests/feats/alliance-rally-pool.test.js`（1 例）。

## 8. 变更记录

- **2026-11-14**：首落地（grilling 两轮定稿：池+唤醒一体 / rally 单消费者 / 拒入不续命 / 模块级+ctx getter / pause 保留+定时器清 / EventHeap 不同刀）。抽出 D 原语 `createSnapshotPool`，只兜去重/TTL/wake.at/一次性消耗四不变量；首个消费者 alliance-rally 迁移（删 pendingTeamIds/scheduleJoin，joinFlow 改 onWake 回调，run 调 reschedule）。行为增强：pause 再 resume 后未过期集结续跑（旧口径放弃）。arch 规则 schedule-primitives-thin 扩名覆盖本模块。契约测试 8 例 + 源码守卫 1 例。