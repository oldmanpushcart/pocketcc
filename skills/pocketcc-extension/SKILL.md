---
name: pocketcc-extension
description: pocketcc Chrome MV3 扩展侧工程规范，覆盖 feat 新增/修改、reactor 生命周期、网络层与推送订阅、日志分级、UID 隔离存储、调度原语 createCycle、壳/远程体两层分发与升级通道、JSDoc 与私有成员代码风格。当在 extension/ 目录下新增或修改玩法（feat）、核心模块（core）、菜单、面板 UI、升级通道，或用户提到 reactor、sendPBV2、ctx.on.push、createCycle、manifest、发版时使用。
---

# pocketcc 扩展工程规范

## 构建与验证

- 改动后必须跑 `npm run build`（esbuild 六入口 IIFE，target chrome110：壳侧 shell/bridge/background/anti-throttle/popup + 远程体 remote）与 `npm run lint`；结构性改动再跑 `npm run arch` / `test` / `ui-snapshot`。
- `extension/dist/` 是构建产物，禁止手工编辑或直接改它来"调试"。
- 新增入口需同时修改 `esbuild.config.mjs` 的 builds 数组（壳侧进 `shellGroup`、玩法侧进 `remoteGroup`）与 `extension/manifest.json`。

## 分发与升级通道（壳 / 远程体两层）

- **壳文件禁改清单**：`shell.js` / `bridge.js` / `background.js` / `anti-throttle.js` / `popup.js`。改一个就得让所有人重新加载扩展，故新增玩法/面板/core 能力**只挂 `remote.entry.js` 一侧**；红线由 `.dependency-cruiser.cjs` 禁边守住（壳不得 import `feats/**` 与 `core/ui/**`）。
- `dist/remote.js` 是双重身份：既是要上传 OSS 的远程体，也是包内基线（OSS 不可用时壳直接 exec 它），不设第二份副本。
- 升级判据（版本比较、清单解析、地址拼接、就绪选择、下载决策、验签、提示口径）**全部收口 `core/update.js` 的纯函数**，`background.js` 只做 I/O 与定时；新判据先写成纯函数并补 `tests/core/update-*.test.js`，不在 SW 里就地判断。快照通道的身份判据另有用例锁定（`tests/core/update-snapshot-identity.test.js`、`tests/core/ui/update-display-snapshot.test.js`：靠构建前设 `globalThis.__PCC_CHANNEL__` 取快照态实例）。
- 升级相关的缓存与偏好走 `chrome.storage.local` 顶层字面键（`pccupd<通道后缀>:bundle|state|pref`，正式通道无后缀），**刻意绕开 `core/storage.js` 的 UID 命名空间**：升级态是全局的，按 UID 存会换号即丢且重复占空间。
- 两条语义纪律：启动路径绝不阻塞网络（壳只 exec 本地已就绪的最优版本，检查结果只写缓存）；「已下载」不等于「已生效」（运行期不热替换，提示统一为「刷新页面即生效」，默认不自动 reload）。
- dev 构建注入空 `__OSS_BASE__` / `__UPDATE_KEY__` = 整条远程通道短路，只跑本地产物；发布构建的基址唯一真相是 `esbuild.config.mjs` 顶部 `UPDATE_BASES`（按通道取），密钥只来自 `PCC_UPDATE_KEY` 环境变量（不入库、面板上也不给可编辑入口）。
- **版本号 = 三段纯数字 X.Y.Z，壳与远程体共用同一套语义**：`X` 架构上有重大调整（含存储结构不兼容）、`Y` 重大功能新增或删除、`Z` 小功能与漏洞修复。唯一真相源是根 `package.json` 的 `version`（构建会自动同步进 `extension/manifest.json`，**不要手改 manifest 的版本**）；**正式通道**内一号一正文，同号重发就 `Z++`；**快照通道**比发布身份 `版本号@摘要前 8 位`（`1.0.0@03b39054`），同号换正文即会推更新，不必抬号（正文文件名同步带摘要段，见 `extension/README.md`「快照通道的发布身份」）。壳号只能 ≤ 远程体号（两者同源一个 `version`，壳靠重新出壳才前进），面板上两者不同号属正常。
- **发布通道（dev / snapshot / release）是版本号之外的独立维度**（`__PCC_CHANNEL__`）：三档各持一组 `manifest.key` ⇒ 三个扩展 ID ⇒ 数据天然隔离。通道**绝不进版本号**（`cmpVer('1.0.0-dev','1.0.0') === 0`，会静默不更新）。理由与代价见 `extension/docs/adr/0003-release-channels.md`。三档显示名在 `chrome://extensions` 上分开（tracked manifest 写「口袋控制中心（开发版）」，出包时 `PKG_NAMES` 按通道覆写成「（快照版）」/无后缀）；名字与 ID 无关（ID 只由 key 派生），改名字不换实例。两条发布通道的产物统一收在 `extension/out/<通道>/{pocketcc-extension（壳）, oss（待上传件）}` 这个分发出口下，dev 不出包；构建输出 `extension/dist/` **刻意不在 out 里**（路径写死在 tracked manifest、Chrome 直读，并与壳内那层 `dist/` 逐字节对应）。
- 凡「按扩展实例命名」的符号（postMessage 协议名、存储键前缀、字面缓存键）一律从 `core/constants.js` 的 `CHAN_SUFFIX` / `NS` / `STORAGE_ROOT` 派生，**不得写死字面量**（漏一处就是两条通道在同一页互踩）；闸门在 `tests/core/channel-isolation.test.js`。正式通道刻意留空后缀（存量零迁移），不得改。
- 发布身份的摘要维度也只由通道常量得出（`core/update.js` 的 `DIGEST_IDENTITY = CHANNEL_NAME !== 'release'`），**摘要绝不并进版本号**（`cmpVer` 逐段 `parseInt` 会把 `@…` 折叠成数字 → 同号判等 → 静默不更新）；「稍后」与隔离按身份记账（`dismissedId` / `blockedId`，旧键 `dismissedVer` / `blockedVer` 只读兼容）。
- 改 `extension/channel-keys.json` 或 tracked manifest 的 `key` = 换一个全新实例（用户数据从零开始），属不可逆操作；正式 ID 已冻结，动它前先确认清楚。

## 架构分层（依赖方向不可逆）

```
feats/<分组>/<玩法> → core/ → 游戏 DOM/符号
bridge.js(ISOLATED) ←postMessage→ MAIN（shell 取包并 exec remote）
background.js(SW) = 唯一出网口：dashcam fetch 转发 + 升级状态机
```

- feats 之间不得互相 import；公共逻辑下沉 `core/`。
- **分层闸门**：`npm run arch`（dependency-cruiser，配置 `.dependency-cruiser.cjs`）强制执行上面两条（core 不回引 feats、feats 间不互 import），当前**无豁免基线**。跨 feat 复用的「常量真相 + 纯查询」下沉**薄底座**（`core/map.js` 地图、`core/item.js` 物品、`core/march.js` 行军）——范式：只收口真相/查询/只读发包骨架，**不聚合玩法动词**；feat 私货（UI 配色/筛选树/扫描调参如 `FILTER_TREE`/`SCAN_GRID`/`DEFAULTS`）留在 `feats/`，不发协议的聚合不下沉。
- `remote.entry.js` 是远程体的唯一装配点：import 顺序即加载顺序（net → feat → boot），并把 bus/game/storage/reactor 等挂到 `window.pocketcc` 调试面。壳（`shell.js`）只做取包/exec/降级，不承载玩法与面板。
- 游戏 bundle 内部符号知识（模块注册名、类属性链、枚举成员名、配置表名）**一律收口 `core/game-api.js`（ACL 防腐层）**，业务层只依赖能力 API（l10n/nav/gameData/gameConf/bits/session），不得在 feat 里直接 `game.get` 或裸写符号链。

## 新增 feat 清单（按序执行）

1. 建文件 `extension/src/feats/<分组>/<玩法>.js`（分组：daily/activity/battle/chat/map/hotkey）。
2. 在 `core/menu.js` 菜单树挂载：声明分组、label、是否 `showFields`。
3. 在 `remote.entry.js` 追加 import。
4. 通过 `reactor.register(spec)` 声明式注册，spec 必含 `label/storageKey/defaults/toModuleCfg`（面板描述符），按需实现 `install/configure/run/pause` 钩子与 `scenes` 门控（如限定 Home/NWorldMap）。`toModuleCfg` 是硬性契约：`core/registry.js` 的 applyFeature 对**每个** reactor 功能无条件调该钩子把面板 cfg 归一成运行时 cfg，即便玩法无可调参数也要声明为 `(c) => ({ enabled: !!(c && c.enabled) })`——缺声明会在面板翻开关的 DOM change 回调里报（旧写法直接抛 `TypeError` 且不经 createLog、日志零痕迹；现已收口为 warn 降级，但除 `enabled` 外的字段会永远停在默认值）。
5. 战斗模式语义上强制下线玩法类 feat（沿用既有门控，不自造开关）。

## 硬性红线

- **feat 脚本只读 + 发包**：禁止调用游戏侧 Update/Delete 等改写本地数据的方法；本地态以应答/推送为准。
- 网络一律走 `window.pocketcc.net` 的 promise 封装：`send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>`，在途查询用 `isSending(cmd)`；被拒语义用 `CODE_NOT_SENT` 等哨兵码，不抛异常控制流。
- 报文订阅三条命名空间，均经 `ctx.on.*` 登记（退订由 reactor 自动托管，禁止直接摸 bus 或手工 off）：推送 `ctx.on.push(cmd)`、应答 `ctx.on.resp(cmd)`、**本端发包** `ctx.on.req(cmd)`。
  - `ctx.on.req` 必须走这条（内部经 `pocketcc.net.onReq` 按需拉起发送 hook），直接 `bus.on('net.req.…')` 会订到一条永不派发的空事件。
  - req 只在包**真上线之后**才派（游戏两条通道的 send/sendPB/sendPBV2 在 needDisable / MsgIDSettings / `cdTime` 请求太频繁 / encode 失败 处 `return!1`，静默无异常）。
  - 「请求带而应答不带」的字段只能从 req 侧取（实证：秘境 8532 req 带 {x,y}、应答不带）；req↔resp 配对用应答的 `Event.reqTime`（= 该应答那条请求的发出时刻）取 `ts <= reqTime` 中最大的一条，**不要靠 FIFO + TTL 猜**（错配后果是拿错点坐标发写请求，被拒还会误拉黑有效目标）。
  - req 事件名是**逻辑 cmd**、resp 是**线上 cmd**：主通道有 `msgIdReplaceMap`/`getOldCmd` 换号，换号时两者不同名（次通道 NetMgrSimple 无换号表）。
- 两条发送通道都要当回事：主通道 `NetMgr.NET` 实例 + 次通道 `NetMgrSimple.prototype`（秘境/观战走另一条 websocket，`TMWatchNetMgr.sendPBV2` 在 `isPabBattleMap` 时分叉到它）。次通道挂点探不到会**整局降级且不重试**（两个类同在 Script bundle，不存在“还没加载”的时序窗口），状态查 `pocketcc.net.secondaryStatus()`（`pending|ok|missing`），改版当天 `pocketcc.net.reprobeSecondary()` 重探即可，不必刷页。
- 心跳不进观测面：`core/net.js` 的 `hbCodes` 集合滤掉两条通道心跳（主 0/NO_QUEUE_HEART、次 6385/TM_WATCH_HEART，次通道号由发送 wrapper 自学习登记；入站在 NetReciver 单点、认不出通道归属，所以必须用集合），因此 **dashcam 录音与 `collecting()` 里没心跳行**，对拍时别当成漏采。
- 生命周期类定时器（唤醒去抖/错峰延迟/可见性轮询）优先 `ctx.setTimeout/setInterval` 托管（pause 自动清、非激活态 no-op 返 -1、clear 未知句柄安全）；在飞休眠用 `sleep(ms, ctx.signal)` 早醒（早 resolve 不 reject，醒来仍判 alive）。托管的 Promise 等待必须带 abort 收口路径（否则永挂卡死 cycle 单飞）；signal 每次 run 内现读不跨 pause 缓存。`run()` 里 `new` 出的引擎与绕过 ctx 的裸定时器仍归 feat：**必须存模块级引用**并在 spec 声明 `pause(ctx)` 自收，不显式收就会在 resume 后拿陈旧快照继续发写请求（`pause` 钩子由 `core/reactor.js` 的 `pause()` 末尾调用，跑在 abort/清托管定时器/摘触发器之后）。一次性自清 latch 守卫（如 daily-state 看门狗）刻意不托管。
- 存储只走 `core/storage.js` 入口（UID 命名空间 + 双 blob + per-blob 串行队列），MAIN 侧禁止直接 `chrome.storage`（那是 bridge 的事）。detail-hidden 功能的详细参数不落盘、只持久化 enabled/intentEnabled。
- 报文对照：发请求的字段形态须与 dashcam 录制报文**逐键一致**，不靠猜；注释里用「报文实证 dashcam <会话文件名>」标注证据来源。

## 调度原语

- 周期性扫描/消费类逻辑用 `core/cycle.js` 的 `createCycle({run, alive, fallback, log})`：`run()` 返回 `>0` 睡眠毫秒、`<=0` 立即再跑；触发一律 `kick`（在飞时置 pending，本轮结束补扫一次）。
- 不要在 feat 里手写 `scheduleCycle/triggerCycle/doCycle` 样板；间隔决策（退避曲线、idle 降频）留在调用方 `run()` 返回值里。
- 一次性任务/无周期重排需求不套 createCycle。

## 日志规范

分级判据按顺序走（完整契约见 `core/log.js` 顶部注释）：

1. **error（确定性停摆 / 不变量违例）**：「本场不会再自己好起来」，必须人工介入或重启能力才能恢复——方案/契约违例导致本周期拒绝发车、依赖符号/订阅通道缺失致整引擎 idle、引擎与录制链路 `stop()` 抛错。边界：**一次被拒 / 一次超时 / 一次偶发抛错不得升 error**（那是 warn 的已降级形态）；模糊个案留 warn，别稀释 error「必须人工看」的信号价值。
2. **warn（真异常但可恢复或已降级）**：「我们没能正确发出/收到/理解」——catch 到的抛错（threw/load·persist·save failed）、发送失败或未发出（CODE_NOT_SENT）、应答畸形/不可解析、游戏符号/表行不可用、未知枚举首次遭遇。
3. **info（生命周期 + 可预期业务拒绝）**：启动/停止/安装/关键动作完成；服务器对已成形请求返回 code≠0（限额/已满/阶段锁/目标被抢/时序竞争/活动未开），必带 code/reason。
4. **debug（调度细节 + 循环态不可动作）**：随资源回收自愈的跳过（no free slot、材料不足、门控不过、退避中）。

debug 故障可诊断条款：

- debug 不吞真异常：属第 1/2 条的故障线索一律 error/warn，不得为降噪把抛错/写盘失败压在 debug。
- 每个 skip/abort/reject/return 出口必有日志（debug 起步，高频循环靠节流或 log-collect 折叠），且必带决策上下文：cmd 号、code、坐标(x,y)、目标/队伍 ID、状态枚举值——保证 dashcam 日志流（minLvl=debug）单轨可还原引擎「为什么没动」。
- error/warn 消息须含可 grep 的定位前缀（协议号/模块动作名）。
- 不得为了「让某条日志能上报」而改它的等级：面板 `minLvl` 调到 debug 就能收到全部既有 debug。

其他约定：

- 统一 `createLog(tag)`，tag 用大写模块名（NET/BUS/REACTOR/GAME…）；message 一律英文（登记例外：core/chat/log.js 包内日志）。
- 判据是 code 而非 cmd；「服务器拒绝」与「CODE_NOT_SENT」分离处理。
- 自动化撞限额的目标当日拉黑，防止逐拍重发刷屏；被拒路径不得打 warn。
- 业务代码禁止裸 console.*；登记例外：bridge.js、core/devtools.js、core/net.js 调试 dump（`createLog` 内部用 console.error 输 error 级，不在此列）。
- 录制基础设施自身日志必须 `createLog(tag, { quiet: true })` 防自录回声。

## 代码风格

- JSDoc 必须覆盖：类、方法、关键成员字段、常量（`@typedef/@param/@returns`；常量 `@type/@const` 说明用途）。
- 文件头部保留大段 JSDoc 说明书（玩法链路、协议清单、闸门判据、触发源），完整设计取舍写 `extension/docs/core/<api>.md`（八节模板），不塞进源码注释。
- 文档落位：扩展侧的设计文档统一在 `extension/docs/` 下，**不在仓库根建 `docs/`**。架构级取舍（难逆转、后来者会问“为什么不另一种做法”）走 ADR，按序编号放 `extension/docs/adr/000N-<slug>.md`，索引在 `extension/docs/README.md`；模块内部取舍写 `docs/core/*.md`，协议台账写 `docs/feat-*.md`。
- 类私有成员一律原生 `#` 前缀，不用 `_` 前缀或 WeakMap。
- 格式全仓交给 Prettier（`npm run format`，2 空格、printWidth 100、单引号），不手工调排版；保存时 VSCode 自动 Prettier + ESLint fixAll。空 catch 是合法的“吞异常降级”惯用法，但要保证降级后循环不停摆。
- Int64 字段按字符串读，不做 Number 转换（精度陷阱）；64 位 ID 比较用字符串。

## 交付前自查

- [ ] `npm run build` 通过、`npm run lint` 无新增 error
- [ ] 新 feat 只挂在 `remote.entry.js` 一侧，未为了它改动任何壳文件
- [ ] 新 feat 在面板出现且开关生效（install/run/pause 走 reactor）
- [ ] 未直接触碰游戏符号名/`game.get`（走了 ACL）
- [ ] 报文订阅经 `ctx.on.push/resp/req`，退订由 reactor 托管；req↔resp 配对按 `Event.reqTime` 而非顺序猜测
- [ ] 生命周期定时器走 `ctx.setTimeout/setInterval` 托管、在飞休眠传 `ctx.signal`；`run()` 里新建的引擎实例/裸定时器已存引用，并有 `pause` 钩子收尾
- [ ] 关键决策与协议形态在文件头注释标注了报文实证来源
