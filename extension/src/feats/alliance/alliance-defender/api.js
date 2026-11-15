/**
 * 联盟保卫战 ACL 适配器：服务器点位 id → 世界坐标解码的唯一出口。
 * 符号知识收口：`GameTools.getWorldPosByServerPointId` 在 Script bundle 里是 **stub**
 *   （verbatim `function(e,t){return void 0===t&&(t=0),new cc.Vec2(0,0)}`，恒返 0,0），
 *   真身由 subpack2 CommonTools 的 takeOver 段运行时覆盖到同一对象上
 *   （`ne.default.getWorldPosByServerPointId=e.getWorldPosByServerPointId`，Morton 位解码，
 *   实证 243886→(346,476) 与实录 902(30) 目标逐键吻合）。
 * 判别口径：真身函数体含 `enabledNewMapSystem`（新旧图分支），stub 不含 →
 *   probe 只在真身在场时缓存模块对象；stub 期 resolve 回 null 不缓存，下拍自愈重试。
 *   函数每次调用现读（takeOver 是属性覆盖，缓存函数引用会钉死 stub）。
 * 合规：纯只读解码，不发包、不改写游戏数据；feat ACL 不 import net（dep-cruiser 红线）。
 */
import { game } from '../../../core/game.js';
import { createAcl } from '../../../core/acl-engine.js';

const { log, probe, SYM } = createAcl('ADPAPI');

/**
 * GameTools 模块对象（仅当真身解码函数在场时缓存）；stub 期/符号缺失返回 null。
 * @returns {object|null}
 */
function gameToolsReal() {
  return probe(SYM.modules.gameTools + '.worldPos', () => {
    var m = game.get(SYM.modules.gameTools);
    var T = (m && (m.default || m.GameTools || m)) || null;
    var fn = T && T.getWorldPosByServerPointId;
    // stub 判别：真身含新旧图分支标记 enabledNewMapSystem；stub 恒返 cc.Vec2(0,0) 不可用
    if (typeof fn !== 'function' || String(fn).indexOf('enabledNewMapSystem') < 0) return null;
    return T;
  });
}

export const defenderApi = {
  /**
   * 服务器点位 id → 世界地图坐标（Morton 位解码，单参调用与游戏侧同口径，subMap 缺省 0）。
   * 真身未接管（stub）/符号缺失/解码抛错/非正坐标一律回 null（调用方据此跳过派兵，下拍自愈）。
   * @param {number} pid 服务器点位 id（841/11104 的 alMonsterSiege.targetId）
   * @returns {{x:number,y:number}|null}
   */
  decodePointId(pid) {
    var id = Number(pid);
    if (!(id > 0)) return null;
    var T = gameToolsReal();
    if (!T) return null;
    try {
      // 函数现读不缓存：takeOver 是属性覆盖，缓存引用会钉死 stub
      var p = T.getWorldPosByServerPointId(id);
      var x = Number(p && p.x);
      var y = Number(p && p.y);
      if (x > 0 && y > 0) return { x: x, y: y };
      log.debug('decodePointId got non-positive pos. pid=%d x=%s y=%s', id, x, y);
      return null;
    } catch (e) {
      log.warn('decodePointId threw. pid=%d', id, e);
      return null;
    }
  },
};
