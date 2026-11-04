# 异能秘境自动驾驶 v4：竞品B `enigmaSecret` 逐行映射（重写施工图）

> 起因：用户决定废掉 `pilot.js` 现有决策/执行逻辑，**完全按竞品B 的自动开车重写**，并要求产物符合本仓架构规范。
> 本文是施工图，不是方案书：每条都带竞品行号 + 我方落点 + 缺口标记，照图施工不应再做决策。
> 竞品参照：`references/竞对逆向/竞品B/assistant/payload/server-js.js` L24138–25650（`helper.pro.misc.enigmaSecret`）。
> 术语：`竞品行号` 均指 server-js.js；`我方落点` 均指 `extension/src/feats/activity/secret-realm/` 下文件。
> **报文核对（2026-11-03 用 `20261101T200401` 录制复核）**：竞品全程用枚举名 `NWorldMapEntityType.PAB_*`（L24804/24834/24966/25280），从不写死数字。三方互证（竞品读字段 × 录制 m 键 × 我方 constants）已确认我方 `constants.js` 的 `PAB_DROP=163 / PAB_MONSTER=172 / PAB_RESOURCE=173 / PAB_SHOP=161` 全对。⚠ **落地硬红线：新 pilot.js 一律引用常量名，禁止出现裸 pointType 数字**（本图早期正文曾把野怪误写成 163，已订正）。实测：`callTId` 落在 **172**（命中 3016/21212，非"待验"）；`163(PAB_DROP)` 带 `teamId`(归属)+`iNum` 无 callTId；`173` 的 `esrId∈{12,14,16,17,18,19}` **多变→回合闸是真实硬闸必须保留**；`161(商店)` esrId 恒 2。

---

## 0. 30 秒摘要

竞品这套的逻辑量其实很小：**一个 200 拍的主决策 + 三个布尔网关 + 五个选点函数 + 一张 cd 账**。
它之所以"能开到该去的地方"，靠的不是算法强度，而是三条执行模型选择：

| #   | 竞品的选择                                                  | 我方现状                                                | 证据                                                               |
| --- | ----------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | **`await` 串行**：901 拉完才选点，选完才发 8521             | `#refreshView` fire-and-forget，同拍派发 → 决策吃陈旧池 | 竞品 L24723-24758；我方 pilot.js L2328/L2377                       |
| 2   | **节拍全靠 `cd_time`**（服务器秒），tick 只是扫描线         | 节拍靠 `Date.now()` + 5s 定拍 + 90s TO 睡               | 竞品 L25250-25283；我方 `tuning.driveScanMs`/`driveMarchTimeoutMs` |
| 3   | **筛子极窄**（`iNum`/`state==0`/`teams==0`/`marched_list`） | 七道闸（多 `rTime` 双职责 + `consumed` 10min 黑名单）   | 竞品 L24734-24737；我方 `#pickResource` L1529-1639                 |

**重写 = 把这三条换掉，其余照搬。** 本文第 2、4、5、6 节逐条给出落点。

---

## 1. 范围边界（先钉死，避免"全部"失控）

竞品 enigmaSecret 的 1500 行由四块组成，本次只重铸第 2 块：

| 块                  | 竞品位置                                                                                                                                                                                                                                                                                                                         | 本次处置                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 世界图组队进秘境 | `teamDispatch` L24533-24557、`fastTeam` L24319、`createTeam` L24328-24371、`teamApply` L24373-24404、`teamAgree` L24406-24418、`kickMember` L24420-24433、`sendArmy` L24435-24505、`sendChatTips` L24507-24520                                                                                                                   | **划出本次范围**，另立 feature。附录 A 留摘要备查                                                                                                                                        |
| B. 秘境内主决策     | `exitStage/shopStage/beastStage` L24560-24594、`getTeamInfo` L24595-24618、`getBossInfo` L24619-24668、`checkPowerGap` L24690-24706、`marchResource` L24708-24770、`marchBeast` L24772-24826、`marchTeam` L24827-24838、`marchShop` L24840-24849、`marchPlane` L24850-24872、`marchBoss` L24873-24880、`autoLeader` L24882-24985 | **本次重写 = 这一块**                                                                                                                                                                    |
| C. 到点分派与干活   | `onPabTeamMarchArrive` L25250-25282、`getResItem` L25127-25193、`shopConver` L25194-25230、`getDropBox` L25080-25126、事件处理 L25283-25341                                                                                                                                                                                      | **只改语义**（cd 公式、空位数折算、自愈补拉），实现继续复用 `pickup.js`/`shop.js`/`boss.js`/`leave.js`                                                                                   |
| D. 杂项分频任务     | `scoutBeast` L25004-25030、`recuperate` L25029-25054、`capturePet` L25055-25079、`judgeLeave` L24987-25003                                                                                                                                                                                                                       | 逐条判：`recuperate`→已有 `heal.js`；`scoutBeast`→已有 `scout.js`；`judgeLeave`→已有 `leave.js`；`capturePet` 竞品是 `cc.find()` 节点反射，**不学**（`capture.js` 保持现有 ui 事件通道） |

**必须删掉的我方包袱**（重写时不要顺手带走）：
`judgePower`（竞品 L24669-24689）是**未完成的死代码**——引用未定义变量 `e/i/t`、无 return、全仓无调用点。别照着实现。

---

## 2. 执行模型：从「返回睡眠时长」改为「cd_time 门控 + 心跳拍」

### 2.1 竞品原样

```
L25437  start()      : this.timer ||= setInterval(this.schedule.bind(this), 100, {counter:0});
L25379  schedule(e)  : if (!this.busy) { try { this.busy=1; e.counter++; if (active) await execute(e.counter) } finally { busy=0 } }
L25369  execute(n)   : isWorldMap||isKvkMap ? (state.shops.length==0 ? teamDispatch(n) : 什么都不做) : roomDispatch(n)
L25342  roomDispatch : n%1→getDropBox 100ms · n%2→autoLeader 200ms · n%2→capturePet · n%2→recuperate
                       n%3→shopConver 300ms · n%8→getResItem 800ms · n%9→scoutBeast/judgeLeave 900ms
```

关键点：**因为 `autoLeader` 里的 `marchResource` 会 `await asend(901)`，`busy` 锁让整条 100ms 心跳链在 901 在途期间全部跳过**。所以竞品的真实节拍 = 901 的 RTT（实测 38~45ms），不是 200ms。

### 2.2 我方落点（架构约束下的等价实现）

**不换调度原语。** `core/cycle.js` 的「单飞闸门 + 触发合并 + 看门狗」正是竞品 `busy` 锁的强化版（不空轮询），保留。要改的是 `#tick` 的契约：

| 项                 | 现状                                   | 重写后                                                                                                                                                                              | 理由                                                                             |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `#tick` 是否 async | 同步（返回下次睡眠 ms）                | **async**，在 `#pickResource`/`#pickPlane` 内 `await env.secret.queryWorldView(...)`                                                                                                | 竞品的灵魂；cycle.js 单飞闸门天然等价 `busy` 锁                                  |
| 返回语义           | 各分支返回 400/5000/90000 等           | **固定返回心跳拍 `driveTickMs`（建议 300）**，睡眠时长不再由分支决定                                                                                                                | 节拍已由 cd_time 表达；返回值只承担"扫描线"                                      |
| 权威时钟           | `Date.now()` 遍布（pilot.js 约 25 处） | **`env.gameData.serverTime()`**（`core/acl/game-data.js` L129，`DataCenter.DATA.ServerTime`，取不到回 0）；`ServerMSTime` 口径用 `serverTime()*1000` 或与 `fightBeginTime` 同源取值 | 竞品 cd/boss 读秒/63s 暖机全用服务器秒；我方混算本地钟是 63s/8min 边界漂移的来源 |
| 兜底看门狗         | `driveScanMs` 5000                     | 保留，改名语义为"最迟复查拍"（cd 全命中时也应被唤醒）                                                                                                                               | 不引入新常量                                                                     |

**时钟降级规则**（本仓 fail-safe 口径）：`serverTime()` 回 0 时**不静默回落本地钟**，而是 `log.warn` 一次并整拍返回心跳（不发写请求）。理由：cd 账与 `fightBeginTime`（服务器毫秒 Int64）不同源时，63s 暖机会算成负数 → 一进场就发车，正是要治的病。

### 2.3 cd_time 账本映射（这是重写的核心数据结构）

竞品八个 cd 全部挂在 `cd_time`（L24200-24209），语义与写点如下。我方落成一个私有 `#cd` 对象 + 一个纯函数闸门：

| 键       | 竞品写点            | 值                                        | 消费点            | 我方语义                          |
| -------- | ------------------- | ----------------------------------------- | ----------------- | --------------------------------- |
| `march`  | L24974 决策前       | `+3`                                      | L24968 常规期闸门 | 行军最小间隔（**唯一的"TO 锁"**） |
| `march`  | L25252 到点 173     | `+2`                                      | 同上              | 到达即锁，防同点重发 8526         |
| `march`  | L25255 到点 173     | `+min(res_stay_time, 未占位格数*0.8+1.1)` | 同上              | **按空位数实时折算驻留**          |
| `march`  | L25267 到点 161     | `+shop_stay_time(15)`                     | 同上              | 到店驻留                          |
| `march`  | L25281 到点 163(怪) | `+20`                                     | 同上              | 打怪驻留                          |
| `march`  | L25329 复活后       | `+2`                                      | 同上              | 复活后短暂锁                      |
| `boss`   | L24632              | `+1`                                      | 同函数入口        | `getBossInfo` 的 901 节流         |
| `team`   | L24600              | `+1`                                      | 同函数入口        | `getTeamInfo` 的 901 节流         |
| `beast`  | L24805              | `+10`                                     | 同函数入口        | 野怪批量验活的 901 节流           |
| `scout`  | L25006              | `beastStage ? +5 : +60`                   | 同函数入口        | 侦察节拍（归 `scout.js`）         |
| `create` | L24329              | `+5`                                      | 组队侧            | 块 A，不在本次                    |
| `apply`  | L24374/L24402       | `+5`/`+60`                                | 组队侧            | 块 A，不在本次                    |

```js
/** 闸门统一写法（纯函数，可单测）：@returns {boolean} true=已到点可执行 */
#can(key, nowSec) { return nowSec > (this.#cd[key] || 0); }
/** 记账统一写法：先赋后动，绝不"成功后再记"（竞品 L24974 在派发前就写 march+3） */
#setCd(key, sec, nowSec) { this.#cd[key] = nowSec + sec; }
```

> **记账时序是硬要求**：竞品每次消耗 cd 都是**赋值在动作之前**（L24974 先写 `cd_time.march`、L24975-24979 才选点发车；L24329/L24600/L24632/L24805 同型）。
> 反过来"成功后才记"会在 901/8521 超时时把节拍打成一秒一发乱撞。我方 `#dispatch` 现有写法已是发前记账，保持。

---

## 3. 三个数据源：竞品读什么，我方怎么等价

竞品候选池**从不依赖 10018 push 做路径选择**（push 只用于掉落箱识别，L25231-25246）。三源如下：

| 源          | 竞品取法（行号）                                                                                                                                                                                                     | 我方落点                                                                                                             | 缺口                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 商店坐标    | `onPabRoomBaseInfoChange` L25308-25321：`TABLE[enigma_secret_realm_building].filter(build_type==3 && group==getPabGroupId())`，`coords="x,y"` → `state.shops[{pos,time,sausage,piece}]`，**只在 length==0 时灌一次** | 表读已有：`env.l10n.tableRows(TABLE_BUILDING)`（pilot.js L640 现用）；`TABLE_BUILDING` 常量已有（constants.js L637） | ⚠ **`getPabGroupId()` 无 ACL**（constants.js L644 一带只有表名注释）→ 需补 `secretRealm.pabGroupId()` |
| BOSS 权威态 | `bossBaseInfo[]`（L24568/24897/24918-24963）：`{bossId,pos,state,stateEndTime}`；`bossGurardRewardInfo[]`（L24709/24925）                                                                                            | 已有：`env.secret.getBossBaseInfo()` / `getBossGuardRewardInfo()`（api.js L144/L152）                                | 无                                                                                                    |
| 主动视口    | `asend(901,{x,y,k,rid:0,width:20,height:30,marchInfo:true,viewLevel})`（L24601/L24632/L24723/L24808）                                                                                                                | 已有：`env.secret.queryWorldView(cx,cy,opt)`（api.js L311，默认 20×30，归一 `{points,marches}`）                     | 无（`viewLevel` 需按竞品传 0/1，见 §5 逐函数）                                                        |

### 3.1 竞品大量使用本地实体表 `MapData.entities` / `getTileInfoByCoord` —— **本次决策不引入**

出现点：`getTeamInfo` L24597、`getBossInfo` L24628、`marchBeast` L24800、`marchTeam` L24831、`scoutBeast` L25010。

本仓 `core/defense.js` L9 已用真机证据否掉这类读法（"不信易失的本地 entities：邻城/野怪未入库时 `canMoveCity` 假阳性放行"），且 `SYM.modules` 里没有 `NWorldMapController`、没有 `MapTileUtils`。**再开这个口子等于把刚填的坑挖回来。**

**等价替换决策（全部改走 901）**：

| 竞品本地读                                                   | 我方替代                                                                                                                     | 代价                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `getTileInfoByCoord(脚下)` 取当前点 tile + `extData.state`   | `queryWorldView(start.x, start.y, {viewLevel:0})` 里 `points.find(x==start.x && y==start.y)`；`marches` 同应答的 `marchList` | 每拍多发一次 901（竞品同函数也有 `cd_time.team+1` 的 901 回落路径 L24599-24612，形态等价） |
| `MapData.entities` 找平台（BOSS 距离<30）                    | `getBossInfo` 恒走 901（竞品 L24632 的 else 分支），删掉"近距离走本地"快路                                                   | 平台查询多一次 901，受 `#cd.boss+1` 节流                                                   |
| `MapData.entities` 找野怪/已占点（`marchBeast`/`marchTeam`） | 视口 901 `points` 过滤 `pointType===PAB_MONSTER`（=172，非 163）；`marchTeam` 的"已占点"用 `marchList` + `points[].m.teams`  | 同 §6.3                                                                                    |
| `EnigmaBeastController._scoutInfo`（**私有字段枚举**）       | `scout.js` 的侦察账（`env.scoutQuality(x,y)` 已在 `index.js` L423 提供）                                                     | 无（我方本来就是自建账本，不摸私有字段）                                                   |

### 3.2 竞品 `state.shops` 的持久化照抄会退化 —— 拆开处理

竞品把四店坐标 + `time/sausage/piece` 一起存 `helper.settings['enigma-secret']`（`save`/`load` L25417-25437），`dayInit`（L25450-25457）跨天才清 `shops`。成立前提是"同一盟同一张固定图"。我方 `#syncAnchors` 注释明写"坐标随图而异"。

**决策**：

- `pos` 每拍从表重读（保持 `#syncAnchors` 现有形态，**不持久化坐标**）；
- `time/sausage/piece` 三字段沿用现有 `#shopLedger`（点位键 → 账），持久化与 `markShopLedger` 回路口已在 `index.js` L415-421；
- **换图检测**（`roomBaseInfo.teamId` 变化）时清账，代替竞品的 `dayInit`。竞品靠 `bossBaseInfo.find(...)==undefined` 判"这场没打过"（L24531），我方 `#skippedBoss` 同语义，保留。

---

## 4. 阶段网关：三个 getter 的逐条翻译

竞品 `autoLeader` 的常规期（L24968-24980）是四选一，判据是三个 getter。**我方 `#stageChain` 现有四档 + explore 全部作废**，改为下面这四个纯函数（建议直接放 pilot.js 顶部私有方法，命名对齐竞品以便复核）。

### 4.1 `exitStageWant()`（竞品 L24560-24576）—— 收场

```
pieceShop   = state.shops 存在某店 piece==1                       （买到过百兽箱）
boss30      = bossBaseInfo 存在某 BOSS state==30                   （已清台）
beastsFull  = roomBagInfo.beastInfo 中 enigma_beast.quality>=4 的只数
              >= dataConfig(3017) + getPabBuffValueByType(PabExtraPackItemNum)
按 team_type 分级：0 → pieceShop
                 1 → pieceShop && boss30
                 2 → pieceShop && boss30 && beastsFull
末尾兜底：ServerMSTime >= fightEndTime
```

我方落点：`env.petPackFull()`（index.js L427）已实现 `beastsFull`，`env.secret.petPackCapacity()` 已实现 `dataConfig(3017)+buff` 合并；`exitStageWant` 已是 env 暴露口（`driveExitStage`，index.js L434）→ **保留判据结构，只把 8 处阈值改为读 §8 的竞品字段名**。

### 4.2 `shopStageWant()`（竞品 L24577-24586）—— 该去商店了

```
nextBossOpen = max(bossBaseInfo.filter(state==22).map(stateEndTime))        // 最近一场开台结束时刻
sinceShopSec = ServerTime - max(state.shops[].time, 0)                       // 距"最近一次真到店"
i = shop_interval * 60                                                        // 480s
team_type==0 → return sinceShopSec > i
否则        → return !bossBaseInfo.find(state==22 && |stateEndTime - now - 60000| < 60000)
                 && ( sinceShopSec > i
                      || (|nextBossOpen - now - 150000| < 30000 && sinceShopSec > 120) )
```

**三个必须照搬的细节**（我方现状都不同）：

1. `shops[].time` **只在 `onPabTeamMarchArrive(161)` / `onPabRoomShopDataUpdate`（L25303）里写**，即"真到店才记"；建账时播种 `time = ServerTime`（L25318）。
   → 我方现状：`#syncAnchors` 用 `visited=0` 绕过 gap（pilot.js L1455-1461），语义漂移。重写后**去掉 `visited` 字段**，gap 一律以 `time` 为准，空账时 `time=now` 播种（等价竞品）。
2. 判据是**全店共享**的 `max(time)`，不是每店独立冷却。→ 我方 `driveShopGapCooldownMs`(10min) 每店独立 + `driveShopRevisitMs` 混用，重写后统一为 `#cd` 的形态：`sinceShopSec` 一个数说了算。
3. 那个 `|stateEndTime - now - 150000| < 30000` = **开台结束后 120~180s 的窗口**（拍宠高光期），与我方 `driveShopNearEndMs/WinMs/GapMs` 三键完全同构 → 保留数值，改键名对齐（§8）。

### 4.3 `beastStageWant()`（竞品 L24587-24594）—— 可以安心抓百兽

```
pieceShop                                        && （team_type==0
    || 所有 bossBaseInfo 的 state ∈ {28,30}
       && 血包 41003 余量 >= setting.items[41003].num（或 999999 表示不限）
       && 绷带 41002 余量 >= setting.items[41002].num（或 999999）
       && 香肠 41011 余量 >= 10
       && roomBaseInfo.buffMap 中 enigma_secret_realm_rss_station.buff_color==5 的增益数 >= 3
       && 背包 quality>=4 只数 <= 容量                        // 没拿满才还有必要抓
       && 没有 BOSS 处于「90s 内开台结束」窗内）
```

**新知识（我方完全没有的一条）**：`buffMap` 的 **5 色增益数 ≥ 3** 才算"安心抓兽"。数据源：
`roomBaseInfo.buffMap`（键 1..3 = 槽位，值 = `enigma_secret_realm_rss_station` 的 specId）→ `l10n.tableRow(TABLE_RSS_STATION, specId).buff_color`。
我方 constants 已有 `TABLE_RSS_STATION`（L558）、pilot.js L903 已在读这张表（`bagFree/buffFree`），**这张表我们已经会读，只是没用 `buff_color` 这一列** → 无 ACL 缺口，纯新增判据。

---

## 5. 五个动作层：选点公式逐行翻译

### 5.1 `marchResource(minNum, maxDist)`（竞品 L24708-24770）

```js
// 距离尺（L24710-24714）：兼容 {x,y} 与 {tileX,tileY} 两种形态
d(p, anchor = roomBaseInfo.startPoint)
// 成本项（L24712）：r(p, shop) = d(p, 起点)/2 + d(p, 未领奖BOSS)/5 + (shop ? d(p, shop)/6 : 0)
//   注意：竞品 marchResource 打分用的是 n = 「最近的无香肠店」，但 n 传入 r 时是第 3 项 /6，
//         而 BOSS 锚 i 是 /5 —— v3 文档 §2.4 记成「距无香肠商店/5」，属误记，以本行号为准。
//   i = bossBaseInfo.find(其 bossId 不在 bossGurardRewardInfo 里)   // 第一个石头奖励还没人领的 BOSS
marched_list = marched_list.filter(e => ServerTime - e.t < 60)      // L24717 只留 60s
n = state.shops.filter(sausage==0).sort(by d(s.pos) asc)[0]         // L24718 商店引力锚
s = roomBaseInfo.startPoint
o = await asend(901, {x:s.x, y:s.y, k:currentServerId, rid:0, width:20, height:30, marchInfo:true, viewLevel:1})   // L24723 ★ 阻塞
l = o.pointList.filter(
      pointType == PAB_RESOURCE                                     // 173
   && 回合已开放：ServerTime > fightBeginTime/1000 + timer[realm[esrId].roundid].start    // L24734
   && !marched_list.find(x,y 相同)
   && m.iNum >= minNum
   && 0 < d(i) <= maxDist)
best = l.filter(
      m.state == 0 && m.teams.length == 0
   && (march_policy == 1 || !o.marchList.find(t => t.target.tx==p.x && t.target.ty==p.y && t.state==1)))
   .sort(by (m.iNum - r(p, n)) desc)[0]                             // L24737 打分：越大越好
if (!best && minNum==0) LocalStorageUtils.set('enigmaSecret-marchResource-failLog', {...})   // L24740-24760 落盘
if (best) { marched_list.push({x,y,t:ServerTime}); sendToBuildingMarch(best.x, best.y); }     // 先记账后发车
```

**筛子总数 = 4**（类型、回合、iNum+距离、空位+无在途）。我方 `#pickResource` 现有 7 道闸，重写时按下表处置：

| 我方闸                  | 处置                                               | 依据                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rTime > now` 判空      | **删**（选点侧不再看 rTime）                       | 竞品无此闸（占用只看 `state==0 && teams.length==0`，见 L24737）；录制实测 173 的 `rTime` 命中 9479/16609，语义=最近一次被采集时间戳，与 `iNum` 无绑定（iNum 可见 8/9/10，故不作选点依据） |
| `consumed` 10min 黑名单 | **删**                                             | 竞品只 60s `marched_list`；10min 黑名单正是不回头补拿的原因                                                                                                                               |
| `marched` 60s           | 保留（改名 `#marchedList`，秒口径存 `serverTime`） | 竞品同款 L24717                                                                                                                                                                           |
| `roundOpen`             | 保留，但**必须传 `viewLevel:1` 且用 `m.esrId`**    | 竞品 L24734                                                                                                                                                                               |
| `marchBlocked`          | 保留，来源改为本应答的 `marchList`（不读全局）     | 竞品 L24737 用 `o.marchList`                                                                                                                                                              |
| `state==0` / `teams==0` | 保留，`march_policy==1` 时跳过在途检查             | 竞品 L24737                                                                                                                                                                               |
| 产出下限                | 严格档 `5 + ceil(members/2)`、宽松档 0             | 竞品 L24974 传参、L24715 默认                                                                                                                                                             |

### 5.2 `marchShop(preferNoSausage)`（竞品 L24840-24849）

```
前置三连（全在一条 if 里，任一不满足直接 undefined 返回）：
  ServerMSTime >= fightBeginTime + 63000
  && !state.shops.find(s => s.time*1000 + 3000 > ServerMSTime)      // 全店共享 3s 冷却
  && roomBaseInfo.pointType != 161
排序：preferNoSausage ? (sausage 升序，tie 再距离升序) : 距离升序
命中即 sendToBuildingMarch(pos.x, pos.y)
```

**这是本次重写最直接的补丁点**：我方链尾兜底店**无前置**（pilot.js L2118/L1443-1500），故池子一空就必胜。照搬这三条即可。
注意竞品链尾兜底（L24979 最后一个 `||`）**同样会调 `marchShop()`**（不带参数=按距离），它不饿死靠的是 §5.1 的 await 串行 + 3 秒级重试，不是靠更多档位。

### 5.3 `marchBeast(minQuality, maxDist)`（竞品 L24772-24826）

```
提前放弃：team_type>0 && bossBaseInfo.find(state==22 && |stateEndTime - now - 90000| < 90000) → false   // L24780
主路（本地 entities）：见 §3.1 → 改视口 901
  过滤：`PAB_MONSTER`(=172，非 163) && 回合已开放 && (!callTId || callTId==本队 teamId)
       && state==0 && teams.length==0 && (march_policy==1 || 无在途指向)
       && quality(from EnigmaBeastController.getScoutInfo) >= minQuality
       && 0 < dist <= maxDist
  排序：quality desc, dist asc
退路（主路没货 && beastStage && now > cd.beast）：cd.beast = now+10
  取侦察账里 quality>=minQuality 的最近 4 只 → 并发 4 次 901 验活 → 第一个还活着的
```

**新知识点（我方此前没利用的两个字段）**：

- `m.callTId`（召唤队 id）：野怪属于"哪一队召唤的"，`!callTId || callTId == roomBaseInfo.teamId` 才可打。**这是抓兽档常年选不出点的隐藏闸**，我方 `#pickResource`/打野档从没看过它。
- `roomBaseInfo.teamId` 是 Int64（`{_low,_high}` POJO）→ 竞品 `.toNumber()`（L24794）。
  ⚠ **报文实证更正（2026-11-03）**：901 里 `172.callTId` 是 **JSON number 且已精度丢失**（录制 3016 条 **100% 尾部"000"**，如 `4910819285328332000`），而 `163.teamId` 是**字符串**（全精度 `"4910819285328331784"`）。→ 归属闸 **不能用字符串比**（`...000` vs `...784` 永不等）；必须 `Number(callTId) === Number(teamId)`（两边同转 double，实测 `Number("4910819285328331784")===4910819285328332000` → **true**）。teamId 经 `bits.int64ToNum` 取数后比。精度代价≈末 3–4 位，同服队 ID 碰撞风险极低（与竞品 `.toNumber()` 同口径）。**注：这是本仓「64 位不 Number 化」红线的一个受控例外**——该处要的是「模糊等值」而非「精确区分」，double 取整方向安全。

我方落点：品质读 `env.scoutQuality(x,y)`（未侦察回 null → 按 2 计，保持现口径）；`driveBeastMinQuality=4` 对应 `minQuality`。

### 5.4 `marchPlane(bossInfo)` / `marchBoss(bossInfo)`（竞品 L24850-24880）

```
getBossInfo(boss)（L24619-24668）：
  若 d(boss.pos, 起点) < 30 → 本地 entities 找该格平台        （我方改 901，见 §3.1）
  否则 now > cd.boss → cd.boss = now+1；901 以 boss.pos 为中心拉 20×30 viewLevel:0
  平台集 = pointList.filter(type==176 && extData.esrId == 当前平台.esrId && extData.state == 22)   // ★ 硬筛 state==22
  行军集 = marchList 归一 {begin_bx,begin_by,target_tx,target_ty,marchState}
  状态修正：命中 tile 的 extData.state ∈ {21,23,30} → 回写 boss.state；否则若 901 成功 → boss.state=28
  返回 {boss, tile, planes, marches}

marchPlane(bossInfo)（L24850-24872）：
  可选 check_power：最近 10 个平台逐个 asendPBV2(POINT_INFO) 探（不 await，fire-and-forget）
  过滤：plane_policy==1 || (teams.length==0 && 无己方/敌方在途指向该平台)
  排序：plane_policy<2 ? 近优先 : 远优先
  命中即 sendToBuildingMarch
marchBoss(bossInfo)（L24873-24880）：
  仅当 tile 在场 && (state==22 && stateEndTime<now || state==21) → sendToBuildingMarch(boss.pos)；随后 await asleep(500)
```

**与我方现状的实质差异（1 条）**：竞品把 `state===22` 做**硬筛**（L24623 的 filter），我方 v3 是"+200 加权不硬筛"（v3 文档 §7.2 第 5 行）。
照抄应改回硬筛，但**保留我方读秒过期宽限窗 `driveBossGraceMs`**（竞品 `marchBoss` 的 `state==22 && stateEndTime<now` 正是该宽限的来源，两侧等价，不冲突）。

### 5.5 `marchTeam()`（竞品 L24827-24838）—— 我方缺失的整个一档

```
候选 = 本地实体里 (173 || 163) && dist>0 && (teams.length>0 || 有在途行军指向该点)
排序：距离升序，取第一个 → sendToBuildingMarch
```

语义：**专挑"已经有队伍/正被冲"的点跟过去**（蹭队伍、抢位）。只在 `march_policy == 2`（抢）时被调用（L24976/L24979 第一个 `||` 项）。
我方完全没有这一档 → 需新增 `#pickFollow()`，数据全来自 §5.1 同一次 901 应答（`points[].m.teams` + `marches`），**零额外协议成本**。
本地实体读的部分按 §3.1 改视口。

> ⚠ 待用户确认：`march_policy==2` 的语义是"抢"。这一档会主动往人堆里开，与"不跟别人抢"的保守取向冲突。默认**照抄但挂配置位**（`driveMarchPolicy` 已有），`policy!=2` 时永不触发。

---

## 6. 主决策树 `autoLeader`（竞品 L24882-24985）逐行翻译

这是重写的"主干"，我方 `#tick` 现有 8 段阶梯（cooldown→base→换场→TO→WORK→常闭闸→threat→return→PVP→refreshView→HOLD→BOSS→stageChain→explore）**整体作废**，替换为下面这一棵顺序完全一致的树。

### 6.1 五道前置（L24916 的一条 if，全在同一表达式）

```
fightBeginTime < ServerMSTime < fightEndTime     // 战场开窗内
&& isTeamLeader()                                 // 仅队长（我方同口径）
&& isCanMarch()                                   // !!roomBaseInfo && teamIsMooring()（api.js L409 已有）
&& roomBaseInfo.pointType ∉ {BOSS, BOSS_GUARD}     // 已在 BOSS 点上不重派
```

任一不满足 → **整拍直接结束**（竞品没有 sleep 概念，下一拍心跳再来）。我方 `#tick` 对应位置返回心跳值。

### 6.2 取现场（L24917-24923）

```
d = await getTeamInfo()          // §5.1 的 {tile, marches}；null 时竞品 await asleep(1000)（L24983）
若 tile.extData.state 或 marches.length 相比 last_team_info 变了 → 更新快照（仅日志/去重用，无副作用）
```

### 6.3 防袭档（L24924-24938，`pointType != 161` 时才查）

| 条件                                                                                                            | 竞品行为                                                                                                                     | 行号         |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `option.auto_march && march_policy>=0 && tile.state==12`                                                        | **不动**（正在挨打交战中）                                                                                                   | L24925       |
| `option.auto_march && march_policy>=1 && tile.state==11`                                                        | **不动**（有敌人来袭倒计时）                                                                                                 | L24928       |
| `option.auto_march && march_policy>=2 && marches.length>0`                                                      | **不动**（有敌方在途）                                                                                                       | L24931       |
| `march_policy==0 && option.avoid_attacked && (state==11 \|\| 有在途) && (!check_power \|\| checkPowerGap()<=0)` | **跑**：`beast_policy==1 && marchBeast(4)` \|\| `marchResource()` \|\| `beast_policy==0 && marchBeast(4)` \|\| `marchShop()` | L24935-24937 |

我方现状：`state==11/12` 的逃营在 `warn.js`，pilot 里是 EVADE 档（受击逃帐篷 + 回攻）。**重写后 EVADE 档改由这一节承担**，`warn.js` 的"自动驾驶开启时让出转移"让闸保持（index.js L111 注释已写）。

⚠ **`state 11/12` 语义此前只在 constants.js L263 以注释形式记录**（`state===11||12` 走 `getRoomPointFightingPVPInfoByXY` + `dataConfig(3018)` 算倒计时），我方没有"敌在途指向脚下"的闸。新增。

### 6.4 BOSS 期（L24939-24963）

```
t = team_type
若 t > 0：
  m = bossBaseInfo 按 pos.x 升序                       // 用于 guard_policy 0/1 的"跳过某个"
  g = bossBaseInfo.filter(state==22 && stateEndTime<now  ||  state==21)     // 可打集（含过期宽限）
  g = guard_policy 过滤（L24944-24952）：
      0 → g != m[2]（跳过 x 最大的那个）
      1 → g != m[0]（跳过 x 最小的那个）
      2 → 剔除 state.boss[bossId]==1（已到场打过）
      3 → 剔除 bossGurardRewardInfo 里已有 rewardInfo 的（石头奖励已领完）
  若 g 非空：
    v = 当前 pointType==176（已在平台）
    y = 离我最近的 BOSS（任意状态） ；b = 离我最近的可打 BOSS
    若 !v || (y != b && auto_march) → marchPlane(await getBossInfo(b))     // 先上平台
    否则                          → marchBoss(await getBossInfo(y))       // 再打
```

### 6.5 BOSS 预警期（L24964-24977）

```
若 auto_march && t>0：
  g = bossBaseInfo.filter(state==22 && 0 <= stateEndTime - now < plane_time*1000)   // plane_time 默认 60s
  再过 guard_policy 同 6.4
  若 g 非空：v = 已在平台；y = 最近 BOSS
     (v && g 含 y) || await marchPlane(getBossInfo(g 中最近者))
```

我方对应 `driveBossLeadMs=60000`（已有，等价）。**但 v3 的"读秒结束后 120~180s 拍宠高光期砍 gap"是竞品的 `shopStage` 里那条（L24585），不是这里** —— 别混。

### 6.6 常规期四选一（L24978-24984）

```
前置：auto_march && (t==0 || 无 BOSS 处于 state==23) && now > cd.march
     && (pointType != PAB_MONSTER(172) || tile.state==0 || (tile.state==5 && capturingPetPos.x<0))   // 怪点必须没在打/没在喂
若 pointType==PAB_MONSTER(172) → await asleep(500)                                               // 让 8546 投喂先落地
cd.march = now + 3
f = ceil(roomBaseInfo.members.length / 2)
exitStage  → return marchShop()
shopStage  → return marchShop(1)
beastStage → return (policy==2 && marchTeam()) || (beast_policy<2 && marchBeast(4)) || marchResource()
否则        → return (policy==2 && marchTeam()) || (beast_policy==1 && marchBeast(4))
                 || marchResource(5+f, 100)          // 严格档
                 || (beast_policy==0 && marchBeast(4))\
                 || marchResource()                 // 宽松档（无下限、无距离上限）
                 || marchShop()                       // 链尾兜底（受 §5.2 三连前置约束）
```

**注意 `state==23`**：竞品在常规期前置里排掉"BOSS state==23"（L24978），而 6.4/6.5 的可打集里都不含 23 → `getBossInfo` 的 L24655 `[21,23,30]` 会把本地读到的 23 回写进 `boss.state`。23 语义未证实（我方 constants 只登记了 21/22/28/30）→ **照抄该条，并在 §11 立"待验证"项**，不要脑补成"开台中"。

### 6.7 `checkPowerGap()`（竞品 L24690-24706）—— 我方完全缺失

```
Promise.all([
  asendPBV2(ENIGMA_SECRET_ROOM_TEAM_INFO, {teamId: roomBaseInfo.teamId}),     // 己方全队
  asendPBV2(ENIGMA_SECRET_ROOM_ATTACK_SELF_TEAM, {uid: String(UID)})          // 来袭我方队
])
任一缺失/members|waitTeams|fightTeams 取不到 → 回 0（保守：视为不占优）
返回 己方 sum(members[].power) − 来袭 sum((waitTeams+fightTeams).flatMap(members).power)
```

消费点：6.3 防袭档（`<=0` 才跑）、`marchPlane` 的可选探平台（L24853）。→ **这是新增协议，见 §7 缺口 G1/G2**。

---

## 7. ACL 缺口清单（按阻塞度排序）

合规前提：`feats/activity/secret-realm/api.js` 受两条闸门管——dep-cruiser 规则 `feat-acl-adapters-not-depend-on-domain-or-net`（不得 import core 领域/网络模块）与 eslint `no-restricted-syntax`（玩法层不得读 `window.pocketcc.*`，仅 api.js 内部已有就地豁免）。因此**新增能力只能往 api.js 加，不能往 pilot.js 里塞裸符号**。

| ID      | 竞品用途（行号）                                                                                                               | 我方现况                                                                                                                                                                                       | 处置                                                                                                                                                                                                                 | 阻塞重写？                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **G1**  | `ENIGMA_SECRET_ROOM_TEAM_INFO`（L24692/L24700）拉全队战力                                                                      | constants.js **未登记该协议号**（已登 8521/8522/8526/8527/8532/8533/8534/8535/8536/8537/8538/8540/8541/8542/8543/8544/8546/8547/8548/8549/8551/8552/8581/8584/8589，中间 8539 一带空洞）       | 需先用录制/dashcam 证实协议号，再入 constants                                                                                                                                                                        | ✅ 阻塞（但只阻塞 `check_power` 开的那条支路，默认可关） |
| **G2**  | `secretRealm.checkPowerGap()`（L24690-24706）                                                                                  | 无。两个协议都是现成的 `sendSecret(cmd, data)` 一行调用                                                                                                                                        | 新增 `api.js` 一个方法（只读查询，归一两数）                                                                                                                                                                         | ✅ 阻塞防袭档的 `check_power` 分支                       |
| **G3**  | `PabController.getPabGroupId()`（L25310）                                                                                      | **已解决（比竞品更强）**：pilot.js L632 用 `roomBaseInfo.group \|                                                                                                                              | pab.myTeam.group`，而后者正是游戏 `getPabGroupId`的实现；且我方每次 group 变化重读表，竞品只在`length==0` 时灌一次                                                                                                   | **保持现有 `#syncAnchors` 形态，不改成竞品的一次性加载** | ❌                                                                                                                                  |
| **G4**  | `MapData.entities` / `NWorldMapController.getTileInfoByCoord` / `MapTileUtils.getConfig`（L24597/L24628/L24800/L24831/L25010） | 无且**不打算新增**（`SYM.modules` 里没有 `NWorldMapController`/`MapTileUtils`；defense.js L9 已用真机证据否掉这类读法）                                                                        | 按 §3.1 全部换 901                                                                                                                                                                                                   | ❌                                                       |
| **G5**  | `roomBaseInfo.members[].powerInfos[].power/initPower`（L24972 算 `f`、L25029 预筛伤员）                                        | `getRoomBaseInfo()` 原样透传（api.js L136），heal.js L171 已在读 `powerInfos`                                                                                                                  | 无缺口；pilot 只需 `base.members.length`                                                                                                                                                                             | ❌                                                       |
| **G6**  | `m.callTId`（野怪归属队，L24801/L24817/L25014）                                                                                | **已证实（录制复核 2026-11-03）**：`callTId` 落在 **172 `PAB_MONSTER`** 的 `m` 上，命中 3016/21212（14%）；**类型为 JSON number 且尾部恒"000"（Int64→double 抹零）**；竞品 L24804 用 `!callTId |                                                                                                                                                                                                                      | callTId==teamId` 作抓兽/打野隐藏闸                       | 新增该闸（值为空/缺省视为无归属可打）；比较走 **`Number(callTId) === Number(teamId)` 的 double 等值**（禁字符串比，详见 §5.3 更正） | ❌ 不阻塞（已从 ⚠ 解除，但实现口径由「字符串比」更正为「double 比」） |
| **G7**  | `enigma_secret_realm_rss_station.buff_color`（L24593）                                                                         | `TABLE_RSS_STATION` 已读（pilot.js L903 取 `bagFree/buffFree`），**只是没用 `buff_color` 列**                                                                                                  | 纯新增判据                                                                                                                                                                                                           | ❌                                                       |
| **G8**  | `PabController.checkItemNumMax` / `getItemNumById` / `updateSneakBaseInfo`（L24237）                                           | 前两个已可经 `getPabController()` 直调（pickup.js L1010 现例）；**`updateSneakBaseInfo` 全仓未出现**                                                                                           | **不调 `updateSneakBaseInfo`**：它在竞品里夹在 `ids` 求值里（一个 `&&` 短路副作用），名字带 `update` 且行为未证——我方 ACL 红线是只读，不能依赖未证的原生写方法。`ids` 改用 `getItemNumById` + `checkItemNumMax` 重建 | ⚠ 阻塞§9.2 购物清单（不阻塞开车）                        |
| **G9**  | 权威时钟 `ServerTime`/`ServerMSTime`/`ClientTime`                                                                              | **已有**：`gameData.serverTime()`（`core/acl/game-data.js` L129，`DataCenter.DATA.ServerTime`）且 `env.gameData` 已注入（index.js L402）                                                       | pilot 内部把 25 处 `Date.now()` 换成注入口，**不需新 ACL**                                                                                                                                                           | ❌                                                       |
| **G10** | `dataConfig(3010/3013/3017/3021/3028/3029/3056/3061/630002/630027)`                                                            | 除 3010（块 A 组队人数阈值）外均已在 constants.js 注释登记，`env.gameConf.dataConfig(n)` 可直接取                                                                                              | 无                                                                                                                                                                                                                   | ❌                                                       |
| **G11** | `EnigmaBeastController._scoutInfo` 枚私字段（L24805）                                                                          | 不采（scout.js 自建账本已够）                                                                                                                                                                  | 无                                                                                                                                                                                                                   | ❌                                                       |

**一句话结论**：主干（§2/§4/§5.1/§5.2/§6.4-6.6）**零新 ACL**，今天就能写；真正需要补协议的只有 `checkPowerGap` 一个方法 + 一个待证协议号（G1/G2），以及一个待证字段 `callTId`（G6）。

---

## 8. 配置层：竞品 `setting` ↔ 我方 `tuning.drive*` 逐项对齐

竞品字段定义在 L24139-24193（默认值）+ L24254-24295（`rebuildSetting` 旧键迁移）+ L25459-25480（`apply` 面板写回）。
**我方现有 44 个 `drive*` 键**（constants.js L1017-1227），面板可见 + storage 持久化 → 迁移不能静默改名。

| 竞品字段（默认）                                                        | 行号         | 我方现有键                                                                                  | 处置                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team_type: 2`                                                          | L24181       | `driveTeamType: 2`                                                                          | 已有，保名                                                                                                                                                                                                                |
| `plane_time: 60`（秒）                                                  | L24182       | `driveBossLeadMs: 60000`                                                                    | **双轨**：新增 `drivePlaneLeadSec`，`load` 时若旧键存在则 `ms/1000` 换算                                                                                                                                                  |
| `march_policy: 0`                                                       | L24185       | `driveMarchPolicy: 0`                                                                       | 已有                                                                                                                                                                                                                      |
| `beast_policy: 0`                                                       | L24186       | `driveBeastPolicy: 0`                                                                       | 已有                                                                                                                                                                                                                      |
| `plane_policy: 0`                                                       | L24187       | ⚠ **无此键**（已核：constants.js 全文无 `planePolicy`）                                     | 新增 `drivePlanePolicy`（0=近优先 1=无视占用 2=远优先，对应 L24868 那个 `(policy<2 ? 1 : -1)`）                                                                                                                           |
| `guard_policy: 0`                                                       | L24188       | `driveGuardPolicy: 0`                                                                       | 已有，但四档语义需按 §6.4 重实现（现有只做"到场即跳"）                                                                                                                                                                    |
| `shop_interval: 8`（分）                                                | L24190       | `driveShopIntervalMs: 480000`                                                               | 双轨换算                                                                                                                                                                                                                  |
| `shop_stay_time: 15`（秒）                                              | L24191       | `driveShopStayMs: 15000` / `driveShopDwellMs: 25000`                                        | **两个键必须合并语义**：竞品只有一个"到店后 cd 锁 15s"；我方 dwell(25s) 是给 shop.js 买货的驻留窗。保留两键，文档写明：cd 用 stay、kick 轮询窗用 dwell                                                                    |
| `res_stay_time: 8`（秒）                                                | L24192       | `driveResStayPerBagMs:800 / driveResStayBaseMs:1100 / driveResStayMaxMs:8000`               | **公式已等价**（pilot.js L1950 `n*0.8+1.1` 上限 `8000` ≡ 竞品 `min(res_stay_time, n*0.8+1.1)`）→ 三键合并为一个 `driveResStaySec: 8`（对齐竞品字段名），旧三键仅作迁移入口                                                |
| `cure_num: 3`                                                           | L24184       | heal.js 自有配置                                                                            | 归 heal.js，不进 pilot                                                                                                                                                                                                    |
| `drop_num: 1`                                                           | L24183       | pickup.js / constants.js L430-432 已读 3061                                                 | 归 pickup.js                                                                                                                                                                                                              |
| `items[]`（六种道具目标数）                                             | L24139-24168 | `env.cfg().pickItems`（pilot.js L867）                                                      | 形态不同但语义重叠，**按 §9.2 重写成 `ids` 口径**                                                                                                                                                                         |
| `option.{buy_sausage,auto_march,avoid_attacked,auto_leave,check_power}` | L24169-24175 | `drive.enabled`/`drive.shopTime`/`drive.boss`/`drive.revive` + warn.enabled + leave.enabled | 映射表（面板文案不动）：`auto_march`→`drive.enabled`；`buy_sausage`→shop.js 现有开关；`avoid_attacked`→warn.enabled；`auto_leave`→leave.enabled；`check_power`→**新增 `driveCheckPower`（默认 false，因 G1 协议号未证）** |
| `join_round/team_mode/room_delay/parteners`                             | L24177-24193 | 块 A                                                                                        | **不入本次**                                                                                                                                                                                                              |

**新增三个 pilot 键**（竞品有、我方无）：`driveMarchCdSec: 3`、`driveBeastCdSec: 10`、`driveBossCdSec: 1`。
**作废六个 pilot 键**（重写了就没这些概念）：`driveScanMs`（→心跳）、`driveMarchTimeoutMs`（→cd.march）、`driveConsumedTtlMs`、`driveWorkMaxMs`、`driveIdleExploreMs`/`driveExploreStep`（探索档，见 §10）、`driveWorkDwellMs`。
→ **驻留三键不在此列**（公式已等价，只做命名合并）。
→ **旧键不删、只停止读取**（保持 storage 兼容，`load` 里做一次换算），并给 `constants.js` 里的旧键加 `@deprecated` 注释指向本表。

---

## 9. 到点层（C 块）：只改四处语义

### 9.1 cd 公式（L25250-25282）

```
173 到点：cd.march = now+2 → await 8526 → cd.march = now + min(res_stay_time, bagInfo.filter(uid 为空).length*0.8+1.1)
161 到点：cd.march = now + shop_stay_time → await 8540 → mooring.shop = {items, point} → emit 刷新
172 怪到点（PAB_MONSTER）：cd.march = now + 20
```

**比对结论（逐键核过，比预想的一致度高）**：

| 竞品值                                     | 我方现有                                                             | 差异                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `min(res_stay_time=8s, 空位数*0.8+1.1)`    | pilot.js L1950-1951 `n*800ms + 1100ms` 上限 `driveResStayMaxMs=8000` | **数值已等价**，不需重算                                                    |
| 161 到店 `+15s`                            | `driveShopStayMs=15000`（pilot.js 文件头已标 15s）                   | **已等价**；另有 `driveShopDwellMs=25000` 是 shop.js 买货窗，两键并存（§8） |
| 怪点 `+20s`                                | `driveStayMonsterMs=20000`                                           | **已等价**                                                                  |
| 到点先 `cd.march=now+2`（防同点重发 8526） | 无这个中间锁                                                         | **新增**（一行）                                                            |
| 常规期 cd `+3s`                            | `driveScanMs=5000` + `driveMarchTimeoutMs=90000`                     | **本项是真正要改的**：驻留公式我们早就抄对了，错的是一拍频率与 TO 锁时长    |

我方落点：`#enterWork` 的时长计算**保留**，改为写入 `#cd.march`（服务器秒口径）而不是 `#workUntil`（本地毫秒），以免两套时钟并行。

### 9.2 购物清单 `ids`（L24232-24253）—— 比 shop.js 现有逻辑多三条约束

```
基础：items.filter(目标数 > getItemNumById(id) && !checkItemNumMax(id))
约束 1：41009(晶块) > 12000 − 41011(香肠)余量*500 − (买到过百兽箱 ? 3000 : 0) → 从清单剔掉 41009
              语义：给买香肠/百兽箱留保底余额，不把晶块花光
约束 2：41010(水晶) + 41011 >= 目标 10 → 剔掉 41010（刷新币不浪费）
约束 3：bossBaseInfo[0].state==30 → 剔掉 41010（清完台不再刷新）
```

⚠ 这里的 `12000 / 500 / 3000` 是竞品写死的字面量（L24239-24241），**必须进 constants 带注释**，不能内联魔法数（本仓 eslint `sonarjs/no-duplicate-string` 与既有口径）。
消费方：`shop.js` 的 `#grabSausage`/选货排序；`shopConver`（L25194-25230）的优先级与刷新回退照搬：

```
候选 = items.filter(getTime == 0) → 查 TABLE_SHOP
boss30 已清 → 百兽箱 || (buy_sausage && 41011<10 && 有 41011)
否则       → (buy_sausage && 41011<10 && 有 41011) || 百兽箱
买：getItemNumById(41009) >= cost → 8542 {specId, num:1}；应答失败 → mooring.shop = null（下拍重拉）
无目标品 && buy_sausage && 41011<10 && 41010>0 → 查 TABLE_SHOP[specId=9] 且 41009>=cost → 8543 刷新
```

### 9.3 自愈补拉（L25131-25137 / L25198-25204）

竞品不等 push：`shopConver`/`getResItem` 开头先判 `mooring.shop/resource` 缺数据或点位不匹配，**自己补发一次 `onPabTeamMarchArrive`**（即 8540/8526）。
我方现状：靠 `PUSH_RESOURCE_CHANGE(21522)`/`PUSH_DROP_CHANGE(21532)` 与 kick 唤醒 → 补上"不匹配就主动重拉"这一句（复用 pickup.js/shop.js 已有的 INFO 调用，零新协议）。

### 9.4 增益择优拿（L25155-25190）与掉落箱归属（L25231-25246）

- `getResItem` 拿完物品后，若 `buffGetNum < dataConfig(3013)[1]` 且**是队长**，从 `buffInfo` 里按 `enigma_speed/enigma_attack/enigma_damage`（`buff_icon` 包字符串）与 `roomBaseInfo.buffMap[1..3]` 的 `buff_para` 比较，算出"哪个 dropId 值得放到哪个槽位"，发 8538。**我方 pickup.js 已接 8538（constants L25），需核对是否做了这套比较。**
- `onUpdateTileInfo`（L25231-25246）：`pointType == PAB_DROP` **且 `roomBaseInfo.teamId == m.teamId`** 且 `m.iNum > 0` 且 `drop_list` 里没有未过期的该点 → 主动 8532 拉箱内容并记进 `drop_list`。我方**未做 teamId 归属判**（任何掉落都接），也无 `drop_list` 去重→ 新知识点（归 pickup.js）。

### 9.5 复活（L25327-25332）

```
21521 里 deadType==1 && dataConfig(3056) > reviveNum → 8552 {uid} → jumpToTarget(起点) → cd.march = now+2
```

我方 pilot.js L393/L440-483 已实现（含 `CFG_REVIVE_LIMIT`）→ 保留，**补一句 cd.march 记账**（现在没记）。竞品还调 `jumpToTarget`（镜头跟随），我方 `nav` 能取但非必需 → 不抄。

---

## 10. 事件/推送订阅映射（竞品 L25394-25403）

| 竞品事件                           | 我方对应（constants.js）                                                              | 新 pilot 是否订阅 | 用途                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `UpdateTileInfo`                   | `PUSH_TILE_INFO` 10018                                                                | ✅                | 只做掉落箱识别（**不再当候选池**）                         |
| `PabTeamMarchArrive`               | `PUSH_TEAM_ARRIVE` 21529                                                              | ✅                | 到点分派 + cd 记账                                         |
| `PabRoomResLibraryDataUpdate`      | `PUSH_RESOURCE_CHANGE` 21522                                                          | ✅（归 pickup）   | 袋账更新                                                   |
| `PabRoomRewardBoxDataUpdate`       | `PUSH_DROP_CHANGE` 21532                                                              | ✅（归 pickup）   | 箱账更新                                                   |
| `PabRoomShopDataUpdate`            | 8542/8543 应答                                                                        | ✅（归 shop）     | **回写 `sausage/piece/time`**（L25299-25306）              |
| `UPDATE_PAB_ROOM_BASE_INFO_CHANGE` | `PUSH_BASE_INFO` 21521                                                                | ✅                | 装锚点 + 复活 + BOSS 到场记账                              |
| `UPDATE_PAB_TEAM_CHANGE`           | —                                                                                     | ❌（块 A）        | 组队聊天提示                                               |
| （竞品无）                         | `PUSH_BOSS_STATE` 21535 / `PUSH_SELF_ATTACKED` 21534 / `PUSH_BOSS_GUARD_REWARD` 21539 | ✅ 保留           | 我方 kick 源，比竞品的纯心跳即时（不破坏等价性：心跳仍在） |

**kick 与心跳的关系写死在文件头**：事件 kick 只是"提前拉一拍"，正确性一律靠 cd 账 + 心跳保证——否则不订阅新事件就等于少一个触发源（v3 就是这么把拍宠高光窗漏掉的）。

---

## 11. 守卫取舍：哪些不随重写一起扔

竞品没有、但我方有实战证据的六条。**默认全部保留**，并逐条挂注释指向证据；只有一例外（见最后一条）。

| 守卫                                                             | 我方现有                        | 证据                                                         | 处置                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 拒绝码 17（战场即将封闭）→ 本场停手                              | pilot.js L2137一带              | 真机报文                                                     | **保留**（竞品靠 `isOpen` getter L24314 判活动态，不等价）                                                                                                                                                                                                                                                                           |
| 拒绝码 157/158/159/141/142/209/252/163 分流                      | pilot.js L1788-1830             | 真机报文                                                     | **保留**，但语义改为竞品的"写 cd + 降级"而非"拉黑"（159/142/252 拉黑保留，163 当日拉黑 → 改竞品的 60s `marchedList`；**209 经 20261101T200401 报文验证也改 60s marched**：(230,226) 吃 209 后挪开、11.5s 后同点行军成功——拒绝取决于当前停泊位，拉黑会白丢稍后可用的平台）                                                            |
| BOSS 读秒过期宽限窗 `driveBossGraceMs`                           | v3 文档 §7.2                    | 竞品 `marchBoss` L24874 同款                                 | **保留**（已对齐）                                                                                                                                                                                                                                                                                                                   |
| 平台 `state==22` 加权 → 硬筛                                     | v3 §7.2                         | 竞品 L24623 硬筛                                             | **改硬筛**（本条是少数"竞品对我方错"的）。覆盖率前提已被 20261101T200401 报文满足：区域可判时关键相位（lead60/fight）同区域 176 平台 state 恒=22（176 全录制 20958 帧仅 22/0 两值）；174 兜底已删（两场录制 0 块）；anyBest 仅留「判区失效」改版退路                                                                                 |
| esr 区域归属判定                                         | pilot.js `#bossEsrId`           | 竞品 L24624 `extData.esrId`                            | **差异A定案修订（2026-11-04）：纯 esr 真值，几何判区删除**。录制实测：`#tiles` 是累积池，本体瓦片在 lead 窗首次 901 即缓存 esrId（三 BOSS 分别在 fight 前 105～522s 已可见），所决策时 `#bossEsrId()` 恒非 null。原“96% esr-unknown”是单帧覆盖率，不代表累积池缺证。几何判区（Voronoi/PAB_BOSS_ZONES/#zoneAnchor）从未实际触发，已删除。保留 `if (esr && t.esrId && t.esrId !== esr) return` 作为唯一区域筛子，缺证放行防御改版 |
| 平台选择的在途行军过滤                                           | pilot.js `#pickPlane`           | 竞品 L24867 `marches.find(target_tx/ty 命中)`                | **已补齐**：`#pickPlane` 接入 `#marchBlocked`（复用巡航/打野同款闸：driveMarchPolicy==1 豁免、driveMarchStaleMs 陈旧脱闸），避免选到他人已指向的平台撞 REJ_PLANE_TAKEN                                                                                                                                                               |
| 探索档 `#pickExplore`（`driveIdleExploreMs`+`driveExploreStep`） | pilot.js                        | 竞品无                                                       | **废弃**。依据：本次录制实证它永远被链尾 shop 截断（pilot.js L2118 在 L2406 的 `viewBusy` 短睡前）；重写后 §5.2 三连前置使兜底店有门槛，兜底空了自然会回到探索——但探索依赖本地 entities 加载度，与 §3.1 口径冲突。先删，上机确认井不再常年选不出才考虑重新加                                                                         |
| 幽灵在途条目自愈（`isSecretSending` 久堵时绕闸发探测包）         | pilot.js                        | 真机报文（次通道静默短路的已知缺陷，api.js L197-217 同注释） | **必须保留**——竞品直写 `PabController.sendToBuildingMarch`，它没这道病；我们有，删了就是拿一个已知真故障换一份干净代码                                                                                                                                                                                                               |

---

## 12. 新 `pilot.js` 骨架（结构与命名对齐竞品，便于后续复核）

```js
/**
 * 异能秘境自动驾驶（v4，逐行对齐竞品B enigmaSecret；行号索引见 docs/feat-异能秘境自动驾驶-v4竞品B对齐重写.md）。
 * 执行模型：await 串行拉 901 → 纯函数选点 → 先记 cd 后发 8521；心跳拍不携带语义，节拍全在 #cd 账。
 * 时钟口径：一律 env.gameData.serverTime()（服务器秒），取不到回 0 并整拍放弃，不回落本地钟。
 * 只读 + 发包红线：写动作只有 8521（sendMarch）与 8552（复活）；候选池不读本地 entities（见 §3.1）。
 * 仅队长发车。
 */
import { createCycle } from '../../../core/cycle.js';
import { bits } from '../../../core/game-api.js';
import { tileKey as utilTileKey, dist as utilDist } from './util.js';
import { CMD_MARCH_MOVE, PAB_SHOP, PAB_RESOURCE, ... , TABLE_BUILDING, TABLE_TIMER, TABLE_REALM, TABLE_RSS_STATION, tuning } from './constants.js';

export class PilotEngine {
  #env; #cd = {}; #mooring = { resource: null, shop: null, drop: null };
  #shops = [];          // [{pos:{x,y}, time 秒, sausage, piece}]（pos 每拍重读表，不持久化）
  #marchedList = [];    // [{key, t 秒}]，60s 窗口
  #skippedBoss = {};    // 竞品 state.boss（guard_policy==2 账）
  #viewCache = null;    // 本拍 901 应答（await 回填，下一拍失效）

  // —— S1 阶段（纯函数，无副作用）——
  #exitStageWant()  {}  // §4.1，env 透 petPackFull/markShopLedger
  #shopStageWant()  {}  // §4.2
  #beastStageWant() {}  // §4.3（含 buff_color==5 计数）

  // —— S2 动作（全部 async：内部 await queryWorldView）——
  async #marchResource(minNum, maxDist) {}  // §5.1
  async #marchBeast(minQuality, maxDist) {} // §5.3
  #marchTeam()    {}                          // §5.5（跟队，policy==2 才调）
  #marchShop(preferNoSausage) {}              // §5.2（三连前置）
  async #getBossInfo(boss) {}                 // §5.4
  async #marchPlane(bossInfo) {} #marchBoss(bossInfo) {}

  // —— S2 主树 ——
  async #autoLeader(nowMs) {}                 // §6，分支进出全部 log.debug('pilot: branch=<名>')

  // —— S0/S3 ——
  #syncAnchors() {}                           // 保持现形态（§7 G3）
  #onArrive(pointType, x, y) {}               // §9.1
  async #tick() { /* 前置 → #autoLeader → 固定返回心跳 */ }
}
```

**量化验收线（防“顺手重构”越界）**：

- 新 pilot.js 行数目标 **1400–1700**（现 2797）。删得多的原因：八段阶梯/探索档/五档 `#shopWant`/`#stageChain`/`#isTileEmpty`/`consumed` 账本全没。
- `#pickDbg` 这类逐闸计数可保留，但**必须补一个竞品同款的全量落盘**（L24740-24760）：筛空时把 `{t, points, marches, teamPoint, marchedList}` 写 storage（走 `env.cfg` 侧的持久化口，不在 pilot 里摸 LocalManager）。
- 拆文件＝另一次变更。**本次保持单文件**：若日后下沉目录，`.dependency-cruiser.cjs` L70-72 的 `secret-realm|cs-hunt` 两条 api.js 锚点必须同步改路径，否则规则静默空转报绿（已犯过的坑）。

---

## 13. 实施步骤与验收

| 步  | 内容                                                                                     | 验收手段                                                                                                                                                                      | 回滚点                       |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 0   | 证实 G1 协议号与 G6 `callTId`（用 `20261101T200401` 那份录制的 901 应答 + dashcam 全量） | 脚本打印 901 `pointList` 里 163 点的全部 `m` 键                                                                                                                               | 无（只读）                   |
| 1   | api.js 新增 `pabGroupId`（若需要）/`checkPowerGap`（默认关）+ constants 新增协议号       | `npm run arch` 0 违规 + `npm run lint`                                                                                                                                        | 新方法是增量，不伤存量       |
| 2   | 选点与阶段写成**纯函数**（`(snap, stage, cd) → {x,y,why}\|null`，无副作用），先不接调度  | 双层：`tests/feats/secret-realm-pilot.test.js`（仓内夹具，12 例，CI 可跑）+ `scripts/secret-realm-replay.mjs`（整份 `20261101T200401` 录制 1074 帧规模化重放，仓外，不进 CI） | 纯函数不在生产链路上，零风险 |
| 3   | 重写 pilot.js 主树（§2/§6）+ 平台硬筛（§11）                                             | `tools/secret-realm-drive-probe.devtools.js` 读 `#cd`/`lastBranch`；实机 60s 内至少 1 笔 8521                                                                                 | git 分支保留 v3              |
| 4   | 到点层四处语义（§9）+ 复活 cd 记账                                                       | dashcam 必须出现 `8540 → 8542`（香肠 0→≥），且 `cd.march` 在店后 15s 内不放行                                                                                                 | 同                           |
| 5   | 配置层双轨迁移（§8）+ 面板文案                                                           | 旧 storage 配置升级后行为不变；新面板字段逐项可写回                                                                                                                           | 同                           |
| 6   | **再**逐条考虑加回守卫（§11）                                                            | 每条一个独立 commit                                                                                                                                                           | 同                           |

> 步 2 是关键：**先证后接**。上一轮重写的教训就是“选点与调度同批写完”，导致错归因时要从 153MB 报文反推。纯函数 + 录制回放把这件事变成离线比对。

> **重放验证记录（2026-11-03，`scripts/secret-realm-replay.mjs` 跑整份 `20261101T200401` 录制 1074 帧）**：
>
> - **点形契约坐实**：901 `pointList` 每点是**信封** `{v,x,y,k,id,pointType,m}`，业务（esrId/state/teams数组/iNum/callTId）全在 `p.m` 子对象；`api.js` 原样透传信封，`pilot-select.js` 即按此消费（`p.pointType` + `p.m.*`），与 `#putTile` 归一的内部 `t`（`teams` 化为数量）是两条独立口径，选点层走前者。
> - **窄闸不变量 0 违例**：全 1074 帧，`pickResource` 命中 922 帧（85.8%，`isRoundOpen` 全开、`maxDist` 不裁，聚焦占用/iNum/state），返回点必为 173 且 state0+teams 空+iNum≥5；`pickBeast` 从不泄漏带 callTId 的兽；**(95,163) 从未被当井/兽选中**。
> - **归属闸 double 等值实证**：172 共 21212、带 callTId 3016（14.2%）、去重 31 个 19 位 id。取最高频 `callTId` 当 `myTeamIdNum`，对全帧 2408 头归属兽核对 `beastOwnedByMeOrFree ⟺ Number(callTId)===Number(mine)`：**已方纳入 382 / 他家排除 2026 / 错配 0**——在真实大整数上证成 §5.3 的 double 比口径。

---

## 14. pilot 依赖模块的配合改造清单（竞品 × 报文双向核对，2026-11-03 用 `20261101T200401`）

> 结论先行：新 pilot 能跑通的**前提**是「3 个必须保留的对外契约」+「1 个必须拍板的行军权归属」；其余多数模块**无需配合改**（报文已证独立或口径一致）。竞品把采/买/打/离场全内联进 `enigmaSecret` 一个模块，我方是分引擎——重写**保留分工**（符合本仓架构规范），只在下列接缝处对齐。

### 14.1 逐模块判定（依赖点 × 竞品 × 报文 × 处置）

| 模块                       | pilot 依赖点                                                                           | 竞品做法                                                        | 报文实测(20261101)                                                                                                                                                                                                                                                                                                                                            | 配合改造                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **api.js**                 | `queryWorldView` 候选池 / `sendMarch`·`sendSecret` 写 / 各 getter                      | 单模块内 `asend(901)` 直读 + 内联 `sendToBuildingMarch`         | 901 req 键 `[x,y,k,rid,width,height,marchInfo,viewLevel]` ✓；`points` **整条透传**（`m.callTId/esrId/teams/iNum/rTime` 全在）✓；8521 resp `header.s=3`、`header.d=enigma_realmN`                                                                                                                                                                              | **零改**（points 无损；`sendSecret` 已把 `header.s→code`、`header.d→reason`，pilot 走 `r.reason` 匹配正确）。可选增量：`checkPowerGap`(G2，默认关)                                                                                                                                                                                                |
| **boss.js**                | `isBossish`(176/177/178) 时 pilot 让位，boss.js **自发送打 BOSS 的 8521**              | 竞品 `marchBoss`/`marchPlane` 在 `autoLeader` 内**直接发 8521** | 21535 `stateInfo`；平台 esrId 分桶                                                                                                                                                                                                                                                                                                                            | ⚠ **需拍板**（§14.2）：pilot 若内联打 BOSS 会与 boss.js **双发抢同一条队级行军**                                                                                                                                                                                                                                                                  |
| **shop.js**                | `kickShop` 叫醒买货；`markShopLedger` 回写 `{time,sausage,piece}`                      | 竞品 `shopConver` 内联 8540/8542/8543                           | 8540×14、8542×14、8543×17，全 `s=0`                                                                                                                                                                                                                                                                                                                           | 契约保持；⚠ 账本 `time` 须与新 pilot「去掉 `visited` 字段、只有 `onPabTeamMarchArrive(161)` 真到店才写 time」对齐。§9.2 购物三约束若要照竞品 → 落 shop.js（独立增强，不阻塞开车）                                                                                                                                                                 |
| **warn.js**                | `drive.enabled` 时 warn 让位，「受击转移由 pilot EVADE 承担」（warn.js L151-154 实锤） | 竞品 §6.3 仅「不动/跑」极简防袭，**无逃帐+回攻**                | 21534 攻击警告 738 次                                                                                                                                                                                                                                                                                                                                         | ⚠ **硬约束**：新 pilot **必须实现 EVADE**，否则 warn 一让位 = 受击无人管。这是「我方比竞品强、不能随重写砍掉」的一条                                                                                                                                                                                                                              |
| **leave.js**               | `env.driveExitStage()` 直读 pilot **公开方法 `exitStageWant()`**（leave.js L9/L92）    | 竞品 `judgeLeave` 内联                                          | 8581×1、8589×1（离场）                                                                                                                                                                                                                                                                                                                                        | 契约：pilot 保留 `exitStageWant()` 同名公开方法                                                                                                                                                                                                                                                                                                   |
| **capture.js**             | 无（仅 pilot 读 `getCapturingPetPos` 判「拍宠中不挪」）                                | 竞品 `capturePet` 用 `cc.find` 反射（**不学**）                 | 21530×358、8546×**2307** 投喂                                                                                                                                                                                                                                                                                                                                 | **零改**，靠 21530 独立驱动                                                                                                                                                                                                                                                                                                                       |
| **pickup.js**              | 无（对 `pilot`/`isBossish`/`enterWork` **零引用**）                                    | 竞品 `getResItem` 内联 8526                                     | 21522×835(`bagInfo/buffGetNum`)、21532×23                                                                                                                                                                                                                                                                                                                     | **零改**；§9.4 掉落归属(teamId)/增益择优(8538) 若要照竞品 = pickup 自身增强，不阻塞 pilot。⚠ **例外已消（C4 订正）**：原担心的 pilot→pickup 耦合不成立——buff 在 173 明细非 163 箱（见 §15.10-P1），`crystal_then_skill` 的 buff 档只是把车开到 173 井，到点后 §9.3 自发 8526 + 既有 8538 链自然接管，**双向零新接缝**；`enigmaB_default` 不受影响 |
| **scout.js**               | `env.scoutQuality→qualityAt(x,y)`（未侦察回 null，scout.js L331）                      | 竞品 `scoutBeast` 内联并发 4×901 验活                           | —                                                                                                                                                                                                                                                                                                                                                             | **零改**，契约完好                                                                                                                                                                                                                                                                                                                                |
| **heal.js**                | 无 env 注入                                                                            | 竞品 `recuperate`                                               | 8584×26                                                                                                                                                                                                                                                                                                                                                       | **零改**                                                                                                                                                                                                                                                                                                                                          |
| **constants.js**           | `REJ_*`/`ST_*`/`PAB_*`/`TABLE_*`/`tuning`                                              | —                                                               | `REJ_*` = `enigma_realm<N>` 整串（L742 等）与 `header.d` **口径一致** ✓；`ST_*`(11/12/21/22/23) 已定义 ✓；实测拒绝码 = `enigma_realm158`(=REJ_NOT_ARRIVED✓)/`enigma_realm209`(**已存在=`REJ_SAME_AREA_PLANE`**，字典义「同一区域核心停泊平台之间不允许相互行军」，pilot.js L1802 已归「黑平台、下一拍换台」而非通用退避 ✓)/`common_159995`(=REJ_PARAM_ERROR✓) | §8 新键 + G1 协议号(`TEAM_INFO`，**本局 0 出现→checkPowerGap 默认关**)；**REJ 209 无需新增**（常量与处置均已在位，此前「待补」为凭记忆误记，已证伪）                                                                                                                                                                                              |
| **util.js / game-data.js** | `tileKey`/`dist`；`gameData.serverTime()`/`myUidStr()`                                 | —                                                               | —                                                                                                                                                                                                                                                                                                                                                             | **零改**（serverTime 已存在于 `core/acl/game-data.js` L129）                                                                                                                                                                                                                                                                                      |

### 14.2 唯一必须拍板的架构冲突：打 BOSS 的 8521 谁发

- **方案①（保留分工，推荐）**：新 pilot 只做到竞品 §6.4 的「选 BOSS + `marchPlane` 开上平台」，**到平台后打 BOSS 的那条 8521 仍交 boss.js**（pilot 命中 `isBossish` 即让位）。只偏离竞品「marchBoss 内联」一处，但**不破分层、不双发**，且满足你「必须符合当前架构规范」的要求。
- **方案②（彻底照竞品）**：把 boss.js 攻打档吸收进 pilot、boss.js 降级为纯展示。改动面波及 boss.js 1165 行 + 面板，风险高。

→ 建议①。此项直接决定 t4/t5 的主树与到点层写法。

### 14.3 重写不得破坏的对外契约（破坏则对应引擎静默落空）

1. `class PilotEngine` + `constructor(env)`（index 挂 `engines.drive`）+ `start(ctx)`/`stop()`。
2. 公开方法名：`exitStageWant()`（leave 依赖）、`markShopLedger(key,patch)`（shop 回写依赖）、`onWarnPush`/`onArriveWake`/`onBasePush`（事件入口）。
3. `env` 消费面固定（`buildEnv` 已给：`alive/realmActive/cfg/secret/gameData/gameConf/l10n/ui/log/kickShop/markShopLedger/scoutQuality/petPackFull/driveExitStage`）——新 pilot 要的新数据（如 `buffMap` 增益数、`powerInfos`）一律走 `secret`/`gameConf` 既有 getter，**不新增 env 字段以最小化 index.js 改动**。

---

## 15. 多开车方案（Plan）架构（前瞻性设计，2026-11-03）

> 背景：未来会有多种「开车方案」——如先普通异能区流转采水晶/晶石 → 强异能区开放后冲进去弄技能 → 3 技能满级后回普通区采集 → 大 BOSS 前 5min 去商店购物、前 2min 占位 → 过程中小 BOSS（2 个）前 1min 就近提前 2min 占位。§12 骨架今天只实现**一条**竞品B对齐链；本节把「方案」从引擎里切出来，使**新增方案 = 往数据加一段，而不是再改引擎**。**B1 落 `#tick` 时即按 §15.6 接口实现，避免把今天写死的 if 阶梯再犯一遍。**

### 15.1 三层切分（只有最上层随方案变）

| 层                      | 职责                                                                                                                                           | 随方案变？           | 落点                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| **Engine 引擎**         | 机制与安全：`serverTime` 时钟 / `#cd` 账 / mooring / `#dispatch(8521)` / 安全前置闸（EVADE·拒绝退避·占用·单飞 createCycle·回合硬闸）/ 事件订阅 | **否**（全方案共享） | pilot.js `#tick` 前置段（现状 L2135–2347）                            |
| **Objectives 目标原语** | 「给定快照+区域+参数 → 选出目标点」的纯函数                                                                                                    | **否**（全方案复用） | pilot-select.js：`pickResource`/`pickBeast`/`pickShop` + `#pickPlane` |
| **Plan 方案**           | 阶段的**顺序** + 进入/退出**条件** + 区域筛选 + 每目标参数                                                                                     | **是**（每方案一份） | 新增 plans.js（纯数据 + 纯判据）                                      |

依赖方向（保持无环、dep-cruiser 安全）：`pilot.js → plans.js → pilot-select.js → constants.js`。plans.js 是**纯叶子**：只 import `constants` + `pilot-select`，**不碰 api/net/引擎**（同 `feat-acl-adapters-not-depend-on-domain-or-net` 精神）。

### 15.2 Plan 的数据形状（Stage DSL）

```js
// plans.js —— 纯数据 + 纯判据，无副作用、不发包
export const PLANS = {
  enigmaB_default: { label: '竞品B对齐（内置=现状）', stages: [/* §15.6：逐字复刻今天链 */] },
  crystal_then_skill: {
    label: '水晶→技能→水晶→BOSS',
    stages: [
      {
        id: 'strongSkill',
        obj: 'buff',
        zone: 'strong', // 弄技能（C4 报文订正：buff 在 173 明细非 163 箱，见 §15.10-P1）
        when: (c) => c.progress.areaOpen('strong') && !c.progress.buffsMaxed(3),
      },
      {
        id: 'bossOccupy',
        obj: 'plane',
        params: { target: 'bigBoss' },
        when: (c) => c.until(c.events.bigBossStart) <= 120_000,
      }, // 前 2min 占位
      {
        id: 'shop',
        obj: 'shop',
        when: (c) => c.until(c.events.bigBossStart) <= 300_000 && !c.progress.shopDone(),
      }, // 前 5min 购物
      {
        id: 'smallGuard',
        obj: 'plane',
        params: { target: 'nearestGuard' },
        when: (c) => c.until(c.events.nearestSmallBossStart) <= 120_000,
      }, // 小BOSS 前 2min 就近占位
      { id: 'normalCrystal', obj: 'resource', zone: 'normal' }, // 兜底：其余时间采集
    ],
  },
};
```

**阶段顺序 = 优先级**（第一个 `when` 为真者赢，一拍最多派一笔），与今天 if 阶梯的语义一致。

### 15.3 ctx 契约（快照 + 跨帧进度）

方案判据 `when(ctx)` 与目标参数都从 ctx 取数，ctx 由引擎每拍组装：

- `snap`：`{points, marches, cur, curPt}`（901 原样信封，喂 pilot-select）。
- `clock`：`{serverMSTime, fightBeginTime, fightEndTime}`（`gameData.serverTime()`，不回落本地钟）。
- `progress`：**跨帧累计态**（方案的「3 个 buff 满级后回普通区」依赖它，非单帧可得）。默认走一张共享 tracker；方案可给可选 `reduce(progress, snap)` 钩子定义本方案语义（如「什么算 buff 满级」从背包/21522 buffGetNum 取数）。
- `until(ts)` / `events`：`{bigBossStart, nearestSmallBossStart}` = 从 21535/`stateInfo` 读秒窗推得的开打绝对毫秒；`until` 给「还有多久」。
- `zone`：区域解析器，把 §5.1 藏在 `isRoundOpen(esrId)` 里的语义**泛化成 `ctx.zone(esrId)` 谓词**（普通区 esrId 集 vs 强区 esrId 集）。阶段 `zone:'strong'|'normal'|'any'` 经此过滤传给目标原语（原语签名不变，多一个 `ctx.zone` 回调）。

### 15.4 Objectives 注册表（obj 名 → 原语）

| obj         | 原语                                                                                                                                           | 出处              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `resource`  | `pickResource(points,{...,zone:ctx.zone,...})`                                                                                                 | §5.1              |
| `buff`      | `pickBuffDrop(points, ctx)`（**C4 已落 + 报文订正**：选带 buff 位的 **173 井**（非 163 箱），到点后拾取走 pickup.js 既有 8538 链；接缝零新增） | §5/§9.4/§15.10-P1 |
| `beast`     | `pickBeast`（归属 double 闸）                                                                                                                  | §5.3              |
| `shop`      | `pickShop`（三连前置）                                                                                                                         | §5.2              |
| `plane`     | `#pickPlane(target)`（占位上平台）                                                                                                             | §11               |
| `bossFight` | **不发**，命中 `isBossish` 让位 boss.js                                                                                                        | §14.2 方案①       |

`follow`/`escape`（跟人、遇袭转移）留在引擎前置，**不作 obj**（属安全/机制，非目标）。

### 15.5 解释器：#tick 目标段

```text
#tick():
  <引擎安全前置：dead/realm-off/cfg-off/cooldown/no-base/threat/return/inflight/回合硬闸>   // 全方案共享
  plan = PLANS[config.drivePlan] || PLANS.enigmaB_default
  ctx  = buildCtx(snap, clock, progress)
  for (stage of plan.stages):
     if (stage.when(ctx)):
        target = Objectives[stage.obj](snap, stage.zone, stage.params)
        if (target): return #dispatch(stage.obj, target)   // 顺序即优先级，命中即派并 return
  return <兜底/短睡>
```

### 15.6 B1 落地接口约定（必守，防返工）

1. `#tick` 目标段写成**解释器**（§15.5），**不复制今天硬编码 if 阶梯**；今天只内置 1 个方案 `PLANS.enigmaB_default`，其 `stages` **逐字复刻现状链**（exit→shop→boss-wait→beast→采井→平台→兜底店），用 `scripts/secret-realm-replay.mjs` 对拍保证 0 行为漂移。
2. `plans.js` 纯叶子（§15.1 依赖方向），新方案 = 加数据。
3. 公开方法名不变：`exitStageWant()` 由「exit 阶段 + 引擎收场前置」共同保证（leave.js L92 直读依赖，§14.3 契约不破）。
4. `config.drivePlan` 缺键 → 回落 `enigmaB_default`（旧配置行为不变）。

### 15.7 关键原则：安全留在引擎，方案只改目标

EVADE / 拒绝码退避 / 占用判空 / 单飞 / 回合硬闸 = **全方案共享，写进 Engine 前置，绝不进 plan**。§14.1「warn 让位后 pilot 必须实现 EVADE」这条硬约束不因分方案而松动——方案排的是「去哪拿什么」，不是「要不要安全」。这也是**不采用**「每方案一个 PilotEngine 子类」的原因：子类会诱导各 plan 复制一份安全逻辑，早晚漂移。

### 15.8 配置 / 面板

- `constants`/config 新增 `drivePlan: 'enigmaB_default'`（字符串键，非魔法数）。
- 面板下拉列出 `Object.keys(PLANS)`；切换即写回 `config.drivePlan`。

### 15.9 测试平移（先证后接红利直接复用）

`scripts/secret-realm-replay.mjs` 加 `--plan=<id>`：同一份录制喂不同 plan，断言**阶段翻转时机**（如「强区一开就从采普通井切走」），并核验每个 plan 仍过引擎安全闸；`enigmaB_default` 必须与现状选点逐字一致。

### 15.10 语义拍板（2026-11-03 已定）

- **P1 弄技能（C4 报文订正，2026-11-04）**：原拍板「拾带 buff 的 163 掉落」**不成立**——录制 `20261101T200401` 全量 2149 帧 901（15 万点次）实证：163 的 `m` 仅 `viewId/teamId/playerInfo/esrId/iNum` 无 buff 字段，且 **163 的 esrId 恒 0（不可分区）**；buff 只出现在 **173 资源点明细**（8526 应答/21522 推送的 `buffInfo`，竞品 L25155-25190 同源只读 173）。→ 落码口径：`obj:'buff'` + `pickBuffDrop` 选带 buff 位的 173 井（无记账乐观派、探明整井拿空不回头），拾取走 pickup.js 既有 8538 链（接缝零新增）；`progress.buffsMaxed(n)` 按 `buffMap[1..n]` 满槽理解（「满级」无表据，待线上钉）。强区/普通区按 `realm[esrId].roundid >= driveStrongRoundMin` 切档（字典 FAQ25「先开微异能区后开强异能区」），**阈值取值需线上探针钉死（D1/E1）**，缺省 0＝关闭分区、crystal 方案不可用。**`enigmaB_default` 不含 buff 阶段、不阻塞 B1**。
- **P2 配置期选定（C4 已落）**：方案 id 只在本次 start 后首拍读一次 `config.drive.drivePlan`，整场不热切；`stop()` 解锁、下次 start 重读；未知 id 回落 enigmaB_default。
- **P3 安全闸全方案共享、不可关**：EVADE/拒绝退避/占用/单飞/回合硬闸一律留 Engine 前置，plan 无 `skipGates` 语义（§15.7）。

---

## 附录 A：块 A（世界图组队）竞品要点摘要（备查，不入本次）

| 函数                     | 行号          | 一句话                                                                                                                          |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `isOpen`                 | L24314        | `baseActivityInfo.type ∈ {1,2}` 且 `state ∈ [1,4]` 且未过 `endTime`；type1 看 `currStageEndTimeMs`、type2 看 `teamStartTimeSec` |
| `fastTeam`               | L24319        | 开快速加入开关（`TES_USER_FAST_JOIN_SWITCH {open:1}`）                                                                          |
| `createTeam`             | L24328        | 先关快加 → type2 先 `CQ2025_SECRET_GET_SECRET_LIST` 选最高城级密境 → `sendCreateTeam` + 往「秘境小队」频道发链接                |
| `teamApply`              | L24373        | `TEAM_LIST2` 筛 `!applied && members<maxMembers && (无 parteners 或昵称命中)`，逐个申请，拒后 60s                               |
| `teamAgree`/`kickMember` | L24406/L24420 | 人数不满则同意申请（记 `member_join_time`）；未出兵且加入超 300s 者踢                                                           |
| `sendArmy`               | L24435        | 预设 1/2/3 三套编队逐套出兵，`PAB_TEAM_MARCH` 一次性提交                                                                        |
| `teamDispatch`           | L24533        | 1s 一拍（`n%10`）；全员出兵且人数达 `dataConfig(3010)[0]` 且 `state==4` 超过 `room_delay` 分 → `TEAM_TO_FIGHT`                  |
| `sendChatTips`           | L24507        | 按 `team_type` 往频道发固定文案（0=低保/1=排名/2=全程）                                                                         |

→ 这块与开车无耦合，将来若做，应另立 `secret-realm-team/` 子玩法目，不复用 pilot 的 cd 账。
