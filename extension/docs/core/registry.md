# registry.js — 特征存储与运行时编排（descriptor 聚合 + 配置版本化）

> 源码：[`src/core/registry.js`](../../src/core/registry.js)　·　日志 tag：`[POCKETCC://REGISTRY]`

## 1. 职责与边界

**一句话**：把各 feat 经 `reactor.register` 声明的 descriptor 聚合为「读盘→合并→版本迁移→推配置→点火」的统一编排层，是配置生命周期的真相汇集点。

**管什么**：

- **descriptor 聚合**：功能 descriptor 单一真相在各 feat 的 `reactor.register`（经 `reactor.list()` 收集）；不经 reactor 的 internal 特例（reconnect/keepAlive/netLog/eventLog）留在 `INTERNAL_FEATURES`。
- **配置读盘合并**：`loadAllConfigs()` 逐功能读盘、按默认值合并、执行版本迁移，填充 `configs[id]`（identity 稳定，session hook/面板实时读它）。
- **配置版本化（本轮新增）**：`version` 落盘写 `_v`；`saved._v < version` 且有 `migrate` 钩子时逐版迁移；`strictConfig` 读盘剔除未声明的历史残留键。
- **落盘视图**：`persistable(f,c)` 决定写什么——detail-hidden 功能只存开关态，其余全量存并补写 `_v`。
- **启动编排**：`startFeatures()` 装底座后遍历 `applyFeature` 点火（只推启用）；`applyFeature` 是唯一 dispatch 路径（启动/降级补载/面板热更都经它：internal 走 apply 回调，其余推 `reactor.setConfig`）。

**不管什么**（铁律）：

- **不做 in-place 切号重载**：换号（UID 变化）由 player.js 触发整页 reload 重建；`reloadForPlayer` 仅服务「登录卡死降级自愈」。
- **不解读字段业务含义**：`setConfig` 只透传 `{enabled, ...}`；字段语义归各 feat 的 `toModuleCfg`。
- **不渲染面板**：面板层级由 `core/menu.js` 声明，descriptor 只管字段/存储/默认值。

## 2. 设计思路与取舍

- **单一真相在 feat、编排在 registry**：新增 feat 只需 `reactor.register` + 挂菜单 + entry import，无需改 registry 本体——descriptor 经 `reactor.list()` 自动纳入读盘/落盘/推配置流程。
- **configs identity 稳定**：`configs[id]` 对象原地覆写（`for k delete` 后 `Object.assign`），键集变化时不换引用，保证 session hook / 面板实时读的引用不失效。
- **配置版本化保守启用（本轮）**：`version/migrate/strictConfig` 三者均可缺省且不改变既有行为——`version+migrate` 始终可用（不 opt-in 即无迁移发生），pruning 通过 `strictConfig` 显式 opt-in。这样 39 个既有 feat 零行为变化，新需求按功能增量启用，避免一次性改配置语义破坏存量。
- **降级补载而非直接失败**：启动时 UID 未到位（waitUid 超时）则以默认配置先跑（`loadedDegraded=true`），`player.ready` 后补读盘并全量重推，`emit('player.configs-reloaded')` 通知 UI 回写控件。

## 3. API 契约

```js
import { configs, loadAllConfigs, saveFeature, saveGroup, startFeatures, applyFeature, features, findFeature } from '../../core/registry.js';

features();                 // reactor.list() + INTERNAL_FEATURES + GROUPS 的合集
findFeature(id);            // 按 id 查 descriptor
configs;                    // id -> 合并后运行时配置对象（identity 稳定，实时读）
await loadAllConfigs({preLogin});  // 读盘→合并→版本迁移，填充 configs；UID 未设走降级默认
saveFeature(f);             // 落盘单功能（经 persistable 视图，非 hidden 补写 _v）
saveGroup(id);              // 落盘菜单组闸门配置
startFeatures();            // 底座 install 后遍历 applyFeature 点火（reactor 只推启用；internal 走 apply 回调）
applyFeature(f);            // 唯一 dispatch：internal 走 apply 回调，其余无条件推 reactor.setConfig（enabled:false 也推，面板关开关靠它 pause）
await migrateLegacyKeys(uid); // 首个 UID 时旧无前缀全局键一次性迁入命名空间
```

**descriptor 可选字段（配置演化契约）**：`version`（当前配置版本号）、`migrate(cfg, fromVersion) => cfg`（纯函数，落后时逐版迁移）、`strictConfig`（true 时读盘剔除未声明历史键）。

## 4. 场景用法

- **feat 加字段**：在 `defaults` 加新键即可——非 strictConfig 功能读盘 `Object.assign(defaults, saved)`，新键取默认、旧键保留，无需 migrate。
- **feat 改名/删字段**：置 `strictConfig:true` 让读盘剔除残留废弃键，避免旧值原样透传 `toModuleCfg`；如需数据搬迁则加 `version` + `migrate(cfg, fromV)`。
- **详细参数不落盘的功能**：`isDetailHiddenFeature(f)` 为真时 `persistable` 只写 `{enabled, _v, intentEnabled?}`，读盘详细参数一律回默认。

## 5. 数据流与降级

```
loadAllConfigs()
  ├─ !hasNamespace()（UID 未到位）──▶ loadedDegraded=true; configs 全回落 defaults; return
  └─ 逐 feature：storage.get(storageKey) → saved
        ├─ detail-hidden ─▶ defaults + saved.{enabled,intentEnabled}
        └─ 普通：
             savedV = saved._v ?? 0
             strictConfig ? (defaults 键 + known 键覆盖，剔除未知) : (assign(defaults,saved); delete _v)
             version && savedV<version && migrate ? c = migrate(c, savedV)  ← try/catch，失败仅 warn
  → backfillIntents()（旧存档补 intentEnabled=!!enabled）→ loadedDegraded=false
startFeatures() → 底座 install → 遍历 applyFeature（reactor 只推启用；internal 走 apply 回调）
reloadForPlayer() → loadAllConfigs → 遍历 applyFeature 全量重推（含未启用，纠偏先跑时偏错的启用态）
```

**降级**：读盘单键 `storage.get` 抛错回落 `saved=null`（用默认）；`migrate` 抛错被 try/catch 兜住、保留合并结果并 `log.warn`，绝不因单功能迁移失败中断整体加载。

## 6. 坑与边界

- **`_v` 不入内存 config**：非 strictConfig 读盘后 `delete c._v`，落盘时由 `persistable` 统一补写；内存 config 永远看不到版本元键。
- **migrate 是纯函数**：`(cfg, fromVersion) => cfg`，返回新对象会整体替换 `c`；不声明 `version` 或 `savedV >= version` 时不触发。
- **strictConfig 的 known 键集**：`knownConfigKeys(f)` = defaults 键 ∪ `fields[].key` ∪ `{enabled,intentEnabled}`；面板未声明但代码读的键须留在 defaults，否则会被剔除。
- **换号不在本模块**：in-place 切换的 `player.switched` 监听已移除，改整页 reload；`reloadForPlayer` 只服务降级补载。
- **旧无前缀全局键不再读**：重构前每功能各自 UID 前缀下的字面键不再读取，开发期视作默认重配一次即可；迁移仍走 storage raw 通道。

## 7. 调试面

- `pocketcc.storage` + 控制台读 `configs`（经装配点暴露）核对合并结果；`findFeature(id)` 查 descriptor。
- 日志：REGISTRY tag；降级读默认走 info（登录页）/warn（游戏内等不到），migrate 失败 warn。

## 8. 变更记录

- **2026-11-14（P4 dispatch 收一份，架构审查候选 3）**：三份 internal-vs-reactor 分叉（applyFeature / startFeatures / reloadForPlayer 内联复制 setConfig）收进 `applyFeature` 单一路径——start/reload 只遍历调用，internal 是 descriptor 的一种（有 apply 调之、无 apply 内联 no-op）而非各调用方的分叉条件。保留两处语义差异：启动只推启用（策略过滤上移 startFeatures）、补载全量重推含未启用以纠偏。零行为变化；编排契约单测 tests/core/registry.test.js（5 例：启动顺序与策略/热更单 feat/internal apply/降级补载纠偏/toModuleCfg 缺声明降级，假 storage bridge 驱动读盘）。

- **2026-10-31（架构审视轮）**：新增配置字段演化契约 `version/migrate/strictConfig` + `knownConfigKeys` 辅助；`loadAllConfigs` 非 hidden 分支改为版本感知读盘（`_v` 落后触发 migrate、strictConfig 剔除残留键），`persistable` 落盘补写 `_v`。采用保守策略：三字段均缺省不改变既有 39 feat 行为，pruning 显式 opt-in。头部注释补契约说明。
