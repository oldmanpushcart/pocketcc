/**
 * CQ26 印石·能量补充车队自动领取（cq26EnergyConvoy）
 *
 * 玩法：白须怪清理（CB 线）期间，世界地图左缘有一枚「胶囊+金箭头」icon（源码类
 *   `CQ26CBWorldUIEnergyIcon`）。**按游戏规则，该派遣按钮「每轮开始时显示 1 次」**（补充量取决于当前击败的白须最高等级）：
 *   icon 亮起 = 本轮有可派遣的能量补充车队；点一下发一条 **不占行军名额**的 2212，服务端派一辆 marchType 310 的
 *   能量运输车（把 extra.energy 送到 itemId=4001 的点），能量进白须怪清理进度，icon 随即熄灭；
 *   **本轮领完后按钮不再回来，直到下一轮开始才由服务器重新推 canReplenish=true 点亮**（不是「攒够能量再亮」）。
 * 本 feat 与玩家看到的 icon 严格同源：亮就发一条 2212，**不动镜头、不派兵、不扫全图**。
 *
 * 协议清单（报文实证：印石-我的日常趟 + part 趟，见 memory「能量补充车队机制与录制验证」）：
 *   2212 SERIES_FROST_MONSTER_CLEANUP_ENERGY_SUPPLY  req `{}`（无载荷）
 *                                                    resp `{energy:<本次领取能量>, lastClaimRound:<累计轮次>}`
 *   22001 push SERIES_FROST_SELF_INFO               带 `canReplenishMonsterCleanupEnergy`（true=icon 亮 / false=icon 灭）；
 *                                                    源码 CQ26ClearBossData.updateSelfInfo 逐字把它写进 _canReplenishMonsterEnergy，
 *                                                    领完后服务端立刻推 false 关灯；下一轮开始时才再推 true 点亮（每轮一次）。
 *                                                    **该推送与内存里都没有「当前轮次/已领轮次」字段**（lastClaimRound 只在 2212 应答里瞬时返回），
 *                                                    故「按钮灭」无法区分「本轮已领」与「未到下一轮」，面板只如实镜像亮/灭两态。
 *
 * 判据（与游戏 icon 严格同源，不扫图、不加请求频次）：
 *   icon 显隐 = CQ26CBWorldUIEnergyIcon.updateIconShow
 *     = CQ26Controller.isOpen() && OriginServerId===ServerId && clearBossData.canSendWorldEnergy()。
 *   前三项本 feat 各自对齐：① 活动闸 cq26IsOpen；② 本服图闸 cq26OriginServerId===worldMap.serverId；
 *   ③ 亮灯闸经 ACL 投影 gameData.cq26EnergySupplyReady()（读内存 canSendWorldEnergy，零发包，与 icon 同一真相源）。
 *   投影不可用（符号漂移/子包未载）时回落自订 22001 的 canReplenishMonsterCleanupEnergy 标量副本。
 *
 * 两路触发（对应用户诉求「定时检测 icon 在就领」+「收到 push 就领一次」）：
 *   A. 定时：cycle 每拍读一次投影自愈式检测（漏收 22001 也能靠内存投影捞回）；
 *   B. 事件：ctx.on.push(22001) 见 canReplenishMonsterCleanupEnergy=true 即 cycle.kick() 抢跑一拍，不等整档睡眠。
 *     口径同 feats-alliance-help：net.js 的 dispatch 先跑完游戏原始 handler 再回调我们，故 push 到达时内存投影必然新鲜。
 *
 * 闸门（按序短路，见 cyclePass）：
 *   1 活动闸 cq26IsOpen → 2 本服图闸 OriginServerId===ServerId（取不到则降级放行）→ 3 亮灯闸（三态：
 *      null=投影不可得→回落 pushReady；pushReady 也 null=无从判定→本拍跳过，绝不把「未知」当「不亮」而永久不领；
 *      false=icon 灭→不动作）→ 4 sendGuarded 在途串行闸（等价游戏侧 checkRequestIdNoRes(2212)）。
 *
 * 刻意不做：不查 marchType 310 的行军落地（能量领取即时进 CB 进度，运输车是表演行军）；
 *   不做本地轮次配额记账（领几轮完全由服务端 canSendWorldEnergy 驱动，关灯即停）；不发 2203 查进度（面板够用）。
 */
import { createLog } from '../../../core/log.js';
import { reactor } from '../../../core/reactor.js';
import { gameData, worldMap } from '../../../core/game-api.js';
import { createCycle } from '../../../core/cycle.js';
import { CODE_NOT_SENT, rejectText } from '../../../core/util.js';

import { CMD_CLAIM, PUSH_SELF_INFO } from './constants.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-CONVOY');

/** 单次被拒后的冷却毫秒（时序竞争类拒绝留自愈窗口，不逐拍重撞） */
const REJECT_COOL_MS = 30 * 1000;
/** 同一「亮灯」连续被拒达此次数即暂缓到下一次 push 再试（防投影/推送打架时刷屏） */
const MAX_REJECT = 3;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入） */
var MCFG = buildDefaults();
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/** @type {boolean|null} 22001 的 canReplenishMonsterCleanupEnergy 标量副本（投影不可用时的回落亮灯判据；null=尚未收到） */
var pushReady = null;
/** @type {number} 连续被拒计数（任一成功领取或新一盏灯亮起即清零） */
var rejectStreak = 0;
/** @type {number} 冷却到期时刻（Date.now() 基准） */
var coolUntilMs = 0;
/** @type {number} 最近一次领取到的能量（面板展示） */
var lastEnergy = 0;
/** @type {number} 最近一次领取后的累计轮次（面板展示） */
var lastRound = 0;
/** @type {boolean} 本轮是否领取成功（决定下一拍是否短间隔续拍） */
var justClaimed = false;
/** @type {boolean} 「投影不可用、降级用 22001 缓存」的 warn 去重（恢复后复位） */
var aclDegradedWarned = false;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（判据全部来自内存投影与推送，安装期不发任何请求）。
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
 * 配置灌入（reactor → 本模块）。无可调参数，仅回吐当前态供面板。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (partial) MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：订阅 22001 推送 + 点火（退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  // 刻意**不**在此清 pushReady/rejectStreak：places/kinds 门控会反复 pause→run（base/world 来回跳、进出 homeland），
  //   清零等于把一次成功领取前的连续被拒计数抹掉，让一个持续被拒的亮灯逐拍重撞刷屏。
  ctx.on.push(PUSH_SELF_INFO, onSelfInfoPush);
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉回落用的推送副本，避免 resume 后拿陈旧的「亮灯」状态去发写请求。
 * cycle 的自重排由 alive() 自守，push 退订由 reactor 托管；本模块无自建定时器。
 */
function pause() {
  pushReady = null;
}

/**
 * 存活判定（cycle 与所有 await 之后的记账都过这一闸）。
 * @returns {boolean}
 */
function aliveFn() {
  return reactor.isRunning('cq26EnergyConvoy');
}

// ── 推送入口 ──────────────────────────────────────────────────────────
/**
 * PBV2 推送取业务体：整包是 `{header,data}`，下钻一层；平铺载荷（旧 JSON 形态）原样回落。
 * @param {object} ev 推送事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o.data || o;
}

/**
 * 22001：读 canReplenishMonsterCleanupEnergy 亮灯位（先取顶层，兼容个别形态落在 monsterSelfInfo 下）。
 * 键缺失/非布尔时**不改** pushReady（无从判定 ≠ 灯灭），避免把一次不带该字段的自我信息推送误读成关灯。
 * @param {object} ev 推送事件
 */
function onSelfInfoPush(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var flag = b.canReplenishMonsterCleanupEnergy;
  if (flag == null && b.monsterSelfInfo) flag = b.monsterSelfInfo.canReplenishMonsterCleanupEnergy;
  if (flag != null) {
    var ready = !!flag;
    // 灯灭（false）时清被拒计数，下一盏灯重新开始；灯亮即唤醒抢跑一拍
    if (!ready) rejectStreak = 0;
    // 与投影相比取「或」：投影说亮也算亮（同帧内存可能已被游戏写好，push 只是权威确认）
    pushReady = ready;
    log.debug('22001 canReplenish=%s', ready);
  }
  if (aliveFn()) cycle.kick();
}

// ── 判据：投影优先 / push 回落 ─────────────────────────────────────────
/**
 * 当前能量补充车队是否「亮灯可领」（与游戏 icon 严格同源）。
 * @returns {boolean|null} true=可领；false=明确不可领；null=两路都无从判定（调用方跳过本拍，不得当 false）
 */
function convoyReady() {
  var proj = gameData.cq26EnergySupplyReady();
  if (proj != null) {
    aclDegradedWarned = false;
    return proj;
  }
  if (pushReady != null) {
    if (!aclDegradedWarned) {
      aclDegradedWarned = true;
      log.warn('convoy acl projection unavailable, degrade to 22001 cache.');
    }
    return pushReady;
  }
  return null;
}

// ── 调度 cycle ────────────────────────────────────────────────────────
// 主触发是 push（每轮开始时服务器推 canReplenish=true 点灯）；轮询只是漏收兼底，故无灯时长睡，
//   有灯（但没领成/在冷却）时短巡自愈。
const cfg = { activeMs: 15000, idleMs: 60000, backoffMs: 30000 };

/**
 * 单拍择时：本轮领成功→按钮熄灭、下一盏灯只能等下一轮，直接降频到 idle（靠 push 唤醒）；
 *   在飞期间攒下的 push（下一轮点灯）立即补拍；其余按「本拍是否有灯」分档。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  var hadLight = await cyclePass();
  if (cycle.pending) return 0;
  if (justClaimed) return cfg.idleMs;
  return hadLight ? cfg.activeMs : cfg.idleMs;
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.backoffMs,
});

// ── 核心 cyclePass ───────────────────────────────────────────────────
/**
 * @returns {Promise<boolean>} 本拍是否存在亮灯候选（供 cycleRun 决定降频档位）
 */
async function cyclePass() {
  justClaimed = false;
  // 1. 活动闸
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    return false;
  }
  // 2. 本服图闸（icon 判据第二项）：老家服≠当前服时游戏侧 icon 恒灭，硬发只会白撞；取不到则降级放行
  var originSid = gameData.cq26OriginServerId();
  var curSid = worldMap.serverId();
  if (originSid != null && curSid > 0 && originSid !== curSid) {
    log.debug(
      'not on origin server (origin=%d cur=%d), convoy icon off by rule.',
      originSid,
      curSid,
    );
    return false;
  }
  // 3. 亮灯闸（三态：null=无从判定跳过本拍；false=灯灭不动作；true=可领）
  var ready = convoyReady();
  if (ready == null) {
    log.debug('convoy state unknown (no projection & no 22001 yet), skip this pass.');
    return false;
  }
  if (!ready) {
    log.debug('convoy icon off (nothing to claim).');
    return false;
  }
  // 3b. 冷却闸：连续被拒达 MAX_REJECT 后暂缓，等下一次 push 点灯自愈
  if (rejectStreak >= MAX_REJECT && Date.now() < coolUntilMs) {
    log.debug('convoy cooling after %d rejects, wait next 22001.', rejectStreak);
    return true;
  }
  if (!net) {
    log.warn('net unavailable, skip claim.');
    return true;
  }
  // 4. 出网（sendGuarded 的在途闸等价游戏侧 checkRequestIdNoRes(2212)）
  await claimConvoy();
  return true;
}

/**
 * 发一条 2212（空载荷）并结算。每拍至多发一条（串行由 sendGuarded 保证）。
 * @returns {Promise<void>}
 */
async function claimConvoy() {
  var t0 = Date.now();
  var sendErr = '';
  var ret = await net.sendGuarded(
    CMD_CLAIM,
    {},
    {
      protocol: 'sendPBV2',
      onError: function (err) {
        sendErr = (err && err.message) || String(err);
      },
    },
  );
  // 停用期间的应答不记账（回落副本已随 pause 丢弃，resume 后重读）
  if (!aliveFn()) {
    log.debug('2212 ack after pause, drop bookkeeping.');
    return;
  }
  if (ret && ret.code === CODE_NOT_SENT) {
    log.warn(
      '2212 not sent%s.',
      sendErr ? ' (threw: ' + sendErr + ')' : ' (in-flight gate or timeout)',
    );
    return;
  }
  if (!ret || !ret.ok) {
    noteReject(ret);
    return;
  }
  settleClaim(ret, Date.now() - t0);
}

/**
 * 成功结算：记能量/轮次供面板，清被拒计数，乐观把回落副本置灭（灯随本次领取熄灭，等下次 push 再点亮）。
 * @param {object} ret Ret{ok,data}
 * @param {number} costMs 往返耗时
 */
function settleClaim(ret, costMs) {
  var d = (ret && ret.data) || {};
  lastEnergy = Number(d.energy) || 0;
  lastRound = Number(d.lastClaimRound) || lastRound;
  rejectStreak = 0;
  coolUntilMs = 0;
  // 权威关灯以 22001 push(false) 为准；乐观把回落副本置灭只为盖住「应答已到、push 未回」那一窗
  if (pushReady != null) pushReady = false;
  justClaimed = true;
  log.info('convoy claimed. energy=%d round=%d cost=%dms', lastEnergy, lastRound, costMs);
}

/**
 * 业务拒绝：属可预期时序类（灯位与实际状态短暂打架），info 级不升 warn；
 * 累计 MAX_REJECT 次后冷却，等下一次 push 点灯自愈（不逐拍重撞）。
 * @param {object} ret Ret{code,data}
 */
function noteReject(ret) {
  rejectStreak++;
  coolUntilMs = Date.now() + REJECT_COOL_MS;
  log.info(
    '2212 rejected. code=%s reason=%s streak=%d%s',
    ret ? ret.code : 'unknown',
    rejectText(ret),
    rejectStreak,
    rejectStreak >= MAX_REJECT ? ' (cooling)' : '',
  );
}

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 面板 defaults（无可调参数，唯一交互项是开关）。
 * @returns {object}
 */
function buildDefaults() {
  return { enabled: false };
}

/**
 * 面板 fields：单行内联状态（组卡片 inlineStatus 取第一个 type:'text' 的 get() 结果）。
 * 只如实镜像游戏按钮的真实两态（canSendWorldEnergy 亮/灭），不臆造中间态：
 *   亮→「可领」；灭且本会话领过→「已领 R{n}」（n 来自 2212 应答的 lastClaimRound，真实数据）；
 *   灭且本会话未领→「不可领」（本轮已手动领或未到下一轮，从可读数上无法区分，不谎称「待点灯」）。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_convoyInfo',
      type: 'text',
      label: '状态',
      get: function () {
        if (!gameData.cq26IsOpen()) return '—';
        var ready = convoyReady();
        if (ready == null) return '—';
        if (ready) return '可领';
        return lastRound ? '已领 R' + lastRound : '不可领';
      },
    },
  ];
}

/**
 * toModuleCfg：面板 cfg → 运行时归一化 MCFG。本玩法无可调参数（两路触发都是默认行为），
 *   仍必须声明：registry 的 applyFeature 对每个 reactor 功能无条件调它。
 * @param {object} c 面板合并后配置
 * @returns {{enabled:boolean}}
 */
function normalizeCfg(c) {
  return { enabled: !!(c && c.enabled) };
}

// ── 注册 ──────────────────────────────────────────────────────────────
reactor.register({
  id: 'cq26EnergyConvoy',
  label: '能量补充车队',
  storageKey: 'pocketcc.feat.cq26_energy_convoy',
  // cq26ClearBoss 为软依赖（探针注册的 cap，见 core/acl-engine.js CAPS）：投影拿不到时降级为「只信 22001 push」，不阻断安装
  symbols: ['dataCenter', 'cq26ClearBoss?'],
  // 与 cq26 家族同口径：靠内存投影 + 定向 2212 出网，不依赖人真站在世界地图里
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 领取不派兵、不占行军名额（310 是能量运输表演行军，实测即时进 CB 进度），战斗态无需下线
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
