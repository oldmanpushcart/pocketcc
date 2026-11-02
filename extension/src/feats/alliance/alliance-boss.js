/**
 * 联盟机甲-自动捐献与攻打（AllianceBoss 老版，reactor 说明书形态）
 *
 * 联盟机甲是联盟维度的 PvE 循环：捐献进度（state=0）→ 召唤后战斗（1）/ 损毁（4）→ 检修（2）。
 * 本功能干两件事：
 *   1) 捐献中（state=0）按「召唤该型号所需碎片数」命中的区间档位代捐机甲碎片：面板上可动态增删
 *      `[from, to) → N 枚` 的规则（to=0 表示不封顶，N=0 表示该段不捐）。型号不同，所需碎片差得很远，
 *      固定枚数要么白捐要么不够，所以配的是区间规则而不是一个数；
 *      首日第一枚走「免费捐」（count:0），其余从背包扣；碎片不够就本轮放弃，不做部分捐赠；
 *   2) 能打就派预设部队（1-8）打一次——不论战斗期还是损毁期，本轮（同一 bossId，当日）只成功发起一次；
 *   3) 脚本加载时多半已错过状态推送，故 run 点火先主动查一次（本地未被填充时用 1160 取全量）。
 *
 * 区间规则的匹配键 num 来自 Alliance_Boss[bossId].num（游戏 AllianceBossPanel 判进度/剩余用的就是它），
 *   经 l10n.tableRow('Alliance_Boss', bossId) 只读取；表行取不到时不捐（宁可不发，按错档位猛捐更糟）。
 *
 * 代际判定（重要）：本功能只做老版。真机抓包（references/历史文档/联盟机甲.md）全程只有
 *   push 10435 + req 1160/1161 + 902(marchType=18)，无 3830-3838 / 21912；V3 是「预约放置 + 只能集结」
 *   的另一套（见 references/游戏逆向/联盟机甲模块分析报告.md §9）。老版在 V3 服上 1160 无有效应答，
 *   本功能自然空转，不做版本门控。
 *
 * 数据源分级（「优先本地数据」的落地口径）：
 *   读本地（游戏 AllianceBossData，由 push 10435 / 1160 / 1161 应答刷新）：state / bossId / x / y / exp / hp / endTime；
 *   读本地：碎片持有 item.amount(3200001)（经 core/item.js 唯一入口）；每日上限与入盟门槛走 gameConf.dataConfig(25008/25009)；
 *   必须发包：todayTime / todayFree —— 这俩由 AllianceBossData.updateData 的 `null != e.todayTime` 守卫单独维护，
 *     而 push 10435 载荷里没有（只有 allianceBoss 一块），未开过面板时恒为构造默认 0 → 判免费只能问 1160。
 *   必须自建：「本轮是否已攻打」——游戏侧无此口径（FinishedIds 只喂 _passIdPool 做型号解锁，
 *     不是玩家攻打记录：抓包里 bossId=1003 已在 FinishedIds 却照样发出了 902），故本机按 bossId 记账。
 *
 * 三条协议（均旧 JSON NET.send，应答 data 为 JSON 串需 parse）：
 *   1) ALLIANCE_BOSS_GET_INFO(1160) {} → {allianceBoss:{state,bossId,x,y,exp,hp,endTime,expireTime,pointSid,…},todayTime,todayFree}；
 *   2) ALLIANCE_BOSS_DONATE(1161) {count} → {ret,reward,bossInfo:{allianceBoss,todayTime,todayFree},count}；
 *      count:0 = 免费捐一枚（不扣碎片），count:n = 扣 n 枚碎片；
 *   3) MARCH_WORLD_POINT(902) {marchType:18,x,y,armyList…} → 派兵攻打，坐标取本地 allianceBoss.x/y。
 *      载荷构造与「快捷攻击」「战争之源」同源：Battle().plan().preset(1..8).adjust().build()（见 core/battle.js）。
 *
 * marchType 18 不漂移（源码实证，同 298 的处置）：WorldUtils.dealMarchTypeWithSpecialMarch 只改写
 *   ATTACK_PLAYER / THRONE / WORLD_SITE 三支，specialMarchList 也不含机甲，battleMarchType[BattleType.AllianceBoss]
 *   = MarchType.ALLIANCE_BOSS 直接命中 → PvE 固定值可写死，无需 march.resolve。
 *
 * 触发（不靠轮询硬撑）：
 *   - run 点火即查一次（脚本加载时大概率已错过 10435，本地 state 未填充则补发 1160 取全量）；
 *   - 收到 push 10435（state/坐标/exp 变化）即刻查一轮；
 *   - 有活可干时按 BUSY_TICK 慢查；state=3（预约中）按 summonTime、state=1 按 endTime 精准到点唤醒，
 *     补「状态自然翻转服务器不再推」这段；无事可干退到 IDLE_TICK。
 *
 * 闸门（对齐游戏 AllianceBossPanel）：在盟 && JoinTime + DataConfig(25009) <= ServerTime（老版 24h 门槛，
 *   不足游戏提示 allianceMachine037）→ 捐献还需 state=0 且 exp < Alliance_Boss[bossId].num，
 *   且该型号当日未捐满区间档位配的枚数；
 *   攻打还需行军槽 >= 1、902/1161 不在途（NetMgr 按 cmd 频控，连发同 cmd 会被吞）。
 *
 * 生命周期由 reactor 托管：install/configure/run 三钩子，places 限 base/world（Home/NWorldMap），战斗模式暂停。
 *   单飞闸门 / 触发合并 / 择时重排收口到 core/cycle；pause 后 alive()=false 让 cycle 自然停摆，resume 重新 kick。
 *   合规：全程只读游戏数据 + 直发协议，不调用游戏的 Update* 改写本地态。
 */
import { sleep, todayStr } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { bus, EVT } from '../../core/bus.js';
import { game } from '../../core/game.js';
import { storage } from '../../core/storage.js';
import { l10n, gameData, gameConf } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { item } from '../../core/item.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ALLIANCE-BOSS） */
const log = createLog('ALLIANCE-BOSS');

/** @type {number} ResponseId.PUSH_ALLIANCE_BOSS(10435)，联盟机甲状态推送（游戏自己已刷新本地数据） */
const CMD_PUSH_ALLIANCE_BOSS = 10435;

/** @type {number} RequestId.ALLIANCE_BOSS_GET_INFO，主动查机甲全量信息 */
const CMD_GET_INFO = 1160;

/** @type {number} RequestId.ALLIANCE_BOSS_DONATE，捐献机甲碎片（count:0 为每日免费一枚） */
const CMD_DONATE = 1161;

/** @type {number} RequestId.MARCH_WORLD_POINT，世界地图行军；攻打机甲用 marchType=18 */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {number} MarchType.ALLIANCE_BOSS，老版单人攻打联盟机甲（抓包 #6742 实证；PvE 不参与跨服漂移） */
const MARCH_TYPE = 18;

/** @type {number} 机甲碎片道具 id（游戏 AllianceBossPanel._itemId 硬编码值） */
const ITEM_SHARD = 3200001;

/**
 * AllianceBossState 枚举（游戏侧数值实证）：-1 未开启 / 0 捐献中 / 1 战斗 / 2 检修 / 3 预约中 / 4 损毁
 * @type {object}
 */
const STATE = { NOT_OPEN: -1, DONATING: 0, FIGHTING: 1, REPAIR: 2, RESERVED: 3, BROKEN: 4 };

/** @type {number} DataConfig：每日可捐枚数上限（面板剩余 = 它 - todayTime，同游戏 _donateMaxCount） */
const CFG_KEY_DONATE_MAX = 25008;

/** @type {number} DataConfig：入盟时长门槛（与 JoinTime/ServerTime 同单位，这里原样复刻游戏的比较式，不假设单位） */
const CFG_KEY_JOIN_LIMIT = 25009;

/** @type {number} 免费捐与付费捐之间的间隔（毫秒）：同 cmd 连发会撞 NetMgr 频控 */
const DONATE_GAP_MS = 1200;

/** @type {number} 有活可干时的复查间隔（毫秒）：捐献进度/攻打窗口不会秒秒变 */
const BUSY_TICK_MS = 1000 * 60 * 3;

/** @type {number} 无事可干时的巡检间隔（毫秒）：等联盟推进到下一阶段 */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 状态自然翻转（预约→战斗、战斗→损毁）的唤醒余量（毫秒），避开服务器换态延迟 */
const STATE_FLIP_BUFFER_MS = 1000 * 30;

/** @type {number} 冷启动连续查不到时的退避间隔（毫秒）：本服/本联盟没玩这套时不每 15 分钟空发一次 1160 */
const COLD_BACKOFF_MS = 1000 * 60 * 60;

/** @type {string} storage.data 分片名：当日代捐计数与本轮攻打记账 */
const DAILY_STATE_NAME = 'allianceBoss.daily';

/**
 * 面板配置：
 *   donateRules=按「召唤所需碎片数」分段的代捐规则数组 [{from,to,count}]（to=0 不封顶，count=0 该段不捐），
 *   preset=攻击预设部队号（0=不攻打）
 * @type {{donateRules:Array<{from:number,to:number,count:number}>, preset:number}}
 */
var cfg = { donateRules: [{ from: 0, to: 0, count: 3 }], preset: 0 };

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} DataCenter.DATA（读 ServerTime 与 UserData 行军槽/入盟时间） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** 检查单飞闸门 / 触发合并 / 排程定时器（到点唤醒 / 慢查共用）均收口到 core/cycle（见下方 cycle 实例）。 */
/** @type {number} 连续冷启动补查（1160）失败次数，达 3 次后退到长间隔；查到即清零 */
var coldMisses = 0;

/**
 * 当日持久态：{ date:'YYYY-MM-DD', donated:{<bossId>:number}, attacked:{<bossId>:{ok:1}}, }
 * donated 按型号记「本机今日对该型号已代捐枚数」（含免费那枚）——同一天联盟可能换型号，
 * 记总成一个数会让新型号被旧型号的额度误判为已捐满；attacked 记「本机已对该型号成功发起过攻打」。
 * 读回完成前不落盘（内存 0 很可能是假象，整块写回会覆掉盘上真值），见 persistDaily。
 * @type {{date:string, donated:Object<string,number>, attacked:Object<string,object>}}
 */
var dailyState = { date: '', donated: {}, attacked: {} };
/** @type {boolean} 持久态是否已读回 */
var dailyStateLoaded = false;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 当日记账 ──────────────────────────────────────────────────────────

/**
 * 滚到今日（跨日自动归零）
 */
function rollToday() {
  var today = todayStr();
  if (dailyState.date !== today) {
    dailyState.date = today;
    dailyState.donated = {};
    dailyState.attacked = {};
  }
}

/**
 * 异步读回当日记账（每轮 run 调一次）。读失败不置 loaded：读不到 ≠ 盘上没数据，留给下次 run 重试。
 * @returns {Promise<void>}
 */
async function loadDaily() {
  try {
    var saved = await storage.data.get(DAILY_STATE_NAME);
    dailyStateLoaded = true;
    rollToday();
    if (saved && typeof saved === 'object' && saved.date === dailyState.date) {
      // 旧结构 donated 是单个数字，按型号记账后不再适用；非对象一律忽略（当日最多按规则重捐，服务器 25008 上限兜底）
      dailyState.donated = saved.donated && typeof saved.donated === 'object' ? saved.donated : {};
      dailyState.attacked =
        saved.attacked && typeof saved.attacked === 'object' ? saved.attacked : {};
    }
  } catch (err) {
    log.warn('daily state load failed, retry next run. %s', err && err.message);
  }
}

/**
 * 记账变更后落盘（写失败不阻断主流程），顺带推面板刷新只读字段
 */
function persistDaily() {
  if (dailyStateLoaded) {
    Promise.resolve(
      storage.data.set(DAILY_STATE_NAME, {
        date: dailyState.date,
        donated: dailyState.donated,
        attacked: dailyState.attacked,
      }),
    ).catch(function (err) {
      log.warn('daily state save failed.', err);
    });
  }
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 该型号本轮是否已攻打（本地记账，服务器无此口径）
 * @param {number} bossId 机甲型号 id
 * @returns {boolean}
 */
function hasAttacked(bossId) {
  rollToday();
  return !!(dailyState.attacked && dailyState.attacked[String(bossId)]);
}

/**
 * 标记某型号本轮已攻打
 * @param {number} bossId 机甲型号 id
 */
function markAttacked(bossId) {
  rollToday();
  dailyState.attacked[String(bossId)] = { ok: 1, at: Date.now() };
  persistDaily();
}

/**
 * 该型号今日已代捐枚数
 * @param {number} bossId 机甲型号 id
 * @returns {number}
 */
function donatedOf(bossId) {
  rollToday();
  return (dailyState.donated && dailyState.donated[String(bossId)]) | 0;
}

/**
 * 代捐成功后按型号累计并落盘
 * @param {number} bossId 机甲型号 id
 * @param {number} n 本次成功代捐枚数
 */
function bumpDonated(bossId, n) {
  rollToday();
  dailyState.donated[String(bossId)] = donatedOf(bossId) + (n | 0);
  persistDaily();
}

/**
 * 面板展示的「今日已代捐」：已捐 / 命中档位的目标枚数，尾部带上匹配键「需N」
 * （没有单独的「当前型号」行了，用户靠这个尾数校对区间填得对不对；值列窄，不留冗余词）
 * @returns {string}
 */
function formatTodayDonate() {
  if (!dailyStateLoaded) return '-';
  var snap = gameData.allianceBoss();
  if (!snap || !snap.bossId) return '-';
  var want = donateTarget(snap.bossId);
  if (!want.known) return '需数未取到';
  var need = ' · 需' + want.need; // known 已保证 need>0
  if (want.count <= 0) return (want.idx < 0 ? '未命中' : '该段不捐') + need;
  return donatedOf(snap.bossId) + ' / ' + want.count + need;
}

/**
 * 面板展示的「本轮攻打」：已打则给型号与时刻，否则提示未攻打
 * （值列只有一百多 px，不带「型号」二字、时刻到分，否则会被省略号截断）
 * @returns {string}
 */
function formatAttack() {
  if (!dailyStateLoaded) return '-';
  var keys = Object.keys(dailyState.attacked || {});
  if (!keys.length) return '未攻打';
  var last = keys[keys.length - 1];
  var rec = dailyState.attacked[last] || {};
  var t = rec.at ? new Date(rec.at) : null;
  return '已打 ' + last + (t ? ' · ' + t.toTimeString().slice(0, 5) : '');
}

// ── 本地数据与闸门 ────────────────────────────────────────────────────
/**
 * 当前服务器时间（秒）
 * @returns {number}
 */
function nowSec() {
  return +(dataCenter && dataCenter.ServerTime) || 0;
}

/**
 * 入盟时长闸门（老版 25009，秒）：JoinTime + 门槛 > ServerTime 即未到点，游戏弹 allianceMachine037。
 * 配置取不到（NaN）时按门槛 0 放行——宁可撞一次服务器拒绝，不因符号缺失静默停摆。
 * @returns {boolean} 是否放行
 */
function passJoinGate() {
  var u = (dataCenter && dataCenter.UserData) || {};
  var aid = u.Alliance && u.Alliance.Aid;
  if (!aid) return false;
  var limit = parseInt(String(gameConf.dataConfig(CFG_KEY_JOIN_LIMIT)), 10) || 0;
  var joinTime = Number(u.Alliance.JoinTime) || 0;
  if (joinTime + limit > nowSec()) {
    log.debug('join time not enough, skip. joinTime=%d;limit=%d', joinTime, limit);
    return false;
  }
  return true;
}

/**
 * 本地态是否已被 push/应答填充过（state 构造默认 -1 = 从未填充，与「本服没这玩法」同义，须主动问一次）
 * @param {object} snap gameData.allianceBoss() 快照
 * @returns {boolean}
 */
function localUninitialized(snap) {
  return !snap || snap.state < 0 || (!snap.bossId && !snap.pointSid);
}

/**
 * 型号目录行（Alliance_Boss[bossId]）：num=召唤所需碎片数（区间规则的匹配键，也是进度上限）
 * @param {number} bossId 机甲型号 id
 * @returns {object|null} 表行；未选型号/表未加载时 null
 */
function bossRow(bossId) {
  return bossId ? l10n.tableRow('Alliance_Boss', bossId) : null;
}

/**
 * 按区间规则算该型号的代捐目标：先取 Alliance_Boss[bossId].num，再取第一条命中的 [from,to)。
 * 命中不到（或 num 取不到）返回 count=0，即不捐。
 * @param {number} bossId 机甲型号 id
 * @returns {{need:number, count:number, known:boolean, idx:number}} need=召唤所需碎片数，idx=命中规则下标（-1 无命中）
 */
function donateTarget(bossId) {
  var row = bossRow(bossId);
  var need = row ? Number(row.num) || 0 : 0;
  // num 取不到（表行缺失/字段未填）时不猜档位：归到最低档按错档位猛捐比少捐一次贵得多
  if (need <= 0) return { need: 0, count: 0, known: false, idx: -1 };
  var rules = Array.isArray(cfg.donateRules) ? cfg.donateRules : [];
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i] || {};
    var from = r.from | 0;
    var to = r.to | 0;
    if (need >= from && (to <= 0 || need < to))
      return { need: need, count: r.count | 0, known: true, idx: i };
  }
  return { need: need, count: 0, known: true, idx: -1 };
}

/**
 * 捐献进度是否已满（exp >= Alliance_Boss[bossId].num，满了就等会长召唤，再捐是浪费碎片）
 * @param {object} boss {exp}
 * @param {number} need 该型号召唤所需碎片数（donateTarget 已取好，不重复查表）
 * @returns {boolean}
 */
function donateProgressFull(boss, need) {
  return need > 0 && Number(boss.exp) >= need;
}

/**
 * 是否还能打：战斗期(1) 与损毁期(4) 都可派兵（游戏 onFightClick 的 [1,4] 口径）。
 * 「只打一次」由本地记账保证，两期共用同一 bossId 键，故损毁期不会二次派兵。
 * @param {number} state 机甲状态
 * @returns {boolean}
 */
function isAttackable(state) {
  return state === STATE.FIGHTING || state === STATE.BROKEN;
}

/**
 * 该型号本轮还有没有捐的活（区间规则配了枚数且当日该型号未捐满）
 * @param {number} bossId 机甲型号 id
 * @returns {boolean}
 */
function hasDonateWork(bossId) {
  var t = donateTarget(bossId);
  return t.count > 0 && donatedOf(bossId) < t.count;
}

// ── 排程 ──────────────────────────────────────────────────────────────
/**
 * 距「状态自然翻转点」的建议唤醒延迟（毫秒）：
 *   预约中(3) → summonTime（推送里的 expireTime，会长预约的开启战斗时刻）到点进战斗；
 *   战斗期(1) → endTime 到点进损毁（若本轮还没打过，损毁期仍是可打窗口）。
 * @returns {number|null} 无可排时刻返回 null
 */
function flipDelayMs() {
  var snap = gameData.allianceBoss();
  if (!snap) return null;
  var at = 0;
  if (snap.state === STATE.RESERVED) at = snap.summonTime;
  else if (snap.state === STATE.FIGHTING && !hasAttacked(snap.bossId)) at = snap.endTime;
  if (!at) return null;
  var ms = (at - nowSec()) * 1000 + STATE_FLIP_BUFFER_MS;
  return ms > 0 ? Math.min(ms, IDLE_TICK_MS * 8) : null;
}

/**
 * 下一拍间隔：有活可干走慢查档；状态翻转点（summonTime/endTime）精准到点唤醒；
 * 其余退到巡检档，连续冷启动补查失败达 3 次（coldMisses）退到更长冷启档。决策留 feat，交 cycle 择时。
 * @returns {number} 毫秒
 */
function nextTickDelay() {
  var snap = gameData.allianceBoss();
  var working =
    (snap && snap.state === STATE.DONATING && hasDonateWork(snap.bossId)) ||
    (snap && isAttackable(snap.state) && cfg.preset > 0 && !hasAttacked(snap.bossId));
  var ms = working
    ? BUSY_TICK_MS
    : flipDelayMs() || (coldMisses >= 3 ? COLD_BACKOFF_MS : IDLE_TICK_MS);
  log.debug('next check in %d s', Math.round(ms / 1000));
  return ms;
}

/**
 * 单轮调和主体（core/cycle 承载单飞闸门 + 触发合并 + 绝不停摆）：跑一轮 tickBody → 返回下拍间隔。
 * 在飞期间攒下的 push（cycle.pending）优先立即补扫（状态翻转是权威信号，不该等整轮询），否则按 nextTickDelay 择档。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  await tickBody();
  if (cycle.pending) return 0;
  return nextTickDelay();
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取 IDLE_TICK_MS，防异常停摆） */
const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 旧 JSON 链路应答归一化：ret.data 通常是 JSON 串（游戏侧 JSON_PARSE(t.d)），兜底已是对象
 * @param {object} ret net.Ret
 * @returns {object|null} 解析后的业务数据；非对象返回 null
 */
function payloadOf(ret) {
  var d = ret && ret.data;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch (err) {
      return null;
    }
  }
  return d && typeof d === 'object' ? d : null;
}

/**
 * 发送一条旧 JSON 协议，异常与频控统一收成哨兵 Ret（调用方只看 ret.ok / ret.code）。永不 reject。
 * @param {number} cmd 命令号
 * @param {object} data 载荷
 * @returns {Promise<object>} net.Ret
 */
async function ask(cmd, data) {
  return net.sendGuarded(cmd, data, {
    onError: function (err) {
      log.debug('cmd %d send failed: %s', cmd, err && err.message);
    },
  });
}

/**
 * 由 allianceBoss 原始块拼归一化快照（字段名取推送/应答口径，与 AllianceBossData.updateData 一致）
 * @param {object} b 原始 allianceBoss 块
 * @returns {object|null} 归一化快照
 */
function normalizeBoss(b) {
  if (!b || typeof b !== 'object') return null;
  return {
    state: b.state | 0,
    bossId: b.bossId | 0,
    x: b.x | 0,
    y: b.y | 0,
    exp: Number(b.exp) || 0,
    hp: Number(b.hp) || 0,
    endTime: Number(b.endTime) || 0,
    summonTime: Number(b.expireTime) || 0,
    pointSid: b.pointSid | 0,
    help: b.help | 0,
  };
}

/**
 * 主动查机甲全量信息（1160）。todayTime/todayFree 只有这条链路给得准，见文件头「数据源分级」。
 * @returns {Promise<object|null>} {boss:归一化快照, todayTime, todayFree}；失败/无数据返回 null
 */
async function requestInfo() {
  var ret = await ask(CMD_GET_INFO, {});
  if (!ret.ok) {
    log.debug('get info not ok. code=%d', ret.code);
    return null;
  }
  var d = payloadOf(ret);
  var boss = d && normalizeBoss(d.allianceBoss);
  if (!boss) return null;
  return { boss: boss, todayTime: Number(d.todayTime) || 0, todayFree: Number(d.todayFree) || 0 };
}

/**
 * 捐献（1161）。count:0 = 每日免费一枚（不扣碎片），count:n = 扣 n 枚碎片。
 * 服务器业务拒绝可能仍回 s=0 而带 ret:0，故两个口径都要判。
 * @param {number} count 枚数（0 表示免费捐）
 * @returns {Promise<{ok:boolean, code:number, data:*}>} 归一化结果
 */
async function sendDonate(count) {
  var ret = await ask(CMD_DONATE, { count: count });
  var d = payloadOf(ret);
  var accepted = ret.ok && !(d && d.ret != null && Number(d.ret) !== 1);
  return { ok: accepted, code: ret.code, data: ret.data };
}

/**
 * 派兵攻打机甲统一走 core/march.attack（902，marchType=18）；载荷与「快捷攻击」同源（core/battle.js）。
 */

// ── 主流程 ────────────────────────────────────────────────────────────
/**
 * 单轮主体：本地态 → 冷启动补查 → 捐/打分流。永不 reject（cycle 另兜一层 fallback 防异常停摆）。
 * @returns {Promise<void>}
 */
async function tickBody() {
  var boss = gameData.allianceBoss();
  var info = null;
  if (!boss) {
    log.debug('alliance boss data unavailable (no Alliance in UserData?)');
    return;
  }

  // 主动补查（对应文件头「触发」）：加载时多半已错过 push，本地是构造默认值 → 问一次全量，纯当数据用（不回写游戏本地）
  if (localUninitialized(boss)) {
    info = await requestInfo();
    if (!aliveFn()) return;
    if (!info) {
      coldMisses++;
      log.debug(
        'cold start 1160 got nothing (miss #%d), maybe this server has no alliance boss',
        coldMisses,
      );
      return;
    }
    coldMisses = 0;
    boss = info.boss;
    log.debug('local data cold, fetched by 1160. state=%d;bossId=%d', boss.state, boss.bossId);
  } else {
    coldMisses = 0;
  }

  if (boss.state === STATE.DONATING) {
    await donateFlow(boss, info);
  } else if (isAttackable(boss.state)) {
    await attackFlow(boss);
  } else {
    log.debug('state %d not actionable (bossId=%d)', boss.state, boss.bossId);
  }
}

/**
 * 捐献流程：区间规则定目标 → 闸门 → 1160 取今日已捐/免费标记 → 免费那枚先捐 → 余下按枚数扣碎片，碎片不足本轮放弃。
 * @param {object} boss 归一化本地/应答快照
 * @param {object|null} preloaded 本轮已查过的 1160 结果（冷启动路径复用，省一次发包）
 * @returns {Promise<void>}
 */
async function donateFlow(boss, preloaded) {
  var t = donateTarget(boss.bossId);
  if (!t.known) {
    log.debug('Alliance_Boss row / num unavailable, skip donate. bossId=%d', boss.bossId);
    return;
  }
  if (t.count <= 0) {
    log.debug(
      'no donate rule hits num=%d. bossId=%d;rules=%d',
      t.need,
      boss.bossId,
      (cfg.donateRules || []).length,
    );
    return;
  }
  if (!passJoinGate()) return;
  var done = donatedOf(boss.bossId);
  if (done >= t.count) {
    log.debug('daily donate count reached for this model (%d/%d), skip', done, t.count);
    return;
  }
  if (donateProgressFull(boss, t.need)) {
    log.info(
      'donate progress full, wait for summon. exp=%d need=%d bossId=%d',
      boss.exp,
      t.need,
      boss.bossId,
    );
    return;
  }

  var info = preloaded || (await requestInfo());
  if (!aliveFn() || !info) return;

  var limit = parseInt(String(gameConf.dataConfig(CFG_KEY_DONATE_MAX)), 10) || 0;
  var serverRemain = limit > 0 ? Math.max(0, limit - (info.todayTime | 0)) : t.count | 0;
  if (serverRemain <= 0) {
    log.info('server donate quota used up today. todayTime=%d limit=%d', info.todayTime, limit);
    return;
  }

  var plan = Math.min(t.count - done, serverRemain);

  // 免费捐：每日首枚不扣碎片（count:0），先把它捐掉——碎片不够的日子也不能白丢这一枚进度
  if (info.todayFree > 0 && plan > 0) {
    var freeRet = await sendDonate(0);
    if (!aliveFn()) return;
    if (freeRet.ok) {
      bumpDonated(boss.bossId, 1);
      plan -= 1;
      log.info('free donate ok. todayTime=%d;donated=%d', info.todayTime, donatedOf(boss.bossId));
    } else {
      log.info('free donate rejected (already used?). code=%d;data=%s', freeRet.code, freeRet.data);
    }
    if (plan <= 0) return;
    await sleep(DONATE_GAP_MS); // 同 cmd 连发会撞频控
    if (!aliveFn()) return;
  }

  // 付费捐：其余从背包扣，不够就本轮放弃（不做部分捐赠）
  var have = item.amount(ITEM_SHARD);
  if (have < plan) {
    log.debug('shard not enough, give up this round. need=%d;have=%d', plan, have);
    return;
  }

  var paid = await sendDonate(plan);
  if (!aliveFn()) return;
  if (paid.ok) {
    bumpDonated(boss.bossId, plan);
    log.info(
      'donate ok. count=%d;bossId=%d;num=%d;shard %d->%d;left=%d',
      plan,
      boss.bossId,
      t.need,
      have,
      item.amount(ITEM_SHARD),
      donateLeft(boss.bossId),
    );
  } else {
    log.info('donate rejected. count=%d;code=%d;data=%s', plan, paid.code, paid.data);
  }
}

/**
 * 该型号今日剩余应捐枚数（本地规则口径，非服务器口径）；面板已改用「已捐 / 目标」直读，现只给日志用
 * @param {number} bossId 机甲型号 id
 * @returns {number}
 */
function donateLeft(bossId) {
  return Math.max(0, donateTarget(bossId).count - donatedOf(bossId));
}

/**
 * 规则数组钳制：负值归 0、枚数上限 99；非法项丢弃。
 * to<=from 的非零上界是空集（用户手滑），保留原值让它自然不命中——静默改成「不封顶」会把一小额度捐成天坑。
 * @param {*} list 面板传来的规则数组
 * @returns {Array<{from:number,to:number,count:number}>}
 */
function normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || typeof r !== 'object') continue;
    out.push({
      from: Math.max(0, r.from | 0),
      to: Math.max(0, r.to | 0),
      count: Math.min(99, Math.max(0, r.count | 0)),
    });
  }
  return out;
}

/**
 * 攻打流程：闸门（预设/入盟/地块归属/坐标/记账/本轮已打）→ 行军槽 → 构造部队 → 派 902，成功发起一次即收手。
 * @param {object} boss 归一化快照
 * @returns {Promise<void>}
 */
async function attackFlow(boss) {
  if (cfg.preset <= 0) return;
  if (!passJoinGate()) return;
  if (hasAttacked(boss.bossId)) {
    log.debug(
      'already attacked this boss today, skip. bossId=%d;state=%d',
      boss.bossId,
      boss.state,
    );
    return;
  }
  if (!(boss.x > 0 && boss.y > 0)) {
    log.debug('boss has no tile yet, skip. state=%d', boss.state);
    return;
  }

  var u = (dataCenter && dataCenter.UserData) || {};
  // 机甲地块不在本服（跨服 KVK 期间会长可能在别的服召唤）：拿它的 x/y 发 902 会打到同坐标的无关地块。
  // 游戏只在 isKVKOpen() 时比 PointSid == UserData.ServerId，这里无条件比（非 KVK 时本来就相等，只会更严不会误打）。
  var serverId = u.ServerId | 0;
  if (serverId && boss.pointSid && boss.pointSid !== serverId) {
    log.debug('boss tile not on my server, skip. pointSid=%d;serverId=%d', boss.pointSid, serverId);
    return;
  }
  if (!march.canMarch()) {
    log.debug('no free march slot, wait next check.');
    return;
  }
  if (net.isSending(CMD_MARCH_WORLD_POINT)) return;

  // 预设部队 → armyListNew/heroList/trapList/formationV2/extraArmy（已按可派额度与军阵状态过滤）
  var plan = new Battle().plan().preset(cfg.preset).adjust().build();
  if (!plan.armyListNew.length) {
    log.debug('preset %d has no dispatchable army, skip. bossId=%d', cfg.preset, boss.bossId);
    return;
  }

  var ret = await march.attack({
    marchType: MARCH_TYPE,
    target: { x: boss.x, y: boss.y },
    data: plan,
  });
  if (!aliveFn()) return;

  if (ret.ok) {
    // 一次即收：不论战斗期还是损毁期，同一型号当日只成功发起一次
    markAttacked(boss.bossId);
    log.info(
      'attack sent. bossId=%d;state=%d;preset=%d;armies=%d;x=%d;y=%d',
      boss.bossId,
      boss.state,
      cfg.preset,
      plan.armyListNew.length,
      boss.x,
      boss.y,
    );
  } else {
    // 被拒不落账：多半是行军槽/体力/服务器换态瞬间的时序问题，下轮再补；持续失败由慢查档自然收敛
    log.info(
      'attack rejected. bossId=%d;x=%d;y=%d;code=%d;data=%s',
      boss.bossId,
      boss.x,
      boss.y,
      ret.code,
      ret.data,
    );
  }
}

/**
 * 注入模块配置：面板区间规则数组 + 预设部队下拉（非法项丢弃，改值下一轮检查即生效）
 * @param {object} partial { donateRules:Array, preset:number }（toModuleCfg 产出）
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  if (Array.isArray(partial.donateRules)) cfg.donateRules = normalizeRules(partial.donateRules);
  if (typeof partial.preset === 'number')
    cfg.preset = partial.preset >= 0 && partial.preset <= 8 ? partial.preset | 0 : 0;
  return cfg;
}

/**
 * 安装：取网络底座 + 数据中心。任一缺失即失败（reactor 不会激活）。
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
 * 运行：读回当日记账 → 订阅 push 10435 → 立即查一次（错过通知的补位，后续由 cycle 择时重排）。
 * pause 后 alive()=false，cycle 自然停摆；resume 重新订阅并再 kick 一轮。
 * @param {object} ctx reactor 上下文
 */
async function run(ctx) {
  ctxRef = ctx;
  log.info(
    'started;marchType=%d;donateRules=%d;preset=%d',
    MARCH_TYPE,
    (cfg.donateRules || []).length,
    cfg.preset,
  );

  await loadDaily();
  if (!aliveFn()) return;

  // pause 已摘掉上轮的订阅，这里每次激活重挂一次（不设幂等标记，否则 resume 后收不到通知）
  ctx.on.push(CMD_PUSH_ALLIANCE_BOSS, function (ev) {
    log.debug(
      'push 10435 arrived. state=%s',
      ev && ev.data && ev.data.allianceBoss && ev.data.allianceBoss.state,
    );
    cycle.kick();
  });

  cycle.kick(); // 首个 tick 立即跑：加载时多半已错过捐献/开打通知
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap），战斗模式暂停；
 * 面板带「召唤所需碎片数 → 代捐枚数」的可增删区间规则 + 攻击预设选择器（0-8）+ 只读态展示；
 * 间隔/上限/道具 id 等均为本文件内置常量（CFG_KEY_* / ITEM_SHARD / *_TICK_MS）。
 */
reactor.register({
  id: 'allianceBoss',
  label: '联盟机甲',
  storageKey: 'pocketcc.feat.allianceBoss',
  symbols: ['dataCenter', 'tableManager', 'tableUtils'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: {
    enabled: false,
    // 默认一条兵底规则（[0, 不封顶) → 3 枚，含每日免费那枚），不捐就改成 0 枚或删行
    donateRules: [{ from: 0, to: 0, count: 3 }],
    preset: 0, // 攻打预设队号 0-8，0=不攻打
  },
  fields: (function () {
    var options = [{ value: 0, label: '不攻打' }];
    for (var i = 1; i <= 8; i++) options.push({ value: i, label: '预设部队 ' + i });
    return [
      {
        key: 'donateRules',
        label: '代捐档位',
        section: '捐献碎片',
        type: 'ranges',
        // 行已按区间记法渲染「[ 0 ~ 300 ) → 3」，列头只需说出两个比较符；限 4 字以免折行
        cols: ['大于等于', '小于', '代捐枚数'],
        hint: '按召唤所需碎片数分档', // 10 个全角字≈110px，单行；「0 = 不封顶」已放进各格 title
      },
      {
        key: 'todayDonate',
        label: '今日已代捐',
        section: '捐献碎片',
        type: 'text',
        get: function () {
          return formatTodayDonate();
        },
      },
      {
        key: 'shardOwned',
        label: '碎片持有',
        section: '捐献碎片',
        type: 'text',
        get: function () {
          return String(item.amount(ITEM_SHARD));
        },
      },
      { key: 'preset', label: '攻击部队', section: '攻打', type: 'select', options: options },
      {
        key: 'attackState',
        label: '本轮攻打',
        section: '攻打',
        type: 'text',
        get: function () {
          return formatAttack();
        },
      },
    ];
  })(),
  toModuleCfg: function (c) {
    return { donateRules: normalizeRules(c.donateRules), preset: c.preset | 0 };
  },
  install: install,
  configure: configure,
  run: run,
});
