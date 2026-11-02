// 战斗模式总开关（全局，面板驱动）。战斗模式不是 cc 场景切换，而是一个面板态：
//   combat=true 时，声明了 offInCombat 的功能（派行军/抢队列类）被 mode 门控暂停，
//   纯发包类（联盟帮助）与不经 reactor 的自动重连不受影响。
// 不持久化，默认日常。setCombatMode 翻态即广播 mode.change，reactor 据此重算门控、ui 据此换图标。
import { createLog } from './log.js';
import { bus, EVT } from './bus.js';
import { reactor } from './reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MODE） */
const log = createLog('MODE');

/** @type {boolean} 当前是否战斗态（不持久化，默认日常） */
let combat = false;
/** @type {boolean} mode 门控是否已注册（幂等标志） */
let installed = false;

/**
 * 当前是否战斗态
 * @returns {boolean}
 */
export function isCombat() {
  return combat;
}

/**
 * 切换战斗模式。同态调用幂等（不重复广播）。
 * @param {boolean} on true=战斗态，false=日常态
 */
export function setCombatMode(on) {
  on = !!on;
  if (on === combat) return;
  combat = on;
  log.info('mode: %s', combat ? 'combat' : 'daily');
  bus.emit(EVT.MODE_CHANGE, { combat: combat });
}

/**
 * 注册 mode 门控。幂等。门控读闭包内的 combat 与 spec.offInCombat：
 *   战斗态且功能声明 offInCombat → 不放行（暂停）；否则放行。
 */
export function installModeGate() {
  if (installed) return;
  installed = true;
  reactor.registerGate({
    id: 'mode',
    /**
     * mode 门控判定
     * @param {object} spec 功能注册说明书
     * @returns {boolean} 是否放行
     */
    ok: function (spec) {
      return !(combat && spec.offInCombat);
    },
  });
}
