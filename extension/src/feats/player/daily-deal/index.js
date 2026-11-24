/**
 * 每日特惠（Hero Daily Deal 免费奖励，reactor 说明书形态，玩家基础设置，单链）
 *
 * 玩法：商店「每日特惠」页签每天附赠一份免费奖励（道具/资源），每日 0 点刷新、限购 1 次。
 *   本功能只做免费线：付费档位礼包（真钱 exchange 购买 / 9883 选英雄礼包）不碰。
 *
 * 协议（抓包实证；源码锚点游戏侧
 *   HeroDailyDealGiftShopNode.onClickReward）：
 *   9884 HERO_DAILY_EXCHANGE_GET_FREE_REWARD，sendPBV2，载荷 {}（游戏领取按钮同款空载荷）→
 *   应答 pbAckV2.data = {reward:{resource:{…}, items:[{itemId,itemCount}…], …}}，header.s=0 为领到；
 *   领取成功伴随 push 10031 PUSH_REWARD 到账 + push 10053 PUSH_USER_DATA_COMMON
 *   {choose_hero_daily_reward:"1"}（游戏 UserData 据此把 heroDailyDealGiftIsReceived 回写为 1）。
 *
 * 可领判据（游戏 HeroDailyDealGiftShopNode.refreshFreeRewardItem 同口径）：
 *   UserData.heroDailyDealGiftIsReceived === 0 即可领（0=未领、1=已领、-1=构造默认/数据未同步/玩法未开）。
 *   本端直发 9884 不经游戏领取回调，但状态回写走服务器 push 10053（与谁发包无关），故本地字段会随领取自然翻 1；
 *   服务器 0 点不推重置 0（全量录制实证：只有领取后推 1 + 登录/LOGIN 全量，重置同步可迟到几十分钟），
 *   故日界后字段=1 可能是昨日 stale，不得当闸门（旧实现把 stale 1 当「今日已领」睡整天，0 点漏领根因）。
 *   字段只在能证明回写新鲜（今日观察到 push 翻 1）时用来省一次发包；真正的当日不重发靠本地日戳
 *   resolvedResetTs（对齐每日补给 mirror / 战争之源 claimedIds 教训），日戳过点即随日切自动解禁。
 *   日戳落盘 storage.data（'dailyDeal.resolved'，UID 命名空间）：刷新后首拍先回读，同日已解决零发包——
 *   修「每次刷新弹『奖励已领取』」事故（dashcam-log 20261114 实证：内存日戳刷新清零 + LOGIN 回写早于订阅，
 *   首拍把今日已领的 1 当昨日 stale 探测 9884 被拒弹 toast）；跨日戳过期仍保留每天至多一次探测。
 *
 * 调度（A 族 createCycle，日锚单次尝试 + 全本地可重放读）：
 *   - 首拍先 await 落盘日戳回读（run() 发起），同日已解决直接睡，不抢跑探测包；
 *   - 日戳未过（resolvedResetTs > ServerTime）：今日已解决（领到 / 被服务器判不可领），睡到该日界 + 缓冲，零发包；
 *   - 新的一天（日戳已过期 / 首次运行）：
 *       · 权威字段=1 且今日观察到 push 翻 1（回写新鲜）：落日戳零发包，省一次请求；
 *       · 否则（含字段=1 但无今日新鲜凭证——可能是昨日 stale）发一拍 9884 领取，由服务器裁决——
 *           - 成功：记当日收益、置 resolvedResetTs=下一日界；
 *           - 服务器真拒绝（s≠0，含「今日已被手动领走/未达条件」）：记 info、同样置 resolvedResetTs 抑制到次日
 *             （免费奖励领取被拒无副作用，每天至多试一次即可，不反复敲门）；
 *           - 瞬态未发出（CODE_NOT_SENT：在途频控/发送超时）：短重试，不落日戳。
 *   - 被拒只累计 streak 供观测，择时始终以「睡到次日日界」为上限，不做 ×2 长睡（否则跨过一个日界白丢一天）。
 *   - 唤醒补充：订阅 push 10053/LOGIN 的 choose_hero_daily_reward 回写——记新鲜度凭证并 kick 重判，
 *     日切重置（迟到同步）一到即解禁，不再干等本地钟。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 9884，不调任何游戏 Update/回写、不 OpenUI。
 *   日常任务形态：面板出启用开关 + 一行只读当日进度（inlineStatus）。
 *   当日次数口径（定稿）：额度类读权威——每日 1 次，分子认「今日新鲜回写 1 / 本会话领成 / 今日日戳未过期且字段=1」，
 *   字段=1 既无新鲜凭证也无未过期日戳（可能昨日 stale）时显示 '—' 不谎报；文案「已完成 x/1」。
 *   不行军不参战，offInCombat:false。生命周期由 reactor 托管，pause 后 alive()=false 自然停摆。
 */
import { CODE_NOT_SENT, safeParse } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { dailyText } from '../../../core/daily-stats.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';

import { CMD_GET_FREE_REWARD, PUSH_USER_DATA_COMMON, PUSH_LOGIN } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=DAILY-DEAL） */
const log = createLog('DAILY-DEAL');

/** @type {number} 数据未就绪/玩法未开时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 睡过服务器 0 点日界后的抖动余量（毫秒），让当日额度完成刷新结算再领 */
const DAILY_ANCHOR_BUFFER_MS = 1000 * 60;

/** @type {number} 瞬态未发出（CODE_NOT_SENT：在途频控/发送超时）的短重试（毫秒），不拖进巡检退避 */
const TRANSIENT_RETRY_MS = 1000 * 20;

/** @type {string} 「今日已解决」日戳落盘键（storage.data blob，UID 命名空间隔离；刷新后同日零发包） */
const STAMP_KEY = 'dailyDeal.resolved';

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {number} 连续被服务器拒绝次数（跨日累计，仅供观测；成功即清零） */
var rejectStreak = 0;

/** @type {number} 今日已解决（领到/被拒）对应的下一次日界绝对秒；ServerTime 未到即抑制重复领取 */
var resolvedResetTs = 0;

/** @type {number|null} 最近一次 push 回写观察到的 choose_hero_daily_reward 值（新鲜度凭证，跨 run 复位） */
var wbValue = null;

/** @type {number} 观察到 wbValue 时的当日日界绝对秒；与当前日界一致才算「今日新鲜回写」 */
var wbDayStart = 0;

/** @type {boolean} 今日是否领成（会话领成 / 新鲜回写 / 落盘日戳恢复；resolvedResetTs 未过期即今日，面板凭证） */
var claimedToday = false;

/** @type {Promise<void>|null} run() 发起的日戳回读（cycle 每拍先 await，防首拍抢跑探测包） */
var stampLoad = null;

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 择时 ──────────────────────────────────────────────────────────────
/**
 * 睡到下一个「服务器 0 点日界」+ 缓冲（绝对秒）；日界不可得时退 IDLE_TICK_MS，并由 cycle 驱动器 24h 硬顶夹住。
 * @param {number} untilTs 目标日界绝对秒
 * @returns {number} 毫秒
 */
function sleepToTs(untilTs) {
  if (!untilTs) return IDLE_TICK_MS;
  var leftMs = (untilTs - gameData.serverTime()) * 1000 + DAILY_ANCHOR_BUFFER_MS;
  return Math.max(leftMs, IDLE_TICK_MS);
}

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 直发一条 9884 领取免费奖励。PBV2 应答已由 net 剥到 pbAckV2.data；永不 reject。
 * @returns {Promise<{ok:boolean, code:number, reason?:string, items:number}>} items=领到的道具条目数
 */
async function claimOnce() {
  if (!net) return { ok: false, code: CODE_NOT_SENT, items: 0 };
  var ret = await net.sendGuarded(
    CMD_GET_FREE_REWARD,
    {},
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        log.warn('cmd 9884 send threw: %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) {
    return { ok: false, code: ret ? ret.code : CODE_NOT_SENT, reason: ret && ret.reason, items: 0 };
  }
  var reward = (ret.data && ret.data.reward) || {};
  var items = Array.isArray(reward.items) ? reward.items.length : 0;
  return { ok: true, code: 0, items: items };
}

// ── 主流程 ────────────────────────────────────────────────────────────
/** cycle 单轮：日戳抑制 → 新的一天发一拍领取 → 按结果落日戳并择时到次日。next-check 日志由 cycle 驱动器统一输出。 */
async function cycleRun() {
  // 首拍先等日戳回读（刷新后同日抑制的关键）；单测直驱不经 run() 时 stampLoad=null 跳过
  if (stampLoad) await stampLoad;
  // 数据未就绪 / 玩法未对该玩家开（字段缺省或 -1）：巡检等待，不敲门
  var state = gameData.heroDailyDealReceived();
  if (state === null || state < 0) return IDLE_TICK_MS;

  // 今日已解决（本地日戳未过期）：睡到日界，零发包（覆盖领取与 push 回写之间的窗口，防逐拍重发）
  if (resolvedResetTs && gameData.serverTime() < resolvedResetTs) {
    return sleepToTs(resolvedResetTs);
  }

  // 新的一天 / 首次运行：字段=1 且今日观察到 push 翻 1（回写新鲜）才省包；
  // 无新鲜凭证的 1 可能是昨日 stale（服务器 0 点不推重置），照发一拍由服务器裁决
  var nextResetTs = gameData.nextDailyResetTs();
  var dayStart = nextResetTs - 86400;
  if (state > 0 && wbValue === 1 && wbDayStart === dayStart) {
    log.debug(
      'daily-deal already claimed today (fresh push write-back), sleep till next daily reset.',
    );
    resolvedResetTs = nextResetTs;
    claimedToday = true;
    saveStamp(true);
    return sleepToTs(resolvedResetTs);
  }
  if (state > 0)
    log.debug('daily-deal field=1 without fresh write-back (stale suspect), try claim anyway.');

  // 否则发一拍领取，由服务器裁决可否。日戳只在成功/真拒绝后落：
  // 瞬态未发出若提前落日戳，下一拍会被日戳闸住睡到次日，短重试承诺失效（单测抓出的旧缺陷）
  var res = await claimOnce();
  if (!aliveFn()) return 0;
  if (!res.ok) {
    // 瞬态未发出（在途频控/发送超时）：短重试，不落日戳
    if (res.code === CODE_NOT_SENT) {
      log.debug('claim transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    // 服务器真拒绝（今日已被手动领走 / 未达条件等）：无副作用，落日戳抑制到次日，每天至多再试一次
    rejectStreak++;
    resolvedResetTs = nextResetTs;
    saveStamp(false);
    log.info(
      'daily-deal claim rejected (streak #%d), retry after next midnight. code=%s%s',
      rejectStreak,
      res.code,
      res.reason ? ' reason=' + res.reason : '',
    );
    return sleepToTs(resolvedResetTs);
  }
  rejectStreak = 0;
  resolvedResetTs = nextResetTs;
  claimedToday = true;
  saveStamp(true);
  log.info(
    'daily-deal free reward claimed (%d items), re-claim after next midnight refresh.',
    res.items,
  );
  return sleepToTs(resolvedResetTs);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

/**
 * 记回写新鲜度凭证（值 + 观察时的当日日界）；ServerTime 不可得时不记（无从定日界）。
 * 拆成纯记录与 kick 两步，供单测直接断言凭证语义。
 * @param {*} v push 载荷里的 choose_hero_daily_reward 原始值
 */
function recordWriteBack(v) {
  var now = gameData.serverTime();
  if (!now) return;
  wbValue = Number(v);
  wbDayStart = gameData.nextDailyResetTs(now) - 86400;
}

/**
 * push 10053/LOGIN 的 choose_hero_daily_reward 回写：记新鲜度凭证并 kick 重判。
 * 日切重置 0 经迟到的 LOGIN 同步到达时，凭证自动失效（wbValue≠1），下一拍即尝试领取。
 * @param {object} ev bus 事件（data 为 JSON 串或已解析对象）
 */
function onReceivedPush(ev) {
  if (!aliveFn()) return;
  var d = safeParse(ev && ev.data) || {};
  if (d.choose_hero_daily_reward == null) return;
  recordWriteBack(d.choose_hero_daily_reward);
  log.debug(
    'push write-back choose_hero_daily_reward=%s, kick re-eval.',
    d.choose_hero_daily_reward,
  );
  cycle.kick();
}

// ── 日戳落盘 ────────────────────────────────────────────────
/**
 * 回读落盘日戳（run() 发起，cycle 每拍先 await 防首拍抢跑探测）。
 * 仅当日戳未过当前服务器日界才恢复（跨日自动作废）；读失败/未就绪按无日戳尽力而为。
 * @returns {Promise<void>}
 */
function loadStamp() {
  return storage.data
    .get(STAMP_KEY)
    .then(function (v) {
      var ts = Number(v && v.resetTs) || 0;
      var now = gameData.serverTime();
      if (ts > 0 && now > 0 && now < ts) {
        resolvedResetTs = ts;
        claimedToday = !!(v && v.claimed);
        log.debug('restored resolved day-stamp (resetTs=%d, claimed=%s).', ts, claimedToday);
        bus.emit(EVT.UI_REFRESH); // 日戳凭证生效，面板只读行立即重算
      }
    })
    .catch(function () {
      /* 读失败（命名空间未就绪等）：按无日戳，首拍照旧由服务器裁决 */
    });
}

/**
 * 落盘「今日已解决」日戳（领成/新鲜回写 claimed=true，真拒绝 false），刷新后同日零发包。
 * 写失败静默降级（storage 自身 warn），不影响内存日戳当拍抑制。
 * @param {boolean} claimed 今日是否已领成
 */
function saveStamp(claimed) {
  storage.data
    .set(STAMP_KEY, { resetTs: resolvedResetTs, claimed: !!claimed })
    .catch(function () {});
  bus.emit(EVT.UI_REFRESH); // 裁决落盘即推面板（拒领日戳刷新后 field=1 显 1/1）
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
 * 运行：复位在飞态 → 订阅回写推送 → 立即判一拍。可否领取靠本地日戳 + 服务器裁决，
 * 权威字段只在有今日新鲜回写凭证时省包；10053/LOGIN 推送兼做日切重置的唤醒补充。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  resolvedResetTs = 0;
  wbValue = null;
  wbDayStart = 0;
  claimedToday = false;
  stampLoad = loadStamp(); // 首拍 await 它：同日刷新恢复日戳零发包，跨日/读失败照旧探测
  ctx.on.push(PUSH_USER_DATA_COMMON, onReceivedPush);
  ctx.on.push(PUSH_LOGIN, onReceivedPush);
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：地图限定基地/大世界（base/world），常态本服（homeland）；
 * 不行军不参战故不设战斗门控；日常任务形态——面板出启用开关 + 一行只读当日进度。
 */
reactor.register({
  id: 'dailyDeal',
  label: '每日特惠',
  storageKey: 'pocketcc.feat.dailyDeal',
  symbols: ['dataCenter'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [
    {
      key: '_dealInfo',
      type: 'text',
      label: '今日',
      get: function () {
        var state = gameData.heroDailyDealReceived();
        if (state === null || state < 0) return '—'; // 数据未就绪/玩法未开
        var now = gameData.serverTime();
        var next = gameData.nextDailyResetTs();
        var dayStart = next ? next - 86400 : 0;
        var freshOne = wbValue === 1 && dayStart > 0 && wbDayStart === dayStart;
        var resolvedToday = resolvedResetTs > 0 && now > 0 && now < resolvedResetTs;
        var scriptOne = claimedToday && resolvedToday;
        // 字段=1 + 今日日戳未过期：当日已裁决且权威字段说已领（拒领日戳刷新场景），非昨日 stale
        var stampOne = state > 0 && resolvedToday;
        if (freshOne || scriptOne || stampOne) return dailyText(1, 1);
        if (state === 0) return dailyText(0, 1);
        return '—'; // 字段=1 但无今日凭证（可能昨日 stale），不谎报已领
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
export { cycleRun, recordWriteBack, install as installForTest };
/** 单测专用：复位在飞态（等价 run() 的复位段，不 kick 循环） */
export function resetForTest() {
  rejectStreak = 0;
  resolvedResetTs = 0;
  wbValue = null;
  wbDayStart = 0;
  claimedToday = false;
  stampLoad = null;
}
/** 单测专用：模拟刷新后的日戳回读（等价 run() 的 stampLoad 发起段） */
export function loadStampForTest() {
  stampLoad = loadStamp();
  return stampLoad;
}
