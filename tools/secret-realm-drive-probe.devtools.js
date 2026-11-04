/**
 * 异能秘境「自动驾驶不动」定责探针（DevTools 一次性粘贴运行，纯只读、零发包）
 *
 * 背景：dashcam 20261031T210443（UID 15596140531952）整场 3 分钟里只有 3 笔 8521，
 *   每笔前 0.7~1.0s 都有一笔同坐标 8522（= 人工「查驻军→前往」），而期间队伍停在出生点
 *   51 秒、视口里一直有 iNum>0 的 173 资源点 → 自动驾驶引擎一笔都没资格/没机会发车。
 *   本探针把「引擎到底被哪一道闸按着」逐条打出来，用来定责，不改任何游戏数据。
 *
 * 运行前提：已加载 pocketcc 扩展、已登录、**已进入异能秘境地图**、MAIN world 控制台
 *   （window.pocketcc 可见，F12 → Console 直接粘贴即可）。
 *
 * 只读承诺：
 *   · 只读 reactor / storage / game-api 快照，**不发任何 85xx 包**（不探路、不试探 8521）；
 *   · 只订阅 push 10018 与「本端 8521 发出」事件做观测，窗口结束自动退订；
 *   · 唯一写动作：B2 段把面板已有配置按 registry 口径（toModuleCfg）重推一次给 reactor，
 *     与「面板里再点一次保存」完全等价——不改游戏数据、不发网络包，用来判定配置链是否通；
 *   · 唯一副作用：把结果同时挂到 window.__pcDriveProbeLast 便于回看。
 *
 * 用法：
 *   __pcDriveProbe()        // 默认观测 12 秒
 *   __pcDriveProbe(20)      // 自定义观测秒数
 *   观测期间请**把镜头在秘境地图上拖一圈**（10018 是「进视口才推」的增量，
 *   不拖镜头可能一条点位证据都收不到，探针会明确提示）。
 *
 * 贴回：把控制台里 "=====" 分段的全部输出（含结论段）一起贴回即可定责。
 */
(function secretRealmDriveProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.gameApi.secretRealm) {
    console.error(
      '[drive-probe] window.pocketcc 未就绪：确认已加载 pocketcc 扩展、已登录，并在游戏页 DevTools 的 Console（MAIN world，top 框架）里执行。',
    );
    return;
  }
  const SR = PC.gameApi.secretRealm;
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const OK = (s) => console.log('%c  ✔ ' + s, 'color:#1a7f37');
  const NO = (s) => console.log('%c  ✘ ' + s, 'color:#c0392b;font-weight:bold');
  const KV = (k, v) => console.log('    ' + k + ' =', v);
  const safe = (fn, fb) => {
    try {
      return fn();
    } catch (e) {
      return '(抛:' + ((e && e.message) || e) + ')';
    }
  };
  /** Int64 / {_low,_high} / number → 数值（与 pilot.js toNum 同口径） */
  const toNum = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'object') {
      try {
        if (typeof v.toNumber === 'function') return Number(v.toNumber()) || 0;
      } catch (e) {}
      const hi = Number(v._high);
      const lo = Number(v._low);
      if (Number.isFinite(hi) || Number.isFinite(lo)) {
        return (Number.isFinite(hi) ? hi : 0) * 4294967296 + (Number.isFinite(lo) ? lo >>> 0 : 0);
      }
      return 0;
    }
    return Number(v) || 0;
  };
  /** 与 pilot.js 同一把尺子（欧氏格距） */
  const dist = (ax, ay, bx, by) => {
    const dx = Number(ax) - Number(bx);
    const dy = Number(ay) - Number(by);
    return Number.isFinite(dx) && Number.isFinite(dy) ? Math.sqrt(dx * dx + dy * dy) : Infinity;
  };
  const PT = {
    161: '商店',
    163: '掉落箱',
    172: '野怪',
    173: '资源点',
    174: '平台',
    175: '营帐',
    176: 'BOSS平台',
    177: '大BOSS',
    178: '小BOSS',
    179: '出生点',
  };
  const ptName = (p) => (PT[p] ? PT[p] + '(' + p + ')' : '其它(' + p + ')');
  const ms2s = (ms) => Math.round(ms / 1000) + 's';
  const now = () => Date.now();

  // ── 现场快照（每段复用）────────────────────────────────────────────────
  const readBase = () => safe(() => SR.getRoomBaseInfo(), null);
  const readLeader = () => safe(() => SR.isTeamLeader(), '(抛)');
  const readMoored = () => safe(() => SR.teamIsMooring(), '(抛)');
  const readSending = () => safe(() => SR.isSecretSending(8521), '(抛)');
  const readCapture = () =>
    safe(() => {
      const p = SR.getPabController();
      const c = p && p.capturingPetPos;
      if (!c) return null;
      return { x: toNum(c.x), y: toNum(c.y), boss: Number(c.boss) || 0 };
    }, null);
  const marchStateName = (() => {
    const S = safe(() => SR.getNMarchState(), null) || {};
    return (v) => {
      const hit = Object.keys(S).find((k) => Number(S[k]) === Number(v));
      return (hit || '?') + '(' + v + ')';
    };
  })();

  window.__pcDriveProbe = async function (seconds) {
    const sec = Math.max(6, Math.min(60, Number(seconds) || 12));

    // ── A. 扩展与场景 ───────────────────────────────────────────────────
    H('A. 扩展 / 场景（引擎跑不跑得起）');
    const dump = safe(() => PC.worldState && PC.worldState.dump && PC.worldState.dump(), {});
    KV('worldState', JSON.stringify(dump));
    const isPab = safe(() => SR.isPabBattleMap(), '(抛)');
    const sceneName = safe(
      () => (PC.gameApi.scene && PC.gameApi.scene.name && PC.gameApi.scene.name()) || '(取不到)',
      '(抛)',
    );
    KV('scene.name()', sceneName);
    const running = safe(() => PC.reactor && PC.reactor.isRunning('secretRealm'), false);
    if (isPab !== true) {
      NO('当前不在秘境战斗图（isPabBattleMap≠true）→ secretRealm 被场景门控 pause，任何引擎都不会动');
    } else {
      OK('在秘境战斗图内（isPabBattleMap=true）');
    }
    if (running) OK("reactor.isRunning('secretRealm') = true（feat 已激活）");
    else NO("reactor.isRunning('secretRealm') = false（feat 未激活 → 先看面板总开关/门控）");

    // ── A2. 引擎内部快照（唯一能看见 #tiles / 相位 / 闸门的口）────────────
    H('A2. 引擎内部快照 pocketcc.secretRealmDrive.debugState()');
    const ENG = PC.secretRealmDrive;
    const dumpEngine = () =>
      ENG && typeof ENG.debugState === 'function' ? safe(() => ENG.debugState(), null) : null;
    const ds = dumpEngine();
    const ticksBefore = ds ? ds.ticks : null;
    if (!ENG) {
      NO('window.pocketcc.secretRealmDrive 不存在 → 引擎实例未被创建（run() 抛错 / feat 未激活 / dist 未含本次改动）');
    } else if (!ds) {
      NO('secretRealmDrive 存在但 debugState() 取不到 → 旧构建（重跑 npm run build + 重载扩展）');
    } else {
      KV('active', ds.active);
      KV('ticks / lastTick', ds.ticks + ' 次 / ' + ds.lastTickAgoMs + 'ms 前');
      KV('lastBranch（本拍停在哪）', ds.lastBranch || '(空=未进入阶梯)');
      KV('lastDispatch（本拍派发结论）', ds.lastDispatch || '(无)');
      KV('gate（各路闸当前态）', JSON.stringify(ds.gate));
      KV('cd（cd 账本剩余 ms：march=唯一 TO 锁，>0 时日常链发车会被 #can 短睡拦一拍）', JSON.stringify(ds.cd));
      KV('phase', JSON.stringify(ds.phase));
      KV('cfgDrive（引擎自己读到的）', JSON.stringify(ds.cfgDrive));
      KV('elapsedSec（fightBegin 起）', ds.elapsedSec);
      KV('idleSec（无候选静默）', ds.idleSec + 's（≥30s 应已触发探索档）');
      KV(
        'shopRestockCoolLeftMs（商店冷却）',
        ds.phase && ds.phase.shopRestockCoolLeftMs != null
          ? Math.round(ds.phase.shopRestockCoolLeftMs / 1000) + 's（⑥ 期间不回店）'
          : '(旧构建无此字段)',
      );
      // ── v3（pilot）新增料源：这三行是「能不能开车」的真正答案 ──
      KV('version（引擎版本）', ds.version || '2（旧 drive.js）');
      KV('stage（本拍阶段）', (ds.stage || '(空)') + (ds.stageWhy ? ':' + ds.stageWhy : ''));
      KV(
        'anchors.shops（表格商店权威坐标）',
        ds.anchors
          ? ds.anchors.shops.length + ' 家 group=' + ds.anchors.group + ' → ' + JSON.stringify(ds.anchors.shops)
          : '(旧构建无此字段)',
      );
      KV(
        'view（901 主动视口）',
        ds.view
          ? 'off=' + ds.view.off + ' busy=' + ds.view.busy + ' miss=' + ds.view.miss +
              ' lastAgo=' + ds.view.lastAgoMs + 'ms last=' + JSON.stringify(ds.view.last)
          : '(旧构建无此字段)',
      );
      KV(
        'sausage（41011 香肠余量）',
        ds.sausage != null ? ds.sausage + '（<10 会触发去商店）' : '(旧构建无此字段)',
      );
      KV('tiles.size', ds.tiles.size);
      KV(
        'realmClosed（战场已封闭）',
        ds.phase && ds.phase.realmClosed != null
          ? ds.phase.realmClosed + '（true = 服务端 enigma_realm17 已回，本场驱动停手）'
          : '(旧构建无此字段)',
      );
      KV(
        'cruiseDbg（巡航筛除计数）',
        ds.cruiseDbg || ds.pick ? JSON.stringify(ds.cruiseDbg || ds.pick) : '(旧构建无此字段)',
      );
      KV('tiles.byPt', JSON.stringify(ds.tiles.byPt));
      if (Array.isArray(ds.marched) && ds.marched.length)
        KV('marched（60s 内已派过的点）', JSON.stringify(ds.marched).slice(0, 260));
      KV('consumed', ds.consumed.length + ' 条 ' + JSON.stringify(ds.consumed).slice(0, 260));
      KV('dayBlack', JSON.stringify(ds.dayBlack));
      // ── D1 crystal 路线补验（§11）：events 推导 + zone 阈值 + buffTried ──
      if (ds.crystal) {
        KV('crystal.planId（本次开车方案）', ds.crystal.planId || '(未锁定)');
        KV('crystal.driveStrongRoundMin（强区回合阈值）', ds.crystal.driveStrongRoundMin + '（0=关闭分区）');
        KV('crystal.zoneEnabled', ds.crystal.zoneEnabled);
        KV('crystal.events（BOSS 开窗时刻推导）', JSON.stringify(ds.crystal.events));
        KV('crystal.buffTriedCount（探明无 buff 位的井数）', ds.crystal.buffTriedCount);
      } else {
        KV('crystal', '(旧构建无此字段)');
      }
      KV('told（已打过的一次性提示）', JSON.stringify(ds.told));
      const own = ds.tiles.detail
        .filter((t) => t.pt === 173 || t.pt === 163 || t.pt === 161)
        .slice(0, 40);
      own.forEach((t) =>
        console.log(
          '    tile ' + ptName(t.pt) + ' (' + t.x + ',' + t.y + ') iNum=' + t.iNum +
            ' rTime=' + (t.rTime > 1e11 ? new Date(t.rTime).toLocaleTimeString() : '-') +
            ' state=' + t.state + ' teams=' + t.teams +
            ' age=' + Math.round((t.ageMs || 0) / 1000) + 's',
        ),
      );
    }

    // ── B. 持久化配置（总闸在不在）──────────────────────────────────────
    H('B. 面板保存的配置（自动驾驶总闸在这里）');
    let cfg = null;
    try {
      cfg = await PC.storage.get('pocketcc.feat.secretRealm');
    } catch (e) {
      NO('读配置抛错：' + ((e && e.message) || e));
    }
    if (!cfg || typeof cfg !== 'object') {
      NO('该 UID 下没有已保存配置 → 一切走默认值，而 driveEnabled 默认 = false');
    } else {
      const driveKeys = ['driveEnabled', 'driveBoss', 'driveShopTime', 'driveShopDwell', 'driveEmptyDwell'];
      driveKeys.forEach((k) => KV(k, cfg[k] === undefined ? '(未保存)' : cfg[k]));
      KV('feat.enabled', cfg.enabled);
      KV('warnEnabled / warnMode', String(cfg.warnEnabled) + ' / ' + String(cfg.warnMode));
      KV('autoLeaveEnabled / scoutEnabled', String(cfg.autoLeaveEnabled) + ' / ' + String(cfg.scoutEnabled));
      KV('pickItems 行数', cfg.pickItems && typeof cfg.pickItems === 'object' ? Object.keys(cfg.pickItems).length : 0);
      KV('原始配置(截断)', JSON.stringify(cfg).slice(0, 400));
      if (cfg.driveEnabled === true) OK('driveEnabled = true（总闸已开）');
      else NO('driveEnabled ≠ true → 【主因】pilot.js #tick 总闸直接 return，方向盘零发包');
    }

    // ── B2. 配置链指纹：storage → toModuleCfg → configure → 引擎 ───────
    H('B2. 配置链指纹（旧代码 vs 配置没推下来，一眼分开）');
    const spec = safe(
      () =>
        ((PC.reactor && PC.reactor.list ? PC.reactor.list() : []) || []).find(
          (s) => s && s.id === 'secretRealm',
        ) || null,
      null,
    );
    let oldConfigure = null;
    if (!spec) {
      NO('reactor.list() 里没有 secretRealm 说明书 → 注册失败（扩展没装/构建过旧）');
    } else {
      const src = String(spec.configure || '');
      // 旧版 configure 体内会调 buildModuleCfg（二次归一化）；新版直接 `modCfg = c`
      oldConfigure = src.indexOf('buildModuleCfg') >= 0;
      KV('configure 源码（截断）', src.replace(/\s+/g, ' ').slice(0, 200) + ' …');
      if (oldConfigure) {
        NO(
          'configure 仍在调用 buildModuleCfg → 【页面里跑的还是旧代码】重载扩展只换了 worker/默认值，页面里的 content.js 必须按 F5 刷新才会换',
        );
      } else {
        OK('configure 已改为整体接收（二次归一化已修掉）');
      }
      let mod = null;
      if (cfg) mod = safe(() => spec.toModuleCfg(cfg), null);
      KV('toModuleCfg(storage) 的 drive', mod ? JSON.stringify(mod.drive) : '(未算)');
      KV('debugState().cfgDrive', ds ? JSON.stringify(ds.cfgDrive) : '(无实例)');
      if (mod && mod.drive && mod.drive.enabled === true && !(ds && ds.cfgDrive && ds.cfgDrive.enabled === true)) {
        NO('面板算出 true 而引擎读到 false → 只可能是 configure 没生效（旧代码 / 从未被推过）');
      }
      // 主动重推一次（与面板「保存」完全等价：零网络包、零游戏动作）：判定 + 自救
      const pushed = safe(() => {
        PC.reactor.setConfig(
          'secretRealm',
          Object.assign({ enabled: !!(cfg && cfg.enabled) }, spec.toModuleCfg(cfg || {})),
        );
        return true;
      }, false);
      KV('主动重推配置', pushed ? '已推一次（等价于面板再保存一次）' : '推送抛错');
      // setConfig→recompute 不会重启 run（running 不变），但仍重取一次实例，防止被替换
      const dsPushed =
        PC.secretRealmDrive && typeof PC.secretRealmDrive.debugState === 'function'
          ? safe(() => PC.secretRealmDrive.debugState(), null)
          : null;
      KV('重推后 cfgDrive', dsPushed ? JSON.stringify(dsPushed.cfgDrive) : '(无实例)');
      if (dsPushed && dsPushed.cfgDrive && dsPushed.cfgDrive.enabled === true) {
        OK('重推后引擎读到 enabled=true → 配置链路已通（说明之前只是从没被推过）');
      } else if (dsPushed) {
        NO('重推后引擎仍读到 enabled=false → 代码里还有第三处问题（把本段整段贴回）');
      }
    }

    // ── C. 现场 ACL（开着也还要过这些闸）────────────────────────────────
    H('C. 现场 ACL（drive 每拍要过的那几道闸）');
    const base = readBase();
    if (!base || !base.startPoint) {
      NO('roomBaseInfo 缺失/无 startPoint → 引擎在 #tick 第 401 行早退（房间现场态还没下发）');
    } else {
      const sp = base.startPoint;
      const mp = base.targetPoint || {};
      const el = toNum(base.fightBeginTime);
      KV('teamId', JSON.stringify(base.teamId));
      KV('leaderUid', base.leaderUid);
      KV('startPoint / pointType', '(' + sp.x + ',' + sp.y + ') ' + ptName(Number(base.pointType) || 0));
      KV('targetPoint', '(' + mp.x + ',' + mp.y + ')');
      KV('marchState', marchStateName(base.marchState));
      if (el > 1e11) {
        const elapsed = (now() - el) / 1000;
        KV(
          'fightBegin→now',
          Math.round(elapsed) + 's（' + (elapsed / 60).toFixed(1) + 'min；大BOSS≈40min、商店勤务 10/15/20min）',
        );
      }
      const st = Number(base.marchState);
      const arrived = (() => {
        const S = safe(() => SR.getNMarchState(), null) || {};
        return S.ARRIVED != null ? Number(S.ARRIVED) : 2;
      })();
      const moored = readMoored();
      const leader = readLeader();
      const sending = readSending();
      const cap = readCapture();
      const capBusy = !!(cap && cap.x > 0 && cap.boss !== 1);
      if (leader === true) OK('isTeamLeader() = true（8521 只有队长能发）');
      else NO('isTeamLeader() = ' + leader + ' → 非队长，方向盘永远不动（这是游戏规则）');
      if (st === arrived && moored === true) OK('停泊成立（marchState=ARRIVED 且 teamIsMooring=true）');
      else NO('停泊不成立（marchState=' + st + ' / teamIsMooring=' + moored + '）→ 行军途中或场景未稳');
      if (capBusy) NO('正在拍普通异能兽 capturingPetPos=(' + cap.x + ',' + cap.y + ') → 挪点会清捕获进度，引擎主动让位');
      else OK('未在拍宠（capturingPetPos 不拦）');
      if (sending === true) {
        NO('isSecretSending(8521) = true → 在途闸按着（若已停泊很久，很可能是 NetMgrSimple 幽灵条目，引擎 90s 会自愈发一笔探测包）');
      } else OK('isSecretSending(8521) = false（通道没有未应答的 8521）');
      const boss = safe(() => SR.getBossBaseInfo(), null);
      if (Array.isArray(boss)) {
        const brief = boss.map((b) => {
          const end = toNum(b && b.stateEndTime);
          const left = end > 1e11 ? Math.round((end - now()) / 1000) : null;
          return 'boss' + (b && b.bossId) + ' state=' + (b && b.state) + (left == null ? '' : ' 距翻转' + left + 's');
        });
        KV('BOSS 状态机', brief.join(' | '));
      } else KV('BOSS 状态机', '(未下发)');
    }

    // ── C2. 档位阶梯：高阶档「有需求但没坐标」会把方向盘钉住 ──────────
    H('C2. 档位阶梯（④BOSS平台 / ⑤商店勤务 / ⑥商店补货 / ⑦巡航）');
    const bossList = safe(() => SR.getBossBaseInfo(), null);
    const list = Array.isArray(bossList) ? bossList : [];
    const liveBoss = list.filter((s) => Number(s && s.state) === 21);
    const lefts = list
      .map((s) => (toNum(s && s.stateEndTime) > 1e11 ? (toNum(s.stateEndTime) - now()) / 1000 : null))
      .filter((v) => v != null && v > 0);
    const leadMin = lefts.length ? Math.min.apply(null, lefts) : null;
    const bossWindow = liveBoss.length > 0;
    const bossLead = !bossWindow && leadMin != null && leadMin * 1000 <= 60000;
    KV(
      '④ BOSS 平台档',
      bossWindow
        ? '窗已开（有 state=21）'
        : bossLead
          ? '预置档触发（距翻转 ' + Math.round(leadMin) + 's ≤ 60s）'
          : '未触发（最近翻转 ' + (leadMin == null ? '?' : Math.round(leadMin)) + 's 之后）',
    );
    const fbMs = base && toNum(base.fightBeginTime);
    const elSec = fbMs > 1e11 ? (now() - fbMs) / 1000 : null;
    const shopDue = elSec != null && elSec >= 600 && !(cfg && cfg.driveShopTime === false);
    KV(
      '⑤ 商店勤务档',
      elSec == null
        ? '（无 fightBegin 锚，不触发）'
        : shopDue
          ? '已到期（elapsed ' + Math.round(elSec) + 's ≥ 600）且 driveShopTime≠false → 优先于巡航'
          : '未到期（elapsed ' + Math.round(elSec) + 's < 600）',
    );
    const gaps = [];
    const pickItems = (cfg && cfg.pickItems) || {};
    Object.keys(pickItems).forEach((k) => {
      const row = pickItems[k];
      if (!/^item:\d+$/.test(k) || !row || Number(row.shop) !== 1) return;
      const id = Number(k.slice(5));
      let cap = Number(row.max) || 0;
      if (cap <= 0) {
        const def = safe(() => PC.gameApi.l10n.tableRow('ITEM', id), null);
        cap = Number(def && def.para1_v1) || 0;
      }
      if (!(cap > 0)) return;
      const have = Number(safe(() => SR.getItemNumById(id), 0)) || 0;
      if (have < cap) gaps.push('item' + id + ' ' + have + '/' + cap);
    });
    KV('⑥ 商店补货档', gaps.length ? '有缺口：' + gaps.join('，') + ' → 优先于巡航' : '无缺口');

    // ── D. 观测窗：收 10018 点位 + 抓本端 8521 ──────────────────────────
    H('D. ' + sec + 's 观测窗（请拖动镜头扫一圈，10018 只在进视口时推）');
    const tiles = new Map();
    const sends = [];
    const unsubTile = PC.bus.on('net.10018', function (ev) {
      const list = ev && ev.data && ev.data.pointInfos;
      if (!Array.isArray(list)) return;
      list.forEach((p) => {
        if (!p) return;
        const k = Math.floor(Number(p.x)) + ',' + Math.floor(Number(p.y));
        const m = p.m && typeof p.m === 'object' ? p.m : {};
        tiles.set(k, {
          pt: Number(p.pointType) || 0,
          x: Math.floor(Number(p.x)),
          y: Math.floor(Number(p.y)),
          state: Number(m.state) || 0,
          iNum: m.iNum == null ? null : Number(m.iNum) || 0,
          rTime: toNum(m.rTime),
          teams: Array.isArray(m.teams) ? m.teams.length : 0,
          esrId: m.esrId == null ? null : Number(m.esrId),
        });
      });
    });
    const unsubReq = PC.net && PC.net.onReq
      ? PC.net.onReq(8521, function (e) {
          const d = (e && e.data) || {};
          sends.push({ t: now(), x: d.x, y: d.y });
          console.log('%c    → 本端发出 8521 目标 (' + d.x + ',' + d.y + ')', 'color:#0066CC');
        })
      : function () {};
    const t0 = now();
    await new Promise((r) => {
      const timer = setInterval(() => {
        const b = readBase();
        const left = sec - Math.round((now() - t0) / 1000);
        if (b) {
          console.log(
            '    [' + Math.round((now() - t0) / 1000) + 's] marchState=' +
              marchStateName(b.marchState) +
              ' start=(' + (b.startPoint && b.startPoint.x) + ',' + (b.startPoint && b.startPoint.y) + ')' +
              ' moored=' + readMoored() +
              ' sending8521=' + readSending() +
              ' 点位证据=' + tiles.size,
          );
        }
        if (left <= 0) {
          clearInterval(timer);
          r();
        }
      }, 3000);
    });
    unsubTile();
    if (typeof unsubReq === 'function') unsubReq();

    const b2 = readBase();
    const cur = b2 && b2.startPoint ? { x: Math.floor(Number(b2.startPoint.x)), y: Math.floor(Number(b2.startPoint.y)) } : null;
    const curKey = cur ? cur.x + ',' + cur.y : '';
    const rows = Array.from(tiles.entries())
      .filter(([k]) => k !== curKey)
      .map(([k, t]) => ({ k, t, d: cur ? dist(t.x, t.y, cur.x, cur.y) : Infinity }))
      .sort((a, b) => a.d - b.d);
    rows.forEach(({ t, d }) => {
      // 与 drive #isTileEmpty 的「当前态路」同式：173 rTime 在未来=已抽空；163 iNum<=0=无可拾（缺列不算空）
      const empty =
        t.pt === 173
          ? t.rTime > now()
          : t.pt === 163
            ? t.iNum != null && t.iNum <= 0
            : null;
      console.log(
        '    ' + ptName(t.pt) + ' (' + t.x + ',' + t.y + ') 距' + (Number.isFinite(d) ? d.toFixed(1) : '?') +
          ' state=' + t.state + ' iNum=' + t.iNum + ' teams=' + t.teams +
          (empty == null ? '' : ' 判空=' + empty),
      );
    });
    if (!rows.length) {
      NO('观测窗内没收到任何点位（10018 未推）→ 把镜头拖到有资源点的地方再跑一次');
    }
    const shopTiles = Array.from(tiles.values()).filter((t) => t.pt === 161);
    KV(
      '观测窗内 161 店点',
      shopTiles.length ? shopTiles.map((t) => '(' + t.x + ',' + t.y + ')').join(' ') : '0 条',
    );
    if ((shopDue || gaps.length) && !shopTiles.length) {
      NO('商店有需求但快照内 0 条 161 坐标 → 旧构建会卡在 ⑤/⑥ 永不巡航（已修：无坐标时下沉巡航）');
    }
    // 与 drive #nearestCruise 同款评分（成本项缺 BOSS/商店锚时不计）
    const cands = rows.filter(
      ({ t }) =>
        (t.pt === 173 || t.pt === 163) &&
        t.state !== 11 &&
        t.state !== 12 &&
        !(t.pt === 173 ? t.rTime > now() : t.iNum != null && t.iNum <= 0),
    );
    const scored = cands
      .map(({ t }) => ({ t, score: (t.iNum == null ? 0 : t.iNum) - (cur ? dist(t.x, t.y, cur.x, cur.y) / 2 : 0) }))
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      const best = scored[0].t;
      OK('按引擎巡航评分，方向盘本该去 ' + ptName(best.pt) + ' (' + best.x + ',' + best.y + ')，score=' + scored[0].score.toFixed(2));
    } else {
      NO('观测窗内没有「可巡航」候选（173 未抽空 / 163 有货 / 非 PVP）→ 引擎会驻留重扫，这不算故障');
    }
    if (sends.length) {
      OK('观测窗内本端发出 ' + sends.length + ' 笔 8521：' + sends.map((s) => '(' + s.x + ',' + s.y + ')').join(' '));
    } else if (ds && ds.lastBranch === 'explore') {
      OK('本拍处于探索档（无候选超 30s 主动开一段）→ 8521 应在紧随的下一拍发出');
    } else {
      NO('观测窗内本端 0 笔 8521（人工没点、引擎也没发）');
    }
    // 引擎周期活性：12s 内 ticks 必须增长（电平兜底 driveScanMs=5s）
    const ds2 = dumpEngine();
    if (ds2 && ticksBefore != null) {
      KV('观测窗 ticks 增量', ds2.ticks - ticksBefore + ' 次（12s 内应 ≥1；0 = cycle 没跑）');
      KV('观测窗末 lastBranch / lastDispatch', (ds2.lastBranch || '(空)') + ' / ' + (ds2.lastDispatch || '(无)'));
      KV('观测窗末 tiles.size / byPt', ds2.tiles.size + ' / ' + JSON.stringify(ds2.tiles.byPt));
    }

    // ── E. 结论 ─────────────────────────────────────────────────────────
    H('E. 结论');
    const cfgDriveOn = !!(cfg && cfg.driveEnabled === true);
    const b3 = readBase();
    const arrivedNum = (() => {
      const S = safe(() => SR.getNMarchState(), null) || {};
      return S.ARRIVED != null ? Number(S.ARRIVED) : 2;
    })();
    const moored3 = readMoored();
    const leader3 = readLeader();
    const sending3 = readSending();
    const cap3 = readCapture();
    const capBusy3 = !!(cap3 && cap3.x > 0 && cap3.boss !== 1);
    const verdict = [];
    if (oldConfigure === true)
      verdict.push(
        '①-0 【页面跑的是旧代码】reactor 里 secretRealm.configure 仍在二次归一化（buildModuleCfg）→ 重载扩展后必须按 F5 刷新游戏页面；旧 content.js 不会自己换，刷新前怎么改都不生效',
      );
    else if (!ENG) verdict.push('①-A 引擎实例不存在 → run() 抛错 / feat 未激活 / dist 未重载（先看 SECRETM 的 "drive engine started" 有没有）');
    else if (ds && ds.ticks === 0) verdict.push('①-B 引擎在但 #tick 一次未执行 → cycle 未 kick 或 alive 恒假');
    else if (ds && ds.lastTickAgoMs != null && ds.lastTickAgoMs > 15000)
      verdict.push(
        '①-C cycle 停滞：上次 #tick 在 ' +
          ds.lastTickAgoMs +
          'ms 前（相位=' +
          (ds.lastBranch || '?') +
          '/toKind=' +
          ((ds.phase && ds.phase.toKind) || '空') +
          '）→ 旧构建在 TO 相位按剩余超时睡满 90s，而拒绝应答只清相位不唤醒 → 现在改为 ≤10s 短轮询 + 应答主动 kick',
      );
    else if (ds && ds.phase && ds.phase.realmClosed === true)
      verdict.push(
        '①-X 【本场已结束，不是故障】服务端回过 enigma_realm17「战场即将封闭，请指挥官尽快选择带出秘境战场的物资」→ 封闭期一切 8521 都被拒，引擎已停手（lastBranch=realm-closed）；等下一场 fightBeginTime 变化会自动解开',
      );
    else if (ds && ds.tiles.size === 0)
      verdict.push('①-D 【内部快照为空】10018 没进引擎（订阅失效/引擎刚 start）→ 任何档位都无候选，先把镜头拖一圈再跑一次');
    else if (ds && /^shop\|same/.test(ds.lastDispatch || ''))
      verdict.push(
        '①-S 目标就是当前所在点（同点短路生效：不发 8521，直接进驻留）→ 属防打转的正常形态，不是故障；驻留结束后 10 分钟内不会再因缺口回店',
      );
    else if (ds && ds.lastBranch === 'work')
      verdict.push(
        '①-W 正在驻留相位（work：pt=' +
          (ds.phase && ds.phase.workMode) +
          '，剩 ' +
          Math.round(((ds.phase && ds.phase.workLeftMs) || 0) / 1000) +
          's）→ 到点干活中，不是卡点；驻留结束会重新评路',
      );
    else if (ds && ds.lastBranch === 'to')
      verdict.push(
        '①-T 正在 TO 相位（8521 行军途中，剩 ' +
          Math.round(((ds.phase && ds.phase.toAgoMs) || 0) / 1000) +
          's 前发的车）→ 正常，不是卡点；旧构建这里会睡满 90s，现已改短轮询',
      );
    else if (ds && ds.lastBranch && ds.lastBranch !== 'cruise' && ds.lastBranch !== 'explore')
      verdict.push('①-E 本拍停在档位 ' + ds.lastBranch + '（dispatch=' + (ds.lastDispatch || '无') + '）→ 这就是卡点');
    else if (ds && ds.lastBranch === 'explore')
      verdict.push('①-E2 正在探索换视野（无候选已超 30s，主动开一段开图）→ 属正常兜底，不是故障；等它到达后再跑一次看 lastBranch 是否回到 cruise');
    else if (ds && /^cruise\|none/.test(ds.lastDispatch || '') && ds.idleSec >= 30)
      verdict.push(
        '①-G 无候选已 ' + ds.idleSec + 's（≥30s）但探索档没发车 → 要么构建未含 ⑦-b，要么 8 个方向 12 格内落点全被已知点/边界挡满（把 A2 的 tiles 明细贴回）',
      );
    else if (ds && /^cruise\|none/.test(ds.lastDispatch || ''))
      verdict.push(
        '①-F 走到⑦巡航但内部无可用 173/163（看 A2 的 tiles 明细：rTime 未来=被抽空、iNum=0=无货）→ 静默满 30s 会自动走探索档',
      );
    if (isPab !== true) verdict.push('① 不在秘境战斗图 → secretRealm 被场景门控 pause（先解决进图/世界态识别）');
    else if (!running) verdict.push('② 秘境里但 feat 未激活 → 面板「异能秘境」总开关/门控未放行');
    else if (!cfgDriveOn) verdict.push('③ 【主因】配置 driveEnabled≠true → 面板：活动 → 异能秘境 → 展开 → 「自动驾驶」勾选「自动驾驶（自动开往资源点/BOSS/商店）」');
    else if (leader3 !== true) verdict.push('④ 非队长（仅队长可发 8521）→ 换成队长带队再试');
    else if (sending3 === true) verdict.push('⑤ 8521 在途闸按着（若已停泊 >90s，多为幽灵条目；引擎会在 90s 后自愈发一笔探测包）');
    else if (capBusy3) verdict.push('⑥ 正在拍普通异能兽 → 挪点会清捕获进度，引擎主动让位（拍完自动恢复）');
    else if (!b3 || !b3.startPoint || Number(b3.marchState) !== arrivedNum || moored3 !== true)
      verdict.push('⑦ 停泊不成立（行军途中/现场态未稳）→ 等停稳后再看');
    else if (shopDue || gaps.length)
      verdict.push(
        '⑧ 商店待办（⑤' +
          (shopDue ? '勤务已到期' : '未到期') +
          ' / ⑥' +
          (gaps.length ? '补货有缺口' : '无缺口') +
          '）优先于巡航，而快照内 161 店点 ' +
          (shopTiles.length ? '有 ' + shopTiles.length + ' 条' : '0 条') +
          ' → 旧构建在「有需求、无坐标」时永久钉死（已修：无坐标下沉巡航）；刚重载扩展仍不动就继续看 ⑨' +
          (ds && ds.phase && ds.phase.shopRestockCoolLeftMs > 0
            ? '；当前商店冷却剩 ' + Math.round(ds.phase.shopRestockCoolLeftMs / 1000) + 's，期间不会再派车回店（防打转生效）'
            : ''),
      );
    else if (!scored.length) verdict.push('⑨ 闸全开但快照里没有可巡航候选 → 拖镜头让 10018 补点，或本来就没货（属正常驻留）');
    else if (!sends.length) verdict.push('⑩ 闸全开、候选也在，但观测窗内没发 8521 → 看 SECRETM 日志是否有 "drive engine started" 与 "drive: 闸[xxx]拦住"（把那段连同本页输出一起贴回）');
    else verdict.push('⑪ 本轮观测窗内确实发了 8521（引擎在工作）→ 若你看到的「没自动驾驶」发生在别的时段，请在那段时间重跑本探针');
    verdict.forEach((v) => console.log('%c  ' + v, 'color:#c0392b;font-weight:bold'));
    console.log(
      '%c\n  下一步：把 A~E 全部输出贴回；若 ③ 命中就去面板勾选自动驾驶，若 ⑧ 命中则属旧构建的「商店待办钉死巡航」（已修，重载扩展即可）。',
      'color:#4a90d9',
    );

    const result = {
      at: new Date().toISOString(),
      oldConfigure,
      isPab,
      running,
      cfgDriveOn,
      cfg,
      base: b3,
      leader: leader3,
      moored: moored3,
      sending8521: sending3,
      capturePos: cap3,
      engine: ds,
      shopDue,
      shopGaps: gaps,
      shopTiles: shopTiles.length,
      tiles: Array.from(tiles.values()),
      sends,
      verdict,
    };
    window.__pcDriveProbeLast = result;
    window.__pcDriveProbeResult = result; // 兼容旧名
    return result;
  };

  console.log(
    '%c[drive-probe] 已就位：输入 __pcDriveProbe() 跑默认 12s；__pcDriveProbe(20) 跑 20s。观测期间请拖动镜头扫图。',
    'color:#4a90d9;font-weight:bold',
  );
  return window.__pcDriveProbe();
})();
