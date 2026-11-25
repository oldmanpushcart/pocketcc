/**
 * 动作 kind 常量与在途族映射（index.js 与 venues/* 共用，避免字符串漂移）。
 *
 * 族代号（FP_FAMILY）决定 prunePendingByExit 按哪个 state 的活跃集确认清除：
 *   lw=本地治疗（state0 令牌 id#orderId#endTime）、cw=跨服治疗（state0 id#army#et）、aw=无双治疗（state0 plain id）、
 *   lr=本地加速（state1 plain id）、cr=跨服加速（state1 plain id）、ar=无双加速（state1 plain id）。
 * 动作名沿用旧版（单测/日志/FP 令牌键的历史口径），场地前缀靠名字区分。
 */

/** @type {Object<string, string>} 动作 kind 枚举 */
export const KIND = {
  HEAL_BASE: 'heal-local',
  HEAL_CSB: 'heal-cross',
  HEAL_AVA: 'heal-ava',
  HEAL_AVA_THOR: 'heal-ava-thor',
  SPEED_GOLD_BASE: 'speed-gold-local',
  SPEED_ITEM_BASE: 'speed-item-local',
  SPEED_GOLD_CSB: 'speed-gold-cross',
  SPEED_ITEM_CSB: 'speed-item-cross',
  SPEED_GOLD_AVA: 'speed-gold-ava',
  SPEED_GOLD_AVA_THOR: 'speed-gold-ava-thor',
  SPEED_ITEM_AVA: 'speed-item-ava',
  SPEED_ITEM_AVA_THOR: 'speed-item-ava-thor',
};

/** @type {Object<string, string>} kind → 在途族代号 */
export const FP_FAMILY = {
  [KIND.HEAL_BASE]: 'lw',
  [KIND.HEAL_CSB]: 'cw',
  [KIND.HEAL_AVA]: 'aw',
  [KIND.HEAL_AVA_THOR]: 'aw',
  [KIND.SPEED_GOLD_BASE]: 'lr',
  [KIND.SPEED_ITEM_BASE]: 'lr',
  [KIND.SPEED_GOLD_CSB]: 'cr',
  [KIND.SPEED_ITEM_CSB]: 'cr',
  [KIND.SPEED_GOLD_AVA]: 'ar',
  [KIND.SPEED_GOLD_AVA_THOR]: 'ar',
  [KIND.SPEED_ITEM_AVA]: 'ar',
  [KIND.SPEED_ITEM_AVA_THOR]: 'ar',
};

/** @type {Set<string>} 道具线加速动作名（815/6312 应答即权威消耗确认） */
export const ITEM_SPEED_KINDS = new Set([
  KIND.SPEED_ITEM_BASE,
  KIND.SPEED_ITEM_CSB,
  KIND.SPEED_ITEM_AVA,
  KIND.SPEED_ITEM_AVA_THOR,
]);

/** @type {Object<string, true>} 成功后把服务器权威队列回灌本地（幻影消除）的动作 */
export const LOCAL_SYNC_KINDS = {
  [KIND.HEAL_BASE]: true,
  [KIND.SPEED_GOLD_BASE]: true,
};

/** @type {Object<string, true>} 治疗类动作（落地后触发同拍加速二次决策） */
export const HEAL_LANES = {
  [KIND.HEAL_BASE]: true,
  [KIND.HEAL_CSB]: true,
};
