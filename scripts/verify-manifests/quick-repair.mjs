/**
 * 快速修理（quickRepair）feat · 录制仿真对拍 Manifest。
 *
 * 与 cq26-train / radar-task 同层：只声明本 feat 的协议号、现场态与闸门规则；
 * 读录制、二分回溯、应答配对、报告打印、退出码全交给 scripts/replay/ 内核。
 *
 * 运行：node scripts/replay/run.mjs --manifest quick-repair [录制...] [--verbose]
 *      npm run verify:quick-repair
 *
 * 校验维度（真人录制对齐 feat 同一份协议字典）：
 *   D1 载荷逐键形态（HARD）：220/1427 req = {ids:string[]}（非空、逐元素十进制串）；1785/1426/1428 req = {}（1428 允许单条 {id}）；
 *      124 req = {id,useGold:1}（本地钻石逐队列单条：id 非空十进制串、useGold 恒 1）
 *   D2 发送通道（HARD）：本族写/读 req 的 dir 恒 = 'req:send'（V1 旧 JSON 链路，对齐 feat sendGuarded 缺省 protocol=send）
 *   D3 修理/加速目标来源闸（HARD）：220 每个 id ∈ 本录制内 10120 见过的本地伤兵队列（type=1 且 orderId≠"0"）；
 *      1427 每个 id ∈ 13006/1426 见过的跨服战场医院队列；124 单条 id ∈ 10120 本地伤兵队列集 ⇒ 「发了不该发的队列」即违例
 *   D4 免费额度守恒（观察）：1785 resp 序列里 common_use 非降、0≤use≤max、common_max 稳定；thor_max=0 时 free_thor 恒 0
 *   D5 前向完备（SOFT，不判负）：state=0 的本地伤兵是否最终被某笔 220 覆盖（真人可能延后/分批，只报量级）
 *   D6 应答配对与节奏（观察）：写请求应答配对率、code≠0 计数
 *
 * 无双（NewCAB/AVA）协议族维度（录制 20261108T180936-普通无双 + 源码 AVAHospitalComponent 实证）：
 *   D7 无双载荷形态（HARD）：6310 族 ask req 体恒 null；6311 族 cure req = {ids:string[]}；
 *      6312 族 speed req = {ids,useGold}（钻石）或 {ids,itemId,num,useGold}（道具）
 *   D8 无双 ids 来源闸（HARD）：6311 每个 id ∈ 本录制 6310 读到的 state0（待修）集；
 *      6312 每个 id ∈ state0∪state1（权威读见过即可）——录制实证：真人 UI 在 6311 后陈旧快照上
 *      点钻石加速，6312 ids 大多呈 state0 形态（服务端入队后自行裁决），故不能按 state1 分域判负；
 *      发了从未见过的 id 即违例
 *   D9 无双队列态（观察）：6310 resp list 字段形态与 state 分布
 *
 * 医院加速道具（815 ITEM_USE）维度（修正十四：批量枚数 = 时间池模型，实证 20261107T203829 真人 amount=9 / 20261108T173210 逐笔 1 枚）：
 *   D10 815 医院加速道具形态（HARD）：带 param 键的 815 请求体键集恒 {amount,itemid,param}、`amount` 为正整数（枚数，
 *      服务器按 Σ(枚数×单枚秒) 的时间池贪心消耗，故 ≥1 合法、多枚同发亦合法）；param 不得取 feat 源码记载的**必拒形态**
 *      （`"0|0"` → 实证 item_124017）；无 param 键的 815（买油/礼包等非医院用途）不纳入本维度
 *   D11 815 枚数-持有守恒与批量度（观察）：同 itemid 相邻笔用「应答回读的剩余持有」算降幅，接受者降幅 ≥ 请求枚数；
 *      并统计 amount 区间、多枚同发笔数、最长「单枚连发」簇长度（量化“一个个加速” vs “一次发足”）
 *   D12 治疗→加速同周期节奏（观察）：每笔 220/1427 之后首笔同域加速（151/124/1428/医院 815）的间隔分布，
 *      ≤ INTER_SEND_MS 视为拍内同周期，≤ IDLE_TICK_MS 视为 push 边沿/心跳内补上（无勤扫档）
 *
 * 判据分级纪律（对齐 replay-conformance 技能）：退出码只对 HARD 严格。前向完备是 feat 策略、
 *   真人未必逐笔照做，故降为 SOFT（只报不 fail），避免以「真人没修满」冒充 HARD 违例；
 *   反向「发了不该发的队列」跨版本恒成立，保留 HARD。
 *
 * 协议字典来源：CMD_/PUSH_ 协议号 B6 起就近收编 feat 的 constants.js（纯常量模块），
 *   此处直接 import 共用同一份（cs-hunt 同款，判据不另起炉灶）；调参（ORDER_TYPE_HEAL/
 *   INTER_SEND_MS/IDLE_TICK_MS）仍留在 index.js（浏览器模块不可 import），从源码文本抽、抽不到即抛。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanNDJSON } from '../replay/reader.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEAT = path.join(ROOT, 'extension/src/feats/player/quick-repair/index.js');
const SRC = fs.readFileSync(FEAT, 'utf8');
// 协议字典：与 feat 共用同一份 constants.js（B6 就近收编，纯常量模块可直 import；cs-hunt 同款）
const C = await import(
  pathToFileURL(path.join(ROOT, 'extension/src/feats/player/quick-repair/constants.js')).href
);

/**
 * 抽 feat 源码里的 `const NAME = <数字字面量>;`（单一真相源，缺符号即抛）。
 * @param {string} name 常量名
 * @returns {number}
 */
function featNum(name) {
  const m = SRC.match(new RegExp('^const ' + name + ' = (\\d+);', 'm'));
  if (!m) throw new Error('feat 源码里找不到常量 ' + name + '（判据字典与 feat 分叉，拒绝跑）');
  return Number(m[1]);
}

/**
 * 抽 feat 源码里右值为纯算式的数值常量（仅 `N`/`N * M` 两种形态，不做 eval）。
 * @param {string} name 常量名
 * @returns {number}
 */
function featNumExpr(name) {
  const m = SRC.match(new RegExp('^const ' + name + ' = (\\d+)(?: \\* (\\d+))?;$', 'm'));
  if (!m) throw new Error('feat 源码里找不到数值常量 ' + name + '（判据字典与 feat 分叉，拒绝跑）');
  return Number(m[1]) * (m[2] ? Number(m[2]) : 1);
}

const CMD_GET_QUICK_REPARE = C.CMD_GET_QUICK_REPARE; // 1785
const CMD_ARMY_HEAL_LIST = C.CMD_ARMY_HEAL_LIST; // 220
const CMD_GET_CROSS_HOSPITAL_QUEUES = C.CMD_GET_CROSS_HOSPITAL_QUEUES; // 1426
const CMD_ARMY_CROSS_HEAL = C.CMD_ARMY_CROSS_HEAL; // 1427
const CMD_ORDER_QUEUE_ING_DONE = C.CMD_ORDER_QUEUE_ING_DONE; // 151
const CMD_ORDER_QUEUE_SPEED_UP = C.CMD_ORDER_QUEUE_SPEED_UP; // 124
const CMD_SPEEDUP_CROSS_GOLD = C.CMD_SPEEDUP_CROSS_GOLD; // 1428
const CMD_ITEM_USE = C.CMD_ITEM_USE; // 815
const PUSH_ORDER_QUEUES = C.PUSH_ORDER_QUEUES; // 10120
const PUSH_CROSS_QUEUE_ADD = C.PUSH_CROSS_QUEUE_ADD; // 13006
const ORDER_TYPE_HEAL = featNum('ORDER_TYPE_HEAL'); // 1
/** 拍内逐条发包节流与慢心跳兜底窗（D12 节奏分类阈）：取自 feat 源码，不手抄毫秒字面（修正十八已删 ACTIVE_TICK_MS 勤扫档） */
const INTER_SEND_MS = featNumExpr('INTER_SEND_MS');
const IDLE_TICK_MS = featNumExpr('IDLE_TICK_MS');
/**
 * 815 param 必拒形态与拒因：从 feat 头部实证记载里抽（「"0|0" 被服务器拒 s=3/item_124017」），
 * 避免 manifest 与 feat 各存一份字典。
 */
const REJECTED_PARAM_FORM = (SRC.match(/"(\d\|\d)"\s*被服务器拒/) || [])[1] || null;
const REJECT_KEY_TEXT = (SRC.match(/s=\d+\/(item_\d+)/) || [])[1] || '（feat 源码未记载拒因）';
// 无双（NewCAB/AVA）协议族：ask/cure/speed 三件套 × 4 模式，均走 V1 req:send
const CMD_AVA_ASK = C.CMD_AVA_ASK; // 6310
const CMD_AVA_CURE = C.CMD_AVA_CURE; // 6311
const CMD_AVA_SPEED = C.CMD_AVA_SPEED; // 6312
const CMD_TM_ASK = C.CMD_TM_ASK; // 6356
const CMD_TM_CURE = C.CMD_TM_CURE; // 6357
const CMD_TM_SPEED = C.CMD_TM_SPEED; // 6358
const CMD_MASTER_ASK = C.CMD_MASTER_ASK; // 8403
const CMD_MASTER_CURE = C.CMD_MASTER_CURE; // 8404
const CMD_MASTER_SPEED = C.CMD_MASTER_SPEED; // 8405
const CMD_LEGEND_ASK = C.CMD_LEGEND_ASK; // 9055
const CMD_LEGEND_CURE = C.CMD_LEGEND_CURE; // 9056
const CMD_LEGEND_SPEED = C.CMD_LEGEND_SPEED; // 9057
const PUSH_AVA_HOSPITAL_CHANGE = C.PUSH_AVA_HOSPITAL_CHANGE; // 21203
const PUSH_TM_HOSPITAL_CHANGE = C.PUSH_TM_HOSPITAL_CHANGE; // 21211
const PUSH_MASTER_HOSPITAL_CHANGE = C.PUSH_MASTER_HOSPITAL_CHANGE; // 21465
const PUSH_LEGEND_HOSPITAL_CHANGE = C.PUSH_LEGEND_HOSPITAL_CHANGE; // 21562
const AVA_PUSH_CMDS = new Set([
  PUSH_AVA_HOSPITAL_CHANGE,
  PUSH_TM_HOSPITAL_CHANGE,
  PUSH_MASTER_HOSPITAL_CHANGE,
  PUSH_LEGEND_HOSPITAL_CHANGE,
]);
const AVA_ASK_CMDS = new Set([CMD_AVA_ASK, CMD_TM_ASK, CMD_MASTER_ASK, CMD_LEGEND_ASK]);
const AVA_CURE_CMDS = new Set([CMD_AVA_CURE, CMD_TM_CURE, CMD_MASTER_CURE, CMD_LEGEND_CURE]);
const AVA_SPEED_CMDS = new Set([CMD_AVA_SPEED, CMD_TM_SPEED, CMD_MASTER_SPEED, CMD_LEGEND_SPEED]);

/** 本 feat 的写动作（进「写动作分布」统计与 D1/D3 判据）；151/124/1428 属钻石加速、本号可能缺席→无样本即 skip */
const WRITE_CMDS = new Set([
  CMD_ARMY_HEAL_LIST,
  CMD_ARMY_CROSS_HEAL,
  CMD_ORDER_QUEUE_ING_DONE,
  CMD_ORDER_QUEUE_SPEED_UP,
  CMD_SPEEDUP_CROSS_GOLD,
  ...AVA_CURE_CMDS,
  ...AVA_SPEED_CMDS,
]);
/** 权威读（V1 send；1785/1426 空体、无双 ask 族恒 null 体） */
const READ_CMDS = new Set([CMD_GET_QUICK_REPARE, CMD_GET_CROSS_HOSPITAL_QUEUES, ...AVA_ASK_CMDS]);
/** V1 旧 JSON 链路：feat sendGuarded 缺省 protocol=send，故本族 req 线上 dir 恒为 'req:send' */
const reqDirCensus = (dir) => dir === 'req:send';

/** 载荷键集（排序） */
function keysOf(o) {
  return Object.keys(o || {}).sort();
}

/** 业务码（V1 header.s）；旧 JSON 链路 header 可能缺省 → null */
function codeOf(e) {
  const h = e.header || (e.outer && e.outer.header) || null;
  return h && h.s != null ? Number(h.s) : null;
}

/** ids 数组形态校验：非空数组且逐元素为非空字符串 */
function idsShapeOk(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');
}

export default {
  id: 'quick-repair',
  defaultRecs: [
    // 医院现场：1785×22 权威读 + 220×9 免费修 + 1427×2 雷神/跨服 + 10120/13006 队列推
    'dashcam/store/rec/11981629951662/dashcam-rec-20261107T203829-印石-我的日常.ndjson',
  ],

  // ── 现场态重建：单遍扫录制 ──────────────────────────────────────────────
  async buildScan(recPath) {
    /** 1785 额度时间线：{ts, commonMax, commonUse, thorMax, thorUse} */
    const quotaTimeline = [];
    /** 本地伤兵队列 id 集（10120，type=1 且 orderId≠"0"）：id -> {firstTs, sawWait:boolean} */
    const localQueues = new Map();
    /** 跨服队列 id 集（13006 push + 1426 resp）：id -> {st} */
    const crossQueues = new Map();
    /** 写视图：reqTs -> {t,cmd,reqKeys,ids,id,code} */
    const reqPending = new Map();
    /** dir 普查（cmd|dir -> n），供通道判据 */
    const dirCensus = new Map();
    let itemUseCount = 0;
    /** 815 ITEM_USE 请求-应答配对：{t,reqKeys,itemid,amount,hasParam,param,respOk,heldAfter,respKeys,errKey} */
    const item815Pending = new Map();
    const item815Respless = [];
    /** 无双：6310 族 resp list 读次时间线 {ts,askCmd,nWait,nRep,listShapeOk} */
    const avaReads = [];
    /** 无双：全录制见过的 state0（待修）/ state1（在修）/ 任意 state id 集，供 D8 来源闸 */
    const avaKnownWait = new Set();
    const avaKnownRep = new Set();
    const avaKnownAny = new Set();
    let avaAskNullBad = 0; // 无双 ask req 体非 null 的笔数（D7 样本）
    let avaPushCount = 0; // 21203 队列变化 push 次数（D9 观察：feat 靠它唤醒下拍）

    const { writes, respByReqTs, total, parseErr, minTs, maxTs, dirCounts } = await scanNDJSON(
      recPath,
      {
        isWrite: (e) => WRITE_CMDS.has(e.cmd),
        onEntry: (e) => {
          const cmd = e.cmd;
          const b = e.body;
          if (WRITE_CMDS.has(cmd) || READ_CMDS.has(cmd) || AVA_PUSH_CMDS.has(cmd)) {
            const dk = cmd + '|' + e.dir;
            dirCensus.set(dk, (dirCensus.get(dk) || 0) + 1);
          }

          // ① 现场态源先行分派
          if (cmd === CMD_GET_QUICK_REPARE && e.dir === 'resp') {
            const d = b && typeof b === 'object' ? b : {};
            quotaTimeline.push({
              ts: e.ts,
              commonMax: Number(d.common_max) || 0,
              commonUse: Number(d.common_use) || 0,
              thorMax: Number(d.thor_max) || 0,
              thorUse: Number(d.thor_use) || 0,
            });
            return;
          }
          if (cmd === PUSH_ORDER_QUEUES && e.dir === 'push') {
            const arr = (b && b.orderQueues) || [];
            for (const q of arr) {
              if (!q) continue;
              if (Number(q.type) !== ORDER_TYPE_HEAL) continue;
              if (String(q.orderId == null ? '' : q.orderId) === '0') continue;
              const id = String(q.id == null ? '' : q.id);
              if (!id) continue;
              const cur = localQueues.get(id) || { firstTs: e.ts, sawWait: false };
              if (Number(q.state) === 0) cur.sawWait = true;
              localQueues.set(id, cur);
            }
            return;
          }
          const noteCross = (arr, ts) => {
            for (const q of arr || []) {
              if (!q) continue;
              const id = String(q.id == null ? '' : q.id);
              if (!id) continue;
              const st = Number(q.st);
              const prev = crossQueues.get(id);
              if (!prev || (prev.st !== 0 && st === 0)) crossQueues.set(id, { st, ts });
            }
          };
          if (cmd === PUSH_CROSS_QUEUE_ADD && e.dir === 'push') {
            noteCross(b && b.queues, e.ts);
            return;
          }
          if (cmd === CMD_GET_CROSS_HOSPITAL_QUEUES && e.dir === 'resp') {
            noteCross(b && b.queues, e.ts);
            return;
          }
          // ①b 无双现场态：ask 族 resp 的 list（orderId≠"0"，state 0=待修 1=在修）
          if (AVA_ASK_CMDS.has(cmd) && e.dir === 'resp') {
            const list = b && Array.isArray(b.list) ? b.list : null;
            let nWait = 0;
            let nRep = 0;
            let shapeOk = true;
            for (const x of list || []) {
              if (!x) {
                shapeOk = false;
                continue;
              }
              if (String(x.orderId) === '0') continue;
              const id = String(x.id == null ? '' : x.id);
              if (!id) {
                shapeOk = false;
                continue;
              }
              avaKnownAny.add(id);
              if (Number(x.state) === 0) {
                nWait++;
                avaKnownWait.add(id);
              } else if (Number(x.state) === 1) {
                nRep++;
                avaKnownRep.add(id);
              }
            }
            avaReads.push({ ts: e.ts, askCmd: cmd, nWait, nRep, listOk: !!list, shapeOk });
            return;
          }
          if (AVA_ASK_CMDS.has(cmd) && e.dir === 'req:send') {
            if (!(b == null || (typeof b === 'object' && Object.keys(b).length === 0)))
              avaAskNullBad++;
            return;
          }

          if (cmd === PUSH_AVA_HOSPITAL_CHANGE && e.dir === 'push') {
            avaPushCount++;
            return;
          }
          // 无双其余三模式同族 push（feat 四号全订作唤醒；本录制非本场模式的号不会到达）→ 归入 dir 普查即可
          if (AVA_PUSH_CMDS.has(cmd)) return;

          // ② 815 ITEM_USE：逐笔配对应答（带 param 键的才可能是医院加速道具，其余是买油/礼包）
          if (cmd === CMD_ITEM_USE) {
            itemUseCount++;
            if (e.dir.startsWith('req')) {
              item815Pending.set(e.ts, {
                t: e.ts,
                reqKeys: keysOf(b),
                itemid: b && b.itemid != null ? Number(b.itemid) : null,
                amount: b && b.amount != null ? Number(b.amount) : null,
                hasParam: !!(b && typeof b === 'object' && 'param' in b),
                param: b ? b.param : undefined,
                respOk: false,
                heldAfter: null,
                respKeys: null,
                errKey: null,
              });
            } else if (e.dir === 'resp') {
              const rec = item815Pending.get(e.rt);
              if (!rec) {
                item815Respless.push({ t: e.ts, body: b });
              } else if (b && typeof b === 'object') {
                rec.respOk = true;
                rec.respKeys = keysOf(b).join(',');
                rec.heldAfter = Number(b.amount);
              } else {
                rec.respOk = true;
                rec.errKey = typeof b === 'string' ? b : JSON.stringify(b);
              }
            }
            return;
          }

          // ③ 写视图：req 建条目、resp 合并 code
          if (e.dir.startsWith('req')) {
            if (!WRITE_CMDS.has(cmd)) return;
            reqPending.set(e.ts, {
              t: e.ts,
              cmd,
              reqKeys: keysOf(b),
              ids: Array.isArray(b && b.ids) ? b.ids.map(String) : null,
              id: b && b.id != null ? String(b.id) : null,
              useGold: b && typeof b.useGold === 'number' ? b.useGold : null,
              itemId: b && b.itemId != null ? Number(b.itemId) : null,
              num: b && b.num != null ? Number(b.num) : null,
              ava: AVA_CURE_CMDS.has(cmd) || AVA_SPEED_CMDS.has(cmd),
              code: null,
            });
            return;
          }
          if (e.dir === 'resp' && WRITE_CMDS.has(cmd)) {
            const rec = reqPending.get(e.rt);
            if (rec) {
              // V1 send 应答无 header.s：以「同 rt 有应答回来」记 responded，业务码不可得则留 null
              rec.responded = true;
              rec.code = codeOf(e);
            }
            return;
          }
        },
      },
    );

    quotaTimeline.sort((a, b) => a.ts - b.ts);
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
      quotaTimeline,
      localQueues,
      crossQueues,
      reqs,
      dirCensus,
      itemUseCount,
      item815: [...item815Pending.values()].sort((a, b) => a.t - b.t),
      item815Respless,
      healReqs: byCmd(CMD_ARMY_HEAL_LIST),
      thorReqs: byCmd(CMD_ARMY_CROSS_HEAL),
      goldReqs: byCmd(CMD_ORDER_QUEUE_ING_DONE).concat(byCmd(CMD_SPEEDUP_CROSS_GOLD)),
      perQueueGoldReqs: byCmd(CMD_ORDER_QUEUE_SPEED_UP),
      avaCureReqs: reqs.filter((x) => AVA_CURE_CMDS.has(x.cmd)),
      avaSpeedReqs: reqs.filter((x) => AVA_SPEED_CMDS.has(x.cmd)),
      avaReads,
      avaKnownWait,
      avaKnownRep,
      avaKnownAny,
      avaAskNullBad,
      avaPushCount,
    };
  },

  // ── 判据 ──────────────────────────────────────────────────────────────
  runVerify(S, rep) {
    const D1 = '载荷逐键形态';
    const D2 = '发送通道';
    const D3 = '修理/加速目标来源闸';
    const D4 = '免费额度守恒（观察）';
    const D5 = '前向完备（观察·SOFT）';
    const D6 = '应答配对与节奏（观察）';
    const D7 = '无双载荷形态';
    const D8 = '无双 ids 来源闸';
    const D9 = '无双队列态（观察）';
    const D10 = '815 医院加速道具形态';
    const D11 = '815 枚数-持有守恒与批量度（观察）';
    const D12 = '治疗→加速同周期节奏（观察）';

    const healTargetIds = new Set([...S.localQueues.keys()]);
    const crossTargetIds = new Set([...S.crossQueues.keys()]);

    /**
     * 医院加速道具样本鉴定（不钉 itemid 字面，不依赖 ITEM 表）：
     *   ① 请求体带 `param` 键（买油/礼包等无 param）；
     *   ② param 形如 feat itemSpeedParam 产出（null / 纯数字串 / "1|…" / "1,…"），或取 feat 源码记载的必拒形态（便于抓回归）；
     *   ③ 应答形态含医院回读签名 {amount,itemId}（剩余持有）即算——按**子集**判定，服务器应答加列不该把真样本全排除；
     *      未配到应答或为拒因串者保留（真样本被拒时仍需 D10/D11 可见）。
     * 反例：`{itemid:1648,param:"920005|1"}` 属其它道具使用，不入本维度。
     * 已知局限（实测 20261107T020125-11 / 092411 / 124846 / 142705 等 21 笔）：无 `param` 键的 815
     *   （`{amount,itemid}`，如 1700039/600001/5101101）应答键集也是 {amount,itemId}，与「医院侧 param 漏发」
     *   不可区分 ⇒ 本维度不能按键集放宽入口（否则假 FAIL），该回归改由单测
     *   tests/feats/quick-repair.test.js（断言 815 body 键集含 param）承担。
     */
    const hospSpeed = S.item815.filter((w) => {
      if (!w.hasParam) return false;
      const s = String(w.param);
      const formOk =
        w.param == null ||
        /^1[|,]/.test(s) ||
        /^\d+$/.test(s) ||
        (!!REJECTED_PARAM_FORM && s === REJECTED_PARAM_FORM);
      if (!formOk) return false;
      if (!w.respOk || w.errKey != null) return true;
      const rs = w.respKeys ? w.respKeys.split(',') : [];
      return rs.includes('amount') && rs.includes('itemId');
    });
    const excluded815 = S.item815.length - hospSpeed.length;

    // D1 每类写请求的键集与 ids 形态
    {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      const scanWrite = (w, wantKeys, needIds) => {
        if (!keysOf(w.reqKeys).length && !w.reqKeys.length) {
          skip++;
          return;
        }
        const keyOk =
          w.reqKeys.length === wantKeys.length && w.reqKeys.every((k, i) => k === wantKeys[i]);
        if (!keyOk) {
          fail++;
          samples.push(`cmd=${w.cmd} req={${w.reqKeys.join(',')}} 期望={${wantKeys.join(',')}}`);
          return;
        }
        if (needIds && !idsShapeOk(w.ids)) {
          fail++;
          samples.push(`cmd=${w.cmd} ids 非「非空字符串数组」（${JSON.stringify(w.ids)}）`);
          return;
        }
        pass++;
      };
      for (const w of S.healReqs) scanWrite(w, ['ids'], true);
      for (const w of S.thorReqs) scanWrite(w, ['ids'], true);
      for (const w of S.goldReqs) {
        // 151/1428 全量 {} 或单条 {id}
        const ok = w.reqKeys.length === 0 || (w.reqKeys.length === 1 && w.reqKeys[0] === 'id');
        if (ok) pass++;
        else {
          fail++;
          samples.push(`cmd=${w.cmd} req={${w.reqKeys.join(',')}} 期望 {} 或 {id}`);
        }
      }
      for (const w of S.perQueueGoldReqs) {
        // 124 本地钻石逐队列单条：{id,useGold:1}（与 151/1428 的 {}/{id} 期望不同，独立分支）
        const keyOk = w.reqKeys.length === 2 && w.reqKeys.join(',') === 'id,useGold';
        if (!keyOk) {
          fail++;
          samples.push(`cmd=${w.cmd} req={${w.reqKeys.join(',')}} 期望={id,useGold}`);
        } else if (!w.id || !/^\d+$/.test(w.id)) {
          fail++;
          samples.push(`cmd=${w.cmd} id=${JSON.stringify(w.id)} 非「非空十进制串」`);
        } else if (w.useGold !== 1) {
          fail++;
          samples.push(`cmd=${w.cmd} useGold=${JSON.stringify(w.useGold)} 期望 1`);
        } else pass++;
      }
      if (pass + fail === 0) {
        rep.check('本场无本族写样本，不判定', D1, 0, 0, 1, []);
      } else {
        rep.check(
          '写请求键集/ids 形态（220·1427={ids}，151·1428={}/{id}，124={id,useGold}）',
          D1,
          pass,
          fail,
          skip,
          samples,
        );
      }
    }

    // D2 写/读动作线上通道恒为 req:send（V1）
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const [dk, n] of S.dirCensus) {
        const i = dk.indexOf('|');
        const cmd = Number(dk.slice(0, i));
        const dir = dk.slice(i + 1);
        if (!dir.startsWith('req:')) continue;
        if (reqDirCensus(dir)) pass += n;
        else {
          fail += n;
          samples.push(
            `cmd=${cmd} dir=${dir} ≠ req:send（feat sendGuarded 缺省 protocol=send，通道漂移需查）`,
          );
        }
      }
      if (pass + fail === 0) rep.check('无 req 样本，不判定通道', D2, 0, 0, 1, []);
      else rep.check('本族 req 通道恒为 req:send（V1 旧 JSON）', D2, pass, fail, 0, samples);
    }

    // D3 修理/加速目标来源闸（HARD）：ids 必须是本录制内确认过的伤兵/跨服队列
    if (healTargetIds.size || crossTargetIds.size) {
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const samples = [];
      for (const w of S.healReqs.concat(S.thorReqs)) {
        const isCross = w.cmd === CMD_ARMY_CROSS_HEAL;
        const allowed = isCross ? crossTargetIds : healTargetIds;
        const bad = (w.ids || []).filter((id) => !allowed.has(id));
        if (!bad.length) pass++;
        else {
          fail++;
          samples.push(
            `cmd=${w.cmd} 有 ${bad.length} 个 id 不在${isCross ? '跨服(13006/1426)' : '本地伤兵(10120)'}队列集：${bad.slice(0, 3).join(',')}`,
          );
        }
      }
      for (const w of S.perQueueGoldReqs) {
        // 124 单条目标必须是本地伤兵队列；本场无 10120 队列态样本时不可判定
        if (!healTargetIds.size) {
          skip++;
          continue;
        }
        if (w.id && healTargetIds.has(w.id)) pass++;
        else {
          fail++;
          samples.push(`cmd=${w.cmd} id=${JSON.stringify(w.id)} 不在本地伤兵(10120)队列集`);
        }
      }
      const n = S.healReqs.length + S.thorReqs.length + S.perQueueGoldReqs.length;
      if (!n) rep.check('本场无 220/1427/124 写样本，不判定目标来源', D3, 0, 0, 1, []);
      else
        rep.check(
          '220/1427/124 目标 id 均源自权威队列态（反向防漏发/误发）',
          D3,
          pass,
          fail,
          skip,
          samples,
        );
    } else {
      rep.check('无 10120/13006 队列态样本，目标来源不可判定', D3, 0, 0, 1, []);
    }

    // D4 免费额度守恒（观察）
    {
      const q = S.quotaTimeline;
      if (q.length < 2) {
        rep.check(
          q.length ? '仅 1 次 1785 读，额度守恒不可判定' : '本场无 1785 读',
          D4,
          0,
          0,
          1,
          [],
        );
      } else {
        let mono = 0;
        let regress = 0;
        const samples = [];
        for (let i = 1; i < q.length; i++) {
          if (q[i].commonUse >= q[i - 1].commonUse) mono++;
          else {
            regress++;
            samples.push(`common_use 回落 ${q[i - 1].commonUse}→${q[i].commonUse}（跨日刷新?）`);
          }
        }
        const maxSet = [...new Set(q.map((x) => x.commonMax))];
        const over = q.filter((x) => x.commonUse > x.commonMax).length;
        const thorZeroFree = q.every((x) => x.thorMax === 0 || x.thorUse <= x.thorMax);
        samples.push(
          `common_max 取值集=[${maxSet.join(',')}]；common_use 区间=[${Math.min(...q.map((x) => x.commonUse))},${Math.max(...q.map((x) => x.commonUse))}]；use>max 违例 ${over}；thor_max=0 一致性 ${thorZeroFree}`,
        );
        // 观察项：以「额度守恒」陈述为主，违例只标注不判负（真人跨日/多页会合法回落）
        rep.check(
          `1785 额度序列单调不降 ${mono}/${mono + regress}${regress ? '（有回落，见样本）' : ''}`,
          D4,
          0,
          0,
          q.length,
          samples,
        );
      }
    }

    // D5 前向完备（SOFT，不判负）：state=0 的本地伤兵是否最终被某笔 220 覆盖
    {
      const healed = new Set();
      for (const w of S.healReqs) for (const id of w.ids || []) healed.add(id);
      const waitIds = [...S.localQueues.entries()].filter(([, v]) => v.sawWait).map(([k]) => k);
      if (!waitIds.length) {
        rep.check('无 state=0 本地伤兵样本，前向完备不可判定', D5, 0, 0, 1, []);
      } else {
        const missed = waitIds.filter((id) => !healed.has(id));
        // 真人未必把所有伤兵一次修满，故作为观察项：missed 只标注、不计 fail
        rep.check(
          `待修伤兵 ${waitIds.length} 个，被 220 覆盖 ${waitIds.length - missed.length} 个${missed.length ? '｜未覆盖 ' + missed.length + ' 个（真人分批/延后，非违例）' : ''}`,
          D5,
          0,
          0,
          waitIds.length,
          missed.length ? ['未覆盖样例: ' + missed.slice(0, 3).join(',')] : [],
        );
      }
    }

    // D6 应答配对与节奏（观察）
    {
      const reqs = S.reqs.length;
      const responded = S.reqs.filter((w) => w.responded).length;
      const rejects = S.reqs.filter((w) => w.code != null && w.code !== 0).length;
      const rate = reqs ? ((responded / reqs) * 100).toFixed(1) : '0.0';
      const samples = [];
      if (S.itemUseCount) {
        samples.push(
          `815 ITEM_USE ×${S.itemUseCount}（其中医院加速道具候选 ${S.item815.filter((x) => x.hasParam).length} 笔带 param 键，明细见 D10/D11）`,
        );
      }
      samples.push(
        'V1 send 应答无 header.s：以「同 rt 有应答回来」计配对率，业务码不可得（拒因走 feat 的 rejectText，另一路）',
      );
      samples.push(
        '「服务器拒绝」(code≠0) 在 feat 走 info、「没发出去」走 CODE_NOT_SENT，两者不得混判',
      );
      rep.check(
        `本族写请求 ${reqs} 笔，应答已回 ${responded}/${reqs}（${rate}%），可判 code≠0 ${rejects} 条`,
        D6,
        0,
        0,
        responded,
        samples,
      );
    }

    // D7 无双载荷形态（HARD）：cure={ids}、speed={ids,useGold}|{ids,itemId,num,useGold}、ask req 体恒 null
    {
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const w of S.avaCureReqs) {
        const keyOk = w.reqKeys.length === 1 && w.reqKeys[0] === 'ids';
        if (!keyOk) {
          fail++;
          samples.push(`cmd=${w.cmd} req={${w.reqKeys.join(',')}} 期望={ids}`);
        } else if (!idsShapeOk(w.ids)) {
          fail++;
          samples.push(`cmd=${w.cmd} ids 非「非空字符串数组」（${JSON.stringify(w.ids)}）`);
        } else pass++;
      }
      for (const w of S.avaSpeedReqs) {
        const k = w.reqKeys.join(',');
        const goldForm = k === 'ids,useGold';
        const itemForm = k === 'ids,itemId,num,useGold';
        if (!goldForm && !itemForm) {
          fail++;
          samples.push(`cmd=${w.cmd} req={${k}} 期望 {ids,useGold} 或 {ids,itemId,num,useGold}`);
        } else if (!idsShapeOk(w.ids)) {
          fail++;
          samples.push(`cmd=${w.cmd} ids 非「非空字符串数组」（${JSON.stringify(w.ids)}）`);
        } else if (w.useGold !== 1 && w.useGold !== 0) {
          fail++;
          samples.push(`cmd=${w.cmd} useGold=${JSON.stringify(w.useGold)} 期望 0|1`);
        } else if (itemForm && (!Number.isFinite(w.itemId) || !(Number(w.num) > 0))) {
          fail++;
          samples.push(`cmd=${w.cmd} 道具形态 itemId/num 非法：itemId=${w.itemId} num=${w.num}`);
        } else pass++;
      }
      if (S.avaAskNullBad) {
        fail += S.avaAskNullBad;
        samples.push(`无双 ask req 体非 null ×${S.avaAskNullBad}（源码 NET.send(6310,null)）`);
      } else if (S.avaReads.length) {
        pass += S.avaReads.length;
      }
      const n = S.avaCureReqs.length + S.avaSpeedReqs.length + S.avaReads.length;
      if (!n) rep.check('本场无双族无样本，不判定载荷形态', D7, 0, 0, 1, []);
      else
        rep.check(
          '无双 cure={ids}、speed={ids,useGold}|{ids,itemId,num,useGold}、ask 体 null',
          D7,
          pass,
          fail,
          0,
          samples,
        );
    }

    // D8 无双 ids 来源闸（HARD）：cure 目标 ∈ state0 集；speed 目标 ∈ state0∪state1（录制实证 6312 可发陈旧 state0 快照，入队与否由服务端裁决）
    {
      const hasPool = S.avaKnownWait.size || S.avaKnownRep.size;
      const n = S.avaCureReqs.length + S.avaSpeedReqs.length;
      if (!hasPool || !n) {
        rep.check(
          !n ? '本场无双族无写样本，不判定目标来源' : '无双 ask 读无队列态样本，目标来源不可判定',
          D8,
          0,
          0,
          1,
          [],
        );
      } else {
        let pass = 0;
        let fail = 0;
        const samples = [];
        for (const w of S.avaCureReqs) {
          const bad = (w.ids || []).filter((id) => !S.avaKnownWait.has(id));
          if (!bad.length) pass++;
          else {
            fail++;
            samples.push(
              `cmd=${w.cmd} 有 ${bad.length} 个 id 不在 6310 族 state0（待修）集：${bad.slice(0, 3).join(',')}`,
            );
          }
        }
        for (const w of S.avaSpeedReqs) {
          const bad = (w.ids || []).filter((id) => !S.avaKnownAny.has(id));
          if (!bad.length) pass++;
          else {
            fail++;
            samples.push(
              `cmd=${w.cmd} 有 ${bad.length} 个 id 从未出现在 6310 族权威读（state0∪state1）：${bad.slice(0, 3).join(',')}`,
            );
          }
        }
        rep.check(
          '无双 cure∈state0、speed∈state0∪state1：目标 id 均源自 6310 族权威队列态',
          D8,
          pass,
          fail,
          0,
          samples,
        );
      }
    }

    // D9 无双队列态（观察）：ask resp list 存活性与 state 分布
    {
      if (!S.avaReads.length) {
        rep.check('本场无无双 ask（6310 族）读样本，队列态不可判定', D9, 0, 0, 1, []);
      } else {
        const badList = S.avaReads.filter((r) => !r.listOk).length;
        const badShape = S.avaReads.filter((r) => r.listOk && !r.shapeOk).length;
        const askSet = [...new Set(S.avaReads.map((r) => r.askCmd))].sort((a, b) => a - b);
        const speedFromRep = S.avaSpeedReqs.filter((w) =>
          (w.ids || []).some((id) => S.avaKnownRep.has(id)),
        ).length;
        const pushSeen = [...S.dirCensus.keys()]
          .filter((dk) => {
            const i = dk.indexOf('|');
            return AVA_PUSH_CMDS.has(Number(dk.slice(0, i))) && dk.slice(i + 1) === 'push';
          })
          .map((dk) => dk.slice(0, dk.indexOf('|')) + '×' + S.dirCensus.get(dk));
        const samples = [
          `ask 应答 ${S.avaReads.length} 次（cmd集=[${askSet.join(',')}]），list 缺失 ${badList}、条目形态异常 ${badShape}`,
          `21203 队列变化 push ×${S.avaPushCount}（feat 订阅它作下拍唤醒提示，不做硬判）；四模式 push 实测：${pushSeen.length ? pushSeen.join(' ') : '仅 NewCAB 系'}`,
          `state0 全集 ${S.avaKnownWait.size} 个、state1 全集 ${S.avaKnownRep.size} 个（单次读最大待修 ${Math.max(...S.avaReads.map((r) => r.nWait))}）`,
          `6312 含 state1 id 的笔数 ${speedFromRep}/${S.avaSpeedReqs.length}（录制实证：真人多在 6311 后的陈旧 state0 快照上直点钻石，语义是「直接修完」而非「加速在修」，不入 HARD 判据）`,
          '模式择表（6310/6356/8403/9055）属 feat 策略，此处只报实测 cmd 集不判负',
        ];
        rep.check(
          '无双 ask 读 list 形态与 state 分布（观察）',
          D9,
          0,
          0,
          S.avaReads.length,
          samples,
        );
      }
    }

    // D10 815 医院加速道具形态（HARD）：键集 {amount,itemid,param}、amount 正整数（时间池枚数）、param 非必拒形态
    {
      const bearing = hospSpeed;
      let pass = 0;
      let fail = 0;
      const samples = [];
      for (const w of bearing) {
        const keyOk = w.reqKeys.length === 3 && w.reqKeys.join(',') === 'amount,itemid,param';
        if (!keyOk) {
          fail++;
          samples.push(`ts=${w.t} 815 键集 {${w.reqKeys.join(',')}} 期望 {amount,itemid,param}`);
          continue;
        }
        if (!Number.isInteger(w.amount) || w.amount < 1) {
          fail++;
          samples.push(
            `ts=${w.t} itemid=${w.itemid} amount=${JSON.stringify(w.amount)} 非正整数枚数`,
          );
          continue;
        }
        if (REJECTED_PARAM_FORM && String(w.param) === REJECTED_PARAM_FORM) {
          fail++;
          samples.push(
            `ts=${w.t} itemid=${w.itemid} param="${REJECTED_PARAM_FORM}" 为 feat 源码记载的必拒形态（实证 ${REJECT_KEY_TEXT}）`,
          );
          continue;
        }
        pass++;
      }
      const plain = excluded815;
      if (!bearing.length) {
        // 无 param 键的 815 不可归因（见上方已知局限），本场确无医院样本时属固有的「无法判定」，不判负。
        rep.check(
          `本场 815 ${S.item815.length} 笔均非医院加速道具用途（无 param 键或属其它道具编码），形态不可判定`,
          D10,
          0,
          0,
          1,
          [],
        );
      } else {
        rep.check(
          `815 医院加速道具样本 ${bearing.length} 笔（另有 ${plain} 笔非医院用途未纳入）：键集/枚数/param 形态`,
          D10,
          pass,
          fail,
          0,
          samples,
        );
      }
    }

    // D11 815 枚数-持有守恒与批量度（观察）：多枚同发是否被接受、是否仍在「一个个加速」
    {
      const hosp = hospSpeed;
      if (!hosp.length) {
        rep.check('无医院加速道具 815 样本，枚数守恒与批量度不可判定', D11, 0, 0, 1, []);
      } else {
        const byItem = new Map();
        for (const w of hosp) {
          const k = String(w.itemid);
          if (!byItem.has(k)) byItem.set(k, []);
          byItem.get(k).push(w);
        }
        const samples = [];
        let conserved = 0;
        let shorted = 0;
        let unknown = 0;
        let multiAccepted = 0;
        for (const [iid, list] of byItem) {
          let run = 0;
          let longestRun = 0;
          let prevHeld = null;
          for (const w of list) {
            if (w.amount === 1) {
              run++;
              if (run > longestRun) longestRun = run;
            } else {
              run = 0;
            }
            const heldOk = w.respOk && Number.isFinite(w.heldAfter);
            if (!heldOk) {
              unknown++;
              continue;
            }
            if (w.amount > 1) multiAccepted++;
            if (prevHeld != null) {
              const drop = prevHeld - w.heldAfter;
              if (drop >= w.amount) conserved++;
              else shorted++;
            }
            prevHeld = w.heldAfter;
          }
          const amts = list.map((x) => x.amount);
          samples.push(
            `#${iid}：${list.length} 笔，amount 区间=[${Math.min(...amts)},${Math.max(...amts)}]，多枚同发（已接受）${
              amts.filter((a) => a > 1).length
            } 笔，最长「单枚连发」簇 ${longestRun}`,
          );
        }
        samples.push(
          `持有守恒：可判相邻笔降幅 ≥ 请求枚数 ${conserved} 笔、降幅不足 ${shorted} 笔（中途获得/消耗道具可合法出现，不判负）；无持有回读 ${unknown} 笔`,
        );
        samples.push(
          `服务器接受多枚同发的实证：${multiAccepted} 笔 amount>1 且应答回读剩余持有；单枚连发簇长度量化“一个个加速”旧病灶（目标：一次发足）`,
        );
        samples.push(
          '单枚折算秒数（ITEM 行 para1）属游戏侧表值，本维度不钉字面，避免与 feat 口径分叉',
        );
        rep.check(
          '815 枚数与背包剩余持有降幅、多枚同发接受度（观察）',
          D11,
          0,
          0,
          hosp.length,
          samples,
        );
      }
    }

    // D12 治疗→加速同周期节奏（观察）：每笔治疗后首笔同域加速的间隔
    {
      const heals = S.healReqs.concat(S.thorReqs).sort((a, b) => a.t - b.t);
      const speeds = S.goldReqs
        .concat(S.perQueueGoldReqs)
        .concat(
          hospSpeed.map((w) => ({
            t: w.t,
            cmd: CMD_ITEM_USE,
            cross: String(w.param).charAt(0) === '1',
          })),
        )
        .sort((a, b) => a.t - b.t);
      if (!heals.length || !speeds.length) {
        rep.check(
          !heals.length ? '本场无 220/1427 治疗写样本' : '本场无钻石/道具加速写样本',
          D12,
          0,
          0,
          1,
          [],
        );
      } else {
        const same = [];
        let noSpeed = 0;
        for (const h of heals) {
          const wantCross = h.cmd === CMD_ARMY_CROSS_HEAL;
          let gap = null;
          for (const s of speeds) {
            if (s.t < h.t) continue;
            const isCross =
              s.cmd === CMD_SPEEDUP_CROSS_GOLD ? true : s.cmd === CMD_ITEM_USE ? !!s.cross : false;
            if (isCross === wantCross) {
              gap = s.t - h.t;
              break;
            }
          }
          if (gap == null) noSpeed++;
          else same.push(gap);
        }
        if (!same.length) {
          rep.check(
            `治疗 ${heals.length} 笔后同域再无可判定的加速动作`,
            D12,
            0,
            0,
            heals.length,
            [],
          );
        } else {
          same.sort((a, b) => a - b);
          const inTick = same.filter((g) => g <= INTER_SEND_MS).length;
          const nextTick = same.filter((g) => g > INTER_SEND_MS && g <= IDLE_TICK_MS).length;
          const slower = same.length - inTick - nextTick;
          const med = same[Math.floor(same.length / 2)];
          const samples = [
            `间隔（ms）：min=${same[0]} 中位=${med} max=${same[same.length - 1]}；可判 ${same.length}/${heals.length} 笔（无后续同域加速 ${noSpeed}）`,
            `拍内同周期（≤ INTER_SEND_MS=${INTER_SEND_MS}ms）${inTick}；push 边沿/心跳内（≤ IDLE_TICK_MS=${IDLE_TICK_MS}ms）${nextTick}；更久 ${slower}`,
            'feat 在治疗落地后同拍补跑加速层，靠 push 边沿/kick 即时唤醒、慢心跳兜底',
            '真人录制的手动节奏（先修后看再点）也会计入「更久」，故只报量级不判负',
          ];
          rep.check(
            `治疗后首笔同域加速间隔：拍内 ${inTick}/${same.length}（观察）`,
            D12,
            0,
            0,
            same.length,
            samples,
          );
        }
      }
    }
  },
};
