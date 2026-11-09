/**
 * ACL 域切片 · Int64 装箱/读侧归一（core/acl/bits.js）
 * 原 core/game-api.js 的 bits 区段，按域拆分片2逐字迁出（行为零变化）。
 * 铁律：64 位 id 一律字符串读、不 Number 转换（精度丢失实证见方法注释）。时间戳量纲的读数值特例见 int64ToNum，严守 < 2^53。
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
   * 铁律：64 位 id 一律按字符串读与比较，不走 Number（>2^53 精度丢失，实录报文
   *   实证 treasureId/teamId/member.uid 均为原生 Long 对象，与控制器侧 19 位字符串是两套口径）。
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

  /**
   * Int64 → 稳定字符串键（同一 Long 恒得同一串，用于车队 id 去重/拉黑）；与 int64Str（十进制串）不同口径，本键不求可读、不求数值。
   * 雪花 id 绝不做有损 Number 转换，故裸对象取 high:low 组合，其余 String(v)。
   * @param {*} v Long 实例 / {_low,_high} / 数字 / 串
   * @returns {string} 无值回空串
   */
  int64Key(v) {
    if (v == null) return '';
    if (typeof v === 'object' && '_low' in v) return v._high + ':' + v._low;
    return String(v);
  },

  /**
   * Int64 → JS number。**仅限 epoch 毫秒/秒等值域 < 2^53 的时间戳量纲**；64 位 id 禁用（精度丢失，守上面 int64Str 铁律）。
   * 归一优先级：number 直取 → Long 实例 toNumber() → 裸 {_low,_high}/{low,high} 按无符号高低位拼装（负 _low 补回 2^32）→ 其余 Number 兑底。
   * 由各 feat 分散的 int64→num 变体（truck / secret-weapon-drop long64Ms·msOf）经离线行为 diff 证明在时间戳输入域等价后收口。
   * @param {*} v
   * @returns {number} 无值/不可解析回 0
   */
  int64ToNum(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toNumber === 'function') {
      try {
        return v.toNumber() || 0;
      } catch (e) {}
    }
    if (typeof v === 'object' && (v._low != null || v.low != null)) {
      var lo = Number(v._low != null ? v._low : v.low);
      var hi = Number(v._high != null ? v._high : v.high);
      if (!isFinite(lo) || !isFinite(hi)) return 0;
      if (lo < 0) lo += 4294967296;
      return hi * 4294967296 + lo;
    }
    return Number(v) || 0;
  },

  /**
   * 裸 {_low,_high} POJO（无 toNumber/toString，区别于 int64Str 处理的 protobuf Long 实例）→ 十进制字符串；用 BigInt 拼装无精度损失（雪花 id 安全）。非裸对象回 `String(v)`；null 回空串；BigInt 不可用/异常回空串。
   * 由 truck-intercept 的 reportId 回发旧内联 `i64Str` 经行为等价收口；与 int64Str 按输入形状分工（Long 实例走 toString、裸 POJO 走此），故并列不合并。
   * @param {*} v {_low,_high} / 数字 / 串
   * @returns {string} 十进制串（无值回空串）
   */
  int64Decimal(v) {
    if (v == null) return '';
    if (typeof v === 'object' && typeof v._high === 'number' && typeof v._low === 'number') {
      try {
        return ((BigInt(v._high) << 32n) | BigInt(v._low >>> 0)).toString();
      } catch (e) {
        return '';
      }
    }
    return String(v);
  },
};
