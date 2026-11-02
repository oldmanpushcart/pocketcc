/**
 * ACL 域切片 · Int64 装箱/读侧归一（core/acl/bits.js）
 * 原 core/game-api.js 的 bits 区段，按域拆分片2逐字迁出（行为零变化）。
 * 铁律：64 位 id 一律字符串读、不 Number 转换（精度丢失实证见方法注释）。
 */
import { game } from '../game.js';
import { SYM, probe } from '../acl-engine.js';

export const bits = {
  /**
   * 数字串 → Long64Bit.Int64（fromString）；非数字串按 Number 走 fromNumber，模块不可用回纯数字兜底。
   * @param {string|number} v 数值或数字串（如私聊 roomId=对端 uid）
   * @returns {*|number}
   */
  int64(v) {
    v = String(v == null ? '0' : v);
    var L = probe(SYM.modules.long64Bit + '.Int64', () => {
      var m = game.get(SYM.modules.long64Bit);
      return (m && m.Int64) || null;
    });
    if (!L) return /^\d+$/.test(v) ? Number(v) || 0 : 0;
    // probe 的 resolve 已返回 m.Int64（Int64 类本体 r），类上直接挂 fromString/fromNumber 静态方法；
    // 曾经多写一层 L.Int64.fromString → TypeError → catch return 0，导致所有大 id（19 位兽 id）
    // 装箱失败、服务器回 enigma_beast018「找不到对应异能兽信息，已失效」。
    try {
      return /^\d+$/.test(v) ? L.fromString(v) : L.fromNumber(Number(v) || 0);
    } catch (e) {
      return 0;
    }
  },

  /**
   * Int64 读侧归一：协议层的 Long 对象（{_low,_high,_unsigned}）/数字/字符串 → 十进制字符串。
   * 铁律：64 位 id 一律按字符串读与比较，不走 Number（>2^53 精度丢失，实证 dashcam 20261016T19xxxx
   *   的 treasureId/teamId/member.uid 均为原生 Long 对象，与控制器侧 19 位字符串是两套口径）。
   * 永不抛异常：null/undefined 回空串，其余取 String(v)。
   * @param {*} v Long 实例 / 数字 / 数字串
   * @returns {string} 十进制字符串（无值为空串）
   */
  int64Str(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    try {
      // Long 实例自带 toString/toNumber（unsigned 下返回无符号十进制串）
      if (typeof v.toString === 'function' && typeof v.toNumber === 'function') return v.toString();
      if (typeof v.toString === 'function') return String(v.toString());
    } catch (e) {}
    return String(v);
  },
};
