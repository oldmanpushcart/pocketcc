# activity-hub.js — 活动感知总线（共享快照 + 推送合并 + 权威重查）

> 源码：[`src/core/activity-hub.js`](../../src/core/activity-hub.js)　·　日志 tag：`ACTIVITY-HUB`
> 配套：[`claim-runner.md`](claim-runner.md)（领取执行器）、[`cycle.md`](cycle.md)（电平调和）

## 1. 职责与边界

**适用**：需要「活动实例状态」的 feat——活动发现、`extra` 变化唤醒、领取后权威重查。典型是 841/10904/10912/3103 这组协议。

**管什么**（跨 feat 唯一的活动真相）：

- **841 全量快照**：`alist` 按 `String(id)` 建索引，整表替换；
- **10904 增量**：整活动推送（含 `id/type/extra`）合并进快照；
- **10912 增量**：`{aid, extra}` 合并；快照无此 aid 时用 3103 单查补齐（单飞 + 每 aid 节流）；
- **3103 重查**：`refresh(aid)` 返回权威活动对象，供领取后确认；
- **订阅广播**：活动变化时只回调 `match(activity)` 命中的订阅者，逐个 try/catch 隔离；
- **引用计数**：首个 `attach` 启动（一次 841 + 订阅推送），最后一个 `detach` 停止并退订；
- **扫描档位**：订阅者可声明 `scanIntervalMs`，hub 取最小非零值驱动周期 841；声明可经 `tune(label, ms)` 运行时调整（如空闲退避），没人声明就只在启动扫一次。

**不管什么**（铁律）：

- **不认识活动业务**：core 里不出现 `showUiType` 字符串、活动 id、可领判据——`match` 函数由 feat 传入；
- **不代发领取**：写协议归 [`claim-runner.js`](claim-runner.md) 或 feat；
- **不判定开放窗**：`begintime/endtime` 的解释归 feat（各活动口径不同）；
- **不拦截/改写推送**：hub 只读订阅 `net.10904/10912`，其它监听者收到的载荷不变。

## 2. 设计思路与取舍

### 2.1 为什么收口

收口前 6 个 feat 各写一遍「订阅 10912 → 按 aid 反查本活动 → 验 `worldUIRed` → 踢自己的 cycle」，3 个 feat 各发一份 841。复制的是管道，不是业务；且历史缺陷（pid 精度、跨服、红点脏数据）在多份拷贝里反复出现。

### 2.2 数据源优先级

`841`（权威全量）> `10912`（增量 extra）> `3103`（单活动权威）。10912 先于 841 到达时，extra 暂存 `pendingExtras`，等 841 合并时应用；快照里没有该活动则 3103 单查，查不到就等下一次 841。

### 2.3 被否决的方案

- **core 认识 `showUiType`**：业务常量进 core 会破坏 feat 可删性。否决，改为 feat 传 `match`。
- **hub 代发领取**：领取有活动专属状态机（CSHunt/发射井），会重蹈「万能流程引擎」。否决。
- **全局常驻轮询**：所有玩法关闭后仍在发 841。否决，改为引用计数归零即停。
- **把 901/10018 世界点位并进来**：那是「世界实体」总线（mask-dance），寻址方式与生命周期都不同。范围外，单独立项。

### 2.4 推送语义

- `10904 PUSH_ONE_ACTIVITY`：载荷是活动对象（至少含 `id/type/extra`），直接合并；
- `10912 PUSH_ONE_ACTIVITY_EXTRA`：载荷 `{aid, extra}`，只合并 `extra`；
- 同一轮 841 与推送交错时，以「最后到达」为准；841 整表替换会丢掉快照中不存在的新活动，因此 10912 带来的未入表活动暂存到 `pendingExtras`，由 841 合并。

## 3. API 契约

```js
import { activityHub } from '../../core/activity-hub.js';

// 引用计数：首个 attach 启动，最后一个 detach 停止
const detach = activityHub.attach({ label: 'city-award', scanIntervalMs: 5 * 60 * 1000 });

// 订阅：match 由 feat 提供；变化时只回调命中的订阅者
const unwatch = activityHub.watch(
  (a) => a.showUiType === 'DragonKingDuel',
  (a) => { /* a 是合并后的活动对象 */ },
  { label: 'city-award' },
);

activityHub.get(aid);          // 单个活动（String(id) 索引）
activityHub.list();            // 全量快照数组
activityHub.getByType(335);    // 按 type 取首个
activityHub.getByUiType('X');  // 按 showUiType 取首个
await activityHub.refresh(aid); // 3103 单查（单飞 + 3s 节流），返回活动或当前快照
await activityHub.refresh(aid, { force: true }); // 领取受理后立即确认：跳过 3s 节流，单飞仍生效
const { activity, fresh } = await activityHub.refreshEx(aid, { force: true }); // fresh=false=未拿到可信 3103 应答
await activityHub.scan();       // 立即 841（受 2s 最小间隔约束）
activityHub.requestScan();      // 同上，供领取成功后踢一拍
activityHub.tune(label, ms);   // 改本订阅者声明的周期档并立即重调定时器，返回命中数
```

`watch` 返回退订函数；`attach` 返回 detach。两者都幂等。

## 4. 场景用法

**新 feat（推荐）**：`attach` → `watch` → 回调里只做业务判定与 `cycle.kick()`；领取用 runner。

**迁移对照（mecha 为例）**：

```js
// 迁移前：ctx.on.push(10912) + isMechaTreasureAid(aid) + worldUIRed 门控
// 迁移后：
const unwatch = activityHub.watch(
  (a) => a.showUiType === SHOW_UI_TYPE_MECHA_TREASURE,
  (a) => { if (a.extra && a.extra.worldUIRed >= 1) cycle.kick(); },
  { label: 'mecha-treasure' },
);
```

**周期档位**：super-value-gift 需要 30s 兜底，`attach({scanIntervalMs: 30000})`；titan/defender 只按需，声明 `0`；city-award 声明 5 分钟。hub 取最小非零值。

**空闲退避**：feat 连续多轮无待领后可 `tune(label, 3 * 60 * 1000)` 放宽自己的档位（super-value-gift 实测 4.87h 零可领期白拉了约 70MB 的 841 全量），出现可领项时再 `tune` 回 30s。tune 只改本订阅者声明，若其它 feat 的最小档更小则整体周期不变；10904/10912 推送仍会即时唤醒订阅者，不依赖扫描档。

> 841 单帧平均约 124KB（31 个活动、含全部 point/atarget 明细），30s 档折合约 15MB/h 下行；调档前先算流量账。

**按需补读**：titan 启动读 `left` → `getByType(271)`；缺失时 `await refresh(aid)` 或 `await scan()`，不再自己发 841。

## 5. 数据流与降级

```
841 应答 ──parseData──> alist ──String(id)──> snapshot（整表替换 + pendingExtras 合并）
10904 ──合并活动对象──> snapshot ──notify(match)
10912 ──快照命中?──> 合并 extra ──notify(match)
              └─未命中─> 3103 单查（单飞/节流）──> 合并 ──notify(match)
```

降级：

- 841 未发出/被拒/畸形：保留旧快照，`info`（可预期拒绝）或 `warn`（畸形），不抛错；
- 3103 失败：返回 `null`，10912 的 extra 留在 `pendingExtras`，等下一轮 841；
- 订阅者回调抛错：`warn` 带订阅者 label，本轮跳过，不影响其它订阅者；
- 引用计数归零：停周期、退订、清空快照与 pending，回到零网络零内存。

## 6. 坑与边界

- **id 精度**：`841` 的 `id` 与 `10912` 的 `aid` 可能 number/string 混用，索引统一 `String(id)`；活动对象原样保留，发协议时按各协议要求取原类型。
- **10904 载荷形态**：顶层可能是 `{id,type,extra}` 或 `{aid,...}`，两种都认；缺 `id` 的载荷直接丢弃并 `debug`。
- **推送先于快照**：不要假设 10912 到达时 841 已就绪，走 `pendingExtras`。
- **3103 风暴**：多活动同时推送时单飞 + 每 aid 最小间隔（默认 3s），失败不立即重试。
- **领取后确认必须 `force`**：连环领取（如 842 逐个任务）的 3103 间隔约 1.5-2s < 3s 节流窗；不加 force 会拿到旧快照，把「已推进」误判成「无进展」而进指数退避。force 只跳过时间窗，不绕过单飞。
- **用 `refreshEx` 区分「验证失败」与「验证成功但无进展」**：`refresh` 在 3103 失败/节流/畸形时返回旧快照，单看对象无法区分；`refreshEx` 的 `fresh=false` 覆盖「未启动/被节流/net 未就绪/被拒/畸形/id 错配/代际失效」，表示「本轮没拿到可信应答」→ 只 retry 不计退避；`fresh=true` 表示应答已合并（即使内容未变）→ 可安全判定「无进展」进指数退避。
- **不把 `worldUIRed` 门控收进 hub**：它是活动业务语义，留 feat 的 `match/onChange`。
- **回调是 per-activity 的**：一次 841 首扫/周期扫描会对快照里每个活动各回调一次（`reason=scan`），watch 首挂同理（`reason=watch`）。`onChange` 不得逐条打日志，否则 30s 档位每轮刷 30+ 行；只对 `push-activity/push-extra/refresh` 留痕。
- **不要把 hub 当活动开关闸门**：hub 只保证「状态最新」，是否可领由 feat/descriptor 判。

## 7. 调试面

- 日志 tag `ACTIVITY-HUB`：启动/停止（info）、841 结果（debug/info/warn）、3103 单查（debug）、订阅者异常（warn，带 label）、推送合并（debug）。
- `activityHub.stats()` 返回 `{refs, subs, activities, lastScanAt, pending}`，供控制台与面板状态行使用。
- 不新增 `window.pocketcc` 调试入口；需要时由 feat 面板读 `stats()`。

## 8. 变更记录

- 2026-11-28：首版。收口 841/10904/10912/3103 感知；迁移台账见下。

## 迁移台账（本次范围）

范围 = 「活动总线」7 个存量 feat + 新增 city-award。**不留旧路径**：迁移完成后 feat 内不得再出现 841 发送、10904/10912 订阅、aid 反查、3103 发送。

| # | feat | 删除 | 替换 | 验收 |
| --- | --- | --- | --- | --- |
| 1 | super-value-gift | 841 轮询、10904/10912 订阅、3103 重查、claim 退避 | hub 快照 + `attach(30s)` + `refresh(aid)` + runner | 领奖链逐活动对拍；30s 兜底不退化；退避/拉黑行为不变 |
| 2 | titan-blessing | 启动 841 补查、10904 锁 activityId | `getByType(271)` + `watch` | left 展示、activityId 锁存时序 |
| 3 | alliance-defender | 按需 841（READ_GAP_MS） | `getByType` / `refresh` | aid/siege 缺失时启动时序 |
| 4 | mecha-treasure | 10912 订阅 + `isMechaTreasureAid` + 红点门控 | `watch(match, onChange)` | 推送唤醒即时性、红点门控 |
| 5 | sea-treasure | 同上 | 同上 | 同上 |
| 6 | domain-treasure | 10912 订阅 + `isDomainTreasureAid` | `watch` | 新矿脉唤醒 |
| 7 | aureole-slot | 10912 订阅 + 套皮反查 + 红点门控 | `watch` | 套皮反查、红点门控 |
| 8 | city-award（新） | — | hub + runner + 三 descriptor（9657） | 3 笔实录逐字对拍 |

**范围外（明确不做，不是尾巴）**：

- `mask-dance`：感知走 901/10018/聊天卡（世界实体总线），与活动总线不同构，单独立项 `WorldSiteFeed`；
- `cs-hunt` / `launch-silo` / `secret-realm` / `floatcar`：各自专用查询协议，不订阅 841/10904/10912；
- `cq26/*` 11 个：专用协议族，不在这条总线。

**完成定义（验收清单）**：

1. `grep -rn "10904\|10912" extension/src/feats` 仅剩 constants + 注释，`index.js` 无订阅；
2. `grep -rn "CMD_GET_ACTIVITY_DATA\|841" extension/src/feats` 仅剩 constants + 注释，无发送；
3. `grep -rn "3103" extension/src/feats` 仅剩 constants + 注释，无发送；
4. 7 个 feat 的 `isXxxAid` 反查函数删除；
5. `npm run build/lint/arch/test` 全绿，`npm run knip` 无新增未使用导出；
6. 每个 feat 的 dashcam 对拍或真机 A/B 记录在对应 `docs/feat-*.md`。