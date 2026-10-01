/**
 * 自建全图渲染层（单 canvas 多「逻辑层」顺序绘制，省 DOM、控开销）。
 *   底图层：terrain 离屏色块图（1px/cell），drawImage 等比缩放贴入；
 *   实体层：store 里的点，离屏缓存成一张 1px/cell 的点图，仅在数据/筛选变化时重建（主渲染只 drawImage）；
 *   雷达层：扫描动效组合——覆盖范围发光描边 + 已扫块余晖拖尾 + 整行滑过的雷达扫波（尾带+亮线）+
 *           起扫块虚线框十字标记；扫波前跨块边线才释放该块数据显示。逐帧轻绘。
 * 交互：滚轮以光标为锚缩放、指针拖拽平移；zoom=1 恒「完整展示全图」（平移锁 0），放大后可平移。
 *       点击（非拖拽）某格 → cell 反算 → cellToGame → nav.flyTo 复用原生导航（只读+发包红线，不改游戏数据）。
 *
 * 布局口径：正交 cell 网格（每 cell 一方格），非等距菱形——色块抽象图够用且点击命中零歧义；
 * 跳转所需 game 坐标由 coord.cellToGame 精确给出，与本布局是否等距无关。
 */
import { createLog } from '../../core/log.js';
import { nav } from '../../core/game-api.js';
import { cellToGame } from './coord.js';
import { SERVER, SCAN_GRID, classifyPoint, playerPass, GRID_STYLE, CELL_ASPECT } from './map-meta.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MAPRENDER） */
const log = createLog('MAPRENDER');

/** @type {number} 实体点屏幕半径（CSS px，不随缩放变化，保证始终可读且为正圆） */
const ENTITY_DOT_R = 2.6;

/** @type {number} 最大放大倍率（相对 fit-to-view） */
const MAX_ZOOM = 12;
/** @type {number} 最小（等比缩到刚好完整展示扫描网格 = 1，含图外 padding 区） */
const MIN_ZOOM = 1;

export class MapView {
  /**
   * @param {HTMLCanvasElement} canvas 目标画布
   * @param {import('./store.js').MapStore} store 实体数据源
   * @param {{cols?:number, rows?:number, onPick?:(cellX:number,cellY:number)=>void}} [opts]
   */
  constructor(canvas, store, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.cols = (opts && opts.cols) || SERVER.cols;
    this.rows = (opts && opts.rows) || SERVER.rows;
    this.onPick = (opts && opts.onPick) || null;
    /** @type {?Function} 右键命中块回调 (i,j,cellX,cellY)（选起扫块用） */
    this.onCtxPick = (opts && opts.onCtxPick) || null;
    /** @type {?Set<string>} 允许展示的细分类 key（null=不限制已分类点） */
    this.enabledSubs = null;
    /** @type {boolean} 是否展示未归入 FILTER_TREE 的 pointType（「其他」灰色兜底，修隐形 bug） */
    this.showOther = false;
    /** @type {{selfPid:number,selfAid:number,selfServer:number}} 细分类归属判定基准（Number，勿 |0 截断） */
    this._ctx = { selfPid: 0, selfAid: 0, selfServer: 0 };
    /** @type {?number} 当前视角桶（只看该区采到的点；null=不过滤，视角号取不到时的降级） */
    this.activeVk = null;
    /** @type {string} 归属筛选模式：all/self/ally/enemy/none */
    this.ownerMode = 'all';
    /** @type {number} 本人 pid（归属分类基准，Number 不 |0 截断） */
    this.selfPid = 0;
    /** @type {number} 本人联盟 aid */
    this.selfAid = 0;
    /** @type {string} 护盾过滤模式：'off'不限 / 'has'有盾 / 'none'无盾（仅玩家城池，见 map-meta.playerPass） */
    this.shieldMode = 'off';
    /** @type {?number} 护盾过滤剩余上限（ms）；仅 shieldMode='has' 下生效，null=不限 */
    this.shieldMs = null;
    /** @type {?number} 玩家等级下限（含）：非 null 时只留 e.level ≥ 此值的城池；null=不限（见 map-meta.playerPass） */
    this.levelMin = null;
    /** @type {boolean} 是否绘制坐标网格/刻度/边界（可读性关键层，默开） */
    this.showGrid = !(opts && opts.showGrid === false);
    /** @type {HTMLCanvasElement|null} 地形底图 */
    this.terrainCanvas = null;
    /** @type {HTMLCanvasElement|null} 实体点离屏缓存 */
    this.entityCanvas = null;
    /** @type {boolean} 实体层是否需重建 */
    this._entityDirty = true;
    // 视图变换
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    /** @type {{cx:number,cy:number,cw:number,ch:number,i:number,j:number}|null} 当前扫描块（cell 矩形 + 块网格下标），雷达高亮用 */
    this.curBlock = null;
    /** @type {?{i:number,j:number}} 起扫块（右键选中的块网格下标，准星标记） */
    this.startBlock = null;
    /** @type {number} 块停留时长 ms（扫波速度初始基准，由 setDwell 注入；运行中被实测 EMA 接管） */
    this._dwellMs = 2700;
    /** @type {number} 实测块间隔 EMA（ms，含网络 RTT+dwell）——扫波速度自适应真实节奏 */
    this._blockEma = 0;
    /** @type {number} 上一块到达时刻（间隔测量） */
    this._lastBlockAt = 0;
    /** @type {number} 扫波行号（块网格行 j；-1=未扫） */
    this._waveRow = -1;
    /** @type {number} 扫波推进量（行内块数连续值，恒向目标匀速追赶，不因单块网络慢而驻停） */
    this._waveFrac = 0;
    /** @type {number} 扫波目标推进量（行内已完成块数，块到达即 +1） */
    this._targetFrac = 0;
    /** @type {number} 扫波上一动画帧时刻（dt 积分用） */
    this._waveLastT = 0;
    /** @type {number} 已释放显示的整块数（波前跨块边线才标脏重建实体层：数据在波扫过后才现身） */
    this._waveShown = 0;
    /** @type {Array<{i:number,j:number,t:number}>} 近几个完成块（余晖拖尾，按时长自动过期） */
    this._trail = [];
    /** @type {{nx:number,ny:number,gw:number,gh:number,offY:number}} 扫描网格几何（定标固定格，game 单位），由 setGrid 注入 */
    this._gg = (opts && opts.grid) || SCAN_GRID;
    /** @type {number} 扫描块网格列/行数（主网格=此网格，与块对齐） */
    this.gridNx = this._gg.nx;
    this.gridNy = this._gg.ny;
    /** @type {boolean} 扫描进行中（决定是否逐帧脉动动画） */
    this.scanning = false;
    /** @type {number|null} rAF 句柄 */
    this._raf = null;
    /** @type {{x:number,y:number,moved:boolean}|null} 拖拽态 */
    this._drag = null;
    /** @type {number} CSS 像素宽/高 */
    this._w = 0; this._h = 0;
    /** @type {number} 设备像素比（resize 时记录，实体屏幕缓存用） */
    this._dpr = 1;
    /** @type {string} 上次实体缓存对应的视图签名（缩放/平移/尺寸），变化即重建 */
    this._viewSig = '';
    this._bind();
    /** 调试句柄：控制台可经 canvas.__pcmap 拿到实时 MapView（与 window.pocketcc 调试面同风格） */
    try { canvas.__pcmap = this; } catch (e) { }
  }

  // ── 视图变换（world=cell 单位 ↔ screen=CSS 像素） ──

  /** @returns {number} 有效缩放：fit-to-view 基准（x 按 cell 宽高比，y 按网格总高含向外 padding）× 用户 zoom */
  _scale() {
    const sp = this._gridSpan();
    const base = Math.min(this._w / (this.cols * CELL_ASPECT), this._h / (sp.bot - sp.top));
    return base * this.zoom;
  }

  /** 扫描网格纵向范围（cell）：定标格超出地图边界的部分析出为图外 padding，视口/裁剪/绘制均按此完整展示 */
  _gridSpan() {
    const g = this._gg;
    return { top: Math.min(0, g.offY), bot: Math.max(this.rows, g.offY + g.ny * g.gh) };
  }

  /** world(cell) → screen(CSS px)：x 乘 CELL_ASPECT 还原真实足迹比例 */
  _w2s(wx, wy) {
    const s = this._scale();
    return {
      x: this._w / 2 + (wx - this.cols / 2) * s * CELL_ASPECT + this.panX,
      y: this._h / 2 + (wy - this.rows / 2) * s + this.panY,
    };
  }

  /** screen(CSS px) → world(cell)：x 除以 (s·CELL_ASPECT) 反算 */
  _s2w(sx, sy) {
    const s = this._scale();
    return {
      x: (sx - this._w / 2 - this.panX) / (s * CELL_ASPECT) + this.cols / 2,
      y: (sy - this._h / 2 - this.panY) / s + this.rows / 2,
    };
  }

  /** 平移夹持：zoom=1 锁死居中（始终全网格）；放大后允许平移但不使网格完全离视 */
  _clampPan() {
    if (this.zoom <= MIN_ZOOM) { this.panX = 0; this.panY = 0; return; }
    const s = this._scale();
    const sp = this._gridSpan();
    const halfW = (this.cols * s * CELL_ASPECT) / 2, halfH = ((sp.bot - sp.top) * s) / 2;
    const limX = Math.max(0, halfW - this._w / 2), limY = Math.max(0, halfH - this._h / 2);
    this.panX = Math.max(-limX, Math.min(limX, this.panX));
    this.panY = Math.max(-limY, Math.min(limY, this.panY));
  }

  // ── 生命周期 ──

  /**
   * 适配画布尺寸（DPR 感知）。容器尺寸变化时由 overlay 调用。
   * @param {number} cssW
   * @param {number} cssH
   */
  resize(cssW, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this._dpr = dpr;
    this._w = cssW; this._h = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  /** 设地形底图（null=降级纯色）；标脏重绘 */
  setTerrain(cv) { this.terrainCanvas = cv || null; this.invalidate(); }

  /** 设筛选：enabledSubs=允许的细分类 key 集合（null=不限制已分类点）；showOther=是否显示未归类类型（灰色兜底） */
  setFilter(enabledSubs, showOther) { this.enabledSubs = enabledSubs || null; this.showOther = !!showOther; this._entityDirty = true; this.invalidate(); }

  /** 设细分类归属判定基准（selfAid/selfServer 变化时重传，影响本区联盟/敌对/跨区归类） */
  setClassifyCtx(ctx) {
    if (!ctx) return;
    this._ctx = { selfPid: ctx.selfPid || 0, selfAid: ctx.selfAid || 0, selfServer: ctx.selfServer || 0 };
    this._entityDirty = true; this.invalidate();
  }

  /**
   * 设当前视角桶（按区切换显示内容）：vk>0 只看该桶点；null/0=不过滤（展示全部桶）。
   * @param {?number} vk 视角所在区服号
   */
  setActiveVk(vk) {
    const n = (vk == null || !isFinite(vk)) ? null : (Number(vk) | 0);
    const next = n && n > 0 ? n : null;
    if (next === this.activeVk) return;
    this.activeVk = next;
    this._entityDirty = true; this.invalidate();
  }

  /** 设归属筛选：mode=all/self/ally/enemy/none；self={pid,aid} 本人身份（身份变化时重传） */
  setOwner(mode, self) {
    this.ownerMode = mode || 'all';
    if (self) { this.selfPid = self.pid || 0; this.selfAid = self.aid || 0; }
    this._entityDirty = true; this.invalidate();
  }

  /**
   * 设护盾过滤（仅玩家城池）：mode='has'有盾/'none'无盾/'off'不限；ms=剩余上限（仅 'has' 保留「剩余 ≤ ms」的城）。
   * 护盾随时间流逝会跨档，mode!='off' 时需业务层定时（每分钟）markEntitiesDirty 重建，否则结果僵住。
   * @param {string} mode
   * @param {?number} ms
   */
  setShieldFilter(mode, ms) {
    const m = (mode === 'has' || mode === 'none') ? mode : 'off';
    const n = (ms == null || !isFinite(ms) || ms < 0) ? null : Number(ms);
    this.shieldMode = m;
    this.shieldMs = m === 'has' ? n : null;
    this._entityDirty = true; this.invalidate();
  }

  /**
   * 设玩家等级下限（仅玩家城池）：min=null 不限；否则只保留 e.level ≥ min 的城池。
   * 与护盾同属「玩家筛选」（map-meta.playerPass）；等级不随时间变，无需定时重建。
   * @param {?number} min 等级下限（含）；null/非法=不限
   */
  setLevelFilter(min) {
    const n = (min == null || !isFinite(min) || min < 0) ? null : Math.floor(Number(min));
    this.levelMin = n;
    this._entityDirty = true; this.invalidate();
  }

  /** 标实体层脏（scanner 每块入库后调用） */
  markEntitiesDirty() { this._entityDirty = true; this.invalidate(); }

  /**
   * 设当前扫描块（cell 矩形 + 块网格下标 i/j）：扫描中同时测块间隔 EMA、推进扫波目标、推入余晖。
   * i/j 使高亮可吸附到主网格线；onBlock 每块调一次即可。
   */
  setCurrentBlock(cx, cy, cw, ch, i, j) {
    const now = Date.now();
    this.curBlock = { cx, cy, cw, ch, i, j };
    if (this.scanning && Number.isFinite(i) && Number.isFinite(j)) {
      // 实测块间隔（网络 RTT + dwell 全含）EMA → 扫波速度自适应真实节奏，块边不再驻停等待
      const dur = now - this._lastBlockAt;
      if (this._lastBlockAt && dur > 100 && dur < 10000) this._blockEma = this._blockEma ? this._blockEma * 0.75 + dur * 0.25 : dur;
      this._lastBlockAt = now;
      const nx = Math.max(1, this.gridNx | 0);
      if (j !== this._waveRow) { this._waveRow = j; this._waveFrac = 0; this._waveShown = 0; this._entityDirty = true; } // 换行：冲刷上行未释放数据；蛇形行尾与下行起点同侧，x 几乎不动
      this._targetFrac = (j & 1) ? nx - i : i + 1; // 目标=行内已完成块数（向西行自右端起计）
      this._trail.push({ i, j, t: now });
      if (this._trail.length > 5) this._trail.shift();
    }
    this.invalidate();
  }

  /** 设块停留时长（扫波速度初始基准；global-map 用 dwellMs+jitter/2 注入，运行中由实测 EMA 接管） */
  setDwell(ms) { if (ms > 0) { this._dwellMs = ms; if (!this._blockEma) this._blockEma = ms; } }

  /** 设起扫块标记（{i,j} 块网格下标；null=清） */
  setStartBlock(b) {
    this.startBlock = (b && Number.isFinite(b.i) && Number.isFinite(b.j)) ? { i: b.i | 0, j: b.j | 0 } : null;
    this.invalidate();
  }

  /** 把指定格平移到画布中心（zoom=1 全图已在视中，仅重绘） */
  recenter(cellX, cellY) {
    if (this.zoom > MIN_ZOOM) {
      const s = this._scale();
      this.panX = -((cellX + 0.5 - this.cols / 2) * s * CELL_ASPECT);
      this.panY = -((cellY + 0.5 - this.rows / 2) * s);
      this._clampPan();
    }
    this.invalidate();
  }

  /** 设扫描网格几何（定标固定格 {nx,ny,gw,gh,offY}，game 单位；主网格按此与扫描块对齐） */
  setGrid(g) {
    if (g && Number.isFinite(g.nx) && Number.isFinite(g.gw) && Number.isFinite(g.gh)) this._gg = g;
    this.gridNx = this._gg.nx;
    this.gridNy = this._gg.ny;
    this.invalidate();
  }

  /** 扫描态（true 时逐帧脉动动画） */
  setScanning(on) {
    this.scanning = !!on;
    if (!this.scanning) { // 停扫：扫波/测速复位，实体层冲刷一次（末块数据不压箱），其余晖自然播完
      this._waveRow = -1; this._waveFrac = 0; this._targetFrac = 0;
      this._lastBlockAt = 0; this._blockEma = 0; this._waveLastT = 0; this._waveShown = 0;
      this._entityDirty = true;
    }
    this.invalidate();
  }

  /** 请求一帧渲染（合并多次调用） */
  invalidate() {
    if (this._raf != null) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
  }

  /**
   * 按倍率缩放（工具栏 +/− 用，屏幕中心为锚）。
   * @param {number} factor 每档倍率（如 1.3）
   */
  zoomBy(factor) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    this._clampPan();
    this.invalidate();
  }

  /** 复位到「刚好完整展示全图」（zoom=1、平移清零） */
  fit() {
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.invalidate();
  }

  /** 切换坐标网格显隐（工具栏「网格」按钮用） @returns {boolean} 切换后状态 */
  toggleGrid() { this.showGrid = !this.showGrid; this.invalidate(); return this.showGrid; }

  /** 停止渲染循环 */
  destroy() {
    if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._unbind();
  }

  // ── 绘制 ──

  _draw() {
    const ctx = this.ctx;
    if (!ctx || !this._w) return;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.fillStyle = '#0c0f14';
    ctx.fillRect(0, 0, this._w, this._h);
    ctx.imageSmoothingEnabled = true; // 草地底/实体圆点缩放保持平滑（网格为矢量线不受影响）

    const tl = this._w2s(0, 0);
    const s = this._scale();
    const wpx = this.cols * s * CELL_ASPECT, hpx = this.rows * s;

    // 1) 草地底图层
    if (this.terrainCanvas) {
      ctx.drawImage(this.terrainCanvas, tl.x, tl.y, wpx, hpx);
    } else {
      ctx.fillStyle = '#41603a';
      ctx.fillRect(tl.x, tl.y, wpx, hpx);
    }

    // 2) 坐标网格 + 刻度 + 全图边界（矢量，屏幕空间；玩家靠此定位）
    this._drawGrid(ctx, s, tl);

    // 3) 实体层（屏幕空间正圆点，按视图签名缓存；缩放/平移/数据变化才重建）
    const sig = this._viewSigNow();
    if (this._entityDirty || sig !== this._viewSig) this._rebuildEntities();
    if (this.entityCanvas) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.entityCanvas, 0, 0);
      ctx.restore();
    }

    // 4) 雷达层
    this._drawRadar(ctx, s, tl);

    // 续帧：扫描中，或尚有余晖拖尾在播（停扫后动画自然收束，由过期修剪后停止）
    if (this.scanning || this._trail.length) this.invalidate();
  }

  /** 当前视图签名（缩放/平移/尺寸）——变化即需重建实体屏幕缓存 */
  _viewSigNow() {
    return this.zoom.toFixed(4) + '|' + this.panX.toFixed(1) + '|' + this.panY.toFixed(1) + '|' + this._w + 'x' + this._h;
  }

  /** 重建实体点：屏幕空间正圆点（固定像素半径，随视图缩放/平移重排，视口外剔除） */
  _rebuildEntities() {
    const dpr = this._dpr || 1;
    const W = Math.max(1, Math.round(this._w * dpr));
    const H = Math.max(1, Math.round(this._h * dpr));
    let cv = this.entityCanvas;
    if (!cv || cv.width !== W || cv.height !== H) {
      cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      this.entityCanvas = cv;
    }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this._w, this._h);
    const R = ENTITY_DOT_R;
    const TAU = Math.PI * 2;
    const now = Date.now();                    // 护盾跨档判据的基准时刻（本轮重建共用，避免逐点取时）
    for (const e of this.store.entities.values()) {
      if (this.activeVk != null) {           // 视角桶：旧档无 vk 时退按点自身服号，都无则 0
        const vk = e.vk != null ? e.vk : (e.k != null ? e.k : 0);
        if (vk !== this.activeVk) continue;
      }
      if (!playerPass(e, { shieldMode: this.shieldMode, shieldMs: this.shieldMs, levelMin: this.levelMin }, now)) continue; // 玩家筛选：护盾有/无+剩余上限 & 等级≥（未开启时全放）
      const sub = classifyPoint(e, this._ctx);
      let color;
      if (sub) {
        if (this.enabledSubs && !this.enabledSubs.has(sub.key)) continue;
        color = sub.color;
      } else {
        if (!this.showOther) continue;   // 未归类类型：仅在开启「其他」时显示（灰色），否则隐形
        color = '#8a93a6';
      }
      if (this.ownerMode !== 'all') {       // 归属分类：self/ally/enemy/none
        const oid = e.oid, aid = e.aid;
        const owned = oid != null && oid !== 0;
        let cls;
        if (owned && oid === this.selfPid) cls = 'self';
        else if (aid != null && this.selfAid && aid === this.selfAid) cls = 'ally';
        else if (owned) cls = 'enemy';
        else cls = 'none';
        if (cls !== this.ownerMode) continue;
      }
      const p = this._w2s(e.cellX + 0.5, e.cellY + 0.5);
      if (p.x < -R || p.y < -R || p.x > this._w + R || p.y > this._h + R) continue;
      c.fillStyle = color;
      c.beginPath();
      c.arc(p.x, p.y, R, 0, TAU);
      c.fill();
    }
    this._entityDirty = false;
    this._viewSig = this._viewSigNow();
  }

  /**
   * 屏幕空间绘网格：主网格=扫描块网格（nx×ny 均分全图，与扫描块/高亮对齐）、次网格=块内逐轴等分，末尾画全图边框。
   * 均分保证无右边/下边不均裁切格；x 按 CELL_ASPECT 拉伸保持真实足迹比例；不标坐标数字。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} s 每 cell 垂直像素
   * @param {{x:number,y:number}} tl 世界 (0,0) 的屏幕坐标
   */
  _drawGrid(ctx, s, tl) {
    if (!this.showGrid) return;
    const cols = this.cols, rows = this.rows;
    const sx = s * CELL_ASPECT, sy = s;
    const wpx = cols * sx, hpx = rows * sy;
    const g = this._gg, nx = g.nx, ny = g.ny;
    const bwpx = (g.gw / 2) * sx, bhpx = g.gh * sy; // 定标块像素（列宽 game/2 cell）
    const topY = tl.y + g.offY * sy;                // 行 0 顶边（offY<0：在地图上方，属图外 padding，照常绘制）
    const sp = this._gridSpan();
    const gy0 = tl.y + sp.top * sy, ghPx = (sp.bot - sp.top) * sy; // 网格矩形（含向外 padding）
    ctx.save();
    ctx.beginPath(); ctx.rect(tl.x, gy0, wpx, ghPx); ctx.clip(); // 裁剪到网格范围：格线完整，不再被图边切短
    // 次网格：块内逐轴等分（份数使间距≥minPx），固定格距 → 全图均匀
    const subW = Math.max(1, Math.floor(bwpx / GRID_STYLE.minPx));
    const subH = Math.max(1, Math.floor(bhpx / GRID_STYLE.minPx));
    if (subW > 1 || subH > 1) {
      ctx.strokeStyle = GRID_STYLE.minor; ctx.lineWidth = 1; ctx.beginPath();
      if (subW > 1) for (let i = 0; i < nx; i++) { for (let k = 1; k < subW; k++) { const x = Math.round(tl.x + (i + k / subW) * bwpx) + 0.5; ctx.moveTo(x, gy0); ctx.lineTo(x, gy0 + ghPx); } }
      if (subH > 1) for (let j = 0; j < ny; j++) { for (let k = 1; k < subH; k++) { const y = Math.round(topY + (j + k / subH) * bhpx) + 0.5; ctx.moveTo(tl.x, y); ctx.lineTo(tl.x + wpx, y); } }
      ctx.stroke();
    }
    // 主网格=扫描块网格（nx×ny 定标固定格，x 向 7 列恰好铺满，y 向首末行完整画到图外 padding 区）
    ctx.strokeStyle = GRID_STYLE.major; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < nx; i++) { const x = Math.round(tl.x + i * bwpx) + 0.5; ctx.moveTo(x, gy0); ctx.lineTo(x, gy0 + ghPx); }
    for (let j = 1; j < ny; j++) { const y = Math.round(topY + j * bhpx) + 0.5; ctx.moveTo(tl.x, y); ctx.lineTo(tl.x + wpx, y); }
    ctx.stroke();
    ctx.restore();
    // 全图边框
    ctx.save();
    ctx.strokeStyle = GRID_STYLE.border; ctx.lineWidth = 1.5;
    ctx.strokeRect(tl.x, tl.y, wpx, hpx);
    ctx.restore();
  }

  /** 块网格下标 i/j → 屏幕矩形（与 _drawGrid 同一套定标固定格几何；首末行可探出地图，由调用方裁剪） */
  _blockRectPx(i, j, s, tl) {
    const g = this._gg;
    const bwpx = (g.gw / 2) * s * CELL_ASPECT, bhpx = g.gh * s;
    return {
      x: tl.x + Math.max(0, Math.min(g.nx - 1, i)) * bwpx,
      y: tl.y + g.offY * s + Math.max(0, Math.min(g.ny - 1, j)) * bhpx,
      w: bwpx, h: bhpx,
    };
  }

  /** 雷达动效层：发光覆盖框 + 余晖拖尾 + 整行滑过的雷达扫波 + 起扫块十字标记 */
  _drawRadar(ctx, s, tl) {
    const AS = CELL_ASPECT;
    const cols = this.cols, rows = this.rows;
    const now = Date.now();
    // 全层裁到网格矩形（含向外 padding）：定标格首末行完整可见，块高亮/拖尾/扫波与格线同一裁剪界
    const sp = this._gridSpan();
    ctx.save();
    ctx.beginPath(); ctx.rect(tl.x, tl.y + sp.top * s, cols * s * AS, (sp.bot - sp.top) * s); ctx.clip();
    // 1) 覆盖范围（当前桶 bound）发光描边；尚无数据时默认按全图范围出边框（边框常驻可见）
    const b = this.store.bucketMeta(this.activeVk != null ? this.activeVk : 0).bound;
    const hasBound = isFinite(b.minX) && isFinite(b.maxX) && b.maxX > b.minX && b.maxY > b.minY;
    {
      const minX = hasBound ? Math.max(0, b.minX) : 0, minY = hasBound ? Math.max(0, b.minY) : 0;
      const maxX = hasBound ? Math.min(cols, b.maxX) : cols, maxY = hasBound ? Math.min(rows, b.maxY) : rows;
      if (maxX > minX && maxY > minY) {
        ctx.save();
        ctx.shadowColor = 'rgba(120,180,255,.7)'; ctx.shadowBlur = 4;
        ctx.strokeStyle = hasBound ? 'rgba(120,180,255,.4)' : 'rgba(120,180,255,.28)';
        ctx.lineWidth = 1;
        ctx.strokeRect(tl.x + minX * s * AS, tl.y + minY * s, (maxX - minX) * s * AS, (maxY - minY) * s);
        ctx.restore();
      }
    }
    // 2) 已扫块余晖拖尾（1.2s 内 alpha .12→0，过期即剪）
    while (this._trail.length && now - this._trail[0].t > 1200) this._trail.shift();
    for (const tr of this._trail) {
      const k = 1 - (now - tr.t) / 1200;
      if (k <= 0) continue;
      const r = this._blockRectPx(tr.i, tr.j, s, tl);
      ctx.fillStyle = `rgba(90,200,255,${(0.12 * k).toFixed(3)})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // 3) 雷达扫波：波前以「实测块间隔 EMA」为速度匀速追赶完成进度（偶数行→，奇数行←）。
    //    单块网络慢时波只是减速接近块边而非驻停卡死；网络快时持续前行不跳位，视觉全程丝滑。
    if (this.scanning && this._waveRow >= 0) {
      const g = this._gg;
      const nx = g.nx, ny = g.ny;
      const wpx = cols * s * AS, hpx = rows * s;
      const bhpx = g.gh * s;
      const j = Math.max(0, Math.min(ny - 1, this._waveRow));
      const ry = Math.max(tl.y + sp.top * s, tl.y + g.offY * s + j * bhpx); // 裁剪界=网格顶（含 padding）
      const rh = Math.min(bhpx, tl.y + sp.bot * s - ry);
      if (rh > 0) {
        const dt = this._waveLastT ? Math.max(0, Math.min(250, now - this._waveLastT)) : 16;
        this._waveLastT = now;
        const period = Math.max(300, this._blockEma || this._dwellMs); // 波速 = 1 块 / 实测间隔
        const lag = this._targetFrac - this._waveFrac;
        if (lag > 0) this._waveFrac = Math.min(this._targetFrac, this._waveFrac + (dt / period) * (1 + Math.max(0, lag - 1) * 1.5));
        // 波前跨块边线才释放显示：已入库但未被波扫过的块暂藏在实体缓存外（不提前穿帮）
        const shown = Math.floor(this._waveFrac);
        if (shown > this._waveShown) { this._waveShown = shown; this._entityDirty = true; }
        const east = !(j & 1); // 蛇形推进方向：偶数行→（自左而右），奇数行←
        const p = Math.max(0, Math.min(nx, east ? this._waveFrac : nx - this._waveFrac)); // 推进量折为自西向东坐标
        const wx = tl.x + (p / nx) * wpx;
        // 当前行淡底（扫波所在行轻罩一层，提示正在扫哪行）
        ctx.fillStyle = 'rgba(90,180,255,.06)';
        ctx.fillRect(tl.x, ry, wpx, rh);
        // 尾带：波后方渐变辉光（宽度约为行宽的 8%，限幅 24~90px）
        const dir = east ? 1 : -1;
        const GW = Math.min(90, Math.max(24, wpx * 0.08));
        const grad = ctx.createLinearGradient(wx - dir * GW, 0, wx, 0);
        grad.addColorStop(0, 'rgba(110,225,255,0)');
        grad.addColorStop(0.7, 'rgba(110,225,255,.14)');
        grad.addColorStop(1, 'rgba(150,240,255,.40)');
        ctx.fillStyle = grad;
        ctx.fillRect(Math.min(wx, wx - dir * GW), ry, GW, rh);
        // 波前亮线（发光）
        ctx.save();
        ctx.shadowColor = 'rgba(140,235,255,.9)'; ctx.shadowBlur = 8;
        ctx.strokeStyle = 'rgba(190,250,255,.95)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(wx, ry); ctx.lineTo(wx, ry + rh); ctx.stroke();
        ctx.restore();
      }
    } else if (this.curBlock) {
      // 非扫描态（暂停/静态展示）：保留普通整块框
      const cb = this.curBlock;
      let x, y, w, h;
      if (Number.isFinite(cb.i) && Number.isFinite(cb.j)) {
        const r = this._blockRectPx(cb.i, cb.j, s, tl);
        x = r.x; y = r.y; w = r.w; h = r.h;
      } else {
        const x0 = Math.max(0, Math.min(cols, cb.cx)), y0 = Math.max(0, Math.min(rows, cb.cy));
        const w0 = Math.min(cb.cw, cols - x0), h0 = Math.min(cb.ch, rows - y0);
        x = tl.x + x0 * s * AS; y = tl.y + y0 * s; w = w0 * s * AS; h = h0 * s;
      }
      if (w > 0 && h > 0) {
        ctx.fillStyle = 'rgba(90,180,255,.10)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(120,200,255,.55)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);
      }
    }
    // 4) 起扫块标记：虚线块框 + 中心十字（品红，与扫描青色区分；无圆圈）
    if (this.startBlock) {
      const r = this._blockRectPx(this.startBlock.i, this.startBlock.j, s, tl);
      const col = 'rgba(255,122,217,.85)';
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = col; ctx.lineWidth = 1.2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      ctx.restore();
      const cx0 = r.x + r.w / 2, cy0 = r.y + r.h / 2, CR = Math.min(14, Math.max(7, Math.min(r.w, r.h) * 0.18));
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx0 - CR * 1.7, cy0); ctx.lineTo(cx0 + CR * 1.7, cy0);
      ctx.moveTo(cx0, cy0 - CR * 1.7); ctx.lineTo(cx0, cy0 + CR * 1.7);
      ctx.stroke();
    }
    ctx.restore(); // 配对方法开头的地图矩形 clip
  }

  // ── 交互接线 ──

  _bind() {
    this._onWheel = (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const before = this._s2w(sx, sy);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
      // 以光标为锚：缩放后让 before 仍落在同一屏幕点（x 方向含 CELL_ASPECT，与 _w2s 一致）
      const s = this._scale();
      this.panX = sx - this._w / 2 - (before.x - this.cols / 2) * s * CELL_ASPECT;
      this.panY = sy - this._h / 2 - (before.y - this.rows / 2) * s;
      this._clampPan();
      this.invalidate();
    };
    this._onDown = (e) => {
      this._drag = { x: e.clientX, y: e.clientY, moved: false, ox: this.panX, oy: this.panY };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { }
    };
    this._onMove = (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this._drag.moved = true;
      this.panX = this._drag.ox + dx;
      this.panY = this._drag.oy + dy;
      this._clampPan();
      this.invalidate();
    };
    this._onUp = (e) => {
      const d = this._drag; this._drag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { }
      if (!d || d.moved) return; // 拖拽不算点击
      if (!this.onPick) return;
      const rect = this.canvas.getBoundingClientRect();
      const w = this._s2w(e.clientX - rect.left, e.clientY - rect.top);
      const cellX = Math.floor(w.x), cellY = Math.floor(w.y);
      if (cellX < 0 || cellY < 0 || cellX >= this.cols || cellY >= this.rows) return;
      this.onPick(cellX, cellY);
    };
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);
    // 右键选起扫块：preventDefault 弹浏览器菜单；overlay 已拦冒泡不扰游戏
    this._onCtx = (e) => {
      e.preventDefault();
      if (!this.onCtxPick) return;
      const rect = this.canvas.getBoundingClientRect();
      const w = this._s2w(e.clientX - rect.left, e.clientY - rect.top);
      const cellX = Math.floor(w.x), cellY = Math.floor(w.y);
      if (cellX < 0 || cellY < 0 || cellX >= this.cols || cellY >= this.rows) return;
      const g2 = this._gg;
      const i = Math.max(0, Math.min(g2.nx - 1, Math.floor(cellX / (g2.gw / 2))));
      const j = Math.max(0, Math.min(g2.ny - 1, Math.floor((cellY - g2.offY) / g2.gh)));
      this.onCtxPick(i, j, cellX, cellY);
    };
    this.canvas.addEventListener('contextmenu', this._onCtx);
  }

  _unbind() {
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('contextmenu', this._onCtx);
  }

  /**
   * 点击某 cell → 反算 game 坐标 → nav.flyTo 跳转（复用原生导航）。
   * @param {number} cellX
   * @param {number} cellY
   * @param {number} [k] 服务器号
   * @param {number} [subMap]
   * @returns {{ok:boolean, err?:string}}
   */
  jumpToCell(cellX, cellY, k, subMap) {
    const g = cellToGame(cellX, cellY);
    const r = nav.flyTo({ x: g.x, y: g.y, z: k != null ? k : null, subMap, click: false });
    if (!r.ok) log.warn('flyTo failed. cell=(%d,%d) game=(%d,%d) err=%s', cellX, cellY, g.x, g.y, r.err);
    return r;
  }
}
