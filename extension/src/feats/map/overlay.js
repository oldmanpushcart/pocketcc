/**
 * 全局地图浮层外壳（Shadow DOM，样式与游戏双向隔离）。照搬 feats/chat/overlay.js 的范式：
 * .pcg- 前缀 CSS、毛玻璃 backdrop-filter、position:fixed、标题栏拖拽 + 边/角 resize + 几何落盘回调、
 * 冒泡阶段 stopPropagation 屏蔽游戏输入、z-index 2147483640。本层只负责视图与交互，
 * 扫图/存储/渲染都在业务层（global-map.js）与本模块持有的 MapView 里，通过 handlers 回调面上报用户动作。
 *
 * handlers 回调面：
 *   onStartScan()               点「开始/重扫」
 *   onStopScan()                扫描中点「停止」
 *   onFilterChange(f)           图例/筛选变化（f={subs,showOther,owner}）
 *   onPick(cellX, cellY)        点画布某格（业务层调 view.jumpToCell 跳转）
 *   onCellContext(i, j)         右键画布命中块网格下标（选/取消起扫块）
 *   onListPick(cx, cy, k)       坐标列表行点击（跳转+回中）
 *   onVisibleChange(visible)    show/hide 之后
 *   onGeomChange(geom)          拖拽/resize 松手后落盘
 */
import { createLog } from '../../core/log.js';
import { MapView } from './render.js';
import { FILTER_TREE, SUB_MAP, CITY_POINT_TYPE, shieldText, fmtLargeNum } from './map-meta.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MAPOVERLAY） */
const log = createLog('MAPOVERLAY');

/** @type {number} 最小宽/高（px） */
const MIN_W = 360;
const MIN_H = 300;
/** @type {number} 默认宽/高（px，地图需要空间，给得比聊天窗大） */
const DEFAULT_W = 620;
const DEFAULT_H = 480;

/** @type {Array<[string,string]>} 归属筛选模式（[值, 标签]），与 MapView.setOwner 对齐 */
const OWN_MODES = [['all', '全部'], ['self', '我的'], ['ally', '联盟'], ['enemy', '敌方'], ['none', '无主']];

/** @type {string} Shadow DOM 样式（深色毛玻璃，延续 core/ui.js 风格） */
const CSS = `
  *{box-sizing:border-box;}
  .pcg-win{position:fixed;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;
    background:rgba(18,22,30,.78);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,.16);color:#e8eef7;
    font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
    box-shadow:0 10px 36px rgba(0,0,0,.55);z-index:2147483640;}
  .pcg-win[hidden]{display:none;}
  .pcg-head{flex:0 0 auto;padding:6px 8px 4px;}
  .pcg-titlebar{display:flex;align-items:center;cursor:move;user-select:none;touch-action:none;}
  .pcg-grip{opacity:.5;font-size:12px;letter-spacing:2px;margin-right:6px;}
  .pcg-title{font-size:12px;font-weight:600;color:#cfe8ff;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcg-tspacer{flex:1 1 auto;}
  .pcg-srvbadge{flex:0 0 auto;margin-left:6px;font-size:11px;color:#ffd98a;background:rgba(255,200,80,.14);
    border:1px solid rgba(255,200,80,.3);border-radius:8px;padding:0 7px;white-space:nowrap;}
  .pcg-close{border:none;background:transparent;color:#e8eef7;font:inherit;font-size:14px;cursor:pointer;padding:0 4px;opacity:.7;}
  .pcg-close:hover{opacity:1;}
  .pcg-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;}
  .pcg-btn{border:1px solid rgba(255,255,255,.18);border-radius:6px;background:rgba(255,255,255,.06);
    color:#cdd8e6;font:inherit;font-size:12px;padding:3px 10px;cursor:pointer;white-space:nowrap;}
  .pcg-btn:hover{background:rgba(255,255,255,.14);}
  .pcg-btn.primary{background:rgba(70,140,255,.25);border-color:rgba(120,170,255,.45);color:#dbeaff;font-weight:600;}
  .pcg-btn.warn{background:rgba(224,70,59,.22);border-color:rgba(255,120,100,.4);}
  .pcg-btn.on{background:rgba(70,140,255,.3);border-color:rgba(120,170,255,.5);color:#dbeaff;}
  .pcg-btn[disabled]{opacity:.45;cursor:default;}
  .pcg-sel{border:1px solid rgba(255,255,255,.18);border-radius:6px;background:rgba(255,255,255,.06);
    color:#cdd8e6;font:inherit;font-size:12px;padding:2px 4px;cursor:pointer;}
  .pcg-sel option{background:#1a2028;color:#e8eef7;}
  .pcg-lbl{font-size:11px;color:#8b98a9;}
  .pcg-prog{flex:1;min-width:80px;display:flex;align-items:center;gap:8px;font-size:11px;color:#8b98a9;}
  .pcg-track{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;}
  .pcg-fill{height:100%;width:0;background:linear-gradient(90deg,#4a9fff,#5be0a0);transition:width .2s;}
  .pcg-legend{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:7px 0 3px;}
  .pcg-lg{display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;user-select:none;}
  .pcg-lg input{width:13px;height:13px;cursor:pointer;}
  .pcg-dot{width:9px;height:9px;border-radius:2px;display:inline-block;}
  .pcg-body{flex:1 1 auto;min-height:0;display:flex;background:#0c0f14;}
  .pcg-cwrap{flex:1 1 auto;min-width:0;position:relative;}
  .pcg-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair;}
  .pcg-status{position:absolute;left:8px;bottom:6px;font-size:11px;color:#9fb0c4;background:rgba(10,14,20,.7);
    padding:2px 8px;border-radius:5px;pointer-events:none;white-space:nowrap;}
  .pcg-toast{position:absolute;left:50%;top:44%;transform:translateX(-50%);max-width:86%;padding:5px 12px;
    border-radius:6px;background:rgba(8,10,14,.92);border:1px solid rgba(255,255,255,.2);color:#ffd0b8;
    font-size:12px;pointer-events:none;opacity:0;transition:opacity .2s;z-index:3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcg-toast.show{opacity:1;}
  .pcg-rz{position:absolute;z-index:2;touch-action:none;}
  .pcg-rz[data-dir="l"]{left:0;top:8px;bottom:8px;width:5px;cursor:ew-resize;}
  .pcg-rz[data-dir="r"]{right:0;top:8px;bottom:8px;width:5px;cursor:ew-resize;}
  .pcg-rz[data-dir="b"]{bottom:0;left:22px;right:22px;height:5px;cursor:ns-resize;}
  .pcg-rz[data-dir="bl"]{left:0;bottom:0;width:16px;height:16px;cursor:nesw-resize;}
  .pcg-rz[data-dir="br"]{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;
    background:linear-gradient(315deg,transparent 50%,rgba(255,255,255,.35) 50%);border-radius:0 0 10px 0;}
  /* P1 图例（行2）：四大类 chip + 归属分段合并同一行（pop 锚定于此，需 position:relative；垂直居中对齐 chip 与归属） */
  .pcg-legend{position:relative;align-items:center;}
  /* 归属：不再 width:100% 另起一行——靠 margin-left:auto 推到图例行右端，左侧竖线分隔与 chip 分组；窄窗无位时随 flex-wrap 换行 */
  .pcg-own{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:11px;margin-left:auto;padding-left:10px;border-left:1px solid rgba(255,255,255,.14);}
  /* 行3 玩家筛选（仅玩家城池）：标题 + 护盾组（独立 panel）+ 等级组（≥N） */
  .pcg-shield{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:5px 0 2px;padding-top:5px;font-size:11px;
    border-top:1px solid rgba(255,255,255,.08);}
  .pcg-shield .pcg-lbl{color:#9fb6d4;}
  /* 护盾组：独立 panel 包裹（边框+淡底，与等级组区分） */
  .pcg-pf-shield{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 8px;
    border:1px solid rgba(255,255,255,.14);border-radius:7px;background:rgba(255,255,255,.04);}
  .pcg-pf-level{display:inline-flex;align-items:center;gap:4px;}
  /* 护盾三态分段 + 时间阈值子组（非 flex 项内部的 label/input/select 靠 flex 排版） */
  .pcg-shield-modes{display:flex;align-items:center;gap:3px;}
  .pcg-shield-thr{display:flex;align-items:center;gap:6px;}
  .pcg-shield-thr[hidden]{display:none;}
  .pcg-shield-num{width:52px;padding:2px 5px;border:1px solid rgba(255,255,255,.18);border-radius:6px;
    background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;font-size:12px;}
  .pcg-level-num{width:48px;padding:2px 5px;border:1px solid rgba(255,255,255,.18);border-radius:6px;
    background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;font-size:12px;}
  .pcg-shield-num::-webkit-inner-spin-button{opacity:.4;}
  .pcg-own .seg,.pcg-shield .seg{border:1px solid rgba(255,255,255,.18);border-radius:5px;background:rgba(255,255,255,.06);
    color:#cdd8e6;font:inherit;font-size:11px;padding:1px 7px;cursor:pointer;}
  .pcg-own .seg:hover,.pcg-shield .seg:hover{background:rgba(255,255,255,.14);}
  .pcg-own .seg.on,.pcg-shield .seg.on{background:rgba(70,140,255,.3);border-color:rgba(120,170,255,.5);color:#dbeaff;font-weight:600;}
  /* 四大类 chip + POP 细分类浮层（pop 绝对定位脱离 flex 流，不顶开工具栏/图例） */
  .pcg-cats{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
  .pcg-chip{display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;user-select:none;
    border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:1px 7px;background:rgba(255,255,255,.05);}
  .pcg-chip:hover{background:rgba(255,255,255,.12);}
  .pcg-chip .pcg-dot{width:9px;height:9px;border-radius:2px;flex:0 0 auto;}
  .pcg-chip input{width:12px;height:12px;cursor:pointer;margin:0;}
  .pcg-chip .caret{font-size:9px;opacity:.65;margin-left:1px;}
  .pcg-pop{position:absolute;top:100%;left:8px;display:none;flex-direction:column;gap:3px;min-width:132px;max-width:230px;
    padding:6px 9px;margin-top:2px;background:rgba(12,16,22,.97);border:1px solid rgba(255,255,255,.2);border-radius:8px;
    box-shadow:0 8px 22px rgba(0,0,0,.5);z-index:6;}
  .pcg-pop.show{display:flex;}
  .pcg-pop-hd{font-size:11px;color:#8b98a9;}
  .pcg-pop-row{display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;user-select:none;}
  .pcg-pop-row input{width:13px;height:13px;cursor:pointer;margin:0;}
  .pcg-swatch{width:11px;height:11px;border-radius:2px;display:inline-block;flex:0 0 auto;border:1px solid rgba(255,255,255,.28);}
  /* 右侧坐标列表侧栏（搜索 + 计数 + 滚动行） */
  .pcg-list{flex:0 0 178px;display:flex;flex-direction:column;min-height:0;
    border-left:1px solid rgba(255,255,255,.12);background:rgba(10,14,20,.55);}
  .pcg-list[hidden]{display:none;}
  .pcg-lsearch{margin:6px 6px 3px;padding:3px 7px;border:1px solid rgba(255,255,255,.18);border-radius:5px;
    background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;font-size:11px;}
  .pcg-lcount{padding:0 8px 3px;font-size:10px;color:#8b98a9;flex:0 0 auto;}
  .pcg-lrows{flex:1 1 auto;overflow-y:auto;min-height:0;padding:0 4px 6px;}
  .pcg-lrow{display:flex;align-items:center;gap:5px;padding:3px 5px;border-radius:5px;cursor:pointer;font-size:11px;color:#c9d6e6;}
  .pcg-lrow:hover{background:rgba(255,255,255,.08);}
  .pcg-lrow.on{background:rgba(70,140,255,.22);}
  .pcg-lsw{width:8px;height:8px;border-radius:2px;flex:0 0 auto;}
  .pcg-lmain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;line-height:1.25;}
  .pcg-lname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcg-lcoord{font-size:10px;color:#8fa3bb;}
  .pcg-lshield{font-size:10px;color:#ffcf8f;}
  .pcg-lshield.none{color:#7d8ea3;}
  .pcg-lmeta{font-size:10px;color:#9fb6d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcg-lk{flex:0 0 auto;font-size:9px;color:#ffd98a;background:rgba(255,200,80,.14);border-radius:6px;padding:0 4px;}
  .pcg-lempty{padding:10px;font-size:11px;color:#8b98a9;text-align:center;}
`;

/** @type {number} 列表一次最多渲染的行数（超出提示用搜索缩小范围，防 DOM 膨胀） */
const LIST_ROW_CAP = 250;

/**
 * HTML 转义（玩家名等外来文本入 innerHTML 前必过）
 * @param {*} s
 * @returns {string}
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 视口宽松钳制（同聊天浮层）：宽高钳到 [min, 视口]，坐标只保证露出 60×40px。
 * @param {{x:number,y:number,w:number,h:number}} g
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function clampGeom(g) {
  const w = Math.max(MIN_W, Math.min(g.w, window.innerWidth));
  const h = Math.max(MIN_H, Math.min(g.h, window.innerHeight));
  return {
    w, h,
    x: Math.max(0, Math.min(g.x, window.innerWidth - Math.min(w, 60))),
    y: Math.max(0, Math.min(g.y, window.innerHeight - Math.min(h, 40))),
  };
}

/** 大类代表色（chip 色点用）：取该类首个细分类的色 */
const CAT_COLOR = (() => {
  const m = {};
  for (const cat of FILTER_TREE) m[cat.key] = (cat.subs[0] && cat.subs[0].color) || '#8a93a6';
  return m;
})();

export class MapOverlay {
  /** @param {object} handlers 回调面（见文件头注释） */
  constructor(handlers) {
    this._h = handlers || {};
    this._geom = clampGeom({ x: Math.max(0, (window.innerWidth - DEFAULT_W) / 2), y: 40, w: DEFAULT_W, h: DEFAULT_H });
    /** @type {string[]} 选中的细分类 key（默认全选，业务层会用 setSubs 回填） */
    this._subs = Object.keys(SUB_MAP);
    /** @type {boolean} 是否展示未归类类型（灰色兜底） */
    this._showOther = true;
    /** @type {string} 归属筛选模式（all/self/ally/enemy/none，默认全部） */
    this._owner = 'all';
    /** @type {?string} 当前展开 POP 的大类 key（null=无） */
    this._openCat = null;
    this._host = null; this._root = null; this._win = null;
    this._body = null; this._canvas = null; this._wrap = null; this._srvBadge = null;
    /** @type {MapView|null} */
    this.view = null;
    this._toastTimer = null;
    this._ro = null;
    /** @type {?Function} 视口 resize 监听（右上锚定重摆，unmount 时移除） */
    this._resizeHandler = null;
    /** @type {?number} resize 防抖定时器 */
    this._resizeTimer = null;
    /** @type {boolean} 右侧坐标列表是否展开（常驻开，已无收起按钮） */
    this._listOpen = true;
    /** @type {Array<object>} 列表当前数据（业务层推入，已按图例过滤、新→旧） */
    this._listItems = [];
    /** @type {number} 桶内符合图例的总点数（计数行用） */
    this._listTotal = 0;
    /** @type {Array<object>} 当前渲染行对应的数据切片（行点击反查用） */
    this._paintIdx = [];
    /** @type {?number} 搜索防抖定时器 */
    this._listTimer = null;
    /** @type {boolean} 右键起扫块提示是否已弹过（一次性） */
    this._ctxHinted = false;
  }

  /**
   * 挂载浮层（幂等）。建 Shadow DOM、实例化 MapView、接线交互。
   * @param {import('./store.js').MapStore} store 传给 MapView 的数据源
   * @param {{cols?:number, rows?:number}} [size] 全图尺寸
   * @returns {void}
   */
  mount(store, size) {
    if (this._host) return;
    const host = document.createElement('div');
    host.id = 'pocketcc-map-host';
    host.style.cssText = 'all:initial;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const inS = (k) => this._subs.indexOf(k) >= 0;
    const catsHtml = FILTER_TREE.map((cat) => {
      const anyOn = cat.subs.some((s) => inS(s.key));
      return `<div class="pcg-chip" data-cat="${cat.key}">` +
        `<input type="checkbox" data-catcb="${cat.key}"${anyOn ? ' checked' : ''}>` +
        `<span class="pcg-dot" style="background:${CAT_COLOR[cat.key]}"></span>${cat.label}` +
        `<span class="caret">▾</span></div>`;
    }).join('');
    const otherChip = `<div class="pcg-chip" data-other="1">` +
      `<input type="checkbox" data-g="other"${this._showOther ? ' checked' : ''}>` +
      `<span class="pcg-dot" style="background:#8a93a6"></span>其他</div>`;
    const popsHtml = FILTER_TREE.map((cat) => {
      const rows = cat.subs.map((s) => `<label class="pcg-pop-row">` +
        `<input type="checkbox" data-sub="${s.key}"${inS(s.key) ? ' checked' : ''}>` +
        `<span class="pcg-swatch" style="background:${s.color}"></span>${s.label}</label>`).join('');
      return `<div class="pcg-pop" data-pop="${cat.key}"><div class="pcg-pop-hd">${cat.label}</div>${rows}</div>`;
    }).join('');
    const legend = `<div class="pcg-cats">${catsHtml}${otherChip}</div>` +
      `<div class="pcg-own"><span class="pcg-lbl">归属</span>` +
      OWN_MODES.map((o) => `<button class="seg${this._owner === o[0] ? ' on' : ''}" data-own="${o[0]}">${o[1]}</button>`).join('') +
      `</div>` +
      popsHtml;
    // 行3：玩家筛选（仅玩家城池）——护盾组（独立 panel：不限/有盾/无盾 + 时间阈值仅「有盾」显）+ 等级组（≥ N）
    const shield = `<div class="pcg-shield"><span class="pcg-lbl">玩家</span>` +
      `<span class="pcg-pf-shield"><span class="pcg-lbl">护盾</span>` +
      `<span class="pcg-shield-modes">` +
      `<button class="seg smode on" data-smode="off">不限</button>` +
      `<button class="seg smode" data-smode="none">无盾</button>` +
      `<button class="seg smode" data-smode="has">有盾</button></span>` +
      `<span class="pcg-shield-thr" hidden><span class="pcg-lbl">剩余≤</span>` +
      `<input class="pcg-shield-num" type="number" min="0" step="1" placeholder="不限">` +
      `<select class="pcg-sel pcg-shield-unit"><option value="h">小时</option><option value="m">分钟</option></select></span>` +
      `</span>` +
      `<span class="pcg-pf-level"><span class="pcg-lbl">等级≥</span>` +
      `<input class="pcg-level-num" type="number" min="0" max="100" step="1" placeholder="不限"></span>` +
      `</div>`;

    const win = document.createElement('div');
    win.className = 'pcg-win';
    win.innerHTML =
      `<div class="pcg-head">` +
      `<div class="pcg-titlebar"><span class="pcg-grip">⠿</span><span class="pcg-title">全局地图</span>` +
      `<span class="pcg-srvbadge" hidden></span><span class="pcg-tspacer"></span>` +
      `<button class="pcg-close" title="关闭">✕</button></div>` +
      `<div class="pcg-bar">` +
      `<button class="pcg-btn primary act-scan">开始扫描</button>` +
      `<button class="pcg-btn warn act-stop" hidden>停止扫描</button>` +
      `<button class="pcg-btn act-fit">复位</button>` +
      `<button class="pcg-btn act-zin">＋</button>` +
      `<button class="pcg-btn act-zout">－</button>` +
      `<button class="pcg-btn act-grid" title="切换坐标网格">网格</button>` +
      `<button class="pcg-btn act-clear" title="清空全部已扫点位（含持久数据）">清空</button>` +
      `<span class="pcg-prog"><span class="pcg-text">未扫描</span><span class="pcg-track"><span class="pcg-fill"></span></span></span>` +
      `</div>` +
      `<div class="pcg-legend">${legend}</div>` +
      shield +
      `</div>` +
      `<div class="pcg-body"><div class="pcg-cwrap"><canvas class="pcg-canvas"></canvas><div class="pcg-status" hidden></div><div class="pcg-toast"></div></div>` +
      `<div class="pcg-list"${this._listOpen ? '' : ' hidden'}><input class="pcg-lsearch" type="text" placeholder="搜索坐标/名称/类型">` +
      `<div class="pcg-lcount"></div><div class="pcg-lrows"></div></div></div>` +
      `<div class="pcg-rz" data-dir="l"></div><div class="pcg-rz" data-dir="r"></div>` +
      `<div class="pcg-rz" data-dir="b"></div><div class="pcg-rz" data-dir="bl"></div>` +
      `<div class="pcg-rz" data-dir="br"></div>`;
    root.appendChild(win);
    document.body.appendChild(host);

    this._host = host; this._root = root; this._win = win;
    this._body = win.querySelector('.pcg-body');
    this._canvas = win.querySelector('.pcg-canvas');
    this._wrap = win.querySelector('.pcg-cwrap');
    this._statusEl = win.querySelector('.pcg-status');
    this._srvBadge = win.querySelector('.pcg-srvbadge');
    this._toast = win.querySelector('.pcg-toast');
    this._fill = win.querySelector('.pcg-fill');
    this._progText = win.querySelector('.pcg-text');
    this._btnScan = win.querySelector('.act-scan');
    this._btnStop = win.querySelector('.act-stop');

    // MapView 接管画布与点击回调（左键跳格 / 右键选起扫块）
    this.view = new MapView(this._canvas, store, {
      cols: (size && size.cols) || undefined,
      rows: (size && size.rows) || undefined,
      onPick: (cx, cy) => this._notify('onPick', cx, cy),
      onCtxPick: (i, j) => {
        if (!this._ctxHinted) { this._ctxHinted = true; this.toast('左键跳格 · 右键选起扫块（再点同块取消）'); }
        this._notify('onCellContext', i, j);
      },
    });

    this._wireBlockGameEvents();
    this._wireHead();
    this._wireToolbar();
    this._wireLegend();
    this._wirePlayer();
    this._wireList();
    this._wireResizeHandle();
    this._applyGeom();
    this._syncCanvas();

    // 容器尺寸变化（resize/首次显示）：ResizeObserver 驱动画布重排
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => { this._syncCanvas(); });
      this._ro.observe(this._body);
    }
    // 视口变化（窗口缩放/F11 全屏等）：右上锚定——保持与视口右/上两边的距离，
    // 宽度变化时按旧右距重算 x（面板跟右缘走），y 不变；与聊天浮层/悬浮图标一致
    let lastVW = window.innerWidth;
    this._resizeHandler = () => {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        if (!this._win) return;
        const nvw = window.innerWidth;
        const g = this._geom;
        const dispW = Math.min(g.w, lastVW);          // 旧视口下的显示宽
        const rightGap = lastVW - (g.x + dispW);      // 面板右缘到旧视口右边距
        this._geom = clampGeom({ x: nvw - rightGap - Math.min(g.w, nvw), y: g.y, w: g.w, h: g.h });
        lastVW = nvw;
        this._applyGeom();
        this._notify('onGeomChange', this.getGeom()); // x 语义已随视口平移，同步存档
      }, 120);
    };
    window.addEventListener('resize', this._resizeHandler);
    win.hidden = true;
  }

  /** 画布 CSS 尺寸同步到容器：必须量「容器」(.pcg-cwrap) 而非 canvas 自身——
   * resize 会把 canvas 的 inline width/height 固定为上次测量值（压过 CSS 100%），
   * 若量 canvas 则永远读回旧尺寸→画布锁死在旧大小，容器变化跟不上。 */
  _syncCanvas() {
    if (!this.view || !this._wrap) return;
    const w = this._wrap.clientWidth, h = this._wrap.clientHeight;
    if (w > 0 && h > 0) this.view.resize(w, h);
  }

  /** 显示 */
  show() {
    if (!this._win) return;
    if (this._win.hidden) { this._win.hidden = false; this._syncCanvas(); this._notify('onVisibleChange', true); }
  }

  /** 隐藏（仅停显示，渲染循环/订阅由业务层管） */
  hide() {
    if (this._win && !this._win.hidden) { this._win.hidden = true; this._notify('onVisibleChange', false); }
  }

  /** 切换显隐 */
  toggle() { if (this._win && this._win.hidden) this.show(); else this.hide(); }

  /** @returns {boolean} 是否可见 */
  isVisible() { return !!(this._win && !this._win.hidden); }

  /**
   * 更新进度显示。
   * @param {{done:number,total:number,running:boolean}} p
   * @param {string} [note] 覆盖度/新鲜度附注
   */
  setProgress(p, note) {
    if (!this._fill) return;
    const ratio = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
    this._fill.style.width = (ratio * 100).toFixed(1) + '%';
    if (p.running) this._progText.textContent = `扫描 ${p.done}/${p.total}` + (note ? ' · ' + note : '');
    else if (p.total > 0 && p.done >= p.total) this._progText.textContent = `完成 ${p.done}/${p.total}` + (note ? ' · ' + note : '');
    else this._progText.textContent = note || '未扫描';
    // 扫描态驱动雷达动画开合与按钮可见
    if (this.view) this.view.setScanning(p.running);
    if (this._btnScan) this._btnScan.hidden = p.running;
    if (this._btnStop) this._btnStop.hidden = !p.running;
  }

  /** 底图就绪后交给 view */
  setTerrain(cv) { if (this.view) this.view.setTerrain(cv); }

  /**
   * 设置选中细分类并同步 chip/POP 勾选（不触发 onFilterChange，供业务层初始化/面板回填用）。
   * @param {string[]} subKeys 选中的细分类 key 数组
   */
  setSubs(subKeys) {
    if (!Array.isArray(subKeys)) return;
    this._subs = subKeys.slice();
    this._syncLegendChecks();
  }

  /** 依据 this._subs 同步 DOM：所有细分类勾选 + 大类 chip 的全选/半选态 */
  _syncLegendChecks() {
    if (!this._win) return;
    const inS = (k) => this._subs.indexOf(k) >= 0;
    this._win.querySelectorAll('input[data-sub]').forEach((cb) => { cb.checked = inS(cb.dataset.sub); });
    this._win.querySelectorAll('input[data-catcb]').forEach((cb) => {
      const cat = FILTER_TREE.find((c) => c.key === cb.dataset.catcb);
      if (!cat) return;
      const nOn = cat.subs.filter((s) => inS(s.key)).length;
      cb.checked = nOn === cat.subs.length;
      cb.indeterminate = nOn > 0 && nOn < cat.subs.length;
    });
    const other = this._win.querySelector('input[data-g="other"]');
    if (other) other.checked = !!this._showOther;
  }

  /** 状态角标（数据时间/覆盖度等） */
  setStatus(text) { if (this._statusEl) { this._statusEl.hidden = !text; this._statusEl.textContent = text || ''; } }

  /** 区号徽标（当前视角桶）：k=0/空时隐藏 */
  setServerBadge(k) {
    if (!this._srvBadge) return;
    if (!k) { this._srvBadge.hidden = true; return; }
    this._srvBadge.hidden = false;
    this._srvBadge.textContent = '区 ' + k;
  }

  /** toast 小提示 */
  toast(msg) {
    if (!this._toast) return;
    this._toast.textContent = msg;
    this._toast.classList.add('show');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._toast.classList.remove('show'), 2200);
  }

  /** @returns {boolean} 列表是否展开（坐标列表已常驻，恒 true） */
  isListOpen() { return this._listOpen; }

  /**
   * 渲染列表数据（业务层推入；搜索变化不重拉数据，纯前端过滤）。
   * @param {Array<{cx:number,cy:number,k:number,color:string,name:string,sub:string,cross:boolean}>} items 新→旧，≤500 条
   * @param {number} total 桶内符合图例的总点数
   */
  renderList(items, total) {
    if (!this._win) return;
    this._listItems = Array.isArray(items) ? items : [];
    this._listTotal = total | 0;
    this._paintList();
  }

  /** 按当前搜索词渲染行（行上限 LIST_ROW_CAP） */
  _paintList() {
    const rows = this._win.querySelector('.pcg-lrows');
    const cnt = this._win.querySelector('.pcg-lcount');
    if (!rows || !cnt) return;
    const inp = this._win.querySelector('.pcg-lsearch');
    const q = (inp && inp.value || '').trim().toLowerCase();
    const all = this._listItems;
    const list = !q ? all : all.filter((it) => ((it.cx + ',' + it.cy) + ' ' + (it.name || '') + ' ' + (it.sub || '')).toLowerCase().indexOf(q) >= 0);
    const shown = list.slice(0, LIST_ROW_CAP);
    this._paintIdx = shown;
    cnt.textContent = q ? `命中 ${list.length} · 桶内共 ${this._listTotal} 点` : `最新 ${all.length} / 共 ${this._listTotal} 点`;
    if (!shown.length) { rows.innerHTML = `<div class="pcg-lempty">${q ? '无匹配点位' : '暂无点位'}</div>`; return; }
    const now = Date.now();
    rows.innerHTML = shown.map((it, n) => {
      const isCity = it.pt === CITY_POINT_TYPE;
      // 玩家城池四行：① 名称 ② 坐标 ③ 等级-基地战力-兵力（Lv100-58.5M-960cc，战力/兵力走 getLargeNumberShow）④ 有无护盾
      let metaLine = '';
      let shieldLine = '';
      if (isCity) {
        const parts = [];
        if (it.lv != null) parts.push('Lv' + it.lv);
        if (it.power != null) parts.push(fmtLargeNum(it.power));
        if (it.army != null) parts.push(fmtLargeNum(it.army));
        if (parts.length) metaLine = `<span class="pcg-lmeta">${esc(parts.join('-'))}</span>`;
        const sTxt = shieldText(it.shield, now);
        shieldLine = (sTxt && sTxt !== '无')
          ? `<span class="pcg-lshield">护盾：${esc(sTxt)}</span>`
          : `<span class="pcg-lshield none">护盾：无</span>`;
      }
      return `<div class="pcg-lrow" data-n="${n}">` +
        `<span class="pcg-lsw" style="background:${it.color}"></span>` +
        `<span class="pcg-lmain"><span class="pcg-lname" title="${esc(it.sub || '')} · (${it.cx},${it.cy})">${esc(it.name || it.sub || '未知点')}</span><span class="pcg-lcoord">(${it.cx},${it.cy})</span>${metaLine}${shieldLine}</span>` +
        (it.cross ? `<span class="pcg-lk" title="跨区点：属区 ${it.k}">区${it.k}</span>` : '') +
        `</div>`;
    }).join('') +
      (list.length > LIST_ROW_CAP ? `<div class="pcg-lempty">仅显示前 ${LIST_ROW_CAP} 条，可用搜索缩小范围</div>` : '');
  }

  /** 恢复几何（读档） */
  setGeom(g) {
    if (!g) return;
    this._geom = clampGeom({ x: g.x != null ? g.x : this._geom.x, y: g.y != null ? g.y : this._geom.y, w: g.w != null ? g.w : this._geom.w, h: g.h != null ? g.h : this._geom.h });
    this._applyGeom();
    this._syncCanvas();
  }

  /** @returns {{x:number,y:number,w:number,h:number}} 当前几何拷贝 */
  getGeom() { return Object.assign({}, this._geom); }

  /** 卸载浮层 */
  unmount() {
    if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null; }
    if (this._listTimer) { clearTimeout(this._listTimer); this._listTimer = null; }
    if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
    if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
    if (this.view) { this.view.destroy(); this.view = null; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._host) { this._host.remove(); this._host = null; this._root = null; this._win = null; }
  }

  // ─────────────────────── 内部接线 ───────────────────────

  _applyGeom() {
    if (!this._win) return;
    const g = clampGeom(this._geom);
    const s = this._win.style;
    s.left = g.x + 'px'; s.top = g.y + 'px'; s.width = g.w + 'px'; s.height = g.h + 'px';
  }

  /** 屏蔽游戏输入：浮层内指针/键盘/滚轮冒泡到 win 即止 */
  _wireBlockGameEvents() {
    const stop = (e) => e.stopPropagation();
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchend', 'contextmenu']) {
      this._win.addEventListener(t, stop);
    }
  }

  /** 标题栏拖拽 + 关闭 */
  _wireHead() {
    this._win.querySelector('.pcg-close').addEventListener('click', () => this.hide());
    const bar = this._win.querySelector('.pcg-titlebar');
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.pcg-close')) return;
      drag = { sx: e.clientX, sy: e.clientY, ox: this._geom.x, oy: this._geom.y };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this._geom = clampGeom({ x: drag.ox + e.clientX - drag.sx, y: drag.oy + e.clientY - drag.sy, w: this._geom.w, h: this._geom.h });
      this._applyGeom();
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      try { bar.releasePointerCapture(e.pointerId); } catch (err) { }
      this._notify('onGeomChange', this.getGeom());
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  /** 工具栏：扫描/停止/复位/缩放 */
  _wireToolbar() {
    this._btnScan.addEventListener('click', () => this._notify('onStartScan'));
    this._btnStop.addEventListener('click', () => this._notify('onStopScan'));
    this._win.querySelector('.act-fit').addEventListener('click', () => { if (this.view) this.view.fit(); });
    this._win.querySelector('.act-zin').addEventListener('click', () => { if (this.view) this.view.zoomBy(1.3); });
    this._win.querySelector('.act-zout').addEventListener('click', () => { if (this.view) this.view.zoomBy(1 / 1.3); });
    this._win.querySelector('.act-grid').addEventListener('click', () => { if (this.view) this.view.toggleGrid(); });
    // 坐标列表改为常驻（_listOpen 恒 true），无「列表」开关按钮；业务层始终供数。
    // 高度已固定为「近」(viewLevel=1)，不再提供工具栏下拉（旧 .act-level 已移除）。
    // 清空：两步确认（首次点击变「确认清空?」并高亮，3s 内再点才真正触发），避免误删
    const clr = this._win.querySelector('.act-clear');
    if (clr) {
      let armed = false, timer = null;
      const disarm = () => { armed = false; clr.textContent = '清空'; clr.classList.remove('warn'); if (timer) { clearTimeout(timer); timer = null; } };
      clr.addEventListener('click', () => {
        if (!armed) { armed = true; clr.textContent = '确认清空?'; clr.classList.add('warn'); timer = setTimeout(disarm, 3000); return; }
        disarm(); this._notify('onClearPoints');
      });
    }
  }

  /**
   * 同步工具栏「高度层级」下拉选中值（不触发 change 回调，供业务层初始化/面板回填用）。
   * @param {number} lv 0~4
   */
  setViewLevel(lv) {
    if (!this._win) return;
    const sel = this._win.querySelector('.act-level');
    if (sel) sel.value = String(Math.max(0, Math.min(4, lv | 0)));
  }

  /** 坐标列表侧栏：行点击（委托）跳转 + 搜索防抖过滤 */
  _wireList() {
    const win = this._win;
    const rows = win.querySelector('.pcg-lrows');
    if (rows) {
      rows.addEventListener('click', (e) => {
        const el = e.target.closest('.pcg-lrow');
        if (!el) return;
        const it = this._paintIdx && this._paintIdx[+el.dataset.n];
        if (!it) return;
        rows.querySelectorAll('.pcg-lrow.on').forEach((r) => r.classList.remove('on'));
        el.classList.add('on');
        this._notify('onListPick', it.cx, it.cy, it.k);
      });
    }
    const inp = win.querySelector('.pcg-lsearch');
    if (inp) {
      inp.addEventListener('input', () => {
        if (this._listTimer) clearTimeout(this._listTimer);
        this._listTimer = setTimeout(() => this._paintList(), 200);
      });
      // 搜索框内 Ctrl+M 不应被全局热键劫持（input 标签已由 onKeydown 自查拦截）
    }
  }

  /** 图例交互：chip 开合 POP、大类全选/半选、细分类叶子、其他、等级/战力/归属 → 汇总回报业务层 */
  _wireLegend() {
    const win = this._win;
    // 大类 chip：点文字/色点区→开合该类 POP；点 checkbox → 全选/取消该类
    win.querySelectorAll('.pcg-chip[data-cat]').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        if (e.target && e.target.tagName === 'INPUT') return; // checkbox 由 change 处理
        this._togglePop(chip);
      });
    });
    win.querySelectorAll('input[data-catcb]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const cat = FILTER_TREE.find((c) => c.key === cb.dataset.catcb);
        if (!cat) return;
        const set = new Set(this._subs);
        for (const s of cat.subs) { if (cb.checked) set.add(s.key); else set.delete(s.key); }
        this._subs = Array.from(set);
        this._syncLegendChecks();
        this._emitFilter();
      });
    });
    win.querySelectorAll('input[data-sub]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const set = new Set(this._subs);
        if (cb.checked) set.add(cb.dataset.sub); else set.delete(cb.dataset.sub);
        this._subs = Array.from(set);
        this._syncLegendChecks();
        this._emitFilter();
      });
    });
    const other = win.querySelector('input[data-g="other"]');
    if (other) other.addEventListener('change', () => { this._showOther = other.checked; this._emitFilter(); });
    // 归属分段（单选）
    win.querySelectorAll('.pcg-own .seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._owner = btn.dataset.own || 'all';
        win.querySelectorAll('.pcg-own .seg').forEach((b) => b.classList.toggle('on', b === btn));
        this._emitFilter();
      });
    });
    // 点画布（拖拽/点击）时收起 POP（shadow 内直接监听，避免 document 重定向问题）
    if (this._canvas) this._canvas.addEventListener('pointerdown', () => this._closePop());
  }

  /** 行3 玩家筛选接线：护盾组（不限/有盾/无盾 三态 + 时间阈值仅「有盾」）→ onShieldFilter；等级组（≥N）→ onLevelFilter */
  _wirePlayer() {
    const win = this._win;
    const num = win.querySelector('.pcg-shield-num');
    const unit = win.querySelector('.pcg-shield-unit');
    const thr = win.querySelector('.pcg-shield-thr');
    const lnum = win.querySelector('.pcg-level-num');
    const modes = Array.from(win.querySelectorAll('.pcg-shield .smode'));
    const st = { mode: 'off' };
    const emit = () => {
      const raw = num ? String(num.value).trim() : '';
      const v = raw === '' ? NaN : Number(raw);
      // 仅「有盾」参与时间阈值：非法/空→ null（=任何有盾城）；「无盾/不限」不传阈值
      const ms = (st.mode === 'has' && isFinite(v) && v >= 0) ? v * (unit && unit.value === 'm' ? 60000 : 3600000) : null;
      this._notify('onShieldFilter', st.mode, ms);
    };
    const sync = () => {
      modes.forEach((b) => b.classList.toggle('on', b.dataset.smode === st.mode));
      if (thr) thr.hidden = st.mode !== 'has'; // 无盾/不限隐时间输入；有盾才显
      if (num) num.disabled = st.mode !== 'has';
      if (unit) unit.disabled = st.mode !== 'has';
    };
    modes.forEach((b) => b.addEventListener('click', () => { st.mode = b.dataset.smode || 'off'; sync(); emit(); }));
    if (num) { num.addEventListener('change', emit); num.addEventListener('input', emit); }
    if (unit) unit.addEventListener('change', emit);
    // 等级组：≥N 整数，空/非法→ null（不限）；与护盾独立回报，不随护盾时间联动
    const emitLevel = () => {
      const raw = lnum ? String(lnum.value).trim() : '';
      const v = raw === '' ? NaN : Number(raw);
      this._notify('onLevelFilter', (isFinite(v) && v >= 0) ? Math.floor(v) : null);
    };
    if (lnum) { lnum.addEventListener('change', emitLevel); lnum.addEventListener('input', emitLevel); }
    sync();
  }

  /** 开合某大类 POP（同时只开一个；锚到该 chip 下方） */
  _togglePop(chip) {
    const key = chip.dataset.cat;
    const pop = this._win.querySelector('.pcg-pop[data-pop="' + key + '"]');
    if (!pop) return;
    const willOpen = this._openCat !== key;
    this._closePop();
    if (willOpen) {
      pop.style.left = Math.max(4, chip.offsetLeft) + 'px';
      pop.classList.add('show');
      this._openCat = key;
    }
  }

  /** 收起全部 POP */
  _closePop() {
    if (!this._win) return;
    this._win.querySelectorAll('.pcg-pop.show').forEach((p) => p.classList.remove('show'));
    this._openCat = null;
  }

  /** 汇总当前选择 → 回报业务层（选中的 subs + showOther + 归属） */
  _emitFilter() {
    if (!this._win) return;
    this._notify('onFilterChange', {
      subs: this._subs.slice(), showOther: this._showOther, owner: this._owner,
    });
  }

  /** 边/角 resize 把手 */
  _wireResizeHandle() {
    Array.from(this._win.querySelectorAll('.pcg-rz')).forEach((hd) => {
      const dir = hd.dataset.dir;
      let rs = null;
      hd.addEventListener('pointerdown', (e) => {
        rs = { sx: e.clientX, sy: e.clientY, ox: this._geom.x, oy: this._geom.y, ow: this._geom.w, oh: this._geom.h };
        hd.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });
      hd.addEventListener('pointermove', (e) => {
        if (!rs) return;
        const dx = e.clientX - rs.sx, dy = e.clientY - rs.sy;
        let x = rs.ox, y = rs.oy, w = rs.ow, h = rs.oh;
        if (dir === 'l' || dir === 'bl') { w = rs.ow - dx; x = rs.ox + dx; }
        if (dir === 'r' || dir === 'br') { w = rs.ow + dx; }
        if (dir === 'b' || dir === 'bl' || dir === 'br') { h = rs.oh + dy; }
        if ((dir === 'l' || dir === 'bl') && w < MIN_W) { w = MIN_W; x = rs.ox + rs.ow - MIN_W; }
        if (h < MIN_H) h = MIN_H;
        this._geom = clampGeom({ x, y, w, h });
        this._applyGeom();
      });
      const end = (e) => {
        if (!rs) return;
        rs = null;
        try { hd.releasePointerCapture(e.pointerId); } catch (err) { }
        this._notify('onGeomChange', this.getGeom());
        this._syncCanvas();
      };
      hd.addEventListener('pointerup', end);
      hd.addEventListener('pointercancel', end);
    });
  }

  /**
   * 回调面转发（异常吞掉，不冒泡到游戏）
   * @param {string} name handlers 键
   * @param {...*} args
   * @returns {*}
   */
  _notify(name, ...args) {
    try { return this._h[name] ? this._h[name](...args) : undefined; } catch (e) { log.warn('handler %s threw: %s', name, e && e.message); return undefined; }
  }
}
