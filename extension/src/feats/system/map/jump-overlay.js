/**
 * 快速镜头切换浮窗外壳（Shadow DOM，样式与游戏双向隔离）。照搬 feats/system/map/map-overlay.js 的范式：
 * .pcj- 前缀 CSS、毛玻璃 backdrop-filter、position:fixed、标题栏拖拽 + 右下角 resize + 几何落盘回调、
 * 冒泡阶段 stopPropagation 屏蔽游戏输入、z-index 2147483640。本层只负责视图与交互，
 * 坐标解析、游戏跳转、历史记录全在业务层（quick-jump.js），通过 handlers 回调面上报用户动作。
 *
 * 交互模型：顶部多行输入框（可粘贴一条或多条形如 `S4251 343,471` / `343,471@4251` 的坐标，行尾可带 `#文字说明` 备注），
 *   回车或点「跳转」→ 交业务层解析；业务层把解析结果 + 历史记录推回 renderItems 铺成可点击列表，
 *   点列表任意一行即再次飞镜头。
 *
 * handlers 回调面：
 *   onSubmit(text)              回车/点「跳转」（text 为输入框原始内容，可多行）
 *   onPick(item)                点记录列表某行（item={x,y,server,...}）
 *   onClearHistory()            点「清空记录」
 *   onSendShare(channelKey, items) 分享态下点「分享▾」（channelKey 为频道下拉当前选中项的 key：固定名 'world'/'alliance' 或数字 c 串）
 *   onDelete(items)             删除（单行传 [item]，多选态传选中集）
 *   onVisibleChange(visible)    显示（_afterShow 聚焦钩子已在前）/ 隐藏之后派发
 *   onGeomChange(geom)          拖拽/resize 松手后落盘
 *
 * 分享交互：每行尾有「分享」按钮（单条分享入口），点它进入分享态并预选该行；工具栏「多选」
 *   进入分享态显示每行 checkbox + 全选/取消全选（再点多选即退出，无独立取消按钮）。分享目的频道做成
 *   下拉（固定项由构造参数 channels 传入，活动/跨服动态项经 refreshChannels 更新）；「删除选中」在工具栏
 *   （仅分享态显、两步确认）；业务层发完调 exitShareMode() 退出；发送期间 setSharing(true) 锁按钮。
 */
import { createLog } from '../../../core/log.js';
import { esc as utilEsc } from '../../../core/util.js';
import { OverlayShell, clampGeom as overlayClamp } from '../../../core/overlay.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=JUMPOVERLAY） */
const log = createLog('JUMPOVERLAY');

/** @type {number} 最小宽/高（px） */
const MIN_W = 260;
const MIN_H = 240;
/** @type {number} 默认宽/高（px，小浮窗，比地图/聊天窗窄） */
const DEFAULT_W = 320;
const DEFAULT_H = 360;

/** @type {string} Shadow DOM 样式（深色毛玻璃，延续全局地图/聊天浮层风格） */
const CSS = `
  *{box-sizing:border-box;}
  .pcj-win{position:fixed;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;
    background:rgba(18,22,30,.8);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,.16);color:#e8eef7;
    font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
    box-shadow:0 10px 30px rgba(0,0,0,.5);z-index:2147483640;}
  .pcj-win[hidden]{display:none;}
  .pcj-titlebar{flex:0 0 auto;display:flex;align-items:center;cursor:move;user-select:none;touch-action:none;padding:6px 8px 4px;}
  .pcj-grip{opacity:.5;font-size:12px;letter-spacing:2px;margin-right:6px;}
  .pcj-title{font-size:12px;font-weight:600;color:#cfe8ff;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcj-srvbadge{flex:0 0 auto;margin-left:6px;font-size:11px;color:#ffd98a;background:rgba(255,200,80,.14);
    border:1px solid rgba(255,200,80,.3);border-radius:8px;padding:0 7px;white-space:nowrap;}
  .pcj-tspacer{flex:1 1 auto;}
  .pcj-close{border:none;background:transparent;color:#e8eef7;font:inherit;font-size:14px;cursor:pointer;padding:0 4px;opacity:.7;}
  .pcj-close:hover{opacity:1;}
  .pcj-inputwrap{flex:0 0 auto;padding:2px 8px 0;}
  .pcj-input{width:100%;min-height:52px;max-height:140px;resize:none;padding:5px 8px;border-radius:7px;
    border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;font-size:12px;
    line-height:1.4;overflow-y:auto;}
  .pcj-input::placeholder{color:#6b7a8d;}
  .pcj-hint{margin-top:3px;font-size:10px;color:#7d8ea3;line-height:1.35;}
  .pcj-bar{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:6px 8px;}
  .pcj-btn{border:1px solid rgba(255,255,255,.18);border-radius:6px;background:rgba(255,255,255,.06);
    color:#cdd8e6;font:inherit;font-size:12px;padding:3px 12px;cursor:pointer;white-space:nowrap;}
  .pcj-btn:hover{background:rgba(255,255,255,.14);}
  .pcj-btn.primary{background:rgba(70,140,255,.25);border-color:rgba(120,170,255,.45);color:#dbeaff;font-weight:600;}
  .pcj-btn.warn{background:rgba(224,70,59,.2);border-color:rgba(255,120,100,.4);}
  .pcj-btn[disabled]{opacity:.45;cursor:default;}
  .pcj-count{flex:1 1 auto;text-align:right;font-size:11px;color:#8b98a9;}
  .pcj-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 6px 6px;border-top:1px solid rgba(255,255,255,.08);}
  .pcj-row{display:flex;align-items:center;gap:6px;margin-top:5px;padding:5px 7px;border-radius:6px;cursor:pointer;
    background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);}
  .pcj-row:hover{background:rgba(70,140,255,.18);border-color:rgba(120,170,255,.4);}
  .pcj-row.on{background:rgba(70,140,255,.28);}
  .pcj-coord{flex:1 1 auto;min-width:0;font-size:12px;color:#dbe6f2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcj-loc{font-size:11px;color:#8fa3bb;margin-left:5px;}
  .pcj-k{flex:0 0 auto;font-size:10px;color:#ffd98a;background:rgba(255,200,80,.14);border:1px solid rgba(255,200,80,.28);
    border-radius:6px;padding:0 5px;white-space:nowrap;}
  .pcj-k.self{color:#8fd6a0;background:rgba(90,200,130,.12);border-color:rgba(120,220,150,.28);}
  .pcj-empty{padding:16px 8px;font-size:12px;color:#7d8ea3;text-align:center;}
  .pcj-toast{position:absolute;left:50%;top:46%;transform:translateX(-50%);max-width:86%;padding:5px 12px;
    border-radius:6px;background:rgba(8,10,14,.92);border:1px solid rgba(255,255,255,.2);color:#ffd0b8;
    font-size:12px;pointer-events:none;opacity:0;transition:opacity .2s;z-index:3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcj-toast.show{opacity:1;}
  .pcj-rz{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:2;touch-action:none;
    background:linear-gradient(315deg,transparent 50%,rgba(255,255,255,.35) 50%);border-radius:0 0 10px 0;}
  /* 每行分享控件：checkbox（仅分享态显）+ 分享按钮（仅普通态显） */
  .pcj-cb{display:none;width:15px;height:15px;flex:0 0 auto;cursor:pointer;margin:0;accent-color:#4a9fff;}
  .pcj-share{flex:0 0 auto;border:1px solid rgba(255,255,255,.18);border-radius:5px;background:rgba(255,255,255,.06);
    color:#cdd8e6;font:inherit;font-size:11px;padding:1px 8px;cursor:pointer;}
  .pcj-share:hover{background:rgba(70,140,255,.22);}
  .pcj-del{flex:0 0 auto;border:1px solid rgba(255,255,255,.14);border-radius:5px;background:transparent;
    color:#9fb0c2;font:inherit;font-size:12px;line-height:1;padding:2px 6px;cursor:pointer;}
  .pcj-del:hover{background:rgba(224,70,59,.24);color:#ffd8d2;border-color:rgba(255,120,100,.4);}
  .pcj-list.share-mode .pcj-del{display:none;}
  .pcj-btn.danger{background:rgba(224,70,59,.2);border-color:rgba(255,120,100,.4);color:#ffdad4;}
  .pcj-btn.danger:hover{background:rgba(224,70,59,.32);}
  /* 工具栏「删除选中」：仅分享态显（与清空记录同款两步确认防误删） */
  .act-del-sel{display:none;}
  .pcj-win.share-on .act-del-sel{display:inline-block;}
  .pcj-list.share-mode .pcj-cb{display:inline-block;}
  .pcj-list.share-mode .pcj-share{display:none;}
  .pcj-row.checked{background:rgba(70,140,255,.22);border-color:rgba(120,170,255,.45);}
  /* 分享页脚（仅分享态显）：已选计数 + 两个目的频道 + 取消 */
  .pcj-footer{flex:0 0 auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;
    border-top:1px solid rgba(255,255,255,.12);background:rgba(10,14,20,.5);}
  .pcj-footer[hidden]{display:none;}
  .pcj-selinfo{font-size:11px;color:#9fb6d4;}
  .pcj-fspacer{flex:1 1 auto;}
  .pcj-send{background:rgba(70,140,255,.22);border-color:rgba(120,170,255,.45);color:#dbeaff;}
  .pcj-send:hover{background:rgba(70,140,255,.35);}
  /* 目的频道下拉（原生 select 深色化；选项弹层为系统样式，不强行仿色） */
  .pcj-chsel{flex:0 0 auto;font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;max-width:132px;
    border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e8eef7;cursor:pointer;}
  .pcj-chsel[disabled]{opacity:.45;cursor:default;}
  .pcj-btn[disabled]{opacity:.45;cursor:default;}
`;

/**
 * HTML 转义（坐标等非可信文本入 innerHTML 前必过）
 * @param {*} s
 * @returns {string}
 */
function esc(s) {
  return utilEsc(s);
}

// 视口内几何钳制算法已上收 core/overlay.js（单一真相）；此处按本浮窗尺寸下限绑定为局部便捷名，保留 7 处既有调用点不变。
const clampGeom = (g) => overlayClamp(g, MIN_W, MIN_H);

export class JumpOverlay extends OverlayShell {
  /**
   * @param {object} handlers 回调面（见文件头注释）
   * @param {object} [opts] 选项：{channels?: Array<{key:string,label:string,fixed?:boolean}>} 分享频道下拉的固定项
   *   （由业务层给定；活动/跨服动态项用 refreshChannels 更新）
   */
  constructor(handlers, opts) {
    super(handlers, {
      geom: {
        x: Math.max(0, window.innerWidth - DEFAULT_W - 24),
        y: 48,
        w: DEFAULT_W,
        h: DEFAULT_H,
      },
      minW: MIN_W,
      minH: MIN_H,
      log,
      closeSel: '.pcj-close',
      barSel: '.pcj-titlebar',
    });
    /** @type {Array<{key:string,label:string,fixed?:boolean}>} 固定频道项（构造传入） */
    this._fixedChannels = (opts && Array.isArray(opts.channels) ? opts.channels : []).slice();
    /** @type {Array<{key:string,label:string}>} 动态频道项（refreshChannels 推入，排在固定项之后） */
    this._dynChannels = [];
    /** @type {Array<object>} 当前渲染的列表项（业务层推入，反查用） */
    this._items = [];
    /** @type {boolean} 分享态（true 时每行显 checkbox、隐藏单条分享按钮、底栏显页脚） */
    this._shareMode = false;
    /** @type {Set<number>} 分享态下选中行的索引（指向 this._items 下标） */
    this._selected = new Set();
    /** @type {boolean} 发送在飞（锁住频道按钮，防重入） */
    this._sharing = false;
    this._input = null;
    this._list = null;
    /** @type {?HTMLElement} 分享态底部页脚 */
    this._footer = null;
    /** @type {?Function} 工具栏「删除选中」两步确认的解除函数（exitShareMode/unmount 调用） */
    this._delSelDisarm = null;
    /** @type {?HTMLSelectElement} 分享目的频道下拉 */
    this._chSel = null;
    this._srvBadge = null;
    this._countEl = null;
  }

  /**
   * 挂载浮层（幂等）。建 Shadow DOM、接线交互。默认隐藏，由 Ctrl+G / 面板开关显示。
   * @returns {void}
   */
  mount() {
    if (this._host) return;
    const win = this._mountWindow({
      hostId: 'pocketcc-jump-host',
      css: CSS,
      winClass: 'pcj-win',
      innerHTML:
        `<div class="pcj-titlebar"><span class="pcj-grip">⠿</span><span class="pcj-title">镜头跳转</span>` +
        `<span class="pcj-srvbadge" hidden></span><span class="pcj-tspacer"></span>` +
        `<button class="pcj-close" title="关闭 (Ctrl+G)">✕</button></div>` +
        `<div class="pcj-inputwrap">` +
        `<textarea class="pcj-input" rows="2" spellcheck="false" placeholder="粘贴坐标，支持：S4251 343,471 / 343,471@4251 / 343:471 / 343,471（可多行，行尾可带 #备注）"></textarea>` +
        `<div class="pcj-hint">只给坐标默认跳本区；带区号（S4251 或 @4251）跨区跳转。行尾「#文字」为分享备注（缺省「坐标分享」）。回车跳转，Shift+回车换行。</div>` +
        `</div>` +
        `<div class="pcj-bar">` +
        `<button class="pcj-btn primary act-go">跳转</button>` +
        `<button class="pcj-btn act-share" title="进入多选态（勾选多条批量分享/删除）">多选</button>` +
        `<button class="pcj-btn danger act-del-sel" title="删除选中记录（两步确认）">删除选中</button>` +
        `<button class="pcj-btn warn act-clear">清空记录</button>` +
        `<span class="pcj-count"></span>` +
        `</div>` +
        `<div class="pcj-list"><div class="pcj-empty">暂无跳转记录</div></div>` +
        `<div class="pcj-footer" hidden>` +
        `<span class="pcj-selinfo">已选 0</span>` +
        `<button class="pcj-btn act-sel-all" title="选中全部记录">全选</button>` +
        `<button class="pcj-btn act-sel-none" title="取消全部选中">取消全选</button>` +
        `<span class="pcj-fspacer"></span>` +
        `<select class="pcj-chsel" title="分享目的频道"></select>` +
        `<button class="pcj-btn pcj-send" title="把选中坐标分享到下拉选中的频道">分享到</button>` +
        `</div>` +
        `<div class="pcj-toast"></div><div class="pcj-rz"></div>`,
    }).win;
    this._input = win.querySelector('.pcj-input');
    this._list = win.querySelector('.pcj-list');
    this._footer = win.querySelector('.pcj-footer');
    this._chSel = win.querySelector('.pcj-chsel');
    this._srvBadge = win.querySelector('.pcj-srvbadge');
    this._countEl = win.querySelector('.pcj-count');
    this._toast = win.querySelector('.pcj-toast');

    this._wireBlockGameEvents();
    this._wireHead();
    this._wireInput();
    this._wireActions();
    this._wireList();
    this._wireShare();
    this._wireResizeHandle();
    this._renderChannelSel();
    this._applyGeom();

    // 视口变化（窗口缩放/F11 全屏等）：右上锚定重摆，逻辑上收 core/overlay.js
    this._wireResizeAnchor();
    win.hidden = true;
  }

  /** 显示后聚焦输入框并全选，便于「按下热键就粘贴」（覆写基类钩子；show/hide/toggle/isVisible 均在基类）。 */
  _afterShow() {
    try {
      this._input.focus();
      this._input.select();
    } catch (e) {}
  }

  /**
   * 区号徽标（本服服号，供「只给坐标跳本区」时的参照）：k=0/空时隐藏。
   * @param {number} k 本服服号
   */
  setSelfServer(k) {
    if (!this._srvBadge) return;
    if (!k) {
      this._srvBadge.hidden = true;
      return;
    }
    this._srvBadge.hidden = false;
    this._srvBadge.textContent = '本服 ' + k;
  }

  /** @returns {string} 输入框当前内容 */
  getInput() {
    return this._input ? this._input.value : '';
  }

  /** 清空输入框 */
  clearInput() {
    if (this._input) this._input.value = '';
  }

  /**
   * 渲染跳转记录列表（业务层推入；新→旧）。每行点击 → onPick(item)。
   * @param {Array<{x:number,y:number,server:?number,selfServer?:number,note?:string}>} items
   */
  renderItems(items) {
    if (!this._list) return;
    this._items = Array.isArray(items) ? items : [];
    if (this._countEl)
      this._countEl.textContent = this._items.length ? '共 ' + this._items.length + ' 条' : '';
    if (!this._items.length) {
      this._list.innerHTML = '<div class="pcj-empty">暂无跳转记录</div>';
      return;
    }
    this._list.innerHTML = this._items
      .map((it, n) => {
        const cross = it.server != null && it.selfServer != null && it.server !== it.selfServer;
        const kTag =
          it.server != null
            ? `<span class="pcj-k${cross ? '' : ' self'}" title="${cross ? '跨区目标' : '本区'}">区 ${esc(it.server)}</span>`
            : `<span class="pcj-k self" title="跳本区">本区</span>`;
        const sel = this._selected.has(n);
        return (
          `<div class="pcj-row${sel ? ' checked' : ''}" data-n="${n}">` +
          `<input class="pcj-cb" type="checkbox" data-n="${n}"${sel ? ' checked' : ''}>` +
          `<span class="pcj-coord">(${esc(it.x)},${esc(it.y)})${it.note ? '<span class="pcj-loc">' + esc(it.note) + '</span>' : ''}</span>` +
          kTag +
          `<button class="pcj-share" data-n="${n}" title="分享此坐标到频道">分享</button>` +
          `<button class="pcj-del" data-n="${n}" title="删除此记录">✕</button>` +
          `</div>`
        );
      })
      .join('');
  }

  /** 高亮某行为「当前已跳转」（按 x,y,server 匹配），给用户跳转落点的即时反馈。 */
  markActive(x, y, server) {
    if (!this._list) return;
    const rows = this._list.querySelectorAll('.pcj-row');
    for (let i = 0; i < rows.length; i++) {
      const it = this._items[i];
      const on =
        it && it.x === x && it.y === y && (it.server == null ? null : it.server) === server;
      rows[i].classList.toggle('on', !!on);
    }
  }

  // setGeom/getGeom/toast 已上收基类 OverlayShell（本浮窗无 setGeom 私货，故不覆写 _afterGeom）。

  /** 释放本浮窗私货：两步确认「删除选中」的解除器（公共定时器/监听/host 由基类 unmount 收尾）。 */
  _teardownExtras() {
    if (this._delSelDisarm) {
      this._delSelDisarm();
      this._delSelDisarm = null;
    }
  }

  // ─────────────────────── 内部接线 ───────────────────────

  // _applyGeom / _wireBlockGameEvents / _wireHead 已上收基类 OverlayShell（closeSel/barSel 经构造注入）。

  /** 输入框：回车提交（Shift+回车换行） */
  _wireInput() {
    if (!this._input) return;
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._notify('onSubmit', this._input.value);
      }
    });
  }

  /** 工具按钮：跳转 / 清空记录 */
  _wireActions() {
    this._win.querySelector('.act-go').addEventListener('click', () => {
      this._notify('onSubmit', this.getInput());
    });
    const clr = this._win.querySelector('.act-clear');
    // 两步确认（首次点击变「确认清空?」，3s 内再点才真正触发），避免误删历史记录
    let armed = false,
      timer = null;
    const disarm = () => {
      armed = false;
      clr.textContent = '清空记录';
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    clr.addEventListener('click', () => {
      if (!this._items.length) {
        this.toast('暂无跳转记录');
        return;
      }
      if (!armed) {
        armed = true;
        clr.textContent = '确认清空?';
        timer = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      this._notify('onClearHistory');
    });
    // 「删除选中」（工具栏、仅分享态显）：与清空记录同款两步确认（首次点变「确认删除?」，3s 内再点才删），防误删
    const delSel = this._win.querySelector('.act-del-sel');
    let delArmed = false,
      delTimer = null;
    const delDisarm = () => {
      delArmed = false;
      delSel.textContent = '删除选中';
      if (delTimer) {
        clearTimeout(delTimer);
        delTimer = null;
      }
    };
    this._delSelDisarm = delDisarm;
    delSel.addEventListener('click', () => {
      if (this._sharing) return;
      const items = this.getSelectedItems();
      if (!items.length) {
        this.toast('未选择要删除的记录');
        return;
      }
      if (!delArmed) {
        delArmed = true;
        delSel.textContent = '确认删除?';
        delTimer = setTimeout(delDisarm, 3000);
        return;
      }
      delDisarm();
      this._notify('onDelete', items);
    });
  }

  /**
   * 记录列表行点击（委托）：
   *   普通态：点行 → onPick(item)；点行尾「分享」按钮 → 进入分享态并预选该行（单条分享快捷）。
   *   分享态：点行任意位置切换该行勾选（checkbox 本体走 change 事件）。
   */
  _wireList() {
    if (!this._list) return;
    this._list.addEventListener('click', (e) => {
      const shareBtn = e.target.closest('.pcj-share');
      if (shareBtn) {
        e.stopPropagation();
        this.enterShareMode(+shareBtn.dataset.n);
        return;
      }
      const delBtn = e.target.closest('.pcj-del');
      if (delBtn) {
        e.stopPropagation();
        const dit = this._items && this._items[+delBtn.dataset.n];
        if (dit) this._notify('onDelete', [dit]);
        return;
      }
      if (e.target.closest('.pcj-cb')) return; // 勾选由 change 事件处理
      const el = e.target.closest('.pcj-row');
      if (!el) return;
      const n = +el.dataset.n;
      if (this._shareMode) {
        if (this._selected.has(n)) this._selected.delete(n);
        else this._selected.add(n);
        this._syncRowChecked();
        return;
      }
      const it = this._items && this._items[n];
      if (!it) return;
      this._notify('onPick', it);
    });
    // 直接点 checkbox 本体
    this._list.addEventListener('change', (e) => {
      const cb = e.target.closest('.pcj-cb');
      if (!cb) return;
      const n = +cb.dataset.n;
      if (cb.checked) this._selected.add(n);
      else this._selected.delete(n);
      this._syncRowChecked();
    });
  }

  /** 分享接线：多选开关（兼退出）、全选/取消全选、页脚发送 */
  _wireShare() {
    this._win.querySelector('.act-share').addEventListener('click', () => {
      if (this._sharing) return;
      if (this._shareMode) this.exitShareMode();
      else if (!this._items.length) this.toast('暂无可分享的记录');
      else this.enterShareMode();
    });
    this._win.querySelector('.act-sel-all').addEventListener('click', () => {
      this._setAllSelected(true);
    });
    this._win.querySelector('.act-sel-none').addEventListener('click', () => {
      this._setAllSelected(false);
    });
    // 单一发送按钮：目的频道取下拉当前选中项（支持未来扩展到跨服/活动等动态频道）
    const sendBtn = this._win.querySelector('.pcj-send');
    sendBtn.addEventListener('click', () => {
      if (this._sharing) return;
      const chKey = this._chSel && this._chSel.value;
      if (!chKey) {
        this.toast('请先选择目的频道');
        return;
      }
      const items = this.getSelectedItems();
      if (!items.length) {
        this.toast('未选择要分享的坐标');
        return;
      }
      this._notify('onSendShare', chKey, items);
    });
  }

  /**
   * 重建频道下拉选项（固定项在前、动态项在后）；尽量保留当前选中项。
   * 由 mount 与 refreshChannels 调用。
   */
  _renderChannelSel() {
    if (!this._chSel) return;
    const prev = this._chSel.value;
    const all = this._fixedChannels.concat(this._dynChannels);
    this._chSel.innerHTML = all
      .map((ch) => `<option value="${esc(ch.key)}">${esc(ch.label)}</option>`)
      .join('');
    if (prev && all.some((ch) => ch.key === prev)) this._chSel.value = prev;
  }

  /**
   * 业务层推入动态频道项（跨服/盟决/无双等活动房间），追加在固定项之后。
   * @param {Array<{key:string,label:string}>} channels 频道项（key 为发送参数标识，见业务层映射）
   */
  refreshChannels(channels) {
    this._dynChannels = Array.isArray(channels) ? channels.slice() : [];
    this._renderChannelSel();
  }

  /**
   * 进入分享态。show 行 checkbox + 底部页脚。
   * @param {?number} [presetN] 预选行下标（单条分享入口传入，仅选该行）
   */
  enterShareMode(presetN) {
    if (!this._list) return;
    this._shareMode = true;
    this._selected = new Set();
    if (presetN != null && this._items[presetN]) this._selected.add(presetN);
    this._list.classList.add('share-mode');
    if (this._win) this._win.classList.add('share-on'); // 驱动工具栏「删除选中」显隐
    if (this._footer) this._footer.hidden = false;
    this._syncRowChecked();
  }

  /**
   * 全选/取消全选所有行（仅分享态、非发送中生效）。
   * @param {boolean} on true=选中全部，false=清空
   */
  _setAllSelected(on) {
    if (!this._shareMode || this._sharing) return;
    this._selected = new Set();
    if (on) for (let i = 0; i < this._items.length; i++) this._selected.add(i);
    this._syncRowChecked();
  }

  /** 退出分享态（业务层发送完毕也走此收口）。 */
  exitShareMode() {
    this._shareMode = false;
    this._selected = new Set();
    if (this._delSelDisarm) this._delSelDisarm(); // 复位「确认删除?」两步确认态
    if (this._list) {
      this._list.classList.remove('share-mode');
      const rows = this._list.querySelectorAll('.pcj-row');
      for (let i = 0; i < rows.length; i++) {
        rows[i].classList.remove('checked');
        const c = rows[i].querySelector('.pcj-cb');
        if (c) c.checked = false;
      }
    }
    if (this._win) this._win.classList.remove('share-on');
    if (this._footer) this._footer.hidden = true;
  }

  /**
   * 发送在飞状态（锁频道/取消按钮，防重入）。由业务层包围发送。
   * @param {boolean} on 是否在飞
   */
  setSharing(on) {
    this._sharing = !!on;
    this._syncSendBtns();
  }

  /** @returns {Array<object>} 分享态下选中的列表项（按列表显示顺序，指向 this._items） */
  getSelectedItems() {
    // _selected 是 Set，forEach 给插入序；用户点选顺序≠显示序 → 按行号升序排，保证逐条发送顺序与列表一致
    const idx = Array.from(this._selected).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < idx.length; i++) {
      if (this._items[idx[i]]) out.push(this._items[idx[i]]);
    }
    return out;
  }

  /** 同步选中行的高亮与页脚计数 */
  _syncRowChecked() {
    if (!this._list) return;
    const rows = this._list.querySelectorAll('.pcj-row');
    for (let i = 0; i < rows.length; i++) {
      const n = +rows[i].dataset.n;
      const on = this._selected.has(n);
      rows[i].classList.toggle('checked', on);
      const c = rows[i].querySelector('.pcj-cb');
      if (c) c.checked = on;
    }
    const info = this._win.querySelector('.pcj-selinfo');
    if (info) info.textContent = '已选 ' + this._selected.size;
  }

  /** 同步发送中锁态（禁用下拉/分享到/全选/取消全选/删除选中按钮） */
  _syncSendBtns() {
    if (!this._win) return;
    const sels = this._win.querySelectorAll(
      '.pcj-send, .act-del-sel, .act-sel-all, .act-sel-none, .pcj-chsel',
    );
    for (let i = 0; i < sels.length; i++) sels[i].disabled = this._sharing;
  }

  /** 右下角 resize 把手 */
  _wireResizeHandle() {
    const hd = this._win.querySelector('.pcj-rz');
    if (!hd) return;
    let rs = null;
    hd.addEventListener('pointerdown', (e) => {
      rs = { sx: e.clientX, sy: e.clientY, ow: this._geom.w, oh: this._geom.h };
      hd.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    hd.addEventListener('pointermove', (e) => {
      if (!rs) return;
      const w = Math.max(MIN_W, rs.ow + (e.clientX - rs.sx));
      const h = Math.max(MIN_H, rs.oh + (e.clientY - rs.sy));
      this._geom = clampGeom({ x: this._geom.x, y: this._geom.y, w, h });
      this._applyGeom();
    });
    const end = (e) => {
      if (!rs) return;
      rs = null;
      try {
        hd.releasePointerCapture(e.pointerId);
      } catch (err) {}
      this._notify('onGeomChange', this.getGeom());
    };
    hd.addEventListener('pointerup', end);
    hd.addEventListener('pointercancel', end);
  }

  // _notify（回调派发）已上收基类 OverlayShell。
}
