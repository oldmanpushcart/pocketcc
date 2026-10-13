// 战斗过程回放事件语义解码 —— 纯函数模块（无 DB 依赖），风格对齐 buff-source.js。
//
// process[] 是游戏做"战斗回放"的权威时序流水，每条 {t, ...}。`t` 的取值来自游戏源码
// 枚举 NBattlePvPDataProcessType（references/游戏逆向/extracted/Script/NBattleCommon__NBattleCommon.js），
// 命中/闪避/暴击判定来自 PvPBattleController.pushAttack 对 NBattleDamageFlags 的映射，
// 元素类型来自 NBattleElementType。此处逐字转录这些枚举，供 parse.js 把事件语义结构化落列。
//
// 关键实证（本仓 8 份真实战报）：buff/技能类事件把 effect_buff id 放在 `val` 字段而非 `buffId`
// —— 共 3588 条（t=3 技能 1495、t=5 移除buff 1943、t=7 加buff 9、t=11 英雄加buff 38、t=25 部队加buff 103）。
// 旧解析只读 p.buffId，会整体漏掉这些增益/损益/控制状态（眩晕、沉默、虚弱等）。buffRefOf 统一按
// "字段优先、val 兜底"取出正确的 buff id。

/** NBattlePvPDataProcessType：process[].t → 事件类型名（源码逐字转录，含跳号）。 */
export const PROCESS_TYPE = {
  1: 'Enter',
  2: 'Attack',
  3: 'Skill',
  4: 'Round',
  5: 'RemoveSkillBuff',
  6: 'EnterHero',
  7: 'AddSkillBuff',
  8: 'MissAttack',
  9: 'LIFEBAR_RESET',
  10: 'HeroAttack',
  11: 'HeroAddBuff',
  12: 'HeroItemBuff',
  13: 'HeroGroundBuff',
  14: 'DebuffHurt',
  15: 'Heal',
  16: 'HERO_ROUND_SKILL',
  17: 'EnterUAV',
  18: 'HeroArmyStamp',
  19: 'BreakHeroEffect',
  20: 'HeroToHeroAddBuff',
  21: 'RemoveHeroAddBuff',
  22: 'UpdateHeroAddBuff',
  23: 'RemoveUAV',
  24: 'SkillAddPower',
  25: 'ArmyAddBuff',
  26: 'MechaAddBuffSpecialOne',
  27: 'MechaMainChipBuff',
  28: 'FormationRelenishEnterOut',
  29: 'FormationRelenish',
  30: 'Stage',
  31: 'IndexRound',
  32: 'ADDMUTIBUFFS',
  33: 'ARMYROUND',
  34: 'UPDATENUMBUFF',
  35: 'ROUND_CHANGE',
  36: 'ADD_BUFF_WITH_NUM',
  37: 'HeroEquipSkillBuff',
  999: 'GoDown',
  9000: 'INVALID_START',
};

/** t → 事件类型名；未知码如实标 UNKNOWN_<code>（新版本游戏可能扩枚举），null 透传。 */
export function kindOf(t) {
  if (t == null) return null;
  return PROCESS_TYPE[t] ?? `UNKNOWN_${t}`;
}

// NBattleDamageFlags: Hit=1, Miss=2, Crit=4（位掩码）。pushAttack 里的判定：
//   actType===1 → Miss，actType===3 → Crit，其余(含 0/2) → Hit。
/** attack 类事件的 actType → 命中结果 'miss'|'crit'|'hit'；非攻击(actType 缺省)返回 null。 */
export function outcomeOf(actType) {
  if (actType == null) return null;
  const n = Number(actType);
  if (n === 1) return 'miss';
  if (n === 3) return 'crit';
  return 'hit';
}

/** NBattleElementType：元素伤害类型（fire=1 火焰, light=2 光, elec=3 电）。 */
export const ELEMENT_TYPE = { 1: 'fire', 2: 'light', 3: 'elec' };
/** eType → 元素名；未知码标 UNKNOWN_<code>，null 透传。 */
export function elementName(eType) {
  if (eType == null) return null;
  return ELEMENT_TYPE[eType] ?? `UNKNOWN_${eType}`;
}

// 把 effect_buff id 承载在 `val` 字段的事件类型（增益/损益/控制状态多出自这里）。
// 依枚举命名（*AddBuff / RemoveBuff / ADD*BUFF / Skill 施加的 buff）判定，实测 t=3/5/7/11/25 全部命中。
// 注意：这些类型只在没有独立 buffId 字段时才回退取 val；t=2/14/32 的 buff id 走 buffId 字段。
const BUFF_ID_IN_VAL = new Set([3, 5, 7, 11, 12, 13, 20, 21, 22, 25, 26, 27, 34, 36, 37]);

/**
 * 取出一条 process 事件正确的 effect_buff id（若有）。
 * 优先显式 buffId 字段（攻击附带/DebuffHurt/多buff），否则对"buff 施加类"事件回退到 val。
 * @param {any} p process 事件对象
 * @returns {{ id: number|null, src: 'field'|'val'|null }}
 */
export function buffRefOf(p) {
  if (p == null) return { id: null, src: null };
  if (p.buffId != null) return { id: p.buffId, src: 'field' };
  if (BUFF_ID_IN_VAL.has(p.t) && p.val != null) return { id: p.val, src: 'val' };
  return { id: null, src: null };
}
