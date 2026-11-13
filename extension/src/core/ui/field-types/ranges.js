/**
 * 区间规则字段类型 module（type:'ranges'，联盟机甲代捐档位等）。
 *
 * T1 pilot（架构审查候选 1）：render 迁自 fields.js 的 rangesInnerHTML，events 迁自 wire.js 的
 * ranges 三路面板级委托。迁完即删旧分支（strangler 纪律），渲染/交互行为逐字节不变。
 *
 * 依赖面 = ctx（dispatcher 传入）；不反查 fields.js/wire.js，无 import（render 不转义、events 纯逻辑）。
 * 外壳（data-id/data-fkey + .pc-rng 视觉类）由 fields.js 的 fieldBox 统一打，本 module 只产内层 HTML。
 */

/**
 * 内层 HTML：列头 + 若干 `[ from ~ to ) → count ×` 行 + 标题行右侧的「＋」。
 * 列头与数据行共用 rngRow 模板（括号类格子在列头只隐藏），否则三列无法逐列对齐；行号挂在 .pc-rngrow[data-idx]，
 * 委托时靠它定位，不能用 querySelectorAll('.pc-rngrow') 的下标（会把列头行算进去，整体偏一位）。
 * 签名照渲染表 (val, fd, c, fid)，只用前两参。
 * @param {Array<{from:number,to:number,count:number}>} list 当前规则表
 * @param {object} fd 字段描述符（label / cols / hint 可选）
 * @returns {string}
 */
function rangesInnerHTML(list, fd) {
  const cols = fd.cols || ['大于等于', '小于', '数值'];
  const rngRow = (cells, rowIdx) =>
    `<div class="pc-rngrow${rowIdx === undefined ? ' pc-rnghead' : ''}"` +
    (rowIdx === undefined ? '' : ` data-idx="${rowIdx}"`) +
    `>` +
    `<span class="pc-rngop">[</span>${cells[0]}` +
    `<span class="pc-rngop">~</span>${cells[1]}` +
    `<span class="pc-rngop">)</span><span class="pc-rngop">→</span>${cells[2]}` +
    `${cells[3]}</div>`;
  const rows = (Array.isArray(list) ? list : [])
    .map((r, i) =>
      rngRow(
        [
          `<input type="number" class="pc-rngn" data-part="from" min="0" step="1" value="${r.from | 0}" title="区间下界（含）">`,
          `<input type="number" class="pc-rngn" data-part="to" min="0" step="1" value="${r.to | 0}" title="区间上界（不含）；填 0 = 不封顶">`,
          `<input type="number" class="pc-rngn" data-part="count" min="0" step="1" value="${r.count | 0}" title="命中该区间的数值；填 0 = 该段不生效">`,
          `<button class="pc-rngdel" type="button" title="删除此档" aria-label="删除此档">×</button>`,
        ],
        i,
      ),
    )
    .join('');
  return (
    `<div class="pc-rngtop">` +
    `<span class="pc-rngtitle">${fd.label || '区间规则'}</span>` +
    `<button class="pc-rngadd" type="button" title="增加一档" aria-label="增加一档">＋</button>` +
    `</div>` +
    rngRow([
      `<span class="pc-rnglbl">${cols[0]}</span>`,
      `<span class="pc-rnglbl">${cols[1]}</span>`,
      `<span class="pc-rnglbl">${cols[2]}</span>`,
      `<span class="pc-rngdelcol"></span>`,
    ]) +
    (rows || '<div class="pc-rnghint">无档位，点右上＋添加</div>') +
    `<div class="pc-rnghint">${fd.hint || '先命中先生效；0 = 不封顶 / 不生效'}</div>`
  );
}

/** 取配置数组（镜像旧 boxTarget 的数组初始化；与 defaults 的引用隔离已由 registry.assignDefaults 单点保证） */
function listOf(ctx) {
  const c = ctx.c;
  const k = ctx.fd.key;
  if (!Array.isArray(c[k])) c[k] = [];
  return c[k];
}

/** 行下标：只取自行上的 data-idx（列头行无此属性，避免按行类名数下标把列头算进去偏一位） */
function rowIdx(el) {
  const row = el && el.closest ? el.closest('.pc-rngrow[data-idx]') : null;
  return row ? +row.dataset.idx : -1;
}

/** 区间规则类型（box 容器，三路声明式事件；interface 形状见 index.js 头注释） */
export const rangesType = {
  type: 'ranges',
  kind: 'box',
  cls: 'pc-rng',
  render: rangesInnerHTML,
  events: [
    // 敲一个字就同步进内存（不落盘、不重刷 DOM）：否则未 blur 的编辑会被增删行的整块重刷吞掉，看着像“清空已填”
    {
      on: 'input',
      sel: '.pc-rngn',
      run(e, ctx) {
        const inp = e.target;
        const list = listOf(ctx);
        const idx = rowIdx(inp);
        if (idx < 0 || idx >= list.length) return;
        const v = parseInt(inp.value, 10);
        if (!isNaN(v) && v >= 0) list[idx][inp.dataset.part] = v;
      },
    },
    // 失焦：钳制后回写输入框并落盘生效
    {
      on: 'change',
      sel: '.pc-rngn',
      run(e, ctx) {
        const inp = e.target;
        const list = listOf(ctx);
        const idx = rowIdx(inp);
        if (idx < 0 || idx >= list.length) return;
        let v = parseInt(inp.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        list[idx][inp.dataset.part] = v;
        inp.value = v;
        ctx.commit();
      },
    },
    // 增删行：改数组后只重刷该字段内层
    {
      on: 'click',
      sel: '.pc-rngdel,.pc-rngadd',
      run(e, ctx) {
        const el = e.target;
        const del = el.closest('.pc-rngdel');
        const add = el.closest('.pc-rngadd');
        if (!del && !add) return;
        const list = listOf(ctx);
        if (del) {
          const idx = rowIdx(del);
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        } else {
          const last = list[list.length - 1];
          // 新档默认接在上一档上界（首档从 0 起），不封顶且枚数 0 = 先占位不捐，避免误发
          list.push({ from: last ? last.to | 0 : 0, to: 0, count: 0 });
        }
        ctx.refresh();
        ctx.commit();
      },
    },
  ],
};
