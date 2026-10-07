/**
 * 每日补给（daily-supply）卡死诊断探针（DevTools 一次性粘贴运行，全程只读零发包）
 *
 * 背景：feat 于 04:16 启动后成功领了 #13..#17（间隔 55/70/86/100 min 递增），之后不再领取。
 * 本探针把 feat 判据在运行时原样重算一遍，一次性确认四种互斥的卡死假设：
 *   H1 capped 正常长睡：online_reward 表没有第 times+1 行 → feat 睡到日界，行为正确只是安静；
 *   H2 镜像锁死（feat 设计缺陷）：服务端日切把权威 timeReward 重置成「更早的 rewardTime + 归零 times」，
 *      而 feat 内存镜像的 rewardTime 更晚 → 镜像永久压制权威 → 永远判 capped；
 *   H3 仍在 wait：第 times+1 行的 time 只是还没到（下节看 leftSec）；
 *   H4 循环停摆：reactor 未 running（场景/门控 pause）或 cycle 定时器没排上。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，处于 MAIN world 控制台上下文（pocketcc 全局可见）。
 * 末尾「贴回结论」把 A–E 五段一起贴回即可定位。
 */
(function dailySupplyProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.reactor) {
    console.error('[daily-supply-probe] window.pocketcc 未就绪（缺 gameApi/reactor）：确认已加载扩展、已登录、MAIN world 上下文。');
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const { l10n, gameData } = PC.gameApi;

  // ── A. feat 运行态 ──────────────────────────────────────────────
  H('A. reactor 运行态');
  console.log('isRunning(dailySupply) =', PC.reactor.isRunning('dailySupply'));
  try {
    const sc = PC.gameApi.scene;
    console.log('当前场景:', sc && typeof sc.current === 'function' ? sc.current() : '(scene.current 不可用)');
  } catch (e) { console.log('场景探测异常:', e && e.message); }

  // ── B. 权威 timeReward（游戏本地态，脚本直发不回写→可能陈旧）──
  H('B. 权威 UserData.timeReward');
  const rawTR = (() => { try { return PC.game.get('DataCenter').DATA.UserData.timeReward; } catch (e) { return '(取不到: ' + e.message + ')'; } })();
  console.log('raw =', rawTR);
  const auth = gameData.timeReward();   // feat 同款 ACL 口径（times>=0 && rewardTime>0 才非 null）
  console.log('ACL 归一 =', auth);
  const srv = gameData.serverTime();
  console.log('ServerTime =', srv, '(', srv ? new Date(srv * 1000).toLocaleString() : '-', ',)');
  if (auth) console.log('权威口径：距上次记录已过', Math.round((srv - auth.rewardTime) / 60), 'min；times =', auth.times);

  // ── C. online_reward 配置表全行 ────────────────────────────────
  H('C. online_reward 表（档位/间隔）');
  const rows = l10n.tableRows('ONLINE_REWARD');
  if (!rows || !rows.length) {
    console.warn('表未就绪或为空（feat 会每 15min idle 巡检，同样表现为"不领取"）');
  } else {
    console.log('行数 =', rows.length);
    console.table(rows.map((r) => ({ id: r.id, time: r.time, timeMin: Math.round((Number(r.time) || 0) / 60) })));
    // 按实证领取节奏外推：#17 之后 feat 查的是第 18 行，逐行看 13..20
    for (let t = 13; t <= 20; t++) {
      const row = l10n.tableRow('ONLINE_REWARD', t + 1);   // 注意：feat 用 times+1 行，这里列 times→查询行
      console.log('times=' + t + ' → 查第 ' + (t + 1) + ' 行:', row ? 'time=' + row.time : '!! 无行（capped）');
    }
  }

  // ── D. feat 判据重算（分别按权威 / 按镜像假说）──────────────────
  H('D. 判据重算');
  const lastClaim = { times: 17, note: '日志末条 claimed (#17) 09:50:17，应答回写的镜像值' };
  const calc = (label, tr) => {
    if (!tr) { console.log(label, '→ idle（数据未就绪）'); return; }
    const row = l10n.tableRow('ONLINE_REWARD', tr.times + 1);
    const interval = row ? Number(row.time) || 0 : 0;
    if (!(interval > 0)) { console.log(label, '→ capped（第', tr.times + 1, '行缺失，睡到日界）'); return; }
    const leftSec = interval - (srv - tr.rewardTime);
    console.log(label, '→', leftSec <= 0 ? 'READY（应立刻领）' : 'wait', '; interval=' + Math.round(interval / 60) + 'min; left=' + Math.round(leftSec / 60) + 'min');
  };
  calc('D1 按权威 timeReward 算:', auth);
  // 镜像假说：feat 内存里镜像是 #17 应答的 {times:17, rewardTime:≈09:50}，只有日切/重登才会被权威覆盖
  const mirrorGuess = (() => {
    // 用权威 times+? 无法还原镜像 rewardTime，退化为按日志时刻估：今晨 09:50:17 本地→秒
    const d = new Date(); d.setHours(9, 50, 17, 0);
    return { times: lastClaim.times, rewardTime: Math.floor(d.getTime() / 1000) };
  })();
  calc('D2 按镜像(times=17, 今晨09:50 领)算:', mirrorGuess);
  if (auth && mirrorGuess.rewardTime > auth.rewardTime) {
    console.warn('⚠ 镜像 rewardTime 晚于权威 → effectiveState() 会取镜像。若权威 times 明显小于 17（日切重置），即命中 H2 镜像锁死。');
  }

  // ── E. 汇总贴回 ────────────────────────────────────────────────
  H('E. 结论速判（贴回以上各段原文）');
  console.log(
    '判读：A.isRunning=false → H4 停摆/被门控；',
    'C 无第 times+1 行且 D1/D2=capped → H1（正常，等日界）或跨日后仍 capped → H2；',
    'D2=wait 且 left>0 → H3（没到点，interval 比想象大）；',
    'D2=READY 且 A=true 但日志无动作 → cycle 排程问题（把 feat 开 net log 复现）。'
  );
})();
