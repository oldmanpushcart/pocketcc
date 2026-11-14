/**
 * 901 视口查询自适应降频（四-1：纯判据层，离线可测）。
 *
 * 动机（24 场交叉验证实证）：整场 901 查询 900~1075 次，其中大量落在「引擎根本不做选点决策」
 *   的拍上——WORK 驻留等结算、BOSS 开台读秒让路、日常链全空无候选。这些拍每 3s 一刀视口
 *   纯属烧查询：降频到 driveViewIdleMs(12s) 可省约 2/3 的空转查询，决策拍仍保 driveViewMs(3s)。
 *
 * 三条纪律：
 *   • 降频只放宽「新鲜闸」（距上刀多久内不重拉），不改查询中心/载荷/降级口径；
 *   • WORK empty 相位**不降频**：B4 离站判空靠现拉视口，降频会把真空井白等到 45s 天花板；
 *   • kick 立即恢复：外部事件唤醒（威胁/到达/BOSS 态/拒码…）经引擎 #viewKick 位绕过降频闸，
 *     下一刀按 3s 口径走（本模块的 forced 入参）。
 *
 * 分层口径：不读 tuning/env/时钟，事实由调用方喂入；副作用（发包/记账）归 pilot.#awaitView。
 */

/**
 * 本拍是否处于「不做选点决策」的空闲态（可降频）。
 * @param {object} f 事实包：
 *   workMode WORK 相位（''=不在 WORK；'empty' 判空中不降频，其余驻留档降频）；
 *   bossFeeding 任一 BOSS state23（开台读秒让路拍）；teamType tuning.driveTeamType；
 *   idleSince 无候选静默起点（>0=上一拍梯全空/探索中，本轮大概率仍无候选）
 * @returns {boolean}
 */
export function viewIdleNow(f) {
  if (f.workMode && f.workMode !== 'empty') return true; // WORK 驻留：到点引擎干活，不选点
  if (f.bossFeeding && f.teamType > 0) return true; // bossWait 让路拍（与 plans bossWait.when 同口径）
  return f.idleSince > 0; // 无候选静默期
}

/**
 * 本刀 901 的新鲜闸窗口（距上刀 #viewAt 多久内跳过重拉）。
 * @param {object} t tuning 事实 {driveViewMs,driveViewIdleMs}
 * @param {boolean} idle viewIdleNow 结果
 * @param {boolean} forced kick 唤醒位（外部事件刚踢过 → 立即恢复常规口径）
 * @returns {number} 毫秒
 */
export function viewWaitMs(t, idle, forced) {
  const base = Number(t.driveViewMs) || 3000;
  if (!idle || forced) return base;
  return Math.max(base, Number(t.driveViewIdleMs) || 12000);
}

/**
 * 窄筛料源新鲜度窗口（#viewPointsFresh 用）：必须盖得住降频后的最老快照，
 *   否则空闲期一放宽查询间隔、窄筛就全空回 null，把「省查询」变成「不选点」。
 *   取 max(常规×3, 在途过滤同尺, 降频间隔+一刀常规余量)。
 * @param {object} t tuning 事实 {driveViewMs,driveViewIdleMs,driveMarchStaleMs}
 * @returns {number} 毫秒
 */
export function viewFreshWinMs(t) {
  const base = Number(t.driveViewMs) || 3000;
  const idle = Math.max(base, Number(t.driveViewIdleMs) || 12000);
  return Math.max(base * 3, Number(t.driveMarchStaleMs) || 15000, idle + base);
}
