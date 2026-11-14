/**
 * 联盟集结-自动加入（reactor 说明书形态）
 *
 * 事件驱动，无轮询：服务器推 12003（PUSH_ALLIANCE_Assembly_Created）
 *   → 按 itemId 在「集结目标目录」里查行（战锤 44 / 惧星 9100 / 难民营 12 / 雷达集结怪 94·95 / …）
 *   → 启用 + 有余位 + 家族闸门过 + 全局行军未满 → 延迟后以最小部队发 1204 加入。
 *
 * 目标清单来源（表驱动 + 自学习，不再手写；面板行集与 cfg.targets 都由 catalog() 给出）：
 *   ① 表反查 buildTableRows()：auto_hunt ⨝ MONSTER_GROUP，入选口径逐项对齐游戏 MonthCardController.getAutoHuntMonsterList ——
 *      search_show===22（该 API 里 22 → 集结页签 searchType 3；实证命中 44 战锤、9100 惧星）、search_show===0 排除、
 *      表 switch 列走 gameData.functionOnValue 三态放行（列里存的是 FunctionKey 值串：warhammer_monster / glorious_science）、
 *      5001 混合集结排除（游戏自己也硬排除；且它加入走 Assembly_Mix_Join 并按队长兵种限兵，本 feat 未接）。
 *      难民营 12 的 search_show 是 0（游戏侧由 getRefugeeCampData() 单独挂在清单末尾），故同构地作为固定行恒在末尾。
 *   ② 12003 自学习 learnTarget()：推来未登记的 itemId → 记 {pointType, marchType, 情报时长, lastTs} 落 storage.data（UID 隔离），
 *      面板多一行「待勾选」，默认 enabled=false、绝不自动开打（关键安全阀）；但**行不是按 itemId 而是按 pointType 归并**
 *      （一族一行，键 'pt<pointType>'）：名字回落 MONSTER_GROUP.name 的译文，取不到用 '#<itemId>'；
 *      万一不同族撞同名，先试情报时长后缀（「·8小时」）、再退 '#<itemId>'。
 *      这条覆盖表反查抓不到的类型 —— 雷达集结怪 94/95：MONSTER_GROUP.search_show=0、auto_hunt 里没有行，服务器却天天推
 *     （1327 条 12003 语料里 94×60 / 95×25；两者的 name、pointType=74、marchType=8、level=100 四项全同，
 *      只有情报时长 8h/24h 与雷达任务号 10001/10002 可分），旧实现查不到行就 return 且不打日志＝静默丢弃；其 pointType 74=RADAR_RALLY_MONSTER
 *      落在游戏 AllianceAssemlbyController.joinAssemlby 的默认分支（无条件加入），故学到即可直接发 1204。
 *      学习的红线（tableGatedGroups）只圈「本该进集结页签却被闸门明确关掉」的 group（赛季 switch=false、CATALOG_EXCLUDE），
 *      否则一条推送就能把明确关掉的玩法复活成行，而它的 key 撞上历史键（44→warHammer）时还会直接继承已勾选的 warHammerEnabled=true。
 *      红线不得扩成「表认识即不许学」（历史版本正是这个扩法把 94/95 又挡回了门外）。
 *      且闸门与目录行源必须基于同一次反查：推送判定前先 ensureTableConsulted()，免得拿着早期回落留下的 null 放行、
 *      紧接着的重建却用刚填好的集合把它筛掉（日志吹牛、面板没行）；学习成功却取不到行 → warn 报不变量破坏，不播假成功。
 *   ③ 表不可读（auto_hunt/MONSTER_GROUP 取不到，或一行都没反查中）→ 整体回落 ROW_SEEDS（= 历史手写清单 44/9100/12），行为零变化。
 *      回落必有日志（首遇 warn、后续 debug，均带 tableFallbackReason），缓存只用 CATALOG_RETRY_MS 短 TTL：
 *      探表失败多半是加载时序（TableManager 在 Script bundle，probe 失败不入缓存、下次自愈），不该被 30s 钉住；
 *      控制台核漂移用 pocketcc.gameApi.probeStatus() / reprobe('TableManager.TABLE')，不必刷页。
 *      成功路径也留痕：首次反查到表行时打一条 info（rows/seed 行数），否则日志只剩「回落」一种信号，面板上到底是动态行还是种子行无法回答。
 *   「减少」不用人工清理：学习项连续 LEARN_STALE_MS 没再被推到就自动出目录（配置键留在盘上但不生效，再见到即恢复）。
 *
 * 加入前的家族闸门（判据收在 FAMILY_GATES 这张数据表里：pointType → 前置检查，新增一族只加一行数据；逐条对齐游戏 AllianceAssemlbyController.joinAssemlby 的 if-else 链，身份取当次推送自带的 pointType）：
 *   pointType 缺失 / 1 玩家城市 / 15 世界遗迹 / 41~49 KVK 建筑 → 游戏走「查目标护盾 + 二次确认弹窗」的 PVP 链路，
 *     玩家亲自点过确认是其语义前提，自动加入不在本 feat 口径内 → 拒绝（学习阶段也不登记，免得面板堆无意义行）；
 *   pointType 79 混合集结 → 加入报文是 Assembly_Mix_Join 且 allowArmyTypes 受队长兵种约束，报文形态不同 → 拒绝；
 *   pointType 12 战锤 → 账号等级须 ≥ data_config 950008（游戏 ShowTips 100273），读数不可得则放行；
 *   pointType 86 惧星 → 须持有 buff 941222 且 Value≠0（游戏缺则 tips thor_monster_cant_assembly；我们原先裸发，只拿得到服务器拒绝）；
 *   其余（含 74 雷达集结怪、18 难民营）→ 无条件加入。难民营的 1026 GET_JION_ALL_RCTIME 前置（游戏查 num 空才加）未复刻：
 *     那要为每次加入多烧一个只读包，现状「服务器拒 + info 日志」已够收敛，列为边界。
 *   另补两条游戏有、我们没有的闸：marchState 须为 INIT=0（还在召集态）；成员数须 < data_config 上限（8005 普通集结 /
 *     61057 超级集结 —— rallyCapacity 是容量墙，真实上限才是这个配置；实证见过 rallySize=130 而容量 260 的集结）。读数不可得一律放行。
 *   以及集结类玩法 inherently 需在盟：游戏 getAutoHuntMonsterList 对 searchType>=3 有 !isInAlliance() 即不列，这里同口径跳过（三态，读不到放行）。
 *
 * 报文与其余口径：
 *   12003 载荷（语料实证字段）{teamId, itemId, pointType, marchType, marchState, rallyCapacity, rallySize, members[], expireTime,
 *     leaderUid, leaderName, targetPos, leaderPos, level, waitTime, …}；marchType 8=ALLIANCE_RALLY_BATTLE、
 *     10=ALLIANCE_SUPER_RALLY_BATTLE（两者都用 1204 加入，只是成员上限取不同 data_config），9=ALLIANCE_RALLY_ASSEMBLY 是加入请求自己的 marchType。
 *   行军闸门（同竞对 canMarch 口径）：UserData.myMarchNumMAX - myMarchNum >= 1。
 *   去重与过期：快照池（createSnapshotPool）键控去重防同一集结重复加入，expireTime 到点惰性剔除；
 *     joinDelayMs 错峰是池内 wake.at，pause 清定时器保留条目、resume 重排续跑。
 *   每目标可配每日参与上限（0=无限），跨日自动清零，持久化到 pocketcc.feat.allianceRally.daily。
 *   延迟期内 reactor pause → 托管定时器被清、池条目保留，resume 重排续跑；信号包络只存标量。
 */
import { todayStr, rejectText } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { gameConf, gameData, l10n } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { storage } from '../../core/storage.js';
import { bus, EVT } from '../../core/bus.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { createSnapshotPool } from '../../core/snapshot-pool.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ALLIANCE_RALLY） */
const log = createLog('ALLIANCE_RALLY');

/** @type {number} ResponseId.PUSH_ALLIANCE_Assembly_Created，联盟集结创建推送 */
const CMD_PUSH_ASSEMBLY_CREATED = 12003;

/** @type {number} RequestId.ALLIANCE_Assembly_Join，加入集结请求 */
const CMD_ASSEMBLY_JOIN = 1204;

/** @type {number} MarchType.ALLIANCE_RALLY_BATTLE，集结主行军类型（普通集结） */
const MARCH_TYPE_RALLY = 8;

/** @type {number} MarchType.ALLIANCE_SUPER_RALLY_BATTLE，超级集结（同走 1204 加入，只换成员上限的 data_config） */
const MARCH_TYPE_SUPER_RALLY = 10;

/** @type {number} MarchType.ALLIANCE_RALLY_ASSEMBLY，加入集结请求的 marchType */
const MARCH_TYPE_JOIN = 9;

/**
 * @type {Object<number,number>} 可加入的集结 marchType → 该形态的成员数上限配置（data_config id）。
 *   8 普通集结、10 超级集结都走同一条 1204 加入报文，游戏侧只在「取哪个上限」上分叉（joinAssemlby 的 c=8005/61057 分支）；
 *   其余 marchType（含 15 混合集结的 ALLIANCE_RALLY_MIX_BATTLE）加入报文不同，不在本 feat 口径内。
 */
const JOINABLE_MARCH_TYPES = { [MARCH_TYPE_RALLY]: 8005, [MARCH_TYPE_SUPER_RALLY]: 61057 };

/** @type {number} MarchState.INIT：还在召集态才能加（游戏 joinAssemlby 的第一道闸） */
const MARCH_STATE_INIT = 0;

// ── WorldMapEntityType（游戏 WorldMapCommon 枚举的实证值）：家族闸门的判据身份 ────────────
/** @type {number} 玩家城市（PVP 集结，需护盾查询 + 二次确认） */
const PT_CITY = 1;
/** @type {number} 战锤集结怪 */
const PT_RALLY_BOSS = 12;
/** @type {number} 世界遗迹（PVP 集结） */
const PT_WORLD_SITE = 15;
/** @type {number} 难民营 */
const PT_REFUGEE_CAMP = 18;
/** @type {number} KVK 建筑家族的 pointType 区间（含端点），全是 PVP 集结 */
const PT_KVK_FROM = 41;
const PT_KVK_TO = 49;
// 雷达集结怪 = 74（RADAR_RALLY_MONSTER）、不属于任何被拦的族，走 familyReject 的默认放行分支（与游戏同构）：故这里不声明常量，
//   避免「只对某个已知类型特殊照应」的假象——它靠的是「不列进黑名单」而非「列进白名单」，新集结类型开箱即用。
/** @type {number} 混合集结（加入报文 Assembly_Mix_Join + 限兵种，本 feat 未接） */
const PT_MIX_BOSS = 79;
/** @type {number} 惧星（须持有 buff 941222 才能加） */
const PT_THOR = 86;
/** @type {number} 普通世界 BOSS（WorldMapEntityType.Boss=11，行军走 ATTACK_WORLDBOSS=14，非集结目标） */
const PT_WORLD_BOSS = 11;
/** @type {number} 战争之源 BOSS（NWorldMapEntityType.BOSS_V2=298，行军走 ATTACK_WORLD_BOSS_V2=298，非集结目标） */
const PT_BOSS_V2 = 298;

/** @type {number} data_config 950008：战锤集结的参战账号等级下限（游戏 ShowTips 100273） */
const CFG_RALLY_MIN_LEVEL = 950008;
/** @type {number} buff 941222：惧星参战必需的「雷神科学」buff（缺则游戏直接 tips） */
const BUFF_THOR_ASSEMBLY = 941222;

/**
 * 集结目标·兜底种子（**只在游戏本地表不可读时顶上**，与历史手写注册表 RALLY_TARGETS 逐项等值；正常运行时的目录由 catalog() 反查 + 自学习得出）。
 * 存在的意义是「刷表当天/符号缺失时行为零变化」，不是清单真相源 —— 新增/下线集结目标请勿来这里改行。
 * key 决定面板字段前缀（xxxEnabled / xxxDelaySec / xxxDailyLimit）与当日计数键，itemId 是 12003 载荷的怪物 species（= MONSTER_GROUP 行 id）；
 *   pointType 只用于日志（加入前的家族闸门一律以当次推送自带的 pointType 为准，那个值每次都带、且权威）。
 * @type {Array<{key:string, label:string, itemId:number, pointType:number}>}
 */
const ROW_REFUGEE_CAMP = {
  key: 'refugeeCamp',
  label: '难民营',
  itemId: 12,
  pointType: PT_REFUGEE_CAMP,
};
const ROW_SEEDS = [
  { key: 'warHammer', label: '战锤', itemId: 44, pointType: PT_RALLY_BOSS }, // 战锤-4000
  { key: 'fearStar', label: '惧星', itemId: 9100, pointType: PT_THOR }, // 惧星-4000
  ROW_REFUGEE_CAMP,
];

/** @type {string} 当日参与计数持久态的数据 blob 逻辑名（与配置分离：频繁写入走 storage.data，面板导出/导入只涉及配置）*/
const DAILY_STATE_NAME = 'allianceRally.daily';

// ── 集结目标目录（表反查 + 12003 自学习） ────────────────────────────
/** @type {string} 自学习目标持久态的数据 blob 逻辑名 */
const TARGETS_STATE_NAME = 'allianceRally.targets';

/**
 * @type {number} 目录缓存有效期（毫秒）：面板渲染与逐次推送共用一份，过期才重读表/开关。
 *   本 feat 无周期循环（事件驱动），这个 TTL 同时是给面板的「新行出现延迟」上限。
 */
const CATALOG_TTL_MS = 1000 * 30;

/**
 * @type {number} 回落态（拿不到表反查结果）的缓存有效期（毫秒）：只用短 TTL，避开「加载时序性探表失败」
 *   被 30s 缓存钉住（面板少行、自学习没有表全集闸），下一拍就重试回表反查。
 */
const CATALOG_RETRY_MS = 1000 * 5;

/**
 * @type {number} 学习项的陈旧判据（毫秒）：连续这么久没再被 12003 推到就从目录逐出，避免活动结束后的类型堆在面板里。
 *   只逐出目录、不删持久态（下次被推到自动回来），也不动用户配置（那些键留在盘上但不再生效）。
 */
const LEARN_STALE_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * @type {Object<number,string>} itemId → 语义 key（历史手写清单沿用的键）。命中者用旧键，使已存配置（xxxEnabled 等）与
 *   当日计数（allianceRally.daily.counts）无需迁移；表里新增的 itemId 用 'm<itemId>'。
 */
const CATALOG_KEYS = { 44: 'warHammer', 9100: 'fearStar', 12: 'refugeeCamp' };

/**
 * @type {Object<number,string>} itemId → 面板标签覆盖。表里 name 列是 monster_name005 这类语言键，直译过来可能叫「野人BOSS」，
 *   与面板上的习惯叫法不一致，故已知目标固定用旧名；新 itemId 走表名译文。
 */
const CATALOG_LABELS = { 44: '战锤', 9100: '惧星' };

/**
 * @type {number[]} 表反查显式排除的 group：12 难民营（走 ROW_REFUGEE_CAMP 固定行，它在表里 search_show=0）、
 *   5001 混合集结（游戏 getAutoHuntMonsterList 自己也硬排除，且加入报文不同）。
 */
const CATALOG_EXCLUDE = [12, 5001];

/** @type {number} MONSTER_GROUP.search_show=22 → 游戏打野面板的「集结」页签（searchType 3），本 feat 的入选判据 */
const SS_RALLY = 22;

/** @type {{rows:object[],at:number,fellBack:boolean}|null} 目录缓存：rows=面板行集（唯一行源）、at=构建时刻、fellBack=本次是否为回落态 */
var catalogCache = null;

/**
 * @type {string} 本轮表反查回落的原因（'ok'=反查成功）；只进日志，供「为什么面板只有种子行」可诊断。
 */
var tableFallbackReason = 'never built';
/** @type {boolean} 「目录回落」是否已播报过（同一页面只提一次 warn，后续逐次回落只留 debug） */
var fallbackAnnounced = false;
/** @type {boolean} 「目录来自游戏表」是否已播报过（同一页面只提一次 info：面板多次渲染不重刷这条） */
var tableAnnounced = false;

/**
 * @type {Set<number>|null} 最近一次成功反查里「本该进集结页签却被闸门明确关掉」的 group（功能开关 switch=false、或在
 *   CATALOG_EXCLUDE 里）；表不可读 / 未反查过时为 null。自学习只对这一类划红线：它们是「赛季明确关了」的目标，
 *   被推送复活会带着用户已勾的历史键（44→warHammer）绕过开关去发包。
 * ⚠ 红线不得扩成「表认识即不许学」：像雷达集结怪 94/95（在 auto_hunt 有行但 search_show≠22、根本不在集结页签）
 *   正是「表口径之外、但服务器确实在推的集结」，一律拒学到底等于把改造前的「静默丢弃」换个形式保留下来。
 */
var tableGatedGroups = null;
/** @type {Object<string,{pt:number,mt:number,ts:number,lf:number}>} 自学习条目（键=itemId 字符串；lf=情报存续秒数），由 targetsState 读回、learnTarget 新增 */
var learnedTargets = {};
/** @type {boolean} 学习项是否已读回（未读回前不新增、不落盘，防拿内存空表覆掉盘上已学项） */
var targetsLoaded = false;
/** @type {boolean} 学习项落盘单飞闸门 */
var targetsSaving = false;
/** @type {boolean} 「目标未登记已当作候选学习」是否已播报过（同一 itemId 只提一次，免得逐次推屏） */
var learnAnnounced = {};

/**
 * MONSTER_GROUP.name → 面板标签：先走 l10n.text（对语言键出译文，返回值≠传入键即命中），
 *   再按「含中日韩字符」认明文（实证该列既有 monster_name005 / radar_key_149 这类键，也有明文），两者都拿不到用 '#<itemId>'。
 * @param {object} mg MONSTER_GROUP 行
 * @param {number} itemId 怪物 species（= 12003 itemId）
 * @returns {string}
 */
function rowLabel(mg, itemId) {
  var k = String((mg && mg.name) || '').trim();
  if (k) {
    var t = l10n.text(k);
    // 游戏侧缺译文时 LOCAL 会给回占位符（'?' / '???'），这种值在面板上等于没名字：当没拿到，继续往下走 '#<itemId>'
    if (t && t !== k && !/^[?\s]+$/.test(t)) return t;
    if (/[\u3400-\u9fff]/.test(k)) return k;
  }
  return '#' + itemId;
}

/**
 * 12003 载荷里的「情报存续时长」（秒）= expireTime - createTime。报文实证：94 恒 ≈28798s（8 小时）、95 恒 ≈86393s（24 小时），
 *   而两者的 MONSTER_GROUP.name、pointType、marchType、level 完全一致 —— 这是目录里唯一能把它们分开的可用信息。
 * 只在两个时刻都读得出、且时长落在 (0, 7 天] 时采信，否则返回 0（=未知，同名消歧会退回 '#<itemId>'）。
 * @param {object} d 12003 载荷
 * @returns {number} 时长秒数，未知为 0
 */
function intelLifeSec(d) {
  var sec = (Number(d.expireTime) || 0) - (Number(d.createTime) || 0);
  return sec > 0 && sec <= 7 * 24 * 3600 ? Math.round(sec) : 0;
}

/**
 * 表反查集结页签目标：auto_hunt ⨝ MONSTER_GROUP，入选闸门逐项对齐游戏 MonthCardController.getAutoHuntMonsterList（不调该 API、只读表自己套闸）。
 * 不复刻的分支（遇到时表现为「该怪不列」而非误列，是诚实边界）：
 *   KVK 赛季（游戏改走 search_show_kvk + KVKTools.judgeMonsterShow，黑暗精卫 9002/9022/9024/9202 等变体只在该态出现，且依赖八国 EC 配置 130137）；
 *   活动砰砰 group 6（需 ActivityController.getLimitHammerBossExchangeActivityId('4') 命中活动）；CQ26 临时禁用态（handleCQ26AutoHuntMonster 会把行改成野怪页签）。
 * @returns {object[]|null} ROW_SEEDS 同构行数组；auto_hunt/MONSTER_GROUP 不可读或一行都没反查中时返回 null（调用方回落种子）
 */
function buildTableRows() {
  tableGatedGroups = null; // 本轮结论只在成功反查时生效，失败路径一律留 null（表不可读时不拿陈旧集合卡住学习）
  var ahRows;
  try {
    ahRows = l10n.tableRows('auto_hunt');
  } catch (e) {
    tableFallbackReason = 'auto_hunt read threw: ' + ((e && e.message) || e);
    return null;
  }
  if (!Array.isArray(ahRows) || !ahRows.length) {
    // TableManager.TABLE 单例不可用时 l10n.tableRows 也回 []（两者在本日志里同口径）
    tableFallbackReason = 'auto_hunt empty or TABLE singleton unavailable';
    return null;
  }
  var rows = [];
  var gated = new Set(); // 表认识但被闸门明确关掉的 group（学习红线，见 tableGatedGroups）
  var mgHit = 0;
  for (var i = 0; i < ahRows.length; i++) {
    var ah = ahRows[i];
    var itemId = Number(ah && ah.monster_group);
    if (!(itemId > 0)) continue;
    if (CATALOG_EXCLUDE.indexOf(itemId) >= 0) {
      gated.add(itemId); // 12 难民营走专用固定行、5001 混合集结报文不同：都不许被推送复活成普通行
      continue;
    }
    var mg = l10n.tableRow('MONSTER_GROUP', itemId);
    if (!mg) continue;
    mgHit++;
    if (Number(mg.search_show) !== SS_RALLY) continue; // 0/其他形态不列（与游戏同口径：11/12/21/-1 都不是集结页签）
    if (mg.switch && gameData.functionOnValue(String(mg.switch)) === false) {
      gated.add(itemId); // 赛季开关明确关了：不许推送复活（带已勾选的历史键会绕过开关发包）
      continue;
    } // 读不到（null）则放行，防误删现役行
    rows.push({
      key: CATALOG_KEYS[itemId] || 'm' + itemId,
      label: CATALOG_LABELS[itemId] || rowLabel(mg, itemId),
      itemId: itemId,
      pointType: 0, // 表里没有 pointType（该列在 MONSTER_GROUP 上不存在）；只从推送取，此处置 0 仅作日志占位
      searchOrder: Number(mg.search_order) || 0,
    });
  }
  if (!mgHit) {
    tableFallbackReason =
      'auto_hunt has ' + ahRows.length + ' rows but monster_group matched none (table name drift?)';
    return null; // auto_hunt 有行但 MONSTER_GROUP 一行都反查不到 = 表未真正就绪，回落种子
  }
  tableFallbackReason = 'ok';
  tableGatedGroups = gated; // 到这里才公布集合：只包含「被闸门明确关掉」的 group（不在集结页签的 group 不进集合，可以学）
  // 排序照游戏集结页签：search_order 升 → itemId 升（难民营与学习项随后追加，不参与排序）
  rows.sort(function (a, b) {
    return a.searchOrder - b.searchOrder || a.itemId - b.itemId;
  });
  return rows;
}

/**
 * 战锤家族的专属前置：参战账号等级须达 data_config 950008（游戏 ShowTips 100273）。
 * 两个读数任一拿不到（回 0）就放行：把「读不到」当「不合格」会误停整类现役行为。
 * @returns {string} ''=放行；非空=拒因
 */
function rallyMinLevelReject() {
  var minLv = Number(gameConf.dataConfig(CFG_RALLY_MIN_LEVEL));
  var lv = gameData.level();
  return minLv > 0 && lv > 0 && lv < minLv ? '等级<' + minLv + '不可参战锤' : '';
}

/**
 * 惧星家族的专属前置：须持有 buff 941222 且 Value≠0（游戏缺则直接 tips thor_monster_cant_assembly）。
 * 只认 buffPresentById 的**假**值（三态里的 null=符号漂移/未就绪 → 放行，不然会误停加入）。
 * @returns {string} ''=放行；非空=拒因
 */
function thorBuffReject() {
  return gameData.buffPresentById(BUFF_THOR_ASSEMBLY) === false ? '缺惧星 buff' : '';
}

/**
 * 家族闸门表（pointType → 前置检查）：逐条对应游戏 AllianceAssemlbyController.joinAssemlby 的 if-else 链。
 * 新增一族「不该自动加入」的集结 = 这里加一行数据，不在 familyReject 里堆分支（表驱动的本意）。
 * 条目形状：`{ pt }` 或 `{ from, to }`（闭区间）定位该族；`always`=固定拒因（无前置读数可翻盘，游戏走了另一条链路），
 *   `check`=带前置的族（返回非空串即拒，理由自带动态数值）。两者都无 = 命中也不拒（仅占位，当前无此用法）。
 * 未命中任何条目 = 无条件加入（与游戏 joinAssemlby 的默认分支同构：雷达集结怪 74、难民营 18 等新类型开箱即用）。
 * @type {Array<{pt?:number, from?:number, to?:number, always?:string, check?:function():string}>}
 */
const FAMILY_GATES = [
  // PVP 族：游戏要先查目标护盾 + 弹二次确认（玩家亲自点过确认是其语义前提），自动加入不在本 feat 口径内
  { pt: PT_CITY, always: 'PVP 集结' },
  { pt: PT_WORLD_SITE, always: 'PVP 集结' },
  { from: PT_KVK_FROM, to: PT_KVK_TO, always: 'KVK 建筑 PVP 集结' },
  // 混合集结：加入报文是 Assembly_Mix_Join 且 allowArmyTypes 受队长兵种约束，报文形态不同
  { pt: PT_MIX_BOSS, always: '混合集结需 Assembly_Mix_Join' },
  // 世界 BOSS（一期/二期）：临时活动实体，走独立行军类型（14/298）攻打，非日常集结目标；
  //   即使有人用普通集结报文（marchType=8）发起对它的集结，也不应学习/自动加入（有专属 feat 管理）
  { pt: PT_WORLD_BOSS, always: '世界 BOSS 非集结目标' },
  { pt: PT_BOSS_V2, always: '世界 BOSS V2（战争之源）非集结目标' },
  { pt: PT_RALLY_BOSS, check: rallyMinLevelReject },
  { pt: PT_THOR, check: thorBuffReject },
];

/**
 * 家族闸门：该 pointType 能否自动加入。返回拒绝原因串（空串=放行）。
 * 判据全部取自 FAMILY_GATES 这张数据表（口径逐条对齐游戏 joinAssemlby），本函数只做分派不再写分支。
 * @param {number} pointType 12003 载荷自带的世界点类型
 * @returns {string} ''=可加入；非空=拒绝原因（进日志）
 */
function familyReject(pointType) {
  var pt = Number(pointType);
  if (!(pt > 0)) return '无 pointType（游戏走玩家城市 PVP 链路）';
  for (var i = 0; i < FAMILY_GATES.length; i++) {
    var g = FAMILY_GATES[i];
    var hit = g.pt != null ? g.pt === pt : pt >= g.from && pt <= g.to;
    if (!hit) continue;
    if (g.always) return g.always + ' pt' + pt;
    if (g.check) {
      var why = g.check();
      if (why) return why;
    }
  }
  return '';
}

/**
 * 拼装目录：表反查行（不可读则种子行）→ 末尾附难民营固定行 → 再附未陈旧的自学习行（排除已占用的 itemId）
 *   → 学习行按 pointType 归并成「一族一行」。返回恒非空；行携 key/label/itemId/itemIds/pointType/learned。
 *   回落态只缓 CATALOG_RETRY_MS，下一拍就重试回表反查。
 * @returns {{rows:object[],at:number,fellBack:boolean}}
 */
function catalog() {
  var now = Date.now();
  var ttl = catalogCache && catalogCache.fellBack ? CATALOG_RETRY_MS : CATALOG_TTL_MS;
  if (catalogCache && now - catalogCache.at < ttl) return catalogCache;
  var rows = buildTableRows();
  var fellBack = !rows;
  if (fellBack) {
    // 表不可读这一路必有日志（保证日志流单轨可还原「为什么面板只有种子行」）；但只在读数面已就绪时 warn，
    //   bundle 未加载那一拍（面板先于 install 渲染）回退属加载时序，会自愈，不是符号漂移。
    log.debug('rally catalog fell back to seed rows. reason=%s', tableFallbackReason);
    if (!fallbackAnnounced && l10n.tableReady()) {
      fallbackAnnounced = true;
      log.warn(
        'rally target table unreadable, panel shows seed rows until it reads ok. reason=%s',
        tableFallbackReason,
      );
    }
    rows = ROW_SEEDS.map(function (r) {
      return {
        key: r.key,
        label: r.label,
        itemId: r.itemId,
        pointType: r.pointType,
        searchOrder: 0,
        learned: false,
      };
    });
  } else {
    if (!tableAnnounced) {
      // 与 auto-hunt 同理：成功路径也得留一条凭据，否则日志只剩「回落」一种信号，面板上到底是动态行还是种子行无法回答
      //   （表行与种子行内容相近时肉眼看不出差别；rows 与 seed 不等或改版新增目标时这条是唯一证据）。
      tableAnnounced = true;
      log.info(
        'rally target catalog built from game table. rows=%d (seed rows=%d, same set is expected).',
        rows.length,
        ROW_SEEDS.length,
      );
    }
    for (var i = 0; i < rows.length; i++) rows[i].learned = false;
    var refugeeIn = rows.some(function (r) {
      return r.itemId === ROW_REFUGEE_CAMP.itemId;
    });
    if (!refugeeIn)
      rows.push({
        key: ROW_REFUGEE_CAMP.key,
        label: ROW_REFUGEE_CAMP.label,
        itemId: ROW_REFUGEE_CAMP.itemId,
        pointType: ROW_REFUGEE_CAMP.pointType,
        searchOrder: 0,
        learned: false,
      });
  }
  var ids = {};
  for (var a = 0; a < rows.length; a++) ids[String(rows[a].itemId)] = 1;
  var learnedKeys = Object.keys(learnedTargets).sort(function (x, y) {
    return (Number(x) | 0) - (Number(y) | 0);
  });
  for (var b = 0; b < learnedKeys.length; b++) {
    var ik = learnedKeys[b];
    if (ids[ik]) continue; // 表行已占该 itemId（携带的 key/标签更稳定），学习项只补位不覆盖
    if (tableGatedGroups && tableGatedGroups.has(Number(ik))) continue; // 盘上陈旧学习项不得绕过赛季开关（表反查结论优先于历史推送）
    var e = learnedTargets[ik];
    // 陈旧判定按 epoch 毫秒原值做，绝不写 `e.ts | 0`：`| 0` 是 ToInt32 截断，而 Date.now() ≈ 1.79e12 早已越界，
    //   截断后绕成负数（实证 1793844355653|0 = -1451974075），于是 now - ts 恒 ≥ 30 天 → 所有学习项都被当陈旧筛掉，
    //   表现即「learnTarget 返回 true 但 rowOfItem 取不到行」（面板也就永远多不出那一行）。
    if (!e || now - (Number(e.ts) || 0) >= LEARN_STALE_MS) continue;
    if (familyReject(e.pt)) continue; // 家族闸门拒绝的 pointType 不列（防御性：修前学的世界 BOSS 等陈旧项自动消失）
    var mg;
    try {
      mg = l10n.tableRow('MONSTER_GROUP', Number(ik));
    } catch (err) {
      mg = null;
    }
    rows.push({
      key: CATALOG_KEYS[ik] || 'm' + ik,
      label: CATALOG_LABELS[ik] || rowLabel(mg, Number(ik)),
      itemId: Number(ik) | 0,
      itemIds: [Number(ik) | 0], // 成员全集：面板×删除按键要删全归并前学到的每一只（同族其余成员 append 到这里）
      pointType: e.pt | 0,
      hours: Math.round((Number(e.lf) || 0) / 3600), // 情报时长（小时）：同名行消歧用；表行没这个信息 → 0
      searchOrder: 0,
      learned: true,
    });
  }
  // 学习行按 pointType 归并成「一族一行」：本 feat 的族身份就是 pointType（与 FAMILY_GATES/familyReject 同口径）。
  //   报文实证 94/95 的 MONSTER_GROUP.name、pointType(74)、marchType(8)、level(100) 四项全同，只有情报时长（8h/24h）
  //   与雷达任务号（10001/10002）不同 —— 拆两行等于让玩家对两个无法辨认的名字各做一次决定，且赛季每新增一只同族怪就多一行。
  //   表反查行不参与归并（各有 switch/页签语义与历史扁平键）；学习项落盘仍按 itemId（30 天续期逐只怪算，归并只发生在读侧）。
  //   归并行的 key 换成 'pt<pointType>'，旧 'm<itemId>' 那组扁平键不再被行读取；用户的已勾状态由 toModuleCfg 一次性继承
  //   （enabled 取或、延迟取首个非零、上限取合计），且只在新键从未被决定过时继承 —— 详见那里的注释。
  var out = [];
  var ptRow = Object.create(null); // pointType → 该族的归并行（即首个成员那张行对象）
  for (var f = 0; f < rows.length; f++) {
    var fr = rows[f];
    if (!fr.learned || !(fr.pointType > 0)) {
      out.push(fr); // 表行/种子行/拿不到 pointType 的行：原样保留
      continue;
    }
    var fam = ptRow[fr.pointType];
    if (fam) {
      fam.itemIds.push(fr.itemId);
      if (fam.labels.indexOf(fr.label) < 0) fam.labels.push(fr.label);
      continue; // 被吸收的同族不再单列
    }
    fr.itemIds = [fr.itemId];
    fr.labels = [fr.label];
    ptRow[fr.pointType] = fr;
    out.push(fr); // 归并行落在该族首个成员的位置上
  }
  Object.keys(ptRow).forEach(function (pt) {
    var r = ptRow[pt];
    if (r.itemIds.length < 2) return; // 独苗不改键，免得为归并而把已有勾选抖没
    r.itemIds.sort(function (x, y) {
      return x - y;
    });
    r.key = 'pt' + r.pointType;
    r.label = r.labels.join('/'); // 同族不同名（改版可能出现）就把名字并列，不藏任何一个
    r.itemId = r.itemIds[0]; // 代表 itemId：只供排序/日志；推送匹配走 itemIds 全集（见 rowOfItem）
    r.hours = 0; // 一族里时长不止一种，'·N小时' 后缀会误导
  });
  rows = out;
  // 同名行消歧（归并后仍可能撞名：表行与学习行、或不同 pointType 却同名）：
  //   先试「情报时长」——只有同组每行都带时长且互不相同才采纳（后缀成「黑暗军团据点·8小时 / ·24小时」）；
  //   否则整组一律退回 '#<itemId>'（itemId 是目录里唯一稳定身份），不发「一行带时长、一行光秃」的混排。
  var groups = Object.create(null); // 标签是表里的自由文本（'constructor' 之类会撞上原型链），无原型字典才安全
  for (var c = 0; c < rows.length; c++) {
    var grp = groups[rows[c].label] || (groups[rows[c].label] = []);
    grp.push(rows[c]);
  }
  Object.keys(groups).forEach(function (lb) {
    var g = groups[lb];
    if (g.length < 2) return;
    var hs = g.map(function (r) {
      return r.hours | 0;
    });
    var allHaveHours = hs.every(function (h) {
      return h > 0;
    });
    var usable = allHaveHours && new Set(hs).size === hs.length;
    for (var i = 0; i < g.length; i++)
      g[i].label = usable ? lb + '·' + hs[i] + '小时' : lb + '#' + g[i].itemId;
  });
  catalogCache = { rows: rows, at: now, fellBack: fellBack };
  return catalogCache;
}

/**
 * 按 itemId 查目录行（未登记回 null）。走 catalogRows()（而非裸 catalog()）：推送处理路径上目录读取意外抛错
 *   也不能抹掉一次加入，回落种子行就是旧行为（只有 44/9100/12 认得）。
 * 归并行（一族一行）的成员存在 itemIds 里，所以 94/95 都命中同一行；行上的 itemId 只是代表（排序/日志用）。
 * @param {number|string} itemId 12003 载荷 itemId
 * @returns {object|null}
 */
function rowOfItem(itemId) {
  var rows = catalogRows();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.itemId) === String(itemId)) return r;
    for (var j = 0; r.itemIds && j < r.itemIds.length; j++)
      if (String(r.itemIds[j]) === String(itemId)) return r;
  }
  return null;
}

/**
 * 异步读回自学习目标（未读回前 learnTarget 不落盘、catalog 也不补学习行）；读失败不置 loaded，保留下次重试机会。
 */
function ensureTargetsLoaded() {
  if (targetsLoaded) return;
  Promise.resolve(storage.data.get(TARGETS_STATE_NAME))
    .then(function (saved) {
      targetsLoaded = true;
      if (saved && saved.items && typeof saved.items === 'object') {
        Object.keys(saved.items).forEach(function (k) {
          learnedTargets[k] = saved.items[k];
        });
        catalogCache = null; // 盘上已学的怪（如 94/95）补进目录
      }
      // 必须带 rebuild：面板 HTML 只在 mountUI 建一次，而本次读回是异步的、晚于那次渲染，
      //   只发裸 UI_REFRESH 只能刷值，盘上已学的目标行永远出不来（刷新页面后“那一行又没了”的成因）。
      bus.emit(EVT.UI_REFRESH, { rebuild: 'allianceRally' });
    })
    .catch(function (err) {
      log.warn('learned targets load failed, will retry. %s', err && err.message);
    });
}

/**
 * 登记一个未见过的集结目标（12003 自学习的入口）：写内存 + 失效目录缓存 + 异步落盘。
 * PVP/混合集结族不登记（那些集结本 feat 永不自动加，登记了只会往面板堆无意义行）；
 * auto_hunt 表认识却被入选闸门筛掉的 itemId 也不登记（否则一条推送就能把「赛季开关明确关了」的目标复活）。
 * @param {object} d 12003 载荷
 * @returns {boolean} true=本轮新学到一个目标
 */
function learnTarget(d) {
  var itemId = Number(d.itemId);
  if (!(itemId > 0)) return false;
  if (familyReject(d.pointType)) return false;
  if (tableGatedGroups && tableGatedGroups.has(itemId)) {
    // 表里确有这个 group 且被闸门明确关掉（功能开关关 / 走别的报文）：推送不该把它当「新目标」学进来
    log.debug('itemId is known to the table but gated off, not learning. itemId=%s', itemId);
    return false;
  }
  var k = String(itemId);
  var now = Date.now();
  var e = learnedTargets[k];
  if (e) {
    // 已登记：只刷新「最后一次被推到」的时刻（陈旧判定用）；距上次落盘超过 6h 才再写一次，避免每推一次写一次盘
    e.ts = now;
    // 老条目（本改造之前学的）没有 lf：这次推来就补上并立刻落盘一次（一次性的，不走 6h 节流），
    //   否则面板后缀会一直停在旧写法 '#<itemId>'（能区分、但对不上游戏里的雷达任务）。
    var life = intelLifeSec(d);
    var backfill = life > 0 && !(Number(e.lf) > 0);
    if (backfill) {
      e.lf = life;
      catalogCache = null; // 时长参与同名行消歧，不失效就还是旧后缀
    }
    if (backfill || now - (Number(e.wTs) || 0) > 1000 * 60 * 60 * 6) {
      e.wTs = now;
      persistTargets();
    }
    return false;
  }
  if (!targetsLoaded) return false; // 读回前不新增：此时 learnedTargets 是空的，落盘会把盘上已学项覆掉
  learnedTargets[k] = {
    pt: Number(d.pointType) | 0,
    mt: Number(d.marchType) | 0,
    lf: intelLifeSec(d),
    ts: now,
    wTs: now,
  };
  catalogCache = null;
  persistTargets();
  return true;
}

/**
 * 学习项落盘（只写不陈旧的部分；无单飞闸门：写入靠 itemId 新增触发，频率极低且后写者覆前写者无害）。
 */
function persistTargets() {
  if (!targetsLoaded || targetsSaving) return;
  targetsSaving = true;
  var now = Date.now();
  var keep = {};
  Object.keys(learnedTargets).forEach(function (k) {
    var e = learnedTargets[k];
    if (e && now - (Number(e.ts) || 0) < LEARN_STALE_MS) keep[k] = e; // ts 取原值：写成 | 0 会让 keep 恒空，等于每次落盘都抹掉已学项
  });
  Promise.resolve(storage.data.set(TARGETS_STATE_NAME, { items: keep }))
    .catch(function (err) {
      log.warn('learned targets save failed. %s', err && err.message);
    })
    .then(function () {
      targetsSaving = false;
    });
}

/**
 * 目录行的安全取用口：catalog() 要读游戏表/开关/语言包，任何意外抛错都不该让面板渲染或配置应用整块停摆 → 回落种子行。
 * （面板描述符里的 rows getter 在序列化/渲染路径上被调用，报错会抹掉整个面板）。
 * @returns {object[]} 与 catalog().rows 同构的行集
 */
function catalogRows() {
  try {
    return catalog().rows;
  } catch (err) {
    log.warn('rally catalog read failed, fall back to seed rows. %s', err && err.message);
    return ROW_SEEDS.map(function (r) {
      return {
        key: r.key,
        label: r.label,
        itemId: r.itemId,
        pointType: r.pointType,
        learned: false,
      };
    });
  }
}

/**
 * 保证「本轮已真读过表」：tableGatedGroups 只在成功反查时才有值。若判定拿到的是页面加载早期那次回落留下的 null，
 *   学习闸门会形同虚设（放行），而紧随其后的目录重建却用刚填好的集合把它筛掉 —— 同一次调用里两个结论相反，
 *   表现就是「日志说学成候选、面板里却没这行」。故推送判定前先补一次真实反查；表确实不可读时保持 null，
 *   学习放行与合并放行两边结论依旧一致。
 */
function ensureTableConsulted() {
  if (tableGatedGroups || !l10n.tableReady()) return; // 已反查过 / 表现在也读不出：两种情形都不必再试
  catalogCache = null;
  catalog();
}

/**
 * 把目录里的新行并入运行时 cfg.targets（仅补缺，不覆盖已有行）；新增行一律默认未勾选，勾选权在用户。
 */
function syncTargets() {
  var rows = catalogRows();
  for (var i = 0; i < rows.length; i++) {
    var k = rows[i].key;
    if (!cfg.targets[k])
      cfg.targets[k] = {
        enabled: false,
        joinDelayMs: 0,
        dailyLimit: 0,
        itemId: rows[i].itemId,
        itemIds: rows[i].itemIds || [rows[i].itemId], // 归并行带整族成员，日志能把「哪只怪算在本行上」说清
      };
  }
}

/**
 * @type {number} 落盘单飞闸门的看门狗超时（毫秒）。storage.data.set 要等 bridge 回执才落定，
 * 回执丢失（如自动重连刷新页面那段间隙 bridge 尚未注入）会让 Promise 永不 settle，
 * 闸门卡死就等于本次会话再也不落盘——超时后强制复位，后续修改照常重试。
 */
const SAVE_STUCK_MS = 10000;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（行军上限/自发集结/过期时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 清快照池托管定时器（条目保留，resume 重排续跑） */
var ctxRef = null;

/**
 * 可调配置：targets[key] = { enabled:boolean, joinDelayMs:number, dailyLimit:number(0=无限) }
 * @type {object}
 */
var cfg = {
  targets: {
    warHammer: { enabled: true, joinDelayMs: 0, dailyLimit: 0 },
    fearStar: { enabled: true, joinDelayMs: 0, dailyLimit: 0 },
    refugeeCamp: { enabled: true, joinDelayMs: 0, dailyLimit: 0 },
  },
};

/**
 * 当日参与计数持久态：{ date:'YYYY-MM-DD', counts:{ <key>:number } }。
 * 懒加载：首次 alive 时从 storage.get 读回；install 后的 push 处理会先确保已加载。
 * 跳日自动归零（今日 != state.date 时重置 counts）。
 * @type {{date:string, counts:Object<string,number>}}
 */
var dailyState = { date: '', counts: {} };
/** @type {boolean} 持久态是否已读回（未读回前计数按 0 处理，且不允许落盘，见 persistDaily） */
var dailyStateLoaded = false;
/** @type {boolean} 是否有一笔写入在飞（单飞合并，不叠加排队） */
var dailyStateSaving = false;
/** @type {number} 落盘世代号：看门狗复位闸门后，迟到的旧回执不得再去动新一轮的闸门 */
var saveSeq = 0;
/**
 * 今日已播报过「达每日上限」的目标集（键 `date|key`）：每目标每天只 info 一次、之后静默，
 * 避免打满后每次集结 push 都刷一行。内存态，日期拼进键里故跨天自然失效。
 * @type {Set<string>}
 */
var limitAnnounced = new Set();

/**
 * 本轮运行内「已勾选集结目标但本人不在盟而跳过」是否已提示过一次（逐次推送重演同一条件会刷屏，故 once 闸门）。
 * @type {boolean}
 */
var noAllianceNoted = false;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（延迟与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 集结快照池（D 原语）：过闸后的 12003 快照按 teamId 入池，joinDelayMs 错峰唤醒后一次性消耗调 joinFlow。
 * 同键拒入不续命（重复 push 不重置延迟）；expireTime 到点惰性剔除；pause 清定时器保留条目，
 * resume 由 run() 调 reschedule() 重排未过期条目（旧 run 清池放弃已延迟集结的口径改为续跑，属有意增强）。
 * @type {ReturnType<createSnapshotPool>}
 */
const pool = createSnapshotPool({
  log: log,
  alive: aliveFn,
  ctx: function () {
    return ctxRef;
  },
  onWake: function (key, payload) {
    return joinFlow(payload.key, key, payload.expireTime).catch(function (err) {
      log.warn('join flow threw!', err);
    });
  },
});

/**
 * 注入面板配置（秒→毫秒在 registry.toModuleCfg 完成）
 * 先按当前目录补齐行（面板改配置时新出现的学习项/表行会在这里进 cfg.targets，默认未勾选），再逐键钳值。
 * @param {object} partial {targets:{<key>:{enabled,joinDelayMs,dailyLimit}}}
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  var targets = partial.targets;
  if (!targets) return cfg;
  syncTargets();
  Object.keys(cfg.targets).forEach(function (key) {
    var t = targets[key];
    if (!t) return;
    if (typeof t.enabled === 'boolean') cfg.targets[key].enabled = t.enabled;
    if (typeof t.joinDelayMs === 'number' && t.joinDelayMs >= 0)
      cfg.targets[key].joinDelayMs = t.joinDelayMs;
    if (typeof t.dailyLimit === 'number' && t.dailyLimit >= 0)
      cfg.targets[key].dailyLimit = t.dailyLimit;
  });
  return cfg;
}

/**
 * 该集结形态的成员数上限（data_config）；取不到回 0=不卡这道闸。
 * @param {number} marchType 12003 载荷 marchType（8 普通 / 10 超级）
 * @returns {number}
 */
function memberCapOf(marchType) {
  var id = JOINABLE_MARCH_TYPES[marchType];
  if (!id) return 0;
  var n = Number(gameConf.dataConfig(id));
  return n > 0 ? n | 0 : 0;
}

/**
 * 12003 推送入口：同步过滤 + 未登记目标自学习 + 安排延迟加入。
 * @param {object} ev net.on 事件 {cmd, status, data, ord, ts, raw}
 */
function onAssemblyCreated(ev) {
  if (!aliveFn()) return;

  var d = ev && ev.data;
  if (!d || !d.teamId) return;

  var marchType = Number(d.marchType);
  // 只处理可走 1204 的形态（8 普通集结、10 超级集结）；其余形态加入报文不同，不属本 feat
  if (!JOINABLE_MARCH_TYPES[marchType]) return;

  // 游戏 joinAssemlby 的第一道闸：还在召集态（INIT=0）才能加（己开始行军的集结不可再加）
  if (Number(d.marchState) !== MARCH_STATE_INIT) {
    log.debug(
      'rally not in INIT state, skip. itemId=%s;marchState=%s;teamId=%s',
      d.itemId,
      d.marchState,
      d.teamId,
    );
    return;
  }

  ensureTableConsulted(); // 学习闸门与目录行源必须基于同一次反查结论（否则会出现「播报学了但面板没行」）
  var target = rowOfItem(d.itemId);
  if (!target) {
    // 目录里没有这个 itemId：旧实现在这里静默 return（就是 94/95 雷达集结怪被天天丢弃的原因）；现在先自学习成「待勾选」候选
    var familyReason = familyReject(d.pointType);
    if (familyReason) {
      // PVP/混合集结族不学习也不加（那些集结游自己需要玩家点过二次确认），属预期的不归本 feat 管：debug
      log.debug(
        'rally family not handled here, skip. itemId=%s;pointType=%s;reason=%s',
        d.itemId,
        d.pointType,
        familyReason,
      );
      return;
    }
    if (learnTarget(d)) {
      var made = rowOfItem(d.itemId);
      if (!made) {
        // 不变量：学习成功即应能在目录里取到该行。取不到＝学习与反查两处闸门结论相反（或反查抛错走了兜底），
        //   宁可直接 warn 也不播「已学成候选」的假成功（历史版本就是这里吹了牛而面板没行）
        log.warn(
          'rally target learned but not listed in catalog. itemId=%s;pointType=%s',
          d.itemId,
          d.pointType,
        );
        return;
      }
      log.info(
        'new rally target learned as an unchecked candidate. itemId=%s;pointType=%s;marchType=%s;label=%s (面板勾选后才会自动加入)',
        d.itemId,
        d.pointType,
        marchType,
        made.label,
      );
      // 行集变了：ui.refresh 本身只刷只读格，不重建 DOM 行，故带上 rebuild 让面板当场多一行（面板未开/正在输入时自动略过）
      bus.emit(EVT.UI_REFRESH, { rebuild: 'allianceRally' });
    }
    return;
  }

  var tcfg = cfg.targets[target.key];
  if (!tcfg || !tcfg.enabled) {
    // 未勾选是用户意志，不是丢弃 bug；但已登记却不使能的情形首次提一行（免得用户以为已经在打）
    if (!learnAnnounced[target.key]) {
      learnAnnounced[target.key] = 1;
      log.info(
        'rally target registered but not enabled, skipping pushes. target=%s;itemId=%s',
        target.label,
        target.itemId,
      );
    } else {
      log.debug('rally target not enabled, skip. target=%s', target.label);
    }
    return;
  }

  // 家族闸门（逐条对齐游戏 joinAssemlby）：不过即 skip，属随资源/等级回收而自愈的门控不过 → debug
  var reject = familyReject(d.pointType);
  if (reject) {
    log.debug(
      'family gate rejected, skip. target=%s;pointType=%s;reason=%s;teamId=%s',
      target.label,
      d.pointType,
      reject,
      d.teamId,
    );
    return;
  }

  // 集结 inherently 需在盟（游戏对 searchType>=3 的行也是 !isInAlliance() 即不列）；null=无从判定→放行
  if (gameData.inAlliance() === false) {
    if (!noAllianceNoted) {
      noAllianceNoted = true;
      log.info(
        'not in an alliance, cannot join any rally (further skips muted until restart). target=%s',
        target.label,
      );
    }
    return;
  }

  // 首读失败过（如 UID 前缀未设的登录窗口期）就借这次推送再试一次，否则本次会话只能永远跑内存值
  if (!dailyStateLoaded) ensureDailyLoaded();

  var teamId = String(d.teamId);

  if (isOwnRally(d)) return;

  // 余位检查
  if ((d.rallyCapacity | 0) - (d.rallySize | 0) < 1) {
    log.info('rally full, skip. target=%s;teamId=%s', target.label, teamId);
    return;
  }

  // 成员数上限（游戏 joinAssemlby 拿 data_config 8005/61057 与 members.length 比，rallyCapacity 只是容量墙）
  var cap = memberCapOf(marchType);
  if (cap > 0 && (d.members || []).length >= cap) {
    log.info(
      'member cap reached, skip. target=%s;teamId=%s;members=%d/cap=%d',
      target.label,
      teamId,
      (d.members || []).length,
      cap,
    );
    return;
  }

  // 全局行军闸门（core/march.canMarch）
  if (!march.canMarch()) {
    log.info('no free march slot, skip. target=%s;teamId=%s', target.label, teamId);
    return;
  }

  // 每日参与上限闸门（dailyLimit=0 意味无限）
  if (isDailyLimitReached(target.key)) {
    // 已达上限是预期的空闲态：每目标每天只在首次命中时播报一行（生命周期），之后 push 静默返回，不刷日志
    var announceKey = dailyState.date + '|' + target.key;
    if (!limitAnnounced.has(announceKey)) {
      limitAnnounced.add(announceKey);
      log.info(
        'daily limit reached, going idle today. target=%s;count=%d/%d (further skips muted)',
        target.label,
        dailyState.counts[target.key] | 0,
        tcfg.dailyLimit,
      );
    }
    return;
  }

  // 入池即去重（同 teamId 在池期间重复 push 拒入不续命）；wake.at=joinDelayMs 错峰，TTL=expireTime
  var accepted = pool.offer(
    teamId,
    { key: target.key, expireTime: d.expireTime },
    {
      wakeAt: Date.now() + Math.max(0, tcfg.joinDelayMs | 0),
      expireAt: d.expireTime > 0 ? d.expireTime * 1000 : 0,
    },
  );
  if (!accepted) return;

  log.info(
    'rally push. target=%s;teamId=%s;leader=%s;delay=%dms',
    target.label,
    teamId,
    d.leaderName,
    tcfg.joinDelayMs,
  );
}

/**
 * 是否自己发起的集结（leaderUid 等于自己 UID 则不自己打自己）
 * @param {object} d 12003 载荷
 * @returns {boolean}
 */
function isOwnRally(d) {
  var uid = dataCenter.UserData && dataCenter.UserData.UID;
  return uid != null && String(d.leaderUid) === String(uid);
}

/**
 * 跳日自动归零：当前日期与持久态不同则重置 counts，保留结构，并落盘。
 * 未读回盘上数据前不动内存 date：此时 date='' 必然≠today，照跑会把内存日期抢先改成今天、
 * 却不落盘（persistDaily 有 loaded 闸门），留下 date/counts 不一致的半截状态；
 * 读回回调里日期会整体覆盖并重试跳日，这里直接跳过即可。
 */
function rollDateIfNeeded() {
  if (!dailyStateLoaded) return;
  var today = todayStr();
  if (dailyState.date !== today) {
    dailyState.date = today;
    dailyState.counts = {};
    persistDaily();
  }
}

/**
 * 异步加载持久化的当日计数（首调完成前，同步闸门会默认当作 0 处理；面板重多推送下不致命，
 * 真机需严格的话可额外挂一个 dailyStateLoaded 闸门，目前接受这个短窗口）。
 * 读失败不置 loaded：读不到 ≠ 盘上没数据（storage.data.get 在 UID 前缀未设时是 reject），
 * 保留下次 run()/推送重试的机会；未 loaded 期间 persistDaily 会挡住写盘，不会拿内存全 0 覆掉盘上真值。
 */
function ensureDailyLoaded() {
  if (dailyStateLoaded) {
    rollDateIfNeeded();
    return;
  }
  Promise.resolve(storage.data.get(DAILY_STATE_NAME))
    .then(function (saved) {
      dailyStateLoaded = true;
      if (saved && typeof saved === 'object' && typeof saved.date === 'string') {
        dailyState.date = saved.date;
        dailyState.counts = saved.counts && typeof saved.counts === 'object' ? saved.counts : {};
      }
      rollDateIfNeeded();
      // 读回完成把面板上的 '-' 占位刷成真实计数（ui.refresh 仅在面板打开时扫 DOM，开销可忽略）
      bus.emit(EVT.UI_REFRESH);
    })
    .catch(function (err) {
      log.warn('daily state load failed, will retry on next run/push. %s', err && err.message);
      rollDateIfNeeded();
    });
}

/**
 * 当前目标今日参与是否已抵达上限（dailyLimit=0 直接放行）
 * @param {string} key 目标 key
 * @returns {boolean}
 */
function isDailyLimitReached(key) {
  var limit = cfg.targets[key] && cfg.targets[key].dailyLimit;
  if (!limit || limit <= 0) return false;
  rollDateIfNeeded();
  return (dailyState.counts[key] | 0) >= limit;
}

/**
 * 当前面板展示的“今日已参与”纯计数：只返数字本体（无 / 上限后缀），与自动打野 huntlist「已打」格同口径，
 * 保持一列窄格内容不撑宽（上限信息已可由同一行的「每日上限」 input 直接看到）。
 * 纯展示函数：不再调 rollDateIfNeeded——首次渲染（mountUI→get）早于异步读盘完成，
 * 旧实现在 UI 路径上触发日期改写+落盘尝试，弹出误报的 skip-save warn。
 * 未读回时借这次渲染补发一次加载，并显示占位符（计数读回后随面板下次刷新更新）。
 * @param {string} key 目标 key
 * @returns {string}
 */
function formatToday(key) {
  if (!dailyStateLoaded) {
    ensureDailyLoaded();
    return '-';
  }
  return String(dailyState.counts[key] | 0);
}

/**
 * 成功加入一条后计数 +1 并异步持久化（写入失败不阻断主流程），顺带推面板刷新
 * @param {string} key 目标 key
 */
function bumpDailyCount(key) {
  rollDateIfNeeded();
  dailyState.counts[key] = (dailyState.counts[key] | 0) + 1;
  persistDaily();
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 保存 daily state（单飞：上一次未写完时不叠加，后续修改会合并到下一笔写入）。两道保险：
 *   1) 未成功读回盘上数据前绝不写盘——内存这份 counts 很可能是全 0，整块写回会把盘上真值覆掉；
 *   2) 单飞闸门带看门狗——写入靠 bridge 回执落定，回执丢失会让闸门永久卡死（之后再也不落盘），
 *      超时强制复位，后续修改照常重试。
 */
function persistDaily() {
  if (dailyStateSaving) return;
  if (!dailyStateLoaded) {
    log.warn(
      'skip daily state save: disk state not loaded yet (in-memory counts are not authoritative).',
    );
    return;
  }
  dailyStateSaving = true;
  var seq = ++saveSeq;
  var snapshot = { date: dailyState.date, counts: Object.assign({}, dailyState.counts) };
  // 看门狗刻意不托管：一次性自清 latch 守卫，pause 后到点仅复位闸门无写动作；
  //   若托管被 pause 清掉、save Promise 又悬跨 pause，latch 反会卡死（同 auto-hunt 口径）。
  var watchdog = setTimeout(function () {
    log.warn('daily state save pending over %dms, reset latch.', SAVE_STUCK_MS);
    releaseSaveLatch(seq);
  }, SAVE_STUCK_MS);
  Promise.resolve(storage.data.set(DAILY_STATE_NAME, snapshot))
    .catch(function (err) {
      log.warn('daily state save failed.', err);
    })
    .then(function () {
      clearTimeout(watchdog);
      releaseSaveLatch(seq);
    });
}

/**
 * 释放落盘单飞闸门（带世代校验）：看门狗已复位且被新一轮接管后，迟到的旧回执不得再去动新那笔的闸门。
 * @param {number} seq 本次写入的世代号
 */
function releaseSaveLatch(seq) {
  if (seq !== saveSeq) return;
  dailyStateSaving = false;
}

/**
 * 单次加入流程（快照池 onWake 回调）：过期复查 → 行军复查 → 最小部队 → 发 1204。永不 reject。
 * 去重/到期剔除/一次性出池已由快照池兜住；这里的 expireTime 复查留作双保险（时钟漂移边界）。
 * @param {string} key 目标 key
 * @param {string} teamId 集结队伍 id
 * @param {number} expireTime 集结过期时间戳（秒）
 * @returns {Promise<void>}
 */
async function joinFlow(key, teamId, expireTime) {
  if (!aliveFn()) return;

  // 过期检查：集结已开始（expireTime 已过）则放弃
  if (expireTime && Date.now() / 1000 > expireTime) {
    log.info('rally expired, abandon. target=%s;teamId=%s', key, teamId);
    return;
  }

  // 行军闸门复查
  if (!march.canMarch()) {
    log.info('no march slot (recheck), abandon. target=%s;teamId=%s', key, teamId);
    return;
  }

  var marchData = new Battle().plan().minimal().build();
  if (!marchData.armyListNew.length) {
    log.info('no army available, abandon. target=%s;teamId=%s', key, teamId);
    return;
  }

  // 发送前复查每日上限（延迟期间可能上一刚刚发成一条，同目标计数会变）
  if (isDailyLimitReached(key)) {
    log.info('daily limit reached (recheck), abandon. target=%s;teamId=%s', key, teamId);
    return;
  }

  var ret = await sendJoin(teamId, marchData);
  if (ret.ok) {
    bumpDailyCount(key);
    log.info(
      'join ok. target=%s;teamId=%s;armyId=%d;today=%d',
      key,
      teamId,
      marchData.armyListNew[0].armyId,
      dailyState.counts[key] | 0,
    );
  } else {
    // 加入被拒（目标已满/已过期/不可加入等 code=3）属预期业务态，非错误：降为 info（真实网络失败另由 sendJoin 的 join send error warn 兜底）
    log.info(
      'join rejected. target=%s;teamId=%s;code=%d;data=%s',
      key,
      teamId,
      ret.code,
      rejectText(ret) || '-',
    );
  }
}

/**
 * 发送 1204 加入集结。永不 reject。
 * @param {string} teamId 集结队伍 id
 * @param {object} marchData Battle 产出的 MarchData
 * @returns {Promise<Ret>} code=1204 状态码
 */
async function sendJoin(teamId, marchData) {
  return net.sendGuarded(
    CMD_ASSEMBLY_JOIN,
    {
      marchType: MARCH_TYPE_JOIN,
      teamId: teamId,
      armyList: marchData.armyListNew,
      armyListNew: marchData.armyListNew,
      heroList: marchData.heroList,
      trapList: marchData.trapList,
      formation: 0,
      formationV2: marchData.formationV2,
    },
    {
      onError: function (err) {
        log.warn('join send error. teamId=%s', teamId, err);
      },
    },
  );
}

/**
 * 安装：网络 + 数据中心。
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

  var mods = game.requireAll(['DataCenter']);

  dataCenter = (mods.DataCenter && mods.DataCenter.DATA) || missing.push('DataCenter');

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
 * 运行：读回两个持久态（当日计数 / 自学习目标）后挂 12003 监听。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  pool.reschedule(); // pause 保留的未过期条目重排唤醒（wakeAt 已过→立即）；首轮池空 no-op
  noAllianceNoted = false; // 刷屏闸门每轮运行复位（退盟/入盟状态变化后需要重新能提一次）
  ensureTargetsLoaded(); // 读回后把盘上已学的目标（如 94/95）补进目录，面板当场多行
  ensureDailyLoaded();
  syncTargets(); // cfg.targets 以当前目录为准补齐（新行默认未勾选）
  ctx.on.push(CMD_PUSH_ASSEMBLY_CREATED, onAssemblyCreated);
  log.info('started, listening push=%d.', CMD_PUSH_ASSEMBLY_CREATED);
}

/**
 * 面板行集（由 catalog() 映射为 rallygrid 行描述符）：每行一个目标，字段前缀统一「key+Enabled / key+DelaySec /
 *   key+DailyLimit / key+TodayCount」，使配置扁平结构不变（已有用户的 warHammer、fearStar、refugeeCamp 三组键零迁移），
 *   新目标只是多一组同形键（默认未勾选，因为 defaults 不声明它、存盘也不存 →「!!c[key 拼 Enabled]」自然为 false）。
 * @returns {object[]}
 */
function buildRallyRows() {
  return catalogRows().map(function (r) {
    return {
      name: r.label,
      learned: !!r.learned, // 仅自学习行可删（表反查/种子行没有可删的持久态）
      itemIds:
        r.itemIds && r.itemIds.length ? r.itemIds : r.learned && r.itemId ? [r.itemId] : null,
      enableKey: r.key + 'Enabled',
      delay: { key: r.key + 'DelaySec', min: 0, step: 1 },
      limit: {
        key: r.key + 'DailyLimit',
        min: 0,
        step: 1,
        zeroUnlimited: true,
        placeholder: '不限',
        title: '每日上限；留空 / 0 = 不限',
      },
      count: {
        key: r.key + 'TodayCount',
        get: function () {
          return formatToday(r.key);
        },
      },
    };
  });
}

/**
 * 面板×按钮手工删除一个自学习目标：按 itemIds 从 learnedTargets 逐个删除并覆盘。
 * 表行/种子行不在 learnedTargets 里（删不到）；删除后除非该 itemId 再被 12003 推到、重新走 learnTarget，否则不会回来。
 * @param {string} rowkey 行上 data-rowkey：成员 itemId 的逗号串（归并行一整族一起删）
 */
function deleteLearnedRow(rowkey) {
  var ids = String(rowkey || '')
    .split(',')
    .filter(Boolean);
  if (!ids.length) return;
  var removed = 0;
  ids.forEach(function (id) {
    if (learnedTargets[id]) {
      delete learnedTargets[id];
      removed++;
    }
  });
  if (!removed) {
    // 进到这里说明面板渲染了学习行的×，但 learnedTargets 里没有该 itemId（目录与持久态失同步）：异常，留 warn 供真机定位
    log.warn('delete requested but itemId not in learnedTargets. rowkey=%s', rowkey);
    return;
  }
  catalogCache = null; // 目录即时剔除该行
  persistTargets(); // 被删的已不在 learnedTargets，覆盘后不再写回（targetsSaving 在飞则下一笔补上，内存已删不影响面板）
  bus.emit(EVT.UI_REFRESH, { rebuild: 'allianceRally' }); // 行集变了：重建面板 DOM 删那一行
  log.info('learned rally target deleted by hand. itemIds=%s', rowkey);
}

/**
 * 向 reactor 注册本功能说明书：places 限定 base/world（Home/NWorldMap），战斗模式暂停；面板行集随目录浮动。
 */
reactor.register({
  id: 'allianceRally',
  label: '联盟集结',
  storageKey: 'pocketcc.feat.allianceRally',
  symbols: ['dataCenter'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: {
    enabled: false,
    warHammerEnabled: true,
    warHammerDelaySec: 0,
    warHammerDailyLimit: 0,
    fearStarEnabled: true,
    fearStarDelaySec: 0,
    fearStarDailyLimit: 0,
    refugeeCampEnabled: true,
    refugeeCampDelaySec: 0,
    refugeeCampDailyLimit: 0,
  },
  fields: [
    {
      // 联盟集结目标紧凑表：一行五列（目标名 · 延迟入队(秒)输入 · 每日上限输入 · 今日已打文本 · 启用 checkbox）。
      // 行集不再写死：rows 是 getter，每次渲染实时取 catalogRows()（表反查 + 12003 自学习），于是赛季新增/下线集结目标自动增减行。
      //   行子格元数据（min/step/zeroUnlimited）挂在 delay/limit 上，wire.js 数字委托按 rows 下探；
      //   count 只读格的 data-fkey 接 r.count.get，refreshTexts 同路径下探。
      //   控件身份钉在每格的 key（而非行下标）上，所以目录重排/增删不会把已存值写到别的怪行上。
      type: 'rallygrid',
      key: 'rallyGrid',
      cols: ['', '延迟入队(秒)', '每日上限', '今日已打', ''],
      get rows() {
        return buildRallyRows();
      },
      // 学习行×删除的回调（由 wire.js 的 .pc-rgdel 委托调用，传行上的 itemIds CSV）：表行无此按钮。
      onDeleteRow: deleteLearnedRow,
    },
  ],
  toModuleCfg: function (c) {
    // 逐目录行取扁平键（新行不会缺席：目录是唯一行源）；本函数产出的就是归一化运行时配置，configure 不二次归一
    var rows = catalogRows();
    var targets = {};
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i].key;
      var ids = rows[i].itemIds || [rows[i].itemId];
      // 归并（一族一行）把键从 'm<itemId>' 换成了 'pt<pointType>'：老键上用户已做的决定不能凭空丢，
      //   但只在「新键还没被决定过」时继承（c[k+'Enabled'] 从未入 defaults 也未入盘 = undefined）——
      //   否则用户后来显式取消勾选会被老键翻回 true。口径：enabled 取或（任一成员勾过就是要打）、
      //   延迟取首个非零、每日上限取合计（旧配置每只怪各一份额度，相加才等价）。
      var enabled = !!c[k + 'Enabled'];
      var delayMs = (Number(c[k + 'DelaySec']) || 0) * 1000;
      var limit = Number(c[k + 'DailyLimit']) | 0;
      if (ids.length > 1 && c[k + 'Enabled'] === undefined) {
        for (var m = 0; m < ids.length; m++) {
          var mk = 'm' + ids[m];
          if (c[mk + 'Enabled']) enabled = true;
          if (!delayMs) delayMs = (Number(c[mk + 'DelaySec']) || 0) * 1000;
          limit += Number(c[mk + 'DailyLimit']) | 0;
        }
      }
      targets[k] = {
        enabled: enabled,
        joinDelayMs: delayMs,
        dailyLimit: limit,
        itemId: rows[i].itemId,
        itemIds: ids,
      };
    }
    return { targets: targets };
  },
  install: install,
  configure: configure,
  run: run,
});
