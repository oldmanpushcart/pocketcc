/**
 * 发射井「活动窗口」1055 关闭期语义探针（DevTools 一次性粘贴运行）
 *
 * 目的：确认 GET_GUN_FIGHT_INFO(1055) 在【活动关闭期】返回的 start/end 到底是不是"下次开启的未来时刻"，
 *   据此定稿 launch-silo 的窗口外排程（精确睡到开启点 vs 退化为 10min 轮询）。
 *   现有实证样本全是窗口内（start<=cur<end），关闭期无录制——本探针就是补这一手。
 *
 * 运行前提：
 *   1. 已加载 pocketcc 扩展并登录进游戏，控制台左上角切到主世界（MAIN world）上下文；
 *   2. net 已由 boot.js install（进 Home / 世界地图即可）。
 *
 * 只读查询（1055 {} 纯拉信息，不派兵、不改本地态），安全。
 * 建议在【非活动时段】（比如周二 21:00 之前）跑，才能验到关闭期语义。
 */
(async function gunfightWindowProbe() {
  const CMD = 1055;   // GET_GUN_FIGHT_INFO（旧 JSON send 链路）
  const PC = window.pocketcc;
  if (!PC || !PC.net) {
    console.error('[gunfight-probe] window.pocketcc / net 未就绪：确认已加载扩展、登录进游戏、处于主世界上下文。');
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const tryParse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return v; } };
  // unix 秒 → 本地可读串
  const fmt = (sec) => {
    const n = Number(sec);
    if (!n) return '(0/无)';
    const d = new Date(n * 1000);
    return d.toLocaleString() + ' [' + n + ']';
  };

  let r;
  try {
    r = await PC.net.send(CMD, {});
  } catch (e) {
    console.error('[gunfight-probe] send(1055) 抛异常（超时/未 install/非活动期服务器不答？）:', e);
    return;
  }
  if (!r) { console.error('[gunfight-probe] 1055 无返回对象。'); return; }

  H('0) 1055 应答总览');
  console.log('ok=%s  code=%s  data typeof=%s', r.ok, r.code, typeof r.data);
  const data = tryParse(r.data);
  console.log('解析后 keys:', data && typeof data === 'object' ? Object.keys(data) : data);
  console.log('原始 data:', r.data);
  console.log('解析后 data:', data);

  if (!data || typeof data !== 'object') {
    console.warn('[gunfight-probe] data 非对象，无法判 start/end。可能非活动期被拒（看上面 code）。');
    return;
  }

  const cur = Number(data.cur), start = Number(data.start), end = Number(data.end);

  H('1) 时间三元组（核心）');
  console.log('cur  =', fmt(cur));
  console.log('start=', fmt(start));
  console.log('end  =', fmt(end));
  console.log('end-start =', (end && start) ? (end - start) + ' 秒' + ((end - start) === 7200 ? '（=2h，吻合活动时长）' : '') : '(缺 start/end)');

  // 对照 launch-silo cycleRun 的判定
  H('2) 对照 launch-silo 的窗口判定（同 cycleRun 口径）');
  const now = cur || (function () { try { const dc = PC.game && PC.game.get('DataCenter'); return +(dc && dc.DATA && dc.DATA.ServerTime) || 0; } catch (e) { return 0; } })();
  console.log('serverNow 回落值 DataCenter.ServerTime =', fmt(now), '（cur 缺失时才用它）');
  const inWindow = !!(data && start && end && start <= now && now < end);
  console.log('inWindow =', inWindow, '（判据：start && end && start<=now && now<end，[start,end) 左闭右开）');

  console.log('%c[gunfight-probe] ★ 关闭期排程分支结论：', 'color:#e07b00;font-weight:bold');
  if (inWindow) {
    console.log('  → 当前【在窗口内】。本次验不到关闭期语义；请到非活动时段（周二 21:00 前）再跑一次。');
  } else if (start > now) {
    const waitS = start - now;
    console.log('  → 关闭期且 1055 返回【未来 start】（start>now，距开启约 ' + waitS + ' 秒 / ' + Math.round(waitS / 60) + ' 分钟）。');
    console.log('    launch-silo 会走【精确睡到开启点】分支（日志：activity not open, sleep toward start in ~Ns），开启即醒提速。');
  } else {
    console.log('  → 关闭期且 start<=now（1055 返回 0 / 上一期过去时刻 / 无未来排期）。');
    console.log('    launch-silo 会退化为【10min 低频轮询】分支（日志：activity not open, idle.），靠每轮重问 1055 捕获开启。');
  }

  H('3) 井列表（顺带看 owner/占领态）');
  const list = data.list || [];
  console.log('井数:', list.length);
  if (list.length) {
    console.table(list.map((s) => ({ id: s.id, owner: s.owner, ownuid: s.ownuid, tag: s.tag, name: s.name, totem: s.totem, time: s.time })));
  }

  H('贴回结论');
  console.log([
    '1) 关闭期 1055 是否 ok、code 多少（非活动期会不会直接拒/不答）',
    '2) start/end 是"下次开启的未来时刻"还是 0/过去值 → 决定 launch-silo 走"精确睡到点"还是"10min 轮询"',
    '3) cur 是否等于服务器时钟（与 DataCenter.ServerTime 对比）',
  ].join('\n'));
})();
