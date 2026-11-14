/**
 * 采集规则字段类型 module（type:'minerules'，次元矿洞）。
 *
 * T3（架构审查候选 1）：render 迁自 fields.js mineRulesInnerHTML，events 迁自 wire.js minerules 委托。
 * 每块单行「矿种▾ + 等级▾ + ★点选」，× 删除；各维度 0 = 不限。行存在即生效（无行级开关，停某条只能 × 删除）。
 * 矿种/等级下拉 change 即落盘（不重刷，选中态由原生 select 自持）；★点选/增删行是结构或视觉变化，整块重刷。
 * 加行默认取具体值（矿种=第一个真实矿种、等级=最高、星级=最高）并暂停总开关（新行未配好即生效会误采），
 * 关总开关走 ctx.box.closest('.pc-sec') + ctx.syncChecks（不取 panel 根，同 farmrules 口径）。
 *
 * 依赖面 = dom.js（escAttr）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 内层 HTML：标题行（含右上＋）+ 若干规则块（矿种▾ + 等级▾ + 「星级」标签 + ★点选 + × 删除）。
 * @param {Array<{type:number,level:number,star:number}>} list 当前规则表
 * @param {object} fd 字段描述符（label / options / levelOptions / maxStar / hint）
 * @param {object} cfg 该功能当前配置（透传给 fd.options / levelOptions / maxStar 函数）
 * @returns {string}
 */
function mineRulesInnerHTML(list, fd, cfg) {
  const typeOpts = (typeof fd.options === 'function' ? fd.options(cfg) : fd.options) || [];
  const lvOpts =
    (typeof fd.levelOptions === 'function' ? fd.levelOptions(cfg) : fd.levelOptions) || [];
  const maxStar = (typeof fd.maxStar === 'function' ? fd.maxStar(cfg) : fd.maxStar) || 5;
  const optsHTML = (opts, sel) =>
    opts
      .map(
        (o) =>
          `<option value="${o.value}"${Number(o.value) === sel ? ' selected' : ''}>${escAttr(String(o.label))}</option>`,
      )
      .join('');
  const rows = (Array.isArray(list) ? list : [])
    .map((r, i) => {
      const type = Number(r.type) || 0,
        lv = Number(r.level) || 0,
        star = Number(r.star) || 0;
      let stars = '';
      for (let s = 1; s <= maxStar; s++) {
        const on = s <= star;
        stars += `<button type="button" class="pc-mrstar${on ? ' on' : ''}" data-part="star" data-star="${s}" title="${s} 星；再点当前星=不限" aria-label="${s} 星" aria-pressed="${on}">${on ? '★' : '☆'}</button>`;
      }
      return (
        `<div class="pc-mrrow" data-idx="${i}">` +
        `<div class="pc-mrbox">` +
        `<select class="pc-mrsel pc-mrtype" data-part="type" title="矿种">${optsHTML(typeOpts, type)}</select>` +
        `<select class="pc-mrsel pc-mrlv" data-part="level" title="等级">${optsHTML(lvOpts, lv)}</select>` +
        `<span>星级</span>` +
        `<span class="pc-mrstars" title="星级；再点当前星=不限">${stars}</span>` +
        `</div>` +
        `<button class="pc-mrdel" type="button" title="删除此规则" aria-label="删除此规则">×</button>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-mruletop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '采集规则')}</span>` +
    `<button class="pc-mradd" type="button" title="添加一条规则" aria-label="添加一条规则">＋</button>` +
    `</div>` +
    (rows ||
      '<div class="pc-rnghint">未添加规则 = 不采集；点＋添加的行即生效，同时会暂停总开关，配好后手动重新打开</div>') +
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
  const r = el && el.closest ? el.closest('.pc-mrrow[data-idx]') : null;
  return r ? +r.dataset.idx : -1;
}

/** 取数组 + 反查行下标，返回 {list, idx}；越界返回 null */
function resolveRow(ctx, el) {
  const list = listOf(ctx);
  const idx = rowIdx(el);
  if (idx < 0 || idx >= list.length) return null;
  return { list, idx };
}

/** 采集规则类型（box 容器，change 改维度 + click ★点选/增删；interface 形状见 index.js 头注释） */
export const minerulesType = {
  type: 'minerules',
  kind: 'box',
  cls: 'pc-mrule',
  render: mineRulesInnerHTML,
  events: [
    // 矿种/等级下拉：按 data-part 写入对应维度（0=不限），change 即落盘生效（选中态原生 select 自持，不重刷）
    {
      on: 'change',
      sel: '.pc-mrsel',
      run(e, ctx) {
        const el = e.target;
        const r = resolveRow(ctx, el);
        if (!r) return;
        const part = el.dataset.part === 'level' ? 'level' : 'type';
        r.list[r.idx][part] = parseInt(el.value, 10) || 0;
        ctx.commit();
      },
    },
    // 星级★点选（再点当前星=不限）/ 增删行：结构性或视觉变化后整块重刷
    {
      on: 'click',
      sel: '.pc-mrstar,.pc-mrdel,.pc-mradd',
      run(e, ctx) {
        const el = e.target;
        const star = el.closest ? el.closest('.pc-mrstar') : null;
        const del = el.closest ? el.closest('.pc-mrdel') : null;
        const add = el.closest ? el.closest('.pc-mradd') : null;
        if (!star && !del && !add) return;
        const list = listOf(ctx);
        if (star) {
          const idx = rowIdx(star);
          if (idx < 0 || idx >= list.length) return;
          const s = +star.dataset.star || 0;
          list[idx].star = list[idx].star === s ? 0 : s;
        } else if (del) {
          const idx = rowIdx(del);
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        } else {
          // 行存在即生效（已无行级开关）：新规则默认取具体值而非“不限”（矿种=第一个真实矿种、等级=最高、星级=最高）。
          const fd = ctx.fd;
          const topts = (typeof fd.options === 'function' ? fd.options(ctx.c) : fd.options) || [];
          const first = topts.find((o) => Number(o.value) > 0);
          const lopts =
            (typeof fd.levelOptions === 'function' ? fd.levelOptions(ctx.c) : fd.levelOptions) ||
            [];
          let maxLv = 0;
          for (const o of lopts) {
            const v = Number(o.value) || 0;
            if (v > maxLv) maxLv = v;
          }
          const maxStar = (typeof fd.maxStar === 'function' ? fd.maxStar(ctx.c) : fd.maxStar) || 5;
          list.push({ type: first ? Number(first.value) : 0, level: maxLv, star: maxStar });
          // 加行即暂停总开关：清 enabled/intentEnabled，回写卡片勾选与组级联（新行未配好即生效会误采）。
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
};
