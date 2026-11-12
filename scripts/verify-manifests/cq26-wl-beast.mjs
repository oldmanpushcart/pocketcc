/**
 * CQ26 冰原巨熊 feat · 录制仿真对拍 Manifest（攻打线首次建基线）。
 *
 * 与 cq26-train / radar-task 同层：只声明本 feat 的协议号、现场态与闸门规则，
 * 读录制、二分回溯、应答配对、报告打印、退出码全交给 scripts/replay/。
 *
 * 运行：node scripts/replay/run.mjs --manifest cq26-wl-beast [录制...] [--verbose]
 *
 * 校验维度（真人录制对齐 feat 同一份协议字典）：
 *   2125 载荷逐键形态（HARD）：体 {wastelandIndex,troop} 两键 / troop 键集 ⊆ {heroList,armyPosList,
 *     formationV2,extraArmyPos} / armyPosList 行恰三键 {pos,armyId,armyNum} 且 pos ∈ 战斗位集合 /
 *     heroList 行仅 {heroId} / extraArmyPos 若存在必 pos=0（实录 2125 troop **不带** heroCap/skinId，
 *     feat 的 toTroop 投影同样只出三键——多一键少一键都是 FAIL）
 *   即时结算不变量（HARD）：每条 2125 前后 ±2s 内不得出现 902（攻打**不另发独立 902 行军包**的实录依据；
 *     注：2125 仍会占一个 myMarchNum 行军队列名额，但那是服务端侧名额、报文不可观测，由 feat 的 canMarch 闸控）
 *   wastelandIndex 真值闸（HARD，仅当录制里确有 317 视口行时判定）：发包时刻回查最近一条 901 resp /
 *     10018 push，317 行的 m.specIndex 集必须含该 wastelandIndex（真人「点的就是这块地」的对偶验证）
 *   发现腿 2111 一致性（HARD）：把录制里每份 2111 resp 的 wastelandList 喂给 **feat 自己的
 *     candidateBeasts**（同一份字典、不另抄），产出的 BOSS_SKILL+OPENING 分区集必须含真人实际攻打的那个
 *     wastelandIndex（feat 改版后「不切图、只靠 2111 枚举」的核心不变量）
 *   地块形态契约（SOFT）：录制里 317 行 m 键须含 specIndex/type/expireTime（仅作真值形态观测，发现腿已不依赖）
 *   通道（HARD）：2124/2125 req 恒 dir='req:sendPBV2'
 *   应答与节奏（观察）：配对率、isOk、isOk 非真笔数、同点重复攻打间隔（真人可连撞，feat 改为当日一次）。
 *
 * 协议字典来源：本 feat 是单文件浏览器模块，radar-task 式「最小桩化浏览器全局后动态 import」
 *   取常量与纯函数（toTroop/candidateBeasts），判据不另抄一份字典。
 *
 * dir 实测（写判据前已探针核对 .reviewtmp/bz-manifest-probe.mjs，避免不可达分支）：
 *   2124×18 / 2125×4 的 req 恒 dir='req:sendPBV2'；317 行只在 901 的 **resp**（body.pointList）与
 *   10018 push（body.pointInfos）里出现；内核 writes.req 走 raw.data，sendPBV2 无业务槽间接（坑 5 不适用），
 *   本 manifest 仍自建写视图（reqPending）以便把 req↔resp 合并成一条并保留 troop 结构。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON, snapshotAt } from '../replay/reader.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEAT = path.join(ROOT, 'extension/src/feats/cq26/wl-beast.js');

// ── 最小桩化浏览器全局（feat import 期需要，判据函数体不触碰）────────────
globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
  document: {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.chrome = globalThis.chrome || {
  runtime: { id: 'test', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};

// ── 协议字典 + 纯函数：与 feat 共用同一份，判据不另起炉灶 ──────────────────
const C = await import(pathToFileURL(FEAT).href);
const { CMD_ATTACK, CMD_INFO, CMD_WORLD_INFO, POINT_TYPE_BEAST, toTroop, candidateBeasts } = C;
if (typeof toTroop !== 'function' || typeof candidateBeasts !== 'function')
  throw new Error('feat 导出面缺 toTroop/candidateBeasts（判据字典与 feat 分叉，拒绝跑）');

/** 902 MARCH_WORLD_POINT（即时结算不变量：2125 不另发独立 902 行军包） */
const CMD_MARCH = 902;
/** feat core/battle.js toBattlePos 的合法战斗位（0 起格 → 1/2/3、11/12/13、21/22/23） */
const BATTLE_POS = new Set([1, 2, 3, 11, 12, 13, 21, 22, 23]);
/** 实录 2125 troop 的四键全集（extraArmyPos 仅在有额外部队时出现 ⇒ 键集允许其缺席） */
const TROOP_KEYS = ['heroList', 'armyPosList', 'formationV2', 'extraArmyPos'];

/**
 * 按键名升序拼串（逐键一致的判据表达成字符串相等，样本可直接肉眼比对）。
 * @param {object} o 载荷
 * @returns {string} 如 `troop|wastelandIndex`
 */
function keysOf(o) {
  return o && typeof o === 'object' ? Object.keys(o).sort().join('|') : '';
}

export default {
  id: 'cq26-wl-beast',
  defaultRecs: [
    // 最新现场（串行改版依据）：2125 idx7 ok → 4s 后 idx10 被 code 3「队列条件不满足」拒（实证 2125 占行军队列）+ 2111×6
    'dashcam/store/rec/11981629951662/dashcam-rec-20261112T011559-11981629951662-1794417359392.part.ndjson',
    // 发现腿改版主样本（已定稿重命名）：2111 + 多条 2125（wastelandIndex 7 isOk 1/0/1）+ 2124 + 901/10018 里的 317 行
    'dashcam/store/rec/11981629951662/dashcam-rec-20261112T003043-印石-我的日常.ndjson',
    // 旧现场（wastelandIndex 7/10 各一条 2125，isOk 均 1）：troop 形态与即时结算不变量的历史基线
    'dashcam/store/rec/11981629951662/dashcam-rec-20261111T103355-印石-我的日常.ndjson',
  ],

  // ── 现场态重建：单遍扫录制，317 地块时间线 + req↔resp 合并的写视图 ────────
  async buildScan(recPath) {
    /** 317 地块快照时间线（按 ts 升序）：{ts, tiles:[{idx,type,expireTime}]} */
    const tileTimeline = [];
    /** 2111 发现快照时间线（按 ts 升序）：{ts, idxs:[BOSS_SKILL+OPENING 分区号], total:分区行数} */
    const beastLands = [];
    /** 902 发包时刻序列（即时结算不变量用） */
    const marchTs = [];
    /** 写视图：reqTs -> {t,cmd,idx,troopKeys,…}，应答字段就地合并到同一条 */
    const reqPending = new Map();
    /** 线上出现过的 2125 总笔数（含内核 isWrite 之外的形态观察基准） */
    let attackCount = 0;

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => e.cmd === CMD_ATTACK,
        onEntry: (e) => {
          // ① 现场态源先行分派（901 的 pointList 只在 resp、10018 在 push，两路都要吃）
          if (
            (e.cmd === 901 && e.dir === 'resp') ||
            (e.cmd === 10018 && (e.dir === 'push' || e.dir === ''))
          ) {
            const list = e.body && (e.body.pointList || e.body.pointInfos);
            if (Array.isArray(list)) {
              const tiles = list.filter(
                (p) => p && Number(p.pointType) === POINT_TYPE_BEAST && p.m,
              );
              if (tiles.length) {
                tileTimeline.push({
                  ts: e.ts,
                  tiles: tiles.map((p) => ({
                    idx: Number(p.m.specIndex),
                    type: Number(p.m.type),
                    expireTime: Number(p.m.expireTime),
                    mKeys: keysOf(p.m),
                  })),
                });
              }
            }
            return;
          }
          if (e.cmd === CMD_WORLD_INFO && e.dir === 'resp') {
            // 发现腿真值：把这份 2111 的 wastelandList 喂给 feat 自己的 candidateBeasts，看它选出的分区
            const list = e.body && e.body.wastelandList;
            if (Array.isArray(list)) {
              const cands = candidateBeasts(list, Math.floor(Number(e.ts) / 1000));
              beastLands.push({ ts: e.ts, idxs: cands.map((c) => c.idx), total: list.length });
            }
            return;
          }
          if (e.cmd === CMD_MARCH && e.dir.startsWith('req')) {
            marchTs.push(e.ts);
            return;
          }
          // ② 写视图：req 建条目、resp 按 rt 合并到同一条
          if (e.dir.startsWith('req') && (e.cmd === CMD_ATTACK || e.cmd === CMD_INFO)) {
            const b = e.body || {};
            const rec = {
              t: e.ts,
              cmd: e.cmd,
              dir: e.dir,
              bodyKeys: keysOf(b),
              idx: Number(b.wastelandIndex),
            };
            if (e.cmd === CMD_ATTACK) {
              attackCount++;
              const tr = b.troop || null;
              rec.troopKeys = keysOf(tr);
              rec.armyRows = tr && Array.isArray(tr.armyPosList) ? tr.armyPosList : [];
              rec.heroRows = tr && Array.isArray(tr.heroList) ? tr.heroList : [];
              rec.formationV2 = tr ? tr.formationV2 : null;
              rec.extra = tr ? tr.extraArmyPos : undefined;
              rec.armyRowKeys = [...new Set(rec.armyRows.map((a) => keysOf(a)))].sort();
              rec.heroRowKeys = [...new Set(rec.heroRows.map((h) => keysOf(h)))].sort();
            }
            reqPending.set(e.ts, rec);
            return;
          }
          if (e.dir === 'resp' && (e.cmd === CMD_ATTACK || e.cmd === CMD_INFO)) {
            const head = e.header || (e.outer && e.outer.header) || null;
            const rec = reqPending.get(e.rt);
            if (!rec) return;
            rec.code = head && head.s != null ? Number(head.s) : null;
            rec.respKeys = keysOf(e.body || {});
            rec.isOk = e.body ? e.body.isOk : undefined;
            rec.fightValue = e.body ? e.body.fightValue : undefined;
          }
        },
      },
    );

    tileTimeline.sort((a, b) => a.ts - b.ts);
    beastLands.sort((a, b) => a.ts - b.ts);
    marchTs.sort((a, b) => a - b);
    const reqs = [...reqPending.values()];
    return {
      writes,
      respByReqTs,
      total,
      parseErr,
      minTs,
      maxTs,
      dirCounts,
      pairedResp: respByReqTs.size,
      uid: path.basename(path.dirname(recPath)),
      tileTimeline,
      beastLands,
      marchTs,
      attackCount,
      attackReqs: reqs.filter((x) => x.cmd === CMD_ATTACK),
      infoReqs: reqs.filter((x) => x.cmd === CMD_INFO),
    };
  },

  // ── 判据 ──────────────────────────────────────────────────────────────
  runVerify(S, rep) {
    const D1 = '载荷逐键形态';
    const D2 = '即时结算不变量';
    const D3 = 'wastelandIndex 真值闸';
    const D4 = '地块形态契约';
    const D5 = '发送通道与链路';
    const D6 = '应答与节奏（观察）';
    const D7 = '发现腿 2111 一致性';

    const attacks = S.attackReqs;
    if (!attacks.length) {
      // 无样本闸门：绝不以空集冒充通过（伪 PASS 红线）
      rep.check('本场无 2125 写样本，不判定', D1, 0, 0, 1, []);
      rep.check('本场无 2125 写样本，不判定', D3, 0, 0, 1, []);
      return;
    }

    // D1 troop 投影逐键形态（HARD）：feat 的 toTroop 与真人录制必须同形
    let pass = 0;
    let fail = 0;
    const samples = [];
    for (const a of attacks) {
      const bad = [];
      if (a.bodyKeys !== 'troop|wastelandIndex') bad.push('body 键=' + a.bodyKeys);
      if (!(a.idx > 0)) bad.push('wastelandIndex=' + a.idx);
      const tk = TROOP_KEYS.filter((k) => (a.troopKeys || '').split('|').includes(k))
        .sort()
        .join('|');
      if (tk !== a.troopKeys) bad.push('troop 键=' + a.troopKeys);
      if (!a.armyRows.length) bad.push('armyPosList 空');
      for (const k of a.armyRowKeys) if (k !== 'armyId|armyNum|pos') bad.push('army 行键=' + k);
      for (const r of a.armyRows) {
        if (!BATTLE_POS.has(Number(r.pos))) bad.push('pos=' + r.pos);
        if (!(Number(r.armyNum) > 0)) bad.push('armyNum=' + r.armyNum);
      }
      for (const k of a.heroRowKeys) if (k !== 'heroId') bad.push('hero 行键=' + k);
      if (!Number.isFinite(Number(a.formationV2))) bad.push('formationV2=' + a.formationV2);
      if (a.extra !== undefined) {
        if (keysOf(a.extra) !== 'armyId|armyNum|pos' || Number(a.extra.pos) !== 0) {
          bad.push('extraArmyPos=' + JSON.stringify(a.extra));
        }
      }
      if (bad.length) {
        fail++;
        if (samples.length < 6) samples.push('idx=' + a.idx + ' ' + [...new Set(bad)].join('；'));
      } else pass++;
    }
    rep.check(
      '2125 {wastelandIndex,troop} 与 troop 四键/行三键逐键一致',
      D1,
      pass,
      fail,
      0,
      samples,
    );

    // D1b（HARD）：feat 的 toTroop 对拍——把录制 troop 反喂给 feat 自己的投影函数应原形不动
    //   （录制行只含三键，toTroop 的产出键集必须与实录同形；防投影层偷偷加/减键）
    {
      const featTroop = toTroop({
        heroList: attacks[0].heroRows.map((h) => h.heroId),
        armyListNew: attacks[0].armyRows.map((r) => ({
          pos: r.pos,
          armyId: r.armyId,
          armyNum: r.armyNum,
        })),
        formationV2: attacks[0].formationV2,
        extraArmy: attacks[0].extra
          ? { armyId: attacks[0].extra.armyId, armyNum: attacks[0].extra.armyNum }
          : {},
      });
      const same =
        keysOf(featTroop) === attacks[0].troopKeys &&
        keysOf(featTroop.armyPosList[0]) === 'armyId|armyNum|pos' &&
        keysOf(featTroop.heroList[0]) === 'heroId' &&
        JSON.stringify(featTroop.armyPosList) ===
          JSON.stringify(
            attacks[0].armyRows.map((r) => ({ pos: r.pos, armyId: r.armyId, armyNum: r.armyNum })),
          );
      rep.check(
        'feat toTroop 投影与实录 troop 同形（反喂回归）',
        D1,
        same ? 1 : 0,
        same ? 0 : 1,
        0,
        ['feat 产出键=' + keysOf(featTroop) + '｜实录键=' + attacks[0].troopKeys],
      );
    }

    // D2 即时结算不变量（HARD）：每条 2125 前后 ±2s 内不得有 902（攻打不另发独立 902 行军包的实录依据）
    pass = 0;
    fail = 0;
    for (const a of attacks) {
      const near = S.marchTs.some((t) => Math.abs(t - a.t) <= 2000);
      if (near) {
        fail++;
        samples.push('2125 idx=' + a.idx + ' 附近 ±2s 出现 902');
      } else pass++;
    }
    rep.check(
      '2125 攻打不伴随独立 902 行军包（即时结算；仍占 myMarchNum 名额，由 canMarch 闸控）',
      D2,
      pass,
      fail,
      0,
      [],
    );

    // D3 wastelandIndex 来源闸（HARD）：发包那一刻最近一份视口快照里必有同号 317 地块
    pass = 0;
    fail = 0;
    let skip = 0;
    for (const a of attacks) {
      const snap = snapshotAt(S.tileTimeline, a.t);
      if (!snap) {
        skip++; // 视口嗅探稀疏：无从判定，不判负
        continue;
      }
      if (snap.tiles.some((t) => t.idx === a.idx)) pass++;
      else {
        fail++;
        samples.push(
          'idx=' +
            a.idx +
            ' 不在最近快照 specIndex 集 [' +
            snap.tiles.map((t) => t.idx).join(',') +
            ']',
        );
      }
    }
    rep.check(
      '2125 wastelandIndex 必来自发包前最近的 317 地块 specIndex',
      D3,
      pass,
      fail,
      skip,
      samples,
    );

    // D4 地块形态契约（SOFT）：feat ingest 依赖的 m 键须在场（漂移只报不判负 ⇒ 计入 skip 展示）
    {
      const allTiles = S.tileTimeline.flatMap((s) => s.tiles);
      const need = ['specIndex', 'type', 'expireTime'];
      let ok = 0;
      let drift = 0;
      const dsamples = [];
      for (const t of allTiles) {
        const have = String(t.mKeys || '').split('|');
        const missing = need.filter((k) => !have.includes(k));
        if (missing.length) {
          drift++;
          if (dsamples.length < 3)
            dsamples.push('m 缺 ' + missing.join(',') + '（实有 ' + t.mKeys + '）');
        } else ok++;
      }
      rep.check(
        '317 地块 m 含 specIndex/type/expireTime（feat 嗅探依赖面，样本 ' + allTiles.length + '）',
        D4,
        ok,
        0,
        drift,
        dsamples,
      );
    }

    // D5 发送通道（HARD）：2124/2125 req 恒 req:sendPBV2
    pass = 0;
    fail = 0;
    for (const a of [...attacks, ...S.infoReqs]) {
      if (a.dir === 'req:sendPBV2') pass++;
      else {
        fail++;
        samples.push(a.cmd + ' dir=' + a.dir);
      }
    }
    rep.check('写/读请求恒走 sendPBV2 通道', D5, pass, fail, 0, []);

    // D7 发现腿 2111 一致性（HARD）：真人实际攻打的 wastelandIndex 必在发包前最近一份 2111 经
    //   feat 自己的 candidateBeasts 选出的 BOSS_SKILL+OPENING 分区集内（改版后「不切图只靠 2111」的核心不变量）
    if (!S.beastLands.length) {
      rep.check('本场无 2111 发现样本，不判定', D7, 0, 0, 1, []);
    } else {
      pass = 0;
      fail = 0;
      skip = 0;
      for (const a of attacks) {
        let snap = null;
        for (const b of S.beastLands) {
          if (b.ts <= a.t) snap = b;
          else break;
        }
        if (!snap) {
          skip++; // 该 2125 早于本场任何 2111 快照：无从判定
          continue;
        }
        if (snap.idxs.includes(a.idx)) pass++;
        else {
          fail++;
          if (samples.length < 6)
            samples.push('idx=' + a.idx + ' 不在最近 2111 候选 [' + snap.idxs.join(',') + ']');
        }
      }
      rep.check(
        '2125 wastelandIndex 必在 2111 经 candidateBeasts 选出的 BOSS_SKILL+OPENING 分区集内',
        D7,
        pass,
        fail,
        skip,
        samples,
      );
    }

    // D6 应答与节奏（OBSERVATION，不判负）：配对率、isOk、同点间隔
    {
      const paired = attacks.filter((a) => a.code != null);
      const okCnt = paired.filter((a) => Number(a.code) === 0 && Number(a.isOk) === 1).length;
      const byIdx = new Map();
      for (const a of attacks) {
        if (!byIdx.has(a.idx)) byIdx.set(a.idx, []);
        byIdx.get(a.idx).push(a.t);
      }
      const gaps = [];
      for (const ts of byIdx.values()) {
        ts.sort((x, y) => x - y);
        for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
      }
      rep.check(
        '应答配对 ' +
          paired.length +
          '/' +
          attacks.length +
          '（线上 2125 共 ' +
          S.attackCount +
          ' 条），isOk=1 共 ' +
          okCnt +
          '，覆盖 wastelandIndex [' +
          [...byIdx.keys()].join(',') +
          ']' +
          (gaps.length ? '，同点间隔秒 [' + gaps.map((g) => g.toFixed(0)).join(',') + ']' : ''),
        D6,
        0,
        0,
        1,
        [],
      );
    }
  },
};
