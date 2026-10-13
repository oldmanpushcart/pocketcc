// Phase 2b dictionary layer: pull the game's CDN config-table pack + locale pack,
// decode them WITHOUT a browser (pure CPU), and land them in `dict_entries` so the
// Phase 2a structured tables can be enriched (armyId -> 兵种名, skillId -> 技能名, ...).
//
// Decode algorithm reverse-engineered & byte-validated from the game bundle:
//   RemoteAssertUtils.decryBinary(buf, step): XOR 255 into every `step`-th byte, UTF-8 decode.
//   RemoteConfigLoader (NewCfgV2, loaderType=1/.txt): step = 6.
//   Table pack text -> split "^--" take [1] -> split "@|@" per table -> each "^@^" = [name, body, dup?]
//     body -> split "^|": [0]=header(` -cols), [1]=coltype, [2+]=rows keyed by first col; cells by coltype;
//     string cell "^#KEY" resolves via that table's dup map.
//   Locale text -> split "^--" take [1] -> split "^|" each "key=value" (value may contain "=").
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLog } from './log.js';

const log = createLog('DICT');

/** RemoteAssertUtils.decryBinary: XOR 255 every `step`-th byte, then UTF-8 decode. */
export function decryBinary(buf, step) {
  const b = Uint8Array.from(buf); // copy — never mutate the caller's buffer
  if (step <= 0) return Buffer.from(b).toString('utf8');
  for (let a = 0; a < b.length;) {
    b[a] = 255 ^ b[a];
    a += step;
  }
  return Buffer.from(b).toString('utf8');
}

/** Parse one table body string into { header, coltype, dup, rows:Map<id, obj> }, game-faithful. */
export function parseTable(name, bodyText, dupText) {
  const recs = bodyText.split('^|');
  const header = (recs[0] || '').split('`');
  const coltype = (recs[1] || '').split('`');
  /** @type {Record<string,string>} */
  const dup = {};
  if (dupText)
    for (const d of dupText.split('^|')) {
      const t = d.split('`');
      if (t.length === 2) dup[t[0]] = t[1];
    }
  const cell = (raw, col) => {
    const ct = coltype[col];
    if (ct === 'int') return raw === '' || raw === '0' ? 0 : parseInt(raw, 10) || 0;
    if (ct === 'float' || ct === 'double' || ct === 'long')
      return raw === '' || raw === '0' ? 0 : parseFloat(raw) || 0;
    if (typeof raw === 'string' && raw.startsWith('^#')) {
      const k = raw.slice(2);
      return dup[k] !== undefined ? dup[k] : raw;
    }
    return raw;
  };
  /** @type {Map<string, Record<string, any>>} */
  const rows = new Map();
  for (let i = 2; i < recs.length; i++) {
    const line = recs[i];
    if (!line) continue;
    const cols = line.split('`');
    const id = cols[0];
    if (!id) continue;
    /** @type {Record<string, any>} */
    const o = {};
    for (let c = 0; c < header.length; c++) o[header[c]] = cell(c < cols.length ? cols[c] : '', c);
    rows.set(id, o);
  }
  return { name, header, coltype, rows };
}

/** Full pack text (post "^--" strip) -> Map<tableName, parsedTable>. */
export function parseTablePack(text) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const chunk of text.split('@|@')) {
    const p = chunk.split('^@^');
    if (p.length < 2 || !p[0]) continue;
    out.set(p[0], parseTable(p[0], p[1], p[2]));
  }
  return out;
}

/** Locale pack text (post "^--" strip) -> Map<key, 中文>. Value keeps any inner "=". */
export function parseLocale(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const rec of text.split('^|')) {
    if (!rec) continue;
    const eq = rec.indexOf('=');
    if (eq <= 0) continue;
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
  }
  return out;
}

/** Take the meaningful pack body: decoded text "^--<body>^--<tail>" -> <body>. */
function packBody(decoded) {
  const parts = decoded.split('^--');
  return parts.length >= 2 ? parts[1] : decoded;
}

/** Extract the version segment right after "/newcfg2/" (DynResVer / LangVer). */
export function deriveVersion(url) {
  const m = /\/newcfg2\/([^/]+)\//.exec(url || '');
  return m ? m[1] : 'unknown';
}

/** Download bytes (timeout+retries) with atomic cache to `cacheRawPath`. */
async function downloadBytes(url, cacheRawPath, opts, force) {
  if (!force && existsSync(cacheRawPath)) {
    log.info('dict cache hit %s', cacheRawPath);
    return readFileSync(cacheRawPath);
  }
  let lastErr;
  for (let attempt = 0; attempt <= (opts.retries ?? 2); attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 30000) });
      if (res.status === 404)
        throw Object.assign(
          new Error(`not found (404): ${url}（链接随版本过期，请更新 config.dict URL）`),
          {
            fatal: true,
          },
        );
      if (!res.ok) throw new Error(`http ${res.status}: ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(cacheRawPath), { recursive: true });
      const part = cacheRawPath + '.part';
      writeFileSync(part, buf);
      renameSync(part, cacheRawPath);
      return buf;
    } catch (e) {
      if (/** @type {any} */ (e).fatal) throw e;
      lastErr = e;
      log.debug('dict attempt %d failed for %s: %s', attempt + 1, url, e.message);
    }
  }
  throw lastErr || new Error(`dict download failed: ${url}`);
}

/**
 * Download + decode + ingest the table pack and locale pack into `dict_entries`.
 * Idempotent: fully rewrites the (dict_version) partition in one transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {any} cfg
 * @param {{ force?:boolean }} [opts]
 */
export async function loadDict(db, cfg, opts = {}) {
  const d = cfg.dict;
  if (!d || !d.tableUrl || !d.localeUrl)
    throw new Error('config.dict missing tableUrl/localeUrl (从游戏 DevTools 复制 CDN 链接)');
  const step = Number.isFinite(d.xorStep) ? d.xorStep : 6;
  const tVer = deriveVersion(d.tableUrl);
  const lVer = deriveVersion(d.localeUrl);
  const dictVersion = `table-${tVer}+locale-${lVer}`;
  const dictDir = cfg._paths.dictDir;
  mkdirSync(dictDir, { recursive: true });

  const tBuf = await downloadBytes(
    d.tableUrl,
    join(dictDir, `table_${tVer}.raw`),
    cfg.fetch,
    opts.force,
  );
  const lBuf = await downloadBytes(
    d.localeUrl,
    join(dictDir, `locale_${lVer}.raw`),
    cfg.fetch,
    opts.force,
  );

  const tables = parseTablePack(packBody(decryBinary(tBuf, step)));
  const locale = parseLocale(packBody(decryBinary(lBuf, step)));
  log.info('decoded tables=%d localeKeys=%d', tables.size, locale.size);

  const wanted = Array.isArray(d.tables) && d.tables.length ? d.tables : [...tables.keys()];
  const ins = db.prepare(
    'INSERT OR REPLACE INTO dict_entries (dict_version, category, key, value) VALUES (?,?,?,?)',
  );

  const run = db.transaction(() => {
    db.prepare('DELETE FROM dict_entries WHERE dict_version = ?').run(dictVersion);
    let rowCount = 0;
    const missing = [];
    for (const tn of wanted) {
      const t = tables.get(tn);
      if (!t) {
        missing.push(tn);
        continue;
      }
      for (const [id, row] of t.rows) {
        ins.run(dictVersion, `table:${tn}`, id, JSON.stringify(row));
        rowCount++;
      }
    }
    // locale: only keys we can actually reference (avoid 100k+ dead rows) — but keep it simple &
    // complete enough for enrichment: store every locale key once.
    for (const [k, v] of locale) ins.run(dictVersion, 'locale', k, v);
    // meta marker so queries can discover the active version cheaply.
    ins.run(dictVersion, '__meta__', 'version', dictVersion);
    log.info(
      'ingested table rows=%d, locale rows=%d, missing tables=%s',
      rowCount,
      locale.size,
      missing.join(',') || '-',
    );
  });
  run();

  db.prepare('UPDATE reports SET dict_version = ? WHERE dict_version IS NULL').run(dictVersion);
  return { dictVersion, tables: wanted.filter((t) => tables.has(t)), localeKeys: locale.size };
}

/** Active dict_version (the most recently ingested marker). Returns null if none loaded. */
export function currentDictVersion(db) {
  const r = db
    .prepare(
      "SELECT dict_version FROM dict_entries WHERE category='__meta__' AND key='version' ORDER BY rowid DESC LIMIT 1",
    )
    .get();
  return r ? r.dict_version : null;
}

/** Read a parsed table row object by (version, table, id). */
export function dictRow(db, version, table, id) {
  if (id == null) return null;
  const r = db
    .prepare('SELECT value FROM dict_entries WHERE dict_version=? AND category=? AND key=?')
    .get(version, `table:${table}`, String(id));
  if (!r) return null;
  try {
    return JSON.parse(r.value);
  } catch {
    return null;
  }
}

/** Locale text by key (returns null if absent). */
export function localeText(db, version, key) {
  if (key == null) return null;
  const r = db
    .prepare('SELECT value FROM dict_entries WHERE dict_version=? AND category=? AND key=?')
    .get(version, 'locale', String(key));
  return r ? r.value : null;
}

/**
 * Resolve a display name for a dict id in a table: row's `name` (or fallback col) is a locale key.
 * Falls back to the raw key when locale misses, and to null when the row is absent.
 * @param {import('better-sqlite3').Database} db
 * @param {string} version
 * @param {string} table e.g. 'army'
 * @param {number|string} id e.g. 901103
 * @param {string[]} [nameCols] columns to try, default NAME_COLS
 */
const NAME_COLS = ['name', 'new_name', 'title', 'show_name', 'cn_name'];
export function resolveName(db, version, table, id, nameCols = NAME_COLS) {
  const row = dictRow(db, version, table, id);
  if (!row) return null;
  for (const c of nameCols) {
    const key = row[c];
    if (typeof key === 'string' && key) {
      const zh = localeText(db, version, key);
      return zh || key; // raw key is still better than nothing
    }
  }
  return null;
}

/**
 * Resolve an effect_buff id into its display name + battle semantics.
 * effect_buff stores its locale key in the `string` column (NOT `name`), e.g. 9301160 ->
 * "全部单位攻击加成". value_type=10000 means 万分比 (raw_value/10000), 1 means absolute.
 * Returns null when the id is absent from the table.
 * @param {import('better-sqlite3').Database} db
 * @param {string} version
 * @param {number|string} buffId
 */
export function buffSemantics(db, version, buffId) {
  const row = dictRow(db, version, 'effect_buff', buffId);
  if (!row) return null;
  const key = typeof row.string === 'string' ? row.string : null;
  return {
    buff_id: Number(buffId),
    name: key ? localeText(db, version, key) || key : null,
    value_type: row.value_type ?? null,
    category: row.category ?? null,
    type: row.type ?? null,
    target: row.target ?? null,
    para_type1: row.paraType1 ?? null,
    para1: row.para1 ?? null,
  };
}

/**
 * Single source of truth mapping report fields (as stored by Phase 2a) to their dict table.
 * Verified against real reports: each id resolves to a row in `table`, and the name column
 * (default NAME_COLS, or `nameCols` override) holds a locale key that translates via
 * `localeText`. `effect_buff` keeps its display key in the `string` column (see buffSemantics).
 * @type {Record<string, {table:string, nameCols?:string[], note?:string}>}
 */
export const REPORT_DICT_FIELDS = {
  career: { table: 'selection_v2' }, // sides.career -> 职业名 (战斗精英/机械大师)
  army_id: { table: 'army' }, // side_units.army_id, unit_instances.army_id -> 兵种名
  hero: { table: 'hero' }, // battle_events.hero, heroList[].heroId -> 英雄名
  skill: { table: 'hero_skill' }, // battle_events.skill, skill_hurts keys -> 技能名
  buff_id: {
    table: 'effect_buff',
    nameCols: ['string'], // string 列存 locale 键 -> 中文 buff 名 (Phase 2c 实证, 推翻旧"无名"结论)
  }, // battle_events.buff_id, buff_effects.buff_id -> 加成名 + 语义
  equip_id: { table: 'hero_equip' }, // heroList[].heroEquips[].equipId -> 装备名
  item_id: { table: 'item' }, // armyEquips[].itemId -> 道具名
  formation_id: { table: 'formationV2' }, // formationV2.id -> 军阵名
  // Phase 2c 编配视图 (供 normalize.js 富化 JSON 与归一 buff_effects)
  talent_id: { table: 'talent' }, // heroList[].talents[].talentId -> 天赋名 (真身= talent.buff -> effect_buff)
  mecha_part_id: { table: 'Mecha_part' }, // mechas[].parts[] -> 机甲部位名
  mecha_chip_id: { table: 'Mecha_chip' }, // mechas[].chips[].chipId -> 芯片名 (rndAttrs 码= chip_buff_rd 下标)
  enigma_beast_id: { table: 'enigma_beast' }, // enigmas.beastDatas[].cfg -> 异能兽配置
  hero_equip_rd_id: { table: 'hero_equip_buff_rd' }, // heroEquips[].infos[].templateId -> buff_id (type=1 随机词条)
  army_equip_suit_id: { table: 'army_equip_suit' }, // newArmyEquips suit -> equip_attr "buffid,value"
  awaken_skill_id: {
    table: 'hero_awakening_skill',
    note: '战报 awakenSkillMap 的 key 是 awakening_skill_id 列(非 PK id)，且按 skill_level 有多行，须走 normalize.enrichHeroes 的复合索引，勿用 resolveName(PK) 直查',
  }, // heroList[].awakenSkillMap -> 觉醒技能(名/等级/授予技能/属性描述)
};
