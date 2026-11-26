/**
 * 快捷攻击 · 出征自动切城皮（feat 私有模块，单消费者）
 *
 * 原理链（实证）：城皮装备后把加成挂到 SKIN 表 equip_buff → 联盟 buff（报文里 10056 PUSH_ALLIANCE_BUFF
 * 的 960012 值随皮肤在 153↔158 之间跳）→ core/acl/battle-preset.js 的 getMaxCoutByPos 用它算「每格出征上限」
 * → Battle().plan().preset(n).adjust().build() 的实时重算值随之膨胀。服务器按「发出时刻的上限」收兵、
 * 按「到达时刻的皮肤 buff」结算，故一波里要穿两次皮：
 *   A 预切（发 902 前穿「出征皮」，让重算器吃到高上限）→ B 出征 → C 在途回切（902 一回包立刻穿「主战皮」，
 *   部队到达时身上是主战 buff）→ D 开始返程（按面板「待机皮肤」归位；待机=主战皮时这里是零发包 no-op）。
 * 三连只有波1 是满编预设（有效战力），波2/波3 是 minimal 陪次数：不切皮、不入在途账本。
 * 每波恒 ≤2 发 855，只是落在 A 还是 D（待机=出征皮时 A 变 no-op、D 才发）。
 *
 * 报文实证 dashcam 20261126T011550-城皮切换（uid 14179309129759）：
 *   - 855 USE_CASTLE_FACE req {skinId, special:0} → resp {ret:0}；RT 49/50/56/61/65/71/128ms（7 样本，中位 61）；
 *   - 与 855 应答同毫秒到达两条推送：10905 PUSH_CASTLE_FACE_CHANGE（{useId,useSpecial,list[],effectiveSkinIds}，
 *     游戏 UserData.UpdateMyCastleFace 由此回写 UsingCastleFace/MyCastleFace——**不依赖游戏 UI 回调**，
 *     我们直发包也能拿到落地判据）、10056 PUSH_ALLIANCE_BUFF（buff 值换新皮肤后即时变化）；
 *   - 854 GET_MY_CASTLE_FACE req {} → 同 10905 形状，RT 40–50ms（本模块不发包，清单走 gameData.castleFaces()）；
 *   - resp 902 带 marchInfo.{marchId,state,marchArrive,returnArriveTime}（相位 C 用它登记在途账本）。
 *   - 游戏源码实证（references/游戏逆向/extracted/Script/CastleSkinChangeView）：客户端自己按 DataConfig 133310
 *     做「同皮肤切换 CD」（lastChangeTime + cd > ServerTime 则弹 changeskin006）；该 CD 值本地无表可查，
 *     录制里两次切换间隔 19.8s 均 ret:0（无法证伪更短间隔）。本模块刻意**不因 CD 猜测定时不切**：
 *     只留 MIN_SEND_GAP_MS（逐目标皮）兜同皮重发，被拒一律 info 一行后照常出征（切皮失败绝不影响打人与回切时机）。
 *
 * 只服务快捷攻击自身的 902（8 类面板场景共用一条 attackFlow）。跨 feat 复用（自动打野/奉旨出征）时
 * 再按分层纪律把本文件下沉 core/city-skin.js——现在只有一个消费者，不下沉。
 *
 * 真机对拍补的硬约束（报文实证 dashcam 20261126T025211 / 031109 / 034023 / 035440-城皮切换，uid 14179309129759）：
 *   - **相位 D 的账本主键是 `March.id`（字符串）**：10019 边沿事件交给订阅者的不是线上报文，而是
 *     `core/march.js` 的 `decode()` 产出（主键已归一成 `id`，`marchId` 只在 `m.raw` 里）；marchId 超 2^53，
 *     全链路只能按字符串比。读 `mm.marchId` 的写法不报错、也不销账——相位 D 整场静默失效。
 *   - **服务器把 855 换皮计入 902 的 `march_time_control_info001`（“操作过快”）全局节奏**：
 *     五场 15 样本按结果分隔干净（全为 855→902 对）——距上一发被受理的 855 **≤1.863s 的全拒**（58/62/1062/1373/1569/1570/1820/1863ms），
 *     **≥2.012s 的全过**（2012/2541/2555/2557/2579/2583ms）⇒ 阈值落在 (1.863, 2.012]，调用方定档 2000；
 *     902→902 无干净可分样本（满编波的两次 902 之间总夹着一发 C 相 855），按同一条时钟同档处理。节奏是**全局一条时钟**，不分 A/C/D 哪一相位发的 855，
 *     故本模块记下「上一发真上线的 855」时刻由 `msSinceLastSkinSend()` 供调用方定拍（每一发 902 上线前都要凑，含限流退避后的重发）。
 *   - **10019 的 state 迁移是 1→3→4，返程(3) 比到家(4) 早 6–15s**（两场 9 条行军实测）：state=3 的 push 与
 *     `marchInfo.marchArrive`/`returnStartTime` 同刻（本地收包时钟与 epoch 有 ~3.5s 固定偏移），所以「服务器按到达时刻
 *     的皮肤结算」在切待机皮之前已经做完 —— 相位 D 挂在 3 上不抢结算，只把归位提前这 6–15s。
 */
import { sleep, CODE_NOT_SENT } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData as realGameData } from '../../../core/game-api.js';
import { Battle as RealBattle } from '../../../core/battle.js';
import { march as realMarch } from '../../../core/march.js';

/** @type {number} RequestId.USE_CASTLE_FACE：切换本人城外观（写动作，本模块唯一的切皮发包口） */
export const CMD_USE_CASTLE_FACE = 855;
/** @type {number} RequestId.GET_MY_CASTLE_FACE：拉本人城外观清单（本模块只读参考，实际清单走 UserData 快照） */
export const CMD_GET_MY_CASTLE_FACE = 854;

/**
 * 相位标识（planSwaps 的决策入参）：
 * pre=A 出征前预切、post=C 在途回切、home=D 待机归位（触发时机是部队开始返程，见 arm()）。B（出征）无切皮决策，故不列。
 * @type {{pre:string, post:string, home:string}}
 */
export const PHASE = { pre: 'pre', post: 'post', home: 'home' };

/**
 * 「待机皮肤」面板选项值（D 相位归位目标）：1=主战皮肤（默认，攻击间隙防御 buff 最强）、
 * 2=出征皮肤（省掉每次攻击的 A 相位预切，代价是攻击间隙防御 buff 弱一档）。
 * @type {{BATTLE:number, MARCH:number}}
 */
export const IDLE_MODE = { BATTLE: 1, MARCH: 2 };

/** @type {number} 面板「未选择」哨兵：任一皮肤为它时整条切皮链路短路（行为与未启用逐字节一致） */
export const SKIN_UNSET = -1;

/**
 * 编排层回传的 reason 名（唯一比对用常量）：调用方靠它定日志等级、本模块靠它判「切皮链是否在场」，
 * 故不在两边重复写字面量。「已真发过包」= SWITCH / REJECTED，「零发包 no-op」= ALREADY。
 * @type {{ALREADY:string, SWITCH:string, REJECTED:string}}
 */
export const REASON = {
  ALREADY: 'already-on-target',
  SWITCH: 'switched',
  REJECTED: 'send-rejected',
};

/**
 * @type {number} **同一张目标皮**的最小发包间隔（ms）：无服务器 CD 证据下兜「同拍重发同一皮」，命中即 NOT_SENT 不阻塞出征。
 * 口径细分（2026-11-26 接线时发现）：节流按「目标皮」记账而不是全局一个时刻——A→C 是两张不同皮、中间只隔一个
 * 902 往返（常见 <250ms），全局闸会把**安全关键的在途回切**静默吞掉（部队带着出征皮 buff 到达，防御弱一档）。
 * 反正每发 855 都 await 过应答，异皮连发的天然间隔 ≥ 一个 RT（实测 49-128ms）。
 */
const MIN_SEND_GAP_MS = 250;
/** @type {number} 855 应答后轮询 usingCastleFace 落地最多等多久（ms） */
const SKIN_SETTLE_MS = 500;
/** @type {number} 落地轮询步长（ms）；同时用作 A 相位兵数轮询的步长 */
const SETTLE_STEP_MS = 50;
/** @type {number} A 相位「兵数是否真的膨胀」轮询预算（ms）——主证据，超过即按未落地继续出征 */
const LOAD_POLL_MS = 400;
/** @type {number} 在途账本看门狗硬上限（ms）：10019 漏推也要收尾 D 相位，防账本永挂 */
const PENDING_WATCHDOG_MS = 15 * 60 * 1000;

/** @type {object} 日志器（tag 与 feat 同源，便于按 QUICK_ATTACK 过滤整场） */
const log = createLog('QUICK_ATTACK');

/**
 * 在途账本：March.id（字符串形态，Int64 精度纪律）→ {skinId, since}。
 * 只有满编预设波（波1）入账；集合清空才执行相位 D（三连并发时的收尾归位点）。
 * @type {Map<string, {skinId:number, since:number}>}
 */
var pending = new Map();
/** @type {Function|null} march.onStateChange 退订句柄（run 挂、pause 摘，防 resume 后重复注册） */
var offMarch = null;
/** @type {number} 相位 D 看门狗托管句柄（ctx.setTimeout 产物；-1=未挂） */
var watchdogId = -1;
/** @type {object|null} 最近一次 arm 注入的宿主面（net/cfg/ctx/alive）；disarm 置 null */
var host = null;
/**
 * 逐「目标皮」的上一发 855 本地时刻（ms）：只有朝同一张皮重发才受 MIN_SEND_GAP_MS 约束（缺键=从未向该皮发过）。
 * @type {Map<number, number>}
 */
var lastSendAtBySkin = new Map();
/**
 * 上一发**真上线**的 855 墙钟时刻（ms）；0 = 本场从未发过。A/C/D/revert 四个出口都写这里：
 * 服务器的行军节奏是全局一条时钟，不区分是哪一相位切的皮。
 * @type {number}
 */
var lastSkinSendAt = 0;

/**
 * 面板 cfg → 运行时切皮配置（buildModuleCfg 与 configure 热更共用，幂等：已归一的形态直接回读）。
 * 面板键：skinSwapEnabled / swapSkinMarch / swapSkinBattle / swapIdleMode；缺键回落「未选择 + 关闭」。
 * 刻意**不读面板的 enabled**（那是快捷攻击总开关，与切皮子开关两个维度）。
 * @param {object} [c] 面板 cfg 或已归一的 skinSwap 区段
 * @returns {{enabled:boolean, marchSkin:number, battleSkin:number, idleMode:number}}
 */
export function normalizeSkinSwapCfg(c) {
  c = c || {};
  var flat = c.marchSkin == null && c.battleSkin == null; // 非归一形态 = 面板键
  var idle = Number(flat ? c.swapIdleMode : c.idleMode) || IDLE_MODE.BATTLE;
  return {
    enabled: flat ? !!c.skinSwapEnabled : !!c.enabled,
    marchSkin: numSkin(flat ? c.swapSkinMarch : c.marchSkin),
    battleSkin: numSkin(flat ? c.swapSkinBattle : c.battleSkin),
    idleMode: idle === IDLE_MODE.MARCH ? IDLE_MODE.MARCH : IDLE_MODE.BATTLE,
  };
}

/**
 * 皮肤 id 归一：非数字/缺省一律回哨兵 SKIN_UNSET（0 是合法值=默认城皮，不能当「未配置」）。
 * @param {*} v 面板取值
 * @returns {number} skinId 或 SKIN_UNSET
 */
function numSkin(v) {
  var n = Number(v);
  return isFinite(n) ? n | 0 : SKIN_UNSET;
}

/**
 * 有效城皮 skinId 清单（同步、零发包；面板 options 与切皮前置校验同一口径）。
 * 取不到读数（符号漂移/未就绪）返回 null = 「无从判定」→ 只降级为不校验所有权，绝不拦切皮。
 * @returns {number[]|null}
 */
export function ownedSkinIds(gameData) {
  var faces = (gameData || realGameData).castleFaces();
  if (!faces || !faces.length) return null;
  return faces.map(function (f) {
    return f.skinId;
  });
}

/**
 * 切皮决策纯函数（无 IO、无时间、无发包）：给定配置、当前穿戴皮、相位、本波是否满编，
 * 回答「这一拍该不该发 855、发到哪张皮、为什么」。<br>
 * 短路顺序（先判贵的、后判便宜的）：开关 → 满编 → 皮肤有效性 → 目标皮 → 已在目标皮。
 * @param {{enabled:boolean, marchSkin:number, battleSkin:number, idleMode:number}} cfg 切皮配置
 * @param {number|null} currentSkin 当前穿戴皮（gameData.usingCastleFace()；null=读不到）
 * @param {string} phase PHASE.* 相位
 * @param {boolean} full 本波是否满编预设波（三连只有波1 是）
 * @param {number[]|null} [owned] 有效城皮清单；null=无从判定（不校验所有权）
 * @returns {{send:boolean, targetSkin:number, reason:string}} reason 直接进日志，每个不发的出口都有名字
 */
export function planSwaps(cfg, currentSkin, phase, full, owned) {
  var c = cfg || {};
  var skip = function (reason) {
    return { send: false, targetSkin: SKIN_UNSET, reason: reason };
  };
  if (!c.enabled) return skip('disabled');
  if (!full) return skip('not-full-wave');
  var marchSkin = numSkin(c.marchSkin);
  var battleSkin = numSkin(c.battleSkin);
  if (marchSkin === SKIN_UNSET || battleSkin === SKIN_UNSET) return skip('skin-unset');
  if (marchSkin === battleSkin) return skip('same-skin');
  if (phase !== PHASE.pre && phase !== PHASE.post && phase !== PHASE.home)
    return skip('unknown-phase');
  if (owned && owned.indexOf(marchSkin) < 0) return skip('march-skin-not-owned');
  if (owned && owned.indexOf(battleSkin) < 0) return skip('battle-skin-not-owned');

  var target =
    phase === PHASE.pre
      ? marchSkin
      : phase === PHASE.post
        ? battleSkin
        : numSkin(c.idleMode) === IDLE_MODE.MARCH
          ? marchSkin
          : battleSkin;
  // 已在目标皮：零发包 no-op（待机=出征皮时 A 相位落到这里，D 相位才发）
  if (currentSkin != null && Number(currentSkin) === target)
    return { send: false, targetSkin: target, reason: REASON.ALREADY };
  return { send: true, targetSkin: target, reason: 'switch' };
}

/**
 * 切换城外观到 skinId（唯一发 855 的口子）。永不 reject：闸门命中/异常一律回落 ok:false。
 * 四步：① 已在目标皮 → skipped 零发包；② 同一目标皮重发未过最小间隔/855 在途 → NOT_SENT（不阻塞出征）；
 * ③ sendGuarded 发包，ret.ok=false 交调用方 info（含服务器拒绝码）；
 * ④ 应答后轮询 usingCastleFace() 至多 SKIN_SETTLE_MS（sleep 传 signal 可被 pause 早醒）；
 *   `settle:false` 只做应答后那一次复读（零额外等待）——给相位 C 用：回切越早越好，不值得为遥测卡住三连下一波。
 * @param {number} skinId 目标城皮
 * @param {object} opts 依赖面（单测注入假件）
 * @param {object} opts.net pocketcc.net 底座（ctx.net）
 * @param {AbortSignal|null} [opts.signal] reactor ctx.signal（pause 早醒）
 * @param {object} [opts.gameData] 读数替身（默认真 gameData）
 * @param {number} [opts.gapMs] 最小发包间隔覆盖（测试用）
 * @param {number} [opts.settleMs] 落地轮询预算覆盖
 * @param {number} [opts.stepMs] 轮询步长覆盖
 * @param {boolean} [opts.settle] 传 false 则不轮询（应答后只复读一次）
 * @param {function():number} [opts.now] 时钟替身
 * @returns {Promise<{ok:boolean, landed:boolean, code:number, rtMs:number, skipped:boolean}>}
 */
export async function ensureSkin(skinId, opts) {
  opts = opts || {};
  var gd = opts.gameData || realGameData;
  var now = opts.now || Date.now;
  var gap = opts.gapMs != null ? opts.gapMs : MIN_SEND_GAP_MS;
  var step = opts.stepMs != null ? opts.stepMs : SETTLE_STEP_MS;
  var budget = opts.settleMs != null ? opts.settleMs : SKIN_SETTLE_MS;
  var want = skinId | 0;
  // 防御：哨兵/负数不发包（调用方的哨兵闸在 planSwaps，这里兜「直接拿面板原值调」的误用）
  if (want < 0) return { ok: false, landed: false, code: CODE_NOT_SENT, rtMs: 0, skipped: false };

  var cur = numSkin(gd.usingCastleFace());
  if (cur === want) return { ok: true, landed: true, code: 0, rtMs: 0, skipped: true };
  // 只卡「朝同一张皮重发」：A 切出征皮后紧接着 C 切回主战皮是两件事，不能被同一个闸门吞掉后一个
  if (now() - (lastSendAtBySkin.get(want) || 0) < gap) {
    return { ok: false, landed: false, code: CODE_NOT_SENT, rtMs: 0, skipped: false };
  }
  var n = opts.net;
  if (
    !n ||
    typeof n.sendGuarded !== 'function' ||
    (n.isSending && n.isSending(CMD_USE_CASTLE_FACE))
  ) {
    return { ok: false, landed: false, code: CODE_NOT_SENT, rtMs: 0, skipped: false };
  }

  var t0 = now();
  lastSendAtBySkin.set(want, t0);
  lastSkinSendAt = Date.now();
  var ret = await n.sendGuarded(
    CMD_USE_CASTLE_FACE,
    { skinId: want, special: 0 },
    {
      onError: function (err) {
        log.warn('855 send threw. skin=%d', want, err);
      },
    },
  );
  var rtMs = now() - t0;
  if (!ret || !ret.ok) {
    return {
      ok: false,
      landed: false,
      code: ret ? ret.code : CODE_NOT_SENT,
      rtMs: rtMs,
      skipped: false,
    };
  }
  // 落地判据：10905 PUSH_CASTLE_FACE_CHANGE 与 855 应答同毫秒到（报文实证），故多数情况首轮即命中
  var settle = opts.settle !== false;
  var landed = false;
  var waited = 0;
  for (;;) {
    if (numSkin(gd.usingCastleFace()) === want) {
      landed = true;
      break;
    }
    if (!settle || waited >= budget) break;
    if (opts.signal && opts.signal.aborted) break;
    await sleep(step, opts.signal);
    waited += step;
  }
  return { ok: true, landed: landed, code: 0, rtMs: rtMs, skipped: false };
}

/**
 * 本波兵数探针（切换是否真的生效的**主证据**）：满编预设走一遍实时重算，取 armyNum 合计。
 * 纯内存调用官方重算器（battlePreset.recalc 只改写自建副本，不写存档、不发包、不触游戏数据）。
 * @param {number} presetIndex 预设队伍号（1 起，同 attackFlow 的 step.index）
 * @param {object} [opts] {Battle?:Function, gameData?:object}
 * @returns {number|null} 兵数合计；重算链抛错/不可得返回 null（调用方按「无从判定」降级）
 */
export function probeMarchLoad(presetIndex, opts) {
  opts = opts || {};
  var BattleCtor = opts.Battle || RealBattle;
  try {
    var d = new BattleCtor().plan().preset(presetIndex).adjust().build();
    return loadOf(d);
  } catch (err) {
    log.debug('load probe unavailable. preset=%d', presetIndex, err);
    return null;
  }
}

/**
 * 本拍决策是否属于「切皮链在场」：真要发包，或已在目标皮（零发包 but 相位 D 仍需归位）。
 * disabled / not-full-wave / skin-unset / same-skin / not-owned 一律视为链不在场（零回归短路）。
 * @param {{send:boolean, reason:string}} plan planSwaps 产物
 * @returns {boolean}
 */
function chainActive(plan) {
  return plan.send || plan.reason === REASON.ALREADY;
}

/**
 * MarchData → 兵数合计（含补位 extraArmy）。导出供 attackFlow 在日志里带「本波实发兵数」。
 * @param {object} d MarchPlan.build() 产物
 * @returns {number}
 */
export function loadOf(d) {
  var s = 0;
  ((d && d.armyListNew) || []).forEach(function (a) {
    s += a && a.armyNum ? a.armyNum | 0 : 0;
  });
  var ex = d && d.extraArmy;
  if (ex && ex.armyNum) s += ex.armyNum | 0;
  return s;
}

/**
 * 相位决策（含所有权校验）。两段式：先只按配置判一次——未启用/非满编/未选皮时**不碰 castleFaces()**
 * （零回归路径上一个包、一次遍历都不该发生）；判到「真要发」才取有效清单再校一次。
 * @param {string} phase PHASE.*
 * @param {object} o 调用方 opts（含 cfg；owned 注入时跳过内部取数）
 * @param {object} gd 读数面
 * @param {boolean} full 本波是否满编
 * @returns {{send:boolean, targetSkin:number, reason:string}}
 */
function decide(phase, o, gd, full) {
  var cur = gd.usingCastleFace();
  var plan = planSwaps(o.cfg, cur, phase, full, null);
  if (!plan.send) return plan;
  var owned = o.owned !== undefined ? o.owned : ownedSkinIds(gd);
  if (!owned) return plan; // 清单取不到 = 无从判定，只降级不校验，绝不拦切皮
  return planSwaps(o.cfg, cur, phase, full, owned);
}

/**
 * 相位 A 编排：探基线兵数 → 切出征皮 → 轮询兵数是否膨胀。
 * 任何一步失败都只回报文事实，**调用方一律照常出征**（切皮不成不能变成不打）。
 * @param {object} ctxA {cfg, net, signal, presetIndex, gameData?, Battle?, now?, stepMs?, loadBudgetMs?, owned?}
 * @returns {Promise<{skipped:boolean, reason:string, base:number|null, load:number|null, landed:boolean, code:number, rtMs:number}>}
 */
export async function preMarchSwap(ctxA) {
  var o = ctxA || {};
  var gd = o.gameData || realGameData;
  var plan = decide(PHASE.pre, o, gd, true);
  if (!plan.send) {
    return {
      skipped: true,
      reason: plan.reason,
      base: null,
      load: null,
      landed: false,
      code: 0,
      rtMs: 0,
    };
  }
  var base = probeMarchLoad(o.presetIndex, o);
  var r = await ensureSkin(plan.targetSkin, o);
  if (!r.ok || r.skipped) {
    return {
      skipped: false,
      reason: r.skipped ? REASON.ALREADY : REASON.REJECTED,
      base: base,
      load: null,
      landed: !!r.landed,
      code: r.code,
      rtMs: r.rtMs,
    };
  }
  // 主证据：兵数是否真的涨（buff 落地有毫秒级延迟，轮询到 LOAD_POLL_MS 为止）
  var load = base == null ? null : probeMarchLoad(o.presetIndex, o);
  var deadline = o.loadBudgetMs != null ? o.loadBudgetMs : LOAD_POLL_MS;
  var step = o.stepMs != null ? o.stepMs : SETTLE_STEP_MS;
  var waited = 0;
  while (base != null && load != null && load <= base && waited < deadline) {
    if (o.signal && o.signal.aborted) break;
    await sleep(step, o.signal);
    waited += step;
    load = probeMarchLoad(o.presetIndex, o);
  }
  return {
    skipped: false,
    reason: REASON.SWITCH,
    base: base,
    load: load,
    landed: base != null && load != null ? load > base : r.landed,
    code: r.code,
    rtMs: r.rtMs,
  };
}

/**
 * 相位 C 编排：902 成功回包后立刻切回主战皮，并把该行军登记进在途账本（等波次开始返程做相位 D）。
 * 只等 855 应答 + 一次落地复读（settle:false，零额外等待）——回程路上还有几十秒，回切越早越稳，
 * 不该为一行日志卡住三连的下一波。被拒不重试。
 * @param {object} ctxC {cfg, net, signal, marchId, gameData?, owned?}
 * @returns {Promise<{reason:string, code:number, rtMs:number, landed:boolean, tracked:boolean}>}
 */
export async function afterMarchSwap(ctxC) {
  var o = ctxC || {};
  var gd = o.gameData || realGameData;
  var plan = decide(PHASE.post, o, gd, true);
  var out = { reason: plan.reason, code: 0, rtMs: 0, landed: false, tracked: false };
  // 切皮链未启用/皮肤未选/波次非满编 → 整条短路（含不入账），行为与现网零回归
  if (!chainActive(plan)) return out;
  if (plan.send) {
    var r = await ensureSkin(plan.targetSkin, Object.assign({ settle: false }, o));
    out.code = r.code;
    out.rtMs = r.rtMs;
    out.landed = r.landed;
    out.reason = r.skipped ? REASON.ALREADY : r.ok ? REASON.SWITCH : REASON.REJECTED;
    if (!r.ok) log.info('855 back-swap failed. code=%d;rt=%dms', r.code, r.rtMs);
  }
  // 账本按「波1 已发出」记，与回切是否成功无关：相位 D 的待机皮归位必须发生
  if (trackMarch(o.marchId, plan.targetSkin)) out.tracked = true;
  return out;
}

/**
 * 登记一条在途行军（满编波 902 成功后的 marchId）。空 id 忽略（应答畸形不记账，防账本永挂）。
 * @param {string|number|null} marchId 902 应答 marchInfo.marchId
 * @param {number} [skinId] 本次切换的目标皮（仅日志用）
 * @returns {boolean} 是否入账
 */
export function trackMarch(marchId, skinId) {
  var id = marchId == null ? '' : String(marchId);
  if (!id) return false;
  pending.set(id, { skinId: skinId != null ? skinId | 0 : SKIN_UNSET, since: Date.now() });
  armWatchdog();
  return true;
}

/** @returns {number} 在途账本条数（run 自愈判据与测试用） */
export function pendingCount() {
  return pending.size;
}

/**
 * 看门狗：账本非空时兜一条 15 分钟硬上限，10019 漏推也能收尾相位 D（托管定时器，pause 自动清）。
 * 每次入账重挂同一条即可（回调里按当时账本再判）。
 */
function armWatchdog() {
  if (!host || !host.ctx || typeof host.ctx.setTimeout !== 'function') return;
  if (watchdogId >= 0) host.ctx.clearTimeout(watchdogId);
  watchdogId = host.ctx.setTimeout(function () {
    watchdogId = -1;
    if (!pending.size) return;
    log.info('skin swap watchdog fired, ledger not empty. pending=%d', pending.size);
    finishPending();
  }, PENDING_WATCHDOG_MS);
}

/**
 * 按待机档归位（相位 D 与「本波没打出去」两条入口共用）。
 * 账本非空 = 还有自己的满编波在途等它返程归位，此处绝不抢先（否则会抢在部队打到目标前把皮换掉）。
 * @param {object} o 依赖面 {cfg, net, signal?, gameData?, owned?}
 * @returns {Promise<{send:boolean, reason:string, code:number, rtMs:number, landed:boolean}>}
 */
export async function restoreIdleSkin(o) {
  var oc = o || {};
  var out = { send: false, reason: 'pending-in-flight', code: 0, rtMs: 0, landed: false };
  if (pending.size) return out;
  var gd = oc.gameData || realGameData;
  var plan = decide(PHASE.home, oc, gd, true);
  out.reason = plan.reason;
  if (!plan.send) return out;
  out.send = true;
  var r = await ensureSkin(plan.targetSkin, Object.assign({ settle: false }, oc));
  out.code = r.code;
  out.rtMs = r.rtMs;
  out.landed = r.landed;
  out.reason = r.skipped ? REASON.ALREADY : r.ok ? REASON.SWITCH : REASON.REJECTED;
  return out;
}

/** 账本清空 → 按待机模式归位（planSwaps 在「待机=主战皮且已在主战皮」时直接判 skip，零发包） */
function finishPending() {
  pending.clear();
  var h = host;
  if (!h || !h.cfg || (h.alive && !h.alive())) return;
  restoreIdleSkin({
    cfg: h.cfg(),
    net: h.net,
    signal: h.ctx ? h.ctx.signal : null,
    gameData: h.gameData,
  }).then(
    function (r) {
      if (!r.send) {
        log.debug('idle restore no-op. reason=%s', r.reason);
        return;
      }
      log.info(
        'idle skin restored. ok=%s;landed=%s;code=%d;rt=%dms;reason=%s',
        r.reason === REASON.REJECTED ? false : true,
        r.landed,
        r.code,
        r.rtMs,
        r.reason,
      );
    },
    function (err) {
      log.warn('idle skin restore threw.', err);
    },
  );
}

/**
 * 10019 行军边沿（返程/到家） → 在途账本主键。
 * **主键是 `m.id`**：`core/march.js` 的 `decode()` 把 `marchInfo.marchId` 归一成 `id`（字符串，报文实证
 * dashcam 20261126T025211-城皮切换：902 resp 与 10019 push 的 marchId 同为 `"4946043221380850741"` 字符串，
 * 超 2^53，只能按字符串比），线上原字段只留在 `m.raw` 里。读 `m.marchId` 恒 undefined = 相位 D 永不触发。
 * @param {object} m decode() 产出的 March
 * @returns {string} 账本键；'' = 无从判定
 */
function ledgerId(m) {
  if (!m) return '';
  if (m.id != null && m.id !== '') return String(m.id);
  var raw = m.raw && (m.raw.marchInfo || m.raw);
  return raw && raw.marchId != null ? String(raw.marchId) : '';
}

/**
 * 挂载相位 D 收尾链路（reactor run 调，可重入：先摘旧订阅再挂，防 resume 后重复注册）。
 * @param {object} h 宿主面
 * @param {object} h.net pocketcc.net 底座
 * @param {function():object} h.cfg 当前切皮配置取值器（热更即时生效）
 * @param {object} h.ctx reactor 上下文（托管定时器 + signal）
 * @param {function():boolean} [h.alive] 激活判定
 * @param {object} [h.gameData] 读数替身（测试）
 * @param {object} [h.march] 行军底座替身（测试；需 onStateChange 与 State）
 */
export function arm(h) {
  host = h || null;
  if (offMarch) {
    offMarch();
    offMarch = null;
  }
  var m = (h && h.march) || realMarch;
  if (!m || typeof m.onStateChange !== 'function') {
    log.warn('march.onStateChange unavailable, idle restore disabled');
    return;
  }
  // 状态值只从行军底座的 State 取（本模块不写死 NMarchState 数值）；取不到就明说并放弃，
  // 绝不默默挂一条永不命中的订阅（那就是相位 D 整场静默失效）。
  var st = m.State;
  if (!st || st.RETURNING == null) {
    log.warn('march.State.RETURNING unavailable, idle restore disabled');
    return;
  }
  offMarch = m.onStateChange(function (mm) {
    if (!mm) return;
    // 触发点 = 开始返程(state 3)：报文实证它比到家(state 4) 早 6–15s，且此时服务器已按到达时刻的皮肤结算完。
    // 到家边沿只作返程漏推时的兜底：两条边沿走同一段销账，先到先得（销完另一条命中「不在账本」直接回）。
    if (mm.state !== st.RETURNING && mm.state !== st.ARRIVED_HOME) return;
    if (!host || (host.alive && !host.alive())) return;
    var id = ledgerId(mm);
    if (!id) {
      log.warn('10019 march edge without usable id, idle restore skipped. state=%s', mm.state);
      return;
    }
    if (!pending.has(id)) {
      // 账本空时别人的行军返程/到家属常态噪声，不占日志；账本里还挂着却对不上号才是真异常
      if (pending.size)
        log.debug(
          'march edge not in ledger. id=%s;state=%d;pending=%d',
          id,
          mm.state,
          pending.size,
        );
      return;
    }
    pending.delete(id);
    if (pending.size) return;
    if (watchdogId >= 0 && host.ctx && host.ctx.clearTimeout) host.ctx.clearTimeout(watchdogId);
    watchdogId = -1;
    finishPending();
  });
}

/**
 * 摘挂载（reactor pause 调）：退订 + 清账本 + 清看门狗句柄引用（托管定时器本身由 reactor 清）。
 */
export function disarm() {
  if (offMarch) {
    offMarch();
    offMarch = null;
  }
  if (host && host.ctx && watchdogId >= 0) host.ctx.clearTimeout(watchdogId);
  watchdogId = -1;
  pending.clear();
  host = null;
}

/**
 * run 期自愈一次：刷新页面时恰好停在出征皮（上局切完就掉线），待机型=主战则切回主战皮。
 * 账本非空说明还有自己的波次在途，交给相位 D，不抢切。
 * @param {object} h 同 arm 的宿主面
 * @returns {Promise<void>}
 */
export async function selfHeal(h) {
  if (!h || !h.cfg || (h.alive && !h.alive())) return;
  var c = h.cfg();
  if (!c || !c.enabled || !c.marchSkin || c.marchSkin === SKIN_UNSET) return;
  if (pending.size) return;
  var gd = h.gameData || realGameData;
  var cur = numSkin(gd.usingCastleFace());
  if (cur !== c.marchSkin) return;
  if (c.idleMode === IDLE_MODE.MARCH) return; // 待机本就是出征皮，不该自愈
  var plan = planSwaps(c, cur, PHASE.home, true, ownedSkinIds(gd));
  if (!plan.send) return;
  var r = await ensureSkin(plan.targetSkin, {
    net: h.net,
    signal: h.ctx ? h.ctx.signal : null,
    gameData: gd,
  });
  log.info(
    'stale march skin healed at start. skin=%d;ok=%s;landed=%s;code=%d;rt=%dms',
    plan.targetSkin,
    r.ok,
    r.landed,
    r.code,
    r.rtMs,
  );
}

/**
 * 距「我们上一发真上线的 855」过了多少毫秒（墙钟）。从未发过返回 Infinity ——
 * 调用方据此零等待：未启用/未选皮的场次一个 855 都不发，也就一拍都不等。
 * 刻意用 `Date.now` 而不是 ensureSkin 的 `now` 替身：这是给发 902 定节奏的真实时间，不是被测时长。
 * @returns {number} 毫秒或 Infinity
 */
export function msSinceLastSkinSend() {
  return lastSkinSendAt ? Date.now() - lastSkinSendAt : Infinity;
}

/**
 * 复位本地发包节流（测试用；运行期无需调用——节流窗口只有 250ms，且只作同皮重发兜底）。
 * 连同「上一发 855」的节奏时刻一起清，免得测试段间互串。
 */
export function resetThrottle() {
  lastSendAtBySkin.clear();
  lastSkinSendAt = 0;
}
