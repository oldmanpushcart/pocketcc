// Config loader: reads warroom/config.json (falling back to config.example.json),
// then deep-expands "${VAR}" placeholders from process.env. Missing env for a
// placeholder is a hard error (fail-fast) so an empty AK is never silently used.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createLog } from './log.js';

const log = createLog('CONFIG');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Recursively expand "${VAR}" string leaves from `env`. An unset/empty env does
 * NOT abort load — it resolves to null and is recorded in `missing`, so commands
 * that don't need a secret (fetch/info) still run, while the consumer that does
 * (LLM) can fail fast at point of use. Secrets are never left as literal "${VAR}".
 * @param {any} node
 * @param {Record<string,string|undefined>} env
 * @param {string[]} missing  collects env names that were referenced but unset
 * @param {string} [path]
 * @returns {any}
 */
function expand(node, env, missing, path = '') {
  if (typeof node === 'string') {
    const m = node.match(PLACEHOLDER);
    if (!m) return node;
    const name = m[1];
    const val = env[name];
    if (val === undefined || val === '') {
      missing.push(name);
      return null;
    }
    return val;
  }
  if (Array.isArray(node)) return node.map((v, i) => expand(v, env, missing, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(node))
      out[k] = expand(v, env, missing, path ? `${path}.${k}` : k);
    return out;
  }
  return node;
}

/**
 * Load and env-expand config. Env overrides WARROOM_* are also honored for paths.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {any}
 */
export function loadConfig(env = process.env) {
  const cfgPath = join(ROOT, 'config.json');
  const examplePath = join(ROOT, 'config.example.json');
  const file = existsSync(cfgPath) ? cfgPath : examplePath;
  if (!existsSync(file)) throw new Error(`no config file: expected ${cfgPath}`);
  if (file === examplePath)
    log.warn(
      'config.json not found, falling back to config.example.json (LLM AK placeholder may be unset)',
    );

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const missing = [];
  const cfg = expand(raw, env, missing);
  if (missing.length)
    log.debug('env not set for placeholders (resolved to null until used): %s', missing.join(', '));
  cfg._missingEnv = missing;

  // Resolve relative storage paths against project root; allow env override of dataDir.
  const dataDir = env.WARROOM_DATA ? resolve(env.WARROOM_DATA) : resolve(ROOT, cfg.storage.dataDir);
  cfg._paths = {
    root: ROOT,
    dataDir,
    dbPath: resolve(dataDir, 'warroom.db'),
    rawDir: resolve(dataDir, 'raw'),
    dictDir: resolve(dataDir, 'dicts'),
  };
  return cfg;
}
