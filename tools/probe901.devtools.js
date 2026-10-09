// 权威占用探针：现拉 901 pointList（不受视口缓存易失影响），按 footprint 扩格判占用 + 堡垒领土，找真·最近合法落点
window.pocketcc.probe901 = async function (x, y, opts = {}) {
  const { gameApi } = window.pocketcc;
  const net = window.pocketcc.net;
  const gd = gameApi.gameData, g = gameApi.game, N = gameApi.nav;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const unwrap = n => { try { const m = g.get(n); return m && (m[n] || m.default || m); } catch { return null; } };
  const TYPE = { 0: 'Blank', 1: 'City', 2: 'Monster', 3: 'Occupy', 4: 'Resource', 10: 'Throne', 11: 'Boss', 12: 'RALLY_BOSS', 13: 'Territory', 14: 'ACTIVITY_BOSS', 15: 'WorldSite', 17: 'ALLIANCE_BOSS', 18: 'RefugeeCamp', 19: 'AirDrop', 20: 'ItemGetMonster', 23: 'DefenderMonster', 24: 'ResourceTower', 25: 'BuffTower', 26: 'WorldTreasure', 27: 'ALDefenderMonster', 28: 'SELF_MONSTER', 29: 'MILITARY_RESOURCE', 31: 'CountryBoss' };
  const BLOCK = new Set([1, 3, 10, 11, 12, 15, 17, 24, 25, 31]);            // 占用即不可落（城/王座/塔/BOSS/遗迹…）
  const anchor = { x: x | 0, y: y | 0 };
  const U = (() => { try { return g.get('DataCenter').DATA.UserData; } catch { return null; } })();
  const myAid = (() => { try { return (U.Alliance && (U.Alliance.Aid ?? U.Alliance.aid)) | 0; } catch { return 0; } })();
  const myPid = (() => { try { return U.id ?? U.pid ?? U.userId ?? U.uid ?? 0; } catch { return 0; } })();
  const svr = U.ServerId | 0, sub = U.subServerID | 0;
  const a = (() => { try { const s = gd.citySkinSize(U.UsingCastleFace); return (s | 0) || 2; } catch { return 2; } })();
  const fp = (t, o, L) => { L = L || a; const c = []; for (let s = 0; s < L; s++) for (let k = 0; k < L; k++) c.push({ x: t + s - k, y: o - s - k }); return c; };
  const Utils = unwrap('NWorldMapUtils');
  const cellIdx = (gx, gy) => Utils.getCellIndex(gx, gy, svr, sub);
  const TM = (() => { try { const m = unwrap('NWorldMapTerritoryModel'); return m && (m.instance || m); } catch { return null; } })();
  const margin = (opts.margin != null ? opts.margin | 0 : 1);
  const radius = (opts.radius | 0) || 12;
  const exact = info => { const w = info.w | 0, bw = info.bw | 0; const Slo = info.x + info.y - w + bw; const Dlo = info.x - info.y - w - bw + 2; return { Slo, Shi: Slo + 2 * (w - 1), Dlo, Dhi: Dlo + 2 * (w - 1) }; };
  const loadTerr = () => { const AT = (TM && TM.AllianceTerritory) || {}, t = []; for (const k in AT) { const i = AT[k]; if (i) t.push({ x: i.x, y: i.y, w: i.w | 0, bw: i.bw | 0, owner: i.owner | 0, buildId: i.buildId, eb: exact(i) }); } return t; };
  const viol = (t, gx, gy) => { const S = gx + gy, D = gx - gy; return Math.max(t.eb.Slo - S, S - t.eb.Shi, t.eb.Dlo - D, D - t.eb.Dhi, 0); };

  // 1) 现拉 901（中心=锚点；viewLevel=1 窗口 x±58/y±39 覆盖整带）
  try { N.flyTo({ x: anchor.x, y: anchor.y, z: 0, click: false }); } catch (e) { }
  await wait(300);
  const body = { x: anchor.x, y: anchor.y, k: svr, rid: 0, width: 116, height: 76, marchInfo: true, viewLevel: 1 };
  let ret, list = [], parseErr = null;
  try { ret = await net.send(901, body); } catch (e) { parseErr = 'send:' + e.message; }
  if (ret && ret.ok) { let d = ret.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } } list = (d && Array.isArray(d.pointList)) ? d.pointList : []; }
  else if (ret) parseErr = 'code:' + ret.code;

  // 2) 取 skinId（跨子对象兜底）与归属
  const skinOf = p => { if (p.skinId != null) return p.skinId; for (const s of ['p', 'b', 'r', 't', 'm']) if (p[s] && p[s].skinId != null) return p[s].skinId; return null; };
  const ownerOf = p => { for (const s of ['p', 'r', 'm', 't', 'b']) if (p[s] && (p[s].aid != null || p[s].allianceId != null)) return Number(p[s].aid || p[s].allianceId) || null; return null; };
  const pidOf = p => { for (const s of ['p', 'b', 'r', 't', 'm']) if (p[s] && (p[s].pid != null || p[s].ownerId != null)) return Number(p[s].pid || p[s].ownerId) || null; return null; };

  // 3) 由 901 构建权威占用集（footprint 扩格）：cellIdx → {pt, typeName, x, y, aid, pid, L}
  const occ = {}; let typeHist = {};
  for (const p of list) {
    const pt = p.pointType | 0; typeHist[TYPE[pt] || pt] = (typeHist[TYPE[pt] || pt] || 0) + 1;
    if (pt === 13) continue;                                     // 领土交由领土闸判，不算占地
    if (!BLOCK.has(pt)) continue;                               // 只把结构性占用计入阻塞（怪/资源田/空投等可覆盖）
    let L = 1; if (pt === 1) { const sk = skinOf(p); L = (sk != null ? gd.citySkinSize(sk) : 0) || 2; }
    const rec = { pt, typeName: TYPE[pt] || pt, x: p.x | 0, y: p.y | 0, aid: ownerOf(p), pid: pidOf(p), L };
    for (const c of fp(p.x | 0, p.y | 0, L)) { const ci = cellIdx(c.x, c.y); if (!occ[ci]) occ[ci] = rec; }
  }
  const isSelfOcc = rec => rec && (rec.aid && rec.aid === myAid || rec.pid && rec.pid === myPid);

  // 4) 三闸：canMoveCity(地形/游戏可落，false 必拦) + 901 占用 + 领土(margin)
  const EN = loadTerr().filter(t => t.owner > 0 && t.owner !== myAid);
  const judge = (gx, gy) => {
    const cm = gd.canMoveCity(gx, gy);
    const occHits = fp(gx, gy).map(c => { const r = occ[cellIdx(c.x, c.y)]; return r && !isSelfOcc(r) ? { ...c, by: r.typeName, src: { x: r.x, y: r.y }, aid: r.aid } : null; }).filter(Boolean);
    const terrHits = []; for (const c of fp(gx, gy)) { const t = EN.find(t => viol(t, c.x, c.y) <= margin); if (t) { terrHits.push({ ...c, owner: t.owner, from: { x: t.x, y: t.y }, viol: viol(t, c.x, c.y) }); break; } }
    return { cm, occ: occHits.length > 0, occHits, terr: terrHits.length > 0, terrHits, ok: cm === true && occHits.length === 0 && terrHits.length === 0 };
  };

  // 5) 三点权威复核 + 最近合法点搜索
  const known = [[413, 415], [412, 415], [413, 410]].map(([kx, ky]) => ({ pt: { x: kx, y: ky }, verdict: judge(kx, ky), rawPointsNear: list.filter(p => Math.abs((p.x | 0) - kx) <= 2 && Math.abs((p.y | 0) - ky) <= 2).map(p => ({ x: p.x | 0, y: p.y | 0, pt: TYPE[p.pointType | 0] || (p.pointType | 0), skinId: skinOf(p), aid: ownerOf(p), pid: pidOf(p), keys: Object.keys(p) })) }));
  const cand = []; for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) cand.push({ x: anchor.x + dx, y: anchor.y + dy, d: Math.abs(dx) + Math.abs(dy) });
  cand.sort((p, q) => p.d - q.d);
  // 两遍：先扫到第一个合法 spot 就停；再对所有「比 spot 更近且被拦」的格子按距离环归因，判断最近点是被领土压着还是被 cm(未加载) 误拦
  let spot = null; const judged = [];
  for (const c of cand) { const v = judge(c.x, c.y); judged.push({ x: c.x, y: c.y, d: c.d, v }); if (!spot && v.ok) spot = { x: c.x, y: c.y, dist: c.d }; if (spot && c.d > spot.dist) break; }
  const ringSummary = {}; const nearerBlocked = []; const cmOnlyCells = [];
  for (const j of judged) {
    if (j.v.ok || (spot && j.d >= spot.dist)) continue;
    const rs = ringSummary[j.d] || (ringSummary[j.d] = { total: 0, occ: 0, terr: 0, cmFalse: 0 });
    rs.total++; if (j.v.occ) rs.occ++; if (j.v.terr) rs.terr++; if (j.v.cm === false) rs.cmFalse++;
    if (nearerBlocked.length < 48) nearerBlocked.push({ x: j.x, y: j.y, d: j.d, cm: j.v.cm, occ: j.v.occ, terr: j.v.terr, viol: j.v.terrHits[0] ? j.v.terrHits[0].viol : null, from: j.v.terrHits[0] ? j.v.terrHits[0].from : null, why: (j.v.occ ? 'occ' : '') + (j.v.terr ? ' terr' : '') + (j.v.cm === false ? ' cmFalse' : '') });
    // 关键诊断：occ:false 且 terr:false，仅因 cm 返回非 true 而被拦 —— 这些是「本地没加载」的可疑格
    if (!j.v.occ && !j.v.terr && j.v.cm !== true) cmOnlyCells.push({ x: j.x, y: j.y, d: j.d, cm: j.v.cm });
  }

  // 领土点（901 pointType=13）原始字段全量 dump，用来验证能否直接从 901 复原禁迁菱形（不依赖易失的 AllianceTerritory 模型）
  const terrPts = list.filter(p => (p.pointType | 0) === 13).map(p => { const flat = {}; for (const k of Object.keys(p)) { const v = p[k]; flat[k] = (v && typeof v === 'object') ? Object.keys(v) : v; }
    const deep = {}; for (const k of Object.keys(p)) { const v = p[k]; if (v && typeof v === 'object') deep[k] = v; }
    return { x: p.x | 0, y: p.y | 0, flat, deep }; });
  return { anchor, myAid, myPid, svr, a, margin, radius, parseErr, pointCount: list.length, typeHist, occCellCount: Object.keys(occ).length, terrModelCount: loadTerr().length, spot, known, ringSummary, nearerBlocked, cmOnlyCells, territoryPoints: terrPts };
};
