/**
 * 自动下田（autoFarm）- 日常 feat：按规则行维持「普通资源田 + 联盟机械田（资源塔） + 6 级田（扫图发现）」的在途采集
 *
 * 用户口径（一行 = 一个田位）：选田类型(金/粮/油/雷神) + 田等级 + ☑只下机械田 + 预设部队(1~16：1~8 战斗预设、9~16 采集预设)。
 * 取田优先级：田等级 <6 时一律优先机械田——先从「联盟机械田活表」按家族命中、按「剩余存活时间」降序（充足优先），并定点 901 确认仍在才下田；
 *   田等级 =6 既无机械田、906 也搜不到（只分布在两块特定区域），走低频分块扫图候选池（见下方「6 级田」段）。
 *   ☐只下机械田（未勾）→ 机械田没有（未命中/快结束/已毁/探针失败）时回退按类型+等级搜普通田；☑只下机械田 → 只看机械田，没有则本行不下（绝不回退普通田）。
 * 雷神矿(family16) 田等级上限 3 级（面板联动封顶）。每行维持 1 条在途采集；缺位（到家/被撤/阵亡）即唤醒补派。
 * 一个矿（含机械田）只能一支部队驻扎：探索到的候选点若已在本人行军表中（去程/到达/采集中）则跳过（返程已让出矿位、不计）。
 * 补派前查全局出征队列名额，不足只等待、不主动撤田（撤田语义保留给「占领发射井」feat，
 * 其撤田造成的缺位会由 10019 回城唤醒自动补回）。本轮无合格候选 → 空闲降频等下个唤醒周期。
 * 名额经 core/march.freeSlots() 读取，已扣除其它高优 feat（发射井撤田腾坑）的预约：
 *   故发射井活动期内撤田腾出的坑会被它留住驻井，本 feat 不会抢着回填（避免撤田↔补田震荡）。
 *
 * 下田时段（可选，面板「启用下田时段」勾选 + 多行「起始~结束」时段）：仅当启用且配了至少一行时段时生效。
 *   时段内→照常按规则行维持下田；时段外→立即逐条 904 撤回全部在途田（recallAllFarms），本轮不下田，
 *   睡到下个时段起点再自动恢复下田。任一时段命中即在窗口内；start>end 视为跨午夜、start===end 视为全天。
 *   判定用本地墙钟（国服=用户本地钟）。未勾选/无时段时视为全天可下田（与旧版行为一致，向后兼容）。
 *   边界主动唤醒：无论时段内/外，下一拍都按「下个边界（任一时段的起或止）」夹时，到点即醒做一次检测（窗口止→立即撤田、新窗口起→立即下田），不因 idle/退避长睡错过边界。
 *   时段外的主动撤田是本 feat 自有的例外（区别于「名额不足不主动撤田」——后者仍保留给发射井）。
 *
 * 候选来源（两份 dashcam 录制 + extracted 逆向源码交叉实证）：
 *   普通田 —— 服务端搜索 WORLD_SEARCH_MONSTER(906)：请求 {minLevel, maxLevel, groupType, pointType:2}，
 *        应答 {point:{r:{itemId,amount,expireTime,ownerId('0'=无主),aid}, x, y, pointType:4}}，服务端直接返回一个可采点。
 *        groupType = RESOURCE 表里 (家族, 等级) 对应行的 id；家族 = floor(id/100)（1油/5粮/7金/16雷神），
 *        等级取该行 .level 字段（实证：id 506 的 level=5、1603 的 level=3——不是 itemId%100）。
 *   机械田 —— 联盟记录发现（视口无关，覆盖全联盟任意地点）：一次性发 ALLIANCE_RECORD_DATA(1193) 全量 +
 *        订阅 push PUSH_ALLIANCE_RECORD(10452)，把「建造 N级<设施>完毕」记录解析成 {x,y,family,level,ts(建成时刻≈btime)}（设施名→家族：
 *        采金=金7/炼油=油1/谷仓=粮5/提纯=雷神16，与 RES_FAMILY_BY_TOWER 的 bid 家族一致；坐标取渲染文本末个 "(x,y)"）灌进活表；
 *        实证塔存活 <10h，故只收 10h 内记录、超期老化剔除。剩余存活时间 = ts + MAP_BUILDING[bid].duration − serverTime（零额外发包）。
 *        摧毁无记录 → 下田前按剩余时间降序对候选定点 901 GET_WORLD_INFO 确认该点仍是本盟已建成资源塔
 *        （pointType24 & st=3 & aid=本盟 & bid 家族匹配）才发 902；剩余不足 MECH_MIN_REMAIN_SEC 的「快结束」塔直接剔除；探到已毁即移出活表+拉黑、换下一候选。
 *        容量闸：901 无驻军字段，故对存在性通过的候选再发 1034 GET_TOWERINFO{id} 取 army_size，配 MAP_BUILDING[bid].force_capacity 判满
 *        （army_size≥上限=已采满、与游戏 NWorldTowerPopup 同口径 force_capacity−army_size≤0）→ 跳过换下一候选（不拉黑，稍后可能有队返采腾出空间），避免向满塔发 902 吃拒。
 *   902  MARCH_WORLD_POINT 下田：普通田 marchType=3，机械田 marchType=26；载荷只需 {marchType,x,y,army…}（服务器按坐标定位点），
 *        形状照抄录制（含 break:0）。902 被拒零成本，拉黑该点换下一候选；但限流类拒（march_time_control_info001）例外：
 *        田点本身有效、不拉黑，改为中止本轮剩余行 + 指数退避重排下轮（启动多行连发时尤其易撞，操作过快）。
 *   6 级田 —— 906 搜不到，且**不是定时刷新**：仅当联盟成员「刷新王者遗迹（资源遗迹）」时，服务器在两个固定锚点 (408,308)/(408,648)
 *        周围批量开出无主 6 级田（竞品B/真机报文实证：pointType 恒 38、家族取 RESOURCE[itemId].resource_type、r.aid=刷新盟）。扫图高危 → 不轮扫、只邮件驱动：
 *        触发信号 = push PUSH_SINGLE_MAIL(10264) 标题「遗迹区域刷新」（正文含 坐标(x,y)=锚点 & 刷新时刻 sendTime & 资源类型 农田/油田/金矿）；
 *        有效窗口 = **4 小时**（实证：田 expireTime ≈ 刷新邮件 sendTime + 14400s；过期即无主消失，真机数据「过期&无主」恒 0）；
 *        **扫图与派兵拆为两个独立 cycle**：派兵 cycle 只从候选池 lvl6Pool 读点取田，不触发扫图；扫图 cycle（relicCycle/relicScanPass）专司扫图：
 *          ① 邮件列表轮询（L6_MAIL_POLL_MS，廉价、游戏本身就在读）与 10264 推送喂同一 (锚点,sendTime) 去重闸 lvl6Scanned，
 *             同封邮件被多次检测只扫一次、且自愈「推送漏达 / feat 上来时刷新邮件已到达」（mailManager 由 subpack 晚载入，未就绪则下拍自然重探）；
 *          ② 家族闸：按邮件正文资源类型解析 family，未勾选该家族则整锚点不扫（省 5 窗高危 901），未知文案 fail-open 照扫；
 *          ③ 消费待扫锚点时对其实行发竞品B口径 5 窗 901（窗心 (x∓60, y−40)/(x∓60, y+40) 四块 + (x−60, y+120)，窗 60×90 viewLevel1，窗间 sleep 2s）收集无主点入池；
 *        候选池 lvl6Pool **落 storage.slot 持久化**（LVL6_STORE_KEY，跨刷新页保留、免重扫高危 901），按 expireTime 老化（serverTime≥expireTime 即删），无刷新邮件则完全不扫；
 *        取田排序「无主优先→最快到期→距本城最近」，超新鲜期 L6_FRESH_MS 的候选派前单点 901 复验仍无主才发 902（持久化的「空闲」可能已过期/被抢，复验不可省）；
 *        6 级点位被拒改记「解禁时刻」L6_BLOCK_MS（下次刷新会复活），不同于普通田/机械田的 run 期硬拉黑；
 *        pointType/家族判据与 5 窗布局照抄竞品B（refreshRelicResources），全收敛在 lvl6PointEntry / relicScanPass 便于真机校准。
 *   10019 USER_MARCH_INFO push：state=4（ARRIVED_HOME）到家才释放名额，作「缺位即唤醒」的触发源。
 *
 * 账本：storage.data['autoFarm'] 按 UID 隔离，rowIdx → [{marchId,x,y,marchType}]，每行至多 1 条；902 成功即记、
 * 在途消失即销；重开页面后认领 856 GET_ALL_MY_MARCH_INFO 的现存采集行军（坐标取 marchInfo.target.tx/ty、状态取 state）回填账本，避免重复下田。
 * 在途核对 / 占用判定均以 856 全量本人行军为权威源（视口无关，Home 场景亦有；mapData.marches 在 Home 为空、进出世界地图被清空重建，故不作真相）。
 *
 * 生命周期由 reactor 托管：places 限定 base/world（Home/NWorldMap），战斗模式暂停（offInCombat）；
 * 触发源（run 点火 / 10019 回城 / 配置变更 / 兜底定时）全部汇入 cycle.kick，在飞合并为一次补扫。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { gameData, l10n, mail } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { storage } from '../../core/storage.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { createCycle } from '../../core/cycle.js';
import { map } from '../../core/map.js';
import { screen } from '../../core/net-guard.js';
import { getUid } from '../../core/player.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=AUTO-FARM） */
const log = createLog('AUTO-FARM');

/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（下田） */
const CMD_MARCH_WORLD_POINT = 902;
/**
 * @type {string} 902 拒绝载荷里“操作过快”的服务器全局限流文案键（字典：march_time_control_info001=操作过快，请重新尝试）。
 * 与“点被抢/已失效”的真拒不同：田点本身有效，不应拉黑；命中即中止本轮剩余行、按指数退避重排下轮。
 */
const ERR_RATE_LIMIT = 'march_time_control_info001';
/** @type {number} RequestId.WORLD_SEARCH_MONSTER：服务端按 (家族,等级) 搜索一个可采资源点 */
const CMD_WORLD_SEARCH_MONSTER = 906;

/** @type {number} 行军类型：普通资源田采集（NMarchType.GATHER_RESOURCE） */
const KIND_FARM = 3;
/** @type {number} 行军类型：联盟机械田（资源塔）采集（枚举名 ATTACK_TOWER，复用值 26） */
const KIND_TOWER = 26;
/** @type {number} 实体类型：资源塔（NWorldMapEntityType.ResourceTower = 901 pointType = 24） */
const POINT_TYPE_TOWER = 24;
/** @type {number} TowerState.COMPLETE：塔建造完成、可采集 */
const TOWER_STATE_COMPLETE = 3;
/** @type {number} 906 搜索分类 pointType：资源 tab（1野怪/2资源/3集结/4国宝） */
const SEARCH_POINT_TYPE_RESOURCE = 2;
/** @type {number} RequestId.ALLIANCE_RECORD_DATA：全量拉联盟记录（含「建筑」机械田建造事件，视口无关） */
const CMD_ALLIANCE_RECORD_DATA = 1193;
/** @type {number} RequestId.GET_TOWERINFO：查资源塔详情（应答 army_size=当前驻军兵力，配 MAP_BUILDING[bid].force_capacity 判满） */
const CMD_GET_TOWERINFO = 1034;
/** @type {number} push PUSH_ALLIANCE_RECORD：联盟记录增量推送（新建成机械田即时并入活表） */
const PUSH_ALLIANCE_RECORD = 10452;
/** @type {number} 机械田记录/活表最大年龄（秒）：实证塔存活 <10h，超期视为已毁不再下田 */
const MECH_MAX_AGE_SEC = 10 * 3600;
/** @type {number} 单轮每行机械田存在性探针上限（候选过多时限流，超出本轮回退普通田、下轮再试） */
const MECH_PROBE_CAP = 6;
/**
 * @type {number} 1193 全量重拉的最小间隔（毫秒，漏推自愈）：mechLive 靠 10452 增量推送维持，但推送可能整批漏达
 * （MV3 service worker 休眠/网络抖动/切场景），而条目又被 pruneMechLive 按 10h 老化——长时间挂机后活表会「只减不增」
 * 清空、永久找不到机械田。故到点即重拉一次全量（并入不清空、单请求廉价），把漏掉的在建塔补回。远小于塔存活 10h。
 */
const MECH_REFRESH_MS = 20 * 60 * 1000;
/**
 * @type {number} 机械田最小剩余存活时间（秒）：排序后剩余不足此值的塔视为「快结束」直接剔除，
 * 免得派兵跑到一个将到期（甚至往返路上就消失）的田上。仅在能查到存活时长时生效。
 */
const MECH_MIN_REMAIN_SEC = 10 * 60;

/**
 * 6 级田事件驱动常量：6 级田不是定时刷新，而是联盟成员「刷新王者遗迹」时由服务器在固定锚点周围批量开出（竞品B/真机报文实证）。
 * 扫图高危 → 不轮扫，只由刷新邮件（PUSH_SINGLE_MAIL 10264、标题「遗迹区域刷新」）触发；田自带 expireTime 为权威到期时刻。
 * 锚点 (408,308)/(408,648) 与 5 窗布局照抄竞品B refreshRelicResources（M=0..4 → x+(M%2−0.5)·120、y+(⌊M/2⌋−0.5)·80，窗 60×90、viewLevel1）；请求 x,y 为回点区中心（记忆陷阱口径）。
 */
/** @type {Array<{x:number,y:number}>} 两个王者遗迹（资源遗迹）锚点（竞品B relices 实证；刷新邮件正文坐标即落此二者之一） */
const L6_RELIC_ANCHORS = [
  { x: 408, y: 308 },
  { x: 408, y: 648 },
];
/** @type {number} 窗口尺寸（game 格，901 请求体 width/height，竞品B refreshRelicResources 口径 60×90） */
const L6_WIN = { w: 60, h: 90 };
/**
 * @type {Array<{dx:number,dy:number}>} 锚点周围 5 窗窗心偏移（照抄竞品B refreshRelicResources：M=0..4 → x+(M%2−0.5)·120、y+(⌊M/2⌋−0.5)·80）。
 * 即上下两排 x∓60 共四块 + 一块 (x−60, y+120)：窗 60×90 对应 x∈[−90,+90]、y∈[−85,+165]，覆盖遗迹刷新辐射带。
 */
const L6_WINDOWS = [
  { dx: -60, dy: -40 },
  { dx: 60, dy: -40 },
  { dx: -60, dy: 40 },
  { dx: 60, dy: 40 },
  { dx: -60, dy: 120 },
];
/** @type {number} 刷新邮件有效期（秒）：启动读邮件缓存时，只回溯 serverTime−sendTime < 此值的刷新（田 expireTime 仍为准，此仅门控要不要补扫） */
const L6_MAIL_FRESH_SEC = 4 * 3600;
/** @type {number} 同一锚点刷新扫描的整轮失败重试上限（防网络持续异常时无限重发 5 窗高危请求） */
const L6_SCAN_RETRY_MAX = 2;
/** @type {number} 候选条目「可直接采信」的新鲜期（毫秒）：超期条目派前须单点 901 复验（复验后 ts 刷新，避免每拍重复探针） */
const L6_FRESH_MS = 10 * 60 * 1000;
/** @type {number} 6 级候选被拒后的拉黑时长（毫秒）：田下次刷新会复活，到期自动解禁（异于普通田/机械田的 run 期硬拉黑） */
const L6_BLOCK_MS = 30 * 60 * 1000;
/** @type {number} 单轮取田最多派前复验探针数（防一拍连发多枚 901） */
const L6_PROBE_CAP = 2;
/** @type {number} 一次锚点刷新内 5 窗扫图请求之间的串行间隔（毫秒，用户口径 2s，免瞬时并发对服务器加压） */
const L6_SCAN_GAP_MS = 2 * 1000;
/**
 * @type {number} 无待扫锚点时扫图 cycle 的邮件列表轮询兜底节拍（毫秒）：读邮件廉价（游戏本身就在读），
 * 与 10264 推送喂同一去重闸，自愈「推送漏达 / feat 上来时刷新邮件已到达」——竞品 B 同 60s schedule 口径。
 */
const L6_MAIL_POLL_MS = 60 * 1000;
/** @type {string} 6 级田候选池独立存储键（storage.slot 下、UID 前缀隔离，与账本 blob 互不牵连写放大） */
const LVL6_STORE_KEY = 'autoFarm.lvl6';
/**
 * @type {number} 候选池存储结构版本：非本版本的一律丢弃不回填。
 * v1 错在把 resource_type 当面板家族恒等编号（实际 5=石油、7=粮食，池内标签整体错位），v2 修正后需让旧池作废重扫重建。
 */
const LVL6_STORE_VER = 2;
/** @type {number} 901 pointType=38 要塞/遗迹资源点（王者遗迹刷新出的 6 级田，真机 914/914 实证恒 38，r 载荷带 itemId） */
const POINT_TYPE_FORTRESS_RES = 38;
/** @type {number} push PUSH_SINGLE_MAIL：单封邮件推送（「遗迹区域刷新」6 级田开田信号，载荷含 title/content/sendTime） */
const PUSH_SINGLE_MAIL = 10264;
/** @type {string} 6 级田开田邮件标题（国服中文实证文案；竞品B 同口径字面比较） */
const L6_MAIL_TITLE = '遗迹区域刷新';
/**
 * RESOURCE 表 resource_type（游戏 ResourceType 枚举）→ 本 feat 面板资源家族编码（面板码 = floor(RESOURCE.id/100)：1 油 / 5 粮 / 7 金 / 16 雷神）。
 * ❗两套编号不同源，**不是恒等**：resource_type 真值为 1=Coin(金矿) / 5=Oila(石油) / 7=Soil(粮食) / 20=ThorElements(雷神)——
 *   报文实证 raw assets/Script/index.2dd40.js 战斗图标分支直接拿该字段比枚举（a === ResourceType.Coin / .Soil / .Oila），
 *   GameDefine.ResourceNameConst 亦证 5→110118「石油」、7→110121「粮食」；竞品B buildTower 的 [7,5,1,20] 配 谷仓/炼油/采金/提纯 同口径。
 * 6 级田的 r.itemId（1514/1515 等）不是 RESOURCE 行的 groupType id，floor(itemId/100)=15 会拒掉全部真田 → 家族只认 resource_type 再按本表换算。
 * @type {Object<number,number>}
 */
const L6_RES_TYPE_TO_FAMILY = { 1: 7, 5: 1, 7: 5, 20: 16 };
/**
 * 刷新邮件正文「资源类型为 X」的中文文案 → 面板资源家族编码（报文实证 农田=粮(5)/油田=油(1)；金矿=金(7) 按 RESOURCE 名称推断，
 * 雷神(16) 田上限 3 级、6 级刷新不出现故不收）。未命中回 0 → parseRelicMail 按 fail-open 照扫（家族真值以扫回点位 resource_type 为准）。
 * @type {Object<string,number>}
 */
const L6_MAIL_TYPE_TO_FAMILY = { 农田: 5, 油田: 1, 金矿: 7 };

/** @type {number[]} 合法资源家族编码：1 石油 / 5 粮食 / 7 金矿 / 16 雷神 */
const RES_FAMILIES = [1, 5, 7, 16];
/**
 * 塔家族（floor(bid/1000)）→ 资源家族编码反查表（51 金塔 / 52 油塔 / 53 粮塔 / 71 雷神塔）。
 * @type {Object<number,number>}
 */
const RES_FAMILY_BY_TOWER = { 51: 7, 52: 1, 53: 5, 71: 16 };
/**
 * 联盟记录文本里的设施名 → 资源家族编码（与 RES_FAMILY_BY_TOWER 的 bid 家族口径一致）：
 * 采金=金矿(7) / 炼油=石油(1) / 谷仓=粮食(5) / 提纯=雷神(16)。仅匹配中文（本工具面向国服）。
 * @type {Object<string,number>}
 */
const FACILITY_FAMILY = { 采金: 7, 炼油: 1, 谷仓: 5, 提纯: 16 };
/**
 * 资源家族编码 → 塔 bid 前缀（RES_FAMILY_BY_TOWER 的反向）：金(7)→51 / 油(1)→52 / 粮(5)→53 / 雷神(16)→71，
 * 供由 (family,level) 反推 bid（= 前缀·1000+等级）去 MAP_BUILDING 表查存活时长 duration。
 * @type {Object<number,number>}
 */
const TOWER_PREFIX_BY_FAMILY = { 7: 51, 1: 52, 5: 53, 16: 71 };

/** @type {string} 账本逻辑键（storage.data 下，UID 前缀隔离） */
const LEDGER_NAME = 'autoFarm';

/**
 * 内置调优常量（面板不暴露；active/idle 两档兜底定时同 domain-treasure 惯例）
 * @type {object}
 */
const cfg = {
  /** 仍有缺位未补上时的兜底扫描间隔（毫秒）：1 分钟 */
  activeScanInterval: 1000 * 60,
  /** 全部田位都在途时的兜底间隔（毫秒）：10 分钟（正常靠 10019 唤醒，这里只是断推兜底） */
  idleScanInterval: 1000 * 60 * 10,
  /** 逐条 902 之间的休眠（毫秒）：防 marches 入表延迟导致同轮超发，同时拉开间隔规避服务器行军时间限流 */
  marchInterval: 1000 * 8,
  /** 推送唤醒补扫的最小间隔（毫秒）：合并突发回城推送 */
  pushScanMinGap: 1000 * 4,
  /** 撞 902 全局限流（march_time_control_info001）后的退避基数（毫秒）：按 streak 指数退避重排下轮 */
  rateLimitBackoffMs: 1000 * 15,
  /** 限流退避封顶（毫秒）：退避到此值后每轮最多等这么久，既不给服务器加压也不错过恢复 */
  rateLimitBackoffMaxMs: 1000 * 60,
  /** 逐条撤田 904 之间的休眠（毫秒）：时段外批量撤田时拉开间隔、规避行军时间限流（同占领发射井口径）。注意是「秒」量级，勿再写成 1000*500（那=500秒会把后续田串在几分钟后才撤） */
  recallInterval: 1000 * 2,
  /** 时段外「睡向下个下田时段起点」的单拍上限（毫秒）：兜住时钟漂移/超大定时器，醒一次即重判（6 小时） */
  windowSleepMaxMs: 1000 * 60 * 60 * 6,
  /** 时段外「睡向下个下田时段起点」的单拍下限（毫秒）：临近起点时的地板，防紧贴空转（10 秒） */
  windowSleepMinMs: 1000 * 10,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（UserData 名额/等级/服务器时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态 */
var ctxRef = null;
/**
 * 周期单飞闸门 / 触发合并 / 兜底定时器均收口到 core/cycle（见文件末 cycle 实例）；
 * feat 只保留「下拍间隔」决策所需的两个业务态：backlogActive（两档）与 rateLimitStreak（退避）。
 */
/** @type {number} 上次推送唤醒的墙钟时刻（毫秒），合并突发 */
var lastPushWakeAt = 0;
/** @type {boolean} 上轮是否仍有缺位未补（决定 active/idle 两档兜底间隔） */
var backlogActive = false;
/** @type {number} 连续撞 902 限流的次数（用于指数退避）；任一条 902 成功受理即归零 */
var rateLimitStreak = 0;
/** @type {boolean} 上轮 cyclePass 是否因「启用时段且当前在时段外」走了撤田分支（供 cycleRun 择时睡向下个时段起点） */
var outsideWindow = false;
/** @type {number} 上轮时段外撤田时仍「占用中」的采集行军数：>0 说明有返程未落地/撤回失败，短间隔复查再撤 */
var outsideRemaining = 0;

/**
 * 本地被拒/不合格点黑名单（"x,y" 键，run 时清空）：902 被拒零成本，拉黑后换下一候选，
 * 避免每个周期都在同一个不可下点上吃拒。
 * @type {Set<string>}
 */
var blacklist = new Set();

/**
 * 联盟机械田活表：坐标键 "x,y" → {x,y,family,level,ts(秒)}。
 * 来源 = 1193 全量 + 10452 推送解析出的「建造 N级设施完毕」记录；下田前逐个定点 901 确认仍在，
 * 探到已毁即移出并拉黑；每条 ts 超 MECH_MAX_AGE_SEC 由 pruneMechLive 老化剔除（塔存活 <10h）。
 * @type {Map<string, {x:number,y:number,family:number,level:number,ts:number}>}
 */
var mechLive = new Map();
/** @type {boolean} 是否已跑过一次 1193 全量（未跑前机械田本轮回退普通田） */
var mechLoaded = false;
/** @type {Promise|null} 1193 全量在飞 promise（单飞去重；await 者共享同一 promise，确保首轮真正等到机械田落地再选点，不再空返回） */
var mechLoading = null;
/** @type {number} 上次 1193 全量成功落地的墙上时刻（毫秒）：驱动 MECH_REFRESH_MS 周期性重拉（漏推自愈），0=从未成功 */
var mechLoadedAt = 0;

/**
 * 6 级田候选池：坐标键 "x,y" → {x,y,family,level,ownerId,expireTime(服务器秒),ts(最近一次扫描看到的墙上毫秒),blockedUntil(解禁墙上毫秒)}。
 * 来源 = 扫图 cycle（relicScanPass）消费刷新邮件的锚点扫图；仅 lvl6PointEntry 判据通过的无主点入池，按 expireTime 老化、并落 storage.slot 持久化。
 * @type {Map<string, {x:number,y:number,family:number,level:number,ownerId:string,expireTime:number,ts:number,blockedUntil:number}>}
 */
var lvl6Pool = new Map();
/**
 * 待扫锚点集：键 "x,y" → {sendTime(服务器秒), family(邮件资源类型→家族编码，0=未知)}。由 PUSH_SINGLE_MAIL(10264)「遗迹区域刷新」
 * 或启动/轮询读邮件缓存写入（均经 markRelicPending 去重），扫图 cycle（relicScanPass）消费后删除。无待扫锚点 = 不扫。
 * @type {Map<string, {sendTime:number, family:number}>}
 */
var lvl6PendingAnchors = new Map();
/**
 * 锚点键 → 已处理刷新邮件的 sendTime（服务器秒）：去重闸，推送与轮询只认「比已处理更新」的邮件才入队扫，
 * 杜绝同一封邮件被多次检测触发多次扫图；随池一并落 storage，跨刷新页保留。取代旧 L6_ANCHOR_SCAN_GAP_MS 合并闸。
 * @type {Object<string, number>}
 */
var lvl6Scanned = {};
/**
 * 锚点键 → 本次刷新的「5 窗全失败」重试次数（上限 L6_SCAN_RETRY_MAX）：部分窗成功即清零，
 * 防网络持续异常时同一刷新被无限度重扫。
 * @type {Object<string, number>}
 */
var lvl6ScanRetry = {};
/**
 * 本会话是否已成功显式拉过一次 alliance 邮件首页（面板从未开过时缓存为空才需要）：run 时复位，免每拍重拉。
 * @type {boolean}
 */
var l6MailLoaded = false;

/**
 * 本地账本：rowIdx（字符串键）→ [{marchId:string, x:number, y:number, marchType:number}]，每行至多 1 条。
 * 902 成功即记；在途核对发现 marchId 消失/坐标无对应行军即销。storage.data 持久化，跨页面刷新认领回填。
 * @type {Object<string, Array<object>>}
 */
var ledger = {};
/** @type {boolean} 账本是否已从盘读回（未读回前不做写操作，防拿空账本重复下田） */
var ledgerLoaded = false;
/** @type {boolean} 账本读盘在飞标记（单飞，防并发触发重复读盘） */
var ledgerLoading = false;

/** @type {Object<string, number>} (family_level) → groupType 缓存（RESOURCE 表页面生命周期内不变） */
var groupTypeCache = {};
/** @type {Object<number, number>} bid → 塔存活时长秒缓存（MAP_BUILDING.duration，页面生命周期内不变；查不到存 0） */
var towerLifeCache = {};
/** @type {Object<number, number>} bid → 塔驻军容量上限缓存（MAP_BUILDING.force_capacity，页面生命周期内不变；查不到存 0） */
var towerCapCache = {};

/** @type {boolean} install 幂等守卫 */
var installed = false;

/** @type {object} 模块配置（configure 灌入）：rules 为归一化后的行数组；timeWindowEnabled/timeRanges 为时段闸（timeRanges 已归一化为 {s,e} 分钟数） */
var MCFG = { rules: [], timeWindowEnabled: false, timeRanges: [] };

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * 等待毫秒（负值钳到 0）
 * @param {number} ms 时长
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, Math.max(0, ms | 0));
  });
}

/**
 * 应答 data 归一化：旧 JSON 链路 data 常为字符串，兜底已解析对象。
 * @param {*} d net.Ret.data
 * @returns {object|null}
 */
function parseData(d) {
  if (d == null) return null;
  if (typeof d === 'object') return d;
  if (typeof d === 'string') {
    try {
      return JSON.parse(d);
    } catch (err) {
      return null;
    }
  }
  return null;
}

/**
 * 902 被拒裸串 → 语言键：被拒时 data 是 "语言键,参数" 形式的裸串（受理才是整包 JSON），
 * 取首个逗号前作为键。非字符串/空回 null。口径照抄 floatcar。
 * @param {*} data net.Ret.data
 * @returns {string|null}
 */
function rejectErrKey(data) {
  if (typeof data !== 'string' || !data) return null;
  var comma = data.indexOf(',');
  return comma >= 0 ? data.slice(0, comma) : data;
}

/** @returns {object} DataCenter.DATA.UserData（读不到回空对象） */
function userData() {
  return (dataCenter && dataCenter.UserData) || {};
}

/**
 * 取本人全部采集行军（marchType 3/26）作为占用/账本核对的权威源。
 * 走 core/march.list()（封装 856 GET_ALL_MY_MARCH_INFO）：服务端全量、视口无关，Home 场景同样返回。
 * 归一化：marchId 一律字符串（>2^53 安全），占用判定取 m.isOccupying（state 非返程/到家）。
 * 永不 reject：失败时 march.list() 回 []（本轮视作无在途，由 freeSlots/preset-out 闸门兼底）。
 * @returns {Promise<Array<{marchId:string,x:number,y:number,marchType:number,state:number,occupying:boolean,heroIds:number[],itemId:number}>>}
 */
async function fetchMyFarmMarches() {
  var ms = await march.list();
  var out = [];
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    var mt = m.type | 0;
    if (mt !== KIND_FARM && mt !== KIND_TOWER) continue;
    // 行军身份（哪支预设部队、采的哪种田）：报文实证 dashcam 20261005T204748-行军加速(普通、高级)和撤回.ndjson
    //   cmd 856 条目自带 heroStateInfo.heroIds=[205,122,305] 与 target.itemId=1603（march.js 以 raw 透传）。
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
    });
  }
  return out;
}

/**
 * 本人全部「非返程/到家」行军已占用的目标点集合（"x,y" 键，来自 856 权威行军）。
 * 普通田只能一支部队驻扎、机械田虽允许多队驻采，但本器不让自己的两支队伍抢同一塔，故一律把本人已在途点预规为占用：
 * 去程/到达/采集中都算占位，唯返程（RETURNING=3）与到家（ARRIVED_HOME=4）已让出矿位不计。
 * @param {object[]} marches fetchMyFarmMarches() 结果（条目自带 x/y/state）
 * @returns {Set<string>} 占用点键集合
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

// ── 规则归一 ────────────────────────────────────────────────────────
/**
 * 面板原始 rules → 归一化行数组（钳值 + 类型对齐）。行存在即生效（无行级 enabled 字段）。
 * @param {Array<object>} raw
 * @returns {Array<{family:number,level:number,mechOnly:boolean,preset:number}>}
 */
function normalizeRules(raw) {
  var out = [];
  var list = Array.isArray(raw) ? raw : [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i] || {};
    var fam = RES_FAMILIES.indexOf(r.family | 0) >= 0 ? r.family | 0 : 7;
    var maxLv = fam === 16 ? 3 : 6; // 雷神矿最高 3 级，其余 1~6
    out.push({
      family: fam,
      level: Math.max(1, Math.min(maxLv, r.level | 0)) || 5,
      mechOnly: !!r.mechOnly,
      preset: Math.max(1, Math.min(16, r.preset | 0) || 1),
    });
  }
  return out;
}

/**
 * 面板预设号（1~16）→ Battle 预设 (index, type)：1~8 为战斗预设（type=0，index=本身），
 * 9~16 为采集预设（type=1，index=预设号-8）。与 battle.js 的 getPreMarchByIndex(index-1, type) 口径对齐。
 * @param {number} p 面板预设号（1~16）
 * @returns {{index:number,type:number}}
 */
function presetArgs(p) {
  var n = p | 0;
  if (n >= 9) return { index: n - 8, type: 1 };
  return { index: Math.max(1, n), type: 0 };
}

// ── 下田时段（timeRanges）归一与判定 ────────────────────────────────
/**
 * "HH:MM" → 当日分钟数（0~1439）；非法/空回 null。start>end 由调用方按「跨午夜」处理。
 * @param {string} str 面板 time 控件值
 * @returns {number|null}
 */
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
 * 面板原始 timeRanges → 归一化为 [{s,e}]（当日分钟数）；任一端非法的行丢弃（面板可留空/半填）。
 * toModuleCfg 专用；configure 直接整体接收本函数产物，绝不二次归一（防两处口径漂移）。
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

/**
 * 时段闸是否生效：仅当勾选启用且至少配了一行有效时段才生效；否则视为「全天可下田」（向后兼容旧档）。
 * @returns {boolean}
 */
function windowActive() {
  return !!(MCFG.timeWindowEnabled && MCFG.timeRanges && MCFG.timeRanges.length);
}

/** @returns {number} 当前本地墙钟的当日分钟数（含秒的小数，边界判定更准） */
function curMin() {
  var d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * 当前是否落在任一下田时段内（本地墙钟，国服=用户本地钟）。任一行命中即在窗口内。
 * 约定：s===e 视为「全天」；s<e 为当日区间 [s,e)；s>e 为跨午夜（t>=s 或 t<e）。
 * 未启用时段闸恒回 true（全天可下田）。
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

/**
 * 距下个下田时段起点还有多少毫秒（仅在「时段外」调用）：逐行取「从现在到该 s 的下一次发生」的最小值。
 * 用含秒的当日分钟差换算，秒级精度；s===e（全天）行跳过（不会处于其外部）。无可算行回 0（调用方兜底短间隔）。
 * @returns {number} 毫秒
 */
function msToNextWindowStart() {
  var t = curMin();
  var rs = MCFG.timeRanges;
  var best = Infinity;
  for (var i = 0; i < rs.length; i++) {
    var s = rs[i].s;
    if (rs[i].s === rs[i].e) continue;
    var delta = s > t ? s - t : 1440 - t + s; // 分钟（含小数）到下个起点
    if (delta < best) best = delta;
  }
  if (!isFinite(best)) return 0;
  return best * 60000;
}

/**
 * 距下个「时段边界」（任一时段的起点或终点）还有多少毫秒（时段内调用）：逐行取 s、e 各自「从现在起的下一次发生」的最小值。
 * inFarmWindow 的布尔翻转只可能发生在某行的起点或终点，故睡到最近的边界即可「到点主动醒做一次检测」——
 *   窗口止→立即撤田（不等 idle 长睡的下个兜底周期），新窗口起→立即恢复下田。s===e（全天）行无边界、跳过；
 *   含秒小数换算、秒级精度；无可算边界（均全天或未启用）回 0（调用方维持原兜底节奏）。
 * @returns {number} 毫秒
 */
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

// ── 账本持久化 ──────────────────────────────────────────────────────
/**
 * 从盘读回账本（单飞；读失败不置 loaded、保留下次重试机会——同 alliance-rally dailyState 语义）。
 * @returns {Promise<void>}
 */
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

/** 账本落盘（fire-and-forget，失败仅 warn，内存账本仍是本轮真相） */
function persistLedger() {
  if (!ledgerLoaded) return;
  Promise.resolve(storage.data.set(LEDGER_NAME, ledger)).catch(function (err) {
    log.warn('persist ledger failed.', err);
  });
}

// ── 行军身份（预设归属）───────────────────────────────────────────
/**
 * 规则行预设的原始英雄集（身份比对用）：走 MarchData.presetHeroIds，**不能**用 plan.heroList——
 * 那个已被 getHaveHeroCanMarchList 过滤，部队正在外采集时恒为空，恰好在需要比对的场景下失能。
 * @param {object} row 归一化规则行（取 .preset）
 * @returns {number[]} 预设英雄 id（读不到 / 无英雄预设 回 []）
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
 * 行军与本行预设是否「确定不是一支队」：两侧英雄集都非空且完全不相交才算外来。
 * 任一侧为空（无英雄预设 / 旧档未记 / 推送不带 heroIds）判不出身份 → 回 false：宁可不销位，也不误把真在途的田当缺位重派。
 * @param {number[]} presetHeroes 本行预设原始英雄集
 * @param {number[]} marchHeroes 856 行军的英雄集
 * @returns {boolean} true=确定外来（该占位不该钉住本行）
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

// ── 在途核对 ────────────────────────────────────────────────────────
/**
 * 用 856 权威行军修剪/回填账本（视口无关，Home 亦可）：
 *   1) 行号越界（规则行被删/改）→ 该键整体作废；
 *   2) 条目 marchId 在 856 中命中且仍占用（非返程/到家）→ 保留；命中但已返程/到家，或 856 全量里缺席
 *      （856 是全量真相，缺席即代表该队已回家/消失）→ 移除，该行随之变回缺位；
 *      ❗坐标兜底**只用于条目本身无 marchId**（旧档/未回传）：机械田允许多队同格驻采，若拿坐标去接一个
 *      「marchId 已消失」的条目，会被同格另一支仍在采的行军误判为仍占用 → 该行被永久钉死、再不下田；
 *      且一个在途行军只消归一个槽位（命中即从索引剔除），免一军钉多行。
 *   3) 认领孤儿：856 中存在（在途/在采）但未被任何账本行引用的采集行军（marchType 3/26）→ 回填到第一个**身份相符**的缺位行
 *      （跨页面刷新/重启不重复下田；手动下的田也算数）。
 *   身份闸（2/3 共用）：账本按行号存位，而改预设不会动行号、一列机械田驻采又能跑上 10 小时，
 *   故外队行军（heroIds 与本行预设英雄集不相交）既不钉位也不认领，否则「别人的田」会把本行钉死到采完。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @param {object[]} allRules 全部规则行（含未启用，下标即规则行 rowIdx）
 * @returns {boolean} 账本是否发生变化（需要落盘）
 */
function reconcileLedger(marches, allRules) {
  var changed = false;
  var liveIds = {};
  var liveCoord = {};
  for (var i = 0; i < marches.length; i++) {
    var mg = marches[i];
    if (!mg.occupying) continue; // 已让位（返程/到家），不计在途
    if (mg.marchId) liveIds[mg.marchId] = mg;
    if (mg.x != null && mg.y != null) liveCoord[mg.x + ',' + mg.y] = mg;
  }
  var isGather = function (mt) {
    return mt === KIND_FARM || mt === KIND_TOWER;
  };
  // 1)+2) 逐行修剪：marchId 命中且仍占用则保留，否则（已回家 / 856 全量缺席）删除
  for (var key in ledger) {
    if (!Object.prototype.hasOwnProperty.call(ledger, key)) continue;
    var idx = +key;
    if (!(idx >= 0 && idx < allRules.length)) {
      delete ledger[key];
      changed = true;
      continue;
    }
    var keep = [];
    var arr = Array.isArray(ledger[key]) ? ledger[key] : [];
    var presetHeroes = arr.length ? rowPresetHeroes(allRules[idx]) : [];
    for (var n = 0; n < arr.length; n++) {
      var e = arr[n] || {};
      // 有 marchId 就只认 marchId（已回家即销位），无 marchId 的旧条目才按坐标兜底；命中的在途行军就地消费，一军只钉一槽
      var mg2 = e.marchId ? liveIds[String(e.marchId)] : liveCoord[e.x + ',' + e.y];
      if (!mg2 || !isGather(mg2.marchType | 0)) continue;
      // 身份闸：命中的行军确定不属于本行预设部队 → 本行其实空着，不销位就会被外队钉到对方采完；
      //   销位不会重复派同一队：派兵前还有 armyListNew/heroList 两道「本队已在外」闸兜底。
      if (isForeignMarch(presetHeroes, mg2.heroIds)) {
        log.info(
          'drop ledger slot held by foreign march. row=%d marchId=%s marchHeroes=%s presetHeroes=%s',
          idx,
          mg2.marchId,
          (mg2.heroIds || []).join('/') || '-',
          presetHeroes.join('/') || '-',
        );
        continue; // 不消费该在途行军：它可能正真属于另一行的槽位
      }
      if (e.marchId) delete liveIds[String(e.marchId)];
      if (mg2.x != null && mg2.y != null) delete liveCoord[mg2.x + ',' + mg2.y];
      keep.push(e);
    }
    if (keep.length !== arr.length) changed = true;
    if (keep.length) ledger[key] = keep;
    else delete ledger[key];
  }
  // 3) 认领孤儿采集行军
  var claimed = {};
  for (var k2 in ledger) {
    var a2 = ledger[k2] || [];
    for (var q = 0; q < a2.length; q++) if (a2[q].marchId) claimed[String(a2[q].marchId)] = 1;
  }
  for (var s = 0; s < marches.length; s++) {
    var ms = marches[s];
    if (!ms.occupying) continue;
    var mt = ms.marchType | 0;
    if (!isGather(mt)) continue; // 856 条目按 marchType 3/26 判定采集行军
    if (ms.x == null || ms.y == null) continue;
    var mid = String(ms.marchId);
    if (claimed[mid]) continue;
    var filled = -1;
    for (var r2 = 0; r2 < allRules.length; r2++) {
      if (ledger[r2] && ledger[r2].length) continue; // 只填缺位行
      // 行存在即生效；但只认身份相符的行（heroIds 判不出时 isForeignMarch 回 false，仍按第一个缺位行兜底）
      if (isForeignMarch(rowPresetHeroes(allRules[r2]), ms.heroIds)) continue;
      filled = r2;
      break;
    }
    if (filled < 0) {
      log.debug(
        'skip adopting march, no row owns its heroes. marchId=%s mt=%d x=%d y=%d heroIds=%s',
        mid,
        mt,
        ms.x,
        ms.y,
        (ms.heroIds || []).join('/') || '-',
      );
      continue;
    }
    ledger[filled] = [
      { marchId: mid, x: ms.x, y: ms.y, marchType: mt, heroIds: (ms.heroIds || []).slice() },
    ];
    claimed[mid] = 1;
    changed = true;
    log.debug(
      'adopt orphan gather march. row=%d marchId=%s mt=%d x=%d y=%d heroIds=%s',
      filled,
      mid,
      mt,
      ms.x,
      ms.y,
      (ms.heroIds || []).join('/') || '-',
    );
  }
  return changed;
}

/**
 * 账本占位分解（专治「某行一直不下田却无任何日志」）：逐非空行列出本行预设英雄集、各槽位的
 * {marchId @坐标 mt=类型}，及其在 856 在途源里的匹配方式（id=按行军号命中 / coord=按坐标命中 / stale=已无对应占用行军）、
 * 行军 state 与行军英雄集；英雄集与本行预设不相交时标 FOREIGN（外队钉位，已由身份闸销位）。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @param {object[]} allRules 全部规则行（下标即账本键，取预设英雄集）
 * @returns {string} 形如 "0[preset 205/122](123 @350,294 mt=26 id st=5 h=205/122) 1(...)"，无占位行回空串
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
    if (!Object.prototype.hasOwnProperty.call(ledger, key)) continue;
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
        (e.marchId || '?') +
          '@' +
          e.x +
          ',' +
          e.y +
          ' mt=' +
          (e.marchType | 0) +
          (hit
            ? '(match=' +
              (byId ? 'id' : 'coord') +
              ' st=' +
              hit.state +
              ' h=' +
              (hit.heroIds || []).join('/') +
              (isForeignMarch(presetHeroes, hit.heroIds) ? ' FOREIGN' : '') +
              ')'
            : '(stale h=' + ((e.heroIds || []).join('/') || '-') + ')'),
      );
    }
    parts.push(
      key + '[preset ' + (presetHeroes.join('/') || '-') + '](' + slots.join(' ') + ')',
    );
  }
  return parts.join(' ');
}

// ── 候选来源 ────────────────────────────────────────────────────────
/**
 * (家族, 等级) → groupType（RESOURCE 表行 id）：家族 = floor(id/100)，等级取该行 .level 字段（非 id%100）。
 * 首次扫表命中即缓存；找不到返回 0（调用方据此放弃本行普通田搜索）。
 * @param {number} family 资源家族编码（1油/5粮/7金/16雷神）
 * @param {number} level 田等级（1~6）
 * @returns {number} RESOURCE 行 id，未命中 0
 */
function findGroupType(family, level) {
  var ck = family + '_' + level;
  if (groupTypeCache[ck] != null) return groupTypeCache[ck];
  var rows = l10n.tableRows('RESOURCE') || [];
  var gid = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    var id = Number(row.id) || 0;
    if (!id || Math.floor(id / 100) !== family) continue;
    if ((Number(row.level) || 0) !== level) continue;
    gid = id;
    break;
  }
  if (gid) groupTypeCache[ck] = gid;
  return gid;
}

// ── 联盟机械田发现（记录解析 + 存在性探针） ──────────────────────────
/**
 * 复刻联盟记录文本渲染（AllianceRecordController.dealOneObj 口径）：
 *   按 specId 查 alliance_information 表拿模板 .text，params 里含 RS(0x1e) 的子参数各自 getText(d[1])，
 *   再交给 l10n.text（LOCAL.getText）拼成最终中文串。失败回空串（调用方据此跳过）。
 * @param {object} e 记录对象 {specId, params[]}
 * @returns {string} 渲染后的记录文本
 */
function renderRecordMsg(e) {
  var o = l10n.tableRow('alliance_information', e.specId);
  if (!o || !o.text) return '';
  var raw = Array.isArray(e.params) ? e.params : [];
  var RS = String.fromCharCode(30);
  var args = [];
  for (var i = 0; i < raw.length; i++) {
    var p = String(raw[i] == null ? '' : raw[i]);
    var d = p.indexOf(RS) >= 0 ? p.split(RS) : null;
    args.push(d && d.length > 1 ? l10n.text(d[1]) : p);
  }
  try {
    return String(l10n.text.apply(null, [o.text].concat(args)) || '');
  } catch (err) {
    return '';
  }
}

/**
 * 单条联盟记录 → 机械田活表条目：只收「建造 N级<设施>完毕」且 sendTime 在 10h 内的记录，
 * 从渲染文本提 family/level/坐标（末个 "(x,y)"）灌进 mechLive。命中返回 true。
 * @param {object} e 记录对象 {specId, params[], sendTime(秒)}
 * @returns {boolean} 是否并入了一条机械田
 */
function ingestMechRecord(e) {
  if (!e || e.specId == null) return false;
  var ts = Number(e.sendTime) || 0;
  if (ts > 1e11) ts = Math.floor(ts / 1000); // ms→s 兜底
  var now = gameData.serverTime();
  if (!ts || (now && now - ts > MECH_MAX_AGE_SEC)) return false;
  var msg = renderRecordMsg(e);
  if (!msg || msg.indexOf('建造') < 0 || msg.indexOf('完毕') < 0) return false;
  var fm = msg.match(/(\d+)\s*级\s*(采金|炼油|谷仓|提纯)\s*设施/);
  if (!fm) return false;
  var family = FACILITY_FAMILY[fm[2]];
  if (!family) return false;
  var level = Number(fm[1]) || 0;
  var cm = msg.match(/\((\d+)\s*[，,]\s*(\d+)\)/g);
  if (!cm || !cm.length) return false;
  var last = cm[cm.length - 1].match(/(\d+)\s*[，,]\s*(\d+)/);
  var x = Number(last[1]) || 0,
    y = Number(last[2]) || 0;
  if (!x && !y) return false;
  mechLive.set(x + ',' + y, { x: x, y: y, family: family, level: level, ts: ts });
  return true;
}

/**
 * 全量拉联盟记录（1193，视口无关）→ 解析灌入活表。单飞（mechLoading），永不 reject。
 * @returns {Promise<void>}
 */
function loadMechRecords() {
  if (mechLoading) return mechLoading; // 已在飞：返回同一 promise，让 await 的调用方（cyclePass 首轮）真正等到落地，而非空返回
  mechLoading = net
    .send(CMD_ALLIANCE_RECORD_DATA, {})
    .then(function (ret) {
      mechLoading = null;
      if (!ret || !ret.ok) return;
      var d = parseData(ret.data) || {};
      var arr = Array.isArray(d.ret) ? d.ret : Array.isArray(d.list) ? d.list : null;
      if (!arr) return;
      var added = 0;
      for (var i = 0; i < arr.length; i++) {
        try {
          if (ingestMechRecord(arr[i])) added++;
        } catch (err) {}
      }
      mechLoaded = true;
      mechLoadedAt = Date.now(); // 记本次全量时刻，交 MECH_REFRESH_MS 周期闸驱动后续漏推自愈重拉
      log.info('alliance mech records loaded: %d tower hit, live=%d.', added, mechLive.size);
    })
    .catch(function (err) {
      mechLoading = null;
      log.debug('1193 load failed, retry next cycle. %s', err && err.message);
    });
  return mechLoading;
}

/** 老化剔除：活表里 ts 超 MECH_MAX_AGE_SEC 的条目（塔存活 <10h，超期视为已毁）。 */
function pruneMechLive() {
  var now = gameData.serverTime();
  if (!now) return;
  mechLive.forEach(function (c, key) {
    if (now - (c.ts || 0) > MECH_MAX_AGE_SEC) mechLive.delete(key);
  });
}

/**
 * (家族,等级) → 塔 bid：前缀·1000 + 等级（实证 71003=雷神 3 级、52006=油 6 级）。无对应前缀回 0。
 * @param {number} family 资源家族编码
 * @param {number} level 塔等级
 * @returns {number}
 */
function towerBidForLevel(family, level) {
  var pre = TOWER_PREFIX_BY_FAMILY[family];
  return pre ? pre * 1000 + (level | 0) : 0;
}

/**
 * 资源塔存活时长（秒）：MAP_BUILDING[bid].duration——游戏 NWorldTowerPopup 的 leftTime 同源字段
 * （leftTime = duration − (serverTime − btime)）。表未就绪/字段缺失回 0（调用方降级按 ts 新度排）。
 * @param {number} family 资源家族编码
 * @param {number} level 塔等级
 * @returns {number}
 */
function towerLifespanSec(family, level) {
  var bid = towerBidForLevel(family, level);
  if (!bid) return 0;
  if (towerLifeCache[bid] != null) return towerLifeCache[bid];
  var r = l10n.tableRow('MAP_BUILDING', bid);
  var life = r ? Number(r.duration) || 0 : 0;
  towerLifeCache[bid] = life;
  return life;
}

/**
 * 定点 901 存在性探针：查 (x,y) 是否仍是「本盟已建成、家族匹配」的资源塔。
 * 命中时一并带回塔 id（b.id 字符串，防 Int64 截断）与 bid，供调用方发 1034 查容量。
 * 永不 reject。@returns {Promise<{status:'ok'|'gone'|'error', id?:string, bid?:number}>} error=请求失败（本行本轮回退普通田）
 */
function probeMechTower(x, y, wantFamily) {
  var u = userData();
  return map
    .fetchWindow(net, x, y, { k: u.ServerId | 0 })
    .then(function (r) {
      if (!r.ok) return { status: 'error' };
      var list = r.points;
      var myAid = gameData.myAid();
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || (p.x | 0) !== x || (p.y | 0) !== y) continue;
        if ((p.pointType | 0) !== POINT_TYPE_TOWER) return { status: 'gone' };
        var b = p.b || {};
        if ((Number(b.st) || 0) !== TOWER_STATE_COMPLETE) return { status: 'gone' };
        if (myAid && Number(b.aid) !== myAid) return { status: 'gone' };
        if (
          wantFamily &&
          RES_FAMILY_BY_TOWER[Math.floor((Number(b.bid) || 0) / 1000)] !== wantFamily
        )
          return { status: 'gone' };
        return { status: 'ok', id: b.id != null ? String(b.id) : null, bid: Number(b.bid) || 0 };
      }
      return { status: 'gone' };
    })
    .catch(function () {
      return { status: 'error' };
    });
}

/**
 * 资源塔驻军容量上限（force_capacity）：MAP_BUILDING[bid].force_capacity（游戏 NWorldTowerPopup 判满同源字段，
 * 满判据 = force_capacity − army_size ≤ 0）。表未就绪/字段缺失回 0（调用方据此跳过容量闸）。
 * @param {number} bid 塔 bid（901 的 b.bid）
 * @returns {number}
 */
function towerForceCapacity(bid) {
  if (!bid) return 0;
  if (towerCapCache[bid] != null) return towerCapCache[bid];
  var r = l10n.tableRow('MAP_BUILDING', bid);
  var cap = r ? Number(r.force_capacity) || 0 : 0;
  towerCapCache[bid] = cap;
  return cap;
}

/**
 * 资源塔当前驻军兵力 army_size（1034 GET_TOWERINFO {id}，id 取 901 的 b.id 字符串，防 Int64 截断）。
 * 永不 reject；请求失败/无字段回 -1（调用方按「未知」不拦，交由 902 结果兜底）。
 * @param {string} id 塔 id（字符串）
 * @returns {Promise<number>}
 */
function towerArmySize(id) {
  if (!id) return Promise.resolve(-1);
  return net
    .send(CMD_GET_TOWERINFO, { id: id })
    .then(function (ret) {
      if (!ret || !ret.ok) return -1;
      var d = parseData(ret.data) || {};
      var n = Number(d.army_size);
      return isFinite(n) ? n : -1;
    })
    .catch(function () {
      return -1;
    });
}

/**
 * 为一行挑联盟机械田：活表按家族命中 → 按「剩余存活时间」降序（充足优先，等级高作次键）
 *   ——剩余时间 = 建成时刻 ts(≈btime) + 存活时长 duration − serverTime，均本地算、零额外发包；
 * → 剔除剩余 < MECH_MIN_REMAIN_SEC 的「快结束」塔（仅存活时长可查时生效）→ 逐个定点 901 确认仍在，
 * 再对存在性通过的候选发 1034 查 army_size 配 force_capacity 过容量闸（满则跳过、不拉黑）才返回；
 * 探到已毁即移出活表+拉黑换下一候选；探针失败/容量未知不拦/超上限/无候选回 null（调用方回退普通田）。
 * @param {object} row 归一化规则行
 * @param {Set<string>} taken 本轮已派点键
 * @returns {Promise<{x:number,y:number,marchType:number}|null>}
 */
async function pickMechTower(row, taken) {
  var now = gameData.serverTime();
  var scored = [];
  mechLive.forEach(function (c) {
    if (c.family !== row.family) return;
    var key = c.x + ',' + c.y;
    if (blacklist.has(key)) return;
    if (taken.has(key)) {
      log.debug('point occupied by my march(856), skip. mech x=%d y=%d', c.x, c.y);
      return;
    }
    var life = towerLifespanSec(c.family, c.level);
    var hasLife = life > 0 && !!now;
    // 剩余时间（秒）：能查到存活时长则用 ts+life-now；否则退化为 ts 新度（大=新建=剩余多）
    var remain = hasLife ? c.ts + life - now : c.ts || 0;
    scored.push({ c: c, remain: remain, hasLife: hasLife });
  });
  // 存活时长全可查时才按绝对剩余剔除快结束的塔；部分不可查时不误杀（仅靠排序优先）
  if (
    scored.length &&
    scored.every(function (s) {
      return s.hasLife;
    })
  ) {
    scored = scored.filter(function (s) {
      return s.remain >= MECH_MIN_REMAIN_SEC;
    });
  }
  scored.sort(function (a, b) {
    return b.remain - a.remain || b.c.level - a.c.level;
  });
  var probed = 0;
  for (var i = 0; i < scored.length; i++) {
    var c = scored[i].c;
    var key = c.x + ',' + c.y;
    if (probed >= MECH_PROBE_CAP) break;
    probed++;
    var pr = await probeMechTower(c.x, c.y, row.family);
    if (pr.status === 'error') return null;
    if (pr.status === 'gone') {
      mechLive.delete(key);
      blacklist.add(key);
      continue;
    }
    // 容量闸：塔存在且已建成，但可能已被采满（army_size ≥ force_capacity）→ 902 必被拒。
    // 本地查 force_capacity，可查则发 1034 取 army_size 比对；满则跳过本候选（不拉黑——稍后可能有队返采腾出空间）。
    var cap = towerForceCapacity(pr.bid);
    if (cap > 0 && pr.id) {
      var cur = await towerArmySize(pr.id);
      if (!aliveFn()) return null;
      if (cur >= 0 && cur >= cap) {
        log.debug('mech tower full, skip. x=%d y=%d army=%d cap=%d', c.x, c.y, cur, cap);
        continue;
      }
    }
    return { x: c.x, y: c.y, marchType: KIND_TOWER };
  }
  return null;
}

/**
 * 为一行搜一个普通田（906，服务端返回一个可采点）。永不 reject。
 * @param {object} row 归一化规则行
 * @param {Set<string>} taken 本轮已派点键
 * @returns {Promise<{x:number,y:number,marchType:number}|null>}
 */
async function pickNormalFarm(row, taken) {
  var gid = findGroupType(row.family, row.level);
  if (!gid) {
    log.warn('no RESOURCE row for family=%d level=%d, skip normal search.', row.family, row.level);
    return null;
  }
  var ret;
  try {
    ret = await net.send(CMD_WORLD_SEARCH_MONSTER, {
      minLevel: row.level,
      maxLevel: row.level,
      groupType: gid,
      pointType: SEARCH_POINT_TYPE_RESOURCE,
    });
  } catch (err) {
    log.debug('906 search send failed. %s', err && err.message);
    return null;
  }
  if (!ret || !ret.ok) return null;
  var d = parseData(ret.data) || {};
  var pt = d.point || (Array.isArray(d.pointList) ? d.pointList[0] : null);
  if (!pt || pt.x == null || pt.y == null) return null;
  var key = (pt.x | 0) + ',' + (pt.y | 0);
  if (blacklist.has(key)) return null;
  if (taken.has(key)) {
    log.debug('point occupied by my march(856), skip. normal x=%d y=%d', pt.x | 0, pt.y | 0);
    return null;
  }
  var r = pt.r || {};
  if (r.ownerId != null && String(r.ownerId) !== '0') return null;
  if ((Number(r.amount) || 0) <= 0) return null;
  return { x: pt.x | 0, y: pt.y | 0, marchType: KIND_FARM };
}

// ── 6 级田邮件驱动（候选池 + 锚点扫图 + 派前复验） ──────────────────────
/**
 * 901 单点 → 6 级田候选条目（判据收敛单函数，便于真机校准）：
 * pointType 必为 38（真机 914/914 条无主 6 级田全部 pointType=38，不存在 4 口径）；
 * 家族/等级均取 RESOURCE[itemId] 行（竞品B 口径）：family = resource_type 经 L6_RES_TYPE_TO_FAMILY 换算（该域 1金/5油/7粮/20雷神，非面板恒等）、
 * level = row.level 必须 6；❗r.itemId（1514/1515…）不是 groupType id，floor(id/100)=15 会拒掉全部真田，故不用 findGroupType 那套；
 * 同盟闸：r.aid 须为本盟（报文实证无主田也带 aid，刷新的是本盟遗迹才轮得到本盟采，同机械田 aid 口径）；
 * ownerId '0'/空=无主可直采，非空则记 expireTime（服务器秒，到期即空出）。表查不到行/非法条目回 null。
 * @param {object} p 901 pointList 单点
 * @returns {{family:number,level:number,ownerId:string,expireTime:number}|null}
 */
function lvl6PointEntry(p) {
  if (!p) return null;
  if ((p.pointType | 0) !== POINT_TYPE_FORTRESS_RES) return null;
  var r = p.r;
  if (!r) return null;
  var itemId = Number(r.itemId) || 0;
  if (!itemId) return null;
  var row = l10n.tableRow('RESOURCE', String(itemId));
  if (!row) return null;
  var fam = L6_RES_TYPE_TO_FAMILY[Number(row.resource_type)] || 0;
  if (!fam) return null;
  if ((Number(row.level) || 0) !== 6) return null;
  var myAid = gameData.myAid();
  if (myAid && Number(r.aid) !== myAid) return null; // 非本盟遗迹刷出的田（myAid 读不到时不拦，同机械田保守口径）
  return {
    family: fam,
    level: 6,
    ownerId: r.ownerId == null ? '0' : String(r.ownerId),
    expireTime: Number(r.expireTime) || 0,
  };
}

/**
 * 单窗应答 → 并入候选池：命中点刷新 ts/ownerId/expireTime（被抢或到期交这里闭环）；blockedUntil 保留既有拉黑时刻
 * （刚被拒的点不因重新扫到就立刻再试）。
 * @param {object[]} points fetchWindow 归一化 pointList
 * @returns {number} 本窗命中的 6 级田数
 */
function refreshLvl6Pool(points) {
  var wall = Date.now();
  var hits = 0;
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (!p || p.x == null || p.y == null) continue;
    var e = lvl6PointEntry(p);
    if (!e) continue;
    var key = (p.x | 0) + ',' + (p.y | 0);
    var old = lvl6Pool.get(key);
    var ent = {
      x: p.x | 0,
      y: p.y | 0,
      family: e.family,
      level: 6,
      ownerId: e.ownerId,
      expireTime: e.expireTime,
      ts: wall,
      blockedUntil: old ? old.blockedUntil : 0,
    };
    lvl6Pool.set(key, ent);
    hits++;
  }
  return hits;
}

/**
 * 老化剔除：田的权威消失时刻就是它自带的 expireTime（服务器秒）——serverTime 到点即空田消失，直接从池里忘；
 * 无 expireTime 的条目（报文缺字段）按刷新有效期 L6_MAIL_FRESH_SEC 墙上兑底老化，免陈旧候选长期占位。
 */
function pruneLvl6Pool() {
  var srv = gameData.serverTime() || 0;
  var wall = Date.now();
  lvl6Pool.forEach(function (e, key) {
    if (e.expireTime) {
      if (srv && srv >= e.expireTime) lvl6Pool.delete(key);
      return;
    }
    if (wall - e.ts > L6_MAIL_FRESH_SEC * 1000) lvl6Pool.delete(key);
  });
}

/**
 * 6 级田候选池落盘（fire-and-forget，走 storage.slot 独立键、不牵账本 blob）：存 {v, pool:[条目], scanned:去重表}。
 * 失败仅 debug 一行（内存池仍是本轮扫图真相，下次扫图再试）。
 */
function persistLvl6() {
  var arr = [];
  lvl6Pool.forEach(function (e) {
    arr.push(e);
  });
  Promise.resolve(
    storage.slot.set(LVL6_STORE_KEY, { v: LVL6_STORE_VER, pool: arr, scanned: lvl6Scanned }),
  ).catch(function (err) {
    log.debug('persist lvl6 failed. %s', err && err.message);
  });
}

/**
 * 从盘读回 6 级田候选池与去重表（run 时调一次，回填后派兵立即能取点、刷新页免重扫高危 901）。
 * 读失败/无数据都不覆盖内存（沿用「读不到≠空」）；版本不等于 LVL6_STORE_VER 的旧档整份丢弃（连同去重表，使待扫闸重扫重建）；
 * 回填后立即按 expireTime pruneLvl6Pool 剔过期。
 * @returns {Promise<void>}
 */
function loadLvl6() {
  return Promise.resolve(storage.slot.get(LVL6_STORE_KEY))
    .then(function (saved) {
      if (!saved || typeof saved !== 'object' || saved.v !== LVL6_STORE_VER) return;
      if (Array.isArray(saved.pool)) {
        for (var i = 0; i < saved.pool.length; i++) {
          var e = saved.pool[i];
          if (e && e.x != null && e.y != null) lvl6Pool.set((e.x | 0) + ',' + (e.y | 0), e);
        }
      }
      if (saved.scanned && typeof saved.scanned === 'object') {
        for (var kk in saved.scanned) {
          if (Object.prototype.hasOwnProperty.call(saved.scanned, kk)) lvl6Scanned[kk] = saved.scanned[kk];
        }
      }
      pruneLvl6Pool();
    })
    .catch(function (err) {
      log.debug('load lvl6 pool failed. %s', err && err.message);
    });
}

/**
 * 当前面板勾选的 6 级田家族集合（level===6 的行的 family）。扫图 cycle 据此做家族闸：
 * 一封刷新邮件标了具体家族而该家族未被勾选 → 整锚点不扫（省 5 窗高危 901）。
 * @returns {Set<number>} 家族编码集合（可能为空 = 无 6 级行）
 */
function lvl6SelectedFamilies() {
  var s = new Set();
  var rules = MCFG.rules || [];
  for (var i = 0; i < rules.length; i++) {
    if (Number(rules[i].level) === 6) s.add(Number(rules[i].family));
  }
  return s;
}

/**
 * 扫图 cycle 主体（独立于派兵 cycle）：邮件列表轮询自愈 + 消费待扫锚点。
 * 每拍：① 无 6 级勾选行 / 邮件系统未就绪 → 直接睡轮询节拍（不发任何 901、不读邮件）；
 *   ② 就绪则把邮件列表近期刷新喂进 (锚点,sendTime) 去重闸（与 10264 推送同源，重复检测不会重复扫），
 *      缓存空且从未成功 load 过时显式拉一次 alliance 首页（与玩家点开面板同源、零副作用）；
 *   ③ 消费**一个**待扫锚点：家族闸不勾选则记已处理跳过；否则串行发竞品B refreshRelicResources 口径 5 窗 901
 *      （窗心偏移见 L6_WINDOWS、窗 60×90、viewLevel1，窗间 sleep L6_SCAN_GAP_MS），命中点入池、随即 pruneLvl6Pool + persistLvl6。
 * 整轮窗全失败 → 回退去重、退回待扫集重试（封顶 L6_SCAN_RETRY_MAX）。永不 reject（fetchWindow 永不 reject）。
 * @returns {Promise<number>} 下拍间隔：仍有待扫锚点→0（立即续扫下一锚点）；否则 L6_MAIL_POLL_MS。
 */
async function relicScanPass() {
  var want = lvl6SelectedFamilies();
  if (!want.size) return L6_MAIL_POLL_MS; // 无 6 级行：不读邮件、不发扫图（规则变化由 configure kick 唤醒）
  if (!mail.ready()) return L6_MAIL_POLL_MS; // 邮件 subpack 未就绪：下拍自然重探（取代旧 seedL6 setTimeout 重试）
  // 轮询自愈：邮件列表近期刷新喂进去重闸（推送漏达 / feat 上来时刷新邮件已到达都能补拾）
  if (!scanRelicMails(mail.all())) {
    // 缓存里一条刷新都没有：面板从未开过时缓存为空，显式拉一次 alliance 首页进游戏缓存再扫第二遍（单次会话只拉一次）
    if (!l6MailLoaded) {
      l6MailLoaded = await mail.load('alliance');
      if (l6MailLoaded) scanRelicMails(mail.all());
    }
  }
  if (!aliveFn()) return L6_MAIL_POLL_MS;
  if (!lvl6PendingAnchors.size) return L6_MAIL_POLL_MS;
  // 取一个待扫锚点消费（一拍一锚点，锚点间靠 return 0 续跑，便于暂停逐锚点复查 alive）
  var key = null;
  lvl6PendingAnchors.forEach(function (v, kk) {
    if (key === null) key = kk;
  });
  var entry = lvl6PendingAnchors.get(key);
  lvl6PendingAnchors.delete(key);
  var sendTime = entry.sendTime;
  // 家族闸：邮件标了具体家族但未勾选 → 记已处理、整锚点不扫（省 5 窗高危 901）；family=0（未知文案）照扫
  if (entry.family > 0 && !want.has(entry.family)) {
    lvl6Scanned[key] = sendTime;
    persistLvl6();
    log.debug('relic refresh skipped (family=%d not selected). anchor=%s', entry.family, key);
    return lvl6PendingAnchors.size ? 0 : L6_MAIL_POLL_MS;
  }
  lvl6Scanned[key] = sendTime;
  var k = userData().ServerId | 0;
  var pos = key.split(',');
  var ax = Number(pos[0]) | 0;
  var ay = Number(pos[1]) | 0;
  var hits = 0;
  var failed = 0;
  for (var wi = 0; wi < L6_WINDOWS.length; wi++) {
    if (!aliveFn()) break;
    var w = L6_WINDOWS[wi];
    var r = await map.fetchWindow(net, ax + w.dx, ay + w.dy, {
      k: k,
      width: L6_WIN.w,
      height: L6_WIN.h,
      viewLevel: 1,
      marchInfo: false, // 竞品B 靠 marchList 剔「有人在路上」的点；本 feat 走 856 taken + 派前复验 + 被拒 TTL 拉黑，不需这层
    });
    if (r.ok) hits += refreshLvl6Pool(r.points);
    else failed++; // 单窗失败不致命：田低频、下次刷新邮件再扫自愈
    if (wi < L6_WINDOWS.length - 1) await sleep(L6_SCAN_GAP_MS); // 窗间串行 2s，免瞬时并发对服务器加压
  }
  pruneLvl6Pool();
  persistLvl6();
  log.info(
    'relic refresh scan. anchor=%s windows=%d failed=%d lvl6=%d pool=%d',
    key,
    L6_WINDOWS.length,
    failed,
    hits,
    lvl6Pool.size,
  );
  // 整轮窗全失败（网络抖动/切场景）→ 回退去重、退回待扫集重试（免错过这一次刷新）；重试封顶 L6_SCAN_RETRY_MAX，任何一窗成功即清零。
  if (failed === L6_WINDOWS.length) {
    var tries = lvl6ScanRetry[key] || 0;
    if (tries < L6_SCAN_RETRY_MAX) {
      lvl6ScanRetry[key] = tries + 1;
      delete lvl6Scanned[key]; // 回退去重，允许下拍重扫该刷新
      lvl6PendingAnchors.set(key, entry);
      log.debug('relic scan all windows failed, re-queued. anchor=%s tries=%d', key, tries + 1);
    } else {
      delete lvl6ScanRetry[key];
    }
  } else {
    delete lvl6ScanRetry[key];
  }
  return lvl6PendingAnchors.size ? 0 : L6_MAIL_POLL_MS;
}

/**
 * 6 级候选派前单点复验：中心定点 901（20×20 小窗）确认该点仍是 lvl6PointEntry 口径的 6 级田。
 * 命中即刷新条目 ts/ownerId/expireTime（新鲜期内可免复验直采）；该点已非 6 级田 → 移出池。
 * 永不 reject；请求失败回 {status:'error'}（未知不拦由调用方按保守处理）。
 * @param {object} e 候选池条目
 * @returns {Promise<{status:'ok'|'gone'|'error', ownerId?:string, expireTime?:number}>}
 */
function probeLvl6Point(e) {
  var u = userData();
  return map
    .fetchWindow(net, e.x, e.y, { k: u.ServerId | 0 })
    .then(function (r) {
      if (!r.ok) return { status: 'error' };
      for (var i = 0; i < r.points.length; i++) {
        var p = r.points[i];
        if (!p || (p.x | 0) !== e.x || (p.y | 0) !== e.y) continue;
        var ent = lvl6PointEntry(p);
        if (!ent) {
          lvl6Pool.delete(e.x + ',' + e.y);
          return { status: 'gone' };
        }
        var old = lvl6Pool.get(e.x + ',' + e.y);
        lvl6Pool.set(e.x + ',' + e.y, {
          x: e.x,
          y: e.y,
          family: ent.family,
          level: 6,
          ownerId: ent.ownerId,
          expireTime: ent.expireTime,
          ts: Date.now(),
          blockedUntil: old ? old.blockedUntil : 0,
        });
        return { status: 'ok', ownerId: ent.ownerId, expireTime: ent.expireTime };
      }
      lvl6Pool.delete(e.x + ',' + e.y);
      return { status: 'gone' };
    })
    .catch(function () {
      return { status: 'error' };
    });
}

/**
 * 6 级池按家族体检（诊断「只下粮不下油」这类取不到点的根因分流）：
 * 统计全池规模与该家族入池的 matched/free(无主可采)/owned(被占)/blocked(拉黑未到点) 计数——
 * matched=0 说明扫图根本没把该家族田入池（家族映射/入池判据问题）；matched>0 而 free=0 说明有田但全被占，
 * 需等下一封刷新邮件重扫该锚点才会再入无主候选（owned 条目被 pickLvl6Farm 首个即 break、不复探、到期即 prune）。
 * @param {number} family 面板家族码（1油/5粮/7金/16雷神）
 * @returns {string} 供日志的分解串
 */
function describeLvl6Pool(family) {
  var wall = Date.now();
  var total = 0,
    matched = 0,
    free = 0,
    owned = 0,
    blocked = 0;
  lvl6Pool.forEach(function (e) {
    total++;
    if (e.family !== family) return;
    matched++;
    if (e.blockedUntil > wall) {
      blocked++;
      return;
    }
    if (e.ownerId === '0') free++;
    else owned++;
  });
  return 'pool=' + total + ' fam=' + family + ' matched=' + matched + ' free=' + free + ' owned=' + owned + ' blocked=' + blocked;
}

/**
 * 为一行 6 级田从候选池取点：新鲜期内无主→直采；超期→派前单点 901 复验仍无主才采（本轮探针上限 L6_PROBE_CAP）；
 * 他人在采/被抢→条目已由复验刷新为占用态，跳过不拉黑（下次刷新邮件重扫时会再入候选）；拉黑未到解禁时刻的条目不参与候选。
 * 排序：无主优先 → expireTime 升序（同批田共享同一到期时刻，故实质按批次旧→新取、先拿将消失的）→ 距本城最近。
 * @param {object} row 归一化规则行（family）
 * @param {Set<string>} taken 本轮已派/已占点键
 * @returns {Promise<{x:number,y:number,marchType:number}|null>}
 */
async function pickLvl6Farm(row, taken) {
  var my = gameData.myWorldPos();
  var wall = Date.now();
  var cands = [];
  lvl6Pool.forEach(function (e, key) {
    if (e.family !== row.family) return;
    if (e.blockedUntil > wall) return;
    if (taken.has(key)) return;
    var d = my ? Math.abs(e.x - my.x) + Math.abs(e.y - my.y) : 0;
    cands.push({ e: e, key: key, free: e.ownerId === '0', d: d });
  });
  cands.sort(function (a, b) {
    return (a.free ? 0 : 1) - (b.free ? 0 : 1) || a.e.expireTime - b.e.expireTime || a.d - b.d;
  });
  var probed = 0;
  for (var i = 0; i < cands.length; i++) {
    var e = cands[i].e;
    if (e.ownerId !== '0') break; // 有序：首个被占即其后全被占，到期时刻交精准唤醒，不再看下去
    if (wall - e.ts >= L6_FRESH_MS) {
      if (probed >= L6_PROBE_CAP) break; // 本轮探针额度用尽，缺位留 active 档下拍续
      probed++;
      var pr = await probeLvl6Point(e);
      if (!aliveFn()) return null;
      if (pr.status === 'gone') continue;
      if (pr.status === 'error') return null; // 网络未知：本行本轮不派、不拉黑，下拍重试
      if (pr.ownerId !== '0') continue; // 被抢：条目已刷新为占用态+到期时刻，换下一候选
    }
    return { x: e.x, y: e.y, marchType: KIND_FARM };
  }
  return null;
}

// ── 派发 ────────────────────────────────────────────────────────────
/**
 * 下田 902：marchType=候选带回来的类型（3 普通田 / 26 机械田），经 core/march.attack 统一发送。
 * 永不 reject（march.attack 内部 catch → code=NOT_SENT）。
 * @param {{x:number,y:number}} coord 目标点
 * @param {number} marchType 行军类型（3 普通田 / 26 机械田）
 * @param {object} plan MarchData（5 字段）
 * @returns {Promise<object>} net.Ret
 */
async function sendFarm(coord, marchType, plan) {
  return await march.attack({
    marchType: marchType,
    target: { x: coord.x, y: coord.y },
    data: plan,
  });
}

/**
 * 时段外立即撤田：逐条 904 撤回当前「占用中」的采集行军（marchType 3/26，取自 856 权威源），
 * 条间 sleep(recallInterval) 拉开间隔规避行军时间限流；每轮前判 alive（暂停则就地收手）。
 * 幂等：返程(RETURNING)/到家不计占用，故下一拍只重新拦尚未落地的；撤回失败仍占用的下拍再试。
 * @param {object[]} marches fetchMyFarmMarches() 结果
 * @returns {Promise<number>} 本轮所见仍占用的采集行军数（>0 交 cycleRun 短间隔复查）
 */
async function recallAllFarms(marches) {
  var n = 0;
  for (var i = 0; i < marches.length; i++) {
    var m = marches[i];
    if (!m.occupying) continue;
    if (m.marchType !== KIND_FARM && m.marchType !== KIND_TOWER) continue;
    if (!aliveFn()) return n;
    n++;
    await march.recall(m.marchId);
    log.info(
      'out-of-window recall farm march. marchId=%s kind=%d x=%d y=%d',
      m.marchId,
      m.marchType,
      m.x,
      m.y,
    );
    if (i < marches.length - 1) await sleep(cfg.recallInterval);
  }
  return n;
}

// ── 周期引擎（core/cycle 调和循环：单飞闸门 + 触发合并 + 绝不停摆均由 cycle 承载）──
/**
 * 单轮调和主体：账本读回 → cyclePass → 返回下拍间隔（毫秒；<=0=立即补扫）。
 * 下一拍睡多久的决策仍归本 feat（限流退避 / 触发合并 / active-idle 两档），cycle 只按返回值择时重排。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  // 账本未从盘读回前不派：防拿空账本重复下田；读回失败返回 active 档、下拍重试（不留紧密循环）
  if (!ledgerLoaded) {
    await loadLedger();
    if (!ledgerLoaded) return cfg.activeScanInterval;
  }
  await cyclePass();
  // 时段外：已全部撤净（outsideRemaining=0）则睡到下个下田时段起点（封顶防超大定时器/时钟漂移）；
  //   仍有在途田（返程未落地/撤回失败）则短间隔复查再撤。两路都按「下个起点」夹一刀：起点临近时到点即醒恢复下田，不因复查跨过边界。
  if (outsideWindow) {
    var resume = msToNextWindowStart();
    if (outsideRemaining > 0) {
      if (resume <= 0) return cfg.activeScanInterval;
      return Math.max(cfg.windowSleepMinMs, Math.min(cfg.activeScanInterval, resume));
    }
    if (resume <= 0) return cfg.activeScanInterval;
    return Math.max(cfg.windowSleepMinMs, Math.min(resume, cfg.windowSleepMaxMs));
  }
  // 撞 902 全局限流的指数退避优先：丢弃本轮在飞期间排队的触发（不立刻再 burst），交退避定时统一重试
  var delay;
  if (rateLimitStreak > 0) {
    delay = Math.min(
      cfg.rateLimitBackoffMs * (1 << Math.min(rateLimitStreak - 1, 5)),
      cfg.rateLimitBackoffMaxMs,
    );
  } else if (cycle.pending) {
    // 本轮在飞期间来了外部触发（回城 / 配置 / 推送）→ 立即补扫一轮（合并语义，靠 cycle.pending 感知）
    return 0;
  } else {
    delay = backlogActive ? cfg.activeScanInterval : cfg.idleScanInterval;
  }
  // 时段内也按「下个边界（任一时段的起或止）」主动择时：到点即醒做一次检测——窗口止→立即撤田（不等 idle 长睡）、新窗口起→立即恢复下田。
  //   未启用时段闸时 edge=0，维持原 active/idle 兜底节奏；delay=0（pending）已在上面 return，此处只处理 >0 的常规档。
  if (windowActive()) {
    var edge = msToNextWindowEdge();
    if (edge > 0) delay = Math.max(cfg.windowSleepMinMs, Math.min(delay, edge));
  }
  return delay;
}

/** @type {{kick: function(), pending: boolean}} 派兵调和循环驱动器（fallback 取 active 档，防异常停摆/空转） */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.activeScanInterval,
});

/**
 * 6 级田扫图驱动器（与派兵 cycle 解耦）：只跑 relicScanPass（邮件轮询自愈 + 消费待扫锚点扫图入池落 storage），
 * 不派兵、不受派兵名额/限流闸牵连——修旧 bug：石油锚点曾因与派兵同周期、被一次性消费后撞上名额/限流早退而 4h 内再不重扫。
 * alive=false（暂停/战斗模式）时自然停摆，无需自建定时器 teardown。
 */
const relicCycle = createCycle({
  log: log,
  alive: aliveFn,
  run: relicScanPass,
  fallback: L6_MAIL_POLL_MS,
});

/**
 * 单轮周期主体：在途核对 → 找缺位行 → 名额闸门 → 逐行取田（☑机械田先本地机械、无则搜普通田； 6 级行走扫图候选池）→ 派发。
 * 早退路径只置 backlogActive 后正常返回（两档重排由 cycleRun 末尾统一返回值决定，cycle 保证无论何种出口都会重排下一拍）。
 * @returns {Promise<void>}
 */
async function cyclePass() {
  // 准入存活校验（每拍 O(1) 读缓存判定，不设限包恒真）：与 alive 同位阶的运行前提，
  // 判定不过则不派兵不读写，下一拍由 cycle 照常重排，链路不停摆。
  if (!screen(getUid())) return;
  // 时段闸（置于最前，撤田不依赖规则行是否还在）：启用「下田时段」且当前不在任一时段内
  //   → 立即逐条 904 撤回全部在途田（本轮不下田），睡向下个时段起点的决策交 cycleRun。
  if (windowActive() && !inFarmWindow()) {
    var cur = await fetchMyFarmMarches();
    if (!aliveFn()) return;
    outsideRemaining = await recallAllFarms(cur);
    outsideWindow = true;
    backlogActive = false;
    return;
  }
  outsideWindow = false;
  outsideRemaining = 0;

  var all = MCFG.rules || [];
  var rules = [];
  var ruleIdx = [];
  for (var i = 0; i < all.length; i++) {
    rules.push(all[i]);
    ruleIdx.push(i);
  } // 行存在即生效，无行级 enabled 过滤
  if (!rules.length) {
    backlogActive = false;
    return;
  }

  // 权威行军源：core/march.list()（封装 856，视口无关、Home 亦有全量）。march.list() 失败回 []（「未知不拦」）：
  // 即便瞬时拉空，预设部队已在外者 armyListNew 为空会静默跳过，不会重复下田；回城后自然补齐。
  var marches = await fetchMyFarmMarches();
  if (!aliveFn()) return;

  // 在途核对 + 缺位行（账本键=规则行原始下标，锚定 856 权威行军：marchId 缺席即已回家/消失 → 销位）
  if (reconcileLedger(marches, all)) persistLedger();
  var missingPos = []; // 缺位行在 rules（启用行数组）中的下标
  for (var m = 0; m < rules.length; m++) {
    if (!(ledger[ruleIdx[m]] && ledger[ruleIdx[m]].length)) missingPos.push(m);
  }
  // 有行未入缺位集 = 被账本占位钉住且本轮不会为其派兵：此处不打日志就完全静默（“只看到一行在报”的典型成因）
  if (missingPos.length < rules.length) {
    log.debug('rows held by ledger (no dispatch): %s', describeLedgerHolds(marches, all));
  }
  if (!missingPos.length) {
    backlogActive = false;
    return;
  }

  // 名额闸门（core/march.freeSlots，读 UserData 服务端同步、跨场景可靠）：无空位只等下个唤醒周期（不主动撤田——撤田语义保留给占领发射井 feat）
  var free = march.freeSlots();
  if (free <= 0) {
    log.debug('no free march slot, wait for arrival wake. missing=%d', missingPos.length);
    backlogActive = true;
    return;
  }

  // 点占用表（来自 856 权威行军）：把本人全部「非返程/到家」行军的目标点预规为占用（种子进 taken），
  // Home 场景也能识别自家在田队；pickMechTower/pickNormalFarm 的 taken 过滤自动跳过（本轮派成的点也并入）。
  var taken = occupiedPointSet(marches);
  pruneMechLive();
  // 6 级田扫图已拆到独立 relicCycle（邮件驱动、与派兵名额/限流解耦）；本派兵周期只从 lvl6Pool 读点取田（pickLvl6Farm），不触发扫图。
  var dispatched = 0;
  for (var t = 0; t < missingPos.length; t++) {
    if (!aliveFn()) return;
    if (free <= 0) {
      log.debug('slot exhausted mid-cycle, remaining=%d', missingPos.length - t);
      break;
    }
    var row = rules[missingPos[t]];
    var rawIdx = ruleIdx[missingPos[t]];

    // 先算该行预设部队可用否（纯本地读预设 + 剔除已出征，零发包）：armyListNew 为空多半意味着
    // 这支部队已在外（正是在下田/采集中）——本行其实已被占用，静默 debug 跳过，既不发 901/906 徒劳搜田、
    // 也不刷 ⚠️；部队回城后 armyListNew 复出不空，下一轮自然补派。
    var pa = presetArgs(row.preset);
    var plan = new Battle().plan().preset(pa.index, pa.type).adjust().build();
    if (!plan.armyListNew.length) {
      log.debug(
        'row %d preset #%d(%s#%d) army already out (farming?), skip without searching.',
        rawIdx,
        row.preset,
        pa.type ? '采集' : '战斗',
        pa.index,
      );
      continue;
    }
    // 英雄就绪守卫：预设原本配了英雄、但当前可派英雄列表为空——这是 10019 回城推送后
    // 兵池（UserData）已刷新、而英雄释放推送（HeroController）尚未到达时的竞争窗口。
    // 若此时发 902，英雄列表将为空（部队无英雄出征），故本轮跳过，等英雄推送到达后的
    // 兵池刷新唤醒或兜底定时器重试。
    if (plan.presetHasHeroes && !plan.heroList.length) {
      log.debug(
        'row %d preset #%d(%s#%d) heroes not yet released, skip this cycle.',
        rawIdx,
        row.preset,
        pa.type ? '采集' : '战斗',
        pa.index,
      );
      backlogActive = true;
      continue;
    }
    if (net.isSending(CMD_MARCH_WORLD_POINT)) {
      backlogActive = true;
      break;
    }

    // 取田：6 级田既无机械田、906 也搜不到（只分布在两块特定区域），走扫图候选池 pickLvl6Farm；其余等级一律优先机械田——先从联盟机械田活表按家族命中、
    // 按剩余存活时间降序、定点 901 确认仍在才下；☑只下机械田(row.mechOnly) 则机械田没有即跳过本行、绝不回退普通田，未☑则没有再搜普通田（906）。
    var cand = null;
    var mechApplicable = row.level < 6;
    if (row.level === 6) {
      cand = await pickLvl6Farm(row, taken);
      if (!aliveFn()) return;
    } else if (mechApplicable) {
      // 首次未拉 或 距上次全量超 MECH_REFRESH_MS（漏推自愈）→ 重拉 1193（并入不清空，单飞在 mechLoading 内去重）
      if (!mechLoaded || Date.now() - mechLoadedAt >= MECH_REFRESH_MS) {
        await loadMechRecords();
        if (!aliveFn()) return;
      }
      cand = await pickMechTower(row, taken);
      if (!aliveFn()) return;
    }
    if (!cand && row.level !== 6 && (!mechApplicable || !row.mechOnly)) {
      if (net.isSending(CMD_WORLD_SEARCH_MONSTER)) {
        backlogActive = true;
        break;
      }
      cand = await pickNormalFarm(row, taken);
      if (!aliveFn()) return;
    }
    if (!cand) {
      if (row.level === 6) {
        log.info(
          'no lvl6 candidate for row %d family=%d — %s',
          rawIdx,
          row.family,
          describeLvl6Pool(row.family),
        );
      } else {
        log.debug(
          'no candidate for row %d (family=%d level=%d mechOnly=%s).',
          rawIdx,
          row.family,
          row.level,
          !!row.mechOnly,
        );
      }
      continue;
    }

    var ck = cand.x + ',' + cand.y;
    var ret = await sendFarm(cand, cand.marchType, plan);
    if (!aliveFn()) return;
    if (ret.ok) {
      taken.add(ck);
      rateLimitStreak = 0; // 成功受理即解除限流退避压力
      var d = parseData(ret.data) || {};
      var mid =
        d.marchInfo && d.marchInfo.marchId != null
          ? String(d.marchInfo.marchId)
          : d.marchId != null
            ? String(d.marchId)
            : '';
      ledger[rawIdx] = [
        {
          marchId: mid,
          x: cand.x,
          y: cand.y,
          marchType: cand.marchType,
          heroIds: (plan.presetHeroIds || []).slice(),
        },
      ];
      persistLedger();
      free--;
      dispatched++;
      log.info(
        'farm march ok. row=%d kind=%d x=%d y=%d marchId=%s',
        rawIdx,
        cand.marchType,
        cand.x,
        cand.y,
        mid || '?',
      );
    } else {
      var errKey = rejectErrKey(ret.data);
      if (errKey === ERR_RATE_LIMIT) {
        // 服务器 902 全局限流（操作过快）：田点本身有效，绝不拉黑。
        // 中止本轮剩余行（不再向后续行继续加压），按 streak 指数退避重排下轮补派。
        rateLimitStreak++;
        log.info(
          'farm march rate-limited, stop burst and back off. row=%d kind=%d x=%d y=%d streak=%d',
          rawIdx,
          cand.marchType,
          cand.x,
          cand.y,
          rateLimitStreak,
        );
        break;
      }
      if (row.level === 6) {
        // 6 级田会刷新复活：不进 run 期硬拉黑，改在池条目记「解禁时刻」，超 L6_BLOCK_MS 自动重新参与候选
        var le = lvl6Pool.get(ck);
        if (le) le.blockedUntil = Date.now() + L6_BLOCK_MS;
      } else {
        blacklist.add(ck); // 其余被拒（点被别人抢/已失效等）零成本：拉黑换下一候选
      }
      // 下田 902 被服务器拒（非限流类）属采集循环里的预期竞争态，非错误 → info
      log.info(
        'farm march rejected. row=%d kind=%d x=%d y=%d code=%s why=%s',
        rawIdx,
        cand.marchType,
        cand.x,
        cand.y,
        ret.code,
        errKey || '-',
      );
    }
    if (t < missingPos.length - 1) await sleep(cfg.marchInterval);
  }
  backlogActive = missingPos.length > dispatched;
}

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

/**
 * 采集行军到家（march.onHomeReturn 复播，state→ARRIVED_HOME 边沿）→ 该行缺位 → 唤醒补派。
 * 全局单点订阅的代价：march.js 常驻 10019，feat 暂停仍会收到复播 → 回调内自判 alive 为硬约束；
 * 只认采集类行军（marchType 3/26）回城，其它行军回城不唤醒（免空跑）。
 *
 * 副防线（英雄释放延迟）：回城复播时 UserData 兵池已立即刷新，但
 * HeroController.getHaveHeroCanMarchList() 依赖独立的英雄释放推送，通常晚 1~2s 到达。
 * 此处故意延迟 1.5s 再唤醒，给英雄推送落地的时间窗口；主防线见 cyclePass 的 presetHasHeroes 守卫。
 * @param {object} m 归一化 March
 */
function onFarmMarchHome(m) {
  if (!aliveFn()) return;
  var mt = m && m.type | 0;
  if (mt !== KIND_FARM && mt !== KIND_TOWER) return; // 只认采集行军回城
  setTimeout(function () {
    if (aliveFn()) pushWake();
  }, 1500);
}

/** @type {Function|null} march.onHomeReturn 退订句柄（防 resume 重激活重复注册） */
var offHomeReturn = null;

/**
 * 10452 联盟记录增量推送：新建成机械田即时入活表；命中则唤醒补扫（新田可能填补某行缺位）。
 * payload 外层结构未知，做容错：d / d.ret / 单条（d.specId）/ d.data。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 */
function onAllianceRecordPush(ev) {
  if (!aliveFn()) return;
  var d = ev && ev.data;
  if (!d) return;
  var arr = Array.isArray(d)
    ? d
    : Array.isArray(d.ret)
      ? d.ret
      : [d.specId != null ? d : d.data || d];
  var hit = false;
  for (var i = 0; i < arr.length; i++) {
    try {
      if (ingestMechRecord(arr[i])) hit = true;
    } catch (err) {}
  }
  if (hit) pushWake();
}

// ── 6 级田开田邮件（刷新信号） ────────────────────────────────
/**
 * 邮件 → 王者遗迹刷新信号解析（报文实证 dashcam 20261004T202430-异能秘境-我是队长-发车.ndjson：
 * push 10264 的 ev.data 就是邮件本体（title/content/sendTime/mailType 平铺），
 * title=「遗迹区域刷新」、content=「书院✨小北对坐标(408,308)的王者遗迹-资源遗迹进行了刷新操作，此次刷新资源类型为农田。」、
 * sendTime=1791119020（服务器秒）、mailType=9（同 mailShowConfig 130157 的 '1|9' ⇒ 邮件展示组 1））：
 * 标题字面匹配 + 正文坐标落在 L6_RELIC_ANCHORS 之一 + 刷新距今 < L6_MAIL_FRESH_SEC（4h 有效期，实证田 expireTime≈sendTime+14400）。
 * 正文括号/逗号兼容全半角（同游戏邮件坐标识别 /[(｜（)\d+(,｜，)\d+[)｜）]/ 口径）。
 * 不落在已知锚点的刷新一律不扫（限住扫图爆炸半径，同竞品B relices 白名单口径）。
 * 正文还带「此次刷新资源类型为 农田/油田/金矿」（“为”后可有空格）→ 解出 family 供扫图 cycle 做家族闸（只勾粮则油邮件整锚点不扫）；
 *   未知文案回 family=0（fail-open：照扫，家族真值仍以扫回的 RESOURCE[itemId].resource_type 为准，绝不因不认识就漏扫）。
 * @param {object} m 邮件对象 {title,content,sendTime}
 * @returns {{key:string,sendTime:number,family:number}|null}
 */
function parseRelicMail(m) {
  if (!m || m.title !== L6_MAIL_TITLE) return null;
  var st = Number(m.sendTime) || 0;
  var now = gameData.serverTime() || 0;
  if (!st || (now && now - st >= L6_MAIL_FRESH_SEC)) return null; // 过期刷新：田早已消失，扫了也白扫
  var content = String(m.content || '');
  var mt = content.match(/坐标[（(](\d+)[，,](\d+)[)）]/);
  if (!mt) return null;
  var x = Number(mt[1]) | 0;
  var y = Number(mt[2]) | 0;
  var tm = content.match(/资源类型为\s*([^\s。]+)。/);
  var fam = tm && L6_MAIL_TYPE_TO_FAMILY[tm[1]] != null ? L6_MAIL_TYPE_TO_FAMILY[tm[1]] : 0;
  for (var i = 0; i < L6_RELIC_ANCHORS.length; i++) {
    var a = L6_RELIC_ANCHORS[i];
    if (a.x === x && a.y === y) return { key: x + ',' + y, sendTime: st, family: fam };
  }
  return null;
}

/**
 * 记待扫锚点（以 (锚点,sendTime) 去重：同封邮件被推送/轮询多次检测也只入队一次），并唤醒扫图 cycle。
 * @param {{key:string,sendTime:number,family:number}} r parseRelicMail 命中结果
 */
function markRelicPending(r) {
  var scanned = lvl6Scanned[r.key] || 0;
  if (scanned >= r.sendTime) return; // 已处理过该次（或更晚）刷新：去重，绝不重复扫
  lvl6PendingAnchors.set(r.key, { sendTime: r.sendTime, family: r.family });
  relicCycle.kick();
}

/**
 * 一批邮件里拣出刷新信号并记待扫锚点（纯读，不改游戏数据）。
 * @param {object[]} list 邮件数组
 * @returns {number} 命中数
 */
function scanRelicMails(list) {
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    var r = parseRelicMail(list[i]);
    if (!r) continue;
    n++;
    markRelicPending(r);
  }
  if (n) log.info('relic refresh mails from mail cache=%d', n);
  return n;
}

/**
 * 10264 PUSH_SINGLE_MAIL：单封邮件推送 → 命中「遗迹区域刷新」即记待扫锚点 + 唤醒补扫。
 * 报文实证 ev.data 就是邮件本体（title/content/sendTime 平铺），仍照 onAllianceRecordPush 保留容错
 * （先 parseData 拆可能串化的业务体，再探 d.mail / d.data.mail / d）。
 * @param {object} ev net 推送事件（载荷在 ev.data）
 */
function onRelicMailPush(ev) {
  if (!aliveFn()) return;
  var d = parseData(ev && ev.data);
  if (!d || typeof d !== 'object') return;
  var m = d.mail || (d.data && d.data.mail) || d;
  var r = parseRelicMail(m);
  if (!r) return;
  log.info('relic refresh mail push. anchor=%s sendTime=%d', r.key, r.sendTime);
  markRelicPending(r);
}

// ── 生命周期 ────────────────────────────────────────────────────────
/**
 * 安装：取网络底座 + 数据中心（本人行军改走 core/march.list()，不再依赖 NWorldMapData）。
 * 任一缺失即失败（reactor 不会激活）。
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
 * 配置灌入：归一化 rules；规则行删减后同步作废越界账本行；运行中即时唤醒一轮让新规则生效。
 * @param {object} partial reactor 推送的面板配置
 * @returns {object} MCFG
 */
function configure(partial) {
  if (!partial) return MCFG;
  if (partial.rules != null) MCFG.rules = normalizeRules(partial.rules);
  // 时段闸：toModuleCfg 已把 timeRanges 归一为 {s,e} 分钟数，这里只整体接收、绝不二次归一（防读不到扁平结构而静默失效）。
  MCFG.timeWindowEnabled = !!partial.timeWindowEnabled;
  MCFG.timeRanges = Array.isArray(partial.timeRanges) ? partial.timeRanges : [];
  if (ledgerLoaded) {
    var pruned = false;
    for (var key in ledger) {
      if (
        Object.prototype.hasOwnProperty.call(ledger, key) &&
        !(+key >= 0 && +key < MCFG.rules.length)
      ) {
        delete ledger[key];
        pruned = true;
      }
    }
    if (pruned) persistLedger();
  }
  if (installed && aliveFn()) {
    cycle.kick();
    relicCycle.kick(); // 家族勾选可能变了 → 立即重评扫图家族闸
  }
  return MCFG;
}

/**
 * 运行：复位状态 → 挂 10019 监听 → 账本读回后点火。
 * pause 后 alive()=false 定时器自然停摆；resume（scene/mode 恢复）重新点火补扫。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  backlogActive = false;
  rateLimitStreak = 0;
  outsideWindow = false;
  outsideRemaining = 0;
  lastPushWakeAt = 0;
  ledgerLoaded = false;
  ledgerLoading = false;
  ledger = {};
  blacklist = new Set();
  mechLive = new Map();
  mechLoaded = false;
  mechLoading = null;
  mechLoadedAt = 0;
  lvl6Pool = new Map();
  lvl6PendingAnchors = new Map();
  lvl6Scanned = {};
  lvl6ScanRetry = {};
  l6MailLoaded = false;
  ctx.on.push(PUSH_ALLIANCE_RECORD, onAllianceRecordPush);
  ctx.on.push(PUSH_SINGLE_MAIL, onRelicMailPush); // 6 级田开田信号：联盟成员刷新王者遗迹的邮件
  if (offHomeReturn) offHomeReturn(); // 先退再挂，防 resume 重激活重复注册
  offHomeReturn = march.onHomeReturn(onFarmMarchHome);
  log.info(
    'started (rules=%d rows, window=%s).',
    MCFG.rules.length,
    MCFG.timeWindowEnabled ? 'on' : 'off',
  );
  loadMechRecords();
  // 6 级田：先从盘读回候选池与去重表（回填后派兵立即能取点、刷新页免重扫高危 901），读完再点火扫图 cycle（不阻塞派兵 cycle）。
  loadLvl6().then(function () {
    if (aliveFn()) relicCycle.kick();
  });
  cycle.kick();
}

/**
 * 田位规则字段选项（farmrules 控件的下拉数据源）。
 * familyOptions 顺序按用户列举（金/粮/油/雷神）；level 1~6；preset 1~16（1~8 战斗预设 / 9~16 采集预设，调 API 时拆回 index+type）。
 * @type {object}
 */
var RULE_OPTS = {
  familyOptions: [
    { value: 7, label: '金矿' },
    { value: 5, label: '粮食' },
    { value: 1, label: '石油' },
    { value: 16, label: '雷神' },
  ],
  levelOptions: (function () {
    var a = [];
    for (var lv = 1; lv <= 6; lv++) a.push({ value: lv, label: lv + ' 级' });
    return a;
  })(),
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
    'mailData?', // 6 级田扫图 cycle 读邮件列表用（软依赖：mailManager 由邮件 subpack 载入时挂上，未就绪时扫图 cycle 下拍自然重探）
  ],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: { enabled: false, rules: [], timeWindowEnabled: false, timeRanges: [] },
  fields: [
    {
      key: 'rules',
      label: '下田规则',
      type: 'farmrules',
      familyOptions: RULE_OPTS.familyOptions,
      levelOptions: RULE_OPTS.levelOptions,
      presetOptions: RULE_OPTS.presetOptions,
      hint: '6 级田不走 906 搜索，也不全天扫图：由独立扫图周期监听+轮询「遗迹区域刷新」邮件（只扫已勾选家族、同封邮件只扫一次），扫到的候选池持久化且仅在刷新后 4 小时内可采；其余等级优先机械田、未勾「只下机械」再搜普通田',
    },
    {
      key: 'timeWindowEnabled',
      label: '启用下田时段',
      type: 'checkbox',
    },
    {
      key: 'timeRanges',
      label: '下田时段',
      type: 'timeranges',
      showIf: function (cfg) {
        return !!cfg.timeWindowEnabled;
      },
      hint: '仅在所列时段内下田；时段外立即撤田，直到下个时段到来。开始>结束视为跨午夜',
    },
  ],
  toModuleCfg: function (c) {
    return {
      rules: normalizeRules(c.rules),
      timeWindowEnabled: !!c.timeWindowEnabled,
      timeRanges: normalizeTimeRanges(c.timeRanges),
    };
  },
  install: install,
  configure: configure,
  run: run,
});
