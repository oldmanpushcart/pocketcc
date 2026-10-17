/**
 * feats/activity/cs-hunt/scenes/roll-dice.js —— 「这次我最大」(rollDice, eventSpecId 1002xx) 场景执行。
 *
 * 交互（§9.4 报文）：掷骰 `7535 {treasureId, round}`；放弃 `7536` 四趟皆 0，故恒掷、不实现。
 *   幸运：掷骰前 `eventRollDiceInfo.winRewardResult` 已明文可见（§7-7 实锤），其 items ∩ cfg.luckyRewards.rollDice
 *   （本场景勾选集，空则该场景不参与幸运判定）→ 动作前先 7551 用幸运(18)。仅主跑发（陪跑无奖励）。
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
  var key = ctx.round + ':dice';
  if (ctx.done(key)) return;
  var rdi = ctx.ei.eventRollDiceInfo;
  if (!rdi) return;
  ctx.markDone(key);
  await ctx.tryLucky('rollDice', rdi.winRewardResult, '掷骰奖励');
  await ctx.sendPB(
    REQ_EVENT_ROLL_DICE,
    { treasureId: bits.int64(ctx.treasureId), round: ctx.round },
    '掷骰',
  );
}
