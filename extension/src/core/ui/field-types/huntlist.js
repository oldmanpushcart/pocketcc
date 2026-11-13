/**
 * 怪物清单字段类型 module（type:'huntlist'，自动打野）。
 *
 * T2（架构审查候选 1）：render 迁自 fields.js 的 huntListInnerHTML，events 迁自 wire.js 的 huntlist change 委托。
 * 行集由 fd.catalog 驱动（可为运行时反查游戏表的 getter）；catalog 对齐与 key 反查收进本 module 内部 helper，
 * 不再依赖 wire.js boxTarget 的 align 钩子。dispatch 键 = fd.type，故旧 `.pc-hl:not(.pc-ct)` 类名撞车 hack 自然退役
 * （表格型 ctrlrow 容器同类名 pc-hl，但 fd.type='ctrlrow' 不会命中本 module）。
 *
 * 依赖面 = dom.js（escAttr / PLACEHOLDER_UNLIMITED）+ ctx；不反查 fields.js/wire.js。
 * 「已打」只读格（.pc-hlstat[data-hlstat] ← fd.todayText(key)）经本 module refreshText 钩子就地改文本
 *   （T5：panel.refreshTexts 的 data-hlstat 硬编分支退役，收编进 module，与 itemlist istock/ibought 同口径）。
 */
import { escAttr, PLACEHOLDER_UNLIMITED } from '../dom.js';

/**
 * 内层 HTML：每种怪一行（行集由 fd.catalog 给出），逐行可编辑。
 * 列：怪物类型 | 方式（select）| 攻打数量（0=不限）| 已打（只读，fd.todayText(key)）| ☑ 参与。
 * 行序恒等于本次渲染的 fd.catalog 下标，行身份同时钉在 data-hkey 上（目录刷新重排后委托靠 key 回写）。
 * 签名照渲染表 (val, fd, c, fid)，用 val/fd/fid（c 不用）。
 * @param {Array<object>} list 当前清单（configs[fid][fd.key]，按 key 匹配）
 * @param {object} fd 字段描述符（label / hint / todayText / catalog）
 * @param {string} fid 功能 id（「已打」只读格挂 data-fid 供 refreshTexts 回查）
 * @returns {string}
 */
function huntListInnerHTML(list, fd, fid) {
  const catalog = fd.catalog || [];
  const stored = Array.isArray(list) ? list : [];
  const byKey = {};
  for (const r of stored) if (r && r.key) byKey[r.key] = r;
  const today = typeof fd.todayText === 'function' ? fd.todayText : () => '';
  const optsHTML = (modes, sel) =>
    (modes || [])
      .map(
        (o) =>
          `<option value="${escAttr(String(o.value))}"${String(o.value) === String(sel) ? ' selected' : ''}>${escAttr(String(o.label))}</option>`,
      )
      .join('');
  const head =
    `<div class="pc-hlrow pc-hlhead">` +
    `<span class="pc-hlname">怪物类型</span>` +
    `<span class="pc-hlmode">方式</span>` +
    `<span class="pc-hlcnt">数量</span>` +
    `<span class="pc-hldone">已打</span></div>`;
  const rows = catalog
    .map((mo, i) => {
      const r = byKey[mo.key] || {};
      const count0 = Number.isFinite(r.count) ? r.count | 0 : mo.defaultCount | 0;
      const countCap = Number.isFinite(mo.maxCount) && mo.maxCount > 0 ? mo.maxCount | 0 : 0;
      const count = countCap > 0 && count0 > countCap ? countCap : count0;
      const mode = r.mode != null ? r.mode : mo.defaultMode;
      const on = r.on === undefined ? !!mo.defaultOn : !!r.on;
      const title = mo.openItem
        ? `用求救信(${mo.openItem})开营 · 无每日上限`
        : `groupType ${mo.groupType} / pointType ${mo.pointType} / 搜索等级 ${mo.levelMode === 'dynamic' ? `动态反查(回退${mo.level})` : mo.level}`;
      return (
        `<div class="pc-hlrow" data-idx="${i}" data-hkey="${escAttr(String(mo.key))}">` +
        `<span class="pc-hlname" title="${escAttr(title)}"><span class="pc-hllabel">${escAttr(String(mo.label))}</span></span>` +
        `<select class="pc-hlmode pc-hlsel" data-part="mode" title="攻打方式">${optsHTML(mo.modes, mode)}</select>` +
        `<input type="number" class="pc-hlcnt pc-hln" data-part="count" min="0"${countCap > 0 ? ` max="${countCap}"` : ''} step="1" value="${count > 0 ? count : ''}" placeholder="${PLACEHOLDER_UNLIMITED}" title="攻打数量；留空 = 不限${countCap > 0 ? `（上限 ${countCap}）` : ''}">` +
        `<span class="pc-fval pc-hlstat" data-fid="${fid}" data-fkey="${fd.key}" data-hlstat="${escAttr(String(mo.key))}" title="今日已打数量">${escAttr(String(today(mo.key) || ''))}</span>` +
        `<input type="checkbox" class="pc-hlon pc-hlchk" data-part="on"${on ? ' checked' : ''} title="勾选=纳入猎杀范围">` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-hltop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '怪物清单')}</span>` +
    `</div>` +
    head +
    (rows || '<div class="pc-rnghint">清单为空</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
  );
}

/**
 * 按 catalog 全量对齐存档数组：逐 key 保留已存值、补齐缺失行、剔除目录已删行，令「下标==catalog 下标==该行 key」。
 * 迁自 wire.js hlTarget 的 align 钩子。存档可能早于目录新增行或顺序错位，直接按下标写会勾到别的怪行、新 key 行永不落盘。
 * @param {object} ctx 字段上下文
 */
function alignCatalog(ctx) {
  const fd = ctx.fd;
  const c = ctx.c;
  if (!Array.isArray(fd.catalog)) return; // 无目录不对齐（本 module 仅 huntlist 命中，正常情况下恒有 catalog）
  const prev = Array.isArray(c[fd.key]) ? c[fd.key] : [];
  const stored = {};
  for (const r of prev) if (r && r.key) stored[r.key] = r;
  c[fd.key] = fd.catalog.map((mo) => {
    const old = stored[mo.key];
    return old
      ? { ...old }
      : { key: mo.key, count: mo.defaultCount | 0, mode: mo.defaultMode, on: !!mo.defaultOn };
  });
}

/**
 * 行下标：优先用该行 data-hkey 到（已对齐的）存档数组反查；目录刷新重排后「下标==DOM 行序」不再成立，
 * key 反查对静态/动态目录都等价（旧行无 hkey 仍按 data-idx 回落，行为不变）。迁自 wire.js hlIdx。
 * @param {Element} el 事件目标
 * @param {Array<object>} list 已对齐的存档数组
 * @returns {number} 行下标，未命中 -1
 */
function rowIdx(el, list) {
  const row = el && el.closest ? el.closest('.pc-hlrow') : null;
  const hk = row && row.dataset ? row.dataset.hkey : '';
  if (hk) {
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].key === hk) return i;
  }
  const r = el && el.closest ? el.closest('.pc-hlrow[data-idx]') : null;
  return r ? +r.dataset.idx : -1;
}

/** 对齐 catalog + 反查行下标，返回 {list, idx}；越界/无目录返回 null */
function resolveRow(ctx, el) {
  alignCatalog(ctx);
  const list = ctx.c[ctx.fd.key];
  if (!Array.isArray(list)) return null;
  const idx = rowIdx(el, list);
  if (idx < 0 || idx >= list.length) return null;
  return { list, idx };
}

/**
 * 「已打」只读格就地改文本（panel.refreshTexts 的 .pc-fval 通路）：值按行 key 从 fd.todayText 取（无则不刷）。
 * 值随数据变、行结构不变，绝不整块重刷（勾选/方式/数量监听绑在行节点上）。
 * @param {Element} el .pc-fval.pc-hlstat 只读格（带 data-hlstat 行 key）
 * @param {object} ctx 字段上下文（fd = huntlist 顶层描述符）
 */
function refreshHuntText(el, ctx) {
  const key = el.dataset.hlstat;
  if (key == null || typeof ctx.fd.todayText !== 'function') return;
  const next = String(ctx.fd.todayText(key) || '');
  if (el.textContent !== next) el.textContent = next;
}

/** 怪物清单类型（box 容器，三路声明式 change 事件 + 只读格 refreshText；interface 形状见 index.js 头注释） */
export const huntlistType = {
  type: 'huntlist',
  kind: 'box',
  cls: 'pc-hl',
  render: (val, fd, c, fid) => huntListInnerHTML(val, fd, fid),
  refreshText: refreshHuntText,
  events: [
    // 参与开关：勾选=纳入猎杀范围（bool 就地写回，不重刷）
    {
      on: 'change',
      sel: '.pc-hlchk',
      run(e, ctx) {
        const r = resolveRow(ctx, e.target);
        if (!r) return;
        r.list[r.idx][e.target.dataset.part] = !!e.target.checked;
        ctx.commit();
      },
    },
    // 攻打方式：字符串键就地写回
    {
      on: 'change',
      sel: '.pc-hlsel',
      run(e, ctx) {
        const r = resolveRow(ctx, e.target);
        if (!r) return;
        r.list[r.idx][e.target.dataset.part] = e.target.value;
        ctx.commit();
      },
    },
    // 攻打数量：负归 0 + 该行硬上限钳位（0 仍表不限）+ count 0 留空回写（placeholder「不限」）
    {
      on: 'change',
      sel: '.pc-hln',
      run(e, ctx) {
        const el = e.target;
        const r = resolveRow(ctx, el);
        if (!r) return;
        const part = el.dataset.part;
        let v = parseInt(el.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        if (part === 'count') {
          const cat = ctx.fd.catalog && ctx.fd.catalog[r.idx];
          const cap =
            cat && Number.isFinite(cat.maxCount) && cat.maxCount > 0 ? cat.maxCount | 0 : 0;
          if (cap > 0 && v > cap) v = cap;
        }
        el.value = part === 'count' && v === 0 ? '' : v;
        r.list[r.idx][part] = v;
        ctx.commit();
      },
    },
  ],
};
