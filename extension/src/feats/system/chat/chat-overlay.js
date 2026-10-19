/**
 * 聊天浮层 UI（Ctrl+K 开关的半透明窗口，Shadow DOM 与游戏样式双向隔离）。
 * 纯视图层：缓冲、协议、历史拉取全在 chat-window.js；本模块只负责渲染与交互，
 * 通过 handlers 回调面把用户动作上报给业务层。风格延续 core/ui.js 的深色毛玻璃，无装饰动效。
 *
 * 消息条目 entry（由 chat-window 预处理好，overlay 不再懂协议）：
 *   { id, timeStr, name, self:boolean, mention:boolean, pmDir:string|null('-> 听白'等，拼进 name 后),
 *     segments: [{type:'text'|'at'|'chip', s:string, copy?:string, action?:object}]
 *             （at=高亮 @片段、chip=链接占位；带 action=可跳转卡片点击走 onJump，否则点击复制 copy）,
 *     quote: {name, msg, id}|null }
 *
 * handlers 回调面：
 *   onSend(text, atList, quoteEntry) -> Promise<boolean>   回车/点发送；resolve true 才清输入框并起冷却
 *   onSharePos(x, y)                                        输入框为 "x,y" 时点分享坐标
 *   onRequestAtList()                                       点 @ 按钮（业务层准备候选后回调 openAtPicker）
 *   onChannelSelect(key)                                    点频道 chip / 更多菜单项
 *   onSideSelect(key)                                       点左侧会话列表项（私聊/跨服家族视图）
 *   onLoadOlder()                                           消息区滚动到顶
 *   onQuote(entry)                                          双击某条消息 / 右键菜单「引用」进入引用态
 *   onRevoke(entry)                                         右键菜单「撤回」（仅自己消息；时限/协议在业务层）
 *   onNamePm(entry)                                         名字菜单→发起私聊（好友或判不出好友时展示）
 *   onNameAddFriend(entry)                                  名字菜单→加好友（确非好友或判不出时展示）
 *   onNameInfo(entry)                                       名字菜单→查看信息（业务层取好后调 showInfoPop）
 *   onJump(action, entry)                                   点可跳转链接卡（坐标/行军，业务层调地图执行器）
 *   onCheckFriend(entry) -> true|false|null                 名字菜单打开时同步询问好友关系（null=判不出，两项并列）
 *   onVisibleChange(visible)                                show/hide 之后
 *   onGeomChange(geom)                                      拖拽/resize 松手后落盘
 */
import { createLog } from '../../../core/log.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CHATWIN） */
const log = createLog('CHATWIN');

/** @type {number} 浮层最小宽度（px） */
const MIN_W = 300;
/** @type {number} 浮层最小高度（px） */
const MIN_H = 220;
/** @type {number} 默认宽度（px） */
const DEFAULT_W = 380;
/** @type {number} 默认高度（px） */
const DEFAULT_H = 480;
/** @type {string} 「全体成员」在输入框里的展示文本（业务层负责替换为协议常量） */
export const AT_ALL_LABEL = '全体成员';

/**
 * Shadow DOM 内样式：.pcw- 前缀，全部规则与游戏隔离
 * @type {string}
 */
const CSS = `
  *{box-sizing:border-box;}
  .pcw-win{position:fixed;display:flex;flex-direction:column;overflow:hidden;
    border-radius:10px;background:rgba(18,22,30,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,.16);color:#e8eef7;
    font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
    box-shadow:0 10px 36px rgba(0,0,0,.55);z-index:2147483640;}
  .pcw-win[hidden]{display:none;}
  /* 顶栏：第一行标题（拖拽区）+关闭，第二行频道 chips + 更多 */
  .pcw-head{flex:0 0 auto;padding:6px 8px 0;}
  .pcw-titlebar{display:flex;align-items:center;cursor:move;user-select:none;touch-action:none;}
  .pcw-grip{opacity:.5;font-size:12px;letter-spacing:2px;margin-right:6px;}
  .pcw-title{font-size:12px;font-weight:600;color:#cfe8ff;flex:1;min-width:0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcw-close{border:none;background:transparent;color:#e8eef7;font:inherit;font-size:14px;
    cursor:pointer;padding:0 4px;opacity:.7;}
  .pcw-close:hover{opacity:1;}
  .pcw-chips{display:flex;align-items:center;gap:4px;margin-top:2px;
    overflow-x:auto;scrollbar-width:none;padding:8px 0 6px;}
  .pcw-chips::-webkit-scrollbar{display:none;}
  .pcw-chip{position:relative;flex:0 0 auto;border:1px solid rgba(255,255,255,.16);border-radius:12px;
    background:transparent;color:#cdd8e6;font:inherit;font-size:12px;padding:2px 10px;cursor:pointer;
    white-space:nowrap;}
  .pcw-chip:hover{background:rgba(255,255,255,.08);}
  .pcw-chip.active{background:rgba(70,140,255,.28);border-color:rgba(120,170,255,.5);color:#fff;font-weight:600;}
  .pcw-badge{position:absolute;top:-6px;right:-4px;min-width:15px;height:15px;line-height:15px;
    padding:0 3px;border-radius:8px;background:#e0463b;color:#fff;font-size:10px;font-weight:600;text-align:center;}
  /* 主体：左会话列表（微信 PC 风，仅私聊/跨服家族视图时显）+ 可拖分隔条 + 右聊天列 */
  .pcw-body{flex:1 1 auto;min-height:0;display:flex;}
  .pcw-side{flex:0 0 auto;width:170px;min-height:0;overflow-y:auto;
    padding:4px;display:none;scrollbar-width:thin;}
  .pcw-side.show{display:block;}
  .pcw-sdrag{flex:0 0 5px;cursor:col-resize;touch-action:none;display:none;
    background:rgba(255,255,255,.1);}
  .pcw-sdrag.show{display:block;}
  .pcw-sdrag:hover{background:rgba(120,170,255,.45);}
  .pcw-side::-webkit-scrollbar{width:5px;}
  .pcw-side::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px;}
  .pcw-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;position:relative;}
  .pcw-loadtip{flex:0 0 auto;text-align:center;font-size:11px;color:#8b98a9;padding:5px 0;letter-spacing:.5px;}
  .pcw-newmsg{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:6;background:rgba(30,40,55,.94);color:#cfe3ff;border:1px solid rgba(120,160,220,.42);border-radius:14px;padding:4px 12px;font-size:12px;line-height:1.4;font-family:inherit;outline:none;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap;}
  .pcw-newmsg:hover{background:rgba(48,64,86,.96);}
  .pcw-conv{position:relative;padding:5px 6px;border-radius:6px;cursor:pointer;margin:1px 0;display:flex;align-items:center;gap:7px;}
  .pcw-convtc{flex:1 1 auto;min-width:0;}
  .pcw-convav{flex:0 0 auto;cursor:pointer;}
  .pcw-convav .pcw-avimg,.pcw-convav .pcw-avph{width:34px;height:34px;font-size:15px;border-radius:7px;}
  .pcw-conv:hover{background:rgba(255,255,255,.07);}
  .pcw-conv.active{background:rgba(70,140,255,.24);}
  .pcw-convt{font-size:12px;font-weight:600;color:#dbe6f3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcw-convs{font-size:11px;color:#8b98a9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcw-convb{position:absolute;top:2px;right:3px;min-width:15px;height:15px;line-height:15px;
    padding:0 3px;border-radius:8px;background:#e0463b;color:#fff;font-size:10px;font-weight:600;text-align:center;}
  /* 消息区（游戏页面的 user-select:none 会继承进 shadow，需显式放开文本选择） */
  .pcw-msgs{flex:1 1 auto;min-height:0;overflow-y:auto;padding:2px 8px;scrollbar-gutter:stable;
    user-select:text;-webkit-user-select:text;}
  .pcw-msgs::-webkit-scrollbar{width:7px;}
  .pcw-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:4px;}
  .pcw-row{padding:2px 4px;border-radius:5px;margin:1px 0;overflow-wrap:break-word;line-height:1.6;}
  .pcw-row:hover{background:rgba(255,255,255,.05);}
  .pcw-row.mention{background:rgba(255,190,60,.12);border-left:2px solid rgba(255,190,60,.7);}
  .pcw-time{color:#8b98a9;font-size:11px;margin-right:5px;font-variant-numeric:tabular-nums;}
  .pcw-name{color:#7fd08a;font-weight:600;}
  .pcw-name.self{color:#9ecbff;}
  .pcw-name.other{cursor:pointer;}
  .pcw-name.other:hover{color:#a9e7b4;}
  .pcw-at{color:#ffd77a;font-weight:600;}
  .pcw-chiplink{display:inline;color:#7fc4ff;border-bottom:1px dashed rgba(127,196,255,.45);cursor:pointer;}
  .pcw-chiplink:hover{color:#b4dcff;}
    .pcw-chiplink.jump{color:#7fe0a8;border-bottom-color:rgba(127,224,168,.5);font-weight:600;}
    .pcw-chiplink.jump:hover{color:#b6f2ce;}
  .pcw-quote{margin:1px 0 1px 12px;padding:2px 6px;border-left:2px solid rgba(255,255,255,.28);
    background:rgba(255,255,255,.05);color:#a9b6c6;font-size:12px;cursor:pointer;border-radius:0 4px 4px 0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:95%;}
  .pcw-quote:hover{color:#d3deea;}
  .pcw-empty{color:#7c8896;text-align:center;padding:16px 0;font-size:12px;}
  /* 引用条 + 输入区 */
  .pcw-qbar{flex:0 0 auto;display:flex;align-items:center;gap:6px;margin:0 8px;padding:3px 8px;
    border-radius:6px;background:rgba(255,255,255,.07);border-left:2px solid rgba(127,196,255,.6);
    font-size:12px;color:#a9b6c6;}
  .pcw-qbar[hidden]{display:none;}
  .pcw-qtext{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcw-qx{border:none;background:transparent;color:#a9b6c6;font:inherit;cursor:pointer;padding:0 2px;}
  .pcw-inputrow{flex:0 0 auto;display:flex;gap:6px;padding:6px 8px 4px;align-items:flex-end;}
  .pcw-input{flex:1;min-width:0;padding:5px 8px;border-radius:6px;font:inherit;color:#e8eef7;
    border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.35);
    resize:none;line-height:1.5;max-height:120px;overflow:hidden;}
  .pcw-input:focus{outline:none;border-color:rgba(120,170,255,.65);}
  .pcw-tool{flex:0 0 auto;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:rgba(255,255,255,.06);
    color:#cdd8e6;font:inherit;font-size:12px;padding:5px 8px;cursor:pointer;white-space:nowrap;}
  .pcw-tool:hover{background:rgba(255,255,255,.14);}
  .pcw-tool[disabled]{opacity:.45;cursor:default;}
  .pcw-tool.send{background:rgba(70,140,255,.25);border-color:rgba(120,170,255,.45);color:#dbeaff;font-weight:600;}
  /* 浮层：@选人 / 更多菜单 / toast */
  .pcw-pop{position:absolute;left:8px;right:8px;bottom:64px;max-height:180px;overflow-y:auto;
    border-radius:8px;background:rgba(14,18,26,.96);border:1px solid rgba(255,255,255,.18);
    box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:2;padding:4px;}
  .pcw-pop[hidden]{display:none;}
  .pcw-pop.atpop{max-height:300px;}
  .pcw-popitem{display:block;width:100%;text-align:left;border:none;background:transparent;color:#e8eef7;
    font:inherit;font-size:12px;padding:5px 8px;border-radius:5px;cursor:pointer;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcw-popitem:hover{background:rgba(70,140,255,.22);}
  .pcw-atuid{color:#9fd0ff;font-size:11px;margin-left:4px;cursor:pointer;}
  .pcw-atuid::after{content:' ⧉';opacity:.7;}
  .pcw-atuid:hover{color:#cfe6ff;}
  .pcw-popfilter{display:block;width:100%;box-sizing:border-box;margin:0 0 4px;padding:4px 8px;
    border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.35);
    color:#e8eef7;font:inherit;font-size:12px;}
  .pcw-popfilter:focus{outline:none;border-color:rgba(120,170,255,.65);}
  .pcw-morepop{bottom:auto;top:34px;}
  .pcw-namepop{left:auto;top:auto;right:auto;bottom:auto;width:max-content;
    min-width:130px;max-width:220px;max-height:none;overflow:visible;}
  .pcw-infopop{left:auto;top:auto;right:auto;bottom:auto;min-width:170px;max-width:250px;
    max-height:240px;overflow-y:auto;padding:8px 10px;}
  .pcw-infotitle{font-size:13px;font-weight:600;color:#cfe0ff;margin:0 0 5px;word-break:break-all;}
  .pcw-inforow{font-size:12px;color:#d6dde8;line-height:1.75;word-break:break-all;
      /* 游戏页的 user-select:none 会继承进 shadow，信息行显式放开供手动选中 */
      user-select:text;-webkit-user-select:text;}
  .pcw-jumplink{color:#7fe0a8;font-weight:600;cursor:pointer;border-bottom:1px dashed rgba(127,224,168,.5);}
  .pcw-jumplink:hover{color:#b6f2ce;}
  .pcw-copylink{color:#9fd0ff;font-weight:600;cursor:pointer;border-bottom:1px dashed rgba(159,208,255,.5);}
  .pcw-copylink:hover{color:#cfe6ff;}
  .pcw-copylink::after{content:' ⧉';font-weight:400;opacity:.7;}
  .pcw-avimg,.pcw-avph{border-radius:8px;object-fit:cover;flex:0 0 auto;}
  .pcw-avph{background:hsl(var(--h,210),45%,38%);color:#fff;font-weight:600;display:grid;place-items:center;}
  .pcw-popav{display:flex;align-items:center;gap:9px;margin:0 0 7px;}
  .pcw-popav .pcw-avimg,.pcw-popav .pcw-avph{width:52px;height:52px;font-size:22px;}
  .pcw-popav .pcw-infotitle{margin:0;}
  .pcw-toast{position:absolute;left:50%;top:44%;transform:translateX(-50%);max-width:86%;
    padding:5px 12px;border-radius:6px;background:rgba(8,10,14,.92);border:1px solid rgba(255,255,255,.2);
    color:#ffd0b8;font-size:12px;pointer-events:none;opacity:0;transition:opacity .2s;z-index:3;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .pcw-toast.show{opacity:1;}
  /* resize 把手：左边、右边、底边、左下、右下（上边/上角与标题栏拖拽语义冲突，不提供） */
  .pcw-rz{position:absolute;z-index:2;touch-action:none;}
  .pcw-rz[data-dir="l"]{left:0;top:8px;bottom:8px;width:5px;cursor:ew-resize;}
  .pcw-rz[data-dir="r"]{right:0;top:8px;bottom:8px;width:5px;cursor:ew-resize;}
  .pcw-rz[data-dir="b"]{bottom:0;left:22px;right:22px;height:5px;cursor:ns-resize;}
  .pcw-rz[data-dir="bl"]{left:0;bottom:0;width:16px;height:16px;cursor:nesw-resize;
    background:linear-gradient(45deg,transparent 50%,rgba(255,255,255,.35) 50%);
    border-radius:0 0 0 10px;}
  .pcw-resize{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;
    background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.35) 50%);
    border-radius:0 0 10px 0;}
`;

/**
 * HTML 转义（消息文本等不可信内容一律走这里）
 * @param {string} s 原文
 * @returns {string}
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 头像描述子→内层 HTML：有 URL 出 <img>（尺寸/圆角由父容器 CSS 决定），无则首字母色块占位。
 * @param {{url?:string, initial?:string, hue?:number}|null} av 头像描述子
 * @returns {string}
 */
function avInner(av) {
  if (av && av.url) {
    return `<img class="pcw-avimg" src="${esc(av.url)}" data-avph="${esc(av.initial || '?')}" style="--h:${av.hue | 0}" alt="">`;
  }
  return `<div class="pcw-avph" style="--h:${av ? av.hue | 0 : 210}">${esc((av && av.initial) || '?')}</div>`;
}

/**
 * 给作用域内头像 <img> 绑 onerror：加载失败（CDN 拦截/防盗链/过期）即换为同款首字母占位。
 * @param {ParentNode} scope 已写入 innerHTML 的容器
 * @returns {void}
 */
function bindAvFallback(scope) {
  scope.querySelectorAll('.pcw-avimg').forEach((el) => {
    el.addEventListener('error', () => {
      const d = document.createElement('div');
      d.className = 'pcw-avph';
      d.style.setProperty('--h', el.style.getPropertyValue('--h') || '210');
      d.textContent = el.getAttribute('data-avph') || '?';
      el.replaceWith(d);
    });
  });
}

/**
 * 钳制几何到视口（宽松版）：宽高钳到 [min, 视口]；坐标只保证露出 60×40px（标题栏可拖可点），
 * 不要求整窗可见——浏览器缩小时保持与窗口左/上的边距不变，拖拽也不被「整窗入视口」卡住
 * @param {{x:number,y:number,w:number,h:number}} g 原始几何
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function clampGeom(g) {
  const w = Math.max(MIN_W, Math.min(g.w, window.innerWidth));
  const h = Math.max(MIN_H, Math.min(g.h, window.innerHeight));
  return {
    w,
    h,
    x: Math.max(0, Math.min(g.x, window.innerWidth - Math.min(w, 60))),
    y: Math.max(0, Math.min(g.y, window.innerHeight - Math.min(h, 40))),
  };
}

/**
 * 聊天浮层视图。生命周期由 chat-window 驱动：mount → set* / render* → unmount。
 */
export class ChatOverlay {
  /**
   * @param {object} handlers 回调面（见文件头注释）
   */
  constructor(handlers) {
    this.#h = handlers || {};
    /** @type {{x:number,y:number,w:number,h:number}} 窗口几何（位置+尺寸） */
    this.#geom = clampGeom({
      x: window.innerWidth - DEFAULT_W - 60,
      y: 80,
      w: DEFAULT_W,
      h: DEFAULT_H,
    });
    /** @type {Array<{uid:string, name:string, all?:boolean}>} 本次待发的 @ 列表（发送时交业务层编码） */
    this.#atList = [];
    /** @type {number|null} 冷却倒计时剩余秒 */
    this.#cooldownLeft = 0;
    /** @type {number|null} 冷却计时器句柄 */
    this.#cooldownTimer = null;
    /** @type {number|null} toast 隐藏定时器 */
    this.#toastTimer = null;
    /** @type {boolean} 消息区是否贴底（滚到最底时清「新消息」浮标） */
    this.#pinned = true;
    /** @type {number} 未读新消息计数（他人新消息不自动滚动，底部浮标提示） */
    this.#newMsgCount = 0;
    /** @type {boolean} 滚动到顶翻页的闸门（防惯性连触） */
    this.#topGate = false;
  }

  #h;
  #geom;
  #atList;
  #cooldownLeft;
  #cooldownTimer;
  #toastTimer;
  #pinned;
  #topGate;
  #newMsgCount;
  /** @type {HTMLElement|null} host 容器 */ #host = null;
  /** @type {ShadowRoot|null} shadow 根 */ #root = null;
  /** @type {HTMLElement|null} 窗口主体 */ #win = null;
  /** @type {HTMLElement|null} 「N 条新消息」浮标（他人新消息不自动滚，点击跳最新） */ #newMsgPill =
    null;
  /** @type {HTMLElement|null} 左侧会话列表（私聊/跨服家族视图） */ #side = null;
  /** @type {HTMLElement|null} 侧栏宽度拖拽把手 */ #sdrag = null;
  /** @type {number} 侧栏当前宽度（px，随几何存档持久） */ #sideW = 170;
  /** @type {HTMLElement|null} 标题栏文本 */ #titleEl = null;
  /** @type {HTMLElement|null} 频道 chip 行 */ #chips = null;
  /** @type {HTMLElement|null} 消息滚动区 */ #msgs = null;
  /** @type {HTMLElement|null} 顶部历史加载状态条 */ #loadTip = null;
  /** @type {HTMLElement|null} 引用条 */ #qbar = null;
  /** @type {HTMLElement|null} 输入框 */ #input = null;
  /** @type {HTMLElement|null} 发送按钮 */ #sendBtn = null;
  /** @type {HTMLElement|null} @ 选人浮层 */ #atPop = null;
  /** @type {HTMLElement|null} 更多频道浮层 */ #morePop = null;
  /** @type {HTMLElement|null} 名字操作菜单浮层 */ #namePop = null;
  /** @type {HTMLElement|null} 玩家信息卡浮层 */ #infoPop = null;
  /** @type {HTMLElement|null} 消息右键菜单浮层（引用/撤回） */ #msgPop = null;
  /** @type {{x:number, y:number}} 名字菜单最近一次弹出点（win 坐标，信息卡沿用） */ #menuPos = {
    x: 8,
    y: 8,
  };
  /** @type {Array<{uid:string, name:string, all?:boolean}>} @ 候选全量（过滤框按子串筛） */ #atCands =
    [];
  /** @type {boolean} @ 候选是否置顶全体成员 */ #atAllowAll = false;
  /** @type {string} @ 候选过滤词 */ #atFilter = '';
  /** @type {HTMLElement|null} toast */ #toast = null;
  /** @type {object|null} 当前引用条目 */ #quote = null;
  /** @type {string} 当前激活频道 key（chip 高亮用） */ #activeKey = '';
  /** @type {Map<string, number>} 未读角标 key->count */ #unread = new Map();
  /** @type {Array<{key:string,label:string}>} 快捷频道定义缓存 */ #quickDefs = [];
  /** @type {Array<{key:string,label:string}>} 更多菜单定义缓存 */ #moreDefs = [];

  /**
   * 挂载浮层（幂等）。事件在 win 上冒泡阶段 stopPropagation，防止误触游戏画布；
   * Ctrl+K 由业务层的 window 捕获监听控制，不受此处影响。
   * @returns {void}
   */
  mount() {
    if (this.#host) return;
    const host = document.createElement('div');
    host.id = 'pocketcc-chat-host';
    host.style.cssText = 'all:initial;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const win = document.createElement('div');
    win.className = 'pcw-win';
    win.innerHTML =
      `<div class="pcw-head">` +
      `<div class="pcw-titlebar"><span class="pcw-grip">⠿</span><span class="pcw-title">聊天</span>` +
      `<button class="pcw-close" title="关闭 (Ctrl+K)">✕</button></div>` +
      `<div class="pcw-chips"></div></div>` +
      `<div class="pcw-body">` +
      `<div class="pcw-side"></div>` +
      `<div class="pcw-sdrag"></div>` +
      `<div class="pcw-main">` +
      `<div class="pcw-loadtip" hidden></div>` +
      `<div class="pcw-msgs"></div>` +
      `<button class="pcw-newmsg" type="button" hidden></button>` +
      `<div class="pcw-qbar" hidden><span class="pcw-qtext"></span><button class="pcw-qx">✕</button></div>` +
      `<div class="pcw-inputrow">` +
      `<textarea class="pcw-input" rows="1" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>` +
      `<button class="pcw-tool btn-at" title="@人">@</button>` +
      `<button class="pcw-tool btn-pos" title="输入 x,y 后分享地图坐标">坐标</button>` +
      `<button class="pcw-tool send">发送</button></div>` +
      `</div>` +
      `</div>` +
      `<div class="pcw-pop atpop" hidden></div>` +
      `<div class="pcw-pop morepop pcw-morepop" hidden></div>` +
      `<div class="pcw-pop pcw-namepop" hidden></div>` +
      `<div class="pcw-pop pcw-namepop pcw-msgpop" hidden></div>` +
      `<div class="pcw-pop infopop pcw-infopop" hidden></div>` +
      `<div class="pcw-toast"></div>` +
      `<div class="pcw-rz" data-dir="l"></div>` +
      `<div class="pcw-rz" data-dir="r"></div>` +
      `<div class="pcw-rz" data-dir="b"></div>` +
      `<div class="pcw-rz" data-dir="bl"></div>` +
      `<div class="pcw-rz pcw-resize" data-dir="br"></div>`;
    root.appendChild(win);
    document.body.appendChild(host);

    this.#host = host;
    this.#root = root;
    this.#win = win;
    this.#chips = win.querySelector('.pcw-chips');
    this.#side = win.querySelector('.pcw-side');
    this.#sdrag = win.querySelector('.pcw-sdrag');
    this.#titleEl = win.querySelector('.pcw-title');
    this.#msgs = win.querySelector('.pcw-msgs');
    this.#loadTip = win.querySelector('.pcw-loadtip');
    this.#newMsgPill = win.querySelector('.pcw-newmsg');
    if (this.#newMsgPill)
      this.#newMsgPill.addEventListener('click', () => {
        this.#scrollBottom();
        this.#clearNewMsg();
      });
    this.#qbar = win.querySelector('.pcw-qbar');
    this.#input = win.querySelector('.pcw-input');
    this.#sendBtn = win.querySelector('.send');
    this.#atPop = win.querySelector('.atpop');
    this.#morePop = win.querySelector('.morepop');
    this.#namePop = win.querySelector('.pcw-namepop');
    this.#msgPop = win.querySelector('.pcw-msgpop');
    this.#infoPop = win.querySelector('.infopop');
    this.#toast = win.querySelector('.pcw-toast');

    this.#wireBlockGameEvents();
    this.#wireHead();
    this.#wireMessages();
    this.#wireInput();
    this.#wireResizeHandle();
    this.#wireSideDrag();
    this.#applyGeom();
    // 初始接管高度/滚动条：必须在 applyGeom 落位之后测——窗口未定宽时 fixed 按内容收缩，
    // 空 textarea 的 scrollHeight 会把折行的长 placeholder 计入，量出虚高定在输入框上
    this.#autoGrow();
    // 视口变化（窗口缩放/F11 全屏等）：右上锚定——记录与视口上/右两边的距离，
    // 宽度变化时按旧右距重算 x（浮层跟着右缘走），y 不变；持续缓存 lastVW 供计算旧右距
    let resizeTimer = null;
    let lastVW = window.innerWidth;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (!this.#win) return;
        const nvw = window.innerWidth;
        const g = this.#geom;
        const dispW = Math.min(g.w, lastVW); // 旧视口下的显示宽
        const rightGap = lastVW - (g.x + dispW); // 窗右缘到视口右边距（可为负=允许超界 60px 那档）
        this.#geom = clampGeom({ x: nvw - rightGap - Math.min(g.w, nvw), y: g.y, w: g.w, h: g.h });
        lastVW = nvw;
        this.#applyGeom();
        this.#notify('onGeomChange', this.getGeom()); // x 语义已随视口平移，同步存档
      }, 120);
    });
    // 挂载即隐藏：可见性统一由 show/hide/toggle 控制（chat-window 决定首次展示时机）
    win.hidden = true;
  }

  /** 卸载浮层（移除 host，冷却/toast 定时器一并清理） */
  unmount() {
    if (this.#cooldownTimer) {
      clearInterval(this.#cooldownTimer);
      this.#cooldownTimer = null;
    }
    if (this.#toastTimer) {
      clearTimeout(this.#toastTimer);
      this.#toastTimer = null;
    }
    if (this.#host) {
      this.#host.remove();
      this.#host = null;
      this.#root = null;
      this.#win = null;
    }
  }

  // ─────────────────────── 可见性 ───────────────────────

  /**
   * 切换显隐
   * @returns {boolean} 切换后的可见态
   */
  toggle() {
    if (!this.#win) this.mount();
    const vis = this.#win.hidden;
    this.#win.hidden = !vis;
    if (vis) {
      this.#autoGrow();
      this.#scrollBottom();
      this.#notify('onVisibleChange', true);
    } else this.#notify('onVisibleChange', false);
    return vis;
  }

  /** @returns {boolean} 当前是否可见 */
  isVisible() {
    return !!this.#win && !this.#win.hidden;
  }

  /**
   * 显示浮层（已挂载时幂等）
   * @returns {void}
   */
  show() {
    if (!this.#win) this.mount();
    if (this.#win.hidden) {
      this.#win.hidden = false;
      this.#autoGrow(); // 隐藏期 mount 时测量被守卫跳过，亮窗后补测一次收回默认高
      this.#scrollBottom();
      this.#notify('onVisibleChange', true);
    }
  }

  /** 隐藏浮层 */
  hide() {
    if (this.#win && !this.#win.hidden) {
      this.#win.hidden = true;
      this.#notify('onVisibleChange', false);
    }
  }

  // ─────────────────────── 频道与角标 ───────────────────────

  /**
   * 左侧会话列表（微信 PC 风双列）；items 为空则收起侧栏回单列
   * @param {Array<{key:string, title:string, sub?:string, unread?:number}>} items 会话项
   * @param {string} active 当前选中会话 key
   * @returns {void}
   */
  setSideList(items, active) {
    if (!this.#side) return;
    if (!items || !items.length) {
      this.#side.classList.remove('show');
      if (this.#sdrag) this.#sdrag.classList.remove('show');
      this.#side.innerHTML = '';
      return;
    }
    this.#side.innerHTML = items
      .map(
        (c, i) =>
          `<div class="pcw-conv${c.key === active ? ' active' : ''}" data-i="${i}">` +
          (c.avatar
            ? `<div class="pcw-convav" title="查看玩家信息">${avInner(c.avatar)}</div>`
            : '') +
          `<div class="pcw-convtc">` +
          `<div class="pcw-convt">${esc(c.title)}</div>` +
          `<div class="pcw-convs">${esc(c.sub || '')}</div>` +
          `</div>` +
          (c.unread ? `<span class="pcw-convb">${c.unread > 99 ? '99+' : c.unread}</span>` : '') +
          `</div>`,
      )
      .join('');
    bindAvFallback(this.#side);
    Array.from(this.#side.querySelectorAll('.pcw-conv')).forEach((el) => {
      el.addEventListener('click', () => {
        const c = items[+el.dataset.i];
        if (c) this.#notify('onSideSelect', c.key);
      });
      const avEl = el.querySelector('.pcw-convav');
      if (avEl)
        avEl.addEventListener('click', (ev) => {
          ev.stopPropagation(); // 点头像只弹信息，不触发整行切会话
          const c = items[+el.dataset.i];
          if (!c) return;
          const uid = c.key.indexOf('pm:') === 0 ? c.key.slice(3) : c.key;
          this.#notify('onNameInfo', { uid: uid, name: c.title, self: false });
        });
    });
    this.#side.style.width = this.#sideW + 'px';
    this.#side.classList.add('show');
    if (this.#sdrag) this.#sdrag.classList.add('show');
  }

  /**
   * 设置快捷频道 chip 栏与「更多」菜单项，并按当前 activeKey/unread 重绘
   * @param {Array<{key:string,label:string}>} quick 快捷栏频道
   * @param {Array<{key:string,label:string}>} more 更多菜单频道（含私聊会话）
   * @param {string} activeKey 当前激活 key
   * @returns {void}
   */
  setChannels(quick, more, activeKey) {
    this.#quickDefs = quick || [];
    this.#moreDefs = more || [];
    this.#activeKey = activeKey || '';
    this.#renderChips();
    this.#renderMorePop();
  }

  /**
   * 更新某频道未读角标并重绘
   * @param {Object<string, number>} map key -> 未读数（<=0 或省略即清）
   * @returns {void}
   */
  setUnread(map) {
    this.#unread = new Map(Object.entries(map || {}));
    this.#renderChips();
    this.#renderMorePop();
  }

  /**
   * 高亮指定频道 chip（不改频道本身，业务层切完后调用）
   * @param {string} key 激活 key
   * @returns {void}
   */
  setActive(key) {
    this.#activeKey = key || '';
    this.#renderChips();
  }

  /**
   * 标题栏文本（当前会话名；空串回默认「聊天」）
   * @param {string} t 标题
   * @returns {void}
   */
  setTitle(t) {
    if (this.#titleEl) this.#titleEl.textContent = t || '聊天';
  }

  /** 重绘快捷 chip 行 */
  #renderChips() {
    if (!this.#chips) return;
    const frag = document.createDocumentFragment();
    for (const def of this.#quickDefs) {
      const b = document.createElement('button');
      b.className = 'pcw-chip' + (def.key === this.#activeKey ? ' active' : '');
      b.textContent = def.label;
      const n = this.#unread.get(def.key) || 0;
      if (n > 0) {
        const badge = document.createElement('span');
        badge.className = 'pcw-badge';
        badge.textContent = n > 99 ? '99+' : String(n);
        b.appendChild(badge);
      }
      b.addEventListener('click', () => {
        this.#morePop.hidden = true;
        this.#notify('onChannelSelect', def.key);
      });
      frag.appendChild(b);
    }
    const moreBtn = document.createElement('button');
    moreBtn.className = 'pcw-chip';
    moreBtn.textContent = '更多▾';
    moreBtn.addEventListener('click', () => {
      this.#morePop.hidden = !this.#morePop.hidden;
    });
    frag.appendChild(moreBtn);
    this.#chips.replaceChildren(frag);
  }

  /** 重绘「更多」频道菜单 */
  #renderMorePop() {
    if (!this.#morePop) return;
    const items = this.#moreDefs
      .map((def) => {
        const n = this.#unread.get(def.key) || 0;
        return `<button class="pcw-popitem" data-key="${esc(def.key)}">${esc(def.label)}${n > 0 ? ' (' + (n > 99 ? '99+' : n) + ')' : ''}</button>`;
      })
      .join('');
    this.#morePop.innerHTML = items || '<div class="pcw-empty">暂无其他会话</div>';
    this.#morePop.querySelectorAll('.pcw-popitem').forEach((b) => {
      b.addEventListener('click', () => {
        this.#morePop.hidden = true;
        this.#notify('onChannelSelect', b.dataset.key);
      });
    });
  }

  // ─────────────────────── 消息渲染 ───────────────────────

  /**
   * 整列重绘消息区（切频道/历史回填时用）
   * @param {object[]} entries 预处理条目（见文件头 entry 约定）
   * @returns {void}
   */
  renderMessages(entries, keepScroll) {
    if (!this.#msgs) return;
    const prevTop = this.#msgs.scrollTop; // keepScroll 用：重排前阅读位置
    const frag = document.createDocumentFragment();
    for (const e of entries || []) frag.appendChild(this.#buildRow(e));
    if (!frag.childNodes.length) {
      const tip = document.createElement('div');
      tip.className = 'pcw-empty';
      tip.textContent = '暂无消息';
      frag.appendChild(tip);
    }
    this.#msgs.replaceChildren(frag);
    if (keepScroll) {
      // 乱序补投导致的整列重排：贴底则继续跟随最新，否则保持原阅读位置（不清浮标、不补翻页）
      if (this.#pinned) this.#scrollBottom();
      else this.#msgs.scrollTop = prevTop;
      return;
    }
    this.#pinned = true;
    this.#clearNewMsg(); // 全量重绘（切频道/初始）已定位到最新，清浮标
    this.#scrollBottom();
    // 首屏内容不足一屏时无滚动条，滚顶翻页触发死锁：主动翻旧页补齐（业务层有 loaded/roomId/上限闸门）
    this.#fillViewport();
  }

  /** 内容不满一屏时继续向上翻页（每轮驱动一页，由 prependMessages 接力直到满屏或触顶上限） */
  #fillViewport() {
    if (!this.#msgs || this.#msgs.hidden) return;
    if (this.#msgs.scrollHeight <= this.#msgs.clientHeight + 4) this.#notify('onLoadOlder');
  }

  /**
   * 追加一条（实时消息）：贴底（正在看最新）或自己发的 → 自动跟随到底部；已向上翻阅历史 → 不打断，仅出「N 条新消息」浮标。
   * @param {object} entry 条目
   * @returns {void}
   */
  appendMessage(entry) {
    if (!this.#msgs) return;
    const empty = this.#msgs.querySelector('.pcw-empty');
    if (empty) empty.remove();
    this.#msgs.appendChild(this.#buildRow(entry));
    // 限 DOM 规模：只留最近 300 个节点
    while (this.#msgs.childElementCount > 300) this.#msgs.firstElementChild.remove();
    // 贴底（#pinned，正在看最新一条）或自己发的 → 自动跟随到底部；已向上翻阅 → 不打断，只累加底部浮标（点浮标或手动滚回底部才清）
    if (entry.self || this.#pinned) {
      this.#pinned = true;
      this.#scrollBottom();
    } else this.#bumpNewMsg();
  }

  /** 底部「N 条新消息」浮标计数 +1 并显示（他人新消息到达、不自动滚动时） */
  #bumpNewMsg() {
    this.#newMsgCount++;
    if (this.#newMsgPill) {
      this.#newMsgPill.hidden = false;
      this.#newMsgPill.textContent =
        '↓ ' + (this.#newMsgCount > 99 ? '99+' : this.#newMsgCount) + ' 条新消息';
    }
  }

  /** 清除「新消息」浮标（用户点击浮标跳最新，或手动滚回底部时） */
  #clearNewMsg() {
    this.#newMsgCount = 0;
    if (this.#newMsgPill) {
      this.#newMsgPill.hidden = true;
      this.#newMsgPill.textContent = '';
    }
  }

  /**
   * 前插一页（历史翻页；保持原滚动位置不跳）
   * @param {object[]} entries 由旧到新的条目数组
   * @returns {void}
   */
  prependMessages(entries) {
    if (!this.#msgs || !entries || !entries.length) return;
    const prevH = this.#msgs.scrollHeight;
    const frag = document.createDocumentFragment();
    for (const e of entries) frag.appendChild(this.#buildRow(e));
    this.#msgs.insertBefore(frag, this.#msgs.firstChild);
    this.#msgs.scrollTop = this.#msgs.scrollHeight - prevH;
    // 补一页后仍不满一屏（scrollTop 被钳到顶部附近）→ 接力翻下一页
    if (this.#msgs.scrollHeight <= this.#msgs.clientHeight + 4 || this.#msgs.scrollTop <= 2)
      this.#notify('onLoadOlder');
  }

  /** 清空消息区 */
  clearMessages() {
    if (this.#msgs) this.#msgs.replaceChildren();
  }

  /**
   * 顶部历史加载状态条（#msgs 前置兄弟，不参与 prepend/append）。
   * @param {string} state 'loading' 正在加载更早 / 'end' 已加载全部 / 'error' 失败可重试 / 其他隐去
   * @returns {void}
   */
  setHistoryStatus(state) {
    if (!this.#loadTip) return;
    const t = this.#loadTip;
    if (state === 'loading') {
      t.hidden = false;
      t.textContent = '正在加载更早的消息…';
    } else if (state === 'end') {
      t.hidden = false;
      t.textContent = '— 已加载全部历史 —';
    } else if (state === 'error') {
      t.hidden = false;
      t.textContent = '历史加载失败，继续上滚重试';
    } else {
      t.hidden = true;
      t.textContent = '';
    }
  }

  /**
   * 构建一条消息行 DOM
   * @param {object} e 条目
   * @returns {HTMLElement}
   */
  #buildRow(e) {
    const row = document.createElement('div');
    row.className = 'pcw-row' + (e.mention ? ' mention' : '');
    row.dataset.id = String(e.id == null ? '' : e.id);
    row._entry = e; // 右键菜单取回条目（DOM 自定义属性存不了对象）
    if (e.quote) {
      const q = document.createElement('div');
      q.className = 'pcw-quote';
      q.textContent = '引用 ' + (e.quote.name || '') + ': ' + (e.quote.msg || '');
      q.title = '定位原消息';
      q.addEventListener('click', () => this.#jumpTo(e.quote.id));
      row.appendChild(q);
    }
    const line = document.createElement('div');
    const time = document.createElement('span');
    time.className = 'pcw-time';
    time.textContent = e.timeStr || '';
    line.appendChild(time);
    const nameEl = document.createElement('span');
    nameEl.className = 'pcw-name' + (e.self ? ' self' : ' other');
    nameEl.textContent = (e.name || '') + (e.pmDir ? ' ' + e.pmDir : '') + ':';
    if (!e.self) {
      nameEl.title = '操作菜单';
      nameEl.addEventListener('click', (ev) => this.openNameMenu(e, ev));
    }
    line.appendChild(nameEl);
    for (const seg of e.segments || [{ type: 'text', s: '' }]) {
      if (seg.type === 'at') {
        const at = document.createElement('span');
        at.className = 'pcw-at';
        at.textContent = seg.s;
        line.appendChild(at);
      } else if (seg.type === 'chip') {
        const chip = document.createElement('span');
        const jumpable = !!seg.action;
        chip.className = 'pcw-chiplink' + (jumpable ? ' jump' : '');
        chip.textContent = seg.s;
        if (jumpable) {
          chip.title = '点击跳转到游戏：' + (seg.jumpHint || seg.s);
          chip.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.#notify('onJump', seg.action, e);
          });
        } else {
          chip.title = '点击复制: ' + (seg.copy != null ? seg.copy : seg.s);
          chip.addEventListener('click', () =>
            this.#copyText(String(seg.copy != null ? seg.copy : seg.s)),
          );
        }
        line.appendChild(chip);
      } else {
        line.appendChild(document.createTextNode(seg.s == null ? '' : String(seg.s)));
      }
    }
    row.appendChild(line);
    row.addEventListener('dblclick', () => this.#notify('onQuote', e));
    return row;
  }

  // ─────────────────────── 引用条 / 输入 ───────────────────────

  /**
   * 设置/清除引用条
   * @param {object|null} entry 被引用条目；null 取消
   * @returns {void}
   */
  setQuote(entry) {
    this.#quote = entry || null;
    if (!this.#qbar) return;
    this.#qbar.hidden = !this.#quote;
    if (this.#quote) {
      this.#qbar.querySelector('.pcw-qtext').textContent =
        '引用 ' +
        (this.#quote.name || '') +
        ': ' +
        (this.#quote.segments ? this.#quote.segments.map((s) => s.s).join('') : '');
    }
  }

  /**
   * 预填输入框并聚焦（回复引导用）
   * @param {string} text 文本
   * @returns {void}
   */
  setInput(text) {
    if (this.#input) {
      this.#input.value = text || '';
      this.#autoGrow();
      this.focusInput();
    }
  }

  /** 聚焦输入框 */
  focusInput() {
    if (this.#input) this.#input.focus();
  }

  /** 发送被业务层接受后：清输入与 @ 列表 */
  clearInput() {
    if (this.#input) {
      this.#input.value = '';
      this.#autoGrow();
    }
    this.#atList = [];
    this.setQuote(null);
  }

  /** textarea 随内容自动扩高（上限 120px 与 CSS max-height 一致，超出内部滚动）。
   * 空值不测 scrollHeight（placeholder 折行/UA 默认 rows 会污染测量），直接按行高算单行定高 */
  #autoGrow() {
    const el = this.#input;
    if (!el || el.offsetParent === null) return; // 隐藏/未布局时测不准，交给亮窗后的补测
    const cs = getComputedStyle(el);
    const lh = Math.ceil(parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.5);
    if (!el.value) {
      el.style.height = lh + 12 + 'px'; // padding 5×2 + 上下边框 1×2
      el.style.overflowY = 'hidden';
      return;
    }
    el.style.height = 'auto';
    // scrollHeight 不含上下边框（2px）：补齐后再定高，否则单行也被判定溢出、误弹滚动条
    const need = el.scrollHeight + 2;
    el.style.height = Math.min(need, 120) + 'px';
    el.style.overflowY = need > 120 ? 'auto' : 'hidden';
  }

  /**
   * 发送冷却倒计时（禁用发送按钮并显示剩余秒）
   * @param {number} sec 冷却秒数
   * @returns {void}
   */
  startCooldown(sec) {
    this.#cooldownLeft = sec | 0;
    if (this.#cooldownTimer) clearInterval(this.#cooldownTimer);
    this.#paintSendBtn();
    this.#cooldownTimer = setInterval(() => {
      if (--this.#cooldownLeft <= 0) {
        clearInterval(this.#cooldownTimer);
        this.#cooldownTimer = null;
        this.#cooldownLeft = 0;
      }
      this.#paintSendBtn();
    }, 1000);
  }

  /** 冷却按钮文案回写 */
  #paintSendBtn() {
    if (!this.#sendBtn) return;
    this.#sendBtn.disabled = this.#cooldownLeft > 0;
    this.#sendBtn.textContent = this.#cooldownLeft > 0 ? `发送(${this.#cooldownLeft})` : '发送';
  }

  /**
   * 打开 @ 选人浮层（带过滤输入框，输入即时模糊匹配，口径类似游戏选人弹窗）
   * @param {Array<{uid:string, name:string}>} speakers 候选（联盟成员/近期发言者，业务层供给）
   * @param {boolean} allowAll 是否置顶「全体成员」
   * @returns {void}
   */
  openAtPicker(speakers, allowAll) {
    if (!this.#atPop) return;
    this.#atCands = (speakers || []).slice();
    this.#atAllowAll = !!allowAll;
    this.#atFilter = '';
    this.#atPop.innerHTML =
      `<input class="pcw-popfilter" type="text" placeholder="输入关键字过滤" />` +
      `<div class="pcw-atitems"></div>`;
    const filter = this.#atPop.querySelector('.pcw-popfilter');
    filter.addEventListener('input', () => {
      this.#atFilter = filter.value || '';
      this.#renderAtItems();
    });
    this.#renderAtItems();
    this.#atPop.hidden = false;
    this.#morePop.hidden = true;
    this.#namePop.hidden = true;
    filter.focus();
  }

  /**
   * 异步补充/替换 @ 候选（如联盟成员表拉到后二次刷新；浮层开着时保留过滤词重渲染）
   * @param {Array<{uid:string, name:string}>} speakers 新候选全量
   * @returns {void}
   */
  setAtCandidates(speakers) {
    this.#atCands = (speakers || []).slice();
    if (this.#atPop && !this.#atPop.hidden) this.#renderAtItems();
  }

  /** 按当前过滤词渲染候选列表（子串模糊，大小写不敏感；空词全量） */
  #renderAtItems() {
    if (!this.#atPop) return;
    const box = this.#atPop.querySelector('.pcw-atitems');
    if (!box) return;
    const q = this.#atFilter.trim().toLowerCase();
    const list = [];
    if (this.#atAllowAll) list.push({ uid: '', name: AT_ALL_LABEL, all: true });
    for (const s of this.#atCands) {
      if (
        !q ||
        String(s.name || '')
          .toLowerCase()
          .indexOf(q) >= 0
      )
        list.push(s);
      if (list.length >= 500) break; // 渲染上限（500 覆盖现实联盟规模，仍设上界防大列表卡 DOM）
    }
    box.innerHTML =
      list
        .map(
          (s, i) =>
            `<button class="pcw-popitem" data-i="${i}">${esc('@' + s.name)}${
              s.uid
                ? '<span class="pcw-atuid" data-copy="' +
                  esc(String(s.uid)) +
                  '">(' +
                  esc(String(s.uid)) +
                  ')</span>'
                : ''
            }</button>`,
        )
        .join('') || '<div class="pcw-empty">无匹配对象</div>';
    Array.from(box.querySelectorAll('.pcw-popitem')).forEach((b) => {
      b.addEventListener('click', () => {
        const s = list[+b.dataset.i];
        this.#atPop.hidden = true;
        if (!s) return;
        this.#insertAt(s);
      });
    });
    // UID 仅展示：点击只复制、不触发所在行的 @ 插入（stopPropagation 挡住冒泡到 button）
    Array.from(box.querySelectorAll('.pcw-atuid')).forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.#copyText(el.dataset.copy || '');
      });
    });
  }

  /**
   * 名字操作菜单：@ 此人 / 发起私聊 /（非好友时）加好友。
   * 好友判定暂无内存数据源（游戏好友面板按需协议拉取），entry.friend 未提供时两项都展示。
   * @param {object} e 消息条目
   * @param {MouseEvent} ev 点击事件（定位菜单）
   * @returns {void}
   */
  openNameMenu(e, ev) {
    if (!this.#namePop || !this.#win || e.self) return;
    // 好友关系由业务层同步判定（null=判不出，私聊/加好友两项并列）
    const friend = this.#notify('onCheckFriend', e);
    const acts = [
      { label: '查看信息', fn: () => this.#notify('onNameInfo', e) },
      { label: '@ ' + (e.name || ''), fn: () => this.#insertAt({ uid: e.uid, name: e.name }) },
    ];
    if (friend !== false) acts.push({ label: '发起私聊', fn: () => this.#notify('onNamePm', e) });
    if (friend !== true)
      acts.push({ label: '加好友', fn: () => this.#notify('onNameAddFriend', e) });
    this.#namePop.innerHTML = acts
      .map((a, i) => `<button class="pcw-popitem" data-i="${i}">${esc(a.label)}</button>`)
      .join('');
    Array.from(this.#namePop.querySelectorAll('.pcw-popitem')).forEach((b) => {
      b.addEventListener('click', () => {
        this.#namePop.hidden = true;
        const a = acts[+b.dataset.i];
        if (a) a.fn();
      });
    });
    // 定位到点击点（win 坐标），钉在窗口内；信息卡沿用此锚点
    const rect = this.#win.getBoundingClientRect();
    const x = Math.max(4, Math.min(ev.clientX - rect.left, rect.width - 140));
    const y = Math.max(4, Math.min(ev.clientY - rect.top, rect.height - 30 - acts.length * 28));
    this.#menuPos = { x, y };
    this.#namePop.style.left = x + 'px';
    this.#namePop.style.top = y + 'px';
    this.#namePop.style.bottom = 'auto';
    this.#namePop.hidden = false;
    this.#infoPop.hidden = true;
    this.#atPop.hidden = true;
    this.#morePop.hidden = true;
  }

  /**
   * 弹出玩家信息卡（名字菜单→查看信息；业务层取到数据后调）。
   * 行可传字符串或 {s, action} / {s, copy}：带 action 渲染为跳转链接（点击关卡并回调 onJump）；
   * 带 copy 渲染为复制链接（点击复制 copy 文本、不关卡，复用 #copyText 的 toast 反馈）。
   * @param {string} title 标题（昵称）
   * @param {Array<string|{s:string, action?:object, copy?:string}>} lines 信息行（key: value）
   * @param {{url?:string, initial?:string, hue?:number}} [av] 头像描述子（可空：无则标题不带图）
   * @returns {void}
   */
  showInfoPop(title, lines, av) {
    if (!this.#infoPop || !this.#win) return;
    const jumpActs = [];
    const rows = (lines || [])
      .map((ln) => {
        const it = ln && typeof ln === 'object' ? ln : { s: String(ln == null ? '' : ln) };
        if (it.copy)
          return `<div class="pcw-inforow"><span class="pcw-copylink" data-copy="${esc(String(it.copy))}">${esc(it.s)}</span></div>`;
        if (!it.action) return `<div class="pcw-inforow">${esc(it.s)}</div>`;
        const idx = jumpActs.push(it.action) - 1;
        return `<div class="pcw-inforow"><span class="pcw-jumplink" data-jump="${idx}">${esc(it.s)}</span></div>`;
      })
      .join('');
    this.#infoPop.innerHTML =
      (av
        ? `<div class="pcw-popav">${avInner(av)}<div class="pcw-infotitle">${esc(title || '玩家信息')}</div></div>`
        : `<div class="pcw-infotitle">${esc(title || '玩家信息')}</div>`) +
      (rows || '<div class="pcw-inforow">（无可用信息）</div>');
    bindAvFallback(this.#infoPop);
    this.#infoPop.querySelectorAll('.pcw-jumplink').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.#infoPop.hidden = true;
        this.#notify('onJump', jumpActs[+el.dataset.jump]);
      });
    });
    // 复制行：只复制不关卡片（方便继续看/复制其他行），反馈走 #copyText 自带的 toast
    this.#infoPop.querySelectorAll('.pcw-copylink').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.#copyText(el.dataset.copy || '');
      });
    });
    // 先亮出来再按实际渲染尺寸 clamp（固定估算值会把卡片底部截到窗口外）
    this.#infoPop.style.left = '0px';
    this.#infoPop.style.top = '0px';
    this.#infoPop.hidden = false;
    const rect = this.#win.getBoundingClientRect();
    const x = Math.max(4, Math.min(this.#menuPos.x, rect.width - this.#infoPop.offsetWidth - 6));
    const y = Math.max(4, Math.min(this.#menuPos.y, rect.height - this.#infoPop.offsetHeight - 6));
    this.#infoPop.style.left = x + 'px';
    this.#infoPop.style.top = y + 'px';
  }

  /**
   * 选中一个 @ 对象：插入输入框并登记待发列表（同人不重复）
   * @param {{uid:string, name:string, all?:boolean}} s 候选项
   * @returns {void}
   */
  #insertAt(s) {
    const token = '@' + s.name + ' ';
    if (this.#input) {
      this.#input.value += token;
      this.#autoGrow();
    }
    if (!this.#atList.some((x) => x.name === s.name)) this.#atList.push(s);
    this.focusInput();
  }

  // ─────────────────────── 外观与几何 ───────────────────────

  /**
   * 设置窗口透明度（背景与边框整体）
   * @param {number} pct 30-100
   * @returns {void}
   */
  setOpacity(pct) {
    if (!this.#win) return;
    const a = Math.max(0.3, Math.min(1, (pct || 75) / 100));
    this.#win.style.background = `rgba(18,22,30,${(a * 0.96).toFixed(2)})`;
    this.#win.style.borderColor = `rgba(255,255,255,${(a * 0.22).toFixed(2)})`;
  }

  /**
   * 应用几何（外部恢复存档时用，自动钳制）
   * @param {{x?:number,y?:number,w?:number,h?:number}} g 几何
   * @returns {void}
   */
  setGeom(g) {
    if (!g) return;
    this.#geom = clampGeom({
      x: g.x != null ? g.x : this.#geom.x,
      y: g.y != null ? g.y : this.#geom.y,
      w: g.w != null ? g.w : this.#geom.w,
      h: g.h != null ? g.h : this.#geom.h,
    });
    if (g.sideW != null && g.sideW >= 100) this.#sideW = Math.min(g.sideW, 360);
    if (this.#side) this.#side.style.width = this.#sideW + 'px';
    this.#applyGeom();
  }

  /** @returns {{x:number,y:number,w:number,h:number,sideW:number}} 当前几何（拷贝，含侧栏宽度） */
  getGeom() {
    return Object.assign({}, this.#geom, { sideW: this.#sideW });
  }

  /** 写样式落位 */
  #applyGeom() {
    if (!this.#win) return;
    // 显示层钳位：#geom 是逻辑几何（与屏幕左/上边距即存档值），视口不足时只把显示贴边，
    // resize 恢复后回到原边距；侧栏显示宽同理随可视窗宽收缩（逻辑 #sideW 不变）
    const g = clampGeom(this.#geom);
    const s = this.#win.style;
    s.left = g.x + 'px';
    s.top = g.y + 'px';
    s.width = g.w + 'px';
    s.height = g.h + 'px';
    if (this.#side)
      this.#side.style.width =
        Math.max(100, Math.min(this.#sideW, Math.max(100, g.w - 240))) + 'px';
  }

  /**
   * 浮层内小提示（2.2s 自动淡出）
   * @param {string} msg 文案
   * @returns {void}
   */
  toast(msg) {
    if (!this.#toast) return;
    this.#toast.textContent = msg;
    this.#toast.classList.add('show');
    if (this.#toastTimer) clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => this.#toast.classList.remove('show'), 2200);
  }

  // ─────────────────────── 内部接线 ───────────────────────

  /** 屏蔽游戏输入：浮层内指针/键盘/滚轮事件冒泡到 win 即止 */
  #wireBlockGameEvents() {
    const stop = (e) => e.stopPropagation();
    for (const t of [
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
    ]) {
      this.#win.addEventListener(t, stop);
    }
    // 焦点进出：host 上 tabindex 防游戏抢焦点丢失由浏览器默认处理，无需干预
  }

  /** 顶栏：关闭按钮、标题拖拽 */
  #wireHead() {
    this.#win.querySelector('.pcw-close').addEventListener('click', () => this.hide());
    const bar = this.#win.querySelector('.pcw-titlebar');
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      // ✕ 按钮也在 titlebar 内：若照常起拖并 setPointerCapture，click 会被重定向到 bar，关闭按钮失效
      if (/** @type {HTMLElement} */ (e.target).closest('.pcw-close')) return;
      drag = { sx: e.clientX, sy: e.clientY, ox: this.#geom.x, oy: this.#geom.y };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.#geom = clampGeom({
        x: drag.ox + e.clientX - drag.sx,
        y: drag.oy + e.clientY - drag.sy,
        w: this.#geom.w,
        h: this.#geom.h,
      });
      this.#applyGeom();
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch (err) {}
      this.#notify('onGeomChange', this.getGeom());
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  /** 侧栏/消息区分隔条：拖拽调宽（100–360px，上限再受窗口宽约束），松手随几何存档持久 */
  #wireSideDrag() {
    const hd = this.#sdrag;
    if (!hd) return;
    let rs = null;
    hd.addEventListener('pointerdown', (e) => {
      rs = { sx: e.clientX, ow: this.#sideW };
      hd.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    hd.addEventListener('pointermove', (e) => {
      if (!rs) return;
      const maxW = Math.min(360, this.#geom.w - 240); // 右侧聊天列至少留 240px
      this.#sideW = Math.max(100, Math.min(rs.ow + e.clientX - rs.sx, maxW));
      if (this.#side) this.#side.style.width = this.#sideW + 'px';
    });
    const end = (e) => {
      if (!rs) return;
      rs = null;
      try {
        hd.releasePointerCapture(e.pointerId);
      } catch (err) {}
      this.#notify('onGeomChange', this.getGeom());
    };
    hd.addEventListener('pointerup', end);
    hd.addEventListener('pointercancel', end);
  }

  /** 消息区：滚动钉底跟踪 + 滚到顶翻页 + 右键菜单 */
  #wireMessages() {
    this.#msgs.addEventListener('contextmenu', (ev) => {
      const row = /** @type {HTMLElement} */ (ev.target).closest('.pcw-row');
      const entry = row && row._entry;
      if (!entry) return; // 空白处不拦默认行为
      ev.preventDefault();
      ev.stopPropagation(); // 不冒到游戏/窗口其他层
      this.#openMsgMenu(entry, ev);
    });
    this.#msgs.addEventListener('scroll', () => {
      const el = this.#msgs;
      this.#pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (this.#pinned) this.#clearNewMsg(); // 用户手动滚回底部：清「新消息」浮标
      if (el.scrollTop < 240 && !this.#topGate) {
        // 提前 240px 预取（不必顶到边缘），#topGate 防惯性连触
        this.#topGate = true;
        this.#notify('onLoadOlder');
        setTimeout(() => {
          this.#topGate = false;
        }, 400);
      }
    });
  }

  /** 输入区：回车发送（Shift+回车软换行）、自动扩高、按钮接线 */
  #wireInput() {
    this.#input.addEventListener('input', () => this.#autoGrow());
    this.#input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.#doSend();
      }
      if (e.key === 'Escape') {
        this.#atPop.hidden = true;
        this.#morePop.hidden = true;
        if (this.#namePop) this.#namePop.hidden = true;
        if (this.#infoPop) this.#infoPop.hidden = true;
        if (this.#msgPop) this.#msgPop.hidden = true;
      }
    });
    this.#sendBtn.addEventListener('click', () => this.#doSend());
    this.#win.querySelector('.btn-at').addEventListener('click', () => {
      // 选人数据由业务层供给：先请求（chat-window 监听后调 openAtPicker）
      this.#notify('onRequestAtList');
    });
    this.#win.querySelector('.btn-pos').addEventListener('click', () => {
      const m = /^(\d+)\s*,\s*(\d+)$/.exec(this.#input.value.trim());
      if (m) {
        this.#notify('onSharePos', +m[1], +m[2]);
        this.#input.value = '';
      } else this.toast('先在输入框里填 711,97 这样的坐标');
    });
    this.#qbar.querySelector('.pcw-qx').addEventListener('click', () => this.setQuote(null));
    // 点窗口空白收起浮层菜单
    this.#win.addEventListener('pointerdown', (e) => {
      if (!this.#atPop.contains(/** @type {Node} */ (e.target))) this.#atPop.hidden = true;
      if (
        !this.#morePop.contains(/** @type {Node} */ (e.target)) &&
        !(/** @type {HTMLElement} */ (e.target).closest('.pcw-chip'))
      )
        this.#morePop.hidden = true;
      if (
        this.#namePop &&
        !this.#namePop.contains(/** @type {Node} */ (e.target)) &&
        !(/** @type {HTMLElement} */ (e.target).closest('.pcw-name'))
      )
        this.#namePop.hidden = true;
      if (
        this.#infoPop &&
        !this.#infoPop.contains(/** @type {Node} */ (e.target)) &&
        !(/** @type {HTMLElement} */ (e.target).closest('.pcw-name'))
      )
        this.#infoPop.hidden = true;
      if (this.#msgPop && !this.#msgPop.contains(/** @type {Node} */ (e.target)))
        this.#msgPop.hidden = true;
    });
  }

  /** 发送动作：交给业务层（Promise 决定清不清输入框）；软换行在出站前压成空格（聊天消息为单行） */
  #doSend() {
    const text = this.#input.value
      .trim()
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (!text) return;
    const p = this.#h.onSend
      ? this.#h.onSend(text, this.#atList.slice(), this.#quote)
      : Promise.resolve(false);
    Promise.resolve(p).then(
      (ok) => {
        if (ok) this.clearInput();
      },
      () => {},
    );
  }

  /** 边/角 resize 把手：左、右、底、左下、右下（上边与上角留给标题栏拖拽） */
  #wireResizeHandle() {
    Array.from(this.#win.querySelectorAll('.pcw-rz')).forEach((hd) => {
      const dir = hd.dataset.dir;
      let rs = null;
      hd.addEventListener('pointerdown', (e) => {
        rs = {
          sx: e.clientX,
          sy: e.clientY,
          ox: this.#geom.x,
          oy: this.#geom.y,
          ow: this.#geom.w,
          oh: this.#geom.h,
        };
        hd.setPointerCapture(e.pointerId);
        e.stopPropagation();
      });
      hd.addEventListener('pointermove', (e) => {
        if (!rs) return;
        const dx = e.clientX - rs.sx;
        const dy = e.clientY - rs.sy;
        let x = rs.ox,
          y = rs.oy,
          w = rs.ow,
          h = rs.oh;
        if (dir === 'l' || dir === 'bl') {
          w = rs.ow - dx;
          x = rs.ox + dx;
        } // 右缘锚定
        if (dir === 'r' || dir === 'br') {
          w = rs.ow + dx;
        }
        if (dir === 'b' || dir === 'bl' || dir === 'br') {
          h = rs.oh + dy;
        }
        if ((dir === 'l' || dir === 'bl') && w < MIN_W) {
          w = MIN_W;
          x = rs.ox + rs.ow - MIN_W;
        } // 触最小宽后右缘不再左移
        if (h < MIN_H) h = MIN_H;
        this.#geom = clampGeom({ x, y, w, h });
        this.#applyGeom();
      });
      const end = (e) => {
        if (!rs) return;
        rs = null;
        try {
          hd.releasePointerCapture(e.pointerId);
        } catch (err) {}
        this.#notify('onGeomChange', this.getGeom());
      };
      hd.addEventListener('pointerup', end);
      hd.addEventListener('pointercancel', end);
    });
  }

  /**
   * 消息右键菜单：引用（所有消息）/ 撤回（仅自己的，时限与协议在业务层）
   * @param {object} e 消息条目
   * @param {MouseEvent} ev 右键事件（定位菜单）
   * @returns {void}
   */
  #openMsgMenu(e, ev) {
    if (!this.#msgPop || !this.#win) return;
    // 复制源：消息区内有选中则取选中文本，否则整条消息正文
    let selText = '';
    try {
      const sel = (this.#root.getSelection ? this.#root : document).getSelection();
      if (sel && String(sel).trim() && sel.anchorNode && this.#msgs.contains(sel.anchorNode))
        selText = String(sel);
    } catch (err) {
      /* 取不到当无选中 */
    }
    const acts = [
      {
        label: '复制',
        fn: () => this.#copyText(selText || String(e.plain != null ? e.plain : e.text || '')),
      },
      { label: '引用', fn: () => this.#notify('onQuote', e) },
    ];
    if (e.self) acts.push({ label: '撤回', fn: () => this.#notify('onRevoke', e) });
    this.#msgPop.innerHTML = acts
      .map((a, i) => `<button class="pcw-popitem" data-i="${i}">${esc(a.label)}</button>`)
      .join('');
    Array.from(this.#msgPop.querySelectorAll('.pcw-popitem')).forEach((b) => {
      b.addEventListener('click', () => {
        this.#msgPop.hidden = true;
        const a = acts[+b.dataset.i];
        if (a) a.fn();
      });
    });
    const rect = this.#win.getBoundingClientRect();
    const x = Math.max(4, Math.min(ev.clientX - rect.left, rect.width - 140));
    const y = Math.max(4, Math.min(ev.clientY - rect.top, rect.height - 30 - acts.length * 28));
    this.#msgPop.style.left = x + 'px';
    this.#msgPop.style.top = y + 'px';
    this.#msgPop.hidden = false;
    if (this.#namePop) this.#namePop.hidden = true;
    if (this.#infoPop) this.#infoPop.hidden = true;
  }

  /**
   * 复制文本到剪贴板（clipboard API 优先，非安全上下文回退临时 textarea+execCommand）
   * @param {string} text 待复制内容
   * @returns {void}
   */
  #copyText(text) {
    if (!text) {
      this.toast('无可复制内容');
      return;
    }
    const done = () => {
      this.toast('已复制');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => this.#copyFallback(text, done));
    } else {
      this.#copyFallback(text, done);
    }
  }

  /** execCommand 兜底复制（页面失焦/权限拒时用） */
  #copyFallback(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      const okc = document.execCommand('copy');
      ta.remove();
      if (okc) done();
      else this.toast('复制失败');
    } catch (e) {
      this.toast('复制失败');
    }
  }

  /** 滚到底 */
  #scrollBottom() {
    if (this.#msgs) this.#msgs.scrollTop = this.#msgs.scrollHeight;
  }

  /**
   * 点引用块定位原消息：已渲染行内直接滚动；找不到且允许按需拉取时回调
   * handlers.onLocateMessage(id)（业务层 aroundHistory 拉取上下文并重绘后再调 jumpToMessage 二次定位）。
   * @param {string} id 目标条目 id
   * @param {boolean} [allowLoad] 假（默认）时允许回调按需加载；jumpToMessage 传假避免无限回环
   * @returns {void}
   */
  #jumpTo(id, allowLoad) {
    if (id == null || id === '') {
      this.toast('引用未记录原消息标识，无法定位');
      return;
    }
    let row = null;
    // data-id 为带引号的属性值：只需转义 " 与 \，不能用 CSS.escape（那是标识符转义，会把纯数字 uuid 开头转成 \31 …导致永远匹配不到）
    try {
      row = this.#msgs.querySelector('[data-id="' + String(id).replace(/["\\]/g, '\\$&') + '"]');
    } catch (e) {
      row = null;
    }
    if (row) {
      row.scrollIntoView({ block: 'center' });
      const had = row.classList.contains('mention');
      if (!had) {
        row.classList.add('mention');
        setTimeout(() => row.classList.remove('mention'), 1500);
      }
    } else if (allowLoad !== false && this.#h.onLocateMessage) {
      this.#h.onLocateMessage(String(id)); // 交业务层拉取未加载区间，完成后回跳 jumpToMessage
    } else this.toast('原消息不在已加载范围内');
  }

  /**
   * 二次定位（业务层 aroundHistory 拉取入缓冲并重绘后调用）：仅在当前已渲染行内查找，不再触发按需加载。
   * @param {string} id 目标条目 id（uuid）
   * @returns {void}
   */
  jumpToMessage(id) {
    this.#jumpTo(id, false);
  }

  /**
   * 回调派发（缺省空操作）
   * @param {string} name handlers 键
   * @param {...*} args 实参
   * @returns {*} handler 返回值（onCheckFriend 等同步询问用；无 handler 或异常返回 undefined）
   */
  #notify(name, ...args) {
    try {
      return this.#h[name] ? this.#h[name](...args) : undefined;
    } catch (e) {
      log.warn('handler %s threw: %s', name, e && e.message);
      return undefined;
    }
  }
}
