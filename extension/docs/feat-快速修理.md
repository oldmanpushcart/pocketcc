# feat · 快速修理（`quickRepair`）

> 代码：[`src/feats/player/quick-repair.js`](../src/feats/player/quick-repair.js)（单文件）· 面板：玩家设置 → **快速修理** · 形态：`createCycle` 电平调和 + push 即时唤醒（与 `armory-material` / `potion-craft` 同族「只读+发包」日常 feat）。
> 报文实证：印石日常真人实录·清批场（普通医院·真人一笔 `amount=9` 清空 15 条在修）· 印石日常真人实录·逐枚场（逐笔 1 枚 ×34，10120 队列 endTime 差分坐实时间池）· 印石日常真人实录·跨服场（`510000 amount=43 param:"1|0"`）· 普通无双真人实录（无双战场）。

---

## 0. 用法说明（先看这节）

**它做什么**：玩家部队受伤进医院后，自动执行游戏里的「英雄免费快速修理」——每日 77 个普通单位、**零材料零钻石**；免费额度用尽后默认继续**花买得起的资源续修**普通伤兵（同游戏一键修理/竞品 B）。这两条零/低成本线**恒开、不需勾选**。面板只暴露三类**可选付费/带成本**动作的开关：`修理雷神兵`、`使用钻石修`、`使用道具修`（各自默认关，受余额/持有约束）。

**怎么开**：

1. 打开扩展面板 → 左 TAB「**玩家设置**」→ 右卡片「**快速修理**」。
2. 先拨卡片顶部的**总启用开关**（`enabled`，默认关）——不开总开关，下面所有字段都不生效。
3. 按需勾选三个付费/带成本开关（`修理雷神兵`/`使用钻石修`/`使用道具修`，见下表）。免费修与资源续修恒开，无需勾选。
4. 保存即生效；feat 靠 push 即时唤醒 + 兜底轮询自愈，无需手动触发。

**建议灰度路径**：

- **零成本线无需手动开**：`英雄免费修理` 与 `超额花资源续修` 已恒开（不放面板），启用总开关后自动先吃免费额度、再花买得起的材料修普通兵。
- `使用钻石修` / `使用道具修` / `修理雷神兵` 三项都会**真实消耗钻石/道具/材料**，默认关（钻石只受余额约束、道具只要背包持有就动用，已无预算/保留量可配）。

**面板字段速查**：

| 字段       | 控件 | 默认 | 语义                                                                                                                                                                                                  |
| ---------- | ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修理雷神兵 | 勾选 | 关   | 本地雷神伤兵并入 220（超免费额度自然扣材料），跨服伤兵走 1427；本号雷神免费额度=0，开了就是真花材料                                                                                                   |
| 使用钻石修 | 勾选 | 关   | 对「修理中」队列发 151（本地）/1428（跨服）全额完成；按每分钟价估算，钻石余额不足即跳过（无日预算上限）                                                                                               |
| 使用道具修 | 勾选 | 关   | 发 815 ITEM_USE（param 本地全量 `null`，跨服全量 `"1\|0"`）用背包 `type=12` 道具缩短在修队列；**枚数按「在修剩余秒和 ÷ 单枚秒数」一次折算发足**（批量加速，不逐枚连点）；只要持有即动用（无保留下限） |

> 节奏：治疗与加速在**同一拍内串联**——治疗落地后就地重读在修态补跑加速层，不再等下一拍（见 §4）。

> 不进面板的内置项（无法勾选）：`freeRepair`（英雄免费修）与 `resourceRepair`（额度耗尽后花买得起的资源续修）恒开；`pollIntervalSec`（自愈轮询间隔）固定内置 60s。
> 已废弃并彻底移除（非仅隐藏）：`goldDailyCap`（钻石日预算）与 `keepItemNum`（道具保留下限）——连带的钻石日记账（`storage.data('quickRepair.gold')`）也已删除。

---

## 1. 协议清单

全部走 `net.sendGuarded` 的 **V1 旧 JSON 链路**（`protocol` 缺省 `send`，`dir` 恒 `req:send`），`ret.data` 为原始 JSON 串需自 `parseData`；`sendGuarded` **永不 reject**（发不出去返回 `CODE_NOT_SENT=-1`）。

| cmd   | 名称                                   | req                                                        | resp 关键载荷                                                                                                                     | 本 feat                                                          |
| ----- | -------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1785  | `GET_QUICK_REPARE_INFO`                | `{}`                                                       | `{common_max,common_use,landThor/navyThor/airThor/thor_max·use,ret:[{id,num}]}`                                                   | **权威额度读**，每拍先发                                         |
| 1426  | `GET_CROSS_HOSPITAL_QUEUES`            | `{}`                                                       | `{queues:[{army,id,st,et,func}]}`（`st` 非枚举而是**开修时刻**：`st===0 && et===0`=跨服待修；`st>0` 且 `et>ServerTime`=跨服在修） | 跨服队列权威读；**仅在「战场抢修车间」开启时才发**（见 §2 门控） |
| 220   | `ARMY_HEAL_LIST`                       | `{ids:[本地待修队列 id…]}`                                 | `{free_common_repair_num,free_thor_repair_num,queues:[…]}`                                                                        | **本地修理（含本地雷神）**，超免费额度才扣料                     |
| 206   | `ARMY_HEAL`                            | `{id}`                                                     | —                                                                                                                                 | 单条本地修理                                                     |
| 1427  | `ARMY_CROSS_HEAL`                      | `{ids:[跨服战场队列 id…]}`                                 | 伴随 `thor_elements`/`oila` 等扣减                                                                                                | **仅跨服战场**（本地 id 混入必被拒）                             |
| 151   | `ORDER_QUEUE_ING_DONE`                 | `{armyType?}`（-1 全量不带键）                             | —                                                                                                                                 | 钻石加速本地全部在修                                             |
| 124   | `ORDER_QUEUE_SPEED_UP`                 | `{id,useGold:1}`                                           | —                                                                                                                                 | 钻石加速本地单条                                                 |
| 1428  | `SPEEDUP_CROSS_HOSPITAL_QUEUE_BY_GOLD` | `{}` 全量 / `{id}` 单条                                    | —                                                                                                                                 | 钻石加速跨服队列                                                 |
| 815   | `ITEM_USE`                             | `{itemid,amount,param}`                                    | `{itemId,amount}`=使用后**剩余持有**（拒则为错误码串，如 `item_124017`）                                                          | 医院加速道具（`type=12`）；`amount`=时间池枚数，见 §2            |
| 10120 | push `ORDER_QUEUES_BATCH_INFO`         | `{orderQueues:[{id,orderId,state,itemId,type:1,endTime}]}` | —                                                                                                                                 | 本地伤兵入队/改态 → **唤醒**                                     |
| 13006 | push `CSB_HOSPITAL_QUEUE_ADD`          | `{queues:[{army,id,st,et}]}`                               | —                                                                                                                                 | 跨服入队 → **唤醒**                                              |

**无双（NewCAB/AVA）战场协议族**（普通无双真人实录 + 源码 `AVAHospitalComponent` 实证；与普通医院协议完全独立，同走 V1 `req:send`）：

| 模式                     | ask（读队列）                | cure（批量待修）               | speed（钻石/道具）    |
| ------------------------ | ---------------------------- | ------------------------------ | --------------------- |
| AVA（无双战场）          | 6310 `AVA_ASK_HOSPITAL_DATA` | 6311 `AVA_CURE_ALL_ARMYS_DATA` | 6312 `AVA_SPEED_CURE` |
| TM（_TEAM_MATCH_）       | 6356                         | 6357                           | 6358                  |
| Master（_MASTER_MATCH_） | 8403                         | 8404                           | 8405                  |
| Legend（_TEAM_LEGEND_）  | 9055                         | 9056                           | 9057                  |

- **ask 请求体恒 `null`**（游戏 `NET.send(6310,null)`）；应答 `{list:[{orderId,id,state,durationTime,startTime,endTime,type,itemId}]}`，`id` 与 `orderId` 同值（部队 uuid 十进制串）；`state 0`=待修、`1`=在修；`orderId==="0"` 为空槽。
- **cure**：`{ids:[state0 全量 id…]}` → `{ret:0}`（源码 `StartAllQueue` 逐字 `orderId!=="0" && state===0`）。
- **speed（钻石）**：`{ids:[id…],useGold:1}`；**speed（道具）**：`{ids,itemId:15100046,num,useGold:0}`（源码 `hospitalUseItemSpeed` + 竞品 B `avaHospitalEnd` 双源一致；真人实录 15 笔全为 useGold=1，道具形态实录无样本）。
- **push 21203** `New_CAB_HOSPITAL_CHANGE`：队列变化 → 唤醒（只当提示，不当数据源）。
- **模式择表**（源码 `StartAllQueue` 优先级）：`isNewCAB → isTMServer(tmServerType==5) → isMasterMatch(==6) → isTeamLegendServer(==8)`，判据源 `CrossUtils`（软依赖，取不到则无双分支整体静默）。
- **钻石估价**（源码 `SpeedCDPanel.getAvaCureGoldByTime`）：`max(floor(GetCDGold(剩余秒)×cfg(模式倍率)),1)`，倍率键 NewCAB `1663543` / TM `1663622` / Master `168036` / Legend `1670027`；`GetCDGold` 本体在逆向抽取里是空桩 ⇒ 以 `ceil(剩余秒/60×61017)` 基价代估×倍率（仅作余额保守闸门，真实扣费服务器裁决；**未建模 Legend buff 折扣项**（源码 `t=max(t-floor(t*a),1)`），估价偏高方向保守，非逐字口径）。道具枚数 `num=min(ceil(剩余秒/para1), 持有量, use_max||cfg(18002))`，道具专行 ITEM 表 `15100046`。

源码锚点：`RequestId`（协议号）、`WareHouseControllerNew.getQuickRepairTipsType`（择时判据）、`HospitalComponentNew.StartAllQueue·EndAllQueue`（写动作形态）、`Script/UserData.getOrderQueuesByType·getArmyByArmyUuid`（现场态读）、`Script/SpeedCDPanel.hospitalUseItemSpeed`（815 param 编码）、`Script/AVAHospitalComponent`（无双三件套）、`subpack2/WareHouseControllerNew.isBattleFieldHospitalValid`（1426 门控）、`GameDefine.ArmyType`/`ItemType.HospitalSpeedItem`。

---

## 2. 判据（只读）

- **普通兵每日免费额度** = `common_max - common_use`（实测本号 `common_max=77`，与英雄技能「免费修 77 个」一致）。雷神族 `*_max=0` ⇒ 雷神不可免费修。
- **择时**（镜像 `getQuickRepairTipsType(wait,max,use)`）：取不到 max/use 或 `wait<=0 || max<=0 || max-use<=0` ⇒ 不可修；`max-use>=wait` ⇒ 可全免；否则部分免。
- **本地待修队列**：直读 `UserData.OrderQueues`，过滤 `type===1(ORDER_TYPE_HEAL) && orderId!=="0"`：`state===0` 待修、`state===1` 修理中；`id` 即发包用的队列（槽）id。**去重令牌 = `id#orderId#endTime`**：① 槽 id 会被复用到不同伤兵（orderId 变），故含 orderId；② 同一部队（orderId 不变）会被反复打伤，每次受伤事件 `endTime` 变、而陈旧幻影（服务器已清、客户端未同步）`endTime` 不变，故含 endTime 以区分「需立修的再次受伤」与「须抑制的陈旧幻影」。
- **雷神判定**：不依赖 `FlameController` 单例，改判 `getArmyByArmyUuid(orderId).Data.thor_group>0`（`isFlameArmyById` 即此判据）。
- **钻石估价**：`max(1, ceil(在修剩余秒和 / 60 × GameTools.getDataConfigData(61017)))`（同 `getProfessionCDGold` 公式）。
- **815 param 编码**（源码 `SpeedCDPanel.hospitalUseItemSpeed` + 真人成功样本 `{itemid:510002,amount:9,param:null} s=0` 实证）：**本地全量 `param=null`**（`"0|0"` 会被服务器拒 `s=3/item_124017`）、本地单条=队列 `id`；跨服全量 `"1|0"`（或 `"1,"+armyType`）、跨服单条 `"1|"+queueId`。
- **战场抢修车间（1426）门控**（源码权威判据 `WareHouseControllerNew.isBattleFieldHospitalValid`）：`FunctionOn(cross_server_battle_hospital)` 且任一来源（`currentWorldMapCrossServerModel`/CQ25/CQ26 stormData）的 `HospitalEndTime - ServerTime > 0`；feat 优先 `game.get('WareHouseControllerNew')` 直调该方法，降级 `gameData.functionOnValue` 三态；两者都取不到 ⇒ 照旧轮询（宁多读不漏修）。无双模式在场时 1426 整体让位 6310 族。
- **道具加速枚数 = 时间池模型**（`speedItemNum`，普通医院 815 与无双 6312 共用）：服务器把 `amount` 理解为「枚数 × 单枚秒数」汇成的时间池，**按槽位顺序贪心消耗**（先修完队首、余额顺延下一条）⇒ 修完全部在修的最小枚数 = `ceil(Σ在修剩余秒 / para1)`，再受「持有量」与「单次上限」夹取。
  - 单枚秒数 = ITEM 行 `para1`（离线表值：510002=28800/8h、510001=3600、510000=300、15100046=3600）；`para1` 不可解（表列漂移）时**回退单枚旧口径**，宁少花不空转。
  - 枚数上限：医院 815 **只取 DATACONFIG `18002 useItem_num`（实测 10000）**——ITEM 行 `use_max=1` 是背包「使用」按钮的单次上限，**不约束医院面板的 N 枚同发**（真人 `amount=9`/`43` 均 `s=0` 落地）；无双 6312 无同量样本，仍按源码口径 `use_max || cfg(18002)`。
  - 实证链：逐枚场实录 1 枚的 10120 `endTime` 差分（首条清空、次条恰减 `28800-其剩余`：11775/6535/1307/13098 全部吻合）、清批场实录真人 `amount=9` 一次清空 15 条（15×≈17000s ≈ 9×28800）、跨服场实录 `amount=43`。
  - **在修秒和的前置闸（评审 M1）**：`repairingLeftSec`/`crossRepairingLeftSec`/`avaRepairingLeftSec` 三者在 `serverTime` 不可判定（≤0/NaN，`gameData.serverTime()` 契约就是「取不到返 0」）时**一律返 0**。因为 `endTime - 0` 会退化成 epoch 秒（单条≈1.79e9），而池模型的枚数 = `ceil(Σ/para1)` 会被夹到持有量⇒一笔打光背包道具。旧行为对钻石估价是 fail-safe（高估→余额不足→静默），对道具枚数则变 fail-open，故时间不可判定 = 视为「不在修」（同文件 `warFever()`/`nextDailyResetTs()` 的早退纪律）。

---

## 3. 决策分层（`planOnce`）

按开关逐层，条件不过即静默返回下一拍延时（日志带 `reason` 字段定位静默期）。决策拆为两个纯函数（`planHealActions` 治疗层 1-2 / `planSpeedActions` 加速层 3-4，另加 `planAvaActions` 无双层），`planActions` 只做 dispatcher——拆层是为了能「治疗落地后只补跑加速层」（见 §4）：

1. `freeRepair`（恒开，已不放面板）：`commonFreeLeft>0 && commonWaitIds.length>0` → 发 `220 {ids:commonWaitIds.slice(0,commonFreeLeft)}`。**额度耗尽时**（`commonFreeLeft<=0`）：`resourceRepair`（也恒开）→ 按部队 `repair_cost` 累计持有量筛「买得起」的普通伤兵发 `220`（kind `heal-local-resource`，服务器先扣免费、超出扣材料，同竞品 B），买不起者静默跳过（reason `no affordable common repair`），不告警不进退避（旧存档显式 `resourceRepair:false` 才会回到静默 reason `common free quota exhausted`）。
2. `thorRepair`（默认关）：开关开 → **本地雷神 ids 走 220**（超免费额度自然扣材料）、**跨服 ids 走 1427**（不混批）。
3. `speedGold`（默认关）：开关开 && `Gold>=goldEstimate` → 本地 `151` / 跨服 `1428`（只受余额约束，日预算闸门已废弃）。
4. `speedItem`（默认关）：开关开 && 背包持有 `type=12` 道具（amount>0）→ `815 ITEM_USE`（本地优先 `param=null`，否则跨服 `param="1|0"`；保留下限闸门已废弃）。**枚数按 §2 时间池模型一次折算发足**（`num = min(ceil(leftSec/para1), 持有量, cfg(18002))`），日志 label 形如 `item speed local #510002 x9 (held 100; leftSec 255000)`；折算为 0（持有空/秒数不可用）时静默记 reason `item speed num=0`。**同域钻石全量完成已排入本拍时，道具线让位**（`goldPlannedFor(actions, cross)` 分域判定，避免同拍双花），reason `item speed local skipped (gold done this tick)`。
5. **无双战场（`snap.avaMode` 在场时叠加，与普通族并行不互斥）**：
   - `heal-ava`：`resourceRepair` 开 && 6310 读到 state0 待修 → 发模式 cure `{ids:全量 state0}`；
   - `speed-gold-ava`（随 `speedGold`）：有在修（state1）且余额≥估价 → 发模式 speed `{ids:state1,useGold:1}`；
   - `speed-item-ava`（随 `speedItem`）：持有 15100046 且 num>0 → 发模式 speed `{ids,itemId:15100046,num,useGold:0}`；**与钻石线互斥（二选一，钻石优先）**——两者同打 `cmds.speed` 同一目标集，同拍双发即双花（游戏 UI 本身也是二选一）；
   - 6310 读失败 ⇒ 整层静默（reason `ava hospital read failed`）；无双写动作**不回灌 UpdateOrderQueues**（不入 `LOCAL_SYNC_KINDS`，靠 push 21203 唤醒 + 下拍 6310 权威读）。

---

## 4. 调度与防重

- **`snapshot → planOnce`** 每拍跑一次；返回下一拍毫秒：有待修走勤扫档 `ACTIVE_TICK_MS≈5s`，静默走 `IDLE_TICK_MS`（内置 `pollIntervalSec`），连续被拒 3 次退避一档。
- **修理与加速同拍串联**（`planOnce` 二次决策，真机灰度修正十四②）：本拍快照在治前读，`snap.repairing` 不含刚开修的队列 → 旧实现会整拍静默等 `nothing under repair`、下一拍（实测 5.1s 后）才发加速。现改为：`execActions` 逐条发本拍动作并回报是否「治疗层落地」（`HEAL_LANES`：`heal-local`/`heal-local-resource`/`heal-local-thor`/`heal-cross`，不含 `heal-ava`）；落地后用 `speedSnapshotAfterHeal(snap)` **纯本地**重读 `healQueues()` + `repairingLeftSec()`（零网络；本地 220 成功已 `syncLocalQueues` 回灌 `OrderQueues`，故即时可见在修态），只补跑 `planSpeedActions`。拍内逐条发包仍隔 `INTER_SEND_MS`（1s）、`ctx.alive()=false` 即时中辍。跨服在修秒和沿用本拍 1426 读数（战场队列只能等下拍权威读）。
- **push 唤醒**：`ctx.on.push(10120/13006, kick)` 即时 `cycle.kick()`；无双四模式队列变化 push 全订（21203 NewCAB / 21211 TM / 21465 Master / 21562 Legend，均 ResponseId 实证；只当唤醒提示、非本场模式的号不会到达，多订无副作用，否则 TM/Master/Legend 战场只能等轮询兜底）；退订由 reactor 统一登记。
- **在途指纹去重**：直发不回写本地态。去重键为 `动作名|去重令牌`（本地治疗令牌 = `id#orderId#endTime`，同槽新伤兵/同队再次受伤→新键→即时放行，不被旧伤同槽键或同队旧伤键一票否决）；`RECENT_SEND_TTL_MS`（45s）内同一键只发一次，跨 TTL 由权威读重新裁决。无令牌的全量动作（151/1428/815）成功后登记整批键 `fp|all`（TTL 45s）——本处**刻意保留**：815 应答不含 queues、队列态靠 push 10120 异步刷新，去掉该闸会引入「客户端陈旧 → 每 5s 烧道具」风险；而修正十四把「逐拍 1 枚」换成「一次发足」，慢感不再靠拆闸解决。
- **已修槽延长抑制**（防 `common_159995` param error 死循环）：220 为**原子批量**——批次含一个空槽/无效 id 会连累整批被拒（也是偶发漏修的一个成因）。治疗**成功**应答里 `orderId→"0"` 的槽，其 `(id#orderId#endTime)` 抑制推至 `HEAL_STALE_SUPPRESS_MS`（5min）。因令牌含 endTime：陈旧幻影（endTime 不变）命中→长抑不重发；而同一部队再次受伤（endTime 变）→新令牌→不受此长抑影响、即时可修（不会因长抑而漏修）。
- **批量 param error 逐 id 隔离**（`bisectHeal`，真机灰度修正四）：`markHealed` 只在**成功**时登记；而 reload 会清空内存 `sentFp`，reload 前已治好、客户端 OrderQueues 未回写的陈旧幻影会在 reload 后首拍重发→**整批 param error 拒绝**（不触发 `markHealed`，仅走 45s `markFp`）→每 TTL 撞一次、死循环，且原子批量会连累同批真伤漏修。对策：220/1427 被 `common_159995` 整批拒绝时**逐 id 单发**——单发成功者即时治好并按 `markHealed` 抑制；单发仍 param error 者确认为幻影→延长抑制，后续拍指纹把它**过滤在批外**，真伤不再被连累。
- **确定陈旧幻影的长抑 + 不污染退避**（`markDeadSlot`，真机灰度修正五，真人实录）：单条治疗（批量已是单元素，或隔离后单发）仍 param error ⇒ 该 id 当前**确定不可修**（服务器侧已空，只是客户端不回写的幻影）。这类令牌已是 `id#orderId#endTime`，真伤再发生会产生新 endTime→新令牌→即时放行，故可安全地长抑 `HEAL_DEAD_SLOT_SUPPRESS_MS`（**30min**，而非 5min）；且**不计入 `rejectStreak`**、按 `debug` 记录（非真业务故障）。否则就会像真人实录里那一场：某槽 02:38 已治好（s=0）、无后续 push 清洗，之后每 5min 重投一次 `common_159995`（streak 一路到 #8）。
- **幻影根治：回灌 `UpdateOrderQueues`**（`syncLocalQueues`，真机灰度修正六）：上述三层抑制都是「不重发」的规避，但客户端 `OrderQueues` 里已治好槽仍显示待修（幻影本体未消）。用户批准 quickRepair 可为此开**只读例外的唯一口子**——借用游戏**自己**治疗/加速应答回调同款入口（源码 `HospitalComponentNew`/`HospitalArmySelectPopup` 的 `UserData.UpdateOrderQueues(o.queues)`，竞品 B `hospitalStart` 治后 `UpdateOrderQueues(M.queues)`、`hospitalEnd` 加速后 `UpdateOrderQueues(·.orderQueues)`）：本地治疗/加速（`heal-local`/`heal-local-thor`/`speed-gold-local`/`speed-item-local`）**成功后**把服务器权威队列按 `id` 就地覆盖回灌本地 `_orderQueues`（`orderId→0`/新 state），幻影从根消失，下一拍权威读不再把它列为待修。`LOCAL_SYNC_KINDS` 表只放行本地流，跨服（1427/1428/`speed-item-cross`）绝不回灌（战场队列由 1426/push 刷新）；符号缺失/异常 `try/catch` 静默降级，三层抑制降为**兜底**（游戏更新导致 `UpdateOrderQueues` 漂移时仍不重发）。这是 `UpdateOrderQueues` 覆盖服务器已下发数据、**非自造增删**，不触碰 `StartAllQueue`/`OpenUI`/`Delete`。

---

## 5. 生命周期与合规

- reactor 托管：`places:['base','world']`、`kinds:['homeland']`、`offInCombat:false`（不行军不参战）；`pause` 后 `ctx.alive()=false`，cycle 与在飞 await 自然停摆。
- `symbols:['dataCenter','gameTools','tableManager']`；install 期取符号，缺任一即 `warn` 返回 false 并降级。UserData **现读不缓存**（切图/进战场会整体替换）。
- **红线**：全程只读游戏数据 + 直发协议，绝不调用 `StartAllQueue`/`UpdateOrderQueue`/`OpenUI`/`Delete` 等改写本地态或弹 UI 的原生方法。**quickRepair 的唯一例外**（经用户批准）：治疗/加速成功后借用游戏自带 `UserData.UpdateOrderQueues(respQueues)`（与源码/竞品 B 应答回调完全同款）把服务器已下发的权威队列就地回灌——只覆盖、不自造增删、不弹 UI，专用于消除 direct-send 不回写产生的陈旧幻影（见 §4 修正六）。

---

## 6. 日志

`createLog('QUICK-REPAIR')`，全程英文 message：

- `info` = 生命周期 + 可预期业务拒绝（无伤兵/额度耗尽/材料不足/在途），带 `code` + `rejectText(ret)`；
- `warn` = 真异常（`CODE_NOT_SENT` / 应答畸形 / install 缺符号）；
- `debug` = 每拍决策细节与 `reason`。

---

## 7. 验证

- **单测**：[`tests/feats/quick-repair.test.js`](../../tests/feats/quick-repair.test.js)（桩化浏览器全局后动态 import 取导出纯函数，断言 `normalize/tipsType/splitWaitIds/estimateGold/itemSpeedParam/speedItemNum/planActions/planHealActions/planSpeedActions/goldPlannedFor/HEAL_LANES/nextDelayMs` 等择时、枚数折算与 param 编码）→ `node --test tests/feats/quick-repair.test.js`。
- **对拍**：[`scripts/verify-manifests/quick-repair.mjs`](../../scripts/verify-manifests/quick-repair.mjs)（协议常量与调度阀值均从 feat 源码正则抽取（`featNum`/`featNumExpr`），单一真相源）→ `npm run verify:quick-repair`。HARD 维度：D1 载荷键集形态、D2 通道恒 `req:send`、D3 修理目标来源闸（反向防误发）、D7 无双载荷形态、D8 无双 ids 来源闸、**D10 815 医院加速道具形态**（键集 `{amount,itemid,param}`、`amount` 为正整数枚数、param 不得取 feat 源码记载的必拒形态 `"0|0"`）；SOFT/观察：D4 免费额度守恒、D5 前向完备、D6 应答配对、D9 无双队列态、**D11 815 枚数-持有守恒与批量度**（同 itemid 相邻笔用应答回读的剩余持有算降幅，并报 amount 区间/多枚同发笔数/最长「单枚连发」簇）、**D12 治疗→加速同周期节奏**（治疗后首笔同域加速间隔分布，≤`INTER_SEND_MS` 计拍内、≈`ACTIVE_TICK_MS` 计下一拍）。医院加速道具样本靠「param 形态 + 应答 `{amount,itemId}` 回读签名（子集判定）」鉴定，不钉 itemid/para1 字面（避免与 feat 分叉）；已知局限：无 `param` 键的 815（全库 21 笔，如 `1700039/600001/5101101`）应答键集也是 `{amount,itemId}`，与「医院侧 param 漏发」不可区分，故该回归由单测而非对拍拦截。已实跑：清批场（真人 amount=9）/ 逐枚场（逐笔 1 枚 ×34）/ 跨服场（amount=43）/ 旧引擎逐枚场均 EXIT=0；负样本场（旧版 `param:"0|0"` ×5）能把 D10 扫红。

---

## 8. 变更记录

- **2026-11-08 真机灰度修正十四（四份真人实录取证，用户两条反馈）**：“不是批量加速，而是一个个加速” + “修理和加速应该在一个周期内”。
  - 实证（报文差分 × 离线配置表交叉）：815 的 `amount` 是**时间池枚数**而非“点一下”——逐枚场实录逐笔 1 枚的 10120 `endTime` 差分与「先吃队首、余额顺延下一条」的贪心模型逐笔精确吻合（11775/6535/1307/13098）；清批场实录真人一笔 `{itemid:510002,amount:9,param:null}` 清空 15 条在修（15×≈17000s ≈ 9×28800）；跨服场实录真人 `amount=43`。离线表：ITEM `510002 para1=28800/use_max=1`、DATACONFIG `18002 useItem_num=10000`、`70038 cross_server_hospital_return_item=510002|510001|510000`。
  - 根因一（一个个加速）：`planActions` 第 4 层硬编码 `amount: 1`，从不按池模型折算；且快照视图不含 `para1`/枚数上限。`use_max=1` 是个陷阱——若照 ITEM 行夹取会永久退回“一次 1 枚”，与真机证据矛盾 ⇒ 医院线枚数上限只取 cfg(18002)。
  - 根因二（不在同周期）：`snapshot` 在 heal 之前读，本拍 `repairing=0` ⇒ 加速层被 `nothing under repair for item speed` 拦住，实测白等 5.1s（下一拍）才发 815。
  - 修复：① 新增 `itemSpeedRow`/`cfgItemSpeedUseMax`/`hospitalSpeedItemInfo`（快照 `speedItem` 富 `secPerUse`/`useMax`），`avaItemNum` 改名 `speedItemNum` 并普通医院/无双共用，第 4 层按 `num = min(ceil(leftSec/para1), 持有量, cfg(18002))` **一次发足**（`para1` 不可解时回退单枚，宁少花不空转；持有为 0 记 reason）；② 决策拆为 `planHealActions`/`planSpeedActions`（`planActions` 降为 dispatcher），`planOnce` 支持治疗落地后同拍只补跑加速层（`HEAL_LANES` + `speedSnapshotAfterHeal` 纯本地重读，零网络）；③ 同域钻石全量完成已排入时道具线让位（新函数 `goldPlannedFor`，分域判定，沿用修正十三①的不双花纪律）；④ 面板 `使用道具修` hint 与头部协议注释同步。保留不改：`fp|all` 整批指纹（见 §4）、道具选择仍为「type=12 候选里持有最多者」（不改换消耗品种）、无双 6312 枚数口径（无多枚样本，不轻改）。
  - 同拍串联首拍真机报 `cycle run threw. TypeError: Cannot read properties of undefined (reading 'actions')`（修正十四补充）：`planHealActions`/`planSpeedActions` 拆层时沿用的是**累加容器**语义（写进传入的 actions/reasons、无返回值），而 `planOnce` 的第二拍误当 `planActions` 那样取返回值读 `plan2.actions`。后果仅降回旧行为（第一拍动作已发出，同拍补跑丢失、加速等到下拍），但每拍都进 cycle 驱动器的 catch。修正：第二拍改传局部容器 `speedActions`/`speedReasons` 后直接读容器，并在两层函数 JSDoc 写明「无返回值」+ 单测用 `assert.equal(ret, undefined)` 钉住该契约（防止后续再误取返回值）。
  - 验证：单测 48/48（新增一次发足 9 枚 / 跨服 2 枚 param `"1|0"` / 持有量与单次上限夹取与 num=0 静默 / 同域让位与分域独立 / `goldPlannedFor` / 拆层不串货（含容器契约断言）/ `HEAL_LANES` 成员集）；对拍新增 D10（HARD）+ D11/D12（观察），四份录制 EXIT=0、负样本场能扫红；四门禁全绿。
  - 【修正十四补充·代码评审】（CodeReview 子代理，1 Major / 2 Minor / 1 Nit，四条已同批落）：
    - **M1（Major，已修）**：枚数折算把 `serverTime` 不可判定的风险从 fail-safe 变 fail-open（详 §2 前置闸）——`repairingLeftSec`/`crossRepairingLeftSec`/`avaRepairingLeftSec` 三入口统一加 `if (!(Number(serverTime) > 0)) return 0;`，并补 serverTime=0/undefined/NaN 单测（原无此类用例）。
    - **m1（Minor，已修）**：`para1` 不可解时的回退分支原直写 `: 1`，绕过持有/上限夹取、也与本文「持有为 0 记 reason」自相矛盾 → 改 `: held > 0 ? 1 : 0`（现网因 `pickSpeedItem(…, 0)` 保证 held≥1 不构成缺陷，属契约面）。新单测钉住「`secPerUse=0` 且 `held=0` ⇒ 不发空包 + reason `item speed num=0`」与「`held=3` ⇒ 回退单枚」。
    - **m2（Minor，部分采纳）**：曾想把 D10 样本入口按键集放宽到 `{amount,itemid}` 以接住「`param` 键整个丢失」的回归——**实测全库 21 笔无 param 的 815（`1700039/600001/600002/700003/47001001/5101101…`）应答键集恰好也是 `{amount,itemId}`**，与医院形态不可区分 ⇒ 放宽会造成假 FAIL，已回退。只保留真正安全的改进：resp 判据由严格相等改为**子集**（服务器应答加列不再把真样本全排除）；该回归改由单测（断言 815 body 键集含 `param`）承担，并在 manifest 注释写明局限。
    - **n1（Nit，已修）**：`execAction` 成功路径注释称「道具类不在 `GOLD_SPEED_KINDS` 表内、逐拍重试通道不受影响」——实际道具动作 `tokens` 为空 ⇒ 先命中 `markFp(act.fp, null)` 登记 `fp|all`，`else if` 对道具永不可达。行为属 §4 声明的刻意保留，仅重写注释并在同处明写「45s 内新入队伤兵拿不到道具/钻石加速」的代价；下一条（修正十三②）的同误述已内联标注。
    - 验证：单测 50/50（本批新增 serverTime 闸 + m1 两形态）/ lint 0 error / arch clean / build Done / 对拍四份录制 EXIT=0、负样本场仍扫红。
- **2026-11-08 代码评审修正（修正十三：无双双花防护 + 软依赖自愈 + 可观测性）**（CodeReview 子代理报告，2 Major/3 Minor/4 Nit）：① **同拍双花**——`speed-gold-ava` 与 `speed-item-ava` 原为独立链，都打 `cmds.speed` 同一 state1 目标集，两勾选同开时同拍既钻石全额完成又道具加速；改为二选一钻石优先（游戏 UI 同款），道具记 reason `ava item speed skipped`；② **无令牌动作成功后不登记指纹**——execAction 成功路径只认 `tokens`，151/1428/6312 钻石这类全量付费动作成功后零登记，勤扫档下服务端结算滞后期每拍重发扣费请求；现成功即登记整批键 `fp|all`（TTL 45s），钻石类全量完成覆盖后不重复扣，道具类（speed-item-*）保留逐拍重试通道（同一队列合法地可连续多次用道具）【修正十四补充 n1 已修正该误述：道具动作无令牌、实际也被 `fp|all` 压住 45s，并非逐拍可重试】；另修复 `execAction` 部分过滤时 `body={ids:subIds}` 重建会丢 `useGold/itemId/num` 键的潜在缺陷（改 `Object.assign` 保留）；③ **CrossUtils 钉死**——原 install 期一次性解析被 `installed` 幂等位固化，首次启用时尚未被 __require 填充则无双层整页生命周期静默失效；改为 `resolveCrossUtils()` 惰性重试（失败不缓存、成功才固化），与 `battleFieldHospitalOpen` 每拍口径对齐；④ **TM/Master/Legend 无唤醒 push**——原只订 21203；现按 ResponseId 实证补订 21211/21465/21562；⑤ `crossSkipped` 死字段接入 `reasons`（`cross hospital gate closed (1426 skipped)`，门控关闭与「读了但无待修」可区分）；⑥ 面板 `speedItem` hint 残留「本地全量 "0|0"」修正为 `null`（修正一漏改）；⑦ snapshot 早退分支补 `lastAvaBusy` 复位；⑧ 文档：§0 闸门描述与修正九自相矛盾处删除；Legend buff 折扣未建模注明；估价注释术语统一。保留不改：cycleRun 轻量重读 healQueues（发包后重读比复用陈旧 snap 更准，纯本地无网络成本）。四门禁全绿（test 42/42 新增互斥/门控归因两用例 / lint 0 error / build Done / verify 无双+印石录制均 EXIT=0）。
- **2026-11-08 无双（NewCAB/AVA）战场修兵（修正十二：独立协议族，报文与普通医院不同）**（普通无双真人实录，用户实证）：无双战场的医院不走 1785/220/1426 族（录制内全部零命中），而是独立的 6310/6311/6312（及 TM 6356-58、Master 8403-05、Legend 9055-57）三件套。功能一样（批量修待修 + 钻石/道具加速），但报文形态不同：ask 体恒 `null`、cure `{ids:state0全量}`、speed 钻石 `{ids,useGold:1}` / 道具 `{ids,itemId:15100046,num,useGold:0}`。三方验证：录制（形态/字段/时序）+ 源码 `AVAHospitalComponent.StartAllQueue·_realUseCure` + 竞品 B `avaHospitalStart·avaHospitalEnd`。诚实边界：① 道具形态录制无样本（15 笔全 useGold=1），依据源码+竞品B 双源；② `GetCDGold` 抽取是空桩，估价用 61017 基价×模式倍率代估；③ 录制里真人多在 6311 后的陈旧 state0 快照上直点钻石（6312 ids 全部∈state0），语义为「直接修完」而非「加速在修」——feat 按源码口径只对 state1 发加速，待修由 cure 批量覆盖，对拍 D8 据此把 speed 来源闸定为 state0∪state1。模式择表按 CrossUtils 四判据优先级（软依赖，取不到则无双层整体静默）；push 21203 作唤醒；无双写不回灌 OrderQueues。四门禁全绿（test 242/242，新增无双用例 8 个 / lint clean / build Done / verify 无双录制+印石录制均 EXIT=0，新增 D7/D8/D9 维度）。
- **2026-11-08 战场抢修车间门控（修正十一：1426 不是永远可用）**（用户指令）：「战场抢修车间」并非常开，官方门控为 `WareHouseControllerNew.isBattleFieldHospitalValid`：`FunctionOn(cross_server_battle_hospital)` 且 HospitalEndTime 窗口未过（currentWorldMapCrossServerModel/CQ25/CQ26 任一）。feat 新增 `battleFieldHospitalOpen()`：优先直调该方法，降级 `gameData.functionOnValue` 三态，都取不到则照旧轮询（宁多读不漏修）；关闭时跳过 1426（`crossSkipped=true`，跨服层静默不报错）；无双模式在场时 1426 整体让位 6310 族。四门禁全绿。
- **2026-11-08 战场（跨服）在修队列从不被加速（修正十：`st` 是开修时间戳而非枚举 1）**（跨服修理真人实录）：用户报两问——① 是否逐条修；② 战场抢修车间单位未加速（用户手动修了一个）。核对报文：本地修理为 `220 {ids:[8 个 id]}` 单包批量（非逐条），战场待修 `1427 {ids:[...]}` 亦批量，逐条修复不存在。但 `crossRepairingLeftSec` 恒返 0——它按本地队列口径判 `st===1`，而 1426 跨服队列的 `st` 不是枚举而是「开修时刻」epoch 秒（实测待修 `st=0/et=0`，在修 `st=1794112460/et=1794125551`，约还 3.6h），故 `snap.repairing=localRepairing+crossRepairing` 里跨服部分永远为 0，日志自 12:34 治好战场单位后每拍刷 `nothing under repair`，钻石（1428）/道具加速均不触发；录制里唯一一笔跨服 `815 param:"1|0" amount:43 itemid:510000` 是用户手动所发（引擎只发 `item speed local`、用 `510002`）。修正：`crossRepairingLeftSec` 判定由 `Number(q.st)===1` 改为 `Number(q.st)>0`（配 `et>serverTime`）；头部协议注释与 §1 表同步 `st` 语义。修好后：本地修完且跨服仍在修时 `speed-item-cross`（param `1|0`）与 `speed-gold-cross`（1428）会正常触发。四门禁全绿（test 30/30、新增跨服在修时间戳形态用例 / lint clean / build Done / verify EXIT=0）。
- **2026-11-08 面板再精简（修正九：废弃钻石日预算与道具保留下限）**（用户指令）：承修正八，用户要求把两个数值闸门「废弃」（非仅隐藏）。因日预算唯一消费方就是 `goldDailyCap` 闸门，按「不留死逻辑」彻底删除：① 面板 `goldDailyCap`/`keepItemNum` 两个字段删除；② `defaults` 与 `normalize` 不再输出这两键（旧存档传入也不透传）；③ `planActions` 删除本地/跨服两处 `m.goldDailyCap>0 && projected+cost>cap` 拦截分支，只保留余额（`Gold>=estimate`）与估价可用两道闸；④ **整块删除钻石日记账**（`goldDay` 变量、`ensureGoldDay`/`persistGoldDay`/`loadGoldDay`/`addGoldSpent` 四函数、`snapshot` 里的 `goldSpentToday`、`execAction` 里的 `addGoldSpent` 调用、`cycleRun`/`run` 里的 `ensureGoldDay`/`loadGoldDay`），连带释放 `storage.data('quickRepair.gold')` 与 `todayStr` 导入（`goldCost` 字段保留供日志）；⑤ 道具保留下限废除：`snapshot` 改为 `pickSpeedItem(..., 0)`（只要背包持有即动用），静默文案由 `no hospital speed item above keep (N)` 改为 `no hospital speed item in bag`；`pickSpeedItem` 保留为通用纯函数（keep 参数仍可传，单测不变）。行为变化：开钻石修理后不再受日上限约束（仅看余额）、开道具修理后把背包 `type=12` 全部用于加速。四门禁全绿（test 30/30 / lint clean / build Done / verify 全部关键不变量通过；dist 无残留 `daily gold cap`/`above keep`/两闸门文案）。
- **2026-11-08 面板精简（修正八：零成本线恒开 + 只留 3 个付费开关）**（用户指令）：将面板从 8 字段精简为 **3 个勾选 + 2 个数值闸门**。① `freeRepair`（英雄免费修）与 `resourceRepair`（额度耗尽后花资源续修）**移出面板、恒开**：defaults 中 `resourceRepair` 改为 true，`normalize` 对两键采用「缺键视为 true、显式 false 仍尊重」口径（旧存档/程序显式传 false 不会静默变成强制开）；② `pollIntervalSec`（自愈轮询间隔）**移出面板**，作为系统内置（normalize 仍读到 defaults 60s，上限钳 `cfg.maxPollSec`）；③ 保留的 3 个开关重命名：`雷神部队修理`→`修理雷神兵`、`钻石加速`→`使用钻石修`、`加速道具加速`→`使用道具修`（`key` 不变，仅改 label）；钻石日预算/道具保留下限两个数值闸门保留（防止移出后钻石支出变无界）。行为层零变动（修正七的资源续修逻辑仍在，只是不再需勾选即默认生效）。四门禁全绿（test 30/30 / lint clean / build Done / verify 全部关键不变量通过）。
- **2026-11-08 真机灰度修正七（额度耗尽不修普通兵→新增资源续修开关）**（真人实录取证）：**车间有普通伤兵却全程不修**。实测：1785 应答全程 `common_use:77/common_max:77`（免费额度真耗尽，`getQuickRepairTipsType` 判 NoCanRepair）；日志 46 拍每拍都 `silent: common free quota exhausted (77/77)` 且 `no common wait` 出 0 次（⇒ 确有普通待修），rec 内 220/206/1427 一次未发。根因：旧 tier-1 只按 `commonIds.slice(0, commonFreeLeft)` 修免费额度内、额度一尽就整批不发，**从不花资源修普通兵**（游戏一键修理/竞品 B 则会花材料续修）。修正（经用户选定：加开关默认关 + 只修买得起）：新增面板开关 `resourceRepair`（默认关）；`splitWaitIds` 额外输出 `commonOrders`（与 commonIds 同序的 orderId）；`snapshot()` 在开关开+额度耗尽+有普通待修时逐伤兵取 `army.Data.repair_cost`（新纯函数 `parseRepairCost`）、按 `UserData.Resource.getResource(resId)` 累计持有量贪心筛「买得起」集（新纯函数 `filterAffordable`，成本不可判定者跳过）；`planActions` 据此发 kind=`heal-local-resource` 的 220，买不起者静默跳过、不计 rejectStreak；`heal-local-resource` 入 `LOCAL_SYNC_KINDS`（成功后同样回灌 UpdateOrderQueues 除幻影）。默认行为零变化（关）。四门禁全绿（30/30）。
- **2026-11-08 真机灰度修正六**（幻影根治）：**从根消除陈旧幻影，不再靠“不重发”规避**。修正四/五只是把已治好幻影的重发频率/日志降噪，但客户端 `OrderQueues` 里那些槽永远显示待修（除非服务器 push 清洗）。参照游戏源码 `HospitalComponentNew`/`HospitalArmySelectPopup`（批量 220 应答回调里 `UserData.UpdateOrderQueues(o.queues)`）与竞品 B `server-js.js`（`hospitalStart` 治后 `UpdateOrderQueues(M.queues)`、`hospitalEnd` 815/151 后 `UpdateOrderQueues(·.orderQueues)`），确认“直发后回灌应答队列”就是游戏官方的标准做法。用户批准 quickRepair 开只读例外：新增 `syncLocalQueues(act,ret)`，本地治疗/加速成功后调 `UserData.UpdateOrderQueues(respQueues)`（取 `resp.queues` 或 `resp.orderQueues`）把权威队列就地回灌；`LOCAL_SYNC_KINDS` 只放行 `heal-local`/`heal-local-thor`/`speed-gold-local`/`speed-item-local`，跨服流不回灌；符号缺失/异常静默降级，三层抑制降为兜底。`execAction` 成功行日志附 `(queues synced)`。新增导出 `LOCAL_SYNC_KINDS` 与契约用例（27/27 全过）。
- **2026-11-08 真机灰度修正五**（真人实录取证）：**已治好癕影每 5min 重投 param error、且污染 rejectStreak**。实测：全场景仅 1 个 push，槽 `353344`/orderId `59752`/endTime `1794075926` 于 ≈02:38（ts `713867`）被 220 **治好（s=0、orderId→0）**；因 direct-send 不回写客户端 `OrderQueues`、且再无 push 清洗，它在本地永远显示待修，之后每 ~300s（=`HEAL_STALE_SUPPRESS_MS`）重发一次→`s=3 common_159995`（streak #1…#8）。本质：该单位**服务器端已修好，非漏修**；param error 只是重投空槽。修正：新增 `markDeadSlot`——**单条（批量 n=1 或隔离后单发）治疗仍 param error ⇒ 确认陈旧幻影 → 延长抑制至 `HEAL_DEAD_SLOT_SUPPRESS_MS`（30min）、`debug` 记录、不计 `rejectStreak`**（真伤再发生→新 endTime→新令牌→即时放行，不会因长抑漏修）；`bisectHeal` 单发 param error 同步改走 `markDeadSlot`，仅当真业务拒绝才累加退避。抽出 `suppressFp(key,tokens,ms)` 共用。四门禁全绿（26/26）。
- **2026-11-08 真机灰度修正四**（真人实录取证，新代码 build 02:10:20 之后）：**reload 后陈旧幻影整批 param error，仍漏修**。实测：`353344`（endTime 变→新令牌）单独发 `689089/991518` 两次均 s=0 治好；而 `083784`/`781798914` 于 `717912`（旧代码）已治好，但 220 直发不回写客户端 `OrderQueues`、无 10120 push 清洗→它们永远是陈旧幻影；02:10:20 重载后内存 `sentFp` 清空，首拍就把这俩一起发 → `s=3 common_159995`，之后每 ~46s TTL 过期重试、`healed->[]` 永不停（param error 是拒绝、不触发只认成功的 `markHealed`）。修正：新增 `bisectHeal`——220/1427 被 `common_159995` **整批拒绝时逐 id 单发隔离**：真伤单发即时治好，确认幻影单发仍 param error 后 `markHealed` 延长抑制→后续拍指纹将其过滤在批外（兼治原子批量连累真伤的漏修）；单条 param error 也直接长抑。新增纯函数 `isParamErrorRet`/`isHealBatchCmd` 及用例（26/26 全过）。
- **2026-11-08 真机灰度修正三**（真人实录取证）：**同队再次受伤被误抑制→仍漏修 1 个**。实测：槽 `353344`/orderId `59752` 于 `689089` 治好（orderId→0），`717796` push 同一 orderId 又被打伤（endTime `1794074009`→`1794074689`）；修正二的 5min `markHealed` 按 `id#orderId` 长抑把这个“同队新伤”误拦→下一拍只发了另 2 个、`353344` 落回未修。修正：**去重令牌改为 `id#orderId#endTime`**——陈旧幻影（endTime 不变）仍命中长抑防 param error；再次受伤（endTime 变）为新令牌→即时放行。单测新增“同 orderId+endTime 变→键相异”用例。
- **2026-11-08 真机灰度修正二**（真人实录取证）：① **偶发漏修 1 个**——医院队列槽 id 被复用于不同伤兵，旧指纹只按槽 id 去重会误抑制「刚进同槽的新兵」；去重键改为 `id#orderId`（新 orderId→新键→即时放行）。② **220 `common_159995` param error 死循环**——治疗成功清空槽后，客户端本地 `OrderQueues` 滞后仍报同一 `id#orderId` 待修，45s TTL 过期后反复去修空槽（220 原子批量还连累同批可修的兵一起失败）；改为成功应答里 `orderId→"0"` 的 `(id#orderId)` 延长抑制至 5min（`markHealed`）。免费额度实证充足（`common_use` 仅 5~12，非额度问题）。
- **2026-11-08 真机灰度修正**（真人实录取证）：① 815 本地全量 `param` 由 `"0|0"`→`null`（真人 510002 成功样本对照，原值被服务器 `s=3/item_124017` 拒）；② 本地雷神不再误发 1427，改走 220（与竞对 B/源码一致，避免服务器拒并污染退避）；③ 钻石估价本地/跨服分域（原双计全量会使日预算提前触顶）；④ 在途指纹去掉整批键对逐 id 动作的一票否决，新伤兵即时放行。
- 初版落地：freeRepair/thorRepair/speedGold/speedItem 四分支 + 兜底轮询；免费线默认开、付费线默认关；build/lint/test/对拍四门禁通过。
