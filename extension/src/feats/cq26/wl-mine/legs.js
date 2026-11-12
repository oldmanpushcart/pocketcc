/**
 * CQ26 荒芜冰原矿区 · 三腿纯函数谓词与选点排序（feats/cq26/wl-mine/legs.js）
 *
 * 本文件是「判据层」，与网络/游戏符号零耦合：输入是 survey.js 从 901 `m` 块拆出来的**标量小对象**，
 *   ctx 是 index.js 每拍现读的 ACL 快照拼出的上下文。三个谓词逐字镜像
 *   `NWICQ26WLResource.canSteal/canHelp` 与采集腿选点口径（docs/feat-荒芜冰原-采集.md §3.7），
 *   **闸门顺序不得改**：改了就和玩家面板上那三个按钮不同源，实测对拍也会翻红。
 *
 * 两处源码不对称，实现照抄而不是「顺手对齐」：
 *   · 盗采不校 `ownerId`（靠 `gatherStartTime>0` 隐含「有人在采」）；
 *   · 协助在 `gatherStartTime==0`（尚未开采）时**放行**（源码原文如此）。
 *
 * fail-closed 纪律：ctx 里任何一项 undefined/null 都当「无从判定 → 不可动」，
 *   绝不落到宽松那支（尤其 `originSid` 取不到时若按 0 比较，外服点会全被误判成本服点，盗采腿整条退成协助腿）。
 *
 * 点位对象形状（survey.js 产出，报文原始 `m` 块用完即弃、不外泄）：
 *   `{x, y, k, itemId, ownerId, initSid, specIndex, gst, gNum, oNum, gatherSpeed, stealUidList, protectUidList}`
 *   其中 `oNum=null` 表示该字段这帧没回（属报文形态问题，排序与门槛都不得当 0 处理）。
 */

// 多条谓词共用同一道前置闸，归因文本成常量：既保证两处判据逐字同源，
//   也不必为了日志可 grep 而重复字面量（取值与历史日志/对拍完全一致）。
const WHY_NO_POINT = 'no-point';
const WHY_NO_ORIGIN_SID = 'no-origin-sid';
const WHY_NO_SPEC_INDEX = 'no-spec-index';
const WHY_NOT_OWN_SERVER = 'not-own-server';
const WHY_ITEM_FILTERED = 'item-filtered';

/**
 * 名单是否已含本人。
 * @param {string[]|null|undefined} list `m.stealUidList` / `m.protectUidList`
 * @param {string} me 本人 StrUid
 * @returns {boolean}
 */
function hasMe(list, me) {
  if (!Array.isArray(list) || !me) return false;
  for (var i = 0; i < list.length; i++) if (String(list[i]) === me) return true;
  return false;
}

/**
 * 矿种白名单：空数组 = 不限制（面板三项全不勾的语义）。
 * @param {number[]} whitelist
 * @param {number} itemId
 * @returns {boolean}
 */
function inWhitelist(whitelist, itemId) {
  if (!Array.isArray(whitelist) || !whitelist.length) return true;
  for (var i = 0; i < whitelist.length; i++) if (Number(whitelist[i]) === itemId) return true;
  return false;
}

/**
 * 单点 `steal + protect` 合计名额是否未满（`conf(52000364)`，盗采与协助在同一点上零和）。
 * @param {object} point 归一点
 * @param {object} ctx `{quotaMax:number|null}`
 * @returns {boolean}
 */
function quotaRoom(point, ctx) {
  var max = ctx.quotaMax;
  if (typeof max !== 'number') return false;
  var used = (point.stealUidList || []).length + (point.protectUidList || []).length;
  return used < max;
}

/**
 * 采集腿：本服空闲点，可直接派兵。
 * 非客户端谓词（游戏侧没有 canGather），是我们自己的选点口径；额度与「本人是否已有采集行军」
 *   由 index.js 的闸门负责，本函数只管「这个点能不能采」。
 * @param {object} point 归一点
 * @param {object} ctx `{originSid:number|null, whitelist:number[]}`
 * @returns {{ok:boolean, why:string}}
 */
export function canGather(point, ctx) {
  if (!point) return { ok: false, why: WHY_NO_POINT };
  if (typeof ctx.originSid !== 'number') return { ok: false, why: WHY_NO_ORIGIN_SID };
  if (point.initSid !== ctx.originSid) return { ok: false, why: WHY_NOT_OWN_SERVER };
  // 无主才叫空闲（ownerId 是字符串 UID，'0'/''/缺失 = 无人开采）
  if (point.ownerId != null && point.ownerId !== '' && point.ownerId !== '0') {
    return { ok: false, why: 'occupied' };
  }
  // 缺 specIndex 即 2114 的 wastelandIndex 无从取值（游戏 clickCQ26WLGather 直接 return）
  if (point.specIndex == null) return { ok: false, why: WHY_NO_SPEC_INDEX };
  if (!inWhitelist(ctx.whitelist, point.itemId)) return { ok: false, why: WHY_ITEM_FILTERED };
  return { ok: true, why: '' };
}

/**
 * 盗采腿：外服、已过安全期、本人未偷过、名额未满。
 * @param {object} point 归一点
 * @param {object} ctx `{me:string, originSid:number|null, nowSec:number, matureSec:number|null, quotaMax:number|null, whitelist:number[], mins:Object<number,number>}`
 * @returns {{ok:boolean, why:string}}
 */
export function canSteal(point, ctx) {
  if (!point) return { ok: false, why: WHY_NO_POINT };
  if (typeof ctx.originSid !== 'number') return { ok: false, why: WHY_NO_ORIGIN_SID };
  if (typeof ctx.matureSec !== 'number') return { ok: false, why: 'no-mature-conf' };
  if (!point.initSid || point.initSid === ctx.originSid) return { ok: false, why: 'not-foreign' };
  if (hasMe(point.stealUidList, ctx.me)) return { ok: false, why: 'already-stolen' };
  if (!quotaRoom(point, ctx)) return { ok: false, why: 'point-quota-full' };
  // 跨服下发的 gatherStartTime 存在陈旧值，故成熟判定必须再叠一道 gNum>0 兜底
  if (!(point.gst > 0) || point.gst + ctx.matureSec > ctx.nowSec)
    return { ok: false, why: 'immature' };
  if (!(point.gNum > 0)) return { ok: false, why: 'nothing-to-take' };
  if (!inWhitelist(ctx.whitelist, point.itemId)) return { ok: false, why: WHY_ITEM_FILTERED };
  if (point.oNum == null) return { ok: false, why: 'no-onum' };
  // 分矿种最低可盗量门槛（items.js legPlan 的 mins）：存量低于该矿种门槛不出手，0=不限
  var min = Number(ctx.mins && ctx.mins[point.itemId]) || 0;
  if (min > 0 && point.oNum < min) return { ok: false, why: 'onum-below-min' };
  return { ok: true, why: '' };
}

/**
 * 协助腿：本服、他人正在采、本人未协过、名额未满。
 * @param {object} point 归一点
 * @param {object} ctx 同 canSteal（whitelist/mins 换成本腿取值）
 * @returns {{ok:boolean, why:string}}
 */
export function canHelp(point, ctx) {
  if (!point) return { ok: false, why: WHY_NO_POINT };
  if (typeof ctx.originSid !== 'number') return { ok: false, why: WHY_NO_ORIGIN_SID };
  if (typeof ctx.matureSec !== 'number') return { ok: false, why: 'no-mature-conf' };
  if (!point.initSid || point.initSid !== ctx.originSid)
    return { ok: false, why: WHY_NOT_OWN_SERVER };
  // 必须已有「他人」主人（协助是给别人的点加保护并即时拿奖励，自己的点不在此列）
  if (!point.ownerId || point.ownerId === '0' || point.ownerId === ctx.me) {
    return { ok: false, why: 'no-other-owner' };
  }
  if (hasMe(point.protectUidList, ctx.me)) return { ok: false, why: 'already-helped' };
  if (!quotaRoom(point, ctx)) return { ok: false, why: 'point-quota-full' };
  // 源码原文：`gatherStartTime` 未起（0/缺失）也放行 —— 与盗采腿刻意不对称，不得对齐
  if (point.gst > 0 && point.gst + ctx.matureSec > ctx.nowSec)
    return { ok: false, why: 'immature' };
  if (!inWhitelist(ctx.whitelist, point.itemId)) return { ok: false, why: WHY_ITEM_FILTERED };
  if (point.oNum == null) return { ok: false, why: 'no-onum' };
  // 分矿种最低可协量门槛（同盗采腿口径）
  var min = Number(ctx.mins && ctx.mins[point.itemId]) || 0;
  if (min > 0 && point.oNum < min) return { ok: false, why: 'onum-below-min' };
  return { ok: true, why: '' };
}

/**
 * 赛季阶段闸（纯函数，不发请求）：只有 CAN_OPEN（开荒中）允许派兵 / 盗采 / 协助。
 * `canOpen/notOpen/ended` 由调用方注入，本层不 import 常量，以守住文件头的「零符号耦合」。
 * @param {{curStage:number|null, curStageEndTime:number|null, canOpen:number, notOpen:number, ended:number}} g
 *   阶段三元组 + 三档阈值（`constants.js` 的 WL_STAGE_*）
 * @returns {{actionable:boolean, why:string, untilSec:number}}
 *   `why`：`''`（可动作）| `unknown`（无从判定，纳入既有分区 status 判据继续跑）| `not-open` | `ended` | `other`
 *   `untilSec`：本阶段结束的目标服务器秒（0 = 无法定位，由调用方兜底档收敛）
 */
export function stageGate(g) {
  var stage = g && g.curStage;
  if (stage == null) return { actionable: true, why: 'unknown', untilSec: 0 };
  var n = Number(stage);
  var end = Number(g.curStageEndTime) || 0;
  if (n === g.canOpen) return { actionable: true, why: '', untilSec: 0 };
  if (n === g.notOpen) return { actionable: false, why: 'not-open', untilSec: end };
  if (n === g.ended) return { actionable: false, why: 'ended', untilSec: end };
  return { actionable: false, why: 'other', untilSec: end };
}

/**
 * 采集腿「本人正在采」判据：用于认领一条本机状态机不知情的在途 315 行军（重启 / pause 期间派出的兵）。
 * 逐字镜像源码 `NWICQ26WLResource.isGatheringResource` —— 原文即 `String(extData.ownerId || "")` 非空且 `=== StrUid`，
 *   故空 ownerId（空闲点）判 false，不会与 `canGather` 的「无主即空闲」重叠。
 * 另加两条本模块自用闸：`initSid` 必须等于本服号（认领只吃本服点）、`specIndex` 必须可得（否则 2114/召回时刻无从算）。
 * @param {object} point 归一点
 * @param {object} ctx `{me:string, originSid:number|null}`
 * @returns {{ok:boolean, why:string}}
 */
export function isOwnGathering(point, ctx) {
  if (!point) return { ok: false, why: WHY_NO_POINT };
  if (!ctx.me) return { ok: false, why: 'no-me' };
  if (typeof ctx.originSid !== 'number') return { ok: false, why: WHY_NO_ORIGIN_SID };
  if (point.initSid !== ctx.originSid) return { ok: false, why: WHY_NOT_OWN_SERVER };
  var owner = String(point.ownerId == null ? '' : point.ownerId);
  if (!owner || owner === '0') return { ok: false, why: 'idle-point' };
  if (owner !== ctx.me) return { ok: false, why: 'not-mine' };
  if (point.specIndex == null) return { ok: false, why: WHY_NO_SPEC_INDEX };
  return { ok: true, why: '' };
}

/**
 * 盗采/协助选点序：按 `oNum` 降序（可被盗/被保护量就是这一笔的即时收益，日额度 ≪ 候选池，价值全在择优）。
 * 不改动入参；`oNum` 缺失的点排到末尾（谓词层已把它们剔除，此处只是保证即便被误传也不会顶到队头）。
 * @param {object[]} points
 * @returns {object[]} 新数组
 */
export function rankByValue(points) {
  return (points || []).slice().sort(function (a, b) {
    var av = a && a.oNum != null ? a.oNum : -1;
    var bv = b && b.oNum != null ? b.oNum : -1;
    return bv - av;
  });
}

/**
 * 采集腿选点序：取最近空闲点。
 * 安全期套利把 16h 额度切成 8 轮，行军 ETA 直接吃掉轮次预算，故近家优先（速率不参与判据，11-12 废弃门槛）。
 * @param {object[]} points 已过 canGather 的点
 * @param {number|null} homeX 本人基地世界 x（取不到传 null，退化为不排序）
 * @param {number|null} homeY 本人基地世界 y
 * @returns {object[]} 新数组（homeX/homeY 不可得时保持入参顺序）
 */
export function pickNearestFree(points, homeX, homeY) {
  var list = (points || []).slice();
  var hx = Number(homeX);
  var hy = Number(homeY);
  if (homeX == null || homeY == null || !isFinite(hx) || !isFinite(hy)) return list;
  return list.sort(function (a, b) {
    return dist2(a, hx, hy) - dist2(b, hx, hy);
  });
}

/**
 * squared 距离（不开方：只用于排序，单调性等价）。
 * @param {object} p 点
 * @param {number} hx 参考 x
 * @param {number} hy 参考 y
 * @returns {number}
 */
function dist2(p, hx, hy) {
  var dx = (p && p.x ? p.x : 0) - hx;
  var dy = (p && p.y ? p.y : 0) - hy;
  return dx * dx + dy * dy;
}

/**
 * 把一组 blocked 原因折叠成一行 `reason×n`（debug 用：保证「为什么没动」单轨可诊断，又不逐点刷屏）。
 * @param {Array<{why:string}>} blocked 被拒原因列表
 * @returns {string}
 */
export function briefReasons(blocked) {
  var m = Object.create(null);
  for (var i = 0; i < (blocked || []).length; i++) {
    var k = blocked[i].why || 'unknown';
    m[k] = (m[k] || 0) + 1;
  }
  return (
    Object.keys(m)
      .map(function (k) {
        return k + '×' + m[k];
      })
      .join(',') || '-'
  );
}
