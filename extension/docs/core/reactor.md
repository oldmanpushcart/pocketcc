# reactor.js — 功能调度中枢（说明书驱动的装配与门控）

> 源码：[`src/core/reactor.js`](../../src/core/reactor.js)　·　日志 tag：`[POCKETCC://REACTOR]`

## 1. 职责与边界

**一句话**：一个功能的全部声明都交给 `register(spec)`；运行期只由两个变量决定起停——面板 `enabled`（registry 推 `setConfig`）与门控 `gates`（world/mode）。

**管什么**：

- **生命周期三段**：`install`（只做一次的挂钩，可重复挂载）→ `configure`（每次推配置）→ `run`（只挂触发器）。`pause` 不卸载，统一摘除 `ctx.on.*` 登记的触发器、abort `ctx.signal` 并清掉托管定时器，在飞流程靠 `ctx.alive()` 自行退出，并给 per-feat `pause(ctx)` 钩子一次自我收尾的机会。
- **注入 `ctx` 这一唯一外部接触面**（`core/feat-ctx.js` `createCtx(entry, deps)` 工厂装配，deps 全注入）：`ctx.net/ctx.chat`（ESM 底座，见 §3）、`ctx.alive()`、`ctx.signal` 与托管定时器 `ctx.setTimeout/setInterval/clearTimeout/clearInterval`、`ctx.on.push/resp/req/chat/event`（退订自动登记，pause 统一摘除）。游戏符号不在 ctx 上：feat 经 ESM 直取 `core/game.js`（窄化纪律，见 §2）。
- **门控重算**：`mode.change` / `world.change` 任一翻转 → `recomputeAll()`；`registerGate` 后立即全量重算。

**不管什么**（铁律）：

- **不拥有 feat 自建引擎实例与绕过 ctx 的裸定时器**：`run()` 里 `new` 出来的东西归 feat，裸 `setTimeout`/在飞循环不受托管，resume 后拿陈旧快照的风险由 spec 声明 `pause` 钩子自收（见 §6）。生命周期类定时器应优先走 `ctx.setTimeout/setInterval` 托管（pause 自动清）。
- **不解读配置字段含义**：`setConfig` 只透传 `{enabled, ...}` 给 `configure`；字段演化与迁移属 [`registry.js`](../../src/core/registry.js)。
- **不反向依赖 feats**：依赖方向 `feats → core` 不可逆，由 `npm run arch` 强制。

## 2. 设计思路与取舍

- **说明书（spec）而非注册回调**：功能把「我是谁、我要什么游戏符号、怎么起停、面板长啥样」一次性声明，框架据此统一装配、门控、渲染面板、落盘。好处是新增 feat 只需 `register` + 挂菜单 + entry import，无需改 core。
- **门控可扩展、字段默认放行**：`gates` 是 `{id, ok(spec)}` 表，功能未声明的字段（无 kinds/places）默认通过；新增一种门控只 `registerGate` 一次，不改既有功能。
- **`ctx.on.*` 集中托管退订**：feat 不必自己记 `off`，pause 时 `entry.triggers.forEach(unsub)` 一把摘干净——从根上消灭「订阅泄漏」。`req` 订阅特殊：必须经 `net.onReq`（按需拉起发送 hook），直接 `bus.on('net.req.…')` 会订到永不派发的空事件。
- **取消语义（signal + 托管定时器）**：每次 activate 新建 `AbortController`，pause 主动 abort 并按 kind 清掉全部托管定时器，再摘触发器、最后跑 per-feat pause 钩子。`sleep(ms, ctx.signal)` abort 时**早 resolve 不 reject**——在飞流程保持「await 回来判 alive()」习语，零新增 catch 路径。已 abort 的 controller 保留到下次 activate 整体替换（在飞流程仍可读 `signal.aborted`）；signal 每次 run 内现读，不跨 pause 缓存。托管是 opt-in 而非强制：cycle/drain/createWaker 薄契约不动（已有 alive 闸门自然停摆），引擎/裸定时器仍归 feat 自收。
- **懒取 → ESM 直取（本轮改造）**：早先 `ctx.net/event` 通过 `window.pocketcc.*` 懒取以规避安装时序，代价是变成 dependency-cruiser 看不见的「影子依赖」。现已改为 `import { netApi/eventApi/chatApi }`，装配期即就绪，`window.pocketcc` 降为纯调试面。
- **ctx 工厂 + 窄化（P4）**：`makeCtx` 下沉 `core/feat-ctx.js` 的 `createCtx(entry, deps)`——log/bus/net()/chat()/event() 全注入（三个底座是 export let 活绑定，getter 读时现取保持懒取语义），工厂零 import，单测用假 deps 直驱装配契约（`tests/core/feat-ctx.test.js`）。同时按盘点窄化接触面：`ctx.bus` 零消费者删；`ctx.game` 唯一消费者 global-map 改 ESM 直取后删——ctx 收敛为「生命周期 + 订阅 + 底座」三件套，游戏符号访问一律走 ESM import（与上条影子依赖收口同方向）。薄契约闸门 `schedule-primitives-thin` 扩名 feat-ctx。

## 3. API 契约

```js
import { reactor } from '../../core/reactor.js';

reactor.register({
  id, label, storageKey, defaults,      // 必填（label/storageKey/defaults 是面板 descriptor 的一部分，缺则拒绝注册）
  fields?, toModuleCfg?,                // 面板字段与配置换算（registry 消费）
  kinds?, places?, symbols?,            // 门控与安装前依赖自检
  available?() -> boolean|{ok,reason},  // feat 自有可用性闸（活动未开等）：纯视觉置灰提示，不禁用启用/参数，不参与启停
  install?(ctx) -> boolean|void,        // 返回 false 视为安装失败
  configure?(cfg), run?(ctx), pause?(ctx),
  // 配置字段演化（由 registry 消费，均可缺省）：version? / migrate?(cfg, fromVersion) / strictConfig?
});

reactor.setConfig(id, cfg);             // 面板/registry 推配置：翻 enabled、必要时 install、随后 recompute
reactor.registerGate({ id, ok(spec) }); // 注册一个门控（world/mode 各一），注册即全量重算
reactor.isRunning(id);                  // 调试：某功能是否激活
reactor.list();                         // 已注册 spec 数组（registry/面板据此渲染、收集存储与默认值）
```

**`ctx` 成员**：`net / chat`（ESM 底座，`null` 表示尚未就绪）、`alive()`、`signal`（本次激活的 AbortSignal，首次激活前 null；pause 后 aborted，resume 全新）、`setTimeout(fn,ms) / setInterval(fn,ms)`（托管：pause 自动清、timeout fire 自移除、非激活态 no-op 返 -1）、`clearTimeout(id) / clearInterval(id)`（未知 id 静默 no-op，feat 的 stop 函数无需关心框架是否已代清）、`on.push(cmd,h) / on.resp(cmd,h) / on.req(cmd,h) / on.chat(type,h) / on.event(name,h)`（均返回退订函数并自动登记）。`on.chat` 的 `type` 为 `push|pm|update|del|reconnect`，由 chat 底座直连聊天 socket 并对 socket 实例更替自愈重挂（见 core/chat.js `SOCKET_MAP`）。配套：`util.sleep(ms, signal?)` 传 `ctx.signal` 可被 pause 早醒（早 resolve 不 reject）。

## 4. 场景用法

- **推送驱动型**（如联盟集结）：`run(ctx)` 里 `ctx.on.push(12003, h)` 挂订阅，`h` 内先判 `ctx.alive()` 再处理；错峰/去抖延迟用 `ctx.setTimeout`（pause 自动清）；`on.event` 兜游戏事件面，聊天推送走 `on.chat`。
- **周期调和型**（如 auto-farm）：`run(ctx)` 建 `createCycle({alive: ctx.alive, ...})` 并 `kick()` 点火；轮内休眠用 `sleep(ms, ctx.signal)` 早醒；`pause(ctx)` 里收引擎/非 ctx 级句柄。
- **可见性驱动型**（如全局地图）：轮询 interval 用 `ctx.setInterval` 托管兜底，start/stop 仍由可见性回调驱动；spec 声明 `pause` 钩子复位模块句柄（否则幂等守卫拿陈旧句柄挡住 resume 重启）。
- **门控下线**：`mode.installModeGate()` 注册 `combat && spec.offInCombat` 门控；`scene-watcher` 把场景信号归一进 `world-state`，`world.change` 驱动 `recomputeAll`。

## 5. 数据流与降级

```
register(spec) ──▶ entries.set(id)（此时不 install、不 run）
setConfig(id,cfg) ─▶ enabled 翻真且未装：missingSymbols 自检 → install(ctx)
                   ─▶ 已装：configure(cfg)
                   ─▶ recompute(entry)：shouldRun(installed&&enabled&&全部门控放行)?
                          ├─ true  ─▶ activate → running=true → 新建 AbortController → spec.run(ctx)
                          └─ false ─▶ pause → running=false → abort(signal) → 清托管定时器 → 摘除 triggers → spec.pause(ctx)
mode.change / world.change / registerGate ──▶ recomputeAll()
```

**降级**：`install/configure/run/pause` 任一抛异常都被 try/catch 兜住并 `log.warn`，`entry.installed=false` 或流程照常推进——单个功能异常绝不拖垮中枢。软依赖（`symbols` 名以 `?` 结尾）缺失只记 debug、不阻断安装。

## 6. 坑与边界

- **生命周期定时器优先 `ctx.setTimeout/setInterval` 托管**：pause 自动清，不留空转 timer。绕过 ctx 的裸 `setTimeout`/在飞 await 循环/`new` 出的引擎仍归 feat：必须存模块级引用并声明 `pause`，否则 resume 后会拿陈旧快照继续发写请求。在飞休眠用 `sleep(ms, ctx.signal)` 早醒，醒来仍须判 `alive()`。
- **托管 Promise 等待必须带 abort 收口路径**：只把 timer 托管清掉而 Promise 不 resolve，会永挂卡死 cycle 单飞（实证口径：auto-hunt 难民营等待的 abort 监听走超时同构路径回 null）。一次性自清 latch 守卫（如 daily-state 看门狗）刻意不托管：pause 清掉它反而可能让 latch 悬跨暂停卡死。
- **signal 不跨 pause 缓存**：每次 activate 是全新 AbortController，run/await 回来现读 `ctx.signal`；缓存旧信号会在 resume 后拿到已 aborted 的死信号。
- **`req` 只能走 `ctx.on.req`**：内部经 `net.onReq` 按需拉起发送 hook；绕过它 `bus.on('net.req.…')` 是空订阅。
- **pause 后 `alive()` 立即为 false**：在飞 await 回来靠它自然退出；但「已发出的请求收不回」是物理事实，feat 不要假设有事务级回滚。
- **`register` 幂等保护**：重复 id 拒绝并 warn；缺 label/storageKey/defaults 拒绝——开发期 F5 即暴露，不静默。

## 7. 调试面

- `pocketcc.reactor.isRunning('<id>')` 看功能起停；`pocketcc.reactor.list()` 看全部已注册 spec。
- `pocketcc.bus.emit('world.change', …)` 手动翻门控观察 recompute。
- 日志：`activate/pause` 走 info，`install failed/run threw` 走 warn。

## 8. 变更记录

- **2026-11-14（P4 ctx 工厂 + registry dispatch 收一份，架构审查候选 3/4 同刀）**：`makeCtx` 下沉 `core/feat-ctx.js` `createCtx(entry, deps)` 工厂（deps 全注入、零 import、单测可直驱）；接触面按盘点窄化——`ctx.bus` 零消费者删、`ctx.game` 唯一消费者 global-map 改 ESM 直取 `core/game.js` 后删。registry 三份 internal-vs-reactor dispatch 分叉（applyFeature/startFeatures/reloadForPlayer 内联复制）收进 applyFeature 单一路径：start 保留「只推启用」启动策略过滤、reload 保留全量重推纠偏，零行为变化。新增契约：tests/core/feat-ctx.test.js（8 例：窄化面/五口订阅登记与降级/底座懒取/alive-signal 现读/托管定时器形状）+ tests/core/registry.test.js（5 例：启动顺序与策略/热更单 feat/internal apply/降级补载纠偏/toModuleCfg 缺声明降级，假 storage bridge 驱动读盘）。`schedule-primitives-thin` 闸门扩名 feat-ctx。

- **2026-11-14（取消语义收尾刀，①遗留项闭环）**：推广刀四类边界逐点处置。① 注入式子模块接 signal：宿主 auto-farm 的 install 注入面增 `signal` 取值器（闭包读 ctxRef.signal，每次 activate 现取新信号），lvl6-scanner（窗间/探针 2 处）与 mech-build（取消间隔 2 处）sleep 接线；cq26 shop 本就收 ctx，持 ctxRef 后抢购间隔 sleep 接线。quick-jump 判定不接：用户触发的批量分享自带 shareAbort，非 feat 生命周期。② secret-realm 发包守卫 abort 收口：api.js sendSecret/sendSecretJson 增可选 signal 参（abort 即回哨兵/null，与超时同口径，收口后移除监听）；index.js buildEnv 的 env.secret 薄包装自动注入当前信号，引擎侧 18 处调用点零改动。③ 引擎类定时器维持自持纪律（stop/clear 已齐），仅补 shop 引擎首扫延迟的句柄缺口（#firstKickTimer，stop 自收）。④ UI 局部定时器核查：jump/map 两步确认 disarm、chat 冷却/toast、channels 队列泵均已有收口；唯一真缺口 chat-overlay resize 监听不摘（mount/unmount 循环累积 + 闭包钉旧实例）已修：存 #onResize/#clearResizeTimer 句柄，unmount 摘监听清防抖。另：过时 window.pocketcc 注释清理 11 处（api.js/heal.js 的 ACL 懒取描述与 render.js 调试面描述属实保留）；chat 未读角标 #e0463b→#d63c33（白字对比度 4.11→4.61:1，OKLCH 降明度保色相）。

- **2026-11-14（取消语义推广，线2 ①推广刀）**：存量生命周期定时器/sleep 逐点分诊后批量接线，判据沿用试点三分法。托管迁移：floatcar（driverTimer + 补 pause 钩子复位句柄）、alliance-gift/alliance-help（单定时器武装器，先 clear 再 set 口径陈旧句柄自替换，无需 pause 钩子）、auto-farm/fear-star-rally 的 1500ms 回城唤醒。sleep 传 signal（循环头/睡后均有 alive 闸门，早醒不多发包）：domain-treasure/launch-silo/mecha-treasure/sea-treasure/titan-blessing/auto-defense/quick-repair/radar-task（删本地 sleepMs 改用 util.sleep）/alliance-behemoth/alliance-boss/alliance-gift/alliance-science/relic-reward/quick-attack/ad-diamond/auto-farm/beast-breed/city-skill/secret-weapon-drop/truck-intercept；floatcar/titan-blessing/auto-defense 的轮询等待裸 Promise 延时同改 sleep(ms, signal)。刻意不托管新增一处：player-like daily-state 看门狗（同 latch 判据，就地注释）。引擎类私有定时器（secret-realm pickup/shop、mine-cave、source-of-war）自带 stop/clear 纪律归引擎自持；发包超时守卫（secret-realm api.js）托管需 abort 收口路径否则 Promise 永挂，维持裸；UI 局部定时器（chat/jump/map 浮层）属组件生命周期不属本刀；注入式 alive 的子模块（lvl6-scanner/mech-build/quick-jump/cq26 shop）无 ctx 持有，待接口演进另刀。

- **2026-11-13（取消语义补全，线2 第①刀）**：Entry 增 `controller`（每次 activate 新建 AbortController）与 `timers` 托管表；ctx 新增 `signal` getter 与 `setTimeout/setInterval/clearTimeout/clearInterval` 托管定时器（非激活态 no-op 返 -1、timeout fire 自移除、clear 未知 id 静默 no-op）；pause 顺序改为 running=false → abort → 清托管定时器 → 摘 triggers → spec.pause。`util.sleep(ms, signal?)` 支持 abort 早 resolve（绝不 reject，零新增 catch 路径）。试点迁移：global-map（两个可见性 interval 托管 + 补 pause 钩子复位句柄）、auto-hunt（marchInterval sleep 传 signal、难民营等待托管 + abort 收口、1500ms 唤醒托管）、alliance-rally（scheduleJoin 托管）；两处 daily-state 看门狗刻意不托管（latch 守卫边界）。cycle/drain/createWaker 薄契约不动。契约单测：tests/core/reactor.test.js + util.test.js sleep 用例。
- **2026-10-31（架构审视轮）**：`ctx.net/event` 由 `window.pocketcc.*` 懒取改为 ESM 直取（`netApi/eventApi`），新增 `ctx.chat`（`chatApi`）；`on.req/on.event` 内部同样改走 ESM。配合 `.dependency-cruiser.cjs` 新增 core 内部分层规则与 ESLint `no-restricted-syntax`（禁 feats 摸 `window.pocketcc.*`），把「影子总线」这一腐蚀轴从文档约定升级为可执行闸门。register spec 文档补 `version/migrate/strictConfig` 可选字段（由 registry 消费）。
- **2026-10-31（聊天收信改直连 socket）**：新增 `ctx.on.chat(type,h)`，聊天四类推送不再经 EventCenter，改由 chat 底座直连 `chatpush/chatpushpm/chatupdate/chatdel`（游戏侧为逐字透传，载荷同一引用），并以「包 `connectSocket` + 包 `client._io` 工厂 + 15s 实例身份自检兜底」自愈重挂（工厂包装零延迟捕获 connect_timeout 故障转移建出的新实例，微任务重挂保证我们仍排在游戏之后）；消费方为 chat-window / floatcar / imperial-decree。
