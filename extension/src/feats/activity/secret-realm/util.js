/**
 * secret-realm 簇内共享纯函数叶子（零 import）：网格键 tileKey、欧氏距离 dist。
 *
 * 此前被逐字复制进本簇 4 个文件：dist 4 份全同；tileKey 3 份全同（warn/scout/boss），
 * pilot 多一份「任一坐标 ≤0 视为无效」的正坐标守卫——收口后用可选 requirePositive 参保语义，
 * pilot 侧以薄委托传 true，18 个调用点零改动（与 core/util.js 的 todayStr epochSec 同一手法）。
 */

/**
 * 网格坐标 → "x,y" 键（Number 归一 + Math.floor 取整）；任一转不出有限数回空串。
 * @param {number|string} x
 * @param {number|string} y
 * @param {boolean} [requirePositive] true 时任一坐标 ≤0 亦回空串（pilot 出口/集结点判据要求正坐标）
 * @returns {string}
 */
export function tileKey(x, y, requirePositive) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return '';
  if (requirePositive && (nx <= 0 || ny <= 0)) return '';
  return Math.floor(nx) + ',' + Math.floor(ny);
}

/**
 * 两点欧氏距离；任一坐标转不出有限数回 Infinity（作「不可达」哨兵，与原各份一致）。
 * @param {number|string} ax
 * @param {number|string} ay
 * @param {number|string} bx
 * @param {number|string} by
 * @returns {number}
 */
export function dist(ax, ay, bx, by) {
  const dx = Number(ax) - Number(bx);
  const dy = Number(ay) - Number(by);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
  return Math.sqrt(dx * dx + dy * dy);
}
