/**
 * 世界态纯词表层（core/world/contracts.js）——阶段四 Tier0/1 领域隔离的共享词汇。
 *
 * 定位：只放「世界态的字母表」（KIND/PLACE/PHASE/GEN 枚举 + KIND_GROUPS 分组）与「纯判据」
 * （kindInList/placeInList：给一个当前值 + 白名单，判是否命中，不读任何实时状态）。
 * 本文件零 import、零状态、不碰 game-api/worldSignals，是 core 依赖图的叶子，因此可被最底层设施
 * （如 core/hotkeys.js 的按键闸门）安全消费，而不把领域归一层（core/world/state.js）拖进底层。
 *
 * 分层口径：core/world/state.js 从这里 import 常量并在其 worldState 接口面重导出（对外表面零变化），
 * 另外承担「读信号→归类→缓存→广播 world.change」的有状态归一。谓词逻辑只在这一处，
 * world/state.js 的 matchesKind/matchesPlace 经本层纯谓词实现，行为与内联拆分前严格一致。
 * 合规：纯函数 + 常量，绝不读写字段（只读红线的词汇底座）。
 */

/**
 * 场景枚举：玩家同一时刻只会有一种 Kind（单值标量）。
 * @type {Object<string, string>}
 */
export const KIND = {
  /** 本服常态：既不在任何跨服战场，也没有跨服形态位（日常图的默认档） */
  homeland: 'homeland',
  /** 异能秘境（独立世界体系：场景名沿用 NWorldMap，真相在 watchingType===PAB） */
  pab: 'pab',
  /** 无双峡谷：AVA / TM / 大师赛 / 传奇小队 四代实现共用一族战场 */
  wushuang: 'wushuang',
  /** 四国（跨战区天梯赛·四国形态，mapType=c4） */
  kvk_c4: 'kvk_c4',
  /** 八国（跨战区天梯赛·八国形态，mapType=kvk——名字反直觉，源码 isC8()→mapType=kvk） */
  kvk_c8: 'kvk_c8',
  /** 八国 S2（跨战区天梯赛·八国第二季，mapType=kvk_s2） */
  kvk_c8s2: 'kvk_c8s2',
  /** 征服者·异能（EniConqueror，mapType=cnc/cnc_high） */
  cnc: 'cnc',
  /** 征服者·CQ25（mapType=cnc_25/cnc_high_25） */
  cnc25: 'cnc25',
  /** 盟决战场：换服重连登录态（ServerId≠OriginServerId 且 crossType=7）或 mapType=adp_war 反查 */
  adp_war: 'adp_war',
  /** 信号在场但落不进任何已知档（版本漂移警报位） */
  unknown: 'unknown',
};

/**
 * Kind 分组名：门控可按组声明（kinds:['kvk'] 覆盖三国形态），避免同族枚举抄三遍。
 * @type {Object<string, string[]>}
 */
export const KIND_GROUPS = {
  kvk: [KIND.kvk_c4, KIND.kvk_c8, KIND.kvk_c8s2],
  sphere: [KIND.cnc, KIND.cnc25],
  cross: [
    KIND.wushuang,
    KIND.pab,
    KIND.kvk_c4,
    KIND.kvk_c8,
    KIND.kvk_c8s2,
    KIND.cnc,
    KIND.cnc25,
    KIND.adp_war,
  ],
};

/**
 * 地图枚举（第二层）：同一种 Kind 下玩家可处的地图。Home/NWorldMap 属此层，不是场景。
 * @type {Object<string, string>}
 */
export const PLACE = {
  /** 大本营（自己的基地内景） */
  base: 'base',
  /** 大本营（别人家，访客） */
  base_other: 'base_other',
  /** 世界大地图（本服图与各类跨服战场图共用同一 cc 场景，靠 Kind 分） */
  world: 'world',
  /** 旧世界大地图（SceneName.WORLD='WorldMap'，已边缘化，留位） */
  world_old: 'world_old',
  /** 战斗演出场景（机甲/RTS） */
  battle: 'battle',
  /** 征服者球体场景 */
  sphere: 'sphere',
  /** 转场Loading */
  transition: 'transition',
  /** 登录/启动 */
  boot: 'boot',
  /** 其它已知场景（面板预览等） */
  other: 'other',
  /** 引擎未就绪，拿不到场景名 */
  off: 'off',
};

/**
 * 阶段枚举：取自游戏 ServerState 语义（跨战区天梯赛的进程位），与 Kind 正交。
 * @type {Object<string, string>}
 */
export const PHASE = {
  normal: 'normal',
  donate: 'donate',
  ready: 'ready',
  fight: 'fight',
  reward: 'reward',
  matching: 'matching',
  unknown: 'unknown',
};

/**
 * 无双峡谷代际：不进 Kind（同族能力一致），但决定 marchType 换算与 UI 归属，供 feat 细分。
 * @type {Object<string, string>}
 */
export const GEN = {
  none: 'none',
  /** AVA / NewCAB 代（marchType 110） */
  ava: 'ava',
  /** TeamMatch 代（marchType 150） */
  tm: 'tm',
  /** 大师赛/王者赛（marchType 170） */
  master: 'master',
  /** 传奇小队·小队赛/传奇赛（marchType 181） */
  legend: 'legend',
  /** 旧雷神峡谷 CAB（mapType=cab，CrossUtils.isCAB() 已恒 false） */
  thunder: 'thunder',
};

/**
 * 判「给定 Kind 是否落在白名单档或组里」（纯判据，不读实时状态）。空/缺省列表视为放行（与 scenes 门控同约定）。
 * @param {string[]|undefined} list 期望档名或组名（KIND 值 / KIND_GROUPS 键）
 * @param {string} cur 当前 Kind
 * @returns {boolean} 是否命中
 */
export function kindInList(list, cur) {
  if (!Array.isArray(list) || !list.length) return true;
  for (var i = 0; i < list.length; i++) {
    var want = list[i];
    if (want === cur) return true;
    var group = KIND_GROUPS[want];
    if (group && group.indexOf(cur) !== -1) return true;
  }
  return false;
}

/**
 * 判「给定 Place 是否落在地图白名单里」（纯判据，不读实时状态）。空/缺省列表视为放行（与 kindInList 同约定）。
 * @param {string[]|undefined} list 期望地图名（PLACE 值）
 * @param {string} cur 当前 Place
 * @returns {boolean} 是否命中
 */
export function placeInList(list, cur) {
  if (!Array.isArray(list) || !list.length) return true;
  return list.indexOf(cur) !== -1;
}
