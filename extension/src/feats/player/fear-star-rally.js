/**
 * 惧星集结（fearStarRally）- 日常 feat：从「自动打野」拆出的惧星专项玩法，维持「我发起的」惧星行军，一只打完再派下一只。
 *
 * 用户口径（面板）：
 *   等级 —— 单选一个档位 level（1~5）；搜点时把它展开成区间 [level, level]（906 minLevel/maxLevel 同值）。
 *   方式 —— 「单打」(902 marchType 79) 或「集结」(1201 marchType 8 创建集结)。
 *   今日已打 —— 只读，取游戏侧 thorSearchNum（1026 GET_JION_ALL_RCTIME 应答，见下）。
 *   预设队伍 —— 单选一个出兵预设 preset（1~8，下拉单选；内部归一化为 0/1 长度池）；该预设本轮无兵则不出兵、等其回城再派。
 *   面板排版 —— 上述四项排成一张表（type:'ctrlrow' + table），与自动打野怪物清单同外观：表头行说明各列含义 + 一行数据（无逐行 checkbox）。
 *
 * 惧星隐性规则（用户口径）：
 *   ① 每日攻打上限 —— 1026 req {} → resp d 含 {thorSearchNum}（今日已搜惧星次数，实录报文实证）；
 *      上限 = DataConfig 941300（源码 WorldMapMonsterSearchComponentNew：剩余 = 941300 - thorSearchNum）。searchNum≥cap 即今日打完、停手等次日。
 *      次数每日 0 点（本地墙钟午夜）刷新：打完即睡向下个 0 点（msToNextMidnight，分块封顶 6h 防漂移），不整夜按 idle 空轮询。
 *      惧星只能「搜到才能打」，且 906 每搜一次即 +1 thorSearchNum（服务端计数），故本 feat 严格「先判可派再搜」，不为打不掉的点白烧配额。
 *   ② 同一时间只允许一个「我发起的」惧星在集结+行军（直到打完当前这只，游戏才派下一只）：按发起应答的 marchId 认领在途锁 fearStarOut，
 *      打完/从 856 行军列表消失即解锁；加入别人的惧星集结（成员行军）不计入、不受此限（行军队列不限制），故不认领、不阻塞。
 *      「见到过」(confirmed) 只靠 10019 边沿复播 + 行军快照补认，不靠 856 轮询采样：本 feat 派完即转 idle 长睡，
 *      下一次 856 采样通常落在到家之后（856 只回在途行军，返程/到家条目不再下发），存活期根本没有采样点。
 *
 * 打法与协议（报文实证：发起攻打野怪 / 发起攻打黑暗军团据点集结 / 下田撤田三趟实录）：
 *   搜惧星 906 WORLD_SEARCH_MONSTER —— req {minLevel,maxLevel,groupType:9100,pointType:9}；resp {point:{x,y,...}}，服务端直接回一个可打点（视口无关，Home 可跑）。
 *   单打 902 MARCH_WORLD_POINT —— 走 core/march.attack() 组 canonical body（逐键同打野实录）；marchType 79。应答带 marchInfo.marchId。
 *     注意：惧星点（906 回的 pointType 86 = THOR_BUFF_RALLY_MIX_BOSS）不是普通野怪，**不能**沿用普通打野的 marchType 5：
 *     5(ATTACK_MONSTER) 会被服务端按普通怪物表查点 → 拒 world_130509「point error, monster not find」（真机报文实证）。
 *     游戏侧 NWorldMapAssemblyEnemyComponent.onAttackNormalMonster 对 THOR_BUFF_RALLY_MIX_BOSS 特判 79 THOR_SCIENCE_BUFF，
 *     同报文实证 902 受理后 marchInfo.marchType=79、10019/10163 亦为 79（10163 pveId=9101005 = 9100+level5）。
 *   集结 1201 ALLIANCE_Assembly_Create —— 直发 req {marchType:8,x,y,time:60,armyList,armyListNew,heroList,trapList,formation:0,formationV2}（无 break/extraArmy，据点集结实录实证）。应答带 marchInfo.marchId。
 *     惧星集结不特判类型（游戏侧 startAssemblyByUserLevel 对 THOR 仍取 ALLIANCE_RALLY_BATTLE=8）。
 *   体力 —— gameData.energy(1)→{point,pointMax}（push 10021）；仅作「体力>0 才搜」的粗闸防零体白烧配额，具体扣减交由服务器拒 + 退避收敛。
 *
 * 生命周期由 reactor 托管：places 限定 base/world、kinds homeland、战斗模式暂停（offInCombat，同 auto-hunt）；
 *   触发源（run 点火 / 10019 回城唤醒 / 10021 体力变化 / 配置变更 / 兜底定时）全部汇入 cycle.kick，在飞合并为一次补扫。
 *   「今日已打」不落本地盘，以游戏侧 thorSearchNum 为权威；每次成功发起乐观自增防同轮超发，下拍 1026 重同步。
 *
 * 配置链路（防「激活不打」，同 auto-hunt）：registry 把 {enabled, ...toModuleCfg(c)} 推给 reactor.setConfig → configure。
 *   故 toModuleCfg 产出的就是归一化运行时配置，configure 只整体赋值、绝不二次归一。
 */
import { parseData } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { bus, EVT } from '../../core/bus.js';
import { gameData, gameConf } from '../../core/game-api.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { map } from '../../core/map.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=FEAR-STAR） */
const log = createLog('FEAR-STAR');

/** @type {number} RequestId.ALLIANCE_Assembly_Create：创建集结（惧星集结，feat 直发） */
const CMD_CREATE_RALLY = 1201;
/**
 * @type {number} RequestId.GET_JION_ALL_RCTIME：查惧星当日计数（应答 d 含 thorSearchNum=今日已搜惧星次数）。
 * 报文实证：下田撤田趟实录 resp cmd 1026 data {thorSearchNum,...}。
 */
const CMD_GET_JION_ALL_RCTIME = 1026;
/** @type {number} DataConfig 941300：惧星每日搜索次数上限（源码 WorldMapMonsterSearchComponentNew：剩余 = 941300 - thorSearchNum） */
const FEAR_STAR_DAILY_CFG = 941300;
/** @type {number} push PUSH_USER_ENERGY：体力变化推送（唤醒重判体力粗闸） */
const PUSH_ENERGY = 10021;

/** @type {number} 惧星 species（groupType），906 搜点用（实证 auto-hunt 拆出前口径） */
const GROUP_TYPE = 9100;
/** @type {number} 惧星搜点 tab（pointType），906 搜点用 */
const POINT_TYPE = 9;

/**
 * @type {number} 行军类型：惧星单打（NMarchType.THOR_SCIENCE_BUFF=79）。
 * 惧星点（906 回 pointType 86 / itemId 9100）走雷神专属类型，游戏侧 NWorldMapAssemblyEnemyComponent.onAttackNormalMonster
 * 对 THOR_BUFF_RALLY_MIX_BOSS 特判 79；沿用普通野怪的 5 会被拒 world_130509（真机报文实证）。
 */
const MT_ATTACK = 79;
/** @type {number} 行军类型：创建集结主行军（NMarchType.ALLIANCE_RALLY_BATTLE=8，惧星不特判；据点集结实录实证） */
const MT_RALLY = 8;
/** @type {number} 1201 集结等待时长（秒，报文实证固定 60） */
const RALLY_WAIT_TIME = 60;

/** @type {number} 体力类型编码（gameData.energy(1)） */
const STAMINA_TYPE = 1;

/**
 * @type {string} 902/1201 拒绝载荷里「操作过快」的服务器全局限流文案键。与「点失效」真拒不同：目标有效、不拉黑，
 * 命中即中止本轮 + 指数退避重排下轮（照抄 auto-hunt 口径）。
 */
const ERR_RATE_LIMIT = 'march_time_control_info001';

/**
 * @type {number} 发起后迟迟没「确认见过该 marchId」的兑底解锁超时（毫秒）：防应答丢 id / 列表同步异常导致永久占锁。
 * 确认通道是 10019 边沿复播 + 行军快照（见 onFearStarMarchEdge / probeConfirmed），不依赖 856 轮询采样点，
 * 故正常「派出去→打完回家」不会走到这条兑底；真走到即「发出去了却全程没见过这条行军」，属异常，保留 warn。
 */
const FEAR_STAR_SYNC_TIMEOUT = 30000;

/** @type {number} 等级下拉的最高档（惧星只有 1~5 级，选项 = 1..LEVEL_MAX） */
const LEVEL_MAX = 5;
/** @type {number} 面板预填的等级档（区间上下界同值，即“只搜这一级”） */
const DEFAULT_LEVEL = 5;

/**
 * 攻打方式枚举 → 面板标签、派发所需 marchType、是否集结（集结走 1201、单打走 902）。
 * @type {Object<string,{label:string,marchType:number,rally:boolean}>}
 */
const MODES = {
  single: { label: '单打', marchType: MT_ATTACK, rally: false },
  rally: { label: '集结', marchType: MT_RALLY, rally: true },
};

/**
 * 内置调优常量（面板不暴露；active/idle 两档兜底同 auto-hunt 惯例）。
 * @type {object}
 */
const cfg = {
  /** 想派却暂不可派（兵在外 / 体力粗闸未过 / 搜点失败）时的兜底扫描间隔（毫秒）：30 秒 */
  activeScanInterval: 1000 * 30,
  /** 锁定在途（等打完唤醒）或今日已打完时的兜底间隔（毫秒）：10 分钟（正常靠 10019 唤醒） */
  idleScanInterval: 1000 * 60 * 10,
  /** 推送唤醒补扫的最小间隔（毫秒）：合并突发回城/体力推送 */
  pushScanMinGap: 1000 * 4,
  /** 撞全局限流后的退避基数（毫秒）：按 streak 指数退避重排下轮 */
  rateLimitBackoffMs: 1000 * 15,
  /** 限流退避封顶（毫秒） */
  rateLimitBackoffMaxMs: 1000 * 60,
  /** 今日打完（次数达上限）后「睡向下个 0 点」的单拍上限（毫秒）：分块封顶防时钟漂移/超长定时器，醒一次即重同步 1026（6 小时） */
  dailyCapSleepMaxMs: 1000 * 60 * 60 * 6,
  /** 睡向下个 0 点的单拍下限（毫秒）：临近 0 点时的地板，防紧贴空转（10 秒） */
  dailyCapSleepMinMs: 1000 * 10,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} reactor 注入的上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {object} 模块配置（configure 灌入）：{minLevel,maxLevel,mode,presets:number[]} */
var MCFG = normalize({});

/** @type {boolean} 上轮是否仍有「想派未派」的缺位（决定 active/idle 两档兜底间隔） */
var backlogActive = false;
/** @type {number} 连续撞全局限流次数（指数退避）；任一发包成功受理即归零 */
var rateLimitStreak = 0;
/** @type {number} 上次推送唤醒的墙钟时刻（毫秒），合并突发 */
var lastPushWakeAt = 0;

/**
 * 惧星当日计数缓存（游戏侧权威，源自 1026 thorSearchNum + DataConfig 941300 上限）。
 * @type {{searchNum:number, cap:number, loaded:boolean}}
 */
var fearStar = { searchNum: 0, cap: 0, loaded: false };
/**
 * 「我发起的在途惧星」单飞锁（隐性规则：自发起的惧星同一时间只允许一只在集结+行军）。
 * 仅跟踪本 feat 自己发 902/1201 派出的那只（按应答 marchInfo.marchId 认领）；加入别人的惧星集结不在其中、不受此限。
 * id=发起应答里的 marchId；confirmed=是否已在 856 行军列表见到过（区分「刚发未同步」与「完成移除」）；since=置锁时刻（ms）。
 * @type {{id:string, confirmed:boolean, since:number}|null}
 */
var fearStarOut = null;

/**
 * 功能是否仍在运行（在飞流程与定时器的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 902/1201 被拒裸串 → 语言键：被拒时 data 常是 "语言键,参数" 形式的裸串（受理才是整包 JSON），取首个逗号前作为键。
 * @param {*} data net.Ret.data
 * @returns {string|null}
 */
function rejectErrKey(data) {
  if (typeof data !== 'string' || !data) return null;
  var comma = data.indexOf(',');
  return comma >= 0 ? data.slice(0, comma) : data;
}

/** 推一次面板刷新（刷新「今日已打」只读格）；收口事件名。 */
function pokePanel() {
  bus.emit(EVT.UI_REFRESH);
}

// ── 配置归一 ────────────────────────────────────────────────────────
/**
 * 面板原始配置 → 归一化运行时配置（toModuleCfg 产出；configure 只整体赋值、不再调本函数）。
 * 出兵池去重剔非法按序保留；等级单档取整并钳到 [1, LEVEL_MAX]；方式非法回落单打。
 * @param {object} raw 面板 configs 快照（{level,mode,preset}，level 为历史存档可能缺位）
 * @returns {object} { minLevel, maxLevel, mode, presets:number[] }
 */
function normalize(raw) {
  raw = raw || {};
  // 单选一个出兵预设（1~8）→ 归一化为 0/1 长度池（非法/未选=空池，本 feat 空池即 idle）
  var preset = Number(raw.preset) | 0;
  var presets = preset >= 1 && preset <= 8 ? [preset] : [];
  // 等级单档选择：面板只给一个 level，搜点区间就是 [level, level]；
  //   旧存档无 level 但有 minLevel 时沿用它作档，保证改版前配的用户不会静默变档。
  var lv =
    Number.isFinite(+raw.level) && +raw.level > 0 ? +raw.level | 0 : Number(raw.minLevel) | 0;
  if (!(lv >= 1 && lv <= LEVEL_MAX)) lv = DEFAULT_LEVEL;
  var mode = MODES[raw.mode] ? raw.mode : 'single';
  return { minLevel: lv, maxLevel: lv, mode: mode, presets: presets };
}

/**
 * 从池里挑第一个「能出兵」的战斗预设并组 MarchData（纯本地读预设 + adjust 排除在途，零发包）。
 * armyListNew 空多半意味着该部队已在外；配了英雄但可派英雄为空是回城推送与英雄释放的竞争窗口——均视为该预设本轮不可用、顺延下一。
 * @param {number[]} presets 预设池（1~8）
 * @returns {object|null} MarchData 或 null（全池无兵）
 */
function buildPlanFromPool(presets) {
  for (var i = 0; i < presets.length; i++) {
    var plan = new Battle().plan().preset(presets[i]).adjust().build();
    if (!plan.armyListNew.length) continue; // 该部队兵已全在外
    if (plan.presetHasHeroes && !plan.heroList.length) continue; // 英雄未释放
    return plan;
  }
  return null;
}

// ── 当日计数（游戏侧权威）与单飞锁 ──────────────────────────────────
/**
 * 拉一次 1026 同步惧星当日已搜次数（thorSearchNum）与上限（DataConfig 941300），回写 fearStar 缓存 + 刷面板。永不 reject。
 * @returns {Promise<void>}
 */
async function refreshFearStarCount() {
  if (!net) return;
  var ret = await net.sendGuarded(
    CMD_GET_JION_ALL_RCTIME,
    {},
    {
      onError: function (err) {
        log.warn('1026 fear-star count fetch threw. %s', err && err.message);
      },
    },
  );
  if (!ret || !ret.ok) return;
  var d = parseData(ret.data);
  if (!d || d.thorSearchNum == null) return;
  fearStar.searchNum = Number(d.thorSearchNum) | 0;
  var cap = Number(gameConf.dataConfig(FEAR_STAR_DAILY_CFG));
  fearStar.cap = isFinite(cap) && cap > 0 ? cap | 0 : 0;
  fearStar.loaded = true;
  pokePanel();
}

/**
 * 刷新「我发起的在途惧星」单飞锁 fearStarOut（隐性规则：我发起的惧星同一时间只允许一只在集结+行军）。
 * 按发起应答的 marchId 在 856 本人行军列表里认领：见到且仍占用 → 保持锁；见到且已返程/到家（打完）或确认见过后从列表消失 → 解锁；
 * 从未见过 → 保持锁直到 FEAR_STAR_SYNC_TIMEOUT 兑底解锁（防应答丢 id / 同步异常导致永久占位）。
 * 「见过」由 10019 边沿（onFearStarMarchEdge）与发起即快照补认（probeConfirmed）维护，本函数只做兜底复核。
 * 加入别人的惧星集结产生的成员行军不在此锁范围内（不认领、不计数），故不会挡住本 feat 自发起下一只。
 * @param {object[]} marches march.list() 结果
 */
function syncSelfFearStar(marches) {
  if (!fearStarOut) return;
  var m = null;
  for (var i = 0; i < marches.length; i++) {
    if (marches[i].id === fearStarOut.id) {
      m = marches[i];
      break;
    }
  }
  if (m) {
    fearStarOut.confirmed = true;
    if (!m.isOccupying) fearStarOut = null; // 打完（返程/到家）→ 解锁，可发起下一只
  } else if (fearStarOut.confirmed) {
    fearStarOut = null; // 之前见过、现已从列表移除 → 定稿结束
  } else if (Date.now() - fearStarOut.since > FEAR_STAR_SYNC_TIMEOUT) {
    log.warn(
      'fear-star march %s never appeared in march list within %dms, release lock.',
      fearStarOut.id || '(no-id)',
      FEAR_STAR_SYNC_TIMEOUT,
    );
    fearStarOut = null;
  }
}

/**
 * 置锁后拿一次行军快照补认「这条行军确实存在」：march.js 对每条 10019 都 upsert 快照（不只边沿才复播），
 * 而首条推送往往早于发起应答落地（报文实证：push 先于 resp 落地），
 * 所以光靠边沿复播会漏认。命中即 confirmed=true；未命中不作判（行军可能尚未入快照）。
 * 稳态走内存快照，零额外网络；快照过期时由 march.js 自行打一次 856 重播种。永不抛错。
 * @param {string} id 发起应答里的 marchId
 */
function probeConfirmed(id) {
  march.list({ cache: true }).then(function (ms) {
    if (!fearStarOut || fearStarOut.id !== id) return; // 锁已释放/已换下一只 → 结果作废
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].id === id) {
        fearStarOut.confirmed = true;
        break;
      }
    }
  });
}

/** @type {boolean} 上轮 cyclePass 是否因「今日攻打次数已达上限」而收手（游戏每日 0 点刷新次数 → 供 cycleRun 睡向下个 0 点） */
var cappedToday = false;

/**
 * 距下个本地 0 点（游戏每日刷新惧星攻打次数的时刻）还有多少毫秒。
 * 用本地墙钟（国服=用户本地钟）的次日 00:00:00.000 与当前时刻之差；恒 >0（恰在 0 点时≈24h）。
 * @returns {number} 毫秒
 */
function msToNextMidnight() {
  var d = new Date();
  var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - d.getTime();
}

// ── 候选与派发 ──────────────────────────────────────────────────────
/**
 * 搜一个可打惧星点（906，服务端返回一个点）。永不 reject。
 * @param {number} minLevel 等级下界
 * @param {number} maxLevel 等级上界
 * @returns {Promise<{x:number,y:number}|null>}
 */
async function searchPoint(minLevel, maxLevel) {
  // 906 只读骨架（isSending 门/异常吞掉/取点）下沉 map.searchPoint
  var r = await map.searchPoint(net, {
    minLevel: minLevel,
    maxLevel: maxLevel,
    groupType: GROUP_TYPE,
    pointType: POINT_TYPE,
  });
  var pt = r.point;
  if (!pt) return null;
  return { x: pt.x | 0, y: pt.y | 0 };
}

/**
 * 发一条惧星单打行军 902：经 core/march.attack 统一组 canonical body + isSending(902) 去重。永不 reject。
 * @param {{x:number,y:number}} coord 目标点
 * @param {object} plan MarchData
 * @returns {Promise<object>} net.Ret
 */
async function sendAttack(coord, plan) {
  return await march.attack({
    marchType: MT_ATTACK,
    target: { x: coord.x, y: coord.y },
    data: plan,
  });
}

/**
 * 创建惧星集结 1201：feat 直发。body 逐键照抄 183114（无 break/extraArmy）。isSending(1201) 去重。永不 reject。
 * @param {{x:number,y:number}} coord 目标点
 * @param {object} plan MarchData
 * @returns {Promise<object>} net.Ret
 */
async function createRally(coord, plan) {
  return net.sendGuarded(
    CMD_CREATE_RALLY,
    {
      marchType: MT_RALLY,
      x: coord.x,
      y: coord.y,
      time: RALLY_WAIT_TIME,
      armyList: plan.armyListNew,
      armyListNew: plan.armyListNew,
      heroList: plan.heroList,
      trapList: plan.trapList,
      formation: 0,
      formationV2: plan.formationV2,
    },
    {
      fallback: net.Ret.from(march.NOT_SENT, null),
      onError: function (err) {
        log.warn('1201 send error. x=%s;y=%s', coord.x, coord.y, err);
      },
    },
  );
}

// ── 调度 ────────────────────────────────────────────────────────────
/**
 * 单拍：同步在途锁 → 判上限/锁定/体力/兵池 → 搜点（搜到即乐观 +1 配额）→ 发起单飞。永不 reject。
 * @returns {Promise<void>}
 */
async function cyclePass() {
  cappedToday = false;
  if (!MCFG.presets.length) {
    backlogActive = false;
    log.debug('no preset configured, idle.');
    return;
  }
  // 体力粗闸：读不到（未就绪）本轮不动；为 0 则不搜（搜一次烧一次配额），等回体唤醒
  var en = gameData.energy(STAMINA_TYPE);
  var stamina = en ? en.point : null;
  if (stamina == null) {
    backlogActive = true;
    return;
  }
  if (stamina <= 0) {
    backlogActive = false;
    log.debug('stamina 0, wait for recover.');
    return;
  }

  // 权威在途：856 全量本人行军（视口无关、Home 亦有）→ 刷新单飞锁
  var marches = await march.list();
  if (!aliveFn()) return;
  syncSelfFearStar(marches);
  // 隐性规则：已有「我发起的」惧星在集结+行军 → 本轮不派（不搜，省配额），等其打完（10019/兜底）再续
  if (fearStarOut) {
    backlogActive = false;
    return;
  }

  // 游戏侧当日计数/上限：拉一次同步（面板「今日已打」也依赖此）
  await refreshFearStarCount();
  if (!aliveFn()) return;
  if (fearStar.loaded && fearStar.cap > 0 && fearStar.searchNum >= fearStar.cap) {
    backlogActive = false;
    cappedToday = true; // 交 cycleRun 睡向下个 0 点（游戏每日 0 点刷新次数）
    log.debug(
      'fear-star daily cap reached, idle till midnight. %d/%d',
      fearStar.searchNum,
      fearStar.cap,
    );
    return;
  }

  // 全局名额闸门
  if (march.freeSlots() <= 0) {
    log.debug('no free march slot, wait for arrival wake.');
    backlogActive = true;
    return;
  }

  // 先判兵池再搜（搜一次即烧配额）：全池无兵则不搜，等回城唤醒
  var plan = buildPlanFromPool(MCFG.presets);
  if (!plan) {
    log.debug('all presets out of troops this cycle.');
    backlogActive = true;
    return;
  }

  var cand = await searchPoint(MCFG.minLevel, MCFG.maxLevel);
  if (!aliveFn()) return;
  if (!cand) {
    backlogActive = true; // 906 在途去重 / 无合格点：active 档稍后重试
    return;
  }
  // 搜一次即消耗一次 thorSearchNum（服务端计数）：乐观自增防下拍 1026 未到前重复搜（本拍后立刻发起，锁会挡住后续）
  fearStar.searchNum++;
  pokePanel();

  var seg = MODES[MCFG.mode];
  var ret = seg.rally ? await createRally(cand, plan) : await sendAttack(cand, plan);
  if (!aliveFn()) return;
  if (ret.ok) {
    rateLimitStreak = 0;
    // 隐性规则：认领「我发起的惧星」——从应答 marchInfo.marchId 置单飞锁（报文实证 902/1201 resp 均带 marchInfo.marchId）
    var d = parseData(ret.data) || {};
    var mid = d.marchInfo && d.marchInfo.marchId != null ? String(d.marchInfo.marchId) : '';
    fearStarOut = { id: mid, confirmed: false, since: Date.now() };
    if (mid) probeConfirmed(mid); // 首条 10019 可能已早于本应答落地 → 快照补认，免误走 30s 兑底告警
    backlogActive = false; // 已锁定在途，等打完唤醒
    log.info('fear-star %s ok. x=%d y=%d marchId=%s', seg.label, cand.x, cand.y, mid || '(no-id)');
  } else {
    var errKey = rejectErrKey(ret.data);
    if (errKey === ERR_RATE_LIMIT) {
      rateLimitStreak++;
      log.info('fear-star march rate-limited, back off. streak=%d', rateLimitStreak);
      return; // 交退避定时重排
    }
    // 真拒（点被抢/失效等）：本轮配额已烧，无行军可锁；active 档换下一候选重试
    backlogActive = true;
    log.info(
      'fear-star march rejected. x=%d y=%d code=%s why=%s',
      cand.x,
      cand.y,
      ret.code,
      errKey || '-',
    );
  }
}

/**
 * 单轮调度：跑 cyclePass → 返回下拍间隔（毫秒；<=0=立即补扫）。
 * 择时优先序：限流退避 > 本轮在飞有外部触发 > active/idle 两档。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  await cyclePass();
  // 今日已打完（次数达上限）：游戏每日 0 点刷新次数 → 睡向下个 0 点再恢复（分块封顶防漂移/超长定时器），
  //   避免整夜按 idle 每 10 分钟空轮询。此分支优先于 pending/退避（配额未刷新前任何唤醒都是空跑；
  //   但 run/configure 的 cycle.kick 仍会强制跑一轮重判，不受此长睡影响）。
  if (cappedToday) {
    var toMid = msToNextMidnight();
    return Math.max(cfg.dailyCapSleepMinMs, Math.min(toMid, cfg.dailyCapSleepMaxMs));
  }
  if (rateLimitStreak > 0) {
    return Math.min(
      cfg.rateLimitBackoffMs * (1 << Math.min(rateLimitStreak - 1, 5)),
      cfg.rateLimitBackoffMaxMs,
    );
  }
  if (cycle.pending) return 0;
  return backlogActive ? cfg.activeScanInterval : cfg.idleScanInterval;
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取 active 档） */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.activeScanInterval,
});

/**
 * 推送唤醒（去抖）：距上次补扫 < pushScanMinGap 则忽略，靠兜底定时收尾。
 */
function pushWake() {
  if (!aliveFn()) return;
  var wall = Date.now();
  if (wall - lastPushWakeAt < cfg.pushScanMinGap) return;
  lastPushWakeAt = wall;
  cycle.kick();
}

/** @type {Function|null} march.onStateChange 退订句柄（防 resume 重激活重复注册） */
var offMarchEdge = null;

/**
 * 10019 状态边沿（march.js 全局单点复播）：一峰二用。
 * ① 单飞锁确认：只要见到「我发起的那条」（id 完全匹配）就置 confirmed，令后续从列表消失走「静默定稿」而非 30s 兑底告警；
 *   不做提前解锁（释放仍由 syncSelfFearStar 统一判，保持单一释放口径）。
 * ② 到家唤醒：只认惧星类行军（marchType 79 单打 / 8 集结主）回城 → 名额释放 → 延迟 1.5s 给英雄释放推送落地后唤醒补派（同 auto-hunt）。
 * @param {object} m 归一化 March
 */
function onFearStarMarchEdge(m) {
  if (!aliveFn()) return;
  if (m && fearStarOut && !fearStarOut.confirmed && m.id === fearStarOut.id)
    fearStarOut.confirmed = true;
  var mt = m && m.type | 0;
  if (mt !== MT_ATTACK && mt !== MT_RALLY) return;
  if (m.state !== march.State.ARRIVED_HOME) return; // onStateChange 未带 to 过滤，回家判据在此自过滤
  setTimeout(function () {
    if (aliveFn()) pushWake();
  }, 1500);
}

/**
 * 10021 体力推送：体力变化（回体 / 用药 / 讨伐扣减）→ 去抖唤醒重判体力粗闸。
 */
function onEnergyPush() {
  pushWake();
}

// ── 生命周期 ────────────────────────────────────────────────────────
/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  net = ctx.net;
  if (!net.install()) {
    net = null;
    log.warn('install failed. missing=pocketcc.net');
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入：直接整体接收 toModuleCfg 已归一化的运行时配置（绝不二次归一，见文件头「配置链路」）。
 * 运行中即时唤醒一轮让新配置生效。
 * @param {object} partial reactor 推送的 { enabled, minLevel, maxLevel, mode, presets }（toModuleCfg 产出）
 * @returns {object} MCFG
 */
function configure(partial) {
  if (!partial || !partial.presets) return MCFG;
  MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：复位内存态 → 挂 10019/10021 → 点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  backlogActive = false;
  cappedToday = false;
  rateLimitStreak = 0;
  lastPushWakeAt = 0;
  fearStar = { searchNum: 0, cap: 0, loaded: false };
  fearStarOut = null;
  ctx.on.push(PUSH_ENERGY, onEnergyPush);
  if (offMarchEdge) offMarchEdge(); // 先退再挂，防 resume 重激活重复注册
  offMarchEdge = march.onStateChange(onFearStarMarchEdge);
  log.info('started. mode=%s presets=%d', MCFG.mode, MCFG.presets.length);
  cycle.kick();
}

/**
 * 停用：收 march.onStateChange 常驻复播句柄（非 ctx 级、框架不代退）；cycle 靠 alive() 自然停摆，无需显式收定时器。
 */
function pause() {
  if (offMarchEdge) {
    offMarchEdge();
    offMarchEdge = null;
  }
}

// ── 面板 descriptor ─────────────────────────────────────────────────
/**
 * 生成 defaults：等级区间预填、默认单打、出兵池空。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
    level: DEFAULT_LEVEL,
    mode: 'single',
    preset: 0,
  };
}

/**
 * 生成 fields：整卡一张表（ctrlrow + table），与自动打野怪物清单同外观——表头行说明各列（等级 | 方式 | 预设队伍 | 今日已打）。
 * 一行数据：等级/方式/预设队伍 为下拉、今日已打为只读（惧星只一种怪，无需逐行 checkbox）。
 * 行内控件各自持存档键（level/mode/preset），todayCount 只读不入库；key 'fearStarRow' 只是行级标识。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: 'fearStarRow',
      label: '惧星打野',
      type: 'ctrlrow',
      table: true,
      cells: [
        {
          key: 'level',
          label: '等级',
          title: '攻打等级（1~5）：906 按这一级搜点',
          options: Array.apply(null, { length: LEVEL_MAX }).map(function (_, i) {
            return { value: i + 1, label: String(i + 1) };
          }),
        },
        {
          key: 'mode',
          label: '方式',
          title: '单打走 902、集结走 1201',
          options: [
            { value: 'rally', label: MODES.rally.label },
            { value: 'single', label: MODES.single.label },
          ],
        },
        {
          key: 'preset',
          label: '预设队伍',
          title: '单选一个出兵预设（战斗 1~8）；该预设本轮无兵则不出兵，等其回城再派',
          options: [{ value: 0, label: '未设置' }].concat(
            Array.apply(null, { length: 8 }).map(function (_, i) {
              return { value: i + 1, label: '战斗' + (i + 1) };
            }),
          ),
        },
        {
          key: 'todayCount',
          label: '今日已打',
          type: 'text',
          title: '今日已搜惧星次数（游戏侧 thorSearchNum）',
          get: function () {
            return fearStar.loaded ? String(fearStar.searchNum) : '-';
          },
        },
      ],
    },
  ];
}

reactor.register({
  id: 'fearStarRally',
  label: '惧星集结',
  storageKey: 'pocketcc.feat.fearStarRally',
  symbols: ['presetMarch', 'heroController', 'mechaController', 'formationAdv', 'marchStorage'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: function (c) {
    return normalize(c);
  },
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
