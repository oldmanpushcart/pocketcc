/**
 * 夺宝奇兵（CSHunt）**进行中**实况提取器（DevTools 一次性粘贴运行，可反复跑）
 *
 * 目的：关闭 feat-夺宝奇兵.md §7 剩余缺口（均需活动开启期数据）——
 *   §7-4 陪跑实态：team.member[i].help 各位 + isHelp() 返回值 + 技能背包 team/personal 分栏；
 *   §7-5 密码掩码实样：eventCodeBoxInfo.codeNum[] 原样（位数/-1 掩码位分布）+ uidWinMap；
 *   §7-7 rollDice 掷骰前奖励字段：eventRollDiceInfo 全量 raw（验证"掷骰前可见物品"落在哪个键）；
 *   §7-8 先知探测字段：DECIDE 阶段 eventInfo 全量 raw（开先知后重跑一次，对比新增字段）；
 *   §7-6 信标发包路径：第 4 段报文 tap 会记录发往游戏的**所有发送包 cmd**——
 *        挂上后去面板点一次"定位信标补次数"，回来重跑本脚本，bundle 里就有那个 cmd。
 *
 * 建议运行时机（每到一个点就跑一次，剪贴板自动覆盖为最新 bundle）：
 *   ① 选场景 DECIDE：开先知**前**一次、开先知**后**一次（两次 bundle 对比即探测字段）；
 *   ② rollDice 场景：掷骰**前**一次、掷骰后一次；
 *   ③ 密码大爆炸进行中；
 *   ④ 被玩家来袭（FIGHT）时；
 *   ⑤ 自己是陪跑（help 位）时；
 *   ⑥ 信标补次数点击**后**（取 tap 里的道具使用 cmd）。
 *
 * 只读游戏数据；第 4 段 hook 仅旁路记录、原样转发，不拦截不改写。
 * 摘除 hook：控制台执行  __csHuntLiveOff()
 * 运行前提：已加载 pocketcc 扩展并登录进游戏（依赖 window.pocketcc.game.get 符号代理）。
 */
(function csHuntLiveDump() {
  const TAG = '[cs-hunt-live] ';
  const PC = window.pocketcc;
  if (!PC || !PC.game || typeof PC.game.get !== 'function') {
    console.error(TAG + 'window.pocketcc.game.get 不可用：确认已加载扩展并登录进游戏。');
    return;
  }
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      console.warn(TAG + 'game.get(%s) 失败', n, e);
      return null;
    }
  };
  const unwrap = (m, k) => (m && (m[k] || (m.default && m.default[k]))) || null;
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const text = (k) => {
    const L = unwrap(G('LocalManager'), 'LOCAL');
    if (!k || !L || typeof L.getText !== 'function') return String(k == null ? '' : k);
    try {
      return String(L.getText(String(k)) || k);
    } catch (e) {
      return String(k);
    }
  };

  // protobuf 消息/Long/循环引用的安全序列化：Long→字符串，深度截断，循环标记
  const safe = (f) => {
    try {
      return f();
    } catch (e) {
      return '(抛错:' + e.message + ')';
    }
  };
  const dump = (v, depth = 0, seen = new WeakSet()) => {
    if (v == null) return v;
    const t = typeof v;
    if (t === 'bigint') return String(v);
    if (t !== 'object') return t === 'function' ? undefined : v;
    // protobufjs Long（含 low/high/unsigned）
    if (v.low !== undefined && v.high !== undefined && typeof v.toString === 'function' && v.__isLong__ !== false) {
      const s = String(v);
      if (/^-?\d+$/.test(s)) return s;
    }
    if (seen.has(v)) return '[circular]';
    if (depth > 8) return '[deep]';
    seen.add(v);
    const C = v.constructor;
    if (C && typeof C.toObject === 'function') {
      const po = safe(() => C.toObject(v, { longs: String, defaults: true }));
      if (po && po !== true && typeof po === 'object') return dump(po, depth + 1, seen);
    }
    if (Array.isArray(v)) return v.slice(0, 80).map((x) => dump(x, depth + 1, seen));
    if (v instanceof Map) return { '[Map size]': v.size, ...Object.fromEntries(Array.from(v.entries()).slice(0, 40).map(([k, x]) => [String(k), dump(x, depth + 1, seen)])) };
    if (v instanceof Set) return Array.from(v).slice(0, 80).map((x) => dump(x, depth + 1, seen));
    const out = {};
    for (const k of Object.keys(v)) {
      const d = dump(v[k], depth + 1, seen);
      if (d !== undefined) out[k] = d;
    }
    return out;
  };

  // ── 0) 控制器实况（ huntCount / team / csHuntInfo 全量）──
  H('0) CSHuntController 实况');
  let ctrl = null;
  const CH = G('CSHuntController');
  const K = unwrap(CH, 'CSHuntController') || (CH && CH.default) || CH;
  const ins = K && typeof K.getInstance === 'function' ? K.getInstance() : null;
  if (!ins) {
    console.warn(TAG + 'getInstance() 返回空——当前不在夺宝运行时态？');
  } else {
    ctrl = {
      huntCount: ins.huntCount,
      lastRecoverTimeMill: String(safe(() => ins.lastRecoverTimeMill)),
      specId: safe(() => ins.specId),
      isTeamLeader: safe(() => ins.isTeamLeader && ins.isTeamLeader()),
      isMeHelp: safe(() => ins.isHelp && ins.isHelp(String(PC.uid || ins.myUid || ''))),
    };
    ctrl.teamRaw = safe(() => dump(ins.team));
    ctrl.csHuntInfoRaw = safe(() => dump(ins.csHuntInfo));
    console.log('概要:', { ...ctrl, teamRaw: '(见下)', csHuntInfoRaw: '(见下)' });
    console.log('team 全量:', ctrl.teamRaw);
    console.log('csHuntInfo 全量:', ctrl.csHuntInfoRaw);
  }

  // ── 1) 当前事件定位 + 类型相关的关键 payload ──
  H('1) 当前场景/事件关键字段（§7-5/§7-7/§7-8）');
  const TM = unwrap(G('TableManager'), 'TABLE');
  const TN = unwrap(G('TableName'), 'TableName') || {};
  const eventRowOf = (specId) => {
    try {
      const rows = TM.getTableGroupArray(TN.cross_treasure_event || 'cross_treasure_event') || [];
      return rows.find((r) => Number(r.id) === Number(specId)) || null;
    } catch (e) {
      return null;
    }
  };
  const info = ins && ins.csHuntInfo;
  const ev = info && info.eventInfo;
  if (!ev) {
    console.warn(TAG + 'eventInfo 不在场——当前不在 EVENT 态（转场/FIGHT/未开车？到点再重跑）。');
  } else {
    const d = safe(() => dump(ev));
    const row = eventRowOf(ev.eventSpecId);
    console.log('status:', safe(() => String(ev.status)), ' round:', safe(() => String(ev.round)),
      ' eventSpecId:', safe(() => String(ev.eventSpecId)),
      ' 事件类型/名:', row ? row.type + ' / ' + text(row.name) : '(表行未命中)');
    console.log('eventInfo 全量 raw（对照"先知探测/掷骰前奖励"字段就看这份）:', d);
    // 分场景点件（存在才打，不存在打 null）
    for (const k of ['eventCodeBoxInfo', 'eventRollDiceInfo', 'eventPickRewardInfo', 'eventPickSkillInfo', 'eventDefPVEInfo', 'eventDecide', 'voteInfo', 'phase', 'timePhaseEnd']) {
      if (d && d[k] !== undefined && d[k] !== null) console.log(' ├─ ' + k + ':', JSON.stringify(d[k]));
    }
  }
  if (info && info.fightInfo) console.log('FIGHT fightInfo（玩家来袭实样）:', safe(() => dump(info.fightInfo)));

  // ── 2) 陪跑/成员实态（§7-4）──
  H('2) 成员 help 位与队伍实态（§7-4 陪跑）');
  const members = (ctrl && ctrl.teamRaw && ctrl.teamRaw.member) || null;
  if (members && members.length) {
    const rows = members.map((m, i) => ({
      idx: i,
      uid: m.uid != null ? String(m.uid) : '?',
      help: m.help,
      name: m.name || m.playerName || '',
    }));
    console.table(rows);
  } else {
    console.warn(TAG + 'team.member 不在场（未组队或字段形态与预期不同——看 0 段 teamRaw 实录）。');
  }

  // ── 3) 技能背包（team/personal 分栏 + 待生效）──
  H('3) 技能背包（cross_treasure_skill 持有态）');
  const skillKeys = ins ? Object.keys(ins).filter((k) => /skill/i.test(k)) : [];
  const skillBag = {};
  for (const k of skillKeys) skillBag[k] = safe(() => dump(ins[k]));
  if (!skillKeys.length) console.warn(TAG + '控制器 own 属性里没 *skill* 键——背包可能挂在面板/子控制器；把本警告连同 0 段一起贴回即可。');
  else console.log(skillBag);

  // ── 4) 报文 tap hook（首次运行安装；重跑只读记录）──
  //   目标：§7-6 信标补次数的道具使用 cmd + 7551 先知应答 + 7532/7535/7537 实样。
  H('4) 报文 tap（CSHunt 号段 + 含 47001001 的发送包）');
  const CS_RANGE = (c) => (Number(c) >= 7501 && Number(c) <= 7599) || (Number(c) >= 21371 && Number(c) <= 21391);
  const LIVE = (window.__csHuntLive = window.__csHuntLive || { tap: [], hooked: false, orig: null, inPB: 0 });
  const remember = (dir, cmd, payload) => {
    try {
      const pj = JSON.stringify(dump(payload));
      const hit470 = pj && pj.indexOf('47001001') >= 0;
      if (!CS_RANGE(cmd) && !hit470) return;
      LIVE.tap.push({ dir, cmd: String(cmd), beaconHit: hit470, at: new Date().toISOString(), payload: (pj || '').slice(0, 4000) });
      if (LIVE.tap.length > 300) LIVE.tap.shift();
      console.log(TAG + 'tap ' + dir + ' cmd=' + cmd + (hit470 ? ' 【含 47001001 ← 信标链路重点看这条】' : ''));
    } catch (e) {}
  };
  if (!LIVE.hooked) {
    const netMgr = G('NetMgr');
    const NET = netMgr && netMgr.NET;
    if (NET && typeof NET.sendPB === 'function') {
      const o1 = NET.sendPB.bind(NET);
      LIVE.orig = { sendPB: NET.sendPB, sendPBV2: NET.sendPBV2, send: NET.send };
      NET.sendPB = function (cmd, data, ...rest) { LIVE.inPB++; remember('req', cmd, data); try { return o1(cmd, data, ...rest); } finally { setTimeout(() => LIVE.inPB--, 0); } };
      if (typeof NET.sendPBV2 === 'function') {
        const o2 = NET.sendPBV2.bind(NET);
        NET.sendPBV2 = function (cmd, data, ...rest) { remember('reqV2', cmd, data); return o2(cmd, data, ...rest); };
      }
      if (typeof NET.send === 'function') {
        const o3 = NET.send.bind(NET);
        NET.send = function (msg, ...rest) { const c = msg && (msg.cmd || msg.header && msg.header.cmd); if (!LIVE.inPB) remember('send', c, msg); return o3(msg, ...rest); };
      }
    } else console.warn(TAG + 'NetMgr.NET 不可用，发送侧 tap 未挂上。');
    const rec = G('NetReciver');
    const inst = rec && rec.getInstance && rec.getInstance();
    if (inst && typeof inst.onMessage === 'function' && !inst.__csHuntLiveTap) {
      const orig = inst.onMessage;
      LIVE.origOnMessage = orig;
      inst.onMessage = function (e, reqTime) {
        const c = e && (e.cmd != null ? e.cmd : e.msgId != null ? e.msgId : e.pbAckV2 && e.pbAckV2.header && e.pbAckV2.header.cmd);
        remember('resp', c, e);
        return orig.call(this, e, reqTime);
      };
      inst.__csHuntLiveTap = true;
      LIVE.recvInst = inst;
    } else console.warn(TAG + 'NetReciver.onMessage 未挂钩（符号缺失或已挂过）。');
    LIVE.hooked = true;
    window.__csHuntLiveOff = () => {
      const n = G('NetMgr') && G('NetMgr').NET;
      if (n && LIVE.orig) { n.sendPB = LIVE.orig.sendPB; n.sendPBV2 = LIVE.orig.sendPBV2; n.send = LIVE.orig.send; }
      if (LIVE.recvInst && LIVE.origOnMessage) { LIVE.recvInst.onMessage = LIVE.origOnMessage; LIVE.recvInst.__csHuntLiveTap = false; }
      LIVE.hooked = false;
      console.log(TAG + 'hook 已摘除（tap 记录保留，重跑脚本可再挂）');
    };
    console.log(TAG + '报文 tap hook **本次首挂**：现在去面板点"定位信标补次数"（若要猎 §7-6），然后重跑本脚本取 bundle。');
  } else {
    console.log(TAG + 'hook 已在场（本次为第 ' + LIVE.tap.length + ' 条记录后重跑），tap 累计:');
  }
  console.table(LIVE.tap.map((x) => ({ at: x.at, dir: x.dir, cmd: x.cmd, beaconHit: x.beaconHit, payloadHead: x.payload.slice(0, 60) })));

  // ── 5) bundle + copy 收口 ──
  H('5) 汇总 bundle（自动复制剪贴板）');
  const bundle = {
    at: new Date().toISOString(),
    phase: ev ? { status: safe(() => String(ev.status)), round: safe(() => String(ev.round)), eventSpecId: safe(() => String(ev.eventSpecId)) } : null,
    ctrl,
    eventRaw: ev ? safe(() => dump(ev)) : null,
    skillBag,
    tap: LIVE.tap,
  };
  const s = JSON.stringify(bundle);
  console.log(TAG + 'bundle 字节数:', s.length, '（tap 条数 ' + LIVE.tap.length + '）');
  try {
    // eslint-disable-next-line no-undef -- copy() 是 DevTools 控制台命令行 API，不在 globals.browser，仅限本探针场景
    copy(s);
    console.log(TAG + '已复制剪贴板：直接 Ctrl+V 贴回。多个时机各跑一次→各贴一次回话即可。');
  } catch (e) {
    console.warn(TAG + 'copy() 不可用，请手动展开各段 JSON 贴回。');
  }
})();
