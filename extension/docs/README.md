# extension/docs — 核心 API 设计文档

`src/core/` 里的底座模块（battle / march / player / …）承载的是跨 feat 复用的设计决策：数据来源口径、与游戏运行时的边界、降级策略。这些内容既不适合塞进产品级 [README](../README.md)，也不该只活在源码头部注释里（检索性差、版本一挪动就散落）。本目录按「一个核心 API 一篇文档」收拢它们。

> 与仓库其他文档的分工：
> - [`references/`](../../references/) — **游戏怎么实现的**（逆向证据，只读）。
> - `.qoder/repowiki/` — 工具**自动生成**的 wiki（会被重生成覆盖，非手写真相）。
> - 本目录 — **pocketcc 自己的 API 怎么设计的、为什么**（决策与取舍的单一真相，随代码演进手工维护）。

## 文档索引

| 文档 | 模块 | 一句话职责 |
|---|---|---|
| [core/battle.md](core/battle.md) | `src/core/battle.js` | 行军发包载荷构造（三场景：快速/普通/活动派兵） |
| [core/march.md](core/march.md) | `src/core/march.js` | 行军统一抽象（取列表/名额/发撤/生命周期），归一 8 个 feat |
| [core/item.md](core/item.md) | `src/core/item.js` | 物品查询/标识薄工具层（持有量/中文名/奖励解析），收口 4 个 feat |
| [core/map.md](core/map.md) | `src/core/map.js` | 世界地图常量真相+三系坐标转换+单窗 901 只读查询底座，收口 map-meta/coord 与 3 处 901 探针 |
| [core/cycle.md](core/cycle.md) | `src/core/cycle.js` | A 原语：电平调和循环驱动器（单飞/合并/绝不停摆），已收口 P0 四 feat |
| [core/world-state.md](core/world-state.md) | `src/core/world/state.js` | 世界态归一层（Kind/Place/Phase/Gen），为 `world` 门控与跨服图降级提供单一真相 |
| [core/reactor.md](core/reactor.md) | `src/core/reactor.js` | 功能调度中枢：spec 说明书驱动的生命周期装配、门控重算、`ctx.on.*` 退订托管 |
| [core/net.md](core/net.md) | `src/core/net.js` | 网络底座：双通道 hook + 三 bus 命名空间 + promise 发包 + req↔resp reqTime 配对 |
| [core/registry.md](core/registry.md) | `src/core/registry.js` | 特征存储与运行时编排：descriptor 聚合 + 配置版本化（version/migrate/strictConfig） |
| [core/storage.md](core/storage.md) | `src/core/storage.js` | UID 隔离存储抽象：双 blob + slot + raw 通道 + 每 blob 串行队列 + 上下文失效降级 |

（规划中：core/player.md——后续同类 API 改动时补。）

> 另见：[`feat-控制模式归类.md`](feat-控制模式归类.md) —— 非单篇 API，而是全 feat「控制结构选型」的单一真相（A/B/C/E 四族归类 + 30 秒决策树 + 逐条重构顺序）。
>
> feat 侧协议台账（号段语义 / 闸门常量 / 状态枚举 + 每条判据的实录与反编译出处）也收在本目录，按 feat 一篇：
> [`异能兽培育.md`](异能兽培育.md)（`src/feats/player/beast-breed.js`）、
> [`feat-雷达任务.md`](feat-雷达任务.md)（`src/feats/player/radar-task.js`）、
> [`feat-战区宝藏.md`](feat-战区宝藏.md)（`src/feats/cq26/excav.js`，含「为什么不嗅探地图地块 / 不用 EventCenter」的通道选型取舍）、
> [`feat-霜之密所抢购.md`](feat-霜之密所抢购.md)（`src/feats/cq26/shop.js`，含「为何 burst 必须 `gate:false` 裸发 + 本地镜像收敛」「push 与 status 1→2 同秒 ⇒ 无可提前量」的取舍）、
> [`feat-机械制药.md`](feat-机械制药.md)（`src/feats/player/potion-craft.js`，制药 lane 单飞排产）、
> [`feat-快速修理.md`](feat-快速修理.md)（`src/feats/player/quick-repair.js`，英雄免费快速修理 + 医院加速，含「只开免费线」灰度用法）。
>
> [`荒芜冰原-巨熊盛宴.md`](荒芜冰原-巨熊盛宴.md)（CQ26 **BWL 线**「巨熊盛宴」玩法说明，**纯逆向 + 录制实证、未实现 feat**）—— 阶段机（GATHER→FEED→SHOW，22032）+ 融冰 2103 / 小游戏 2129 / 礼盒 2106 / 密礼 2108·22064 / 能量喂养 22044 / **巨熊宝藏**（奖励宝箱 实体 315·2104/2105）逐条协议与实录数值；与采集线（NWL）互斥独立。
>
> [`acl-cq26-荒芜冰原.md`](acl-cq26-荒芜冰原.md)（`src/core/acl/game-data.js` 的 NWL 区段，**待实现**）—— 荒芜冰原 2111~2130 / 22071~22077 字段字典与投影契约，含「一个分区只有一种玩法」「`k` 就是 `wkid`」「`todayCanGatherTime` 是剩余、`todayCollectDuration` 是已用」等判据。
>
> [`feat-荒芜冰原采集.md`](feat-荒芜冰原采集.md)（`src/feats/cq26/wl-gather/`，**设计定稿、未实现**）—— 一个 feat 三腿（采集 2114 / 协助 2116 / 盗采 2115）的组织与决策文档：为何合一、`2201→2120→901` 三层扫描的成本口径、三腿谓词与配额、对拍规则表、8 条已知缺口；协议与判据的真相源在 ACL，本篇只写「怎么组织与怎么决策」。
>
> 异能秘境自动驾驶两篇递进，改动前先读 v4（施工图，带竞品逐行索引与 ACL 缺口清单）：
> [`feat-异能秘境自动驾驶-v3重设计.md`](feat-异能秘境自动驾驶-v3重设计.md)（现状根因 + 竞品拆解）→
> [`feat-异能秘境自动驾驶-v4竞品B对齐重写.md`](feat-异能秘境自动驾驶-v4竞品B对齐重写.md)（逐行映射 + 施工步骤）。

## 统一模板（八节）

每篇 `<api>.md` 按以下小节组织，无内容的小节写「暂无」而不是删掉，保证跨篇可对读：

1. **职责与边界** — 这个模块管什么、明确不管什么；对外契约（产出物的字段形态等）。
2. **设计思路与取舍** — 为什么这么设计，**含被否决的备选方案与否决理由**。这节是文档的核心价值：代码能表达「是什么」，只有文档适合沉淀「为什么不是别的」。
3. **API 契约** — 方法签名、参数语义（含默认值与极性）、返回值形态。
4. **场景用法** — 以业务场景组织的调用示例，每个场景给出对应的底层语义。
5. **数据流与降级** — 从输入到产出的路径图；首选路径不可用时（符号漂移等）每档降级行为。
6. **坑与边界** — 实证踩过的坑、易误用处、混用风险。
7. **调试面** — 控制台直接可戳的表达式、日志 tag、探针工具。
8. **变更记录** — 追加式，带日期；重大 API 变更（改默认极性、删方法等）必须留痕。

## 维护约定

- **源码头部 JSDoc 与本目录文档同步改**：JSDoc 保留精简版（签名 + 一句话语义），设计思路与取舍的完整版只写在 docs；改 API 不动对应 `.md` 视为改动未完成。
- 文档内引用游戏源码结论时，标注证据出处（`references/` 路径或真机探针）。
- 事实以代码为准：文档与 `src/core/*.js` 冲突时，先读码核实，再修文档。
