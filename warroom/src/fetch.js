// Fetch phase: download a report by id -> verify -> persist raw file -> upsert
// report envelope. Raw file is source-of-truth (OSS link expires), so we always
// write it first, then record cheap/safe信封 fields. Full structured decode is Phase 2.
import { writeFileSync, renameSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLog } from './log.js';
import { buildReportUrl, rawRelPath } from './link.js';
import { upsertReportFetched } from './db.js';

const log = createLog('FETCH');

/**
 * Download text with timeout + retries. Node 18 global fetch.
 * @param {string} url
 * @param {{ timeoutMs:number, retries:number }} opts
 * @returns {Promise<string>}
 */
async function download(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      if (res.status === 404)
        throw Object.assign(new Error(`not found (404): ${url}`), { fatal: true });
      if (!res.ok) throw new Error(`http ${res.status}: ${url}`);
      return await res.text();
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      log.debug('attempt %d failed for %s: %s', attempt + 1, url, e.message);
    }
  }
  throw lastErr || new Error(`download failed: ${url}`);
}

/** Write raw file atomically (.part -> rename), shard dir created on demand. */
function persistRaw(rawDir, relPath, text) {
  const abs = join(rawDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  const part = abs + '.part';
  writeFileSync(part, text, 'utf8');
  renameSync(part, abs);
  return abs;
}

/** Read only precision-safe envelope fields from a parsed report body. */
export function readEnvelope(reportId, body) {
  const b = body && body.battle ? body.battle : {};
  return {
    reportId: String(reportId),
    logtime: Number.isFinite(body.logtime) ? body.logtime : null,
    pointStr: typeof body.pointStr === 'string' ? body.pointStr : null,
    srcPointStr: typeof body.srcPointStr === 'string' ? body.srcPointStr : null,
    fightType: Number.isFinite(b.fightType) ? b.fightType : null,
    fightType2: typeof b.fightType2 === 'string' ? b.fightType2 : null,
    result: Number.isFinite(b.result) ? b.result : null,
    stage: Number.isFinite(b.stage) ? b.stage : null,
    ver: Number.isFinite(b.ver) ? b.ver : null,
    serverVersion: typeof b.serverVersion === 'string' ? b.serverVersion : null,
    extraFlag: b.extraFlag ?? null,
  };
}

/**
 * Fetch one report by id. If already on disk and `force` is false, re-validate
 * from disk (no network) but still upsert the envelope.
 * @param {import('better-sqlite3').Database} db
 * @param {any} cfg
 * @param {string} reportId
 * @param {{ force?:boolean }} [opts]
 * @returns {Promise<{ reportId:string, rawPath:string, fromCache:boolean }>}
 */
export async function fetchReport(db, cfg, reportId, opts = {}) {
  const rel = rawRelPath(reportId);
  const abs = join(cfg._paths.rawDir, rel);
  let text;
  let fromCache = false;

  if (!opts.force && existsSync(abs)) {
    text = readFileSync(abs, 'utf8');
    fromCache = true;
    log.info('cache hit %s (skip network)', reportId);
  } else {
    const url = buildReportUrl(reportId, cfg.oss);
    log.info('download %s', url);
    text = await download(url, cfg.fetch);
    persistRaw(cfg._paths.rawDir, rel, text);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new Error(`report ${reportId} body is not valid JSON: ${e.message}`, { cause: e });
  }
  if (!body || !body.battle) throw new Error(`report ${reportId} missing 'battle' root object`);

  const env = readEnvelope(reportId, body);
  env.rawPath = rel; // store path relative to rawDir for portability
  upsertReportFetched(db, env);

  log.info('%s %s -> %s', fromCache ? 'ok(cached)' : 'ok(fetched)', reportId, rel);
  return { reportId: String(reportId), rawPath: rel, fromCache };
}
