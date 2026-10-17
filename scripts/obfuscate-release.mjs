// 授权包二次混淆（仅构建期）：对 extension/dist/*.js 原地做字符串数组编码，
// 把中文提示串/水印从字面量里抽走，拦住「搜『核验』二字定位闸门」的 L2 路标式破解。
// 判据：dist/build-info.json 的 licensed 标记（= release 授权包）才执行；
// sidecar 不在本阶段删除，留给 package-friend 取昵称（链路：esbuild → obfuscate → package-friend）。
// 强度取保守档位：只做字符串编码 + 十六进制改名，**不开** selfDefending / debugProtection /
// controlFlowFlattening —— 本仓大量正则字面量与游戏符号耦合（cc.director、协议字段名），激进档位易误伤运行时行为。
import obfuscatorPkg from 'javascript-obfuscator';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

// CJS 包在 Node ESM 下只有 default 导出：类形式自带 .obfuscate，default 即 Obfuscator 类
const Obfuscator = obfuscatorPkg.Obfuscator || obfuscatorPkg;

const root = fileURLToPath(new URL('../', import.meta.url));
const distDir = `${root}extension/dist`;
const sidecar = `${distDir}/build-info.json`;

// 无 sidecar（非 release）或 licensed=false（无限制包）都不做二次混淆。
if (!existsSync(sidecar)) {
  console.log('[obfuscate] 非 release 构建（无 build-info.json），跳过。');
  process.exit(0);
}
const buildInfo = JSON.parse(await readFile(sidecar, 'utf8'));
if (!buildInfo.licensed) {
  console.log('[obfuscate] 无限制 release 包，跳过二次混淆。');
  process.exit(0);
}

/** @type {import('javascript-obfuscator').ObfuscatorOptions} */
const options = {
  compact: true,
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStringsChunkLength: 8,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, // IIFE 顶层即 chrome 脚本作用域，全局改名易碰游戏符号，保守不动
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: true,
  target: 'browser',
};

const files = ['content.js', 'bridge.js', 'background.js'];
for (const f of files) {
  const p = `${distDir}/${f}`;
  const src = await readFile(p, 'utf8');
  const out = Obfuscator.obfuscate(src, options).getObfuscatedCode();
  await writeFile(p, out);
  console.log(`[obfuscate] ${f}: ${src.length} -> ${out.length}`);
}
console.log('[obfuscate] done');
