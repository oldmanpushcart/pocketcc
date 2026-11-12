// 面板事件绑定：wirePanel 把 TAB 切换 / 卡片折叠 / 组主闸门级联 / 功能开关 / 各类字段改值 / 登出 / 战斗模式
// 统一挂到面板根。动态可增删行的字段（ranges/multiopts/minerules/farmrules）走面板级事件委托。
// 从 core/ui.js 迁出。骨架渲染在 panel.js，控件装配在 widgets.js，纯 HTML 在 fields.js。
import { createLog } from '../log.js';
import { session } from '../game-api.js';
import { configs, findFeature, saveFeature, saveGroup, applyFeature } from '../registry.js';
import { collectFeatureIds } from '../menu.js';
import { isCombat, setCombatMode } from '../mode.js';
import {
  findMenuNode,
  syncFeatureChecks,
  refreshTexts,
  refreshFieldVisibility,
  activateTab,
} from './panel.js';
import { setupUidField, mountUidList, mountSortList, mountItemList } from './widgets.js';
import {
  findFieldDescriptor,
  refreshFieldBox,
  farmKindSummary,
  farmFamilySummary,
} from './fields.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CORE，与原 ui.js 一致） */
const logCore = createLog('CORE');

/**
 * 给面板绑定交互：TAB 切换 / 卡片折叠 / 组主闸门级联 / 功能开关（以上面板chrome）+ 卡内字段控件（wireControls）
 *   + 容器型字段的面板级委托（wireContainerFields）。
 * 所有改动即存档（saveFeature/saveGroup）并实时编排（applyFeature）。
 * @param {Element} panel 面板根元素
 */
export function wirePanel(panel) {
  // TAB 切换：只换右栏 pane 的可见性，切换后刷一次只读 text 字段（与活动闸门回退同走 activateTab）。
  // 带 gate 的类别在活动未开启时被 panel.js refreshTabGates 置 disabled，原生不再派发 click，这里无需再判。
  panel.querySelectorAll('.pc-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activateTab(panel, tab.dataset.tab);
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

  // 可折叠子分组（.pc-fsectoggle）：点标题行展开/收起紧随其后的 .pc-fsec-body；默认收起的组展开时补刷只读文本。
  // 用面板级委托（子分组体随卡重建而重生，直接绑会失效）。
  panel.addEventListener('click', (e) => {
    const head = e.target.closest ? e.target.closest('.pc-fsectoggle') : null;
    if (!head) return;
    const body = head.nextElementSibling;
    if (!body || !body.classList || !body.classList.contains('pc-fsec-body')) return;
    const open = body.hidden;
    body.hidden = !open;
    head.classList.toggle('open', open);
    if (open) refreshTexts(body);
  });

  // 组主闸门：关→子项全部 enabled=false；开→恢复各子项 intentEnabled（用户意图，组关不丢失）。
  // 组自身 enabled 单独存档（menu.js 声明的组键）；不新增 reactor 门控，级联后逐个 save+apply。
  panel.querySelectorAll('.pc-gen').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const gid = cb.dataset.gid;
      const gc = configs[gid];
      if (!gc) {
        logCore.warn('group config missing: %s', gid);
        return;
      }
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
      logCore.info(
        `group ${gid} ${cb.checked ? 'enabled' : 'disabled'} (cascade ${ids.length} features)`,
      );
    });
  });

  // 功能启用开关（功能卡片 checkbox / 组内子项 checkbox）：同步 intentEnabled（意图）+ enabled（生效态）。
  panel.querySelectorAll('.pc-en').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const f = findFeature(cb.dataset.id);
      if (!f || !configs[f.id]) {
        logCore.warn('feature not registered: %s', cb.dataset.id);
        return;
      }
      configs[f.id].enabled = cb.checked;
      configs[f.id].intentEnabled = cb.checked;
      saveFeature(f);
      applyFeature(f);
      logCore.info(`feature ${f.id} ${cb.checked ? 'enabled' : 'disabled'}`);
    });
  });

  // 卡内字段控件的逐元素绑定抽成 wireControls：卡片 body 会被 rerenderFeatureCard 整块换掉（联盟集结/自动打野的行集随目录浮动），
  //   换出来的新控件若不重走一遍绑定就一个监听都没有——表现是「照常可点、看着像勾上了，值却不落盘也不生效」（面板级委托只管容器型字段）。
  wireControls(panel);
  wireContainerFields(panel);
}

/**
 * 绑定卡片 body 内的字段控件：勾选框 / 数字 / 下拉 / 按钮 / 文本 / UID 复合行 / 各类清单装配。
 * 与 wirePanel 分开导出，正是为了让「卡重建后重新装配」成为可能（调用方见 rerenderFeatureCard 的 rewire 参数）。
 * 对同一批元素重复调用是有害的（双监听 = 一次改动存两遍、应用两遍），所以只对 innerHTML 新替换出来的元素调用。
 * @param {Element} root 绑定范围：整面板（首次装配）或刚重建的某个 .pc-sec-body
 */
export function wireControls(root) {
  // 功能字段勾选框（type:'checkbox' 的 field，如按集结目标单独开关）：改动即存档 + 热更
  root.querySelectorAll('input.pc-fchk').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const f = findFeature(cb.dataset.id);
      if (!f) return;
      configs[f.id][cb.dataset.key] = cb.checked;
      saveFeature(f);
      applyFeature(f);
      // 行级开关不留日志的话，「我明明勾了」就只能靠猜：key 与勾选态进日志流，单轨可回溯改动时刻
      logCore.debug(
        'field checkbox changed. feature=%s;key=%s;checked=%s',
        f.id,
        cb.dataset.key,
        cb.checked,
      );
    });
  });

  // 数字字段：钳制到 min，存档 + 运行中热更（区间规则行内的数字格无 data-id，归 wirePanel 末尾的委托处理）
  // rallygrid（联盟集结目标紧凑表）行内的延迟/上限格：顶层 fd.key ≠ input.dataset.key，需下探 rows（同 tripick.parts 口径）。
  root.querySelectorAll('input[type=number]').forEach((input) => {
    if (!input.dataset.id) return;
    input.addEventListener('change', () => {
      const f = findFeature(input.dataset.id);
      if (!f) return;
      // data-key 可能是顶层 fd.key，也可能是 rallygrid 行内格的 key（子描述符才是存档键），下探口径见 findFieldDescriptor
      const src = findFieldDescriptor(f, input.dataset.key);
      if (!src) return;
      const key = src.key;
      let v = src.float ? parseFloat(input.value) : parseInt(input.value, 10);
      if (src.zeroUnlimited && (isNaN(v) || input.value === ''))
        v = 0; // 留空 = 不限（0），与渲染对称
      else if (isNaN(v)) v = f.defaults[key];
      v = Math.max(src.min != null ? src.min : 0, v);
      input.value = src.zeroUnlimited && v === 0 ? '' : v; // 0 → 留空，placeholder「不限」
      configs[f.id][key] = v;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 下拉字段（如战争之源按形态选预设部队）：存档 + 运行中热更。
  // 值按 descriptor 的 option **原类型**回写：字符串档（如卡车「时段模板」、目标模式 random/specify）过去被 parseInt
  // 成 NaN → 静默回落 defaults，用户选完像没生效；没命中 option 才走旧的整数解析（保留非法值兜底）。
  // tripick（行内多下拉，如异能兽培育「派出的兽 [属相][品种][品质]」）的 select data-key 是 part.key（applyFactions…），
  //   ctrlrow（一行多控件，如惧星集结「等级/方式/预设队伍」）的是 cell.key，都不等于 field.key（applyAttrTrio / fearStarRow），
  //   故 descriptor 查找须同时下探 parts / cells（口径见 findFieldDescriptor），选项取该子控件自己的口径。
  root.querySelectorAll('select.pc-fsel').forEach((sel) => {
    sel.addEventListener('change', () => {
      const f = findFeature(sel.dataset.id);
      if (!f) return;
      const src = findFieldDescriptor(f, sel.dataset.key);
      if (!src) return;
      const key = src.key;
      const opts =
        (typeof src.options === 'function' ? src.options(configs[f.id]) : src.options) || [];
      const hit = opts.find((o) => String(o.value) === sel.value);
      let v = hit ? hit.value : parseInt(sel.value, 10);
      if (!hit && isNaN(v)) v = f.defaults[key];
      sel.value = String(v);
      configs[f.id][key] = v;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 动作按钮（type:'button'）：点击调 fd.onClick(cfg)，返回 Promise 则禁用+文案反馈；不触发卡片折叠
  root.querySelectorAll('.pc-fbtn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const f = findFeature(btn.dataset.id);
      if (!f) return;
      const fd = f.fields.find((x) => x.key === btn.dataset.bkey);
      if (!fd || typeof fd.onClick !== 'function') return;
      const restore = () => {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = fd.label;
        }
      };
      btn.disabled = true;
      btn.textContent = fd.busyText || '处理中…';
      try {
        Promise.resolve(fd.onClick(configs[f.id])).then(restore, restore);
      } catch (err) {
        restore();
      }
    });
  });

  // 可编辑文本字段（如城市技能赠送 UID）：点输入框不触发卡片折叠，改动 trim 后按字符串存档 + 热更
  root.querySelectorAll('input.pc-fstr').forEach((input) => {
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
  root.querySelectorAll('.pc-uidwrap').forEach((w) => {
    if (!w.classList.contains('pc-uli')) setupUidField(w);
  });

  // 好友清单字段（type:'uidlist'，玩家点赞）：逐容器装配（行状态机 + ＋/× 增删，见 mountUidList）。
  root.querySelectorAll('.pc-ulist').forEach(mountUidList);

  // 领取优先级清单字段（type:'sortlist'，遗迹奖励）：逐容器装配（↑/↓ 交换相邻位，见 mountSortList）。
  root.querySelectorAll('.pc-slist').forEach(mountSortList);

  // 物品清单字段（type:'itemlist'，秘境拾取）：逐容器装配，行不可增删（见 mountItemList）。
  root.querySelectorAll('.pc-ilist').forEach(mountItemList);
}

/**
 * 容器型字段的面板级事件委托（ranges/multiopts/minerules/farmrules/huntlist/…）、登出与战斗模式总开关的绑定。
 * 这些挂在面板根上，卡体重建不影响委托生效，故无需随卡重新装配。
 * @param {Element} panel 面板根元素
 */
function wireContainerFields(panel) {
  panel.querySelector('#pc-logout').addEventListener('click', () => {
    session.logout(); // 游戏登出（PlatformCore 符号收口于 core/game-api.js 防腐层）
  });

  // ── 容器型字段（ranges / multiopts / minerules / farmrules / timeranges / huntlist / presetpool）的公共解析 ──
  // fields.js 的 fieldBox 给这类容器统一打了 data-id（功能 id）+ data-fkey（字段 key），行统一打 data-idx，
  // 于是「上浮容器→反查 descriptor→取配置数组」与「取行下标」各只需一份实现。
  // 以前每种字段自带一对手写解析器（7+6 份同形拷贝，属性名还各取一套），新增一类字段就得再抄一份，
  // 且属性名漏改是静默失效：控件照常可点、值不落盘。
  /**
   * @param {Element} el 事件目标
   * @param {string} sel 容器类选择器（.pc-rng / .pc-mopts / …）
   * @param {(c:object, fd:object)=>void} [align] 取数组前的对齐钩子（huntlist 需按 catalog 重建行序）
   * @returns {{f:object, fd:object, box:Element, list:Array, cfg:object}|null}
   */
  const boxTarget = (el, sel, align) => {
    const box = el && el.closest ? el.closest(sel) : null;
    if (!box) return null;
    const f = findFeature(box.dataset.id);
    if (!f) return null;
    const fd = findFieldDescriptor(f, box.dataset.fkey);
    if (!fd) return null;
    const c = configs[f.id];
    if (!c) return null;
    if (align) align(c, fd);
    // 数组字段与 descriptor defaults 的引用隔离已在 registry.loadAllConfigs 单点处理（assignDefaults），
    // 此处与下面各委托一律就地增删，不必再判「是否 defaults 本体」
    if (!Array.isArray(c[fd.key])) c[fd.key] = [];
    return { f, fd, box, list: c[fd.key], cfg: c };
  };
  /** 行下标：只取自行上的 data-idx（列头行没这个属性，按行类名的 querySelectorAll 下标数会把列头算进去，整体偏一位） */
  const idxOf = (el, rowSel) => {
    const row = el && el.closest ? el.closest(rowSel + '[data-idx]') : null;
    return row ? +row.dataset.idx : -1;
  };

  // 区间规则字段（如联盟机甲按召唤所需碎片数分段）：行可动态增删，故用面板级事件委托而非逐控件绑定。
  const rangesTarget = (el) => boxTarget(el, '.pc-rng');
  const rngIdx = (el) => idxOf(el, '.pc-rngrow');
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
      t.list.push({ from: last ? last.to | 0 : 0, to: 0, count: 0 });
    }
    refreshFieldBox(t.box);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 多选开关组字段（type:'multiopts'，次元矿洞矿种）：勾选/取消与全选/清空均整批重存 number[]。
  // 与区间规则一样用面板级事件委托（选项由配置表运行时枚举，不逐个绑控件）。
  // fd.maxSelect>0 时限最多勾选数：已满再点→回弹不入库；满额后整块重刷以把其余项置 disabled。
  const moptsTarget = (el) => boxTarget(el, '.pc-mopts');
  panel.addEventListener('change', (e) => {
    const inp = e.target;
    if (!inp.classList || !inp.classList.contains('pc-moptchk')) return;
    const t = moptsTarget(inp);
    if (!t) return;
    const val = parseInt(inp.value, 10);
    const i = t.list.indexOf(val);
    const cap = Math.max(0, Math.floor(Number(t.fd.maxSelect) || 0));
    if (inp.checked && i < 0) {
      if (cap > 0 && t.list.length >= cap) {
        // 已达上限：回弹该框并重刷（恢复 disabled 口径），不静默改配置
        refreshFieldBox(t.box);
        return;
      }
      t.list.push(val);
    } else if (!inp.checked && i >= 0) t.list.splice(i, 1);
    if (cap > 0) refreshFieldBox(t.box);
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
      const cap = Math.max(0, Math.floor(Number(t.fd.maxSelect) || 0));
      const pick = cap > 0 ? opts.slice(0, cap) : opts; // 有上限时“全选”退化为“取前 N 项”
      t.list.length = 0;
      pick.forEach((o) => t.list.push(o.value));
    } else {
      t.list.length = 0;
    }
    refreshFieldBox(t.box);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 采集规则字段（type:'minerules'，次元矿洞）：矿种/等级下拉 + 星级★点选，行可增删，走面板级事件委托。
  const mrTarget = (el) => boxTarget(el, '.pc-mrule');
  const mrIdx = (el) => idxOf(el, '.pc-mrrow');
  // 矿种/等级下拉：按 data-part 写入对应维度（0=不限），change 即落盘生效
  panel.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('pc-mrsel')) return;
    const t = mrTarget(el);
    if (!t) return;
    const idx = mrIdx(el);
    if (idx < 0 || idx >= t.list.length) return;
    const part = el.dataset.part === 'level' ? 'level' : 'type';
    t.list[idx][part] = parseInt(el.value, 10) || 0;
    saveFeature(t.f);
    applyFeature(t.f);
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
      t.list[idx].star = t.list[idx].star === s ? 0 : s;
    } else if (del) {
      const idx = mrIdx(del);
      if (idx >= 0 && idx < t.list.length) t.list.splice(idx, 1);
    } else {
      // 行存在即生效（已无行级开关）：新规则默认取具体值而非“不限”（矿种=第一个真实矿种、等级=最高、星级=最高）。
      // 添加行会把本功能总开关关闭（新行未配好即生效会误采），配好后由用户手动重新打开。
      const topts = (typeof t.fd.options === 'function' ? t.fd.options(t.cfg) : t.fd.options) || [];
      const first = topts.find((o) => Number(o.value) > 0);
      const lopts =
        (typeof t.fd.levelOptions === 'function' ? t.fd.levelOptions(t.cfg) : t.fd.levelOptions) ||
        [];
      let maxLv = 0;
      for (const o of lopts) {
        const v = Number(o.value) || 0;
        if (v > maxLv) maxLv = v;
      }
      const maxStar =
        (typeof t.fd.maxStar === 'function' ? t.fd.maxStar(t.cfg) : t.fd.maxStar) || 5;
      t.list.push({ type: first ? Number(first.value) : 0, level: maxLv, star: maxStar });
      // 加行即暂停总开关：清 enabled/intentEnabled，回写卡片勾选与组级联（新行未配好即生效会误采）
      const c = configs[t.f.id];
      if (c) {
        c.enabled = false;
        c.intentEnabled = false;
        const enCb = panel.querySelector('.pc-en[data-id="' + t.f.id + '"]');
        if (enCb) enCb.checked = false;
        const sec = enCb && enCb.closest ? enCb.closest('.pc-sec') : null;
        if (sec) syncFeatureChecks(sec);
      }
    }
    refreshFieldBox(t.box);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 下田规则字段（type:'farmrules'，自动下田）：预设编队单选 / 资源类型多选 / 资源种类多选，行可增删。
  // 同 minerules 走面板级事件委托；两个多选组（family / kind）勾选**就地更新**（不重建下拉 DOM，展开态得以保持），
  // preset 互斥的 disabled 状态跨行联动、行增删则整块重绘。
  const frTarget = (el) => boxTarget(el, '.pc-frule');
  const frIdx = (el) => idxOf(el, '.pc-frrow');
  // 资源种类多选的展开/收起。主路径用 Popover API（top layer）：面板/卡片/内容区的 overflow 裁切与面板的
  // backdrop-filter（会给 fixed 子元素建 containing block）都困不住它，所以选项列表能像原生下拉那样浮在行下方、
  // 不撑高卡片；light dismiss（点浮层外/Esc）由浏览器代劳，这里只补两件浏览器不管的：定位 + 箭头态类名同步。
  // 老 Chrome（<114）无 popover 属性 → 降级为流内撑开独占一行（样式在 panel-css 的 .pc-frkinds.pc-open 分支）。
  const kindPopSupported = (() => {
    const probe = document.createElement('div');
    return typeof probe.showPopover === 'function' && typeof probe.hidePopover === 'function';
  })();
  if (kindPopSupported)
    panel.classList.add('pc-kindpop'); // 把浮层样式打开（否则默认规则把 .pc-frkpop 当流内展开用）
  else logCore.debug('popover API unavailable, kind multiselect falls back to in-flow expand.');
  const KIND_OPEN_SEL = '.pc-frkinds.pc-open'; // 展开中的种类行容器（收起与类名同步共用一个口径）
  const KIND_POP_SEL = '.pc-frkpop'; // 容器内的选项浮层
  const hideKindPops = () => {
    panel.querySelectorAll(KIND_OPEN_SEL).forEach((x) => {
      const p = x.querySelector(KIND_POP_SEL);
      if (kindPopSupported && p && p.hidePopover) {
        try {
          p.hidePopover();
        } catch {
          /* 已经收起：类名照删 */
        }
      }
      x.classList.remove('pc-open');
    });
  };
  /**
   * 只把“浏览器已经自己关掉”的浮层类名补齐（箭头不能一直翻着）；
   * 本拍刚 hide 又立刻 reopen 的（getPopover 仍为 shown）不动，否则会误关刚展开的列表。
   */
  const syncKindPopClass = () => {
    if (!kindPopSupported) return;
    panel.querySelectorAll(KIND_OPEN_SEL).forEach((x) => {
      const p = x.querySelector(KIND_POP_SEL);
      if (p && p.getPopover && p.getPopover() === 'hidden') x.classList.remove('pc-open');
    });
  };
  /** 浮层左上角对齐按钮左下角（top layer 里的 fixed 坐标就是视口坐标） */
  const placeKindPop = (box, pop) => {
    const btn = box.querySelector('.pc-frkbtn');
    if (!btn || !btn.getBoundingClientRect) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const w = Math.max(r.width, Math.min(190, vw - 16));
    const left = Math.max(8, Math.min(Math.round(r.left), vw - w - 8));
    pop.style.cssText =
      'position:fixed;margin:0;left:' +
      left +
      'px;top:' +
      Math.round(r.bottom + 3) +
      'px;' +
      'min-width:' +
      w +
      'px;';
  };
  /**
   * 行内两个多选组（family 资源类型 / kind 资源种类）的就地刷新：摘要文案 + 各项勾选态 + 遗迹置灰联动。
   * 不整块重绘，否则展开中的浮层会被自己关掉（连着勾第二项就断）；两个组都不影响别行的 preset
   * disabled 联动（那是 preset 之间的事），所以都不需要跟着重绘。
   * @param {Element} rowEl .pc-frrow
   * @param {{families?:number[], kinds?:string[]}} row 该行当前值
   * @param {object} fd 字段描述符（家族摘要要用它的下拉数据源）
   */
  const syncRowGroupsUi = (rowEl, row, fd) => {
    if (!rowEl || !rowEl.querySelectorAll) return;
    const fams = (Array.isArray(row.families) ? row.families : []).map((f) => String(f));
    const kinds = Array.isArray(row.kinds) ? row.kinds : [];
    // 雷神(family 16) 没有 6 级田：本行勾选的家族全都开不出遗迹 → 遗迹置灰（与 feat 侧 normalizeRules 同口径）
    const thunder = fams.length > 0 && fams.every((f) => f === '16');
    rowEl.querySelectorAll('.pc-frkinds').forEach((holder) => {
      const isFam = holder.dataset.grp === 'family';
      const want = isFam ? fams : kinds;
      holder.querySelectorAll('.pc-frkin').forEach((cb) => {
        cb.checked = want.indexOf(cb.value) >= 0;
        if (isFam || cb.value !== 'relic') return;
        cb.disabled = thunder;
        const opt = cb.closest('.pc-frkopt');
        if (opt) opt.classList.toggle('pc-frkoptdis', thunder);
      });
      const sum = holder.querySelector('.pc-frksum');
      if (!sum) return;
      sum.textContent = isFam
        ? farmFamilySummary(row.families || [], fd.familyOptions)
        : farmKindSummary(kinds);
    });
  };
  panel.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || !el.classList) return;
    const btn = el.closest ? el.closest('.pc-frkbtn') : null;
    if (btn) {
      const box = btn.closest('.pc-frkinds');
      const pop = box.querySelector(KIND_POP_SEL);
      const wasOpen = box.classList.contains('pc-open');
      hideKindPops();
      if (wasOpen) return; // 再点一次按钮 = 收起
      box.classList.add('pc-open');
      if (kindPopSupported && pop && pop.showPopover) {
        try {
          placeKindPop(box, pop);
          pop.showPopover();
        } catch (err) {
          // showPopover 报错（元素已脱离文档等）：本会话常驻退回流内撑开那一档，
          // 不能让列表既不弹也不撑（两头落空 = 点了没反应）
          panel.classList.add('pc-kindpopfail');
          logCore.debug(
            'kind popover open failed, fallback to in-flow expand: %s',
            err && err.message,
          );
        }
      }
      return;
    }
    if (el.closest && el.closest(KIND_POP_SEL)) return; // 展开列表内操作（勾选/改文案）：保持展开
    hideKindPops();
    syncKindPopClass();
  });
  // 浮层位置按打开那一刻的按钮 rect 定死（top layer 里的 fixed 不跟着重排），所以任何一层滚动都把列表收起：
  // 跟原生下拉一致，也免得选项飘到别的行下面被误勾。scroll 不冒泡，用捕获抓外层面板与内层 pane 两级。
  panel.addEventListener('scroll', hideKindPops, { capture: true, passive: true });
  panel.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.classList) return;
    // 多选组（资源类型 family / 资源种类 kind）内的勾选：按 data-part 分流进本行的 families / kinds，
    // 然后**只就地刷控件**（摘要/勾选态/遗迹置灰），不整块重绘：重绘会把展开的选项列表关掉，
    // 勾第二个选项就断（两个组都只影响本行，不必联动别行）。
    if (el.classList.contains('pc-frkin')) {
      const t = frTarget(el);
      if (!t) return;
      const idx = frIdx(el);
      if (idx < 0 || idx >= t.list.length) return;
      const row = t.list[idx];
      const isFam = el.dataset.part === 'family';
      const key = isFam ? 'families' : 'kinds';
      const cur = Array.isArray(row[key]) ? row[key].slice() : [];
      // 家族存数字、种类存字符串（与 normalizeRules / 账本的字段形状一致）
      const val = isFam ? Number(el.value) : el.value;
      const pos = cur.findIndex((x) => String(x) === String(val));
      if (el.checked && pos < 0) cur.push(val);
      else if (!el.checked && pos >= 0) cur.splice(pos, 1);
      row[key] = cur;
      // 只剩雷神（本行勾的家族全开不出 6 级田）→ 同步剔除已勾的遗迹，不留数据与控件的矛盾态
      if (isFam && cur.length && cur.every((f) => Number(f) === 16) && Array.isArray(row.kinds))
        row.kinds = row.kinds.filter((k) => k !== 'relic');
      syncRowGroupsUi(el.closest('.pc-frrow'), row, t.fd);
      saveFeature(t.f);
      applyFeature(t.f);
      return;
    }
    // 剩下的单选只有一件：预设编队（改动要整块重绘同步其它行的 disabled）
    if (!el.classList.contains('pc-frsel')) return;
    const t = frTarget(el);
    if (!t) return;
    const idx = frIdx(el);
    if (idx < 0 || idx >= t.list.length) return;
    const row = t.list[idx];
    row[el.dataset.part] = parseInt(el.value, 10) || 0;
    refreshFieldBox(t.box); // 其它行的 preset disabled 状态要同步（重绘会把展开中的多选列表收起）
    saveFeature(t.f);
    applyFeature(t.f);
  });
  // 增删行：行存在即生效。新行默认第一支空闲预设 + 金矿 + 机械/普通田。
  // 添加行会把「自动下田」总开关关闭（新行未配好即生效会派错兵），配好后由用户手动重新打开。
  panel.addEventListener('click', (e) => {
    const del = e.target.closest ? e.target.closest('.pc-frdel') : null;
    const add = e.target.closest ? e.target.closest('.pc-fradd') : null;
    if (!del && !add) return;
    const t = frTarget(del || add);
    if (!t) return;
    if (del) {
      const idx = frIdx(del);
      if (idx >= 0 && idx < t.list.length) t.list.splice(idx, 1);
    } else {
      const used = new Set(t.list.map((r) => Number(r && r.preset) || 1));
      let free = 1;
      while (free <= 16 && used.has(free)) free++;
      t.list.push({ preset: free, families: [7], kinds: ['tower', 'normal'] });
      // 加行即暂停总开关：清 enabled/intentEnabled，回写卡片勾选与组级联（新行未配好即生效会派错兵）
      const c = configs[t.f.id];
      if (c) {
        c.enabled = false;
        c.intentEnabled = false;
        const enCb = panel.querySelector('.pc-en[data-id="' + t.f.id + '"]');
        if (enCb) enCb.checked = false;
        const sec = enCb && enCb.closest ? enCb.closest('.pc-sec') : null;
        if (sec) syncFeatureChecks(sec);
      }
    }
    refreshFieldBox(t.box);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 下田时段字段（type:'timeranges'，自动下田）：每行两个原生 <input type=time>（起始~结束），行可增删。
  // 同 ranges/farmrules 走面板级事件委托；time 控件无 data-id，靠专属类 .pc-tinp 命中（通用 number/select/fstr 处理器会自动跳过）。
  const trTarget = (el) => boxTarget(el, '.pc-trule');
  const trIdx = (el) => idxOf(el, '.pc-trow');
  // 敲字实时同步进内存（不落盘不重刷）：防止未 blur 的编辑被增删行的整块重绘吞掉（同 ranges 踩过的坑）。
  panel.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('pc-tinp')) return;
    const t = trTarget(el);
    if (!t) return;
    const idx = trIdx(el);
    if (idx < 0 || idx >= t.list.length) return;
    t.list[idx][el.dataset.part === 'end' ? 'end' : 'start'] = el.value;
  });
  // 选定完整时刻（change）：写回 + 落盘 + 热更（时段增删会即时影响下田/撤田判定）。
  panel.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('pc-tinp')) return;
    const t = trTarget(el);
    if (!t) return;
    const idx = trIdx(el);
    if (idx < 0 || idx >= t.list.length) return;
    t.list[idx][el.dataset.part === 'end' ? 'end' : 'start'] = el.value;
    saveFeature(t.f);
    applyFeature(t.f);
  });
  // 增删行：行存在即生效。新行默认 09:00~18:00（合法时段，不必暂停总开关）。
  panel.addEventListener('click', (e) => {
    const del = e.target.closest ? e.target.closest('.pc-tdel') : null;
    const add = e.target.closest ? e.target.closest('.pc-tradd') : null;
    if (!del && !add) return;
    const t = trTarget(del || add);
    if (!t) return;
    if (del) {
      const idx = trIdx(del);
      if (idx >= 0 && idx < t.list.length) t.list.splice(idx, 1);
    } else {
      t.list.push({ start: '09:00', end: '18:00' });
    }
    refreshFieldBox(t.box);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 怪物清单字段（type:'huntlist'，自动打野）：逐行改值（数量、攻打方式、参与；等级不入清单，野怪行派发时由功能侧从游戏表运行时反查）。
  // 行集来自 fd.catalog（可以是getter：自动打野的目录已改为运行时反查游戏表，行会随赛季增删）；align 令「存档序==catalog 序」，写回按该行 data-hkey 反查下标。
  const hlTarget = (el) =>
    // 选择器排除 `.pc-ct`：表格型 ctrlrow 容器的 class 就是 "pc-hl pc-ct"，与本字段容器同类名；
    //   data-attr schema 统一后两者都带 data-id + data-fkey，靠属性反查已分不开，只能在选择器上挡。
    boxTarget(el, '.pc-hl:not(.pc-ct)', (c, fd) => {
      if (!Array.isArray(fd.catalog)) return; // 非 huntlist 字段不对齐：否则下面会把该字段 config 清成 [] 并落盘
      // 面板按 catalog 渲染（行序=catalog 下标、每行带 key），写回却按行下标落到存档数组上。
      // 存档可能早于目录新增行（如后来加的难民营）或顺序错位：直接按下标写会勾到别的怪行、新 key 行永不落盘，
      // 而 feat 用 normalizeHunt 按 key 归一，读不到该行 → 该玩法勾了也静默不激活（曾卡死难民营）。
      // 故每次取目标先按 catalog 全量对齐 huntlist：逐 key 保留已存值、补齐缺失行、剔除目录已删行，令「下标==catalog 下标==该行 key」。
      const cat = Array.isArray(fd.catalog) ? fd.catalog : [];
      const prev = Array.isArray(c[fd.key]) ? c[fd.key] : [];
      const stored = {};
      for (const r of prev) if (r && r.key) stored[r.key] = r;
      c[fd.key] = cat.map((mo) => {
        const old = stored[mo.key];
        return old
          ? { ...old }
          : { key: mo.key, count: mo.defaultCount | 0, mode: mo.defaultMode, on: !!mo.defaultOn };
      });
    });
  const hlIdx = (el, list) => {
    // 行身份优先用该行渲染时钉死的 data-hkey 到存档数组里反查：目录已改为运行时反查游戏表（表驱动），
    //   面板渲染后目录可能刷新重排，而 align 把存档数组重建为新目录序——此时「下标==DOM 行序」不再成立，
    //   按下标写回会勾到别的怪行。key 反查对静态目录与动态目录都等价（旧行仍按 data-idx 回落，行为不变）。
    const row = el && el.closest ? el.closest('.pc-hlrow') : null;
    const hk = row && row.dataset ? row.dataset.hkey : '';
    if (hk) {
      for (let i = 0; i < list.length; i++) if (list[i] && list[i].key === hk) return i;
    }
    return idxOf(el, '.pc-hlrow');
  };
  panel.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.classList) return;
    const isNum = el.classList.contains('pc-hln');
    const isSel = el.classList.contains('pc-hlsel');
    const isChk = el.classList.contains('pc-hlchk');
    if (!isNum && !isSel && !isChk) return;
    const t = hlTarget(el);
    if (!t) return;
    const idx = hlIdx(el, t.list);
    if (idx < 0 || idx >= t.list.length) return;
    const part = el.dataset.part;
    if (isChk) t.list[idx][part] = !!el.checked;
    else if (isSel)
      t.list[idx][part] = el.value; // 攻打方式=字符串键
    else {
      let v = parseInt(el.value, 10);
      if (isNaN(v) || v < 0) v = 0;
      if (part === 'count') {
        // 该行有硬上限（如惧星 10）则钳位；0 仍表不限，不受钳位影响
        const cat = t.fd.catalog && t.fd.catalog[idx];
        const cap = cat && Number.isFinite(cat.maxCount) && cat.maxCount > 0 ? cat.maxCount | 0 : 0;
        if (cap > 0 && v > cap) v = cap;
      }
      el.value = part === 'count' && v === 0 ? '' : v; // count 0 → 留空（placeholder「不限」）
      t.list[idx][part] = v;
    }
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 打野预设池字段（type:'presetpool'，自动打野）：动态增删单选行，每个预设只能进一次（跨行去重）。
  // 改选/增删都要整块重刷以重算其它行可选项；值落 configs[fid][fd.key]=number[]（有序、去重）。
  const ppTarget = (el) => boxTarget(el, '.pc-pp');
  const ppIdx = (el) => idxOf(el, '.pc-pprow');
  panel.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('pc-ppsel')) return;
    const t = ppTarget(el);
    if (!t) return;
    const idx = ppIdx(el);
    if (idx < 0 || idx >= t.list.length) return;
    const v = parseInt(el.value, 10) || 0;
    // 兜底：若该值已被别的行占用（理论上选项已剔除，防陈旧 DOM），忽略并不入库，重刷回正
    if (t.list.indexOf(v) >= 0 && t.list[idx] !== v) {
      refreshFieldBox(t.box);
      return;
    }
    t.list[idx] = v;
    refreshFieldBox(t.box);
    saveFeature(t.f);
    applyFeature(t.f);
  });
  panel.addEventListener('click', (e) => {
    const del = e.target.closest ? e.target.closest('.pc-ppdel') : null;
    const add = e.target.closest ? e.target.closest('.pc-ppadd') : null;
    if (!del && !add) return;
    const t = ppTarget(del || add);
    if (!t) return;
    const max = Math.max(1, Math.floor(Number(t.fd.max) || 8));
    if (del) {
      const idx = ppIdx(del);
      if (idx >= 0 && idx < t.list.length) t.list.splice(idx, 1);
    } else {
      if (t.list.length >= max) return; // ＋已 disabled，兜底
      let free = 0;
      for (let n = 1; n <= max; n++) {
        if (t.list.indexOf(n) < 0) {
          free = n;
          break;
        }
      }
      if (free) t.list.push(free);
    }
    refreshFieldBox(t.box);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 联盟集结目标表（type:'rallygrid'）自学习行的×删除：行由 feat 目录驱动（learnedTargets ⨝ 表反查），
  //   删除只能回到 feat 侧动私有持久态，故经描述符 onDeleteRow(itemIdsCsv) 回调，不在这里碰 configs。
  //   走面板级委托（非逐个绑定）：学习行增删会整块重刷 DOM，委托对新建的按钮照旧生效。
  panel.addEventListener('click', (e) => {
    const del = e.target.closest ? e.target.closest('.pc-rgdel') : null;
    if (!del) return;
    e.stopPropagation(); // 不触发卡片折叠
    const box = del.closest('.pc-rg');
    if (!box) return;
    const f = findFeature(box.dataset.id);
    if (!f) return;
    const fd = findFieldDescriptor(f, box.dataset.fkey);
    if (!fd || typeof fd.onDeleteRow !== 'function') return;
    // 先把焦点从×移走：否则下面同步 rebuild 时 rerenderFeatureCard 会拿「activeElement 仍在卡片 body 内」
    //   判定为「用户正在输入」而跳过重建（行集变化被记进 pendingRebuild，要等重开面板才补刷），
    //   用户视角即「点了×但行没消失」。blur 后焦点落到面板外，闸门放行，当场删行。
    del.blur();
    fd.onDeleteRow(del.dataset.rowkey);
  });

  // 战斗模式总开关：翻态即广播 mode.change（reactor 重算门控、图标换态）。不持久化，默认日常。
  const combatCb = panel.querySelector('#pc-combat');
  combatCb.checked = isCombat();
  combatCb.addEventListener('change', () => {
    setCombatMode(combatCb.checked);
  });

  // 条件字段显隐（fd.showIf）：任何字段改动都可能翻动别的字段（如「目标模式」从随机切到指定要收起联盟/离线阈值）。
  // 挂面板级 change 委托兜住全部控件类型：change 会冒泡，且各控件自己的监听在 target 阶段已跑完
  // saveFeature/applyFeature，到这里 configs 必定是新值；只切 hidden 不重建，所以重复触发代价可忽。
  panel.addEventListener('change', () => refreshFieldVisibility(panel));
}
