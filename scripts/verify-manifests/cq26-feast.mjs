/**
 * CQ26 巨兽盛宴 feat · 录制仿真对拍 Manifest（三腿：礼盒 2106 / 巨熊宝藏 2108 / 奖励宝箱 2104）。
 *
 * 与 cq26-ice-shake / cq26-wl-chest 同层：只声明本 feat 的协议号、触发源与闸门规则，
 * 读录制、二分回溯、Int64 归一、应答配对、报告打印、退出码全交给 scripts/replay/。
 *
 * 运行：node scripts/replay/run.mjs --manifest cq26-feast [录制...] [--verbose]
 *
 * 「仿真侧」是什么：本 feat 的决策已收口成导出纯函数（pickGiftIndex/mergeClaimed/
 *   secretReady/pickSecrets/pickBwlChests/ingestChestTiles/readGiftId）。这里用
 *   **feat 自己的 ingest 纯函数**从录制的 901 resp / 10018 push 重建 315 地块缓存，
 *   把现场态喂回决策纯函数，得到「feat 站在真人那一刻会怎么判」，再与线上真人报文对照。
 *
 * 策略差异（判据设计的前提）：feat 比真人**保守**——巨熊宝藏 grace=0 到点即抢（与游戏闸 endTime≤ServerTime 同口径；真人成功领取集中 endtime 当口，本录 2108 resp s=0×5 / s=3×7）；
 *   礼盒不重领（真人重复点同一 idx，本录 2106 resp s=3×8）。故判据不要求「仿真出网集 == 真人出网集」，
 *   而是：① 载荷逐键同形；② feat 的候选过滤/时序闸与真人真值不打架；③ 真人被拒的重复/抢发恰好
 *   反证 feat 的去重/到点即抢语义。巨熊宝藏日上限配置不在录制里 → 离线无从判定，
 *   额度闸由单测覆盖（三态纪律，不冒充已验证）。融冰（2103）验证已迁至 cq26-ice-shake manifest。
 *
 * 校验维度：
 *   载荷逐键形态（HARD）：真人 2106 body 键集 == `pointIndex`、2108 == `id|received`
 *     且 received===true、id 为 {_low,_high} Int64 形态；通道恒 req:sendPBV2
 *   礼盒不重领（HARD，两侧）：仿真侧重放 mergeClaimed+pickGiftIndex 乐观集语义 → 10 发无重复全覆盖；
 *     真人真值条——同一 pointIndex 至多一次成功（被拒后重试到成功合法，成功后不可重复领）
 *   礼盒满集真值（HARD）：真人末态 22073 claimedIndexList == [0..9]（GIFT_COUNT=10 的录制真值）
 *   礼盒阶段闸（HARD）：真人每发 2106 的时刻 phase==FEED
 *   巨熊宝藏 Int64 往返（HARD）：真人每发 2108 的 id 经 feat readGiftId 解回的十进制串必在 22064 快照
 *     id 集内（feat 只领快照给过的 id，不凭空发；装箱丢精度在此现形）
 *   巨熊宝藏到点即抢（HARD，仿真侧）：对每枚快照巨熊宝藏，secretReady(endtime+GRACE)===true 且
 *     secretReady(endtime+GRACE-1)===false（GRACE=0 即 endtime 当口；闸改松/边界漂移必现形，GRACE 符号与 feat 同源）
 *   奖励宝箱分线过滤（HARD，仿真侧）：录制 315 地块（BWL specIndex=0 ×207 / NWL specIndex=11 ×65）喂
 *     pickBwlChests → ready 全 specIndex=0，NWL 行不入 ready/unknown（wl-chest 的箱不抢）
 *   奖励宝箱出网（无样本记 skip）：本录 2104 零发 ⇒ 载荷形态只有源码约束、无录制真值，如实标注待补证
 *   观察（OBSERVATION）：应答配对率、2106/2108 拒绝率、真人巨熊宝藏抢发延迟分布、
 *     阶段时间线、22072 额度轨迹、2105 已开表形态
 *
 * 协议字典来源：feat 已导出协议号/阈值/纯函数（最小桩化浏览器全局后动态 import），
 *   抽不到期望导出面直接抛错——宁可跑不起来也不手抄一份字典。
 *
 * dir/字段实测（写判据前已用 .reviewtmp/feast/probe-feat-shapes.mjs 探针核对，避免不可达分支）：
 *   2103 req:sendPBV2×116（body {x,y}，归 cq26-ice-shake 验证，本 manifest 不再判）；
 *   2106 req:sendPBV2×18（body {pointIndex}）/ resp×18（**空体**，header.s：0×10 + 3×8）；
 *   2108 req:sendPBV2×12（body {id:{_low,_high,_unsigned},received:true}）/ resp×12（s：0×5 + 3×7）；
 *   2104 零样本；2105 req:sendPBV2×1（body {}）/ resp（posList:[]）；
 *   22032 push×4（feastPhase）；22064 push×41（gift 全量快照含空表）；22073 push×25（player）；
 *   22075 push×10（pointIndex + claimedIndexList + rewardResult.items）；22072 push×6（remainChestNum）；
 *   901 resp×201 / 10018 push×151 带 iceList（本 manifest 只取 initSid 求老家服众数，冰缓存重建归 ice-shake）；
 *   315 地块 specIndex 分布 0×207 / 11×65；iceList 6550 行 initSid 全 3828（老家服唯一）。
 *   内核 writes.req 走 raw.data，sendPBV2 无业务槽间接（坑 5 不适用），本 manifest 仍自建写视图：
 *   要的是「线上真正发出的键集 + Int64 原形 + 发包那一刻的现场态快照」，且 req↔resp 按 rt 合并成一条。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON } from '../replay/reader.mjs';
import { isInt64Obj } from '../replay/int64.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEAT = path.join(ROOT, 'extension/src/feats/cq26/feast.js');
/** 默认录制所在目录（uid 目录；uid 从录制目录名取，不钉账号） */
const REC_DIR = path.join(ROOT, 'dashcam/store/rec/11981629951662');

/**
 * 按会话起始串定位录制文件（相对 ROOT 的路径）。
 * dashcam server 空闲后 finalize 改名，只认 `dashcam-rec-<start>` 前缀，优先定稿名、回落 `.part`。
 * @param {string} start 会话起始串，如 '20261109T205818'
 * @returns {string} ROOT 相对路径
 */
function recByStart(start) {
  const want = 'dashcam-rec-' + start;
  const hits = fs
    .readdirSync(REC_DIR)
    .filter((f) => f.startsWith(want) && f.endsWith('.ndjson') && f !== 'dashcam-rec-index.ndjson');
  if (!hits.length)
    throw new Error('录制缺失：' + path.basename(REC_DIR) + '/ 里没有 ' + want + '*');
  hits.sort((a, b) => {
    const pa = a.endsWith('.part.ndjson') ? 1 : 0;
    const pb = b.endsWith('.part.ndjson') ? 1 : 0;
    return pa - pb || a.localeCompare(b);
  });
  return path.relative(ROOT, path.join(REC_DIR, hits[0])).split(path.sep).join('/');
}

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

// ── 协议字典 + 决策纯函数：与 feat 共用同一份，判据不另起炉灶 ────────────────
const C = await import(pathToFileURL(FEAT).href);
const {
  CMD_GET_CHEST,
  CMD_OPENED_LIST,
  CMD_GET_GIFT,
  CMD_SECRET_GIFT,
  PUSH_PHASE,
  PUSH_SECRET,
  PUSH_PLAYER,
  PUSH_GIFT_REWARD,
  PUSH_WL_INFO,
  PUSH_TILE,
  CMD_WORLD_INFO,
  PHASE_FEED,
  GIFT_COUNT,
  SECRET_GRACE_SEC,
  ingestChestTiles,
  readGiftId,
  pickGiftIndex,
  mergeClaimed,
  secretReady,
  pickBwlChests,
} = C;
const PURE_FNS = {
  ingestChestTiles,
  readGiftId,
  pickGiftIndex,
  mergeClaimed,
  secretReady,
  pickBwlChests,
};
for (const [name, fn] of Object.entries(PURE_FNS)) {
  if (typeof fn !== 'function')
    throw new Error('feat 导出面缺 ' + name + '（判据字典与 feat 分叉，直接报错退出）');
}
/** 本 feat 的三腿写动作（2105 是只读，不计写；2103 融冰归 ice-shake） */
const WRITE_CMDS = new Set([CMD_GET_CHEST, CMD_GET_GIFT, CMD_SECRET_GIFT]);

/**
 * 按键名升序拼串（逐键一致的判据表达成字符串相等，样本可直接肉眼比对）。
 * @param {object} o 载荷
 * @returns {string} 如 `x|y`
 */
function keysOf(o) {
  return o && typeof o === 'object' ? Object.keys(o).sort().join('|') : '';
}

/**
 * 中位数（小样本够用，不引依赖）。
 * @param {number[]} arr 数值数组（非空）
 * @returns {number}
 */
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/**
 * 众数（老家服号取 iceList initSid 的多数派；本录 6550 行全 3828，唯一即众数）。
 * @param {Map<number,number>} votes 值 → 票数
 * @returns {number|null} 空表回 null
 */
function modeOf(votes) {
  let best = null;
  let bestN = -1;
  for (const [v, n] of votes) if (n > bestN) ((best = v), (bestN = n));
  return best;
}

export default {
  id: 'cq26-feast',
  // 按会话起始串解析当前文件名（finalize 会改名，见 recByStart 注释）
  defaultRecs: [
    // 主样本（用户本场录制）：2103×116 + 2106×18 + 2108×12 + 2105×1；2104 零发（奖励宝箱腿出网判据落 skip）
    recByStart('20261109T205818'),
  ],

  // ── 现场态重建：单遍扫录制，feat 自己的 ingest 纯函数维护 running 缓存 ──
  async buildScan(recPath) {
    /** 22032 阶段时间线：{ts,state,gatherTime,beginTime,endTime,displayEndTime} */
    const phases = [];
    /** 22073 玩家快照时间线：{ts,giftCount,blue,feedCount,claimedIndexList,secretGiftCount} */
    const players = [];
    /** 22075 礼盒发奖：{ts,pointIndex,blue,claimedIndexList} */
    const giftRewards = [];
    /** 22064 巨熊宝藏全量快照：{ts,gifts:[{idStr,x,y,k,endtime}]} */
    const secretSnaps = [];
    /** 22072 额度快照：{ts,remainChestNum} */
    const quotaSnaps = [];
    /** 2106 写视图：{t,dir,bodyKeys,idx,phase,code} */
    const giftReqs = [];
    /** 2108 写视图：{t,dir,bodyKeys,idStr,idObj,received,endtime,code} */
    const secretReqs = [];
    /** 2104 写视图（本录零样本，逻辑保留待新录制）：{t,dir,bodyKeys,x,y,code} */
    const chestReqs = [];
    /** 2105 只读：{t,dir,bodyKeys,posListLen,code} */
    const openedReqs = [];
    /** req↔resp 合并暂存（按 rt 配对） */
    const giftPending = new Map();
    const secretPending = new Map();
    const chestPending = new Map();
    const openedPending = new Map();

    // running 现场态（全部经 feat 自己的纯函数写入，与线上引擎同口径）
    const chestCache = Object.create(null);
    const sidVotes = new Map();
    let curPhase = null;
    let curSecrets = new Map();

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => WRITE_CMDS.has(e.cmd),
        onEntry: (e) => {
          const b = e.body || {};
          // ① 地块真相：901 只在 resp 带 pointList/iceList（req:send 不带，dir 分支互斥坑）；iceList 只取 initSid 求老家服
          if (e.cmd === CMD_WORLD_INFO && e.dir === 'resp') {
            for (const r of b.iceList || [])
              if (r && r.initSid != null)
                sidVotes.set(Number(r.initSid), (sidVotes.get(Number(r.initSid)) || 0) + 1);
            ingestChestTiles(b.pointList, chestCache, e.ts);
            return;
          }
          // ② 10018 增量 push（pointInfos 315 行；iceList 只取 initSid 求老家服）
          if (e.cmd === PUSH_TILE && e.dir === 'push') {
            for (const r of b.iceList || [])
              if (r && r.initSid != null)
                sidVotes.set(Number(r.initSid), (sidVotes.get(Number(r.initSid)) || 0) + 1);
            ingestChestTiles(b.pointInfos, chestCache, e.ts);
            return;
          }
          // ③ 阶段机
          if (e.cmd === PUSH_PHASE && e.dir === 'push') {
            const fp = b.feastPhase;
            if (fp && typeof fp === 'object') {
              curPhase = Number(fp.state) || 0;
              phases.push({
                ts: e.ts,
                state: curPhase,
                gatherTime: Number(fp.gatherTime) || 0,
                beginTime: Number(fp.beginTime) || 0,
                endTime: Number(fp.endTime) || 0,
                displayEndTime: Number(fp.displayEndTime) || 0,
              });
            }
            return;
          }
          // ④ 玩家快照（claimed 权威）
          if (e.cmd === PUSH_PLAYER && e.dir === 'push') {
            const pl = b.player;
            if (pl && typeof pl === 'object')
              players.push({
                ts: e.ts,
                giftCount: Number(pl.giftCount) || 0,
                blue: Number(pl.blue) || 0,
                feedCount: Number(pl.feedCount) || 0,
                claimedIndexList: Array.isArray(pl.claimedIndexList)
                  ? pl.claimedIndexList.map(Number)
                  : [],
                secretGiftCount: Number(pl.secretGiftCount) || 0,
              });
            return;
          }
          // ⑤ 礼盒发奖（claimedIndexList 同为满集权威；奖励在 rewardResult.items）
          if (e.cmd === PUSH_GIFT_REWARD && e.dir === 'push') {
            giftRewards.push({
              ts: e.ts,
              pointIndex: b.pointIndex == null ? null : Number(b.pointIndex),
              blue: Number(b.blue) || 0,
              claimedIndexList: Array.isArray(b.claimedIndexList)
                ? b.claimedIndexList.map(Number)
                : [],
            });
            return;
          }
          // ⑥ 巨熊宝藏全量快照（整体替换 running 表；id 用 feat 自己的 reader 解串）
          if (e.cmd === PUSH_SECRET && e.dir === 'push') {
            const next = new Map();
            for (const r of Array.isArray(b.gift) ? b.gift : []) {
              const idStr = readGiftId(r);
              if (!idStr) continue;
              const pos = (r && r.pos) || {};
              next.set(idStr, {
                idStr,
                x: Number(pos.x) || 0,
                y: Number(pos.y) || 0,
                k: Number(pos.k) || 0,
                endtime: Number(r.endtime) || 0,
              });
            }
            curSecrets = next;
            secretSnaps.push({ ts: e.ts, gifts: [...next.values()] });
            return;
          }
          // ⑦ 额度权威
          if (e.cmd === PUSH_WL_INFO && e.dir === 'push') {
            if (b.remainChestNum != null)
              quotaSnaps.push({ ts: e.ts, remainChestNum: Number(b.remainChestNum) });
            return;
          }
          // ⑧ 三腿写视图：req 建条目（带发包那一刻的现场态快照），resp 按 rt 合并
          if (e.cmd === CMD_GET_GIFT && e.dir.startsWith('req')) {
            const rec = {
              t: e.ts,
              dir: e.dir,
              bodyKeys: keysOf(b),
              idx: b.pointIndex == null ? null : Number(b.pointIndex),
              phase: curPhase,
            };
            giftPending.set(e.ts, rec);
            giftReqs.push(rec);
            return;
          }
          if (e.cmd === CMD_GET_GIFT && e.dir === 'resp') {
            const rec = giftPending.get(e.rt);
            if (!rec) return;
            const head = e.header || (e.outer && e.outer.header) || null;
            rec.code = head && head.s != null ? Number(head.s) : null;
            rec.respKeys = keysOf(b); // 实录空体，键集应为 ''
            return;
          }
          if (e.cmd === CMD_SECRET_GIFT && e.dir.startsWith('req')) {
            const idStr = readGiftId({ id: b.id });
            const snap = curSecrets.get(idStr);
            const rec = {
              t: e.ts,
              dir: e.dir,
              bodyKeys: keysOf(b),
              idStr,
              idObj: isInt64Obj(b.id),
              received: b.received,
              endtime: snap ? snap.endtime : null,
            };
            secretPending.set(e.ts, rec);
            secretReqs.push(rec);
            return;
          }
          if (e.cmd === CMD_SECRET_GIFT && e.dir === 'resp') {
            const rec = secretPending.get(e.rt);
            if (!rec) return;
            const head = e.header || (e.outer && e.outer.header) || null;
            rec.code = head && head.s != null ? Number(head.s) : null;
            rec.rewardId = b.rewardId == null ? null : b.rewardId;
            return;
          }
          if (e.cmd === CMD_GET_CHEST && e.dir.startsWith('req')) {
            const rec = {
              t: e.ts,
              dir: e.dir,
              bodyKeys: keysOf(b),
              x: Number(b.x),
              y: Number(b.y),
            };
            chestPending.set(e.ts, rec);
            chestReqs.push(rec);
            return;
          }
          if (e.cmd === CMD_GET_CHEST && e.dir === 'resp') {
            const rec = chestPending.get(e.rt);
            if (!rec) return;
            const head = e.header || (e.outer && e.outer.header) || null;
            rec.code = head && head.s != null ? Number(head.s) : null;
            return;
          }
          if (e.cmd === CMD_OPENED_LIST && e.dir.startsWith('req')) {
            const rec = { t: e.ts, dir: e.dir, bodyKeys: keysOf(b) };
            openedPending.set(e.ts, rec);
            openedReqs.push(rec);
            return;
          }
          if (e.cmd === CMD_OPENED_LIST && e.dir === 'resp') {
            const rec = openedPending.get(e.rt);
            if (!rec) return;
            const head = e.header || (e.outer && e.outer.header) || null;
            rec.code = head && head.s != null ? Number(head.s) : null;
            rec.posListLen = Array.isArray(b.posList) ? b.posList.length : null;
          }
        },
      },
    );

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
      phases,
      players,
      giftRewards,
      secretSnaps,
      quotaSnaps,
      giftReqs,
      secretReqs,
      chestReqs,
      openedReqs,
      chestCache,
      originSid: modeOf(sidVotes),
    };
  },

  // ── 判据 ──────────────────────────────────────────────────────────────
  runVerify(S, rep) {
    const D1 = '载荷逐键形态与通道';
    const D3 = '礼盒腿（2106）';
    const D4 = '巨熊宝藏腿（2108）';
    const D5 = '奖励宝箱腿（2104/2105）';
    const D6 = '观察（不判负）';

    // 无盛宴样本闸门：绝不以空集冒充通过（伪 PASS 红线）
    if (!S.phases.length) {
      rep.check('本场无盛宴样本，不判定', D3, 0, 0, 1, []);
      rep.check('本场无盛宴样本，不判定', D4, 0, 0, 1, []);
      rep.check('本场无盛宴样本，不判定', D5, 0, 0, 1, []);
      return;
    }

    // D1（HARD）载荷逐键形态 + 通道：三腿写动作的线上键集与 feat 出网形状逐键一致
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      const note = (ok, msg) => {
        if (ok) pass++;
        else {
          fail++;
          if (samples.length < 6) samples.push(msg);
        }
      };
      for (const w of S.giftReqs) {
        note(w.bodyKeys === 'pointIndex', '2106 键集=' + w.bodyKeys + '（应 pointIndex）t=' + w.t);
        note(w.dir === 'req:sendPBV2', '2106 通道=' + w.dir);
      }
      for (const w of S.secretReqs) {
        note(
          w.bodyKeys === 'id|received',
          '2108 键集=' + w.bodyKeys + '（应 id|received）t=' + w.t,
        );
        note(w.received === true, '2108 received=' + JSON.stringify(w.received) + '（应 true）');
        note(w.idObj, '2108 id 非 {_low,_high} Int64 形态 t=' + w.t);
        note(w.dir === 'req:sendPBV2', '2108 通道=' + w.dir);
      }
      if (!S.giftReqs.length && !S.secretReqs.length)
        rep.check('本场无礼盒/巨熊宝藏写动作样本，不判定', D1, 0, 0, 1, []);
      else
        rep.check(
          '真人 2106={pointIndex} / 2108={id:Int64,received:true}，通道恒 sendPBV2',
          D1,
          pass,
          fail,
          0,
          samples,
        );
    }

    // D3a（HARD）礼盒点位域：pointIndex ∈ [0, GIFT_COUNT)
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const w of S.giftReqs) {
        if (Number.isInteger(w.idx) && w.idx >= 0 && w.idx < GIFT_COUNT) pass++;
        else {
          fail++;
          if (samples.length < 6) samples.push('2106 pointIndex=' + w.idx + ' 越界 t=' + w.t);
        }
      }
      if (!S.giftReqs.length) rep.check('本场无 2106 样本，不判定', D3, 0, 0, 1, []);
      else
        rep.check('真人 2106 pointIndex 皆在 [0,' + GIFT_COUNT + ')', D3, pass, fail, 0, samples);
    }

    // D3b（HARD，仿真侧）不重领重放：mergeClaimed+pickGiftIndex 乐观集语义 → 10 发无重复全覆盖
    {
      const auth = new Set();
      const opt = new Set();
      const simSends = [];
      for (let i = 0; i < GIFT_COUNT + 2; i++) {
        const idx = pickGiftIndex(mergeClaimed(auth, opt));
        if (idx < 0) break;
        simSends.push(idx);
        opt.add(idx); // 发送成功即加乐观集（feat legGift 语义）
      }
      const bad = [];
      if (simSends.length !== GIFT_COUNT)
        bad.push('仿真只产出 ' + simSends.length + ' 发（应 ' + GIFT_COUNT + '）');
      if (new Set(simSends).size !== simSends.length) bad.push('仿真出网有重复 idx：' + simSends);
      // 权威满集到货后乐观集应被完全覆盖（pruneClaimedOpt 语义：并集不变大）
      const finalAuth = S.players.length ? S.players[S.players.length - 1].claimedIndexList : [];
      const merged = mergeClaimed(finalAuth, opt);
      if (merged.size !== GIFT_COUNT)
        bad.push('权威满集到货后并集=' + merged.size + '（应 ' + GIFT_COUNT + '）');
      rep.check(
        '仿真侧：礼盒乐观集重放 ' + simSends.length + ' 发无重复、权威满集到货后并集收敛',
        D3,
        bad.length ? 0 : 1,
        bad.length,
        0,
        bad,
      );
    }

    // D3c（HARD，真值）礼盒每点位至多一次成功：同一 pointIndex 的 code=0 至多一发。
    //   被拒后重试到成功是合法的（本录 idx=0 序列 [3,3,3,3,0]：前 4 发撞 s=3、第 5 发才成功），
    //   故真值不是「第二发起必拒」，而是「成功不可重复」——feat 乐观集去重正依赖此语义。
    {
      const byIdx = new Map();
      for (const w of S.giftReqs) {
        if (!byIdx.has(w.idx)) byIdx.set(w.idx, []);
        byIdx.get(w.idx).push(w);
      }
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const [idx, list] of byIdx) {
        const okN = list.filter((w) => w.code === 0).length;
        if (!okN) {
          skip++; // 该 idx 全拒/未配对，无成功样本可判
          continue;
        }
        if (okN === 1) pass++;
        else {
          fail++;
          if (samples.length < 6)
            samples.push('idx=' + idx + ' 竟有 ' + okN + ' 发 code=0（成功应不可重复）');
        }
      }
      if (!pass && !fail)
        rep.check('真人礼盒无成功样本（或均未配对），不重领真值条不判定', D3, 0, 0, 1, []);
      else
        rep.check(
          '真人真值：每 pointIndex 至多一次成功（' +
            pass +
            ' 个点位各恰 1 发 code=0；被拒重试合法）⇒ feat 去重语义有据',
          D3,
          pass,
          fail,
          skip,
          samples,
        );
    }

    // D3d（HARD，真值）满集：真人末态 claimedIndexList == [0..GIFT_COUNT-1]
    {
      if (!S.players.length) {
        rep.check('本场无 22073 玩家快照，满集真值不判定', D3, 0, 0, 1, []);
      } else {
        const last = S.players[S.players.length - 1].claimedIndexList;
        const want = Array.from({ length: GIFT_COUNT }, (_, i) => i);
        const ok =
          last.length === want.length && [...last].sort((a, b) => a - b).join() === want.join();
        rep.check(
          '真人末态 claimedIndexList=[' +
            last +
            '] == 满集 [0..' +
            (GIFT_COUNT - 1) +
            ']（GIFT_COUNT 真值）',
          D3,
          ok ? 1 : 0,
          ok ? 0 : 1,
          0,
          ok ? [] : ['末态满集与 GIFT_COUNT=' + GIFT_COUNT + ' 分叉'],
        );
      }
    }

    // D3e（HARD）礼盒阶段闸：真人每发 2106 的时刻 phase==FEED
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const w of S.giftReqs) {
        if (w.phase == null) skip++;
        else if (w.phase === PHASE_FEED) pass++;
        else {
          fail++;
          if (samples.length < 6) samples.push('2106 出现在 phase=' + w.phase + ' t=' + w.t);
        }
      }
      if (!S.giftReqs.length) rep.check('本场无 2106 样本，阶段闸不判定', D3, 0, 0, 1, []);
      else rep.check('真人 2106 只出现在 FEED 期（22032 快照）', D3, pass, fail, skip, samples);
    }

    // D4a（HARD）巨熊宝藏 Int64 往返：真人 2108 的 id 解串后必在 22064 快照 id 集内
    {
      const snapIds = new Set();
      for (const s of S.secretSnaps) for (const g of s.gifts) snapIds.add(g.idStr);
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const w of S.secretReqs) {
        if (!w.idStr) {
          fail++;
          if (samples.length < 6) samples.push('2108 id 读空（reader 与报文分叉）t=' + w.t);
          continue;
        }
        if (!snapIds.size) {
          skip++;
          continue;
        }
        if (snapIds.has(w.idStr)) pass++;
        else {
          fail++;
          if (samples.length < 6) samples.push('2108 id=' + w.idStr + ' 不在任何 22064 快照内');
        }
      }
      if (!S.secretReqs.length) rep.check('本场无 2108 样本，不判定', D4, 0, 0, 1, []);
      else
        rep.check(
          '真人 2108 id 经 readGiftId 解串皆在 22064 快照集内（' + snapIds.size + ' 枚快照 id）',
          D4,
          pass,
          fail,
          skip,
          samples,
        );
    }

    // D4b（HARD，仿真侧）到点即抢：每枚快照巨熊宝藏 endtime+GRACE 起领、早 1s 不发
    {
      const byId = new Map();
      for (const s of S.secretSnaps) for (const g of s.gifts) byId.set(g.idStr, g);
      if (!byId.size) {
        rep.check('本场 22064 快照全空，巨熊宝藏时序不判定', D4, 0, 0, 1, []);
      } else {
        let pass = 0;
        let fail = 0;
        const samples = [];
        for (const g of byId.values()) {
          const ripe = secretReady(g, g.endtime + SECRET_GRACE_SEC);
          const early = secretReady(g, g.endtime + SECRET_GRACE_SEC - 1);
          if (ripe && !early) pass++;
          else {
            fail++;
            if (samples.length < 6)
              samples.push(
                'id=' + g.idStr + ' ripe=' + ripe + ' early=' + early + '（应 true/false）',
              );
          }
        }
        rep.check(
          '仿真侧：' +
            byId.size +
            ' 枚巨熊宝藏皆 endtime+' +
            SECRET_GRACE_SEC +
            's 起领、早 1s 不发（到点即抢）',
          D4,
          pass,
          fail,
          0,
          samples,
        );
      }
    }

    // D5a（HARD，仿真侧）奖励宝箱分线过滤：315 地块喂 pickBwlChests，NWL 箱不抢
    {
      const keys = Object.keys(S.chestCache);
      const bwlKeys = keys.filter((k) => S.chestCache[k].specIndex === 0);
      const nwlKeys = keys.filter((k) => S.chestCache[k].specIndex > 0);
      if (!bwlKeys.length) {
        rep.check('本场无 BWL(specIndex=0) 315 地块样本，不判定', D5, 0, 0, 1, []);
      } else {
        const picked = pickBwlChests(S.chestCache, {
          opened: new Set(),
          nowSec: Math.floor(S.maxTs / 1000),
          now: S.maxTs,
          ttlMs: Infinity, // 离线重建不考新鲜度（TTL 闸由单测覆盖）
          originSid: S.originSid,
        });
        const bad = [];
        if (!picked.ready.length) bad.push('BWL 地块 ' + bwlKeys.length + ' 格却选不出候选');
        for (const c of picked.ready)
          if (S.chestCache[c.key].specIndex !== 0) bad.push('ready 混入非 BWL 箱 ' + c.key);
        const visible = new Set([...picked.ready, ...picked.unknown].map((c) => c.key));
        for (const k of nwlKeys)
          if (visible.has(k)) bad.push('NWL 箱 ' + k + ' 入了本腿视野（应归 wl-chest）');
        rep.check(
          '仿真侧：315 地块 BWL×' +
            bwlKeys.length +
            ' / NWL×' +
            nwlKeys.length +
            ' → ready ' +
            picked.ready.length +
            ' 全 specIndex=0，NWL 零入视野',
          D5,
          bad.length ? 0 : 1,
          bad.length,
          0,
          bad,
        );
      }
    }

    // D5b（无样本记 skip）2104 出网载荷：本录零发，源码约束无录制真值
    {
      if (!S.chestReqs.length)
        rep.check(
          '2104 本录零样本 ⇒ 奖励宝箱出网载荷离线无法判定（形态按源码 CQ26WLWorldRewardBoxPop，需新录制补证）',
          D5,
          0,
          0,
          1,
          [],
        );
      else {
        let pass = 0;
        let fail = 0;
        const samples = [];
        for (const w of S.chestReqs) {
          if (w.bodyKeys === 'x|y' && w.dir === 'req:sendPBV2') pass++;
          else {
            fail++;
            if (samples.length < 6) samples.push('2104 键集=' + w.bodyKeys + ' 通道=' + w.dir);
          }
        }
        rep.check('真人 2104={x,y} 通道 sendPBV2', D5, pass, fail, 0, samples);
      }
    }

    // D5c（HARD 形态）2105 已开表：req {} → resp posList 数组
    {
      if (!S.openedReqs.length) {
        rep.check('本场无 2105 样本，不判定', D5, 0, 0, 1, []);
      } else {
        let pass = 0;
        let fail = 0;
        let skip = 0;
        const samples = [];
        for (const w of S.openedReqs) {
          if (w.bodyKeys !== '') {
            fail++;
            if (samples.length < 6) samples.push('2105 req 键集=' + w.bodyKeys + '（应空）');
            continue;
          }
          if (w.posListLen == null) skip++;
          else pass++;
        }
        rep.check(
          '2105 req={} → resp posList 数组（已开表只读形态）',
          D5,
          pass,
          fail,
          skip,
          samples,
        );
      }
    }

    // D6（OBSERVATION）节奏与收益量级：只报不判负
    {
      // 本 feat 写配对率：三腿 req 中按 rt 配到 resp 的比例。
      //   注意 S.pairedResp 是全场全局应答表（含 901/10018 等），不能做本 feat 的分母。
      const allReqs = [...S.giftReqs, ...S.secretReqs, ...S.chestReqs];
      const paired = allReqs.filter((w) => w.code != null).length;
      const pairRate = allReqs.length ? ((paired / allReqs.length) * 100).toFixed(0) : '0';
      rep.check(
        '本 feat 写配对率 ' +
          pairRate +
          '%（' +
          paired +
          '/' +
          allReqs.length +
          '；未配对=频控/超时/rt 碰撞，只作观察不判负）',
        D6,
        0,
        0,
        1,
        [],
      );
      // 2106 三分解：成功 / 被拒 / 未配对
      const giftOk = S.giftReqs.filter((w) => w.code === 0).length;
      const giftRej = S.giftReqs.filter((w) => w.code != null && w.code !== 0).length;
      const giftUnpaired = S.giftReqs.filter((w) => w.code == null).length;
      rep.check(
        '2106 ×' +
          S.giftReqs.length +
          '：成功 ×' +
          giftOk +
          ' / 被拒 ×' +
          giftRej +
          ' / 未配对 ×' +
          giftUnpaired +
          '（真人重复点/重试，feat 乐观集去重后不会出现）',
        D6,
        0,
        0,
        1,
        [],
      );
      // 2108 三分解 + 抢发延迟（仅 endtime>0 可对照；feat grace=0 到点即抢，与游戏闸同口径）
      const secOk = S.secretReqs.filter((w) => w.code === 0).length;
      const secRej = S.secretReqs.filter((w) => w.code != null && w.code !== 0).length;
      const secUnpaired = S.secretReqs.filter((w) => w.code == null).length;
      const delays = S.secretReqs
        .filter((w) => Number.isFinite(w.endtime) && w.endtime > 0)
        .map((w) => w.t / 1000 - w.endtime);
      const delayText = delays.length
        ? '可对照 ' +
          delays.length +
          ' 发抢发延迟 ' +
          Math.min(...delays).toFixed(1) +
          '~' +
          Math.max(...delays).toFixed(1) +
          's（中位 ' +
          median(delays).toFixed(1) +
          's；feat grace=' +
          SECRET_GRACE_SEC +
          's 到点即抢）'
        : '无 endtime 对照';
      rep.check(
        '2108 ×' +
          S.secretReqs.length +
          '：成功 ×' +
          secOk +
          ' / 被拒 ×' +
          secRej +
          ' / 未配对 ×' +
          secUnpaired +
          '｜' +
          delayText,
        D6,
        0,
        0,
        1,
        [],
      );
      rep.check(
        '阶段时间线 ' +
          S.phases.map((p) => p.state).join('→') +
          '｜22072 额度轨迹 ' +
          S.quotaSnaps.map((q) => q.remainChestNum).join('→'),
        D6,
        0,
        0,
        1,
        [],
      );
    }
  },
};
