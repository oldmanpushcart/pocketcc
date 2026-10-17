/**
 * feats/activity/cs-hunt/scenes/pick-skill.js —— 「奇妙新科技」(pickSkill, eventSpecId 1004xx) 场景执行。
 *
 * 交互（用户口径 + §9.2）：本场景 `eventPickSkillInfo.skillSpecIdList` 是若干候选科技，玩家选一个入背包。
 *   1. 按 cfg.skillPool（勾选+拖拽优先级）在候选里取第一个命中位 → 发 `7538 {treasureId, round, pos}`（pos 1-based）；
 *   2. 若无命中且背包有全量刷新(23，仅本场景可用）→ `7551{23}` 重洗候选后回下一拍重判（≤2 次，防死循环）；
 *   3. 再无（无刷新或刷满 2 次仍不命中）→ 随机选一位（不留空，白给一个科技）。全员发（陪跑也能拿科技）。
 *
 * 控制权：由 engine-flow.js 分派命中本模块，只吃注入的 ctx（背包/刷新次数计数/幂等闸由 ctx 提供）。
 */
import { bits } from '../../../../core/game-api.js';
import { REQ_EVENT_PICK_SKILL, SKILL_REFRESH, HELPER_EXCLUDE_SKILLS } from '../constants.js';
import { chooseByPool } from '../skills.js';

/**
 * 场景执行入口。
 * @param {object} ctx engine-flow 注入的运行上下文
 * @returns {Promise<void>}
 */
export async function handle(ctx) {
  var key = ctx.round + ':skill';
  if (ctx.done(key)) return;
  var psi = ctx.ei.eventPickSkillInfo;
  if (!psi || !Array.isArray(psi.skillSpecIdList) || !psi.skillSpecIdList.length) return;
  var candidates = psi.skillSpecIdList.map(Number);
  // 陪跑不选「只对领奖有意义」的科技（HELPER_EXCLUDE_SKILLS = 幸运降临18 + 安全锁定17）：两者一个翻倍奖励、一个保护奖励，
  //   而 rollDice/pickReward 两个领奖场景已对陪跑早退（不发 7534/7535）——陪跑选了纯属浪费科技槽位，
  //   故从「按池命中」与「随机兜底」双双排除（主跑不受影响，正常按池选）。
  var exclude = ctx.isMain() ? [] : HELPER_EXCLUDE_SKILLS;
  var pos = chooseByPool(ctx.cfg.skillPool, candidates, exclude);
  if (pos === 0) {
    await ctx.ensureBackpack();
    // 无命中 → 有刷新(23)且本回合刷新的次数 <2 则重洗候选、下一拍重判
    if (
      ctx.canUse(SKILL_REFRESH) &&
      ctx.canPhase(SKILL_REFRESH) &&
      ctx.refreshCount(ctx.round) < 2
    ) {
      ctx.bumpRefresh(ctx.round);
      await ctx.useSkill(SKILL_REFRESH, '刷新科技');
      ctx.invalidateBackpack();
      return;
    }
    // 兜底随机位（不留空）：只在「非排除位」里随机；排除后无候选（理论不可能）才退回全量随机
    var slots = [];
    for (var i = 0; i < candidates.length; i++)
      if (exclude.indexOf(candidates[i]) < 0) slots.push(i + 1);
    pos = slots.length
      ? slots[Math.floor(Math.random() * slots.length)]
      : 1 + Math.floor(Math.random() * candidates.length);
  }
  ctx.markDone(key);
  await ctx.sendPB(
    REQ_EVENT_PICK_SKILL,
    { treasureId: bits.int64(ctx.treasureId), round: ctx.round, pos: pos },
    '选科技',
  );
  ctx.invalidateBackpack(); // 新选科技入包，背包缓存作废
}
