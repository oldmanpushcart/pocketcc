/**
 * CQ26 印石·开荒融冰（cq26IceShake）= 自动融冰（2103）+ 开荒摇一摇（2129）合并独立 feat
 *
 * 两条腿合为一个玩法（用户拍板：从巨兽盛宴拆出融冰，与开荒摇一摇合并，挂「基础设置」组）：
 *   ① 融冰腿（主动，cycle 驱动）：BWL 巨兽盛宴 GATHER（集结）期，点冰封地块发 2103（消耗火种），
 *     level 升序先便宜；冰缓存空则每拍一扇定向 901 探针（窗心=bwlPos+轮转偏移）。原 feast.js legMelt 迁来。
 *   ② 摇一摇腿（被动，应答驱动）：融冰弹出的小游戏立刻按最高档提交 2129（详见下）。
 *   两腿同文件：融冰发的 2103 应答既走 melt 结算（删冰格/计数），又经订阅触发摇一摇（同一份应答，inHand 去重）。
 *
 * 玩法：荒芜冰原/巨熊盛宴开荒时点冰封地块融冰（点火），**部分点**不直接给奖励，而是弹一个
 * 「旋转指针 + 三段温度区」的小游戏（源码 `CQ26WLRemoveIceView`）：指针在 ±85° 间以 0.6s/趟来回扫，
 * 玩家须在 10s 倒计时内点「发送火焰」，停在哪一段就领哪一档（低温/中温/**高温**），高温档给得最多。
 * 真人要盯着指针择机，本 feat 把这一眼省掉：**看到 miniGameId 就立刻按最高档提交**，不等指针、
 * 不看倒计时，出网载荷与"亲手摇到最满"的那一次逐键同形。
 *
 * 协议清单（报文实证：本场 rec 11981629951662 / dashcam-rec-20261112T011559…-1794417359392 的
 *   6 发 2117 + 4 发 2129，以及四场「印石-我的日常」实录汇总的 53 发 2129）：
 *   2117 SERIES_FROST_NWL_FIRE   req `{wastelandIndex, x, y}`
 *     resp `{isOk:1, miniGameId:Int64}` ← 触发小游戏（**本 feat 的唯一入口**）
 *     resp `{isOk:1, rewardResult}`     ← 普通点直接给奖，与小游戏无关
 *   2103 SERIES_FROST_BWL_FIRE   req `{x, y}`（源码 `CQ26WasteLandData.meltIce` 按
 *     `specIndex===0` 分叉到盛宴线）；resp 两支与 2117 同形 ⇒ 两路都订
 *   2129 SERIES_FROST_NWL_FIRE_MINI_GAME  req `{id:Int64(=miniGameId), index:0|1|2}`
 *     resp `{rewardResult:{resource(实录恒全 0), items:[{itemId,itemCount}]}}`
 *   实录里真人从拿到 miniGameId 到 2129 出网隔了 2~4s（盯着指针找时机），本 feat 收到即发。
 *
 * index ↔ 档位（源码 `CQ26WLRemoveIceView` 两段逐字对回）：
 *   指针归一位置 `t=(rotation+85)/170 ∈ [0,1]`，档位 =
 *     `t < rate[0] ? 0 : t < rate[0]+rate[1] ? 2 : 1`（onCLickSendFire）
 *   三段贴图按 **低温(low) → 高温(high) → 中温(medium)** 顺序铺在弧上（refreshShow，段宽比取
 *   dataConfig 52000358 `"A|B|C"` → `[C,A,B]/sum`）⇒ **0=低温、2=高温、1=中温**。
 *   档位奖励由服务器发（客户端无档位奖励表），实录佐证：53 发按 index 分组后 index=2 的
 *   `rewardResult.items` 恒 2~4 项（含 1700098/1988002），而 index=0 只有单项 ×2、index=1 单项 ×1~2
 *   ⇒ 2 就是最好的一档 ⇒ 恒发 TIER_HIGH，不做档位下拉。
 *
 * 闸门（按序短路，每个出口一条日志）：应答 `status===0`（融冰本身被拒时不带小游戏，无需代摇）
 *   → 载荷带**非零** miniGameId（直接给奖那一支在此短路）→ Int64 装箱往返自校验（读回必须与快照串
 *   逐字相等，否则**宁可不发**也不拿一个错 id 去撞服务器）→ 未过期（客户端 10s 倒计时留 1s 余量，
 *   与「发哪一档」一起做成纯函数 `planSubmit`，出网点唯一）→ `sendGuarded` 在途串行闸（等价游戏侧
 *   `checkRequestIdNoRes(2129)`），且**被在途闸挡下就不重投**（见下「收窗与不重投」）。
 *
 * 收窗与不重投（报文实证 dashcam rec 11981629951662 / dashcam-rec-20261112T021006…-1794420606597）：
 *   只「代发包」不够——游戏侧那扇 `CQ26WLRemoveIceView` 是被**我们发的包**结算的，它自己 `submitMiniGame`
 *   的回调没被触发，于是 `_submitting` 仍为 false、指针继续扫、10s 倒计时继续走；而面板注册项写着
 *   `clickBlankClose:false`（点空白关不掉），玩家只剩两个动作：干等倒计时自己收，或者顺手点一下「发送火焰」。
 *   实录里玩家点了：同一枚 id 的第二发 2129 在 +8.8s 出网，撞回 `header.s=3 / d=activity_120002`
 *   （字典表「activity_120002=参数错误」），而 `NetMgr` 对外层 `s===3` **无条件** `ShowTips(getNetMsgText(d))`
 *   ⇒ 奖励其实已按高温档到账（我们那一发同刻的 resp 带 `47007004×3 62909×2`），玩家脸上却挨一条「参数错误」。
 *   所以：**成功结算后复刻游戏原生那两步** —— 先 `ui.open('commonRewardPanel', {serverReward: 应答.rewardResult})`
 *   把奖励展示出来（用户明确要求「别把奖励点掉，我想看看获得了什么」；这就是该视图自己成功回调里的那一句，
 *   也是 BagPanel/QuestController/AllianceBehemothNet 等全仓通用的同一个调用），再走原生
 *   `ui.close('iceShakePopup')` 收掉摇一摇弹窗（与 capture.js 收投喂弹窗同源：只关窗、不改业务态；视图
 *   `cpnDisable` 里的 `showTimeoutLowestReward()` 在当前 bundle 是空函数，关掉无任何副作用）。
 *   这样既保住「要看到奖励」，又抹掉「还要点一下/会报错」的入口——奖励面板是玩家自己点掉的正常游戏 UI。
 *   OpenUI 白名单只放这一张展示型面板（`rewardOutPanel`，注册项 `hideMask:!0,cacheUI:!0`），不带任何业务动作。
 *   同理被在途闸挡下时**不重投**：那一发是玩家自己点的，多半已经成，重投只会再制造一条 s=3。
 *
 * 导出面：`readMiniGameId`/`tierText`/`planSubmit`/`shouldResubmit`/`rewardPanelArgs` + 协议号与档位常量供单测与 replay 对拍
 *   （`scripts/verify-manifests/cq26-ice-shake.mjs`）复用同一份字典，判据不另抄。
 *
 * 刻意不做：
 *   · 不主动发 2117（NWL 荒芜冰原线）融冰——那要 wastelandIndex 与另一套地块来源；本 feat 只主动融 BWL 线（2103），
 *     但**两线**弹出的小游戏都接（2117/2103 应答同形）；
 *   · 不做档位/难度可调参数（"摇到最高档"是唯一正确答案，同 wl-chest/excav 的「无可调参数」纪律）；
 *   · 融冰无额外可调旋钮（火种预算读背包实持、消耗表读配置，全不勾即全融），故归基础设置组只出开关+内联状态；
 *   · 不接 push 22076 SERIES_FROST_NWL_FIRE_MINI_GAME_REWARD（汇总 53 发结算全走 2129 应答，零出现）。
 */
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { gameData, gameConf, bits, worldMap, ui } from '../../core/game-api.js';
import { item } from '../../core/item.js';
import { createCycle } from '../../core/cycle.js';
import { fetchWindow } from '../../core/map.js';
import { CODE_NOT_SENT, rejectText, sleep, todayStr } from '../../core/util.js';
import { storage } from '../../core/storage.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-SHAKE');

// ── 常量 ──────────────────────────────────────────────────────────────
/** 功能 id（register / aliveFn / 日志共用一处字面量） */
const FEAT_ID = 'cq26IceShake';
/** SERIES_FROST_NWL_FIRE：荒芜冰原（NWL）融冰，resp 带 miniGameId 那一支是本 feat 的入口 */
const CMD_FIRE_NWL = 2117;
/** SERIES_FROST_BWL_FIRE：巨熊盛宴（BWL）融冰，游戏按 `specIndex===0` 分叉到这条，resp 同形 */
const CMD_FIRE_BWL = 2103;
/** SERIES_FROST_NWL_FIRE_MINI_GAME：唯一出网动作，载荷 `{id:Int64, index:档位}`（实录逐键） */
const CMD_MINI_GAME = 2129;
/** 档位号 → 展示名（弧序 低→高→中，判据见文件头「index ↔ 档位」） */
const TIER_LABELS = { 0: '低温档', 1: '中温档', 2: '高温档' };
/** 恒发的那一档：高温 = 实录 53 发里给得最多的一档 */
const TIER_HIGH = 2;
/** 客户端倒计时 10s（源码 `_countdownSeconds=10`），留 1s 余量：更老的条目当已过期，不再提交 */
const SUBMIT_EXPIRE_MS = 9000;
/** 抛错重试闸的上限（仅对「发送本身抛错」生效；被在途闸挡下的不重投，见 `shouldResubmit`） */
const MAX_TRIES = 2;
/** 抛错重试前的等待毫秒（让出可能挂在途中的那一发 2129） */
const RETRY_DELAY_MS = 300;

// ── 融冰腿常量（原 feast.js 迁来，判据同源）─────────────────────────────
/** SERIES_FROST_BWL_INFO：补读巨兽锚点 pos（只读，探针窗心用） */
const CMD_BWL_INFO = 2101;
/** GET_WORLD_INFO：iceList 真相的只读通道（定向探针） */
const CMD_WORLD_INFO = 901;
/** push 阶段机（CQ26BeastFeastPhase）：融冰只在 GATHER 期 */
const PUSH_PHASE = 22032;
/** push 地块增量（iceList，level=0 删格） */
const PUSH_TILE = 10018;
/** CQ26BeastFeastPhase.GATHER：融冰唯一窗口（用户拍板：比真人保守，FEED 期不融） */
const PHASE_GATHER = 1;
/** 配置：融冰逐等级火种消耗数组（'|' 全段，cq26WlConfList） */
const CFG_FIRE_COST = 52000359;
/** 配置：火种道具 id（实录 47007004，不硬编码） */
const CFG_FIRE_ITEM = 52000369;
/** 定向 901 窗宽（照抄游戏跳图那一发的实录 {width:18,height:30,viewLevel:0}） */
const PROBE_W = 18;
/** 定向 901 窗高 */
const PROBE_H = 30;
/** 定向 901 视口层级（0=最近·全量，iceList 行只在此层级稳定下发） */
const PROBE_VIEW_LEVEL = 0;
/** 融冰探针轮转偏移（窗心=bwlPos+偏移，逐拍覆盖巨兽周边九窗） */
const PROBE_OFFSETS = [
  [0, 0],
  [PROBE_W, 0],
  [-PROBE_W, 0],
  [0, PROBE_H],
  [0, -PROBE_H],
  [PROBE_W, PROBE_H],
  [-PROBE_W, -PROBE_H],
  [PROBE_W, -PROBE_H],
  [-PROBE_W, PROBE_H],
];
/** 冰缓存 TTL（毫秒）：过期条目不再当候选，靠探针/增量刷新 */
const ICE_TTL_MS = 5 * 60 * 1000;
/** 定向查询「窗里没找到冰」后的重试冷却（毫秒） */
const MISS_COOL_MS = 10 * 60 * 1000;
/** 同一目标连续被拒达此次数即当日拉黑 */
const MAX_REJECT = 3;
/** 单次被拒后的冷却毫秒 */
const REJECT_COOL_MS = 5 * 60 * 1000;
/** 2101 补读冷却（毫秒）：pos 未达时不逐拍重发 */
const BWL_INFO_COOL_MS = 60 * 1000;
/** 融冰腿择时档位：GATHER 窗仅 300s，~5s 一拍（push 唤醒兜底）；成功续发 1.5s；闲时 60s */
const meltCfg = { activeMs: 5000, chainMs: 1500, idleMs: 60000, fallback: 30000 };
/** 今日融冰计数落盘逻辑名（storage.data blob；date 命中今日才回读，换日清空，口径同 wl-beast 当日表） */
const DATA_NAME_MELT = 'cq26IceShake.melt';

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object|null} net 实例 */
var net = null;
/** @type {object|null} reactor 注入的上下文（取 signal 用：重试休眠 pause 早醒） */
var ctxRef = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {Array<{idStr:string, src:number, atMs:number, tries:number}>} 待提交的小游戏队列（串行出网） */
var queue = [];
/** @type {Set<string>} 已入队/在途的 miniGameId 十进制串（同一条只提交一次） */
var inHand = new Set();
/** @type {boolean} pump 是否在途（同刻只有一条 2129 出网） */
var pumping = false;
/** @type {boolean} 「Int64 装箱不可靠」warn 去重（恢复后复位） */
var boxDegradedWarned = false;

// ── 融冰腿模块态（原 feast.js 迁来）─────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入；本 feat 无可调参数，仅 enabled） */
var MCFG = { enabled: false };
/** @type {Object<string,{x:number,y:number,k:number,level:number,specIndex:number,initSid:number,atMs:number}>}
 *  冰缓存（键 x_y；只由 901 resp / 10018 的 iceList 写入，level=0 删格） */
var iceTiles = Object.create(null);
/** @type {{x:number,y:number,k:number}|null} 2101 pos 的同帧标量副本（投影不可用时的回落） */
var bwlPosSnap = null;
/** @type {number} 上次 2101 补读时刻（Date.now() 基准） */
var bwlInfoAt = 0;
/** @type {number} 融冰探针轮转偏移索引 */
var probeIdx = 0;
/** @type {boolean} 定向 901 在途（同刻至多一发） */
var probeInFlight = false;
/** @type {Object<string,number>} 探针窗心 → 上次「窗里没找到冰」时刻 */
var missAt = Object.create(null);
/** @type {object|null} 22032 feastPhase 的同帧标量副本 */
var phaseSnap = null;
/** @type {Object<string,number>} 目标键（i: 前缀）→ 连续被拒次数 */
var rejectCount = Object.create(null);
/** @type {Object<string,number>} 目标键 → 冷却到期时刻（Date.now() 基准） */
var coolUntil = Object.create(null);
/** @type {string} 上两表所属服务器日（换日清空，使「当日拉黑」真止于当日） */
var dayKey = '';
/** @type {boolean} 「融冰配置不可读」warn 去重 */
var fireCfgWarned = false;
/** @type {number} 今日成功融冰数（面板内联状态用；换日滚清 + 落盘跨重载，见 startLoadMelt/persistMelt） */
var meltedCount = 0;
/** @type {boolean} 今日融冰计数回读是否成功（false=写盘会整体覆盖，宁可跳过持久化） */
var meltLoadOk = false;
/** @type {Promise<void>|null} 回读 promise（persistMelt 前 wait，完成前禁写盘避免覆盖丢账） */
var meltLoadPromise = null;
/** @type {boolean} 本拍融冰是否成功出网（决定 chainMs 续发） */
var justActed = false;
/** @type {boolean} 本拍是否有候选/探针工作（决定 activeMs 档） */
var hadCandidate = false;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（安装期不发任何请求；运行期融冰腿会发只读 901/2101 探针）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  if (installed) return true;
  net = ctx.net;
  if (!net.install()) {
    net = null;
    log.warn('install failed. missing=net');
    return false;
  }
  // UI 面板符号无需预热：ui.open/close 每次调用都走 acl-engine 的 probe（只缓存成功、
  //   失败不入缓存且下一拍自愈重探），首次结算时才用也不会永久降级
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行：摇一摇腿订阅两路融冰应答；融冰腿订阅阶段机/地块增量/巨兽锚点 + 点火 cycle（退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  // 摇一摇腿：被动接 2117/2103 应答里的小游戏句柄
  ctx.on.resp(CMD_FIRE_NWL, onFireResp);
  ctx.on.resp(CMD_FIRE_BWL, onFireResp);
  // 融冰腿：从投影播种阶段/锚点基线，再订阅推送与游戏自己的 901 视口应答（零额外报文被动嗅探 iceList）
  var fp = gameData.cq26FeastPhase();
  if (fp) phaseSnap = fp;
  var pos = gameData.cq26BwlPos();
  if (pos) bwlPosSnap = pos;
  ctx.on.push(PUSH_PHASE, onPhasePush);
  ctx.on.push(PUSH_TILE, onTileInfo);
  ctx.on.resp(CMD_WORLD_INFO, onTileInfo);
  ctx.on.resp(CMD_BWL_INFO, onBwlInfoResp);
  log.info('started. tier=%s', TIER_LABELS[TIER_HIGH]);
  cycle.kick();
}

/**
 * 停用：丢掉待提交队列与融冰缓存。
 * resume 后不该拿陈 miniGameId 出网（客户端侧那条小游戏早已走完倒计时），
 *   在途那一发的结算由 aliveFn() 自守（见 settle），不记账也不重投；
 *   冰缓存/阶段/锚点一并丢，避免 resume 后拿陈旧快照发 2103。
 */
function pause() {
  queue = [];
  inHand.clear();
  iceTiles = Object.create(null);
  phaseSnap = null;
  bwlPosSnap = null;
  probeInFlight = false;
}

// ── 存活判定 ──────────────────────────────────────────────────────────
function aliveFn() {
  return reactor.isRunning(FEAT_ID);
}

// ── 应答入口 ──────────────────────────────────────────────────────────
/**
 * 2117 / 2103 应答：只有带非零 miniGameId 的那一支才是小游戏入口，其余（直接给奖、被拒）静默放过。
 * @param {object} ev net 应答事件 `{cmd,status,data}`
 */
function onFireResp(ev) {
  if (!aliveFn()) return;
  var idStr = readMiniGameId(ackBody(ev), Number(ev && ev.status));
  if (!idStr) return;
  if (inHand.has(idStr)) {
    log.debug('2129 skip: id already in hand. id=%s', idStr);
    return;
  }
  log.debug('%d mini game opened. id=%s', ev.cmd, idStr);
  queue.push({ idStr: idStr, src: Number(ev.cmd) || 0, atMs: Date.now(), tries: 1 });
  inHand.add(idStr);
  pump();
}

/**
 * PBV2 报文取业务体（应答/推送同形）：整包是 `{header,data}`，下钻一层；平铺载荷（901 应答/旧 JSON）原样回落。
 * @param {object} ev bus 事件（应答或推送）
 * @returns {object|null}
 */
function ackBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o.data || o;
}

// ── 串行提交 ──────────────────────────────────────────────────────────
/**
 * 把队列里的 miniGameId 逐条按最高档提交（同刻至多一发出网）。
 * @returns {Promise<void>}
 */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      var it = queue.shift();
      if (!aliveFn()) {
        // 停用期间不再出网；留在队首的那条随 pause 一起丢（见 pause）
        inHand.delete(it.idStr);
        break;
      }
      var ageMs = Date.now() - it.atMs;
      var plan = planSubmit(it.idStr, ageMs);
      if (!plan) {
        // 队里只会有过了 readMiniGameId 的合法句柄，故 null 的唯一成因就是「窗口已闭」
        inHand.delete(it.idStr);
        log.warn(
          '2129 dropped: mini game window closed. id=%s age=%dms src=%d',
          it.idStr,
          ageMs,
          it.src,
        );
        continue;
      }
      var idVal = boxId(plan.id);
      if (idVal == null) {
        inHand.delete(it.idStr);
        continue; // boxId 自带 warn，此处不重复出网也不重试
      }
      var sendErr = '';
      var ret = await net.sendGuarded(
        CMD_MINI_GAME,
        { id: idVal, index: plan.index },
        {
          protocol: 'sendPBV2',
          onError: function (err) {
            sendErr = (err && err.message) || String(err);
          },
        },
      );
      if (!aliveFn()) {
        log.debug('2129 ack after pause, drop bookkeeping. id=%s', it.idStr);
        break;
      }
      if (ret && ret.code === CODE_NOT_SENT && shouldResubmit(sendErr, it.tries)) {
        // 走到这里只可能是发送抛错（在途闸挡下的那一发不重投，归 settle 记一条 info）
        it.tries++;
        queue.unshift(it);
        log.debug('2129 not sent, retry %d/%d. id=%s (%s)', it.tries, MAX_TRIES, it.idStr, sendErr);
        await sleep(RETRY_DELAY_MS, ctxRef && ctxRef.signal); // pause 早醒（循环头 aliveFn 闸门兜住不再出网）
        continue;
      }
      settle(it, ret, sendErr);
    }
  } catch (e) {
    // 泵内的意外抛错不外溢（调用点是 fire-and-forget），也不能把 pumping 卡在 true 上
    log.warn('2129 pump threw: %s', (e && e.message) || String(e));
  } finally {
    pumping = false;
  }
}

/**
 * 装箱并**往返自校验**：十进制串 → 游戏 Long → 读回必须逐字相等。
 * 为什么较真：`bits.int64` 在 long64Bit 符号缺席时会退成 `Number(v)`，19 位雪花 id 直接丢精度
 *   （shop.js 同款教训），拿一个末几位被抹平的 id 去提交只会撞「找不到对应小游戏」，
 *   还会让人以为最高档没摇中。校验失配就放弃代摇（玩家自己点仍然能领奖），并首遇一条 warn。
 * @param {string} idStr miniGameId 十进制串
 * @returns {*|null} 可出网的 Int64；不可安全装箱时 null
 */
function boxId(idStr) {
  var boxed;
  try {
    boxed = bits.int64(idStr);
  } catch (e) {
    boxed = null;
  }
  if (boxed == null || bits.int64Str(boxed) !== idStr) {
    if (!boxDegradedWarned) {
      boxDegradedWarned = true;
      log.warn('2129 skip: Int64 boxing unreliable (round-trip mismatch). id=%s', idStr);
    }
    return null;
  }
  boxDegradedWarned = false;
  return boxed;
}

/**
 * 代摇成功后收掉小游戏弹窗：只触游戏原生 `UIManager.CloseUI(描述符)`（与面板自己那条关闭链同源），
 *   不改任何业务态。为什么要收（详见文件头「收窗与不重投」）：面板 `clickBlankClose:false` 又不知道奖励已被
 *   我们领走，玩家补点一发只会撞 `s=3 activity_120002`（「参数错误」）并在脸上弹一条 toast。
 * 失败一律降级（符号漂移/面板已不在场），绝不影响已到账的奖励；本函数不抛。
 * @returns {boolean} 是否真关掉了（面板不在场回 false，不视为错误）
 */
function closeShakePop() {
  var r;
  try {
    r = ui.close('iceShakePopup');
  } catch (e) {
    log.warn('2129 popup close threw: %s', (e && e.message) || String(e));
    return false;
  }
  if (r && r.ok) {
    log.debug('2129 shake popup closed. name=%s', r.name);
    return true;
  }
  log.debug('2129 shake popup not closed: %s', (r && r.err) || 'unknown');
  return false;
}

/**
 * 展示本次摇一摇的奖励（用户要求：奖励要能看到，不要直接被收窗“隐形”）。
 * 只转交应答自带的 `rewardResult` 给游戏原生面板，不拼造字段、不读本地数据。
 *   实证：本视图自己的成功回调就是 `OpenUI(UIDataInfo.CommonRewardPanel,{serverReward:o.rewardResult})`，
 *   与 BagPanel/QuestController/AllianceBehemothNet 等全仓调用逐字同形。
 * 失败一律降级（符号漂移/无载荷），绝不影响已到账的奖励；本函数不抛。
 * @param {*} rewardResult 应答里的奖励载荷（`{items,resource}` 形态）
 * @returns {boolean} 是否真开了窗（无载荷或开窗失败回 false，不视为错误）
 */
function showRewardPanel(rewardResult) {
  var args = rewardPanelArgs(rewardResult);
  if (!args) {
    log.debug('2129 reward panel skipped: no rewardResult payload');
    return false;
  }
  var r;
  try {
    r = ui.open('commonRewardPanel', args);
  } catch (e) {
    log.warn('2129 reward panel open threw: %s', (e && e.message) || String(e));
    return false;
  }
  if (r && r.ok) {
    log.debug('2129 reward panel opened.');
    return true;
  }
  log.warn('2129 reward panel not opened: %s', (r && r.err) || 'unknown');
  return false;
}

/**
 * 纯函数：把应答里的 `rewardResult` 归一成 CommonRewardPanel 的实参（单测与对拍共用）。
 * @param {*} rewardResult 应答里的奖励载荷
 * @returns {?{serverReward:object}} 无有效载荷（非对象/空）时 null——宁不开窗也不开一扇空窗
 */
export function rewardPanelArgs(rewardResult) {
  if (!rewardResult || typeof rewardResult !== 'object' || Array.isArray(rewardResult)) return null;
  if (!Object.keys(rewardResult).length) return null;
  return { serverReward: rewardResult };
}

/**
 * 重投判定（纯函数，单测与 replay 对拍共用）：只有「发送本身抛错」才值得再来一次。
 * 被在途闸挡下（`sendErr` 为空串）不重投：那发在飞的 2129 多半已经把这条 miniGameId 结算掉了，
 *   补一发只会撞 `s=3`（见文件头「收窗与不重投」）。
 * @param {string} sendErr 发送抛错的文案（空串=没抛错，只是被在途闸挡下）
 * @param {number} tries 已尝试次数（含本次）
 * @returns {boolean} 是否再投一次
 */
export function shouldResubmit(sendErr, tries) {
  return !!sendErr && Number(tries) < MAX_TRIES;
}

/**
 * 结算：成功记一次代摇并**立刻收掉小游戏弹窗**；被拒属可预期业务拒绝（已提交/活动关闭），info 级不升 warn。
 * @param {object} it 队列项
 * @param {object} ret Ret{ok,code,data}
 * @param {string} sendErr 抛错文案（CODE_NOT_SENT 且非空＝发送本身抛错，不是被在途闸挡下）
 */
function settle(it, ret, sendErr) {
  inHand.delete(it.idStr);
  if (ret && ret.code === CODE_NOT_SENT) {
    if (sendErr) {
      log.warn('2129 not sent (threw: %s). id=%s src=%d', sendErr, it.idStr, it.src);
      return;
    }
    // 没抛错＝被在途闸挡下：那发 2129 是玩家自己点出去的，结算归他，不抢也不重投
    log.info(
      '2129 skip: another submit in flight (manual click owns it). id=%s src=%d',
      it.idStr,
      it.src,
    );
    return;
  }
  if (!ret || !ret.ok) {
    log.info(
      '2129 rejected. id=%s src=%d code=%s reason=%s',
      it.idStr,
      it.src,
      ret ? ret.code : 'unknown',
      rejectText(ret),
    );
    return;
  }
  var d = (ret && ret.data) || {};
  // 与游戏原生成功回调同序：先开奖励面板，再收摇一摇弹窗
  showRewardPanel(d.rewardResult);
  closeShakePop();
  var items = (d.rewardResult && d.rewardResult.items) || [];
  var got = items
    .map(function (it2) {
      return item.label(it2.itemId) + '×' + (Number(it2.itemCount) || 0);
    })
    .join(', ');
  log.info(
    'mini game submitted tier=%s id=%s src=%d → %s',
    TIER_LABELS[TIER_HIGH],
    it.idStr,
    it.src,
    got || 'empty reward',
  );
}

// ── 纯函数 ────────────────────────────────────────────────────────────
/**
 * 从融冰应答业务体里读小游戏句柄：只有 `status===0` 且带**非零** miniGameId 才成句柄。
 * 两种 Int64 形态都吃：游戏内 Long 实例（自带 toString/toNumber）→ `int64Str`；
 *   裸 `{_low,_high}` POJO（序列化/回落形态）→ `int64Decimal` 用 BigInt 拼装，无精度损失。
 * @param {object|null} body 应答业务体（`{isOk, miniGameId}` 或 `{isOk, rewardResult}`）
 * @param {number} [status] 应答状态码（`header.s`，0=成功）；缺省按 0 处理
 * @returns {string} miniGameId 十进制串；无小游戏/形态异常回空串
 */
export function readMiniGameId(body, status) {
  if (!body || typeof body !== 'object') return '';
  if (status != null && Number(status) !== 0) return '';
  var v = body.miniGameId;
  if (v == null) return '';
  var s = bits.int64Str(v);
  if (!/^\d+$/.test(s)) s = bits.int64Decimal(v);
  if (!/^\d+$/.test(s) || s === '0') return '';
  return s;
}

/**
 * 提交计划（出网前唯一的决策点，也是 replay 对拍共用的「仿真侧」）：句柄 + 已耗时 → 该不该发、发什么。
 * 回 null 即「这条不代摇」：句柄不合法（非纯数字/为 0）或客户端倒计时窗已闭（留 1s 余量，见
 *   SUBMIT_EXPIRE_MS）。**不含**装箱与去重——那是 pump 的事，此处保持纯函数以便离线喂录制数据。
 * @param {string} idStr miniGameId 十进制串
 * @param {number} ageMs 从拿到句柄到此刻的毫秒数
 * @returns {{id:string,index:number}|null} 出网计划（`{id,index}`，id 为十进制串，装箱由 boxId 负责）
 */
export function planSubmit(idStr, ageMs) {
  var s = String(idStr == null ? '' : idStr);
  if (!/^\d+$/.test(s) || s === '0') return null;
  if (!(ageMs >= 0) || ageMs > SUBMIT_EXPIRE_MS) return null;
  return { id: s, index: TIER_HIGH };
}

/**
 * 档位号 → 面板/日志展示名（未知档位号回 `档 <n>`，不抛异常）。
 * @param {number} index 档位号（0/1/2）
 * @returns {string}
 */
export function tierText(index) {
  var n = Number(index);
  return TIER_LABELS[n] != null ? TIER_LABELS[n] : '档 ' + n;
}

// ── 融冰腿：推送/应答入口 + 纯函数 + 探针 + 调度（原 feast.js 迁来）──────────────
/** 22032：阶段机快照（同帧拆标量副本；报文对象池化复用，不得存引用） */
function onPhasePush(ev) {
  var b = ackBody(ev);
  var fp = b && b.feastPhase;
  if (!fp || typeof fp !== 'object') {
    log.warn('22032 malformed (no feastPhase).');
    return;
  }
  phaseSnap = {
    state: Number(fp.state) || 0,
    gatherTime: bits.int64ToNum(fp.gatherTime),
    beginTime: bits.int64ToNum(fp.beginTime),
    endTime: bits.int64ToNum(fp.endTime),
    displayEndTime: bits.int64ToNum(fp.displayEndTime),
  };
  log.debug('22032 phase=%d', phaseSnap.state);
  if (aliveFn()) cycle.kick();
}

/**
 * 901 应答 / 10018 推送 → iceList 并入冰缓存（level=0 删格）。
 * 两条通道的行形状一致，共用一个 ingest；iceList 行的 k 在 body 顶层（行内不带）。
 * @param {object} ev bus 事件
 */
function onTileInfo(ev) {
  var b = ackBody(ev);
  if (!b) return;
  var k = Number(b.k) || 0;
  if (Array.isArray(b.iceList) && ingestIceList(b.iceList, k, iceTiles, Date.now())) {
    if (aliveFn()) cycle.kick();
  }
}

/** 2101 应答：巨兽锚点 pos 标量副本（补读探针窗心用；游戏内存投影由 ACL 同步维护） */
function onBwlInfoResp(ev) {
  var b = ackBody(ev);
  var pos = b && b.pos;
  if (pos && Number(pos.x) > 0 && Number(pos.y) > 0) {
    bwlPosSnap = { x: Number(pos.x) | 0, y: Number(pos.y) | 0, k: Number(pos.k) || 0 };
    log.debug('2101 pos resolved. (%d,%d) k=%d', bwlPosSnap.x, bwlPosSnap.y, bwlPosSnap.k);
  }
  if (aliveFn()) cycle.kick();
}

/**
 * 当前阶段快照：投影优先（与游戏内存同源），不可用时回落自订 22032 副本。
 * @returns {object|null} null=两路都没有（阶段闸跳过本拍）
 */
function currentPhase() {
  return gameData.cq26FeastPhase() || phaseSnap;
}

/**
 * 日界滚清：换日清空拒绝/冷却/探针 miss 表与今日融冰计数，使「当日拉黑」「今日次数」真止于当日。
 * @param {number} nowSec 服务器秒
 */
function rolloverState(nowSec) {
  var d = todayStr(nowSec);
  if (d === dayKey) return;
  dayKey = d;
  rejectCount = Object.create(null);
  coolUntil = Object.create(null);
  missAt = Object.create(null);
  meltedCount = 0;
  startLoadMelt();
  log.debug('day rollover. day=%s', d);
}

// ── 今日融冰计数持久化（同 wl-beast 当日表口径：回读成功才写，避免覆盖丢账）──
/**
 * 换日回读：date 命中今日才把落盘计数累加进 meltedCount。
 *   回读前已清零，回读在途期间新融的冰靠「累加」而非「覆盖」并入，不丢账。
 */
function startLoadMelt() {
  meltLoadOk = false;
  meltLoadPromise = (async function () {
    var saved;
    try {
      saved = await storage.data.get(DATA_NAME_MELT);
    } catch (e) {
      log.warn('load cq26IceShake.melt failed: %s', (e && e.message) || e);
      return;
    }
    if (saved && typeof saved === 'object' && saved.date === dayKey) {
      var n = Number(saved.count) | 0;
      if (n > 0) {
        meltedCount += n;
        log.debug('melt count loaded. count=%d day=%s', meltedCount, dayKey);
      }
    }
    meltLoadOk = true;
  })();
}

/**
 * 等回读完成（完成前禁写盘：整体覆盖会抹掉当日已落盘的融冰数）。
 * @returns {Promise<boolean>} true = 可安全写盘
 */
async function waitMeltLoad() {
  if (meltLoadPromise) {
    try {
      await meltLoadPromise;
    } catch (e) {
      /* 回读异常已在 startLoadMelt 内降级，这里只保证不阻塞 */
    }
  }
  return meltLoadOk;
}

/**
 * 落盘今日融冰数（fire-and-forget：读盘失败则跳过整体覆盖写）。
 */
function persistMelt() {
  waitMeltLoad().then(function (ok) {
    if (!ok) {
      log.warn('persist melt skipped: daily count unreadable (avoid overwrite).');
      return;
    }
    return storage.data.set(DATA_NAME_MELT, { date: dayKey, count: meltedCount });
  });
}

/**
 * 纯函数：iceList 行数组 → 并入冰缓存（就地改 into，只写自己 new 的对象，绝不碰报文本体）。
 * level=0 = 已融（10018 增量语义）→ 删格；其余 upsert。
 * @param {Array<object>} list 901/10018 的 iceList
 * @param {number} k 房间号（body 顶层，行内不带）
 * @param {object} into 目标缓存（键 x_y）
 * @param {number} nowMs Date.now() 基准
 * @returns {number} 变更条数（含删格）
 */
export function ingestIceList(list, k, into, nowMs) {
  var n = 0;
  for (var i = 0; i < (list || []).length; i++) {
    var r = list[i];
    if (!r) continue;
    var x = Number(r.x) | 0;
    var y = Number(r.y) | 0;
    if (!x && !y) continue;
    var key = x + '_' + y;
    var level = Number(r.level) || 0;
    if (level <= 0) {
      if (into[key]) {
        delete into[key];
        n++;
      }
      continue;
    }
    into[key] = {
      x: x,
      y: y,
      k: Number(k) || 0,
      level: level,
      specIndex: r.specIndex == null ? -1 : Number(r.specIndex) || 0,
      initSid: Number(r.initSid) || 0,
      atMs: nowMs,
    };
    n++;
  }
  return n;
}

/**
 * 纯函数：逐冰等级火种消耗求值（52000359 全段数组，level 从 1 起）。
 * @param {number[]|null} costTable cq26WlConfList 产出
 * @param {number} level 冰等级
 * @returns {number|null} 缺表/越界/非数值回 null（调用方跳过该候选，不得按 0 消耗白送）
 */
export function iceCost(costTable, level) {
  if (!Array.isArray(costTable)) return null;
  var lv = Number(level) || 0;
  if (lv <= 0 || lv > costTable.length) return null;
  var c = Number(costTable[lv - 1]);
  return Number.isFinite(c) && c >= 0 ? c : null;
}

/**
 * 纯函数：冰缓存 → 本轮可融队列（level 升序，先便宜）。
 * 闸序：specIndex=0（BWL 线）→ 本服 → 新鲜度 → 冷却/拉黑 → 消耗表 → 火种预算。
 * @param {object} iceMap 冰缓存（键 x_y）
 * @param {object} g 闸门入参
 * @param {number[]|null} g.costTable 逐等级消耗表
 * @param {number} g.fireAmount 火种持有量
 * @param {number|null} g.originSid 老家服号（null=跳过归属闸，调用方须先 fail-closed）
 * @param {number} [g.now] Date.now() 基准
 * @param {number} [g.ttlMs] 冰缓存 TTL
 * @param {Object<string,number>} [g.coolUntil] 冷却表（键带前缀）
 * @param {Object<string,number>} [g.rejectCount] 拒绝计数表（键带前缀）
 * @param {string} [g.keyPrefix] 冷却/拉黑键前缀（缺省 'i:'）
 * @param {number} [g.maxReject] 当日拉黑阈值
 * @returns {{ready:Array<object>, blocked:Array<{key:string,reason:string}>}}
 */
export function pickIce(iceMap, g) {
  var o = g || {};
  var now = o.now == null ? Date.now() : o.now;
  var ttl = o.ttlMs == null ? ICE_TTL_MS : o.ttlMs;
  var cool = o.coolUntil || {};
  var rej = o.rejectCount || {};
  var prefix = o.keyPrefix == null ? 'i:' : o.keyPrefix;
  var maxRej = o.maxReject == null ? MAX_REJECT : o.maxReject;
  var ready = [];
  var blocked = [];
  var keys = Object.keys(iceMap || {});
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var t = iceMap[key];
    var rk = prefix + key;
    if (t.specIndex !== 0) {
      blocked.push({ key: key, reason: 'not-bwl' });
      continue;
    }
    if (o.originSid != null && t.initSid > 0 && t.initSid !== o.originSid) {
      blocked.push({ key: key, reason: 'other-server' });
      continue;
    }
    if (now - t.atMs > ttl) {
      blocked.push({ key: key, reason: 'stale' });
      continue;
    }
    if ((cool[rk] || 0) > now) {
      blocked.push({ key: key, reason: 'cooling' });
      continue;
    }
    if ((rej[rk] || 0) >= maxRej) {
      blocked.push({ key: key, reason: 'blacklisted' });
      continue;
    }
    var cost = iceCost(o.costTable, t.level);
    if (cost == null) {
      blocked.push({ key: key, reason: 'no-cost-cfg' });
      continue;
    }
    if (!(Number(o.fireAmount) >= cost)) {
      blocked.push({ key: key, reason: 'no-fire' });
      continue;
    }
    ready.push({ key: key, x: t.x, y: t.y, level: t.level, cost: cost });
  }
  ready.sort(function (a, b) {
    return a.level - b.level || a.x - b.x || a.y - b.y;
  });
  return { ready: ready, blocked: blocked };
}

/**
 * 该窗心现在能不能发定向 901（在途单发 + miss 冷却）。
 * @param {string} key 探针窗心键
 * @returns {boolean}
 */
function canProbe(key) {
  if (probeInFlight || !net) return false;
  if (net.isSending && net.isSending(CMD_WORLD_INFO)) return false;
  return Date.now() - (missAt[key] || 0) >= MISS_COOL_MS;
}

/**
 * 融冰探针：bwlPos 未知先补读一发 2101（冷却 60s）；否则以 bwlPos+轮转偏移为窗心发一扇定向 901。
 * iceList 经 resp(901) 订阅回流进冰缓存（fetchWindow 返回值不含 iceList）；窗里无冰记 miss 冷却。
 * @returns {Promise<void>}
 */
async function probeIceWindow() {
  var pos = gameData.cq26BwlPos() || bwlPosSnap;
  if (!pos) {
    if (Date.now() - bwlInfoAt < BWL_INFO_COOL_MS) {
      log.debug('2103 probe skip: bwlPos unknown, 2101 cooling.');
      return;
    }
    if (!net || (net.isSending && net.isSending(CMD_BWL_INFO))) return;
    bwlInfoAt = Date.now();
    var sendErr = '';
    var ret = await net.sendGuarded(
      CMD_BWL_INFO,
      {},
      {
        protocol: 'sendPBV2',
        onError: function (err) {
          sendErr = (err && err.message) || String(err);
        },
      },
    );
    if (!aliveFn()) return;
    if (ret && ret.code === CODE_NOT_SENT) {
      log.warn('2101 not sent%s.', notSentSuffix(sendErr));
      return;
    }
    if (!ret || !ret.ok) {
      log.debug('2101 read failed. code=%s', ret ? ret.code : 'unknown');
      return;
    }
    var p = ret.data && ret.data.pos;
    if (p && Number(p.x) > 0 && Number(p.y) > 0) {
      bwlPosSnap = { x: Number(p.x) | 0, y: Number(p.y) | 0, k: Number(p.k) || 0 };
    }
    log.debug(
      '2101 read ok, pos %s.',
      bwlPosSnap ? bwlPosSnap.x + ',' + bwlPosSnap.y : 'still unknown',
    );
    return; // 本拍只读一发，下一拍再探针
  }
  var off = PROBE_OFFSETS[probeIdx % PROBE_OFFSETS.length];
  var cx = pos.x + off[0];
  var cy = pos.y + off[1];
  var centerKey = cx + '_' + cy;
  if (!canProbe(centerKey)) {
    log.debug('901 ice probe gated. center=%s', centerKey);
    return;
  }
  probeIdx++;
  var t0 = Date.now();
  probeInFlight = true;
  var r = await fetchWindow(net, cx, cy, {
    k: pos.k || worldMap.serverId(),
    width: PROBE_W,
    height: PROBE_H,
    viewLevel: PROBE_VIEW_LEVEL,
    marchInfo: false,
  });
  probeInFlight = false;
  if (!aliveFn()) return;
  if (!r.ok) {
    log.debug('901 ice probe failed. center=%s code=%s', centerKey, r.code);
    return;
  }
  hadCandidate = true;
  // resp(901) 订阅已在 dispatch 时把 iceList 并入缓存；数一下本窗新到货的冰
  var fresh = 0;
  var keys = Object.keys(iceTiles);
  for (var i = 0; i < keys.length; i++) if (iceTiles[keys[i]].atMs >= t0) fresh++;
  if (!fresh) {
    missAt[centerKey] = Date.now();
    log.debug('901 ice window empty. center=%s k=%d', centerKey, pos.k);
  } else {
    delete missAt[centerKey];
    log.debug('901 ice window resolved. center=%s fresh=%d', centerKey, fresh);
  }
}

/**
 * 发一条 2103 并结算（每拍至多一次）。isOk=1 → 本地删冰格（10018 level=0 双保险）；
 * 带 miniGameId 不在此处理（摇一摇腿经订阅接走）；被拒 → 冷却/拉黑。
 * @param {object} c 候选（pickIce ready 项）
 * @returns {Promise<void>}
 */
async function fireIce(c) {
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_FIRE_BWL,
    { x: c.x, y: c.y },
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) {
    log.debug('2103 ack after pause, drop bookkeeping. ice=%s', c.key);
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn('2103 not sent%s. ice=%s', notSentSuffix(sendErr), c.key);
    return;
  }
  var d = (ret && ret.data) || {};
  if (!ret || !ret.ok || Number(d.isOk) !== 1) {
    noteReject('i:' + c.key, CMD_FIRE_BWL, ret, 'ice=' + c.key + ' lv=' + c.level);
    return;
  }
  delete iceTiles[c.key];
  rejectCount['i:' + c.key] = 0;
  delete coolUntil['i:' + c.key];
  justActed = true;
  meltedCount++;
  persistMelt();
  if (d.miniGameId != null) {
    log.info(
      '2103 melted (%d,%d) lv=%d → mini game opened (shake leg owns it).',
      c.x,
      c.y,
      c.level,
    );
    return;
  }
  var items = (d.rewardResult && d.rewardResult.items) || [];
  var got = items
    .map(function (it) {
      return item.label(it.itemId) + '×' + (Number(it.itemCount) || 0);
    })
    .join(', ');
  log.info(
    '2103 melted (%d,%d) lv=%d cost=%d → %s',
    c.x,
    c.y,
    c.level,
    c.cost,
    got || 'empty reward',
  );
}

/**
 * 融冰腿：候选在手发队头（level 升序）；缓存空则每拍一扇定向 901（窗心=bwlPos+轮转偏移）。
 * @param {object|null} phase 阶段快照
 * @param {number|null} originSid 老家服号
 * @returns {Promise<void>}
 */
async function legMelt(phase, originSid) {
  if (!phase) {
    log.debug('2103 skip: no feast phase snapshot yet.');
    return;
  }
  if (phase.state !== PHASE_GATHER) {
    log.debug('2103 skip: phase=%d (GATHER only).', phase.state);
    return;
  }
  if (originSid == null) {
    log.debug('2103 skip: origin server id unknown.');
    return;
  }
  var costTable = gameData.cq26WlConfList(CFG_FIRE_COST);
  var fireItemId = Number(gameConf.dataConfig(CFG_FIRE_ITEM)) || 0;
  if (!costTable || !fireItemId) {
    if (!fireCfgWarned) {
      fireCfgWarned = true;
      log.warn(
        '2103 leg halt: fire config unreadable (cost=%d item=%d).',
        CFG_FIRE_COST,
        CFG_FIRE_ITEM,
      );
    }
    return;
  }
  fireCfgWarned = false;
  var picked = pickIce(iceTiles, {
    costTable: costTable,
    fireAmount: item.amount(fireItemId),
    originSid: originSid,
    now: Date.now(),
    coolUntil: coolUntil,
    rejectCount: rejectCount,
  });
  var head = picked.ready[0] || null;
  if (!head) {
    log.debug(
      '2103 no candidate. ice=%d blocked=%d reasons=%s',
      Object.keys(iceTiles).length,
      picked.blocked.length,
      briefReasons(picked.blocked),
    );
    await probeIceWindow();
    return;
  }
  hadCandidate = true;
  if (!net) {
    log.warn('net unavailable, skip 2103. ice=%s', head.key);
    return;
  }
  await fireIce(head);
}

/**
 * 业务拒绝：可预期闸门类，info 级不升 warn；单次留冷却自愈，连续 MAX_REJECT 次当日拉黑。
 * @param {string} key 带前缀目标键
 * @param {number} cmd 协议号
 * @param {object} ret Ret{code,data}
 * @param {string} ctx 定位上下文
 */
function noteReject(key, cmd, ret, ctx) {
  var n = (rejectCount[key] = (rejectCount[key] || 0) + 1);
  coolUntil[key] = Date.now() + REJECT_COOL_MS;
  log.info(
    '%d rejected. %s code=%s reason=%s streak=%d%s',
    cmd,
    ctx,
    ret ? ret.code : 'unknown',
    rejectText(ret),
    n,
    n >= MAX_REJECT ? ' (blacklisted today)' : '',
  );
}

/**
 * blocked 原因折叠成一行 reason×n（debug 用）。
 * @param {Array<{key:string,reason:string}>} blocked
 * @returns {string}
 */
function briefReasons(blocked) {
  var m = Object.create(null);
  for (var i = 0; i < blocked.length; i++) m[blocked[i].reason] = (m[blocked[i].reason] || 0) + 1;
  return (
    Object.keys(m)
      .map(function (k) {
        return k + '×' + m[k];
      })
      .join(',') || '-'
  );
}

/**
 * CODE_NOT_SENT 后缀：区分「发送抛错」与「在途闸/超时」。
 * @param {string} sendErr 抛错文案
 * @returns {string}
 */
function notSentSuffix(sendErr) {
  return sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)';
}

/**
 * 单拍：活动闸 → 时刻闸 → 日界滚清 → 融冰腿（至多一发写 + 至多一发只读探针）。
 * @returns {Promise<void>}
 */
async function cyclePass() {
  justActed = false;
  hadCandidate = false;
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    return;
  }
  var nowSec = gameData.serverTime() | 0;
  if (nowSec <= 0) {
    log.debug('server time unavailable, skip this pass.');
    return;
  }
  rolloverState(nowSec);
  await legMelt(currentPhase(), gameData.cq26OriginServerId());
}

/**
 * 单拍择时：成功出网 → chainMs 续发；GATHER 期/有候选 → activeMs；闲时 idleMs。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  await cyclePass();
  if (cycle.pending) return 0;
  if (justActed) return meltCfg.chainMs;
  var phase = currentPhase();
  var phaseActive = !!phase && phase.state === PHASE_GATHER;
  return hadCandidate || phaseActive ? meltCfg.activeMs : meltCfg.idleMs;
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: meltCfg.fallback,
});

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 面板 defaults：唯一交互项是开关（档位与融冰都不是可调项，见文件头「刻意不做」）。
 * @returns {object}
 */
function buildDefaults() {
  return { enabled: false };
}

/**
 * 面板 fields：单行内联状态（组卡片 inlineStatus 取第一个 type:'text' 的 get() 结果），
 * 只显「今日融冰 N 次」（用户拍板：只看当日融冰次数；摇一摇是融冰衍生小游戏，不单独计）。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_shakeInfo',
      type: 'text',
      label: '状态',
      get: function () {
        if (!gameData.cq26IsOpen()) return '—';
        return '今日融冰 ' + meltedCount + ' 次';
      },
    },
  ];
}

// ── 注册 ──────────────────────────────────────────────────────────────
/**
 * toModuleCfg：面板 cfg → 运行时配置。本玩法无可调参数，但仍必须声明
 * （`core/registry.js` 的 applyFeature 对每个 reactor 功能无条件调它）。
 * @param {object} c 面板合并后配置
 * @returns {{enabled:boolean}} 运行时配置（历史残留键不透传）
 */
function normalizeCfg(c) {
  return { enabled: !!(c && c.enabled) };
}

/**
 * configure：registry 每次推配置灌入运行时 cfg，运行中变更立即补一拍（融冰腿 cycle）。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (!partial) return MCFG;
  MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

// 协议号/档位/融冰常量导出给 replay 对拍（scripts/verify-manifests/cq26-ice-shake.mjs）与单测复用同一份字典
export {
  CMD_FIRE_NWL,
  CMD_FIRE_BWL,
  CMD_MINI_GAME,
  TIER_HIGH,
  TIER_LABELS,
  SUBMIT_EXPIRE_MS,
  MAX_TRIES,
  CMD_BWL_INFO,
  CMD_WORLD_INFO,
  PUSH_PHASE,
  PUSH_TILE,
  PHASE_GATHER,
  CFG_FIRE_COST,
  CFG_FIRE_ITEM,
  PROBE_W,
  PROBE_H,
  PROBE_VIEW_LEVEL,
  ICE_TTL_MS,
  MAX_REJECT,
  REJECT_COOL_MS,
};

reactor.register({
  id: FEAT_ID,
  label: '开荒融冰',
  storageKey: 'pocketcc.feat.cq26_ice_shake',
  // dataCenter 硬依赖（活动闸 cq26IsOpen / 阶段 cq26FeastPhase / 锚点 cq26BwlPos / 老家服 cq26OriginServerId
  //   / 消耗表 cq26WlConfList 均走控制器投影）；long64Bit 也是硬依赖：
  //   缺失时 bits.int64 退成 Number，19 位 miniGameId 丢精度 ⇒ 由 boxId 的往返校验兜住并放弃代摇
  symbols: ['dataCenter', 'long64Bit'],
  // 与 cq26 家族同口径：靠房间号 k 跨图定向发包，不依赖人真站在冰原图里
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 融冰/代摇均不派兵、不占行军名额 ⇒ 战斗态无需下线
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
