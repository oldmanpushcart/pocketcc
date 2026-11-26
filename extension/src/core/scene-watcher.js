/**
 * 世界态采集驱动 + 场景门控安装器。
 *
 * 职责边界：本文件只负责「什么时候重算」与「门控怎么放行」，归类算法在 core/world/state.js，
 * 原始判据在 core/acl/world.js（worldSignals）。三层分开后，游戏改版时符号只在一处漂移。
 *
 * 采集时机（事件驱动为主、轮询兜底，翻转才广播 world.change）：
 *   1) cc 场景启动（EVENT_AFTER_SCENE_LAUNCH）——第二层 Place 的唯一即时源；
 *   2) 游戏事件 MapTypeChange（NWorldMapCoreBiz.mapType setter 只在值真变了才 emit）；
 *   3) 游戏事件 CHANGE_SCENE（SceneManager.loadSceneEnd 发出，早于/晚于 cc 事件都可能是唯一信号）；
 *   4) 游戏事件 CrossServerStateUpdate（PushResponse.PushServerState 推来的形态/阶段位变化）；
 *   5) 2s 兜底轮询——覆盖「无事件写入的形态位」（如 UserData 报文直接改 eightServerType）。
 * 事件底座不可用时自动退化为纯轮询（一次 warn，不阻断）。
 */
import { createLog } from './log.js';
import { bus, EVT } from './bus.js';
import { reactor } from './reactor.js';
import { worldSignals } from './acl/world.js';
import { worldState } from './world/state.js';
import { eventApi } from './event.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SCENE） */
const log = createLog('SCENE');

/** 兜底轮询间隔（毫秒）：事件是主路，轮询只补形态位漂移，2s 足够且不抢主线程 */
const POLL_MS = 2000;

/** @type {string|null} 当前 cc 场景名；引擎尚未就绪时为 null。boot.js 就绪闸门与 hotkeys.js 的场景口径直接读它 */
let current = null;
/** @type {boolean} 监听与门控是否已挂（幂等标志） */
let started = false;

/**
 * 重算一次世界态（采集入口；world-state 内部只在四维翻转时才广播与打日志）
 */
function refresh() {
  worldState.refresh();
}

/**
 * cc 场景启动回调：先更新场景名并广播 scene.change（boot.js 就绪闸门消费；reactor 门控已改吃 world-state 快照），
 * 再重算世界态（place 随场景翻转而翻转，触发 world.change → reactor recomputeAll）
 */
function onLaunch() {
  const name = worldSignals.sceneName() || '';
  if (name !== current) {
    current = name || null;
    log.info('scene: %s', name);
    bus.emit(EVT.SCENE_CHANGE, { name: current });
  }
  refresh();
}

/**
 * 挂世界态事件订阅。pocketcc.event 底座早期可能还没装好（EventCenter 在模块加载期即建，
 * 实际失败概率极低），失败即退化为纯轮询并记一次 warn。
 */
function subscribeGameEvents() {
  const event = eventApi;
  if (!event || !event.install()) {
    log.warn('event base unavailable, world state falls back to %dms polling', POLL_MS);
    return;
  }
  const ev = worldSignals.events;
  event.on(ev.mapTypeChange, refresh);
  event.on(ev.changeScene, onLaunch);
  event.on(ev.crossServerStateUpdate, refresh);
}

/**
 * 注册 world 门控（唯一场景闸门）：Kind（哪一种场景，支持组名如 'kvk'/'cross'）× Place（哪张地图）。
 * 旧 scene 门控（spec.scenes 白名单）已于 P3 第 4 刀退役——各 feat 的 scenes 声明等价迁移到 places
 *   （Home→base、NWorldMap→world，由 game-api.sceneSemantic 折算，与旧口径逐字等价）。
 * 秘境（kind===pab）是独立世界体系：沿用原 core/pab-watcher.js 的默认全拦语义，秘境图内只放行
 *   显式声明 kinds 含 'pab' 的 feat（异能秘境本体），其余一律 pause。判据本体（matchesKind/matchesPlace）
 *   仍保持纯判据，本层的 pab 隔离是门控策略、不下沉 world-state（热键层不经此闸门、不需要这道拦）。
 */
function installGates() {
  reactor.registerGate({ id: 'world', ok: worldAllows });
}

/**
 * world 门控纯判据：Kind × Place，并对秘境态做隔离收口。
 * reactor 门控与面板可用性（core/ui/availability.js）共用本函数，避免「门控拦了但面板不灰」两套口径。
 * @param {object} spec 功能注册说明书
 * @returns {boolean} 是否放行
 */
export function worldAllows(spec) {
  const st = worldState.current();
  if (st.kind === worldState.KIND.pab) {
    // 秘境隔离：仅显式把 'pab' 写进 kinds 且 places 也放行的 feat 才过（不放行组名间接含 pab 的 'cross'）
    return (
      Array.isArray(spec.kinds) &&
      spec.kinds.indexOf(worldState.KIND.pab) !== -1 &&
      worldState.matchesPlace(spec.places, st.place)
    );
  }
  return (
    worldState.matchesKind(spec.kinds, st.kind) && worldState.matchesPlace(spec.places, st.place)
  );
}

/**
 * 挂场景/世界态监听 + 注册 world 门控 + 补采一次当前态。
 * 幂等：重复调用只生效一次。cc.Director.EVENT_AFTER_SCENE_LAUNCH 的可用性已由 boot.js
 * deferInit 真机验证；worldSignals 的判据全部主包符号（无子包懒加载竞态）。
 */
export function startSceneWatcher() {
  if (started) return;
  started = true;
  cc.director.on(cc.Director.EVENT_AFTER_SCENE_LAUNCH, onLaunch);
  subscribeGameEvents();
  installGates();
  setInterval(refresh, POLL_MS);
  onLaunch();
}

/**
 * 当前场景名（旧接口，保留给 boot.js 的就绪闸门）
 * @returns {string|null} 未就绪为 null
 */
export function getCurrentScene() {
  return current;
}
