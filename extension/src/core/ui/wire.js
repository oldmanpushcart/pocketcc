// 面板事件绑定：wirePanel 把 TAB 切换 / 卡片折叠 / 组主闸门级联 / 功能开关 / 各类字段改值 / 登出 / 战斗模式
// 统一挂到面板根。动态可增删行的字段（ranges/multiopts/minerules/farmrules）走面板级事件委托。
// 从 core/ui.js 迁出。骨架渲染在 panel.js，控件装配在 widgets.js，纯 HTML 在 fields.js。
import { createLog } from '../log.js';
import { session } from '../game-api.js';
import { configs, findFeature, saveFeature, saveGroup, applyFeature } from '../registry.js';
import { collectFeatureIds } from '../menu.js';
import { isCombat, setCombatMode } from '../mode.js';
import { findMenuNode, syncFeatureChecks, refreshTexts, refreshFieldVisibility } from './panel.js';
import { setupUidField, mountUidList, mountSortList } from './widgets.js';
import {
  rangesInnerHTML,
  multiOptsInnerHTML,
  mineRulesInnerHTML,
  farmRulesInnerHTML,
} from './fields.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=CORE，与原 ui.js 一致） */
const logCore = createLog('CORE');

/**
 * 给面板绑定交互：TAB 切换 / 卡片折叠 / 组主闸门级联 / 功能开关 / 字段改值 / 登出 / 战斗模式。
 * 所有改动即存档（saveFeature/saveGroup）并实时编排（applyFeature）。
 * @param {Element} panel 面板根元素
 */
export function wirePanel(panel) {
  // TAB 切换：只换右栏 pane 的可见性，切换后刷一次只读 text 字段。
  panel.querySelectorAll('.pc-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab;
      panel.querySelectorAll('.pc-tab').forEach((t) => t.classList.toggle('active', t === tab));
      panel.querySelectorAll('.pc-pane').forEach((p) => {
        p.hidden = p.dataset.pane !== id;
      });
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
      let v = fd.float ? parseFloat(input.value) : parseInt(input.value, 10);
      if (isNaN(v)) v = f.defaults[fd.key];
      v = Math.max(fd.min, v);
      input.value = v;
      configs[f.id][fd.key] = v;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 下拉字段（如战争之源按形态选预设部队）：存档 + 运行中热更。
  // 值按 descriptor 的 option **原类型**回写：字符串档（如卡车「时段模板」、目标模式 random/specify）过去被 parseInt
  // 成 NaN → 静默回落 defaults，用户选完像没生效；没命中 option 才走旧的整数解析（保留非法值兜底）。
  panel.querySelectorAll('select.pc-fsel').forEach((sel) => {
    sel.addEventListener('change', () => {
      const f = findFeature(sel.dataset.id);
      if (!f) return;
      const fd = f.fields.find((x) => x.key === sel.dataset.key);
      const opts =
        (typeof fd.options === 'function' ? fd.options(configs[f.id]) : fd.options) || [];
      const hit = opts.find((o) => String(o.value) === sel.value);
      let v = hit ? hit.value : parseInt(sel.value, 10);
      if (!hit && isNaN(v)) v = f.defaults[fd.key];
      sel.value = String(v);
      configs[f.id][fd.key] = v;
      saveFeature(f);
      applyFeature(f);
    });
  });

  // 动作按钮（type:'button'）：点击调 fd.onClick(cfg)，返回 Promise 则禁用+文案反馈；不触发卡片折叠
  panel.querySelectorAll('.pc-fbtn').forEach((btn) => {
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
  panel.querySelectorAll('.pc-uidwrap').forEach((w) => {
    if (!w.classList.contains('pc-uli')) setupUidField(w);
  });

  // 好友清单字段（type:'uidlist'，玩家点赞）：逐容器装配（行状态机 + ＋/× 增删，见 mountUidList）。
  panel.querySelectorAll('.pc-ulist').forEach(mountUidList);

  // 领取优先级清单字段（type:'sortlist'，遗迹奖励）：逐容器装配（↑/↓ 交换相邻位，见 mountSortList）。
  panel.querySelectorAll('.pc-slist').forEach(mountSortList);

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
      t.list.push({ from: last ? last.to | 0 : 0, to: 0, count: 0 });
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
    t.box.innerHTML = mineRulesInnerHTML(t.list, t.fd, t.cfg);
    saveFeature(t.f);
    applyFeature(t.f);
  });

  // 下田规则字段（type:'farmrules'，自动下田）：田类型/田等级/预设部队下拉 + ☑只下机械田开关，行可增删，
  // 同 minerules 走面板级事件委托；family/level 改动会联动其它控件（雷神封顶 3 级、选 6 级田禁用机械田）需整行重刷，preset 行形状不变。
  const frTarget = (el) => {
    const box = el && el.closest ? el.closest('.pc-frule') : null;
    if (!box) return null;
    const f = findFeature(box.dataset.id);
    if (!f) return null;
    const fd = f.fields.find((x) => x.key === box.dataset.frkey);
    if (!fd) return null;
    const c = configs[f.id];
    if (!Array.isArray(c[fd.key])) c[fd.key] = [];
    // 首次改动先浅拷一份，避免就地 push/splice 污染 descriptor defaults（同 minerules）
    if (c[fd.key] === f.defaults[fd.key]) c[fd.key] = c[fd.key].map((r) => ({ ...r }));
    return { f, fd, box, list: c[fd.key] };
  };
  const frIdx = (el) => {
    const row = el && el.closest ? el.closest('.pc-frrow[data-fidx]') : null;
    return row ? +row.dataset.fidx : -1;
  };
  panel.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.classList) return;
    // ☑只下机械开关：勾选后本行只看机械田（没有则不下、不回退普通田）；行形状不变，无需重刷
    if (el.classList.contains('pc-frmechin')) {
      const t = frTarget(el);
      if (!t) return;
      const idx = frIdx(el);
      if (idx < 0 || idx >= t.list.length) return;
      t.list[idx].mechOnly = !!el.checked;
      saveFeature(t.f);
      applyFeature(t.f);
      return;
    }
    if (!el.classList.contains('pc-frsel')) return;
    const t = frTarget(el);
    if (!t) return;
    const idx = frIdx(el);
    if (idx < 0 || idx >= t.list.length) return;
    const part = el.dataset.part;
    t.list[idx][part] = parseInt(el.value, 10) || 0;
    // family/level 联动其它控件（雷神等级封顶 3、选 6 级田禁用机械田）→ 就地归一后整行重刷；preset 行形状不变无需重刷
    if (part === 'family' || part === 'level') {
      const row = t.list[idx];
      if ((Number(row.family) || 7) === 16 && (Number(row.level) || 0) > 3) row.level = 3;
      if ((Number(row.level) || 0) >= 6) row.mechOnly = false;
      t.box.innerHTML = farmRulesInnerHTML(t.list, t.fd);
    }
    saveFeature(t.f);
    applyFeature(t.f);
  });
  // 增删行：行存在即生效（已无行级开关）。新行默认金矿 5 级、不勾「只下机械」、预设 1（战斗预设）。
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
      t.list.push({ family: 7, level: 5, mechOnly: false, preset: 1 });
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
    t.box.innerHTML = farmRulesInnerHTML(t.list, t.fd);
    saveFeature(t.f);
    applyFeature(t.f);
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
