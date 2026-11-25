/**
 * 无双修理厂（NewCAB / TM / Master / Legend 四模式）场地适配器：6311 批量修理 + 6312 钻石/道具加速。
 *
 * 无双修理**免费**（不耗材料、无免费额度概念），所以修理只看 repairAva 的类型码集合；
 * 加速方式按类型档 speedAvaNormal / speedAvaThor（钻石倍率随模式取 DATACONFIG，见 index.js）。
 * 队列 id 即部队 uuid，可按 `getArmyByArmyUuid` 分类——修理按类型档合并（全选一笔、部分选择按档分批），
 * 加速按「方式 × 类型档」分批（6312 body 带 ids，天然支持子集，无需逐队列点名）。
 * 去重与本地/跨服同构：修理用 state0 plain id（aw 族）、加速用 state1 plain id（ar 族）；
 * 道具动作 atomic=true：道具枚数按该批 Σleft 池级折算、不可拆子集，任一在途即整批跳过。
 */
import { estimateAvaGold } from '../model/cost.js';
import { isThorBand, sumLeft } from '../model/entries.js';
import { KIND } from '../model/kinds.js';
import { repairIncludes, cellSpeedMode } from '../model/schema.js';
import { goldShortReason, takeItem } from './shared.js';

/**
 * 无双场地一轮决策（修理 + 加速，累加进调用方容器）。
 * @param {object} snap 快照（avaReadOk / avaWait / avaRepair / avaMode / ratePerMin / avaGoldMult）
 * @param {object} cfg 归一后的模块配置
 * @param {{cure:number, speed:number}} cmds 当前模式的 cure/speed 命令号
 * @param {object} budget 共享预算
 * @param {Array} actions 累加容器
 * @param {Array} reasons 累加容器
 */
export function planAva(snap, cfg, cmds, budget, actions, reasons) {
  if (!cmds) return;
  if (!snap.avaReadOk) {
    reasons.push('ava: hospital read failed (' + snap.avaMode + ')');
    return;
  }
  planAvaHeal(snap, cfg, cmds, actions, reasons);
  planAvaSpeed(snap, cfg, cmds, budget, actions, reasons);
}

/**
 * 修理：选中类型的 state0 队列——全选一笔；部分选择按类型档（普通/雷神）分批。
 */
function planAvaHeal(snap, cfg, cmds, actions, reasons) {
  const wait = snap.avaWait || [];
  if (!wait.length) {
    reasons.push('ava: no wait');
    return;
  }
  const picked = wait.filter((e) => repairIncludes(cfg, 'ava', e.arm, e.tier));
  if (!picked.length) {
    reasons.push('ava: wait exists but no selected class');
    return;
  }
  if (picked.length === wait.length) {
    pushHeal(snap, cmds, KIND.HEAL_AVA, picked, 'all', actions);
    return;
  }
  for (const band of ['normal', 'thor']) {
    const group = picked.filter((e) => isThorBand(e.tier) === (band === 'thor'));
    if (!group.length) continue;
    pushHeal(
      snap,
      cmds,
      band === 'thor' ? KIND.HEAL_AVA_THOR : KIND.HEAL_AVA,
      group,
      band,
      actions,
    );
  }
}

/** @param {object} snap @param {object} cmds @param {string} kind @param {Array} group @param {string} tag */
function pushHeal(snap, cmds, kind, group, tag, actions) {
  const ids = group.map((e) => e.id);
  if (!ids.length) return;
  actions.push({
    kind,
    cmd: cmds.cure,
    body: { ids },
    fp: kind,
    ids,
    dedup: ids,
    label: 'ava heal(' + snap.avaMode + ' ' + tag + ') ' + ids.length,
  });
}

/**
 * 加速：state1 队列按类型档取方式，按「方式」分批（同方式不同档可合并一笔）。
 */
function planAvaSpeed(snap, cfg, cmds, budget, actions, reasons) {
  const all = snap.avaRepair || [];
  if (!all.length) {
    reasons.push('ava: nothing under repair');
    return;
  }
  const active = all
    .filter((e) => e.left > 0)
    .map((e) => ({
      id: e.id,
      left: e.left,
      tier: e.tier,
      mode: cellSpeedMode(cfg, 'ava', e.arm, e.tier),
    }));
  if (!active.length) {
    reasons.push('ava: nothing under repair');
    return;
  }
  let offCount = 0;
  for (const mode of ['gold', 'item']) {
    const group = active.filter((e) => e.mode === mode);
    if (!group.length) continue;
    const ids = group.map((e) => e.id);
    const tag = group.every((e) => isThorBand(e.tier)) ? 'thor' : '';
    planAvaSpeedOne(snap, cmds, mode, ids, sumLeft(group), tag, budget, actions, reasons);
  }
  for (const e of active) if (e.mode === 'none') offCount++;
  if (offCount) reasons.push('ava: ' + offCount + ' queue(s) speed none');
}

/**
 * 无双单批加速：6312 钻石 {ids,useGold:1} / 道具 {ids,itemId,num,useGold:0}。
 * kind 后缀仅雷神档带（'-thor'；普通档/混合批沿用主 kind，与 FP_FAMILY/prune 族口径一致）。
 * @param {object} snap 快照
 * @param {{cure:number, speed:number}} cmds 模式命令号
 * @param {'gold'|'item'} mode 加速方式
 * @param {string[]} ids 该批 state1 活跃 id 集
 * @param {number} leftSec 该批剩余秒和
 * @param {''|'thor'} tag 档标（仅影响 kind 后缀与日志）
 * @param {object} budget 共享预算
 * @param {Array} actions 累加容器
 * @param {Array} reasons 累加容器
 */
function planAvaSpeedOne(snap, cmds, mode, ids, leftSec, tag, budget, actions, reasons) {
  if (!ids.length || !(leftSec > 0)) return;
  const suffix = tag === 'thor' ? '-thor' : '';
  if (mode === 'gold') {
    const gc = estimateAvaGold(leftSec, snap.ratePerMin, snap.avaGoldMult);
    if (!gc) {
      reasons.push('ava: gold estimate unavailable (rate ' + snap.ratePerMin + ')');
      return;
    }
    if (budget.gold < gc) {
      reasons.push(goldShortReason(budget.gold, gc, 'ava' + (tag ? ' ' + tag : '')));
      return;
    }
    budget.gold -= gc;
    actions.push({
      kind: KIND.SPEED_GOLD_AVA + suffix,
      cmd: cmds.speed,
      body: { ids, useGold: 1 },
      fp: KIND.SPEED_GOLD_AVA + suffix,
      ids,
      dedup: ids,
      goldCost: gc,
      label:
        'gold speed ava(' +
        snap.avaMode +
        (tag ? ' ' + tag : '') +
        ') ' +
        ids.length +
        ' (leftSec ' +
        leftSec +
        ')',
    });
    return;
  }
  const t = takeItem(budget.a, leftSec);
  if (t.err) {
    reasons.push(t.err);
    return;
  }
  actions.push({
    kind: KIND.SPEED_ITEM_AVA + suffix,
    cmd: cmds.speed,
    body: { ids, itemId: t.si.itemId, num: t.num, useGold: 0 },
    fp: KIND.SPEED_ITEM_AVA + suffix,
    ids,
    dedup: ids,
    // 道具枚数按该批 Σleft 池级折算、不可拆子集：任一在途即整批跳过（否则按整批 num 只加速部分队列→超烧非幂等道具）
    atomic: true,
    label:
      'item speed ava(' +
      snap.avaMode +
      (tag ? ' ' + tag : '') +
      ') #' +
      t.si.itemId +
      ' x' +
      t.num +
      ' (held ' +
      t.si.amount +
      ')',
  });
}
