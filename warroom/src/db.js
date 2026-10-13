// SQLite handle: open db, run versioned migrations, expose typed helpers.
// All 64-bit ids are bound/stored as TEXT. Large metric numbers are stored as
// INTEGER via safeBindNum (BigInt when >2^53, else Number) to avoid precision loss.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { MIGRATIONS } from './schema.js';
import { createLog } from './log.js';

const log = createLog('DB');
const MAX_SAFE = 9007199254740991n; // 2^53-1

/**
 * @param {import('./config.js').any} cfg
 * @returns {Database.Database}
 */
export function openDb(cfg) {
  mkdirSync(cfg._paths.dataDir, { recursive: true });
  mkdirSync(cfg._paths.rawDir, { recursive: true });
  mkdirSync(cfg._paths.dictDir, { recursive: true });

  const db = new Database(cfg._paths.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Apply pending migrations in order, bumping user_version. */
function migrate(db) {
  const cur = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version <= cur) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.pragma(`user_version = ${m.version}`);
    })();
    log.info('applied migration v%d', m.version);
  }
}

/** Convert a JS value to an INTEGER-bindable (BigInt over 2^53, else Number). */
export function toInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v > MAX_SAFE || v < -MAX_SAFE ? v : Number(v);
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v);
  const s = String(v);
  // scientific-notation strings ("3.2E13") and big integer literals
  if (/e[+-]?\d+/i.test(s)) return Math.round(Number(s));
  if (/^-?\d+$/.test(s)) {
    const bi = BigInt(s);
    return bi > MAX_SAFE || bi < -MAX_SAFE ? bi : Number(bi);
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Convert to a REAL-bindable number (float powers); null when absent/non-numeric. */
export function toReal(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** JSON column helper: store as TEXT, null passthrough. */
export function toJson(v) {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

/**
 * Upsert a report envelope right after download (fetch phase).
 * Only信封 fields that are cheap/safe to read are set here; the heavy structured
 * parse (sides/units/events/players) is Phase 2 and fills parsed_at.
 * @param {Database.Database} db
 * @param {{ reportId:string, rawPath:string, logtime?:number, fightType?:number,
 *   fightType2?:string, result?:number, stage?:number, ver?:number,
 *   serverVersion?:string, pointStr?:string, srcPointStr?:string,
 *   extraFlag?:any, dictVersion?:string }} r
 */
export function upsertReportFetched(db, r) {
  const stmt = db.prepare(`
    INSERT INTO reports (
      report_id, logtime, point_str, src_point_str, fight_type, fight_type2,
      result, stage, ver, server_version, extra_flag, raw_path, dict_version,
      fetched_at, parsed_at
    ) VALUES (
      $report_id, $logtime, $point_str, $src_point_str, $fight_type, $fight_type2,
      $result, $stage, $ver, $server_version, $extra_flag, $raw_path, $dict_version,
      $fetched_at, NULL
    )
    ON CONFLICT(report_id) DO UPDATE SET
      logtime=excluded.logtime, point_str=excluded.point_str,
      src_point_str=excluded.src_point_str, fight_type=excluded.fight_type,
      fight_type2=excluded.fight_type2, result=excluded.result, stage=excluded.stage,
      ver=excluded.ver, server_version=excluded.server_version,
      extra_flag=excluded.extra_flag, raw_path=excluded.raw_path,
      dict_version=COALESCE(excluded.dict_version, reports.dict_version),
      fetched_at=excluded.fetched_at
  `);
  stmt.run({
    report_id: String(r.reportId),
    logtime: toInt(r.logtime ?? null),
    point_str: r.pointStr ?? null,
    src_point_str: r.srcPointStr ?? null,
    fight_type: toInt(r.fightType ?? null),
    fight_type2: r.fightType2 ?? null,
    result: toInt(r.result ?? null),
    stage: toInt(r.stage ?? null),
    ver: toInt(r.ver ?? null),
    server_version: r.serverVersion ?? null,
    extra_flag: toJson(r.extraFlag ?? null),
    raw_path: r.rawPath,
    dict_version: r.dictVersion ?? null,
    fetched_at: Date.now(),
  });
}
