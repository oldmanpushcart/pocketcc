# core/item.js —— 物品查询/标识工具层

> 源码：`src/core/item.js`。定位是**薄工具层**（query/identify），不是协议聚合层。

## 1. 职责与边界

**管什么**——把各 feat 对「物品」的零散**查询与标识**收口，消除重复并根治命名空间混淆：

- `amount(itemId)`：背包持有量的唯一入口（带 guard，读不到回 0）。
- `label(itemId, rawName?)`：itemId → 中文展示名，三级回退。
- `fromReward(rewardId)`：奖励配置 id → 主道具 `{itemId, rawName}`。
- `sortResolve(itemId)`：面板 `sortlist` 字段的 resolve 复用件。
- `ITEM_NAMES`：itemId → 中文名静态登记表。

**明确不管**：

- **「使用/消耗物品」不聚合**。各 feat 扣道具是专属服务器契约（920 加速 / 1139 联盟帮助申请 / 机甲捐赠 / 1826 遗迹领取…），语义互不相干，强行统一会退化成 `if-cmd` 大杂烩。发送动词留在各 feat，或像加速那样就近放协议模块（`march.js` 的 `ITEM_SPEED_UP_NORMAL/ADVANCED`）。
- **业务候选池留在 feat**：`L2_ITEM_POOL`（遗迹）、`TRUCK_ITEM_POOL`（卡车）是「这个玩法关心哪些物品」的业务门，不进本模块。
- **协议耦合的 itemId 常量留在原模块**：520001/520002（march）、3200001（boss）等发协议就近常量不归本模块登记。

**对外契约**：全部纯读、同步、永不抛异常；无加载期副作用（不订阅 bus、不发包）。

## 2. 设计思路与取舍

**核心动机——命名空间三态铁律**（教训：道具标识符混淆陷阱）：TopWar 里 `loc 键 ≠ itemId ≠ 中文显示名` 是三个不同命名空间。最致命的是 `RewardController.Instance.getRewardsArrById(id)[0].name` 返回的是**未翻译 loc 键**（如 `"107068"` / `"item_name3300001"`），既不是中文、也不自动等于 itemId。实证：大体力药剂 itemId=600002，而其 `rewardItems().name` 与字典键都是 107068。遗迹 feat 早期把池写成中文名、按 `items[0].name` 匹配 → 永不命中。

本模块把这条铁律固化进 API：

- **匹配一律走 `.id`**：`fromReward()` 只暴露真实 `itemId`（number），不把 `.name` 当身份。
- **展示才翻译**：`label()` 内部才对 loc 键过一道 `l10n.text`。

**取舍：为什么不抽「使用物品」**——见 §1。march.js 能抽象是因为行军有一条**通用线协议**（856/902/904/920 是行军的通用读写）；物品没有这种通用「使用」协议，只有各玩法专属的消耗契约，故本模块刻意只做查询/标识这半边，保持薄。

**取舍：为什么 `ITEM_NAMES` 集中而池不集中**——itemId→中文名是**全局命名空间**（同一 itemId 在任何玩法显示同名），集中登记无歧义、且补上了此前 truck 缺的 `l10n` 翻译兜底通道；而「哪些 itemId 属于本玩法候选」是**业务语义**，随玩法不同，留在 feat。二者分开，既消重复又不越界。

**被否决的备选**：把「使用物品」也塞进 item.js（→ 大杂烩，违反单一职责，否决）；把 boss/march 的协议常量也迁进来（→ 削弱协议就近自治、引入 item→各 feat 反向依赖，否决）。

## 3. API 契约

| 方法 | 签名 | 返回 | 语义 |
|---|---|---|---|
| `amount` | `(itemId: number\|string) → number` | 持有数量 | 委托 `gameData.itemAmount`（try/catch + Number 强转），数据源/方法不可用回 0 |
| `label` | `(itemId, rawName?) → string` | 中文展示名 | 三级回退：`ITEM_NAMES[id]` → `l10n.text(rawName)`（翻译 loc 键）→ `'道具 ' + id`；永不抛 |
| `fromReward` | `(rewardId) → {itemId:number, rawName:string}` | 主道具身份 | 封装 `gameData.rewardItems(rewardId)[0]`：`itemId=Number(it.id)||0`、`rawName=String(it.name)`（未翻译 loc 键）；解析失败回 `{itemId:0, rawName:''}` |
| `sortResolve` | `(itemId) → [{id,name}] \| null` | 面板选项 | `ITEM_NAMES` 有登记则回 `[{id,name}]`，否则回 null（面板据此不展示该项） |
| `ITEM_NAMES` | `Object<number,string>` | 登记表 | itemId→中文名，供 label/sortResolve 查 |

## 4. 场景用法

**遗迹领取（奖励配置 id → 真实 itemId + 展示名）**：
```js
for (var si = 0; si < select.length; si++) {
    var r = item.fromReward(select[si]);          // select[si] 是奖励配置 id
    if (!r.itemId) { /* 池外/解析失败，不领 */ continue; }
    selectNames.push(item.label(r.itemId, r.rawName));  // 匹配用 .itemId，展示才 label
}
```

**卡车拦截（候选展示名）**：`itemName: item.label(m.itemId)`（truck 的 itemId 直接来自 loot，无需 fromReward）。

**背包判定是否够捐**：`var have = item.amount(ITEM_SHARD); if (have < plan) 放弃本轮;`。

**面板 sortlist 字段**：`{ key:'order', type:'sortlist', resolve: item.sortResolve }`（relic/truck 共用，替代各自复制的 resolve 闭包）。

## 5. 数据流与降级

```
rewardId ──fromReward──▶ gameData.rewardItems ──▶ RewardController.Instance.getRewardsArrById ─▶ items[0]
itemId   ──amount──────▶ gameData.itemAmount  ──▶ UserData.getItemAmount
itemId   ──label───────▶ ITEM_NAMES 命中 ─▶ 中文
                          └ 未命中 ─▶ l10n.text(rawName 命中) ─▶ 中文
                                       └ 仍无 ─▶ '道具 <id>'
```

降级全为「读不到即回退默认」：符号缺失时 `amount`→0、`fromReward`→itemId 0、`label`→`'道具 <id>'`，绝不抛，调用方据哨兵值（0/空）自行决定「池外不领」等。

## 6. 坑与边界

- **别拿 `fromReward().rawName` 当身份**：它是 loc 键，匹配必须用 `.itemId`。rawName 只是喂 `label()` 的兜底翻译输入。
- **`ITEM_NAMES` 未登记 ≠ 物品不存在**：`label()` 会走 l10n/占位兜底；但 `sortResolve()` 严格——未登记返回 null（面板不列该项）。新池物品要在 feat 池 + 视需要补登记。
- **函数内局部变量勿命名为 `item`**：会与模块导入 `item` 冲突（alliance-help 的 `getItemAmount` 形参已从 `item` 改名 `it` 以避免遮蔽）。
- **`amount` 走的是 `gameData.itemAmount` 的 UserData**，与游戏面板 `getItemAmount(reward_param)` 同源口径（联盟帮助对齐 AllianceHelpSelectPanel_New）。

## 7. 调试面

控制台直读登记表与解析：
```js
pocketcc 环境内：item.amount(3200001)      // 碎片持有
                item.label(1600029)         // '职业道具自选宝箱'
                item.fromReward(8301745)    // {itemId, rawName}
```
离线批量取真实 itemId/名称：`tools/relic-table-dump.devtools.js` / `tools/relic-pool-probe.devtools.js`（DevTools 直读运行时内存表，登录即可读，无需发包）。

## 8. 变更记录

- **2026-10-05 初版**：新建 `core/item.js`（amount/label/fromReward/sortResolve + ITEM_NAMES 登记表）。迁移 4 个 feat：relic-reward（删本地 ITEM_LABELS+itemLabel，rewardItems 解析走 fromReward）、truck-intercept（删 ITEM_LABELS，itemName 走 label、补上此前缺的 l10n 兜底）、alliance-help（裸 `data.UserData.getItemAmount` 收编进 `item.amount`，修无 try/catch 的崩点 + 形参 `item`→`it` 去遮蔽）、alliance-boss（`gameData.itemAmount(ITEM_SHARD)`→`item.amount`，ITEM_SHARD 留作协议就近常量）。构建通过（content.js 850.7kb）。「使用物品」明确不纳入本模块。
