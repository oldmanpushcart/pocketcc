/**
 * 自动下田（autoFarm）—— 遗迹(6级) > 机械 > 普通 三级优先 + 升级换田 + 三路独立扫描器
 *
 * 面板口径（一行 = 一支预设部队，让队伍去匹配资源）：预设编队（1~16 单选、整表互斥）+ 资源类型多选（金/粮/油/雷神）+ 资源种类多选（遗迹/机械/普通）。
 * 取田统一按 rank = 种类×10000 + 家族×1000 + 矿脉级×10 + 机械设施级 严格比大小（字典序：种类 > 家族 > 等级 > 设施级，真相在 priority.rankOf）；
 * 剩余存活时间不参与排序（只当同分 tiebreak 与「快到期不下田」硬闸）；家族已进 rank，所以石油 5 级会被雷神 3 级顶掉（雷神稀缺优先）；
 * 已有在途田的行若发现 rank 更高的可下候选→ 904 撤田，到家后由 10019 唤醒重新按 rank 取最优（不钉目标）；
 * 「到家」前本行不算缺位（撤回瞬间 856 就把这支转返程，此时重派必撞 hero_mutually_exclusive_tip，详见下文撤田防抖）。
 *
 * 三个数据源（feats/player/auto-farm/ 内互 import，同 feat 目录不算跨 feat 依赖）：
 *   lvl6-scanner —— 遗迹田：邮件驱动（「遗迹区域刷新」）5 窗 901 扫锚点，池落 storage.slot('autoFarm.lvl6')；
 *   tower-scanner —— 机械田：1193 全量 + 10452 增量活表 + 20min 周期重扫，落 storage.slot('autoFarm.tower')；
 *   normal-scan  —— 普通田：906 逐级降序（5→1）搜索，应答即校验（ownerId '0' && amount>0）。
 * 下田前的信息获取全部在 priority.pickBest 内闭环：遗迹 901 复验、机械 901+1034 容量、普通 906 应答。
 *
 * 6 级田是抢的，三道闸都在 lvl6-scanner 内（详见该文件头）：
 *   ① 派前单点 901 复验同时开 marchInfo，看有没有别人也在飞向该点——**按 ETA 比划算**：对手预计到达晚于我方
 *     （加 RACE_MARGIN_SEC 垫）才下，否则只记 contendedUntil（对手预计空出时刻）延后重试，不拉黑；
 *     扫图 5 窗仍不开 marchInfo（视口外的行军不下发，且徒增包体）；
 *   ② 902 被拒后同一行本轮内换点续抢（上限 cfg.relicRetryMax），只有全局限流/英雄未归队两类不续抢；
 *   ③ 到达却从未进采集态（10019 state=5 边沿未亮且 856 未见）= 空返，按 cfg.relicGatherFailMs 短解禁该点。
 * 排程侧配套：抢田「判无可判」但池里还有未复验候选（relic.staleCount>0）时算 backlog，走 active 档而非 idle 长档，
 * 否则就成了「每 10 分钟只验几个点、而田只活 4h」（真机实录）。
 *
 * 子引擎 mech-build（自动建造机械田，需机械大师职业）：共用本 feat 的 ctx / alive / 下田时段闸，
 * 面板字段 mechBuildEnabled + mechBuildFamilies 经 toModuleCfg 归一后由本 feat configure 转发；
 * 时段外/取消勾选时由 mech-build 先拉 1031 权威表、再对**在建（st=2）**塔逐座 1032 TOWER_REMOVE，
 * 已建成（st=3）塔显式跳过保留给联盟采集（关掉整张 autoFarm 卡不保证取消，详见子引擎头注释）。
 *
 * 升级抢田的防抖（缺位补派不受此限）：单拍最多撤 1 行（904 后名额要等 state=4 到家才真释放，
 * 多行同撤会造成多条田空转 + 902 撞全局限流 + 空窗期被发射井抢坑）；且要求已驻留 UPGRADE_MIN_DWELL_MS、
 * 同行距上次抢田超过 UPGRADE_COOLDOWN_MS。抢田后不钉目标——目标可能已被抢，回城补派时自然退回次优。
 * 判定本身的发包也节流：906 探更高级普通田每行 UPGRADE_PROBE_MS 一次、单拍最多 UPGRADE_PROBE_MAX_PER_PASS 行
 *（与「是否真撤田」解耦：没撤成也要记账，否则每拍重放 5 发 906）。
 *
 * 撤田后的「待归队」钉位（主闸，否则必撞英雄互斥）：904 受理的瞬间 856 就把这支归为返程（occupying=false），
 * 而服务端仍把英雄算在途直到到家——若拿「856 查不到」当缺位，下一拍（面板连续勾选时是 0.4s 后）就会对新田重发 902，
 * 得 code=3 + hero_mutually_exclusive_tip；旧实现把它当「点不可用」拉黑坐标，于是逐点换着撞（真机：连拒 3 次后撞全局限流）。
 * 现：撤回成功即给条目钉 recalledAt → reconcileLedger 保留该钉位（不放缺位）→ 10019 到家由 releaseRecallSlot 摘掉并唤醒补派
 *（推送漏了则靠 cfg.recallHomeMaxMs 超时回常规对账，宁可晚一轮也不钉死）；被拒分支另有一道 ERR_HERO_BUSY 分流（不拉黑、不换点）。
 *
 * 驻留闸与排程的衔接：configure 踢醒的那一拍会被驻留闸拦住（只读、零发包），此时不无脑睡满
 * idleScanInterval，而由 cycleRun 把长睡截到「最早驻留到点」（earliestDwellReady），到点即重评换田；
 * 限流退避期间不截（提前醒只会再撞一次同一条码）。
 *
 * 时段闸（按种类生效）：时段外 allowedKinds 恒收窄为 ['relic']——撤田只撤「不被允许的种类」，
 * 遗迹田保留在田、缺位的遗迹行照常补下；kind 未知时按 marchType=26→机械、targetType=38/itemId 组 15→遗迹、坐标反查池子判定。
 *
 * 撤田全局不变量：**遗迹田（6 级田）永不撤回**，三个撤田出口一律受此闸——时段外只撤机械/普通（recallAllFarms 硬闸）、
 * 升级抢田跳过遗迹行（upgradePass）、发射井为自己腾队列时把遗迹田剔出候选（launch-silo 走 core/resource.isRelicTarget）。
 * 识别走单一判据 core/resource.isRelicTarget：targetType=38（与 901 pointType 同轴，报文实证 856 条目恒带：普通田 4/遗迹田 38）
 * 优先，itemId 组 15 与 RESOURCE level≥6 兜底——三面都不依赖候选池是否已扫过。
 * 理由：6 级田只由遗迹刷新邮件批量开出、4 小时即到期，撤一趟往返就赶不上本期剩下的采集窗，收益远低于损失。
 *
 * 账本：storage.data['autoFarm']，rowIdx → [{marchId,x,y,marchType,heroIds,kind,level,facility,family,itemId,preset,dispatchedAt,upgradedAt,probedAt,recalledAt,gatheredAt}]，
 * 每行至多 1 条（recalledAt>0 = 待英雄归队的钉位；gatheredAt>0 = 该队真进过采集态，遗迹空返闭环的唯一判据；旧档无这些字段回 undefined 不影响读）；增删行导致下标位移时靠 preset 一致性闸销位（不把别人的田钉到本行），
 * 身份闸（英雄集）与孤儿认领沿用旧口径，防止外队把某行钉死到对方采完。
 * 抢田的两个时刻（upgradedAt/probedAt）落盘而非只存内存：本 feat offInCombat，进/出战斗模式与
 * 切场景都会重跑 run()，内存态冷却会被抹平 → 抖动窗口从 10min 退化成 3min。
 *
 * 生命周期由 reactor 托管：places 限 base/world、战斗模式暂停；唤醒源（run/10019 回城/配置变更/推送/遗迹池增长/兜底定时）
 * 全部汇入 cycle.kick。三个 cycle（派兵 / 遗迹扫图 / 机械田重扫）均由 alive 门控，暂停自然停摆；
 * 遗迹田是抢的，邮件驱动那条链必须闭环到底：**10264 刷新邮件 → 立即起扫图 cycle（不经去抖）→ 这批待扫邮件扫完 → 立即踢派兵 cycle 一轮**
 * （下田/换田判定都在 cyclePass 里；旧实现只「池子变大」才踢，零新点的收尾拍不重评，而扫图期间别的队已可能先落子）。
 * 子引擎 mech-build 的 install/configure/run/pause 由本 feat 生命周期统一转发（不独立注册 reactor）。
 */
import { parseData, sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { storage } from '../../../core/storage.js';
import { bus, EVT } from '../../../core/bus.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';
import { createCycle } from '../../../core/cycle.js';
import { screen } from '../../../core/net-guard.js';
import { getUid } from '../../../core/player.js';
import {
  KIND,
  KIND_ORDER,
  rankOf,
  allowedKinds,
  sortFamilies,
  pickBest,
  findUpgrade,
  wantsNormalProbe,
  inferKind,
  inferLevel,
  inferFacility,
  blacklist,
} from './priority.js';
import { relic } from './lvl6-scanner.js';
import { tower } from './tower-scanner.js';
import { normal } from './normal-scan.js';
import { mechBuild, normalizeMechFamilies, familyOptions } from './mech-build.js';
import { skillAttach } from './skill-attach.js';
import { heroIcon } from '../../../core/acl/hero-icon.js';
import { l10n } from '../../../core/acl/l10n.js';

import { CMD_MARCH_WORLD_POINT } from './constants.js';

/** @type {ReturnType<typeof createLog>} 模块日志器（tag=AUTO-FARM） */
const log = createLog('AUTO-FARM');

/**
 * @type {string} 902 拒绝载荷里「操作过快」的服务器全局限流文案键（march_time_control_info001）。
 * 与「点被抢/已失效」的真拒不同：田点本身有效，不应拉黑；命中即中止本轮剩余行、按指数退避重排下轮。
 */
const ERR_RATE_LIMIT = 'march_time_control_info001';
/**
 * @type {string} 902 拒绝载荷里「该武将已在另一支行军中」的文案键（hero_mutually_exclusive_tip）。
 * 典型成因不是田点问题，而是**刚撤回来的那支还在回城路上**：撤田后 856 不再把它算作占田（occupying=false），
 * 本地却据此判该行「缺位」并立刻派新田，而服务端仍把英雄算在途——此时换任何坐标都撞同一条码
 * （真机踩到：撤田后 0.4s 内连拒 3 次、每次换一个点，最后撞上全局行军限流）。故不拉黑、不换点重试。
 */
const ERR_HERO_BUSY = 'hero_mutually_exclusive_tip';
/** @type {number} 行军类型：普通/遗迹资源田采集（NMarchType.GATHER_RESOURCE） */
const KIND_FARM = 3;
/** @type {number} 行军类型：联盟机械田（资源塔）采集（枚举名 ATTACK_TOWER，复用值 26） */
const KIND_TOWER = 26;
/** @type {string} 账本逻辑键（storage.data 下，UID 前缀隔离） */
const LEDGER_NAME = 'autoFarm';
/** @type {number[]} 合法资源家族编码：1 石油 / 5 粮食 / 7 金矿 / 16 雷神 */
const RES_FAMILIES = [1, 5, 7, 16];
/** @type {number} 面板预设上限（1~8 战斗预设、9~16 采集预设） */
const PRESET_MAX = 16;

/** @type {object} 内置调优常量（面板不暴露） */
const cfg = {
  /** 仍有缺位未补上时的兜底扫描间隔（毫秒） */
  activeScanInterval: 1000 * 60,
  /** 全部田位都在途时的兜底间隔（毫秒）：正常靠 10019 唤醒，这里只是断推兜底 */
  idleScanInterval: 1000 * 60 * 10,
  /** 逐条 902 之间的休眠（毫秒）：拉开间隔规避行军时间限流 + 防 marches 入表延迟导致同轮超发 */
  marchInterval: 1000 * 8,
  /** 撤回田后「待英雄归队」占位最长保留（毫秒）：到点仍未收到回城推送就当作漏推，交回常规对账（该行宁可晚一轮下田） */
  recallHomeMaxMs: 1000 * 60 * 3,
  /** 推送唤醒补扫的最小间隔（毫秒）：合并突发回城推送 */
  pushScanMinGap: 1000 * 4,
  /** 撞 902 全局限流后的退避基数（毫秒）：按 streak 指数退避重排下轮 */
  rateLimitBackoffMs: 1000 * 15,
  /** 限流退避封顶（毫秒） */
  rateLimitBackoffMaxMs: 1000 * 60,
  /** 逐条撤田 904 之间的休眠（毫秒） */
  recallInterval: 1000 * 2,
  /** 「睡向下个时段起点」的单拍下限（毫秒）：防紧贴空转 */
  windowSleepMinMs: 1000 * 10,
  /**
   * 升级换田的最短驻留（毫秒）：刚派出的队不许立刻撤（防同拍派→撤抖动与连改勾选逐次白扔）。
   * 真正的循环保护靠 upgradeCooldownMs + 被拒拉黑，故本值只须盖住 configure 连点窗口；
   * 小于行军去程时，撤的是「还在路上、一口未采」的队，浪费反而最小。
   */
  upgradeMinDwellMs: 1000 * 60,
  /** 同一行两次抢田的最小间隔（毫秒）：防同坐标反复撤/派。落盘到账本条目，跨 run/刷新页仍生效 */
  upgradeCooldownMs: 1000 * 60 * 10,
  /** 单拍最多撤田换田的行数（904 名额释放慢 + 902 全局限流，见文件头） */
  upgradeMaxPerPass: 1,
  /** 同一行两次「发 906 探更高级普通田」的最小间隔（毫秒）：判定本身也限流，没撤成同样计时 */
  upgradeProbeMs: 1000 * 60 * 5,
  /** 单拍最多几行做 906 升级探测（906 每行最多 5 发，多行同探会自撞操作过快并牵连 902） */
  upgradeProbeMaxPerPass: 1,
  /**
   * 单拍每行普通田最多探几个家族（906 无零发包窥视，一族最坏 5 发）：四族一行全试能打出 20 发，
   * 撞进 cdTime「请求太频繁」会被游戏侧静默丢弃、反而全线误判无田。priority 会轮转起始族，
   * 保证被预算挡住后面的族下拍也能探到（不是永久盲掉）。
   */
  normalFamilyMax: 2,
  /**
   * 遗迹田派兵被拒后，同一行本轮最多再换几个点续抢（纯计数）：6 级田靠抢，
   * 一个点被别人先下不该白等一整拍（真机实录：被拒后本行直接转入下一行，缺位留到下次唤醒）。
   */
  relicRetryMax: 2,
  /** 遗迹田「到达却从未进入采集态」（被人先一步占/存量异常）的空返解禁（毫秒）：短到能立刻换下一块，又不反复撞同一点 */
  relicGatherFailMs: 1000 * 60 * 2,
};

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;
/** @type {object} 模块配置（configure 灌入）：rules 已归一化；timeRanges 已归一为 {s,e} 分钟数 */
var MCFG = { rules: [], timeWindowEnabled: false, timeRanges: [] };

/** @type {Object<string, Array<object>>} rowIdx（字符串键）→ 账本条目数组，每行至多 1 条 */
var ledger = {};
/** @type {boolean} 账本是否已从盘读回（未读回前不写，防拿空账本重复下田） */
var ledgerLoaded = false;
/** @type {boolean} 账本读盘在飞标记（单飞，防并发触发重复读盘） */
var ledgerLoading = false;

/** @type {number} 上次推送唤醒的墙钟时刻（毫秒），合并突发 */
var lastPushWakeAt = 0;
/** @type {boolean} 上轮是否仍有缺位未补（决定 active/idle 两档兜底间隔） */
var backlogActive = false;
/** @type {number} 连续撞 902 限流的次数（指数退避）；任一条 902 成功受理即归零 */
var rateLimitStreak = 0;
/** @type {number} 上轮时段外撤田后仍占用的（该撤）采集行军数（>0 → 短间隔复查） */
var outsideRemaining = 0;
/** @type {number} 本拍已执行的抢田次数 */
var passUpgrades = 0;
/** @type {number} 本拍已发起的 906 升级探测行数 */
var passProbes = 0;
/**
 * @type {number} held 行里最早的「驻留闸到点」时刻（epoch ms，0 = 无待判行）：
 *   供 cycleRun 把 idle 长睡截到这一拍，避免「改了种类勾选却要等满 idleScanInterval 才生效」。
 */
var nextDwellReadyAt = 0;
/** @type {Function|null} march.onHomeReturn 退订句柄（防 resume 重激活重复注册） */
var offHomeReturn = null;
/**
 * @type {Function|null} march.onStateChange 退订句柄：只用来给账本条目销「真开采过」（state=5 GATHERING）。
 * 没这个边沿就分不清「采满回家」与「到了发现被人先占、一口未采空返」，后者不拉黑就成了每拍重跑同一块死田。
 */
var offGatherEdge = null;
/**
 * @type {boolean} 抢田/换田的评估还没跑完：或遗迹池里仍有没复验过的候选（relic.staleCount>0），
 *   或本拍抢田名额（upgradeMaxPerPass）用完了但后面还有行未判。这类「还有事没做完」不该睡 idle 长档
 *   （真机：100 点池每拍只验 2 个、田只活 4h，永远验不完；8 行要换遗迹田得等满 8 个 10 分钟）。
 */
var reEvalPending = false;

/** @returns {boolean} 功能是否仍在运行 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/** @param {object} o @returns {boolean} 是否自有属性 */
function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

// ── 规则归一 ────────────────────────────────────────────────────
/**
 * 预设全局唯一：按行序扫描，重复者改为「第一个未被占用的 1..16」；全占满则保留原值并 log 一次。
 * 面板侧已把其它行选用的值置 disabled，这里兜住手改配置/并发写入。
 * @param {Array<object>} rows 归一化行数组（就地改写 preset）
 */
function assignUniquePresets(rows) {
  var used = {};
  var overflow = 0;
  for (var i = 0; i < rows.length; i++) {
    var want = rows[i].preset;
    if (!used[want]) {
      used[want] = 1;
      continue;
    }
    var free = 0;
    for (var p = 1; p <= PRESET_MAX; p++) {
      if (!used[p]) {
        free = p;
        break;
      }
    }
    if (!free) {
      overflow++;
      continue;
    }
    log.debug('preset #%d duplicated at row %d → reassign #%d', want, i, free);
    rows[i].preset = free;
    used[free] = 1;
  }
  if (overflow)
    log.info('%d row(s) keep duplicated preset: all %d presets taken.', overflow, PRESET_MAX);
}

/**
 * 面板原始 rules → 归一化行数组。**一行 = 一支队伍**：preset 单选（整表互斥）+ families 多选 + kinds 多选。
 * families 白名单 [1,5,7,16] 去重后按 FAMILY_RANK 降序（同分挑选的真相在 priority.js）；
 * kinds 去重 + 白名单 + 按 KIND_ORDER 重排；**空 families 或空 kinds = 该行不下田**；
 * 遗迹只在「本行勾选的家族全都开不出 6 级田」（只剩雷神）时剔除；预设全局唯一。
 * 旧档的单值 family 经注册表 migrate 升成 families，此处不再做形兼容（遇到就当空处理）。
 * @param {Array<object>} raw 面板原始行
 * @returns {Array<{preset:number, families:number[], kinds:string[]}>}
 */
function normalizeRules(raw) {
  var list = Array.isArray(raw) ? raw : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i] || {};
    var fams = sortFamilies(
      (Array.isArray(r.families) ? r.families : []).filter(function (f) {
        return RES_FAMILIES.indexOf(f | 0) >= 0;
      }),
    );
    // 雷神没有 6 级田（遗迹邮件只开得出金/粮/油），故只剩雷神时遗迹不可下
    var relicOk = fams.some(function (f) {
      return f !== 16;
    });
    var src = Array.isArray(r.kinds) ? r.kinds : [];
    var picked = [];
    for (var o = 0; o < KIND_ORDER.length; o++) {
      var k = KIND_ORDER[o];
      if (src.indexOf(k) < 0) continue;
      if (k === KIND.RELIC && !relicOk) continue;
      picked.push(k);
    }
    out.push({
      preset: Math.max(1, Math.min(PRESET_MAX, r.preset | 0) || 1),
      families: fams,
      kinds: picked,
      skill: !!(r.skill | 0), // v3：采集技能装载位（缺省关，旧行为不变）
    });
  }
  assignUniquePresets(out);
  return out;
}

/**
 * 面板预设号（1~16）→ Battle 预设 (index, type)：1~8 战斗预设（type=0，index=本身），
 * 9~16 采集预设（type=1，index=预设号-8）。与 battle.js getPreMarchByIndex(index-1, type) 口径对齐。
 * @param {number} p 面板预设号
 * @returns {{index:number, type:number}}
 */
function presetArgs(p) {
  var n = p | 0;
  if (n >= 9) return { index: n - 8, type: 1 };
  return { index: Math.max(1, n), type: 0 };
}

// ── 下田时段归一与判定 ──────────────────────────────────────────────
/** @param {string} str 面板 time 控件值 @returns {number|null} "HH:MM" → 当日分钟数 */
function normMinutes(str) {
  if (typeof str !== 'string') return null;
  var m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  var h = +m[1];
  var mm = +m[2];
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

/**
 * 面板原始 timeRanges → [{s,e}]（当日分钟数）；任一端非法的行丢弃（面板可留空/半填）。
 * @param {Array<{start:string,end:string}>} raw
 * @returns {Array<{s:number,e:number}>}
 */
function normalizeTimeRanges(raw) {
  var out = [];
  var list = Array.isArray(raw) ? raw : [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i] || {};
    var s = normMinutes(r.start);
    var e = normMinutes(r.end);
    if (s == null || e == null) continue;
    out.push({ s: s, e: e });
  }
  return out;
}

/** @returns {boolean} 时段闸是否生效（勾了启用且至少一行有效时段） */
function windowActive() {
  return !!(MCFG.timeWindowEnabled && MCFG.timeRanges && MCFG.timeRanges.length);
}

/** @returns {number} 当前本地墙钟的当日分钟数（含秒小数，边界判定更准） */
function curMin() {
  var d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * 当前是否落在任一下田时段内（本地墙钟）。s===e 视为全天；s<e 为 [s,e)；s>e 为跨午夜。
 * @returns {boolean}
 */
function inFarmWindow() {
  if (!windowActive()) return true;
  var t = curMin();
  var rs = MCFG.timeRanges;
  for (var i = 0; i < rs.length; i++) {
    var s = rs[i].s;
    var e = rs[i].e;
    if (s === e) return true;
    if (s < e) {
      if (t >= s && t < e) return true;
    } else if (t >= s || t < e) return true;
  }
  return false;
}

/** @returns {number} 距下个时段起点毫秒（仅时段外调用；无可算行回 0） */
function msToNextWindowStart() {
  var t = curMin();
  var rs = MCFG.timeRanges;
  var best = Infinity;
  for (var i = 0; i < rs.length; i++) {
    if (rs[i].s === rs[i].e) continue;
    var delta = rs[i].s > t ? rs[i].s - t : 1440 - t + rs[i].s;
    if (delta < best) best = delta;
  }
  if (!isFinite(best)) return 0;
  return best * 60000;
}

/** @returns {number} 距下个时段边界（起或止）毫秒（时段内调用；无可算边界回 0） */
function msToNextWindowEdge() {
  var t = curMin();
  var rs = MCFG.timeRanges;
  var best = Infinity;
  for (var i = 0; i < rs.length; i++) {
    if (rs[i].s === rs[i].e) continue;
    var ds = rs[i].s > t ? rs[i].s - t : 1440 - t + rs[i].s;
    var de = rs[i].e > t ? rs[i].e - t : 1440 - t + rs[i].e;
    if (ds < best) best = ds;
    if (de < best) best = de;
  }
  if (!isFinite(best)) return 0;
  return best * 60000;
}

/**
 * 全局允许的种类（时段闸）：时段内/未启用 → 全部；时段外 → 恒只留遗迹（遗迹田不受时段限制是固定行为，
 * 既不被撤、也照常允许补下）。
 * @returns {string[]}
 */
function globalAllowedKinds() {
  if (!windowActive() || inFarmWindow()) return KIND_ORDER.slice();
  return [KIND.RELIC];
}

// ── 账本持久化 ──────────────────────────────────────────────────────
/** 从盘读回账本（单飞；读失败不置 loaded、保留重试机会） @returns {Promise<void>} */
function loadLedger() {
  if (ledgerLoaded || ledgerLoading) return Promise.resolve();
  ledgerLoading = true;
  return Promise.resolve(storage.data.get(LEDGER_NAME))
    .then(function (saved) {
      ledgerLoading = false;
      if (saved && typeof saved === 'object') ledger = saved;
      ledgerLoaded = true;
    })
    .catch(function (err) {
      ledgerLoading = false;
      log.warn('load ledger failed, retry next cycle. %s', err && err.message);
    });
}

/** 账本落盘（fire-and-forget；内存账本仍是本轮真相） */
function persistLedger() {
  if (!ledgerLoaded) return;
  Promise.resolve(storage.data.set(LEDGER_NAME, ledger)).catch(function (err) {
    log.warn('persist ledger failed. %s', err && err.message);
  });
}

// ── 行军身份（预设归属）─────────────────────────────────────────────
/**
 * 规则行预设的原始英雄集（身份比对用）：走 MarchData.presetHeroIds，**不能**用 plan.heroList
 * （后者已被 getHaveHeroCanMarchList 过滤，部队在外采集时恒为空，恰在需要比对的场景失能）。
 * @param {object} row 归一化规则行
 * @returns {number[]} 预设英雄 id（读不到回 []）
 */
function rowPresetHeroes(row) {
  if (!row) return [];
  var pa = presetArgs(row.preset);
  try {
    var plan = new Battle().plan().preset(pa.index, pa.type).adjust().build();
    return plan.presetHeroIds || [];
  } catch (err) {
    return [];
  }
}

/**
 * 面板「队列技能」只读区块数据（type:'queueskills' 的 fd.get 数据源）：逐规则行一节——
 * [{preset, fam, skill, heroes:[{hid, name, level, items|null, str|null}]}]。英雄名/等级现场读
 * HeroData（借还轮转不影响名字与等级）；items/str 是出发瞬间装配快照（旧档无 items 时 str 兜底成文本行）。
 * 英雄集走 rowPresetHeroes（MarchData 口径，与派兵一致）。面板 get() 同步执行：slot 未加载 /
 * 符号未就绪时英雄集为空（面板显示未就绪占位），随下一次面板刷新补齐。
 * @param {Array} rules 面板配置的规则行（原始形状，内部 normalize）
 * @returns {Array|null} 无规则行时 null（面板显示占位）
 */
function queueSkillData(rules) {
  const rows = normalizeRules(rules || []);
  if (!rows.length) return null;
  const famLabel = function (family) {
    for (let i = 0; i < RULE_OPTS.familyOptions.length; i++) {
      if (RULE_OPTS.familyOptions[i].value === family) return RULE_OPTS.familyOptions[i].short;
    }
    return '';
  };
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const heroes = rowPresetHeroes(row);
    const hs = [];
    for (let j = 0; j < heroes.length; j++) {
      const hid = heroes[j] | 0;
      const h = skillAttach.heroData(hid);
      const info = skillAttach.loadoutInfo(hid);
      hs.push({
        hid: hid,
        name: h && h._name ? l10n.text(h._name) || h._name : '英雄' + hid,
        level: h ? h._level | 0 : 0,
        // 星级（HeroData._star 底层直读，同 _level 口径）：头像边框色 ≥5金/4紫/3蓝，其余默认描边
        star: h ? h._star | 0 : 0,
        icon: heroIcon.heroPath(h),
        // icon 是展示资产不进快照语义：渲染期一律按 skillId 现查表（skillInfo 权威分支：
        // skill_type==1 走 hero_skill.skill_icon，其余 item 表反查）。快照 items 里的 icon 字段是
        // 历史版本写入的查询产物，可能为废弃占位错值（skill_icon020 全表同值），不读。
        items:
          info && Array.isArray(info.items)
            ? info.items.map(function (it) {
                return {
                  skillId: it.skillId | 0,
                  name: it.name,
                  tag: it.tag,
                  icon: skillAttach.skillIconPath(it.skillId),
                  level: it.level | 0,
                };
              })
            : null,
        str: info && info.str && info.str !== 'empty' ? info.str : '',
      });
    }
    out.push({
      preset: row.preset | 0,
      fam: famLabel(row.family | 0),
      skill: !!row.skill,
      heroes: hs,
    });
  }
  return out;
}

/**
 * 行军与本行预设是否「确定不是一支队」：两侧英雄集都非空且完全不相交才算外来。
 * 任一侧为空（无英雄预设 / 旧档未记 / 推送不带 heroIds）判不出身份 → false：宁可不销位，也不误把真在途的田当缺位重派。
 * @param {number[]} presetHeroes 本行预设英雄集
 * @param {number[]} marchHeroes 856 行军的英雄集
 * @returns {boolean} true=确定外来
 */
function isForeignMarch(presetHeroes, marchHeroes) {
  if (!presetHeroes || !presetHeroes.length) return false;
  if (!marchHeroes || !marchHeroes.length) return false;
  var set = new Set(presetHeroes);
  for (var i = 0; i < marchHeroes.length; i++) {
    if (set.has(marchHeroes[i] | 0)) return false;
  }
  return true;
}

// ── 在途行军（856 权威源） ──────────────────────────────────────────
/**
 * 本人全部采集行军（marchType 3/26）。走 core/march.list()（封装 856，视口无关，Home 同样返回）。
 * 永不 reject：失败回 []（本轮视作无在途，由自由名额/预设在两道闸兜底）。
 * @returns {Promise<Array<object>>}
 */
async function fetchMyFarmMarches() {
  var ms = await march.list();
  var out = [];
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    var mt = m.type | 0;
    if (mt !== KIND_FARM && mt !== KIND_TOWER) continue;
    var raw = m.raw || {};
    var hsi = raw.heroStateInfo || null;
    var heroIds = hsi && Array.isArray(hsi.heroIds) ? hsi.heroIds.map(Number) : [];
    out.push({
      marchId: m.id,
      x: m.target.x,
      y: m.target.y,
      marchType: mt,
      state: m.state,
      occupying: m.isOccupying,
      heroIds: heroIds,
      itemId: m.target.itemId | 0,
      targetType: m.target.targetType | 0,
    });
  }
  return out;
}

/**
 * 本人全部「非返程/到家」行军的目标点集合（"x,y"）：普通田一队一格、机械田虽允许多队同格，
 * 但本 feat 不让自家两队抢同一塔，故一律预规为占用（返程/到家已让出矿位不计）。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @returns {Set<string>}
 */
function occupiedPointSet(marches) {
  var s = new Set();
  for (var i = 0; i < marches.length; i++) {
    var mg = marches[i];
    if (!mg.occupying) continue;
    if (mg.x == null || mg.y == null) continue;
    s.add(mg.x + ',' + mg.y);
  }
  return s;
}

/**
 * 由池/表反查在途田的家族（账本缺 family 时用），都查不到回退 fallback。
 * @param {string} kind 种类
 * @param {number} x 坐标
 * @param {number} y 坐标
 * @param {number} itemId 856 target.itemId（普通田反查线索）
 * @param {number} fallback 兜底家族
 * @returns {number}
 */
function inferFamily(kind, x, y, itemId, fallback) {
  var key = (x | 0) + ',' + (y | 0);
  var e =
    kind === KIND.RELIC ? relic.entryAt(key) : kind === KIND.TOWER ? tower.entryAt(key) : null;
  if (e && e.family) return e.family | 0;
  if (itemId) {
    var m = normal.resourceMeta(itemId);
    if (m && m.family) return m.family | 0;
  }
  return fallback | 0;
}

/**
 * 反推在途田家族时的兜底值：一行多族后「行家族」不再是答案，只拿优先级首位当估计
 * （真值靠池/活表/itemId 反推，这个兜底仅用于反推不出来的诊断场景）。
 * @param {{families?:number[]}} row 归一化规则行
 * @returns {number} 估计家族；0 = 本行未勾任何族
 */
function rowFamilyGuess(row) {
  var f = row && Array.isArray(row.families) ? row.families[0] : 0;
  return f | 0;
}

/**
 * 用 856 权威行军修剪/回填账本：
 *   1) 行号越界（规则行被删）→ 该键整体作废；
 *   2) 条目 preset 与当前行不一致 → 销位（增删行导致下标位移时不会把别人的田钉到本行）；
 *   3) marchId 命中且仍占用 → 保留；命中但已返程/到家，或 856 全量缺席（全量真相）→ 移除，该行变回缺位；
 *      ❗坐标兜底只用于条目本身无 marchId（旧档）：机械田允许多队同格，拿坐标接「marchId 已消失」的条目会被同格另一队误判仍占用；
 *      一个在途行军只消归一个槽位（命中即从索引剔除），免一军钉多行；
 *   4) 认领孤儿：856 中存在但未被任何账本行引用的采集行军 → 回填到第一个身份相符的缺位行。
 * 身份闸：外队行军（heroIds 与本行预设英雄集不相交）既不钉位也不认领。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @param {object[]} allRules 全部规则行（下标即账本键）
 * @returns {boolean} 账本是否变化（需要落盘）
 */
function reconcileLedger(marches, allRules) {
  var changed = false;
  var liveIds = {};
  var liveCoord = {};
  for (var i = 0; i < marches.length; i++) {
    var mg = marches[i];
    if (!mg.occupying) continue;
    if (mg.marchId) liveIds[mg.marchId] = mg;
    if (mg.x != null && mg.y != null) liveCoord[mg.x + ',' + mg.y] = mg;
  }
  var isGather = function (mt) {
    return mt === KIND_FARM || mt === KIND_TOWER;
  };
  for (var key in ledger) {
    if (!hasOwn(ledger, key)) continue;
    var idx = +key;
    if (!(idx >= 0 && idx < allRules.length)) {
      delete ledger[key];
      changed = true;
      continue;
    }
    var row = allRules[idx] || {};
    var arr = Array.isArray(ledger[key]) ? ledger[key] : [];
    var presetHeroes = arr.length ? rowPresetHeroes(row) : [];
    var keep = [];
    for (var n = 0; n < arr.length; n++) {
      var e = arr[n] || {};
      // preset 一致性闸：行被增删/改预设后，旧条目可能已属于别的行；不销位就会把别人的田钉死在本行
      if (e.preset != null && (e.preset | 0) !== (row.preset | 0)) {
        log.debug('drop ledger slot: preset changed. row=%d %d->%d', idx, e.preset, row.preset);
        changed = true;
        continue;
      }
      var hit = e.marchId ? liveIds[String(e.marchId)] : liveCoord[e.x + ',' + e.y];
      if (!hit || !isGather(hit.marchType | 0)) {
        // 撤回来的行军已转返程（856 不再算占田）≠ 田位空了：英雄还在回城路上，此刻放开钉位本行就立刻被算缺位重派。
        // 保留「待归队」占位直到回城推送（releaseRecallSlot）；超时则当作漏推交回常规移除，避免永久钉死一行。
        if (e.recalledAt && Date.now() - e.recalledAt < cfg.recallHomeMaxMs) keep.push(e);
        continue;
      }
      // 撤回了却在 856 里仍占着田 = 撤回未真生效（应答 ok 但状态未变/时序竞争）：撤掉待归队标记回到常规判定
      if (e.recalledAt) {
        delete e.recalledAt;
        changed = true;
      }
      if (isForeignMarch(presetHeroes, hit.heroIds)) {
        log.info(
          'drop ledger slot held by foreign march. row=%d marchId=%s marchHeroes=%s presetHeroes=%s',
          idx,
          hit.marchId,
          (hit.heroIds || []).join('/') || '-',
          presetHeroes.join('/') || '-',
        );
        continue; // 不消费该行军：它可能真的属于另一行的槽位
      }
      if (e.marchId) delete liveIds[String(e.marchId)];
      if (hit.x != null && hit.y != null) delete liveCoord[hit.x + ',' + hit.y];
      if (e.itemId == null && hit.itemId != null) {
        // 田位身份（普通田靠 itemId 反推等级/家族）：旧条目缺位时用 856 现成的 itemId 补录，零额外发包
        e.itemId = hit.itemId | 0;
        changed = true;
      }
      if (e.kind == null) {
        e.kind = inferKind(hit.marchType, hit.x, hit.y, hit);
        changed = true;
      }
      if (!e.level) {
        e.level = inferLevel(e.kind, hit.x, hit.y, hit.itemId);
        changed = true;
      }
      if (!e.family) {
        e.family = inferFamily(e.kind, hit.x, hit.y, hit.itemId, rowFamilyGuess(row));
        changed = true;
      }
      // 只机械田有设施级：非机械田恒 0，不能写成 `if (!e.facility)`（否则每拍都当成缺位重复落盘）
      if (e.kind === KIND.TOWER && !e.facility) {
        e.facility = inferFacility(e.kind, hit.x, hit.y);
        changed = true;
      }
      // 「真开采过」的快照补认：856 里已见 state=5，就不必等 10019 边沿。
      // 只靠边沿会在「刷新页后重挂订阅」时永久漏认（那期间已在采集的行军不再产生跃迁），
      // 于是到家被误判成空返、白拉黑一块好田（同类坑见惧星在途锁的 confirmed 修复）。
      if (!e.gatheredAt && hit.state === march.State.GATHERING) {
        e.gatheredAt = Date.now();
        changed = true;
      }
      keep.push(e);
    }
    if (keep.length !== arr.length) changed = true;
    if (keep.length) ledger[key] = keep;
    else delete ledger[key];
  }
  // 认领孤儿采集行军（跨页面刷新/手动下的田也算数）
  var claimed = {};
  for (var k2 in ledger) {
    var a2 = ledger[k2] || [];
    for (var q = 0; q < a2.length; q++) if (a2[q].marchId) claimed[String(a2[q].marchId)] = 1;
  }
  for (var s = 0; s < marches.length; s++) {
    var ms = marches[s];
    if (!ms.occupying || ms.x == null || ms.y == null) continue;
    var mt = ms.marchType | 0;
    if (!isGather(mt)) continue;
    var mid = String(ms.marchId);
    if (claimed[mid]) continue;
    var filled = -1;
    for (var r2 = 0; r2 < allRules.length; r2++) {
      if (ledger[r2] && ledger[r2].length) continue;
      if (isForeignMarch(rowPresetHeroes(allRules[r2]), ms.heroIds)) continue;
      filled = r2;
      break;
    }
    if (filled < 0) {
      log.debug(
        'skip adopting march, no row owns its heroes. marchId=%s mt=%d x=%d y=%d',
        mid,
        mt,
        ms.x,
        ms.y,
      );
      continue;
    }
    var kind = inferKind(mt, ms.x, ms.y, ms);
    var level = inferLevel(kind, ms.x, ms.y, ms.itemId);
    ledger[filled] = [
      {
        marchId: mid,
        x: ms.x,
        y: ms.y,
        marchType: mt,
        heroIds: (ms.heroIds || []).slice(),
        kind: kind,
        level: level,
        facility: inferFacility(kind, ms.x, ms.y),
        family: inferFamily(kind, ms.x, ms.y, ms.itemId, rowFamilyGuess(allRules[filled])),
        itemId: ms.itemId | 0,
        preset: allRules[filled].preset,
        dispatchedAt: Date.now(),
        upgradedAt: 0,
        probedAt: 0,
      },
    ];
    claimed[mid] = 1;
    changed = true;
    log.debug(
      'adopt orphan gather march. row=%d marchId=%s %s(%d) x=%d y=%d',
      filled,
      mid,
      kind,
      level,
      ms.x,
      ms.y,
    );
  }
  return changed;
}

/**
 * 账本占位分解（专治「某行一直不下田却无任何日志」）：逐非空行列出预设英雄集与各槽位的
 * {kind(level:family) marchId @坐标 mt=类型}，及在 856 在途源里的匹配方式（id/coord/recalling/stale）。
 * 一行多族后 family 不再能从行读出，必须逐槽位显式带出（否则「这队到底在采哪个资源」看不出）。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @param {object[]} allRules 规则行
 * @returns {string} 形如 "0[preset 205/122](relic(6:7) 123 @350,294 mt=3 id st=5)"，无占位行回空串
 */
function describeLedgerHolds(marches, allRules) {
  var liveIds = {};
  var liveCoord = {};
  for (var i = 0; i < marches.length; i++) {
    var mg = marches[i];
    if (!mg.occupying) continue;
    if (mg.marchId) liveIds[String(mg.marchId)] = mg;
    if (mg.x != null && mg.y != null) liveCoord[mg.x + ',' + mg.y] = mg;
  }
  var parts = [];
  for (var key in ledger) {
    if (!hasOwn(ledger, key)) continue;
    var arr = Array.isArray(ledger[key]) ? ledger[key] : [];
    if (!arr.length) continue;
    var presetHeroes = rowPresetHeroes((allRules || [])[+key]);
    var slots = [];
    for (var n = 0; n < arr.length; n++) {
      var e = arr[n] || {};
      var byId = e.marchId ? liveIds[String(e.marchId)] : null;
      var byCoord = e.marchId ? null : liveCoord[e.x + ',' + e.y];
      var hit = byId || byCoord;
      slots.push(
        (e.kind === KIND.TOWER
          ? // 机械田有两级：矿脉级/设施级（rank 里分别占十位与个位），只看一个会误判优先级
            'tower(' + (e.level | 0) + '/' + (e.facility | 0) + ':' + (e.family | 0) + ')'
          : (e.kind || '?') + '(' + (e.level | 0) + ':' + (e.family | 0) + ')') +
          ' ' +
          (e.marchId || '?') +
          ' @' +
          e.x +
          ',' +
          e.y +
          ' mt=' +
          (e.marchType | 0) +
          (hit
            ? '(match=' + (byId ? 'id' : 'coord') + ' st=' + hit.state + ')'
            : e.recalledAt
              ? '(recalling→home)'
              : '(stale)'),
      );
    }
    parts.push(key + '[preset ' + (presetHeroes.join('/') || '-') + '](' + slots.join(' ') + ')');
  }
  return parts.join(' ');
}

// ── 派发 / 撤田 ────────────────────────────────────────────────────
/**
 * 下田 902：marchType 由候选带回（3 普通/遗迹、26 机械）。永不 reject（march.attack 内部 catch）。
 * @param {{x:number,y:number,marchType:number}} coord 目标点
 * @param {object} plan MarchData
 * @returns {Promise<object>} net.Ret
 */
async function sendFarm(coord, plan) {
  return await march.attack({
    marchType: coord.marchType,
    target: { x: coord.x, y: coord.y },
    data: plan,
  });
}

/**
 * 时段外撤田：逐条 904 撤回当前「占用中」的采集行军，条间 sleep(recallInterval) 规避行军时间限流。
 * allow 非空时只撤「不被允许的种类」；❗遗迹田是全局硬闸——无论 allow 传什么都永不撤（见文件头不变量）。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @param {string[]|null} allow 允许保留的种类（null/空 = 除遗迹外全撤）
 * @returns {Promise<number>} 本轮所见仍占用的（该撤）采集行军数
 */
async function recallAllFarms(marches, allow) {
  var n = 0;
  var keep = Array.isArray(allow) && allow.length ? allow.slice() : [];
  if (keep.indexOf(KIND.RELIC) < 0) keep.push(KIND.RELIC); // 遗迹硬闸：即便调用方传空 allow 也不撤
  for (var i = 0; i < marches.length; i++) {
    var m = marches[i];
    if (!m.occupying) continue;
    var mt = m.marchType | 0;
    if (mt !== KIND_FARM && mt !== KIND_TOWER) continue;
    var kind = inferKind(mt, m.x, m.y, m);
    if (keep.indexOf(kind) >= 0) continue; // 豁免种类（必含遗迹）：时段外照常维持
    if (!aliveFn()) return n;
    n++;
    var rr = await march.recall(m.marchId);
    // 撤回成功即钉「待归队」：时段外豁免分支撤完接着就算缺位重派（同一拍），英雄未释放必撞互斥
    if (rr && rr.ok) markRecalled(m.marchId);
    log.info('out-of-window recall. marchId=%s kind=%s x=%d y=%d', m.marchId, kind, m.x, m.y);
    if (i < marches.length - 1) await sleep(cfg.recallInterval, ctxRef && ctxRef.signal);
  }
  return n;
}

/**
 * 撤回田成功 → 给对应账本条目钉上「待归队」标记（reconcileLedger 据此保留钉位，dispatchRows 不会把本行算缺位）。
 * 撤田后 856 会把这支转为返程（不再 occupying），若当作「田位已释放」立刻重派，英雄未释放必撞互斥。
 * @param {string|number} marchId 已受理撤回的 id
 * @returns {boolean} 是否命中条目（未命中 = 孤儿田/手动下的田不在本 feat 账本里）
 */
function markRecalled(marchId) {
  var mid = String(marchId || '');
  if (!mid) return false;
  for (var key in ledger) {
    if (!hasOwn(ledger, key)) continue;
    var arr = ledger[key] || [];
    for (var n = 0; n < arr.length; n++) {
      if (arr[n] && String(arr[n].marchId) === mid) {
        arr[n].recalledAt = Date.now();
        persistLedger();
        return true;
      }
    }
  }
  return false;
}

/**
 * 按 marchId 反查账本条目（行军边沿事件只带 id，要落到「哪一行、哪块田」就得这么回查）。
 * id 一律 String 比较：雪花 id 超过 2^53，转 Number 会静默丢精度后认错人。
 * @param {string|number} marchId 归一化 March.id
 * @returns {{rowIdx:number, entry:object}|null}
 */
function findLedgerEntry(marchId) {
  var mid = String(marchId || '');
  if (!mid) return null;
  for (var key in ledger) {
    if (!hasOwn(ledger, key)) continue;
    var arr = Array.isArray(ledger[key]) ? ledger[key] : [];
    for (var n = 0; n < arr.length; n++) {
      if (arr[n] && String(arr[n].marchId) === mid) return { rowIdx: +key, entry: arr[n] };
    }
  }
  return null;
}

/**
 * 行军到家 → 放开它的「待归队」占位（英雄已释放，此刻该行才算真缺位）。
 * @param {string|number} marchId 到家行军 id
 * @returns {boolean} 是否命中并摘掉了占位条目
 */
function releaseRecallSlot(marchId) {
  var mid = String(marchId || '');
  if (!mid) return false;
  var hit = false;
  for (var key in ledger) {
    if (!hasOwn(ledger, key)) continue;
    var arr = ledger[key] || [];
    for (var n = arr.length - 1; n >= 0; n--) {
      if (arr[n] && arr[n].recalledAt && String(arr[n].marchId) === mid) {
        arr.splice(n, 1);
        hit = true;
      }
    }
    if (hit && !arr.length) delete ledger[key];
  }
  if (hit) persistLedger();
  return hit;
}

/**
 * 缺位行派兵：逐行按 rank 取最优候选（遗迹→机械→普通，族内跨族取优），成功即记账本；逐条 sleep 拉开间隔。
 * @param {number[]} rows 缺位行的规则下标
 * @param {string[]} allow 全局允许的种类
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @returns {Promise<number>} 本轮派成条数
 */
async function dispatchRows(rows, allow, taken) {
  var all = MCFG.rules || [];
  var free = march.freeSlots();
  var dispatched = 0;
  for (var t = 0; t < rows.length; t++) {
    if (!aliveFn()) return dispatched;
    if (free <= 0) {
      log.debug('slot exhausted mid-cycle, remaining=%d', rows.length - t);
      break;
    }
    var idx = rows[t];
    var row = all[idx];
    var kinds = allowedKinds(row, allow);
    if (!kinds.length) continue;

    // 预设可用性（纯本地读，零发包）：armyListNew 为空多半意味这支部队已在外（正在下田/采集）→ 本行其实已被占用，静默跳过
    var pa = presetArgs(row.preset);
    var plan = new Battle().plan().preset(pa.index, pa.type).adjust().build();
    if (!plan.armyListNew.length) {
      log.debug(
        'row %d preset #%d(%s#%d) army already out, skip.',
        idx,
        row.preset,
        pa.type ? 'gather' : 'battle',
        pa.index,
      );
      continue;
    }
    // 英雄就绪守卫：10019 回城后兵池已刷新、英雄释放推送（HeroController）尚未到达的竞争窗口，此时 902 会带空英雄。
    // ⚠️ 两道本地 plan 守卫只反映「预设/兵池数据读得到读不到」，**不反映服务端的英雄占用**：
    // 真机实证撤田后 0.4s 发出 902 时 armyListNew/heroList 仍非空，照样撞 hero_mutually_exclusive_tip——
    // 撤田后的归队等待不能依赖这里，要靠账本 recalledAt 钉位（见文件头「待归队」钉位一段）。
    if (plan.presetHasHeroes && !plan.heroList.length) {
      log.debug('row %d preset #%d heroes not yet released, skip this cycle.', idx, row.preset);
      backlogActive = true;
      continue;
    }
    if (net.isSending(CMD_MARCH_WORLD_POINT)) {
      backlogActive = true;
      break;
    }

    // 6 级田靠抢：被拒（多为目标已被别人先一步下）不等于本行本轮无田——同行内换点续抢，
    // 上一发被拒的点已由 relic.block 记入解禁表，pick 不会重复选中；上限 cfg.relicRetryMax。
    // 两个例外不续抢：全局限流（中止本轮剩余行）、英雄未归队（换点注定同码，等归队唤醒）。
    var stopRows = false;
    for (var att = 0; ; att++) {
      var cand = await pickBest(row.families, kinds, taken, { familyBudget: cfg.normalFamilyMax });
      if (!aliveFn()) return dispatched;
      if (!cand) {
        if (!att)
          log.debug(
            'no candidate. row=%d preset #%d families=%s kinds=%s',
            idx,
            row.preset,
            (row.families || []).join('+') || '-',
            kinds.join('+'),
          );
        break;
      }
      var ck = cand.x + ',' + cand.y;
      // 采集技能装载（行级勾选 skill 时）：先装配（1345 切组2 + 复制组1 + 补采集书）再派兵——
      // 增益在 902 受理瞬间写进行军快照，派完即卸归还书池（借还轮转）；release 必须进 finally，
      // march 报错/中止也不能跳过，否则书被钉死在首批英雄身上后续队借不到（skill-attach 头注释）。
      var skillOn =
        !!row.skill && Array.isArray(plan.presetHeroIds) && plan.presetHeroIds.length > 0;
      var ret; // try 内必赋值后才读；attach 抛错时 finally 归还后异常照抛，ret 永不被读
      try {
        if (skillOn) await skillAttach.attachHeroes(plan.presetHeroIds, cand.family, aliveFn);
        // 装配期间开关被关：技能照还（finally），兵不再派——20261121 真机：在途轮跑完还把 902 发了
        if (aliveFn()) {
          ret = await sendFarm(cand, plan);
        } else {
          log.debug(
            'farm march skipped. feat paused during attach (row=%d x=%d y=%d).',
            idx,
            cand.x,
            cand.y,
          );
        }
      } finally {
        if (skillOn) await skillAttach.releaseHeroes(plan.presetHeroIds);
      }
      // 装配快照已写入：面板开着就重绘本卡（面板关着由 pendingRebuild 记账、开面板补），
      // 让「队列技能」区块跟上最新一轮的实装清单
      if (skillOn) bus.emit(EVT.UI_REFRESH, { rebuild: 'autoFarm' });
      if (!aliveFn()) return dispatched;
      if (ret.ok) {
        taken.add(ck);
        rateLimitStreak = 0;
        var d = parseData(ret.data) || {};
        // 标定我方采集行军速度：抢道判定要拿「我方预计到达」跟对手比，不硬编码秒表
        relic.learnSpeed(cand.x, cand.y, d.marchInfo || null);
        var mid =
          d.marchInfo && d.marchInfo.marchId != null
            ? String(d.marchInfo.marchId)
            : d.marchId != null
              ? String(d.marchId)
              : '';
        ledger[idx] = [
          {
            marchId: mid,
            x: cand.x,
            y: cand.y,
            marchType: cand.marchType,
            heroIds: (plan.presetHeroIds || []).slice(),
            kind: cand.kind,
            level: cand.level, // 矿脉（资源）级；机械田未探到时已兜底为设施级
            facility: cand.facility | 0, // 机械设施级，非机械田 0
            family: cand.family,
            itemId: cand.itemId | 0,
            preset: row.preset,
            dispatchedAt: Date.now(),
            upgradedAt: 0,
            probedAt: 0,
            gatheredAt: 0, // 是否真进过采集态（state=5）：0 = 未观测到，空返闭环靠它
          },
        ];
        persistLedger();
        free--;
        dispatched++;
        log.info(
          'farm march ok. row=%d kind=%s ore=%d fac=%d family=%d rank=%d x=%d y=%d marchId=%s',
          idx,
          cand.kind,
          cand.level,
          cand.facility | 0,
          cand.family,
          cand.rank,
          cand.x,
          cand.y,
          mid || '?',
        );
        break;
      }
      var errKey = rejectErrKey(ret.data);
      if (errKey === ERR_RATE_LIMIT) {
        // 服务器 902 全局限流（操作过快）：田点本身有效，绝不拉黑；中止本轮剩余行并按 streak 指数退避
        rateLimitStreak++;
        stopRows = true;
        log.info(
          'farm march rate-limited, stop burst and back off. row=%d kind=%s x=%d y=%d streak=%d',
          idx,
          cand.kind,
          cand.x,
          cand.y,
          rateLimitStreak,
        );
        break;
      }
      if (errKey === ERR_HERO_BUSY) {
        // 英雄未归队（多半是本行刚撤回的那支还在路上），与田点无关：
        // 拉黑会误杀好点、换点重试注定同码（还把节奏推向全局限流）——就地放弃本行，等撤田唤醒。
        // reconcileLedger 的「待归队」钉位是主闸（本行不该走到这里），这条兜手动撤田/撤田推送未入账本的场景。
        backlogActive = true;
        log.info(
          'farm march rejected (hero not home yet), wait for return wake. row=%d kind=%s x=%d y=%d',
          idx,
          cand.kind,
          cand.x,
          cand.y,
        );
        break;
      }
      if (cand.kind === KIND.RELIC)
        relic.block(cand.x, cand.y); // 遗迹会刷新复活：记解禁时刻，非同族硬拉黑
      else blacklist.add(cand.x, cand.y);
      log.info(
        'farm march rejected. row=%d kind=%s x=%d y=%d code=%s why=%s',
        idx,
        cand.kind,
        cand.x,
        cand.y,
        ret.code,
        errKey || '-',
      );
      if (cand.kind !== KIND.RELIC || att >= cfg.relicRetryMax) break;
      if (net.isSending(CMD_MARCH_WORLD_POINT)) {
        backlogActive = true;
        break;
      }
      // 续抢下一点：拉开间隔同逐条派兵口径（免把重试打成 902 全局限流）
      log.debug('row=%d relic point lost, grab next. attempt=%d', idx, att + 1);
      await sleep(cfg.marchInterval, ctxRef && ctxRef.signal);
    }
    if (stopRows) break;
    if (t < rows.length - 1 && free > 0) await sleep(cfg.marchInterval, ctxRef && ctxRef.signal);
  }
  return dispatched;
}

/**
 * 902 被拒裸串 → 语言键：被拒时 data 是 "语言键,参数" 形式的裸串（受理才是整包 JSON），取首个逗号前。
 * @param {*} data net.Ret.data
 * @returns {string|null}
 */
function rejectErrKey(data) {
  if (typeof data !== 'string' || !data) return null;
  var comma = data.indexOf(',');
  return comma >= 0 ? data.slice(0, comma) : data;
}

/**
 * 把在途田归约成 priority.findUpgrade 需要的 {kind, family, level, facility}。
 * rank = 种类×10000 + 家族×1000 + 矿脉级×10 + 设施级，所以 **family 与 facility 都参与升级判定**（不是只供诊断）。
 * @param {object} e 账本条目
 * @param {object} row 规则行（仅用于家族反推不出时的兜底估计）
 * @returns {{kind:string, level:number, family:number, facility:number}|null} 推不出等级回 null（不瞎换）
 */
function currentFarm(e, row) {
  var kind = e.kind || inferKind(e.marchType, e.x, e.y, e);
  var level = e.level | 0;
  if (!level) level = inferLevel(kind, e.x, e.y, e.itemId);
  if (!level) return null;
  var facility = e.facility | 0;
  if (!facility) facility = inferFacility(kind, e.x, e.y);
  return {
    kind: kind,
    level: level,
    facility: facility,
    family: e.family | 0 || rowFamilyGuess(row),
  };
}

/**
 * 升级抢田：对账本占位的行做一次判定，发现 rank 更高的可下候选 → 904 撤田（不钉目标）。
 * 闸门：驻留时长 + 同行冷却（upgradedAt，落盘）+ 单拍上限 + **遗迹行不撤**（全局不变量）；
 * 候选必须已经过 priority 的派前校验且不在黑名单。
 * 906 探测另走一层节流（probedAt，落盘）：与「是否真撤田」解耦，没找到更优田也算一次，否则每拍重放 5 发。
 * 撤田后账本条目暂留（田位仍被占），待 856 显示已返程再销位，随后由缺位派兵按新 rank 重取。
 * @param {string[]} allow 全局允许的种类
 * @param {Set<string>} taken 本轮已占用/已派点键
 * @returns {Promise<number>} 本轮执行的抢田次数
 */
async function upgradePass(allow, taken) {
  var all = MCFG.rules || [];
  var wall = Date.now();
  for (var key in ledger) {
    if (!hasOwn(ledger, key)) continue;
    if (passUpgrades >= cfg.upgradeMaxPerPass) {
      // 名额用完（单拍只撞 1 行是既有防抖：904 名额释放慢 + 902 全局限流）但本拍还有行没判：
      // 不留 active 档就会睡回 10min，刚刷出的 6 级田要分 8 个 10 分钟才能逐行换完。
      reEvalPending = true;
      return passUpgrades;
    }
    var idx = +key;
    var arr = Array.isArray(ledger[key]) ? ledger[key] : [];
    var row = all[idx];
    if (!row || !arr.length) continue;
    var e = arr[0] || {};
    if (!e.marchId) continue;
    if (wall - (e.dispatchedAt || 0) < cfg.upgradeMinDwellMs) continue;
    if (wall - (e.upgradedAt || 0) < cfg.upgradeCooldownMs) continue;
    var kinds = allowedKinds(row, allow);
    if (!kinds.length) continue;
    var cur = currentFarm(e, row);
    if (!cur) {
      log.debug('cannot tell current farm of row=%d, skip upgrade.', idx);
      continue;
    }
    // 遗迹田永不撤（全局不变量）：即便探到更高 rank 的遗迹田也不换——撤一趟往返就赶不上本期采集窗，且遗迹已是最高种类
    if (cur.kind === KIND.RELIC) continue;
    // 906 行级/拍级节流：行内冷却未过或本拍名额已用 → 不允许发 906（遗迹/机械的零发包窥视与 901/1034 不受影响）。
    // 计时先于探测落地：没找到更优田、甚至没撤成都算一次，否则坏候选会每拍重放最多 5 发 906。
    var needsProbe = wantsNormalProbe(cur) && kinds.indexOf(KIND.NORMAL) >= 0;
    var mayProbe = false;
    if (needsProbe) {
      mayProbe =
        passProbes < cfg.upgradeProbeMaxPerPass && wall - (e.probedAt || 0) >= cfg.upgradeProbeMs;
      if (mayProbe) {
        passProbes++;
        e.probedAt = wall;
        persistLedger();
      } else log.debug('row=%d 906 upgrade probe throttled.', idx);
    }
    var better = await findUpgrade(cur, row.families, kinds, taken, {
      normalProbe: mayProbe,
      familyBudget: cfg.normalFamilyMax,
    });
    if (!aliveFn()) return passUpgrades;
    if (!better) {
      // 勾了遗迹却「没动静」时，光看 rank 推不出原因（池里家族不合 / 全被人占 / 还在拉黑期内 都会空手而归），
      // 就把遗迹池的实际形状摊开（describe 零发包纯查表，只在 debug 档打，一行一族一份）
      if (kinds.indexOf(KIND.RELIC) >= 0) {
        log.debug(
          'row=%d no better field. cur=%s r%d %s',
          idx,
          cur.kind,
          rankOf(cur),
          (row.families || [])
            .map(function (fm) {
              return relic.describe(fm | 0);
            })
            .join(' | '),
        );
        // 池里还有没复验过的点 ⇒ 本行不是「真没田」而是「还没验到」：6 级田靠抢，
        // 按 idle 长档睡下去就是每 10 分钟只验几个点、而田只活 4h（真机实录整小时零动作）。
        if (!reEvalPending) {
          for (var fi = 0; fi < (row.families || []).length; fi++) {
            if (relic.staleCount(row.families[fi] | 0) > 0) {
              reEvalPending = true;
              break;
            }
          }
        }
      }
      continue;
    }
    var rec = await march.recall(e.marchId);
    if (!aliveFn()) return passUpgrades;
    if (!rec || !rec.ok) {
      // 904 未发出/被拒：不占单拍配额也不钉冷却，下拍重新判定（田未撤成，本行仍是原田）
      log.info(
        'upgrade recall rejected. row=%d marchId=%s code=%s',
        idx,
        e.marchId,
        rec && rec.code,
      );
      continue;
    }
    e.upgradedAt = Date.now();
    // 撤回成功即钉「待归队」：这支转返程后 856 不再把它算作占田，若不钉位下一拍就会把本行当缺位重派，
    // 而英雄尚未释放 → 撞 hero_mutually_exclusive_tip（真机踩过）。回城推送到来时由 releaseRecallSlot 放开。
    e.recalledAt = Date.now();
    persistLedger();
    passUpgrades++;
    // 日志带上两二维与最终 rank：换田只看 rank 严格大于，用户对照优先级时需要的就是这几个数
    log.info(
      'upgrade recall. row=%d %s(o%d/t%d/f%d r%d)->%s(o%d/t%d/f%d r%d) x=%d y=%d marchId=%s',
      idx,
      cur.kind,
      cur.level,
      cur.facility,
      cur.family,
      rankOf(cur),
      better.kind,
      better.level,
      better.facility,
      better.family,
      better.rank,
      e.x,
      e.y,
      e.marchId,
    );
  }
  return passUpgrades;
}

// ── 周期引擎（core/cycle 承载单飞闸门 + 触发合并 + 绝不停摆）──
/**
 * 单轮调和主体：账本读回 → cyclePass → 返回下拍间隔（毫秒；<=0=立即补扫）。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  if (!ledgerLoaded) {
    await loadLedger();
    if (!ledgerLoaded) return cfg.activeScanInterval; // 读回失败：下拍重试，不留紧密循环
  }
  await cyclePass();
  // 本拍机械田候选被自己行军占用的坐标，汇总成一行（逐点打会被「规则行 × 候选塔」乘性放大成刷屏）
  var held = tower.drainOccupiedSkipped();
  if (held.length)
    log.debug(
      'mech candidates skipped (occupied by my marches): %d [%s]',
      held.length,
      held.join(' '),
    );
  if (!aliveFn()) return cfg.idleScanInterval;
  var delay;
  if (rateLimitStreak > 0) {
    delay = Math.min(
      cfg.rateLimitBackoffMs * (1 << Math.min(rateLimitStreak - 1, 5)),
      cfg.rateLimitBackoffMaxMs,
    );
  } else if (cycle.pending) {
    return 0; // 本轮在飞期间来了外部触发 → 立即补扫一轮（合并语义）
  } else {
    // 缺位未补上（backlogActive）或抢田还有一堆没复验过的候选（reEvalPending）⇒ active 档；
    // 只看前者会把「有田可抢但额度没验完」误归为无事可做，白睡满 10 分钟（真机实录）。
    delay = backlogActive || reEvalPending ? cfg.activeScanInterval : cfg.idleScanInterval;
  }
  // 时段内也按下个边界主动择时：窗口止→立即撤田（不等 idle 长睡）、新窗口起→立即恢复下田
  if (windowActive()) {
    var edge = msToNextWindowEdge();
    if (edge > 0) delay = Math.max(cfg.windowSleepMinMs, Math.min(delay, edge));
  }
  // 驻留闸到点择时：把 idle 长睡截到「最早可重评换田」那一刻，否则改完勾选得等满 10min 兜底才生效。
  // 限流退避优先（提前醒只会再撞一次同一条码）；到点之后该行不再计入，自然回到 idle 档，不会形成紧密循环。
  var dwellIn = nextDwellReadyAt ? nextDwellReadyAt - Date.now() : 0;
  if (!rateLimitStreak && dwellIn > 0)
    delay = Math.max(cfg.windowSleepMinMs, Math.min(delay, dwellIn));
  return delay;
}

/** @type {{kick: function(), pending: boolean}} 派兵调和循环驱动器（fallback 取 active 档，防异常停摆） */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.activeScanInterval,
});

/** @type {{kick: function()}} 遗迹田扫图驱动器（与派兵 cycle 解耦：名额/限流不牵连扫图） */
const relicCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: relicScanRun,
  fallback: relic.MAIL_POLL_MS,
});

/** @type {{kick: function(), pending: boolean}} 机械田周期重扫驱动器（漏推自愈，不阻塞派兵） */
const towerCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: towerScanRun,
  fallback: tower.MECH_REFRESH_MS,
});

/**
 * 统一 kick 出口：起一轮前打一行 debug 交代触发缘由与「被掐掉的排程」。
 * createCycle 的 kick 在非在飞时会取消已排程的定时器立即起一轮，所以「说好睡 600s 却每秒一轮」
 * 这类现象只能靠缘由定位（wakeIn 表示若不 kick 还要睡多久，0 = 当时本就无排程）。
 * @param {{kick: function(), inFlight: boolean, wakeAt: number}} c 目标 cycle
 * @param {string} why 触发缘由（进日志）
 */
function kick(c, why) {
  var wakeIn = c.wakeAt ? Math.round((c.wakeAt - Date.now()) / 1000) : 0;
  log.debug(
    'kick: %s (%s).',
    why,
    c.inFlight
      ? 'in flight → pending'
      : wakeIn
        ? 'cutting sleep ' + wakeIn + 's'
        : 'no sleep armed',
  );
  c.kick();
}

/** @returns {Promise<number>} 遗迹扫图一拍（家族闸取当前面板勾了遗迹的行的全部家族） */
function relicScanRun() {
  var want = new Set();
  var rules = MCFG.rules || [];
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].kinds.indexOf(KIND.RELIC) < 0) continue;
    // 一行多族：本行勾的族都是“愿意为它们去扫”的，邮件家族不在并集内才省掉 5 窗高危 901
    for (var f = 0; f < (rules[i].families || []).length; f++) want.add(rules[i].families[f] | 0);
  }
  var before = relic.size();
  // 本轮进来时有待扫邮件（邮件驱动的一批）：扫完它就必须让派兵侧重评一次，不能只看池子有无变大
  var hadWork = relic.pendingCount() > 0;
  return Promise.resolve(relic.scanPass(want)).then(function (ms) {
    // 扫图与派兵是两个 cycle（901 名额/限流不牵连），但「扫出新田」得有人去采：
    // 派兵 cycle 此刻多半在睡 idle 长档（10min），不唤醒就成了「邮件收到了、田也扫出来了，却一动不动」
    //（真机踩过：21:00:45 扫出 180 点入池，下一次派兵判定却排在 21:05:48）。
    var after = relic.size();
    if (after > before) pushWake('relic pool grew (' + before + '→' + after + ')');
    if (hadWork && !relic.pendingCount()) {
      // 这批刷新邮件收尾（一封也没新增也要踢）：抢道/占田态势在扫图的十几秒里又变了，
      // 重评一轮才能把「扫到的田」立即变成「派出去的队」；批内已经踢过的多跑一轮成本仅一次 856 + 判定
      kick(cycle, 'relic scan batch done (mail queued, pool ' + before + '→' + after + ')');
    }
    return ms;
  });
}

/** @returns {Promise<number>} 机械田重扫一拍 */
function towerScanRun() {
  return tower.scanPass();
}

/**
 * 把「本拍只剩驻留闸未到的已占位行」折算成最早可重评换田的时刻（口径与 upgradePass 的驻留闸一致）。
 * 只有 dispatchedAt 已写且尚未到点的行才算——认领的孤儿田 dispatchedAt=0、本拍就能判，不需提前醒；
 * 该行本身不下田（空种类/空家族/时段不允）也不算，否则会为永不可换的行白醒一拍。
 * @param {Array<{preset:number, families:number[], kinds:string[]}>} rows 归一化规则行
 * @param {string[]} allow 全局允许种类
 * @param {number} now 当前墙钟（毫秒）
 * @returns {number} 最早到点时刻，0 = 无需提前醒
 */
function earliestDwellReady(rows, allow, now) {
  var dwell = cfg.upgradeMinDwellMs | 0;
  if (dwell <= 0) return 0;
  var soonest = 0;
  for (var i = 0; i < rows.length; i++) {
    if (!allowedKinds(rows[i], allow).length) continue;
    var entries = ledger[i] || [];
    for (var j = 0; j < entries.length; j++) {
      if (!entries[j].dispatchedAt) continue;
      var at = entries[j].dispatchedAt + dwell;
      if (at <= now) continue;
      if (!soonest || at < soonest) soonest = at;
    }
  }
  return soonest;
}

/**
 * 单轮周期主体：准入 → 时段闸（只撤不被允许的种类）→ 在途核对 → 缺位派兵 → 升级抢田。
 * 早退路径只置 backlogActive，两档重排由 cycleRun 统一决定（cycle 保证任何出口都会重排下一拍）。
 * @returns {Promise<void>}
 */
async function cyclePass() {
  if (!screen(getUid())) return; // 准入存活校验（每拍 O(1)）
  nextDwellReadyAt = 0; // 先清预告，下面的提前 return 分支不得留下上拍旧值
  reEvalPending = false; // 同上：抢田重评需求每拍重算，不拿上拍的旧候选结论驱动本轮排程
  var allow = globalAllowedKinds();
  outsideRemaining = 0;
  if (windowActive() && !inFarmWindow()) {
    // 时段外：只撤不被允许的种类（遗迹田永不撤，且缺位的遗迹行照常补下）；残留量并入末尾的 backlogActive 统一判定
    var cur = await fetchMyFarmMarches();
    if (!aliveFn()) return;
    outsideRemaining = await recallAllFarms(cur, allow);
  }

  var all = MCFG.rules || [];
  if (!all.length) {
    backlogActive = false;
    return;
  }
  var marches = await fetchMyFarmMarches();
  if (!aliveFn()) return;
  if (reconcileLedger(marches, all)) persistLedger();

  var taken = occupiedPointSet(marches);
  var missing = [];
  for (var i = 0; i < all.length; i++) {
    if (ledger[i] && ledger[i].length) continue;
    if (!allowedKinds(all[i], allow).length) continue; // 该行本轮不下田（空种类/时段不允）
    missing.push(i);
  }
  if (missing.length < all.length)
    log.debug('rows held by ledger (no dispatch): %s', describeLedgerHolds(marches, all));

  var dispatched = 0;
  if (missing.length) {
    if (march.freeSlots() > 0) dispatched = await dispatchRows(missing, allow, taken);
    else log.debug('no free march slot, wait for arrival wake. missing=%d', missing.length);
  }
  // 下拍节奏：还有缺位没派成，或时段外的不应保留田没撤净（904 已发但田位未释放）→ active 档。
  // 写成单一表达式而非两处赋值，否则撤田分支刚置的 true 会被本行直接覆盖成 idle 10min 档。
  backlogActive = missing.length > dispatched || outsideRemaining > 0;
  if (!aliveFn()) return;

  passUpgrades = 0;
  passProbes = 0;
  await upgradePass(allow, taken);
  // 预告算在派发与抢田之后：本拍刚派出去的行也要把自己的驻留到点排进睡眠，
  // 否则「本轮把缺位填满」会直接进 idle 长睡，新田到点却没人重评（正是改完勾选等 10min 的根因）。
  nextDwellReadyAt = earliestDwellReady(all, allow, Date.now());
}

// ── 推送入口 ────────────────────────────────────────────────────────
/**
 * 推送唤醒（去抖）：距上次补扫 < pushScanMinGap 则忽略，靠兜底定时收尾。
 * @param {string} why 唤醒缘由（进 kick 日志）
 */
function pushWake(why) {
  if (!aliveFn()) return;
  var wall = Date.now();
  if (wall - lastPushWakeAt < cfg.pushScanMinGap) return;
  lastPushWakeAt = wall;
  kick(cycle, why);
}

/**
 * 行军迁入采集态（10019 边沿 state=5 GATHERING）→ 给账本条目钉上「真开采过」的时刻。
 * 这个边沿是「空返」的唯一判据：只有派兵被受理、走到田上、并且服务器确认开始采集的行军才会点亮它；
 * 缺了它就无法区分「采满回家」与「到了才发现被人先占、一口未采空返」（后者不短解禁就成了每拍重撞同一块死田）。
 * @param {object} m 归一化 March
 */
function onFarmMarchGather(m) {
  if (!aliveFn()) return;
  var mt = (m && m.type) | 0;
  if (mt !== KIND_FARM && mt !== KIND_TOWER) return;
  var hit = findLedgerEntry(m && m.id);
  if (!hit || hit.entry.gatheredAt) return; // 已钉过：同一条行军的重复边沿不再写盘
  hit.entry.gatheredAt = Date.now();
  persistLedger();
  log.debug(
    'march entered gathering, ledger stamped. row=%d kind=%s x=%d y=%d',
    hit.rowIdx,
    hit.entry.kind,
    hit.entry.x | 0,
    hit.entry.y | 0,
  );
}

/**
 * 采集行军到家（march.onHomeReturn 复播）→ 该行缺位 → 唤醒补派。
 * 只认采集类行军回城；延迟 1.5s 给 HeroController 英雄释放推送落地的时间窗口（主防线见 dispatchRows 的英雄守卫）。
 * 遗迹田在此做「空返闭环」：到家却从未进过采集态 ⇒ 这块田有问题（被先占/存量为空），短解禁后立刻换下一块，
 * 而不是留着它在池里被下一拍重新选中（真机实录：21:02:13 派 (332,352)，≈63s 后一口未采空返）。
 * @param {object} m 归一化 March
 */
function onFarmMarchHome(m) {
  if (!aliveFn()) return;
  var mt = (m && m.type) | 0;
  if (mt !== KIND_FARM && mt !== KIND_TOWER) return;
  // 摘占位前先回查账本：releaseRecallSlot 会把条目 splice 掉，之后就找不到坐标了
  var hit = findLedgerEntry(m && m.id);
  // recalledAt 已钉位说明是我们主动撤的（时段外/升级换田），到家与田好坏无关，不得误解禁
  if (hit && hit.entry.kind === KIND.RELIC && !hit.entry.gatheredAt && !hit.entry.recalledAt) {
    relic.block(hit.entry.x | 0, hit.entry.y | 0, cfg.relicGatherFailMs);
    log.info(
      'relic home never gathered, point short-blocked. row=%d x=%d y=%d retry=%ds',
      hit.rowIdx,
      hit.entry.x | 0,
      hit.entry.y | 0,
      Math.round(cfg.relicGatherFailMs / 1000),
    );
  }
  // 撤回的那支到家 = 英雄真释放了，此刻摘掉「待归队」占位，该行才算真缺位（比等 856 缺席+超时快一大拍）
  releaseRecallSlot(m.id);
  ctxRef.setTimeout(function () {
    if (aliveFn()) pushWake('march home (id=' + ((m && m.id) || '?') + ')');
  }, 1500);
}

/**
 * 10452 联盟记录增量推送：新建成机械田即时并入活表；命中则唤醒补派（新田可能填补某行缺位）。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 */
function onAllianceRecordPush(ev) {
  if (!aliveFn()) return;
  if (tower.onRecordPush(ev)) pushWake('10452 alliance record push');
}

/**
 * 10264 单封邮件推送：命中「遗迹区域刷新」即入待扫队列并**立即**起一轮扫图。
 * 走统一的 kick() 出口而非裸 relicCycle.kick()：一是带「剪掉了多久排程」的诊断日志（事故回溯靠它），
 * 二是本链不经过 pushWake 的 4s 去抖——刷田批次只靠邮件驱动，被去抖吞一次就是白等 60s 轮询兜底。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 */
function onRelicMailPush(ev) {
  if (!aliveFn()) return;
  if (relic.onMailPush(ev)) kick(relicCycle, '10264 relic refresh mail');
}

// ── 生命周期 ────────────────────────────────────────────────────────
/**
 * 安装：取网络底座即可（行军/地图/表/邮件全部走 core 封装）。任一缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  if (!ctx.net || !ctx.net.install()) {
    log.warn('install failed. missing=pocketcc.net');
    return false;
  }
  net = ctx.net;
  var base = {
    net: ctx.net,
    alive: aliveFn,
    signal: function () {
      return ctxRef && ctxRef.signal;
    },
  };
  relic.install(base);
  tower.install(base);
  normal.install(ctx.net);
  // 机械田建造子引擎：共用 autoFarm 的 net/alive，并把「下田时段」闸以回调形式注入（时段外/停用一律 1032 取消在建）
  mechBuild.install({
    net: ctx.net,
    alive: aliveFn,
    signal: function () {
      return ctxRef && ctxRef.signal;
    },
    gate: {
      active: windowActive,
      isIn: inFarmWindow,
      msToStart: msToNextWindowStart,
    },
  });
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入：归一化 rules / 时段；行删减后作废越界账本；运行中即时唤醒让新规则生效。
 * @param {object} partial reactor 推送的面板配置
 * @returns {object} MCFG
 */
function configure(partial) {
  if (!partial) return MCFG;
  if (partial.rules != null) MCFG.rules = normalizeRules(partial.rules);
  // timeRanges 已由 toModuleCfg 归一为 {s,e} 分钟数，这里整体接收、绝不二次归一（防静默失效）
  MCFG.timeWindowEnabled = !!partial.timeWindowEnabled;
  MCFG.timeRanges = Array.isArray(partial.timeRanges) ? partial.timeRanges : [];
  mechBuild.configure(partial);
  if (ledgerLoaded) {
    var pruned = false;
    for (var key in ledger) {
      if (hasOwn(ledger, key) && !(+key >= 0 && +key < MCFG.rules.length)) {
        delete ledger[key];
        pruned = true;
      }
    }
    if (pruned) persistLedger();
  }
  if (installed && aliveFn()) {
    kick(cycle, 'configure (panel/storage push)');
    kick(relicCycle, 'configure (kind selection may change)'); // 种类勾选可能变了 → 立即重评扫图家族闸
  }
  return MCFG;
}

/**
 * 运行：复位全部内存态 → 挂 10019/10452/10264 监听 → 读回账本与两处盘上扫描结果后点火。
 * pause 后 alive()=false，三个 cycle 自然停摆；resume（场景/模式恢复）重新点火补扫。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  backlogActive = false;
  rateLimitStreak = 0;
  outsideRemaining = 0;
  lastPushWakeAt = 0;
  passUpgrades = 0;
  passProbes = 0;
  nextDwellReadyAt = 0;
  reEvalPending = false;
  ledgerLoaded = false;
  ledgerLoading = false;
  ledger = {};
  blacklist.clear();
  relic.reset();
  tower.reset();
  normal.reset();
  ctx.on.push(tower.CMD_PUSH_RECORD, onAllianceRecordPush);
  ctx.on.push(relic.CMD_PUSH_MAIL, onRelicMailPush);
  if (offHomeReturn) offHomeReturn(); // 先退再挂，防 resume 重激活重复注册
  offHomeReturn = march.onHomeReturn(onFarmMarchHome);
  if (offGatherEdge) offGatherEdge();
  offGatherEdge = march.onStateChange(onFarmMarchGather, { to: march.State.GATHERING });
  log.info(
    'started (rows=%d, window=%s).',
    MCFG.rules.length,
    MCFG.timeWindowEnabled ? 'on' : 'off',
  );
  // 两处盘上扫描结果先回填（刷新页免重扫高危 901、免等 1193），再点火各自的 cycle
  Promise.all([relic.load(), tower.load()]).then(function () {
    if (!aliveFn()) return;
    kick(relicCycle, 'run (store restored)');
    kick(towerCycle, 'run (store restored)');
    kick(cycle, 'run (store restored)');
  });
  // 机械田建造子引擎：复用宿主 ctx（ctx.on.push 退订由 reactor 在 pause 时统一 摘除），自带一个 cycle
  mechBuild.run(ctx);
  // 采集技能装载子引擎：10906 确认通道订阅同复用宿主 ctx；启动扫残留（台账 fill 项 + 快照 diff）
  // ——重启/换 UID/刷新页都会重新走 run，残留归还全覆盖；pause 期不补扫（半挂起态不发包，下个 run 周期接管）
  skillAttach.install(ctx);
  skillAttach.reconcile().catch(function (err) {
    log.warn('skill reconcile failed: %s', err && err.message);
  });
}

/**
 * 暂停钩子：三个 cycle 靠 alive 自然停；这里退订 feat 自挂的两条全局行军订阅（reactor 摘不到它们）。
 * @param {object} _ctx reactor 上下文
 */
function pause(_ctx) {
  if (offHomeReturn) {
    offHomeReturn();
    offHomeReturn = null;
  }
  if (offGatherEdge) {
    offGatherEdge();
    offGatherEdge = null;
  }
  mechBuild.pause(_ctx);
  skillAttach.pause(); // 放行在途 10906 waiter（订阅已由 reactor 摘除，别挂满超时）
}

/**
 * 田位规则字段选项（farmrules 控件的下拉数据源）：family 顺序按用户列举（金/粮/油/雷神）；
 * preset 1~16（1~8 战斗预设 / 9~16 采集预设，调 API 时拆回 index+type）。
 * @type {object}
 */
var RULE_OPTS = {
  // 展示序（金/粮/油/雷神）与取田同分次键（priority.FAMILY_RANK：雷神 > 石油 = 粮食 > 金矿）互不牵连
  familyOptions: [
    { value: 7, label: '金矿', short: '金' },
    { value: 5, label: '粮食', short: '粮' },
    { value: 1, label: '石油', short: '油' },
    { value: 16, label: '雷神', short: '雷' },
  ],
  presetOptions: (function () {
    var a = [];
    for (var n = 1; n <= 8; n++) a.push({ value: n, label: '战斗' + n });
    for (var g = 9; g <= 16; g++) a.push({ value: g, label: '采集' + (g - 8) });
    return a;
  })(),
};

reactor.register({
  id: 'autoFarm',
  label: '自动下田',
  storageKey: 'pocketcc.feat.autoFarm',
  symbols: [
    'dataCenter',
    'tableManager',
    'localManager',
    'tableName',
    'presetMarch',
    'heroController',
    'mechaController',
    'formationAdv',
    'marchStorage',
    'buffValue?', // 机械田建造子引擎的机械大师职业读数（软依赖：缺失时子引擎运行期 checkCap 自行 idle）
    'tableUtils?', // 子引擎读 DATACONFIG[11001] 建造等级门槛（软依赖：缺配按不设闸处理）
    'mailData?', // 遗迹扫图读邮件列表（软依赖：mailManager 由邮件 subpack 载入时挂上，未就绪则扫图 cycle 下拍重探）
  ],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  /**
   * @type {number} 配置版本：v2 起规则行由「资源匹配队伍」改为「队伍匹配资源」
   *（preset 单选 + families 多选 + kinds 多选）；v3 起规则行增加 skill 布尔位（采集技能装载）；
   * 当前存盘为 v2，无 _v 的更旧数据计 0。
   */
  version: 3,
  /**
   * 旧档迁移：v0/v1 每行的单值 family → v2 的 families 数组；v2 及以下行补 skill:false（缺省关，旧行为不变）。
   * 只做形状换算、行序与 preset 不动（账本 rowIdx 仍对齐，不会把别人的田钉到本行），
   * 也不替用户猜新意愿：原来几个族、勾了哪些种类，迁移后照旧。
   * @param {object} c 存量配置（已与 defaults 合并）
   * @param {number} from 存量版本号（无 _v 的旧数据为 0）
   * @returns {object} 迁移后配置
   */
  migrate: function (c, from) {
    var rules = Array.isArray(c.rules) ? c.rules : [];
    var out = rules.map(function (r) {
      var row = r || {};
      if (!Array.isArray(row.families)) {
        var fam = row.family | 0;
        // 旧档缺 family 时不能默认成金矿（那是 normalizeRules 旧版的兑底），否则 凭空多出一个族
        row = { preset: row.preset | 0 || 1, families: fam ? [fam] : [], kinds: row.kinds || [] };
      }
      if (row.skill == null) row.skill = false; // v3：技能装载位缺省关（旧行为不变）
      return row;
    });
    log.info('rules migrated to v%d (from v%d): %d row(s).', 3, from | 0, out.length);
    return Object.assign({}, c, { rules: out });
  },
  defaults: {
    enabled: false,
    rules: [],
    timeWindowEnabled: false,
    timeRanges: [],
    mechBuildEnabled: false,
    mechBuildFamilies: [],
  },
  fields: [
    {
      key: 'rules',
      label: '下田规则',
      type: 'farmrules',
      familyOptions: RULE_OPTS.familyOptions,
      presetOptions: RULE_OPTS.presetOptions,
      hint: '一行=一支队伍匹配资源：优先级 种类（遗迹>机械>普通）>家族（雷神>石油=粮食>金矿）>等级；发现更优会撤田换田，遗迹田站上后永不撤回。',
    },
    {
      key: 'mechBuildEnabled',
      label: '自动建造机械田（需机械大师）',
      type: 'checkbox',
      // 面板分段：本行与下行「建造家族」自成一块，靠 section 头的上边框与上下两块隔开
      section: '机械田自动建造',
      hint: '同族恒保 1 座；受下田时段控制，时段外/取消勾选会撤回在建塔（已建成保留）；建成立即撤回单兵。关掉整卡不会取消在建。',
    },
    {
      key: 'mechBuildFamilies',
      label: '建造家族',
      type: 'multiopts',
      options: familyOptions,
      showIf: function (c) {
        return !!c.mechBuildEnabled;
      },
      hint: '机械大师可选的资源家族；每族恒保 1 座，到期前自动补建。建造是联盟公共福利，与队伍配置互不牵连。',
    },
    {
      key: 'timeWindowEnabled',
      label: '启用下田时段',
      type: 'checkbox',
      // 面板分段：时段字段（启用 / 时段）自成一块，与上面的机械田块再分一刀
      section: '下田时段',
    },
    {
      key: 'timeRanges',
      label: '下田时段',
      type: 'timeranges',
      showIf: function (c) {
        return !!c.timeWindowEnabled;
      },
      hint: '仅在所列时段内下田；时段外撤回机械/普通田，遗迹田不受限。开始>结束视为跨午夜。',
    },
    {
      key: '_skillInfo',
      label: '队列技能',
      type: 'queueskills',
      // 面板分段：与「下田时段」再分一刀
      section: '队列技能',
      hint: '每支队伍出发瞬间实际装配的技能书；出发后书自动归还背包（不影响已生效收益），下一轮出发前自动重新装配',
      get: function (c) {
        return queueSkillData(c.rules);
      },
    },
  ],
  toModuleCfg: function (c) {
    return {
      rules: normalizeRules(c.rules),
      timeWindowEnabled: !!c.timeWindowEnabled,
      timeRanges: normalizeTimeRanges(c.timeRanges),
      mechBuildEnabled: !!c.mechBuildEnabled,
      mechBuildFamilies: normalizeMechFamilies(c.mechBuildFamilies),
    };
  },
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});

// 面板「归还技能组2」的执行方（farmrules 只发 bus 固定事件，core/ui 不反查 feat）。
// 模块级常驻而非 run 期挂：按钮的价值恰在 feat 未运行时清理残留（征用快照恒存盘，restoreSnapshots
// 自身按需 loadState，不依赖 reactor 生命周期）；多次点击幂等（快照清空后 no-op，只记 info）。
bus.on(EVT.FARM_SKILL_RESTORE, function () {
  skillAttach.restoreSnapshots().catch(function (err) {
    log.warn('skill restore failed: %s', err && err.message);
  });
});
