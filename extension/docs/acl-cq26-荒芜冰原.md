# acl · CQ26 荒芜冰原（NWL 2111~2130 / push 22071~22077 / 星路大地图 2201 + push 22001）

> 代码落点：`extension/src/core/acl/game-data.js` 的 `── CQ26 印石·荒芜冰原 ──` 区段 —— **星路大地图「身份三元组」三投影 + wl-chest 宝箱子集（§5）已实现**；额度/分区/点位/配置之外的其余签名待实现
> 消费方：`feats/cq26/wl-gather/`（**一个 feat 三腿**：采集 / 协助 / 盗采，设计见 [`feat-荒芜冰原采集.md`](feat-荒芜冰原采集.md)）、`feats/cq26/wl-chest/index.js`（遗失之箱，**已落地**，接线口径见 §6 该行修订）、`feats/cq26/wl-beast/index.js`（冰原巨兽，待立项）
> 形态口径：**不再与 [`feat-战区宝藏.md`](feat-战区宝藏.md) 同族** —— 战区宝藏可纯靠 push 快照，本玩法的点位判据（`initSid`/`gNum`/名单）**只在 901 应答 `pointList[].m`（即游戏实体 `extData`）里**，2201 全图只给到「哪个分区属于哪个服、什么类型/状态」这一层，故 wl-gather 必然带「一次 2201 全图 + 按候选平铺 901」的扫描成本（取舍见 §2.5、§6）
> 证据：真人报文录制（176 个会话文件，本文普查脚本 `.reviewtmp/cq26wl-fielddict.mjs`；三腿与 2201 实证来自印石日常主跑趟实录，脚本 `.reviewtmp/star-land-2201.mjs` / `shownum-is-index.mjs` / `star-land-crosstab.mjs` / `beast-status-scan.mjs` / `beast-xfile.mjs` / `nwl-writes-census.mjs` / `pointtype-census.mjs` / `help-quota.mjs`）

一句话职责：把「荒芜冰原 16 个分区 + 分区里三种玩法」的**运行时状态与身份基准**从游戏内存与推送里投影成标量，让 feat 能像玩家眼睛一样判断"哪个区开着、哪种玩法、还有多少额度、点位属于哪个服"。投影本身零发包；但 wl-gather 的点位级判据不在投影里，必须配合 `2201 + 2120 + 901` 的扫描（§2.5），**不得把本文误读为"全部玩法都可零扫描"**。

---

## 1. 职责与边界

**管**：

- 分区表（`wastelandIndex` → 类型/状态/解锁条件/结束时刻）的只读投影；
- 四类额度（今日采集时长、可盗采次、可守护次、可开箱次）的只读投影；
- 点位清单的只读投影（宝箱点位、巨兽挑战时刻）；**采集点本身的 `gNum/ownerId/名单` 不在 ACL 里**——它们只存在于 901/10018 报文，由 feat 直接解析（§4.4）；
- **星路大地图的"身份三元组"**：`selfInfo.group`（分组号）/ `status.cid`（副本号）/ `UserData.OriginServerId`（本服号）—— 2201 请求参数与「本服 vs 外服」判据的真相源（见 §2.5）；
- 表/配置读取（`series_frost_small_wasteland`、`RESOURCE`、`5200xxxx`）——表名与配置号属符号知识，按分层决策收在 ACL。

**不管**：

- **不发包**。所有 `21xx` 请求由 feat 直接 `sendPBV2`（协议号是服务器↔客户端契约，留在 feat 侧常量表，同 excav.js 的 `CMD_CLAIM = 2491`）；
- **不改写游戏状态**（只读+发包红线：禁止调游戏的 Update/Delete）；
- **不做决策**（选哪个点、何时出手都在 feat）；
- **不管 WLB（冰原会战 2131~2139）与战区巨兽（2451~2459）**：那是跨服占领战，同名"矿山/矿脉"但不同源，本文只辨析不实现。

**对外契约**：全部返回**新建的普通对象/标量**，绝不外泄游戏对象引用（池化对象红线）。符号不可用一律回 `null`，调用方**不得**把 `null` 当"没有点/没额度"。

---

## 2. 设计思路与取舍

### 2.1 为什么数据源选"推送缓存 + 内存投影"双通道

游戏侧自己就是这么活的：`CQ26WasteLandData` 三个 push handler 把服务器推的快照直接存成字段，面板只读它 —— 实证 `CQ26WasteLandData` 源码：

```js
onNWlListPush(e){ this.wlList=e; this.wlListMap={}; for(...of e.wastelandList) this.wlListMap[a.wastelandIndex]=a;
                  EVENT.emit(EventId.CQ26_WL_LIST_STATUS_CHANGE) }
onNWLInfoPush(e){ var o=this.wlInfo&&this.wlInfo.remainChestNum; this.wlInfo=e;
                  EVENT.emit(EventId.CQ26_WL_LIST_INFO_CHANGE);
                  if(o!==e.remainChestNum) EVENT.emit(EventId.CQ26_WL_OPENED_CHEST_UPDATE) }
onWastelandChestPosPush(e){ this._WlBossRwardPBDataPos=e.pos||[]; EVENT.emit(EventId.CQ26_WL_CHEST_POS_UPDATE,...) }
```

三条硬结论：

1. **`2111`/`2120` 这类查询请求在客户端只出现在握手/打开面板时刻**，登录后全量快照随握手送达、录制看不见（同 22062 的情形）。所以 feat **不该**依赖"发个 2111 就能拿到最新态"，而应依赖 `22071/22072/22077` 三条推送维持的常驻快照 —— 这与"零扫描、零主动拉取"是同一件事的两面。
2. `remainChestNum` 变化时游戏**专门补发** `CQ26_WL_OPENED_CHEST_UPDATE`：开箱额度的边沿信号已经内建在游戏事件里，feat 订阅它即可，无须轮询。
3. `wlListMap` 以 `wastelandIndex` 为键 —— 分区状态是**字典不是列表**，投影时保持这个形状，feat 拿 `byIndex[idx]` 是 O(1)。

### 2.2 为什么"分区类型"是必读的第一跳

普查实证：**一个分区只会有一种玩法**，`2112` 应答里只出现与 `wastelandType` 对应的那一个子块 —— 全部 35 场 `2112:resp` 的顶层键组合统计为 `collectArea` 14 / `beastChallenge` 13 / `iceFrozen` 8，**无任何混合样本**（互斥成立，不是"多数时候一个"）：

| `wastelandType` | 枚举（`CQ26Common.CQ26WLLandType`） | `2112` 子块      | 玩法                                                                            |
| --------------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| 1               | `BOSS_SKILL`                        | `beastChallenge` | 冰原巨兽挑战                                                                    |
| 2               | `ICE`                               | `iceFrozen`      | 融冰（点火→小游戏）                                                             |
| 3               | `GATHER`                            | `collectArea`    | 采集（矿山/雷神矿脉）+ 开箱                                                     |
| 5               | `HELP_BOSS`                         | —                | 冰原巨兽援助地块（**2x2 房间专属**，带 `beastStatus`；本 feat 族不做，见 §4.6） |
| 0               | `NONE`                              | —                | 未知（首遇记 warn）                                                             |

⇒ 决策顺序必须是 **index → type → 分支**，而不是"遍历所有点找宝箱"。这也解释了为什么「遗失之箱」挂在采集区（type 3）：宝箱点位推送 `22077` 与采集点共用同一张分区图。

### 2.3 被否决的备选

| 备选                                               | 否决理由                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| feat 启动时发 `2111`+逐分区 `2112` 拉全量          | 16 分区 × 每分区一次 Detail = 结构性轮询；且 `2112` 应答不含点位坐标，拉了也定不了目标。录制里 `2112` 的 35 次全部出现在玩家面板流量上下文中（紧跟 `2120`/`2127`/`2118` 一类面板动作），未见任何周期性自拉。                                                                                        |
| 地图 901 扫图找采集点/宝箱                         | 与 feat-战区宝藏 同一否决：点位权威源已在 `22077`（宝箱）与地图实体 `extData`（采集点）里，扫图既贵又会漂。                                                                                                                                                                                         |
| 直接读 `wlList` 原始数组喂给 feat                  | 对象是报文孪生体、跨帧引用即外泄；且 `wastelandCondition` 这类原始枚举漏进业务层会把符号漂移成本摊到每个 feat。                                                                                                                                                                                     |
| ~~ACL 里发 `2116` 换 `remainGuardNum` + 本地记账~~ | **本条已作废（20261108 实录推翻）**：`22072` 每次写动作**同秒下发**并带完整额度块（`remainStealNum 3→2→1`、`remainHelpNum 2→1→0`），游戏把它写进 `wasteLandData.wlInfo`，四个 getter 直读 ⇒ 本地记账完全不必要。唯一纪律是三态：`wlInfo==null` 回 `null`，不得把「无快照」读成 `0`（见 §4.2、§5）。 |
| 逐房间发 `2127 ROOM_INFO` 建「分区→服」映射        | 一房间一查（本场 18 次），且只给分区级 `{x,y,localX,localY,status,occupyForceId}`。**`2201` 一次就给全 612 个 region 的 `mSid`**（§2.5），2127 降级为单房间细查。                                                                                                                                   |

### 2.4 `k` 就是 `wkid`（跨服落点原语的前提）

三处交叉证明 `pos.k === wkid`，格式 `RRRRRLLTT`（5 位区号 + localX + localY + 1 位）：

- `2120`（分区中心）应答 `{pos:{x:101,y:356,k:14001012}}`，同场 `2127`（`NWL_ROOM_INFO`，req `{wkid}`）应答里该分区行 `{x:101,y:356,localX:0,localY:1,...}`，`occupyForceId=3828`；
- `2128`（`NWL_NEAREST_ICE_POS`）req `{wastelandIndex:0,sid:14002212}` → resp `{wkid:14002212,x:196,y:26}` —— **请求里的 `sid` 与应答里的 `wkid` 同名同值**，说明地图实体的 `serverId` 字段装的就是 wkid；
- 采集点气泡 `CQ26WLWorldResourceBubble.onClickSteal/onClickHelp` 取 `entity.serverId` 当 `wkid` 发 `2115/2116`，实证 `2116 req {wkid:14002212 系的 14002112, x:775, y:445}`。

⇒ 「飞到点 / 发守护」这类原语只需要 `(x, y, k)` 三元组，`k` 直接当 `wkid` 用，无须额外查询。
⇒ **未定项**：`wkid % 100` 是 localX/localY（已验 `14001012 % 100 = 12` → localX=1,localY=2），但 `local → wastelandIndex` 的反查映射需要分区表基准坐标才能建，本文**不声称可做**；在有基准之前，feat 一律从 `wlList` 正向带 `index`，不从坐标反推分区。

### 2.5 全图入口是 `2201`：三个请求参数、一个主键、一层粗筛

「哪个服在哪个分区开了哪种玩法」这件事，过去只能逐房间 `2127` 试（本场真人流量 18 次），`2201 SERIES_FROST_STAR_LAND_MAP_SINGLE_INFO` 一次就给全：**144 格 grid → 89 个冰原房间 → 612 个 region，每个 region 自带 `mSid`（归属服）**。这是盗采/协助自动化的唯一低成本入口，也是本文把它列为一等公民的原因。

**三个请求参数的真相源**（源码 `CQ26MapData.requestData` 逐字：`{cid: ctrl.status.cid, serverId: e.serverId, group: e.group}`）：

| 参数       | 来源                                                                       | 符号还是协议 | 自动化口径                                          |
| ---------- | -------------------------------------------------------------------------- | ------------ | --------------------------------------------------- |
| `cid`      | `CQ26Controller.status.cid`（`SERIES_FROST_STATUS` 推）                    | 游戏符号     | ACL 投影只读，**不得**自己填 2                      |
| `group`    | `CQ26Controller.selfInfo.group`（push **22001** `SERIES_FROST_SELF_INFO`） | 游戏符号     | ACL 投影只读；**每拍现读，不缓存**（见下）          |
| `serverId` | 客户端不传（`undefined` ⇒ 本服）                                           | 协议         | 本服快照不带；`CQ26MapDataMgr` 只在显式看某服时才带 |

`group` 的语义 = **本服在本次星路活动里的分组号**（同组约 36 个服同屏竞争：本场 `mSid` 去重恰 36 个服、每服摊到 17 个 region）。它有三个会变的信号，全部来自源码，必须在实现里尊重：

1. `RealCQ26Controller.updateSelfInfo`：`this.selfInfo?.group !== e.group` ⇒ 置位后 `mapData.requestData({group, force:!0})` —— 换组即整图重拉；
2. `RealCQ26Controller.updateStatusData`：`e.isRegroupRound` 且 `round` 变化 ⇒ `onRoundChange()` —— **每轮可能重新分组**，所以 group 不是常量；
3. `CQ26MapDataMgr` `t.group = t.group || ctrl.selfInfo.group`，且 `t.group === selfInfo.group` 才复用权威 `mapData` 单例，否则 `new CQ26MapData()`；`CQ26MapUI` 用同一判据决定隐藏 `infoContent`/`filterNode` —— 游戏自己看别组地图时都不显示本组信息面板，投影侧同样**禁止跨组混用**。

**region 主键 = `(mSid, showNum)`**，且 **`showNum === wastelandIndex`**（实证 `.reviewtmp/shownum-is-index.mjs`：本服 17 个 region 中 16 个与 2111 `wastelandList` 逐条 `type/status` 全等；唯一"不符"的那条是 `showNum=0` 的 type5 援助地块，它本来就不在 16 分区表里）⇒ 拿到候选后可直接 `2120 {wastelandIndex: showNum, sid: mSid}` 定中心点，无须任何中间换算。注意源码侧把这个值当 `showId` 传给渲染层（`applyWastelandRegions` 里 `var i=t.showNum||0`），"相等"是**报文实证**而非源码断言，故实现里要保留一次校验（同分区 type/status 对不上就 warn 并退回逐房间路径）。

**粗筛谓词与它不能替代的那一层**：

- `wastelandType===3 && status===4(OPENING)` ⇒ 本场 34 个候选 = 本服 1 + 外服 33（`.reviewtmp/star-land-crosstab.mjs`）；
- `status===5(OPENED)` 的 type3 分区共 83 个（本服 2 + 外服 81）**也能进**（用户口径），但真人本场所有可盗/可助点都落在 status=4 ⇒ v1 只跑 4，5 留配置开关；
- **粗筛 ≠ 有矿**：`status` 是**分区级**状态，34 个候选里真正存在可盗成熟点的只有 1 个房间（`wkid=14003212`）⇒ §4.4 的 901 精筛层不可省，也不能靠 2201 直接发 2115。

---

## 3. 协议台账（req / push 全量登记）

### 3.1 请求（`NRequestIdV2.SERIES_FROST_*`）

| cmd  | 名称                                | req 载荷                                                                                                                                                           | resp 关键字段                                                                                                          | 录制 n                                                                                                         | 出处                                          | 消费方                                                                                                            |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 2111 | `NWL_INFO`                          | `{}`                                                                                                                                                               | 见 §4.1                                                                                                                | 20                                                                                                             | 源码+实录                                     | 只读（不主动发）                                                                                                  |
| 2112 | `NWL_DETAIL`                        | `{wastelandIndex}`（外服分区可带 `sid`，实证 `{3,sid:3895}`/`{9,sid:3828}`/`{6,sid:4178}`）                                                                        | 按 type 三选一子块                                                                                                     | 35+21                                                                                                          | 源码+实录                                     | 只读（不主动发）                                                                                                  |
| 2113 | `NWL_OPEN`                          | `{wastelandIndex, timeIndex}`                                                                                                                                      | 同 2112 形态                                                                                                           | **0**                                                                                                          | `CQ26WLOpenBaseComponent.sendToUnlock`        | 不做（联盟/引导权限）                                                                                             |
| 2114 | `NWL_COLLECT`                       | `{wastelandIndex, x, y}` —— **`wastelandIndex` 传的是 `extData.specIndex`**（源码 `CQ26WLWorldGatherPop.onClickAction` 直接把它当 `wastelandIndex` 发），不是 wkid | `{isOk:1}`                                                                                                             | **3**（20261108 实录：`{9,682,384}`/`{9,716,436}`/`{9,723,433}`）                                              | 源码+实录                                     | **wl-gather 采集腿**                                                                                              |
| 2115 | `NWL_STEAL`                         | `{wkid, x, y}`（`wkid` = 地图实体的 `serverId`/`k`）                                                                                                               | `{rewardResult:{resource…}, remainStealNum}`                                                                           | **2**（`{14003212,101,343}`→`thor_elements:1449, remainStealNum:2`；`{…,86,354}`→`gold:78, remainStealNum:1`） | 源码+实录                                     | **wl-gather 盗采腿**                                                                                              |
| 2116 | `NWL_GUARD`                         | `{wkid, x, y}`                                                                                                                                                     | `{rewardResult, **remainGuardNum**}`（注意：应答叫 `remainGuardNum`，2111/22072 里叫 `remainHelpNum`，同一额度两个名） | **2**（`{14002112,639,279}`→`thor:1575, remainGuardNum:1`；`{…,627,283}`→`gold:78, remainGuardNum:0`）         | 源码+实录                                     | **wl-gather 协助腿**（面板"帮助"按钮）                                                                            |
| 2117 | `NWL_FIRE`                          | `{wastelandIndex, x, y}`                                                                                                                                           | `{isOk, rewardResult}`；另有 `{miniGameId}` 分支                                                                       | 1                                                                                                              | `wasteLandData.meltIce`                       | 不做（融冰是小游戏入口）                                                                                          |
| 2118 | `NWL_GET_CHEST`                     | `{wastelandIndex, x, y}`                                                                                                                                           | `{rewardResult}`（实测 `resource` 全 0、只有 `items`）                                                                 | 5                                                                                                              | `CQ26WLWorldRewardBoxPop`                     | **wl-chest**                                                                                                      |
| 2119 | `NWL_OPENED_CHEST_LIST`             | `{wastelandIndex}`                                                                                                                                                 | `{posList:[{x,y,k}]}`                                                                                                  | 2                                                                                                              | `wasteLandData.sendGetOpenedChestList`        | 冷启动补一次（见 §5）                                                                                             |
| 2120 | `NWL_POS`                           | `{wastelandIndex}` 或 `{wastelandIndex, sid}`（外服必带 `sid`=归属服，实证 `{6,4178}`/`{8,3918}`/`{15,3765}`）                                                     | `{pos:{x,y,k}}`（**单点，非数组**）                                                                                    | 13+9                                                                                                           | 实录                                          | 跳转锚点 / L1 定房间                                                                                              |
| 2121 | `NWL_COLLECT_RECALL`                | `{marchId:Int64}`                                                                                                                                                  | `{isOk}`                                                                                                               | **2**（1093.6 / 4185.2）                                                                                       | `CQ26WLWorldGatherPop.onReturnBtnClick`       | wl-gather 采集腿                                                                                                  |
| 2122 | `NWL_COLLECT_WKID_LIST`             | —                                                                                                                                                                  | —                                                                                                                      | **0**（客户端零调用点）                                                                                        | **客户端零调用点**                            | **登记不接线**；但名字烔"直接给在采点 wkid 清单"，若能一次查出可省掉整个 L1+L2，**待单次实验验证**（见 §6 未解④） |
| 2123 | `NWL_MARCH_SPEED_UP`                | `{marchId:Int64, itemId}`                                                                                                                                          | `{isOk}`                                                                                                               | **11**（`itemId` 实测只用 `520001`/`520002` 两种，且总发生在 **2121 召回之后**、同一个 marchId）               | `wasteLandData.sendToMarchSpeedUp`            | wl-gather 采集腿（**压回程时间**）                                                                                |
| 2124 | `NWL_BEAST_SKILL_ACTIVATE_INFO`     | `{wastelandIndex}`                                                                                                                                                 | `{fightValue, selfFightValue, timeIndex}`                                                                              | 15                                                                                                             | 实录                                          | wl-beast                                                                                                          |
| 2125 | `NWL_BEAST_SKILL_ACTIVATE`          | `{wastelandIndex, troop}`                                                                                                                                          | `{isOk}`（当场结算伤害）                                                                                               | 2                                                                                                              | 实录+`wasteLandData.sendChallengeWlBoss`      | **wl-beast**                                                                                                      |
| 2126 | `NWL_BEAST_SKILL_CHANGE_TIME_INDEX` | `{wastelandIndex, timeIndex}`                                                                                                                                      | —                                                                                                                      | 0                                                                                                              | `CQ26WLOpenBossComponent.sendChangeTimeIndex` | 不做（时刻由盟里定）                                                                                              |
| 2127 | `NWL_ROOM_INFO`                     | `{wkid}`                                                                                                                                                           | `{wastelandList:[{x,y,localX,localY,status,wastelandType,occupyForceId,endTime}]}`                                     | 26+18                                                                                                          | 实录                                          | 单房间细查（建「分区→服」映射的职责已交给 2201，见 §2.5）                                                         |
| 2128 | `NWL_NEAREST_ICE_POS`               | `{wastelandIndex, sid}`                                                                                                                                            | `{wkid, x, y}`                                                                                                         | 4                                                                                                              | 实录                                          | 不做                                                                                                              |
| 2129 | `NWL_FIRE_MINI_GAME`                | `{id:Int64, index:1\|2}`                                                                                                                                           | `{rewardResult}`                                                                                                       | 7                                                                                                              | 实录                                          | 不做                                                                                                              |
| 2130 | `NWL_TODAY_GET_FIRE_NUM`            | —                                                                                                                                                                  | —                                                                                                                      | 0                                                                                                              | **客户端零调用点**                            | 走 push 22074                                                                                                     |
| 2110 | `NWL_DONATE_FIRE`                   | `{wastelandIndex, donateNum}`                                                                                                                                      | `{isOk, rewardResult}`                                                                                                 | 0                                                                                                              | `wasteLandData.donateFire`                    | 不做                                                                                                              |

> 2113/2132 之类带权限或转服的请求一律"登记不接线"，理由同 feat-战区宝藏 对 2490/2492 的处理：客户端零调用点或需要 `AuthorityType26` 级别权限，自动化去撞它是噪音不是收益。

### 3.2 推送（`NResponseIdV2`）

| cmd   | 名称                           | payload                                                                              | 录制 n                            | 语义                                                                       |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------- |
| 22071 | `NWL_LIST_PUSH`                | `{wastelandList:[{wastelandIndex,status,wastelandType,wastelandCondition,endTime}]}` | 8（每次 16 行，**全量**）         | 分区状态权威；**不含 `sid`/归属服**（实证：外服分区列表里根本没有 sid 键） |
| 22072 | `NWL_INFO_PUSH`                | 标量集合，见 §4.2                                                                    | 7+10                              | **额度权威，且每个写动作同秒下发**（见 §4.2 实证）                         |
| 22074 | `NWL_TODAY_GET_FIRE_NUM_PUSH`  | `{num, canGetNum}`                                                                   | 0→本场 10（每次写动作同秒伴随推） | 今日点火道具数/上限                                                        |
| 22076 | `NWL_FIRE_MINI_GAME_REWARD`    | 奖励                                                                                 | 0                                 | 小游戏结算                                                                 |
| 22077 | `NWL_WASTELAND_CHEST_POS_PUSH` | `{pos:[{x,y,k}]}`                                                                    | **57**（每份 17~21 点）           | **宝箱点位**，全量快照（开过的会从中消失）                                 |

> 与本协议族同场景但不是 NWL 号段的两个到账/刷新通道，feat 需订（均为世界地图通用推，不走 `wasteLandData`）：**`10018`** 单 tile 变更（`pointInfos[].m/.r/.t`，含采集点新 `m`，写完动作同秒即推）；**`10001`** 资源总量变更（盗采/协助的即时入账在这里，而不是邮件）。

### 3.3 星路大地图（不在 NWL 号段，但是本玩法的全图入口）

| cmd   | 名称                                  | req / payload                                                               | 录制 n                             | 语义                                                                                                                                                                    |
| ----- | ------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2201  | `STAR_LAND_MAP_SINGLE_INFO`           | req `{cid, serverId, group}` → resp `{maxX:11, maxY:11, grid:[144], group}` | **8**                              | 整片星路一次性快照：`grid.type` = 0:1 / 1:35(`serverInfo`) / 2:19(`cityInfo` 中立城) / 3:89(`wastelandInfo` 冰原房间)；89 房间摊出 **612 个 region**（字段字典见 §4.6） |
| 22001 | `SERIES_FROST_SELF_INFO`              | push `{group, resistanceLevel, monsterSelfInfo:{…}}`                        | 1（上一场会话，ts 比本场早约 34h） | **`group` 的权威来源**（本场值 14）；`CQ26Response` Handler → `ctrl.updateSelfInfo(t.data)`                                                                             |
| 22023 | `SERIES_FROST_NEUTRAL_CITY_SELF_INFO` | push                                                                        | 0（本族不接）                      | 中立城个人信息，与采集腿无关                                                                                                                                            |

### 3.4 游戏事件（`EventId`，feat 走 `ctx.on.event` 订阅）

`CQ26_WL_LIST_STATUS_CHANGE` / `CQ26_WL_LIST_INFO_CHANGE` / `CQ26_WL_OPENED_CHEST_UPDATE` / `CQ26_WL_CHEST_POS_UPDATE` / `CQ26_WL_TODAY_FIRE_NUM_CHANGE` / `CQ26_WL_OPEN_SUC` / `CQ26_WL_SELECT_LAND`（值取自运行时 `EventId` 枚举，不硬编码数字，缺失时 warn 一次 —— 同 global-map.js 的 `SERVER_VIEW_CHANGE` 写法）。

**为什么不直接 `ctx.on.push(22077)`**：两条都要。push 是数据通道（把快照落到 ACL 投影能读的位置），event 是**变化**通道（`remainChestNum` 的下降游戏已经帮我们比好了）。

> **wl-chest 落地修订（20261108）**：`feats/cq26/wl-chest/index.js` 的 kick 走的是 **push 22077/22072/22071**，不是这三路 `EventId`。理由逐字来自源码：`CQ26WasteLandData.onWastelandChestPosPush/onNWLInfoPush/onNWlListPush` 就是在各自 push handler 里 `EVENT.emit(...)`（本文 §2.1 的那段代码），**同源同时刻**；订 push 一侧既拿到 kick 又顺手存下投影不可用时的标量回落副本，不必再为 feat 新开一层 ACL 事件面。`remainChestNum` 的边沿（`CQ26_WL_OPENED_CHEST_UPDATE`）因此不必单独订阅 —— 22072 到货本身就意味着额度权威刷新。

---

## 4. 字段字典（普查口径：n=出现次数 / 覆盖率基于该协议 resp 条数）

### 4.1 `2111` resp（`n=20`，字段覆盖 100%）

| 字段                                   | 样例                | 语义（源码锚点）                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curStage`                             | 1 / 2               | 赛季阶段 `CQ26WLStatus`：`1 CAN_OPEN`(开荒中) / `2 NOT_OPEN`(面板「等待下次开荒」) / `3 ENDED`(面板「已结束」，不再显示倒计时)；`curStageEndTime` 配 `CQ26WLOpenMain` 倒计时。**只有 1 才有矿可挖/可盗/可助**（wl-mine 三腿的阶段闸，见 §6 坑16） |
| `curStageEndTime`                      | 1794240000          | 阶段结束秒（2 阶段实录见 21h+ 倒计时，睡到这个时刻是正解）                                                                                                                                                                                        |
| `todayCanGatherTime`                   | 57600               | **今日剩余采集时长（秒）**，57600=16h；`getTodayCanGatherTime()`                                                                                                                                                                                  |
| `remainStealNum` / `remainHelpNum`     | 3 / 3               | 可盗采次 / 可守护(帮助)次；`getRemainStealNum/getRemainHelpNum`                                                                                                                                                                                   |
| `remainChestNum`                       | 4 / 5               | 可开箱次；`getRemainChestNum()`，上限 `52000426`                                                                                                                                                                                                  |
| `isGathering`                          | 0 / 1               | 本人是否已在采集（同点互斥判据）；`getIsGathering()`                                                                                                                                                                                              |
| `elecPower`                            | 2912 / 3306 / 34208 | 电力（开分区花费的池子，`series_frost_small_wasteland.price`）                                                                                                                                                                                    |
| `warEnergy` / `warEnergyWeekAdd`       | 6320 / 18000        | 战区能量 / 周上限（`CQ26WLOpenMain` 面板字段，本族不做）                                                                                                                                                                                          |
| `bwlRelativeX` / `bwlRelativeY`        | 1 / 1               | 巨兽盛宴(BWL)大地图相对坐标，`CQ26WLOpenMain` 消费                                                                                                                                                                                                |
| `rescueInfo.{needUnlock,total,unlock}` | 700 / 3500 / 2148   | BWL 救援进度（本族不做）                                                                                                                                                                                                                          |
| `wastelandList[]`                      | 每次 **16** 行      | `{wastelandIndex, status, wastelandType, wastelandCondition, endTime}`                                                                                                                                                                            |

`status`（`CQ26WLLandStatus`）：`1 LOCKED / 2 CAN_OPEN / 3 WAIT_START / 4 OPENING / 5 OPENED / 6 CAN_REOPEN`。
**只有 `status===4(OPENING)` 才能做动作** —— 实证 `checkWlOpening(idx)` 严格比 `=== OPENING`，否则面板提示 `101104`。
`wastelandCondition` 观测值只有 1/2/3，随 `curStage` 递增（阶段门槛），`CQ26WLOpenLandCellComponent` 用它判解锁；自动化侧**只当"能不能开"的参考，当前不做判断**。

### 4.2 `22072` push（`n=7`，100% 覆盖）

与 2111 的标量子集完全一致：`curStage, curStageEndTime, remainStealNum, remainHelpNum, todayCanGatherTime, elecPower, warEnergy, warEnergyWeekAdd, remainChestNum, isGathering`。**不带 `wastelandList`**（分区状态只走 22071），也**不带 `remainGuardNum`** —— 见 §6 坑3。

### 4.3 `2112` resp 三选一子块

`collectArea`（type 3，n=14）：`{remainStealNum, remainHelpNum, endTime, todayCollectDuration}`
→ `todayCollectDuration` 是**已采集时长**（面板文案 `series_frost_wasteland_text_019` = 已用/上限，上限取 `52000363` 后 `formatHour`），方向与 2111 的 `todayCanGatherTime`（剩余）**相反**，混用是经典翻车点。

`beastChallenge`（type 1，n=13）：`{endTime, resistanceDemand, unlockProgress, challengeTime, selfResistance, fightValue, selfFightValue}`
→ `resistanceDemand` 与玩家 `getResistance()` 对比决定伤害文案；`fightValue` 是**该场巨兽累计伤害**、`selfFightValue` 是本人贡献（实录 `2124 → {fightValue:14046494415471366, timeIndex:0, selfFightValue:0}`）；`challengeTime` 是**时刻索引**（不是时间戳！），取值范围是配置 `52000372` 的 `"8|12|18|22"` 数组下标，源码另读 `nextChallengeTime`、`canRechallengeTime`（本次普查样本未出现 ⇒ 记为"存在但本批录制未覆盖"）。

`iceFrozen`（type 2，n=8）：`{endTime, openIceNum, allIceNum, openProgress, selfThawNum, waitExploreTreasureNum}`
→ 进度 = `openIceNum/allIceNum`（`text_044`）；`selfThawNum` 本人融冰数；`waitExploreTreasureNum` 待探索宝藏数；`openProgress` 走 `CQ26WLRemoveIceView`。本族不做。

### 4.4 采集点地块：`901 pointList[].m`（游戏实体 `extData`）——三腿谓词全在这儿

报文形状（实证 `.reviewtmp/pointtype-census.mjs`，本场 901 应答共 7692 个带 `initSid` 的点）：

```jsonc
// 901 resp.pointList[i]  —— pointType 316 = 荒芜冰原采集点
{
  "v": 0,
  "x": 101,
  "y": 343,
  "k": 14003212,
  "id": 426341,
  "pointType": 316,
  "m": {
    "itemId": 4501,
    "specIndex": 6,
    "initSid": 4178,
    "ownerId": "10535561301377",
    "gatherStartTime": 1794105483,
    "gNum": 6037,
    "oNum": 1449,
    "stealUidList": [],
    "protectUidList": [],
    "expireTime": 1794240000,
  },
}
```

- **`pointType` 分流**：`316` 采集点（唯一带 `gNum/oNum/名单` 的），`317` 冰原 PVE（带 `pveId/type`），`319` 只带 `initSid+itemId+specIndex`（无存量），`315` 本场仅 2 次。三腿只认 316。注意 `315` 同时是 `MarchType.CQ26_WASTELAND_GATHER` 的值，**两个号段不同源，不得互推**。
- **增量刷新通道**：同一份 `m` 形状也会出现在 `10018 pointInfos[].m/.r/.t`（单 tile 变更推）——实录中 2115 之后同秒就推了被盗点的新 `m`（`gNum` 6037→4588、`stealUidList` 写入自己 uid）⇒ 写完动作后不需要重扫即可确认到账。
- 表字段语义：

| 字段                              | 语义                                                                                                                                                          | 锚点                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `specIndex`                       | 所属 `wastelandIndex`；**缺失即不可采**（`clickCQ26WLGather` 直接 return）；`2114` 请求里的 `wastelandIndex` 就是它                                           | `NWorldMapTileClickUtils` / `CQ26WLWorldGatherPop.onClickAction` |
| `itemId`                          | `RESOURCE` 表主键 → `1301 矿山(钻石)` / `1303 雷神矿脉(雷神元素)`；实录值 `4501/4502` 为同一字段另一形态（行含 `level/gather_speed/resource_type/drop_show`） | `CQ26WLWorldGatherPop`                                           |
| `ownerId`                         | 采集者 StrUid（**字符串**）；`""`/`"0"` = 无主                                                                                                                | `hasGatherOwner` / `isGatheringResource`                         |
| `initSid`                         | 点的**归属服**（不是占领者服）；所有跨服判据的唯一地基                                                                                                        | `canSteal` / `canHelp` 首闸                                      |
| `gatherStartTime`                 | 本次采集起始秒；成熟判据 `gatherStartTime + conf(52000367) <= ServerTime`。实录有 `66318s` 量级的陈旧值，故**不得单靠它判在采**，需 `gNum>0` 兜底             | `NWICQ26WLResource`                                              |
| `gNum` / `oNum`                   | 已采量 / 单次可得量（`oNum = floor(gatherSpeed/2)`，不跨档叠加；`gNum = floor(在采秒/60) × gatherSpeed / 60`）                                                | 同上 + 三次实测                                                  |
| `stealUidList` / `protectUidList` | 已盗采者 / 已守护者 StrUid 名单；`两者长度之和 >= conf(52000364)` ⇒ 谁都动不了                                                                                | 同上                                                             |

**三腿资格谓词逐字对齐**（源码 `NWICQ26WLResource`，闸门按序，**任何实现不得改序**）：

| 序  | `canSteal`（盗采，外服腿）                                   | `canHelp`（协助，本服腿）                               |
| --- | ------------------------------------------------------------ | ------------------------------------------------------- |
| 1   | `initSid` 存在且 `!== OriginServerId`（⇒ 无主点不可盗）      | `initSid` 存在且 `=== OriginServerId`（本服专属）       |
| 2   | `stealUidList` 含自己 ⇒ false                                | `ownerId` 空/`"0"`/自己 ⇒ false（**必须已有他人主人**） |
| 3   | `steal+protect 长度之和 >= conf(52000364)` ⇒ false           | `protectUidList` 含自己 ⇒ false                         |
| 4   | `getRemainStealNum() <= 0` ⇒ false                           | `steal+protect 长度之和 >= conf(52000364)` ⇒ false      |
| 5   | `gatherStartTime > 0 && 已成熟` ⇒ true（**不在采就不可盗**） | `getRemainHelpNum() <= 0` ⇒ false                       |
| —   | （不校 `ownerId`！）                                         | `!(gatherStartTime > 0) \|\| 已成熟` ⇒ true             |

⇒ 两处关键差异（均为源码事实，不是我们的选择）：**盗采不校 `ownerId`，靠 `gatherStartTime>0` 隐含有人在采**；**协助在 `gatherStartTime==0`（尚未开采）时直接放行**，而盗采同场景为 false。面板按钮可见性 `needShowResourceBubble = canSteal || canHelp || hasGatherOwner`，即与玩家眼睛同源的完整口径。两腿都不校 `status===OPENING`（那是 `checkWlOpening` 在弹层里的事，feat 需自己补）。

### 4.4.1 实测扣减语义（三腿收益模型，均已逐帧证实）

| 动作        | 对 owner 侧 `gNum`                                                                                                     | 到账通道                                                                                           | 额度字段                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `2115` 盗采 | **精确扣减**（101,343：6037→4588，缺 1449 = 盗得量；86,354：467→389，缺 78）；`oNum` 没有变化；同刻写入 `stealUidList` | `2115 resp.rewardResult.resource` + **10001 即时入账**（THOR+1449 / GOLD+78），**不走 10264 邮件** | `remainStealNum` 3→2→1                                 |
| `2116` 协助 | **不扣**（14385→14385、320→320）——早期“30 条缺口=0”的错误结论就源于样本全是协助                                        | `2116 resp.rewardResult` + 10001                                                                   | `remainGuardNum` 1→0（应答名），快照叫 `remainHelpNum` |
| `2114` 采集 | 自己占用该点，后续 `gNum` 回升（owner 继续采）                                                                         | 行军回程到账（`2121` 召回 / `2123` 加速）                                                          | 占 `MarchType 315` 名额 + 耗 `todayCanGatherTime`      |

收益公式（3 次实测）：`gNum = floor(在采秒/60) × gatherSpeed / 60`；可盗/可助所得 `oNum = floor(gatherSpeed/2)` ⇒ **跨池择优而非枚举数量**（gs=2898→1449 vs gs=157→78，差近 20 倍），而每日盗采额度只有 3 次 ≪ 33 个外服候选。

### 4.5 配置号（`getDataConfigData`）

| 号                             | 语义                                                              | 实证                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 52000363                       | 每日采集时长上限（小时口径由 `formatHour` 处理）                  | `CQ26WLOpenGatherComponent`                                                                                                          |
| 52000364                       | 单点 `steal+protect` 总人数上限                                   | `canSteal/canHelp`                                                                                                                   |
| 52000367                       | 单次采集时长（秒），到点即"成熟"（`canSteal`/`canHelp` 尾闸用它） | `NWICQ26WLResource`；**值本身不可从报文推**（报文里只能看到结果），故必须由 ACL `cq26WlConf(52000367)` 现读，feat **禁止硬编码秒数** |
| 52000372                       | 巨兽场次时刻表 `"h\|h\|…"`，`challengeTime`/`timeIndex` 是其下标  | Boss 组件                                                                                                                            |
| 52000426                       | 宝箱每日上限                                                      | `getChestDailyLimit`                                                                                                                 |
| 52000359 / 52000369 / 52000427 | 融冰各档道具数 / 点火道具 itemId / 小游戏倍率                     | 融冰线，本族不做                                                                                                                     |
| 17004                          | 侦察体力（`WorldMapScout`）                                       | `NWorldMapTileClickUtils`                                                                                                            |

表：`series_frost_small_wasteland`（分区：`price` 电力、`resitance_demand`（注意拼写是 `resitance`）、`beast_skill_1/2`、`ice_place_reward`）、`series_frost_server_beast`（技能阈值）、`RESOURCE`（1301/1303）。

### 4.6 `2201` region 字段字典（含 `beastStatus` 的诚实结论）

快照层级：`data.{maxX:11, maxY:11, group, grid[144]}` → `grid[].{type, pos, surfaceType, serverInfo|cityInfo|wastelandInfo}` → `wastelandInfo.{id, wkid, sid, regions[]}` → `region`：

`{id, mSid, showNum, wastelandType, pos:{x,y}, areaType, status, specId}` + （**仅 type5**）`beastStatus`

实证口径（`.reviewtmp/star-land-crosstab.mjs`，本场首份快照 612 region）：

| 字段                    | 分布 / 取值                                       | 解读                                                                                                                                        |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `mSid`                  | 36 个不同服，每服 17 个 region                    | 归属服；与 `2127.occupyForceId`、`901.m.initSid` 同语义（已交叉验证：`wkid=14003212/regionId=140155/showNum=6/mSid=4178` 正是实录被盗分区） |
| `showNum`               | 本服 0~16                                         | **=== `wastelandIndex`**（§2.5）；type5 恒为 0                                                                                              |
| `wastelandType`         | 1:144 / 2:216 / 3:216 / 5:36                      | `CQ26WLLandType`；一个 region 一种玩法                                                                                                      |
| `status`                | 0:36 1:16 2:273 4:135 5:128 6:24                  | `CQ26WLLandStatus`；**type5 恒为 0**（它不用分区状态机）；type3 只出现 1/2/4/5                                                              |
| `areaType`              | 1(1x1 房) / 2(2x2 相关)                           | type5 恒为 2                                                                                                                                |
| `specId`                | 本批全为 0                                        | 语义未知，不消费                                                                                                                            |
| `surfaceType`（房间层） | 2/3（`WASTELAND_1x1_1/_2`）、4（`WASTELAND_2x2`） | 枚举值来自 `CQ26MapCommon`；type5 恒为 4，`pos ∈ {0,0},{2,0},{0,2},{2,2}` 四象限，**一个 2x2 房间的 4 个 region 分属 4 个不同 `mSid`**      |

**`beastStatus`（用户问题③的答复）**：

- **源码零消费**：游戏反编译源码全库检索 `beastStatus` 0 命中（形近的 `PBEnumBattleEnigmaBeastStatus` 属异能战斗，无关）；`CQ26MapData.applyWastelandRegions` 只读 `showNum/pos/id/mSid`，根本不看它 ⇒ 客户端渲染层不使用，只能从报文推语义。
- **只在 2201 的 type5 region 上出现**：跨 5 个会话文件 / 12 份 2201 快照统计（`.reviewtmp/beast-xfile.mjs`、`beast-mSid.mjs`），`beastStatus` 从不伴随其他 type；取值 `0×12 / 1×288 / 2×132`（每快照 36 个 type5 region）。
- **完全相关**：`beastStatus===0 ⟺ mSid===0`（无归属空槽，12/12 份快照恰各 1 个）；1/2 均带归属服；从没有出现 3。
- **候选枚举**（值域吻合，但**未被证实是哪个**）：`PBEnumSeriesFrostWarzoneIceBeastState{NONE=0, IDLE=1, SUMMONING=2, SUMMONED=3}` ⇒ 暂定语义为「冰原巨兽援助地块（HELP_BOSS）上巨兽的召唤状态」。
- **实现口径**：本 feat 族不消费（type5 不在三腿范围内）；ACL 不投影它；一旦未来要接巨兽援助线，按「未知枚举首遇记 warn」纪律处理越界值，不得猜测。

---

## 5. ACL 契约（拟新增，签名即承诺）

```js
// ── CQ26 印石·荒芜冰原（NWL）─────────────────────────────
// 探针实证访问链：CQ26Controller.getInstance() → ctrl; ctrl.wasteLandData → wld
// 全部只读投影：wlInfo / wlListMap / _WlBossRwardPBDataPos / _openedChestMap 都是游戏自己维护的推送快照，
//   本区不主动发包（零拉取口径），读不到就回 null 让调用方降级。

/** @returns {object|null} {ctrl, wld}；子包未加载/符号漂移回 null。**只缓存类、每次现取单例**（purge 僵尸对象教训同 _cq26Neutral） */
_cq26WasteLand() {}

/** @returns {{todayCanGatherTime:number, remainStealNum:number, remainHelpNum:number, remainChestNum:number,
              chestDailyLimit:number, isGathering:boolean, curStage:number|null,
              curStageEndTime:number|null, elecPower:number}|null}
    额度类键缺失按 0（同游戏 getter 的 `||0`）；唯独 `curStage`/`curStageEndTime` 缺键回 **null**（枚举无 0，折成 0 会被读成「已结束」而全停）*/
cq26WlInfo() {}

/** @returns {Array<{index:number, status:number, type:number, condition:number, endTime:number}>|null} 16 分区全量 */
cq26WlLands() {}

/** @returns {{index:number, status:number, type:number, opening:boolean}|null} 单分区快取（feat 决策主入口，内部走 wlListMap） */
cq26WlLand(index) {}

/** @returns {Array<{x:number, y:number, k:number}>|null} 22077 宝箱点位（未开箱全量快照，开过的自然消失）；**三态**：`null`=快照未达（≠ 无箱） */
cq26WlChestPos() {}

/** @returns {boolean|null} 该点是否已开过；**快照未 loaded 时回 null（= 未知），不得当 false 直接发 2118** */
cq26WlChestOpened(index, x, y) {}

/** @returns {number} 分区开闸电力花费（表 series_frost_small_wasteland.price） */
cq26WlOpenCost(index) {}
/** @returns {number} 分区巨兽抗性门槛（表 resitance_demand，拼写照抄游戏侧） */
cq26WlResistanceDemand(index) {}
/** @returns {number|null} 配置值（52000363/364/367/372/426 之类），不可用回 null */
cq26WlConf(id) {}
/** @returns {{itemId:number, resId:number, level:number, gatherSpeed:number, resourceType:number}|null} 采集点资源投影（RESOURCE 表） */
cq26WlResource(itemId) {}

// ── 星路大地图「身份三元组」（§2.5：2201 请求参数与本服/外服判据的真相源）──
/** @returns {{group:number, resistanceLevel:number}|null} 读 ctrl.selfInfo（源自 push 22001）；**每拍现读不缓存**（isRegroupRound 会重排分组） */
cq26StarLandSelf() {}
/** @returns {{cid:number, round:number, status:number, beginTime:number, endTime:number, stealBeginTime:number, stealEndTime:number}|null} 读 ctrl.status */
cq26StarLandStatus() {}
/** @returns {number|null} **老家服号** `UserData.OriginServerId`；与 901 `m.initSid`/2201 `mSid` 比较的唯一基准。
 *   与已有的 `acl/world.js` `selfServerId()` **不是同一个东西**：后者是「本图所在服」（登录回包 currk），
 *   跨服进冰原房间时两者不等，而 canSteal/canHelp 用的是 OriginServerId —— 拿错则三腿谓词全错 */
cq26OriginServerId() {}
```

**四条签名级决策**：

1. `cq26WlChestOpened` 的三态（`true/false/null`）是硬要求。游戏自己写的是 `getOpenedChestSta()`：**未 loaded 时返回 `true`（当作已开、顺手补发 2119）** —— 那是 UI 的保守策略，自动化照抄会永久漏开第一个宝箱。ACL 把它拆成"未知"和"已开"两态，`null` 由 feat 决定是"发 2119 冷启动查询一次"还是"本拍跳过"。**2119 是唯一允许的主动拉，且每分区一次**（`_openedChestLoadedMap` 已loaded 就不再发，游戏自己就是这个语义）。
2. **投影优先、push 缓存回落**（excav 同款）：`_WlBossRwardPBDataPos` 是游戏内存里的 22077 快照，正常情况下读它零成本；符号漂移时降级为 feat 自己订阅 22077 存的标量副本。两条通道都空 ⇒ 本拍不动作并 `debug('no chest source yet.')`，**不**发 2120/2111 补拉。（注：wl-chest 落地后允许的唯一拉是**定向 901 单窗**，它补的是「这一颗箱的 `specIndex`」而不是快照本身，与本轮口径不冲突 —— 见 §6 该行与坑 14。）
3. 表/配置读取不返回行对象，只返回投影里用到的字段 —— 与 `cq26ShopRows`「刻意返回新造对象」同口径，防止表缓存跨帧引用外泄。

**第四条（本轮新增）：身份三元组只收符号、不收数据**。`2201` 的**应答载荷**（`grid/wastelandInfo/regions`）全是协议字段，feat 直接解析即可，ACL **不**提供“全图 region 列表”这种聚合投影（否则把“该发几次 901”这类成本决策抬进 ACL）；ACL 只负责三样东西——`group`/`cid`（请求参数，游戏符号）、`OriginServerId`（判据基准；本人 StrUid 直接用已有的 `gameData.strUid()`，不新增）、`52000xxx` 配置值。另：三个 getter 均为**只读**，绝不得调 `CQ26MapData.requestData`（那是发包，且会写坏游戏自己的 `mapData.group`）。

**落地进度（20261108）**：

- **身份三元组**：三个 getter 已在 `core/acl/game-data.js` 的 `── CQ26 印石·荒芜冰原「星路大地图身份三元组」 ──` 区段实现（复用已有 `_cq26()` 拿 `ctrl`；`selfInfo`/`status` 每拍现读、返回新建标量对象）。`cq26StarLandStatus()` 额外把 `cid<=0`（构造默认哨兵 = 状态推送尚未达）也归入 `null`，让 feat 闸 2「任一 null → 停整腿」对 cid 同样生效。
- **wl-chest 宝箱子集**（随 `feats/cq26/wl-chest/index.js` 落地）：`_cq26WasteLand()`（探针 `CQ26Controller.getInstance() → ctrl.wasteLandData`，**只缓存类、单例每次现取**，僵尸对象教训同 `_cq26Neutral`）、`cq26WlInfo()`、`cq26WlLands()`/`cq26WlLand(index)`、`cq26WlChestPos()`、`cq26WlConf(id)`、`cq26OriginServerId()`。两个实现细节：
  1. `cq26WlChestPos()` 直读私有字段 `_WlBossRwardPBDataPos` 以保三态（`null`=未达 / `[]`=已开完），只在字段名漂移时回落 `getWlBossRewardPos()` 并将 `[]` 归 `null`；
  2. 能力键 `cq26WasteLand` 已登记进 `core/acl-engine.js` 的 `CAPS` + `setSharedCapsProbe`，feat 侧 descriptor 写 `symbols: ['dataCenter', 'cq26WasteLand?']`（软依赖：拿不到只降级为自订 push 的副本，不阻断）。
- **仍待实现**：`cq26WlChestOpened/cq26WlOpenCost/cq26WlResistanceDemand/cq26WlResource`。其中 `cq26WlChestOpened` 本 feat **未用**（§6 该行：22077 天然排除已开点，乐观集盖住「已发成功、快照未回」那一窗，所以下面的签名级决策 1 对 wl-chest 暂不生效，待需要时再接）。

---

## 6. 三个 feat 的接线草案（本节到"立项"为止，不含面板字段）

| feat                                                                                                 | 唯一写动作                                                                                                                                  | kick                                                                                       | 决策链（全部标量）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wl-chest` 遗失之箱（**已落地** `feats/cq26/wl-chest/index.js`）                                     | `2118 {wastelandIndex,x,y}`                                                                                                                 | push `22077`（快照）/ `22072`（额度）/ `22071`（分区），+ `10018` / resp `901`（地块真相） | 活动闸 → 本服图闸 `OriginServerId===ServerId`（icon 判据第二项，取不到则降级放行）→ `cq26WlInfo().remainChestNum > 0`（`null`=本拍不动作，`0`=睡到日界线）→ 数据源 `cq26WlChestPos()` ∪ 22077 副本 → **逐点定号：只认 315 地块 `m.specIndex`**（被动嗅探 901/10018 缓存；队头定不出号时以该箱坐标为窗心发**一发定向 901**，18×30 / viewLevel 0，与游戏跳图后那一发同形）→ 发 2118 → 乐观记 `opened`、等下一份 22077 覆盖。**不动镜头、不派兵、不发 2120/2111/2119/2104**（旧口径「经 2120 反查分区号 / 零拉取」已被坑 14 的三条实证修订）                                            |
| `wl-beast` 冰原巨兽                                                                                  | `2125 {wastelandIndex, troop}`                                                                                                              | 自身 cycle + `52000372` 时刻表                                                             | 活动闸 → 只挑 `type===1 && opening` → `2124` 读 `{fightValue, selfFightValue, timeIndex}` → 抗性 `<` `cq26WlResistanceDemand(idx)` 时按文案降级（打不动就别烧体力）→ `troop` 由 `core/battle.js` 构造 → 发 2125 → 成功后重查 2124 再决定下一轮                                                                                                                                                                                                                                                                                                                                       |
| `wl-gather` 矿山/雷神矿脉（**一个 feat 三腿**，详见 [`feat-荒芜冰原采集.md`](feat-荒芜冰原采集.md)） | 采集 `2114 {wastelandIndex,x,y}`（+ `2121 {marchId}` 召回 / `2123 {marchId,itemId}` 加速）/ 协助 `2116 {wkid,x,y}` / 盗采 `2115 {wkid,x,y}` | `CQ26_WL_LIST_INFO_CHANGE` + 行军态 + 自 cycle                                             | 共同前置：活动闸 → `cq26StarLandSelf/Status` 可用（否则 2201 发不出去）→ `type===3` 分区粗筛 → `checkWlOpening` 同序的 `status===4` → 按候选平铺 `2120{showNum,mSid}` + `901` 精筛。**三腿谓词逐字照 §4.4**：采集腿 = `initSid===OriginServerId && ownerId 为空` + `todayCanGatherTime>0` + 无 315 行军占用；协助腿 = `initSid===OriginServerId && ownerId 为他人` + 不在 `protectUidList` + `remainHelpNum>0`；盗采腿 = `initSid!==OriginServerId` + 不在 `stealUidList` + `remainStealNum>0` + `gatherStartTime>0` 且已成熟，**跨池按 `oNum` 择优**（每日仅 3 次 ≪ 33 个外服候选） |

`wl-chest`（2118）与 `wl-gather` 的**协助腿/盗采腿（2116/2115）都是即时结算、不派兵不占行军名额**（2118 实测 `resp.resource` 全 0、奖励在 `items`；2115/2116 实测 `rewardResult.resource` 直接进 10001）；**只有采集腿 2114 派兵**，占 `MarchType.CQ26_WASTELAND_GATHER = 315` 名额并持续消耗 `todayCanGatherTime`。

### 坑与边界（务必带进实现）

1. **两套同名"矿山/矿脉"**：日常采集点走 `2114/2115/2116`（NWL），冰原会战建筑 `CQ26_WLB_MINE(314)/ORE(308)` 走 `2131~2139`（WLB，`2133` 应答里是 `dLandInfoList[].mineInfoList[{specId:1001~1004, serverId, behemothLevel}]`）。判据不同源、面板 key 不同（`series_frost_energybattle_*`），feat 里靠实体 id 分流，绝不可合并处理。
2. **2125 不是行军**：`ChallengeBossPop` 里有一段 `MarchType.CQ26_WASTELAND_ATTACK_MONSTER(327)` 的派兵分支，但真人录制实证面板出手走 **2125 带 `troop` 即时结算** —— `2125` 后同一秒 `fightValue` 跳变（`14.046e15 → 17.3e15`）并到账 100T 阈值邮件（45060）。照抄派兵分支会双花兵力。
3. **额度以 `22072` 为唯一权威，无需本地记账**（早期“`remainGuardNum` 不在任何查询里、得本地递减校准”的说法已被 20261108 实录推翻）：每个写动作（2115/2116）的**同秒**都伴随一份 `22072`，带完整额度块 —— 实录时间线：`2949.3 REQ 2116` → `2949.4 22072 help=1` 且 `2116 resp remainGuardNum=1`；`5529.1 REQ 2115` → `5529.1 22072 steal=2`。⇒ `2116` 应答里的 `remainGuardNum` 与 `2115` 应答里的 `remainStealNum` 只是**回执倒影**（两个名字、同一额度），feat 可以拿它做即时一致性校验，但**不得**当独立额度源；游戏侧 `getRemainStealNum/getRemainHelpNum` 也是直读 `wlInfo`（= 22072 快照）。三态纪律不变：`wlInfo==null` 时回 `null`，不得把「无快照」读成 `0`（那会永久静默）。
4. **`todayCanGatherTime`（剩余）vs `todayCollectDuration`（已用）** 方向相反，见 §4.3。
5. **`challengeTime`/`timeIndex` 是数组下标**，不是秒；越界游戏侧直接归 0（`n<0||n>=o.length → n=0`），投影时保持原值 + 不做钳制，把钳制留给消费方，避免掩盖符号漂移。
6. **`isGathering` 是"我有一支采集行军在场"的总闸**，不等于"这个点是我的"；同点判定必须回落到行军列表的 `MarchType` + 坐标。
7. **22077 是全量快照不是增量**：实录连续两份里前一份刚开过的点会从后一份消失（350_216 在第一份有、第二份无 ⇒ 中间发过 2118），不能按"新增点"理解，也不能靠计数推断剩余额度。
8. **零拒绝样本**：本批 176 个文件里这些协议应答 `header.s` 全部为 0，没有任何业务拒绝码可参考。⇒ 退避策略现在只能按"哨兵码+`rejectText`+统一退避"写（既有纪律），**不得**声称已实证；上线后首批 `info` 级拒绝码要回灌本台账。
9. **Int64 载荷**：`2121/2123` 的 `marchId`、`2129` 的 `id` 在报文里是 `{_low,_high}` 形态，取值走 `bits`/`int64Num`，`marchId` 字符串形态必须从 `raw.d` 取（19 位整数在 `data` 里已丢精度）。
10. **粗筛不能代替精筛**：2201 的 `status` 是**分区级**，本场 34 个 type3+status4 候选里真正有可盗成熟点的只有 1 个房间 ⇒ 想跳过 901 精筛直接发 2115 就是“拿错点发写请求”，而首批零拒绝样本下我们并不知道服务器会不会只按“不在同一房间”静默拒绝。
11. **两个“本服号”不得混用**：`UserData.OriginServerId`（老家服，canSteal/canHelp 用的就是它）vs `NWorldMapData.instance.serverData.selfServerId`（本图所在服，跨服房间不等）；已有 ACL 只有后者，新增的 `cq26OriginServerId()` 必须用前者（§5）。
12. **`group` 是变量不是常量**：push 22001 可改它、`isRegroupRound` 会重排 ⇒ 不得缓存 group/cid，也不得把本场实证的 `group:14`、`cid:2` 写进代码常量（§2.5）。
13. **绝不写游戏侧地图对象**：`CQ26MapData.group` 是游戏自己维护的粘滞字段（`this.group = e.group || this.group`），我们只发 2201 读应答，**不得**调 `requestData`/改 `mapData`（只读+发包红线）。
14. **宝箱的分区号不得由 `k` 反查**（对 §6 旧草案「逐分区 2120 建 `k→idx` 映射表」与「零拉取」两个口径的实证修订，脚本 `.reviewtmp/chest-kmap-session.mjs` 可复跑）：`22077` 行只有 `{x,y,k}`，而 `k`（房间号）→ `wastelandIndex` 是 **1:N**：
    - ① 印石日常主跑趟实录：`2120{wastelandIndex:9}` 的应答锚点 `k=14002112`，而**同一房间**里 315 地块 `m.specIndex=11`（真人点图标走进那格时，游戏发的是 `2118{11,…}`）；同场 `14012612` 一个房间对应到 8 与 15 两个分区号；
    - ② 连开箱趟实录：宝箱地块 `specIndex=5` 所属分区 `wastelandType=2`（不是采集线的 3）⇒ 拿 `type===3` 粗筛会整片漏箱（与 §2.2「一个分区只一种玩法」不矛盾，但宝箱不限于 type3）；
    - ③ 同一场本服只有一个 status=4 的分区，22077 却覆盖 `14001012`/`14002212` 两个房间 ⇒「房间唯一 ⇒ 分区唯一」不成立。
      ⇒ `wastelandIndex` 的唯一真相源是 **315 地块 `m.specIndex`**（源码逐字：`CQ26WLWorldRewardBoxPop.onClickGetReward` 取 `extData.specIndex`）；按映射表反查会拿错号出网，被拒还会把有效目标误计进拉黑（与 §2.5 采集腿的 `showNum===wastelandIndex` 实证**不互推**：那条说的是 region 主键，不是宝箱房间）。
15. **开箱时 `22072` 抢在 `2118` 应答之前到货**（真人连开箱实录，四颗箱的报文序完全一致：`req 2118 → push 22072(remain−1) → push 22077 → resp 2118 code=0`，单颗往返 45–59ms）：坑 3 说「额度唯一权威是 22072」是对的，但**不能因此把乐观扣减写成「应答里 +1、推送到货清零」**——推送先到、记账后到，那个 `+1` 就是把服务器已经扣掉的那格再扣一遍 ⇒ 乐观值常挂 1。后果不是多发包而是**少发包**：额度 5 只开得出 4，第 5 颗卡在「等下一条 22072」，而 22072 只在额度真变化时才推 ⇒ 该等待永无下文，饿到日界（表观：游戏面板「今日剩余 1/5」而引擎「可开 0/5」）。纪律：① 结算时先比快照（`snapNow < snapAtSend` ⇒ 服务器已反映本笔，不再记乐观账）；② 推送侧按**额度增量**回抵（`prevRemain − curRemain`），额度持平的推送（同包 `elecPower`/采集态变了）**不得**清账；③ 乐观账必须有寿命（本 feat 取 10s），推送丢失时宁可多撞一次被拒也不饿死一整天。单测 `tests/feats/cq26-wl-chest.test.js` 的 `runQuotaLedger` 三种报文序对拍（含旧写法反证）。

16. **赛季阶段与分区状态是两层，feat 只认后者会空跑**（190 场普查脚本 `.reviewtmp/stage-census.mjs` / `stage-sessions.mjs` / `stage-point-shape.mjs` 可复跑）：`curStage`（赛季级 `CQ26WLStatus`）与 `status`（分区级 `CQ26WLLandStatus`）互不蕴含。实证对照 —— `curStage=1`（78 场）：采集额度有消耗、分区含 `OPENING(4)`、316 点有主数可达 91、人的写动作 `2114/2115/2116/2121` 齐全；`curStage=2`（18 场）：**额度恒满 57600、盗采/协助恒 3/3、无一个 `OPENING(4)` 分区、9380 个 316 点全部无主、人的写动作全 0**。⇒ 阶段 2 里没有任何可挖/可盗/可助对象，而只按分区 `status` 判据跑的采集腿仍会每拍发 2201 空刷棋盘、盗采/协助腿仍会对组内的 `status=5` 外服区逐区精扫（1×2120 + 2×901）后空手而归。纪律（已落 `feats/cq26/wl-mine`，见 feat §4.5）：三腿各加 `stageGate`，**只有 `curStage===1` 出新网**；`curStage` 未知（快照缺键 → ACL 回 `null`）时**不挡**，退回既有分区 `status` 判据；阶段闸必须排在 `marchBusy()` 与 `isGathering` 认领之后，否则阶段跳变时还在外面采的那一趟没人收。

---

## 7. 数据流与降级

```
登录握手 ──► 22071(16分区全量) + 22072(标量额度) + 22077(宝箱点位) ──► 游戏写进 wasteLandData
                                                                          │
feat（createCycle 电平调和）─► ACL 投影 ── 读不到（符号漂移/子包未载）──► feat 自己订 push 存的标量副本
                     │                                                    │
                     └─ ctx.on.event(CQ26_WL_*) kick（打破静默期） ◄───────┘

wl-gather 三腿专用通道（§2.5）：
  ACL cq26StarLandSelf/Status ──► 2201 {cid, group} ──► 612 region 粗筛 (type3 && status4)
                                                              │
                                       2120 {showNum, mSid} ──► {x,y,k}（房间中心）
                                                              │
                                       901 窗扫 pointType=316 ──► §4.4 三腿谓词精筛
                                                              │
                          2114（采集，派兵）/ 2116（协助）/ 2115（盗采）
                                                              │
                              同秒 22072（额度）+ 10018（新 m）+ 10001（入账）→ 下一拍自然收敛
```

唯一写动作：`2118` / `2125` / `2114`(+`2121`/`2123`) / `2116` / `2115`。唯一允许的拉：`2119`（每分区一次，wl-chest 当前**未接**）、`2124`（打之前查一次）、`2201`+`2120`+`901`（wl-gather 的结构性扫描成本，口径见 §2.5）、`901` 定向单窗（wl-chest 定号专用：仅当队头箱在地块缓存里定不出 `specIndex` 时发，以该箱坐标为窗心，均摊 ≤1 发/颗、同窗可顺带解多颗，镜头不动）。

| 档     | 条件                                   | 行为                                                                                                                                                                                    |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常   | 投影可用                               | 纯读，零发包                                                                                                                                                                            |
| 降级   | 投影 null                              | 用 push 缓存；`wl-chest` 无法判本服归属，`debug` 记一次、`warn` 去重                                                                                                                    |
| 冷启动 | `_openedChestLoadedMap[idx]` 未 loaded | 发一次 `2119 {wastelandIndex:idx}`，`loaded` 前该分区**跳过**（不是"当作已开"）。**注：wl-chest 未走该档** —— 它靠 22077 全量快照天然排除已开点 + 乐观 `opened` 集盖住在途窗，不订 2119 |
| 停摆   | 活动闸不过 / 全部分区非 OPENING        | `cycle` 静默，`debug` 带 `reason`（静默期定位纪律）                                                                                                                                     |

---

## 8. 证据索引

- 源码：`CQ26WasteLandData`（三个 push handler / `checkWlOpening` / `getOpenedChestSta` / `meltIce` / `sendChallengeWlBoss` / 四个额度 getter）、`CQ26WLOpen{Base,Gather,Boss,Ice}Component`、`CQ26WLWorldGatherPop`、`CQ26WLWorldRewardBoxPop`、`CQ26WLWorldResourceBubble`（`onClickSteal/onClickHelp` 取 `entity.serverId` 当 `wkid`）、`NWICQ26WLResource`（**`canSteal`/`canHelp`/`hasGatherOwner`/`isGatheringResource`/`needShowResourceBubble` 全文，§4.4 的逐字依据**）、`CQ26MapData`（`requestData`/`updateData`/`applyWastelandRegions`/`fillRenderRect`）、`CQ26MapDataMgr`、`CQ26MapUI`、`RealCQ26Controller`（`updateSelfInfo`/`updateStatusData`/`onRoundChange`）、`CQ26Response`（22001 Handler）、`CQ26Common`（枚举）、`CQ26MapCommon`（`WASTELAND_1x1_1=2/_1x1_2=3/_2x2=4`、`CQ26_MAP_FACTOR=4`）、`PBMsgClient`（`PBEnumSeriesFrost*Beast*State` 三套枚举）、`N{Request,Response}IdV2`
- 报文：印石战区真人录制会话（连开箱场、小游戏/最近冰点场、发掘场、2124/2125 同秒伤害跳变场、2116 守护 + 2117 融冰场、**印石日常主跑趟三腿与 2201 主证据**）
- 脚本（本文可复跑）：`.reviewtmp/cq26wl-fielddict.mjs`（字段形态普查）、`.reviewtmp/cq26wl-probe.mjs`（逐协议样本）、`.reviewtmp/cq26wl-codes.mjs`（应答码分布）、`.reviewtmp/send-probe.mjs`（源码调用点）、`.reviewtmp/sf-map.mjs`（符号→号对照）；本轮新增：`.reviewtmp/star-land-2201.mjs`（2201 解剖）、`star-land-region-stat.mjs`（612 region 统计）、`star-land-crosstab.mjs`（type×status×归属服交叉）、`shownum-is-index.mjs`（`showNum===wastelandIndex` 终判据）、`beast-status-scan.mjs`/`beast-xfile.mjs`/`beast-mSid.mjs`（beastStatus 全库普查）、`nwl-writes-census.mjs`（写动作形状）、`pointtype-census.mjs`（901 点型与 `m` 键集）、`steal-verify.mjs`/`steal-tile-track.mjs`/`guard-vs-steal-deduct.mjs`（扣减铁证）、`help-quota.mjs`（22072 与写动作同秒时间线）、`march-src-probe.mjs`（2121 前后行军上下文）
- wl-chest 专用（本文可复跑）：`.reviewtmp/chest-kmap-session.mjs`（坑 14 三条反证的取证：`2120` 应答 `k` vs 同房间 315 地块 `specIndex`、宝箱分区 `wastelandType`、单 status4 分区覆两房间）、`.reviewtmp/chest-replay-check.mjs`（离线回放对拍：真人 5 发 2118 的 `wastelandIndex` 与我方地块推导逐键一致 5/5、“下一份 22077 快照已消失”命中 5/5）；单测 `tests/feats/cq26-wl-chest.test.js`。报文会话为印石日常趟实录（坑 15 的报文序铁证：四发 `2118` 均为 `req → 22072(remain−1) → 22077 → resp`，额度 5→4→3→2→1，单颗往返 45–59ms）。
- 竞品B：其快照内**无任何 CQ26 NWL 实现**（`SERIES_FROST_*` 符号、2114/2118/2456 等号段、中文关键词三层扫描均 0 命中），只有 CQ25/CQ24 世代 `CQ25Gather`/`conquerorGather` 的"赛季矿山"状态机形状可参考 —— 本设计**不抄**它。
