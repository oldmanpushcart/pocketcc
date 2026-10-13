// Phase 2b probe #2: download+decode the config pack, CACHE raw & decoded, enumerate tables.
// Usage: node scripts/dict-enumerate.js <url>
//   -> data/dict/config_optim2.raw       (原始字节，永久缓存)
//   -> data/dict/config_optim2.dec.txt   (解码后的整包文本)
//   -> console: 每张表的 [名字 / 列名 / 行数]
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const url = process.argv[2];
if (!url) throw new Error('usage: node scripts/dict-enumerate.js <url>');

function decryBinary(buf, t) {
  const b = Uint8Array.from(buf);
  if (t <= 0) return Buffer.from(b).toString('utf8');
  for (let a = 0; a < b.length;) {
    b[a] = 255 ^ b[a];
    a += t;
  }
  return Buffer.from(b).toString('utf8');
}

mkdirSync('data/dict', { recursive: true });
const rawPath = 'data/dict/config_optim2.raw';
const decPath = 'data/dict/config_optim2.dec.txt';

let raw;
try {
  raw = readFileSync(rawPath);
  console.log(`(cache hit) raw=${raw.length}`);
} catch {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  raw = Buffer.from(await res.arrayBuffer());
  writeFileSync(rawPath, raw);
  console.log(`(downloaded) raw=${raw.length}`);
}

let dec;
try {
  dec = readFileSync(decPath, 'utf8');
} catch {
  const text = decryBinary(raw, 6);
  const parts = text.split('^--'); // ["", main, tail?]
  dec = parts[1] ?? text;
  writeFileSync(decPath, dec);
}
console.log(`decoded chars=${dec.length}`);

// doLoadProcess: chunks separated by "@|@" ; each chunk "^@^" -> [name, content, dup?]
const chunks = dec.split('@|@');
const tables = [];
for (const ch of chunks) {
  const p = ch.split('^@^');
  if (p.length < 2) continue;
  const name = p[0];
  const recs = p[1].split('^|');
  const header = (recs[0] || '').split('`');
  const rows = recs.length - 2;
  tables.push({ name, cols: header.length, rows, header: header.slice(0, 12).join(',') });
}
tables.sort((a, b) => b.rows - a.rows);
console.log(`\ntotal tables=${tables.length}`);
console.log('--- tables whose header mentions name/army/hero/skill/career/troop ---');
for (const t of tables) {
  if (/army|hero|skill|career|troop|soldier|name/i.test(t.name + t.header)) {
    console.log(`${String(t.rows).padStart(6)} rows | ${t.name.padEnd(22)} | ${t.header}`);
  }
}
console.log('\n--- top 40 tables by row count ---');
for (const t of tables.slice(0, 40))
  console.log(`${String(t.rows).padStart(6)} rows | ${t.name.padEnd(24)} | ${t.header}`);
