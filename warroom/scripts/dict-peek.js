// Phase 2b probe #3: faithfully reproduce TableManager.doParseTable/parseRow/parseCell on the
// cached decoded pack, then peek specific tables by id. Confirms whether `name` is an i18n key
// and whether "^#" cells resolve via the per-table dup map.
// Usage: node scripts/dict-peek.js
import { readFileSync } from 'node:fs';

const dec = readFileSync('data/dict/config_optim2.dec.txt', 'utf8');

// Build name -> {rows: Map<id, obj>, dup: Map} exactly like the game.
function loadAll(decText) {
  const out = {};
  for (const ch of decText.split('@|@')) {
    const p = ch.split('^@^');
    if (p.length < 2) continue;
    const name = p[0];
    const recs = p[1].split('^|');
    const header = (recs[0] || '').split('`');
    const coltype = (recs[1] || '').split('`');
    // dup raw -> map (from p[2]); "^#" cells look values up here
    const dup = {};
    if (p[2])
      for (const d of p[2].split('^|')) {
        const t = d.split('`');
        if (t.length === 2) dup[t[0]] = t[1];
      }
    const cell = (raw, col) => {
      let v = raw;
      const ct = coltype[col];
      if (ct === 'int') v = raw === '' || raw === '0' ? 0 : parseInt(raw) || 0;
      else if (ct === 'float' || ct === 'double' || ct === 'long')
        v = raw === '' || raw === '0' ? 0 : parseFloat(raw) || 0;
      else if (typeof raw === 'string' && raw.startsWith('^#')) {
        const k = raw.slice(2);
        v = dup[k] !== undefined ? dup[k] : raw;
      }
      return v;
    };
    const rows = new Map();
    for (let i = 2; i < recs.length; i++) {
      const line = recs[i];
      if (!line) continue;
      const cols = line.split('`');
      if (!cols[0]) continue;
      const o = {};
      for (let c = 0; c < header.length; c++)
        o[header[c]] = cell(c < cols.length ? cols[c] : '', c);
      rows.set(cols[0], o);
    }
    out[name] = { rows, header, dup };
  }
  return out;
}

const T = loadAll(dec);
console.log(`tables=${Object.keys(T).length}`);

const peek = (tname, ids) => {
  const t = T[tname];
  if (!t) return console.log(`\n[${tname}] NOT FOUND`);
  console.log(`\n[${tname}] rows=${t.rows.size} header=${t.header.join(',')}`);
  for (const id of ids) {
    const r = t.rows.get(String(id));
    console.log(`  id=${id} -> ${r ? JSON.stringify(r).slice(0, 240) : 'MISS'}`);
  }
};

// armyIds observed in the parsed reports:
peek('army', [901103, 903103, 902103, 504401, 504531, 507241, 904103, 30101, 50103]);
peek('hero_skill', [1]);
// career observed 72001/72002 — look for a table that has these ids
for (const [n, t] of Object.entries(T))
  if (t.rows.has('72001') || t.rows.has('72002'))
    console.log(`\ncareer-candidate table: ${n} (rows=${t.rows.size})`);
