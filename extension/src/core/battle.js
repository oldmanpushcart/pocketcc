/**
 * battle.js
 * 战斗工具类：按分析文档（references/战斗代码分析.md）从游戏运行时读取预设部队 / 机甲 / 英雄 / 军阵信息，
 * 并构造出发起行军（MARCH_WORLD_POINT 902 等）所必须的部队字段。
 *
 * 本工具只负责"造数据"，不发起真正的行军。产出的 MarchData 固定含 5 个字段：
 *   armyListNew / heroList / trapList / formationV2 / extraArmy
 *
 * 数据来源两条路：
 *   1) preset —— 从 PresetMarchController 读某个预设队伍（默认战斗 type=0，可指定采集 type=1），
 *      映射成请求字段；pos 采用战斗位编码（1|2|3 / 11|12|13 / 21|22|23，见 toBattlePos）。
 *   2) minimal —— 最简行军：0 英雄、0 军阵、0 陷阱，从"可派遣部队"里取等级最低的一支、数量 1 放 pos1；
 *      无可派遣部队时部队派空（armyListNew 为空）。
 *
 * 未指定任何来源（plan().build() 既不 preset 也不 minimal）、或 preset 读取失败时，同样部队派空。
 *
 * preset 出征前做过滤（口径见分析文档的取数接口）：剔除已派出的部队（普通兵可用额度、
 *   机甲战斗状态）、已派出的英雄（不在可派遣名单）、已出征的军阵（置 0）。
 *
 * 每格上阵数走「实时重算」而非直接采纳预设 Num（见 recalcFromPreset）：预设里的数字是
 *   保存那一刻的上限，而真实上限由 Buff 池（城皮/VIP/科技…）+ 英雄统率加成 + 等级格子数
 *   + 当前可派兵池共同决定，这些因素穷举不完，故交回游戏自带的重算器算。
 *   重算器不可用（符号漂移 / subpack2 未接管）时降级到手写过滤口径。
 *
 * minimal 无需过滤（只派 1 个最低级兵，不碰上限）。
 *
 * 依赖游戏运行时模块，全部经 core/game.js 薄封装软获取；缺失即返回 null，各查询入口自行兜底。
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

/** @type {number} 最简行军放兵的战斗位 */
const MINIMAL_POS = 1;

/**
 * 机甲战斗状态（对应游戏 MechaState）：仅 CAN_FIGHT 可随军出征，MARCHING(已出征)/BROKEN 等均不可
 * @type {{NOT_OPEN:number, UNKNOWN:number, CANNOT_FIGHT:number, CAN_FIGHT:number, MARCHING:number, BROKEN:number}}
 */
const MECHA_STATE = {
    NOT_OPEN: 0,
    UNKNOWN: 1,
    CANNOT_FIGHT: 2,
    CAN_FIGHT: 3,
    MARCHING: 4,   // 已出征 / 行军中（mechaServerData.marching=true）
    BROKEN: 5,
};

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

// ── 运行时依赖取值（分析文档记录的取数接口，同时供出征过滤使用）──────
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
/** @returns {object|null} FightFormationAdvController 单例 */
function formationCtl() {
    var m = game.get('FightFormationAdvController');
    return (m && m.default && m.default.Instance) || null;
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
 * 指定兵种持有总数
 * @param {number} armyId 兵种 id
 * @returns {number}
 */
function getTotalArmyNum(armyId) {
    var u = userData();
    return (u && u.getArmyNumByArmyId(armyId)) || 0;
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
        if (!army.Normal || !army.CanBattle) return;    // 与 getCanUseArmyLenByArmyId 同判据
        var level = (army.Data && army.Data.level) | 0;
        if (!best || level < best.level) best = { armyId: army.ArmyId, level: level };
    });
    return best;
}
/**
 * 可派遣英雄列表（原始对象数组，元素含 _id）
 * @returns {object[]}
 */
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
/**
 * 军阵是否已在出征
 * @param {number} formationCode 军阵代码（如 1003）
 * @returns {boolean}
 */
function isFormationMarching(formationCode) {
    var inst = formationCtl();
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
    if (sd && sd.marching) return false;                 // 已出征（行军中）
    return getMechaState(mecha) === MECHA_STATE.CAN_FIGHT;
}

/**
 * 过滤已派出的部队，产出可出征的 army 条目：
 *   - 机甲条目：战斗状态非"可战斗"（在途/损坏等）整条剔除
 *   - 普通兵：按 getCanUseArmyLenByArmyId 的"可用数"钳制 armyNum，同兵种多条目共享额度，
 *            额度耗尽即丢弃该条（已全部派出）
 * @param {object[]} rawArmys 预设 Armys 原始数组
 * @returns {object[]} 过滤后的 army 条目
 */
function filterArmys(rawArmys) {
    var remaining = {};   // armyId -> 该兵种剩余可派额度（懒查一次）
    var result = [];
    (rawArmys || []).forEach(function (item) {
        if (!item || !item.ArmyId) return;
        if (item.isMecha || item.mechaId) {           // 机甲走状态判定
            if (isMechaCanFight(item.mechaId)) result.push(toArmyEntry(item));
            return;
        }
        var armyId = item.ArmyId;
        if (remaining[armyId] === undefined) remaining[armyId] = getAvailableArmyNum(armyId);
        var take = Math.min(item.Num | 0, remaining[armyId]);
        if (take <= 0) return;                        // 该兵种已全部派出
        remaining[armyId] -= take;
        var entry = toArmyEntry(item);
        entry.armyNum = take;
        result.push(entry);
    });
    return result;
}

/**
 * 过滤已派出的英雄：仅保留在"可派遣英雄"名单（getHaveHeroCanMarchList）内的 id
 * @param {number[]} heroIds 预设 HeroIds
 * @returns {number[]} 可出征的英雄 id
 */
function filterHeroIds(heroIds) {
    var set = new Set();
    getMarchableHeroes().forEach(function (h) { if (h) set.add(h._id); });
    return (heroIds || []).filter(function (id) { return set.has(id); });
}

/**
 * 首选路径：把每格上阵数交回游戏自带的重算器实时算（battlePreset.recalc）。
 *
 * 为何必须实时算：预设 Num 是保存那一刻的值，而真实上限 =
 *   1 + floor(add/cells) + (add % cells > pos ? 1 : 0)，
 *   add = Buff(BattleArmyAddNum=153) 全量聚合（城皮技能/VIP/科技/活动等一律收敛于此）
 *       + 英雄统率加成（随出征英雄变），cells 随等级解锁。
 * 再叠加"可派兵池按格逐个消耗"——同一份预设实测可派 250（兵全在家）或 126（部分兵在外，
 * 且尾部两格拿不满 16→15），这种逐格递减的分配结果任何手写公式都复现不出来。
 *
 * 四条实证约束：
 *   - 重算器语义是「发满」（给 1 支也会补到格上限）→ 与预设 Num 取小，保住"预设故意少摆"的语义；
 *   - 兵池按 armyInfo 数组顺序消耗 → 必须按 pos 升序喂入，否则分配与面板不一致；
 *   - 未知 formationV2 不被纠正（只把补位容量算成 0）→ 军阵在途判定仍需本地兜底；
 *   - 重算器就地改写传入对象 → 只喂自建副本，绝不传 PresetMarchData 本体。
 *
 * @param {object[]} rawArmys 预设 Armys 原始数组
 * @param {number[]} rawHeroIds 预设 HeroIds
 * @param {number} formationV2 预设军阵
 * @param {object[]|object} extraRaw 预设 extraArmy
 * @returns {object|null} {armys, heroIds, formationV2, extraArmy}；重算能力不可用返回 null（调用方降级）
 */
function recalcFromPreset(rawArmys, rawHeroIds, formationV2, extraRaw) {
    if (!battlePreset.ok()) return null;
    var srcByPos = {};
    var armyInfo = [];
    (rawArmys || []).forEach(function (item) {
        if (!item || !item.ArmyId) return;
        var pos = item.Pos | 0;
        srcByPos[pos] = item;   // 重算后按 pos 找回原条目，带回 skinId/heroCap 等游戏不认的字段
        armyInfo.push({ armyId: item.ArmyId, num: item.Num | 0, pos: pos, heroCap: item.heroCap || 0 });
    });
    if (!armyInfo.length) return null;
    armyInfo.sort(function (a, b) { return a.pos - b.pos; });
    var extra = toExtraArmy(extraRaw);
    var entry = {
        index: 0,
        formation: 0,
        formationV2: formationV2 | 0,
        heroIds: (rawHeroIds || []).slice(),
        armyInfo: armyInfo,
        extraArmy: extra.armyId ? extra : null,
    };
    if (battlePreset.recalc(entry) === null) return null;

    var armys = [];
    (entry.armyInfo || []).forEach(function (a) {
        var src = srcByPos[a.pos];
        var live = a.num | 0;
        // 发满语义 → 与预设取小；src 缺失（理论上不会）时直接采纳实时值
        if (src && src.Num != null) live = Math.min(live, src.Num | 0);
        if (live <= 0) return;
        armys.push(toArmyEntry({
            ArmyId: a.armyId,       // 机甲条目的 armyId 会被游戏按当前 armyType 换算，取返回值
            Pos: a.pos,
            Num: live,
            heroCap: src && src.heroCap,
            skinId: src && src.skinId,
        }));
    });
    var extraArmy = {};
    if (entry.extraArmy && entry.extraArmy.armyId) {
        var liveExtra = entry.extraArmy.armyNum | 0;            // 无补位容量时游戏已把 extraArmy 置 null
        if ((extra.armyNum | 0) > 0) liveExtra = Math.min(liveExtra, extra.armyNum | 0);
        if (liveExtra > 0) extraArmy = { armyId: entry.extraArmy.armyId, armyNum: liveExtra };
    }
    return {
        armys: armys,
        heroIds: toHeroList(entry.heroIds),                     // 游戏已按"可派遣 + 数量上限"截断
        formationV2: entry.formationV2 | 0,
        extraArmy: extraArmy,
    };
}

/**
 * 从预设队伍构造行军数据。
 * @param {number} [index=0] 预设索引（0 起）
 * @param {number} [type=0]  预设类型：0 战斗 / 1 采集
 * @returns {object|null} MarchData，读取失败返回 null
 */
function buildFromPreset(index, type) {
    index = index | 0;
    type = type | 0;
    var ctl = presetMarchCtl();
    if (!ctl) return null;

    var preset = ctl.getPreMarchByIndex(index, type);
    if (!preset) {
        return null;
    }

    // 预设对象既有 getter（Armys/HeroIds/extraArmy）也有下划线私有字段，二者取其一兜底
    var rawArmys = preset.Armys || preset._Armys;
    var rawHeroIds = preset.HeroIds || preset._HeroIds;
    var rawExtra = preset.extraArmy || preset._extraArmy;
    var formationV2 = (ctl.getFormationV2ByIndex && ctl.getFormationV2ByIndex(index, type)) || 0;

    // 首选：交游戏实时重算每格可派数（含可派兵池逐格消耗、英雄可派截断、补位容量）
    var live = recalcFromPreset(rawArmys, rawHeroIds, formationV2, rawExtra);
    if (live) {
        // 重算器不校验非法军阵（实证：乱填 id 原样保留），在途判定仍由本地兜一层
        if (live.formationV2 && isFormationMarching(live.formationV2)) live.formationV2 = 0;
        log.debug('preset#%d(type=%d) live-recalc -> %d/%d slots, hero=%d, formationV2=%d, extra=%d',
            index + 1, type, live.armys.length, (rawArmys || []).length,
            live.heroIds.length, live.formationV2, (live.extraArmy.armyId || 0));
        return {
            armyListNew: live.armys,
            heroList: live.heroIds,
            trapList: [],               // 预设不含陷阱
            formationV2: live.formationV2,
            extraArmy: live.extraArmy,
        };
    }

    // 降级（重算器符号不可用）：出征过滤——剔除已派出的部队（普通兵可用额度、机甲战斗状态）与英雄（不在可派遣名单）
    var armys = filterArmys(rawArmys);
    var heroList = toHeroList(filterHeroIds(rawHeroIds));
    var extraArmy = toExtraArmy(rawExtra);
    // 军阵已出征则不可再用，置 0
    if (formationV2 && isFormationMarching(formationV2)) formationV2 = 0;

    return {
        armyListNew: armys.map(function (e) { return Object.assign({}, e); }),
        heroList: heroList,
        trapList: [],               // 预设不含陷阱
        formationV2: formationV2,
        extraArmy: extraArmy,
    };
}

/**
 * 空部队行军数据：armyListNew 为空，其余字段归零。
 * 用于"无可派遣部队"、"未指定任何数据来源"或"预设读取失败"的派空场景。
 * @returns {object} MarchData
 */
function emptyMarchData() {
    return {
        armyListNew: [],
        heroList: [],
        trapList: [],
        formationV2: 0,
        extraArmy: {},
    };
}

/**
 * 最简行军数据：0 英雄、0 军阵、0 陷阱，取"可派遣部队"中等级最低的一支、数量 1 放 pos1；
 * 无可派遣部队时部队派空。
 * @returns {object} MarchData
 */
function buildMinimal() {
    var found = findLowestLevelAvailableArmy();
    if (!found) return emptyMarchData();               // 无可派遣部队 → 派空
    var army = { pos: MINIMAL_POS, armyId: found.armyId, armyNum: 1 };
    return {
        armyListNew: [army],
        heroList: [],
        trapList: [],
        formationV2: 0,
        extraArmy: {},
    };
}

/**
 * 对外查询面（只读运行时数据，供 feat 与面板字段惰性求值）
 * @type {object}
 */
var query = {
    PRESET_TYPE: PRESET_TYPE,
    MECHA_STATE: MECHA_STATE,
    getAvailableArmyNum: getAvailableArmyNum,
    getTotalArmyNum: getTotalArmyNum,
    getLowestLevelAvailableArmy: findLowestLevelAvailableArmy,
    getMarchableHeroes: getMarchableHeroes,
    getMyMechaList: getMyMechaList,
    getMechaState: getMechaState,
    isFormationMarching: isFormationMarching,
};

/**
 * 行军计划构造器（由 Battle#plan 创建）：链式选定数据来源，build() 出请求字段。
 * 用法：
 *   new Battle().plan().preset(1).build();          // 预设队伍 1（战斗，type 默认 0）
 *   new Battle().plan().preset(1, 1).build();       // 预设队伍 1（采集，type=1）
 *   new Battle().plan().minimal().build();          // 最简出征
 *   new Battle().plan().build();                    // 未指定来源 → 部队派空
 */
class MarchPlan {
    /** @type {string|null} 数据来源：null 未指定 | 'preset' | 'minimal' */
    #source = null;
    /** @type {number} 预设队伍号（1 起，由 preset() 设置） */
    #preset = 0;
    /** @type {number} 预设类型：0 战斗 / 1 采集 */
    #type = PRESET_TYPE.BATTLE;

    /**
     * 选择预设队伍。
     * @param {number} [index=1] 预设队伍号（1 起，内部减 1 传给 getPreMarchByIndex）
     * @param {number|boolean} [type] 预设类型：0 战斗（默认）/ 1 采集；传 true 等价采集
     * @returns {MarchPlan} this
     */
    preset(index, type) {
        this.#source = 'preset';
        this.#preset = index == null ? 1 : index | 0;
        if (type != null) this.#type = (type === true ? PRESET_TYPE.GATHER : type | 0);
        return this;
    }

    /**
     * 切换到最简出征（0 英雄 / 0 军阵 / 0 陷阱，取最低级可派遣部队 1 个放 pos1；无可用则派空）
     * @returns {MarchPlan} this
     */
    minimal() {
        this.#source = 'minimal';
        return this;
    }

    /**
     * 产出请求所需的行军数据（5 字段）。
     * 未指定来源（既非 preset 也非 minimal）或预设读取失败时，部队派空。
     * @returns {object} MarchData
     */
    build() {
        if (this.#source === 'minimal') return buildMinimal();
        if (this.#source !== 'preset') return emptyMarchData();   // 未指定来源 → 派空
        var data = buildFromPreset(this.#preset - 1, this.#type);
        if (!data) {
            return emptyMarchData();
        }
        return data;
    }
}

/**
 * 战斗工具入口。
 *   new Battle().plan().preset(1).build();   // 返回预设队伍 1 的行军数据
 *   new Battle().plan().minimal().build();   // 返回最简出征的行军数据
 */
export class Battle {
    /** 开始一份行军计划 @returns {MarchPlan} */
    plan() {
        return new MarchPlan();
    }
}

/**
 * 战斗工具对外接口面：位置编码/构数据/查询面/类型常量
 * @type {object}
 */
export const battle = {
    toBattlePos: toBattlePos,
    buildFromPreset: buildFromPreset,
    buildMinimal: buildMinimal,
    query: query,
    PRESET_TYPE: PRESET_TYPE,
    /** 实时重算是否可用（false 时 buildFromPreset 走手写过滤降级） */
    liveRecalcOk() { return battlePreset.ok(); },
};
