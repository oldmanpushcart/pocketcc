#!/usr/bin/env node
/**
 * dashcam 录制分析 CLI（离线逆向通用原语）。
 *
 * 子命令：
 *   index  <file.ndjson>                     全局概览：cmd×dir 频次 / 首末 ts / name 反查
 *   series <file.ndjson> --cmd N [...]      某 cmd 的时序抽取（req/resp/push、字段提取）
 *   shape  <file.ndjson> --cmd N [...]      该 cmd 载荷的字段形态（path→覆盖数+样例）
 *   slice  <file.ndjson> --from S --to S    时间窗内全部事件流水（诊断「这 40s 里发生了什么」）
 *   push   <file.ndjson> --cmd N --field P  推送载荷按标量字段过滤/分布（如 21534 的 num>0）
 *   log    <日志目录|段文件|报文会话文件>    日志流（/log 落盘的小时轮转段）：过滤/聚合/双轨对照
 *
 * 通用旗标：
 *   --dir=req|resp|push    仅匹配归一后的 dir（req:* 视为 req）
 *   --from=600 --to=900    相对锚点的秒窗（锚点=文件首行 ts，或 --anchor=绝对毫秒）
 *   --limit=200            序列类输出上限
 *   --fields=x,y           series 提取的点路径（支持 a.b[].c），缺省打内层载荷截断
 *   --eq/--ne/--gt=N       push 的字段值过滤
 *   --json                 机器可读输出（逐行 JSON）
 *
 * log 专属旗标：--hour=20261104T15（段前缀） --ms=from,to（绝对毫秒窗，与 slice 双轨对照）
 *   --lvl=debug|info|warn|error（最低档，只升不降） --mod=NET（子串） --grep=stall（子串）
 *   --group=mod|lvl|modlvl（聚合计数代替流水）
 *   位置参数传报文会话文件时，自动查同目录 index.ndjson 的 logRef 解析日志目录（软引用配对）。
 *
 * 定位：只认落盘格式，不懂游戏业务——cmd 语义由调用方给。
 * 引擎仿真类 harness（依赖 extension 源码）不放这里，见仓内 scripts/（replay 对拍框架 + verify-manifests）。
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  entries,
  dirOf,
  innerOf,
  payloadOf,
  pickPath,
  walkShape,
  bump,
  pctl,
  relTag,
  trimJson,
  logSegments,
} from './lib/rec.js';

// 管道早闭（如 `| head`）时静默退出，避免流式扫描继续写 stdout 触发 EPIPE 崩栈
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(0);
  throw e;
});

const argv = process.argv.slice(2);
const cmdName = argv[0];
const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
// 旗标：--k=v 与 --k v 两形都收（裸 --k 为布尔）
const flags = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (!m) continue;
  if (m[2] !== undefined) flags[m[1]] = m[2];
  else if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--'))
    flags[m[1]] = argv[++i];
  else flags[m[1]] = true;
}
if (!cmdName || !file) {
  console.log(usage());
  process.exit(cmdName ? 1 : 0);
}

function usage() {
  return [
    '用法：node dashcam/cli.js <index|series|shape|slice|push|log> <file> [旗标]',
    '旗标：--cmd --dir --from --to --anchor --limit --fields --field --eq --ne --gt --json --min --width --all',
    'log 旗标：--hour=20261104T15 --ms=from,to --lvl=info --mod=NET --grep=kw --group=mod|lvl|modlvl',
    '（--from/--to 为相对文件首行 ts 的秒，可用 --anchor 改锚点；log 位置参数可为日志目录/段文件/报文会话文件）',
  ].join('\n');
}

const num = (k) => (flags[k] === undefined ? null : Number(flags[k]));
const CMD = num('cmd');
const DIR = flags.dir || null;
const LIMIT = num('limit') || 200;
const JSONOUT = !!flags.json;

/** 逐行流扫，把命中行交给 fn(o, anchor, printed, st)；返回 {total, matched, anchor}。 */
async function scan(fn, st0) {
  const st = st0 || { matched: 0 };
  let anchor = num('anchor');
  let first = true;
  let total = 0;
  let printed = 0;
  const from = num('from');
  const to = num('to');
  for await (const o of entries(path.resolve(file))) {
    const ts = Number(o.ts) || 0;
    if (first) {
      first = false;
      if (anchor == null) anchor = ts;
    }
    const rel = (ts - anchor) / 1000;
    if (from != null && rel < from) continue;
    if (to != null && rel > to) continue;
    total++;
    printed = fn(o, anchor, printed, st);
  }
  return { total, matched: st.matched, anchor };
}

function matchCmdDir(o) {
  if (CMD != null && Number(o.cmd) !== CMD) return false;
  if (DIR && dirOf(o) !== DIR) return false;
  return true;
}

// ── index ────────────────────────────────────────────────────────────────
if (cmdName === 'index') {
  const freq = new Map();
  const names = new Map();
  const r = await scan((o, anchor, printed, st) => {
    void anchor;
    st.matched++;
    const key = o.cmd + ':' + dirOf(o);
    bump(freq, key, null);
    const rec = freq.get(key);
    rec.tsMin = rec.tsMin == null ? o.ts : Math.min(rec.tsMin, o.ts);
    rec.tsMax = Math.max(rec.tsMax || 0, o.ts);
    if (o.name && !names.has(String(o.cmd))) names.set(String(o.cmd), o.name);
    return printed;
  });
  const rows = [...freq.entries()]
    .map(([k, v]) => ({
      cmd: k.split(':')[0],
      dir: k.split(':')[1],
      name: names.get(k.split(':')[0]) || '',
      n: v.n,
      first: +((v.tsMin - r.anchor) / 1000).toFixed(1),
      last: +((v.tsMax - r.anchor) / 1000).toFixed(1),
    }))
    .sort((a, b) => b.n - a.n);
  if (JSONOUT) rows.forEach((x) => console.log(JSON.stringify(x)));
  else {
    console.log(
      `file=${path.basename(file)} 行=${r.matched} 跨度=${rows.reduce((m, x) => Math.max(m, x.last), 0).toFixed(0)}s cmd×dir=${rows.length}`,
    );
    const top = Number(flags.limit) || 40;
    for (const x of rows.slice(0, top)) {
      console.log(
        String(x.cmd).padEnd(7),
        x.dir.padEnd(5),
        (x.name || '').padEnd(26),
        String(x.n).padStart(7),
        ` first=${x.first}s last=${x.last}s`,
      );
    }
    if (rows.length > top) console.log(`…（其余 ${rows.length - top} 项，--limit 调整）`);
  }
} else if (cmdName === 'series') {
  // 某 cmd 的时序抽取
  if (CMD == null) throw new Error('series 需要 --cmd');
  const fields = flags.fields ? String(flags.fields).split(',') : null;
  const gaps = [];
  let prev = null;
  const r = await scan((o, anchor, printed, st) => {
    if (!matchCmdDir(o)) return printed;
    st.matched++;
    const inner = innerOf(o);
    let line;
    if (fields) {
      const vals = fields.map((f) => {
        const v =
          pickPath(payloadOf(o), f) != null ? pickPath(payloadOf(o), f) : pickPath(inner, f);
        return v == null ? '-' : String(v);
      });
      line = relTag(o.ts, anchor) + ' ' + dirOf(o) + ' ' + vals.join(' ');
    } else {
      line =
        relTag(o.ts, anchor) + ' ' + dirOf(o) + ' ' + trimJson(inner, Number(flags.width) || 140);
    }
    if (prev != null) gaps.push((o.ts - prev) / 1000);
    prev = o.ts;
    if (printed < LIMIT)
      console.log(JSONOUT ? JSON.stringify({ t: o.ts, dir: dirOf(o), data: inner }) : line);
    return printed + 1;
  });
  gaps.sort((a, b) => a - b);
  const head =
    `cmd=${CMD} 命中=${r.matched}` +
    (gaps.length
      ? ` 间隔 p10=${pctl(gaps, 0.1).toFixed(1)}s p50=${pctl(gaps, 0.5).toFixed(1)}s p90=${pctl(gaps, 0.9).toFixed(1)}s max=${gaps[gaps.length - 1].toFixed(1)}s`
      : '');
  console.error(head);
} else if (cmdName === 'shape') {
  // 载荷字段形态：path → 覆盖数 + 样例（数组字段以 pointList[].m.state 类路径自然呈现）
  if (CMD == null) throw new Error('shape 需要 --cmd');
  const stats = new Map();
  let hits = 0;
  await scan((o, anchor, printed, st) => {
    void anchor;
    void printed;
    if (!matchCmdDir(o)) return 0;
    hits++;
    st.matched++;
    walkShape(innerOf(o), '', stats);
    return 0;
  });
  const min = num('min') || (flags.all ? 1 : Math.max(1, Math.floor(hits * 0.02)));
  const rows = [...stats.entries()]
    .filter(([p, v]) => v.n >= min && !p.endsWith('[]') && !p.endsWith('.[]'))
    .sort((a, b) => b[1].n - a[1].n);
  if (JSONOUT)
    rows.forEach(([p, v]) => console.log(JSON.stringify({ path: p, n: v.n, sample: v.sample })));
  else {
    console.log(`cmd=${CMD} dir=${DIR || 'any'} 命中帧=${hits} 路径(覆盖>=${min})=${rows.length}`);
    for (const [p, v] of rows.slice(0, LIMIT))
      console.log(
        String(v.n).padStart(8),
        p.padEnd(46),
        v.sample !== undefined ? '= ' + JSON.stringify(v.sample) : '',
      );
  }
} else if (cmdName === 'slice') {
  // 时间窗全事件流水
  if (num('from') == null || num('to') == null) throw new Error('slice 需要 --from/--to（秒）');
  const width = Number(flags.width) || 110;
  const r = await scan((o, anchor, printed, st) => {
    if (!matchCmdDir(o)) return printed;
    st.matched++;
    const p = dirOf(o) === 'req' ? payloadOf(o) : innerOf(o);
    if (printed < LIMIT)
      console.log(
        relTag(o.ts, anchor).padEnd(12) +
          String(o.cmd).padEnd(7) +
          (o.name || '').padEnd(22) +
          dirOf(o).padEnd(5) +
          trimJson(p, width),
      );
    return printed + 1;
  });
  console.error(`窗内事件=${r.total} 命中=${r.matched}（输出上限 --limit）`);
} else if (cmdName === 'push') {
  // 推送标量字段：值分布 + 命中序列（如 21534 num>0 的脉冲形态）
  if (CMD == null || !flags.field) throw new Error('push 需要 --cmd 和 --field（内层标量路径）');
  const eq = num('eq');
  const ne = num('ne');
  const gt = num('gt');
  const dist = new Map();
  const hitsTs = [];
  await scan((o, anchor, printed, st) => {
    void printed;
    if (!matchCmdDir(o)) return 0;
    st.matched++;
    const v = pickPath(innerOf(o), flags.field);
    if (v === undefined) return 0;
    bump(dist, String(v), null);
    const pass =
      (eq == null || Number(v) === eq) &&
      (ne == null || Number(v) !== ne) &&
      (gt == null || Number(v) > gt);
    if (pass) hitsTs.push((o.ts - anchor) / 1000);
    return 0;
  });
  const rows = [...dist.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, Number(flags.dist) || 12);
  console.log(
    `cmd=${CMD} field=${flags.field} 值分布: ` + rows.map((e) => e[0] + '=' + e[1].n).join(' '),
  );
  console.log(
    `命中=${hitsTs.length}` +
      (hitsTs.length
        ? ' 序列: ' +
          hitsTs
            .slice(0, LIMIT)
            .map((s) => 't+' + s.toFixed(1) + 's')
            .join(' ')
        : ''),
  );
  // 相邻异号间隔（脉冲形态诊断：num>0 后多久跟 num=0）
  if (hitsTs.length > 1) {
    const d = [];
    for (let i = 1; i < hitsTs.length; i++) d.push(hitsTs[i] - hitsTs[i - 1]);
    d.sort((a, b) => a - b);
    console.log(
      `命中相邻间隔 p50=${pctl(d, 0.5).toFixed(2)}s p90=${pctl(d, 0.9).toFixed(2)}s max=${d[d.length - 1].toFixed(2)}s`,
    );
  }
} else if (cmdName === 'log') {
  // 日志流：选段（小时轮转）→ 过滤（级别/模块/关键字/绝对窗）→ 流水或聚合
  const abs = path.resolve(file);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  let dir = abs;
  let files; // 各分支必赋值（目录/段文件/会话 logRef 解析）
  const hourPrefix = flags.hour ? String(flags.hour) : null;
  // --ms 先解析并校验（畸形输入早报错），与会话 logRef 窗在后面取交集
  let cliWin = null;
  if (flags.ms) {
    const p = String(flags.ms).split(',');
    const num = (s) => (s === undefined || s.trim() === '' ? null : Number(s.trim()));
    const a = num(p[0]);
    const b = num(p[1]);
    // 开区间：缺 from 从头、缺 to 到末；给了但非数字（NaN）报错；两者都缺报错
    if (a === null && b === null) throw new Error('--ms 需为 绝对毫秒 from[,to]');
    if ((a !== null && Number.isNaN(a)) || (b !== null && Number.isNaN(b)))
      throw new Error('--ms 需为 绝对毫秒 from[,to]');
    const from = a === null ? -Infinity : a;
    const to = b === null ? Infinity : b;
    if (from > to) throw new Error('--ms from>to');
    cliWin = [from, to];
  }
  let msWin = null;
  if (st && st.isDirectory()) {
    files = logSegments(dir, hourPrefix);
  } else if (st && /^\d{8}T\d{2}(-\d{2})?\.ndjson$/.test(path.basename(abs))) {
    files = [abs];
    dir = path.dirname(abs);
  } else if (st) {
    // 报文会话文件 → 同目录 index.ndjson 查 logRef（软引用配对，业务窗口在报文侧）
    const base = path.basename(abs).replace(/\.ndjson$/, '');
    const indexPath = path.join(path.dirname(abs), 'index.ndjson');
    let ref = null;
    if (fs.existsSync(indexPath)) {
      for await (const e of entries(indexPath)) {
        if (e.file && path.basename(String(e.file)).replace(/\.ndjson$/, '') === base) {
          ref = e.logRef || null;
          break;
        }
      }
    }
    if (!ref) throw new Error('非日志目录/段文件，且会话 index 无 logRef（旧 index 行需重录才有）');
    // logRef.dir 相对 OUT 根（如 _log/<uid>）；会话文件在 <OUT>/<uid>/ 下，上跳一层即 OUT 根
    dir = path.resolve(path.dirname(abs), '..', ref.dir);
    msWin = [ref.from, ref.to];
    files = logSegments(dir, hourPrefix);
  } else {
    throw new Error('路径不存在: ' + abs);
  }
  // 显式 --ms 与会话软引用窗取交集（而非静默忽略其中一个）
  if (cliWin) {
    msWin = msWin ? [Math.max(msWin[0], cliWin[0]), Math.min(msWin[1], cliWin[1])] : cliWin;
    if (msWin[0] > msWin[1]) throw new Error('--ms 与会话 logRef 窗无交集');
  }
  const LVL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLvl = flags.lvl ? String(flags.lvl) : null;
  if (minLvl && !(minLvl in LVL_ORDER)) throw new Error('--lvl 取 debug|info|warn|error');
  const modSub = flags.mod ? String(flags.mod).toUpperCase() : null;
  const grepSub = flags.grep ? String(flags.grep).toLowerCase() : null;
  const groupBy = flags.group ? String(flags.group) : null;
  if (groupBy && !/^(mod|lvl|modlvl)$/.test(groupBy)) throw new Error('--group 取 mod|lvl|modlvl');
  if (!files.length) {
    console.log(`无匹配日志段 dir=${dir} hour=${hourPrefix || '*'}`);
    process.exit(0);
  }
  const gagg = new Map();
  let shown = 0;
  let seen = 0;
  let matched = 0;
  let anchor = null;
  for (const f of files) {
    for await (const o of entries(f)) {
      if (o.ts == null || !o.lvl) continue; // 非日志行（防误喂报文文件）
      const ts = Number(o.ts) || 0;
      if (anchor == null) anchor = ts;
      seen++;
      if (msWin && (ts < msWin[0] || ts > msWin[1])) continue;
      if (minLvl && (LVL_ORDER[o.lvl] ?? 1) < LVL_ORDER[minLvl]) continue;
      const msg = String(o.msg == null ? '' : o.msg);
      if (
        modSub &&
        String(o.mod || '')
          .toUpperCase()
          .indexOf(modSub) < 0
      )
        continue;
      if (grepSub && msg.toLowerCase().indexOf(grepSub) < 0) continue;
      matched++;
      if (groupBy) {
        bump(gagg, groupBy === 'modlvl' ? o.mod + ' ' + o.lvl : o[groupBy] || '?', null);
        continue;
      }
      if (shown < LIMIT) {
        const rep = Number(o.n) > 1 ? ` {${o.n}×}` : '';
        const clock = new Date(ts).toTimeString().slice(0, 8);
        console.log(
          JSONOUT
            ? JSON.stringify({ ts, lvl: o.lvl, mod: o.mod, msg, n: Number(o.n) || 1 })
            : `${clock} ${relTag(ts, anchor).padEnd(12)} ${o.lvl[0].toUpperCase()} ${(o.mod || '').padEnd(9)} ${msg.slice(0, 200)}${rep}`,
        );
        shown++;
      }
    }
  }
  if (groupBy) {
    const rows = [...gagg.entries()].sort((a, b) => b[1].n - a[1].n);
    for (const [k, v] of rows.slice(0, LIMIT)) console.log(String(v.n).padStart(8), k);
    console.error(`段=${files.length} 总行=${seen} 命中=${matched} 分组=${groupBy}`);
  } else {
    console.error(
      `段=${files.length} 总行=${seen} 命中=${matched} 显示=${shown}` +
        (matched > shown ? `（余 ${matched - shown} 条，--limit 调整）` : ''),
    );
  }
} else {
  console.log(usage());
  process.exit(1);
}
