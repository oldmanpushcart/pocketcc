/**
 * feats/activity/cs-hunt/scenes/roll-dice.js —— 「这次我最大」(rollDice, eventSpecId 1002xx) 场景执行。
 *
 * 交互（§9.4 报文）：掷骰 `7535 {treasureId, round}`；放弃 `7536` 四趟皆 0，故恒掷、不实现。
 * 幸运：掷骰中奖奖励 `eventRollDiceInfo.winRewardResult`（实证 20261018T105933：该字段在触发掷骰的同一 21376 push 里即明文可见），
 *   其 items ∩ cfg.luckyRewards.rollDice（本场景勾选集，空则不参与幸运判定）→ 动作前先 7551 用幸运(18)。仅主跑发（陪跑无奖励）。
 *
 * **幸运必须先于掷骰**（实证 20261018T105933 round6：手投在掷骰后 4s 用即对本次失效）：同一 tick 内串行 await 完成
 *   `tryLucky(→7551{18})→7535`，天然保证幸运在掷骰之前。持有态新鲜度由引擎 `#useSkill` 从 7551 应答内嵌 skillBackpack 回写保证
 *   （借鉴竞对），故此处**不再掷骰前强拉 7550**；`#tryLucky` 内部 `ensureBackpack()` 仅在从未落地时补拉一次。
 *
 * **幂等（借鉴竞对服务端态判断）**：除本地 `:dice` 记账外，先看 `eventRollDiceInfo.memberList` 里我方 `rollNum>0`（服务端权威“已掷”），
 *   抗引擎重启/推送重放导致的误重掷；本地记账桥接 `sendPB(7535)` 到服务器回推之间窗口内的重复 tick。
 *
 * 控制权：由 engine-flow.js 分派命中本模块，只吃注入的 ctx（不反向 import 引擎）。
 */
import { bits } from '../../../../core/game-api.js';
import { REQ_EVENT_ROLL_DICE } from '../constants.js';

/**
 * 场景执行入口。
 * @param {object} ctx engine-flow 注入的运行上下文
 * @returns {Promise<void>}
 */
export async function handle(ctx) {
  if (!ctx.isMain()) return; // 陪跑无奖励，不发 7535
  var rdi = ctx.ei.eventRollDiceInfo;
  if (!rdi) return;
  var key = ctx.round + ':dice';
  // 双保险幂等：① 服务端权威——本回合我方 rollNum>0 即已掷（抗引擎重启/推送重放）；② 本地 :dice 记账（桥接 sendPB 到服务器回推之间窗口的重复 tick）。任一命中即记账返回
  if (ctx.done(key) || ctx.alreadyRolled()) {
    ctx.markDone(key);
    return;
  }
  ctx.markDone(key);
  // 幸运必须先于掷骰：命中已勾池且持有幸运则先 7551{18}、再 7535（tryLucky 内部按需 ensureBackpack 取持有态，新鲜度由 #useSkill 内嵌回写保证）
  var luckyUsed = await ctx.tryLucky('rollDice', rdi.winRewardResult, 'roll-dice-reward');
  // 未命中白名单但已溢出（持有>本回合后剩余窗）时同样提前烧一张（用户口径 2026-10-25，见 engine #tryLuckyOverflow）
  if (!luckyUsed && ctx.tryLuckyOverflow) await ctx.tryLuckyOverflow(ctx.round, 'roll-dice-reward');
  await ctx.sendPB(
    REQ_EVENT_ROLL_DICE,
    { treasureId: bits.int64(ctx.treasureId), round: ctx.round },
    'roll-dice',
  );
}
