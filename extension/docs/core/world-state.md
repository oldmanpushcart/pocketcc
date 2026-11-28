# world-state.js — 世界态归一层（Kind / Place / Phase / Gen）

> 一句话：把游戏四路正交信号（cc 场景名、`mapType`、`CrossUtils` 形态位、`watchingType`）
> 归一成**互斥的场景档 Kind + 该场景下的地图 Place + 阶段 Phase +（峡谷代际 Gen）**，
> 供 reactor 的 `world` 门控与 feat 自查使用。
>
> 本文件只讲「插件怎么用」，不复述逆向证据。

---

## 1. 职责与边界

| 层             | 文件                                | 职责                                                                                                                               |
| -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 原始信号       | `core/game-api.js` → `worldSignals` | 只读取游戏原值（`mapType`/`watchingType`/`ServerState`/`_tmServerType`/`eightServerType`/`CrossUtils.*`/场景名），**不做任何判断** |
| 归一           | `core/world-state.js`（本文件）     | 归类 + 快照缓存 + 翻转广播 + 调试面；**不出现任何游戏符号名**                                                                      |
| 采集时机与门控 | `core/scene-watcher.js`             | 决定「什么时候重算」、注册 `world` 唯一门控（含秘境 `kind===pab` 隔离）                                                            |

硬边界：

- **纯只读**。全链路没有一次游戏侧 setter 调用（只读 + 发包红线）。
- **不 import reactor**（依赖方向：`scene-watcher → world-state → game-api`），否则 core 内部成环。
- 不做「该不该跑」的业务决策，只输出事实维度；业务判断写在 feat 的 `kinds/places` 声明或 `actionable()` 调用处。

---

## 2. 设计思路与取舍

### 2.1 两层抽象而不是三层

旧 `scenes:['Home','NWorldMap']` 门只覆盖 cc 场景名这一层，而**所有跨服战场图共用 `NWorldMap`**，
导致「本服图」与「跨服图」在门控眼里是同一件事。解法是把两个问题拆开：

- **Kind**（哪一种场景）由服务器形态位 + `mapType` 决定 —— 回答「你在打什么」；
- **Place**（哪张地图）由 cc 场景名决定 —— 回答「相机在哪」。

天梯不独立成第三种「场景」：它的四阶段（捐献/准备/战斗/领奖）与游戏 `ServerState` 枚举一一对应，
是**进程位**，所以落 `Phase`。

### 2.2 谓词链优先于 mapType 反查（顺序不可调换）

游戏里有两个同名 `setMapTmxData`（`CrossUtils` 与 `NewCABController`），后者会按
`isNewCABServer()` 写 `new_cab`、否则写 `world`，而前者**没有 AVA 分支、else 兜底也写 `world`**。
两者互相覆盖 ⇒ **AVA 峡谷图内 `mapType` 可能是 `new_cab(7)`，也可能是 `world(1)`**。

结论：`mapType==='world'` **不能反证**「你在本服」。所以 `kindOf()` 必须先跑形态位谓词链（第 ② 步），
再跑跨服登录态（第 ⑥ 步），`mapType` 反查只能当兜底（第 ⑦ 步）。这条顺序是被游戏实现逼出来的，不是风格选择。

另外，**换服重连型跨服**（盟决 `7631 CROSS_ALLIANCE_MOVE_TO_OTHER_SERVER`）登录包把 `currk`
改成目标服，但 `CrossUtils.setMapTmxData` 没有 `crossType=7` 分支，`mapType` 仍是本服图变体
（2026-11-28 真机：敌对战服 4397 内 `mapType=202`、`kind` 若只靠反查会误判 homeland）。
这类形态只有 `ServerId !== OriginServerId` 可辨，mapType 反查永远等不到 `adp_war(12)`。

### 2.3 `kind` 与 `crossMap` 双口径（同一份快照里两个字段）

- `kind` 用形态位：跨服赛季**整季为真**（你的身份在这族战场），哪怕你此刻回了原战区看家；
- `crossMap` 用 `mapType` + 跨服登录态：**此刻你的世界图不在本服**（`mapType` 反查出非本服图，
  或 `ServerId !== OriginServerId` 的换服重连态——后者 `mapType` 仍是本服图变体，只看反查会把敌对战服误判成本服）。

游戏自己就有这种分裂：`TMWatchNetMgr` 允许「人在 `kvk` 图上、`watchingType=PAB` 观战」同时成立。
⇒ **破坏性动作（开盾/迁城/发行军）的严判要读 `crossMap()`，不要读 `kind()`**，否则会误伤
「赛季开着但人回老家」的窗口（那时护盾照常可用）。

### 2.4 未就绪档放行 homeland（否决了「默认拦截」）

`_currentMapType` 初值就是 `world(1)`，「从没进过跨服的账号」与「信号没到」静态不可分。
默认拦 = 新账号首屏饿死 28 个玩法；默认放行 = 误判窗口小于一拍（`mapType` 由登录报文折算，
时序必然早于进场景）。选了后者，快照里用 `ready:false, reason:'biz-not-ready'` 留痕。

### 2.5 Gen 不进 Kind

`ava/tm/master/legend` 四代共用「无双峡谷」这一个 Kind（地图资源名、护盾规则、行军换算同族），
只在 `gen` 维度细分（它决定 `marchType` 110/150/170/181 与 UI 归属）。
拆成四个 Kind 会让 `kinds:['wushuang']` 这种声明变成抄四遍，且与游戏语义相悖。

---

## 3. API 契约

### 3.1 枚举常量（导出）

```js
KIND; // homeland pab wushuang kvk_c4 kvk_c8 kvk_c8s2 cnc cnc25 adp_war unknown
KIND_GROUPS; // kvk:[3] sphere:[cnc,cnc25] cross:[8]
PLACE; // base base_other world world_old battle sphere transition boot other off
PHASE; // normal donate ready fight reward matching unknown
GEN; // none ava tm master legend thunder
```

### 3.2 `worldState` 聚合面

| API                              | 返回    | 说明                                                                 |
| -------------------------------- | ------- | -------------------------------------------------------------------- |
| `current()`                      | 快照    | 无缓存则现采一次（保证装配早期也有值）                               |
| `refresh()`                      | 快照    | 现采 + 翻转才 `log.info` 并 `bus.emit('world.change')`               |
| `kind()` / `place()` / `phase()` | string  | 单维度便捷读                                                         |
| `crossMap()`                     | boolean | 此刻是否真在跨服战场图上（`mapType` 口径，见 §2.3）                  |
| `matchesKind(list, at?)`         | boolean | 支持组名；**空/缺省列表 = 放行**                                     |
| `matchesPlace(list, at?)`        | boolean | Place 白名单（无组名概念）；**空/缺省列表 = 放行**，不内置兜底       |
| `actionable(needKinds?)`         | boolean | 破坏性动作自查：未就绪或观战中 → `false`；缺省列表时「除秘境外可动」 |
| `dump()`                         | 快照    | 现采 + 打印，含 `raw` 四路原始值                                     |

快照结构：

```js
{ kind, place, phase, gen, watching, crossMap, ready, reason,
  raw: { scene, sceneSemantic, mapType, mapTypeName, watchingType, watchingTypeName,
         serverState, serverStateName, tmServerType, eightServerType,
         cross:{anyServer,cabMap,tm,master,teamLegend,newCab,eni,cq25,c4,c8,c8s2} } }
```

`reason` 是落档依据（`watching-pab` / `cross-predicate` / `cross-cabmap` / `maptype-master` /
`biz-not-ready` / `maptype-xxx`(unknown) …），排错第一眼看它。

**`watching` 的口径**：`watchingType !== 0` **且非秘境**。游戏侧的 `watchingType` 实为「世界图被哪个
玩法接管」的接管位，秘境（PAB）也占在其取值里——真机实证：打秘境时 `watchingType=3(PAB)`、
`mapType=9`、`kind=pab`，人是**在场实战而非观战**。若直接按「非 0」判，会把整段秘境期误报成观战。
真·秘境观战与秘境实战共用同一位、静态不可分——需要细分时看 `raw.watchingTypeName` 与秘境活动态。

### 3.3 门控声明（feat 侧唯一入口）

```js
reactor.register({
  id: 'autoFarm',
  kinds: ['homeland'], // 哪一种场景（档名或组名）；缺省=放行
  places: ['base', 'world'], // 哪张地图（Place 值）；缺省=不判
});
```

`world` 门是唯一场景闸门（P3 第 4 刀退役了旧 `scene` 门：各 feat 的 `scenes:['Home','NWorldMap']` 等价迁移为
`places:['base','world']`，因 `place` 本就由 `sceneSemantic` 从场景名折算）。`kinds` 与 `places` 是**与**关系，任一不过即 pause。

**秘境隔离（P3 第 4 刀，原 `core/pab-watcher.js` 折进本层）**：当 `kind===pab` 时 `world` 门**默认全拦**，
只放行 `kinds` 显式含 `'pab'` 的 spec（异能秘境本体 `secretRealm`）——秘境是独立世界体系，其它 feat
进秘境即 pause、出秘境自动 resume（检测走 `scene-watcher` 的事件 + 2s 兜底轮询）。这是 `scene-watcher` 的
门控策略、**不写进 `matchesKind`/`matchesPlace` 纯判据**（否则热键层会被连带拦下）。

热键层（`core/hotkeys.js` 的 `bind()`）用**同一套判据**（`matchesKind` × `matchesPlace`）但不经 reactor：
它自己按键时直接读 `current()`，且不受秘境隔离约束。两者的兜底方向不同，见 §4.6。

---

## 4. 场景用法

### 4.1 「只在本服常态图跑」的玩法（迁移主体）

```js
kinds: ['homeland']; // 下田、卡车争夺、遗迹、扫图、联盟科技/机甲/巨兽……
```

**已落地（P3 第 1 刀 + 第 4 刀）**：24 个 A 档 feat 全部声明了 `kinds:['homeland']`（名单见可行性报告 §7.2），
并在第 4 刀把各自的 `scenes:['Home','NWorldMap']` 退役为 `places:['base','world']`。注意 `kinds:['homeland']`
**不区分 Home 与看别人的城**（两者 Kind 都是 `homeland`、只是 Place 不同）；而 scene 门退役后，正是这道
`places:['base','world']` 在拦「在别人城里误触发」（`place=base_other`）与战斗演出（`place=battle`、此时
kind 可能仍 `homeland`）——所以退役 `scene` 门时**必须**补 `places`，不能只留 `kinds`。

### 4.2 「三种天梯形态都要跑」

```js
kinds: ['homeland', 'kvk']; // 组名覆盖 kvk_c4/kvk_c8/kvk_c8s2
```

### 4.3 开盾类动作：峡谷按 `kind` 恒跳、其余跨服图按 `crossMap` 降级

```js
var st = worldState.current();
if (st.kind === worldState.KIND.wushuang) return false; // 峡谷内护盾根本不生效（ava_tips_064）——发一次废一张盾
if (worldState.crossMap()) return false; // 天梯/盟决：仅「此刻真在战场图上」不能开（cross_server_info_042）
```

**已落地（P3 第 2 刀）**：`feats/battle/auto-defense/index.js` 的 `strategyShield` 开头就是这两道闸（策略 ②③④ 不降级）。
两条判据不能合并成一条：无双峡谷是「族内恒不生效」，而 `kind=kvk_*` 是**整季形态位**——
赛季中你随时可能回原战区老家（`mapType` 折回本服图、`crossMap=false`），那时护盾照常可用，
按 `kind` 一刀切会把整季的常态防御一起废掉。同理，`gameData.isKVK()`（= `judgeKVK(eightServerType)`）
也是形态位而非图位，与 `matchesKind(['kvk'])` 同源；要「现在哪张图」只认 `crossMap()`（§2.3）。

注：游戏自身的 `checkShieldEnable()` 把「危险区/跨服」两条闸包在 `isForceFightBattling()` 里，
非强制对战态时会返回「可开」——所以这里的跳过是**插件侧主动不浪费道具**，不是复现游戏判定。

### 4.4 攻击类动作：拿 Gen 决定 marchType 兜底档

`march.resolve()` 已内建跨服漂移换算，feat 一般不需要读 `gen`；
只有在「要按代际换 UI 文案/活动面板」时读 `worldState.current().gen`。

### 4.5 破坏性动作前的统一自查

```js
if (!worldState.actionable(['homeland', 'kvk'])) return; // 观战/未就绪/落错档一律不动手
```

### 4.6 UI/输入类功能：只声明 `places`（C 档）

关弹窗 / 背包 / 基地↔大世界 / 聊天窗口这类与「哪一种场景（Kind）」无关、只与「哪张地图（Place）」
有关的功能，**只声明 `places`、不声明 `kinds`**——在峡谷/天梯/盟决图上照用，不因为进了跨服档就被停掉：

```js
bind({
  id: 'closePopup',
  keys: ['Escape'],
  scenes: ['Home', 'NWorldMap'],
  places: ['base', 'world'],
});
```

reactor 侧（如 `chatWindow`）同理加 `places`。两点例外口径：①热键层的兜底——世界态拿不到（`kind=unknown` 或
`place=off`）时对新口径**直接放行**、退回旧 `scenes` 口径。理由是本层是按键级判定，没有 pause/resume
补偿，拦错一次就是功能凭空消失且不自愈；而 reactor 拦错会在回到白名单档时自动 resume，所以
`worldState.matchesPlace()` 本体保持纯判据、不把这道兜底内置进去；②秘境档的隔离（§3.3）是**默认全拦**——
不声明 `kinds` 的 C 档 feat（如 `chatWindow`）在秘境图内也会被 pause，与 `matchesKind` 空列表=放行的
纯判据口径相反；这是门控策略而非判据，要在秘境照跑需显式声明 `kinds:['pab']`。

---

## 5. 数据流与降级

```
游戏事件 MapTypeChange / CHANGE_SCENE / CrossServerStateUpdate
        + cc EVENT_AFTER_SCENE_LAUNCH + 2s 兜底轮询
                ↓
   scene-watcher.refresh()  →  world-state.collect()  →  worldSignals（只读原值）
                ↓（四维任一翻转）
   log.info + bus.emit('world.change')  →  reactor.recomputeAll()  →  各 feat run/pause
```

另一路消费者：`core/hotkeys.js` 在按键时直读 `worldState.current()`（不经 reactor，兜底方向见 §4.6）。

降级路径（都不停摆）：

| 异常                                              | 行为                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| 事件底座不可用（`pocketcc.event.install()` 失败） | 退化为纯 2s 轮询，记一次 warn                                                     |
| 某个 `CrossUtils` 谓词抛错（子包门面未接管）      | 该支路返回 `undefined`，跳过继续走下一判据；**区别于 `false`**，不会误落 homeland |
| `collect()` 整体抛错                              | 沿用上一帧快照，`reason:'collect-error'`，warn 一次                               |
| `NWorldMapCoreBiz` 未在场                         | `ready:false` + `kind:homeland`（§2.4），下一拍自动纠正                           |
| 拿到未知 `mapType` 名                             | `kind:'unknown'` + `reason:'maptype-xxx'`（版本漂移首遇，值得响一次）             |

---

## 6. 坑与边界

1. **`unknown` 不是「没事」**：它是漂移警报位。A 档 feat 一旦落 `unknown` 会被门控 pause——
   看到大面积停摆先 `dump()` 看 `reason`。
2. **`worldSignals` 的 `cross.*` 可能返回 `undefined`**：feat 里不要写
   `worldSignals.cross.c4() === false`（无从判定 ≠ 判定为否），要么走 `worldState`，要么用 `!`。
3. **`kind` 不等于「人在这张图上」**：跨服赛季整季 `kind=kvk_*`；判「此刻在战场图」必须用 `crossMap`。
4. **秘境一路的 `mapType`/`watchingType` 都不能单看**：`mapType` 会被 `PabController.getPabMapType()`
   覆写，所以 `pab` 判定走 `watchingType===PAB` 且排在链首；反过来 `watchingType` 是**接管位而非观战位**
   （PAB 也占它），故 `watching` 显式排除 PAB。
5. **盟决（`adp_war`）判据**：主判据是跨服登录态（`ServerId !== OriginServerId` 且 `crossType=7`，
   2026-11-28 真机 4397/4402 实证）；`mapType===12` 反查只当兜底（换服重连后 `mapType` 实测仍是 202，
   `CrossUtils.setMapTmxData` 无形态 7 分支）。另注意：盟决下 `isInAnyServer()` 可能因
   `ServerState!=Normal` 才为 true，别把它当跨服信号；`cross.*` 峡谷/征服者谓词全 false。
   未识别的跨服形态号一律落 `unknown`（保守暂停），不许冒充 homeland。
6. **传奇小队无观战态**：`isTeamLegendServer()` 无 watching 分支、枚举无 `LEGEND_WATCHING`。
   若 dump 出现 `watching:true && gen:'legend'`，说明游戏改版，需要重新核对判据。
7. **旧 `thunder`（雷神峡谷）是历史档**：`CrossUtils.isCAB()` 恒 false，`gen:'thunder'` 仅为
   `mapType=cab(3)` 兜底保留，别在它上面写新逻辑。
8. **本服世界图有四个 `mapType` 变体**：`world / world_withBoder / world_NTerrain / world_NTerrain_border`
   （游戏自己就收口成 `worldMapArr` 四元数组），反查表少列任何一个，常态就会整片落 `unknown` 饿死 A 档 feat。
   真机常态实测是 `202`——开了新地形的服上 `world(1)` 不会成为实际值。
9. **不要在本文件里写游戏符号名**：所有原始判据必须经 `worldSignals`，否则 ACL 白名单机制失效。

---

## 7. 调试面

```js
pocketcc.worldState.dump(); // 现采 + 打印完整快照（含 raw 四路原值）
pocketcc.worldState.kind(); // 'homeland' | 'wushuang' | 'kvk_c8' | ...
pocketcc.worldState.current(); // 上一帧缓存（不重算）
pocketcc.worldSignals.mapTypeName(); // 原始 mapType 名，核对 §2.2 双态
pocketcc.worldSignals.crossLogin(); // 跨服登录态（ServerId ≠ OriginServerId；盟决/换服重连）
pocketcc.worldSignals.crossType(); // 登录包形态号：7=盟决，-1/0=非跨服登录
pocketcc.worldSignals.tmServerType(); // 5=TM 6=Master 8=TeamLegend 9=征服者/CQ25
pocketcc.worldSignals.cross.anyServer(); // 官方 isInAnyServer() 同义，交叉验证
```

日志（tag=WORLD / SCENE）：

```
[WORLD] world: homeland/base (none phase=normal) reason=maptype-world_NTerrain_border   // 真机：Home
[WORLD] world: homeland/world (none phase=normal) reason=maptype-world_NTerrain_border  // 真机：本区世界
[WORLD] world: wushuang/world (tm phase=normal watching) reason=cross-predicate         // 预期形态，尚未回样
[WORLD] dump {"kind":"pab",...,"watching":false,"crossMap":true,"reason":"watching-pab",
        "raw":{"mapType":9,"mapTypeName":"pab","watchingType":3,"watchingTypeName":"PAB",
               "eightServerType":2,"cross":{"anyServer":true,"cabMap":false}}}
[SCENE] scene: NWorldMap
```

`homeland` 常态的 `reason` 一定是 `maptype-*` 而不是 `cross-*`（谓词全 false 才会落到反查），
看到 `homeland + cross-*` 就是漂移信号。真机三档 dump（Home / 本区世界 / 异能秘境）里
`eightServerType` 恒为 `2`：它是登录报文的 `server_type` 原值，不在 `judgeKVK` 的 8/4/6 三形态内
⇒ 三个 kvk 谓词均为 false，归类不受干扰（这也是为何比较折算值而非「位是否非零」）。

跨验证口径：`dump()` 里 `raw.cross.*` 与 `raw.mapTypeName` 若互相矛盾，以
`reason` 指示的路径为准——两者本就可不同时为真（赛季开着但人回了原战区：形态位真、`mapType=world`）。

---

## 8. 变更记录

| 日期       | 变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-10 | 首版。Kind 由草案的 13 值收敛为 10 值：`ava/tm` 合并为 `wushuang`（字典证明四代实现同叫无双峡谷）、`legend` 降为 Gen、`thunder` 降为 Gen；新增 `crossMap` 双口径与 `sceneSemantic()` 语义键；`scene-watcher.js` 重写为事件驱动 + 2s 兜底，注册 `world` 门控（未声明 `kinds` 一律放行 ⇒ P1/P2 零行为变更）。同日订正「双子星/无双」命名错误，并纠正「无双峡谷城留在原图」的机制描述（详见可行性报告 §2.1/§2.3）。                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-10 | 真机首次 dump（异能秘境）后订正：`watching` 排除 PAB——`watchingType` 是世界接管位而非观战位，打秘境时也等于 3，旧口径（非 0 即观战）会把整段秘境期误报成观战。同类：actionable() 注释不再断言秘境「城不在场」。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-10-11 | 对照组两档回样（本区 Home / 本区世界）全部落对：`kind=homeland`、`place=base/world`、`crossMap=false`。新记两条事实：常态 `mapType` 实测 202（setter 就地折算），`eightServerType=2`是报文`server_type` 原值而非残留位；§6 据此补第 8 条坑。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-10-11 | P3 第 1 刀落地：24 个 A 档 feat 加 `kinds:['homeland']`（含本来无 `scenes` 的 `allianceGift`/`allianceHelp`/`globalMap`），`scenes` 全部保留 ⇒ 进峡谷/天梯/秘境图时这 24 个走 pause，回本服图自动 resume 并补扫。另订正一处统计口径：34 个功能力里只有 29 个是 reactor feat，其余 5 个（closePopup/openBag/sceneToggle/battlePanelHotkeys/flyHome）是 `core/hotkeys.js` 的 `bind()` 热键，**不经 reactor 门控**——它们接 Place/Kind 需先改 hotkeys 本体（第 3 刀）。                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-10-11 | P3 第 2 刀落地：`autoDefense` 进 B 档（`kinds:['homeland','wushuang','kvk','adp_war']`，刻意不含 pab/cnc/cnc25 ⇒ 进秘境/征服者时整个 feat pause，回图自动 resume），并在 `strategyShield` 开头接 §4.3 那两道降级闸（②③④ 不降级）。附带把 `core/defense.js` 的两处游戏符号口径换成本层：`gameData.isKVK()` → `matchesKind(['kvk'])`、`serverStateIsFight()` → `phase()!=='fight'`（取证：`GameTools.isKVK`@34412 三支全走 `judgeKVK(eightServerType)`，与 `CrossUtils`@1651 同名谓词同源 ⇒ 语义不变）；`game-api.js` 里那个把 `isKVK()` 说成「判跨服战场图」的注释同步订正为形态位。                                                                                                                                                                                                                                                                                      |
| 2026-10-11 | P3 第 3 刀落地：本层新增 `matchesPlace()` 纯判据（`scene-watcher` 的 world 门改为复用，不再内联）；`core/hotkeys.js` 接上本层，`bind()` 新支持 `kinds`/`places`（与 scenes 取交集，拿不到世界态时退回旧口径）。声明侧：C 档的 `closePopup`/`openBag`/`sceneToggle`（热键）与 `chatWindow`（reactor）只加 `places`（不看 Kind），B 档的 `flyHome` 加 `kinds`（排掉 pab）——详见 §4.6。`battlePanelHotkeys`/`secretRealm` 保持 D 档不动。                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-28 | 盟决换服重连归类修复（真机 dump：敌对战服 4397 内 `ServerId=4397`/`OriginServerId=4402`/`crossType=7`/`mapType=202`，旧逻辑误报 `kind:homeland`/`crossMap:false`）。`worldSignals` 新增 `serverId`/`originServerId`/`crossLogin`/`crossType` 四路信号；`kindOf()` 新增第 ⑥ 步跨服登录态分支（`crossType=7`→`adp_war`，其余形态号→`unknown` 保守档）；`crossMap` 加 `crossLogin` 兜底。真机回归样本进 `tests/core/world-cross-login.test.js`。§2.2/§2.3/§6/§7 同步。 |
| 2026-10-11 | P3 第 4 刀落地：①`quickAttack`/`imperialDecree` 补 B 档 `kinds:['homeland','wushuang','kvk']`（真收窄：盟决不再触发）；②`pab-watcher` 并入世界态——删 `core/pab-watcher.js`（1s 轮询+`pab` 门+`pab.change`），秘境检测改由 `world-state` 的 `kind===pab`（scene-watcher 事件+2s 兜底）承担，其默认全拦折进 `scene-watcher` 的 world 门（`kind===pab` 只放行 `kinds` 含 `'pab'`），`secretRealm` 声明 `kinds:['pab']`；`reactor.js` 摘掉 `scene.change`/`pab.change` 两条 recompute 订阅；③`scenes` 声明退役：全部 reactor feat 的 `scenes` 等价迁移为 `places`（Home→base、NWorldMap→world），`scene-watcher` 删 `scene` 门，`hotkeys.js` 的 5 个 `bind()` 仍留 `scenes`；④`launchSilo` 经静态复核发现两个「发射井」概念（天梯核心建筑 vs 每周二联盟活动）、本 feat 属后者且图属 kind 静态不可判 ⇒ 保持 `kinds:['homeland']` 未升 B，待真机 `dump()`。§1/§3.3/§4.1 同步。 |
| 2026-10-11 | 第 4 刀审查回改：①world 门秘境分支补上 `matchesPlace`（此前 `kind===pab` 时 places 被单方面短路，与「kinds×places 是与关系」契约不符）；②确认不声明 kinds 的 feat 在秘境被拦（默认全拦的副作用），§4.6 补秘境例外口径、`chatWindow` 注释同步；③三个热键 C 档的 `places` 去掉与 `scenes` 不等价的 `base_other`（scenes 仍是必要条件，多给部分是死声明）；④secret-realm 拍宠物引擎 `stop()` 补引擎存活位 `#active`（cycle 睡眠期的定时器不会被撤，只清引用拦不住 pause→resume 后的孤儿循环）。                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-11-26 | 快捷战斗扩基地：`quickAttack` `places:['world']` → `['base','world']`（基地内卡片不置灰、基地里打开目标面板同样可用；世界地图面板类晚加载由 run 期 5s 重试补齐，挂满即停）。`battlePanelHotkeys` 热键 `scenes` 增 `Home`（现为 `['NWorldMap','Home']`），路径改为从场景根直挂 `UICanvas/PopLayer/NBattleMain/ui/BattlePanel`（UICanvas 为 UIManager 持久根节点，Home/NWorldMap 同构），基地内排兵（上卡车/出征）的 1-8/G 生效。 |
