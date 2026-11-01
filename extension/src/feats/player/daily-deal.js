/**
 * 每日特惠（Hero Daily Deal 免费奖励，reactor 说明书形态，玩家基础设置，单链）
 *
 * 玩法：商店「每日特惠」页签每天附赠一份免费奖励（道具/资源），每日 0 点刷新、限购 1 次。
 *   本功能只做免费线：付费档位礼包（真钱 exchange 购买 / 9883 选英雄礼包）不碰。
 *
 * 协议（抓包实证 20261024T093950-每日特惠.ndjson；源码锚点 extracted/subpack 的
 *   HeroDailyDealGiftShopNode.onClickReward）：
 *   9884 HERO_DAILY_EXCHANGE_GET_FREE_REWARD，sendPBV2，载荷 {}（游戏领取按钮同款空载荷）→
 *   应答 pbAckV2.data = {reward:{resource:{…}, items:[{itemId,itemCount}…], …}}，header.s=0 为领到；
 *   领取成功伴随 push 10031 PUSH_REWARD 到账 + push 10053 PUSH_USER_DATA_COMMON
 *   {choose_hero_daily_reward:"1"}（游戏 UserData 据此把 heroDailyDealGiftIsReceived 回写为 1）。
 *
 * 可领判据（游戏 HeroDailyDealGiftShopNode.refreshFreeRewardItem 同口径）：
 *   UserData.heroDailyDealGiftIsReceived === 0 即可领（0=未领、1=已领、-1=构造默认/数据未同步/玩法未开）。
 *   本端直发 9884 不经游戏领取回调，但状态回写走服务器 push 10053（与谁发包无关），故本地字段会随领取自然翻 1；
 *   日切回写是否及时不可靠（可能只在登录/开面板时下发），故字段只当「省一次发包的优化」用，不当闸门；
 *   真正的当日不重发靠本地日戳 resolvedResetTs（对齐每日补给 mirror / 战争之源 claimedIds 教训），日戳过点即随日切自动解禁。
 *
 * 调度（A 族 createCycle，日锚单次尝试 + 全本地可重放读）：
 *   - 日戳未过（resolvedResetTs > ServerTime）：今日已解决（领到 / 被服务器判不可领），睡到该日界 + 缓冲，零发包；
 *   - 新的一天（日戳已过期 / 首次运行）：
 *       · 权威字段已翻 1（游戏/手动当日领过且回写及时）：落日戳零发包，省一次请求；
 *       · 否则发一拍 9884 领取，由服务器裁决——
 *           - 成功：记当日收益、置 resolvedResetTs=下一日界；
 *           - 服务器真拒绝（s≠0，含「今日已被手动领走/未达条件」）：记 info、同样置 resolvedResetTs 抑制到次日
 *             （免费奖励领取被拒无副作用，每天至多试一次即可，不反复敲门）；
 *           - 瞬态未发出（CODE_NOT_SENT：在途频控/发送超时）：短重试，不落日戳。
 *   - 被拒只累计 streak 供观测，择时始终以「睡到次日日界」为上限，不做 ×2 长睡（否则跨过一个日界白丢一天）。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 9884，不调任何游戏 Update/回写、不 OpenUI。
 *   日常任务形态：面板只出启用开关，无字段无配置（fields=[]，toModuleCfg 返回空）。
 *   不行军不参战，offInCombat:false。生命周期由 reactor 托管，pause 后 alive()=false 自然停摆。
 */
import { CODE_NOT_SENT } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { gameData } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=DAILY-DEAL） */
const log = createLog('DAILY-DEAL');

/** @type {number} NRequestIdV2.HERO_DAILY_EXCHANGE_GET_FREE_REWARD，领取每日特惠免费奖励（sendPBV2，空载荷） */
const CMD_GET_FREE_REWARD = 9884;

/** @type {number} 数据未就绪/玩法未开时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 睡过服务器 0 点日界后的抖动余量（毫秒），让当日额度完成刷新结算再领 */
const DAILY_ANCHOR_BUFFER_MS = 1000 * 60;

/** @type {number} 瞬态未发出（CODE_NOT_SENT：在途频控/发送超时）的短重试（毫秒），不拖进巡检退避 */
const TRANSIENT_RETRY_MS = 1000 * 20;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {number} 连续被服务器拒绝次数（跨日累计，仅供观测；成功即清零） */
var rejectStreak = 0;

/** @type {number} 今日已解决（领到/被拒）对应的下一次日界绝对秒；ServerTime 未到即抑制重复领取 */
var resolvedResetTs = 0;

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
  if (!net || net.isSending(CMD_GET_FREE_REWARD))
    return { ok: false, code: CODE_NOT_SENT, items: 0 };
  var ret;
  try {
    ret = await net.sendPBV2(CMD_GET_FREE_REWARD, {});
  } catch (err) {
    log.debug('cmd 9884 send failed: %s', err && err.message);
    return { ok: false, code: CODE_NOT_SENT, items: 0 };
  }
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
  // 数据未就绪 / 玩法未对该玩家开（字段缺省或 -1）：巡检等待，不敲门
  var state = gameData.heroDailyDealReceived();
  if (state === null || state < 0) return IDLE_TICK_MS;

  // 今日已解决（本地日戳未过期）：睡到日界，零发包（覆盖领取与 push 回写之间的窗口，防逐拍重发）
  if (resolvedResetTs && gameData.serverTime() < resolvedResetTs) {
    return sleepToTs(resolvedResetTs);
  }

  // 新的一天 / 首次运行：权威字段说已领（且回写追平日界）则直接落日戳，省一次发包
  resolvedResetTs = gameData.nextDailyResetTs();
  if (state > 0) {
    log.debug('每日特惠今日已领（游戏侧领取回写），睡到明日日界。');
    return sleepToTs(resolvedResetTs);
  }

  // 否则发一拍领取，由服务器裁决可否
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
    log.info(
      '每日特惠领取被拒（streak #%d），明日 0 点后再试。 code=%s%s',
      rejectStreak,
      res.code,
      res.reason ? ' reason=' + res.reason : '',
    );
    return sleepToTs(resolvedResetTs);
  }
  rejectStreak = 0;
  log.info('每日特惠免费奖励已领取（%d 项道具），明日 0 点刷新后再领。', res.items);
  return sleepToTs(resolvedResetTs);
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
 * 运行：复位在飞态 → 立即判一拍。无 push 订阅（可否领取靠本地日戳 + 权威字段，日切自然解禁）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  resolvedResetTs = 0;
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：地图限定基地/大世界（base/world），常态本服（homeland）；
 * 不行军不参战故不设战斗门控；日常任务形态——面板只出启用开关，无字段无配置。
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
  fields: [],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
