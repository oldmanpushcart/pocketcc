// Shadow DOM 内样式：与游戏样式双向隔离，图标/面板/卡片/TAB 全部规则。
// 从 core/ui.js 原样迁出，唯一依赖是 ICON_SIZE / PANEL_W 两个尺寸常量插值。
import { ICON_SIZE, PANEL_W } from './consts.js';

/** @type {string} */
export const PANEL_CSS = `
    .pc-icon{position:fixed;width:${ICON_SIZE}px;height:${ICON_SIZE}px;border-radius:50%;
      background:transparent;border:none;padding:0;
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;user-select:none;touch-action:none;
      z-index:2147483647;}
    .pc-icon svg{position:relative;z-index:1;
      filter:drop-shadow(0 0 10px rgba(47,155,255,.7)) drop-shadow(0 2px 5px rgba(0,0,0,.55));transition:filter .15s;}
    .pc-icon:hover svg{filter:drop-shadow(0 0 13px rgba(47,155,255,.9)) drop-shadow(0 2px 5px rgba(0,0,0,.55)) brightness(1.2);}
    .pc-icon.combat svg{filter:drop-shadow(0 0 12px rgba(255,59,48,.95)) drop-shadow(0 2px 5px rgba(0,0,0,.55));}
    /* 光晕层必须明显大于图标：亮带半径要落在不透明圆盘（约 21px）之外，否则整圈被圆盘盖住。 */
    .pc-halo{position:absolute;left:50%;top:50%;width:190%;height:190%;
      transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;z-index:0;
      background:radial-gradient(circle closest-side,
        rgba(110,190,255,0) 0 50%, rgba(110,190,255,.7) 70%,
        rgba(140,205,255,1) 82%, rgba(110,190,255,0) 100%);
      filter:blur(6px);
      animation:pc-breathe-daily 3.4s ease-out infinite;}
    .pc-icon.combat .pc-halo{
      background:radial-gradient(circle closest-side,
        rgba(255,95,65,0) 0 50%, rgba(255,95,65,.75) 70%,
        rgba(255,130,100,1) 82%, rgba(255,95,65,0) 100%);
      filter:blur(7px);
      animation:pc-breathe-combat 1.1s ease-out infinite;}
    @keyframes pc-breathe-daily{
      0%{transform:translate(-50%,-50%) scale(.9);opacity:0;}
      18%{opacity:1;}
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
    /* 世界态胶囊：展示当前 Kind(场景)·Place(地图)，随 world.change 刷新；unknown/off 转警色 */
    .pc-world{display:inline-flex;align-items:center;gap:6px;margin:0 0 8px;padding:3px 10px;
      border-radius:999px;font-size:12px;line-height:1.5;color:#bfe3ff;cursor:default;
      border:1px solid rgba(120,190,255,.28);background:rgba(70,140,220,.12);}
    .pc-world .pc-wk{font-weight:600;}
    .pc-world .pc-wp{opacity:.9;}
    .pc-world .pc-wdot{opacity:.45;}
    .pc-world.warn{color:#ffd0b8;border-color:rgba(255,150,90,.42);background:rgba(255,120,60,.14);}
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
    /* 组内子项声明了 showFields 时展开的详细字段：左缩进一级、与子项开关行视觉从属，去掉重复上边框 */
    .pc-subfields{margin:0 0 6px 18px;padding:0 0 2px;border:0;}
    .pc-subfields .pc-fsec{margin-top:2px;padding-top:2px;border-top:0;}
    /* 字段行 / 子项行 */
    .pc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:7px 0;}
    .pc-row > span{flex:1;min-width:0;}
    .pc-row input[type=number]{width:96px;flex:0 0 auto;padding:3px 6px;border-radius:6px;box-sizing:border-box;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;
      font-variant-numeric:tabular-nums;}
    .pc-row input[type=number]:focus{outline:none;border-color:rgba(120,180,255,.55);background:rgba(120,180,255,.10);}
    /* placeholder（如 0=不限 的「不限」提示）：与打野 .pc-hln 同款亮色，避免浏览器默认浅灰看不清；聚焦时隐去 */
    .pc-row input[type=number]::placeholder{color:#cfe3ff;opacity:1;}
    .pc-row input[type=number]:focus::placeholder{color:transparent;}
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
    /* uidlist 行首勾选框（fd.itemCheck，夺宝玩家池）：勾中才入池，未勾行由 feat 侧自行排除 */
    .pc-ulichk{flex:0 0 auto;width:15px;height:15px;margin:0 2px 0 0;cursor:pointer;accent-color:#4aa3ff;}
    .pc-ulistadd:disabled{opacity:.4;cursor:default;}
    .pc-uli .pc-udel{flex:0 0 18px;width:18px;height:22px;padding:0;border:none;background:transparent;
      color:#ff9c9c;font:inherit;font-size:14px;line-height:22px;cursor:pointer;}
    .pc-uli .pc-udel:hover{color:#ff6b6b;}
    .pc-uli .pc-udisp{flex:1 1 auto;width:auto;min-width:0;}
    /* 领取优先级清单字段（type:'sortlist'，遗迹奖励）：整池奖励摆出、行不可增删只能整行拖拽调序。
       无删除按钮（全员参与），松手才按 DOM 顺序回写（见 mountSortList）。 */
    .pc-slist{display:flex;flex-direction:column;gap:4px;width:100%;margin:2px 0 6px;}
    .pc-slisttop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-srows{display:flex;flex-direction:column;gap:4px;width:100%;}
    .pc-srow{display:flex;align-items:center;gap:6px;width:100%;cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none;}
    .pc-shandle{flex:0 0 auto;width:12px;text-align:center;opacity:.4;font-size:14px;line-height:1;letter-spacing:-2px;cursor:grab;}
    .pc-srow.pc-sdragging{opacity:.35;}
    .pc-srows.pc-sgrabbing,.pc-srows.pc-sgrabbing .pc-sname{cursor:grabbing;}
    .pc-srank{flex:0 0 auto;width:18px;text-align:right;opacity:.6;font-variant-numeric:tabular-nums;}
    .pc-sname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;
      padding:3px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e8eef7;}
    /* checkable sortlist（卡车争夺）：每行行首一枚 checkbox 控制该物品是否参与匹配，取消勾选整行置灰但仍可拖拽排序 */
    .pc-scheck{flex:0 0 auto;width:15px;height:15px;margin:0;cursor:pointer;accent-color:#4aa3ff;}
    .pc-srow.pc-srowoff .pc-sname{opacity:.42;}
    .pc-srow.pc-srowoff .pc-srank{opacity:.3;}
    .pc-smove{flex:0 0 auto;width:22px;height:22px;padding:0;border-radius:6px;cursor:pointer;
      border:1px solid rgba(255,255,255,.22);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:20px;}
    /* 物品清单字段（type:'itemlist'，秘境拾取）：行不可增删，每行 [拖拽 序号] 名称 [数字(0=占位显示上限/无上限)] [拾] [店]。
       容器不单独限高/滚动（整块随面板 .pc-pane 统一滞动），避免清单内嵌滞动条。 */
    .pc-ilist{display:flex;flex-direction:column;gap:4px;width:100%;margin:2px 0 6px;}
    .pc-ilisttop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-irows{display:flex;flex-direction:column;gap:2px;width:100%;padding-right:2px;}
    .pc-irow{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;background:rgba(255,255,255,.03);}
    /* 可拖拽排序的 itemlist（fd.sortable）：只手柄可起拖（行内有输入框，整行起拖会抢焦点/选字），
       touch-action:none 保证触摸设备上 pointermove 不被滚动抢走（同 .pc-srow） */
    .pc-irow .pc-shandle{touch-action:none;}
    .pc-irow.pc-sdragging{opacity:.35;}
    .pc-irows.pc-sgrabbing,.pc-irows.pc-sgrabbing .pc-shandle{cursor:grabbing;}
    .pc-irank{flex:0 0 auto;width:18px;text-align:right;opacity:.6;font-variant-numeric:tabular-nums;}
    .pc-irow.pc-irowoff .pc-irank{opacity:.3;}
    .pc-irow.pc-irowoff{opacity:.5;}
    .pc-ichk{flex:0 0 auto;width:14px;height:14px;margin:0;cursor:pointer;accent-color:#4aa3ff;}
    /* 渠道勾选标签（[拾取]/[商店]）：勾选框+文字紧排，亮色文字避免整行发灰；置灰渠道（disabled）单独降透明+禁选光标 */
    .pc-ichklbl{flex:0 0 auto;display:inline-flex;align-items:center;gap:2px;cursor:pointer;color:#e8eef7;font-size:12px;}
    .pc-ichklbl input:disabled{cursor:not-allowed;}
    .pc-ichklbl:has(input:disabled){opacity:.4;cursor:not-allowed;}
    /* 名称固定列宽（.pc-iname 66px）保证输入框左对齐；主勾选（拾取）靠 margin-left:auto 把「拾取/商店」整组推到行右侧对齐成列 */
    .pc-ichkpush{margin-left:auto;}
    .pc-ichk2{flex:0 0 auto;width:14px;height:14px;margin:0;cursor:pointer;accent-color:#4aa3ff;}
    .pc-ichklbl2{margin-left:14px;}
    .pc-iname{flex:0 0 66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#e8eef7;}
    /* fd.nameGrow：名称列改弹性填充（长物品名不截断，同行数字/勾选仍右对齐成列）；类写在 .pc-iname 之后靠源码顺序决胜特异度 */
    .pc-iname.pc-namegrow{flex:1 1 auto;min-width:0;}
    /* 行内角标：池项带 cap（游戏自身硬上限，如秘境 ITEM.para1_v1）时标 ≤N，提醒超出会被自动修正 */
    .pc-icap{flex:0 0 auto;padding:0 4px;border-radius:4px;font-size:11px;color:#9ecbff;
      background:rgba(74,163,255,.12);border:1px solid rgba(74,163,255,.22);}
    .pc-imax{flex:0 0 auto;width:64px;padding:2px 4px;border-radius:4px;
      border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:#e8eef7;font:inherit;font-size:12px;}
    /* 背包上限 placeholder（cap=0 时的「无上限」）：与打野 .pc-hln 同款亮色，不被浏览器默认浅灰吞掉 */
    .pc-imax::placeholder{color:#cfe3ff;opacity:1;}
    /* fd.noMax 的钻石价列（代替「购买上限」输入列）：红色对齐游戏内钻石花费读数，表未加载时置灰破折号 */
    .pc-icost{flex:0 0 auto;min-width:64px;text-align:right;font-variant-numeric:tabular-nums;
      font-size:12px;color:#ff6b6b;white-space:nowrap;}
    .pc-icost.pc-icostunk{color:#8b97a8;}
    /* itemlist 的只读总数量列（fd.stockText，如密所「全部商店该商品剩余之和」）：与价列同右对齐成列。
       双类选择器 (0-2-0) 压过上方 .pc-fval 的 flex:0 0 auto——那一条源码顺序在后，单类写会被它抢走宽度行为 */
    .pc-fval.pc-istock{flex:0 0 46px;text-align:right;font-size:12px;white-space:nowrap;}
    /* 只读信息表格（type:'infogrid'，如密所状态：归属区/等级/状态/倒计时）：一行一条记录，
       行包 div 用 display:contents 把格子直接挂到父栅格，列宽由内联 grid-template-columns:repeat(N,max-content) 给出
       ——所有行共用同一套列宽，因此「上下严格对齐」不依赖等宽字体（CJK/数字混排下靠空格填充会错位） */
    .pc-igraph{display:grid;gap:2px 10px;width:100%;margin:2px 0 6px;font-size:12px;
      align-items:center;justify-content:start;}
    .pc-igrow{display:contents;}
    .pc-igcell{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      font-variant-numeric:tabular-nums;color:#e8eef7;}
    .pc-igright{text-align:right;}
    .pc-ighead-cell{color:#9ecbff;font-size:11px;opacity:.85;}
    .pc-ignone{grid-column:1/-1;color:#8b97a8;}
    .pc-smove:hover{background:rgba(255,255,255,.1);}
    .pc-smove:disabled{opacity:.3;cursor:default;}
    .pc-row input[type=checkbox]{width:16px;height:16px;cursor:pointer;flex:0 0 auto;}
    /* 联盟集结目标紧凑表（type:'rallygrid'）：一行一目标的多行表 [目标名][延迟入队(秒)输入][每日上限输入][今日已打文本][启用checkbox]，
       列头与数据行共用同一 5 列 CSS Grid（行包 div 靠 display:contents 将子格直接挂到父栅格），窄面板下输入框弹性收缩、标签只占必要宽度；
       目标名列取 minmax(40px,auto)：行集由运行时目录给出，学习行的标签（如「雷达集结怪#94」）比旧手写三行长，定宽 40px 会跨列溢出 */
    .pc-rg{display:grid;grid-template-columns:minmax(40px,auto) 1fr 1fr 62px 20px;gap:6px;align-items:center;
      width:100%;margin:6px 0 10px;font-size:12px;}
    .pc-rghead{display:contents;}
    .pc-rghead > .pc-rgcell{color:#9ecbff;font-size:11px;opacity:.85;text-align:center;white-space:nowrap;
      overflow:hidden;text-overflow:ellipsis;}
    .pc-rghead > .pc-rgc-0{text-align:left;}
    .pc-rgrow{display:contents;}
    .pc-rgrow > .pc-rgcell{display:flex;align-items:center;justify-content:center;gap:2px;min-width:0;}
    .pc-rgrow > .pc-rgc-0{justify-content:flex-start;color:#e8eef7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pc-rgrow > .pc-rgcell input[type=number].pc-rgin{width:100%;min-width:0;padding:2px 4px;border-radius:5px;
      box-sizing:border-box;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);
      color:#e8eef7;font:inherit;font-variant-numeric:tabular-nums;}
    .pc-rgrow > .pc-rgcell input[type=number].pc-rgin:focus{outline:none;border-color:rgba(120,180,255,.55);
      background:rgba(120,180,255,.10);}
    .pc-rgrow > .pc-rgcell input[type=number].pc-rgin::placeholder{color:#cfe3ff;opacity:1;}
    .pc-rgrow > .pc-rgcell input[type=number].pc-rgin:focus::placeholder{color:transparent;}
    .pc-rgrow > .pc-rgcount{width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pc-rgchk{width:15px;height:15px;cursor:pointer;flex:0 0 auto;}
    .pc-row select.pc-fsel{max-width:150px;flex:0 0 auto;padding:3px 6px;border-radius:6px;
      border:1px solid rgba(255,255,255,.25);background:rgba(20,26,38,.9);color:#e8eef7;font:inherit;}
    /* 行内多下拉（type:'tripick'，如异能兽培育属相/品种/品质同一行）与一行多控件（type:'ctrlrow'，
       如惧星集结「等级/方式/预设队伍/今日已打」）共用：标签只占文字宽，控件在剩余空间里等分收缩。
       用 .pc-row > 提升特异度，压过通用的 .pc-row > span{flex:1}（否则两个 span 各占一半、控件会撑破右边界） */
    .pc-row > .pc-triolab{flex:0 0 auto;}
    .pc-row > .pc-trio{display:flex;gap:4px;flex:1 1 auto;min-width:0;}
    .pc-trio select.pc-fsel{flex:1 1 0;min-width:0;width:auto;max-width:none;padding:3px 4px;font-size:12px;}
    /* ctrlrow 里的只读格（.pc-fval）：同样等分收缩，靠右对齐与其他只读值一致。
       必须写在下方 .pc-fval 之后：两条同为 (0-2-1) 特异度，靠源码顺序决胜，否则 .pc-fval 的 flex:0 0 auto 会赢 */
    .pc-fval{font-variant-numeric:tabular-nums;color:#9ecbff;opacity:.9;flex:0 0 auto;
      text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pc-trio span.pc-ftri{flex:1 1 0;min-width:0;width:auto;text-align:right;}
    /* 只读 text 字段的多行变体（fd.multiline，如次元矿洞今日进度）：标签在上、值整行，pre-line 保留换行不截断 */
    .pc-rowcol{flex-direction:column;align-items:flex-start;gap:2px;}
    .pc-fvalml{white-space:pre-line;overflow:visible;text-overflow:clip;text-align:left;flex:0 0 auto;width:100%;line-height:1.6;}
    /* 只读 text 的「同行多行」变体（fd.multiline + fd.inline）：标签与值同行，值靠右 pre-line 换行，顶对齐使首行与标签齐平 */
    .pc-rowtop{align-items:flex-start;}
    .pc-fvalhl{white-space:pre-line;text-align:right;overflow:visible;text-overflow:clip;line-height:1.6;}
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
    .pc-moptacts{display:flex;align-items:center;gap:6px;flex:0 0 auto;}
    /* 已选/上限计数（fd.maxSelect）：与全选/清空同组靠右 */
    .pc-moptcount{font-size:11px;opacity:.7;font-variant-numeric:tabular-nums;}
    .pc-moptall,.pc-moptnone{padding:1px 8px;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;
      border:1px solid rgba(255,255,255,.24);background:transparent;color:#cfe8ff;}
    .pc-moptall:hover,.pc-moptnone:hover{background:rgba(255,255,255,.1);}
    .pc-moptgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:4px 8px;width:100%;}
    .pc-mopt{display:flex;align-items:center;gap:4px;font-size:12px;min-width:0;cursor:pointer;}
    .pc-mopt input[type=checkbox]{width:14px;height:14px;cursor:pointer;flex:0 0 auto;}
    /* 达勾选上限后的未选项（fd.maxSelect）：置灰不可点，与已选项拉开对比 */
    .pc-mopt.pc-moptdis{opacity:.42;cursor:default;}
    .pc-mopt input[type=checkbox]:disabled{cursor:default;}
    .pc-mopt span,.pc-mopt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .pc-rngadd{flex:0 0 auto;width:22px;height:20px;padding:0;border-radius:6px;cursor:pointer;
      border:1px dashed rgba(255,255,255,.28);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:18px;}
    .pc-rngadd:hover{background:rgba(255,255,255,.1);}
    /* 字段分组小标题（如联盟集结按目标分段） */
    .pc-fsec{margin:10px 0 2px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.14);
      font-size:12px;font-weight:600;color:#cfe8ff;letter-spacing:.5px;}
    .pc-fsec:first-child{margin-top:2px;padding-top:0;border-top:none;}
    /* 可折叠子分组（如卡车拦截「拦截判定」默认收起）：标题行带箭头可点展开/收起，箭头随开合旋转 */
    .pc-fsectoggle{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
    .pc-fsectoggle:hover{color:#eaf4ff;}
    .pc-fsecchev{font-size:9px;opacity:.6;transition:transform .15s;}
    .pc-fsectoggle.open .pc-fsecchev{transform:rotate(90deg);}
    .pc-fsec-body{margin:0;}
    /* 纯说明横幅字段（type:'note'）：整行 muted 小字，配合其 section 标题切分相邻字段块 */
    .pc-fnote{font-size:11px;line-height:1.5;color:#9fb4cc;opacity:.9;margin:0 0 2px;padding:0 2px;}
    /* 字段条件显隐（fd.showIf(cfg)）：行根打 data-dep 标记，由 refreshFieldVisibility 就地切 hidden、不重建 DOM。
       双属性选择器特异度高于 .pc-row/.pc-mopts 等作者类规则，故 hidden 能真生效（同 .pc-sec-body[hidden] 的写法原因）；
       分组小标题同理：其下字段全隐时一起收起，不留「光杆标题」 */
    [data-dep][hidden]{display:none;}
    .pc-fsec[data-sec][hidden]{display:none;}
    .pc-empty{opacity:.5;font-size:12px;padding:4px 0;}
    /* 快捷键一览卡（方案 C：分组 + 键帽精修）：不复用 .pc-row（其 >span{flex:1} 会抢宽导致换行/错位）。
       行内负外边距 + padding 让 hover 高亮能铺到卡片内边沿；键帽立体（渐变+底边阴影）、键名列右对齐贴齐功能名、场景做小胶囊 */
    .pc-hkrow{display:flex;align-items:center;gap:10px;margin:0 -6px;padding:5px 6px;border-radius:6px;transition:background .12s;}
    .pc-hkrow:hover{background:rgba(255,255,255,.06);}
    .pc-hkrow .pc-hkk{flex:0 0 62px;text-align:right;}
    .pc-hkrow .pc-hkk kbd{display:inline-block;padding:2px 7px;border-radius:6px;font:inherit;font-size:12px;white-space:nowrap;color:#dcefff;
      background:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.05));
      border:1px solid rgba(255,255,255,.24);border-bottom-width:2px;box-shadow:0 1px 0 rgba(0,0,0,.35);}
    .pc-hkrow .pc-hkl{flex:1 1 auto;min-width:0;}
    .pc-hkrow .pc-hkw{flex:0 0 auto;font-size:10px;opacity:.5;text-align:right;background:rgba(255,255,255,.06);border-radius:10px;padding:1px 8px;}
    .pc-hkgrp{font-size:11px;opacity:.55;letter-spacing:.5px;margin:8px 0 2px;padding:0 6px;}
    .pc-hkgrp:first-child{margin-top:2px;}
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
    .pc-mrcap{flex:0 0 auto;margin-left:auto;font-size:10px;line-height:1;color:#8fa6c4;letter-spacing:.5px;}
    .pc-mrstars{display:inline-flex;gap:3px;flex:0 0 auto;}
    .pc-mrstar{font-size:15px;line-height:1;cursor:pointer;color:rgba(255,255,255,.3);transition:transform .1s,color .1s;}
    .pc-mrstar.on{color:#ffcf4d;text-shadow:0 0 6px rgba(255,207,77,.5);}
    .pc-mrstar:hover{transform:scale(1.18);}
    /* 下田规则字段（type:'farmrules'，自动下田：每行=一个田位；资源类型/种类多选/预设部队 三个下拉 + 删除，行存在即生效）。
       行盒可换行（窄卡尽量单行），× 与标题行＋右对齐；骨架同 minerules，交互走面板级事件委托（见 wirePanel）。 */
    .pc-frule{display:flex;flex-direction:column;gap:6px;width:100%;margin:2px 0 6px;}
    .pc-fruletop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-fradd{flex:0 0 auto;width:22px;height:20px;padding:0;border-radius:6px;cursor:pointer;
      border:1px dashed rgba(255,255,255,.28);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:18px;}
    .pc-fradd:hover{background:rgba(255,255,255,.1);}
    .pc-frmain{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .pc-frbox{display:flex;flex:1 1 auto;flex-wrap:wrap;align-items:center;gap:4px;min-width:0;padding:6px 7px;
      border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.03);}
    /* 目标/部队 分组小标签 + 中间竖分隔线：把“采集什么田”与“派哪支部队”在视觉上分成两段 */
    .pc-frcap{flex:0 0 auto;font-size:10px;line-height:1;color:#8fa6c4;letter-spacing:.5px;}
    .pc-frdiv{flex:0 0 auto;width:1px;align-self:stretch;margin:1px 2px;background:rgba(255,255,255,.22);}
    .pc-frsel{padding:3px 5px;border-radius:6px;border:1px solid rgba(255,255,255,.25);
      background:rgba(20,26,38,.9);color:#e8eef7;font:inherit;min-width:0;}
    /* 资源种类多选下拉（type:'farmrules'：遗迹/机械/普通）——按钮就是下拉触发器（观感对齐 .pc-frsel，只显示已选摘要），
       选项列表每项一个 checkbox。主路径（面板带 .pc-kindpop = 浏览器有 Popover API）：列表进 top layer 浮在按钮下方，
       不撑高卡片，也不被 .pc-panel/.pc-pane 的 overflow:auto、.pc-sec 的 overflow:hidden 和面板的 backdrop-filter 裁切
       （fixed 子元素会被这些困住）；位置由 wire.js 按按钮 rect 写行内 style，light dismiss 交给浏览器。
       降级（老 Chrome 无 popover 属性）：同一条列表改走流内撑开，独占一行。全不勾 = 该行不下田。 */
    .pc-frkinds{display:inline-flex;flex-direction:column;align-items:flex-start;gap:3px;flex:0 1 auto;min-width:0;}
    .pc-frkinds.pc-open{flex:1 0 100%;align-items:flex-start;}
    .pc-frkbtn{display:inline-flex;align-items:center;gap:5px;max-width:150px;padding:3px 6px;border-radius:6px;cursor:pointer;
      border:1px solid rgba(255,255,255,.25);background:rgba(20,26,38,.9);color:#e8eef7;font:inherit;font-size:12px;}
    .pc-frkbtn:hover{border-color:rgba(74,158,255,.6);}
    .pc-frksum{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .pc-frkcaret{flex:0 0 auto;font-size:10px;line-height:1;opacity:.7;transition:transform .12s;}
    .pc-frkinds.pc-open .pc-frkcaret{transform:rotate(180deg);}
    .pc-frkpop{display:none;flex-wrap:wrap;align-items:center;gap:3px 14px;width:100%;padding:4px 7px;
      border:1px solid rgba(255,255,255,.14);border-radius:7px;background:rgba(255,255,255,.05);}
    .pc-frkinds.pc-open .pc-frkpop{display:flex;}
    /* popover 模式：收起时由 UA 的 :not(:popover-open) 隐藏，声明顺序要压过上面那条「展开才 flex」；
       .pc-kindpopfail = showPopover 报错后常驻退回流内撑开（wire.js），两类名不同时存在所以不冲突 */
    .pc-panel.pc-kindpop .pc-frkpop{display:none;}
    .pc-panel.pc-kindpop .pc-frkinds.pc-open{flex:0 1 auto;}
    .pc-panel.pc-kindpopfail .pc-frkinds.pc-open{flex:1 0 100%;}
    .pc-panel.pc-kindpopfail .pc-frkinds.pc-open .pc-frkpop{display:flex;}
    .pc-panel.pc-kindpop .pc-frkpop:popover-open{display:flex;flex-direction:column;align-items:stretch;gap:2px;
      width:max-content;max-width:240px;padding:5px 7px;border:1px solid rgba(255,255,255,.22);border-radius:8px;
      background:rgba(24,30,42,.985);box-shadow:0 8px 22px rgba(0,0,0,.5);}
    .pc-frkopt{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#cfe3ff;cursor:pointer;white-space:nowrap;}
    .pc-frkoptdis{opacity:.35;cursor:not-allowed;}
    .pc-frkin{width:13px;height:13px;margin:0;cursor:pointer;accent-color:#4a9eff;flex:0 0 auto;}
    .pc-frkopt input[type=checkbox]:disabled{cursor:not-allowed;}
    .pc-frdel{flex:0 0 auto;width:22px;height:24px;padding:0;border:none;background:transparent;
      color:#ff9c9c;font:inherit;font-size:16px;line-height:24px;cursor:pointer;text-align:center;}
    .pc-frdel:hover{color:#ff6b6b;}
    /* 下田时段字段（type:'timeranges'，自动下田：每行=一个时段，原生 time 选时:分，× 删除，行存在即生效）。
       骨架同 minerules/ranges，行盒单行：[起始 ~ 结束 ×]；交互走面板级事件委托（见 wirePanel）。 */
    .pc-trule{display:flex;flex-direction:column;gap:6px;width:100%;margin:2px 0 6px;}
    .pc-trtop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-tradd{flex:0 0 auto;width:22px;height:20px;padding:0;border-radius:6px;cursor:pointer;
      border:1px dashed rgba(255,255,255,.28);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:18px;}
    .pc-tradd:hover{background:rgba(255,255,255,.1);}
    .pc-trow{display:flex;align-items:center;gap:8px;}
    .pc-tinp{flex:0 1 auto;min-width:0;padding:3px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.25);
      background:rgba(20,26,38,.9);color:#e8eef7;font:inherit;font-variant-numeric:tabular-nums;}
    .pc-tinp:focus{outline:none;border-color:rgba(120,180,255,.55);}
    .pc-tdash{flex:0 0 auto;opacity:.55;font-size:12px;}
    .pc-tdel{flex:0 0 auto;width:22px;height:24px;padding:0;border:none;background:transparent;
      color:#ff9c9c;font:inherit;font-size:16px;line-height:24px;cursor:pointer;text-align:center;}
    .pc-tdel:hover{color:#ff6b6b;}
    /* 怪物清单字段（type:'huntlist'，自动打野）：固定行（每种怪一行）的表格，列头与数据行共用同一 grid 模板逐列对齐。
       列：类型 | 方式 | 数量 | 已打 | 参与☑（等级不入清单，固定搜最高档）。行不可增删，交互走面板级事件委托（见 wirePanel）。 */
    .pc-hl{display:flex;flex-direction:column;width:100%;margin:2px 0 6px;}
    .pc-hltop{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;}
    .pc-hlrow{display:grid;grid-template-columns:minmax(0,1fr) 84px 64px 52px 26px;align-items:center;gap:8px;
      padding:6px 2px;}
    .pc-hlhead{padding:2px 2px 4px;border-bottom:1px solid rgba(255,255,255,.16);font-size:11px;opacity:.62;}
    .pc-hlhead .pc-hlmode,.pc-hlhead .pc-hlcnt,.pc-hlhead .pc-hldone,.pc-hlhead .pc-hlon{text-align:center;}
    /* ctrlrow 表格式变体（fd.table，惧星集结）：与怪物清单同一套 .pc-hl/.pc-hlrow/.pc-hlhead 外观（表头小字 + 表头/表身分隔线，数据行无分隔线），
       列数由内联 grid-template-columns 决定（等分），故不沿用 .pc-hlrow 的 5 列固定模板 */
    .pc-cthd{text-align:center;}
    .pc-ct select.pc-hlmode{max-width:none;}
    .pc-ct .pc-hlstat{font-size:12px;}
    .pc-hlname{display:flex;align-items:center;gap:5px;min-width:0;font-size:12px;text-align:left;}
    .pc-hllabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .pc-hln{width:100%;min-width:0;box-sizing:border-box;padding:3px 2px;border-radius:5px;
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e8eef7;font:inherit;
      font-size:12px;font-variant-numeric:tabular-nums;text-align:center;appearance:textfield;-moz-appearance:textfield;}
    .pc-hln:focus{outline:none;border-color:rgba(120,180,255,.55);background:rgba(120,180,255,.10);}
    .pc-hln::-webkit-inner-spin-button,.pc-hln::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
    .pc-hln::placeholder{color:#cfe3ff;opacity:1;font-size:11px;}
    .pc-hln:focus::placeholder{color:transparent;}
    .pc-hldone{font-size:11px;text-align:center;color:#9ecbff;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;}
    /* 「已打」只读数据格：做成居中胶囊，与相邻的 方式/数量 输入框同高同列宽，避免无样式裸值把行拽得左挤右空 */
    .pc-hlstat{box-sizing:border-box;width:100%;min-width:0;padding:3px 2px;border-radius:5px;
      border:1px solid rgba(255,255,255,.09);background:rgba(158,203,255,.07);color:#9ecbff;opacity:1;
      font-size:12px;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap;overflow:hidden;}
    .pc-hlon{width:15px;height:15px;margin:0;cursor:pointer;accent-color:#4aa3ff;justify-self:center;}
    /* 打野预设池字段（type:'presetpool'，自动打野）：动态增删的单选行，每行一枚下拉选战斗预设（1~8）+ × 移除，跨行去重。
       增删/改选整块重刷以重算其它行可选项，交互走面板级事件委托（见 wirePanel）。 */
    .pc-pp{display:flex;flex-direction:column;gap:4px;width:100%;margin:2px 0 6px;}
    .pc-pptop{display:flex;align-items:center;justify-content:space-between;gap:8px;}
    .pc-ppadd{flex:0 0 auto;width:22px;height:20px;padding:0;border-radius:6px;cursor:pointer;
      border:1px dashed rgba(255,255,255,.28);background:transparent;color:#cfe8ff;font:inherit;font-size:14px;line-height:18px;}
    .pc-ppadd:hover{background:rgba(255,255,255,.1);}
    .pc-ppadd:disabled{opacity:.4;cursor:default;}
    .pc-pprow{display:flex;align-items:center;gap:6px;}
    .pc-ppslot{flex:0 0 auto;font-size:11px;opacity:.6;font-variant-numeric:tabular-nums;}
    .pc-ppdel{flex:0 0 auto;width:22px;height:22px;padding:0;border:none;background:transparent;
      color:#ff9c9c;font:inherit;font-size:16px;line-height:22px;cursor:pointer;text-align:center;}
    .pc-ppdel:hover{color:#ff6b6b;}
    /* 下田清单/预设池下拉共用外观（限定 select.：表头同名 span 不能继承下拉的边框/背景，否则表头「方式」格会与其他表头不一致） */
    select.pc-hlmode,.pc-ppsel{padding:2px 4px;border-radius:6px;border:1px solid rgba(255,255,255,.25);
      background:rgba(20,26,38,.9);color:#e8eef7;font:inherit;font-size:12px;min-width:0;width:100%;box-sizing:border-box;}
    .pc-ppsel{flex:1 1 auto;}
  `;
