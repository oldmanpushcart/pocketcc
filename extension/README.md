# extension — pocketcc 浏览器扩展

口袋奇兵（Top War，`warh5.rivergame.net`）H5 页游的个人辅助 **Chrome MV3 扩展**。把重复性的日常/活动操作（祝福领取、联盟协作、采集派遣、限时活动、地图侦察、聊天）与登录/断线恢复自动化，全部跑在游戏页面自己的 **MAIN world** 里，复用游戏已登录的会话，不碰账号凭据的加解密。

> 属于 [pocketcc](../README.md) 仓库；配套可选的报文接收服务见 [`dashcam/`](../dashcam/README.md)。
> 个人逆向学习与自用项目。使用第三方辅助可能违反游戏用户协议，风险自负。

## 目录

- [特性](#特性)
- [架构](#架构)
- [目录结构](#目录结构)
- [构建与安装](#构建与安装)
- [打包与发版](#打包与发版)
- [使用](#使用)
- [控制台调试面](#控制台调试面)
- [开发约定](#开发约定)
- [路线图](#路线图)

## 特性

- **免扫码自动登录** — 缓存游戏自己的 `serverToken` 并在下次启动时重放，跳过扫码页；补一个「登出 / 换号」按钮（游戏在自动复用 token 后默认无法主动换号）。
- **自动重连** — 监听断线弹窗与流量停滞，按配置间隔调度整页重载恢复会话；会话恢复健康后自动清零计数。
- **泰坦祝福** — 推送驱动：活动推送一到即领取，零轮询。
- **联盟帮助** — 轮询各类帮助石头并自动协助/领取，按 kind 去重。
- **采集与限时活动自动化** — 领域寻宝（挖矿）、海上夺宝、占领发射井、花车空投、自动下田、遗迹奖励：以「推送 + 主动扫描 + 兜底定时」组合触发拉取目标，名额判定后逐条派遣；被服务器以「剩余时间不足以行军」拒派或撞限额的目标当日拉黑，等它从名单消失才解禁。
- **联盟协作** — 联盟集结（按战锤/惧星/难民营分段设置）、联盟礼物、联盟科技、联盟机甲，覆盖捐赠/协助/出征的日常协作。
- **战争之源** — 限时世界 BOSS：以回包 `finishTime` 为在场窗口排表、慢扫补派，不轮询空跑。
- **次元矿洞** — 挖矿与盗窃封存双引擎，预算驱动（剩余次数 / 时间窗 / 冷热加权）规划动作。
- **城市技能 / 玩家点赞** — 日常一键操作自动化。
- **快捷战斗 / 奉旨出征** — 战斗辅助：面板驱动的快捷攻击（`Shift+1-8` 三连：先派预设再最小出征）与奉旨出征批量发包。
- **全局地图** — Shadow DOM 浮层：分区扫描全图点位、按归属/等级/护盾筛选、色块底图，支持跳转/取点，几何与扫描数据落盘（`Ctrl+M` 开合）。
- **聊天窗口** — 半透明浮层：世界/联盟等多频道收发的独立视图，支持 @点名、引用、坐标跳转、撤回、玩家信息卡；只读游戏态、经 `pocketcc.chat` 收发，不改写游戏任何状态（`Ctrl+K` 开合）。
- **游戏内快捷键** — `Tab` 飞回基地、`H` 基地↔大世界、`B` 背包、`Esc` 关闭当前弹窗、`1-8`+`G` 在战斗面板选预设并出征；`F8` 切日常/战斗模式。全局输入层单监听统一分派（打字自动让位、修饰键放行、按场景门控）。
- **报文录制（黑匣子）** — 默认关闭，开启时仅 tap 缓冲 + 定时批量落盘，绝不阻断游戏真实收发；落盘由本仓库的 [`dashcam/`](../dashcam/README.md) 承接（见[架构](#架构)）。
- **日志上送** — 与报文录制平行的独立开关（不同存储键/不同端点）：`core/log.js` 单点 tee 到 `core/log-collect.js`，缓冲+连续同文案折叠后批量 POST 到 dashcam `/log`；长期常开设计，热路径仅一次判空+push（序列化/网络全部延迟到 flush），录制器自身日志走 quiet 豁免防自录回声。
- **战斗模式总开关** — 面板上的全局开关（或热键 `F8`）：开启时派行军类的功能主动挂起，纯发包类与会话看门狗继续跑；浮动图标同步切换日常/战斗双态并带呼吸光晕。
- **在线自动升级** — 本地壳季度级换一次，日常只把新远程体传 OSS：后台每 4h 检查、下正文、双验（SHA-256 + HMAC）后只落缓存，面板/角标/欢迎页脚提示「刷新页面即生效」；OSS 挂了照旧跑包内基线，零中断。
- **菜单树驱动面板** — Shadow DOM 左右两栏：左为类别 TAB（日常设置 / 战斗设置 / 地图设置 / 系统设置，切换只换右栏），右为卡片列表（组卡片带主闸门开关，关则级联停用子项；功能卡片带启用开关，可展开详细字段）。层级定义在 `core/menu.js`，字段/存储/默认值仍在各功能 descriptor；日常任务与快捷战斗只出 checkbox 不需详细参数，改动即存档即生效。

## 架构

Chrome MV3。清单只引用 `dist/*` 的 esbuild 产物（IIFE；dev 构建未压缩 + sourcemap 以保控制台栈可读，release 构建 minify 且去 sourcemap）。注入目标 `https://warh5.rivergame.net/*`：

| 入口                   | world          | 职责                                                                                           |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `dist/anti-throttle.js`| MAIN           | `document_start` 就位：对抗后台标签页的定时器/RAF 节流，必须早于游戏与壳                          |
| `dist/shell.js`        | MAIN           | **本地壳**：向 bridge 取「本地已就绪的最优远程体」并 `new Function` 执行；不等网络，执行报错则当场降级跑包内基线 |
| `dist/remote.js`       | MAIN           | **远程体**（feats + core 全量）：与游戏同域同上下文，hook 游戏网络层与控制器，跑全部功能。同一个文件既上传 OSS、也留在包内作离线基线 |
| `dist/bridge.js`       | ISOLATED       | 唯一持 `chrome.*` 的一侧：代理 `chrome.storage` 读写给 MAIN；把报文转发给 background；中继升级命令与状态广播 |
| `dist/background.js`   | Service Worker | 唯一出网口：代发 `fetch POST http://127.0.0.1:7391/ingest` 到本地 dashcam；跑升级状态机（拉清单/下正文/验签/写缓存/`alarms` 定时复检） |
| `dist/popup.js`        | 扩展弹窗       | 登录凭证导入导出                                                                                 |

`manifest.json` 权限：`storage` / `unlimitedStorage` / `scripting` / `activeTab` / `alarms`；`host_permissions`：`http://127.0.0.1/*`、`http://localhost/*`（报文录制 POST 到本地 dashcam）+ 升级域名（发布构建按通道基址自动追加，缺则 SW 的 GET 被拦）。顶层 `key` 固定扩展 ID，供 OSS CORS 与长期身份复用；tracked 这份存的是 **dev key**，正式与快照的 key 在 `channel-keys.json`，打包时按通道注入（见「发布通道」）。

核心是 **EventBus + 两层 reactor**：

- **EventBus**（`core/bus.js`）— 事件类：`net.<cmd>`（游戏推送/应答）、`session.*`（会话健康）、`scene.*`（cc 场景切换）、`mode.change`（战斗模式）、`tick.*`（定时）。
- **reactor**（`core/reactor.js`）— 功能以「说明书」形态注册（触发器 + 可选 produce→queue→drain）；门控是**可注册集合**（`shouldRun = enabled && 所有门控通过`），现有 scene 门控（`Home`/`NWorldMap` 白名单）与 mode 门控（`offInCombat`）。门控翻 false 走 pause（退订推送、停定时、在飞流程自然退出、保留队列与配置），翻回 true 走 resume 并补扫一轮。
- **底座自注册全局** — `net`/`event`/`chat`/`net-collect` 挂在 `window.pocketcc.*`，各功能经全局访问而非互相 import，避免循环依赖：
  - **net**（`core/net.js`）— `NetMgr` 的 promise 封装（`send`/`sendPBV2`/`isSending`/`Ret`，15s 应答超时防 await 挂死）+ `NetReciver.onMessage` 单点 hook，把游戏推送派发到 bus；`collecting()` fluent builder 提供报文观测面。
  - **event**（`core/event.js`）— `EventCenter` 的按需订阅封装（`ctx.on.event` 退订自动登记、pause 统一摘除）。
  - **chat**（`core/chat.js`）— 对 `NetChatClient` 的薄封装，只读 + 发包。

报文录制链路（跨进程，绕页面 CSP）：

```
MAIN core/net-collect.js  ──postMessage──▶  bridge.js  ──chrome.runtime──▶  background.js  ──fetch POST──▶  dashcam /ingest
   (缓冲 NDJSON)                            (ISOLATED)                      (service worker)                (按会话落盘 .ndjson)
```

日志上送链路（同一通道、不同 op/端点，两个开关互不依赖）：

```
MAIN core/log.js sink tee ──▶ core/log-collect.js（缓冲+折叠）──postMessage(op=dashcam-log-flush)──▶ bridge ──▶ background ──▶ dashcam /log（按小时轮转）
```

两个开关都关时 dashcam 无需运行，扩展完全独立可用。

### 目录结构

```
extension/
├─ docs/                     设计文档：核心 API（一模块一篇：职责边界/取舍/契约/降级）+ `adr/` 架构决策记录，见 [docs/README](docs/README.md)
├─ manifest.json             MV3 清单（只引用 dist/*；顶层 key 存的是 dev 通道那一条）
├─ channel-keys.json         snapshot / release 两档的 manifest.key（仅公钥派生物、不含私钥），打包时按通道注入
├─ assets/                   图标 16/48/128 三档 PNG
├─ dist/                     esbuild 产物（gitignore，不入库）
└─ src/
   ├─ shell.js              MAIN 薄壳入口（document_idle）：取本地就绪的远程体 → exec → 报错即降级跑包内基线
   ├─ remote.entry.js       远程体入口；import 顺序即加载顺序：底座 → feats → boot
   ├─ anti-throttle.js      document_start 反节流（MAIN，早于壳与游戏）
   ├─ bridge.js              ISOLATED 入口（chrome.storage 代理 + 转发 background + 中继升级状态）
   ├─ background.js          service worker（代发 POST 到 dashcam、升级状态机，均绕开页面 CSP）
   ├─ boot.js                编排器（场景监视/自动登录/重连 hook/启动闸/UI 挂载）
   ├─ core/                  全部跨玩法底座 + reactor 生命周期层
   │  ├─ net.js             网络底座（window.pocketcc.net：NetMgr 封装 + 推送派发）
   │  ├─ update.js          升级通道判据单一真相（版本/清单解析/地址拼接/就绪选择/下载决策/验签/提示口径），纯函数无 I/O
   │  ├─ update-client.js   MAIN 侧只读镜像：向 bridge 取快照、订阅状态广播，供面板/角标/欢迎页脚消费
   │  ├─ net-collect.js     报文黑匣子流式录制（window.pocketcc.netCollect）
   │  ├─ net-payload.js     报文编解码辅助
   │  ├─ event.js           EventCenter 封装（window.pocketcc.event，按需订阅/退订）
   │  ├─ chat.js            聊天通道薄封装（window.pocketcc.chat）
   │  ├─ battle.js          行军发包载荷构造（预设 / 最小出征，跨战斗 feat 共享）
   │  ├─ bus.js             EventBus（单例、emit 恒同步）
   │  ├─ reactor.js         两层模型 + 可注册门控（说明书生命周期）
   │  ├─ registry.js        descriptor 驱动配置单一真相（组配置读盘/存档、intent 补全）
   │  ├─ menu.js            面板菜单树（类别→组/功能）单一真相，组闸门语义在此声明
   │  ├─ game.js            游戏模块 hub（__require 集中；缺失软失败返回 null）
   │  ├─ game-api.js        ACL 防腐层共享区段（l10n / gameData / worldMap / march 等；活动适配器已下沉各 feat 的 api.js）
   │  ├─ acl-engine.js      ACL 引擎核（SYM 共享表 / probe 惰性探测 / CAPS 自检 / createAcl 工厂，feat api.js 经它共用单例）
   │  ├─ player.js          UID 与玩家态
   │  ├─ storage.js         MAIN 侧 chrome.storage 代理客户端（UID 前缀下 config/data 两个 blob）
   │  ├─ session.js         会话健康广播 + 自动重连
   │  ├─ auto-login.js      token 缓存重放（免扫码）
   │  ├─ scene-watcher.js   cc 场景信号（EVENT_AFTER_SCENE_LAUNCH）→ scene.* 事件
   │  ├─ mode.js            战斗模式布尔 + mode 门控（不持久化，默认日常）
   │  ├─ hotkeys.js         全局快捷键注册表（单监听统一分派：打字让位 / 修饰键放行 / 场景门控）
   │  ├─ drain.js           通用消费循环（produce→queue→drain 的 drain 段）
   │  ├─ ui/                表现层（拆自旧 ui.js）：Shadow DOM 浮动图标 + 左 TAB 右卡片面板
   │  │                     index.js 编排 mountUI；panel/fields/widgets/wire 渲染与事件；welcome.js 启动署名告知页；
   │  │                     consts/dom/icon-pos/panel-css/icon-svg 为零依赖叶子原语
   │  ├─ log.js             统一日志 [POCKETCC://MODULE]
   │  └─ constants.js       实例命名收口：两 world 的 postMessage 协议命名空间 NS、存储前缀根段与发布通道后缀
   └─ feats/                功能模块（目录层级对齐面板菜单树五类别，均向 reactor 注册说明书）
      ├─ player/            玩家设置：daily-supply / armory-material / secret-weapon-drop / one-click-claim /
      │                     player-like / source-of-war/ / truck-intercept / auto-farm / auto-hunt /
      │                     fear-star-rally / mine-cave/ / beast-breed / city-skill
      ├─ alliance/          联盟设置：alliance-help / alliance-gift / alliance-science / alliance-behemoth /
      │                     alliance-rally / alliance-boss / relic-reward
      ├─ activity/          活动设置：sea-treasure / mecha-treasure / domain-treasure / titan-blessing /
      │                     floatcar / launch-silo / secret-realm/
      ├─ battle/            战斗设置：quick-attack（快捷战斗）/ imperial-decree（奉旨出征）/ auto-defense（自动防御）
      └─ system/            系统设置
         ├─ chat/           聊天窗口：chat-window / chat-overlay / classify
         ├─ map/            全局地图与镜头跳转：global-map（+ render / scanner / store / terrain / map-overlay / map-meta）/
         │                  quick-jump（+ jump-overlay）
         └─ hotkey/         游戏内快捷键行为：fly-home / scene-toggle / open-bag / close-popup / battle-panel / aux-docs
```

## 构建与安装

前置：Node.js（开发用 esbuild，扩展无运行时依赖）。构建脚本在**仓库根**的 `package.json`。下面先给日常调试那一条（dev 档）；三档完整命令与产物目录见「[三档构建速查](#三档构建速查)」，版本号怎么抬见「[版本号规则](#版本号规则三段式-xyz)」：

```bash
# 在仓库根执行
npm install
npm run build     # 或 npm run watch（壳侧 + 远程体各入口并行监听）
```

加载到 Edge/Chrome：

1. 打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」。
2. 「加载解压缩的扩展」选择 **`extension/` 这一层**（直接含 `manifest.json` 的目录；选仓库根或 `dist/` 会报清单缺失）。
3. 打开游戏页登录即可。**改完源码必须 `npm run build` 并 F5 刷新游戏页面**（不是只重载扩展）——MAIN world 的 monkey-patch 只有干净页面才清得掉。

### 开发调试与升级通道

日常调试**不需要任何密钥**：dev 构建（`npm run build` / `watch`）把 `__OSS_BASE__` 与 `__UPDATE_KEY__` 一律注入空串，`configured()` 即为 false，`runCheck` 开头就把状态归 `unconfigured` 直接返回——不发请求、不下载正文，跑的是磁盘上你刚构建出来的那份 `dist/remote.js`。dev 构建也不碰 `host_permissions`，不会撤销发布用的那条域名权限。

一个细节以前会咬人、现在不会了：`serveBundle` **不看 `configured()` 闸门**，它照样读升级缓存、与包内基线比个高并取高的那份执行。早期 dev 与发布壳共用一个 `manifest.key`（⇒ 同一个扩展 ID ⇒ 共用 `chrome.storage.local`），装过发布壳再回 dev 调试就会被那份旧缓存抢先。现在三档通道各持一组 key、各是独立实例（见下节「发布通道」），dev 读的是 `pccupd.dev:bundle`，与正式/快照的缓存天然分开，不需要再手动「清除已下载包」。

一句口诀：**调试不带钥，发版才带钥**。但 `UPDATE_BASES` 一旦填成真实地址，`esbuild.config.mjs` 那道「有基址、无密钥即退出」的 fail-fast 就对所有发布形态生效（`build:release` / `pack:release` / `pack:snapshot` / `publish:release` / `publish:snapshot`）——这些都必须先设好 `PCC_UPDATE_KEY`；只有 `npm run build` / `watch`（dev 通道）不需要。

两条与「壳 exec 远程体」这个注入方式绑定的调试事实：

- 代码跑在 eval 里，Sources 面板的落点是 `(eval)`；最省事的断法是**在想停的位置写一行 `debugger;`**。去 `Page → chrome-extension://…/dist/remote.js` 那个文件上打断点大概率不命中——那是包内资源实例，与被 eval 出来的那份不是同一个 script。`__DEVTOOLS__` 门控的调试探针在 dev 构建里照常保留。
- 跑完 `pack:release` / `publish:release`，`extension/dist/` 会停在 release 形态（minify、无 sourcemap、通道开启）。回调试前补一句 `npm run build`；判断自己处在哪种形态，看 `dist/remote.js.map` 在不在最省事。

## 打包与发版

发版是两件事：**换壳**（季度级，朋友要重新加载一次目录）与**发远程体**（日常，朋友零动作、刷新页面即升级）。

| 层 | 内容 | 变更频率 | 朋友侧动作 |
| --- | --- | --- | --- |
| 本地壳 | `manifest.json` + `dist/{shell,bridge,background,anti-throttle,popup}.js` + `dist/remote.js`（兼离线基线）+ `assets/` | 季度级重发一次 | 一次性「加载解压缩的扩展」 |
| OSS 远程体 | `pocketcc-remote-<ver>.js`（快照通道多一段摘要：`pocketcc-remote-<ver>-<sha8>.js`，见「快照通道的发布身份」）+ `latest.json` | 每次发版 | 无，刷新页面即升级 |

### 版本号规则（三段式 X.Y.Z）

**壳与远程体都遵循同一套规则**：

| 段 | 名称 | 什么时候抬 |
| --- | --- | --- |
| `X` | 主版本 | **架构上有重大调整**：注入机制/分层方式更换、存储结构不兼容、跨多个玩法的地基重构 |
| `Y` | 大版本 | **重大功能新增或删除**：新增一整个玩法大类、砍掉一块能力、面板信息架构重排 |
| `Z` | 小版本 | **小功能与漏洞修复**：单个玩法的行为修正、参数补全、崩溃或误判修复 |

四条硬约束：

- **只维护一处**：版本号的唯一真相源是仓库根 `package.json` 的 `version`。任何构建都会自动同步进 `extension/manifest.json`，出发布包时再覆写分发目录里那份——**不要手改 manifest 的版本**，改了也会被下次构建盖掉。
- **只允许三段纯数字**。Chrome 的 `manifest.version` 只接受 1–4 段纯数字，`publish-oss.mjs` 另按 `/^\d+(\.\d+)*$/` 拦一道。
- **通道名绝不进版本号**。`1.3.0-dev` 会被 `cmpVer` 判成与 `1.3.0` 同版（逐段 `parseInt` 把 `0-dev` 折叠成 0），后果是静默不更新；dev / snapshot / release 是版本号**之外**的独立维度，见下节与 [ADR-0003](docs/adr/0003-release-channels.md)。
- **正式通道内一号一正文**。`cmpVer` 相等即 `stay`，已拿到那一版的人永远不会重下；同号重发就 `Z++`（`publish-oss.mjs` 撞到同号摘要不同会 warn）。抬 `X` 若动了存储结构，须保证向后兼容，或在欢迎页/面板明说需要重新配置。
- **快照通道不看号看「发布身份」**（`版本号@摘要前 8 位`）：同号换正文照样会推更新，不必为了让客户端重下一份而抬号。详见下文「快照通道的发布身份」。

### 壳与远程体是两条各自递增的线

两者同源于一次构建、共用同一个 `package.json.version`，但发布节奏不同：

- **出壳**（`pack:release` / `pack:snapshot`）时：壳号 = 远程体号 = 当时的 `version`。
- 之后**只发远程体**：远程体号随每次发版 `Z++` / `Y++`，壳号停在上次出壳那一刻。所以面板上出现「壳 v1.0.0 · 远程体 v1.0.5」**属正常，不是 bug**。
- **不变式：壳号永远 ≤ 远程体号**。壳的号只能靠重新出壳前进，而重新出壳用的就是当下的 `version`，没法让壳单独抬号。
- 只有壳侧文件（`shell.js` / `bridge.js` / `background.js` / `anti-throttle.js` / `popup.js`）真变了才重发壳，那通常是一次 `Y` 或 `X` 级变更；清单里的 `shellMin`（发布时用 `--shell-min=` 设）就是「人手上那批壳的下限」，低于它的壳会被提示重新加载。
- 每发一版打 git tag `v<version>`；换壳另记一次。

### 发布通道（dev / snapshot / release）

同一份代码按**风险级别**出三个实例：各自一个扩展 ID、各自一份数据、各自一条更新源。通道与版本号是两个维度——`1.3.0` 可以先发快照、验过再发正式，两次都叫 `1.3.0`。为什么不能把通道写进版本号（`1.3.0-dev`）见 [ADR-0003](docs/adr/0003-release-channels.md)：`cmpVer` 会把 `1.3.0-dev` 判成与 `1.3.0` 同版，后果是静默不更新。

| 通道 | 干什么用 | 远程升级 | 编译 + 打包命令 | 分发目录 | 扩展 ID |
| --- | --- | --- | --- | --- | --- |
| dev | 日常改代码调试 | 关（注入空基址，整条通道短路） | `npm run build` | 直接加载 `extension/` | `ogmdkmglhpmlgbjdmpionopdcbfbepbp` |
| snapshot | 自己先吃真实分发链路 | 开，指 `/extension/snapshot/` | `npm run publish:snapshot`；只出壳 `npm run pack:snapshot` | `extension/out/snapshot/pocketcc-extension/` | `agagndkjekiamgceioibegbfbnhlmmkl` |
| release | 发给所有人 | 开，指 `/extension/release/` | `npm run publish:release`；只出壳 `npm run pack:release` | `extension/out/release/pocketcc-extension/` | `apdhbapmdnmbfcfcmknbclgbelcegapj` |

两条发布通道的产物统一收在 **`extension/out/`** 这个分发出口下，每个通道一层：「`extension/out/<通道>/pocketcc-extension/`」是壳、「`extension/out/<通道>/oss/`」是待上传件（正式即 `extension/out/release/pocketcc-extension/` + `extension/out/release/oss/`，快照即 `extension/out/snapshot/` 下那两份）。叶名一致、通道名在上一层分开，两批壳物理上不可能互相覆盖（dev 不出包、也不上传，直接加载 `extension/`）。

`out/` 与 `dashcam/store/` 同构：一个工程一个产物 sink，目录名不混进 `src`/`docs`/`assets` 这些工程名。它**只装分发件**，构建输出 `extension/dist/` 不在里面（那个路径写死在 tracked manifest 里、Chrome 直读，且与壳内那层 `dist/` 逐字节对应）。另提醒：别把本地 `extension/out/release/` 跟 OSS 上的远端前缀 `/extension/release/` 混了——后者是上传目标地址，与本地目录无关，改名不影响它。

三档在 `chrome://extensions` 里靠名字一眼分辨：**口袋控制中心（开发版）** / **口袋控制中心（快照版）** / **口袋控制中心**。名字在两处定：tracked 的 `extension/manifest.json` 写「（开发版）」（那个目录就是 dev 实体），出包时由 `package-release.mjs` 的 `PKG_NAMES` 按通道覆写分发目录那一份。名字与扩展 ID 无关（ID 只由 `manifest.key` 派生），改名字不换实例、不动数据，也不影响任何运行逻辑（源码只读 `getManifest().version`）。

三个 ID 由三组 `manifest.key` 派生。正式与快照的 key 存在 `extension/channel-keys.json`（只有公钥派生物、不含私钥，可入库），打包时按通道注入；tracked 的 `extension/manifest.json` 里那条是 **dev key**。这么放是为了把正式 ID 从定稿起冻结住：此后无论怎么改构建，朋友手上的实例与数据都不受影响。**换任何一条 key = 换一个全新实例**（数据从零开始），三条线定稿后别再动。

实例命名一律带通道后缀（`.dev` / `.snapshot`，正式刻意留空以便存量零迁移）：postMessage 协议名 `NS`、存储前缀 `pocketcc<后缀>.u{uid}.`、升级三键 `pccupd<后缀>:bundle|state|pref`。口径收口在 `core/constants.js` 一处，`tests/core/channel-isolation.test.js` 守这三处不漏一处。

**同时只启用一个通道。** 三套构建都往同一个游戏页注入，两套远程体并存等于同一个账号跑了两套自动化（重复出征、互相踩状态）。MAIN world 里两层各有守卫，但行为不一样，值得知道：

- **壳**：启动标志现在记的是通道名，后到的通道不执行远程体，并在控制台点名「本页已由哪个通道占用」——这是兜底，不是让你同时开着试。
- **anti-throttle**（`document_start`）：守卫仍是布尔，后加载的通道整套补丁直接跳过 ⇒ 它用的是**先加载那个通道**的补丁版本。两条通道版本不同步时，排查这段行为要按先加载者算。

ISOLATED world 的 `bridge` 每个扩展各自一份，不在此列。

### 快照通道的发布身份（版本号@摘要）

快照通道是作者自己先吃的那一条，一天可以出好几个包。若每个包都得 `Z++`，号会在一日之内从 `1.0.0` 涨到 `1.0.9`，等真要发正式时号已经被吃掉了。所以快照通道**不靠抬号来表达「换了一份正文」**，而是把发布身份做成二维：

- **release：身份就是版本号**（`1.4.0`）。上面的规则一字不变，仍是一号一正文、`cmpVer` 相等即 `stay`。
- **snapshot：身份是 `版本号@正文摘要前 8 位`**（`1.0.0@03b39054`）。版本号可以一直钉在 `1.0.0`，只要正文变了，客户端就认出这是另一份发布、照常下载并提示刷新。

摘要取的就是清单里那个 `sha256` 的前 8 位（小写十六进制），同源三处：**清单标签 / 正文文件名 / UI 展示**。于是 `pocketcc-remote-1.0.0-03b39054.js` 这个对象名自带摘要——同号换正文落在**不同对象名**上，`immutable` 永久缓存没有被违背，谁也不会被缓存挡在旧正文里；release 的对象名照旧只带版本号。

三条设计前提，改代码时别绕过：

- **摘要绝不并进版本号**。`cmpVer` 逐段 `parseInt`，`0@03b39054` 会被折叠成 `0`，那就又回到「同号判等 → 静默不更新」。身份是**版本号之外独立的一串**，只在需要回答「是哪一份正文」的地方出现。
- **分叉只由通道常量得出**：`core/update.js` 里 `DIGEST_IDENTITY = CHANNEL_NAME !== 'release'`，`identityOf(ver, sha)` 在未注入通道的构建里退化成纯版本号，所以 release 侧的行为与既有断言一字不变。`tests/core/channel-isolation.test.js` 把这个分叉也守成了源码级纪律（不许有人自己比通道字面量）。
- **人工位按身份记账**：「稍后」与隔离存的是身份串（`dismissedId` / `blockedId`）而不是版本号——快照通道里「稍后」掉的只是 `1.0.0@aa11bb22` 那一份，同号的另一份正文照旧会提示。旧键 `dismissedVer` / `blockedVer` 仍可读出（一次性兼容迁移，不抹存量配置）。

用户侧两处可见（只有快照通道带摘要，正式通道一个都不出现）：欢迎页页脚 `pocketcc v1.0.0@03b39054 · snapshot`；系统 tab 的软件更新区里「正在运行 / 本地已就绪 / 待生效」三行读数都挂身份，另有一行「就绪包摘要」给出 sha256 前 12 位供排查。判据与展示分别由 `tests/core/update-snapshot-identity.test.js`、`tests/core/ui/update-display-snapshot.test.js` 锁住。

### 三档构建速查

**dev：日常调试，零密钥、零上传**

```bash
npm install
npm run build        # 或 npm run watch（六入口并行监听）
```

在 `chrome://extensions` 加载 **`extension/`** 这一层。改完源码 → 再 `npm run build` → F5 刷新游戏页。不发请求、不读 OSS，跑的就是磁盘上刚构建出的 `dist/remote.js`。

dev 也**不出分发包**：`package-release.mjs --channel=dev` 会直接中断——另拷一份副本出去，每次 `watch` 后它就过期了，不如直接加载源码目录。

**snapshot：自己先吃真实分发链路**

```bash
export PCC_UPDATE_KEY='<与正式同一把>'   # Git Bash 写法；PowerShell / CMD 见下文「环境变量在 Windows 上怎么设」
# 需要新版才改根 package.json 的 version（通常 Z++），然后：
npm run publish:snapshot -- --notes="快照：改了行军回收"
```

产出两件（同在 `extension/out/snapshot/` 下，与正式通道同形）：待上传件 `extension/out/snapshot/oss/{pocketcc-remote-<ver>-<sha8>.js, latest.json}`（正文文件名里那段摘要就是发布身份的后半，见「快照通道的发布身份」；按「上传到 OSS」那一节的顺序传到 `/extension/snapshot/`）与分发壳 `extension/out/snapshot/pocketcc-extension/`（**只需装一次**，之后靠自动升级）。只想出壳不发布：`npm run pack:snapshot`。

快照通道不必为「让人重下一份」抬号：代码改了就发，正文摘要一变，客户端自然认出是新的一份发布（`package.json` 的 `version` 可以一直停在 `1.0.0`）。

**release：发给所有人**

```bash
export PCC_UPDATE_KEY='<同一把>'
npm run publish:release -- --notes="修了自动下田卡格"
```

产出 `extension/out/release/oss/` 两个待上传件（传到 `/extension/release/`）与 `extension/out/release/pocketcc-extension/`（要压缩发朋友的那份壳）。只出壳：`npm run pack:release`。

**转正（快照 → 正式）不必升号**：同一批代码跑一次 `npm run publish:release`，把新出来的 `extension/out/release/oss/` 那两个文件传上去即可；朋友侧零动作。

**缺密钥时的表现**：`pack:release` / `pack:snapshot` / `publish:release` / `publish:snapshot` 都会 fail-fast 报「配了升级基址却没给 HMAC 密钥」；只有 dev 不受影响（它就是靠空串把整条远程通道短路掉的）。

### 出壳：`npm run pack:release`（快照：`npm run pack:snapshot`）

命令串两步：`esbuild --release` → 组装分发目录，输出到：

```
extension/out/release/pocketcc-extension/
├─ dist/          各入口产物（仅 *.js 与 popup.html，无 .map）；remote.js 既是被 exec 的正文也是包内基线
├─ manifest.json  version 覆写为当前构建版本
└─ assets/        图标
```

目录名固定不带版本号，便于朋友按同一路径加载、下次换壳原地覆盖。快照通道走 `npm run pack:snapshot`，输出到同构的 `extension/out/snapshot/pocketcc-extension/`（壳目录按「`extension/out/<通道>/pocketcc-extension/`」统一格式）——**两个目录的差别只有 `manifest.key`（⇒ 扩展 ID）与注入的基址**，其余逐字节同形。

release 构建相对开发包的差异：`minify: true` + **关闭 sourcemap** + 去 legal 注释。壳与远程体都只 minify、**不做二次混淆**（远程体执行的是你写的代码，可审计性优先）。

把整个 `extension/out/release/pocketcc-extension/` 文件夹压缩发过去，对方走 `chrome://extensions`（或 `edge://extensions`）→ 开「开发人员模式」→「加载解压缩的扩展」选这一层目录即可（是已解压扩展，不是 .crx）。提前告知：

- Chrome 会定期弹「请停用开发者扩展」，属正常现象。
- 不做 CRX 与 `update_url` 自托管更新：普通 Windows 设备上会被标 `[BLOCKED]`、sideload 的 CRX 会被自动禁用，故升级能力全走「壳内远程体」这一条路。
- 主城就绪后起功能与面板，并顺带弹一个署名欢迎页（非模态告知，不点也不影响使用）。

### 发远程体：`npm run publish:release`（快照：`npm run publish:snapshot`）

下面按正式通道写，快照走同一条流程、只是命令带 `--channel=snapshot`、目录换成各自那份（速查见上文「三档构建速查」）。

两个前提：`esbuild.config.mjs` 顶部的 `UPDATE_BASES` 已填成真实地址（按通道取；留空即该通道不启用，脚本会 fail-fast），HMAC 密钥走环境变量 `PCC_UPDATE_KEY`（**不入库、不写进脚本**）。两个常量都是构建期常量、运行期不可改，但管的完全是两件事：

| 常量 | 管什么 | 换成另一个的代价 |
| --- | --- | --- |
| `UPDATE_BASES[channel]` | **去哪拿**。清单地址 = 基址 + `latest.json`；正文地址 = 基址 + 清单里的相对 `file`。它是客户端唯一的信任边界 | 地址烧在壳里、面板刻意不提供配置项 → 换基址等于重发所有人手上的壳 |
| `PCC_UPDATE_KEY` | **拿到的是不是我签的那份**。发布侧用它签清单里的 `hmac`，运行侧 SW 用同一把对下载的正文复算 HMAC，与 SHA-256 组成双验 | **一把长期固定复用**。换钥 = 老壳对上任意新清单全部验签失败、连续三次即熔断，也只能重发壳 |

地址不是秘密（本来就在每个人手上），所以 `UPDATE_BASES` 写进仓库是设计使然；密钥一旦入库，任何人 fork 就能自己签包，所以它只来自环境变量或 `--update-key=`。

#### 环境变量在 Windows 上怎么设

只在你要发版的那**一个终端窗口**里设（会话级），关掉就没了，不需要动系统环境变量也不需要重启：

```bash
# Git Bash
export PCC_UPDATE_KEY='<密钥>'
```

```powershell
# PowerShell：务必单引号，双引号会让 $ ` ! 被解释
$env:PCC_UPDATE_KEY = '<密钥>'
```

```cmd
:: CMD：引号包住整串，否则值会把后面的命令一起吃掉
set "PCC_UPDATE_KEY=<密钥>"
```

设完先确认不是空串、又不把密钥打印出来：`echo ${#PCC_UPDATE_KEY}`（bash）或 `$env:PCC_UPDATE_KEY.Length`（PowerShell）。三个坑：

- 粘贴时带进了换行或中间空格。构建侧只 `trim()` 首尾空白，中间多一个字符就等于换了一把钥 → 全部客户端验签失败。
- 别用 `setx` 或系统属性面板设永久值：明文常驻易被其他进程读到，而且 `setx` 对**已开的窗口无效**，最常出现的怪事就是「我明明设了怎么还报缺钥」。
- 密钥丢了或换了都得重发所有人的壳，所以第一次就把它存进密码管理器，此后每次发版粘同一个值。

发版命令本身：

```bash
# 在仓库根执行；--notes 会进清单供面板展示
npm run publish:release -- --notes="修了自动下田卡格"
```

脚本零第三方依赖，且**不直连 OSS**（AccessKey 不落脚本），只做四件事：跑一次 release 构建 → 对 `dist/remote.js` 算 SHA-256 + HMAC → 落 `extension/out/release/oss/pocketcc-remote-<ver>.js` 与 `extension/out/release/oss/latest.json` → 自检「地址三处同值」（源码常量 / 已内联进 `background.js` 的值 / `manifest.host_permissions` 条目）后打印上传清单与顺序，再按下一节传那两个文件。

一次构建同时出「要上传的正文」与「分发包内基线」，两者逐字节一致、版本口径不分家。`extension/out/release/oss/` 里的旧版本正文不删：清单的 `versions[]` 留最近 5 条作回滚索引。

其余旋钮：`--channel=` 是主旋钮（一次定下基址、待上传目录与分发目录，见上节与「发布通道」）；`--min=<ver>` / `--shell-min=<ver>` 是人工吊销位（低于它的版本不再供下载，客户端横幅改口为「此版本已停止支持，请重新加载扩展」且不给刷新按钮），缺省从上一份清单继承、**脚本绝不自动上抬**；`--oss-base=` / `--update-key=` 临时覆写（试跑 `--oss-base=` 会把该域名追加进 `extension/manifest.json`，不想入库就记得删；同 origin 不重复追加）；`--oss-dir=` / `--pkg-dir=` 单独点名目录（只在绕开通道缺省时用）；`--dry-run` 只算摘要与自检、待上传件不落盘，且**分发包只构建到 `.reviewtmp/dryrun-pkg-<通道>/`、绝不碰真实壳目录**（出壳那一步会把 `--update-key=` 一并内联进 `dist/background.js`，早前版本拿一把试跑的钥干跑一次就能把人手上那批壳作废：扩展 ID 未变、装上却恒定验签失败）。但**仍会跑一次 release 构建**，`extension/dist` 会变成发布形态，跑完记得 `npm run build` 回 dev。

### 快照通道：先自己吃这一天构建

两档发布**不能共用一份 `latest.json`**——基址烧在壳里、客户端只认自己那一份清单，共用就等于把没验过的包推给所有人。一个 `--channel=snapshot` 旋钮一次定下三件事：基址（`/extension/snapshot/`）、待上传目录（`extension/out/snapshot/oss/`）、分发目录（`extension/out/snapshot/pocketcc-extension/`）。命令见上文「三档构建速查」，与正式发版只差一个 `snapshot`。

两条通道各读各的 `prev` 与 `versions[]` 回滚史，互不串味。上传照旧按下一节的两步顺序，只是本地目录换成 `extension/out/snapshot/`、OSS 上的目标前缀换成 `/extension/snapshot/`。

**同号双通道是故意支持的**：`1.3.0` 发过快照，转正就以 `--channel=release` 再发一次同一个 `1.3.0`，不必升号——两条通道各读各的 `prev`、各记各的版本史，一次发布不会拿另一档的正文来比摘要（`publish-oss.mjs` 的「同号摘要不同」告警也就只在 release 生效）。至于**同一条通道内能不能同号重发**，两档分道：release 仍是一号一正文（`cmpVer` 相等即 `stay`，已拿到的人不会重下），要重发就 `Z++`；snapshot 比的是发布身份（`版本号@摘要前 8 位`），同号只要正文不同就会推下去，不必为了「让人重下一份」而抬号（哪一段抬、为什么不能拿后缀当通道、为什么摘要不并进版本号，见上文「版本号规则」与「快照通道的发布身份」）。

> 早期本节写过「快照版本号只能走第四段（`1.1.0.1`）」，那是通道还没成为独立维度时的绕行办法，**现已作废**，别再照做（理由见 [ADR-0003](docs/adr/0003-release-channels.md)）。快照壳也是一次性人工动作：装 `extension/out/snapshot/pocketcc-extension/` 那一层，它与正式壳是**两个不同 ID**，能共存于浏览器，但记得只启用一个。快照稳定了转正：跑 `npm run publish:release`，朋友侧照旧无需任何动作。

dev 通道刻意没发布命令：`publish-oss.mjs --channel=dev` 会直接中断——它没有基址也没有可签的正文，发布它没有意义。

### 上传到 OSS（顺序不能反）

1. 传 `extension/out/release/oss/pocketcc-remote-<ver>.js`，HTTP 头填 `Cache-Control: public, max-age=31536000, immutable`（文件名自带版本——快照通道还自带摘要段——可永久缓存）。
2. 浏览器直接打开该 URL，**能看到一大段 JS 文本才继续**。这一步没过就传清单，客户端会指向一个还不存在的文件，连续失败三次即熔断。
3. 传 `extension/out/release/oss/latest.json`，HTTP 头填 `Cache-Control: no-cache` —— 不设，新版会被缓存挡住，最长要等一轮 alarms（4h）才看得见。以后每次发版：正文是**新增**，清单是**覆盖**。
4. 传完别在控制台编辑这两个文件：字节一改摘要就对不上。`Content-Type` 不用管（客户端只按文本读）；清单里的 `size` 仅展示，真校验只认 `sha256` + `hmac`。

发快照时上面四步一字不改，只把本地待上传目录 `extension/out/release/oss/` 换成 `extension/out/snapshot/oss/`、OSS 上的目标前缀换成 `/extension/snapshot/`（正文文件名多了一段摘要，不影响步骤）。**两个通道的文件绝不互抄**：清单里的 `hmac` 虽同钥可算，但 `versions[]` 回滚史各自一份。

快照通道同号重发时记得：旧正文对象**别删也别盖**（immutable 缓存里已经存着它，删了会让旧机器回滚不了），只需覆盖清单。

清单请求带 `?_t=<时间戳>` 查询串：若前面套了 CDN，要么开「保留查询参数」，要么对 `latest.json` 显式不缓存。

### 装机与端到端自测

装壳是一次性人工动作：`chrome://extensions`（或 `edge://extensions`）→ 开发者模式 → 「加载解压缩的扩展」选 `extension/out/release/pocketcc-extension/` 这一层（快照通道则是 `extension/out/snapshot/pocketcc-extension/`；两个都能装，但**只启用一个**，见「发布通道」）。

**第一次装完什么都不会发生，这是对的**：包内基线的版本 = `manifest.version`，清单的 `latest` 也是同号、正文又同源于一次构建（快照通道连摘要也一致 ⇒ 同一个发布身份），`pickBundle` 走到「身份未变」→ `stay / uptodate`，既不下载也不出横幅。此时通道状态应为 `uptodate`，面板不给任何升级提示；出现 `unconfigured`（基址或密钥没吃到）、`failed`（校验未通过）或 `fused`（已熔断）才是问题。

要验整条下载链路：正式通道发一个真新版本，只把根 `package.json` 的 `version` 按上节规则抬一级（小修小补就 `1.0.0` → `1.0.1`，**代码一行不用改**——版本号会内联进远程体的 `__PCC_VERSION__`，正文天然与上一版字节不同，不撞同号禁忌），`npm run publish:release` → 只传 `pocketcc-remote-1.0.1.js` + 覆盖 `latest.json` → 游戏页**刷新一次**收到横幅「新版 v1.0.1 已下载完成，刷新页面即生效」→ **再刷新一次**才生效，面板转为「已下载的新版 · v1.0.1」。这两次刷新的分工就是整套设计：第一次只走「取清单 → 下正文 → 双验 → 落缓存」，第二次才由壳从缓存 handOff。

快照通道要验同一条链路不必抬号：代码改一处（或干脆不改，只等构建时间戳类字节变）再 `npm run publish:snapshot`，新正文摘要就与基线不同，客户端会把它当另一份发布拉下来——面板上两份正文会显示为 `v1.0.0@03b39054`（正在运行）与 `v1.0.0@aa11bb22`（本地已就绪）。

### OSS 一次性配置

1. 本仓库当前用的是裸 bucket 域名：`https://pocketcc.oss-cn-beijing.aliyuncs.com/extension/release/`（即 `UPDATE_BASES.release` 现值，快照另有其行）。更稳的做法是**自有域名 CNAME 到 bucket**（如 `pcc-update.<你的域>` → `bucket.oss-<region>.aliyuncs.com`）：地址烧在壳里且刻意不做成可配置项，将来换 bucket / 换 region / 套 CDN 只改 DNS 与这一行，不必重发所有人手上的壳——**壳还没发出去之前改是零成本**，一旦发出去就得按「换基址 = 换壳」计代价。
2. bucket 公共读；对象同放一个目录（**OSS 上的**前缀现为 `extension/release/`，跟本地 `extension/out/release/` 只是名字撞了、两者无关），布局扁平：`extension/release/latest.json`、`extension/release/pocketcc-remote-1.0.1.js`。
3. 两条粒度要知道：`host_permissions` 追加的是**整个 bucket 域名**（`https://<bucket>.oss-<region>.aliyuncs.com/*`）而不是那一条子路径，所以这个 bucket 里别放任何不想被读到的东西；公共读 ACL 同时允许匿名 GetObject **与匿名列举**，等于插件正文对全网可下载（本就是公开分发），别指望靠藏路径当访问控制。
4. CORS 允许 GET，两条来源：`chrome-extension://<固定ID>`（ID 由 manifest 顶层 `key` 固定）与 `https://warh5.rivergame.net`。配了 `host_permissions` 时 SW 的 GET 本就不受页面 CORS 约束，所以这一步不是硬前置，配上是为了免得日后改注入面时踩坑。
5. `latest.json` 设 `Cache-Control: no-cache`；正文文件名自带版本（快照通道另带摘要段），可长缓存 `public, max-age=31536000, immutable`。
6. 开 bucket 版本控制，误覆盖可回退。

清单里的 `file` 只允许是相对路径：客户端 `assertUrl` 禁掉协议头、协议相对、`..` 与查询串后才拼到壳内基址上。于是基址永远来自壳——一次 OSS 写权限失守也只能换正文，换不了源头。面板上**不提供「更新地址」配置项**（与 `ingestUrl`/`logUrl` 那两个本地调试工具刻意相反，此处可编辑等于开攻击面）。

### 检测与提示

触发四源：SW 唤醒即检（受 60s 最小间隔约束，MV3 下 worker 会被频繁回收）、`chrome.alarms` 每 4h、面板「检查更新」手动、壳执行远程体后一次例行补检（非强制，首装靠它把基线换成新版）。单次流程全程只写缓存、绝不碰正在运行的代码：拉 `latest.json`（1.5s 超时）→ 判发布身份新旧（正式看版本号，快照看 `版本号@摘要`）→ 下正文（6s 超时）→ `crypto.subtle` 双验 → 写全局键 `pccupd<通道后缀>:bundle`（正式无后缀；**刻意绕开 `core/storage.js` 的 UID 前缀**：升级缓存是全局的，按 UID 存会换号即丢且重复占空间）→ 广播状态。

四层提示，打扰度递增、条件互斥：

| 层 | 出现条件 | 内容与动作 |
| --- | --- | --- |
| 浮动图标角标 | 有已下载待生效的新版 | 右上角小圆点，`title`「新版本已就绪」；点「稍后」不熄它（常驻低打扰提醒） |
| 面板横幅 | 同上 | 「新版 v1.4.0 已下载完成，刷新页面即生效」（快照通道写成发布身份 `v1.0.0@aa11bb22`）+「立即刷新 / 稍后 / 锁定此版本」 |
| 欢迎页脚 | 同上 | `pocketcc v1.3.0 · 新版 v1.4.0 已就绪，刷新页面即生效`，纯告知不拦人；快照通道另在号后挂摘要与通道名 |
| 「系统」tab | 常驻只读 | 正在运行的版本与来源（已下载的新版 / 包内基线）、已就绪版本、待生效、就绪包摘要（sha256 前 12 位）、最近检查时刻、「检查更新」、自动升级开关、「清除已下载包」；快照通道三行读数都挂摘要 |

异常分路：网络失败/超时静默 + 系统 tab 记「最近检查失败」，下轮 alarms 自愈（连续 3 次即熔断停用远程通道）；验签失败必须可见——「更新包校验未通过，仍在使用 v<当前>」是**被篡改的唯一信号**；远程体执行抛错 → 壳当场降级跑包内基线并把那一版隔离（防「刷新即崩」循环）；被吊销 → 横幅不给「立即刷新」（刷新无用，必须换壳）。日志分级照项目约定：网络类 `info`、验签失败/熔断/执行降级 `warn`、逐轮细节 `debug`。

两条贯穿全案的语义纪律：**启动路径绝不阻塞网络**（壳只 exec 本地已就绪的最优版本，新版只落缓存 → 下次刷新生效；OSS 挂掉照旧跑基线）；**「已下载」不等于「已生效」**（运行期永不热替换，免得打断在途行军与 reactor 状态），所以提示口径统一为「刷新页面即生效」，且**默认不自动 reload**——朋友可能正在打 BOSS 或跨服夺宝。

## 使用

- 游戏页右下角浮动图标（可拖拽，位置记忆）；点开为左 TAB + 右卡片面板，五个类别（与 feats/ 目录层级 1:1）：
  - **玩家设置** — 「基础设置」组（每日补给 / 军火库生产材料 / 秘密武器空投 / 一键领取，只出勾选）；玩家点赞、战争之源、卡车争夺、自动下田、自动打野、惧星集结、次元矿洞、异能兽培育、城市技能各自为独立卡片（可展开详细参数）。
  - **联盟设置** — 「基础设置」组（联盟帮助 / 联盟礼物 / 联盟科技 / 联盟守卫）；联盟集结、联盟机甲、遗迹奖励为独立卡片。
  - **活动设置** — 「基础设置」组（海上夺宝 / 重装母舰 / 领域寻宝）；泰坦祝福、花车空投、占领发射井、异能秘境为独立卡片。
  - **战斗设置** — 快捷战斗、奉旨出征、自动防御。
  - **系统设置** — 聊天窗口、全局地图、镜头跳转、自动重连、网络日志、事件日志、报文录制、日志上送，以及只读的「软件更新」（版本与来源/已就绪版本/最近检查时刻）、「设置备份」（导出 / 导入，见下文）与「快捷键一览」。
- 组开关是主闸门：关掉整组即停用全部子项，重新打开恢复各子项之前的勾选（意图存 `intentEnabled`，不丢失）；子项仍可单独勾选。改动即存即生效。新功能默认关闭（不未经同意发游戏包），自动重连默认开启。
- 只出 checkbox 的功能（日常任务各项、快捷战斗）不展示详细参数，也就不把这些参数写入 local，一律用 descriptor 默认值（只持久化启用/意图两个开关态）；展示字段的功能（联盟集结、次元矿洞、自动重连等）才全量持久化。
- 面板顶部「战斗模式」为全局开关（或热键 `F8` 直接切换日常/战斗）：开启后派行军类功能挂起、图标转红热态；关闭即恢复并补扫一轮。
- 快捷键一览见面板「系统设置」，或直接记：`Tab` 飞回基地 / `H` 基地↔大世界 / `B` 背包 / `Q` 关弹窗 / `1-8`+`G` 战斗面板选预设并出征 / `Shift+1-8` 快捷三连攻击 / `F8` 战斗模式 / `Ctrl+K` 聊天浮层 / `Ctrl+M` 全局地图浮层。
- 配置存于扩展自己的 `chrome.storage.local`，**每个 UID 下固定两个键**：`pocketcc.config`（用户配置 blob：功能开关/参数/组闸门/图标位置/日志开关）与 `pocketcc.data`（运行期数据 blob：联盟集结当日计数、矿洞预算账本等，写入频繁）。两者互不干扰，「设置备份」只读前者、也只写前者。键统一 `pocketcc.` 前缀；**游戏自身的 LocalStorage 键（登录态等）原样不动**。

### 设置备份（导出 / 导入）

面板「系统设置」tab 的「设置备份」卡，两个按钮都在**远程体侧**完成，不动壳文件：导出用页面内 `<a download>`（`chrome.downloads` 要在壳侧加权限与消息通道），也不用系统保存框（那会让玩家改名，而文件名可预期正是这个功能要给的保证）。

- **只导设置，不导数据**：正文就是配置 blob `pocketcc.config` 的全部内容——功能开关与详细参数、菜单组闸门、图标位置、各浮窗几何。运行数据不带：`pocketcc.data` 与 `storage.slot` 下的分片（当日计数、矿洞账本、地图扫描缓存…）是引擎从服务器镜像出来的事实，搬去另一台机器只会以陈旧值参与决策。
- **文件名** `pocketcc-<UID>-YYYYMMDD-HHMMSS.json`（本地时刻）：大端写使「按名称排序」就是「按时间排序」，UID 进名字是为了多账号备份混在一个文件夹里也分得开。不用 Unix 时间戳（`1795745428000` 得换算才认得哪天）。
- **正文是信封不是裸 map**：`{kind:'pocketcc.settings', schema:1, uid, exportedAt, from:{remote,channel}, settings:{…}}`。导入侧必须能分辨这是设置备份还是凭证导出件，`schema` 给将来的结构变更留切分缝（比当前程序新就整份拒收，宁拒不误解析）。
- **导入是逐键并入，不是整块替换**：文件里有的键覆盖同名键，没提到的键原样保留；跨账号导入允许，但二次确认会点明「备份来自账号 X，当前是 Y」。落盘走 `storage.mergeConfig`（N 项也只回写整块一次），写完立即重读盘并全量重推（`reloadConfigsAndApply`），所以**即时生效、不必刷新页面**。
- 判据（命名、信封、逐键取舍）全在 `core/settings-io.js` 的纯函数里，用例见 `tests/core/settings-io.test.js`；落盘那面（保留键拒收、命名空间未设必报错）见 `tests/core/storage-merge-config.test.js`。

### 控制台调试面

MAIN world 暴露 `window.pocketcc`，逆向时直接戳：

```js
pocketcc.game.get('DataCenter').DATA.UserData.UID; // 取游戏单例
pocketcc.bus.has('net.10912'); // 查某推送有无功能订阅
pocketcc.bus.emit('scene.change', { name: 'NWorldMap' }); // 模拟切场景测门控
pocketcc.net.sendPBV2(8623, { activityId: 0, type: 2 }); // 手动发包看 Ret
pocketcc.reactor.list(); // 列出全部功能与运行态
pocketcc.reactor.isRunning('floatCar'); // 看某功能是否起
pocketcc.battle.buildFromPreset(0, 0); // 看预设部队造出的行军字段
pocketcc.chat.status(); // 聊天连接与房间；pocketcc.chat.on('push', fn) 收频道消息
```

## 开发约定

- 日志统一 `[POCKETCC://模块] 英文消息`；info=生命周期、debug=逐条调度、warn=异常/被拒。
- 加功能 = 写一个 `feats/<类别>/<name>.js` 调 `reactor.register(spec)`（含面板 descriptor），**再在 `core/menu.js` 菜单树挂节点、`remote.entry.js` 加 import**（两处登记缺一则功能不出现/不加载）；UI 渲染与配置存取零改动。
- **壳文件禁改清单**：`shell.js` / `bridge.js` / `background.js` / `anti-throttle.js` / `popup.js` 属本地壳，改了就得让所有人重新加载扩展——新增玩法/面板能力一律只挂远程体侧（`remote.entry.js` 及其依赖），架构红线由 `.dependency-cruiser.cjs` 的禁边守住（壳不得 import `feats/**` 与 `core/ui/**`）。
- feat 只读游戏态、只发包，绝不调用游戏 Update/Delete 改写本地数据；生命周期完全让渡给 reactor（不手写 `off()`，一律 `ctx.on.*` 托管退订）。
- 判据/hook 点以 [`references/`](../references/) 内的游戏源码镜像与真机探针为准，不按假设设计；该目录只读。
- 不建第二个游戏消息总线（`core/net.js` 已是）；trigger API 保持极小，不加投机旋钮。

## 路线图

- 联盟机甲、奉旨出征、全局地图、聊天窗口、次元矿洞等已落地；后续按 `references/` 逆向素材继续扩充活动/日常类 feat。
- 报文录制可选加落盘保留/清理策略（在 dashcam 侧）。

## 许可

未声明开源许可的个人项目（私有、暂不授权再分发）。
