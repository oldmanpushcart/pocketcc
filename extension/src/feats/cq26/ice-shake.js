/**
 * CQ26 印石·开荒摇一摇自动选最高档（cq26IceShake）
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
 *   · 不主动发 2117/2103 融冰（那要火种道具与地块坐标，属另一条玩法；本 feat 只**接**已经弹出来的小游戏）；
 *   · 不做档位/难度可调参数（"摇到最高档"是唯一正确答案，同 wl-chest/excav 的「无可调参数」纪律）；
 *   · 不接 push 22076 SERIES_FROST_NWL_FIRE_MINI_GAME_REWARD（汇总 53 发结算全走 2129 应答，零出现）。
 */
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { gameData, bits, ui } from '../../core/game-api.js';
import { item } from '../../core/item.js';
import { CODE_NOT_SENT, rejectText, sleep } from '../../core/util.js';

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

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {Array<{idStr:string, src:number, atMs:number, tries:number}>} 待提交的小游戏队列（串行出网） */
var queue = [];
/** @type {Set<string>} 已入队/在途的 miniGameId 十进制串（同一条只提交一次） */
var inHand = new Set();
/** @type {boolean} pump 是否在途（同刻只有一条 2129 出网） */
var pumping = false;
/** @type {number} 本场成功代摇次数（面板内联状态用，随 pause/重载归零） */
var submitted = 0;
/** @type {boolean} 「Int64 装箱不可靠」warn 去重（恢复后复位） */
var boxDegradedWarned = false;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（纯被动接应答，安装与运行期都不发只读请求）。
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
 * 运行：订阅两路融冰应答（退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctx.on.resp(CMD_FIRE_NWL, onFireResp);
  ctx.on.resp(CMD_FIRE_BWL, onFireResp);
  log.info('started. tier=%s', TIER_LABELS[TIER_HIGH]);
}

/**
 * 停用：丢掉待提交队列。
 * resume 后不该拿陈 miniGameId 出网（客户端侧那条小游戏早已走完倒计时），
 *   在途那一发的结算由 aliveFn() 自守（见 settle），不记账也不重投。
 */
function pause() {
  queue = [];
  inHand.clear();
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
 * PBV2 应答取业务体：整包是 `{header,data}`，下钻一层；平铺载荷（旧 JSON 形态）原样回落。
 * @param {object} ev 应答事件
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
        await sleep(RETRY_DELAY_MS);
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
  submitted++;
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

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 面板 defaults：唯一交互项是开关（档位不是可调项，见文件头「刻意不做」）。
 * @returns {object}
 */
function buildDefaults() {
  return { enabled: false };
}

/**
 * 面板 fields：单行内联状态（组卡片 inlineStatus 取第一个 type:'text' 的 get() 结果），
 * 读起来是「开荒摇一摇 · 高温档 · 本场 3 次 · ✓」。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_shakeInfo',
      type: 'text',
      label: '档位',
      get: function () {
        if (!gameData.cq26IsOpen()) return '—';
        return tierText(TIER_HIGH) + (submitted > 0 ? ' · 本场 ' + submitted + ' 次' : '');
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

// 协议号/档位常量导出给 replay 对拍（scripts/verify-manifests/cq26-ice-shake.mjs）复用同一份字典
export {
  CMD_FIRE_NWL,
  CMD_FIRE_BWL,
  CMD_MINI_GAME,
  TIER_HIGH,
  TIER_LABELS,
  SUBMIT_EXPIRE_MS,
  MAX_TRIES,
};

reactor.register({
  id: FEAT_ID,
  label: '开荒摇一摇',
  storageKey: 'pocketcc.feat.cq26_ice_shake',
  // dataCenter 硬依赖（面板活动闸 cq26IsOpen 走控制器投影）；long64Bit 也是硬依赖：
  //   缺失时 bits.int64 退成 Number，19 位 miniGameId 丢精度 ⇒ 由 boxId 的往返校验兜住并放弃代摇
  symbols: ['dataCenter', 'long64Bit'],
  // 与 cq26 家族同口径：靠应答触发出网，不依赖人真站在冰原图里（融冰那一下必然在世界地图）
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 代摇只发一条小游戏结算，不派兵、不占行军名额 ⇒ 战斗态无需下线
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  run: run,
  pause: pause,
});
