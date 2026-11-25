/**
 * 场地闸门（纯判据）：无双模式择表 + 战场抢修车间开窗/关闸倒计时。
 *
 * 源码锚点：
 *   - 无双四模式择表 = AVAHospitalComponent.StartAllQueue 的顺序判定（AVA → TM → Master → Legend）；
 *   - 抢修车间开窗 = WareHouseControllerNew.isBattleFieldHospitalValid：
 *     `FunctionOn(cross_server_battle_hospital) && (model.HospitalEndTime - ServerTime > 0 ||
 *      CQ25 stormData.HospitalEndTime - ServerTime > 0)`。
 * 符号读取（CrossUtils/WareHouseController/CQ25）留在 index.js，本模块只做给定值的判定，
 *   便于单测与对拍。
 */

/**
 * 无双模式择表：AVA → TM → Master → Legend；皆非返回 null（不在无双战场）。
 * @param {{isNewCAB:boolean, isTM:boolean, isMaster:boolean, isLegend:boolean}} flags CrossUtils 四判据
 * @returns {'ava'|'tm'|'master'|'legend'|null}
 */
export function pickAvaMode(flags) {
  if (!flags) return null;
  if (flags.isNewCAB) return 'ava';
  if (flags.isTM) return 'tm';
  if (flags.isMaster) return 'master';
  if (flags.isLegend) return 'legend';
  return null;
}

/**
 * 抢修车间关闸倒计时（秒，两个战场模型取较大窗口）。
 * @param {number} endTime 战场 HospitalEndTime（epoch 秒；both 模型取 max 后传入）
 * @param {number} serverTime DATA.ServerTime（秒）
 * @returns {number} 剩余秒；不可判定返回 -1（区别于「已关闸」的 0）
 */
export function csbDeadlineSec(endTime, serverTime) {
  const et = Number(endTime);
  const st = Number(serverTime);
  if (!(et > 0) || !(st > 0)) return -1;
  return Math.max(0, et - st);
}

/**
 * 抢修车间是否开窗：功能开关关 → false；窗口可判定 → 未到期即开；窗口不可判定 → 视为开
 * （判据缺失时宁多读一笔 1426 不漏修，与旧版 battleFieldHospitalOpen 回退一致）。
 * @param {boolean|null} fnOn FunctionOn(cross_server_battle_hospital)；null/undefined=判据缺失
 * @param {number} endTime 战场 HospitalEndTime（epoch 秒）
 * @param {number} serverTime DATA.ServerTime（秒）
 * @returns {boolean}
 */
export function csbOpen(fnOn, endTime, serverTime) {
  if (fnOn === false) return false;
  const left = csbDeadlineSec(endTime, serverTime);
  return left !== 0;
}

/**
 * 关闸前优先档：剩余秒进入阈值内即置顶加速（避免未修完随关闸损毁）。
 * @param {number} deadlineSec csbDeadlineSec 产物（-1=不可判定）
 * @param {number} thresholdSec 阈值（秒；≤0 表示不启用）
 * @returns {boolean}
 */
export function csbClosingSoon(deadlineSec, thresholdSec) {
  const th = Number(thresholdSec);
  if (!(th > 0)) return false;
  return deadlineSec >= 0 && deadlineSec <= th;
}
