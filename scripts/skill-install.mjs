#!/usr/bin/env node
/**
 * Skill 装配脚本：把仓内 skill 真身链接进 IDE 的项目级发现路径。
 *
 * 为什么要它（取代旧的 `mkdir -p "$HOME/…" && ln -sfn` 一行式）：
 *   仓库里 skill 真身只放一处 —— 仓内 `skills/<id>/SKILL.md`（入库、可 review、可 diff）；
 *   而 IDE 读的是项目级 `.qoder/skills/`（被 .gitignore 忽略）。两者靠链接接起来，
 *   就能做到「一份内容、git 与 IDE 同时看见」，不必在两处维护同一份规范。
 *
 * 旧一行式的两个坑，本脚本按注释逐条避开：
 *   1) `$HOME`/`$PWD` 在 PowerShell/cmd 里不展开 → `mkdir -p` 按字面量在仓根建出 `$HOME/…` 目录。
 *      故路径一律由 Node 计算（os.homedir() / import.meta.url），全程不经 shell 变量。
 *   2) `ln -s` 建目录符号链在 Windows 需要开发者模式或管理员权限（EPERM）。
 *      故 win32 用 junction（reparse point，不需要特权），其余平台用目录 symlink。
 *
 * 兜底：万一某版本 IDE 不跟随链接（表现为 skill 列表里看不到这几份规范），跑 `--copy`
 *   退化成真身复制；代价是内容双份、以仓内那份为准手工同步。脚本每次都在末行说明当前用的是哪种方式。
 *
 * 用法：node scripts/skill-install.mjs [--copy] [--home] [--force]
 *   --copy   用复制代替链接（IDE 不跟随链接时的兜底）
 *   --home   额外装一份到用户级 ~/.qoder-cn/skills（跨项目共用同一套规范）
 *   --force  目标已是一个「真实目录」（不是链接）时也接管：先改名留档再装，绝不静默删内容
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'skills');
const SKILL_FILE = 'SKILL.md';
const argv = process.argv.slice(2);
const USE_COPY = argv.includes('--copy');
const FORCE = argv.includes('--force');

/** 装配目标：项目级必做，--home 时追加用户级。@type {Array<{scope:string,dir:string}>} */
const TARGETS = [
  { scope: 'project', dir: path.join(ROOT, '.qoder', 'skills') },
  ...(argv.includes('--home')
    ? [{ scope: 'user', dir: path.join(os.homedir(), '.qoder-cn', 'skills') }]
    : []),
];

/**
 * 链接类型：win32 走 junction（不需特权），其余走目录 symlink。
 * @returns {'junction'|'dir'} fs.symlinkSync 的 type 参数
 */
function linkType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

/**
 * 读出某路径的「链接身份」。Node 在 Windows 上把 junction 也报成 symlink，
 * 故 readlink 成功就算链接，不再区分二者。
 * @param {string} p 路径
 * @returns {string|null} 链接原文目标；非链接或不存在返回 null
 */
function readLink(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * 列出仓内 skill 真身（判据：目录下有 SKILL.md）。
 * @returns {Array<{id:string,src:string}>} 按 id 升序
 */
function listSkills() {
  if (!fs.existsSync(SRC_DIR)) return [];
  return fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SRC_DIR, e.name, SKILL_FILE)))
    .map((e) => ({ id: e.name, src: path.join(SRC_DIR, e.name) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * 删掉一个已存在的链接（只断链，不碰它指向的内容）。
 * @param {string} p 链接路径
 */
function unlink(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

/**
 * 在 dst 落下真身：默认建链接，--copy 时整目录复制。
 * @param {string} src 仓内真身绝对路径
 * @param {string} dst 目标路径
 * @returns {void}
 */
function plant(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (USE_COPY) fs.cpSync(src, dst, { recursive: true });
  else fs.symlinkSync(src, dst, linkType());
}

/**
 * 透过 dst 读一次 SKILL.md，与仓内真身比字节数 —— 证明「链接可解析 + 内容一致」。
 * @param {string} src 仓内真身绝对路径
 * @param {string} dst 目标路径
 * @returns {string} 校验结果短语
 */
function verify(src, dst) {
  try {
    const a = fs.statSync(path.join(src, SKILL_FILE)).size;
    const b = fs.statSync(path.join(dst, SKILL_FILE)).size;
    return a === b ? `校验通过 ${b}B` : `⚠️ 字节数不一致（真身 ${a}B / 目标 ${b}B）`;
  } catch (e) {
    return '⚠️ 透过目标读不到 ' + SKILL_FILE + '：' + e.code;
  }
}

/**
 * 装配一个 skill 到一个目标位。
 * @param {{id:string,src:string}} skill 仓内真身
 * @param {string} dst 目标路径
 * @returns {string} 动作短语，供汇总行打印
 */
function installOne(skill, dst) {
  const link = readLink(dst);
  if (link !== null) {
    if (!fs.existsSync(dst)) {
      unlink(dst);
      plant(skill.src, dst);
      return '修复悬空链接';
    }
    if (path.resolve(path.dirname(dst), link) === skill.src && !USE_COPY) return '已就位';
    unlink(dst);
    plant(skill.src, dst);
    return USE_COPY ? '链接改复制' : '重新指向仓内真身';
  }
  if (fs.existsSync(dst)) {
    if (!FORCE) return '⚠️ 目标是真实目录，未动（要接管加 --force）';
    const bak = dst + '.bak-' + Date.now();
    fs.renameSync(dst, bak);
    plant(skill.src, dst);
    return '接管（原目录留档 ' + path.relative(ROOT, bak) + '）';
  }
  plant(skill.src, dst);
  return USE_COPY ? '已复制' : '已建链';
}

/**
 * 清掉目标目录里指向「已删除的仓内 skill」的悬空链接。只断链，真实目录一律不碰。
 * @param {string} dir 目标父目录（.qoder/skills 或用户级 skills）
 * @param {Set<string>} liveIds 当前仓内还存在的 skill id
 * @returns {string[]} 被清掉的名字
 */
function pruneDangling(dir, liveIds) {
  if (!fs.existsSync(dir)) return [];
  const gone = [];
  for (const name of fs.readdirSync(dir)) {
    if (liveIds.has(name)) continue;
    const p = path.join(dir, name);
    if (readLink(p) === null || fs.existsSync(p)) continue; // 不是链接，或链接还能解析 → 留着
    unlink(p);
    gone.push(name);
  }
  return gone;
}

const skills = listSkills();
if (!skills.length) {
  console.log(
    '仓内 ' + path.relative(ROOT, SRC_DIR) + '/ 下没有带 ' + SKILL_FILE + ' 的 skill 目录',
  );
  process.exit(0);
}
console.log(
  `skill 真身 ${skills.length} 份（${skills.map((s) => s.id).join(', ')}）；方式=${USE_COPY ? 'copy' : 'link'}${FORCE ? ' force' : ''}`,
);

for (const t of TARGETS) {
  console.log(`\n── ${t.scope}：${path.relative(ROOT, t.dir) || t.dir}`);
  const ids = new Set(skills.map((s) => s.id));
  for (const s of skills) {
    const dst = path.join(t.dir, s.id);
    console.log(`   ${s.id.padEnd(22)} ${installOne(s, dst)}  ${verify(s.src, dst)}`);
  }
  const gone = pruneDangling(t.dir, ids);
  if (gone.length) console.log('   清掉悬空链接：' + gone.join(', '));
}

console.log(
  '\n下一步：重载/重启 IDE 让 skill 列表重扫。若列表里看不到这几份（说明该版本不跟随链接），' +
    '跑 `node scripts/skill-install.mjs --copy` 兜底。',
);
