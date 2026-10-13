// Phase 2c verifier: sanity-check the buff_effects ledger.
//  - per-source_view row count + name resolution rate + how many rows have a resolvable buff_id
//  - cross-view duplication: distinct buff_id that appear in >1 source_view for the same
//    (report,side) — the exact double-count risk the source_view column exists to control.
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const cfg = loadConfig();
const db = openDb(cfg);
const out = [];
const log = (...a) => out.push(a.join(' '));

const reports = db
  .prepare('SELECT COUNT(*) n, COUNT(DISTINCT report_id) d FROM buff_effects')
  .get();
log(`buff_effects rows=${reports.n} across reports=${reports.d}`);
log('');

log('== per source_view ==');
log('view                        rows   buff_id_ok  named   name%');
const byView = db
  .prepare(
    `SELECT source_view,
            COUNT(*) rows,
            SUM(buff_id IS NOT NULL) has_id,
            SUM(name IS NOT NULL) named
     FROM buff_effects GROUP BY source_view ORDER BY rows DESC`,
  )
  .all();
for (const v of byView) {
  const pct = v.rows ? Math.round((v.named / v.rows) * 100) : 0;
  log(
    v.source_view.padEnd(28),
    String(v.rows).padStart(5),
    String(v.has_id).padStart(10),
    String(v.named).padStart(7),
    String(pct).padStart(6),
  );
}

log('\n== rows with NO buff_id (unresolved views) ==');
const noId = db
  .prepare(
    `SELECT source_view, COUNT(*) c FROM buff_effects WHERE buff_id IS NULL GROUP BY source_view ORDER BY c DESC`,
  )
  .all();
if (!noId.length) log('  (none)');
for (const r of noId) log(`  ${r.source_view}: ${r.c}`);

log('\n== cross-view duplication (same report+side+buff_id in >1 view) ==');
const dup = db
  .prepare(
    `SELECT COUNT(*) pairs FROM (
       SELECT report_id, side, buff_id, COUNT(DISTINCT source_view) v
       FROM buff_effects WHERE buff_id IS NOT NULL
       GROUP BY report_id, side, buff_id HAVING v > 1
     )`,
  )
  .get();
const totalBuffs = db
  .prepare(
    `SELECT COUNT(DISTINCT report_id||side||buff_id) n FROM buff_effects WHERE buff_id IS NOT NULL`,
  )
  .get().n;
log(`  distinct (report,side,buff_id)=${totalBuffs}, appearing in >1 view=${dup.pairs}`);
log(`  => naive sum over views would over-count these ${dup.pairs} effects multiple times.`);

log('\n== sample resolved rows per view ==');
for (const v of byView) {
  const s = db
    .prepare(
      `SELECT item_ref,attr_slot,buff_id,name,raw_value,value_type FROM buff_effects
       WHERE source_view=? AND name IS NOT NULL LIMIT 3`,
    )
    .all(v.source_view);
  for (const r of s)
    log(
      `  [${v.source_view}] item=${r.item_ref ?? '-'} slot=${r.attr_slot ?? '-'} buff=${r.buff_id} "${r.name}" val=${r.raw_value} vt=${r.value_type}`,
    );
}

writeFileSync('data/normalize-check.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/normalize-check.out');
db.close();
