import esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');

/**
 * 读取 --key=value 形式的构建参数
 * @param {string} name 参数名（不含 --）
 * @returns {string|undefined} 未提供时返回 undefined
 */
function argVal(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p === undefined ? undefined : p.slice(2 + name.length + 1);
}

// 授权参数契约：uid 与 friend 必须成对出现（缺一 fail-fast）；都不给 = 无限制包。
const licUid = argVal('uid');
const licFriend = argVal('friend');
if ((licUid && !licFriend) || (licFriend && !licUid)) {
  console.error(
    '[esbuild] --uid 与 --friend 必须成对提供（授权包必须带水印昵称）；都不提供 = 无限制包。',
  );
  process.exit(1);
}
if (!release && (licUid || licFriend)) {
  console.error('[esbuild] 授权注入仅限 --release 构建（开发包不掺授权态）。');
  process.exit(1);
}
// 盐值：默认内置常量（发布前建议轮换），--salt= 覆写实现按朋友隔离口径。
const licSalt = argVal('salt') || 'pcc-2026-a1';
// 期望哈希只在构建侧算一次；包内不落 UID 明文（防 grep 定位与直接替换）。
const licHash = licUid
  ? createHash('sha256')
      .update(licSalt + licUid)
      .digest('hex')
  : '';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
if (release) {
  console.log(
    licHash
      ? `[esbuild] release 授权包：赠予「${licFriend}」 rev=${pkg.version}`
      : `[esbuild] release 无限制包 rev=${pkg.version}`,
  );
}

// 版本单一真相源同步：把根 package.json 的 version 写回 extension/manifest.json，
// 消除 dev 加载时 manifest 版本与真相源漂移（分发包的 version/name 由 package-friend.mjs 另覆写）。
{
  const manifestUrl = new URL('./extension/manifest.json', import.meta.url);
  const manifestRaw = readFileSync(manifestUrl, 'utf8');
  // 只精准替换顶层 "version" 值，保留原有紧凑格式（不误伤 manifest_version）。
  const nextRaw = manifestRaw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${pkg.version}$2`);
  if (nextRaw !== manifestRaw) {
    writeFileSync(manifestUrl, nextRaw);
    console.log(`[esbuild] manifest.version 同步为 ${pkg.version}`);
  }
}

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  sourcemap: !release,
  minify: release,
  legalComments: release ? 'none' : 'eof',
  logLevel: 'info',
  // 编译期常量注入：各入口（content/anti-throttle/bridge/background）独立打包内联同一份值；
  // 非 release 一律空串 = 无限制态，运行时闸门全部短路放行，dev 行为零变化。
  define: {
    __LICENSE_HASH__: JSON.stringify(licHash),
    __LICENSE_SALT__: JSON.stringify(licSalt),
    __LICENSE_FRIEND__: JSON.stringify(licFriend || ''),
    __PCC_VERSION__: JSON.stringify(pkg.version),
    // dev 专属调试探针闸门（core/devtools.js）：非 release=true 保留，release=false 配合 minify 死代码消除。
    __DEVTOOLS__: JSON.stringify(!release),
  },
};

const builds = [
  {
    ...common,
    entryPoints: ['extension/src/content.entry.js'],
    outfile: 'extension/dist/content.js',
  },
  {
    ...common,
    entryPoints: ['extension/src/anti-throttle.js'],
    outfile: 'extension/dist/anti-throttle.js',
  },
  { ...common, entryPoints: ['extension/src/bridge.js'], outfile: 'extension/dist/bridge.js' },
  {
    ...common,
    entryPoints: ['extension/src/background.js'],
    outfile: 'extension/dist/background.js',
  },
  {
    ...common,
    entryPoints: ['extension/src/popup.js'],
    outfile: 'extension/dist/popup.js',
  },
];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching... (Ctrl+C to stop)');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  // popup.html 是静态资源（manifest action 指向 dist/popup.html），esbuild 不处理 HTML，构建时原样拷入 dist。
  {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(
      new URL('./extension/src/popup.html', import.meta.url),
      new URL('./extension/dist/popup.html', import.meta.url),
    );
  }
  // 授权包元信息 sidecar（仅 release）：供 scripts/obfuscate-release.mjs 判定是否二次混淆（licensed 标记）、
  // scripts/package-friend.mjs 取昵称组装分发目录；由 obfuscate 阶段消费后删除。
  // 不含 UID 明文/哈希；非 release 不产出（旧残留先删）。
  {
    const { writeFile, rm } = await import('node:fs/promises');
    const sidecar = new URL('./extension/dist/build-info.json', import.meta.url);
    if (release) {
      await writeFile(
        sidecar,
        JSON.stringify({
          friend: licFriend || '',
          salt: licSalt,
          version: pkg.version,
          licensed: !!licHash,
        }),
      );
    } else {
      await rm(sidecar, { force: true });
    }
  }
}
