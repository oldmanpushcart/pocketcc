---
name: pocketcc-dashcam
description: pocketcc dashcam 报文录制服务（Node.js）工程规范，覆盖零依赖约束、NDJSON 会话落盘与定稿时序、ingest 协议头编码、文件名净化安全、环境变量契约与容错风格。当修改 dashcam/server.js、新增路由或会话存储逻辑、分析 store 下报文文件、或用户提到 dashcam、ingest、NDJSON、会话定稿、报文录制时使用。
---

# pocketcc dashcam 工程规范

## 运行与验证

- 启动：`cd dashcam; npm start`（等价 `node server.js`），无构建步骤。
- 健康检查：浏览器打开 `GET http://127.0.0.1:7391/`，返回 `{ service, out, port, activeSessions }`。
- 校验：根目录 `npm run lint`（dashcam 归入 Node ESM 段配置）；改动落盘逻辑后用真实 POST 回放一段 NDJSON 验证。

## 硬性红线

- **零第三方依赖**：只用 Node 内置模块（`node:http`/`node:fs`/`node:path`/`node:url`），需要工具能力时手写函数，不引 npm 包。Node >= 18，ESM。
- **仅绑定 `127.0.0.1`**，任何情况下不得改成 `0.0.0.0`。
- 用户可控字符串（uid/sessionId/note）进文件路径前**必须过 `sanitize`/`sanitizeNote`**：只留 `[\w.\-]`、强制剥离 `..`；note 允许中文，仅去路径/控制字符。
- 单批 body 上限 `MAX_BODY = 32MB`，超限拒收，不得放开。
- 环境变量契约只有两个：`DASHCAM_PORT`（默认 7391）、`DASHCAM_OUT`（默认 `dashcam/store`，已 gitignore）。新增配置沿用它俩的模式，不引入配置文件。

## 落盘模型（改动前必须先理解）

```
会话进行中：store/<uid>/<sessionId>.part.ndjson   只 append，稳定
定稿触发：  x-done=1 请求头 ∥ 空闲超 IDLE_FINALIZE_MS(3min)，sweeper 每 30s 扫
定稿动作：  算 slug → .part 重命名为最终名 → index.ndjson 追加/更新一行（按 start 升序整体重写）→ 出 active 表
最终命名：  store/<uid>/<startLocal>[-<note>][-<slug>].ndjson
  startLocal = 本地紧凑时间 YYYYMMDDTHHMMSS（可排序）
  slug       = cmd 统计剥噪声(NOISE_NAMES)与 GET_ 等前缀后的 top 请求名（无 note 时作主题）
```

- 会话状态只在内存双 Map（`active`: sessionId→会话态；`indexes`: uid→session→索引条目），不引入持久队列/数据库；定稿重命名失败时保留 `.part` 交下次 sweep 重试。
- `SIGINT`/`SIGTERM` 时 shutdown 收尾全部活跃会话——新增会话态时要同步保证能被收尾。

## ingest 协议（与扩展的契约）

- 链路：`MAIN(net-collect 缓冲) → postMessage → bridge → chrome.runtime → background fetch POST /ingest`，改协议要同时核对扩展侧。
- 请求头：`x-session` / `x-uid` / `x-start` / `x-note` / `x-done`。**HTTP 头只能 Latin-1**——含中文的 note 必须扩展侧 `encodeURIComponent`、本侧 `decodeURIComponent`，这条互锁不可破坏。
- body 为 NDJSON，每行一条 net entry：`{dir,cmd,name,data,raw,ts,seq,rt}`；`dir` 取值 `req:send|req:sendPB|req:sendPBV2|resp|push`，`rt` 非应答为 `null`。
- 落盘按行原样存储（机读友好），人读检索走 `index.ndjson`，不要在文件名里塞语义。

## 容错与日志风格

- 容错式处理：单行报文解析失败跳过该条、不杀整个请求；磁盘写失败记日志、会话循环自愈。
- `NOISE_NAMES` 噪声名单（心跳/高频轮询）允许按真机反馈增补，这是唯一常态可增的数据表。
- 控制台日志面向运维者：启动打印监听地址与 OUT 目录，会话定稿打印文件名与行数；不用第三方 logger。

## 文档同步

- 路由、命名规范、环境变量、落盘格式任一契约变化时，同步更新 `dashcam/README.md` 对应小节（README 是对外契约文档）。

## 交付前自查

- [ ] 未新增任何 require/import 三方包
- [ ] 用户可控字符串全部过 sanitize/sanitizeNote，`..` 无法穿透路径
- [ ] 新会话态在 shutdown 与 sweeper 两条路径都有归宿
- [ ] 协议头中文编码互锁未被破坏（Latin-1 约束）
- [ ] `npm run lint` 无新增 error；README 契约小节已同步
