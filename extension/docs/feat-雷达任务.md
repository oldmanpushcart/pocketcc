# 雷达任务（radarTask）自动执行与领奖

日常 feat，实现体：[`src/feats/player/radar-task/index.js`](../src/feats/player/radar-task/index.js)（单文件）。
协议与判据的实录出处：雷达任务真人实录（3138 行，234 秒一场完整「三连环 + 普通任务」操作）。
竞品口径参考：`references/竞对逆向/竞品B/assistant/payload/server-js.js` 的 `helper["pro"]["misc"]["radar"]` 段。

## 1. 玩法口径（用户定稿）

- 雷达任务分两大类：**类一 每日三连环**（每天固定三条，报文里的 `day_group_events`）与 **类二 普通任务**（环上 `events`，种类随任务池刷新）。
- **同一时间只能执行一个任务**——这是用户对自动化的口径，不是游戏硬约束（真人录制里可见并行发起多条 40001 求援，见 §6）。feat 侧按单飞锁 `exec` 严格串行。
- 部分任务需要派兵（黑暗军团据点、三连环里的扫荡/集结位），故面板要能指定出兵预设。
- **体力闸（用户定稿）**：执行任务要消耗体力，体力低于下限即**暂停任务执行**（认领与出兵一起停），下限做成面板可配项；体力不足期间**继续领奖**（领奖不扣体力）；**不做**体力不足自动补药。
- **雷达防御（干扰攻击）已纳入**（面板 `doDefend`，独立开关）：任务全清后黑暗军团会打一次雷达，一键击退（3515）不派兵、不扣体力，打完功率顶满格 → 下一次截取必为 5 星，且干扰攻击每日至多 1 次。
- v1 范围仍不含活动雷达/联盟组任务（§7）。

## 2. 协议表（全部老 `send` 通道，无 PBV2）

| cmd   | 名称                            | req                                                                                                                            | resp 关键载荷                                                                                                                                                                                        | 实证                                                    |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 3504  | RadarGetInfo                    | `{clearFinishNotify:1}`                                                                                                        | `events[]` / `day_group_events.day_group_events[]` / `group_events.group_events[]` / `act_radar_events[]` + 标量 `taskPoolSurplusNum` `scaned` `nexRefreshtTime` `sign` `radarLevel` `currFinishNum` | 录制内 19 次，真人每轮点开雷达都重发                    |
| 3505  | RadarStartTask                  | `{id}`（实例 id，**裸 number**）                                                                                               | **同名扁平数组**（`events` 或 `day_group_events`，非两层嵌套），该任务 `state 0→1` 并回填 `x/y`                                                                                                      | 18 次，全部命中                                         |
| 3508  | RadarGetReward                  | `{id}`                                                                                                                         | `{reward:{items[],resource,…}}`                                                                                                                                                                      | 41 次，串行间隔实测 ~0.8–1.1s                           |
| 3515  | RadarDefend                     | **`{}` 恒空体**（不带 id/坐标）                                                                                                | `{sign}`（击退即把功率顶满格）                                                                                                                                                                       | 1 次（触发推送后 4s，`s=0` 受理）                       |
| 902   | MARCH_WORLD_POINT               | 带兵 `marchType=62`（canonical 十键）/ 零部队 `marchType=64\|67\|200`（**八键**）                                              | `marchInfo.marchId`（**十进制字符串**）`marchType` `state=1`                                                                                                                                         | 13 次                                                   |
| 1201  | ALLIANCE_Assembly_Create        | `{marchType:8,x,y,time:60,armyList,armyListNew,heroList,trapList,formation:0,formationV2}`（十键，**无** `break`/`extraArmy`） | `marchInfo.marchId` `state=8`                                                                                                                                                                        | 5 次                                                    |
| 20013 | RADAR_STATUS_CHANGE             | —                                                                                                                              | 载荷**即**单任务事件对象（`{id,taskId,state,x,y,…}`）                                                                                                                                                | 44 次                                                   |
| 20015 | RADAR_ADD_ONE_TASK              | —                                                                                                                              | `{optionType,events[]}`（领奖后同 id 消失 + 新 id 补位成对出现）                                                                                                                                     | 67 次                                                   |
| 20016 | RADAR_OTHER_DATA_CHANGE         | —                                                                                                                              | 纯标量（`taskPoolSurplusNum` 等），无任务事件                                                                                                                                                        | 67 次                                                   |
| 20021 | PUSH_RADAR_SIGN                 | —                                                                                                                              | `{sign,deBeginTime}`（`deBeginTime>0` 即干扰攻击进行中，被推回 0 即服务器已自清理）                                                                                                                  | 40 次，其中仅 1 条 `deBeginTime` 非 0                   |
| 20025 | RADAR_RING_CHANGE               | —                                                                                                                              | 载荷即单任务事件（三连环在途/完成也走这条）                                                                                                                                                          | 6 次                                                    |
| 20026 | RADAR_DAYGROUP_EVENT_NUM_CHANGE | —                                                                                                                              | `{optionType,events[]}`：链推进（旧条 `state=4` + 下一条 `state=0` 同批下发）                                                                                                                        | 5 次                                                    |
| 10021 | PUSH_ENERGY                     | —                                                                                                                              | `{type,point,pointMax,restoreSec,restorePoint,reason,buyTimes,syncTime}`；体力池 `type=1`（`EnergyType.Action`），`reason` 即本次扣减来源枚举                                                        | 雷达任务实录 18↔18 / 日常任务实录 3↔3（合计 21 条 1:1） |

**形态纪律**（写码/对拍都必须吃双形态）：`day_group_events` 在 3504 应答里是 `{day_group_events:[…]}` 两层嵌套，在 3505 应答里是同名扁平数组 —— feat 的 `applyPayload()` 与 manifest 的 `eventsOf()` 同口径兼容。

**体力扣减点实证**（两份真人实录交叉验证：雷达任务场、日常任务场）：只有**出兵那一下**烧体力（推送紧跟 902/1201 那一下 36~66ms；而 readonly 之后最近一条推送至少隔 740ms，日常任务场 899ms），**3505 认领、3508 领奖与 3515 击退全场无一条体力跟随**（3515 那笔前后 ±15s 内零条 10021）；实测单价 `RADAR_MONSTER=8`（带兵攻打）、`ALLIANCE_RALLY_BATTLE=8`（集结）、`RADAR_ASSIST` 跌幅观测 {4,5} 取上界 5（差值被一次不回推的自然回体稀释 1 点）、`RADAR_RESCUE` 亦扣减（零部队求援档，无基线故单价未定）。体力池 `pointMax=275`、自然回体 `restoreSec=360 / restorePoint=1`（6 分钟 1 点），且**自然回体不一定推 10021**——阻塞时不能只等推送唤醒。

> 样本空白：两份录制里 21 条体力推送**全是跌幅、0 条回升**，所以「点数回升才唤醒」这条路径目前只有单测覆盖，尚无实机样本；待录到含自然回体/用药的录制才算端到端验证。

## 3. 任务状态机（`event.state`，报文实证）

```
0 待认领 ──3505──> 1 已认领（应答回填 x/y）──902/1201──> 2 进行中 ──┐
                                                                  ├─> 4 完成待领 ──3508──> 条目移除 + 20015 补位新任务
                           （211/208 型经 3 需二次动作）3 ─────────┘
```

- `state=3` 只在 **211 玩家求援**（40001）与 **208 搜怪型**（真人实录无）出现：3505 认领后应答直接给 `state=3` 并带坐标，再发一次零部队 902 才转 2。
- 三连环的推进由 20026 驱动：`optionType:1` 携旧条 `state=4`、`optionType:2` 携下一条 `state=0`，两条同批到达（实测 25.0s / 45.8s / 77.9s 三次）。
- 即时/条件完成型（4178/4180/4181/10000/10022/10024/10031/10032/10034/10035）进场即 `state=4`，唯一动作是 3508。

## 4. type 分派表（`radar_event` 按**事件实例 id** 反查 + 读数面不可用时才兜底经验表）

**查表键 = `event.id`（实例 id），不是 `taskId`。** 权威口径三处独立实证：游戏 `RadarTaskPrefab.initData`（`getTableDataById(TableName.radar_event, String(this._eventId))`，`_eventId` 即实例 id）、`RadarController.askBeginTask`（用 `String(e)`，e=实例 id 分派 206/207/208）、竞品 B `server-js.js:19868`（`getTableDataById(TableName.radar_event, e["id"])`）。`taskId` 是**另一张表** `radar_task` 的键（`name/des/cost_energy/condition_num`），两表同号不同物：拿 taskId 去查 `radar_event` 会命中一个恰好同名的槽位行，读到错 type 就发错包（线上事故见 §9）。

兜底纪律：只有 `l10n.tableReady()` 为假（游戏 bundle 未就绪的早期窗口）才按 taskId 走录制经验表 `TASK_TYPES`；**表可读但该槽位无行 → `type=0`（未知），本拍不发包**——少做一个任务的代价远低于发一个错包。`TASK_TYPES` 只是「某场录制里这些 taskId 恰好落在这些动作」的快照，不是权威映射。

type 全集（游戏 `RadarController.beginMarch`/`askBeginTask` 列出）：201/202/203/204/205/206/207/208/209/211。

| type | fromState | 动作          | 线上形态                                                             | 经验表兜底 taskId（仅录制快照）               |
| ---- | --------- | ------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| 201  | 1         | `attack`      | 902 `marchType=62` 带兵（`march.attack` canonical）                  | 10004（三连环扫荡位）                         |
| 202  | 1         | `rally`       | 1201 `marchType=8,time=60` 带兵集结                                  | 10002（三连环集结位）、10001（黑暗军团据点）  |
| 203  | 1         | `zero`        | 902 `marchType=64` 零部队八键                                        | 真人实录无（枚举取自游戏 MarchType 逆向）     |
| 205  | 1         | `zero`        | 902 `marchType=67` 零部队八键                                        | 10003（三连环援助位）                         |
| 211  | 3         | `zero`        | 902 `marchType=200` 零部队八键                                       | 40001（玩家求援，`extData.p` 带被援玩家 uid） |
| 208  | 3         | `unsupported` | v1 不做（需 906 搜怪再打，无真人实证）                               | 真人实录无                                    |
| 204  | 1         | `unsupported` | 零部队据点应发 `marchType=65`（RADAR_MARCH_COUNTRY），真人实录零样本 | 真人实录无                                    |
| 206  | —         | `unsupported` | 剪线小游戏（`WireCutPanel`），非发包可完成                           | 真人实录无                                    |
| 207  | —         | `unsupported` | 密码验证小游戏（`CodeCheckPanel`）                                   | 真人实录无                                    |
| 209  | —         | `unsupported` | 仅倒计时规则引用（`RadarTaskPrefab` 里只影响 label）                 | 真人实录无                                    |

零部队八键 body（与 `march.pickUp` 的九键 `ext` 形态**不同**，故 feat 直发）：
`{marchType,x,y,armyList:[],armyListNew:[],heroList:[],trapList:[],formation:0}`。

## 5. feat 实现要点

- **控制模式**：A 族 `createCycle` 电平调和（归类见 [feat-控制模式归类.md](feat-控制模式归类.md)），全部触发源汇入 `cycle.kick()`。
- **账本**：`Map<id串, {id,taskId,state,x,y,dayGroupId,groupType,endTime}>`，真相源只有 3504/3505 应答与四条任务推送；feat 只读 + 发包，绝不写游戏对象。**推送有双形态**：20013/20025 的载荷本身就是一条裸事件（顶层 `{id,taskId,state,…}`），20015/20026 才套 `events` 数组——入账必须走 `applyPushPayload`（内部用 `isTaskEvent` 分辨），只读数组会把「完成待领」全丢。
- **为什么这条形态差异是命脉**：实录实证 50 条 20013/20025 无一例外是裸事件（state=4 有 32 条），36 个首见 `state=4` 的实例里 **27 个只能从这两条通道看到**（第二份录制 19 个里 10 个）。只读数组的写法会让账本永远停在 `state=1`：既不领奖（`claimable=0`），又每拍重选同一条反复出兵吃 `code=3`——已踩过并在线上跑了一整夜（实录上送日志：`id=3145` 每 15s 一条 reject，`pending=10` 全夜不动）。
- **类型解析接线**：`resolveType(evt, l10n.tableRow, l10n.tableReady())` 吃的是**账本条目本体**（含实例 id），`pickCandidate` 与 cyclePass 的 unknown/unsupported 遍历都走同一个 `resolve(t)`；任何一处退回传 `t.taskId` 都会重演「按错键查表」，故单测与对拍都断言了 resolve 收到的参数含 id。
- **单轮顺序**：`3504 对拍（首拍/漏推兜底）→ 雷达防御击退（3515）→ 释放已达终态的单飞锁 → 领奖 → exec 在途判（在途仍推认领）→ 体力闸 → 选候选 → 执行一步`。领奖与执行解耦：任何 `state=4` 都可领，不需要 `type`，也不受体力限制；且**领奖在选候选之前**，所以「有未完成就先去打」这种抢拍不会发生（`cr.left>0` 直接 return，`state=4` 的任务也永远不会被 `pickCandidate` 选中——它只收 `state∈{0,1,3}`）。**防御排在全部早返回之前**：它的触发前提恰恰是「任务已全清」，若排在 exec 在途/体力闸那两条 return 之后就永远碰不到，会错过当日唯一一次机会。
- **体力闸**：读 `gameData.energy(1)`（ACL 镜像），`point < max(1, minStamina)` 即本轮 return、不认领不出兵。默认下限 `8` = 实测最贵一档单价（带兵/集结各 8）；面板配 0 也强制抬到至少 1 点，保证「耗尽必停」不被误关；上界靠 `normalize` 钳到 `minStaminaCap=100`（number 渲染器不吃 `fd.max`，钳在面板外会静默永不派兵）。阻塞时下拍精准睡到 `nextRecoverSec` 回点（`energyWakeMs`：+3s 缓冲，钳 [5s, 1h]），不只依赖推送唤醒；长睡前先看 `cycle.pending`——本轮在飞期间到达的触发只置 pending、内核 `arm()` 不提前醒，故补一次空拍（零发包）把 pending 收掉，否则刚推到 `state=4` 的奖励要等一个回体窗才能领，偏离「继续领奖」口径。镜像读不到（`energy()` 返回 null）归 `mirror` 档，本轮不动、下拍按 `activeScanMs` 重判。唤醒只认 10021 的**点数回升**（出兵自身会推 10021，不过滤方向会形成「动一下→被推→再踢一轮」自激，同 alliance-behemoth 教训）。
- **体力镜像异常告警**：真耗尽（`point=0` 且池存在）是用户要的正常暂停态，留 debug；但 `energy()` 返回 null、`pointMax` 读成 0、以及**镜像说 0 而最近一条 10021 说 >0**（`gameData.energy` 的 `Number(e.Point) || 0` 会把 getter 改名伪装成耗尽）三种「读不通」会让整条玩法停摆，本场首条升 warn（latch 防刷屏，`run()` 复位）。
- **候选排序**：`stalls`（停滞次数，升序）→ `day_group_id` 降序 → `quality` 降序 → `id` 升序。三连环靠 2026 逐个解锁，池里同时只有一条 `state=0`，故原排序足以保证链序 21→22→20 推进；但 `day_group_id` 降序有个反噬：一条「派了没做成」的三连环位会**永远排在最前**、把其余候选饿死（实录上送日志：3147 被重派 4 次、`pending=9` 全程不动），故加 `stalls` 作首键。不带该字段的调用方（领奖排序）等价于 0，行为与旧口径逐字一致。
- **单飞锁**：只锁「执行」（902/1201）；动作受理即 `lockExec`，释放只认账本状态跃迁（进 4 / 条目消失 / 回滚到 0/1），不轮询行军列表。**认领（3505）不占行军槽、不扣体力、不置锁，因而在途期间照旧逐拍推进**（`claimStartsWhileExec`，每拍最多 1 条，仍过体力闸）——旧版把认领也吞在 `exec` 早返回里，是「雷达久久不执行」的直接成因。
- **在途择时**：首次对拍按集结窗到期 `execPollMs`(90s=窗 60s+缓冲 30s) 即醒——窗一过就能发现解散并换候选；确认仍 in-flight（真在行军路上）才降到 `execResyncMs`(4min) 低频档。取代旧版固定 240s（实录上送日志里 4 笔重派的间隔实测 73.6/300.1/300.1s）。
- **停滞止损（与拒因退避并列的第二类死循环）**：`s=0` 受理但账本回滚到可派态（集结窗到期被服务器原地解散、任务态 2→1）走不到「被拒计数」，故按 dispatch 收尾单独记账：`endExec('rollback')` 累加 `stalls`，达 `dispatchStallLimit`(2) 即当日让位该实例（`stallYield`，与 `rejectBlacklist` 合并后喂给 `pickCandidate`；跨日清）。判定前置于 `dispatchSettleMs`(10s) 沉降窗之后——派兵那一刻账本还是 `state=1`，engage 推送（→2）实测 <100ms 才到，抢在推送前判会把正常派兵误计成停滞。让位/停滞**都只挡 dispatch、不挡领奖**，误判不会锁死奖励。
- **雷达防御闸 `defenseGate`**（纯决策，单测与对拍直驱）：`doDefend` 开 + `deBeginTime>0`（触发时刻）+ 该时刻未受理过 + `sign<5` + 连续被拒未达 `rejectRetryLimit` + 战力 ≥ `PLAYER_LEVEL[等级].att_new`（`combat_power_v1` 为假时取 `att_old`；该开关判定不到时按游戏面板本身取 att_new）才发一笔空体 3515。幂等键 = **触发时刻 `deBeginTime` 本身**，落 `storage.data['radarTask.stats'].defendKey`，扩展重载不重发；`deBeginTime` 被推回 0 即服务器已清理本次攻击，自然停手——**故不本地估窗**（估窗要引配置 4000034 与服务时钟差，收益不抵风险）。战力/门槛任一读不到一律不发（fail-closed）；连续业务拒达 2 次即锁死该次触发（干扰攻击每日至多 1 次，反复撞日限只会刷日志）；`CODE_NOT_SENT` 不计拒。竞品 B `server-js.js:19892` 同条另加 `radarSignNum <= 3`，那是给 3517「免费增强信号」留位——本 feat 不做 3517（会花钻石），故只按 `sign<满格` 放行：击退本身就是把功率顶满，早做晚做都是净收益。
- **`deBeginTime` 的归一口径**：走 `normalizeDeBeginTime` 而**不走其余标量那档 `|0`**——它是秒级 epoch（实测 1793896015），一旦被 ToInt32 截断就变成负数，闸永不放行且零日志线索（本仓踩过同类截断坑）；3504 全量、20016、20021 三源都带该键，`applyScalars` 只在本条载荷带它时才覆盖。
- **派兵闸门**：`doMarch` 关 / `preset=0` → 带兵型不选（`gated` 归因 `no-preset`）；`march.freeSlots()<=0` 或预设无兵 → 本轮不派，等回城边沿唤醒。
- **频控**：3508 串行 + 1.2s 间隔，单拍封顶 10 条（剩余下拍续），源自 NetMgr 按 cmd 频控吞连发的教训。
- **拒因退避（防逐拍死循环）**：发送结果统一三态 `SEND_OK|SEND_REJECTED|SEND_NOT_SENT`——本端在途闸/桥断（`CODE_NOT_SENT`、`march.NOT_SENT`）**不算**服务器拒绝，不计数也不拉黑。同一「实例 id + 动作」连续被服务器拒达 `rejectRetryLimit`(2) 次即当日拉黑该实例（`rejectBlacklist`，`pickCandidate` 跳过；跨日清）并立即 3504 重拍。两道缺一不可：不拉黑就是 15s/拍整夜重发且它按 `candCmp` 恒排最前、把其余候选饿死；不重拍则「拒」的真正成因（本地账本陈旧）无法自愈。拉黑只挡执行不挡领奖（`claimFinished` 不看名单），所以误拉不会锁死奖励。
- **归因日志**：每轮出口一条 `pass done. reason=…; pending=…; claimable=…; exec=…; pool=…; stamina=…; blacklist=…; yield=…; defend=…; sign=…; deBegin=…`，reason ∈ `claim/exec/start/dispatch/rejected/not-sent/no-queue/no-troops/no-preset/no-stamina/no-energy/skip/idle/pool-empty/no-sync`（`no-stamina`=低于下限、`no-energy`=镜像读不到、`not-sent`=本端在途闸吞掉、`blacklist`>0 即说明有目标被当日拉黑、`yield`>0 即有目标因「受理却没做成」而让位）。停滞侧另有两条 info：`dispatch rolled back without progress`（记数）与 `task yields today (accepted but never progressed)`（让位）。`defend=` 是防御闸的归因（`off/no-trigger/handled/full/reject-limit/no-reading/weak/fire`），`deBegin=` 是当前触发时刻；击退成功/被拒/锁死各自还有一条独立日志（info/debug）。
- **面板**：`doDaily` / `doEvents` / `doMarch` / `doDefend`（label `雷达防御`）四 checkbox + `minStamina`（number，label `体力下限(低于即停·0按1)`）+ 一行 ctrlrow（战斗预设 0~8 单选 | 今日已领只读）；number 渲染器不吃 `title/hint/max`（`core/ui/fields.js` 的 `renderNumber` 只吐 min/step/placeholder/value），所以关键口径写进 label（同 auto-hunt 的写法）；当日记账落 `storage.data['radarTask.stats']`（`{day,claimed,defendKey}`），跨日归零。
- **今日已领只是一个计数，不是配额**：该格只报 `claimed`（今日 3508 成功次数）。本 feat **不存在任何按日封顶的逻辑**；首版曾按「领奖次数/完成数」两个计数器显示，但二者在同一成功分支里同增、永远相等，`N/N` 会被读成「每天只做 N 个」，因此删掉冗余的 `finished` 计数器、只留单值（title 文案里显式写「无每日上限」）。

## 6. 与真人录制的差异（feat 更严之处）

录制里 11 次「认领时另有任务在途」——真人把 8 条 40001 求援并行发出。这是玩家体验层面的自由，不是服务端约束；feat 按用户口径串行执行，因此该维度在 replay 里记为**软判据（观察，不判负）**。

## 7. v1 边界（明确不做）

| 项                          | 出处                                                                                | 不做的原因                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 3517 RadarStrength 增强信号 | 竞品 B `server-js.js:19897`（`sign==4 && getNowStrengthPrice()==0` → 每日首次免费） | 会花钻石（仅每日首次免费），属另一条授权口径；本 feat 不碰，面板也不给开关                                                                      |
| `act_radar_events` 活动雷达 | 3504 应答恒 `[]`                                                                    | 真人实录无样本，无逐键依据不发                                                                                                                  |
| `group_events` 联盟组任务   | 3504 应答恒 `{group_events:[]}`                                                     | 需联盟协作语义，v1 不碰                                                                                                                         |
| type=208 搜怪型             | 竞品 B 有、真人实录无                                                               | 需 906 搜点 + 再打，无实证 body，首遇 warn 后当日跳过                                                                                           |
| type=204/206/207/209        | 游戏 `beginMarch`/`askBeginTask` 列出                                               | 显式列入 `UNSUPPORTED_TYPES`：204 需 `marchType=65` 零样本、206/207 是小游戏面板、209 只是倒计时规则。宁可跳过 + 当日 latch warn，也绝不猜 body |
| 主动扫描刷新任务池          | 录制内无 3506/3507 类报文                                                           | 不自造协议，只被动跟随 `nexRefreshtTime` 与推送                                                                                                 |

## 8. 验证

- 单测：[`tests/feats/radar-task.test.js`](../../tests/feats/radar-task.test.js)（normalize 四开关 / applyEventTo / **resolveType 查表键契约**（实例行为权威、taskId 撞号不误读、表无行 fail-closed、仅 tableReady=false 走经验表）/ actionFor 分派与 `UNSUPPORTED_TYPES`(204/206/207/209) 名单 / candCmp 排序 / pickCandidate 闸门与 latch（含 resolve 收到条目本体含 id）/ pickCandidate 拉黑不选中 / staminaGate 下限与配 0 回归 / energyWakeMs 上下限 / isTaskEvent 双形态（拿录制真实 20013 样本作 fixture）/ **normalizeDeBeginTime 超 Int32 不截断** / **defenseGate 八分支与 fail-closed 短路次序** / **stallStep 只计 rollback 且达阈即让位（finish·gone 归零）** / **cfg 止损与择时三键口径互斥锁死（沉降窗<集结窗<首拍对拍<低频档）** / **candCmp stalls 首键（无该字段时与旧口径逐字一致）** / **pickCandidate opts.stalls 注入降权** / **pickCandidate onlyStart 只放行认领**，18 项）。
- 录制对拍：[`scripts/verify-manifests/radar-task.mjs`](../../scripts/verify-manifests/radar-task.mjs)，`npm run verify:radar-task`。HARD 维度全过（雷达任务实录 / 日常任务实录）：请求体形态 77/27、行军坐标来自认领回填 18/3、type→动作分派对齐 18/3、**radar_event 查表键 = 实例 id 40/32**、3508 当场 `state=4` 41/21、**完成即领 36/19**、**停滞止损（dispatch 无完成证据不得超止损阈重派）18/4**、**推送形态契约 122/56**、3505 当场 `state=0` 18/3、**3515 恒空体且发包前必有 `deBeginTime>0` 2/（日常任务实录无 3515 → 无法判定 1）**、**defenseGate 与真人击退对齐 129/60**、**体力闸前提（认领/领奖/击退不烧）78/27**、Int64 形态 19/5。
  - 「查表键契约」用录制里真实的 (实例 id, taskId) 对驱动 `resolveType`，桩表**只对实例 id 返回权威行（quality=5 指纹）、对 taskId 返回毒药行 type=205**，并断言：查询轨迹恰为单次 `radar_event|<id>`、读到的不是毒药行、表无行时 type=0（fail-closed）、兜底轴仅在 `tableReady=false` 生效。已做变异实测：把 feat 的查表键改回 taskId 后，该维度雷达任务实录 36 违例 / 日常任务实录 28 违例、退码 1（单测同步 FAIL）。
  - 「完成即领」是这次新增的反向断言：凡录制里首见 `state=4` 的实例，后续必须出现同 id 的 3508。旧版只有正向的「3508 时 state=4」，所以 feat 漏收裸事件推送时对拍仍全绿——单靠正向断言封不住这类 bug。
  - 「推送形态契约」把 `isTaskEvent` 当判据直接跑线上形态：20013/20025 应全为裸事件、20015/20026 应全为数组集合，任一侧翻转即 FAIL（改版后提醒重设入账判据，而不是静丢）。附带归属指纹观察（`dg/rgt/gid`）：两份录制里裸事件 `group_id` 恒 0，全在 v1 范围内。
  - 入账判据单一真相源：manifest 自己的 `eventsOf` 已改为 import feat 本体的 `isTaskEvent`，不再抄一份本地写法——本次 bug 正是「对拍侧抄对了、feat 侧自己写了一份」造成的分叉。
  - 体力新维度只把「readonly（3505/3508/3515）后紧跟一条**跌幅**体力推送」计 FAIL（这是闸位的承重前提，违例则须重设闸位；3515 归入 readonly 正是「防御不插体力闸」这一设计的事实依据）；回升/持平推送（自然回体或用药）不是烧体力，不计违例；「出兵缺跟随」计无法判定（不推翻闸位安全性）。窗口分级：readonly 用 300ms 窄窗（推送实测紧跟出兵 36~66ms，而真人「认领→出兵」至少隔 740ms，宽窗会把出兵那条算到认领头上）、dispatch 用 1500ms。
  - 「停滞止损」是第二条反向断言（本轮新增）：先把 `902/1201` 按最近一次 3505 回填的 `(x,y)` 归属到实例（`claimByPos`），再把 dispatch 与 `state=4` 合成一条时间轴，**同一实例在无完成证据下的连续 dispatch 峰值 > `cfg.dispatchStallLimit` 即 FAIL**；归属不到的 dispatch 一律记「无法判定」而非「无违例即通过」。阈值由 manifest 直驱 feat 导出的同一个 `stallStep` 做同源自检，两份真人录制实测 `最大无进展重派=1`（PASS）。
  - 该维度的变异实测：拿改版前带 bug 的引擎真人实录跑对拍 → 退码 1、`❌ FAIL … [通过 12｜违例 1｜无法判定 5]`，命中 `id=1099009 taskId=10001 无完成证据下连续 dispatch 3 次 > 止损阈 2`——即该断言确实钉得住本轮修的回归，不是恒绿维度。
  - 该 manifest 的协议字典直接 import feat 本体（最小桩化浏览器全局），守住「判据不与 feat 分叉」；应答配对按 `raw.s` 自建（内核只认 PB 形态的 `data.header`）。
  - **防御两个维度的取数口径**：`signTimeline` 是与 feat 的 `scalars` 同构的**累计**视图（3504 全量/20016/20021 三源只各自带 sign 或 deBeginTime 中的一两个，若每条都当全量读会把「上一条刚报过的触发时刻」误当成 0 → 防御维度全盘假 FAIL）；`defenseGate` 维度拿录制当时的标量快照直驱 feat 导出的同一个闸，战力桩为「达标」（离线拿不到 `PLAYER_LEVEL` 表，门槛本身由单测钉住）。
  - 防御维度已做变异实测（四个变异均退码 1、对应维度 FAIL）：`normalizeDeBeginTime` 恒返 0（模拟 deBeginTime 不入账）→ 两个维度同收（真人发了 3515 而我方闸 `no-trigger`）；满格判定收紧到 `sign<=3`（照抄竞品）→ 正向 FAIL（真人 sign=4 仍发）；摘掉 `no-trigger` 闸 → 反向 2 共 124 条违例；给 3515 请求体添一个 `id` 键 → 空体契约 FAIL。日常任务实录无 3515（真人未遇干扰攻击）→ 该维度记「无法判定 1」，不伪 PASS。

## 9. 变更记录

- 2026-11-06 首版：类一/类二分派、单飞串行、领奖解耦、v1 边界如 §7。
- 2026-11-06 体力闸：新增 `staminaGate`/`energyWakeMs` 纯函数、面板 `minStamina`（默认 8、配 0 抬到 1）、10021 方向过滤唤醒、`no-stamina`/`no-energy` 归因；对拍加「体力闸前提」维度（两份录制均 PASS）。
- 2026-11-06 登录现场反馈修复「完成不领奖 + 反复派兵」：根因是 20013/20025 的载荷为**裸任务事件**，而 `applyPayload` 只读 `events`/`day_group_events` 数组，50 条状态推送全被静丢（其中 32 条 `state=4`）——账本永停 `state=1`，于是 `claimable=0` 且每拍重选同一条吃 `code=3`。修：新增 `isTaskEvent`/`applyPushPayload` 双形态入账（manifest 改为 import 该判据）；发送结果改三态，本端未发出不再误计为拒；同一实例同一动作连续被拒 2 次即当日拉黑 + 立即 3504 重拍（只挡执行不挡领奖）；`syncExecLock` 提到领奖之前，已达终态的单飞锁当拍释放即可领。新增两个 HARD 对拍维度（完成即领 / 推送形态契约）+ 两项单测（isTaskEvent 双形态、pickCandidate 拉黑）；归因行加 `blacklist=`，reason 加 `not-sent`。
- 2026-11-06 面板计数修正：用户反馈「1/1」被误读为每日只做 1 个。查明 `claimed`/`finished` 同分支同增永远相等（全仓无任何日上限逻辑），故删除 `finished` 计数器与落盘键，「今日已领」改报单值，title 写明「无每日上限，0 点归零」。
- 2026-11-06 评审修复（m1–m5 + M1/M2）：长睡不再吞 `cycle.pending`（补一次零发包短拍）；`minStamina` 增 `minStaminaCap=100` 上界钳；体力镜像「读不通」本场首条升 warn（含 `Point` 被伪装成 0 的交叉校验）；面板 label 承载「0 按 1」口径（number 不渲染 title/hint）；对拍 readonly 归因只认跌幅推送；注释/文档的实测数值改准（推送 36~66ms、两份录制合计 21 次派兵、`RADAR_ASSIST` 取上界 5）。
- 2026-11-06 雷达防御（干扰攻击击退）：用户追问「之前的录制报文和竞品 B 都提到的『防御』是什么、做了么」，取证定论为 `3515 RadarDefend`（req 恒空体 `{}` → resp 只有 `{sign}`；游戏 `RadarMainPrefab` 见 `radarDefendStartTime` 非 0 才亮入口、`RadarDefPop` 拿 `PLAYER_LEVEL[等级].att_new` 作门槛置灰按钮；雷达任务实录唯一一笔完整时序：最后一条 3508 领完 → 20021 `{sign:4,deBeginTime:1793896015}` → 4s 后 3515 → `resp {sign:5}` → 20021 `{sign:5,deBeginTime:0}`，且该笔前后 ±15s 零条 10021 → 不扣体力不派兵），而我方一行代码都没。修：`deBeginTime` 进 `scalars`（走 `normalizeDeBeginTime`，刻意不走 `|0` 以免 ToInt32 截断）+ 纯函数 `defenseGate`（八分支 fail-closed）+ `defenseNeedPower`（ACL 取 PLAYER_LEVEL 与 `combat_power_v1`）+ `tryDefend`（幂等键=触发时刻、落盘 `defendKey` 跨重载不重发、连续拒达 2 次锁死该次触发、`CODE_NOT_SENT` 不计拒）+ 面板 `doDefend`（缺省开）+ 归因行加 `defend=`/`sign=`/`deBegin=`；防御排在 `cyclePass` 全部早返回之前（它的前提恰是「任务已全清」）。新增两个 HARD 对拍维度 + 一项新单测（共 13 项）并做四个变异实测；3515 从 §7 排除表移出，3517（会花钻石）补入排除表。
- 2026-11-06 错查表键修复（消除残余 reject）：实录上送日志显示上一版上线后仍有 `taskId=10001`（黑暗军团据点）的实例发 `902 marchType=67` 吃 `code=3`，连续 2 次后当日拉黑、其余任务正常——拉黑只兜住了循环，**错包本身不在预期**。交叉取证定论：① 真人录制里 taskId=10001 的动作恒为 `1201 mt=8` 集结（发 67 的是 10003）；② 游戏 `RadarTaskPrefab.initData`/`RadarController.askBeginTask` 与竞品 B `server-js.js:19868` 三处一致地用**事件实例 id** 查 `radar_event`（taskId 是 `radar_task` 的键）。根因：`resolveType` 拿 taskId 当查表键，10001 命中同号不同物的槽位行 type=205 → 据点被派成零部队援助；更痛的是上一轮加的 `l10n.tableRow` 早于 TASK_TYPES 生效，把本来正确的经验表兜底（10001→202 集结）反而盖掉了。修：查表键改 `evt.id` + 表可读无行时 fail-closed（type=0 不发包）+ 经验表仅在 `l10n.tableReady()===false` 时兜底 + 把 v1 不做的 204/206/207/209 从隐式提为显式 `UNSUPPORTED_TYPES`（归 unsupported、当日 latch warn、绝不猜 body）；`pickCandidate`/cyclePass 三处调用改传条目本体。新增一个 HARD 对拍维度与三组单测断言（并做变异实测确证能粘住回归）。
- 2026-11-07 「久久不执行」四处修法：用户要求分析凌晨两小时的实录上送日志与对应报文会话，诊断雷达为何长时间不动。取证定论为两类成因叠加：① **认领被 exec 早返回吞掉**——一条集结占锁的 11 分钟里 9 条 `state=0` 任务 0 笔 3505、0 笔 3508（`exec` 把「不占行军槽、不扣体力」的认领也无谓地挡了）；② **受理却没做成的死循环**——同一条 3147（taskId=10001 黑暗军团据点）在 639s 内被重派 4 次，行军态序列恒为 `8→4`（真人是 `8→1→3→4`，即集结在 60s 窗内被原地解散）、任务态 2→1 回滚，这类 `s=0` 走不到「被拒计数」，而 `candCmp` 的 `day_group_id` 降序又让它恒排最前把其余候选饿死；另有第三因：在途固定睡 240s（实测重派间隔 73.6/300.1/300.1s），解散了也要再等 4 分钟才看见。修四条：**①认领解耦** `claimStartsWhileExec`（exec 在途时逐拍仍推 3505，每拍至多 1 笔、仍过体力闸，`pickCandidate` 新增 `opts.onlyStart` 只放行 `act==='start'`）；**②停滞止损** `syncExecLock` 重写为四终局（进 4 / 条目消失 / 沉降窗 `dispatchSettleMs`(10s) 后回滚 / 仍在途保持），回滚经纯函数 `stallStep` 累加 `stalls`，达 `dispatchStallLimit`(2) 即当日让位（`stallYield`，与 `rejectBlacklist` 合并喂给 `pickCandidate`；只挡 dispatch 不挡领奖，跨日清）；**③排序降权** `candCmp` 加 `stalls` 升序作首键（不带该字段的调用方等价 0，领奖排序与旧单测逐字不变）；**④在途择时** 两档唤醒——首拍 `execPollMs`(90s=集结窗 60s+缓冲 30s) 窗到期即醒，确认仍在途才降 `execResyncMs`(4min)，并删除旧版 `exec.since = Date.now()`（since 现恒为首次 dispatch 时刻，沉降窗判定才成立）。新增 5 项单测（共 18 项）与一个 HARD 对拍维度「dispatch 无完成证据不得超止损阈重派」，两份真人录制全绿（`最大无进展重派=1`）、改版前的 bug 录制退码 1 命中该维度；归因行加 `yield=`，并新增两条 info（`dispatch rolled back without progress` / `task yields today`）。遗留未定论：**集结为何被原地解散**（深夜联盟无人加入 vs 载荷兵型阵位不被接受）本场证据仍不足，本轮属「止损 + 让位」而非治愈该因。
