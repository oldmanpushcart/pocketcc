/**
 * feats/activity/cs-hunt/scenes/pick-skill.js —— 「奇妙新科技」(pickSkill, eventSpecId 1004xx) 场景执行。
 *
 * 交互（用户口径 + §9.2 + 借鉴竞对 eventPickSkill/skillPrioritys）：本场景 `eventPickSkillInfo.skillSpecIdList` 是若干候选科技，玩家选一个入背包。
 *   1. **③ 回合剪枝**：先知(specId9)/幸运(specId18) 若「背包持有 + 当前回合 ≥ ROUND_MAX(10)」——剩余回合已消化不完，本回合既不作命中候选、也不因缺它而逼刷新；
 *   2. **④ top-2 刷新**：按 cfg.skillPool 优先级取前 2 族（剔被③剪枝者），若候选里凑不进任一 top-2 族且背包有全量刷新(23，仅本场景可用）→ `7551{23}` 重洗候选（≤ 2 次）再回下一拍重判；
 *   3. 刷新不可用/刷满 2 次仍无 top-2 → 按池取第一个未排除命中位；再无则**两级兜底**（#6）：先在未排除（未被③剪枝/非 helper 排除）位里随机一位，
 *      仅当候选**全被排除**（池空/全剪）时才迫于「不留空」从全量位随机取一个（此时可能选中刚被剪者，但白给一个科技优于什么都不选）。全员发（陪跑也能拿科技）。
 *
 * 控制权：由 engine-flow.js 分派命中本模块，只吃注入的 ctx（背包/刷新次数计数/幂等闸由 ctx 提供）。
 */
import { bits } from '../../../../core/game-api.js';
import {
  REQ_EVENT_PICK_SKILL,
  SKILL_REFRESH,
  HELPER_EXCLUDE_SKILLS,
  SKILL_PROPHET,
  SKILL_LUCKY,
  ROUND_MAX,
} from '../constants.js';
import { chooseByPool, skillGroupRep } from '../skills.js';

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
  var exclude = ctx.isMain() ? [] : HELPER_EXCLUDE_SKILLS.slice();
  // ③ 先知/幸运按「持有 + 回合」剪枝（借鉴竞对 skillPrioritys）：剩余回合不够消化就不再选它们（既不成命中位、也不逼 top-2 刷新）。
  //   需背包张数→先保背包落地（ensureBackpack 幂等缓存，未就绪时 count=0、自然退化为不剪枝）。
  await ctx.ensureBackpack();
  if (ctx.backpackCount(SKILL_PROPHET) + ctx.round >= ROUND_MAX) exclude.push(SKILL_PROPHET);
  if (ctx.backpackCount(SKILL_LUCKY) + ctx.round >= ROUND_MAX) exclude.push(SKILL_LUCKY);
  var pool = Array.isArray(ctx.cfg.skillPool) ? ctx.cfg.skillPool : [];
  // top-2 优先族代表 id（剔除被③剪枝的族——它们已不可选，不应因缺它而白刷）；池不足 2 族则有几个取几个。
  var topReps = [];
  for (var t = 0; t < pool.length && topReps.length < 2; t++) {
    var rep = skillGroupRep(pool[t]);
    if (exclude.indexOf(rep) >= 0 || topReps.indexOf(rep) >= 0) continue;
    topReps.push(rep);
  }
  // ④ 候选里是否存在未被排除、且归族命中 top-2 的位（借鉴竞对 eventPickSkill hasTopTwo）。
  var hasTop2 = false;
  if (topReps.length) {
    for (var c = 0; c < candidates.length; c++) {
      if (exclude.indexOf(candidates[c]) >= 0) continue;
      if (topReps.indexOf(skillGroupRep(candidates[c])) >= 0) {
        hasTop2 = true;
        break;
      }
    }
  }
  // 无 top-2 且可刷新（本回合刷新 <2）→ 重洗候选、下一拍重判（刷后无论有无 top-2 都会走下方择位/兜底）。
  if (
    topReps.length &&
    !hasTop2 &&
    ctx.canUse(SKILL_REFRESH) &&
    ctx.canPhase(SKILL_REFRESH) &&
    ctx.refreshCount(ctx.round) < 2
  ) {
    ctx.bumpRefresh(ctx.round);
    await ctx.useSkill(SKILL_REFRESH, '刷新科技');
    ctx.invalidateBackpack();
    return;
  }
  // 择位：按池优先级取第一个未排除命中位；无命中走**两级兜底**（#6，不留空）：
  //   一级：从「未排除」（未被③剪枝且非 helper 排除）候选位里随机取一位；
  //   二级：候选全被排除时（池空/全剪），迫于不留空从全量候选随机取一位（可能选中刚被剪的科技，但优于什么都不选）。
  var pos = chooseByPool(pool, candidates, exclude);
  if (pos === 0) {
    var slots = [];
    for (var i = 0; i < candidates.length; i++)
      if (exclude.indexOf(candidates[i]) < 0) slots.push(i + 1);
    pos = slots.length
      ? slots[Math.floor(Math.random() * slots.length)] // 一级：优先未排除位
      : 1 + Math.floor(Math.random() * candidates.length); // 二级：全被排除，不留空
  }
  ctx.markDone(key);
  await ctx.sendPB(
    REQ_EVENT_PICK_SKILL,
    { treasureId: bits.int64(ctx.treasureId), round: ctx.round, pos: pos },
    '选科技',
  );
  ctx.invalidateBackpack(); // 新选科技入包，背包缓存作废
}
