# feat · 荒芜冰原采集（`cq26WlGather`，一个 feat 三腿：采集 / 协助 / 盗采）

> **已重构为 wl-mine（`cq26WlMine`「荒芜冰原矿区」）**：本文作为历史设计参考保留，代码已改名 `feats/cq26/wl-mine/`，面板不再有三腿开关，采集腿新增 920 去程加速与矿种白名单，盗采/协助各自拆分矿种白名单与 `oNum` 门槛，`reserveSec`/`recallOnMature`/`speedUp` 与 `legs.*` 全部废弃，扫描频率 `scanIntervalSec` 上面板。旧配置迁移见 `wl-mine/index.js` 内的 `version: 2` + `migrate()` 钩子。
> 状态：**设计定稿，未实现**。协议/判据的真相源是 [`acl-cq26-荒芜冰原.md`](acl-cq26-荒芜冰原.md)（下称 ACL），本文只写"怎么组织与怎么决策"，凡引用一律给 §号，不重复抄字段表。
> 代码落点：`extension/src/feats/cq26/wl-gather/`（新目录）+ `core/acl/game-data.js` 新增 §5 的投影（ACL 侧先落，feat 才能开工）。
> 装配三处：`core/menu.js` 的 `cq26` 分组加 `{ id:'cq26WlGather', kind:'feature', label:'荒芜冰原采集', showFields:true }`、`content.entry.js` 追加 import、`scripts/verify-manifests/cq26-wl-gather.mjs`（§10）。
> 实证来源：印石日常真人实录（2026-11-08 主跑趟，真人完成 2 次 2115 盗采 + 2 次 2116 协助 + 3 次 2114 采集，含 8 份 2201 全图快照）；普查脚本清单见 ACL §8。

一句话：**三腿共用同一张候选池与同一次精筛，只在"选点谓词 + 写动作 + 额度口径"处分叉**；两条即时腿（协助/盗采）是配额驱动的突发轮，一条行军腿（采集）是常驻轮，两者节奏差异大到不能共享一个循环，但小到一个 feat 外壳装得下。

---

## 0. 范围与用法（先看这节）

| 腿 | 目标点 | 写动作 | 派兵 | 日额度 | 结算 |
| --- | --- | --- | --- | --- | --- |
| **采集** gather | `initSid === OriginServerId` 且 `ownerId` 为空 | `2114 {wastelandIndex,x,y}`（`wastelandIndex` 传点的 `specIndex`，ACL §3.1/§4.4） | **是**，占 `MarchType 315` 名额 | `todayCanGatherTime` 57600s（16h） | 行军回程 + 10264 采集报告邮件 |
| **协助** help | `initSid === OriginServerId` 且 `ownerId` 为他人 | `2116 {wkid,x,y}`（`wkid` 传点的 `k`） | 否 | `remainHelpNum` 2 次 | **即时**：resp `rewardResult` + 同秒 10001 |
| **盗采** steal | `initSid !== OriginServerId` 且已在采且成熟 | `2115 {wkid,x,y}` | 否 | `remainStealNum` 3 次 | **即时**：同上，且精确扣 owner 的 `gNum` |

三条都打开时的执行序：**先即时腿（短平快、只 5 次）、后行军腿（长驻）**，同一拍内不并发（§5 单飞闸门）。任一腿可单独关闭；全关即引擎 idle、零发包。

不做（§12 有完整清单）：遗失之箱（2118，独立 feat `wl-chest`）、冰原巨兽（2125，`wl-beast`）、融冰/点火（2117/2129）、type5 `HELP_BOSS` 援助地块与 `beastStatus`（ACL §4.6：客户端零消费）、`2113` 开分区（要电力与联盟权限）、WLB 冰原会战（2131~2139）。

---

## 1. 组织决策：为什么是一个 feat 三腿，而不是三个 feat

**结论：一个 feat（`cq26WlGather`）内三个引擎 + 一个共享扫描层。** 依据三条硬事实：

1. **候选池同源**。三腿的输入都是「2201 粗筛 → 2120 锚点 → 901 精筛」这一条链（ACL §2.5），差别只在最后一步用哪个谓词筛选、发哪个 cmd。拆成三个 feat 会把同一次扫描做三遍 —— 901 是全网最大宗的只读请求，重复扫描既贵又扰服务器。
2. **额度互斥于同一片点**。`stealUidList.length + protectUidList.length >= conf(52000364)` 是**单点共享**的上限（ACL §4.4 第 3/4 闸），协助与盗采在同一点上是零和的；不放在一起决策就会出现"两个 feat 抢同一个点，第二个必撞拒绝码"。
3. **节奏不同但共享唤醒源**。三腿都靠 `22071/22072` 与 `10018` 收敛，事件订阅（`ctx.on.push`）只需登记一份。

**先例**：[`feats/player/mine-cave/`](../src/feats/player/mine-cave/index.js) 就是这个形状 —— 一个 feat、`mining.js`/`steal-pack.js` 两个引擎、`index.js` 只做「装配 + env 注入 + rules 分发 + 生命周期」，注释原话「两者刷新预算与节奏不同，故各有独立队列/drain/定时器」。本 feat 沿用同一范式，多出来的是一个**共享层 `survey.js`**（mine-cave 的目标来自联盟列表，不需要扫图，所以没有这一层）。

被否决的备选：

| 备选 | 否决理由 |
| --- | --- |
| 三个独立 feat（`wl-gather`/`wl-help`/`wl-steal`） | feat 之间不得互相 import（分层闸门），共享扫描只能下沉 `core/` —— 而「该发几次 901、取哪个点」是玩法决策，`core/` 的红线明确不收（skill「分层闸门」条：薄底座只收口真相/查询，不聚合玩法动词）。结果必然是三份重复扫图或一次违规下沉。 |
| 三腿共用一个 `createCycle` | 行军腿要 7×24 常驻盯着 `marchArrive`/成熟时刻，即时腿只在配额未满时突发扫；合成一个循环会让"抢额度"这件事被 16h 采集的长睡期挡住（`run()` 返回 delay 只有一个）。 |
| 用 `2127 ROOM_INFO` 逐房间建映射 | 一房间一查（本场真人 18 次）且只给分区级字段，没有 `gNum`/名单 ⇒ 定不了目标点。ACL §2.3 已作废此路径。 |
| 靠 `2122 NWL_COLLECT_WKID_LIST` 一次拿全在采点 | 客户端**零调用点**、报文零样本，字段形态全靠猜。列为 §11 的独立验证实验（真能省掉整个 L1+L2），**不进 v1**。 |
| 把 2201 应答喂进 ACL 做「全图 region 列表」投影 | ACL §5 第四条：应答载荷全是协议字段，聚合投影会把扫描成本决策抬进 ACL。ACL 只给 `group`/`cid`/`OriginServerId`/配置号。 |

---

## 2. 文件与运行时结构

```
feats/cq26/wl-gather/
  index.js        reactor.register + spec + 面板 descriptor + env 注入 + 两循环装配（唯一有 register 的文件）
  survey.js       共享扫描层（无循环）：L0 粗筛(2201) → L1 锚点(2120) → L2 精筛(901) → Candidate[]，带 TTL / 单飞 / 预算
  legs.js         三腿谓词（逐字镜像 ACL §4.4）+ 打分排序 + 配额分配（纯函数，可单测）
  act.js          写动作管线：2114 / 2115 / 2116 / 2121 / 2123 的发送、Ret 归类、当日拉黑、在途串行
  march-loop.js   行军腿引擎：本人 315 行军的发现/成熟/召回/加速状态机
  constants.js    协议号（2114/2115/2116/2120/2121/2123/2201/2111/2112）、push 号（22071/22072/22074/22001/10018/10001）、
                  线上数值（CQ26WLLandType.GATHER=3、CQ26WLLandStatus.OPENING=4/OPENED=5、pointType 316、marchType 315）、
                  配置号（52000363/364/367）
```

**边界纪律**（照 skill 的依赖方向）：`legs.js` / `constants.js` 不 import 任何游戏符号；游戏符号一律经 `gameData.cq26*()`（ACL §5）。`survey.js` 是**唯一**发只读请求（2201/2120/2112/901）的模块，`act.js` 是**唯一**发写请求（2114/2115/2116/2121/2123）的模块 —— 这样「只读+发包」红线与请求频控口径各只有一个收口点。

`index.js` 注入给下层的 `env`（与 mine-cave 同款，不反向摸模块态）：

```js
env = { net, alive(), cfg, gameData, log, now(), uid(), originSid(), selfGroup(), selfCid() }
```

`selfGroup()/selfCid()` 内部就是 `gameData.cq26StarLandSelf()/cq26StarLandStatus()`，**每次调用现读**（ACL 坑 12：`group` 会因 `isRegroupRound` 重排，缓存即错）。

---

## 3. 数据链路与成本模型（决定一切节流参数）

### 3.1 三层链路

```
L0 2201 {cid, group} ──► 612 region ──过滤 type=3 && status∈{4(,5)}──► 候选分区池（本场 34 个：本服 1 + 外服 33）
                                    │  每条自带主键 (mSid, showNum)，showNum 即 wastelandIndex（ACL §2.5）
L1 2120 {wastelandIndex:showNum, sid:mSid} ──► {pos:{x,y,k}}         —— 房间/分区锚点，k=wkid
L2 901 {x, y, k:wkid, width, height, viewLevel} ──► pointList[pointType=316] 的 m 块
                                    │  只有这里能拿到 initSid/ownerId/gNum/oNum/gatherStartTime/两个名单
legs.js 三谓词 + 打分 ──► act.js 发 2114/2116/2115
```

### 3.2 扫描成本实测（这是节流参数的唯一依据，不能靠感觉）

- 一帧 901 在 `viewLevel=1`、`37×60` 窗下实测收到 **36 个** 316 点（真人 5524.0 那帧，房间 `14003212`）；`viewLevel=0`、`18×30` 窗收到 15 个在采点。
- 但**一个分区的点铺得比一帧窗大**：去重后实测 `14003212` 的 131 个点跨 `x[17,192] y[326,458]`（≈176×133 格），`14014112` 的 369 个点跨 `x[415,809] y[276,708]`（≈395×433）。⇒ **单窗只是采样，不是全量覆盖**。
- 结论：v1 明确采用**「每候选 1 窗（37×60，锚点为心）的采样口径」**，并把窗数做成可配（`scanWindows` 1/2/4，2 窗 = 锚点上下错位，4 窗 = 2×2 平铺）。不承诺"扫全分区"，面板文案与日志都写「采样」，避免用户按全图最优预期。

### 3.3 每拍预算（默认值，全部可配）

| 参数 | 默认 | 理由 |
| --- | --- | --- |
| `l0TtlSec` | 300 | 2201 的分区状态变化慢（分区开关是分钟级）；5min 内复用缓存 |
| `candCap` | 12 | 一次 burst pass 最多精筛 12 个候选（≈ 12×(1×2120 + 1×901) = 24 个只读请求），够填满 5 次即时额度 |
| `candOrder` | `本服优先(协助) → 外服按 2201 出现序(盗采)`；失败过的候选降权到队尾 | 协助只有 2 次且必须本服，先把它做完能立刻让 help 腿退出扫描 |
| `rescanMin` | 3 | 同一候选连续 3 次扫不到可动点 ⇒ 当日降频到 `l0TtlSec×6`（不是拉黑，分区状态会变） |

L0 缓存失效的三个外部事件：`22071`（分区状态推）、`22001`（group 变更）、日界（配额滚清）。任一命中即置 `l0Dirty`，下一拍重发 2201。

---

## 4. 三腿判据与选点

### 4.1 谓词（逐字镜像 ACL §4.4，**闸门顺序不得改**）

```js
// 全部输入来自 901 的 m 块 + ACL 额度快照；任何一项 null/undefined 都当"不可动"，不当 false 里最宽松的那支
canGather(p, s, me, originSid)  // 采集腿：非客户端谓词（客户端无对应函数），是我们自己的选点口径
  = p.m.initSid === originSid                        // 本服点
 && (p.m.ownerId == null || p.m.ownerId === '' || p.m.ownerId === '0')  // 无主
 && p.m.specIndex != null                            // 缺 specIndex 即不可采（游戏 clickCQ26WLGather 直接 return）
 && s.todayCanGatherTime > RESERVE_SEC               // 留额，见 §4.3
 && s.noSelfMarchOnThisPoint                         // 同点互斥（§4.4 走 isGathering + 行军坐标，不用 ACL 的 isGathering 总闸，ACL 坑 6）

canSteal(p, s, me, originSid)   // = 游戏 canSteal 的镜像，五闸原序
  = p.m.initSid && p.m.initSid !== originSid
 && !(p.m.stealUidList || []).includes(me)
 && (p.m.stealUidList||[]).length + (p.m.protectUidList||[]).length < conf364
 && s.remainStealNum > 0
 && p.m.gatherStartTime > 0 && p.m.gatherStartTime + conf367 <= nowSec && p.m.gNum > 0   // gNum>0 是陈旧 gStart 的兜底，ACL §4.4

canHelp(p, s, me, originSid)    // = 游戏 canHelp 的镜像，六闸原序
  = p.m.initSid && p.m.initSid === originSid
 && p.m.ownerId && p.m.ownerId !== '0' && p.m.ownerId !== me     // 必须已有他人主人
 && !(p.m.protectUidList || []).includes(me)
 && steal+protect < conf364
 && s.remainHelpNum > 0
 && (!(p.m.gatherStartTime > 0) || p.m.gatherStartTime + conf367 <= nowSec)  // 源码原文：未开采也放行
```

两处**源码不对称**，实现必须照抄而不是"顺手对齐"（否则与玩家看到的按钮不同源）：盗采不校 `ownerId`（靠 `gatherStartTime>0` 隐含在采）；协助在 `gatherStartTime==0` 时放行。

`conf364`/`conf367` 走 `gameData.cq26WlConf(id)` **现读**；`conf367` 的值无法从报文推（ACL §4.5），**禁止硬编码秒数**，读不到即整腿 fail-closed（§5 闸 3）。

### 4.2 打分与配额（三腿各一条排序键）

| 腿 | 排序键 | 依据 |
| --- | --- | --- |
| 盗采 | `oNum` **降序**（`oNum = floor(gatherSpeed/2)`，实测 2898→1449 vs 157→78，差近 20 倍） | 每日 3 次 ≪ 33 个外服候选 ⇒ 价值全在"跨池择优"。门槛 `minStealONum`（默认 100）过滤"花一次额度换 78 金"的碎点 |
| 协助 | 同上 `oNum` 降序，门槛 `minHelpONum`（默认 0，本服不花跨服扫描成本） | 实测 1 次协助拿 1575 thor / 78 gold |
| 采集 | `(itemId 白名单, gatherSpeed 降序, 距锚点距离升序)` | 采集腿是长期占用，速率即产出速率；1301/1303（`itemId` 4502/4501）分级白名单 |

`oNum` 缺失（该点从未被 901 回过）时**不得**当 0 排序，而是整条候选跳过并 `debug`（缺字段属报文形态问题，§9）。

### 4.3 采集腿的行军生命周期（`march-loop.js`）

状态机只有四态，全部判据来自可重放读通道（856 行军列表 + 901/10018 点态），不引入私有定时器链：

| 态 | 进入条件 | 动作 |
| --- | --- | --- |
| IDLE | 本人无 315 行军 | 精筛取最优 `canGather` 点 → 发 2114 |
| GATHERING | 有 315 行军且 `state` 在采 | 每拍核对 `todayCanGatherTime` 与 `marchArrive`；**不主动召回**（除非命中下面三条退出条件） |
| RETURNING | 已召回/自然回城 | 睡到 `returnArriveTime`；期间不重扫（`isGathering` 仍可能为 1，ACL 坑 6） |
| SPEEDUP | 命中退出条件且回程中 | 发 `2123 {marchId, itemId}`（实测只用 `520001`/`520002` 两种，且都发生在 2121 之后同一 marchId） |

退出条件（任一）：① `todayCanGatherTime <= RESERVE_SEC`（默认留 1800s）→ 召回；② 该点 `stealUidList+protectUidList` 已达 `conf364`（被别人薅满，继续挂着无收益）→ 召回；③ 面板「成熟即召回」勾选且 `gNum` 停止增长连续 2 拍 → 召回。`marchId` **必须按字符串**从 `raw.d` 取（19 位 Int64 在 `data` 里已丢精度，ACL 坑 9）。

召回即发 `2121 {marchId}`，实测 2 次；owner 侧到账走 10264 采集报告邮件 + 10001（ACL §4.4.1），本 feat 不校验到账（属 SOFT，§10）。

---

## 5. 闸门序列（fail-closed，按序短路，每口一条 debug）

```
1 活动闸      gameData.cq26IsOpen()                      不过 → 整 feat idle，debug 一次
2 身份三元组  cq26StarLandSelf().group / cq26StarLandStatus().cid / cq26OriginServerId()
              任一 null → **整腿停摆**（发不出 2201，也定不了本服/外服），warn 一次 + error 只在首轮
3 配置闸      cq26WlConf(52000364|52000367) null → 盗采/协助腿停摆（谓词无法求值），采集腿不受影响
4 额度闸      22072 快照（= wlInfo）三态：null → 本拍跳过并 debug('no wlInfo yet')；
              0 → 该腿退出本轮（不当错误）；>0 → 继续。绝不把「无快照」读成 0（ACL 坑 3）
5 时刻闸      gameData.serverTime() 不可得 → 整拍跳过（成熟判定依赖它）
6 日界滚清    todayStr() 变化 → 清 reject 计数 / 重置本地 attempt 标记（额度本身走服务器快照，不自记）
7 候选级      逐候选过：rescanMin 降频 → 拉黑（同 wkid_x_y 连续 MAX_REJECT 次被拒 → 当日不再发）
              → 冷却（单次被拒 REJECT_COOL_MS，不拉黑）
8 单飞        act.js 对每个 cmd 用 net.isSending(cmd) 串行（等价游戏 checkRequestIdNoRes）；
              survey.js 的 2201/2120/901 各自一条在途队列
```

**三腿互斥**：同一拍内 `act.js` 只允许一个写动作在飞（协助与盗采在同一点零和，见 §1 理由 2）；不同点的即时腿可以连发，但两条之间留 `ACT_GAP_MS`（默认 800ms，同 mine-cave/excav 的串行节奏）。

---

## 6. 写动作管线与拒绝分类

`act.js` 对四个写 cmd 走同一条管线：

```js
sendWrite(cmd, body) → net.sendPBV2(cmd, body)（永不 reject，sendGuarded 口径）
  ok/code===0        → info('done') + 标 dirty（等 22072/10018 自然收敛，**不本地改写额度**）
  CODE_NOT_SENT(-1)  → warn（我们没发出去），不占用拒绝计数，不拉黑
  code !== 0         → info + rejectText(ret)，rejectCount[key]++（达 MAX_REJECT 当日拉黑）
  应答缺 rewardResult / 缺 remainStealNum|remainGuardNum → warn（应答畸形），本拍不动这条腿
```

载荷形态**逐键照实录**，不加不减（skill 红线：不靠猜）：

```js
2114 → { wastelandIndex: p.m.specIndex, x, y }              // 实证 {9,682,384}/{9,716,436}/{9,723,433}
2115 → { wkid: p.k, x, y }                                   // 实证 {14003212,101,343}
2116 → { wkid: p.k, x, y }                                   // 实证 {14002112,639,279}
2121 → { marchId: <Int64 字符串，从 raw.d 取> }
2123 → { marchId, itemId: 520001|520002 }
```

**零拒绝样本声明**（ACL 坑 8）：本批 176 个会话文件里这些协议的 `header.s` 全为 0，`code≠0` 的具体取值与文案 key **一个都没实证**。因此 §5/§6 的退避与拉黑参数属于"既有纪律的复用"，不是实测结论；上线后首批 `info` 级拒绝码必须回灌 ACL §3.1 与本文。

---

## 7. 调度、订阅、生命周期与存储

### 7.1 两个 `createCycle`（不做第三个）

| 循环 | 负责 | `run()` 返回 delay |
| --- | --- | --- |
| `burstCycle`（即时腿） | help + steal 两条腿：L0/L1/L2 采样 → 谓词 → 连发 | 配额已满 → `idleSleep`（默认 10min）；未满但无可动点 → `busySleep`（90s）；本轮有发包 → 8s（等 22072/10018 到货后立刻补扫） |
| `marchCycle`（行军腿） | gather 腿四态 | IDLE→`busySleep`；GATHERING→到下一个核对点的精确秒数（封顶 5min）；RETURNING→到 `returnArriveTime` |

两个循环都存**模块级引用**，`spec.pause(ctx)` 里各自 `stop()`（skill 红线：reactor 的触发器摘除管不到 feat 自建定时器；在飞 `await` 循环靠 `alive()` 短路）。

### 7.2 订阅（全部经 `ctx.on.*`，退订由 reactor 托管）

```js
ctx.on.push(22071)  // 分区状态 → l0Dirty + kick(burst)
ctx.on.push(22072)  // 额度权威（每个写动作同秒下发）→ 刷新额度视图 + kick(burst)
ctx.on.push(22001)  // selfInfo.group 变更 → l0Dirty + kick(burst)
ctx.on.push(10018)  // 单 tile 新 m（写完即推）→ 点态缓存更新 + kick(march)
ctx.on.resp(2114|2115|2116|2121|2123)  // 只做「应答形状核对 + 日志」，不当额度源（ACL 坑 3：额度只认 22072）
ctx.on.req(2120|901)                   // req↔resp 配对靠 Event.reqTime 取锚点/窗归属（skill：不靠 FIFO+TTL 猜）
```

`10001`（资源总量）**不订**：即时腿的 reward 已从 `resp.rewardResult` 可读，10001 只在 §10 对拍里作为"确实到账"的外部证据。

### 7.3 存储（`core/storage.js`，UID 命名空间，`storageKey: 'pocketcc.feat.cq26_wl_gather'`）

只持久化**跨拍有用且可从服务器重放**的少量状态，不落缓存池（重启后重新扫即可，避免脏候选）：

```js
{ enabled, legs:{gather,help,steal},                   // 开关类（detail-hidden 也只持久化这些 + intentEnabled）
  dayKey,                                              // todayStr()，日界滚清锚
  reject: { [wkid_x_y]: { n, ts } },                   // 当日拉黑计数
  triedONum: [ ... ],                                  // 当日已花额度的 oNum 记录（面板展示"今天盗了什么档次"，纯观测）
  surveyMemo: { [mSid_showNum]: { miss, ts } } }       // §3.3 的 rescanMin 降频计数
```

**绝不落盘**：额度值、候选池、点态 `m`（全部以服务器快照/报文为准，只读+发包红线）。

---

## 8. 面板字段（descriptor，`buildFields` / `buildDefaults` / `normalizeCfg`）

```
荒芜冰原采集   [x] 启用
  ── 三条腿 ──
  [x] 采集（本服无主点，派兵）        [x] 协助（本服他人点，即时）        [x] 盗采（外服成熟点，即时）
  矿种：[x] 雷神矿脉(4501)  [x] 矿山(4502)        留额阈值(秒) 1800        [x] 成熟即召回
  ── 门槛与预算 ──
  盗采最小 oNum [100]      协助最小 oNum [0]      候选精筛上限 candCap [12]
  每候选窗数 scanWindows [1]（1=锚点单窗 37×60，4=2×2 平铺）  分区状态纳入 [x] 开荒中(4)  [ ] 已开(5)
  ── 状态行（type:'text', multiline, get()）──
  组/副本：group=14 cid=2（每拍现读）      额度：steal 3/3  help 2/2  采集 57600s
  候选池：type3+status4 = 34（本服 1）    最近：101,343 盗得 thor 1449（oNum 1449）
```

字段纪律：说明行用 `type:'note'`（`renderCheckbox` 不消费 `topHint`，挂上去会静默不渲染 —— excav.js 里已踩过）；`get()` 状态行与引擎**同一判据**（读 `survey` 的实际缓存，不自己重算一遍谓词，避免"面板说可采 1、引擎每拍零发包"的旧翻版）；`normalizeCfg` 里对 `scanWindows`/`candCap` 做钳制，越界回落默认并 `warn` 一次。

---

## 9. 日志分级（每个出口都归级，dashcam 单轨可还原"为什么没动"）

| 级 | 触发 | 样例消息（一律英文，带可 grep 前缀） |
| --- | --- | --- |
| error | 身份三元组/符号长期不可得导致**整 feat 停摆**（首轮一次，之后降 warn 去重）；两个 cycle 的 `stop()` 抛错 | `CQ26-WLGATHER star-land identity unavailable (group/cid/originSid), engines idle` |
| warn | `CODE_NOT_SENT`；应答缺 `rewardResult`/额度键；`cq26WlConf` 读空致某腿停摆；`showNum` 与 2111 `wastelandList` 校验不符（退回逐分区路径）；未知 `wastelandType/status` 首遇 | `2115 resp malformed (no rewardResult), steal leg skipped this tick` |
| info | 生命周期；每个写动作成功（cmd + 坐标 + `wkid` + 得到什么）；`code≠0` 业务拒绝（带 `code` + `rejectText`） | `steal ok wkid=14003212 @101,343 got thor_elements=1449 remainStealNum=2` |
| debug | 每个 skip/abort 出口：`no wlInfo yet`、`quota full (steal=0)`、`no candidate left under minONum=100`、`cand 4178_6 downgraded (miss=3)`、`l0 cache hit (ttl 240s)`、门控不过、退避中 | 必带 `cmd`/`code`/坐标/`mSid_showNum`/状态枚举 |

「被拒路径不得打 warn」沿用既有纪律（一次性业务拒绝是 info，达 `MAX_REJECT` 拉黑时才在 info 里追加 `(blacklisted today)`）。

---

## 10. 对拍接入（`scripts/verify-manifests/cq26-wl-gather.mjs`）

`buildScan(recPath)` 单遍扫录制，维护四条时间线：`2201` 首快照的 region 表、`22071` 分区状态、`22072` 额度（含每个写动作同秒那份）、`901/10018` 的点态（键 `k_x_y` → `m`）。`runVerify` 逐笔写动作 `snapshotAt(req.ts)` 回查后过判据，调 `rep.check(name, d, pass, fail, skip, samples)`。

| 规则 | 级 | 判据 |
| --- | --- | --- |
| 载荷键形 | **HARD** | 2114 恰 `{wastelandIndex,x,y}` 且 `wastelandIndex === 该点 m.specIndex`；2115/2116 恰 `{wkid,x,y}` 且 `wkid === 该点 k`（跨版本恒成立的字段形态） |
| 盗采归属 | **HARD** | 发 2115 时目标 `m.initSid` 存在且 `!== OriginServerId`（本服号取该录制 uid 的 3828；**注意用 OriginServerId，不是 `world.selfServerId()`**，ACL 坑 11） |
| 盗采成熟 | **HARD** | 发 2115 时 `m.gatherStartTime > 0` 且 `m.gNum > 0` |
| 协助主人 | **HARD** | 发 2116 时 `m.initSid === OriginServerId` 且 `m.ownerId` 非空非 0 非自己，且自己不在 `protectUidList` |
| 额度 > 0 | **HARD** | 发 2115/2116 前最近一份 `22072` 的 `remainStealNum`/`remainHelpNum` `> 0` |
| 名单余量 | **HARD** | 发时任一点 `steal+protect < conf(52000364)` |
| marchId 口径 | **HARD** | 2121/2123 的 `marchId` 可无损还原为 Int64 且命中本人 901/10007/10019 里的 315 行军 id（录制侧实录是 Long 对象、feat 发十进制串，两种编码等价 ⇒ 见 §14） |
| 择优性 | SOFT | 同一次 pass 内所选点的 `oNum` ≥ 同帧已扫到的最大 `oNum`（允许"够好就出手"，默认不 FAIL，只报差距） |
| 扫描节奏 | OBSERVATION | 2201 次数、901 窗数/候选、每候选请求数（只报量级区间，不判负） |
| 到账核对 | OBSERVATION | 写动作同秒 `10001` 是否含对应资源增量（覆盖率低只报数） |

`defaultRecs` 指向该趟印石日常主跑趟实录。按 skill 踩坑第 5 条，manifest 侧自建写视图（从 `entry.body`/`o.raw` 剥业务槽），不信内核 `w.req`。

---

## 11. 已知缺口与补证步骤（诚实声明）

| # | 缺口 | 影响 | 补证步骤 |
| --- | --- | --- | --- |
| 1 | **未实证「不必真的进入该房间也能发 2115/2116」**。真人链路是 `2112 → 2120 → 901(viewLevel 0/1) → 气泡点击 → 2115`，我们复制了读侧全链路，但服务器是否校验"视野/房间归属"无从得知（零拒绝样本） | 若服务器校验，v1 的做法（照抄读侧链路）恰好是安全的；若**不**校验，我们可以省掉 L1/L2 之外的动作但收益不变 | 首跑若出现稳定 `code≠0` 且集中在跨服点 → 把 `candCap` 降 1 做单点实验，把首批拒绝码回灌 ACL §3.1 |
| 2 | **零拒绝样本**（ACL 坑 8） | 退避/拉黑参数未经实测 | 同上；`info` 级 code 分布回灌后即可定稿 |
| 3 | **单窗采样≠全量**（§3.2 实测 131/369 点跨 176×133~395×433） | 可能漏掉同分区内更高速率的点；每日只 3 次盗采，漏优即漏收益 | 面板把 `scanWindows` 开放到 4；另用一次真人录制对照"4 窗扫到的最大 oNum vs 人工进图看到的最好点" |
| 4 | **`showNum === wastelandIndex` 是 16/16 报文实证，非源码断言**（源码把该字段当 `showId` 用于渲染） | 若某期服务器让两者分叉，候选会指错分区 | 每次 L0 后用本服 `mSid` 的 region 与 2111/22071 的 `wastelandList` 逐条校验 `type/status`，不符即 warn 并退回逐分区（`2127`）路径 |
| 5 | **`conf(52000367)` 的值未知**（报文里只有结果，无配置） | 成熟判定完全依赖 ACL 现读；读不到就无法判"能不能盗" | 上线后从 ACL 打出实际值并回灌本文；若与 `gNum` 反推的档位不一致，以配置为准并记 warn |
| 6 | **`oNum` 语义仍有缺口**：639,279 协助后 `oNum` 归零、627,283 协助后 `oNum` 不变（78） | 不作 HARD 判据；只用于排序 | 再录 2~3 次不同档速率的协助，看归零是否与 `protectUidList` 人数相关 |
| 7 | **`2122 NWL_COLLECT_WKID_LIST` 客户端零调用、报文零样本** | 若可用，能把 §3.1 的 L1+L2 全省掉（一次查出所有在采点 wkid） | 单点实验：真人进图前发一次 2122 看应答形态；验证通过前不接入 feat |
| 8 | **`group` 重排的实际频率未知**（`isRegroupRound` 只在源码里看到，本批录制无该 push） | 若一轮内多次重排，L0 缓存会短暂指错组 | §3.3 的 `l0Dirty` 已挂 22001；另在每次 burst pass 前比对 `group` 值变化即可自愈 |

---

## 12. 刻意不做

1. **不改写游戏本地数据**：不碰 `wlInfo`/`wlListMap`/`mapData`（含"顺手把 `remainStealNum` 减 1"这种看似无害的本地记账，ACL 坑 3 已证服务器同秒会给）。
2. **不发** `2113`（开分区，花电力 + 联盟/引导权限）、`2117`/`2129`（融冰小游戏）、`2126`（时刻由盟里定）、`2130`/`2122`（客户端零调用点）、`2110`（捐火）、WLB 2131~2139 与战区巨兽 2451~2459（同名不同源，ACL 坑 1）。
3. **不碰 type1/type2/type5 分区**：巨兽（`wl-beast`）、融冰、`HELP_BOSS` 援助地块（含 `beastStatus`）都超出本 feat 范围。
4. **不派兵到 2115/2116**：两腿都是即时结算，派兵分支会双花兵力（同 ACL 坑 2 对 2125 的辨析）。
5. **不做"跨组看别组地图"**：`group` 一律取 `selfInfo.group`（`CQ26MapUI` 看别组时连本组信息面板都隐藏，我们没理由更聪明）。
6. **不承诺扫全分区**（§3.2），面板/日志统一用"采样"措辞。
7. **不在 `pause` 后继续任何在飞循环**：`pause` 收两个 cycle + `survey` 的在途队列（skill 的 `run()` 里 new 出来的必须存引用并显式收）。

---

## 13. 验收清单

- [x] ACL §5 的新投影（`cq26StarLandSelf/cq26StarLandStatus/cq26OriginServerId` + `cq26WlConf`）已实现且单测覆盖 null 三态
- [x] `npm run build` / `npm run lint` / `npm run arch` 全绿（`feats/cq26/wl-gather/` 内部可互相 import，不得跨 feat）
- [ ] 面板出现「荒芜冰原采集」，三腿开关独立生效；`pause` 后 dashcam 日志里无新的 21xx 写动作
- [x] 载荷形态与实录逐键一致（2114 用 `specIndex`、2115/2116 用 `k`、marchId 可无损还原）
- [x] `node scripts/replay/run.mjs --manifest cq26-wl-gather <该趟真人实录>` 退码 0（HARD 全过；用真人录制当"应当 FAIL 的负样本"跑一遍证伪，确认判据不是永真）
- [ ] 首次真机跑的 `info` 级拒绝码已回灌 ACL §3.1 与本文 §11
- [x] 文件头注释标注报文实证来源（本 feat 全部协议形态引用 ACL §8 的脚本清单）

---

## 14. 首轮对拍实测校准（`npm run verify:cq26-wl-gather`，印石日常主跑趟真人实录）

退码 0；`negSelfTest()` 一次注入五类假违例后，**8 条 HARD 全数翻红**（D1 载荷、D3 盗采、D4 协助、D5 额度、D6 marchId、D7 名单余量需 env、D8 谓词复跑、D11 通道），判据非永真。四处口径按实测校正：

1. **marchId 不是「字符串形态」**：2121/2123 实录的 `marchId` 是 protobuf Long 对象 `{_low,_high,_unsigned}`（十进制 4.9e18 级）。内核 `int64.toNum` 走 double 会在末位丢精度，故 manifest 自建 BigInt 口径，判据改为**「可无损还原的 Int64 且命中本人 315 行军 id」** —— feat 发十进制串与录制发 Long 对象是同一数值的两种合法编码，不作违例。另：本人 315 行军**不在 856 里**（856 只有 3 条开局旧行军，type 3/25），来源是 901 `marchList` + 10007/10019 push。
2. **真人盗采发生在 `status=5`（OPENED）分区**：22071 全量里分区 9 是 `4 OPENING`、分区 6 是 `5 OPENED`，两笔 2115 都在 OPENED 区 ⇒ 「分区状态纳入集」只做 OBSERVATION（报写动作所在分区的状态分布），不开 HARD；feat 默认仍只纳入 OPENING=4，`OPENED=5` 由面板勾选放开。
3. **22072 只伴发「点写入」**：7/7 点写入（2114/2115/2116）同秒有额度推送，13 笔行军类（2121/2123）不伴发 ⇒ 同秒到达率的分母改为点写入数。另一处实测：当日**第一笔**动作前最近一份 22072 可已 30 分钟旧（Δ=1 802 880 ms），「发前回查」仍成立只是不新鲜 —— 额度判定靠「`>0`」而不是靠「同秒」，与 §4.3「零本地记账」不冲突。
4. **`2120` 请求有两种键形**：本服只 `{wastelandIndex}`，跨服带 `sid`（实测 9 请求 / 5 个分区锚点）。应答 `pos.k` 与 2201 L0 给的 region `wkid` 逐一对上（D10 SOFT 11 项通过），故 §3.1 的「L0 粗筛 → L1 锚点 → L2 精筛」链路在录制侧自洽；仅分区 4 的锚点不在 L0 采集分区集内（该分区当时不属采集线），记 SOFT 不判负。
5. **谓词复跑（D8）实测吻合**：把 `legs.canGather/canSteal/canHelp` 直接跑在「发前那一刻」的快照上，可判定的点写入全部判可发（盗采/协助两腿需 `WL_CONF_MEMBER_MAX` + `WL_CONF_MATURE_SEC` 注入，取 5 / 3600 时零违例）。这是「引擎代码 vs 真人决策」最硬的一条对拍 —— 用引擎自己的函数复判真人，而不是手抄一份规则自证。
