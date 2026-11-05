/**
 * 三态报告器（replay 内核 · 全 feat 共享的收集与打印）。
 *
 * 判据分级由各 feat 的 runVerify 通过 check 的 fail 计数体现：
 *   - fail>0            → ❌ FAIL（HARD 违例，影响退出码）
 *   - fail=0 且 pass=0  → 仅「无法判定 / 观察」类，打印 skip 计数（不影响退出码）
 *   - 其余              → ✅ PASS
 * 「无法判定」（稀疏回读、采样局限）走 skip，单独标注、不判负——这是脱机对拍的固有局限。
 */

/**
 * 报告收集器。
 * @param {boolean} verbose 是否展开全部样本（缺省每行只留 3 条）
 */
export function makeReport(verbose = false) {
  const dims = new Map(); // 维度 -> checks[]
  function dim(name) {
    if (!dims.has(name)) dims.set(name, []);
    return dims.get(name);
  }
  function check(name, d, pass, fail, skip, samples) {
    dim(d).push({
      name,
      pass,
      fail,
      skip: skip || 0,
      samples: (samples || []).slice(0, verbose ? Infinity : 3),
    });
  }
  return { dims, check };
}

/**
 * 打印单份录制的分项报告。
 * @param {string} recName
 * @param {object} S 扫描结果（需含 total/parseErr/minTs/maxTs/writes/pairedResp）
 * @param {ReturnType<makeReport>} rep
 * @param {{pass:number,fail:number,notes:string[]}} smoke 引擎装配冒烟
 * @returns {boolean} 是否全部关键不变量通过
 */
export function printReport(recName, S, rep, smoke) {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' 录制仿真对拍验证 · ' + recName);
  console.log('════════════════════════════════════════════════════════════');
  console.log(
    ` 行数 ${S.total}（解析失败 ${S.parseErr}）｜时长 ${((S.maxTs - S.minTs) / 1000).toFixed(0)}s｜写动作 ${S.writes.length} 笔｜应答配对 ${S.pairedResp}`,
  );
  const cmdDist = new Map();
  for (const w of S.writes) cmdDist.set(w.cmd, (cmdDist.get(w.cmd) || 0) + 1);
  console.log(
    ' 写动作分布: ' +
      [...cmdDist.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}×${v}`)
        .join(' '),
  );

  const totals = { pass: 0, fail: 0 };
  for (const [dimName, checks] of rep.dims) {
    console.log('\n── 维度：' + dimName + ' ──');
    for (const c of checks) {
      const verdict = c.fail > 0 ? '❌ FAIL' : '✅ PASS';
      totals.pass += c.pass;
      totals.fail += c.fail;
      console.log(
        `  ${verdict}  ${c.name}  [通过 ${c.pass}｜违例 ${c.fail}${c.skip ? '｜无法判定 ' + c.skip : ''}]`,
      );
      for (const s of c.samples) console.log('        · ' + s);
    }
  }

  if (smoke) {
    console.log('\n── 维度：引擎装配冒烟 ──');
    console.log(
      `  ${smoke.fail > 0 ? '❌ FAIL' : '✅ PASS'}  模块导入与导出面  [通过 ${smoke.pass}｜违例 ${smoke.fail}]`,
    );
    for (const n of smoke.notes) console.log('        · ' + n);
  }

  return totals.fail === 0 && (!smoke || smoke.fail === 0);
}
