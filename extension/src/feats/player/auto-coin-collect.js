/**
 * 自动收取金币（reactor 说明书形态，玩家基础设置，单链）
 *
 * 玩法：主城金币流水线在当前版本（功能位 key_novice_adjustments）是「金矿场/民居持续产出 → 缓存池 → 金币收割机
 *   提现」两段，游戏只要求点一次：点金币收割机把缓存池连同其自身产量一起结进钱包。矿不单独收（它的产出只折进
 *   缓存池、没有独立结算入口）。本功能接管这一次点击：收割机攒够免费门槛即提现，全程不花钻石、不开面板。
 *
 * 协议（抓包实证；源码 RequestId.GET_ORDER=102）：
 *   102 V1 send（非 PB），载荷 `{id:收割机建筑实例id}` → 应答 d（JSON 串）=
 *   {reward:{resource:{coin…}}, building:{…更新后的收割机…}, crit:false}，伴随 push 10001 到账与 10101（该建筑
 *   ProCount 归零重排、 UserData.CacheResource 随之清零）。报文实证整段只有一次 req:send 102 {id:"4164271433534422541"}
 *   （收割机 1801），与玩家「手动点了金币收割机的收割」一致；本功能不订阅这两个 push（下一拍重读权威态即可）。
 *
 * 可收判据（游戏源码同构，纯本地钟算、无到点推送——玩家说的「定时产出、没走服务器 push」即矿折进缓存池的累积）：
 *   收割机（buildingId 1801）可收量 = ProCount + UserData.CacheResource（矿折进缓存池的那笔），
 *   游戏 gotoCollectMachine 的免费分支门槛 = 可收量 > PLAYER_LEVEL.gold_mine_reaper_store_max × 0.2
 *   或 距上次收取 > 14400s；未达门槛游戏弹 CollectionMachine 走钻石「立即收取」，本功能一律不碰。
 *   判据与快照全在本目录 api.js（coinDomain，领域 ACL 下沉）合成，feat 只消费结果、不感知游戏符号；
 *   收取动作只发 {id}，绝不调用游戏的建筑改写接口（只读+发包红线）。
 *
 * 直发不回写 → 本地镜像：脚本发 102 不经游戏 GetProductCallBack/UpdateData，收割机侧权威态（ProCount/产品时刻）
 *   可能没及时追平（要靠游戏自己的建筑推送刷新），追平前若重读 pending 会误判仍可收 → 逐拍重发（对齐每日补给 825
 *   教训）。对策：收成功后把「now + produce_time」记入自持镜像（key=收割机实例 id）；镜像只推进、不拉回，
 *   权威态追平（玩家自己点了、或收到 10101/10109 推送）后由 pruneMirrors 自动让位并剪掉。
 *
 * 调度（A 族 createCycle，单一收敛态 + 全本地可重放读）：
 *   - 每拍至多发一个 102（收割机一次收走全部已结缓存，无需逐矿发）；
 *   - wait 档：睡到最近一个矿到点时刻（涨币信号）+ 缓冲（封顶 LONG_WAKE_MS，到点前零发包，重读无损）；
 *   - 数据未就绪（coinState.available=false / 无到点信息）：IDLE 档巡检；
 *   - 连续被拒 3 次：退 IDLE×2。
 *
 * 合规：全程只读游戏数据（经 game-api ACL）+ 直发 102，不调用任何游戏 Update/Delete 改写本地态、不 OpenUI、
 *   不花钻石。日常任务形态：面板只出启用开关，无字段无配置（fields=[]，toModuleCfg 返回空）。
 *   不行军不参战，offInCombat:false。生命周期由 reactor 托管，pause 后 alive()=false 自然停。
 */
import { CODE_NOT_SENT } from '../../core/util.js';
import { createLog } from '../../core/log.js';
import { gameData } from '../../core/game-api.js';
import { coinDomain } from './auto-coin-collect/api.js';
import { reactor } from '../../core/reactor.js';
import { createCycle } from '../../core/cycle.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=AUTO-COIN） */
const log = createLog('AUTO-COIN');

/** @type {number} RequestId.GET_ORDER，收取主城建筑产出（V1 send，载荷 {id:建筑实例id}） */
const CMD_GET_ORDER = 102;

/** @type {number} 到点唤醒的抖动余量（毫秒），避开服务器结算时序 */
const READY_BUFFER_MS = 1000 * 5;

/** @type {number} 数据未就绪/被拒后的巡检间隔（毫秒） */
const IDLE_TICK_MS = 1000 * 60 * 15;

/** @type {number} 单睡上界（毫秒）：矿的产出间隔一般 8~10 分钟，超长值一律切成多拍，纯本地读零发包，防超长定时器漂移 */
const LONG_WAKE_MS = 1000 * 60 * 30;

/** @type {number} 下拍唤醒的最小间隔（毫秒）：判据抖动时兜底，防紧循环 */
const MIN_WAKE_MS = 1000 * 3;

/** @type {number} 距上次提现多久就放行一次收割（秒）：镜像游戏 LocalDataKey.CollectMechineGetTime 的 4h 分支（游戏写本地、本端只读不改写，故自记时刻） */
const HARVEST_PERIOD_SEC = 14400;

/** @type {number} 连续被服务器拒绝次数，达 3 次后退巡检档；收取成功即清零 */
var rejectStreak = 0;

/** @type {number} 本页面周期内最近一次提现（收割机收取）的服务器秒，0=还没收过 */
var lastHarvestAt = 0;

/**
 * @type {Object<string,number>} 收取回执镜像：建筑实例 id → 下一次到点时刻（服务器秒）。
 * 直发 102 不回写 BuildingData.ProductTime 的补偿；权威态追平后由 pruneMirrors 剪掉。
 */
var mirrors = {};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;

/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;

/**
 * 功能是否仍在运行（cycle 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 状态判定 ──────────────────────────────────────────────────────────
/**
 * 读一份金币产出态快照（注入本端镜像，让刚收过、游戏本地态还没追平的建筑不被误判为仍可收）。
 * @returns {object} coinDomain.read 形态
 */
function readState() {
  return coinDomain.read({ mirrors: mirrors });
}

/**
 * 剪掉已失效的镜像：游戏侧权威到点时刻已追平/反超（玩家自己点了、或收到建筑推送），或时刻早已过期，
 * 都让位给权威值，避免收割机拆除重建换实例 id 后镜像表只增不减。
 * @param {object} state readState() 结果
 */
function pruneMirrors(state) {
  for (var key of Object.keys(mirrors)) {
    var h = state.harvester;
    // 收割机已不在场（拆了/换了实例 id）或镜像时刻已过：不再需要本端兜底
    if (!h || h.id !== key || mirrors[key] <= state.now) delete mirrors[key];
  }
}

/**
 * 收割机本轮该不该提现（镜像游戏免费收取门槛，两个条件命中其一即可；门槛值由 ACL 按
 * PLAYER_LEVEL.gold_mine_reaper_store_max × 0.2 合成，拿不到等级配置时降为「有钱即收」）：
 *   ① 可收量达门槛；② 距上次提现满 4h 且确实有钱。
 * 未达门槛不提现是有意保守：游戏此刻只给钻石「立即收取」入口，UI 上没有免费按钮。
 * @param {object} state readState() 结果
 * @returns {boolean}
 */
function harvestWorth(state) {
  if (!state.harvester || !state.harvestReady) return false;
  if (state.harvestPending <= 0) return false;
  // 镜像未追平前（刚收过、权威 ProCount/CacheResource 还没刷下来）不重复发：交给 collectOnce 后的 mirror 与 harvestPending 自然判断
  if (state.harvester.mirrorProductTime > state.now) return false;
  if (state.harvestPending >= state.harvestFloor) return true;
  return lastHarvestAt > 0 && state.now - lastHarvestAt >= HARVEST_PERIOD_SEC;
}

/**
 * 择时：本轮没活可干时睡多久。最近到点时刻（矿结币 / 收割机自身产满）优先，
 * 拿不到到点信息（数据未就绪、无矿在场）退回 IDLE 巡检；连续被拒降速。
 * @param {object} state readState() 结果
 * @returns {number} 毫秒
 */
function delayFor(state) {
  if (rejectStreak >= 3) return IDLE_TICK_MS * 2;
  if (!state.available || !(state.nextWakeSec > 0)) return IDLE_TICK_MS;
  return Math.min(Math.max(state.nextWakeSec * 1000 + READY_BUFFER_MS, MIN_WAKE_MS), LONG_WAKE_MS);
}

// ── 发包 ──────────────────────────────────────────────────────────────
/**
 * 取应答里的到账金币数（V1 应答 d 是 JSON 串，Ret.data 不解析）；形态不符回 0。
 * @param {object|null} d 已 parse 的应答体
 * @returns {number}
 */
function rewardCoin(d) {
  var r = d && d.reward && d.reward.resource;
  return r ? Number(r.coin) || 0 : 0;
}

/**
 * 直发一条 102 收割机收取。永不 reject；成功即按「now + produce_time」记镜像（下一批到点时刻）。
 * @param {{id:string, intervalSec:number}} harvester 目标收割机
 * @returns {Promise<{claimed:boolean, code:number}>}
 */
async function collectOnce(harvester) {
  var ret = await net.sendGuarded(
    CMD_GET_ORDER,
    { id: harvester.id },
    {
      onError: function (err) {
        log.warn('cmd 102 send threw (harvest): %s', err && err.message);
      },
    },
  );
  var code = ret ? ret.code : CODE_NOT_SENT;
  if (!ret || !ret.ok) {
    if (code !== CODE_NOT_SENT) rejectStreak++;
    return { claimed: false, code: code };
  }
  var d;
  try {
    d = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data;
  } catch (e) {
    d = null;
  }
  // 镜像必须落地，否则在收割机侧权威态追平前会被逐拍重发；produce_time 缺失（符号/配置漂移）时退到巡检档时长
  var interval = Number(harvester.intervalSec) || 0;
  var now = gameData.serverTime();
  mirrors[harvester.id] = now + (interval > 0 ? interval : Math.round(IDLE_TICK_MS / 1000));
  lastHarvestAt = now;
  rejectStreak = 0;
  log.info('coin harvest claimed, id=%s coin=%s.', harvester.id, rewardCoin(d));
  return { claimed: true, code: code };
}

// ── 主流程 ────────────────────────────────────────────────────────────
/**
 * 单轮动作：收割机一次就收走全部已结缓存（矿的产出靠游戏自动折进缓存池、不单独收），
 *   故本轮只看收割机值不值得提现，值得就发一个 102。
 * @returns {Promise<boolean>} 是否发出过收取请求
 */
async function collectPass() {
  var state = readState();
  if (!state.available) return false;
  if (!harvestWorth(state)) return false;
  await collectOnce(state.harvester);
  return true;
}

/** cycle 单轮：判态 → 至多发一个 102 → 按新态择时。next-check 日志由 cycle 驱动器统一输出。 */
async function cycleRun() {
  var acted = await collectPass();
  if (!aliveFn()) return 0;
  var state = readState();
  pruneMirrors(state);
  // 收完后缓存已清零、镜像已推进，本轮一般无补充可收；睡到最近矿到点（涨币信号）再重读权威态
  if (acted && harvestWorth(state)) return 0;
  return delayFor(state);
}

const cycle = createCycle({ log: log, alive: aliveFn, run: cycleRun, fallback: IDLE_TICK_MS });

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
 * 运行：复位在飞态与镜像 → 立即判一拍。无 push 订阅（到点判据是本地钟算，游戏红点同款；
 * 建筑/资源推送只用于游戏自己刷 ProductTime，我们重读权威态即可，不必被它唤醒）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  rejectStreak = 0;
  lastHarvestAt = 0;
  mirrors = {};
  log.info('started.');
  cycle.kick();
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap）；不行军不参战故不设战斗门控；
 * 日常任务形态——面板只出启用开关，无字段无配置（门槛比例/4h 提现窗均为内置口径，不花钻石故不暴露付费档）。
 */
reactor.register({
  id: 'autoCoinCollect',
  label: '自动收取金币',
  storageKey: 'pocketcc.feat.autoCoinCollect',
  symbols: ['dataCenter', 'tableManager'],
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
