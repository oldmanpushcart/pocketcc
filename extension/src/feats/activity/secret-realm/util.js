/**
 * secret-realm 簇内共享纯函数叶子（零 import）：网格键 tileKey、欧氏距离 dist。
 *
 * 本簇共用一把尺子：dist 为欧氏格距，任一坐标转不出有限数回 Infinity（「不可达」哨兵）；
 * tileKey 默认不校验正负，需要「≤0 视为无效」的调用方（pilot 的出口/集结点判据）传 requirePositive。
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
 * 两点欧氏距离；任一坐标转不出有限数回 Infinity（作「不可达」哨兵）。
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
