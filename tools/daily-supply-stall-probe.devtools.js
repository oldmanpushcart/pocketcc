/**
 * 每日补给（daily-supply）停摆诊断探针（DevTools 一次性粘贴运行，默认全程只读、零发包）
 *
 * 用法：登录进游戏、处于 MAIN world 控制台（window.pocketcc 可见）后整段粘贴运行。
 *   先跑同步诊断（A–F + 结论），再按需调 window.__dsWatch(60000) / window.__dsForceClaim() 做活体确认。
 *
 * feat 判据（extension/src/feats/player/daily-supply.js）回顾——三态 + 择时：
 *   effectiveState()：取「权威 UserData.timeReward」与「内存镜像 mirror」中 rewardTime 较新者；
 *   readyInfo()：查 online_reward[times+1].time，leftSec = interval - (ServerTime - rewardTime)；
 *     无第 times+1 行 → capped（睡到日界）；leftSec<=0 → ready（发 825 领）；否则 wait；无态 → idle。
 *
 * 停摆假设（本探针逐一定位）：
 *   H1 capped 正常长睡：跑到表末档，行为正确只是安静（等日切）。
 *   H2 wait 未到点：下一档间隔还没到（最长约 2h 属正常）。
 *   H3 reactor 门控/暂停：isRunning=false（离开 base/world 或 homeland 态、面板停用、reload 后未启用）。
 *   H4 镜像锁死（feat 设计隐患）：日切把权威 timeReward 重置成更早 rewardTime+归零 times，
 *      而内存 mirror 的 rewardTime 更晚 → 永久压制权威 → 误判 capped/wait。reload 会清 mirror（故仅同会话内可能）。
 *   H5 循环/发送停摆：cycle 未排上或 net 不可用 → 到点也不发 825。
 *
 * 判读关键：mirror/cycle 定时器是 feat 模块私有，控制台读不到；用「权威算出 READY 却不见领取」这一症状
 *   + __dsForceClaim（服务器码=0 说明确有可领、问题在客户端 H4/H5；码≠0 说明服务端本就无奖 H1/H2）+
 *   __dsWatch（观察 cycle 是否真的在发 825）三者三角定位。
 */
(function dailySupplyStallProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.reactor) {
    console.error(
      '[ds-stall-probe] window.pocketcc 未就绪（缺 gameApi/reactor）：确认已加载扩展、已登录、MAIN world 上下文。',
    );
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const KV = (k, v) => console.log('  ' + k + ':', v);
  const { l10n, gameData } = PC.gameApi;
  const CMD = 825;
  const TABLE = 'ONLINE_REWARD';

  // ── A. reactor 运行态（H3 门控/暂停）──────────────────────────────
  H('A. reactor 运行态（H3）');
  const running = PC.reactor.isRunning('dailySupply');
  KV('isRunning(dailySupply)', running);
  try {
    const ws = PC.worldState && PC.worldState.current ? PC.worldState.current() : null;
    if (ws) KV('worldState', { kind: ws.kind, place: ws.place, phase: ws.phase });
    const sn = PC.gameApi.scene && PC.gameApi.scene.name ? PC.gameApi.scene.name() : '(n/a)';
    KV('scene.name', sn);
  } catch (e) {
    KV('场景探测异常', e && e.message);
  }
  console.log(
    '  说明：feat 门 places:[base,world] + kinds:[homeland]。isRunning=false → 命中 H3（被门控/暂停/未启用），' +
      '回到白名单场景或面板启用后 reactor 会自动 resume、cycle 重排。',
  );

  // ── B. 权威 timeReward + ServerTime ──────────────────────────────
  H('B. 权威 UserData.timeReward / ServerTime');
  let rawTR;
  try {
    rawTR = PC.game.get('DataCenter').DATA.UserData.timeReward;
  } catch (e) {
    rawTR = '(取不到: ' + e.message + ')';
  }
  KV('raw', rawTR);
  const auth = gameData.timeReward(); // feat 同款 ACL 归一（times>=0 && rewardTime>0 才非 null）
  KV('ACL 归一', auth);
  const srv = gameData.serverTime();
  KV('ServerTime', srv + (srv ? ' (' + new Date(srv * 1000).toLocaleString() + ')' : ''));
  if (auth) KV('距上次记录已过', Math.round((srv - auth.rewardTime) / 60) + ' min；times=' + auth.times);

  // ── C. online_reward 表（档位/间隔，判 capped 边界）───────────────
  H('C. online_reward 表');
  const rows = l10n.tableRows(TABLE);
  if (!rows || !rows.length) {
    console.warn('  表未就绪/为空 → feat 判 idle 每 15min 巡检（也表现为"不领取"）。检查 tableManager 符号是否加载。');
  } else {
    KV('行数（=当日封顶档数）', rows.length);
    const probeTimes = auth ? [auth.times - 1, auth.times, auth.times + 1] : [0, 1, 2];
    for (const t of probeTimes) {
      const row = l10n.tableRow(TABLE, t + 1); // feat 用 times+1 行的 time 作下档间隔
      console.log(
        '  times=' + t + ' → 查第 ' + (t + 1) + ' 行: ' +
          (row ? 'time=' + row.time + ' (' + Math.round((Number(row.time) || 0) / 60) + 'min)' : '!! 无行 → capped'),
      );
    }
  }

  // ── D. feat 判据原样重算（按权威态）──────────────────────────────
  H('D. 判据重算（按权威 timeReward）');
  const calc = (label, tr) => {
    if (!tr) {
      console.log('  ' + label + ' → idle（数据未就绪，15min 巡检）');
      return { state: 'idle' };
    }
    const row = l10n.tableRow(TABLE, tr.times + 1);
    const interval = row ? Number(row.time) || 0 : 0;
    if (!(interval > 0)) {
      console.log('  ' + label + ' → capped（第 ' + (tr.times + 1) + ' 行缺失，睡到本地日界）');
      return { state: 'capped', times: tr.times };
    }
    const leftSec = interval - (srv - tr.rewardTime);
    if (leftSec <= 0) {
      console.log('  ' + label + ' → READY（应立刻发 825 领；interval=' + Math.round(interval / 60) + 'min，已超 ' + Math.round(-leftSec / 60) + 'min）');
      return { state: 'ready', times: tr.times };
    }
    const eta = new Date(Date.now() + leftSec * 1000).toLocaleTimeString();
    console.log('  ' + label + ' → wait（interval=' + Math.round(interval / 60) + 'min，还剩 ' + Math.round(leftSec / 60) + 'min，约 ' + eta + ' 到点）');
    return { state: 'wait', times: tr.times, leftSec };
  };
  const verdict = calc('按权威', auth);

  // ── E. 镜像锁死（H4）症状线索 ────────────────────────────────────
  H('E. 镜像 mirror（H4，模块私有不可直读，看症状）');
  console.log(
    '  mirror 是 feat 内存私有变量，控制台无法直接读；reload 会清空它（故 H4 只在"上次领取后未刷新页面"的同一会话内可能）。',
  );
  if (verdict.state === 'ready' && running) {
    console.warn(
      '  ⚠ 权威算出 READY 且 reactor 在跑，但若日志久无 "daily supply claimed" → 高度怀疑 H4（mirror 用更晚 rewardTime 压制了日切后的权威）或 H5（cycle 未排上）。用 __dsForceClaim / __dsWatch 定案。',
    );
  } else {
    console.log('  当前权威态非 READY（' + verdict.state + '），mirror 压制无从显现；H4 暂不成立。');
  }

  // ── F. 结论速判 ──────────────────────────────────────────────────
  H('F. 结论速判（贴回 A–E 原文即可定位）');
  let lead = '未知';
  if (!running) lead = 'H3 门控/暂停：isRunning=false。回 base/world+homeland 场景或面板启用后自愈。';
  else if (verdict.state === 'capped') lead = 'H1 capped 正常长睡：跑到表末档，等日切，非故障。';
  else if (verdict.state === 'wait') lead = 'H2 wait 未到点：下档间隔未至（最长约 2h 属正常）。';
  else if (verdict.state === 'idle') lead = '数据未就绪：timeReward=null 或 online_reward 表未加载，feat 走 15min 巡检。';
  else lead = '权威=READY 且在跑却不领 → H4 镜像锁死 / H5 cycle 停摆，需 __dsForceClaim + __dsWatch 三角定位。';
  console.log('  初步结论：' + lead);

  // ── G. 活体工具（按需调用，非默认执行）──────────────────────────
  // __dsWatch(ms)：挂 net 钩子观察 cycle 是否真的在发/收 825（默认 60s），返回退订函数。
  window.__dsWatch = function (ms) {
    ms = ms || 60000;
    if (!PC.net || !PC.net.onReq) {
      console.error('[__dsWatch] pocketcc.net 不可用');
      return;
    }
    const t0 = Date.now();
    const offReq = PC.net.onReq(CMD, (ev) =>
      console.log('[ds-watch] ↑ 发出 825 @', new Date().toLocaleTimeString(), ev && ev.data),
    );
    const offResp = PC.bus.on('net.resp.' + CMD, (ev) => {
      const r = ev && ev.data ? ev.data : ev;
      console.log('[ds-watch] ↓ 825 应答 @', new Date().toLocaleTimeString(), 'code=', r && r.code, r);
    });
    console.log('[ds-watch] 监听 ' + ms + 'ms。到点仍无 ↑发出 825 且 isRunning=true → H5 cycle 停摆。');
    const timer = setTimeout(() => {
      offReq && offReq();
      offResp && offResp();
      console.log('[ds-watch] 结束（历时 ' + Math.round((Date.now() - t0) / 1000) + 's）。全程无 825 收发即佐证客户端未尝试。');
    }, ms);
    return () => {
      clearTimeout(timer);
      offReq && offReq();
      offResp && offResp();
    };
  };

  // __dsForceClaim()：手动发一条 825，用服务器码区分「服务端无奖(H1/H2)」vs「客户端没去领(H4/H5)」。
  //   ⚠ 这是本探针唯一的发包动作，与 feat 领取同一条 cmd、幂等（无奖时仅返回 code≠0），确需定案再调。
  window.__dsForceClaim = async function () {
    if (!PC.net || !PC.net.send) {
      console.error('[__dsForceClaim] pocketcc.net 不可用');
      return;
    }
    console.log('[__dsForceClaim] 发送 825 …');
    const ret = await PC.net.send(CMD, {});
    let d = ret && ret.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (e) {}
    }
    const code = ret ? ret.code : 'NO_RET';
    console.log('[__dsForceClaim] ok=', ret && ret.ok, 'code=', code, 'data=', d);
    if (ret && ret.ok)
      console.log('  → 服务器受理（确有可领）：客户端此前该领没领 = H4/H5。回看权威 mirror 与 __dsWatch。');
    else console.log('  → 服务器拒绝（code≠0）：服务端此刻本就无可领 = H1/H2 属正常静默，非停摆。');
    return ret;
  };

  console.log(
    '%c\n可用活体工具：window.__dsWatch(60000) 观测 cycle 是否发 825；window.__dsForceClaim() 手动探一次服务器码。',
    'color:#3aa655',
  );
})();
