# storage.js — UID 隔离存储抽象（双 blob + slot + raw + 串行队列）

> 源码：[`src/core/storage.js`](../../src/core/storage.js)　·　日志 tag：`[POCKETCC://STORAGE]`

## 1. 职责与边界

**一句话**：MAIN world 无 `chrome.*`，本模块经 ISOLATED 的 bridge.js 用 postMessage 代理读写 `chrome.storage.local`，对外提供「UID 前缀隔离 + 配置/数据双 blob + 独立键 slot + 绕过前缀 raw 通道」四类存取，并以内存缓存 + 每 blob 串行队列保证读写安全。

**管什么**：

- **跨 world 桥接**：请求-应答用自增 `seq.n` 关联，`pending` Map 维护在途请求；监听 `bridge->main` 回执 resolve/reject。
- **UID 命名空间**：`setNamespace('pocketcc.u{uid}.')` 后所有 key 自动拼前缀；未设时写丢弃、读 reject。
- **双 blob 模型**：`CONFIG_KEY='pocketcc.config'`（开关/参数/组闸门）与 `DATA_KEY='pocketcc.data'`（运行期数据）完全解耦。
- **内存缓存 + 串行队列**：`blobs[blobKey]` 只在真正读盘成功后固化；`queues[blobKey]` 每 blob 独立串行写，避免并发 read-modify-write 覆盖。
- **独立键 slot**：`storage.slot.*` 绕过 blob 直接按逻辑键存取（不进取内存缓存），适合大体量分片数据。
- **raw 通道**：`getRaw/setRaw/removeRaw` 绕过 UID 前缀与 blob，仅旧全局键迁移/认领用。
- **上下文失效降级**：MV3 扩展重载后置位 `contextInvalidated`，后续 `call()` 短路为写丢弃/读回 undefined 且不 reject。

**不管什么**（铁律）：

- **不做配置合并/迁移语义**：读盘后如何按 defaults 合并、版本迁移属 [`registry.js`](../../src/core/registry.js)；本模块只管键值读写。
- **不主动设命名空间**：`setNamespace` 由 player.js 在 UID 就绪时调用。
- **MAIN 侧禁止直接 `chrome.storage`**：那是 bridge.js 的职责。

## 2. 设计思路与取舍

- **空快照绝不固化**：`loadBlob` 只有拿到盘的应答才写缓存；命名空间未设 reject、bridge 异常 reject 都不写缓存——否则一份空快照被缓存后，任何一笔写都会把整块 blob 覆成只剩那一个键，等于清空盘上已有数据。
- **读 reject 而非返回 null**：前缀未设时读直接报错，绝不把「没权限读」伪装成「盘上是空的」，防止 loadAllConfigs 用空快照覆盖真实数据。
- **上下文失效不 reject**：置位后 `call()` 短路返回 undefined 而非 reject，因为 warn 刷屏来自各 feat 自己的 `.catch(log.warn)`——只有让它不触发才能全局收口。上下文失效后不可能再落盘，刷新页面即整份重建，空快照固化无害。
- **slot 与 blob 队列隔离**：slot 写队列加 `slot:` 前缀，与 blob 队列互不干扰，避免大体量分片写阻塞配置写。

## 3. API 契约

```js
import { storage, setNamespace, getNamespace } from '../../core/storage.js';

setNamespace('pocketcc.u{uid}.');  // player.js 在 UID 就绪时调用
getNamespace();                     // 读当前前缀

// 配置 blob（逻辑键沿用调用点原有 storageKey 字面值）
await storage.get(key); storage.set(key, value); storage.remove(key);
storage.getAllConfig();             // 配置 blob 浅拷贝（供导出，不含 data）
// 数据 blob（与配置分离，频繁写互不干扰）
await storage.data.get(name); storage.data.set(name, value); storage.data.remove(name);
// 独立键（UID 前缀下、脱离双 blob，不进取内存缓存）
await storage.slot.get(name); storage.slot.set(name, value); storage.slot.remove(name);
// 绕过 UID 前缀 + 绕过 blob（仅 migrateLegacyKeys / 旧全局键认领）
await storage.getRaw(key); storage.setRaw(key, value); storage.removeRaw(key);
```

## 4. 场景用法

- **功能配置落盘**：走 registry（`saveFeature → storage.set(storageKey, cfg)`），feat 不直接摸 storage 写配置。
- **运行期持久数据**（如联盟集结当日计数）：`storage.data.set(name, value)`，与配置 blob 分离。
- **大体量按需分片**（如全局地图实体桶）：`storage.slot.*`，一次只碰一个键、不牵连共享 blob 里其他 feat。
- **旧无前缀键迁移**：`migrateLegacyKeys` 用 `getRaw/setRaw/removeRaw` 绕过命名空间读写字面键（见 registry.md）。

## 5. 数据流与降级

```
MAIN storage.get/set → call(op, key, value[, raw])
  ├─ contextInvalidated=true ─▶ 短路：写丢弃 / 读回 undefined，不 reject（全局静默降级）
  ├─ 写 & !ns（前缀未设）─▶ drop（blobSet 内 warn 一次），不碰存储层
  ├─ 读 & !ns ─▶ reject（调用方兜底，不污染缓存）
  └─ postMessage {__ns, dir:'main->bridge', id, op, key, value}
        → bridge.js 分发 chrome.storage.local → 回执 bridge->main {id, result|error}
        → pending 命中 resolve/reject
blob 写：enqueue(blobKey, task) —— 前一笔成败都放行下一笔，串行 read-modify-write
```

**降级**：`Extension context invalidated` 错误首笔识别降级为一条 info、此后完全静默；bridge 单批异常经回执 error 字段 reject，调用方（registry）兜默认。

## 6. 坑与边界

- **NS 两边必须同值**：`constants.js` 导出 `NS='pocketcc'`，MAIN 与 bridge 各自打包内联，不同值会让 storage 代理静默失效。
- **`value===undefined` 即删**：`blobSet` 以 undefined 表示删除逻辑键，写入 undefined 与 remove 等价。
- **getAllConfig 是浅拷贝**：只含配置 blob、不含 data；深层对象仍共享引用。
- **slot 不缓存**：读回值只归调用方持有、用完可被 GC，不会长期常驻副本——大对象用它、别用 blob。
- **旧无前缀字面键已废弃**：重构前每功能各自 UID 前缀下的字面键不再读取，开发期视作默认重配一次即可。

## 7. 调试面

- `pocketcc.storage`（装配点暴露）在控制台直接读写核对；`getNamespace()` 看前缀是否已设。
- 日志：STORAGE tag；命名空间未设丢写走 warn、上下文失效走一次性 info。

## 8. 变更记录

- **2026-10-31（架构审视轮）**：首篇设计文档落位（源码行为未改，补齐全局影子总线收口后的底座文档基线）。配合 reactor 走 ESM 直取底座，`window.pocketcc.storage` 定位为纯调试面。
