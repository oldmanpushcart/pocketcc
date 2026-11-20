/**
 * 每日补给（DailyGift 免费计时奖励，reactor 说明书形态，日常任务，单链）
 *
 * 玩法：随时间累积一份免费奖励（gold/资源），到点即可领，领完进入下一档间隔；档位序列与间隔
 *   由 online_reward 配置表驱动（第 times+1 行），行数跑完即当日封顶，等日切重置。
 *   本功能只做免费线：付费礼包（payByExchangeId，真钱充值）不碰。
 *
 * 协议（抓包实证）：
 *   825 RequestId.GetTimeReward，V1 send（非 PB），载荷 {}（商店格 SupplyGiftCell 同款，DailyGift 面板的
 *   isAll=1 与「付费礼包全买光」联动、语义不明，不采用）→ 应答 d（JSON 串）=
 *   {reward:{resource:{gold…}…}, timeReward:{rewardTime,times}}，伴随 push 10001/10031 到账（本功能不订阅）。
 *
 * 可领判据（游戏源码 DailyGift/SupplyGiftCell/金融中心红点同构，纯本地钟算、无到点推送）：
 *   UserData.timeReward={times,rewardTime}；online_reward[times+1].time - (ServerTime - rewardTime) < 0 即可领；
 *   查不到 times+1 行 = 当日封顶。注意第 1 行 time=0（日切后首档立即可领，游戏 setTimeRewardState 同口径）：
 *   「行存在但 time=0」是 ready 不是 capped——旧实现把两者混判，导致 0 点后首见 times=0 即误判封顶睡整天
 *   （实证 dashcam-log 20261112~14 连续三天「capped at #0」）。真机实证（探针 2026-10-07）：表共 36 行，
 *   前段间隔逐档拉长（…55/70/85/100/120min），第 19 行起回到 10/15/30/45/60/120min 循环——最长睡 2h 属正常，
 *   领取后的静默期靠 ETA 日志自证，不靠频繁心跳。
 *
 * 直发不回写 → 本地回执镜像：脚本发 825 不经游戏回调，UserData.timeReward 不会更新（游戏只在自己 UI
 *   领取回调里 updateTimeReward），下一拍会误判仍 ready → 逐拍重发（对齐战争之源 claimedIds 教训）。
 *   对策：领成功把应答 timeReward 记入内存镜像；判定时取 rewardTime 较新者，游戏侧日切/登录全量下发
 *   （rewardTime 追平或更新）后镜像自动让位并被清掉。reload 后即便镜像丢失也多付一次被拒请求，
 *   由 rejectStreak 退避兜住。镜像按游戏日键控（mirror.day）：昨日 23:45 的 rewardTime 比今日 0 点
 *   重置的更新，光靠「较新者」会压制新日权威态，跨日即失效（实证 dashcam-log 20261119 罢工窗）。
 *
 * 调度（A 族 createCycle，单一收敛态 + 全本地可重放读）：
 *   - wait 档：睡到点 + 缓冲（封顶 IDLE×8，到点前零发包，重读无损）；
 *   - 睡越本地日界的 wait/capped 一律截断到「日界 + DAY_ROLL_BUFFER_MS」再醒（实证 dashcam-log 20261119：
 *     昨夜 23:45 领 #35 后排 01:45 醒，用户 0 点后手动领 3 次全落睡眠窗——0 点重置是确定性状态变化，
 *     排程必须优先于表间隔于日界处重判；日界拍若 LOGIN 全量迟到而权威仍昨日旧态，发一拍由服务器裁决，
 *     领到即今日首档，被拒走 rejectStreak 退避）；
 *   - capped 档：睡到本地日界 + 缓冲（封顶 26h），不逐轮空查；例外：日界后 1h 宽限窗内仍判 capped
 *     降为 IDLE 巡检——防御保险：若日切重置回写滞后（直发不回写）或 times 实为滚动队列，
 *     一次性 24h 长睡会整天跳过；注：36 档累计间隔≈>24h，正常跑不到封顶，此分支平时无感。
 *   - 数据未就绪（timeReward null / 表未加载）：IDLE 档巡检；
 *   - 连续被拒 3 次：退 IDLE×2。
 *   - 唤醒补充：订阅 push LOGIN（cmd=1，UserData 全量重同步）——日切重置态 {times:0} 经它回写，
 *     到即 kick 重判（实证 dashcam 20261112T235237：0 点重置可迟到 50min，纯本地钟会干等）。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 825，不调 updateTimeReward 回写本地态、不 OpenUI。
 *   日常任务形态：面板出启用开关 + 一行只读当日进度（inlineStatus）。
 *   当日次数口径（定稿）：额度类读服务器权威——分子=effectiveState().times（含手动领取）。
 *   无分母：表 36 行累计间隔>24h，行数不是真实每日上限（用户否决 36 口径），一律显示「今日 N 次」。
 *   不行军不参战，offInCombat:false。生命周期由 reactor 托管，pause 后 alive()=false 自然停摆。
 */
import { CODE_NOT_SENT, rejectText, safeParse, todayStr } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { l10n, gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { dailyText } from '../../../core/daily-stats.js';

import { CMD_GET_TIME_REWARD, PUSH_LOGIN } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=DAILY-SUPPLY） */
const log = createLog('DAILY-SUPPLY');

/** @type {string} TableName.ONLINE_REWARD（="online_reward"），档位间隔配置表 */
const TABLE_ONLINE_REWARD = 'ONLINE_REWARD';

/** @type {number} 到点唤醒的抖动余量（毫秒），避开服务器结算时序 */
const READY_BUFFER_MS = 1000 * 10;

/** @type {number} 数据未就绪/被拒后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} wait 档单睡上界（毫秒）：超长间隔切成多拍，纯本地读零发包，防超长定时器漂移 */
const WAIT_CAP_MS = IDLE_TICK_MS * 8;

/** @type {number} 日切唤醒缓冲（毫秒），对齐矿洞/战争之源的日界留白口径 */
const DAY_ROLL_BUFFER_MS = 1000 * 60 * 5;

/** @type {number} 日界后宽限窗（毫秒）：窗内 capped 判据不可信（重置回写常晚于本端醒来），降为 IDLE 巡检 */
const DAY_ROLL_GRACE_MS = 1000 * 60 * 60;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {number} 连续被服务器拒绝次数，达 3 次后退巡检档；领取成功即清零 */
var rejectStreak = 0;

/** @type {{times:number, rewardTime:number, day:string}|null} 领取回执镜像（内存态，直发不回写的补偿；day=写入时的游戏日，跨日作废） */
var mirror = null;

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 状态判定 ──────────────────────────────────────────────────────────
/**
 * 合并权威值与回执镜像：取 rewardTime 较新者；权威值追平/反超后镜像让位并清掉（日切/重登全量下发即此情形）。
 * 跨日镜像一律作废：昨日尾档的 rewardTime 晚于今日 0 点重置值，「较新者」规则会压制新日权威态。
 * @returns {{times:number, rewardTime:number}|null} 两边都拿不到返回 null
 */
function effectiveState() {
  var u = gameData.timeReward();
  if (mirror && mirror.day !== todayStr(Math.floor(gameData.serverTime()))) mirror = null;
  if (!u) return mirror;
  if (mirror && mirror.rewardTime > u.rewardTime) return mirror;
  mirror = null;
  return u;
}

/**
 * 三态判定：ready 可领 / wait 未到点（waitMs 相对毫秒）/ capped 当日封顶 / idle 数据未就绪。
 * capped 只认「行缺失」；行存在而 time=0 是首档立即可领（游戏 setTimeRewardState 同口径），
 * 不得混判封顶（0 点停摆根因，见文件头）；表未加载归 idle 巡检，同样不得混判封顶。
 * @returns {{state:string, waitMs?:number, times?:number}}
 */
function readyInfo() {
  var t = effectiveState();
  if (!t) return { state: 'idle' };
  if (!l10n.tableReady()) return { state: 'idle' };
  var row = l10n.tableRow(TABLE_ONLINE_REWARD, t.times + 1);
  if (!row) return { state: 'capped', times: t.times };
  var intervalSec = Number(row.time) || 0;
  var leftSec = intervalSec - (gameData.serverTime() - t.rewardTime);
  if (leftSec <= 0) return { state: 'ready', times: t.times };
  return { state: 'wait', waitMs: leftSec * 1000, times: t.times };
}

/**
 * 睡到下一个本地日界 + 缓冲（capped 档）；封顶 26h 防时钟异常导致超睡。
 * 日界后 1h 宽限窗内不做长睡：此时仍判 capped 大概率是服务端重置尚未回写（旧 times 钉在 UserData），
 * 一次性 24h 睡会跳过整天；改 IDLE 巡检直到回写追平或窗过。
 * @returns {number} 毫秒
 */
function dayRollDelay() {
  var now = new Date();
  var dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (now.getTime() - dayStart < DAY_ROLL_GRACE_MS) return IDLE_TICK_MS;
  var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  var ms = next.getTime() - now.getTime() + DAY_ROLL_BUFFER_MS;
  return Math.min(Math.max(ms, IDLE_TICK_MS), 1000 * 60 * 60 * 26);
}

/**
 * 长睡截断到「下一个本地日界 + 缓冲」：日切重置是确定性状态变化（首档 time=0 立即可领），
 * 跨日的排程若不一一截断，睡眠窗内的手动领取与重置档位都要等到原 ETA 才重判（20261119 罢工窗根因）。
 * 仅对 > TRANSIENT 的长睡生效（ready 后下一拍、瞬态重试不打扰）；本拍已在日界窗内则不干预，防紧循环。
 * @param {number} ms delayFor 原择时（毫秒）
 * @returns {number} 毫秒
 */
function capAtDayRoll(ms) {
  if (ms <= IDLE_TICK_MS * 2) return ms;
  var now = new Date();
  var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  var rollMs = next.getTime() - now.getTime() + DAY_ROLL_BUFFER_MS;
  if (rollMs <= 0) return ms;
  return Math.min(ms, rollMs);
}

/**
 * 按三态出择时（ready 交调用方走发包分支）。
 * @param {object} info readyInfo() 结果
 * @returns {number} 毫秒
 */
function delayFor(info) {
  if (info.state === 'wait')
    return capAtDayRoll(Math.min(info.waitMs + READY_BUFFER_MS, WAIT_CAP_MS));
  if (info.state === 'capped') return capAtDayRoll(dayRollDelay());
  return rejectStreak >= 3 ? IDLE_TICK_MS * 2 : IDLE_TICK_MS;
}

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 直发一条 825 领取。V1 send 应答 Ret.data 是 JSON 串（Ret.from 不解析），自行 parse；永不 reject。
 * @param {number} times 领取前档位（仅日志用）
 * @returns {Promise<{claimed:boolean, code:number, data?:*, reason?:string}>} 失败时带上原始应答载荷（错误文案）
 */
async function claimOnce(times) {
  var ret = await net.sendGuarded(
    CMD_GET_TIME_REWARD,
    {},
    {
      onError: function (err) {
        log.warn('cmd 825 send threw: %s', err && err.message);
      },
    },
  );
  var code = ret ? ret.code : CODE_NOT_SENT;
  if (!ret || !ret.ok)
    return { claimed: false, code: code, data: ret && ret.data, reason: ret && ret.reason };
  var d;
  try {
    d = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data;
  } catch (e) {
    d = null;
  }
  // 镜像优先取应答回写的 timeReward；缺则按「now + times+1」兜底，保证下一拍不误判仍可领
  var tr = d && d.timeReward;
  var day = todayStr(Math.floor(gameData.serverTime()));
  if (tr && Number(tr.rewardTime) > 0) {
    mirror = { times: Number(tr.times) || times + 1, rewardTime: Number(tr.rewardTime), day: day };
  } else {
    mirror = { times: times + 1, rewardTime: gameData.serverTime(), day: day };
  }
  rejectStreak = 0;
  var gold = d && d.reward && d.reward.resource ? Number(d.reward.resource.gold) || 0 : 0;
  log.info('daily supply claimed (#%d), gold=%s.', mirror.times, gold);
  return { claimed: true, code: code };
}

// ── 主流程 ────────────────────────────────────────────────────────────
/** cycle 单轮：判态 → 非 ready 纯本地择时（零发包）→ ready 领一拍 → 按新态排下拍。next-check 日志由 cycle 驱动器统一输出。 */
async function cycleRun() {
  var info = readyInfo();
  if (info.state !== 'ready') {
    if (info.state === 'capped')
      log.info('daily supply capped at #%d; sleep to day roll.', info.times);
    return delayFor(info);
  }
  var res = await claimOnce(info.times);
  if (!aliveFn()) return 0;
  if (!res.claimed) {
    rejectStreak++;
    log.info(
      'claim rejected (streak #%d). code=%s;data=%s',
      rejectStreak,
      res.code,
      rejectText(res) || '-',
    );
  }
  // 领成功后按新态排下拍（间隔由表驱动逐档变长）；next-check 时刻交由驱动器统一打印
  return delayFor(readyInfo());
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * push LOGIN（UserData 全量重同步）：只认带 timeReward 的载荷——日切重置态 {times:0,rewardTime=日界}
 * 经它回写（可能迟到几十分钟），游戏侧已自行更新 UserData，这里只 kick 重判不读值。
 * @param {object} ev bus 事件（data 为 JSON 串或已解析对象）
 */
function onLoginPush(ev) {
  if (!aliveFn()) return;
  var d = safeParse(ev && ev.data) || {};
  if (d.timeReward == null) return;
  log.debug('push LOGIN carries timeReward, kick re-eval.');
  cycle.kick();
}

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
 * 运行：复位在飞态 → 订阅日切回写推送 → 立即判一拍。到点判据仍是本地钟算（游戏红点同款），
 * LOGIN 推送只做日切重置的唤醒补充，不承担到点通知。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  mirror = null;
  ctx.on.push(PUSH_LOGIN, onLoginPush);
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap）；不行军不参战故不设战斗门控；
 * 日常任务形态——面板出启用开关 + 一行只读当日进度（组卡片 inlineStatus 取第一个 type:'text' 的 get()）。
 */
reactor.register({
  id: 'dailySupply',
  label: '每日补给',
  storageKey: 'pocketcc.feat.dailySupply',
  symbols: ['dataCenter', 'tableManager'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_supplyInfo',
      type: 'text',
      label: '今日',
      get: function () {
        var t = effectiveState();
        if (!t) return '—';
        // 无分母：表行数不是日限（36 行累计间隔>24h，见文件头），只报权威次数
        return dailyText(t.times);
      },
    },
  ],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});

// 单测导出（仅供 tests/feats/daily-midnight.test.js 断言判据，运行期无消费方）
export { readyInfo, claimOnce, delayFor, install as installForTest };
/** 单测专用：复位在飞态（等价 run() 的复位段，不 kick 循环） */
export function resetForTest() {
  rejectStreak = 0;
  mirror = null;
}
