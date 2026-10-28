/**
 * battle.js —— 行军发包载荷构造（只造数据，不发起行军）。
 * 模型：plan() 持有一个 raw「数据完备集」，preset()/minimal() 覆盖式装载整份来源（二者互斥），
 *   adjust() 只记校准意图，build() 单点把完备集投影成请求 MarchData（armyListNew/heroList/trapList/formationV2/extraArmy + presetHasHeroes/presetHeroIds）。
 *   完备集内部存预设 0 起格子 pos，战斗位编码（toBattlePos）统一在投影时做，避免重算器与投影口径打架。
 * 三场景：快速派兵 plan().minimal().build()；普通派兵 plan().preset(n).adjust().build()（校准+排除在途）；
 *   活动派兵 plan().preset(n).adjust({ignoreMarched:true}).build()（校准+不排除，快照战斗如卡车掠夺）。
 * 未指定来源/读取失败 → 派空；重算符号不可用时按口径降级（普通=手写过滤，活动=满编原样）。详见 docs/core/battle.md。
 *
 * 依赖游戏运行时模块经 core/game.js 软获取，缺失即 null，各入口自行降级。
 */
import { game } from './game.js';
import { battlePreset } from './game-api.js';
import { createLog } from './log.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=BATTLE） */
const log = createLog('BATTLE');

/**
 * 预设类型（对应 PresetMarchType）：0 默认战斗，1 采集
 * @type {{BATTLE:number, GATHER:number}}
 */
const PRESET_TYPE = {
  BATTLE: 0,
  GATHER: 1,
};

/** @type {number} 最简行军放兵的战斗位（grid 索引发 0，投影时 toBattlePos(0)=1） */
const MINIMAL_GRID_POS = 0;

/**
 * 机甲可随军出征状态（游戏 MechaState.CAN_FIGHT）；其余状态（未开放/不可战/已出征/损坏）均不可
 * @type {number}
 */
const MECHA_CAN_FIGHT = 3;

// ── 战斗位编码 ──────────────────────────────────────────────────────────
/**
 * 把预设 9 宫格索引（0..8，行优先）映射成请求里的战斗位 pos。
 * 口径与 RealNBattleModel.startFight 一致：
 *   索引 0/1/2 → 1/2/3；3/4/5 → 11/12/13；6/7/8 → 21/22/23
 * @param {number} index 阵型索引（0 起）
 * @returns {number} 战斗位 pos
 */
function toBattlePos(index) {
  if (index < 3) return index + 1;
  var col = (index + 1) % 3 || 3;
  if (index < 6) return 10 + col;
  if (index < 9) return 20 + col;
  return index + 1; // 越界兜底：极少见，保持不丢兵
}

/**
 * 单条预设兵种 → 请求 army 条目 {pos, armyId, armyNum[, heroCap][, skinId]}
 * 只带请求需要的字段；isMecha / mechaId 属预设内部标记，不进请求（机甲以其 ArmyId 体现）。
 * @param {object} item 预设 Armys 元素 {ArmyId, Pos, Num, heroCap, skinId?}
 * @returns {object}
 */
function toArmyEntry(item) {
  var entry = {
    pos: toBattlePos(item.Pos | 0),
    armyId: item.ArmyId,
    armyNum: item.Num | 0,
  };
  if (item.heroCap) entry.heroCap = item.heroCap;
  if (item.skinId) entry.skinId = item.skinId;
  return entry;
}

/**
 * 英雄 id 列表 → 请求 heroList：纯 id 数字数组 [id, ...]（不是 {heroId} 对象数组）。
 * 口径：游戏 heroList 直接取 attackerHeros（RealNBattleModel.js:159 attackerHeros = o.heroIds），
 * 902 start_commonMarch 与 1204 ALLIANCE_Assembly_Join 都发 `heroList: this.attackerHeros`——英雄 id 数字数组。
 * @param {number[]} ids
 * @returns {number[]}
 */
function toHeroList(ids) {
  return (ids || []).slice();
}

/**
 * 预设 extraArmy（数组）→ 请求 extraArmy（对象 {armyId, armyNum}，无则 {}）。
 * 与 RealNBattleModel 里 CurBattleData.extraArmy 的 {armyId, armyNum} 口径一致。
 * @param {object[]|object} extra 预设 _extraArmy
 * @returns {object}
 */
function toExtraArmy(extra) {
  var list = extra;
  if (!list) return {};
  if (!Array.isArray(list)) list = [list];
  if (!list.length) return {};
  var armyNum = 0;
  for (var i = 0; i < list.length; i++) {
    armyNum += list[i].Num | 0;
  }
  return { armyId: list[0].ArmyId, armyNum: armyNum };
}

// ── 预设部队读取 ────────────────────────────────────────────────────────
/**
 * PresetMarchController 单例（缺失时记日志并返回 null）
 * @returns {object|null}
 */
function presetMarchCtl() {
  var m = game.get('PresetMarchController');
  var inst = m && m.default && m.default.instance;
  if (!inst) log.warn('PresetMarchController.instance unavailable.');
  return inst || null;
}

// ── 运行时依赖 ──────────────────────────────────────────────────────
/** @returns {object|null} UserData 数据面（DataCenter.DATA.UserData） */
function userData() {
  var dc = game.get('DataCenter');
  return (dc && dc.DATA && dc.DATA.UserData) || null;
}
/** @returns {object|null} HeroController 单例 */
function heroCtl() {
  var m = game.get('HeroController');
  return (m && m.HeroController && m.HeroController.getInstance()) || null;
}
/** @returns {object|null} MechaController 单例 */
function mechaCtl() {
  var m = game.get('MechaController');
  return (m && m.MechaController && m.MechaController.getInstance()) || null;
}

/**
 * 指定兵种可用（战斗可派）总数
 * @param {number} armyId 兵种 id
 * @returns {number}
 */
function getAvailableArmyNum(armyId) {
  var u = userData();
  return (u && u.getCanUseArmyLenByArmyId(armyId)) || 0;
}
/**
 * 从"当前可派遣部队"里挑等级最低的一支（供最简行军按 1 数量派遣）。
 * 可派遣判据与 getCanUseArmyLenByArmyId 一致：army.Normal && army.CanBattle；等级取 army.Data.level。
 * @returns {{armyId:number, level:number}|null} 无可用部队时返回 null
 */
function findLowestLevelAvailableArmy() {
  var u = userData();
  if (!u || typeof u.userArmyForEach !== 'function') return null;
  var best = null;
  u.userArmyForEach(function (army) {
    if (!army || !army.ArmyId) return;
    if (!army.Normal || !army.CanBattle) return; // 与 getCanUseArmyLenByArmyId 同判据
    var level = (army.Data && army.Data.level) | 0;
    if (!best || level < best.level) best = { armyId: army.ArmyId, level: level };
  });
  return best;
}
/** 可派遣英雄列表（原始对象数组，元素含 _id） */
function getMarchableHeroes() {
  var inst = heroCtl();
  return (inst && inst.getHaveHeroCanMarchList()) || [];
}
/**
 * 我方机甲列表
 * @param {number} mechaId 机甲 cfg id（如 1004）
 * @returns {object[]} 机甲数组，实际只用 [0]
 */
function getMyMechaList(mechaId) {
  var inst = mechaCtl();
  return (inst && inst.getMyMechaList(mechaId)) || [];
}
/**
 * 机甲战斗状态：0 未开放 / 2 不能战斗 / 3 可战斗 / 4 已出征(行军中) / 5 损坏
 * @param {object} mecha 机甲对象（非 cfg id）
 * @returns {number}
 */
function getMechaState(mecha) {
  var inst = mechaCtl();
  return (inst && mecha && inst.getMechaStateByMecha(mecha)) || 0;
}
/** 军阵是否已在出征 */
function isFormationMarching(formationCode) {
  var m = game.get('FightFormationAdvController');
  var inst = m && m.default && m.default.Instance;
  return !!(inst && inst.getAdvFormationMarching(formationCode));
}

/**
 * 机甲是否可随军出征：先排除已出征（行军中），再以状态=可战斗兜底。
 * 已出征的机甲（mechaServerData.marching=true）getMechaStateByMecha 会返回 MARCHING(4)，
 * 不等于 CAN_FIGHT(3)，故一并被过滤掉。
 * @param {number} mechaId 机甲 cfg id
 * @returns {boolean}
 */
function isMechaCanFight(mechaId) {
  if (!mechaId) return false;
  var mecha = getMyMechaList(mechaId)[0];
  if (!mecha) return false;
  var sd = mecha.mechaServerData;
  if (sd && sd.marching) return false; // 已出征（行军中）
  return getMechaState(mecha) === MECHA_CAN_FIGHT;
}

/**
 * 过滤已派出的英雄：仅保留在"可派遣英雄"名单（getHaveHeroCanMarchList）内的 id
 * @param {number[]} heroIds 预设 HeroIds
 * @returns {number[]} 可出征的英雄 id
 */
function filterHeroIds(heroIds) {
  var set = new Set();
  getMarchableHeroes().forEach(function (h) {
    if (h) set.add(h._id);
  });
  return (heroIds || []).filter(function (id) {
    return set.has(id);
  });
}

/**
 * 校准：对整份 raw 完备集交游戏重算器实时算每格可派数（含可派兵池逐格消耗、英雄可派截断、补位容量）。
 * 预设 num 只是保存那一刻的上限快照，真实上限由 Buff 池+英雄统率+可派兵池逐格消耗动态决定，手写公式复现不出来。
 * 关键约束（详见 docs/core/battle.md §2.1/§6）：结果与预设 num 取小（重算器「发满」语义）、按 pos 升序喂入（兵池按数组序消耗）、只喂自建副本（重算器就地改写）。
 * @param {object} d raw 完备集（{armyInfo(grid pos), heroIds, formationV2, extraRaw}）
 * @param {boolean} excludeMarched true=排除在途（普通）/ false=全量池（活动）
 * @returns {object|null} MarchData；重算能力不可用返回 null（调用方降级）
 */
function recalcData(d, excludeMarched) {
  if (!battlePreset.ok()) return null;
  var srcByPos = {};
  var armyInfo = [];
  d.armyInfo.forEach(function (it) {
    srcByPos[it.pos] = it; // 重算后按 pos 找回原条目，带回 skinId/heroCap 等游戏不认的字段
    armyInfo.push({ armyId: it.armyId, num: it.num | 0, pos: it.pos, heroCap: it.heroCap || 0 });
  });
  if (!armyInfo.length) return null;
  armyInfo.sort(function (a, b) {
    return a.pos - b.pos;
  });
  var extra = toExtraArmy(d.extraRaw);
  var entry = {
    index: 0,
    formation: 0,
    formationV2: d.formationV2 | 0,
    heroIds: d.heroIds.slice(),
    armyInfo: armyInfo,
    extraArmy: extra.armyId ? extra : null,
  };
  // excludeMarched=true → checkMarch=true（排除在途）；false → checkMarch=false（全部持有池，容量校准恒做）
  if (battlePreset.recalc(entry, excludeMarched !== false) === null) return null;

  var armys = [];
  (entry.armyInfo || []).forEach(function (a) {
    var src = srcByPos[a.pos];
    var live = a.num | 0;
    // 发满语义 → 与预设取小；src 缺失（理论上不会）时直接采纳实时值
    if (src && src.num != null) live = Math.min(live, src.num | 0);
    if (live <= 0) return;
    armys.push(
      toArmyEntry({
        ArmyId: a.armyId, // 机甲条目的 armyId 会被游戏按当前 armyType 换算，取返回值
        Pos: a.pos,
        Num: live,
        heroCap: src && src.heroCap,
        skinId: src && src.skinId,
      }),
    );
  });
  var extraArmy = {};
  if (entry.extraArmy && entry.extraArmy.armyId) {
    var liveExtra = entry.extraArmy.armyNum | 0; // 无补位容量时游戏已把 extraArmy 置 null
    if ((extra.armyNum | 0) > 0) liveExtra = Math.min(liveExtra, extra.armyNum | 0);
    if (liveExtra > 0) extraArmy = { armyId: entry.extraArmy.armyId, armyNum: liveExtra };
  }
  return {
    armyListNew: armys,
    heroList: toHeroList(entry.heroIds), // 游戏已按"可派遣 + 数量上限"截断
    trapList: [],
    formationV2: entry.formationV2 | 0,
    extraArmy: extraArmy,
    presetHasHeroes: d.heroIds.length > 0,
    // 非报文位（与 presetHasHeroes 同列）：预设原始英雄集，未经可派过滤，供调用方做行军身份比对
    presetHeroIds: d.heroIds.slice(),
  };
}

/**
 * 读预设原始数据（loadPreset 用）。
 * 预设对象既有 getter（Armys/HeroIds/extraArmy）也有下划线私有字段，二者取其一兜底。
 * @param {number} index 预设索引（0 起）
 * @param {number} type  预设类型：0 战斗 / 1 采集
 * @returns {{rawArmys:object[], rawHeroIds:number[], rawExtra:object[]|object, formationV2:number}|null}
 */
function readPreset(index, type) {
  var ctl = presetMarchCtl();
  if (!ctl) return null;
  var preset = ctl.getPreMarchByIndex(index, type);
  if (!preset) return null;
  return {
    rawArmys: preset.Armys || preset._Armys,
    rawHeroIds: preset.HeroIds || preset._HeroIds,
    rawExtra: preset.extraArmy || preset._extraArmy,
    formationV2: (ctl.getFormationV2ByIndex && ctl.getFormationV2ByIndex(index, type)) || 0,
  };
}

// ── 装载：来源 → raw 完备集（存 grid pos，不编码、不重算、不过滤）───────
/**
 * 装载某个预设队伍为 raw 完备集（覆盖式来源选择）。
 * @param {number} index 预设索引（0 起）
 * @param {number} type  预设类型：0 战斗 / 1 采集
 * @returns {object|null} {source,armyInfo,heroIds,formationV2,extraRaw}；读取失败返回 null
 */
function loadPreset(index, type) {
  var rp = readPreset(index, type);
  if (!rp) return null;
  var armyInfo = [];
  (rp.rawArmys || []).forEach(function (item) {
    if (!item || !item.ArmyId) return;
    armyInfo.push({
      armyId: item.ArmyId,
      num: item.Num | 0,
      pos: item.Pos | 0,
      heroCap: item.heroCap || 0,
      skinId: item.skinId,
      mechaId: item.mechaId || 0,
      isMecha: !!(item.isMecha || item.mechaId),
    });
  });
  return {
    source: 'preset',
    armyInfo: armyInfo,
    heroIds: (rp.rawHeroIds || []).slice(),
    formationV2: rp.formationV2 | 0,
    extraRaw: rp.rawExtra,
  };
}

/**
 * 装载最简出征为 raw 完备集：最低级可派遣部队 1 支放 grid0，其余全零；无可用部队则 armyInfo 为空。
 * 不查在途额度（快速派兵语义）。
 * @returns {object} 完备集
 */
function loadMinimal() {
  var found = findLowestLevelAvailableArmy();
  return {
    source: 'minimal',
    armyInfo: found ? [{ armyId: found.armyId, num: 1, pos: MINIMAL_GRID_POS }] : [],
    heroIds: [],
    formationV2: 0,
    extraRaw: null,
  };
}

// ── 投影：raw 完备集 → 请求 MarchData ─────────────────────────────────
/**
 * 满编原样投影：armyNum 取完备集保存值，不 filter 不重算（不消耗真实行军池的快照场景用，如卡车掠夺）。
 * @param {object} d raw 完备集
 * @returns {object} MarchData
 */
function projectRaw(d) {
  return {
    armyListNew: d.armyInfo.map(function (it) {
      return toArmyEntry({
        ArmyId: it.armyId,
        Pos: it.pos,
        Num: it.num,
        heroCap: it.heroCap,
        skinId: it.skinId,
      });
    }),
    heroList: toHeroList(d.heroIds),
    trapList: [],
    formationV2: d.formationV2 | 0,
    extraArmy: toExtraArmy(d.extraRaw),
    presetHasHeroes: d.heroIds.length > 0,
    presetHeroIds: d.heroIds.slice(),
  };
}

/**
 * 降级投影（游戏符号不可用 + 普通口径）：手写过滤剔除已派出部队/英雄、军阵在途置 0；容量用预设 num，不重算。
 * @param {object} d raw 完备集
 * @returns {object} MarchData
 */
function filterFallback(d) {
  var remaining = {}; // armyId -> 该兵种剩余可派额度（懒查一次）
  var armys = [];
  d.armyInfo.forEach(function (it) {
    if (it.isMecha) {
      // 机甲走战斗状态判定
      if (isMechaCanFight(it.mechaId))
        armys.push(
          toArmyEntry({
            ArmyId: it.armyId,
            Pos: it.pos,
            Num: it.num,
            heroCap: it.heroCap,
            skinId: it.skinId,
          }),
        );
      return;
    }
    if (remaining[it.armyId] === undefined) remaining[it.armyId] = getAvailableArmyNum(it.armyId);
    var take = Math.min(it.num | 0, remaining[it.armyId]);
    if (take <= 0) return; // 该兵种已全部派出
    remaining[it.armyId] -= take;
    armys.push(
      toArmyEntry({
        ArmyId: it.armyId,
        Pos: it.pos,
        Num: take,
        heroCap: it.heroCap,
        skinId: it.skinId,
      }),
    );
  });
  var formationV2 = d.formationV2;
  if (formationV2 && isFormationMarching(formationV2)) formationV2 = 0;
  return {
    armyListNew: armys,
    heroList: toHeroList(filterHeroIds(d.heroIds)),
    trapList: [],
    formationV2: formationV2,
    extraArmy: toExtraArmy(d.extraRaw),
    presetHasHeroes: d.heroIds.length > 0,
    presetHeroIds: d.heroIds.slice(),
  };
}

/**
 * 空部队行军数据：armyListNew 为空，其余字段归零。
 * 用于"未指定任何数据来源"或"预设读取失败"的派空场景。
 * @returns {object} MarchData
 */
function emptyMarchData() {
  return {
    armyListNew: [],
    heroList: [],
    trapList: [],
    formationV2: 0,
    extraArmy: {},
    presetHasHeroes: false,
    presetHeroIds: [],
  };
}

/**
 * 行军计划构造器（由 Battle#plan 创建）：链式操作一个 raw 数据完备集，build() 单点投影成请求字段。
 * preset()/minimal() 是互斥的整份覆盖式装载；adjust() 只记校准意图、延迟到 build() 执行（避免顺序陷阱）。
 * 三场景与组合矩阵详见 docs/core/battle.md §3.3。
 */
class MarchPlan {
  /** @type {object|null} raw 数据完备集；null=尚未选源或读取失败 */
  #data = null;
  /** @type {{excludeMarched:boolean}|null} 校准意图（adjust 设置、build 执行）；null=不校准 */
  #recalc = null;

  /**
   * 覆盖式装载预设队伍为完备集（来源选择，与 minimal 互斥）。
   * @param {number} [index=1] 预设队伍号（1 起，内部减 1）
   * @param {number|boolean} [type] 预设类型：0 战斗（默认）/ 1 采集；传 true 等价采集
   * @returns {MarchPlan} this
   */
  preset(index, type) {
    var idx = (index == null ? 1 : index | 0) - 1;
    var t = type == null ? PRESET_TYPE.BATTLE : type === true ? PRESET_TYPE.GATHER : type | 0;
    this.#data = loadPreset(idx, t);
    return this;
  }

  /**
   * 覆盖式装载最简出征为完备集（0 英雄/0 军阵/0 陷阱，最低级可派遣部队 1 个；无可用则派空）
   * @returns {MarchPlan} this
   */
  minimal() {
    this.#data = loadMinimal();
    return this;
  }

  /**
   * 记「按可派口径校准」意图：build() 时对完备集整份重算（容量校准恒做，与是否排除在途无关）。
   * 默认排除已外派的部队/英雄/军阵名额（普通派兵）；传 { ignoreMarched: true } 则不排除在途
   * （活动/快照派兵，如卡车掠夺），对应游戏 checkPreMarchExtraList 的 checkMarch=false。
   * 仅对 preset 源有意义（minimal 只发 1 支最低级兵、本就是快速派兵，不查额度也不重算）。
   * @param {object} [opts] { ignoreMarched?:boolean } true=不排除在途（活动派兵）
   * @returns {MarchPlan} this
   */
  adjust(opts) {
    this.#recalc = { excludeMarched: !(opts && opts.ignoreMarched) };
    return this;
  }

  /**
   * 单点投影：把完备集转成请求 MarchData（5 字段）。未选源/读取失败 → 派空。
   * minimal 与不校准走满编原样；preset+校准走重算，符号不可用时按口径降级（普通=手写过滤，活动=满编）。
   * @returns {object} MarchData
   */
  build() {
    var d = this.#data;
    if (!d) return emptyMarchData();
    if (d.source === 'minimal' || !this.#recalc) return projectRaw(d);
    var excl = this.#recalc.excludeMarched;
    var out = recalcData(d, excl);
    if (out) {
      // 重算器不校验非法/在途军阵，排除口径下本地兜一层；活动口径不兜（名额由池来源决定）
      if (excl && out.formationV2 && isFormationMarching(out.formationV2)) out.formationV2 = 0;
      return out;
    }
    return excl ? filterFallback(d) : projectRaw(d); // 符号不可用降级：普通→手写过滤，活动→满编
  }
}

/**
 * 战斗工具入口：new Battle().plan() 开始一份行军计划（用法见 MarchPlan / docs/core/battle.md §4）。
 */
export class Battle {
  /** 开始一份行军计划 @returns {MarchPlan} */
  plan() {
    return new MarchPlan();
  }
}
