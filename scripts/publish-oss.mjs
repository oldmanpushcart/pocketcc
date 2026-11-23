// OSS 发布一条龙（仅构建期，零第三方依赖）：
//   npm run publish:release      # 正式通道
//   npm run publish:snapshot     # 快照通道
// 职责：跑一次 release 构建 → 对远程体算 sha256/HMAC → 落「待上传件」到该通道的目录 → 生成/合并 latest.json
//      → 自检升级地址三处同值 → 打印 OSS 控制台的上传清单与顺序。
// 本脚本不直连 OSS：AccessKey 不落脚本、不进仓库，上传由控制台或 ossutil 手动执行（一次性配置见 extension/README.md）。
// 清单判据（字段名、versions 归并、相对路径合法性、字段缺省）一律复用客户端的 core/update.js，两侧不留第二套口径。
//
// 发布通道（--channel=snapshot|release，缺省 release）是单一旋钮，一次定下三件事：
//   基址（由 esbuild 的 UPDATE_BASES 按通道取）、待上传目录、分发壳目录；三条线各自一份 latest.json，
//   所以快照不会推给正式版用户。两条通道的**发布身份**不同：正式按版本号（升不升号由你拿主意，转正就重跑一次 publish:release），
//   快照按「版本号@摘要前 8 位」：版本号可以长期钉在同一个号上，每次重发都是一份新正文（文件名与清单标签都跟着摘要走）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertUrl, makeLatest, parseLatest, shaTag } from '../extension/src/core/update.js';

/** @type {string} 仓库根目录（正斜杠、带尾斜杠） */
const root = fileURLToPath(new URL('../', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/[^/]*$/, '');
const node = process.execPath;

/**
 * 读取 --key=value 形式的命令行参数
 * @param {string} name 参数名（不含 --）
 * @returns {string|undefined} 未提供时为 undefined（区别于「传了空值」）
 */
function argVal(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p === undefined ? undefined : p.slice(2 + name.length + 1);
}

/**
 * 中止并给出可执行的下一步指示
 * @param {string} message 说明
 * @returns {never}
 */
function die(message) {
  console.error(`[publish-oss] ${message}`);
  process.exit(1);
}

/** @type {boolean} 干跑：只算摘要与自检，不落任何待上传件 */
const dryRun = process.argv.includes('--dry-run');

/** @type {'dev'|'snapshot'|'release'} 发布通道：目录与基址全由它派生（--oss-dir / --pkg-dir / --oss-base 可逐项覆写） */
const channel = String(argVal('channel') ?? 'release').trim();
if (channel === 'dev') {
  die(
    'dev 通道刻意不启用远程升级，没有可发布的正文：要发自己先吃的构建用 --channel=snapshot，发给所有人用 --channel=release。',
  );
}
if (channel !== 'snapshot' && channel !== 'release') {
  die(`--channel 只认 dev / snapshot / release，收到「${channel}」`);
}

/** @type {{[k:string]:string}} 各通道的待上传目录（各持一份 latest.json，版本史互不串味）；与分发壳同在一个通道目录下，两者统一收在 extension/out/ 这个分发出口 */
const OSS_DIRS = {
  release: 'extension/out/release/oss',
  snapshot: 'extension/out/snapshot/oss',
};
/** @type {{[k:string]:string}} 各通道的分发目录（扩展 ID 不同，三份壳可同时装在一个浏览器里）；叶名统一为 pocketcc-extension */
const PKG_DIRS = {
  release: 'extension/out/release/pocketcc-extension',
  snapshot: 'extension/out/snapshot/pocketcc-extension',
};

/** @type {string} 正式通道的分发目录（要发朋友的那份壳） */
const PKG_DEFAULT = `${root}${PKG_DIRS.release}`;

/**
 * 归一命令行给的路径：反斜杠转正斜杠、去尾斜杠；绝对路径原样用，相对路径按仓库根展开
 * @param {string|undefined} raw 原值
 * @returns {string} 归一后的绝对路径，空值返回空串
 */
function resolvePath(raw) {
  const s = String(raw === undefined ? '' : raw)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!s) return '';
  return /^[A-Za-z]:?\//.test(s) ? s : `${root}${s.replace(/^\/+/, '')}`;
}

/**
 * 由手动指定的上传目录名派生分发壳目录（让两个产物同父、不致两档一新一旧）：
 * 如 /tmp/x/oss → /tmp/x/pocketcc-extension、/tmp/x/oss-beta → /tmp/x/pocketcc-extension-beta。
 * 通道缺省目录不走这条（它们本就各自定在 PKG_DIRS 里）。
 * @param {string} dir 已归一的上传目录
 * @returns {string} 名字不合形态时返回空串（交调用方回落默认值）
 */
function derivePkg(dir) {
  const m = dir.match(/^(.*\/)oss(-[^/]+)?$/);
  return m ? `${m[1]}pocketcc-extension${m[2] || ''}` : '';
}

/** @type {boolean} 是否手改过待上传目录（此时分发壳目录也跟着按名字派生，避免两档一新一旧） */
const customOssDir = argVal('oss-dir') !== undefined;
/** @type {string} 待上传目录（本脚本产物，人工据此传 OSS） */
const ossDir = resolvePath(argVal('oss-dir')) || `${root}${OSS_DIRS[channel]}`;
/** @type {string} 本通道的分发目录缺省值 */
const pkgDefault = `${root}${PKG_DIRS[channel]}`;
/** @type {string} 分发目录（壳 + 包内基线）；--pkg-dir= 优先，其次由 --oss-dir 派生，否则按通道取 */
let pkgDir =
  resolvePath(argVal('pkg-dir')) || (customOssDir ? derivePkg(ossDir) : '') || pkgDefault;

/**
 * 相对仓库根的显示形式，供日志用
 * @param {string} dir 绝对路径
 * @returns {string} 去掉根前缀后的相对路径
 */
function rel(dir) {
  return dir.startsWith(root) ? dir.slice(root.length) : dir;
}

if (channel !== 'release' || pkgDir !== pkgDefault) {
  console.log(
    `[publish-oss] 通道 ${channel}：待上传件→ ${rel(ossDir)}/，分发壳→ ${rel(pkgDir)}/` +
      `（正式通道仍为 ${OSS_DIRS.release}/ 与 ${PKG_DIRS.release}/）`,
  );
}
if (channel !== 'release' && pkgDir === PKG_DEFAULT) {
  console.warn(
    `[publish-oss] 注意：${channel} 通道仍会把壳写进 ${rel(PKG_DEFAULT)}/，那是要发朋友的那一份。` +
      ` 请用 --pkg-dir= 指一个独立目录（或干脆不传，脚本会按通道落到 ${pkgDefault.slice(root.length)}/）。`,
  );
}

// ---- 1. 取本次构建会用到的升级配置（权威源在 esbuild.config.mjs 顶部常量，此处只读不复制）----

/** @type {string} 真实分发壳目录（仅供展示；干跑时构建会被引到临时位，这里仍指人手上那一份） */
const pkgReal = pkgDir;

// 干跑绝不碰分发壳：出壳那一步会把本次传入的验签密钥一并内联进壳（dist/background.js），
// 拿一把试跑的钥干跑一次，人手上那批壳就作废了（扩展 ID 没变、装上却恒定验签失败，属最难查的一类问题）。
// 所以干跑时把壳构建到一个固定的临时位，只为取到那份与待传件同批的 remote.js 算摘要。
if (dryRun) pkgDir = `${root}.reviewtmp/dryrun-pkg-${channel}`;

/** @type {string} HMAC 密钥：同一个值既内联进壳、又用来签清单，缺一侧即客户端恒定验签失败 */
const key = String(argVal('update-key') || process.env.PCC_UPDATE_KEY || '').trim();
if (!key) {
  die(
    '缺 HMAC 密钥：设环境变量 PCC_UPDATE_KEY，或传 --update-key=<密钥>。' +
      '该值必须与既往发布用的同一个（换了钥，老清单签出的包在新壳上全部验不过）。',
  );
}

/**
 * @type {string[]} 下发给构建的覆写参数：探测与正式构建共用同一份，保证「读到的配置」就是「构建用的配置」。
 *   通道一律显式传（目录与基址都由它派生），密钥也显式传（不依赖环境变量能否穿透两层 spawn），基址只在人显式给了才传。
 */
const overrides = [`--channel=${channel}`];
if (argVal('oss-base') !== undefined) overrides.push(`--oss-base=${argVal('oss-base')}`);
if (pkgDir !== pkgDefault) overrides.push(`--out-dir=${pkgDir}`);
overrides.push(`--update-key=${key}`);

/**
 * 直跑一个 node 脚本并回 stdout；非零退出即中断
 * @param {string} script 相对仓库根的脚本路径
 * @param {string[]} args 命令行参数
 * @param {boolean} echo 是否把子进程日志直通到本终端
 * @returns {string} 子进程 stdout
 */
function run(script, args, echo) {
  const r = spawnSync(node, [`${root}${script}`, ...args], {
    stdio: echo ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    if (!echo) console.error(r.stderr || '');
    die(`${script} 失败（exit ${r.status}）`);
  }
  return String(r.stdout || '');
}

const probed = run(
  'esbuild.config.mjs',
  ['--release', '--print-update-config', ...overrides],
  false,
)
  .trim()
  .split('\n')
  .pop();

/** @type {{version?:string, channel?:string, ossBase?:string, keyConfigured?:boolean}} */
let cfg;
try {
  cfg = JSON.parse(probed || '{}');
} catch {
  die(`读取升级配置失败：esbuild --print-update-config 输出不是 JSON（原文：${probed}）`);
}
if (!cfg.keyConfigured) die('构建侧没吃到密钥（检查 --update-key= 传参是否被截断）。');

/** @type {string} 升级基址（客户端唯一信任的地址来源，永远来自壳内常量而非清单） */
const base = String(cfg.ossBase || '');
if (!base) {
  die(
    '升级基址未配置：编辑 esbuild.config.mjs 顶部的 UPDATE_BASE（形如 https://pcc-update.<你的域>/ext/，带结尾斜杠），' +
      '或临时传 --oss-base=<地址>。',
  );
}
if (base.includes('<') || base.includes('>')) die(`升级基址仍是占位值：${base}`);
if (!base.endsWith('/')) die(`升级基址必须以 / 结尾：${base}`);
/** @type {URL} 解析并校验协议；OSS 裸 bucket 域名与自有域名 CNAME 都走 https */
let baseObj;
try {
  baseObj = new URL(base);
} catch {
  die(`升级基址不是合法 URL：${base}`);
}
if (baseObj.protocol !== 'https:')
  die(`升级基址必须是 https（当前 ${baseObj.protocol}//）：${base}`);

/** @type {string} 版本单一真相源（根 package.json），远程体与包内基线同批产出，共用它 */
const version = String(cfg.version || '');
if (!/^\d+(\.\d+)*$/.test(version)) die(`版本号形态异常：${version}（应为点分数字）`);
if (cfg.channel && cfg.channel !== channel) {
  die(
    `通道不一致：本脚本按 --channel=${channel} 走，构建侧却报了 ${cfg.channel}（检查参数是否被 npm 吞掉）。`,
  );
}

// 文件名在算完摘要之后才定得下（快照通道要把摘要编进名字），故这一步推到 §4；此处先校验版本号形态与通道一致性。

// ---- 2. 一次构建出全套产物（同一次构建保证「要传 OSS 的正文」与「分发包内基线」逐字节一致）----
// pkgDir / ossDir 已在前面按 --oss-dir / --pkg-dir 定好，快照通道下两者都偏离默认值。
run('scripts/package-release.mjs', overrides, true);

/**
 * 读一个文本文件，读不到即中断
 * @param {string} path 绝对路径
 * @param {string} hint 失败提示
 * @returns {Promise<string>} 文件内容
 */
async function mustRead(path, hint) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    die(`${path} 读不到：${hint}`);
  }
}

// ---- 3. 算完整性标记（node:crypto 口径，与客户端 crypto.subtle 同结果由 tests/core/update-integrity.test.js 守住）----
const text = await mustRead(`${pkgDir}/dist/remote.js`, '先确认 npm run pack:release 能正常出包');
if (!text.trim()) die('远程体为空，拒绝发布');
const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = createHmac('sha256', key).update(text, 'utf8').digest('hex');
const size = Buffer.byteLength(text, 'utf8');

// ---- 4. 正文文件名：拿到摘要才定得了名，所以必放在 §3 之后 ----
// 正式通道：名字只含版本号，一号一份，「你在用哪版」由版本号回答；同号重发属误操作（下面 §6 会给出警告）。
// 快照通道：名字带摘要前 8 位（与客户端 identityOf 的身份串同源），于是同一版本号的重发是一份新对象，
//   而不是把旧对象覆盖掉——正文走 immutable 长缓存，同名不同字节会让已下过旧正文的机器直接验签失败并计入熔断。
// 两种形态都必须过客户端 assertUrl，否则清单里的 file 拼不出地址。
const file =
  channel === 'release'
    ? `pocketcc-remote-${version}.js`
    : `pocketcc-remote-${version}-${shaTag(sha256)}.js`;
if (!assertUrl(file, base)) die(`正文文件名被客户端判为非法路径：${file}`);

// ---- 5. 地址三处同值自检：源码常量 → 已内联进壳的产物 → manifest 放行域名 ----
const built = await mustRead(`${pkgDir}/dist/background.js`, '壳的 service worker 产物缺失');
if (!built.includes(base)) {
  die('构建产物里找不到升级基址，说明 __OSS_BASE__ 注入没生效（检查 esbuild 构建日志）。');
}
const manifest = JSON.parse(await mustRead(`${pkgDir}/manifest.json`, '分发包缺 manifest.json'));
const needHost = `${baseObj.origin}/*`;
if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes(needHost)) {
  die(
    `分发包 manifest.host_permissions 缺 ${needHost}（缺则 SW 的 GET 直接被浏览器拦掉）。` +
      ' 正常由 esbuild 构建时自动追加，若仍缺失请检查 manifest 里 host_permissions 数组的书写形态。',
  );
}
if (manifest.version !== version) {
  die(
    `分发包 manifest.version=${manifest.version} 与版本真相源 ${version} 不一致（壳与远程体必须同批）。`,
  );
}

// ---- 6. 生成/合并清单 ----
const latestPath = `${ossDir}/latest.json`;
/** @type {ReturnType<typeof parseLatest>|undefined} 既往清单（首次发布或文件损坏归 null）；min/shellMin 属人工吊销旋钮，绝不自动上抬 */
let prev;
try {
  prev = parseLatest(await readFile(latestPath, 'utf8'));
} catch {
  prev = null;
}
const notes = String(argVal('notes') || '');
const min = String(argVal('min') ?? (prev ? prev.min : '')).trim();
const shellMin = String(argVal('shell-min') ?? (prev ? prev.shellMin : '')).trim();
// 同号不同摘要：正式通道是误操作（客户端按版本号高低决定要不要重下，已拿到该号的机器不会再拉）；
// 快照通道则正是设计本意——靠摘要而非版本号推更新，新版名字不撞、客户端 pickBundle 也会按摘要放行。
if (
  channel === 'release' &&
  prev &&
  prev.latest === version &&
  prev.sha256 &&
  prev.sha256 !== sha256
) {
  console.warn(
    `[publish-oss] 注意：清单里 v${version} 已有一份摘要不同的正文。客户端按版本高低决定要不要重下，` +
      `已拿到 v${version} 的机器不会再拉这一份——同版本号重发请升版本（patch++）。`,
  );
}

/** @type {object} 待上传的清单：由客户端同一模块的 makeLatest 生成，字段名不可能与 parseLatest 走岔 */
const manifestJson = makeLatest({
  latest: version,
  min: min,
  shellMin: shellMin,
  file: file,
  sha256: sha256,
  hmac: hmac,
  size: size,
  notes: notes,
  prev: prev,
  added: [{ ver: version, file: file, notes: notes, sha256: sha256, hmac: hmac }],
  publishedAt: new Date().toISOString(),
});

// ---- 7. 落待上传件（旧版本正文留在目录里不删，供 versions[] 回滚索引）----
if (dryRun) {
  console.log(
    `[publish-oss] 干跑结束：待上传件未落盘；分发壳只构建到 ${rel(pkgDir)}/，${rel(pkgReal)}/ 未动。`,
  );
} else {
  await mkdir(ossDir, { recursive: true });
  await writeFile(`${ossDir}/${file}`, text);
  await writeFile(latestPath, JSON.stringify(manifestJson, null, 2) + '\n');
}

/** @type {string} 本批的发布身份串（与客户端 identityOf 同口径：正式=版本号，快照=版本号@摘要前 8 位） */
const identity = channel === 'release' ? version : `${version}@${shaTag(sha256)}`;

// ---- 8. 打印上传清单与顺序（顺序反了会让客户端指向一个还不存在的文件）----
console.log(
  [
    '',
    `[publish-oss] v${version}（通道 ${channel}）待上传件已就绪${dryRun ? '（干跑，未落盘）' : ''}：`,
    `  1) ${rel(ossDir)}/${file}  →  ${base}${file}`,
    `     Cache-Control: public, max-age=31536000, immutable`,
    `  2) ${rel(ossDir)}/latest.json  →  ${base}latest.json`,
    `     Cache-Control: no-cache   ← 必设，否则新版被缓存挡住，最长要等一轮 alarms 才看得见`,
    '',
    '  先传正文并确认能 GET 到，再传清单。',
    `  发布身份：v${identity}` +
      (channel === 'release'
        ? ''
        : '（版本号不动、靠摘要推更新；页脚/面板/正文文件名都是这一段，报障时念得出是哪一份）'),
    `  正文 sha256=${sha256.slice(0, 12)}… hmac=${hmac.slice(0, 12)}… size=${size}B`,
    `  清单 min=${min || '(不限)'} shellMin=${shellMin || '(不限)'} versions=[${manifestJson.versions.map((v) => v.ver).join(', ')}]`,
    '',
    `  本批基址：${base}`,
    channel === 'release'
      ? `  朋友侧无需任何动作（刷新页面即在下一次启动时生效）。只有壳改了才需重发 ${rel(pkgReal)}/。`
      : `  本批只影响装了 ${channel} 通道壳的机器（扩展 ID 与正式版不同）；` +
        `正式通道用户读的是另一个基址，看不到 ${base}，不受影响。`,
  ].join('\n'),
);
