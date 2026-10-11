/**
 * 卡车争夺自动拦截 —— 日常护送（Escort Truck funcType=1）自动掠夺（reactor 说明书形态，日常任务，单文件）。
 *
 * 玩法：定时刷新「可拦截车队列表」（6473 首次开 / 6474 重随机），从每车 lootRewardResult 的货物 itemId
 *   里检测玩家配置要拦截的物品（勾选=参与、拖拽=优先级，命中其一即视为目标）；对目标车反复发起拦截（6476），
 *   打到该车「不可再打」为止（失败达 fail_times 上限，或该车被成功抢夺次数达 loot_num_max 抢空）。
 *   每日拦截次数（lootNum 已用 / loot_num_max_daily 上限）耗尽即全线停检；服务器 0 点刷新次数
 *   （nextRefreshLootNumTime 毫秒时间戳到点，或推 21551 主动下发新计数），届时自动恢复。
 *
 * 刷新节奏（静态时刻表）：游戏日（以 daily.refreshMs 为 0 点）切成 24 个等长小时格，「时段模板」给每格一个次数占比，
 *   「今日刷新上限 cap」按占比分到各格（最大余数法，保证 Σ=cap），格内间隔 = 1h / 该格次数；
 *   每次只查表取“下一个格点”，错过的格点不补刷——cap 与刷新频率单调对应（调大变密、调小变疏）。
 *
 * 协议族（NRequestIdV2 实证，均走 net.sendPBV2 新 PB 链路，ret.data 已是解码对象）：
 *   6473 ESCORT_TRUCK_LOOT_TRUCK_VIEW_OPEN {funcType, localServerDisable:1} → {funcType, lootNum, lootTruckViewList:[LootTruckView]}；
 *   6474 ..._RELOAD 同载荷（列表重随机，游戏侧 0.5s 防抖，我们按 reloadGap 节流）；
 *   6476 ESCORT_TRUCK_LOOT {funcType, truckId(Long), troop:{heroList:[{heroId}], armyPosList:[{pos,armyId,armyNum}], formationV2}}
 *        → {funcType, lootNum(当日已用新值), lootTruckView(该车最新计数), rewardResult, isWin, reportId, ...}；
 *   6486 ESCORT_TRUCK_GET_REFRESH_INFO {funcType} → {funcType, lootNum, nextRefreshLootNumTime(毫秒 Int64), ...}；
 *   21551 ESCORT_TRUCK_REFRESH_INFO_PUSH 结构同 6486：拦截后服务器把 lootNum 主动推下来（订阅唤醒，免轮询）。
 *   truckId 是雪花 id（{_low,_high}，超 2^53），身份键用 _low:_high 串；发包原样透传收到的 truckId 对象（游戏自己也是直接回发它）。
 *
 * 攻击前置校验（复刻源码 checkTruckInterceptEnable 五条 + getTargetAttackDisableTips 同联盟，发送前本地过滤，防撞限额刷屏）：
 *   ① func_type.open_level ≤ 玩家等级；② 当日 lootNum < loot_num_max_daily；③ 我对该车 myLootNum < loot_num_max_same_truck；
 *   ④ 我对该车 myLootFailNum < fail_times；⑤ 该车 lootNum < loot_num_max（未被抢空）；⑥ 非本服（localServerDisable=1）且非同联盟。
 *
 * 被拒当日拉黑（blockedToday，落 storage.data，跨日清空）+ 6474/6476 节流：对齐「自动化撞限额刷屏」既有教训。
 *
 * 只打能赢（threatOn，默认开）：每轮刷列表先用未过滤 raw 满编编成算我方出征战力（999 GET_SINGLE_QUEUE_BATTLEPOWER 的
 *   battlePowerVal）+ heroList 多数投票定我方军种；战力不每轮重查——队列战力变化极少，缓存 POWER_CACHE_EVERY 次卡车列表
 *   刷新（或超 POWER_MAX_AGE_MS、编成指纹变化）才主动更新一次，面板「刷新我方战力」按钮 force 强制重查；列表侧按 grade（escort_truck.grade，面板「拦截品级」勾选）+ 战力粗筛
 *   （敌 > 我×1.5 直接淘汰，省 927）预筛；对存活候选用 scoutReportId 走 927 拉战报，取 defender.players[0].heroList 的 hero
 *   army_type（101陆/201海/301空，仅 hero 表有此字段，army 表无）多数投票定对方军种；再按克制（陆克空/空克海/海克陆）与
 *   战力比（我克敌≤1.5 / 同军种≤1.2 / 我被克≤0.8）assess：打得起才入队，打不过进本轮 skipRound（内存态、重随机即清，与
 *   服务器拒绝的当日拉黑 blocked 严格分离）。军种只能走 hero.army_type（units armyId 含机甲推不出）；999/927 走旧 net.send
 *   且 ret.data 需 parse；我方战力未探到则 fail-open 退回旧行为、对方军种未知则 fail-closed 不打。
 *
 * 合规：只读游戏数据（经 game-api ACL）+ 直发协议；编队走 core/battle.js 从预设队伍实时重算造数据（不碰游戏本地态、不 OpenUI）。
 *   6476 派真实部队出征战斗、消耗兵力，属派行军类 → 受战斗模式门控 offInCombat:true（战斗态由 reactor 整体 pause，退出即 resume 补扫）。
 */
import { createLog } from '../../core/log.js';
import { bus } from '../../core/bus.js';
import { storage } from '../../core/storage.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../core/battle.js';
import { l10n, gameData } from '../../core/game-api.js';
import { item } from '../../core/item.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=TRUCK-INTERCEPT） */
const log = createLog('TRUCK-INTERCEPT');

/** @type {number} ESCORT_TRUCK_LOOT_TRUCK_VIEW_OPEN：打开可拦截车队列表 */
const CMD_OPEN = 6473;
/** @type {number} ESCORT_TRUCK_LOOT_TRUCK_VIEW_RELOAD：刷新（重随机）可拦截列表 */
const CMD_RELOAD = 6474;
/** @type {number} ESCORT_TRUCK_LOOT：对某车队发起拦截掠夺（核心战斗请求） */
const CMD_LOOT = 6476;
/** @type {number} ESCORT_TRUCK_GET_REFRESH_INFO：拉取每日次数与刷新时间点 */
const CMD_REFRESH = 6486;
/** @type {number} ESCORT_TRUCK_REFRESH_INFO_PUSH：服务器主动推次数/刷新变化（结构同 6486） */
const CMD_REFRESH_PUSH = 21551;
/** @type {number} GET_SINGLE_QUEUE_BATTLEPOWER：查询一支编队的实际战力（旧 send 链路，ret.data 字符串需 parse） */
const CMD_POWER = 999;
/** @type {number} 我方战力缓存档：刷这么多次卡车列表才重查一次 999（队列战力变化极少，省重复往返） */
const POWER_CACHE_EVERY = 10;
/**
 * @type {number} 战力缓存的时间兜底：powerAge 只由真实列表往返推进，配额耗尽/时刻表长睡会冻结它
 *   → 退化为“永不自然过期”。加一条绝对时限与列表计数取或（陈旧方向安全：低估我方战力只会多跳过不会误打）。
 */
const POWER_MAX_AGE_MS = 6 * 3600000;
/** @type {number} MAIL_GETREPORT：按 reportId 拉战报（旧 send 链路，reportStr 解析后含 battle.defender） */
const CMD_REPORT = 927;

/** @type {number} 功能类型：1=dailyEscort 日常护送（本轮只做这一种） */
const FUNC_TYPE = 1;

/**
 * 军种与克制判定常量（真机探针实证）：hero 表 army_type 值为字符串 "101"陆/"201"海/"301"空；
 * 克制关系 陆克空 / 空克海 / 海克陆（BEATS[me] = 被 me 克制的军种）。战力比(敌/我)可打上限：
 * 我克敌 1.5（可趁克制吃掉更高战力）、同军种 1.2、我被克 0.8（需让 20% 才打）。
 * @type {object}
 */
const BRANCH = { LAND: 101, SEA: 201, AIR: 301 };
const BEATS = { 101: 301, 301: 201, 201: 101 };
/** 战力比可打上限默认值（面板可调，configure 写入 ratio） */
const RATIO_DEFAULT = { counter: 1.5, same: 1.2, countered: 0.8 };
/** @type {{counter:number, same:number, countered:number}} 运行时可调阈值（我克敌/同军种/我被克 的敌我战力比上限） */
var ratio = { counter: 1.5, same: 1.2, countered: 0.8 };

/**
 * 运输车品级（escort_truck.grade）→ 品质名（字典 moc_002/003/004 实证 3=稀有/4=史诗/5=传奇，1/2 推断普通/高级）。
 * 面板「拦截品级」用这组标签；grade 取不到（0）时按“不限制”放行（fail-open）。
 * @type {Object<number,string>}
 */
const GRADE_LABELS = { 1: '普通', 2: '高级', 3: '稀有', 4: '史诗', 5: '传奇' };
/** @type {number[]} 全部品级档 */
const ALL_GRADES = [1, 2, 3, 4, 5];

/** @type {number} 非服务器返回的哨兵 code（闸门未放开 / 在途 / 发送异常，与真实 s 码区分，不当拒绝拉黑） */
const CODE_NOT_SENT = -1;

/** @type {string} 当日拉黑持久数据键（storage.data blob 内逻辑名） */
const DATA_NAME = 'truckIntercept.blocked';

/** @type {string} 当日刷新次数/攻击成败计数持久数据键（storage.data blob 内逻辑名，跨日归零） */
const DATA_NAME_STATS = 'truckIntercept.stats';

/**
 * 值得拦截的奖励物品池（itemId 直接来自 lootRewardResult，无需 rewardItems 反解）。
 * 默认优先级 = 序号顺序（面板可拖拽调整 + 逐行勾选是否参与）。itemId 经录制报文与字典表双向实证：
 *   820016=高级催化剂、69359=中级重装芯片宝箱、1600029=职业道具自选宝箱、2300003=橙色万能碎片。
 * @type {number[]}
 */
const TRUCK_ITEM_POOL = [820016, 69359, 1600029, 2300003];

/**
 * 内置调优常量（面板只出优先级/编队，不暴露这些间隔）。
 * @type {object}
 */
const cfg = {
  /** @type {number} 活跃刷新间隔：未同步到刷新点（daily.refreshMs=0）时的退化档 */
  activeRefresh: 1000 * 60 * 2,
  /** @type {number} 空转刷新间隔：拿不到刷新点/刷新点已过时的退避档 */
  idleRefresh: 1000 * 60 * 10,
  /** @type {number} 6474 列表重随机最小间隔（游戏侧 0.5s 防抖，我们留足余量） */
  reloadGap: 1000 * 3,
  /** @type {number} 同一车连打（6476）间距（重载荷战斗接口节流，防刷屏） */
  lootGap: 1000 * 2,
  /** @type {number} 0 点刷新点（nextRefreshLootNumTime）到点后的余量，避开服务器结算时序 */
  flipBuffer: 1000 * 20,
};

/**
 * 刷新调度：静态时刻表（24 格 × 占比权重 × cap 分配）。
 *   把游戏日（以 daily.refreshMs 为服务器 0 点锚定）切成 24 个等长格，每格一个刷新次数占比；
 *   cap 按占比分到各格（最大余数法，保证 Σ=cap），格内间隔 = 1h / 该格次数，格点绝对时刻 = 格起点 + k×间隔。
 *   格等长（各 1h）⇒「次数占比」与「密度占比」等价，cap 直接等于一天的计划刷新总数：调大整体变密、调小整体变疏，无地板吞预算。
 *   面板只暴露「时段模板（三档内置）+ 今日刷新上限」，占比表内置防误调。
 * @type {{capDefault:number, slotMs:number, hopCap:number, presetDefault:string}}
 */
const REFRESH = {
  capDefault: 300, // 今日刷新上限默认值（面板可改）
  slotMs: 3600000, // 一格 = 1 小时
  hopCap: 1000 * 60 * 10, // 长睡分段上限：0 占比格与日界前分段醒来按同一张表重算（幂等），兼防刷新点被推正后睡过头
  presetDefault: 'normal',
};

/**
 * 三档内置时段模板：数组下标即游戏日第几小时（0 = 00:00–00:59…），值为该格的刷新次数占比（相对量纲，无需归一）。
 *   热点（00:10–02:00 玩家集中发车）最密、白天居中、深夜最稀；「省心」把 20 点后压到 0（该档当晚不刷，睡到次日）。
 * @type {Object<string, number[]>}
 */
const REFRESH_PRESETS = {
  /** 密集：全天都盯，深夜也不归零（Σ=94） */
  dense: [6, 6, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 2, 2],
  /** 正常（默认）：热点密·白天中·深夜稀（Σ=70） */
  normal: [6, 6, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1],
  /** 省心：只盯热点与上午，20 点后不刷（Σ=54） */
  calm: [6, 6, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0],
};

/** 模板档位的面板文案（值 = select 选项 label） */
const PRESET_LABELS = {
  dense: '密集（全天高频，深夜也刷）',
  normal: '正常（热点密·白天中·深夜稀）',
  calm: '省心（只盯热点与上午，20 点后不刷）',
};

/** @type {number} 今日刷新次数上限（configure 从面板写入，<=0 回退默认） */
var refreshCap = REFRESH.capDefault;
/** @type {string} 当前时段模板档位 */
var refreshPreset = REFRESH.presetDefault;
/** @type {number[]} 当前生效的 24 格刷新次数分配（configure 按 cap × 占比重算，Σ=cap） */
var slotCounts = allocateSlots(REFRESH_PRESETS[REFRESH.presetDefault], REFRESH.capDefault);

/** @type {object|null} 网络底座 */
var net;
/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/** @type {number[]} 当前优先级顺序（itemId，靠前优先），configure 写入 */
var order = TRUCK_ITEM_POOL.slice();
/** @type {Set<number>} 被取消勾选（不参与匹配）的 itemId */
var disabled = new Set();
/** @type {Map<number,number>} itemId → rank（order 下标），O(1) 匹配与排序 */
var rankMap = new Map();
/** @type {number} 出征预设队伍号（1 起） */
var presetIdx = 1;

/** @type {Set<number>} 勾选要拦截的品级集合（空=不限制） */
var gradeSet = new Set(ALL_GRADES);
/** @type {boolean} 是否启用「只打能赢」战力+克制判定 */
var threatOn = true;
/** @type {Set<string>} 本轮判定为“打不过”而跳过的 truckId（内存态，每轮新列表清空；与服务器拒绝拉黑 blocked 分离） */
var skipRound = new Set();
/**
 * 我方出征侧本轮快照（probeSelf 每轮 doScan 算一次）：{power:battlePowerVal（可能来自缓存）, branch:101/201/301, raw:未过滤编成, ready:探到战力, tried:本轮已尝试探测}
 * @type {{power:number, branch:number, raw:object|null, ready:boolean, tried:boolean}}
 */
var my = { power: 0, branch: 0, raw: null, ready: false, tried: false };
/** 上次 configure 生效的攻击预设号（面板换预设时据此唤醒一次探测，供展示） */
var prevPreset = -1;
/** 战力缓存：上次 999 探到的 battlePowerVal（0=未探到/已失效，下一轮仍会重试） */
var powerCache = 0;
/** 距上次 999 真实查询已刷新的卡车列表次数，达 POWER_CACHE_EVERY 归零并重查 */
var powerAge = 0;
/** 缓存所属的编成指纹（presetIdx+英雄+总兵量+阵型）：与本轮 raw 不等即作废，换预设/游戏内改队都能接住 */
var powerFp = '';
/** 上次真实 999 查询成功的时刻（本地 ms），供 POWER_MAX_AGE_MS 时间兜底 */
var powerAt = 0;
/** 999 探测在途旗：面板按钮与循环探测可能同 cmd 并发（sendLegacy 会吃 isSending 回落），后来者直接复用缓存不再发 */
var powerProbing = false;

/**
 * 每日配额权威态（由 6486 / 21551 push / 6476 应答共同维护）：
 * @type {{used:number, maxDaily:number, sameTruckMax:number, openLevel:number, refreshMs:number}}
 */
var daily = { used: 0, maxDaily: 0, sameTruckMax: 0, openLevel: 0, refreshMs: 0 };

/** @type {object[]} 本轮刷出的可打候选（{view,key,rank,itemId,itemName,lootMax,failMax}），consume 逐条 shift */
var queue = [];
/** @type {number} 上次 6474 发出时刻（本地 ms），reloadGap 节流 */
var lastReloadAt = 0;
/** @type {boolean} 列表是否已开过一次（决定首发 6473 还是后续 6474） */
var listOpened = false;
/** @type {{day:string, trucks:string[]}} 当日被拒车队拉黑（键 truckId 串，跨日清空，落 storage.data） */
var blocked = { day: '', trucks: [] };

/**
 * 当日计数快照（跨日归零，落 storage.data）：
 * refreshUsed=今日已刷列表次数（对 refreshCap）；tried/win/fail=真发 6476 且拿到 isWin 的战斗尝试/胜/负；rejected=被服务器硬拒（未打）。
 * @type {{day:string, refreshUsed:number, tried:number, win:number, fail:number, rejected:number}}
 */
var stats = { day: '', refreshUsed: 0, tried: 0, win: 0, fail: 0, rejected: 0 };

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 小工具 ──────────────────────────────────────────────────────────────
/**
 * 今日日期串 YYYY-MM-DD（当地时区，跨日失效判据）
 * @returns {string}
 */
function todayStr() {
  var d = new Date();
  var m = d.getMonth() + 1,
    day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * Int64（{_low,_high} 或数字/串）→ 稳定字符串键（车队 id 拉黑/去重用，雪花 id 不做有损 Number 转换）
 * @param {*} v
 * @returns {string}
 */
function int64Key(v) {
  if (v == null) return '';
  if (typeof v === 'object' && '_low' in v) return v._high + ':' + v._low;
  return String(v);
}

/**
 * Int64（{_low,_high} 或数字/串）→ JS number（毫秒/秒时间戳等，值域远小于 2^53 时可安全用）
 * @param {*} v
 * @returns {number}
 */
function int64ToNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && '_low' in v) return (v._high >>> 0) * 4294967296 + (v._low >>> 0);
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/**
 * 安全序列化拒绝载荷（对象 String() 会退化成 [object Object] 丢原因）
 * @param {*} v
 * @returns {string}
 */
function safeStringify(v) {
  if (v == null) return String(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

/**
 * 等待毫秒
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, Math.max(0, ms | 0));
  });
}

// ── 优先级（configure / rankMap / 匹配） ────────────────────────────────
/**
 * 池驱动升档迁移：保留 raw 中仍在池内的 itemId（维持相对顺序），再追加池中未出现者到末尾，丢弃池中已消失者。
 * @param {*} raw
 * @returns {number[]}
 */
function migrateOrder(raw) {
  var incoming = Array.isArray(raw) ? raw.map(Number).filter(isFinite) : [];
  var out = [];
  for (var i = 0; i < incoming.length; i++)
    if (TRUCK_ITEM_POOL.indexOf(incoming[i]) !== -1 && out.indexOf(incoming[i]) === -1)
      out.push(incoming[i]);
  for (var j = 0; j < TRUCK_ITEM_POOL.length; j++)
    if (out.indexOf(TRUCK_ITEM_POOL[j]) === -1) out.push(TRUCK_ITEM_POOL[j]);
  return out;
}

/**
 * 注入模块配置：写优先级顺序 + 不参与集合 + 出征预设，重建 rankMap；刷新时刻表（cap × 模板）变更即重排24 格分配。
 * @param {object} partial { order:number[], off:number[], preset:number }（toModuleCfg 产出）
 */
function configure(partial) {
  order = migrateOrder(partial && partial.order);
  disabled = new Set(
    ((partial && partial.off) || []).map(Number).filter(function (n) {
      return isFinite(n) && TRUCK_ITEM_POOL.indexOf(n) !== -1;
    }),
  );
  presetIdx = Math.max(1, Number(partial && partial.preset) || 1);
  // 品级集合：只保留合法 1~5；空集合语义=不限制（不因其误清而静默屏蔽全部）
  var gs = ((partial && partial.grades) || []).map(Number).filter(function (n) {
    return ALL_GRADES.indexOf(n) !== -1;
  });
  gradeSet = new Set(gs);
  threatOn = !(partial && partial.threat === false);
  // 战力比阈值：面板可调（<=0 或非数回退默认），驱动 assess 与面板上限展示
  var rc = Number(partial && partial.ratioCounter),
    rms = Number(partial && partial.ratioSame),
    rr = Number(partial && partial.ratioCountered);
  ratio.counter = rc > 0 ? rc : RATIO_DEFAULT.counter;
  ratio.same = rms > 0 ? rms : RATIO_DEFAULT.same;
  ratio.countered = rr > 0 ? rr : RATIO_DEFAULT.countered;
  // 今日刷新上限 + 时段模板：面板可调（非数/非法档回退默认）；cap 按模板占比分到 24 格，直接决定各格间隔
  var nextCap = Math.max(
    1,
    Math.floor(Number(partial && partial.refreshCap) || REFRESH.capDefault),
  );
  var nextPreset = REFRESH_PRESETS[partial && partial.refreshPreset]
    ? partial.refreshPreset
    : REFRESH.presetDefault;
  if (nextCap !== refreshCap || nextPreset !== refreshPreset) {
    refreshCap = nextCap;
    refreshPreset = nextPreset;
    slotCounts = allocateSlots(REFRESH_PRESETS[refreshPreset], refreshCap);
    // 时刻表变了：kick 立即跑一轮落到新表（睡眠中被打断、在飞时合并为 pending，本轮尾返 0 补扫）；
    // 格点仍幂等——nextGridPointMs 只取未来格点、不回填已错过点，这次即时刷多出的一次往返由 reloadGap 节流 + refreshUsed≥cap 总闸封顶。
    if (aliveFn()) cycle.kick();
  }
  rankMap = new Map();
  for (var i = 0; i < order.length; i++) rankMap.set(order[i], i);
  if (threatOn && (presetIdx !== prevPreset || !my.ready)) cycle.kick(); // 换攻击预设/尚未探到：唤醒一轮刷新展示快照（配额耗尽也能探；缓存作废靠 powerFp 比对，不在此处做）
  prevPreset = presetIdx;
  bus.emit('ui.refresh'); // 阈值/开关变更后即时重算面板“可打上限”展示
}

/**
 * 一车货物里命中「已勾选参与且尚有存货」物品的最优（最小）rank；无命中返回 -1。
 * 槽位被抢后 itemId 仍留在 lootRewardResult、只有 itemCount 归 0（口径同游戏 empty.active），故空槽不算命中。
 * @param {object} view LootTruckView
 * @returns {{rank:number, itemId:number}}
 */
function matchWanted(view) {
  var list = (view && view.lootRewardResult) || [];
  var best = -1,
    bestId = 0;
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {};
    var id = Number(entry.itemId);
    if (!isFinite(id)) continue;
    if (Number(entry.itemCount) <= 0) continue; // 已被抢空的槽（itemCount=0）不参与命中
    if (disabled.has(id)) continue;
    var rank = rankMap.get(id);
    if (rank === undefined) continue; // 池外物品不参与
    if (best === -1 || rank < best) {
      best = rank;
      bestId = id;
    }
  }
  return { rank: best, itemId: bestId };
}

// ── 当日拉黑 ─────────────────────────────────────────────────────────────
/**
 * 跨日收敛：日期一变即清空内存拉黑表与当日计数表
 */
function ensureDay() {
  var today = todayStr();
  if (blocked.day === today && stats.day === today) return;
  blocked = { day: today, trucks: [] };
  stats = { day: today, refreshUsed: 0, tried: 0, win: 0, fail: 0, rejected: 0 };
}

/**
 * 读回当日拉黑（run 启动时一次）：存档 date 与今日相符才采纳
 * @returns {Promise<void>}
 */
async function loadBlocked() {
  ensureDay();
  var saved;
  try {
    saved = await storage.data.get(DATA_NAME);
  } catch (e) {
    saved = null;
  }
  if (
    saved &&
    typeof saved === 'object' &&
    saved.date === todayStr() &&
    Array.isArray(saved.trucks)
  ) {
    blocked = { day: saved.date, trucks: saved.trucks.map(String) };
  }
}

/**
 * 读回当日计数（run 启动时一次）：存档 date 与今日相符才采纳，否则保持 ensureDay 的归零值
 * @returns {Promise<void>}
 */
async function loadStats() {
  ensureDay();
  var saved;
  try {
    saved = await storage.data.get(DATA_NAME_STATS);
  } catch (e) {
    saved = null;
  }
  if (saved && typeof saved === 'object' && saved.date === todayStr()) {
    stats = {
      day: saved.date,
      refreshUsed: Number(saved.refreshUsed) || 0,
      tried: Number(saved.tried) || 0,
      win: Number(saved.win) || 0,
      fail: Number(saved.fail) || 0,
      rejected: Number(saved.rejected) || 0,
    };
  }
}

/**
 * 落盘当日计数（fire-and-forget，失败仅记日志；storage.data 串行队列保证不串写）
 */
function saveStats() {
  storage.data
    .set(DATA_NAME_STATS, {
      date: stats.day,
      refreshUsed: stats.refreshUsed,
      tried: stats.tried,
      win: stats.win,
      fail: stats.fail,
      rejected: stats.rejected,
    })
    .catch(function (err) {
      log.warn('persist truck stats failed.', err);
    });
}

/**
 * 拉黑一车至当日不再重发（落 storage.data，失败仅记日志）
 * @param {string} key truckId 串
 * @returns {Promise<void>}
 */
async function rejectToday(key) {
  ensureDay();
  if (blocked.trucks.indexOf(key) === -1) blocked.trucks.push(key);
  try {
    await storage.data.set(DATA_NAME, { date: blocked.day, trucks: blocked.trucks });
  } catch (err) {
    log.warn('persist blocked failed.', err);
  }
}

// ── 每日配额同步 ─────────────────────────────────────────────────────────
/**
 * 直发一条 PBV2 请求并归一化，永不 reject；同 cmd 在途回落 CODE_NOT_SENT 哨兵。
 * @param {number} cmd
 * @param {object} body
 * @returns {Promise<{ok:boolean, code:number, data:*}>}
 */
async function send(cmd, body) {
  if (net.isSending(cmd)) return { ok: false, code: CODE_NOT_SENT, data: null };
  var ret;
  try {
    ret = await net.sendPBV2(cmd, body);
  } catch (err) {
    log.debug('cmd %d send failed: %s', cmd, err && err.message);
    return { ok: false, code: CODE_NOT_SENT, data: null };
  }
  return { ok: ret.ok, code: ret.code, data: ret.data };
}

/**
 * 取网络底座：运行中用 install 注入的 ctx.net；功能未启用时（面板“刷新”预览）懒取全局 pocketcc.net 并 install。
 * @returns {object|null}
 */
function ensureNet() {
  if (net) return net;
  var g = typeof window !== 'undefined' && window.pocketcc && window.pocketcc.net;
  if (g && g.install && g.install()) net = g;
  return net || null;
}

/**
 * 旧 send 链路（999/927）：与 send(PBV2) 分流；net.send 的 ret.data 常为原始 JSON 串，统一兑 parse。
 * 同 cmd 在途/异常回落 CODE_NOT_SENT 哨兵（不当真拒绝）。永不 reject。
 * @param {number} cmd
 * @param {object} body
 * @returns {Promise<{ok:boolean, code:number, data:*}>}
 */
async function sendLegacy(cmd, body) {
  var n = ensureNet();
  if (!n) return { ok: false, code: CODE_NOT_SENT, data: null };
  if (n.isSending(cmd)) return { ok: false, code: CODE_NOT_SENT, data: null };
  var r;
  try {
    r = await n.send(cmd, body);
  } catch (err) {
    log.debug('cmd %d send failed: %s', cmd, err && err.message);
    return { ok: false, code: CODE_NOT_SENT, data: null };
  }
  var d = r.data;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch (e) {
      /* 非 JSON 保留原串 */
    }
  }
  return { ok: r.ok, code: r.code, data: d };
}

/**
 * 拉 6486 同步每日配额 + func_type 上限（lootNum/loot_num_max_daily/loot_num_max_same_truck/open_level/nextRefreshLootNumTime）。
 * 落 daily，永不 reject。
 * @returns {Promise<void>}
 */
async function fetchRefresh() {
  var r = await send(CMD_REFRESH, { funcType: FUNC_TYPE });
  if (r.code === CODE_NOT_SENT || !r.data || typeof r.data !== 'object') return;
  applyRefresh(r.data);
}

/**
 * 把 6486/21551/6476 应答里的配额信息并入 daily（应答带 lootNum 即当日已用，权威覆盖）
 * @param {object} d 应答 data（含 funcType/lootNum/nextRefreshLootNumTime）
 */
function applyRefresh(d) {
  if (d.funcType != null && Number(d.funcType) !== FUNC_TYPE) return;
  if (typeof d.lootNum === 'number') daily.used = d.lootNum;
  if (d.nextRefreshLootNumTime != null) daily.refreshMs = int64ToNum(d.nextRefreshLootNumTime);
  // func_type 上限（随版本基本不变，每次刷列表前取一次即可）
  var row = l10n.tableRow('escort_truck_func_type', FUNC_TYPE);
  if (row) {
    daily.maxDaily = Number(row.loot_num_max_daily) || 0;
    daily.sameTruckMax = Number(row.loot_num_max_same_truck) || 0;
    daily.openLevel = Number(row.open_level) || 0;
  }
}

/**
 * 今日剩余拦截次数
 * @returns {number}
 */
function dailyLeft() {
  return daily.maxDaily > 0 ? Math.max(0, daily.maxDaily - daily.used) : 0;
}

// ── 编队 ────────────────────────────────────────────────────────────────
/**
 * 从预设队伍造 6476 troop（heroList:[{heroId}] / armyPosList:[{pos,armyId,armyNum}] / formationV2）。
 * battle 产出的 heroList 是纯 id 数组、armyListNew 即 armyPosList 口径，这里做字段名/形态适配。
 * @returns {object|null} 无兵可派返回 null
 */
function buildTroop() {
  // 启用判定时复用 probeSelf 算好的未过滤 raw 编成（与 999 分母同源）；否则沿用过滤+重算版
  var data = threatOn && my.raw ? my.raw : new Battle().plan().preset(presetIdx).adjust().build();
  if (!data || !data.armyListNew || !data.armyListNew.length) return null;
  var armyPosList = data.armyListNew.map(function (a) {
    var e = { pos: a.pos | 0, armyId: a.armyId, armyNum: a.armyNum | 0 };
    if (a.heroCap) e.heroCap = a.heroCap;
    if (a.skinId) e.skinId = a.skinId;
    return e;
  });
  var heroList = (data.heroList || []).map(function (id) {
    return { heroId: id };
  });
  return { heroList: heroList, armyPosList: armyPosList, formationV2: data.formationV2 | 0 };
}

// ── 战力/军种探测 + 克制判定 ──────────────────────────────
/**
 * Int64（{_low,_high} / 数字 / 字符串）→ 十进制字符串（reportId 回发用，BigInt 无精度损失；与 int64Key 的 _high:_low 身份键不同）。
 * @param {*} v
 * @returns {string}
 */
function i64Str(v) {
  if (v == null) return '';
  if (typeof v === 'object' && typeof v._high === 'number' && typeof v._low === 'number') {
    try {
      return ((BigInt(v._high) << 32n) | BigInt(v._low >>> 0)).toString();
    } catch (e) {
      return '';
    }
  }
  return String(v);
}

/**
 * 品级是否命中勾选集（空集=不限制；grade=0 表解析不到→ fail-open 不淘汰）。
 * @param {number} grade
 * @returns {boolean}
 */
function gradeOk(grade) {
  if (gradeSet.size === 0) return true;
  var g = Number(grade) || 0;
  if (!g) return true;
  return gradeSet.has(g);
}

/**
 * 英雄 id → 军种（hero 表 army_type）；非 101/201/301 一律当 0（不可用）。
 * @param {number|string} id
 * @returns {number} 101陆 / 201海 / 301空 / 0 未知
 */
function heroBranch(id) {
  if (id == null) return 0;
  var r = l10n.tableRow('hero', id);
  var t = r && (r.army_type != null ? r.army_type : r.armyType);
  var n = Number(t);
  return n === BRANCH.LAND || n === BRANCH.SEA || n === BRANCH.AIR ? n : 0;
}

/**
 * 英雄 id 数组 → 多数投票定军种（计数最高者；全不可用返回 0）。
 * @param {Array<number|string>} heroIds
 * @returns {number} 101/201/301/0
 */
function majorityBranch(heroIds) {
  var cnt = {},
    best = 0,
    bc = 0;
  (heroIds || []).forEach(function (id) {
    var b = heroBranch(id);
    if (!b) return;
    cnt[b] = (cnt[b] || 0) + 1;
    if (cnt[b] > bc) {
      bc = cnt[b];
      best = b;
    }
  });
  return best;
}

/**
 * 用 scoutReportId 走 927 拉战报 → defender.players[0].heroList → 多数投票得对方军种。失败/无报返回 0。
 * @param {string} scoutId 十进制串
 * @returns {Promise<number>} 101/201/301/0
 */
async function enemyBranch(scoutId) {
  if (!scoutId) return 0;
  var r = await sendLegacy(CMD_REPORT, { reportId: scoutId });
  if (!r || !r.ok || !r.data || typeof r.data !== 'object') return 0;
  var rs = r.data.reportStr;
  if (typeof rs === 'string') {
    try {
      rs = JSON.parse(rs);
    } catch (e) {
      return 0;
    }
  }
  var def = rs && rs.battle && rs.battle.defender;
  var pl = def && def.players && def.players[0];
  var heroes = (pl && pl.heroList) || [];
  var ids = heroes.map(function (h) {
    return h && h.id != null ? h.id : h;
  });
  return majorityBranch(ids);
}

/**
 * 编成指纹：标识“999 缓存属于哪一份兵力”。走 preset 号 + 英雄集 + 总兵量 + 阵型，
 * 游戏内直接改该预设的英雄/兵种也会变（比只用 presetIdx 作判据更准），成本仅本地字符串拼接。
 * @param {object} raw Battle 未过滤满编构建
 * @returns {string}
 */
function troopFingerprint(raw) {
  var n = 0;
  var list = raw.armyListNew || [];
  for (var i = 0; i < list.length; i++) n += list[i].armyNum | 0;
  return presetIdx + '|' + (raw.heroList || []).join(',') + '|' + n + '|' + (raw.formationV2 | 0);
}

/**
 * 每轮刷列表前算一次我方出征侧：raw 满编编成→ 999 战力（battlePowerVal）+ heroList 多数投票定我方军种。
 * 战力走缓存（powerCache，按编成指纹 powerFp 认同源）：powerAge 达 POWER_CACHE_EVERY、超 POWER_MAX_AGE_MS、指纹变了或 force
 * 才真实发 999，编成/军种仍每轮本地重算。查询失败不覆盖旧值（宁用略旧战力也别把“只打能赢”打成 fail-open）。
 * 失败（无兵/无有效缓存）时 ready=false，上层退回不做战力/克制过滤的降级模式。落 my，永不 reject。
 * @param {boolean} [force] true=无视缓存强制重查 999（面板「刷新我方战力」按钮）
 * @returns {Promise<void>}
 */
async function probeSelf(force) {
  my.ready = false;
  my.power = 0;
  my.branch = 0;
  my.raw = null;
  my.tried = false;
  var raw = new Battle().plan().preset(presetIdx).build();
  if (!raw || !raw.armyListNew.length) {
    my.tried = true;
    log.debug('preset %d raw empty, threat probe skipped.', presetIdx);
    bus.emit('ui.refresh');
    return;
  }
  my.raw = raw;
  my.branch = majorityBranch(raw.heroList);
  var fp = troopFingerprint(raw);
  var same = fp === powerFp && powerCache > 0; // 缓存是否属于本轮编成（换预设/游戏内改队会变）
  var stale = !same || powerAge >= POWER_CACHE_EVERY || Date.now() - powerAt > POWER_MAX_AGE_MS;
  if ((force || stale) && !powerProbing) {
    var atPreset = presetIdx;
    powerAge = 0;
    powerProbing = true;
    var pow, code;
    try {
      var r = await sendLegacy(CMD_POWER, {
        armyListNew: raw.armyListNew,
        heroList: raw.heroList,
        formation: 0,
        formationV2: raw.formationV2 | 0,
      });
      code = r && r.code;
      pow =
        r && r.ok && r.data && typeof r.data === 'object' ? Number(r.data.battlePowerVal) || 0 : -1;
    } finally {
      powerProbing = false;
    }
    if (atPreset !== presetIdx) {
      // 在飞期间面板换了预设：本次应答与刚算的 raw/branch 均属旧编成，整块作废（buildTroop 需回落到按新预设实时重算），
      // 不把判定留在“旧队出兵 + 无战力过滤”的窗口里；configure 已 kick，cycle pending 会用新预设补探一轮
      my.raw = null;
      my.branch = 0;
      my.tried = true;
      log.debug('999 answer dropped: preset %d -> %d, re-probe next round.', atPreset, presetIdx);
      bus.emit('ui.refresh');
      return;
    }
    if (pow >= 0) {
      powerCache = pow;
      powerFp = fp;
      powerAt = Date.now();
      log.debug('999 power refreshed: %d (cache every %d lists).', powerCache, POWER_CACHE_EVERY);
    } else {
      // 没拿到新值（在途碰撞/异常/真拒）：同编成旧战力保留直接用（不把“只打能赢”打成 fail-open），旧编成缓存则下面当作未探到；
      // 年龄拉到只差一次列表往返：重试挂在“真实列表往返”上，避免持续被拒时999每轮刷屏（同本 feat 的撞限额教训）
      powerAge = POWER_CACHE_EVERY - 1;
      if (same) log.debug('999 refresh failed(code=%d), keep cached power=%d.', code, powerCache);
      else log.debug('999 power unavailable(code=%d), degrade: skip power/counter filter.', code);
    }
  } else if (force || stale) {
    log.debug('999 probe already in flight, reuse power=%d.', powerCache); // 面板按钮撞上循环在途：不另开一枪，直接用现有缓存刷新展示
  }
  my.power = powerFp === fp && powerCache > 0 ? powerCache : 0; // 只认同源战力：旧编成的缓存对新编成一律当作未探到
  my.ready = my.power > 0;
  my.tried = true;
  if (my.ready) log.debug('self probe: power=%d branch=%d.', my.power, my.branch);
  bus.emit('ui.refresh'); // 刷新面板“我方战力/军种 + 三军种可打上限”展示
}

/**
 * 面板「刷新我方战力」按钮：即使功能未启用也能预览——按面板当前选中的预设号懒加载全局 net 后探一次。
 * @param {object} cfg 面板 configs（含 preset）
 * @returns {Promise<void>}
 */
function probeForPanel(cfg) {
  presetIdx = Math.max(1, Number(cfg && cfg.preset) || presetIdx);
  if (!ensureNet()) {
    my.tried = true;
    bus.emit('ui.refresh');
    return Promise.resolve();
  }
  return probeSelf(true); // 面板按钮是显式动作：无视缓存强制重查
}

/**
 * 根据我方快照 + 对方战力/军种判是否值得打（战力比 r=敌/我）：
 *   我克敌 ≤ratio.counter、同军种 ≤ratio.same、我被克 ≤ratio.countered（需敌低于我一段才打）。
 * 降级口径：我方战力未探到 → fail-open 放行（退回旧行为）；对方军种未知 → fail-closed 不打（宁可漏不可错）。
 * @param {number} enemyPower view.battlePower
 * @param {number} enemyBranch 101/201/301/0
 * @returns {{go:boolean, why:string}}
 */
function assess(enemyPower, enemyBranch) {
  if (!my.ready || !my.power) return { go: true, why: 'degraded:no-my-power' };
  if (!enemyPower) return { go: false, why: 'no-enemy-power' };
  if (!enemyBranch) return { go: false, why: 'unknown-enemy-branch' };
  var me = my.branch;
  var r = enemyPower / my.power;
  var lim;
  if (me && BEATS[me] === enemyBranch)
    lim = ratio.counter; // 我克敌
  else if (me && BEATS[enemyBranch] === me)
    lim = ratio.countered; // 我被克
  else lim = ratio.same; // 同军种 / 我方军种未知（保守）
  return {
    go: r <= lim + 1e-9,
    why: (me || '?') + 'vs' + enemyBranch + ':' + r.toFixed(2) + '<=' + lim,
  };
}

/** 军种码 → 中文简称 */
function branchName(b) {
  return b === 101 ? '陆' : b === 201 ? '海' : b === 301 ? '空' : '?';
}

/** 大数字紧凑串（近似游戏 K/M/B/T 阶梯，仅用于面板展示） */
function fmtPower(n) {
  n = Number(n) || 0;
  var u = ['', 'K', 'M', 'B', 'T'];
  var i = 0;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return i ? n.toFixed(1) + u[i] : String(Math.round(n));
}

/**
 * 按当前 ratio 阈值 + 我方军种，算出对陆/海/空三军种各自「可打的敌方战力上限」（供面板直观展示）。
 * 我方战力未探到时返回 {ready:false}。
 * @returns {{ready:boolean, list?:Array<{b:number, rel:string, lim:number, ceil:number}>}}
 */
function branchCeilings() {
  if (!my.ready || !my.power) return { ready: false };
  var me = my.branch;
  var list = [101, 201, 301].map(function (b) {
    var rel, lim;
    if (me && BEATS[me] === b) {
      rel = '我克';
      lim = ratio.counter;
    } else if (me && BEATS[b] === me) {
      rel = '被克';
      lim = ratio.countered;
    } else {
      rel = '同军';
      lim = ratio.same;
    }
    return { b: b, rel: rel, lim: lim, ceil: my.power * lim };
  });
  return { ready: true, list: list };
}

// ── 单车攻击判定 + 连打 ──────────────────────────────────────
/**
 * 单车 escort_truck 规格行（loot_num_max/fail_times）
 * @param {number} truckSpecId
 * @returns {{lootMax:number, failMax:number}|null}
 */
function truckSpec(truckSpecId) {
  var s = l10n.tableRow('escort_truck', truckSpecId);
  if (!s) return null;
  return {
    lootMax: Number(s.loot_num_max) || 0,
    failMax: Number(s.fail_times) || 0,
    grade: Number(s.grade) || 0,
  };
}

/**
 * 一车当前是否可发起拦截（逐条复刻 checkTruckInterceptEnable，读 view 最新计数；口径与源码一致用 >=，fail-closed：表值缺省即视为不可打）
 * @param {object} cand 候选 {view, key, spec}
 * @returns {boolean}
 */
function attackable(cand) {
  var v = cand.view,
    spec = cand.spec;
  if (daily.openLevel > 0 && gameData.level() < daily.openLevel) return false; // ①未达功能解锁等级
  if (daily.used >= daily.maxDaily) return false; // ②每日配额
  if ((v.myLootNum | 0) >= daily.sameTruckMax) return false; // ③我对该车成功数
  if ((v.myLootFailNum | 0) >= spec.failMax) return false; // ④我对该车失败数
  if ((v.lootNum | 0) >= spec.lootMax) return false; // ⑤该车被抢空
  return true;
}

/**
 * 对一辆车「打到不能打为止」：只要仍每日有次数、该车仍可打且仍命中已勾选物品，就反复 6476。
 * 每发后读应答权威覆盖 daily.used 与该车计数；被服务器拒即当日拉黑该车并收手。永不 reject。
 * 带每车每轮硬护栏（maxTries）：正常打满也到不了，仅防应答字段结构漂移致计数不推进而死循环白耗配额。
 * @param {object} cand 候选
 * @returns {Promise<string>} 'done'（正常收敛/无兵）| 'blacklisted'（服务器拒绝已拉黑）| 'notsent'（在途/异常收手）
 */
async function lootFlow(cand) {
  var v = cand.view;
  var maxTries = (cand.spec.failMax || 5) + (daily.sameTruckMax || 2) + 2;
  var tries = 0;
  while (aliveFn() && dailyLeft() > 0 && attackable(cand) && matchWanted(v).rank !== -1) {
    if (++tries > maxTries) {
      log.warn(
        'truck %s hit per-round try cap %d, stop (counters not converging?).',
        cand.key,
        maxTries,
      );
      return 'done';
    }
    var troop = buildTroop();
    if (!troop) {
      log.debug('preset %d has no dispatchable army, stop truck %s.', presetIdx, cand.key);
      return 'done';
    }
    var ret = await send(CMD_LOOT, { funcType: FUNC_TYPE, truckId: v.truckId, troop: troop });
    if (!aliveFn()) return 'done';
    if (ret.code === CODE_NOT_SENT) return 'notsent'; // 在途/异常：本轮此车收手，留待下轮
    if (!ret.ok || !ret.data || typeof ret.data !== 'object') {
      log.info(
        'loot rejected, blacklist today. truck=%s;code=%d;data=%s',
        cand.key,
        ret.code,
        safeStringify(ret.data),
      );
      stats.rejected++;
      saveStats();
      bus.emit('ui.refresh'); // 服务器硬拒（已在上方排除 CODE_NOT_SENT）：计入拒绝旁路量，不计入 tried
      await rejectToday(cand.key);
      return 'blacklisted';
    }
    var d = ret.data;
    if (typeof d.lootNum === 'number') daily.used = d.lootNum;
    var nv = d.lootTruckView;
    if (nv) {
      v.lootNum = nv.lootNum | 0;
      v.myLootNum = nv.myLootNum | 0;
      v.myLootFailNum = nv.myLootFailNum | 0;
      if (Array.isArray(nv.lootRewardResult)) v.lootRewardResult = nv.lootRewardResult;
    }
    if (typeof d.isWin === 'boolean') {
      stats.tried++;
      if (d.isWin) stats.win++;
      else stats.fail++;
      saveStats();
      bus.emit('ui.refresh');
    } // 真打了一仗：胜/负入注（tried=win+fail 恒成立）
    if (d.isWin) {
      log.info(
        'loot WIN. truck=%s;item=%d(%s);truckLoot=%d/%d;daily=%d/%d',
        cand.key,
        cand.itemId,
        cand.itemName || '?',
        v.lootNum | 0,
        cand.spec.lootMax,
        daily.used,
        daily.maxDaily,
      );
      bus.emit('ui.refresh');
    } else {
      log.info(
        'loot fail. truck=%s;fail=%d/%d;daily=%d/%d',
        cand.key,
        v.myLootFailNum | 0,
        cand.spec.failMax,
        daily.used,
        daily.maxDaily,
      );
    }
    if (!aliveFn()) return 'done';
    await sleep(cfg.lootGap);
  }
  return 'done';
}

// ── 刷列表（生产） ───────────────────────────────────────────────────────
/**
 * 刷一轮：同步配额 → 配额闸门 → 拉列表（首发 6473/后续 6474，reloadGap 节流）→ 过滤可打候选（命中勾选物品 + 通过校验 + 未被拒拉黑）
 *   → 按优先级升序排 → 整批替换 queue → 交消费。永不 reject。
 * @returns {Promise<void>}
 */
async function doScan() {
  try {
    await fetchRefresh();
    if (!aliveFn()) return;
    if (threatOn) await probeSelf(); // 解耦：每轮一进来先探我方快照（不依赖配额/新列表），保证面板展示与后续判定都有数据
    if (daily.maxDaily <= 0) {
      log.debug('escort_truck_func_type row unavailable, skip scan.');
      queue.length = 0;
    } else if (dailyLeft() <= 0) {
      log.debug('daily loot exhausted (%d/%d), stop scan.', daily.used, daily.maxDaily);
      queue.length = 0;
    } else if (listOpened && Date.now() - lastReloadAt < cfg.reloadGap) {
      log.debug('reload too soon (<%dms since last), skip this round.', cfg.reloadGap); // 距上次重随机太近：本轮不出新列表（格点不补，下一格点照常）
    } else {
      var cmd = listOpened ? CMD_RELOAD : CMD_OPEN;
      var ret = await send(cmd, { funcType: FUNC_TYPE, localServerDisable: 1 });
      lastReloadAt = Date.now();
      if (!aliveFn()) return;
      if (ret.code !== CODE_NOT_SENT) {
        stats.refreshUsed++;
        powerAge++;
        saveStats();
        bus.emit('ui.refresh');
      } // 真实列表往返（含空/拒）计一次刷新预算，同时推战力缓存年龄
      if (!ret.ok || !ret.data || !Array.isArray(ret.data.lootTruckViewList)) {
        log.debug('loot list empty/rejected. cmd=%d;code=%d', cmd, ret.code);
        queue.length = 0;
      } else {
        listOpened = true;
        if (typeof ret.data.lootNum === 'number') daily.used = ret.data.lootNum; // 列表应答也带当日已用，随手校准
        skipRound = new Set(); // 新列表（重随机）→ 清上轮“打不过”跳过集
        if (!aliveFn()) return;
        queue = buildCandidates(ret.data.lootTruckViewList);
        if (threatOn && queue.length && my.ready) {
          queue = await refineThreat(queue);
          if (!aliveFn()) return;
        }
        if (queue.length)
          log.debug(
            'loot list ready. candidates=%d;daily=%d/%d',
            queue.length,
            daily.used,
            daily.maxDaily,
          );
      }
    }
  } catch (err) {
    log.warn('scan error.', err);
    queue.length = 0;
  }
}

/**
 * 从原始车队列表构造粗筛候选：命中已勾选物品 + 通过攻击校验 + 未被当日拉黑/本轮跳过 + 非同联盟 + 品级命中
 *   + （启用判定时）战力粗筛（敌 > 我×1.5 连克制都赢不了 → 直接淘汰，省一次 927）→ 按优先级升序。
 * @param {object[]} list LootTruckView 数组
 * @returns {object[]} 候选（{view,key,rank,itemId,itemName,spec}）
 */
function buildCandidates(list) {
  var myAid = gameData.myAid();
  ensureDay();
  var cands = [];
  for (var i = 0; i < list.length; i++) {
    var view = list[i];
    if (!view) continue;
    var key = int64Key(view.truckId);
    if (!key || blocked.trucks.indexOf(key) !== -1) continue; // 当日被服务器拒绝拉黑
    if (skipRound.has(key)) continue; // 本轮已判“打不过”跳过（内存态，与拒绝拉黑分离）
    var m = matchWanted(view);
    if (m.rank === -1) continue; // 无命中已勾选物品
    var uv = view.userView || {};
    if (myAid > 0 && int64ToNum(uv.allianceId) === myAid) continue; // ⑥同联盟（dailyEscort 不可打）
    var spec = truckSpec(view.truckSpecId);
    if (!spec) continue;
    if (!gradeOk(spec.grade)) continue; // 品级不在拦截范围
    if (threatOn && my.ready) {
      // 战力粗筛（只排“克制也打不过”的硬天花板）
      var bp = Number(view.battlePower) || 0;
      if (bp && bp > my.power * ratio.counter) continue;
    }
    var cand = {
      view: view,
      key: key,
      rank: m.rank,
      itemId: m.itemId,
      itemName: item.label(m.itemId),
      spec: spec,
      grade: spec.grade,
    };
    if (attackable(cand)) cands.push(cand);
  }
  cands.sort(function (a, b) {
    return a.rank - b.rank;
  });
  return cands;
}

/**
 * 对粗筛存活候选逐条细判：按优先级序取 scoutReportId 走 927 拉对方军种 → assess → 只留“打得起”的，
 *   打不过的进本轮 skipRound（不落库）。927 逐条串行，单轮上限 MAX_THREAT_LOOK 台（超出本轮丢弃、下轮重随机再评）。
 * 降级：我方战力未探到（my.ready=false）时不做细判，原样返回（由 assess 的 fail-open 接管）。
 * @param {object[]} cands buildCandidates 产物
 * @returns {Promise<object[]>} 细判后的可打候选
 */
async function refineThreat(cands) {
  if (!my.ready) return cands;
  var MAX_THREAT_LOOK = 15;
  var out = [],
    looked = 0;
  for (var i = 0; i < cands.length; i++) {
    if (!aliveFn()) return out; // 已 pause：未处理的下轮 rebuild
    var c = cands[i];
    var eb = 0;
    if (looked < MAX_THREAT_LOOK) {
      var scout = i64Str(c.view.scoutReportId);
      if (scout) {
        eb = await enemyBranch(scout);
        looked++;
      }
    } else {
      break; // 达本轮 927 上限，余下不评不入队
    }
    var a = assess(Number(c.view.battlePower) || 0, eb);
    if (a.go) out.push(c);
    else {
      skipRound.add(c.key);
      log.debug('threat skip truck %s (%s).', c.key, a.why);
    }
  }
  return out;
}

// ── 消费 ────────────────────────────────────────────────────────────────
/**
 * 串行消费候选队列：逐条 lootFlow（内部打到不能打为止）。重入防护交给 cycle 内部单飞闸门（在飞时外部 kick 只合并为 pending，不会并发进入本函数）。永不 reject。
 * @returns {Promise<void>}
 */
async function consume() {
  var rejectStreak = 0;
  while (queue.length && aliveFn()) {
    if (dailyLeft() <= 0) {
      log.debug('daily loot exhausted, drain stopped.');
      queue.length = 0;
      break;
    }
    var cand = queue.shift();
    var res;
    try {
      res = await lootFlow(cand);
    } catch (err) {
      log.warn('loot flow threw.', err);
    }
    // 连续两台不同车被服务器硬拒（非在途哨兵）→ 判为全局闸门（配额耗尽/功能未开/系统繁忙），
    // 立即清空本轮队列停摆，避免逐车撞限额并把当天所有目标车误拉黑（对齐撞限额刷屏既有教训）。
    if (res === 'blacklisted') {
      if (++rejectStreak >= 2) {
        log.info(
          'consecutive server rejects (%d), likely a global gate; halt queue this round.',
          rejectStreak,
        );
        queue.length = 0;
        break;
      }
    } else {
      rejectStreak = 0;
    }
  }
}

/**
 * 当前服务器本地时刻（ms）。serverTime() 为秒，×1000 对齐 daily.refreshMs（ms）。
 * @returns {number}
 */
function serverNowMs() {
  return gameData.serverTime() * 1000;
}

/**
 * 本游戏日的 0 点绝对时刻（ms）：以 daily.refreshMs（下一个刷新点）回推 24h。
 * 刷新点尚未被 6486/21551 推正（已过期）时向后滚整日，保证 dayStart ≤ now < dayStart+24h——纯服务器时钟口径，不受浏览器时区干扰。
 * @param {number} nowMs
 * @returns {number}
 */
function dayStartMs(nowMs) {
  var d = daily.refreshMs - 86400000;
  while (d + 86400000 <= nowMs) d += 86400000;
  return d;
}

/** 当前时刻落在第几格（-1 = 尚未同步到刷新点） */
function curSlotOf(nowMs) {
  return daily.refreshMs ? Math.floor((nowMs - dayStartMs(nowMs)) / REFRESH.slotMs) : -1;
}

/**
 * 把 cap 按 24 格占比分配为整数次数（最大余数法）：先按比例取整，剩下名额按小数部分降序补齐（同分按格序）。
 * 保证 Σ = cap，且不因逐项 floor 把小占比格整天吐掉。占比全 0 / cap<=0 → 全 0（当天不排刷新）。
 * @param {number[]} weights 24 格占比（相对量纲）
 * @param {number} cap 今日刷新总数
 * @returns {number[]} 24 格各自的刷新次数
 */
function allocateSlots(weights, cap) {
  var ws = [],
    sum = 0,
    i;
  for (i = 0; i < 24; i++) {
    var w = Math.max(0, Number(weights[i]) || 0);
    ws.push(w);
    sum += w;
  }
  if (sum <= 0 || cap <= 0) return new Array(24).fill(0);
  var counts = [],
    fracs = [],
    used = 0;
  for (i = 0; i < 24; i++) {
    var exact = (cap * ws[i]) / sum,
      n = Math.floor(exact);
    counts.push(n);
    fracs.push({ slot: i, frac: exact - n });
    used += n;
  }
  fracs.sort(function (a, b) {
    return b.frac - a.frac || a.slot - b.slot;
  });
  // 余数 = Σfrac且每项 <1 → 正小数的个数必 >= 余数，逐个 +1 即可补齐（最多 23 轮）
  for (var k = 0; k < 24 && used < cap; k++) {
    if (fracs[k].frac <= 0) break;
    counts[fracs[k].slot]++;
    used++;
  }
  return counts;
}

/**
 * 下一格点（绝对时刻 ms），静态时刻表口径：本格内取第一个不早于 now 的点（k = ceil((now-格起点)/格内间隔)），
 * 本格点位已走完就顺延到后面第一个有配额的格——错过的格点不补刷，天然实现「已流逝时间扣掉对应次数」。
 * 格边界安全：上一格末点（3600-step）距下一格首点恰为一个格内间隔，不会扎堆。找不到返回 null。
 * @param {number} nowMs
 * @returns {number|null}
 */
function nextGridPointMs(nowMs) {
  var dayStart = dayStartMs(nowMs);
  for (var i = 0; i < 24; i++) {
    var n = slotCounts[i] | 0;
    if (n <= 0) continue; // 0 占比格：整小时不刷
    var start = dayStart + i * REFRESH.slotMs,
      step = REFRESH.slotMs / n;
    var k = Math.ceil((nowMs - start) / step);
    if (k < 0) k = 0; // 尚未开始的格：取其首点
    if (k >= n) continue; // 本格点位已全部走过：顺延
    return start + k * step;
  }
  return null;
}

/**
 * 下一轮刷新间隔：查静态时刻表取下一个格点（cap 定总量、模板定各小时占比，间隔与 cap 单调相关）。
 *   ① 成功配额耗尽 → 睡到服务器刷新点(+缓冲)；② 实际往返次数触 cap → 防失控，睡到下一刷新点；
 *   ③ 未同步到刷新点 → 退化 activeRefresh；④ 今日格点走完（占比全 0 或已过完）→ 睡到日界。
 *   长睡按 hopCap 分段：醒来重查同一张表（格点幂等，不会补刷），兼防 refreshMs 被推正后还睡在旧日帧上。
 * 长期运行排查：各出口收敛为一条 debug 决策日志，reason 定位闸门、slot/step 展示本格计划密度。
 * @returns {number} 毫秒
 */
function planNextRefresh() {
  var nowMs = serverNowMs();
  var delay, reason;
  if (daily.maxDaily > 0 && dailyLeft() <= 0) {
    // ① 成功配额耗尽
    var ms = daily.refreshMs - nowMs + cfg.flipBuffer;
    delay = ms > 0 ? ms : cfg.idleRefresh;
    reason = ms > 0 ? 'quota' : 'idle-fallback';
  } else if (stats.refreshUsed >= refreshCap) {
    // ② 实际刷新次数触顶（手动/异常放大兼底）
    var m2 = daily.refreshMs - nowMs;
    delay = m2 > 0 ? m2 : cfg.idleRefresh;
    reason = m2 > 0 ? 'budget' : 'idle-fallback';
  } else if (!daily.refreshMs) {
    // 未同步到刷新点：时刻表无从对齐
    delay = cfg.activeRefresh;
    reason = 'no-refresh-point';
  } else {
    var next = nextGridPointMs(nowMs);
    if (next == null) {
      // ④ 今日格点走完：睡到日界重开
      var m3 = daily.refreshMs - nowMs;
      delay = m3 > 0 ? m3 : cfg.idleRefresh;
      reason = m3 > 0 ? 'day-done' : 'idle-fallback';
    } else {
      delay = next - nowMs;
      reason = delay > REFRESH.hopCap ? 'grid-hop' : 'grid'; // grid-hop：长睡分段，醒来重查表
      if (delay < cfg.reloadGap)
        delay = cfg.reloadGap; // 绝对地板（列表重随机节流）
      else if (delay > REFRESH.hopCap) delay = REFRESH.hopCap;
    }
  }
  var slot = curSlotOf(nowMs),
    step = slot >= 0 && (slotCounts[slot] | 0) > 0 ? REFRESH.slotMs / (slotCounts[slot] | 0) : 0;
  log.debug(
    'next refresh in %ds. reason=%s; slot=%d step=%ds; refreshUsed=%d/%d; dailyLeft=%d',
    Math.round(delay / 1000),
    reason,
    slot,
    Math.round(step / 1000),
    stats.refreshUsed,
    refreshCap,
    dailyLeft(),
  );
  return delay;
}

/**
 * cycle 单轮：doScan → consume → 若期间攒下推触就立即补扫，否则按时刻表 planNextRefresh 择下拍。
 * doScan/consume 内部已自吞异常；cycle 另兜一层 fallback(activeRefresh) 作为停摆护栏。
 * @returns {Promise<number>} 下拍 delay（毫秒）；0 = 立即再跑（alive=false 或 pending 补扫）。
 */
async function cycleRun() {
  await doScan();
  if (!aliveFn()) return 0;
  await consume();
  if (!aliveFn()) return 0;
  if (cycle.pending) return 0;
  return planNextRefresh();
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: cfg.activeRefresh });

/**
 * 21551 推送入口：同步配额；若从「耗尽」恢复到有次数则提前唤醒刷列表。listener 永不 throw。
 * @param {object} ev net 事件 {cmd, data}
 */
function onRefreshPush(ev) {
  if (!aliveFn()) return;
  var p = ev && ev.data; // PBV2 推送经 Event.#dataOf 得 {header,data}，业务对象在 .data（与 send 的 ret.data 口径不同）
  if (!p || typeof p !== 'object') return;
  if (p.header && (p.header.s | 0) !== 0) return; // 非 0 状态推送不参与配额覆盖
  var d = p.data || p;
  if (!d || typeof d !== 'object') return;
  var before = dailyLeft();
  applyRefresh(d);
  if (before <= 0 && dailyLeft() > 0) {
    log.info('loot quota restored by push, wake scan.');
    cycle.kick();
  }
}

// ── 生命周期 ─────────────────────────────────────────────────────────────
/**
 * 安装：只做一次，取网络底座（21551 push 订阅移到 run，因 pause 会统一摘触发器而 install 不重跑）。缺失即失败（reactor 不激活）。
 * @param {object} ctx
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
 * 运行：复位列表开态、重随机时间戳与战力缓存 → 挂 21551 push 订阅 → 读回当日拉黑 → 点火即刷一轮 → 后续由 cycle 根据 planNextRefresh 择下拍。
 * @param {object} ctx
 */
function run(ctx) {
  ctxRef = ctx;
  listOpened = false;
  lastReloadAt = 0;
  powerCache = 0;
  powerAge = 0;
  powerFp = '';
  powerAt = 0;
  powerProbing = false; // 冷启动作废战力缓存，首轮必真实探一次
  ctx.on.push(CMD_REFRESH_PUSH, onRefreshPush); // 订阅须挂 run：pause 会统一摘 triggers，install 只跑一次不重挂
  log.info('started.');
  Promise.all([loadBlocked(), loadStats()]).then(function () {
    if (aliveFn()) cycle.kick();
  });
}

/**
 * 向 reactor 注册本功能说明书：场景 Home/NWorldMap；6476 派兵出征 → offInCombat:true。
 *   面板两字段——目标物品 sortlist（勾选=参与、拖拽=优先级，checkable）+ 攻击部队 select(1-8)；
 *   刷新/间距/池为内置常量，funcType 恒 1 不进配置。
 */
var presetOptions = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
  return { value: i, label: '预设部队 ' + i };
});

reactor.register({
  id: 'truckIntercept',
  label: '卡车争夺',
  storageKey: 'pocketcc.feat.truckIntercept',
  symbols: ['dataCenter', 'tableManager'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: {
    enabled: false,
    order: TRUCK_ITEM_POOL.slice(),
    off: [],
    preset: 1,
    grades: ALL_GRADES.slice(),
    threat: true,
    ratioCounter: RATIO_DEFAULT.counter,
    ratioSame: RATIO_DEFAULT.same,
    ratioCountered: RATIO_DEFAULT.countered,
    refreshCap: REFRESH.capDefault,
    refreshPreset: REFRESH.presetDefault,
  },
  fields: [
    {
      key: 'grades',
      type: 'multiopts',
      label: '目标品级',
      hint: '勾选要拦截的运输车品级；全不勾=不限制品级',
      gridMin: 48, // 5 个短标签（普通/高级/…）收进一行（默认 72px 列宽会排成 4+1 两行）
      options: ALL_GRADES.map(function (g) {
        return { value: g, label: GRADE_LABELS[g] || '' + g };
      }),
    },
    {
      key: 'order',
      type: 'sortlist',
      checkable: true,
      offKey: 'off',
      label: '目标物品',
      hint: '勾选要拦截的物品，越靠上优先级越高；命中其一即视为可打目标',
      resolve: item.sortResolve,
    },
    {
      key: 'preset',
      label: '攻击部队',
      section: '拦截编队',
      type: 'select',
      options: presetOptions,
    },
    {
      key: 'dailyState',
      label: '今日拦截',
      section: '拦截编队',
      type: 'text',
      get: function () {
        return daily.maxDaily > 0 ? daily.used + '/' + daily.maxDaily : '—';
      },
    },
    {
      key: 'refreshPreset',
      type: 'select',
      section: '刷新策略',
      label: '时段模板',
      options: Object.keys(REFRESH_PRESETS).map(function (k) {
        return { value: k, label: PRESET_LABELS[k] };
      }),
      hint: '一天内哪些小时多刷（游戏日 24 格占比）；占比低的格自然变疏，归零格不刷',
    },
    {
      key: 'refreshCap',
      type: 'number',
      section: '刷新策略',
      label: '今日刷新上限',
      min: 1,
      step: 10,
      hint: '一天计划刷多少次卡车列表：按模板占比铺到 24 个小时格，cap 越大整体越密（正常模板 cap=300 → 热点约 2.4 分钟、白天约 4.6 分钟、深夜约 15 分钟一次）',
    },
    {
      key: 'refreshState',
      label: '今日刷新 / 今日攻击',
      section: '刷新策略',
      type: 'text',
      multiline: true,
      inline: true,
      get: function () {
        var slot = curSlotOf(serverNowMs()),
          n = slot >= 0 ? slotCounts[slot] | 0 : 0;
        var per = slot < 0 ? '—' : n > 0 ? Math.round(REFRESH.slotMs / n / 1000) + 's' : '不刷'; // — = 尚未同步到刷新点，时刻表无从对齐
        return (
          '刷新 ' +
          stats.refreshUsed +
          '/' +
          refreshCap +
          ' · 本小时间隔 ' +
          per +
          '\n尝试 ' +
          stats.tried +
          ' · 胜 ' +
          stats.win +
          ' · 负 ' +
          stats.fail +
          ' · 拒 ' +
          stats.rejected
        );
      },
    },
    {
      key: 'threat',
      type: 'checkbox',
      section: '拦截判定',
      secCollapsible: true,
      secCollapsed: true,
      label: '只打能赢（战力+克制判定）',
    },
    {
      key: 'ratioCounter',
      label: '我克敌·战力比上限',
      section: '拦截判定',
      min: 0.1,
      step: 0.05,
      float: true,
    },
    {
      key: 'ratioSame',
      label: '同军种·战力比上限',
      section: '拦截判定',
      min: 0.1,
      step: 0.05,
      float: true,
    },
    {
      key: 'ratioCountered',
      label: '我被克·战力比上限',
      section: '拦截判定',
      min: 0.1,
      step: 0.05,
      float: true,
    },
    {
      key: 'probeBtn',
      type: 'button',
      section: '拦截判定',
      label: '↻ 刷新我方战力',
      busyText: '刷新中…',
      onClick: function (cfg) {
        return probeForPanel(cfg);
      },
    },
    {
      key: 'threatView',
      label: '我方战力 / 可打上限（陆·海·空）',
      section: '拦截判定',
      type: 'text',
      multiline: true,
      get: function () {
        if (!my.ready)
          return my.tried
            ? '未探到（该预设无兵 / 未解锁卡车功能）\n点上方「刷新我方战力」重试'
            : '探测中…（也可点上方「刷新我方战力」）';
        var c = branchCeilings();
        var lines = [
          '我方：' +
            fmtPower(my.power) +
            ' · ' +
            (my.branch ? branchName(my.branch) + '军' : '军种未知'),
        ];
        c.list.forEach(function (x) {
          lines.push(
            branchName(x.b) + '军（' + x.rel + '≤' + x.lim + '）：敌 ≤ ' + fmtPower(x.ceil),
          );
        });
        return lines.join('\n');
      },
    },
  ],
  toModuleCfg: function (c) {
    return {
      order: Array.isArray(c.order) ? c.order.slice() : TRUCK_ITEM_POOL.slice(),
      off: Array.isArray(c.off) ? c.off.slice() : [],
      preset: Number(c.preset) || 1,
      grades: Array.isArray(c.grades) ? c.grades.slice() : ALL_GRADES.slice(),
      threat: c.threat !== false,
      ratioCounter: Number(c.ratioCounter) || RATIO_DEFAULT.counter,
      ratioSame: Number(c.ratioSame) || RATIO_DEFAULT.same,
      ratioCountered: Number(c.ratioCountered) || RATIO_DEFAULT.countered,
      refreshCap: Number(c.refreshCap) || REFRESH.capDefault,
      refreshPreset: REFRESH_PRESETS[c.refreshPreset] ? c.refreshPreset : REFRESH.presetDefault,
    };
  },
  install: install,
  configure: configure,
  run: run,
});
