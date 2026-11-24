/**
 * 世界态归一层（纯只读）：把游戏四路正交信号——cc 场景名、NWorldMapCoreBiz.mapType、
 * CrossUtils 跨服形态谓词、WatchingBattleType 观战态——归一成三个正交维度：
 *
 *   Kind  「你在哪一种场景」：homeland / wushuang(无双峡谷) / kvk_c4(四国) / kvk_c8(八国) /
 *         kvk_c8s2 / pab(异能秘境) / cnc / cnc25 / adp_war(盟决) / unknown —— 互斥单值。
 *   Place 「这个场景下的哪张地图」：base(家) / world(大地图) / battle / sphere / transition / …
 *   Phase 「这个场景进行到哪个阶段」：normal / donate / ready / fight / reward / matching
 *         （跨战区天梯赛的四阶段是 ServerState 阶段机，不是场景，故不进 Kind）
 *
 * 快照另带两个派生位：watching（真观战，不含秘境——PAB 也占 watchingType 位）、
 * crossMap（mapType 口径的「此刻真在跨服/副本图上」，比 kind 严）。
 *
 * 设计取舍与真机验证口径全文见 extension/docs/core/world-state.md。
 *
 * 分层立场：本文件不出现任何游戏符号名（判据一律经 game-api.worldSignals），也不 import reactor
 * （门控由 core/scene-watcher.js 注册）——它只是「读 + 归类 + 缓存 + 广播」的纯查询面，
 * 因此既能被门控用，也能被 feat 自查用（如 autoDefense 在峡谷图跳过开盾）。
 * 合规：全部只读 getter，绝不写游戏任何字段（只读 + 发包红线）。
 */
import { createLog } from '../log.js';
import { bus, EVT } from '../bus.js';
import { worldSignals } from '../game-api.js';
import { KIND, KIND_GROUPS, PLACE, PHASE, GEN, kindInList, placeInList } from './contracts.js';

// 世界态词表与纯谓词下沉至 core/world/contracts.js（阶段四 Tier0/1 隔离）：本文件 import 后经
// worldState 接口面重导出（对外表面零变化）；有状态归一（读信号→归类→缓存→广播 world.change）仍留此处。
export { KIND, KIND_GROUPS, PLACE, PHASE, GEN };

/** @type {ReturnType<createLog>} 模块日志器（tag=WORLD） */
const log = createLog('WORLD');

// KIND / KIND_GROUPS / PLACE / PHASE / GEN 词表定义已迁至 core/world/contracts.js（见顶部 import+重导出）；
// 下方归一映射表 PLACE_OF_SCENE / KIND_OF_MAPTYPE 直接复用导入的常量值。

/** 场景名语义键 → Place（语义键由 game-api 给出，本表不含游戏符号） */
const PLACE_OF_SCENE = {
  home: PLACE.base,
  homeOther: PLACE.base_other,
  newWorld: PLACE.world,
  worldOld: PLACE.world_old,
  battle: PLACE.battle,
  sphere: PLACE.sphere,
  transition: PLACE.transition,
  boot: PLACE.boot,
  other: PLACE.other,
  off: PLACE.off,
};

/**
 * mapType 语义名 → Kind（谓词链落空时的反查表，也是 adp_war 目前唯一可辨识的入口）。
 * 注意 kvk(2) 对应八国、c4(4) 对应四国、kvk_s2(5) 对应八国第二季（源码 setMapTmxData 实证）。
 * 下面五个 homeland 变体必须全列：地图 setter 会把任何「写 world」就地折算成
 * `world / world_withBoder / world_NTerrain / world_NTerrain_border / sq_2026` 之一
 * （按新地形与边界图两个功能开关；sq_2026=15 是 2026 赛季新地图变体，部分玩家启用），
 * 少列任一个都会让常态落 unknown 、把整批玩法饿死（游戏自己同源：WorldUtils.worldMapArr）。
 */
const KIND_OF_MAPTYPE = {
  world: KIND.homeland,
  world_withBoder: KIND.homeland,
  world_NTerrain: KIND.homeland,
  world_NTerrain_border: KIND.homeland,
  sq_2026: KIND.homeland, // 15：新版本服常态地图（2026 赛季起部分玩家启用），与旧 202 互斥
  pab: KIND.pab,
  cab: KIND.wushuang,
  new_cab: KIND.wushuang,
  master: KIND.wushuang,
  c4: KIND.kvk_c4,
  kvk: KIND.kvk_c8,
  kvk_s2: KIND.kvk_c8s2,
  cnc: KIND.cnc,
  cnc_high: KIND.cnc,
  cnc_25: KIND.cnc25,
  cnc_high_25: KIND.cnc25,
  adp_war: KIND.adp_war,
};

/** @type {object|null} 最近一次归一结果（缓存供门控与 feat 同步读，翻转时才广播） */
let snapshot = null;

/**
 * 无双峡谷代际细分：顺序对齐游戏 WorldUtils.dealMarchTypeWithSpecialMarch 的换算优先级
 * （NewCAB→TM→Master→TeamLegend），这样 gen 与行军类型漂移的真相同源。
 * @param {object} sig worldSignals
 * @returns {string} GEN 值
 */
function genOfCanyon(sig) {
  if (sig.cross.newCab()) return GEN.ava;
  if (sig.cross.tm()) return GEN.tm;
  if (sig.cross.master()) return GEN.master;
  if (sig.cross.teamLegend()) return GEN.legend;
  if (sig.mapTypeName() === 'cab') return GEN.thunder;
  return GEN.none;
}

/**
 * 场景归类：谓词链优先（服务器形态位是「你的城在哪一族战场」的权威），
 * 落空才用 mapType 反查（它只说明「此刻渲染的是哪张图」，但 adp_war 只有这一路可辨）。
 * @param {object} sig worldSignals
 * @returns {{kind:string, gen:string, reason:string}} 归一结果与落档依据
 */
function kindOf(sig) {
  // ① 秘境最先：它的 mapType 会被 PabController.getPabMapType() 覆盖成别的值，
  //    只有 watchingType===PAB 这一路可靠（源码 mapType setter 实证）。
  if (sig.pabBattleMap()) return { kind: KIND.pab, gen: GEN.none, reason: 'watching-pab' };
  // ② 峡谷族（四代实现同族，gen 区分代际）
  if (sig.cross.newCab() || sig.cross.tm() || sig.cross.master() || sig.cross.teamLegend()) {
    return { kind: KIND.wushuang, gen: genOfCanyon(sig), reason: 'cross-predicate' };
  }
  // ③ 征服者族（9 号形态位；eni 与 cq25 互斥，由 neutralData 分流）
  if (sig.cross.eni()) return { kind: KIND.cnc, gen: GEN.none, reason: 'cross-eni' };
  if (sig.cross.cq25()) return { kind: KIND.cnc25, gen: GEN.none, reason: 'cross-cq25' };
  // ④ 跨战区天梯赛三形态（eightServerType 位域，赛季内持续为真——城也被迁进了跨服图）
  if (sig.cross.c4()) return { kind: KIND.kvk_c4, gen: GEN.none, reason: 'cross-c4' };
  if (sig.cross.c8()) return { kind: KIND.kvk_c8, gen: GEN.none, reason: 'cross-c8' };
  if (sig.cross.c8s2()) return { kind: KIND.kvk_c8s2, gen: GEN.none, reason: 'cross-c8s2' };
  // ⑤ 单项谓词都拿不到（子包门面未接管抛错），但游戏自建的峡谷总闸说「是」
  if (sig.cross.cabMap()) {
    return { kind: KIND.wushuang, gen: genOfCanyon(sig), reason: 'cross-cabmap' };
  }
  // ⑥ 反查 mapType
  var mt = sig.mapTypeName();
  if (KIND_OF_MAPTYPE[mt]) {
    return {
      kind: KIND_OF_MAPTYPE[mt],
      gen: KIND_OF_MAPTYPE[mt] === KIND.wushuang ? genOfCanyon(sig) : GEN.none,
      reason: 'maptype-' + mt,
    };
  }
  // ⑦ 信号就绪却认不出来：本服常态之外的一切新形态（版本漂移首遇，值得响一次）
  if (mt) return { kind: KIND.unknown, gen: GEN.none, reason: 'maptype-' + mt };
  return { kind: KIND.unknown, gen: GEN.none, reason: 'no-signal' };
}

/**
 * 阶段归类：把游戏 ServerState 语义名折成小写档。名外一律 unknown（漂移可见）。
 * @param {object} sig worldSignals
 * @returns {string} PHASE 值
 */
function phaseOf(sig) {
  var name = String(sig.serverStateName() || '').toLowerCase();
  return PHASE[name] || (sig.serverState() ? PHASE.unknown : PHASE.normal);
}

/**
 * 采集一次完整快照（纯读，无副作用）。
 * @returns {object} 快照对象 {kind,place,phase,gen,watching,crossMap,ready,reason,raw}
 */
function collect() {
  var sig = worldSignals;
  var place = PLACE_OF_SCENE[sig.sceneSemantic()] || PLACE.off;
  // watching 只标「真观战」。watchingType 实为 NWorldMapCoreBiz 的世界接管位，PAB 也占它——
  // 真机实证（2026-10-10 异能秘境）：打秘境时 watchingType=3(PAB)、mapType=9，人是在场实战而非观战，
  // 若按「!==0」判会把整个秘境期误报成观战。秘境实战与秘境观战共用同一位、静态不可分，
  // 需细分时看 raw.watchingTypeName 与 PabController 的活动态。
  var watching = sig.watchingType() !== 0 && !sig.pabBattleMap();
  var raw = {
    scene: sig.sceneName(),
    sceneSemantic: sig.sceneSemantic(),
    mapType: sig.mapType(),
    mapTypeName: sig.mapTypeName(),
    watchingType: sig.watchingType(),
    watchingTypeName: sig.watchingTypeName(),
    serverState: sig.serverState(),
    serverStateName: sig.serverStateName(),
    tmServerType: sig.tmServerType(),
    eightServerType: sig.eightServerType(),
    cross: {
      anyServer: sig.cross.anyServer(),
      cabMap: sig.cross.cabMap(),
      tm: sig.cross.tm(),
      master: sig.cross.master(),
      teamLegend: sig.cross.teamLegend(),
      newCab: sig.cross.newCab(),
      eni: sig.cross.eni(),
      cq25: sig.cross.cq25(),
      c4: sig.cross.c4(),
      c8: sig.cross.c8(),
      c8s2: sig.cross.c8s2(),
    },
  };
  if (!sig.ready()) {
    // 未就绪档：NWorldMapCoreBiz 还没在场（引擎早期/未登录）。按 homeland 放行——
    // 判据 mapType 的初值本就是 world(1)，「从没进过跨服的账号」与「信号没到」在静态上不可分；
    // 真机时序上 mapType 由登录报文折算，一定早于进任何场景，故首帧即正确，误判窗口小于一拍。
    return {
      kind: KIND.homeland,
      place: place,
      phase: PHASE.normal,
      gen: GEN.none,
      watching: watching,
      crossMap: false,
      ready: false,
      reason: 'biz-not-ready',
      raw: raw,
    };
  }
  var k = kindOf(sig);
  // crossMap：mapType 反查出来的档不是本服图——即「你的视角此刻真在跨服战场图上」。
  // kind 用的是形态位（跨服赛季整季为真），两者相差一个「赛季中回了原战区」的时间窗，
  // 需要严判「此刻真在战场图」的 feat（如破坏性动作）读 crossMap，不要读 kind。
  var mapKind = KIND_OF_MAPTYPE[raw.mapTypeName];
  // 谓词链与 mapType 反查不一致时不打 warn（两者本就可不同时为真：赛季中你在家，
  // 形态位为真而 mapType 仍是本服图），原始两侧值都在 raw 里，dump() 供诊断对照。
  return {
    kind: k.kind,
    place: place,
    phase: phaseOf(sig),
    gen: k.gen,
    watching: watching,
    crossMap: !!(mapKind && mapKind !== KIND.homeland),
    ready: true,
    reason: k.reason,
    raw: raw,
  };
}

/**
 * 快照是否等价（只比对外可见的四维 + 观战态；raw 里的原值抖动不算翻转）。
 * @param {object} a 旧快照
 * @param {object} b 新快照
 * @returns {boolean} 是否变了
 */
function changed(a, b) {
  if (!a || !b) return true;
  return (
    a.kind !== b.kind ||
    a.place !== b.place ||
    a.phase !== b.phase ||
    a.gen !== b.gen ||
    a.watching !== b.watching ||
    a.crossMap !== b.crossMap ||
    a.ready !== b.ready
  );
}

/**
 * 重算快照；四维任一翻转才广播 world.change（门控据此 recomputeAll），抖动不刷屏。
 * @returns {object} 最新快照
 */
export function refresh() {
  var next;
  try {
    next = collect();
  } catch (e) {
    // 归一绝不允许因一次判据异常而停摆：沿用上一帧（无则给 homeland/off），并记真异常
    log.warn('collect threw: %s', e && e.message);
    next = snapshot || {
      kind: KIND.unknown,
      place: PLACE.off,
      phase: PHASE.unknown,
      gen: GEN.none,
      watching: false,
      crossMap: false,
      ready: false,
      reason: 'collect-error',
      raw: {},
    };
  }
  var prev = snapshot;
  snapshot = next;
  if (changed(prev, next)) {
    log.info(
      'world: %s/%s (%s phase=%s%s) reason=%s',
      next.kind,
      next.place,
      next.gen,
      next.phase,
      next.watching ? ' watching' : '',
      next.reason,
    );
    bus.emit(EVT.WORLD_CHANGE, next);
  }
  return next;
}

/**
 * 最近一次快照（首次调用即现采一次，保证门控在装配早期也有值可读）。
 * @returns {object} 快照
 */
export function current() {
  return snapshot || refresh();
}

/**
 * 当前场景档（Kind）。
 * @returns {string}
 */
export function kind() {
  return current().kind;
}

/**
 * 当前地图（Place）。
 * @returns {string}
 */
export function place() {
  return current().place;
}

/**
 * 当前阶段（Phase）。
 * @returns {string}
 */
export function phase() {
  return current().phase;
}

/**
 * 当前是否处在跨服战场图上（mapType 口径，比 kind 更严：排除了「赛季开着但人回了原战区」的窗口）。
 * @returns {boolean}
 */
export function crossMap() {
  return !!current().crossMap;
}

/**
 * 判「当前 Kind 是否落在给定的档或组里」。空/缺省列表视为放行（与 scenes 门控同约定）。
 * @param {string[]|undefined} list 期望档名或组名（KIND 值 / KIND_GROUPS 键）
 * @param {string} at 当前 Kind（默认读快照）
 * @returns {boolean} 是否命中
 */
export function matchesKind(list, at) {
  if (!Array.isArray(list) || !list.length) return true;
  return kindInList(list, at || kind());
}

/**
 * 判「当前 Place 是否落在给定的地图白名单里」。空/缺省列表视为放行（与 matchesKind 同约定）。
 * Place 只由 cc 场景语义名折算，符号缺失/引擎未就绪时落 PLACE.off。本函数保持**纯判据**、
 * 不内置「拿不到就放行」的兜底——按键级消费方（core/hotkeys.js）需要那道兜底，而 reactor 门控
 * 不需要（拦错了回到白名单档会自动 resume，热键没有这个补偿）。
 * @param {string[]|undefined} list 期望地图名（PLACE 值）
 * @param {string} [at] 当前 Place（默认读快照）
 * @returns {boolean} 是否命中
 */
export function matchesPlace(list, at) {
  if (!Array.isArray(list) || !list.length) return true;
  return placeInList(list, at || place());
}

/**
 * 破坏性动作自查：观战态（你在旁不控局）与秘境态（世界图被副本接管）下都不该发改本地/行军的动作。
 * @param {object[]} [needKinds] 允许落档（档名或组名）；缺省=除观战/秘境上一切常态
 * @returns {boolean} 当前是否允许动手
 */
export function actionable(needKinds) {
  var st = current();
  if (!st.ready || st.watching) return false;
  if (!needKinds || !needKinds.length) return st.kind !== KIND.pab;
  return matchesKind(needKinds, st.kind);
}

/**
 * 调试面（DevTools）：当前快照 + 四路原始信号并排，便于对照归一是否落错档。
 * @returns {object} 快照（含 raw）
 */
export function dump() {
  var st = refresh();
  log.info('dump %s', st);
  return st;
}

/**
 * 世界态只读接口面（门控与 feat 统一从这里取，不碰 game-api 原始信号）
 */
export const worldState = {
  KIND,
  KIND_GROUPS,
  PLACE,
  PHASE,
  GEN,
  current,
  refresh,
  kind,
  place,
  phase,
  crossMap,
  matchesKind,
  matchesPlace,
  actionable,
  dump,
};
