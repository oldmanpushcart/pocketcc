/**
 * 引擎装配冒烟（replay 内核）：逐模块 import + 导出面校验。
 *
 * 不驱动私有 cycle（风险高、需 stub 全套 env），只做「模块能解析 + 关键导出在册」的静态冒烟，
 * 保证 feat 目录没被改崩、协议/引擎文件仍在。feat 只需声明 { 文件名: [期望导出名...] }。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * @param {string} featDir feat 模块绝对目录（各引擎 .js 所在）
 * @param {Record<string,string[]>} modsMap 文件名 -> 期望导出名列表
 */
export async function engineSmoke(featDir, modsMap) {
  const res = { pass: 0, fail: 0, notes: [] };
  for (const [file, names] of Object.entries(modsMap)) {
    try {
      const m = await import(pathToFileURL(path.join(featDir, file)).href);
      for (const n of names) {
        if (m[n]) res.pass++;
        else {
          res.fail++;
          res.notes.push(`${file} 缺导出 ${n}`);
        }
      }
    } catch (e) {
      res.fail++;
      res.notes.push(`${file} import 失败: ${e.message}`);
    }
  }
  return res;
}
