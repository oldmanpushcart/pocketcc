import { createLog } from './log.js';

// 全局唯一事件总线（不建第二个游戏消息总线——net 仍是游戏报文的唯一出入口，bus 只承载内部事件）。
// 事件类：net.<cmd>（游戏推送）、net.resp.<cmd>（应答）、net.req.<cmd>（本端发包，见 net.onReq）——均由 cmd 动态拼接；
//   其余固定名（ui.refresh / mode.change / world.change / scene.change / player.* / session.*）统一取本模块导出的 EVT。
// emit 恒同步：net 事件的 raw 是池化复用对象，延迟派发会读到脏数据；
//   需要延迟的只有 reactor 合成的 tick 载荷 {}，那由 scheduler 负责，不进 bus。
/** @type {ReturnType<createLog>} 模块日志器（tag=BUS） */
const log = createLog('BUS');

/**
 * 固定事件名字典（跨模块契约：一个名字往往只有一处监听、却有多处发射，散成字面量后拼错就是静默失效）。
 *   发射/订阅一律从这里取名字，改名只需动一处；新增固定事件请顺手补进本表。
 *   不收录 `net.<cmd>` / `net.req.<cmd>` / `net.resp.<cmd>` 家族——它们由 cmd 动态拼接，不是固定字面量。
 * @type {Readonly<object>}
 */
export const EVT = Object.freeze({
  /** 功能侧推面板重算只读文本字段（唯一监听方 core/ui/index.js） */
  UI_REFRESH: 'ui.refresh',
  /** 战斗/日常模式切换（core/mode.js 发，reactor 重算门控 + UI 换图标/同步复选框） */
  MODE_CHANGE: 'mode.change',
  /** 世界态快照翻转（Kind/Place/Phase/gen/crossMap 任一，core/world/state.js 发） */
  WORLD_CHANGE: 'world.change',
  /** 游戏场景名变化（core/scene-watcher.js 发，boot 就绪放行 + 启动看门狗订阅） */
  SCENE_CHANGE: 'scene.change',
  /** UID 首次就绪（core/player.js 发，等待 UID 的调用方据此收尾） */
  PLAYER_READY: 'player.ready',
  /** 降级补载后 configs 已按真实 UID 重读（core/registry.js 发，UI 据此回写控件） */
  PLAYER_CONFIGS_RELOADED: 'player.configs-reloaded',
  /** 会话转为健康（core/session.js 发） */
  SESSION_HEALTHY: 'session.healthy',
  /** 会话转为不健康（core/session.js 发，自动重连链路） */
  SESSION_UNHEALTHY: 'session.unhealthy',
  /** 面板「归还技能组2」按钮（core/ui/field-types/farmrules.js 发，auto-farm feat 常驻监听执行快照还原） */
  FARM_SKILL_RESTORE: 'farm.skill-restore',
});

/** @type {Map<string, Set<Function>>} type -> Set<handler> */
const map = new Map();

/**
 * 订阅事件
 * @param {string} type 事件名
 * @param {Function} handler 回调（同 type 同引用只登记一次，Set 天然去重）
 * @returns {Function} unsubscribe；入参非法时为空操作函数
 */
function on(type, handler) {
  if (typeof type !== 'string' || typeof handler !== 'function') return () => {};
  let set = map.get(type);
  if (!set) map.set(type, (set = new Set()));
  set.add(handler);
  return () => off(type, handler);
}

/**
 * 退订事件
 * @param {string} type 事件名
 * @param {Function} [handler] 省略则删除该 type 下的全部订阅
 */
function off(type, handler) {
  const set = map.get(type);
  if (!set) return;
  if (handler === undefined) {
    map.delete(type);
    return;
  }
  set.delete(handler);
  if (!set.size) map.delete(type);
}

/**
 * 同步派发事件（快照迭代，handler 内部 on/off 不影响本轮），单个 handler 抛错只记 warn 不中断其余
 * @param {string} type 事件名
 * @param {*} payload 载荷
 */
function emit(type, payload) {
  const set = map.get(type);
  if (!set || !set.size) return;
  // 快照迭代：handler 内部 on/off（如 pause 时退订）不影响本轮派发
  for (const h of [...set]) {
    try {
      h(payload);
    } catch (err) {
      log.warn('handler for %s threw', type, err);
    }
  }
}

/**
 * 该 type 是否有订阅（net 据此懒构造 Event，无人订阅就不解析载荷）
 * @param {string} type 事件名
 * @returns {boolean}
 */
function has(type) {
  const set = map.get(type);
  return !!(set && set.size);
}

/** 全局唯一内部事件总线，挂到 window.pocketcc.bus */
export const bus = { on, off, emit, has };
