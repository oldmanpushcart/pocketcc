# feat · 荒芜冰原-采集

> 状态：**协议取证阶段，设计中**。
> 本文档覆盖「采集区域」三腿玩法（采集/协助/盗采）的协议实证、扫描策略与调度设计。
> 详细协议字段见 [`acl-cq26-荒芜冰原.md`](acl-cq26-荒芜冰原.md)；历史实现见 [`feat-荒芜冰原采集.md`](feat-荒芜冰原采集.md)（已重构为 `cq26WlMine`）。
> 挑战区域（巨兽）见 [`荒芜冰原-巨熊盛宴.md`](荒芜冰原-巨熊盛宴.md)。

---

## 1. 棋盘查询协议选型：2201（非 2111）

### 结论

**统一用 `SERIES_FROST_STAR_LAND_MAP_SINGLE_INFO` (2201) 作为棋盘唯一查询入口。**

### 理由

| 对比项   | 2111 NWL_INFO  | 2201 STAR_LAND_MAP_SINGLE_INFO                          |
| -------- | -------------- | ------------------------------------------------------- |
| 视野     | 仅本服 16 分区 | 全组 144 格 → 89 房间 → **612 region**                  |
| 跨服分区 | **看不到**     | 每条带 `mSid`（归属服务器）                             |
| 盗采候选 | 无法发现       | `type=3 && status=4/5 && mSid≠self` 直接筛出            |
| 本服采集 | 可用           | `mSid === OriginServerId` 过滤即可（实测 1 个 OPENING） |
| 额度     | 有             | 无（靠 22072 push）                                     |
| 响应体积 | 小             | 大（~10KB/612条），需本地过滤                           |

### 请求参数

```js
{
  cid: <来自 selfInfo / 22001 push>,   // 赛季活动 cid (=2)
  group: <来自 selfInfo.group>          // 分组号 (=14)
}
```

### 候选过滤逻辑

```js
// 采集（本服 OPENING 的 GATHER 分区）
ownGather = allRegions.filter(
  (r) => r.wastelandType === 3 && r.status === 4 && r.mSid === OriginServerId,
);

// 盗采（外服 OPENING/OPENED 的 GATHER 分区）
stealTargets = allRegions.filter(
  (r) => r.wastelandType === 3 && (r.status === 4 || r.status === 5) && r.mSid !== OriginServerId,
);
```

### 2201 不含的字段（不影响决策）

- `wastelandCondition` / `endTime`：分区到期时间和解锁条件——对采集/盗采均无实质影响（OPENED 同样可盗采，到期不影响在途行军）。
- 额度字段：由 22072 push 提供，无需重复查询。

---

## 2. 推送行为实证结论

### 2.1 棋盘（wastelandList）变动无服务器主动 push

**证据**（录制 `dashcam-rec-20261109T043951`，15.5h，46782 行）：

- 22071/22072 push 全场仅 **1 条**（t+599s，本人 315 行军回城触发）。
- 15 次主动 2111 轮询覆盖 10:39→02:04，GATHER 分区 status **零变化**。
- 无 10018 tile push 涉及 NWL wkid（全部 12 条指向别的地图）。
- 无 22077 宝箱 push。
- **他人开分区 / 分区到期翻转 → 本客户端完全无感知**。

### 2.2 开分区（2113）响应自带新状态

源码 `CQ26WLOpenMain.onLandOpenSuc(e)` 证实：

```js
// e 即 2113 resp data，结构为：
{ isOk: 1, wasteland: { wastelandIndex, status, ... } }
// 游戏直接本地替换 wastelandList[idx]，不依赖独立 push
```

### 2.3 三类开分区（采集/巨兽/冰封）行为一致

`CQ26WLOpenBaseComponent.sendToUnlock(e)` 对所有分区类型发同一个 2113，仅 UI 子节点 prefab 按 `landType` 分叉。协议层无区别。

### 2.4 设计含义

- **候选池必须 cycle 内主动 2201 刷新**（外部开分区无 push 通知）。
- 额度走 `cq26WlInfo()`（读 22072 内存快照），零额外请求。
- 2111 仅作为冷启动 fallback（22072 尚未到达时）。

---

## 3. 采集区域（采集/协助/盗采）关键结论

### 3.1 可采集分区判据

```
wastelandType === 3 (GATHER)
&& status === 4 (OPENING)   // 实测：OPENED(5) 的分区内资源点仍可采集（有未采完的）
```

### 3.2 额度权威：22072 push

| 字段                 | 语义                               | feat 用法                                                         |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `todayCanGatherTime` | 今日剩余采集秒数（57600=16h 满额） | 采集腿本轮窗长 `roundWindowSec`（满额=一个安全期，零头=尾轮短窗） |
| `remainStealNum`     | 今日剩余盗采次数（上限 3）         | 盗采腿闸门 `> 0`                                                  |
| `remainHelpNum`      | 今日剩余协助次数（上限 3）         | 协助腿闸门 `> 0`                                                  |
| `isGathering`        | 本人是否已有采集行军在场（0/1）    | 采集腿：1 时先走认领，不无脑重复派兵                              |

- 每次 2114/2115/2116 后同秒必伴 22072。
- 2121(召回)/2123(加速) **不触发** 22072。
- 0 点日切不主动推——靠下次动作刷新或 cycle 主动 2111 兜底。
- 采集行军**到家瞬间**会补推一份 22072（同秒跟在 10019/10007 `type=315 state=4` 之后）——实录 20261111 逐轮可见；正常轮转实际上是被这条推送救回来的。
- 由此得到一条硬约束：**`isGathering` 没有 TTL，也没有「归 0」的独立事件源**。除到家补推外，它只会停在派兵那一刻写入的 1；扩展 reload（模块态清零）、手操召回、上一日遗留都会让它长期为真。采集腿不能把它当纯闸用 → 见 §3.10。

### 3.3 写动作协议速查

| cmd  | 动作     | 请求载荷                 | 应答                             | 特点                            |
| ---- | -------- | ------------------------ | -------------------------------- | ------------------------------- |
| 2114 | 采集派兵 | `{wastelandIndex, x, y}` | `{isOk}`                         | 占行军队列，315 型行军          |
| 2115 | 盗采     | `{wkid, x, y}`           | `{rewardResult, remainStealNum}` | 即时结算，不派兵，扣 owner gNum |
| 2116 | 协助     | `{wkid, x, y}`           | `{rewardResult, remainGuardNum}` | 即时结算，不派兵，不扣 gNum     |
| 2121 | 召回     | `{marchId}`              | `{isOk}`                         | 触发到账邮件(10264)             |
| 2123 | 加速     | `{marchId, itemId}`      | `{}`                             | 缩短行军时间                    |

### 3.4 次级定位链路

```
L0: 2201 → region(mSid, showNum, wkid) → 候选分区池
L1: 2120 {wastelandIndex:showNum, sid:mSid} → {pos:{x,y,k}} 分区中心坐标
L2: 901 {x, y, k:wkid, width, height, viewLevel} → pointList[pointType=316] 具体采集点
```

- `showNum === wastelandIndex`（16/16 实证）。
- `k = wkid`，格式 `RRRRRLLTT`（5位区号+localX+localY+1位）。
- `initSid === OriginServerId` 判本服/跨服（点内字段，非 region.mSid）。

### 3.5 分区扫描几何实证（录制 dashcam-rec-20261109T205818）

**901 viewLevel=2 单帧有效覆盖 ≈ 192 × 160 tiles**（远大于请求字面 w=75,h=120；width/height 是相机渲染参数，服务器回窗另有上限）。

以分区 9（sid=1836, wkid=14011512）为例，全量 **155 个 316 点** 分布：

| 扫描       | 请求中心   | 回点 x 范围 | 回点 y 范围 | 命中 | 新增   |
| ---------- | ---------- | ----------- | ----------- | ---- | ------ |
| Scan1 居中 | (713, 356) | [617, 809]  | [276, 435]  | 112  | 112    |
| Scan2 x-50 | (663, 356) | [617, 777]  | [276, 435]  | 84   | **0**  |
| Scan3 y-60 | (713, 296) | [619, 807]  | [242, 375]  | 103  | **43** |
| Scan4 x+50 | (763, 356) | [649, 809]  | [276, 435]  | 91   | 0      |

**分区跨度**：x [617, 809]=193, y [242, 435]=194。x 方向一帧就吃下（192≥193），仅 y 方向漏底部 ~34 tiles。

**扫描策略：固定 2 次即可 100%**（`Scan1 居中 + Scan2 (x, y-60)`），x 偏移无收益；请求参数 `viewLevel=2, width=75, height=120, k=wkid, rid=0, marchInfo=false`。

### 3.6 安全期套利策略（攻略实证）

**核心机制**：每次采集的前 2h 为安全期（`conf(52000367)` = 7200s），不会被偷。每日 16h 额度可分 **8 轮 × 2h** 使用，每轮撤回后重新派兵 = 重新享受 2h 安全期。

| 参数       | 值                                          | 来源                      |
| ---------- | ------------------------------------------- | ------------------------- |
| 安全期时长 | 7200s (2h)                                  | `conf(52000367)`          |
| 每日额度   | 57600s (16h)                                | `todayCanGatherTime` 满值 |
| 每日轮次   | 8 次                                        | 57600 / 7200              |
| 撤回时机   | `marchArrive + 本轮窗长 - 60`               | 留 60s 余量               |
| 派下一轮   | 收到 10007 `state=4` (ARRIVED_HOME) 后 kick | 行军回城事件              |

**设计含义**：

- 采集 cycle 不是「派一次采 16h」，而是 **8 轮循环：派→采 2h→撤→回→再派**。
- 选点优先**近家**（行军 ETA 短，一天能塞下 8 轮）。
- march-loop 需精确计时：`nextCheckAt = marchArrive + 7200 - marginSec`，到点发 2121 召回。
- **窗长是「本轮属性」而不是 conf 常量**：一天跑到剩余额度塞不满一个安全期时，尾轮窗长压成剩余额度照常派兵。
  旧口径是「塞不满一轮就睡到日切」，等于每天最多白丢一个完整安全期（实录 20261111 最坏 7199s ≈ 2h）。
  短窗召回仍早于成熟线，套利安全性方向不变（偏早只少赚这一段，偏晚才是把产出送给偷的人）。
  为此 `march-loop` 把窗长定格在 `roundMatureSec`，后续拿推送校准 `marchArrive` 时按它重算，不会升级回 conf 原值。
- 盗采目标：只能偷「过了 2h 但 owner 未撤回」的点；canSteal 谓词已包含此判据，无需额外时间窗过滤。

### 3.7 316 点 m 块字段与三腿判据

`m` = 客户端源码里的 `extData`，字段与 `NWICQ26WLResource.canSteal/canHelp/isGatheringResource` 一一对应：

| 字段              | 类型     | 语义                                                           | 用途                                                                      |
| ----------------- | -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `itemId`          | int      | 4501=雷神矿脉 / 4502=矿山                                      | 矿种白名单                                                                |
| `ownerId`         | string   | 开采者 UID（0=空闲）                                           | `isGatheringResource`、`canHelp` 判他人点                                 |
| `initSid`         | int      | 点位**归属服务器**（非 owner 的当前 sid）                      | 跨服判据：canSteal 要 `!==OriginServerId`，canHelp 要 `===OriginServerId` |
| `specIndex`       | int      | 所属分区 wastelandIndex                                        | 过滤本分区点                                                              |
| `gatherStartTime` | int (秒) | 开始开采时间戳                                                 | 成熟判据 `gst+conf(52000367)<=ServerTime`                                 |
| `gatherSpeed`     | int      | 每分钟产出（跨档）                                             | `oNum=floor(gatherSpeed/2)` 校验                                          |
| `gNum`            | int      | owner **已累积的采集量**                                       | 2115 盗采扣的就是这个                                                     |
| **`oNum`**        | int      | **该点可被盗采的量**（= floor(gatherSpeed/2)，单点不跨档叠加） | **盗采收益直接读数**，无需二次换算                                        |
| `stealUidList`    | string[] | 已偷过本点的 UID                                               | 判本人是否偷过 & 名额                                                     |
| `protectUidList`  | string[] | 已协助过本点的 UID                                             | canHelp 判重 & 与 steal 合并算名额                                        |

**三腿源码判据（`NWICQ26WLResource`）**：

- `canSteal(p)` = 外服 (`initSid!==OriginServerId`) + 本人未偷过 (`!stealUidList.includes(StrUid)`) + 名额未满 (`steal+protect < conf(52000364)`) + 已成熟 (`gst+conf(52000367)<=ServerTime`) + 今日额度 (`remainStealNum>0`)；实测跨服 `gStart` 存在陈旧值，需 `gNum>0` 兜底。
- `canHelp(p)` = 本服 (`initSid===OriginServerId`) + 他人正采 (`ownerId!=="0" && ownerId!==StrUid`) + 本人未协过 + `remainHelpNum>0` + 成熟；**协助不扣 owner gNum**（是额外奖励）。
- `isGatheringResource(p)` = `ownerId===StrUid`（本人正在采的点）。

**2114 载荷口径**（源码 `CQ26WLWorldGatherPop.onClickAction`）：

```js
{wastelandIndex: tileInfo.extData.specIndex, x: tileInfo.tileX, y: tileInfo.tileY}
```

**2115/2116 载荷**：`{wkid, x, y}` — wkid 即 2120 的 `k`；x/y 即点位坐标。

**验证脚本**：`.reviewtmp/wl-scan-coverage.devtools.js`（覆盖率）、`.reviewtmp/wl-steal-candidates.devtools.js`（盗采候选枚举）。

### 3.8 三腿 cycle 拆分

| Cycle    | 扫描对象                               | 节奏                         | 触发闸门                                                      |
| -------- | -------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| **采集** | 本服 OPENING 分区空闲点                | 8 轮/日，每轮 ~2h + 行军     | `todayCanGatherTime >= 600` 且（`!isGathering` 或认领判陈旧） |
| **盗采** | 外服 OPENING/OPENED 分区已过安全期的点 | ≤ 3 次/日，canSteal 满足即偷 | `remainStealNum > 0`                                          |
| **协助** | 本服他人正在采的点                     | ≤ 3 次/日                    | `remainHelpNum > 0`                                           |

- 采集 + 协助可共用一次本服分区扫描（同一批 901 结果按 ownerId 分派）。
- 盗采独立扫外服分区，按 mSid 分桶 + memo 缓存减少重复请求。
- 三腿不单独开关，统一由总开关控制；各腿是否执行由额度闸门与矿种清单自然决定。

### 3.9 stealCycle 无目标时的重试策略

单拍流程：

```
1. 候选分区列表 = 2201 过滤 (外服 + OPENING/OPENED + type=3)
2. 排除黑名单 (memo.stealable=false 且 5min 内扫过的分区不再重试)
3. 按优先级排序：
   上次有 canSteal 产出的 > 从未扫过的 > 黑名单刚过期的
4. 取 top-1 分区 → 2120 + 2×901 → canSteal 过滤
5. 有结果 → 偷 oNum 最大且 ≥ 该矿种最低可盗量的点 → 结束本拍
   无结果 → 该分区标记 stealable=false(5min) → 取 top-2 再试
6. 单拍最多试 MAX_ZONES_PER_TICK = 3 个分区
7. 3 个都无目标 → 本拍退出，nextCheckAt = 下次棋盘刷新
```

关键设计点：

| 参数                       | 值               | 理由                                        |
| -------------------------- | ---------------- | ------------------------------------------- |
| 单拍最多试几个分区         | 3                | 每分区 3 请求，3×3=9 封顶，不烧预算         |
| 分区黑名单 TTL             | 5 min            | 点状态变化慢（owner 2h 才撤），太短会重复扫 |
| 全部试完仍无目标           | 长睡到棋盘刷新   | 外服分区被偷空后短期不会恢复                |
| memo 命中且 stealable=true | 0 请求直接用缓存 | 进一步减少重复扫描                          |

### 3.10 陈旧 `isGathering` 的降级路径（采集腿不早停的关键）

**缺陷形态**：16h 额度只花掉一部分就再也看不到派兵（实录可见的最坏一天就是半程早停）。

**链路**：`gatherTick` 拿 `g.info.isGathering` 当硬闸 → 1 就走 `claimInFlightRound`（棋盘找「owner=我」的那颗点续跑状态机）→
找不到就 `return D.gatherIdleMs`，**没有上限**。而 `isGathering` 只由 22072 刷新，22072 只在「点写入」与「采集行军到家」两个时刻下发
（2121 召回不触发）—— 于是「陈旧 1 + 认领失败」是**自锁**：解锁需要一次 22072，而发 22072 需要先动作，动作又被闸挡住。

三种典型成因：扩展 reload（`march-loop` 模块态清零，服务器上那一趟照旧）、手操召回（不发 22072）、上一日遗留。

**实录证据**（uid 11981629951662 / 20261111）：分区 `3828_12` 在 00:12:12 已从 `status=2(CAN_OPEN)` 翻到 `4(OPENING)`、额度满 57600，
但引擎直到 02:00:30 才打出第一发 2114；中间 `00:15:55 → 01:56:01` 连吃 21 条 hold（严格 5min 一条 = `CLAIM_GAP_MS`），
靠一次扩展 reload 重新拿到 `isGathering=0` 才脱困。若落在白天中段，呈现的就是「只采了半天」。

**落地口径**（`index.js` 的 `claimInFlightRound` / `noteStaleClaim` / `noteProbeOutcome`）：

1. 认领连续 `CLAIM_STALE_MAX_MS`（15min）找不到本人的点，且**全部候选分区都已排除**（`staleCovered` 累计覆盖，
   单拍只有 `MAX_ZONES_PER_TICK` 预算）时，才把标志上报为陈旧。覆盖不全则把计时推平 —— 宁可继续 hold，
   也不许误判：误判的代价是多派一支兵，而上一支没人召回、成熟产出裸奔给别人偷。
   「本服已无 OPENING 采集分区」不谎报陈旧（那种情况选点也无从下手，是游戏侧 `checkWlOpening` 只认 `status===4` 的口径）。
2. 陈旧则放行一发**试探派兵**：真有一趟在外面时服务器回 `{isOk:0}`（11-08 实测：既不扣 `todayCanGatherTime`、也不动在采点），
   标志确实陈旧时则立刻恢复采集 —— 期望收益远超代价。
3. 试探自带指数退避 `PROBE_GAP_MS → PROBE_GAP_MAX_MS`（10min→20min→40min→封顶 60min），被接受即复位；
   且**不给目标点记拒绝账**（`settleWrite(..., countReject=false)`）：那是预期分支，累加到 `MAX_REJECT` 会把一颗本来可采的点当日拉黑，
   试探越多候选池反而越小。这三条一起防的就是 11-08 实录那种「64 发 2114 只有 2 发召回」的废券风暴。
4. 陈旧计时在三处归零：状态机在途（`marchBusy`）、`isGathering` 归 0、认领命中。

单测只能覆盖第 4 条里 `march-loop` 那一半（`roundMatureSec` 定格，见「尾轮短窗属于本轮」）；降级路径本身在 `index.js` 私有层，
靠录制回放核对：日志锚点 `(stale isGathering probe)` 与 `excluded=%d`。

### 3.11 额度闸只挡「再开一轮」，绝不挡认领与召回（11-12 事故）

**缺陷形态**：当日 `todayCanGatherTime` 已耗尽，外面那条 315 行军却没人召回 —— 点早过了成熟线，产出整段挂在「可被盗」那侧，
行军队列还被一支不再花额度的兵白占着。日志里既没有 warn 也没有 recall failed，看上去像「引擎知情却不撤矿」。

**链路**：旧 `gatherTick` 的序是 `windowSec = roundWindowSec(g)` → `!windowSec` 就地 `return 睡到日界`，**然后**才轮到 `isGathering` 的认领段。
于是「额度归零」这个恰恰最该收兵的信号，反而把唯一能收兵的路径杀了：重启后 `march-loop` 模块态清零 ⇒ `marchBusy()=false`（推进召回那条路不存在了），
认领那条又被额度闸挡在门外，整条采集腿一路睡到次日 0 点。

**实录证据**（uid 11981629951662 / 20261112）：14:22:08 派出一轮 `recallAt=1794471669`（=16:21:09）；14:29:08 打出 `next check at [14:30:08]` 后浏览器被硬关
（13:28 的会话停在 `.part` 未定稿），预定的召回无人执行；18:39 重开至 18:49，CQ26-MINE / -MARCH / -SURVEY 三件套**零日志**、2121 出网数为 0。
那颗点 (188,182)：itemId 4502、`gatherStartTime=1794464908`（14:28:28）、成熟线 16:28:28，18:49:01 仍 `ownerId=本人` 且 `stealUidList` 空 —— 已过成熟线 2h20m 挂在可被盗侧。
当日额度最后可见值 `todayCanGatherTime=11545`（14:22 的 22072），按在采秒数推算归零 ≈ 17:40:53。

**落地口径**（`index.js` 的 `gatherTick` / `claimInFlightRound`，与 §4.5 第 3 条同律）：

1. 认领段整体前移到额度闸**之前**；命中即 `return D.chainMs`（`claimInFlightRound` 为此新增 `claimed` 返回字段），让下一拍去推进召回。
2. 认领「未命中也未判陈旧」时：额度已尽 ⇒ 按 `max(delayMs, CLAIM_GAP_MS)` 睡，不在零收益的空拍上逐拍空转（中间那些拍在 `claimInFlightRound` 首句就被节流拦下，本就零请求）。
3. 判陈旧但额度已尽 ⇒ **不放行试探派兵**：试探本身就是「再开一轮」，已无窗可下；打 `probe withheld` debug 后按认领节奏重来，也不记拒绝账。
4. 额度闸本身（`!windowSec → 睡到日界`）挪到认领段之后：此刻确实没有任何东西替我们收兵，才允许睡到明天。
5. 认领命中的窗长取 `roundWindowSec(g) || RECALL_MARGIN_SEC`：连零头都不剩时 `recallAt = arrive`（已过或将过）⇒ 下一拍即发 2121。
   旧值 `TAIL_MIN_SEC` 只在 `gst` 已过期时才恰好退化成即刷；万一那一趟刚开始几分钟，它会把已不再产出的在采多留近 9 分钟（方向上不致被盗，但白占队列）。

单测覆盖第 5 条的状态机端（`tests/feats/cq26-wl-mine.test.js` 的「零额度认领下发的窗长 = RECALL_MARGIN_SEC」）；第 1~4 条是 `index.js` 私有层的闸门序，
不可直接单测，靠日志锚点核对：`claimed in-flight own gather march` → `2121 recalled at mature margin`，以及额度已尽时的 `probe withheld`。

**实测前提**：整条认领路径的数据源是 `gameData.cq26WlInfo()` 的 22072 快照。若重开后从没进过荒芜冰原界面、快照未达，`commonGate` 会停在
`no 22072 snapshot yet`（fail-closed：「还没推」不得读成「额度 0」），此时需要进一次界面取快照，召回才会启动。

---

## 4. 数据流总图

```
总开关 enabled
│
├─ gatherCycle (每轮 ≈ 2h + 行军时间)
│   1. 读 cq26WlInfo() → 窗长 roundWindowSec(剩余额度)；isGathering 则**先**走认领/陈旧降级（额度闸在其后，§3.11）
│   2. 发 2201 → 本服 OPENING 分区
│   3. 发 2120 + 2×901 → 空闲点 (ownerId=0)
│   4. 选最近可采点 → 发 2114
│   5. march-loop: 到达后计时 7200s → 发 2121 召回
│   6. 回城 (10007 state=4) → kick 下一轮
│
├─ stealCycle (额度驱动，≤ 3 次/日)
│   1. 读 cq26WlInfo() → remainStealNum > 0?
│   2. 发 2201 → 外服 OPENING/OPENED 分区
│   3. 排除黑名单 + 按优先级排序 → 取 top-N (≤3)
│   4. 2120 + 2×901 → canSteal 过滤 → oNum ≥ 该矿种最低可盗量
│   5. 有目标 → 偷 oNum 最大 → 22072 push 刷新额度
│   6. 无目标 → 标记该分区 stealable=false → 试下一个
│   7. 全部无目标 → 睡到下次棋盘刷新
│
└─ helpCycle (额度驱动，≤ 3 次/日)
    1. 读 cq26WlInfo() → remainHelpNum > 0?
    2. 复用 gatherCycle 的本服 901 扫描结果
    3. canHelp 谓词过滤 → 选 oNum 最大点
    4. 发 2116 → 22072 push 刷新额度
```

事件唤醒：22072 push / 10007 回城 / curStageEndTime 到期全停。

### 4.5 赛季阶段闸（`stageGate`）

两层「阶段」互不蕴含：赛季级 `curStage`（`CQ26WLStatus`：1 开荒中 / 2 等待下次开荒 / 3 已结束）与分区级 `status`（`CQ26WLLandStatus`）。三腿原先只看分区 `status`，于是阶段 2 仍在空刷（实录：阶段 2 的 18 场里额度恒满、9380 个 316 点全部无主、零写动作）。落地口径三条：

1. **只有 `curStage===1` 出新网**（派兵 / 盗采 / 协助）。阶段 2/3 睡到 `curStageEndTime`（服务器秒差换算本地毫秒，实测见 21h+；22072 push 到货会 `kickAll()` 提前复查，故不需要给这段睡眠另设上限）。
2. **`curStage` 未知不挡**：快照在场但缺 `curStage` 键时 ACL 回 `null`（不得 `||0` 折成 0——枚举里没有 0，折出来会被判成「已结束」而整族停摆），`stageGate` 回 `{actionable:true, why:'unknown'}`，退回既有分区 `status` 判据继续跑。
3. **闸门排在两条在途路径之后**：采集腿的 `marchBusy()`（推进召回）与 `isGathering` 认领（`claimInFlightRound`）都在阶段闸之前跑完 —— 阶段跳变那一刻还在外面采的那一趟必须照常收回来，否则成熟产出裸奔给别人偷。盗采/协助是即时写、无在途账，阶段闸放在腿首。
   同一方向性铁律也约束**额度闸**（`todayCanGatherTime` 不够一轮）：它只决定「要不要再开新一轮」，不挡认领与召回，理由与实录见 §3.11。

判据是 `legs.js` 里的纯函数 `stageGate`（阈值由 `constants.js` 的 `WL_STAGE_*` 注入，保持 legs 层零符号耦合），单测见 `tests/feats/cq26-wl-mine.test.js` 的「只有开荒中(1) 放行」一条。

---

## 5. 用户配置项（采集区域）

只有一个总开关，采集/盗采/协助三腿不单独开关——各腿是否执行由额度闸门与矿种清单自然决定（额度=0 或清单全不勾则自动跳过）。

### 面板配置

每条腿区块头部显示当日额度进度（只读 `text` 字段，数据源 `cq26WlInfo()` 读 22072 快照，零额外请求）：

| 进度字段 | 格式                | 刷新时机              |
| -------- | ------------------- | --------------------- |
| 采集额度 | `剩余 12h30m / 16h` | 面板打开 + 22072 push |
| 盗采额度 | `已用 1/3`          | 同上                  |
| 协助额度 | `已用 0/3`          | 同上                  |

| 配置                  | 控件     | 默认        | 说明                                                                            |
| --------------------- | -------- | ----------- | ------------------------------------------------------------------------------- |
| `enabled`             | checkbox | off         | 总开关                                                                          |
| `gatherItemWhitelist` | tripick  | 4501+4502   | 采集腿矿种白名单                                                                |
| `stealItems`          | itemlist | 全勾选+不限 | 盗采腿矿种清单：勾选=要偷，逐矿种最低可盗量（oNum 门槛，0=不限，全不勾=腿不动） |
| `helpItems`           | itemlist | 全勾选+不限 | 协助腿矿种清单：同上（最低可协量）                                              |

采集腿**不设速率门槛**（11-12 废弃 `gatherMinSpeed`，用户口径：多余）：选点只过矿种白名单 + 本服无主 + 离主城最近，
`gatherSpeed` 不再参与任何判据（归一点仍携带该字段供观测，`canGather` 不读它）。旧存储里残留的 `gatherMinSpeed` 键由
`normalizeCfg` 的「未声明键不透传」自然丢弃，无需迁移。

### 分矿种最低量门槛（v3）

用户口径（11-12 纠正）：盗采/协助要的是**分矿种最低可盗/协量**（例：雷神矿脉 1400、矿山 78，点存量 oNum 达标才出手），不是分矿种每日次数预算。次数总额看「今日进度」的 `已用 x/3`（22072 快照，零本地记账）；逐矿种列「今日已用/每日上限」无必要，已撤。门槛是选点策略不是记账：只滤点、不计次，方向安全（只做「少动」），服务器共享总额度闸始终兜底。

- **控件**：盗采/协助腿的矿种清单（`itemlist`），每行 `[矿种] [最低量输入] [☑]`；未登记 = 默认勾选 + 不限（0），取消勾选 = 排除该矿种，**全不勾 = 该腿不动**（与采集腿 multiopts「空 = 不限」刻意不同）。采集腿仍 multiopts。数值列由 core itemlist 的 `numKey:'min'` 通用化承载（缺省 'max'，商店/秘境不受影响）。
- **闸门序**：服务器总额度闸 → 矿种清单闸（全不勾=腿不动）→ 游戏谓词（`canSteal/canHelp` 内按 `ctx.mins[itemId]` 逐点滤，归因 `onum-below-min`）。全区点都低于门槛 → pool 空 → 分区进 stealable=false 黑名单（与旧全局门槛行为一致）。纯推导在 `items.js`（`legPlan` → `{whitelist, mins}`）。
- **迁移**：`version 3`，`migrateItemLists` 同时折算 v1（白名单数组 + 全局 `stealMinONum/helpMinONum`）与 v2（`{on,max}` + 全局门槛，未发布但可能已本地落盘）：on 取已有条目 > 旧白名单 > 默认全勾；min 取条目自带值，否则取旧全局门槛（旧语义所有矿种共用 → 折算为每矿种初始门槛，行为等价）；v2 的 max 丢弃；四个旧键删除。幂等（落盘前每次读盘重跑收敛同一结果）。

### 内置常量（不暴露为面板配置）

| 常量                                | 值            | 语义                                                                                                                                    |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAIM_GAP_MS`                      | 300s          | 「标志说在采」时主动认领在途 315 行军的尝试间隔（认领要现扫分区，不能逐拍扫）                                                           |
| `CLAIM_STALE_MAX_MS`                | 15min         | 认领连续失败多久即把 `isGathering` 判为陈旧值（见 §3.10）                                                                               |
| `PROBE_GAP_MS` / `PROBE_GAP_MAX_MS` | 10min / 60min | 试探派兵的初始间隔与退避天花板（防废券风暴）                                                                                            |
| `TAIL_MIN_SEC`                      | 600           | 尾轮最少可采秒数：剩余额度低于此就不派了（见 §3.6）                                                                                     |
| `BOARD_REFRESH_SEC`                 | 300           | 2201 棋盘刷新周期（外部开分区无 push，纯轮询）                                                                                          |
| `RECALL_MARGIN_SEC`                 | 60            | 安全期撤回余量：在 `marchArrive + 7200 - 60` 发 2121，给网络延迟 + cycle 调度抖动留缓冲，防止点刚进入“可被偷”窗口时召回还没被服务器处理 |
| `MAX_ZONES_PER_TICK`                | 3             | stealCycle 单拍最多试几个分区                                                                                                           |
| `ZONE_MEMO_TTL_SEC`                 | 300           | 分区扫描结果缓存有效期（也是 stealable=false 黑名单时长）                                                                               |

---

## 6. 参考文件

- [acl-cq26-荒芜冰原.md](acl-cq26-荒芜冰原.md) — 19 协议完整字段字典
- [feat-荒芜冰原采集.md](feat-荒芜冰原采集.md) — 采集腿历史详细设计（wl-mine 前身）
- 录制样本：`dashcam/store/11981629951662/dashcam-rec-20261109T043951-*.ndjson`（15.5h 无棋盘 push）
- 游戏源码：`CQ26WLOpenBaseComponent`、`CQ26WLOpenMain`、`CQ26WasteLandData`、`CQ26Response`
