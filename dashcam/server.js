/**
 * dashcam 接收器 —— pocketcc 「行车记录仪」落盘端：双记录能力
 *
 * 纯 node:http，无三方依赖。接收扩展 background service worker 代发的 NDJSON，两类流两个端点：
 *
 * 1. POST /ingest —— 网络报文（会话制）：面板开→关为一段，带业务标签 note，按下方命名定稿。
 *   命名规范（本次录制会话 = 一个文件；开→关为一次；文件名统一带 dashcam-rec- 前缀）：
 *     store/rec/<uid>/dashcam-rec-<startLocal>[-<note>][-<slug>].ndjson
 *       <startLocal>  录制启动时刻的本地紧凑时间 YYYYMMDDTHHMMSS（可排序、可读）
 *       <note>        面板「本次标签」预填（可空，优先作主题词；保留原大小写/中文，仅净化路径字符）
 *       <slug>        自动派生：本段 cmd 统计去掉噪声与 GET_ 等前缀后的 top 请求名（无 note 时作主题）
 *     同目录另有 dashcam-rec-index.ndjson（每 session 一行）作为「行程表」，行内附 logRef 指向同时段日志段。
 *   落盘时序：进行中写 dashcam-rec-*.part（只 append）；x-done 或空闲超时后定稿——算 slug、改名、写索引。
 *
 * 2. POST /log —— 扩展日志（长期常开，无业务语义）：不分会话、不定稿、不建索引，
 *   按**天轮转直写**最终文件名（传统 logrotate 形态，崩溃不丢已写内容；文件名带 dashcam-log- 前缀）：
 *     store/log/<uid>/dashcam-log-<YYYYMMDD>[-NN].ndjson   行格式 {ts,lvl,mod,msg,n}（n=折叠重复计数）
 *   按行内 ts 归段；单段超 DASHCAM_LOG_MAXSEG 字节则滚到下一序号段（防失控刷屏把磁盘写满）。
 *   与报文会话的配对是**查询时软引用**（index 行 logRef 给目录+时间窗），不耦合生命周期。
 *
 * 启动：node server.js
 *   环境变量 DASHCAM_PORT 监听端口（默认 7391）· DASHCAM_OUT 落盘根目录（默认 <工程>/store）
 *   DASHCAM_LOG_MAXSEG 日志单段字节上限（默认 32MB）
 * 路由：GET / 健康检查 · POST /ingest（x-session/x-uid/x-start/x-note/x-done 头 + NDJSON body）
 *       POST /log（x-uid/x-run 头 + NDJSON body）
 * 安全：仅绑 127.0.0.1；uid/session/note 做文件名净化并强制剥离 .. 防目录穿越。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.DASHCAM_PORT) || 7391;
const HOST = '127.0.0.1';
const OUT = process.env.DASHCAM_OUT || path.join(__dirname, 'store');

const IDLE_FINALIZE_MS = 3 * 60 * 1000; // 空闲超此值即定稿（done 批丢失时的兜底）
const SWEEP_INTERVAL_MS = 30 * 1000;
const MAX_BODY = 32 * 1024 * 1024; // 单批 body 上限 32MB
const LOG_MAX_SEG = Number(process.env.DASHCAM_LOG_MAXSEG) || 32 * 1024 * 1024; // 日志单段字节保险丝

// 存储分层与前缀（新规范）：报文 → store/rec/<uid>/dashcam-rec-*.ndjson；日志 → store/log/<uid>/dashcam-log-*.ndjson。
// 目录归类 + 文件名前缀双保险，任一侧 glob 都不会误吞另一侧；rec 侧机器索引固定名 dashcam-rec-index.ndjson。
const REC_SUB = 'rec';
const LOG_SUB = 'log';
const REC_PREFIX = 'dashcam-rec-';
const LOG_PREFIX = 'dashcam-log-';
const INDEX_NAME = 'dashcam-rec-index.ndjson';

// ── 自动 slug 启发式 ──────────────────────────────────────────────
// 噪声：高频纯轮询/心跳类命令名，派生主题时跳过（可按真机反馈增补）
const NOISE_NAMES = new Set([
  'HEART',
  'NO_QUEUE_HEART',
  'PING',
  'GET_WORLD_INFO',
  'GET_MIX_TERRITORY_INFO',
  'GET_TERRITORY_INFO',
  'GET_MARCH_TIME',
  'GET_BEHEMOTH_WORLD_INFO',
  'GET_PLAYER_POINT',
]);
// 名字前缀：作主题词时剥掉，更短更可读
const NAME_PREFIX_RE = /^(GET|REQ|CMD|C2S|SEND)_/;

fs.mkdirSync(OUT, { recursive: true });

/** @type {Map<string,object>} sessionId -> 活动会话状态（含 .part 路径、cmd 统计） */
const active = new Map();
/** @type {Map<string,Map<string,object>}> uid -> (sessionId -> 索引条目) */
const indexes = new Map();

// ── 工具函数 ──────────────────────────────────────────────────────
/**
 * 净化字符串作文件名/目录名：剥离除 [\w.\-] 外的所有字符（含 / \ 空字节），并强制去掉 ..。
 * @param {string} raw
 * @param {number} max 截断长度
 * @returns {string}
 */
function sanitize(raw, max) {
  const s = String(raw == null ? '' : raw)
    .replace(/\.\./g, '_')
    .replace(/[^\w.-]+/g, (m) => (m.includes(' ') || m === '_' ? '_' : ''))
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return (s || '').slice(0, max || 120);
}

/**
 * 本地紧凑时间戳 YYYYMMDDTHHMMSS（用服务器本地时区，与浏览器录制机同时区）。
 * @param {number} ts 毫秒
 * @returns {string}
 */
function fmtLocal(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 从一个命令名派生 slug 片段：剥噪声以外命令的前缀、转小写连字符。
 * @param {string} name
 * @returns {string}
 */
function slugPiece(name) {
  const stripped = name.replace(NAME_PREFIX_RE, '');
  return sanitize(stripped.toLowerCase(), 24).replace(/_/g, '-');
}

/**
 * 据 cmd 统计算自动主题词：取非噪声、按计数降序的 top 请求名，最多两段。
 * @param {Map<string,number>} nameCounts
 * @returns {string} '' 表示无合适主题
 */
function deriveSlug(nameCounts) {
  const ranked = [...nameCounts.entries()]
    .filter(([name]) => name && !NOISE_NAMES.has(name))
    .sort((a, b) => b[1] - a[1]);
  const pieces = [];
  for (const [name] of ranked) {
    const piece = slugPiece(name);
    if (piece && !pieces.includes(piece)) pieces.push(piece);
    if (pieces.length >= 2) break;
  }
  return pieces.join('+').slice(0, 48);
}

/**
 * 解析唯一最终文件名：base 冲突则追加 -NN。
 * @param {string} dir 目录
 * @param {string} startLocal 时间前缀
 * @param {string} note 已净化 note（可空）
 * @param {string} slug 已算 slug（可空）
 * @returns {{name:string, file:string}} name 仅文件名，file 绝对路径
 */
function resolveName(dir, startLocal, note, slug) {
  const base = REC_PREFIX + [startLocal, note, slug].filter(Boolean).join('-');
  let name = base + '.ndjson';
  if (!fs.existsSync(path.join(dir, name))) return { name, file: path.join(dir, name) };
  for (let i = 1; i < 1000; i++) {
    name = `${base}-${String(i).padStart(2, '0')}.ndjson`;
    if (!fs.existsSync(path.join(dir, name))) return { name, file: path.join(dir, name) };
  }
  name = `${base}-${Date.now()}.ndjson`;
  return { name, file: path.join(dir, name) };
}

/**
 * 读取并索引某 uid 目录已有的 index.ndjson（启动时或首次用到时）。
 * @param {string} uid
 * @param {string} dir
 * @returns {Map<string,object>} sessionId -> 条目
 */
function loadIndex(uid, dir) {
  if (indexes.has(uid)) return indexes.get(uid);
  const m = new Map();
  try {
    const p = path.join(dir, INDEX_NAME);
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && e.sessionId) m.set(e.sessionId, e);
        } catch (_) {
          /* 跳过坏行 */
        }
      }
    }
  } catch (e) {
    console.error('[dashcam] load index fail', uid, e.message);
  }
  indexes.set(uid, m);
  return m;
}

/**
 * 原子重写某 uid 的 index.ndjson（按 start 升序，每行一条 JSON）。
 * @param {string} uid
 * @param {string} dir
 */
function writeIndex(uid, dir) {
  const m = indexes.get(uid);
  if (!m) return;
  const rows = [...m.values()].sort((a, b) => (a.start || 0) - (b.start || 0));
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const tmp = path.join(dir, INDEX_NAME + '.tmp');
  const out = path.join(dir, INDEX_NAME);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, out);
  } catch (e) {
    console.error('[dashcam] write index fail', uid, e.message);
  }
}

/**
 * 定稿一个会话：算 slug → .part 重命名为最终名 → 追加索引行 → 出表。
 * @param {string} sessionId
 * @param {object} s 活动会话状态
 */
function finalizeSession(sessionId, s) {
  const dir = s.dir;
  const slug = s.note ? '' : deriveSlug(s.nameCounts); // 有 note 时 note 即主题，不再叠 auto slug
  const { name } = resolveName(dir, s.startLocal, s.note, slug);
  const finalRel = path.join(REC_SUB, s.uidSeg, name);
  // 重命名失败则保留 .part 不动，交给下次 sweep 重试
  try {
    if (fs.existsSync(s.partFile)) fs.renameSync(s.partFile, path.join(dir, name));
    else {
      console.warn('[dashcam] finalize: part missing', s.partFile);
    }
  } catch (e) {
    console.error('[dashcam] finalize rename fail', sessionId, e.message);
    return;
  }
  const top = [...s.nameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map((x) => [x[0], x[1]]);
  const entry = {
    file: finalRel.split(path.sep).join('/'),
    uid: s.uid,
    sessionId,
    start: s.start,
    end: s.lastSeen,
    durMs: Math.max(0, s.lastSeen - s.start),
    lines: s.lines,
    slug,
    note: s.note,
    finalized: true,
    top,
    // 同时段日志软引用（查询时配对，不耦合生命周期）：日志按天轮转，窗内可能跨多个段文件
    logRef: s.uidSeg ? { dir: LOG_SUB + '/' + s.uidSeg, from: s.start, to: s.lastSeen } : null,
  };
  const idx = loadIndex(s.uid, dir);
  idx.set(sessionId, entry);
  writeIndex(s.uid, dir);
  active.delete(sessionId);
  console.log('[dashcam] finalized session=%s -> %s (%d lines)', sessionId, finalRel, s.lines);
}

// ── 报文摄入 ──────────────────────────────────────────────────────
/**
 * 处理一批 NDJSON：累加到该 session 的 .part，更新统计；done 则立即定稿。
 * @param {{session?:string, uid?:string, start?:string, note?:string, done?:string}} headers
 * @param {string} ndjson
 */
function ingest(headers, ndjson) {
  // Node req.headers 键一律小写带连字符（x-session/x-uid/...），非驼峰。
  const sessionId = sanitize(headers['x-session'], 120) || 'anon-' + Date.now();
  const uid = headers['x-uid'] || '';
  const noteRaw = decodeNote(headers['x-note']); // background 侧 encodeURIComponent，含中文
  const startHdr = Number(headers['x-start']);
  const start = Number.isFinite(startHdr) && startHdr > 0 ? startHdr : Date.now();

  let s = active.get(sessionId);
  if (!s) {
    const uidSeg = sanitize(uid, 60) || 'anon';
    const dir = path.join(OUT, REC_SUB, uidSeg);
    fs.mkdirSync(dir, { recursive: true });
    const startLocal = fmtLocal(start);
    s = {
      uid,
      uidSeg,
      dir,
      start,
      startLocal,
      note: sanitizeNote(noteRaw), // note 允许中文，仅去路径/控制字符
      nameCounts: new Map(),
      lines: 0,
      lastSeen: Date.now(),
      partFile: path.join(dir, `${REC_PREFIX}${startLocal}-${sessionId}.part.ndjson`),
    };
    active.set(sessionId, s);
    fs.appendFileSync(s.partFile, ''); // touch 空文件，后续 append 续写
  } else if (noteRaw) {
    s.note = sanitizeNote(noteRaw); // 允许录制中改标签，取最后一次
  }

  const text = ndjson.trim();
  if (text) {
    const body = text.endsWith('\n') ? text : text + '\n';
    fs.appendFileSync(s.partFile, body); // 同步 append：与 sweep 的重命名串行安全
    s.lines += body.split('\n').filter(Boolean).length;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const nm = e.name || e.dir + ':' + e.cmd;
        s.nameCounts.set(nm, (s.nameCounts.get(nm) || 0) + 1);
      } catch (_) {
        /* 非单行 JSON，忽略统计 */
      }
    }
  }
  s.lastSeen = Date.now();

  if (headers['x-done'] === '1') finalizeSession(sessionId, s);
}

/**
 * 解码 note 头（background 侧 encodeURIComponent）；非法编码回落原值。
 * @param {string|undefined} raw
 * @returns {string}
 */
function decodeNote(raw) {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return String(raw);
  }
}

/**
 * note 净化：保留中文与常见可打印字符，仅去路径分隔/控制字符与首尾空白，截断。
 * @param {string} raw
 * @returns {string}
 */
function sanitizeNote(raw) {
  const s = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\.\./g, '_')
    .trim();
  return s.slice(0, 40);
}

/**
 * 日志批落盘：按行内 ts 归天段直写最终文件（无 .part、无定稿、无索引——日志无业务语义，
 * rename 机制那套是为报文会话定稿服务的，这里纯属多余）。
 * 目录 store/log/<uid>/；文件名带 dashcam-log- 前缀；单段超 LOG_MAX_SEG 滚下一序号段（-01/-02…）；坏行静默跳过。
 * @param {{uid?:string, run?:string}} headers
 * @param {string} ndjson
 */
function ingestLog(headers, ndjson) {
  const uid = sanitize(headers['x-uid'], 60) || 'anon';
  const dir = path.join(OUT, LOG_SUB, uid);
  const text = String(ndjson || '').trim();
  if (!text) return;
  fs.mkdirSync(dir, { recursive: true }); // 有有效批才建目录，空 POST 不留空壳
  // 先按天键分组再写：归段必须按行内 ts 而非到达时刻，
  // 否则扩展侧缓冲攒着的旧日志会被错归到后一段里。
  /** @type {Map<string, string[]>} dayKey -> 行 */
  const groups = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let dayKey;
    try {
      const e = JSON.parse(line);
      // ts 合理区间闸门（2001–2100）：外部误喂报文/秒当毫秒时，不致造出远古段文件污染目录
      const t = Number(e.ts);
      const ts = t > 978307200000 && t < 4102444800000 ? t : Date.now();
      dayKey = fmtLocal(ts).slice(0, 8); // YYYYMMDD（8 位日期）
    } catch (_) {
      continue; // 非单行 JSON：丢弃不阻断（与 /ingest 容错同轨）
    }
    const arr = groups.get(dayKey) || [];
    arr.push(line);
    groups.set(dayKey, arr);
  }
  for (const [dayKey, lines] of groups) {
    const body = lines.join('\n') + '\n';
    // 序号段保险丝：只看该天已存在的「最大序号段」是否超限，超限则新开 maxSeq+1。
    // 不能从前段往后逐个 stat：基准段一旦被人为截小/调大上限后会「回开」，新行插进旧时间段。
    let file = path.join(dir, LOG_PREFIX + dayKey + '.ndjson');
    try {
      // 只看已存在的最大序号段；基准段（无 -NN）最早写入、序号段从 -01 起。
      // 无序号段时：基准超限 → 新开 -01；有序号段时：只往最大序号段追加，最大也超限 → max+1；
      // 绝不回头追加基准段（人为截小后会新行插进旧时间段），也不产 -00。
      let maxSeg = -1;
      for (const n of fs.readdirSync(dir)) {
        const m = new RegExp('^' + LOG_PREFIX + dayKey + '-(\\d{2})\\.ndjson$').exec(n);
        if (m) maxSeg = Math.max(maxSeg, Number(m[1]));
      }
      if (maxSeg < 0) {
        if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_SEG) {
          file = path.join(dir, `${LOG_PREFIX}${dayKey}-01.ndjson`);
        }
      } else {
        const top = path.join(
          dir,
          `${LOG_PREFIX}${dayKey}-${String(maxSeg).padStart(2, '0')}.ndjson`,
        );
        file =
          fs.existsSync(top) && fs.statSync(top).size > LOG_MAX_SEG && maxSeg < 99
            ? path.join(dir, `${LOG_PREFIX}${dayKey}-${String(maxSeg + 1).padStart(2, '0')}.ndjson`)
            : top;
      }
    } catch (_) {
      /* 扫目录/stat 失败不阻断，落首选文件 */
    }
    try {
      fs.appendFileSync(file, body);
    } catch (e) {
      console.error('[dashcam] log append fail', file, e.message);
    }
  }
}

// ── HTTP ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, x-session, x-uid, x-start, x-note, x-done, x-run',
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({ service: 'dashcam', out: OUT, port: PORT, activeSessions: active.size }),
    );
    return;
  }

  if (req.method === 'POST' && url === '/ingest') {
    try {
      const ndjson = await readBody(req);
      ingest(req.headers, ndjson);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":1}');
    } catch (e) {
      console.error('[dashcam] ingest error:', e.message);
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: 0, error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && url === '/log') {
    try {
      const ndjson = await readBody(req);
      ingestLog(req.headers, ndjson);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":1}');
    } catch (e) {
      console.error('[dashcam] log error:', e.message);
      // 只有限体超限才判 413，落盘异常（ENOSPC/EACCES 等）归 500，不误导端上排障
      const tooLarge = e.message === 'payload too large';
      res.writeHead(tooLarge ? 413 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: 0, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

// 空闲定稿兜底：done 批若丢失，超时无新批的会话在此收尾
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of [...active]) {
    if (now - s.lastSeen > IDLE_FINALIZE_MS) finalizeSession(id, s);
  }
}, SWEEP_INTERVAL_MS);

function shutdown() {
  console.log('\n[dashcam] shutting down, finalizing %d active session(s)', active.size);
  for (const [id, s] of [...active]) finalizeSession(id, s);
  clearInterval(sweeper);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log('[dashcam] listening http://' + HOST + ':' + PORT + '  ->  ' + OUT);
  console.log(
    '[dashcam] POST /ingest(报文会话) · POST /log(日志天轮转) · GET / · 命名 store/<uid>/<startLocal>[-<note>][-<slug>].ndjson · index.ndjson 侧车',
  );
});
