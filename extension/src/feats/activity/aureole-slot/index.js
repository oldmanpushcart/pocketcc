/**
 * 摇摇机-自动抽取他人的世界机器（reactor 说明书形态）
 *
 * 玩法：这类「摇摇机」不是一个独立活动，而是活动挂在大世界里的一台台**限时机器**（三轴老虎机皮）。
 *   某个指挥官在自己活动里攒够进度 → 机器落到他附近的地块（存活数小时）→ **同分组**的其他指挥官
 *   可以免费抽一次（按钮文案 `102373=免费` / `101106=已领取`，无消耗、不派兵、不占行军名额）。
 *   本 feat 只做这条「拉世界列表 → 逐台免费抽」链路。
 *
 * 两套皮共用同一份游戏面板代码（AureoleWorldSlotMachinePanel / AureoleSlotListPanel 及其 item），
 *   故一个 feat 覆盖两个 showUiType（号段镜像见 constants.js 的 SLOT_FAMILIES）：
 *     情报摇摇机 `ActAureole`（好运冲刺，type=339）  —— 抽取 9628 / 世界列表 9630
 *     宝藏幸运机 `ActivityExcavate`（印石挖掘支路）  —— 抽取 2507 / 世界列表 2509
 *   目录名取 aureole-slot 是按**代码同源实体**命名（两套皮都走这批类），不是按活动命名。
 *
 * 三条协议（实录报文逐键：dashcam rec 14179309129759 / dashcam-rec-20261127T001318-城皮自动切换）：
 *   9630（孪生 2509）HAPPY_GO_GET_WORLD_LIST  req {activityId}
 *     resp {worldList:[{instanceIdStr, expireTimeMilli:Int64(毫秒), triggerUser:{uid,playerInfo,serverId,frameId}, x, y}]}
 *     实录条目 instanceIdStr="1"、expireTimeMilli {_low:435005007,_high:418} = 1795731334735 毫秒。
 *     注意 uid 在 **triggerUser.uid** 下（两套竞品脚本都读条目顶层 L.uid，等于「不打自己」从未生效）。
 *   9628（孪生 2507）HAPPY_GO_BUILDING_DRAW   req {activityId, instanceIdStr} → resp {resultId, reward{items:[{itemId,itemCount}],…}}
 *     实录 resultId=8 → 稀有技能宝箱 2540002 ×1；**resultId>0 即抽中**，无后续领奖请求（奖励直接到账）。
 *   10912 PUSH_ONE_ACTIVITYEXTRA  push {aid, extra}（实录顶层键即此二键）
 *     extra 关键位：worldUIRed / worldRed（世界页红点，抽前 1 → 抽完同一台后同时归 0）、
 *     buildDrawNumMap（{"1":1}，instanceId→我在这台上已抽次数，服务端权威）、
 *     buildDrawNumToday（今日已抽次数，实录抽前 0 → 抽后 1）。
 *
 * 参数与上限（源码锚点）：
 *   每台上限 `cap = (showUiType===ActivityExcavate ? para6 : type_para1).split('|').map(Number)[2] || 1`
 *     （AureoleWorldSlotMachinePanel.refreshDrawBtnState 逐字）⇒ 摇摇机读 type_para1[2]、幸运机读 para6[2]，
 *     这是两套皮唯一的非对称点，已收进 SLOT_FAMILIES.capField。
 *   实录 type_para1="21600|999|1|1|260113080"：[0]=21600 机器存活秒数（expire−创建 = 21585s 印证）、
 *     [2]=1 每台上限、[4]=260113080 发现者大奖。[1]/[3] 语义未证实，不接线。
 *   幸运机支路的开关是 **activity.para6 是否非空**（NWorldUIActBtnSetting.onClickExcavate：有 para6 开
 *     AureoleSlotListPanel=摇摇机，没有则开 ExcavateBuildListPanel=传说宝藏，那是另一族、需派兵）。
 *   每日上限：l10n 有 castle_halo_activity_001「已达每日情报摇摇机抽取上限」/ newwajue_007 同义条，
 *     但客户端代码零引用（只有 002 每台上限）⇒ 判为服务端硬闸，靠红点归 0 + 拒绝码当日拉黑兜住，
 *     **不建本地日计数器、不给面板编分母**。
 *   跨分组 castle_halo_activity_015 / newwajue_009：世界列表只下发本组，不做本地校验，被拒即拉黑。
 *   自己的机器：游戏列表照常显示自己的机器（selfBgNode）且面板不禁用 ⇒ 默认不剔除，被拒走拒绝码拉黑。
 *
 * 调度（A 模式单层调和循环，同重装母舰口径但去掉行军消费段）：
 *   三个触发源汇入 cycle.kick：① 推送 10912（按 aid 反查 showUiType ∈ SLOT_FAMILIES，再验 extra.worldUIRed>=1）；
 *   ② run() 启动即主动扫一次；③ 兜底定时（active/idle 两档，连续 EMPTY_STREAK_IDLE 次空扫降频）防漏推。
 *   **不订阅 10019**：本 feat 零行军，到家补扫无意义。
 *   生产 doScan：找活动（两套皮同期开启则在同一轮内串行各扫一次，不并发）→ 红点闸 → 拉世界列表
 *     → pickDrawables 过滤排序 → 整批替换 queue。
 *   消费 consume（cycleRun 后半段）：逐条 shift → 抽一条 → 每条间 sleep(drawInterval) 防服务器限流。
 *
 * 去重三保险：服务端权威 extra.buildDrawNumMap（按台）+ 本地 drawn（发出即成功计入，补红点/extra 的落地延迟）
 *   + 本地 rejected（被拒即当日拉黑，防逐拍重发同一台被拒刷屏）。影子键一律用 **showUiType#instanceIdStr@expireSec**
 *   复合键：录制全场只有一台（instanceIdStr="1"），无法证实该号全局唯一、是否会被下一台机器复用；两套皮的
 *   instanceId 也各自独立计数，加前缀可彻底避免互相屏蔽。
 *
 * 刻意不做：不领自己机器的大奖（9629 / 2508）、不做活动本体的抽奖与进度奖励（9632/9627/9623）、
 *   不拉点赞面板（9625/2511）、不做聊天分享（sendChatLinkActCommon2）。
 *   同族但本次不做的还有「胜利冲刺·世界训练场」（9885-9890，另一个纯点击 + 每日 20 次的同型玩法，
 *   缺 9888/9889 逐键实录）；雪原列车的 MMTrainSlotNode 只共用三轴滚轮组件、无世界机器列表层。
 *
 * 未实证项与兜底纪律（备查）：
 *   instanceIdStr 唯一性：全场录制只有一台（"1"），无法证实该号过期后是否被下一台复用 → 一律用复合键规避。
 *   每日上限：l10n 有 castle_halo_activity_001「已达每日情报摇摇机抽取上限」但客户端零引用（只有 002 每台上限）
 *     ⇒ 判为服务端硬闸，靠红点归 0 + 拒绝码当日拉黑兜住，不建本地日计数器、不给状态行编分母。
 *   跨分组（castle_halo_activity_015 / newwajue_009）：世界列表只下发本组，不做本地校验，被拒即拉黑。
 *   自己的机器能否抽：游戏列表照常显示（selfBgNode）且面板不禁用 → 默认不剔除，被拒走拒绝码拉黑。
 *   type_para1[1]=999 / [3]=1 语义未证实 → 不接线。
 *   **宝藏幸运机（ActivityExcavate）侧目前零实录**，只有源码与文案键推导：para6 只确证 [2]=cap、[4]=奖励预览 id，
 *     其余按与 type_para1 对称推定，世界列表 resp 字段名沿用摇摇机形态。兜底：该路所有拒绝一律 rejectText 打日志
 *     + 复合键当日拉黑、不重试；实录到位后收敛只碰 constants.js 的 SLOT_FAMILIES 一行（注册表 usages 已登记）。
 *
 * 当日次数口径（定稿）：面板单行「今日 N 次」，分子优先读服务器权威 **extra.buildDrawNumToday**
 *   （含手动抽取，实录抽前 0 → 抽后 1），两套皮同期开启时各读各自活动的 extra 求和；该字段读不到时
 *   回落本地日账（core/daily-stats，按 showUiType 分键）兜冷启动窗口；两者皆无显示 '—'，不拿 0 冒充进度。
 *   无分母形态经 dailyText 产出（同假面舞会/每日补给口径）。
 *
 * 生命周期由 reactor 托管：install/run 两个钩子，places 门控限定 base/world，战斗模式强制下线。
 *   drawn/rejected 不随 run 清空（「每台只能抽 cap 次」是当日硬约束，清空会让 resume 后重复撞同一台被拒刷屏）。
 */
import { CODE_NOT_SENT, sleep, rejectText } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { game } from '../../../core/game.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { createCycle } from '../../../core/cycle.js';
import { createDailyLedger, dailyText } from '../../../core/daily-stats.js';

import { SLOT_FAMILIES, CMD_PUSH_ONE_ACTIVITY_EXTRA } from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=AUREOLE-SLOT） */
const log = createLog('AUREOLE-SLOT');

/**
 * @type {number} 过期安全余量（秒）：距过期不足这个量就不抽——列表快照与发抽取之间总有延迟，
 *   踩在过期线上发出去只会撞回「机器已消失」，白吃一条拒绝。
 */
const SAFE_REMAIN_SEC = 60;

/** @type {number} 连续这么多次扫描都没有可抽机器，才把间隔从 active 降到 idle（去抖：单次漏扫不立即降频） */
const EMPTY_STREAK_IDLE = 2;

/**
 * 可预期的业务拒绝（撞上限 / 不在分组）：走 info + 当日拉黑；其余未知码走 warn。
 * 匹配的是服务器拒绝文案键（net 已把 header.d 归一到 ret.reason），也兜住 l10n 已翻译的中文串。
 * castle_halo_activity_001/002 = 每日/该台上限，015 = 不在分组；newwajue_007/008/009 是孪生皮同义条。
 */
const EXPECTED_REJECT_RE = /castle_halo_activity_0(01|02|15)|newwajue_00(7|8|9)|上限|分组/;

/** @type {import('../../../core/daily-stats.js').DailyLedger} 当日抽取日账（按 showUiType 分键，同复合键去重） */
const drawLedger = createDailyLedger('pocketcc.daily.aureoleSlot');

/**
 * 内置调优常量（面板仅出启用开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {
  /** 活跃扫描间隔：默认 1 分钟。本轮扫到可抽机器时用这档，勤扫趁机器未过期多抽 */
  activeScanInterval: 1000 * 60,

  /**
   * 空转扫描间隔：默认 10 分钟。连续 EMPTY_STREAK_IDLE 次空扫后降到这档，少刷世界列表。
   * 推送 10912 仍是主触发源，新机器一落地即被推醒，不必等这档定时
   */
  idleScanInterval: 1000 * 60 * 10,

  /** 抽取间隔：默认 3 秒（消费逐条之间的休眠）。同 cmd 连发过快会被服务器限流 */
  drawInterval: 1000 * 3,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} 活动控制器（活动列表、开启判定、aid 反查） */
var activityCtl;

/** @type {object|null} reactor 上下文；alive() 反映运行态，pause 后置否让定时器与在飞流程自然退出 */
var ctxRef = null;

/** @type {object[]} 本轮扫出的可抽机器（[{fam,activity,item}]），consume 逐条 shift */
var queue = [];
/** @type {number} 连续空扫计数：抽到机器即清零，达到 EMPTY_STREAK_IDLE 转 idle 间隔 */
var emptyStreak = 0;
/** @type {Set<string>} 本地影子「已抽中」的复合键：extra.buildDrawNumMap 落地有延迟，这段窗口靠它挡重复抽 */
var drawn = new Set();
/** @type {Set<string>} 被服务器拒过的复合键：当日不再重抽（同一目标重发只会逐拍刷屏，且原因不会自己变好） */
var rejected = new Set();

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * Int64 → number。expireTimeMilli 运行时是游戏 Int64 实例（报文序列化后是 {_low,_high}），
 * 优先用游戏自带的 toNumber()，回落高低位无符号拼装（实证 {_high:418,_low:435005007} = 1795731334735 毫秒）。
 * 不可解析一律回 0（调用方按「无到期信息」处理，不因为读不懂就误判过期）。
 * @param {*} v Int64 实例 / {_low,_high} / 数字 / 数字串
 * @returns {number}
 */
function int64ToNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v === 'object') {
    if (typeof v.toNumber === 'function') {
      try {
        return Number(v.toNumber()) || 0;
      } catch (e) {
        /* 落到高低位拼装 */
      }
    }
    var hi = Number(v._high != null ? v._high : v.high);
    var lo = Number(v._low != null ? v._low : v.low);
    if (isFinite(hi) && isFinite(lo)) return (hi >>> 0) * 4294967296 + (lo >>> 0);
    return 0;
  }
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

/**
 * 每台上限（源码逐字复刻：`(活动字段.split('|').map(Number))[2] || 1`）。
 * 取哪个活动字段由 fam.capField 决定（摇摇机 type_para1、幸运机 para6）。
 * 字段缺失/畸形一律回 1（游戏原式如此：宁可少抽一轮也不放开上限）。
 * @param {object} activity 活动对象
 * @param {object} fam 皮描述符
 * @returns {number}
 */
export function slotCap(activity, fam) {
  var raw = activity ? activity[fam.capField] : null;
  var parts = String(raw == null ? '' : raw)
    .split('|')
    .map(function (s) {
      return Number(s);
    });
  return parts[2] || 1;
}

/**
 * 影子集复合键：`showUiType#instanceIdStr@expireSec`。
 * 加 showUiType 前缀（两套皮的 instanceId 各自独立计数，不能互相屏蔽）+ expire 后缀
 * （录制只见到 instanceIdStr="1"，无法证实该号在一台机器过期后被下一台复用还是继续递增，
 *   复合键让「新一台」与「旧的那台」天然不同键，彻底规避误屏蔽）。
 * @param {object} fam 皮描述符
 * @param {string|number} instanceIdStr 机器实例号
 * @param {number} expireAtMs 过期时刻（毫秒）
 * @returns {string}
 */
export function drawKey(fam, instanceIdStr, expireAtMs) {
  return fam.showUiType + '#' + String(instanceIdStr) + '@' + Math.floor(expireAtMs / 1000);
}

/**
 * 逐台过滤 + 排序（纯函数，不摸全局，供单测直接喂实录条目）：
 *   每台剩余次数 > 0（cap − extra.buildDrawNumMap[instanceIdStr]）
 *   → 未过期且留 SAFE_REMAIN_SEC 余量（expireTimeMilli 读不出=0 时不因此剔除）
 *   → 不在影子集（已抽中 / 曾被拒）。
 * 排序照抄游戏列表口径（AureoleSlotListPanel.reqWorldList 按 remainNum 降序）并把「快过期」提为次键升序，
 *   使同余量的机器先抽即将消失的那台。
 * @param {object} activity 活动对象（读 extra.buildDrawNumMap）
 * @param {object} fam 皮描述符
 * @param {object[]} list 世界列表应答的 worldList
 * @param {number} nowSec 服务器秒
 * @param {{isBlocked: function(string):boolean}} [shadow] 影子集查询口
 * @returns {Array<{instanceIdStr: string, remain: number, expireAt: number, key: string}>}
 */
export function pickDrawables(activity, fam, list, nowSec, shadow) {
  var cap = slotCap(activity, fam);
  var usedMap = ((activity && activity.extra) || {}).buildDrawNumMap || {};
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var it = list[i];
    if (!it || it.instanceIdStr == null) continue;
    var id = String(it.instanceIdStr);
    var remain = cap - (Number(usedMap[id]) || 0);
    if (remain <= 0) continue;
    var expireAt = int64ToNumber(it.expireTimeMilli);
    if (expireAt > 0 && expireAt / 1000 <= nowSec + SAFE_REMAIN_SEC) continue;
    var key = drawKey(fam, id, expireAt);
    if (shadow && shadow.isBlocked(key)) continue;
    out.push({ instanceIdStr: id, remain: remain, expireAt: expireAt, key: key });
  }
  out.sort(function (a, b) {
    return a.remain !== b.remain ? b.remain - a.remain : a.expireAt - b.expireAt;
  });
  return out;
}

/**
 * 今日已抽次数（面板状态行的分子，纯函数）：逐皮取「服务器 extra.buildDrawNumToday 优先，
 * 本地日账兜底」，求和。一个皮都定不出数值时回 null（面板显 '—'，不拿 0 冒充进度）。
 * @param {Array<{fam: object, activity: object}>} targets findSlotActivities() 的结果
 * @param {import('../../../core/daily-stats.js').DailyLedger} [ledger] 本地日账
 * @returns {number|null}
 */
export function slotTodayCount(targets, ledger) {
  var seen = false;
  var sum = 0;
  for (var i = 0; i < (targets || []).length; i++) {
    var extra = (targets[i].activity && targets[i].activity.extra) || {};
    var auth = extra.buildDrawNumToday;
    if (auth != null && isFinite(Number(auth))) {
      seen = true;
      sum += Number(auth) || 0;
      continue;
    }
    if (ledger && ledger.loaded()) {
      seen = true;
      sum += ledger.get(targets[i].fam.showUiType) || 0;
    }
  }
  return seen ? sum : null;
}

/**
 * 红点闸（纯函数）：extra 上的世界页红点是否亮 —— 决定这一轮要不要去拉世界列表。
 * 排在世界列表请求之前：服务端把「本组无机器 / 每台都已抽 / 撞到每日上限」三者归一为红点归 0，
 *   此时拉全量列表纯属浪费（且客户端读不出细分，故面板也不据此编结论）。
 * @param {object} [extra] 活动 extra
 * @returns {boolean}
 */
export function slotRedDotOpen(extra) {
  var e = extra || {};
  return Number(e.worldUIRed) > 0 || Number(e.worldRed) > 0;
}

/**
 * 皮 ↔ 活动实例入选判定（纯函数，把「同 showUiType」与「支路开关」两条闸门收在一处）：
 * - showUiType 必须命中该皮；
 * - openFn（= activityCtl.checkActivityIsOpen 的包装）必须回 true —— 限时活动已结束还发列表只会被拒；
 *   传 null 表示不校验开启（单测只验支路开关时用）；
 * - fam.requireField 缺位/空串 = 本期活动没挂摇摇机支路（印石挖掘无 para6 时挂的是传说宝藏），整条不入选。
 * @param {object} fam 皮描述符
 * @param {object} [activity] 活动对象
 * @param {function(number):boolean} [openFn] 活动开启判定
 * @returns {boolean}
 */
export function isSlotActivity(fam, activity, openFn) {
  if (!fam || !activity || activity.showUiType !== fam.showUiType) return false;
  if (openFn && openFn(activity.id) !== true) return false;
  if (fam.requireField && !activity[fam.requireField]) return false;
  return true;
}

/**
 * 当前开启且挂有摇摇机支路的活动（按皮 × 按活动实例展开，同期两套皮会得到两条）。
 * @returns {Array<{fam: object, activity: object}>}
 */
function findSlotActivities() {
  var out = [];
  var list = (activityCtl && activityCtl.getActivityList()) || [];
  var openFn =
    activityCtl && activityCtl.checkActivityIsOpen
      ? activityCtl.checkActivityIsOpen.bind(activityCtl)
      : null;
  for (var i = 0; i < SLOT_FAMILIES.length; i++) {
    var fam = SLOT_FAMILIES[i];
    for (var j = 0; j < list.length; j++) {
      var a = list[j];
      if (!isSlotActivity(fam, a, openFn)) continue;
      out.push({ fam: fam, activity: a });
    }
  }
  return out;
}

/**
 * 单轮调和主体（core/cycle 承载单飞闸门 + 触发合并 + 绝不停摆）：生产 doScan → 消费 consume → 返回下拍间隔。
 * 决策仍归本 feat：在飞期间攒下触发（cycle.pending）优先立即补扫，否则按 emptyStreak 选 active/idle 两档。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  await doScan();
  if (!aliveFn()) return 0; // pause 中途：consume 不再进入，cycle 在 alive 检查处自然停摆
  await consume();
  if (cycle.pending) return 0;
  return nextScanInterval();
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取 active 档，防异常停摆） */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.activeScanInterval,
});

/**
 * 生产端：找活动 → 逐皮扫一轮 → 整批替换 queue。永不 reject。
 * 两套皮同期开启时在同一轮内**串行**各扫一次（共用一个 queue，不并发，避免同一拍双份世界列表）。
 * @returns {Promise<void>}
 */
async function doScan() {
  try {
    var targets = findSlotActivities();
    if (!targets.length) {
      log.debug('no slot activity open.');
      queue = [];
      emptyStreak++;
      return;
    }
    var next = [];
    for (var i = 0; i < targets.length; i++) {
      var got = await scanFamily(targets[i].fam, targets[i].activity);
      next = next.concat(got);
    }
    if (!aliveFn()) return;
    queue = next;
    if (next.length) emptyStreak = 0;
    else emptyStreak++;
  } catch (err) {
    log.warn('scan error.', err);
    queue = [];
    emptyStreak++;
  }
}

/** @type {{isBlocked: function(string):boolean}} 默认影子集查询口（drawn/rejected 只增不重建，故可常驻） */
const defaultShadow = {
  isBlocked: function (key) {
    return drawn.has(key) || rejected.has(key);
  },
};

/**
 * 扫一套皮：红点闸 → 在途闸 → 拉世界列表 → pickDrawables。永不 reject，任一步不满足都回空数组。
 * host 为注入位（同 cq26/wl-mine 的 `net` 注入口径）：生产调用不传，单测喂假 net 断言红点闸真的短路、
 *   以及孪生皮的 cap 取哪个字段。
 * @param {object} fam 皮描述符
 * @param {object} activity 活动对象
 * @param {{net?: object, nowSec?: number, shadow?: {isBlocked: function(string):boolean}, alive?: function():boolean}} [host] 缺省取模块全局
 * @returns {Promise<object[]>} 归一化候选（[{instanceIdStr,remain,expireAt,key}]）
 */
export async function scanFamily(fam, activity, host) {
  host = host || {};
  var n = host.net || net;
  var alive = host.alive || aliveFn;
  var shadow = host.shadow || defaultShadow;
  var nowSec = host.nowSec == null ? gameData.serverTime() | 0 : host.nowSec;
  if (!slotRedDotOpen(activity.extra)) {
    log.debug('%s red dot off, skip list request. aid=%d', fam.label, activity.id);
    return [];
  }
  // 在途闸门（游戏面板也在拉同一 cmd）：不静默断链，本轮跳过，由下拍兜底定时补
  if (n.isSending(fam.worldListCmd)) {
    log.debug('%s world list %d in flight, skip.', fam.label, fam.worldListCmd);
    return [];
  }
  var ret = await n.sendPBV2(fam.worldListCmd, { activityId: activity.id });
  if (!alive()) return [];
  if (!ret.ok || !ret.data) {
    log.info(
      '%s world list rejected. aid=%d;cmd=%d;code=%d;data=%s',
      fam.label,
      activity.id,
      fam.worldListCmd,
      ret.code,
      rejectText(ret),
    );
    return [];
  }
  var list = ret.data.worldList || [];
  var picked = pickDrawables(activity, fam, list, nowSec, shadow);
  log.debug('%s scanned. raw=%d;pickable=%d', fam.label, list.length, picked.length);
  return picked.map(function (item) {
    return { fam: fam, activity: activity, item: item };
  });
}

/**
 * 消费端（作为 cycleRun 一轮的后半段）：串行抽队列，每条之间休眠 drawInterval（队列空则不空等）。
 * @returns {Promise<void>}
 */
async function consume() {
  while (queue.length && aliveFn()) {
    var task = queue.shift();
    try {
      await drawOne(task);
    } catch (err) {
      log.warn('draw flow threw.', err);
    }
    if (queue.length && aliveFn()) {
      await sleep(cfg.drawInterval, ctxRef && ctxRef.signal);
    }
  }
}

/**
 * 下一轮兜底扫描间隔：连续空扫达到 EMPTY_STREAK_IDLE 次 → idle 长间隔（降频空转），否则 active 短间隔。
 * 扫到可抽机器会把 emptyStreak 清零（doScan），从而回到 active 档
 * @returns {number} 毫秒
 */
function nextScanInterval() {
  return emptyStreak >= EMPTY_STREAK_IDLE ? cfg.idleScanInterval : cfg.activeScanInterval;
}

/**
 * 单条抽取：发 fam.drawCmd {activityId, instanceIdStr} → 按 resultId 记账，按拒绝码分级日志。永不 reject。
 * 日志单一出口在这里，一次抽取只打一条（成功 info、可预期拒绝 info、未知码 warn、未发出 debug）。
 * @param {object} task {fam, activity, item}
 * @returns {Promise<void>}
 */
async function drawOne(task) {
  var fam = task.fam;
  var item = task.item;
  if (net.isSending(fam.drawCmd)) {
    log.debug('%s draw %s in flight, skip.', fam.label, item.instanceIdStr);
    return;
  }
  var ret = await net.sendPBV2(fam.drawCmd, {
    activityId: task.activity.id,
    instanceIdStr: item.instanceIdStr,
  });
  if (!aliveFn()) return;

  if (ret.ok && ret.data && Number(ret.data.resultId) > 0) {
    drawn.add(item.key);
    drawLedger.countOnce(item.key, fam.showUiType);
    log.info(
      '%s drew. instance=%s;resultId=%d;items=%s',
      fam.label,
      item.instanceIdStr,
      Number(ret.data.resultId),
      rewardBrief(ret.data.reward),
    );
    return;
  }

  // 未真正发出（同 cmd 在途/异常）：不拉黑，下轮自愈
  if (ret.code === CODE_NOT_SENT) {
    log.debug('%s draw not sent. instance=%s', fam.label, item.instanceIdStr);
    return;
  }

  // 可预期业务拒绝（撞每台上限 / 每日上限 / 不在分组 / 机器已消失）：当日拉黑，同一目标重发不会自己变好
  rejected.add(item.key);
  var text = rejectText(ret);
  if (EXPECTED_REJECT_RE.test(text)) {
    log.info(
      '%s draw refused. instance=%s;code=%d;data=%s',
      fam.label,
      item.instanceIdStr,
      ret.code,
      text,
    );
    return;
  }
  log.warn(
    '%s draw rejected with unknown code. instance=%s;code=%d;data=%s',
    fam.label,
    item.instanceIdStr,
    ret.code,
    text,
  );
}

/**
 * 奖励摘要（只取 itemId × itemCount，不打印 Int64 原对象、不把整个 reward 塞进日志）
 * @param {object} reward 应答里的 reward
 * @returns {string}
 */
function rewardBrief(reward) {
  var items = (reward && reward.items) || [];
  if (!items.length) return '-';
  return items
    .map(function (it) {
      return (it && it.itemId) + 'x' + (it && it.itemCount);
    })
    .join(',');
}

/**
 * 10912 推送入口：aid 反查到某套皮、且 extra.worldUIRed >= 1（确认世界有可抽机器）才触发扫描。
 * 10912 任何活动的 extra 更新都会推它，故必先按 aid 认皮。listener 本身永不 throw。
 * @param {object} ev net.on 事件 {cmd, data:{aid, extra}}
 */
function onActivityExtraPush(ev) {
  if (!aliveFn()) return;
  var data = ev && ev.data;
  var aid = data && data.aid;
  if (!aid) return;
  var activity = activityCtl.getActivityByActivityId(aid);
  if (!activity) return;
  var fam = null;
  for (var i = 0; i < SLOT_FAMILIES.length; i++) {
    if (SLOT_FAMILIES[i].showUiType === activity.showUiType) {
      fam = SLOT_FAMILIES[i];
      break;
    }
  }
  if (!fam) return;
  var extra = data.extra;
  if (!extra || !(extra.worldUIRed >= 1)) return;
  log.info('%s extra push with red dot, trigger scan. aid=%d', fam.label, aid);
  cycle.kick();
}

/**
 * 安装：取网络底座 + 活动控制器。任一依赖缺失即失败（reactor 不会激活）。
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

  var mods = game.requireAll(['ActivityController']);

  activityCtl =
    (mods.ActivityController &&
      mods.ActivityController.ActivityController &&
      mods.ActivityController.ActivityController.Instance) ||
    missing.push('ActivityController');

  if (missing.length) {
    net = null;
    activityCtl = null;
    log.warn('install failed. missing=%d;deps=%s', missing.length, missing.join(';'));
    return false;
  }

  installed = true;
  log.info('installed.');

  return true;
}

/**
 * 运行：复位调度状态，挂 10912 监听，主动扫一次（之后由推送 / 兜底定时驱动）。
 * reactor pause 置 alive=false 后定时器自然停摆；resume 重新复位点火（cycle.kick 内部先清旧定时器，不会重复）。
 * drawn/rejected 不在此清空：「每台只能抽 cap 次」是当日硬约束，清空会让 resume 后重复撞同一台被拒刷屏。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  emptyStreak = 0;
  queue = [];
  drawLedger.ensureLoaded();
  ctx.on.push(CMD_PUSH_ONE_ACTIVITY_EXTRA, onActivityExtraPush);
  log.info('started, listening push cmd=%d.', CMD_PUSH_ONE_ACTIVITY_EXTRA);
  // 启动即主动查一次；本轮结束后 cycle 会武装兜底定时
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap），战斗模式强制下线；
 * 面板仅出启用开关 + 一行只读当日抽取数（inlineStatus），扫描/抽取间隔均为 cfg 内置常量
 */
reactor.register({
  id: 'aureoleSlot',
  label: '摇摇机',
  storageKey: 'pocketcc.feat.aureoleSlot',
  symbols: ['activityController', 'dataCenter?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 面板可用性：两套皮都严格未开启才整卡置灰（null=控制器未就绪无从判定，按可用放行，不误灰）
  available: function () {
    var allClosed = SLOT_FAMILIES.every(function (fam) {
      return gameData.activityIsOpen('showUiType', fam.showUiType) === false;
    });
    return allClosed ? { ok: false, reason: '摇摇机活动未开启' } : true;
  },
  offInCombat: true,
  // 无可调参数：抽取免费、不派兵、不占行军名额、无可配阈值 —— 与海上夺宝/重装母舰同档，只出开关 + 内联状态
  defaults: { enabled: false },
  fields: [
    {
      key: '_drawInfo',
      type: 'text',
      label: '今日',
      hint: '含情报摇摇机、宝藏幸运机两种皮肤活动',
      // inlineStatus 取的就是第一条 type:'text'，此行必须留在 fields 首位
      get: function () {
        var n = slotTodayCount(findSlotActivities(), drawLedger);
        return n == null ? '—' : dailyText(n);
      },
    },
  ],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
