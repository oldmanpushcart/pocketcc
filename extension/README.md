# extension — pocketcc 浏览器扩展

口袋奇兵（Top War，`warh5.rivergame.net`）H5 页游的个人辅助 **Chrome MV3 扩展**。把重复性的日常/活动操作（祝福领取、联盟协作、采集派遣、限时活动、地图侦察、聊天）与登录/断线恢复自动化，全部跑在游戏页面自己的 **MAIN world** 里，复用游戏已登录的会话，不碰账号凭据的加解密。

> 属于 [pocketcc](../README.md) 仓库；配套可选的报文接收服务见 [`dashcam/`](../dashcam/README.md)。
> 个人逆向学习与自用项目。使用第三方辅助可能违反游戏用户协议，风险自负。

## 目录

- [特性](#特性)
- [架构](#架构)
- [目录结构](#目录结构)
- [构建与安装](#构建与安装)
- [打包与授权分发（发给朋友）](#打包与授权分发发给朋友)
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
- **游戏内快捷键** — `Tab` 飞回基地、`H` 基地↔大世界、`B` 背包、`Q` 关闭当前弹窗、`1-8`+`G` 在战斗面板选预设并出征；`F8` 切日常/战斗模式。全局输入层单监听统一分派（打字自动让位、修饰键放行、按场景门控）。
- **报文录制（黑匣子）** — 默认关闭，开启时仅 tap 缓冲 + 定时批量落盘，绝不阻断游戏真实收发；落盘由本仓库的 [`dashcam/`](../dashcam/README.md) 承接（见[架构](#架构)）。
- **日志上送** — 与报文录制平行的独立开关（不同存储键/不同端点）：`core/log.js` 单点 tee 到 `core/log-collect.js`，缓冲+连续同文案折叠后批量 POST 到 dashcam `/log`；长期常开设计，热路径仅一次判空+push（序列化/网络全部延迟到 flush），录制器自身日志走 quiet 豁免防自录回声。
- **战斗模式总开关** — 面板上的全局开关（或热键 `F8`）：开启时派行军类的功能主动挂起，纯发包类与会话看门狗继续跑；浮动图标同步切换日常/战斗双态并带呼吸光晕。
- **菜单树驱动面板** — Shadow DOM 左右两栏：左为类别 TAB（日常设置 / 战斗设置 / 地图设置 / 系统设置，切换只换右栏），右为卡片列表（组卡片带主闸门开关，关则级联停用子项；功能卡片带启用开关，可展开详细字段）。层级定义在 `core/menu.js`，字段/存储/默认值仍在各功能 descriptor；日常任务与快捷战斗只出 checkbox 不需详细参数，改动即存档即生效。

## 架构

Chrome MV3，清单只引用 `dist/*` 三个 esbuild 产物（IIFE、未压缩 + sourcemap，控制台栈可读）。注入目标 `https://warh5.rivergame.net/*`：

| 入口                 | world          | 职责                                                                                 |
| -------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `dist/content.js`    | MAIN           | 与游戏同域同上下文：hook 游戏网络层与控制器，跑全部功能                              |
| `dist/bridge.js`     | ISOLATED       | 唯一持 `chrome.*` 的一侧：代理 `chrome.storage` 读写给 MAIN；把报文转发给 background |
| `dist/background.js` | Service Worker | 代发 `fetch POST http://127.0.0.1:7391/ingest` 到本地 dashcam，绕开游戏页 CSP        |

`manifest.json` 权限：`storage` / `unlimitedStorage`；`host_permissions`：`http://127.0.0.1/*`、`http://localhost/*`（仅供报文录制 POST 到本地 dashcam）。

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
├─ docs/                     核心 API 设计文档（一模块一篇：职责边界/取舍/契约/降级），见 [docs/README](docs/README.md)
├─ manifest.json             MV3 清单（只引用 dist/*）
├─ assets/                   图标 16/48/128 三档 PNG
├─ dist/                     esbuild 产物（gitignore，不入库）
└─ src/
   ├─ content.entry.js       MAIN 入口；import 顺序即加载顺序：底座 → feats → boot
   ├─ bridge.js              ISOLATED 入口（chrome.storage 代理 + 转发 background）
   ├─ background.js          service worker（代发 POST 到 dashcam，绕 CSP）
   ├─ boot.js                编排器（场景监视/自动登录/重连 hook/启动闸/UI 挂载）
   ├─ core/                  全部跨玩法底座 + reactor 生命周期层
   │  ├─ net.js             网络底座（window.pocketcc.net：NetMgr 封装 + 推送派发）
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
   │  │                     index.js 编排 mountUI；panel/fields/widgets/wire 渲染与事件；
   │  │                     consts/dom/icon-pos/panel-css/icon-svg 为零依赖叶子原语
   │  ├─ log.js             统一日志 [POCKETCC://MODULE]
   │  └─ constants.js       两 world postMessage 协议命名空间
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

前置：Node.js（开发用 esbuild，扩展无运行时依赖）。构建脚本在**仓库根**的 `package.json`：

```bash
# 在仓库根执行
npm install
npm run build     # 或 npm run watch（三入口并行监听）
```

加载到 Edge/Chrome：

1. 打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」。
2. 「加载解压缩的扩展」选择 **`extension/` 这一层**（直接含 `manifest.json` 的目录；选仓库根或 `dist/` 会报清单缺失）。
3. 打开游戏页登录即可。**改完源码必须 `npm run build` 并 F5 刷新游戏页面**（不是只重载扩展）——MAIN world 的 monkey-patch 只有干净页面才清得掉。

## 打包与授权分发（发给朋友）

想把扩展单独授权给某个朋友（BY UID），用一条命令出「授权包」。**在仓库根执行**：

```bash
npm run pack:friend -- --uid=<朋友的游戏UID> --friend=<昵称> [--salt=<盐值>]
# 例：npm run pack:friend -- --uid=14172836401183 --friend=泷宝 --salt=longbao-2026-01
```

### 参数契约

| 参数                 | 说明                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--uid` / `--friend` | **必须成对出现**，缺一即 fail-fast 报错退出。单人单包，一个包只授权一个 UID。                                               |
| 都不给               | = **无限制包**（等同 `npm run build` 的开发自用包）：运行时闸门全部放行、不弹欢迎界面。                                     |
| `--salt`             | 可选，缺省用内置 `pcc-2026-a1`。**强烈建议每人换一个**——盐不同则哈希口径不同，一人被破解/外泄不波及其他人，也便于事后追踪。 |

### 产物与防护

命令会串起三步：`esbuild --release`（编译期注入授权常量）→ `obfuscate-release`（二次混淆）→ 组装分发目录，输出到：

```
release/pocketcc-extension-for-<UID>/
├─ dist/        content.js / bridge.js / background.js（仅 *.js，无 .map、无授权标记）
├─ manifest.json  version 同步为根版本号；name 追加水印「 - <昵称>」
└─ assets/      图标
```

release 构建相对开发包的差异：`minify: true` + **关闭 sourcemap** + 去 legal 注释；javascript-obfuscator 只做字符串编码（`stringArray`+base64+unicode），**不开** `selfDefending`/`debugProtection`/`controlFlowFlattening`（会与游戏符号耦合误伤）。

**包内不落 UID 明文**：只内联 `sha256(salt+uid)` 哈希，运行时对登录 UID 求同样哈希比对。核验点分布式埋四处（boot 主闸 + bridge ISOLATED 复验 + background ingest 复验 + 个别 feat 副闸），补单点不全解锁。防护目标是拦「顺手 grep 改 UID / 补单点短路」这类初级破解，**不追内存断点级破解**（客户端无解，明示边界）。

### 交付给朋友

把整个 `release/pocketcc-extension-for-<UID>/` 文件夹压缩发过去，对方走 `chrome://extensions`（或 `edge://extensions`）→ 开「开发人员模式」→「加载解压缩的扩展」选这一层目录即可（是已解压扩展，不是 .crx）。提前告知：

- Chrome 会定期弹「请停用开发者扩展」，属正常现象。
- 发布包是本地文件夹、**无远程升级通道**，只能靠你重新打包 + 对方重新加载来更新。
- 登录匹配的 UID → 绿色「核验通过」+「进入使用」；登录别的 UID → 红色「核验失败」，功能全停（不读配置、不起 feat、不挂 UI），界面不可关闭。

### 版本管理

- **唯一真相源 = 仓库根 `package.json` 的 `version`**，只维护这一处。
- 任一构建（`build`/`build:release`/`pack:friend`/`watch`）都会把它自动同步进 `extension/manifest.json`（消除 dev 加载时的版本漂移）；出授权包时再由 `package-friend.mjs` 覆写分发目录内那份 manifest 并加昵称水印。
- semver 约定：`patch`=修复、`minor`=新功能、`major`=存储结构变更（须向后兼容或欢迎界面提示需重新配置）。
- 每发一个包打 git tag `v<version>`；同一版本给朋友重发用 `v<version>-<后缀>`（如 `v1.0.1-longbao`），便于回溯各人手上的版本。

## 使用

- 游戏页右下角浮动图标（可拖拽，位置记忆）；点开为左 TAB + 右卡片面板，五个类别（与 feats/ 目录层级 1:1）：
  - **玩家设置** — 「基础设置」组（每日补给 / 军火库生产材料 / 秘密武器空投 / 一键领取，只出勾选）；玩家点赞、战争之源、卡车争夺、自动下田、自动打野、惧星集结、次元矿洞、异能兽培育、城市技能各自为独立卡片（可展开详细参数）。
  - **联盟设置** — 「基础设置」组（联盟帮助 / 联盟礼物 / 联盟科技 / 联盟守卫）；联盟集结、联盟机甲、遗迹奖励为独立卡片。
  - **活动设置** — 「基础设置」组（海上夺宝 / 重装母舰 / 领域寻宝）；泰坦祝福、花车空投、占领发射井、异能秘境为独立卡片。
  - **战斗设置** — 快捷战斗、奉旨出征、自动防御。
  - **系统设置** — 聊天窗口、全局地图、镜头跳转、自动重连、网络日志、事件日志、报文录制、日志上送，以及只读的「快捷键一览」。
- 组开关是主闸门：关掉整组即停用全部子项，重新打开恢复各子项之前的勾选（意图存 `intentEnabled`，不丢失）；子项仍可单独勾选。改动即存即生效。新功能默认关闭（不未经同意发游戏包），自动重连默认开启。
- 只出 checkbox 的功能（日常任务各项、快捷战斗）不展示详细参数，也就不把这些参数写入 local，一律用 descriptor 默认值（只持久化启用/意图两个开关态）；展示字段的功能（联盟集结、次元矿洞、自动重连等）才全量持久化。
- 面板顶部「战斗模式」为全局开关（或热键 `F8` 直接切换日常/战斗）：开启后派行军类功能挂起、图标转红热态；关闭即恢复并补扫一轮。
- 快捷键一览见面板「系统设置」，或直接记：`Tab` 飞回基地 / `H` 基地↔大世界 / `B` 背包 / `Q` 关弹窗 / `1-8`+`G` 战斗面板选预设并出征 / `Shift+1-8` 快捷三连攻击 / `F8` 战斗模式 / `Ctrl+K` 聊天浮层 / `Ctrl+M` 全局地图浮层。
- 配置存于扩展自己的 `chrome.storage.local`，**每个 UID 下固定两个键**：`pocketcc.config`（用户配置 blob：功能开关/参数/组闸门/图标位置/日志开关）与 `pocketcc.data`（运行期数据 blob：联盟集结当日计数、矿洞预算账本等，写入频繁）。两者互不干扰，后续「导出配置」只读前者。键统一 `pocketcc.` 前缀；**游戏自身的 LocalStorage 键（登录态等）原样不动**。

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
- 加功能 = 写一个 `feats/<类别>/<name>.js` 调 `reactor.register(spec)`（含面板 descriptor），**再在 `core/menu.js` 菜单树挂节点、`content.entry.js` 加 import**（两处登记缺一则功能不出现/不加载）；UI 渲染与配置存取零改动。
- feat 只读游戏态、只发包，绝不调用游戏 Update/Delete 改写本地数据；生命周期完全让渡给 reactor（不手写 `off()`，一律 `ctx.on.*` 托管退订）。
- 判据/hook 点以 [`references/`](../references/) 内的游戏源码镜像与真机探针为准，不按假设设计；该目录只读。
- 不建第二个游戏消息总线（`core/net.js` 已是）；trigger API 保持极小，不加投机旋钮。

## 路线图

- 联盟机甲、奉旨出征、全局地图、聊天窗口、次元矿洞等已落地；后续按 `references/` 逆向素材继续扩充活动/日常类 feat。
- 报文录制可选加落盘保留/清理策略（在 dashcam 侧）。

## 许可

未声明开源许可的个人项目（私有、暂不授权再分发）。
