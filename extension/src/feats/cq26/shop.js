/**
 * CQ26 印石·霜之密所抢购（cq26Shop）
 *
 * 玩法：CQ26 期间若干中立城各开一座「密所」（CNC Shop / Mystery Shop），**城主宣布开市**（2445，需 DECLARE 权限）
 * 后进入营业态（status=2），货架 9 件商品共享一份全服库存（buy_limit_all=40）、本人另有 5 次总购买额度。
 * 实测开市 ~77s 内两个所就打到 356/360、332/360（8/9 件售罄）→ 迟到一分钟基本无货，故本 feat 的核心是「贴脸下单」。
 *
 * 协议清单（号源 NRequestIdV2/NResponseIdV2 实证；CQ26 由 ConquerorSession.initReplaceMap 把整套
 *   CQ2025_CNC_SHOP_* 换成 SERIES_FROST_NEUTRAL_CITY_SHOP_*，表名 conqueror_2025_cnc_shop → series_frost_cnc_shop，
 *   UI 与逻辑完全复用 CQ25，只换号）：
 *   2442 SHOP_GET_INFO        req {}                      resp {shop:[…], cScore, endSec, canBuyCnt}    快照轮询（兜底）
 *   2443 SHOP_GET_SINGLE_INFO req {id:Int64}              resp {info:{id,status,statusEndSec,buyCnt,tax,canRevRedPack}, playerInfo}  状态到期补查 + **开市单所快查**（游戏 onShopOpen 同式）
 *   2444 SHOP_BUY             req {id:Int64, cfgId, cnt:1} resp {canBuyCnt, selfBuyCnt, buyCnt, tax}（**消费侧源码实证**：
 *                              CQ25CNCShopMainNode.onBuyCallBack 逐字读 e.data.canBuyCnt / .tax / .selfBuyCnt / .buyCnt 回写 shopMainData；
 *                              我方录制零命中，故仍保留一次性 dump 核形）
 *   2441 SHOP_VIEW_OR_GET_RED_PACK req {id:Int64, get:bool} resp {info:{record:[{uid,…}],…}}             领红包（get=true）
 *   2445 SHOP_OPEN / 2446 SHOP_SEND_RED_PACK / 2447 SHOP_BUY_RECORD —— 登记不接线（开市/发红包是城主决策，2447 只喂流水面板）
 *   22030 push NEUTRAL_CITY_SHOP_ICON {type:1|2, id:Int64}  type=1 开市、type=2 红包 —— **主触发**（该商店族唯一 push）
 *
 * 判据（与游戏严格同源，印石-我的日常趟实录报文实证）：
 *   货架真源 = `Object.keys(shop.buyCnt)`（CQ25CNCShopMainNode.updateItemListUI 原式：拿 buyCnt 的 key 去查表、按 .order 排序），
 *     **不是**按档位枚举整表；实测每所恰 9 件，cfg 空间 1–11（普通城 cityShowNum 3001–3006）/ 101–111（高级城 4001），
 *     每所从所属档位里随机缺一到两件 → 静态目录 CFG_CATALOG 只作面板保底，实际候选仍按 buyCnt 键集裁。
 *   商品身份 = **品种 + 数量**（表行 item_id + item_num）：同品种不同数量是两个商品（实测橙色万能碎片有 x15/x3 两档，
 *     行名只出品种会撞成两行看不出差别）；同品种同数量若在不同档位各占一行，则是**同一个商品**（面板一行、
 *     勾选共用、剩余量相加）。游戏侧行名同口径（竞品 cname = `item_num + "个" + 物品名`），本面板把数量放在名后（x15）。
 *     ⚠ 报文侧库存/限购**按 cfg 行**计（buy_limit_all 在表上、buyCnt/selfBuyCnt 的键就是 cfg id），故商品只是「同货的
 *     若干 cfg 行」的别名，下单仍逐 (shopId,cfg) 发；面板 goods 的键是商品键（见 productKey / productsOfRows）。
 *   status 机：1 待开市 → 2 营业中（唯一可买，游戏侧 maskNode.active = 2!==status）→ 3 税收/红包期 → 4 结算。
 *     status=1 的 statusEndSec 是**最迟开市截止**（实测四个 status1 所同为 1794063600），**不是开市时刻**：
 *     开市是城主手动 2445，没有任何可提前量的权威信号。
 *   push 22030 与 1→2 翻转**同秒**（决定性证据：push ts=1794052802/1794052808 ↔ 翻转后 statusEndSec=1794139202/1794139208，
 *     差恰 86400=营业 24h；四所开市 == 四条 push，零漏零多：csn3002/3003（sid 3765）与 csn3005/3006（sid 3281），
 *     即用户指的 S3765/S3281 两区就是在 11/7 这天由城主逐所宣布开市）⇒ push 是最快的权威信号，轮询只作漏收自愈。
 *   另一条决定性证据：status=1 的 2442 所行**已带齐 9 个 buyCnt 键**（货架不缺）——故收到 type=1 后无需等任何
 *     应答就能直接构造候选（本地翻牌），2443 只做后台校正（见 onPushOpen）。
 *   贴脸时序的两个约束（2026-11-11 一场实录逐笔对齐后定下，详见 feat 文档「用时」一节）：
 *     a) 本轮首包只花 2ms（push 到达→2444 上 wire），服务器记的「用时」42ms、排 2/40；但一个新所的开市撞上
 *        正在飞的那轮 burst 时，首包会排到下一个轮次边界（实测晚 245~274ms、名次掉到 21）——故重试间隔走
 *        burstPacer.pause，新所到达即叫醒（逐条 BUY_GAP_MS 不受影响，同所两件节奏不变）。
 *     b) sendGuarded 在同步段就写 socket，2443 与面板同步渲染留在同步段会把 2444 挤后——两者都挤到下一个微任务。
 *   密所 id 为 19 位（实测如 4918151952583191043，≈4.9e18）> 2^53，全程字符串往返（见 idStr），禁 Number()。
 *
 * 闸门（全部源码同源，逐件判定，见 buildCandidates）：
 *   总次数：剩余 = Number(gameConf.dataConfig(81268)) − snap.canBuyCnt（canBuyCnt 是**已用**，主面板 lover_gift_key24 同式）
 *   可买态：shop.status === 2
 *   全服库存：row.limitAll − (shop.buyCnt[cfg]||0) > 0        // ≤0 → rank_shop_05「售罄」
 *   本人限购：(shop.selfBuyCnt[cfg]||0) < row.limit            // 游戏原式无 limit>0 豁免，此处同构 → activity95_009
 *   逐商品本期总上限：goods[商品键].max>0 时 Σ各所 selfBuyCnt + 在飞 + 本批已分配 < max（用户分配旋钮，0=无上限；
 *     2026-11-12 恢复：两波错峰开市 + 5 次额度，第一波全押会让高级城零发包）
 *   积分门槛：row.score ≤ snap.cScore                          // 否则 conqueror2025_city33/46
 *   钻石余额：累计 need_gold ≤ resourceAmount(Gold=10，玩家侧显示为「钻石」)（竞品原式同构：A `need_gold <= gold`、B 余额减本轮累计）
 *     ——「钻石保留额」面板项已废弃，不退让到余额以下
 *   面板「总数量」列：Σ_{status≤2 的所} max(0, row.limitAll − shop.buyCnt[cfg])（逐 cfg 行求和，= 该商品全部商店剩余之和；
 *     status 3/4 不计——那里已买不到，计入只会虚报）；快照未到显 '—'，不猜数
 *   备钻（清单页脚）：把勾选商品的可买份数（逐 (所,cfg) 取 min(全服剩余, 本人限购余量) 并过积分门槛）按单价降序
 *     展开，取**最贵的 N 份**求和，N = 本期剩余额度；无 mirror 时无份数可展 → 退到「最贵单价 × N」并写明是估算
 * 前置闸：cq26IsOpen()=false → **一个包都不发**（含 2442）；dataConfig 81268 取不到/非法 → 额度不可得，整拍跳过（warn 去重）
 *
 * 系统固定参数（原面板项已废弃或内化，逐项带竞品实证）：
 *   下单间隔 BUY_GAP_MS=100：竞品B 候选循环内每条 2444 前 `asleep(100)`（并先删 `_requestTimePool[CQ2025_CNC_SHOP_BUY]` 绕频控），
 *     且它的 `setting.interval` 只在 render 里透传、UI 从不读写——即竞品也是硬编码系统值；竞品A 每拍只发 1 条，无间隔概念。
 *   兜底轮询 IDLE_POLL_SEC=60：开市 push 同秒已实证，轮询只作漏收自愈；竞品A 用 2s 常驻全量轮询、竞品B 只在启动后 5s 探一次，
 *     取两者之间的静默档，不做 2s 级高频轮询。
 *   单次开市下单上限 = 本期剩余额度：竞品B 直接 `slice(0, 81268 − canBuyCnt)` 截候选，没有独立的「单次」旋钮——maxPerBurst 已废弃。
 *   启用抢购 / 顺带领红包 = 恒开（两位竞品的红包领取均无条件；启用与否交给菜单的通用开关，不再设 feats 自有的二级总闸）。
 *
 * 本地镜像收敛（规避「直发不回写 UserData → 逐拍重发」陷阱）：我们的 2444 不经游戏 UI，游戏侧
 *   CQ25Controller.neutralData.shopMainData 不会感知，故模块内自建 mirror 作唯一判据源，**绝不读游戏 neutralData**（陈旧）：
 *   2444 成交 → 应答带的四个字段按游戏原式**整体回写**（canBuyCnt 覆盖全局、selfBuyCnt/buyCnt 覆盖该所两张表）；
 *     应答未带才退回乐观 selfBuyCnt[cfg]++ / buyCnt[cfg]++ / canBuyCnt++。
 *   2442/2443 应答 → 服务器值覆盖 mirror；**burst 在飞时**取 max 合并（快照可能早于我们刚发出的 2444 落库，防镜像回退导致同件重买）。
 *   **canRevRedPack 例外**：实证 2442 所行键集不含此位（只在 2443 info 下），故 projectShop 不投影它、
 *     applySnapshot 反而**跨快照承接**旧镜像里由 2443 探得的权威位；否则每拍被 2442 抹回未知 → sweepRedPack 每拍重发 2443 补查。
 *
 * 面板刷新：商品总数量列 / 页脚备钻 / 密所状态行都是「行结构不变、值随快照变」的只读格，只走事件驱动一条通路——
 *   applySnapshot / requestSingle / settleBuy / onPushOpen 四处 pokePanel()（EVT.UI_REFRESH，**刻意不带 rebuild**：
 *   带它会整卡重渲染、拆掉用户正在拖拽的行 DOM 与其监听），由 core/ui/panel.js 的 refreshTexts 就地改文本；无 UI 定时器。
 *   onPushOpen 那一处排在下一个微任务（贴脸路径不做同步渲染，见上「贴脸时序」b）。
 *
 * 已知缺口（诚实声明，交付后需真人开市补证才能固化为对拍）：
 *   1) 2444 的应答**形状**已由消费侧源码钉死（onBuyCallBack 只读这四个字段），但**我方录制里 2444 零命中**
 *      （全库 5 个 uid、39 个录制，与「从未成功购买」吻合）——即字段存在性无报文级证据，故保留首次成交全量 dump；
 *      另注：该回调的奖励面板 items 是客户端用配置表**自拼**（{itemId:row.item_id,itemCount:row.item_num}），
 *      即 **2444 应答不携带奖励明细**，买到什么只能自己读表行 —— 故表行不可得时 fail-closed 不下单。
 *   2) 2441 应答 / 22030 type=2 / canRevRedPack 录制里**零出现**（玩家未走到结算期），红包触发条件属源码推导；
 *      故首次 2444/2441 成功各打一条全量应答 dump（dumped 标志位约束、只打一次），把推断形态升级为实证形态。
 *   3) 各业务拒绝码（售罄/积分不足/次数用尽/非营业期/钻石不足）未知 → 拒绝处理走「通用计数 + 60s 冷却 + 连续 3 次当日拉黑」，
 *      不按码分派（抢购节奏快，冷却不能沿用 excav 的 5min）。
 *
 * 刻意不做：不发 2445 开市 / 2446 发红包（需 hasAuthority(DECLARE)，是城主决策，不是脚本该抢的权）；
 *   不接聊天通道拿密所商人卡（ChatCQ25ShopMerchantItem 的 cstp）——实证竞品B 的主触发确实是聊天卡
 *   （onNewChatPush 匹配 conqueror2025_city27「我开启了印石秘所，快来抢购！」后解析 cstp.id → 3s 重试窗买），
 *   但我方 22030 已实测与翻转同秒且零漏，接聊天会引入 feats/system/chat → feats/cq26 的反向依赖，违反依赖方向红线；
 *   不做「买后自动使用/寄售」，不改游戏 neutralData，
 *   不调任何 Update/Delete 类游戏接口；不做 2s 级全量高频轮询（push 已实证同秒，轮询只作漏收自愈）。
 */
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { bus, EVT } from '../../core/bus.js';
import { gameData, gameConf, bits, l10n, worldMap } from '../../core/game-api.js';
import { item } from '../../core/item.js';
import { createCycle } from '../../core/cycle.js';
import {
  CODE_NOT_SENT,
  createWaker,
  rejectText,
  safeStringify,
  sleep,
  todayStr,
} from '../../core/util.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-SHOP');

// ── 常量 ──────────────────────────────────────────────────────────────
/** SHOP_VIEW_OR_GET_RED_PACK：req {id, get}，get=true 即领 */
const CMD_RED_PACK = 2441;
/** SHOP_GET_INFO：全量快照（唯一权威读通道） */
const CMD_GET_INFO = 2442;
/** SHOP_GET_SINGLE_INFO：单所补查（带 canRevRedPack） */
const CMD_SINGLE = 2443;
/** SHOP_BUY：本 feat 唯一写动作 */
const CMD_BUY = 2444;
// CMD_OPEN=2445（城主宣布开市）/ 2446 发红包 / 2447 流水 —— 登记不接线，理由见文件头「刻意不做」
/** push NEUTRAL_CITY_SHOP_ICON：{type:1 开市 | 2 红包, id}，与 status 1→2 翻转同秒 */
const PUSH_SHOP_ICON = 22030;
/** 购买总次数配置（游戏主面板 updateBuyCntUI 同源） */
const CFG_TOTAL = 81268;
/** 钻石资源号（实证 GameDefine：ResourceType.Gold=10；ResourceNameConst[10]=loc 100017=「钻石」——枚举名 Gold 具误导，玩家侧实为钻石） */
const RES_GOLD = 10;
/** 城档表（两期共用，ConquerorSession 只换货架表不换它）；游戏侧排序比的就是它的 .level */
const CITY_LEVEL_TABLE = 'cnc_city_level';
/** 物品表语义名（l10n 经 TableName 枚举解析，与 potion-craft 同口径）：货架行只给 item_id，名字要现查 */
const ITEM_TABLE = 'ITEM';
/** PBV2 通道名（四处发包共用，避免字面量重复触发 sonarjs/no-duplicate-string） */
const PROTO = 'sendPBV2';
/** cfg 静态保底目录：表读空时面板仍能列出可选项（运行期枚举返回空是踩过的坑） */
const CFG_CATALOG = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
];
/** 表不可读时面板占位商品键的前缀（见 placeholderKey） */
const CFG_PREFIX = 'cfg';
/** 同一 (shopId,cfg) 连续被拒达此次数即**当日**拉黑 */
const MAX_REJECT = 3;
/** 单次被拒后的冷却毫秒（开市瞬间的时序竞争要在本场内自愈，5min 太长） */
const REJECT_COOL_MS = 60 * 1000;
/** 贴脸 burst 的重试窗长度（毫秒） */
const BURST_RETRY_MS = 3000;
/** 重试窗内重跑候选生成的间隔（**可被新所开市提前结束**，见 burstPacer） */
const BURST_RETRY_GAP_MS = 400;
/**
 * 逐条 2444 之间的最小间隔（**系统值**，面板不再暴露）：实证取竞品B 的 `asleep(100)`；
 *   竞品A 每拍只发 1 条（节奏由它的 2s 轮询决定）故无"间隔"概念。抢购节奏里这个值不给用户自由度。
 */
const BUY_GAP_MS = 100;
/**
 * 兜底轮询秒数（**系统值**）：开市 push 22030 已实证与 status 1→2 同秒，轮询只作漏收自愈；
 *   竞品A 2s 常驻 / 竞品B 仅启动后 5s 探一次，取静默档 60s（待开市快档仍由面板 nearPollSec 控制）。
 */
const IDLE_POLL_SEC = 60;
/** 81268 不可得时的「本轮件数」估值（只用于页脚备钻文案，不参与闸门；实测上限 5 次——见文件头 canBuyCnt 语义） */
const QUOTA_EST = 5;
/** CQ26 未开启时的长睡（活动级 fail-closed，不发包也不空转） */
const OFF_ACTIVITY_MS = 5 * 60 * 1000;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入 toModuleCfg 产物） */
var MCFG = buildDefaults();
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {{shops:Array<object>,cScore:number,endSec:number,canBuyCnt:number,atSec:number}|null}
 *  密所快照的**本地镜像**（唯一判据源；候选生成绝不读游戏 neutralData） */
var mirror = null;
/** @type {Object<string,number>} cityLevelId → cnc_city_level.level（同帧拆出的标量，跨帧可用） */
var levelCache = {};
/** @type {Object<string,number>} (shopId:cfg) → 连续被拒次数 */
var rejectCount = {};
/** @type {Object<string,number>} (shopId:cfg) → 冷却到期时刻（Date.now() 基准） */
var coolUntil = {};
/** @type {string} rejectCount/coolUntil 所属服务器日（换日清空，使「当日拉黑」真止于当日） */
var rejectDay = '';
/** @type {Object<string,boolean>} shopIdStr → 红包已处理（本地置灰，不重复发 2441） */
var redPackDone = {};
/** @type {boolean} burst 互斥（同刻至多一轮开市下单） */
var bursting = false;
/** @type {boolean} burst 在飞时又收到新触发（开市 push 撞上轮询 burst）：置位，由当前轮 finally 末尾合并补扫一轮，不整轮丢弃 */
var burstPending = false;
/**
 * burst 轮次间隔的「可提前结束」休眠句柄：新所开市撞上正在飞的那轮时叫醒它，让它立刻重跑候选生成。
 *   实测不接这个句柄时，新所首包只能排到下一个 400ms 重试边界（push→2444 实测 245~274ms，而单轮首包只花 2ms）。
 *   刻意**不覆盖**逐条 BUY_GAP_MS：同一所两件之间的节奏是系统值，保持原样（跨所并行是另一件事）。
 */
var burstPacer = createWaker();
/** @type {boolean} 「额度配置不可得」warn 去重（恢复后复位） */
var quotaWarned = false;
/** @type {boolean} 「货架表不可读」warn 去重 */
var rowsWarned = false;
/** @type {boolean} 首次 2444/2441 应答的全量 dump 是否已打过（一次性固化推断形态） */
var dumpedBuy = false;
var dumpedRedPack = false;
/** @type {{text:string,atSec:number}|null} 面板展示用的最近一次成交 */
var lastDeal = null;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（快照/push/表读都不需要额外 install）。
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
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入：整体接收 toModuleCfg 已归一化的运行时配置（绝不二次归一）。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (!partial) return MCFG;
  MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：订阅开市/红包 push 并点火首轮快照（退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  // 刻意**不**在此清 rejectCount/coolUntil：places/kinds 门控会反复 pause→run（进出 homeland、base/world 来回跳），
  //   清零等于给一个服务器侧永久拒绝的 (所,件) 无限续命逐拍重撞；「当日拉黑」必须跨 activate 成立，日界由 rolloverReject 收。
  ctx.on.push(PUSH_SHOP_ICON, onIconPush);
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉镜像与红包置灰，避免 resume 后拿陈旧快照发写请求。
 * cycle 的自重排由 alive() 自守，push 退订由 reactor 托管，本处无自建定时器。
 */
function pause() {
  mirror = null;
  levelCache = {};
  redPackDone = {};
}

function aliveFn() {
  return reactor.isRunning('cq26Shop');
}

// ── 形态工具 ──────────────────────────────────────────────────────────
/**
 * Int64 → 十进制字符串（双路兜底）：Long 实例走 int64Str，裸 {_low,_high} POJO 时它会得到
 * '[object Object]'，故非纯数字串再回落 int64Decimal（BigInt 拼装，无精度损失）。
 * @param {*} v Long 实例 / {_low,_high} / 数字 / 数字串
 * @returns {string} 十进制串，不可解析回 ''
 */
function idStr(v) {
  var s = bits.int64Str(v);
  if (/^\d+$/.test(s)) return s;
  var d = bits.int64Decimal(v);
  return /^\d+$/.test(d) ? d : '';
}

/**
 * 十进制字符串 id 升序（等价游戏的 Int64.compare，避开 >2^53 的 Number 有损转换）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function cmpIdStr(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 密所行 → 同帧标量副本（报文对象属池化产物，不可跨帧保留；口径同 excav.projectSite）。
 * ownServer / level 在此现取（只有快照构造期能摸游戏符号），使 buildCandidates 保持纯函数。
 * @param {object} s 报文行
 * @param {number} selfSid UserData.ServerId
 * @returns {object} 新造对象
 */
function projectShop(s, selfSid) {
  var id = idStr(s && s.id);
  var lid = Number(s && s.cityLevelId) || 0;
  if (!(lid in levelCache)) {
    // 游戏原式：TABLE.getTableDataById(cnc_city_level, cityLevelId).level（取不到按同等档处理）
    var r = l10n.tableRow(CITY_LEVEL_TABLE, lid);
    levelCache[lid] = r ? Number(r.level) || 0 : 0;
  }
  return {
    idStr: id,
    sid: Number(s && s.sid) || 0,
    cityId: Number(s && s.cityId) || 0,
    cityLevelId: lid,
    level: levelCache[lid],
    cityShowNum: Number(s && s.cityShowNum) || 0,
    status: Number(s && s.status) || 0,
    statusEndSec: Number(s && s.statusEndSec) || 0,
    tax: Number(s && s.tax) || 0,
    opened: !!(s && s.opened),
    // canRevRedPack 刻意不从 2442 所行投影：实证 105 条快照行的键集不含此位（只在 2443 info 下），
    //   读它会恒得 false 而误判「无红包」。留空（undefined=未知），由 applySnapshot 跨快照承接 2443 的权威位。
    buyCnt: cntMap(s && s.buyCnt),
    selfBuyCnt: cntMap(s && s.selfBuyCnt),
    ownServer: selfSid > 0 && Number(s && s.sid) === selfSid,
  };
}

/**
 * {cfgId:已售数} → 键归一为十进制串的副本（报文里的键可能是数字或字符串，两套口径必须钉成一条）。
 * @param {object} src 原始计数对象
 * @returns {Object<string,number>}
 */
function cntMap(src) {
  var out = {};
  if (!src || typeof src !== 'object') return out;
  var ks = Object.keys(src);
  for (var i = 0; i < ks.length; i++) {
    var k = String(ks[i]);
    out[k] = Number(src[ks[i]]) || 0;
  }
  return out;
}

/**
 * PBV2 推送取业务体：整包是 {header,data}，下钻一层；平铺载荷原样回落（同 excav.pushBody）。
 * @param {object} ev 推送事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o.data || o;
}

/**
 * 总额度（Number(dataConfig(81268))）。
 * @returns {number} 0 = 不可得或非法（调用方按 fail-closed 跳过整拍）
 */
function resolveQuota() {
  var raw = gameConf.dataConfig(CFG_TOTAL);
  if (raw === '' || raw == null) return 0;
  var n = Number(raw);
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * 钻石可用额（三态：resourceAmount 读不到 → null，调用方按「放行」处理，最终以服务器拒绝为裁决）。
 * 「钻石保留额」面板项已废弃：竞品原式就是 need_gold ≤ 余额（A 取余额、B 取余额减本轮累计已花），
 *   不留退让额度——保留额只会在余额够时少抢一件，而抢购迟到即无货。
 * @returns {number|null}
 */
function goldBudget() {
  return gameData.resourceAmount(RES_GOLD); // 本轮累计已花在 burst 的 state.spent 里扣
}

// ── 候选生成（纯函数）─────────────────────────────────────────────────
/**
 * 商品身份键：品种 + 数量（表行 item_id + item_num）。
 * 用户口径钉死：「只有品种+数量才能构成一个商品」——同 item_id 不同 item_num 是两个商品（橙色万能碎片
 *   x15 与 x3 各自一行、各自可勾）；反过来同一 (item_id, item_num) 在不同档位各占一行（普通城 5 / 高级城 105）
 *   是同一个商品：合成一行、共用勾选、总数量取两处之和。
 * 键带 'i' 前缀且含 'x'，与旧存档的纯 cfg 数字键、与表不可读时的 'cfgN' 占位键都不会碰撞（迁移见 normalizeCfg）。
 * @param {number} itemId 表行 item_id
 * @param {number} num 表行 item_num（单份数量）
 * @returns {string}
 */
function productKey(itemId, num) {
  return 'i' + (Number(itemId) || 0) + 'x' + (Number(num) || 0);
}

/**
 * 表不可读时的面板占位商品键（`cfg7` 形态）：与商品键 `i..x..`、与旧存档的纯 cfg 键 `7` 都不碰撞。
 * goodsPool 的保底行、normalizeCfg 的保底池、旧勾选/旧拖拽序的迁移**必须同式**，故收口成一处生成。
 * @param {number|string} cfg cfg 档号
 * @returns {string}
 */
function placeholderKey(cfg) {
  return CFG_PREFIX + cfg;
}

/** cfg id 升序（表行枚举与同一商品的多 cfg 行都需要稳定序） */
function cmpCfg(a, b) {
  return (Number(a) || 0) - (Number(b) || 0);
}

/**
 * 表行 → 商品索引：`productKey → {key, itemId, num, gold, cfgs:string[]}`，cfgs 按 cfg id 升序。
 * 刻意只存 cfg 串、不存行对象：闸门/库存仍逐 cfg 现查 rows，不在这里造第二份数据真相。
 * gold 取该商品首个 cfg 行的单价（同货不同档位单价按表设计一致；万一不同也只是估值）。
 * @param {object|null} rows gameData.cq26ShopRows() 产物（null → 空索引）
 * @returns {Object<string,object>}
 */
function productsOfRows(rows) {
  var out = {};
  var ks = rows ? Object.keys(rows) : [];
  ks.sort(cmpCfg);
  for (var i = 0; i < ks.length; i++) {
    var r = rows[ks[i]] || {};
    var pk = productKey(r.itemId, r.num);
    var p = out[pk];
    if (!p) {
      p = out[pk] = {
        key: pk,
        itemId: Number(r.itemId) || 0,
        num: Number(r.num) || 0,
        gold: Number(r.gold) || 0,
        cfgs: [],
      };
    }
    if (p.cfgs.indexOf(ks[i]) < 0) p.cfgs.push(ks[i]);
  }
  return out;
}

/**
 * 面板 goodsOrder → 去重且补全的商品键优先级串数组（未登记的商品追加在后，与 fields.orderPoolItems 同口径）。
 * @param {string[]} order 面板拖拽序（商品键；旧存档的 cfg 数字键已由 normalizeCfg 迁移）
 * @param {Object<string,object>} prods productsOfRows 产物（补全集 = 表上真实存在的全部商品）
 * @returns {string[]}
 */
function priorityOrder(order, prods) {
  var seen = {};
  var out = [];
  var src = Array.isArray(order) ? order : [];
  for (var i = 0; i < src.length; i++) {
    var k = String(src[i]);
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(k);
  }
  var ks = Object.keys(prods || {});
  for (var j = 0; j < ks.length; j++) {
    if (!seen[ks[j]]) {
      seen[ks[j]] = 1;
      out.push(ks[j]);
    }
  }
  return out;
}

/**
 * 货架行 → 展示名（**品种+数量**，如「橙色万能碎片x15」）：数量是商品身份的一部分，不拼上去就会与同品种其他档撞行。
 * 三级回退全在 item.label 里（登记表 → rawName 译键 → '道具 N'），
 *   本处只负责把 rawName 备齐：离线拿不到密所奖池的 item_id（本地无 series_frost_cnc_shop 表数据），
 *   故**不向 core/item.js 的 ITEM_NAMES 硬塞未知 id**，而是运行期现查 item 表的 name loc 键。
 * 单件钻石价不拼进行名：由 itemlist 的 `fd.costCol` 红色列与 `fd.stockText` 总数量列分列渲染（价与价、量与量同列对齐）。
 * @param {object|null} row cq26ShopRows 的一行（或等价标量 {itemId,num}）
 * @returns {string}
 */
function goodsLabel(row) {
  if (!row || !row.itemId) return '未知物品';
  var ir = l10n.tableRow(ITEM_TABLE, row.itemId);
  var n = Number(row.num) || 0;
  return item.label(row.itemId, ir && ir.name) + (n > 0 ? 'x' + n : '');
}

/**
 * 游戏显示序（本服优先 → cnc_city_level.level 降 → Int64 升）：下单内层序与面板状态表共用这一条口径。
 * 游戏原式比 .level（缺行按同等）；此处 level=0（表缺）时退到 cityLevelId 降序，不给未知档加权。
 * @param {Array<object>} shops 所集合（不动原数组）
 * @returns {Array<object>} 新排序数组
 */
function sortByGameOrder(shops) {
  return (shops || []).slice().sort(function (a, b) {
    if (a.ownServer !== b.ownServer) return a.ownServer ? -1 : 1;
    var la = a.level || a.cityLevelId;
    var lb = b.level || b.cityLevelId;
    if (la !== lb) return lb - la;
    return cmpIdStr(a.idStr, b.idStr);
  });
}

/**
 * 纯函数：本轮应下单的有序清单（不读模块态、不摸游戏符号，闸门全部显式传参，供单测与未来对拍复用）。
 * 排序三轴：外层=面板 goods 优先级（商品键，下标即优先级）→ 中层=密所的游戏显示序（本服优先 → 城档 level 降 → id 升）
 *   → 内层=该商品在这一所的 cfg 行（同货多档时逐个判闸）→ 逐件过文件头「闸门」六条 → 截断到（剩余总次数 − 本轮已下发）。
 * 注：下单总量由本期总额度一道总闸控制（maxPerBurst 面板项已废弃，与竞品B `slice(0, 额度)` 同形）；
 *   2026-11-12 恢复逐商品「本期总上限」分配旋钮（goods[商品键].max，含已抢、0=无上限）：
 *   实测两波错峰开市 + 本期仅 5 次额度，第一波全押会让高级城零发包，故把分配权交给用户。
 * @param {object|null} snap 本地镜像 {shops,cScore,canBuyCnt}
 * @param {object|null} rows gameData.cq26ShopRows() 产物（null=表不可读 → 闸门不可判定 → 空清单）
 * @param {object} panel {goods,goodsOrder,quotaTotal,dispatched,spentGold,byProduct,cool,reject,now}
 * @param {number} nowSec 服务器秒
 * @param {number|null} goldAvail 钻石可用额（null=无从判定 → 不拦，最终以服务器拒绝为裁决）
 * @returns {Array<{shopIdStr:string,cfgStr:string,cfgId:number,key:string,row:object,shop:object}>}
 */
export function buildCandidates(snap, rows, panel, nowSec, goldAvail) {
  var out = [];
  if (!snap || !rows || !panel || !Array.isArray(snap.shops)) return out;
  void nowSec; // 货架/状态判定不依赖时刻（时刻只用于快照新鲜度与面板展示，由调用方负责）
  var quota = Number(panel.quotaTotal) || 0;
  var remain = quota - (Number(snap.canBuyCnt) || 0);
  if (remain <= 0) return out;
  // 单次开市上限不存在独立旋钮（maxPerBurst 已废弃）：本轮还能发多少就发多少，与竞品B slice(0, 额度) 同形
  var cap = remain - (Number(panel.dispatched) || 0);
  if (cap <= 0) return out;
  var goods = panel.goods || {};
  var prods = productsOfRows(rows);
  var cool = panel.cool || {};
  var rej = panel.reject || {};
  var now = panel.now == null ? Date.now() : panel.now;
  var budget = goldAvail == null ? Infinity : Number(goldAvail);
  // shops 过滤 status<=2（status1 所也进显示序，由逐件的 status===2 闸拦下——与游戏 toggle 列出的集合一致）
  var shops = sortByGameOrder(
    snap.shops.filter(function (s) {
      return s && s.status <= 2;
    }),
  );
  var order = priorityOrder(panel.goodsOrder, prods);
  // spent 以本轮已下发金额为初值（跨重试轮累计）：应答未落库时 goldBudget 仍读旧余额，靠此账防重试轮重复预算
  var spent = Number(panel.spentGold) || 0;
  for (var i = 0; i < order.length && out.length < cap; i++) {
    var pk = order[i];
    var g = goods[pk];
    if (g && g.on === false) continue; // 面板取消勾选（未登记=默认 on）
    var prod = prods[pk];
    if (!prod) continue; // 面板残留的商品键已不在表上（换季/表变）：不猜货，直接跳过
    // 逐商品本期总上限（0=无上限）：已抢(Σ各所 selfBuyCnt) + 在飞(byProduct) 先计，本批每分配一件再 +1
    var capN = Number(g && g.max) || 0;
    var usedN =
      capN > 0 ? sumBought(snap.shops, prod.cfgs) + (Number((panel.byProduct || {})[pk]) || 0) : 0;
    for (var j = 0; j < shops.length && out.length < cap; j++) {
      var s = shops[j];
      if (s.status !== 2) continue; // 唯一可买态
      // 内层走本商品在该所上榜的 cfg 行（普通城/高级城同款同量时一个商品可占多行）
      for (var m = 0; m < prod.cfgs.length && out.length < cap; m++) {
        var cfgStr = prod.cfgs[m];
        if (!(cfgStr in s.buyCnt)) continue; // 该所未上架此档（货架真源 = buyCnt 的 keys）
        var row = rows[cfgStr];
        if (!row) continue; // 表外 cfg：价格/库存/限购全不可判定 → 不买（fail-closed）
        var needGold = Number(row.gold) || 0;
        var key = s.idStr + ':' + cfgStr;
        if ((cool[key] || 0) > now) continue;
        if ((rej[key] || 0) >= MAX_REJECT) continue;
        if (Math.max(0, (Number(row.limitAll) || 0) - (s.buyCnt[cfgStr] || 0)) <= 0) continue; // 全服库存打满
        if ((s.selfBuyCnt[cfgStr] || 0) >= (Number(row.limit) || 0)) continue; // 本人限购
        if (capN > 0 && usedN >= capN) continue; // 逐商品本期总上限（含已抢+在飞+本批）
        if ((Number(row.score) || 0) > (Number(snap.cScore) || 0)) continue; // 积分门槛
        if (spent + needGold > budget) continue; // 钻石预算（余额 − 本轮累计已花）
        spent += needGold;
        usedN++;
        out.push({
          shopIdStr: s.idStr,
          cfgStr: cfgStr,
          cfgId: Number(cfgStr) || 0,
          key: key,
          productKey: pk,
          row: row,
          shop: s,
        });
      }
    }
  }
  return out;
}

// ── 快照与补查 ────────────────────────────────────────────────────────
/**
 * 推一次面板刷新：清单「总数量」列、页脚备钻、密所状态表都是“行结构不变、值随快照变”的只读格，
 *   只靠这条事件驱动通路就地重算（面板未开时 core/ui/index.js 早退，开销可忽略）。
 * 刻意**不带 rebuild**：带它会整卡重渲染，把用户正在拖拽/输入的行 DOM 拆掉（此处行集不随快照变，无需重建）。
 */
function pokePanel() {
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 发 2442 取全量快照并灌入 mirror。
 * @param {string} tag 触发来源（日志）
 * @returns {Promise<boolean>} 是否拿到了可用快照
 */
async function refresh(tag) {
  if (!net) return false;
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_GET_INFO,
    {},
    {
      protocol: PROTO,
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) return false;
  if (ret && ret.code === CODE_NOT_SENT) {
    // 读通道不升 warn：带闸的 2442 在「push 补快照」与「轮询拍」撞车时恒命中在途闸（下一拍自愈），
    //   只有发送真抛错才值得警报（日志四级契约：warn 只给真异常）。
    if (sendErr) log.warn('2442 send threw: %s. tag=%s', sendErr, tag);
    else log.debug('2442 not sent (in-flight gate or timeout). tag=%s', tag);
    return false;
  }
  if (!ret || !ret.ok) {
    log.info(
      '2442 rejected. tag=%s code=%s reason=%s',
      tag,
      ret ? ret.code : 'unknown',
      rejectText(ret),
    );
    return false;
  }
  return applySnapshot(ret.data, tag);
}

/**
 * 2442 应答 → mirror（服务器优先；burst 在飞时取 max 合并乐观增量）。
 * @param {object} d 应答 data
 * @param {string} tag 日志来源
 * @returns {boolean} 形态是否可用
 */
function applySnapshot(d, tag) {
  // 线上传输字段名是 **shop**（不是 shops）：实证 neutralData.shopMainData=pbAckV2.data，而游戏侧处处读 `.shop`
  //   （createToggleUI 的 t.shop.length / t.shop.sort、updateShopUI 的 this._shops）；mirror 内部叫 shops 只为可读。
  var list = d && d.shop;
  if (!Array.isArray(list)) {
    log.warn('2442 malformed (no shop array). tag=%s', tag);
    return false;
  }
  var selfSid = worldMap.serverId();
  var shops = list.map(function (s) {
    return projectShop(s, selfSid);
  });
  // 跨快照承接 canRevRedPack：2442 所行不带此位（见 projectShop 注记），若不承接则每拍归零 → sweepRedPack 每拍重发 2443 补查。
  //   旧镜像里已由 2443 探得权威位（true/false）的所，直接继承；领过的另有 redPackDone 置灰。
  if (mirror) {
    var prevById = {};
    for (var pi = 0; pi < mirror.shops.length; pi++)
      prevById[mirror.shops[pi].idStr] = mirror.shops[pi];
    for (var ci = 0; ci < shops.length; ci++) {
      var p = prevById[shops[ci].idStr];
      if (p && p.canRevRedPack != null) shops[ci].canRevRedPack = p.canRevRedPack;
    }
  }
  var used = Number(d.canBuyCnt) || 0;
  if (bursting && mirror) used = mergeOptimistic(shops, mirror, used);
  mirror = {
    shops: shops,
    cScore: Number(d.cScore) || 0,
    endSec: Number(d.endSec) || 0,
    canBuyCnt: used,
    atSec: gameData.serverTime() | 0,
  };
  log.debug(
    '2442 snapshot. tag=%s shops=%d cScore=%d used=%d/%d',
    tag,
    shops.length,
    mirror.cScore,
    used,
    resolveQuota(),
  );
  pokePanel();
  return true;
}

/**
 * burst 在飞时的双源合并：快照可能早于我们刚发出的 2444 落库，计数取 max 防镜像回退导致同件重买。
 * @param {Array<object>} next 新镜像的所数组（就地修改）
 * @param {object} prev 旧镜像
 * @param {number} used 服务器回传的已用次数
 * @returns {number} 合并后的已用次数
 */
function mergeOptimistic(next, prev, used) {
  var byId = {};
  for (var i = 0; i < prev.shops.length; i++) byId[prev.shops[i].idStr] = prev.shops[i];
  for (var j = 0; j < next.length; j++) {
    var o = byId[next[j].idStr];
    if (!o) continue;
    bump(o.buyCnt, next[j].buyCnt);
    bump(o.selfBuyCnt, next[j].selfBuyCnt);
  }
  return Math.max(used, Number(prev.canBuyCnt) || 0);
}

/** src 里大于 dst 的计数写回 dst（只增不减：已售/已购都是单调量） */
function bump(src, dst) {
  var ks = Object.keys(src || {});
  for (var i = 0; i < ks.length; i++) {
    var v = Number(src[ks[i]]) || 0;
    if (v > (Number(dst[ks[i]]) || 0)) dst[ks[i]] = v;
  }
}

/**
 * 发 2443 补查单个密所（状态到期/红包期自愈；同游戏 cpnUpdate100MS 的 _needRequest 通道）。
 * 2443 是 canRevRedPack 的唯一权威源（2442 所行不带），故也是红包兜底线补齐判据的手段。
 * @param {string} shopIdStr 密所 id（十进制串）
 * @returns {Promise<object|null>} 补查后的所（失败/停用回 null），供 sweepRedPack 就地读权威位
 */
async function requestSingle(shopIdStr) {
  if (!net || !shopIdStr) return null;
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_SINGLE,
    { id: bits.int64(shopIdStr) },
    {
      protocol: PROTO,
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  var sh = findShop(shopIdStr);
  if (!aliveFn()) return null;
  if (ret && ret.code === CODE_NOT_SENT) {
    // 带闸读通道：闸门命中（在途同拍）不升 warn（下拍自愈），只有发送真抛错才值得警报（日志四级契约）。
    if (sendErr) log.warn('2443 send threw: %s. shop=%s', sendErr, shopIdStr);
    else log.debug('2443 not sent (in-flight gate or timeout). shop=%s', shopIdStr);
    return sh;
  }
  if (!ret || !ret.ok) {
    log.info(
      '2443 rejected. shop=%s code=%s reason=%s',
      shopIdStr,
      ret ? ret.code : 'unknown',
      rejectText(ret),
    );
    return sh;
  }
  var info = ret.data && ret.data.info;
  if (!info || !sh) return sh;
  // 2443 带 canRevRedPack（实证 updateShopData），是红包期唯一权威判据来源
  sh.status = Number(info.status) || sh.status;
  sh.statusEndSec = Number(info.statusEndSec) || sh.statusEndSec;
  sh.tax = Number(info.tax) || sh.tax;
  // canRevRedPack 按原式直接赋值（不粘旧值）：它就是「红包还在不在」的唯一权威位，
  //   领完后补查必须能把它压回 false，否则 sweepRedPack 会反复重发 2441。
  sh.canRevRedPack = !!info.canRevRedPack;
  if (info.buyCnt) sh.buyCnt = cntMap(info.buyCnt);
  pokePanel(); // 单所补查带回了新 buyCnt/status：状态行与总数量列当场跟上
  return sh;
}

/** @param {string} shopIdStr @returns {object|null} mirror 里的所 */
function findShop(shopIdStr) {
  if (!mirror || !shopIdStr) return null;
  for (var i = 0; i < mirror.shops.length; i++)
    if (mirror.shops[i].idStr === shopIdStr) return mirror.shops[i];
  return null;
}

// ── push 入口 ─────────────────────────────────────────────────────────
/**
 * 22030：type=1 开市（主触发，与 1→2 翻转同秒）、type=2 红包。
 * @param {object} ev 推送事件
 */
function onIconPush(ev) {
  if (!aliveFn()) return;
  var b = pushBody(ev);
  var type = Number(b && b.type);
  var id = idStr(b && b.id);
  if (!id) {
    log.warn('22030 malformed (no id).');
    return;
  }
  if (type === 1) onPushOpen(id);
  else if (type === 2)
    void claimRedPack(id, true); // 红包恒领（原面板项 redPack 已废弃，竞品两侧均无条件）
  else log.debug('22030 ignored. type=%s', type);
}

/**
 * 贴脸开市时序：本地直接翻牌（省一个 RTT）→ 立即 burst；面板刷新与 2443 单所快查**让位给 2444**。
 * 为何能不等任何应答就下单：实证 2442 快照里 **status=1 的所已带齐 9 个 buyCnt 键**（货架不缺），
 *   而开市本就是 push type=1 本身——即 status 2 是 push 给出的权威结论，本地翻牌不损信息。
 * 2443 只作为**后台校正**（刷新该所的 statusEndSec/tax/buyCnt，并接上 canRevRedPack 这个唯一权威位），
 *   绝不参与下单时序（与游戏侧 onShopOpen 命中当前所时发 requestShopSingleData 同一动作，但游戏是在 UI 上等）。
 *   本端 wire 顺位：sendGuarded 的同步前缀就写 socket，故留在同步段发 2443 会把 2444 挤后（实测 2443 早 2ms）；
 *   挪到下一个微任务后，上面 lead.then 已先入队、burst 在其同步段把首包推上 wire，2443 只能排在它后面。
 * 缓存里没有这一所（刚开 feat / 快照陈于其所）时，才退回 2442 全量快照作前导。
 * @param {string} id 开市密所 id
 */
function onPushOpen(id) {
  // 活动闸前置：burst 自带自查，但下面的 refresh('push-lead')（2442 读通道）不经它——
  //   活动刚退场/漂移时收到一条残留 push，不拦就会打一条 15s 超时的 2442（与 §「一个包都不发」相违）。
  if (!gameData.cq26IsOpen()) return;
  var sh = findShop(id);
  if (sh && sh.status === 1) sh.status = 2;
  // 无独立「启用抢购」闸：aliveFn（菜单开关/暂停）已在 onIconPush 入口拦下
  var lead = sh ? Promise.resolve() : refresh('push-lead');
  lead
    .then(function () {
      return burst('push#' + id, true);
    })
    .catch(function (err) {
      log.warn('push open flow threw: %s', (err && err.message) || String(err));
    });
  // 本地翻牌的面板同步与后台快查都挤到下一个微任务：状态列仍不等应答（一个微任务内就动），
  //   但贴脸路径上不再做同步渲染、也不再把 2443 排在 2444 前面。
  queueMicrotask(function () {
    pokePanel();
    if (!sh) return;
    requestSingle(id).catch(function (err) {
      log.debug('2443 push-lead threw: %s', (err && err.message) || String(err));
    });
  });
}

// ── burst ─────────────────────────────────────────────────────────────
/**
 * 一轮开市下单：候选一次生成 → **管线化**裸发（`gate:false`，逐条间隔 BUY_GAP_MS，不等应答）→
 *   可选重试窗内重跑候选生成补漏。
 * 为什么必须 gate:false：net.sendGuarded 的在途闸门命中即回落 CODE_NOT_SENT，而 burst 期间玩家手点
 *   或上一包尚未回，都可能让 2444 在途——带闸会把我们的包**静默吞掉**（等价竞品删 _requestTimePool[BUY] 的动机）。
 *   绕过后节奏与上限由本模块自己保证：BUY_GAP_MS 间隔（系统值）+ cap=剩余额度−已下发。
 * @param {string} reason 触发来源（日志）
 * @param {boolean} retry 是否进入 3s 重试窗（贴脸 true，轮询兜底 false）
 * @returns {Promise<void>}
 */
async function burst(reason, retry) {
  // 写动作唯一入口自查活动闸：轮询拍虽已被 gatedPass 拦在前头，但 push 贴脸路径不经过它，
  //   而密所本身只存在于 CQ26 期（符号缺失即判未开启）——不拦就会在漂移/退场瞬间漏出 2444。
  if (!gameData.cq26IsOpen()) return;
  if (bursting) {
    // 贴脸 push 撞上正在飞的另一轮 burst（轮询兜底或上一条 push）：**不整轮丢弃**，攒一个补扫标志，
    //   由当前轮 finally 末尾合并再跑一轮，否则「轮询 burst 在飞 → 新所的开市 push 被吞」只能等下一拍（60s）。
    burstPending = true;
    // 光攒补扫标志不够：补扫要等当前轮跑完（重试窗最长 3s），实测新所首包因此晚 245~274ms。
    //   当前若正睡在轮次间隔上就一并叫醒，让下一轮立即重跑候选生成（本轮已排队的逐条间隔不受影响）。
    var woken = burstPacer.wake();
    log.debug('burst busy, queued pending resweep. reason=%s woken=%s', reason, woken);
    return;
  }
  // 早于任何 await 占位：冷启动 mirror 缺失时会 await refresh，若互斥标志晚置，两条 push 可同时越过检查。
  bursting = true;
  /** @type {Object<string,number>} key → 缺省 未碰 / 1 已发出待应答 / 2 已成交、被拒或结果未知（本轮不再碰） */
  var state = Object.create(null);
  /** @type {{dispatched:number,goldSpent:number}} 本轮已**真正上 wire** 的包数与累计钻石（未发出的退回） */
  var stats = { dispatched: 0, goldSpent: 0, byProduct: Object.create(null) };
  var panel = {
    goods: MCFG.goods,
    goodsOrder: MCFG.goodsOrder,
    quotaTotal: 0, // try 内 resolveQuota 后回填真实额度；buildCandidates 只在循环里读，构造期这个 0 不会被读到
    dispatched: 0,
    spentGold: 0,
    cool: coolUntil,
    reject: rejectCount,
    now: Date.now(),
  };
  try {
    if (!mirror && !(await refresh('burst-lead'))) return;
    var quota = resolveQuota();
    if (quota <= 0) {
      noteQuota();
      return;
    }
    var rows = gameData.cq26ShopRows();
    if (!rows) {
      noteRows();
      return;
    }
    rowsWarned = false;
    quotaWarned = false;
    panel.quotaTotal = quota;
    var deadline = Date.now() + (retry ? BURST_RETRY_MS : 0);
    var round = 0;
    for (;;) {
      round++;
      // 跨重试轮累计：dispatched 约束件数、spentGold 约束金额（应答未落库时 goldBudget 读到旧余额，靠此账防砸空）
      panel.dispatched = stats.dispatched;
      panel.spentGold = stats.goldSpent;
      panel.byProduct = stats.byProduct;
      panel.now = Date.now();
      var cands = buildCandidates(
        mirror,
        rows,
        panel,
        gameData.serverTime() | 0,
        goldBudget(),
      ).filter(function (c) {
        return !state[c.key];
      });
      if (cands.length) {
        log.info('burst %s round=%d n=%d', reason, round, cands.length);
        for (var i = 0; i < cands.length; i++) {
          state[cands[i].key] = 1;
          stats.dispatched++;
          stats.goldSpent += Number(cands[i].row.gold) || 0;
          stats.byProduct[cands[i].productKey] = (stats.byProduct[cands[i].productKey] || 0) + 1;
          sendBuy(cands[i], state, stats); // 不 await：管线化，下一包不等上一包应答
          if (!aliveFn()) return;
          await sleep(BUY_GAP_MS);
        }
      } else if (round === 1 || !retry) break;
      if (Date.now() >= deadline || !aliveFn()) break;
      await burstPacer.pause(BURST_RETRY_GAP_MS);
    }
  } finally {
    bursting = false;
    if (burstPending && aliveFn()) {
      burstPending = false;
      void burst(reason + '+pending', true);
    }
  }
}

/**
 * 发一条 2444 并就地结算（永不 reject：sendGuarded 已收口双通道失败）。
 * @param {object} c buildCandidates 产出的候选
 * @param {Object<string,number>} state 本轮 key 状态表
 * @param {{dispatched:number,goldSpent:number,byProduct:Object<string,number>}} stats 本轮已下发计数（未发出时退回）
 */
async function sendBuy(c, state, stats) {
  if (!net) return;
  var t0 = Date.now();
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_BUY,
    { id: bits.int64(c.shopIdStr), cfgId: c.cfgId, cnt: 1 },
    {
      protocol: PROTO,
      gate: false,
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  // 停用期间的应答不记账（mirror 已随 pause 丢弃，resume 后重读）
  if (!aliveFn()) return;
  if (ret && ret.code === CODE_NOT_SENT) {
    // gate:false 下 CODE_NOT_SENT 只可能来自 sendGuarded 的 catch，分两种，必须差异处理：
    //   a) withTimeout 15s 超时：包**已上 wire**、只是应答丢失 → 可能已成交；
    //   b) 发送入口返回 !ok（cdTime 频控/needDisable/编码失败）：包**确未上线**。
    var timedOut = sendErr.indexOf('no server response') >= 0;
    if (timedOut) {
      // 结果未知：不退回重试（否则对同一 (所,件) 重复下单、多花钻石/额度），本轮不再碰 + 冷却；
      //   真成交与否交由下一拍 2442 权威快照纠偏（成交则 buyCnt/canBuyCnt 上涨 → 候选自然被闸掉）。
      state[c.key] = 2;
      coolUntil[c.key] = Date.now() + REJECT_COOL_MS;
      log.warn(
        '2444 outcome unknown (sent, no ack). shop=%s cfg=%s err=%s',
        c.shopIdStr,
        c.cfgId,
        sendErr,
      );
    } else {
      // 确未上线：退回 key 状态与件数/钻石账，使其能在重试窗内再补（不是服务器拒绝，不计入拒绝计数）
      state[c.key] = 0;
      stats.dispatched = Math.max(0, stats.dispatched - 1);
      stats.goldSpent = Math.max(0, stats.goldSpent - (Number(c.row.gold) || 0));
      stats.byProduct[c.productKey] = Math.max(0, (stats.byProduct[c.productKey] || 0) - 1);
      log.warn('2444 not sent (threw: %s). shop=%s cfg=%s', sendErr, c.shopIdStr, c.cfgId);
    }
    return;
  }
  if (!ret || !ret.ok) {
    state[c.key] = 2;
    noteReject(c, ret);
    return;
  }
  state[c.key] = 2;
  settleBuy(c, ret, Date.now() - t0);
}

/**
 * 成交结算：按游戏原式整表回写权威值，缺字段才退回乐观自增（mirror 是唯一判据源，游戏侧不感知我们的直发）。
 * @param {object} c 候选
 * @param {object} ret Ret{ok,code,data}
 * @param {number} costMs 往返耗时
 */
function settleBuy(c, ret, costMs) {
  var d = (ret && ret.data) || {};
  if (!dumpedBuy) {
    dumpedBuy = true;
    log.info('2444 first ack dump. %s', safeStringify(ret.data));
  }
  var sh = findShop(c.shopIdStr);
  var cfg = c.cfgStr;
  // 原式：shopMainData.canBuyCnt = e.data.canBuyCnt；shop.selfBuyCnt/buyCnt = e.data.selfBuyCnt/buyCnt（**整张表替换**，不是只改买到的那件）
  if (mirror) {
    var auth = d.canBuyCnt == null ? NaN : Number(d.canBuyCnt);
    mirror.canBuyCnt = isFinite(auth) ? auth : (mirror.canBuyCnt || 0) + 1;
  }
  if (sh) {
    if (d.selfBuyCnt && typeof d.selfBuyCnt === 'object') sh.selfBuyCnt = cntMap(d.selfBuyCnt);
    else sh.selfBuyCnt[cfg] = (sh.selfBuyCnt[cfg] || 0) + 1;
    if (d.buyCnt && typeof d.buyCnt === 'object') sh.buyCnt = cntMap(d.buyCnt);
    else sh.buyCnt[cfg] = (sh.buyCnt[cfg] || 0) + 1;
    if (d.tax != null) sh.tax = Number(d.tax) || sh.tax;
  }
  rejectCount[c.key] = 0;
  delete coolUntil[c.key];
  var cost = Number(c.row.gold) || 0;
  lastDeal = {
    text:
      'cs' +
      (sh ? sh.cityShowNum : '?') +
      '·cfg' +
      c.cfgId +
      ' ' +
      goodsLabel(c.row) +
      ' -' +
      cost +
      '钻',
    atSec: gameData.serverTime() | 0,
  };
  log.info(
    'bought S%d shop=%s cfg=%d %s gold=%d left=%d/%d cost=%dms',
    sh ? sh.sid : 0,
    c.shopIdStr,
    c.cfgId,
    goodsLabel(c.row),
    cost,
    mirror ? Math.max(0, resolveQuota() - mirror.canBuyCnt) : 0,
    resolveQuota(),
    costMs,
  );
  pokePanel(); // 成交回写的 buyCnt/canBuyCnt 直接决定总数量列与备钻，不等下一拍 2442
}

/**
 * 业务拒绝：拒绝码语义未知（录制零命中），故一律「计数 + 冷却 + 当日拉黑」，info 级不升 warn。
 * @param {object} c 候选
 * @param {object} ret Ret{code,data}
 */
function noteReject(c, ret) {
  var n = (rejectCount[c.key] = (rejectCount[c.key] || 0) + 1);
  coolUntil[c.key] = Date.now() + REJECT_COOL_MS;
  log.info(
    '2444 rejected. shop=%s cfg=%s code=%s reason=%s streak=%d%s',
    c.shopIdStr,
    c.cfgId,
    ret ? ret.code : 'unknown',
    rejectText(ret),
    n,
    n >= MAX_REJECT ? ' (blacklisted today)' : '',
  );
}

/** 日界滚清：拉黑/冷却计数只属当日（口径同 excav.rolloverReject） */
function rolloverReject(nowSec) {
  var d = todayStr(nowSec);
  if (d === rejectDay) return;
  rejectDay = d;
  rejectCount = {};
  coolUntil = {};
}

// ── 红包线 ────────────────────────────────────────────────────────────
/**
 * 领红包：2441 {id, get:true}（源码 openShopEnvelopList(id, !!canRevRedPack) 同式）。
 * 判重：应答 record[].uid 含本人（StrUid）则在日志里标 mine，且无论如何本地置灰不再发（每所每会话一次）。
 * @param {string} shopIdStr 密所 id
 * @param {boolean} force 权威触发（push type=2）：mirror 里的 canRevRedPack 可能早于红包产生那次轮询，
 *   陈旧为 false 不能反过来否掉 push（否则 type=2 永远不领）
 * @returns {Promise<void>}
 */
async function claimRedPack(shopIdStr, force) {
  if (!gameData.cq26IsOpen()) return; // 同上：活动闸不只拦轮询拍
  if (!net || !shopIdStr || redPackDone[shopIdStr]) return;
  if (!force) {
    var sh = findShop(shopIdStr);
    if (!sh || sh.canRevRedPack !== true) return; // 非权威路径只按已知为 true 才领（undefined=未补查、false=无红包，均不领）
  }
  var rpErr = '';
  var ret = await net.sendGuarded(
    CMD_RED_PACK,
    { id: bits.int64(shopIdStr), get: true },
    {
      protocol: PROTO,
      onError: function (err) {
        rpErr = (err && err.message) || String(err);
      },
    },
  );
  if (!aliveFn()) return;
  if (ret && ret.code === CODE_NOT_SENT) {
    // 与 refresh/requestSingle 同构：带闸通道的在途闸门命中只配 debug（下拍自愈），只有发送真抛错才 warn。
    if (rpErr) log.warn('2441 send threw: %s. shop=%s', rpErr, shopIdStr);
    else log.debug('2441 not sent (in-flight gate or timeout). shop=%s', shopIdStr);
    return;
  }
  if (!ret || !ret.ok) {
    log.info(
      '2441 rejected. shop=%s code=%s reason=%s',
      shopIdStr,
      ret ? ret.code : 'unknown',
      rejectText(ret),
    );
    return;
  }
  if (!dumpedRedPack) {
    dumpedRedPack = true;
    log.info('2441 first ack dump. %s', safeStringify(ret.data));
  }
  var rec = (ret.data && ret.data.info && ret.data.info.record) || [];
  var me = gameData.strUid();
  var mine = me
    ? Array.isArray(rec) &&
      rec.some(function (r) {
        return bits.int64Str(r && r.uid) === me;
      })
    : false;
  redPackDone[shopIdStr] = true;
  log.info(
    'red packet claimed. shop=%s record=%d mine=%s',
    shopIdStr,
    Array.isArray(rec) ? rec.length : 0,
    mine,
  );
  requestSingle(shopIdStr); // 游戏在领完红包后同样补查单所（把 canRevRedPack 归位为 false）
}

/**
 * 结算期红包兜底线（status===4 && opened && 未领）。push type=2 是即时主触发，本函数只在漏收 push 时自愈。
 * 关键：2442 所行不带 canRevRedPack（实证），故判据未知时**先发 2443 补查拿回权威位**，再决定领不领；
 *   否则旧式「直接读快照位的 canRevRedPack」恒为 undefined → 兜底线完全不可达。补查后按权威 true 才领。
 */
async function sweepRedPack() {
  if (!mirror) return;
  for (var i = 0; i < mirror.shops.length; i++) {
    var s = mirror.shops[i];
    if (s.status !== 4 || !s.opened || redPackDone[s.idStr]) continue;
    // 已知无可领红包（上一拍 2443 探得 false 并被 applySnapshot 承接）→ 跳过，不重复补查
    if (s.canRevRedPack === false) continue;
    // 未知（undefined）→ 先拿 2443 权威位；已知 true → 直接领
    var cur = s.canRevRedPack === true ? s : await requestSingle(s.idStr);
    if (cur && cur.canRevRedPack === true) await claimRedPack(cur.idStr, false);
  }
}

// ── 调度 ──────────────────────────────────────────────────────────────
/**
 * 活动级 fail-closed 闸门：CQ26 未开启时**一个包都不发**（含 2442 快照）——在未开放的服务器上这些号根本不应答，
 *   发了就是每拍一条 15s 超时刷屏。抽成导出的高阶函数，是为了让「零发包」可被单测直接断言（不依赖 net 桩）。
 * @param {boolean} open gameData.cq26IsOpen()
 * @param {Function} pass 开启时才准跑的整拍（返回下拍延迟毫秒）
 * @returns {Promise<number>} 下拍延迟毫秒
 */
export async function gatedPass(open, pass) {
  if (!open) return OFF_ACTIVITY_MS;
  return pass();
}

/**
 * 单拍：活动闸 → 额度闸 → 2442 快照 → 兜底 burst → 结算期红包 → 择时。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  var nextMs = await gatedPass(gameData.cq26IsOpen(), cyclePass);
  // 在飞期间攒下的触发（配置变更等）是权威信号，立即补一拍
  if (cycle.pending) return 0;
  return nextMs;
}

/**
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cyclePass() {
  var nowSec = gameData.serverTime() | 0;
  if (nowSec > 0) rolloverReject(nowSec);
  var quota = resolveQuota();
  if (quota <= 0) {
    noteQuota();
    return sec(IDLE_POLL_SEC);
  }
  quotaWarned = false;
  if (await refresh('poll')) {
    await burst('poll', false);
    await sweepRedPack(); // 红包恒扫（原 redPack 面板项已废弃）
  }
  return nextDelay(nowSec);
}

/**
 * 兜底轮询档位：只要还有 status=1（待开市）的所就用快档，否则用静默档。
 * 为何不用「statusEndSec 临近」做判据：实证那个值是**最迟开市截止**（实测比真实开市 push 早 ~3h），
 *   开市是城主手动、无可提前量的随机时刻，`statusEndSec-now<120s` 恒不成立→快档会退成死代码。
 *   故改为「有待开市的所即快轮询」：这段正是唯一可能漏收 push 且迟到即无货的窗口；全部开完/结算后自动回静默档。
 * @param {number} nowSec
 * @returns {number} 毫秒
 */
function nextDelay(nowSec) {
  void nowSec;
  if (bursting) return 1000;
  if (!mirror) return sec(IDLE_POLL_SEC);
  var pending = mirror.shops.some(function (s) {
    return s.status === 1;
  });
  return sec(pending ? MCFG.nearPollSec : IDLE_POLL_SEC);
}

function sec(n) {
  return Math.max(1000, (Number(n) || IDLE_POLL_SEC) * 1000);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: 60000 });

// ── 面板 ──────────────────────────────────────────────────────────────
/**
 * 面板 items：**一行一个商品**（品种+数量）。
 * 表可读时按 productsOfRows 合并（同 item_id+item_num 的多个 cfg 行合成一行，cfgs 记住全部行），
 *   行名带数量（goodsLabel）——只出品种会把橙色万能碎片 x15 与 x3 撞成两行看不出差别；
 *   表不可读时退回 cfg 静态保底目录（placeholderKey 占位，保证面板不空——运行期枚举返回空是踩过的坑）。
 * 行 id 就是商品键（表可读）或占位键（表不可读），与 normalizeCfg 的 goods 键同一套。
 * @returns {Array<{id:string,label:string,cost:number,cfgs:string[]}>}
 */
function goodsPool() {
  var rows = gameData.cq26ShopRows();
  var prods = productsOfRows(rows);
  var keys = Object.keys(prods);
  if (!keys.length) {
    return CFG_CATALOG.map(function (cfg) {
      var k = placeholderKey(cfg);
      return { id: k, label: k, cost: 0, cfgs: [String(cfg)] };
    });
  }
  return keys.map(function (k) {
    var p = prods[k];
    return { id: k, label: goodsLabel(rows[p.cfgs[0]]), cost: p.gold, cfgs: p.cfgs };
  });
}

/**
 * 纯函数：该商品在各所的可买明细 `[{row, shop, all, self}]`（all=全服剩余 limitAll−buyCnt，self=本人限购余量 limit−selfBuyCnt）。
 * 只进 status≤2 的所（红包期/已结束买不到，计入只会虚报）；未上架此 cfg 的所不出现（货架真源 = buyCnt 键集）。
 * 面板两个只读数（总数量列、备钻页脚）共用这一套口径；rows/shops 不可得 → null（三态：未知，不是 0）。
 * @param {object|null} rows 表行
 * @param {Array<object>|null} shops 镜像的所数组
 * @param {string} key 商品键（goodsPool 的行 id）
 * @returns {Array<{row:object,shop:object,all:number,self:number}>|null}
 */
export function unitsOfProduct(rows, shops, key) {
  if (!rows || !Array.isArray(shops)) return null;
  var p = productsOfRows(rows)[key];
  var out = [];
  if (!p) return out;
  for (var j = 0; j < shops.length; j++) {
    var s = shops[j];
    if (!s || s.status > 2) continue;
    for (var m = 0; m < p.cfgs.length; m++) {
      var c = p.cfgs[m];
      var r = rows[c];
      if (!r || !(c in s.buyCnt)) continue;
      out.push({
        row: r,
        shop: s,
        all: Math.max(0, (Number(r.limitAll) || 0) - (Number(s.buyCnt[c]) || 0)),
        self: Math.max(0, (Number(r.limit) || 0) - (Number(s.selfBuyCnt[c]) || 0)),
      });
    }
  }
  return out;
}

/**
 * 镜像版可买明细（只读格都走 mirror，不读游戏 neutralData，理由见文件头「本地镜像收敛」）。
 * @param {object|null} rows 表行
 * @param {string} key 商品键
 * @returns {Array<object>|null}
 */
function productUnits(rows, key) {
  return unitsOfProduct(rows, mirror ? mirror.shops : null, key);
}

/**
 * 纯函数：面板只读「总数量」列的算式（导出供单测直接钉住）——该商品在**全部商店**的剩余之和（Σ all，不被本人限购的余量抢窄）。
 * @param {object|null} rows 表行
 * @param {Array<object>|null} shops 镜像的所数组
 * @param {string} key 商品键
 * @returns {string} 无快照/无表显 '—'（不猜数）；有快照但无货显 '0'
 */
export function productStockSum(rows, shops, key) {
  var units = unitsOfProduct(rows, shops, key);
  if (!units) return '—';
  var sum = 0;
  for (var i = 0; i < units.length; i++) sum += units[i].all;
  return String(sum);
}

/**
 * 面板只读「总数量」列（fd.stockText）：当前镜像下的商品剩余总和。
 * @param {string} key 商品键
 * @returns {string}
 */
function goodsStockText(key) {
  return productStockSum(gameData.cq26ShopRows(), mirror ? mirror.shops : null, String(key));
}

/**
 * Σ 指定 cfg 行集在全部所的 selfBuyCnt（本人历史购买，settled 口径）。
 * **不看 status**：红包期/已结束的所也记着本人购买，故跨波累计（与「本轮已抢 x/y」同轮次）。
 * @param {Array<object>|null} shops 镜像的所数组
 * @param {string[]} cfgs 商品的 cfg 行集
 * @returns {number}
 */
function sumBought(shops, cfgs) {
  var n = 0;
  for (var j = 0; j < (shops || []).length; j++) {
    var s = shops[j];
    if (!s) continue;
    for (var m = 0; m < cfgs.length; m++) n += Number(s.selfBuyCnt[cfgs[m]]) || 0;
  }
  return n;
}

/**
 * 纯函数：该商品本期已抢购次数（导出供单测钉住）——Σ 各所各 cfg 行 selfBuyCnt。
 * @param {object|null} rows 表行
 * @param {Array<object>|null} shops 镜像的所数组
 * @param {string} key 商品键
 * @returns {number} 无表/无商品 → 0
 */
export function boughtOfProduct(rows, shops, key) {
  var p = productsOfRows(rows)[key];
  return p ? sumBought(shops, p.cfgs) : 0;
}

/**
 * 面板只读「已抢」列（fd.boughtText）：该商品本期已买次数；无快照/无表显 —（不猜数）。
 * @param {string} key 商品键
 * @returns {string}
 */
function goodsBoughtText(key) {
  var rows = gameData.cq26ShopRows();
  if (!mirror || !rows) return '—';
  return String(boughtOfProduct(rows, mirror.shops, String(key)));
}

/**
 * 面板 itemlist 页脚：本轮建议准备的钻石总额（勾选变更走整块重刷，快照/额度变更走 refreshTexts 重算）。
 * 算法（用户钉的口径）：把勾选商品的可买份数按**单价降序**展开，取最贵的 N 份求和（N=本期剩余额度）：
 *   逐 (所,cfg) 的可买份数 = min(全服剩余, 本人限购余量)，并过积分门槛（买不动的件不必为它备钻）；
 *   同一件货在多个所都有货 → 可重复计入，所以「最贵组合」会自然退化成「最贵单件 × N」直到它抢完。
 * 尚无快照时无份数可展 → copies 当不限（即最贵单价 × N），并写明是估算；表未加载时单价不可知，不猜数。
 * 单价取表行 need_gold（游戏 ResourceType.Gold=10，玩家侧显示为「钻石」）。
 * @param {Array<{id:string,cost:number}>} items 池项（含单价）
 * @param {Object<string,{on:number,max:number}>} state 面板勾选态
 * @returns {string}
 */
function goodsSummary(items, state) {
  var quota = resolveQuota();
  var rows = gameData.cq26ShopRows();
  var live = !!(rows && mirror && Array.isArray(mirror.shops));
  var n;
  var unit;
  if (quota > 0) {
    n = Math.max(0, quota - (mirror ? Number(mirror.canBuyCnt) || 0 : 0));
    if (n <= 0) return '本期额度已用尽，无需备钻';
    unit = '本期剩余额度';
  } else {
    n = QUOTA_EST; // 无面板旋钮可依（maxPerBurst 已废弃）：按实测每轮上限估，并在文案里写明不可得
    unit = '本期额度（81268 不可得，按实测上限 ' + QUOTA_EST + ' 件估）';
  }
  var groups = [];
  for (var i = 0; i < items.length; i++) {
    var e = state && state[String(items[i].id)];
    if (e && e.on === 0) continue; // 取消勾选（未登记=默认 on）
    var price = Number(items[i].cost) || 0;
    if (price <= 0) continue; // 表未加载：单价未知，不计入
    var copies = Infinity;
    if (live) {
      copies = 0;
      var units = productUnits(rows, String(items[i].id)) || [];
      for (var k = 0; k < units.length; k++) {
        var u = units[k];
        // 积分门槛：不够分就买不动这一件，不必为它备钻（口径与 buildCandidates 同）
        if ((Number(u.row.score) || 0) > (Number(mirror.cScore) || 0)) continue;
        copies += Math.min(u.all, u.self);
      }
    }
    // 逐商品本期总上限再夹一刀（含已抢）：备钻不高估（口径与 buildCandidates 的 max 闸同）
    var capN = Number(e && e.max) || 0;
    if (capN > 0) {
      copies = Math.min(
        copies,
        Math.max(0, capN - (live ? boughtOfProduct(rows, mirror.shops, String(items[i].id)) : 0)),
      );
    }
    if (copies > 0) groups.push({ price: price, copies: copies });
  }
  if (!groups.length) return '勾选件本轮建议备钻 —（无勾选件或货架表未加载）';
  groups.sort(function (a, b) {
    return b.price - a.price;
  });
  var left = n;
  var total = 0;
  var parts = [];
  for (var g = 0; g < groups.length && left > 0; g++) {
    var take = Math.min(left, groups[g].copies);
    total += take * groups[g].price;
    parts.push(groups[g].price + '×' + take);
    left -= take;
  }
  return (
    '勾选件本轮建议备钻 ≈ ' +
    total +
    '（最贵可买组合 ' +
    parts.join(' + ') +
    '，' +
    unit +
    ' ' +
    n +
    ' 件' +
    (live
      ? left > 0
        ? '，勾选中只买得到 ' + (n - left) + ' 件'
        : ''
      : '，尚无快照：按不限库存估') +
    '）'
  );
}

/** status → 面板状态文案（与游戏 updateShopUI 的三态标签同源：1 开启倒计时 / 2 抢购结束倒计时 / 3 红包发放倒计时） */
var STATUS_TEXT = { 1: '待开市', 2: '抢购中', 3: '红包期', 4: '已结束' };

/**
 * 状态倒计时（游戏原式口径：statusEndSec 只在 status<4 且未到点时有效）。
 * 注：status=1 时那个字段是**最迟开市截止**（实证比真实开市 push 早 ~3h），不是开市时刻，故文案不承诺“还有多久开”。
 * @param {object} s 所快照
 * @param {number} nowSec 服务器秒
 * @returns {string} hh:mm:ss / mm:ss，无效时 '—'
 */
function countdownText(s, nowSec) {
  var end = Number(s.statusEndSec) || 0;
  if (Number(s.status) >= 4 || end <= 0 || end <= nowSec) return '—';
  var left = Math.floor(end - nowSec);
  var h = Math.floor(left / 3600);
  var m = Math.floor((left % 3600) / 60);
  var ss = String(left % 60).padStart(2, '0');
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
}

/**
 * 密所状态行集（面板 infogrid 的 fd.rows）：**一密所一行**，列=归属区 / 等级 / 状态 / 状态倒计时。
 * 归属区 = 报文行的 sid（实证 11/7 录制的 S3281/S3765 就是那两个 status=1 的所）；
 * 等级 = cnc_city_level.level（游戏标题「{0}级印石秘所」同式，表缺时退到 cityLevelId）；
 * 行序与下单内层序同一口径（见 sortByGameOrder），本服所在归属区后标 ★。
 * @returns {Array<Array<string>>}
 */
function shopRows() {
  if (!mirror || !Array.isArray(mirror.shops)) return [];
  var now = gameData.serverTime() | 0;
  return sortByGameOrder(mirror.shops).map(function (s) {
    return [
      'S' + s.sid + (s.ownServer ? ' ★' : ''),
      (s.level || s.cityLevelId || 0) + '级',
      STATUS_TEXT[s.status] || 'st' + s.status,
      countdownText(s, now),
    ];
  });
}

/**
 * 纯函数：面板「本轮已抢 x/y」文案。分子是**已用**（口径同 wl-mine 的「已用 x/y」、wl-chest 的「已领 x/y」），
 *   因为读的就是服务器权威的 `canBuyCnt`（本期已用次数）：它天然跟随轮次，不随页面刷新/跨天归零。
 * @param {number|null} used 本期已用次数（`canBuyCnt`；null=2442 快照尚未取得）
 * @param {number} quota 本期总次数（`resolveQuota()`；<=0 = 配置 81268 不可得）
 * @returns {string}
 */
export function quotaText(used, quota) {
  var q = Number(quota) || 0;
  if (q <= 0) return '额度配置不可得';
  if (used == null) return '本轮已抢 —/' + q; // 没快照就不报进度（下一行已写明「尚无快照」）
  var u = Math.min(Math.max(0, Number(used) || 0), q); // 夹进 [0, 总次数]：不冒出「已抢 6/5」
  return '本轮已抢 ' + u + '/' + q;
}

/**
 * 面板概览摘要（type:'text' 的 get）：只留跨所聚合量（本轮进度/最近成交/拉黑）；
 *   逐所的状态已移到 infogrid（shopRows），那里才能做到一行一密所且列对齐。
 * @returns {string}
 */
function shopInfoText() {
  if (!gameData.cq26IsOpen()) return 'CQ26 未开启';
  var lines = [];
  lines.push(quotaText(mirror ? Number(mirror.canBuyCnt) || 0 : null, resolveQuota()));
  if (!mirror) lines.push('尚无快照（开启后自动取得）');
  if (lastDeal) {
    var d = new Date(lastDeal.atSec * 1000);
    lines.push(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + lastDeal.text);
  }
  var blacked = Object.keys(rejectCount).filter(function (k) {
    return rejectCount[k] >= MAX_REJECT;
  }).length;
  if (blacked) lines.push('当日拉黑 (所,件) ' + blacked + ' 组');
  return lines.join('\n');
}

/**
 * 面板 defaults。
 * 只留真正需要用户决定的三项（勾选/拖拽序/逐商品本期上限 + 待开市快档）；其余已内化为系统值，见文件头「系统固定参数」。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
    goods: {},
    goodsOrder: [],
    nearPollSec: 5,
  };
}

/**
 * 面板 fields。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      // 逐所状态走 infogrid（单列宽栅格）：一行一密所、上下严格对齐，
      //   不再用多行文本拼「cs·st·货架·余量」（CJK/数字混排下空格对齐会错位，且字段名不解释不可读）
      key: '_shopGrid',
      type: 'infogrid',
      label: '密所状态',
      columns: [
        { label: '归属区', title: '密所所在区；★=本服' },
        { label: '等级', title: '秘所等级' },
        { label: '状态', title: '待开市 / 抢购中（唯一可买态）/ 红包期 / 已结束' },
        {
          label: '状态倒计时',
          align: 'right',
          title: '当前状态剩余时间',
        },
      ],
      rows: shopRows,
      hint: '倒计时为展示截止，不是开市时刻；开市由城主手动触发，插件实时感知自动抢。',
    },
    {
      key: '_shopInfo',
      type: 'text',
      label: '本轮概览',
      multiline: true,
      inline: true,
      get: shopInfoText,
    },
    {
      key: 'goods',
      type: 'itemlist',
      label: '抢购物品优先级',
      sortable: true,
      orderKey: 'goodsOrder',
      items: goodsPool,
      nameGrow: true,
      // costCol：红色钻石单价只读列；maxCol：数字输入列与价列共存（逐商品「本期总上限」，
      //   含已抢、0=无上限）；boughtText：输入列前的「已抢」只读列
      costCol: true,
      maxCol: true,
      maxTitle: '本期总上限（含已抢），∞=不限；同商品跨普通/高级城共享',
      maxPlaceholder: '∞', // 窄列（两位数宽）塞不下「无上限」三字，∞ 表不限
      // 表头行：列含义自解释（已抢/上限/剩余的完整口径在各列 title 与下方 hint）
      head: { name: '物品', cost: '单价', bought: '已抢', max: '上限', stock: '剩余' },
      boughtText: goodsBoughtText,
      boughtTitle: '该商品本期已买次数，成交后自动刷新',
      // stockText：末列「商品总数量」= 该商品在全部商店的剩余之和（只读数，随 2442/2443/2444 回写就地刷新）
      stockText: goodsStockText,
      stockTitle: '该商品在全部密所的剩余可买之和（红包期/已结束不计）',
      summary: goodsSummary,
      topHint: '拖拽排序=优先级；取消勾选=不抢；∞=不限',
      hint: '一行一个商品（品种+数量，如 x15 与 x3 是两件）；数字=本期总上限（含已抢），∞=不限。',
    },
    {
      key: 'nearPollSec',
      type: 'number',
      label: '待开市轮询(秒)',
      min: 1,
      max: 60,
      step: 1,
      hint: '仅用于待开市自检；开市后实时抢购。',
    },
    {
      // 说明行用 type:'note'（fields.js 的 renderCheckbox 不消费 topHint/hint，挂在上面会静默不渲染）
      key: '_shopNote',
      type: 'note',
      text: '下单节奏、本期额度、红包领取等均由系统自动控制；你只需配置优先级与逐商品上限。',
    },
  ];
}

/**
 * toModuleCfg：面板 cfg → 运行时归一化 MCFG（configure 直接整体接收本函数产物，绝不二次归一）。
 * goods 逐**商品**重建（剔历史残留键）、区间钳值，保证 buildCandidates 读到的形状恒定；
 *   键集直接取自 goodsPool，与面板勾选写回的键必然同一套（否则用户的取消会静默失效）。
 * 注：旧存档里的 buyOn/maxPerBurst/burstGapMs/idlePollSec/goldReserve/redPack 已废弃或内化为系统值，
 *   到此直接丢弃（不留残留键，否则导出配置会带上面板上已看不见的项）。
 * 存档迁移（商品化改造的兼容点）：旧存档 goods 以纯 cfg 档号（'7' / '105'）为键，这里按当前表上的商品集
 *   把它们并到商品键下——**同一商品的任一 cfg 档曾被取消勾选即整体视为取消**（AND 语义：宁可少买，
 *   不越权买用户明确关掉的货）；表不可读时 goodsPool 退成占位键，同样从同名占位/旧 cfg 键承接。
 * 注：max 只承接**商品键**登记的值（新 UI 的「本期总上限」）；旧存档 per-cfg 键下的 `max`
 *   （已废弃的旧「购买上限」输入，语义不同）不复活，随旧键一并丢弃。
 * @param {object} c 面板合并后配置
 * @returns {object}
 */
function normalizeCfg(c) {
  c = c || {};
  var raw = c.goods || {};
  var pool = goodsPool();
  var goods = {};
  for (var i = 0; i < pool.length; i++) {
    var pk = String(pool[i].id);
    var e = raw[pk];
    goods[pk] = {
      on: e ? e.on !== 0 : !anyOff(raw, pool[i].cfgs),
      max: Math.max(0, Math.floor(Number(e && e.max) || 0)),
    };
  }
  return {
    goods: goods,
    goodsOrder: migrateOrder(Array.isArray(c.goodsOrder) ? c.goodsOrder : [], goods, pool),
    nearPollSec: clamp(Number(c.nearPollSec) || 5, 1, 60),
  };
}

/** 该键在旧存档里是不是被显式取消勾选（未登记=默认 on） */
function offOf(raw, k) {
  var e = raw[k];
  return !!(e && e.on === 0);
}

/**
 * 商品的全部 cfg 档里是否有曾被取消的（任一即整体取消，AND 语义）；一并承接表不可读时期的占位键记录，
 * 否则那段时间的取消会在表恢复后静默失效（用户明明关掉的货又变成抢）。
 * @param {object} raw 旧存档 goods
 * @param {string[]} cfgs 该商品的 cfg 行集
 * @returns {boolean}
 */
function anyOff(raw, cfgs) {
  for (var i = 0; i < cfgs.length; i++) {
    if (offOf(raw, cfgs[i]) || offOf(raw, placeholderKey(cfgs[i]))) return true;
  }
  return false;
}

/**
 * 旧拖拽序 → 商品键序：商品键原样保留，纯 cfg 档号（含占位键 cfgN）映射到它所属商品；
 * 映射不到当前商品集（换季/表变）或重复的丢弃——buildCandidates 的 priorityOrder 会把漏掉的补在末尾，不会丢货。
 * @param {Array<string|number>} src 旧 goodsOrder
 * @param {Object<string,object>} goods 已重建的商品勾集（判定键是否存在）
 * @param {Array<{id:string|number,cfgs:string[]}>} pool goodsPool 产物
 * @returns {string[]}
 */
function migrateOrder(src, goods, pool) {
  var byCfg = {};
  for (var i = 0; i < pool.length; i++) {
    for (var m = 0; m < pool[i].cfgs.length; m++) {
      var c = pool[i].cfgs[m];
      if (!(c in byCfg)) byCfg[c] = String(pool[i].id);
    }
  }
  var out = [];
  var seen = {};
  for (var j = 0; j < src.length; j++) {
    var k = String(src[j]);
    var key = goods[k] ? k : byCfg[k.indexOf(CFG_PREFIX) === 0 ? k.slice(CFG_PREFIX.length) : k];
    if (!key || seen[key]) continue;
    seen[key] = 1;
    out.push(key);
  }
  return out;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 「额度配置不可得」与「货架表不可读」各只 warn 一次（恢复后由调用点复位） */
function noteQuota() {
  if (quotaWarned) return;
  quotaWarned = true;
  log.warn('quota config 81268 unavailable, fail-closed (no packet sent this pass).');
}

function noteRows() {
  if (rowsWarned) return;
  rowsWarned = true;
  log.warn('shop goods table projection unavailable, cannot judge gates, skip burst.');
}

// ── 注册 ──────────────────────────────────────────────────────────────
reactor.register({
  id: 'cq26Shop',
  label: '霜之密所抢购',
  storageKey: 'pocketcc.feat.cq26_shop',
  // 四个硬依赖：ServerTime/UserData（dataCenter）、货架与城档表（tableManager）、额度配置 81268（tableUtils）、
  //   Int64 装箱（long64Bit）——后者缺失时 bits.int64 会退成 `Number(v)`，19 位密所 id 直接丢精度
  symbols: ['dataCenter', 'tableManager', 'tableUtils', 'long64Bit'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 抢购是即时成交、不派兵不占行军名额，战斗态无需下线
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
