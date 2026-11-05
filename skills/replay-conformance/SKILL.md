---
name: replay-conformance
description: pocketcc 录制回放对拍验证框架（Replay-Kit）使用与扩展规范，覆盖「内核 + Manifest」分层架构、新 feat 接入三步、三态判据(PASS/FAIL/无法判定)、HARD/SOFT/OBSERVATION 规则分级、reader/report 内核 API 契约、以及 dir 分支互斥/Int64 形态/uid 取值等踩坑纪律。当实现或改动某个 feat 后需用真人录制核对写动作、新增 scripts/verify-manifests/<id>.mjs、运行 node scripts/replay/run.mjs、或用户提到 录制验证/对拍/conformance/仿真验证/退码门禁时使用。
---

# 录制回放对拍验证（Replay-Kit）

拿「真人/旧版实机录制」当 ground truth，用**当前 feat 的规则**（`constants.js`）逐笔核对录制里的写动作是否自洽。纯离线 Node，不开浏览器、不连服务器、不发网络包，只读 `.ndjson` + import 常量。

## 何时触发

- 新实现或改动某个 feat 后，用手上的队长/实机录制跑一遍 conformance，确认代码规则没和真实报文打架。
- 要给一个此前没覆盖的 feat 建立验证基线（写一张新 manifest）。
- CI/提交前门禁：退码 `0`=HARD 全过，`1`=有 HARD 违例，`2`=manifest/参数问题。

## 运行入口

```bash
npm run verify:secret-realm                                              # 异能秘境（队长视角）
npm run verify:cs-hunt                                                   # 夺宝奇兵（主跑=队长 / 陪跑 双角色）
node scripts/replay/run.mjs --manifest <id> [录制.ndjson ...] [--verbose] # 通用入口；位置参数覆盖默认清单
```

报告每维度出 `✅ PASS` / `❌ FAIL` / `无法判定 N`（末者不判负）。只有 FAIL 才影响退码。

## 架构：内核 + Manifest 分层

- **内核 `scripts/replay/`（feat 无关，禁止塞私货）**
  - `int64.mjs`：`toNum`（`{_low,_high}`/十进制串/裸数 → Number，null → **NaN**）/ `isInt64Obj` / `isRidString` / `samePos`
  - `reader.mjs`：`scanNDJSON(recPath,{isWrite,onEntry,respPairs})` 单遍流式扫描；`snapshotAt(arr,T)` 二分回溯「发包那一刻」
  - `report.mjs`：`makeReport(verbose)` + `printReport(recName,S,rep,smoke)` 三态渲染
  - `engine.mjs`：`engineSmoke(featDir,modsMap)` 逐模块 import + 导出面校验
  - `run.mjs`：CLI 编排 + 退码
- **Manifest `scripts/verify-manifests/<id>.mjs`（feat 私货）**：默认导出 `{ id, featDir, defaultRecs[], engineMods, buildScan(recPath)→scan, runVerify(scan,rep) }`
- **已落地两张参考实现**：`secret-realm.mjs`（首张，队长单角色，含 901 视口↔区域配对维度）、`cs-hunt.mjs`（第二张，压测内核抽象——三通道 send/sendPB/sendPBV2 并存 + `REQ_FIELD` 业务槽间接 + Long-obj Int64 + 主跑/陪跑 role 差异，**内核零改动即扛住**）。接入新 feat 时优先照抄更贴近的那张。

## 接入新 feat（三步）

1. 新建 `scripts/verify-manifests/<id>.mjs`：`buildScan` 单遍扫录制重建现场态时间线（`scanNDJSON` + `onEntry` 收集 push/resp 快照并 `sort(byTs)`），`runVerify` 逐笔写动作用 `snapshotAt` 回查后过判据、调 `rep.check(name,d,pass,fail,skip,samples)`。
2. **协议号/阈值/点型/拒因一律 `import` 该 feat 的 `constants.js`**（单一真相源），严禁硬编码字面量或手抄一份字典。本人 uid 从录制目录名取（`path.basename(path.dirname(recPath))`），不钉死账号。
3. `node scripts/replay/run.mjs --manifest <id> [录制]` 跑通；按需加 `npm run verify:<id>` 脚本。生产 feat 代码**零改动**。

## 判据纪律

- **三态**：PASS / FAIL（仅 HARD 违例计入退码）/ 无法判定（稀疏回读、采样局限 → `skip`，绝不判负）。
- **规则分级**：HARD（跨版本恒成立，如载荷字段形态、Int64 口径）/ SOFT（版本迭代可合法收紧，如"只在某点位攻打"）/ OBSERVATION（节奏类，只报量级区间，如投喂间隔）。退码只对 HARD 严格。
- 视口/账本类对照若数据不足，宁可记 `skip`（无法判定），也不要「空集即通过」——那是伪 PASS。

## 踩过的坑（务必先实测再写分支）

1. **dir 分支互斥**：`onEntry` 的 `push/resp/req` 是 `if-else if` 链。写条件前先实测目标 cmd 在该录制里的真实 `dir` 分布——异能秘境曾把 901 视口采集写成 `else if(!dir.startsWith('req') && cmd===901)`，而 901 实际只有 `req:send`/`resp` 两种 dir，导致该分支**恒不可达**、两个维度一直空转。901 的 `pointList` 只在 `resp` 上，须归入 resp 分支。
2. **Int64 三形态**：同一字段可能是 `{_low,_high}` 对象 / 十进制串 / 裸数；比较统一走 `toNum()` 组装成 double 再比（`teamId` vs `callTId` 用字符串比反而不等）。`toNum` 对缺字段返回 `NaN`，参与 `<`/`>` 比较恒 false → 会假 FAIL，判据前加 `Number.isFinite` 守卫并记 `skip`。
3. **应答配对**靠 `resp.rt === req.ts`，`rt` 单独可能同毫秒碰撞；覆盖率偏低（频控/超时）只作 OBSERVATION，不判负。
4. **内核去私货**：`scripts/replay/*.mjs` 不得出现任何协议号/点型/账号/字段名（代码或文案都不行）——那些只能进 manifest。
5. **sendPB 的 `w.req` 形状坑**：内核 `writes.push({ req: (o.raw&&o.raw.data)||body||o.data||{} })` 对 `req:sendPB` 会优先取 `o.raw.data`（raw 外层 `{api,data}` 的载荷），**不等于** `entry.body`（想要的 `{header,<业务槽>}`）。异能秘境 85xx 时二者恰好全等掩盖了此分支，夺宝奇兵 sendPB 一暴露即需绕开——凡按业务槽取字段的 feat，在 `onEntry` 里用 `entry.body` **自建写视图**（逐通道剥槽），别信内核 `w.req`。改内核会破坏秘境保真，故修正归 manifest 侧。

## 边界（红线）

- 零第三方依赖（只 `node:fs`/`node:path`/`node:url`/`node:readline`），ESM，`scripts/**/*.mjs` 走 ESLint node globals。
- 严格只读：验证器绝不写 `store/`、不改 feat、不发网络包；`dashcam/` 是报文唯一生产者。
- 不进 esbuild 打包、不入 dependency-cruiser 的 `extension/src` 范围；与 `dashcam/cli.js` 的"读取原语"分工不同（见 `skills/dashcam-rec-analysis`：仿真 harness 不归那侧）。
