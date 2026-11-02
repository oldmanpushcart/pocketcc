/**
 * 联盟礼物-自动领取（reactor 说明书形态）
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 *
 * 判据（口径同游戏面板 updatePageRedPoint / onReceiveBoxClick，见 references/历史文档/联盟礼物.md、AllianceGiftPanel.js）：
 *   读内存模型 DATA.UserData.Alliance.AllianceGiftData 两字段：
 *     - RedPointObj（形如 {1: 普通可领数, 2: 稀有可领数}）→ 某 type>0 即该类 1177 可领；
 *     - AlGiftList（珍藏奖励 id 数组，如 [900122,900122]）→ length>0 即 1178 可领。
 *   两字段都由 5014 应答 / 10442 push 一次刷完（push 同时带 typeNumMap 与 userInfo.alGiftRewards），
 *   脚本不自建 5015 分页解析。
 *
 * 领取（见 references/历史文档/联盟礼物.md）：
 *   req send Receive_Alliance_Gift_Small_All(1177) {type:1 普通 / 2 稀有} → 一键领完该类全部可领礼物。
 *   req send Receive_Alliance_Gift_Big(1178) {} → 领 1 箱"联盟珍藏礼物"（游戏 onReceiveBoxClick 就是这个语义，
 *   一次一箱），剩余靠下轮 busy 逐箱清完。
 *   普通/稀有/珍藏各一个开关，独立判据、独立发送；三者共用同一条 busy/idle 定时链与 10442 唤醒。
 *
 * 触发模型：
 *   1) 轮询为主（联盟礼物无可靠的"有礼物"专用推送语义可依赖，口径同联盟帮助——生产者轮询，不纯事件驱动）；
 *   2) 礼物信息推送 10442（PUSH_ALLIANCE_GIFT_INFO）当纯唤醒源：listener 不读载荷，游戏自身 handler 已先把
 *      RedPointObj 刷新（net 封装先跑 recvOrig 再派发）。唤醒只用于打破 idle 长眠，不穿透 busy 勤扫节奏；
 *      一次唤醒风暴只发一次复查（wake 在途时后续 push 忽略），防风暴期反复重置定时把检查无限后移；
 *   3) busy/idle 两档降频：本轮真领到了东西用 busyInterval 勤扫（RedPointObj 由服务器回执刷新，需短间隔复核），
 *      没东西可领降 idleInterval 防空转刷 1177。零点礼物风暴期节奏严格锁定在 busyInterval，与 push 频率解耦；
 *   4) 1177 按 type、1178 单 key 'big'，各设最小间隔闸门：同类距上次成功发送不足 busyInterval 直接跳过
 *      （1177 批量结算攒一批再领 / 1178 一 tick 只领 1 箱避免同刻连发被限流，剩余靠下轮 busy 续领），
 *      被拒不记闸门、下轮可重试。
 *
 * 重入闸门：单定时器 + claiming 标志保证同一时刻只有一轮检查在飞（含 1177 await）；
 *   pause 后 alive()=false，挂着的定时器到点空转一次不再自重排，resume 时 run 复位并重新点火。
 *
 * 生命周期由 reactor 托管：install/configure/run 三个钩子。纯协议领取（不派行军、不抢行军队列），
 *   故不声明 places、不声明 offInCombat（战斗态下继续跑）；但声明了 kinds:['homeland']（A 档）：
 *   进峡谷/天梯/秘境/征服者图即 pause，回本服图自动 resume（可行性报告 §7.2 保守选择，要升 B 可改）。
 */
import { sleep } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ALLIANCE_GIFT） */
const log = createLog('ALLIANCE_GIFT');

/** @type {number} RequestId.Receive_Alliance_Gift_Small_All（RequestId.js:408），一键领取某类联盟礼物，载荷 {type} */
const CMD_RECEIVE_GIFT_ALL = 1177;

/** @type {number} RequestId.Receive_Alliance_Gift_Big（RequestId.js:409），领 1 箱联盟珍藏礼物，载荷 {} */
const CMD_RECEIVE_GIFT_BIG = 1178;

/** @type {number} ResponseId.PUSH_ALLIANCE_GIFT_INFO（ResponseId.js:192），联盟礼物信息更新推送；仅作唤醒源，不读载荷 */
const CMD_PUSH_ALLIANCE_GIFT_INFO = 10442;

/** @type {number} AllianceGiftType.NORMAL_GIFT（AllianceGiftData.js:280），普通礼物 */
const GIFT_TYPE_NORMAL = 1;

/** @type {number} AllianceGiftType.RARE_GIFT（AllianceGiftData.js:281），稀有礼物 */
const GIFT_TYPE_RARE = 2;

/** @type {string} lastClaimAt 里珍藏礼物（1178 无 type 参数）的记账 key */
const GIFT_KEY_BIG = 'big';

/** @type {number} 领完一类到下一类之间的间隔，规避 1177 过快被服务器限流 */
const CLAIM_GAP_MS = 1000 * 2;

/** @type {number} 推送 10442 到点复查的去抖窗口：礼物风暴期多条推送合并成一次检查 */
const PUSH_DEBOUNCE_MS = 1000 * 2;

/**
 * 内置调优常量（面板仅出启用开关，不暴露这些项）
 * @type {object}
 */
const cfg = {
  /** 普通礼物自动领取开关 */
  normal: { enabled: true },

  /** 稀有礼物自动领取开关 */
  rare: { enabled: true },

  /** 珍藏礼物自动领取开关（判据 AllianceGiftData.AlGiftList.length>0；1178 一次一箱，跨 tick busy 逐箱清完） */
  big: { enabled: true },

  /**
   * 有礼物时间隔：本轮真领到了东西时用（默认15秒），勤扫趁 RedPointObj 刷新后继续领剩下的
   */
  busyInterval: 1000 * 15,

  /**
   * 无礼物时间隔：没东西可领时降到这档（默认5分钟），少刷 1177；推送 10442 仍是主触发源，礼物一到即被唤醒
   */
  idleInterval: 1000 * 60 * 5,
};

/**
 * 脚本依赖：net 网络（promise 封装 pocketcc.net）、data 数据中心（读 AllianceGiftData.RedPointObj）
 * @type {object|null}
 */
var net;
/** @type {object|null} DataCenter.DATA */
var data;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞检查自然退出 */
var ctxRef = null;

/** @type {number|null} 单定时器句柄；pause 后到点空转一次不再自重排 */
var timer = null;

/** @type {boolean} 检查闸门：同时只跑一轮 tick（含 1177 await），防重入 */
var claiming = false;

/** @type {number} 上轮 tick 开跑时刻；push 唤醒据此判断是否已超 busy 间隔 */
var lastCheckAt = 0;

/** @type {'busy'|'idle'|'wake'|null} 当前定时档位：wake=push 唤醒复查在途，busy/idle=tick 末尾排程 */
var timerMode = null;

/** @type {Object<number, number>} 各礼物类型上次 1177 成功发送时刻；同类发送的最小间隔闸门用 */
var lastClaimAt = Object.create(null);

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ─────────────────────────── 数据读取 ───────────────────────────

/**
 * 取联盟礼物数据本体 AllianceGiftData（RedPointObj / AlGiftList 两个判据字段的共同宿主）
 * 不在联盟 / 数据未就绪时返回 null（调用方据此判 0，不崩）
 * @returns {object|null}
 */
function getGiftData() {
  var alliance = data && data.UserData && data.UserData.Alliance;
  return (alliance && alliance.AllianceGiftData) || null;
}

/**
 * 取 1177 判据字段 RedPointObj（{1:普通数, 2:稀有数}）
 * @returns {object|null}
 */
function getRedPointObj() {
  var giftData = getGiftData();
  return (giftData && giftData.RedPointObj) || null;
}

/**
 * 取 1178 判据字段 AlGiftList（珍藏奖励 id 数组，如 [900122,900122]）
 * 游戏 AllianceGiftPanel.onReceiveBoxClick 就是判 length>0
 * @returns {Array|null}
 */
function getAlGiftList() {
  var giftData = getGiftData();
  return (giftData && giftData.AlGiftList) || null;
}

/**
 * 某类礼物的可领数量（RedPointObj 键为 "1"/"2"，数字下标亦可命中）
 * @param {object|null} red RedPointObj
 * @param {number} type 礼物类型 1/2
 * @returns {number}
 */
function countOf(red, type) {
  if (!red) return 0;
  return Number(red[type]) || 0;
}

// ─────────────────────────── 调度 ───────────────────────────

/**
 * 单定时器武装器：到点跑一次 tick；pause 后 alive()=false 不再武装
 * @param {number} delay 延迟(毫秒)
 * @param {'busy'|'idle'|'wake'} mode 档位；wake 只能从 busy/idle 进入，防 push 风暴反复重置把检查无限后移
 */
function schedule(delay, mode) {
  if (!aliveFn()) return;
  if (timer) clearTimeout(timer);
  timerMode = mode;
  timer = setTimeout(
    function () {
      timer = null;
      timerMode = null;
      if (!aliveFn()) return;
      tick().catch(function (err) {
        log.warn('tick threw, reschedule.', err);
        schedule(cfg.idleInterval, 'idle');
      });
    },
    Math.max(0, delay),
  );
}

/**
 * 推送 10442 唤醒入口：不读载荷，游戏 handler 已先刷新 RedPointObj。
 * 只做"打破 idle 长眠"的提前复查，不穿透 busy 勤扫节奏；wake 在途时后续 push 直接忽略，
 * 风暴期实际检查节奏由 tick 自己的 busy/idle 排程决定，与 push 频率解耦
 */
function onGiftInfoPush() {
  if (!aliveFn() || claiming) return;
  if (timerMode === 'wake') return;
  if (timerMode === 'busy' && Date.now() - lastCheckAt < cfg.busyInterval) return;
  // idle 长眠中或从未检查过：提前到 debounce 点；busy 档超期兜底：回到常规 busy 节奏
  schedule(
    timerMode === 'idle' ? PUSH_DEBOUNCE_MS : cfg.busyInterval,
    timerMode === 'busy' ? 'busy' : 'wake',
  );
}

// ─────────────────────────── 生产 + 领取 ───────────────────────────

/**
 * 一轮检查：读 RedPointObj → 逐个启用的类型若有可领则发 1177 → 按本轮是否领到东西重排。永不 reject。
 * @returns {Promise<void>}
 */
async function tick() {
  if (claiming) return;
  claiming = true;
  lastCheckAt = Date.now();
  var didClaim = false;
  try {
    var red = getRedPointObj();

    // 普通礼物
    if (cfg.normal.enabled && countOf(red, GIFT_TYPE_NORMAL) > 0) {
      if (await claimType(GIFT_TYPE_NORMAL, 'normal')) {
        didClaim = true;
        await sleep(CLAIM_GAP_MS);
        if (!aliveFn()) return;
      }
    }

    // 稀有礼物（重新读红点，普通领取后可能已被服务器回执刷新）
    red = getRedPointObj();
    if (cfg.rare.enabled && countOf(red, GIFT_TYPE_RARE) > 0) {
      if (await claimType(GIFT_TYPE_RARE, 'rare')) {
        didClaim = true;
        await sleep(CLAIM_GAP_MS);
        if (!aliveFn()) return;
      }
    }

    // 珍藏礼物：判据 AlGiftList.length>0；1178 一次一箱，剩余靠下轮 busy 续领（同 tick 不连发，规避限流）
    if (cfg.big.enabled) {
      var list = getAlGiftList();
      if (list && list.length > 0) {
        if (await claimBig()) didClaim = true;
      }
    }
  } finally {
    claiming = false;
  }

  if (!aliveFn()) return;
  // 领到了 → busy 勤扫接着清剩下的；没领 → idle 降频（push 唤醒会打破 idle 长眠）
  schedule(didClaim ? cfg.busyInterval : cfg.idleInterval, didClaim ? 'busy' : 'idle');
}

/**
 * 一键领取某类礼物（1177）。永不 reject；返回是否领取成功
 * 同类最小间隔闸门：距上次成功发送不足 busyInterval 直接跳过（攒一批再领，风暴期限频主闸门）；
 * 被拒/出错不记闸门，下轮照常重试。
 * 结果单一出口在此打日志：成功 info（带上该类原可领数）、被拒 warn（带 code）
 * @param {number} type 礼物类型 1/2
 * @param {string} label 日志标识 normal/rare
 * @returns {Promise<boolean>} 是否领取成功
 */
async function claimType(type, label) {
  if (net.isSending(CMD_RECEIVE_GIFT_ALL)) {
    return false;
  }
  if (Date.now() - (lastClaimAt[type] || 0) < cfg.busyInterval) {
    log.debug('skip %s claim: min-interval gate. type=%d', label, type);
    return false;
  }
  var pending = countOf(getRedPointObj(), type);
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_RECEIVE_GIFT_ALL,
    { type: type },
    {
      gate: false,
      onError: function () {
        threw = true;
      },
    },
  );
  if (threw) {
    log.warn('receive %s gift error.', label, null);
    return false;
  }
  if (ret.ok) {
    lastClaimAt[type] = Date.now();
    log.info('receive %s gift ok. wasPending=%d', label, pending);
    return true;
  }
  log.info('receive %s gift rejected. code=%d', label, ret.code);
  return false;
}

/**
 * 领取 1 箱联盟珍藏礼物（1178，载荷 {}）。永不 reject；返回是否领取成功。
 * 与 claimType 同一闸门风格：isSending 防重 + 单 key 'big' 的最小间隔闸门（防零点风暴把 1178 高频打出去被限流）；
 * 被拒/出错不记闸门，下轮照常重试。
 * 结果单一出口在此打日志：成功 info（带上原 AlGiftList 长度）、被拒 warn（带 code）
 * @returns {Promise<boolean>} 是否领取成功
 */
async function claimBig() {
  if (net.isSending(CMD_RECEIVE_GIFT_BIG)) {
    return false;
  }
  if (Date.now() - (lastClaimAt[GIFT_KEY_BIG] || 0) < cfg.busyInterval) {
    log.debug('skip big claim: min-interval gate.');
    return false;
  }
  var pending = (getAlGiftList() || []).length;
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_RECEIVE_GIFT_BIG,
    {},
    {
      gate: false,
      onError: function () {
        threw = true;
      },
    },
  );
  if (threw) {
    log.warn('receive big gift error.', null);
    return false;
  }
  if (ret.ok) {
    lastClaimAt[GIFT_KEY_BIG] = Date.now();
    log.info('receive big gift ok. wasPending=%d', pending);
    return true;
  }
  log.info('receive big gift rejected. code=%d', ret.code);
  return false;
}

// ─────────────────────────── 生命周期 ───────────────────────────

/**
 * 安装：取网络底座 + 数据中心。任一依赖缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) {
    return true;
  }

  var missing = [];

  net = ctx.net;
  if (!net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  var mods = game.requireAll(['DataCenter']);

  data = (mods.DataCenter && mods.DataCenter.DATA) || missing.push('DataCenter');

  if (missing.length) {
    net = null;
    data = null;
    log.warn('install failed. missing=%s', missing.join(';'));
    return false;
  }

  installed = true;
  log.info('installed.');

  return true;
}

/**
 * 运行：复位闸门，挂 10442 唤醒，立即查一次（之后由推送 / 两档定时驱动）。
 * reactor pause 会自动摘除此处登记的触发器并置 alive=false，定时器自然停摆；resume 重新点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  claiming = false;
  lastCheckAt = 0;
  timerMode = null;
  lastClaimAt = Object.create(null);
  ctx.on.push(CMD_PUSH_ALLIANCE_GIFT_INFO, onGiftInfoPush);
  log.info('started, listening push=%d.', CMD_PUSH_ALLIANCE_GIFT_INFO);
  // 启动即查一次；本轮结束后 tick 末尾按 busy/idle 武装下一轮
  schedule(0, 'busy');
}

/**
 * 向 reactor 注册本功能说明书：纯协议领取，不声明 scenes / offInCombat（全场景 + 战斗态都继续跑）。
 */
reactor.register({
  id: 'allianceGift',
  kinds: ['homeland'],
  label: '联盟礼物',
  storageKey: 'pocketcc.feat.allianceGift',
  symbols: ['dataCenter'],
  // 面板仅出启用开关；普通/稀有领取开关与 busy/idle 间隔均为上方 cfg 的内置常量，不作为可持久化配置项。
  defaults: {
    enabled: false,
  },
  fields: [],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
