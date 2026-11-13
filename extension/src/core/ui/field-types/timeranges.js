/**
 * 下田时段字段类型 module（type:'timeranges'，自动下田）。
 *
 * T3（架构审查候选 1）：render 迁自 fields.js timeRangesInnerHTML，events 迁自 wire.js timeranges 委托。
 * 每行两个原生 <input type=time>（起始~结束），值落 [{start:'HH:MM', end:'HH:MM'}]（字符串，可跨午夜）。
 * input 只 mutate（防未 blur 编辑被增删整块重绘吞掉，同 ranges 踩过的坑）；change 写回+提交；增删行 refresh+提交。
 *
 * 依赖面 = dom.js（escAttr）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 内层 HTML：标题行（含右上＋）+ 若干 `[ 起始 ~ 结束 × ]` 行。
 * @param {Array<{start:string,end:string}>} list 当前时段表
 * @param {object} fd 字段描述符（label / hint 可选）
 * @returns {string}
 */
function timeRangesInnerHTML(list, fd) {
  const rows = (Array.isArray(list) ? list : [])
    .map((r, i) => {
      const s = String((r && r.start) || '');
      const e = String((r && r.end) || '');
      return (
        `<div class="pc-trow" data-idx="${i}">` +
        `<input type="time" class="pc-tinp" data-part="start" value="${escAttr(s)}" title="下田时段开始时刻">` +
        `<span class="pc-tdash">~</span>` +
        `<input type="time" class="pc-tinp" data-part="end" value="${escAttr(e)}" title="下田时段结束时刻（开始>结束=跨午夜）">` +
        `<button class="pc-tdel" type="button" title="删除此时段" aria-label="删除此时段">×</button>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="pc-trtop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '下田时段')}</span>` +
    `<button class="pc-tradd" type="button" title="添加一个时段" aria-label="添加一个时段">＋</button>` +
    `</div>` +
    (rows || '<div class="pc-rnghint">无时段，点右上＋添加</div>') +
    `<div class="pc-rnghint">${escAttr(fd.hint || '仅在所列时段内下田，时段外立即撤田；开始>结束视为跨午夜')}</div>`
  );
}

/** 取本字段配置数组（镜像旧 boxTarget：非数组就地置 []） */
function listOf(ctx) {
  const c = ctx.c;
  const k = ctx.fd.key;
  if (!Array.isArray(c[k])) c[k] = [];
  return c[k];
}

/** 行下标：只取自行上的 data-idx（镜像旧 idxOf） */
function rowIdx(el) {
  const r = el && el.closest ? el.closest('.pc-trow[data-idx]') : null;
  return r ? +r.dataset.idx : -1;
}

/** 取数组 + 反查行下标，返回 {list, idx}；越界返回 null */
function resolveRow(ctx, el) {
  const list = listOf(ctx);
  const idx = rowIdx(el);
  if (idx < 0 || idx >= list.length) return null;
  return { list, idx };
}

/** 下田时段类型（box 容器，input/change/click 三路声明式事件；interface 形状见 index.js 头注释） */
export const timerangesType = {
  type: 'timeranges',
  kind: 'box',
  cls: 'pc-trule',
  render: timeRangesInnerHTML,
  events: [
    // 敲字实时同步进内存（不落盘不重刷）：防止未 blur 的编辑被增删行的整块重绘吞掉
    {
      on: 'input',
      sel: '.pc-tinp',
      run(e, ctx) {
        const el = e.target;
        const r = resolveRow(ctx, el);
        if (!r) return;
        r.list[r.idx][el.dataset.part === 'end' ? 'end' : 'start'] = el.value;
      },
    },
    // 选定完整时刻：写回 + 落盘 + 热更（时段增删会即时影响下田/撤田判定）
    {
      on: 'change',
      sel: '.pc-tinp',
      run(e, ctx) {
        const el = e.target;
        const r = resolveRow(ctx, el);
        if (!r) return;
        r.list[r.idx][el.dataset.part === 'end' ? 'end' : 'start'] = el.value;
        ctx.commit();
      },
    },
    // 增删行：行存在即生效。新行默认 09:00~18:00（合法时段，不必暂停总开关）
    {
      on: 'click',
      sel: '.pc-tdel,.pc-tradd',
      run(e, ctx) {
        const el = e.target;
        const del = el.closest ? el.closest('.pc-tdel') : null;
        const add = el.closest ? el.closest('.pc-tradd') : null;
        if (!del && !add) return;
        const list = listOf(ctx);
        if (del) {
          const idx = rowIdx(del);
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        } else {
          list.push({ start: '09:00', end: '18:00' });
        }
        ctx.refresh();
        ctx.commit();
      },
    },
  ],
};
