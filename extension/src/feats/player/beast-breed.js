/**
 * 异能兽培育-日常（reactor 说明书形态，控制模式归 A：core/cycle 电平调和循环）
 *
 * 玩法：把「我的异能兽」派到别的玩家基地里培育，等时无后领取产出；同时自家基地可挂一只主宠，
 * 接受别人申请进来配对、并让盟友帮忙加速。协议族 1569~1599 与三条推送的逐字段核对见
 * extension/docs/异能兽培育.md（实录：dashcam 20261002T024843 / 20261007T001108 / 20261007T034829 三份 ndjson +
 * 游戏反编译 RealEnigmaBeastController / EnigmaBeastBreedSelectPop / VisitPop(Cell) / MainPop / BreedInfo）。
 *
 * 为什么归 A：1570（我的兽池）/ 1583（我家在途与寄养）/ 1585（可拜访全量列表）/ 1582（待我处理的申请）
 * 都是**可重放的全量读通道**——错过一轮，下一轮重读拿到的仍是真相；10130/10132/10133 三条推送只当
 * 「有变化，快补扫一轮」的唤醒信号，不参与业务判定。故本 feat 用 createCycle：单飞闸门 + 推触合并 +
 * 绝不停摆，一轮内把五段流水顺序折叠跑完，段内逐条 sleep 限流（不另起 drain，保持与 auto-farm /
 * truck-intercept 同构的单轮形态）。
 *
 * 一轮流水（cycleRun 内部顺序，段间无回滚依赖）：
 *   ① 全量读：1570 兽池 → 1583 在途/寄养 → 1585 拜访列表 →（开自动同意才读）1582 待处理申请；
 *   ② 领奖：1583 中 breedingStatus=REWARD 的各家 + breedData 里我家到点的 REWARD → 逐条 1584；
 *      breedData.helpBornRewardCnt>0 再补一条 1599；
 *   ③ 主宠：池内无 breeding=2 且 breedData/1583 也不见 info.main → 按主宠物种/品质挑最优发 1579；
 *   ④ 同意/加油/分享：1582 逐条 1581（前置=我家有主宠，同意口径按 cfg.autoAgree 分档）；1585 中培育中且我没帮过的家发 1587；
 *      我家正在培育且还能被加 → 发一条 670 聊天链接（联盟频道，t=35）请盟友来加油；
 *   ⑤ 申请/撤单：先按在途账本撤超时单（1580 apply:false），再在名额内挑目标×挑我兽发 1580 apply:true。
 *
 * 目标选择两种互斥模式（cfg.mode，面板靠 core/ui.js 的 fd.showIf 只展开当前模式那侧的参数）：
 *   - specify 指定玩家：只在 cfg.uids 名单内挑拜访目标，**同意申请也只认这份名单**（cfg.autoAgree='list'）——
 *             名单是用户显式意志，故不再套联盟/离线阈值（但仍守 WAIT、不在途）；
 *   - random 随机玩家：1585 全量里按「WAIT → 不在我已发出且等同意的集合 →（allyOnly）同联盟 tag
 *             → 在线或离线时长达标」逐级过滤，**过滤后为空则逐级回退**（先放宽离线阈值、再放宽联盟闸门），
 *             仍空才本轮跳过申请并记 warn——窄口径导致整轮空转且无声是最难查的故障；同意口径走 off/ally/all 三档。
 *   两个模式的候选集都是**等概率随机取一个**（用户口径：随机一个匹配的玩家/宠物）。
 *
 * 出访兽匹配口径逐字对齐游戏 EnigmaBeastBreedSelectPop.updateUI：
 *   cfg.breeding（该物种可培育）&& data.breeding===0（空闲）&& 不在联盟机械领域 && 物种/品质命中；
 *   游戏 UI 只硬挡 breeding===2、对「派一只已寄养在别人家（=1）的兽」靠服务器拒；脚本额外挡掉 1，不赌服务器幂等。
 *
 * 配额闸门（gameConf.dataConfig）：310007 每日免费申请次数 / 310008 同时等待同意上限 /
 *   310009 产出可领缓冲(分) / 310011 单只被帮助人次上限 / 310012 每日帮助次数上限。
 *   每日次数唯一来源是 10132 缓存的 breedData：缺失时**不硬拦**（fail-open），靠服务器拒绝回落；
 *   拒绝文案命中 enigma_peiyu_times_8（次数耗尽）即置当日停止申请，只继续跑领奖/加速。
 *
 * 合规红线：全程只读游戏数据（经 game-api ACL）+ 直发 15xx，不调用游戏的 Update 系列接口改写本地态、不 OpenUI。
 *   唯一的非 15xx 出站是 670 聊天分享（求加油，走 core/chat.js 底座，与聊天浮层同一发送链）。
 *   唯一本地写是 storage.data 的当日账本（在途首发时刻 + 「次数耗尽」标记 + 上次分享时刻）。
 *   刷屏防护：发包条间 sleep 限流 + 在途集合本轮不撞同一目标 + 「次数耗尽」当日不再申请；
 *   不做按 uid 的当日拉黑（错 ID/瞬时拒不该把指定玩家整天封掉；下一拍重读 1585/1582 自愈）。
 *
 * Int64 陷阱：兽 id 在应答里是游戏 Int64 实例（{_low,_high}），读必须 .toString() 取十进制串，
 *   发必须经 bits.int64(strId) 装箱回 Int64——直传数字串会丢精度、直传 JS number 会被服务器拒。
 *   玩家 uid 反之：应答/请求两侧都是十进制字符串，原样透传。
 *
 * 生命周期由 reactor 托管：install/configure/run 三钩子，places 限 base/world（Home/NWorldMap），战斗模式暂停；
 *   pause 后 alive()=false 让 cycle 自然停摆，resume 时 run 复位状态并重新点火。
 */
import { createLog } from '../../core/log.js';
import { storage } from '../../core/storage.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';
import { l10n, gameData, gameConf, bits } from '../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=BEAST-BREED） */
const log = createLog('BEAST-BREED');

// ─────────────────────────── 协议常量（全部 net.sendPBV2） ───────────────────────────
/** @type {number} ENIGMA_BEAST_GET_INFO：我的兽池全量，req {} → resp {infos:[{id,cfgId,level,star,potential,breeding,show,lock,…}],expPool,fields} */
const CMD_GET_INFO = 1570;
// 1578 ENIGMA_BEAST_BREEDING_RECORD_LIST：培育日志，req {} → resp {record:[{type,msg,time,gotoUid,id,result}]}（协议族备查，本 feat 未调用）
/** @type {number} ENIGMA_BEAST_BREEDING_MAIN_SET：设我家主宠，req {id:Int64}（Int64(0) 撤除） */
const CMD_MAIN_SET = 1579;
/** @type {number} ENIGMA_BEAST_BREEDING_OTHER_APPLY：申请把我的兽放到 uid 家 / apply:false 撤回，req {uid,id:Int64,apply} */
const CMD_OTHER_APPLY = 1580;
/** @type {number} ENIGMA_BEAST_BREEDING_OTHER_APPLY_OP：处理别人对我家的申请，req {uid,id:Int64,agree} */
const CMD_OTHER_APPLY_OP = 1581;
/** @type {number} ENIGMA_BEAST_BREEDING_OTHER_APPLY_LIST：待我处理的申请，req {} → resp {apply:[{id,cfgId,level,star,uid,playerInfo,allianceTag}]} */
const CMD_OTHER_APPLY_LIST = 1582;
/** @type {number} ENIGMA_BEAST_BREEDING_MAIN_LIST：与我相关的培育家列表，req {} → resp {info:[{apply?,info:{ownerUid,breedingStatus,breedingEndTimeSec,main,other,helpUid}}]} */
const CMD_MAIN_LIST = 1583;
/** @type {number} ENIGMA_BEAST_BREEDING_BORN：领取该家培育产出，req {uid} */
const CMD_BREEDING_BORN = 1584;
/** @type {number} ENIGMA_BEAST_BREEDING_VISIT_LIST：可拜访全量列表，req {} → resp {visit:[{ownerUid,breedingStatus,breedingEndTimeSec,main,other,helpUid,lastOfflineTime,ownerAllianceTag,…}]} */
const CMD_VISIT_LIST = 1585;
// 1586 ENIGMA_BEAST_BREEDING_CANCEL：培育中提前撤，req {uid}（协议族备查，本 feat 未调用）
/** @type {number} ENIGMA_BEAST_BREEDING_HELP：帮盟友加速，req {uid} */
const CMD_BREEDING_HELP = 1587;
/** @type {number} ENIGMA_BEAST_GET_HELP_BORN_REWARD：领取「帮助培育」的累计奖励，req {} */
const CMD_HELP_BORN_REWARD = 1599;

/** @type {number} ResponseId.ENIGMA_BEAST_CHANGE：兽池单条变更推送（仅作唤醒） */
const PUSH_BEAST_CHANGE = 10130;
/** @type {number} ResponseId.ENIGMA_BEAST_BREEDING_CHANGE：整包 breedData 推送（唤醒 + 每日配额唯一来源） */
const PUSH_BREEDING_CHANGE = 10132;
/** @type {number} ResponseId.ENIGMA_BEAST_OTHER_BREEDING_CHANGE：别人家培育变更推送（仅作唤醒） */
const PUSH_OTHER_BREEDING = 10133;

/** @type {number} 非服务器返回的哨兵 code：闸门未放开 / 在途 / 发送异常，与真实 s 码区分，不当拒绝处理 */
const CODE_NOT_SENT = -1;

/** BeastBreedType（游戏 EnigmaBeastController 枚举）：培育状态机三值 */
const BREED_WAIT = 0;
const BREED_BREEDING = 1;
const BREED_REWARD = 2;

/** 我兽 data.breeding 三值（实录核对：样本 863 只 {0:862,2:1}，那只 =2 正是 1581 应答里的 info.main.id） */
const OWN_IDLE = 0;
// breeding=1：已派在别人家（等同意或培育中，池内不再区分）——本 feat 未消费该值
const OWN_MAIN = 2; // 当我家主宠

/**
 * 闸门配置 id（TableUtils.getDataConfigData，单位见各项注释）。
 * @type {object}
 */
const CFG = {
  /** @type {number} 单次培育时长（分） */
  breedMin: 310006,
  /** @type {number} 每日免费申请次数 */
  dailyApply: 310007,
  /** @type {number} 同时等待同意的申请上限（在途名额） */
  inflightMax: 310008,
  /** @type {number} 产出可领缓冲（分）：到点后还要等这么久才允许领 */
  rewardBufferMin: 310009,
  /** @type {number} 单只兽可被帮助的人次上限 */
  helpPerBeast: 310011,
  /** @type {number} 每日帮助次数上限 */
  dailyHelp: 310012,
  /** @type {number} 功能开放的主城等级 */
  openLevel: 310022,
  /** @type {number} 收藏上限（本 feat 只用 favorite 字段做展示，不主动收藏） */
  favMax: 310033,
};

/** @type {string} 拒绝文案键：每日申请次数耗尽（命中即当日不再申请） */
const REJECT_TIMES_EXHAUSTED = 'enigma_peiyu_times_8';

// ─────────────────────────── 择时常量 ───────────────────────────
/** @type {number} 活跃档：有在途申请/有兽在培育时的复查间隔 */
const ACTIVE_INTERVAL_MS = 5 * 60 * 1000;
/** @type {number} 空闲档：全空闲/配额用尽/无候选时的兜底巡检间隔（也是 cycle 的 fallback） */
const IDLE_INTERVAL_MS = 30 * 60 * 1000;
/** @type {number} 310008 取不到时的在途名额兜底（服务器仍会硬拦，超发是有界的） */
const DEFAULT_INFLIGHT_MAX = 3;
/** @type {number} 在途申请超时撤单阈值（时）：内部兜底阀门，不进面板（用户无从判断该填几小时，6h 覆盖「对方当天上线一次就够」） */
const APPLY_TTL_HOURS = 6;
/** @type {number} 连发条间限流（毫秒）：内部节奏，不进面板 —— 调小只会撞服务器频控，调大只是拖慢一轮，用户无从判断 */
const APPLY_INTERVAL_MS = 1200;
/** @type {number} 单轮加油上限：一轮 1585 最多给几家加油，避免整轮耗时都花在辅助动作上 */
const HELP_PER_TICK = 3;
/** @type {number} 求加油分享的链接子类型 = 游戏 ChatShareLinkType.ENIGMA_BEAST_BREED（实录 20261007T034829 的 llm.t） */
const SHARE_LINK_TYPE = 35;
/** @type {number} 分享求加油的缺省间隔（分）：面板可调，取值下限同值（再小就是刷联盟频道） */
const SHARE_INTERVAL_MIN = 5;
/** @type {number} 分享求加油的缺省间隔（分）：一个培育时长（310006）量级内提醒几次足够 */
const SHARE_INTERVAL_DEFAULT = 30;

/** @type {string} 当日账本持久数据键（storage.data blob 内逻辑名，UID 隔离） */
const LEDGER_NAME = 'beastBreed.ledger';

/**
 * 运行时模块配置（toModuleCfg 产出 → configure 写入；面板缺省值见文件底部 descriptor）。
 * mode 与同意口径互斥绑定：specify 只出 agreeList（→ autoAgree:'list'/'off'），random 只出 autoAgree（'off'/'ally'/'all'），
 * 故下游一律只读 autoAgree 一个字段，不必再判 mode。
 * @type {object}
 */
var cfg = {
  mode: 'random',
  uids: [],
  allyOnly: true,
  maxOfflineHours: 24,
  applyTypes: [],
  applyQualities: [],
  mainTypes: [],
  mainQualities: [],
  enableMain: true,
  autoAgree: 'ally',
  autoHelp: true,
  claim: true,
  shareHelp: true,
  shareIntervalMin: SHARE_INTERVAL_DEFAULT,
  applyIntervalMs: APPLY_INTERVAL_MS,
  helpPerTick: HELP_PER_TICK,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net = null;
/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {boolean} install 是否已成功（依赖只在首次装配） */
var installed = false;
/** @type {object|null} EnigmaBeastController 单例；缺失只影响「机械领域占用」过滤（降级为不过滤） */
var ctl = null;

/** @type {object|null} 10132 缓存的 breedData：{info,breedingTodayCnt,breedingBuyMaxCnt,breedingTodayHelpCnt,helpBornRewardCnt} */
var breedData = null;

/** @type {{day:string, exhausted:string, shareAt:number}} 「次数耗尽」标记与上次分享时刻（不做按 uid 拉黑） */
var ledger = { day: '', exhausted: '', shareAt: 0 };

/** @type {boolean} 账本是否已成功读回（未读回前绝不写盘，避免拿内存初值覆掉盘上真值） */
var ledgerLoaded = false;
/** @type {boolean} 账本读盘单飞闸门 */
var ledgerLoading = false;
/** @type {Object<string,number>} uid → 该在途申请首次被见到的时刻（毫秒）；1583 的 apply 条目不带发起时间戳，只能本地记账 */
var inflightSeen = {};

/**
 * 功能是否仍在运行（在飞流程与限流 sleep 的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ─────────────────────────── 小工具 ───────────────────────────
/**
 * 休眠
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, Math.max(0, ms | 0));
  });
}

/**
 * 今日日期串 YYYY-MM-DD（以服务器时钟为准，缺 DataCenter 时回落本地时间）
 * @returns {string}
 */
function todayStr() {
  var d = new Date((gameData.serverTime() || Math.floor(Date.now() / 1000)) * 1000);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 闸门配置读数（gameConf.dataConfig 可能返回字符串/对象，统一取整数；不可用回 0）
 * @param {number} id 配置 id
 * @returns {number} 整数值；取不到 0
 */
function cfgNum(id) {
  var raw;
  try {
    raw = gameConf.dataConfig(id);
  } catch (e) {
    raw = '';
  }
  var n = parseInt(String(raw == null ? '' : raw), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Int64 → 十进制字符串。应答里的兽 id 是游戏 Int64 实例（{_low,_high}），String() 走其 toString；
 * 已是字符串/数字时原样转串。**只认纯数字串**：Int64 若换了实现（无 toString、或退化成对象字面串），
 * 宁可回 '' 让调用方跳过 —— 把 '[object Object]' 塞给 bits.int64 去发一个服务器不认识的 id 更难查。
 * @param {*} v Int64 实例 / 字符串 / 数字
 * @returns {string} 十进制串或 ''
 */
function idStr(v) {
  if (v == null) return '';
  var s;
  if (typeof v === 'object') {
    if (typeof v.toString !== 'function') return '';
    try {
      s = String(v.toString());
    } catch (e) {
      return '';
    }
  } else {
    s = String(v);
  }
  return /^\d+$/.test(s) ? s : '';
}

/**
 * 随机取一个下标（等概率）
 * @param {number} n 池大小
 * @returns {number} [0,n) 的整数
 */
function randIdx(n) {
  return Math.floor(Math.random() * n) % n;
}

/**
 * 把拒绝应答归一成一串可 grep 的文本（ret.data 常是对象，l10n.net 内部 String() 会得 [object Object]）
 * @param {object} ret Ret 对象
 * @returns {string} 原始串或 JSON
 */
function rejectText(ret) {
  // PBV2 拒绝原因的多语言 key 落在 header.d（已由 net 归一到 ret.reason）；优先用它，才能识别「次数耗尽」等语义
  if (ret && ret.reason != null && ret.reason !== '') return String(ret.reason);
  var d = ret && ret.data;
  if (d == null) return '';
  if (typeof d === 'string') return d;
  try {
    return JSON.stringify(d);
  } catch (e) {
    return String(d);
  }
}

/**
 * 数字夹区间（面板可调项的归一化）
 * @param {*} v 原值
 * @param {number} lo 下限
 * @param {number} hi 上限
 * @param {number} dflt 非法时的缺省
 * @returns {number} 整数
 */
function clampNum(v, lo, hi, dflt) {
  var n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 数字数组归一：去 NaN/非正、去重
 * @param {*} v 原值（数组或标量）
 * @returns {number[]} 归一后的数组
 */
function normNums(v) {
  var arr = Array.isArray(v) ? v : v == null ? [] : [v];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var n = Number(arr[i]) | 0;
    if (n > 0 && out.indexOf(n) === -1) out.push(n);
  }
  return out;
}

/**
 * UID 数组归一：面板 uidlist 存的是 [{uid,name}]，这里压成去空去重的字符串名单
 * @param {*} v 原值（对象数组 / 字符串数组 / 标量）
 * @returns {string[]} 名单
 */
function normUids(v) {
  var arr = Array.isArray(v) ? v : v == null ? [] : [v];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i];
    var s = String((it && typeof it === 'object' ? it.uid : it) || '').trim();
    if (s && out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

// ─────────────────────────── 当日账本（在途首发时刻 / 次数耗尽标记） ───────────────────────────
/**
 * 跳日收敛：「次数耗尽」标记只在当日有效；首发时刻不按日清（它随条目消失而删）。
 */
function rollDay() {
  var today = todayStr();
  if (ledger.day === today) return;
  ledger.day = today;
  ledger.exhausted = '';
}

/**
 * 读回当日账本（单飞；读失败不置 loaded、保留下次重试机会——同 auto-farm ledger 语义）。
 * 首发时刻跨 reload 保留，避免「刷新页面就把 TTL 重新起算」导致超时单永远撤不掉。
 * @returns {Promise<void>}
 */
function loadLedger() {
  if (ledgerLoaded || ledgerLoading) return Promise.resolve();
  ledgerLoading = true;
  return Promise.resolve(storage.data.get(LEDGER_NAME))
    .then(function (saved) {
      ledgerLoading = false;
      ledgerLoaded = true; // 读回成功才允许写盘（缺这行会把 persistLedger 永久锁死，账本落不了盘）
      if (saved && typeof saved === 'object') {
        if (typeof saved.day === 'string') ledger.day = saved.day;
        if (typeof saved.exhausted === 'string') ledger.exhausted = saved.exhausted;
        if (saved.seen && typeof saved.seen === 'object')
          inflightSeen = Object.assign({}, saved.seen);
        // 上次分享时刻不按日清（它只是防刷屏的节流锚，跳日照常继续隔够久再发）
        if (Number.isFinite(saved.shareAt)) ledger.shareAt = saved.shareAt;
      }
      rollDay();
    })
    .catch(function (err) {
      ledgerLoading = false;
      log.warn('load ledger failed, retry next cycle. %s', err && err.message);
    });
}

/** 账本落盘（fire-and-forget，失败仅 warn，内存账本仍是本轮真相） */
function persistLedger() {
  if (!ledgerLoaded) return;
  Promise.resolve(
    storage.data.set(LEDGER_NAME, {
      day: ledger.day,
      exhausted: ledger.exhausted,
      seen: inflightSeen,
      shareAt: ledger.shareAt,
    }),
  ).catch(function (err) {
    log.warn('persist ledger failed.', err);
  });
}

// 旧版本曾在此定义 banToday / isBanned（按 uid 当日拉黑），已整体移除：
// 任何瞬时/异常拒绝都不应把指定玩家整天封掉；下一拍重读 1585/1582 自然收敛。
// storage.data 上历史遗留的 uids 字段被 loadLedger 忽略、不再落盘。

// ─────────────────────────── 发包封装 ───────────────────────────
/**
 * 直发一条 PBV2 并归一化，永不 reject：同 cmd 在途回落 CODE_NOT_SENT 哨兵（下轮重试，不算拒绝）。
 * @param {number} cmd 命令号
 * @param {object} body 载荷
 * @returns {Promise<object>} Ret {code,data,ok}
 */
async function send(cmd, body) {
  if (!net || net.isSending(cmd)) return net.Ret.from(CODE_NOT_SENT, null);
  try {
    return await net.sendPBV2(cmd, body || {});
  } catch (err) {
    log.warn('send %d threw: %s', cmd, err && err.message);
    return net.Ret.from(CODE_NOT_SENT, null);
  }
}

// ─────────────────────────── 出访兽匹配 ───────────────────────────
/**
 * 该兽是否占用着联盟机械领域（游戏 getBeastInFiled，key=strId）；控制器/符号缺失时回 false（降级不过滤，
 * 真占用由服务器拒绝兜底）。
 * @param {string} sid 兽 strId
 * @returns {boolean}
 */
function inField(sid) {
  if (!ctl || typeof ctl.getBeastInFiled !== 'function' || !sid) return false;
  try {
    return !!ctl.getBeastInFiled(sid);
  } catch (e) {
    return false;
  }
}

/**
 * 池内某物种配置行（enigma_beast 按 cfgId 出 {type,quality,breeding,…}）
 * @param {number} cfgId 配置 id
 * @returns {object|null}
 */
function beastCfg(cfgId) {
  return cfgId ? l10n.tableRow('enigma_beast', cfgId) : null;
}

/**
 * 从兽池挑可出访/可当主宠的候选（口径逐字对齐游戏 SelectPop.updateUI，另加品质维度）：
 *   cfg.breeding 为真（该物种可培育）&& breeding===0（空闲；游戏仅硬挡 ===2，脚本额外挡 1，因 1 必被服务器拒）
 *   && 不在机械领域 && 物种/品质命中（空数组 = 不限）。
 * @param {object[]} beasts 1570 的 infos
 * @param {number[]} types 物种白名单（空 = 不限）
 * @param {number[]} qualities 品质白名单（空 = 不限）
 * @param {Set<string>} used 本轮已消耗掉的 strId（同轮不重复申请）
 * @returns {Array<{strId:string,cfgId:number,quality:number,star:number,level:number,potential:number}>} 候选
 */
function pickBreedable(beasts, types, qualities, used) {
  var typeSet = types && types.length ? new Set(types.map(Number)) : null;
  var qSet = qualities && qualities.length ? new Set(qualities.map(Number)) : null;
  var out = [];
  for (var i = 0; i < beasts.length; i++) {
    var b = beasts[i];
    if (!b || (b.breeding | 0) !== OWN_IDLE) continue;
    var sid = idStr(b.id);
    if (!sid || (used && used.has(sid))) continue;
    var c = beastCfg(b.cfgId);
    if (!c || !c.breeding) continue;
    if (inField(sid)) continue;
    if (typeSet && !typeSet.has(Number(c.type) | 0)) continue;
    if (qSet && !qSet.has(Number(c.quality) | 0)) continue;
    out.push({
      strId: sid,
      cfgId: b.cfgId | 0,
      type: Number(c.type) | 0,
      quality: Number(c.quality) | 0,
      star: b.star | 0,
      level: b.level | 0,
      potential: b.potential | 0,
    });
  }
  return out;
}

/**
 * 主宠优序比较：品质降 → 星级降 → 等级降 → 潜力降（与游戏 beastBaseSortFunc(o=1) 同向，
 * 末位 id 比较无意义故省去）。
 * @param {object} a 候选
 * @param {object} b 候选
 * @returns {number} sort 比较值
 */
function mainSort(a, b) {
  return b.quality - a.quality || b.star - a.star || b.level - a.level || b.potential - a.potential;
}

// ─────────────────────────── 目标挑选 ───────────────────────────
/**
 * 拜访列表按一组闸门过滤成候选集。
 * @param {object[]} visit 1585 的 visit
 * @param {object} g 闸门 {ally:boolean 联盟限制, offlineSec:number|Infinity 允许的离线时长, mine:string[]} 白名单（非空则只取名单内）
 * @param {Set<string>} inflightUids 我已发出且等同意的家
 * @param {number} nowSec 服务器时刻（秒）
 * @param {string} myUid 我的 StrUid
 * @param {string} myTag 我的联盟 tag
 * @returns {Array<{ownerUid:string,lastOfflineTime:number}>} 候选
 */
function filterVisit(visit, g, inflightUids, nowSec, myUid, myTag) {
  var out = [];
  for (var i = 0; i < visit.length; i++) {
    var v = visit[i];
    if (!v) continue;
    var uid = String(v.ownerUid || '');
    if (!uid || uid === myUid) continue;
    if ((v.breedingStatus | 0) !== BREED_WAIT) continue; // ① 只挑空着的家
    if (inflightUids.has(uid)) continue; // ② 我已申请且等同意
    if (g.mine && g.mine.length && g.mine.indexOf(uid) === -1) continue;
    if (g.ally && (!myTag || String(v.ownerAllianceTag || '') !== myTag)) continue; // ③ 同联盟
    if (g.offlineSec !== Infinity) {
      // ④ 在线或近期离线
      var off = v.lastOfflineTime | 0;
      if (off !== 0 && nowSec - off > g.offlineSec) continue;
    }
    out.push({ ownerUid: uid, lastOfflineTime: v.lastOfflineTime | 0 });
  }
  return out;
}

/**
 * 随机模式取一个目标：窄口径空则逐级回退（先放宽离线阈值 → 再放宽联盟闸门），仍空回 null 由调用方记 warn。
 * 每个口径内的候选都是等概率随机。
 * @param {object[]} visit 1585 的 visit
 * @param {Set<string>} inflightUids 在途集合
 * @param {number} nowSec 服务器时刻（秒）
 * @param {string} myUid 我的 StrUid
 * @param {string} myTag 我的联盟 tag
 * @returns {string|null} 目标 uid；无候选 null
 */
function pickRandomTarget(visit, inflightUids, nowSec, myUid, myTag) {
  var offlineSec = clampNum(cfg.maxOfflineHours, 1, 24 * 60, 24) * 3600;
  var gates = [
    { ally: !!cfg.allyOnly, offlineSec: offlineSec },
    { ally: !!cfg.allyOnly, offlineSec: Infinity }, // 放宽：不再看离线时长
    { ally: false, offlineSec: Infinity }, // 再放宽：不再看联盟
  ];
  for (var i = 0; i < gates.length; i++) {
    var pool = filterVisit(visit, gates[i], inflightUids, nowSec, myUid, myTag);
    if (pool.length) return pool[randIdx(pool.length)].ownerUid;
  }
  return null;
}

/**
 * 指定模式取一个目标：名单内等概率随机，允许放宽联盟/离线（名单是用户显式意志），但仍守 WAIT/在途/拉黑。
 * @param {object[]} visit 1585 的 visit
 * @param {Set<string>} inflightUids 在途集合
 * @param {number} nowSec 服务器时刻（秒）
 * @param {string} myUid 我的 StrUid
 * @returns {string|null} 目标 uid；无候选 null
 */
function pickSpecifiedTarget(visit, inflightUids, nowSec, myUid) {
  var pool = filterVisit(
    visit,
    { ally: false, offlineSec: Infinity, mine: cfg.uids },
    inflightUids,
    nowSec,
    myUid,
    '',
  );
  return pool.length ? pool[randIdx(pool.length)].ownerUid : null;
}

// ─────────────────────────── 段②：领奖 ───────────────────────────
/**
 * 汇总两处 REWARD 来源并逐条发 1584；顺带把「我家已到点前」的绝对时刻回传给择时。
 * @param {object[]} mainList 1583 的 info
 * @param {string} myUid 我的 StrUid
 * @param {number} nowSec 服务器时刻（秒）
 * @returns {Promise<{sent:number, wakeAt:number}>} sent=发出的领取请求数；wakeAt=待领到点的毫秒时刻（0=无）
 */
async function claimRewards(mainList, myUid, nowSec) {
  var sent = 0;
  var wakeAt = 0;
  if (!cfg.claim) return { sent: sent, wakeAt: wakeAt };

  /** @type {string[]} 待领目标家（去重：1583 与 breedData 两处来源可能指同一个家） */
  var targets = [];
  function addTarget(uid) {
    uid = String(uid || '');
    if (uid && targets.indexOf(uid) === -1) targets.push(uid);
  }
  for (var i = 0; i < mainList.length; i++) {
    var inf = mainList[i] && mainList[i].info;
    if (inf && (inf.breedingStatus | 0) === BREED_REWARD) addTarget(inf.ownerUid);
  }
  var bd = breedData && breedData.info;
  if (bd && (bd.breedingStatus | 0) === BREED_REWARD && String(bd.ownerUid || '') === myUid) {
    // 游戏 EnigmaBeastBreedInfo 同判据：自家产出要过 310009 缓冲分才允许领
    var readyAt = (bd.breedingEndTimeSec | 0) + 60 * (cfgNum(CFG.rewardBufferMin) || 0);
    if (readyAt <= nowSec) addTarget(myUid);
    else wakeAt = readyAt * 1000;
  }

  for (var j = 0; j < targets.length; j++) {
    var uid = targets[j];
    if (!aliveFn()) break;
    var ret = await send(CMD_BREEDING_BORN, { uid: uid });
    if (ret.code === 0) log.info('breeding reward claimed. uid=%s', uid);
    else if (ret.code !== CODE_NOT_SENT)
      log.info('claim rejected. uid=%s;code=%d;data=%s', uid, ret.code, rejectText(ret));
    sent++;
    if (j < targets.length - 1) await sleep(cfg.applyIntervalMs);
  }

  if (breedData && (breedData.helpBornRewardCnt | 0) > 0 && aliveFn()) {
    var r2 = await send(CMD_HELP_BORN_REWARD, {});
    if (r2.code === 0)
      log.info('help-born reward claimed (cnt=%d).', breedData.helpBornRewardCnt | 0);
    else if (r2.code !== CODE_NOT_SENT)
      log.info('help-born claim rejected. code=%d;data=%s', r2.code, rejectText(r2));
  }
  return { sent: sent, wakeAt: wakeAt };
}

// ─────────────────────────── 段③：主宠维持 ───────────────────────────
/**
 * 我家是否已有主宠：池内有 breeding=2 的兽，或 breedData/1583 见自家 info.main。
 * @param {object[]} beasts 1570 的 infos
 * @param {object[]} mainList 1583 的 info
 * @param {string} myUid 我的 StrUid
 * @returns {boolean}
 */
function hasMainBeast(beasts, mainList, myUid) {
  for (var i = 0; i < beasts.length; i++)
    if (beasts[i] && (beasts[i].breeding | 0) === OWN_MAIN) return true;
  var bd = breedData && breedData.info;
  if (bd && String(bd.ownerUid || '') === myUid && bd.main) return true;
  for (var j = 0; j < mainList.length; j++) {
    var inf = mainList[j] && mainList[j].info;
    if (inf && String(inf.ownerUid || '') === myUid && inf.main) return true;
  }
  return false;
}

/**
 * 无主宠时按主宠物种/品质挑最优发 1579。已有主宠一律不动（不主动换，避免打断在培育）。
 * @param {object[]} beasts 1570 的 infos
 * @returns {Promise<boolean>} 是否发出了设置请求
 */
async function ensureMain(beasts) {
  var pool = pickBreedable(beasts, cfg.mainTypes, cfg.mainQualities, null);
  if (!pool.length) {
    log.warn('no main candidate under current type/quality filter.');
    return false;
  }
  pool.sort(mainSort);
  var pick = pool[0];
  var ret = await send(CMD_MAIN_SET, { id: bits.int64(pick.strId) });
  if (ret.code === 0) {
    log.info('main beast set. strId=%s;cfgId=%d;quality=%d', pick.strId, pick.cfgId, pick.quality);
    return true;
  }
  if (ret.code !== CODE_NOT_SENT)
    log.info('main set rejected. code=%d;data=%s', ret.code, rejectText(ret));
  return false;
}

// ─────────────────────────── 段④：同意 / 加油 / 分享 ───────────────────────────
/**
 * 处理别人对我家的申请（1581）。前置：我家必须有主宠，否则服务器一定拒（游戏 UI 同闸门）。
 * 同意口径由 cfg.autoAgree 一档决定（与 cfg.mode 互斥关系对齐）：
 *   list（指定玩家模式）= 只处理名单内申请人的申请，不再套联盟/离线；名单是用户显式意志；
 *   ally / all（随机玩家模式）= 按联盟 tag 比对 / 不看关系。
 * 被拒（非哨兵）本轮整段收手、下轮再试——不做按 uid 拉黑，同一申请人下一拍仍会重读 1582 再判。
 * @param {object[]} applyList 1582 的 apply
 * @param {boolean} mainSet 我家已有主宠
 * @returns {Promise<number>} 处理条数
 */
async function agreeApplies(applyList, mainSet) {
  if (cfg.autoAgree === 'off' || !applyList.length) return 0;
  if (!mainSet) {
    log.warn('skip agree: my home has no main beast (server would reject).');
    return 0;
  }
  var myTag = gameData.myAllianceTag();
  var done = 0;
  for (var i = 0; i < applyList.length; i++) {
    var a = applyList[i];
    if (!a || !aliveFn()) break;
    var uid = String(a.uid || '');
    if (!uid) continue;
    if (cfg.autoAgree === 'list') {
      if (cfg.uids.indexOf(uid) === -1) continue;
    } else if (cfg.autoAgree === 'ally' && (!myTag || String(a.allianceTag || '') !== myTag))
      continue;
    var idS = idStr(a.id);
    if (!idS) continue;
    var ret = await send(CMD_OTHER_APPLY_OP, { uid: uid, id: bits.int64(idS), agree: true });
    done++;
    if (ret.code === 0) log.info('agreed a breeding apply. uid=%s;beast=%s', uid, idS);
    else if (ret.code !== CODE_NOT_SENT) {
      log.info(
        'agree rejected, stop this round. uid=%s;code=%d;data=%s',
        uid,
        ret.code,
        rejectText(ret),
      );
      break; // 同一原因大概率会连着拒绝整批：本轮整段收手，下轮再试（不拉黑申请人）
    }
    await sleep(cfg.applyIntervalMs);
  }
  return done;
}

/**
 * 帮盟友加速（1587）。四重闸门逐条判（同游戏 VisitPopCell）：培育中 && 那家的寄养兽不是我 && 我没帮过
 * && 该兽被帮助人次未饱和 && 我今日帮助次数未耗尽。每轮最多 helpPerTick 条，条间限流。
 * @param {object[]} visit 1585 的 visit
 * @param {string} myUid 我的 StrUid
 * @returns {Promise<number>} 发出的帮助条数
 */
async function helpBreeding(visit, myUid) {
  if (!cfg.autoHelp) return 0;
  var perMax = cfgNum(CFG.helpPerBeast);
  var dailyMax = cfgNum(CFG.dailyHelp);
  var todayHelp = breedData ? breedData.breedingTodayHelpCnt | 0 : 0;
  var done = 0;
  for (var i = 0; i < visit.length && done < cfg.helpPerTick; i++) {
    if (!aliveFn()) break;
    var v = visit[i];
    if (!v || (v.breedingStatus | 0) !== BREED_BREEDING) continue;
    var uid = String(v.ownerUid || '');
    if (!uid || uid === myUid) continue;
    if (v.other && String(v.other.uid || '') === myUid) continue; // 寄养的是我自己的兽，不帮
    var help = Array.isArray(v.helpUid) ? v.helpUid : [];
    var already = false;
    for (var k = 0; k < help.length; k++)
      if (String(help[k]) === myUid) {
        already = true;
        break;
      }
    if (already) continue;
    if (perMax > 0 && help.length >= perMax) continue;
    if (dailyMax > 0 && breedData && todayHelp + done >= dailyMax) break;
    var ret = await send(CMD_BREEDING_HELP, { uid: uid });
    if (ret.code === 0) {
      log.debug('helped breeding. uid=%s', uid);
      done++;
    } else if (ret.code !== CODE_NOT_SENT) {
      log.info('help rejected. uid=%s;code=%d;data=%s', uid, ret.code, rejectText(ret));
      break;
    }
    await sleep(cfg.applyIntervalMs);
  }
  return done;
}

/**
 * 分享我家这一组培育求盟友加油（同游戏 EnigmaBeastBreedMainPop.onBreedShareClick）：
 * 那条「请来给我的异能兽加油吧」不是 15xx，而是一条聊天链接 —— 670 PostChatMsg，
 * m='link'、c=2（联盟）、llm={t:35, pid:我的StrUid, enigmaBeastInfoList:[我家 main, 寄养进来的 other], uts:1}
 * （id 一律十进制串，实录 20261007T034829 逐字段核对）；盟友点它才发 1587，各人受自己的 310012 限额约束。
 * 四重闸门：培育中 && main/other 齐 && 已被加油人次未饱和（310011，满了再分享也没人能加）
 * && 距上次分享够 cfg.shareIntervalMin。上次时刻落账本，否则刷新一次页面就多刷一条联盟消息。
 * @param {string} myUid 我的 StrUid
 * @param {number} nowMs 本地毫秒时刻
 * @returns {Promise<boolean>} 是否发出了分享
 */
async function shareForHelp(myUid, nowMs) {
  if (!cfg.shareHelp) return false;
  var inf = breedData && breedData.info;
  if (!inf || (inf.breedingStatus | 0) !== BREED_BREEDING) return false; // 等同意 / 可领时无可加油的对象
  if (String(inf.ownerUid || '') !== myUid || !inf.main || !inf.other) return false;
  var perMax = cfgNum(CFG.helpPerBeast);
  var help = Array.isArray(inf.helpUid) ? inf.helpUid : [];
  if (perMax > 0 && help.length >= perMax) return false;
  var gapMs =
    clampNum(cfg.shareIntervalMin, SHARE_INTERVAL_MIN, 24 * 60, SHARE_INTERVAL_DEFAULT) * 60e3;
  if (ledger.shareAt > 0 && nowMs - ledger.shareAt < gapMs) return false;
  var mainId = idStr(inf.main.id);
  var otherId = idStr(inf.other.id);
  if (!mainId || !otherId) return false;
  var chat = window.pocketcc && window.pocketcc.chat;
  if (!chat) {
    log.warn('skip share: pocketcc.chat unavailable.');
    return false;
  }
  var payload = {
    t: SHARE_LINK_TYPE,
    pid: myUid,
    uts: 1,
    enigmaBeastInfoList: [
      { id: mainId, cfgId: inf.main.cfgId | 0, star: inf.main.star | 0 },
      { id: otherId, cfgId: inf.other.cfgId | 0, star: inf.other.star | 0 },
    ],
  };
  var ret;
  try {
    ret = await chat.send('link', { channel: 'alliance', llm: JSON.stringify(payload) });
  } catch (err) {
    log.warn('share threw: %s', err && err.message);
    return false;
  }
  // 670 应答：成功 data 是 '{"success":1,…}' JSON 串，业务拒（频控/禁言）为裸串
  var ack = null;
  try {
    ack = JSON.parse(String((ret && ret.data) || ''));
  } catch (e) {}
  if (!ret || !ret.ok || !ack || ack.success !== 1) {
    log.info('share rejected. code=%s;data=%s', ret && ret.code, ret && ret.data);
    return false;
  }
  ledger.shareAt = nowMs;
  persistLedger();
  log.info(
    'help request shared to alliance. main=%s;other=%s;helped=%d/%d',
    mainId,
    otherId,
    help.length,
    perMax,
  );
  return true;
}

// ─────────────────────────── 段⑤：在途撤单 + 新申请 ───────────────────────────
/**
 * 从 1583 提取「我发出且等待同意」的在途集合（apply 非空的条目，apply.id 是我的兽、info.ownerUid 是目标家）。
 * @param {object[]} mainList 1583 的 info
 * @returns {Array<{uid:string, beastId:string}>} 在途单
 */
function collectInflight(mainList) {
  var out = [];
  for (var i = 0; i < mainList.length; i++) {
    var e = mainList[i];
    if (!e || !e.apply || !e.info) continue;
    var uid = String(e.info.ownerUid || '');
    var beastId = idStr(e.apply.id);
    if (!uid || !beastId) continue;
    out.push({ uid: uid, beastId: beastId });
  }
  return out;
}

/**
 * 超时撤单：1583 的 apply 条目不带发起时间戳，故按 inflightSeen[uid] 的首见时刻判 TTL；
 * 超期即发 1580 apply:false 撤单，腾出 310008 名额给随机池的其他候选（不拉黑目标，下拍可再申请）。
 * TTL 本身即是防刷屏的收敛阀：撤单前该 uid 在 inflightUids 里被挡住，撤单后要等 inflightSeen 被 clear 才会重发。
 * @param {Array<{uid:string,beastId:string}>} inflight 在途单
 * @param {number} nowMs 本地毫秒时刻
 * @returns {Promise<number>} 撤单数
 */
async function cancelStaleApplies(inflight, nowMs) {
  var uidSet = new Set(
    inflight.map(function (x) {
      return x.uid;
    }),
  );
  // 条目消失即删账（服务器已同意/拒绝，首发时刻重新起算）
  for (var key in inflightSeen) if (!uidSet.has(key)) delete inflightSeen[key];
  inflight.forEach(function (x) {
    if (inflightSeen[x.uid] == null) inflightSeen[x.uid] = nowMs;
  });
  persistLedger();

  var ttl = APPLY_TTL_HOURS * 3600e3;
  var n = 0;
  for (var i = 0; i < inflight.length; i++) {
    if (!aliveFn()) break;
    var it = inflight[i];
    if (nowMs - (inflightSeen[it.uid] || nowMs) <= ttl) continue;
    var ret = await send(CMD_OTHER_APPLY, {
      uid: it.uid,
      id: bits.int64(it.beastId),
      apply: false,
    });
    if (ret.code === 0) {
      log.info(
        'stale apply withdrawn. uid=%s;beast=%s;age=%dmin',
        it.uid,
        it.beastId,
        Math.round((nowMs - inflightSeen[it.uid]) / 60000),
      );
      delete inflightSeen[it.uid];
      n++;
    } else if (ret.code !== CODE_NOT_SENT) {
      log.info('withdraw rejected. uid=%s;code=%d;data=%s', it.uid, ret.code, rejectText(ret));
    }
    await sleep(cfg.applyIntervalMs);
  }
  return n;
}

/**
 * 今日剩余可申请次数（镜像游戏 EnigmaBeastBreedMainPop 同判据：`max(310007 - breedingTodayCnt, 0) + breedingBuyMaxCnt`）。
 * breedData 缺失回 null（调用方 fail-open，靠服务器拒绝兜底）；返回 <=0 即与游戏一样会弹 enigma_peiyu_times_8 挡住申请。
 * @returns {number|null} 剩余次数；不可知回 null
 */
function dailyApplyLeft() {
  if (!breedData) return null;
  var free = Math.max((cfgNum(CFG.dailyApply) || 0) - Number(breedData.breedingTodayCnt || 0), 0);
  return free + Number(breedData.breedingBuyMaxCnt || 0);
}

/**
 * 在名额内发新申请：先算闸门（在途数 / 310008 上限 / 每日次数），再逐轮「挑目标 × 挑我兽」配对。
 * 挑不到任一侧即收手。同轮内已用的 strId 从池子剔除，不重复申请。
 * @param {object[]} beasts 1570 的 infos
 * @param {object[]} visit 1585 的 visit
 * @param {Array<{uid:string,beastId:string}>} inflight 在途单（已扣掉本轮撤掉的）
 * @param {number} nowSec 服务器时刻（秒）
 * @param {number} nowMs 本地毫秒时刻
 * @returns {Promise<{applied:number, noTarget:boolean, noBeast:boolean}>} 结果摘要
 */
async function applyNewBeasts(beasts, visit, inflight, nowSec, nowMs) {
  var res = { applied: 0, noTarget: false, noBeast: false };
  if (ledger.exhausted === todayStr()) return res;

  // 在途名额恒跟随游戏上限 310008（面板不再暴露：调小只会少培育，调大服务器硬拦）
  var cap = cfgNum(CFG.inflightMax) || DEFAULT_INFLIGHT_MAX;
  var slots = Math.max(0, cap - inflight.length);
  if (slots <= 0) return res;

  // 每日次数：仅当 breedData 可得时硬判（缺失 fail-open，靠服务器拒绝回落）
  var left = dailyApplyLeft();
  if (left != null) {
    if (left <= 0) {
      log.info('daily apply quota used up (breedData).');
      return res;
    }
    slots = Math.min(slots, left);
  }

  var myUid = gameData.strUid();
  var myTag = gameData.myAllianceTag();
  /** @type {Set<string>} 本轮已消耗的兽 id */
  var used = new Set();
  var inflightUids = new Set(
    inflight.map(function (x) {
      return x.uid;
    }),
  );

  while (slots > 0 && aliveFn()) {
    var target =
      cfg.mode === 'specify'
        ? pickSpecifiedTarget(visit, inflightUids, nowSec, myUid)
        : pickRandomTarget(visit, inflightUids, nowSec, myUid, myTag);
    if (!target) {
      res.noTarget = true;
      break;
    }
    var pool = pickBreedable(beasts, cfg.applyTypes, cfg.applyQualities, used);
    if (!pool.length) {
      res.noBeast = true;
      break;
    }
    var pick = pool[randIdx(pool.length)];
    used.add(pick.strId);

    var ret = await send(CMD_OTHER_APPLY, { uid: target, id: bits.int64(pick.strId), apply: true });
    if (ret.code === 0) {
      log.info('apply sent. uid=%s;beast=%s;cfgId=%d', target, pick.strId, pick.cfgId);
      inflightSeen[target] = nowMs;
      inflightUids.add(target);
      persistLedger();
      res.applied++;
      slots--;
    } else if (ret.code !== CODE_NOT_SENT) {
      var text = rejectText(ret);
      log.info('apply rejected. uid=%s;code=%d;reason=%s', target, ret.code, text || '(none)');
      if (text.indexOf(REJECT_TIMES_EXHAUSTED) >= 0) {
        ledger.exhausted = todayStr();
        persistLedger();
        log.info('daily apply exhausted today, only claim/help will run.');
        break;
      }
      inflightUids.add(target); // 本轮不再撞同一目标（不做按 uid 拉黑，下拍重读 1585 再判）
    }
    await sleep(cfg.applyIntervalMs);
  }
  // 指定模式下「名单里全忙/在途」是随名额释放自愈的「当前不可动作」→ debug（勿当 warn 刷屏）；
  // 随机模式回退后仍空往往意味着过滤口径过严，保留 warn 供排查。
  if (res.noTarget && cfg.mode === 'specify')
    log.debug('no visit candidate in specified list (all busy / inflight).');
  else if (res.noTarget) log.warn('no visit candidate even after fallbacks.');
  if (res.noBeast) log.warn('no free beast matches type/quality filter.');
  return res;
}

// ─────────────────────────── 一轮 ───────────────────────────
/**
 * 全量读一条并区分「读到空集」与「没读到」：后者返回 null（调用方按旗标跳过依赖段）。
 * 把读失败当空集会算错在途数，进而超发 310008 名额——宁可不发也不猜。
 * @param {number} cmd 命令号
 * @param {string} label 日志用别名
 * @returns {Promise<object|null>} 业务 data（失败 null）
 */
async function readAll(cmd, label) {
  var ret = await send(cmd, {});
  if (ret.code !== 0) {
    log.warn('%s read failed. cmd=%d;code=%d', label, cmd, ret.code);
    return null;
  }
  return ret.data || {};
}

/**
 * cycle 单轮：五段顺序折叠，返回下拍延迟。任何一段的异常都由 cycle 的 fallback 兜住（绝不停摆）。
 * @returns {Promise<number>} 下拍 delay（毫秒）；0 = 立即再跑
 */
async function cycleRun() {
  var nowMs = Date.now();
  var nowSec = gameData.serverTime() || Math.floor(nowMs / 1000);
  var myUid = gameData.strUid();

  // 额度已尽（当日累计耗尽或被服务器判次数耗尽）且本轮无需再动主宠时，跳过 1570 兽池重读：
  //   1570 只喂「选兽申请」与「设主宠」两处，额度用尽后两条都跑不到，几百行的全量池查询纯属浪费。
  //   用 {} 记「主动跳过」而非 null，避免被末拍当成「读降级」而强制 5 分重试；一旦再买次数（10132 刷 breedData + kick）下轮自动恢复。
  var qLeft = dailyApplyLeft();
  var quotaOut = ledger.exhausted === todayStr() || (qLeft != null && qLeft <= 0);
  var bdInfo0 = breedData && breedData.info;
  var homeMainKnown = !!(bdInfo0 && String(bdInfo0.ownerUid || '') === myUid && bdInfo0.main);
  var skipPool = quotaOut && (!cfg.enableMain || homeMainKnown);

  // ① 全量读（可重放权威通道）；失败的通道置旗标，下游按旗标跳过
  var poolD = skipPool ? {} : await readAll(CMD_GET_INFO, 'beast-pool');
  var beasts = (poolD && poolD.infos) || [];
  if (!aliveFn()) return 0;
  var mainD = await readAll(CMD_MAIN_LIST, 'main-list');
  var mainList = (mainD && mainD.info) || [];
  if (!aliveFn()) return 0;
  var visitD = await readAll(CMD_VISIT_LIST, 'visit-list');
  var visit = (visitD && visitD.visit) || [];
  if (!aliveFn()) return 0;
  var applyList = [];
  if (cfg.autoAgree !== 'off') {
    var applyD = await readAll(CMD_OTHER_APPLY_LIST, 'apply-list');
    applyList = (applyD && applyD.apply) || [];
  }

  // ② 领奖
  var claim = await claimRewards(mainList, myUid, nowSec);
  if (!aliveFn()) return 0;

  // ③ 主宠维持
  var mainSet = hasMainBeast(beasts, mainList, myUid);
  if (cfg.enableMain && !mainSet && beasts.length) mainSet = (await ensureMain(beasts)) || mainSet;

  // ④ 同意 / 加油 / 分享求加油
  await agreeApplies(applyList, mainSet);
  if (!aliveFn()) return 0;
  await helpBreeding(visit, myUid);
  if (aliveFn()) await shareForHelp(myUid, nowMs);

  // ⑤ 在途撤单 → 新申请：三条通道全读到才跑（部分缺失会把在途数算少、或把首发时刻误删）
  var inflight = collectInflight(mainList);
  if (poolD && mainD && visitD && aliveFn()) {
    var cancelled = await cancelStaleApplies(inflight, nowMs);
    if (cancelled)
      inflight = inflight.filter(function (x) {
        return inflightSeen[x.uid] != null;
      });
    // 额度已尽：已知 applyNewBeasts 会立刻 bail，不再进（既省重复的 quota 日志，也免白跑配对）；撤单照跑以清过期在途
    if (aliveFn() && !quotaOut) await applyNewBeasts(beasts, visit, inflight, nowSec, nowMs);
  } else {
    log.debug('apply/cancel stage skipped: full-read channel unavailable.');
  }

  if (cycle.pending) return 0;
  var delay = planNextDelay(mainList, inflight, claim);
  // 全量读通道有降级（-1 未发出 / 读失败，多与游戏客户端刷新的在途撞车）→ 别按「全空闲」睡 30 分，短隔重试
  if (!(poolD && mainD && visitD)) delay = Math.min(delay, ACTIVE_INTERVAL_MS);
  return delay;
}

/**
 * 择时：有待领但没到点 → 睡到绝对到点时刻（游戏 breedingEndTimeSec 显式时刻，仅 24h 硬顶）；有在途/在培育 → ACTIVE；其余 IDLE。
 * @param {object[]} mainList 1583 的 info
 * @param {Array<{uid:string,beastId:string}>} inflight 在途单
 * @param {{sent:number, wakeAt:number}} claim 领奖摘要
 * @returns {number} 下拍毫秒
 */
function planNextDelay(mainList, inflight, claim) {
  if (claim && claim.wakeAt > 0) {
    var d = claim.wakeAt - Date.now();
    if (d > 0) return Math.min(d, 24 * 3600 * 1000);
  }
  var busy = inflight.length > 0;
  if (!busy) {
    for (var i = 0; i < mainList.length; i++) {
      var inf = mainList[i] && mainList[i].info;
      if (
        inf &&
        ((inf.breedingStatus | 0) === BREED_BREEDING || (inf.breedingStatus | 0) === BREED_REWARD)
      ) {
        busy = true;
        break;
      }
    }
  }
  var bd = breedData && breedData.info;
  if (
    !busy &&
    bd &&
    ((bd.breedingStatus | 0) === BREED_BREEDING || (bd.breedingStatus | 0) === BREED_REWARD)
  )
    busy = true;
  return busy ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
}

// ─────────────────────────── 推送唤醒 ───────────────────────────
/**
 * 10132：整包 breedData 覆盖缓存（每日申请/帮助次数、帮助奖励数的唯一来源）。listener 永不 throw。
 * @param {object} ev net 事件 {cmd,status,data}；data 是 pbAckV2 {header,data}
 */
function onBreedingPush(ev) {
  var p = ev && ev.data;
  if (p && typeof p === 'object' && p.data && typeof p.data === 'object') {
    breedData = p.data;
  }
  if (aliveFn()) cycle.kick();
}

/**
 * 10130 / 10133：兽池或别人家变更，只当唤醒信号（真相下一轮全量重读）。
 */
function onWakePush() {
  if (aliveFn()) cycle.kick();
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_INTERVAL_MS });

// ─────────────────────────── 生命周期 ───────────────────────────
/**
 * 安装：取网络底座（必须）+ EnigmaBeastController 单例（可选，缺则领域占用过滤降级为不过滤）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean} 依赖缺失即 false（reactor 不会激活）
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;

  net = ctx.net;
  if (!net || !net.install()) {
    log.warn('install failed. missing=pocketcc.net');
    net = null;
    return false;
  }

  var m = game.get('EnigmaBeastController');
  ctl =
    m && m.default && typeof m.default.getInstance === 'function'
      ? m.default.getInstance() || null
      : null;
  if (!ctl)
    log.warn('installed without EnigmaBeastController; field-occupy filter degrades to no-op.');

  installed = true;
  log.info('installed. ctl=%s', ctl ? 'ok' : 'missing');
  return true;
}

/**
 * 注入模块配置（toModuleCfg 产出）：热更即生效，并 kick 一次把睡梦中的下一拍提前——
 * 否则「先开功能、后调参数」时新口径要干等到 IDLE 档才复查。
 * @param {object} partial 归一化后的模块配置
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (partial && typeof partial === 'object') cfg = Object.assign({}, cfg, partial);
  if (aliveFn()) cycle.kick();
  return cfg;
}

/**
 * 运行：复位跨轮状态，挂三条推送唤醒，读回当日账本后点火。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  ctx.on.push(PUSH_BEAST_CHANGE, onWakePush);
  ctx.on.push(PUSH_BREEDING_CHANGE, onBreedingPush);
  ctx.on.push(PUSH_OTHER_BREEDING, onWakePush);
  // 重新激活时补一次 breedData（游戏控制器是 10132 的常驻镜像，比等下一条推送快）
  if (!breedData && ctl && ctl.breedData && typeof ctl.breedData === 'object')
    breedData = ctl.breedData;
  Promise.resolve(loadLedger());
  log.info(
    'started (mode=%s;agree=%s;help=%s;claim=%s;share=%s).',
    cfg.mode,
    cfg.autoAgree,
    cfg.autoHelp,
    cfg.claim,
    cfg.shareHelp,
  );
  cycle.kick();
}

// ─────────────────────────── 面板条件显隐与选项枚举 ───────────────────────────
/**
 * 是否「指定玩家」模式（两模式互斥，面板只展开当前模式那侧的参数：随机池口径 vs 名单）。
 * @param {object} c 面板配置
 * @returns {boolean}
 */
function isSpecify(c) {
  return c.mode === 'specify';
}
/**
 * 是否「随机玩家」模式（见 isSpecify 的同源口径）：用 !== 而非 === 判随机，
 * 使未设/旧值都落到随机那侧（那边的闸门更多，更保守）。
 * @param {object} c 面板配置
 * @returns {boolean}
 */
function isRandom(c) {
  return c.mode !== 'specify';
}

/**
 * 异能兽物种枚举（enigma_beast 全表去重 type），标签走游戏同一条链：
 *   enigma_beast_type.name_type → LOCAL.getText。查不到回「物种 N」（宁显原文也不空列表）。
 * @returns {Array<{value:number,label:string}>}
 */
function typeOptions() {
  var rows = l10n.tableRows('enigma_beast');
  var seen = [];
  for (var i = 0; i < rows.length; i++) {
    var t = rows[i] && Number(rows[i].type) | 0;
    if (t > 0 && seen.indexOf(t) === -1) seen.push(t);
  }
  seen.sort(function (a, b) {
    return a - b;
  });
  return seen.map(function (t) {
    var r = l10n.tableRow('enigma_beast_type', t);
    var key = r && r.name_type;
    return { value: t, label: key ? l10n.text(key) : '物种 ' + t };
  });
}

/**
 * 品质枚举（游戏 QUALITY_NUM=5，名字键 enigma_beast_quality + padNumber(q,3)，与 EnigmaBeastResCfg.getQualityName 同源）
 * @returns {Array<{value:number,label:string}>}
 */
function qualityOptions() {
  var out = [];
  for (var q = 1; q <= 5; q++) {
    var key = 'enigma_beast_quality' + ('00' + q).slice(-3);
    out.push({ value: q, label: l10n.text(key) });
  }
  return out;
}

// ─────────────────────────── 注册说明书 ───────────────────────────
reactor.register({
  id: 'beastBreed',
  label: '异能兽培育',
  storageKey: 'pocketcc.feat.beastBreed',
  symbols: ['dataCenter', 'tableManager', 'tableUtils', 'long64Bit', 'enigmaBeast?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: {
    enabled: false,
    mode: 'random',
    uids: [],
    agreeList: true,
    allyOnly: true,
    maxOfflineHours: 24,
    autoAgree: 'ally',
    applyTypes: [],
    applyQualities: [],
    mainTypes: [],
    mainQualities: [],
    enableMain: true,
    autoHelp: true,
    claim: true,
    shareHelp: true,
    shareIntervalMin: SHARE_INTERVAL_DEFAULT,
  },
  // 面板文案一律走游戏官方口径（字典表 enigma_beast*）：1580/1581 =「培育申请」、1587 =「加油」、
  //   我家那只 main 兽 =「放置的异能兽」；代码注释仍用「主宠 / 出访兽」简称，与面板同一回事。
  // 「找谁培育」是这一张卡的总闸式字段：select 一翻，另一侧的参数整片收起（fd.showIf），因为它们在业务上就不参与——
  //   「指定玩家」下拜访与同意都只认名单（名单是用户显式意志，不再套联盟/离线阈值）；「随机玩家」下没有名单可言。
  //   两模式共用的段（派出的兽 / 我放置的兽 / 自动领奖与加油）不受模式影响，照常展开。
  fields: [
    {
      key: 'mode',
      type: 'select',
      label: '找谁培育',
      section: '培育对象',
      options: [
        { value: 'random', label: '随机玩家' },
        { value: 'specify', label: '指定玩家' },
      ],
    },
    {
      key: 'uids',
      label: '指定玩家名单',
      type: 'uidlist',
      max: 20,
      section: '培育对象',
      itemLabel: '玩家',
      placeholder: '请输入玩家UID',
      hint: '拜访与同意申请都只在这份名单内；名单内等概率随机一个空着的家',
      showIf: isSpecify,
    },
    {
      key: 'agreeList',
      label: '同意名单内的申请',
      type: 'checkbox',
      section: '培育对象',
      showIf: isSpecify,
    },
    {
      key: 'allyOnly',
      label: '只找同联盟',
      type: 'checkbox',
      section: '培育对象',
      showIf: isRandom,
    },
    {
      key: 'maxOfflineHours',
      label: '只找离线不超过(时)',
      min: 1,
      step: 1,
      section: '培育对象',
      showIf: isRandom,
    },
    {
      key: 'autoAgree',
      type: 'select',
      label: '自动同意申请',
      section: '培育对象',
      showIf: isRandom,
      options: [
        { value: 'off', label: '不同意' },
        { value: 'ally', label: '仅同联盟' },
        { value: 'all', label: '全部同意' },
      ],
    },
    {
      key: 'applyTypes',
      type: 'multiopts',
      label: '派出的物种',
      section: '派出的兽',
      options: typeOptions,
      hint: '全不勾 = 不限物种',
    },
    {
      key: 'applyQualities',
      type: 'multiopts',
      label: '派出的品质',
      section: '派出的兽',
      gridMin: 60,
      options: qualityOptions,
      hint: '全不勾 = 不限品质',
    },
    { key: 'enableMain', label: '自动放置一只兽', type: 'checkbox', section: '我放置的兽' },
    {
      key: 'mainTypes',
      type: 'multiopts',
      label: '放置物种',
      section: '我放置的兽',
      options: typeOptions,
      hint: '全不勾 = 不限物种；按品质→星级→等级→潜力取最优',
    },
    {
      key: 'mainQualities',
      type: 'multiopts',
      label: '放置品质',
      section: '我放置的兽',
      gridMin: 60,
      options: qualityOptions,
      hint: '全不勾 = 不限品质',
    },
    { key: 'claim', label: '自动领取培育产出', type: 'checkbox', section: '自动领奖与加油' },
    { key: 'autoHelp', label: '自动给别人培育加油', type: 'checkbox', section: '自动领奖与加油' },
    // 自家在培育且还能被加 → 往联盟发一条求加油的链接（同游戏分享按钮）；间隔是用户能判断的（怕刷屏就调大），
    //   真正的节奏闸门（已被加油人次达 310011）由脚本自判，无需用户动手。
    { key: 'shareHelp', label: '分享到联盟求加油', type: 'checkbox', section: '自动领奖与加油' },
    {
      key: 'shareIntervalMin',
      label: '求加油间隔(分)',
      min: SHARE_INTERVAL_MIN,
      step: 5,
      section: '自动领奖与加油',
    },
  ],
  toModuleCfg: function (c) {
    var mode = c.mode === 'specify' ? 'specify' : 'random';
    // 同意口径跟着模式走，两侧各读自己那个控件（另一侧的存量值不参与）：
    //   指定模式 = agreeList 勾选 → 'list'（只处理名单内申请人）/ 不勾 → 'off'；
    //   随机模式 = autoAgree 三档，非法值落 'off'（自动同意会把我的主宠与人配对，属有副作用的动作，宁可不做）。
    var agree =
      mode === 'specify'
        ? c.agreeList === false
          ? 'off'
          : 'list'
        : c.autoAgree === 'all' || c.autoAgree === 'ally'
          ? c.autoAgree
          : 'off';
    return {
      mode: mode,
      uids: normUids(c.uids),
      allyOnly: c.allyOnly !== false,
      maxOfflineHours: clampNum(c.maxOfflineHours, 1, 24 * 60, 24),
      applyTypes: normNums(c.applyTypes),
      applyQualities: normNums(c.applyQualities),
      mainTypes: normNums(c.mainTypes),
      mainQualities: normNums(c.mainQualities),
      enableMain: !!c.enableMain,
      autoAgree: agree,
      autoHelp: !!c.autoHelp,
      claim: c.claim !== false,
      shareHelp: c.shareHelp !== false,
      shareIntervalMin: clampNum(
        c.shareIntervalMin,
        SHARE_INTERVAL_MIN,
        24 * 60,
        SHARE_INTERVAL_DEFAULT,
      ),
      applyIntervalMs: APPLY_INTERVAL_MS,
      helpPerTick: HELP_PER_TICK,
    };
  },
  install: install,
  configure: configure,
  run: run,
});
