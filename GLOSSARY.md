# 业务术语表（GLOSSARY）

> 架构审查与设计讨论用的域词汇。词条随设计定稿懒追加（domain-modeling 约定），
> 架构词汇（module / interface / seam / depth / locality / leverage）见 codebase-design 技能。

## 协议注册表（Protocol Registry）

协议知识的单一真相，开发期 module（`scripts/protocol/`），不进运行期 bundle。
条目以**协议号**为键，收方向（dir）、语义标注（note）、逆向出处（src）与
**feat 局部常量**用法清单（usages）。feat 保留本地常量（零运行期改动），一致性由
`tests/protocol-registry.test.js` 闸门断言（随 `npm test`）：代码与注册表双向一致、
manifests 协议号 ⊆ 注册表。维护走 `npm run protocol:extract` 增量合并——机器字段
（usages/域归属）重建，人工字段（dir/note/src）按号保留。数据按业务域分片，
跨域共享号与 core 基础设施号归 `registry/shared.mjs`。

## 协议号（CMD）

游戏网络报文的命令号（如 8521 = 秘境行军、901 = 世界地图视口查询）。
注册表的条目键，全局唯一。方向分 C2S（请求）与 S2C（推送）；推送号多以 PUSH_
前缀命名，但有例外（10019 名为 CMD_USER_MARCH_INFO 实为推送，须实证标注）。

## feat 局部名

feat 文件内自定义的协议常量名（如 `CMD_GET_INFO`）。同一泛化名在不同 feat 指向
不同协议是**局部命名**而非语义漂移——注册表以号为键，名字只是别名；跨 feat 的
语义名走人工 note 标注。

## 别名

同一协议号的不同常量名（如 902 = `CMD_MARCH_WORLD_POINT` = `CMD_MARCH_POINT`），
收进同一条目的 usages 清单，不另立条目。

## 录制对拍（Replay Conformance）

用真人录制报文（dashcam NDJSON）离线仿真 feat 决策并核对写动作的验证框架
（`scripts/replay/` 内核 + `scripts/verify-manifests/` feat 私货）。manifest 的
协议号判据须与 feat 同源（import constants 或 featNum 文本抽取），不得另起炉灶。

## 快照池（Snapshot Pool）

D 原语 `createSnapshotPool`（`core/snapshot-pool.js`）：服务「边沿推送即事实、无重放读通道」的
feat（如 alliance-rally 的 12003）。推送过完业务闸后按 key 入池，四件不变量：键控去重
（同键拒入**不续命**）、TTL 惰性过期、wake.at 托管唤醒（ctx.setTimeout）、一次性消耗
（onWake 前出池，抛错也出池）。pause 清定时器保留条目，resume 由 run() 调 reschedule()
重排续跑。与 A（createCycle，可重放读合并）、B（createDrain，逐条消费）、C（createEventHeap，
N 实例各自计时）是不同的缝；业务闸门与动作编排全归调用方。详设见
`extension/docs/core/snapshot-pool.md`。

## 功能上下文（Feature Context）

注入给 feat spec.install/run 的唯一外部接触面，由 `core/feat-ctx.js` 的
`createCtx(entry, deps)` 工厂装配（deps 全注入、零 import，单测可直驱）。窄化为三件套：
生命周期（`alive()`/`signal`/托管定时器）、订阅（`on.push/resp/req/event/chat`，退订自动
登记、pause 统一摘除）、底座（`net/chat` getter 读时现取活绑定）。游戏符号不在 ctx 上：
feat 经 ESM 直取 `core/game.js`（旧 `ctx.game/ctx.bus` 于 2026-11-14 盘点后删除：
bus 零消费者、game 唯一消费者 global-map 已迁）。详设见 `extension/docs/core/reactor.md`。

## 壳（Shell）

装在浏览器里、季度级才换一次的那一层，只负责取包、执行与降级。它是远程体的启动器，不是插件本体。
_Avoid_: 本地包、宿主、引导包

## 远程体（Remote Bundle）

真正承载玩法与面板的那一份代码，平时发版只换它；玩家刷新页面即换成新版本。
_Avoid_: 热更包、补丁、payload

## 基线（Baseline）

随壳一起装进机器的那一份远程体，是远程通道失灵时的最后立足点。它跟远程体同源于一次构建，不代表「旧版本」。
_Avoid_: 出厂版、兜底包

## 版本号（X.Y.Z）

三段纯数字，壳与远程体共用同一套语义：主版本 X 是架构上的重大调整，大版本 Y 是重大功能的新增或删除，小版本 Z 是小功能与漏洞修复。
壳与远程体各走一条版本线、但同源于一张号：日常只发远程体，所以远程体的号会跑在壳前面，两者不同号不是异常。
_Avoid_: 语义化版本（本项目不带 prerelease / build metadata，通道也不靠后缀表达）、修订号与构建号（壳号与远程体号都是同一个规则的实例，不是两种号）

## 发布身份（Release Identity）

一次发布唯一的「是哪一份正文」的答案：正式通道就是版本号（`1.4.0`），快照通道是 `版本号@正文摘要前 8 位`（`1.0.0@03b39054`）。它只在需要判新旧、该不该提示、以及「稍后/隔离」记账的地方出现，不进版本号、也不当通道名用。
_Avoid_: 构建号（本项目不另记 build metadata，摘要就是正文本身）、四段式版本（`1.0.0.1` 那种写法已作废，且它会被 `cmpVer` 排成另一个版本）、版本后缀（`1.0.0-snapshot` 会被折叠成与 `1.0.0` 同版）

## 发布通道（Channel）

同一份代码的三个风险级别：开发（dev，只在作者机器上、不走远程升级）、快照（snapshot，作者先吃的新构建）、正式（release，发给所有人）。
通道**不是版本号的一部分**：一个版本号可以同时以不同通道发出去，转正就是把同一批代码换个通道重发一次。
每个通道是一个独立的扩展实例，自己的数据与自己的更新源；同时只启用一个。
_Avoid_: 版本后缀（`1.0.0-dev` 那类写法在本项目里等于「跟 1.0.0 同版」，会造成静默不升级）、环境（dev/prod 容易被读成同一实例切开关）、分支

## 快照通道（Snapshot Channel）

作者自己先吃的那条发布通道，比正式版更早、比开发版更接近真实分发链路（走远程升级、走 OSS 清单）。它的发布身份带正文摘要，所以同一日连续出好几个包不必抬版本号。它与「快照池」无关。
_Avoid_: 测试服、预发布（本项目没有两套人群，只有两套风险）、快照池（那是另一个领域的词）

## 已就绪待刷新（Ready, Pending Refresh）

新版已下载到本地但尚未被执行的中间态：此刻正在跑的仍是旧版。所有面向玩家的升级提示统一用这个口径。
_Avoid_: 已更新、升级完成、热更新（运行期刻意不热替换）

## 署名告知页（Welcome）

启动时一次的署名与风险告知，以非模态弹窗呈现：功能与面板照常拉起，玩家点不点都不影响使用。它不承载任何准入判定——所有人用到全部功能。
_Avoid_: 授权页、激活页、启动闸门（它不做任何放行判定，也不拦在启动链上）

## 设置备份（Settings Backup）

把一个账号的**设置**搬去另一个账号或另一台机器的那份 JSON 文件。范围恰好等于配置 blob（`pocketcc.config`）的全部内容：功能开关与详细参数、菜单组闸门、图标与浮窗位置。文件名 `pocketcc-<UID>-YYYYMMDD-HHMMSS.json`，大端写使「按名称排序」就是「按时间排序」。
导入是**逐键并入**：文件里有的键覆盖同名键，没提到的键原样保留，不是整块替换。
_Avoid_: 数据导出、存档（save）、全量备份（它只做设置那一半）

## 运行数据（Run Data）

引擎从服务器镜像出来、并据此决策的事实：当日计数、矿洞预算账本、地图扫描缓存等，住在 `pocketcc.data` 与 `storage.slot` 的分片键里。它与设置的分界就是「设置备份」的导出边界——运行数据**永不进备份**，因为陈旧的事实在另一台机器上只会参与错误决策，而它会自己重新长出来。
_Avoid_: 配置（那是玩家表达意图的那一块）、缓存（它不只是可丢弃的加速数据）