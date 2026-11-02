/**
 * 军火库生产材料（reactor 说明书形态）
 *
 * 玩法：全自动运转「军火库材料生产」——到期即收割已完成产物，队列有空位就补满。
 *   每个空槽都重算「当前持有最少」的家族基础料并排产它。稀缺度按融合链把所有等级折算成基础料等价单位求和，
 *   并把在途队列按每单产量（920002）投影计入持有——即「排队中的家族也算上它即将到手的量」。
 *   投影按真实产量计（每条 = 一单产量），故当某家族显著比其余稀缺（差距 > 单槽投影×剩余槽数）时，
 *   允许把多个槽连排同一种直到追平（口径经用户确认：严格「取最少者」，不强制摊开分散）。
 *
 * 协议（源码 RequestId 实证，均走 net.send 旧 JSON 链路，ret.data 为原始 JSON 串需自 parse）：
 *   1643 ARMYEQUIP_NEW_MATERIAL_PRODUCE  {itemId} → 应答 d={st,wait:[...]}（最新队列，权威）
 *   1645 ARMYEQUIP_NEW_MATERIAL_PRODUCE_GET {} → 收割到期产物（应答含 reward，附最新 st/wait）
 *
 * 数据来源（只读游戏态）：
 *   可生产集 = ITEM 表 type=85(ArmyMaterial) && quality=1 的行（每家族仅最低级基础料可生产）；
 *   融合链   = 某行 para1(合成到下一级所需数量，缺省 4) → para2(下一级 itemId)，逐级折成基础料系数；
 *   持有量   = UserData.getItemAmount(itemId)；队列初始种子 = UserData.ArmyEquipSystemMeterial（{st,wait}）。
 *   等级判定 = 镜像游戏 getProductRedPointShow：新手调整开关 FunctionOn(key_novice_adjustments) 开启且
 *              UserData.Level < DATACONFIG 920004 时生产未解锁，此时不补产（收割读态无害，保持运行）。
 *
 * 关键工程点：客户端镜像 ArmyEquipSystemMeterial 仅在游戏自身面板/控制器的应答回调里刷新；
 *   面板未开时本 feat 自发协议的应答不会驱动该镜像更新。故 feat 自持一份 shadow（{st,wait}），
 *   镜像在场时以它为初值、其余一律用本 feat 收到的应答覆盖，跨周期持久，靠 createCycle 自愈纠偏。
 *
 * 生命周期由 reactor 托管：install/run 两钩子，places 限定 base/world（Home/NWorldMap），战斗模式暂停（offInCombat）。
 */
import { parseData } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ARMORY-MATERIAL） */
const log = createLog('ARMORY-MATERIAL');

/** @type {number} RequestId.ARMYEQUIP_NEW_MATERIAL_PRODUCE，排一条材料进生产队列 */
const CMD_PRODUCE = 1643;

/** @type {number} RequestId.ARMYEQUIP_NEW_MATERIAL_PRODUCE_GET，收割已到期的产物 */
const CMD_PRODUCE_GET = 1645;

/** @type {number} 生产队列上限（源码 MaterialPanel.m_maxCount=5） */
const MAX_QUEUE = 5;

/** @type {number} ItemType.ArmyMaterial（军火库材料类型），可生产集过滤键 */
const ARMY_MATERIAL_TYPE = 85;

/** @type {number} 可生产的最低等级品质（融合链头，quality=1） */
const BASE_QUALITY = 1;

/** @type {number} DATACONFIG 键：每单生产耗时（秒），收割到期判据用 */
const CFG_PRODUCE_TIME = 920001;

/** @type {number} DATACONFIG 键：每单产量（基础料单位），在途投影折算用 */
const CFG_YIELD = 920002;

/** @type {number} DATACONFIG 键：新手调整开启时开放生产的玩家等级门槛（源码 getProductRedPointShow 实证） */
const CFG_UNLOCK_LEVEL = 920004;

/** @type {string} FunctionKey.key_novice_adjustments（枚举名即字符串值）：新手调整功能开关，开且等级不足则锁产 */
const NOVICE_SWITCH = 'key_novice_adjustments';

/** @type {number} 融合比缺省值（行缺 para1 时按 4 个本级合成 1 个上级） */
const DEFAULT_FUSION_RATIO = 4;

/** @type {number} 融合链展开的层数上限（环/异常配置保护） */
const MAX_CHAIN_DEPTH = 16;

/** @type {number} 单个生产周期内最多收割次数（一次收一条，队列最多 5 条，留冗余） */
const MAX_HARVEST_PER_CYCLE = MAX_QUEUE;

/** @type {number} 睡到队首到期时刻后额外留出的缓冲（毫秒）：补偿 setTimeout 节流/时钟抖动，避免早醒一拍空转 */
const HARVEST_BUFFER_MS = 5000;

/** @type {number} 下拍唤醒的最小间隔（毫秒）：到期判据抖动（remainMs≈0）时兜底，防紧循环 */
const MIN_WAKE_MS = 3000;

/**
 * 内置调优常量（面板仅出启用开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {
  /** 兜底轮询间隔（默认 30 秒）：仅在拿不到可靠队列态（空队列 / st 未初始化 / 取不到耗时配置）时用作唤醒兜底；
   *  有在产料时 cycleRun 会直接睡到队首到期（见 nextWakeDelayMs），不再固定 30 秒轮询 */
  cycleInterval: 1000 * 30,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {object|null} reactor 上下文；alive() 反映运行态，pause 后在飞流程自然退出 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {object|null} TableManager.TABLE 单例（配置表读） */
var tableMgr = null;
/** @type {string} ITEM 表名（TableName.ITEM，解析失败兜底 'item'） */
var ITEM_TABLE = 'item';
/** @type {object|null} DataCenter.DATA（ServerTime / UserData 只读入口） */
var dataCenter = null;
/** @type {object|null} GameTools（getDataConfigData 读生产耗时/产量配置） */
var gameTools = null;

/**
 * feat 自持的队列影子态（跨周期持久）：镜像不在场时以此为准，收到的应答覆盖它。
 * @type {{st:number, wait:number[]}}
 */
var shadow = { st: 1, wait: [] };

/**
 * 疑似队列已满标志：PRODUCE 被服务器拒（满员/param error）时置真，停止后续补产，
 * 直到一次收割（1645）应答显式返回短于上限的 wait（腾出了槽位）才清除。
 * 防「客户端镜像读不到真实队列、误判有空槽 → 满员仍反复发 1643 刷屏」。
 * @type {boolean}
 */
var blocked = false;

/**
 * 播种标志：镜像仅在页面生命周期内首次 run() 时取作起点一次；pause→resume 重入不得用可能缺失/陈旧的镜像清空已积累的权威 shadow。
 * @type {boolean}
 */
var seeded = false;

/**
 * 启动/点火权威读标志：每次 run() 置 false，首轮 cycle 先发一次 1645 拿当前 {st,wait}（应答恒含队列）再决定是否补产，
 * 杜绝队列已满时启动盲发 1643（用户反馈的启动刷屏）。置 true 后本点火不再强制，退回常规到期收割。
 * @type {boolean}
 */
var synced = false;

/**
 * 功能是否仍在运行（在飞流程与循环的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ─────────────────────── 游戏态只读访问（try/catch 降级） ───────────────────────

/** @returns {object|null} DataCenter.DATA（注：dataCenter 本身已是 DATA，勿再取 .DATA） */
function data() {
  try {
    return dataCenter || null;
  } catch (e) {
    return null;
  }
}

/** @returns {object|null} DATA.UserData */
function userData() {
  var d = data();
  try {
    return (d && d.UserData) || null;
  } catch (e) {
    return null;
  }
}

/** @returns {number} 当前服务器时间（秒）；取不到 0 */
function serverTime() {
  var d = data();
  try {
    return Number(d.ServerTime) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 客户端生产队列镜像（原始值，可能为 null——面板从未开过则未初始化）。
 * @returns {{st:number, wait:number[]}|null} 有镜像返回浅拷贝，无镜像返回 null
 */
function rawMeterial() {
  var u = userData();
  try {
    var m = u && u.ArmyEquipSystemMeterial;
    if (m && Array.isArray(m.wait)) return { st: Number(m.st) || 0, wait: m.wait.slice() };
  } catch (e) {}
  return null;
}

/**
 * 当前生效队列态 = feat 自持 shadow（唯一真相），返回浅拷贝。
 * 客户端镜像 ArmyEquipSystemMeterial 只由游戏面板应答回调刷新，本 feat 的 net.send 不触发它，
 * 若每周期回读会拿到陈旧值进而误判「有空槽」，故仅在 seedShadow() 一次性取作初值，
 * 运行期一律以本 feat 收到的 1643/1645 应答为准。
 * @returns {{st:number, wait:number[]}} shadow 的浅拷贝
 */
function currentState() {
  return { st: shadow.st, wait: shadow.wait.slice() };
}

/**
 * 一次性播种影子态：镜像在场（说明面板本次会话真同步过）则采其值作起点，否则维持空态；并清 blocked。
 * 只在 run() 点火时调用一次，避免陈旧镜像反复覆盖 shadow。
 */
function seedShadow() {
  if (seeded) return; // 页内仅播种一次：resume 重入保留权威 shadow，不用可能为空的镜像覆盖
  seeded = true;
  var m = rawMeterial();
  shadow = m ? { st: m.st, wait: m.wait } : { st: 1, wait: [] };
  blocked = false;
}

/**
 * 道具背包持有量（UserData.getItemAmount，只读）。
 * @param {number|string} itemId 道具 id
 * @returns {number} 持有数量；不可用回 0
 */
function itemAmount(itemId) {
  var u = userData();
  if (!u || typeof u.getItemAmount !== 'function') return 0;
  try {
    return Number(u.getItemAmount(+itemId)) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * DATACONFIG 数值读取（生产耗时/每单产量）；不可用回默认。
 * @param {number} key 配置 id
 * @param {number} def 兜底值
 * @returns {number}
 */
function configNum(key, def) {
  try {
    if (gameTools && typeof gameTools.getDataConfigData === 'function') {
      var v = Number(gameTools.getDataConfigData(key));
      if (v > 0) return v;
    }
  } catch (e) {}
  return def;
}

/**
 * 生产是否已开放：镜像游戏 getProductRedPointShow 的等级判定——
 * 新手调整开关（FunctionOn key_novice_adjustments）开启且玩家等级 < DATACONFIG 920004 时锁产。
 * 取不到配置（回 0）或非新手调整场景时默认放行（仅在确知存在正门槛且等级不足时才锁，避免误锁）。
 * @returns {boolean} 可生产返回 true；未解锁返回 false
 */
function productionUnlocked() {
  var u = userData();
  if (!u) return false;
  try {
    var noviceOn = typeof u.FunctionOn === 'function' && u.FunctionOn(NOVICE_SWITCH) === true;
    var needLv = configNum(CFG_UNLOCK_LEVEL, 0);
    if (noviceOn && needLv > 0 && (Number(u.Level) || 0) < needLv) return false;
  } catch (e) {}
  return true;
}

/**
 * ITEM 表单行（按 id）。
 * @param {number|string} id 道具 id
 * @returns {object|null}
 */
function tableRow(id) {
  try {
    return (tableMgr && tableMgr.getTableDataById(ITEM_TABLE, String(id))) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 可生产的基础料行数组：ITEM 表 type=85 且 quality=1（每家族一个）。
 * @returns {object[]}
 */
function producibleBases() {
  try {
    return (
      (tableMgr &&
        tableMgr.getTableByKey(ITEM_TABLE, 'type', ARMY_MATERIAL_TYPE, 'quality', BASE_QUALITY)) ||
      []
    );
  } catch (e) {
    return [];
  }
}

// ─────────────────────── 稀缺度算法 ───────────────────────

/**
 * 某家族（以基础料 id 为链头）折算成基础料等价单位的持有总量。
 * 沿 para2 走融合链，逐级 value = ∏(各级 para1)：基础料 value=1，二级=para1，三级=para1×para1...
 * 高等级融合料据此计为大量基础单位，不会被误判为稀缺。带环保护与层数上限。
 * @param {number} baseId 家族基础料（quality=1）id
 * @returns {number} 归一化持有量（基础料等价单位）
 */
function familyNormalizedHoldings(baseId) {
  var total = 0;
  var value = 1; // 当前等级折成基础料的系数
  var cur = baseId;
  var seen = new Set();
  var guard = 0;
  while (cur != null && cur > 0 && guard++ < MAX_CHAIN_DEPTH) {
    if (seen.has(cur)) break; // 环保护
    seen.add(cur);
    var row = tableRow(cur);
    if (!row) break;
    total += itemAmount(cur) * value;
    var ratio = Number(row.para1) > 0 ? Number(row.para1) : DEFAULT_FUSION_RATIO;
    var next = Number(row.para2);
    if (!(next > 0) || next === cur) break; // 链尾
    value *= ratio;
    cur = next;
  }
  return total;
}

/**
 * 选出下一槽该生产的家族基础料 id：家族归一持有 + 在途队列投影（该家族排队条数 × 每单产量），
 * 取投影最小者；并列最小按基础料 id 升序定序（确定性）。
 * @param {number[]} wait 当前队列（含本轮已排入的投影）
 * @returns {number|null} 该排的基础料 id；无可生产集回 null
 */
function scarcestBase(wait) {
  var bases = producibleBases();
  if (!bases || !bases.length) return null;
  var perYield = configNum(CFG_YIELD, 1);
  // 统计各基础料在队列中的条数（wait 里存的就是基础料 id）
  var queuedCount = {};
  for (var i = 0; i < wait.length; i++) {
    var id = Number(wait[i]);
    if (id > 0) queuedCount[id] = (queuedCount[id] || 0) + 1;
  }
  var best = null;
  var bestScore = Infinity;
  for (var j = 0; j < bases.length; j++) {
    var b = Number(bases[j].id);
    if (!(b > 0)) continue;
    var score = familyNormalizedHoldings(b) + (queuedCount[b] || 0) * perYield;
    if (score < bestScore || (score === bestScore && best != null && b < best)) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

// ─────────────────────── 生产/收割动作 ───────────────────────

/**
 * 到期收割：满足 canHarvest 判据（st!=1 && wait 非空 && 耗时+st-服务器时间<0）即发 1645。
 * 逐条收，最多 MAX_HARVEST_PER_CYCLE 次；应答带最新 st/wait 则更新 shadow，否则以镜像/原态纠偏。永不 reject。
 * @returns {Promise<void>}
 */
async function harvestDue() {
  var produceTime = configNum(CFG_PRODUCE_TIME, 0);
  for (var n = 0; n < MAX_HARVEST_PER_CYCLE && aliveFn(); n++) {
    var s = currentState();
    var haveSt = produceTime > 0 && s.st !== 1 && s.wait.length > 0;
    var dueByTime = haveSt && produceTime + s.st - serverTime() < 0;
    // 首轮强制权威读：1645 应答恒含当前 {st,wait}，先判队列是否已满，杜绝启动时盲发 1643（用户诉求）
    // 之后：有可靠 st 且到期 → 收；无可靠 st 但队列有在产料或疑似满员 → 试发一次让服务端到期收割并回带权威态自愈
    var forceSync = !synced;
    var shouldProbe = !haveSt && (blocked || s.wait.length > 0);
    if (!dueByTime && !forceSync && !shouldProbe) return;
    if (net.isSending(CMD_PRODUCE_GET)) return;
    var harvestThrew = false;
    var ret = await net.sendGuarded(
      CMD_PRODUCE_GET,
      {},
      {
        onError: function (e) {
          log.warn('harvest send threw.', e);
          harvestThrew = true;
        },
      },
    );
    if (harvestThrew) return;
    if (!aliveFn()) return;
    synced = true; // 点火后已完成一次权威读，不再强制；失败则退回 produce 试探（由 blocked 兜底）
    var d = parseData(ret && ret.data);
    // 显式判 object：parseData 归口守卫版后非 object 恒返 null，此处不依赖其内部约定
    if (ret && ret.ok && d && typeof d === 'object') {
      if (d.st != null) shadow.st = Number(d.st) || 0;
      if (Array.isArray(d.wait)) shadow.wait = d.wait.slice();
      log.debug('harvest/sync. code=%d;waitRemain=%d', ret.code, shadow.wait.length);
      // 解除闸门：应答带回短于上限的 wait，或虽无 wait 但确有 reward（收割成功即腾槽），避免形态不符时永久锁死
      if (Array.isArray(d.wait) ? d.wait.length < MAX_QUEUE : !!d.reward) blocked = false;
    } else {
      // 无到期项/被拒：结束本轮（正常到期路径记 info，blocked 无 st 的探测路径静默）
      if (haveSt) log.info('harvest no-op/rejected. code=%s', ret && ret.code);
      return;
    }
  }
}

/**
 * 补满队列：队列不足 MAX_QUEUE 时逐个排入「当前持有最少」的基础料。以 shadow/镜像 wait 起步，
 * 每次用 1643 应答返回的权威 wait 继续下一槽（故在途投影即时生效；最缺家族差距大时可连排数槽，符合「取最少者」口径）。串行 await。
 * @returns {Promise<void>}
 */
async function fillQueue() {
  if (blocked) return; // 疑似满员：停止补产，等收割腾槽后由 harvestDue 解除
  if (!productionUnlocked()) {
    log.debug('produce locked: novice switch on & level < %d', CFG_UNLOCK_LEVEL);
    return;
  } // 等级判定：新手调整未达门槛不补产（镜像游戏锁产）
  var queue = currentState().wait.slice();
  var guard = 0;
  while (queue.length < MAX_QUEUE && aliveFn() && guard++ < MAX_QUEUE) {
    var base = scarcestBase(queue);
    if (base == null) {
      log.debug('no producible base.');
      return;
    }
    if (net.isSending(CMD_PRODUCE)) return;
    var produceThrew = false;
    var ret = await net.sendGuarded(
      CMD_PRODUCE,
      { itemId: base },
      {
        onError: function (e) {
          log.warn('produce send threw.', e);
          produceThrew = true;
        },
      },
    );
    if (produceThrew) return;
    if (!aliveFn()) return;
    var d = parseData(ret && ret.data);
    if (ret && ret.ok && d && typeof d === 'object' && Array.isArray(d.wait)) {
      queue = d.wait.slice();
      shadow.wait = queue;
      if (d.st != null) shadow.st = Number(d.st) || 0;
      log.debug('produce queued. itemId=%d;queue=%d', base, queue.length);
    } else if (ret && !ret.ok) {
      // 服务器明确拒绝（满员 common_159995 / param error 等）：认定队列已满，置 blocked 停止后续补产，
      // 等下一次收割（1645）成功腾槽再解除——杜绝满员时反复发 1643 刷屏。
      blocked = true;
      log.info(
        'produce rejected, assume queue full -> halt until harvested. itemId=%d;code=%s',
        base,
        ret && ret.code,
      );
      return;
    } else {
      // 应答 ok 但形态异常（缺 wait）：无法确证槽位，保守结束本轮但不锁闸门（非满员拒绝，不应误当已满）
      log.warn('produce ack malformed (no wait). itemId=%d', base);
      return;
    }
  }
}

/**
 * 计算下拍唤醒延时：游戏判定某个槽位是否到期只看 `produceTime + st <= serverTime`（st=当前生产头的服务器起始时刻），
 * 故队列有在产料且 st 可靠时，直接睡到队首到期时刻再加缓冲去收割，不必固定 30 秒轮询；
 * 拿不到可靠态（空队列 / st=1 未初始化 / 取不到耗时配置）时退回 cycleInterval 兜底。
 * @returns {number} 下拍间隔（毫秒）；<=0 由 createCycle 立即再跑
 */
function nextWakeDelayMs() {
  var s = currentState();
  var produceTime = configNum(CFG_PRODUCE_TIME, 0);
  if (produceTime > 0 && s.st !== 1 && s.wait.length > 0) {
    var remainMs = (produceTime + s.st - serverTime()) * 1000; // 队首距到期的毫秒（与 harvestDue 同判据）
    if (remainMs <= 0) return MIN_WAKE_MS; // 本轮未收走（满员闸门/异常）：短隔后再试，不空转
    return Math.max(remainMs + HARVEST_BUFFER_MS, MIN_WAKE_MS); // 睡到到期 + 缓冲
  }
  return cfg.cycleInterval;
}

/**
 * 单轮调和主体（core/cycle 承载单飞闸门 + 触发合并 + 绝不停摆）：先收割到期，再补满队列。
 * @returns {Promise<number>} 下拍间隔（毫秒）；在飞攒到触发则立即补扫
 */
async function cycleRun() {
  await harvestDue();
  if (!aliveFn()) return 0;
  await fillQueue();
  if (cycle.pending) return 0;
  return nextWakeDelayMs();
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取 cycleInterval，防异常停摆） */
const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: cfg.cycleInterval });

/**
 * 安装：取网络底座 + 游戏数据/配置表/工具模块。任一缺失即失败（reactor 不激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;

  var missing = [];

  net = ctx.net;
  if (!net || !net.install || !net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  var tmMod = game.get('TableManager');
  tableMgr = (tmMod && tmMod.TABLE) || null;
  if (!tableMgr) missing.push('TableManager.TABLE');

  var tnMod = game.get('TableName');
  var tnEnum = tnMod && (tnMod.TableName || (tnMod.default && tnMod.default.TableName));
  if (tnEnum && tnEnum.ITEM) ITEM_TABLE = tnEnum.ITEM; // 取不到保留兜底 'item'

  var dcMod = game.get('DataCenter');
  dataCenter = (dcMod && dcMod.DATA) || null;
  if (!dataCenter) missing.push('DataCenter.DATA');

  var gtMod = game.get('GameTools');
  gameTools = gtMod && gtMod.default ? gtMod.default : gtMod;
  if (!gameTools || typeof gameTools.getDataConfigData !== 'function') missing.push('GameTools');

  if (missing.length) {
    net = null;
    tableMgr = null;
    dataCenter = null;
    gameTools = null;
    log.warn('install failed. missing=%d;deps=%s', missing.length, missing.join(';'));
    return false;
  }

  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行：复位影子态，启动循环点火（之后由兜底定时驱动）。
 * reactor pause 置 alive=false 后循环自然停摆；resume 重新点火（cycle.kick 内部先清旧定时器，不会重复）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  seedShadow();
  synced = false; // 每次点火（含 resume）都重做一次权威读，拾取外部变更后的真实队列态
  log.info('started. queue=%d', shadow.wait.length);
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：places 限定 base/world（Home/NWorldMap），战斗模式暂停（offInCombat）。
 * 面板仅出启用开关；轮询/队列上限/融合折算均为上方内置常量，不作为可持久化配置项（与 domainTreasure 同口径）。
 */
reactor.register({
  id: 'armoryMaterial',
  label: '军火库生产材料',
  storageKey: 'pocketcc.feat.armoryMaterial',
  symbols: ['tableManager', 'tableName', 'dataCenter', 'gameTools'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: { enabled: false },
  fields: [],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
