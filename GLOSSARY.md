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