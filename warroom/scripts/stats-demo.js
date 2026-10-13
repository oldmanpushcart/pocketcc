// Demo query layer: prove Phase 2a/2b data is检索/统计-ready — structured tables joined
// against the decoded CDN dictionary (side_units.army_id -> army.name -> locale 中文).
// Usage: node scripts/stats-demo.js
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { currentDictVersion } from '../src/dict.js';

const db = openDb(loadConfig());
const DV = currentDictVersion(db);
const line = (t) => console.log(`\n=== ${t} ===`);
const all = (sql) => db.prepare(sql).all();

line('players aggregate (power_peak / battles / casualties)');
console.table(
  all(`SELECT uid, substr(name,1,12) name, power_peak, battles_att ba, battles_def bd,
  troops_dead td, troops_wounded tw FROM players ORDER BY power_peak DESC NULLS LAST LIMIT 20`),
);

line('reports overview (fight_type / result / parsed)');
console.table(
  all(`SELECT report_id rid, fight_type ft, result, datetime(logtime,'unixepoch','localtime') t,
  (SELECT COUNT(*) FROM battle_events e WHERE e.report_id=r.report_id) events
  FROM reports r ORDER BY logtime`),
);

line('sides: casualties & power per report');
console.table(
  all(`SELECT s.report_id rid, s.side, s.uid, s.career, s.total, s.survival, s.dead, s.wounded,
  m.att_battle_power_val apv, m.def_battle_power_val dpv
  FROM sides s JOIN battle_marches m ON m.report_id=s.report_id AND m.seq=0 LIMIT 16`),
);

line('army composition (side_units by army_id, name decoded via dict_entries + locale)');
if (!DV) console.log('  (dict not loaded — run: node cli.js dict)');
else
  console.table(
    db
      .prepare(
        `SELECT su.army_id,
           COALESCE(l.value, json_extract(d.value,'$.name'), '(miss)') AS name_zh,
           json_extract(d.value,'$.type') AS type,
           json_extract(d.value,'$.quality') AS quality,
           COUNT(*) appearances, SUM(su.uuid_count) fielded, SUM(su.dead_count) lost
         FROM side_units su
         JOIN dict_entries d ON d.category='table:army' AND d.dict_version=@v AND d.key=CAST(su.army_id AS TEXT)
         LEFT JOIN dict_entries l ON l.category='locale' AND l.dict_version=@v AND l.key=json_extract(d.value,'$.name')
         GROUP BY su.army_id HAVING fielded>0 ORDER BY fielded DESC LIMIT 15`,
      )
      .all({ v: DV }),
  );

line('process events: t distribution across all reports');
console.table(
  all(`SELECT t, COUNT(*) n, COUNT(DISTINCT report_id) reports
  FROM battle_events GROUP BY t ORDER BY n DESC LIMIT 25`),
);

db.close();
