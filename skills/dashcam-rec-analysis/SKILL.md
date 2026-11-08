---
name: dashcam-rec-analysis
description: pocketcc dashcam 录制文件（网络报文 NDJSON + 扩展日志）离线分析标准用法。当用户要求分析某场录制（.ndjson）、核对引擎决策与实际报文、诊断「开场直冲商店」「威胁窗」「逼店永动」类行为、回放扩展日志，或修复 store 落盘损坏（会话分片合并、孤儿 .part 定稿）时使用。命令入口：node dashcam/cli.js（分析只读）；修复走 node dashcam/repair-store.js。
---

# dashcam 录制分析（报文 + 日志双轨）

## 数据从哪来

- 扩展面板「报文录制」开关 → POST /ingest → `store/rec/<uid>/dashcam-rec-<startLocal>[-<note>][-<slug>].ndjson`（会话制，开→关一段，带业务标签）；同目录 `dashcam-rec-index.ndjson` 每会话一行，含 `logRef`。
- 扩展面板「日志上送」开关 → POST /log → `store/log/<uid>/dashcam-log-<YYYYMMDD>[-NN].ndjson`（长期常开，按天轮转直写，无业务语义；旧版无前缀小时段 `YYYYMMDDTHH[-NN]` 仍兼容读）。
- 报文行格式 `{dir,cmd,name,data,raw,ts,seq,rt}`；日志行格式 `{ts,lvl,mod,msg,n}`（n=连续同文案折叠计数）。

## 六个子命令（都走流式扫描，大文件不平铺内存）

```bash
R=node\ dashcam/cli.js
$R index   <报文.ndjson>                          # cmd×dir 频次/首末 ts/name 反查（先跑这个定位）
$R series  <报文.ndjson> --cmd 8521 --dir req --fields x,y   # 时序抽取 + 间隔分位 p10/p50/p90
$R shape   <报文.ndjson> --cmd 901 --dir resp     # 载荷字段形态（path→覆盖数+样例）
$R slice   <报文.ndjson> --from 600 --to 640      # 时间窗全事件流水（窗=相对首行 ts 秒，--anchor 可改锚）
$R push    <报文.ndjson> --cmd 21534 --field num --gt 0   # 推送标量分布/命中序列/脉冲间隔
$R log     <日志目录|段文件|报文会话文件> [--grep stall]    # 日志流/聚合
```

## 双轨对照（报文说"发生了什么"，日志说"引擎为什么"）

```bash
# 1) 报文侧定位异常窗口（业务标签在报文会话上）
node dashcam/cli.js slice 录制.ndjson --from 600 --to 640
# 2) 拿会话窗口的绝对毫秒去问日志（传会话文件自动经 index.logRef 找日志目录）
node dashcam/cli.js log 录制.ndjson --ms=1730419200000,1730419264000 --lvl=info --mod=SECRET
# 3) 不知道哪个模块在刷屏时先聚合
node dashcam/cli.js log store/log/<uid>/ --hour=20261104 --group=modlvl
```

日志旗标：`--hour=20261104` 选段（天粒度；旧版小时段 `--hour=20261104T15` 仍兼容）、`--ms=from[,to]` 绝对毫秒窗（可开区间，与会话 logRef 窗同时给取交集）、`--lvl` 最低档（debug|info|warn|error 只升不降）、`--mod`/`--grep` 子串、`--group=mod|lvl|modlvl` 聚合、`--limit`、`--json`。

等级语义（高→低）：`error` 确定性停摆/不变量违例（必须人工看）、`warn` 真异常但可恢复/已降级、`info` 生命周期+可预期业务拒绝、`debug` 调度细节。排查开场先用 `--lvl=error` 扫一眼，有条目就是引擎自己好不了；再降到 `warn`/`info` 定时间轴。

## 分析纪律（踩过坑的）

1. **cmd 语义自己给**：CLI 只认格式不懂业务，`--cmd` 数字含义要对照 `extension/src/core/constants.js` / 逆向文档，不要臆测。
2. **对拍先立真值**：回答"引擎行为对不对"之前，先用 series/index 把实际报文的频次、间隔分位（如 8521 p50≈6s）拉出来当基线，再对照仿真/代码。
3. **仿真 harness 不在这里**：依赖 extension 源码的引擎仿真（如 pilot 单引擎仿真）属扩展验证工具（.replaytmp/tools），只把「读取原语」复用 `dashcam/lib/rec.js`（entries/dirOf/payloadOf/innerOf/int64Num/pickPath/logSegments）。
4. **Int64 字段**：`{_low,_high}` 形态的位宽（fightBeginTime 等）用 `int64Num` 解，直接 Number() 会得 NaN。
5. **精度不对称**：长整型 id（callTId/teamId）在报文里可能已丢精度，比对用 String 或容差。

## store 修复（分析之外的写操作，CLI 红线仍是只读）

`dashcam/repair-store.js`（migrate-store.js 的姊妹脚本）处理两类历史损坏，命名/派生算法逐字复刻 server.js 生产者（sanitize/slugPiece/deriveSlug/resolveName/nameCounts 口径），避免与在线定稿漂移：

```bash
node dashcam/repair-store.js merge    [--uid=<uid>] [--apply]              # base + base-NN 同会话分片合回单文件
node dashcam/repair-store.js finalize <uid> [<startLocal|sessionId>] [--note=<note>] [--apply]
```

- **先诊断再动手**：seq 跨片从 1 连续铺满、无重复空洞且 ts 单调 → 同一会话可并；各片 seq 各自从 1 起 → 不同会话，merge 会自动拒绝（退码 2，不碰文件）。
- **安全约定**：默认 dry-run；`--apply` 前自动探测 7391，dashcam server 在跑则拒绝执行；写出后回读行数==源总和才删源；index tmp+rename、按 start 升序。
- **note 不可恢复**：x-note 从不编码进 .part 文件名，finalize 缺省留空（不臆造）；确认过来源可 `--note=` 补。

## 边界（红线）

`dashcam/` 只认落盘格式、不懂游戏业务：不 import `extension/src` 任何常量；cmd→语义由调用方给。反向亦然——扩展侧不得依赖 dashcam 的代码（数据格式以 README 为准）。
