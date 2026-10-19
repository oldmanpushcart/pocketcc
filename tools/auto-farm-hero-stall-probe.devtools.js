/**
 * 自动下田（auto-farm）「英雄未释放」停摆诊断探针（DevTools 一次性粘贴运行，只读游戏数据；仅多发一条 856 查行军）
 *
 * 症状：面板日志每 60s 刷一条
 *   [AUTO-FARM] row 0 preset #6(战斗#6) heroes not yet released, skip this cycle.
 *   出处 feats/player/auto-farm.js 的英雄就绪守卫：plan.presetHasHeroes && !plan.heroList.length → 本轮跳过。
 *   守卫本意只挡「回城推送后兵池已刷新、英雄释放推送未到」的 1~2s 竞争窗口；连续十几分钟不消失 ⇒ 不是竞态，而是某个前提长期为假。
 *
 * 判据链（battle.js build → recalcData → game-api.battlePreset.recalc，实证游戏源码）：
 *   presetHasHeroes = 预设 HeroIds 非空；heroList = 交游戏重算器 checkPreMarchExtraList(checkMarch=true) 截断后的英雄名单。
 *   重算器截断口径（subpack2/RealMarchStorageController）：
 *     p = HeroController.getHaveHeroCanMarchList()；f = DATACONFIG 61002 .value + Buff(BattleHeroAddNum)；
 *     逐个 preset heroId T：仅当 p 里存在 `T === hero.Id`（**严格等于**，类型漂移即落空）且 g.length < f 才保留。
 *   getHaveHeroCanMarchList 口径（subpack2/HeroManager）：剔除 (TryOut && ExpireTime>0 && ExpireTime<ServerTime) 过期试用英雄；
 *     并按需剔除 `hero.State !== HeroState.Default`（Default=0 / March=1；仅当 CurBattleData.Type 不在 enableAllHeroBattleTypes 时检查）。
 *   若 battlePreset.ok()=false（重算符号漂移）→ battle.js 降级 filterFallback，用 `hero._id` 建集合过滤，另一套字段口径。
 *
 * 停摆假设（本探针逐一定位，结论见第 H 段）：
 *   H1 英雄真的在外（State=March 且 856 有行军引用它）——非采集类行军长期占用（集结/无尽/运车…）。
 *   H2 本地英雄状态陈旧（State=March 但 856 无任何行军引用）——heroMarchUpdate 推送缺失，只能靠刷新/重登复位。
 *   H3 预设 #6 引用的英雄已不存在/试用过期（UserData.Heros 取不到或被 TryOut 过滤）。
 *   H4 出征英雄上限 f ≤ 0（61002 缺配 + buff 负值）——全体预设一起中招，不止 #6。
 *   H5 重算器符号漂移 → 走降级路径，而降级用 `_id` 口径与名单实际字段不匹配 → heroList 恒空。
 *   H6 预设 heroIds 类型漂移（字符串/Long vs 数字 Id）→ 严格等于匹配全体落空 → heroList 恒空（只影响该预设）。
 *
 * 用法：登录进游戏、MAIN world 控制台（window.pocketcc 可见）整段粘贴。默认诊断 #6 号预设，
 *   换目标预设：window.__afHeroProbe(9)（9~16 为采集预设）。
 *
 * 分段：A 现场态+生产判据复算 / A2 面板规则行与账本（确认只有哪几行缺位）/ B 全体预设横向对比 /
 *   C 可派遣名单与字段口径 / D 预设英雄逐个体检 / E 本地 State vs 856 行军交叉 / F 出征英雄上限 f / G A/B 实验 / H 结论。
 */
(async function autoFarmHeroStallProbe(selfArg) {
  const PC = window.pocketcc;
  if (!PC || !PC.game || !PC.gameApi || !PC.gameApi.battlePreset) {
    console.error(
      '[af-hero-stall] window.pocketcc 未就绪（缺 game/gameApi.battlePreset）：确认已加载扩展、已登录、MAIN world 上下文。',
    );
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const KV = (k, v) => console.log('  ' + k + ':', v);
  const WARN = (m) => console.log('%c  ⚠ ' + m, 'color:#e05c5c');
  const OK = (m) => console.log('%c  ✓ ' + m, 'color:#7cb342');
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      return null;
    }
  };

  /** 面板预设号（1~16）→ (index 1 起, type 0 战斗/1 采集)，与 auto-farm.presetArgs 同口径 */
  const presetArgs = (p) =>
    p >= 9 ? { index: p - 8, type: 1 } : { index: Math.max(1, p), type: 0 };
  const brief = (v) => {
    if (v === null || v === undefined) return String(v);
    if (typeof v !== 'object') return typeof v + ':' + String(v);
    if (Array.isArray(v)) return 'arr[' + v.length + ']:' + JSON.stringify(v.slice(0, 8));
    const ks = Object.keys(v);
    return (
      'obj{' + ks.slice(0, 10).join(',') + (ks.length > 10 ? '…+' + (ks.length - 10) : '') + '}'
    );
  };

  const target = Number(selfArg) || 6;
  const pa = presetArgs(target);

  // ── 前置：本探针要复刻的生产判据（三处游戏符号，缺一个就无法定位，先验在场）──
  const DATA = (G('DataCenter') || {}).DATA || null;
  const U = DATA && DATA.UserData;
  const heroInstOf = () => {
    const m = G('HeroController');
    return (m && m.HeroController && m.HeroController.getInstance()) || null;
  };
  const presetCtl = () => {
    const m = G('PresetMarchController');
    return (m && m.default && m.default.instance) || null;
  };
  if (!DATA || !U || !heroInstOf() || !presetCtl()) {
    console.warn(
      '[af-hero-stall] 游戏符号缺失（DataCenter/HeroController/PresetMarchController），后续段会降级。',
    );
  }

  /** 读预设原始档案（照抄 battle.js readPreset 口径） */
  const readPreset = (index1, type) => {
    const ctl = presetCtl();
    const p = ctl && ctl.getPreMarchByIndex(index1 - 1, type);
    if (!p) return null;
    let armys = [];
    try {
      armys = p.Armys || p._Armys || [];
    } catch (e) {}
    let hids = [];
    try {
      hids = p.HeroIds || p._HeroIds || [];
    } catch (e) {}
    let formationV2 = 0;
    try {
      formationV2 = (ctl.getFormationV2ByIndex && ctl.getFormationV2ByIndex(index1 - 1, type)) || 0;
    } catch (e) {}
    let extra = null;
    try {
      extra = p.extraArmy || p._extraArmy || null;
    } catch (e) {}
    return { rawArmys: armys, rawHeroIds: hids, formationV2, rawExtra: extra, present: true };
  };
  /** extraArmy 数组 → 请求对象（照抄 battle.js toExtraArmy） */
  const toExtra = (extra) => {
    if (!extra) return null;
    const list = Array.isArray(extra) ? extra : [extra];
    if (!list.length) return null;
    let num = 0;
    list.forEach((it) => (num += it.Num | 0));
    return num > 0 ? { armyId: list[0].ArmyId, armyNum: num } : null;
  };
  /** 交游戏重算器实算（自建副本，绝不喂游戏对象）→ {heroIds, armyInfo} 或 {err} */
  const recalc = (rp, checkMarch, heroIdsOverride) => {
    if (!rp || !rp.present) return { err: '预设读不到' };
    const armyInfo = (rp.rawArmys || [])
      .filter((a) => a && a.ArmyId)
      .map((a) => ({ armyId: a.ArmyId, num: a.Num | 0, pos: a.Pos | 0, heroCap: a.heroCap || 0 }))
      .sort((x, y) => x.pos - y.pos);
    if (!armyInfo.length) return { err: 'armyInfo 空（重算器要求至少 1 条兵）' };
    const entry = {
      index: 0,
      formation: 0,
      formationV2: rp.formationV2 | 0,
      heroIds: (heroIdsOverride || rp.rawHeroIds || []).slice(),
      armyInfo,
      extraArmy: toExtra(rp.rawExtra),
    };
    const out = PC.gameApi.battlePreset.recalc(entry, checkMarch !== false);
    return out
      ? { heroIds: out.heroIds || [], armyInfo: out.armyInfo || [], entryIn: entry }
      : { err: 'recalc 返回 null（符号不可用或游戏抛错 → 生产走降级 filterFallback）' };
  };

  // ── A. 现场态 + 生产判据复算（一屏看是不是仍在守卫里）────────────────
  H(
    'A. 现场态 & 生产同款判据复算（预设 #' +
      target +
      ' → ' +
      (pa.type ? '采集' : '战斗') +
      '#' +
      pa.index +
      '）',
  );
  KV('reactor.isRunning(autoFarm)', PC.reactor ? PC.reactor.isRunning('autoFarm') : '(无 reactor)');
  try {
    const ws = PC.worldState && PC.worldState.current ? PC.worldState.current() : null;
    if (ws) KV('worldState', { kind: ws.kind, place: ws.place, phase: ws.phase });
    KV('scene.name', PC.gameApi.scene && PC.gameApi.scene.name ? PC.gameApi.scene.name() : '(n/a)');
  } catch (e) {
    KV('场景探测异常', e && e.message);
  }
  KV('重算器可用 battlePreset.ok()', PC.gameApi.battlePreset.ok());
  const rp = readPreset(pa.index, pa.type);
  if (!rp) {
    WARN(
      '预设 #' + target + ' 读不到（getPreMarchByIndex 返回 null）→ 生产 plan 会派空，本探针终止。',
    );
    return;
  }
  const rTrue = recalc(rp, true);
  const rFalse = recalc(rp, false);
  KV('预设 HeroIds（raw）', brief(rp.rawHeroIds));
  KV('预设 armyInfo 条数', (rp.rawArmys || []).length);
  KV('checkMarch=true → heroIds', rTrue.err ? 'ERR ' + rTrue.err : brief(rTrue.heroIds));
  KV('checkMarch=false → heroIds', rFalse.err ? 'ERR ' + rFalse.err : brief(rFalse.heroIds));
  if (!rTrue.err && rTrue.heroIds.length === 0) {
    console.log(
      '  生产口径命中：presetHasHeroes=' +
        ((rp.rawHeroIds || []).length > 0) +
        ' && heroList.length=0 → 守卫跳过（与日志一致）。下面逐段定位是哪一环把英雄截没了。',
    );
  } else if (!rTrue.err) {
    console.log(
      '  此刻重算已能给出 ' +
        rTrue.heroIds.length +
        ' 个英雄 → 守卫当前不会拦；若仍在刷屏，说明运行期与本探针读的名单不同步（H5 降级路径 / 时点差异），看 C/E 段。',
    );
  }

  // ── A2. 面板规则行 & 账本（确认「只有 row 0 缺位」与它绑的预设）───────
  H('A2. 面板规则行 / 账本');
  let cfg = null;
  try {
    cfg = await PC.storage.get('pocketcc.feat.autoFarm');
  } catch (e) {
    KV('配置读取异常（UID 命名空间未就绪？）', e && e.message);
  }
  const rules = (cfg && cfg.rules) || [];
  KV(
    'enabled / timeWindowEnabled / 诊断预设',
    (cfg && cfg.enabled) + ' / ' + (cfg && cfg.timeWindowEnabled) + ' / #' + target,
  );
  let ledger = null;
  try {
    ledger = await PC.storage.data.get('autoFarm');
  } catch (e) {
    KV('账本读取异常', e && e.message);
  }
  const rowsOut = rules.map((r, i) => ({
    行: i,
    资源家族: r.family,
    等级: r.level,
    仅机械田: !!r.mechOnly,
    预设: r.preset,
    账本在途: ledger && ledger[i] ? ledger[i].length : 0,
    缺位:
      ledger && ledger[i] && ledger[i].length ? '否（本轮不会走到派发）' : '是（本行才会被尝试）',
  }));
  if (rowsOut.length) console.table(rowsOut);
  else console.log('  读到空 rules（面板未配规则或配置未落盘）');

  // ── B. 横向对比：战斗 1~8 / 采集 1~8 全体预设「raw vs 重算后」─────────
  H('B. 全体预设横向对比（区分「只有 #N 中招」vs「全体中招」）');
  const rowsCmp = [];
  for (const [label, type] of [
    ['战斗', 0],
    ['采集', 1],
  ]) {
    for (let i = 1; i <= 8; i++) {
      const r = readPreset(i, type);
      if (!r || !(r.rawHeroIds || []).length) continue;
      const rr = recalc(r, true);
      rowsCmp.push({
        预设: label + i,
        raw英雄数: r.rawHeroIds.length,
        重算后: rr.err ? 'ERR' : rr.heroIds.length,
        兵种条数: (r.rawArmys || []).length,
        重算后兵: rr.err ? '-' : rr.armyInfo.length,
      });
    }
  }
  console.table(rowsCmp);
  const zeroed = rowsCmp.filter((x) => x.重算后 === 0).length;
  if (zeroed === rowsCmp.length && rowsCmp.length)
    WARN(
      '全部带英雄的预设都被截成 0 → 高度怀疑 H4（上限 f≤0）或 H5（符号/字段口径漂移），非 #6 独有。',
    );
  else if (zeroed)
    WARN(
      '仅 ' + zeroed + ' 个预设被截成 0（见上表）→ 问题在这些预设所配的英雄本身（H1/H2/H3/H6）。',
    );

  // ── C. 可派遣英雄名单（游戏原生口径 + 字段口径核验）──────────────────
  H('C. getHaveHeroCanMarchList 名单与字段口径');
  const inst = heroInstOf();
  const marchable = (inst && inst.getHaveHeroCanMarchList()) || [];
  KV('名单长度', marchable.length);
  KV(
    '名单前 20 个 Id',
    marchable.slice(0, 20).map((h) => h && h.Id),
  );
  const sample = marchable[0] || null;
  if (sample) {
    KV('样例元素字段（own keys）', Object.keys(sample).slice(0, 16));
    KV('样例 .Id / ._id', sample.Id + ' / ' + sample._id + '（typeof ' + typeof sample._id + '）');
    if (sample._id === undefined)
      WARN(
        '名单元素没有 `_id` 字段 → 降级路径 battle.js filterHeroIds（用 _id 建集合）会恒空（H5）。',
      );
  }
  const hc = G('HeroController');
  KV('HeroState 枚举', hc && hc.HeroState);
  const HeroState = (hc && hc.HeroState) || { Default: 0, March: 1 };
  let stateChecked = true; // 名单是否要求 State===Default（getHaveHeroCanMarchList 的 e 标志）
  try {
    const BTC = G('BattleTypeConfig');
    const curType = (DATA.CurBattleData && DATA.CurBattleData.Type) || 0;
    const enableAll =
      BTC && BTC.default && BTC.default.Instance && BTC.default.Instance.enableAllHeroBattleTypes;
    const skipStateCheck = !!(enableAll && enableAll.indexOf(curType) >= 0);
    stateChecked = !skipStateCheck;
    KV(
      'CurBattleData.Type / 是否跳过 State 检查',
      curType +
        ' / ' +
        skipStateCheck +
        (skipStateCheck ? '（名单只看过期，不看 State）' : '（名单要求 State===Default）'),
    );
    if (curType)
      console.log(
        '  注：CurBattleData 是战斗面板残留态；若它停在某个「要求 State===Default」的类型上，本身不额外拦人，但会让面板与本地态判定不同步，仅供解读参考。',
      );
  } catch (e) {
    KV('CurBattleData 探测异常', e && e.message);
  }

  // ── D. 逐个卡住英雄体检（#N 的每个 heroId 到底为什么不在名单里）──────
  H('D. 预设 #' + target + ' 英雄逐个体检');
  const setIds = new Set(marchable.map((h) => h && h.Id));
  const rawIds = (rp.rawHeroIds || []).slice();
  const verdicts = [];
  const srv = Number(DATA && DATA.ServerTime) || Math.floor(Date.now() / 1000);
  for (const id of rawIds) {
    const rec = { heroId: id, typeof: typeof id, 在名单: setIds.has(id) ? 'Y' : 'N', 结论: '' };
    const byNum = U && U.Heros ? U.Heros[id] || U.Heros[Number(id)] : null;
    if (!byNum) {
      rec.在Heros = 'N';
      rec.结论 = 'H3 预设引用的英雄在 UserData.Heros 里不存在（已删除/换将/借用未同步）';
    } else {
      rec.在Heros = 'Y';
      rec.Level = byNum.Level;
      rec.Star = byNum.Star;
      rec.State = byNum.State;
      rec.Is_show = byNum.Is_show;
      rec.TryOut = byNum.TryOut;
      rec.ExpireTime = byNum.ExpireTime;
      const expired =
        !!byNum.TryOut && Number(byNum.ExpireTime) > 0 && Number(byNum.ExpireTime) < srv;
      if (expired)
        rec.结论 =
          'H3 试用/限时英雄已过期（ExpireTime ' + byNum.ExpireTime + ' < ServerTime ' + srv + '）';
      else if (Number(byNum.State) !== Number(HeroState.Default))
        rec.结论 =
          'State=' +
          byNum.State +
          '（' +
          (Number(byNum.State) === Number(HeroState.March)
            ? 'March：被行军占用/未释放'
            : '非常规值') +
          '）' +
          (stateChecked
            ? '→ 名单剔除，见 E 段定谁占用'
            : '→ 但当前名单不看 State（C 段 skipStateCheck），此值不是拦截原因，另查 H3/H6');
      else if (typeof id === 'string' && setIds.has(Number(id)))
        rec.结论 = 'H6 类型漂移：名单里有同号数字 Id，但预设存的是字符串 → 严格等于匹配落空';
      else if (rec.在名单 === 'Y') rec.结论 = '正常可派（heroList 仍空则看 F 段上限 f / G 段实验）';
      else
        rec.结论 =
          '健康却不在名单：英雄自身 Id=' +
          byNum.Id +
          '(' +
          typeof byNum.Id +
          ')、预设存 ' +
          id +
          '(' +
          typeof id +
          ') → Id 口径/实例不一致，重点看 C 段名单前 20 是否含此号';
    }
    verdicts.push(rec);
  }
  console.table(verdicts);

  // ── E. 谁锁住了英雄（State≠Default 全量清单 + 856 行军引用交叉）──────
  H('E. 英雄占用交叉验证（本地 State vs 856 权威行军）');
  const locked = [];
  if (U && U.Heros) {
    for (const k in U.Heros) {
      const h = U.Heros[k];
      if (h && Number(h.State) !== Number(HeroState.Default))
        locked.push({ key: k, Id: h.Id, State: h.State, Level: h.Level });
    }
  }
  KV('本地 State≠Default 的英雄数', locked.length);
  if (locked.length) console.table(locked.slice(0, 40));
  let marches = null;
  if (!PC.net || typeof PC.net.send !== 'function') {
    WARN('pocketcc.net 不可用 → 跳过 856 交叉验证，H1/H2 需另行确认。');
  } else
    try {
      const ret = await PC.net.send(856, {});
      const d = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data;
      marches =
        (d && (Array.isArray(d.marches) ? d.marches : Array.isArray(d.ret) ? d.ret : null)) || [];
      KV('856 本人行军条数', marches.length);
    } catch (e) {
      WARN('856 发不出/解析失败（' + (e && e.message) + '）→ 无法交叉验证占用，H1/H2 需另行确认。');
    }
  // 递归在 856 条目里找等于该英雄 id 的叶子，**连路径一起打出**（避免把 armyId/坐标误读成英雄引用）
  const heroRefSearch = (id) => {
    if (!marches) return [];
    const num = Number(id);
    if (!isFinite(num)) return [];
    const hit = [];
    const walk = (node, path, depth) => {
      if (hit.length >= 6 || node == null || depth > 6) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length && hit.length < 6; i++)
          walk(node[i], path + '[' + i + ']', depth + 1);
        return;
      }
      if (typeof node === 'object') {
        for (const k of Object.keys(node)) walk(node[k], path + '.' + k, depth + 1);
        return;
      }
      if (typeof node === 'number' || (typeof node === 'string' && node !== '')) {
        if (Number(node) === num && path) hit.push({ 命中路径: path });
        return;
      }
    };
    marches.forEach((m) => {
      const before = hit.length;
      const mi = m.marchInfo || m;
      walk(m, 'march#' + String(mi.marchId || m.marchId || mi.id || '?'), 0);
      for (let i = before; i < hit.length; i++) {
        hit[i].marchId = String(mi.marchId || m.marchId || mi.id || '');
        hit[i].type = mi.marchType != null ? mi.marchType : m.marchType;
        hit[i].state = mi.state != null ? mi.state : m.marchState;
      }
    });
    return hit;
  };
  for (const v of verdicts) {
    if (v.在名单 === 'Y') continue;
    const hits = heroRefSearch(v.heroId);
    console.log(
      '  hero ' +
        v.heroId +
        '（' +
        v.结论 +
        '）→ 856 引用: ' +
        (hits.length ? JSON.stringify(hits) : '无'),
    );
    if (!hits.length && /State=/.test(v.结论))
      WARN(
        'H2 症状：英雄本地 State=March 但没有任何在途行军引用它 → heroMarchUpdate 推送缺失，客户端状态陈旧（重载页面/重新登录会复位）。',
      );
    else if (hits.length)
      OK('H1 症状：英雄确实在占用中（marchType 见上，非采集 3/26 的行军也会占英雄）。');
  }

  // ── F. 出征英雄上限 f（H4：全体截断的头号嫌疑）───────────────────────
  H('F. 出征英雄上限 f = DATACONFIG 61002 + Buff(BattleHeroAddNum)');
  const row61002 =
    PC.gameApi.l10n && PC.gameApi.l10n.tableRow
      ? PC.gameApi.l10n.tableRow('DATACONFIG', '61002')
      : null;
  KV('DATACONFIG 61002 行', row61002 ? JSON.stringify(row61002).slice(0, 300) : '(取不到)');
  KV(
    'gameConf.dataConfig(61002)',
    PC.gameApi.gameConf ? PC.gameApi.gameConf.dataConfig(61002) : '(无)',
  );
  try {
    const GD = G('GameDefine');
    const bt = GD && GD.BuffType ? GD.BuffType.BattleHeroAddNum : null;
    const add =
      bt != null && U && U.Buff && U.Buff.getBuffAddValue ? U.Buff.getBuffAddValue(bt) : null;
    KV('BuffType.BattleHeroAddNum / getBuffAddValue', bt + ' / ' + add);
  } catch (e) {
    KV('buff 探测异常', e && e.message);
  }
  try {
    const NBM = G('NBattleModel');
    const ins = NBM && NBM.NBattleModel && NBM.NBattleModel.instance;
    KV(
      '游戏原生 getMarchHeroNumMax()',
      ins && typeof ins.getMarchHeroNumMax === 'function'
        ? ins.getMarchHeroNumMax()
        : '(符号不在场)',
    );
  } catch (e) {
    KV('NBattleModel 探测异常', e && e.message);
  }
  if (marchable.length && rTrue.err === undefined && rTrue.heroIds.length === 0)
    console.log(
      '  判读：名单非空却截成 0，且 D 段英雄皆「正常可派」→ 只看这里的 f（≤0 即 H4 成立）。',
    );

  // ── G. A/B 决定性实验（把变量逐个换掉，看 heroList 何时复活）─────────
  H('G. A/B 实验：armyInfo 固定为 #' + target + '，只换 heroIds');
  const exps = [];
  const lenOf = (r) => (r.err ? null : r.heroIds.length);
  const push1 = (name, ids) => {
    const r = recalc(rp, true, ids);
    exps.push({
      实验: name,
      输入: brief(ids),
      重算后英雄数: r.err ? 'ERR' : r.heroIds.length,
      重算后: r.err ? 'ERR ' + r.err : brief(r.heroIds),
    });
    return r;
  };
  const e1 = push1('① 预设原样（含原类型）', rp.rawHeroIds);
  const e2 = push1('② 预设 heroIds → Number()', (rp.rawHeroIds || []).map(Number));
  const e3 = push1(
    '③ 名单里前 3 个英雄 Id',
    marchable.slice(0, 3).map((h) => h && h.Id),
  );
  push1(
    '④ 名单前 3 个 → String()',
    marchable.slice(0, 3).map((h) => String(h && h.Id)),
  );
  console.table(exps);
  if (lenOf(e1) === 0 && lenOf(e2) > 0)
    WARN(
      'H6 定案：② Number() 化后英雄复活 ⇒ 预设存的是字符串/Long，游戏严格等于匹配落空。修复＝battle.js 装载完备集时统一 Number()。',
    );
  if (marchable.length && lenOf(e1) === 0 && lenOf(e3) === 0)
    WARN('名单内英雄照样被截成 0 ⇒ 与具体英雄无关 → H4（上限 f≤0）或重算器闸异常，查 F 段。');
  if (lenOf(e1) === null)
    WARN(
      '重算器对本行直接返回 null → 生产走降级 filterFallback（H5），重点看 C 段「样例元素字段」有无 _id。',
    );

  // ── H. 结论 ────────────────────────────────────────────────────────
  H('H. 结论打点');
  const bad = verdicts.filter((v) => v.在名单 !== 'Y');
  console.log(
    '  ① 预设 #' +
      target +
      ' 共 ' +
      rawIds.length +
      ' 个英雄，名单外 ' +
      bad.length +
      ' 个；' +
      (rowsCmp.length ? '全体预设 ' + rowsCmp.length + ' 个被截空 ' + zeroed + ' 个。' : ''),
  );
  console.log(
    '  ② 重算器在场=' +
      PC.gameApi.battlePreset.ok() +
      '，名单长度=' +
      marchable.length +
      '，ServerTime=' +
      srv +
      '。把 A~G 段（尤其 D/G 两表 + F 段上限）整段贴回即可定案。',
  );
  console.log(
    '%c\n判读速查：D 表结论列直接给 H 编号；② 实验表若「Number() 化复活」= H6；「名单英雄也空」= H4/H5；' +
      '「856 无引用但 State=March」= H2（客户端状态陈旧，reload 复位）；「856 有引用」= H1（真被别的行军占用，考虑给该行军让位或换预设英雄）。',
    'color:#7cb342',
  );

  // 复跑入口：换预设诊断（不发 902，纯本地读 + 一条 856）
  window.__afHeroProbe = (n) => autoFarmHeroStallProbe(n);
})().catch((e) => console.error('[af-hero-stall] 探针异常:', e));
