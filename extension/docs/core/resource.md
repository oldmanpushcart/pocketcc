# core/resource.js —— 资源田「编号真相 + 纯查询」薄底座

> 源码：`src/core/resource.js`。定位是**薄底座**（truth / query），不是玩法聚合层。对齐 [`core/item.js`](item.md) / [`core/map.js`](map.md) 的「只收口查询、不聚合动词」铁律。

## 1. 职责与边界

**管什么**——把跨 feat 复用的 **RESOURCE 配置表事实与只读查询**收口为单一真相，只覆盖**「资源田 / RESOURCE 行」这一条编号轴**：

- `groupTypeFor(fieldFamily, level)`：(田家族, 等级) → 906 搜索的 `groupType`（RESOURCE 行 id）。家族 = `floor(RESOURCE.id/100)`，等级取该行 `.level` 字段。
- `resourceMeta(itemId)`：itemId（RESOURCE 行 id）→ `{family, level}` 反查（家族回 `floor(id/100)` 轴）。
- `maxLevelForFamily(fieldFamily)`：该族在 RESOURCE 表里存在的最高等级（族级天花板，如雷神=3）。逐档下探类调用方用它做起点，免撞表里根本不存在的行。
- `RESOURCE_MAX_LEVEL`（=5）：906 可搜的普通田通用等级上界。
- `isRelicItemId(itemId)` / `isRelicTarget(target)`：**遗迹田（6 级田）识别的跨 feat 单一判据**——「遗迹田永不撤回」全局不变量（auto-farm 时段外撤田/升级抢田 + launch-silo 腾队列）只走这一条。`isRelicTarget` 是三轴的合体入口，`isRelicItemId` 只走 id 轴。
- `RELIC_ITEM_GROUP`（=15）/ `RELIC_LEVEL`（=6）/ `RELIC_POINT_TYPE`（=38，转名自 `core/map.js` 的 `FORTRESS_RES_POINT_TYPE`）：遗迹田识别的三个常量真相。
- `resetCache()`：清 `groupTypeFor` 与 `maxLevelForFamily` 的页面级结果缓存。

**明确不管**（都是「建塔玩法」私货或另一条编号轴，不可混入田轴）：

- **机械田「塔」的三条编号轴**：bid 前缀 `floor(bid/1000)`（51 金/52 油/53 粮/71 雷神）、职业 buffId（1101001…）、面板家族码，以及「面板家族 ↔ 塔 bid 前缀 ↔ 落点田组 ↔ buff」**四元组表**——只有 `feats/player/mech-build.js` 用，留在该 feat，本模块不碰。
- **RESOURCE 表的 `resource_type` 字段**：那是第三套编号（游戏 `ResourceType` 枚举 1=Coin/3=Oil/7=Soil/20=ThorElements…），语义另计，本模块不碰。
- **落点谓词与择优策略**：`isFreeField`（R2 无主普通田判据）、R3「等级最高优先」的逐级降序/排序、`taken`/黑名单/`ownerId+amount` 宽严口径——都是各 feat 玩法私货，留 `feats/`。
- **6 级田的玩法层**：扫描（邮件驱动锚点扫图）、候选池、复验、派兵——全归 `auto-farm/lvl6-scanner.js`。本模块只回答「这个目标是不是遗迹田」，不回答「哪块遗迹田可下」。
- **机械田塔 bid / 遗迹候选谓词以外的世界点语义**：pointType 实体字典本体归 `core/map.js`（本模块只取 38 这一个值）。

**对外契约**：全部纯读、同步查表、永不抛异常、无发包无加载期副作用；仅经 `l10n` 能力 API 读 RESOURCE 表，不 `game.get`、不摸 `window.pocketcc`。

## 2. 设计思路与取舍

**核心动机——编号轴隔离**（教训：`RESOURCE表resource_type与面板family编号不同源` 的错标 bug）：TopWar 里资源家族同时存在**三条不同源编号**——

| 轴               | 取值式                   | 语义                                | 谁在用                                    |
| ---------------- | ------------------------ | ----------------------------------- | ----------------------------------------- |
| 田 / RESOURCE 行 | `floor(RESOURCE.id/100)` | 1 石油 / 5 粮食 / 7 金矿 / 16 雷神  | 906 的 `groupType`、落点田 itemId、本模块 |
| 塔 / bid         | `floor(bid/1000)`        | 51 金 / 52 油 / 53 粮 / 71 雷神     | mech-build 四元组（feat 私货）            |
| resource_type    | `RESOURCE.resource_type` | 游戏 `ResourceType` 枚举（1=Coin…） | lvl6-scanner 换算                         |

三条轴**绝不可当恒等合并**。最反直觉但经 dashcam 实证的一条：一座「采金」塔（bid 51xxx）落在 `floor(id/100)=1` 的田上，而 `floor(id/100)=1` 在采集侧叫**石油**——「建塔落点」与「田本身叫什么」本就是两回事。本模块只沉淀第一条轴，把第二/三条隔离在外，正是为了不在「单一真相」里把三轴焊死。

**取舍：为什么只下沉田轴、不下沉四元组**——「(家族,等级)→groupType」「itemId→家族/等级」是 auto-farm 采集与 mech-build 建塔**都要用、且必须同口径**的纯翻译（此前两处各抄一份是隐患）；而四元组是只有建塔才有的产品知识，按「不聚合玩法动词」留在 feat。

**取舍：为什么等级天花板靠表真相、而不建 `{族→上限}` 硬编码表**——金/油/粮到 5 级、雷神到 3 级，本质是「RESOURCE 表里雷神族没有 1604/1605 这两行」。天花板仍由表给出，但**以显式查询形式**（`maxLevelForFamily`）交给逐档下探的调用方：早期只靠 `groupTypeFor==0` 隐式跳过，实测会每拍在雷神族上白撞 5/4 两档（`pickHigher` 还会多探几档注定不够高的 906）。不另立硬编码上限（会随游戏版本漂），也不把「表查不到」当成「该族没田」——`maxLevelForFamily` 回 0 时调用方 fail-open 退回通用上界。

**被否决的备选**：把面板家族↔塔 bid↔buff 也塞进 resource.js 当「资源真相」（→ 把两条编号轴焊成一条，重蹈错标 bug，否决）；把 `isFreeField`/R3 排序下沉（→ 各 feat 判据宽严不同：normal-scan 只看 `ownerId+amount`、mech-build 还要查 `aid/allianceAreaOwner`，强行统一会改变行为，否决）。

## 3. API 契约

| 方法                 | 签名                                                            | 返回           | 语义                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groupTypeFor`       | `(fieldFamily:number, level:number) → number`                   | RESOURCE 行 id | 扫 `l10n.tableRows('RESOURCE')` 找 `floor(id/100)===fieldFamily && row.level===level` 的行 id；命中即缓存；该族该级无行（如雷神 4/5 级）返回 **0**                                    |
| `resourceMeta`       | `(itemId:number\|string) → {family:number, level:number}\|null` | 田元数据       | `l10n.tableRow('RESOURCE', String(id))`；`family=floor(id/100)`、`level=row.level`；查不到行回 **null**。只服务 1~5 级普通田                                                          |
| `RESOURCE_MAX_LEVEL` | `5`                                                             | 上界           | 906 可搜的普通田通用等级上界（6 级非 906 可达）                                                                                                                                       |
| `maxLevelForFamily`  | `(fieldFamily:number) → number`                                 | 该族最高等级   | 扫 `l10n.tableRows('RESOURCE')` 取 `floor(id/100)===fieldFamily` 行的最大 `.level`；命中即缓存；表未就绪/该族无行回 **0**（调用方 fail-open）                                         |
| `resetCache`         | `() → void`                                                     | —              | 清 `groupTypeFor` 与 `maxLevelForFamily` 的结果缓存（run 复位时调，跨会话不保留）                                                                                                     |
| `isRelicItemId`      | `(itemId:number\|string) → boolean`                             | 是否遗迹田     | 轴② `floor(id/100)===15`（纯 id 轴，表未就绪也成立）或轴③ `RESOURCE` 该行 `.level ≥ 6` 即真；itemId 缺/查不到行回 **false**                                                           |
| `isRelicTarget`      | `(target:{itemId?,targetType?}\|null) → boolean`                | 是否遗迹田     | 三轴任一即真，按硬度排序：① `targetType===38`（与 901 pointType 同轴，856 报文恒带，不靠表）→ ② → ③；入参非对象/都取不到回 **false**（fail-open：宁可误撤，不把普通田误锁成永不撤回） |

## 4. 场景用法

**auto-farm/normal-scan 逐级降序搜普通田**（田家族直接就是 `floor(id/100)` 轴，与 familyOptions 同口径）：

```js
var gid = resource.groupTypeFor(family, level); // family 即面板 1/5/7/16
if (!gid) return null; // 该级无行 → 跳过、不发包
var res = await map.searchPoint(net, {
  minLevel: level,
  maxLevel: level,
  groupType: gid,
  pointType: 2,
});
```

**mech-build 建塔选地**（面板家族 → 落点田组 → 田轴 groupType；这一步「跨轴换算」是 feat 私货，只有落到田轴后才交本模块）：

```js
var fieldGroup = FIELD_GROUP_BY_FAMILY[family]; // 面板家族 7 → 落点田组 1（feat 表）
var gid = resource.groupTypeFor(fieldGroup, lv); // 田组 1 + 等级 → 1xx 行 id（本模块）
```

**itemId 反查家族/等级**（auto-farm 账本 / priority 展示，经 `normal.resourceMeta` 透传）：`resource.resourceMeta(506)` → `{family:5, level:5}`。

## 5. 数据流与降级

```
fieldFamily + level ─groupTypeFor─▶ l10n.tableRows('RESOURCE') ─▶ 命中行 id（缓存） / 无行 ─▶ 0
itemId            ─resourceMeta─▶ l10n.tableRow('RESOURCE', id) ─▶ {floor(id/100), row.level} / 无行 ─▶ null
```

降级全为「读不到即回哨兵值」：表未就绪 / 族级无行 → `groupTypeFor` 回 0、`resourceMeta` 回 null；调用方据哨兵值决定「跳过该级 / 不展示」，绝不抛，也不发包。

## 6. 坑与边界

- **三轴勿混**：本模块只认 `floor(id/100)` 田轴。拿塔 bid 前缀（51/52/53/71）或 `resource_type` 枚举当本模块的 `fieldFamily` 传进来必错（历史 bug 即源于此）。跨轴换算由 mech-build/lvl6-scanner 自持。
- **等级取 `.level` 字段，非 `id%100`**：实证 id 506 的 `.level=5`（`506%100=6` 是错的）。旧口径 `itemId%100` 已废弃。
- **6 级田的 itemId（1514/1515）`floor(id/100)=15` 不是家族编码**：家族轴只有 1/5/7/16，15xx 只由遗迹田占用，故 `isRelicItemId` 拿它当遗迹预筛是安全的；但 `resourceMeta` 只服务普通田 1~5 级，6 级家族真值以 lvl6-scanner 池内 `resource_type` 换算为准，勿用本函数反查 6 级田。
- **雷神族无 4/5 级行**：`groupTypeFor(16, 4|5)` 返回 0 属正常，不是「表没加载」。逐档下探请先用 `maxLevelForFamily(16)`（→ 3）夹住起点，否则会每拍撞空行刷日志（真机踩过：`no RESOURCE row for family=16 level=5/4`）。
- **遗迹识别不得依赖候选池**：`auto-farm/lvl6-scanner` 的遗迹池靠邮件驱动扫图，刚刷新页面/未扫过时是空的；只按坐标反查会把在途遗迹田误判成普通田而误撤。「永不撤回」是全局不变量，故判据下沉本模块（跨 feat 也不得 import 对方 feat 的池）。
- **`isRelicTarget` 的 fail-open 方向**：三条轴都取不到时回 false（当普通田可撤）。考虑到采集行军的 `target.itemId`/`targetType` 由 856 恒带，缺号只在进场极早期；此时宁可放过一次误撤，也不把普通田钉成永不收回。
- **906 每级只回一个点**：本模块只给 groupType，不含排序；「同等级被拒换第二个点」906 做不到，选地是「拉黑该坐标 + 降级重搜」（详见 map.md `searchPoint` 与 mech-build 变更记录）。
- **Int64 勿做 Number 精度陷阱**：itemId/等级均小整数，`Number` 安全；但 906/901 应答里 `ownerId/aid` 等大整数身份要按字符串比较，属谓词层（feat）职责，不在本模块。

## 7. 调试面

运行环境直读（DevTools / 控制台，登录即可读，无需发包）：

```js
resource.groupTypeFor(1, 5); // → 106（石油 5 级田行 id）
resource.groupTypeFor(16, 3); // → 1603（雷神 3 级）
resource.groupTypeFor(16, 4); // → 0（雷神无 4 级，天花板隐式）
resource.maxLevelForFamily(16); // → 3（雷神普通田封顶 3 级）
resource.maxLevelForFamily(1); // → 5（石油到 5 级）
resource.resourceMeta(506); // → {family:5, level:5}
resource.isRelicTarget({ targetType: 38 }); // → true（遗迹田，不靠 RESOURCE 表）
resource.isRelicTarget({ targetType: 4, itemId: 1603 }); // → false（普通雷神田）
resource.isRelicItemId(1514); // → true（6 级田 itemId 组 15）
```

报文实证源：查询普通田真人实录（15 发 906 全量家族×等级扫描，应答 `r={itemId,amount,expireTime,allianceAreaOwner,ownerId,aid}`、顶层 `pointType=4`）。

## 8. 变更记录

- **2026-11-01 新增遗迹田识别判据 `isRelicItemId` / `isRelicTarget`**：配合「遗迹田（6 级田）永不撤回」升级为全局撤田不变量（auto-farm 时段外撤田/升级抢田 + launch-silo 腾队列三个出口同口径），并删除面板 `relicIgnoreWindow` checkbox（「遗迹田不受时段限制」从可选项变为固定行为）。三条轴：`targetType===38`（新：`core/march.js` 开始透传 856 `target.targetType`，常量真身 `FORTRESS_RES_POINT_TYPE` 下沉 `core/map.js`）> `floor(itemId/100)===15` > `RESOURCE.level ≥ 6`；都不依赖候选池。报文实证夺宝陪跑真人实录（856：普通田 targetType=4、遗迹田 38）。

- **2026-11-01 新增 `maxLevelForFamily`**：配合 auto-farm 四维 rank（种类>家族>矿脉级>设施级）改造。原因：`normal-scan.searchDown` 从通用上界 5 逐档下探，对雷神族每拍先撞 4/5 两个表里不存在的档（两行 `warn`）；`pickHigher(16, 3)` 还会把 3/2/1 这些注定不够高的档的 906 发出去再丢弃。现：起点夹族上界 + `pickHigher` 只探 `(above, 族上界]` + 已顶格零发包直回 + `probeLevel` 的空行日志降为 debug；`priority.wantsNormalProbe` 也改按族判上升空间（免白占 5 分钟探测名额）。

- **2026-11-01 初版**：新建 `core/resource.js`，从 `auto-farm/normal-scan.js` 下沉 `findGroupType`→`groupTypeFor`、`resourceMeta`、`NORMAL_MAX_LEVEL`→`RESOURCE_MAX_LEVEL`（normal-scan 改 import + 在 `normal` 单例透传 resourceMeta、`NORMAL_MAX_LEVEL` 保留为别名供 priority 消费）。同步为 [`core/map.js`](map.md) 新增 `searchPoint`（906 只读查询骨架），把 auto-hunt / fear-star-rally / normal-scan 三处 906 手抄与 mech-build 的选地一并改调底座：**mech-build 选地从 901 视口普查切换为 906 服务端逐级降序搜索**（删 `surveyCenters/rankCandidates/runSurvey/peekCandidate/advanceCursor/pickBuildPoint` + `candidateCap`/`buildRadius` 面板字段）。验证：arch 0 违规（136 模块 / 615 依赖）、lint 0 error、build 三入口 OK、`node --test` 17 通过（mech-build 单测随下线函数移除 `rankCandidates`/`surveyCenters` 用例，`isFreeField`/`planFamilies`/账本回归全绿）。
