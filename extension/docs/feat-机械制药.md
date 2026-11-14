# feat · 机械制药（`potionCraft`）

> 代码：`extension/src/feats/player/potion-craft/index.js` · 面板：玩家 → 机械制药 · 形态：`createCycle` 电平调和 + 每拍全量重读（与 `armory-material` 同族）

只做**制药 lane**（`traps_and_potions` 那条单槽队列）：**一次只做一个药水**——面板单选一个目标（`formula`，0=未选），
排产前先把「职业 / 科技 / 材料」三道限制过一次，不过就原地等，**绝不擅自换配方**。运行时态一律不落盘：1387 应答恒含 `{making, unlock}`，
重启免费、状态可从服务器应答完全重建。

---

## 1. 协议清单

全部走 `net.sendGuarded` 的**旧 JSON 通道**（`protocol` 缺省 `send`），`ret.data` 是原始 JSON 串、需 `parseData` 自解。
报文实证：机械制药真人实录。

| cmd   | 名称                         | 载荷              | 应答（实测）                                                                          | 本 feat                       |
| ----- | ---------------------------- | ----------------- | ------------------------------------------------------------------------------------- | ----------------------------- |
| 1387  | `getStrengthenMakingData`    | `{}`              | `{making:{st,id,state,et}, unlock:[10003,…,90001,11001]}`；空闲时 `making` 四字段全 0 | **唯一权威读**，每拍先发      |
| 1388  | `MAKE_FORMULA`               | `{id:90001}`      | `{making:{st:1794046716,id:90001,state:0,et:1794219516}}`（`et-st`=172800s=48h）      | 排产                          |
| 1397  | `ProductionReward`           | `{type:1}`        | —                                                                                     | 到期领取（**推断项**，见 §5） |
| 10722 | push `FORMULA_MAKE_COMPLETE` | `{op:2,id:90001}` | —                                                                                     | 只当唤醒提示，载荷不入状态    |
| 1389  | `SPEED_UP_FORMULA`           | `{}`              | `rewardResults.items=[{itemId:1600041,itemCount:1}]`（加速即发货）                    | **登记不接线**                |
| 1390  | `CANCEL_FORMULA`             | `{}`              | —                                                                                     | **登记不接线**                |

源码锚点：`RequestId`（协议号）、`ProductingData`（判据）、`subpack2/ProductionFactoryPanelNew`（写动作形态）、
`subpack2/PushResponse.Push_FORMULA_MAKE_COMPLETE`（推送分支）、`subpack/CommonTools.getProductionFactoryData`（读通道）。

### 1389 钻石加速（本轮刻意不做）

- 成本：`GameTimeTools.getProfessionCDGold(剩余秒)` = `Math.max(1, Math.ceil(剩余秒/60 × DATACONFIG 61017))`；
  余额口径 `UserData.Resource.Gold`（不足时游戏弹 tips `100130`）。
- 副作用：`SPEED_UP_FORMULA` 应答直接把产物发下来（`ProductComplete(0,0,isPotion)` 清队列），**不需要** 1397。
- 将来要接：在 `cycleRun` 排产分支后加一个 `speedUp()` 分支 + 三重限额（钻石余额 / 每日次数 / 单配方上限），
  主体状态机不动。本 feat 明确**零钻石消耗**。

---

## 2. 状态机（五态判据）

镜像 `ProductingData`：`Producting = id>0 && et>0`；`State === 1` = 完成待领取。

| 态         | 判据                                          | 动作                                                      | 睡                                                         |
| ---------- | --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| 无从判定   | 1387 抛错 / `code≠0` / 应答无 `making` 对象   | **本轮不发任何写动作**                                    | `idlePollMs`（10min）                                      |
| 待领取     | `state === 1`                                 | 发 `1397 {type:1}`                                        | 成功 → 0（立刻再跑一轮去排产）；被拒 → 拉黑 + `idlePollMs` |
| 到期未结算 | `id>0 && et>0 && et<=ServerTime && state===0` | 先**重读一次** 1387；复读仍是这副样子才试 `1397` **一次** | 同上，被拒不循环                                           |
| 空闲       | `!(id>0 && et>0)`                             | `checkTarget()` 过闸 → `1388 {id}`                        | 受理 → 按应答 `et` 择时；不可作/被拒 → `idlePollMs`        |
| 在产       | `id>0 && et>0 && et>ServerTime`               | 不动                                                      | `(et-now)*1000 + DUE_BUFFER_MS`                            |

> `createCycle` 内部 `MAX_ARM_MS = 24h` 硬顶会把 48h 队列截成「24h 醒一次再算」——属既有行为，醒后重走「在产」分支即可，
> 看门狗保证不漏醒，无需绕过。

### 内置常量（不作面板项）

| 名                    | 值    | 用途                                                   |
| --------------------- | ----- | ------------------------------------------------------ |
| `IDLE_POLL_MS`        | 10min | 缺料 / 被拒 / 读失败的兜底复查                         |
| `DUE_BUFFER_MS`       | 5s    | 睡到 `et` 后的抖动余量                                 |
| `MIN_WAKE_MS`         | 3s    | 下拍唤醒下限（到期判据抖动时防紧循环）                 |
| `TRANSIENT_RETRY_MS`  | 20s   | `CODE_NOT_SENT`（在途频控/发送超时）短重试，**不拉黑** |
| `POTION_PRODUCT_TYPE` | 1     | 1397 的 `type`，制药 lane 源码硬置                     |

整功能闸：`gameData.functionOn('ProductFactory')`（`GameDefine.FunctionKey.ProductFactory` = 值串 `manufacture_system`），
关则整轮零发包、只按 `IDLE_POLL_MS` 复查。

---

## 3. 可制作判据（`checkTarget`，排产前逐条过）

只看用户**单选**的那一个目标（`MCFG.formula`），四闸依序；任一不过即 `ok=false`，**本轮不发 1388 也不改做别的配方**
（缺料就原地等资源补齐或用户改选；换配方会花掉用户没打算花的材料）。拒因带完整明细进 debug 日志
（`resId/itemId`、`need`、`have`、职业名），保证「为什么没动」单轨可还原。

| 拒因         | 判据                                   | 语义                                                             |
| ------------ | -------------------------------------- | ---------------------------------------------------------------- |
| `profession` | `unlock` 为空                          | **职业限制**：非机械大师 / 一点制药天赋都没点，整条制药线未开    |
| `unselected` | 面板目标 = 0                           | 用户还没选（候选清单已不等 1387，见 §4）                         |
| `locked`     | 目标 ∉ `unlock`                        | **科技限制**：选了个服务器不认的 id（改配置/天赋重置），带职业名 |
| `row`        | 配方行读不到                           | 配置表不可用（表已就绪时首遇 warn 一次）                         |
| `resource`   | `resources` 首段 `resId\|count` 不够   | **材料限制**（资源）                                             |
| `item`       | `needItem` 任一段 `itemId\|count` 不够 | **材料限制**（道具）                                             |

### 职业闸为什么用 `unlock` 为空（而不是反查职业 id）

源码实证（`ProductingData.checkPotionUnlock` + `ProductItem.UpdateItem`）：

- 客户端判「这个药水能不能做」**只看服务器 `unlock` 数组**（职业与制药天赋的解锁结果全由服务器算好放进去），
  根本不查职业；面板的 `LockNode`/`UnlockTips` 也只拿 `ENDOWMENT_V2`（`formula==1 && para1==配方 id`）反查一行
  `career_name` 拼「需要职业 X」的**文案**。
- 因此本 feat 不硬编码职业 id（`ProfessionId` 与 `SELECTION_V2` 分支同数值、多天赋位并存，反查易误伤），
  也不在客户端拦「非机械大师」：`unlock` 为空已经是不排产的充分条件，服务器才是裁决。
- `career_name` 只用来把 `locked` 拒因写成可读信息（`talentCareer()`，取不到回空串，不影响判据）。

### 三闸细则

1. `id ∈ unlock` —— 解锁由服务器 `unlock` 数组下发，feat 不自行反查天赋做拦截。
2. `resources` **首段** `resId|count` 够 —— 走 ACL 原语 `gameData.resourceAmount(resId)`（`Resource.getResource`）。
   **三态纪律**：读不到（`null`）按**放行**处理，把「读不到」当缺料会永久跳过有效配方；最终以服务器拒绝为裁决。
3. `needItem` 每段 `itemId|count` 够 —— 走 `gameData.itemAmount(itemId)`。

> **与游戏原函数的一处刻意差异**：`checkItemCanMake` 对 `needItem` 里的形态不符段（含整列空串，`''.split(',')` 得到 `['']`）
> 直接 `return false`，即「永不可做」。那是**红点闸**口径；面板真正的起跑闸是 `checkProductMaterialItemEnough`（跳过形态不符段）。
> 本 feat 取起跑闸口径——照红点闸实现的话，`needItem` 为空的行会被一起判死、整个 feat 静默躺平。
> `resources` 段形态不符同样只跳过、不拦。

---

## 4. `ProductingData` 镜像语义与「不订阅」清单

push 10722 → `ProductComplete(op, state, isPotion=true)`：

- `op === 1` → `UpdateState(state)`（置完成标志）
- `op !== 1`（实测 `op=2`）→ `UpdateData(null, potion)`（**清空制药队列**）

本 feat **不解析推送载荷入状态**，只 `cycle.kick()`（level-triggered：丢推送由 `et` 定时醒兜底）。
同理**不订阅 10001/10401**（资源/道具 push 高频），材料不足时靠 `IDLE_POLL_MS` 轮询足够，避免 hot path 噪声。

面板选项与标签用模块内 `lastUnlock` 缓存（每拍由 1387 的非空 `unlock` 刷新），它**不是真相源**：`formulaOptions(cfg)` 固定以
`{value:0, label:'未选择（只领已完成的，不排产）'}` 开头（与 `defaults.formula=0` 同形），其后是候选配方；若**存档目标不在候选里**
（天赋重置/换服），末尾再补一项，以免下拉显示的默认项与实际存档值不一致（实际行为仍由引擎按 `locked` 拒因上报）。
「（缺料）」标记**只对 `resource` 缺口打**：道具侧 `gameData.itemAmount` 无三态（数据源不可用与真的一个没有同形回 0），
首屏未就绪时照样标记会全线假阳性。

### 清单数据源（面板首开不能是空的，但也不猜档位）

「选一个制药目标」是**启动本功能的前提**，所以清单不能只等本功能自己发出的那一发 1387（功能未启用时永不发包）。
三个来源按权威性递降，**都只列真解锁列表**：

1. `lastUnlock`：本 feat 读过的 1387 `unlock`（服务器权威）。最准，但要等本功能跑过一轮。
2. `gameData.potionUnlockList()`：游戏本地缓存 `UserData.ProductingData.getProductData(true).UnlockList`，**零发包**。
   源码实证 `CommonTools.getProductionFactoryData()` 只挂在工厂面板的 `onShow` 上，所以这一项仅在
   「玩家本场开过游戏内工厂面板」时有值；空数组不等于「未解锁任何配方」。
3. 两者都空 → 下拉只出首项 + 一条提示项，由面板上的 **「↻ 读取可生产清单」按钮**（`type:'button'`）显式触发
   `probeUnlockForPanel()`：懒取全局 `netApi` 发一发 1387 只读，应答到手写 `lastUnlock` 并广播重建本卡。
   与 truck-intercept 的 `probeForPanel` 同口径：**发包挂在用户动作上，不挂在 `options` 求值链上**——
   `buildPanelHTML()` 在 `mountUI()`（主城就绪）就执行一次，自动探测等于每个页面会话无条件发一发 1387，
   即使玩家从未开面板、从未启用本功能（`enabled` 默认 false）。
   重试语义：`probeInFlight` 只防连点，发完即复位，失败可再点；**不把「试过一次」当「试成功」**。
   引擎在跑（`aliveFn()`）时按钮直接返回不另开一枪：同 cmd 互撞 `CODE_NOT_SENT` 只会双双空转，
   清单本就由循环的 `fetchQueue` + `adopt` 负着。

> **为何去掉了「现扫配方表取 `level==1` 基线行」那一路**：字典实证 `trapName_10001/10002/10003` = 「等级1/2/3 强化机油」，
> 而实录里该玩家解锁的是 `10003`。拿基线行造候选会同时踩两个噪声：① 把已升到等级3 的药说成等级1（满屏无效档位）；
> ② 该 id 必然不在服务器 unlock 里，排产时被 `locked` 拒掉——白列。等一次真读数比猜更便宜。
>
> 标签去重：`joinFormulaLabel(配方名, 产物名)` —— 字典里 `trapName_90001` 与 `item_name1600041` 都是「等级1腐蚀粘液」，
> 旧拼法 `A · A` 等于把同名写两遍（面板宽下被截成「等级1腐蚀粘液 · 等…」）。判定取**单向包含**（产物名 ⊆ 配方名
> 才说明它没新信息），包含前先剥掉尾部的数量段（`×2` 之类），否则同名会换个形态复现。

> **两种空态分开写**（`buildFormulaOptions` 的 `knownEmpty` 入参）：「还没读到清单」提示去点按钮；「服务器回了
> `unlock:[]`」写明「当前无可生产配方（非机械大师或未点制药天赋）」。把前者当成后者就是把「无从判定」当否定结论。

> `type:'select'` 的选项只在面板 HTML 装配那一次求值（`openPanel/closePanel` 只翻 `hidden`），故首批 `unlock` 到手时
> （无论来自 `adopt()` 还是面板探测）经 `bus.emit(EVT.UI_REFRESH, { rebuild: 'potionCraft' })` 广播重建这张卡；
> 面板关着时由 `core/ui/index.js` 的 `pendingRebuild` 记账，开面板时补渲染。重建在焦点位于卡内时会被
> `rerenderFeatureCard` 自己跳过，故 `pokePanel()` 不设 once（调用方只有上述两处，都是低频动作）。

---

## 5. 待补录 / 风险

1. **自然到期怎么领是推断项（头号）**：`1397 {type:1}` 全部来自源码，实录里一次都没出现（那场真人实录全程钻石加速，
   加速响应直接把 `items` 发下来了）。需补录一场「等到队列自然到期 → 手动点领取」，确认到期时服务器是
   推 `10722 {op:1,state:1}` 等领取，还是**自动入包无需 1397**。若为后者，状态机「待领取/到期未结算」两支整段简化掉即可，
   其余不变。现设计已是安全形态：只以「自己读到的 1387 `state===1`」为发 1397 的前件，被拒即页内拉黑
   （读到 `id`/`state` 变化自动解除），绝不循环重试。
2. **`type:1` 的 lane 二义**：源码里制药 lane 的 `ProductType` 被硬置 1，而制造 lane 的行也可能 `type===1`。
   本 feat 只用自己读的 1387 `state===1` 作前件，**绝不调 `getProductingData()` 合并视图**（它会优先返回制药、把两条 lane 混起来）。
3. **`results` 形态**未离线取证（表数据在服务器下发侧），按「数字 item id」实现，并对 `'id|count'` 串做首段容错。
4. **制造 lane**（`1398/1399/1600/1396/1612`，`manufacture` 表，5 槽 + `ProductionBatch` 批量）明确不在本轮，
   留 P1：复用同一 feat 结构另开文件，两套状态机互不干涉。

---

## 6. 日志分级

| 级    | 场景                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| warn  | 1387 读被拒/抛错、应答无 `making` 对象、发包抛错、表已就绪却读不到配方行（首遇一次，拒因不再是 `row` 即复位）                                                                                                                               |
| info  | `installed.` / `started.` / `make started`（带 `id`/`st`/`et`）/ `claim ok` / 服务器可预期拒绝（必带 `code` + `rejectText`）                                                                                                                |
| debug | 目标不可作（`profession`/`unselected`/`locked`/缺料，均带拒因明细）、闸门未过（功能位关 / `claimBlocked`）、`CODE_NOT_SENT` 未发出（读写两侧同口径：瞬态短重试、不拉黑）、拉黑解除、`next check` 行（由 cycle 驱动器统一打，feat 不重复打） |

---

## 7. 验收

- 门禁：`npm run arch` → `npm run build` → `npm run lint` → `npm run test` 四绿。
- 单测：`tests/feats/potion-craft.test.js`（只测导出的纯函数 `readQueue` / `isExpired` / `nextDelayMs` / `checkTarget` /
  `joinFormulaLabel` / `buildFormulaOptions`，不触网）。
- 真机首开：面板先把「制药目标」选成一个具体配方（不选 = 只领不排产），再看一行
  `make started. id=…;et=…` 与 next check 时刻是否等于 `et + 5s`，确认择时无误后再长期开启。
