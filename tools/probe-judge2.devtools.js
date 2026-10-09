window.pocketcc.probeJudge2 = async function (x, y, opts = {}) {
  const { gameApi } = window.pocketcc;
  const gd = gameApi.gameData,
    g = gameApi.game,
    N = gameApi.nav;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const unwrap = (n) => {
    try {
      const m = g.get(n);
      return m && (m[n] || m.default || m);
    } catch {
      return null;
    }
  };
  const TYPE = {
    0: 'Blank',
    1: 'City',
    2: 'Monster',
    3: 'Occupy',
    4: 'Resource',
    10: 'Throne',
    11: 'Boss',
    12: 'RALLY_BOSS',
    13: 'Territory',
    14: 'ACTIVITY_BOSS',
    15: 'WorldSite',
    17: 'ALLIANCE_BOSS',
    18: 'RefugeeCamp',
    19: 'AirDrop',
    20: 'ItemGetMonster',
    23: 'DefenderMonster',
    24: 'ResourceTower',
    25: 'BuffTower',
    26: 'WorldTreasure',
    27: 'ALDefenderMonster',
    28: 'SELF_MONSTER',
    29: 'MILITARY_RESOURCE',
    31: 'CountryBoss',
  };
  const COVERABLE = new Set([2, 4, 18, 19, 20, 23, 26, 27, 28]); // 可覆盖类；其余非零视为占用
  const anchor = { x: x | 0, y: y | 0 };
  const U = (() => {
    try {
      return g.get('DataCenter').DATA.UserData;
    } catch {
      return null;
    }
  })();
  const myAid = (() => {
    try {
      return (U.Alliance && (U.Alliance.Aid ?? U.Alliance.aid)) | 0;
    } catch {
      return 0;
    }
  })();
  const svr = U.ServerId | 0,
    sub = U.subServerID | 0;
  const myPos = (gd.myWorldPos && gd.myWorldPos()) || {
    x: U.WorldCoord && U.WorldCoord.x,
    y: U.WorldCoord && U.WorldCoord.y,
  };
  const a = (() => {
    try {
      const s = gd.citySkinSize(U.UsingCastleFace);
      return s | 0 || 2;
    } catch {
      return 2;
    }
  })();
  const fp = (t, o) => {
    const c = [];
    for (let s = 0; s < a; s++) for (let k = 0; k < a; k++) c.push({ x: t + s - k, y: o - s - k });
    return c;
  };
  const Utils = unwrap('NWorldMapUtils');
  const cellIdx = (gx, gy) => Utils.getCellIndex(gx, gy, svr, sub);
  const WM = unwrap('NWorldMapData') && unwrap('NWorldMapData').instance;
  const pf = WM && WM.placeFlags;
  const TM = (() => {
    try {
      const m = unwrap('NWorldMapTerritoryModel');
      return m && (m.instance || m);
    } catch {
      return null;
    }
  })();
  const margin = opts.margin != null ? opts.margin | 0 : 1;
  // 精确实心区（margin=0）：旋转系 S=x+y, D=x-y 的四界
  const exact = (info) => {
    const w = info.w | 0,
      bw = info.bw | 0;
    const Slo = info.x + info.y - w + bw;
    const Dlo = info.x - info.y - w - bw + 2;
    return { Slo, Shi: Slo + 2 * (w - 1), Dlo, Dhi: Dlo + 2 * (w - 1) };
  };
  const loadTerr = () => {
    const AT = (TM && TM.AllianceTerritory) || {},
      t = [];
    for (const k in AT) {
      const i = AT[k];
      if (i)
        t.push({
          x: i.x,
          y: i.y,
          w: i.w | 0,
          bw: i.bw | 0,
          owner: i.owner | 0,
          buildId: i.buildId,
          eb: exact(i),
        });
    }
    return t;
  };
  const viol = (t, gx, gy) => {
    const S = gx + gy,
      D = gx - gy;
    return Math.max(t.eb.Slo - S, S - t.eb.Shi, t.eb.Dlo - D, D - t.eb.Dhi, 0);
  }; // 0=在精确区内；>0=超出几格

  // 就绪门（对齐生产 makeJudge：靠原生 901 推送 settle 把整条候选带刷进本地，而非只看锚点邻格）
  const bus = window.pocketcc.bus;
  let lastPush = 0,
    pushSeen = 0,
    sample901 = null,
    samplePointKeys = null,
    samplePoint = null;
  const off901 =
    bus && bus.on
      ? bus.on('net.901', function (ev) {
          lastPush = Date.now();
          pushSeen++;
          try {
            const d = (ev && (ev.data != null ? ev.data : ev)) || null;
            if (d && !sample901) {
              sample901 = Object.keys(d);
              const pl = d.pointList || d.points || d.list || d.pl;
              if (pl && pl.length) {
                samplePointKeys = Object.keys(pl[0]);
                samplePoint = pl[0];
              }
            }
          } catch (e) {}
        })
      : null;
  let readyPf = false,
    terrCount = 0;
  try {
    const startSeen = pushSeen,
      t0 = Date.now(),
      maxWait = 9000,
      settleQuiet = 800;
    N.flyTo({ x: anchor.x, y: anchor.y, z: 0, click: false });
    // ① 等至少一个新 901 回包且锚点 canMoveCity 可读
    while (Date.now() - t0 < maxWait) {
      await wait(120);
      try {
        N.flyTo({ x: anchor.x, y: anchor.y, z: 0, click: false });
      } catch (e) {}
      if (pushSeen > startSeen && typeof gd.canMoveCity(anchor.x, anchor.y) === 'boolean') {
        readyPf = true;
        break;
      }
    }
    // ② 静默期：连续 settleQuiet 无新 901 → 认为整带刷完
    if (readyPf) {
      const tq = Date.now();
      while (Date.now() - tq < maxWait && Date.now() - lastPush < settleQuiet) await wait(100);
    }
    await wait(250);
    let near = 0;
    for (let dx = -7; dx <= 7; dx++)
      for (let dy = -7; dy <= 7; dy++)
        if (pf && pf.has && pf.has(cellIdx(anchor.x + dx, anchor.y + dy))) near++;
    readyPf = readyPf && near > 0;
    terrCount = loadTerr().length;
  } finally {
    if (off901) off901();
  }
  const pushSeenTotal = pushSeen;

  const EN = loadTerr().filter((t) => t.owner > 0 && t.owner !== myAid);
  const pfBlocked = (gx, gy) =>
    fp(gx, gy)
      .map((c) => {
        const fl = pf && pf.get(cellIdx(c.x, c.y));
        const own = myPos && c.x === myPos.x && c.y === myPos.y;
        return fl != null && fl !== 0 && !COVERABLE.has(fl | 0) && !own
          ? { ...c, type: TYPE[fl] || fl }
          : null;
      })
      .filter(Boolean);
  const terrHitAt = (m) => (gx, gy) => {
    const bad = [];
    for (const c of fp(gx, gy)) {
      const t = EN.find((t) => viol(t, c.x, c.y) <= m);
      if (t) {
        bad.push({
          ...c,
          owner: t.owner,
          from: { x: t.x, y: t.y },
          buildId: t.buildId,
          viol: viol(t, c.x, c.y),
        });
        break;
      }
    }
    return bad;
  };
  const judgeAt = (m) => (gx, gy) => {
    const cm = gd.canMoveCity(gx, gy);
    const sk = pfBlocked(gx, gy);
    const tr = terrHitAt(m)(gx, gy);
    return {
      cm,
      skinBlocked: sk.length > 0,
      terrBlocked: tr.length > 0,
      terrHits: tr,
      ok: cm === true && sk.length === 0 && tr.length === 0 && terrCount > 0,
    };
  };
  const judge = judgeAt(margin);

  const findSpot = (m) => {
    const J = judgeAt(m);
    const cand = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++)
        cand.push({ x: anchor.x + dx, y: anchor.y + dy, d: Math.abs(dx) + Math.abs(dy) });
    cand.sort((p, q) => p.d - q.d);
    for (const c of cand) {
      const v = J(c.x, c.y);
      if (v.ok) return { x: c.x, y: c.y, dist: c.d };
    }
    return null;
  };
  const radius = opts.radius | 0 || 14;
  const spot = findSpot(margin);
  const spotM0 = findSpot(0);

  // 最近诊断：按 d 排序列出前若干格，看每格栽在哪一闸 + 离敌堡垒精确区的越界格数
  const diag = [];
  {
    const cand = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++)
        cand.push({ x: anchor.x + dx, y: anchor.y + dy, d: Math.abs(dx) + Math.abs(dy) });
    cand.sort((p, q) => p.d - q.d);
    for (const c of cand) {
      if (diag.length >= 28) break;
      const v = judge(c.x, c.y);
      if (v.ok) continue;
      const near =
        EN.map((t) => ({
          from: { x: t.x, y: t.y },
          buildId: t.buildId,
          viol: Math.max(...fp(c.x, c.y).map((fc) => viol(t, fc.x, fc.y))),
        })).sort((p, q) => p.viol - q.viol)[0] || null;
      diag.push({
        x: c.x,
        y: c.y,
        d: c.d,
        cm: v.cm,
        skin: v.skinBlocked,
        terr: v.terrBlocked,
        nearestEnemyTerr: near,
      });
    }
  }

  const known = [
    [413, 415],
    [412, 415],
    [413, 410],
  ].map(([kx, ky]) => ({
    pt: { x: kx, y: ky },
    verdict: {
      cm: judge(kx, ky).cm,
      skin: judge(kx, ky).skinBlocked,
      terr: judge(kx, ky).terrBlocked,
      ok: judge(kx, ky).ok,
    },
    terrHits: terrHitAt(margin)(kx, ky),
    terrHitsM0: terrHitAt(0)(kx, ky),
  }));

  return {
    anchor,
    myAid,
    a,
    readyPf,
    terrCount,
    pushSeenTotal,
    margin,
    spot,
    spotM0,
    known,
    nearestBlockedDiag: diag,
    sample901Keys: sample901,
    samplePointKeys,
    samplePoint,
    enemyTerritoriesNear: loadTerr().filter(
      (t) =>
        t.x >= anchor.x - 14 &&
        t.x <= anchor.x + 14 &&
        t.y >= anchor.y - 14 &&
        t.y <= anchor.y + 14,
    ),
  };
};
