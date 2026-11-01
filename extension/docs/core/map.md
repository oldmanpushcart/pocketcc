# core/map.js —— 世界地图「常量真相 + 坐标转换 + 只读查询」底座

> 源码：`src/core/map.js`。定位是**薄底座**（truth / query），不是玩法聚合层。对齐 [`core/item.js`](item.md) 的「只收口查询与标识、不聚合动词」铁律与 [`core/march.js`](march.md) 的「行为层 + game-api ACL」双层范式。

## 1. 职责与边界

**管什么**——把跨 feat 复用的**地图事实**与**只读查询**收口为单一真相：

- **协议/尺寸真相**：`TILE`（瓦片 224×162 / 半宽高 112/81）、`CELL_ASPECT`、`ZOOM_LEVELS`、`VIEW_LEVELS`（901 viewLevel 0~4 档）、`SERVER`（本服 cols=408/rows=952/gameXMax=816/gameYMax=952）、`MAP_INFOS`（按 NWorldMapType 的尺寸表）、`CMD_GET_WORLD_INFO=901`、`CMD_WORLD_SEARCH=906`、`POINT_TYPES`/`POINT_TYPE_MAP`（pointType=NWorldMapEntityType 实体字典）、`CITY_POINT_TYPE`、`FORTRESS_RES_POINT_TYPE`（=38 要塞资源，即遗迹刷出的 6 级田）。
- **可读串工具**：`shieldText()`（护盾剩余）、`fmtLargeNum()`（逐字复刻游戏 `NumUtils.getLargeNumberShow`）。
- **三系坐标互转**（原 `feats/map/coord.js` 整体迁入）：`gameToCell`/`cellToGame`/`cellToDisplay`/`displayToCell`/`cellToIndex`/`indexToCell`/`inGameBounds`/`inCellBounds`。game=服务器 tileX/tileY（奇偶行错排），cell=紧凑网格索引，display=等距像素（Cocos）。
- **只读查询（唯一发入口）**：`fetchWindow(net, x, y, opts)` —— 单窗 901「构造请求体→发送→归一应答→回吐 pointList」公共骨架，永不 reject；`pickSub(p, subs, keys)` —— 901 点位跨 p/b/r/t/m 子对象兜底取字段。
- **只读搜索骨架**：`searchPoint(net, body, opts?)` —— 906（WORLD_SEARCH_MONSTER）「isSending 门→发送→归一→抽一个可交互点」骨架，`fetchWindow` 的亲兄弟；服务端一次只按 `(groupType, minLevel~maxLevel, pointType)` 回一个点（`d.point` 或 `d.pointList[0]`），不带排序。命中判定/黑名单/taken/ownerId 等业务谓词全留调用方（逐级降序类策略由调用方循环本函数实现）。

**明确不管**（都是「全局地图」这个 feat 的私货，不是底座真相，留 `feats/system/map/map-meta.js`）：

- **扫描块网格调参** `SCAN_GRID`（7×13 定标，绑 viewLevel=1）；
- **筛选树/图例配色** `FILTER_TREE` 家族（`SUB_MAP`/`ALL_SUB_KEYS`/`CAT_MAP`/`POINT_GROUPS`）；
- **渲染样式** `GRID_STYLE`/`TERRAIN_COLORS`、**面板默认值** `DEFAULTS`；
- **归属过滤谓词** `classifyPoint`/`playerPass`（依赖 feat 上下文 selfAid/selfServer）。
- **视图/玩法引擎**全部留 `feats/system/map`：`scanner`（全图逐块 drain 扫描，自带发包节律，**不迁** `fetchWindow`）、`store`/`render`/`terrain`/`map-overlay`/`global-map`。

**对外契约**：常量与坐标转换均为纯函数、无副作用、同步；`fetchWindow`/`searchPoint` 是两个异步只读发入口，分别只读 901/906、不改写游戏任何状态，永不 reject。

## 2. 设计思路与取舍

**核心动机——解「core 不回引 feats」死结**：下沉前 `map-meta.js` 混装了两类真相——约 60% 是跨 feat 复用的协议事实（瓦片/尺寸/pointType 字典/901 命令号），约 40% 是 global-map 面板私货（筛选树/配色/默认值）。由此派生两处坏味道：

1. **defense.js 手抄副本**：`core/defense.js` 因「core 不得反向依赖 feats」铁律，无法引 `feats/system/map/map-meta.js`，只好手抄 `WORLD_BOUNDS {816,952}`（注释自证）、`RELOC_VIEW`、`pickSub`。下沉后 `WORLD_BOUNDS` 直接派生自 `SERVER.gameXMax/gameYMax`，`pickSub` 改引本模块，副本消除。
2. **跨 feat 违规 import**：`auto-farm` / `imperial-decree` 直接 `import { CMD_GET_WORLD_INFO } from '../map/map-meta.js'`，触发 `feat-not-depend-on-other-feat` 架构规则的豁免基线。下沉后二者改引 `core/map.js`，`.dependency-cruiser.cjs` 的 map-meta 豁免删除，规则回到无豁免 error。

**取舍：为什么不把 SCAN_GRID/FILTER_TREE 也下沉**——那些是「全局地图 feat 想怎么展示」的私货，换一种 UI 就会变，不是服务器契约。底座只沉淀「地图本身是什么样」的真相。

**取舍：为什么 fetchWindow 不吞掉命中判定**——严守 item.js 铁律「只收口查询、不聚合动词」。`fetchWindow` 只做「请求 + 解析 + 取点数组」这段三处同构的骨架；命中比较（auto-farm 找塔、imperial-decree 找目标点）、占用集建集（defense 按 footprint 扩格）等业务遍历留在调用方。窗口默认 20×20 单点探针恰好覆盖 auto-farm/imperial-decree 两处探针；defense 迁城占用传显式 `width:116/height:76/marchInfo:true`（x±58/y±39 大窗）。

**被否决的备选**：让 `core/map.js` 做玩法动词聚合（发 902 行军 / 911 迁城等）——否，那是各 feat 专属契约，且 march/defense 已就近自治；把渲染样式/配色也塞进底座——否，违反单一真相分类。

## 3. API 契约

**常量**（值均有实证，见 `references/游戏逆向/全局地图知识点归档.md`）：

| 符号                          | 形态                                            | 语义                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TILE`                        | `{W:224,H:162,HALF_W:112,HALF_H:81}`            | 等距瓦片像素                                                                                                                                                            |
| `SERVER`                      | `{cols:408,rows:952,gameXMax:816,gameYMax:952}` | 本服世界尺寸（game 上界 = cols·2 / rows）                                                                                                                               |
| `CMD_GET_WORLD_INFO`          | `901`                                           | 视口拉取命令号                                                                                                                                                          |
| `POINT_TYPE_MAP`              | `Object<type, {label,en,color,group,field}>`    | pointType → 字典项（由 `POINT_TYPES` 建索引）                                                                                                                           |
| `CITY_POINT_TYPE`             | `1`                                             | 玩家城池（护盾归属实体）                                                                                                                                                |
| `FORTRESS_RES_POINT_TYPE`     | `38`                                            | 要塞资源 = 王者遗迹刷出的 6 级田；也是 856 行军 `target.targetType` 的取值（普通田 4），供 [`core/resource.js`](resource.md) `isRelicTarget` 做「遗迹田永不撤回」硬判据 |
| `VIEW_LEVELS` / `ZOOM_LEVELS` | 档表                                            | 901 viewLevel 0~4 / 离散缩放档                                                                                                                                          |

**函数**：

| 方法                            | 签名                                                                                                          | 返回       | 语义                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetchWindow`                   | `(net, x, y, {k, width=20, height=20, viewLevel=1, marchInfo=false}) → Promise<{ok, code, points, err?}>`     | 点数组     | 发单窗 901，归一 `data.pointList`；失败 `ok:false, points:[]`，**永不 reject**                                                                         |
| `searchPoint`                   | `(net, {groupType,minLevel,maxLevel,pointType}, {cmd?=906}) → Promise<{ok, sent, code, point, points, err?}>` | 单点       | 发 906；`isSending` 命中回 `{ok:false,sent:false}`；无点回 `point:null, points:[]`；受理且有单点回 `{ok:true,sent:true,point,points}`；**永不 reject** |
| `pickSub`                       | `(p, subs[], keys[]) → *`                                                                                     | 首个非空值 | 按 subs 优先级进子对象找 keys，全落空回点顶层；无则 null                                                                                               |
| `gameToCell`/`cellToGame`       | `(x,y)→{cellX,cellY}` / `(cellX,cellY)→{x,y}`                                                                 | 坐标       | 奇偶行错排折半/回加                                                                                                                                    |
| `cellToDisplay`/`displayToCell` | `(cellX,cellY)→{dx,dy}` / 反算                                                                                | 像素       | 等距投影（display 近似反算，精确四象限修正交游戏）                                                                                                     |
| `shieldText`/`fmtLargeNum`      | 可读串                                                                                                        | string     | 护盾剩余 / 大数字（复刻游戏）                                                                                                                          |

## 4. 场景用法

**auto-farm 机械塔存活探针**（默认 20×20 窗）：

```js
var r = await map.fetchWindow(net, x, y, { k: userData().ServerId | 0 });
if (!r.ok) return { status: 'error' };
for (var p of r.points) {
  /* 命中 (x,y) 且 pointType=24 且本盟已建成 → 带 id/bid 返回 */
}
```

**imperial-decree 目标点探测**（同默认窗）：`fetchWindow` 后按 `(p.x|0)===x && (p.y|0)===y` 找实体点，命中返点对象、查无返 null、请求失败返 undefined。

**906 逐级降序搜普通田**（`auto-farm/normal-scan` 与 `mech-build` 选地共用；`groupType` 由 [`core/resource.js`](resource.js) 的 `groupTypeFor` 得出，本模块只管发包与取点）：

```js
// 田家族搜资源传 pointType:2；野怪/集结/惧星是另外的 (pointType,groupType)，由各自 feat 决定
var res = await map.searchPoint(net, { minLevel: lv, maxLevel: lv, groupType: gid, pointType: 2 });
if (!res.point) { if (!res.sent) return null /* 同号在途，本拍让路 */; continue /* 本级无点，降级 */; }
var pt = res.point; // 资源点读 pt.r{itemId,ownerId,amount,…}；野怪/惧星点读 pt.m{itemId,level,…}
```

**defense 迁城占用大窗**（显式 116×76 / marchInfo:true，并数 pointType=13 领土点作就绪交叉校验）：

```js
var win = await fetchWindow(net, ax, ay, {
  k: opts.serverId | 0 || 0,
  width: RELOC_VIEW.width,
  height: RELOC_VIEW.height,
  viewLevel: RELOC_VIEW.viewLevel,
  marchInfo: true,
});
if (win.ok)
  for (var p of win.points) {
    /* 除自己主城外任何实体按 footprint 扩格入占用集（仅 isKVK 时豁免 RELOC_KVK_COVERABLE 可覆盖类） */
  }
```

## 5. 数据流与降级

```
fetchWindow: body{x,y,k,width,height,marchInfo,viewLevel}
   ─net.send(901)─▶ Ret ─parseData─▶ data.pointList ─▶ {ok:true, code, points}
   send 抛错 ─▶ {ok:false, code:null, points:[], err}
   Ret 非 ok ─▶ {ok:false, code:Ret.code, points:[]}

searchPoint: body{groupType,minLevel,maxLevel,pointType}, cmd=906
   isSending(906) ─▶ {ok:false, sent:false, point:null, points:[]}
   ─net.send(906)─▶ Ret ─parseData─▶ d.point||d.pointList[0] ─▶ {ok:true, sent:true, code, point, points}
   send 抛错 ─▶ {ok:false, sent:false, point:null, points:[], err}
   Ret 非 ok ─▶ {ok:false, sent:true, code:Ret.code, point:null, points:[]}
   受理但无点/无坐标 ─▶ {ok:true, sent:true, code, point:null, points:[]}
```

降级收敛：`fetchWindow` 到 `ok:false, points:[]`；`searchPoint` 额外用 `sent` 区分「未上线（isSending/发送异常，sent=false）」与「上线了但无有效点（sent=true）」，调用方据此决定「本拍让路」还是「降级重搜」。均无需再包 try/catch。

## 6. 坑与边界

- **k（服号）必须是 `UserData.ServerId|0`**：`viewServerId()` 在 Home 场景返回 -1，`Number(-1)||0` 仍是 -1，发出 k=-1 → 服务端判非法、应答无 pointList（实证 status=3 / `world_130512`）。非正数应跳过发包。
- **901 请求 `(x,y)` 是回点区「中心」非左上角**：全图逐块扫描须按**块中心**发请求，否则漏扫最右列/最下行（该逻辑在 `feats/system/map/scanner.js`，本模块只提供单窗骨架）。
- **Int64 精度**：塔 id 等大整数从 901 取回须 `String()` 承载，防 `number` 截断。
- **迁城占用集留 defense**：那是「迁城哪些点算阻塞」的业务判据，非地图真相，不下沉。口径为「除自己主城外一切实体 footprint 均占位」，仅 `isKVK()` 时豁免权威可覆盖集 `RELOC_KVK_COVERABLE`（难民营18/世界宝藏26/野怪73/集结怪74/雷达宝藏75/国度76/援助77）——对齐 extracted `checkIsPlainTile` 的 `isKVK() && judgeTileIfCanCover(p)`，标准本服图这些点同样阻塞落点。（插件侧调用的不是游戏符号而是 `worldState.matchesKind(['kvk'])`——两者同走 `eightServerType` 形态位（整季为真），语义一致。）
- **窗口默认 20×20/viewLevel1/marchInfo=false**：仅够单点探针；覆盖搜索带须显式传大窗 opts。
- **906 视口无关、每级只回一个点**：`searchPoint` 请求体无坐标/半径，服务端一次只回单点，不带排序；「优先高级/多候选轮换」靠调用方逐级降序 + 拉黑坐标实现，不保证同级换第二个点（mech-build 建塔低频场景已接受此退化）。
- **906 的 `(pointType,groupType)` 随目标而变**：资源田 `pointType:2`、野怪 `1/61`、集结 `3/44`、惧星 `9/9100`（均非实体类型，是搜索 tab）；且应答点载荷分家——资源回 `point.r{itemId,…}`、野怪/惧星回 `point.m{itemId,level,…}`。本模块只原样回吐 `point`，读 r 还是 m 交调用方。
- **`isSending` 门命中≠失败**：`searchPoint` 回 `sent:false`，是「同号在途、本拍让路」，调用方应停止降级狂发而非当作无点继续循环下一级（否则会短时间堆发多枚 906）。

## 7. 调试面

- DevTools 探针：`tools/probe901.devtools.js`（对照 901 请求 req(x,y,w,h) 与回点包围盒）。
- 运行环境直读底座：`pocketcc` 内 `map.fetchWindow(net, x, y, {k})` / `map.gameToCell(103, 33)`（回环锚点 cell(51,33)）/ `map.POINT_TYPE_MAP[1].label`（='玩家城池'）。

## 8. 变更记录

- **2026-11-01 新增 `FORTRESS_RES_POINT_TYPE`（=38）**：「遗迹田永不撤回」全局不变量下沉时，`core/resource.js` 需要 pointType=38 这一真相但字典本体归本模块（单一真相），故沿用 `CITY_POINT_TYPE` 范式导出命名常量；resource.js 只转名为 `RELIC_POINT_TYPE`。同时 `core/march.js` 的归一化 `March.target` 透传 `targetType`（856 报文实证采集行军恒带）。

- **2026-10-09 初版（Phase1+2）**：新建 `core/map.js`。Phase1——下沉 `map-meta.js` 协议真相段（TILE/SERVER/POINT_TYPES/CMD_GET_WORLD_INFO/…）+ `feats/map/coord.js` 整体迁入；`map-meta.js` 瘦身只留 feat 私货；9 个引用方（render/store/global-map/terrain/scanner/map-overlay + auto-farm/imperial-decree）改引路径；`defense.js` 删 `WORLD_BOUNDS` 手抄副本改派生 `SERVER`、`pickSub` 改引本模块。Phase2——`fetchWindow` 收口 auto-farm/imperial-decree/defense 三处同构单窗 901 骨架。`.dependency-cruiser.cjs` 删 map-meta 豁免（跨玩法基线归零）。验证：arch 0 违规（82 模块 / 359 依赖）、lint 0 error / 10 baseline warning、build content.js 1004.3kb、format 通过。

- **2026-11-01 `searchPoint`（906 只读搜索骨架）**：新增 `searchPoint` + `CMD_WORLD_SEARCH=906`，收口此前 `auto-hunt`/`fear-star-rally`/`auto-farm/normal-scan` 三处手抄的 906「isSending 门→发送→取 `d.point||pointList[0]`」同构骨架，并为 `mech-build` 选地从 901 普查改走 906 提供底座（田轴编号真相另见 [`core/resource.js`](resource.md)）。与 `fetchWindow` 一致：只发只读查询、回原始点，谓词与逐级降序策略全留调用方。
