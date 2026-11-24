#!/usr/bin/env node
// warroom CLI entry. Phase 1 commands:
//   node cli.js fetch <reportId...> [--force]   download + persist + index
//   node cli.js import <file.json> <reportId>    ingest an already-saved raw file
//   node cli.js parse [reportId...]              decode raw -> structured tables (all if omitted)
//   node cli.js dict [--force]                   download+decode CDN dict packs -> dict_entries
//   node cli.js info                             db/dir status
import { join, resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { loadConfig } from './src/config.js';
import { openDb, upsertReportFetched } from './src/db.js';
import { fetchReport, readEnvelope } from './src/fetch.js';
import { parseReport } from './src/parse.js';
import { renderReportHtml } from './src/html.js';
import { loadDict, currentDictVersion } from './src/dict.js';
import { rawRelPath } from './src/link.js';
import { createLog } from './src/log.js';

const log = createLog('CLI');

function parseArgs(argv) {
  const cmds = [];
  const flags = new Set();
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a.slice(2));
    else cmds.push(a);
  }
  return { cmds, flags };
}

/** Read a raw JSON already on disk and register it (reuse fetch envelope logic). */
function importLocal(db, cfg, file, reportId) {
  const text = readFileSync(resolve(file), 'utf8');
  const body = JSON.parse(text);
  if (!body || !body.battle) throw new Error(`${file} missing 'battle' root object`);
  const rel = rawRelPath(reportId);
  const abs = join(cfg._paths.rawDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  const env = readEnvelope(reportId, body);
  env.rawPath = rel;
  upsertReportFetched(db, env);
  log.info('imported %s -> %s', file, rel);
}

function showInfo(db, cfg) {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const rawFiles = countRaw(cfg._paths.rawDir);
  console.log('[warroom] status');
  console.log('  dataDir   :', cfg._paths.dataDir);
  console.log('  db        :', cfg._paths.dbPath, existsSync(cfg._paths.dbPath) ? '' : '(missing)');
  console.log('  reports   :', count('reports'), 'indexed |', rawFiles, 'raw files on disk');
  console.log(
    '  parsed    :',
    db.prepare('SELECT COUNT(*) c FROM reports WHERE parsed_at IS NOT NULL').get().c,
  );
  const dv = currentDictVersion(db);
  console.log('  dict      :', dv ? dv : '(not loaded — run: node cli.js dict)');
  console.log('  migration : user_version =', db.pragma('user_version', { simple: true }));
}

function countRaw(rawDir) {
  let n = 0;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.json') && !e.name.endsWith('.part')) n++;
    }
  };
  walk(rawDir);
  return n;
}

async function main() {
  const { cmds, flags } = parseArgs(process.argv.slice(2));
  const cmd = cmds[0];
  const cfg = loadConfig();
  const db = openDb(cfg);

  if (cmd === 'fetch') {
    const ids = cmds.slice(1);
    if (!ids.length) throw new Error('usage: node cli.js fetch <reportId...> [--force]');
    for (const id of ids) {
      await fetchReport(db, cfg, id, { force: flags.has('force') });
    }
  } else if (cmd === 'import') {
    const [, file, reportId] = cmds;
    if (!file || !reportId) throw new Error('usage: node cli.js import <file.json> <reportId>');
    importLocal(db, cfg, file, reportId);
  } else if (cmd === 'parse') {
    const ids = cmds.slice(1);
    const targets = ids.length
      ? ids
      : db
          .prepare('SELECT report_id FROM reports ORDER BY report_id')
          .all()
          .map((r) => r.report_id);
    if (!targets.length) throw new Error('no reports to parse (fetch or import first)');
    for (const id of targets) parseReport(db, cfg, id);
  } else if (cmd === 'html') {
    const ids = cmds.slice(1);
    const targets = ids.length
      ? ids
      : db
          .prepare('SELECT report_id FROM reports WHERE parsed_at IS NOT NULL ORDER BY report_id')
          .all()
          .map((r) => r.report_id);
    if (!targets.length)
      throw new Error('no parsed reports (run: node cli.js parse [reportId...])');
    for (const id of targets) {
      const out = renderReportHtml(id);
      log.info('html %s -> %s', id, out);
    }
  } else if (cmd === 'dict') {
    const r = await loadDict(db, cfg, { force: flags.has('force') });
    console.log(
      `[dict] ${r.dictVersion}: tables=${r.tables.join(',')} localeKeys=${r.localeKeys.toLocaleString('en-US')}`,
    );
  } else if (cmd === 'info') {
    showInfo(db, cfg);
  } else {
    console.log('warroom — battle-report download/parse/analysis\n');
    console.log('  node cli.js fetch <reportId...> [--force]   download + persist + index');
    console.log('  node cli.js import <file.json> <reportId>    ingest a locally-saved raw file');
    console.log('  node cli.js parse [reportId...]              decode raw -> structured tables');
    console.log(
      '  node cli.js html [reportId...]               render 3-tab HTML workbench -> analysis/<id>.html',
    );
    console.log(
      '  node cli.js dict [--force]                   download+decode CDN dict -> dict_entries',
    );
    console.log('  node cli.js info                             db/dir status');
    if (cmd) log.warn('unknown command: %s', cmd);
  }
  db.close();
}

main().catch((e) => {
  log.warn('fatal: %s', e.stack || e.message);
  process.exitCode = 1;
});
