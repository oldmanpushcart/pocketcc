/**
 * 下田规则字段类型 module（type:'farmrules'，自动下田）。
 *
 * T2（架构审查候选 1）：render 迁自 fields.js farmRulesInnerHTML（连同 FARM_KIND_DEFS / farmKindSummary /
 * farmFamilySummary 三个只服务本类型的 helper），数据事件迁自 wire.js farmrules 委托。
 * 「资源类型/种类」浮层是**面板级生命周期**（一次性探测 + panel 类名、全面板扫描收起、点浮层外 dismiss、
 * scroll 捕获监听），超出 dispatcher（单容器 closest('[data-fkey]') + 仅 input/change/click），故经定稿外
 * 新增的可选 mount(panel, log) 钩子自持（用户拍板 A，与 Q7「有状态清单保留 mount* 装配」先例一致，T5 可复用）。
 * 数据事件（family/kind/preset change + 增删 click）仍走 dispatcher：mount 只管浮层 UI，不碰数据提交。
 *
 * 依赖面 = dom.js（escAttr）+ ctx + mount 传入的 panel/log；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 资源种类定义（值 → 下拉摘要短名 / 展开后的全名 / 说明）。雷神(family16) 无遗迹田，渲染时单独禁用。
 * 数组顺序就是下田优先级（遗迹 > 机械 > 普通），摘要拼接与展开列表都按此序，不随勾选先后变化。
 * @type {Array<{value:string,label:string,short:string,title:string}>}
 */
const FARM_KIND_DEFS = [
  {
    value: 'relic',
    short: '遗迹',
    long: '遗迹(6级)',
    title: '遗迹田：只能由「遗迹区域刷新」邮件开出，刷新后 4 小时内可采',
  },
  {
    value: 'tower',
    short: '机械',
    long: '机械田',
    title: '机械田：联盟成员建造的资源塔，需有余量（派前查驻军容量）',
  },
  {
    value: 'normal',
    short: '普通',
    long: '普通田',
    title: '普通田：1~5 级，走 906 服务端搜索，等级从高到低试',
  },
];

/**
 * 种类多选 → 下拉按钮上的摘要文案（按优先级序拼短名，一项未选回「未选」= 该行不下田）。
 * 首次渲染与勾选后就地刷新共用此函数，避免两处文案口径漂移。
 * @param {string[]} kinds 已选种类
 * @returns {string} 形如 "遗迹·机械"
 */
function farmKindSummary(kinds) {
  const arr = Array.isArray(kinds) ? kinds : [];
  const picked = FARM_KIND_DEFS.filter((d) => arr.indexOf(d.value) >= 0);
  return picked.length ? picked.map((d) => d.short).join('·') : '未选';
}

/**
 * 资源类型多选 → 下拉按钮上的摘要文案（按 familyOptions 的**展示序**拼短名，一项未选回「未选」= 该队不下田）。
 * 摘要顺序不表达优先级：同分时的家族优先级（雷神 > 石油 = 粮食 > 金矿）真相在 priority.FAMILY_RANK，
 * 与面板展示序故意解耦，改下拉选项顺序不会偷偷改掉取田优先级。
 * @param {number[]} families 已选家族编码
 * @param {Array<{value:number,label:string,short?:string}>} options 家族下拉数据源
 * @returns {string} 形如 "金·粮·油"
 */
function farmFamilySummary(families, options) {
  const arr = (Array.isArray(families) ? families : []).map((f) => Number(f) || 0);
  const picked = (options || []).filter((o) => arr.indexOf(Number(o.value)) >= 0);
  return picked.length ? picked.map((o) => o.short || String(o.label)).join('·') : '未选';
}

/**
 * 下田规则字段（type:'farmrules'，自动下田）内层 HTML：标题行（含右上＋）+ 若干「队伍行」。
 * **一行 = 一支队伍去匹配资源**：预设编队▾(1~16，单选、整表互斥) + 资源类型▾多选(金/粮/油/雷神)
 * + 资源种类▾多选(遗迹/机械/普通) + × 删除。
 * 两个多选控件是**下拉样式的多选**（原生 select 做不到“展开后不收起、每项带勾选框”，故自研）：
 * 按钮显示已选摘要，点开是一份浮在下方的选项列表（每项 checkbox + 文案），勾完可连着勾下一项、点列表外即收起。
 * 两处共用同一套类名与结构（.pc-frkinds[data-grp] / .pc-frkbtn / .pc-frkpop / .pc-frkin），
 * 本 module 的委托只认这套类名、靠 data-grp 分流，所以新增一个多选组不用动浮层那套管子。
 * 浮层用 Popover API（`popover` 属性）挂上去——面板/卡片/内容区都有 overflow 裁切，面板自身还带 backdrop-filter
 * （会给 fixed 子元素建 containing block），只有 top layer 能同时躲过这两层裁切；老 Chrome 不支持时自动退回
 * 流内撑开成一行（见本 module mount 的降级分支与 panel-css 的 .pc-frkinds.pc-open 撑开规则）。
 * 预设编队在整表内互斥：其它行已选用的值渲染成 disabled（本行自身仍可选），与 feat 侧 normalizeRules 的
 * 全局唯一口径对齐。雷神没有 6 级田，故**本行勾选的家族全都开不出遗迹**（只剩雷神）时遗迹选项置 disabled。
 * 行存在即生效；preset 改动与行增删整块重绘（disabled 要随之联动），family/kind 勾选只就地刷摘要
 *（两者都不影响其它行，重绘反而会把展开中的浮层关掉）。
 * @param {Array<{preset:number,families?:number[],kinds?:string[]}>} list 当前队伍规则表
 * @param {object} fd 字段描述符（label / familyOptions / presetOptions / hint）
 * @returns {string}
 */
function farmRulesInnerHTML(list, fd) {
  const optsHTML = (opts, sel, disabled) =>
    (opts || [])
      .map((o) => {
        const v = Number(o.value);
        const dis = disabled && disabled.has(v) && v !== sel ? ' disabled' : '';
        return `<option value="${o.value}"${v === sel ? ' selected' : ''}${dis}>${escAttr(String(o.label))}</option>`;
      })
      .join('');
  /**
   * 一个多选下拉控件（资源类型 / 资源种类共用）。
   * @param {string} grp 组名（family | kind）：进容器 data-grp 与选项的 data-part，委托靠它分流
   * @param {string} btnTitle 按钮 title（说明这组是什么、全不勾的含义）
   * @param {Array<{value:string|number,long:string,title?:string,dis?:boolean}>} defs 选项定义
   * @param {Array<string|number>} picked 该行已选值（数字/字符串混用，比较统一走 String）
   * @param {string} sum 按钮上的已选摘要
   * @returns {string}
   */
  const optCell = (grp, btnTitle, defs, picked, sum) => {
    const has = (v) => picked.map(String).indexOf(String(v)) >= 0;
    const optRows = defs
      .map((d) => {
        // 已选中的不因置灰条件被锁死（勾不动 = 取消不了），避免数据与控件打架
        const dis = !!d.dis && !has(d.value);
        return (
          `<label class="pc-frkopt${dis ? ' pc-frkoptdis' : ''}" title="${escAttr(d.title || '')}">` +
          `<input type="checkbox" class="pc-frkin" data-part="${grp}" value="${d.value}"${has(d.value) ? ' checked' : ''}${dis ? ' disabled' : ''}>` +
          `<span>${escAttr(d.long)}</span></label>`
        );
      })
      .join('');
    return (
      `<span class="pc-frkinds" data-grp="${grp}">` +
      `<button class="pc-frkbtn" type="button" title="${escAttr(btnTitle)}">` +
      `<span class="pc-frksum">${escAttr(sum)}</span>` +
      `<span class="pc-frkcaret" aria-hidden="true">▾</span></button>` +
      `<span class="pc-frkpop" popover="manual">${optRows}</span></span>`
    );
  };
  const rowsArr = Array.isArray(list) ? list : [];
  const usedPresets = new Set(rowsArr.map((r) => Number(r && r.preset) || 1));
  const famDefs = (fd.familyOptions || []).map((o) => ({
    value: Number(o.value),
    long: String(o.label),
    title: '资源类型：这支队愿意去采的家族（多选，同分时按 雷神 > 石油 = 粮食 > 金矿 挑）',
  }));
  const rows = rowsArr
    .map((r, i) => {
      const preset = Number(r && r.preset) || 1;
      const families = (Array.isArray(r && r.families) ? r.families : [])
        .map((f) => Number(f) || 0)
        .filter((f) => f > 0);
      const kinds = Array.isArray(r && r.kinds) ? r.kinds : [];
      // 雷神没有 6 级田（遗迹邮件只开得出金/粮/油）：只剩雷神时遗迹不可下，与 normalizeRules 同口径
      const relicDis = families.length > 0 && families.every((f) => f === 16);
      const kindDefs = FARM_KIND_DEFS.map((k) => ({
        value: k.value,
        long: k.long,
        title: k.title,
        dis: k.value === 'relic' && relicDis,
      }));
      return (
        `<div class="pc-frrow" data-idx="${i}">` +
        `<div class="pc-frmain">` +
        `<div class="pc-frbox">` +
        `<select class="pc-frsel" data-part="preset" title="预设编队（1~8 战斗 / 9~16 采集；整表内不可重复）">${optsHTML(
          fd.presetOptions,
          preset,
          usedPresets,
        )}</select>` +
        `<span class="pc-frdiv" aria-hidden="true"></span>` +
        optCell(
          'family',
          '资源类型（多选；全不勾 = 该队不下田）',
          famDefs,
          families,
          farmFamilySummary(families, fd.familyOptions),
        ) +
        `<span class="pc-frdiv" aria-hidden="true"></span>` +
        optCell(
          'kind',
          '资源种类（多选；全不勾 = 该队不下田）',
          kindDefs,
          kinds,
          farmKindSummary(kinds),
        ) +
        `</div>` +
        `<button class="pc-frdel" type="button" title="删除这支队伍" aria-label="删除这支队伍">×</button>` +
        `</div></div>`
      );
    })
    .join('');
  return (
    `<div class="pc-fruletop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '下田规则')}</span>` +
    `<button class="pc-fradd" type="button" title="添加一支队伍" aria-label="添加一支队伍">＋</button>` +
    `</div>` +
    (rows ||
      '<div class="pc-rnghint">未添加队伍 = 不下田；点＋添加的行即生效，同时会暂停总开关，配好后手动重新打开</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/** 取本字段配置数组（镜像旧 boxTarget：非数组就地置 []，引用隔离已由 registry.assignDefaults 单点处理） */
function listOf(ctx) {
  const c = ctx.c;
  const k = ctx.fd.key;
  if (!Array.isArray(c[k])) c[k] = [];
  return c[k];
}

/** 行下标：只取自行上的 data-idx（镜像旧 idxOf；标题行无此属性，避免按行类名数下标整体偏一位） */
function rowIdx(el) {
  const r = el && el.closest ? el.closest('.pc-frrow[data-idx]') : null;
  return r ? +r.dataset.idx : -1;
}

/** 取数组 + 反查行下标，返回 {list, idx}；越界返回 null */
function resolveRow(ctx, el) {
  const list = listOf(ctx);
  const idx = rowIdx(el);
  if (idx < 0 || idx >= list.length) return null;
  return { list, idx };
}

/**
 * 行内两个多选组（family 资源类型 / kind 资源种类）的就地刷新：摘要文案 + 各项勾选态 + 遗迹置灰联动。
 * 不整块重绘，否则展开中的浮层会被自己关掉（连着勾第二项就断）；两个组都不影响别行的 preset
 * disabled 联动（那是 preset 之间的事），所以都不需要跟着重绘。迁自 wire.js syncRowGroupsUi。
 * @param {Element} rowEl .pc-frrow
 * @param {{families?:number[], kinds?:string[]}} row 该行当前值
 * @param {object} fd 字段描述符（家族摘要要用它的下拉数据源）
 */
function syncRowGroupsUi(rowEl, row, fd) {
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
}

/** 下田规则类型（box 容器；数据事件走 dispatcher，浮层面板级生命周期走 mount。interface 形状见 index.js 头注释） */
export const farmrulesType = {
  type: 'farmrules',
  kind: 'box',
  cls: 'pc-frule',
  render: farmRulesInnerHTML,
  events: [
    // 多选组（资源类型 family / 资源种类 kind）勾选：按 data-part 分流进本行 families / kinds，
    // 然后**只就地刷控件**（摘要/勾选态/遗迹置灰），不整块重绘：重绘会把展开的选项列表关掉，勾第二个就断。
    {
      on: 'change',
      sel: '.pc-frkin',
      run(e, ctx) {
        const el = e.target;
        const r = resolveRow(ctx, el);
        if (!r) return;
        const row = r.list[r.idx];
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
        syncRowGroupsUi(el.closest('.pc-frrow'), row, ctx.fd);
        ctx.commit();
      },
    },
    // 预设编队单选：改动要整块重绘同步其它行的 disabled（重绘会把展开中的多选列表收起）
    {
      on: 'change',
      sel: '.pc-frsel',
      run(e, ctx) {
        const el = e.target;
        const r = resolveRow(ctx, el);
        if (!r) return;
        r.list[r.idx][el.dataset.part] = parseInt(el.value, 10) || 0;
        ctx.refresh();
        ctx.commit();
      },
    },
    // 增删行：行存在即生效。新行默认第一支空闲预设 + 金矿 + 机械/普通田。
    // 添加行会把「自动下田」总开关关闭（新行未配好即生效会派错兵），配好后由用户手动重新打开。
    {
      on: 'click',
      sel: '.pc-frdel,.pc-fradd',
      run(e, ctx) {
        const el = e.target;
        const del = el.closest ? el.closest('.pc-frdel') : null;
        const add = el.closest ? el.closest('.pc-fradd') : null;
        if (!del && !add) return;
        const list = listOf(ctx);
        if (del) {
          const idx = rowIdx(del);
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        } else {
          const used = new Set(list.map((r) => Number(r && r.preset) || 1));
          let free = 1;
          while (free <= 16 && used.has(free)) free++;
          list.push({ preset: free, families: [7], kinds: ['tower', 'normal'] });
          // 加行即暂停总开关：清 enabled/intentEnabled，回写卡片勾选与组级联（新行未配好即生效会派错兵）。
          // 不取 panel 根：enable checkbox 与本容器同属一个 .pc-sec，ctx.box.closest('.pc-sec') 自取（合 ctx 契约）。
          const c = ctx.c;
          c.enabled = false;
          c.intentEnabled = false;
          const sec = ctx.box.closest ? ctx.box.closest('.pc-sec') : null;
          const enCb = sec ? sec.querySelector('.pc-en[data-id="' + ctx.fid + '"]') : null;
          if (enCb) enCb.checked = false;
          if (sec) ctx.syncChecks(sec);
        }
        ctx.refresh();
        ctx.commit();
      },
    },
  ],
  /**
   * 面板级生命周期装配（一次性）：资源种类/类型多选的展开/收起浮层子系统。
   * 主路径用 Popover API（top layer）：面板/卡片/内容区的 overflow 裁切与面板的 backdrop-filter
   * （会给 fixed 子元素建 containing block）都困不住它，选项列表能像原生下拉那样浮在行下方、不撑高卡片；
   * light dismiss（点浮层外/Esc）由浏览器代劳，这里只补两件浏览器不管的：定位 + 箭头态类名同步。
   * 老 Chrome（<114）无 popover 属性 → 降级为流内撑开独占一行（样式在 panel-css 的 .pc-frkinds.pc-open 分支）。
   * 这些都要 panel 根 + scroll 捕获 + 全面板扫描，非单容器 dispatcher 所能表达，故收进 mount（不碰数据提交）。
   * @param {Element} panel 面板根
   * @param {object} log 日志器（createLog 实例，降级时打 debug）
   */
  mount(panel, log) {
    const kindPopSupported = (() => {
      const probe = document.createElement('div');
      return typeof probe.showPopover === 'function' && typeof probe.hidePopover === 'function';
    })();
    if (kindPopSupported)
      panel.classList.add('pc-kindpop'); // 把浮层样式打开（否则默认规则把 .pc-frkpop 当流内展开用）
    else log.debug('popover API unavailable, kind multiselect falls back to in-flow expand.');
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
    // 只把“浏览器已经自己关掉”的浮层类名补齐（箭头不能一直翻着）；
    // 本拍刚 hide 又立刻 reopen 的（getPopover 仍为 shown）不动，否则会误关刚展开的列表。
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
            log.debug(
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
  },
};
