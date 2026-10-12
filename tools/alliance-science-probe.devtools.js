/**
 * 联盟科技捐赠「为什么停了」诊断器（DevTools 一次性粘贴运行）
 *
 * 背景：面板日志刷 `donate honor capped today (server addPoint=0), skip until reset.`，
 *   这条来自 feats/daily/alliance-science.js 的 tickBody()，由模块内私有 flag honorCappedDay 命中当天触发。
 *   honorCappedDay 只在 donateScience() 里「某枚 1144 应答里 sid!=null 但 addPoint===0」时被置位，
 *   一旦置位，当天后续每 tick 开头直接 return null 停捐（科技+遗迹两链都停），跨零点才自然解禁。
 *
 * 本脚本目标：不改代码、只取证，回答三问——
 *   1) feat 到底是不是被这道「当日封顶」闸拦住的（能量池/金币/目标是否其实都正常）？
 *   2) 服务端真实荣誉是否真的满了（本地 donateDailyHonor 会因直发包绕过游戏 handler 而恒滞后，不可信）？
 *   3) 冒烟枪：现场发 1 枚真实捐赠，观察应答里的 addPoint 到底是几——
 *      addPoint>0 ⇒ 荣誉没满 ⇒ honorCappedDay 是误判（上一枚恰好回了 0，如某 sid 特例/字段缺失）；
 *      addPoint===0 ⇒ 服务端确实封顶 ⇒ 停捐是对的，需等零点。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏、处于主世界（MAIN world）控制台上下文。
 *   只读段（1~3）零副作用；第 4 段「活体捐赠探针」默认关闭（PROBE_DONATE=false），置 true 才会
 *   真发 1 枚 1144（消耗 1 次捐赠能量 + 若干金币），用于取到服务端权威 addPoint。
 */
(async function allianceScienceProbe() {
  // ── 活体捐赠探针开关：置 true 会真发捐赠（每枚消耗 1 点捐赠能量 + 若干金币），用于取服务端权威 addPoint ──
  const PROBE_DONATE = true;
  // ── 探针目标 sid 列表：null=用当前 donateTarget；追加 10900 可单独验「建筑池捐赠是否回 addPoint=0」这一误封疑凶 ──
  //    例：const PROBE_SIDS = [null, 10900];
  const PROBE_SIDS = [null, 10900];

  const PC = window.pocketcc;
  const gd = PC && PC.gameApi && PC.gameApi.gameData;
  if (!PC || !PC.net || !gd) {
    console.error('[as-probe] window.pocketcc.net / gameApi.gameData 不可用：确认已加载扩展并登录进游戏（主世界上下文）。');
    return;
  }

  // 常量与 feat 对齐（见 alliance-science.js）
  const CMD_DONATE = 1144; // ALLIANCE_DOANTE_SCIENCE（科技金币捐）
  const E_SCIENCE = 4; // EnergyType.ALLIANCE_DONATE_NUM
  const E_BUILDING = 6; // EnergyType.ALLIANCE_BUILDING_DONATE_GOLD_NUM（仅 sid 10900）
  const E_RELIC = 7; // EnergyType.ALLIANCE_WORLDSITE_DONATE_GOLD_NUM
  const SID_BUILDING_DONATE = 10900;

  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const jsonOf = (ret) => {
    let d = ret && ret.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (e) {
        return null;
      }
    }
    return d && typeof d === 'object' ? d : null;
  };

  // ── 0) feat 运行态：确认它确实还「活着」，只是被内部闸挡住，而非压根没跑/被暂停 ──
  H('0) feat 运行态');
  let running = null;
  try {
    running = PC.reactor && PC.reactor.isRunning('allianceScience');
  } catch (e) {
    running = 'isRunning 异常: ' + e.message;
  }
  console.log('reactor.isRunning("allianceScience") =', running);
  console.log(
    running === true
      ? '→ feat 在跑。日志刷 skip 说明确实卡在 tickBody 的 honorCappedDay 当日闸上（见第 2/4 段）。'
      : '→ feat 当前未运行（面板未启用 / 不在 Home·NWorldMap / 战斗模式暂停）。这不是捐赠封顶，先查启用与场景门控。',
  );

  // ── 1) 能量池：捐赠次数是否真的还有余量（point>0）──
  H('1) 能量池（捐赠次数余量）');
  const pools = [
    ['科技池 type=4', E_SCIENCE],
    ['建筑池 type=6 (sid10900)', E_BUILDING],
    ['遗迹池 type=7', E_RELIC],
  ];
  console.table(
    pools.map(([name, t]) => {
      const e = gd.energy(t);
      return e
        ? { 池: name, point: e.point, pointMax: e.pointMax, nextRecoverSec: e.nextRecoverSec }
        : { 池: name, point: '（取不到）' };
    }),
  );

  // ── 2) 荣誉与目标快照（注意：本地 dailyHonor 可能恒滞后，别只信它）──
  H('2) 科技/遗迹态快照');
  const sc = gd.allianceScience();
  if (!sc) {
    console.warn('→ allianceScience() 返回 null：多半不在盟或数据未填充，这不是封顶停捐。');
  } else {
    console.log({
      本地dailyHonor: sc.dailyHonor,
      服务端荣誉上限honorCap: sc.honorCap,
      本地闸是否命中: sc.honorCap > 0 && sc.dailyHonor >= sc.honorCap,
      recommendId: sc.recommendId,
      donateTarget: sc.donateTarget,
      donateRecommended: sc.donateRecommended,
      costCoin: sc.costCoin,
      金币余额: gd.coins(),
      金币够不够: gd.coins() >= (sc.costCoin || 0),
    });
    console.log(
      '⚠ 提醒：插件只直发 1144/1067、不走游戏应答 handler，本地 donateDailyHonor 不会被自家捐包刷新；' +
        '「本地闸是否命中=false」并不能证明服务端荣誉没满——务必看第 4 段服务端权威 addPoint。',
    );
  }

  const rl = gd.allianceRelic ? gd.allianceRelic() : null;
  console.log('遗迹 relicCostCoin=', rl && rl.relicCostCoin, '; donateTarget=', rl && rl.donateTarget, '; FunctionOn(Relic_upgrade_time)=', gd.functionOn('Relic_upgrade_time'));

  // ── 3) 判定汇总：给出最可能的停捐原因 ──
  H('3) 停捐原因初判（只读段能定的部分）');
  if (!sc) {
    console.log('· allianceScience() 为空 → 非「封顶停捐」，是不在盟/数据未就绪。');
  } else {
    const tgtPool = sc.donateTarget && sc.donateTarget.id === SID_BUILDING_DONATE ? gd.energy(E_BUILDING) : gd.energy(E_SCIENCE);
    const relE = gd.energy(E_RELIC);
    console.log('· 科技可捐目标存在：', !!sc.donateTarget, '| 对应池余量：', tgtPool && tgtPool.point);
    console.log('· 遗迹可捐目标存在：', !!(rl && rl.donateTarget), '| 遗迹池余量：', relE && relE.point);
    console.log('· 若上面「目标有 + 池有余 + 金币够」全成立，而面板仍在刷 skip → 基本锁定：被 honorCappedDay 当日闸误封，请跑第 4 段拿服务端 addPoint 定论。');
  }

  // ── 4) 冒烟枪：活体捐赠探针（默认关闭）──
  H('4) 活体捐赠探针（读服务端权威 addPoint）');
  if (!PROBE_DONATE) {
    console.log(
      '%c[未执行] 把脚本顶部 PROBE_DONATE 改成 true（可把 PROBE_SIDS 设成 [null, 10900] 顺带验建筑池误封疑凶）再粘贴运行，就会真发捐赠并打印应答 addPoint。',
      'color:#d9822b',
    );
    return;
  }
  if (!sc || !sc.donateTarget) {
    console.warn('→ 没有可捐目标（donateTarget 为空），无法用 null 探当前目标；可把 PROBE_SIDS 改成 [10900] 单测建筑池。');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 逐个目标发一枚，串行观察 addPoint；null → 当前 donateTarget
  const targets = PROBE_SIDS.map((s) => (s == null ? (sc && sc.donateTarget ? sc.donateTarget.id : null) : s)).filter((s) => s != null);
  if (!targets.length) return;

  const results = [];
  for (const tid of targets) {
    const poolType = tid === SID_BUILDING_DONATE ? E_BUILDING : E_SCIENCE;
    const before = gd.energy(poolType);
    if (before && before.point <= 0) {
      console.warn('→ sid=%d 的池 type=%d point=0，跳过（发了也会被拒次数不足，验不出 addPoint 语义）。', tid, poolType);
      continue;
    }
    console.log('即将发 1144 {scienceId:%d,type:1,num:1}；捐前池 point=%s，金币=%s', tid, before && before.point, gd.coins());
    let ret;
    try {
      ret = await PC.net.send(CMD_DONATE, { scienceId: tid, type: 1, num: 1 });
    } catch (err) {
      console.error('[as-probe] 探针发包异常 sid=%d：', tid, err);
      continue;
    }
    const payload = jsonOf(ret);
    const after = gd.energy(poolType);
    H('应答 · sid=' + tid);
    console.log({ ok: ret.ok, code: ret.code, raw: ret.data, payload });
    console.log('捐后池 point=', after && after.point);
    if (!payload || payload.sid == null) {
      console.log('%c→ 应答无 sid（被拒或畸形），本次不算成功捐；请看 code/raw 判断是哪道闸。', 'color:#d9822b');
      results.push({ sid: tid, donated: false, addPoint: null });
      await sleep(600);
      continue;
    }
    const addPt = Number(payload.addPoint);
    console.log('服务端 sid=%s 回 addPoint=%s（原始值：%o）', payload.sid, addPt, payload.addPoint);
    results.push({ sid: tid, donated: true, addPoint: addPt });
    await sleep(600);
  }

  // ── 综合结论 ──
  H('4) 探针结论');
  console.table(results.map((r) => ({ sid: r.sid, 成功捐: r.donated, addPoint: r.addPoint })));
  const cur = results.find((r) => r.sid !== SID_BUILDING_DONATE && r.donated);
  const bld = results.find((r) => r.sid === SID_BUILDING_DONATE && r.donated);
  if (cur) {
    if (cur.addPoint > 0) {
      console.log(
        '%c✔ 当前目标 addPoint>0 ⇒ 服务端荣誉没满 ⇒ tickBody 的 honorCappedDay 当日闸是误封！重载/刷新插件即可当日临时解禁。',
        'color:#dc3545;font-weight:bold',
      );
    } else {
      console.log('%c→ 当前目标 addPoint=0 ⇒ 服务端确实荣誉封顶，停捐是对的，需等零点重置。', 'color:#2aa198;font-weight:bold');
    }
  }
  if (cur && bld && cur.addPoint > 0 && bld.addPoint === 0) {
    console.log(
      '%c★ 定位到误封根因：普通科技 addPoint>0（荣誉没满），但 sid=10900（建筑捐赠）addPoint=0。' +
        'donateScience 只看“addPoint===0”就当荣誉封顶并停两链整天 → 只要当轮目标恰为 10900，就会误封。' +
        '修法：封顶判定应排除 10900（它本就不加个人荣誉），或改以「本地 dailyHonor 逼近 honorCap」/「连续多枚普通科技均回0」为准。',
      'color:#dc3545;font-weight:bold',
    );
  }
})();
