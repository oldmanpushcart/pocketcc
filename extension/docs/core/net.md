# net.js — 网络底座（三 bus 命名空间 + 双通道 hook + promise 发包）

> 源码：[`src/core/net.js`](../../src/core/net.js)　·　日志 tag：`[POCKETCC://NET]`　·　具名导出：`netApi`

## 1. 职责与边界

**一句话**：收口游戏两条发送通道与单点入站 hook，把「发包 / 订阅推送 / 应答配对 / 采集」统一成 promise 与 bus 三条命名空间，业务层只依赖能力 API、不触碰游戏网络符号。

**管什么**：

- **发包封装**：`send / sendPB / sendPBV2(cmd, data) → Promise<Ret{code,data,ok,reason}>`，超时由 `withTimeout` 兜底；在途查询 `isSending(cmd)`。
- **三条 bus 命名空间**：`net.<cmd>`（推送）、`net.resp.<cmd>`（应答）、`net.req.<cmd>`（本端发包，经 `onReq` 按需拉起）。
- **双通道观测**：主通道 `NetMgr.NET` 实例 + 次通道 `NetMgrSimple.prototype` 各挂发送 hook；入站在 `NetReciver.getInstance().onMessage` 单点覆盖两条通道。
- **心跳过滤**：`hbCodes` 集合滤掉两条通道心跳（主 0/NO_QUEUE_HEART、次 6385/TM_WATCH_HEART），不入日志/采集/dashcam。
- **采集面**：`collecting()` 环形缓冲 + 过滤谓词链 + 实时 tap；`stream/isStreaming` 流式观测。

**不管什么**（铁律）：

- **不解读协议字段含义**：只搬运 `Event{cmd,status,data,ord,ts,reqTime,raw}`，业务语义归各 feat。
- **不自启**：由 boot.js 在登录成功、场景就绪后调 `install()`（扩展内不自动挂钩）。
- **不承诺事务回滚**：`pause` 后已发出的请求收不回是物理事实。

## 2. 设计思路与取舍

- **具名导出 `netApi` 而非 `net`（本轮改造）**：早先 reactor/feat 经 `window.pocketcc.net` 懒取底座，代价是变成 dependency-cruiser 看不见的影子依赖。现改为 `import { netApi }`，装配期即就绪、`window.pocketcc.net` 降为纯调试面。命名用 `netApi` 是因 IIFE 内部已有局部 `var net`（NetMgr.NET 实例）会遮蔽同名导出。
- **入站单点、出站双点**：两条通道的报文最终都汇聚 `NetReciver.getInstance().onMessage`，故入站只挂一处即全覆盖；出站两条通道物理隔离（秘境/观战走另一条 websocket），必须各自 hook，否则只包主通道会让次通道整族 req 消失。
- **次通道只包原型不包门面**：`NetMgrSimple.prototype` 与 `_socket` 销毁重建无关，一次挂钩长期有效；包 `TMWatchNetMgr` 门面会让同一条包记两次（门面在地图外转调 NET）。
- **心跳用集合而非单值**：入站认不出报文来自哪条通道，拿主通道号去滤会让次通道心跳应答整族漏进日志/采集。报文实证 dashcam 20261010T211527：1177 行里 68 行是 cmd 6385 心跳（占 5.8%）。
- **被拒静默不抛异常**：游戏两条通道在 needDisable / MsgIDSettings / `cdTime` 太频繁 / encode 失败处 `return!1`，无异常；被拒语义用 `CODE_NOT_SENT` 等哨兵码表达，不用异常控制流。

## 3. API 契约

```js
import { netApi } from '../../core/net.js';   // 装配期已就绪；feat 一般经 ctx.net 取用

netApi.install();                 // boot 登录成功后调，挂入站/发送 hook
netApi.send(cmd, data);           // → Promise<Ret>，主通道
netApi.sendPBV2(cmd, data);       // → Promise<Ret>，PBV2（两条通道按 isPabBattleMap 分叉）
netApi.isSending(cmd);            // 在途查询（net.checkRequestIdNoRes）
netApi.onReq(handler);            // 本端发包 hook：req 仅在包真上线后派发
netApi.secondaryStatus();         // 'pending' | 'ok' | 'missing' —— 次通道挂点探测态
netApi.reprobeSecondary();        // 改版当天清负缓存重探，无需刷页
netApi.setLog(bool) / isLogging();// 发送 hook + 入站打印总开关
netApi.collecting() / stream;     // 采集环形缓冲 / 流式观测
// Ret：{ code, data, ok(code===0), reason(PBV2 拒绝多语言 key，仅 s≠0 带 key 时非空) }
```

**订阅一律经 `ctx.on.push/resp/req`**（退订由 reactor 托管）：`ctx.on.req` 内部走 `netApi.onReq` 按需拉起发送 hook，直接 `bus.on('net.req.…')` 会订到一条永不派发的空事件。

## 4. 场景用法

- **发写请求**：`const ret = await ctx.net.sendPBV2(cmd, data); if (!ret.ok) { /* 按 ret.code 归类，被拒走 info 不 warn */ }`。字段形态须与 dashcam 录制报文逐键一致。
- **req↔resp 配对**：「请求带而应答不带」的字段只能从 req 侧取（实证：秘境 8532 req 带 `{x,y}`、应答不带）。配对用应答的 `Event.reqTime`（= 该应答那条请求的发出时刻），在 req 流里取 `ts <= reqTime` 中最大的一条，**不靠 FIFO + TTL 猜**。
- **逻辑 cmd vs 线上 cmd**：req 事件名是逻辑 cmd、resp 是线上 cmd；主通道有 `msgIdReplaceMap`/`getOldCmd` 换号，换号时两者不同名（次通道无换号表）。
- **次通道降级恢复**：`secondaryStatus()==='missing'` 时改版当天调 `reprobeSecondary()` 重探即可，不必刷页。

## 5. 数据流与降级

```
发送：feat → netApi.sendPBV2(cmd,data) → 主/次通道 send* → 游戏 encode 上线
        ├─ 上线成功 → req 事件（net.req.<逻辑cmd>）→ 在途登记
        └─ return!1（needDisable/cdTime/encode失败）→ 静默，哨兵码，不抛
入站：NetReciver.onMessage(e, reqTime)（两条通道汇聚单点）
        → Event{cmd,status,data,ts,reqTime,raw} → 心跳 hbCodes 滤除
        → 命中在途请求 → net.resp.<cmd>（携 reqTime） ；纯推送 → net.<cmd>
```

**降级**：install 探不到次通道挂点则整局降级（`secondaryStatus='missing'`）且不重试，需显式 `reprobeSecondary`；`send/sendPBV2` 超时由 `withTimeout` reject，调用方兜底。

## 6. 坑与边界

- **心跳不进观测面**：`hbCodes` 已滤两条通道心跳，故 dashcam 录音与 `collecting()` 里没心跳行，对拍时别当成漏采。
- **`ctx.on.req` 是唯一正解**：绕过它 `bus.on('net.req.…')` 是空订阅（发送 hook 未按需拉起）。
- **req 只在真上线后派**：`return!1` 的静默拒绝不会产生 req 事件，据此可判断包是否上线。
- **Int64 字段按字符串读**：64 位 ID 不做 Number 转换（精度陷阱），比较用字符串。
- **raw 只读池化**：`Event.raw` 是复用缓冲，跨帧持有需自行拷贝。

## 7. 调试面

- `pocketcc.net.secondaryStatus()` 看次通道态；`pocketcc.net.setLog(true)` 开全量收发打印（关闭零开销）。
- `pocketcc.net.collecting()` 拉当前采集窗口；协议形态对拍走 `dashcam/store/<uid>/…` NDJSON。
- 日志：NET tag；被拒走 info、循环/心跳走 debug，真异常才 warn。

## 8. 变更记录

- **2026-10-31（架构审视轮）**：新增具名导出 `export let netApi`（IIFE 内 api 构造完成后回赋值），供 reactor/feat 走 ESM import，替代 `window.pocketcc.net` 全局摸取；`window.pocketcc.net` 降为纯调试面。配合 ESLint `no-restricted-syntax` 禁 feats 摸 `window.pocketcc.*` 与 `.dependency-cruiser.cjs` core 分层规则，把影子总线腐蚀轴升级为可执行闸门。
