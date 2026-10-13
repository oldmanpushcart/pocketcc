// Phase 2b inspector: for candidate tables, print header + row count, and resolve a sample id
// through every name-ish column so we learn which column the resolver must target per table.
// Usage: node scripts/dict-inspect.js
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decryBinary, parseTablePack, parseLocale, deriveVersion } from '../src/dict.js';

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

const NAME_COLS = [
  'name',
  'new_name',
  'title',
  'show_name',
  'cn_name',
  'desc',
  'des',
  'detail',
  'name_str',
];
const out = [];
const log = (...a) => {
  out.push(a.join(' '));
};

function inspect(tableName, sampleIds) {
  const t = tables.get(tableName);
  if (!t) return log(`[${tableName}] NOT FOUND`);
  const nameCols = t.header.filter((c) => NAME_COLS.includes(c));
  log(`\n[${tableName}] rows=${t.rows.size} nameCols=[${nameCols.join(',')}]`);
  log(`  header: ${t.header.slice(0, 16).join(',')}`);
  for (const id of sampleIds) {
    const row = t.rows.get(String(id));
    if (!row) {
      log(`  id=${id}: MISS`);
      continue;
    }
    const parts = nameCols
      .map((c) => {
        const v = row[c];
        return typeof v === 'string' && v ? `${c}="${v}"->${locale.get(v) ?? '(no locale)'}` : null;
      })
      .filter(Boolean);
    log(`  id=${id}: ${parts.join('  |  ') || '(no name col value)'}`);
  }
}

// sample ids pulled from the real reports/DB
inspect('selection_v2', [72001, 72002]);
inspect('effect_buff', [992341, 992913, 2204202]);
inspect('status_buff', [992341, 520010, 1145]);
inspect('hero', [240, 241, 169]);
inspect('hero_skill', [10169, 10234, 941212, 1690210]);
inspect('skill', [10169, 941212]);
inspect('hero_equip', [100104, 100204]);
inspect('item', [403100, 910041, 100104]);
inspect('formationV2', [1003]);
inspect('formationV2_mastery', [1, 2, 11]);
inspect('formationV2_science', [1, 2, 3]);
inspect('enhance_mastery', [116, 219, 312]);

writeFileSync('data/dict-inspect.out', out.join('\n') + '\n', 'utf8');
db.close();
console.log('wrote data/dict-inspect.out');
