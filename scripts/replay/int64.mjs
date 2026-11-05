/**
 * Int64 与坐标归一工具（replay 内核 · 纯函数、零依赖）。
 *
 * 录制里的 64 位整数字段有三种形态，跨 feat 通用，故收进内核：
 *   ① protobuf Int64 对象  {_low, _high, _unsigned}
 *   ② 十进制字符串         "1234567890123"
 *   ③ 裸数（未超安全整数）  12345
 * rId（如资源/掉落拾取的实体 ID）则是「十进制字符串」这一约定形态。
 */

/** Int64 归一：{_low,_high} protobuf / 十进制字符串 / 裸数 → Number */
export function toNum(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'object' && '_low' in v && '_high' in v) {
    return v._high * 0x100000000 + (v._low >>> 0);
  }
  return Number(v);
}

/** 是否为 protobuf Int64 对象形态（{_low,_high,...}） */
export function isInt64Obj(v) {
  return !!(v && typeof v === 'object' && '_low' in v && '_high' in v);
}

/** rId 是否为合法十进制字符串（拾取协议口径，防 Int64 丢精度） */
export function isRidString(v) {
  return typeof v === 'string' && /^\d+$/.test(v);
}

/** 两点是否同格：各自 floor 后比较（坐标可能带小数偏移 / Int64 对象） */
export function samePos(a, b) {
  if (!a || !b) return false;
  return (
    Math.floor(toNum(a.x)) === Math.floor(toNum(b.x)) &&
    Math.floor(toNum(a.y)) === Math.floor(toNum(b.y))
  );
}
