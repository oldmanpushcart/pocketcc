/**
 * 一键领取（oneClickClaim / 日志 tag=ONE-CLICK）停摆诊断探针（DevTools 一次性粘贴运行）
 *
 * 背景：feat 不再领取。它的动作被一串**串联闸门**决定，任一道关掉都会表现为「静默不动、日志也不报错」：
 *   P1 装配层：spec 未注册（构建没打进 / register 被拒）→ 面板都没有这一项；
 *   P2 启用层：面板 enabled=false（含组闸门 playerBasics 级联关、换 UID 后命名空间里没有这份配置）；
 *   P3 安装层：install 失败（pocketcc.net 不可用 / 硬依赖符号漂移 missingSymbols）→ 永不 activate；
 *   P4 门控层：world 门控（places:['base','world'] + kinds:['homeland'] + 秘境 pab 隔离）当前不放行 → pause；
 *   P5 开启闸：gameData.taskRelaxOpenRows() 返回空（复刻游戏 TaskRelaxTool 三级闸：账号总闸 / 服务器灰度 /
 *      逐行解锁）→ feat 走 IDLE 巡检挂起，只打一条 info 后彻底静默；
 *   P6 择时层：领过一次就睡到下一个服务器 0 点（日锚，最长 24h）或睡到 limitTimeSec 冷却 —— 行为正确只是安静；
 *   P7 网络层：5684/5685 的 isSending 卡在 true（在途未清）→ 每 20s 瞬态重试的死循环，且只打 debug。
 *
 * 本探针把 P1..P7 逐段复算一遍（全只读；唯一发包是可选的 5684 INFO 查询，纯读、无副作用，可用开关关掉）。
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，控制台上下文为 MAIN world（window.pocketcc 可见）。
 * 末尾「结论速判」把各段原文贴回即可定位。
 */

/** @type {boolean} 是否主动发一次 5684 只读查询（拿服务器权威 limitTimeSec）。false=完全零发包。 */
const ACTIVE_INFO_PROBE = true;

(async function oneClickClaimProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.reactor) {
    console.error(
      '[one-click-probe] window.pocketcc 未就绪（缺 gameApi/reactor）：确认已加载扩展、已登录、MAIN world 上下文。',
    );
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const ID = 'oneClickClaim';
  const CMD_INFO = 5684;
  const CMD_REWARD = 5685;
  const CFG_RANGE = 79089; // 一键领取放量 serverTransferRange 白名单
  const CFG_ADVENTURE = 79092; // 远征行动解锁的最后通关任务线门槛
  const { gameApi, reactor, game } = PC;
  const { gameData, gameConf, l10n, SYM, ns } = gameApi;
  const WS = PC.worldState;

  // ── P1. 装配：spec 是否注册 ─────────────────────────────────────
  H('P1. 装配层（spec 注册）');
  const spec = reactor.list().find((s) => s.id === ID);
  if (!spec) {
    console.error(
      '!! reactor 里没有 %s —— 该 feat 的代码没进构建（content.entry.js 的 import 缺失 / 构建未刷新）。后续各段无意义。',
      ID,
    );
    return;
  }
  console.log('spec 已注册:', {
    label: spec.label,
    storageKey: spec.storageKey,
    places: spec.places,
    kinds: spec.kinds,
    offInCombat: spec.offInCombat,
    symbols: spec.symbols,
    defaults: spec.defaults,
    fieldsLen: (spec.fields || []).length,
  });
  console.log(
    'toModuleCfg() =',
    (() => {
      try {
        return spec.toModuleCfg({});
      } catch (e) {
        return 'threw: ' + e.message;
      }
    })(),
  );

  // ── P2. 启用：存储里的持久化 enabled（UID 命名空间内） ──────────
  H('P2. 启用层（面板/存储 enabled）');
  console.log('isRunning(%s) =', ID, reactor.isRunning(ID));
  const cfgBlob = await PC.storage.getAllConfig().catch((e) => {
    console.warn('读配置 blob 失败（多半是 UID 命名空间未设）：', e && e.message);
    return null;
  });
  if (cfgBlob) {
    console.log('本 feat 持久化配置 =', cfgBlob[spec.storageKey]);
    console.log('组闸门 playerBasics 持久化 =', cfgBlob['pocketcc.group.playerBasics']);
    if (!cfgBlob[spec.storageKey])
      console.warn(
        '!! 盘上没有 %s 这份配置 → 按 defaults.enabled=false 起，feat 根本没被启用过（或换了 UID 命名空间）。',
        ID,
      );
    else if (!cfgBlob[spec.storageKey].enabled)
      console.warn('!! 持久化 enabled=false → 面板上这一项是关的（或被组闸门级联关掉）。');
  }

  // ── P3. 安装：硬依赖符号 + net 底座 ─────────────────────────────
  H('P3. 安装层（symbols 自检 / net 底座）');
  const miss = [];
  for (const name of spec.symbols || []) {
    const soft = /\?$/.test(name);
    let ok;
    try {
      ok = !!gameApi.checkCap(name);
    } catch (e) {
      ok = 'err:' + e.message;
    }
    console.log(
      (ok === true ? '  OK  ' : soft ? '  soft ' : '  MISS ') +
        name +
        (ok === true || soft ? '' : ' -> ' + ok),
    );
    if (ok !== true && !soft) miss.push(name);
  }
  if (miss.length)
    console.warn(
      '!! 硬依赖缺失 missing=%s → reactor 判安装失败，永不 activate（日志会有一条 install failed warn）。',
      miss.join(';'),
    );
  const net = PC.net;
  console.log(
    'pocketcc.net 在场 =',
    !!net,
    '; net.install() 幂等返回 =',
    net && typeof net.install === 'function' ? net.install() : '(不可用)',
  );

  // ── P4. 门控：world 门控（kind × place + 秘境隔离）/ mode ───────
  H('P4. 门控层（当前世界态是否放行）');
  if (WS && typeof WS.current === 'function') {
    const st = WS.current();
    console.log('worldState.current =', {
      kind: st.kind,
      place: st.place,
      phase: st.phase,
      gen: st.gen,
    });
    const kindOk = WS.matchesKind(spec.kinds);
    const placeOk = WS.matchesPlace(spec.places);
    console.log(
      'matchesKind(kinds)=%s ; matchesPlace(places)=%s ; pab 隔离=%s',
      kindOk,
      placeOk,
      st.kind === WS.KIND.pab ? '秘境图内：未声明 pab 的 feat 一律 pause' : '不在秘境',
    );
    if (!kindOk || !placeOk)
      console.warn('!! 当前场景不放行 → feat 被 pause（回自己主城/本服大地图即自愈）。');
  } else {
    console.log(
      'worldState 不可用（旧构建？），退化看场景名：',
      (() => {
        try {
          return gameApi.scene.name();
        } catch (e) {
          return 'err:' + e.message;
        }
      })(),
    );
  }
  console.log(
    'offInCombat=%s → 战斗模式门控%s受限',
    spec.offInCombat,
    spec.offInCombat ? '' : '不',
  );

  // ── P5. 开启闸：三级逐级复算 ────────────────────────────────────
  H('P5. 开启闸（TaskRelax 三级，复刻 gameData.taskRelaxOpenRows）');
  const u = (() => {
    try {
      return game.get(SYM.modules.dataCenter).DATA.UserData;
    } catch (e) {
      return null;
    }
  })();
  const gd = (() => {
    try {
      return ns(game.get(SYM.modules.gameDefine));
    } catch (e) {
      return null;
    }
  })();
  const fk = gd && gd.FunctionKey && gd.FunctionKey.task_relax_claim_all;
  console.log('UserData 在场 =', !!u);
  console.log(
    '① FunctionKey[task_relax_claim_all] 原始成员名 =',
    JSON.stringify(fk),
    '; FunctionOn(...) =',
    (() => {
      try {
        return u && typeof u.FunctionOn === 'function' && fk ? !!u.FunctionOn(fk) : '(不可判)';
      } catch (e) {
        return 'threw:' + e.message;
      }
    })(),
  );
  if (fk == null)
    console.warn(
      '!! ① 账号总闸：GameDefine.FunctionKey 里查不到该成员名（枚举改名/漂移或该账号未开）→ 整功能挂起。',
    );

  const wl = String(gameConf.dataConfig(CFG_RANGE) || '');
  const range = u ? u.serverTransferRange : undefined;
  console.log(
    '② DataConfig %s 白名单 =',
    CFG_RANGE,
    JSON.stringify(wl),
    '; UserData.serverTransferRange =',
    JSON.stringify(range),
    typeof range,
    '; 命中 =',
    wl.split(',').indexOf(String(range == null ? '' : range)) >= 0,
  );
  if (!wl)
    console.warn(
      '!! ② 服务器灰度闸：79089 配置缺失/为空 → 游戏侧未放量，feat 会打「一键领取未对该玩家开启…挂起待巡检」后静默。',
    );

  const rows = l10n.tableRows('task_relax') || [];
  const lv = gameData.level();
  console.log('③ task_relax 表行数 =', rows.length, '; 本人等级 =', lv);
  if (!rows.length)
    console.warn('!! ③ 表未就绪或改名（l10n.tableRows("task_relax") 空）→ 可用行恒空。');
  console.table(
    rows.map((r) => ({
      id: r.id,
      type: r.type,
      level: r.level,
      order: r.order,
      等级达标: lv >= Number(r.level),
    })),
  );
  const advThr = String(gameConf.dataConfig(CFG_ADVENTURE));
  console.log(
    '远征门槛 79092 =',
    JSON.stringify(advThr),
    '; LastWinMissionId =',
    u && u.AdventureData ? u.AdventureData.LastWinMissionId : '(无 AdventureData)',
  );
  const open = gameData.taskRelaxOpenRows();
  console.log(
    'ACL 终判 taskRelaxOpenRows() =',
    open.map((r) => r.id + ':' + r.type),
    '; 长度 =',
    open.length,
  );
  if (!open.length)
    console.warn(
      '!! 开启闸判为空 → feat 每 15min 巡检一次且零发包（这正是最常见的「看起来停了」）。对照上面 ①②③ 找是哪一级卡的。',
    );

  // ── P6. 择时：日锚/冷却复算（区分「正常长睡」与「真停摆」） ─────
  H('P6. 择时层（日锚 / 冷却 / 在途闸门）');
  const srv = gameData.serverTime();
  const next = gameData.nextDailyResetTs();
  console.log('ServerTime =', srv, srv ? '(' + new Date(srv * 1000).toLocaleString() + ')' : '');
  console.log(
    'nextDailyResetTs =',
    next,
    next
      ? '(' + new Date(next * 1000).toLocaleString() + ')'
      : '(取不到 → dailyDelay 退化 IDLE 15min)',
  );
  if (srv && next)
    console.log(
      '距下一个 0 点 =',
      Math.round((next - srv) / 60),
      'min（领过一次后 feat 就睡这么久，最长 24h）',
    );
  console.log(
    'isSending(5684) =',
    net ? net.isSending(CMD_INFO) : '-',
    '; isSending(5685) =',
    net ? net.isSending(CMD_REWARD) : '-',
  );
  if (net && (net.isSending(CMD_INFO) || net.isSending(CMD_REWARD)))
    console.warn(
      '!! 该 cmd 有「已发出未收应答」的在途请求 → fetchInfo/claimAll 会一直回 CODE_NOT_SENT，feat 每 20s 瞬态重试（只打 debug，看起来完全不动）。',
    );

  if (!ACTIVE_INFO_PROBE) {
    console.log('ACTIVE_INFO_PROBE=false：跳过 5684 主动查询（零发包）。');
  } else if (!net || net.isSending(CMD_INFO)) {
    console.warn('跳过 5684 主动查询（net 不在场或已在途）。');
  } else {
    try {
      const ret = await net.sendPBV2(CMD_INFO, {});
      console.log('5684 应答 ok=%s code=%s data=', ret && ret.ok, ret && ret.code, ret && ret.data);
      const limitTs = Number(ret && ret.data && ret.data.limitTimeSec) || 0;
      console.log(
        'limitTimeSec（绝对服务器秒） =',
        limitTs,
        limitTs ? '(' + new Date(limitTs * 1000).toLocaleString() + ')' : '(0=现在可领)',
      );
      if (limitTs && srv < limitTs)
        console.log(
          '→ 服务器冷却中，还剩',
          Math.round(((limitTs - srv) / 60) * 10) / 10,
          'min（feat 会睡到点，零发包）',
        );
      else
        console.log(
          '→ 不在冷却。若开启闸非空且 isRunning=true 却仍未领取，问题在 cycle 排程（见下方判读）。',
        );
      const d = (ret && ret.data && ret.data.detail) || [];
      if (d.length) console.table(d.map((x) => ({ id: x.id, code: x.code, param: x.param })));
    } catch (e) {
      console.error('5684 主动查询抛错：', e && e.message);
    }
  }

  // ── 结论速判 ────────────────────────────────────────────────────
  H('结论速判（贴回 P1–P6 原文）');
  console.log(
    [
      'P1 缺 spec → 构建/import 问题，先去 content.entry.js 补引用再 F5；',
      'P2 enabled=false 或盘上无此键 → 面板没开（或被组闸门关/换 UID 后配置不在该命名空间），勾上即恢复；',
      'P3 有 MISS 或 net 不可用 → 安装失败，控制台应有 REACTOR 的 install failed warn（符号漂移需修 game-api CAPS）；',
      'P4 门控不放行 → 在秘境/跨服图，回本服主城或大地图后自愈；',
      'P5 taskRelaxOpenRows()=空 → 游戏侧真没开（①总闸/②79089 灰度/③行解锁），feat 只 15min 巡检，属设计内挂起；',
      'P6 冷却中或距 0 点很久 → 没坏，在长睡（ONE-CLICK/CYCLE 应有 "next check at [...]" 一行 info）；',
      'P6 isSending 恒 true → 在途闸门卡死，feat 每 20s 空转（把 net 日志开起来看 5684 是否有应答）。',
      '以上全绿 + isRunning=true + 不在冷却 + 闸内可用行非空，却仍无动作 → cycle 排程问题：',
      '   重点怀疑「暂停期在飞的那轮返回了长 delay」——恢复运行只 kick 一次，在飞时仅置 pending，',
      '   而本 feat 不读 cycle.pending，于是照旧睡到 0 点，表现为恢复后长时间不动。',
    ].join('\n'),
  );
})();
