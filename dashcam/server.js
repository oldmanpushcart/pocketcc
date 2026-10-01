/**
 * dashcam 接收器 —— pocketcc 报文「行车记录仪」落盘端
 *
 * 纯 node:http，无三方依赖。接收扩展 background service worker 代发的 NDJSON（每行一条 net entry），
 * 按「会话 / 日期」落盘，供离线 glob 读取分析。
 *
 * 命名规范（本次录制会话 = 一个文件；开→关为一次）：
 *   store/<uid>/<startLocal>[-<note>][-<slug>].ndjson
 *     <startLocal>  录制启动时刻的本地紧凑时间 YYYYMMDDTHHMMSS（可排序、可读）
 *     <note>        面板「本次标签」预填（可空，优先作主题词；保留原大小写/中文，仅净化路径字符）
 *     <slug>        自动派生：本段 cmd 统计去掉噪声与 GET_ 等前缀后的 top 请求名（无 note 时作主题）
 *   同目录另有 index.ndjson（每 session 一行）作为「行程表」：文件名保持机器友好，人读检索走索引。
 *
 * 落盘时序：session 进行中写入 .part 临时文件（只 append，稳定）；收到 x-done 或空闲超时后「定稿」——
 *   据累计统计算 slug、把 .part 重命名为最终名、往 index.ndjson 追加/更新一行。
 *
 * 启动：node server.js
 *   环境变量 DASHCAM_PORT 监听端口（默认 7391）· DASHCAM_OUT 落盘根目录（默认 <工程>/store）
 * 路由：GET / 健康检查 · POST /ingest（x-session/x-uid/x-start/x-note/x-done 头 + NDJSON body）
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

const IDLE_FINALIZE_MS = 3 * 60 * 1000;   // 空闲超此值即定稿（done 批丢失时的兜底）
const SWEEP_INTERVAL_MS = 30 * 1000;
const MAX_BODY = 32 * 1024 * 1024;         // 单批 body 上限 32MB

// ── 自动 slug 启发式 ──────────────────────────────────────────────
// 噪声：高频纯轮询/心跳类命令名，派生主题时跳过（可按真机反馈增补）
const NOISE_NAMES = new Set([
  'HEART', 'NO_QUEUE_HEART', 'PING', 'GET_WORLD_INFO', 'GET_MIX_TERRITORY_INFO',
  'GET_TERRITORY_INFO', 'GET_MARCH_TIME', 'GET_BEHEMOTH_WORLD_INFO', 'GET_PLAYER_POINT',
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
    .replace(/[^\w.\-]+/g, (m) => (m.includes(' ') || m === '_' ? '_' : ''))
    .replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '');
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
 * 生成会话目录（store/<uid>），uid 为空回落 anon。
 * @param {string} uid
 * @returns {string} 目录绝对路径
 */
function dirFor(uid) {
  const u = sanitize(uid, 60) || 'anon';
  const dir = path.join(OUT, u);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  const base = [startLocal, note, slug].filter(Boolean).join('-');
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
    const p = path.join(dir, 'index.ndjson');
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); if (e && e.sessionId) m.set(e.sessionId, e); } catch (_) { /* 跳过坏行 */ }
      }
    }
  } catch (e) { console.error('[dashcam] load index fail', uid, e.message); }
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
  const tmp = path.join(dir, 'index.ndjson.tmp');
  const out = path.join(dir, 'index.ndjson');
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, out);
  } catch (e) { console.error('[dashcam] write index fail', uid, e.message); }
}

/**
 * 定稿一个会话：算 slug → .part 重命名为最终名 → 追加索引行 → 出表。
 * @param {string} sessionId
 * @param {object} s 活动会话状态
 */
function finalizeSession(sessionId, s) {
  const dir = s.dir;
  const slug = s.note ? '' : deriveSlug(s.nameCounts);   // 有 note 时 note 即主题，不再叠 auto slug
  const { name } = resolveName(dir, s.startLocal, s.note, slug);
  const finalRel = path.join(s.uidSeg, name);
  // 重命名失败则保留 .part 不动，交给下次 sweep 重试
  try {
    if (fs.existsSync(s.partFile)) fs.renameSync(s.partFile, path.join(dir, name));
    else { console.warn('[dashcam] finalize: part missing', s.partFile); }
  } catch (e) {
    console.error('[dashcam] finalize rename fail', sessionId, e.message);
    return;
  }
  const top = [...s.nameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => [x[0], x[1]]);
  const entry = {
    file: finalRel.split(path.sep).join('/'), uid: s.uid, sessionId,
    start: s.start, end: s.lastSeen, durMs: Math.max(0, s.lastSeen - s.start),
    lines: s.lines, slug, note: s.note, finalized: true, top,
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
  const sessionId = sanitize(headers['x-session'], 120) || ('anon-' + Date.now());
  const uid = headers['x-uid'] || '';
  const noteRaw = decodeNote(headers['x-note']);   // background 侧 encodeURIComponent，含中文
  const startHdr = Number(headers['x-start']);
  const start = Number.isFinite(startHdr) && startHdr > 0 ? startHdr : Date.now();

  let s = active.get(sessionId);
  if (!s) {
    const uidSeg = sanitize(uid, 60) || 'anon';
    const dir = path.join(OUT, uidSeg);
    fs.mkdirSync(dir, { recursive: true });
    const startLocal = fmtLocal(start);
    s = {
      uid, uidSeg, dir, start, startLocal,
      note: sanitizeNote(noteRaw),         // note 允许中文，仅去路径/控制字符
      nameCounts: new Map(), lines: 0, lastSeen: Date.now(),
      partFile: path.join(dir, `${startLocal}-${sessionId}.part.ndjson`),
    };
    active.set(sessionId, s);
    fs.appendFileSync(s.partFile, '');    // touch 空文件，后续 append 续写
  } else if (noteRaw) {
    s.note = sanitizeNote(noteRaw);        // 允许录制中改标签，取最后一次
  }

  const text = ndjson.trim();
  if (text) {
    const body = text.endsWith('\n') ? text : text + '\n';
    fs.appendFileSync(s.partFile, body);   // 同步 append：与 sweep 的重命名串行安全
    s.lines += body.split('\n').filter(Boolean).length;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const nm = e.name || (e.dir + ':' + e.cmd);
        s.nameCounts.set(nm, (s.nameCounts.get(nm) || 0) + 1);
      } catch (_) { /* 非单行 JSON，忽略统计 */ }
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
  try { return decodeURIComponent(raw); } catch (_) { return String(raw); }
}

/**
 * note 净化：保留中文与常见可打印字符，仅去路径分隔/控制字符与首尾空白，截断。
 * @param {string} raw
 * @returns {string}
 */
function sanitizeNote(raw) {
  const s = String(raw || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\.\./g, '_').trim();
  return s.slice(0, 40);
}

// ── HTTP ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-session, x-uid, x-start, x-note, x-done');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ service: 'dashcam', out: OUT, port: PORT, activeSessions: active.size }));
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
  console.log('[dashcam] POST /ingest · GET / · 命名 store/<uid>/<startLocal>[-<note>][-<slug>].ndjson · index.ndjson 侧车');
});
