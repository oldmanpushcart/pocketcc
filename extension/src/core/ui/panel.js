// 面板骨架：菜单树 → 卡片/pane 的渲染，以及只读文本刷新 / 全量控件回写 / 条件字段显隐 / 菜单树查询。
// 从 core/ui.js 迁出。字段 HTML 委托给 fields，动态控件装配委托给 widgets。
import { configs, findFeature } from '../registry.js';
import { MENU } from '../menu.js';
import { list as hotkeyList } from '../hotkeys.js';
import { gameData } from '../game-api.js';
import { escAttr } from './dom.js';
import { cardHead, buildFieldsHTML, findFieldDescriptor, refreshFieldBox } from './fields.js';
import { mountUidList, mountSortList, mountItemList } from './widgets.js';

/**
 * 左 TAB 的活动闸门注册表：menu.js 类别节点的 `gate` 名 -> 判据（返回假则该 TAB 不可点）。
 * 判据与各 feat 的活动闸严格同源（cq26 家族一律走 gameData.cq26IsOpen()），面板只镜像引擎事实、
 * 不自造中间态：符号漂移 / 子包未载导致投影不可得时 cq26IsOpen() 本身就是 false，与 feat 侧
 * 「活动闸未开 → 一个包都不发」同一口径，不会出现在 TAB 可点而引擎什么都不干的分裂态。
 * @type {Object<string,()=>boolean>}
 */
const TAB_GATES = {
  cq26Open: () => gameData.cq26IsOpen(),
};

/**
 * 世界态展示中文名（Kind 场景档 / Place 地图）：仅供面板头部状态胶囊展示，口径对齐
 * core/world/state.js 枚举注释与逆向报告 §2.2 定谳表。展示文案归 UI 层（world/state 只输出事实维度）。
 * 未知枚举回退原值（宁可显英文符号也不要空白，便于版本漂移肉眼可察）。
 */
const KIND_ZH = {
  homeland: '本服常态',
  pab: '异能秘境',
  wushuang: '无双峡谷',
  kvk_c4: '天梯·四国',
  kvk_c8: '天梯·八国',
  kvk_c8s2: '天梯·八国S2',
  cnc: '征服者·异能',
  cnc25: '征服者2025',
  adp_war: '联盟对决',
  unknown: '未知场景',
};
const PLACE_ZH = {
  base: '自己城内',
  base_other: '别人城内',
  world: '大地图',
  world_old: '旧大地图',
  battle: '战斗演出',
  sphere: '征服者球体',
  transition: '转场',
  boot: '登录中',
  other: '其它场景',
  off: '未就绪',
};

/**
 * 由世界态快照算头部状态胶囊的展示数据（纯函数，不碰 DOM、不采新态）。
 * @param {{kind:string, place:string, reason?:string, raw?:{scene?:string}}} st worldState.current() 快照
 * @returns {{inner:string, warn:boolean, title:string}} inner=胶囊内 HTML（Kind·Place），warn=落 unknown/off 时置真报警，title=悬停原始口径
 */
export function buildWorldStatus(st) {
  const kind = KIND_ZH[st.kind] || st.kind || '—';
  const place = PLACE_ZH[st.place] || st.place || '—';
  const warn = st.kind === 'unknown' || st.place === 'off';
  const inner =
    `<span class="pc-wk">${escAttr(kind)}</span>` +
    '<span class="pc-wdot">·</span>' +
    `<span class="pc-wp">${escAttr(place)}</span>`;
  const scene = (st.raw && st.raw.scene) || '-';
  const title = `Kind=${st.kind || '-'} Place=${st.place || '-'} scene=${scene} reason=${st.reason || '-'}`;
  return { inner, warn, title };
}

/**
 * 重算条件字段（fd.showIf）的显隐：只切 hidden 属性，不重建 DOM（结构不变 → 控件已绑的事件与草稿态全存活）。
 * 一个分组下的字段全被隐藏时，其 .pc-fsec 小标题一起收起；可折叠子分组的字段包在 .pc-fsec-body 里，
 * 不是标题的弟弟元素，故保守当「有内容」不收标题。
 * showIf 抛错按**可见**处理：宁可多显一行，也静默不掉用户能改的字段。
 * @param {Element} root 扫描范围（整个面板）
 */
export function refreshFieldVisibility(root) {
  root.querySelectorAll('[data-dep]').forEach((el) => {
    const f = findFeature(el.dataset.depfid);
    if (!f) return;
    const fd = f.fields.find((x) => x.key === el.dataset.dep);
    if (!fd || !fd.showIf) return;
    let on;
    try {
      on = !!fd.showIf(configs[f.id]);
    } catch (e) {
      on = true;
    }
    if (el.hidden !== !on) el.hidden = !on;
  });
  root.querySelectorAll('.pc-fsec[data-sec]').forEach((head) => {
    let visible = false;
    for (
      let n = head.nextElementSibling;
      n && !n.classList.contains('pc-fsec');
      n = n.nextElementSibling
    ) {
      if (!n.hasAttribute('data-dep') || !n.hidden) {
        visible = true;
        break;
      } // 无条件字段或还有未隐的条件字段
    }
    head.hidden = !visible;
  });
}

/**
 * 组卡片：主闸门 checkbox（pc-gen）+ 展开=子项 checkbox 列表（pc-en）。子项详细参数不展示。
 * 子项声明 `inlineStatus: true` 时，把 descriptor 中第一个 type:'text' 字段的 get() 返回值
 *   内联到开关行（左标签 · 中状态值 · 右 checkbox），不展开 pc-subfields 块。
 * @param {object} node menu.js 组节点
 * @returns {string}
 */
function renderGroupCard(node) {
  const gc = configs[node.id] || { enabled: false };
  const chk = `<input type="checkbox" class="pc-gen" data-gid="${node.id}" ${gc.enabled ? 'checked' : ''}>`;
  const rows = (node.children || [])
    .map((ch) => {
      const c = configs[ch.id] || { enabled: false };
      const f = findFeature(ch.id);
      // inlineStatus: 将第一个 text 字段的值内联到开关行
      if (ch.inlineStatus && f && f.fields && f.fields.length) {
        const fd = f.fields.find((x) => x.type === 'text');
        let val = '';
        if (fd && typeof fd.get === 'function') {
          try {
            val = String(fd.get(c) || '');
          } catch (_) {
            val = '';
          }
        }
        return (
          `<label class="pc-row"><span>${ch.label || (f && f.label) || ch.id}</span>` +
          `<span class="pc-fval" data-fid="${ch.id}" data-fkey="${fd ? fd.key : ''}">${val}</span>` +
          `<input type="checkbox" class="pc-en" data-id="${ch.id}" ${c.enabled ? 'checked' : ''}></label>`
        );
      }
      const head =
        `<label class="pc-row"><span>${ch.label || (f && f.label) || ch.id}</span>` +
        `<input type="checkbox" class="pc-en" data-id="${ch.id}" ${c.enabled ? 'checked' : ''}></label>`;
      // 组内子项一般只出 checkbox；若个别子项声明了 showFields，则紧随其开关行展开该功能的详细字段（通用备用能力），
      //   number/checkbox 控件由 wirePanel 的全局面板委托统一接好（按 data-id 定位功能），无需在此单独绑定
      if (ch.showFields && f && f.fields && f.fields.length) {
        return head + `<div class="pc-subfields">${buildFieldsHTML(ch.id, f)}</div>`;
      }
      return head;
    })
    .join('');
  return (
    `<div class="pc-sec" data-gid="${node.id}">` +
    cardHead(node.label, chk, true) +
    `<div class="pc-sec-body" hidden>${rows || '<div class="pc-empty">无子项</div>'}</div></div>`
  );
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
  return (
    `<div class="pc-sec" data-fid="${fid}">${head}` +
    `<div class="pc-sec-body" hidden>${fields || '<div class="pc-empty">无可调参数</div>'}</div></div>`
  );
}

/**
 * 只读信息卡「快捷键一览」：渲染 core/hotkeys.js list() 当前全部键位（立体键帽 + 功能名 + 场景胶囊）。
 * 按 list() 的 group 分两段：'global'（展示型全域/浮层开关）与 'game'（注册表分派的游戏内裸键），各带小标题。
 * 非 feature：不可开关、不进存储；默认展开（.open + body 不带 hidden），点标题行仍可折叠（wirePanel 通用折叠）。
 * @param {object} node menu.js hotkeys 节点
 * @returns {string}
 */
function renderHotkeysCard(node) {
  const items = hotkeyList();
  const row = function (h) {
    return (
      `<div class="pc-hkrow"><span class="pc-hkk"><kbd>${escAttr(h.display)}</kbd></span>` +
      `<span class="pc-hkl">${escAttr(h.label)}</span>` +
      (h.where ? `<span class="pc-hkw">${escAttr(h.where)}</span>` : '') +
      `</div>`
    );
  };
  // 分组顺序固定：全局/浮层开关在前，游戏内操作在后；group 缺省归 game
  const groups = [
    ['global', '全局 · 浮层开关'],
    ['game', '游戏内操作'],
  ];
  let body = '';
  groups.forEach(function (g) {
    const rows = items.filter(function (h) {
      return (h.group || 'game') === g[0];
    });
    if (!rows.length) return;
    body += `<div class="pc-hkgrp">${escAttr(g[1])}</div>` + rows.map(row).join('');
  });
  return (
    `<div class="pc-sec open" data-hk="1">` +
    cardHead(node.label || '快捷键一览', '', true) +
    `<div class="pc-sec-body">${body || '<div class="pc-empty">暂无快捷键</div>'}</div></div>`
  );
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
  const cards = (cat.children || [])
    .map((n) =>
      n.kind === 'group'
        ? renderGroupCard(n)
        : n.kind === 'hotkeys'
          ? renderHotkeysCard(n)
          : renderFeatureCard(n),
    )
    .join('');
  const extra =
    cat.id === LOGOUT_PANE_ID ? `<button class="pc-btn" id="pc-logout">登出 / 换号</button>` : '';
  return `<div class="pc-pane" data-pane="${cat.id}"${active ? '' : ' hidden'}>${cards || '<div class="pc-empty">无内容</div>'}${extra}</div>`;
}

/**
 * 面板主体 HTML：标题 + 战斗模式开关 + 左 TAB 条 + 右内容区
 * @returns {string}
 */
export function buildPanelHTML() {
  const tabs = MENU.map(
    (c, i) =>
      `<button class="pc-tab${i === 0 ? ' active' : ''}" data-tab="${c.id}">${c.label}</button>`,
  ).join('');
  const panes = MENU.map((c, i) => renderCategoryPane(c, i === 0)).join('');
  return `
      <h3>口袋控制中心<span class="pc-sub">POCKETCC</span></h3>
      <div class="pc-world" id="pc-world"></div>
      <label class="pc-mode"><span>战斗模式</span><input type="checkbox" id="pc-combat"></label>
      <div class="pc-tabs">
        <div class="pc-tabbar">${tabs}</div>
        <div class="pc-tabpanes">${panes}</div>
      </div>`;
}

/**
 * 切换左 TAB：只换右栏 pane 的可见性，并刷一次该 pane 的只读 text 字段。
 * wirePanel 的点击与活动闸门回退（refreshTabGates）共用本入口，避免两处各抄一份切换逻辑而跑偏。
 * @param {Element} panel 面板根
 * @param {string} id 类别 id（menu.js category.id）
 */
export function activateTab(panel, id) {
  panel
    .querySelectorAll('.pc-tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  panel.querySelectorAll('.pc-pane').forEach((p) => {
    p.hidden = p.dataset.pane !== id;
  });
  const pane = panel.querySelector(`.pc-pane[data-pane="${id}"]`);
  if (pane) refreshTexts(pane);
}

/**
 * 重算带 gate 的左 TAB 可点态：活动未开启的 TAB 置 disabled（原生不可点）并在 title 说明原因。
 * 判据求值抛错按**可点**处理（与 refreshFieldVisibility 的 showIf 同规矩）：宁可多给一次可点，
 *   也不因 UI 判据炸掉一整类入口。
 * 当前激活的 TAB 被关时（活动中途退场且面板开着）回退到第一个仍可点的 TAB，别把右栏停在看不见的 pane 上。
 * 不开轮询：挂载 + 开面板 + 功能侧 UI_REFRESH（面板可见）三处调用即够 —— 活动开关由人在游戏里触发，
 *   最迟下次展开面板就会跟上。
 * @param {Element} panel 面板根
 */
export function refreshTabGates(panel) {
  let activeDisabled = false;
  panel.querySelectorAll('.pc-tab').forEach((tab) => {
    const node = findMenuNode(tab.dataset.tab);
    const fn = node && node.gate ? TAB_GATES[node.gate] : null;
    if (!fn) return; // 无闸门的常规类别、以及判据未注册的闸门名：保持可点
    let open;
    try {
      open = !!fn();
    } catch (e) {
      open = true;
    }
    tab.disabled = !open;
    tab.title = open ? '' : `${tab.textContent.trim()}活动未开启`;
    if (!open && tab.classList.contains('active')) activeDisabled = true;
  });
  if (!activeDisabled) return;
  const fallback = panel.querySelector('.pc-tab:not([disabled])');
  if (fallback) activateTab(panel, fallback.dataset.tab);
}

/**
 * 重建某个功能卡片的字段区 DOM（**行集**变了才需要：只刷值不改结构看不见新增行）。
 * 面板原本是「一次性渲染 + 只刷值」模型，而集结目标 / 打野清单的行集现在来自运行时反查游戏表 + 推送自学习：
 *   不重建 DOM 就少一行，用户视角即「日志说加了、面板里没看到」。
 * 重走首次渲染同一入口（buildFieldsHTML），控件值全从 configs 取回，不会丢已存配置；两道保守闸门：
 *   该卡不在当前面板返回 false，焦点在卡内（用户正在输入）也返回 false。
 *   注意面板展开/收起只翻 .pc-sec-body 的 hidden，而整块面板 HTML 只在 mountUI 建一次 —— 所以上面两种跳过情形
 *   不会靠「用户自己打开面板」自愈；调用侧（core/ui/index.js 的 pendingRebuild）负责记账并在开面板时补渲染。
 * @param {Element} root 面板根
 * @param {string} fid 功能 id（如 'allianceRally'）
 * @param {(scope:Element)=>void} [rewire] 新 body 的控件装配回调（实际就是 wireControls）。
 *   body 是 innerHTML 整块换掉的，里面每个控件的监听器也一起没了，不重绑就是「照常可点、看着像改好了，
 *   值却不落盘也不生效」的静默失效（面板级委托只兼容容器型字段，管不到逐元素绑定的勾选框/数字/下拉）。
 * @returns {boolean} 是否真的重建了
 */
export function rerenderFeatureCard(root, fid, rewire) {
  if (!root || !/^[-\w]+$/.test(String(fid))) return false; // fid 来自功能侧自报，先验字再进选择器
  const card = root.querySelector(`.pc-sec[data-fid="${fid}"]`);
  const body = card && card.querySelector('.pc-sec-body');
  if (!body) return false; // 该卡不在当前面板（不可展开或不属于本面板）：由调用侧记账，别默默当成已刷完
  // 面板在 Shadow DOM 里，document.activeElement 只会给到宿主元素，须取所属根的同名属性
  const focused =
    (body.getRootNode() && body.getRootNode().activeElement) || document.activeElement;
  if (focused && body.contains(focused)) return false; // 正在输入：不抢焦点、不丢未落盘的值（由调用侧记账后重试）
  const f = findFeature(fid);
  if (!f) return false;
  body.innerHTML = buildFieldsHTML(fid, f) || '<div class="pc-empty">无可调参数</div>';
  // 控件装配：优先用调用方给的整块重绑回调（与首次渲染同口径）；没给就只兜得住有状态清单，
  //   其余逐元素控件会因 innerHTML 换掉而无人绑定（新调用方务必把 rewire 传上）。
  if (typeof rewire === 'function') {
    rewire(body);
  } else {
    body.querySelectorAll('.pc-ulist').forEach(mountUidList);
    body.querySelectorAll('.pc-slist').forEach(mountSortList);
    body.querySelectorAll('.pc-ilist').forEach(mountItemList);
  }
  refreshFieldVisibility(card); // 条件字段显隐随新行集重算
  refreshTexts(card);
  return true;
}

/**
 * 刷新面板内所有只读字段：type:'text' 按 descriptor.get() 重算当前值；type:'infogrid' 行集来自 fd.rows，
 * 整块重刷（与首次渲染同一渲染器，靠容器 data-id/data-fkey 反查）。
 * 另特处理两个清单内的只读格：怪物清单（huntlist）「已打」（.pc-hlstat[data-hlstat] ← fd.todayText(key)）与
 * 物品清单（itemlist）「总数量」（.pc-istock[data-istock] ← fd.stockText(key)）、「已抢」（.pc-ibought[data-ibought] ← fd.boughtText(key)），以及清单页脚汇总
 *   （.pc-isummary[data-isummary] ← fd.summary(items,state,cfg)，汇总跟快照/额度走同一条通路）。
 * 这些都是「值随数据变、行结构不变」的格：只改文本，绝不整块重刷（itemlist 的拖拽/勾选监听绑在行节点上）。
 * 面板打开 / 卡片展开 / 切 TAB / 功能侧 ui.refresh 时调用，无需定时器（避免常驻轮询）。
 * @param {Element} root 扫描范围（面板或单个 pane/body）
 */
export function refreshTexts(root) {
  root.querySelectorAll('.pc-igraphbox').forEach((box) => refreshFieldBox(box));
  root.querySelectorAll('.pc-fval').forEach((span) => {
    const f = findFeature(span.dataset.fid);
    if (!f) return;
    // 行内只读格的 data-fkey 未必是顶层 fd.key，需下探子描述符（rallygrid 行内计数格 / ctrlrow 的 cell，口径见 findFieldDescriptor）
    const fd = findFieldDescriptor(f, span.dataset.fkey);
    if (!fd) return;
    let next;
    if (span.dataset.hlstat != null) {
      // 怪物清单「已打」格：值按行 key 从 fd.todayText 取（无则不刷）
      if (typeof fd.todayText !== 'function') return;
      next = String(fd.todayText(span.dataset.hlstat) || '');
    } else if (span.dataset.istock != null) {
      // 物品清单「总数量」格：值按行 key 从 fd.stockText 取（无则不刷）
      if (typeof fd.stockText !== 'function') return;
      next = String(fd.stockText(span.dataset.istock) || '');
    } else if (span.dataset.ibought != null) {
      // 物品清单「已抢」格：值按行 key 从 fd.boughtText 取（无则不刷）
      if (typeof fd.boughtText !== 'function') return;
      next = String(fd.boughtText(span.dataset.ibought) || '');
    } else {
      if (!fd.get) return;
      next = String(fd.get(configs[f.id]) || '');
    }
    if (span.textContent !== next) span.textContent = next;
  });
  // 清单页脚汇总：快照/额度变了就要重算（勾选变更时 widgets.js 走同一个 fd.summary，两条通路同口径）
  root.querySelectorAll('.pc-isummary').forEach((div) => {
    if (div.dataset.isummary == null) return;
    const f = findFeature(div.dataset.fid);
    if (!f) return;
    const fd = findFieldDescriptor(f, div.dataset.fkey);
    if (!fd || typeof fd.summary !== 'function') return;
    const c = configs[f.id];
    if (!c) return;
    const items = typeof fd.items === 'function' ? fd.items(c) : fd.items || [];
    const next = String(fd.summary(items, c[fd.key] || {}, c) || '');
    if (div.textContent !== next) div.textContent = next;
  });
}

/**
 * 降级补载后把全部控件回写为新 configs 的态（只改值不重建，保留折叠/TAB 展开态），末尾刷 text 字段。
 * @param {Element} panel 面板根元素
 */
export function syncControls(panel) {
  panel.querySelectorAll('.pc-gen').forEach((cb) => {
    const gc = configs[cb.dataset.gid];
    if (gc) cb.checked = !!gc.enabled;
  });
  panel.querySelectorAll('.pc-en').forEach((cb) => {
    const c = configs[cb.dataset.id];
    if (c) cb.checked = !!c.enabled;
  });
  panel.querySelectorAll('input.pc-fchk').forEach((cb) => {
    cb.checked = !!configs[cb.dataset.id][cb.dataset.key];
  });
  panel.querySelectorAll('input[type=number]').forEach((input) => {
    if (!input.dataset.id) return; // 区间规则行内的数字格靠 data-part 定位，不占 data-id/data-key
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
  panel.querySelectorAll('.pc-uidwrap').forEach((w) => {
    if (!w.classList.contains('pc-uli') && w.__pcUidRefresh) w.__pcUidRefresh();
  });
  // 容器型字段（区间规则 / 多选开关组 / 采集规则 / 下田规则 / 下田时段）：整块重刷内层。
  // 这类字段行数可增可减、选项由配置表运行时枚举，不能只回写单个值；重刷与首次渲染走同一张 FIELD_BOXES
  // 渲染表（refreshFieldBox 靠容器上的 data-id + data-fkey 反查 descriptor），不再逐类抄一份同形块。
  // 注意：重刷会重建种类多选下拉的 DOM，展开态随之收起（只在配置补载后发生，可接受）
  panel
    .querySelectorAll('.pc-rng, .pc-mopts, .pc-mrule, .pc-frule, .pc-trule, .pc-igraphbox')
    .forEach((box) => {
      refreshFieldBox(box);
    });
  // 好友清单：整块重刷 + 重绑（同 ranges，行数可增删）
  panel.querySelectorAll('.pc-ulist').forEach(mountUidList);
  // 领取优先级清单：整块重刷 + 重绑（行不可增删但 ↑/↓ 交换后序号/disabled 态会变）
  panel.querySelectorAll('.pc-slist').forEach(mountSortList);
  // 物品清单（type:'itemlist'）：整块重刷 + 重绑（行不可增删，池由 fd.items 动态枚举）
  panel.querySelectorAll('.pc-ilist').forEach(mountItemList);
  refreshTexts(panel);
}

/**
 * 菜单树按 id 找节点（组卡片需要它收集子项功能 id 做主闸门级联）
 * @param {string} id 节点 id
 * @returns {object|null}
 */
export function findMenuNode(id) {
  let hit = null;
  const walk = (nodes) =>
    nodes.some((n) => {
      if (n.id === id) {
        hit = n;
        return true;
      }
      return !!(n.children && walk(n.children));
    });
  walk(MENU);
  return hit;
}

/**
 * 组闸门级联后的控件回写：子项 checkbox 跟 configs 走（组半开态无需呈现，全有或全无）。
 * @param {Element} sec 组卡片容器
 */
export function syncFeatureChecks(sec) {
  sec.querySelectorAll('.pc-en').forEach((cb) => {
    const c = configs[cb.dataset.id];
    if (c) cb.checked = !!c.enabled;
  });
}
