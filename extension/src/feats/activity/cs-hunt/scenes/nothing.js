/**
 * feats/activity/cs-hunt/scenes/nothing.js —— 「空冒一场险」(nothing, eventSpecId 1006xx/4006xx) 场景执行。
 *
 * 交互：源码 CSHuntEventNothing，本场景**无任何玩家写动作**（选到即空过，无 75xx 请求）。分派表命中本模块仅为
 *   保持六族映射完整、便于后续扩展；先知感知选场景时已把 6 nothing 排除在优先项外（见 engine-flow chooseProphet）。
 *
 * 控制权：由 engine-flow.js 分派命中本模块，只吃注入的 ctx。
 */

/**
 * 场景执行入口（无动作占位）。
 * @param {object} ctx engine-flow 注入的运行上下文（本期未用）
 * @returns {Promise<void>}
 */
export async function handle(ctx) {
  void ctx; // nothing 无玩家写动作
}
