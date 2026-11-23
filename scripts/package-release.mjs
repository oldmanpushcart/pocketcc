// 分发打包一条龙（仅构建期，零第三方依赖）：
//   npm run pack:release ／ npm run pack:snapshot
// 职责：跑 release 构建 → 组装 extension/out/<通道>/pocketcc-extension/ 分发目录（正式即 extension/out/release/pocketcc-extension/）
// （目录名固定、不带版本：朋友按同一路径加载，发版时原地覆盖；版本仍写进包内 manifest.version）。
// --channel=<release|snapshot> 决目录与扩展 ID（缺省 release），--out-dir=<目录> 只覆写目录；
// snapshot / release 两条线各占 extension/out/ 下一个目录、各持一个扩展 ID，因此能同时装进同一个浏览器（靠启用/禁用切换，别同时启用）；
// dev 刻意不出包（见下方闸门）。
import { readFile, writeFile, mkdir, cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** @type {string} 仓库根目录（正斜杠、带尾斜杠） */
const root = fileURLToPath(new URL('../', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/[^/]*$/, '');
const node = process.execPath;

/**
 * 分发目录：给定的相对路径按仓库根展开，绝对路径原样用；缺省为正式目录
 * @param {string} [raw] --out-dir= 的原值
 * @returns {string} 绝对路径（正斜杠、无尾斜杠）
 */
function resolveOut(raw) {
  const s = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!s) return `${root}extension/out/release/pocketcc-extension`;
  return /^[A-Za-z]:?\//.test(s) ? s : `${root}${s.replace(/^\/+/, '')}`;
}

/**
 * 读取 --key=value 形式的构建参数
 * @param {string} name 参数名（不含 --）
 * @returns {string|undefined} 未提供时为 undefined
 */
function argVal(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p === undefined ? undefined : p.slice(2 + name.length + 1);
}

/** @type {{[k:string]:string}} 两条发布通道的分发目录（一通道一位、同一叶名，互不覆盖）；统一收在 extension/out/ 这个分发出口下，与 dashcam/store 同一条约定；dev 无位——它不出包 */
const PKG_DIRS = {
  release: 'extension/out/release/pocketcc-extension',
  snapshot: 'extension/out/snapshot/pocketcc-extension',
};

/** @type {{[k:string]:string}} 各通道的扩展显示名（供 chrome://extensions 一眼分辨）；dev 无位——它加载 tracked 那份，名字天然带「开发版」 */
const PKG_NAMES = {
  release: '口袋控制中心',
  snapshot: '口袋控制中心（快照版）',
};

// dev 通道不出分发包：日常调试直接加载 extension/ 目录本身（watch 增量写进 extension/dist，重载即生效），
// 另拷一份只会得到一份每次构建后都过期的副本。真想要 dev 形态的产物就用 npm run build。
// 拿 --channel=dev 来碰这个入口一律早退（省掉一次无用的 esbuild）；显式给了 --out-dir= 则视为知情覆盖，放行。
if (String(argVal('channel') || 'release') === 'dev' && argVal('out-dir') === undefined) {
  console.error(
    '[package-release] dev 通道不出分发包：日常调试请在浏览器里加载 extension/ 目录（先 npm run build 或 npm run watch）。',
  );
  process.exit(1);
}

/**
 * 直跑一个 node 脚本，非零退出即中断
 * @param {string} script 相对仓库根的脚本路径
 * @param {string[]} args 命令行参数
 */
function runStep(script, args) {
  const r = spawnSync(node, [`${root}${script}`, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[package-release] ${script} 失败（exit ${r.status}）`);
    process.exit(r.status || 1);
  }
}

// 1. 构建（release：minify、关 sourcemap、写版本 sidecar）；命令行透传：
//    publish-oss.mjs 靠它把升级基址与 HMAC 密钥带进同一次构建，保证「OSS 正文」与「包内基线」逐字节一致。
runStep('esbuild.config.mjs', ['--release', ...process.argv.slice(2)]);

// 2. 读 sidecar 拿版本号与发布通道（由 esbuild 产出，本脚本消费后删除）
const distDir = `${root}extension/dist`;
const infoPath = `${distDir}/build-info.json`;
const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
let builtVersion = pkg.version;
/** @type {string} 本次产物的发布通道；缺省按正式，所以下游拿不到 sidecar 时行为与以往一致 */
let channel = 'release';
if (existsSync(infoPath)) {
  const info = JSON.parse(await readFile(infoPath, 'utf8'));
  builtVersion = String(info.version || pkg.version);
  channel = String(info.channel || 'release');
  await rm(infoPath, { force: true });
}

// 3. 清旧重建；dist 拷 *.js 与 popup.html——显式排除 .map（发布包绝不带 sourcemap）
const outDir = resolveOut(argVal('out-dir') || PKG_DIRS[channel] || PKG_DIRS.release);
await rm(outDir, { recursive: true, force: true });
await mkdir(`${outDir}/dist`, { recursive: true });
for (const f of await readdir(distDir)) {
  if (!f.endsWith('.js') && f !== 'popup.html') continue;
  await cp(`${distDir}/${f}`, `${outDir}/dist/${f}`);
}

// 4. assets 整体拷贝
await cp(`${root}extension/assets`, `${outDir}/assets`, { recursive: true });

// 5. manifest：version 以构建版本覆写（单一真相源仍是根 package.json），name 按通道覆写。
//    名字与 ID 无关（ID 只由 key 派生），改名字不会换实例；tracked 那份写「（开发版）」，因为那个目录就是 dev 实体。
//    key 也在此按通道注入：tracked 的 extension/manifest.json 存的是 dev key（日常加载的就是那个目录），
//    发布通道的 ID 放在 extension/channel-keys.json（只有公钥派生物、不含私钥）。
//    扩展 ID 由 key 派生 ⇒ 改任何一条等于换一个全新实例（storage 从零开始），所以三条线一旦定稿就别再动。
const manifest = JSON.parse(await readFile(`${root}extension/manifest.json`, 'utf8'));
manifest.version = builtVersion;
if (PKG_NAMES[channel]) manifest.name = PKG_NAMES[channel];
if (channel !== 'dev') {
  const keys = JSON.parse(await readFile(`${root}extension/channel-keys.json`, 'utf8'));
  if (!keys[channel]) {
    console.error(
      `[package-release] extension/channel-keys.json 缺「${channel}」条目，扩展 ID 无法固定`,
    );
    process.exit(1);
  }
  manifest.key = keys[channel];
}
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[package-release] 已生成 ${outDir}（v${builtVersion} · 通道 ${channel}）`);
