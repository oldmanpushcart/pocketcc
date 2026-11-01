/**
 * 异能秘境自动驾驶 v3（pilot）**数据源可用性探针**（纯只读，仅 901 查询，不发任何写包）
 *
 * 目的：在重写驾驶层之前，先把 v3 依赖的三个数据源**一次性验明**。三条任一不成立，重设计就得换源：
 *   ① 表格 `enigma_secret_realm_building` 能否直接给出四个商店坐标（不再依赖镜头扫到 161）
 *   ② 901 GET_WORLD_INFO 能否在秘境图里**主动拉回 pointList**（不再依赖 10018 push 累积）
 *   ③ `bossBaseInfo` 是否带 BOSS 权威坐标 pos / state / stateEndTime
 *
 * 用法：进入异能秘境地图 → F12 Console → 粘贴本文件全部内容 → `__pcPilotSnap()`。
 *   默认等你拖镜头 0s；`__pcPilotSnap({wait:8000})` 先等 8 秒（用于观察 push 增量后再主动查）。
 *
 * 判读：每段末尾 ✔/✘，最后 E 段给「v3 能不能落地」的结论。
 */
(() => {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.gameApi.secretRealm) {
    console.error('[pilot-snap] window.pocketcc.gameApi.secretRealm 不可见：扩展未加载/未在页面主世界执行');
    return;
  }
  const G = PC.gameApi;
  const SR = G.secretRealm;

  const H = (s) => console.log('%c\n===== ' + s + ' =====', 'color:#0b6;font-weight:bold');
  const KV = (k, v) => console.log('%c  ' + k + ' = ', 'color:#666', v);
  const OK = (s) => console.log('%c  ✔ ' + s, 'color:#1a7f37');
  const NO = (s) => console.log('%c  ✘ ' + s, 'color:#c0392b;font-weight:bold');
  const WARN = (s) => console.log('%c  ! ' + s, 'color:#b8860b');

  const safe = (fn, dflt) => {
    try {
      return fn();
    } catch (e) {
      return dflt;
    }
  };
  const toNum = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    try {
      if (typeof v.toNumber === 'function') return v.toNumber() || 0;
    } catch (e) {}
    return Number(v) || 0;
  };
  const ptName = (pt) => {
    const M = { 161: '商店', 163: '掉落箱', 172: '野怪', 173: '资源点', 174: '平台', 175: '营帐', 176: 'BOSS平台' };
    return (M[pt] || '其它') + '(' + pt + ')';
  };

  window.__pcPilotSnap = async function (opt) {
    const o = opt || {};
    const wait = Math.max(0, Number(o.wait) || 0);

    console.log('%c[pilot-snap] 开始：本探针只读 + 仅发一笔 901 查询', 'color:#0366d6;font-weight:bold');
    if (wait) {
      console.log('  先等 ' + wait + 'ms…');
      await new Promise((r) => setTimeout(r, wait));
    }

    const t0 = Date.now();
    const isPab = safe(() => SR.isPabBattleMap(), false);
    const base = safe(() => SR.getRoomBaseInfo(), null);
    const groupId = base ? toNum(base.group) : 0;
    const start = base && base.startPoint ? base.startPoint : null;

    H('A. 场景与现场态');
    KV('isPabBattleMap', isPab);
    KV('reactor.isRunning(secretRealm)', safe(() => PC.reactor.isRunning('secretRealm'), 'n/a'));
    KV('startPoint', start ? '(' + start.x + ',' + start.y + ')' : null);
    KV('pointType', base ? ptName(Number(base.pointType) || 0) : null);
    KV('marchState', base ? Number(base.marchState) : null);
    KV('group（房间分组）', groupId);
    KV('isCanMarch（新 ACL）', safe(() => SR.isCanMarch(), 'n/a'));
    KV('isTeamLeader', safe(() => SR.isTeamLeader(), 'n/a'));
    KV('fightBegin/fightEnd', base ? toNum(base.fightBeginTime) + ' / ' + toNum(base.fightEndTime) : null);
    if (!base || !start) {
      NO('不在秘境房间内（roomBaseInfo/startPoint 缺失）→ 先进入秘境再跑本探针');
      return;
    }
    if (!isPab) WARN('isPabBattleMap=false，下面 901 可能走错通道');

    /* ── B. 表格：商店坐标 ─────────────────────────────────────── */
    H('B. 商店坐标（表 enigma_secret_realm_building, build_type=3）');
    let shopFromTable = [];
    const rows = safe(() => G.l10n.tableRows('enigma_secret_realm_building'), null) || [];
    KV('表行数', rows.length);
    if (rows.length) KV('首行字段', JSON.stringify(Object.keys(rows[0])));
    const shopsAll = rows.filter((r) => r && Number(r.build_type) === 3);
    KV('build_type=3 行数', shopsAll.length);
    const shopsGrp = groupId ? shopsAll.filter((r) => Number(r.group) === groupId) : shopsAll;
    KV('本组(或全部)行数', shopsGrp.length);
    shopFromTable = shopsGrp
      .map((r) => {
        const c = String(r.coords || r.coord || '').split(',');
        return { x: Number(c[0]), y: Number(c[1]), raw: r };
      })
      .filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && v.x > 0);
    shopFromTable.forEach((v, i) => KV('  商店' + (i + 1), '(' + v.x + ',' + v.y + ')'));
    if (shopFromTable.length) OK('表格可直接给出商店坐标，共 ' + shopFromTable.length + ' 个 → 商店档不再依赖视口');
    else {
      NO('表格取不到商店坐标 → 检查表名/字段名（上面首行字段）或 group 过滤');
      const sample = shopsAll.slice(0, 3).map((r) => JSON.stringify(r).slice(0, 160));
      sample.forEach((s) => KV('  样本', s));
    }

    /* ── C. 901 主动视口查询（v3 的地基） ───────────────────────── */
    H('C. 901 主动视口查询（以 startPoint 为中心 20×30）');
    let view = null;
    const tv = Date.now();
    try {
      view = await SR.queryWorldView(start.x, start.y, { viewLevel: 1 });
    } catch (e) {
      NO('queryWorldView 抛错：' + ((e && e.message) || e));
    }
    const viewMs = Date.now() - tv;
    if (!view) {
      NO('901 没有回包（' + viewMs + 'ms）→ v3 的「主动查询」方案不成立，需换数据源');
      WARN('可能原因：901 在秘境走主通道而不是次通道；或该 cmd 在秘境被服务端禁用');
    } else {
      const pts = view.points || [];
      const ms = view.marches || [];
      KV('耗时', viewMs + 'ms');
      KV('points 数量', pts.length);
      KV('marches 数量', ms.length);
      const byPt = {};
      pts.forEach((p) => {
        const k = Number(p.pointType) || 0;
        byPt[k] = (byPt[k] || 0) + 1;
      });
      const named = {};
      Object.keys(byPt).forEach((k) => {
        named[ptName(k)] = byPt[k];
      });
      KV('points 按类型', JSON.stringify(named));
      // 逐类抽样
      [173, 163, 161, 176, 172].forEach((pt) => {
        const arr = pts.filter((p) => Number(p.pointType) === pt);
        if (!arr.length) return;
        console.log('%c    ── ' + ptName(pt) + ' 共 ' + arr.length + ' 个', 'color:#0366d6');
        arr.slice(0, 6).forEach((p) => {
          const m = p.m || {};
          const d = Math.hypot(p.x - start.x, p.y - start.y);
          KV(
            '     (' + p.x + ',' + p.y + ')',
            'iNum=' + m.iNum + ' rTime=' + m.rTime + ' state=' + m.state + ' teams=' + (m.teams ? m.teams.length : '?') +
              ' esrId=' + m.esrId + ' 距' + d.toFixed(1),
          );
        });
      });
      if (ms.length) ms.slice(0, 4).forEach((m) => KV('    行军', JSON.stringify(m)));
      const usable = pts.filter((p) => Number(p.pointType) === 173 && Number((p.m || {}).iNum) > 0);
      if (usable.length) OK('901 可用：拉回 ' + pts.length + ' 个点，其中 ' + usable.length + ' 个 iNum>0 的资源点');
      else if (pts.length) WARN('901 可用但当前视口内没有 iNum>0 的 173（换位置再跑一次）');
      else NO('901 回了包但 pointList 为空 → 检查请求体 width/height/viewLevel 是否被服务端忽略');
    }

    /* ── D. BOSS 权威坐标 ─────────────────────────────────────── */
    H('D. BOSS 权威坐标（bossBaseInfo）');
    const boss = safe(() => SR.getBossBaseInfo(), null);
    KV('bossBaseInfo 条数', boss ? boss.length : 0);
    if (boss && boss.length) {
      boss.forEach((b) => {
        const p = b.pos || {};
        KV(
          '  boss#' + b.bossId,
          '(' + p.x + ',' + p.y + ') state=' + b.state + ' 结束=' +
            (toNum(b.stateEndTime) ? new Date(toNum(b.stateEndTime)).toLocaleTimeString() : '-') +
            ' 距' + (p.x ? Math.hypot(p.x - start.x, p.y - start.y).toFixed(1) : '?'),
        );
      });
      const hasPos = boss.some((b) => b.pos && Number(b.pos.x) > 0);
      if (hasPos) OK('BOSS 坐标可直接从服务器态取到 → 平台档不再依赖视口');
      else NO('bossBaseInfo 没有 pos');
    } else NO('bossBaseInfo 为空（21535 还没推？）');

    /* ── E. 行军 / 背包 / 增益 ─────────────────────────────────── */
    H('E. 行军列表 / 背包 / 增益（新 ACL）');
    const mar = safe(() => SR.getMarchList(), []);
    KV('getMarchList().length', Array.isArray(mar) ? mar.length : 'n/a');
    if (Array.isArray(mar)) mar.slice(0, 5).forEach((m) => KV('  行军', JSON.stringify(m)));
    const bag = safe(() => SR.getRoomBagInfo(), null);
    KV('roomBagInfo 字段', bag ? JSON.stringify(Object.keys(bag)) : null);
    KV('背包野兽数', bag && bag.beastInfo ? bag.beastInfo.length : 0);
    KV('41011 香肠 / 41009 购买币 / 41010 刷新币', [41011, 41009, 41010].map((id) => id + ':' + safe(() => SR.getItemNumById(id), '?')).join('  '));
    KV('拍宠中 capturingPetPos', JSON.stringify(safe(() => SR.getCapturingPetPos(), null)));
    KV('pabServerId()', safe(() => SR.pabServerId(), 'n/a'));
    KV('PabExtraPackItemNum 增益', safe(() => SR.getPabBuffValueByType(0), 'n/a') + '（type 传 0 只是探活，非真实值）');

    /* ── F. 表格：回合开放时间 ─────────────────────────────────── */
    H('F. 回合表（enigma_secret_realm_timer / enigma_secret_realm）');
    const timerRows = safe(() => G.l10n.tableRows('enigma_secret_realm_timer'), null) || [];
    KV('timer 行数', timerRows.length);
    if (timerRows.length) {
      KV('首行字段', JSON.stringify(Object.keys(timerRows[0])));
      timerRows.slice(0, 6).forEach((r) => KV('  行', JSON.stringify(r).slice(0, 200)));
    }
    const realmRows = safe(() => G.l10n.tableRows('enigma_secret_realm'), null) || [];
    KV('realm 行数', realmRows.length);
    if (realmRows.length) KV('首行字段', JSON.stringify(Object.keys(realmRows[0])));

    /* ── G. 结论 ─────────────────────────────────────────────── */
    H('G. 结论：v3 数据源是否成立');
    const c1 = shopFromTable.length > 0;
    const c2 = !!view && (view.points || []).length > 0;
    const c3 = !!(boss && boss.some((b) => b.pos && Number(b.pos.x) > 0));
    console.log('%c  ① 表格商店坐标: ' + (c1 ? '成立' : '不成立'), 'color:' + (c1 ? '#1a7f37' : '#c0392b') + ';font-weight:bold');
    console.log('%c  ② 901 主动视口: ' + (c2 ? '成立' : '不成立'), 'color:' + (c2 ? '#1a7f37' : '#c0392b') + ';font-weight:bold');
    console.log('%c  ③ BOSS 权威坐标: ' + (c3 ? '成立' : '不成立'), 'color:' + (c3 ? '#1a7f37' : '#c0392b') + ';font-weight:bold');
    if (c1 && c2 && c3) OK('三条全成立 → 可以按 v3 设计重写驾驶层（商店/BOSS 都不再依赖 10018 push）');
    else {
      const miss = [];
      if (!c1) miss.push('① 商店表');
      if (!c2) miss.push('② 901');
      if (!c3) miss.push('③ BOSS 坐标');
      NO('缺：' + miss.join(' / ') + ' → 把本段完整输出贴回，据此改数据源');
    }
    KV('总耗时', Date.now() - t0 + 'ms');
    return { shops: shopFromTable.length, points: view ? (view.points || []).length : -1, boss: boss ? boss.length : 0 };
  };

  console.log(
    '%c[pilot-snap] 已就位：输入 __pcPilotSnap() 直接验；__pcPilotSnap({wait:8000}) 先等 8 秒',
    'color:#0366d6;font-weight:bold',
  );
})();
