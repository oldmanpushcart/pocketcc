/**
 * 广告领钻石（AD_NEW 看广告领每日钻石，reactor 说明书形态，玩家基础设置，单链）
 *
 * 玩法：主界面「免费钻石」广告位按槽位每日配额发钻石（游戏 MonthCardController + ADRewardItem），
 *   每领一次进入该槽位冷却 cd，配额跑完等日切重置。本 feat 复刻同口径判据，把冷却到点的槽位领回。
 *   只做钻石线（9707 逐槽位领取），不碰月卡/礼包充值（canPay 相关分支一概不走）。
 *
 * 协议（抓包实证 20261101T030009-广告领钻石.ndjson；源码锚点 extracted/Script/MonthCardController）：
 *   9706 GET_AD_MONTH_CARD_WATCH_INFO，sendPBV2，载荷 {} → 应答 data =
 *     {adMonthCardWatchInfos:[{adNewId,viewCount,lastViewTime(Int64 毫秒)}], endTimeWithSwitchClosed(Int64)}。
 *     viewCount 是**服务器侧当日已领次数**（20261011T185055 那台号 adNewId=1 直接回 20），故每轮重读即权威，
 *     不需要长期自维护镜像。
 *   9707 GET_AD_MONTH_CARD_WATCH_REWARD，sendPBV2，载荷 {adNewId,cnt} → 应答 data =
 *     {adMonthCardInfo:{adNewId,viewCount,lastViewTime}, reward:{resource:{gold:15,…}}}。
 *     header.s=0 为领到；实证四连发均 adNewId=1、cnt=1，viewCount 1→4、每次 gold=15，间隔 16–17s（即 cd 形状）。
 *     真机已验证：**不看了广告 SDK 也能领到**（脚本直发 9707 应答 gold=15），服务器不校验看点凭据。
 *
 * 领取范围：**只领含钻石的槽位**。AD_NEW 不止钻石——其余槽位发城市外观/出征队列/行军速度等限时 buff
 *   （字典 ad_new05/06/07），随机时刻领掉会浪费生效窗，故按行上 `reward` 奖励配置解出的条目 type 筛掉非钻石槽。
 *   判据链：ADRewardItem.updateItem 用 `e.reward` 渲染奖励图标（行上有该字段，其他表实测为数字配置 id）
 *   → RewardController.getRewardsArrById 解出 [{type,id,count,name}] → type=ResourceType.Gold=10
 *   （ResourceNameConst[10]="100017"="钻石"，与 9707 应答的 reward.resource.gold 同源）。
 *
 * 同轮连发的频率闸：游戏 NetMgr 对 cmd 9707 配了 MsgIdSettings.cdTime=200（同一 cmd 距上次发出不足 200ms
 *   则 `return!1` 直接不发，真机实证为第二条报 `SendPBV2 [9707] failed.`），故多槽位领取必须隔
 *   CLAIM_SEND_GAP_MS；单靠 isSending 在途查拦不住（它是墙钟时间闸，与在途无关）。
 *
 * 可领判据（游戏 ADRewardItem.refreshItem 同口径：cdTime=floor(lastViewTime/1000)+cd，rewardCount=times-viewCount）：
 *   配置表 AD_NEW(="ad_new") 行字段 {id 槽位, times 当日配额, cd 领取后冷却秒, level 开放等级}；
 *   remaining>0 且 ServerTime>=cdTime 即可领；remaining<=0 = 该槽位当日封顶；等级未达标的行按不存在
 *   （游戏 getAdRewardList 亦如此过滤）。vip_level/月卡免费的分支不预先判定，交由服务器裁决（见下「被拒口径」）。
 *
 * 被拒口径：直发 9707 不经游戏 UI 回调，MonthCardController._monthCardInfo 不回写，但下一轮 9706 重读服务器
 *   权威态即自愈；领成功当轮先用应答的 adMonthCardInfo 乐观补写 stateById，只为择时准确、避免同轮重复领。
 *   服务器拒绝（s≠0，如该槽位需 VIP/月卡）属可预期业务态，走 info、不做本地拉黑：
 *   连续拒绝计数只统计领取侧，达 3 次退巡检档 ×2，任一槽位领到即清零（对齐一键领取 streak 口径）。
 *
 * 调度（A 族 createCycle，全本地可重放读）：
 *   - 有可领槽位：本轮逐个 9707 领取 → 按新态排下拍；
 *   - 全在冷却：睡到最早 cd 到点 + 缓冲（夹在 [MIN_WAKE, WAIT_CAP]，到点前零发包）；
 *   - 全部当日封顶：睡到服务器日界 + 缓冲（封顶 26h）；
 *   - 表未加载/9706 未就绪：IDLE 巡检；9706/9707 瞬态未发出：短重试，不拖进退避。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 9706/9707，不回写游戏本地态、不 OpenUI、不看真实广告 SDK。
 *   日常任务形态：面板只出启用开关，无字段无配置（fields=[]，toModuleCfg 返回空）。
 *   不行军不参战，offInCombat:false。生命周期由 reactor 托管，pause 后 alive()=false 自然停摆。
 */
import { CODE_NOT_SENT, sleep } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { bits, gameData, l10n } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=AD-DIAMOND） */
const log = createLog('AD-DIAMOND');

/** @type {number} NRequestIdV2.GET_AD_MONTH_CARD_WATCH_INFO，查各槽位当日已领态（sendPBV2） */
const CMD_WATCH_INFO = 9706;

/** @type {number} NRequestIdV2.GET_AD_MONTH_CARD_WATCH_REWARD，领指定槽位一次看广告奖励（sendPBV2） */
const CMD_WATCH_REWARD = 9707;

/** @type {string} TableName.AD_NEW（="ad_new"），槽位配置表（times 配额 / cd 冷却秒 / level 开放等级） */
const TABLE_AD_NEW = 'AD_NEW';

/** @type {number} cd 到点唤醒的抖动余量（毫秒），避开服务器结算时序 */
const READY_BUFFER_MS = 1000 * 3;

/** @type {number} 数据未就绪/被拒后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 单睡上界（毫秒）：长冷却切成多拍，纯本地读零发包，防超长定时器漂移 */
const WAIT_CAP_MS = IDLE_TICK_MS * 8;

/** @type {number} 择时下界（毫秒）：cd 配置缺省/为 0 时防空转连点 */
const MIN_WAKE_MS = 1000 * 5;

/** @type {number} 瞬态未发出（在途频控/发送超时）的重试间隔（毫秒） */
const TRANSIENT_RETRY_MS = 1000 * 20;

/**
 * @type {number} 同轮多槽位领取的发送间隔（毫秒）：游戏 NetMgr 对 cmd 9707 配了反连点频率闸
 *   （MsgIdSettings[9707].cdTime=200，verbatim：同一 cmd 距上次发出 <cdTime 则 `return!1` 直接不发），
 *   故同轮连领必须 >200ms；取 300 留裕量避开结算抖动。真机实证：不隔时第一条成、第二条报
 *   `SendPBV2 [9707] failed.`（本端未发出，非服务器拒绝）。
 */
const CLAIM_SEND_GAP_MS = 300;

/** @type {number} 日切唤醒缓冲（毫秒），对齐每日补给/矿洞的日界留白口径 */
const DAY_ROLL_BUFFER_MS = 1000 * 60 * 5;

/**
 * @type {number} 奖励条目 type 为钻石的枚举值（实证 GameDefine.ResourceType.Gold=10，
 *   其名字键 ResourceNameConst[10]="100017"="钻石"；与 9707 应答里的 reward.resource.gold 同源）
 */
const RES_TYPE_GOLD = 10;

/** @type {number} 连续领取被拒次数，达 3 次后退巡检档；任一槽位领到即清零 */
var claimStreak = 0;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {Map<number, {viewCount:number, lastSec:number}>} 槽位态：9706 权威读入，9707 应答乐观补写 */
var stateById = new Map();

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 只读换算 ──────────────────────────────────────────────────────────
/**
 * Int64 毫秒时刻归一：应答 lastViewTime 运行时是 Long 实例（有 toNumber），
 *   离线形态才落成 {_low,_high}，故两侧都兜。
 *   口径说明：本字段是**时刻量纲**（ms，当前约 1.8e12 << 2^53）而非 64 位 id，故取 Number 与游戏
 *   `lastViewTime.toNumber()/1000` 同口径；id 类字段仍守「按字符串读」铁律。
 * @param {*} v Long 实例 / 数字 / 数字串
 * @returns {number} 毫秒（无值/不可解析回 0）
 */
function toMs(v) {
  if (v == null) return 0;
  try {
    if (typeof v.toNumber === 'function') return Number(v.toNumber()) || 0;
  } catch (e) {}
  return Number(bits.int64Str(v)) || 0;
}

/**
 * 该行的奖励内容是否含钻石（只领钻石槽位的筛选判据，见文件头「领取范围」）。
 *   行上 `reward` 是奖励配置 id，经 RewardController 实时解成道具清单后比 type。
 * @param {object} row AD_NEW 表行
 * @returns {boolean|null} true 含钻石；false 不含（buff/外观槽或行未配奖励）；
 *   null 有配置 id 但解不出条目（rewardCtrl 依赖缺失，调用方据此整轮不领，不默认当钻石）
 */
function hasDiamondReward(row) {
  var rid = Number(row.reward) || 0;
  if (!rid) return false;
  var items = gameData.rewardItems(rid);
  if (!items.length) return null;
  for (var i = 0; i < items.length; i++) {
    if (Number(items[i].type) === RES_TYPE_GOLD) return true;
  }
  return false;
}

/**
 * 可参与槽位（AD_NEW 配置行，字段归一）：无 id/无配额的行剔除，等级未达标的行按游戏同口径视作不存在，
 *   奖励不含钻石的槽位一并筛掉。
 * @returns {{list: {id:number, times:number, cd:number}[], unresolved:number}} list 为钻石槽；
 *   unresolved 为「有 reward 配置但解不出条目」的行数（依赖缺失计数）；表未加载时 list=[]
 */
function slots() {
  var rows = l10n.tableRows(TABLE_AD_NEW);
  var lv = gameData.level();
  var out = [];
  var unresolved = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var id = Number(r.id) || 0;
    var times = Number(r.times) || 0;
    if (!id || times <= 0) continue;
    if (Number(r.level) > 0 && lv < Number(r.level)) continue;
    var diamond = hasDiamondReward(r);
    if (diamond !== true) {
      if (diamond === null) unresolved++;
      continue;
    }
    out.push({ id: id, times: times, cd: Number(r.cd) || 0 });
  }
  return { list: out, unresolved: unresolved };
}

/**
 * 单槽位三态：ready 可领 / wait 冷却中（waitSec 剩余秒）/ capped 当日配额跑完。
 * 未领过的槽位服务器无条目（viewCount 0、lastSec 0），cdTime=cd，通常即刻 ready。
 * @param {{id:number, times:number, cd:number}} slot slots() 元素
 * @param {number} now 服务器秒
 * @returns {{state:string, waitSec?:number}}
 */
function slotState(slot, now) {
  var st = stateById.get(slot.id);
  var used = st ? st.viewCount : 0;
  if (used >= slot.times) return { state: 'capped' };
  var cdTime = (st ? st.lastSec : 0) + slot.cd;
  if (now < cdTime) return { state: 'wait', waitSec: cdTime - now };
  return { state: 'ready' };
}

/**
 * 按各槽位态出择时：取最早 cd 到点（夹 [MIN_WAKE, WAIT_CAP]）；全部当日封顶则睡到日界。
 * 仍判 ready 说明上一拍的领取被拒（本地态没推进），回下界等下次巡检裁决，不自造拉黑。
 * @param {object[]} list slots() 结果
 * @param {number} now 服务器秒
 * @returns {number} 毫秒
 */
function delayFor(list, now) {
  var minWaitSec = 0;
  var anyRemaining = false;
  for (var i = 0; i < list.length; i++) {
    var s = slotState(list[i], now);
    if (s.state === 'capped') continue;
    anyRemaining = true;
    if (s.state === 'ready') return MIN_WAKE_MS;
    if (!minWaitSec || s.waitSec < minWaitSec) minWaitSec = s.waitSec;
  }
  if (!anyRemaining) return dayRollDelay();
  return Math.min(Math.max(minWaitSec * 1000 + READY_BUFFER_MS, MIN_WAKE_MS), WAIT_CAP_MS);
}

/**
 * 全部槽位当日封顶：睡到下一个服务器日界 + 缓冲（日界不可得退 IDLE，封顶 26h 防时钟异常超睡）。
 * @returns {number} 毫秒
 */
function dayRollDelay() {
  var next = gameData.nextDailyResetTs();
  if (!next) return IDLE_TICK_MS;
  var ms = (next - gameData.serverTime()) * 1000 + DAY_ROLL_BUFFER_MS;
  return Math.min(Math.max(ms, IDLE_TICK_MS), 1000 * 60 * 60 * 26);
}

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 直发 9706 拉各槽位当日已领态并整表覆盖 stateById（服务器权威，顺带清掉上轮乐观值）。永不 reject。
 * @returns {Promise<{ok:boolean, code:number}>}
 */
async function fetchInfo() {
  if (!net || net.isSending(CMD_WATCH_INFO)) return { ok: false, code: CODE_NOT_SENT };
  var ret;
  try {
    ret = await net.sendPBV2(CMD_WATCH_INFO, {});
  } catch (err) {
    log.debug('cmd 9706 send failed: %s', err && err.message);
    return { ok: false, code: CODE_NOT_SENT };
  }
  if (!ret || !ret.ok) return { ok: false, code: ret ? ret.code : CODE_NOT_SENT };
  var list = ret.data && ret.data.adMonthCardWatchInfos;
  if (!Array.isArray(list)) {
    log.warn('cmd 9706 ack has no adMonthCardWatchInfos.', ret.data);
    return { ok: false, code: ret.code };
  }
  stateById = new Map();
  for (var i = 0; i < list.length; i++) {
    var it = list[i] || {};
    var id = Number(it.adNewId) || 0;
    if (!id) continue;
    stateById.set(id, {
      viewCount: Number(it.viewCount) || 0,
      lastSec: Math.floor(toMs(it.lastViewTime) / 1000),
    });
  }
  return { ok: true, code: 0 };
}

/**
 * 直发一条 9707 领某槽位（cnt=1，与真机逐次看点同形）。永不 reject。
 * @param {number} id 槽位 id（AD_NEW 行 id）
 * @param {number} times 领取前已领次数（仅应答缺 adMonthCardInfo 时兜底递增用）
 * @returns {Promise<{claimed:boolean, code:number, gold:number}>}
 */
async function claimOnce(id, times) {
  if (!net || net.isSending(CMD_WATCH_REWARD))
    return { claimed: false, code: CODE_NOT_SENT, gold: 0 };
  var ret;
  try {
    ret = await net.sendPBV2(CMD_WATCH_REWARD, { adNewId: id, cnt: 1 });
  } catch (err) {
    log.debug('cmd 9707 send failed: %s', err && err.message);
    return { claimed: false, code: CODE_NOT_SENT, gold: 0 };
  }
  if (!ret || !ret.ok) return { claimed: false, code: ret ? ret.code : CODE_NOT_SENT, gold: 0 };
  var info = ret.data && ret.data.adMonthCardInfo;
  if (info && Number(info.adNewId) === id) {
    stateById.set(id, {
      viewCount: Number(info.viewCount) || times + 1,
      lastSec: Math.floor(toMs(info.lastViewTime) / 1000) || gameData.serverTime(),
    });
  } else {
    // 应答没带回槽位态：按「now + times+1」兜底，保证同轮/下拍不误判仍可领（下轮 9706 会校正）
    stateById.set(id, { viewCount: times + 1, lastSec: gameData.serverTime() });
  }
  var res = ret.data && ret.data.reward && ret.data.reward.resource;
  var gold = Number(res && res.gold) || 0;
  claimStreak = 0;
  log.info('ad diamond claimed (slot #%d, #%d today), gold=%d.', id, times + 1, gold);
  return { claimed: true, code: 0, gold: gold };
}

// ── 主流程 ────────────────────────────────────────────────────────────
/** cycle 单轮：表 → 9706 权威态 → 逐个领 ready 钻石槽 → 按新态排下拍。next-check 日志由 cycle 驱动器统一输出。 */
async function cycleRun() {
  var g = slots();
  var list = g.list;
  if (!list.length) {
    // 一个钻石槽都没筛出：区分「奖励配置解不出（依赖故障，必须可见）」与「确实无钻石槽/表未加载」
    if (g.unresolved > 0)
      log.warn(
        'diamond filter unresolved on %d AD_NEW row(s) (reward config unavailable), skip round.',
        g.unresolved,
      );
    else log.debug('no diamond slot in AD_NEW (table empty or level gated), poll later.');
    return IDLE_TICK_MS;
  }
  var st = await fetchInfo();
  if (!aliveFn()) return 0;
  if (!st.ok) {
    // 瞬态未发出（在途频控/发送超时）：短重试，不拖进 15min 退避，避免已到点的领取被延迟
    if (st.code === CODE_NOT_SENT) {
      log.debug('info transient (not sent/in-flight), retry soon.');
      return TRANSIENT_RETRY_MS;
    }
    log.info('info rejected by server, poll later. code=%s', st.code);
    return IDLE_TICK_MS;
  }

  var now = gameData.serverTime();
  var claimed = 0;
  var gold = 0;
  var notSent = false;
  /** @type {boolean} 本轮是否已发过一条 9707（发过则下一条须隔 cdTime，不看成败：被拦/被拒都已占用发送时刻） */
  var sentThisRound = false;
  for (var i = 0; i < list.length; i++) {
    var cur = stateById.get(list[i].id);
    if (slotState(list[i], now).state !== 'ready') continue;
    // 同轮连领须隔过游戏侧 9707 的 cdTime 频率闸（见 CLAIM_SEND_GAP_MS 注释），否则第二条直接发不出去
    if (sentThisRound) {
      await sleep(CLAIM_SEND_GAP_MS);
      if (!aliveFn()) return 0;
    }
    sentThisRound = true;
    var res = await claimOnce(list[i].id, cur ? cur.viewCount : 0);
    if (!aliveFn()) return 0;
    if (res.claimed) {
      claimed += 1;
      gold += res.gold;
      continue;
    }
    if (res.code === CODE_NOT_SENT) {
      notSent = true;
      break; // 在飞/未发出：本轮收口，下拍重读
    }
    claimStreak++;
    log.info('claim rejected (slot #%d, streak #%d). code=%s', list[i].id, claimStreak, res.code);
  }
  if (notSent) {
    log.debug('claim transient (not sent/in-flight), retry soon.');
    return TRANSIENT_RETRY_MS;
  }
  if (claimStreak >= 3) return IDLE_TICK_MS * 2;
  if (claimed > 0) log.info('ad diamond round: %d slot(s), gold=%d.', claimed, gold);
  return delayFor(list, gameData.serverTime());
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
 * 运行：复位在飞态 → 立即判一拍。无 push 订阅（可否领取靠 9706 服务器权威态 + 本地 cd 钟算）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  claimStreak = 0;
  stateById = new Map();
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：地图限定基地/大世界（base/world），常态本服（homeland）；
 * 不行军不参战故不设战斗门控；日常任务形态——面板只出启用开关，无字段无配置
 * （配额/冷却均由 AD_NEW 表驱动，非用户可调项）。
 */
reactor.register({
  id: 'adDiamond',
  label: '广告领钻石',
  storageKey: 'pocketcc.feat.adDiamond',
  symbols: ['dataCenter', 'tableManager', 'tableName'],
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
