/**
 * 三系坐标互转（game ↔ cell ↔ display）：照搬 NWorldMapUtils 已验证公式，纯函数、无副作用。
 *   - game：服务器 tileX/tileY（奇偶行错排，横向双倍编号），901 请求/应答、nav.flyTo 用它；
 *   - cell：紧凑网格索引（地形文件与实体表按此寻址），自建渲染与 store 用它；
 *   - display：等距像素（Cocos 坐标，y 向上为负），仅在游戏内跨服换算/命中时需要。
 * 自建全图渲染用「正交 cell 网格」布局（每格一色块），不铺等距菱形——点击命中即 cell 反算，
 * 跨服像素换算仅在跳转/与游戏对表时调游戏 NWorldMapUtils（本模块只落本服公式，够用且可离线单测）。
 * 实证回环锚点（见实录文档 §4）：game(103,33) ↔ cell(51,33)。
 */
import { TILE, SERVER } from './map-meta.js';

/**
 * game → cell（NWorldMapUtils 实证）：x 为奇数先归偶再折半，y 直接透传。
 * @param {number} x game x（服务器 tileX）
 * @param {number} y game y（服务器 tileY）
 * @returns {{cellX:number, cellY:number}}
 */
export function gameToCell(x, y) {
  return { cellX: ((x & 1) ? x - 1 : x) / 2, cellY: y };
}

/**
 * cell → game（NWorldMapUtils 实证）：x=2·cellX，cellY 为奇数则再 +1（奇行错位），y=cellY。
 * @param {number} cellX
 * @param {number} cellY
 * @returns {{x:number, y:number}}
 */
export function cellToGame(cellX, cellY) {
  return { x: 2 * cellX + ((cellY & 1) ? 1 : 0), y: cellY };
}

/**
 * cell → display（等距像素，Cocos y 向上为负）：X=cellX·TW+HALF_W(+奇行+HALF_W)，Y=-(cellY·TH/2+HALF_H)。
 * 注：横向奇行偏移取决于所在行 cellY 的奇偶（与 cellToGame 的 x 错位同源）。
 * @param {number} cellX
 * @param {number} cellY
 * @returns {{dx:number, dy:number}}
 */
export function cellToDisplay(cellX, cellY) {
  const dx = cellX * TILE.W + TILE.HALF_W + ((cellY & 1) ? TILE.HALF_W : 0);
  const dy = -(cellY * (TILE.H / 2) + TILE.HALF_H);
  return { dx, dy };
}

/**
 * display → cell（cellToDisplay 的近似反算，取格心命中；等距精确四象限修正由游戏 display2Game2 负责，
 * 本模块只为跳转兜底与单测对拍，不做像素级精修）。
 * @param {number} dx
 * @param {number} dy
 * @returns {{cellX:number, cellY:number}}
 */
export function displayToCell(dx, dy) {
  const cellY = Math.round((-dy - TILE.HALF_H) / (TILE.H / 2));
  const base = dx - TILE.HALF_W - ((cellY & 1) ? TILE.HALF_W : 0);
  const cellX = Math.round(base / TILE.W);
  return { cellX, cellY };
}

/**
 * cell → 朴素一维索引（自建 store/render 容器键，不复用游戏 12bit 位打包）。
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} [cols] 列数（默认本服 cols）
 * @returns {number}
 */
export function cellToIndex(cellX, cellY, cols) {
  return cellY * (cols || SERVER.cols) + cellX;
}

/**
 * 朴素一维索引 → cell。
 * @param {number} index
 * @param {number} [cols] 列数（默认本服 cols）
 * @returns {{cellX:number, cellY:number}}
 */
export function indexToCell(index, cols) {
  const c = cols || SERVER.cols;
  return { cellX: index % c, cellY: Math.floor(index / c) };
}

/**
 * game 坐标是否在合法范围内（越界仅用于本地裁剪块队列，不代表服务器一定拒绝）。
 * @param {number} x game x
 * @param {number} y game y
 * @returns {boolean}
 */
export function inGameBounds(x, y) {
  return x >= 0 && y >= 0 && x <= SERVER.gameXMax && y <= SERVER.gameYMax;
}

/**
 * cell 是否落在本服全图网格内。
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {boolean}
 */
export function inCellBounds(cellX, cellY, cols, rows) {
  return cellX >= 0 && cellY >= 0 && cellX < (cols || SERVER.cols) && cellY < (rows || SERVER.rows);
}
