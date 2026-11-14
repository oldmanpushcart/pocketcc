/**
 * 异能秘境 feat · 录制仿真对拍 Manifest（第一个消费者 / 参考实现）。
 *
 * 这是「内核 + Manifest」分层里的 feat 私货一侧：只声明「本 feat 的协议号/现场态/闸门规则」，
 * 读录制、二分回溯、Int64 归一、应答配对、报告打印、退出码这些通用机制全交给 scripts/replay/。
 *
 * 运行：node scripts/replay/run.mjs --manifest secret-realm [录制...] [--verbose]
 *
 * 校验维度（队长视角写动作对齐 constants.js 同一份协议字典）：
 *   数据格式 / BOSS 攻打 / BOSS 停车坪(176)↔区域(esrId) / 商店 / 拍宠·投喂 / 石头拾取 / 拒绝码·时序。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON, snapshotAt } from '../replay/reader.mjs';
import { toNum, isInt64Obj, isRidString } from '../replay/int64.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SR = path.join(ROOT, 'extension/src/feats/activity/secret-realm');

// ── 协议字典：与 feat 共用同一份 constants.js，判据不另起炉灶 ──────────────
const C = await import(pathToFileURL(path.join(SR, 'constants.js')).href);
const {
  CMD_MARCH_MOVE,
  CMD_RESOURCE_INFO,
  CMD_RESOURCE_GET,
  CMD_RESOURCE_GET_BUFF,
  CMD_DROP_INFO,
  CMD_DROP_GET,
  CMD_BEAST_OPERATE,
  CMD_BOSS_GUARD_GET,
  CMD_SHOP_INFO,
  CMD_SHOP_BUY,
  CMD_SHOP_REFRESH,
  CMD_BAG_GET_SET,
  CMD_LEAVE_AREA,
  CMD_BEAST_INFO,
  CMD_BEAST_SCOUT,
  PUSH_BASE_INFO,
  PUSH_BOSS_STATE,
  PUSH_BOSS_GUARD_REWARD,
  PUSH_BAG_INFO,
  PUSH_FEED_BEAST,
  ST_BOSS_FIGHTING,
  PAB_SHOP,
  PAB_DROP,
  PAB_MONSTER,
  PAB_RESOURCE,
  PAB_BOSS_PLANE,
  PAB_BOSS,
  PAB_BOSS_GUARD,
  tuning,
  SHOP_SPEC_ECONOMY,
} = C;

/** 点型：直接取 constants.js 的 PAB_* 单一真相源（判据不与 feat 分叉） */
const PT = {
  SHOP: PAB_SHOP,
  DROP: PAB_DROP,
  WILD: PAB_MONSTER,
  RESOURCE: PAB_RESOURCE,
  PLANE: PAB_BOSS_PLANE,
  BOSS_BIG: PAB_BOSS,
  BOSS_SMALL: PAB_BOSS_GUARD,
};
/** 世界图视口 cmd（core 协议，非本 feat 常量）：其 resp 的 pointList[].m.esrId 是 176/177/178 区域配对数据源 */
const CMD_GET_WORLD_INFO = 901;
/** NMarchState（运行时枚举，diff-replay 实测值）：ARRIVED=2 为「停泊在位」 */
const NM_ARRIVED = 2;

// 85xx 写动作（队长侧发出）集合
const WRITE_CMDS = new Set([
  CMD_MARCH_MOVE,
  CMD_RESOURCE_GET,
  CMD_RESOURCE_GET_BUFF,
  CMD_DROP_GET,
  CMD_BEAST_OPERATE,
  CMD_BOSS_GUARD_GET,
  CMD_SHOP_BUY,
  CMD_SHOP_REFRESH,
  CMD_SHOP_INFO,
  CMD_RESOURCE_INFO,
  CMD_DROP_INFO,
  CMD_BAG_GET_SET,
  CMD_LEAVE_AREA,
  CMD_BEAST_INFO,
  CMD_BEAST_SCOUT,
]);

export default {
  id: 'secret-realm',
  featDir: 'extension/src/feats/activity/secret-realm',
  defaultRecs: [
    'dashcam/store/rec/14179309129759/dashcam-rec-20261018T200040-异能秘境-我是队长.ndjson',
    'dashcam/store/rec/14179309129759/dashcam-rec-20261101T200401-异能秘境-我是队长.ndjson',
  ],
  engineMods: {
    'pilot.js': ['PilotEngine'],
    'boss.js': ['BossEngine'],
    'shop.js': ['ShopEngine'],
    'capture.js': ['CaptureEngine'],
    'pickup.js': ['PickupEngine'],
    'api.js': ['secretRealm'],
  },

  // ── 现场态重建：单遍扫录制，把引擎读取口径的 push/resp/view 归入各自时间线 ──
  async buildScan(recPath) {
    const baseSnaps = []; // {ts, info} 21521
    const bossSnaps = []; // {ts, list} 21535（整表替换）
    const rewardSnaps = []; // {ts, groups} 21539
    const bagSnaps = []; // {ts, bagInfo:[{itemId,itemCount}]} 21525
    const feedPos = []; // {ts, x, y, boss} 21530（capturingPetPos 写）
    const viewPoints = new Map(); // "x,y" -> {pointType, esrId} 来自 901 resp 视口（秘境 176/177/178 的真身在此）
    const viewShopPts = new Map(); // "x,y" -> true（901 视口里出现过的 161 点）
    const feedInfoByReqTs = new Map(); // reqTs -> {allFavor, changeScore} 来自 8546 resp

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => WRITE_CMDS.has(e.cmd),
        onEntry: (e, _acc) => {
          const body = e.body;
          if (e.dir === 'push') {
            if (e.cmd === PUSH_BASE_INFO) {
              const info = body && body.info ? body.info : body;
              if (info && (info.startPoint || info.marchState != null))
                baseSnaps.push({ ts: e.ts, info });
            } else if (e.cmd === PUSH_BOSS_STATE) {
              const list =
                body && body.stateInfo ? body.stateInfo : Array.isArray(body) ? body : null;
              if (Array.isArray(list)) bossSnaps.push({ ts: e.ts, list });
            } else if (e.cmd === PUSH_BOSS_GUARD_REWARD) {
              const groups =
                body && body.rewardInfo ? body.rewardInfo : Array.isArray(body) ? body : null;
              if (groups) rewardSnaps.push({ ts: e.ts, groups });
            } else if (e.cmd === PUSH_BAG_INFO) {
              const bag = body && body.bagInfo ? body.bagInfo : null;
              if (Array.isArray(bag)) bagSnaps.push({ ts: e.ts, bagInfo: bag });
            } else if (e.cmd === PUSH_FEED_BEAST) {
              const x = Number(body && body.x);
              const y = Number(body && body.y);
              feedPos.push({ ts: e.ts, x, y, boss: Number(body && body.boss) === 1 });
            }
          } else if (e.dir === 'resp') {
            if (e.cmd === CMD_BEAST_OPERATE && body && body.feedInfo) {
              feedInfoByReqTs.set(e.rt, {
                allFavor: toNum(body.feedInfo.allFavor),
                changeScore: toNum(body.changeScore),
              });
            } else if (e.cmd === CMD_GET_WORLD_INFO && body && Array.isArray(body.pointList)) {
              // 901 世界图 resp：pointList[].m.esrId 是停车坪(176)↔BOSS 本体(177/178)区域配对的数据源
              for (const p of body.pointList) {
                const m = p.m || p.extData || {};
                const esr = Number(m.esrId);
                const pt = Number(p.pointType);
                if (pt === PT.SHOP) viewShopPts.set(p.x + ',' + p.y, true);
                if (
                  Number.isFinite(esr) &&
                  (pt === PT.PLANE || pt === PT.BOSS_BIG || pt === PT.BOSS_SMALL)
                ) {
                  viewPoints.set(p.x + ',' + p.y, { pointType: pt, esrId: esr });
                }
              }
            }
          }
        },
      },
    );

    // 排序保证回溯查询单调
    const byTs = (a, b) => a.ts - b.ts;
    baseSnaps.sort(byTs);
    bossSnaps.sort(byTs);
    rewardSnaps.sort(byTs);
    bagSnaps.sort(byTs);
    feedPos.sort(byTs);

    // 应答配对率
    let pairedResp = 0;
    for (const w of writes) if (respByReqTs.has(w.t)) pairedResp++;

    return {
      recPath,
      total,
      parseErr,
      minTs,
      maxTs,
      dirCounts,
      writes,
      baseSnaps,
      bossSnaps,
      rewardSnaps,
      bagSnaps,
      feedPos,
      feedInfoByReqTs,
      respByReqTs,
      viewShopPts,
      viewPoints,
      pairedResp,
      // 本人 uid：以录制所在目录名为真相源（换账号即换判据），避免硬编码
      uid: path.basename(path.dirname(recPath)),
    };
  },

  // ── 一致性体检：逐维度校验（对每条写动作回查「发包那一刻」现场态）────────
  runVerify(S, rep) {
    const { writes } = S;

    // 「发包那一刻」控制器现场（回溯最近 ≤T 的快照）
    const baseAt = (t) => {
      const s = snapshotAt(S.baseSnaps, t);
      return s ? s.info : null;
    };
    const bossListAt = (t) => {
      const s = snapshotAt(S.bossSnaps, t);
      return s ? s.list : null;
    };
    const rewardAt = (t) => {
      const s = snapshotAt(S.rewardSnaps, t);
      return s ? s.groups : null;
    };
    const feedPosAt = (t) => snapshotAt(S.feedPos, t) || null;

    // ── 维度：数据格式（载荷字段形态）─────────────────────────────
    {
      const spec = {
        [CMD_MARCH_MOVE]: { keys: ['x', 'y'], int: ['x', 'y'] },
        [CMD_SHOP_INFO]: { keys: ['x', 'y'], int: ['x', 'y'] },
        [CMD_SHOP_REFRESH]: { keys: ['x', 'y'], int: ['x', 'y'] },
        [CMD_RESOURCE_INFO]: { keys: ['x', 'y'], int: ['x', 'y'] },
        [CMD_DROP_INFO]: { keys: ['x', 'y'], int: ['x', 'y'] },
        [CMD_BEAST_OPERATE]: { keys: ['specId'], int: ['specId'] },
        [CMD_BOSS_GUARD_GET]: { keys: ['x', 'y'], int: ['x', 'y'] },
        [CMD_SHOP_BUY]: { keys: ['specId', 'num'], int: ['specId', 'num'] },
        [CMD_RESOURCE_GET]: { keys: ['rId'], rid: ['rId'] },
        [CMD_DROP_GET]: { keys: ['x', 'y', 'rId'], int: ['x', 'y'], rid: ['rId'] },
        [CMD_RESOURCE_GET_BUFF]: { keys: ['rId', 'pos'], rid: ['rId'] },
        [CMD_BEAST_INFO]: { keys: ['x', 'y'], int: ['x', 'y'] },
        [CMD_BEAST_SCOUT]: { keys: ['x', 'y'], int: ['x', 'y'] },
      };
      let pass = 0;
      let fail = 0;
      const fails = [];
      for (const w of writes) {
        const s = spec[w.cmd];
        if (!s) continue; // 8581/8589 单独查
        const req = w.req || {};
        const gotKeys = Object.keys(req).sort();
        const wantKeys = s.keys.slice().sort();
        let ok = gotKeys.join(',') === wantKeys.join(',');
        if (ok) {
          for (const k of s.int || []) if (!Number.isFinite(Number(req[k]))) ok = false;
          for (const k of s.rid || []) if (!isRidString(req[k])) ok = false;
        }
        if (ok) pass++;
        else {
          fail++;
          if (fails.length < 3)
            fails.push('cmd' + w.cmd + ' keys=[' + gotKeys + '] 期望[' + wantKeys + ']');
        }
      }
      rep.check('写动作载荷字段形态（数据格式）', '数据格式', pass, fail, 0, fails);

      // 8581 uuIds 必须是 Int64 对象；8589 带 uid
      let bagPass = 0;
      let bagFail = 0;
      const bagF = [];
      for (const w of writes) {
        if (w.cmd === CMD_BAG_GET_SET) {
          const u = (w.req && w.req.uuIds) || [];
          const allInt64 = Array.isArray(u) && (u.length === 0 || u.every(isInt64Obj));
          const hasItems = Array.isArray(w.req && w.req.itemIds);
          if (allInt64 && hasItems) bagPass++;
          else {
            bagFail++;
            if (bagF.length < 3) bagF.push('8581 uuIds 非 Int64 对象或缺 itemIds');
          }
        }
        if (w.cmd === CMD_LEAVE_AREA) {
          const uid = toNum(w.req && w.req.uid);
          if (uid === Number(S.uid)) bagPass++;
          else {
            bagFail++;
            if (bagF.length < 3) bagF.push('8589 uid=' + uid + ' 非本人(' + S.uid + ')');
          }
        }
      }
      if (bagPass || bagFail)
        rep.check('8581/8589 带出与离场载荷', '数据格式', bagPass, bagFail, 0, bagF);
    }

    // ── 维度：BOSS 攻打逻辑（8521→BOSS 坐标须 state21）───────────
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      const bossPos = new Map(); // "x,y" -> {bossId}
      // 从 21535 全量收集 BOSS 本体坐标
      for (const s of S.bossSnaps) {
        for (const b of s.list || []) {
          if (b && b.pos)
            bossPos.set(Math.floor(toNum(b.pos.x)) + ',' + Math.floor(toNum(b.pos.y)), {
              bossId: Number(b.bossId),
            });
        }
      }
      for (const w of writes) {
        if (w.cmd !== CMD_MARCH_MOVE) continue;
        const x = Math.floor(Number(w.req.x));
        const y = Math.floor(Number(w.req.y));
        const hit = bossPos.get(x + ',' + y);
        if (!hit) continue; // 非 BOSS 点行军（巡航/商店/拾取），不属本维度
        const list = bossListAt(w.t);
        if (!list) {
          skip++;
          continue;
        }
        const b = (list || []).find((z) => Number(z.bossId) === hit.bossId);
        const st = b ? Number(b.state) : NaN;
        if (st === ST_BOSS_FIGHTING) pass++;
        else {
          fail++;
          if (fails.length < 3)
            fails.push(
              `8521→BOSS${hit.bossId}@(${x},${y}) 时刻 state=${st}（非${ST_BOSS_FIGHTING}可打）`,
            );
        }
      }
      rep.check('8521 攻打 BOSS 仅在其 state=21 时发起', 'BOSS 攻打', pass, fail, skip, fails);

      // 攻打闸：发 BOSS 行军那一刻队伍须为队长（leaderUid==本人）；在位平台与否只统计
      let leadPass = 0;
      let leadFail = 0;
      let leadSkip = 0;
      const onPlane = { pass: 0, fail: 0, skip: 0 };
      let strict176 = 0; // 严格当前闸：从 176 平台发起
      let softBody = 0; // 从 BOSS 本体 177/178 发起（真机合法、当前闸不主动发）
      let staleTransit = 0; // 在 BOSS 邻域但回读 marchState≠ARRIVED（21521 滞后）
      const offPt = new Map(); // 攻打时非-176 的 pointType 直方图
      const baseStaleMs = 15000; // 21521 回读快照可信年龄上限
      const lf = [];
      for (const w of writes) {
        if (w.cmd !== CMD_MARCH_MOVE) continue;
        const x = Math.floor(Number(w.req.x));
        const y = Math.floor(Number(w.req.y));
        if (!bossPos.has(x + ',' + y)) continue;
        const b = baseAt(w.t);
        if (!b) {
          leadSkip++;
          continue;
        }
        if (toNum(b.leaderUid) === Number(S.uid)) leadPass++;
        else {
          leadFail++;
          if (lf.length < 3) lf.push('攻打非队长 leaderUid=' + b.leaderUid);
        }
        // 停车坪/在位攻打（新鲜快照口径）：当前代码 boss.js 要求 `pointType===176 && marchState===ARRIVED`；
        //   但真机行军四段式里「在 BOSS 本体」段 pt=177/178 且已 ARRIVED 后还会续打 → 从本体发起攻打为游戏合法。
        //   硬伤（fail）= 新鲜快照下 pt 不属 BOSS 邻域{176,177,178}（从商店/资源/野怪点打 BOSS = 逻辑错）。
        //   marchState 只靠稀疏 21521 回读不可靠（抵达常由 21529 TEAM_ARRIVE + 更新的 21521 体现，滞后于回读快照）
        //   → pt 已在 BOSS 邻域但 ms≠ARRIVED 归「21521 滞后快照」（staleTransit），不计违例。
        //   pt=177/178 单独归「当前 176 闸比真机严」的观察（soft），不计违例。
        const pt = Number(b.pointType);
        const ms = Number(b.marchState);
        const snap = snapshotAt(S.baseSnaps, w.t);
        const age = snap ? w.t - snap.ts : Infinity;
        const bossish = pt === PT.PLANE || pt === PT.BOSS_BIG || pt === PT.BOSS_SMALL;
        if (!Number.isFinite(pt) || age > baseStaleMs) onPlane.skip++;
        else if (!bossish) {
          onPlane.fail++;
          offPt.set(`pt${pt}/ms${ms}`, (offPt.get(`pt${pt}/ms${ms}`) || 0) + 1);
        } else {
          onPlane.pass++;
          if (ms !== NM_ARRIVED) staleTransit++;
          if (pt === PT.PLANE) strict176++;
          else softBody++;
        }
      }
      rep.check(
        '8521 攻打由队长发起（leaderUid 闸）',
        'BOSS 攻打',
        leadPass,
        leadFail,
        leadSkip,
        lf,
      );

      // 在位攻打：硬伤只算「非 BOSS 邻域点位」；176 vs 177/178 、marchState 滞后快照拆开展示
      const offDesc = [...offPt.entries()].map(([k, v]) => `${k}×${v}`).join(' ');
      rep.check(
        '攻打发起时队伍在 BOSS 邻域(176/177/178)点位',
        'BOSS 停车坪(176)',
        onPlane.pass,
        onPlane.fail,
        onPlane.skip,
        [
          `pt=176平台 ${strict176} 次；pt=177/178 本体 ${softBody} 次（真机合法、当前代码 pt≠176 不主动发→保守收敛）` +
            (staleTransit
              ? `；${staleTransit} 次回读 ms≠ARRIVED 属 21521 滞后（抵达由 21529 体现）`
              : '') +
            (onPlane.skip ? `；${onPlane.skip} 次因快照稀疏无法判定` : '') +
            (offPt.size ? `；硬伤(非BOSS邻域): ${offDesc}` : ''),
        ],
      );
    }

    // ── 维度：BOSS 停车坪(176)↔BOSS 区域(esrId)配对（数据源=901 视口）───────
    {
      const platEsr = new Set();
      const bossEsr = new Set();
      let plat = 0;
      let bossBody = 0;
      for (const [, t] of S.viewPoints) {
        if (t.pointType === PT.PLANE) {
          plat++;
          platEsr.add(t.esrId);
        } else if (t.pointType === PT.BOSS_BIG || t.pointType === PT.BOSS_SMALL) {
          bossBody++;
          bossEsr.add(t.esrId);
        }
      }
      if (plat === 0 && bossBody === 0) {
        rep.check(
          '176 平台 esrId 覆盖全部 BOSS 本体 esrId（同区可攻打）',
          'BOSS 停车坪(176)',
          0,
          0,
          1,
          [
            '901 视口未采到带 esrId 的 176/177/178 点（本录制镜头未扫过 BOSS 区，属采样局限，不判负）',
          ],
        );
      } else {
        // 配对：每个 BOSS 本体 esrId 都应有同 esrId 的平台（可攻打）
        const orphanBossEsr = [...bossEsr].filter((e) => !platEsr.has(e));
        const ok = plat > 0 && bossBody > 0 && orphanBossEsr.length === 0;
        rep.check(
          '176 平台 esrId 覆盖全部 BOSS 本体 esrId（同区可攻打）',
          'BOSS 停车坪(176)',
          ok ? 1 : 0,
          ok ? 0 : 1,
          0,
          [
            `平台 ${plat} 块(esrId ${[...platEsr].sort().join('/') || '—'})｜BOSS 本体 ${bossBody} 个(esrId ${[...bossEsr].sort().join('/') || '—'})｜无平台对应的 BOSS 区: ${orphanBossEsr.join('/') || '无'}`,
          ],
        );
      }
    }

    // ── 维度：商店（8542 买货仅在停靠 161；specId 合法；getTime 语义）─────
    {
      let parked = 0;
      let notParked = 0;
      let skip = 0;
      const fails = [];
      let specOk = 0;
      let specBad = 0;
      const specBadF = [];
      const knownSpec = new Set([11, 12, 13, 14, 15, 16, 17, 19, 20]);
      for (const w of writes) {
        if (w.cmd === CMD_SHOP_BUY) {
          const b = baseAt(w.t);
          if (!b) skip++;
          else if (Number(b.pointType) === PT.SHOP && Number(b.marchState) === NM_ARRIVED) parked++;
          else {
            notParked++;
            if (fails.length < 3)
              fails.push(
                `8542 买货时 pointType=${b.pointType} marchState=${b.marchState}（未停靠161）`,
              );
          }
          const sp = Number(w.req.specId);
          if (knownSpec.has(sp) || SHOP_SPEC_ECONOMY[sp]) specOk++;
          else {
            specBad++;
            if (specBadF.length < 3) specBadF.push('8542 未知 specId=' + sp);
          }
        }
      }
      rep.check(
        '8542 买货仅在停靠商店点(161,ARRIVED)时发起',
        '商店',
        parked,
        notParked,
        skip,
        fails,
      );
      rep.check('8542 specId 落在货单集合内', '商店', specOk, specBad, 0, specBadF);

      // 8540/8543 必须带坐标且坐标是已见商店点
      let xyOk = 0;
      let xySkip = 0;
      for (const w of writes) {
        if (w.cmd === CMD_SHOP_INFO || w.cmd === CMD_SHOP_REFRESH) {
          const k = Math.floor(Number(w.req.x)) + ',' + Math.floor(Number(w.req.y));
          if (S.viewShopPts.has(k)) xyOk++;
          else xySkip++; // 视口未采到该商店点（稀疏回读/采样局限）→ 无法判定，不判负
        }
      }
      rep.check('8540/8543 携带坐标命中已见商店点(视口采样)', '商店', xyOk, 0, xySkip, []);
    }

    // ── 维度：拍宠 / 投喂（specId=5/6 仅大BOSS窗、节流 200ms；specId=1 手拍）──
    {
      // specId=5/6 只在 boss 窗（21530 boss===1 或 8546resp allFavor=1e6）
      let inBoss = 0;
      let outBoss = 0;
      const fails = [];
      const feedGap = tuning.bossFeedGapMs;
      // 投喂间隔只在同一窗内计量（换一只宠 onFeedBeast 会重置 #nextFeedAt），并拿实测区间与配置对量级
      const gaps = [];
      let lastFeedT = -Infinity;
      let lastWinKey = '';
      for (const w of writes) {
        if (w.cmd !== CMD_BEAST_OPERATE) continue;
        const sp = Number(w.req.specId);
        if (sp === 5 || sp === 6) {
          const pos = feedPosAt(w.t);
          const fi = S.feedInfoByReqTs.get(w.t);
          const bossWin = (pos && pos.boss && pos.x > 0) || (fi && fi.allFavor === 1000000);
          if (bossWin) inBoss++;
          else {
            outBoss++;
            if (fails.length < 3)
              fails.push(
                `8546 specId=${sp} 非大BOSS窗(pos=${pos ? pos.boss : 'null'} allFavor=${fi ? fi.allFavor : 'null'})`,
              );
          }
          const winKey = pos && pos.x > 0 ? pos.x + ',' + pos.y : 'w?';
          if (winKey !== lastWinKey) lastFeedT = -Infinity; // 跨窗不节流
          if (lastFeedT !== -Infinity) gaps.push(w.t - lastFeedT);
          lastFeedT = w.t;
          lastWinKey = winKey;
        }
      }
      rep.check('8546 投喂道具(specId5/6)仅在大BOSS窗内', '拍宠/投喂', inBoss, outBoss, 0, fails);

      if (gaps.length) {
        const sorted = gaps.slice().sort((a, b) => a - b);
        const gmin = sorted[0];
        const gmax = sorted[sorted.length - 1];
        const gmed = sorted[Math.floor(sorted.length / 2)];
        // 真机两份录制的同窗投喂间隔分别以 158ms / 252ms 为下界，把配置 200ms 夹在中间 → 同量级。
        //   判定口径：配置与实测区间同一数量级（[min*0.5, max*2]）即「与人手节奏同量级」，非硬阀。
        const lo = gmin * 0.5;
        const hi = gmax * 2;
        const inEnvelope = feedGap >= lo && feedGap <= hi;
        rep.check(
          '投喂节流 bossFeedGapMs 与真机节奏同量级',
          '拍宠/投喂',
          inEnvelope ? 1 : 0,
          inEnvelope ? 0 : 1,
          0,
          [
            `真机同窗投喂间隔 min=${gmin} 中位=${gmed} max=${gmax}ms（${gaps.length} 样本）｜配置 bossFeedGapMs=${feedGap}` +
              (feedGap < gmin
                ? '（现版比该录制更快，旧实机产物低于现阀→现版更保守，非缺陷）'
                : feedGap > gmax
                  ? '（现版节流慢于真机最快档，合理）'
                  : '（落在真机区间内）'),
          ],
        );
      } else {
        rep.check('投喂节流 bossFeedGapMs 与真机节奏同量级', '拍宠/投喂', 0, 0, 1, [
          '本录制无同窗连续投喂样本',
        ]);
      }

      // specId=1（免费手拍）应存在（自动驾驶拍宠打底）；仅统计
      let tap = 0;
      for (const w of writes) if (w.cmd === CMD_BEAST_OPERATE && Number(w.req.specId) === 1) tap++;
      rep.check('8546 免费手拍(specId=1)节拍存在', '拍宠/投喂', tap, 0, tap ? 0 : 1, [
        tap ? `手拍 ${tap} 次` : '录制无手拍',
      ]);
    }

    // ── 维度：石头（8548 坐标须来自 21539 账本、isFight=1 且 rewardNum<max）──
    {
      let ok = 0;
      let bad = 0;
      let skip = 0;
      const fails = [];
      for (const w of writes) {
        if (w.cmd !== CMD_BOSS_GUARD_GET) continue;
        const x = Math.floor(Number(w.req.x));
        const y = Math.floor(Number(w.req.y));
        const groups = rewardAt(w.t);
        if (!groups) {
          skip++;
          continue;
        }
        let found = null;
        const garr = Array.isArray(groups) ? groups : [groups];
        for (const g of garr) {
          for (const p of (g && g.rewardInfo) || []) {
            if (!p || !p.pos) continue;
            if (Math.floor(toNum(p.pos.x)) === x && Math.floor(toNum(p.pos.y)) === y) {
              found = p;
              break;
            }
          }
          if (found) break;
        }
        if (!found) {
          bad++;
          if (fails.length < 3) fails.push(`8548@(${x},${y}) 不在 21539 石头账本内`);
        } else {
          const rn = toNum(found.rewardNum);
          const mx = toNum(found.rewardMaxNum);
          if (!Number.isFinite(rn) || !Number.isFinite(mx)) {
            skip++; // 账本字段缺失（服务端裁剪）→ 无法判定，不判负
          } else if (Number(found.isFight) === 1 && rn < mx) {
            ok++;
          } else {
            bad++;
            if (fails.length < 3)
              fails.push(`8548@(${x},${y}) isFight=${found.isFight} ${rn}/${mx}（判据不符）`);
          }
        }
      }
      rep.check(
        '8548 石头坐标源自 21539 账本且 isFight=1/rewardNum<max',
        '石头拾取',
        ok,
        bad,
        skip,
        fails,
      );
    }

    // ── 维度：拾取（8527/8533/8538 仅停泊在位发起；rId 十进制串）──────
    {
      let parkedOk = 0;
      let parkedBad = 0;
      let skip = 0;
      const fails = [];
      for (const w of writes) {
        if (w.cmd !== CMD_RESOURCE_GET && w.cmd !== CMD_DROP_GET && w.cmd !== CMD_RESOURCE_GET_BUFF)
          continue;
        const b = baseAt(w.t);
        if (!b) {
          skip++;
          continue;
        }
        // 资源/掉落拿取要求已停泊（marchState=ARRIVED）；8527/8533 目标点=当前 startPoint
        if (Number(b.marchState) === NM_ARRIVED) parkedOk++;
        else {
          parkedBad++;
          if (fails.length < 3)
            fails.push(`cmd${w.cmd} 发出时 marchState=${b.marchState}（未抵达）`);
        }
      }
      rep.check('8527/8533/8538 拾取仅在停泊在位时发起', '拾取', parkedOk, parkedBad, skip, fails);

      // rId 十进制字符串格式
      let ridOk = 0;
      let ridBad = 0;
      const rf = [];
      for (const w of writes) {
        if ([CMD_RESOURCE_GET, CMD_DROP_GET, CMD_RESOURCE_GET_BUFF].includes(w.cmd)) {
          if (isRidString(w.req.rId)) ridOk++;
          else {
            ridBad++;
            if (rf.length < 3)
              rf.push('cmd' + w.cmd + ' rId 非十进制字符串: ' + JSON.stringify(w.req.rId));
          }
        }
      }
      rep.check('拾取 rId 为十进制字符串（Int64 精度口径）', '拾取', ridOk, ridBad, 0, rf);
    }

    // ── 维度：应答拒绝码 & 配对覆盖（健壮性/时序）──────────────────
    {
      // 8521 应答：header.s=0 成功 / =3 业务拒（拒因在 header.d，如 enigma_realm158）
      // 拒因白名单直接取 constants.js 的 REJ_* 单一真相源（feat 增删拒因即自动同步）
      const knownReason = new Set(
        Object.entries(C)
          .filter(([k]) => k.startsWith('REJ_'))
          .map(([, v]) => v),
      );
      const sDist = new Map();
      const reasonDist = new Map();
      let codePass = 0;
      let codeFail = 0;
      const cf = [];
      for (const w of writes) {
        if (w.cmd !== CMD_MARCH_MOVE) continue;
        const r = S.respByReqTs.get(w.t);
        if (!r || r.s == null) continue;
        sDist.set(r.s, (sDist.get(r.s) || 0) + 1);
        if (r.s === 0) codePass++;
        else if (r.s === 3) {
          reasonDist.set(r.d, (reasonDist.get(r.d) || 0) + 1);
          if (!r.d || knownReason.has(r.d)) codePass++;
          else {
            codeFail++;
            if (cf.length < 3) cf.push('8521 未知拒因 s=3 d=' + r.d);
          }
        } else {
          codeFail++;
          if (cf.length < 3) cf.push('8521 异常状态码 s=' + r.s);
        }
      }
      rep.check(
        '8521 应答属已知集(0成功/3业务拒+已知拒因)',
        '拒绝码/时序',
        codePass,
        codeFail,
        0,
        cf.concat([
          's 分布: ' +
            [...sDist.entries()].map(([k, v]) => `${k}×${v}`).join(' ') +
            '｜拒因: ' +
            [...reasonDist.entries()].map(([k, v]) => `${k || '(空)'}×${v}`).join(' '),
        ]),
      );

      // HARD：159995 短黑窗内不得重发同点 8521（四-3）。
      // 规则与 feat 同源：拒因取 C.REJ_PARAM_ERROR、窗长取 tuning.paramBlacklistMs，
      // pilot/boss 两引擎的 #paramBlack/#target 短黑都以此为准（rejects.js 共享真相表）。
      // 窗口起点用拒答对应请求的 ts（内核 respByReqTs 只存 {s,d}，RTT 远小于 60s 窗，口径保守安全）。
      // 无 159995 样本 → 无法判定（skip 不判负，不做「空集即通过」的伪 PASS）。
      {
        const win = Number(tuning.paramBlacklistMs) || 0;
        const rejections = []; // {t, x, y} 159995 拒答事件（按请求 ts）
        for (const w of writes) {
          if (w.cmd !== CMD_MARCH_MOVE) continue;
          const r = S.respByReqTs.get(w.t);
          if (!r || r.s !== 3 || r.d !== C.REJ_PARAM_ERROR) continue;
          const x = Number(w.req && w.req.x);
          const y = Number(w.req && w.req.y);
          if (Number.isFinite(x) && Number.isFinite(y)) rejections.push({ t: w.t, x, y });
        }
        if (!rejections.length || win <= 0) {
          rep.check(
            `159995 短黑窗(${Math.round(win / 1000)}s)内不重发同点 8521 [HARD]`,
            '拒绝码/时序',
            0,
            0,
            1,
            ['本场无 159995 拒答样本，无法判定'],
          );
        } else {
          let ok = 0;
          let bad = 0;
          const fails = [];
          for (const e of rejections) {
            let hit = null;
            for (const w of writes) {
              if (w.cmd !== CMD_MARCH_MOVE || w.t <= e.t || w.t - e.t > win) continue;
              const x = Number(w.req && w.req.x);
              const y = Number(w.req && w.req.y);
              if (x === e.x && y === e.y) {
                hit = w;
                break;
              }
            }
            if (hit) {
              bad++;
              if (fails.length < 3)
                fails.push(
                  `(${e.x},${e.y}) 159995@+${e.t - S.minTs}ms 后 ${hit.t - e.t}ms 重发同点 8521（窗 ${win}ms）`,
                );
            } else ok++;
          }
          rep.check(
            `159995 短黑窗(${Math.round(win / 1000)}s)内不重发同点 8521 [HARD]`,
            '拒绝码/时序',
            ok,
            bad,
            0,
            fails,
          );
        }
      }

      const pairRate = writes.length ? S.pairedResp / writes.length : 0;
      rep.check(
        '写动作应答配对覆盖率(rt===req.ts)',
        '拒绝码/时序',
        pairRate >= 0.5 ? 1 : 0,
        pairRate >= 0.5 ? 0 : 1,
        0,
        [
          `${S.pairedResp}/${writes.length} = ${(pairRate * 100).toFixed(1)}%（次通道频控/超时会压低，>50% 视为链路正常）`,
        ],
      );
    }
  },
};
