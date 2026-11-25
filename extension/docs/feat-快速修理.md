# feat · 快速修理（`quickRepair`）

> 代码：[`src/feats/player/quick-repair/`](../src/feats/player/quick-repair/)（index.js 编排/协议；`model/` 纯判据 classify·schema·entries·gates·cost·quota·kinds；`venues/` 三场地适配器 base·csb·ava·shared）· 面板：战斗设置 → **快速修理** · 形态：`createCycle` 电平调和 + push 即时唤醒（与 `armory-material` / `potion-craft` 同族「只读+发包」日常 feat）。
> 报文实证：印石日常真人实录·清批场（普通医院·真人一笔 `amount=9` 清空 15 条在修）· 印石日常真人实录·逐枚场（逐笔 1 枚 ×34，10120 队列 endTime 差分坐实时间池）· 印石日常真人实录·跨服场（`510000 amount=43 param:"1|0"`）· 普通无双真人实录（无双战场）。

---

## 0. 用法说明（先看这节）

**它做什么**：玩家部队受伤进医院后，按三个场地分别自动修理并按需加速（面板按场地分段全配）：

- **基地修理厂**（本地医院）：普通兵先扣英雄每日免费额度（77 个）、超出扣材料；雷神兵直接扣材料。修理 = 勾选类型集合一笔 220 全发。
- **战场抢修车间**（跨服天梯赛战场医院）：只收雷神；赛事项圈内才可读，关闸前 10 分钟优先加速本场地，避免未修完随关闸损毁。
- **无双修理厂**（NewCAB/AVA、TM、大师赛、传奇小队）：**修理免费**（不耗材料），只按勾选集合排队；加速按模式倍率估价。

每个场地一组配置：**修理范围**（军种 × 类型多选）+ **加速方式**（不加速/钻石/道具，默认一律不加速）。基地与无双分普通档/雷神档两个加速键；抢修车间只收雷神，单键。所有场地钻石加速共享一个 **钻石日上限**（跨场地累计，服务器日界归零；0/空 = 不限）。

**怎么开**：

1. 打开扩展面板 → 左 TAB「**战斗设置**」→ 右卡片「**快速修理**」。
2. 先拨卡片顶部的**总启用开关**（`enabled`，默认关）。
3. 在「基地修理厂 / 战场抢修车间 / 无双修理厂」三段里勾修理范围、选加速方式；在「加速预算」段可选填钻石日上限。
4. 保存即生效；feat 靠 push 即时唤醒 + 兜底轮询自愈，无需手动触发。

**建议灰度路径**：先只开基地+无双的普通兵修理（默认已是此形态、加速全 none），确认日志 `sent` 正常；要修雷神/战场再勾对应类型；加速先试「道具」（时间池折算、按需烧），最后再开「钻石」并设日上限。

**面板字段速查**：

| 字段 | 控件 | 默认 | 语义 |
| --- | --- | --- | --- |
| `repairBase` 修理范围 | 多选（9 码） | 三军种普通兵 | 基地：勾选军种×类型，一笔 220 全发；普通兵先吃免费额度、超出扣料 |
| `speedBaseNormal` / `speedBaseThor` | 三态 | none | 基地普通档/雷神档在修队列加速方式 |
| `repairCsb` 修理范围 | 多选（仅 6 个雷神码） | 空 | 抢修车间：只收雷神，赛事窗口内一笔 1427 |
| `speedCsb` | 三态 | none | 抢修车间在修队列加速（1428/815 跨服） |
| `repairAva` 修理范围 | 多选（9 码） | 三军种普通兵 | 无双：修理免费，只按勾选排队（6311 族） |
| `speedAvaNormal` / `speedAvaThor` | 三态 | none | 无双普通档/雷神档加速（6312 族，钻石按模式倍率） |
| `goldDailyCap` 钻石日上限 | 数字（0=不限） | 0 | 全场地钻石加速共享的当日花销上限，按服务器日界归零 |

> 类型码：1 陆普通 · 2 陆雷神 · 3 海普通 · 4 海雷神 · 5 空普通 · 6 空雷神（`army.Data.type` 101/201/301 × `thor_group`/`glorious_science_group` 判定；雷神与超级雷神不会同时存在，已合并为单一「雷神」类型）。
> 节奏：治疗与加速在**同一拍内串联**——治疗落地后就地重读在修态补跑加速决策，不再等下一拍（见 §4）。
> 不进面板的内置项：`pollIntervalSec`（自愈轮询间隔，默认 60s）、抢修车间关闸前优先窗口（`cfg.csbClosingSoonSec`=600s）。
> 已废弃：`resourceRepair`（材料按用户口径视为充足，不再做持有量预算——服务器超限会拒绝且日志可见）、`commonRepair`/`thorRepair`/`speedCommon`/`speedThor`/`freeRepair`/`speedGold`/`speedItem`（v4 存档迁移一次性折算，见 `model/schema.js`）。

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

源码锚点：`RequestId`（协议号）、`WareHouseControllerNew.getQuickRepairTipsType`（择时判据）、`HospitalComponentNew.StartAllQueue·EndAllQueue`（写动作形态）、`UserData.getOrderQueuesByType·getArmyByArmyUuid`（现场态读）、`SpeedCDPanel.hospitalUseItemSpeed`（815 param 编码）、`AVAHospitalComponent`（无双三件套）、`WareHouseControllerNew.isBattleFieldHospitalValid`（1426 门控）、`GameDefine.ArmyType`/`ItemType.HospitalSpeedItem`。

---

## 2. 判据（只读）

- **普通兵每日免费额度** = `common_max - common_use`（实测本号 `common_max=77`，与英雄技能「免费修 77 个」一致）。雷神族 `*_max=0` ⇒ 雷神不可免费修。
- **择时**（镜像 `getQuickRepairTipsType(wait,max,use)`）：取不到 max/use 或 `wait<=0 || max<=0 || max-use<=0` ⇒ 不可修；`max-use>=wait` ⇒ 可全免；否则部分免。
- **本地待修队列**：直读 `UserData.OrderQueues`，过滤 `type===1(ORDER_TYPE_HEAL) && orderId!=="0"`：`state===0` 待修、`state===1` 修理中；`id` 即发包用的队列（槽）id。**去重令牌 = `id#orderId#endTime`**：① 槽 id 会被复用到不同伤兵（orderId 变），故含 orderId；② 同一部队（orderId 不变）会被反复打伤，每次受伤事件 `endTime` 变、而陈旧幻影（服务器已清、客户端未同步）`endTime` 不变，故含 endTime 以区分「需立修的再次受伤」与「须抑制的陈旧幻影」。
- **单位分类（军种 × 类型）**：军种 = `army.Data.type`（`GameDefine.ArmyType` 101 陆 / 201 海 / 301 空）；类型 = 普通（`thor_group===0 && glorious_science_group<=0`）/ 雷神（`thor_group>0` 或 `glorious_science_group>0`，包含原普通雷神与超级雷神，两者不会同时存在）。分类纯函数在 `model/classify.js`（`classifyUnit`/`tierOf`），不依赖 `FlameController` 单例；部队对象取不到时按 fallback 归并——本地/无双缺省「陆·普通」（不漏修普通兵），抢修车间缺省「雷神」（该场地只收雷神）。配置表对拍（解码 `config_optim2` 1.5.11775 / 1.5.12631）：`army_type_hospital===2 ⇔ thor_group>0`，177 行零违例（84xxxx 雷神 45 行 / 90xxxx 超雷神 132 行）；该列只是「雷神系」二值标签，医院代码不区分普通/超雷神（`FlameController.isFlameArmyById` 即 `thor_group>0`），故 `thor_group` 判据与游戏同源。
- **面板修理范围 → 类型码**：`code = 1..6`，按 军种×类型 顺序（见 §0）；`normalize` 把多选值过滤到场地可选集（抢修车间仅 2/4/6）并去重。决策侧 `repairIncludes(cfg, venue, arm, tier)` 逐条目判定。
- **钻石估价**：`max(1, ceil(在修剩余秒和 / 60 × GameTools.getDataConfigData(61017)))`（同 `getProfessionCDGold` 公式）。
- **815 param 编码**（源码 `SpeedCDPanel.hospitalUseItemSpeed` + 真人成功样本 `{itemid:510002,amount:9,param:null} s=0` 实证）：**本地全量 `param=null`**（`"0|0"` 会被服务器拒 `s=3/item_124017`）、本地单条=队列 `id`；跨服全量 `"1|0"`（或 `"1,"+armyType`）、跨服单条 `"1|"+queueId`。
- **战场抢修车间（1426）门控**（源码权威判据 `WareHouseControllerNew.isBattleFieldHospitalValid`）：`FunctionOn(cross_server_battle_hospital)` 且任一来源（`currentWorldMapCrossServerModel`/CQ25/CQ26 stormData）的 `HospitalEndTime - ServerTime > 0`；feat 优先 `game.get('WareHouseControllerNew')` 直调该方法，降级 `gameData.functionOnValue` 三态；两者都取不到 ⇒ 照旧轮询（宁多读不漏修）。无双模式在场时 1426 整体让位 6310 族。
- **道具加速枚数 = 时间池模型**（`speedItemNum`，普通医院 815 与无双 6312 共用）：服务器把 `amount` 理解为「枚数 × 单枚秒数」汇成的时间池，**按槽位顺序贪心消耗**（先修完队首、余额顺延下一条）⇒ 修完全部在修的最小枚数 = `ceil(Σ在修剩余秒 / para1)`，再受「持有量」与「单次上限」夹取。
  - 单枚秒数 = ITEM 行 `para1`（离线表值：510002=28800/8h、510001=3600、510000=300、15100046=3600）；`para1` 不可解（表列漂移）时**回退单枚旧口径**，宁少花不空转。
  - 枚数上限：医院 815 **只取 DATACONFIG `18002 useItem_num`（实测 10000）**——ITEM 行 `use_max=1` 是背包「使用」按钮的单次上限，**不约束医院面板的 N 枚同发**（真人 `amount=9`/`43` 均 `s=0` 落地）；无双 6312 无同量样本，仍按源码口径 `use_max || cfg(18002)`。
  - 实证链：逐枚场实录 1 枚的 10120 `endTime` 差分（首条清空、次条恰减 `28800-其剩余`：11775/6535/1307/13098 全部吻合）、清批场实录真人 `amount=9` 一次清空 15 条（15×≈17000s ≈ 9×28800）、跨服场实录 `amount=43`。
  - **在修秒和的前置闸（评审 M1）**：`baseRepairEntries`/`csbRepairEntries`/`avaEntries` 三处 `left` 在 `serverTime` 不可判定（≤0/NaN，`gameData.serverTime()` 契约就是「取不到返 0」）时**一律为 0**。因为 `endTime - 0` 会退化成 epoch 秒（单条≈1.79e9），而池模型的枚数 = `ceil(Σ/para1)` 会被夹到持有量⇒一笔打光背包道具。旧行为对钻石估价是 fail-safe（高估→余额不足→静默），对道具枚数则变 fail-open，故时间不可判定 = 视为「不在修」（同文件 `warFever()`/`nextDailyResetTs()` 的早退纪律）。

---

## 3. 决策分层（`planOnce`）

按场地逐层，条件不过即静默（日志带 `reason` 字段定位静默期）。决策拆为纯函数：`model/entries.js` 把三个场地的原始队列投影成「带军种/类型的条目」（`baseWait/baseRepair/csbWait/csbRepair/avaWait/avaRepair`），`venues/base.js·csb.js·ava.js` 各自产动作，`planActions` 只做编排 + 共享预算（`venues/shared.js` 的 `makeBudget`：钻石余额、普通医院道具池、无双道具池）。

1. **基地修理厂（`planBase`）**：修理 = `baseWait` 条目按 `repairBase` 过滤后**一笔 220 全发**（服务器内部先扣免费额度、超出扣材料；不再按材料持有量预算、也不拆免费/资源两批——两批拆分存在「第一批修好 → 回灌遗忘 → 陈旧 push 推回 → 第二批重开修理」的幻影重烧窗口）。
   加速 = `baseRepair`（state1）所有在修队列；方式按类型档取 `speedBaseNormal`/`speedBaseThor`：
   - 全部队列方式一致 → 全量一笔（151 钻石 / 815 道具 `param=null`，道具时间池不浪费）；
   - 两档方式不同 → 逐队列点名（124 `{id,useGold:1}` / 815 `param=队列id`），道具逐队列 ceil 折算的余量浪费只在该场景付。
2. **战场抢修车间（`planCsb`）**：门控关闭/不可判定 → 记 `csb: gate closed (1426 skipped)` 整轮静默。开窗时修理 = `csbWait` 按 `repairCsb` 过滤一笔 1427（`id` 混入本地必拒）；加速 = `csbRepair` 全部一笔（1428 钻石 / 815 跨服 `param="1|0"`），方式单键 `speedCsb`。**关闸前优先**：`csbDeadline` 进入 `cfg.csbClosingSoonSec`（600s）时，编排顺序改为 抢修车间 → 基地 → 无双，抢先把将随关闸损毁的队列修完/加速。
3. **无双修理厂（`planAva`）**：`avaReadOk=false` 整层静默。修理**免费**，只看 `avaWait` 是否被 `repairAva` 选中——全选一笔、部分选择按类型档分批（雷神子集 kind 带 `-thor` 后缀，6311 族 `{ids}`）；加速按 `speedAvaNormal`/`speedAvaThor` 分批（6312 `{ids,useGold:1}` 钻石 / `{ids,itemId,num,useGold:0}` 道具），钻石估价 = 基价×模式倍率（见 §1），道具 `atomic`（按 Σleft 池级折算、不可拆子集）；none 档记 `N queue(s) speed none`。
4. **钻石预算（全场地共享）**：`makeBudget` 的 `gold` 在一轮内被三场地累计扣减，同拍多笔不会超支；日上限 >0 时 `snapshot` 先按日账（`core/daily-stats.js`，服务器日界归零）把 `gold` 钳到 `min(余额, cap - 当日已花)`，日账未读回前 `gold=0`（钻石分支静默一拍，安全优先）。余额不足记 `gold X < estimate Y (域)`。
5. **道具枚数按 §2 时间池模型一次折算发足**（`num = min(ceil(leftSec/para1), 持有量, 单次上限)`），日志 label 形如 `item speed base #510002 x9 (held 100; leftSec 255000)`；折算为 0（持有空/秒数不可用）时静默记 reason `item speed num=0`。普通医院道具池（base/csb 共用背包同一行）与无双道具池（专行 15100046）互不挪用。

---

## 4. 调度与防重（三场景统一：push 边沿 + 在途令牌确认清除，无抑制时钟）

> **修正十八总纲**：本节的去重与节拍模型已由「push 边沿触发 + 完全无时钟的在途令牌（pending，仅由权威读确认清除、无 TTL）」统一重写，取代此前分层抑制窗（`speedGateMsFor` 的 45s/10s 整批窗、`markHealed`/`markDeadSlot` 的 5min/30min、`RECENT_SEND_TTL_MS`/`SPEED_FALLBACK_MS`、5s 勤扫 `ACTIVE_TICK_MS`）与 `pruneAvaFp`/`avaActiveIdSet`/`SPEED_FULL_FP_KINDS`。以下各条为新模型；历史条目（修正二～十七）保留作演变记录，其中涉及时钟/整批窗的描述已被本节取代。

- **节拍（去勤扫）**：`snapshot → planOnce` 每拍跑一次。`nextDelayMs` 无论忙闲一律返回慢心跳 `max(IDLE_TICK_MS, pollIntervalSec*1000)`（内置下限 60s），连续被拒达 `REJECT_STREAK_LIMIT`（3）次时×2 退避；快照形参保留但不参与判定（免为「有没有活」多花一发读）。即时性完全交给 push 边沿，丢推最坏等一个慢心跳兜底。
- **push 边沿唤醒**：`ctx.on.push(10120/13006, kick)` 即时 `cycle.kick()`；无双四模式队列变化 push 全订（21203 NewCAB / 21211 TM / 21465 Master / 21562 Legend，均 ResponseId 实证；只当唤醒提示、非本场模式的号不会到达，多订无副作用）；退订由 reactor 统一登记。**任一写动作成功后同样 `kick()`**，尽早拿到「确认读」缩小在途窗（与竞品 B 事件驱动同构）。因 `createCycle` 单飞：在飞期间的 `kick` 只置 `pending`，故 `cycleRun` 尾部必须读 `cycle.pending` 进「立即补一拍」（与全仓 22 个 feat 同模），否则写后 kick / 战场高频 push 会被吞、退化为只能等慢心跳。
- **修理与加速同拍串联**（`planOnce` 二次决策，真机灰度修正十四②）：本拍快照在治前读，`snap.repairing` 不含刚开修的队列 → 旧实现会整拍静默等 `nothing under repair`。现改为：`execActions` 逐条发本拍动作并回报是否「治疗层落地」（`HEAL_LANES`：`heal-local`/`heal-cross`，不含无双 cure）；落地后用 `speedSnapshotAfterHeal(snap)` **纯本地**重读 `healQueues()` + 在修秒和（零网络；本地 220 成功已 `syncLocalQueues` 回灌 `OrderQueues`，故即时可见在修态），再跑一次 `planActions` 但只保留加速类动作（kind 非 `heal-*`）。拍内逐条发包仍隔 `INTER_SEND_MS`（1s）、`ctx.alive()=false` 即时中辍。跨服在修秒和沿用本拍 1426 读数（战场队列只能等下拍权威读）。
- **在途令牌去重（无 TTL，`markPending`/`isPending`）**：所有抑制墙钟全废，改为「在途令牌 pending，仅由权威读确认清除」。去重键 = `动作名|去重令牌`（`sentFp` 表，值恒 `Infinity` 永不到期）：
  - **逐令牌动作**（heal-local/heal-cross/heal-ava/heal-ava-thor/speed-gold-ava/speed-gold-ava-thor/speed-item-ava/speed-item-ava-thor）：`execAction` 成功后 `markPending(fp, 实发令牌)`；入口对 `dedup` 逐令牌 `isPending` 过滤，只发未在途子集，全部在途则整动作 `skipped`。本地治疗令牌沿用 `id#orderId#endTime`、跨服沿用 `id#army#et`、无双沿用 plain `id`。**例外：`speed-item-ava` 标 `atomic`**（道具 `num` 按全集 Σleft 池级折算、不可拆子集）——任一令牌在途即整域 skip，避免按全集 num 只加速部分队列而超烧非幂等道具（钻石 `useGold` 逐队列计费、仍可拆子集）。
  - **全量不点名动作**（`body={{}}` 的 151/1428 钻石、815 道具本地/跨服全量）：动作带 `all:true` + `pendingTokens`=本拍快照里该域 state1 活跃 id 集；`execAction` 入口只要 `pendingTokens` 里**任一**令牌仍在途即整域 `skipped`（全量不可拆子集，绝不第二枪），成功后 `markPending(fp, pendingTokens)` 逐项登记、可被逐项确认清除。
  - 业务拒绝（`rejected`/`not-sent`/`param error`）路径**不再登记任何时钟抑制**：`not-sent` 由 kick/心跳自然重试；`rejectStreak` 仅用于心跳×2 退避。
- **确认清除（`prunePendingByExit(族, 活跃集)`）**：`snapshot` 每拍三场景权威读后分别按族遗忘「已退出目标 state」的在途令牌（六族代号见 `FP_FAMILY`：lw/cw/aw=本地/跨服/无双治疗，lr/cr/ar=本地/跨服/无双加速）。治疗族确认集 = state0 待处理令牌集，加速族确认集 = state1 在修令牌集；他族令牌不受本族 prune 影响。6310 读 OK 但 `list` 缺席/非数组时**不 prune**（避免形态漂移误清在途）。
- **三场景活跃令牌集（供上述 prune，派生自权威读、零额外发包）**：三个场地各只经 `model/entries.js` 投影一次——治疗族取条目的 `key`（本地 `id#orderId#endTime`、跨服 `id#army#et`、无双 plain id），加速族取条目的 `id`（plain id）；与 `venues/*` 发给服务器的 `dedup`/`pendingTokens` 同源同对象，令牌口径不再有第二处实现。
- **无双去重**：`heal-ava`/-thor（aw）与 `speed-gold-ava`/-thor、`speed-item-ava`/-thor（ar）均走逐队列 `id` 令牌 pending——令牌在其目标 state（待修 state0 / 在修 state1）退出权威读前恒在途，故非幂等烧道具的 `speed-item-ava` 天然防重烧（无需旧的 `SPEED_FULL_FP_KINDS` 整批 + `SPEED_FALLBACK_MS`）；同队再次受伤 → 该 id 退出 state0 → prune 遗忘 → 即时放行。
- **批量 param error 逐 id 隔离**（`bisectHeal`，真机灰度修正四）：220 为**原子批量**——含一个空槽/无效 id 会连累整批被拒。被 `common_159995` 整批拒绝时**逐 id 单发**：单发成功者 `markPending` 并按 `syncLocalQueues` 回灌确认；单发仍 param error 者**不登记任何抑制**（旧 `markDeadSlot` 30min 长抑已废除）——若回灌能确认其退出 state0 则被 prune 自然遗忘，否则依无时钟模型在下次事件重试（可接受，见风险）。抽出 `isParamErrorRet`/`isHealBatchCmd` 仍在。
- **幻影根治：回灌 `UpdateOrderQueues`**（`syncLocalQueues`，真机灰度修正六）：本地治疗/钻石加速（`heal-local`/`speed-gold-local`）成功后，借用游戏官方应答回调同款 `UserData.UpdateOrderQueues(resp.queues/orderQueues)` 把服务器权威队列按 `id` 就地覆盖回灌本地态——它**不是时钟、而是本地流的「确认」源**：回灌后该队列退出 state0/state1，正是 `prunePendingByExit` 遗忘其本地在途令牌的确认来源。`LOCAL_SYNC_KINDS` 只放行本地流；本地道具 815 应答不含队列（实录 34/34 仅 `{itemId,amount}`）、跨服/无双不回灌，各靠本场景每拍权威读（10120/1426/6310）确认。符号缺失/异常 `try/catch` 静默降级。

---

## 5. 生命周期与合规

- reactor 托管：`places:['base','world']`、`kinds:['homeland','wushuang','kvk','sphere','adp_war']`、`offInCombat:false`（战斗设置类，战斗模式下照常修）；秘境（pab）由 world 门控隔离不放行。`pause` 后 `ctx.alive()=false`，cycle 与在飞 await 自然停摆。
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

- **单测**：
  - [`tests/feats/quick-repair-model.test.js`](../../tests/feats/quick-repair-model.test.js)：纯模型（`classify`/`cost`/`quota`/`gates`）——单位三档分类、钻石/道具估价、1785 额度投影、抢修车间窗口判定与关闸前阈值。
  - [`tests/feats/quick-repair.test.js`](../../tests/feats/quick-repair.test.js)：桩化浏览器全局后动态 import，断言 `normalize/defaultConfig/migrateConfig`（v1→v3、v2→v3、v3 不动）、类型码/场地选集、`entries` 队列投影、`planBase/planCsb/planAva` 三场地决策（220/1427/6311 不串道、全量与逐队列、预算共享、`atomic`）、`planActions` 编排（关闸前优先、同拍预算共享）、在途令牌/confirm 放行、`itemSpeedParam`/`takeItem`/`speedItemNum`/`nextDelayMs`。
  - 命令：`node --test tests/feats/quick-repair.test.js tests/feats/quick-repair-model.test.js`（仓内 `npm test` 全量覆盖）。
- **对拍**：[`scripts/verify-manifests/quick-repair.mjs`](../../scripts/verify-manifests/quick-repair.mjs)（CMD_/PUSH_ 协议字典直 import feat 的 `constants.js` 共用同一份——B6 就近收编后纯常量模块可直 import，cs-hunt 同款；调参 `ORDER_TYPE_HEAL`/`INTER_SEND_MS`/`IDLE_TICK_MS` 留 index.js，仍从源码文本正则抽取（`featNum`/`featNumExpr`），抽不到即抛）→ `npm run verify:quick-repair`。HARD 维度：D1 载荷键集形态、D2 通道恒 `req:send`、D3 修理目标来源闸（反向防误发）、D7 无双载荷形态、D8 无双 ids 来源闸、**D10 815 医院加速道具形态**（键集 `{amount,itemid,param}`、`amount` 为正整数枚数、param 不得取 feat 源码记载的必拒形态 `"0|0"`）；SOFT/观察：D4 免费额度守恒、D5 前向完备、D6 应答配对、D9 无双队列态、**D11 815 枚数-持有守恒与批量度**（同 itemid 相邻笔用应答回读的剩余持有算降幅，并报 amount 区间/多枚同发笔数/最长「单枚连发」簇）、**D12 治疗→加速同周期节奏**（治疗后首笔同域加速间隔分布，≤`INTER_SEND_MS` 计拍内、≤`IDLE_TICK_MS` 计 push 边沿/心跳内（修正十八去勤扫后无 `ACTIVE_TICK_MS` 档））。医院加速道具样本靠「param 形态 + 应答 `{amount,itemId}` 回读签名（子集判定）」鉴定，不钉 itemid/para1 字面（避免与 feat 分叉）；已知局限：无 `param` 键的 815（全库 21 笔，如 `1700039/600001/5101101`）应答键集也是 `{amount,itemId}`，与「医院侧 param 漏发」不可区分，故该回归由单测而非对拍拦截。已实跑：清批场（真人 amount=9）/ 逐枚场（逐笔 1 枚 ×34）/ 跨服场（amount=43）/ 旧引擎逐枚场均 EXIT=0；负样本场（旧版 `param:"0|0"` ×5）能把 D10 扫红。

---

## 8. 变更记录

- **2026-11-25 v3 三场地全配（基地 / 战场抢修车间 / 无双；军种×类型 + 钻石日上限）**（用户需求：按真实游戏修理单位重构，面板全配）：
  - 面板：`commonRepair/thorRepair/speedCommon/speedThor` 两开关两 select → 三场地各「修理范围多选（类型码 1..6；抢修车间仅雷神 3 码）+ 加速三态（基地/无双分普通档/雷神档，抢修车间单键）」，新增 `goldDailyCap` 钻石日上限（全场地共享、服务器日界归零、0=不限，日账走 `core/daily-stats.js`）；`pollIntervalSec` 保留但默认 60s、上限 3600s。
  - 模块拆分：`model/`（`classify` 军种×类型两档 / `schema` 类型码·归一·迁移 / `entries` 队列投影 / `gates` 抢修车间窗口 / `cost`·`quota`·`kinds`）与 `venues/`（`base`/`csb`/`ava`/`shared` 预算与 param 编码），`index.js` 只留协议收发/编排/生命周期。manifest 契约（`ORDER_TYPE_HEAL`、`INTER_SEND_MS`、`IDLE_TICK_MS`、文档串）不变。
  - 行为变化：① 修理范围只按勾选集合过滤，**不再做材料持有量预算**（`resourceRepair` 废弃，服务器超限会拒绝）；② 无双修理明确免费、只按勾选排队；③ 抢修车间关闸前 10 分钟置顶；④ 无双加速不再与本地互斥「钻石优先」，而是按类型档各随其方式（6312 带 `{ids}` 天然支持子集）。
  - 存档：`version: 4`；`migrateConfig(c, fromVersion)` 把 v1/v2 旧开关展开到三场地类型码集合，v3 九码映射为 v4 六码（super合并到 thor）；fresh install 保持默认不被推断覆盖。
  - 模块规范收口（同日晚）：`index.js` 内与 `model/entries.js` 重复的 18 个队列投影纯函数（`splitWaitIds`/`localWaitTokenSet`/`splitRepairingByType`/`crossWait*`/`avaWait*`/`repairingLeftSec` 等）全部删除，snapshot 只保留 `entries` 投影 + `tokenSet`/`idSet`/`sumLeft` 三个投影小件；`pickSpeedItem` 去掉已废弃的 `keepItemNum` 形参；`army_type_hospital` 配置表对拍证据写入 `classify.js` 头注与 §2。
  - 验证：`quick-repair.test.js` 54 + `quick-repair-model.test.js` 15 全过；`npm run format:check && npm run lint && npm test && npm run arch` 四门禁全绿（全量 794）。`verify:quick-repair` 需本地 dashcam 录制，随 P0 实录刷新后复跑。
- **2026-11-21 无双按兵种拆分：修理随 commonRepair/thorRepair、加速随 speedCommon/speedThor（修正二十）**（dashcam 录制+日志双轨诊断，用户报「快速修理在无双下不工作」）：
  - 诊断：录制 `dashcam-rec-20261121T190208-普通无双` + 同日日志对拍——feat 发 4 笔 6311（31+23+10+2 ids）全 ret:0，逐笔探针对拍确认下一拍 6310 权威读里同批 id state0→state1，**修理线正常**；全程零 6312，每拍刷 `speedCommon not gold (ava)`/`speedCommon not item (ava)`。根因=无双队列此前整体跟随 `speedCommon`，用户配置 sc=none → 加速线被闸；无双队列 durationTime≈12h 不加速即困在医院，用户被迫手动钻石加速（同日 18:17 场录制 5 笔游戏自发 6312 `{ids,useGold:1}` ret:0 实证，形态与 feat 的 `speed-gold-ava` 完全一致）。
  - 设计前提修正（用户领域知识）：无双修理厂可区分普通兵/雷神兵（6310 队列 id=部队 uuid，按 `getArmyByArmyUuid().Data.thor_group>0` 判定），推翻旧定稿「无双队列无法可靠区分兵种故整体跟随 speedCommon」。
  - 修正：① 新增纯函数 `avaWaitIdsByClass`/`avaRepairingByClass`（6310 list 按兵种拆分+逐类剩余秒和，注入 `thorOfOrderId`，部队对象取不到归普通、与本地 `splitRepairingByType` 缺省一致）；② `planAvaActions` 重写——修理按类 gate（普通子集 `commonRepair&&resourceRepair`、雷神子集 `thorRepair`），加速按类各随 select，合并一笔条件=两类都开（修理）/方式相同或仅一类有在修（加速），钻石预算共享 budget `{gold,item,si}` 投影；③ 新增 kind `heal-ava-thor`/`speed-gold-ava-thor`/`speed-item-ava-thor`（FP_FAMILY 映射 aw/ar、ITEM_SPEED_KINDS 收编，令牌/prune/道具 atomic 语义与主 kind 同）；④ 快照装配拆分字段 `avaWaitCommonIds`/`avaWaitThorIds`/`avaRepairingCommonIds`/`avaRepairingThorIds`/`avaRepairingLeftCommon`/`avaRepairingLeftThor`（全集字段保留供 prune/对拍）；⑤ 面板 hint 与本文同步（commonRepair 兼管无双普通兵、thorRepair 兼管无双雷神、加速 select 按类归属；§0/§3 顺带把加速层旧 speedGold/speedItem 描述订正为现行 speedCommon/speedThor 口径）。
  - 保留：本地/跨服行为零变化；6310/6311/6312 协议形态不变 → 对拍 D7/D8 判据不受影响（子集⊆全集）。
  - 验证：`node --test tests/feats/quick-repair.test.js` 67/67（FP_FAMILY 三新 kind、分类纯函数（含缺省归普通）、sc=none/st=gold 分流+合并全量、修理按兵种分流）/ 全量 725/725 / lint 0 error / build Done / `verify:quick-repair` 印石场 + 无双三场（20261108T180936、20261121T181703、20261121T190208）全部关键不变量通过（D7/D8 无违例）。
- **2026-11-14 单笔 220 全发：学竞品 B 废免费/资源两批拆分（修正十九，幻影重烧根治）**（用户指令「学竞品B」，报文实证确认浪费后实施）：
  - 动机：dashcam 录制（`dashcam-rec-20261114T195030-印石-我的日常`）铁证——旧两批拆分（先 `heal-local` 免费批 → 约 1.3s 后 `heal-local-resource` 资源批）存在幻影重烧窗口：免费批 220 resp 77/77 orderId=0（已修好）→ `syncLocalQueues` 回灌 → `prunePendingByExit` 遗忘令牌 → 陈旧 10120 push 把同槽推回 orderId≠0/state=0 → 资源批当新伤放行 → 服务器不校验「刚修好」直接重开 17030s 满额修理 → 151 全量加速对全部 90 队列收满额费（单价 1.72 与后续批次一致，证明 77 幻影也被全额计费），浪费 ~132 钻 + 2205 雷神元素中一部分 + 77 次免费额度。
  - 竞品 B 对照：`hospitalStart` 一笔 220 全发 state0（不拆免费/资源，服务器内分额度）+ 200ms 防抖读终态 + 纯事件驱动——架构上不存在两批中间态，故无幻影窗口。
  - 修正（学竞品 B 单笔全发）：① 新增纯函数 `budgetHealIds(split, freeLeft, resourceRepair, costOf, holdingOf)`——免费额度覆盖前 freeN 个（零消耗恒可发）、付费段按 `repair_cost` 累计持有量筛可负担、`resourceRepair` 关（旧存档）只发免费段；② `snapshot` 据此预算 `healIds`/`healKeys`（取代旧 `payIds`/`payKeys`，且不再仅在额度耗尽时预算）；③ `planHealActions` 第 1 层合并为单一 `heal-local` 动作（label `heal N/M`），**`heal-local-resource` kind 删除**（`FP_FAMILY`/`LOCAL_SYNC_KINDS`/`HEAL_LANES` 同步移除）；④ 服务器侧语义不变：220 内部先扣免费额度、超出扣材料（同游戏一键修理）。
  - 结构性效果：同拍内不再有「第二批重修第一批刚修好的队列」，幻影重烧窗口从根消除；回灌/确认清除/同拍修理→加速串联全部保留（单笔回灌一次确认全部队列，终态读更稳）。面板三个付费开关与免费/资源恒开语义不变。
  - 保留：发包 body 协议形态（220 `{ids}`）不变 → `verify:quick-repair` 对拍判据不受影响（D1/D3 协议级、不询问动作 kind）；雷神批（thorRepair 独立开关、与普通集不相交）/跨服 1427/无双三件套均未动。
  - 对拍 manifest 适配（B6 遗留分叉修复）：B6 常量收编（cecf36e）把 CMD_/PUSH_ 迁入 `constants.js` 后 manifest 仍用正则扫 index.js 找本地 `const`，`verify:quick-repair` 抛「判据字典与 feat 分叉」拒跑（B6 门禁漏跑 verify 所致，非本轮引入）。按 cs-hunt 既定模式改直 `await import` `constants.js`（25 个 CMD_/PUSH_ 共用同一份），调参三个保留 `featNum`/`featNumExpr` 正则抽取；§7 字典来源描述同步。
  - 验证：`node --test tests/feats/quick-repair.test.js` 54/54（新增 `budgetHealIds` 免费前缀/付费可负担/零消耗/超总额四组断言；`planActions` 改 healIds/healKeys 入参；`FP_FAMILY`/`LOCAL_SYNC_KINDS`/`HEAL_LANES` 断言 heal-local-resource 已删）/ lint 0 error / prettier clean / build+arch / `verify:quick-repair` EXIT=0。
- **2026-11-11 三场景统一：push 边沿触发 + 确认清除去重（修正十八，最纯模型，取代修正十五/十六/十七的分层抑制窗）**（用户指令，方案批准）：
  - 动机：把本地普通医院 / 跨服战场 / 无双 AVA 三场景 × 治疗/钻石加速/道具加速三动作统一到单一模型：「只在 push 事件（kick）跑一拍 + 一个很慢心跳兜底丢推」 + 「所有抑制时钟全废、改在途令牌 pending（仅由权威读确认清除、无 TTL）」。
  - 不变式：新令牌（从没在途过的队列）即时放行；已发未确认的令牌绝不第二枪；令牌只在其「目标 state 退出权威读」时遗忘。
  - A 触发：`nextDelayMs` 去勤扫（恒返回慢心跳，重拒 `streak>=REJECT_STREAK_LIMIT` 时×2 保留），`ACTIVE_TICK_MS` 删除；`execAction`/`bisectHeal` 任一写成功后通用 `kick()`（不仅 AVA）。首拍由现有 push 订阅（10120/13006/AVA change×4）+ `createCycle` 起始一拍驱动。
  - B 去重原语：新增 `markPending(fpKey, tokens)`（`sentFp[fp|tok]=Infinity` 永不到期）、`isPending(key)=!!(key in sentFp)`；**删除** `RECENT_SEND_TTL_MS`/`SPEED_FALLBACK_MS`/`HEAL_STALE_SUPPRESS_MS`/`HEAL_DEAD_SLOT_SUPPRESS_MS`/`markFp`/`suppressFp`/`markHealed`/`markDeadSlot`/`sweepFp`/`SPEED_FULL_FP_KINDS`/`speedGateMsFor`。
  - C 确认清除：`pruneAvaFp` 泛化为 `prunePendingByExit(族tag, activeSet)`（按 `FP_FAMILY` 前缀匹配、令牌∈活跃集则保留、否则删）；新增三场景活跃令牌集纯函数（`localWaitTokenSet`/`localRepairingIdSet`/`crossWaitKeySet`/`crossRepairingIds`/`crossRepairingIdSet`/`avaWaitIdSet`/`avaRepairingIdSet`）；snapshot 三处权威读后分别按 state0（治疗族）/state1（加速族）prune；6310 `list` 缺席/非数组仍不 prune。
  - D/E 全量动作：`body={{}}` 的 151/1428/815 全量取消 `|all` 记法，改为发送时把该域 state1 活跃令牌集整体 `markPending`（`act.all`+`act.pendingTokens`，由 `planSpeedActions`/`planAvaActions` 生成）；入口任一 pendingToken 在途即整域 skip（不可拆子集）。`speed-item-ava` 从整批并入逐令牌（6312 带 `{ids}`，注释订正）。本地回灌 `syncLocalQueues` 作为确认源保留（非时钟）。
  - 保留：所有发包 body 协议形态（cmd/字段）不变→`verify:quick-repair` 对拍判据不受影响；`speedItemNum` 枚数折算/`serverTime>0` 前置闸/`goldPlannedFor` 让位/`resourceRepair` 额度逻辑不动。
  - 已知代价（用户已明确接受）：① 比竞品 B 略保守——道具/钻石「部分加速未打满」时要等该队列退出 state1 才重新可操作（绝不第二枪）；② 失败动作丢推+不回灌+服务器异常叠加时可能卡到下次真正 state 变化或 reload；③ 去 `markDeadSlot` 后符号漂移使已空槽滞留 state0 会每次事件重试 param error；④ 丢推反应变慢，新伤兵最坏等一个慢心跳。
  - 验证：`node --test tests/feats/quick-repair.test.js` 55/55（删 `speedGateMsFor`/`markFp` 旧用例，新增 `FP_FAMILY` 全族/`markPending` 恒在途+`prunePendingByExit` 按族遗忘/活跃令牌集纯函数同形/全量 `all`+`pendingTokens`/`nextDelayMs` 恒慢心跳/speed-item-ava 逐令牌）/ lint 0 error / prettier clean / build+arch / `verify:quick-repair` EXIT=0。
  - 【修正十八补充·代码评审】（CodeReview 子代理，2 MUST / 1 SHOULD，三条已同批落）：
    - **M1（已修）**：`cycleRun` 未读 `cycle.pending` → 写动作后的通用 `kick()` 与在飞期间到达的 push 全部被吐（createCycle 单飞只置 pending），「写成功催一拍取确认读、缩小在途窗」机制整体失效、退化为只能等慢心跳。修：`cycleRun` 尾部补 `if (cycle.pending) return 0;`（与全仓 22 个 feat 同模）。
    - **M2（已修）**：`speedSnapshotAfterHeal` 只重算 `localRepairing`、`Object.assign` 把治前 `localRepairingIds` 原样带入同拍加速二次 pass →全量动作 `pendingTokens` 缺刚治好转入 state1 的队列 → 成功 `markPending` 漏登记它们→下拍仍见其 state1 即第二枪（双花钻石/重烧本地道具）。修：同源同拍补 `localRepairingIds: Array.from(localRepairingIdSet(queues))`。
    - **S1（已修）**：`speed-item-ava` 新增 `ids/dedup` 后，`execAction` 部分在途时会走子集过滤重写 `body.ids`，但 `num` 仍按全集 Σleft 折算→按全集枚数只加速部分队列→超烧非幂等道具。修：动作标 `atomic:true`，`execAction` 逐令牌分支中 `act.atomic && keep.length!==dedup.length` 即整域 skip（钻石 useGold 逐队列计费不受此限）。
- **2026-11-10 真机灰度修正十七（代码评审：本地道具线抑制窗 45s→10s 为回归、恢复；speedNeedsTimeGate→speedGateMsFor）**（CodeReview 子代理 + 实录复核）【已被修正十八的无时钟模型取代：`speedGateMsFor`/`RECENT_SEND_TTL_MS`/`SPEED_FALLBACK_MS` 均已删除】：
  - 发现的错认：修正十五声称“本地 151/**815** 应答确带 orderQueues、回灌成功即免闸”——用本仓实录 `dashcam-rec-20261108T173210` 直接否证：**815 应答 34/34 只含 `{itemId, amount}`（amount=背包剩余）、无一含 queues/orderQueues**（而 220 是 8/8 含）。因 `syncLocalQueues` 对 815 永远 `return false`，`speedNeedsTimeGate({speed-item-local}, false)` 恒 true→走 `SPEED_FALLBACK_MS`（10s）。即修正十五把本地道具线抑制从旧 **45s 无声降到 10s**。
  - 风险：道具是非幂等烧币、本地在修态只靠 push 10120 异步刷新；若某拍 push 未到（幻影仍在修），10s 就会按 `num=ceil(Σleft/para1)` 再烧一整池（旧 45s 才一次）。
  - 修正：`speedNeedsTimeGate(act,synced)`（返回 bool）重构为 `speedGateMsFor(act,synced)`（返回窗长）——本地钻石回灌成功→0；**本地道具 `speed-item-local`→`RECENT_SEND_TTL_MS`（45s 恢复）**；跨服钻石/道具与无双道具（每拍 1426/6310 权威读）→`SPEED_FALLBACK_MS`（10s）。另：6310 读 OK 但 list 缺席/非数组时补 `log.debug` 归因（不整清、避免误删在途令牌）；`execAction` 无双逐令牌族写成功后 `kick()` 催一次权威读、缩小 clear-on-absent 观测窗；`markFp` 的 `ms || 默认` 改 `ms == null ? 默认 : ms`（免 `ms=0` 被当 45s）。同步订正头部注释/§4/修正十五对“815 回灌”的错述。
  - 验证：单测 53/53（`speedGateMsFor` 改为断言窗长：本地钻石 0/本地道具 45s/跨服无双 10s/逐令牌与治共 0）/ lint 0 error / prettier clean / build Done / `verify:quick-repair` EXIT=0。
- **2026-11-10 真机灰度修正十六（无双去重：逐令牌 + 消失即遗忘；兼修正十五回归自查）**（用户问“无双还会等一段时间才修/才加速吗”）【已被修正十八的无时钟模型取代：`pruneAvaFp`/`avaActiveIdSet`/`avaFpShouldPrune`/`SPEED_FULL_FP_KINDS` 已删，无双三动作统一走 `FP_FAMILY` 逐令牌 pending + `prunePendingByExit`】：
  - 背景（修正十七订正）：原写“无双不存在 45s 整批闸”有误——HEAD `GOLD_SPEED_KINDS` 含 `speed-gold-ava`，旧 `execAction` 会为其登记 `speed-gold-ava|all` 的 45s 整批闸（这正是用户“加速要等一会”的根因）。无双仍有两处“要等一小会”：① 钻石/治疗整批闸 + 令牌在途压制到 TTL；② 修正十五删本地闸时把 `speed-item-ava` 一并移出 `SPEED_FULL_FP_KINDS`，使其失去抑制、可能逐拍重烧道具（回归）。
  - 实录实证（普通无双场 `dashcam-rec-20261108T180936` 6310 应答）：无双里 `id ≡ orderId`（同值）、state0 待修项 `endTime=0` ⇒ 令牌字段无法区分“同一部队再次受伤”（签名与首伤一致），不能靠字段升级判重。
  - 修正（两层）：① `heal-ava`/`speed-gold-ava` 改为**逐队列 `id` 令牌**去重（动作级补 `dedup: snap.avaWaitIds`/`avaRepairingIds`），并在 `snapshot` 权威 6310 读 OK 后新增 `pruneAvaFp(avaActiveIdSet(avaList))`——遗忘服务器已不再列出的无双令牌（clear-on-absent），使同一部队修完离开列表后再次受伤即时放行；② 道具 `speed-item-ava`（6312 非幂等）归回 `SPEED_FULL_FP_KINDS`，保留整批键 + `SPEED_FALLBACK_MS`（10s）。新增纯函数 `avaActiveIdSet`/`avaFpShouldPrune`/集合 `AVA_ID_FP_KINDS`（均导出供单测）。
  - 验证：单测 53/53（新增 `speedNeedsTimeGate` 无双钻石免闸/道具兜底、`clear-on-absent` 遗忘/保留/不误删、`avaActiveIdSet` id 集、planActions `dedup` 字段四组断言）/ lint 0 error / prettier clean / build Done / `verify:quick-repair` 全部关键不变量通过 EXIT=0。
- **2026-11-10 真机灰度修正十五（抄竞品 B：本地加速去掉 45s 整批时间闸）**（dashcam 实录取证，用户问“快速修理为何没立即修”）【已被修正十八的无时钟模型取代：`speedNeedsTimeGate`/`SPEED_FULL_FP_KINDS`/`SPEED_FALLBACK_MS`/整批键 `fp|all` 均已删除，改为无 TTL pending + 确认清除】：
  - 现象/根因：钻石加速命令 151（`speed-gold-local`）被 `speed-gold-local|all` 整批指纹（`RECENT_SEND_TTL_MS`=45s）闸门延迟——新入队伤兵即使权威读已看到在修，也被上一拍的整批键压住最多 45s 才放行；延迟出在 151 闸门，而非治疗 220 慢。
  - 对标竞品 B 口径：`hospitalEnd` 钻石线 `asend(ORDER_QUEUE_ING_DONE,{})` 后 `UpdateOrderQueues(L.orderQueues)`——钻石本地线确靠回灌作真相源。**但本仓实录证 815 本地应答不含 orderQueues（仅 `{itemId,amount}`），下面“151/815 都带队列”的断言仅对 151 成立、对 815 为假（已于修正十七恢复本地道具线长闸）**。（当时误判：以为本地 151/815 应答都确带 `orderQueues`、回灌后队列下一读即消失→天然不重发。）
  - 修正（最小方案）：`execAction` 成功路径改为先算 `synced = syncLocalQueues(act,ret)`，再按新纯函数 `speedNeedsTimeGate(act, synced)` 决定是否登记整批键——**本地流回灌成功→免闸**（新入队伤兵下一拍即被加速）；跨服/无双流与本地回灌失败才登记整批键，且窗口从 45s 降为 `SPEED_FALLBACK_MS`（10s，仅兜回灌失败/跨服无双的重复扣费）。新增导出 `SPEED_FALLBACK_MS`/`SPEED_FULL_FP_KINDS`/`speedNeedsTimeGate`，`markFp` 加可选 `ms` 参。防抖无需额外实现（`createCycle` 单飞 + pending 合并已内建）。道具线（815）保持全量修（与钻石全量口径一致，未改逐条发）。
  - 同拍双发自查：主 pass 的 151 与治疗后 post-heal 二次 pass 的 151 靠回灌去重（post-heal 重读 `healQueues()` 已看不到刚加速队列）→天然不重发；仅回灌失败才落 10s 兜底。
  - 验证：单测全过（新增 `speedNeedsTimeGate` 免闸/兜底/治疗类不登记三组断言）/ lint 0 error / prettier clean / arch clean / build Done / `verify:quick-repair` 全部关键不变量通过（发包 body 形态未改，对拍不受影响；D12 治疗→加速节奏为观察项）。
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
- **2026-11-08 真机灰度修正六**（幻影根治）：**从根消除陈旧幻影，不再靠“不重发”规避**。修正四/五只是把已治好幻影的重发频率/日志降噪，但客户端 `OrderQueues` 里那些槽永远显示待修（除非服务器 push 清洗）。参照游戏源码 `HospitalComponentNew`/`HospitalArmySelectPopup`（批量 220 应答回调里 `UserData.UpdateOrderQueues(o.queues)`）与竞品 B（`hospitalStart` 治后 `UpdateOrderQueues(M.queues)`、`hospitalEnd` 815/151 后 `UpdateOrderQueues(·.orderQueues)`），确认“直发后回灌应答队列”就是游戏官方的标准做法。用户批准 quickRepair 开只读例外：新增 `syncLocalQueues(act,ret)`，本地治疗/加速成功后调 `UserData.UpdateOrderQueues(respQueues)`（取 `resp.queues` 或 `resp.orderQueues`）把权威队列就地回灌；`LOCAL_SYNC_KINDS` 只放行 `heal-local`/`heal-local-thor`/`speed-gold-local`/`speed-item-local`，跨服流不回灌；符号缺失/异常静默降级，三层抑制降为兜底。`execAction` 成功行日志附 `(queues synced)`。新增导出 `LOCAL_SYNC_KINDS` 与契约用例（27/27 全过）。
- **2026-11-08 真机灰度修正五**（真人实录取证）：**已治好癕影每 5min 重投 param error、且污染 rejectStreak**。实测：全场景仅 1 个 push，槽 `353344`/orderId `59752`/endTime `1794075926` 于 ≈02:38（ts `713867`）被 220 **治好（s=0、orderId→0）**；因 direct-send 不回写客户端 `OrderQueues`、且再无 push 清洗，它在本地永远显示待修，之后每 ~300s（=`HEAL_STALE_SUPPRESS_MS`）重发一次→`s=3 common_159995`（streak #1…#8）。本质：该单位**服务器端已修好，非漏修**；param error 只是重投空槽。修正：新增 `markDeadSlot`——**单条（批量 n=1 或隔离后单发）治疗仍 param error ⇒ 确认陈旧幻影 → 延长抑制至 `HEAL_DEAD_SLOT_SUPPRESS_MS`（30min）、`debug` 记录、不计 `rejectStreak`**（真伤再发生→新 endTime→新令牌→即时放行，不会因长抑漏修）；`bisectHeal` 单发 param error 同步改走 `markDeadSlot`，仅当真业务拒绝才累加退避。抽出 `suppressFp(key,tokens,ms)` 共用。四门禁全绿（26/26）。
- **2026-11-08 真机灰度修正四**（真人实录取证，新代码 build 02:10:20 之后）：**reload 后陈旧幻影整批 param error，仍漏修**。实测：`353344`（endTime 变→新令牌）单独发 `689089/991518` 两次均 s=0 治好；而 `083784`/`781798914` 于 `717912`（旧代码）已治好，但 220 直发不回写客户端 `OrderQueues`、无 10120 push 清洗→它们永远是陈旧幻影；02:10:20 重载后内存 `sentFp` 清空，首拍就把这俩一起发 → `s=3 common_159995`，之后每 ~46s TTL 过期重试、`healed->[]` 永不停（param error 是拒绝、不触发只认成功的 `markHealed`）。修正：新增 `bisectHeal`——220/1427 被 `common_159995` **整批拒绝时逐 id 单发隔离**：真伤单发即时治好，确认幻影单发仍 param error 后 `markHealed` 延长抑制→后续拍指纹将其过滤在批外（兼治原子批量连累真伤的漏修）；单条 param error 也直接长抑。新增纯函数 `isParamErrorRet`/`isHealBatchCmd` 及用例（26/26 全过）。
- **2026-11-08 真机灰度修正三**（真人实录取证）：**同队再次受伤被误抑制→仍漏修 1 个**。实测：槽 `353344`/orderId `59752` 于 `689089` 治好（orderId→0），`717796` push 同一 orderId 又被打伤（endTime `1794074009`→`1794074689`）；修正二的 5min `markHealed` 按 `id#orderId` 长抑把这个“同队新伤”误拦→下一拍只发了另 2 个、`353344` 落回未修。修正：**去重令牌改为 `id#orderId#endTime`**——陈旧幻影（endTime 不变）仍命中长抑防 param error；再次受伤（endTime 变）为新令牌→即时放行。单测新增“同 orderId+endTime 变→键相异”用例。
- **2026-11-08 真机灰度修正二**（真人实录取证）：① **偶发漏修 1 个**——医院队列槽 id 被复用于不同伤兵，旧指纹只按槽 id 去重会误抑制「刚进同槽的新兵」；去重键改为 `id#orderId`（新 orderId→新键→即时放行）。② **220 `common_159995` param error 死循环**——治疗成功清空槽后，客户端本地 `OrderQueues` 滞后仍报同一 `id#orderId` 待修，45s TTL 过期后反复去修空槽（220 原子批量还连累同批可修的兵一起失败）；改为成功应答里 `orderId→"0"` 的 `(id#orderId)` 延长抑制至 5min（`markHealed`）。免费额度实证充足（`common_use` 仅 5~12，非额度问题）。
- **2026-11-08 真机灰度修正**（真人实录取证）：① 815 本地全量 `param` 由 `"0|0"`→`null`（真人 510002 成功样本对照，原值被服务器 `s=3/item_124017` 拒）；② 本地雷神不再误发 1427，改走 220（与竞对 B/源码一致，避免服务器拒并污染退避）；③ 钻石估价本地/跨服分域（原双计全量会使日预算提前触顶）；④ 在途指纹去掉整批键对逐 id 动作的一票否决，新伤兵即时放行。
- 初版落地：freeRepair/thorRepair/speedGold/speedItem 四分支 + 兜底轮询；免费线默认开、付费线默认关；build/lint/test/对拍四门禁通过。
