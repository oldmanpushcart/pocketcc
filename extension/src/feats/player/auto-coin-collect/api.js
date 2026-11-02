/**
 * pocketcc.feats.player.autoCoinCollectApi
 * 主城金币产出态（自动收取金币）领域 ACL —— 原住 core/game-api.js 的 coinState 区段，
 * 因单一消费方（本目录 feat）且属「复刻游戏收取链路」的领域知识，按解耦试点模式下沉。
 * 引擎机器（SYM/probe/ns/userData 原语）经 core/acl-engine.js 的 createAcl 取共享单例；
 * gameData/l10n/bits 共享对象经 sharedValue 运行期现取（不静态 import game-api，防 core⇄feats 循环）。
 * 纪律：只读游戏数据，不调用任何游戏 Update/Delete 写接口；符号缺失一律保守降级、不抛错。
 */
import { createAcl, sharedValue } from '../../../core/acl-engine.js';

const { userData, log } = createAcl('COINDOM');

/** @type {number} 金币收割机 buildingId（push 10101 实证：GameDefine.MapPointType.Harvester 组下唯一建筑，collectorMaxNum 只挂在它身上） */
const COIN_HARVESTER_BUILDING_ID = 1801;
/** @type {number} BUILDING 表 produce_type=1 = 金币产出型（民居/金矿场）——源码 BuildingData.getProductCacheCount 首闸 `1!=this._Data.produce_type` 即 return 0 */
const COIN_PRODUCE_TYPE = 1;

/**
 * 取调用方镜像的下一次到点时刻（只推进、不拉回：拿不到或更旧回 0 表示不覆写）。
 * @param {Object<string,number>|null} mirrors 镜像表
 * @param {string} id 建筑实例 id
 * @param {number} authoritative 游戏侧权威到点时刻
 * @returns {number} 覆写秒数（无覆写回 0）
 */
function mirrorOf(mirrors, id, authoritative) {
  if (!mirrors) return 0;
  var v = Number(mirrors[id]) || 0;
  return v > authoritative ? v : 0;
}

/**
 * 主城金币产出态只读快照（自动收取金币的唯一真相来源）——复刻游戏自身的收取链路：
 *   当前版本功能位 key_novice_adjustments 生效，金币是「矿持续产出 → 折进缓存池 → 收割机一次提现」两段：
 *   ① 金矿场/民居（BUILDING.produce_type=1）定时产出，游戏用 BuildingData.getProductCacheCount 按
    「(floor((now-ProductTime)/produce_time)+1) × para」逐矿本地累加，经 UpdateHaverstCache 折进缓存池
    UserData.CacheResource（只在建筑 UpdateData/推送时刷新，非定时器——玩家说的「定时产出、没走服务器 push」即此）。
 *      **矿不单独收取**：产物只涨缓存池、没有独立的结算入口，一次收割机收取即连同全部缓存一起结进钱包。
 *   ② 金币收割机（buildingId 1801）把「ProCount + CacheResource」一起收进钱包。游戏点击建筑 gotoCollectMachine →
 *      collectMachineExcute 的**免费分支**只发 GET_ORDER `{id:收割机实例id}`，可免费收的门槛为
 *      「ProCount+CacheResource > PLAYER_LEVEL.gold_mine_reaper_store_max × 0.2」或「距上次收取 > 14400s」
 *      （后者依赖游戏写 LocalDataKey.CollectMechineGetTime，本端只读不改写，故由 feat 自记时刻）；
 *      未达门槛游戏弹 CollectionMachine 走付费「立即收取」——本能力不披露、feat 也不该碰。
 *   收割机可收判据（源码 UserData.AutoHarvesting / BuildingData 实证）：在场、Broken!=1、未报满仓。
 *   mines[] 仅保留「最近一批到点」的本地钟算信息作唤醒/涨币信号（收割机收完后靠它判断下笔何时值得收），
 *   不作为逐矿收取候选。全程只读游戏数据，不调用任何游戏 Update/Delete 写接口。
 * @param {{mirrors?:Object<string,number>}} [opt] mirrors=本端自持的收割机下一次到点时刻表（直发不回写时由调用方维护）
 * @returns {{available:boolean, now:number, cacheResource:number, harvester:({id:string, buildingId:number, broken:number, proCount:number, collectorMax:number, productTime:number, mirrorProductTime:number, intervalSec:number}|null),
 *   mines:Array<{id:string, buildingId:number, productTime:number, intervalSec:number}>,
 *   harvestPending:number, harvestReady:boolean, storeMax:number, harvestFloor:number, nextWakeSec:number}}
 *   available=false：DataCenter/UserData.Buildings 未就绪（调用方本轮不发）；
 *   harvestPending=收割机可收量（ProCount+CacheResource）；harvestFloor=免费收取门槛（拿不到等级配置时降为 pending>0 即收）；
 *   nextWakeSec=距下一次「有矿到点 / 收割机自身到点」的秒数（纯本地钟算，游戏无到点推送；0=无待产信息）。
 */
function coinState(arg) {
  var gd = sharedValue('gameData');
  var l = sharedValue('l10n');
  var bits = sharedValue('bits');
  if (!gd || !l || !bits)
    return {
      available: false,
      now: 0,
      cacheResource: 0,
      harvester: null,
      mines: [],
      harvestPending: 0,
      harvestReady: false,
      storeMax: 0,
      harvestFloor: 0,
      nextWakeSec: 0,
    };
  var empty = {
    available: false,
    now: 0,
    cacheResource: 0,
    harvester: null,
    mines: [],
    harvestPending: 0,
    harvestReady: false,
    storeMax: 0,
    harvestFloor: 0,
    nextWakeSec: 0,
  };
  var u = userData();
  var list = u && u.Buildings;
  if (!u || !Array.isArray(list) || !list.length) return empty;
  var now = gd.serverTime();
  if (!(now > 0)) return empty;
  var lvRow = l.tableRow('PLAYER_LEVEL', gd.level());
  var storeMax = lvRow ? Number(lvRow.gold_mine_reaper_store_max) || 0 : 0;
  var cache = Number(u.CacheResource) || 0;
  /** @type {object|null} 收割机（金币仓库） */
  var harvester = null;
  /** @type {Object<string,number>} 调用方注入的「下一次到点时刻」覆写表（直发 102 不回写游戏本地态的补偿，key=建筑实例 id 字符串） */
  var mirrors = (arg && arg.mirrors) || null;
  /** @type {object[]} 金币产出建筑（金矿场/民居） */
  var mines = [];
  for (var i = 0; i < list.length; i++) {
    var b = list[i];
    var cfg = b && b.Data;
    if (!cfg) continue;
    var id = bits.int64Str(b.Id);
    if (!id) continue;
    var productTime = Number(b.ProductTime) || 0;
    var buildingId = Number(b.BuildingId) || 0;
    if (buildingId === COIN_HARVESTER_BUILDING_ID) {
      var hMirror = mirrorOf(mirrors, id, productTime);
      harvester = {
        id: id,
        buildingId: buildingId,
        broken: Number(b.Broken) || 0,
        proCount: Number(b.ProCount) || 0,
        collectorMax: Number(b.CollectorMaxNum) || 0,
        productTime: hMirror || productTime,
        mirrorProductTime: hMirror,
        intervalSec: Number(cfg.produce_time) || 0,
      };
      continue;
    }
    if (Number(cfg.produce_type) !== COIN_PRODUCE_TYPE) continue; // 只算金币产出建筑：士兵/其他产物建筑收了也不出币
    var intervalSec = Number(b.TotalTime) || 0; // BuildingData._totalTime = BUILDING.produce_time（士兵类才改写，金币建筑恒为配置值）
    // 矿不单独收取，仅作唤醒/涨币信号：ProductTime 是下一批到点时刻（权威态由游戏建筑推送刷新，无需镜像补偿）。
    if (productTime <= 0) continue;
    mines.push({
      id: id,
      buildingId: buildingId,
      productTime: productTime,
      intervalSec: intervalSec,
    });
  }
  var harvestPending = harvester ? harvester.proCount + cache : 0;
  // 收割机可收态：在场、未破损、未报满仓（满仓后再发也不涨，游戏同判据不再显示可收）。collectorMax 读数异常（浮点精度）时不参与闸门。
  var collectorMax = harvester ? harvester.collectorMax : 0;
  var harvestReady = !!(
    harvester &&
    harvester.broken !== 1 &&
    !(collectorMax > 0 && collectorMax <= 1e15 && harvestPending >= collectorMax)
  );
  // 下一次值得醒来的时刻：最早的矿到点 / 收割机自身下一批到点；已过点的候选不参与（本轮就能收，不需要定时）
  var nextWakeSec = 0;
  var pickNext = function (t) {
    if (!(t > 0)) return;
    var d = t - now;
    if (d <= 0) return;
    if (!nextWakeSec || d < nextWakeSec) nextWakeSec = d;
  };
  for (var j = 0; j < mines.length; j++) pickNext(mines[j].productTime);
  if (harvester) pickNext(harvester.productTime);
  return {
    available: true,
    now: now,
    cacheResource: cache,
    harvester: harvester,
    mines: mines,
    harvestPending: harvestPending,
    harvestReady: harvestReady,
    storeMax: storeMax,
    harvestFloor: storeMax > 0 ? storeMax * 0.2 : 1,
    nextWakeSec: nextWakeSec,
  };
}

/**
 * 主城金币产出态快照（金矿场/民居到点产出 + 金币收割机可收量），口径见上方 coinState 注释。
 * 只读、无副作用；符号/数据缺失或插槽不可用回 {available:false}，调用方本轮不发。
 * @param {{mirrors?:Object<string,number>}} [opt] 同 coinState
 * @returns {ReturnType<typeof coinState>}
 */
export const coinDomain = {
  read(opt) {
    try {
      return coinState(opt);
    } catch (e) {
      log.debug('coinState threw: %s', e && (e.message || e));
      return { available: false };
    }
  },
};
