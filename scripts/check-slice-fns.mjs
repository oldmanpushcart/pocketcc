/**
 * 切片函数注册表自检（挂进 npm run arch）。
 *
 * 背景：目录化拆分（如 feats/system/chat）用 `S.fns` 运行期函数注册表打散兄弟切片互调环，
 * 但这条边对全部静态门禁不可见——depcruise 看不到调用边、eslint 的 no-undef 判不出属性访问、
 * esbuild 不做类型检查。漏登记一个函数时四门禁全绿、线上却在 push 回调/setTimeout/Promise.then
 * 的 fire-and-forget 路径里静默抛 `S.fns.X is not a function`，排查成本极高。
 *
 * 本脚本补上这条显式门禁，对每个「切片目录」做两条判据：
 *   1. used ⊆ registered：所有 `S.fns.X` 使用点必须能在某切片的 Object.assign(S.fns,{…}) 里找到登记；
 *   2. shorthand 可解析：登记花括号里的每个裸名必须在登记文件内声明（function/const/let），防拼写错位。
 * 违例即退出码 1，阻断 arch。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 参与自检的切片目录（相对仓库根）。目录内以 `Object.assign(S.fns, {…})` 登记、以 `S.fns.X` 互调。
 * @type {string[]}
 */
const SLICE_DIRS = ['extension/src/feats/system/chat'];

/** 去掉行内注释前的整行注释（保留代码），用于排除注释/文档里的假使用点 */
function stripLineComment(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return '';
  return line;
}

let violations = 0;
for (const dir of SLICE_DIRS) {
  const abs = path.resolve(dir);
  const files = readdirSync(abs).filter((f) => f.endsWith('.js'));
  const registered = new Map(); // name -> 登记文件（首次出现）
  const used = []; // {name, file, line}

  for (const f of files) {
    const text = readFileSync(path.join(abs, f), 'utf8');
    const lines = text.split('\n');
    // 注释剥离后的纯代码文本（登记与使用提取都只跑在这上面，防文档/注释里的例证假命中）
    const code = lines.map(stripLineComment).join('\n');

    // 登记：Object.assign(S.fns, { a, b, c })（shorthand 列表，允许跨行）
    for (const m of code.matchAll(/Object\.assign\(\s*S\.fns\s*,\s*\{([^}]*)\}\s*\)/gs)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
          console.error(`[check-slice-fns] ${dir}/${f}: 登记项非裸名 shorthand: "${name}"`);
          violations++;
          continue;
        }
        // 判据 2：登记名必须在登记文件内声明
        const declared =
          new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'm').test(code) ||
          new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`, 'm').test(code);
        if (!declared) {
          console.error(`[check-slice-fns] ${dir}/${f}: 登记了未声明的函数 "${name}"`);
          violations++;
        }
        if (registered.has(name)) {
          console.error(
            `[check-slice-fns] ${dir}/${f}: "${name}" 重复登记（已在 ${registered.get(name)}）`,
          );
          violations++;
        }
        registered.set(name, f);
      }
    }

    // 使用：S.fns.X（属性访问，X 后非调用与否均计），已在 code 层面剔除注释行
    code.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/S\.fns\.([A-Za-z_$][\w$]*)/g)) {
        used.push({ name: m[1], file: f, line: i + 1 });
      }
    });
  }

  // 判据 1：used ⊆ registered
  for (const u of used) {
    if (!registered.has(u.name)) {
      console.error(
        `[check-slice-fns] ${dir}/${u.file}:${u.line}: 使用了未登记的 S.fns.${u.name}（线上将抛 not a function）`,
      );
      violations++;
    }
  }
  console.log(
    `[check-slice-fns] ${dir}: 登记 ${registered.size} 项 / 使用 ${used.length} 处${violations ? '' : '，双向一致'}`,
  );
}

if (violations) {
  console.error(`[check-slice-fns] 违例 ${violations} 条，门禁失败`);
  process.exit(1);
}
