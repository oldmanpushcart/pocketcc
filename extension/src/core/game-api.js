/**
 * 游戏符号防腐层（ACL）组装薄壳：本文件不再持有区段实现——各能力域住在 core/acl/ 切片里
 * （l10n/bits/session/mail/scene/ui/world/battle-preset/avatar/nav/march/game-data），
 * 本文件只做三件事：① import 切片并 re-export（保 69 处消费方 `import … from 'core/game-api.js'`
 * 路径不破）；② 维护调试面 debug（window.pocketcc.gameApi 控制台口径）；③ 经 registerSharedValue
 * 把共享对象挂引擎插槽供下沉 feat 的 api.js 运行期现取。引擎核（SYM 共享表、probe 惰性探测、
 * ns/LOCAL/TABLE 取用机器、CAPS/checkCap）在 core/acl-engine.js（解耦试点），活动专属适配器
 * 下沉各 feat 的 api.js，经 createAcl(tag) 共用同一份引擎单例——符号名知识仍集中
 * （引擎 SYM=共享域 + 各 api.js 本地 SYM=专属域），漂移修复单点化。
 *
 * 本文件不再持有活动适配器：secretRealm/csHunt 住在各 feat 的 api.js，消费方直接 import 同目录 api.js。
 *
 * 耦合分层立场（解耦重构的依据）：
 *   - 线路格式知识（llm 字段、ChatShareLinkType、消息模板规则）→ feats/system/chat/classify.js
 *     纯函数层。属服务器↔客户端契约，变化极少，带源码锚点，不算病态耦合；
 *   - 运行时符号知识（core/acl/ 切片，本文件组装）→ 游戏 bundle 实现细节，随版本漂移。收敛于此，
 *     惰性探测 + 缓存 + 失败一次性 warn，使漂移可观测、修复单点化。
 *
 * 合规：全部能力为只读查询或调用游戏原生导航/UI 动作，不改写游戏数据（只读+发包红线）。
 */
import { game } from './game.js';
import { SYM, probe, ns, CAPS, checkCap, registerSharedValue, sharedValue } from './acl-engine.js';
import { l10n } from './acl/l10n.js';
import { bits } from './acl/bits.js';
import { session } from './acl/session.js';
import { mail } from './acl/mail.js';
import { scene } from './acl/scene.js';
import { ui } from './acl/ui.js';
import { worldMap, worldSignals } from './acl/world.js';
import { battlePreset } from './acl/battle-preset.js';
import { avatar } from './acl/avatar.js';
import { nav } from './acl/nav.js';
import { march } from './acl/march.js';
import { gameData, gameConf } from './acl/game-data.js';

// 引擎 re-export：reactor.js 等既有消费方仍从本文件取 checkCap 与各能力对象，import 路径不破；
// 区段实现已按域拆至 core/acl/（片1–片7，各区段去向见下方注记）。
export { checkCap };
export { l10n };
export { bits };
export { session };
export { mail };
export { scene };
export { ui };
export { worldMap };
export { worldSignals };
export { battlePreset };
export { avatar };
export { nav };
export { march };
export { gameData };
export { gameConf };

// ─────────────────────── 能力校验表（CAPS/checkCap）已迁至 core/acl-engine.js ───────────────────────
// 活动键经 registerCaps 由各 feat api.js 自带自注册；navFly 经 setSharedCapsProbe 由 core/acl/nav.js 回填。

// 原 primitives 区段（LOCAL/ns/TABLE/tableNameEnum/userData/proce/uiMgrClass/uiRegistry）已迁至 core/acl-engine.js（见文件头 import）。

// ─────────────────────── 本地化 / 配置表 → core/acl/l10n.js（片1，见文件头 import 与上方 re-export） ───────────────────────

// ─────────────────────── 邮件 / 场景切换 / 原生 UI 面板 → core/acl/{mail,scene,ui}.js（片3，见文件头 import 与 re-export） ───────────────────────

// ─────────────────────── 世界地图导航 / 行军类型（跨服漂移） → core/acl/{nav,march}.js（片5/片6，见文件头 import 与 re-export） ───────────────────────

// ─────────────────────── 玩家/游戏数据（只读）+ 配置数据表 → core/acl/game-data.js（片7，见文件头 import 与 re-export） ───────────────────────

// ─────────────────────── bits（Int64）/ session（登出）→ core/acl/{bits,session}.js（片2）；世界地图/世界态 → core/acl/world.js（片4，含 battle-preset/avatar） ───────────────────────

/**
 * 调试面（仅供控制台，不入业务路径）：与 core 工具同挂 window.pocketcc（见 content.entry.js），
 * 逆向时 `pocketcc.gameApi.march.flags()` 看战场判定器是否解析成功、
 * `pocketcc.gameApi.march.resolve(13)` 看基础 marchType 在当前战场漂成哪个值（无需等到活动图里复现）。
 */
export const debug = {
  SYM,
  CAPS,
  checkCap,
  probe,
  ns,
  game,
  l10n,
  nav,
  march,
  gameData,
  gameConf,
  bits,
  session,
  mail,
  avatar,
  worldMap,
  worldSignals,
  battlePreset,
  scene,
  ui,
  /** 秘境适配器已下沉 feat：经引擎插槽现取（feat 未加载时 null，控制台口径与拆分前一致） */
  get secretRealm() {
    return sharedValue('secretRealm');
  },
  /** 夺宝奇兵适配器已下沉 feat：同上，经引擎插槽现取 */
  get csHunt() {
    return sharedValue('csHunt');
  },
};

// ─────────────────────── 活动 api 下沉后的接入桥（解耦试点） ───────────────────────

// 共享能力对象经引擎插槽注册：下沉到 feats 的活动 api.js 只 import acl-engine，不反向 import 本文件，
// 避免 core⇄feats 依赖；调用时机均在模块求值完毕之后，插槽取到的是实时对象引用。
registerSharedValue('l10n', () => l10n);
registerSharedValue('gameData', () => gameData);
registerSharedValue('gameConf', () => gameConf);
registerSharedValue('bits', () => bits);
