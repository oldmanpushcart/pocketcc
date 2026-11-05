/**
 * 占领发射井（GunFight / LaunchTower）- 自动驻军 + 自动领积分（reactor 说明书形态）
 *
 * 「占领发射井」是与「首府占领(Throne/Kingdom)」并列的独立活动，仅共用底层代码；内部代号 GunFight、UI 名 LaunchTower。
 * 每周二 21:00 开启、持续 2 小时：4 个发射井(id 4001~4004)由黑暗军团初始占领，联盟需先战胜才能占领；
 * 联盟按累计占领时长排行，个人按占领/杀敌/击败黑暗军团得积分，积分达档位可领奖。
 * 本功能做两件事：①把「归属本联盟」的井派最小部队入驻（不打野、不主动攻打他人井）；②按档位自动领个人积分奖励。
 * 收尾：个人积分刷满（total≥最高档且全档已领）即视为本期结束——主动撤回驻井部队(904)、放行 auto-farm 照常回填、
 *   本期不再驻军/领奖，只保持窗口探测直到活动 end 复位等下一期。
 *
 * 依据（反编译常量 + 三份实机报文 dashcam 双重验证，详见 references/游戏逆向/占领发射井分析报告.md）：
 *   协议（均走旧 JSON NET.send，应答 data 为 JSON 串需 parse）：
 *     1055 GET_GUN_FIGHT_INFO {} → {start,end,cur,list:[{id,owner(联盟aid),ownuid,tag,name,totem,time}]}（活动信息 + 4 井归属）
 *     1057 GET_GUN_FIGHT_USER_INFO {} → {total,os,ks,gs,us,reward:[]}（个人积分 + 已领档位 num 列表）
 *     1058 GET_GUN_FIGHT_USER_REWARD {score:num} → 实发奖励（score 即档位门槛值；积分不足时游戏客户端本地拦截、不发此包）
 *     902  MARCH_WORLD_POINT {marchType:35,x,y,armyList...} → 驻军行军；应答 marchInfo.target{itemId:4001~4004,targetType:10}
 *     904  RECALL_MARCH {marchId} → 撤回单条行军（撤田腾队列用）
 *   推送：11017 GUN_FIGHT_INFO（单井归属增量，触发重扫驻军）；10029 GUN_FIGHT_REWARD_INFO（个人积分/已领刷新，触发领奖）；
 *         10019 USER_MARCH_INFO（本人行军状态，state=4 ARRIVED_HOME 才释放名额，据此唤醒补派）。
 *   档位门槛数据源：DATACONFIG[130118].value，格式 "num,rewardId|num,rewardId|..."；面板内联兜底串见 TIERS_FALLBACK。
 *   井坐标：1055 list 不含坐标，须按 id 读配置表 tableThrone（新图 THRONE_v2、旧图 THRONE，行含 pos_x/pos_y）。
 *
 * 队列与撤田（与 auto-farm 的争抢收敛口径，无跨 feat 预约账本）：
 *   全局行军名额读 UserData.myMarchNumMAX - myMarchNum（跨场景可靠，走 core/march.freeSlots）。
 *   撤田为面板可选项 recallFarm（默认开）：仅当「需驻军且名额不足」且勾选撤田时才撤田，且一次只撤 1 条——优先撤「还在去程路上」(state=MARCHING)的下田行军（浪费最少、返家最快）；
 *   关闭撤田则不主动撤田，待驻井只在有空闲名额时入驻。
 *   撤回不立即释放名额，须返程 state=4 到家才释放；该田到家的瞬间名额空出，存在 auto-farm 尚未回填的「空窗期」——
 *   本 feat 在 march.onHomeReturn 里认出「自己为腾位撤的那条田」到家，走快路径直接补驻一口井（一跳 902，跳过 1055/856），抢在 auto-farm 前占位。
 *   若抢输（名额被 auto-farm 抢先 / 902 被拒），该井留待驻队列、下轮再撤 1 条田重试，直至驻满。
 *   "田"＝资源采集行军：判据以 marchType 3/26 为准（普通田 3 / 机械田 26），显式排除驻井 35、领域寻宝挖矿 180 与**遗迹田（6 级田）**。
 *   遗迹田永不撤是与 auto-farm 同口径的全局不变量（判据走 core/resource.isRelicTarget，不依赖对方候选池是否已扫过）：
 *   6 级田只由遗迹刷新邮件批量开出、4 小时即到期，撤一趟往返就赶不上本期剩下的采集窗。
 *
 * 生命周期由 reactor 托管：install/run 两个钩子，places 门控限定 base/world（Home/NWorldMap），战斗模式暂停（offInCombat）。
 *   驻军/领积分为内置默认行为；撤田腾队列为面板可选项（recallFarm，默认勾选）。
 *   驻军/撤田读本人行军走 core/march.list()（封装 856 GET_ALL_MY_MARCH_INFO，视口无关、Home 亦有全量；不再依赖 mapData.marches）。
 */
import { parseData, sleep, rejectText } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { l10n, gameConf, gameData } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { isRelicTarget } from '../../core/resource.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=LAUNCH-SILO） */
const log = createLog('LAUNCH-SILO');

/** @type {number} RequestId.GET_GUN_FIGHT_INFO：活动信息 + 4 井归属（JSON send，{}） */
const CMD_GET_GUN_FIGHT_INFO = 1055;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_INFO：个人积分与已领档位（JSON send，{}） */
const CMD_GET_GUN_FIGHT_USER_INFO = 1057;
/** @type {number} RequestId.GET_GUN_FIGHT_USER_REWARD：领取某档位积分奖励（JSON send，{score:num}） */
const CMD_GET_GUN_FIGHT_USER_REWARD = 1058;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（驻军）——仅用于发驻军前的同 cmd 在途频控 */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {number} ResponseId.PUSH_GUN_FIGHT_INFO（=11017）：单井归属/占领增量推送 */
const PUSH_GUN_FIGHT_INFO = 11017;
/** @type {number} ResponseId.PUSH_GUN_FIGHT_REWARD_INFO（=10029）：个人积分/已领档位刷新推送 */
const PUSH_GUN_FIGHT_REWARD_INFO = 10029;

/**
 * 行军类型：驻军发射井（MarchType.GUN_FIGHT=35，WorldMapCommon/NWorldMapMarchCommon 枚举）。
 * PvE/PvP 占领井行军不参与跨服攻玩家城的 marchType 漂移，直接用固定值（同 domain-treasure 用 180 的口径）。
 * @type {number}
 */
const MARCH_TYPE_GUN_FIGHT = 35;
/** @type {number} 行军类型：领域寻宝挖矿（永不纳入撤田候选） */
const MARCH_TYPE_DOMAIN_TREASURE = 180;

/** @type {number} DataConfig：个人积分档位表（"num,rewardId|num,rewardId|..."，num=积分门槛） */
const CFG_TIERS_KEY = 130118;
/** @type {string} 档位兜底串：DATACONFIG 取不到时用面板内联值（实证门槛集） */
const TIERS_FALLBACK =
  '10,9018101|50,9018102|100,9018103|200,9018104|400,9018105|700,9018106|1200,9018107';

/**
 * 内置调优常量（面板仅出功能开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {
  /** 活动窗口内兜底扫描间隔（毫秒）：驻军主要靠 11017 归属/回城 push 即时唤醒，本值仅作断推兜底（旧 60s→20s） */
  activeScanInterval: 1000 * 20,
  /**
   * 非活动期的「周期复查上限」（毫秒）：离开启还远时按此周期低频探活（兼捕获排期变化）；
   * 进入末段则由 cycleRun 改为按 (start−cur) 精确睡到开启点。10 分钟。
   */
  idleScanInterval: 1000 * 60 * 10,
  /** 睡到开启点时提前量（毫秒）：在 start 前这么久醒，避免踩点读到的 cur 仍略早于 start */
  openWakeLeadMs: 3000,
  /** 睡到开启点的最小睡眠（毫秒）：临近开启时的下限，防 (start−now) 很小导致紧密空转 */
  openWakeMinMs: 1000 * 10,
  /** 逐条驻军 902 之间的休眠（毫秒）：规避 902 限流（同 titan-blessing） */
  marchInterval: 1000 * 5,
  /** 逐条撤田 904 之间的休眠（毫秒）：秒量级（旧值 1000*400=400秒系手滑，会把后续驻军串在几分钟后才撤） */
  recallInterval: 1000 * 2,
  /** 逐条领 1058 之间的休眠（毫秒）：纯为不打爆 1058 频控（旧值 10min 系手滑，会把驻军串在后面拖慢） */
  claimInterval: 1000 * 3,
  /**
   * 1057 积分查询的兜底最小间隔（毫秒）：领奖与驻军解耦——1057 只在收到 10029 积分刷新 push（即时）
   *   或距上次查询超此兜底间隔时发起，不再搭驻军唤醒（11017 归属变化 / 撤田到家 10019）的顺风车。
   */
  rewardScanMinGap: 1000 * 60,
  /** 回城/归属推送补扫的最小间隔（毫秒）：合并突发推送，免 1055 风暴 */
  pushScanMinGap: 1000 * 4,
  /**
   * 关闭期「睡向下次开启」的单拍上限（毫秒）：已证实 1055 在关闭期即返回下期 start（固定周二 21:00 周活、不漂移），
   * 故无需按 idle 每 10min 探活——直接成段睡向 start，仅以此上限兜住「服务器时钟漂移 / 单定时器过大」，醒一次即重读 cur 再校准。24 小时。
   */
  startSleepMaxMs: 1000 * 60 * 60 * 24,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（读 UserData 联盟 aid/UID/服务器时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞流程自然退出 */
var ctxRef = null;

/**
 * configure 推入的模块配置（面板经 toModuleCfg 透传）；缺省与 defaults 口径一致：默认允许撤田腾队列
 * @type {{recallFarm:boolean}}
 */
var modCfg = { recallFarm: true };

/**
 * 扫描单飞闸门 / 触发合并 / 兜底定时器均收口到 core/cycle（见下方 cycle 实例）；
 * feat 只保留活动窗口态 inWindow（决定 active/idle 两档）供 cycleRun 返回下拍间隔。
 */
/** @type {number} 上次因推送补扫的墙钟时刻（毫秒），合并突发 */
var lastPushScanAt = 0;
/** @type {number} 上次发起 1057 积分查询的墙钟时刻（毫秒）；配合 rewardScanMinGap 给领奖节流 */
var lastRewardScanAt = 0;
/** @type {boolean} 收到 10029 积分刷新 push 置真：下轮 cycleRun 无视兜底间隔立即领奖一次 */
var rewardDirty = false;
/** @type {boolean} 是否收到驻军相关边沿(11017 归属变化 / 自家撤田到家)需立即复查驻军；配合 activeScanInterval 兜底 */
var garrisonDirty = false;
/** @type {number} 上次执行 garrisonPass(含 856 权威读)的墙钟时刻(ms)；给驻军复查节流，不搭领奖唤醒的顺风车 */
var lastGarrisonAt = 0;
/** @type {boolean} 个人积分是否已刷满（total≥最高档且全档已领）：真则本期结束、撤回驻军、放行 auto-farm，直到窗口关闭复位 */
var scoreMaxed = false;
/** @type {boolean} 刷满后的撤军收尾是否已做过（只撤一次，别每轮重复发 904） */
var windDownDone = false;
/** @type {boolean} 本轮启动后是否已探过一次积分(1057)：冷启动先探再决定驻军，避免“先驻→发现满→又撤”往返 */
var scoreProbed = false;
/** @type {boolean} 当前是否在活动窗口内（决定 active/idle 扫描档） */
var inWindow = false;
/**
 * 已发 904 撤回、尚未到家（名额未释放）的行军 id 集合（键 marchId 字符串）。
 * 撤田「要几个撤几个」的去重依据：这些不再计入可撤候选、也不重复撤；返家（10019 state=4）后移除。
 * @type {Set<string>}
 */
var pendingRecall = new Set();
/**
 * 待驻井队列：garrisonPass 依最新 1055 权威刷新的「本盟所有 & 尚无驻军 & 坐标可读」的井（{id,x,y}）。
 * 本轮就地把空闲名额占满后剩余的，交给「撤田到家快路径」逐口补驻；每轮 garrisonPass 全量重建，故不陈旧。
 * @type {Array<{id:number,x:number,y:number}>}
 */
var garrisonQueue = [];
/**
 * 「为腾驻军名额而撤的下田行军」id 集合（pendingRecall 的子集）。
 * 其到家时 onMarchArrivedHome 认出是自家腾位田 → 走快路径补驻；区别于刷满收尾撤的驻井兵（不触发补驻）。
 * @type {Set<string>}
 */
var recalledForGarrison = new Set();

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/** @returns {number} 服务器当前时间（秒） */
function serverNow() {
  return +(dataCenter && dataCenter.ServerTime) || 0;
}

// ── 行军表读取（本人 marches）────────────────────────────────────────
// 本人行军统一走 core/march.list()（856 权威源，返回归一化 March[]，视口无关、Home 亦有全量）：
//   March = { id:str, type, state, isOccupying, target:{x,y,itemId,targetType}, raw }。摊平/嵌套/Int64 三坑已由 march.js 抹平。
/**
 * 是否已有一条驻本井的行军（marchType=35 且目标命中该井）：命中 itemId 或坐标。
 * @param {number} siloId 井配置 id（4001~4004）
 * @param {{x:number,y:number}} coord 井坐标
 * @param {object[]} myMarches march.list() 结果
 * @returns {boolean}
 */
function hasGarrisonMarchFor(siloId, coord, myMarches) {
  for (var i = 0; i < myMarches.length; i++) {
    var m = myMarches[i];
    if ((m.type | 0) !== MARCH_TYPE_GUN_FIGHT) continue;
    if (m.target.itemId && m.target.itemId === siloId) return true;
    if (coord && m.target.x === coord.x && m.target.y === coord.y) return true;
  }
  return false;
}

/**
 * 是否"可撤的资源采集田"行军（撤田候选）：以 marchType 3/26 为主判据（普通田 3 / 机械田 26）；
 * 显式排除驻井(35)与领域寻宝挖矿(180)，并排除**遗迹田**（marchType 3 但目标是 6 级田，全局不可撤不变量）；
 * 已在待撤集合(pendingRecall)的跳过。遗迹识别走 core/resource.isRelicTarget（跨 feat 不得 import auto-farm
 * 的遗迹池，且对方池靠邮件驱动扫图、可能根本没加载）：targetType=38 优先、itemId 组 15 兜底，
 * 两者都缺时回「非遗迹」放行撤回（宁可误撤，也不把普通田误锁成永不撤回）。
 * @param {object} m 归一化 March
 * @returns {boolean}
 */
function isRecallableFarmMarch(m) {
  var mt = m.type | 0;
  if (mt === MARCH_TYPE_GUN_FIGHT || mt === MARCH_TYPE_DOMAIN_TREASURE) return false;
  if (mt === 3 && isRelicTarget(m.target)) return false; // 遗迹田（6 级田）永不撤
  if (pendingRecall.has(m.id)) return false;
  return mt === 3 || mt === 26;
}

/**
 * 取至多 limit 条可撤的田行军（marchId 字符串，已 >2^53 安全）；优先去程在途(state=MARCHING)——
 * 未开采浪费最少、且离城近返家快，能更快腾出名额进入「空窗期」。
 * @param {number} limit 需要的名额缺口
 * @param {object[]} myMarches march.list() 结果
 * @returns {Array<{marchId:string}>}
 */
function pickRecallableFarmMarches(limit, myMarches) {
  var transit = [],
    harvesting = [];
  for (var i = 0; i < myMarches.length; i++) {
    var m = myMarches[i];
    if (!isRecallableFarmMarch(m)) continue;
    (m.state === march.State.MARCHING ? transit : harvesting).push({ marchId: m.id });
  }
  return transit.concat(harvesting).slice(0, limit);
}

// ── 井坐标（tableThrone）─────────────────────────────────────────────
/** @type {Object<string,{x:number,y:number}>} 井 id → 坐标缓存（同局活动坐标不变） */
var coordCache = {};

/**
 * 读井坐标：新图 THRONE_v2 优先、回落旧图 THRONE（对应 WorldMap2Biz.tableThrone getter）。行含 pos_x/pos_y。
 * @param {number} siloId 井 id
 * @returns {{x:number,y:number}|null}
 */
function getSiloCoord(siloId) {
  var key = String(siloId);
  if (coordCache[key]) return coordCache[key];
  var row = l10n.tableRow('THRONE_v2', siloId) || l10n.tableRow('THRONE', siloId);
  if (!row || row.pos_x == null || row.pos_y == null) return null;
  var coord = { x: Number(row.pos_x) | 0, y: Number(row.pos_y) | 0 };
  coordCache[key] = coord;
  return coord;
}

// ── 档位表（DATACONFIG 130118）───────────────────────────────────────
/**
 * 解析积分档位门槛：DATACONFIG[130118].value "num,rewardId|..." → [num,...]（升序）。取不到回落 TIERS_FALLBACK。
 * @returns {number[]} 各档位积分门槛
 */
function tierThresholds() {
  var raw;
  try {
    raw = gameConf.dataConfig(CFG_TIERS_KEY);
  } catch (err) {
    raw = '';
  }
  var src = (raw && String(raw)) || TIERS_FALLBACK;
  var nums = [];
  src.split('|').forEach(function (seg) {
    var num = parseInt(String(seg).split(',')[0], 10);
    if (isFinite(num) && num > 0) nums.push(num);
  });
  if (!nums.length) {
    TIERS_FALLBACK.split('|').forEach(function (seg) {
      var num = parseInt(String(seg).split(',')[0], 10);
      if (isFinite(num) && num > 0) nums.push(num);
    });
  }
  return nums.sort(function (a, b) {
    return a - b;
  });
}

// ── 发包 ─────────────────────────────────────────────────────────────
/**
 * 拉活动信息（1055）。永不 reject：异常回 null。
 * @returns {Promise<object|null>} {start,end,cur,list} 或 null
 */
async function requestInfo() {
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_GET_GUN_FIGHT_INFO,
    {},
    {
      gate: false,
      onError: function (err) {
        log.warn('request info error.', err);
        threw = true;
      },
    },
  );
  if (threw) return null;
  if (!ret.ok) {
    log.debug('1055 not ok. code=%d;data=%s', ret.code, rejectText(ret) || '-');
    return null;
  }
  return parseData(ret.data);
}

/**
 * 拉个人积分信息（1057）。永不 reject：异常回 null。
 * @returns {Promise<object|null>} {total,reward:[]} 或 null
 */
async function requestUserInfo() {
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_GET_GUN_FIGHT_USER_INFO,
    {},
    {
      gate: false,
      onError: function (err) {
        log.warn('request user info error.', err);
        threw = true;
      },
    },
  );
  if (threw) return null;
  if (!ret.ok) return null;
  return parseData(ret.data);
}

/**
 * 领取某档位积分奖励（1058 {score:num}）。永不 reject。
 * @param {number} num 档位门槛值
 * @returns {Promise<object>} net.Ret
 */
async function sendClaim(num) {
  return net.sendGuarded(
    CMD_GET_GUN_FIGHT_USER_REWARD,
    { score: Number(num) },
    {
      gate: false,
      onError: function (err) {
        log.warn('claim send error. num=%d', num, err);
      },
    },
  );
}

/**
 * 驻军某井（902 marchType=35 minimal）。载荷对齐 quick-attack 的 start_commonMarch 口径。永不 reject。
 * @param {{x:number,y:number}} coord 井坐标
 * @param {object} plan MarchData（5 字段）
 * @returns {Promise<object>} net.Ret
 */
async function sendGarrison(coord, plan) {
  return await march.attack({
    marchType: MARCH_TYPE_GUN_FIGHT,
    target: { x: coord.x, y: coord.y },
    data: plan,
  });
}

/**
 * 撤回一条行军（core/march.recall → 904 {marchId}）。永不 reject；成功即记入 pendingRecall（名额返程后才释放）并回 true。
 * @param {string} marchId 行军 id
 * @returns {Promise<boolean>} 是否成功发出并被接受
 */
async function sendRecall(marchId) {
  var ret = await march.recall(marchId);
  if (ret.ok) {
    pendingRecall.add(String(marchId));
    log.info('recall march ok. marchId=%s', marchId);
    return true;
  }
  log.info(
    'recall march rejected. marchId=%s;code=%d;data=%s',
    marchId,
    ret.code,
    rejectText(ret) || '-',
  );
  return false;
}

/**
 * 撤回自家仍占用井的驻井行军（marchType=35 且 isOccupying，排除返程/到家；904）。逐条、间隔休眠，已在待撤集合跳过。
 * 被 pause 打断回 -1（未判定，下轮继续）；本轮无占用驻井回 0（撤净）；否则回本轮发出的条数(>0)。永不 reject。
 * @returns {Promise<number>}
 */
async function recallGarrisonMarches() {
  var my = await march.list();
  if (!aliveFn()) return -1;
  var ids = [];
  for (var i = 0; i < my.length; i++) {
    var m = my[i];
    if ((m.type | 0) === MARCH_TYPE_GUN_FIGHT && m.isOccupying && !pendingRecall.has(m.id))
      ids.push(m.id);
  }
  if (!ids.length) return 0; // 已无占位驻井（全在返程/已到家）
  log.info('score maxed, recalling %d garrison march(es).', ids.length);
  for (var j = 0; j < ids.length; j++) {
    if (!aliveFn()) return -1; // pause 中途：未撤完不谎报成功，下轮重读接着撤
    await sendRecall(ids[j]);
    if (j < ids.length - 1) await sleep(cfg.recallInterval);
  }
  return ids.length;
}

// ── 领积分 ───────────────────────────────────────────────────────────
/**
 * 领一轮个人积分奖励：1057 拉 total 与已领 reward[] → 逐档「total≥门槛且未领」发 1058，串行、间隔休眠。永不 reject。
 * @returns {Promise<void>}
 */
async function claimRewards() {
  if (net.isSending(CMD_GET_GUN_FIGHT_USER_INFO)) return;
  var ui = await requestUserInfo();
  if (!aliveFn() || !ui) return;
  var total = Number(ui.total) || 0;
  var got = Array.isArray(ui.reward) ? ui.reward.map(Number) : [];
  var thresholds = tierThresholds();
  for (var i = 0; i < thresholds.length; i++) {
    var num = thresholds[i];
    if (!aliveFn()) return;
    if (total < num) continue; // 积分不足：游戏侧本地拦截不发 1058，这里同口径跳过
    if (got.indexOf(num) >= 0) continue; // 已领（reward[] 幂等真相）
    if (net.isSending(CMD_GET_GUN_FIGHT_USER_REWARD)) break;
    var ret = await sendClaim(num);
    if (!aliveFn()) return;
    if (ret.ok) {
      got.push(num); // 本地补记，防本轮重复发同一档
      log.info('claim ok. score=%d;total=%d', num, total);
    } else {
      log.info('claim rejected. score=%d;code=%d;data=%s', num, ret.code, rejectText(ret) || '-');
    }
    if (i < thresholds.length - 1) await sleep(cfg.claimInterval);
  }
  // 判定积分刷满：total≥最高档 且 所有档位均已领 → 本期个人刷分结束（下轮 cycleRun 撤军收尾）
  var maxT = thresholds.length ? thresholds[thresholds.length - 1] : 0;
  if (
    maxT &&
    total >= maxT &&
    thresholds.every(function (t) {
      return got.indexOf(t) >= 0;
    })
  ) {
    if (!scoreMaxed) {
      scoreMaxed = true;
      log.info(
        "score maxed. total=%d;max=%d — this season's launch silo done, recall garrison next round and let auto-farm proceed.",
        total,
        maxT,
      );
    }
  }
}

// ── 驻军（含撤田腾队列）─────────────────────────────────────────────
/**
 * 驻军一轮：按最新 1055 权威重建待驻队列（本盟所有 & 我未驻 & 坐标可读），
 *   ①先把当前空闲名额就地占满（逐条 minimal 入驻，发前现判免超发）；
 *   ②若仍有待驻但无空位，则撤 1 条田（优先去程在途）腾位，其到家瞬间由 fillOneSiloFast 抢空窗补驻。
 * 无跨 feat 预约：抢输（被 auto-farm 抢先/902 被拒）则该井留队列、下轮再撤一田重试。永不 reject。
 * @param {object[]} list 1055 应答的井列表 [{id,owner,...}]
 * @returns {Promise<void>}
 */
async function garrisonPass(list) {
  var alliance = gameData.alliance();
  var myAid = alliance && Number(alliance.Aid);
  if (!myAid) {
    log.debug('no alliance, skip garrison.');
    return;
  }
  // 本人行军权威源（core/march.list 封装 856）：视口无关、Home 亦有全量，取代旧 mapData.marches（Home 读空会误判「没驻」而重复增援）
  var myMarches = await march.list();
  if (!aliveFn()) return;

  // 需要驻的井：归属本联盟 && 我尚无驻军行军 && 坐标可读 → 全量重建待驻队列（权威，供本轮派发 + 撤田到家快路径取用）
  garrisonQueue = [];
  for (var i = 0; i < list.length; i++) {
    var silo = list[i];
    if (Number(silo.owner) !== myAid) continue; // 非我盟的井：只等待，不打
    var coord = getSiloCoord(Number(silo.id));
    if (!coord) {
      log.debug('silo coord unavailable, skip. id=%s', silo.id);
      continue;
    }
    if (hasGarrisonMarchFor(Number(silo.id), coord, myMarches)) continue; // 已在驻：跳过
    garrisonQueue.push({ id: Number(silo.id), x: coord.x, y: coord.y });
  }
  if (!garrisonQueue.length) return;

  // 1) 先把当前空闲名额就地占满（逐条、发前现判，避免入表延迟导致超发；成功/被拒都移出队列，被拒者由下轮 1055 权威重建再定）
  while (garrisonQueue.length && march.freeSlots() > 0) {
    if (!aliveFn()) return;
    if (net.isSending(CMD_MARCH_WORLD_POINT)) return;
    var tgt = garrisonQueue[0];
    var plan = new Battle().plan().minimal().build();
    if (!plan.armyListNew.length) {
      log.debug('no dispatchable army, stop garrison pass. silo=%d', tgt.id);
      return;
    }
    var ret = await sendGarrison(tgt, plan);
    if (!aliveFn()) return;
    garrisonQueue.shift();
    if (ret.ok) {
      log.info(
        'garrison ok. silo=%d;x=%d;y=%d;remaining=%d',
        tgt.id,
        tgt.x,
        tgt.y,
        garrisonQueue.length,
      );
    } else {
      log.info(
        'garrison rejected. silo=%d;x=%d;y=%d;code=%d;data=%s',
        tgt.id,
        tgt.x,
        tgt.y,
        ret.code,
        ret.data,
      );
    }
    if (garrisonQueue.length && march.freeSlots() > 0) await sleep(cfg.marchInterval);
  }

  // 2) 仍有待驻但无空闲名额：撤 1 条田腾位（优先去程在途），其到家时由快路径抢空窗补驻。
  //    在途撤军尚未到家时不重复多撤：以「已撤待归的腾位田数」<「剩余待驻数」为闸，防过度撤田。
  //    撤田为面板可选项（recallFarm）：关闭则不主动撤田，待驻井只在自然空出名额时（cycle 唤醒）入驻。
  if (!modCfg.recallFarm) {
    if (garrisonQueue.length)
      log.debug('recall disabled by option, wait for free slot. pending=%d', garrisonQueue.length);
    return;
  }
  if (garrisonQueue.length && recalledForGarrison.size < garrisonQueue.length) {
    var pick = pickRecallableFarmMarches(1, myMarches);
    if (pick.length) {
      log.info(
        'slots short, recalling 1 farm march to free a slot for garrison. marchId=%s;remaining=%d',
        pick[0].marchId,
        garrisonQueue.length,
      );
      if (await sendRecall(pick[0].marchId)) recalledForGarrison.add(pick[0].marchId);
    } else {
      log.debug('no recallable farm march, wait for free slot.');
    }
  }
}

/**
 * 撤田到家的空窗期快路径：用待驻队列队首井 + 缓存坐标，直接发一条驻军 902（跳过 1055/856 整轮），
 * 抢在 auto-farm 回填前占住刚释放的名额。成败都消费队首（被拒者由下轮 garrisonPass 依 1055 权威重建时再定）。
 * 由 onMarchArrivedHome 触发（fire-and-forget），与常规 cycle 并行；并发 902 由 march.attack 内 isSending 去重兜底。
 * @returns {Promise<void>}
 */
async function fillOneSiloFast() {
  if (!aliveFn() || !garrisonQueue.length) return;
  if (march.freeSlots() <= 0) {
    garrisonDirty = true;
    pushWake();
    return;
  } // 没抢到/仍满 → 交常规轮重判（可能再撤一田）
  if (net.isSending(CMD_MARCH_WORLD_POINT)) {
    pushWake();
    return;
  }
  var tgt = garrisonQueue[0];
  var plan = new Battle().plan().minimal().build();
  if (!plan.armyListNew.length) return;
  var ret = await sendGarrison(tgt, plan);
  if (!aliveFn()) return;
  garrisonQueue.shift();
  if (ret.ok) {
    log.info(
      'garrison ok (fast). silo=%d;x=%d;y=%d;remaining=%d',
      tgt.id,
      tgt.x,
      tgt.y,
      garrisonQueue.length,
    );
    if (garrisonQueue.length && march.freeSlots() > 0) pushWake();
  } else {
    log.info(
      'garrison rejected (fast), re-eval next cycle. silo=%d;code=%d;data=%s',
      tgt.id,
      ret.code,
      ret.data,
    );
    garrisonDirty = true;
    pushWake();
  }
}

// ── 扫描调度 ─────────────────────────────────────────────────────────
/**
 * 单轮扫描主体（core/cycle 调和循环：单飞闸门 + 触发合并 + 绝不停摆均由 cycle 承载）：
 * 1055 判活动窗口 → 窗口内驻军优先 + 按需领奖 → 返回下拍间隔（毫秒；<=0=立即补扫）。
 * 窗口外只探活不发写包，并据 1055 的 start 排程：已证实 1055 在关闭期即返回下期 start（固定周活），
 *   故直接成段睡向 start（单拍上限 startSleepMaxMs，醒一次重读 cur 校准时钟），临近开启自然收敛为精确睡到开前 openWakeLeadMs；
 *   仅当 1055 拿不到未来 start（请求失败/无排期）才退回 idleScanInterval 低频探活。用时长差而非绝对时刻，规避时钟偏移。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  var info = await requestInfo();
  if (!aliveFn()) return 0; // pause 中途：cycle 会在 alive 检查处自然停摆
  var now = (info && Number(info.cur)) || serverNow();
  var start = info ? Number(info.start) || 0 : 0;
  var end = info ? Number(info.end) || 0 : 0;
  inWindow = !!(info && start && end && start <= now && now < end);

  if (!inWindow) {
    // 窗口关闭/未开：本期结束，复位刷满收尾标记，下期重新计
    scoreMaxed = false;
    windDownDone = false;
    scoreProbed = false; // 下期重新探一次积分（冷启动防往返只在窗口首个周期生效）
    garrisonQueue = [];
    recalledForGarrison.clear(); // 出窗口清待驻/腾位残留，下期从 1055 权威重建
    // 已证实 1055 关闭期即返回下期 start（固定周活、不漂移）→ 成段睡向 start（开前 openWakeLeadMs 醒），
    //   单拍上限 startSleepMaxMs 仅兜「服务器时钟漂移 / 单定时器过大」，醒一次即重读 cur 再校准；临近开启 waitMs<上限自然收敛为精确睡到点。
    if (start > now) {
      var waitMs = (start - now) * 1000 - cfg.openWakeLeadMs;
      var hop = Math.max(cfg.openWakeMinMs, Math.min(waitMs, cfg.startSleepMaxMs));
      log.debug(
        'activity not open, next start in ~%ds, sleep %dms.',
        Math.max(0, Math.round(waitMs / 1000)),
        hop,
      );
      return hop;
    }
    log.debug('activity not open, idle.');
    return cfg.idleScanInterval;
  }

  var list = (info && info.list) || [];
  // 积分刷满=本期结束：停驻军、把占用中的驻井部队持续撤回直到撤净（放行 auto-farm 正常回填），之后只保持窗口探测
  if (scoreMaxed) {
    garrisonQueue = [];
    recalledForGarrison.clear(); // 刷满收尾：不再补驻，清待驻/腾位残留
    if (!windDownDone) {
      var left = await recallGarrisonMarches();
      if (left === 0) {
        windDownDone = true; // 重读确认已无占位驻井 → 才认定收尾完成
        log.info('score maxed wind-down settled: all garrison marches recalled.');
      } else {
        // left>0 本轮撤了待下轮确认返程，或 left<0 被 pause 打断：都短周期再来，不谎报 done
        return cfg.activeScanInterval;
      }
    }
    // 只剩等窗口关闭复位：睡到 end（末段外按 idle 上限复查），省得窗口内 20s 空转 1055
    var toEnd = (end - now) * 1000 - cfg.openWakeLeadMs;
    return Math.max(
      cfg.openWakeMinMs,
      Math.min(toEnd > 0 ? toEnd : cfg.activeScanInterval, cfg.idleScanInterval),
    );
  }
  // 冷启动/重启防往返傻动：刷新后 scoreMaxed 是初值 false，若直接驻军、同轮稍后才发现分已满→下轮又撤回，白跑一来回。
  //   故未探过积分的首轮先查一次 1057（claimRewards 内含刷满判定）：若已满则本轮不驻军，直接交下轮顶部 scoreMaxed 分支收尾（只撤刷新前遗留的驻井兵）。
  if (!scoreProbed) {
    scoreProbed = true;
    lastRewardScanAt = Date.now();
    rewardDirty = false;
    await claimRewards();
    if (!aliveFn()) return 0;
    if (scoreMaxed) return cfg.activeScanInterval; // 已满：本轮不驻军
  }
  // 驻军与领奖各自按「唤醒意图 + 兜底间隔」门控，互不搭顺风车：
  //   10029 积分 push 只置 rewardDirty→只跑领奖，不触发驻军的 856；11017/撤田到家只置 garrisonDirty→只跑驻军。
  //   两者各有兜底间隔（active/rewardScanMinGap），保证任一路径漏 push 也能周期复查。
  var wallG = Date.now();
  if (garrisonDirty || wallG - lastGarrisonAt >= cfg.activeScanInterval) {
    lastGarrisonAt = wallG;
    garrisonDirty = false;
    await garrisonPass(list);
    if (!aliveFn()) return 0;
  }
  var wallC = Date.now();
  if (rewardDirty || wallC - lastRewardScanAt >= cfg.rewardScanMinGap) {
    lastRewardScanAt = wallC;
    rewardDirty = false;
    await claimRewards();
    if (!aliveFn()) return 0;
  }
  if (cycle.pending) return 0;
  return cfg.activeScanInterval;
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取 active 档，防异常停摆） */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.activeScanInterval,
});

// ── 推送入口 ─────────────────────────────────────────────────────────
/**
 * 由推送触发的补扫（去抖）：距上次补扫 < pushScanMinGap 则忽略（仅靠兜底定时收尾）。
 */
function pushWake() {
  if (!aliveFn()) return;
  var wall = Date.now();
  if (wall - lastPushScanAt < cfg.pushScanMinGap) return;
  lastPushScanAt = wall;
  cycle.kick();
}

/** 11017 单井归属/占领变化：可能刚变成我盟所有 → 置驻军脏标记，唤醒补扫驻军。 */
function onGunFightInfoPush() {
  garrisonDirty = true;
  pushWake();
}

/** 10029 个人积分/已领刷新：积分可能跨过新档位 → 置脏标记，下轮 cycleRun 无视兜底间隔立即领奖一次。 */
function onRewardPush() {
  rewardDirty = true;
  pushWake();
}

/**
 * 行军到家（march.onHomeReturn 复播，state→ARRIVED_HOME 边沿）：仅认「我方某条已撤行军」（出 pendingRecall）。
 *   若这条正是「为驻军腾位而撤的田」(recalledForGarrison)，它到家=名额刚空出、auto-farm 尚未回填的空窗期 →
 *   走快路径 fillOneSiloFast 立刻补驻一口井（一跳 902，抢在 auto-farm 前）；否则仅唤醒常规轮复查。
 * 全局单点订阅的代价：march.js 常驻 10019，feat 暂停仍会收到复播 → 回调内自判 alive 为硬约束。
 * @param {object} m 归一化 March
 */
function onMarchArrivedHome(m) {
  if (!aliveFn()) return;
  var mid = m && m.id;
  if (!mid || !pendingRecall.has(mid)) return; // 不是我们撤的（驻军/其它行军回城），不唤醒
  pendingRecall.delete(mid);
  if (recalledForGarrison.has(mid)) {
    recalledForGarrison.delete(mid);
    log.debug(
      'recalled farm march arrived home (marchId=%s), slot freed → fast garrison fill.',
      mid,
    );
    fillOneSiloFast();
    return;
  }
  log.debug('recalled march arrived home (marchId=%s).', mid);
  garrisonDirty = true;
  pushWake();
}

/** @type {Function|null} march.onHomeReturn 退订句柄（防 resume 重激活重复注册） */
var offHomeReturn = null;

// ── 生命周期 ─────────────────────────────────────────────────────────
/**
 * 安装：取网络底座 + 数据中心。任一缺失即失败（reactor 不会激活）。
 * 本人行军改走 core/march.list()（856），不再依赖 NWorldMapData。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;

  var missing = [];

  net = ctx.net;
  if (!net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  var dc = game.get('DataCenter');
  dataCenter = (dc && dc.DATA) || (missing.push('DataCenter'), null);

  if (missing.length) {
    net = null;
    dataCenter = null;
    log.warn('install failed. missing=%s', missing.join(';'));
    return false;
  }

  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行：复位状态 → 挂 11017/10029/10019 监听 → 主动扫一次。
 * pause 后 alive()=false 定时器自然停摆；resume 重新复位点火（cycle.kick 内部先清旧定时器，不重复）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  inWindow = false;
  lastPushScanAt = 0;
  lastRewardScanAt = 0;
  rewardDirty = true; // 点火首轮强制查一次 1057（进场时可能有已达标未领的档位），之后靠 10029/兜底驱动
  lastGarrisonAt = 0;
  garrisonDirty = true; // 点火首轮强制驻军一轮，之后靠 11017/撤田到家/兜底驱动
  scoreProbed = false; // 冷启动/resume 首轮先探一次积分再决定驻军（防“先驻→发现满→又撤”往返）
  // 注：scoreMaxed/windDownDone 不在此复位——resume 会重跑 run，复位会丢弃刷满收尾状态导致重驻又重撤；
  //         只在窗口关闭(!inWindow) 时复位，同一活动窗口内跨 pause/resume 保留。
  pendingRecall.clear();
  coordCache = {};
  garrisonQueue = [];
  recalledForGarrison.clear(); // 清上一轮残留的待驻/腾位标记（resume 后由 garrisonPass 从 1055 权威重建）
  ctx.on.push(PUSH_GUN_FIGHT_INFO, onGunFightInfoPush);
  ctx.on.push(PUSH_GUN_FIGHT_REWARD_INFO, onRewardPush);
  if (offHomeReturn) offHomeReturn(); // 先退再挂，防 resume 重激活重复注册
  offHomeReturn = march.onHomeReturn(onMarchArrivedHome);
  log.info(
    'started (garrison + claim-score built-in default; recall-farm-to-free-slot=%s).',
    modCfg.recallFarm ? 'on' : 'off',
  );
  cycle.kick();
}

/**
 * 接收面板配置（registry 经 toModuleCfg 推入）：撤田腾队列开关。reactor 在 setConfig 时调用，早于 run。
 * @param {object} c 模块配置 { recallFarm:boolean }
 */
function configure(c) {
  modCfg = { recallFarm: !!(c && c.recallFarm) };
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap），战斗模式暂停（offInCombat）。
 * 驻军 / 领积分为内置默认行为；「队列不足撤田腾位」为面板可选项（默认勾选）。
 */
reactor.register({
  id: 'launchSilo',
  label: '占领发射井',
  storageKey: 'pocketcc.feat.launchSilo',
  symbols: ['dataCenter', 'tableManager', 'tableName', 'tableUtils'],
  places: ['base', 'world'],
  // A 档保守收（可行性报告 §7.2/§7.4 第 4 刀）：发射井疑属天梯战场（cross_server_* 词条），但本 feat 自动化的是
  // 「每周二 21:00 / 4 井 4001-4004 / tableThrone THRONE」那条联盟活动，静态无法确证其图属 kind。
  // 真机复核口径：下次开活动进发射井图跑一次 worldState.dump()，若 kind 落 kvk_* 则把本行升为 ['homeland','kvk']（A→B）。
  kinds: ['homeland'],
  offInCombat: true,
  defaults: { enabled: false, recallFarm: true },
  fields: [
    {
      key: 'recallFarm',
      type: 'checkbox',
      label: '撤田腾队列',
      hint: '行军队列不足时，撤回一条下田采集行军（普通/机械田）腾出名额驻井；遗迹田永不撤回。关闭则只在有空闲队列时驻军，不主动撤田',
    },
  ],
  toModuleCfg: function (c) {
    return { recallFarm: !!(c && c.recallFarm) };
  },
  configure: configure,
  install: install,
  run: run,
});
