/**
 * 自动打野（autoHunt）- 日常 feat：按「怪物清单」维持多种野怪的在途讨伐，带体力边界闸与自动补药。
 *
 * 用户口径（怪物清单表格：一行一种怪，勾选=纳入猎杀范围；参照「机甲捐赠」的表格范式而非分段）：
 *   全局区   —— 体力边界 minStamina（体力 ≥ 此值才开打）、autoRefill（体力不足自动补药）、打野预设池 presets（动态增删、每个预设只进一次、按序取能出兵者）。
 *   怪物清单 —— 一行一种怪，固定行不可增删：怪物类型 | 等级区间 from~to | 方式（下拉，选项随该行而变）| 攻打数量（0=不限）| 已打（今日已打，只读）| ☑ 参与。
 *              「同时打好几种怪」= 勾多行；行未勾选则该种怪不参与。
 *              「已打」= 本 feat 本地当日派发计数（storage.data 持久、跳日归零）。惧星已拆出为独立 feat「惧星集结」（fearStarRally）。
 *   多预设出兵 —— 派发一个目标时按 presets 顺序遍历，对预设 n 调 Battle().plan().preset(n).adjust().build()（adjust 已排除在途兵），
 *              取第一个「能出兵」（armyListNew 非空、且配了英雄则英雄已就绪）者发 902/1201；全池无兵则该目标本轮不派、等唤醒。
 *
 * 怪物清单来源（表驱动，不再手写）：面板行集与派发段由 catalog() 运行时从游戏本地表反查 —— auto_hunt ⨝ MONSTER_GROUP，
 *   闸门对齐游戏自身的 MonthCardController.getAutoHuntMonsterList（不调该 API、只读表自己套闸）：search_show 21/22 决定野怪/集结页签、
 *   switch 走 FunctionOn（表存的是值串，见 gameData.functionOnValue）、five_continuous_type 决定「五连」候选，并排除难民营(12)/惧星(9100)/混合集结(5001)。
 *   于是赛季新增/下线怪物与 warhammer_monster 这类开关翻转会自动反映到面板与派发（新行默认未勾选，勾选权在用户）；
 *   表不可读时整体回落 MONSTERS_SEED（= 历史手写清单），行为零变化。难民营行（道具开营）不参与反查、恒在末尾（与游戏侧同构）。
 *
 * 打法与协议（报文实证 dashcam 20261011T183821-发起攻打野怪 / 20261011T184302-发起攻打野怪-5连 / 20261011T192612-集结5人打锤子 / 20261011T185055-补充体力）：
 *   搜野怪 906 WORLD_SEARCH_MONSTER —— req {minLevel,maxLevel,groupType,pointType}；resp {point:{x,y,id,pointType,m:{itemId,level,expireTime}}}，服务端直接回一个可打点（视口无关，Home 可跑）。
 *        pointType=tab：1 野怪（无需集结）、3 集结（战锤）。groupType=怪物 species（黑雷神陆军 61、黑暗陆军 43、黑暗海军 42、黑暗空军 41、战锤 44，实证于 183821 与游戏内 906 搜索）。
 *        等级：清单不暴露区间，固定搜该怪最高档（min=max）——野怪行（pointType=1）的最高档不再硬编码，派发时由 resolveHuntLevel 从游戏本地表
 *        运行时反查（= UserData.Level + MONSTER_REFRESH 最大 level_relative，旧野怪再钳 data_config 1120）；反查不可用才回落目录行的 level 回退值（曾实证：黑暗军团 86、黑雷神陆军 106）。
 *        黑暗军团(41/42/43) 实测不支持区间搜索（1~86 搜空、86~86 才回点），故恒取单档。
 *   无集结行军 902 MARCH_WORLD_POINT —— 走 core/march.attack() 组 canonical body；marchType 5 单打（183821 seq280/384/465/549 实证）、42 五连（184302 seq806 实证）。
 *   创建集结 1201 —— 直发 req {marchType:8,x,y,time:60,armyList,armyListNew,heroList,trapList,formation:0,formationV2}（无 break/extraArmy，192612 seq39/183114 实证）。
 *        「5 人 / 10 人」不是请求字段：同一 1201 body、体力扣减不同（据玩家口径 5 人扣 10 体力、10 人扣 20 体力），故按「攻打方式」给每档记一个体力下限 seg.cost，派前若体力不足该档即跳过（不硬发）。
 *   难民营（道具开营，非 906 搜索）—— 用一张求救信开一个营地：815 ITEM_USE req {itemid:1700039,amount:1} → 服务器推 10802 PUSH_FIND_REFUGEECAMP {x,y}（落点唯一来源）→ 1201 集结（body 同战锤）。背包无求救信即自动忽略该行（用户口径），并受「攻打数量」的当日开营上限约束（当日打满即停、跨日归零）。实证 dashcam 20261012T022955-难民营集结。
 *   难民营行启用时装载「镜头抑制器」（core/game-api nav.camGuard）——游戏收到 10802 会自行把镜头甩到新营地（连开多营即「乱飞」）；
 *     本玩法经 net.onPreInbound 抢在原生处理器前登记落点坐标，按坐标命中吞掉那一次自动跳转（坐标不匹配的玩家手动跳转不受影响、无时间窗口）。
 *   体力 —— gameData.energy(1)→{point,pointMax}（push 10021 type:1,point,pointMax,reason）；补充 815 ITEM_USE req {itemid,amount}（小体力 600001+10 / 大体力 600002+50 / 纯情花 700003+30 / 浪漫心 700004+30）。
 *        体力不足且勾 autoRefill → 挑四种药剂里持有量最多者（item.pickMostHeld）发 815 amount:1，等 10021 刷新镜像后再判；仍不足且无货 → 空转退避。
 *
 * 生命周期由 reactor 托管：places 限定 base/world、kinds homeland、战斗模式暂停（offInCombat，同 auto-farm）；
 *   触发源（run 点火 / 10019 回城唤醒 / 10021 体力变化 / 配置变更 / 兜底定时）全部汇入 cycle.kick，在飞合并为一次补扫。
 *   「攻打数量」= 该行当日总量上限：以本地当日已派计数（dailyState.counts）封顶，当日打满 count 个即停手、跨自然日自动归零；0=不限则不设日总量上限、参与轮转持续补派。派发节奏由全局行军名额（march.freeSlots）与逐条间隔裁决，不再按 itemId 统计在途并发（旧「维持 N 条在途」语义下，一回城即再派，难民营会持续吞求救信）。
 *   多行均分（雨露均沾）：每次 cyclePass 每个勾选行最多派 1 条，起始行按持久游标逐拍轮转，避免固定首行（如不限的黑暗陆军）单拍吃满共享行军队列、把其余勾选行饿死；空闲名额跨拍均摊。
 *
 * 配置链路（防「激活不打野」）：registry 把 {enabled, ...toModuleCfg(c)} 推给 reactor.setConfig → configure。故 toModuleCfg 产出的就是归一化运行时配置，
 *   configure 只整体赋值、绝不二次归一（曾在此踩坑：configure 再 normalize 一次读不到已归一结构里的扁平键，导致全部段判未启用而静默停摆）。
 */
import { parseData, sleep, todayStr } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { storage } from '../../core/storage.js';
import { bus, EVT } from '../../core/bus.js';
import { gameData, gameConf, l10n, nav } from '../../core/game-api.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { item } from '../../core/item.js';
import { map } from '../../core/map.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=AUTO-HUNT） */
const log = createLog('AUTO-HUNT');

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（打野/5连，经 march.attack） */
const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} RequestId.ALLIANCE_Assembly_Create：创建集结（战锤集结，feat 直发） */
const CMD_CREATE_RALLY = 1201;
/** @type {number} RequestId.ITEM_USE：使用道具（补充体力，req {itemid,amount}） */
const CMD_ITEM_USE = 815;
/** @type {number} push PUSH_USER_ENERGY：体力变化推送（唤醒重判体力闸） */
const PUSH_ENERGY = 10021;
/** @type {number} push PUSH_FIND_REFUGEECAMP：用求救信开营后服务器回推营地坐标 {x,y}（难民营落点唯一来源，非 906 搜索） */
const PUSH_FIND_REFUGEECAMP = 10802;
/** @type {number} ActivityItem.refugeeLetter：求救信道具 id（815 用一张开一个难民营，实证 20261012T022955） */
const REFUGEE_LETTER = 1700039;

/** @type {string} 当日已打计数持久态的数据 blob 逻辑名（与配置分离：频繁写入走 storage.data，面板导出/导入只涉配置） */
const DAILY_STATE_NAME = 'autoHunt.daily';
/**
 * @type {number} 落盘单飞闸门的看门狗超时（毫秒）。storage.data.set 要等 bridge 回执才落定，回执丢失会让
 * Promise 永不 settle、闸门卡死等于本会话再也不落盘——超时后强制复位，后续修改照常重试。
 */
const SAVE_STUCK_MS = 10000;

/** @type {number} 行军类型：野怪单打（ATTACK_MONSTER，183821 实证） */
const MT_ATTACK = 5;
/** @type {number} 行军类型：野怪 5 连打（184302 实证） */
const MT_COMBO = 42;
/** @type {number} 行军类型：创建集结主行军（MarchType.ALLIANCE_RALLY_BATTLE，192612 实证） */
const MT_RALLY = 8;
/** @type {number} 1201 集结等待时长（秒，报文实证固定 60） */
const RALLY_WAIT_TIME = 60;

/**
 * @type {string} 902/1201 拒绝载荷里「操作过快」的服务器全局限流文案键。与「点失效」真拒不同：目标有效、不拉黑，
 * 命中即中止本轮 + 指数退避重排下轮（照抄 auto-farm 口径）。
 */
const ERR_RATE_LIMIT = 'march_time_control_info001';

/** @type {number} 体力类型编码（UserData.getEnergy(1)） */
const STAMINA_TYPE = 1;
/**
 * 体力药剂候选池（itemId，恢复量服务端定：600001+10/600002+50/700003+30/700004+30）。
 * pickMostHeld 取持有量最多者，并列按本数组靠前者（把恢复量大者放前，尽量一次补足）。
 * @type {number[]}
 */
const STAMINA_POTS = [600002, 600001, 700003, 700004];

/**
 * 攻打方式枚举 → 面板标签、派发所需 marchType、是否集结、该档体力下限 cost（派前若体力 < cost 即跳过、不硬发）。
 * cost 据玩家口径：战锤 5 人扣 10、10 人扣 20；单打/5连的具体扣减未实证 → 记 0（只受全局体力下限约束，不足由服务器拒 + 退避自然收敛）。
 * @type {Object<string,{label:string,marchType:number,rally:boolean,cost:number}>}
 */
const MODES = {
  single: { label: '单打', marchType: MT_ATTACK, rally: false, cost: 0 },
  combo: { label: '五连', marchType: MT_COMBO, rally: false, cost: 0 },
  rally5: { label: '五人', marchType: MT_RALLY, rally: true, cost: 10 },
  rally10: { label: '十人', marchType: MT_RALLY, rally: true, cost: 20 },
};

/**
 * 难民营行（「道具开营」类，恒在目录末尾）：不参与表反查、由 buildCatalog 固定追加。口径对齐游戏侧——它也是把自己从
 * getAutoHuntMonsterList 主循环里剥出来、末尾走 getRefugeeCampData() 单独追加的（MONSTER_GROUP(12).search_show=0 不满足入选条件）。
 * 本行不走 906 搜索：用一张求救信(815)开点 + 等 10802 落点，故无 groupType/pointType/level。
 * @type {object}
 */
const ROW_REFUGEE_CAMP = {
  key: 'refugeeCamp',
  label: '难民营',
  modes: ['rally5', 'rally10'],
  level: 0,
  defaultMode: 'rally5',
  openItem: REFUGEE_LETTER,
};

/**
 * 怪物目录·兜底种子（**只在游戏本地表不可读时顶上**，与历史手写清单逐字段等值；正常运行时的目录由 catalog() 反查得出）。
 * 存在的意义是「刷表当天/符号缺失时行为零变化」，不是清单真相源 —— 新增/下线怪物请勿来这里改行。
 * 字段语义同 buildCatalog 产出：groupType/pointType 是 906 搜索的协议身份（pointType=页签：1 野怪、3 集结）；
 *   level 是「搜索等级回退值」（野怪行派发时由 resolveHuntLevel 反查覆盖，集结行等级由服务端下发、恒用此值）；
 *   modes 引用 MODES 键（该行「攻打方式」候选）；openItem 非空者为「道具开营」类。
 * @type {Array<{key:string,label:string,modes:string[],level:number,defaultMode:string,maxCount?:number,groupType?:number,pointType?:number,openItem?:number}>}
 */
const MONSTERS_SEED = [
  {
    key: 'wild',
    label: '黑雷神陆军',
    groupType: 61,
    pointType: 1,
    modes: ['single', 'combo'],
    level: 106,
    defaultMode: 'single',
  },
  {
    key: 'dark1',
    label: '黑暗陆军',
    groupType: 43,
    pointType: 1,
    modes: ['single', 'combo'],
    level: 86,
    defaultMode: 'single',
  },
  {
    key: 'dark2',
    label: '黑暗海军',
    groupType: 42,
    pointType: 1,
    modes: ['single', 'combo'],
    level: 86,
    defaultMode: 'single',
  },
  {
    key: 'dark3',
    label: '黑暗空军',
    groupType: 41,
    pointType: 1,
    modes: ['single', 'combo'],
    level: 86,
    defaultMode: 'single',
  },
  {
    key: 'warHammer',
    label: '战锤',
    groupType: 44,
    pointType: 3,
    modes: ['rally5', 'rally10'],
    level: 80,
    defaultMode: 'rally5',
  },
  ROW_REFUGEE_CAMP,
];

/**
 * @type {Object<number,string>} group → 语义 key（历史手写清单沿用的键）。命中者用旧键，使已存配置（huntlist[].key）与
 *   当日已打计数（autoHunt.daily.counts）无需迁移；表里新增的 group 用 'g<group>'。
 */
const CATALOG_KEYS = { 41: 'dark3', 42: 'dark2', 43: 'dark1', 44: 'warHammer', 61: 'wild' };

/**
 * @type {Object<number,number>} 野怪行的「搜索等级回退值」（仅 resolveHuntLevel 反查不可用时顶上，均为实证值）。
 *   表里新增、此处没有的野怪 group 回退 0 → 反查也不可用时该行当轮不搜索（宁不发 0 级档，也不猜等级）。
 */
const WILD_LEVEL_FALLBACK = { 41: 86, 42: 86, 43: 86, 61: 106 };

/**
 * @type {number} 集结行（pointType=3）的搜索等级：游戏由 903 SEARCH_HAMMER_BOSS_MAXLEVEL 应答下发（本 feat 不接该应答、
 *   也无法只读反查），故恒用此实证档（战锤 80 可回点）；搜空即该轮不派，无害。
 */
const RALLY_LEVEL = 80;

/** @type {number} MONSTER_GROUP.search_show=21 → 打野面板「野怪」页签（实证 41/42/43/61） */
const SS_WILD = 21;
/** @type {number} MONSTER_GROUP.search_show=22 → 打野面板「集结」页签（实证 44/5001/9100） */
const SS_RALLY = 22;

/**
 * @type {number[]} 表反查显式排除的 group：
 *   12 难民营（走 ROW_REFUGEE_CAMP 专用行）、9100 惧星（已拆独立 feat fearStarRally，同列会双跑抢行军队列）、
 *   5001 混合集结（游戏 getAutoHuntMonsterList 自己也硬排除该项）。
 */
const CATALOG_EXCLUDE = [12, 9100, 5001];

/** @type {number} 目录缓存有效期（毫秒）：面板渲染与逐拍派发共用一份，过期才重读表/开关（赛季开关翻转最迟 30s 内反映到面板与派发） */
const CATALOG_TTL_MS = 1000 * 30;

/**
 * @type {number} 回落态（拿不到表反查结果）的缓存有效期（毫秒）：只用短 TTL，避开「游戏 bundle 未加载时的探表失败」
 *   被 30s 钉住（面板求值期会走一次本目录，那一拍必读不到表）；下一拍就重试回表反查，syncCatalog 随即重建 segs。
 */
const CATALOG_RETRY_MS = 1000 * 5;

/** @type {number} data_config 1110 world_v1_monster_group_id：'|' 分隔的新世界野怪 group 名单，命中者走「不受旧野怪上限钳制」的口径（实证游戏 WorldMonsterModel.isNWorldTransformNMonster 即读此项） */
const CFG_WORLD_V1_GROUPS = 1110;
/** @type {number} data_config 1120 world_v1_oldmonster_max_level：旧野怪搜索等级上限（当前 86，即黑暗军团硬编码 86 的真相源） */
const CFG_OLD_MONSTER_MAX_LEVEL = 1120;

/**
 * 运行时反查某野怪 group 的「搜索最高等级」（= 插件单档搜索 min=max 的那个 level）。
 * 复刻游戏 AutoHuntMonsterSettingPop.updateMonsterSearchLevel 的 searchType==1 口径（真相全走 ACL 只读面）：
 *   旧野怪（group 不在 data_config 1110）：level = min(UserData.Level + maxOffset, data_config 1120)；
 *   新世界野怪（group 命中 data_config 1110，如黑雷神陆军 61）：level = UserData.Level + maxOffset（不受 1120 钳制）。
 *   maxOffset = MONSTER_REFRESH 表 level_relative 列最大值（当前 +6；实证黑暗军团某高等级号→86、黑雷神陆军→号级100+6=106，与旧硬编码逐项吻合）。
 * 任一输入不可得（表未就绪 / 等级为 0 / 读数非法）→ 返回 0，调用方回落目录行的 level 回退值，保证刷表当天或异常时行为零变化。
 * @param {number} groupType 野怪 species（906 groupType）
 * @returns {number} 反查到的等级；0=不可用（用回退值）
 */
function resolveHuntLevel(groupType) {
  try {
    var rows = l10n.tableRows('MONSTER_REFRESH');
    if (!rows || !rows.length) return 0;
    var maxOff = -Infinity;
    for (var i = 0; i < rows.length; i++) {
      var lr = Number(rows[i].level_relative);
      if (isFinite(lr) && lr > maxOff) maxOff = lr;
    }
    if (!isFinite(maxOff)) return 0;
    // 与游戏 _monsterLevelOffsetList[1] 以 0 为基线、只「更大才覆盖」同构（有效 maxOffset = max(0, max(level_relative))）；当前数据为 +6，若日后该表偏移整体调负也不会误搜低于账号等级的档
    if (maxOff < 0) maxOff = 0;
    var lv = gameData.level();
    if (!(lv > 0)) return 0;
    var cand = lv + maxOff;
    var v1 = String(gameConf.dataConfig(CFG_WORLD_V1_GROUPS) || '').split('|');
    var isWorldV1 = groupType != null && v1.indexOf(String(groupType)) >= 0;
    if (!isWorldV1) {
      var cap = Number(gameConf.dataConfig(CFG_OLD_MONSTER_MAX_LEVEL));
      if (isFinite(cap) && cap > 0 && cand > cap) cand = cap;
    }
    return cand > 0 ? cand | 0 : 0;
  } catch (e) {
    return 0;
  }
}

// ── 怪物目录（表驱动：运行时从游戏本地表反查） ────────────────────
/** @type {{rows:object[],sig:string,at:number,fellBack:boolean}|null} 目录缓存：rows=与 MONSTERS_SEED 同构的行、sig=侦测目录漂移的签名、at=构建时刻、fellBack=本次是否为回落态 */
var catalogCache = null;
/**
 * @type {string} 本轮表反查回落的原因（'ok'=反查成功）；只进日志，供「为什么面板只有种子行」可诊断。
 */
var catalogFallbackReason = 'never built';
/** @type {boolean} 「目录回落」是否已播报过（同一页面只提一次 warn，后续逐次回落只留 debug） */
var fallbackAnnounced = false;
/** @type {boolean} 「目录来自游戏表」是否已播报过（同一页面只提一次 info：30s TTL 到期不重刷这条） */
var tableAnnounced = false;
/**
 * @type {boolean} 是否允许读游戏表（模块求值期 false，install 才置 true）：本 feat 在求值期就要 `normalizeHunt({})` 拿到形状，
 *   而那一刻游戏 bundle（`__require`）还没上全局，读表必落。拿一个「还没到能读」的结论去报回退/延迟，每次刷页都是三条假警报，
 *   故这类先拦住不读（静默用种子行占位）；真回退（install 之后读不到）仍走下面带 reason 的日志路径。
 */
var tableReadAllowed = false;
/** @type {string} 最近一次 normalizeHunt 所依据的目录签名；与 catalog().sig 不符即触发 segs 重算（见 syncCatalog） */
var segsCatalogSig = '';

/**
 * 表列 name → 面板标签：先 auto_hunt.name（更贴打野语境）、回落 MONSTER_GROUP.name，两者都拿不到可读文案时用 '#<group>'。
 * 实证两表 name 列既有语言键（monster_name005 / 105717）也有明文（战锤-4000）：l10n.text 对语言键出译文（返回值≠传入键即命中），
 *   对明文原样返回（查不到回原键），故再按「含中日韩字符」认明文。
 * @param {object} ah auto_hunt 行
 * @param {object} mg MONSTER_GROUP 行
 * @param {number} group 怪物 group（= 906 groupType）
 * @returns {string}
 */
function catalogLabel(ah, mg, group) {
  var keys = [ah && ah.name, mg && mg.name];
  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i] == null ? '' : keys[i]).trim();
    if (!k) continue;
    var t = l10n.text(k);
    if (t && t !== k) return t;
    if (/[\u3400-\u9fff]/.test(k)) return k;
  }
  return '#' + group;
}

/**
 * 从游戏本地表反查怪物目录：auto_hunt ⨝ MONSTER_GROUP，闸门与排序对齐 MonthCardController.getAutoHuntMonsterList +
 * AutoHuntMonsterSettingPop.initMonsterListV1/initView（真相全走 ACL 只读面，不调游戏侧那个聚合 API）。
 * 入选条件：该 group 在 auto_hunt 有行 → MONSTER_GROUP 有行 → search_show 命中页签（21 野怪→pointType 1 / 22 集结→pointType 3，
 *   其余形态（含 search_show=0）不列）→ switch 为空或功能开关已开（表存 FunctionKey 值串，走 gameData.functionOnValue；读不到则放行）→ 不在 CATALOG_EXCLUDE。
 * 不复刻游戏侧的 NWorld 转换怪开放等级闸（data_config 1118 + NWorldRaise 的 WORLD_MONSTER_LEVEL）：低等级号多列一行只会搜空（906 只读、无副作用），
 *   而把它搬进目录反而有「1118/1110 读数异常即误删现役行」的风险。
 * 攻打方式：野怪行的「五连」取决于 auto_hunt.five_continuous_type 非空（实证值 42，与 MODES.combo.marchType 同值；
 *   若日后该列改成别的值，仍按本 feat 已实证的 42 派发，不照表改码）。
 * 刻意不复刻的分支（遇到时表现为「该怪不列」而非误列，是诚实边界）：
 *   KVK 赛季（游戏改用 search_show_kvk + 八国 EC 配置 130137 判定，黑暗机甲/黑暗精卫 9001/9021/9031/9131/9201 等变体只在该态出现）；
 *   活动锤子怪（group 6，需 ActivityController.getLimitHammerBossExchangeActivityId('4') 命中活动）；
 *   惧星（monster_type=40 + buff 941222，已拆独立 feat）；relevance_activity 活动窗口屏蔽；CQ26 临时禁用态。
 * @returns {object[]|null} MONSTERS_SEED 同构行数组（末尾恒附难民营行）；auto_hunt/MONSTER_GROUP 表不可读时返回 null（调用方回落种子）
 */
function buildCatalog() {
  var ahRows;
  try {
    ahRows = l10n.tableRows('auto_hunt');
  } catch (e) {
    catalogFallbackReason = 'auto_hunt read threw: ' + ((e && e.message) || e);
    return null;
  }
  if (!Array.isArray(ahRows) || !ahRows.length) {
    // 游戏 bundle 未加载（面板求值期）与 TABLE 单例缺失都走这条：l10n.tableRows 统一回 []
    catalogFallbackReason = 'auto_hunt empty or TABLE singleton unavailable';
    return null;
  }
  var rows = [];
  var mgHit = 0;
  for (var i = 0; i < ahRows.length; i++) {
    var ah = ahRows[i];
    var group = Number(ah && ah.monster_group);
    if (!(group > 0) || CATALOG_EXCLUDE.indexOf(group) >= 0) continue;
    var mg = l10n.tableRow('MONSTER_GROUP', group);
    if (!mg) continue;
    mgHit++;
    var show = Number(mg.search_show);
    var pointType = show === SS_RALLY ? 3 : show === SS_WILD ? 1 : 0;
    if (!pointType) continue;
    if (mg.switch && gameData.functionOnValue(String(mg.switch)) === false) continue; // 赛季功能开关（表 switch 列存 FunctionKey 值串）：明确关了就不列也不派；读不到（null）则放行，防误删现役行
    var wild = pointType === 1;
    var modes = wild ? ['single'] : ['rally5', 'rally10'];
    if (wild && Number(ah.five_continuous_type)) modes.push('combo');
    rows.push({
      key: CATALOG_KEYS[group] || 'g' + group,
      label: catalogLabel(ah, mg, group),
      groupType: group,
      pointType: pointType,
      modes: modes,
      defaultMode: modes[0],
      level: wild ? WILD_LEVEL_FALLBACK[group] || 0 : RALLY_LEVEL,
      searchOrder: Number(mg.search_order) || 0, // 仅供行排序（对齐游戏 search_order），下游不读
    });
  }
  if (!mgHit) {
    catalogFallbackReason =
      'auto_hunt has ' + ahRows.length + ' rows but monster_group matched none (table name drift?)';
    return null; // auto_hunt 有行但 MONSTER_GROUP 一行都反查不到 = 表未真正就绪，回落种子
  }
  catalogFallbackReason = 'ok';
  // 排序照游戏 initView：页签(searchType) 升 → search_order 升 → group 升；难民营行恒在末尾
  rows.sort(function (a, b) {
    return a.pointType - b.pointType || a.searchOrder - b.searchOrder || a.groupType - b.groupType;
  });
  rows.push(ROW_REFUGEE_CAMP);
  return rows;
}

/**
 * 目录行签名（key + 协议身份 + 打法候选 + 等级回退值 + 开营道具 + 标签）：增删行或某行属性变化都会改变签名，供 syncCatalog 侦测漂移。
 * @param {object} mo 目录行
 * @returns {string}
 */
function catalogRowSig(mo) {
  return [
    mo.key,
    mo.groupType == null ? '-' : mo.groupType,
    mo.pointType == null ? '-' : mo.pointType,
    mo.level | 0,
    mo.modes.join('/'),
    mo.openItem || 0,
    mo.label,
  ].join(':');
}

/**
 * 取怪物目录（惰性 + TTL 缓存）：面板 descriptor 的 catalog getter 与逐拍派发共用同一份。
 * 表不可得（buildCatalog 回 null）→ 回落 MONSTERS_SEED，行为与改造前零差异；回落态只缓 CATALOG_RETRY_MS。
 * ⚠ 返回值恒非空（难民营行总在里面）：面板 wire 的 huntlist align 钩子会按 catalog 全量重建存档行，
 *   某刻返回空数组会把用户已配的整张清单清成 [] 并落盘。
 * @returns {{rows:object[],sig:string,at:number,fellBack:boolean}}
 */
function catalog() {
  var now = Date.now();
  var ttl = catalogCache && catalogCache.fellBack ? CATALOG_RETRY_MS : CATALOG_TTL_MS;
  if (catalogCache && now - catalogCache.at < ttl) return catalogCache;
  if (!tableReadAllowed) {
    // 求值期这一路不读表也不打日志（理由见 tableReadAllowed）；at:0 使占位缓存立即失效，install 后第一读就拿表目录
    var seed = MONSTERS_SEED.slice();
    catalogCache = { rows: seed, sig: seed.map(catalogRowSig).join('|'), at: 0, fellBack: true };
    return catalogCache;
  }
  var rows = buildCatalog();
  var fellBack = !rows;
  if (fellBack) {
    // 回落必有日志（保证 dashcam 单轨可还原「为什么面板只有种子行」）；但只在读数面已就绪时 warn，
    //   bundle 未加载那一拍已由 tableReadAllowed 拦在门外（根本不读表、不打日志），走到这里只能是表真读不出。
    log.debug('hunt catalog fell back to seed rows. reason=%s', catalogFallbackReason);
    if (!fallbackAnnounced && l10n.tableReady()) {
      fallbackAnnounced = true;
      log.warn(
        'hunt monster table unreadable, panel shows seed rows until it reads ok. reason=%s',
        catalogFallbackReason,
      );
    }
    rows = MONSTERS_SEED.slice();
  } else if (!tableAnnounced) {
    // 成功路径也要留痕：否则日志里只有「回落」一种信号，无从判断面板上的是动态行还是种子行（表行与种子行
    //   内容相近时肉眼看不出差别）；rows 与 seed 不等或将来改版新增怪，这条就是唯一证据。
    tableAnnounced = true;
    log.info(
      'hunt catalog built from game table. rows=%d (seed rows=%d, same set is expected).',
      rows.length,
      MONSTERS_SEED.length,
    );
  }
  catalogCache = {
    rows: rows,
    sig: rows.map(catalogRowSig).join('|'),
    at: now,
    fellBack: fellBack,
  };
  return catalogCache;
}

/**
 * 内置调优常量（面板不暴露；active/idle 两档兜底同 auto-farm 惯例）。
 * @type {object}
 */
const cfg = {
  /** 仍有缺位未补/名额不足时的兜底扫描间隔（毫秒）：1 分钟 */
  activeScanInterval: 1000 * 60,
  /** 全部达标（或体力不足且未勾自动补药，等自然回体）时的兜底间隔（毫秒）：10 分钟（正常靠 10019/10021 唤醒） */
  idleScanInterval: 1000 * 60 * 10,
  /** 逐条 902/1201 之间的休眠（毫秒）：防 marches 入表延迟导致同轮超发 + 规避服务器行军时间限流 */
  marchInterval: 1000 * 8,
  /** 用完一枚体力药剂后重判体力的短间隔（毫秒）：等 10021 落地刷新 UserData 镜像 */
  energyRecheckMs: 1000 * 3,
  /** 推送唤醒补扫的最小间隔（毫秒）：合并突发回城/体力推送 */
  pushScanMinGap: 1000 * 4,
  /** 撞全局限流后的退避基数（毫秒）：按 streak 指数退避重排下轮 */
  rateLimitBackoffMs: 1000 * 15,
  /** 限流退避封顶（毫秒） */
  rateLimitBackoffMaxMs: 1000 * 60,
  /** 用一张求救信(815)后等 10802 落点推送的超时（毫秒）：超时未收到即本轮放弃该营地 */
  refugeeWaitMs: 1000 * 6,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} reactor 注入的上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * @type {object} 模块配置（configure 灌入）：{minStamina,autoRefill,presets:number[],segs:归一化行[]}。
 *   本行在模块求值期就调 normalizeHunt→catalog：那一刻游戏 bundle（`__require`）还没上全局，而目录行集只能从表反查，
 *   所以 catalog() 用 tableReadAllowed 直接拦住不读，静默拿一份种子行占位（at:0 立即失效、不留日志）；
 *   真正的表目录由 install 后的首拍 syncCatalog 建立（带 info 留痕）。
 */
var MCFG = normalizeHunt({});

/** @type {boolean} 上轮是否仍有缺位未补 / 名额不足（决定 active/idle 两档兜底间隔） */
var backlogActive = false;
/** @type {boolean} 上一拍是否为「用药后等体力刷新」（决定 energyRecheckMs 短档） */
var waitingEnergy = false;
/** @type {number} 连续撞全局限流次数（指数退避）；任一发包成功受理即归零 */
var rateLimitStreak = 0;
/** @type {number} 上次推送唤醒的墙钟时刻（毫秒），合并突发 */
var lastPushWakeAt = 0;
/** @type {number} 轮转派发游标：cyclePass 起始行下标，逐拍后移以均摊「优先补派」权（雨露均沾的跨拍公平） */
var rrCursor = 0;
/**
 * 本地被拒/失效点黑名单（"x,y" 键，run 时清空）：902/1201 被拒零成本，拉黑换下一候选，避免每拍在同一无效点吃拒。
 * @type {Set<string>}
 */
var blacklist = new Set();
/**
 * 等待「用求救信(815)后 10802 落点」的 resolver 队列（FIFO：一张信开一个营，按发送顺序认领回推）。
 * @type {Array<function({x:number,y:number}|null):void>}
 */
var refugeeWaiters = [];
/**
 * 本轮运行内「难民营已勾选但背包读不到求救信而跳过」是否已提示过一次（逐拍重演同一条件会刷屏，故 once 闸门）。
 * @type {boolean}
 */
var refugeeNoLetterNoted = false;

/**
 * 本轮运行内「集结行已勾选但本人不在盟而跳过」是否已提示过一次（逐拍重演同一条件会刷屏，故 once 闸门）。
 * @type {boolean}
 */
var rallyNoAllianceNoted = false;

/**
 * 当日已打计数持久态：{ date:'YYYY-MM-DD', counts:{ <key>:number } }。
 * 懒加载：首次 alive 时从 storage.data.get 读回；跳日自动归零。
 * @type {{date:string, counts:Object<string,number>}}
 */
var dailyState = { date: '', counts: {} };
/** @type {boolean} 持久态是否已读回（未读回前计数按 0 处理且不允许落盘，防拿内存全 0 覆掉盘上真值） */
var dailyStateLoaded = false;
/** @type {boolean} 是否有一笔写入在飞（单飞合并，不叠加排队） */
var dailyStateSaving = false;
/** @type {number} 落盘世代号：看门狗复位闸门后，迟到的旧回执不得再去动新一轮的闸门 */
var saveSeq = 0;

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

// ── 配置归一 ────────────────────────────────────────────────────────
/**
 * 面板原始配置 → 归一化运行时配置（toModuleCfg 用；configure 只整体赋值、不再调本函数）。
 * 清单行按当前目录（catalog，表驱动）顺序重建（保证 tally/派发下标稳定），逐行钳值 + 校验攻打方式在该行候选内；
 *   同时记下本次所依据的目录签名，供 syncCatalog 侦测「目录漂移」（赛季新增/下线怪物、功能开关翻转）。
 * @param {object} raw 面板 configs 快照（{minStamina,autoRefill,presets:number[],huntlist:[{key,min,max,mode,count,on}]}）
 * @returns {object} { minStamina, autoRefill, presets:number[], segs:Array }
 */
function normalizeHunt(raw) {
  raw = raw || {};
  // 预设池：战斗预设 1~8，去重、剔非法、按用户勾选顺序保留（出兵按此序取可用者）
  var presets = [];
  var rawP = Array.isArray(raw.presets) ? raw.presets : [];
  for (var i = 0; i < rawP.length; i++) {
    var p = Number(rawP[i]) | 0;
    if (p >= 1 && p <= 8 && presets.indexOf(p) < 0) presets.push(p);
  }
  // 清单行按 key 索引（面板行序对齐 catalog，但用 key 匹配更稳）
  var byKey = {};
  var hunt = Array.isArray(raw.huntlist) ? raw.huntlist : [];
  for (var h = 0; h < hunt.length; h++) {
    var r = hunt[h];
    if (r && r.key) byKey[r.key] = r;
  }
  var segs = [];
  var entry = catalog();
  segsCatalogSig = entry.sig;
  for (var m = 0; m < entry.rows.length; m++) {
    var mo = entry.rows[m];
    var row = byKey[mo.key] || {};
    // 攻打方式：必须在该行候选内，非法/缺省回落该怪默认打法
    var mode = MODES[row.mode] && mo.modes.indexOf(row.mode) >= 0 ? row.mode : mo.defaultMode;
    // 等级：此处只存目录行的 level 作为回退值（min=max）；野怪行（pointType=1）实际搜索等级由 searchPoint 派发时调 resolveHuntLevel 反查覆盖，反查不可用才用此值（黑暗军团实测只 min=max 才回点）
    var lv = mo.level | 0;
    var mm = MODES[mode];
    var count = Math.max(0, Number(row.count) | 0);
    if (mo.maxCount > 0 && count > mo.maxCount) count = mo.maxCount; // 该行有硬上限（maxCount）则钳位
    segs.push({
      key: mo.key,
      label: mo.label,
      on: !!row.on,
      groupType: mo.groupType,
      pointType: mo.pointType,
      mode: mode,
      marchType: mm.marchType,
      rally: mm.rally,
      cost: mm.cost,
      minLevel: lv,
      maxLevel: lv,
      count: count,
      openItem: mo.openItem || 0,
    });
  }
  return {
    minStamina: Math.max(0, Number(raw.minStamina) | 0),
    autoRefill: !!raw.autoRefill,
    presets: presets,
    segs: segs,
  };
}

/**
 * 目录漂移同步：游戏表刷新 / 功能开关翻转会让目录增删行，而 MCFG.segs 只在 configure（面板改配置）时归一一次。
 * 签名不符就用现有行的 on/mode/count 重新归一：新行按目录默认态（未勾选，勾选权在用户）、下线行自动消失。
 * 每拍 cyclePass 入口调一次（目录本身有 TTL 缓存，未过期仅多一次字串比较）。
 */
function syncCatalog() {
  var snap = catalog();
  // 模块求值期读表必落（那时 `__require` 还没上全局），于是缓存里是一份种子行快照；若启动首拍落在重试 TTL（5s）之内，
  //   它会把这份快照照单收下，segs 就得等到下一次 catalog()（体力不足降频时要 600s，或直到有人开面板）才吃到表目录。
  //   此刻已过了加载窗，故主动作废缓存重读一次 —— 让启动那一拍的目录就是表目录。
  if (snap.fellBack && l10n.tableReady()) {
    catalogCache = null;
    snap = catalog();
  }
  if (snap.sig === segsCatalogSig) return;
  MCFG = normalizeHunt({
    // segs 与面板行同构（携 key/on/mode/count），直接回填即可原样保留用户已选；标量项从当前 MCFG 取回
    minStamina: MCFG.minStamina,
    autoRefill: MCFG.autoRefill,
    presets: MCFG.presets,
    huntlist: MCFG.segs,
  });
  log.info('hunt catalog drifted, segs rebuilt. segs=%d', MCFG.segs.length);
  // 行集变了：面板只刷只读格不会改 DOM（新行看不见），故带 rebuild 让那张卡重建；
  //   面板关着或焦点正在格子里时，core/ui/index.js 会先记账，等下次开面板补渲染（展开本身不重跑 buildFieldsHTML）。
  bus.emit(EVT.UI_REFRESH, { rebuild: 'autoHunt' });
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

// ── 当日计数（面板「已打」列） ──────────────────────────────────────
/** 推一次面板刷新（open 时 refreshTexts 扫 DOM 重算「已打」格）；收口事件名，多处复用。 */
function pokePanel() {
  bus.emit(EVT.UI_REFRESH);
}

/** 跳日自动归零：当前日期与持久态不同则重置 counts 并落盘（未读回前不动，防半截态）。 */
function rollDateIfNeeded() {
  if (!dailyStateLoaded) return;
  var today = todayStr();
  if (dailyState.date !== today) {
    dailyState.date = today;
    dailyState.counts = {};
    persistDaily();
  }
}

/** 异步读回当日计数（首调完成前计数按 0 处理）；读回后刷面板把 '-' 占位换成真实值。 */
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
      pokePanel();
    })
    .catch(function (err) {
      log.warn('daily state load failed, will retry next run. %s', err && err.message);
    });
}

/**
 * 保存 daily state（单飞 + 看门狗）：未读回前绝不写盘；写入靠 bridge 回执落定，回执丢失超时强制复位闸门。
 */
function persistDaily() {
  if (dailyStateSaving) return;
  if (!dailyStateLoaded) return;
  dailyStateSaving = true;
  var seq = ++saveSeq;
  var snapshot = { date: dailyState.date, counts: Object.assign({}, dailyState.counts) };
  var watchdog = setTimeout(function () {
    log.warn('daily state save pending over %dms, reset latch.', SAVE_STUCK_MS);
    releaseSaveLatch(seq);
  }, SAVE_STUCK_MS);
  Promise.resolve(storage.data.set(DAILY_STATE_NAME, snapshot))
    .catch(function (err) {
      log.warn('daily state save failed. %s', err && err.message);
    })
    .then(function () {
      clearTimeout(watchdog);
      releaseSaveLatch(seq);
    });
}

/**
 * 释放落盘单飞闸门（世代号不符＝已被看门狗复位过、闸门已属新一轮，不再处理）。
 * @param {number} seq 发起写入时的世代号
 */
function releaseSaveLatch(seq) {
  if (seq !== saveSeq) return;
  dailyStateSaving = false;
}

/**
 * 成功派发一条后本地计数 +1 + 异步落盘 + 推面板刷新。
 * @param {string} key 怪物行 key
 */
function bumpDailyCount(key) {
  rollDateIfNeeded();
  dailyState.counts[key] = (dailyState.counts[key] | 0) + 1;
  persistDaily();
  pokePanel();
}

/**
 * 面板「已打」列取值：本地当日派发计数（未读到显 '-'）。
 * @param {string} key 怪物行 key
 * @returns {string}
 */
function todayText(key) {
  if (!dailyStateLoaded) return '-';
  return String(dailyState.counts[key] | 0);
}

/**
 * 该行当日已派计数（「攻打数量」= 当日总量封顶的读值；未读到/无记录按 0）。
 * @param {string} key 怪物行 key
 * @returns {number}
 */
function dailyDone(key) {
  return dailyState.counts[key] | 0;
}

// ── 候选与派发 ──────────────────────────────────────────────────────
/**
 * 为一行搜一个可打点（906，服务端返回一个点）。永不 reject。
 * @param {object} seg 归一化清单行
 * @param {Set<string>} taken 本轮已派点键
 * @returns {Promise<{x:number,y:number}|null>}
 */
async function searchPoint(seg, taken) {
  // 等级：野怪行（pointType=1）派发时实时反查游戏本地表（随账号等级/版本闸浮动），反查不可用回落目录行的 level；
  //   集结行（战锤 pointType=3）等级由服务端下发、无法只读反查，恒用回退值。min=max 单档（黑暗军团实测不支持区间搜索）。
  var lv = seg.pointType === 1 ? resolveHuntLevel(seg.groupType) || seg.minLevel : seg.minLevel;
  if (!(lv > 0)) return null; // 等级不可得（表未就绪且该行无回退值，如新增野怪）：宁不搜，也不发 0 级档
  // 906 只读骨架（isSending 门/异常吞掉/取点）下沉 map.searchPoint；黑名单/taken 业务谓词留本 feat
  var r = await map.searchPoint(net, {
    minLevel: lv,
    maxLevel: lv,
    groupType: seg.groupType,
    pointType: seg.pointType,
  });
  var pt = r.point;
  if (!pt) return null;
  var key = (pt.x | 0) + ',' + (pt.y | 0);
  if (blacklist.has(key)) return null;
  if (taken.has(key)) return null;
  return { x: pt.x | 0, y: pt.y | 0 };
}

/**
 * 10802 PUSH_FIND_REFUGEECAMP 落点推送：把 {x,y} 交给最早的一个等待者（无等待者则忽略，可能是玩家手动开信）。
 * ctx.on.push 递来的是 Event 包装（业务坐标在 ev.data，net 层已把 e.d 串解析成 {x,y}）；
 * 直接对 Event 走 parseData 只会拿到包装体、读不到 x/y（历史 bug：营地永不落点）。
 * @param {object} ev 推送事件（Event，含 .data）
 */
function onRefugeeCampPush(ev) {
  var d = parseData((ev && ev.data) || ev) || {};
  var pos = d.x != null && d.y != null ? { x: d.x | 0, y: d.y | 0 } : null;
  var w = refugeeWaiters.shift();
  if (w) w(pos);
}

/**
 * 10802「抢在游戏原生处理器之前」观察（net.onPreInbound）：若这是我方自动开营触发的（有在途等待者），
 * 先把落点坐标登记进镜头抑制表，赶在游戏同 tick 内发起的 gotoWorldAndDo/WorldMapJumpToTile 前入表，
 * 确保吞掉那次甩镜头。非我方开营（玩家手动用信，无等待者）则不登记，让其照常飞至营地。
 * @param {object} ev Event（含 .data {x,y}）
 */
function onRefugeeCampPre(ev) {
  if (!refugeeWaiters.length) return; // 只抑我方自动开营引发的镜头
  nav.camGuard.install(); // 惰性补装（进世界图后控制器实例才在）
  var d = parseData((ev && ev.data) || ev) || {};
  if (d.x != null && d.y != null) nav.camGuard.arm(d.x | 0, d.y | 0);
}

/**
 * 难民营行是否启用（决定镜头抑制器装/摘）。openItem 非空且 on 者为道具开营类（难民营）。
 * @returns {boolean}
 */
function refugeeRowOn() {
  for (var i = 0; i < MCFG.segs.length; i++) {
    var s = MCFG.segs[i];
    if (s.openItem && s.on) return true;
  }
  return false;
}

/**
 * 依难民营行开关同步镜头抑制器的装/摘（仅运行态装；停运行由 pause 统一摘）。
 * 装：包两条跳转入口 + 抢跑登记 10802 落点；摘：还原入口 + 退订观察。
 */
function syncCamGuard() {
  if (!aliveFn() || !net) return;
  if (refugeeRowOn()) {
    nav.camGuard.install();
    if (!offCamPre) offCamPre = net.onPreInbound(PUSH_FIND_REFUGEECAMP, onRefugeeCampPre);
  } else if (offCamPre) {
    offCamPre();
    offCamPre = null;
    nav.camGuard.uninstall();
  }
}

/**
 * 开一个难民营并等其落点（道具开营，非 906）：发 815 {itemid:1700039,amount:1} → 等 10802 回推 {x,y}（cfg.refugeeWaitMs 超时）。
 * 背包无求救信 / 815 在途 / 超时未回推 / 落点已拉黑或本轮已占 → 回 null（永不 reject）。
 * @param {object} seg 归一化清单行（seg.openItem 为求救信 id）
 * @param {Set<string>} taken 本轮已派点键
 * @returns {Promise<{x:number,y:number}|null>}
 */
async function openRefugeeCamp(seg, taken) {
  var letter = seg.openItem | 0;
  if (!letter || item.amount(letter) <= 0) return null; // 背包无求救信
  if (net.isSending(CMD_ITEM_USE)) return null; // 815 在途（可能与补药撞车）→ 本轮跳过
  log.info(
    'refugee camp: using one distress letter (id=%d), send 815 to open camp, waiting for 10802 landing (timeout %dms).',
    letter,
    cfg.refugeeWaitMs,
  );
  var pos = await new Promise(function (resolve) {
    var timer = 0;
    var wrapper = function (p) {
      clearTimeout(timer);
      resolve(p);
    };
    timer = setTimeout(function () {
      var idx = refugeeWaiters.indexOf(wrapper);
      if (idx >= 0) refugeeWaiters.splice(idx, 1);
      resolve(null);
    }, cfg.refugeeWaitMs);
    refugeeWaiters.push(wrapper);
    net.send(CMD_ITEM_USE, { itemid: letter, amount: 1 }).catch(function (err) {
      log.warn('815 refugee letter use threw. %s', err && err.message);
    });
  });
  if (!aliveFn()) return null;
  if (!pos) {
    log.debug(
      'refugee camp: 815 sent but no 10802 landing push within %dms, give up this camp this round.',
      cfg.refugeeWaitMs,
    );
    return null;
  }
  log.info('refugee camp: 10802 landing at x=%d y=%d.', pos.x, pos.y);
  var key = pos.x + ',' + pos.y;
  if (blacklist.has(key) || taken.has(key)) return null;
  return pos;
}

/**
 * 发一条打野行军 902（单打/5连）：经 core/march.attack 统一组 canonical body + isSending(902) 去重。永不 reject。
 * @param {{x:number,y:number}} coord 目标点
 * @param {number} marchType 5 单打 / 42 5连
 * @param {object} plan MarchData
 * @returns {Promise<object>} net.Ret
 */
async function sendAttack(coord, marchType, plan) {
  return await march.attack({
    marchType: marchType,
    target: { x: coord.x, y: coord.y },
    data: plan,
  });
}

/**
 * 创建集结 1201（战锤集结）：feat 直发（同 alliance-rally 的 1204 不下沉 core）。body 逐键照抄 192612 seq39/183114（无 break/extraArmy）。
 * isSending(1201) 去重。永不 reject。
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

/**
 * 用一枚体力药剂（815 ITEM_USE {itemid,amount:1}）。镜像靠随后 10021 推送刷新，此处只发不等。永不 reject。
 * @param {number} itemId 药剂 itemId
 * @returns {Promise<void>}
 */
async function useStaminaItem(itemId) {
  var ret = await net.sendGuarded(
    CMD_ITEM_USE,
    { itemid: itemId, amount: 1 },
    {
      onError: function (err) {
        log.warn('815 use threw. %s', err && err.message);
      },
    },
  );
  if (ret && ret.ok) log.info('used stamina potion. itemId=%d', itemId);
}

// ── 周期引擎 ────────────────────────────────────────────────────────
/**
 * 单轮主体：体力闸 →（不足则补药/退避）→ 达标后轮转补缺位（每轮给每个仍有缺位的行各派 1 条 → 搜点 → 池里挑可用预设 → 派发），多行均分名额。
 * 早退只置 backlogActive / waitingEnergy，下拍间隔由 cycleRun 末尾统一裁决。
 * @returns {Promise<void>}
 */
async function cyclePass() {
  syncCatalog(); // 目录漂移（赛季新增/下线怪物、功能开关翻转）先同步进 segs，再取当拍勾选行
  var segs = [];
  for (var i = 0; i < MCFG.segs.length; i++) {
    var s = MCFG.segs[i];
    if (s.on) segs.push(s);
  }
  if (!segs.length) {
    backlogActive = false;
    return;
  }
  if (!MCFG.presets.length) {
    backlogActive = false;
    log.debug('no hunt preset configured, idle.');
    return;
  }

  // 体力边界闸（全局下限）
  var en = gameData.energy(STAMINA_TYPE);
  var stamina = en ? en.point : null;
  if (stamina == null) {
    // 体力镜像读不到（未就绪）：本轮不动，按 active 档稍后再判
    backlogActive = true;
    return;
  }
  if (stamina < MCFG.minStamina) {
    waitingEnergy = false;
    if (!MCFG.autoRefill) {
      backlogActive = false; // 未勾自动补药：等自然回体（10021 唤醒 / idle 兜底重判）
      log.debug('stamina %d < min %d, refill off, idle.', stamina, MCFG.minStamina);
      return;
    }
    var pot = item.pickMostHeld(STAMINA_POTS);
    if (!pot) {
      backlogActive = false; // 想补但无货：空转退避（idle 档）
      log.debug(
        'stamina %d < min %d, refill on but no potion held, idle.',
        stamina,
        MCFG.minStamina,
      );
      return;
    }
    await useStaminaItem(pot.itemId);
    waitingEnergy = true; // 用药后走短档等 10021 刷新再判
    return;
  }
  waitingEnergy = false;

  // 跳日归零：当日已派计数跨自然日重置，令「攻打数量」的当日封顶按新日重新起算
  rollDateIfNeeded();

  // 全局名额闸门
  var free = march.freeSlots();
  if (free <= 0) {
    log.debug('no free march slot, wait for arrival wake.');
    backlogActive = true;
    return;
  }

  var taken = new Set();
  var attempted = 0;
  var succeeded = 0;
  // 轮转派发（雨露均沾）：本轮每个勾选行最多派 1 条，且起始行按持久游标 rrCursor 轮转，
  // 使空闲名额优先轮到「上次排在末尾」的行，杜绝固定首行（如不限的黑暗陆军）在单拍内吃满共享行军队列、把其余勾选行饿死。
  // 未填满的空闲名额留 active 档 / 回城唤醒，下一拍游标后移继续均摊，逐拍把各行的在途数拉平。
  var n = segs.length;
  for (var step = 0; step < n && free > 0; step++) {
    var si = (rrCursor + step) % n;
    var seg = segs[si];
    // 「攻打数量」= 该行当日总量上限：当日已派满 count 个即停手（跨自然日 rollDateIfNeeded 归零）；未读到当日计数前保守不派封顶行，防启动瞬间误发；count=0(不限) 不受此限
    if (seg.count > 0 && (!dailyStateLoaded || dailyDone(seg.key) >= seg.count)) continue;
    if (stamina < seg.cost) continue; // 体力不够该档（如 10 人集结扣 20），跳过该行不硬发
    // 集结行需已在联盟（游戏 getAutoHuntMonsterList 对 searchType>=3 的同口径闸）：明确不在盟即跳过，不白吃一次 1201 真拒（真拒会拉黑那个点）。
    //   inAlliance() 回 null=符号未就绪、无从判定 → 放行，保持改造前行为（把读不到当「不在盟」会误停整类集结）
    if (seg.rally && gameData.inAlliance() === false) {
      if (!rallyNoAllianceNoted) {
        rallyNoAllianceNoted = true;
        log.info(
          'rally rows selected but not in an alliance, rally rows are skipped until joining one.',
        );
      }
      continue;
    }
    // 道具开营类（难民营）：背包无求救信即自动忽略该行（用户口径），不占本轮名额
    if (seg.openItem && item.amount(seg.openItem) <= 0) {
      if (!refugeeNoLetterNoted) {
        refugeeNoLetterNoted = true;
        log.info(
          'refugee camp selected, but inventory reads distress letter (id=%d) amount=%d, treated as no-letter and this row is skipped. If letters really exist, it is usually that the tool bag was not synced into UserData._items after login (getItemAmount only reads _items) — using one letter to trigger 10401 PUSH_TOOL will restore reading.',
          seg.openItem,
          item.amount(seg.openItem),
        );
      }
      continue;
    }
    var sendCmd = seg.rally ? CMD_CREATE_RALLY : CMD_MARCH_WORLD_POINT;
    if (net.isSending(sendCmd)) {
      backlogActive = true;
      break; // 同类写请求在途：本轮到此为止，交下拍/唤醒续派
    }
    var cand = seg.openItem ? await openRefugeeCamp(seg, taken) : await searchPoint(seg, taken);
    if (!aliveFn()) return;
    if (!cand) continue; // 该行暂无合格候选（906 无点 / 开营未回推）→ 跳过该行，不影响其它行本轮的均摊
    var plan = buildPlanFromPool(MCFG.presets);
    if (!plan) {
      log.debug('all hunt presets out of troops this cycle. seg=%s', seg.label);
      backlogActive = true;
      break; // 全池无兵：整体等回城唤醒，不再逐行空搜
    }
    var ck = cand.x + ',' + cand.y;
    var ret = seg.rally
      ? await createRally(cand, plan)
      : await sendAttack(cand, seg.marchType, plan);
    if (!aliveFn()) return;
    attempted++;
    if (ret.ok) {
      taken.add(ck);
      rateLimitStreak = 0;
      free--;
      // 集结按已知档位扣减估算体力（单打/5连 cost=0 不估算，交由服务器拒 + 退避收敛）
      stamina = Math.max(0, stamina - seg.cost);
      succeeded++;
      bumpDailyCount(seg.key); // 本地当日已打 +1
      log.info('hunt march ok. seg=%s mode=%s x=%d y=%d', seg.label, seg.mode, cand.x, cand.y);
    } else {
      var errKey = rejectErrKey(ret.data);
      if (errKey === ERR_RATE_LIMIT) {
        rateLimitStreak++;
        log.info(
          'hunt march rate-limited, stop burst and back off. seg=%s streak=%d',
          seg.label,
          rateLimitStreak,
        );
        break; // 撞全局限流：中止本轮剩余行，交退避定时统一重试
      }
      blacklist.add(ck); // 点失效/被抢等真拒：拉黑换下一候选（本轮该行该次作废）
      log.info(
        'hunt march rejected. seg=%s x=%d y=%d code=%s why=%s',
        seg.label,
        cand.x,
        cand.y,
        ret.code,
        errKey || '-',
      );
    }
    if (free > 0) await sleep(cfg.marchInterval); // 逐条之间休眠，防 marches 入表延迟超发 + 规避行军时间限流
  }
  // 游标后移一位：把「优先补派」权轮给下一行，跨拍均摊（n<=0 时保持 0）
  if (n > 0) rrCursor = (rrCursor + 1) % n;
  // 当日仍有额度未打满的封顶行 → active 档尽快续派；不限行（count=0）只要有空闲名额也留 active；全部封顶行已打满且无不限行 → idle（勿空转）
  var remaining = 0;
  var hasUnlimited = false;
  for (var ri = 0; ri < segs.length; ri++) {
    if (segs[ri].count > 0) remaining += Math.max(0, segs[ri].count - dailyDone(segs[ri].key));
    else hasUnlimited = true;
  }
  backlogActive = remaining > 0 || (hasUnlimited && free > 0);
  if (attempted)
    log.debug(
      'cycle dispatched. attempted=%d succeeded=%d remaining=%d',
      attempted,
      succeeded,
      remaining,
    );
}

/**
 * 单轮调度：跑 cyclePass → 返回下拍间隔（毫秒；<=0=立即补扫）。
 * 择时优先序：限流退避 > 用药后等体力 > 本轮在飞有外部触发 > active/idle 两档。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  await cyclePass();
  if (rateLimitStreak > 0) {
    return Math.min(
      cfg.rateLimitBackoffMs * (1 << Math.min(rateLimitStreak - 1, 5)),
      cfg.rateLimitBackoffMaxMs,
    );
  }
  if (waitingEnergy) return cfg.energyRecheckMs;
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

// ── 推送入口 ────────────────────────────────────────────────────────
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

/** @type {Function|null} march.onHomeReturn 退订句柄（防 resume 重激活重复注册） */
var offHomeReturn = null;

/** @type {Function|null} 难民营镜头抑制：net.onPreInbound(10802) 退订句柄（随难民营行开关装/摘） */
var offCamPre = null;

/**
 * 行军到家（10019 复播）→ 名额释放 + 目标可能刷新 → 唤醒补派。
 * 只认本 feat 的打野类行军（marchType 5/42/8）回城；延迟 1.5s 给英雄释放推送落地（同 auto-farm 副防线）。
 * @param {object} m 归一化 March
 */
function onHuntMarchHome(m) {
  if (!aliveFn()) return;
  var mt = m && m.type | 0;
  if (mt !== MT_ATTACK && mt !== MT_COMBO && mt !== MT_RALLY) return;
  setTimeout(function () {
    if (aliveFn()) pushWake();
  }, 1500);
}

/**
 * 10021 体力推送：体力变化（回体 / 用药 / 讨伐扣减）→ 去抖唤醒重判体力闸。
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
  tableReadAllowed = true; // 本拍已远晚于 bundle 就位：目录从这里开始才该读表
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
 * @param {object} partial reactor 推送的 { enabled, minStamina, autoRefill, presets, segs }（toModuleCfg 产出）
 * @returns {object} MCFG
 */
function configure(partial) {
  if (!partial || !partial.segs) return MCFG;
  MCFG = partial;
  syncCamGuard(); // 难民营行可能被勾选/取消 → 同步镜头抑制器
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
  waitingEnergy = false;
  rateLimitStreak = 0;
  lastPushWakeAt = 0;
  blacklist = new Set();
  refugeeWaiters = [];
  refugeeNoLetterNoted = false;
  rallyNoAllianceNoted = false;
  ensureDailyLoaded(); // 读回当日已打计数（面板「已打」列与本地计数闸门依赖）
  ctx.on.push(PUSH_ENERGY, onEnergyPush);
  ctx.on.push(PUSH_FIND_REFUGEECAMP, onRefugeeCampPush);
  if (offHomeReturn) offHomeReturn(); // 先退再挂，防 resume 重激活重复注册
  offHomeReturn = march.onHomeReturn(onHuntMarchHome);
  syncCamGuard(); // 难民营行启用则装镜头抑制 + 抢跑登记 10802 落点
  var onSegs = 0;
  for (var i = 0; i < MCFG.segs.length; i++) if (MCFG.segs[i].on) onSegs++;
  log.info('started. presets=%d segsOn=%d', MCFG.presets.length, onSegs);
  cycle.kick();
}

/**
 * 停用：收 march.onHomeReturn 常驻复播句柄（非 ctx 级、框架不代退）；cycle 靠 alive() 自然停摆，无需显式收定时器。
 */
function pause() {
  if (offHomeReturn) {
    offHomeReturn();
    offHomeReturn = null;
  }
  if (offCamPre) {
    offCamPre();
    offCamPre = null;
  }
  nav.camGuard.uninstall(); // 摘镜头抑制：还原游戏跳转方法
  // 收摊时唤醒所有在途「等 10802」的 resolver（回 null），避免 openRefugeeCamp 挂到超时才醒
  var ws = refugeeWaiters;
  refugeeWaiters = [];
  for (var wi = 0; wi < ws.length; wi++) ws[wi](null);
}

// ── 面板 descriptor ─────────────────────────────────────────────────
/**
 * 生成 defaults：全局项 + 怪物清单行（注册时按当时目录铺一次默认值；实际行集以面板每次渲染的 catalog getter 为准）。
 * 每种怪一行，默认未勾选、数量 1、该行默认打法；等级不入配置（固定搜最高档）。
 * @returns {object}
 */
function buildDefaults() {
  var huntlist = catalog().rows.map(function (mo) {
    return {
      key: mo.key,
      count: 1,
      mode: mo.defaultMode,
      on: false,
    };
  });
  return {
    enabled: false,
    minStamina: 0,
    autoRefill: false,
    presets: [],
    huntlist: huntlist,
  };
}

/**
 * 目录行 → 面板 huntlist 的 catalog 行（descriptor 形态）：补 levelMode（野怪行运行时反查、标题标「动态」）与攻打方式选项标签。
 * @param {object} mo 目录行（buildCatalog / MONSTERS_SEED 同构）
 * @returns {object}
 */
function huntCatalogRow(mo) {
  return {
    key: mo.key,
    label: mo.label,
    groupType: mo.groupType,
    pointType: mo.pointType,
    level: mo.level,
    // 野怪行（pointType=1 且非道具开营）等级运行时反查，title 提示标「动态」；其余（集结/难民营）为固定回退值
    levelMode: mo.pointType === 1 && !mo.openItem ? 'dynamic' : 'fixed',
    defaultCount: 1,
    defaultOn: false,
    defaultMode: mo.defaultMode,
    maxCount: mo.maxCount,
    openItem: mo.openItem || 0,
    modes: mo.modes.map(function (mk) {
      return { value: mk, label: MODES[mk].label };
    }),
  };
}

/**
 * 生成 fields：全局区（体力下限 / 自动补药 / 打野预设池）+ 怪物清单（表格，行集由 catalog getter 实时给出）。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: 'minStamina',
      label: '体力下限(≥才开打)',
      type: 'number',
      min: 0,
      step: 1,
      hint: '体力低于此值即停手；配 0 = 不设门槛',
    },
    {
      key: 'autoRefill',
      label: '体力不足自动补药',
      type: 'checkbox',
      hint: '勾选则体力不足时自动用持有量最多的体力药剂补足；不勾则不足即空转等回体',
    },
    {
      key: 'presets',
      label: '打野预设池',
      type: 'presetpool',
      max: 8,
    },
    {
      key: 'huntlist',
      label: '怪物清单',
      type: 'huntlist',
      // 目录 getter：面板每次渲染实时反查游戏表（新增/下线怪物自动增减行，无需再改本 feat）。
      //   wire 的 huntlist align 钩子会按本 catalog 全量对齐存档行（逐 key 保留已存值、补齐新行、剔除下线行），
      //   所以 getter 绝不能返空（catalog() 已保证难民营行恒在）。
      get catalog() {
        return catalog().rows.map(huntCatalogRow);
      },
      todayText: todayText,
    },
  ];
}

reactor.register({
  id: 'autoHunt',
  label: '自动打野',
  storageKey: 'pocketcc.feat.autoHunt',
  symbols: ['presetMarch', 'heroController', 'mechaController', 'formationAdv', 'marchStorage'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: function (c) {
    return normalizeHunt(c);
  },
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
