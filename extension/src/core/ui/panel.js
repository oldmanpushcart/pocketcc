// 面板骨架：菜单树 → 卡片/pane 的渲染，以及只读文本刷新 / 全量控件回写 / 条件字段显隐 / 菜单树查询。
// 从 core/ui.js 迁出。字段 HTML 委托给 fields，动态控件装配委托给 widgets。
import { configs, findFeature } from '../registry.js';
import { MENU } from '../menu.js';
import { list as hotkeyList } from '../hotkeys.js';
import { escAttr } from './dom.js';
import {
  cardHead,
  buildFieldsHTML,
  rangesInnerHTML,
  multiOptsInnerHTML,
  mineRulesInnerHTML,
  farmRulesInnerHTML,
  timeRangesInnerHTML,
} from './fields.js';
import { mountUidList, mountSortList, mountItemList } from './widgets.js';

/**
 * 世界态展示中文名（Kind 场景档 / Place 地图）：仅供面板头部状态胶囊展示，口径对齐
 * core/world-state.js 枚举注释与逆向报告 §2.2 定谳表。展示文案归 UI 层（world-state 只输出事实维度）。
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
 * 刷新面板内所有 type:'text' 只读字段：按 descriptor.get() 重算当前值。
 * 另特处理怪物清单（huntlist）的「已打」只读格（.pc-hlstat[data-hlstat]）：按行 key 调 fd.todayText(key)。
 * 面板打开 / 卡片展开 / 切 TAB / 功能侧 ui.refresh 时调用，无需定时器（避免常驻轮询）。
 * @param {Element} root 扫描范围（面板或单个 pane/body）
 */
export function refreshTexts(root) {
  root.querySelectorAll('.pc-fval').forEach((span) => {
    const f = findFeature(span.dataset.fid);
    if (!f) return;
    let fd = f.fields.find((x) => x.key === span.dataset.fkey);
    if (!fd) {
      // 行内只读格的 data-fkey ≠ 顶层 fd.key，需下探子描述符（同 wire.js 委托口径）：
      //   rallygrid（联盟集结目标紧凑表）行内的计数格 r.count.key / ctrlrow（惧星集结一行多控件）的 cell.key
      for (const x of f.fields) {
        const sub =
          x.type === 'rallygrid'
            ? (x.rows || []).find((r) => r.count && r.count.key === span.dataset.fkey)?.count
            : x.type === 'ctrlrow'
              ? (x.cells || []).find((p) => p.key === span.dataset.fkey)
              : null;
        if (sub) {
          fd = sub;
          break;
        }
      }
    }
    if (!fd) return;
    let next;
    if (span.dataset.hlstat != null) {
      // 怪物清单「已打」格：值按行 key 从 fd.todayText 取（无则不刷）
      if (typeof fd.todayText !== 'function') return;
      next = String(fd.todayText(span.dataset.hlstat) || '');
    } else {
      if (!fd.get) return;
      next = String(fd.get(configs[f.id]) || '');
    }
    if (span.textContent !== next) span.textContent = next;
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
  // 领取优先级清单：整块重刷 + 重绑（行不可增删但 ↑/↓ 交换后序号/disabled 态会变）
  panel.querySelectorAll('.pc-slist').forEach(mountSortList);
  // 物品清单（type:'itemlist'）：整块重刷 + 重绑（行不可增删，池由 fd.items 动态枚举）
  panel.querySelectorAll('.pc-ilist').forEach(mountItemList);
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
  // 下田规则：整块重刷内层（行可增删且行形状随田类型变，同 minerules）
  // 注意：重刷会重建种类多选下拉的 DOM，展开态随之收起（只在配置补载后发生，可接受）
  panel.querySelectorAll('.pc-frule').forEach((box) => {
    const f = findFeature(box.dataset.id);
    if (!f) return;
    const fd = f.fields.find((x) => x.key === box.dataset.frkey);
    if (!fd) return;
    box.innerHTML = farmRulesInnerHTML(configs[f.id][fd.key], fd);
  });
  // 下田时段：整块重刷内层（行可增删，同 ranges/farmrules）
  panel.querySelectorAll('.pc-trule').forEach((box) => {
    const f = findFeature(box.dataset.id);
    if (!f) return;
    const fd = f.fields.find((x) => x.key === box.dataset.trkey);
    if (!fd) return;
    box.innerHTML = timeRangesInnerHTML(configs[f.id][fd.key], fd);
  });
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
