/**
 * 夺宝奇兵 feat · 录制仿真对拍 Manifest（第二个消费者 / 内核抽象压测）。
 *
 * 与 secret-realm.mjs 同层：只声明本 feat 的协议号、现场态与闸门规则，
 * 读录制、二分回溯、Int64 归一、应答配对、报告打印、退出码全交给 scripts/replay/。
 *
 * 运行：node scripts/replay/run.mjs --manifest cs-hunt [录制...] [--verbose]
 *
 * 校验维度（主跑=队长 / 陪跑=非队长两种角色，均对齐 constants.js 同一份协议字典）：
 *   数据格式（sendPB 业务槽 + JSON 通道 815/7519）/ 状态机一致性（treasureId）/
 *   技能使用闸门（7551 目录·队长·陪跑排除）/ 业务闸门（7532 越界·7534/7538 pos·7537 codeNum）/
 *   场景族对齐（软）·7532 轮值 SHOW 门（软）/ 时序观察（7527 op · 应答配对率）。
 *
 * 写视图自持：内核 scanNDJSON 的 w.req 优先取 raw.data（对 sendPB 非 {header,槽} 形态），
 *   故在 onEntry 里按 entry.body 自建 csWrites，逐通道取业务槽，绕开该差异、不动内核。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON, snapshotAt } from '../replay/reader.mjs';
import { toNum } from '../replay/int64.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CS = path.join(ROOT, 'extension/src/feats/activity/cs-hunt');

// ── 协议字典：与 feat 共用同一份 constants.js / skills.js，判据不另起炉灶 ──
const C = await import(pathToFileURL(path.join(CS, 'constants.js')).href);
const SK = await import(pathToFileURL(path.join(CS, 'skills.js')).href);
const {
  REQ_FIELD,
  HUNT_STATUS,
  EVENT_PHASE_STATE,
  EVENT_SHOW_PHASE,
  MARCH_TYPE_CS_TEAM_HUNT,
  CMD_ITEM_USE,
  HELPER_EXCLUDE_SKILLS,
  REQ_TEAM_MARCH,
  REQ_TEAM_CREATE,
  REQ_TEAM_APPLY_OR_CANCEL,
  REQ_TEAM_APPLY_OP,
  REQ_MARCH_START,
  REQ_EVENT_DECIDE,
  REQ_EVENT_PICK_REWARD,
  REQ_EVENT_ROLL_DICE,
  REQ_EVENT_ROLL_DICE_GIVE_UP,
  REQ_EVENT_CODE_BOX_UNLOCK,
  REQ_EVENT_PICK_SKILL,
  REQ_SKILL_USE,
  PUSH_TEAM_CHANGE,
  PUSH_READY_CHANGE,
  PUSH_HUNT_INFO_CHANGE,
  FIELD_TEAM_CHANGE,
  FIELD_READY_CHANGE,
  FIELD_HUNT_INFO_CHANGE,
} = C;
const { SKILL_IDS, isTeamSkill } = SK;

/** 点型/枚举：DECIDE 候选上限（event_decidable_num=6，§9.4）与密码位上限（max_ppl_num=5） */
const DECIDE_MAX = 6;
const CODE_LEN = 5;

// 写动作（会改变服务器状态、需回查现场态对齐）集合；查询类（7501/7526/7528/7530/7531/7550/7552/7572/7578）不计入
const WRITE_CMDS = new Set([
  REQ_TEAM_MARCH, // 7519（send）
  REQ_TEAM_CREATE, // 7521
  REQ_TEAM_APPLY_OR_CANCEL, // 7522
  REQ_TEAM_APPLY_OP, // 7523
  REQ_MARCH_START, // 7527
  REQ_EVENT_DECIDE, // 7532
  REQ_EVENT_PICK_REWARD, // 7534
  REQ_EVENT_ROLL_DICE, // 7535
  REQ_EVENT_ROLL_DICE_GIVE_UP, // 7536
  REQ_EVENT_CODE_BOX_UNLOCK, // 7537
  REQ_EVENT_PICK_SKILL, // 7538
  REQ_SKILL_USE, // 7551
  CMD_ITEM_USE, // 815（send）
]);

/** 场景动作 cmd → 事件族（floor(eventSpecId/100)：1001 pickReward / 1002 rollDice / 1003 codeBox / 1004 pickSkill） */
const SCENE_FAMILY = {
  [REQ_EVENT_PICK_REWARD]: 1001,
  [REQ_EVENT_ROLL_DICE]: 1002,
  [REQ_EVENT_CODE_BOX_UNLOCK]: 1003,
  [REQ_EVENT_PICK_SKILL]: 1004,
};

export default {
  id: 'cs-hunt',
  featDir: 'extension/src/feats/activity/cs-hunt',
  defaultRecs: [
    'dashcam/store/14179309129759/20261025T110353-夺宝奇兵-我是主跑.ndjson',
    'dashcam/store/14179309129759/20261018T030028-夺宝奇兵-我是陪跑.ndjson',
  ],
  engineMods: {
    'constants.js': [
      'REQ_FIELD',
      'HUNT_STATUS',
      'EVENT_TYPE',
      'MARCH_TYPE_CS_TEAM_HUNT',
      'HELPER_EXCLUDE_SKILLS',
    ],
    'skills.js': ['SKILL_IDS', 'isTeamSkill', 'SKILL_BY_ID', 'chooseByPool'],
    'codebox.js': ['isFullyKnown', 'solveCandidates'],
  },

  // ── 现场态重建：单遍扫录制，把状态机(21376)/队长(21371)/召集(21372)归入时间线，并自持写动作视图 ──
  async buildScan(recPath) {
    const huntSnaps = []; // {ts,tid,status,round,eventSpecId,eiStatus,phase,uidDecide}
    const teamSnaps = []; // {ts,leaderNum}
    const readyTs = []; // 21372 召集时刻
    const csWrites = []; // {t,cmd,dir,body,inner}

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => WRITE_CMDS.has(e.cmd),
        onEntry: (e) => {
          const body = e.body;
          if (e.dir === 'push' && e.cmd === PUSH_HUNT_INFO_CHANGE) {
            const hi = body && body[FIELD_HUNT_INFO_CHANGE];
            if (hi) {
              const ei = hi.status === HUNT_STATUS.EVENT ? hi.eventInfo || {} : {};
              const edi = ei.eventDecideInfo || {};
              huntSnaps.push({
                ts: e.ts,
                tid: toNum(hi.treasureId),
                status: hi.status,
                round: hi.round,
                eventSpecId: ei.eventSpecId,
                eiStatus: ei.status,
                phase: edi.phase,
                uidDecide: toNum(edi.uidDecide),
              });
            }
          } else if (e.dir === 'push' && e.cmd === PUSH_TEAM_CHANGE) {
            const t = body && body[FIELD_TEAM_CHANGE] && body[FIELD_TEAM_CHANGE].team;
            if (t && t.uid != null) teamSnaps.push({ ts: e.ts, leaderNum: toNum(t.uid) });
          } else if (e.dir === 'push' && e.cmd === PUSH_READY_CHANGE) {
            if (body && body[FIELD_READY_CHANGE]) readyTs.push(e.ts);
          } else if (e.dir.startsWith('req') && WRITE_CMDS.has(e.cmd)) {
            // 逐通道取业务槽：send 扁平体；sendPB/sendPBV2 从 {header,<槽>} 剥出槽内层
            let inner = body;
            if (e.dir !== 'req:send') {
              const slot = body && Object.keys(body).find((k) => k !== 'header');
              inner = slot ? body[slot] : null;
            }
            csWrites.push({ t: e.ts, cmd: e.cmd, dir: e.dir, body, inner });
          }
        },
      },
    );

    const byTs = (a, b) => a.ts - b.ts;
    huntSnaps.sort(byTs);
    teamSnaps.sort(byTs);
    readyTs.sort((a, b) => a - b);

    let pairedResp = 0;
    for (const w of csWrites) if (respByReqTs.has(w.t)) pairedResp++;

    return {
      recPath,
      total,
      parseErr,
      minTs,
      maxTs,
      dirCounts,
      writes,
      csWrites,
      huntSnaps,
      teamSnaps,
      readyTs,
      respByReqTs,
      pairedResp,
      // 本人 uid：以录制所在目录名为真相源（换账号即换判据），避免硬编码
      uid: path.basename(path.dirname(recPath)),
    };
  },

  // ── 一致性体检：逐维度校验（对每条写动作回查「发包那一刻」现场态）────────
  runVerify(S, rep) {
    const { csWrites, huntSnaps, teamSnaps, uid } = S;
    const uidNum = Number(uid);
    const huntAt = (t) => snapshotAt(huntSnaps, t) || null;
    const leaderAt = (t) => {
      const s = snapshotAt(teamSnaps, t);
      return s ? s.leaderNum : NaN;
    };

    // ── 维度：数据格式 · sendPB 业务槽（req 体恒 {header, REQ_FIELD[cmd]}）─────
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      for (const w of csWrites) {
        if (w.dir === 'req:send') continue; // JSON 通道另维
        const want = REQ_FIELD[w.cmd];
        if (!want) {
          skip++;
          continue;
        }
        const b = w.body;
        if (!b || typeof b !== 'object') {
          fail++;
          if (fails.length < 3) fails.push(w.cmd + ' body 非对象');
          continue;
        }
        const got = Object.keys(b).sort().join(',');
        const exp = ['header', want].sort().join(',');
        const ok = got === exp && b[want] && typeof b[want] === 'object';
        if (ok) pass++;
        else {
          fail++;
          if (fails.length < 3) fails.push(w.cmd + ' keys=[' + got + '] 期望[' + exp + ']');
        }
      }
      rep.check('sendPB 请求体业务槽（数据格式）', '数据格式', pass, fail, skip, fails);
    }

    // ── 维度：数据格式 · JSON 通道（815 道具使用 / 7519 满编出征）─────────────
    {
      let pass = 0;
      let fail = 0;
      const fails = [];
      for (const w of csWrites) {
        if (w.dir !== 'req:send') continue;
        const inner = w.inner || {};
        if (w.cmd === CMD_ITEM_USE) {
          const keys = Object.keys(inner).sort().join(',');
          const ok =
            keys === 'amount,itemid' && Number(inner.itemid) > 0 && Number(inner.amount) >= 1;
          if (ok) pass++;
          else {
            fail++;
            if (fails.length < 3) fails.push('815 形态异常 keys=[' + keys + ']');
          }
        } else if (w.cmd === REQ_TEAM_MARCH) {
          const ok =
            Number(inner.marchType) === MARCH_TYPE_CS_TEAM_HUNT &&
            Array.isArray(inner.armyList) &&
            inner.armyList.length >= 1;
          if (ok) pass++;
          else {
            fail++;
            if (fails.length < 3) fails.push('7519 marchType≠137 或 armyList 空');
          }
        }
      }
      if (pass || fail) rep.check('JSON 通道 815/7519 出征体', '数据格式', pass, fail, 0, fails);
    }

    // ── 维度：状态机一致性 · treasureId 与发包那一刻的本跑对齐 ────────────────
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      for (const w of csWrites) {
        const inner = w.inner;
        if (!inner || inner.treasureId == null) continue;
        const h = huntAt(w.t);
        if (!h || !Number.isFinite(h.tid)) {
          skip++;
          continue;
        }
        if (toNum(inner.treasureId) === h.tid) pass++;
        else {
          fail++;
          if (fails.length < 3) fails.push(w.cmd + ' treasureId≠当时 21376(' + h.tid + ')');
        }
      }
      rep.check('treasureId 与发包时刻本跑一致', '状态机一致性', pass, fail, skip, fails);
    }

    // ── 维度：技能使用闸门 · 7551（目录在册 / 队技仅队长 / 陪跑排除 17·18）─────
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      for (const w of csWrites) {
        if (w.cmd !== REQ_SKILL_USE) continue;
        const id = Number(w.inner && w.inner.skillSpecId);
        if (!SKILL_IDS.includes(id)) {
          fail++;
          if (fails.length < 3) fails.push('7551 skillSpecId=' + id + ' 不在 28 行目录');
          continue;
        }
        pass++;
        const ld = leaderAt(w.t);
        if (!Number.isFinite(ld)) {
          skip++;
          continue;
        }
        const isLeader = ld === uidNum;
        if (isTeamSkill(id) && !isLeader) {
          fail++;
          if (fails.length < 3) fails.push('7551 队技 ' + id + ' 由非队长(' + ld + ')发起');
        }
        if (!isLeader && HELPER_EXCLUDE_SKILLS.includes(id)) {
          fail++;
          if (fails.length < 3) fails.push('7551 陪跑使用被排除科技 ' + id);
        }
      }
      rep.check('7551 科技目录/队长/陪跑闸门', '技能使用', pass, fail, skip, fails);
    }

    // ── 维度：业务闸门 · 事件动作参数门限（HARD，跨版本恒成立的协议约束）──────
    {
      let pass = 0;
      let fail = 0;
      const fails = [];
      for (const w of csWrites) {
        const inner = w.inner || {};
        if (w.cmd === REQ_EVENT_CODE_BOX_UNLOCK) {
          const cn = inner.codeNum;
          const ok =
            Array.isArray(cn) &&
            cn.length === CODE_LEN &&
            cn.every((d) => Number.isInteger(Number(d)) && Number(d) >= 0 && Number(d) <= 9);
          if (ok) pass++;
          else {
            fail++;
            if (fails.length < 3)
              fails.push('7537 codeNum 非 ' + CODE_LEN + ' 位数字: ' + JSON.stringify(cn));
          }
        } else if (w.cmd === REQ_EVENT_DECIDE) {
          const idx = Number(inner.indexDecide);
          if (Number.isInteger(idx) && idx >= 1 && idx <= DECIDE_MAX) pass++;
          else {
            fail++;
            if (fails.length < 3) fails.push('7532 indexDecide 越界[1,' + DECIDE_MAX + ']: ' + idx);
          }
        } else if (w.cmd === REQ_EVENT_PICK_REWARD || w.cmd === REQ_EVENT_PICK_SKILL) {
          const pos = Number(inner.pos);
          if (Number.isInteger(pos) && pos >= 1) pass++;
          else {
            fail++;
            if (fails.length < 3) fails.push(w.cmd + ' pos 非法: ' + pos);
          }
        }
      }
      rep.check('事件动作参数门限', '业务闸门', pass, fail, 0, fails);
    }

    // ── 维度：场景族对齐（SOFT → 采样局限/版本收紧一律 skip，不判负）───────────
    {
      let pass = 0;
      let skip = 0;
      const notes = [];
      for (const w of csWrites) {
        const want = SCENE_FAMILY[w.cmd];
        if (!want) continue;
        const h = huntAt(w.t);
        if (!h || h.status !== HUNT_STATUS.EVENT || !(Number(h.eventSpecId) > 0)) {
          skip++;
          continue;
        }
        const fam = Math.floor(Number(h.eventSpecId) / 100);
        if (fam === want) pass++;
        else {
          skip++;
          if (notes.length < 3)
            notes.push(w.cmd + ' 当时族 ' + fam + ' ≠ 期望 ' + want + '（新鲜度存疑，不判负）');
        }
      }
      rep.check('场景动作与事件族对齐（软）', '场景族·轮值（软）', pass, 0, skip, notes);
    }

    // ── 维度：7532 选场景轮值 / SHOW 门（SOFT → skip）──────────────────────────
    {
      let pass = 0;
      let skip = 0;
      const notes = [];
      for (const w of csWrites) {
        if (w.cmd !== REQ_EVENT_DECIDE) continue;
        const h = huntAt(w.t);
        if (!h || h.eiStatus !== EVENT_PHASE_STATE.DECIDE || h.phase !== EVENT_SHOW_PHASE.SHOW) {
          skip++;
          if (notes.length < 3) notes.push('7532 无当场 DECIDE/SHOW 快照（采样局限）');
          continue;
        }
        if (h.uidDecide === uidNum) pass++;
        else {
          skip++;
          if (notes.length < 3)
            notes.push('7532 发起时 uidDecide=' + h.uidDecide + ' 非本人（新鲜度存疑，不判负）');
        }
      }
      rep.check('7532 选场景轮值/SHOW 门（软）', '场景族·轮值（软）', pass, 0, skip, notes);
    }

    // ── 维度：时序观察 · 7527 出发表态 op 合法 + 相对首次召集（OBSERVATION）─────
    {
      let pass = 0;
      let fail = 0;
      const notes = [];
      for (const w of csWrites) {
        if (w.cmd !== REQ_MARCH_START) continue;
        const op = Number(w.inner && w.inner.op);
        if (op === 1 || op === 2) pass++;
        else {
          fail++;
          if (notes.length < 3) notes.push('7527 op=' + op + ' 非{1,2}');
        }
      }
      const firstReady = S.readyTs.length ? S.readyTs[0] : null;
      if (firstReady != null) {
        const early = csWrites.filter((w) => w.cmd === REQ_MARCH_START && w.t < firstReady).length;
        notes.push('7527 早于首次召集(21372) 的笔数: ' + early + '（观察，不判负）');
      }
      rep.check('7527 出发表态 op∈{1,2}', '时序观察', pass, fail, 0, notes);
    }

    // ── 维度：应答配对率（OBSERVATION · 脱机 resp 可能漏采，不判负）───────────
    {
      const total = csWrites.length;
      const paired = S.pairedResp;
      rep.check('写动作应答配对率', '时序观察', paired, 0, total - paired, [
        '配对 ' + paired + '/' + total + '（脱机采样局限，不判负）',
      ]);
    }
  },
};
