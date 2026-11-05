/**
 * 异能秘境自动驾驶 · 选点纯函数层（v4，逐行对齐竞品B enigmaSecret §5.1/§5.3）。
 *
 * 「先证后接」的产物：这里只放**无副作用**的选点/判据函数，供 pilot.js 的 async 动作层调用，
 * 也供 tests/feats/secret-realm-pilot.test.js 用录制 901 夹具离线回放（不摸 chrome、不发协议、不读全局）。
 *
 * 时钟/队 ID/回合开放/品质等**外部料一律由调用方预解析后经 ctx 注入**，函数本身只吃数据做纯计算——
 * 这样错归因时能从报文反推，而不是把选点与调度绑在一起（上一轮重写的教训）。
 *
 * 竞品行号索引见 docs/feat-异能秘境自动驾驶-v4竞品B对齐重写.md。
 * 红线：一律引用 constants 常量名（PAB_*），禁止裸 pointType 数字。
 */
import { PAB_RESOURCE, PAB_MONSTER, PAB_SHOP } from './constants.js';
import { dist } from './util.js';

/**
 * 归属判定（竞品 L24804 `!callTId || callTId==teamId`，抓兽/打野的隐藏闸）。
 * ⚠ 报文实证：`callTId` 是 901 里的 JSON number 且尾部恒被 Int64→double 抹零，`roomBaseInfo.teamId` 是精确串/Int64——
 *   **不能字符串比**，必须两边同转 double（本仓「64 位不 Number 化」红线在此的一个受控例外，要的是模糊等值）。
 * @param {number|string|null|undefined} callTId 野怪 m.callTId（无归属为空/0）
 * @param {number|null|undefined} myTeamIdNum 己方队 ID 的 double 值（调用方用 bits.int64ToNum 预先取数）
 * @returns {boolean} true=可打（无主或己方）
 */
export function beastOwnedByMeOrFree(callTId, myTeamIdNum) {
  if (callTId == null || callTId === 0 || callTId === '') return true; // 无召唤队 → 野怪可打
  if (myTeamIdNum == null) return false; // 拿不到己方队 ID → 保守判不可打（不误抢别人召唤的兽）
  return Number(callTId) === Number(myTeamIdNum);
}

/** 该点是否被 marched_list（60s 窗）拦下：竞品 L24717 `ServerTime - e.t < 60`。 */
function inMarchedList(marchedList, x, y, serverTimeSec) {
  if (!Array.isArray(marchedList)) return false;
  for (let i = 0; i < marchedList.length; i++) {
    const e = marchedList[i];
    if (!e) continue;
    if (
      Number(e.x) === Number(x) &&
      Number(e.y) === Number(y) &&
      serverTimeSec - Number(e.t || 0) < 60
    )
      return true;
  }
  return false;
}

/** 是否已有在途行军（state==1）指向该点：竞品 L24737 `o.marchList.find(t.target.tx==x && t.target.ty==y && t.state==1)`。
 *  marchPolicy==1（跟队派）跳过本检查。 */
function hasMarchTargeting(marches, x, y, marchPolicy) {
  if (marchPolicy === 1) return false;
  if (!Array.isArray(marches)) return false;
  for (let i = 0; i < marches.length; i++) {
    const m = marches[i];
    if (m && Number(m.tx) === Number(x) && Number(m.ty) === Number(y) && Number(m.state) === 1)
      return true;
  }
  return false;
}

/**
 * 资源点成本打分（竞品 L24712 `r(p, n)`）：越小越"顺路"，选点键 `iNum - r` 越大越好。
 *   `r(p, n) = d(p,起点)/2 + d(p,未领奖BOSS)/5 + (n ? d(p,无香肠店)/6 : 0)`
 * @param {{x:number,y:number}} p
 * @param {{startPoint:{x:number,y:number}, firstUnrewardedBoss?:{x:number,y:number}|null, nearestNoSausageShop?:{x:number,y:number}|null}} ctx
 * @returns {number}
 */
export function resourceCost(p, ctx) {
  const s = ctx.startPoint || {};
  let r = dist(p.x, p.y, s.x, s.y) / 2;
  const boss = ctx.firstUnrewardedBoss;
  if (boss) r += dist(p.x, p.y, boss.x, boss.y) / 5;
  const shop = ctx.nearestNoSausageShop;
  if (shop) r += dist(p.x, p.y, shop.x, shop.y) / 6;
  return r;
}

/**
 * 选资源井（竞品 `marchResource` L24708-24770）。筛子**收敛到 4 道**：类型 / 回合 / iNum+距离 / 空位无在途。
 * ⚠ 我方 v3 的 `rTime>now` 判空 与 `consumed` 10min 黑名单**在此一律不看**（竞品无此闸，误删是"不回头补拿"的根因，§5.1）。
 * @param {Array} points 901 原样 pointList（每点 {x,y,pointType,m:{iNum,state,teams,esrId}}）
 * @param {{
 *   startPoint:{x:number,y:number}, serverTimeSec:number, minNum?:number, maxDist?:number,
 *   isRoundOpen:(esrId:number)=>boolean, marches?:Array, marchedList?:Array, marchPolicy?:number,
 *   firstUnrewardedBoss?:{x:number,y:number}|null, nearestNoSausageShop?:{x:number,y:number}|null
 * }} ctx
 * @returns {{x:number,y:number,pointType:number,m:object,score:number}|null} 最佳井，无则 null
 */
export function pickResource(points, ctx) {
  const minNum = ctx.minNum == null ? 0 : Number(ctx.minNum);
  const maxDist = ctx.maxDist == null ? Infinity : Number(ctx.maxDist);
  const policy = ctx.marchPolicy || 0;
  const isRoundOpen = ctx.isRoundOpen || (() => true);
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || Number(p.pointType) !== PAB_RESOURCE) continue; // 闸 1：类型（Number 兜字符串 pointType，防静默全 drop）
    const m = p.m || {};
    if (!isRoundOpen(m.esrId)) continue; // 闸 2：回合已开放（用 m.esrId，viewLevel:1）
    if (inMarchedList(ctx.marchedList, p.x, p.y, ctx.serverTimeSec)) continue; // 闸 3a：60s 内派过
    if (!(Number(m.iNum || 0) >= minNum)) continue; // 闸 3b：产出下限
    const dd = dist(p.x, p.y, (ctx.startPoint || {}).x, (ctx.startPoint || {}).y);
    if (!(dd > 0 && dd <= maxDist)) continue; // 闸 3c：距离（>0 排除脚下）
    // 闸 4：空位 + 无在途
    if (Number(m.state) !== 0) continue;
    if (Array.isArray(m.teams) && m.teams.length > 0) continue;
    if (hasMarchTargeting(ctx.marches, p.x, p.y, policy)) continue;
    const score = Number(m.iNum || 0) - resourceCost(p, ctx);
    if (score > bestScore) {
      bestScore = score;
      best = { x: p.x, y: p.y, pointType: p.pointType, m, score };
    }
  }
  return best;
}

/**
 * 选异能兽（竞品 `marchBeast` L24772-24826 主路，本地 entities 部分按 §3.1 全换视口 901）。
 * 归属闸用 `beastOwnedByMeOrFree`（double 比）。品质经 ctx.qualityFor 注入（未侦察回 null → 按 2 计）。
 * @param {Array} points
 * @param {{
 *   startPoint:{x:number,y:number}, minQuality?:number, maxDist?:number,
 *   isRoundOpen:(esrId:number)=>boolean, myTeamIdNum?:number|null,
 *   qualityFor:(x:number,y:number)=>number|null, marches?:Array, marchPolicy?:number
 * }} ctx
 * @returns {{x:number,y:number,pointType:number,m:object,quality:number}|null}
 */
export function pickBeast(points, ctx) {
  const minQuality = ctx.minQuality == null ? 4 : Number(ctx.minQuality);
  const maxDist = ctx.maxDist == null ? Infinity : Number(ctx.maxDist);
  const policy = ctx.marchPolicy || 0;
  const isRoundOpen = ctx.isRoundOpen || (() => true);
  const qualityFor = ctx.qualityFor || (() => null);
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || Number(p.pointType) !== PAB_MONSTER) continue; // 类型：172（非 163；Number 兜字符串 pointType）
    const m = p.m || {};
    if (!isRoundOpen(m.esrId)) continue;
    if (!beastOwnedByMeOrFree(m.callTId, ctx.myTeamIdNum)) continue; // 归属隐藏闸
    if (Number(m.state) !== 0) continue;
    if (Array.isArray(m.teams) && m.teams.length > 0) continue;
    if (hasMarchTargeting(ctx.marches, p.x, p.y, policy)) continue;
    const q = qualityFor(p.x, p.y);
    const quality = q == null ? 2 : Number(q);
    if (!(quality >= minQuality)) continue;
    const dd = dist(p.x, p.y, (ctx.startPoint || {}).x, (ctx.startPoint || {}).y);
    if (!(dd > 0 && dd <= maxDist)) continue;
    // 排序：quality desc, dist asc
    if (
      !best ||
      quality > best.quality ||
      (quality === best.quality &&
        dd < dist(best.x, best.y, (ctx.startPoint || {}).x, (ctx.startPoint || {}).y))
    ) {
      best = { x: p.x, y: p.y, pointType: p.pointType, m, quality };
    }
  }
  return best;
}

// ─────────── 阶段网关（§4，竞品 exitStage/shopStage/beastStage L24560-24594）───────────
// 外部料（背包/BOSS 态/增益/buff_color）一律由 pilot 预解析进 ctx，网关只做纯布尔决策。

/**
 * 收场判据（竞品 exitStageWant L24560-24576）。按 team_type 分级 + 整场到点兜底。
 * @param {{teamType:number, pieceShop:boolean, boss30:boolean, beastsFull:boolean, serverMSTime:number, fightEndTime:number}} ctx
 * @returns {boolean}
 */
export function exitStageWant(ctx) {
  const tier =
    ctx.teamType === 0
      ? ctx.pieceShop
      : ctx.teamType === 1
        ? ctx.pieceShop && ctx.boss30
        : ctx.pieceShop && ctx.boss30 && ctx.beastsFull;
  return !!tier || Number(ctx.serverMSTime) >= Number(ctx.fightEndTime);
}

/**
 * 该去商店判据（竞品 shopStageWant L24577-24586）。
 * team_type==0 只看「距最近一次真到店」超节拍；否则避开台前 0~120s 禁店窗，再叠「开台后 120~180s 高光窗可加密」。
 * 单位：shopIntervalSec 已是**秒**（§8 driveShopIntervalSec=480），竞品源是 shop_interval(分)*60，此处不再乘 60。
 * @param {{teamType:number, sinceShopSec:number, shopIntervalSec:number, bossOpeningSoon:boolean, nearEndWindow:boolean}} ctx
 * @returns {boolean}
 */
export function shopStageWant(ctx) {
  const i = Number(ctx.shopIntervalSec) || 0;
  const since = Number(ctx.sinceShopSec) || 0;
  if (ctx.teamType === 0) return since > i;
  return !ctx.bossOpeningSoon && (since > i || (ctx.nearEndWindow && since > 120));
}

/**
 * 可安心抓百兽判据（竞品 beastStageWant L24587-24594）。
 * 新知识：buffMap 中 buff_color==5 的增益数 ≥ 3 才算“安心”（§4.3）。
 * @param {{teamType:number, pieceShop:boolean, allBossCleared:boolean, cureOk:boolean, bandageOk:boolean, sausageOk:boolean, color5Count:number, beastsNotFull:boolean, bossIn90sWindow:boolean}} ctx
 * @returns {boolean}
 */
export function beastStageWant(ctx) {
  if (!ctx.pieceShop) return false;
  if (ctx.teamType === 0) return true;
  return (
    ctx.allBossCleared &&
    ctx.cureOk &&
    ctx.bandageOk &&
    ctx.sausageOk &&
    Number(ctx.color5Count) >= 3 &&
    ctx.beastsNotFull &&
    !ctx.bossIn90sWindow
  );
}

/**
 * 选商店（竞品 marchShop L24840-24849）——**本次重写最直接的补丁点**：链尾兜底店必须过三连前置。
 * 前置任一不满足直接 null（暖机 63s 内不去 / 全店共享 3s 冷却 / 已在 161 不重派）。
 * @param {Array<{pos:{x:number,y:number}, time:number, sausage:number}>} shops time=秒（sausage=0 代“无香肠”）
 * @param {{serverMSTime:number, fightBeginTime:number, curPointType:number, preferNoSausage?:boolean, startPoint?:{x:number,y:number}}} ctx
 * @returns {{x:number,y:number}|null}
 */
export function pickShop(shops, ctx) {
  if (!Array.isArray(shops) || shops.length === 0) return null;
  if (!(Number(ctx.serverMSTime) >= Number(ctx.fightBeginTime) + 63000)) return null; // 前置①暖机
  if (shops.some((s) => Number(s.time) * 1000 + 3000 > Number(ctx.serverMSTime))) return null; // 前置②全店共享 3s 冷却
  if (ctx.curPointType === PAB_SHOP) return null; // 前置③已在店内
  const sp = ctx.startPoint || { x: 0, y: 0 };
  const d = (s) => dist(s.pos.x, s.pos.y, sp.x, sp.y);
  const list = shops.filter((s) => s && s.pos).slice();
  if (ctx.preferNoSausage) {
    list.sort((a, b) => Number(a.sausage || 0) - Number(b.sausage || 0) || d(a) - d(b));
  } else {
    list.sort((a, b) => d(a) - d(b));
  }
  const chosen = list[0];
  return chosen ? { x: chosen.pos.x, y: chosen.pos.y } : null;
}
