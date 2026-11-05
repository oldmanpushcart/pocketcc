# pocketcc（口袋控制中心）

口袋奇兵（Top War，`warh5.rivergame.net`）H5 页游的**个人逆向辅助工具集**。本仓库并列两个**相互独立**的工程，各自有自己的 `package.json` 与 README：

| 工程 | 类型 | 说明 | 文档 |
|---|---|---|---|
| [`extension/`](./extension/) | Chrome MV3 扩展 | 跑在游戏页 MAIN world 的自动化辅助：免扫码登录、自动重连、日常/活动任务、地图侦察、聊天、报文录制 | [`extension/README.md`](./extension/README.md) |
| [`dashcam/`](./dashcam/) | Node.js HTTP 服务 | 扩展「报文录制」落盘的接收端：按会话/日期把 NDJSON 报文写盘，供离线逆向分析 | [`dashcam/README.md`](./dashcam/README.md) |

> 个人逆向学习与自用项目。使用第三方辅助可能违反游戏用户协议，风险自负。

## 两者的关系

两个工程**没有运行时依赖**，只通过一条本地 HTTP 链路松耦合——扩展负责采集，dashcam 负责落盘：

```
游戏页 MAIN world                         扩展自有进程                本地服务
core/net-collect.js  ──postMessage──▶  bridge.js  ──runtime──▶  background.js  ──fetch POST──▶  dashcam /ingest
   (缓冲 NDJSON)                        (ISOLATED)              (service worker, 绕页面 CSP)      (按会话落盘 .ndjson)
```

不启用「报文录制」时，`dashcam/` 完全不需要运行；扩展可独立使用。

## 仓库布局

```
pocketcc/
├─ extension/          Chrome MV3 扩展工程（详见 extension/README.md）
├─ dashcam/            报文录制接收服务（详见 dashcam/README.md）
├─ references/         只读逆向素材：游戏源码镜像 + 分析台账（不入库的大文件已 .gitignore）
├─ esbuild.config.mjs  扩展三入口的打包配置
└─ package.json        扩展构建脚本（npm run build / watch；dashcam 不在其中）
```

## 快速开始

**扩展**（Node.js 环境，开发用 esbuild，无运行时依赖）：

```bash
npm install
npm run build                 # 产物落 extension/dist/
# 浏览器 edge://extensions 开启「开发人员模式」→「加载解压缩的扩展」选择 extension/ 目录
```

**报文接收服务**（可选，仅当要开启扩展的「报文录制」时才需要）：

```bash
cd dashcam
npm start                     # 等价 node server.js，监听 http://127.0.0.1:7391
```

装好扩展进游戏页后，右下角浮动图标即控制面板。详细用法见 [`extension/README.md`](./extension/README.md)。

## 技术栈

- **扩展**：JavaScript（ES Module）+ [esbuild](https://esbuild.github.io/) 打包为 IIFE（`target: chrome110`、未压缩 + sourcemap），Chrome Manifest V3，双 content script（MAIN + ISOLATED world）+ background service worker。
- **dashcam**：纯 Node.js（`node:http`），无第三方依赖，`engines.node >= 18`，ESM。
- 无锁文件 / 私有源 / CI；版本在各自 `package.json` 手动维护。

## 许可

未声明开源许可的个人项目（私有、暂不授权再分发）。若后续开源会在此补充许可证。
