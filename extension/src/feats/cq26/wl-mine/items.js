/**
 * CQ26 荒芜冰原矿区 · 矿种清单与分矿种最低量门槛（feats/cq26/wl-mine/items.js）
 *
 * 本文件是「本地策略层」，与 legs.js 的分工：
 *   legs.js 逐字镜像游戏谓词（canSteal/canHelp），回答「这个点游戏让不让动」；
 *   本文件回答「用户让不让动、存量够不够肥」—— 矿种勾选 + 按矿种的最低可盗/协量（oNum 门槛）。
 *
 * 零本地记账：每日次数唯一权威 = 22072 快照的共享总额度（remainStealNum/remainHelpNum ≤3/日，不分矿种），
 *   面板「今日进度」直接读它显示总数。本文件不记任何次数、不落盘、无网络/游戏符号耦合，只做纯推导。
 *   分矿种门槛只是「少动」的选点策略：存量 oNum 低于该矿种门槛的点不出手，把有限的日额度花在肥点上；
 *   它绝不参与服务器额度判定，服务器总额度闸始终兜底。
 *
 * 清单语义（itemlist，与采集腿 multiopts 刻意不同）：
 *   状态 `{[idStr]:{on:0|1,min:number}}`，未登记 = 默认 on 且 min=0（不限）；
 *   取消勾选 = 排除该矿种；**全不勾 = 该腿不动**（multiopts 空数组 = 不限，迁移按此折算）。
 */
import { ITEM_MINE, ITEM_THOR_MINE } from './constants.js';

/**
 * 矿种池（itemlist 行集，顺序即面板展示序）。itemId 即 RESOURCE 表主键，实测只有这两档在冰原出。
 * @type {Array<{id:number, label:string}>}
 */
export const MINE_POOL = [
  { id: ITEM_THOR_MINE, label: '雷神矿脉' },
  { id: ITEM_MINE, label: '矿山' },
];

/**
 * 面板 cfg → 运行时清单状态：只收池内 id，on 归一为 0/1、min 归一为非负整数；
 *   未登记项不落键（渲染与推导两侧都按「未登记 = on + 不限」处理，磁盘最小化）。
 * @param {*} v cfg 里的清单状态
 * @returns {Object<string,{on:number,min:number}>}
 */
export function normalizeItemState(v) {
  var out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (var i = 0; i < MINE_POOL.length; i++) {
    var id = MINE_POOL[i].id;
    var e = v[String(id)];
    if (!e || typeof e !== 'object') continue;
    var min = Math.floor(Number(e.min) || 0);
    out[String(id)] = { on: e.on === 0 ? 0 : 1, min: min > 0 ? min : 0 };
  }
  return out;
}

/**
 * 清单状态 → 本腿执行计划：勾选矿种数组（喂 legs.js 的 inWhitelist）+ 逐矿种最低量门槛（喂 canSteal/canHelp 的 mins）。
 * @param {*} state 清单状态（normalizeItemState 产出；未登记项默认 on/min=0）
 * @returns {{whitelist:number[], mins:Object<number,number>}} whitelist 为空 = 全不勾 = 腿不动
 *   （调用方必须先判空再喂谓词：legs.js 的 inWhitelist 把空数组当「不限」，语义相反）
 */
export function legPlan(state) {
  var map = state && typeof state === 'object' ? state : {};
  var whitelist = [];
  var mins = Object.create(null);
  for (var i = 0; i < MINE_POOL.length; i++) {
    var id = MINE_POOL[i].id;
    var e = map[String(id)];
    if (e && e.on === 0) continue;
    whitelist.push(id);
    var min = e ? Math.floor(Number(e.min) || 0) : 0;
    mins[id] = min > 0 ? min : 0;
  }
  return { whitelist: whitelist, mins: mins };
}

/**
 * 单腿迁移：把旧配置折算成 `{[idStr]:{on,min}}`，只登记非默认项（默认 on=1/min=0 不落键，磁盘最小化）。
 *   三种来源按优先级取 on：已有清单条目（v2/v3）> 旧白名单数组（v1）> 默认全勾。
 *   min：已有条目带 min（v3）直接用；否则取旧全局门槛 globalMin（v1/v2 的 stealMinONum/helpMinONum，
 *   旧语义是「所有矿种共用一个门槛」，故折算成每个矿种的初始门槛，行为逐字等价）。v2 的 max（每日上限）丢弃。
 * @param {*} items 已有清单状态（可能含 v2 的 max）
 * @param {*} whitelist 旧白名单数组（v1）
 * @param {*} globalMin 旧全局最低量门槛
 * @returns {Object<string,{on:number,min:number}>}
 */
function migrateLeg(items, whitelist, globalMin) {
  var gmin = Math.floor(Number(globalMin) || 0);
  if (gmin < 0) gmin = 0;
  var hasItems = items && typeof items === 'object' && !Array.isArray(items);
  var list = Array.isArray(whitelist) ? whitelist.map(Number) : null;
  var out = {};
  for (var i = 0; i < MINE_POOL.length; i++) {
    var id = MINE_POOL[i].id;
    var key = String(id);
    var on = 1;
    var min = gmin;
    var e = hasItems ? items[key] : null;
    if (e && typeof e === 'object') {
      on = e.on === 0 ? 0 : 1;
      if (Number.isFinite(Number(e.min))) min = Math.max(0, Math.floor(Number(e.min)));
    } else if (list) {
      // 旧语义「空数组 = 不限」折算为全勾；非空 = 只勾列出的矿种
      on = list.length === 0 || list.indexOf(id) >= 0 ? 1 : 0;
    }
    if (on !== 1 || min !== 0) out[key] = { on: on, min: min };
  }
  return out;
}

/**
 * 配置迁移（descriptor.migrate 钩子，纯函数）：v1 的白名单数组 + 全局门槛、v2 的 {on,max} + 全局门槛，
 *   统一折算成 v3 的 stealItems/helpItems `{on,min}`，旧键（stealItemWhitelist/helpItemWhitelist/
 *   stealMinONum/helpMinONum）删除（不留历史残留）。
 *   幂等：registry 在落盘前每次读盘都会重跑 migrate，同一份旧存档必须产出相同结果 ——
 *   折算只读「旧键/已有条目」，重跑时旧键已删、min 已在条目里，收敛到同一状态。
 * @param {object} cfg 默认+存量合并后的配置
 * @param {number} fromVersion 存档版本（无 _v 视为 0）
 * @returns {object} 迁移后的新配置（不改动入参）
 */
export function migrateItemLists(cfg, fromVersion) {
  var out = Object.assign({}, cfg || {});
  if (fromVersion < 3) {
    out.stealItems = migrateLeg(out.stealItems, out.stealItemWhitelist, out.stealMinONum);
    out.helpItems = migrateLeg(out.helpItems, out.helpItemWhitelist, out.helpMinONum);
    delete out.stealItemWhitelist;
    delete out.helpItemWhitelist;
    delete out.stealMinONum;
    delete out.helpMinONum;
  }
  return out;
}
