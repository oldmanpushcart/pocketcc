// 浮动图标 + 半透明面板（Shadow DOM 与游戏样式双向隔离）。
// 面板为左右两栏：左栏类别 TAB（日常/战斗/系统设置，切换只换右栏内容），右栏卡片列表。
// 卡片来自 core/menu.js：组卡片（主闸门 + 展开子项 checkbox）/ 功能卡片（启用 checkbox + 可展开详细字段）。
// 组开关是 UI 层主闸门：关→子项全部 enabled=false，开→恢复各子项 intentEnabled（见 menu.js）。
// 改动即存档（storage）并实时编排（applyFeature → reactor.setConfig）。
// 换号（UID 变化）由 player.js 走整页 reload，无需 in-place 刷新；仅登录卡死降级补载时监听 player.configs-reloaded 回写控件。
import { createLog } from './log.js';
import { game } from './game.js';
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
/** @type {number} 面板宽度（px，定位时用于算左右边界） */
const PANEL_W = 440;
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
      font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
      box-shadow:0 10px 36px rgba(0,0,0,.55);padding:14px;z-index:2147483646;box-sizing:border-box;}
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
    .pc-row input[type=number]{width:96px;flex:0 0 auto;padding:3px 6px;border-radius:6px;
      border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#e8eef7;font:inherit;}
    .pc-row input[type=checkbox]{width:16px;height:16px;cursor:pointer;flex:0 0 auto;}
    .pc-fval{font-variant-numeric:tabular-nums;color:#9ecbff;opacity:.9;flex:0 0 auto;}
    /* 字段分组小标题（如联盟集结按目标分段） */
    .pc-fsec{margin:10px 0 2px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.14);
      font-size:12px;font-weight:600;color:#cfe8ff;letter-spacing:.5px;}
    .pc-fsec:first-child{margin-top:2px;padding-top:0;border-top:none;}
    .pc-empty{opacity:.5;font-size:12px;padding:4px 0;}
    .pc-btn{margin-top:10px;width:100%;padding:7px 0;border-radius:8px;cursor:pointer;
      border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e8eef7;
      font:inherit;transition:background .15s;}
    .pc-btn:hover{background:rgba(255,255,255,.16);}
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
 * descriptor fields -> 行 HTML（checkbox / text 只读惰性求值 / 数字输入）。
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
      row = `<label class="pc-row"><span>${fd.label}</span>` +
        `<span class="pc-fval" data-fid="${fid}" data-fkey="${fd.key}">${v}</span></label>`;
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
    const v = configs[input.dataset.id][input.dataset.key];
    if (v !== undefined) input.value = v;
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

  // 数字字段：钳制到 min，存档 + 运行中热更
  panel.querySelectorAll('input[type=number]').forEach((input) => {
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

  panel.querySelector('#pc-logout').addEventListener('click', () => {
    game.get('PlatformCore').instance.userLogout();
  });

  // 战斗模式总开关：翻态即广播 mode.change（reactor 重算门控、图标换态）。不持久化，默认日常。
  const combatCb = panel.querySelector('#pc-combat');
  combatCb.checked = isCombat();
  combatCb.addEventListener('change', () => {
    setCombatMode(combatCb.checked);
  });
}
