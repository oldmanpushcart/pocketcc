/**
 * CQ26 雪原列车 feat · 录制仿真对拍 Manifest（第四个消费者 / 到站结算 lane 首次建基线）。
 *
 * 与 secret-realm / cs-hunt / radar-task 同层：只声明本 feat 的协议号、现场态与闸门规则，
 * 读录制、二分回溯、Int64 归一、应答配对、报告打印、退出码全交给 scripts/replay/。
 *
 * 运行：node scripts/replay/run.mjs --manifest cq26-train [录制...] [--verbose]
 *
 * 校验维度（真人录制对齐 feat 同一份协议字典）：
 *   载荷逐键形态（2373 单键 / 2386 {uuid,index} / 2385 第 1 页省略 pageId / 2367·2370 {troop,uuid} + troop 四键）
 *   目标 uuid 来源闸（结算=主体车 lastTrain 优先、禁 curTrain 回落；2367=当前车；2370=2369 列表项）
 *   结算资格闸（state=30 ∧ selfOn=1 ∧ 结算窗未过，三条件同时成立才允许写）
 *   领奖一次性（发 2373 前 baseRewardGet 必为 0、成功后首个权威源必为 1、同车不重复领）
 *   翻卡配额单调（shareRewardHaveNum 非增、成功笔数 == 起始-结束差、归 0 后不再发）
 *   卡位选择自洽（只翻已读未翻位 / index 不重复 / 应答 cardInfo.index 回显请求位）
 *   分页语义（缺 pageId ⇒ 服务端回 1、pageSize == feat 常量、index 区间 == 全局 32 个一页）
 *   盲翻判据契约（无 reward.itemId 的项必无 userView——feat 未翻位判据的前提）
 *   发送通道分派（dir == feat send() 里的 protocol 字面量）/ 22096 与应答字段一致 / 配对率与节奏（观察）。
 *
 * 协议字典来源：本 feat 是单文件浏览器模块且**零导出**（radar-task 那种「桩化全局后 import 取常量」
 *   在此不可用），为守住「判据不与 feat 分叉」红线，此处直接从 feat 源码文本抽取 `const CMD_* = …`
 *   与 send() 的 protocol 字面量——抽不到即抛错，宁可跑不起来也不手抄一份字典。
 *
 * dir/字段实测（写判据前已用 .reviewtmp/cq26-train-probe*.mjs 探针核对，避免不可达分支）：
 *   本族 req 恒 dir='req:sendPBV2'（仅 2376 属 V1 send，本 feat 不发）；resp 的 data={header,data}，
 *   header.s 即业务码、header.ts 为服务器秒且与 rt/1000 同尺度（实测差 <1s，故「窗未过」直接比本地 ts）。
 *   内核 writes.req 走 raw.data，实测与 entry.body 逐键等值（sendPBV2 无业务槽间接，坑 5 不适用），
 *   本 manifest 仍自建 req 视图（reqPending）：形态判据要的是「线上真正发出的键集」，且 req↔resp 合并成一条。
 *   2365 应答 curTrain/lastTrain 在本组三场录制里**始终同对象**（跨零点 lastTrain≠curTrain 样本缺失），
 *   故「结算主体取 lastTrain」这条只有约束力、无区分度——单独作为观察项如实标注，不冒充已验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanNDJSON, snapshotAt } from '../replay/reader.mjs';
import { toNum, isInt64Obj } from '../replay/int64.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEAT = path.join(ROOT, 'extension/src/feats/cq26/train/index.js');

// ── 协议字典：从 feat 源码文本取常量（单一真相源，缺符号即抛）──────────────
const SRC = fs.readFileSync(FEAT, 'utf8');

/**
 * 抽 feat 源码里的 `const NAME = <数字字面量>;`。
 * @param {string} name 常量名
 * @returns {number} 常量值
 */
function featNum(name) {
  const m = SRC.match(new RegExp('^const ' + name + ' = (\\d+);', 'm'));
  if (!m) throw new Error('feat 源码里找不到常量 ' + name + '（判据字典与 feat 分叉，拒绝跑）');
  return Number(m[1]);
}

const CMD_OPEN = featNum('CMD_OPEN');
const CMD_MARCH = featNum('CMD_MARCH');
const CMD_LIST = featNum('CMD_LIST');
const CMD_LOOT = featNum('CMD_LOOT');
const CMD_INFO = featNum('CMD_INFO');
const CMD_REWARD = featNum('CMD_REWARD');
const CMD_CARD_LIST = featNum('CMD_CARD_LIST');
const CMD_CARD_FLIP = featNum('CMD_CARD_FLIP');
const PUSH_TRAIN_DATA = featNum('PUSH_TRAIN_DATA');
const ST_GET_ON = featNum('ST_GET_ON');
const ST_ROAD = featNum('ST_ROAD');
const ST_REWARD = featNum('ST_REWARD');
const CARD_PAGE_SIZE = featNum('CARD_PAGE_SIZE');
const HIT_GAP_MS = featNum('HIT_GAP_MS');

/** feat 唯一发包门面 send() 声明的通道（dir 判据的真相源） */
const PROTO = (SRC.match(
  /async function send\(cmd, body\)[\s\S]{0,600}?protocol:\s*'(sendPBV2|sendPB|send)'/,
) || [])[1];
if (!PROTO) throw new Error('feat 源码里探不到 send() 的 protocol 字面量');
/** 期望的 req 线上形态（内核 dir 实测值 = 'req:' + 通道名） */
const REQ_DIR = 'req:' + PROTO;

/** 需逐笔回查现场态的写动作（2365/2369/2375 属纯读查询，不计入） */
const WRITE_CMDS = new Set([CMD_MARCH, CMD_LOOT, CMD_REWARD, CMD_CARD_LIST, CMD_CARD_FLIP]);
/**
 * 面板/UI 类协议：真人点了才会出现，feat 按设计**不发**，只做量级观察（不进任何 HARD 判据）。
 * 其中 2376/2377/2378/2384 在本 feat 无对应常量（正因为不发才没有），故此处只能落字面量。
 */
const PANEL_CMDS = new Map([
  [CMD_INFO, '2375 他人列车详情'],
  [2377, '2377 防守名单（实测应答 172KB 级，纯面板）'],
  [2378, '2378 单个防守者详情'],
  [2384, '2384 刷新奖励（用户定案不做）'],
  [2376, '2376 地图行军信息（V1 send）'],
]);

/** troop 四键实证形态（2367/2370 共用，与 truck-intercept 的 buildTroop 同构） */
const TROOP_KEYS = ['armyPosList', 'extraArmyPos', 'formationV2', 'heroList'].sort();

/** Int64 → 稳定串键（(high:low) 原样比，不做 Number 以免精度陷阱） */
function uuidKey(v) {
  if (v == null) return '';
  if (isInt64Obj(v)) return v._high + ':' + v._low;
  const n = toNum(v);
  return Number.isFinite(n) ? 'num:' + n : '';
}

/** 载荷键集（排序） */
function keysOf(o) {
  return Object.keys(o || {}).sort();
}

/** 键集是否等于期望集 */
function sameKeys(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * 2385 cardInfoList 拆未翻位/已翻位（feat 未翻位判据 = !reward.itemId）。
 * @param {Array<object>} list 应答里的 cardInfoList
 * @returns {{unflipped:number[],flipped:number[],ghosts:number[],dark:number[]}} ghosts/dark 为畸形项（判据前提违例）
 */
function splitSlots(list) {
  const unflipped = [];
  const flipped = [];
  const ghosts = []; // 无 reward 却带 userView：feat 会误判成未翻位
  const dark = []; // 有 reward 却无 userView：翻卡人信息缺失
  for (const c of list) {
    if (!c || !Number(c.index)) continue;
    if (c.reward && Number(c.reward.itemId) > 0) {
      flipped.push(Number(c.index));
      if (!c.userView) dark.push(Number(c.index));
    } else {
      unflipped.push(Number(c.index));
      if (c.userView) ghosts.push(Number(c.index));
    }
  }
  return { unflipped, flipped, ghosts, dark };
}

/**
 * 2365 应答 → 主体车快照（投影口径与 feat readSnapshot 逐字一致：
 *   主体 = lastTrain 有 baseInfo 则取 lastTrain，否则 curTrain）。
 * @param {object} e 录制 entry（dir 必为 resp）
 * @returns {object} 时间线一条
 */
function projectOpen(e) {
  const d = e.body && typeof e.body === 'object' ? e.body : {};
  const ct = d.curTrain || null;
  const lt = d.lastTrain || null;
  const sl = lt && lt.baseInfo ? lt : ct;
  const bi = (sl && sl.baseInfo) || {};
  const cbi = (ct && ct.baseInfo) || {};
  const times = Array.isArray(bi.times) ? bi.times : [];
  const w30 = times.find((x) => Number(x.state) === ST_REWARD) || null;
  const k = uuidKey(bi.uuid);
  return {
    ts: e.ts,
    src: '2365',
    state: Number(bi.state) || 0,
    selfOn: Number(sl && sl.selfOn) || 0,
    got: Number(sl && sl.baseRewardGet) || 0,
    share: Number(sl && sl.shareRewardHaveNum) || 0,
    uuidKey: k,
    curKey: uuidKey(cbi.uuid),
    settleEnd: Number(w30 && w30.eTime) || Number(bi.stateEndTime) || 0,
    sameObj: k !== '' && k === uuidKey(cbi.uuid),
  };
}

/**
 * 22096 列车态回推 → 主体车快照（它只带一辆车，即当前发生变化的那辆）。
 * @param {object} e 录制 entry（dir 必为 push）
 * @returns {object|null}
 */
function projectPush(e) {
  const t = (e.body && e.body.train) || null;
  if (!t) return null;
  const bi = t.baseInfo || {};
  const k = uuidKey(bi.uuid);
  return {
    ts: e.ts,
    src: '22096',
    state: Number(bi.state) || 0,
    selfOn: Number(t.selfOn) || 0,
    got: Number(t.baseRewardGet) || 0,
    share: Number(t.shareRewardHaveNum) || 0,
    uuidKey: k,
    curKey: k,
    settleEnd: Number(bi.stateEndTime) || 0,
    sameObj: true,
  };
}

export default {
  id: 'cq26-train',
  defaultRecs: [
    // 到站结算现场：2373 领奖 + 2385 分页 + 2386×3 翻卡（lane 3 的唯一真人样本）
    'dashcam/store/rec/11981629951662/dashcam-rec-20261107T203829-印石-我的日常.ndjson',
    // 上车现场（state=10）：2367 troop 形态 + 「上车 uuid 必取当前车」对照样本
    'dashcam/store/rec/11981629951662/dashcam-rec-20261107T002336-印石-我的日常.ndjson',
    // 掠夺现场（state=20）：2370 troop 形态 + 目标 uuid 必来自 2369 列表
    'dashcam/store/rec/11981629951662/dashcam-rec-20261107T142705-印石-我的日常.ndjson',
  ],

  // ── 现场态重建：单遍扫录制，主体车时间线 + req↔resp 合并的写视图 ──────────
  async buildScan(recPath) {
    /** 主体车时间线（2365 快照 + 22096 回推合并）：{ts,src,state,selfOn,got,share,uuidKey,curKey,settleEnd,sameObj} */
    const settleTimeline = [];
    /** 2369 列表项 uuid（按 ts）：掠夺目标的合法来源集 */
    const listKeys = [];
    /** 写视图：reqTs -> {t,cmd,reqKeys,body,uuidKey,…}，应答字段就地合并到同一条 */
    const reqPending = new Map();
    const panelCounts = new Map();
    const dirCensus = new Map();
    let clockDelta = null;
    let uidProbe = null;

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => WRITE_CMDS.has(e.cmd),
        onEntry: (e) => {
          const cmd = e.cmd;
          if (WRITE_CMDS.has(cmd) || PANEL_CMDS.has(cmd) || cmd === CMD_LIST) {
            const dk = cmd + '|' + e.dir;
            dirCensus.set(dk, (dirCensus.get(dk) || 0) + 1);
          }

          // ① 现场态源**先行**分派：2365 应答 / 22096 回推 / 2369 列表都须先入时间线。
          //   踩过的坑（dir 分支互斥）：曾把 2365 的 resp 落在下面 req↔resp 合并分支里被提前 return
          //   整条丢弃，同时 2365 的 req（空体）反而被投影成 uuidKey 为空的僵尸快照，回查全走 skip。
          if (cmd === CMD_OPEN && e.dir === 'resp') {
            settleTimeline.push(projectOpen(e));
            return;
          }
          if (cmd === PUSH_TRAIN_DATA && e.dir === 'push') {
            const p = projectPush(e);
            if (p) settleTimeline.push(p);
            return;
          }
          if (cmd === CMD_LIST && e.dir === 'resp') {
            const trains = e.body && Array.isArray(e.body.trains) ? e.body.trains : [];
            for (const tr of trains) listKeys.push({ ts: e.ts, key: uuidKey(tr && tr.uuid) });
            return;
          }
          if (e.dir === 'resp' && e.header && e.header.ts != null && e.rt)
            clockDelta = Number(e.header.ts) - e.rt / 1000;

          // ② 写视图：req 建条目、resp 按 rt 合并到同一条
          if (e.dir.startsWith('req')) {
            if (PANEL_CMDS.has(cmd)) {
              panelCounts.set(cmd, (panelCounts.get(cmd) || 0) + 1);
              if (cmd === 2378 && e.body && e.body.uid != null)
                uidProbe = String(toNum(e.body.uid));
              return;
            }
            if (!WRITE_CMDS.has(cmd)) return;
            const k = keysOf(e.body);
            const rec = {
              t: e.ts,
              cmd,
              reqKeys: k,
              body: e.body || {},
              uuidKey: uuidKey(e.body && e.body.uuid),
            };
            if (cmd === CMD_CARD_FLIP) rec.index = Number(e.body && e.body.index);
            else if (cmd === CMD_CARD_LIST) {
              rec.hasPageId = k.includes('pageId');
              rec.pageIdReq = Number(e.body && e.body.pageId);
              rec.needEmpty = e.body && 'needEmpty' in e.body ? Number(e.body.needEmpty) : null;
            } else if (cmd === CMD_MARCH || cmd === CMD_LOOT)
              rec.troopKeys = keysOf(e.body && e.body.troop);
            reqPending.set(e.ts, rec);
            return;
          }

          if (e.dir === 'resp') {
            const head = e.header || (e.outer && e.outer.header) || null;
            const code = head && head.s != null ? Number(head.s) : null;
            const rec = reqPending.get(e.rt);
            if (!rec) return;
            const d = e.body && typeof e.body === 'object' ? e.body : {};
            rec.code = code;
            rec.ts = e.ts;
            rec.respKeys = keysOf(d);
            if (cmd === CMD_REWARD) {
              const rr = d.rewardResult;
              rec.hasRewardResult = !!(rr && typeof rr === 'object');
              rec.items = rr && Array.isArray(rr.items) ? rr.items.length : -1;
            } else if (cmd === CMD_CARD_FLIP) {
              rec.share = 'shareRewardHaveNum' in d ? Number(d.shareRewardHaveNum) : null;
              rec.cardIdx = d.cardInfo ? Number(d.cardInfo.index) : null;
              rec.itemId =
                d.cardInfo && d.cardInfo.reward ? Number(d.cardInfo.reward.itemId) : null;
            } else if (cmd === CMD_CARD_LIST) {
              const list = Array.isArray(d.cardInfoList) ? d.cardInfoList : [];
              Object.assign(rec, splitSlots(list), {
                pageId: Number(d.pageId),
                pageSize: Number(d.pageSize),
                all: Number(d.allRewardNum) || 0,
                empty: d.emptyRewardNum != null ? Number(d.emptyRewardNum) : null,
                selfAll: Number(d.selfRewardAllNum) || 0,
                share: 'shareRewardHaveNum' in d ? Number(d.shareRewardHaveNum) : null,
                listLen: list.length,
              });
            }
            return;
          }
        },
      },
    );

    settleTimeline.sort((a, b) => a.ts - b.ts);
    /** 2365 快照子集（已按 ts 升序）：供「2367 取当前车 uuid」回查 */
    const openSnaps = settleTimeline.filter((x) => x.src === '2365');
    listKeys.sort((a, b) => a.ts - b.ts);
    const reqs = [...reqPending.values()];
    const byCmd = (c) => reqs.filter((x) => x.cmd === c);

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
      clockDelta,
      uidProbe,
      settleTimeline,
      openSnaps,
      listKeys,
      panelCounts,
      dirCensus,
      rewardReqs: byCmd(CMD_REWARD),
      flipReqs: byCmd(CMD_CARD_FLIP),
      pageReqs: byCmd(CMD_CARD_LIST),
      boardReqs: byCmd(CMD_MARCH),
      lootReqs: byCmd(CMD_LOOT),
    };
  },

  // ── 判据 ──────────────────────────────────────────────────────────────
  runVerify(S, rep) {
    const D1 = '载荷逐键形态';
    const D2 = '目标 uuid 来源闸';
    const D3 = '结算资格闸';
    const D4 = '领奖一次性';
    const D5 = '翻卡配额单调';
    const D6 = '卡位选择自洽';
    const D7 = '分页语义';
    const D8 = '盲翻判据契约';
    const D9 = '发送通道与链路';
    const D10 = '推送一致性';
    const D11 = '节奏与链路质量（观察）';
    const D12 = '面板类协议（观察）';

    /**
     * 无样本闸门：本族写动作为空时记「无法判定」，绝不以空集冒充通过（伪 PASS 红线）。
     * @param {number} n 该维度的样本数
     * @param {string} dim 维度名
     * @param {string} label 判据名
     * @returns {boolean} true = 有样本，可继续判据
     */
    const has = (n, dim, label) => {
      if (n > 0) return true;
      rep.check(label + '：本场无该族写样本，不判定', dim, 0, 0, 1, []);
      return false;
    };

    const settleWrites = [...S.rewardReqs, ...S.flipReqs, ...S.pageReqs];

    // D1 每类写请求的键集必须与录制逐键一致（feat 侧多一键少一键都算违例）
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      const want = new Map([
        [CMD_REWARD, ['uuid']],
        [CMD_CARD_FLIP, ['index', 'uuid']],
        [CMD_MARCH, ['troop', 'uuid']],
        [CMD_LOOT, ['troop', 'uuid']],
      ]);
      for (const w of settleWrites.concat(S.boardReqs, S.lootReqs)) {
        if (w.cmd === CMD_CARD_LIST) continue;
        const exp = want.get(w.cmd);
        if (!exp) {
          skip++;
          continue;
        }
        if (sameKeys(w.reqKeys, exp)) pass++;
        else {
          fail++;
          samples.push(`cmd=${w.cmd} req={${w.reqKeys.join(',')}} 期望={${exp.join(',')}}`);
        }
      }
      for (const p of S.pageReqs) {
        const ok =
          sameKeys(p.reqKeys, ['needEmpty', 'uuid']) ||
          sameKeys(p.reqKeys, ['needEmpty', 'pageId', 'uuid']);
        if (ok) pass++;
        else {
          fail++;
          samples.push(`2385 req={${p.reqKeys.join(',')}} 期望={needEmpty,uuid} 或加 pageId`);
        }
        if (p.needEmpty !== 0 && p.needEmpty !== 1) {
          fail++;
          samples.push(`2385 needEmpty=${p.needEmpty} 非 0/1`);
        }
      }
      for (const b of S.boardReqs.concat(S.lootReqs)) {
        if (!b.troopKeys || !b.troopKeys.length) {
          skip++;
          continue;
        }
        if (sameKeys(b.troopKeys, TROOP_KEYS)) pass++;
        else {
          fail++;
          samples.push(`troop={${b.troopKeys.join(',')}} 期望={${TROOP_KEYS.join(',')}}`);
        }
      }
      rep.check('写请求键集与录制逐键一致', D1, pass, fail, skip, samples);
    }

    // D2 uuid 必须是「发包那一刻」的合法来源，且结算族禁 curTrain 回落
    if (has(settleWrites.length + S.boardReqs.length + S.lootReqs.length, D2, 'uuid 来源')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const w of settleWrites) {
        const sn = snapshotAt(S.settleTimeline, w.t);
        if (!sn || !sn.uuidKey) {
          skip++;
          continue;
        }
        if (!isInt64Obj(w.body.uuid)) {
          fail++;
          samples.push(
            `cmd=${w.cmd} uuid 非 Int64 对象形态（${typeof w.body.uuid}）→ 类型/精度不符`,
          );
          continue;
        }
        if (w.uuidKey === sn.uuidKey) pass++;
        else {
          fail++;
          samples.push(`cmd=${w.cmd} uuid=${w.uuidKey} ≠ 主体车=${sn.uuidKey}（src=${sn.src}）`);
        }
      }
      for (const w of S.boardReqs) {
        const sn = snapshotAt(S.openSnaps, w.t);
        if (!sn || !sn.curKey) {
          skip++;
          continue;
        }
        if (w.uuidKey === sn.curKey) pass++;
        else {
          fail++;
          samples.push(`2367 uuid=${w.uuidKey} ≠ curTrain=${sn.curKey}（把兵派上了别的车）`);
        }
      }
      for (const w of S.lootReqs) {
        const seen = [];
        for (const x of S.listKeys) if (x.ts <= w.t) seen.push(x.key);
        if (!seen.length) {
          skip++;
          continue;
        }
        if (seen.includes(w.uuidKey)) pass++;
        else {
          fail++;
          samples.push(`2370 uuid=${w.uuidKey} 不在此前 2369 列表 ${seen.length} 项中`);
        }
      }
      rep.check(
        'uuid 来源 = 发包那一刻的权威快照/列表（Int64 原形态）',
        D2,
        pass,
        fail,
        skip,
        samples,
      );
    }
    // D3 state=30 ∧ selfOn=1 ∧ 窗未过，三条件同时成立才允许结算写
    if (has(settleWrites.length, D3, '结算写资格')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const w of settleWrites) {
        const sn = snapshotAt(S.settleTimeline, w.t);
        if (!sn || !sn.uuidKey) {
          skip++;
          continue;
        }
        const endOk = sn.settleEnd > 0 && w.t / 1000 <= sn.settleEnd + 2;
        if (sn.state === ST_REWARD && sn.selfOn === 1 && endOk) pass++;
        else {
          fail++;
          samples.push(
            `cmd=${w.cmd} state=${sn.state} selfOn=${sn.selfOn} 窗止=${sn.settleEnd} 此刻=${Math.floor(w.t / 1000)} src=${sn.src}`,
          );
        }
      }
      rep.check('结算写只发生在 state=30 ∧ 已上车 ∧ 窗未过', D3, pass, fail, skip, samples);
    }

    // D4 领奖一次性：发前 got=0，成功后首个权威源 got=1，同车不得重复成功领
    if (has(S.rewardReqs.length, D4, '2373 领奖')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      const byTrain = new Map();
      for (const w of S.rewardReqs) {
        if (!byTrain.has(w.uuidKey)) byTrain.set(w.uuidKey, []);
        byTrain.get(w.uuidKey).push(w);
      }
      for (const [key, list] of byTrain) {
        const ok = list.filter((x) => x.code === 0).length;
        if (ok > 1) {
          fail++;
          samples.push(`列车 ${key} 有 ${ok} 次 2373 成功应答（一次性闸失守）`);
        } else pass++;
        if (!list.length) skip++;
      }
      for (const w of S.rewardReqs) {
        const before = S.settleTimeline.filter((x) => x.ts < w.t).pop();
        if (!before || !before.uuidKey) {
          skip++;
          continue;
        }
        if (before.got === 0) pass++;
        else {
          fail++;
          samples.push(`发 2373 前主体已 got=${before.got}（src=${before.src}）→ 重复领奖风险`);
        }
        const after = S.settleTimeline.find((x) => x.ts > (w.ts || w.t) && x.uuidKey === w.uuidKey);
        if (!after) {
          skip++;
          continue;
        }
        if (w.code !== 0) pass++;
        else if (after.got === 1) pass++;
        else {
          fail++;
          samples.push(`2373 成功后 ${after.src} 仍 got=${after.got}（feat 乐观置位会与之打架）`);
        }
      }
      rep.check('2373 一次性：发前未领、成功后即置 1', D4, pass, fail, skip, samples);
    }

    // D5 翻卡配额（服务器权威 shareRewardHaveNum）单调不增 + 笔数守恒 + 归 0 即停
    if (has(S.flipReqs.length, D5, '2386 翻卡配额')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      const seq = [];
      for (const x of S.settleTimeline)
        if (x.state === ST_REWARD) seq.push({ t: x.ts, v: x.share, from: x.src });
      for (const p of S.pageReqs)
        if (p.share != null) seq.push({ t: p.ts || p.t, v: p.share, from: '2385' });
      for (const f of S.flipReqs)
        if (f.share != null) seq.push({ t: f.ts || f.t, v: f.share, from: '2386' });
      seq.sort((a, b) => a.t - b.t);
      for (let i = 1; i < seq.length; i++) {
        if (seq[i].v <= seq[i - 1].v) pass++;
        else {
          fail++;
          samples.push(
            `share 回升 ${seq[i - 1].v}→${seq[i].v}（${seq[i - 1].from} → ${seq[i].from}）→ 权威值不可信或取错了车`,
          );
        }
      }
      const okFlips = S.flipReqs.filter((f) => f.code === 0).length;
      if (!seq.length || !S.flipReqs.length) {
        skip++;
      } else {
        const first = seq[0].v;
        const last = seq[seq.length - 1].v;
        if (okFlips === first - last) pass++;
        else {
          fail++;
          samples.push(`成功翻卡 ${okFlips} 笔 ≠ share 消耗 ${first}→${last}`);
        }
      }
      const zeroAt = seq.findIndex((x) => x.v === 0);
      if (zeroAt < 0) skip++;
      else {
        const zt = seq[zeroAt].t;
        const late = S.flipReqs.filter((f) => f.t > zt && f.code === 0);
        if (late.length) {
          fail++;
          samples.push(`share 归 0 后仍有 ${late.length} 笔成功翻卡 → 配额闸没取权威值`);
        } else pass++;
      }
      rep.check('2386 次数守恒于 shareRewardHaveNum、归 0 即停', D5, pass, fail, skip, samples);
    }

    // D6 feat 策略「只翻 2385 已读到的未翻位」+ 应答回显同位
    if (has(S.flipReqs.length, D6, '卡位选择')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      const used = new Set();
      for (const f of S.flipReqs) {
        if (!Number.isFinite(f.index) || f.index <= 0) {
          fail++;
          samples.push(`2386 index=${f.index} 非法`);
          continue;
        }
        if (used.has(f.index)) {
          fail++;
          samples.push(`index=${f.index} 重复翻（feat 发后必须摘位）`);
        } else if (f.code === 0) used.add(f.index);
        const known = [];
        for (const p of S.pageReqs)
          if ((p.ts || p.t) <= f.t && p.unflipped) known.push(...p.unflipped);
        if (!known.length) {
          skip++;
          continue;
        }
        if (known.includes(f.index)) pass++;
        else {
          fail++;
          samples.push(`index=${f.index} 不在已读未翻位集合（${known.length} 项）内`);
        }
        if (f.code === 0 && f.cardIdx != null) {
          if (f.cardIdx === f.index) pass++;
          else {
            fail++;
            samples.push(`应答 cardInfo.index=${f.cardIdx} ≠ 请求 ${f.index}`);
          }
          if (Number(f.itemId) > 0) pass++;
          else skip++; // 位被他人先翻：合法业务结果，不作形态违例
        }
      }
      rep.check('只翻已读未翻位 + index 不重复 + 应答回显同位', D6, pass, fail, skip, samples);
    }

    // D7 分页语义：缺 pageId ⇒ 服务端回 1；pageSize == feat 常量；index 全局 32 个一页
    if (has(S.pageReqs.length, D7, '2385 分页')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const p of S.pageReqs) {
        if (p.code !== 0 || !Number.isFinite(p.pageId)) {
          skip++;
          continue;
        }
        if (!p.hasPageId) {
          if (p.pageId === 1) pass++;
          else {
            fail++;
            samples.push(
              `req 省略 pageId 却回 pageId=${p.pageId}（feat「第 1 页省略」的前提不成立）`,
            );
          }
        } else if (p.pageIdReq === p.pageId) pass++;
        else {
          fail++;
          samples.push(`req.pageId=${p.pageIdReq} ≠ resp.pageId=${p.pageId}`);
        }
        if (p.pageSize === CARD_PAGE_SIZE) pass++;
        else {
          fail++;
          samples.push(
            `pageSize=${p.pageSize} ≠ feat CARD_PAGE_SIZE=${CARD_PAGE_SIZE}（分页大小变了，扫页上限要跟着改）`,
          );
        }
        const idxs = p.unflipped.concat(p.flipped).sort((a, b) => a - b);
        if (idxs.length <= p.listLen) pass++;
        else {
          fail++;
          samples.push(`拆出 index ${idxs.length} 项 > listLen=${p.listLen}`);
        }
        if (idxs.length) {
          const lo = (p.pageId - 1) * p.pageSize + 1;
          const hi = p.pageId * p.pageSize;
          if (idxs[0] >= lo && idxs[idxs.length - 1] <= hi) pass++;
          else {
            fail++;
            samples.push(
              `page ${p.pageId} 的 index[${idxs[0]}..${idxs[idxs.length - 1]}] 越出 [${lo}..${hi}]`,
            );
          }
        } else skip++;
        if (p.all > 0) {
          const maxPage = Math.ceil(p.all / p.pageSize);
          if (p.pageId <= maxPage) pass++;
          else {
            fail++;
            samples.push(`pageId=${p.pageId} > ceil(${p.all}/${p.pageSize})=${maxPage}`);
          }
        } else skip++;
      }
      rep.check(
        'pageId 全局分页语义（缺省回 1 / 区间连续 / 不越奖池）',
        D7,
        pass,
        fail,
        skip,
        samples,
      );
    }

    // D8 盲翻未翻位判据的前提：无 reward.itemId ⇔ 无 userView
    if (has(S.pageReqs.length, D8, '未翻位判据')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const p of S.pageReqs) {
        if (p.code !== 0 || !p.listLen) {
          skip++;
          continue;
        }
        if (p.ghosts.length || p.dark.length) {
          fail++;
          samples.push(
            `page ${p.pageId}: 无 reward 带 userView ${p.ghosts.length} 项 / 有 reward 无 userView ${p.dark.length} 项 → feat 未翻位判据须改`,
          );
        } else pass++;
        if (p.empty != null && p.all > 0) {
          if (p.empty >= 0 && p.empty <= p.all) pass++;
          else {
            fail++;
            samples.push(`emptyRewardNum=${p.empty} 越出 [0,${p.all}]`);
          }
        } else skip++;
      }
      rep.check('未翻位判据契约（!reward.itemId ⇔ 无 userView）', D8, pass, fail, skip, samples);
    }

    // D9 写动作通道必须恒等于 feat send() 声明的 protocol
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const [dk, n] of S.dirCensus) {
        const i = dk.indexOf('|');
        const cmd = Number(dk.slice(0, i));
        const dir = dk.slice(i + 1);
        if (!dir.startsWith('req:') || !WRITE_CMDS.has(cmd)) continue;
        if (dir === REQ_DIR) pass += n;
        else {
          fail += n;
          samples.push(
            `cmd=${cmd} dir=${dir} ≠ feat 声明的 ${REQ_DIR}（通道分派变了，send() 需改）`,
          );
        }
      }
      rep.check(`写动作线上通道恒为 ${REQ_DIR}`, D9, pass, fail, 0, samples);
    }

    // D10 写请求后紧邻的 22096 回推字段必须与应答同值（feat 靠它做权威闸门）
    if (has(S.rewardReqs.length + S.flipReqs.length, D10, '22096 回推一致性')) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const f of S.flipReqs) {
        if (f.code !== 0 || f.share == null) continue;
        const at = f.ts || f.t;
        const push = S.settleTimeline.find(
          (x) => x.src === '22096' && x.ts >= at - 1 && x.ts <= at + 5000,
        );
        if (!push) {
          skip++;
          continue;
        }
        if (push.share === f.share) pass++;
        else {
          fail++;
          samples.push(
            `2386 应答 share=${f.share} 而 22096 回推 share=${push.share} → feat 取哪个都会分叉`,
          );
        }
      }
      for (const r of S.rewardReqs) {
        if (r.code !== 0) continue;
        const push = S.settleTimeline.find(
          (x) => x.src === '22096' && x.ts >= r.t - 1 && x.ts <= r.t + 5000,
        );
        if (!push) {
          skip++;
          continue;
        }
        if (push.got === 1) pass++;
        else {
          fail++;
          samples.push(`2373 成功后 22096 仍 got=${push.got}`);
        }
      }
      rep.check('22096 回推与 2373/2386 应答字段同值', D10, pass, fail, skip, samples);
    }

    // D11 链路质量与节奏（观察，不判负）
    {
      const reqs = S.writes.length;
      const paired = S.writes.filter((w) => S.respByReqTs.has(w.t)).length;
      const rejects = settleWrites
        .concat(S.boardReqs, S.lootReqs)
        .filter((w) => w.code != null && w.code !== 0).length;
      const rate = reqs ? ((paired / reqs) * 100).toFixed(1) : '0.0';
      const ts = S.flipReqs.filter((f) => f.code === 0).map((f) => f.t);
      const gaps = [];
      for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      gaps.sort((a, b) => a - b);
      const p50 = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      rep.check(
        `写动作应答配对 ${paired}/${reqs}（${rate}%），本族写请求 code≠0 ${rejects} 条`,
        D11,
        0,
        0,
        paired,
        [
          '配对率只描述录制质量；「服务器拒绝」在 feat 走 info、「没发出去」走 CODE_NOT_SENT，两者不得混判',
        ],
      );
      rep.check(
        gaps.length
          ? `真人连翻间隔 p50=${p50}ms（max=${gaps[gaps.length - 1]}ms）｜feat HIT_GAP_MS=${HIT_GAP_MS}ms → ${HIT_GAP_MS >= p50 ? '不快于真人' : '快于真人，注意节奏画像'}`
          : '本场无连续翻卡样本，节奏不可判定',
        D11,
        0,
        0,
        gaps.length || 1,
        [],
      );
      const sn = S.openSnaps[S.openSnaps.length - 1];
      rep.check(
        sn
          ? `末次 2365：state=${sn.state} 结算窗止=${sn.settleEnd}（距快照 ${Math.floor((sn.settleEnd * 1000 - sn.ts) / 1000)}s）`
          : '本场无 2365 快照，择时不可判定',
        D11,
        0,
        0,
        1,
        sn
          ? [
              `三窗：${ST_GET_ON} 上车 / ${ST_ROAD} 行驶 / ${ST_REWARD} 结算`,
              S.clockDelta != null
                ? `服务器秒 − 本地毫秒/1000 = ${S.clockDelta}s（故「窗未过」可直接拿录制 ts 比）`
                : '未取得 header.ts，时钟偏差未知',
            ]
          : [],
      );
      // 跨日主体车区分度：诚实标注 lastTrain≠curTrain 样本有无
      const st = S.settleTimeline.filter((x) => x.src === '2365');
      const diff = st.filter((x) => !x.sameObj).length;
      rep.check(
        `curTrain/lastTrain 同对象 ${st.length - diff}/${st.length}：${
          diff
            ? '含跨日区分样本，「结算取 lastTrain」已实弹验证'
            : '缺 lastTrain≠curTrain 样本，该口径仅有约束力、未经实弹（需补录 00:00–12:00 一场）'
        }`,
        D2,
        diff ? st.length : 0,
        0,
        diff ? 0 : st.length,
        [],
      );
    }

    // D12 面板类协议量（feat 按设计不发，仅记录真人 UI 动作）
    {
      const samples = [];
      // uid 行放首位：非 verbose 报告只展 3 条样本，别让身份对照被面板计数顶掉
      if (S.uidProbe != null)
        samples.push(
          `2378 req.uid=${S.uidProbe}（录制账号=${S.uid}）${S.uidProbe === S.uid ? '=本人' : '≠本人（看的是防守者）'}`,
        );
      for (const [cmd, label] of PANEL_CMDS) {
        const n = S.panelCounts.get(cmd) || 0;
        if (n) samples.push(`${label} ×${n}`);
      }
      rep.check(
        samples.length ? '真人 UI 动作（自动化不发）' : '本场无面板类协议样本',
        D12,
        0,
        0,
        samples.length,
        samples,
      );
    }
  },
};
