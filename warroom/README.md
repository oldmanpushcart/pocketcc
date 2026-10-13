# warroom —— 战报下载 / 解析 / 分析系统

> pocketcc 仓库的并列子工程之一。回链：[根 README](../README.md) · 兄弟工程 [extension](../extension/README.md)、[dashcam](../dashcam/README.md)

`warroom` 读取《口袋奇兵》的战斗结算记录（战报 / report），把重字典 ID 编码的原始 JSON
解析为结构化数据并持久化，后续叠加规则统计与大模型分析，产出**整体 + 攻方 + 守方**三份
改进建议。同时沉淀玩家档案，供跨战报统计战力情况。

## 目录

- [定位与命名](#定位与命名)
- [数据链路](#数据链路)
- [安装](#安装)
- [配置](#配置)
- [使用](#使用)
- [存储设计](#存储设计)
- [开发约定](#开发约定)
- [路线图](#路线图)

## 定位与命名

命名延续 [dashcam](../dashcam/README.md)（报文"行车记录仪"）的英文隐喻风格：dashcam 管"录"，
warroom（作战室）管"复盘推演 + 给决策"。本工程**独立于**扩展与 dashcam，自带 `package.json`，
不参与根 `esbuild` 构建，仅按需读取游戏侧产出的战报数据。

## 数据链路

战报正文存于阿里云 OSS，**链接限时有效会过期**，因此第一要务是"抓到即永久缓存原文"。

```
战报ID  ──link.js──►  OSS URL  ──fetch.js──►  raw/{prefix4}/{id}.json (永久留档)
 (4878890640079697925)         │                        │
                               └── 读信封字段 ──────────►  SQLite reports 索引
```

URL 拼写规则（已实测，无需登录态）：

```
{baseUrl}/prod/{id前4位}/{完整ID}.json
4878890640079697925 → https://fight-report.oss-accelerate.aliyuncs.com/prod/4878/4878890640079697925.json
```

## 安装

```bash
cd warroom
npm install          # 唯一三方依赖：better-sqlite3（含原生二进制）
```

要求 Node.js >= 18（使用全局 `fetch`、`AbortSignal.timeout`）。

## 配置

复制 `config.example.json` 为 `config.json`（后者已 gitignore，可安全填写私密值）：

```bash
Copy-Item config.example.json config.json   # PowerShell
```

- **AK 走环境变量**：`config.json` 里 `"apiKey": "${WARROOM_LLM_AK}"` 会被自动展开为同名环境变量值；
  环境变量缺失时该字段解析为 `null` 并记录，**不会**把占位符原文写库，也不阻断 `fetch`/`info`。
- 路径均可用 `WARROOM_DATA` 覆盖数据根目录；`WARROOM_DEBUG=1` 打开 debug 级日志。

## 使用

```bash
node cli.js fetch <reportId...> [--force]   # 下载（默认幂等：本地已有则跳过网络）
node cli.js import <file.json> <reportId>   # 导入已在本地的原始战报文件
node cli.js info                             # 查看库/落盘状态与迁移版本
```

示例（本仓库已实测跑通）：

```bash
node cli.js fetch 4878890640079697925 4878890262508451849
node cli.js info
```

## 存储设计

**双层持久化**（详见 [`src/schema.js`](./src/schema.js)）：

| 层 | 存什么 | 位置 |
|----|--------|------|
| 文件层 | 下载的原始战报 JSON、字典快照 | `data/raw/`、`data/dicts/` |
| SQLite | 解析后的结构化数据、玩家档案、分析结果 | `data/warroom.db` |

三条建模原则：

1. **冷热分离**：高频统计字段（战力、结果、uid、时间）摊平成列；`formation_v2`、`enigmas`
   等待考证容器先存 JSON 列，解码一个、拆列一个，解析进度不堵建模。
2. **64 位 ID 一律 TEXT**：`report_id`/`uuid`/`march_id`/`uid` 超 `2^53`，绝不 `Number` 化，杜绝精度丢失。
3. **字典版本随行**：`reports.dict_version` + `dict_entries` 带版本键，历史战报可按当时代码复现。

表清单：`reports` · `battle_marches` · `sides` · `side_players` · `side_units` ·
`unit_instances` · `battle_events` · `players` · `dict_entries` · `rule_findings` · `analyses`。
其中 `analyses.scope` 取 `overall/attacker/defender`，正好对应三份报告。

## 开发约定

- ESM + Node 全局；日志走 [`src/log.js`](./src/log.js) 的 `createLog(MODULE)`，前缀 `[WARROOM://<MODULE>]`，
  message 一律英文，级别语义 info=生命周期/debug=逐条/warn=真异常（对齐扩展侧约定）。
- 原子落盘：`.part` → `rename`，避免半写文件。
- 已注册进根 ESLint（`warroom/**/*.js` 归 Node 环境 + sonarjs 精选规则），提交前 `npx eslint warroom` 应零告警。
- 数据目录 `data/`、`config.json`、`node_modules/` 均已 gitignore。

## 路线图

- [x] **Phase 1**：工程骨架 + `link`/`fetch`（ID→URL→下载→原文落盘+索引）+ SQLite v1 建表 —— 已实测跑通
- [ ] **Phase 2**：数据字典获取/解码/版本化 + `parse`（翻游戏源码逐容器考证 sides/units/events/players）
- [ ] **Phase 3**：`players` 聚合统计（战力曲线、胜败/被攻 TopN）
- [ ] **Phase 4**：规则/统计报告 + LLM 三路输出（整体 / 攻方 / 守方三份）
