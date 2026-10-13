// 军阵探针 v3：拿一份真实 formation_v2，把 5 条子表路径全解一遍，验证命中率 + effect_buff 命名。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decryBinary, parseTablePack, parseLocale, deriveVersion } from '../src/dict.js';

const cfg = loadConfig();
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
const T = (n) => tables.get(n);
const loc = (v) => (typeof v === 'string' && v ? (locale.get(v) ?? v) : null);
const buffName = (id) => {
  const r = T('effect_buff')?.rows.get(String(id));
  if (!r) return `#${id}(无effect_buff行)`;
  return `#${id}"${loc(r.string) ?? r.string ?? '(空)'}"`;
};

// 解析三种 buff_group 格式 → [{pos, buff, val}]
//  style 'pos'    : science/level  -> "pos=id,val;pos=id,val|id,val"
//  style 'quality': quality        -> "id,val|id,val"
//  style 'mastery': mastery_buff   -> "id|val,id|val"
function parseBuffGroup(str, style) {
  const res = [];
  if (!str) return res;
  const emit = (body, pos) => {
    const sep = style === 'mastery' ? ',' : '|';
    const kv = style === 'mastery' ? '|' : ',';
    for (const one of String(body).split(sep)) {
      if (!one) continue;
      const a = one.split(kv);
      res.push({ pos, buff: a[0], val: a[1] ?? null });
    }
  };
  if (style === 'pos') {
    for (const seg of String(str).split(';')) {
      if (!seg) continue;
      if (seg.includes('=')) {
        const [p, b] = seg.split('=');
        emit(b, p);
      } else emit(seg, null);
    }
  } else {
    emit(str, null);
  }
  return res;
}

// 取一份真实 formation_v2
const db = openDb(cfg);
const raw = db
  .prepare("SELECT formation_v2 f FROM side_players WHERE formation_v2 LIKE '%sciences%' LIMIT 1")
  .get();
const o = JSON.parse(raw.f);
log('== 真实 formation_v2 ==\n' + JSON.stringify(o, null, 1));

// 1) level
const FL = T('formationV2_level');
let hitLvl = null;
for (const [, r] of FL.rows) if (r.formationV2_id === o.id && r.level === o.lv) hitLvl = r;
log('\n-- formationV2_level(id=' + o.id + ',lv=' + o.lv + ') --');
if (hitLvl) {
  for (const g of parseBuffGroup(hitLvl.buff_group_inside, 'pos'))
    log(`  inside pos=${g.pos} ${buffName(g.buff)} val=${g.val}`);
  for (const g of parseBuffGroup(hitLvl.buff_group_outside, 'pos'))
    log(`  outside pos=${g.pos} ${buffName(g.buff)} val=${g.val}`);
} else log('  MISS');

// 2) quality
const FQ = T('formationV2_quality');
let hitQ = null;
for (const [, r] of FQ.rows) if (r.formationV2_id === o.id && r.level === o.quality) hitQ = r;
log('\n-- formationV2_quality(id=' + o.id + ',quality=' + o.quality + ') --');
if (hitQ) {
  for (const g of parseBuffGroup(hitQ.buff_group_inside, 'quality'))
    log(`  inside ${buffName(g.buff)} val=${g.val}`);
  for (const g of parseBuffGroup(hitQ.buff_group_outside, 'quality'))
    log(`  outside ${buffName(g.buff)} val=${g.val}`);
} else log('  MISS');

// 3) sciences
const FS = T('formationV2_science');
log('\n-- formationV2_science per group/level --');
const distinct = new Map();
for (const [, r] of FS.rows) {
  const k = `${r.type}/${r.group}`;
  if (!distinct.has(k)) distinct.set(k, []);
  distinct.get(k).push(r.level);
}
log(
  '  (type/group)→levels 概览: ' +
    [...distinct].map(([k, v]) => `${k}:${Math.min(...v)}-${Math.max(v)}`).join('  '),
);
for (const [gk, gv] of Object.entries(o.sciences || {})) {
  let hit = null;
  for (const [, r] of FS.rows) if (String(r.group) === gk && r.level === gv) hit = r;
  const parts = hit
    ? parseBuffGroup(hit.buff_group, 'pos').map((g) => `pos=${g.pos} ${buffName(g.buff)}=${g.val}`)
    : ['MISS'];
  log(`  science group=${gk} lv=${gv} -> [${parts.join(' ; ')}]`);
}

// 4) masterys (position→level, 池下标)
const FM = T('formationV2_mastery');
const FMB = T('formationV2_mastery_buff');
log('\n-- masterys: position→level→mastery_buff[下标]--');
for (const [pos, lv] of Object.entries(o.masterys || {})) {
  let mrow = null;
  for (const [, r] of FM.rows)
    if (r.formationV2_id === o.id && String(r.position) === pos) mrow = r;
  if (!mrow) {
    log(`  pos=${pos}: 无 formationV2_mastery 行`);
    continue;
  }
  const pool = String(mrow.mastery_buff).split('|').filter(Boolean);
  const bid = pool[Number(lv)];
  const bb = bid ? FMB.rows.get(String(bid)) : null;
  const parts = bb
    ? parseBuffGroup(bb.buff_group_inside, 'mastery').map((g) => `${buffName(g.buff)}=${g.val}`)
    : ['(无buff)'];
  log(
    `  pos=${pos} lv=${lv} -> pool[${lv}]=${bid} "${loc(mrow.mastery_name)}" -> [${parts.join(' ; ')}]`,
  );
}

writeFileSync('data/formation-probe3.out', out.join('\n') + '\n', 'utf8');
db.close();
