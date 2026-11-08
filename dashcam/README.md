# dashcam — pocketcc 行车记录仪（报文 + 日志双记录）

接收 [pocketcc 扩展](../extension/README.md) 上送的两类流并落盘，供离线逆向分析：

1. **网络报文**（「报文录制」开关，会话制，有业务标签）——玩游戏时协议报文自动流入，无需手动抓包。
2. **扩展日志**（「日志上送」开关，长期常开，无业务语义）——引擎决策的「内心独白」，与报文双轨对照。

> 属于 [pocketcc](../README.md) 仓库，是与扩展**并列的独立工程**：纯 Node.js、无第三方依赖，与扩展无运行时耦合（两个开关都关时无需运行本服务）。

## 目录

- [启动](#启动)
- [环境变量](#环境变量)
- [与扩展的链路](#与扩展的链路)
- [路由](#路由)
- [报文命名规范](#报文命名规范一次开--关--一个文件)
- [日志命名与轮转](#日志命名与轮转长期常开按天直写)
- [索引侧车](#索引侧车-storerecuid-dashcam-rec-indexndjson)
- [落盘格式](#落盘格式)
- [离线分析 CLI](#离线分析-clidashcamclij)
- [安全](#安全)

## 启动

```bash
cd dashcam
npm start          # 等价 node server.js
```

无三方依赖（纯 `node:http`），需 **Node >= 18**，ESM。

### 环境变量

| 变量                 | 默认值          | 说明                                   |
| -------------------- | --------------- | -------------------------------------- |
| `DASHCAM_PORT`       | `7391`          | 监听端口（仅绑 `127.0.0.1`）           |
| `DASHCAM_OUT`        | `dashcam/store` | 落盘根目录（已在 `.gitignore`）        |
| `DASHCAM_LOG_MAXSEG` | `32MB`          | 日志单段字节保险丝（超限滚下一序号段） |

## 与扩展的链路

```
报文：MAIN(core/net-collect.js 缓冲 NDJSON)
        → postMessage → bridge.js(ISOLATED) → chrome.runtime → background.js(SW fetch)
        → POST /ingest
日志：MAIN(core/log.js sink tee → core/log-collect.js 缓冲+折叠)
        → 同一条 bridge/background 通道（op=dashcam-log-flush）
        → POST /log
```

扩展侧经 background service worker 代发 HTTP，以绕开游戏页的 CSP / 混合内容限制（扩展自带 `host_permissions: http://127.0.0.1/*`）。面板「系统设置」里「报文录制」与「日志上送」是**两个独立开关**（不同存储键、不同端点、关一个不影响另一个），默认端点即 `/ingest` 与 `/log`。日志上送热路径极薄（一次判空+push，序列化/网络全部延迟到 flush），长期开着不拖慢游戏页。

## 路由

- `GET /` — 健康检查，返回 `{ service, out, port, activeSessions }`，可在浏览器直接打开验证服务在跑。
- `POST /ingest` — 请求头 `x-session` / `x-uid` / `x-start` / `x-note`（percent 编码）/ `x-done`，body 为 NDJSON（每行一条报文）。
- `POST /log` — 请求头 `x-uid` / `x-run`，body 为 NDJSON（每行一条日志 `{ts,lvl,mod,msg,n}`）。

## 报文命名规范（一次开→关 = 一个文件）

```
store/rec/<uid>/dashcam-rec-<startLocal>[-<note>][-<slug>].ndjson
例：store/rec/14179309129759/dashcam-rec-20260929T101432-芯片祝福STEP2.ndjson
    store/rec/14179309129759/dashcam-rec-20260929T103201-airdrop-info+chip-airdrop.ndjson   ← 无 note 时自动派生 slug
```

- **统一 `dashcam-rec-` 前缀 + `store/rec/` 目录**双保险，与日志侧 `dashcam-log-`/`store/log/` 互不误吞（任一侧 glob 都不会命中另一侧）。

- `<startLocal>`：录制启动时刻本地紧凑时间 `YYYYMMDDTHHMMSS`（可排序、可读）。
- `<note>`：面板「本次标签」预填（可空；**优先作用作主题词**，保留中文，仅去路径/控制字符）。
- `<slug>`：自动派生——本段 cmd 统计去掉噪声（心跳 / `GET_WORLD_INFO` 等高频轮询）与 `GET_` 等前缀后，取 top 请求名（无 note 时作主题）。
- 会话进行中先写 `dashcam-rec-*.part.ndjson`；收到 `x-done` 或空闲超时后**定稿**：算 slug → 重命名为最终名 → 追加索引。

## 日志命名与轮转（长期常开，按天直写）

```
store/log/<uid>/dashcam-log-<YYYYMMDD>[-NN].ndjson
例：store/log/14179309129759/dashcam-log-20261104.ndjson        ← 当天段
    store/log/14179309129759/dashcam-log-20261104-01.ndjson     ← 单段超 LOG_MAX_SEG 的溢出序号段
```

> 早期无前缀的小时段 `20261104T15.ndjson`、按天段 `20261104.ndjson` 形式文件仍被分析 CLI（`logSegments`）兼容读取，历史数据不丢。

与报文流的本质差异：日志无业务语义，不分会话、不定稿、不建索引——**按行内 ts 归天段直接 append 最终文件名**（传统 logrotate 形态，崩溃不丢已写内容）。`store/log/` 与报文 `store/rec/` 目录分层，加上各自文件名前缀，glob 不会误吞。`LOG_MAX_SEG` 是滚段**触发阈值而非硬截断**（单批可整体超出后滚下一段）；本服务按**单实例**设计，多进程共用同一 `DASHCAM_OUT` 不保证并发安全。

**与报文会话的配对是查询时软引用**：报文定稿时 index 行写入 `logRef:{dir,from,to}`（日志自己不带业务标签，业务窗口由报文侧供给），CLI 能自动解析。

## 索引侧车 `store/rec/<uid>/dashcam-rec-index.ndjson`

每定稿一次会话追加一行（按 `start` 升序整体重写），作为「行程表」。固定机器友好名 `dashcam-rec-index.ndjson`（与同目录 `dashcam-rec-*.ndjson` 录制体共用前缀，但不带时间戳不会归入录制）：

```json
{"file":"rec/<uid>/dashcam-rec-<name>.ndjson","uid":...,"sessionId":...,"start":...,"end":...,"durMs":...,"lines":...,"slug":"...","note":"...","finalized":true,"top":[["GET_WORLD_INFO",19]],"logRef":{"dir":"log/<uid>","from":...,"to":...}}
```

> `file` / `logRef.dir` 均为相对 `DASHCAM_OUT`（store 根）的路径：录制在 `rec/<uid>/…`，日志在 `log/<uid>/…`。

## 落盘格式

### 报文（/ingest）

每行是一条 net entry（由扩展 `core/net.js` 构造）：

```json
{
  "dir": "push",
  "cmd": 10912,
  "name": "XXX",
  "data": {},
  "raw": {},
  "ts": 1730000000000,
  "seq": 42,
  "rt": null
}
```

- `dir`：`req:send` | `req:sendPB` | `req:sendPBV2` | `resp` | `push`
- `cmd`：命令号；`name`：反查的可读常量名
- `data`：归一化业务数据；`raw`：原始报文/发送载荷快照
- `ts`：毫秒时间戳；`seq`：全局序号；`rt`：应答对应的发包时刻（非应答为 `null`）

### 日志（/log）

每行一条结构化日志（由扩展 `core/log.js` tee + `core/log-collect.js` 产出）：

```json
{ "ts": 1730000000000, "lvl": "warn", "mod": "SECRET", "msg": "dispatch stall, retry 2", "n": 3 }
```

- `lvl`：`error`（确定性停摆/不变量违例）| `warn`（真异常但可恢复/已降级）| `info`（关键动作/可预期业务拒绝）| `debug`（调度细节）；面板可调最低档
- `mod`：`createLog` 的模块标记（如 NET / SECRET / REC）；`msg`：printf 自拼后的完整单行文本
- `n`：**折叠重复计数**——连续同 `(lvl,mod,msg)` 合并成一条（缺省 1）；溢出时批头会插一条 `[dropped N]` 审计行
- ⚠️ 隐私：扩展同时开「网络日志」+「日志上送」时，req/resp 载荷会拼进 msg 落盘（含玩家名/坐标等），单行扩展侧截 2048 字符；日常只上送决策日志建议保持 minLvl=info 且关网络日志

## 离线分析 CLI（`dashcam/cli.js`）

录制读取原语（纯格式层，`lib/rec.js`）+ 六个子命令，无三方依赖：

```bash
cd dashcam
node cli.js index <file.ndjson>                          # 全局概览：cmd×dir 频次/首末 ts/name
node cli.js series <file> --cmd 8521 --dir req --fields x,y   # 时序抽取（自带间隔分位数）
node cli.js shape  <file> --cmd 901 --dir resp           # 字段形态：path→覆盖数+样例
node cli.js slice  <file> --from 1130 --to 1146          # 时间窗全事件流水
node cli.js push   <file> --cmd 21534 --field num --gt 0 # 推送标量分布/命中序列/脉冲间隔
node cli.js log    <目录|段文件|报文会话文件> --grep stall # 日志流/聚合（双轨对照）
```

旗标：`--dir=req|resp|push`（req:* 归一为 req）、`--from/--to` 相对首行 ts 的秒（`--anchor` 改锚点）、`--limit`、`--json`（机器可读）、`--width`（截断宽）。大文件流式扫，153MB 单命令约 10s。

log 专属旗标：`--hour=20261104` 选段（天粒度；旧版 `--hour=20261104T15` 小时段仍兼容）、`--ms=from[,to]` 绝对毫秒窗（接 slice 窗口的双轨对照；缺 to 意为「此刻往后」，与软引用窗同时给则取**交集**）、`--lvl` 最低档（debug|info|warn|error 只升不降）、`--mod`/`--grep` 子串过滤、`--group=mod|lvl|modlvl` 聚合计数（诊断哪个模块在刷屏）。位置参数传**报文会话文件**时自动经 `dashcam-rec-index.ndjson` 的 `logRef` 解析日志目录并限定会话窗。

```bash
# 双轨对照：报文发现 t+600~640s 行为异常 → 拉同时刻引擎内心独白
node cli.js slice 录制.ndjson --from 600 --to 640
node cli.js log 录制.ndjson --lvl=info --grep stall
```

**边界（红线）**：本 CLI 只认落盘格式、不懂游戏业务——cmd 语义由调用方给，不 import `extension/src` 任何常量。依赖引擎的仿真/回放 harness（如秘境的 pilot 单引擎仿真）属于扩展验证工具，不在本工程。

## store 维护脚本（写操作，`cli.js` 自身仍只读）

两个一次性/按需维护脚本，命名与派生算法以本文档为准复刻 `server.js`（若服务端落盘格式变更须同步）：

- `migrate-store.js` —— 旧布局→新规范（rec/log 分层 + 前缀）一次性迁移，已执行完毕，保留备查。
- `repair-store.js` —— 修历史损坏：

```bash
cd dashcam
node repair-store.js merge    [--uid=<uid>] [--apply]              # 同会话被撞名拆成 base + base-NN → 合回单文件
node repair-store.js finalize <uid> [<startLocal|sessionId>] [--note=<note>] [--apply]  # 孤儿 .part → 转正名 + 补 index
```

纪律：默认 dry-run；`--apply` 前自动探测端口（server 在跑则拒绝）；merge 校验 seq 跨片从 1 连续铺满且 ts 单调才并（不满足=不同会话，拒绝、退码 2）；写出回读行数==源总和才删源；index tmp+rename 按 start 升序；x-note 不在 .part 文件名里，finalize 缺省留空不臆造。

也可逐行 `JSON.parse` 自写脚本统计：

```powershell
# PowerShell：统计某会话内各 cmd 出现次数
Get-Content store/rec/*/*.ndjson | ForEach-Object { ($_ | ConvertFrom-Json).cmd } | Group-Object | Sort-Object Count -Descending
```

## 安全

仅监听 `127.0.0.1`；uid / session 名经 `sanitize`（去非 `[\w.\-]`、强制剥离 `..`）防目录穿越，note 经 `sanitizeNote`（允许中文，仅去路径/控制字符）；单批 body 上限 32MB。进程退出时 `SIGINT`/`SIGTERM` 触发 shutdown 收尾全部活跃会话。

## 许可

未声明开源许可的个人项目（私有、暂不授权再分发）。
