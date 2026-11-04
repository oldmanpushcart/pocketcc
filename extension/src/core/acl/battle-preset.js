/**
 * ACL 域切片 · 出征档案实时重算（core/acl/battle-preset.js）
 * 原 core/game-api.js 的 battlePreset 区段，按域拆分片4逐字迁出（行为零变化）。
 * 只改写调用方自建的 entry 副本，不触碰游戏数据（只读+调用红线）。
 */
import { createLog } from '../log.js';
import { marchStorage } from '../acl-engine.js';

/** @type {ReturnType<createLog>} 沿用拆分前 tag=GAMEAPI，日志口径零漂移 */
const log = createLog('GAMEAPI');

/**
 * 出征档案实时重算能力：把「每格能派多少兵」这件事交回游戏自己算。
 * 游戏侧公式（RealMarchStorageController.getMaxCoutByPos，实证）：
 *   普通格 = 1 + floor(add/cells) + (add % cells > pos ? 1 : 0)，
 *     add = Buff(BattleArmyAddNum=153) 全量聚合（城皮/VIP/科技等一律收敛于此）
 *         + HeroController.getMarchHeroArmyAdd(heroIds)（英雄统率×配置20006 + 技能 153 加成）
 *     cells = FunctionOn(monster_battle_replace) ? 按等级查 960600/960601 : 5
 *   补位格(pos=30) = 军阵 buff ReplenishArmyCount(useFormationV2Id=formationV2)
 * 之所以用它而不是自己套公式：加成因素（城皮技能、英雄技能、VIP、科技、活动…）穷举不完，
 * 而该路径不读 CurBattleData / myMaxArmysNum（这两个是战斗面板打开时才写的残留态），Home 场景同样准。
 */
export const battlePreset = {
  /** 重算能力是否可用（subpack2 已接管且方法在场） */
  ok() {
    return !!marchStorage();
  },
  /**
   * 让游戏重算一份出征档案的每格上阵数。**只改写传入的 entry（必须是自建副本）**，不触碰游戏数据。
   * entry 会被就地改写：armyInfo[].num 重写为实时值（num<=0 的条目被剔除）、heroIds 截断为可派遣名单、
   * 军阵在途名额用尽时 formationV2 打回 0、extraArmy 无补位容量时置 null。
   * @param {object} entry {armyInfo:[{armyId,num,pos,heroCap}], heroIds:[id], formationV2, extraArmy:{armyId,armyNum}|null}
   * @param {boolean} [checkMarch=true] true=按可派遣口径（兵不在外征战、英雄可派、军阵有剩余名额）
   * @returns {object|null} 改写后的 entry；符号缺失或游戏抛错返回 null（调用方自行降级）
   */
  recalc(entry, checkMarch) {
    var inst = marchStorage();
    if (!inst || !entry) return null;
    try {
      inst.checkPreMarchExtraList([entry], { checkMarch: checkMarch !== false });
      return entry;
    } catch (e) {
      log.warn(
        'battlePreset.recalc threw: expedition preset recalculator unavailable (symbol drift?); caller will use degraded path',
        e,
      );
      return null;
    }
  },
};
