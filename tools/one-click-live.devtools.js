/**
 * 一键领取（ONE-CLICK）在线观测 + 强制补扫探针（DevTools 一次性粘贴运行）
 *
 * 用法场景：one-click-probe.devtools.js 的 P1–P6 全绿（spec 在、enabled、符号齐、门控放行、
 *   taskRelaxOpenRows() 非空、5684 回 limitTimeSec=0 不在冷却、isSending 两头都 false），
 *   也就是说「该领、能领、允许领」但 feat 就是没动作 —— 剩下的唯一嫌疑是 cycle 排程本身。
 *   本探针把这一嫌疑证真/证伪，靠三件事：
 *     ① 常开观察器：onReq(5684/5685) 抓本端发包、net.resp.* 抓应答、console hook 抓
 *        [POCKETCC://ONE-CLICK] / [CYCLE] 行（含 next check at 那条择时日志）并打时间戳，
 *        存进 window.__ocw.rows，免受控制台视图被刷/被折叠影响；
 *     ② 强制补扫：reactor.setConfig 先关后开，走一遍 pause→activate→run()→cycle.kick()，
 *        这是外部唯一能拉起一轮的手段（activate 对已 running 的条目幂等直返，不重跑 run）；
 *     ③ 看时间线：kick 之后 8s 内有没有 5684 出去、有没有 5685 出去、应答里逐行 code 是什么。
 *
 * 判读（脚本末尾也会打一遍）：
 *   T1 kick 后有 5684 req+resp，随后 5685 req → cycle 与闸门都正常，之前的静止就是「日锚长睡」
 *      （领过一次即睡到下一个 0 点，最长 24h，其间日间新增的收益一律不领）→ 是调度口径问题，不是故障；
 *   T2 kick 后连 5684 都没出去 → 那一轮被卡在 in-flight（cycle 闭包 running 恒 true，
 *      后续 kick 只置 pending 而本 feat 不读 pending）或 alive() 判定错位 → 排程层要加看门狗；
 *   T3 5684 有应答但 5685 没发 → 回到择时分支重看（cooldownDelay 把 limitTimeSec 当成很久之后 /
 *      nextDailyResetTs 折算错日界线）；
 *   T4 5685 发了、detail 全 code≠0 → 服务器判「这些行此刻无累积收益」，属正常业务态（领到 0 行也照样睡到 0 点）。
 *
 * ⚠️ 副作用：② 会真的触发一次领取发包（5685），即把当日累积收益领走。这是预期收益、非破坏性操作，
 *   但若你此刻正想手动领、或想先留着收益，请只跑第 1 段（把 FORCE_SCAN 置 false，纯观察）。
 * 合规：全程只订阅 + 只经 reactor 公开入口推配置，不改游戏本地数据、不 OpenUI、不写存储。
 */

/** @type {boolean} 是否执行「强制补扫」（关→开面板开关，会真的领一次）。false=只装观察器静默看。 */
const FORCE_SCAN = true;

/** @type {number} 强制补扫后观察时间线的秒数 */
const WATCH_SEC = 8;

(async function oneClickLiveWatch() {
  const PC = window.pocketcc;
  if (!PC || !PC.reactor || !PC.net || !PC.gameApi) {
    console.error('[one-click-live] window.pocketcc 未就绪（缺 reactor/net/gameApi）。');
    return;
  }
  const ID = 'oneClickClaim';
  const CMD_INFO = 5684;
  const CMD_REWARD = 5685;
  const { gameData } = PC.gameApi;

  // ── 1. 常开观察器（幂等：重复粘贴不会叠两层 hook）────────────────
  const W = (window.__ocw = window.__ocw || {});
  if (W.installed) {
    console.log(
      '[one-click-live] 观察器已在位，跳过重复安装。rows 已有',
      (W.rows || []).length,
      '条。',
    );
  } else {
    W.rows = [];
    W.t0 = Date.now();
    const rec = (kind, payload) => {
      const row = { at: new Date().toLocaleTimeString(), dt: Date.now() - W.t0, kind, payload };
      W.rows.push(row);
      console.log(
        '%c[OCW] ' + kind + ' @' + row.at + ' (+' + row.dt + 'ms)',
        'color:#e67e22',
        payload,
      );
    };
    W.rec = rec;
    // 本端发包（onReq 会按需拉起发送 hook，务必经它而非直接 bus.on）
    PC.net.onReq(CMD_INFO, (e) =>
      rec('REQ ' + CMD_INFO + ' 载荷', JSON.parse(JSON.stringify(e.data))),
    );
    PC.net.onReq(CMD_REWARD, (e) =>
      rec('REQ ' + CMD_REWARD + ' 载荷', JSON.parse(JSON.stringify(e.data))),
    );
    // 应答（raw 池化复用，同拍快照）
    const onResp = (cmd) => (ev) =>
      rec('RESP ' + cmd + ' status=' + ev.status, JSON.parse(JSON.stringify(ev.data || null)));
    PC.bus.on('net.resp.' + CMD_INFO, onResp(CMD_INFO));
    PC.bus.on('net.resp.' + CMD_REWARD, onResp(CMD_REWARD));
    // feat/cycle 自己的日志行也进 rows（next check at 那条是择时唯一自证）
    W.hooked = {};
    for (const lvl of ['info', 'debug', 'warn']) {
      const orig = console[lvl].bind(console);
      W.hooked[lvl] = orig;
      console[lvl] = function (fmt, ...rest) {
        orig(fmt, ...rest);
        const line = typeof fmt === 'string' ? fmt : String(fmt);
        if (/POCKETCC:\/\/(ONE-CLICK|CYCLE|REACTOR)/.test(line)) {
          const row = {
            at: new Date().toLocaleTimeString(),
            dt: Date.now() - W.t0,
            kind: 'LOG',
            payload:
              line + (rest.length ? ' | ' + rest.map((r) => JSON.stringify(r)).join(' ') : ''),
          };
          W.rows.push(row);
        }
      };
    }
    W.installed = true;
    // 解除：__ocw.off()
    W.off = function () {
      for (const lvl of Object.keys(W.hooked)) console[lvl] = W.hooked[lvl];
      W.installed = false;
      console.log('[one-click-live] 观察器已摘（rows 保留在 __ocw.rows 供贴回）。');
    };
    console.log(
      '[one-click-live] 观察器装好。之后 5684/5685 与 ONE-CLICK/CYCLE 日志都会带时间戳进 __ocw.rows。',
    );
  }

  // ── 2. 基线 ────────────────────────────────────────────────────
  const srv = gameData.serverTime();
  const next = gameData.nextDailyResetTs();
  const rows = gameData.taskRelaxOpenRows();
  console.table([
    { 项: 'isRunning', 值: PC.reactor.isRunning(ID) },
    {
      项: 'isSending 5684 / 5685',
      值: PC.net.isSending(CMD_INFO) + ' / ' + PC.net.isSending(CMD_REWARD),
    },
    { 项: '可用行', 值: rows.map((r) => r.id + ':' + r.type).join(' ') },
    { 项: '距下一个服务器 0 点', 值: next && srv ? Math.round((next - srv) / 60) + ' min' : '-' },
  ]);

  // ── 3. 强制补扫（pause→activate 借道 run() 里的 cycle.kick）──────
  if (!FORCE_SCAN) {
    console.log(
      '[one-click-live] FORCE_SCAN=false：只观察不动手。等下一次自然排程（可能到 0 点）。',
    );
    return;
  }
  console.log(
    '%c[one-click-live] 即将推 setConfig enabled=false → true 强制起一轮（会真的领一次）。',
    'color:#e74c3c',
  );
  PC.reactor.setConfig(ID, { enabled: false });
  await new Promise((r) => setTimeout(r, 400));
  console.log(
    '  pause 后 isRunning =',
    PC.reactor.isRunning(ID),
    '（应为 false，且应有一行 LOG pause）',
  );
  W.rows.length = 0; // 时间线从 kick 起算
  W.t0 = Date.now();
  PC.reactor.setConfig(ID, { enabled: true });
  console.log('  activate 后 isRunning =', PC.reactor.isRunning(ID), '; 观察', WATCH_SEC, 's …');
  await new Promise((r) => setTimeout(r, WATCH_SEC * 1000));

  // ── 4. 时间线与判读 ────────────────────────────────────────────
  console.log(
    '%c\n===== 强制补扫后的时间线（+ms 相对 kick） =====',
    'color:#4a90d9;font-weight:bold',
  );
  if (!W.rows.length)
    console.warn(
      '!! 8 秒内零事件：既没发包也没日志 → 见判读 T2（那一轮挂在 in-flight，kick 只置了 pending）。',
    );
  else
    console.table(W.rows.map((r) => ({ at: r.at, dt_ms: r.dt, kind: r.kind, payload: r.payload })));
  const seen = (k) => W.rows.some((r) => r.kind.indexOf(k) === 0);
  console.log(
    [
      '',
      '判读：',
      seen('REQ ' + CMD_REWARD)
        ? 'T1/T4：本轮确实跑到领取分支（5685 已发）。看 RESP 5685 的 detail 逐行 code：有 0 = 领到了（那之前的静止就是日锚长睡，不是故障）；全非 0 = T4，服务器判无累积收益。'
        : seen('REQ ' + CMD_INFO)
          ? 'T3：5684 发了但没发 5685 → 卡在择时分支，看 RESP 5684 的 limitTimeSec 与 nextDailyResetTs 折算。'
          : 'T2：kick 后连 5684 都没发 → cycle 内部 in-flight 没落地（run() 的 kick 撞上了 running=true 只置 pending，而 feat 不读 pending），或 alive 判定错位。',
      '另：LOG 行里若出现 "next check at [yyyy-MM-dd HH:mm:ss] (after N sec)" 且 N≈19000+（数小时）→ 印证日锚睡；完全没这行 → 印证停摆。',
      '贴回：整段时间线 + 最后一条 next check at 的原文即可定改法。',
    ].join('\n'),
  );
})();
