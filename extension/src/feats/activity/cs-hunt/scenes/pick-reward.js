/**
 * feats/activity/cs-hunt/scenes/pick-reward.js —— 「先下手为强」(pickReward, eventSpecId 1001xx) 场景执行。
 *
 * 交互（用户口径 + §9.4 报文）：**随机点 5 宝箱之一**（各期待遇揭示不全，无固定择优依据），发
 *   `7534 {treasureId, round, pos}`（pos 1-based）。幸运降临不在本场景常规用（用户口径 2026-10-17：幸运只服务 rollDice，
 *   见 engine-flow `#tryLucky`）；**例外（用户口径 2026-10-25）：溢出提前消耗**——持有幸运>本回合后剩余回合数时，
 *   点宝箱前先 tryLuckyOverflow 烧一张翻倍本次奖励（实证 20261025T110353 第三跑 r9 持2张非 rollDice，只能手动）。
 *   仅主跑发（陪跑无奖励）。
 *
 * 控制权：由 engine-flow.js 分派命中本模块，只吃注入的 ctx（不反向 import 引擎）。
 */
import { bits } from '../../../../core/game-api.js';
import { REQ_EVENT_PICK_REWARD } from '../constants.js';

export { handle };

/**
 * 场景执行入口。
 * @param {object} ctx engine-flow 注入的运行上下文
 * @returns {Promise<void>}
 */
async function handle(ctx) {
  if (!ctx.isMain()) return; // 陪跑无奖励，不发 7534
  var key = ctx.round + ':reward';
  if (ctx.done(key)) return;
  var pri = ctx.ei.eventPickRewardInfo;
  if (!pri) return;
  ctx.markDone(key);
  // 溢出提前消耗必须先于选宝（幸运对「下一次奖励」生效，点完再翻已迟）；未溢出/不可用时无害返回
  if (ctx.tryLuckyOverflow) await ctx.tryLuckyOverflow(ctx.round, '先手奖励');
  var pos = 1 + Math.floor(Math.random() * 5); // 随机点宝箱（1..5）
  await ctx.sendPB(
    REQ_EVENT_PICK_REWARD,
    { treasureId: bits.int64(ctx.treasureId), round: ctx.round, pos: pos },
    '先手选奖励',
  );
}
