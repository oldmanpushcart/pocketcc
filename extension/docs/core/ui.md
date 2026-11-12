# core/acl/ui.js — 原生 UI 面板开关 / 回退

> 模块路径：`src/core/acl/ui.js`（从 `core/game-api.js` 的 ui 区段按域迁出）。
> 消费方：`feats/system/hotkey/close-popup.js`（Esc）、`feats/system/hotkey/open-bag.js`（B）、`feats/activity/secret-realm/capture.js`（代答后收窗）。

## 1. 职责与边界

- **管什么**：只触发游戏**原生**的开窗 / 关窗 / 回退动作——打开某语义面板、关闭指定面板、关闭当前栈顶弹窗或逐层回退。
- **不管什么**：不改写游戏数据（只读 + 调用红线）；不渲染自有面板（那是 `core/ui/`）；不做 feat 业务编排。
- **对外契约**：全部返回 `{ ok, err?, name? }` 形状。`err` 三态固定：
  - `unavailable` — 游戏符号漂移 / 缺方法，能力不可用；
  - `not_open` / `nothing` — 目标面板不在场（`not_open` 用于 `close`，`nothing` 用于 `closeTop`）；
  - `failed` — 游戏侧调用抛错。

## 2. 设计思路与取舍

核心问题是 **Esc「关闭/回退」到底调哪个 API**。真机探针（邮件三层场景）逐条证伪了看似合理的方案，最终锁定「组件 `close()`」。

- **✅ 采用：`CurrentUIDataInfo` → `CloseUI(descriptor)` 为主，组件 `close()` 为回退兜底**
  - 普通弹窗（如活动子页）：`CurrentUIDataInfo` 指向栈顶，`CloseUI` 直接关掉，等价面板 X。
  - 复合容器面板（如邮件）：`CloseUI` 只把子面板从 `DataPool` 摘除，**不触发内部视图切换**（分类视图 → 列表视图）。只有拦到 `CurrentUIDataInfo` 为 null 的兜底路径、按渲染层序取视觉栈顶、调用其脚本组件的 `close()`（+ `closeBtnClick()`），才与游戏内 `<` 回退按钮的**真实调用链**一致。

- **❌ 否决：`UIManager.LastCloseUI`**
  - 传字符串是空操作（源码内部访问 `e.name`，需传 descriptor 对象）；即便传真 descriptor，也只 `delete LoadingPanel` + 摘 `DataPool`，同样不触发邮件的视图切换。

- **❌ 否决：合成 DOM / Touch 事件点按钮**
  - `cc.Node` 收不到 DOM `keydown`；`dispatchEvent` / `TouchEvent` / `MouseEvent` 合成事件对 Cocos 的 `_touchListener` 全部无效（上一轮会话已逐一验证）。

- **关键取证手法**：给组件的候选方法挂 `console.trace` 钩子（`Object` 包一层 wrap），让用户**手动点一次 `<`**，从调用栈读到真实链是 `close()` → `closeBtnClick()`，据此复刻。

## 3. API 契约

| 方法 | 签名 | 语义 |
|---|---|---|
| `open(semantic, ...args)` | 语义名 → `SYM.uiPanels` → `UIDataInfo[member]` | 转发给 `UIManager.OpenUI(descriptor, ...args)`；args 传分页 index / 目标道具等 |
| `openBag()` | — | `open('bag')` 便捷入口（B 键） |
| `close(semantic)` | 语义名 | **先验在场**再 `CloseUI(descriptor)`，异常回落 `Close(name)` |
| `closeTop()` | — | Esc 键：主路径 `CloseUI(CurrentUIDataInfo)`；兜底按 `siblingIndex` 取栈顶调组件 `close()` |
| `backPanel(mgr, name)`（私有） | — | 从 `DataPool[name]` 取节点，找带 `close` 的脚本组件，调 `close()`（有则再 `closeBtnClick()`） |

**`closeTop` 兜底选栈顶的判据**：同一父（PopLayer）下 `getSiblingIndex()` 越大 = 渲染越靠上 = 视觉栈顶。这是 Cocos 兄弟节点的绘制次序，比 DataPool 键序可靠。

## 4. 场景用法

- **Esc 关普通弹窗**：`closeTop()` → `CurrentUIDataInfo` 非空 → `CloseUI` 命中 → `{ok:true, name}`。
- **Esc 从邮件分类视图回列表（层 2 → 层 1）**：`CurrentUIDataInfo` 为 null（子弹窗关闭后游标清空）→ 兜底取 sibIdx 最大者（NMailListPanel）→ `backPanel` 调其组件 `close()` → 视图切回列表，`{ok:true, name:'NMailListPanel'}`。
- **Esc 关整个邮件（层 1 → 关闭）**：只剩 NMailGroupPanel 在场 → 兜底取它 → 组件 `close()` 关掉整个面板。
- **代答限时弹窗后收窗**（capture.js）：`close('pabFeedPopup')` 走 `CloseUI(descriptor)`；**必须先验在场**（见 §6）。

## 5. 数据流与降级

```
closeTop()
  ├─ uiMgrClass().Instance() 取不到 ─────────────→ {ok:false, err:'unavailable'}
  ├─ 无 CloseUI 且无 Close ──────────────────────→ {ok:false, err:'unavailable'}
  ├─ CurrentUIDataInfo.name 存在（主路径）
  │    ├─ CloseUI(cur) → 面板仍在场 → backPanel(close) → ok
  │    ├─ CloseUI(cur) → 面板已关   → ok
  │    └─ 抛错 → 回落 Close(nm) → 仍抛错 → {err:'failed'}（warn）
  └─ 兜底路径（游标为空、容器面板在场）
       └─ DataPool 取 active 且 sibIdx 最大者 → backPanel
            ├─ 命中带 close 的组件 → {ok:true, name}
            └─ 无 / 空池 → {ok:false, err:'nothing'}
```

## 6. 坑与边界

- **`CloseUI` 对不在场面板有副作用**：仍会 `EVENT.emit(CLOSEUI)` 并走 `LastCloseUI`（无条件 `delete LoadingPanel[name]`、改写 `CurrentUIDataInfo`）。因此 `close()` 必须**先验在场**再调，判据含「正在异步加载」（`LoadingPanel[name]` 为真）。
- **`CloseUI` / `LastCloseUI` 都不能触发复合面板内部视图切换**——这是本次改造的根因；只有组件 `close()` 走完整回退链。别再用 UIManager 层方法去「回退」邮件类面板。
- **组件 `close()` 需成对补 `closeBtnClick()`**：邮件 `<` 的真实链两步都跑，缺一视图不切。`backPanel` 里对 `closeBtnClick` 做了存在性判断，非邮件面板无此方法时安全跳过。
- **`_components` vs `components`**：Cocos 2.x 该节点只暴露 `_components`，探针/取组件用 `node._components || node.components`。
- **`getSiblingIndex` 判栈顶的前提**是同一父节点下的兄弟；跨父（不同 wrapper）时该值不可比。当前邮件场景两面板同挂 PopLayer，成立。

## 7. 调试面

- 日志 tag：`GAMEAPI`（`ui.close` / `ui.open` / `ui.closeTop` 的 warn），热键侧 tag `CLOSE_POPUP`。
- 真机探针（控制台直戳，只读）：
  ```js
  var mgr = __require('UIManager').default.Instance();
  mgr.CurrentUIDataInfo;                              // 主/兜底路径分流
  Object.keys(mgr.DataPool).filter(k => mgr.DataPool[k] && mgr.DataPool[k].active !== false); // 在场面板
  mgr.DataPool['NMailListPanel'].getSiblingIndex();   // 视觉层序
  ```
- **取证某面板 `<` 的真实调用链**：给组件方法挂 `console.trace` 包装，手动点一次 `<` 读栈。

## 8. 变更记录

- **2026-11**：`backPanel` 从 `UIManager.LastCloseUI(name)` 改为「取 `DataPool[name]` 的脚本组件调 `close()` + `closeBtnClick()`」；`closeTop` 兜底路径改为按 `getSiblingIndex` 取视觉栈顶。修复邮件三层场景「层 2 → 层 1 回退无响应」。根因经真机 `console.trace` 钩子取证：UIManager 层 API 只改 DataPool，不触发复合面板内部视图切换。
- **早期**：`ui` 区段从 `core/game-api.js` 按域迁出为 `core/acl/ui.js`（行为零变化）。
