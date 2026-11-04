/**
 * feats/activity/cs-hunt/scenes/code-box.js —— 「密码大爆炸」(codeBox, eventSpecId 1003xx) 场景执行。
 *
 * 交互（源码 CSHuntEventCodeBox + §9.4 + 用户口径）：本端 `eventCodeBoxInfo.codeNum[5]` 只见自己那一层视图
 *   （每位 `0..9` 明文、`-1`=掩码），满编 5 人各见 1 位、余为掩码，游戏内无跨玩家聚合，**靠频道 17 聊天汇总**：
 *   1. 读本端视图 → `viewToStr` 广播到频道 17（每回合一次，engine 侧去重）；
 *   2. 收队友视图（engine `#peerViews`）→ `merge([本端, ...队友])` 得本回合汇总视图；
 *   3. 汇总视图全满（无未知位）→ 若本场景（codeBox）勾了幸运物品且 `eventCodeBoxInfo.winRewardResult`（EVENT 态 push 明文可见）
 *      命中，先 7551 用幸运(18) ×2，再发 `7537 {treasureId, round, codeNum[5]}`（穷举猜码阶段不占幸运），`ok` 记 done、`s≠0`（错）走 info 不 warn；
 *   4. 兜底：汇总仍有未知位且未知数 ≤2 → 等队友视图到齐或超时 15s 后 `solveCandidates` 穷举逐个提交（CODE_GAP 节流）；未知 >2 且未汇总满 →
 *      放弃本回合（留手动），不空耗打爆 60s 窗；
 *   5. `uidWinMap[我的uid]===true` 视为已中，停手。全员发（陪跑也能置 win）。
 *
 * 控制权：由 engine-flow.js 分派命中本模块，只吃注入的 ctx（视图编解码/背包/幂等闸均由 ctx 提供）。
 */
import { bits, gameData } from '../../../../core/game-api.js';
import { REQ_EVENT_CODE_BOX_UNLOCK } from '../constants.js';

/**
 * 场景执行入口。
 * @param {object} ctx engine-flow 注入的运行上下文
 * @returns {Promise<void>}
 */
export async function handle(ctx) {
  var cb = ctx.ei.eventCodeBoxInfo;
  if (!cb) return;
  var key = ctx.round + ':code';
  if (ctx.done(key)) return;
  var myUid = gameData.myUidStr();
  if (myUid && cb.uidWinMap && cb.uidWinMap[myUid] === true) {
    ctx.markDone(key); // 本端已解锁成功
    return;
  }
  var own = Array.isArray(cb.codeNum) ? cb.codeNum.map(Number) : [];
  // 1) 本端视图广播（engine 去重每回合一次）
  ctx.codeBox.broadcast(ctx.round, ctx.viewToStr(own));
  // 2) 汇总视图（本端 + 频道 17 收到的队友视图）
  var merged = ctx.codeBox.merged(ctx.round, own);
  var unknown = 0;
  for (var i = 0; i < merged.length; i++) if (Number(merged[i]) < 0) unknown++;
  // 未知 >2（组合 10^>2）且聊天未汇总满 → 放弃本回合，不空耗穷举
  if (unknown > 2) return;
  // 有未知位时等队友视图汇总（频道 17 广播回复约 1-2 个 EVENT_TICK 周期到达），最多等 15s 后转穷举
  if (unknown > 0) {
    var waitMs = ctx.codeBox.peerWaitMs(ctx.round);
    if (waitMs < 15000) return;
  }
  // 3/4) 取下一个未试候选（全满时即 merged 本身）逐次提交
  var tried = ctx.codeBox.tried(ctx.round);
  var pick = ctx.nextUntried(ctx.solveCandidates(merged), tried);
  if (!pick.cand) return;
  if (!ctx.codeBox.readyToSubmit()) return;
  ctx.codeBox.markSubmit();
  tried.add(pick.key);
  var ret = await ctx.sendPB(
    REQ_EVENT_CODE_BOX_UNLOCK,
    { treasureId: bits.int64(ctx.treasureId), round: ctx.round, codeNum: pick.cand },
    'submit-code',
  );
  if (ret.ok) {
    ctx.markDone(key);
    ctx.log.info('code-box hit (code=%s)', pick.key);
  } else {
    var head = ret && ret.payload && ret.payload.header;
    if (head && head.s) ctx.log.info('code-box wrong code s=%s (continue aggregating/brute-forcing)', head.s);
  }
}
