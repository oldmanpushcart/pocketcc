// core/ui 纯文本工具：属性转义、可选 JSON 解析、630 应答取昵称、容器字段外壳、共享占位文案、字段描述符反查。
// 无 DOM/状态依赖，被 fields/widgets/panel/field-types 复用。
// findFieldDescriptor/findFieldOwner 从 fields.js 下沉于此（T5）：纯函数叶子，令有状态清单 module
//   可直接 import 而不撞 fields→index→module 循环（depcruise no-circular）。

/** @type {string} 「0 = 无限」类数字框的占位文案（huntlist/rallygrid/number 共用，单点定义防文案漂移） */
export const PLACEHOLDER_UNLIMITED = '不限';

/**
 * 转义写入属性选择器/属性值的双引号与尖括号、&（供可编辑文本字段回填 value）
 * @param {string} s 原值
 * @returns {string}
 */
export function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 整行容器字段的外壳：统一带 data-id（功能 id）与 data-fkey（字段 key），供消费侧 boxTarget 反查。
 * 从 fields.js 下沉：field-types 各类型 module 也要拼容器外壳，共用此单点实现，
 * 且令 fields→field-types→dom 依赖链无环（field-types 不反查 fields）。
 * @param {string} cls 容器类
 * @param {string} fid 功能 id
 * @param {string} key 字段 key
 * @param {string} inner 内层 HTML
 * @returns {string}
 */
export function fieldBox(cls, fid, key, inner) {
  return `<div class="${cls}" data-id="${fid}" data-fkey="${escAttr(key)}">${inner}</div>`;
}

/**
 * 字符串载荷尝试 JSON.parse；非串或失败原样返回
 * @param {*} s 原值
 * @returns {*} 解析结果
 */
export function parseMaybe(s) {
  if (typeof s !== 'string' || !s) return s;
  try {
    return JSON.parse(s);
  } catch (e) {
    return s;
  }
}

/**
 * 从 630 应答取展示昵称（微信资料内层串 username/nickname 优先，回退顶层 nickname/name）
 * @param {object} d 应答顶层 parse 产物
 * @returns {string}
 */
export function nickFrom630(d) {
  var wx = d && d.playerInfo;
  if (typeof wx === 'string') wx = parseMaybe(wx);
  return String((wx && (wx.username || wx.nickname)) || (d && (d.nickname || d.name)) || '');
}

/**
 * 按 DOM 上的控件 key（data-key / data-fkey）反查 descriptor，单点口径。
 * 顶层 fd.key 命中即返回；否则按类型下探行内子控件（子控件的 key 才是存档键，与 fd.key 不同）：
 *   tripick → parts、ctrlrow → cells、rallygrid → rows 的 delay/limit/count。
 * 此前 wire.js（数字/下拉两处）与 panel.js（refreshTexts）各抄了一份下探逻辑，新增一类子控件就要三处跟改。
 * @param {object} f descriptor（含 fields）
 * @param {string|undefined} key DOM 上带的控件 key
 * @returns {object|null} 命中的（子）描述符，未命中 null
 */
export function findFieldDescriptor(f, key) {
  if (!f || !Array.isArray(f.fields) || key == null) return null;
  const top = f.fields.find((x) => x.key === key);
  if (top) return top;
  for (const x of f.fields) {
    if (x.type === 'tripick' || x.type === 'ctrlrow') {
      const sub = (x.parts || x.cells || []).find((p) => p.key === key);
      if (sub) return sub;
    } else if (x.type === 'rallygrid') {
      for (const r of x.rows || []) {
        for (const cell of [r.delay, r.limit, r.count]) {
          if (cell && cell.key === key) return cell;
        }
      }
    }
  }
  return null;
}

/**
 * 按控件 key 反查**拥有它的顶层字段** descriptor（dispatcher 内联路径路由用，T5）。
 * 与 findFieldDescriptor 互补：后者返回子描述符本身（part/cell/行内格），本函数返回其所属顶层 fd，
 *   以便按 fd.type 查类型 module。子控件（tripick.parts / ctrlrow.cells / rallygrid 行内格 / uid.enableKey）
 *   的 data-key ≠ 顶层 fd.key，无 data-fkey 容器外壳，故内联路径须靠本函数找到 owning module。
 * 顶层 key 直接返回该 fd；uid 的 enableKey、rallygrid 行 enableKey 也归到各自顶层 fd。
 * @param {object} f descriptor（含 fields）
 * @param {string|undefined} key DOM 上带的控件 key
 * @returns {object|null} 拥有该 key 的顶层字段描述符，未命中 null
 */
export function findFieldOwner(f, key) {
  if (!f || !Array.isArray(f.fields) || key == null) return null;
  for (const x of f.fields) {
    if (x.key === key) return x;
    if (x.type === 'tripick' || x.type === 'ctrlrow') {
      if ((x.parts || x.cells || []).some((p) => p.key === key)) return x;
    } else if (x.type === 'rallygrid') {
      for (const r of x.rows || []) {
        if (r.enableKey === key) return x;
        if ([r.delay, r.limit, r.count].some((cell) => cell && cell.key === key)) return x;
      }
    } else if (x.type === 'uid') {
      if (x.enableKey === key || x.nameKey === key) return x;
    }
  }
  return null;
}
