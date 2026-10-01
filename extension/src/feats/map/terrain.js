/**
 * 离屏草地底图生成：实证本服 mapType=202 走 newTerrainV2——地形是 GPU 合成的均匀草地平面，
 * 无任何可提取的地形位图/材质（terrains/newTerrains/specTerrains 节点零组件，matKeys 空）。
 * 所以这里不“逐格取图集”、也不“按省份上色”（那是要被否掉的绿格子），而是在 1px/cell 离屏
 * canvas 上用两档接近的草绿做低频平滑噪声（landA↔landB）插值，得到有机的、无硬边的草地观感。
 * 可读性（坐标网格/边界/刻度）交给 render 层的屏幕空间矢量绘制，本模块只负责“地面”。
 *
 * 不依赖地形模型/相机走位：草地是纯程序化噪声，无 currentMapFile 也能生成，故底图恒可铺。
 * 分批防卡帧：cols×rows 逐格算噪声，用 requestAnimationFrame 每帧铺若干行；生成结果整体缓存，
 * mapType/尺寸不变不重建。
 */
import { createLog } from '../../core/log.js';
import { worldMap } from '../../core/game-api.js';
import { TERRAIN_COLORS, SERVER } from './map-meta.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=TERRAIN） */
const log = createLog('TERRAIN');

/** @type {number} 每帧推进的行数（平衡生成速度与主线程占用） */
const ROWS_PER_FRAME = 48;

/**
 * #rrggbb → [r,g,b]
 * @param {string} hex
 * @returns {[number, number, number]}
 */
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @type {{a:number[],b:number[]}} 草地两档绿 rgb（低频噪声在两者间插值） */
const PAL = {
  a: hexToRgb(TERRAIN_COLORS.landA),
  b: hexToRgb(TERRAIN_COLORS.landB),
};

/**
 * 低频平滑噪声（0..1）：多组 sin 叠加得到连贯的明暗斑块，无格点硬边——
 * 让草地看上去有机的深浅变化，而非均匀死板，也不会退化成“按 cell 的棋盘”。
 * @param {number} x cell 列
 * @param {number} y cell 行
 * @returns {number} 0..1 插值因子
 */
function mottle(x, y) {
  const v = Math.sin(x * 0.018) * 0.5 + Math.sin(y * 0.015) * 0.5
    + Math.sin((x * 0.6 + y) * 0.021) * 0.35 + Math.sin((x - y * 0.8) * 0.013) * 0.35;
  const t = (v + 1.7) / 3.4;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 底图生成器：持有离屏 canvas 与生成状态；同一 mapType 复用，避免重复铺格。
 */
export class TerrainBase {
  /**
   * @param {object|null} model 地形模型单例（保留形参兼容调用方；草地生成不依赖它）
   * @param {number} [cols]
   * @param {number} [rows]
   */
  constructor(model, cols, rows) {
    this.model = model || null;
    this.cols = (cols || (model && model.cols) || SERVER.cols) | 0;
    this.rows = (rows || (model && model.rows) || SERVER.rows) | 0;
    /** @type {HTMLCanvasElement|null} 完成的底图（1px/cell） */
    this.canvas = null;
    /** @type {boolean} 是否已生成完毕 */
    this.ready = false;
    /** @type {boolean} 是否正在生成 */
    this.generating = false;
    /** @type {number} 下一待铺行 */
    this._row = 0;
    /** @type {ImageData|null} 逐行填充的像素缓冲 */
    this._img = null;
    /** @type {number|null} rAF 句柄 */
    this._raf = null;
    /** @type {function|null} 完成回调 */
    this._done = null;
  }

  /** @returns {boolean} 草地底图恒可生成（纯程序化噪声，不依赖地形符号） */
  supported() { return true; }

  /**
   * 启动生成（异步，跨帧铺完）。已就绪则同步回调；不支持则回调 null。
   * @param {(canvas: HTMLCanvasElement|null) => void} [onDone]
   * @returns {void}
   */
  build(onDone) {
    this._done = onDone || null;
    if (this.ready) { if (onDone) onDone(this.canvas); return; }
    if (this.generating) return;
    const cv = document.createElement('canvas');
    cv.width = this.cols; cv.height = this.rows;
    this._cv = cv;
    this._ctx = cv.getContext('2d');
    this._img = this._ctx.createImageData(this.cols, this.rows);
    // alpha 恒不透明（0→255），逐行只写 rgb
    const d = this._img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    this._row = 0;
    this.generating = true;
    this._tick();
  }

  /** 逐帧铺若干行：每格用低频噪声在两档草绿间插值上色；铺完落 canvas 并回调 */
  _tick() {
    if (!this.generating) return;
    const cols = this.cols, rows = this.rows, data = this._img.data;
    const end = Math.min(rows, this._row + ROWS_PER_FRAME);
    const a = PAL.a, b = PAL.b;
    for (let y = this._row; y < end; y++) {
      for (let x = 0; x < cols; x++) {
        const t = mottle(x, y);
        const p = (y * cols + x) * 4;
        data[p] = a[0] + (b[0] - a[0]) * t;
        data[p + 1] = a[1] + (b[1] - a[1]) * t;
        data[p + 2] = a[2] + (b[2] - a[2]) * t;
      }
    }
    this._row = end;
    if (this._row >= rows) {
      this._ctx.putImageData(this._img, 0, 0);
      this.canvas = this._cv;
      this.ready = true;
      this.generating = false;
      this._img = null;
      log.info('base map built. %dx%d', cols, rows);
      if (this._done) this._done(this.canvas);
      return;
    }
    this._raf = requestAnimationFrame(() => this._tick());
  }

  /** 取消进行中的生成（清 rAF） */
  cancel() {
    this.generating = false;
    if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
  }
}

/** @type {TerrainBase|null} 单例（按 mapType 复用；mapType 变化则重建） */
let instance = null;
/** @type {number} 当前实例对应的 mapType */
let instanceMapType = 0;

/**
 * 取（或按当前 mapType 重建）底图生成器单例。
 * 尺寸一律用 SERVER（本服可扫范围 408×952），不用 worldMap.size()：
 *   202 的 size() 返回含边境带的 568 宽，而扫描/实体/网格/边框均以 408 为准，
 *   若底图按 568 生成会被压进 408 视宽→地形特征与坐标网格错位、右侧多出一条空带。
 * @returns {TerrainBase}
 */
export function getTerrainBase() {
  const mapType = worldMap.mapType() || 0;
  const model = worldMap.terrainModel();
  if (instance && instanceMapType === mapType && instance.model === model) return instance;
  if (instance) instance.cancel();
  instance = new TerrainBase(model, SERVER.cols, SERVER.rows);
  instanceMapType = mapType;
  return instance;
}
