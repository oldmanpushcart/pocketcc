/**
 * 自动下田（auto-farm）「取田优先级 / 升级抢田」诊断探针
 * （DevTools 一次性粘贴运行；只读游戏数据，默认仅多发一条 856，可选再发少量 901/1034/906）
 *
 * 出处 feats/player/auto-farm/：priority.js（rank/allowedKinds/pickBest/findUpgrade）、
 *   index.js（时段闸、账本、upgradePass 闸门）、lvl6-scanner.js（遗迹池）、
 *   tower-scanner.js（机械田活表）、normal-scan.js（906 逐级降序）。
 *
 * 症状对照：面板日志出现
 *   「upgrade recall. row=.. old=.. new=..」过于频繁 → 抖（调 upgradeCooldownMs / upgradeMinDwellMs）
 *   完全不出「upgrade recall」→ 看 F 段哪道闸门一直不过（多数是 curRank 已顶格或候选池空）
 *   某行长期缺位（日志无 farm march ok）→ 看 F 段「缺位」子段的各来源候选与家族体检
 *
 * 探针不 import 生产模块（DevTools 里没有 ESM 上下文），所有口径就地复刻：
 *   rank = KIND_RANK[kind]*100 + level（遗迹 306 > 机械 2xx > 普通 1xx）；
 *   升级闸门 = 驻留 3min + 同行冷却 10min + 单拍 1 次 + 候选 rank 严格大于当前；
 *   时段闸 = 时段外仅 relicIgnoreWindow 时留 ['relic']，否则空（空 = 全撤 + 睡到下个起点）。
 *   上述常量若在 index.js cfg / priority.js 里改了，本探针需同步（见文件末 G 段核对提示）。
 *
 * 发包口径（严格只读；默认不开探测）：
 *   856 GET_ALL_MY_MARCH_INFO  —— 恒发 1 条，用于「账本条目是否真的还在途」交叉验证；
 *   901 GET_WORLD_INFO         —— opt.relicProbe 条（默认 1，0=关）：单点复验遗迹候选仍无主；
 *   901+1034 GET_TOWERINFO     —— 仅 opt.tower=true：复验机械候选存在性 + 驻军余量；
 *   906 WORLD_SEARCH_MONSTER   —— 仅 opt.normal=true：复刻普通田逐级降序探测。
 *   三者都会真正向服务器查询，但都不改变任何游戏状态。
 *
 * 用法（MAIN world 控制台，window.pocketcc 可见）：
 *   window.__afPriorityProbe()                       // 默认：本地打分 + 1 发 901
 *   window.__afPriorityProbe({ normal: true })       // 追加普通田 906 实探（每家族最多 5 发）
 *   window.__afPriorityProbe({ tower: true })        // 追加机械田 901+1034 实探
 *   window.__afPriorityProbe({ relicProbe: 0 })      // 完全不发 901，纯本地
 *
 * 分段：A 配置与时段闸 / B 账本↔856 在途核对 / C 遗迹池候选 / D 机械田活表候选 /
 *   E 普通田 906（可选）/ F 逐行判定（在途行→升级闸门；缺位行→首候选）/ G 结论与调参提示。
 */
(async function autoFarmPriorityProbe(optArg) {
  const PC = window.pocketcc;
  if (!PC || !PC.gameApi || !PC.gameApi.march || !PC.storage) {
    console.error(
      '[af-prio] window.pocketcc 未就绪（缺 gameApi.march / storage）：确认已加载扩展、已登录、MAIN world 上下文。',
    );
    return;
  }
  const opt = Object.assign({ normal: false, tower: false, relicProbe: 1 }, optArg || {});
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const KV = (k, v) => console.log('  ' + k + ':', v);
  const WARN = (m) => console.log('%c  ⚠ ' + m, 'color:#e05c5c');
  const OK = (m) => console.log('%c  ✓ ' + m, 'color:#7cb342');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v) => {
    const x = Number(v);
    return isFinite(x) ? x : 0;
  };
  const key = (o) => (o.x | 0) + ',' + (o.y | 0);
  const ago = (ms) => {
    if (!ms) return '(无)';
    const d = Date.now() - ms;
    return d < 0 ? '-' + Math.round(-d / 1000) + 's' : Math.round(d / 1000) + 's 前';
  };
  const left = (ms) => {
    const s = Math.round(ms / 1000);
    return s <= 0 ? '已过期' : '剩 ' + Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
  };

  // ── 生产口径复刻（改动需与 priority.js / index.js / 三个 scanner 同源）──────────────
  const KIND_RANK = { relic: 3, tower: 2, normal: 1 };
  const KIND_ORDER = ['relic', 'tower', 'normal'];
  const MAX_LEVEL = { relic: 6, tower: 6, normal: 5 };
  const MARCH_TYPE_OF = { relic: 3, tower: 26, normal: 3 };
  const MIN_DWELL_MS = 3 * 60 * 1000;
  const COOLDOWN_MS = 10 * 60 * 1000;
  const MAX_UPGRADE_PER_PASS = 1;
  const RELIC_FRESH_MS = 10 * 60 * 1000;
  const MECH_MIN_REMAIN_SEC = 10 * 60;
  const MECH_MAX_AGE_SEC = 10 * 3600;
  const TOWER_PREFIX = { 7: 51, 1: 52, 5: 53, 16: 71 };
  const rank = (k, lv) => (KIND_RANK[k] || 0) * 100 + (lv | 0);
  const maxRank = (k) => rank(k, MAX_LEVEL[k] || 0);
  const orderKinds = (ks) => KIND_ORDER.filter((k) => ks.indexOf(k) >= 0);
  /** kinds 直读（同 index.js normalizeRules：不做旧档 level/mechOnly 兼容，缺失即空 = 该行不下田） */
  const rowKinds = (r) => (Array.isArray(r && r.kinds) ? orderKinds(r.kinds.slice()) : []);

  const gm = PC.gameApi.march;
  const gd = PC.gameApi.gameData;
  const l10n = PC.gameApi.l10n;
  const srvNow = () => num(gd && gd.serverTime && gd.serverTime());
  const myPos = () => (gd && gd.myWorldPos ? gd.myWorldPos() : null);
  const myAid = num(gd && gd.myAid && gd.myAid());
  const serverK = () => (PC.gameApi.worldMap ? PC.gameApi.worldMap.serverId() : 0);
  const tbRow = (t, id) => (l10n && l10n.tableRow ? l10n.tableRow(t, id) : null);
  const send = async (cmd, body) => {
    if (!PC.net || typeof PC.net.send !== 'function') return null;
    try {
      const ret = await PC.net.send(cmd, body);
      const d = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data;
      return ret && ret.ok ? d || {} : null;
    } catch (e) {
      return null;
    }
  };

  // ── A. 配置与时段闸 ──────────────────────────────────────────────
  H('A. 配置 / 时段闸 / 规则行归一');
  KV('reactor.isRunning(autoFarm)', PC.reactor ? PC.reactor.isRunning('autoFarm') : '(无 reactor)');
  try {
    const ws = PC.worldState && PC.worldState.current ? PC.worldState.current() : null;
    if (ws) KV('worldState', { kind: ws.kind, place: ws.place, phase: ws.phase });
  } catch (e) {
    WARN('worldState 读取异常: ' + (e && e.message));
  }
  let R = {};
  try {
    R = (await PC.storage.get('pocketcc.feat.autoFarm')) || {};
  } catch (e) {
    WARN('配置读取异常（UID 命名空间未就绪？）: ' + (e && e.message));
  }
  const normMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const h = num(m[1]);
    const mi = num(m[2]);
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  };
  const ranges = arr(R.timeRanges)
    .map((r) => {
      const s = normMin(r && r.start);
      const e = normMin(r && r.end);
      return s == null || e == null ? null : { s, e };
    })
    .filter(Boolean);
  const winOn = !!(R.timeWindowEnabled && ranges.length);
  const nowMin = () => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  };
  const inWin = () => {
    if (!winOn) return true;
    const t = nowMin();
    for (const r of ranges) {
      if (r.s === r.e) return true;
      if (r.s < r.e ? t >= r.s && t < r.e : t >= r.s || t < r.e) return true;
    }
    return false;
  };
  const allowedGlobal = !winOn || inWin() ? KIND_ORDER.slice() : R.relicIgnoreWindow ? ['relic'] : [];
  KV('timeWindowEnabled / 有效时段数', { on: !!R.timeWindowEnabled, ranges: ranges.length });
  KV('timeRanges(分钟)', ranges);
  KV('relicIgnoreWindow', !!R.relicIgnoreWindow);
  KV('当前在时段内 / 全局允许种类', { inWin: inWin(), allowed: allowedGlobal });

  const rows = arr(R.rules).map((r, i) => ({
    idx: i,
    family: num(r && r.family) || 7,
    kinds: rowKinds(r),
    preset: num(r && r.preset) || 1,
    raw: r,
  }));
  const seenPreset = new Set();
  const dupPreset = [];
  rows.forEach((r) => {
    if (seenPreset.has(r.preset)) dupPreset.push(r.idx + '→#' + r.preset);
    seenPreset.add(r.preset);
  });
  KV(
    '规则行数',
    rows.length + (rows.length ? '（' + rows.map((r) => `#${r.idx} f${r.family} [${r.kinds.join('|') || '空'}] p${r.preset}`).join(' / ') + '）' : ''),
  );
  if (dupPreset.length) WARN('预设重复（归一化会改派到空位）：' + dupPreset.join(', '));
  rows.forEach((r) => {
    if (r.family === 16 && r.kinds.indexOf('relic') >= 0) WARN('行 ' + r.idx + ' 雷神家族仍勾了遗迹（归一化会剔除）');
  });
  const allowedOf = (row) => orderKinds(row.kinds.filter((k) => allowedGlobal.indexOf(k) >= 0));

  // ── 数据面：账本 / 856 / 两个持久化槽 ────────────────────────────
  let ledger = null;
  try {
    ledger = await PC.storage.data.get('autoFarm');
  } catch (e) {
    WARN('账本读取异常: ' + (e && e.message));
  }
  let l6Store = null;
  let twStore = null;
  try {
    l6Store = await PC.storage.slot.get('autoFarm.lvl6');
  } catch (e) {
    WARN('遗迹池读取异常: ' + (e && e.message));
  }
  try {
    twStore = await PC.storage.slot.get('autoFarm.tower');
  } catch (e) {
    WARN('机械活表读取异常: ' + (e && e.message));
  }
  const l6pool = l6Store && l6Store.v === 3 ? arr(l6Store.pool) : [];
  const twlist = twStore && twStore.v === 1 ? arr(twStore.list) : [];
  if (l6Store && l6Store.v !== 3) WARN('遗迹池版本=' + l6Store.v + '（生产只认 v3，整份作废）');
  if (twStore && twStore.v !== 1) WARN('机械活表版本=' + twStore.v + '（生产只认 v1，整份作废）');
  KV('遗迹池条目 / 已扫邮件(去重表)数', {
    pool: l6pool.length,
    scanned: l6Store && l6Store.scanned ? Object.keys(l6Store.scanned).length : 0,
  });
  KV('机械活表条目 / 扫描时刻', {
    list: twlist.length,
    scannedAt: twStore && twStore.scannedAt ? ago(twStore.scannedAt) : '(无)',
  });
  const l6Map = new Map(l6pool.map((e) => [key(e), e]));
  const twMap = new Map(twlist.map((e) => [key(e), e]));

  let marches = [];
  try {
    marches = (await gm.list()) || [];
  } catch (e) {
    WARN('856 行军列表拉取失败: ' + (e && e.message));
  }
  const marchById = new Map(marches.map((m) => [String(m.id), m]));
  KV('856 本人行军条数（全类型）', marches.length);

  /** 在途田种类反推（同 priority.inferKind） */
  const inferKind = (marchType, x, y) => {
    if ((marchType | 0) === MARCH_TYPE_OF.tower) return 'tower';
    const k = (x | 0) + ',' + (y | 0);
    if (l6Map.has(k)) return 'relic';
    if (twMap.has(k)) return 'tower';
    return 'normal';
  };
  /** 在途田等级反推（同 priority.inferLevel） */
  const inferLevel = (kind, x, y, itemId) => {
    if (kind === 'relic') return 6;
    const e = twMap.get((x | 0) + ',' + (y | 0));
    if (e && e.level) return e.level | 0;
    if (itemId) {
      const row = tbRow('RESOURCE', String(itemId));
      if (row && num(row.level)) return num(row.level);
    }
    return 0;
  };

  // ── B. 账本 ↔ 856 在途核对 ──────────────────────────────────────
  H('B. 账本 ↔ 856 在途核对（每行在途田的 kind/level/rank）');
  if (!ledger || typeof ledger !== 'object') {
    WARN('账本为空（未启用过 / 未读回）：F 段全部按「缺位」处理');
  } else {
    const ledRows = Object.keys(ledger);
    if (!ledRows.length) WARN('账本没有任何行键');
    ledRows.forEach((k) => {
      const idx = +k;
      const row = rows[idx];
      const arr1 = arr(ledger[k]);
      if (!arr1.length) return;
      const e = arr1[0] || {};
      const m = e.marchId ? marchById.get(String(e.marchId)) : null;
      const kind = e.kind || inferKind(e.marchType, e.x, e.y);
      const level = (e.level | 0) || inferLevel(kind, e.x, e.y, e.itemId);
      KV('行 ' + idx + (row ? '（f' + row.family + ' p#' + row.preset + '）' : '（行已不存在）'), {
        marchId: e.marchId,
        x: e.x,
        y: e.y,
        marchType: e.marchType,
        kind,
        level,
        rank: level ? rank(kind, level) : '(推不出→生产不换)',
        family: e.family,
        派出: ago(e.dispatchedAt),
        上次抢田: e.upgradedAt ? ago(e.upgradedAt) : '(无)',
        '856 在途': m
          ? m.type === e.marchType
            ? '是 type=' + m.type + ' state=' + m.state + '/' + m.stateName
            : 'type 不符 账本=' + e.marchType + ' 856=' + m.type
          : '否（已返程/推送缺失 → 下拍应由 856 销位）',
      });
      if (row && row.preset !== num(e.preset)) {
        WARN('行 ' + idx + ' 账本 preset=' + e.preset + ' ≠ 当前行 preset=' + row.preset + ' → 生产会销位（增删行后正常）');
      }
    });
  }

  // ── C. 遗迹池候选（autoFarm.lvl6, v3）───────────────────────────
  H('C. 遗迹池候选（4h 有效期，rank 恒 306）');
  const srv = srvNow();
  const wall = Date.now();
  const mp = myPos();
  /** 遗迹候选排序（同 lvl6-scanner.pick：无主优先 → expireTime 升 → 距本城） */
  const relicCands = (family) => {
    const out = [];
    l6pool.forEach((e) => {
      if (e.family !== family) return;
      if (num(e.blockedUntil) > wall) return;
      if (e.expireTime && srv && srv >= e.expireTime) return;
      out.push({ e, free: e.ownerId === '0', d: mp ? Math.abs(e.x - mp.x) + Math.abs(e.y - mp.y) : 0 });
    });
    out.sort((a, b) => (a.free ? 0 : 1) - (b.free ? 0 : 1) || num(a.e.expireTime) - num(b.e.expireTime) || a.d - b.d);
    return out;
  };
  const fams = Array.from(new Set(rows.map((r) => r.family)));
  let relicProbeBudget = num(opt.relicProbe);
  for (const fam of fams.length ? fams : [7, 1, 5]) {
    const all = l6pool.filter((e) => e.family === fam);
    const cs = relicCands(fam);
    const free = cs.filter((c) => c.free).length;
    KV('家族 f' + fam, {
      池内: all.length,
      可下: cs.length,
      其中无主: free,
      blocked: all.filter((e) => num(e.blockedUntil) > wall).length,
      已到期: all.filter((e) => e.expireTime && srv >= num(e.expireTime)).length,
    });
    if (!cs.length) {
      if (!all.length) WARN('f' + fam + ' 池内无该家族遗迹田 → 看邮件扫图（relicCycle 日志 relic scan mail=..）与 RESOURCE.resource_type 映射');
      continue;
    }
    console.table(
      cs.slice(0, 5).map((c) => ({
        坐标: key(c.e),
        rank: rank('relic', 6),
        无主: c.free ? '是' : '否',
        到期: c.e.expireTime ? left((num(c.e.expireTime) - srv) * 1000) : '(无)',
        距本城: c.d,
        入池: ago(c.e.ts),
        需复验: wall - num(c.e.ts) >= RELIC_FRESH_MS ? '是(901)' : '否',
      })),
    );
    // 可选单点复验：只对「无主且排序第一」发一条 901，判 pool 是否陈旧
    const first = cs.find((c) => c.free);
    if (first && relicProbeBudget > 0) {
      relicProbeBudget--;
      const d = await send(901, {
        x: first.e.x,
        y: first.e.y,
        k: serverK(),
        rid: 0,
        width: 1,
        height: 1,
        marchInfo: false,
        viewLevel: 1,
      });
      const p = d && arr(d.pointList)[0];
      if (!p) {
        WARN('901 复验 ' + key(first.e) + ' 无应答（网络/视口问题，生产 pick 遇 error 会本轮放弃该行）');
      } else {
        const r = p.r || {};
        const okPt = (p.pointType | 0) === 38;
        const okAid = !myAid || num(r.aid) === myAid;
        const okFree = r.ownerId == null || String(r.ownerId) === '0';
        KV('901 复验 ' + key(first.e), {
          pointType: p.pointType,
          itemId: r.itemId,
          aid: r.aid,
          本盟: okAid,
          ownerId: r.ownerId,
          无主: okFree,
          结论: okPt && okAid && okFree ? '可下' : '生产会判 gone（池内条目陈旧）',
        });
      }
    }
  }

  // ── D. 机械田活表候选（autoFarm.tower, v1）──────────────────────
  H('D. 机械田活表候选（10h 老化，rank = 200 + level）');
  const lifespanSec = (family, level) => {
    const pre = TOWER_PREFIX[family];
    const bid = pre ? pre * 1000 + (level | 0) : 0;
    const r = bid ? tbRow('MAP_BUILDING', bid) : null;
    return r ? num(r.duration) : 0;
  };
  /** 机械候选打分（同 tower-scanner.score：剩余存活降序 + 等级次键，全可查时剔 <10min） */
  const towerCands = (family) => {
    const out = [];
    twlist.forEach((c) => {
      if (c.family !== family) return;
      if (srv && num(c.ts) && srv - num(c.ts) > MECH_MAX_AGE_SEC) return;
      const life = lifespanSec(c.family, c.level);
      const hasLife = life > 0 && !!srv;
      out.push({ c, remain: hasLife ? num(c.ts) + life - srv : num(c.ts), hasLife });
    });
    let list = out;
    if (list.length && list.every((s) => s.hasLife)) list = list.filter((s) => s.remain >= MECH_MIN_REMAIN_SEC);
    list.sort((a, b) => b.remain - a.remain || b.c.level - a.c.level);
    return list;
  };
  for (const fam of fams.length ? fams : [7, 1, 5]) {
    const all = twlist.filter((e) => e.family === fam);
    const cs = towerCands(fam);
    KV('家族 f' + fam, {
      活表: all.length,
      可下: cs.length,
      最高等级: cs.length ? cs[0].c.level : 0,
      '最高 rank': cs.length ? rank('tower', cs[0].c.level) : 0,
    });
    if (!all.length) {
      WARN('f' + fam + ' 活表无该家族 → 看 1193 拉取（tower scan）与联盟记录 specId 文本解析');
      continue;
    }
    console.table(
      cs.slice(0, 5).map((s) => ({
        坐标: key(s.c),
        等级: s.c.level,
        rank: rank('tower', s.c.level),
        剩余: s.hasLife ? left(s.remain * 1000) : '(缺 MAP_BUILDING.duration)',
        建成: ago(num(s.c.ts) * 1000),
        并入: ago(num(s.c.seenAt)),
      })),
    );
    // 可选复验（opt.tower）：对剩余最久的候选发 901 判存在性 + 1034 判驻军余量，口径同 tower-scanner.verify
    if (opt.tower && cs.length) {
      const t = cs[0].c;
      const d = await send(901, {
        x: t.x,
        y: t.y,
        k: serverK(),
        rid: 0,
        width: 1,
        height: 1,
        marchInfo: false,
        viewLevel: 1,
      });
      const p = d && arr(d.pointList).find((q) => q && (q.x | 0) === (t.x | 0) && (q.y | 0) === (t.y | 0));
      if (!p) {
        WARN('901 复验 ' + key(t) + ' 无应答/无该点 → 生产判 gone（候选陈旧，下轮重扫 1193）');
      } else {
        const b = p.b || {};
        const bid = num(b.bid);
        const famOfBid = { 51: 7, 52: 1, 53: 5, 71: 16 }[Math.floor(bid / 1000)] || 0;
        const gone =
          (p.pointType | 0) !== 24 || num(b.st) !== 3 || (myAid && num(b.aid) !== myAid) || famOfBid !== fam;
        KV('901 复验 ' + key(t), {
          pointType: p.pointType,
          bid,
          bid家族: famOfBid,
          st: b.st,
          aid: b.aid,
          '本盟/已完成/家族匹配': gone ? '否（生产判 gone）' : '是',
        });
        if (!gone && b.id) {
          const td = await send(1034, { id: String(b.id) });
          const army = td ? num(td.army_size) : -1;
          const capRow = tbRow('MAP_BUILDING', bid);
          const cap = capRow ? num(capRow.force_capacity) : 0;
          KV('1034 驻军', {
            army_size: army,
            force_capacity: cap,
            结论: army < 0 ? '未知（生产不拦，交 902 兜底）' : cap - army > 0 ? '有余量，可下' : '已满，生产换下一候选（不拉黑）',
          });
        }
      }
    }
  }

  // ── E. 普通田 906 实探（可选，opt.normal）────────────────────────
  H('E. 普通田 906 逐级降序实探' + (opt.normal ? '' : '（已跳过；如需实探传 {normal:true}）'));
  /** 906 groupType：RESOURCE 行 id（家族 = floor(id/100)，等级取行 .level） */
  const groupType = (family, level) => {
    const rows2 = (l10n && l10n.tableRows ? l10n.tableRows('RESOURCE') : null) || [];
    for (const r of rows2) {
      const id = num(r && r.id);
      if (!id || Math.floor(id / 100) !== family) continue;
      if (num(r.level) !== level) continue;
      return id;
    }
    return 0;
  };
  const probe906 = async (family, level) => {
    const gid = groupType(family, level);
    if (!gid) return { err: '无 RESOURCE 行' };
    const d = await send(906, { minLevel: level, maxLevel: level, groupType: gid, pointType: 2 });
    if (!d) return { err: '无应答' };
    const pt = d.point || arr(d.pointList)[0];
    if (!pt) return { err: '空 point' };
    const r = pt.r || {};
    return {
      x: pt.x | 0,
      y: pt.y | 0,
      ownerId: r.ownerId,
      amount: num(r.amount),
      ok: (r.ownerId == null || String(r.ownerId) === '0') && num(r.amount) > 0,
    };
  };
  const normalBest = new Map();
  if (opt.normal) {
    for (const fam of fams.length ? fams : [7, 1, 5]) {
      const trace = [];
      let hit = null;
      for (let lv = MAX_LEVEL.normal; lv >= 1; lv--) {
        const r = await probe906(fam, lv);
        trace.push(lv + '级:' + (r.err ? r.err : r.ok ? key(r) + '(可下)' : key(r) + '(被占/空)'));
        if (r.ok) {
          hit = { x: r.x, y: r.y, level: lv, family: fam };
          break;
        }
      }
      normalBest.set(fam, hit);
      KV('家族 f' + fam + ' 906 结果', hit ? { 命中: key(hit), 等级: hit.level, rank: rank('normal', hit.level) } : '逐级全空');
      KV('探测轨迹', trace);
    }
  }

  // ── F. 逐行判定 ────────────────────────────────────────────────
  H('F. 逐行判定（在途行 → 升级闸门复演；缺位行 → 首候选 rank）');
  rows.forEach((row) => {
    const kinds = allowedOf(row);
    const arr1 = arr(ledger && ledger[row.idx]);
    const e = arr1[0] || null;
    console.log('%c\n--- 行 ' + row.idx + '：f' + row.family + ' kinds=[' + row.kinds.join('|') + '] p#' + row.preset + ' ---', 'color:#8a7fd0');
    KV('本行允许种类（∩ 时段闸）', kinds.length ? kinds : '空 → 本行本轮不下田，且时段外会撤田');
    if (!kinds.length) {
      WARN('闸门：allowedKinds 为空（下行时段未开 / 遗迹豁免未开）');
      return;
    }
    if (!e) {
      // 缺位：按 pickBest 顺序给出各来源首候选（本地打分；不考虑 taken，仅供看总量）
      KV('状态', '缺位（账本无条目）→ 生产走 pickBest 补派');
      const local = [];
      if (kinds.indexOf('relic') >= 0) {
        const c = relicCands(row.family).find((x) => x.free);
        local.push({ 来源: '遗迹', rank: c ? rank('relic', 6) : 0, 候选: c ? key(c.e) : '(无无主候选)', 需验: c ? '901' : '-' });
      }
      if (kinds.indexOf('tower') >= 0) {
        const c = towerCands(row.family)[0];
        local.push({
          来源: '机械',
          rank: c ? rank('tower', c.c.level) : 0,
          候选: c ? key(c.c) : '(活表无货)',
          需验: c ? '901+1034' : '-',
        });
      }
      if (kinds.indexOf('normal') >= 0) {
        const b = normalBest.get(row.family);
        local.push({
          来源: '普通',
          rank: opt.normal ? (b ? rank('normal', b.level) : 0) : '(未实探)',
          候选: opt.normal ? (b ? key(b) : '(逐级全空)') : '传 {normal:true} 实探',
          需验: '—(906 应答即校验)',
        });
      }
      console.table(local);
      return;
    }
    // 在途：闸门逐项
    const gates = [];
    const curKind = e.kind || inferKind(e.marchType, e.x, e.y);
    const curLevel = (e.level | 0) || inferLevel(curKind, e.x, e.y, e.itemId);
    const curRank = curLevel ? rank(curKind, curLevel) : 0;
    KV('当前田', {
      marchId: e.marchId,
      坐标: (e.x | 0) + ',' + (e.y | 0),
      kind: curKind,
      level: curLevel,
      rank: curRank || '(推不出 → 生产不换)',
      '856 在途': e.marchId && marchById.has(String(e.marchId)) ? '是' : '否',
      派出: ago(e.dispatchedAt),
    });
    if (!e.marchId) gates.push('✗ 账本无 marchId（904 无从发起）');
    const dwell = wall - num(e.dispatchedAt);
    if (dwell < MIN_DWELL_MS) gates.push('✗ 驻留不足 ' + Math.ceil((MIN_DWELL_MS - dwell) / 1000) + 's（upgradeMinDwellMs=3min）');
    else gates.push('✓ 驻留 ' + Math.round(dwell / 1000) + 's ≥ 3min');
    // upgradedAt / probedAt 已落盘到账本条目（跨 run / 刷新页仍生效），探针能直读
    const cool = wall - num(e.upgradedAt);
    gates.push(
      num(e.upgradedAt)
        ? (cool < COOLDOWN_MS ? '✗' : '✓') +
          ' 同行冷却 ' + Math.round(cool / 1000) + 's/' + Math.round(COOLDOWN_MS / 1000) + 's（上次抢田 ' + ago(e.upgradedAt) + '）'
        : '✓ 同行冷却：该行本版本从未抢过田',
    );
    gates.push(
      '906 计时 probedAt=' +
        (num(e.probedAt) ? ago(e.probedAt) : '从未') +
        '（生产：每行 ' + Math.round(num(R.upgradeProbeMs) || 300) + 's 一次、单拍最多 ' + (R.upgradeProbeMaxPerPass == null ? 1 : R.upgradeProbeMaxPerPass) + ' 行；探针为一次性实探，不受此限）',
    );
    if (MAX_UPGRADE_PER_PASS < 1) gates.push('✗ 单拍上限=0');
    if (!curRank) {
      gates.push('✗ 当前等级推不出 → 生产直接跳过（isForeignMarch / 旧账本缺字段）');
      KV('闸门', gates);
      return;
    }
    let better = null;
    for (const kind of kinds) {
      const mr = maxRank(kind);
      if (mr <= curRank) {
        gates.push('· ' + kind + '：天花板 rank=' + mr + ' ≤ 当前 ' + curRank + ' → 零发包跳过');
        continue;
      }
      if (kind === 'normal') {
        if (curKind !== 'normal') {
          gates.push('· normal：当前非普通田（906 只做同种类小级别提升）→ 跳过');
          continue;
        }
        const b = normalBest.get(row.family);
        if (!opt.normal) gates.push('· normal：需 906 实探（传 {normal:true} 才发）');
        else if (!b) gates.push('· normal：906 逐级全空（无可下普通田）');
        else if (rank('normal', b.level) <= curRank) gates.push('· normal：最高 ' + b.level + ' 级 rank=' + rank('normal', b.level) + ' ≤ 当前');
        else {
          gates.push('✓ normal：' + b.level + ' 级 x=' + key(b) + ' rank=' + rank('normal', b.level) + ' > 当前');
          if (!better) better = { kind: 'normal', level: b.level, x: b.x, y: b.y, rank: rank('normal', b.level) };
        }
        continue;
      }
      // peek 口径 = 该类天花板（生产用它做 rank 预筛）；pick 口径 = 真会复验并拿回的田（机械带 rank 反推的等级地板）
      const freeRelic = kind === 'relic' ? relicCands(row.family).find((c) => c.free) : null;
      const tw = kind === 'tower' ? towerCands(row.family) : null;
      const peekLevel =
        kind === 'relic' ? (freeRelic ? 6 : 0) : tw.reduce((m, x) => Math.max(m, x.c.level | 0), 0);
      if (!peekLevel) {
        gates.push('· ' + kind + '：本地打分无候选（池/活表无货）');
        continue;
      }
      if (rank(kind, peekLevel) <= curRank) {
        gates.push('· ' + kind + '：本地最高 rank=' + rank(kind, peekLevel) + ' ≤ 当前 → 不发探针');
        continue;
      }
      // 机械：生产只验「rank 严格高于当前」的塔（地板 = curRank - 200，跨种时为负→不限级），低于地板的不占 901 额度
      const floor = Math.max(0, curRank - (KIND_RANK[kind] || 0) * 100);
      const cheap = kind === 'relic' ? freeRelic : tw.find((x) => (x.c.level | 0) > floor);
      if (!cheap) {
        gates.push('· tower：天花板 ' + peekLevel + ' 级确实更高，但 aboveLevel=' + floor + ' 闸下无可验候选');
        continue;
      }
      const cl = kind === 'relic' ? 6 : cheap.c.level;
      gates.push('✓ ' + kind + '：本地 rank=' + rank(kind, cl) + ' > 当前（生产会发 ' + (kind === 'relic' ? '901' : '901+1034') + ' 复验）');
      if (!better) {
        better = { kind, level: cl, x: kind === 'relic' ? cheap.e.x : cheap.c.x, y: kind === 'relic' ? cheap.e.y : cheap.c.y, rank: rank(kind, cl) };
      }
    }
    KV('闸门明细', gates);
    if (better) {
      OK(
        '结论：会撤田抢 ' +
          better.kind +
          '(' +
          better.level +
          ') x=' +
          better.x +
          ' y=' +
          better.y +
          ' rank=' +
          better.rank +
          '（当前 ' +
          curRank +
          '）→ 撤后不钉目标，回城按新 rank 重取；抢不到则该点进 run 期黑名单',
      );
      WARN('注意：探针未做 ' + (better.kind === 'relic' ? '901' : '901+1034') + ' 派前复验，真机若日志无 recall 则多半是复验判 gone / 902 被拒');
    } else {
      KV('结论', '不换（isForeignMarch 或上述全部闸门未通过）');
    }
  });

  // ── G. 结论提示 ────────────────────────────────────────────────
  H('G. 调参提示 / 口径核对');
  KV('遗迹池整体', { pool: l6pool.length, scannedMail: l6Store && l6Store.scanned ? Object.keys(l6Store.scanned).length : 0 });
  KV('机械活表整体', { list: twlist.length, scannedAt: twStore && twStore.scannedAt ? ago(twStore.scannedAt) : '(无)' });
  console.log(
    '  若「有更优田却从不出 upgrade recall」：① 确认 F 段是否有 ✓ 但结论不换（说明是 isForeignMarch/推不出等级）；' +
      '② 若闸门列表全是「天花板 ≤ 当前」，那是正常（机械 6 级 = rank 206 已顶格）；' +
      '③ 若本地无候选，先查 C/D 段池/活表规模与家族体检。',
  );
  console.log(
    '  若「同一坐标反复撤/派抖动」：调大 index.js cfg.upgradeCooldownMs（当前 10min）或 upgradeMinDwellMs（当前 3min）；'
      + '两个时刻现在都落在账本条目 upgradedAt/dispatchedAt 上（跨 run 仍生效）；'
      + '本探针的 MIN_DWELL_MS/COOLDOWN_MS 是复刻值，生产改动后需同步此文件。',
  );
  console.log(
    '  若「906 发得太频繁」：升级探测走两层节流——每行 cfg.upgradeProbeMs（5min）+ 单拍 cfg.upgradeProbeMaxPerPass（1 行），'
      + '计时落在条目 probedAt（没撤成也计时）。',
  );
  console.log('  复跑入口：window.__afPriorityProbe({normal:true,tower:true,relicProbe:1})');
  window.__afPriorityProbe = (o) => autoFarmPriorityProbe(o);
})().catch((e) => console.error('[af-prio] 探针异常:', e));
