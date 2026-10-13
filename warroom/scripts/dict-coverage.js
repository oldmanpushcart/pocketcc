// Phase 2b coverage scout: enumerate (a) every still-raw dict id in our DB, (b) all config
// tables, and (c) auto-discover which table holds each id as a row key + whether it has a name.
// Usage: node scripts/dict-coverage.js
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decryBinary, parseTablePack, parseLocale, deriveVersion } from '../src/dict.js';

const cfg = loadConfig();
const db = openDb(cfg);
const step = Number.isFinite(cfg.dict.xorStep) ? cfg.dict.xorStep : 6;

// --- decode the cached packs (authoritative .raw written by cli.js dict) ---
const tRaw = readFileSync(
  join(cfg._paths.dictDir, `table_${deriveVersion(cfg.dict.tableUrl)}.raw`),
);
const lRaw = readFileSync(
  join(cfg._paths.dictDir, `locale_${deriveVersion(cfg.dict.localeUrl)}.raw`),
);
const tables = parseTablePack(decryBinary(tRaw, step).split('^--')[1]);
const locale = parseLocale(decryBinary(lRaw, step).split('^--')[1]);

// --- DB: distinct dict ids per field ---
const distinct = (sql) => db.prepare(sql).all();
const fields = {
  'side_units.army_id': distinct(
    'SELECT army_id id, COUNT(*) n FROM side_units WHERE army_id IS NOT NULL GROUP BY army_id ORDER BY n DESC',
  ),
  'sides.career': distinct(
    'SELECT career id, COUNT(*) n FROM sides WHERE career IS NOT NULL GROUP BY career ORDER BY n DESC',
  ),
  'events.skill': distinct(
    'SELECT skill id, COUNT(*) n FROM battle_events WHERE skill NOT NULL AND skill<>0 GROUP BY skill ORDER BY n DESC LIMIT 30',
  ),
  'events.hero': distinct(
    'SELECT hero id, COUNT(*) n FROM battle_events WHERE hero NOT NULL AND hero<>0 GROUP BY hero ORDER BY n DESC LIMIT 30',
  ),
  'events.buff_id': distinct(
    'SELECT buff_id id, COUNT(*) n FROM battle_events WHERE buff_id NOT NULL AND buff_id<>0 GROUP BY buff_id ORDER BY n DESC LIMIT 30',
  ),
  'events.tl': distinct(
    'SELECT tl id, COUNT(*) n FROM battle_events WHERE tl NOT NULL AND tl<>0 GROUP BY tl ORDER BY n DESC LIMIT 30',
  ),
};

// --- auto-discover: for the top id of each field, which tables contain it & do they have a name col ---
function discover(id, limit = 6) {
  const hits = [];
  const key = String(id);
  for (const [name, t] of tables) {
    const row = t.rows.get(key);
    if (row) {
      const nm = row.name ?? row.new_name ?? row.title;
      const zh = nm && locale.get(String(nm));
      hits.push({ table: name, hasName: nm !== undefined, nameKey: nm, zh });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

const report = [];
const p = (...a) => report.push(a.join(' '));
p(`config tables=${tables.size}  locale keys=${locale.size}\n`);
for (const [field, rows] of Object.entries(fields)) {
  p(`=== ${field} === distinct=${rows.length} (showing top ${Math.min(rows.length, 6)})`);
  for (const r of rows.slice(0, 6)) {
    const hits = discover(r.id);
    const best = hits.find((h) => h.hasName) || hits[0];
    p(
      `  id=${String(r.id).padStart(8)} n=${String(r.n).padStart(4)}  ->  ${best ? `${best.table} ${best.zh ? '(中文:' + best.zh + ')' : best.hasName ? '(name=' + best.nameKey + ')' : '(无名键)'}` : '❓未在任何表命中'}`,
    );
    if (hits.length > 1) p(`      候选表: ${hits.map((h) => h.table).join(', ')}`);
  }
  p('');
}

// also list all table names for manual scanning
const names = [...tables.keys()].sort();
writeFileSync('data/table-names.txt', names.join('\n') + '\n', 'utf8');
writeFileSync('data/dict-coverage.out', report.join('\n') + '\n', 'utf8');
db.close();
console.log('wrote data/dict-coverage.out + data/table-names.txt');
