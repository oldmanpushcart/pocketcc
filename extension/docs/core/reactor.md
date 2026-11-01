# reactor.js — 功能调度中枢（说明书驱动的装配与门控）

> 源码：[`src/core/reactor.js`](../../src/core/reactor.js)　·　日志 tag：`[POCKETCC://REACTOR]`

## 1. 职责与边界

**一句话**：一个功能的全部声明都交给 `register(spec)`；运行期只由两个变量决定起停——面板 `enabled`（registry 推 `setConfig`）与门控 `gates`（world/mode）。

**管什么**：

- **生命周期三段**：`install`（只做一次的挂钩，可重复挂载）→ `configure`（每次推配置）→ `run`（只挂触发器）。`pause` 不卸载，统一摘除 `ctx.on.*` 登记的触发器，在飞流程靠 `ctx.alive()` 自行退出，并给 per-feat `pause(ctx)` 钩子一次自我收尾的机会。
- **注入 `ctx` 这一唯一外部接触面**：`ctx.net/ctx.chat`（ESM 导入，见 §3）、`ctx.game/ctx.bus`、`ctx.alive()`、`ctx.on.push/resp/req/chat/event`（退订自动登记，pause 统一摘除）。
- **门控重算**：`mode.change` / `world.change` 任一翻转 → `recomputeAll()`；`registerGate` 后立即全量重算。

**不管什么**（铁律）：

- **不拥有 feat 自建定时器/引擎实例**：`run()` 里 `new` 出来的东西归 feat，resume 后拿陈旧快照的风险由 spec 声明 `pause` 钩子自收（见 §6）。
- **不解读配置字段含义**：`setConfig` 只透传 `{enabled, ...}` 给 `configure`；字段演化与迁移属 [`registry.js`](registry.js)。
- **不反向依赖 feats**：依赖方向 `feats → core` 不可逆，由 `npm run arch` 强制。

## 2. 设计思路与取舍

- **说明书（spec）而非注册回调**：功能把「我是谁、我要什么游戏符号、怎么起停、面板长啥样」一次性声明，框架据此统一装配、门控、渲染面板、落盘。好处是新增 feat 只需 `register` + 挂菜单 + entry import，无需改 core。
- **门控可扩展、字段默认放行**：`gates` 是 `{id, ok(spec)}` 表，功能未声明的字段（无 kinds/places）默认通过；新增一种门控只 `registerGate` 一次，不改既有功能。
- **`ctx.on.*` 集中托管退订**：feat 不必自己记 `off`，pause 时 `entry.triggers.forEach(unsub)` 一把摘干净——从根上消灭「订阅泄漏」。`req` 订阅特殊：必须经 `net.onReq`（按需拉起发送 hook），直接 `bus.on('net.req.…')` 会订到永不派发的空事件。
- **懒取 → ESM 直取（本轮改造）**：早先 `ctx.net/event` 通过 `window.pocketcc.*` 懒取以规避安装时序，代价是变成 dependency-cruiser 看不见的「影子依赖」。现已改为 `import { netApi/eventApi/chatApi }`，装配期即就绪，`window.pocketcc` 降为纯调试面。

## 3. API 契约

```js
import { reactor } from '../../core/reactor.js';

reactor.register({
  id, label, storageKey, defaults,      // 必填（label/storageKey/defaults 是面板 descriptor 的一部分，缺则拒绝注册）
  fields?, toModuleCfg?,                // 面板字段与配置换算（registry 消费）
  kinds?, places?, symbols?,            // 门控与安装前依赖自检
  install?(ctx) -> boolean|void,        // 返回 false 视为安装失败
  configure?(cfg), run?(ctx), pause?(ctx),
  // 配置字段演化（由 registry 消费，均可缺省）：version? / migrate?(cfg, fromVersion) / strictConfig?
});

reactor.setConfig(id, cfg);             // 面板/registry 推配置：翻 enabled、必要时 install、随后 recompute
reactor.registerGate({ id, ok(spec) }); // 注册一个门控（world/mode 各一），注册即全量重算
reactor.isRunning(id);                  // 调试：某功能是否激活
reactor.list();                         // 已注册 spec 数组（registry/面板据此渲染、收集存储与默认值）
```

**`ctx` 成员**：`net / chat`（ESM 底座，`null` 表示尚未就绪）、`game / bus`、`alive()`、`on.push(cmd,h) / on.resp(cmd,h) / on.req(cmd,h) / on.chat(type,h) / on.event(name,h)`（均返回退订函数并自动登记）。`on.chat` 的 `type` 为 `push|pm|update|del|reconnect`，由 chat 底座直连聊天 socket 并对 socket 实例更替自愈重挂（见 core/chat.js `SOCKET_MAP`）。

## 4. 场景用法

- **推送驱动型**（如联盟集结）：`run(ctx)` 里 `ctx.on.push(12003, h)` 挂订阅，`h` 内先判 `ctx.alive()` 再处理；`on.event` 兜游戏事件面，聊天推送走 `on.chat`。
- **周期调和型**（如 auto-farm）：`run(ctx)` 建 `createCycle({alive: ctx.alive, ...})` 并 `kick()` 点火；`pause(ctx)` 里停 cycle/收引擎。
- **门控下线**：`mode.installModeGate()` 注册 `combat && spec.offInCombat` 门控；`scene-watcher` 把场景信号归一进 `world-state`，`world.change` 驱动 `recomputeAll`。

## 5. 数据流与降级

```
register(spec) ──▶ entries.set(id)（此时不 install、不 run）
setConfig(id,cfg) ─▶ enabled 翻真且未装：missingSymbols 自检 → install(ctx)
                   ─▶ 已装：configure(cfg)
                   ─▶ recompute(entry)：shouldRun(installed&&enabled&&全部门控放行)?
                          ├─ true  ─▶ activate → running=true → spec.run(ctx)
                          └─ false ─▶ pause → running=false → 摘除 triggers → spec.pause(ctx)
mode.change / world.change / registerGate ──▶ recomputeAll()
```

**降级**：`install/configure/run/pause` 任一抛异常都被 try/catch 兜住并 `log.warn`，`entry.installed=false` 或流程照常推进——单个功能异常绝不拖垮中枢。软依赖（`symbols` 名以 `?` 结尾）缺失只记 debug、不阻断安装。

## 6. 坑与边界

- **`run()` 里新建的引擎/定时器必须存模块级引用并声明 `pause`**：触发器摘除管不到 feat 自建的 `setTimeout`/在飞 await；不显式收，resume 后会拿陈旧快照继续发写请求。
- **`req` 只能走 `ctx.on.req`**：内部经 `net.onReq` 按需拉起发送 hook；绕过它 `bus.on('net.req.…')` 是空订阅。
- **pause 后 `alive()` 立即为 false**：在飞 await 回来靠它自然退出；但「已发出的请求收不回」是物理事实，feat 不要假设有事务级回滚。
- **`register` 幂等保护**：重复 id 拒绝并 warn；缺 label/storageKey/defaults 拒绝——开发期 F5 即暴露，不静默。

## 7. 调试面

- `pocketcc.reactor.isRunning('<id>')` 看功能起停；`pocketcc.reactor.list()` 看全部已注册 spec。
- `pocketcc.bus.emit('world.change', …)` 手动翻门控观察 recompute。
- 日志：`activate/pause` 走 info，`install failed/run threw` 走 warn。

## 8. 变更记录

- **2026-10-31（架构审视轮）**：`ctx.net/event` 由 `window.pocketcc.*` 懒取改为 ESM 直取（`netApi/eventApi`），新增 `ctx.chat`（`chatApi`）；`on.req/on.event` 内部同样改走 ESM。配合 `.dependency-cruiser.cjs` 新增 core 内部分层规则与 ESLint `no-restricted-syntax`（禁 feats 摸 `window.pocketcc.*`），把「影子总线」这一腐蚀轴从文档约定升级为可执行闸门。register spec 文档补 `version/migrate/strictConfig` 可选字段（由 registry 消费）。
- **2026-10-31（聊天收信改直连 socket）**：新增 `ctx.on.chat(type,h)`，聊天四类推送不再经 EventCenter，改由 chat 底座直连 `chatpush/chatpushpm/chatupdate/chatdel`（游戏侧为逐字透传，载荷同一引用），并以「包 `connectSocket` + 包 `client._io` 工厂 + 15s 实例身份自检兜底」自愈重挂（工厂包装零延迟捕获 connect_timeout 故障转移建出的新实例，微任务重挂保证我们仍排在游戏之后）；消费方为 chat-window / floatcar / imperial-decree。
