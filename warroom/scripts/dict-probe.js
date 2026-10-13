// Phase 2b probe #1: validate the config-table decode algorithm against REAL CDN bytes.
// Reproduces the game's RemoteTableCombineLoader path (loaderType=1, NewCfgV2, step=6):
//   raw bytes -> decryBinary(buf, 6) -> utf8 text -> split "^--" (3 parts) -> part[1]
// Usage: node scripts/dict-probe.js <url> [xorStep]
const url = process.argv[2];
if (!url) throw new Error('usage: node scripts/dict-probe.js <url> [xorStep]');
const step = Number(process.argv[3] ?? 6);

// RemoteAssertUtils.decryBinary: XOR 255 every `step`-th byte, then text-decode.
function decryBinary(buf, t) {
  const b = Uint8Array.from(buf); // copy, don't mutate source
  if (t <= 0) return Buffer.from(b).toString('utf8');
  for (let a = 0; a < b.length;) {
    b[a] = 255 ^ b[a];
    a += t;
  }
  return Buffer.from(b).toString('utf8');
}

const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
const raw = new Uint8Array(await res.arrayBuffer());
console.log(`bytes=${raw.length}  head(hex)=${Buffer.from(raw.slice(0, 16)).toString('hex')}`);

// Try a few candidate steps so we can eyeball which one yields readable text.
for (const t of [step, 0, 2, 3, 6]) {
  const txt = decryBinary(raw, t);
  const hasRec = txt.includes('^|');
  const hasPack = txt.includes('^--');
  const hasTick = txt.includes('`');
  const cjk = /[\u4e00-\u9fff]/.test(txt);
  console.log(
    `\n[step=${t}] ^|=${hasRec} ^--=${hasPack} \`=${hasTick} cjk=${cjk}  sample=${JSON.stringify(txt.slice(0, 160))}`,
  );
}
