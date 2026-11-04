/**
 * 联盟守卫（巨兽 AllianceBehemoth）金币外道具自动捐献（reactor 说明书形态，日常任务，单链）
 *
 * 联盟日常收益循环：成员向联盟守卫「投喂升级道具 + 1 点捐赠次数能量」→ 攒守卫经验（每捐 +固定 exp，
 *   满经验由服务端自动升级并回写最新 behemoth）→ 守卫更强属性。本功能只做一件事：有可捐守卫且能量
 *   有余时把当轮捐赠次数能量花掉——自然恢复的额度不用就是白丢（对齐联盟科技捐赠的取舍）。
 *   仅做「等级捐献」这一条日常收益线（type LEVEL）；精力(VIGOUR)/天赋(TALENT)/商店等子玩法不碰。
 *
 * 协议（均走 net.sendPB，V1 PB 链路，pbAck 业务数据为命名子字段）：
 *   7101 ALLIANCE_BEHEMOTH_LIST {header:{}} → pbAck.allianceBehemothList.list[]（游戏登录/联盟刷新链已拉，本功能只读内存快照）；
 *   7102 ALLIANCE_BEHEMOTH_DONATE {header:{}, allianceBehemothDonate:{behemothId, level}} → pbAck.allianceBehemothDonate
 *     = {behemoth(最新 level/exp), reward, addExp, errorCode}；level 传守卫「当前等级」（对齐游戏 donate(behemothId, 当前 level)）。
 *   抓包实证（20261007T003438）：behemothId=1、level=8 连捐 10 次，每次 +4800 exp、能量池 push 10021 type=13 point 9→0 递减、restoreSec=4200。
 *
 * 门控（复刻游戏 AllianceBehemothDonateComponent.onClick，全部只读判定后才发）：
 *   - 开启：在盟 && FunctionOn(FunctionKey.alliance_behemoth) && UserData.behemothIsOpen（见 gameData.allianceBehemoth().open）；
 *   - 能量：EnergyType.ALLIANCE_BEHEMOTH_DONATE_NUM=13，Point<=0 不捐（游戏弹 alliance_120524）；
 *   - 目标：首个 isUnlock && level<levelCap（behemoth_cultivate.level_cap）的守卫；
 *   - 消耗：behemoth_level[currentLevel].lvup_cost = "costId,costCount"，itemAmount(costId) < costCount 则不捐（游戏弹 CommonItemGetPanel）。
 *
 * 触发（只靠回点驱动，不拿 push 当轮询）：
 *   - run 点火即查一轮（加载时多半已错过推送，本地态直接可用）；
 *   - push 10021 PUSH_ENERGY 只认 type=13 **且只在点数回升时**唤醒：抓包实证每捐一次也把 point 往下扣并推一条 10021
 *     （reason=ALLIANCE_BEHEMOTH_DONATE），一次捐光连推多条递减——故按方向过滤（只认 pt>prev），否则形成「捐→被推→再捐」的请求风暴；
 *   - 能量有余但道具不足/连续被拒 → BUSY 档慢等；池空 → 按回点精准唤醒；
 *   - 无可捐目标/守卫未开/不在盟 → IDLE 档巡检（自然等回点与守卫上新）。
 *
 * 应答兜底（对齐「直发包不回写导致静默失效」教训）：本功能走 net.sendPB 后读 pbAck.allianceBehemothDonate——
 *   errorCode 非空即业务拒（header.s 仍可能为 0），立即 break；成功则用回写的 behemoth.level 刷新等级镜像，
 *   避免升级后仍按旧 level 发包被服务端拒而空转。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 7102，不调用游戏的 Update 系改写本地态；不 OpenUI。
 *   日常任务形态：面板只出启用开关，无字段无配置（fields=[]，toModuleCfg 返回空）。
 *   仅消耗道具与能量、不行军不参战，故 offInCombat:false。
 *
 * 生命周期由 reactor 托管：install/run 两钩子（日常任务无配置可推），places 限 base/world（Home/NWorldMap）；
 *   调度交给 core/cycle.js：单飞闸门、推触合并、异常 fallback 重排均内置；pause 后 alive()=false 让 cycle 自然停摆。
 */
import { CODE_NOT_SENT, sleep } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { l10n, gameData } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=ALLIANCE-BEHEMOTH） */
const log = createLog('ALLIANCE-BEHEMOTH');

// 协议参考：7101 RequestId.ALLIANCE_BEHEMOTH_LIST 拉守卫列表（游戏登录链已发，本功能只读快照、不主动发，故未定义常量）

/** @type {number} RequestId.ALLIANCE_BEHEMOTH_DONATE，等级捐献（type LEVEL） */
const CMD_DONATE = 7102;

/** @type {number} ResponseId.PUSH_ENERGY(10021)，能量池变更推送；只认载荷 type=13 且只在点数回升时触发 */
const CMD_PUSH_ENERGY = 10021;

/** @type {number} EnergyType.ALLIANCE_BEHEMOTH_DONATE_NUM（GameDefine），守卫等级捐献次数能量池（抓包实证 pointMax=10/restoreSec=4200） */
const ENERGY_BEHEMOTH = 13;

/** @type {number} 守卫池自然恢复周期（秒，抓包实证 restoreSec=4200）；getter 没给回点秒数时的兜底 */
const RECOVER_SEC = 4200;

/** @type {number} 单捐链的枚间隔（毫秒）：同 cmd 频控的安全间距（对齐联盟科技 600） */
const DONATE_GAP_MS = 600;

/** @type {number} 单 tick 的连捐枚数上限（二次防御）：池 pointMax≈10，把单次突发锁到 10 枚，未捐完靠 donated→CHAIN_GAP 复查续捐 */
const LOOP_MAX_PER_TICK = 10;

/** @type {number} 本轮捐成功后短隔复查（毫秒）：道具不足/池未花光时续捐 */
const CHAIN_GAP_MS = 2500;

/** @type {number} 能量有余但道具不足/连续被拒时的慢查间隔（毫秒） */
const BUSY_TICK_MS = 1000 * 60 * 5;

/** @type {number} 无事可干（无可捐目标/守卫未开/不在盟）时的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 回点唤醒的抖动余量（毫秒），避开服务器结算时序 */
const RECOVER_BUFFER_MS = 1000 * 10;

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞流程自然退出 */
var ctxRef = null;

/** @type {number} 连续被服务器拒绝次数，达 3 次后退到巡检档；成功即清零 */
var rejectStreak = 0;

/** @type {number} 上次观测到的守卫捐赠池点数（type=13），用于只认「点数回升」的恢复推送、忽略捐赠消耗回执推送 */
var lastEnergyPoint = 0;

/**
 * 功能是否仍在运行（定时器与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 排程 ──────────────────────────────────────────────────────────────
/**
 * 下一拍择时：刚捐过短隔续查 > 池有余慢查 > 回点精准唤醒 > 巡检档。返回值交给 cycle 排下次。
 * @param {object} [snap] 本轮 {donated, energy} 判定结果（缺省按闲档）
 * @returns {number} 毫秒
 */
function nextTickDelay(snap) {
  var ms;
  var e = snap && snap.energy;
  if (snap && snap.donated) ms = CHAIN_GAP_MS;
  else if (e && e.point > 0) ms = rejectStreak >= 3 ? IDLE_TICK_MS : BUSY_TICK_MS;
  else if (e)
    ms = (e.nextRecoverSec > 0 ? e.nextRecoverSec : RECOVER_SEC) * 1000 + RECOVER_BUFFER_MS;
  else ms = rejectStreak >= 3 ? IDLE_TICK_MS * 2 : IDLE_TICK_MS;
  // 游戏 nextRecoverSec 为显式回点时刻：直接睡到该点，仅以 24h 硬顶兜住异常超长值/时钟漂移（离线错过 push 10021 也由下次启动或到点重读自愈）。
  // BUSY=5min、IDLE=15min 等自选档恒 < 24h，不受此顶影响。
  if (ms > 24 * 3600 * 1000) ms = 24 * 3600 * 1000;
  return ms;
}

/** cycle 单轮：跑一次 tickBody → 若期间攒下推触就立即补扫 → 否则按 snap 择下拍。 */
async function cycleRun() {
  var snap = await tickBody();
  if (!aliveFn()) return 0;
  if (cycle.pending) return 0;
  return nextTickDelay(snap || undefined);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 直发一条 V1 PB 请求并归一化应答。net.sendPB 现返回整段 pbAck（V1 业务数据是其命名子字段），
 * payload 即 pbAck 对象，调用方按 cmd 取 allianceBehemothDonate 等字段。永不 reject。
 * @param {number} cmd 命令号
 * @param {object} body 载荷（含 header:{}）
 * @returns {Promise<{ok:boolean, code:number, payload:object|null}>} 归一化结果
 */
async function sendRawPB(cmd, body) {
  var ret = await net.sendGuarded(cmd, body, {
    protocol: 'sendPB',
    onError: function (err) {
      log.warn('cmd %d send threw: %s', cmd, err && err.message);
    },
  });
  var d = ret && ret.data;
  return {
    ok: !!(ret && ret.ok),
    code: ret ? ret.code : CODE_NOT_SENT,
    payload: d && typeof d === 'object' ? d : null,
  };
}

// ── 目标选择 ──────────────────────────────────────────────────────────
/**
 * 按当前等级取 behemoth_level 行的升级消耗（costId,costCount）；行缺失/字段非法返回 null。
 * @param {number} level 守卫当前等级
 * @returns {{costId:number, costCount:number}|null}
 */
function levelCost(level) {
  var row = l10n.tableRow('behemoth_level', level);
  if (!row || !row.lvup_cost) return null;
  var parts = String(row.lvup_cost).split(',');
  var costId = parseInt(parts[0], 10);
  var costCount = parseInt(parts[1], 10);
  if (!(costId > 0) || !(costCount > 0)) return null;
  return { costId: costId, costCount: costCount };
}

/**
 * 选本轮可捐目标：首个 isUnlock && level<levelCap && 有升级消耗行 && 道具够的守卫。
 * @param {object[]} items gameData.allianceBehemoth().items
 * @returns {{behemothId:number, level:number, costId:number, costCount:number}|null}
 */
function pickTarget(items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it.isUnlock || !(it.level > 0)) continue;
    if (it.levelCap > 0 && it.level >= it.levelCap) continue; // 满级不可捐
    var cost = levelCost(it.level);
    if (!cost) continue;
    if (gameData.itemAmount(cost.costId) < cost.costCount) continue; // 道具不足
    return {
      behemothId: it.behemothId,
      level: it.level,
      costId: cost.costId,
      costCount: cost.costCount,
    };
  }
  return null;
}

// ── 主流程 ────────────────────────────────────────────────────────────
/**
 * 单轮主体：本地快照 → 能量闸 → 选目标 → 逐枚 7102 连捐（读应答兜底）。
 * @returns {Promise<object|null>} 排程线索 {donated, energy}；守卫未开/数据不可用返回 null（走闲档）
 */
async function tickBody() {
  var bh = gameData.allianceBehemoth();
  if (!bh || !bh.open) {
    log.debug('behemoth unavailable or not open (not in alliance / feature off).');
    return null;
  }
  var energy = gameData.energy(ENERGY_BEHEMOTH);
  if (!energy) return { donated: false, energy: null };
  if (energy.point <= 0) return { donated: false, energy: energy };

  var target = pickTarget(bh.items);
  if (!target) {
    log.debug('no donateable behemoth (locked/max/item not enough), skip.');
    return { donated: false, energy: energy };
  }

  var donated = 0;
  var curLevel = target.level;
  var loopMax = Math.min(energy.point, LOOP_MAX_PER_TICK);
  for (var i = 0; i < loopMax; i++) {
    if (!aliveFn()) break;
    // 每枚前按当前等级重取消耗行并校验道具（升级后换行、或中途被耗尽都能即时收手）
    var cost = levelCost(curLevel);
    if (!cost) {
      log.debug('behemoth: no level_cost row at level=%d, stop.', curLevel);
      break;
    }
    if (gameData.itemAmount(cost.costId) < cost.costCount) {
      log.debug(
        'behemoth: item not enough. cost=%d(%d/%d)',
        cost.costId,
        gameData.itemAmount(cost.costId),
        cost.costCount,
      );
      break;
    }
    var res = await sendRawPB(CMD_DONATE, {
      header: {},
      allianceBehemothDonate: { behemothId: target.behemothId, level: curLevel },
    });
    if (!aliveFn()) break;
    var ack = res.payload && res.payload.allianceBehemothDonate;
    if (res.ok && ack && !ack.errorCode) {
      rejectStreak = 0;
      donated++;
      var nb = ack.behemoth || {};
      if (nb.level) curLevel = Number(nb.level) || curLevel; // 升级则刷新等级镜像
      log.info(
        'behemoth donate ok. id=%d;#%d;level=%d;addExp=%s',
        target.behemothId,
        donated,
        curLevel,
        ack.addExp,
      );
    } else {
      // 业务拒（errorCode，header.s 仍可能为 0）或发送异常/在途频控：任一枚失败即收手，交下轮/排程
      rejectStreak++;
      var msg =
        ack && ack.errorCode
          ? l10n.net(ack.errorCode)
          : res.code === CODE_NOT_SENT
            ? 'not sent'
            : 'code=' + res.code;
      log.info(
        'behemoth donate rejected (streak #%d). id=%d;level=%d;%s',
        rejectStreak,
        target.behemothId,
        curLevel,
        msg,
      );
      break;
    }
    if (i < loopMax - 1) await sleep(DONATE_GAP_MS);
  }
  return {
    donated: donated > 0,
    energy: donated > 0 ? gameData.energy(ENERGY_BEHEMOTH) || energy : energy,
  };
}

/**
 * 安装：取网络底座。缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  net = ctx.net;
  if (!net || !net.install()) {
    log.warn('install failed: pocketcc.net unavailable');
    net = null;
    return false;
  }
  log.info('installed.');
  return true;
}

/**
 * 运行：复位在飞态 → 订阅 push 10021（只认回升）唤醒 → 立即查一轮。
 * pause 后 alive()=false，定时器与在飞流程自然退出；resume 重新订阅并再查一轮。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  log.info('started.');

  // 以当前点数作为基准：自家捐赠带来的 point 递减推送会因「非回升」被过滤，不再触捐
  var e = gameData.energy(ENERGY_BEHEMOTH);
  lastEnergyPoint = e ? e.point : 0;

  // 能量池推送 10021：只在点数「回升」（自然回点）时唤醒捐赠。
  // 抓包实证：每捐一次把 point 往下扣也推一条 10021（reason=ALLIANCE_BEHEMOTH_DONATE），
  // 一次捐光连推多条递减——不看方向逐条 cycle.kick 就是「捐→被推→再捐」的自我反馈风暴。
  ctx.on.push(CMD_PUSH_ENERGY, function (ev) {
    var d = ev && ev.data;
    if (!d || Number(d.type) !== ENERGY_BEHEMOTH) return;
    var pt = Number(d.point) || 0;
    var prev = lastEnergyPoint;
    lastEnergyPoint = pt;
    if (pt <= prev) return; // 持平/下降：非回升（多为消耗回执），忽略
    log.debug('push 10021 energy type=13 recovered (%d→%d), tick.', prev, pt);
    cycle.kick();
  });

  cycle.kick(); // 首个 tick 立即跑：加载时多半已错过推送，本地态直接可用
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap），不行军不参战故不设战斗门控；
 * 日常任务形态——面板只出启用开关，无字段无配置（守卫未开/满级/道具不足/能量空均为内置口径）；
 * 能量池 id / 恢复周期 / 单捐间距等均为本文件内置常量。
 */
reactor.register({
  id: 'allianceBehemoth',
  label: '联盟守卫',
  storageKey: 'pocketcc.feat.allianceBehemoth',
  symbols: ['dataCenter', 'gameDefine', 'tableManager'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: false,
  defaults: { enabled: false },
  fields: [],
  toModuleCfg: function () {
    return {};
  },
  install: install,
  run: run,
});
