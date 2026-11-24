/**
 * 雷达任务 feat · 录制仿真对拍 Manifest（第三个消费者 / 单文件 feat 首次接入）。
 *
 * 与 secret-realm.mjs / cs-hunt.mjs 同层：只声明本 feat 的协议号、现场态与闸门规则，
 * 读录制、二分回溯、Int64 归一、应答配对、报告打印、退出码全交给 scripts/replay/。
 *
 * 运行：node scripts/replay/run.mjs --manifest radar-task [录制...] [--verbose]
 *
 * 校验维度（真人录制对齐 feat 同一份协议字典）：
 *   数据格式 · 写请求体形态（3504/3505/3508 键集 + 902 零部队八键 / 902 带兵 canonical / 1201 十键）
 *   认领前置闸门（行军坐标必来自 3505 回填）/ type×marchType 分派对拍 / radar_event 查表键契约（实例 id 而非 taskId）
 *   领奖时序（3508 需当场 state=4）/ 停滞止损（dispatch 无完成证据不得超 dispatchStallLimit 重派）
 *   雷达防御（3515 恒空体 + 发包前必有 deBeginTime>0 触发 + feat 击退闸与真人击退对齐）
 *   Int64 形态（任务 id 裸 number vs marchId 十进制串）/ 单飞不变量（软）/ 应答配对率（观察）。
 *
 * 协议字典来源：本 feat 是单文件浏览器模块（无独立 constants.js），为守住「判据不与 feat 分叉」红线，
 *   此处最小桩化浏览器全局后动态 import feat 本体取常量——与 tests/feats/radar-task.test.js 同法。
 *
 * dir 实测（写判据前已探针核对，避免不可达分支）：
 *   3504/3505/3508/902/1201 的 req 恒 dir='req:send'（老 send 通道，无 PBV2）；任务事件推送 dir='push'。
 *   3504 resp 的 day_group_events 是两层嵌套 {day_group_events:[…]}，而 3505 resp 是同名扁平数组——
 *   两种形态都得吃（feat 的 applyPayload 正是双形态兼容，本处判据同口径）。
 * 应答配对：内核 respByReqTs 只认 PB 形态的 data.header，而本族走老 send 通道（data 即载荷、码在 raw.s），
 *   故此处按 entry.raw.s 自建配对视图——不改内核（改了会破秘境/夺宝的 PB 保真）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON, snapshotAt } from '../replay/reader.mjs';
import { toNum, isInt64Obj } from '../replay/int64.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEAT = path.join(ROOT, 'extension/src/feats/player/radar-task/index.js');

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
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

// ── 协议字典 + 分派表：与 feat 共用同一份常量，判据不另起炉灶 ──────────────
const C = await import(pathToFileURL(FEAT).href);
const {
  resolveType,
  actionFor,
  TYPE_ACTIONS,
  UNSUPPORTED_TYPES,
  TASK_TYPES,
  ST_FINISH,
  ST_RUNNING,
  ST_SECONDARY,
  isTaskEvent,
  normalizeDeBeginTime,
  defenseGate,
  stallStep,
  cfg,
  CMD_GET_INFO,
  CMD_START_TASK,
  CMD_GET_REWARD,
  CMD_MARCH_POINT,
  CMD_CREATE_RALLY,
  CMD_DEFEND,
  SIGN_MAX,
  PUSH_STATUS_CHANGE,
  PUSH_ADD_ONE_TASK,
  PUSH_OTHER_DATA,
  PUSH_SIGN,
  PUSH_RING_CHANGE,
  PUSH_DAYGROUP_CHANGE,
  PUSH_ENERGY,
  STAMINA_TYPE,
  MT_MONSTER,
  MT_TREASURE,
  MT_ASSIST,
  MT_HELP,
  MT_RALLY,
  RALLY_WAIT_TIME,
} = C;

/** 雷达专属行军类型集（区别于普通打野/采集的 902）：只有这几型才归本 feat 判据管 */
const RADAR_MT = new Set([MT_MONSTER, MT_TREASURE, MT_ASSIST, MT_HELP]);
/** 零部队型（feat 直发八键 body）；MT_MONSTER 带兵走 march.attack canonical */
const ZERO_MT = new Set([MT_TREASURE, MT_ASSIST, MT_HELP]);
/** feat sendZeroMarch 的八键实证形态（20261106T002310）：多一键少一键都是 FAIL */
const ZERO_KEYS = [
  'armyList',
  'armyListNew',
  'formation',
  'heroList',
  'marchType',
  'trapList',
  'x',
  'y',
].sort();
/** feat sendRally 的十键实证形态（同惧星 20261011T183114）：无 break/extraArmy */
const RALLY_KEYS = [
  'armyList',
  'armyListNew',
  'formation',
  'formationV2',
  'heroList',
  'marchType',
  'time',
  'trapList',
  'x',
  'y',
].sort();

// 需回查现场态的写动作：3505 认领 / 3508 领奖 / 雷达 902 行军 / 雷达 1201 集结 / 3515 击退（3504 是纯读，不计）
const WRITE_CMDS = new Set([
  CMD_START_TASK,
  CMD_GET_REWARD,
  CMD_MARCH_POINT,
  CMD_CREATE_RALLY,
  CMD_DEFEND,
]);

/** 摊平「任务事件数组」的三种来源形态：3504 全量（day_group 两层嵌套）/ 3505 应答（同名扁平）/ 推送（载荷即事件或 {events}） */
function eventsOf(body) {
  if (!body || typeof body !== 'object') return [];
  // 20013/20025：载荷即单事件。判据直接取 feat 本体导出的 isTaskEvent（单一真相源，不在此另抄一份）
  if (isTaskEvent(body)) return [body];
  const out = [];
  if (Array.isArray(body.events)) out.push(...body.events);
  const dg = body.day_group_events;
  if (Array.isArray(dg)) out.push(...dg);
  else if (dg && Array.isArray(dg.day_group_events)) out.push(...dg.day_group_events);
  const ge = body.group_events;
  if (Array.isArray(ge)) out.push(...ge);
  else if (ge && Array.isArray(ge.group_events)) out.push(...ge.group_events);
  return out.filter((e) => e && e.id != null && e.taskId != null);
}

export default {
  id: 'radar-task',
  featDir: 'extension/src/feats/player',
  defaultRecs: [
    'dashcam/store/rec/14179309129759/dashcam-rec-20261106T002310-雷达任务.ndjson',
    // 第二账号的日常任务录制：含雷达派兵，给「体力只在出兵时扣」提供交叉样本
    'dashcam/store/rec/15596140531952/dashcam-rec-20261105T010023-日常任务.ndjson',
  ],
  engineMods: {
    // 单文件 feat：冒烟即「模块可解析 + 协议字典与决策纯函数在册」
    'radar-task.js': [
      'CMD_GET_INFO',
      'CMD_START_TASK',
      'CMD_GET_REWARD',
      'TYPE_ACTIONS',
      'UNSUPPORTED_TYPES',
      'TASK_TYPES',
      'resolveType',
      'actionFor',
      'pickCandidate',
      'stallStep',
      'cfg',
      'staminaGate',
      'defenseGate',
      'normalizeDeBeginTime',
      'CMD_DEFEND',
      'normalize',
    ],
  },

  // ── 现场态重建：单遍扫录制，把任务状态时间线按实例 id 归档，并自持雷达写视图 ──
  async buildScan(recPath) {
    const stateById = new Map(); // id(串) -> [{ts, state, taskId, x, y}]
    const marchResp = []; // {ts, cmd, marchId, marchType, state} 来自 902/1201 resp
    const radarWrites = []; // {t, cmd, dir, body}
    const claimByPos = new Map(); // "x,y" -> {t, id, taskId, state} 最近一次 3505 回填的坐标
    const respByRt = new Map(); // reqTs -> {cmd, s} 老 send 通道自持配对视图（码在 raw.s）
    const energyPushes = []; // {ts, point, reason, restoreSec} 体力池推送（type=1），用于定位「哪一步实扣体力」
    const pushShape = []; // {ts, cmd, bare} 任务类推送的载荷形态，用于「feat 判据 ↔ 线上形态」契约维度
    // 信号功率/干扰攻击时间线（防御闸的现场态）：与 feat 的 scalars 同构的**累计**视图——
    //   只在本条载荷带 sign / deBeginTime 时覆盖对应格（3504 全量、20016、20021 三源都只带其中一部分，
    //   若每条都当全量读会把「上一条刚报过的 deBeginTime」误当成 0，防御维度全盘假 FAIL）。
    const signTimeline = [];
    const signCur = { sign: 0, deBeginTime: 0 };

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => WRITE_CMDS.has(e.cmd),
        onEntry: (e, _acc) => {
          const b = e.body;
          if (e.dir === 'resp' || e.dir === 'push') {
            // 老 send 通道应答：无 data.header，业务码在 raw.s（0=受理，非 0=服务器拒）
            if (e.dir === 'resp' && e.rt && WRITE_CMDS.has(e.cmd)) {
              const s = e.raw && e.raw.s != null ? Number(e.raw.s) : null;
              respByRt.set(e.rt, { cmd: e.cmd, s: s });
            }
            // 状态时间线：3504/3505 应答 + 携带任务事件的推送（20013/20015/20025/20026）
            const isEventCmd =
              e.dir === 'push'
                ? [
                    PUSH_STATUS_CHANGE,
                    PUSH_ADD_ONE_TASK,
                    PUSH_RING_CHANGE,
                    PUSH_DAYGROUP_CHANGE,
                  ].includes(e.cmd)
                : e.cmd === CMD_GET_INFO || e.cmd === CMD_START_TASK;
            if (isEventCmd) {
              if (e.dir === 'push')
                pushShape.push({
                  ts: e.ts,
                  cmd: e.cmd,
                  bare: isTaskEvent(b),
                  // 归属指纹（day_group_id/radar_group_type/group_id）：只统计裸事件，防越界摄入无人接的形态
                  sig: isTaskEvent(b)
                    ? `${b.day_group_id | 0}/${b.radar_group_type | 0}/${b.group_id | 0}`
                    : '',
                });
              for (const ev of eventsOf(b)) {
                if (ev.state == null) continue;
                const k = String(ev.id);
                const arr = stateById.get(k) || [];
                arr.push({
                  ts: e.ts,
                  state: Number(ev.state),
                  cmd: e.cmd,
                  taskId: Number(ev.taskId),
                  x: Number(ev.x) | 0,
                  y: Number(ev.y) | 0,
                });
                stateById.set(k, arr);
              }
            }
            // 认领回填：3505 resp 的 state=1/3 条目按坐标登记，供「行军坐标必来自认领」回查
            if (e.dir === 'resp' && e.cmd === CMD_START_TASK) {
              for (const ev of eventsOf(b)) {
                const st = Number(ev.state);
                if ((st === 1 || st === ST_SECONDARY) && (ev.x || ev.y)) {
                  claimByPos.set(ev.x + ',' + ev.y, {
                    t: e.ts,
                    id: String(ev.id),
                    taskId: Number(ev.taskId),
                    state: st,
                  });
                }
              }
            }
            // 体力池推送：只认 type=1（EnergyType.Action），带 point 供算单价
            if (e.dir === 'push' && e.cmd === PUSH_ENERGY) {
              const d = b || {};
              if ((Number(d.type) | 0) === STAMINA_TYPE) {
                energyPushes.push({
                  ts: e.ts,
                  point: Number(d.point),
                  reason: String(d.reason || ''),
                  restoreSec: Number(d.restoreSec) | 0,
                });
              }
            }
            // 标量时间线：sign / deBeginTime（干扰攻击触发时刻）——3504 全量 + 20016 + 20021 三源合并
            if (
              (e.dir === 'push' && (e.cmd === PUSH_SIGN || e.cmd === PUSH_OTHER_DATA)) ||
              (e.dir === 'resp' && e.cmd === CMD_GET_INFO)
            ) {
              const sc = b || {};
              let touched = false;
              if (sc.sign != null) {
                signCur.sign = Number(sc.sign) | 0;
                touched = true;
              }
              if (sc.deBeginTime != null) {
                // 口径与 feat 同源：秒级 epoch 走 normalizeDeBeginTime（不走 `|0`，超 Int32 不截断）
                signCur.deBeginTime = normalizeDeBeginTime(sc.deBeginTime);
                touched = true;
              }
              if (touched) {
                signTimeline.push({
                  ts: e.ts,
                  cmd: e.cmd,
                  sign: signCur.sign,
                  deBeginTime: signCur.deBeginTime,
                });
              }
            }
            // 行军应答：marchId Int64 形态与状态
            if (e.dir === 'resp' && (e.cmd === CMD_MARCH_POINT || e.cmd === CMD_CREATE_RALLY)) {
              const mi = (b && b.marchInfo) || {};
              marchResp.push({
                ts: e.ts,
                cmd: e.cmd,
                marchId: mi.marchId,
                marchType: mi.marchType,
                state: mi.state,
              });
            }
            return;
          }
          if (e.dir.startsWith('req') && WRITE_CMDS.has(e.cmd)) {
            // 自建写视图：老 send 通道体即 entry.body（不经内核 w.req 的 raw.data 优先序）
            radarWrites.push({ t: e.ts, cmd: e.cmd, dir: e.dir, body: b || {} });
          }
        },
      },
    );

    for (const arr of stateById.values()) arr.sort((a, b) => a.ts - b.ts);
    energyPushes.sort((a, b) => a.ts - b.ts);
    signTimeline.sort((a, b) => a.ts - b.ts);
    const byTs = (a, b) => a.t - b.t;
    radarWrites.sort(byTs);

    let pairedResp = 0;
    for (const w of radarWrites) if (respByReqTs.has(w.t) || respByRt.has(w.t)) pairedResp++;

    return {
      recPath,
      total,
      parseErr,
      minTs,
      maxTs,
      dirCounts,
      writes,
      radarWrites,
      stateById,
      pushShape,
      marchResp,
      claimByPos,
      energyPushes,
      signTimeline,
      respByReqTs,
      respByRt,
      pairedResp,
      uid: path.basename(path.dirname(recPath)),
    };
  },

  // ── 一致性体检 ────────────────────────────────────────────────────────
  runVerify(S, rep) {
    const { radarWrites, stateById, claimByPos, energyPushes, pushShape, signTimeline } = S;

    /** 发包那一刻该实例的已知状态（时间线二分回溯，复现 feat 账本视角） */
    const stateAt = (id, t) => snapshotAt(stateById.get(String(id)) || [], t);

    // ── 维度：数据格式 · 查询与写请求体形态（HARD，跨版本恒成立的协议约束）───
    {
      let pass = 0;
      let fail = 0;
      const fails = [];
      const bad = (msg) => {
        fail++;
        if (fails.length < 3) fails.push(msg);
      };
      for (const w of radarWrites) {
        const keys = Object.keys(w.body).sort();
        if (w.cmd === CMD_START_TASK || w.cmd === CMD_GET_REWARD) {
          // 报文实证：req 恰 {id}，且 id 是裸 number（非 Int64 对象/串）
          const idOk =
            !isInt64Obj(w.body.id) &&
            typeof w.body.id !== 'string' &&
            Number.isFinite(Number(w.body.id));
          if (keys.length === 1 && keys[0] === 'id' && idOk) pass++;
          else
            bad(
              w.cmd +
                ' req 体非 {id:number}: keys=' +
                keys.join(',') +
                ' id=' +
                JSON.stringify(w.body.id),
            );
        } else if (w.cmd === CMD_MARCH_POINT) {
          const mt = Number(w.body.marchType);
          if (!RADAR_MT.has(mt)) {
            // 非雷达行军型（本录制不该出现）不参与本 feat 判据
            continue;
          }
          if (ZERO_MT.has(mt)) {
            if (keys.join(',') === ZERO_KEYS.join(',')) pass++;
            else bad('902 零部队(mt=' + mt + ') 键集非八键: ' + keys.join(','));
          } else {
            // 带兵单打 = march.attack canonical（含 break/extraArmy/formationV2）
            const ok =
              keys.includes('armyListNew') &&
              keys.includes('heroList') &&
              keys.includes('trapList') &&
              keys.includes('formationV2') &&
              keys.includes('break') &&
              keys.includes('extraArmy') &&
              (w.body.armyListNew || []).length > 0;
            if (ok) pass++;
            else bad('902 带兵(mt=' + mt + ') 非 march.attack canonical: ' + keys.join(','));
          }
        } else if (w.cmd === CMD_CREATE_RALLY) {
          const ok =
            keys.join(',') === RALLY_KEYS.join(',') &&
            Number(w.body.marchType) === MT_RALLY &&
            Number(w.body.time) === RALLY_WAIT_TIME &&
            (w.body.armyListNew || []).length > 0;
          if (ok) pass++;
          else
            bad(
              '1201 集结体非十键/time=' +
                RALLY_WAIT_TIME +
                ': ' +
                keys.join(',') +
                ' time=' +
                w.body.time,
            );
        }
      }
      // 3504 是纯读查询（不入 writes 集合），其 {clearFinishNotify:1} 形态由 feat 侧单测与报文注释守住
      rep.check('3505/3508/902/1201 请求体形态', '数据格式', pass, fail, 0, fails);
    }

    // ── 维度：认领前置闸门（HARD）行军坐标必来自 3505 认领回填 ───────────────
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      for (const w of radarWrites) {
        if (w.cmd !== CMD_MARCH_POINT && w.cmd !== CMD_CREATE_RALLY) continue;
        if (w.cmd === CMD_MARCH_POINT && !RADAR_MT.has(Number(w.body.marchType))) continue;
        const pos = w.body.x + ',' + w.body.y;
        const claim = claimByPos.get(pos);
        if (!claim) {
          // 坐标从未被任何 3505 应答回填过：可能是录制起点前的既存在途任务（采样局限）→ skip
          skip++;
          if (fails.length < 3)
            fails.push(
              (w.cmd === CMD_CREATE_RALLY ? '1201' : '902') +
                ' 坐标 ' +
                pos +
                ' 无认领回填（采样局限）',
            );
          continue;
        }
        if (claim.t <= w.t) pass++;
        else {
          fail++;
          if (fails.length < 3)
            fails.push(w.cmd + ' 行军早于该坐标的 3505 认领（时序倒置）@' + pos);
        }
      }
      rep.check('行军坐标来自 3505 认领回填', '认领前置闸门', pass, fail, skip, fails);
    }

    // ── 维度：type×marchType 分派对拍（HARD，taskId 在经验表内才可判）─────────
    // 离线拿不到 radar_event 表，只能走 feat 的「表不可读 → taskId 经验表」兜底轴；查表键本身的契约由下一个维度钉住。
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      for (const w of radarWrites) {
        let cmd = w.cmd;
        if (cmd !== CMD_MARCH_POINT && cmd !== CMD_CREATE_RALLY) continue;
        if (cmd === CMD_MARCH_POINT && !RADAR_MT.has(Number(w.body.marchType))) continue;
        const claim = claimByPos.get(w.body.x + ',' + w.body.y);
        if (!claim) {
          skip++;
          continue;
        }
        const taskId = claim.taskId;
        // 离线无游戏表 → tableReady=false 走 feat 的录制经验表兜底口径（resolveType 的第二轴）
        const { type } = resolveType({ id: claim.id, taskId }, null, false);
        const def = TYPE_ACTIONS[type];
        if (!def) {
          skip++;
          if (fails.length < 3) fails.push('taskId=' + taskId + ' 经验表外（无法预测分派）');
          continue;
        }
        const want = def.action;
        // 期望的线上形态：rally → 1201；attack/zero → 902 + 该 type 的 marchType
        const ok =
          want.act === 'rally'
            ? cmd === CMD_CREATE_RALLY
            : cmd === CMD_MARCH_POINT && Number(w.body.marchType) === want.marchType;
        if (ok) pass++;
        else {
          fail++;
          if (fails.length < 3)
            fails.push(
              'taskId=' +
                taskId +
                ' type=' +
                type +
                ' feat 预测 ' +
                want.act +
                (want.marchType != null ? '/' + want.marchType : '') +
                '，实发 ' +
                cmd +
                (w.body.marchType != null ? '/' + w.body.marchType : ''),
            );
        }
      }
      rep.check('type→动作分派与实发对齐', 'type×marchType 分派', pass, fail, skip, fails);
    }

    // ── 维度：radar_event 查表键契约（HARD）键 = 事件实例 id，不是 taskId ────────
    // 权威口径三处实证：游戏 RadarTaskPrefab.initData / RadarController.askBeginTask 均以 e.id 查表，
    // 竞品 B 同为 getTableDataById(TableName.radar_event, e["id"])；taskId 是另一张表 radar_task 的键。
    // 反例（线上事故）：曾按 taskId 查，10001 命中同号不同物的槽位行 type=205，把据点任务派成零部队援助 902/67 吃 code=3
    //   （实证 dashcam store/log/15596140531952/dashcam-log-20261106.ndjson）。此处用「只对实例 id 返回权威行、对 taskId 返回毒药行」的桩钉死契约。
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      const ID_ROW = { type: 202, quality: 5 }; // 实例行指纹（quality=5 只挂在实例行上，用来证明取的是哪一行）
      const POISON = 205; // 错键（taskId）才会命中的槽位行 type
      for (const [id, arr] of stateById) {
        const taskId = arr.length ? arr[arr.length - 1].taskId : 0;
        if (!taskId || String(taskId) === id) {
          skip++; // 无 taskId 或两轴同号，桩无法区分，记无法判定
          continue;
        }
        const queried = [];
        const tableRow = (table, key) => {
          queried.push(table + '|' + String(key));
          if (String(key) === id) return ID_ROW;
          if (String(key) === String(taskId)) return { type: POISON, quality: 1 };
          return null;
        };
        const r = resolveType({ id, taskId }, tableRow, true);
        if (queried.length !== 1 || queried[0] !== 'radar_event|' + id) {
          fail++;
          if (fails.length < 3)
            fails.push('id=' + id + ' 查询轨迹 ' + queried.join(',') + ' ≠ 单次 radar_event|' + id);
          continue;
        }
        if (r.type === POISON) {
          fail++;
          if (fails.length < 3)
            fails.push('id=' + id + ' 读到 taskId=' + taskId + ' 同号槽位行（错键查表）');
          continue;
        }
        if (r.type !== ID_ROW.type || r.quality !== ID_ROW.quality) {
          fail++;
          if (fails.length < 3)
            fails.push(
              'id=' + id + ' 未取到实例行（得 type=' + r.type + ' quality=' + r.quality + '）',
            );
          continue;
        }
        // 反向断言：表可读但该槽位无行 → fail-closed（type=0），绝不退回 taskId 猜动作
        const rEmpty = resolveType({ id, taskId }, () => null, true);
        if (rEmpty.type !== 0) {
          fail++;
          if (fails.length < 3)
            fails.push(
              'id=' + id + ' 表无行却得 type=' + rEmpty.type + '（fail-closed 失效，会发猜包）',
            );
          continue;
        }
        // 兜底轴（录制经验表）只允许在「读数面整体不可用」时生效，且仍以 taskId 为键
        const expect = TASK_TYPES[taskId] || 0;
        const rFallback = resolveType({ id, taskId }, null, false);
        if (rFallback.type !== expect) {
          fail++;
          if (fails.length < 3)
            fails.push(
              'taskId=' +
                taskId +
                ' tableReady=false 兜底应 ' +
                expect +
                '，实得 ' +
                rFallback.type,
            );
          continue;
        }
        pass++;
      }
      // v1 不做名单（feat 侧 UNSUPPORTED_TYPES）必须显式归 unsupported：落到「未知」会被其它分支误判，落到分派表就是猜包
      for (const ty of UNSUPPORTED_TYPES) {
        const a = actionFor({ state: 1, taskId: 0 }, ty);
        if (!a || a.act !== 'unsupported') {
          fail++;
          if (fails.length < 3)
            fails.push('type=' + ty + ' 在 unsupported 名单内却得 ' + JSON.stringify(a));
          continue;
        }
        if (TYPE_ACTIONS[ty]) {
          fail++;
          if (fails.length < 3)
            fails.push('type=' + ty + ' 同时在册于分派表与 unsupported 名单（口径冲突）');
          continue;
        }
        pass++;
      }
      rep.check(
        'radar_event 查表键 = 实例 id（含 fail-closed 与兜底轴）',
        '查表键契约',
        pass,
        fail,
        skip,
        fails,
      );
    }

    // ── 维度：领奖时序（HARD）3508 那一刻该实例已知状态必须是 ST_FINISH ────────
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      for (const w of radarWrites) {
        if (w.cmd !== CMD_GET_REWARD) continue;
        const snap = stateAt(w.body.id, w.t);
        if (!snap) {
          skip++;
          if (fails.length < 3)
            fails.push('3508 id=' + w.body.id + ' 无前置状态快照（录制起点前的存量任务）');
          continue;
        }
        if (snap.state === ST_FINISH) pass++;
        else {
          fail++;
          if (fails.length < 3)
            fails.push('3508 id=' + w.body.id + ' 当场 state=' + snap.state + ' ≠ ' + ST_FINISH);
        }
      }
      rep.check('3508 领奖须当场 state=' + ST_FINISH, '领奖时序', pass, fail, skip, fails);
    }

    // ── 维度：完成即领（HARD）凡观测到 state=4 的实例，其后必须出现同 id 的 3508 ──────
    // 真人基线（两份录制均 100%：rec1 36/36、rec2 19/19）：state=4 即「完成待领」，不存在漏领。
    // 本维度专为钉住这次的回归：feat 曾把 20013/20025 的裸事件读成数组、永远看不到 state=4，
    // 结果既不领奖又反复 902（实证 20261106T02 一场 id=3145 code=3 死循环 15s/拍）。
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const notes = [];
      const first4 = new Map(); // id -> 首次观测到 state=4 的那条记录
      for (const [k, arr] of stateById) {
        const hit = arr.find((s) => s.state === ST_FINISH);
        if (hit) first4.set(k, hit);
      }
      const bareFirst = [...first4.values()].filter(
        (s) => s.cmd === PUSH_STATUS_CHANGE || s.cmd === PUSH_RING_CHANGE,
      ).length;
      for (const [k, s] of first4) {
        const got = radarWrites.some(
          (w) => w.cmd === CMD_GET_REWARD && String(w.body.id) === k && w.t >= s.ts,
        );
        if (got) pass++;
        else if (s.ts >= S.maxTs - 1000) {
          // 录制收尾那一秒才完成的，后面本就没有机会发领——不判负
          skip++;
        } else {
          fail++;
          if (notes.length < 3) notes.push('state=4 实例 id=' + k + ' 此后再无 3508 领奖');
        }
      }
      notes.push(
        `首见 state=4 共 ${first4.size} 个；其中 ${bareFirst} 个只能从 20013/20025 裸事件看到（丢裸事件即对这些全盲）`,
      );
      rep.check('凡 state=4 实例后续必有 3508 领奖', '完成即领', pass, fail, skip, notes);
    }

    // ── 维度：停滞止损（HARD）同一实例在无完成证据下的连续 dispatch 不得超 dispatchStallLimit ──────
    // 第二条反向断言：「发 1201 时坐标来自认领」那类正向判据封不住「集结被服务器 60s 原地解散后
    // 无限度重派同一条」——必须看 dispatch 之后有没有 state=4 证据。
    // 实证 dashcam 20261107T005129：同一条 id=3147 在 639s 内被 1201 重派 4 次（每次 s=0 受理、
    // 行军态恒 8→4 从未出发、任务态 2→1 反复回滚），而整场 0 笔 3505/3508。
    // 真人基线不违反（两份录制同实例最多 1 笔 dispatch）；坐标无法归属到实例的 dispatch 一律记 skip，不假 PASS。
    {
      const limit = cfg.dispatchStallLimit;
      const dispById = new Map(); // 实例 id -> [{t, cmd}]
      let orphan = 0; // 坐标回查不到认领回填的 dispatch（录制起点前的存量任务）
      for (const w of radarWrites) {
        if (w.cmd !== CMD_MARCH_POINT && w.cmd !== CMD_CREATE_RALLY) continue;
        if (w.cmd === CMD_MARCH_POINT && !RADAR_MT.has(Number(w.body.marchType))) continue;
        const claim = claimByPos.get(w.body.x + ',' + w.body.y);
        if (!claim || claim.t > w.t) {
          orphan++;
          continue;
        }
        const arr = dispById.get(claim.id) || [];
        arr.push({ t: w.t, cmd: w.cmd });
        dispById.set(claim.id, arr);
      }
      let pass = 0;
      let fail = 0;
      let skip = orphan;
      const notes = [];
      if (orphan) notes.push(`${orphan} 笔 dispatch 坐标无认领回填（采样局限，不判负）`);
      let peakAll = 0;
      for (const [id, ds] of dispById) {
        ds.sort((a, b) => a.t - b.t);
        const tl = stateById.get(id) || [];
        // 时间轴合并 dispatch(D) 与 state=4 观测(F)：F 即「前一次真做成了」，把无进展计数清零
        const marks = [
          ...ds.map((d) => ({ t: d.t, k: 'D' })),
          ...tl.filter((s) => s.state === ST_FINISH).map((s) => ({ t: s.ts, k: 'F' })),
        ].sort((a, b) => a.t - b.t);
        let streak = 0;
        let peak = 0;
        for (const m of marks) {
          if (m.k !== 'D') {
            streak = 0;
            continue;
          }
          streak++;
          if (streak > peak) peak = streak;
        }
        if (peak > peakAll) peakAll = peak;
        if (peak > limit) {
          fail++;
          if (notes.length < 4)
            notes.push(
              `id=${id} taskId=${tl.length ? tl[0].taskId : '?'} 无完成证据下连续 dispatch ${peak} 次 > 止损阈 ${limit}`,
            );
        } else pass++;
      }
      // 阈本身要与 feat 同源（不在此重抄一份）：拿 stallStep 反推同样的达标形状
      notes.push(
        `止损阈=${limit}（cfg.dispatchStallLimit，与 feat stallStep 同源）；最大无进展重派=${peakAll}`,
      );
      const probe = stallStep('rollback', limit - 1, limit);
      if (!probe.yielded) fail++;
      else pass++;
      notes.push('stallStep 自检：第 ' + limit + ' 次 rollback 必须达让位阈');
      rep.check('dispatch 无完成证据不得超止损阈重派', '停滞止损', pass, fail, skip, notes);
    }

    // ── 维度：任务推送形态契约（HARD）feat 的 isTaskEvent 判据必须与线上形态一致 ──────
    // 20013/20025 线上恒为裸事件（应 bare=true），20015/20026 恒为 {events} 集合（应 bare=false）；
    // 任意一侧翻转即 FAIL——提醒改版后重设 feat 侧的入账判据，而不是静丢状态。
    {
      let pass = 0;
      let fail = 0;
      const notes = [];
      const byCmd = new Map(); // cmd -> {bare, arr}
      for (const p of pushShape) {
        const shouldBare = p.cmd === PUSH_STATUS_CHANGE || p.cmd === PUSH_RING_CHANGE;
        const c = byCmd.get(p.cmd) || { bare: 0, arr: 0 };
        c[p.bare ? 'bare' : 'arr']++;
        byCmd.set(p.cmd, c);
        if (shouldBare === p.bare) pass++;
        else fail++;
      }
      for (const [cmd, c] of [...byCmd].sort((a, b) => a[0] - b[0])) {
        notes.push(`${cmd}: 裸事件 ${c.bare} / 数组集合 ${c.arr}`);
      }
      // 观察项（不判负）：裸事件的归属指纹集。两份录制实测均为 dg/rgt/gid 中的 0/1|3/0 与 */3/0，
      // 即 group_id 恒 0、全部落在 v1 范围（类二 events + 类一 day_group）内；若改版出现 group_id>0
      // 的裸事件（联盟组任务），需重新评估入账是否会越界发错行军。
      const sigs = new Set(pushShape.filter((p) => p.bare).map((p) => p.sig));
      notes.push(
        `裸事件归属指纹 dg/rgt/gid: ${[...sigs].sort().join(' , ') || '（本场无裸事件）'}`,
      );
      rep.check('任务推送形态与 feat 入账判据一致', '推送形态契约', pass, fail, 0, notes);
    }

    // ── 维度：认领时任务态（HARD）3505 只能认领 state=0 的任务 ────────────────
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const fails = [];
      for (const w of radarWrites) {
        if (w.cmd !== CMD_START_TASK) continue;
        const snap = stateAt(w.body.id, w.t);
        if (!snap) {
          skip++;
          continue;
        }
        if (snap.state === 0) pass++;
        else {
          fail++;
          if (fails.length < 3)
            fails.push('3505 id=' + w.body.id + ' 认领时 state=' + snap.state + ' ≠ 0');
        }
      }
      rep.check('3505 认领须当场 state=0', '认领状态门', pass, fail, skip, fails);
    }

    // ── 维度：雷达防御请求契约（HARD）3515 恒空体，且发包那一刻必有 deBeginTime>0 ──────
    // 源码实证 `RadarController.radarDefCallBack` 就是 `NET.send(RequestId.RadarDefend, {}, …)`：不带 id/坐标；
    //   而 `RadarMainPrefab` 只在 radarDefendStartTime（即 deBeginTime）非 0 时点亮防御入口——真人不可能在无攻击时发它。
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const notes = [];
      const defends = radarWrites.filter((w) => w.cmd === CMD_DEFEND);
      if (!defends.length) {
        skip++;
        notes.push('本场无 3515（真人未遇/未做干扰攻击）：空体契约无从取样，不判负也不伪 PASS');
      }
      for (const w of defends) {
        const keys = Object.keys(w.body);
        if (keys.length === 0) pass++;
        else {
          fail++;
          if (notes.length < 3)
            notes.push('3515 req 非空体: keys=' + keys.join(',') + ' ' + JSON.stringify(w.body));
        }
        const snap = snapshotAt(signTimeline, w.t);
        if (!snap) {
          skip++;
          if (notes.length < 3)
            notes.push('3515 t=' + w.t + ' 之前无任何 sign/deBeginTime 载荷（采样局限）');
        } else if (snap.deBeginTime > 0) pass++;
        else {
          fail++;
          if (notes.length < 3)
            notes.push(
              '3515 发包前最近标量 deBeginTime=' +
                snap.deBeginTime +
                '（无触发即击退，协议上不成立）',
            );
        }
      }
      rep.check('3515 恒空体且发包前必有 deBeginTime>0', '雷达防御契约', pass, fail, skip, notes);
    }

    // ── 维度：defenseGate 与真人击退对齐（HARD）正向不比真人严、反向不在无触发时白撞 ────
    // 拿录制当时的标量快照直驱 feat 导出的同一个 `defenseGate`（单一真相源）：
    //   正向——真人发了 3515 的那一拍，我方闸必须同样放行（否则漏做当日唯一一次机会，功率满格换 5 星的收益丢掉）；
    //   反向——同快照叠加「已满格/已受理/开关关/达拒阈」必须收手，且 deBeginTime≤0 的常态一律不得放行（无攻击白撞）。
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const notes = [];
      const defends = radarWrites.filter((w) => w.cmd === CMD_DEFEND);
      /** 用录制快照驱 feat 闸；战力桩为「达标」，门槛本身已由单测钉住（离线拿不到 PLAYER_LEVEL 表） */
      const gateSnap = (s, over) =>
        defenseGate({
          open: true,
          deBeginTime: s.deBeginTime,
          sign: s.sign,
          maxSign: SIGN_MAX,
          handled: 0,
          rejects: 0,
          limit: 2,
          power: 1e12,
          needPower: 1,
          ...over,
        });
      if (!signTimeline.length) {
        skip++;
        notes.push('本场无 sign/deBeginTime 标量载荷：闸门口径无从对拍，不判负');
      }
      for (const w of defends) {
        const s = snapshotAt(signTimeline, w.t);
        if (!s) {
          skip++;
          continue;
        }
        const g = gateSnap(s);
        if (g.fire) pass++;
        else {
          fail++;
          if (notes.length < 3)
            notes.push(
              '真人已发 3515，feat 闸却 reason=' +
                g.reason +
                '（sign=' +
                s.sign +
                ' deBegin=' +
                s.deBeginTime +
                '）',
            );
        }
      }
      // 反向 1：真人那一拍的同一快照，叠加四种「该收手」前提必须被闸拦住
      for (const w of defends) {
        const s = snapshotAt(signTimeline, w.t);
        if (!s || !(s.deBeginTime > 0)) continue;
        const cases = [
          [{ maxSign: s.sign }, 'full'],
          [{ handled: s.deBeginTime }, 'handled'],
          [{ open: false }, 'off'],
          [{ rejects: 2, limit: 2 }, 'reject-limit'],
        ];
        for (const [over, want] of cases) {
          const g = gateSnap(s, over);
          if (!g.fire && g.reason === want) pass++;
          else {
            fail++;
            if (notes.length < 3)
              notes.push(
                '反向断言失效：' +
                  Object.keys(over)
                    .map((k) => k + '=' + over[k])
                    .join(',') +
                  ' 应 ' +
                  want +
                  '，实得 ' +
                  g.reason,
              );
          }
        }
      }
      // 反向 2：无触发（deBeginTime≤0）的标量时刻一律不得放行
      let noTrig = 0;
      for (const s of signTimeline) {
        if (s.deBeginTime > 0) continue;
        noTrig++;
        const g = gateSnap(s);
        if (!g.fire && g.reason === 'no-trigger') pass++;
        else {
          fail++;
          if (notes.length < 3)
            notes.push('deBeginTime=' + s.deBeginTime + ' 无触发却 reason=' + g.reason);
        }
      }
      if (!noTrig && !defends.length) skip++;
      const trig = new Set(signTimeline.filter((s) => s.deBeginTime > 0).map((s) => s.deBeginTime));
      notes.push(
        '触发时刻实测 ' +
          ([...trig].join('/') || '无') +
          '（' +
          trig.size +
          ' 次）；3515 ' +
          defends.length +
          ' 笔；无触发标量 ' +
          noTrig +
          ' 条（干扰攻击每日至多 1 次，样本天然稀疏）',
      );
      rep.check('defenseGate 与真人击退对齐（正反向）', '雷达防御契约', pass, fail, skip, notes);
    }

    // ── 维度：体力扣减点定位（HARD 仅限「认领/领奖/击退不烧」这一承重前提）───────────
    // 报文实证：只有出兵（902 雷达型 / 1201 集结）那一下烧体力池（type=1）；3505 认领与 3508 领奖不烧。
    // feat 据此把闸插在「起新任务」前、领奖不受体力限制继续做——若哪天认领即烧体，闸位必须重设，故计 FAIL。
    // 而「出兵必有体力跟随」只是反向信息（少一条也不推翻闸位的安全性）→ 计无法判定，不判负。
    // 归因只认跌幅推送：自然回体/用药也会推 10021（两份录制里 21 条全是跌幅、0 条回升，属未覆盖分支），
    // 若不过滤方向，一条回体推送落进 readonly 的 300ms 窗就会把「闸位须重设」的错误结论当 HARD 违例报出来。
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const notes = [];
      const costByReason = new Map(); // reason -> Set(单价)
      /** 该写动作后 windowMs 内的第一条体力推送 */
      const energyAfter = (t, windowMs) => {
        for (const p of energyPushes) {
          if (p.ts < t) continue;
          if (p.ts - t > windowMs) break;
          return p;
        }
        return null;
      };
      /** 该推送相对上一条的跌幅（即本次动作的实扣单价；首条无基线回 null） */
      const unitCost = (p) => {
        const i = energyPushes.indexOf(p);
        if (i <= 0) return null;
        const d = energyPushes[i - 1].point - p.point;
        return Number.isFinite(d) ? d : null;
      };
      /** 该推送是不是「扣体」：回升/持平（自然回体或用药）不算烧体力；首条无基线保守当扣减 */
      const isCost = (p) => {
        const i = energyPushes.indexOf(p);
        if (i <= 0) return true;
        const prev = energyPushes[i - 1].point;
        return !(Number.isFinite(prev) && Number.isFinite(p.point) && p.point >= prev);
      };
      for (const w of radarWrites) {
        const dispatch =
          w.cmd === CMD_CREATE_RALLY ||
          (w.cmd === CMD_MARCH_POINT && RADAR_MT.has(Number(w.body.marchType)));
        const readonly =
          w.cmd === CMD_START_TASK || w.cmd === CMD_GET_REWARD || w.cmd === CMD_DEFEND;
        if (!dispatch && !readonly) continue; // 非雷达型的 902 不归本判据
        // 认领/领奖用 300ms 窄窗：推送紧跟自己那条出兵实测 36~66ms（rec1 36-66 / rec2 35-52），而真人「认领→出兵」
        // 至少隔 740ms（rec2 899ms：3505 @631019 → 902 @631866 → 推送 @631918），宽窗会把出兵那条误算到认领头上。
        const p = energyAfter(w.t, readonly ? 300 : 1500);
        if (dispatch) {
          if (!p) {
            skip++;
            if (notes.length < 3)
              notes.push(`出兵后无体力跟随 cmd=${w.cmd} mt=${w.body.marchType} t=${w.t}`);
            continue;
          }
          pass++;
          const c = unitCost(p);
          if (c != null && c >= 0) {
            const set = costByReason.get(p.reason) || new Set();
            set.add(c);
            costByReason.set(p.reason, set);
          }
        } else if (p && isCost(p)) {
          // 只把「跌幅推送」归因给 readonly；回升/持平（自然回体或用药）不是烧体力，不计违例
          fail++;
          notes.push(`${w.cmd} 不应烧体力却跟了一条 reason=${p.reason} t=${w.t}`);
        } else {
          pass++;
        }
      }
      for (const [reason, set] of costByReason) {
        const arr = [...set].sort((a, b) => a - b);
        // 跌幅按相邻两条推送点位差算，中间若夹了一次不回推的自然回体会把跌幅稀释 1 点 → 取上界为单价
        notes.push(
          `单价实测 ${reason}=${arr.join('/')}${arr.length > 1 ? '（跌幅观测集，取上界为单价）' : ''}`,
        );
      }
      if (!energyPushes.length) skip++;
      rep.check('体力只在出兵时扣（认领/领奖/击退不烧）', '体力闸前提', pass, fail, skip, notes);
    }

    // ── 维度：单飞不变量（SOFT）——真人可并行多条求援，feat 更严（不判负）───────
    {
      let pass = 0;
      let soft = 0;
      const notes = [];
      for (const w of radarWrites) {
        if (w.cmd !== CMD_START_TASK) continue;
        const others = [];
        for (const [id, arr] of stateById) {
          if (id === String(w.body.id)) continue;
          const snap = snapshotAt(arr, w.t);
          if (snap && (snap.state === ST_RUNNING || snap.state === ST_SECONDARY))
            others.push(id + ':' + snap.state);
        }
        if (others.length) {
          soft++;
          if (notes.length < 3)
            notes.push(
              '3505 认领 id=' +
                w.body.id +
                ' 时另有在途 ' +
                others.join('/') +
                '（真人并行，合法）',
            );
        } else pass++;
      }
      rep.check('单飞：认领时他任务不在途（软·观察）', '单飞不变量（软）', pass, 0, soft, notes);
    }

    // ── 维度：Int64 形态（HARD）marchId 恒十进制串，任务 id 恒裸 number ────────
    {
      let pass = 0;
      let fail = 0;
      const fails = [];
      for (const m of S.marchResp) {
        if (m.marchId == null) {
          fail++;
          if (fails.length < 3) fails.push(m.cmd + ' 应答无 marchInfo.marchId');
          continue;
        }
        if (
          typeof m.marchId === 'string' &&
          !isInt64Obj(m.marchId) &&
          Number.isFinite(toNum(m.marchId))
        )
          pass++;
        else {
          fail++;
          if (fails.length < 3)
            fails.push(
              m.cmd + ' marchId 非十进制串: ' + typeof m.marchId + ' ' + JSON.stringify(m.marchId),
            );
        }
      }
      const idForms = new Set();
      for (const w of radarWrites)
        if (w.body.id != null) idForms.add(isInt64Obj(w.body.id) ? 'int64obj' : typeof w.body.id);
      if (idForms.size === 1 && idForms.has('number')) pass++;
      else if (idForms.size !== 0) {
        fail++;
        if (fails.length < 3) fails.push('任务 id 形态混杂/非裸 number: ' + [...idForms].join(','));
      }
      rep.check('marchId=十进制串 / 任务 id=裸 number', 'Int64 形态', pass, fail, 0, fails);
    }

    // ── 维度：应答配对率（OBSERVATION · 脱机采样局限，不判负）────────────────
    {
      const totalW = radarWrites.length;
      const paired = S.pairedResp;
      rep.check('写动作应答配对率', '时序观察', paired, 0, totalW - paired, [
        '配对 ' + paired + '/' + totalW + '（老 send 通道按 raw.s 配对；脱机采样局限，不判负）',
      ]);
    }

    // ── 维度：业务受理码分布（OBSERVATION）——拒因在 feat 侧走 info、不拉黑──────
    {
      let ok = 0;
      let rejected = 0;
      const notes = [];
      for (const w of radarWrites) {
        const r = S.respByRt.get(w.t);
        if (!r || r.s == null) continue;
        if (r.s === 0) ok++;
        else {
          rejected++;
          if (notes.length < 3) notes.push(w.cmd + ' 被拒 s=' + r.s);
        }
      }
      rep.check('应答受理码 s=0 占比', '时序观察', ok, 0, rejected, notes);
    }

    // ── 维度：经验表覆盖度（OBSERVATION）录制里出现的 taskId 与 feat 经验表差集 ──
    {
      const seen = new Set();
      for (const arr of stateById.values()) for (const s of arr) seen.add(s.taskId);
      const known = [...seen].filter((id) => TASK_TYPES[id] != null);
      const unknown = [...seen].filter((id) => TASK_TYPES[id] == null);
      rep.check('taskId 经验表覆盖度', '时序观察', known.length, 0, unknown.length, [
        '经验表内 ' +
          known.join('/') +
          '；表外（须靠 radar_event 本地表）' +
          (unknown.join('/') || '无'),
      ]);
    }
  },
};
