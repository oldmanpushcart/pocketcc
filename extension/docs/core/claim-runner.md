# claim-runner.js — 活动领取执行器（协议分派 + 节奏 + 退避）

> 源码：[`src/core/claim-runner.js`](../../src/core/claim-runner.js)　·　日志 tag 由 feat 注入
> 配套：[`activity-hub.md`](activity-hub.md)（活动感知总线）、[`cycle.md`](cycle.md)（调度节拍）

## 1. 职责与边界

**适用**：活动类 feat 的「领取动作管线」——一次写请求从发出到回执分类的全过程。典型场景是 1777/3140/842/3135/4790/8768/8795/8833/9657 这类领奖协议。

**管什么**：

- **协议分派**：`register(cmd, {protocol, body, key, label})` 声明每个协议号的发送通道、载荷构造、退避键与日志语义；
- **节奏**：两次领取动作之间至少 `actionGapMs`（默认 1500ms），防连点被服务器限流；
- **在途闸门**：`gate: true` 交给 `sendGuarded`，与全局发包闸门共用；
- **回执分类**：`ok`（受理）/`rejected`（业务拒绝）/`transient`（未发出/-1）/`suppressed`（本地退避中）/`unregistered`（协议未注册）/`aborted`（signal 中止）；
- **退避**：业务拒绝固定 15 分钟；「已受理但权威状态未推进」指数退避 20s×2^n 封顶 5min；transient 不退避；
- **退避键**：默认 `cmd:aid:targetId`，feat 可覆盖（保持跨版本稳定，prune 按此解析）。

**不管什么**（铁律）：

- **不认识活动业务**：可领判据、协议号、参数形态全部由 feat 提供；
- **不拥有调度**：下一拍睡多久由 feat 的 `createCycle` 决定，runner 只管单次动作；
- **不判定开放窗/红点**：那是 feat 的事；
- **不做权威确认**：确认走 `activityHub.refreshEx(aid, {force:true})`，runner 只在 feat 判定后清退避（`confirm`）。

## 2. 设计思路与取舍

### 2.1 为什么收口

super-value-gift 曾自建 6 个退避/拉黑函数（`claimCooldown/suppressClaim/noProgress...`），city-award 又写一遍「受理 → 等推送 → 超时补查」；复制的是节奏与回执分类，不是业务。收口后 feat 只保留「领什么、什么时候算成功」的判据。

### 2.2 退避语义

| 回执 | 状态 | 退避 | 说明 |
| --- | --- | --- | --- |
| ok + 权威推进 | 成功 | `confirm` 清退避 | 推进判定归 feat（refreshEx 后比对） |
| ok + 权威未变 | 无进展 | `noProgress`：20s、40s、80s…封顶 5min | 防服务器「受理但不执行」时连环重发 |
| code≠0 | 业务拒绝 | `suppress`：固定 15min | 可预期拒绝（限额/未开/无权），15 分钟后重试 |
| code=-1 | transient | 不退避 | 未发出/在途，下一轮自然重试 |
| 本地退避中 | suppressed | 不发包 | `isSuppressed` 先行短路 |

### 2.3 被否决的方案

- **runner 内置确认闭环**：确认协议（3103 vs 推送）与「算不算推进」因活动而异，内置会变成万能流程引擎。否决，确认留在 feat。
- **全局单例 runner**：退避状态必须按 feat 隔离（日志 tag、节奏参数、拉黑口径不同）。否决，每次 `createClaimRunner` 一个实例。
- **按 Date.now() 对齐服务器时间**：退避是本地节流，服务端漂移不影响量级。保持本地时钟（可注入 `now` 供单测）。

## 3. API 契约

```js
import { createClaimRunner } from '../../core/claim-runner.js';

const runner = createClaimRunner({
  log,                          // feat 的 logger（日志 tag 跟着 feat 走）
  actionGapMs: 1500,            // 节奏（默认 1500）
  businessBackoffMs: 15 * 60 * 1000, // 业务拒绝退避（默认 15min）
  noProgressBaseMs: 20 * 1000,  // 无进展指数退避基数（默认 20s）
  noProgressMaxMs: 5 * 60 * 1000,    // 无进展封顶（默认 5min）
});

runner.register(842, {
  protocol: 'send',             // send | sendPB | sendPBV2
  label: 'generic-task',        // 日志语义
  body: (item) => ({ aid: item.aid, tid: item.targetId }),
  key: (item) => `842:${item.aid}:${item.targetId}`, // 可选，默认 cmd:aid:targetId
});

const r = await runner.claim({ cmd: 842, aid, targetId, body, signal });
// r.status: ok | rejected | transient | suppressed | unregistered | aborted
// r.ret: 原始 Ret；r.code: 数值码（-1 未发出 / -2 未注册 / -3 退避 / -4 中止 / -5 无回执）
```

确认与清理：

```js
runner.confirm(item);   // 权威推进后清退避
runner.suppress(item);  // 业务拒绝后固定退避
runner.noProgress(item); // 已受理但未推进，指数退避
runner.isSuppressed(item); // 不发包，先行判定
runner.prune((key, entry) => /* 活动仍存活? */); // 每轮按业务存活裁剪
runner.reset();         // 全量清空（activate 复位 / 测试隔离）
runner.stats();         // {handlers, cooldowns, lastClaimAt}
```

## 4. 场景用法

**标准领取链（super-value-gift 范式）**：

```js
// ① 发领取
const r = await runner.claim({ cmd, aid, targetId, body, signal: ctx.signal });
if (r.status === 'suppressed') return 0;
if (r.status === 'transient' || r.status === 'aborted') return { stop: true };
if (r.status === 'rejected') { runner.suppress(item); return 0; }

// ② 权威确认（hub 单查，必须 force）
const { activity, fresh } = await activityHub.refreshEx(aid, { force: true });
if (!fresh) return 0;                       // 验证失败：只 retry，不计退避
if (stillClaimable(activity, item)) {
  runner.noProgress(item);                  // 验证成功但无进展：指数退避
  return 0;
}
runner.confirm(item);                       // 确认推进：清退避
```

**生命周期**：`install` 里 `createClaimRunner` + 全部 `register`；`run` 里 `runner.reset()`；`pause` 不需要释放（无定时器、无订阅）。

**每轮裁剪**：`cycleRun` 开头用 `prune((key) => 活动仍开放且仍有可领项)`，活动结束/换日后不残留退避。

## 5. 数据流与降级

```
claim(item) ──> isSuppressed? ──yes──> suppressed（不发包）
   │no
   ├─ gap = actionGapMs - (now - lastClaimAt) > 0 ? sleep(gap, signal)
   ├─ signal.aborted ? ──> aborted
   ├─ getNet() 不可用 ? ──> transient(-1)
   ├─ sendGuarded(cmd, body, {protocol, gate:true})
   │    ├─ code=-1 ──> transient（不退避）
   │    ├─ code≠0 ──> rejected（feat 决定 suppress）
   │    └─ ok ──> ok（feat 决定 confirm / noProgress）
```

降级：

- `sendGuarded` 抛错：catch 后返回 `transient`，`warn` 带 cmd/label；
- net 未就绪：`transient(-1)`，`debug`；
- signal 中止：等待早醒后返回 `aborted`，不发包；
- 退避表无上限增长：由 feat 每轮 `prune` 兜底。

## 6. 坑与边界

- **退避键要稳定**：prune 按 `key.split(':')` 解析 cmd/aid/targetId；改格式会让旧退避无法裁剪（super-value 复刻了 `cmd:aid[:tid]` 口径）。
- **`actionGapMs` 用本地时钟**：测试注入 `actionGapMs: 0` + 假 `now`，否则跨用例时间回退会触发真实 `sleep`（曾出现单用例 21s 挂起）。
- **`reset()` 与 `prune()` 分工**：`reset` 回到刚创建状态（activate/测试）；`prune` 只按业务存活裁剪（每轮）。
- **transient 不进退避**：游戏侧限流/未发出会自愈，退避反而挡住恢复；连续 transient 由 feat 的 cycle 节拍兜住。
- **`rejected` 不等于拉黑**：`suppress` 是 feat 的决策（如「已领完」不该拉黑，「无权领取」才拉）；runner 不自动 suppress。
- **body 保留原始 ID 类型**：842/3140 的数字 aid/tid 不能转字符串（服务器按类型校验），Int64 用字符串。
- **`gate: true` 是硬约定**：runner 发出的领取与其它写动作共用全局闸门，不要为绕过节流改 false。

## 7. 调试面

- 日志由 feat 注入的 logger 输出：受理（debug）、拒绝（info，带 code/reason）、未发出（warn）、无进展退避（debug，带 key/streak/delay）、退避中跳过（debug，带 retryAfter）。
- `runner.stats()` 返回 `{handlers, cooldowns, lastClaimAt}`，供面板状态行/控制台。
- 无独立 `window.pocketcc` 入口；排查顺序：feat 日志 → hub `stats()` → runner `stats()`。

## 8. 变更记录

- 2026-11-28：首版。收口 super-value-gift 自建退避与 city-award 受理确认节奏；`reset()` 支撑 activate 复位与测试隔离。