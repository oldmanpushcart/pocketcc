// Phase 2b coverage verifier: for every dict-bearing report field, resolve distinct ids from the
// DB through REPORT_DICT_FIELDS -> resolveName, and report the 中文名 hit-rate. Also spot-checks
// ids that live inside side_players JSON blobs (equip/item/formation).
// Usage: node scripts/dict-check.js
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { currentDictVersion, resolveName, dictRow, REPORT_DICT_FIELDS } from '../src/dict.js';

const out = [];
const log = (...a) => out.push(a.join(' '));

const db = openDb(loadConfig());
const v = currentDictVersion(db);
log(`active dict_version = ${v}\n`);

/** scalar field -> distinct id query */
const FIELD_SOURCES = {
  career:
    'SELECT career id, COUNT(*) n FROM sides WHERE career IS NOT NULL AND career<>0 GROUP BY career',
  army_id:
    'SELECT army_id id, SUM(uuid_count) n FROM side_units WHERE army_id IS NOT NULL GROUP BY army_id',
  hero: 'SELECT hero id, COUNT(*) n FROM battle_events WHERE hero NOT NULL AND hero<>0 GROUP BY hero',
  skill:
    'SELECT skill id, COUNT(*) n FROM battle_events WHERE skill NOT NULL AND skill<>0 GROUP BY skill',
  buff_id:
    'SELECT buff_id id, COUNT(*) n FROM battle_events WHERE buff_id NOT NULL AND buff_id<>0 GROUP BY buff_id',
};

for (const [field, sql] of Object.entries(FIELD_SOURCES)) {
  const map = REPORT_DICT_FIELDS[field];
  const rows = db.prepare(sql).all();
  let hit = 0;
  const lines = [];
  for (const r of rows) {
    const zh = resolveName(db, v, map.table, r.id);
    if (zh && zh !== String(r.id)) hit++;
    lines.push(
      `    id=${String(r.id).padStart(8)} n=${String(r.n).padStart(5)} -> ${zh ?? '(null)'}`,
    );
  }
  const rate = rows.length ? ((hit / rows.length) * 100).toFixed(0) : '-';
  log(
    `=== ${field} -> table:${map.table} === ids=${rows.length} named=${hit} (${rate}%)${map.note ? '  [' + map.note + ']' : ''}`,
  );
  log(lines.slice(0, 8).join('\n'));
  log('');
}

// JSON-blob spot checks: ids we know appear in side_players arrays
log('=== JSON-blob id spot checks (equip/item/formation) ===');
for (const [field, id] of [
  ['equip_id', 100104],
  ['item_id', 403100],
  ['formation_id', 1003],
]) {
  const map = REPORT_DICT_FIELDS[field];
  log(`  ${field}=${id} [${map.table}] -> ${resolveName(db, v, map.table, id) ?? '(null)'}`);
}

// buff attrs (no name, but confirm structural row landed)
log('\n=== buff attrs (effect_buff, no display name) ===');
const b = dictRow(db, v, 'effect_buff', 992341);
log(
  `  buff 992341 attrs: category=${b?.category} type=${b?.type} value_type=${b?.value_type} op=${b?.op}`,
);

db.close();
writeFileSync('data/dict-check.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/dict-check.out (utf8)');
