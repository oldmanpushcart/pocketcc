/**
 * 浮层窗口基类（Shadow DOM 壳 + 几何钳制/拖拽/游戏输入屏蔽/视口重摆/toast 的公共骨架）。
 *
 * 此前 jump-overlay 与 map-overlay 各自逐字克隆了同一套浮层 shell（clampGeom/_applyGeom/
 * _wireBlockGameEvents/_wireHead/toast/_notify/resize 重摆/unmount 收尾）。其中「游戏输入屏蔽」
 * 尤其危险：事件类型清单一旦漏挂（如新增 touchmove），浮层内拖动会带动底层地图——两份拷贝意味着
 * 这个 bug 要修两次、极易只修一处。收口到此单点后，两个 map feat 只保留各自的 innerHTML 与业务接线。
 *
 * 设计为模板方法：基类持有公共字段（_h/_geom/_host/_root/_win/_toast/_toastTimer/_resizeHandler/
 * _resizeTimer，字段名沿用两 feat 原有命名以免改写数十处 this._win/this._geom 引用），并暴露三个
 * 空钩子供子类注入私货：_afterShow()（显示时、onVisibleChange 通知**之前**调用，如聚焦输入框 / 同步画布）、_afterGeom()（几何恢复后）、
 * _teardownExtras()（unmount 前收自建资源）。三钩子均经 _callHook 容错隔离（异常转 warn，绝不因单钩子抛错吞掉后续 notify/收尾）。零 core 依赖的 UI 叶子（logger 由调用方注入）。
 */

/**
 * 视口内几何钳制（单一真相）：尺寸下限 minW/minH，位置保证至少 60×40 像素留在视口内。
 * @param {{x:number,y:number,w:number,h:number}} g 待钳制的矩形
 * @param {number} minW 宽度下限
 * @param {number} minH 高度下限
 * @returns {{x:number,y:number,w:number,h:number}} 钳制后的矩形
 */
export function clampGeom(g, minW, minH) {
  const w = Math.max(minW, Math.min(g.w, window.innerWidth));
  const h = Math.max(minH, Math.min(g.h, window.innerHeight));
  return {
    w,
    h,
    x: Math.max(0, Math.min(g.x, window.innerWidth - Math.min(w, 60))),
    y: Math.max(0, Math.min(g.y, window.innerHeight - Math.min(h, 40))),
  };
}

/** 浮层内需要拦截冒泡、不让其穿透到底层游戏的事件清单（输入屏蔽的单一真相）。@type {string[]} */
const BLOCK_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'wheel',
  'keydown',
  'keyup',
  'keypress',
  'touchstart',
  'touchend',
  'contextmenu',
];

export class OverlayShell {
  /**
   * @param {object} handlers 业务回调面（子类文档约定；_notify 按名派发）
   * @param {object} opts {geom:{x,y,w,h}, minW:number, minH:number, log:ReturnType<createLog>, closeSel:string, barSel:string}
   *   geom 初始几何（内部会钳制）；minW/minH 尺寸下限；log 供 _notify 记异常；
   *   closeSel/barSel 为标题栏拖拽/关闭按钮的选择器（两 feat 的 CSS 前缀不同，故参数化）。
   */
  constructor(handlers, opts) {
    this._h = handlers || {};
    this._minW = opts.minW;
    this._minH = opts.minH;
    this._log = opts.log;
    this._closeSel = opts.closeSel;
    this._barSel = opts.barSel;
    this._geom = clampGeom(opts.geom, this._minW, this._minH);
    this._host = null;
    this._root = null;
    this._win = null;
    /** @type {?HTMLElement} toast 容器（子类 mount 里 querySelector 赋值） */
    this._toast = null;
    /** @type {?number} toast 隐藏定时器 */
    this._toastTimer = null;
    /** @type {?Function} 视口 resize 监听（右上锚定重摆，unmount 时移除） */
    this._resizeHandler = null;
    /** @type {?number} resize 防抖定时器 */
    this._resizeTimer = null;
    /** @type {?HTMLElement} 打开前的焦点元素（关闭时归还，2.4.3 焦点顺序） */
    this._prevFocus = null;
  }

  // ─── 子类可覆盖的空钩子 ───

  /**
   * 显示时机钩子（在 onVisibleChange 通知**之前**调用——保留 map「同步画布先于可见回调」的原有顺序；
   * jump 的聚焦输入框亦前移至此，因其 onVisibleChange 处理器不重建/不读输入框，顺序翻转无副作用）。
   */
  _afterShow() {}
  /** setGeom（读档恢复）应用后调用（如 map 重排画布）。 */
  _afterGeom() {}
  /** unmount 收公共资源前调用（释放子类自建的定时器/引擎/观察器）。 */
  _teardownExtras() {}

  /**
   * 容错调用子类钩子：异常转 warn、不外抛，确保后续 notify/收尾不被单钩子抛错吞掉（与 _notify 容错同风格）。
   * @param {string} name 钩子方法名
   */
  _callHook(name) {
    try {
      this[name]();
    } catch (e) {
      if (this._log) this._log.warn('hook %s threw: %s', name, e && e.message);
    }
  }

  // ─── 挂载脚手架 ───

  /**
   * 建 Shadow DOM 浮层壳（幂等由子类在调用前 guard `if(this._host)return`）。
   * 设置 this._host/_root/_win，返回三者供子类继续 querySelector 接线。
   * @param {{hostId:string, css:string, winClass:string, innerHTML:string}} o
   * @returns {{host:HTMLElement, root:ShadowRoot, win:HTMLElement}}
   */
  _mountWindow(o) {
    const host = document.createElement('div');
    host.id = o.hostId;
    host.style.cssText = 'all:initial;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = o.css;
    root.appendChild(style);
    const win = document.createElement('div');
    win.className = o.winClass;
    win.innerHTML = o.innerHTML;
    root.appendChild(win);
    document.body.appendChild(host);
    this._host = host;
    this._root = root;
    this._win = win;
    return { host, root, win };
  }

  /** 挂 window resize：右上锚定重摆——宽度变化时保持面板与视口右/上两边距离，120ms 防抖。 */
  _wireResizeAnchor() {
    let lastVW = window.innerWidth;
    this._resizeHandler = () => {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        if (!this._win) return;
        const nvw = window.innerWidth;
        const g = this._geom;
        const dispW = Math.min(g.w, lastVW);
        const rightGap = lastVW - (g.x + dispW);
        this._geom = clampGeom(
          { x: nvw - rightGap - Math.min(g.w, nvw), y: g.y, w: g.w, h: g.h },
          this._minW,
          this._minH,
        );
        lastVW = nvw;
        this._applyGeom();
        this._notify('onGeomChange', this.getGeom());
      }, 120);
    };
    window.addEventListener('resize', this._resizeHandler);
  }

  // ─── 显隐 ───

  /** 显示（先跑子类 _afterShow，再通知 onVisibleChange——保留 map 浮层「同步画布先于可见回调」的原有顺序）。 */
  show() {
    if (!this._win) return;
    if (this._win.hidden) {
      // 记录打开前的焦点（多为游戏画布/body），关闭时归还，避免键盘用户焦点丢回文档顶
      this._prevFocus = /** @type {HTMLElement} */ (document.activeElement);
      this._win.hidden = false;
      this._callHook('_afterShow');
      this._notify('onVisibleChange', true);
    }
  }

  /** 隐藏（焦点归还打开前的元素，仍在文档中且可聚焦时）。 */
  hide() {
    if (this._win && !this._win.hidden) {
      this._win.hidden = true;
      this._notify('onVisibleChange', false);
      const pf = this._prevFocus;
      this._prevFocus = null;
      try {
        if (pf && pf.isConnected && typeof pf.focus === 'function') pf.focus();
      } catch (e) {}
    }
  }

  /** 切换显隐。 */
  toggle() {
    if (this._win && this._win.hidden) this.show();
    else this.hide();
  }

  /** @returns {boolean} 是否可见 */
  isVisible() {
    return !!(this._win && !this._win.hidden);
  }

  // ─── 几何 ───

  /**
   * 恢复几何（读档）：逐键取传入值、缺省保留现值，钳制后应用并触发 _afterGeom。
   * @param {{x?:number,y?:number,w?:number,h?:number}} g
   */
  setGeom(g) {
    if (!g) return;
    this._geom = clampGeom(
      {
        x: g.x != null ? g.x : this._geom.x,
        y: g.y != null ? g.y : this._geom.y,
        w: g.w != null ? g.w : this._geom.w,
        h: g.h != null ? g.h : this._geom.h,
      },
      this._minW,
      this._minH,
    );
    this._applyGeom();
    this._callHook('_afterGeom');
  }

  /** @returns {{x:number,y:number,w:number,h:number}} 当前几何拷贝 */
  getGeom() {
    return Object.assign({}, this._geom);
  }

  /** 把 this._geom 写回 this._win 的 inline 定位样式。 */
  _applyGeom() {
    if (!this._win) return;
    const g = clampGeom(this._geom, this._minW, this._minH);
    const s = this._win.style;
    s.left = g.x + 'px';
    s.top = g.y + 'px';
    s.width = g.w + 'px';
    s.height = g.h + 'px';
  }

  // ─── 接线 ───

  /** 屏蔽游戏输入：浮层内指针/键盘/滚轮/触摸冒泡到 win 即止（事件清单见 BLOCK_EVENTS 单一真相）。 */
  _wireBlockGameEvents() {
    const stop = (e) => e.stopPropagation();
    for (const t of BLOCK_EVENTS) this._win.addEventListener(t, stop);
  }

  /** 标题栏拖拽 + 关闭按钮（选择器由 this._barSel/this._closeSel 给定）。 */
  _wireHead() {
    this._win.querySelector(this._closeSel).addEventListener('click', () => this.hide());
    const bar = this._win.querySelector(this._barSel);
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest(this._closeSel)) return;
      drag = { sx: e.clientX, sy: e.clientY, ox: this._geom.x, oy: this._geom.y };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this._geom = clampGeom(
        {
          x: drag.ox + e.clientX - drag.sx,
          y: drag.oy + e.clientY - drag.sy,
          w: this._geom.w,
          h: this._geom.h,
        },
        this._minW,
        this._minH,
      );
      this._applyGeom();
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch (err) {}
      this._notify('onGeomChange', this.getGeom());
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  /** toast 小提示（2.2s 自动隐藏）。 @param {string} msg */
  toast(msg) {
    if (!this._toast) return;
    this._toast.textContent = msg;
    this._toast.classList.add('show');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._toast.classList.remove('show'), 2200);
  }

  /**
   * 向业务回调面按名派发（异常吞掉转 warn，绝不让 UI 事件冒崩）。
   * @param {string} name 回调名
   * @param {...*} args 透传参数
   * @returns {*} 回调返回值（无回调/异常时为 undefined）
   */
  _notify(name, ...args) {
    try {
      return this._h[name] ? this._h[name](...args) : undefined;
    } catch (e) {
      if (this._log) this._log.warn('handler %s threw: %s', name, e && e.message);
      return undefined;
    }
  }

  /** 卸载浮层：先收子类私货，再清公共定时器/监听/host。 */
  unmount() {
    this._callHook('_teardownExtras');
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._host) {
      this._host.remove();
      this._host = null;
      this._root = null;
      this._win = null;
    }
  }
}
