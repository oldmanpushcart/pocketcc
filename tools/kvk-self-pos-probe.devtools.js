/**
 * 天梯/夺宝奇兵「我的主城坐标 + 服号」一次性对拍探针（DevTools 粘贴即自动跑，主动只读查询）
 *
 * 用法（关键）：在【城已主动跨区迁到战场区（如 4337）、正在交战、且感觉 TAB 乱跳】的那一刻，
 *   MAIN world 控制台（window.pocketcc 可见）整段粘贴 → 会自动跑完 A–F 并打印。无需手动平移/再调函数。
 *   交战结束回老家后再跑只会一切正常，抓不到 bug 态。
 *
 * 要回答的问题：本地 WorldCoord / selfServerId / UserData.ServerId 是否跟随「跨区迁城」？
 *   服务端权威（909 自查询 + 630 自查询）把城点报在哪个 k？这张图的 serverMatrix 铺了哪几个区（k 决定落点）？
 *
 * 只读红线：仅发 909/630 两个「查坐标」只读包（不改写任何本地数据），其余全是本地读。
 *
 * 判读（把输出整段贴回即可）：
 *   - 若 909/630 把 self 城点报在 4337，而本地 WorldCoord 仍是老家(如 346,488)@selfServerId=4336
 *       ⇒ 本地源不跟随跨区迁城 → fly-home/auto-defense 必须改以服务端权威(909)坐标 + 其 k 为锚。
 *   - 若本地 WorldCoord 已=战场坐标，只是 selfServerId 仍=4336 而 909 的 k=4337
 *       ⇒ 纯 z 取错 → fly-home 的 z 改取 909/630 权威 serverId（或 viewServerId，视战场态）。
 *   - serverMatrix 若同时含 4336 与 4337 ⇒ 同一张连续图、k 决定区域偏移；否则是两套独立图实例。
 */
(async function kvkSelfPosProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi) {
    console.error('[kvk-self-pos-probe] window.pocketcc 未就绪：确认已加载扩展、已登录、MAIN world 上下文。');
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const KV = (k, v) => console.log('  ' + k + ':', v);
  const { worldMap, gameData, scene } = PC.gameApi;
  const SELF_UID = gameData.myUidStr ? gameData.myUidStr() : '';
  const SELF_PID = String(gameData.myPid ? gameData.myPid() : '');

  // ── A. 交战态确认 ────────────────────────────────────────────────
  H('A. 世界态（确认此刻在不在战场图）');
  try {
    const st = PC.worldState && PC.worldState.current ? PC.worldState.current() : null;
    if (st) { KV('kind', st.kind); KV('place', st.place); KV('phase', st.phase); KV('crossMap', st.crossMap); }
    else KV('worldState', '(不可用)');
  } catch (e) { KV('worldState 异常', e && e.message); }
  KV('scene.name', scene && scene.name ? scene.name() : '(n/a)');
  KV('自身 UID', SELF_UID + ' (pid=' + SELF_PID + ')');

  // ── B. 本地标量并排（fly-home / auto-defense 实际消费的源）─────────
  H('B. 本地「我的坐标 + 服号」读数');
  const local = { wp: null, selfK: 0, userK: 0, viewK: 0, sub: 0, mapType: 0 };
  try {
    local.wp = gameData.myWorldPos();
    local.selfK = worldMap.selfServerId();
    local.userK = worldMap.serverId();
    local.viewK = worldMap.viewServerId();
    local.sub = gameData.subServerId();
    local.mapType = worldMap.mapType();
    KV('WorldCoord (gameData.myWorldPos) ← fly-home 的 x,y / 防御 me 锚', local.wp);
    KV('selfServerId()  ← fly-home 的 z', local.selfK);
    KV('serverId() (=UserData.ServerId)  ← auto-defense 的 serverId()', local.userK);
    KV('viewServerId()  ← 镜头在看哪个区', local.viewK);
    KV('subServerId()', local.sub);
    KV('mapType()', local.mapType);
  } catch (e) { KV('B 异常', e && e.message); }

  // ── C. UserData 相关字段浅扫（找有没有另一套跨服坐标字段）──────────
  H('C. UserData 关键字段（primitive 值 + 含 x/y 的对象）');
  try {
    const ud = PC.game.get('DataCenter').DATA.UserData || {};
    const KEYS = ['UID', 'ServerId', 'CurrServerId', 'OriginServerId', 'RegisterServerId', 'subServerID',
      'WorldCoord', 'CurServerId', 'worldId', 'WorldId', 'mapType', 'MapType'];
    const dumpKey = (k) => {
      const v = ud[k];
      if (v == null) return;
      if (typeof v === 'object') {
        if (typeof v.x === 'number' && typeof v.y === 'number') KV('UserData.' + k, { x: v.x, y: v.y });
        else KV('UserData.' + k, typeof v);
      } else KV('UserData.' + k, v);
    };
    KEYS.forEach(dumpKey);
    // 额外扫一遍所有 primitive，抓名字里带 coord/server/city/k 的漏网字段
    const pat = /(coord|server|city|world|kvk|cross|origin|register|curr)/i;
    Object.keys(ud).forEach((k) => {
      if (KEYS.includes(k)) return;
      const v = ud[k];
      if ((typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') && pat.test(k)) KV('UserData.' + k + '（扫描命中）', v);
    });
  } catch (e) { KV('C 异常', e && e.message); }

  // ── D. serverData / serverMatrix：这张图铺了哪几个区（k 决定落点）──
  H('D. serverData.serverMatrix（本图区域布局）');
  try {
    const m = PC.game.get('NWorldMapData');
    const C = m && (m.NWorldMapData || m.default || m);
    const inst = C && (C.instance || C);
    const sd = inst && inst.serverData;
    if (!sd) KV('serverData', '(取不到，符号漂移？)');
    else {
      KV('serverData.selfServerId', sd.selfServerId);
      KV('serverData.currentServerId', sd.currentServerId);
      const mx = sd.serverMatrix;
      let keys = [];
      if (mx instanceof Map) keys = [...mx.keys()];
      else if (mx) keys = Object.keys(mx);
      KV('serverMatrix 区号列表（前 40 个）', keys.slice(0, 40).join(', '));
      KV('serverMatrix 区数', keys.length + (keys.includes(4336) ? '  含4336' : '') + (keys.includes(4337) ? '  含4337' : ''));
    }
  } catch (e) { KV('D 异常（不影响主判读）', e && e.message); }

  // ── E. 服务端权威 self 城点：909 自查询 + 630 自查询 ───────────────
  H('E. 服务端权威「我的城在哪」');
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ __timeout: true }), ms))]);
  const extract = (d) => {
    if (!d) return null;
    const cand = d.point || d.info || d.playerInfo || d;
    const o = typeof cand === 'string' ? (() => { try { return JSON.parse(cand); } catch (e) { return null; } })() : cand;
    if (!o) return null;
    const x = o.x != null ? o.x : o.tileX;
    const y = o.y != null ? o.y : o.tileY;
    const k = o.k != null ? o.k : o.serverId != null ? o.serverId : o.sid;
    return x != null && y != null ? { x, y, k } : null;
  };
  // 909 GET_PLAYER_POINT：targetId 必须字符串
  try {
    const r909 = await withTimeout(PC.net.send(909, { targetId: String(SELF_UID) }), 8000);
    const d909 = r909 && (r909.__timeout ? null : r909.data);
    console.log('  909 self 原始 code=', r909 && r909.__timeout ? 'TIMEOUT' : r909 && r909.code, ' data=', JSON.stringify(d909).slice(0, 600));
    KV('909 self 城点(解析)', extract(d909));
  } catch (e) { KV('909 异常', e && e.message); }
  // 630 PLAYER_INFO：注意转服场景可能回注册服（历史坑），故与 909 互为交叉验证
  try {
    const r630 = await withTimeout(PC.net.send(630, { uid: String(SELF_UID) }), 8000);
    const d630 = r630 && (r630.__timeout ? null : r630.data);
    const pi = d630 && typeof d630.playerInfo === 'string' ? JSON.parse(d630.playerInfo) : (d630 && d630.playerInfo) || d630;
    console.log('  630 self 原始 code=', r630 && r630.__timeout ? 'TIMEOUT' : r630 && r630.code, ' playerInfo=', JSON.stringify(pi).slice(0, 600));
    KV('630 self 城点(解析)', extract(pi));
  } catch (e) { KV('630 异常', e && e.message); }

  // ── F. 综合结论 ──────────────────────────────────────────────────
  H('F. 综合结论（把 A–E 原文贴回即可定案）');
  const viewIsBattle = local.viewK && String(local.viewK) !== String(local.userK);
  if (local.wp) {
    console.log(
      '  本地: WorldCoord=(' + local.wp.x + ',' + local.wp.y + ') selfK=' + local.selfK + ' userK=' + local.userK + ' viewK=' + local.viewK,
    );
  }
  console.log('  ' + (viewIsBattle
    ? 'viewServerId(' + local.viewK + ') ≠ UserData.ServerId(' + local.userK + ') → 镜头在别的区，重点看 E 段服务端把城报在哪个 k。'
    : 'viewServerId==ServerId(' + local.userK + ') → 若你确认城已在战场区，请核对 E 段服务端 k 是否≠本地 k（≠即本地不跟随跨区迁城）。'));
  console.log(
    '%c  ★ 若本地 WorldCoord/selfK 指老家、而 E 段 909/630 把城报在战场区(如 4337) ⇒ 坐实「本地源不跟随跨区迁城」，\n'
      + '     fly-home/auto-defense 须改用服务端权威坐标 + 其 k 为锚（630 若与 909 不一致则以 909 为准，规避转服注册服坑）。',
    'color:#3aa655',
  );
})();
