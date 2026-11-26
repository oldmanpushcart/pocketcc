// 面板可用性判据：某个 feat 此刻是否「根本跑不起来」，供卡片置灰（纯视觉提示，不禁用控件）。
// 判据分三层，依次求值（命中即返回）：
//   1) spec.available()：feat 自有的活动/开放闸（如「活动未开启」），闸的真相处在 feat 一侧；
//   2) world 门控：复用 scene-watcher.worldAllows（Kind/Place + 秘境隔离），与 reactor 停止口径同源；
//   3) mode 门控：战斗模式下声明 offInCombat 的 feat 被暂停。
// 只影响面板观感，不改 reactor 启停；用户仍可提前启用/配置，活动开启后自动生效。
// 判据抛错一律按**可用**放行（同 refreshTabGates 的降级口径）。
import { worldAllows } from '../scene-watcher.js';
import { isCombat } from '../mode.js';

/**
 * @typedef {object} Availability
 * @property {boolean} off 是否不可用（true=置灰；仍可启用与改参数，只是此刻跑不起来）
 * @property {string} reason 不可用原因（中文，供悬停 title）
 */

/** @type {Availability} 可用态常量 */
const OK = { off: false, reason: '' };

/**
 * spec.available 的返回归一：boolean 或 {ok, reason} 都收。
 * @param {*} r available() 的返回值
 * @returns {Availability|null} null=未给出否定结论（继续看框架门控）
 */
function readAvailable(r) {
  if (r === false) return { off: true, reason: '当前条件未满足' };
  if (r && typeof r === 'object' && r.ok === false) {
    return { off: true, reason: String(r.reason || '当前条件未满足') };
  }
  return null;
}

/**
 * 求一个 feat 的当前可用性。
 * @param {object} spec reactor 注册说明书（含可选 available/kinds/places/offInCombat）
 * @returns {Availability}
 */
export function availabilityOf(spec) {
  if (!spec) return OK;
  if (typeof spec.available === 'function') {
    let r;
    try {
      r = spec.available();
    } catch (e) {
      r = true; // 判据异常：宁可多给一次可点，也不因面板判据炸掉入口
    }
    const byFeat = readAvailable(r);
    if (byFeat) return byFeat;
  }
  if (!worldAllows(spec)) return { off: true, reason: '当前场景/地图不适用' };
  if (isCombat() && spec.offInCombat) return { off: true, reason: '战斗模式下已停用' };
  return OK;
}
