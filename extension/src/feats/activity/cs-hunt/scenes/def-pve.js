/**
 * feats/activity/cs-hunt/scenes/def-pve.js —— 「最后幸存者」(defPVE, eventSpecId 1005xx/4005xx) 场景执行。
 *
 * 交互：怪物 PVE 自动战斗（marchType CROSS_TREASURE_EVENT_PVE），**无玩家写动作**——保命由 21383 真人来袭分支
 *   承载（见 engine-flow `#autoStrategies`）。幸运降临也不在本场景用（用户口径 2026-10-17：幸运只服务 rollDice，
 *   见 engine-flow `#tryLucky`）。本模块保留为无动作占位，只为维持六族分派表完整、便于后续扩展。
 *
 * 控制权：由 engine-flow.js 分派命中本模块，只吃注入的 ctx。
 */

/**
 * 场景执行入口（无动作占位）。
 * @param {object} ctx engine-flow 注入的运行上下文（本期未用）
 * @returns {Promise<void>}
 */
export async function handle(ctx) {
  void ctx; // defPVE 无玩家写动作，且幸运不在此场景使用
}
