// 架构图体积哨兵（构建期，npm run arch 尾部）：
// depcruise 本版 schema 已不收 options.maxNodes，图规模「该拆了」的机器提醒改由本脚本把守——
// cruise 节点总数超阈值只 console.warn 不置错（不阻断提交），阈值语义与原计划 maxNodes:500 一致。
// 依赖零第三方：child_process 调本仓已装的 depcruise CLI，解析其 summary JSON。
// 调用方式刻意不走 npx/shell：Windows 上 'npx' 不是可执行文件名（要 npx.cmd），而 new URL(..).pathname 会给出 '/C:/…'
//   这种 win32 不认的盘符前缀（ENOENT → 哨兵静默跳过）；故直接用当前 node 跑仓内 CLI，cwd 走 fileURLToPath。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_NODES = 500;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(
  new URL('../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', import.meta.url),
);

let summary;
try {
  const out = execFileSync(
    process.execPath,
    [CLI, 'extension/src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  summary = JSON.parse(out).summary;
} catch (e) {
  // depcruise 自身违规退出码非 0 时 stdout 仍是合法 JSON——解析失败才当真（环境问题），降级提示不吞主闸门结论
  const stdout = e && e.stdout ? String(e.stdout) : '';
  try {
    summary = JSON.parse(stdout).summary;
  } catch {
    console.warn(
      '[arch-size-guard] depcruise 输出不可解析，体积检查跳过（不影响 arch 主闸门结论）',
    );
    process.exit(0);
  }
}

const nodes = summary ? summary.totalCruised : 0;
if (nodes > MAX_NODES) {
  console.warn(
    `[arch-size-guard] ⚠ 依赖图节点数 ${nodes} 已超过阈值 ${MAX_NODES}——core 有文件该按域拆目录了（见 pocketcc-extension skill 分层红线）`,
  );
} else {
  console.log(`[arch-size-guard] 依赖图节点数 ${nodes}/${MAX_NODES}，体积健康`);
}
process.exit(0);
