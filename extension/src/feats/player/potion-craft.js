/**
 * 机械制药（reactor 说明书形态 · 制药 lane 单槽队列）
 *
 * 玩法：把「机械工厂 · 制药」那条**单槽**队列自动跑起来——面板**单选**一个配方当制药目标，
 *   队列空且「这个目标做得动」才排产（一次只做一个药水；缺料或未解锁就原地等，绝不擅自改做别的），
 *   完成待领取就领掉，正在生产就睡到 et 到期。只做制药 lane（表 traps_and_potions，id≥1e4，单槽），
 *   不碰同面板的制造 lane（表 manufacture，id<1e4，5 槽，1398/1399/1600/1396/1612）。
 *
 * 职业闸（「只有机械大师才能制药」）：源码实证**客户端不查职业**——ProductingData.checkPotionUnlock
 *   只认服务器 1387 下发的 `unlock` 数组（职业 + 制药天赋的解锁结果全由服务器算好放进它），
 *   面板的 LockNode/UnlockTips 也只是拿 ENDOWMENT_V2 反查「要哪个职业」的文案（ProductItem.UpdateItem）。
 *   故本 feat 的职业闸 = `unlock` 为空（非机械大师 / 一点制药天赋都没点）→ 整轮不排产（debug），
 *   不硬编码职业 id、也不反查天赋做拦截：服务器才是裁决，猜错的代价是白撞拒绝或永久躺平。
 *   目标 ∉ unlock（面板改选了个服务器不认的 id）→ gap=`locked`，日志带反查到的职业名。
 *
 * 协议（源码 RequestId 实证；全部走 net 旧 JSON 通道，ret.data 是原始 JSON 串需自 parse）：
 *   1387 getStrengthenMakingData {} → {making:{st,id,state,et}, unlock:[配方 id…]}
 *     机械制药趟实录报文实证（空闲时 making 四字段恒为 0；unlock 由服务器下发）
 *   1388 MAKE_FORMULA {id} → {making:{st,id,state,et}}（et-st 即耗时，实测配方 90001 = 172800s = 48h）
 *   1397 ProductionReward {type} → 到期领取（制药 lane 的 ProductType 源码硬置 1，见 ProductData.UpdateData）
 *   10722 push FORMULA_MAKE_COMPLETE {op,id} → 只当唤醒提示，载荷不入状态
 *     （源码 Push_FORMULA_MAKE_COMPLETE：op===1 置 state，op≠1 清空制药队列——实测见过 op=2）
 *   —— 登记但**不接线**：1389 SPEED_UP_FORMULA {}（钻石加速，成本
 *      `Math.max(1, Math.ceil(剩余秒/60 * DATACONFIG 61017))`，余额读 UserData.Resource.Gold，
 *      源码 GameTimeTools.getProfessionCDGold）与 1390 CANCEL_FORMULA {}（取消）。本 feat 明确不花钻石。
 *
 * 判据（镜像源码 ProductingData + subpack2/ProductionFactoryPanelNew，全部只读）：
 *   在产 = making.id>0 && making.et>0；state===1 = 完成待领取；et<=ServerTime 而 state 仍 0 = 到期未结算。
 *   可制作（排产前逐条过，全过才发 1388）= 目标已选 + 目标 ∈ unlock（科技/职业限制）
 *     +「resources 首段 resId|count 够」+「needItem 每段 itemId|count 够」（材料限制）。
 *     材料口径取自面板真正的起跑闸 checkProductMaterialItemEnough（外加 resources 段），比红点闸
 *     checkItemCanMake 宽容一处：needItem 为空/形态不符的段只跳过、不判死——照 checkItemCanMake 原样实现的话
 *     needItem 为空的行会被游戏判成「永不可做」，本 feat 会跟着静默躺平。
 *   整功能闸 = FunctionOn(FunctionKey.ProductFactory)（值串 manufacture_system）。
 *   面板「制药目标」的清单 = 真解锁列表，不猜档位：本 feat 读过的 1387 unlock 优先，其次游戏本地
 *     缓存的 UnlockList（玩家开过游戏内工厂面板时已有，零发包）；两者都空时下拉只给一条提示项，
 *     由面板上的「↻ 读取可生产清单」按钮**显式**发一次 1387（选项求值链上不得做网络副作用：
 *     buildPanelHTML 在主城就绪时就跑一次，自动探测=每会话无条件发包，即使功能未启用也没开面板）。
 *     不拿表里 level==1 基线行造候选：那会把已升到等级3 的药说成等级1（实录：unlock=[10003,…]
 *     而 trapName_10001=等级1强化机油），既噪声又必然被排产时的权威值以 locked 拒掉。
 *
 * 关键取舍（电平调和 + 每拍全量重读，与 armory-material 同族）：
 *   1387 是唯一权威读通道且恒含 {making, unlock}，故运行时态一律不落盘：重启免费、状态可从应答完全重建。
 *   读失败绝不当作「队列空闲」——误判空闲会重复排产白耗材料，故读失败/应答形态不符时本轮不发任何写动作。
 *   自然到期究竟怎么领属源码推断项（实录报文里 1397 一次都没出现，对应场次全程用钻石加速），因此只在
 *   「自己读到的 1387 state===1」时才发 1397，被拒即页内拉黑（读到 id/state 变化自动解除），不循环重试。
 *   补录清单与风险详见 extension/docs/feat-机械制药.md。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 1387/1388/1397，不调任何游戏 Update/回写、不 OpenUI。
 *   生命周期由 reactor 托管：places base/world、kinds homeland、战斗模式暂停（offInCombat）；
 *   pause 后 ctx.alive()=false，在飞 await 自然退出，cycle 由看门狗与 kick 复活。
 */
import { CODE_NOT_SENT, parseData, rejectText } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';
import { netApi } from '../../core/net.js';
import { bus, EVT } from '../../core/bus.js';
import { l10n, gameData } from '../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=POTION-CRAFT） */
const log = createLog('POTION-CRAFT');

/** @type {number} RequestId.getStrengthenMakingData，制药队列唯一权威读（恒含 {making, unlock}） */
const CMD_INFO = 1387;

/** @type {number} RequestId.MAKE_FORMULA，排一条配方进制药队列（载荷 {id}） */
const CMD_MAKE = 1388;

/** @type {number} RequestId.ProductionReward，领取已完成的产物（载荷 {type}，制药 lane 恒 1） */
const CMD_CLAIM = 1397;

/** @type {number} push FORMULA_MAKE_COMPLETE（只当唤醒提示，不解析载荷入状态） */
const PUSH_MAKE = 10722;

/** @type {number} 制药 lane 的 ProductType（源码 ProductData.UpdateData 对 isPotion 硬置 1） */
const POTION_PRODUCT_TYPE = 1;

/** @type {string} GameDefine.FunctionKey.ProductFactory 成员名（值串 manufacture_system） */
const FUNCTION_KEY = 'ProductFactory';

/** @type {string} 配方表（TableName 枚举成员名，ACL 解析为 traps_and_potions） */
const POTION_TABLE = 'TRAPS_AND_POTIONS';

/** @type {string} 产物道具表（枚举成员名 → item），仅面板取产物名用 */
const ITEM_TABLE = 'ITEM';

/**
 * 职业/科技表（枚举成员名 → endowment_v2），仅用于「目标未解锁」时反查职业名写进日志（ProductItem 同口径）。
 * @type {string}
 */
const TALENT_TABLE = 'ENDOWMENT_V2';

/** @type {number} 缺料/被拒/读失败后的兜底复查间隔（毫秒）：队列本身是小时级，10 分钟足够灵敏 */
const IDLE_POLL_MS = 10 * 60 * 1000;

/** @type {number} 睡到 et 后额外留出的缓冲（毫秒）：补偿定时器节流与时钟抖动，避免早醒一拍空转 */
const DUE_BUFFER_MS = 5000;

/** @type {number} 下拍唤醒的最小间隔（毫秒）：到期判据抖动时兜底，防紧循环 */
const MIN_WAKE_MS = 3000;

/** @type {number} 瞬态未发出（CODE_NOT_SENT：在途频控/发送超时）的短重试（毫秒），不拉黑、不退 10 分钟 */
const TRANSIENT_RETRY_MS = 20 * 1000;

/**
 * 协议号与内置时序常量的导出面：单测与录制对拍 manifest 从这里取，避免在测试里复制一份数值（会漂移）。
 * @type {{cmd:object, timing:object}}
 */
export const INTERNAL = {
  cmd: {
    info: CMD_INFO,
    make: CMD_MAKE,
    claim: CMD_CLAIM,
    push: PUSH_MAKE,
    productType: POTION_PRODUCT_TYPE,
  },
  timing: {
    idlePollMs: IDLE_POLL_MS,
    dueBufferMs: DUE_BUFFER_MS,
    minWakeMs: MIN_WAKE_MS,
    transientRetryMs: TRANSIENT_RETRY_MS,
  },
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;

/** @type {object|null} reactor 上下文；alive() 反映运行态，pause 后在飞流程自然退出 */
var ctxRef = null;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {{formula:number}} 面板配置（configure 灌入 toModuleCfg 产物）；formula=0 表示用户尚未选择制药目标 */
var MCFG = { formula: 0 };

/**
 * 服务器下发的解锁配方 id 缓存：**非真相源**，只喂面板动态选项与标签现扫（每拍由 1387 的非空列表刷新）。
 * @type {number[]}
 */
var lastUnlock = [];

/**
 * 领取被拒后的页内拉黑标志：置真就不再重试 1397，直到一次 1387 读到的 id/state 组合发生变化
 *   （说明队列被游戏侧/服务器推进了）才自动解除。不落盘——重启后本就该重新问服务器一次。
 * @type {boolean}
 */
var claimBlocked = false;

/** @type {string} 拉黑时的队列指纹 `id|state`，用于判「态变了就解除」 */
var claimBlockedKey = '';

/**
 * 本轮是否已试过排产：置真后同轮不再发 1388（每轮 cycleRun 开头复位）。
 *   「同一配方别当日反复试」由「下拍先重读 1387」自然达成，不额外做当日账本。
 * @type {boolean}
 */
var makeBlocked = false;

/** @type {boolean} 「表已就绪却读不到配方行」是否已 warn 过一行（防逐拍刷屏，读到行即复位） */
var warnedRowMiss = false;

/**
 * 清单探测的在飞闸门：按钮连点不重复发包（发完即复位，不拿「试过一次」当「试成功」）。
 * @type {boolean}
 */
var probeInFlight = false;

/**
 * 服务器是否明确回了「unlock 为空」。这是**确定答案**（非机械大师/未点制药天赋），与
 *   「还没读到过」不同形：后者下拉提示去点按钮，前者下拉直接写明「无可生产配方」。
 * @type {boolean}
 */
var unlockKnownEmpty = false;

/**
 * 请面板重建本功能的卡片（下拉的选项只在面板 HTML 装配那一次求值，openPanel/closePanel 只翻 hidden，
 *   新到手的清单不会自己长出来）。
 * 不设 once：调用方只有「首批 unlock 到手（adopt）」与「用户点按钮」两处，两者都是低频动作；
 *   而重建在焦点位于卡内时由 rerenderFeatureCard 自己跳过，不抢用户输入。
 * 面板关着时由 core/ui/index.js 的 pendingRebuild 记账，开面板时补渲染，不会丢。
 */
function pokePanel() {
  bus.emit(EVT.UI_REFRESH, { rebuild: 'potionCraft' });
}

/**
 * 取网络底座：运行中用 install 注入的 ctx.net；功能未启用时懒取全局 netApi 并 install
 *   （与 truck-intercept 的 probeForPanel 同机制，保证面板预览不依赖功能开关）。
 * @returns {object|null} 底座不可用回 null（调用方不硬撑）
 */
function ensureNet() {
  if (net) return net;
  var g = netApi;
  if (g && g.install && g.install()) net = g;
  return net || null;
}

/**
 * 面板「读取可生产清单」按钮的处理器：**显式用户动作**才发包（不在 formulaOptions 的求值过里做网络
 *   副作用——buildPanelHTML 在主城就绪时就跑一次，自动探测等于每个页面会话无条件发一发 1387，
 *   即使玩家从未开过面板、从未启用本功能）。
 * 不复用 fetchQueue：它带 `aliveFn()` 闸门（未 install 时 ctxRef 为空→恒假），探到了也会把应答丢掉。
 * 三态纪律：只有「应答可用 且 unlock 字段确实是个空数组」才记成确定无配方；应答畸形/在途未发出
 *   一律留待下次再点，不拿「无从判定」当否定结论。
 * @returns {Promise<void>} wire.js 的按钮处理器已 .then(restore, restore) 兜住 reject，本函数也不外抛
 */
async function probeUnlockForPanel() {
  if (probeInFlight) return;
  if (aliveFn()) {
    // 引擎在跑：它每拍自己读 1387 并由 adopt 填清单，面板不另开一枪（同 cmd 互撞 CODE_NOT_SENT 只会双双空转）
    log.debug('panel probe skipped: engine running, it reads cmd %d each cycle.', CMD_INFO);
    return;
  }
  probeInFlight = true;
  try {
    var n = ensureNet();
    if (!n) {
      log.debug('panel probe skipped: net unavailable.');
      return;
    }
    var ret = await n.sendGuarded(
      CMD_INFO,
      {},
      {
        onError: function (err) {
          log.debug('cmd %d panel probe threw: %s', CMD_INFO, err && err.message);
        },
      },
    );
    var payload = ret && ret.ok ? parseData(ret.data) : null;
    var q = readQueue(payload);
    if (!q.ok || !payload || !Array.isArray(payload.unlock)) {
      // 被拒 / 在途未发出 / 应答无 unlock 字段：瞬态，不记确定结论，用户可再点一次
      log.debug(
        'panel probe got no usable unlock list. cmd %d code=%s',
        CMD_INFO,
        (ret && ret.code) || '-',
      );
      return;
    }
    if (!payload.unlock.length) {
      unlockKnownEmpty = true;
      lastUnlock = [];
      log.debug('cmd %d reports no unlocked recipe.', CMD_INFO);
    } else {
      unlockKnownEmpty = false;
      lastUnlock = q.unlock.slice();
    }
    pokePanel();
  } catch (e) {
    log.debug('cmd %d panel probe failed: %s', CMD_INFO, e && e.message);
  } finally {
    probeInFlight = false;
  }
}

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ─────────────────────── 纯函数（导给单测） ───────────────────────

/**
 * 归一 id 列表：数字化、剔非正数、按首现顺序去重（只用于服务器 `unlock` 数组，面板已是单选一个 id）。
 * @param {*} list 原始列表（可能非数组/含字符串项）
 * @returns {number[]}
 */
function toIdList(list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  var seen = new Set();
  for (var i = 0; i < list.length; i++) {
    var n = Number(list[i]);
    if (!(n > 0) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * 1387/1388 应答载荷 → 制药队列态（纯函数，不摸游戏态）。
 * 判据镜像源码 ProductData.UpdateData：`making` 缺省/非对象即形态不符（游戏自身也会拿到全 0 态），
 *   调用方必须按「无从判定」处理，不得当成空闲。
 * @param {*} payload 已 parse 的应答 data（可能是 null/非 object）
 * @returns {{ok:boolean, idle:boolean, producing:boolean, claimable:boolean,
 *   id:number, st:number, et:number, state:number, unlock:number[]}}
 *   ok=false 形态不符；claimable = state===1；idle = !(id>0 && et>0)
 */
export function readQueue(payload) {
  var q = {
    ok: false,
    idle: true,
    producing: false,
    claimable: false,
    id: 0,
    st: 0,
    et: 0,
    state: 0,
    unlock: [],
  };
  if (!payload || typeof payload !== 'object') return q;
  var m = payload.making;
  if (!m || typeof m !== 'object') return q;
  q.ok = true;
  q.id = Number(m.id) || 0;
  q.st = Number(m.st) || 0;
  q.et = Number(m.et) || 0;
  q.state = Number(m.state) || 0;
  q.producing = q.id > 0 && q.et > 0;
  q.idle = !q.producing;
  q.claimable = q.state === 1;
  if (Array.isArray(payload.unlock)) q.unlock = toIdList(payload.unlock);
  return q;
}

/**
 * 队列态是否已过到期时刻（纯函数）。et 不可信（0/缺失）时判「未到期」——宁可多睡一拍也不误领。
 * @param {{et:number}} q readQueue 产物
 * @param {number} now 服务器秒
 * @returns {boolean}
 */
export function isExpired(q, now) {
  return !!(q && q.et > 0 && now > 0 && q.et <= now);
}

/**
 * 由队列态给出下拍唤醒毫秒（纯函数，不发包）。
 * @param {{ok:boolean, claimable:boolean, producing:boolean, et:number}} q 队列态
 * @param {number} now 服务器秒
 * @param {number} [fallbackMs] 形态不符时的兜底间隔，默认 IDLE_POLL_MS
 * @returns {number} >0 睡眠毫秒；0 = 立即再跑一轮（完成待领取，领后要接着排产）
 */
export function nextDelayMs(q, now, fallbackMs) {
  if (!q || !q.ok) return fallbackMs == null ? IDLE_POLL_MS : fallbackMs;
  if (q.claimable) return 0;
  if (q.producing) {
    if (!(now > 0) || !(q.et > 0)) return IDLE_POLL_MS; // 时刻不可信：退兜底，不拿 0 去算超长睡眠
    var remainMs = (q.et - now) * 1000;
    if (remainMs <= 0) return MIN_WAKE_MS; // 已到期但本轮没领走（拉黑/异常）：短隔后再读
    return Math.max(remainMs + DUE_BUFFER_MS, MIN_WAKE_MS);
  }
  return IDLE_POLL_MS; // 空闲：本该由调用方排产；走到这里说明排产被闸门拦下，按兜底复查
}

/**
 * 配方名 + 产物名 → 一行选项标签（纯函数）。
 * 存在理由：字典实证两者**同源**——配方名 `trapName_90001` 与产物名 `item_name1600041` 译出来都是
 *   「等级1腐蚀粘液」，直接拼 `A · A` 等于把同一个名字写两遍（面板窄宽下被截成「等级1腐蚀粘液 · 等…」，
 *   用户看到的是重复噪声）。尾追与否取**单向包含**：产物名 ⊆ 配方名 才说明它没新信息（含同名）；
 *   反方向「配方名 ⊆ 产物名」（如「电磁飞弹」→「电磁飞弹图纸 ×2」）恰恰是额外信息，得留着。
 * @param {string} name 配方名（traps_and_potions.name 译文）
 * @param {string} product 产物名（results → item.name 译文），可空串
 * @returns {string} 单名，或「配方名 · 产物名」
 */
export function joinFormulaLabel(name, product) {
  var a = String(name == null ? '' : name);
  var b = String(product == null ? '' : product);
  if (!a) return b;
  // 数量段（「 ×2」「x10」之类）不参与重名判定，否则「等级1腐蚀粘液」vs「腐蚀粘液 ×2」会脱过而回到 A · B 噪声
  var bCore = b.replace(/\s*[×x*]\s*\d+\s*$/, '').trim();
  if (!bCore || a.indexOf(bCore) >= 0) return a; // b===a 时 indexOf 回 0，同走此支
  return a + ' · ' + b;
}

/**
 * 单行缺口判据（镜像游戏起跑闸，纯函数）。
 * @param {object|null} row traps_and_potions 行
 * @param {(resId:number)=>number|null} getRes 资源余额（null=无从判定 → 放行）
 * @param {(itemId:number)=>number} getItem 道具持有量
 * @returns {?{reason:string, [k:string]:*}} 可作返回 null；否则返回缺口描述（供 debug 日志定位「为什么没动」）
 */
function rowGap(row, getRes, getItem) {
  if (!row || typeof row !== 'object') return { reason: 'row' };
  // resources：源码只认首段 `resId|count`；形态不符/非正值不拦（交给服务器裁决）
  var seg = String(row.resources == null ? '' : row.resources)
    .split(',')[0]
    .split('|');
  if (seg.length === 2) {
    var resId = Number(seg[0]);
    var needRes = Number(seg[1]);
    if (resId > 0 && needRes > 0) {
      var haveRes = getRes(resId);
      // 三态纪律：读不到（null）按放行——把「读不到」当缺料会永久跳过有效配方
      if (haveRes !== null && haveRes < needRes) {
        return { reason: 'resource', resId: resId, need: needRes, have: haveRes };
      }
    }
  }
  var parts = String(row.needItem == null ? '' : row.needItem).split(',');
  for (var i = 0; i < parts.length; i++) {
    var c = parts[i].split('|');
    if (c.length !== 2) continue; // 形态不符段跳过（镜像面板 checkProductMaterialItemEnough）
    var itemId = Number(c[0]);
    var need = Number(c[1]);
    if (!(itemId > 0) || !(need > 0)) continue;
    var have = getItem(itemId);
    if (have < need) return { reason: 'item', itemId: itemId, need: need, have: have };
  }
  return null;
}

/**
 * 排产前的「这个药水现在做得动吗」判定（纯函数，全部数据源经注入的读函数取，便于单测）。
 * 一次只做一个药水：只看用户单选的那一个目标，**不退回「改做下一个」**——缺料就原地等，
 *   擅自换配方会花掉用户没打算花的材料（面板已是单选，不存在「候选队列」）。
 * 四闸依序：unlock 为空（职业/科技未入制药线）→ 未选择 → 目标 ∉ unlock（科技限制）→ 行/材料（材料限制）。
 * @param {number[]} unlock 服务器解锁列表（1387 权威值）
 * @param {number} selected 面板单选的目标配方 id（0=未选）
 * @param {(id:number)=>object|null} getRow 配方行读取
 * @param {(resId:number)=>number|null} getRes 资源余额读取（null=无从判定）
 * @param {(itemId:number)=>number} getItem 道具持有量读取
 * @param {((id:number)=>string)=} [getCareer] 目标所属职业名（仅供日志，取不到回空串）
 * @returns {{id:number, ok:boolean, gap:?object}} ok=true 时 id 即待排产目标、gap=null；否则 id=0、gap 为拒因
 */
export function checkTarget(unlock, selected, getRow, getRes, getItem, getCareer) {
  var un = toIdList(unlock);
  if (!un.length) return { id: 0, ok: false, gap: { reason: 'profession' } };
  var sel = Number(selected) || 0;
  if (!(sel > 0)) return { id: 0, ok: false, gap: { reason: 'unselected' } };
  if (un.indexOf(sel) < 0) {
    return {
      id: 0,
      ok: false,
      gap: {
        reason: 'locked',
        id: sel,
        career: typeof getCareer === 'function' ? getCareer(sel) : '',
      },
    };
  }
  var gap = rowGap(getRow(sel), getRes, getItem);
  if (gap) return { id: 0, ok: false, gap: Object.assign({ id: sel }, gap) };
  return { id: sel, ok: true, gap: null };
}

// ─────────────────────── 游戏态只读（经 ACL，try/catch 降级） ───────────────────────

/** @returns {object|null} 配方行（traps_and_potions） */
function potionRow(id) {
  return l10n.tableRow(POTION_TABLE, id);
}

/** @returns {number|null} 资源余额（null=无从判定，按放行处理） */
function resAmount(resId) {
  return gameData.resourceAmount(resId);
}

/** @returns {number} 道具持有量 */
function itemCnt(itemId) {
  return gameData.itemAmount(itemId);
}

/**
 * 目标配方「要哪个职业才解得到」的展示名（仅用于日志与面板标签，不做拦截）。
 * 源码口径 ProductItem.UpdateItem：ENDOWMENT_V2 里 `formula==1 && para1==配方 id` 的行，取 `career_name` 译文。
 * 这里只能按单列查（ACL tableRowByKey），拿到首行后本地再核 `formula==1`；核不上就当作查不到（不猜）。
 * @param {number} id 配方 id
 * @returns {string} 职业名；取不到回空串
 */
function talentCareer(id) {
  var row = l10n.tableRowByKey(TALENT_TABLE, 'para1', id);
  if (!row || Number(row.formula) !== 1 || !row.career_name) return '';
  return l10n.text(row.career_name) || '';
}

/**
 * 产物名（results 首段取道具 id → ITEM 表 name）。取不到回空串，不造假名字。
 * @param {*} results 行的 results 列（数字 id 或 `id|count` 串）
 * @returns {string}
 */
function resultName(results) {
  var s = String(results == null ? '' : results);
  var id = Number(s.split(',')[0].split('|')[0]);
  if (!(id > 0)) return '';
  var row = l10n.tableRow(ITEM_TABLE, id);
  if (!row) return '';
  return l10n.text(row.name || row.id || '');
}

/**
 * 配方面板标签：`配方名 · 产物名`（同源重名时只留一个名，见 {@link joinFormulaLabel}）。
 * @param {number} id 配方 id
 * @returns {string}
 */
function formulaLabel(id) {
  var row = potionRow(id);
  if (!row) return POTION_TABLE + ' ' + id;
  return joinFormulaLabel(l10n.text(row.name || String(id)), resultName(row.results));
}

/**
 * 组装「制药目标」下拉（纯函数，不摸游戏态/不发包，可测）。
 * 清单只列真解锁列表，**不拿配方表的 level==1 基线行猜档位**（字典实证 trapName_10001/10002/10003
 *   是「等级1/2/3强化机油」，而升级过的玩家解锁的是 `10003`：基线行既满屏无效档位，又必然被
 *   排产时的权威 unlock 以 `locked` 拒掉）。清单没到手时用一条 value:0 的提示项把两种态分开写：
 *   未读到→请点按钮；读到且为空→确定无可生产配方。
 * @param {number[]} unlock 已解锁清单（本 feat 或游戏本地缓存；空数组=无清单）
 * @param {number} selId 存档目标（0=未选）；不在清单里时尾追一项，避免显示与存档不一致
 * @param {boolean} knownEmpty 服务器确定回了「无解锁配方」（与「还没读到」不同形）
 * @param {(id:number)=>string} labelOf id → 标签
 * @param {(id:number)=>string} markOf id → 额外标记（如「（缺料）」）
 * @returns {Array<{value:number, label:string}>}
 */
export function buildFormulaOptions(unlock, selId, knownEmpty, labelOf, markOf) {
  var ul = toIdList(unlock);
  var opts = [{ value: 0, label: '未选择（只领已完成的，不排产）' }];
  if (!ul.length) {
    opts.push({
      value: 0,
      label: knownEmpty
        ? '（服务器确认：当前无可生产配方——非机械大师或未点制药天赋）'
        : '（尚未读到解锁清单：点下方「↻ 读取可生产清单」）',
    });
  }
  var ids = ul.slice();
  var sel = Number(selId) || 0;
  if (sel > 0 && ids.indexOf(sel) < 0) ids.push(sel);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    // 「未解锁」只在手里有真清单时才打（无清单=无从判定，不打假标记）；此分支能命中的只有补进来的存档项
    var mark = ul.length && ul.indexOf(id) < 0 ? '（未解锁）' : markOf ? markOf(id) : '';
    opts.push({ value: id, label: (labelOf ? labelOf(id) : String(id)) + mark });
  }
  return opts;
}

/**
 * 面板动态选项（薄包装：取数据源 + 拼标签，判定本身在 {@link buildFormulaOptions}）。
 * 数据源两级递降，**本函数不发包**（它是 buildPanelHTML 求值链上的一环，在这里做网络副作用等于
 *   每个页面会话无条件读一次 1387）：
 *   1. `lastUnlock`：本 feat 读过的 1387 `unlock`（服务器权威）；
 *   2. `gameData.potionUnlockList()`：游戏本地缓存（玩家本场开过游戏内工厂面板时已有，零发包）；
 *   3. 两者都空 → 下拉给一条提示项，由「↻ 读取可生产清单」按钮显式触发 {@link probeUnlockForPanel}。
 * 缺料标记：仅 `resource` 类型的缺口才打——道具侧 `itemAmount` 无三态（读不到=0，与「真的没道具」同形），
 *   首屏未就绪时会全线假阳性，误导用户「都缺料」。
 * @param {?object} [cfg] 当前配置（wire.js 会传入 configs[f.id]，可缺省则不补存档项）
 * @returns {Array<{value:number, label:string}>}
 */
function formulaOptions(cfg) {
  var unlock = lastUnlock.length ? lastUnlock : gameData.potionUnlockList();
  var selId = cfg ? Number(cfg.formula) : 0;
  return buildFormulaOptions(unlock, selId, unlockKnownEmpty, formulaLabel, function (id) {
    var gap = rowGap(potionRow(id), resAmount, itemCnt);
    return gap && gap.reason === 'resource' ? '（缺料）' : '';
  });
}

/** @returns {boolean} 整功能闸（功能位读不到按未开处理：宁不动，也不撞无谓的拒绝） */
function functionOpen() {
  return gameData.functionOn(FUNCTION_KEY);
}

// ─────────────────────── 发包 ───────────────────────

/**
 * 权威读 1387（永不 reject）。失败/形态不符一律 ok=false —— 调用方据此**不发任何写动作**。
 * @returns {Promise<object>} readQueue 产物（ok=false 表示无从判定）
 */
async function fetchQueue() {
  if (!net) return readQueue(null);
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_INFO,
    {},
    {
      onError: function (err) {
        log.warn('cmd %d read threw: %s', CMD_INFO, err && err.message);
        threw = true;
      },
    },
  );
  if (threw) return readQueue(null);
  if (!aliveFn()) return readQueue(null);
  if (!ret || !ret.ok) {
    if (ret && ret.code === CODE_NOT_SENT) {
      // 未发出（同 cmd 在途去重，包括游戏自己开了面板在拉 1387）：随在途自然回收而自愈的跳过，按契约第 4 条走 debug，
      //   与 startMake/claimNow 对同一码的口径一致。但**不因此提频重试**：仍回 IDLE_POLL_MS 兜底，
      //   免得与游戏侧的 1387 轮询互相撞频控。真被拒 / 抛错 / 应答畸形仍走下条 warn（本轮零写动作的降级形态）。
      log.debug('cmd %d read not sent (in-flight), skip writes this round.', CMD_INFO);
    } else {
      log.warn(
        'cmd %d read failed, skip all write actions this round. code=%s;data=%s',
        CMD_INFO,
        ret && ret.code,
        rejectText(ret) || '-',
      );
    }
    return readQueue(null);
  }
  var q = readQueue(parseData(ret.data));
  if (!q.ok) {
    log.warn('cmd %d response malformed (no making object). data=%s', CMD_INFO, rejectText(ret));
  }
  return q;
}

/**
 * 排产 1388。永不 reject。
 * @param {number} id 配方 id
 * @returns {Promise<{ret:object, threw:boolean}>}
 */
async function sendMake(id) {
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_MAKE,
    { id: id },
    {
      onError: function (err) {
        log.warn('cmd %d make threw: %s', CMD_MAKE, err && err.message);
        threw = true;
      },
    },
  );
  return { ret: ret, threw: threw };
}

/**
 * 领取 1397（type 恒 1 = 制药 lane）。永不 reject。
 * @returns {Promise<{ret:object, threw:boolean}>}
 */
async function sendClaim() {
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_CLAIM,
    { type: POTION_PRODUCT_TYPE },
    {
      onError: function (err) {
        log.warn('cmd %d claim threw: %s', CMD_CLAIM, err && err.message);
        threw = true;
      },
    },
  );
  return { ret: ret, threw: threw };
}

// ─────────────────────── 状态机各分支 ───────────────────────

/**
 * 采纳一次权威读的副作用：刷新解锁缓存 + 判「队列态变了就解除领取拉黑」。
 * 解锁缓存只在应答真带出非空列表时覆盖：`unlock` 缺席（形态不符）与「确实一个都没解锁」在 readQueue 里
 *   同形（都是 []），拿 [] 覆盖会把面板刚列出的选项抹掉；而排产候选一向用当拍的 q.unlock（权威值），
 *   故缓存偏旧只影响列表展示，不会误排产。
 * @param {object} q readQueue 产物
 * @returns {string} 当前队列指纹 `id|state`
 */
function adopt(q) {
  if (Array.isArray(q.unlock) && q.unlock.length) {
    var wasEmpty = !lastUnlock.length;
    lastUnlock = q.unlock.slice();
    // 首批解锁清单到手，而面板的下拉还停在「只有首项」那一份（选项不随后重刷）：广播重建一次卡片。
    // 面板探测已先行填过 lastUnlock 时 wasEmpty 为假，不会重复播报。
    if (wasEmpty) pokePanel();
  }
  var key = q.id + '|' + q.state;
  if (claimBlocked && key !== claimBlockedKey) {
    claimBlocked = false;
    log.debug('claim blacklist lifted, queue changed to id=%d;state=%d', q.id, q.state);
  }
  return key;
}

/**
 * 领取分支：state===1（或到期复核后仍判该领）发 1397。
 * 成功 → 0（立刻再跑一轮去排产，不等兜底）；被拒 → 页内拉黑 + 兜底间隔，绝不循环重试。
 * @param {object} q 队列态
 * @param {string} why 触发口径（state=1 / expired）
 * @returns {Promise<number>} 下拍毫秒
 */
async function claimNow(q, why) {
  if (claimBlocked) {
    log.debug('claim skipped, blacklisted since id|state=%s (why=%s)', claimBlockedKey, why);
    return IDLE_POLL_MS;
  }
  var r = await sendClaim();
  if (!aliveFn()) return 0;
  var ret = r.ret;
  if (r.threw) return IDLE_POLL_MS; // 抛错已在 sendClaim 内 warn；下拍重读权威态
  if (ret && ret.ok) {
    log.info('claim ok (%s). id=%d', why, q.id);
    return 0;
  }
  if (!ret || ret.code === CODE_NOT_SENT) {
    log.debug('claim transient (not sent/in-flight), retry soon.');
    return TRANSIENT_RETRY_MS;
  }
  claimBlocked = true;
  claimBlockedKey = q.id + '|' + q.state;
  // 自然到期可能根本不需要 1397（录制零出现，属推断项）——拉黑等队列态变化即自愈，不循环重试
  log.info('claim rejected. code=%s;data=%s', ret.code, rejectText(ret) || '-');
  return IDLE_POLL_MS;
}

/**
 * 排产分支：队列空闲时先过「目标做得动吗」判定，全过才发 1388。
 * 不可作（未入制药线/未选择/未解锁/缺料）一律**不发写动作也不换配方**：一次只做一个药水，
 *   按兵等到用户改选或材料补齐为止（换配方会花掉用户没打算花的材料）。
 * @param {object} q 队列态（idle）
 * @returns {Promise<number>} 下拍毫秒
 */
async function startMake(q) {
  if (makeBlocked) return IDLE_POLL_MS; // 本轮已试过（被拒后不重复发）
  var chk = checkTarget(q.unlock, MCFG.formula, potionRow, resAmount, itemCnt, talentCareer);
  // 「行读不到」的 warn 闩：只在「本轮确实卡在 row 拒因且表就绪」时首遇打一次；
  //   复位口径 = 「本轮不是 row 拒因」（行读到了、或压根没走到行闸）——表就绪性闪烁不解除闩，免得反复 warn
  var rowMiss = !!(chk.gap && chk.gap.reason === 'row');
  if (rowMiss) {
    if (l10n.tableReady() && !warnedRowMiss) {
      warnedRowMiss = true;
      log.warn('potion table rows unavailable while table is ready. id=%d', chk.gap.id || 0);
    }
  } else {
    warnedRowMiss = false;
  }
  if (!chk.ok) {
    // 四个拒因都是「循环态不可动作」（等职业解锁 / 等用户选 / 等材料），按规范走 debug，带完整 gap 明细
    log.debug(
      'target not craftable, nothing sent. unlock=%d;%s',
      q.unlock.length,
      gapText(chk.gap),
    );
    return IDLE_POLL_MS;
  }
  makeBlocked = true;
  var r = await sendMake(chk.id);
  if (!aliveFn()) return 0;
  var ret = r.ret;
  if (r.threw) return IDLE_POLL_MS;
  if (ret && ret.ok) {
    var made = readQueue(parseData(ret.data));
    if (made.ok && made.producing) {
      log.info('make started. id=%d;st=%d;et=%d', made.id, made.st, made.et);
      if (cycle.pending) return 0; // 在飞期间有新触发（推送/改配置）：立刻带着新目标再跑一轮
      return nextDelayMs(made, gameData.serverTime());
    }
    // 受理但应答没带回可用队列态：立刻重读权威态，不拿猜值去睡
    log.info('make accepted without making in response. id=%d; re-reading now.', chk.id);
    return 0;
  }
  if (!ret || ret.code === CODE_NOT_SENT) {
    makeBlocked = false;
    log.debug('make transient (not sent/in-flight), retry soon. id=%d', chk.id);
    return TRANSIENT_RETRY_MS;
  }
  log.info('make rejected. id=%d;code=%s;data=%s', chk.id, ret.code, rejectText(ret) || '-');
  return IDLE_POLL_MS;
}

/**
 * 拒因/缺口描述 → 一行可读文本（debug 用，让日志流单轨可判「为什么没排产」）。
 * @param {?object} gap checkTarget 的 gap
 * @returns {string}
 */
function gapText(gap) {
  if (!gap) return '-';
  if (gap.reason === 'resource') {
    return 'id=' + gap.id + ' lacks resource ' + gap.resId + ' x' + gap.need + ', have ' + gap.have;
  }
  if (gap.reason === 'item') {
    return 'id=' + gap.id + ' lacks item ' + gap.itemId + ' x' + gap.need + ', have ' + gap.have;
  }
  if (gap.reason === 'row') return 'id=' + gap.id + ' config row unreadable';
  if (gap.reason === 'profession')
    return 'no recipe unlocked (not a mechanic / no potion talent learned)';
  if (gap.reason === 'unselected') return 'no target selected in panel';
  if (gap.reason === 'locked') {
    return (
      'id=' +
      gap.id +
      ' not unlocked by server' +
      (gap.career ? ', requires profession ' + gap.career : '')
    );
  }
  return 'id=' + (gap.id || 0) + ' reason=' + gap.reason;
}

/**
 * 单轮调和主体（createCycle 承载单飞闸门 + 触发合并 + 绝不停摆）：读态 → 该领就领 → 该排就排 → 否则睡到 et。
 * @returns {Promise<number>} 下拍间隔（毫秒）；<=0 立即再跑一轮
 */
async function cycleRun() {
  makeBlocked = false;
  if (!functionOpen()) {
    log.debug('gate off: FunctionOn(%s) not open, idle.', FUNCTION_KEY);
    return IDLE_POLL_MS;
  }
  var q = await fetchQueue();
  if (!aliveFn()) return 0;
  if (!q.ok) return IDLE_POLL_MS; // fail-safe：权威态读不到时本轮一个写动作都不发
  adopt(q);

  // 到期但 state 仍 0：push 10722 可能没到（客户端镜像滞后）→ 先重读一次拿权威态
  if (!q.claimable && q.producing && isExpired(q, gameData.serverTime())) {
    log.debug('queue past et without state, re-reading. id=%d;et=%d', q.id, q.et);
    q = await fetchQueue();
    if (!aliveFn()) return 0;
    if (!q.ok) return IDLE_POLL_MS;
    adopt(q);
    if (q.producing && !q.claimable && isExpired(q, gameData.serverTime())) {
      // 复读仍显示「到期未结算」：按推断语义试领一次即止（被拒即拉黑，不循环）
      return await claimNow(q, 'expired');
    }
  }

  if (q.claimable) return await claimNow(q, 'state=1');
  if (q.idle) return await startMake(q);
  if (cycle.pending) return 0;
  return nextDelayMs(q, gameData.serverTime());
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取兜底轮询，防异常停摆） */
const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_POLL_MS });

/**
 * 安装：取网络底座。缺失即失败（reactor 不激活）。游戏符号一律经 game-api ACL 现取，不在此摸。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  net = ctx.net;
  if (!net || !net.install || !net.install()) {
    net = null;
    log.warn('install failed: pocketcc.net unavailable');
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入：整体接收 toModuleCfg 产物（绝不二次归一），运行中即时唤醒一轮让新目标生效。
 * @param {object} partial {formula:number}
 * @returns {object} MCFG
 */
function configure(partial) {
  if (partial) MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：复位页内态 → 挂完成推送唤醒 → 点火。
 * 推送只当「醒一次去重读」的提示，载荷不入状态（level-triggered，丢推送由 et 定时醒兜底）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  makeBlocked = false;
  claimBlocked = false;
  claimBlockedKey = '';
  ctx.on.push(PUSH_MAKE, function () {
    cycle.kick();
  });
  log.info('started. target=%d;unlock=%d', MCFG.formula, lastUnlock.length);
  cycle.kick();
}

/**
 * 停用：清本轮排产标志（触发器摘除与在飞退出由 reactor 统一负责，cycle 无自建定时器需要收）。
 */
function pause() {
  makeBlocked = false;
}

/**
 * 向 reactor 注册本功能说明书：地图限定基地/大世界（base/world），常态本服（homeland），战斗模式暂停。
 * 面板只出「制药目标」一项（**单选**，0=未选择则不排产）；轮询间隔/到期缓冲/ProductType 均为内置常量，
 *   与 armory-material「内置常量优先、少暴露旋钮」同口径。
 */
reactor.register({
  id: 'potionCraft',
  label: '机械制药',
  storageKey: 'pocketcc.feat.potionCraft',
  symbols: ['dataCenter', 'tableManager', 'tableName', 'gameDefine'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: { enabled: false, formula: 0 },
  fields: [
    {
      key: 'formula',
      label: '制药目标',
      type: 'select',
      options: formulaOptions,
      hint: '单选一个要自动制作的药水：选项只列真正可生产的药品（服务器 1387 的 unlock 清单，本 feat 读过就用、没读过则点下方按钮现读一次；不拿配方表的 level==1 基线行猜档位）；排产前逐次判「材料够不够 + 这个配方服务器解没解锁」，两条不过就原地等、不换别的配方。一次只做一瓶，48 小时一单的队列不花钻石加速',
    },
    {
      key: 'probeUnlock',
      type: 'button',
      label: '↻ 读取可生产清单',
      busyText: '读取中…',
      onClick: function () {
        return probeUnlockForPanel();
      },
    },
  ],
  toModuleCfg: function (c) {
    var n = Number(c.formula);
    return { formula: n > 0 ? n : 0 };
  },
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
