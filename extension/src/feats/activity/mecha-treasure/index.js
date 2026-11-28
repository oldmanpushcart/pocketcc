/**
 * 重装母舰宝藏-自动攻打世界使徒（reactor 说明书形态）
 *
 * 活动即「重装母舰宝藏」（ActivityShowUIType.pinkMechaTreasure，type=292），限时开档。玩法链路：
 *   抽奖（8800）打盘面 boss → boss 被击杀后在大世界刷出「重装母舰使徒」瓦片（pointType=203）
 *   → 同匹配组内其他指挥官可派一条零部队行军攻击该使徒，领取一份随机奖励（每个使徒同一指挥官只能打 1 次）
 *   → 奖励由服务端直接走邮件下发（mail_title_3289「攻击重装母舰使徒奖励」），没有任何领奖请求。
 * 本 feat 只做这条「攻打世界使徒领奖」链路：不抽奖（消耗抽券，属资源支出）、不领 8801 进度奖励。
 *
 * 网络一律走 reactor 注入的 ctx.net（promise 封装）：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>，isSending(cmd) 查在途。
 *
 * 三条协议（实录报文实证）：
 *   1) req sendPBV2 8802（PINK_MECHA_MONSTER_LIST）{aid, type}：type=1 → data.myMonsters（我自己发现的），
 *      type=2 → data.worldMonsters（世界使徒）。本 feat 只用 type=2。条目形态
 *      {uid:string, x, y, uuid:string, serverId, frameId, playerInfo, expireMilli:Int64(毫秒), hasMarch}。
 *   2) req send 902（MARCH_WORLD_POINT）{isAirCraftCarrier:true, marchType:189, x, y} → 攻打该坐标使徒，应答带 marchInfo。
 *      与海上夺宝/领域寻宝挖矿同为「零部队」派遣，不带 armyList/heroList；多出的 isAirCraftCarrier 是活动专属顶层标记键，
 *      走 core/march.pickUp 的 bodyExtra 透传，保持与录制报文逐键一致。
 *   3) push 10912（PUSH_ONE_ACTIVITYEXTRA，载荷 {aid,extra}）：活动 extra 更新。extra 关键位
 *      worldUIRed（世界有可打使徒的红点，实证攻击前=1、攻击后=0）、attackMonsterIds（我已攻打过的使徒 uuid 串数组，服务端权威）、
 *      groupId（我的匹配组，跨组攻击会被拒）。
 *
 * 四条游戏侧闸门（WorldMechaTreasureBossPop.onAttackBtnClick，逐条抄成脚本判据）：
 *   a) extra.attackMonsterIds 含该 uuid → 已打过；b) uid === UserData.UID → 不能打自己发现的（backup_mecha_lottery_11）；
 *   c) 瓦片 groupId !== extra.groupId → 跨匹配组不可打（-12）；d) 我已有 marchType=189 且同 target_tx/ty 的行军 ≥1 条
 *      → 被拒并提示「每个使徒只能被同一指挥官攻击 1 次」（-21）。
 *   注：8802 的 worldMonsters 条目不带 groupId（游戏是拿瓦片 extData 比对的），c) 这条脚本无法在发送前校验，
 *   依赖「服务端只下发本组使徒」+ 被拒后本地拉黑兜住。
 *
 * 生产端三个触发源（同海上夺宝口径）：
 *   1) 推送 10912（按 aid 认出本活动 + extra.worldUIRed>=1）；2) run() 启动即主动扫一次；
 *   3) 兜底定时（active/idle 两档，连续空扫降频）防漏推；外加 10019 本人行军到家补扫。
 *   触发一律汇入 cycle.kick（core/cycle 调和循环）：一轮在飞时只置 pending，本轮结束后补扫一次（多条推送合并成一次）。
 *   生产 doScan：找活动 → 拉 8802 type=2 → 过滤可攻打使徒 → 整批替换 queue → 交消费。
 *   消费 consume（并入 cycleRun 的一轮）：逐条 shift → attackFlow 派 902 → 每条间 sleep(marchInterval)。
 *   去重双保险：服务端权威 extra.attackMonsterIds + 本地影子集 dispatched（发出即计入）/rejected（被拒即拉黑，防逐拍重发刷屏）。
 *   零部队行军不占用全局行军队列上限（与 178 同口径），故无名额闸门（不引入 canMarch）；仅逐条间限流防 902 被服务器限流。
 *
 * 生命周期由 reactor 托管：install/run 两个钩子，places 门控限定 base/world（Home/NWorldMap），战斗模式强制下线。
 *   消费逐条派遣的限流逻辑不套 createDrain，作为 cycleRun 一轮的后半段原样保留在本文件。
 *   兜底定时器（active/idle 两档）由 cycle 承载，pause 后 alive()=false 自然停摆，resume 时 run 复位状态并重新点火
 *   （dispatched/rejected 不随 run 清空，防 resume 后重复攻打同一使徒）。
 *
 * 当日次数口径（定稿）：行军类计**奖励到账**（非派遣受理）——使徒奖励邮件经 push 10264 PUSH_SINGLE_MAIL
 *   实时下发（报文实证 dashcam store 全量扫描 .reviewtmp/daily-mail-probe.mjs），标题字面匹配
 *   mail_title_3289「【重装母舰宝藏】攻击重装母舰使徒奖励」，按邮件 id 去重 countOnce（跨页重推不重计），
 *   core/daily-stats 日账跨页持久；无分母文案「今日 N 次」，未读回前显示 '—'。
 */
import { CODE_NOT_SENT, sleep, parseData } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { march } from '../../../core/march.js';
import { createCycle } from '../../../core/cycle.js';
import { createDailyLedger, dailyText } from '../../../core/daily-stats.js';
import { activityHub } from '../../../core/activity-hub.js';

import {
  CMD_MONSTER_LIST,
  CMD_MARCH_WORLD_POINT,
  CMD_USER_MARCH_INFO,
  PUSH_SINGLE_MAIL,
} from './constants.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MECHA-TREASURE） */
const log = createLog('MECHA-TREASURE');

/**
 * 重装母舰宝藏活动 showUiType（来源：GameDefine.ActivityShowUIType.pinkMechaTreasure，
 * 与报文 3103 应答 showUiType 字段同值；与 CHIP_BLESSING/海上夺宝 同口径——枚举值等于键名字符串）
 * @type {string}
 */
const SHOW_UI_TYPE_MECHA_TREASURE = 'pinkMechaTreasure';

/** @type {number} 8802 的 type：1=我发现的使徒（myMonsters），2=世界使徒（worldMonsters）。本 feat 只拉 2 */
const MONSTER_LIST_TYPE_WORLD = 2;

/**
 * 行军类型：攻打重装母舰使徒。
 * 定义：NWorldMapMarchCommon.NMarchType.MECHA_TREASURE_BOSS = 189（WorldMapCommon 同值）
 * @type {number}
 */
const MARCH_TYPE = 189;

/**
 * 使徒奖励邮件标题字面（字典表 mail_title_3289；10264 推送的邮件本体 title 字段逐字匹配）
 * @type {string}
 */
const REWARD_MAIL_TITLE = '【重装母舰宝藏】攻击重装母舰使徒奖励';

/** @type {import('../../../core/daily-stats.js').DailyLedger} 当日到账日账（行军类计奖励到账：10264 邮件按 id 去重） */
const rewardLedger = createDailyLedger('pocketcc.daily.mechaTreasure');

/**
 * 内置调优常量（面板仅出启用开关，不暴露这些间隔）
 * @type {object}
 */
const cfg = {
  /**
   * 活跃扫描间隔：默认1分钟。本轮扫描发现可攻打使徒时用这档，勤扫趁使徒未「潜逃」多打
   */
  activeScanInterval: 1000 * 60,

  /**
   * 空转扫描间隔：默认10分钟。连续 EMPTY_STREAK_IDLE 次扫描都没使徒后降到这档，少刷 8802。
   * 推送 10912 仍是主触发源，新使徒一刷出即被推醒，不必等这档定时
   */
  idleScanInterval: 1000 * 60 * 10,

  /**
   * 攻打间隔：默认5秒（消费逐条之间的休眠）。902 过快会被服务器限流，逐条之间休眠规避
   */
  marchInterval: 1000 * 5,
};

/** @type {number} 连续这么多次扫描都没使徒，才把扫描间隔从 active 降到 idle（去抖：单次漏扫不立即降频） */
const EMPTY_STREAK_IDLE = 2;

/** @type {number} 10019 到家补扫的最小间隔（毫秒）：合并一场行军的多条状态推送，避免 8802 突发 */
const PUSH_SCAN_MIN_GAP = 1000 * 3;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让定时器与在飞流程自然退出 */
var ctxRef = null;
/** @type {function():void|null} hub 引用计数 detach（pause 释放） */
var detachHub = null;
/** @type {function():void|null} hub 活动变化退订（pause 释放） */
var unwatchHub = null;

/** @type {object[]} 本轮扫描过滤出的可攻打使徒（[{uuid,x,y,uid,expireAt}]），consume 逐条 shift */
var queue = [];
/** @type {number} 连续空扫计数：发现使徒即清零，达到 EMPTY_STREAK_IDLE 转 idle 间隔 */
var emptyStreak = 0;
/** @type {Set<string>} 本地影子「已发出攻打」的使徒 uuid：服务端 attackMonsterIds 要等行军结算才带上，这段窗口靠它挡重复派 */
var dispatched = new Set();
/** @type {Set<string>} 被服务器拒过的使徒 uuid：本会话不再重发（同一目标重发只会逐拍刷屏，且原因不会自己变好） */
var rejected = new Set();
/** @type {number} 上次因 10019 到家补扫的时刻（ms），用于 PUSH_SCAN_MIN_GAP 去抖 */
var lastPushScanAt = 0;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/**
 * Int64 → number。expireMilli 运行时是游戏 Int64 实例（报文序列化后是 {_low,_high}），
 * 优先用游戏自带的 toNumber()，回落高低位无符号拼装（实证 {_high:417,_low:396012568} = 1791397375000 毫秒）。
 * 不可解析一律回 0（调用方按「无到期信息」处理，不因为读不懂就误判过期）。
 * @param {*} v Int64 实例 / {_low,_high} / 数字 / 数字串
 * @returns {number}
 */
function int64ToNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v === 'object') {
    if (typeof v.toNumber === 'function') {
      try {
        return Number(v.toNumber()) || 0;
      } catch (e) {
        /* 落到高低位拼装 */
      }
    }
    var hi = Number(v._high != null ? v._high : v.high);
    var lo = Number(v._low != null ? v._low : v.low);
    if (isFinite(hi) && isFinite(lo)) return (hi >>> 0) * 4294967296 + (lo >>> 0);
    return 0;
  }
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

/**
 * 对象安全展开（拒绝日志用，避免 [object Object] 丢掉服务器给的原因）
 * @param {*} v 任意值
 * @returns {string}
 */
function safeStringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

/**
 * 单轮调和主体（core/cycle 承载单飞闸门 + 触发合并 + 绝不停摆）：生产 doScan → 消费 consume → 返回下拍间隔。
 * 决策仍归本 feat：在飞期间攒下触发（cycle.pending）优先立即补扫，否则按 emptyStreak 选 active/idle 两档。
 * @returns {Promise<number>}
 */
async function cycleRun() {
  await doScan();
  if (!aliveFn()) return 0; // pause 中途：consume 不再进入，cycle 在 alive 检查处自然停摆
  await consume();
  if (cycle.pending) return 0;
  return nextScanInterval();
}

/** @type {{kick: function(), pending: boolean}} 调和循环驱动器（fallback 取 active 档，防异常停摆） */
const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.activeScanInterval,
});

/**
 * 生产端：找活动 → 拉 8802 type=2 → 过滤可攻打使徒 → 整批替换 queue → 交消费。永不 reject。
 * @returns {Promise<void>}
 */
async function doScan() {
  try {
    // 活动并未开启（限时活动，窗口外对 8802 发请求只会被拒）：清空队列，交下拍兜底，算一次空扫
    var activity = getMechaTreasureActivity();
    if (!activity) {
      log.debug('no activity found.');
      queue.length = 0;
      emptyStreak++;
      return;
    }

    // 在途闸门（游戏面板也在拉同一 cmd）：不静默断链，本轮跳过，由下拍兜底定时补
    if (net.isSending(CMD_MONSTER_LIST)) {
      log.debug('8802 in flight, skip this round.');
      return;
    }

    var ret = await net.sendPBV2(CMD_MONSTER_LIST, {
      aid: activity.id,
      type: MONSTER_LIST_TYPE_WORLD,
    });
    if (!aliveFn()) return;

    if (!ret.ok || !ret.data) {
      log.info(
        'monster list rejected. activityId=%d;code=%d;data=%s',
        activity.id,
        ret.code,
        safeStringify(ret.reason || ret.data),
      );
      queue.length = 0;
      emptyStreak++;
      return;
    }

    var monsters = filterMonsters(activity, ret.data.worldMonsters || []);
    if (!monsters.length) {
      log.debug('no attackable monster. total=%d', (ret.data.worldMonsters || []).length);
      queue.length = 0;
      emptyStreak++;
      return;
    }

    // 每轮 8802 是全量快照，整批替换队列（追加会累积重复使徒）
    queue = monsters;
    emptyStreak = 0;
    log.debug(
      'monsters loaded. count=%d;raw=%d',
      queue.length,
      (ret.data.worldMonsters || []).length,
    );
  } catch (err) {
    log.warn('scan error.', err);
    queue.length = 0;
    emptyStreak++;
  }
}

/**
 * 过滤可攻打的世界使徒（四条闸门里能在列表侧判的都判掉）：
 *   不打自己发现的（uid 与我相同，一律 String 比对——64 位 uid 走 Number 会丢精度）、
 *   不打已过期/即将潜逃的（expireMilli 毫秒 ≤ 服务器钟）、
 *   服务器标注 hasMarch 的（该使徒已有行军在场）、
 *   打过/发过/被拒过的（extra.attackMonsterIds ∪ 本地 dispatched ∪ 本地 rejected）。
 * @param {object} activity 活动信息（读它的 extra.attackMonsterIds 作权威已攻打集）
 * @param {object[]} list 8802 应答里的 worldMonsters
 * @returns {object[]} 归一化使徒（[{uuid,x,y,uid,expireAt}]）
 */
function filterMonsters(activity, list) {
  var extra = (activity && activity.extra) || {};
  var attacked = Array.isArray(extra.attackMonsterIds) ? extra.attackMonsterIds : [];
  var myUid = String(gameData.myPid() || '');
  var nowMs = (gameData.serverTime() | 0) * 1000;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (!m || m.uuid == null) continue;
    var uuid = String(m.uuid);
    if (!m.x && !m.y) continue; // 无坐标（-1/-1 之类未落地形态）不打
    if (myUid && String(m.uid) === myUid) continue; // 闸门 b：不能打自己发现的
    if (m.hasMarch === true) continue; // 服务器已标注该使徒有在途行军
    if (
      attacked.some(function (u) {
        return String(u) === uuid;
      })
    )
      continue; // 闸门 a：服务端权威已攻打
    if (dispatched.has(uuid) || rejected.has(uuid)) continue; // 本地影子已攻打 / 已拉黑
    var expireAt = int64ToNumber(m.expireMilli);
    if (expireAt > 0 && expireAt <= nowMs) continue; // 已潜逃
    out.push({
      uuid: uuid,
      x: m.x | 0,
      y: m.y | 0,
      uid: String(m.uid == null ? '' : m.uid),
      expireAt: expireAt,
    });
  }
  return out;
}

/**
 * 消费端（作为 cycleRun 一轮的后半段）：串行消费队列，每条之间休眠 marchInterval（队列空则不空等）。
 * @returns {Promise<void>}
 */
async function consume() {
  while (queue.length && aliveFn()) {
    var item = queue.shift();
    try {
      await attackFlow(item);
    } catch (err) {
      log.warn('attack flow threw.', err);
    }
    if (queue.length && aliveFn()) {
      await sleep(cfg.marchInterval, ctxRef && ctxRef.signal);
    }
  }
}

/**
 * 下一轮兜底扫描间隔：连续空扫达到 EMPTY_STREAK_IDLE 次 → idle 长间隔（降频空转），否则 active 短间隔。
 * 发现使徒会把 emptyStreak 清零（doScan），从而回到 active 档
 * @returns {number} 毫秒
 */
function nextScanInterval() {
  return emptyStreak >= EMPTY_STREAK_IDLE ? cfg.idleScanInterval : cfg.activeScanInterval;
}

/**
 * 单条攻打流程：检查目标是否已有在途行军 → 有则跳过 → 无则派 902 → 打一条结果日志。永不 reject。
 * 与海上夺宝同为「零部队」派遣，多出活动专属标记 isAirCraftCarrier:true（走 march.pickUp 的 bodyExtra 透传），无出征消耗。
 * 日志单一出口在这里：一次攻打只打一条（成功 info、被拒 info、已有行军/在途 debug）。
 * @param {object} item 使徒 {uuid,x,y,uid,expireAt}
 * @returns {Promise<void>}
 */
async function attackFlow(item) {
  // 闸门 d：同一使徒同一时间只能有我一条 189 行军（已在途中则跳过，等这条结束再由下轮补打）
  if (await hasMarchAtTarget(item.x, item.y)) {
    log.debug(
      'target already has march in flight, skip. uuid=%s;x=%d;y=%d',
      item.uuid,
      item.x,
      item.y,
    );
    return;
  }

  var ret = await marchAttack(item);
  if (!aliveFn()) return;

  if (ret.ok) {
    dispatched.add(item.uuid);
    log.info('attack march started. uuid=%s;x=%d;y=%d', item.uuid, item.x, item.y);
    return;
  }

  // 未真正发出（902 在途/异常）：不拉黑，下轮自愈
  if (ret.code === CODE_NOT_SENT) {
    log.debug('attack march not sent. uuid=%s', item.uuid);
    return;
  }

  // 可预期的业务拒绝（跨组/已被抢/时序竞争）：当日拉黑，同一目标重发不会自己变好，只会被拒刷屏
  rejected.add(item.uuid);
  log.info(
    'attack march rejected. uuid=%s;x=%d;y=%d;code=%d;data=%s',
    item.uuid,
    item.x,
    item.y,
    ret.code,
    safeStringify(ret.reason || ret.data),
  );
}

/**
 * 检查目标坐标 (x,y) 是否已被我的行军占用（同 marchType=189 且目标坐标匹配）。
 * 口径走 core/march.list()（封装 856 本人全量行军，视口无关、Home 亦有）；不读 mapData.marches（Home 读空会误判没占而重复派）。
 * 856 已是本人，无需再过滤 uid。
 * @param {number} x 目标 x
 * @param {number} y 目标 y
 * @returns {Promise<boolean>}
 */
async function hasMarchAtTarget(x, y) {
  var marches = await march.list();
  return marches.some(function (m) {
    return m.type === MARCH_TYPE && m.target.x === x && m.target.y === y;
  });
}

/**
 * 派兵攻打使徒（902 行军）。永不 reject：闸门未放开 / 发送异常都回落到 CODE_NOT_SENT 的哨兵 Ret。
 * 零部队 body 为四键 {isAirCraftCarrier:true, marchType:189, x, y}（与录制报文逐键一致），
 * isAirCraftCarrier 由 core/march.pickUp 的 bodyExtra 合并进三键分支。
 * @param {object} item 使徒 {uuid,x,y}
 * @returns {Promise<object>} 整个 902 的 Ret，code=902 状态码，data=成功载荷或 null
 */
async function marchAttack(item) {
  if (!item || net.isSending(CMD_MARCH_WORLD_POINT)) {
    return net.Ret.from(CODE_NOT_SENT, null);
  }
  return march.pickUp({
    marchType: MARCH_TYPE,
    target: { x: item.x, y: item.y },
    bodyExtra: { isAirCraftCarrier: true },
  });
}

/**
 * hub 订阅回调：重装母舰的 extra 变化、且 worldUIRed >= 1（确认世界有可打使徒）才触发扫描。
 * 10912 任何活动的 extra 更新都会进 hub，故先由 watch 的 match 认出本活动，再验红点位。
 * @param {object} activity hub 合并后的活动对象
 */
function onActivityChange(activity) {
  if (!aliveFn()) return;
  var extra = activity && activity.extra;
  var hasMonster = extra && extra.worldUIRed && extra.worldUIRed >= 1;
  if (!hasMonster) {
    return;
  }
  log.info('activity extra push received, trigger scan. aid=%s', activity.id);
  cycle.kick();
}

/**
 * 10019 本人行军推送入口：只关心「本玩法行军到家」这一跃迁——打完一条即补扫一轮，趁同批其他使徒未过期接着打。
 * 到家推送按 PUSH_SCAN_MIN_GAP 去抖（一场行军会连推多条状态）。
 * @param {object} ev net.on 事件 {cmd, data}
 */
function onMarchUpdate(ev) {
  if (!aliveFn()) return;
  var m = march.decode(ev && ev.data);
  if (!m || m.type !== MARCH_TYPE || m.state !== march.State.ARRIVED_HOME) return;
  var now = Date.now();
  if (now - lastPushScanAt < PUSH_SCAN_MIN_GAP) return;
  lastPushScanAt = now;
  cycle.kick();
}

/**
 * 10264 单封邮件推送：标题命中使徒奖励即按邮件 id 去重计一次到账（行军类计奖励到账口径）。
 * 载荷容错：parseData 拆可能串化的业务体；net 已剥 pbAckV2 信封，ev.data 即邮件对象本身
 *   （1115/1116 实录 240 包 title/sendTime 均在顶层，无 mail/data 包装，不再多层探针）。
 * listener 本身永不 throw；不踢扫描 cycle（到账只是计数，不影响攻打调度）。
 * @param {object} ev net.on 事件 {cmd, data}
 */
function onRewardMailPush(ev) {
  if (!aliveFn()) return;
  var d = parseData(ev && ev.data);
  if (!d || typeof d !== 'object') return;
  var m = d;
  if (!m || m.title !== REWARD_MAIL_TITLE) return;
  // Int64 邮件 id 按字符串读；无 id 时退 sendTime 合成键，同封重推仍可去重
  var id = String(m.id || m.mailId || '');
  if (!id) id = 't' + (Number(m.sendTime) || 0);
  if (rewardLedger.countOnce(id, 'arrive')) {
    log.info('cmd 10264 reward mail arrived. mailId=%s', id);
  }
}

/**
 * 从 hub 快照获取重装母舰宝藏活动（要求仍在开启期——对已结束的活动发 8802/902 只会被拒）。
 * 在期判定用快照自带的 begintime/endtime（841 权威）与服务器时间；时间不可用则放行（被拒无害）。
 * @returns {object|undefined}
 */
function getMechaTreasureActivity() {
  var activity = activityHub.getByUiType(SHOW_UI_TYPE_MECHA_TREASURE);
  if (!activity) return undefined;
  var now = gameData.serverTime();
  if (now && activity.begintime && activity.begintime > now) return undefined;
  if (now && activity.endtime && activity.endtime <= now) return undefined;
  return activity;
}

/**
 * 安装：只验证网络底座可用（活动快照归 activity-hub，游戏侧符号依赖由 symbols 在 install 前自检）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) {
    return true;
  }

  net = ctx.net;
  if (!net.install()) {
    net = null;
    log.warn('install failed: pocketcc.net unavailable.');
    return false;
  }

  installed = true;
  log.info('installed.');

  return true;
}

/**
 * 运行：复位调度状态，attach hub（引用计数，首扫 841 + 订阅活动推送），订阅 10019 到家与奖励邮件，主动扫一次。
 * reactor pause 置 alive=false 后定时器自然停摆，并在 spec.pause 里释放 hub 引用与 watch；
 * resume 重新复位点火（cycle.kick 内部先清旧定时器，不会重复）。
 * dispatched/rejected 不在此清空：使徒「每人只能打一次」是当日硬约束，清空会让 resume 后重复攻打同一目标被拒刷屏。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  emptyStreak = 0;
  queue = [];
  lastPushScanAt = 0;
  rewardLedger.ensureLoaded();
  if (unwatchHub) unwatchHub();
  if (detachHub) detachHub();
  detachHub = activityHub.attach({
    label: 'mecha-treasure',
    scanIntervalMs: cfg.idleScanInterval,
  });
  unwatchHub = activityHub.watch(
    function (activity) {
      return activity.showUiType === SHOW_UI_TYPE_MECHA_TREASURE;
    },
    onActivityChange,
    { label: 'mecha-treasure' },
  );
  ctx.on.push(CMD_USER_MARCH_INFO, onMarchUpdate);
  ctx.on.push(PUSH_SINGLE_MAIL, onRewardMailPush);
  log.info('started; mail=%d;marchType=%d.', PUSH_SINGLE_MAIL, MARCH_TYPE);
  // 启动即主动查一次；本轮结束后 cycle 会武装兜底定时
  cycle.kick();
}

/**
 * 暂停：释放 hub 引用与活动订阅（reactor 的 triggers 管不到 hub 的内部订阅）。
 */
function pause() {
  if (unwatchHub) {
    unwatchHub();
    unwatchHub = null;
  }
  if (detachHub) {
    detachHub();
    detachHub = null;
  }
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap），战斗模式强制下线；
 * 面板仅出启用开关，扫描/攻打间隔均为 cfg 内置常量
 */
reactor.register({
  id: 'mechaTreasure',
  label: '重装母舰',
  storageKey: 'pocketcc.feat.mechaTreasure',
  symbols: ['activityController', 'dataCenter?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 面板可用性：活动不在期时整卡置灰（null=控制器未就绪无从判定，按可用放行，不误灰）
  available: function () {
    return gameData.activityIsOpen('showUiType', SHOW_UI_TYPE_MECHA_TREASURE) === false
      ? { ok: false, reason: '重装母舰活动未开启' }
      : true;
  },
  offInCombat: true,
  // 面板仅出启用开关 + 一行只读当日到账进度（inlineStatus）；扫描/攻打间隔均为 cfg 内置常量。
  defaults: { enabled: false },
  fields: [
    {
      key: '_arriveInfo',
      type: 'text',
      label: '今日',
      get: function () {
        if (!rewardLedger.loaded()) return '—';
        return dailyText(rewardLedger.get('arrive'));
      },
    },
  ],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
  pause: pause,
});
