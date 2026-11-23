import esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');
// 日常发版只重建远程体（上传 OSS 的那一个文件），壳侧产物原地不动
const remoteOnly = process.argv.includes('--remote-only');

/**
 * 读取 --key=value 形式的构建参数
 * @param {string} name 参数名（不含 --）
 * @returns {string|undefined} 未提供时返回 undefined
 */
function argVal(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p === undefined ? undefined : p.slice(2 + name.length + 1);
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * 升级基址的权威源（运行期不可改，全仓只有这一处需要人肉填）。
 * 填法：形如 `https://pcc-update.<你的域>/ext/`，**必须带结尾斜杠**；留空 = 该通道不启用远程升级，只跑包内产物。
 * 强烈建议用自有域名 CNAME 到 OSS bucket，而不是裸 `bucket.oss-<region>.aliyuncs.com`：
 * 地址烧在壳里且不提供可配置项，将来换 bucket / 换 region / 套 CDN 只需改 DNS，不必重发所有人手上的壳。
 * 两条发布通道必须各占一个目录：共用一份 latest.json 等于把快照推给正式版用户。
 */
const UPDATE_BASES = {
  release: 'https://pocketcc.oss-cn-beijing.aliyuncs.com/extension/release/',
  snapshot: 'https://pocketcc.oss-cn-beijing.aliyuncs.com/extension/snapshot/',
};

/**
 * 发布通道：dev（本地调试、不启用远程通道）/ snapshot（自己先吃的新构建）/ release（发给所有人的正式）。
 * 它是**版本号之外的独立维度**：manifest.version 只接受 1–4 段纯数字，而 cmpVer 会把「1.0.0-dev」算成等于「1.0.0」，
 * 把通道塞进版本号只会造成静默不更新。缺省：--release 构建归 release，其余归 dev（所以现有命令行为不变）。
 * @type {'dev'|'snapshot'|'release'}
 */
const channel = (function pickChannel() {
  const c = String(argVal('channel') ?? (release ? 'release' : 'dev')).trim();
  if (c !== 'dev' && c !== 'snapshot' && c !== 'release') {
    console.error(`[esbuild] --channel 只认 dev / snapshot / release，收到「${c}」`);
    process.exit(1);
  }
  return c;
})();
/** @type {boolean} 是否走远程通道：dev 恒为假，不注入基址与密钥、也不动 host_permissions */
const remote = channel !== 'dev';

/** @type {string} 本次构建实际注入的基址：dev 恒为空串（远程通道整体短路，只跑本地 entry） */
const ossBase = remote ? String(argVal('oss-base') ?? UPDATE_BASES[channel]).trim() : '';
/** @type {string} 本次构建实际注入的 HMAC 密钥：只认 --update-key= / 环境变量 PCC_UPDATE_KEY，绝不入库 */
const updateKey = remote
  ? String(argVal('update-key') || process.env.PCC_UPDATE_KEY || '').trim()
  : '';

// 只回报「本次构建会用的升级配置」然后退出：publish-oss.mjs 靠它取基址、通道与版本号，避免第二处常量。
// 放在任何写盘动作之前，保证这一模式是纯读取。
if (process.argv.includes('--print-update-config')) {
  console.log(
    JSON.stringify({ version: pkg.version, channel, ossBase, keyConfigured: !!updateKey }),
  );
  process.exit(0);
}

if (remote && ossBase && !updateKey) {
  console.error(
    '[esbuild] 配了升级基址却没给 HMAC 密钥：设环境变量 PCC_UPDATE_KEY 或传 --update-key=。' +
      '缺钥的包客户端会把通道判为「未配置」，发出去永远不会自升级。',
  );
  process.exit(1);
}
if (remote && updateKey && !ossBase) {
  console.warn('[esbuild] 有密钥但未配升级基址：远程通道不启用，产物只跑包内产物。');
}
if (remote) {
  const chan = ossBase && updateKey ? `通道 ${ossBase}` : '通道未配置（只跑包内产物）';
  console.log(
    `[esbuild] ${channel} 构建 rev=${pkg.version}${remoteOnly ? ' (仅远程体)' : ''} · ${chan}`,
  );
}

// 版本单一真相源同步：把根 package.json 的 version 写回 extension/manifest.json，
// 消除 dev 加载时 manifest 版本与真相源漂移（分发包的 version 由 package-release.mjs 另覆写）。
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

// 升级基址与 manifest.host_permissions 同处同步（“三处同值”由构建而不靠人肉维护）：
// 传了 --oss-base= 就把它的 origin 补进 host_permissions（缺则 SW 的 GET 直接被拦）；未传（dev）不动 manifest。
if (ossBase) {
  const manifestUrl = new URL('./extension/manifest.json', import.meta.url);
  const raw = readFileSync(manifestUrl, 'utf8');
  const hit = raw.match(/("host_permissions"\s*:\s*\[)([^\]]*)(\])/);
  if (!hit) {
    console.warn('[esbuild] manifest 里找不到 host_permissions 数组，升级域名需手工添加');
  } else {
    const need = `${new URL(ossBase).origin}/*`;
    const list = JSON.parse(`[${hit[2]}]`);
    if (!list.includes(need)) {
      const at = hit.index + hit[1].length;
      writeFileSync(
        manifestUrl,
        `${raw.slice(0, at)}${hit[2]}${hit[2].trim() ? ', ' : ''}"${need}"${raw.slice(at + hit[2].length)}`,
      );
      console.log(`[esbuild] manifest.host_permissions 追加 ${need}`);
    }
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
  // 编译期常量注入：各入口（shell/anti-throttle/bridge/background/远程体）独立打包内联同一份值。
  // 升级通道两个常量只有 release 才给值（见上方 UPDATE_BASE / PCC_UPDATE_KEY）；空串即客户端闸门短路。
  define: {
    __PCC_VERSION__: JSON.stringify(pkg.version),
    // 发布通道名：供壳/远程体派生存储前缀、postMessage 命名空间与面板展示（release 为空后缀，保证存量数据零迁移）。
    __PCC_CHANNEL__: JSON.stringify(channel),
    __OSS_BASE__: JSON.stringify(ossBase),
    __UPDATE_KEY__: JSON.stringify(updateKey),
    // dev 专属调试探针闸门（core/devtools.js）：非 release=true 保留，release=false 配合 minify 死代码消除。
    __DEVTOOLS__: JSON.stringify(!release),
  },
};

// 本地壳：季度级才重发一次，只含取包/执行/升级状态机与转发，不含玩法与面板 UI。
const shellGroup = [
  { ...common, entryPoints: ['extension/src/shell.js'], outfile: 'extension/dist/shell.js' },
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
// 远程体：feats + core 全量。产物 dist/remote.js 是双重身份——既是要传 OSS 的正文，也是包内基线
// （壳取不到缓存、OSS 不可用时直接 exec 它），故不设第二份副本，也不允许两边版本口径分开。
const remoteGroup = [
  {
    ...common,
    entryPoints: ['extension/src/remote.entry.js'],
    outfile: 'extension/dist/remote.js',
  },
];
const builds = remoteOnly ? remoteGroup : shellGroup.concat(remoteGroup);

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching... (Ctrl+C to stop)');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  // 以下两件都是壳侧产物：只重建远程体时不碰（popup.html 是静态资源（manifest action 指向 dist/popup.html），esbuild 不处理 HTML，构建时原样拷入 dist）
  if (!remoteOnly) {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(
      new URL('./extension/src/popup.html', import.meta.url),
      new URL('./extension/dist/popup.html', import.meta.url),
    );
  }
  // 构建元信息 sidecar（仅 release）：记录本次产物的版本号，供下游打包脚本消费后删除；
  // 非 release 不产出（旧残留先删）。
  if (!remoteOnly) {
    const { writeFile, rm } = await import('node:fs/promises');
    const sidecar = new URL('./extension/dist/build-info.json', import.meta.url);
    if (release) {
      await writeFile(sidecar, JSON.stringify({ version: pkg.version, channel }));
    } else {
      await rm(sidecar, { force: true });
    }
  }
}
