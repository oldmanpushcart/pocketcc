/**
 * 联盟集结目标紧凑表字段类型 module（type:'rallygrid'）。
 *
 * T5（架构审查候选 1 · Option A 全量收编）：render 迁自 fields.js rallyGridInnerHTML，
 * 行内数字（delay/limit）/ 勾选（enableKey）change 迁自 wire.js wireControls 的 number/checkbox 委托，
 * 自学习行×删除迁自 wire.js wireContainerFields 的 .pc-rgdel 面板级委托（三处旧 handler T5 退役）。
 * 渲染产物自带 .pc-rg[data-fkey] 容器（无 fieldBox 外壳，故 kind:'inline'），dispatcher 容器路径直接命中本 module；
 *   handler 经 findFieldDescriptor 下探 rows 的 delay/limit/count 取子描述符（子格 key 才是存档键，≠ 顶层 fd.key）。
 * count 只读格（.pc-rgcount，子描述符无 type）随 refreshTexts 走 fd.get 兜底，故本 module 无需自持 refreshText。
 * 行集由 fd.rows 驱动（可为运行时反查游戏表 + 推送自学习的 getter）：行增删靠 rerenderFeatureCard 整卡重建，
 *   值回写靠 syncControls 通用内联循环（.pc-rgin/.pc-rgchk 带 data-id/data-key），无闭包态 → 无需 assemble/sync 钩子。
 *
 * 依赖面 = dom（escAttr/PLACEHOLDER_UNLIMITED/findFieldDescriptor）+ ctx；不反查 fields.js/wire.js。
 */
import { escAttr, PLACEHOLDER_UNLIMITED, findFieldDescriptor } from '../dom.js';

/**
 * 联盟集结目标紧凑表内层 HTML：一行一目标的多行表 [目标名][延迟入队(秒)输入][每日上限输入][今日已打文本][启用checkbox]。
 * 行集不要求固定长度：fd.rows 可以是 getter（目标目录运行时反查 + 推送自学习，行随赛季增删），
 *   每格控件身份钉在自己的 key（delay.key / limit.key / count.key / enableKey）上，不依赖行下标。
 * 列头与数据行共用同一 5 列 CSS Grid（.pc-rghead/.pc-rgrow 用 display:contents 让子格直挂父栅格），列宽严格对齐。
 * 末列每行固定「checkbox + gap + 删除槽」结构：学习行槽里是×按钮，非学习行渲染同宽隐形占位 .pc-rgdelna——
 *   条件性内容（×）不得改变行内 flex 总宽，否则 checkbox 的 x 随×有无逐行偏移（同异能秘境角标占位教训）。
 * 签名照 module render (val, fd, c, fid)，本类型直接读 cfg（val 仅占位对齐）。
 * @param {*} val 配置里的字段值（占位，不读）
 * @param {object} fd 字段描述符 { key, cols: string[], rows: [{ name, enableKey, delay, limit, count, learned?, itemIds? }] }
 * @param {object} cfg 该功能当前配置
 * @param {string} fid 功能 id
 * @returns {string}
 */
function rallyGridInnerHTML(val, fd, cfg, fid) {
  void val;
  const cols = fd.cols || ['', '延迟入队(秒)', '每日上限', '今日已打', ''];
  const header =
    `<div class="pc-rghead">` +
    cols
      .map(
        (c, i) =>
          `<span class="pc-rgcell pc-rgc-${i}"${c ? '' : ' aria-hidden="true"'}>${c ? escAttr(c) : '&nbsp;'}</span>`,
      )
      .join('') +
    `</div>`;
  const rows = (fd.rows || [])
    .map((r) => {
      const delay = r.delay || {};
      const limit = r.limit || {};
      const count = r.count || {};
      const delayVal = cfg[delay.key];
      const limitVal = cfg[limit.key];
      const limitEmpty = limit.zeroUnlimited && (limitVal == null || Number(limitVal) === 0);
      const countText = count.get ? String(count.get(cfg) || '') : '';
      return (
        `<div class="pc-rgrow">` +
        `<span class="pc-rgcell pc-rgc-0" title="${escAttr(r.name || '')}">${escAttr(r.name || '')}</span>` +
        `<span class="pc-rgcell pc-rgc-1"><input type="number" class="pc-rgin" data-id="${fid}" data-key="${escAttr(delay.key)}" min="${delay.min != null ? delay.min : 0}" step="${delay.step != null ? delay.step : 1}" placeholder="${escAttr(delay.placeholder || '')}" value="${delayVal == null ? '' : delayVal}" title="${escAttr(delay.title || '延迟入队(秒)')}"></span>` +
        `<span class="pc-rgcell pc-rgc-2"><input type="number" class="pc-rgin" data-id="${fid}" data-key="${escAttr(limit.key)}" min="${limit.min != null ? limit.min : 0}" step="${limit.step != null ? limit.step : 1}" placeholder="${escAttr(limit.placeholder || (limit.zeroUnlimited ? PLACEHOLDER_UNLIMITED : ''))}" value="${limitEmpty ? '' : limitVal}" title="${escAttr(limit.title || (limit.zeroUnlimited ? '留空 = 不限' : '每日上限'))}"></span>` +
        `<span class="pc-rgcell pc-rgc-3"><span class="pc-fval pc-rgcount" data-fid="${fid}" data-fkey="${escAttr(count.key)}">${countText}</span></span>` +
        `<span class="pc-rgcell pc-rgc-4"><input type="checkbox" class="pc-fchk pc-rgchk" data-id="${fid}" data-key="${escAttr(r.enableKey)}"${cfg[r.enableKey] ? ' checked' : ''} title="勾选=自动加入${escAttr(r.name || '')}集结">` +
        (r.learned && r.itemIds && r.itemIds.length
          ? `<button class="pc-rgdel" type="button" data-rowkey="${escAttr(r.itemIds.join(','))}" title="删除这个自学习目标（除非它再次被服务器推送，否则不会回来）" aria-label="删除自学习目标「${escAttr(r.name || '')}」">×</button>`
          : `<span class="pc-rgdelna" aria-hidden="true"></span>`) +
        `</span>` +
        `</div>`
      );
    })
    .join('');
  return `<div class="pc-rg" data-id="${fid}" data-fkey="${escAttr(fd.key)}">${header}${rows}</div>`;
}

/** 联盟集结目标表类型（inline 渲染自带容器，数字/勾选/删除三路 events；interface 形状见 index.js 头注释） */
export const rallygridType = {
  type: 'rallygrid',
  kind: 'inline',
  render: rallyGridInnerHTML,
  events: [
    // 延迟/上限数字格：data-key 是行内子格 key，下探 rows 取子描述符（min/step/zeroUnlimited/float 挂在 r.delay/r.limit 上）
    {
      on: 'change',
      sel: '.pc-rgin',
      run(e, ctx) {
        const input = e.target;
        const src = findFieldDescriptor(ctx.f, input.dataset.key);
        if (!src) return;
        const key = src.key;
        let v = src.float ? parseFloat(input.value) : parseInt(input.value, 10);
        if (src.zeroUnlimited && (isNaN(v) || input.value === ''))
          v = 0; // 留空 = 不限（0），与渲染对称
        else if (isNaN(v)) v = ctx.f.defaults[key];
        v = Math.max(src.min != null ? src.min : 0, v);
        input.value = src.zeroUnlimited && v === 0 ? '' : v; // 0 → 留空，placeholder「不限」
        ctx.c[key] = v;
        ctx.commit();
      },
    },
    // 行启用勾选框：点选不触发卡片折叠
    {
      on: 'click',
      sel: '.pc-rgchk',
      run(e) {
        e.stopPropagation();
      },
    },
    // 行启用勾选改动即存档 + 热更（key = enableKey）
    {
      on: 'change',
      sel: '.pc-rgchk',
      run(e, ctx) {
        ctx.c[e.target.dataset.key] = e.target.checked;
        ctx.commit();
      },
    },
    // 自学习行×删除：行由 feat 目录驱动，删除回 feat 侧动私有持久态（经描述符 onDeleteRow 回调，不碰 configs）。
    //   先 blur 把焦点移出卡片 body：否则同步 rebuild 时 rerenderFeatureCard 判「用户正在输入」跳过重建（行不消失）。
    {
      on: 'click',
      sel: '.pc-rgdel',
      run(e, ctx) {
        const del = e.target.closest('.pc-rgdel');
        if (!del) return;
        e.stopPropagation(); // 不触发卡片折叠
        if (typeof ctx.fd.onDeleteRow !== 'function') return;
        del.blur();
        ctx.fd.onDeleteRow(del.dataset.rowkey);
      },
    },
  ],
};
