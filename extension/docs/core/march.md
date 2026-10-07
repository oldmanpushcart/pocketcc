# march.js — 行军统一抽象（行为/聚合层）

> 源码：[`src/core/march.js`](../../src/core/march.js)　·　日志 tag：`[POCKETCC://MARCH]`

## 1. 职责与边界

**管什么**：把散在各 feat 里对「本人行军」的零散获取/动作收口到一处——

- 取列表：封装 `856 GET_ALL_MY_MARCH_INFO`（视口无关、Home 亦有全量），归一化为纯数据 `March`——统一入口 `list(opt)`：默认实时打 856，`{cache:true}` 读内存快照（见 §2.2）；
- 名额：读 `UserData.myMarchNum`/`myMarchNumMAX`（经 `game-api.js` 的 `gameData.marchCount()`）给出 `freeSlots()/canMarch(n)`；
- 发/拾/撤/加速：`attack()` 组 902 canonical body（带兵）、`pickUp()` 组 902 零部队 body（`{marchType,x,y}` 三键，或带 `ext` 的九键）、`recall()` 发 904、`speedUp()` 发 920（对一条在途行军用加速道具）；
- 生命周期：全局单点常驻订阅 `net.10019 USER_MARCH_INFO`，做**状态边沿检测**后向 feat 复播（`onStateChange`/`onHomeReturn`）。

**不管什么**（铁律）：

- **marchType 一律外部传入**：不同活动各异（3 普通田 / 26 机械田 / 35 发射井 / 298 战争之源 / 18 联盟机甲 / 180 领域寻宝 / 13 攻玩家城…），且**跨服漂移**（`quick-attack` / `imperial-decree` 的 `marchApi.resolve`）属各 feat 业务。march.js 不解读、不换算、不代理 type 语义，仅把它当 902 body 的一个透传字段。
- **feat 业务状态**：账本 / 黑名单 / 排程 / 乐观返程记账（如 `launch-silo` 的 `pendingRecall`）一律留 feat，march.js 不代管。
- **载荷构造**：`data` 由 `core/battle.js`（`Battle().plan()…build()`）产出，march.js 只搬运其 5 字段，不造兵。参见 [core/battle.md](battle.md)。

**对外契约**：归一化 `March` 是**纯数据**（不持方法/闭包，可自由序列化与单测），动作一律走模块动词：

```js
March = {
  id: string,          // marchId，一律 String()（>2^53 安全，Int64 不丢精度）
  type: number,        // 原始 marchType，仅透传展示，march.js 不解读、不做漂移
  state: number,       // NMarchState 数值（见 State）
  stateName: string,   // 'INIT'|'MARCHING'|'ARRIVED'|'RETURNING'|'ARRIVED_HOME'|'GATHERING'
  isOccupying: boolean,// state ∉ {RETURNING, ARRIVED_HOME}（去程/到达/采集中都算占位）
  target: { x, y, itemId },  // 摊平/嵌套差异已抹平；itemId = 目标地块实体 id
  marchStartTime: number,    // 出发时刻（服务器 epoch 秒；marchInfo.* 优先→摊平顶层；缺省 0）
  marchArrive: number,       // 当前段到达时刻（epoch 秒）；加速(920)后由 10019 边沿更新为更早值
  returnArriveTime: number,  // 返程到家时刻（epoch 秒）；出发段必为 0，回城/返程 push 合并后才有值
  raw: object,         // 原始条目留档
}
```

### ACL 边界

本模块只含**线协议常量**（cmd 号 856/902/904/10019 与 `State` 语义数值）——这些是稳定的服务器契约常量、非游戏 bundle 符号名，故就近定义。**游戏 bundle 符号名**（`march.resolve` 等）仍收口在 [`game-api.js`](../../src/core/game-api.js) 的 SYM/防腐层。

## 2. 设计思路与取舍

### 2.1 纯异步每次打 856（本轮），废 `mapData.marches`

真机探针实证：`mapData.marches`（`NWorldMapData.instance.marches`）在 **Home 场景彻底为空**，只在世界地图视口内才灌满，且受视口裁剪。这是「自动下田重复派遣」的老根因——feat 在 Home 读到空列表 → 占用判定失效 → 往已在田的点再派。

`856 GET_ALL_MY_MARCH_INFO` 请求体 `{}`，应答 `.marches` 是**全量本人行军**，与地图视口/场景无关（游戏自身在 `LOGIN_SUCCESS` 里也发 856 重灌）。故 `list()` 定为唯一取列表权威源，**不再提供任何 `mapData.marches` 直读路径**，根治 Home 读空。

否决的备选：**同步读 `mapData.marches`**——简单但正是被根治的 bug 源；（热路径旁路已并入 `list({cache:true})`，见 §2.2；默认 `list()` 仍实时。）

### 2.2 读列表唯一入口 `list(opt)`：默认实时 856，`{cache:true}` 读快照

`list(opt)` 是对外唯一读入口，用 `opt.cache` 一个开关分两路（外部无需再感知「缓存」是另一个函数）：

- **默认 `list()`**：每次实打 856（权威、视口无关），同 tick 并发去重；失败回 `[]`（调用方「未知不拦」）。写决策类 feat（下田/发射井/领域寻宝/海上夺宝去重）对新鲜度敏感、调用是逐事件/逐周期的有界频率，直接 `await list()`。成功后顺带 **write-through** 喂快照，帮热路径读者把快照焐热。
- **`list({cache:true})`**：读**内存快照**（供热路径 `floatcar`）。**不会每次打 856**——冷启动/超 TTL 时 `await` 一次刷新播种，稳态零网络、由全局常驻 10019 边沿实时 upsert/删除维护，`SNAPSHOT_TTL_MS` 周期兑底重灌清幽灵。不保证强一致（边沿实时更新 + 周期兑底）。失败重试也按 TTL 节流：outage 下至多每 TTL 一条 856，且 `_fetch()` 回 `null`（读不到）时**保留旧快照、不重置 `_lastSync`**，一次抖动不会误清空好数据（与 `storage.js`「读不到 ≠ 空」同源）。

为何不合并成一个纯异步 `list()` 让 floatcar 也走默认？floatcar 是事件堆调度、每拍多处读名额/去重，把权威 856 塞进每拍会放大请求量并给每次决策压一个网络 RTT；`{cache:true}` 让它走「内存 + 边沿 + TTL 兑底」而成本仍 ~1 条 856/TTL。floatcar 自身已是 fire-and-forget 异步事件调度器（handler 全 async），读点无同步顶层调用者，故 `{cache:true}` 返回 Promise 不构成额外改造负担。

### 2.3 生命周期 = 全局单点订阅 10019

各 feat 原本各订各的 `net.10019` + 各自解析 state + 各自魔法数字，重复且易错（`10019` 对**所有**行军状态跃迁都推，须只认 `ARRIVED_HOME` 边沿）。改为 march.js 模块加载即挂**一条常驻** `bus.on('net.10019')`（非 ctx 级、非引用计数），dispatch 里逐条 `decode` → 与上次已知态比对 → **仅在状态边沿迁移时**经内部 emitter 复播。

**代价（已拍板接受）**：全局 hook 常驻，feat 暂停时仍会收到复播 → **回调内必须自判 `alive`**；按 `m.type` 过滤（如 source-of-war 只认 298）、最小间隔节流仍是 feat 策略，march.js 不代管。`onStateChange` 返回 `off`，feat 需在卸载/重挂前调 `off` 防重激活重复注册。

### 2.4 March 纯数据 + 模块动词

否决「March 上挂 `m.recall()`/闭包」的方案：纯数据可自由 `JSON.stringify`、可单测、可跨 worker 搬运；动作收在模块动词（`march.recall(m.id)`）里，state/边沿逻辑只有一处真相。

### 2.5 902 走 `net.send`（旧 JSON 链路）

核对 `net.js` 后纠正：902 世界地图行军走 `net.send`（旧 JSON），**非 `sendPBV2`**。body 为 canonical 11 键（含 `break:0,formation:0`）。

## 3. API 契约

```js
import { march } from './core/march.js';

// ── 读模型（纯） ──
march.State                          // {INIT:0,MARCHING:1,ARRIVED:2,RETURNING:3,ARRIVED_HOME:4,GATHERING:5}
march.NOT_SENT                       // -1，attack/recall 的「未发出」哨兵 code
march.isOccupying(m) → boolean       // m.state ∉ {RETURNING, ARRIVED_HOME}
march.decode(rawEntry) → March|null  // 摊平/嵌套/Int64 统一入口（856、10019 共用）；非法输入回 null

// ── 列表（唯一入口 list(opt)，均异步） ──
await march.list() → March[]              // 默认：每次打 856（权威），同 tick 并发去重，成功后 write-through 喂快照；失败回 []（调用方「未知不拦」）
await march.list({ cache: true }) → March[] // 热路径读快照：冷启动/超 TTL await 一次刷新播种，稳态零网络、10019 边沿实时维护；不保证强一致（对外不再有独立 cached()/refresh()）
await march.byId(id) → March|null         // 打一次 list 后本地筛，同 tick 复用在途 Promise

// ── 名额（同步读 UserData） ──
march.freeSlots() → number           // max - used（数据源缺失回 0）
march.canMarch(n = 1) → boolean      // freeSlots() >= n

// ── 发 / 撤 / 加速（marchType 外部传入；返回 net.Ret，永不 reject） ──
await march.attack({ marchType, target:{x,y}, data }) → Ret  // 组 902 body → isSending(902) 去重 → net.send → catch→Ret(NOT_SENT)
await march.pickUp({ marchType, target:{x,y}, ext? }) → Ret  // 902 零部队：无 ext→三键{marchType,x,y}；有 ext→九键(含空 armyList+ext)。频控门留调用方
await march.recall(marchId) → Ret                            // 904 {marchId}
await march.speedUp(marchId, { advanced?, itemId? }) → Ret    // 920 {marchId,itemId}；缺省普通道具 520001，{advanced:true}→高级 520002，或直接传 {itemId}

// ── 生命周期（全局单点 10019 → 边沿检测 → 内部复播；回调收纯数据 March） ──
march.onStateChange(cb, { to? }) → off   // cb(m:March, prev?:March)；to 指定则只在该 state 边沿触发
march.onHomeReturn(cb) → off             // onStateChange(cb, {to:ARRIVED_HOME}) 糖
```

`attack` 的 `data` 是 `Battle().build()` 的 MarchData（读 `armyListNew/heroList/trapList/formationV2/extraArmy`）。

## 4. 场景用法

**发一条世界地图行军（marchType 由 feat 备好传入）**：

```js
const plan = new Battle().plan().preset(1).adjust().build();
if (!plan.armyListNew.length) return;              // 空兵不派
const ret = await march.attack({ marchType: 298, target: { x, y }, data: plan });
if (ret.ok) { /* 记账 */ }
```

**跨服漂移（quick-attack / imperial-decree）**：marchType 先在 feat 内换算再传入，march.js 不介入：

```js
import { march as marchApi } from './core/game-api.js';   // 漂移 resolver（异名，勿与 core/march 冲突）
const marchType = marchApi.resolve(base, MARCH_FALLBACK); // feat 自理漂移
await march.attack({ marchType, target, data });
```

**回城唤醒（补派节拍）**：

```js
let off = march.onHomeReturn((m) => {
  if (!aliveFn()) return;          // 硬约束：回调自判 alive
  if (m.type !== 298) return;      // feat 自持：按本玩法 marchType 过滤
  // feat 自持节流 + 触发下一轮
});
// 重激活/卸载路径先 off()，防重复注册
```

**名额闸门**：`if (!march.canMarch()) return;`；多槽判断用 `march.freeSlots() >= need`。

**在途行军计数（活动名额判据，如领域寻宝）**：

```js
const marches = await march.list();                 // 856 全量本人行军
const inFlight = marches.filter(m => m.type === 180).length;
```

## 5. 数据流与降级

```
feat ──await──▶ march.list() ──▶ net.send(856,{}) ──▶ parseData(ret.data)
                                                        │  d.marches || d.ret（数组）
                                                        ▼
                                                  逐条 decode → March[]
异常/符号缺/net 未装/结构不符 ──▶ 回 []（调用方「未知不拦」）

feat ──await──▶ march.attack({marchType,target,data}) ──▶ 组 canonical body
                                                        │  net 缺失 → fallbackRet{ok:false,code:-1}
                                                        │  net.isSending(902) → notSentRet
                                                        ▼
                                                  net.send(902,body) ──catch──▶ notSentRet

net.10019 推送 ──▶ bus('net.10019') ──▶ _onPush: decode → 与 _known 比对
                                       │  state 边沿迁移 → 遍历 _stateSubs（按 to 过滤）复播 cb(m,prev)
                                       └  m.state===ARRIVED_HOME → _known.delete(id)（防内存涨）
```

- `decode`：state 优先 `marchInfo.state` → 摊平 `marchState` → `state`；target.x/y 优先摊平 `target_tx/ty` → 嵌套 `marchInfo.target.tx/ty` → `entry.target.tx/ty`（修历史「`march.target` 恒 undefined」坑）；itemId 同理。永不抛异常。
- `State` 为本地权威副本（真机符号漂移时不至全线瘫痪）。
- `freeSlots()` 数据源（`gameData.marchCount()`）缺失回 `{0,0}` → `canMarch()` 恒 false，写决策类 feat 据此保守不派。

## 6. 坑与边界

- **`mapData.marches` 在 Home 空**：正是要根治的对象，任何 feat 不得再直读它取本人行军。
- **摊平 vs 嵌套两种条目形状**：856 / 10019 是 `marchInfo.*` 嵌套，mapData.marches 是摊平；`decode` 已统一，但**不要绕过 decode 直接读 `raw` 的某一条路径**。
- **Int64 精度**：`marchId` 是 `String()`，>2^53 安全；比对/记账用字符串，勿 `Number()` 化。
- **10019 需按 type 过滤**：推送对所有行军、所有状态跃迁都发；唤醒补派必须①只认 `ARRIVED_HOME` 边沿、②按 `m.type` 锁本玩法，否则会在他种行军出发/到达时空跑。
- **全局单点常驻**：feat 暂停仍收复播 → 回调内自判 `alive` 是硬约束；`off()` 需在重挂路径先调，防重复注册。
- **集结 ≠ 902**：`alliance-rally` 派最小部队走的是 1204 `ALLIANCE_Assembly`，**不套 `march.attack()`**，只借用 `march.canMarch()` 闸门；`truck-intercept` 只用 `Battle` 造载荷、不碰列表/生命周期，不迁移。
- **热路径读用 `list({cache:true})`、别塞默认 `list()`**：`{cache:true}` 稳态零网络（10019 边沿 + TTL 兑底）；把权威 `await list()`（856）放进每拍紧循环会放大请求量并给决策压网络 RTT。`floatcar` 名额账/去重即走 `list({cache:true})`；其 `nextReleaseAt` 腾位打点改读归一化 `March.returnArriveTime/marchArrive`（仅取未来时刻，两者都不可用或已成过去才回退轮询）。
- **speedUp 已实装（920）**：真机报文实证（dashcam 20261005T204748）req `{marchId:str, itemId:number}`→resp `{s:0,d:"{}"}`（成功空载荷）；`itemId` 520001=普通、520002=高级（均为全账号稳定内容 id，就近定义于 march.js）。道具削减比（对「当时剩余时间」生效，报文实测同一行军先普通后高级）：**普通缩短 25%（剩 75%）、高级缩短 50%（剩 50%）**；调用方按「加速到剩余 ≤ N 秒」反推该用哪支。
- **加速后的新到达走 10019 边沿（state 不变）**：920 受理成功后，服务器推一条 `10019`（state 仍 `MARCHING`）带更新后的 `marchInfo.marchArrive`（更早）。`decode` 已把 `marchStartTime/marchArrive/returnArriveTime` 归一化为 `March` 字段，`_cacheApply` 采用新到达（仅当新值解为 0=增量推送未带时刻才回退保留旧值，绝不把加速后的更早到达又冲掉）。因 state 未迁移，**不触发 `onStateChange` 复播**（加速非生命周期跃迁）；依赖到达的 feat（如 floatcar 腾位打点 `nextReleaseTime`）改读归一化 `March.marchArrive/returnArriveTime`，不再摸 `raw.marchArrive`（`raw` 是 `{marchInfo:...}` 嵌套，顶层无该字段，旧读法恒 undefined）。
- **pickUp 两种 body 勿合并**：三键（海上夺宝/花车）与九键含 `ext`（领域寻宝挖矿/泰坦祝福）是各自真机录制口径，服务器都受理但保持逐键一致最稳；由是否传 `ext` 切换。
- **缓存快照已并入 `list({cache:true})`（已完成）**：后端仍是 856 播种 + 10019 边沿 upsert/删除 + TTL 兑底刷新，但对外只剩 `list(opt)` 一个入口（`cached()/refresh()` 收为私有）。默认 `list()` 实时且 write-through 喂快照。快照不做跨登录/切号显式复位——靠 TTL 全量重播自然纠偏。

## 7. 调试面

- 日志 tag：`[POCKETCC://MARCH]`（856 发送失败 debug、902/904 发送异常 warn、listener 抛错 warn）。
- 控制台直接戳：`window.pocketcc` 下经 feat 触发；或临时 `import { march } …` 后 `await march.list()` 看归一化结果、`march.freeSlots()` 看名额、`march.State` 看枚举。
- 排查「列表读空」：确认走的是 `march.list()`（856）而非残留的 `mapData.marches`；grep 校验残留见变更记录。

## 8. 变更记录

- **2026-10-07（加速 push 归一化 + floatcar 行军加速）**：`decode` 新增归一化 `marchStartTime/marchArrive/returnArriveTime`（服务器 epoch 秒，`marchInfo.*` 优先→摊平顶层），供 feat 直接算剩余时间/腾位打点，无需再摸 `raw`（旧 floatcar `nextReleaseAt` 读 `raw.marchArrive` 恒 undefined、静默退化轮询）；`_cacheApply` 对时刻做「新值 >0 才采用、否则保留旧值」的防御合并，确保 920 加速后的 10019 边沿（state 不变）把更早到达并进快照。`speedUp` 文档补充削减比（普通 25%/高级 50%）与「加速后到达经 10019 更新、不触发 onStateChange」的口径。floatcar 新增面板字段 `accelTargetSec`（加速至剩余≤N 秒，0=不加速）：拾取 902 受理后按当前去程到达点判一次，决策前先 `item.amount` 核对背包数量，普通能达标优先普通、否则高级，缺货回退另一支。

- **2026-10-05（读入口合并 + 快照加固）**：把 `cached()/refresh()` 合并进唯一入口 `list(opt)`——`list({cache:true})` 读快照（冷启动 await 播种），默认 `list()` 实时并 write-through；`cached/refresh` 从导出退为私有。加固：`_fetch()` 区分「读不到(null) vs 确认 0 条([])」，`_seed` 仅在成功时替换快照、outage 保留旧快照不重置 `_lastSync`、并按 TTL 节流失败重试（避免一次 856 抖动误清空）。floatcar 因是 fire-and-forget 异步事件调度器，读链 8 个私有函数（`listMarches/hasMarchAtTarget/myActiveMarches/freeSlots/nextReleaseAt/scheduleSlotFree/requestPickup/logQueueFullEvidence`）改为 async 并 `await march.list({cache:true})`。

- **2026-10-05（行军全量归一收尾）**：新增 `pickUp()`（902 零部队统一动词，`ext` 切换三键/九键）与 `cached()/refresh()`（同步快照：856 播种 + 10019 边沿 upsert/删除 + TTL 兑底）。将剩余 4 处直读 `mapData.marches`/直发 902 的 feat 收口：`sea-treasure`（`marchAttack`→`pickUp` 三键、`hasMarchAtTarget`→`await list()`、去 NWorldMapData/DataCenter）、`titan-blessing`（`marchPickUp`→`pickUp` 九键）、`domain-treasure`（`digging…Mine`→`pickUp` 九键，isSending 门留 feat）、`floatcar`（`marchPickUp`→`pickUp` 三键；名额账 `freeSlots`/`myActiveMarches`/`hasMarchAtTarget`/`logQueueFullEvidence` 全改走 `cached()` 归一化字段、废 `isMyMarch`、去 NWorldMapData）。至此无 feat 再直发 902/904/856 或直读 `mapData.marches`。

- **2026-10-05**：`speedUp()` 由接口缝→实装。据 dashcam 报文（20261005T204748）确认 920 `MARCH_SPEED_UP` req `{marchId,itemId}`、resp 成功空载荷；新增线协议常量 `CMD_MARCH_SPEED_UP=920` 与加速道具 `ITEM_SPEED_UP_NORMAL=520001`/`ITEM_SPEED_UP_ADVANCED=520002`，同批报文印证 904 召回 `{marchId}`、 856 `{}` 与 decode 嵌套口径。

- **2026-10**：新建 `core/march.js`。归一化 `March` + 列表（纯异步 856）+ 名额（`freeSlots/canMarch`）+ 发/撤（`attack/recall`，902 走 `net.send`）+ 生命周期（全局单点 10019 边沿复播，`onStateChange/onHomeReturn`）。全量迁移 8 个 feat：`auto-farm`（856/10019/多槽 free/902 下田）、`launch-silo`（`mapData.marches`→`list()`、904→`recall`、返程→`onHomeReturn`、名额→`canMarch`）、`source-of-war/attack`（10019/名额/902）、`alliance-boss`（`canMarch/sendMarch`）、`quick-attack`+`imperial-decree`（发送骨架→`attack`，跨服漂移留 feat）、`domain-treasure`（在途计数→`list()`）、`alliance-rally`（仅 `canMarch` 闸门，1204 集结发包不动）。`speedUp` 仅留接口缝；缓存快照拆为独立后续。
