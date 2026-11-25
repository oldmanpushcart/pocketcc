// 字段类型 module 注册表（架构审查候选 1 · T0 地基）。
// 每个字段类型一个 module（core/ui/field-types/<type>.js），经 registerType 汇入本表；
// fields.js 渲染查表与 wire.js 事件分发都按 fd.type 先查本表（module 优先 → 旧 FIELD_BOXES/FIELD_INLINE 兜底）。
// T1 迁 ranges（pilot）、T2 迁 huntlist + farmrules、T3 迁 multiopts/minerules/timeranges/presetpool/infogrid、
// T4 迁内联无状态 checkbox/number/select/string/button/text/note、T5 迁有状态清单 uidlist/sortlist/itemlist + uid/tripick/ctrlrow/rallygrid。
// 全 22 类型收编完毕（strangler 终态）：fields.js 两旧渲染表（FIELD_BOXES/FIELD_INLINE）与 wire.js 旧逐元素 handler 全退役，widgets.js 删除。
//
// module interface（grilling 定稿形状）：
//   {
//     type: string,                 // 字段类型名（= descriptor.fields[].type）
//     kind: 'box' | 'inline',       // box 带 fieldBox 外壳（容器型）；inline 无外壳（内联型）
//     cls?: string,                 // box 型容器类（如 'pc-rng'）；inline 型无
//     render(val, fd, c, fid): string,  // 内层 HTML，签名与旧渲染表严格一致
//     events?: [{ on, sel, run(e, ctx) }],  // 容器级委托声明：on=input/change/click，sel=命中选择器
//     refresh?(box, ctx): void,     // 缺省 = 重渲染内层；可覆写（有状态清单另由 mount* 装配）
//     refreshText?(el, ctx): void,  // 可选只读格钩子（随 refreshTexts 就地改文本）
//     assembleSel?: string,         // 有状态装配的容器选择器（assemble/sync 共用，如 '.pc-ulist' / '.pc-uidwrap:not(.pc-uli)'）
//     assemble?(box, ctx): void,    // 首次装配 / 卡重建重绑（有状态清单 mount*：闭包态行状态机/拖拽，决策 §3.4/§8 保留直接绑定）
//     sync?(box, ctx): void,        // 降级补载回写（清单 = 重刷重绑；标量 UID = __pcUidRefresh 只回显示态，绝不重绑）
//     mount?(panel, log): void,     // 可选面板级生命周期钩子（装配期调一次）：自注册超出单容器 dispatcher
//                                   //   的面板级监听（如 farmrules 浮层的 scroll 捕获/点外收起）；只拿 panel+log，不碰数据提交
//   }
//   ctx = { f, fd, c, fid, box, el, commit(), refresh(), syncChecks(sec) }
//   commit() = saveFeature + applyFeature + debug 日志（全扩展唯一提交流管道）
// 依赖链：fields.js → field-types/index.js → 各类型 module → dom.js/registry.js/net.js/ctx.js（无环；类型 module 不反查 fields.js/wire.js/panel.js）。

import { rangesType } from './ranges.js';
import { huntlistType } from './huntlist.js';
import { farmrulesType } from './farmrules.js';
import { multioptsType } from './multiopts.js';
import { matrixselectType } from './matrixselect.js';
import { minerulesType } from './minerules.js';
import { queueskillsType } from './queueskills.js';
import { timerangesType } from './timeranges.js';
import { presetpoolType } from './presetpool.js';
import { infogridType } from './infogrid.js';
import { checkboxType } from './checkbox.js';
import { numberType } from './number.js';
import { selectType } from './select.js';
import { stringType } from './string.js';
import { buttonType } from './button.js';
import { textType } from './text.js';
import { noteType } from './note.js';
import { uidlistType } from './uidlist.js';
import { sortlistType } from './sortlist.js';
import { itemlistType } from './itemlist.js';
import { uidType } from './uid.js';
import { tripickType } from './tripick.js';
import { ctrlrowType } from './ctrlrow.js';
import { rallygridType } from './rallygrid.js';

/** @type {Map<string, object>} type → 字段类型 module */
const MODULES = new Map();

/**
 * 注册一个字段类型 module（同 type 重复注册即覆写，便于测试隔离与热重载）。
 * @param {object} mod 类型 module（须含 type / kind / render）
 */
export function registerType(mod) {
  if (!mod || !mod.type || !mod.kind || typeof mod.render !== 'function') {
    throw new Error('field-type module must declare { type, kind, render() }');
  }
  MODULES.set(mod.type, mod);
}

/**
 * 按 fd.type 查类型 module。
 * @param {string} type 字段类型
 * @returns {object|undefined} 命中返回 module，未命中 undefined（调用方回落旧渲染表）
 */
export function getTypeModule(type) {
  return MODULES.get(type);
}

/**
 * 是否已注册任何类型 module（dispatcher 短路闸：空表时事件分发零 DOM 开销，T0 行为零变化）。
 * @returns {boolean}
 */
export function hasTypeModules() {
  return MODULES.size > 0;
}

/**
 * 装配期对声明了 mount 的类型 module 逐个调一次（面板级生命周期钩子，如 farmrules 浮层）。
 * 与 dispatcher 的逐事件 ctx 分离：mount 只拿 panel 根 + 日志器，自注册面板级监听，不做数据提交。
 * @param {Element} panel 面板根
 * @param {object} log 日志器（createLog 实例）
 */
export function mountTypeModules(panel, log) {
  for (const mod of MODULES.values()) if (typeof mod.mount === 'function') mod.mount(panel, log);
}

/**
 * 遍历声明了某装配钩子（assemble/sync）+ assembleSel 的类型 module，对 root 内每个匹配容器调一次。
 * makeCtx(box) 由调用方提供（wire/panel 共用 field-types/ctx.js 的 assembleCtx），解析不出 ctx 的容器跳过。
 * 只遍历有 assembleSel 的有状态 module（清单 + 标量 UID），无状态容器不在此列（它们走 refreshFieldBox）。
 * @param {Element} root 扫描范围（整面板或刚重建的 .pc-sec-body）
 * @param {'assemble'|'sync'} hook 钩子名
 * @param {function(Element):object|null} makeCtx 装配级 ctx 工厂
 */
function runAssembleHook(root, hook, makeCtx) {
  for (const mod of MODULES.values()) {
    if (typeof mod[hook] !== 'function' || !mod.assembleSel) continue;
    root.querySelectorAll(mod.assembleSel).forEach((box) => {
      const ctx = makeCtx(box);
      if (ctx) mod[hook](box, ctx);
    });
  }
}

/**
 * 首次装配 / 卡重建重绑：对有状态清单（uidlist/sortlist/itemlist）与标量 UID 行逐个调 assemble。
 * 替代 wire.wireControls 旧的逐类 querySelectorAll + mount*（widgets.js T5 退役）。
 * @param {Element} root 绑定范围（整面板或刚重建的 .pc-sec-body）
 * @param {function(Element):object|null} makeCtx 装配级 ctx 工厂（commit 收口 save+apply+log）
 */
export function assembleTypeModules(root, makeCtx) {
  runAssembleHook(root, 'assemble', makeCtx);
}

/**
 * 降级补载回写：对有状态清单逐个调 sync（重刷重绑），标量 UID 行只回显示态（__pcUidRefresh，不重绑）。
 * 替代 panel.syncControls 旧的 .pc-uidwrap __pcUidRefresh 循环 + 逐类 mount*。
 * @param {Element} root 面板根
 * @param {function(Element):object|null} makeCtx 装配级 ctx 工厂
 */
export function syncTypeModules(root, makeCtx) {
  runAssembleHook(root, 'sync', makeCtx);
}

// ── 装配：逐类型注册（strangler，迁一个注册一个） ──
registerType(rangesType);
registerType(huntlistType);
registerType(farmrulesType);
registerType(multioptsType);
registerType(matrixselectType);
registerType(minerulesType);
registerType(queueskillsType);
registerType(timerangesType);
registerType(presetpoolType);
registerType(infogridType);
registerType(checkboxType);
registerType(numberType);
registerType(selectType);
registerType(stringType);
registerType(buttonType);
registerType(textType);
registerType(noteType);
registerType(uidlistType);
registerType(sortlistType);
registerType(itemlistType);
registerType(uidType);
registerType(tripickType);
registerType(ctrlrowType);
registerType(rallygridType);
