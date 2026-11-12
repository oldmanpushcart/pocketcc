/**
 * CQ26 荒芜冰原矿区 · 采集行军的「安全期套利」状态机（feats/cq26/wl-mine/march-loop.js）
 *
 * 玩法内核：单日采集额度（`todayCanGatherTime`，满值 16h）不是一次派完，而是**按安全期切轮**——
 *   一个点从「行军到达」起进入 `conf(52000367)`（实测 7200s = 2h）的成熟倒计时；**在此之前把它召回**，
 *   别人就盗不走（`canSteal` 的 `gst + mature <= now` 不成立），而我们已经拿到这一段的产出。
 *   于是 16h 额度 ≈ 8 轮 × 2h，每轮都要重新选点、重新派兵。本模块只管这三态与召回时机：
 *
 *   IDLE ──2114 成功──► GATHERING ──now >= recallAt──► RECALLING ──10007 state=4──► IDLE
 *
 * `recallAt = marchArrive + matureSec - RECALL_MARGIN_SEC`（`marchArrive` 未知时以派兵秒兜底：
 *   派兵秒 ≤ 真实到达秒 ⇒ 召回点只会偏早不会偏晚，方向上安全 —— 偏晚才会被别人盗，偏早只是少赚这一段）。
 *
 * 窗长是「本轮属性」不是「conf 常量」：一天跑到剩余额度塞不满一个安全期时，上层会把尾轮窗长压成
 *   剩余额度发进 `beginRound`（零头本来就是要作废的，短窗召回仍早于成熟线，套利方向不破）。
 *   本模块为此把窗长定格在 `roundMatureSec`，后续校准 `arrive` 时按它重算，不会升级回 conf 原值。
 *
 * marchId 的来源（**实测修订，与计划书 §5 不同**）：2114 的应答只有 `{isOk}`，本人这条 315 行军
 *   **也不在 856 `GET_ALL_MY_MARCH_INFO` 里**（真人录制实证：856 只有开局遗留的 type 3/25 三条；
 *   见 docs/feat-荒芜冰原-采集.md §3.6；856 快照实测不含本人这条 315）。可用来源只有两条：
 *     A. 901 `marchList`（`marchInfo:true`，以派兵点为窗心的小窗探针）—— 下发口径是「行军线段是否穿窗」
 *        而非「起终点是否在窗内」，故在途行军必在表内（core/map.js fetchWindow 注记）；
 *     B. 10007 / 10019 行军推送 —— 由 index.js 转交本模块就地认领。
 *   两条都没命中时**不阻塞召回**：仍按 recallAt 发 2121 的前置判断会失败并 debug，下一拍重试；
 *   绝不为「拿到 id」而放大扫描成本。
 *
 * 池化对象红线：本模块只存标量（数字/字符串），不持有任何报文对象引用。
 */
import { createLog } from '../../../core/log.js';
import { bits } from '../../../core/game-api.js';
import { march } from '../../../core/march.js';
import { fetchWindow } from '../../../core/map.js';
import { doRecall } from './act.js';
import {
  CMD_RECALL,
  MARCH_PROBE_VIEW_LEVEL,
  MARCH_PROBE_WH,
  MARCH_TYPE_GATHER,
  RECALL_FAIL_BACKOFF_MS,
  RECALL_FAIL_MAX,
  RECALL_MARGIN_SEC,
  RECALL_TIMEOUT_SEC,
} from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-MINE-MARCH');

/** 三态字面量（对外只回字符串，便于 index.js 直接映射成 cycle delay 档位）。 */
export const PHASE_IDLE = 'IDLE';
/** 在途/在采：等安全期窗走完就召回 */
export const PHASE_GATHERING = 'GATHERING';
/** 已发 2121，等 10007 state=4 认定回城 */
export const PHASE_RECALLING = 'RECALLING';

/** @type {string} 当前态 */
var phase = PHASE_IDLE;
/** @type {string} 本轮采集行军 id（十进制字符串，永不 Number 化） */
var marchId = '';
/** @type {{x:number,y:number,k:number,specIndex:number}|null} 本轮目标点（标量副本） */
var point = null;
/** @type {number} 预计开始采集的服务器秒（行军到达；未知时 = 派兵秒，见文件头方向性论证） */
var arriveAtSec = 0;
/** @type {number} 该发 2121 的服务器秒 */
var recallAtSec = 0;
/** @type {number} 发出 2121 的本地毫秒（RECALL_TIMEOUT_SEC 兜底基准） */
var recallSentAtMs = 0;
/** @type {number} 上次 marchId 探针的本地毫秒（节流） */
var probeAtMs = 0;
/** @type {boolean} 探针在途 */
var probeInFlight = false;
/** @type {number} 本轮召回连续失败次数（成功/换轮/归零） */
var recallFails = 0;
/** @type {number} 下次允许尝试召回的本地毫秒（0=不退避） */
var recallNextAtMs = 0;
/**
 * @type {number} 本轮定格的窗长（秒），0 = 未定格（回落到 `setMatureSec` 的 conf 现读值）。
 * 上层可以把尾轮（当日额度只剩零头）的窗长压成「剩余额度」发进来；窗长属于**本轮属性**，故必须在此定格：
 *   否则 `onMarch` / `resolveMarchId` 拿到更准的 `marchArrive` 后会拿 conf 原值重算 `recallAtSec`，
 *   把短窗升级回完整安全期 —— 召回点越过成熟线，这一段的产出正好送给偷的人。
 */
var roundMatureSec = 0;

/**
 * 纯函数：召回时刻。`matureSec` 不可得（conf 读空）时回 0 ⇒ 调用方视为「无法求值」，整腿停摆而不是拍脑袋召回。
 * @param {number} arriveAtSec 行军到达的服务器秒
 * @param {number|null} matureSec `conf(52000367)`
 * @param {number} [marginSec] 撤回余量
 * @returns {number} 0=无从判定
 */
export function computeRecallAt(arriveAtSec, matureSec, marginSec) {
  var a = Number(arriveAtSec) || 0;
  var m = Number(matureSec);
  if (!a || typeof m !== 'number' || m <= 0) return 0;
  var mg = marginSec == null ? RECALL_MARGIN_SEC : Number(marginSec) || 0;
  return a + m - mg;
}

/** 当前状态快照（面板与 debug 用，全是标量）。 */
export function snapshot() {
  return {
    phase: phase,
    marchId: marchId,
    x: point ? point.x : 0,
    y: point ? point.y : 0,
    arriveAtSec: arriveAtSec,
    recallAtSec: recallAtSec,
  };
}

/** 是否处于「有采集行军占用」的态（index.js 用它决定本拍要不要选点派兵）。 */
export function isBusy() {
  return phase !== PHASE_IDLE;
}

/**
 * 2114 成功（或重启后认领到在途 315 行军）→ 进入 GATHERING。
 * @param {{x:number,y:number,k:number,specIndex:number}} p 目标点（标量副本）
 * @param {number} nowSec 服务器秒（派兵/认领时刻）
 * @param {number|null} matureSec 本轮窗长（通常 = `conf(52000367)`；尾轮由上层压成剩余额度，见本模块文件头）
 * @param {string} [id] 已解析出的 marchId
 * @param {number} [arrive] 已解析出的行军到达服务器秒
 * @returns {void}
 */
export function beginRound(p, nowSec, matureSec, id, arrive) {
  point = {
    x: Number(p.x) | 0,
    y: Number(p.y) | 0,
    k: Number(p.k) | 0,
    specIndex: Number(p.specIndex) || 0,
  };
  marchId = id ? String(id) : '';
  roundMatureSec = Number(matureSec) > 0 ? Number(matureSec) : 0;
  arriveAtSec = Number(arrive) > 0 ? Number(arrive) : Number(nowSec) | 0;
  recallAtSec = computeRecallAt(arriveAtSec, readMature());
  recallSentAtMs = 0;
  probeAtMs = 0;
  recallFails = 0;
  recallNextAtMs = 0;
  phase = PHASE_GATHERING;
  log.debug(
    'GATHERING (%d,%d) arrive=%d recallAt=%d id=%s',
    point.x,
    point.y,
    arriveAtSec,
    recallAtSec,
    marchId || '-',
  );
}

/**
 * 回到 IDLE（回城确认 / 召回超时 / 停用清场）。
 * @param {string} why 归因（日志用）
 */
export function reset(why) {
  if (phase !== PHASE_IDLE) log.debug('%s → IDLE (%s)', phase, why);
  phase = PHASE_IDLE;
  marchId = '';
  point = null;
  roundMatureSec = 0;
  arriveAtSec = 0;
  recallAtSec = 0;
  recallSentAtMs = 0;
  probeAtMs = 0;
  recallFails = 0;
  recallNextAtMs = 0;
}

/**
 * 召回失败归一：退避 + 计数，达 `RECALL_FAIL_MAX` 即放弃本轮（回 IDLE）。
 * 「没发出去」与「被服务器拒绝」都走这里 —— 两者重试都可能是无界的：id 失效、行军已自然到期、
 *   跨场景被校验，都会稳定命中同一条拒绝路径。上层 cycle 走 3s 档，不设退避与上限就是每 3s 一发废券。
 * @param {object} g `advance` 入参
 * @param {string} detail 归因文本（日志用）
 * @param {boolean} rejected true=服务器拒绝（可预期业务拒绝，info），false=没发出去（warn）
 * @returns {string} 供上层映射 delay 档的结果串
 */
function noteRecallFail(g, detail, rejected) {
  recallFails++;
  recallNextAtMs = (Number(g && g.nowMs) || Date.now()) + RECALL_FAIL_BACKOFF_MS;
  if (recallFails < RECALL_FAIL_MAX) {
    var lvl = rejected ? log.info : log.warn;
    lvl(
      '%d recall failed %d/%d (%s), retry after %ds. id=%s',
      CMD_RECALL,
      recallFails,
      RECALL_FAIL_MAX,
      detail,
      RECALL_FAIL_BACKOFF_MS / 1000,
      marchId,
    );
    return 'recall-failed';
  }
  log.warn(
    '%d recall failed %d times (%s) - abandon this round, id=%s point=(%d,%d).',
    CMD_RECALL,
    recallFails,
    detail,
    marchId,
    point ? point.x : 0,
    point ? point.y : 0,
  );
  reset('recall failed ' + recallFails + ' times (' + detail + ')');
  return 'recall-abandoned';
}

/**
 * 行军推送入口（10007 / 10019 均由 index.js 先 `march.decode` 再转交）。
 * 本模块只认**已归一化的 March**（`type/state/target.x/marchArrive`）：`decode` 的入参是报文形态
 *   （`marchType`、`target.tx`），把已 decode 的对象再喂一次会把坐标解成 0；反过来把 10007 的 raw
 *   当已 decode 的 March 则 `type/state` 全 undefined，认领与回城判定都会静默失效。
 * 认领规则：`marchType===315` 且目标坐标等于本轮点；`state===4 (ARRIVED_HOME)` 才认定回城收尾，
 *   其余状态只用来补 `marchId` 与更准的 `marchArrive`（计划书原文「只认 state===4，其余状态也推」）。
 * @param {object|null} m `march.decode` 产出的 March
 * @returns {boolean} true = 本轮已收尾（调用方应 kick 下一轮）
 */
export function onMarch(m) {
  if (!m || Number(m.type) !== MARCH_TYPE_GATHER) return false;
  var t = m.target || {};
  if (phase !== PHASE_IDLE && (!point || t.x !== point.x || t.y !== point.y)) return false;
  if (m.id && !marchId) marchId = String(m.id);
  if (m.state === march.State.ARRIVED_HOME) {
    if (phase === PHASE_IDLE) return false;
    reset('march home (state=4) id=' + (m.id || '-'));
    return true;
  }
  // 去程/在采都可能带 `marchArrive`：拿到就升级 arrive（越准，召回点越贴安全期末）
  if (Number(m.marchArrive) > 0 && m.marchArrive !== arriveAtSec && phase === PHASE_GATHERING) {
    arriveAtSec = Number(m.marchArrive);
    var next = computeRecallAt(arriveAtSec, readMature());
    if (next) recallAtSec = next;
  }
  return false;
}

/** @type {number|null} conf 现读的安全期秒（由 index.js 每拍注入，避免本模块直接摸 ACL） */
var matureCache = null;

/**
 * 注入成熟秒（`conf(52000367)` 现读值）。本模块不 import ACL 读数，保持「判据入参显式化」的边界。
 * 只在 `roundMatureSec` 未定格时兜底（重启/跨场景后状态机被直接置为在途的异常路径）。
 * @param {number|null} v
 */
export function setMatureSec(v) {
  matureCache = typeof v === 'number' ? v : null;
}

/** @returns {number|null} 本轮窗长：定格过就用定面值，否则回落到 conf 现读值 */
function readMature() {
  return roundMatureSec || matureCache;
}

/**
 * 以派兵点为窗心发一发 901 `marchInfo` 探针，认领本人那条 315 行军（补 marchId / 精确 arrive）。
 * 节流 `gapMs`；同刻只允许一发在途。
 * @param {object} net 已安装 net
 * @param {{me:string, homeX:number|null, homeY:number|null, gapMs:number, nowMs:number}} g
 * @returns {Promise<boolean>} true = 认领成功
 */
export async function resolveMarchId(net, g) {
  if (phase !== PHASE_GATHERING || !point || probeInFlight) return false;
  var now = Number(g.nowMs) || Date.now();
  var gap = Number(g.gapMs) > 0 ? Number(g.gapMs) : 60 * 1000;
  // 已有 marchId 时只为「校准 arrive」而偶尔重探，降一档频率
  if (marchId) gap *= 4;
  if (now - probeAtMs < gap) return false;
  probeAtMs = now;
  probeInFlight = true;
  var r = await fetchWindow(net, point.x, point.y, {
    k: point.k,
    width: MARCH_PROBE_WH,
    height: MARCH_PROBE_WH,
    viewLevel: MARCH_PROBE_VIEW_LEVEL,
    marchInfo: true,
  });
  probeInFlight = false;
  if (!r.ok) {
    log.debug('march probe window failed. code=%s', r.code);
    return false;
  }
  var picked = pickGatherMarch(r.marches, {
    x: point.x,
    y: point.y,
    me: g.me,
    homeX: g.homeX,
    homeY: g.homeY,
  });
  if (!picked) {
    log.debug('march probe found no own %d march at (%d,%d).', MARCH_TYPE_GATHER, point.x, point.y);
    return false;
  }
  marchId = picked.id;
  if (picked.arrive > 0) {
    arriveAtSec = picked.arrive;
    var next = computeRecallAt(arriveAtSec, readMature());
    if (next) recallAtSec = next;
  }
  log.debug('march resolved. id=%s arrive=%d', marchId, arriveAtSec);
  return true;
}

/**
 * 纯函数：从 901 `marchList` 里挑出本轮那条本人采集行军。
 * 判据（从严到宽，逐条短路）：`marchType===315` → 目标坐标 == 派兵点 → 本人（三条同序证据任一成立）：
 *   `uid` 等于 `g.me` / `begin` 坐标等于本人基地 / 本轮已有 marchId 且相同。
 * `m.id` 一律按字符串取（19 位 Int64 走 Number 会丢精度，ACL 坑 9）。
 * @param {Array<object>} list 901 `marchList`（池化报文条目）
 * @param {{x:number,y:number,me:string,homeX:number|null,homeY:number|null}} g
 * @returns {{id:string, arrive:number, state:number}|null}
 */
export function pickGatherMarch(list, g) {
  for (var i = 0; i < (list || []).length; i++) {
    var m = march.decode(list[i]);
    if (!m || Number(m.type) !== MARCH_TYPE_GATHER) continue;
    if (!m.id) continue;
    if (m.target.x !== g.x || m.target.y !== g.y) continue;
    var raw = m.raw || {};
    var uid = bits.int64Str(raw.uid != null ? raw.uid : raw.realUid);
    var bg = raw.begin || {};
    var bx = Number(bg.bx != null ? bg.bx : raw.begin_x) || 0;
    var by = Number(bg.by != null ? bg.by : raw.begin_y) || 0;
    var homeHit =
      g.homeX != null && g.homeY != null && bx === Number(g.homeX) && by === Number(g.homeY);
    if (!(uid && uid === g.me) && !homeHit) continue;
    return { id: String(m.id), arrive: Number(m.marchArrive) || 0, state: m.state };
  }
  return null;
}

/**
 * 每拍推进状态机（由 index.js 的 gatherTick 调用；召回出网在本模块内完成，因为时刻判定与出网必须同帧）。
 * @param {object} net 已安装 net
 * @param {{alive:Function, nowSec:number, nowMs:number}} g
 * @returns {Promise<'idle'|'gathering'|'recalling'|'recalled'|'recall-failed'|'recall-abandoned'>} 本拍处置结果，供上层选 delay 档
 */
export async function advance(net, g) {
  if (phase === PHASE_IDLE) return 'idle';
  if (phase === PHASE_RECALLING) {
    if (g.nowMs - recallSentAtMs >= RECALL_TIMEOUT_SEC * 1000) {
      // 兜底：推送丢了/换了场景没订上 ⇒ 当已回城，回 IDLE 由额度闸重新收敛（绝不允许永久停在 RECALLING）
      reset('recall ack timeout (' + RECALL_TIMEOUT_SEC + 's)');
      return 'idle';
    }
    return 'recalling';
  }
  if (!recallAtSec) {
    log.debug(
      'recall time undecidable (conf 52000367 unreadable?), stay GATHERING without a plan.',
    );
    return 'gathering';
  }
  if (g.nowSec < recallAtSec) return 'gathering';
  // 退避期内不出网，也不重发探针（否则 3s 档会把「注定失败的一发」和它的探针一起放大）
  if (recallNextAtMs && g.nowMs < recallNextAtMs) return 'gathering';
  if (!marchId && net) {
    await resolveMarchId(net, Object.assign({}, g.probe, { nowMs: g.nowMs }));
  }
  if (!g.alive()) return 'gathering';
  if (!marchId) {
    log.debug(
      'mature window reached but marchId unknown, retry next pass. point=(%d,%d)',
      point.x,
      point.y,
    );
    return 'gathering';
  }
  var res = await doRecall(net, marchId);
  if (!g.alive()) return 'gathering';
  if (!res.sent) return noteRecallFail(g, 'reason=' + res.reason, false);
  if (!res.ok) return noteRecallFail(g, 'code=' + res.code + ' reason=' + res.reason, true);
  phase = PHASE_RECALLING;
  recallSentAtMs = g.nowMs;
  recallFails = 0;
  recallNextAtMs = 0;
  log.info(
    '%d recalled at mature margin. point=(%d,%d) id=%s',
    CMD_RECALL,
    point.x,
    point.y,
    marchId,
  );
  return 'recalled';
}
