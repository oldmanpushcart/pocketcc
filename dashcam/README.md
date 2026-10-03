# dashcam — pocketcc 报文行车记录仪

接收 [pocketcc 扩展](../extension/README.md) 录制的网络报文，按「会话 / 日期」落盘成 NDJSON，供离线逆向分析。玩游戏时报文自动流入这里，无需手动抓包。

> 属于 [pocketcc](../README.md) 仓库，是与扩展**并列的独立工程**：纯 Node.js、无第三方依赖，与扩展无运行时耦合（不启用「报文录制」时无需运行本服务）。

## 目录

- [启动](#启动)
- [环境变量](#环境变量)
- [与扩展的链路](#与扩展的链路)
- [路由](#路由)
- [命名规范](#命名规范一次开--关--一个文件)
- [索引侧车](#索引侧车-storeuidindexndjson)
- [落盘格式](#落盘格式)
- [分析示例](#分析示例)
- [安全](#安全)

## 启动

```bash
cd dashcam
npm start          # 等价 node server.js
```

无三方依赖（纯 `node:http`），需 **Node >= 18**，ESM。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHCAM_PORT` | `7391` | 监听端口（仅绑 `127.0.0.1`） |
| `DASHCAM_OUT` | `dashcam/store` | 落盘根目录（已在 `.gitignore`） |

## 与扩展的链路

```
扩展 MAIN(core/net-collect.js 缓冲 NDJSON)
   → postMessage →  bridge.js(ISOLATED)
   → chrome.runtime →  background.js(service worker, fetch POST)
   → POST http://127.0.0.1:7391/ingest
   → dashcam 落盘
```

扩展侧经 background service worker 代发 HTTP，以绕开游戏页的 CSP / 混合内容限制（扩展自带 `host_permissions: http://127.0.0.1/*`）。在扩展面板「系统设置 → 报文录制」勾选开启，转发地址默认即 `http://127.0.0.1:7391/ingest`。

## 路由

- `GET /` — 健康检查，返回 `{ service, out, port, activeSessions }`，可在浏览器直接打开验证服务在跑。
- `POST /ingest` — 请求头 `x-session` / `x-uid` / `x-start` / `x-note`（percent 编码）/ `x-done`，body 为 NDJSON（每行一条报文）。

## 命名规范（一次开→关 = 一个文件）

```
store/<uid>/<startLocal>[-<note>][-<slug>].ndjson
例：store/14179309129759/20260929T101432-芯片祝福STEP2.ndjson
    store/14179309129759/20260929T103201-airdrop-info+chip-airdrop.ndjson   ← 无 note 时自动派生 slug
```

- `<startLocal>`：录制启动时刻本地紧凑时间 `YYYYMMDDTHHMMSS`（可排序、可读）。
- `<note>`：面板「本次标签」预填（可空；**优先作用作主题词**，保留中文，仅去路径/控制字符）。
- `<slug>`：自动派生——本段 cmd 统计去掉噪声（心跳 / `GET_WORLD_INFO` 等高频轮询）与 `GET_` 等前缀后，取 top 请求名（无 note 时作主题）。
- 会话进行中先写 `*.part.ndjson`；收到 `x-done` 或空闲超时后**定稿**：算 slug → 重命名为最终名 → 追加索引。

## 索引侧车 `store/<uid>/index.ndjson`

每定稿一次会话追加一行（按 `start` 升序整体重写），作为「行程表」。文件名保持机器友好，人读检索走这里：

```json
{"file":"<uid>/<name>.ndjson","uid":...,"sessionId":...,"start":...,"end":...,"durMs":...,"lines":...,"slug":"...","note":"...","finalized":true,"top":[["GET_WORLD_INFO",19]]}
```

## 落盘格式

每行是一条 net entry（由扩展 `core/net.js` 构造）：

```json
{"dir":"push","cmd":10912,"name":"XXX","data":{},"raw":{},"ts":1730000000000,"seq":42,"rt":null}
```

- `dir`：`req:send` | `req:sendPB` | `req:sendPBV2` | `resp` | `push`
- `cmd`：命令号；`name`：反查的可读常量名
- `data`：归一化业务数据；`raw`：原始报文/发送载荷快照
- `ts`：毫秒时间戳；`seq`：全局序号；`rt`：应答对应的发包时刻（非应答为 `null`）

## 分析示例

分析时先读 `store/<uid>/index.ndjson` 一眼看全局，再定点打开对应 `.ndjson`。也可逐行 `JSON.parse` 统计 cmd 分布：

```powershell
# PowerShell：统计某会话内各 cmd 出现次数
Get-Content store/*/*.ndjson | ForEach-Object { ($_ | ConvertFrom-Json).cmd } | Group-Object | Sort-Object Count -Descending
```

## 安全

仅监听 `127.0.0.1`；uid / session 名经 `sanitize`（去非 `[\w.\-]`、强制剥离 `..`）防目录穿越，note 经 `sanitizeNote`（允许中文，仅去路径/控制字符）；单批 body 上限 32MB。进程退出时 `SIGINT`/`SIGTERM` 触发 shutdown 收尾全部活跃会话。

## 许可

未声明开源许可的个人项目（私有、暂不授权再分发）。
