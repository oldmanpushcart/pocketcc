/**
 * 机械田自动建造（mechBuild）真机校准探针（DevTools 一次性粘贴运行）
 *
 * 目的：一次跑清 feat 计划「待真机实证」表的全部口径项，把首版兜底换成真机真相：
 *   A) MAP_BUILDING[bid] 行字段：duration（塔存活秒，feat 用它算剩余寿命）/ force_capacity /
 *      等级 / 是否有距离或联盟领地限制字段；顺带对同族不同等级扫一遍，验证「雷神 dur=2000 是否随等级变化」。
 *   B) 职业可建等级：Buff.getBuffDataById(buffId).Value 直接给的完整 bid，与经验兜底 {51:6,52:6,53:6,71:1} 对拍。
 *   C) armyId 权威来源：复刻 Battle().plan().minimal() 的「最低级可派遣部队」判据，逐族打印实际会用的 armyId，
 *      与建塔面板实发样本（粮 20096/20098、油 30097、雷神 10097）对拍。
 *   D) 空点判据 + 半径外拒绝：只读 901 扫本城附近，看无主资源田（pointType=4 / ownerId '0' / aid '0' /
 *      allianceAreaOwner 0）分布；可选（默认关）越界发一条 1033 读拒绝 code/tips，量化真实半径硬限。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏、处于主世界（world 场景），MAIN world 控制台上下文
 *   （window.pocketcc 可见）。A/B/C 段全程只读、零写发包；只有把顶部 D_OUT_OF_RADIUS_BUILD 置 true 才会
 *   真发一条 1033 建塔行军（有游戏副作用），默认关闭。
 *
 * 贴回：把 A/B/C/D 各段输出一起贴回即可据此把 feat 的兜底常量替换为真机值。
 */
(function mechBuildProbe() {
  // ── 可调开关 ────────────────────────────────────────────────────────
  /** @type {boolean} 是否越界真发一条 1033（危险：会在世界地图建一座真塔并派单兵；仅在校准半径硬限时开） */
  const D_OUT_OF_RADIUS_BUILD = false;
  /** @type {number} D 段只读 901 扫描半径（game 格），用于统计附近无主资源田分布 */
  const D_SCAN_RADIUS = 45;

  const PC = window.pocketcc;
  if (!PC || !PC.game || !PC.gameApi || !PC.net) {
    console.error('[mech-build-probe] window.pocketcc(.game/.gameApi/.net) 未就绪：确认已加载扩展、已登录、MAIN world 上下文。');
    return;
  }
  const { gameData, l10n, worldMap } = PC.gameApi;

  // 家族四元组（与 feat 同口径，dashcam 定死；此处只为遍历打印，不参与发包决策）
  const FAMILIES = [
    { family: 7, label: '金矿', prefix: 51, fieldGroup: 1, buffId: 1101001, sampleBid: 51006 },
    { family: 5, label: '粮食', prefix: 53, fieldGroup: 7, buffId: 1101003, sampleBid: 53006 },
    { family: 1, label: '石油', prefix: 52, fieldGroup: 5, buffId: 1101002, sampleBid: 52006 },
    { family: 16, label: '雷神', prefix: 71, fieldGroup: 16, buffId: 1101072, sampleBid: 71001 },
  ];
  const FALLBACK_LEVEL = { 51: 6, 52: 6, 53: 6, 71: 1 };
  const POINT_TYPE_FIELD = 4;

  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const brief = (v) => {
    if (v === null) return 'null';
    if (typeof v !== 'object') return String(v);
    try {
      return JSON.stringify(v);
    } catch (e) {
      return '(不可序列化)';
    }
  };

  // ── A) MAP_BUILDING 行字段 ─────────────────────────────────────────
  H('A. MAP_BUILDING 表：实证样本 bid 行 + 同族等级梯度扫描（duration/force_capacity/level/距离限制）');
  const dumpRow = (bid) => {
    let row;
    try {
      row = l10n.tableRow('MAP_BUILDING', bid);
    } catch (e) {
      row = null;
    }
    if (!row) {
      console.log('  bid=' + bid + ' → （MAP_BUILDING 查无此行或表未就绪）');
      return null;
    }
    const keep = {};
    ['id', 'name', 'duration', 'force_capacity', 'capacity', 'level', 'lv', 'hp', 'dur', 'range', 'distance', 'territory', 'profession', 'job', 'need_profession', 'res_type', 'resource'].forEach((k) => {
      if (row[k] !== undefined) keep[k] = row[k];
    });
    console.log('  bid=' + bid + ' 关注字段=', keep);
    if (Object.keys(keep).length === 0) console.log('    （无预设关注字段命中，整行 own keys:', Object.keys(row).join(','), '）');
    return row;
  };
  for (const f of FAMILIES) {
    console.log('%c家族 ' + f.label + '（前缀 ' + f.prefix + '）:', 'color:#e0a800');
    const base = dumpRow(f.sampleBid);
    if (base) console.log('    整行 JSON:', brief(base));
    // 同族 1..10 级梯度：看 duration 是否随等级变化（尤其雷神 71001..71010）
    const sweep = [];
    for (let lv = 1; lv <= 10; lv++) {
      const bid = f.prefix * 1000 + lv;
      let r;
      try {
        r = l10n.tableRow('MAP_BUILDING', bid);
      } catch (e) {
        r = null;
      }
      sweep.push({ bid, level: lv, exists: !!r, duration: r ? r.duration : null, force_capacity: r ? (r.force_capacity != null ? r.force_capacity : r.capacity) : null });
    }
    console.table(sweep);
  }

  // ── B) 职业可建等级 ────────────────────────────────────────────────
  H('B. 机械大师职业读数：Buff.getBuffDataById(buffId).Value = 本人可建完整 bid');
  for (const f of FAMILIES) {
    let viaACL;
    try {
      viaACL = gameData.buffValueById(f.buffId);
    } catch (e) {
      viaACL = '(抛:' + (e && e.message) + ')';
    }
    // 原始对象一并打印（Value 之外的字段可能对拍职业等级有用）
    let raw;
    try {
      const U = PC.game.get('DataCenter').DATA.UserData;
      const B = U && U.Buff;
      raw = B && typeof B.getBuffDataById === 'function' ? B.getBuffDataById(f.buffId) : null;
    } catch (e) {
      raw = '(读抛:' + (e && e.message) + ')';
    }
    const impliedLevel = viaACL && Math.floor(viaACL / 1000) === f.prefix ? viaACL % 1000 : null;
    const prefixOk = viaACL && Math.floor(viaACL / 1000) === f.prefix;
    console.log(
      '  ' + f.label + ' buff=' + f.buffId +
        ' → Value(bid)=' + brief(viaACL) +
        ' | 前缀匹配=' + (prefixOk ? '✔' : '✘(将回退经验等级 ' + FALLBACK_LEVEL[f.prefix] + ')') +
        ' | 隐含等级=' + (impliedLevel != null ? impliedLevel : '-') +
        ' | 兜底等级=' + FALLBACK_LEVEL[f.prefix],
    );
    if (raw && typeof raw === 'object') console.log('    原始 BuffData:', brief(raw));
  }

  // ── C) armyId 权威来源（复刻 minimal 判据）─────────────────────────
  H('C. armyId 权威来源：可派遣部队池 + minimal() 会选的「最低级可派遣」armyId');
  let U;
  try {
    U = PC.game.get('DataCenter').DATA.UserData;
  } catch (e) {
    U = null;
  }
  if (!U || typeof U.userArmyForEach !== 'function') {
    console.log('  UserData.userArmyForEach 不可用（符号漂移？）——无法枚举部队池。');
  } else {
    const pool = [];
    try {
      U.userArmyForEach((army) => {
        if (!army || !army.ArmyId) return;
        pool.push({
          armyId: army.ArmyId,
          level: (army.Data && army.Data.level) | 0,
          normal: !!army.Normal,
          canBattle: !!army.CanBattle,
          usable: (typeof U.getCanUseArmyLenByArmyId === 'function' ? U.getCanUseArmyLenByArmyId(army.ArmyId) : null),
        });
      });
    } catch (e) {
      console.log('  枚举抛:', e && e.message);
    }
    console.log('  部队池共 ' + pool.length + ' 支:');
    console.table(pool);
    // minimal() 判据：Normal && CanBattle 中 level 最低者（与 core/battle.js findLowestLevelAvailableArmy 同口径）
    const available = pool.filter((a) => a.normal && a.canBattle);
    let lowest = null;
    for (const a of available) if (!lowest || a.level < lowest.level) lowest = a;
    console.log(
      '%c  → minimal() 将派遣 armyId=' + (lowest ? lowest.armyId : '(无可用部队→派空)') +
        (lowest ? '（level=' + lowest.level + '）' : ''),
      'color:#7cb342;font-weight:bold',
    );
    console.log('  对拍实证样本：粮 20096/20098 · 油 30097 · 雷神 10097（若与上行不符，说明各族 armyId 并非同一「最低级」口径，需按族固化）。');
  }

  // ── D) 空点判据（只读 901）+ 半径外拒绝（可选）──────────────────────
  H('D. 落点：本城附近无主资源田（pointType=4）分布 + 可选越界 1033 拒绝码');
  const home = gameData.myWorldPos();
  console.log('  myWorldPos =', brief(home), '| myUid =', gameData.myUidStr(), '| serverTime =', gameData.serverTime());
  if (!home) {
    console.log('  拿不到本城坐标（不在 world 场景？）——D 段跳过。');
  } else {
    const k = worldMap.serverId() | 0;
    const body = { x: home.x, y: home.y, k, rid: 0, width: D_SCAN_RADIUS * 2 + 1, height: D_SCAN_RADIUS * 2 + 1, marchInfo: false, viewLevel: 1 };
    console.log('  发只读 901 k=' + k + ' 窗 ' + body.width + '×' + body.height + ' @(' + home.x + ',' + home.y + ') …');
    PC.net
      .send(901, body)
      .then((ret) => {
        if (!ret || !ret.ok) {
          console.log('  901 未 ok，code=' + brief(ret && ret.code));
          return;
        }
        let d = ret.data;
        if (typeof d === 'string') {
          try {
            d = JSON.parse(d);
          } catch (e) {
            d = {};
          }
        }
        const pts = (d && d.pointList) || [];
        const fields = pts.filter((p) => p && (p.pointType | 0) === POINT_TYPE_FIELD);
        const freeByGroup = {};
        for (const p of fields) {
          const r = p.r || {};
          const itemId = Number(r.itemId) || 0;
          const grp = Math.floor(itemId / 100);
          const owner = r.ownerId == null ? '0' : String(r.ownerId);
          const aid = r.aid == null ? '0' : String(r.aid);
          const areaOwner = Number(r.allianceAreaOwner) || 0;
          const free = (owner === '0' || owner === '') && (aid === '0' || aid === '') && areaOwner === 0;
          if (free) freeByGroup[grp] = (freeByGroup[grp] || 0) + 1;
        }
        console.log('  901 回点 ' + pts.length + ' 个，其中 pointType=4 资源田 ' + fields.length + ' 个');
        console.log('  无主可建田按 itemId 组（1金/5油/7粮/16雷神）计数:', brief(freeByGroup));
        console.log('  （itemId 组即 feat FIELD_GROUP_BY_FAMILY；某组计数=0 说明半径内该族无空地，会走 candidateCap 耗尽后 noop）');
        const sample = fields.slice(0, 5).map((p) => ({ x: p.x, y: p.y, itemId: p.r && p.r.itemId, ownerId: p.r && p.r.ownerId, aid: p.r && p.r.aid, allianceAreaOwner: p.r && p.r.allianceAreaOwner }));
        if (sample.length) {
          console.log('  前 5 个田点样本:');
          console.table(sample);
        }
      })
      .catch((err) => console.log('  901 抛:', err && err.message));

    if (D_OUT_OF_RADIUS_BUILD) {
      const far = { x: home.x + D_SCAN_RADIUS + 40, y: home.y };
      console.log('%c[D 危险] D_OUT_OF_RADIUS_BUILD=true → 向 (' + far.x + ',' + far.y + ') 越界发一条真实 1033（会建真塔！）读拒绝 code/tips…', 'color:#dc3545;font-weight:bold');
      const army = [{ pos: 1, armyId: 0, armyNum: 1 }]; // armyId 占位；被拒时不会用到，若意外成功需人工核对
      const b1033 = { marchType: 25, x: far.x, y: far.y, armyList: army, armyListNew: army, heroList: [], trapList: [], buildId: FAMILIES[0].sampleBid, formation: 0, skinId: 0, formationV2: 0 };
      PC.net
        .send(1033, b1033)
        .then((ret) => console.log('  越界 1033 → ok=' + (ret && ret.ok) + ' code=' + brief(ret && ret.code) + ' data=' + brief(ret && ret.data) + '（用 l10n.net(data) 可解 tips 文案）'))
        .catch((err) => console.log('  越界 1033 抛:', err && err.message));
    } else {
      console.log('  （半径外拒绝码未探：把顶部 D_OUT_OF_RADIUS_BUILD 置 true 才会真发 1033，谨慎。）');
    }
  }

  console.log('%c[mech-build-probe] 完成：A/B/C 段可离线定稿兜底常量；D 段确认空点判据分布，如需半径硬限再开 D_OUT_OF_RADIUS_BUILD。', 'color:#2aa198;font-weight:bold');
})();
