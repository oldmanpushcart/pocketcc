/**
 * ACL 域切片 · 行军类型跨服漂移（core/acl/march.js）
 * 原 core/game-api.js 的行军类型区段，按域拆分片6逐字迁出（行为零变化）。
 * crossUtils 判定器随本域导出，供 core/acl/world.js 的 crossFlag/tmServerType 复用（同目录 import，不成环）。
 */
import { game } from '../game.js';
import { createLog } from '../log.js';
import { SYM, probe, ns } from '../acl-engine.js';

/** @type {ReturnType<createLog>} 沿用拆分前 tag=GAMEAPI，日志口径零漂移 */
const log = createLog('GAMEAPI');

/** 游戏 MarchType 枚举对象（WorldMapCommon 为裸 CommonJS 导出，枚举在顶层，无 .default） */
function marchEnum() {
  return probe(SYM.modules.mapOldCommon + '.' + SYM.marchEnum.obj, () => {
    var m = game.get(SYM.modules.mapOldCommon);
    return (m && m[SYM.marchEnum.obj]) || null;
  });
}

/** 游戏 WorldMapEntityType 枚举对象（地块实体类型，同上在裸导出顶层） */
function entityEnum() {
  return probe(SYM.modules.mapOldCommon + '.' + SYM.entityEnum.obj, () => {
    var m = game.get(SYM.modules.mapOldCommon);
    return (m && m[SYM.entityEnum.obj]) || null;
  });
}

/** 跨服判定器（CrossUtils 静态方法，ES 包装下取 .default；随 tmServerType 变化，每次实时调用，不缓存结果） */
export function crossUtils() {
  return probe(SYM.modules.crossUtils, () => {
    var C = ns(game.get(SYM.modules.crossUtils));
    return C && typeof C.isTMServer === 'function' ? C : null;
  });
}

/** 新跨服战场（AVA）判定：NewCABController.default.Instance.isNewCABServer() */
function isNewCabServer() {
  try {
    var K = ns(game.get(SYM.modules.newCabCtrl));
    var I = K && (K.Instance || K.instance);
    return !!(I && typeof I.isNewCABServer === 'function' && I.isNewCABServer());
  } catch (e) {
    return false;
  }
}

/** 游戏原生换算器 WorldUtils.dealMarchTypeWithSpecialMarch（漂移表唯一真相源，在则优先用；ES 包装下取 .default） */
function worldMarchUtils() {
  return probe(SYM.modules.worldUtils + '.dealMarchTypeWithSpecialMarch', () => {
    var W = ns(game.get(SYM.modules.worldUtils));
    return W && typeof W.dealMarchTypeWithSpecialMarch === 'function' ? W : null;
  });
}

/**
 * 行军类型能力：把「本服基础 marchType」换算成「当前战场实际 marchType」。
 * 跨服战场（无双/王者/军团传奇/新跨服）下玩家城等目标的 marchType 与基础值不同，
 * 直接用基础值发 902 会被服务器拒；换算优先调游戏原生函数，游戏侧符号漂移时降级本地兜底。
 */
export const march = {
  /**
   * 枚举成员名 → 数值（运行时向游戏枚举对象取，取不到回 fallback）。
   * 对外供 feats 以游戏枚举为权威源取名值（如 quick-attack/imperial-decree 的世界 BOSS 行军类型），
   * resolve 内部换算亦经此。
   * @param {string} member SYM.marchEnum 里的成员名（如 'tmAttackPlayer'）
   * @param {number} fallback 游戏符号缺失时的兜底数值（可能过期，仅作降级）
   * @returns {number}
   */
  typeOf(member, fallback) {
    var E = marchEnum();
    var v = E && E[SYM.marchEnum[member]];
    return typeof v === 'number' && v > 0 ? v : fallback | 0;
  },
  /**
   * 地块实体类型是否 bossV2（世界 boss 二期，行军类型与普怪不同）。
   * @param {*} entityType tileInfo.type 原值
   * @returns {boolean}
   */
  isBossV2(entityType) {
    var E = entityEnum();
    return !!(E && entityType != null && entityType === E[SYM.entityEnum.bossV2]);
  },
  /**
   * 地块实体类型是否普通世界 boss（一期，行军类型 ATTACK_WORLDBOSS=14）。
   * 成员缺失（符号漂移）时恒 false——宁可回「无可攻打目标」也不猜服务器契约。
   * @param {*} entityType tileInfo.type / 901 pointType 原值
   * @returns {boolean}
   */
  isBoss(entityType) {
    var E = entityEnum();
    var v = E && E[SYM.entityEnum.boss];
    return !!(E && typeof v === 'number' && entityType != null && entityType === v);
  },
  /**
   * 基础 marchType → 当前战场实际 marchType（等价游戏 WorldUtils.getMarchTypeByBattleData 的换算分支）。
   * @param {number} base 基础 marchType（本服口径，如 ATTACK_PLAYER=13）
   * @param {{attackPlayer?:number, tm?:number, master?:number, ava?:number, teamLegend?:number}} fb
   *   游戏符号缺失时的本地兜底数值表（调用方传注册表常量，保证语义一致）
   * @returns {number} 换算结果；判定器全部不可用时原样返回 base（宁可少功能，不猜服务器契约）
   */
  resolve(base, fb) {
    base = base | 0;
    fb = fb || {};
    if (base !== this.typeOf('attackPlayer', fb.attackPlayer)) return base; // 仅攻玩家城参与漂移换算
    var W = worldMarchUtils();
    if (W) {
      try {
        // 游戏原生优先：服务器契约由游戏自己维护，改版自动跟随
        var v = W.dealMarchTypeWithSpecialMarch(base, {});
        if (v) return v | 0;
      } catch (e) {}
    }
    var C = crossUtils();
    if (isNewCabServer()) return this.typeOf('avaAttackPlayer', fb.ava);
    if (C) {
      if (C.isTMServer()) return this.typeOf('tmAttackPlayer', fb.tm);
      if (C.isMasterMatch()) return this.typeOf('masterAttackPlayer', fb.master);
      if (C.isTeamLegendServer()) return this.typeOf('teamLegendAttackPlayer', fb.teamLegend);
    }
    log.warn('march.resolve 降级：WorldUtils/CrossUtils 均不可用，按本服 marchType=%d 发送', base);
    return base;
  },
  /**
   * 战场判定器快照（仅诊断用，日志排查「漂移解析成了什么、凭什么」）。
   * @returns {object} {tm, master, teamLegend, ava, resolver} 判定器缺失记 null
   */
  flags() {
    var C = crossUtils();
    var o = { resolver: !!worldMarchUtils(), tm: null, master: null, teamLegend: null, ava: null };
    if (C) {
      try {
        o.tm = !!C.isTMServer();
        o.master = !!C.isMasterMatch();
        o.teamLegend = !!C.isTeamLegendServer();
      } catch (e) {}
    }
    o.ava = isNewCabServer();
    return o;
  },
};
