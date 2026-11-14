# feat · CQ26 战区宝藏（`cq26Excav`）

> 代码：`extension/src/feats/cq26/excav/index.js` · ACL：`core/acl/game-data.js`（`_cq26Neutral` / `cq26ExcavSites` / `cq26ExcavIconOn`）
> 面板：CQ26 印石 → 基础设置 → 战区宝藏 · 形态：`createCycle` 电平调和 + 推送 kick，**零扫描、零主动拉取**

只做一件事：世界地图那个宝藏 icon 亮着的时候，替玩家点一下「开采」。
全 feat 只有一条出网动作 `2491 {siteId}`，不派兵、不占行军名额、不发任何查询请求。

报文实证：印石日常真人实录（两次开启 + 两次发掘 + 两次 22062），
另取刷新页面后的冷启动场实录（含 S3281 点的发掘）。

---

## 1. 协议清单

| cmd   | 名称                       | 方向 | 载荷 / 应答（实测）                                                                                             | 本 feat                            |
| ----- | -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 2491  | `SERIES_FROST_EXCAV_CLAIM` | req  | `{siteId:"140138_1794053696"}`（**只有这一个键**）                                                              | **唯一写动作**                     |
| 2491  |                            | resp | `{reward:{items:[{itemId:1700404,itemCount:1}],…},marchEndTime}`；`marchEndTime - header.ts = 10`（= 52000418） | 成功结算                           |
| 22062 | `…_EXCAV_OPEN_LIST`        | push | `{list:[{siteId,cityId,cityConfigId,ownerSid,endTime,pos:{x,y,k}}]}`，**全量快照、不按已采过滤**                | 候选数据源                         |
| 22063 | `…_EXCAV_SELF`             | push | `{claimedSiteIds:[…]}`，服务端持久（20:35 那次仍含 20:02 采的点）                                               | 已采权威                           |
| 22061 | `…_EXCAV_OWNED`            | push | `{list:[…带 totalRemainCount]}`                                                                                 | **登记不接线**（全部录制零出现）   |
| 2490  | `…_EXCAV_OPEN`             | req  | —                                                                                                               | **登记不接线**（客户端零调用点）   |
| 2492  | `…_EXCAV_RECORD_LIST`      | req  | —                                                                                                               | **登记不接线**（挖掘记录面板专用） |

实录片段（逐字）：

```
20:01:55 push 22062 {header:{ts:1794052915},data:{list:[{cityId:140064,cityConfigId:1015,ownerSid:3765,
              endTime:1794060115,siteId:"140064_1794052915",pos:{x:393,y:481,k:3765}}]}}
20:02:10 req  2491 {siteId:"140064_1794052915"}
20:02:10 resp 2491 {header:{ts:1794052930,s:0},data:{reward:{…items:[{itemId:820015,itemCount:2}]},…}}
20:02:10 push 22063 {claimedSiteIds:["140064_1794052915"]}
20:14:56 push 22062 {header:{ts:1794053696},data:{list:[{140138…ownerSid:3281,endTime:1794060896,pos:{395,483,k:3281}},
                                                         {140064…已采那条仍在}]}}
—— 刷新页面后 ——
20:35:44 req  2491 {siteId:"140138_1794053696"} → resp header.ts=1794054944, items:[{1700404,1}], marchEndTime=1794054954
20:35:44 push 22063 {claimedSiteIds:["140138_1794053696","140064_1794052915"]}
```

字段口径三条硬事实：

1. `siteId = "{cityId}_{开启秒}"`，`endTime - 开启秒 = 7200`（= 52000417 `series_frost_excav_duration_sec`）；两次推送时刻 `header.ts` **精确等于**各自 openTs ⇒ 服务端在开启瞬间广播，不存在轮询窗口。
2. 22062 是**全量**列表：20:14:56 那条把 15 分钟前已采的 140064 也带着 ⇒ 候选集必须自己减 `claimedSiteIds`。
3. 行里叫 `cityConfigId`，地图 901 地块的 `m` 里叫 `cityCfgId`（同一个值 1018）——两处名字不通用，ACL 投影做了双向回落。

---

## 2. 发现通道选型（本篇的核心取舍）

玩家侧的真相只有一个：世界地图左下角那一列活动按钮里的宝藏 icon。它的显隐判据（`subpack2/NWorldUIActBtnSetting`）是

```js
checkCQ26NeutralExcavShow = () =>
  null != CQ26NeutralController.getInstance().getFirstOpenEnableSite();
```

**纯客户端推导、零报文**。所以 feat 的候选源与它同源即可，不需要任何额外的服务器查询。三条通道的取舍：

| 通道                                        | 结论          | 理由（实证）                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.on.push(22062/22063)`                  | ✅ 主通道     | 载荷自带全量列表；实时性与时序无坑：`core/net.js` 先 `recvOrig.apply()` 跑完游戏 handler 再 `dispatch()` 给我们，读到的一定是落地后的态                                                                                                                                   |
| 每拍读一次 ACL 内存投影                     | ✅ 冷启动自愈 | 实录实证 net-collect 的 hook **晚于**游戏登录握手（两场冷启动首包都是 `7428/7415/825/9706/1645/1583/5684/4169/1517` 一串登录后初始化报文）。冷启动那场**全程无 22062**，但面板照开、点照采 ⇒ 握手期那次全量快照必然送达、只是录不到。漏收时下一拍读内存即补回，无需发请求 |
| 嗅探 901/10018 里的 `pointType:311`         | ❌ 否决       | ① 要拉全图/切图报文，对服务器打扰大；② 视野依赖，本场 10 次 901 里只有 2 次含 311、单次最多 1 个（且 `k` 是归属服号 3281，得把视野挪过去）；③ 不及时——icon 早在 22062 那一刻就亮了                                                                                        |
| `ctx.on.event('CQ26_NEUTRAL_EXCAV_UPDATE')` | ❌ 不用       | `postExcavUpdateEvent()` 被 22061/22062/22063 三个 `update*` 全部调用，覆盖面**不比 push 多**，却不带载荷；且依赖 `eventApi.install()`，装不上是静默空订阅（feat 侧 `ctx.on.event` 现仅剩 `SERVER_VIEW_CHANGE`，属既有收敛方向）                                          |
| 主动发 2490 拉列表                          | ❌ 否决       | 2490 在 `NRequestIdV2` 有号但**客户端零调用点**，游戏自己都不拉；凭空加一条请求频次                                                                                                                                                                                       |

⇒ 分工：**push 管实时，一次性读内存管冷启动补漏，event 不要，扫图禁止。**

---

## 3. 候选序与闸门

### 3.1 与 `getFirstOpenEnableSite` 逐行对齐

```js
// 游戏原式（extracted/Script/CQ26NeutralController）
for (n of _excavOpenSiteList) {
  if (checkExcavSiteClaimed(n.siteId)) continue; // _claimedSiteIds.indexOf >= 0
  if (null != o && n.ownerSid == o) {
    a = n;
    break;
  } // o = _selfInfo.mSid —— 命中本服第一个即返回
  (!t || t.endTime > n.endTime) && (t = n); // 否则取 endTime 最小
}
return a || t;
```

feat 侧 `buildQueue()` 把它拆为两个纯函数（`pickOpen` 闸门过滤 + `orderLikeGame` 排序），**本服点按列表原序在前，其余按 `endTime` 升序**，
队列头即游戏 icon 会选中的那一个；`tests/feats/cq26-excav.test.js` 拿游戏原式的参照实现做 200 组随机对拍。
`ownServer` 判定用 `_selfInfo.mSid`（来自 push 22001），只在 ACL 投影里有；降级到 22062 缓存时判不了归属，排序退化为纯 `endTime` 升序并打一条 warn（恢复后复位）。

两条数据源共用 `projectSite()` 归一到同一组标量字段：报文对象是**池化复用**的（`Event.raw` 只读），所以 22062 一到就要同帧拆成副本再存活到下一拍，
否则降级路径读到的是被下一条报文刷过的脏值（与 `train.js` 的 `cloneInt64` / `readSnapshot` 同一口径）。

### 3.2 闸门（按代码实际次序，任一不过即本轮零发包）

| 闸       | 判据                                                           | 不过时                                                                 |
| -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 活动闸   | `gameData.cq26IsOpen()`                                        | debug `CQ26 not open`，按 idle 降频                                    |
| 数据源闸 | ACL 投影非 null，否则 22062 缓存非空                           | debug `no site source yet`（**不当成「没有点」**）                     |
| 时刻闸   | `gameData.serverTime() > 0`                                    | warn（去重一次）+ 本轮零发包：拿不到权威时刻就不做过期判定             |
| 日界滚清 | `todayStr(serverTime)` 与上次不同                              | 清空 `rejectCount`/`coolUntil`（拉黑只属**当日**，跨刷页也成立到日界） |
| 去重闸   | 游戏侧 `claimed` ∪ 本地乐观 `Set`                              | 该点不入队                                                             |
| 过期闸   | `endTime - ServerTime > SAFE_REMAIN_SEC`（30s）                | 该点不入队                                                             |
| 冷却闸   | 单次被拒 → 5min 冷却                                           | 该点不入队                                                             |
| 拉黑闸   | 同一 siteId 连续被拒达 3 次（`MAX_REJECT`）                    | 该点当日不再尝试（防逐拍重发刷屏）                                     |
| 串行闸   | `sendGuarded` 在途闸门（= 游戏侧 `checkRequestIdNoRes(2491)`） | 回落 `CODE_NOT_SENT` → 一条 warn，下拍按 `activeMs`（20s）重试         |

> `CODE_NOT_SENT` 是**三态同码**：在途闸命中、发送抛错、应答超时都回 `-1`（抛错形态在 warn 里附 `(threw: …)` 分叉）。
> 超时且服务端实际已成交时，下一拍会重发一次，靠 22063 与本地 `claimed` 自愈，不会连续撞。
> `30s`（`backoffMs`）只在 `run()` 整拍抛错时由 `createCycle` 兜底使用，不是常规重试间隔。

**一轮采完是默认行为、不再是可勾选项**（`claimAll` 字段已废弃）：采成功后 800ms 续采下一个（串行、每拍一条，`claimed` 逐件增长自然收敛）；
采不到时按上一拍有无候选退到 `activeMs`/`idleMs`。推送在飞期间到达（`cycle.pending`）一律立即补一拍。

### 3.3 面板按钮置灰为什么不需要撞错误码

`CQ26NeutralWorldTreasurePanel.cpnUpdate1000MS` 的置灰是**纯本地**判据：`checkExcavSiteClaimed(siteId)` → 按钮 `interactable=false`、文案切 `series_frost_cnccity_text_035`（已发掘）。
真实拒绝码（`header.s ≠ 0`）在录制里拿不到，本 feat 因此不依赖错误码语义，只做兜底：`!ret.ok` 一律 info 记 code/reason + 冷却，不升 warn、不猜含义。

面板「可采 N」与引擎**同一判据**（走 `currentSites()` + `buildQueue()`，含过期/冷却/拉黑闸）：
若只减 `claimed`，会出现「面板写可采 1、引擎每拍零发包」——即本 feat 要消灭的「icon 亮而引擎不动」在面板侧的翻版。

### 3.4 投影取器两条纪律（`gameData._cq26Neutral`）

这两条都是实测/源码级踩坑，改 ACL 时勿回退：

1. **只缓存类，单例每次现取**。`probe` 命中即永久返回缓存值，而 `ResetGame.purgeData()` 会执行
   `He.default.getInstance().purge()`（实证 `extracted/Script/ResetGame`，`He` = CQ26NeutralController；`purge` 内 `t.instance = null`）。
   缓存实例 ⇒ 跨服/重置流程后投影永远读僵尸对象，且返回的是**非 null 陈旧数组**，
   于是「投影优先」分支永占上风、22062 回落通道被结构性屏蔽（只能刷页自愈）。回归用例见「purge 重建单例后投影必须跟上新实例」。
   对照：`CQ26Controller` **无** `prototype.purge`，故 `_cq26()` 缓存实例无此风险（别照抄本节的顾虑过去）。
2. **不得双解包**。本模块是 **default 导出**（`a.default=E`，无 `a.CQ26NeutralController=`），而 `CQ26Controller` 是**命名导出**。
   `ns(m)` 已把 default 解包成类，再写 `ns(m).CQ26NeutralController || ns(m).default` 会得到 `undefined`
   ⇒ 投影恒返 null ⇒ 静默退化成「只信 22062」（本域冷启动补漏整条通道失效，且只有首遇一条 warn）。
   正确式：先查**裸模块**命名导出，再取 `ns(m)`。

---

## 4. 配置与奖励档位（字典实证，`warroom/data/dicts` 1.5.12855 / locale 1.6.4668）

| data_config | name                         | value                                                     |
| ----------- | ---------------------------- | --------------------------------------------------------- |
| 52000416    | `series_frost_excav_reward`  | `69459\|2, 801040\|1, 820016\|1, 62910\|10, 23044402\|10` |
| 52000417    | `…_duration_sec`             | 7200                                                      |
| 52000418    | `…_march_max_sec`            | 10                                                        |
| 52000419    | `…_door_range`               | `2\|10`（语义不可证，客户端零引用）                       |
| 52000420    | `…_site_range`               | `3\|10`（同上）                                           |
| 52000421    | `…_troops_max_num`           | 100（同上）                                               |
| 52000422    | `…_max_claim_num`            | 200（同上）                                               |
| 52000423    | `series_frost_excav_reward2` | `69459\|1, 1700404\|1, 820015\|2, 62908\|5, 23044402\|5`  |

- 面板两列奖励写死 `i = [52000416, 52000423]`，字典列名 `series_frost_cnccity_text_102 = 开启战区` / `text_100 = 其他战区` ⇒ **A = 开启战区档，B = 其他战区参与档**。
- 两池交集为 `69459`（高级重装芯片宝箱，A 给 2 / B 给 1）与 `23044402`（军阵补给箱（新），10 / 5）；**独占条目**：A 独有 `801040` 装备改造图纸、`820016` 高级催化剂、`62910` 泰坦装备材料自选箱；B 独有 `1700404` 紫色材料随机箱、`820015` 中级催化剂、`62908` 泰坦装备材料随机箱。
- 实测两次发掘（ownerSid 3765、3281，本服 3828 两者皆外服）分别拿到 `820015×2` 与 `1700404×1`，**2/2 命中 B 池独占条目** ⇒ 与「非开启战区走 reward2」一致。
  反过来，A 档是否真有额外优待，只有等本服开点才能证，见 §7。
- 点位所属中立城：`series_frost_cnc_city` `1015`（level 3 / faction 2 / show_id 3003）、`1018`（level 3 / faction 1 / show_id 3006），都是 3 级中立城，`group=4`。
- 文案：`text_047` 战区宝藏刷新倒计时、`text_099`「曾经冰魂星探索者的遗留之物，不妨去看看。」、`title_101` 挖掘记录、`tips_034`「您只能派遣一支队伍发掘」。

---

## 5. marchType 332 是幽灵行军（不占名额的依据）

`resp 2491` 带 `marchEndTime = header.ts + 10`，紧接着 `push 10019` 出现两条 `marchType:332` 的可视化条目：

```
20:35:44 uid=11981629951662 state=1 begin=(391,513)bk3828 → target=(388,530)tk3828 targetType=0  st=…944 ar=…954
20:35:53 uid=11981629951662 state=2（同一条，10s 后到）
20:35:53 uid=0              state=1 begin=(398,470)bk3281 → target=(395,483)tk3281 targetType=311 st=…954 ar=…963
```

而同期 4 次 `resp 856`（行军列表）**零命中 332** ⇒ 332 只是地图上的表现层动画，不占玩家行军名额。
所以本 feat **不查 `march.canMarch()`、不等回城唤醒**，成功判定只看 `2491` 应答的 `reward`；奖励实测直接进背包（`itemAmount` 可查），不必等 `marchEndTime`。

---

## 6. 日志分级

| 级    | 场景                                                                          | 关键上下文                                                     |
| ----- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| info  | 安装 / 启动 / **发掘成功** / 业务拒绝（`!ret.ok`）                            | siteId、S{ownerSid}、坐标、剩余秒、耗时、所得物品、code/reason |
| warn  | 22062/22063 载荷畸形、`CODE_NOT_SENT`（未发出）、发包抛错、ACL 投影不可用降级 | cmd、siteId、err.message                                       |
| debug | 活动未开 / 无数据源 / 无可采点（带 total 与 claimed 数）/ 停用后应答不落账    | 决策原因                                                       |

发掘成功的日志形如 `excavated S3281 site=140138_1794053696 (395,483) k=3281 remain=5952s cost=173ms → 紫色材料随机箱×1`，
物品名走 `core/item.js` 的 `item.label`（本池 8 个 id 已登记进 `ITEM_NAMES`）。

---

## 7. 待补录 / 风险

1. **22061 `EXCAV_OWNED` 全录制零出现** —— 语义（本战区开启的点？带 `totalRemainCount` 的归属列表？）未证实，未接线。出现时会被忽略，不报错。
2. **`header.s ≠ 0` 的真实错误码拿不到** —— 用户实测：采过后按钮本地置灰，撞不到拒绝路径。故 `noteReject` 的冷却/拉黑参数是**保守估计**，首次真被拒时需要按 code 复核。
3. **52000419/420/421/422 语义不可证**（客户端零引用，纯服务端配置）：`door_range`、`site_range`、`troops_max_num=100`、`max_claim_num=200` 到底限的是什么，未定；`max_claim_num` 与「每点限采一次」是两个维度，将来若撞限额会走 §7.2 的拒绝日志。
4. **A 档优待未证** —— 需一场「本服自己开启点位」的录制来验 `ownerSid === mSid` 时是否真走 52000416。目前排序按游戏原式实现，即使档位结论有变也不需要改代码。
5. **冷启动那次 22062 属强推断** —— 逻辑链：面板 `refreshView` 取不到 `getExcavOpenSite(cityId)` 就 `close()`；`updateExcavOpenSiteList` 全工程只有 22062 一个调用者；而该场实录全程无 22062 却能开面板并采到点 ⇒ 快照在实录窗口之前已落地。报文录制的 hook 时机不在本 feat 控制范围内，本 feat 只负责「读得到就用」。

---

## 8. 验收

- [ ] `npm run build` / `npm run lint` / `npm run arch` / `npm test` 通过（含 `tests/feats/cq26-excav.test.js` 的 200 组游戏原式对拍）
- [ ] 安装期依赖自检：`symbols: ['dataCenter', 'cq26NeutralCtrl?']`，控制器拿不到只打一行 soft symbol debug，不阻断
- [ ] 面板出现「CQ26 印石 → 基础设置 → 战区宝藏」（组内子项，不再有「一轮采完所有可采点」勾选），开关可开可关，`_excavInfo` 显示「可采 N / 共 M（本服 K）」与最近一次结果
- [ ] 世界地图 icon 亮 → feat 在 ≤ 1 个 activeMs 周期内发且**只发**一条 2491；icon 灭时零发包
- [ ] 同一 siteId 不重复发（本地 Set + 22063 覆盖 + 面板置灰三重一致）
- [ ] 全程无 901/10018 嗅探、无 2490/2492 发出（用 dashcam 录制复核：除游戏自身报文外，本 feat 只增加 2491 req/resp）
- [ ] 战斗模式开关不影响本 feat（`offInCombat: false`，因不占行军名额）
