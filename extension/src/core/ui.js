// 浮动图标 + 半透明面板（Shadow DOM 与游戏样式双向隔离）。
// 面板为左右两栏：左栏类别 TAB（日常/战斗/系统设置，切换只换右栏内容），右栏卡片列表。
// 卡片来自 core/menu.js：组卡片（主闸门 + 展开子项 checkbox）/ 功能卡片（启用 checkbox + 可展开详细字段）。
// 组开关是 UI 层主闸门：关→子项全部 enabled=false，开→恢复各子项 intentEnabled（见 menu.js）。
// 改动即存档（storage）并实时编排（applyFeature → reactor.setConfig）。
// 换号（UID 变化）由 player.js 走整页 reload，无需 in-place 刷新；仅登录卡死降级补载时监听 player.configs-reloaded 回写控件。
import { createLog } from './log.js';
import { session } from './game-api.js';
import { storage } from './storage.js';
import { bus } from './bus.js';
import { getUid } from './player.js';
import { configs, findFeature, saveFeature, saveGroup, applyFeature } from './registry.js';
import { iconSVG } from './icon-svg.js';
import { isCombat, setCombatMode } from './mode.js';
import { MENU, collectFeatureIds } from './menu.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CORE） */
const logCore = createLog('CORE');

/** @type {number} 浮动图标直径（px） */
const ICON_SIZE = 44;
/** @type {number} 面板宽度（px，定位时用于算左右边界）；左 TAB 栏固定 88px，余量给右侧内容列，避免长标签/数值区拥挤换行 */
const PANEL_W = 500;
/** @type {string} 图标位置存储键（属 UID 命名空间） */
const POS_KEY = 'pocketcc.ui.iconPos';

/** @type {string} Shadow DOM 内样式：与游戏样式双向隔离，图标/面板/卡片/TAB 全部规则 */
const PANEL_CSS = `
    .pc-icon{position:fixed;width:${ICON_SIZE}px;height:${ICON_SIZE}px;border-radius:50%;
      background:transparent;border:none;padding:0;
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;user-select:none;touch-action:none;
      z-index:2147483647;}
    .pc-icon svg{position:relative;z-index:1;
      filter:drop-shadow(0 0 8px rgba(47,155,255,.5)) drop-shadow(0 2px 5px rgba(0,0,0,.55));transition:filter .15s;}
    .pc-icon:hover svg{filter:drop-shadow(0 0 11px rgba(47,155,255,.75)) drop-shadow(0 2px 5px rgba(0,0,0,.55)) brightness(1.15);}
    .pc-icon.combat svg{filter:drop-shadow(0 0 10px rgba(255,59,48,.75)) drop-shadow(0 2px 5px rgba(0,0,0,.55));}
    /* 光晕层必须明显大于图标：亮带半径要落在不透明圆盘（约 21px）之外，否则整圈被圆盘盖住。 */
    .pc-halo{position:absolute;left:50%;top:50%;width:190%;height:190%;
      transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;z-index:0;
      background:radial-gradient(circle closest-side,
        rgba(90,175,255,0) 0 50%, rgba(90,175,255,.5) 70%,
        rgba(90,175,255,.9) 82%, rgba(90,175,255,0) 100%);
      filter:blur(6px);
      animation:pc-breathe-daily 3.4s ease-out infinite;}
    .pc-icon.combat .pc-halo{
      background:radial-gradient(circle closest-side,
        rgba(255,70,45,0) 0 50%, rgba(255,70,45,.55) 70%,
        rgba(255,70,45,1) 82%, rgba(255,70,45,0) 100%);
      filter:blur(7px);
      animation:pc-breathe-combat 1.1s ease-out infinite;}
    @keyframes pc-breathe-daily{
      0%{transform:translate(-50%,-50%) scale(.9);opacity:0;}
      18%{opacity:.85;}
      100%{transform:translate(-50%,-50%) scale(1.3);opacity:0;}}
    @keyframes pc-breathe-combat{
      0%{transform:translate(-50%,-50%) scale(.9);opacity:0;}
      14%{opacity:1;}
      100%{transform:translate(-50%,-50%) scale(1.38);opacity:0;}}
    .pc-mode{display:flex;align-items:center;justify-content:space-between;gap:8px;
      margin:2px 0 10px;padding:8px 10px;border-radius:8px;cursor:pointer;
      border:1px solid rgba(255,120,90,.35);background:rgba(255,90,60,.10);}
    .pc-mode span{font-weight:600;font-size:13px;color:#ffd0b8;}
    .pc-mode input{width:16px;height:16px;cursor:pointer;}
    .pc-panel{position:fixed;width:${PANEL_W}px;border-radius:12px;
      background:rgba(18,22,30,.6);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,.16);color:#e8eef7;
      font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif;
      -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
      box-shadow:0 10px 36px rgba(0,0,0,.55);padding:14px;z-index:2147483646;box-sizing:border-box;
      /* 卡片多/视口矮时面板自身可滞：fixed 元素不会撑出页面滚动条，不封高度则底部内容直接不可达（placePanel 会跟着把 top 钉回可见区） */
      max-height:calc(100vh - 16px);overflow-y:auto;scrollbar-gutter:stable;}
    .pc-panel[hidden]{display:none;}
    .pc-panel h3{margin:0 0 8px;font-size:14px;font-weight:600;letter-spacing:.5px;color:#cfe8ff;}
    .pc-sub{margin-left:8px;font-size:10px;font-weight:400;opacity:.6;letter-spacing:1.5px;}
    /* 左右两栏：左 TAB，右内容。 */
    .pc-tabs{display:flex;gap:12px;align-items:stretch;}
    .pc-tabbar{flex:0 0 88px;display:flex;flex-direction:column;gap:4px;
      border-right:1px solid rgba(255,255,255,.12);padding-right:10px;}
    .pc-tab{appearance:none;text-align:left;border:none;background:transparent;color:#e8eef7;
      font:inherit;font-size:13px;padding:8px 10px;border-radius:8px;cursor:pointer;
      transition:background .15s,color .15s;}
    .pc-tab:hover{background:rgba(255,255,255,.08);}
    .pc-tab.active{background:rgba(70,140,255,.24);color:#dbeaff;font-weight:600;}
    .pc-tabpanes{flex:1;min-width:0;}
    .pc-pane{max-height:56vh;overflow-y:auto;scrollbar-gutter:stable;padding-right:2px;}
    /* 固定滞动条槽宽度 + 细滑动条：避免内容超高时滞动条出现/消失导致面板横向跳动 */
    .pc-pane::-webkit-scrollbar{width:8px;}
    .pc-pane::-webkit-scrollbar-track{background:transparent;}
    .pc-pane::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:4px;}
    .pc-pane[hidden]{display:none;}
    /* 卡片：组 / 功能共用外壳。 */
    .pc-sec{border:1px solid rgba(255,255,255,.12);border-radius:8px;margin:0 0 8px;overflow:hidden;}
    .pc-sec:last-child{margin-bottom:0;}
    .pc-sec-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;
      background:rgba(255,255,255,.04);transition:background .15s;}
    .pc-sec-head:hover{background:rgba(255,255,255,.09);}
    .pc-chev{font-size:10px;opacity:.65;transition:transform .15s;}
    .pc-chev.invisible{visibility:hidden;}
    .pc-sec.open > .pc-sec-head .pc-chev{transform:rotate(90deg);}
    .pc-sec-title{flex:1;font-weight:600;font-size:13px;}
    .pc-en,.pc-gen{width:16px;height:16px;cursor:pointer;flex:0 0 auto;}
    .pc-sec-body{padding:4px 12px 10px;}
    .pc-sec-body[hidden]{display:none;}
    /* 字段行 / 子项行 */
    .pc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:7px 0;}
    .pc-row > span{flex:1;min-width:0;}
    .pc-row input[type=number]{width:96px;flex:0 0 auto;padding:3px 6px;border-radius:6px;box-sizing:border-box;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;
      font-variant-numeric:tabular-nums;}
    .pc-row input[type=number]:focus{outline:none;border-color:rgba(120,180,255,.55);background:rgba(120,180,255,.10);}
    .pc-row input[type=text].pc-fstr{width:140px;flex:0 0 auto;padding:3px 6px;border-radius:6px;box-sizing:border-box;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;
      font-variant-numeric:tabular-nums;}
    .pc-row input[type=text].pc-fstr:focus{outline:none;border-color:rgba(120,180,255,.55);background:rgba(120,180,255,.10);}
    /* UID 控件（城市技能）：显示态「✎ 玩家名」可点→输入态；失焦反查名字，失败留框+红字 */
    .pc-uidwrap{width:100%;}
    .pc-uidwrap .pc-row>span:first-of-type{flex:0 0 auto;}
    /* 显示态做成与输入态同宽同框的「字段」外观（150px 定宽 + 边框 + 内边距），切换不跳版 */
    .pc-udisp{flex:0 0 150px;width:150px;box-sizing:border-box;display:flex;align-items:center;justify-content:flex-start;gap:4px;
      padding:3px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);cursor:pointer;
      color:#9ecbff;white-space:nowrap;overflow:hidden;transition:border-color .15s,background .15s;}
    /* display:flex 会盖过 UA 的 [hidden]{display:none}，enterEdit 里 disp.hidden=true 失效导致 ✎ Label 与输入框并存、行宽溢出：显式补一条 */
    .pc-udisp[hidden]{display:none;}
    .pc-udisp:hover{border-color:rgba(120,180,255,.55);background:rgba(120,180,255,.10);}
    .pc-udisp .pc-uedit{opacity:.55;font-size:11px;flex:0 0 auto;}
    .pc-udisp .pc-uname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left;}
    .pc-udisp .pc-uname.pc-uempty{opacity:.5;}
    .pc-row input[type=text].pc-uinput{width:150px;flex:0 0 auto;padding:3px 6px;border-radius:6px;box-sizing:border-box;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;
      font-variant-numeric:tabular-nums;}
    .pc-row input[type=text].pc-uinput:focus{outline:none;border-color:rgba(120,180,255,.55);background:rgba(120,180,255,.10);}
    .pc-row input[type=text].pc-uinput.pc-uerr{border-color:rgba(255,95,95,.85);}
    .pc-uhint{font-size:11px;color:#ff8a8a;text-align:right;margin:1px 0 2px;}
    /* 好友清单字段（type:'uidlist'，玩家点赞）：动态增删的 UID 行列表，行本身复用上面的 .pc-uidwrap 视觉。
       行可增删故结构性改动走整块重刷 + 重绑（见 mountUidList），非区间规则那种纯委托。 */
    .pc-ulist{display:flex;flex-direction:column;gap:4px;width:100%;margin:2px 0 6px;}
    .pc-ulisttop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-ulistadd{flex:0 0 auto;width:22px;height:20px;padding:0;border-radius:6px;cursor:pointer;
      border:1px dashed rgba(255,255,255,.28);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:18px;}
    .pc-ulistadd:hover{background:rgba(255,255,255,.1);}
    .pc-ulistadd:disabled{opacity:.4;cursor:default;}
    .pc-uli .pc-udel{flex:0 0 18px;width:18px;height:22px;padding:0;border:none;background:transparent;
      color:#ff9c9c;font:inherit;font-size:14px;line-height:22px;cursor:pointer;}
    .pc-uli .pc-udel:hover{color:#ff6b6b;}
    .pc-uli .pc-udisp{flex:1 1 auto;width:auto;min-width:0;}
    .pc-row input[type=checkbox]{width:16px;height:16px;cursor:pointer;flex:0 0 auto;}
    .pc-row select.pc-fsel{max-width:150px;flex:0 0 auto;padding:3px 6px;border-radius:6px;
      border:1px solid rgba(255,255,255,.25);background:rgba(20,26,38,.9);color:#e8eef7;font:inherit;}
    .pc-fval{font-variant-numeric:tabular-nums;color:#9ecbff;opacity:.9;flex:0 0 auto;
      text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    /* 只读 text 字段的多行变体（fd.multiline，如次元矿洞今日进度）：标签在上、值整行，pre-line 保留 \n 换行不截断 */
    .pc-rowcol{flex-direction:column;align-items:flex-start;gap:2px;}
    .pc-fvalml{white-space:pre-line;overflow:visible;text-overflow:clip;text-align:left;flex:0 0 auto;width:100%;line-height:1.6;}
    /* 区间规则字段（type:'ranges'，如联盟机甲按召唤所需碎片数分段配代捐枚数）：
       行可动态增删，因此交互走事件委托（见 wirePanel），不能逐个绑控件。
       行的视觉语法就是区间记法「[ 0 ~ 300 ) → 3」；列头与数据行共用同一套格子模板，所以括号类占位符在列头里只是隐藏而非删掉 */
    .pc-rng{display:flex;flex-direction:column;gap:4px;width:100%;margin:2px 0 6px;}
    .pc-rngtop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-rngtitle{font-size:12px;opacity:.9;font-weight:600;}
    /* 中文小字下限 11px：再小就没有 hinting，在深色底上会发灰发虚；弱化靠颜色而不是缩字号 */
    .pc-rnghint{font-size:11px;opacity:.62;line-height:1.5;}
    .pc-rngrow{display:flex;align-items:center;gap:4px;}
    /* 列宽用 flex 均分而非固定 px：卡片内容区只有两百多 px，固定宽会把行撑到面板外 */
    .pc-rngrow input[type=number]{flex:1 1 0;min-width:0;width:auto;padding:3px 5px;border-radius:6px;box-sizing:border-box;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;
      font-variant-numeric:tabular-nums;text-align:right;appearance:textfield;-moz-appearance:textfield;}
    .pc-rngrow input[type=number]:focus{outline:none;border-color:rgba(120,180,255,.55);background:rgba(120,180,255,.10);}
    .pc-rngrow input[type=number]::-webkit-inner-spin-button,
    .pc-rngrow input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
    /* 括号 / 波浪号 / 箭头：不参与伸缩，也不给数字框抢宽 */
    .pc-rngop{flex:0 0 auto;min-width:7px;text-align:center;font-size:12px;opacity:.5;}
    .pc-rnghead .pc-rngop{visibility:hidden;}
    .pc-rnglbl{flex:1 1 0;min-width:0;font-size:11px;opacity:.72;text-align:center;letter-spacing:.2px;}
    .pc-rngdelcol{flex:0 0 18px;}
    .pc-rngdel{flex:0 0 18px;width:18px;height:22px;padding:0;border:none;background:transparent;
      color:#ff9c9c;font:inherit;font-size:14px;line-height:22px;cursor:pointer;}
    .pc-rngdel:hover{color:#ff6b6b;}
    /* 多选开关组字段（type:'multiopts'，次元矿洞矿种）：标题行（左标题 + 右全选/清空）+ 下方紧凑网格。
       网格用 auto-fill 小盒，窄卡片下一行排几个自适应；选项由配置表运行时枚举，数量不定。 */
    .pc-mopts{display:flex;flex-direction:column;gap:4px;width:100%;margin:2px 0 6px;}
    .pc-mopstop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-mopttitle{font-size:12px;opacity:.9;font-weight:600;}
    .pc-moptacts{display:flex;gap:6px;flex:0 0 auto;}
    .pc-moptall,.pc-moptnone{padding:1px 8px;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;
      border:1px solid rgba(255,255,255,.24);background:transparent;color:#cfe8ff;}
    .pc-moptall:hover,.pc-moptnone:hover{background:rgba(255,255,255,.1);}
    .pc-moptgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:4px 8px;width:100%;}
    .pc-mopt{display:flex;align-items:center;gap:4px;font-size:12px;min-width:0;cursor:pointer;}
    .pc-mopt input[type=checkbox]{width:14px;height:14px;cursor:pointer;flex:0 0 auto;}
    .pc-mopt span,.pc-mopt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .pc-rngadd{flex:0 0 auto;width:22px;height:20px;padding:0;border-radius:6px;cursor:pointer;
      border:1px dashed rgba(255,255,255,.28);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:18px;}
    .pc-rngadd:hover{background:rgba(255,255,255,.1);}
    /* 字段分组小标题（如联盟集结按目标分段） */
    .pc-fsec{margin:10px 0 2px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.14);
      font-size:12px;font-weight:600;color:#cfe8ff;letter-spacing:.5px;}
    .pc-fsec:first-child{margin-top:2px;padding-top:0;border-top:none;}
    .pc-empty{opacity:.5;font-size:12px;padding:4px 0;}
    .pc-btn{margin-top:10px;width:100%;padding:7px 0;border-radius:8px;cursor:pointer;
      border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e8eef7;
      font:inherit;transition:background .15s;}
    .pc-btn:hover{background:rgba(255,255,255,.16);}
    /* 采集规则字段（type:'minerules'，次元矿洞：每条=矿种下拉 + 等级下拉 + 星级★点选，可动态增删）。
       每条规则单行：盒子 flex:1 撑满整行（矿种/等级左侧簇集、星级靠右），× 删除按钮留在最右与标题行的＋对齐，盒与×靠 row gap 拉开固定间隔。行可增删，交互走面板级事件委托（见 wirePanel）。 */
    .pc-mrule{display:flex;flex-direction:column;gap:6px;width:100%;margin:2px 0 6px;}
    .pc-mruletop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-mradd{flex:0 0 auto;width:22px;height:20px;padding:0;border-radius:6px;cursor:pointer;
      border:1px dashed rgba(255,255,255,.28);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:18px;}
    .pc-mradd:hover{background:rgba(255,255,255,.1);}
    .pc-mrrow{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .pc-mrbox{display:flex;flex:1 1 auto;align-items:center;gap:9px;min-width:0;padding:6px 9px;
      border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.03);}
    .pc-mrsel{padding:3px 5px;border-radius:6px;border:1px solid rgba(255,255,255,.25);
      background:rgba(20,26,38,.9);color:#e8eef7;font:inherit;min-width:0;}
    .pc-mrtype{flex:0 1 auto;}
    .pc-mrlv{flex:0 0 auto;}
    .pc-mrdel{flex:0 0 auto;width:22px;height:24px;padding:0;border:none;background:transparent;
      color:#ff9c9c;font:inherit;font-size:16px;line-height:24px;cursor:pointer;text-align:center;}
    .pc-mrdel:hover{color:#ff6b6b;}
    .pc-mrtoggle{flex:0 0 auto;display:inline-flex;align-items:center;cursor:pointer;}
    .pc-mron{width:15px;height:15px;margin:0;cursor:pointer;accent-color:#4a9eff;}
    .pc-mrrow.off .pc-mrbox{opacity:.45;}
    .pc-mrstars{display:inline-flex;gap:3px;flex:0 0 auto;margin-left:auto;}
    .pc-mrstar{font-size:15px;line-height:1;cursor:pointer;color:rgba(255,255,255,.3);transition:transform .1s,color .1s;}
    .pc-mrstar.on{color:#ffcf4d;text-shadow:0 0 6px rgba(255,207,77,.5);}
    .pc-mrstar:hover{transform:scale(1.18);}
  `;

/**
 * 图标默认位置：右下角（留 24px 边距）
 * @returns {{x:number, y:number}}
 */
function defaultPos() {
  return { x: window.innerWidth - ICON_SIZE - 24, y: window.innerHeight - ICON_SIZE - 24 };
}

/**
 * 把坐标钉回视口可见范围内
 * @param {{x:number, y:number}} pos 待钉位置
 * @returns {{x:number, y:number}}
 */
function clampPos(pos) {
  return {
    x: Math.max(0, Math.min(pos.x, window.innerWidth - ICON_SIZE)),
    y: Math.max(0, Math.min(pos.y, window.innerHeight - ICON_SIZE)),
  };
}

/**
 * 视口变化时的宽松兜底：只保证至少露出 12px 可点，不要求整图标可见——
 * 保持与窗口左/上的边距不变，极端缩小致图标完全出屏时才拉回（区别于拖拽用的 clampPos）
 * @param {{x:number, y:number}} pos 逻辑位置
 * @returns {{x:number, y:number}}
 */
function rescuePos(pos) {
  return {
    x: Math.max(0, Math.min(pos.x, window.innerWidth - 12)),
    y: Math.max(0, Math.min(pos.y, window.innerHeight - 12)),
  };
}

/**
 * 卡片标题行 HTML：折叠箭头 + 标题 + 启用 checkbox（组用 pc-gen[data-gid]，功能用 pc-en[data-id]）
 * @param {string} label 标题文本
 * @param {string} chkHTML checkbox 片段
 * @param {boolean} expandable 是否可展开（否则箭头隐藏）
 * @returns {string}
 */
function cardHead(label, chkHTML, expandable) {
  return `<div class="pc-sec-head">` +
    `<span class="pc-chev${expandable ? '' : ' invisible'}">▶</span>` +
    `<span class="pc-sec-title">${label}</span>${chkHTML}</div>`;
}

/**
 * 多选开关组字段（type:'multiopts'，如次元矿洞按矿种多选）内层 HTML。
 * 选项集由 fd.options 提供：数组直接用，函数则每次求值时传当前 cfg（配置表运行时动态枚举）。
 * 选中态 configs[fid][fd.key] 为 number[]（命中的 option.value 集合）。勾选/取消由 wirePanel 事件委托接。
 * @param {number[]} selected 当前选中值数组
 * @param {object} fd 字段描述符（label / options / hint）
 * @param {object} cfg 该功能当前配置（透传给 fd.options 函数）
 * @returns {string}
 */
function multiOptsInnerHTML(selected, fd, cfg) {
  const opts = (typeof fd.options === 'function' ? fd.options(cfg) : fd.options) || [];
  const sel = Array.isArray(selected) ? selected : [];
  const cells = opts.map((o) => {
    const checked = sel.indexOf(o.value) >= 0 ? ' checked' : '';
    return `<label class="pc-mopt"><input type="checkbox" class="pc-moptchk" value="${o.value}"${checked}>${escAttr(String(o.label))}</label>`;
  }).join('');
  return `<div class="pc-mopstop">` +
      `<span class="pc-mopttitle">${escAttr(fd.label || '多选')}</span>` +
      `<span class="pc-moptacts"><button class="pc-moptall" type="button">全选</button>` +
      `<button class="pc-moptnone" type="button">清空</button></span>` +
    `</div>` +
    `<div class="pc-moptgrid">${cells || '<div class="pc-rnghint">暂无可选项</div>'}</div>` +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '');
}

/**
 * 采集规则字段（type:'minerules'，次元矿洞）内层 HTML：标题行（含右上＋）+ 若干规则块。
 * 每块单行：盒子「矿种▾ + 等级▾ + 星级★点选」居左，× 删除按钮靠右与标题行＋对齐。各维度 0 = 不限。
 * 矿种选项由 fd.options(cfg)、等级选项由 fd.levelOptions(cfg)、★颗数由 fd.maxStar(cfg) 提供；行增删/改值由 wirePanel 事件委托接。
 * @param {Array<{type:number,level:number,star:number}>} list 当前规则表
 * @param {object} fd 字段描述符（label / options / levelOptions / maxStar / hint）
 * @param {object} cfg 该功能当前配置（透传给 fd.options）
 * @returns {string}
 */
function mineRulesInnerHTML(list, fd, cfg) {
  const typeOpts = (typeof fd.options === 'function' ? fd.options(cfg) : fd.options) || [];
  const lvOpts = (typeof fd.levelOptions === 'function' ? fd.levelOptions(cfg) : fd.levelOptions) || [];
  const maxStar = (typeof fd.maxStar === 'function' ? fd.maxStar(cfg) : fd.maxStar) || 5;
  const optsHTML = (opts, sel) => opts.map((o) => `<option value="${o.value}"${Number(o.value) === sel ? ' selected' : ''}>${escAttr(String(o.label))}</option>`).join('');
  const rows = (Array.isArray(list) ? list : []).map((r, i) => {
    const type = Number(r.type) || 0, lv = Number(r.level) || 0, star = Number(r.star) || 0, act = !!r.enabled;
    let stars = '';
    for (let s = 1; s <= maxStar; s++) {
      const on = s <= star;
      stars += `<span class="pc-mrstar${on ? ' on' : ''}" data-part="star" data-star="${s}" title="${s} 星；再点当前星=不限">${on ? '★' : '☆'}</span>`;
    }
    return `<div class="pc-mrrow${act ? '' : ' off'}" data-midx="${i}">` +
      `<div class="pc-mrbox">` +
        `<select class="pc-mrsel pc-mrtype" data-part="type" title="矿种">${optsHTML(typeOpts, type)}</select>` +
        `<select class="pc-mrsel pc-mrlv" data-part="level" title="等级">${optsHTML(lvOpts, lv)}</select>` +
        `<span class="pc-mrstars" title="星级；再点当前星=不限">${stars}</span>` +
      `</div>` +
      `<label class="pc-mrtoggle" title="勾选后本条规则才生效"><input type="checkbox" class="pc-mron" data-part="enabled"${act ? ' checked' : ''}></label>` +
      `<button class="pc-mrdel" type="button" title="删除此规则">×</button>` +
      `</div>`;
  }).join('');
  return `<div class="pc-mruletop">` +
      `<span class="pc-rngtitle">${escAttr(fd.label || '采集规则')}</span>` +
      `<button class="pc-mradd" type="button" title="添加一条规则">＋</button>` +
    `</div>` +
    (rows || '<div class="pc-rnghint">未添加规则 = 不采集；添加后需勾选本条才生效</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '');
}

/**
 * 区间规则字段（type:'ranges'）内层 HTML：列头 + 若干 `[ from ~ to ) → count ×` 行 + 标题行右侧的「＋」。
 * 列头与数据行共用 rngRow 模板（括号类格子在列头只隐藏），否则三列无法逐列对齐；行号挂在 .pc-rngrow[data-ridx]，
 * 委托时靠它定位，不能用 querySelectorAll('.pc-rngrow') 的下标（会把列头行算进去，整体偏一位）。
 * @param {Array<{from:number,to:number,count:number}>} list 当前规则表
 * @param {object} fd 字段描述符（label / cols / hint 可选）
 * @returns {string}
 */
function rangesInnerHTML(list, fd) {
  const cols = fd.cols || ['大于等于', '小于', '数值'];
  const rngRow = (cells, ridx) => `<div class="pc-rngrow${ridx === undefined ? ' pc-rnghead' : ''}"` +
    (ridx === undefined ? '' : ` data-ridx="${ridx}"`) + `>` +
    `<span class="pc-rngop">[</span>${cells[0]}` +
    `<span class="pc-rngop">~</span>${cells[1]}` +
    `<span class="pc-rngop">)</span><span class="pc-rngop">→</span>${cells[2]}` +
    `${cells[3]}</div>`;
  const rows = (Array.isArray(list) ? list : []).map((r, i) => rngRow([
    `<input type="number" class="pc-rngn" data-part="from" min="0" step="1" value="${r.from | 0}" title="区间下界（含）">`,
    `<input type="number" class="pc-rngn" data-part="to" min="0" step="1" value="${r.to | 0}" title="区间上界（不含）；填 0 = 不封顶">`,
    `<input type="number" class="pc-rngn" data-part="count" min="0" step="1" value="${r.count | 0}" title="命中该区间的数值；填 0 = 该段不生效">`,
    `<button class="pc-rngdel" type="button" title="删除此档">×</button>`,
  ], i)).join('');
  return `<div class="pc-rngtop">` +
      `<span class="pc-rngtitle">${fd.label || '区间规则'}</span>` +
      `<button class="pc-rngadd" type="button" title="增加一档">＋</button>` +
    `</div>` +
    rngRow([`<span class="pc-rnglbl">${cols[0]}</span>`, `<span class="pc-rnglbl">${cols[1]}</span>`,
      `<span class="pc-rnglbl">${cols[2]}</span>`, `<span class="pc-rngdelcol"></span>`]) +
    (rows || '<div class="pc-rnghint">无档位，点右上＋添加</div>') +
    `<div class="pc-rnghint">${fd.hint || '先命中先生效；0 = 不封顶 / 不生效'}</div>`;
}

/**
 * 好友清单字段（type:'uidlist'）内层 HTML：标题行（含右上＋，达上限置 disabled）+ 若干 UID 行 + 上限 hint。
 * 每行是一个 .pc-uidwrap.pc-uli[data-uidx=i]（复用城市技能 UID 控件的视觉与显示↔输入态），行尾带 × 删除；
 * 与标量 UID 行的区别：值落在 configs[fid].friends[i].{uid,name}，故行不带 data-ukey/nkey，靠 data-uidx 定位。
 * @param {Array<{uid:string, name:string}>} list 当前好友清单
 * @param {object} fd 字段描述符（label / max / placeholder / hint 可选）
 * @returns {string}
 */
function uidListInnerHTML(list, fd) {
  const arr = Array.isArray(list) ? list : [];
  const max = fd.max || 10;
  const ph = escAttr(fd.placeholder || '');
  const rows = arr.map((it, i) => {
    const uidV = String((it && it.uid) || '');
    const nmV = String((it && it.name) || '');
    return `<div class="pc-uidwrap pc-uli" data-uidx="${i}">` +
      `<div class="pc-row"><span>好友 ${i + 1}</span>` +
      `<span class="pc-udisp" title="点击编辑 UID"><span class="pc-uedit">✎</span><span class="pc-uname">${escAttr(nmV || uidV)}</span></span>` +
      `<input type="text" class="pc-uinput" inputmode="numeric" hidden placeholder="${ph}">` +
      `<button class="pc-udel" type="button" title="删除此好友">×</button>` +
      `</div><div class="pc-uhint" hidden></div></div>`;
  }).join('');
  return `<div class="pc-ulisttop">` +
      `<span class="pc-rngtitle">${fd.label || '好友清单'}</span>` +
      `<button class="pc-ulistadd" type="button" title="添加好友"${arr.length >= max ? ' disabled' : ''}>＋</button>` +
    `</div>` +
    (rows || '<div class="pc-rnghint">无好友，点右上＋添加</div>') +
    `<div class="pc-rnghint">${fd.hint || ('最多 ' + max + ' 个；点＋添加，×删除')}</div>`;
}

/**
 * 装配好友清单容器（.pc-ulist）：为每个 UID 行绑显示态↔输入态状态机（失焦反查名字，写入 friends[idx]），
 * 并接＋/×（结构性改动 → 整块重刷 + 重绑）。configs[fid][key] 若仍是 descriptor defaults 本体先浅拷，
 * 避免就地 push/splice 污染 defaults（同 ranges 的坑）。
 * @param {HTMLElement} box .pc-ulist 容器
 */
function mountUidList(box) {
  const fid = box.dataset.id;
  const f = findFeature(fid);
  if (!f) return;
  const fd = f.fields.find((x) => x.key === box.dataset.akey);
  if (!fd) return;
  const c = configs[fid];
  if (!Array.isArray(c[fd.key])) c[fd.key] = [];
  if (c[fd.key] === f.defaults[fd.key]) c[fd.key] = c[fd.key].map((it) => ({ ...it }));
  const arr = c[fd.key];
  const max = fd.max || 10;

  const rerender = () => { box.innerHTML = uidListInnerHTML(arr, fd); mountUidList(box); };

  // ＋ / ×：结构性改动后整块重刷（索引会变，故重绑而非逐控件）
  const add = box.querySelector('.pc-ulistadd');
  if (add) add.addEventListener('click', (e) => {
    e.stopPropagation();
    if (arr.length >= max) return;
    arr.push({ uid: '', name: '' });
    rerender();
    const rows = box.querySelectorAll('.pc-uli');
    const last = rows[rows.length - 1];
    if (last && last.__pcEnterEdit) last.__pcEnterEdit();
    saveFeature(f); applyFeature(f);
  });
  box.querySelectorAll('.pc-udel').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = +btn.closest('.pc-uli').dataset.uidx;
      if (i >= 0 && i < arr.length) arr.splice(i, 1);
      rerender();
      saveFeature(f); applyFeature(f);
    });
  });

  // 每行 UID 控件：复用 setupUidField 的状态机，但读写 friends[idx].{uid,name}
  box.querySelectorAll('.pc-uli').forEach((wrap) => setupUidListRow(wrap, f, arr));
}

/**
 * 好友清单里的一行（.pc-uli）：显示态↔输入态 + 失焦用 PLAYER_INFO(630) 反查名字，成功才提交。
 * 与 setupUidField 同逻辑，差别只在值落在数组项 item.uid/item.name（而非 configs 的标量键）。
 * @param {HTMLElement} wrap .pc-uli 行容器
 * @param {object} f descriptor（saveFeature/applyFeature 用）
 * @param {Array<{uid:string, name:string}>} arr 当前好友清单（原地改）
 */
function setupUidListRow(wrap, f, arr) {
  const idx = +wrap.dataset.uidx;
  const disp = wrap.querySelector('.pc-udisp');
  const nameEl = wrap.querySelector('.pc-uname');
  const input = wrap.querySelector('.pc-uinput');
  const hint = wrap.querySelector('.pc-uhint');
  const item = () => arr[idx] || (arr[idx] = { uid: '', name: '' });
  let lastBad = null;

  function renderDisplay() {
    const it = item();
    const v = String(it.name || it.uid || '');
    nameEl.textContent = v || input.placeholder || '未设置';
    nameEl.classList.toggle('pc-uempty', !v);
    disp.hidden = false;
    input.hidden = true;
    input.disabled = false;
    input.classList.remove('pc-uerr');
    hint.hidden = true;
  }
  function enterEdit() {
    hint.hidden = true;
    input.value = String(item().uid || '');
    input.classList.remove('pc-uerr');
    disp.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }
  function failEdit(msg) {
    input.disabled = false;
    input.classList.add('pc-uerr');
    hint.textContent = msg;
    hint.hidden = false;
    input.focus();
  }

  disp.addEventListener('click', (e) => { e.stopPropagation(); enterEdit(); });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); lastBad = null; renderDisplay(); }
  });
  input.addEventListener('blur', async () => {
    if (!wrap.isConnected) return;         // 容器已重刷，丢弃
    const it = item();
    const oldUid = String(it.uid || '');
    const val = input.value.trim();
    if (val === '') {                       // 清空：提交空 UID/名字，不查
      lastBad = null;
      if (oldUid || it.name) { it.uid = ''; it.name = ''; saveFeature(f); applyFeature(f); }
      renderDisplay();
      return;
    }
    if (val === oldUid) { lastBad = null; renderDisplay(); return; }   // 未变，不查
    if (val === lastBad) { failEdit(hint.textContent || '玩家不存在，请检查 UID'); return; }
    input.disabled = true;
    nameEl.textContent = '查询中…';
    const res = await lookupPlayerName(val);
    if (!wrap.isConnected) return;          // 面板已重刷，丢弃回写
    if (res.ok) {
      lastBad = null;
      it.uid = val; it.name = res.name || '';
      saveFeature(f); applyFeature(f);
      renderDisplay();
    } else {
      lastBad = val;
      failEdit(res.msg || '玩家不存在，请检查 UID');
    }
  });

  wrap.__pcUidRefresh = renderDisplay;
  wrap.__pcEnterEdit = enterEdit;
  renderDisplay();
}

/**
 * 转义写入属性选择器/属性值的双引号与尖括号、&（供可编辑文本字段回填 value）
 * @param {string} s 原值
 * @returns {string}
 */
function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @type {number} RequestId.PLAYER_INFO（同 chat-window 口径），按 uid 查玩家基础信息，应答 d.playerInfo 为内层 JSON 串 */
const CMD_PLAYER_INFO = 630;

/**
 * 字符串载荷尝试 JSON.parse；非串或失败原样返回
 * @param {*} s 原值
 * @returns {*} 解析结果
 */
function parseMaybe(s) {
  if (typeof s !== 'string' || !s) return s;
  try { return JSON.parse(s); } catch (e) { return s; }
}

/**
 * 从 630 应答取展示昵称（微信资料内层串 username/nickname 优先，回退顶层 nickname/name）
 * @param {object} d 应答顶层 parse 产物
 * @returns {string}
 */
function nickFrom630(d) {
  var wx = d && d.playerInfo;
  if (typeof wx === 'string') wx = parseMaybe(wx);
  return String((wx && (wx.username || wx.nickname)) || (d && (d.nickname || d.name)) || '');
}

/**
 * 用 UID 查玩家名（PLAYER_INFO 630）。永不 reject；失败回 {ok:false,msg}（含格式预校，避免无谓请求）
 * @param {string} uid 玩家 UID（数字串）
 * @returns {Promise<{ok:boolean, name?:string, msg?:string}>}
 */
async function lookupPlayerName(uid) {
  const net = window.pocketcc && window.pocketcc.net;
  if (!net || !net.send) return { ok: false, msg: '网络未就绪' };
  if (!/^\d{4,20}$/.test(uid)) return { ok: false, msg: 'UID 格式不正确' };
  let ret;
  try {
    ret = await net.send(CMD_PLAYER_INFO, { uid });
  } catch (e) {
    return { ok: false, msg: '查询失败，请重试' };
  }
  if (!ret || !ret.ok) return { ok: false, msg: '玩家不存在（查询被拒）' };
  const d = parseMaybe(ret.data);
  if (!d || typeof d !== 'object') return { ok: false, msg: '玩家不存在' };
  return { ok: true, name: nickFrom630(d) };
}

/**
 * 装配一个 UID 复合行（.pc-uidwrap）：显示态↔输入态切换 + 失焦反查名字 + 成功才提交。
 * 名字随 UID 写入 configs[fd.nameKey]（持久化），下次开面板直接显缓存名、零查询。
 * @param {HTMLElement} wrap .pc-uidwrap 容器
 */
function setupUidField(wrap) {
  const fid = wrap.dataset.id;
  const ukey = wrap.dataset.ukey;
  const nkey = wrap.dataset.nkey;
  const disp = wrap.querySelector('.pc-udisp');
  const nameEl = wrap.querySelector('.pc-uname');
  const input = wrap.querySelector('.pc-uinput');
  const hint = wrap.querySelector('.pc-uhint');
  const cur = () => configs[fid] || {};
  let lastBad = null;   // 同一无效值不重复查

  function renderDisplay() {
    const c = cur();
    const v = String(c[nkey] || c[ukey] || '');
    nameEl.textContent = v || input.placeholder || '未设置';
    nameEl.classList.toggle('pc-uempty', !v);   // 空值显占位提示（弱化），非空显玩家名/UID
    disp.hidden = false;
    input.hidden = true;
    input.disabled = false;
    input.classList.remove('pc-uerr');
    hint.hidden = true;
  }
  function enterEdit() {
    hint.hidden = true;
    input.value = String(cur()[ukey] || '');
    input.classList.remove('pc-uerr');
    disp.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }
  function failEdit(msg) {
    input.disabled = false;
    input.classList.add('pc-uerr');
    hint.textContent = msg;
    hint.hidden = false;
    input.focus();
  }

  disp.addEventListener('click', (e) => { e.stopPropagation(); enterEdit(); });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); lastBad = null; renderDisplay(); }
  });
  input.addEventListener('blur', async () => {
    const c = cur();
    const f = findFeature(fid);
    const oldUid = String(c[ukey] || '');
    const val = input.value.trim();
    if (val === '') {                       // 清空：提交空 UID/名字，不查
      lastBad = null;
      if (oldUid || c[nkey]) { c[ukey] = ''; c[nkey] = ''; if (f) { saveFeature(f); applyFeature(f); } }
      renderDisplay();
      return;
    }
    if (val === oldUid) { lastBad = null; renderDisplay(); return; }   // 未变，不查
    if (val === lastBad) { failEdit(hint.textContent || '玩家不存在，请检查 UID'); return; }   // 同一无效值不重查
    input.disabled = true;
    nameEl.textContent = '查询中…';
    const res = await lookupPlayerName(val);
    if (!wrap.isConnected) return;          // 面板已重建，丢弃回写
    if (res.ok) {
      lastBad = null;
      c[ukey] = val; c[nkey] = res.name || '';
      if (f) { saveFeature(f); applyFeature(f); }
      renderDisplay();
    } else {
      lastBad = val;
      failEdit(res.msg || '玩家不存在，请检查 UID');
    }
  });

  wrap.__pcUidRefresh = renderDisplay;
  renderDisplay();
}

/**
 * descriptor fields -> 行 HTML（checkbox / text 只读惰性求值 / 数字输入 / 下拉 / 区间规则）。
 * fd.section 变化时插入分组小标题（如联盟集结按战锤/惧星/难民营分段），容器带 data-id=功能 id。
 * @param {string} fid 功能 id
 * @param {object} f descriptor
 * @returns {string}
 */
function buildFieldsHTML(fid, f) {
  const c = configs[fid];
  let lastSection;
  return f.fields.map((fd) => {
    let sec = '';
    if (fd.section && fd.section !== lastSection) sec = `<div class="pc-fsec">${fd.section}</div>`;
    lastSection = fd.section || null;
    let row;
    if (fd.type === 'checkbox') {
      row = `<label class="pc-row"><span>${fd.label}</span>` +
        `<input type="checkbox" class="pc-fchk" data-id="${fid}" data-key="${fd.key}" ${c[fd.key] ? 'checked' : ''}></label>`;
    } else if (fd.type === 'text') {
      const v = fd.get ? String(fd.get(c)) : '';
      if (fd.multiline) {
        // 多行只读值（如「今日进度」一长串统计）：标签与值上下排、值整行换行，避免窄卡片里被 ellipsis 截断
        row = `<div class="pc-row pc-rowcol"><span>${fd.label}</span>` +
          `<span class="pc-fval pc-fvalml" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></div>`;
      } else {
        row = `<label class="pc-row"><span>${fd.label}</span>` +
          `<span class="pc-fval" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></label>`;
      }
    } else if (fd.type === 'select') {
      const cur = String(c[fd.key]);
      const opts = (fd.options || []).map((o) =>
        `<option value="${o.value}"${String(o.value) === cur ? ' selected' : ''}>${o.label}</option>`).join('');
      row = `<label class="pc-row"><span>${fd.label}</span>` +
        `<select class="pc-fsel" data-id="${fid}" data-key="${fd.key}">${opts}</select></label>`;
    } else if (fd.type === 'string') {
      // 可编辑文本字段（如城市技能目标 UID）：按字符串存档，change 时 trim 落盘 + 热更
      row = `<label class="pc-row"><span>${fd.label}</span>` +
        `<input type="text" class="pc-fstr" data-id="${fid}" data-key="${fd.key}" placeholder="${escAttr(fd.placeholder)}" value="${escAttr(c[fd.key])}"></label>`;
    } else if (fd.type === 'uid') {
      // UID 复合行（城市技能）：显示态「✎ 玩家名」点击转输入态，失焦用 PLAYER_INFO(630) 反查名字。
      // 名字随 UID 一起持久化(fd.nameKey)，开面板直接显缓存名、零查询；仅 UID 变了才查。失败留框+红字不提交。
      // 勾选框(data-key=enableKey)最右，复用 .pc-fchk 处理器；输入框用独立类 .pc-uinput，避开通用 .pc-fstr 即时存档逻辑。
      const uidV = String(c[fd.key] || '');
      const nmV = String(c[fd.nameKey] || '');
      row = `<div class="pc-uidwrap" data-id="${fid}" data-ukey="${fd.key}" data-nkey="${fd.nameKey}" data-ekey="${fd.enableKey}">` +
        `<div class="pc-row"><span>${fd.label}</span>` +
        `<span class="pc-udisp" title="点击编辑 UID"><span class="pc-uedit">✎</span><span class="pc-uname">${escAttr(nmV || uidV)}</span></span>` +
        `<input type="text" class="pc-uinput" inputmode="numeric" hidden placeholder="${escAttr(fd.placeholder)}">` +
        `<input type="checkbox" class="pc-fchk" data-id="${fid}" data-key="${fd.enableKey}" ${c[fd.enableKey] ? 'checked' : ''}>` +
        `</div><div class="pc-uhint" hidden></div></div>`;
    } else if (fd.type === 'ranges') {
      // 区间规则占整行（不套 pc-row）：容器带 fid/key，行内控件靠 closest('.pc-rng') 回属
      return sec + `<div class="pc-rng" data-id="${fid}" data-rkey="${fd.key}">` +
        rangesInnerHTML(c[fd.key], fd) + `</div>`;
    } else if (fd.type === 'uidlist') {
      // 好友清单（玩家点赞）：动态增删的 UID 行，整行返回（不套 pc-row），容器带 fid/key 供 mountUidList 重绑
      return sec + `<div class="pc-ulist" data-id="${fid}" data-akey="${fd.key}">` +
        uidListInnerHTML(c[fd.key], fd) + `</div>`;
    } else if (fd.type === 'multiopts') {
      // 多选开关组（次元矿洞矿种）：整行返回，选项由 fd.options(cfg) 动态求值（可为函数或常量数组）
      return sec + `<div class="pc-mopts" data-id="${fid}" data-mkey="${fd.key}">` +
        multiOptsInnerHTML(c[fd.key], fd, c) + `</div>`;
    } else if (fd.type === 'minerules') {
      // 采集规则（次元矿洞）：整行返回（不套 pc-row），行可增删，容器带 fid/key 供委托与重刷
      return sec + `<div class="pc-mrule" data-id="${fid}" data-mrkey="${fd.key}">` +
        mineRulesInnerHTML(c[fd.key], fd, c) + `</div>`;
    } else {
      row = `<label class="pc-row"><span>${fd.label}</span>` +
        `<input type="number" data-id="${fid}" data-key="${fd.key}" min="${fd.min}" step="${fd.step}" value="${c[fd.key]}"></label>`;
    }
    return sec + row;
  }).join('');
}

/**
 * 组卡片：主闸门 checkbox（pc-gen）+ 展开=子项 checkbox 列表（pc-en）。子项详细参数不展示。
 * @param {object} node menu.js 组节点
 * @returns {string}
 */
function renderGroupCard(node) {
  const gc = configs[node.id] || { enabled: false };
  const chk = `<input type="checkbox" class="pc-gen" data-gid="${node.id}" ${gc.enabled ? 'checked' : ''}>`;
  const rows = (node.children || []).map((ch) => {
    const c = configs[ch.id] || { enabled: false };
    const f = findFeature(ch.id);
    return `<label class="pc-row"><span>${ch.label || (f && f.label) || ch.id}</span>` +
      `<input type="checkbox" class="pc-en" data-id="${ch.id}" ${c.enabled ? 'checked' : ''}></label>`;
  }).join('');
  return `<div class="pc-sec" data-gid="${node.id}">` +
    cardHead(node.label, chk, true) +
    `<div class="pc-sec-body" hidden>${rows || '<div class="pc-empty">无子项</div>'}</div></div>`;
}

/**
 * 功能卡片：启用 checkbox（pc-en，直驱本功能 enabled）；showFields 时可展开详细字段。
 * @param {object} node menu.js 功能节点
 * @returns {string}
 */
function renderFeatureCard(node) {
  const fid = node.id;
  const c = configs[fid] || { enabled: false };
  const f = findFeature(fid);
  const expandable = !!node.showFields && !!f;
  const chk = `<input type="checkbox" class="pc-en" data-id="${fid}" ${c.enabled ? 'checked' : ''}>`;
  const head = cardHead(node.label || (f && f.label) || fid, chk, expandable);
  if (!expandable) return `<div class="pc-sec" data-fid="${fid}">${head}</div>`;
  const fields = buildFieldsHTML(fid, f);
  return `<div class="pc-sec" data-fid="${fid}">${head}` +
    `<div class="pc-sec-body" hidden>${fields || '<div class="pc-empty">无可调参数</div>'}</div></div>`;
}

/** @type {string} 挂「登出 / 换号」按钮的类别 id（账号级操作，归入系统设置） */
const LOGOUT_PANE_ID = 'system';
/**
 * 一个类别 = 右栏一个 pane，children 里 group/feature 分别渲染成卡片
 * @param {object} cat menu.js 类别节点
 * @param {boolean} active 是否为当前可见 pane
 * @returns {string}
 */
function renderCategoryPane(cat, active) {
  const cards = (cat.children || []).map((n) => (n.kind === 'group' ? renderGroupCard(n) : renderFeatureCard(n))).join('');
  const extra = cat.id === LOGOUT_PANE_ID
    ? `<button class="pc-btn" id="pc-logout">登出 / 换号</button>` : '';
  return `<div class="pc-pane" data-pane="${cat.id}"${active ? '' : ' hidden'}>${cards || '<div class="pc-empty">无内容</div>'}${extra}</div>`;
}

/**
 * 面板主体 HTML：标题 + 战斗模式开关 + 左 TAB 条 + 右内容区
 * @returns {string}
 */
function buildPanelHTML() {
  const tabs = MENU.map((c, i) =>
    `<button class="pc-tab${i === 0 ? ' active' : ''}" data-tab="${c.id}">${c.label}</button>`).join('');
  const panes = MENU.map((c, i) => renderCategoryPane(c, i === 0)).join('');
  return `
      <h3>口袋控制中心<span class="pc-sub">POCKETCC</span></h3>
      <label class="pc-mode"><span>战斗模式</span><input type="checkbox" id="pc-combat"></label>
      <div class="pc-tabs">
        <div class="pc-tabbar">${tabs}</div>
        <div class="pc-tabpanes">${panes}</div>
      </div>`;
}

/**
 * 刷新面板内所有 type:'text' 只读字段：按 descriptor.get() 重算当前值。
 * 面板打开 / 卡片展开 / 切 TAB 时调用，无需定时器（避免常驻轮询）。
 * @param {Element} root 扫描范围（面板或单个 pane/body）
 */
function refreshTexts(root) {
  root.querySelectorAll('.pc-fval').forEach((span) => {
    const f = findFeature(span.dataset.fid);
    if (!f) return;
    const fd = f.fields.find((x) => x.key === span.dataset.fkey);
    if (!fd || !fd.get) return;
    const next = String(fd.get(configs[f.id]) || '');
    if (span.textContent !== next) span.textContent = next;
  });
}

/**
 * 降级补载后把全部控件回写为新 configs 的态（只改值不重建，保留折叠/TAB 展开态），末尾刷 text 字段。
 * @param {Element} panel 面板根元素
 */
function syncControls(panel) {
  panel.querySelectorAll('.pc-gen').forEach((cb) => {
    const gc = configs[cb.dataset.gid];
    if (gc) cb.checked = !!gc.enabled;
  });
  panel.querySelectorAll('.pc-en').forEach((cb) => {
    const c = configs[cb.dataset.id];
    if (c) cb.checked = !!c.enabled;
  });
  panel.querySelectorAll('input.pc-fchk').forEach((cb) => { cb.checked = !!configs[cb.dataset.id][cb.dataset.key]; });
  panel.querySelectorAll('input[type=number]').forEach((input) => {
    if (!input.dataset.id) return;   // 区间规则行内的数字格靠 data-part 定位，不占 data-id/data-key
    const v = configs[input.dataset.id][input.dataset.key];
    if (v !== undefined) input.value = v;
  });
  panel.querySelectorAll('select.pc-fsel').forEach((sel) => {
    const v = configs[sel.dataset.id][sel.dataset.key];
    if (v !== undefined) sel.value = String(v);
  });
  panel.querySelectorAll('input.pc-fstr').forEach((input) => {
    const v = configs[input.dataset.id][input.dataset.key];
    if (v !== undefined) input.value = v;
  });
  // UID 复合行：若当前处于显示态，按最新 configs 回写名字/UID（输入态下不打断用户编辑）
  // 好友清单的行（.pc-uli）不在此列：它们随下方 .pc-ulist 整块重刷，避免重复回写
  panel.querySelectorAll('.pc-uidwrap').forEach((w) => { if (!w.classList.contains('pc-uli') && w.__pcUidRefresh) w.__pcUidRefresh(); });
  // 区间规则：整块重刷内层（行数可增可减，不能只回写值）
  panel.querySelectorAll('.pc-rng').forEach((box) => {
    const f = findFeature(box.dataset.id);
    if (!f) return;
    const fd = f.fields.find((x) => x.key === box.dataset.rkey);
    if (!fd) return;
    box.innerHTML = rangesInnerHTML(configs[f.id][fd.key], fd);
  });
  // 好友清单：整块重刷 + 重绑（同 ranges，行数可增删）
  panel.querySelectorAll('.pc-ulist').forEach(mountUidList);
  // 多选开关组：整块重刷内层（选项动态枚举、选中态为 number[]，不能只回写单个值）
  panel.querySelectorAll('.pc-mopts').forEach((box) => {
    const f = findFeature(box.dataset.id);
    if (!f) return;
    const fd = f.fields.find((x) => x.key === box.dataset.mkey);
    if (!fd) return;
    box.innerHTML = multiOptsInnerHTML(configs[f.id][fd.key], fd, configs[f.id]);
  });
  // 采集规则：整块重刷内层（行可增删，同 ranges）
  panel.querySelectorAll('.pc-mrule').forEach((box) => {
    const f = findFeature(box.dataset.id);
    if (!f) return;
    const fd = f.fields.find((x) => x.key === box.dataset.mrkey);
    if (!fd) return;
    box.innerHTML = mineRulesInnerHTML(configs[f.id][fd.key], fd, configs[f.id]);
  });
  refreshTexts(panel);
}

/**
 * 图标位置读盘（含旧全局键一次性认领）：新 UID 键无值且无前缀旧键有值时，视旧值为当前玩家所有，写入命名空间后删旧键。
 * 旧键是字面无前缀值，必须用 getRaw/removeRaw（否则又被自动拼上 UID 前缀，永远读不到）。
 * 每步各自兜底：storage.get 在 UID 前缀未设时是 reject（不是回 null），这里绝不能再往上抛——
 * mountUI  await 了本函数，抛出来会让后面的控件回写与事件绑定全部落空；读不到就用默认位置，本次不认领旧键。
 * @returns {Promise<{x:number, y:number}>}
 */
async function readIconPos() {
  let pos = null;
  try {
    pos = await storage.get(POS_KEY);
  } catch (err) {
    logCore.warn('read icon pos failed (storage unavailable): %s', err && err.message);
  }
  if (!pos) {
    try {
      pos = await storage.getRaw(POS_KEY);
    } catch (err) {
      logCore.warn('read legacy icon pos failed: %s', err && err.message);
      pos = null;
    }
    if (pos) {
      // 认领失败（写盘被丢弃等）不影响本次使用：内存里照这个位置摆，下次启动再重试认领
      try {
        await storage.set(POS_KEY, pos);
        await storage.removeRaw(POS_KEY);
      } catch (err) {
        logCore.warn('adopt legacy icon pos failed, keep in-memory only: %s', err && err.message);
      }
    }
  }
  return clampPos(pos || defaultPos());
}

/**
 * 挂载浮动图标与面板（Shadow DOM 隔离）。幂等：已挂载则直接返回。
 * @returns {Promise<void>}
 */
export async function mountUI() {
  if (document.getElementById('pocketcc-host')) return;

  const host = document.createElement('div');
  host.id = 'pocketcc-host';
  host.style.cssText = 'all:initial;';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  root.appendChild(style);

  const icon = document.createElement('div');
  icon.className = 'pc-icon';
  icon.title = '口袋控制中心';

  /** 图标随战斗态切换：换 SVG（冷/热）+ 切 .combat 类（光晕节奏/配色、外发光跟随）。 */
  function renderIcon() {
    icon.classList.toggle('combat', isCombat());
    icon.innerHTML = '<span class="pc-halo"></span>' + iconSVG(isCombat(), ICON_SIZE);
  }
  renderIcon();
  bus.on('mode.change', renderIcon);

  const panel = document.createElement('div');
  panel.className = 'pc-panel';
  panel.hidden = true;
  panel.innerHTML = buildPanelHTML();

  root.appendChild(icon);
  root.appendChild(panel);
  document.body.appendChild(host);

  wirePanel(panel);

  // 战斗模式复选框随模式广播同步（含下面的 F8 热键切换，避免图标翻了但面板未跟着变）
  bus.on('mode.change', () => { const cb = panel.querySelector('#pc-combat'); if (cb) cb.checked = isCombat(); });
  // F8 热键：战斗 / 日常 切换（setCombatMode 广播 mode.change → 图标/复选框/reactor 门控重算自动跟进）。
  // 必须用 window 捕获阶段（capture:true）：游戏自己也会处理 keydown 并在冒泡阶段 stopPropagation，
  // 导致面板收起（焦点在画布）时挂 document 冒泡监听收不到；捕获阶段先于游戏处理且不受焦点/stopPropagation 影响。
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F8') { e.preventDefault(); setCombatMode(!isCombat()); }
  }, true);

  // 功能侧主动推面板刷新（如联盟集结今日计数 +1）；emit 同步，open 时才扫 DOM
  bus.on('ui.refresh', function () { if (!panel.hidden) refreshTexts(panel); });

  let pos = await readIconPos();
  applyPos(pos);

  // 视口变化（窗口缩放/F11 全屏等）：右上锚定——保持与视口上/右两边的距离，
  // 宽度变化时按旧右距重算 x（图标跟着右缘走），y 不变；完全出屏时 rescuePos 兜底
  let resizeTimer = null;
  let lastVW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const nvw = window.innerWidth;
      const rightGap = lastVW - (pos.x + ICON_SIZE); // 图标右缘到旧视口右边距（拖拽 clampPos 保证 ≥0）
      pos = clampPos({ x: nvw - rightGap - ICON_SIZE, y: pos.y }); // 新视口过窄时贴左/右缘兜底
      lastVW = nvw;
      applyPos(rescuePos(pos));
      if (!panel.hidden) placePanel();
      storage.set(POS_KEY, pos); // x 语义已随视口平移，同步存档
    }, 120);
  });

  // 控件回写只在降级补载后发生（player.configs-reloaded，见 registry）；换号已改为整页 reload，无需 in-place 回写。
  bus.on('player.configs-reloaded', (e) => {
    if (e && e.uid && getUid() && e.uid !== getUid()) return; // UID 已变，丢弃过期的补载
    syncControls(panel);
  });

  /**
   * 写图标坐标
   * @param {{x:number, y:number}} p 位置
   */
  function applyPos(p) {
    icon.style.left = `${p.x}px`;
    icon.style.top = `${p.y}px`;
  }

  /**
   * 把面板摆到图标上方（放不下则往下），先量高再定位
   */
  function placePanel() {
    const rect = icon.getBoundingClientRect();
    let left = rect.right - PANEL_W;
    if (left < 8) left = 8;
    if (left + PANEL_W > window.innerWidth - 8) left = window.innerWidth - PANEL_W - 8;
    panel.style.left = `${left}px`;
    panel.style.visibility = 'hidden';
    panel.hidden = false;
    const panelH = panel.offsetHeight;
    panel.hidden = true;
    panel.style.visibility = '';
    let top = rect.top - panelH - 12;
    if (top < 8) top = rect.bottom + 12;
    // 图标靠下 + 面板较高时上/下两方案都可能探出视口：再钉一次，保证整块可见（CSS 已把面板高限到 100vh-16）
    top = Math.max(8, Math.min(top, window.innerHeight - panelH - 8));
    panel.style.top = `${top}px`;
  }

  /** 展开面板并刷一次只读字段 */
  function openPanel() { placePanel(); panel.hidden = false; refreshTexts(panel); }
  /** 收起面板 */
  function closePanel() { panel.hidden = true; }

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  icon.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    originX = pos.x;
    originY = pos.y;
    icon.setPointerCapture(e.pointerId);
  });

  icon.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true;
    pos = clampPos({ x: originX + dx, y: originY + dy });
    applyPos(pos);
    if (!panel.hidden) placePanel();
  });

  icon.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    icon.releasePointerCapture(e.pointerId);
    if (moved) {
      storage.set(POS_KEY, pos);
    } else {
      panel.hidden ? openPanel() : closePanel();
    }
  });

  // 点击外部收起：shadow DOM 内事件在 document 上 target 被重定向为 host
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    if (e.target === host || host.contains(e.target)) return;
    closePanel();
  }, true);
}

// ─────────────────────── 面板交互 ───────────────────────

/**
 * 菜单树按 id 找节点（组卡片需要它收集子项功能 id 做主闸门级联）
 * @param {string} id 节点 id
 * @returns {object|null}
 */
function findMenuNode(id) {
  let hit = null;
  const walk = (nodes) => nodes.some((n) => {
    if (n.id === id) { hit = n; return true; }
    return !!(n.children && walk(n.children));
  });
  walk(MENU);
  return hit;
}

/**
 * 组闸门级联后的控件回写：子项 checkbox 跟 configs 走（组半开态无需呈现，全有或全无）。
 * @param {Element} sec 组卡片容器
 */
function syncFeatureChecks(sec) {
  sec.querySelectorAll('.pc-en').forEach((cb) => {
    const c = configs[cb.dataset.id];
    if (c) cb.checked = !!c.enabled;
  });
}

/**
 * 给面板绑定交互：TAB 切换 / 卡片折叠 / 组主闸门级联 / 功能开关 / 字段改值 / 登出 / 战斗模式。
 * 所有改动即存档（saveFeature/saveGroup）并实时编排（applyFeature）。
 * @param {Element} panel 面板根元素
 */
function wirePanel(panel) {
  // TAB 切换：只换右栏 pane 的可见性，切换后刷一次只读 text 字段。
  panel.querySelectorAll('.pc-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab;
      panel.querySelectorAll('.pc-tab').forEach((t) => t.classList.toggle('active', t === tab));
      panel.querySelectorAll('.pc-pane').forEach((p) => { p.hidden = p.dataset.pane !== id; });
      const pane = panel.querySelector(`.pc-pane[data-pane="${id}"]`);
      if (pane) refreshTexts(pane);
    });
  });

  // 卡片折叠：点标题行展开/收起（仅带 body 的卡片可折叠）；点开关本身不触发折叠。
  panel.querySelectorAll('.pc-sec-head').forEach((head) => {
    head.addEventListener('click', (e) => {
      if (e.target.classList.contains('pc-gen') || e.target.classList.contains('pc-en')) return;
      const sec = head.parentElement;
      const body = sec.querySelector('.pc-sec-body');
      if (!body) return; // 无展开内容的卡片（快捷战斗/日志）不折叠
      const open = body.hidden;
      body.hidden = !open;
      sec.classList.toggle('open', open);
      if (open) refreshTexts(body);
    });
  });

  // 组主闸门：关→子项全部 enabled=false；开→恢复各子项 intentEnabled（用户意图，组关不丢失）。
  // 组自身 enabled 单独存档（menu.js 声明的组键）；不新增 reactor 门控，级联后逐个 save+apply。
  panel.querySelectorAll('.pc-gen').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const gid = cb.dataset.gid;
      const gc = configs[gid];
      if (!gc) { logCore.warn('group config missing: %s', gid); return; }
      gc.enabled = cb.checked;
      saveGroup(gid);
      const node = findMenuNode(gid);
      const ids = node ? collectFeatureIds(node) : [];
      for (const fid of ids) {
        const f = findFeature(fid);
        const c = configs[fid];
        if (!f || !c) continue;
        c.enabled = cb.checked ? !!c.intentEnabled : false;
        saveFeature(f);
        applyFeature(f);
      }
      const sec = cb.closest('.pc-sec');
      if (sec) syncFeatureChecks(sec);
      logCore.info(`group ${gid} ${cb.checked ? 'enabled' : 'disabled'} (cascade ${ids.length} features)`);
    });
  });

  // 功能启用开关（功能卡片 checkbox / 组内子项 checkbox）：同步 intentEnabled（意图）+ enabled（生效态）。
  panel.querySelectorAll('.pc-en').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const f = findFeature(cb.dataset.id);
      if (!f || !configs[f.id]) { logCore.warn('feature not registered: %s', cb.dataset.id); return; }
      configs[f.id].enabled = cb.checked;
      configs[f.id].intentEnabled = cb.checked;
      saveFeature(f);
      applyFeature(f);
      logCore.info(`feature ${f.id} ${cb.checked ? 'enabled' : 'disabled'}`);
    });
  });

  // 功能字段勾选框（type:'checkbox' 的 field，如按集结目标单独开关）：改动即存档 + 热更
  panel.querySelectorAll('input.pc-fchk').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const f = findFeature(cb.dataset.id);
      if (!f) return;
      configs[f.id][cb.dataset.key] = cb.checked;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 数字字段：钳制到 min，存档 + 运行中热更（区间规则行内的数字格无 data-id，归 wirePanel 末尾的委托处理）
  panel.querySelectorAll('input[type=number]').forEach((input) => {
    if (!input.dataset.id) return;
    input.addEventListener('change', () => {
      const f = findFeature(input.dataset.id);
      if (!f) return;
      const fd = f.fields.find((x) => x.key === input.dataset.key);
      let v = parseInt(input.value, 10);
      if (isNaN(v)) v = f.defaults[fd.key];
      v = Math.max(fd.min, v);
      input.value = v;
      configs[f.id][fd.key] = v;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 下拉字段（如战争之源按形态选预设部队）：值取 option 的整数值，存档 + 运行中热更
  panel.querySelectorAll('select.pc-fsel').forEach((sel) => {
    sel.addEventListener('change', () => {
      const f = findFeature(sel.dataset.id);
      if (!f) return;
      const fd = f.fields.find((x) => x.key === sel.dataset.key);
      let v = parseInt(sel.value, 10);
      if (isNaN(v)) v = f.defaults[fd.key];
      sel.value = String(v);
      configs[f.id][fd.key] = v;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 可编辑文本字段（如城市技能赠送 UID）：点输入框不触发卡片折叠，改动 trim 后按字符串存档 + 热更
  panel.querySelectorAll('input.pc-fstr').forEach((input) => {
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      const f = findFeature(input.dataset.id);
      if (!f) return;
      const fd = f.fields.find((x) => x.key === input.dataset.key);
      const v = input.value.trim();
      input.value = v;
      configs[f.id][fd.key] = v;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // UID 复合行（type:'uid'，城市技能）：装配显示态↔输入态切换 + 失焦反查名字（见 setupUidField）。
  // 行内勾选框是 .pc-fchk，已由上面的通用处理器接好；这里只管输入控件的状态机。
  // 好友清单的行（.pc-uli）走下方 mountUidList 单独装配，此处排除。
  panel.querySelectorAll('.pc-uidwrap').forEach((w) => { if (!w.classList.contains('pc-uli')) setupUidField(w); });

  // 好友清单字段（type:'uidlist'，玩家点赞）：逐容器装配（行状态机 + ＋/× 增删，见 mountUidList）。
  panel.querySelectorAll('.pc-ulist').forEach(mountUidList);

  panel.querySelector('#pc-logout').addEventListener('click', () => {
    session.logout(); // 游戏登出（PlatformCore 符号收口于 core/game-api.js 防腐层）
  });

  // 区间规则字段（如联盟机甲按召唤所需碎片数分段）：行可动态增删，故用面板级事件委托而非逐控件绑定。
  // 行号只取自行上的 data-ridx（列头行没这个属性）：按 .pc-rngrow 的下标数会把列头算进去，整体偏一位。
  const rngIdx = (el) => {
    const row = el && el.closest ? el.closest('.pc-rngrow[data-ridx]') : null;
    return row ? +row.dataset.ridx : -1;
  };
  const rangesTarget = (el) => {
    const box = el && el.closest ? el.closest('.pc-rng') : null;
    if (!box) return null;
    const f = findFeature(box.dataset.id);
    if (!f) return null;
    const fd = f.fields.find((x) => x.key === box.dataset.rkey);
    if (!fd) return null;
    const c = configs[f.id];
    if (!Array.isArray(c[fd.key])) c[fd.key] = [];
    // 读到的是 descriptor defaults 本体（loadAllConfigs 的 Object.assign 不深拷）：
    // 先换一份浅拷，否则增删行会就地污染 defaults，连带影响无存档时的默认规则
    if (c[fd.key] === f.defaults[fd.key]) c[fd.key] = c[fd.key].map((r) => ({ ...r }));
    return { f, fd, box, list: c[fd.key] };
  };
  // 敲一个字就同步进内存（不落盘、不重刷 DOM）：否则未 blur 的编辑会被增删行的整块重刷吞掉，看着像“清空已填”
  panel.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp.classList || !inp.classList.contains('pc-rngn')) return;
    const t = rangesTarget(inp);
    if (!t) return;
    const idx = rngIdx(inp);
    if (idx < 0 || idx >= t.list.length) return;
    const v = parseInt(inp.value, 10);
    if (!isNaN(v) && v >= 0) t.list[idx][inp.dataset.part] = v;
  });
  // 失焦：钳制后回写输入框并落盘生效
  panel.addEventListener('change', (e) => {
    const inp = e.target;
    if (!inp.classList || !inp.classList.contains('pc-rngn')) return;
    const t = rangesTarget(inp);
    if (!t) return;
    const idx = rngIdx(inp);
    if (idx < 0 || idx >= t.list.length) return;
    let v = parseInt(inp.value, 10);
    if (isNaN(v) || v < 0) v = 0;
    t.list[idx][inp.dataset.part] = v;
    inp.value = v;
    saveFeature(t.f);
    applyFeature(t.f);
  });
  // 增删行：改数组后只重刷该字段内层
  panel.addEventListener('click', (e) => {
    const del = e.target.closest ? e.target.closest('.pc-rngdel') : null;
    const add = e.target.closest ? e.target.closest('.pc-rngadd') : null;
    if (!del && !add) return;
    const t = rangesTarget(del || add);
    if (!t) return;
    if (del) {
      const idx = rngIdx(del);
      if (idx >= 0 && idx < t.list.length) t.list.splice(idx, 1);
    } else {
      const last = t.list[t.list.length - 1];
      // 新档默认接在上一档上界（首档从 0 起），不封顶且枚数 0 = 先占位不捐，避免误发
      t.list.push({ from: last ? (last.to | 0) : 0, to: 0, count: 0 });
    }
    t.box.innerHTML = rangesInnerHTML(t.list, t.fd);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 多选开关组字段（type:'multiopts'，次元矿洞矿种）：勾选/取消与全选/清空均整批重存 number[]。
  // 与区间规则一样用面板级事件委托（选项由配置表运行时枚举，不逐个绑控件）。
  const moptsTarget = (el) => {
    const box = el && el.closest ? el.closest('.pc-mopts') : null;
    if (!box) return null;
    const f = findFeature(box.dataset.id);
    if (!f) return null;
    const fd = f.fields.find((x) => x.key === box.dataset.mkey);
    if (!fd) return null;
    const c = configs[f.id];
    // defaults 数组可能被多处共享（loadAllConfigs 不深拷）：首次改动先浅拷一份，避免污染 descriptor
    if (!Array.isArray(c[fd.key])) c[fd.key] = [];
    else if (c[fd.key] === f.defaults[fd.key]) c[fd.key] = c[fd.key].slice();
    return { f, fd, box, list: c[fd.key], cfg: c };
  };
  panel.addEventListener('change', (e) => {
    const inp = e.target;
    if (!inp.classList || !inp.classList.contains('pc-moptchk')) return;
    const t = moptsTarget(inp);
    if (!t) return;
    const val = parseInt(inp.value, 10);
    const i = t.list.indexOf(val);
    if (inp.checked && i < 0) t.list.push(val);
    else if (!inp.checked && i >= 0) t.list.splice(i, 1);
    saveFeature(t.f);
    applyFeature(t.f);
  });
  panel.addEventListener('click', (e) => {
    const all = e.target.closest ? e.target.closest('.pc-moptall') : null;
    const none = e.target.closest ? e.target.closest('.pc-moptnone') : null;
    if (!all && !none) return;
    const t = moptsTarget(all || none);
    if (!t) return;
    if (all) {
      const opts = (typeof t.fd.options === 'function' ? t.fd.options(t.cfg) : t.fd.options) || [];
      t.list.length = 0;
      opts.forEach((o) => t.list.push(o.value));
    } else {
      t.list.length = 0;
    }
    t.box.innerHTML = multiOptsInnerHTML(t.list, t.fd, t.cfg);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 采集规则字段（type:'minerules'，次元矿洞）：矿种/等级下拉 + 星级★点选，行可增删，走面板级事件委托。
  const mrTarget = (el) => {
    const box = el && el.closest ? el.closest('.pc-mrule') : null;
    if (!box) return null;
    const f = findFeature(box.dataset.id);
    if (!f) return null;
    const fd = f.fields.find((x) => x.key === box.dataset.mrkey);
    if (!fd) return null;
    const c = configs[f.id];
    if (!Array.isArray(c[fd.key])) c[fd.key] = [];
    // 首次改动先浅拷一份，避免就地 push/splice 污染 descriptor defaults
    if (c[fd.key] === f.defaults[fd.key]) c[fd.key] = c[fd.key].map((r) => ({ ...r }));
    return { f, fd, box, list: c[fd.key], cfg: c };
  };
  const mrIdx = (el) => {
    const row = el && el.closest ? el.closest('.pc-mrrow[data-midx]') : null;
    return row ? +row.dataset.midx : -1;
  };
  // 矿种/等级下拉：按 data-part 写入对应维度（0=不限），change 即落盘生效
  panel.addEventListener('change', (e) => {
    const el = e.target;
    // 生效开关（checkbox）：勾选才让本条规则参与匹配；重刷以更新置灰态
    if (el.classList && el.classList.contains('pc-mron')) {
      const t0 = mrTarget(el);
      if (!t0) return;
      const i0 = mrIdx(el);
      if (i0 < 0 || i0 >= t0.list.length) return;
      t0.list[i0].enabled = !!el.checked;
      t0.box.innerHTML = mineRulesInnerHTML(t0.list, t0.fd, t0.cfg);
      saveFeature(t0.f); applyFeature(t0.f);
      return;
    }
    if (!el.classList || !el.classList.contains('pc-mrsel')) return;
    const t = mrTarget(el);
    if (!t) return;
    const idx = mrIdx(el);
    if (idx < 0 || idx >= t.list.length) return;
    const part = el.dataset.part === 'level' ? 'level' : 'type';
    t.list[idx][part] = parseInt(el.value, 10) || 0;
    saveFeature(t.f); applyFeature(t.f);
  });
  // 星级★点选（再点当前星=不限）/ 增删行：结构性或视觉变化后整块重刷
  panel.addEventListener('click', (e) => {
    const star = e.target.closest ? e.target.closest('.pc-mrstar') : null;
    const del = e.target.closest ? e.target.closest('.pc-mrdel') : null;
    const add = e.target.closest ? e.target.closest('.pc-mradd') : null;
    if (!star && !del && !add) return;
    const t = mrTarget(star || del || add);
    if (!t) return;
    if (star) {
      const idx = mrIdx(star);
      if (idx < 0 || idx >= t.list.length) return;
      const s = +star.dataset.star || 0;
      t.list[idx].star = (t.list[idx].star === s) ? 0 : s;
    } else if (del) {
      const idx = mrIdx(del);
      if (idx >= 0 && idx < t.list.length) t.list.splice(idx, 1);
    } else {
      // 新规则默认取具体值而非“不限”，并默认不勾选(enabled:false)：配好后手动勾上才生效（起「提交」作用），
      // 避免刚添加（还没改）就被扫描误采。默认：矿种=第一个真实矿种、等级=最高等级、星级=最高星级
      const topts = (typeof t.fd.options === 'function' ? t.fd.options(t.cfg) : t.fd.options) || [];
      const first = topts.find((o) => Number(o.value) > 0);
      const lopts = (typeof t.fd.levelOptions === 'function' ? t.fd.levelOptions(t.cfg) : t.fd.levelOptions) || [];
      let maxLv = 0; for (const o of lopts) { const v = Number(o.value) || 0; if (v > maxLv) maxLv = v; }
      const maxStar = (typeof t.fd.maxStar === 'function' ? t.fd.maxStar(t.cfg) : t.fd.maxStar) || 5;
      t.list.push({ type: first ? Number(first.value) : 0, level: maxLv, star: maxStar, enabled: false });
    }
    t.box.innerHTML = mineRulesInnerHTML(t.list, t.fd, t.cfg);
    saveFeature(t.f); applyFeature(t.f);
  });

  // 战斗模式总开关：翻态即广播 mode.change（reactor 重算门控、图标换态）。不持久化，默认日常。
  const combatCb = panel.querySelector('#pc-combat');
  combatCb.checked = isCombat();
  combatCb.addEventListener('change', () => {
    setCombatMode(combatCb.checked);
  });
}
