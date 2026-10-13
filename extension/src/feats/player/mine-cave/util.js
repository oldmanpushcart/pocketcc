/**
 * 次元矿洞 · 两引擎共享的纯工具函数。
 * 仅矿洞自用（工程内无其它 feat 引用），故留在矿洞目录内而非工程级 utils/。
 */
import { l10n } from '../../../core/game-api.js';

// Int64 对象 → 稳定字符串键（拉黑/去重用）；非对象则退化为 String。
export function idKey(id) {
  if (id == null) return '';
  if (typeof id === 'object') return id._low + ':' + id._high + ':' + (id._unsigned ? 1 : 0);
  return String(id);
}

// Int64（{_low,_high} 或数字/字符串）→ JS number（毫秒时间戳等）。
export function int64ToNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && '_low' in v) {
    return (v._high >>> 0) * 4294967296 + (v._low >>> 0);
  }
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

// 把服务器拒绝载荷翻成可读文本（优先命中形如 xxx999 的本地化 key）。
export function rejectText(d) {
  if (d == null) return '-';
  if (typeof d !== 'object') {
    var t = l10n.net(d);
    return t && t !== String(d) ? t + '(' + d + ')' : String(d);
  }
  var s;
  try {
    s = JSON.stringify(d);
  } catch (e) {
    s = String(d);
  }
  var m = /"([a-z][a-z0-9_]*[0-9])"/.exec(s);
  if (m) {
    var tt = l10n.net(m[1]);
    return (tt && tt !== m[1] ? tt : m[1]) + ' ' + s;
  }
  return s;
}
