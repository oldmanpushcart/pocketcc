/**
 * 协议常量扫描器（纯函数，无副作用）—— 注册表抽取器与一致性闸门共用。
 *
 * 扫描口径：extension/src 全域（feats + core）的 CMD_/PUSH_ 平铺定义：
 *   (export )?(var|const|let) CMD_X = 1234;
 * 不扫对象字面量/内联数字（那是用法不是定义，注册表 v1 只收定义）。
 *
 * 另扫 scripts/verify-manifests/*.mjs 的两类协议号引用：
 *   - 本地数字定义（const CMD_MARCH = 902;）—— 闸门断言其号 ⊆ 注册表；
 *   - featNum('CMD_X') 文本抽取引用 —— 闸门断言其名存在于注册表 usages；
 *     featNum 也抽非协议常量（ST_ 等状态枚举与调优参数），只收 CMD_/PUSH_ 前缀。
 *   （直接 import feat constants 的 manifest 不经此口，由「代码 ⊆ 注册表」间接覆盖。）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../../extension/src');
const MANIFEST_DIR = path.resolve(HERE, '../verify-manifests');

/** 平铺定义行：CMD_/PUSH_ 前缀 + 十进制数字字面量 */
const DEF_RE = /^\s*(?:export\s+)?(?:var|const|let)\s+((?:CMD|PUSH)_[A-Z0-9_]+)\s*=\s*(\d+)\s*;/;

/**
 * @typedef {object} ProtoDef
 * @property {string} name 常量名（feat 局部名，跨 feat 可同名异号）
 * @property {number} cmd 协议号
 * @property {string} file 相对 extension/src 的路径（正斜杠）
 * @property {number} line 行号（1-based）
 * @property {string} domain 业务域：activity/alliance/battle/cq26/player/system/core
 * @property {string} feat 玩法 id（feats 下目录名或文件名；core 下为相对路径去扩展名）
 */

/**
 * 扫描 extension/src 全部协议常量定义。
 * @returns {ProtoDef[]}
 */
export function scanDefinitions() {
  /** @type {string[]} */
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js')) files.push(p);
    }
  })(SRC_ROOT);

  /** @type {ProtoDef[]} */
  const defs = [];
  for (const f of files) {
    const rel = path.relative(SRC_ROOT, f).replace(/\\/g, '/');
    const seg = rel.split('/');
    const domain = seg[0] === 'feats' ? seg[1] : seg[0];
    const feat =
      seg[0] === 'feats'
        ? seg[2].endsWith('.js')
          ? seg[2].slice(0, -3)
          : seg[2]
        : seg.slice(1).join('/').replace(/\.js$/, '');
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => {
      const m = DEF_RE.exec(ln);
      if (m) defs.push({ name: m[1], cmd: Number(m[2]), file: rel, line: i + 1, domain, feat });
    });
  }
  return defs;
}

/**
 * 扫描对拍 manifests 的协议号引用（本地数字定义 + featNum 名）。
 * @returns {{ locals: Array<{name: string, cmd: number, file: string}>, featNums: Array<{name: string, file: string}> }}
 */
export function scanManifests() {
  /** @type {Array<{name: string, cmd: number, file: string}>} */
  const locals = [];
  /** @type {Array<{name: string, file: string}>} */
  const featNums = [];
  const localRe = /(?:const|var|let)\s+((?:CMD|PUSH)_[A-Z0-9_]+)\s*=\s*(\d+)/g;
  const featNumRe = /featNum\(\s*'([A-Z0-9_]+)'\s*\)/g;
  for (const e of readdirSync(MANIFEST_DIR)) {
    if (!e.endsWith('.mjs')) continue;
    const text = readFileSync(path.join(MANIFEST_DIR, e), 'utf8');
    for (const m of text.matchAll(localRe)) locals.push({ name: m[1], cmd: Number(m[2]), file: e });
    for (const m of text.matchAll(featNumRe)) {
      if (/^(CMD|PUSH)_/.test(m[1])) featNums.push({ name: m[1], file: e });
    }
  }
  return { locals, featNums };
}
