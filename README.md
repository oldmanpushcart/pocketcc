# pocketcc（口袋控制中心）

口袋奇兵（Top War，warh5.rivergame.net）H5 页游的个人辅助 Chrome MV3 扩展：把重复性的活动操作（祝福领取、联盟帮助、领域寻宝挖矿）与登录/断线恢复自动化，全部跑在游戏页面自己的 MAIN world 里，复用游戏已登录的会话，不碰账号凭据的加解密。

> 个人逆向学习与自用项目。使用第三方辅助可能违反游戏用户协议，风险自负。

## 特性

- **免扫码自动登录** — 缓存游戏自己的 `serverToken` 并在下次启动时重放，跳过扫码页；补一个「登出 / 换号」按钮（游戏在自动复用 token 后默认无法主动换号）。
- **自动重连** — 监听断线弹窗与流量停滞，按配置间隔调度整页重载恢复会话；会话恢复健康后自动清零计数。
- **芯片祝福 / 泰坦祝福** — 推送驱动：活动推送一到即领取，零轮询。
- **联盟帮助** — 轮询四种帮助石头并自动帮助/领取，按 kind 去重。
- **领域寻宝（挖矿）** — 推送 + 主动扫描 + 兜底定时三触发源拉矿脉列表，名额判定后逐条派遣；被服务器以「剩余时间不足以行军」拒派的矿脉进黑名单，直到它从矿脉名单消失才解禁。
- **战斗模式总开关** — 面板上的全局开关：开启时派行军类的功能（芯片/泰坦/领域寻宝）主动挂起，纯发包类（联盟帮助）与会话看门狗继续跑；浮动图标同步切换日常/战斗双态并带呼吸光晕。
- **菜单树驱动面板** — Shadow DOM 左右两栏：左为类别 TAB（日常/战斗/系统设置，切换只换右栏），右为卡片列表（组卡片带主闸门开关，关则级联停用子项；功能卡片带启用开关，可展开详细字段）。层级定义在 `core/menu.js`，字段/存储/默认值仍在各功能 descriptor；日常任务与快捷战斗只出 checkbox 不需详细参数，改动即存档即生效。

## 架构

两个 content script 入口，esbuild 打包（未压缩 + sourcemap，控制台栈可读）：

| 入口 | world | 职责 |
|---|---|---|
| `dist/content.js` | MAIN | 与游戏同域同上下文：hook 游戏网络层与控制器，跑全部功能 |
| `dist/bridge.js` | ISOLATED | 持有 `chrome.storage`，经 postMessage 代理给 MAIN 侧 |

核心是 **EventBus + 两层 reactor**：

- **EventBus**（`core/bus.js`）— 事件类：`net.<cmd>`（游戏推送/应答）、`session.*`（会话健康）、`scene.*`（cc 场景切换）、`mode.change`（战斗模式）、`tick.*`（定时）。
- **reactor**（`core/reactor.js`）— 功能以「说明书」形态注册（触发器 + 可选 produce→queue→drain）；门控是**可注册集合**（`shouldRun = enabled && 所有门控通过`），现有 scene 门控（`Home`/`NWorldMap` 白名单）与 mode 门控（`offInCombat`）。门控翻false 走 pause（退订推送、停定时、在飞流程自然退出、保留队列与配置），翻回 true 走 resume 并补扫一轮。
- **net**（`net.js`）— `NetMgr` 的 promise 封装（`send`/`sendPBV2`/`isSending`/`Ret`，15s 应答超时防 await 挂死）+ `NetReciver.onMessage` 单点 hook，把游戏推送派发到 bus。

### 目录结构

```
pocketcc/
├─ package.json / esbuild.config.mjs / .gitignore
├─ README.md
├─ references/                 只读逆向素材：游戏源码镜像 + 分析台账（不可修改/搬迁）
└─ extension/                  Edge「加载解压缩的扩展」指向这一层
   ├─ manifest.json
   ├─ assets/                  manifest 图标（16/48/128 三档 PNG）
   ├─ dist/                    esbuild 产物（gitignore）
   └─ src/
      ├─ content.entry.js      MAIN 入口；import 顺序即加载顺序：net → feats → main
      ├─ bridge.js             ISOLATED 入口（chrome.storage 代理）
      ├─ main.js               纯编排器（场景监视/自动登录/重连 hook/启动闸/UI 挂载）
      ├─ net.js                网络底座
      ├─ feats/                功能模块（目录层级对齐面板菜单树，均向 reactor 注册说明书）
      │  ├─ daily/              日常设置：chip-blessing / titan-blessing / alliance-help /
      │  │                      domain-treasure / sea-treasure / alliance-gift / alliance-rally
      │  └─ battle/              战斗设置：quick-attack
      ├─ utils/                功能间共享工具（battle.js 行军发包构造、quick-attack.js 目标注册表）
      └─ core/
         ├─ bus.js             EventBus（单例、emit 恒同步）
         ├─ reactor.js         两层模型 + 可注册门控
         ├─ menu.js            面板菜单树（类别 TAB→组/功能卡片）单一真相，组闸门语义在此声明
         ├─ scene-watcher.js   cc 场景信号（EVENT_AFTER_SCENE_LAUNCH）→ scene.* 事件
         ├─ mode.js            战斗模式布尔 + mode 门控（不持久化，默认日常）
         ├─ registry.js        descriptor 驱动配置单一真相（含组配置读盘/存档、intent 补全）
         ├─ game.js            游戏模块 hub（__require 集中；缺失软失败返回 null）
         ├─ storage.js         MAIN 侧 chrome.storage 代理客户端（UID 前缀下两个 blob：pocketcc.config / pocketcc.data）
         ├─ session.js         会话健康广播 + 自动重连
         ├─ auto-login.js      token 缓存重放（免扫码）
         ├─ ui.js              Shadow DOM 浮动图标 + 左 TAB 右卡片面板
         ├─ icon-svg.js        双态图标 SVG（日常冷蓝 / 战斗红热）
         ├─ drain.js           通用消费循环（produce→queue→drain 的 drain 段）
         ├─ log.js             统一日志 [POCKETCC://MODULE]
         └─ constants.js       两 world postMessage 协议命名空间
```

## 构建与安装

前置：Node.js（开发用 esbuild，无运行时依赖）。

```bash
npm install
npm run build     # 或 npm run watch
```

安装到 Edge/Chrome：

1. 打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」。
2. 「加载解压缩的扩展」选择 **`extension/` 这一层**（直接含 `manifest.json` 的目录；选仓库根或 `dist/` 会报清单缺失）。
3. 打开游戏页登录即可。**改完源码必须 `npm run build` 并 F5 刷新游戏页面**（不是只重载扩展）——MAIN world 的 monkey-patch 只有干净页面才清得掉。

## 使用

- 游戏页右下角浮动图标（可拖拽，位置记忆）；点开为左 TAB + 右卡片面板：日常设置（日常任务组：芯片祝福/泰坦祝福/联盟帮助/领域寻宝/海上夺宝/联盟礼物，只出勾选；联盟集结卡片，展开按战锤/惧星/难民营分段设置）、战斗设置（快捷战斗）、系统设置（自动重连可展开，网络日志/事件日志平级勾选）。
- 组开关是主闸门：关掉整组即停用全部子项，重新打开恢复各子项之前的勾选（意图存 intentEnabled，不丢失）；子项仍可单独勾选。改动即存即生效。新功能默认关闭（不未经同意发游戏包），自动重连默认开启。
- 只出 checkbox 的功能（日常任务各项、快捷战斗）不展示详细参数，也就不把这些参数写入 local，一律用 descriptor 默认值（只持久化启用/意图两个开关态）；展示字段的功能（联盟集结、自动重连）才全量持久化。
- 面板顶部「战斗模式」为全局开关（或热键 **F8** 直接切换日常/战斗）：开启后派行军类功能挂起、图标转红热态；关闭即恢复并补扫一轮。
- 配置存于扩展自己的 `chrome.storage.local`，**每个 UID 下固定两个键**：`pocketcc.config`（用户配置 blob：功能开关/参数/组闸门/图标位置/日志开关）与 `pocketcc.data`（运行期数据 blob：联盟集结当日计数等，写入频繁）。两者互不干扰，后续「导出配置」只读前者。键统一 `pocketcc.` 前缀；**游戏自身的 LocalStorage 键（登录态等）原样不动**。

### 控制台调试面

MAIN world 暴露 `window.pocketcc`，逆向时直接戳：

```js
pocketcc.game.get('DataCenter').DATA.UserData.UID   // 取游戏单例
pocketcc.bus.has('net.10912')                       // 查某推送有无功能订阅
pocketcc.bus.emit('scene.change', { name: 'NWorldMap' })  // 模拟切场景测门控
pocketcc.net.sendPBV2(8623, { activityId: 0, type: 2 })   // 手动发包看 Ret
```

## 开发约定

- 日志统一 `[POCKETCC://模块] 英文消息`；info=生命周期、debug=逐条调度、warn=异常/被拒。
- 加功能 = 写一个 `feats/<层级>/<name>.js` 调 `reactor.register(spec)`（含面板 descriptor），再在 `core/menu.js` 菜单树挂节点、`content.entry.js` 加 import；UI 渲染与配置存取零改动。
- 判据/hook 点以 `references/` 内的游戏源码镜像与真机探针为准，不按假设设计；该目录只读。
- 不建第二个游戏消息总线（`net.js` 已是）；trigger API 保持极小，不加投机旋钮。

## 路线图

- 联盟机甲（协议素材收集中）。

## 许可

未声明开源许可的个人项目。
