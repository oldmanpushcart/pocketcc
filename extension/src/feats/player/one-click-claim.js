/**
 * 一键领取（TaskRelax 集中领取，reactor 说明书形态，玩家基础设置，单链）
 *
 * 玩法：把若干「随时间累积、可集中领取」的收益（岛屿作战 / 远征行动 / 重装母舰 / 金币收割机）
 *   一键领回。它不是所有玩家都有——游戏侧有三级开启闸（复刻于 game-api 的 taskRelaxOpenRows），
 *   任一不满足则该功能对该玩家根本不存在（主城助手面板不显示 bot 入口）。本 feat 先判开启闸，
 *   关则整功能挂起（只巡检，不发包）。
 *
 * 游戏规则（用户提供，指导调度节奏）：
 *   1. 每次领取后有 30 秒领取间隔（服务器以 limitTimeSec 下发，是反连点冷却、非收益就绪时刻）；
 *   2. 领取后不必急着再领——收益恢复很慢，按 30s 空转会大部分领到 code≠0 的空行；
 *   3. 每日 0 点必定刷新。
 *   据此原采用「纯日锚」调度（领一次即睡到下一个 0 点）。**该前提被报文推翻**：收益是 0 点之后仍全天
 *   线性累积的（dashcam 20261011T172802 那轮 17:28 仍领到 expedition_coin=364），纯日锚会把 0 点后整天的
 *   新增漏到第二天，用户侧表现为「游戏里明明还能领，脚本一整天不动」。现调度定为
 *   **「日锚 + 日内 CLAIM_GAP_MS 兜底」取先到者**：0 点那次必领，日内每 2h 复领一批（全天约 12 拍）。
 *
 * 协议（报文实证 dashcam 20261011T172802-一键领取.ndjson；源码锚点 extracted/subpack 的
 *   TaskRelaxTool / OpenBuildingBotNode / OpenBuildingBotDetailPop）：
 *   5684 TASK_RELAX_ONE_CLICK_GET_INFO，sendPBV2，载荷 {}：
 *     应答 data = {detail:[{id,param,code?}…], limitTimeSec}。limitTimeSec 是**绝对服务器秒**=下次可领时刻
 *     （0 或已过=现在可领；> 现在=冷却中，游戏按钮同步显示倒计时）。实证它只是「领取后 +30s」的反连点冷却
 *     （报文：领于 …887，随后 INFO limitTimeSec=…917，恰 +30s），**不含收益就绪时刻**，故日锚另按 0 点择时。
 *   5685 TASK_RELAX_ONE_CLICK_GET_REWARD，sendPBV2，载荷 {id:[可用行 id 列表]}：
 *     应答 data = {detail:[{id,code,param,rewardResult}…]}。逐行 code=0 为领到（带 rewardResult），
 *     非 0 为该行此刻无累积收益（可预期业务态，非异常）。游戏「开始领取」即整表一次性发全部可用行 id。
 *     INFO 的 param **不是** ready 位（同一份报文实证反例：param 为空的 id=2 反倒领到 364 远征币，
 *     param 为 ["0"] 的 id=1/id=3 均返回 code=4），故不可据它猜单行就绪；探「有没有收益」的唯一手段就是
 *     发 5685 本身——无收益行只返回 code≠0，不消耗任何额度，这也是日内可以放心加复领档的成本依据。
 *
 * 领取判据（游戏 OpenBuildingBotNode 同口径）：detail 不含 ready 位，是否可领只看
 *   `!limitTimeSec || ServerTime >= limitTimeSec`（不在冷却即允许点）。所以本功能不猜单行 ready，
 *   到冷却点即整批领取，由服务器逐行裁决；无收益的行返回 code≠0 属正常，不拉黑、不告警。
 *
 * 直发不回写无影响：5685 成功游戏侧仅在 UI 回调里回写 AdventureData/Mecha 塔等本地态，本 feat 直发
 *   不经其回调——但「可否再领」始终以服务器 INFO 的 limitTimeSec 为权威（每轮重读），不依赖任何本地镜像，
 *   故无需自维护 shadow；领后服务器设冷却，下轮 INFO 读到即精确休眠，天然收敛不重发。
 *
 * 调度（A 族 createCycle，日锚 + 日内兜底，全本地可重放读）：
 *   - 开启闸关：IDLE 巡检（rarely 翻 true，玩家升级/放量后自愈）；
 *   - 冷却中（规则 1，仅当玩家刚手动领过 <30s 才会命中）：睡到 limitTimeSec + 缓冲（封顶 WAIT_CAP，零发包）；
 *   - 到点可领：整批 5685 领取 → 睡到「下一个服务器 0 点 + 缓冲」与 CLAIM_GAP_MS 的**较早者**
 *     （2h 整除 24h，故兜底档自然滚到日锚；临近 0 点时 dailyDelay 更短，0 点那次仍必领），不再纯日锚空转；
 *   - 有无收益都走同一择时（收益按小时累积，未到点重领只是返回 code≠0，无副作用）；
 *   - INFO/REWARD 瞬态未发出（CODE_NOT_SENT：在途频控/发送超时）：短重试（TRANSIENT_RETRY_MS），不拖长退避；
 *     仅服务器真拒绝（s≠0）才计入 streak，连续 3 次降巡检档 ×2。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 5684/5685，不调任何游戏 Update/回写、不 OpenUI。
 *   日常任务形态：面板只出启用开关，无字段无配置（fields=[]，toModuleCfg 返回空）。
 *   不行军不参战，offInCombat:false。生命周期由 reactor 托管，pause 后 alive()=false 自然停摆。
 */
import { CODE_NOT_SENT, rejectText } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { gameData } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ONE-CLICK） */
const log = createLog('ONE-CLICK');

/** @type {number} NRequestIdV2.TASK_RELAX_ONE_CLICK_GET_INFO，查询集中领取态（sendPBV2） */
const CMD_INFO = 5684;

/** @type {number} NRequestIdV2.TASK_RELAX_ONE_CLICK_GET_REWARD，一键领取全部可用行（sendPBV2） */
const CMD_REWARD = 5685;

/** @type {number} 到冷却点唤醒的抖动余量（毫秒），避开服务器结算时序 */
const READY_BUFFER_MS = 1000 * 5;

/** @type {number} 数据未就绪/开启闸关/被拒后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 冷却单睡上界（毫秒）：超长切成多拍，纯本地读零发包，防超长定时器漂移 */
const WAIT_CAP_MS = IDLE_TICK_MS * 8;

/** @type {number} 睡过服务器 0 点日界后的抖动余量（毫秒）：让当日收益完成刷新结算再领（规则 3） */
const DAILY_ANCHOR_BUFFER_MS = 1000 * 60;

/** @type {number} 日内兜底复领间隔（毫秒）：收益 0 点后仍按小时累积，纯日锚会把当天新增漏掉，
 *   而 5685 无收益行只返回 code≠0、不消耗额度，故取「日锚」与这个间隔的先到者（全天约 12 拍） */
const CLAIM_GAP_MS = 1000 * 60 * 120;

/** @type {number} 瞬态未发出（CODE_NOT_SENT：在途频控/发送超时）的短重试（毫秒）：与服务器真拒绝区分，不把已到点的领取拖进 15min 退避 */
const TRANSIENT_RETRY_MS = 1000 * 20;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {number} 连续被服务器拒绝（REWARD s≠0）次数，达 3 次退巡检档；成功即清零 */
var rejectStreak = 0;

/** @type {number} 连续 INFO 失败次数，达 3 次退巡检档；成功即清零 */
var infoStreak = 0;

/** @type {boolean} 「功能未对该玩家开启」是否已打过一条 info（防逐拍刷屏，可用后复位） */
var loggedUnavailable = false;

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 直发 5684 查询领取态。PBV2 应答已由 net 剥到 pbAckV2.data；永不 reject。
 * @returns {Promise<{ok:boolean, code:number, limitTs:number, data?:*, reason?:string}>} limitTs=下次可领的绝对服务器秒（0=现在可领）；失败带原始应答载荷
 */
async function fetchInfo() {
  if (!net) return { ok: false, code: CODE_NOT_SENT, limitTs: 0 };
  var ret = await net.sendGuarded(
    CMD_INFO,
    {},
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        log.warn('cmd 5684 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) return { ok: false, code: ret ? ret.code : CODE_NOT_SENT, limitTs: 0, data: ret && ret.data, reason: ret && ret.reason };
  var d = ret.data || {};
  return { ok: true, code: 0, limitTs: Number(d.limitTimeSec) || 0 };
}

/**
 * 直发 5685 一键领取给定行。PBV2 应答 detail 逐行带 code（0=领到）。永不 reject。
 * @param {number[]} ids 可用行 id 列表（来自 gameData.taskRelaxOpenRows）
 * @returns {Promise<{ok:boolean, code:number, success:number, total:number, data?:*, reason?:string}>} 失败时带上原始应答载荷（错误文案）
 */
async function claimAll(ids) {
  if (!net) {
    return { ok: false, code: CODE_NOT_SENT, success: 0, total: 0 };
  }
  var ret = await net.sendGuarded(
    CMD_REWARD,
    { id: ids },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        log.warn('cmd 5685 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) {
    return { ok: false, code: ret ? ret.code : CODE_NOT_SENT, success: 0, total: 0, data: ret && ret.data, reason: ret && ret.reason };
  }
  var detail = ret.data && Array.isArray(ret.data.detail) ? ret.data.detail : [];
  var success = 0;
  for (var i = 0; i < detail.length; i++) {
    if (Number(detail[i].code) === 0) success++;
  }
  return { ok: true, code: 0, success: success, total: detail.length };
}

// ── 择时 ──────────────────────────────────────────────────────────────
/**
 * 冷却休眠：睡到 limitTs（绝对服务器秒）+ 缓冲，夹到 [1s, WAIT_CAP]。
 * @param {number} limitTs 下次可领的绝对服务器秒
 * @returns {number} 毫秒
 */
function cooldownDelay(limitTs) {
  var leftMs = (limitTs - gameData.serverTime()) * 1000 + READY_BUFFER_MS;
  return Math.min(Math.max(leftMs, 1000), WAIT_CAP_MS);
}

/**
 * 日锚休眠候选（规则 3）：睡到下一个「游戏日 0 点」+ 缓冲。服务器不暴露单行收益就绪时刻（limitTimeSec 只是 30s
 * 领取间隔），故日界只能本地择时；跨天单次 sleep 由 cycle.js 的 24h 硬顶夹住，每轮重读 INFO 自然收敛。
 * @returns {number} 毫秒（日界不可得时退 IDLE_TICK_MS）
 */
function dailyDelay() {
  var nextReset = gameData.nextDailyResetTs();
  if (!nextReset) return IDLE_TICK_MS;
  var leftMs = (nextReset - gameData.serverTime()) * 1000 + DAILY_ANCHOR_BUFFER_MS;
  return Math.max(leftMs, READY_BUFFER_MS);
}

/**
 * 领取后的下次唤醒：日锚与日内兜底档取先到者。0 点那次仍必领（临近日界时 dailyDelay 更短），
 *   日间则每 CLAIM_GAP_MS 复领一批，不再把 0 点后的累积整天空转掉。
 * @returns {number} 毫秒
 */
function nextClaimDelay() {
  return Math.min(dailyDelay(), CLAIM_GAP_MS);
}

// ── 主流程 ────────────────────────────────────────────────────────────
/** cycle 单轮：开启闸 → INFO 冷却 → 到点整批领取 → 择时。next-check 日志由 cycle 驱动器统一输出。 */
async function cycleRun() {
  var rows = gameData.taskRelaxOpenRows();
  if (!rows || !rows.length) {
    if (!loggedUnavailable) {
      log.debug(
        'one-click-claim not enabled for this player (master switch / server gray / gameplay gate), idle pending re-scan.',
      );
      loggedUnavailable = true;
    }
    return IDLE_TICK_MS;
  }
  loggedUnavailable = false;

  var st = await fetchInfo();
  if (!aliveFn()) return 0;
  if (!st.ok) {
    // 瞬态未发出（在途频控/发送超时）：短重试，不拖进 15min 退避，避免已到点的领取被延迟
    if (st.code === CODE_NOT_SENT) {
      log.debug('info transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    infoStreak++;
    log.info('info rejected by server (streak #%d). code=%s;data=%s', infoStreak, st.code, rejectText(st) || '-');
    return infoStreak >= 3 ? IDLE_TICK_MS * 2 : IDLE_TICK_MS;
  }
  infoStreak = 0;

  // 冷却中：睡到点（零发包，全本地可重放）
  if (st.limitTs && gameData.serverTime() < st.limitTs) {
    return cooldownDelay(st.limitTs);
  }

  // 到点：整批领取（ids 用当前可用行，与游戏面板可见集合一致）
  var ids = rows.map(function (r) {
    return Number(r.id);
  });
  var res = await claimAll(ids);
  if (!aliveFn()) return 0;
  if (!res.ok) {
    // 瞬态未发出：短重试；仅服务器真拒绝（s≠0）才计入 streak 退避
    if (res.code === CODE_NOT_SENT) {
      log.debug('claim transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    rejectStreak++;
    log.info('claim rejected by server (streak #%d). code=%s;data=%s', rejectStreak, res.code, rejectText(res) || '-');
    return rejectStreak >= 3 ? IDLE_TICK_MS * 2 : IDLE_TICK_MS;
  }
  rejectStreak = 0;
  // 规则 2+3 修正：收益 0 点后仍按小时累积 → 领后睡到「下一个 0 点」与 CLAIM_GAP_MS 的较早者，不再纯日锚空转
  var wakeMs = nextClaimDelay();
  if (res.success > 0) {
    log.info(
      'one-click-claim done: %d/%d rows rewarded, re-claim in %d min (the midnight one is always claimed).',
      res.success,
      res.total,
      Math.round(wakeMs / 60000),
    );
  } else {
    log.debug(
      'one-click-claim triggered: no claimable reward in %d rows, re-claim in %d min.',
      res.total,
      Math.round(wakeMs / 60000),
    );
  }
  return wakeMs;
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  net = ctx.net;
  if (!net || !net.install()) {
    log.warn('install failed: pocketcc.net unavailable');
    net = null;
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * 运行：复位在飞态 → 立即判一拍。无 push 订阅（可否领取靠服务器 INFO 权威态，无到点推送）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  infoStreak = 0;
  loggedUnavailable = false;
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：地图限定基地/大世界（base/world），常态本服（homeland）；
 * 不行军不参战故不设战斗门控；日常任务形态——面板只出启用开关，无字段无配置。
 * mechaTower 为软依赖（重装母舰子玩法闸，subpack2 未接管时该子玩法按未开降级，不阻断安装）。
 */
reactor.register({
  id: 'oneClickClaim',
  label: '一键领取',
  storageKey: 'pocketcc.feat.oneClickClaim',
  symbols: ['dataCenter', 'tableManager', 'tableUtils', 'gameDefine', 'mechaTower?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
