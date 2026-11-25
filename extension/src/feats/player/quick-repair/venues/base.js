/**
 * 基地修理厂（本地医院）场地适配器：220 批量修理 + 151/124 钻石加速 + 815 道具加速。
 *
 * 修理范围 = 面板 repairBase（类型码 1~9），逐队列按部队军种×类型过滤后**一笔 220 全发**：
 * 服务器内部先扣英雄免费额度、超出扣材料（材料按用户口径视为充足，不再做持有量预算）。
 * 加速范围 = 所有 state1 在修队列；方式按类型档 speedBaseNormal / speedBaseThor：
 *   全部在修队列方式一致 → 全量一笔（151 / 815 param=null，道具时间池不浪费）；
 *   普通档与雷神档方式不同 → 逐队列点名（124 钻石单条 / 815 param=队列 id），
 *   道具逐队列各自向上取整会多耗几枚，只在该场景付。
 * 钻石/道具预算与其它场地共享（budget.gold / budget.h）。
 */
import {
  CMD_ARMY_HEAL_LIST,
  CMD_ITEM_USE,
  CMD_ORDER_QUEUE_ING_DONE,
  CMD_ORDER_QUEUE_SPEED_UP,
} from '../constants.js';
import { estimateGold } from '../model/cost.js';
import { KIND } from '../model/kinds.js';
import { repairIncludes, speedModeFor } from '../model/schema.js';
import { goldShortReason, itemSpeedParam, takeItem } from './shared.js';

/**
 * 基地场地一轮决策（修理 + 加速，累加进调用方容器）。
 * @param {object} snap 快照（baseWait / baseRepair）
 * @param {object} cfg 归一后的模块配置
 * @param {object} budget 共享预算
 * @param {Array} actions 累加容器
 * @param {Array} reasons 累加容器
 */
export function planBase(snap, cfg, budget, actions, reasons) {
  planBaseHeal(snap, cfg, actions, reasons);
  planBaseSpeed(snap, cfg, budget, actions, reasons);
}

/**
 * 修理：选中类型的 state0 队列合并一笔 220（去重令牌 id#orderId#endTime 逐项登记）。
 */
function planBaseHeal(snap, cfg, actions, reasons) {
  const wait = snap.baseWait || [];
  if (!wait.length) {
    reasons.push('base: no wait');
    return;
  }
  const picked = wait.filter((e) => repairIncludes(cfg, 'base', e.arm, e.tier));
  if (!picked.length) {
    reasons.push('base: wait exists but no selected class');
    return;
  }
  const ids = picked.map((e) => e.id);
  actions.push({
    kind: KIND.HEAL_BASE,
    cmd: CMD_ARMY_HEAL_LIST,
    body: { ids },
    fp: KIND.HEAL_BASE,
    ids,
    dedup: picked.map((e) => e.key),
    label: 'base heal ' + ids.length + '/' + wait.length,
  });
}

/**
 * 加速：state1 队列按类型档取加速方式；同方式合并全量、异方式逐队列点名。
 */
function planBaseSpeed(snap, cfg, budget, actions, reasons) {
  const all = snap.baseRepair || [];
  if (!all.length) {
    reasons.push('base: nothing under repair');
    return;
  }
  let leftTotal = 0;
  for (const e of all) if (e.left > 0) leftTotal += e.left;
  if (!(leftTotal > 0)) {
    reasons.push('base: nothing under repair');
    return;
  }
  const active = all
    .filter((e) => e.left > 0)
    .map((e) => ({ id: e.id, left: e.left, mode: speedModeFor(cfg, 'base', e.tier) }));
  const modes = uniq(active.map((e) => e.mode));
  if (modes.length === 1) {
    planBaseWhole(all, active, modes[0], leftTotal, snap, budget, actions, reasons);
    return;
  }
  // 普通档/雷神档方式不同：逐队列点名（151/815 全量无法区分兵种，整发会把另一档也加速）
  let offCount = 0;
  for (const mode of ['gold', 'item']) {
    const group = active.filter((e) => e.mode === mode);
    if (!group.length) continue;
    planBasePerQueue(group, mode, snap, budget, actions, reasons);
  }
  for (const e of active) if (e.mode === 'none') offCount++;
  if (offCount) reasons.push('base: ' + offCount + ' queue(s) speed none');
}

/** @param {Array} list @returns {string[]} 去重保序 */
function uniq(list) {
  const out = [];
  for (const v of list) if (out.indexOf(v) < 0) out.push(v);
  return out;
}

/**
 * 全量加速一笔（该场地全部 state1 队列方式一致时）：151 钻石 / 815 道具 param=null。
 * pendingTokens 取全部 state1 id（含剩余 0 的过期槽，与权威读同集，避免漏登记导致第二枪）。
 */
function planBaseWhole(all, active, mode, leftTotal, snap, budget, actions, reasons) {
  if (mode === 'none') {
    reasons.push('base: speed none');
    return;
  }
  const ids = all.map((e) => e.id);
  if (mode === 'gold') {
    const lc = estimateGold(leftTotal, snap.ratePerMin);
    if (!lc) {
      reasons.push('base: gold estimate unavailable (rate ' + snap.ratePerMin + ')');
    } else if (budget.gold < lc) {
      reasons.push(goldShortReason(budget.gold, lc, 'base'));
    } else {
      budget.gold -= lc;
      actions.push({
        kind: KIND.SPEED_GOLD_BASE,
        cmd: CMD_ORDER_QUEUE_ING_DONE,
        body: {},
        fp: KIND.SPEED_GOLD_BASE,
        all: true,
        pendingTokens: ids,
        goldCost: lc,
        label: 'gold speed base (leftSec ' + leftTotal + ')',
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
    kind: KIND.SPEED_ITEM_BASE,
    cmd: CMD_ITEM_USE,
    body: { itemid: t.si.itemId, amount: t.num, param: itemSpeedParam(false, null, -1) },
    fp: KIND.SPEED_ITEM_BASE,
    all: true,
    pendingTokens: ids,
    label:
      'item speed base #' +
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

/**
 * 逐队列点名加速：124 钻石单条 {id,useGold:1} / 815 单条 param=队列 id。
 * 逐队列独立估价/折算，共享预算累计扣减；余额/道具不足的队列跳过（记 reason），不影响其余。
 * @param {Array<{id:string,left:number}>} group 同方式队列（已过滤 left>0）
 * @param {'gold'|'item'} mode 加速方式
 */
function planBasePerQueue(group, mode, snap, budget, actions, reasons) {
  for (const e of group) {
    if (mode === 'gold') {
      const gc = estimateGold(e.left, snap.ratePerMin);
      if (!gc) {
        reasons.push('base: gold estimate unavailable (rate ' + snap.ratePerMin + ')');
        return;
      }
      if (budget.gold < gc) {
        reasons.push(goldShortReason(budget.gold, gc, 'base queue ' + e.id));
        continue;
      }
      budget.gold -= gc;
      actions.push({
        kind: KIND.SPEED_GOLD_BASE,
        cmd: CMD_ORDER_QUEUE_SPEED_UP,
        body: { id: e.id, useGold: 1 },
        fp: KIND.SPEED_GOLD_BASE,
        dedup: [e.id],
        goldCost: gc,
        label: 'gold speed base queue ' + e.id + ' (leftSec ' + e.left + ')',
      });
      continue;
    }
    const t = takeItem(budget.h, e.left);
    if (t.err) {
      reasons.push(t.err);
      return;
    }
    actions.push({
      kind: KIND.SPEED_ITEM_BASE,
      cmd: CMD_ITEM_USE,
      body: { itemid: t.si.itemId, amount: t.num, param: itemSpeedParam(false, e.id) },
      fp: KIND.SPEED_ITEM_BASE,
      dedup: [e.id],
      label:
        'item speed base queue ' +
        e.id +
        ' #' +
        t.si.itemId +
        ' x' +
        t.num +
        ' (leftSec ' +
        e.left +
        ')',
    });
  }
}
