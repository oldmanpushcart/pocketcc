# feat · CQ26 霜之密所抢购（`cq26Shop`）

> 代码：`extension/src/feats/cq26/shop.js` · ACL：`core/acl/game-data.js`（`cq26ShopRows`）
> 面板：CQ26 印石 → 霜之密所抢购 · 形态：push 贴脸 burst + `createCycle` 轮询兜底，**唯一写动作 2444**

只做一件事：中立城城主宣布开市那一刻，替玩家把货架上还能买的、自己还想买的东西**成批下单**。
全 feat 出网四条：`2444` 买（写）、`2442` 全量快照、`2443` 单所补查、`2441` 领红包。不改游戏数据、不派兵、不开市、不发红包。

报文实证：印石日常真人实录（四个 status=1 所 + 两次开市 push + 多份 2442 快照）。
**2444/2441 在该场实录与全部真人录制库里零命中**（用户从未成功购买），故写动作的应答形态只有消费侧源码级证据，无报文级证据 —— 见 §7。

---

## 1. 身份确认（三个同名候选里为什么是它）

「霜之密所」= **CQ26 中立城商店（CNC Shop / Mystery Shop）**，不是 `SERIES_FROST_SHOP_*`(2169/2170，捐赠/战功双页签的密宝商店)，也不是 `SERIES_FROST_SECRET_*`(2471+，组队开车族)。三条独立证据：

1. `Script/ConquerorSession.initReplaceMap()`：CQ26 开启时把整套 `CQ2025_CNC_SHOP_*` 协议号替换为 `SERIES_FROST_NEUTRAL_CITY_SHOP_*`，表名 `conqueror_2025_cnc_shop` → `series_frost_cnc_shop`。**UI 与逻辑完全复用 CQ25，只换号换表**。
2. `CQ25CNCShopCityComp` 的入口常量是 `FakeActivityId.CQ25MysteryShop / CQ26MysteryShop`（Mystery Shop = 密所）。
3. 竞品 A `server-js.js` 里该模块中文名 `'cncShop': { text: "印石密所" }`。

`cnc_city_level`（城档表）**两期共用、不在替换表里** ⇒ feat 现查它拿档位高低。

---

## 2. 协议清单

| cmd   | 名称                        | 方向     | 载荷 / 应答（实证 or 推断）                                                     | 本 feat                                                |
| ----- | --------------------------- | -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 22030 | `…_SHOP_ICON`               | push     | `{type:1\|2, id:Int64}`；type=1 开市、type=2 红包                               | **主触发**（该商店族唯一 push；11/7 实录 4 条，见 §4） |
| 2442  | `SHOP_GET_INFO`             | req      | `{}`                                                                            | 快照轮询（兜底 + burst 前导）                          |
| 2442  |                             | resp     | `{shop:[…], cScore, endSec, canBuyCnt}`（线上字段名是 **`shop`** 不是 `shops`） | mirror 真源                                            |
| 2443  | `SHOP_GET_SINGLE_INFO`      | req      | `{id:Int64}`                                                                    | 状态到期/领红包后补查                                  |
| 2443  |                             | resp     | `{info:{id,status,statusEndSec,buyCnt,tax,canRevRedPack}, playerInfo}`          | `canRevRedPack` 唯一权威来源                           |
| 2444  | `SHOP_BUY`                  | req      | `{id:Int64, cfgId:number, cnt:1}`                                               | **唯一写动作**                                         |
| 2444  |                             | resp     | `{canBuyCnt, selfBuyCnt, buyCnt, tax}`（**消费侧源码实证**，见 §3.3）           | 整表回写 mirror                                        |
| 2441  | `SHOP_VIEW_OR_GET_RED_PACK` | req/resp | `{id:Int64, get:bool}` → `{info:{record:[{uid,…}],…}}`                          | `get:true` 领红包（顺带）                              |
| 2445  | `SHOP_OPEN`                 | req      | `{id:Int64}`                                                                    | **登记不接线**（需 `hasAuthority(DECLARE)`）           |
| 2446  | `SHOP_SEND_RED_PACK`        | req      | —                                                                               | **登记不接线**（城主动作）                             |
| 2447  | `SHOP_BUY_RECORD`           | req      | —                                                                               | **登记不接线**（流水面板专用）                         |

---

## 3. 玩法还原（判据逐条带出处）

### 3.1 数据形态与货架真源

一个 shop：`{id:{_low,_high,_unsigned}, cityId:140094, cityLevelId:403|404, cityShowNum:3001..4001, sid,
playerInfo:"JSON 串", alTag:"304%", status, statusEndSec, buyCnt:{cfgId:已售数}, tax, opened, selfBuyCnt:{}}`

- **密所 id 为 19 位（实测如 `4918151952583191043`，≈ 4.9e18）> 2^53** ⇒ 全程字符串往返（`idStr()` 双路兜底：Long 实例走 `bits.int64Str`，裸 `{_low,_high}` POJO 回落 `bits.int64Decimal`），禁 `Number()`；排序用十进制串比较 `cmpIdStr()`，等价游戏 `Int64.compare`。
- **货架真源 = `Object.keys(shop.buyCnt)`**，出处 `CQ25CNCShopMainNode.updateItemListUI` 原式：拿 `buyCnt` 的 key 去 `getTableDataById(表, String(k))`，再按 `.order` 排序。**不是**按档位枚举整表。
- 实测每所恰 **9 件**；cfg 空间 = **1–11**（普通城 cityShowNum 3001–3006）/ **101–111**（高级城 4001），每所从所属档位随机缺 1–2 件 ⇒ 静态 `CFG_CATALOG` 只作面板保底，候选仍按 `buyCnt` 键集裁（「运行期枚举返回空」是踩过的坑）。
- 每 cfg `buy_limit_all = 40`（全服共享库存），`tax` 随已售增长（实录 25872 / 25920 / 122400）。

### 3.2 状态机与「开市时刻」——为什么只能贴脸

`status`：1 待开市 → 2 营业中（唯一可买）→ 3 税收/红包期 → 4 结算。可买性判据出处 `maskNode.active = 2 !== status`。

- status=1 的 `statusEndSec` 是**最迟开市截止**（实测四个 status1 所同为 `1794063600`），**不是开市时刻**：开市是城主手动 2445。
- **push 22030 与 1→2 翻转同秒**（决定性证据）：push `ts=1794052802/1794052808` ↔ 翻转后 `statusEndSec=1794139202/1794139208`，差恰 86400（营业 24h）；四个所开市 == 四条 push，零漏零多。
- ⇒ **push 是最快的权威信号，且没有可靠的提前量可算**，只能「push 贴脸 + 轮询漏收自愈」。
- 激烈程度量化：t+1544s 的快照里，刚开市约 77 秒的两个所已 `sum=356/360`、`332/360`（8/9 件打满 40/40）⇒ 迟到一分钟基本无货。

### 3.3 闸门公式（全部源码同源）

```
剩余总次数 = Number(gameConf.dataConfig(81268)) − snap.canBuyCnt   // canBuyCnt 是【已用】：updateBuyCntUI 原式 Math.max(t-o, 0)
                                                        // 录制 canBuyCnt 恒 0 且用户自述剩 5 次 ⇒ 上限 = 5
可买前置   = shop.status === 2                          // maskNode.active = 2!==status
货架在场   = cfg ∈ Object.keys(shop.buyCnt)             // updateItemListUI 原式
全服库存   = row.buy_limit_all − (shop.buyCnt[cfg]||0) > 0   // ≤0 → rank_shop_05「售罄」
本人限购   = (shop.selfBuyCnt[cfg]||0) < row.buy_limit      // 否则 activity95_009（游戏原式无 limit>0 豁免，此处同构）
积分门槛   = row.need_score ≤ snap.cScore                // 否则 conqueror2025_city33/46
钻石余额   = Σ need_gold ≤ gameData.resourceAmount(Gold=10)    // GameDefine.Gold=10；无「保留额」（面板项已废弃，竞品原式就是 ≤ 余额）
面板总数量  = Σ_{status≤2 的所 × 该商品的全部 cfg 行} max(0, buy_limit_all − buyCnt[cfg])   // 无快照显 —（不猜数）、打满显 0
备钻（页脚） = 把勾选商品的可买份数 min(全服剩余, 本人限购余量)（并过积分门槛）按单价降序展开，取最贵的 N 份求和   // N = 本期剩余总次数
```

> **货币单位（已核）**：表列名 `need_gold`、游戏枚举 `ResourceType.Gold=10` 都叫“Gold”，但 `ResourceNameConst[10]` 指向 loc `100017`＝**钻石**（`references/字典表.txt`），两个竞品的 `buyItem` 也都拿 `getResource(ResourceType.Gold)` 与 `need_gold` 比较——即玩家侧实际扣的是**钻石**，不是金币。本 feat 面板/文案统一写“钻石”，内部仍沿用 `gold`/`need_gold`/`spentGold` 以对齐报文与枚举。
>
> **商品身份 = 品种 + 数量（已核）**：用户口径「只有品种+数量才能构成一个商品」——实测橙色万能碎片有 `x15` 与 `x3` 两档，在面板上是**两个商品**（只出品种会撞成两行看不出差别）；游戏侧行名同口径（竞品 B `cname = item_num + "个" + 物品名`）。本 feat 行名 = 物品名 + `x数量`（`goodsLabel`，`item_num` 由 `cq26ShopRows` 投影成 `num`）。
> 反过来，**同一 `(item_id, item_num)` 在普通城/高级城各占一行**（如 cfg 5 与 105）时是**同一个商品**：`productsOfRows()` 按 `productKey = 'i'+itemId+'x'+num` 合成一行、共用勾选、总数量相加；下单时再展开到该商品在这一所上架的全部 cfg 行——因为报文侧的库存/限购**始终按 cfg 行计**（`buy_limit_all` 在表上、`buyCnt`/`selfBuyCnt` 的键就是 cfg id），商品只是「同货的若干 cfg 行」的别名。
>
> **等级不区分（已核）**：竞品把全部 `cnc_shop` 行当作**单一扁平清单**（按 cfg id 枚举、仅按 `cnc_level` 排序）；本 feat 的 `buildCandidates` 是**三轴**：外层商品优先级 → 中层密所的游戏显示序 → 内层该商品在该所的 cfg 行，再按 `buyCnt` 键集过滤——普通城 cfg(1–11) 天然只命中普通城所、高级城 cfg(101–111) 只命中高级城所，档位前缀纯属冗余，故不拼「普通城/高级城」（`cfgLabel` 已删），也不把单价拼进行名——行名只出「品种+数量」，钻石价与总数量各走一列（价与价、量与量同列对齐、可扫读）。

2444 应答四字段由**消费侧源码钉死**（不再是推断）：`CQ25CNCShopMainNode.onBuyCallBack(e)` 逐字读
`e.data.canBuyCnt` / `e.data.tax` / `e.data.selfBuyCnt` / `e.data.buyCnt` 回写 `shopMainData`，而且是**整张表替换**，不是只改买到的那件
⇒ `settleBuy()` 同样整表替换，应答缺字段才退回乐观自增。
另注：成交面板上的奖励条目是客户端用配置表**自拼**（`CQ25CNCShopItem`：`{itemId:row.item_id, itemCount:row.item_num}`），
即 **2444 应答不携带奖励明细** ⇒ 表行不可得时 fail-closed 不下单。

---

## 4. 三层触发与 burst 施工

> **开售信号已定谳（实证 20261107 全天 37 场录制）**：push 普查命中 **22030 `SERIES_FROST_NEUTRAL_CITY_SHOP_ICON` 四条**（`{type:1, id:Int64}`），
> ts=1794052801963 / 1794052808762 / 1794053646924 / 1794053652223，与 2442 快照里四个 `status=1` 所逐一对上、零漏零多：
> `id._low=-1256363517`→csn3002(sid3765)、`-1172477431`→csn3003(sid3765)、`-417750526`→csn3005(sid3281)、`-350641657`→csn3006(sid3281)
> ——即 **S3765 / S3281 两区就是在 11/7 由城主逐所宣布开市**，与用户指认一致。
> 另一条决定性证据：**`status=1` 的 2442 所行已带齐 9 个 `buyCnt` 键**（货架不缺），故收到 `type=1` 后**无需等任何应答**就能构造候选。
> 游戏侧同源：`CQ26Response` 的该 push Handler → `emit(CQ25_CNC_SHOP_CHAT_ICON,{type,id})` → `CQ25CNCShopMainNode.onShopOpen` 命中当前所时 `requestShopSingleData(id)`（= **2443 单所快查**，不是 2442 全量）。

| 层      | 触发源                      | 动作                                                                                                                                                                                                                                                                                                                                               | 延迟                          |
| ------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| L1 贴脸 | push 22030 `type===1`       | 缓存里该所若 `status===1` → **本地直接翻成 2**（省一个 RTT）→ **立即 burst，不排在任何应答后面**；同时按游戏 `onShopOpen` 原式**并行**发一条 **2443 单所快查**作后台校正（`statusEndSec/tax/buyCnt` + `canRevRedPack` 权威位），快查**不参与下单时序**，且与面板刷新一起让位给 2444（挤到下一个微任务，见 §4.3）；缓存无此所才退回 2442 全量作前导 | ~0ms                          |
| L2 补量 | push 22030 `type===2`       | `2441 {id, get:true}` 领红包（`force=true`，见 §6）                                                                                                                                                                                                                                                                                                | ~0ms                          |
| L3 兜底 | `createCycle` 轮询 2442     | 快照过期 / 登录后漏收 push 自愈；**存在 status1（待开市）的所即降为快轮询**（旧版按「最迟开市截止 <120s」判据实测恒不成立——开市比该截止早 ~3h，已修正）                                                                                                                                                                                            | 静默 60s（系统值）/ 待开市 5s |
| L4 重试 | burst 内失败候选            | `BURST_RETRY_MS=3000` 窗内每 400ms 重跑候选生成，**只补未成功的 `(shopId,cfg)`**；钻石预算跨轮累计（`panel.spentGold`）防重试窗内砸空                                                                                                                                                                                                              | 3s 内                         |
| L5 补扫 | burst 在飞时又收到开市 push | 不整轮丢弃：置 `burstPending`，当前轮 `finally` 末尾合并再跑一轮（`retry=true`），避免「轮询 burst 在飞→新所 push 被吞」要等下一拍；**同时叫醒当前轮次间隔**（`burstPacer`，见 §4.3）                                                                                                                                                              | 立即接续                      |

### 4.1 下单为什么必须 `gate:false` + 管线化

逐条 `await` 会把 N 件拖成 `N×RTT`。本 feat 一次生成完整有序清单，逐条 `sendGuarded(2444, …, {protocol:'sendPBV2', gate:false})` **不 await**，间隔 `BUY_GAP_MS`（系统值 100ms，实证竞品B 每条下单前 `asleep(100)`）。

`gate:false` 的依据：`core/net.js` 的 `sendGuarded` 在 `opts.gate !== false && net.checkRequestIdNoRes(cmd)` 命中时直接回落 `CODE_NOT_SENT`——**包被静默吞掉**。burst 期间游戏自身也可能挂一个在途 2444（玩家手点），带闸就等于让玩家的这一次点击废掉我们整轮。绕过后节奏与上限由本模块自己保证：`BUY_GAP_MS` 间隔 + `cap = 剩余额度 − 本轮已下发`（不再有独立的「单次」旋钮）。

`gate:false` 下 2444 的 `CODE_NOT_SENT` 只来自 `sendGuarded` 的 catch，按 `sendErr` 是否含 `no server response` **二分处理**：**超时**（包已上 wire、应答丢失，结果未知）→ `state[key]=2` + 冷却，**不退回重试**（否则对同一 `(所,件)` 重复下单、多花钻石/额度），交下一拍 2442 权威快照纠偏；**确未上线**（发送入口 `!ok`：cdTime 频控/编码失败）→ `state[key]=0; stats.dispatched--; stats.goldSpent -= row.gold`，退回计数以便重试窗内再补。两者都 warn。

### 4.2 候选序（纯函数 `buildCandidates`，导出）

```
shops 过滤 status<=2，排序：① 本服优先 (sid===worldMap.serverId()) ② (level||cityLevelId) 降 ③ id 十进制串升
外层：面板 goods 优先级序（下标即优先级，未登记=默认 on）；内层：shops × 该所货架（Object.keys(buyCnt)）
逐件过 §3.3 六闸 → 截断到 cap
```

唯一刻意偏离：游戏 `createToggleUI` 比 `cnc_city_level.level || 1`，本实现 `level` 读不到（表缺 → 0）时退到 `cityLevelId` 降序——未知档不给加权，而不是压平成同一档。专例覆盖。

`buildCandidates(snap, rows, panel, nowSec, goldAvail)` **不读模块态、不摸游戏符号**（闸门全部显式传参），
故 `tests/feats/cq26-shop.test.js` 能拿游戏原式参照实现做 200 组随机对拍。

### 4.3 用时：贴脸时序的两个约束（20261111 一场实录逐笔对齐）

游戏流水（2447）里的 `buyUseMill` = **服务器收到我们 2444 的时刻 − 该所开市时刻**，即面板上的「用时」。
同一场所全场最快 22~56ms（= 开市当刻包已在途的物理下限），我方五笔实测：

| 密所 cfg     | push 到达→2444 上 wire | 用时     | 名次  | 该档最快 |
| ------------ | ---------------------- | -------- | ----- | -------- |
| …553096 cfg5 | 2ms                    | **42ms** | 2/40  | 40ms     |
| …553096 cfg6 | 160ms                  | 229ms    | 13/40 | 48ms     |
| …330568 cfg5 | 245ms                  | 289ms    | 21/40 | 56ms     |
| …553347 cfg5 | 274ms                  | 306ms    | 3/40  | 61ms     |
| …553347 cfg6 | 385ms                  | 419ms    | 2/40  | 54ms     |

拟合：**用时 ≈ (push→发包) + 40ms**（那 40ms 是上行 + 服务器，压不动）⇒ 慢的部分全在我们自己排队，两条已修：

1. **新所插队**（`burstPacer` = `core/util.js` 的 `createWaker`）：一轮 burst 要跑满 3s 重试窗，期间新到的开市 push 原先只置 `burstPending` 等 `finally`，或等下一个 400ms 轮次边界 → 首包晚 245~274ms（同一所里名次从 2 掉到 21）。现在 `burst` 的 busy 分支除置标志外还 `wake()` 当前轮次间隔，下一轮立即重跑候选生成。**逐条 `BUY_GAP_MS` 刻意不接这个句柄**：同所两件之间的节奏是系统值，跨所并行是另一件事。
2. **wire 顺位**：`sendGuarded` 的同步前缀就写 socket，故 `onPushOpen` 里留在同步段发的 2443（实测比 2444 早 2ms）与同步 `pokePanel()` 渲染都挤到**下一个微任务**——`lead.then(burst)` 先入队，burst 在其同步段把首包推上 wire；状态列仍不等应答（一个微任务内就动）。

复算：`node dashcam/cli.js log <日志目录> --ms=<会话窗> --mod=CQ26-SHOP --lvl=debug` 看 `burst busy … woken=true`；
`node dashcam/cli.js slice <会话文件> --from <开市秒> --to <开市秒+4>` 看 push 与 2444 的 ts 差。

---

## 5. 本地镜像收敛（规避「直发不回写 UserData → 逐拍重发」陷阱）

我们的 2444 不经游戏 UI，`CQ25Controller.neutralData.shopMainData` 不会感知。故模块内自建 `mirror` 作**唯一判据源，绝不读游戏 `neutralData`**（陈旧）：

- 2444 成交 → 应答带的四字段按游戏原式**整体回写**（`canBuyCnt` 覆盖全局、`selfBuyCnt`/`buyCnt` 覆盖该所两张表）。
- 2442/2443 应答 → 服务器值覆盖 mirror（真源归位）。
- **burst 在飞时**取 max 合并（`mergeOptimistic`）：快照可能早于我们刚发出的 2444 落库，不合并会镜像回退 → 同件重买。
- 拒后记账：`rejectCount[shopId:cfg]`，`REJECT_COOL_MS=60s`（抢购节奏快，不能沿用 excav 的 5min），连续 `MAX_REJECT=3` **当日**拉黑，日界由 `rolloverReject(todayStr(serverTime))` 滚清。
- `run()` **不清** `rejectCount`/`coolUntil`：`places/kinds` 门控会反复 pause→run（进出 homeland、base/world 跳），清零等于给服务器侧永久拒绝的 `(所,件)` 无限续命逐拍重撞。

---

## 6. fail-closed 前置闸（三处，不只轮询拍）

| 闸             | 位置                                 | 判据                              | 不过时                                                                                |
| -------------- | ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------- |
| 活动闸（拍）   | `gatedPass(cq26IsOpen(), cyclePass)` | `gameData.cq26IsOpen()`           | 长睡 5min，**一个包都不发**（含 2442）                                                |
| 活动闸（写）   | `burst()` 首行                       | 同上                              | 直接 return：push 贴脸路径不经过 `gatedPass`                                          |
| 活动闸（红包） | `claimRedPack()` 首行                | 同上                              | 直接 return                                                                           |
| 额度闸         | `burst()` / `cyclePass()`            | `Number(dataConfig(81268)) > 0`   | 整拍跳过 + warn 一次（`quotaWarned` 去重，恢复后复位）                                |
| 表行闸         | `burst()`                            | `gameData.cq26ShopRows()` 非 null | 整拍跳过 + warn 一次（投影返回 **null** 而非 `{}`，就是为了区分「读不到」与「没货」） |

未开放的服务器上这些协议号根本不应答 ⇒ 发了就是每拍一条 15s 超时刷屏。这也是 `gatedPass` 抽成**导出的高阶函数**的理由：
「零发包」可被单测直接断言，不必搭 net 桩。

红包路径的 `force` 参数与 `canRevRedPack` 权威源：实证 **2442 所行键集不含 `canRevRedPack`**（只在 2443 info 下），故 `projectShop` 不投影它、`applySnapshot` 反而**跨快照承接**旧镜像里由 2443 探得的权威位（否则每拍被抹回未知 → 每拍重发 2443 补查）。`sweepRedPack()`（`force=false`）见判据 `undefined`（从未探得）时先 `await requestSingle`（2443）拿权威位再决定领，`=== false` 跳过，`=== true` 直接领；push `type=2`（`force=true`）则跳过快照位直接领——陈旧为 `false` 不能反过来否掉 push（否则 type=2 永远不领）。

---

## 7. 日志分级与首跑诊断

| 级    | 场景                                                                                                                                | 关键上下文                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| info  | 安装 / 启动 / 成交 / burst 轮次 / 业务拒绝（`!ret.ok`）/ 领红包                                                                     | shop、cfg、物品名、钻石、余量、耗时、code + `rejectText` |
| warn  | `2444` 超时（已上线无应答，outcome unknown）/确未上线、`2443/2442/2441` 发送真抛错、`dataConfig` 缺配、表投影不可用、22030 载荷畸形 | err.message、tag                                         |
| debug | `2442/2443/2441` 在途闸命中（下一拍自愈）、2442 快照摘要、burst 忙转 pending、22030 未知 type                                       | 决策原因                                                 |

`2442` 的 `CODE_NOT_SENT` 刻意**只打 debug**：带闸的读通道在「push 补快照」与「轮询拍」撞车时恒命中，升 warn 就是刷屏（日志四级契约：warn 只给真异常）。server `code !== 0` 一律 info 且带 `rejectText(ret)`。

**首跑一次性 dump**：首次 2444 成功与首次 2441 成功各打一条 `safeStringify(ret.data)` 全量应答（`dumpedBuy`/`dumpedRedPack` 标志位约束），把「源码推断形态」升级为「报文实证形态」。

---

## 8. 面板字段

| key           | 类型                                                                                                                                | 默认  | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_shopGrid`   | infogrid(columns=归属区/等级/状态/状态倒计时, rows=`shopRows`)                                                                      | —     | **一密所一行**的只读栅格（新字段类型，见 `core/ui/fields.js` 的 `infoGridInnerHTML`）：归属区=`sid`（报文实证 S3281/S3765 就是 11/7 那两个 status1 所；★=本服）、等级=`cnc_city_level.level`（表缺时退 `cityLevelId`）、状态=待开市/抢购中/红包期/已结束、倒计时=`statusEndSec − ServerTime`（游戏原式：status≥4 或已过点不出）；行序与下单内层序共用 `sortByGameOrder`；排版靠单个 CSS Grid + `display:contents`，因此对齐不依赖等宽字体（旧版用 multiline text 拼 `cs3003 · st2 · 货架9 · 余量312` 在 CJK/数字混排下会错位，已拆掉）                                                                                                                                                                                                                                                                                                                                               |
| `_shopInfo`   | text(multiline, inline, get)                                                                                                        | —     | 跨所聚合量：CQ26 状态 / 本轮已抢 x/5 / 最近一次成交 / 当日拉黑组数（逐所状态已上移到 `_shopGrid`）。「本轮已抢」分子 = 服务器权威的 `canBuyCnt`（本期**已用**，含手动购买），因此跟随轮次而非日界，页面刷新 / 扩展重载 / 跨天都不清零；旧版此处另有一行会话级「本会话已抢 N 件」（模块变量 `dealCount`，刷新即归零）与上一行的额度摆在一起被读成「本轮一件没抢」，已删                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `goods`       | itemlist(sortable, orderKey=`goodsOrder`, items=`goodsPool`, nameGrow, costCol, stockText=`goodsStockText`, summary=`goodsSummary`) | 全 on | **一行一个商品**（=`item_id`+`item_num`，行名带 `x数量`），不分普通/高级城；同货多档已合并为一行（键为 `productKey`）；**红色 `💎N` 列 = 单件钻石价**（`fd.costCol`，代替原「购买上限」数字输入——抢购迟到即无货，逐件上限没有自由度，`buildCandidates` 的 `g.max` 闸已删，`normalizeCfg` 直接丢弃旧存档的 `max` 位）；**总数量列 = 该商品在全部商店的剩余之和**（`fd.stockText`，无快照显 `—`）；取消勾选=不抢（作用在整个商品上，含其全部 cfg 档）；页脚 `goodsSummary` 汇总「本轮建议备钻 ≈ **勾选商品的最贵可买组合**（逐 (所,cfg) 取 min(全服剩余, 本人余量) 并过积分门槛 → 单价降序取前 N 份；N=本期剩余额度，实测 5；81268 不可得时退系统估值 `QUOTA_EST=5` 并写明是估算）」；两个只读列与页脚都是「行结构不变、值随快照变」的格：由 `refreshTexts` 就地重算（`.pc-istock[data-istock]` / `.pc-isummary[data-isummary]`），**不走 `refreshFieldBox`**（那会拆掉拖拽/勾选监听） |
| `nearPollSec` | number 1–60                                                                                                                         | 5     | 存在 status1（待开市）所时的快轮询（静默档已内化为系统值 `IDLE_POLL_SEC=60`；旧判据「临近开市截止 <120s」实测恒不成立，已弃用）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**已不在面板的项（内化为系统值，逐项带竞品实证）**：

| 系统常量              | 值             | 依据                                                                                                                                                                                                              | 原面板项            |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `BUY_GAP_MS`          | 100ms          | 竞品B 候选循环内每条 2444 前 `asleep(100)`（先删 `_requestTimePool[CQ2025_CNC_SHOP_BUY]` 绕频控），且它的 `setting.interval` 只在 render 里透传、UI 从不读写——竞品侧同样是硬编码；竞品A 每拍只发 1 条，无间隔概念 | `burstGapMs`（120） |
| `IDLE_POLL_SEC`       | 60s            | 开市 push 同秒已实证，轮询只作漏收自愈；竞品A 用 2s 常驻全量轮询、竞品B 只在启动后 5s 探一次                                                                                                                      | `idlePollSec`       |
| 单次开市下单上限      | = 本期剩余额度 | 竞品B 直接 `slice(0, 81268 − canBuyCnt)` 截候选，没有独立的「单次」旋钮                                                                                                                                           | `maxPerBurst`       |
| 钻石预算              | = 余额         | 竞品原式 `need_gold ≤ 余额`（A 取余额、B 取余额减本轮累计已花）；保留额只会在余额够时少抢一件                                                                                                                     | `goldReserve`       |
| 启用抢购 / 顺带领红包 | 恒开           | 红包两侧竞品均无条件领（A `onNewChatPush` city34、B `getRedPack`）；启用与否交给菜单通用开关——`run()` 只在 feat 运行时订阅 push，`onIconPush` 首行 `aliveFn()` 再拦一层                                           | `buyOn` / `redPack` |

旧存档里的这六个键由 `normalizeCfg` 直接丢弃（不留残留键，否则配置导出会带上面板上已看不见的项）。

物品名**不向 `core/item.js` 的 `ITEM_NAMES` 硬塞**：离线仓库（`warroom/data/config_optim2.dec.utf8.txt`、`table-names.txt`）里 grep 不到 `cnc_shop` 行 ⇒ 密所奖池的 `item_id` 离线不可知，登记不存在的 id 是凭空造表。
改由 `goodsLabel()` 运行期现查 item 表的 `name` loc 键，再走 `item.label` 三级回退（登记表 → 译键 → `道具 N`），并附 `x数量`；表未加载时面板退化为 `placeholderKey()` 的 `cfg7` 形态（无档位前缀、钻石价与总数量列置灰显示 `—`），不空。

**存档迁移（商品化改造的兼容点）**：旧 `goods`/`goodsOrder` 以纯 cfg 档号为键，`normalizeCfg` 按当前表上的商品集重建：
旧 cfg 键的取消记录**并入所属商品**（同一商品任一档曾被关 → 整体关，AND 语义：宁可少买，不越权买用户明确关掉的货），
拖拽序同口径映射并去重；表不可读时商品集退成 `placeholderKey` 占位键，也同样从占位/旧 cfg 键承接（否则那段时间的取消会在表恢复后静默失效）。

**面板实时刷新**：本 feat 无任何定时器参与 UI，只在各结算点调 `pokePanel()`（`bus.emit(EVT.UI_REFRESH)`，**刻意不带 `rebuild`**）：
`applySnapshot`（2442 落 mirror）、`requestSingle`（2443 回写单所）、`settleBuy`（2444 成交）、`onPushOpen`（开市本地翻牌）。
面板未开时 `core/ui/index.js` 早退，开销可忽略。

另：只读信息表格 `type:'infogrid'` 是本轮新增的共享字段类型（`core/ui/fields.js` 的 `infoGridInnerHTML` + `FIELD_BOXES.infogrid`），
任何 feat 的「多行只读状态摘要」都可以用（行集由 `fd.rows(cfg)` 现取，`refreshTexts` 走 `refreshFieldBox` 整块重刷）。

---

## 9. 已知缺口（诚实声明）与补证步骤

1. **2444 应答无报文级证据**。形状由 `onBuyCallBack` 钉死，但全库 5 个 uid、39 场录制里 2444 **零命中**（与「从未成功购买」吻合）⇒ 字段存在性待首跑 dump 固化。
2. **2441 应答 / 22030 type=2 / `canRevRedPack` 全部零命中**（录制未走到结算期）⇒「status4 + opened + canRevRedPack」这条触发是源码推导。
3. **各业务拒绝码未知**（售罄/积分不足/次数用尽/非营业期/钻石不足）⇒ 拒绝处理走「通用计数 + 冷却 + 当日拉黑」，不按码分派。
4. `dataConfig(81268)` 与 `series_frost_cnc_shop` 表行离线不可读 ⇒ 运行期现取 + `CFG_CATALOG` 静态保底。

补证两步（才能把 1/2/3 固化为对拍）：

- **步骤 A**：开着 feat 跑一次真实开市（或真人手动买一次），用扩展面板「报文录制」开关留档实录。
- **步骤 B**：`node dashcam/cli.js shape/slice --cmd 2444/2441` 抽真实应答，回填本文 §2 表格与单测内联夹具；再新增 `scripts/verify-manifests/cq26-shop.mjs`（对拍「面板候选序 == 实际下单序」「买后 `canBuyCnt` 步进」）与 `package.json` 的 `verify:cq26-shop`。
  **本次交付不接入对拍**——没有我方写报文，manifest 只能对着推断形态自证，无意义。

---

## 10. 刻意不做

- 不发 2445 开市 / 2446 发红包：需 `hasAuthority(DECLARE)`，是城主决策，不是脚本该抢的权。
- 不接聊天通道拿密所商人卡（`ChatCQ25ShopMerchantItem` 的 `cstp`）：实证竞品 B 的主触发确实是聊天卡（`onNewChatPush` 匹配 `conqueror2025_city27`「我开启了印石秘所，快来抢购！」→ 解析 `cstp.id` → 3s 重试窗 `buyItem`，且删 `_requestTimePool[CNC_SHOP_BUY]` 绕节流）。
  但仍不接：我方 22030 已实证与 status 1→2 **同秒且零漏**（见 §4），接聊天会引入 `feats/system/chat → feats/cq26` 的跨 feat 反向依赖，违反依赖方向红线；本 feat 已在同一时刻用 **2443 单所快查**覆盖竞品靠聊天卡拿到的那份信息。
- 不做「抢购后自动使用/寄售」，不改游戏 `neutralData`，不调任何 Update/Delete 类游戏接口。
- 不做 2s 级全量高频轮询（竞品 A 口径）：push 已实证同秒，轮询只作漏收自愈。

---

## 11. 验收

- [x] `npm run lint` / `npm run build` / `npm run arch` / `npm test` 通过（含 `tests/feats/cq26-shop.test.js` 的 200 组游戏原式对拍）
- [x] 安装期依赖自检：`symbols: ['dataCenter', 'tableManager', 'tableUtils', 'long64Bit']`。四个都是硬依赖，其中 `long64Bit` 不可省：`bits.int64` 拿不到 `Int64` 类时回退 `Number(v)`（实证 `core/acl/bits.js` L21），
      19 位密所 id 会被截成 `499999999999999000` ⇒ 每条 2444 都打在不存在的 id 上。本玩法不声明 `cq26NeutralCtrl`（那是 excav 的发掘控制器），`cq26IsOpen()` 走 `_cq26()` 惰性 probe，活闸不过时静默长睡
- [ ] 面板出现「CQ26 印石 → 霜之密所抢购」，开关可开可关；`_shopGrid` 一密所一行且四列对齐（归属区/等级/状态/倒计时），`_shopInfo` 显示额度 x/5
- [ ] 抢购物品清单**一行一个商品**且行名带 `x数量`（如「橙色万能碎片x15」与「橙色万能碎片x3」分列两行）；无「购买上限」输入列，改为红色 `💎N` 单件钻石价列 + 总数量列
- [ ] 总数量列 = 全部商店该商品剩余之和（逐所逐 cfg 行 `max(0, buy_limit_all − buyCnt)` 相加；status 3/4 不计；无快照显 `—`），且随 2442/2443/2444 回写就地更新
- [ ] 页脚备钻 = 勾选商品的**最贵可买组合**（份数取 min(全服剩余, 本人余量) 并过积分门槛，按单价降序取本期剩余额度 N 份）；无快照时退「最贵单价 × N」并写明是估算
- [ ] 旧存档（按 cfg 档号勾选/排序）首次 configure 即迁移到商品键：同一商品任一档曾被取消 → 整体取消
- [ ] 面板不再出现「单次开市最多下单数 / 下单间隔 / 兜底轮询 / 钻石保留额 / 启用抢购 / 顺带领红包」六项，且行为与系统值一致（逐条 100ms 间隔、静默拍 60s、一轮最多发满本期额度、预算=余额、红包恒领）
- [ ] 旧存档带上述六个键时首次 configure 不报错、不残留（导出配置只剩 `goods`/`goodsOrder`/`nearPollSec`）
- [ ] CQ26 未开启时零报文（dashcam 复核：本 feat 不增加任何 req）
- [ ] 收到 push type=1 → 3s 内出现 ≤ 本期剩余额度条 2444（逐条间隔 100ms），且顺序 == 面板候选序；**同一时刻并行一条 2443（不阻断下单）**
- [ ] 同一 `(所,件)` 一轮内不重复下单；应答整表回写后该件不再入选
- [ ] 首次成交/首次领红包各一条 `first ack dump`，用于 §9 的形态固化
- [ ] 战斗模式不影响本 feat（`offInCombat:false`：即时成交、不占行军名额）
