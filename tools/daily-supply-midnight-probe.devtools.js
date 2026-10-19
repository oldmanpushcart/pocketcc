/**
 * 每日补给（dailySupply）「0 点起停摆」诊断探针 v2（DevTools 一次性粘贴运行，本体只读零发包）
 *
 * 场景：feat 从昨日某刻起不再领取，停摆起点恰在本地 0 点（日界）附近。
 * 对照 feat 源码 extension/src/feats/player/daily-supply.js 的判据原样重算，逐一定位：
 *   H1 档位跑满正常长睡：times 到表末（36）→ capped，睡到「本地日界+5min」。
 *      ⚠ 0 点场景变体：若游戏日界是 UTC 0 点（= 本地 08:00），而 feat 的 dayRollDelay 按本地 0 点睡，
 *      00:05 醒时服务端尚未重置 → 权威仍 capped → 再睡一个"本地日界" → 若两边永远错开即表现为每日停摆。
 *   H2 wait 未到点：下档间隔未至（最长 120min 属正常）。
 *   H3 门控/暂停：isRunning=false（场景不在 places/kinds 白名单、面板停用、reload 后未启用）。
 *   H4 镜像锁死（日切高发）：昨日末拍领取把 mirror.rewardTime 推到接近 0 点；日切服务端把权威
 *      timeReward 重置为「更早 rewardTime + times 归零」，但直发不回写、若无 push 10001 全量下发，
 *      权威就不会追平 → mirror（rewardTime 更新）永久压制 → 按镜像误判 wait/capped。
 *   H5 cycle 停摆：到点不发 825（定时器没排上/net 不可用）。
 *
 * 活体工具（默认不执行）：
 *   __dsWatch2(ms)  挂 net/bus 钩子记录 825 收发与 push 里的 timeReward 回写（建议停摆到点前开 3~5min）；
 *   __dsForceClaim() 手动发一条 825，用服务器码三角定位：受理=客户端没去领(H4/H5)，拒绝=服务端无奖(H1/H2)。
 *
 * 贴回 A–F 六段原文即可定位。
 */
(function dailySupplyMidnightProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.reactor) {
    console.error(
      '[ds-midnight-probe] window.pocketcc 未就绪（缺 gameApi/reactor）：确认已加载扩展、已登录、MAIN world 上下文。',
    );
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const KV = (k, v) => console.log('  ' + k + ':', v);
  const { l10n, gameData } = PC.gameApi;
  const CMD = 825;
  const TABLE = 'ONLINE_REWARD';

  // ── A. reactor 运行态（H3）──────────────────────────────────────
  H('A. reactor 运行态（H3）');
  const running = PC.reactor.isRunning('dailySupply');
  KV('isRunning(dailySupply)', running);
  try {
    const sn = PC.gameApi.scene && PC.gameApi.scene.name ? PC.gameApi.scene.name() : '(n/a)';
    KV('scene.name', sn);
  } catch (e) {
    KV('场景探测异常', e && e.message);
  }
  if (!running)
    console.warn('  isRunning=false → H3：回 base/world + homeland 场景或面板启用后 reactor 自动 resume。');

  // ── B. 权威 timeReward / ServerTime / 本地钟 ────────────────────
  H('B. 权威态与时钟');
  let rawTR;
  try {
    rawTR = PC.game.get('DataCenter').DATA.UserData.timeReward;
  } catch (e) {
    rawTR = '(取不到: ' + e.message + ')';
  }
  KV('raw UserData.timeReward', rawTR);
  const auth = gameData.timeReward();
  KV('ACL 归一', auth);
  const srv = gameData.serverTime();
  const srvDate = srv ? new Date(srv * 1000) : null;
  KV('ServerTime', srv + (srvDate ? ' (' + srvDate.toLocaleString() + ')' : ''));
  KV('本机墙上钟', new Date().toLocaleString());
  if (srvDate) {
    // 服务器时区偏移（近似）：ServerTime 与本地毫秒差，>1min 才列出
    const diffMin = Math.round((Date.now() - srv * 1000) / 60000);
    if (Math.abs(diffMin) > 1) KV('本地钟 - 服务器钟', diffMin + ' min');
    // 服务器日的 UTC 起点：验证日界到底落在本地几点
    const utcDayStartMs = Math.floor((srv * 1000) / 86400000) * 86400000;
    KV('UTC 日界(服务器秒口径)对应本地时刻', new Date(utcDayStartMs).toLocaleString());
  }
  if (auth) {
    const trDate = new Date(auth.rewardTime * 1000);
    KV('rewardTime 本地可读', trDate.toLocaleString());
    KV('距上次记录已过', Math.round((srv - auth.rewardTime) / 60) + ' min；times=' + auth.times);
    // 日切线索：权威 rewardTime 若落在「本地昨日 00:00~08:00 区间且 times 很小」，说明服务端已重置过
    const hoursSinceAuthDay = (srv % 86400) / 3600;
    KV('服务器日内时刻(UTC 口径 h)', hoursSinceAuthDay.toFixed(2));
  }

  // ── C. online_reward 表末档核对（H1 判据）───────────────────────
  H('C. online_reward 表');
  const rows = l10n.tableRows(TABLE);
  if (!rows || !rows.length) {
    console.warn('  表未就绪/为空 → feat 判 idle 每 15min 巡检（也表现为"不领取"）。');
  } else {
    KV('行数（=当日封顶档数）', rows.length);
  }

  // ── D. 双口径判据重算（权威 vs 镜像锁死对照，H1/H2/H4）──────────
  H('D. 判据重算（feat readyInfo 原样）');
  const calc = (label, tr) => {
    if (!tr) return console.log('  ' + label + ' → idle（无数据）'), { state: 'idle' };
    const row = l10n.tableRow(TABLE, tr.times + 1);
    const interval = row ? Number(row.time) || 0 : 0;
    if (!(interval > 0)) {
      console.log('  ' + label + ' → capped（第 ' + (tr.times + 1) + ' 行缺失，feat 睡到本地日界+5min）');
      return { state: 'capped', times: tr.times };
    }
    const leftSec = interval - (srv - tr.rewardTime);
    if (leftSec <= 0) {
      console.log('  ' + label + ' → READY（应发 825；interval=' + Math.round(interval / 60) + 'min，已超 ' + Math.round(-leftSec / 60) + 'min）');
      return { state: 'ready', times: tr.times };
    }
    const eta = new Date(Date.now() + leftSec * 1000).toLocaleTimeString();
    console.log('  ' + label + ' → wait（interval=' + Math.round(interval / 60) + 'min，剩 ' + Math.round(leftSec / 60) + 'min，约 ' + eta + '）');
    return { state: 'wait', times: tr.times, leftSec };
  };
  const verdict = calc('按权威', auth);
  // 镜像不可直读（模块私有）。H4 症状公式：昨日最后一次领取的应答 timeReward 已入 mirror，
  // 若权威 times 明显小于「昨日领取进度」且 rewardTime 停在日切前，则 mirror 大概率压制中。
  // 对照法：手工模拟「镜像值 = 权威最后一次领取前 +1 档」重算一遍——
  if (auth) {
    const guessedMirror = { times: auth.times + 1, rewardTime: srv - 60 }; // 若今天其实一直在领、只是没回写权威
    calc('按假想镜像(昨末拍+1)', guessedMirror);
    console.log('  说明：上一行是"如果 mirror 停留在昨日末拍"时的判据；若它为 wait/capped 而权威是 READY → H4 镜像锁死成立的核心症状。');
  }

  // ── E. 日界时区核对（0 点场景专属：capped 循环睡的可能性）────────
  H('E. 日界口径核对（0 点停摆关键）');
  if (auth && rows && rows.length) {
    const cappedNow = auth.times + 1 >= rows.length && !(l10n.tableRow(TABLE, auth.times + 1) && Number(l10n.tableRow(TABLE, auth.times + 1).time) > 0);
    if (cappedNow) {
      console.log('  权威口径当前 capped：feat 每次醒来都会重算，只有当「服务端 times 重置」与「feat 醒来时刻」对上才恢复。');
      KV('本地日界醒来点', '本地 00:05 前后（dayRollDelay=本地次日0点+5min）');
      KV('服务器 times 归零所需下发', '登录全量 或 push 10001 回写 UserData（直发 825 不回写）');
      console.log('  → 若 00:05 醒来时服务端日界(按服务器时区)未过/推送未到，将再睡 24h，表现即"0 点起天天停摆"。用 __dsWatch2 在 00:00 前后观察是否收到含 timeReward 的 push。');
    } else {
      console.log('  权威口径当前非 capped（=' + verdict.state + '），E 段仅供日界时刻参考。');
    }
  } else {
    console.log('  数据不全（auth 或表缺失），跳过 E。');
  }

  // ── F. 结论速判 ─────────────────────────────────────────────────
  H('F. 结论速判（贴回 A–E 原文即可定位）');
  let lead = '未知';
  if (!running) lead = 'H3 门控/暂停：isRunning=false，非 0 点专属问题。';
  else if (verdict.state === 'capped') lead = 'H1 capped 长睡：重点看 E 段——feat 按本地日界醒，服务端按自己时区重置，两者错开则是日界线口径缺陷。';
  else if (verdict.state === 'wait') lead = 'H2 wait 未到点（若 leftSec>130min 或 times 异常大，结合 B 段 rewardTime 考虑 H4）。';
  else if (verdict.state === 'idle') lead = '数据未就绪：timeReward=null 或表未加载，走 15min 巡检档。';
  else lead = '权威=READY 且在跑却不领 → H4 镜像锁死 / H5 cycle 停摆，用 __dsForceClaim + __dsWatch2 三角定位。';
  console.log('  初步结论：' + lead);

  // ── G. 活体工具（按需调用，非默认执行）──────────────────────────
  window.__dsWatch2 = function (ms) {
    ms = ms || 180000;
    if (!PC.net || !PC.net.onReq) {
      console.error('[__dsWatch2] pocketcc.net 不可用');
      return;
    }
    const t0 = Date.now();
    const ups = [];
    const offReq = PC.net.onReq(CMD, (ev) => {
      ups.push(new Date().toLocaleTimeString());
      console.log('[ds-watch2] ↑ 发出 825 @', new Date().toLocaleTimeString(), ev && ev.data);
    });
    const offResp = PC.bus.on('net.resp.' + CMD, (ev) => {
      const r = ev && ev.data ? ev.data : ev;
      console.log('[ds-watch2] ↓ 825 应答 @', new Date().toLocaleTimeString(), 'code=', r && r.code, r);
    });
    // 盯 UserData 回写通道：日切/登录全量下发一般走 push（如 10001 系列）。
    // ⚠ bus 无通配订阅且 dispatch 懒构造（无人订阅 net.<cmd> 就不派发），故临时包 bus.emit 看全量事件；
    //   raw 是池化复用对象，只能在 emit 同步栈内读 ev.data，监听结束即还原。
    const busRef = PC.bus;
    let origEmit = null;
    if (busRef && typeof busRef.emit === 'function') {
      origEmit = busRef.emit;
      busRef.emit = function (type, ev) {
        try {
          if (ev && String(type).indexOf('net.') === 0) {
            const d = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data || '');
            if (d.indexOf('timeReward') >= 0)
              console.log('[ds-watch2] ✎ push 含 timeReward @', new Date().toLocaleTimeString(), 'type=', type, d.slice(0, 300));
          }
        } catch (e) {}
        return origEmit.call(this, type, ev);
      };
    } else {
      console.warn('[ds-watch2] pocketcc.bus 不可用，跳过 push 回写观测（仅盯 825 收发）。');
    }
    const restore = () => {
      if (origEmit && busRef) {
        busRef.emit = origEmit;
        origEmit = null;
      }
    };
    console.log('[ds-watch2] 监听 ' + ms + 'ms：到点无 ↑ 且 isRunning=true → H5；0 点前后若见 ✎ push → 权威回写正常，锁死另有其因。');
    const timer = setTimeout(() => {
      offReq && offReq();
      offResp && offResp();
      restore();
      console.log('[ds-watch2] 结束（历时 ' + Math.round((Date.now() - t0) / 1000) + 's，发出 825 共 ' + ups.length + ' 次）。');
    }, ms);
    return () => {
      clearTimeout(timer);
      offReq && offReq();
      offResp && offResp();
      restore();
    };
  };

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
    console.log('[__dsForceClaim] ok=', ret && ret.ok, 'code=', ret && ret.code, 'data=', d);
    if (ret && ret.ok)
      console.log('  → 服务器受理（确有可领，返回 timeReward=', d && d.timeReward, '）：客户端该领没领 = H4/H5。');
    else console.log('  → 服务器拒绝（code≠0）：服务端此刻本就无可领 = H1/H2 正常静默。注意：受理会把该档计入昨日进度，测前知晓。');
    return ret;
  };

  console.log(
    '%c\n活体工具：window.__dsWatch2(300000)（建议卡在下一拍 ETA 或 0 点前后开）；window.__dsForceClaim() 定案服务器码。',
    'color:#3aa655',
  );
})();
