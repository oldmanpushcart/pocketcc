/**
 * 打野预设池字段类型 module（type:'presetpool'，自动打野）。
 *
 * T3（架构审查候选 1）：render 迁自 fields.js presetPoolInnerHTML，events 迁自 wire.js presetpool 委托。
 * 动态增删单选行，每个预设只能进一次（跨行去重）；值落 number[]（有序、去重）。
 * 改选/增删都整块重刷以重算其它行可选项；改选撞已占用值时回弹（只 refresh 不提交，防陈旧 DOM）。
 *
 * 依赖面 = dom.js（escAttr）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr } from '../dom.js';

/**
 * 内层 HTML：动态增删的单选行，每行选一个战斗预设（1..max），其它行已占用的值剔除。
 * @param {number[]} list 当前预设池（有序 number[]）
 * @param {object} fd 字段描述符（label / hint / max 预设号上限，缺省 8）
 * @returns {string}
 */
function presetPoolInnerHTML(list, fd) {
  const max = Math.max(1, Math.floor(Number(fd.max) || 8));
  const arr = (Array.isArray(list) ? list : []).map((v) => Number(v) | 0);
  // 除本行外其它行占用的预设值集合（本行当前值不剔除，否则选中态无法回显）
  const usedElsewhere = (idx) => {
    const s = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (i !== idx && arr[i] > 0) s.add(arr[i]);
    }
    return s;
  };
  const rows = arr
    .map((v, i) => {
      const taken = usedElsewhere(i);
      let opts = '';
      for (let n = 1; n <= max; n++) {
        if (taken.has(n) && n !== v) continue; // 被别的行占用且非本行当前值 → 剔除
        opts += `<option value="${n}"${n === v ? ' selected' : ''}>战斗预设 ${n}</option>`;
      }
      if (!opts) opts = `<option value="${v}" selected>战斗预设 ${v}</option>`; // 全占用的兜底（不该发生）
      return (
        `<div class="pc-pprow" data-idx="${i}">` +
        `<span class="pc-ppslot" title="出兵顺序">#${i + 1}</span>` +
        `<select class="pc-ppsel" title="该位的战斗预设">${opts}</select>` +
        `<button class="pc-ppdel" type="button" title="移出预设池" aria-label="移出预设池">×</button>` +
        `</div>`
      );
    })
    .join('');
  const canAdd = arr.length < max;
  return (
    `<div class="pc-pptop">` +
    `<span class="pc-rngtitle">${escAttr(fd.label || '打野预设池')}</span>` +
    `<button class="pc-ppadd" type="button" title="添加一个预设位" aria-label="添加一个预设位"${canAdd ? '' : ' disabled'}>＋</button>` +
    `</div>` +
    (rows || '<div class="pc-rnghint">未添加预设 = 不出兵；点＋添加，×移除</div>') +
    (fd.hint ? `<div class="pc-rnghint">${escAttr(fd.hint)}</div>` : '')
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
  const r = el && el.closest ? el.closest('.pc-pprow[data-idx]') : null;
  return r ? +r.dataset.idx : -1;
}

/** 打野预设池类型（box 容器，change 改选 + click 增删；interface 形状见 index.js 头注释） */
export const presetpoolType = {
  type: 'presetpool',
  kind: 'box',
  cls: 'pc-pp',
  render: presetPoolInnerHTML,
  events: [
    // 改选：跨行去重，撞已占用值回弹（只 refresh 不提交，防陈旧 DOM）；正常写回后整块重刷
    {
      on: 'change',
      sel: '.pc-ppsel',
      run(e, ctx) {
        const el = e.target;
        const list = listOf(ctx);
        const idx = rowIdx(el);
        if (idx < 0 || idx >= list.length) return;
        const v = parseInt(el.value, 10) || 0;
        if (list.indexOf(v) >= 0 && list[idx] !== v) {
          ctx.refresh(); // 该值已被别行占用：忽略不入库，重刷回正
          return;
        }
        list[idx] = v;
        ctx.refresh();
        ctx.commit();
      },
    },
    // 增删行：加行取第一个空闲预设号（达 max 上限则忽略，＋已 disabled 兜底）
    {
      on: 'click',
      sel: '.pc-ppdel,.pc-ppadd',
      run(e, ctx) {
        const el = e.target;
        const del = el.closest ? el.closest('.pc-ppdel') : null;
        const add = el.closest ? el.closest('.pc-ppadd') : null;
        if (!del && !add) return;
        const list = listOf(ctx);
        const max = Math.max(1, Math.floor(Number(ctx.fd.max) || 8));
        if (del) {
          const idx = rowIdx(del);
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        } else {
          if (list.length >= max) return; // ＋已 disabled，兜底
          let free = 0;
          for (let n = 1; n <= max; n++) {
            if (list.indexOf(n) < 0) {
              free = n;
              break;
            }
          }
          if (free) list.push(free);
        }
        ctx.refresh();
        ctx.commit();
      },
    },
  ],
};
