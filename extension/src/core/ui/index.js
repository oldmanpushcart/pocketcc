// mountUI 编排：浮动图标 + 半透明面板（Shadow DOM 与游戏样式双向隔离）的挂载入口。
// 从 core/ui.js 迁出。CSS 见 panel-css，坐标原语见 icon-pos，面板骨架见 panel，事件绑定见 wire。
// 卡片来自 core/menu.js：组卡片（主闸门 + 展开子项 checkbox）/ 功能卡片（启用 checkbox + 可展开详细字段）。
// 换号（UID 变化）由 player.js 走整页 reload，无需 in-place 刷新；仅登录卡死降级补载时监听 player.configs-reloaded 回写控件。
import { storage } from '../storage.js';
import { bus, EVT } from '../bus.js';
import { getUid } from '../player.js';
import { configs, findFeature, applyFeature } from '../registry.js';
import { iconSVG } from './icon-svg.js';
import { isCombat, setCombatMode } from '../mode.js';
import { ICON_SIZE, PANEL_W, POS_KEY } from './consts.js';
import { PANEL_CSS } from './panel-css.js';
import { clampPos, rescuePos, readIconPos } from './icon-pos.js';
import {
  buildPanelHTML,
  refreshFieldVisibility,
  refreshTexts,
  rerenderFeatureCard,
  syncControls,
  buildWorldStatus,
} from './panel.js';
import { wirePanel, wireControls } from './wire.js';
import { worldState } from '../world/state.js';

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
  bus.on(EVT.MODE_CHANGE, renderIcon);

  const panel = document.createElement('div');
  panel.className = 'pc-panel';
  panel.hidden = true;
  panel.innerHTML = buildPanelHTML();

  root.appendChild(icon);
  root.appendChild(panel);
  document.body.appendChild(host);

  wirePanel(panel);
  refreshFieldVisibility(panel); // 条件字段（fd.showIf）初始态：按当前配置把不该出现的行收起

  // 战斗模式复选框随模式广播同步（含下面的 F8 热键切换，避免图标翻了但面板未跟着变）
  bus.on(EVT.MODE_CHANGE, () => {
    const cb = panel.querySelector('#pc-combat');
    if (cb) cb.checked = isCombat();
  });

  // 世界态胶囊：展示当前 Kind(场景)·Place(地图)。world.change 只在四维翻转才广播（常驻 2s 兜底轮询本就在跑，
  // 不新增轮询），故订阅它刷新即可；面板未展开时元素仍在 DOM，更新照常生效。
  function renderWorldStatus() {
    const el = panel.querySelector('#pc-world');
    if (!el) return;
    const s = buildWorldStatus(worldState.current());
    el.innerHTML = s.inner;
    el.classList.toggle('warn', s.warn);
    el.title = s.title;
  }
  renderWorldStatus();
  bus.on(EVT.WORLD_CHANGE, renderWorldStatus);
  // F8 热键：战斗 / 日常 切换（setCombatMode 广播 mode.change → 图标/复选框/reactor 门控重算自动跟进）。
  // 必须用 window 捕获阶段（capture:true）：游戏自己也会处理 keydown 并在冒泡阶段 stopPropagation，
  // 导致面板收起（焦点在画布）时挂 document 冒泡监听收不到；捕获阶段先于游戏处理且不受焦点/stopPropagation 影响。
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'F8') {
        e.preventDefault();
        setCombatMode(!isCombat());
      }
    },
    true,
  );

  // 功能侧主动推面板刷新（如联盟集结今日计数 +1）；emit 同步，open 时才扫 DOM。
  // payload.rebuild=<fid>：该功能的**行集**变了（目录新增/删少行），只刷只读格不会改 DOM 结构，须重建那张卡。
  /**
   * @type {Set<string>} 待重建的功能卡 fid。
   * 面板 HTML 只在本函数开头 buildPanelHTML() 建一次，openPanel/closePanel 只翻 hidden —— 所以行集变化若恰好在
   *   面板关着（或用户正在格子里输入）时被播报，不能一丢了之：记账下来，开面板时补渲染。
   */
  const pendingRebuild = new Set();

  /**
   * 重建某张卡，并把它的新控件重新装配一遍。
   * body 是整块 innerHTML 换掉的，每个控件的监听器也一起没了：不传 wireControls 就得到一堆「照常可点、
   *   值却不落盘」的行（联盟集结的行级开关就是这样被默默吞掉过），故重建必与重绑同途。
   * 重推配置与重建 DOM 同源同途：行的出现即运行时的目标表也要重算（见下方 UI_REFRESH 注释）。
   * @param {string} fid 功能卡 id
   * @returns {boolean} 是否真的重建了
   */
  const rebuildCard = (fid) => rerenderFeatureCard(panel, fid, wireControls);

  /** 开面板时补渲染积压的行集变化（每个 fid 只试一次，失败也不重试，免得不存在的卡反复排队）。 */
  function flushRebuild() {
    if (!pendingRebuild.size) return;
    for (const fid of [...pendingRebuild]) {
      pendingRebuild.delete(fid);
      rebuildCard(fid);
    }
  }

  bus.on(EVT.UI_REFRESH, function (payload) {
    const fid = payload && payload.rebuild;
    if (fid) {
      // 行集变化必把配置重推一次，只重建 DOM 不够：面板读的是扁平键 configs[fid]（读盘即恢复），
      //   而 feat 运行时那份「目标表」是 toModuleCfg 在推送那一刻的目录行集上算出的快照。目录行常常晚于
      //   配置灌入才出现（联盟集结的自学习目标要等异步读盘或首条 12003 推送才进 catalogRows），于是那行
      //   在面板上是勾着的、在引擎里却是 syncTargets 补出来的 enabled:false 占位 —— 「我明明勾了」的分裂态。
      //   故这里重走一次 applyFeature：toModuleCfg 用当前行集重算，configure 幂等合并，多推一次无副作用。
      //   且必须放在 panel.hidden 闸门之前 —— 引擎的正确性不能取决于面板开没开。
      const f = findFeature(fid);
      if (f && configs[f.id]) applyFeature(f);
      // 面板关着 / 焦点在卡内（rerenderFeatureCard 的保守闸门跳过）：两种情形都记账待开面板时补，不能把行集变化丢掉
      if (panel.hidden || !rebuildCard(fid)) pendingRebuild.add(fid);
    }
    if (panel.hidden) return;
    refreshTexts(panel);
  });

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
  bus.on(EVT.PLAYER_CONFIGS_RELOADED, (e) => {
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
  function openPanel() {
    placePanel();
    panel.hidden = false;
    flushRebuild(); // 收起期间播报过的行集变化，此时才真能重渲染（展开本身不动 DOM 结构）
    refreshTexts(panel);
    renderWorldStatus(); // 展开时再核一次世界态（订阅已常驻，此处兜住极早期 world.change 先于挂订阅的窗口）
  }
  /** 收起面板 */
  function closePanel() {
    panel.hidden = true;
  }

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
  document.addEventListener(
    'click',
    (e) => {
      if (panel.hidden) return;
      if (e.target === host || host.contains(e.target)) return;
      closePanel();
    },
    true,
  );
}
