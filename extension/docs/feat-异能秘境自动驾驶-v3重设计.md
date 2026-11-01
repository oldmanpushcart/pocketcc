# 异能秘境自动驾驶 v3 重设计（依据竞品B enigmaSecret 逆向）

> 起因：用户反馈四条硬伤——①一次都没开成车 ②一次没到过商店 ③一次没到过 BOSS 平台 ④到店也不会买。
> 本文先给出**根因**（有代码/报文证据），再给出**颠覆性重设计**，最后是**分阶段落地**。
> 竞品参照：`references/竞对逆向/竞品B/assistant/payload/server-js.js` L24138–25650（`helper.pro.misc.enigmaSecret`）。

---

## 一、四条不满的根因（不是调参能解决的，是数据源选错了）

### 1.1 总根因：**路径选择建立在「10018 push 快照」上，而 push 只在镜头扫过时才来**

现有 `drive.js` 的所有选点都走 `this.#tiles`（10018 `PUSH_TILE_INFO` 累积）：

| 档位 | 现在的候选来源 | 实战后果 |
|---|---|---|
| ④ BOSS 平台 | `#nearestBossPlatform()` 从 `#tiles` 里找 176 | 视口里没有 176 → 永远无候选 |
| ⑤/⑥ 商店 | `#nearestShop()` 从 `#tiles` 里找 161 | 161 是固定建筑、极少进视口 → 日志稳定输出「shop 档在视口快照内无可用候选点」 |
| ⑦ 巡航 | `#nearestCruise()` 从 `#tiles` 里找 163/173 | `tiles.size` 常年 2~3 个，且还有 rTime 过滤 → 常年 `cruise\|none` |

实测证据（2026-10-31 21:53 探针）：`tiles.size = 3`、`byPt={"172":1,"173":2}`、`cruiseDbg.pass=1 best=""`。
用户四条不满，**全部**落在这一行的下游。

### 1.2 逐条定位

| 用户原话 | 直接原因 | 代码位置 |
|---|---|---|
| 没一次开车成功 | ①巡航评分把 `Infinity` 参与减法，`score` 恒 `-Infinity`，`best` 恒 null（已修）；②即使修了，候选池也只有 push 到的 2~3 个点；③5s 一拍 + 一堆冷却 | `drive.js #nearestCruise` |
| 没一次到点进商店 | 商店坐标只能从视口快照里找，而四个商店是**固定建筑**（表 `enigma_secret_realm_building`, `build_type=3`），镜头到不了就永远没有候选 | `drive.js #nearestShop` |
| 没一次到点打 BOSS | 打 BOSS 要先去 176 平台，平台坐标同样靠视口找；而服务器其实给了 BOSS 权威坐标 `bossBaseInfo[i].pos` | `drive.js #nearestBossPlatform` |
| 到商店也不会自动购买 | `shop.js` 的能力是完整的（8540/8542/8543 全实现了），但它硬性要求 `pointType===161 && ARRIVED` —— **上游从没把车开到店里**，买货逻辑一次都没被触发过 | `shop.js` 头部契约 |

### 1.3 架构性缺陷（比单个 bug 更致命）

1. **8 个引擎靠相位耦合**：`drive.js` 开车 → `#enterWork` 切 `workMode` → 到点引擎（pickup/shop/boss/heal/capture）各自 `createCycle` 抢活。谁该干活取决于 drive 的相位变量，drive 一旦没发车，其它 7 个引擎全部空转。
2. **反应速度慢一个量级**：`driveScanMs = 5000`，且 TO 相位曾经睡 90s；竞品是 **100 ms tick**（`setInterval(schedule.bind(this), 100)`）。
3. **没有「阶段」概念**：只有线性优先级 ①→⑦。竞品有三个**阶段网关**（`exitStage` / `shopStage` / `beastStage`）决定「现在该干什么」，优先级是算出来的不是排出来的。
4. **金额/容量/回合开放时间这些权威约束完全没做**：资源点要按 `enigma_secret_realm_timer` 的回合 `start`（相对 `fightBeginTime`）判断是否已开放；竞品做了，我们没做。

---

## 二、竞品B `enigmaSecret` 完整拆解

### 2.1 数据源：三源合一，**没有一处依赖地图 push 做路径选择**

| 源 | 用途 | 取法 |
|---|---|---|
| **表格** `enigma_secret_realm_building`（`build_type=3` && `group==getPabGroupId()`） | **四个商店的固定坐标** | `onPabRoomBaseInfoChange` 里一次性灌进 `state.shops`，带 `sausage/piece/time` 三个记账字段 |
| **服务器态** `bossBaseInfo[]` | BOSS 坐标 `pos`、`state`(21 已开台/22 战斗中/28/30)、`stateEndTime` | `PabController` 直读 |
| **主动探测** `901 GET_WORLD_INFO {x,y,width:20,height:30,viewLevel}` | 视野内的资源点/怪/平台/掉落 | `marchResource` 每拍按需拉一次，`pointList` 直接当候选池 |
| push `10018` | 仅做增量补充与掉落箱识别 | `onUpdateTileInfo` |

> **901 走的是秘境次通道的 JSON 版**：`TMWatchNetMgr.Instance.send(901, body, null, cb)`，回调 `e.s == 0 ? JSON.parse(e.d) : null`。
> 这不是 PBV2 —— 我们现有的 `sendSecret()` 只封了 `sendPBV2`，**这是必须补的第一个 ACL 口子**。

### 2.2 节拍：100 ms tick + 取模分频 + `busy` 锁

```js
start() { this.timer ||= setInterval(this.schedule.bind(this), 100, { counter: 0 }); ... }
async schedule(e) {
  if (!this.busy) {
    try { this.busy = 1; e.counter++; if (this.active) await this.execute(e.counter); }
    finally { this.busy = 0; }
  }
}
execute(n) { isWorldMap|isKvkMap ? teamDispatch(n) : roomDispatch(n); }
roomDispatch(n) {
  if (n % 1 == 0) getDropBox();      // 100ms
  if (n % 2 == 0) autoLeader();      // 200ms  主决策
  if (n % 2 == 0) capturePet();
  if (n % 2 == 0) recuperate();
  if (n % 3 == 0) shopConver();      // 300ms  到店买货
  if (n % 8 == 0) getResItem();      // 800ms  到点拾取
  if (n % 9 == 0) scoutBeast();
  if (n % 9 == 0) judgeLeave();
}
```

配合 `cd_time`（**全部用服务器秒 `ServerTime`**）做真正的最小间隔：
`march: +3s` / `beast: +10s` / `shop` 到店 `+shop_stay_time(15s)` / `resource` 到点 `+min(res_stay_time, 未占位格数*0.8+1.1)` / `boss: +1s` / `create: +5s`。

> 我们现在的 5s 固定拍 + 本地 `Date.now()` 冷却，和最坏情况下的 `driveMarchTimeoutMs=90s`，等于把反应速度压到竞品的 1/50。

### 2.3 决策：三个阶段网关 + 一张动作优先级表

```js
get exitStage() {   // 收场：按 team_type 分别要求「买过 piece==1 的店」「BOSS state==30」「百兽箱数量达标」
  return {0: pieceShop, 1: pieceShop && boss30, 2: pieceShop && boss30 && beastsEnough}[team_type]
      || ServerMSTime >= fightEndTime;
}
get shopStage() {   // 该去商店了：超过 shop_interval(8min) 没去；或 BOSS 将在 150s±30 内开台而 >120s 没去
  ...
}
get beastStage() {  // 可以安心抓百兽：已买 piece、所有 BOSS 都 state 28/30、血包/香肠够、5 色增益≥3、百兽箱未满
  ...
}
```

`autoLeader()`（每 200ms）——**队长专用主决策**，前置 `fightBegin < now < fightEnd`、是队长、`isCanMarch()`、当前点不是 BOSS/BOSS_GUARD：

```
0. getTeamInfo()                          取当前驻泊点 tile + 敌方在途行军
1. 防袭（当前点≠商店时）
   march_policy>=0 且 tile.state==12        → 不动（正在挨打）
   march_policy>=1 且 tile.state==11        → 不动（有敌人来袭）
   march_policy>=2 且 有敌方行军            → 不动
   march_policy==0 且 tile 危险 且 战力不占优 → 跑：marchBeast(4) || marchResource() || marchShop()
2. BOSS 期（state==21 开台 或 22 且已结束）
   若不在平台 或 目标台≠当前台 → marchPlane(getBossInfo(目标台))   ← 先上平台
   否则                        → marchBoss()                      ← 再打 BOSS
3. BOSS 预警期（state==22 且 剩余 < plane_time 60s）→ 提前 marchPlane
4. 常规期（受 cd_time.march +3s 节流）
   exitStage  → marchShop()
   shopStage  → marchShop(1)          // 1 = 优先「还没香肠的店」
   beastStage → marchTeam(policy==2) || marchBeast(4) || marchResource()
   否则       → marchTeam(policy==2) || marchBeast(4) || marchResource(需求5+人数/2, 距离上限100)
                || marchResource() || marchShop()
```

### 2.4 动作函数：选点公式（可借鉴的关键算法）

**marchResource（资源点）**
```js
// 1) 主动拉 901，以 startPoint 为中心 20×30
const o = await asend(901, {x:start.x, y:start.y, k, width:20, height:30, marchInfo:true, viewLevel:1});
// 2) 过滤
pointType == PAB_RESOURCE
  && 回合已开放：ServerTime > fightBegin/1000 + timer[realm[esrId].roundid].start
  && 60s 内没去过（marched_list）
  && m.iNum >= 需求
  && 0 < 距离 <= 距离上限
// 3) 再筛：state==0 && teams.length==0 && (policy==1 || 无敌方行军指向该点)
// 4) 打分：iNum - 距起点/2 - 距"最近无香肠商店"/5   ← 越大越好
// 5) 出发前记账 matched_list.push({x,y,t:ServerTime})，然后 sendToBuildingMarch(x,y)
```

**marchShop（商店）**
```js
前置：now >= fightBegin + 63s                    // 开局 63s 内不出门
     && 最近 3s 内没在这家店（state.shops[].time*1000+3000）
     && 当前不在 161
排序：e(优先无香肠) ? 按 sausage 升序 : 按距离升序
```

**marchPlane / marchBoss（平台/BOSS）**
```js
getBossInfo(boss):
  boss.pos 就近(<30) → 从 MapData.entities 找该格的 PAB_BOSS_PLANE（extData.esrId 相同 && state==22）
  否则 901 拉该 BOSS 坐标，pointList 里找平台 + marchList 里找己方/敌方行军
marchPlane(bossInfo):
  planes.filter(policy==1 || 无队伍占 && 无己方行军指向)
        .sort(plane_policy<2 ? 近优先 : 远优先)[0] → sendToBuildingMarch
marchBoss(bossInfo):
  仅当 tile 在场 && (state==22 已过结束时间 || state==21) → sendToBuildingMarch(boss.pos)
```

**marchBeast（野怪）**
```js
按品质分档：先拿 EnigmaBeastController 已侦察的最多 4 只 → 并发 901 验活 → 按 quality 降序、距离升序取第一只
```

### 2.5 到点分派：以 `pointType` 为准，不是靠相位变量

```js
onPabTeamMarchArrive({x,y,pointType}) {
  PAB_RESOURCE → 8526 RESOURCE_INFO → cd_time.march = ServerTime + min(res_stay_time, 空位数*0.8+1.1)
  PAB_SHOP     → 8540 SHOP_INFO     → cd_time.march = ServerTime + shop_stay_time(15s)
  PAB_MONSTER  → cd_time.march = ServerTime + 20
}
```
到点后由 `getResItem()`（每 800ms）/`shopConver()`（每 300ms）**从响应里的 bagInfo/items 直接干活**，不依赖「现在处于哪个相位」。

### 2.6 到店买货（`shopConver`，300ms 一次）

```
前置：isCanMarch && roomBaseInfo.pointType==161 && targetPoint 与 mooring.shop.point 一致
候选：items.filter(getTime==0) → 查表 enigma_secret_realm_shop
选品优先级：
  BOSS30 已清 → 百兽箱商品 || (buy_sausage && 41011<10 && 有41011)   // 清完 BOSS 转抓百兽
  否则        → (buy_sausage && 41011<10 && 有41011) || 百兽箱商品
买：41009 余额 >= cost → 8542 {specId, num:1} → emit PabRoomShopDataUpdate 刷新本地 items
  若没有目标品 && buy_sausage && 41011<10 && 41010>0 → 8543 REFRESH（花 1 个刷新币）
```
> 注意：**`getTime == 0` 才是可买的货位**；`getTime` 是"已买次数"，买完就 +1。

---

## 三、新架构（v3）：`pilot.js`

### 3.1 设计原则（与 v2 的三条硬切割）

| # | v2（现） | v3（新） |
|---|---|---|
| 1 | 路径候选 = 10018 push 快照 | **路径候选 = 表格权威坐标 + 主动 901 视口 + push 增量，三源合并** |
| 2 | 5s 固定拍 + 90s 输运相位 | **300ms 评估拍**，`cd_time` 用服务器秒做最小间隔，**永不长睡** |
| 3 | 开车与到点分成 8 个引擎、靠相位耦合 | **一个 pilot 统一「决策 + 发车 + 到点分派」**；拾取/买货/打 BOSS/治疗作为 pilot 的**动作**调用，不再各自 createCycle |

### 3.2 分层

```
pilot.js
├─ S0 数据层  snapshot()
│    ├─ anchors: 商店坐标（表）· BOSS 坐标/状态（bossBaseInfo）· 平台坐标（901 按 BOSS 坐标查）
│    ├─ viewport: 901 主动查询（startPoint 中心 20×30，命中 CD 才发）
│    └─ pushes: 10018 增量并入（合并、带 age）
├─ S1 阶段层  stage()
│    ├─ realmClosed（enigma_realm17 → 停手）
│    ├─ exitStage / shopStage / beastStage / bossStage
│    └─ 输出「本拍该干的事」枚举：MARCH_SHOP | MARCH_PLANE | MARCH_BOSS | MARCH_RES | MARCH_BEAST | IDLE
├─ S2 动作层  act()
│    ├─ 选点（每个动作一个纯函数：输入 snapshot+stage，输出 {x,y,why} | null）
│    ├─ 同点短路：目标==当前点 → 直接进「到点态」，不发包
│    ├─ 8521 发车（sendToBuildingMarch 等价），记账 marched_list[60s]
│    └─ 应答：ok===1 进到点态；enigma_realm17 → realmClosed；其它 → 目标降级 + 短退避
└─ S3 到点层  arrive(pointType)
     ├─ 161 → shopBuy（复用现有 shop.js 的核心逻辑，改为 pilot 调用）
     ├─ 173 → resPick（复用 pickup.js 核心）
     ├─ 176 → bossFight（复用 boss.js 核心）
     ├─ 163 → dropPick
     └─ 统一 cd_time：res = min(res_stay, 空位*0.8+1.1) / shop = shop_stay / monster = 20
```

**关键：v3 不再有「TO 相位睡 90s」。** 到点判定只认 `roomBaseInfo.startPoint == 目标 && marchState==ARRIVED`，每 300ms 复核一次；超时阈值只用来「记账走人」，不再决定睡眠时长。

### 3.3 必须补的 ACL（`core/game-api.js` → `secretRealm`）

| 方法 | 用途 | 实现要点 |
|---|---|---|
| `sendSecretJson(cmd, data)` | 901 等 JSON 协议走秘境次通道 | `mgr.send(cmd, data, null, cb)`，`cb.s==0 ? JSON.parse(cb.d) : null`，5s 超时回 null |
| `queryWorldView(cx, cy, w, h, viewLevel)` | 主动拉视口 | 包 `sendSecretJson(901, {x,y,k,rid:0,width,height,marchInfo:true,viewLevel})`，返回 `{points, marches}` 归一 |
| `getPabBuffValueByType(type)` | 背包容量/增益 | `p.getPabBuffValueByType(type)` |
| `getRoomBagInfo()` | 背包野兽/物品 | `p.roomBagInfo`（只读快照，深拷贝最小字段） |
| `getCapturingPetPos()` | 拍宠中不挪点 | `p.capturingPetPos` |
| `getEnigmaBeastScout(x,y)` | 野怪品质 | `EnigmaBeastController.getScoutInfo(x,y)` |
| `isCanMarch()` | 统一可发闸 | 游戏 verbatim：`!!roomBaseInfo && teamIsMooring()` |
| `getMarchList()` | 己方/敌方行军 | `MapData.marches` → 归一 `{begin,target,state,leaderUid}` |

### 3.4 表格与常量

| 表 | 用途 |
|---|---|
| `enigma_secret_realm_building` | `build_type==3 && group==getPabGroupId()` → **四个商店坐标**（v3 商店档的权威来源） |
| `enigma_secret_realm_timer` | `id` ↔ 回合；`start`（相对 fightBegin 的秒）；资源点/野怪的开放判定 |
| `enigma_secret_realm` | `roundid` 映射（`esrId → roundid → timer`） |
| `enigma_secret_realm_shop` | 货位 `item_id / cost / buy_times / type(3=跨店限量)` |
| `enigma_beast` | 品质 `quality`（≥4 才算好货） |

### 3.5 配置项（对齐竞品但去掉其冗余）

```js
pilot: {
  enabled: true,
  // 行为
  buySausage: true,        // 41011 < 10 就买香肠
  resStaySec: 8,           // 资源点驻留上限
  shopStaySec: 15,         // 商店驻留
  shopGapSec: 480,         // 多久必须去一次商店（竞品 shop_interval=8min）
  planeLeadSec: 60,        // BOSS 开台前多久上平台
  // 策略
  marchPolicy: 0,          // 0=让路 1=只躲不抢 2=抢
  planePolicy: 0,          // 0=近优先 1=无视占用 2=远优先
  guardPolicy: 0,          // 0/1=跳过某个 BOSS 2=只打已领奖 3=只打未领奖
}
```

> 现有 `drive.*` 四个开关（`enabled/boss/shopTime/shopDwellMs`）保留为兼容映射，面板文案改为「自动驾驶 v3」。

---

## 四、实施计划（分四步，每步都可独立验收）

### P0 地基（ACL + 数据源）
1. `game-api.js` 补 §3.3 八个方法。
2. `constants.js` 补 `TABLE_BUILDING='enigma_secret_realm_building'`、`TABLE_TIMER='enigma_secret_realm_timer'`、`TABLE_REALM='enigma_secret_realm'`。
3. `pilot.js` 的 S0 数据层 + 一个只读探针 `__pcPilotSnap()`：打印「四店坐标 / BOSS 列表 / 901 视口点数 / 行军列表」。

**验收**：探针能打出 4 个商店真实坐标与至少 1 个 BOSS 坐标（不依赖镜头位置）。

### P1 决策 + 发车（替换 drive.js 的巡航/商店/平台三档）
4. S1 阶段层 + S2 动作层（marchShop / marchResource / marchPlane / marchBoss）。
5. 注册开关：`pilot.enabled` 优先，`drive.enabled` 作为回退（并存一个版本）。

**验收**：`__pcPilot()` 观察 60s → 至少 1 笔 8521 且 dashcam 里应答 `s:0, data.ok:1`；商店档必能选中 4 店之一。

### P2 到点分派（消灭 8 引擎相位耦合）
6. S3 到点层接管：161 调 `shopBuy`、173 调 `resPick`、176 调 `bossFight`、163 调 `dropPick`。
7. 现有 `shop.js / pickup.js / boss.js` 的 `createCycle` 改为「仅由 pilot 调用的一次性动作」，不再自转。
8. `drive.js` 降级为 legacy，默认不启动。

**验收**：一次完整链路——发车→到店→买香肠（41011 从 0 到 ≥1）→发车→上平台→打 BOSS。

### P3 稳健性
9. 收场/封闭识别（`enigma_realm17`）、复活（`8552`）、跑路（受击 + 战力比较）、离场（`8581`+`8589`）。
10. 失败现场落盘：像竞品 `LocalStorageUtils.set('enigmaSecret-marchResource-failLog', {...})` 那样，把「本拍候选池 + 过滤后为空的原因」写进 storage，事后可复现。

---

## 五、明确**不学**的部分

| 竞品做法 | 为什么不学 |
|---|---|
| 100ms 全局 tick | 对方全局只有这一个引擎；我们有 20+ feat 共用主线程。**改为 300ms 且按需**（`cd_time` 已保证不会重复发包）。 |
| 直接 `PabController.sendToBuildingMarch` | 我们要走 ACL 防腐层（`secretRealm.sendMarch`），但**判据要对齐**：`data.ok === 1` 才算成功。 |
| UI 节点反射（`cc.find(...).onTouchBegin()` 拍宠/喂食） | 侵入式、改版即漂。我们保留现有的 `ui` 事件通道，不做节点反射。 |
| 拆 `c8*` 赛季变体整模块 fork | 我们用一个引擎 + 配置位区分。 |
| 远程下发代码 | 供应链风险，是我方护城河的反面。 |

---

## 六、附：竞品代码位置索引（便于复核）

| 内容 | server-js.js 行 |
|---|---|
| `setting` 全量默认值 | 24139–24193 |
| `state.shops/boss` + `cd_time` + `mooring` | 24194–24215 |
| `ids`（该买什么货） | 24219–24231 |
| `isOpen`（活动开没开） | 24314 |
| `exitStage / shopStage / beastStage` | 24560–24594 |
| `getTeamInfo / getBossInfo` | 24595–24668 |
| **`marchResource`（评分公式）** | 24708–24771 |
| `marchBeast / marchTeam / marchShop / marchPlane / marchBoss` | 24772–24880 |
| **`autoLeader`（主决策树）** | 24882–24986 |
| `judgeLeave / recuperate / capturePet` | 24987–25079 |
| `getDropBox / getResItem` | 25080–25193 |
| **`shopConver`（到店买货）** | 25194–25230 |
| 推送处理（到点/商店/掉落变更） | 25231–25341 |
| **`roomDispatch`（100ms 分频）** | 25342–25369 |
| `schedule / start`（busy 锁） | 25379–25400 |
| 面板字段 | 25491–25650 |

---

## 七、落地进度（已实施，2026-10-31）

### 7.1 实际交付

| 项 | 状态 | 落点 |
|---|---|---|
| P0 ACL（`queryWorldView` 901 / `tableRows` / `getItemNumById` / `pabServerId`） | ✅ | `core/game-api.js`（L2653/2670/2711/2754） |
| 表名 + 道具 + pilot tuning 三组常量 | ✅ | `secret-realm/constants.js`（`TABLE_BUILDING/TIMER/REALM`、`ITEM_SAUSAGE=41011`、`driveViewMs` 等 12 键） |
| v3 引擎（四层：S0 数据 / S1 阶段 / S2 动作 / S3 到点） | ✅ | `secret-realm/pilot.js`（`PilotEngine`，约 1860 行） |
| 旧 `drive.js` 退场 | ✅ | 已删除；`index.js` 改装配 `PilotEngine`，调试面名仍是 `pocketcc.secretRealmDrive` |
| 到店真买货 | ✅ | `shop.js`：总闸放行 `drive.enabled`、新增 `#grabSausage`、新增可被外部唤醒的 `kick()` |
| 只读探针（P0 验收） | ✅ | `tools/secret-realm-pilot-snap.devtools.js` → 控制台 `__pcPilotSnap()` |

### 7.2 与原计划的偏差（都是有理由的）

| 计划 | 实际 | 原因 |
|---|---|---|
| P2 把 `shop.js/pickup.js/boss.js` 的 `createCycle` 改成「仅由 pilot 调用」 | **不改**，改为「引擎照旧自转 + pilot 到店踢一脚（`env.kickShop()`）+ 自动驾驶时商店引擎改短轮询」 | 那三个引擎的到点能力已被实战验证；拆它们的循环等于重写拾取/攻打/拍宠三大块，风险远大于收益。真正缺的只是「车到店时商店引擎正睡着（`shopSweepMs`=10min）」这一处时序缺口 |
| 500ms 定拍 | 事件 kick + `driveScanMs`(5s) 兜底 + 到点/被拒后 0~400ms 紧拍 | 秘境里真正需要紧拍的只有「到达复核」，其余都是分钟级动作 |
| 只在 21 开打 / 22 读秒上平台 | 追加**读秒过期宽限窗**（`driveBossGraceMs`=90s）：`state==22 && stateEndTime<now` 且已在平台上 → 仍视为可打 | 竞品 `marchBoss`（server-js.js L24874）同款；少了它，21 推送迟到时车会从平台上落下去巡航，整场 BOSS 让掉 |
| 商店档纯缺口闸 | 追加**到店即冷却** `#shopCoolUntil`（`driveShopGapCooldownMs`=10min） | 缺口补不满（无货/额度空/缺刷新币）时会「离店→缺口仍在→又开回同一家店」永动（v2 20261031 实证） |
| 平台筛选只看类型/占用 | 追加 `state===22` **加权**（+200 分，不硬筛） | 竞品 `getBossInfo` 只认 `extData.state==22` 的平台；我方做成加权，避免未证形态被硬筛没 |

### 7.3 实机验收步骤

1. `npm run build` → 重载扩展 → 进异能秘境。
2. 面板开「自动驾驶」；控制台跑 `__pcPilotSnap()`：
   - 必须看到 `anchors.shops` ≥1 家（表格坐标，与镜头无关）；
   - `view.ok=true` 且 `points` 数十级（901 主动拉成功）。若 `view.off=true`，说明 901 在秘境不可用，引擎已自动降级为「锚点 + push + 探索」。
3. 开 `pocketcc.secretRealmDrive.debugState()`，重点看：
   - `version:3`；`stage`：`boss-open`/`boss-lead`/`shop`/`cruise`/`explore`；
   - `lastBranch` + `gate`：卡在哪一道闸一眼可见（`not-leader`/`not-moored`/`inflight`/`curpvp`/`cooldown`）；
   - `phase.shopCoolLeftMs`：到过店之后不应再立刻回店。
4. 到店验收：dashcam 里必须出现 `8540 SHOP_INFO` → `8542 SHOP_BUY`（`shop: bought spec …`）；若只有 8540 没有 8542，说明本店无香肠/无货，看 `shop: buy spec … rejected` 那一行。

