# dashcam —— pocketcc 报文行车记录仪

接收 pocketcc 扩展录制的网络报文，按「会话 / 日期」落盘成 NDJSON，供离线分析。
玩游戏时报文自动流入这里，无需手动录包。

## 启动

```bash
cd dashcam
node server.js
```

无三方依赖（纯 `node:http`），需 Node >= 18。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHCAM_PORT` | `7391` | 监听端口（仅绑 `127.0.0.1`） |
| `DASHCAM_OUT` | `dashcam/store` | 落盘根目录 |

## 与扩展的链路

```
扩展 MAIN(net-collect) → bridge → background service worker → POST http://127.0.0.1:7391/ingest → dashcam 落盘
```

在扩展面板「系统设置 → 报文录制」勾选开启，转发地址默认即 `http://127.0.0.1:7391/ingest`。

## 路由

- `GET /` 健康检查，返回 `{ service, out, port, activeSessions }`，可在浏览器直接打开验证服务在跑。
- `POST /ingest` 请求头 `x-session`/`x-uid`/`x-start`/`x-note`(percent 编码)/`x-done`，body 为 NDJSON（每行一条报文）。

## 命名规范（一次开→关 = 一个文件）

```
store/<uid>/<startLocal>[-<note>][-<slug>].ndjson
例：store/14179309129759/20260929T101432-芯片祝福STEP2.ndjson
    store/14179309129759/20260929T103201-airdrop-info+chip-airdrop.ndjson   ← 无 note 时自动派生 slug
```

- `<startLocal>`：录制启动时刻本地紧凑时间 `YYYYMMDDTHHMMSS`（可排序、可读）
- `<note>`：面板「本次标签」预填（可空；**优先作主题词**，保留中文，仅去路径/控制字符）
- `<slug>`：自动派生——本段 cmd 统计去掉噪声（心跳/`GET_WORLD_INFO` 等高频轮询）与 `GET_` 等前缀后，取 top 请求名（无 note 时作主题）
- 会话进行中先写 `*.part.ndjson`，收到 `x-done` 或空闲超时后**定稿**：算 slug → 重命名为最终名 → 追加索引。

## 索引侧车 `store/<uid>/index.ndjson`

每定稿一次会话追加一行（按 start 升序重写），作为「行程表」，文件名保持机器友好、人读检索走这里：

```json
{"file":"<uid>/<name>.ndjson","uid":...,"sessionId":...,"start":...,"end":...,"durMs":...,"lines":...,"slug":"...","note":"...","finalized":true,"top":[["GET_WORLD_INFO",19],...]}
```

## 落盘格式

每行是一条 net entry（由扩展 `net.js` 构造）：

```json
{"dir":"push","cmd":10912,"name":"XXX","data":{...},"raw":{...},"ts":1730000000000,"seq":42,"rt":null}
```

- `dir`：`req:send|req:sendPB|req:sendPBV2|resp|push`
- `cmd`：命令号；`name`：反查的可读常量名
- `data`：归一化业务数据；`raw`：原始报文/发送载荷快照
- `ts`：毫秒时间戳；`seq`：全局序号；`rt`：应答对应的发包时刻（非应答为 null）

分析时先读 `store/<uid>/index.ndjson` 一眼看全局，再定点打开对应 `.ndjson`。也可按行 `JSON.parse` 统计 cmd 分布：

```bash
# PowerShell：统计某会话内各 cmd 出现次数
Get-Content store/*/*.ndjson | ForEach-Object { ($_ | ConvertFrom-Json).cmd } | Group-Object | Sort-Object Count -Descending
```

## 安全

仅监听 `127.0.0.1`，会话名做文件名净化并强制剥离 `..` 防目录穿越；单批 body 上限 32MB。
