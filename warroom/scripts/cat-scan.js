// List ingested dict tables + find candidate tables for the still-undecoded ids/attrs.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
const db = openDb(loadConfig());
const cats = db
  .prepare(
    "SELECT DISTINCT category FROM dict_entries WHERE category LIKE 'table:%' ORDER BY category",
  )
  .all()
  .map((r) => r.category.slice(6));
const re =
  /attr|proper|score|chip|mecha|enigma|beast|talent|science|master|form|equip|decorat|sublime|ctc|collect|skin|buff|effect|relic|type/i;
console.log('total tables ingested:', cats.length);
console.log('candidates:', cats.filter((t) => re.test(t)).join(', '));
db.close();
