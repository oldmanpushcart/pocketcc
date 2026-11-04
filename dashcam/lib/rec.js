/**
 * dashcam 录制报文读取原语（纯格式层）。
 *
 * 行格式 = 扩展 core/net.js 产出的 net entry（见 README「落盘格式」）：
 *   {"dir":"req:send|req:sendPB|...|resp|push","cmd":N,"name":"...","data":{},"raw":{},"ts":ms,"seq":N,"rt":ms|null}
 *
 * 红线：本模块只认报文格式，**不 import extension 侧任何业务常量**——
 *   cmd→语义由调用方（CLI 参数 / 上层脚本）决定；信封拆包做成通用形态而非按 cmd 分支。
 */
import { createReadStream, readdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** 流式逐行解析；坏行静默跳过（录制里偶发截断行）。 */
export async function* entries(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    yield o;
  }
}

/** dir 归一：req:* → 'req'；其余原样（'resp' / 'push'）。 */
export function dirOf(o) {
  const d = (o && o.dir) || '';
  return d.startsWith('req') ? 'req' : d;
}

/** 外层业务体：o.data（缺回 {}）。 */
export function payloadOf(o) {
  const d = o && o.data;
  return d && typeof d === 'object' ? d : {};
}

/** 内层信封：push/resp 常见 {header,data} 嵌套，取 data.data；无则原样回 data。 */
export function innerOf(o) {
  const d = payloadOf(o);
  if (d.data && typeof d.data === 'object') return d.data;
  return d;
}

/** long.js Int64 bits（{_low,_high}）→ double 毫秒/数值；标量原样回 Number。 */
export function int64Num(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && ('_low' in v || '_high' in v)) {
    const lo = v._low < 0 ? v._low + 4294967296 : v._low || 0;
    return (v._high || 0) * 4294967296 + lo;
  }
  return Number(v) || 0;
}

/** 按 'a.b[].c' 路径取标量（数组取首个命中）；取不到回 undefined。 */
export function pickPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    const arr = p.endsWith('[]');
    const k = arr ? p.slice(0, -2) : p;
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
    if (arr) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[0];
      if (cur == null || typeof cur !== 'object') return undefined;
    }
  }
  return cur;
}

/** 字段形态计数：path → {n, sample(首个标量样例)}。数组用 '[]' 后缀、对象递归。 */
export function walkShape(obj, prefix, stats, depth = 0) {
  if (depth > 7 || obj == null) return;
  if (Array.isArray(obj)) {
    bump(stats, prefix + '[]', null);
    for (let i = 0; i < obj.length; i++) walkShape(obj[i], prefix, stats, depth + 1);
    return;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const p = prefix ? prefix + '.' + k : k;
      const v = obj[k];
      if (v !== null && typeof v === 'object') bump(stats, p, null);
      else bump(stats, p, v);
      walkShape(v, p, stats, depth + 1);
    }
  }
}

export function bump(map, k, sample) {
  const cur = map.get(k) || { n: 0, sample: undefined };
  cur.n++;
  if (cur.sample === undefined && sample !== undefined && sample !== null) cur.sample = sample;
  map.set(k, cur);
}

/** 分位数（q∈[0,1]，空回 null）。 */
export function pctl(sortedArr, q) {
  if (!sortedArr.length) return null;
  return sortedArr[Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * q))];
}

/** 相对锚点的可读秒标（anchor=绝对毫秒）。 */
export function relTag(ts, anchor) {
  return 't+' + ((ts - anchor) / 1000).toFixed(1) + 's';
}

/** 单行 JSON 截断（打印防刷屏）。 */
export function trimJson(o, max = 160) {
  const s = JSON.stringify(o);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 日志小时段选段（store/_log/<uid>/ 命名属本工程落盘格式：YYYYMMDDTHH[-NN].ndjson，
 * 如 20261104T17 / 20261104T17-01；日期 8 位 + T + 小时 2 位）。
 * 排序按（小时键，序号）：基准段（无 -NN）写最早，视为序号 -1 排最前；
 * 直接按名字 ASCII 升序会把 '-01' 排到基准段前（'-'<'.'）造成时间线倒流。
 * @param {string} dir 日志目录
 * @param {string|null} hourPrefix 段名前缀（如 '20261104' 整天 / '20261104T17' 整小时）；null 全取
 * @returns {string[]} 绝对路径，按时间序
 */
export function logSegments(dir, hourPrefix) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const key = (n) => {
    const m = /^(\d{8}T\d{2})(?:-(\d{2}))?\.ndjson$/.exec(n);
    return { hour: m[1], seq: m[2] === undefined ? -1 : Number(m[2]) };
  };
  return names
    .filter((n) => /^\d{8}T\d{2}(-\d{2})?\.ndjson$/.test(n))
    .filter((n) => !hourPrefix || n.startsWith(hourPrefix))
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka.hour < kb.hour ? -1 : ka.hour > kb.hour ? 1 : ka.seq - kb.seq;
    })
    .map((n) => path.join(dir, n));
}
