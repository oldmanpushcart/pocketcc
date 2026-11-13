// descriptor.fields[] → 面板行 HTML 的纯构建器族（无 DOM 绑定，只返回字符串）。
// 从 core/ui.js 迁出：cardHead / buildFieldsHTML。值来自 registry.configs，转义走 dom.escAttr。
// T5 终态：全部 22 字段类型的渲染器已迁 field-types/<type>.js module，本文件只余卡片标题 + 渲染分发 + 容器就地重刷。
import { configs, findFeature } from '../registry.js';
import { escAttr, fieldBox, findFieldDescriptor } from './dom.js';
import { getTypeModule } from './field-types/index.js';

/**
 * 卡片标题行 HTML：折叠箭头 + 标题 + 启用 checkbox（组用 pc-gen[data-gid]，功能用 pc-en[data-id]）
 * @param {string} label 标题文本
 * @param {string} chkHTML checkbox 片段
 * @param {boolean} expandable 是否可展开（否则箭头隐藏）
 * @returns {string}
 */
export function cardHead(label, chkHTML, expandable) {
  const title =
    `<span class="pc-chev${expandable ? '' : ' invisible'}">▶</span>` +
    `<span class="pc-sec-title">${label}</span>`;
  // 可展开卡片的标题做成真实 button（键盘 Enter/Space 可折叠）；checkbox 作为兄弟节点不被包进按钮（交互元素不得嵌套）
  const toggle = expandable
    ? `<button type="button" class="pc-sec-toggle" aria-expanded="false">${title}</button>`
    : title;
  return `<div class="pc-sec-head">${toggle}${chkHTML}</div>`;
}

// 全部字段类型渲染器已迁 field-types/<type>.js module（T1~T5，strangler 终态）：
//   容器型 ranges/multiopts/minerules/farmrules/timeranges/huntlist/presetpool/infogrid/uidlist/sortlist/itemlist，
//   内联型 checkbox/number/select/string/button/text/note/tripick/ctrlrow/uid/rallygrid。
//   旧 FIELD_BOXES / FIELD_INLINE 两渲染表随之退役，渲染分发只查 module 注册表 + number 兜底。
//   有状态清单的装配（mount*）迁各 module 的 assemble/sync 钩子，共享核落 uid-core.js / row-drag.js，widgets.js 删除。

// findFieldDescriptor 已下沉 dom.js（T5）：纯函数叶子，供有状态清单 module 直接 import 而不撞循环。
//   fields.js 自身（refreshFieldBox）与 panel/wire 改从 dom.js import。

/**
 * 就地重刷一个容器型字段（.pc-rng / .pc-mopts / .pc-mrule / .pc-frule / .pc-trule / .pc-igraphbox …）的内层 HTML：
 * 靠外壳上的 data-id + data-fkey 反查 descriptor，再按 type 走 module 注册表渲染，
 * 与 buildFieldsHTML 首次渲染严格同源（同一 render、同一参数顺序）。
 * 有状态的清单（uidlist/sortlist/itemlist）不走这里，由各 module 的 sync 钩子（mount*）重刷并重绑
 *   （innerHTML 整块重刷会拆掉拖拽/勾选/行状态机监听）。
 * @param {Element} box 带 data-id/data-fkey 的字段容器
 * @returns {boolean} 是否刷了（功能/字段查不到、类型无 box module 时 false）
 */
export function refreshFieldBox(box) {
  if (!box || !box.dataset) return false;
  const f = findFeature(box.dataset.id);
  if (!f) return false;
  const fd = findFieldDescriptor(f, box.dataset.fkey);
  if (!fd) return false;
  const c = configs[f.id];
  // 仅 box 型 module 走这里（inline 无容器外壳）；T5 终态无旧表兜底
  const mod = getTypeModule(fd.type);
  if (!c || !mod || mod.kind !== 'box') return false;
  box.innerHTML = mod.render(c[fd.key], fd, c, f.id);
  return true;
}

/**
 * descriptor fields -> 行 HTML（checkbox / text 只读惰性求值 / 数字输入 / 下拉 / 一行多控件 / 区间规则）。
 * fd.section 变化时插入分组小标题（如联盟集结按战锤/惧星/难民营分段），容器带 data-id=功能 id。
 * fd.showIf(cfg) 为假时该行不占位（只在行根打 data-dep，真实显隐由 refreshFieldVisibility 切 hidden）。
 * @param {string} fid 功能 id
 * @param {object} f descriptor
 * @returns {string}
 */
export function buildFieldsHTML(fid, f) {
  const c = configs[fid];
  // 单字段 → HTML（不含分组标题）；分组标题与可折叠包裹由下方循环统一处理。
  // T5 终态：分发只查 module 注册表（box 型套 fieldBox 外壳 / inline 型直出），无 type 顶层字段落 number module 兜底。
  const fieldHTML = (fd) => {
    const mod = getTypeModule(fd.type);
    if (mod) {
      const inner = mod.render(c[fd.key], fd, c, fid);
      return mod.kind === 'box' ? fieldBox(mod.cls, fid, fd.key, inner) : inner;
    }
    return getTypeModule('number').render(c[fd.key], fd, c, fid); // 无 type 顶层字段兜底（number module，T4）
  };
  let lastSection;
  let bodyOpen = false; // 当前是否有一个可折叠子分组的 body 处于打开（待闭合）状态
  const out = [];
  for (const fd of f.fields) {
    if (fd.section && fd.section !== lastSection) {
      if (bodyOpen) {
        out.push('</div>');
        bodyOpen = false;
      } // 闭合上一个折叠体
      if (fd.secCollapsible) {
        // 可折叠子分组（如卡车拦截「拦截判定」）：标题行带箭头可点，其后字段包进 .pc-fsec-body（secCollapsed 默认收起）
        const collapsed = !!fd.secCollapsed;
        out.push(
          `<button type="button" class="pc-fsec pc-fsectoggle${collapsed ? '' : ' open'}" aria-expanded="${collapsed ? 'false' : 'true'}"><span class="pc-fsecchev">▶</span><span>${fd.section}</span></button>`,
        );
        out.push(`<div class="pc-fsec-body"${collapsed ? ' hidden' : ''}>`);
        bodyOpen = true;
      } else {
        out.push(`<div class="pc-fsec" data-sec="${escAttr(fd.section)}">${fd.section}</div>`);
      }
    }
    lastSection = fd.section || null;
    const html = fieldHTML(fd);
    // 条件字段（fd.showIf(cfg)）：不改 fieldHTML 各分支，只在行根补一个 data-dep 标记（值=字段 key，
    //   data-depfid=功能 id），显隐交 refreshFieldVisibility 就地切 hidden —— 不重建 DOM，已绑好的控件事件全部存活
    out.push(
      fd.showIf
        ? html.replace(
            /<([a-zA-Z][\w-]*)/,
            `<$1 data-dep="${escAttr(fd.key)}" data-depfid="${fid}"`,
          )
        : html,
    );
  }
  if (bodyOpen) out.push('</div>');
  return out.join('');
}
