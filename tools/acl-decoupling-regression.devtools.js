/**
 * ACL 解耦试点回归探针（DevTools 一次性粘贴运行，纯只读、零发包）
 *
 * 背景：core/game-api.js 拆分试点——引擎核迁至 core/acl-engine.js（SYM/probe/CAPS/createAcl），
 *   secretRealm、csHunt 两个活动适配器下沉到 feats/activity/*/api.js，共享对象经
 *   registerSharedValue/sharedValue 插槽桥接，core→feats 薄壳已收回。本探针把拆分涉及的
 *   每一条接缝在真机逐项验活，替代“凭肉眼读代码猜运行期行为”。
 *
 * 覆盖计划第八节回归项：
 *   A. 调试面插槽：debug.secretRealm / debug.csHunt getter 经 sharedValue 现取可通（薄壳收回后旧口径）；
 *   B. registerCaps 回挂：CAPS 含四枚活动键且 checkCap 自检可跑（feat 安装期同一入口）；
 *   C. worldSlot 桥：worldSignals.pabBattleMap() 不抛（Blocker 修复点）、与 secretRealm.isPabBattleMap 同真相；
 *   D. sharedValue 运行期：csHunt.readState / secretRealm.petPackCapacity 经插槽取 bits/gameConf 不抛错；
 *   E. setSharedCapsProbe 桥：CAPS.navFly 经插槽取共享区段 mapTodo 可求值；
 *   F. 环境相关段：在秘境图/夺宝面板可达时追加深度校验（否则明确 SKIP，不算失败）。
 *      注：sendSecret 4s 超时/次通道告警闸门属发包链路，本探针零发包不主动触发，
 *      只验预检依赖链（watchNet 能力 + isConnectStatus 可调）；完整验证需图内让 pilot 自然跑一段看控制台告警。
 *
 * 运行前提：已加载 pocketcc 扩展、已登录进游戏，MAIN world 控制台
 *   （F12 → Console → top 框架，window.pocketcc 可见）。F 段要求：
 *   · F1 需已进入异能秘境地图；F2 需夺宝奇兵活动开启期。不满足会 SKIP 并提示。
 *
 * 只读承诺：不发送任何 PB/85xx 包，不写游戏数据；唯一副作用是把结果挂到
 *   window.__pcAclRegressionLast 便于回看。
 *
 * 用法：整段粘贴即运行（自执行，同 self-power-probe 惯例）；换场景后重新粘贴即可复跑。
 * 贴回：把 "=====" 分段的全部输出（含结论段）一起贴回。
 */
(function aclDecouplingRegression() {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi) {
    console.error(
      '[acl-regression] window.pocketcc 未就绪：确认已加载 pocketcc 扩展、已登录，并在游戏页 DevTools 的 Console（MAIN world，top 框架）里执行。',
    );
    return;
  }
  const API = PC.gameApi; // core/game-api.js 的 debug 面（含 CAPS / checkCap / 活动 getter）
  const WS = PC.worldSignals;
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const OK = (s) => console.log('%c  ✔ ' + s, 'color:#1a7f37');
  const NO = (s) => console.log('%c  ✘ ' + s, 'color:#c0392b;font-weight:bold');
  const SKIP = (s) => console.log('%c  ○ SKIP ' + s, 'color:#8a6d3b');
  const KV = (k, v) => console.log('    ' + k + ' =', v);
  const results = []; // [pass, fail, skip]
  const stat = { pass: 0, fail: 0, skip: 0 };
  const expect = (name, fn) => {
    try {
      const v = fn();
      if (v === true || v === undefined) {
        OK(name);
        stat.pass++;
      } else {
        NO(name + '（返回 ' + JSON.stringify(v) + '）');
        stat.fail++;
        results.push('FAIL ' + name);
      }
    } catch (e) {
      NO(name + '（抛 ' + ((e && e.message) || e) + '）');
      stat.fail++;
      results.push('FAIL ' + name + ': ' + ((e && e.message) || e));
    }
  };
  const safe = (fn, fb) => {
    try {
      return fn();
    } catch (e) {
      return '(抛:' + ((e && e.message) || e) + ')';
    }
  };

  // ── A. 调试面插槽（薄壳收回后，debug.secretRealm/csHunt 应经 sharedValue 现取） ──
  H('A. 调试面插槽 debug.secretRealm / debug.csHunt');
  const debugKeys = API.debug ? Object.keys(API.debug) : [];
  KV('debug 面键数', debugKeys.length);
  expect('debug.secretRealm getter 可取（非 undefined 即插槽通；feat 未加载才 null）', () => {
    const sr = API.debug && API.debug.secretRealm;
    KV('debug.secretRealm', sr === null ? 'null（secret-realm api.js 未求值？不应发生）' : typeof sr);
    return sr != null ? true : 'null';
  });
  expect('debug.csHunt getter 可取', () => {
    const ch = API.debug && API.debug.csHunt;
    KV('debug.csHunt', ch === null ? 'null（cs-hunt api.js 未求值？不应发生）' : typeof ch);
    return ch != null ? true : 'null';
  });
  const SR = API.debug && API.debug.secretRealm;
  const CH = API.debug && API.debug.csHunt;
  expect('secretRealm 形状与拆分前一致（关键方法在位）', () => {
    const need = ['isPabBattleMap', 'sendSecret', 'petPackCapacity'];
    const missing = need.filter((m) => !SR || typeof SR[m] !== 'function');
    KV('missing', missing);
    return missing.length === 0;
  });
  expect('csHunt 形状与拆分前一致（关键方法在位）', () => {
    const need = ['present', 'openFlag', 'canHunt', 'readState', 'readTeam', 'readRewardPool'];
    const missing = need.filter((m) => !CH || typeof CH[m] !== 'function');
    KV('missing', missing);
    return missing.length === 0;
  });

  // ── B. registerCaps 回挂：CAPS 应含四枚活动键，checkCap 与 reactor 安装期同入口 ──
  H('B. registerCaps 回挂（CAPS 活动键 + checkCap）');
  const ACT_KEYS = ['pabController', 'watchNet', 'mapNewBiz', 'csHuntController'];
  expect('CAPS 含四枚活动键（各 feat api.js 模块求值期自注册到位）', () => {
    const caps = API.debug && API.debug.CAPS;
    const missing = ACT_KEYS.filter((k) => !caps || typeof caps[k] !== 'function');
    KV('missing', missing);
    KV('CAPS 键总数', caps ? Object.keys(caps).length : 'CAPS 不可见');
    return missing.length === 0;
  });
  for (const k of ACT_KEYS) {
    expect('checkCap("' + k + '") 可求值且不抛（真机符号在场与否都算通过，只验桥）', () => {
      const v = safe(() => API.checkCap(k));
      KV(k, v);
      return typeof v === 'boolean';
    });
  }

  // ── C. worldSlot 桥（Blocker 修复点：pabBattleMap 不得二次求值抛 TypeError） ──
  H('C. worldSlot 桥 worldSignals.pabBattleMap()');
  expect('worldSignals.pabBattleMap() 调用不抛', () => {
    const v = safe(() => WS.pabBattleMap());
    KV('pabBattleMap()', v);
    return typeof v === 'boolean' ? true : v;
  });
  expect('与 secretRealm.isPabBattleMap() 同一真相（共用判据不分两套口径）', () => {
    if (!SR) return 'secretRealm 不可用，无法对比';
    const a = safe(() => WS.pabBattleMap(), '抛');
    const b = safe(() => SR.isPabBattleMap(), '抛');
    KV('worldSignals vs secretRealm', a + ' vs ' + b);
    return a === b ? true : '口径不一致: ' + a + ' vs ' + b;
  });

  // ── D. sharedValue 运行期：活动适配器经插槽取 bits/gameData/gameConf/l10n ──
  H('D. sharedValue 运行期桥（bits/gameData/gameConf/l10n）');
  expect('csHunt.readState() 不抛（内部经 sharedValue("bits")；不在活动期回 null 属正常降级）', () => {
    const v = safe(() => CH && CH.readState());
    KV('readState()', v === null ? 'null（降级口径正常）' : typeof v === 'object' ? 'object' : v);
    return !(typeof v === 'string' && String(v).indexOf('抛') === 0);
  });
  expect('secretRealm.petPackCapacity() 不抛（内部经 sharedValue("gameConf")）', () => {
    const v = safe(() => SR && SR.petPackCapacity());
    KV('petPackCapacity()', v);
    return !(typeof v === 'string' && String(v).indexOf('抛') === 0);
  });
  expect('worldSignals.serverStateName() 可用（game-api 共享区段未受拆分影响）', () => {
    const v = safe(() => WS.serverStateName());
    KV('serverStateName()', v);
    return typeof v === 'string';
  });

  // ── E. setSharedCapsProbe 桥：CAPS.navFly 经插槽取共享区段 mapTodo ──
  H('E. setSharedCapsProbe 桥（CAPS.navFly → mapTodo）');
  expect('checkCap("navFly") 可求值且不抛', () => {
    const v = safe(() => API.checkCap('navFly'));
    KV('navFly', v);
    return typeof v === 'boolean';
  });

  // ── F. 环境相关深度校验（不满足场景 SKIP，不计失败） ──
  H('F. 环境相关段（秘境图 / 夺宝活动期）');
  const inPab = safe(() => WS.pabBattleMap()) === true;
  if (inPab) {
    expect('F1 秘境图内：worldSignals kind 归一应为 pab（feat 激活前提）', () => {
      const kind = safe(() => (PC.reactor && WS.kind ? WS.kind() : WS.mapTypeName ? WS.mapTypeName() : ''));
      KV('kind/mapTypeName', kind);
      return kind === 'pab' || String(kind).toUpperCase().indexOf('PAB') >= 0 ? true : 'kind=' + kind;
    });
    expect('F1 秘境图内：secretRealm 适配器在图判据实时为真（worldSlot 时序 OK）', () => {
      return safe(() => SR.isPabBattleMap()) === true;
    });
    // 次通道只读观测：不碰 sendSecret（那是发包链路，探针守零发包红线）；
    // 超时/告警闸门需在秘境图内让 pilot 自然跑一段，看控制台是否出现
    // 「secondary socket not ready (connect/login), skip secret cmd」首告警与其后的 debug 降级。
    expect('F1 秘境图内：次通道门面在场且 isConnectStatus 可调用（sendSecret 预检依赖链只读验证）', () => {
      const capOk = safe(() => API.checkCap('watchNet'));
      const mgr = safe(() => {
        const g = window.game || PC.game;
        const m = g && g.get && g.get('TMWatchNetMgr');
        const C = m && (m.TMWatchNetMgr || (m.default || m));
        const inst = C && (C.Instance || (typeof C.getInstance === 'function' ? C.getInstance() : null));
        return inst;
      });
      KV('CAPS.watchNet', capOk);
      KV('isConnectStatus', mgr && typeof mgr.isConnectStatus === 'function' ? safe(() => mgr.isConnectStatus()) : '不可达（实例由 subpack 接管属正常）');
      return capOk === true ? true : 'watchNet 能力自检未过：' + capOk;
    });
  } else {
    SKIP('F1 秘境段跳过——当前不在异能秘境地图。请进入秘境后重跑本探针验证 kind 归一、worldSlot 时序与次通道预检链；sendSecret 4s 超时/告警闸门请在图内让 pilot 自然跑一段后看控制台（本探针零发包不主动触发）。');
  }
  const huntOpen = safe(() => CH && CH.present()) === true && safe(() => CH && CH.openFlag()) === true;
  if (huntOpen) {
    expect('F2 夺宝开启期：readRewardPool() 返回数组（内部经 sharedValue("l10n"/"gameData")）', () => {
      const v = safe(() => CH.readRewardPool());
      KV('rewardPool', Array.isArray(v) ? v.length + ' 项' : v);
      return Array.isArray(v);
    });
  } else {
    SKIP('F2 夺宝段跳过——夺宝奇兵不在开启期（present/openFlag 未过）。开启后重跑即可。');
  }

  // ── 结论 ──
  H('结论');
  KV('pass/fail/skip', stat.pass + ' / ' + stat.fail + ' / ' + stat.skip);
  if (results.length) console.log(results.map((s) => '  · ' + s).join('\n'));
  OK(stat.fail === 0 ? 'A–E 桥接层回归全绿（F 段 SKIP 不算失败，补齐场景后重跑）' : '存在 ' + stat.fail + ' 项失败，整段输出贴回排查');
  window.__pcAclRegressionLast = { stat, results, ts: Date.now() };
})();
