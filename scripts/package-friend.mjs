// 授权分发一条龙（仅构建期，零第三方依赖）：
//   npm run pack:friend -- --uid=13886462332905 --friend=阿明 [--salt=xxx]
// 职责：校验授权参数 → spawn 构建链（esbuild --release → obfuscate-release）→ 组装
// release/pocketcc-extension-for-<uid>/ 分发目录（目录名不带版本，便于朋友固定路径加载/升级原地覆盖；版本仍在包内 manifest）。
// 参数在这里收一次并转发给 esbuild，避开 npm 链式脚本尾参只达末条的问题。
import { readFile, writeFile, mkdir, cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * 读取 --key=value 形式的脚本参数
 * @param {string} name 参数名（不含 --）
 * @returns {string|undefined} 未提供时返回 undefined
 */
function argVal(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p === undefined ? undefined : p.slice(2 + name.length + 1);
}

const licUid = argVal('uid');
const licFriend = argVal('friend');
if (!licUid || !licFriend) {
  console.error(
    '[package-friend] 用法：npm run pack:friend -- --uid=<游戏UID> --friend=<昵称>（授权包必须成对提供）',
  );
  process.exit(1);
}
const saltArg = argVal('salt');

/** @type {string} 仓库根目录（正斜杠、带尾斜杠） */
const root = fileURLToPath(new URL('../', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/[^/]*$/, '');
const node = process.execPath;

/**
 * 直跑一个 node 脚本（透传授权参数），非零退出即中断
 * @param {string} script 相对仓库根的脚本路径
 * @param {string[]} args 命令行参数
 */
function runStep(script, args) {
  const r = spawnSync(node, [`${root}${script}`, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[package-friend] ${script} 失败（exit ${r.status}）`);
    process.exit(r.status || 1);
  }
}

// 1. 构建链：esbuild release（写 sidecar）→ 授权包二次混淆
runStep('esbuild.config.mjs', [
  '--release',
  `--uid=${licUid}`,
  `--friend=${licFriend}`,
  ...(saltArg ? [`--salt=${saltArg}`] : []),
]);
runStep('scripts/obfuscate-release.mjs', []);

// 2. 读 sidecar 拿昵称/版本（由 esbuild 产出，本脚本消费后删除）
const distDir = `${root}extension/dist`;
const infoPath = `${distDir}/build-info.json`;
if (!existsSync(infoPath)) {
  console.error('[package-friend] 缺 dist/build-info.json（构建链未产出授权标记），中止组装。');
  process.exit(1);
}
const info = JSON.parse(await readFile(infoPath, 'utf8'));
await rm(infoPath, { force: true });
const friend = String(info.friend || '');
// 分发目录名格式：pocketcc-extension-for-<uid>（纯 ASCII、不带版本：固定路径便于朋友加载，升级时原地覆盖）；
// 版本仍写进包内 manifest.version，昵称烧在 manifest.name 作追踪水印。
const uidSlug = String(licUid).replace(/[\\/:*?"<>|\x00-\x1f]/g, '');
const outDir = `${root}release/pocketcc-extension-for-${uidSlug}`;

// 3. 清旧重建；dist 拷 *.js 与 popup.html——显式排除 .map 与 sidecar（发布包绝不带 sourcemap/授权标记）
await rm(outDir, { recursive: true, force: true });
await mkdir(`${outDir}/dist`, { recursive: true });
for (const f of await readdir(distDir)) {
  if (!f.endsWith('.js') && f !== 'popup.html') continue;
  await cp(`${distDir}/${f}`, `${outDir}/dist/${f}`);
}

// 4. assets 整体拷贝
await cp(`${root}extension/assets`, `${outDir}/assets`, { recursive: true });

// 5. manifest：version 以 package.json 为单一真相源覆写；name 追加赠予水印
const pkg = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
const manifest = JSON.parse(await readFile(`${root}extension/manifest.json`, 'utf8'));
manifest.version = pkg.version;
manifest.name = `${manifest.name} - ${friend}`;
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[package-friend] 已生成 ${outDir}（v${pkg.version}，赠予「${friend}」）`);
