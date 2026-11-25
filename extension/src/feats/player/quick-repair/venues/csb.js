/**
 * 战场抢修车间（跨服天梯赛医院）场地适配器：1427 批量修理 + 1428/815 加速。
 *
 * 该场地只收雷神（普通雷神 + 超级雷神），修理范围 = 面板 repairCsb（类型码 2/3/5/6/8/9）；
 * 赛事窗口由 index.js 的 csbGate 判定（FunctionOn + HospitalEndTime），关闭时不发 1426、本场地整轮静默。
 * 队列粒度 = 单条伤兵（1426 id），加速方式单键 speedCsb（无普通/雷神分档）。
 * 关闸前（deadline 进入阈值）由 index.js 把本场地排到决策顺序最前，先加速再修其它场地。
 */
import { CMD_ARMY_CROSS_HEAL, CMD_ITEM_USE, CMD_SPEEDUP_CROSS_GOLD } from '../constants.js';
import { estimateGold } from '../model/cost.js';
import { KIND } from '../model/kinds.js';
import { repairIncludes, speedModeFor } from '../model/schema.js';
import { goldShortReason, itemSpeedParam, takeItem } from './shared.js';

/**
 * 战场抢修车间一轮决策（修理 + 加速，累加进调用方容器）。
 * @param {object} snap 快照（csbWait / csbRepair / csbSkipped）
 * @param {object} cfg 归一后的模块配置
 * @param {object} budget 共享预算
 * @param {Array} actions 累加容器
 * @param {Array} reasons 累加容器
 */
export function planCsb(snap, cfg, budget, actions, reasons) {
  if (snap.csbSkipped) {
    // 门控关闭/不可判定跳过 1426：与「读了但无待修」区分开，供静默期归因
    reasons.push('csb: gate closed (1426 skipped)');
    return;
  }
  planCsbHeal(snap, cfg, actions, reasons);
  planCsbSpeed(snap, cfg, budget, actions, reasons);
}

/** 修理：选中类型的 state0 队列合并一笔 1427（去重令牌 id#army#et）。 */
function planCsbHeal(snap, cfg, actions, reasons) {
  const wait = snap.csbWait || [];
  if (!wait.length) {
    reasons.push('csb: no wait');
    return;
  }
  const picked = wait.filter((e) => repairIncludes(cfg, 'csb', e.arm, e.tier));
  if (!picked.length) {
    reasons.push('csb: wait exists but no selected class');
    return;
  }
  const ids = picked.map((e) => e.id);
  actions.push({
    kind: KIND.HEAL_CSB,
    cmd: CMD_ARMY_CROSS_HEAL,
    body: { ids },
    fp: KIND.HEAL_CSB,
    ids,
    dedup: picked.map((e) => e.key),
    label: 'csb heal ' + ids.length + '/' + wait.length,
  });
}

/** 加速：全部 state1 队列一笔（1428 全量 / 815 跨服 param="1|0"）。 */
function planCsbSpeed(snap, cfg, budget, actions, reasons) {
  const all = snap.csbRepair || [];
  if (!all.length) {
    reasons.push('csb: nothing under repair');
    return;
  }
  let leftTotal = 0;
  for (const e of all) if (e.left > 0) leftTotal += e.left;
  if (!(leftTotal > 0)) {
    reasons.push('csb: nothing under repair');
    return;
  }
  const mode = speedModeFor(cfg, 'csb', 'thor');
  if (mode === 'none') {
    reasons.push('csb: speed none');
    return;
  }
  const ids = all.map((e) => e.id);
  if (mode === 'gold') {
    const cc = estimateGold(leftTotal, snap.ratePerMin);
    if (!cc) {
      reasons.push('csb: gold estimate unavailable (rate ' + snap.ratePerMin + ')');
    } else if (budget.gold < cc) {
      reasons.push(goldShortReason(budget.gold, cc, 'csb'));
    } else {
      budget.gold -= cc;
      actions.push({
        kind: KIND.SPEED_GOLD_CSB,
        cmd: CMD_SPEEDUP_CROSS_GOLD,
        body: {},
        fp: KIND.SPEED_GOLD_CSB,
        all: true,
        pendingTokens: ids,
        goldCost: cc,
        label: 'gold speed csb (leftSec ' + leftTotal + ')',
      });
    }
    return;
  }
  const t = takeItem(budget.h, leftTotal);
  if (t.err) {
    reasons.push(t.err);
    return;
  }
  actions.push({
    kind: KIND.SPEED_ITEM_CSB,
    cmd: CMD_ITEM_USE,
    body: { itemid: t.si.itemId, amount: t.num, param: itemSpeedParam(true, null, -1) },
    fp: KIND.SPEED_ITEM_CSB,
    all: true,
    pendingTokens: ids,
    label:
      'item speed csb #' +
      t.si.itemId +
      ' x' +
      t.num +
      ' (held ' +
      t.si.amount +
      '; leftSec ' +
      leftTotal +
      ')',
  });
}
