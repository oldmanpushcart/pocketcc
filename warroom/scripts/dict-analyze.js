// Feasibility analysis for a "universal dictionary": instead of curating config.dict.tables,
// could we persist ONE generic (namespace,id)->name dict covering the whole id->display space?
// Measures: current persisted categories; full-pack table/row totals; how many tables actually
// carry a display-name column; locale hit-rate; cross-table id collisions (namespace need).
// Usage: node scripts/dict-analyze.js
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decryBinary, parseTablePack, parseLocale, deriveVersion } from '../src/dict.js';

const NAME_COLS = ['name', 'new_name', 'title', 'show_name', 'cn_name'];
const cfg = loadConfig();
const db = openDb(cfg);
const step = Number.isFinite(cfg.dict.xorStep) ? cfg.dict.xorStep : 6;

const tRaw = readFileSync(
  join(cfg._paths.dictDir, `table_${deriveVersion(cfg.dict.tableUrl)}.raw`),
);
const lRaw = readFileSync(
  join(cfg._paths.dictDir, `locale_${deriveVersion(cfg.dict.localeUrl)}.raw`),
);
const tables = parseTablePack(decryBinary(tRaw, step).split('^--')[1]);
const locale = parseLocale(decryBinary(lRaw, step).split('^--')[1]);

const out = [];
const log = (...a) => out.push(a.join(' '));

// (1) what we actually persist today
log('=== current dict_entries categories ===');
for (const r of db
  .prepare('SELECT category, COUNT(*) n FROM dict_entries GROUP BY category ORDER BY n DESC')
  .all()) {
  log(`  ${r.category.padEnd(22)} rows=${r.n}`);
}
const dbBytes = statSync(cfg._paths.dbPath).size;
log(`  db file on disk ~ ${(dbBytes / 1048576).toFixed(1)} MB\n`);

// (2) full-pack landscape
let totalRows = 0;
let nameTables = 0;
let nameRows = 0;
let localeHits = 0;
const idSpace = new Map(); // id -> Set<tableName> to gauge collisions
const noNameBigTables = [];
for (const [tn, t] of tables) {
  totalRows += t.rows.size;
  const nmCols = t.header.filter((c) => NAME_COLS.includes(c));
  for (const [id] of t.rows) {
    if (!idSpace.has(id)) idSpace.set(id, new Set());
    idSpace.get(id).add(tn);
  }
  if (nmCols.length) {
    nameTables++;
    for (const [, row] of t.rows) {
      let has = false;
      for (const c of nmCols)
        if (typeof row[c] === 'string' && row[c]) {
          has = true;
          break;
        }
      if (has) {
        nameRows++;
        for (const c of nmCols) {
          const k = row[c];
          if (typeof k === 'string' && k && locale.has(k)) {
            localeHits++;
            break;
          }
        }
      }
    }
  } else if (t.rows.size >= 500) {
    noNameBigTables.push(`${tn}(${t.rows.size})`);
  }
}
log('=== full pack (1488 tables) ===');
log(`  total tables        : ${tables.size}`);
log(`  total rows          : ${totalRows.toLocaleString('en-US')}`);
log(`  tables w/ name col  : ${nameTables}  (${((nameTables / tables.size) * 100).toFixed(0)}%)`);
log(`  rows w/ a name value: ${nameRows.toLocaleString('en-US')}`);
log(
  `  those names locale-hit: ${localeHits.toLocaleString('en-US')} (${((localeHits / nameRows) * 100).toFixed(0)}%)`,
);
log(`  huge NO-name tables (>=500 rows, pure game data): ${noNameBigTables.length}`);
log(`    e.g. ${noNameBigTables.slice(0, 12).join(', ')}\n`);

// (3) cross-table id collisions -> why a single flat key is unsafe
let coll = 0;
let maxColl = 0;
let maxCollId = '';
for (const [id, set] of idSpace) {
  if (set.size > 1) coll++;
  if (set.size > maxColl) {
    maxColl = set.size;
    maxCollId = id;
  }
}
log('=== id-space collisions (same numeric id across tables) ===');
log(`  distinct ids        : ${idSpace.size.toLocaleString('en-US')}`);
log(
  `  ids in >1 table     : ${coll.toLocaleString('en-US')} (${((coll / idSpace.size) * 100).toFixed(0)}%)`,
);
log(`  worst id ${maxCollId} appears in ${maxColl} tables`);
log(`  => a flat id-only dict is UNSAFE; must key by (namespace, id)\n`);

// (4) size estimate for "persist every name-bearing table as a generic dict"
const est = Math.round(nameRows * 120); // ~120 bytes/row (namespace+id+zh name) conservative
log('=== if we auto-persist a universal (ns,id)->zh dict ===');
log(`  rows to store       : ${nameRows.toLocaleString('en-US')}  (vs 53,300 today)`);
log(`  rough size           : ~${(est / 1048576).toFixed(1)} MB`);

db.close();
writeFileSync('data/dict-analyze.out', out.join('\n') + '\n', 'utf8');
console.log('wrote data/dict-analyze.out');
