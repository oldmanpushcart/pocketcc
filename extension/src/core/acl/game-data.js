/**
 * ACL 域切片 · 玩家/游戏数据只读面 + 配置数据表（core/acl/game-data.js）
 * 原 core/game-api.js 的「玩家/游戏数据」区段（一键领取常量/helper + gameData 巨对象 + gameConf），
 * 按域拆分片7逐字迁出（行为零变化）。l10n 经同目录 import；本切片对外导出 gameData/gameConf，
 * 由 game-api re-export 保 69 处消费方路径不破，并继续在 game-api 尾部经 registerSharedValue 挂插槽。
 */
import { game } from '../game.js';
import { SYM, probe, ns, userData } from '../acl-engine.js';
import { l10n } from './l10n.js';

// ─────────────────────── 一键领取（TaskRelax 集中领取）开启闸只读枚举 ───────────────────────

/** @type {number} DataConfig 79089：一键领取放量的 serverTransferRange 白名单（逗号分隔） */
const TASK_RELAX_RANGE_CFG = 79089;
/** @type {number} DataConfig 79092：远征行动解锁所需的最后通关任务线门槛 */
const TASK_RELAX_ADVENTURE_CFG = 79092;
/** @type {number} 远征行动建筑组 id（checkBuildingGroupExists 用，实证 TaskRelaxTool 硬编码 3800） */
const TASK_RELAX_ADVENTURE_GROUP = 3800;
/** @type {number} 金币收割机建筑 type（getBuildingByType(6)） */
const TASK_RELAX_HARVESTER_TYPE = 6;
/** @type {Object<string,number>} TaskRelaxType 枚举值（源码实证：11/21/22/31/41/42），仅记成员名→数值，游戏漂移时改此处 */
const TASK_RELAX_TYPE = {
  ISLE: 11,
  ADVENTURE_INCOME: 21,
  ADVENTURE_QUICK_BATTLE: 22,
  MECHA_TOWER: 31,
  COIN_HARVESTER_INCOME: 41,
  COIN_HARVESTER_FREE_RECEIVE: 42,
};

/**
 * 安全调用 UserData 上的一个方法（缺失/异常返回 undefined，不抛）。
 * @param {object} obj 目标对象（多为 UserData）
 * @param {string} name 方法名
 * @param {number} arg 单参数
 * @returns {*}
 */
function callNumFn(obj, name, arg) {
  if (!obj || typeof obj[name] !== 'function') return undefined;
  try {
    return obj[name](arg);
  } catch (e) {
    return undefined;
  }
}

/** BuildingGroup.Isle 枚举值（岛屿作战建筑组，运行时按成员名向 GameDefine 取；符号缺失兜底实证值 3100） */
function buildingGroupIsle() {
  var gd = probe(SYM.modules.gameDefine, () => ns(game.get(SYM.modules.gameDefine)));
  var bg = gd && gd.BuildingGroup;
  return bg && bg.Isle != null ? bg.Isle : 3100;
}

/** 重装母舰（Mecha 塔）功能是否开启：MechaTowerController.getInstance().isOpenFunc(false)（传 false 抑制 UI 弹提示，纯只读查询） */
function mechaTowerOpen() {
  try {
    var m = game.get(SYM.modules.mechaTowerCtrl);
    var cls = m && (m.MechaTowerController || (m.default && m.default.MechaTowerController));
    if (!cls || typeof cls.getInstance !== 'function') return false;
    var inst = cls.getInstance();
    return !!(inst && typeof inst.isOpenFunc === 'function' && inst.isOpenFunc(false));
  } catch (e) {
    return false;
  }
}

/**
 * 一键领取子玩法解锁只读判定（复刻 TaskRelaxTool.getIsShowQuickSweepByType 的 switch）。
 * @param {number|string} type task_relax 行的 type（TaskRelaxType 数值）
 * @returns {boolean}
 */
function taskRelaxTypeOpen(type) {
  var u = userData();
  if (!u) return false;
  var t = Number(type);
  switch (t) {
    case TASK_RELAX_TYPE.ISLE:
      return !!callNumFn(u, 'checkBuildingGroupExists', buildingGroupIsle());
    case TASK_RELAX_TYPE.ADVENTURE_INCOME:
    case TASK_RELAX_TYPE.ADVENTURE_QUICK_BATTLE: {
      if (!callNumFn(u, 'checkBuildingGroupExists', TASK_RELAX_ADVENTURE_GROUP)) return false;
      var adv = u.AdventureData;
      var last = adv ? Number(adv.LastWinMissionId) : NaN;
      // 与游戏 `Number(getDataConfigData(79092))` 的 fail-closed 对齐：门槛缺配（dataConfig 归一为 ''，
      // 游戏侧 undefined→NaN 使 last>=NaN 恒 false）时按「未达门槛」关闭，不可当 0 放行未解锁玩家。
      var thrRaw = String(gameConf.dataConfig(TASK_RELAX_ADVENTURE_CFG));
      return thrRaw !== '' && isFinite(Number(thrRaw)) && last >= Number(thrRaw);
    }
    case TASK_RELAX_TYPE.MECHA_TOWER:
      return mechaTowerOpen();
    case TASK_RELAX_TYPE.COIN_HARVESTER_INCOME:
    case TASK_RELAX_TYPE.COIN_HARVESTER_FREE_RECEIVE: {
      var b = callNumFn(u, 'getBuildingByType', TASK_RELAX_HARVESTER_TYPE);
      return !!(
        u.Harvester &&
        Number(u.Harvester.Broken) === 0 &&
        Array.isArray(b) &&
        b.length > 0 &&
        gameData.functionOn('gold_coin_harvester_ui_v1')
      );
    }
    default:
      return false;
  }
}

// coinState/mirrorOf/COIN_* 常量已迁 feats/player/auto-coin-collect/api.js（领域算法下沉，单消费方）

/**
 * 游戏日界偏移（秒）：每日 0 点刷新对应的 UTC 秒内偏移。真相来自 extracted DateUtils.getOffsetDaysByTime
 * 的归日式 `(t-57600)%86400`，57600=16h → 日界线落在 UTC 16:00 = 服务器本地 0:00（UTC+8）。
 * 符号/常量知识收口 ACL（只读口径）；实证 dashcam 服务器秒与本地文件名 UTC+8 对齐。
 * @type {number}
 */
const GAME_DAY_RESET_OFFSET = 57600;

/**
 * @type {number} 排除捐赠的科技组 sid 10900（字典 alliance_tech_name10900=快速作战）：剩余捐赠次数走独立能量池
 * EnergyType.ALLIANCE_BUILDING_DONATE_GOLD_NUM=6，且服务端恒回 addPoint=0（只加建筑经验、不计个人每日荣誉）。
 * 能量池实测（dashcam 全量 10021 归集）：pointMax=200、restoreSec=20 —— 比通用池 4（10/1800）大两个数量级、
 * 回点快 90 倍；把它混进普通科技目标会长期霸占 donateTarget（它排在 dev 列表第 8 组，前序满级即命中），
 * 把捐赠交互抬到 3 次/分钟的常驻量。用户定案（快速作战不捐）：ACL 把它从捐赠目标中整体排除——
 * 不进 donateTarget（含回退首项）、不采纳推荐位命中、不再单列 buildingTarget 披露。
 */
const SCIENCE_SID_EXCLUDE_DONATE = 10900;

export const gameData = {
  /** 当前服务器时间（秒），实时取值不缓存；取不到返回 0 */
  serverTime() {
    try {
      return +game.get(SYM.modules.dataCenter).DATA.ServerTime || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 下一个「游戏日 0 点」的绝对服务器秒（日界口径见 GAME_DAY_RESET_OFFSET，源自 DateUtils）。
   * 供「按日刷新」类玩法把下次动作锤定到服务器本地 0 点之后（只读换算，不碰游戏数据）。
   * @param {number} [fromTs] 参考服务器秒（缺省取当前 ServerTime）
   * @returns {number} 下一个日界线的绝对秒；参考时间不可用（0）时返回 0
   */
  nextDailyResetTs(fromTs) {
    var t = fromTs == null ? gameData.serverTime() : Number(fromTs) || 0;
    if (!t) return 0;
    var dayStart = t - ((t - GAME_DAY_RESET_OFFSET) % 86400);
    return dayStart + 86400;
  },
  /** 本人 StrUid（快速登录模式下与数字 UID 不同）；取不到返回 '' */
  strUid() {
    var s = userData() && userData().StrUid;
    return s != null && s !== '' ? String(s) : '';
  },
  /** 好友 Map（登录下发 + push 维护，CheckIsMyFriend 同源）；无数据源返回 null */
  friends() {
    var fr = userData() && userData().Friends;
    return fr && typeof fr.has === 'function' && typeof fr.keys === 'function' ? fr : null;
  },
  /** 联盟对象（Aid/MemberCount…）；不在盟/无数据源返回 null */
  alliance() {
    return (userData() && userData().Alliance) || null;
  },
  /** 本人数字 pid（=UserData.UID，与世界地图 p.pid 同源，已用实录核对）；取不到返回 0 */
  myPid() {
    try {
      return Number(userData() && userData().UID) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本人 UID 原始字符串（=UserData.UID.toString()，异能秘境掉落/资源「已领」判据按 uid==UID 字符串比对，与游戏侧同口径）。
   * 相比 myPid() 的 Number 化，字符串避免 64 位 UID 超安全整数时的精度陷阱；取不到返回 ''。
   * @returns {string}
   */
  myUidStr() {
    try {
      var uid = userData() && userData().UID;
      return uid != null ? String(uid) : '';
    } catch (e) {
      return '';
    }
  },
  /**
   * 本人基地战力（=UserData.Power，游戏顶栏同源；真机探针实证 Power 为明文整数 48906307，与地图 p.power 同量纲）。
   * 取不到返回 null（而非 0）：自动防御开盾的战力闸门据 null 走「未知→最悲观」保守分支，不可把「取不到」误当「战力为 0 而判我更强」。
   * @returns {number|null}
   */
  myPower() {
    try {
      var p = userData() && userData().Power;
      return p != null && !isNaN(Number(p)) ? Number(p) : null;
    } catch (e) {
      return null;
    }
  },
  /** 本人联盟 aid（=UserData.Alliance.Aid，与地图 p.aid 同源）；未入盟/取不到返回 0 */
  myAid() {
    try {
      var a = userData() && userData().Alliance;
      return Number(a && a.Aid) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本人联盟 tag 串（=UserData.Alliance.Tag，AllianceData 构造 `this.Tag = e.basic.tag` 已核对）。
   * 用于「只与同联盟成员比对」这类判据：联盟类下发（如 1585 的 ownerAllianceTag）只带 tag 不带 aid，
   * 按 aid 比对需逐 uid 反查（回调式、代价高），故 tag 字符串比对是这类全量列表的唯一可行口径。
   * @returns {string} 未入盟/取不到返回 ''（调用方据此判「无联盟」而非「匹配任意」）
   */
  myAllianceTag() {
    try {
      var a = userData() && userData().Alliance;
      return String((a && a.Tag) || '');
    } catch (e) {
      return '';
    }
  },
  /** 本人主城/账号等级（=UserData.Level，功能 open_level 门槛判据同源）；取不到返回 0 */
  level() {
    try {
      return Number(userData() && userData().Level) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本人基地世界坐标（UserData.WorldCoord，口径同 NWorldMapUIComponent 的小地图定位）。
   * @returns {{x:number, y:number}|null} 取不到/字段不全返回 null
   */
  myWorldPos() {
    var c = userData() && userData()[SYM.dataProps.worldCoord];
    if (!c || c.x == null || c.y == null) return null;
    return { x: c.x | 0, y: c.y | 0 };
  },
  // homeAirDropSpot / airDropInstances / cdSkillAvailability 已迁 feats/player/secret-weapon-drop/api.js（领域算法下沉，单消费方）
  /**
   * 道具背包持有量（UserData.getItemAmount，只读）。机甲碎片 3200001 等都走这里。
   * @param {number} itemId 道具 id
   * @returns {number} 持有数量；数据源/方法不可用返回 0
   */
  itemAmount(itemId) {
    var u = userData();
    if (!u || typeof u.getItemAmount !== 'function') return 0;
    try {
      return Number(u.getItemAmount(+itemId)) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 战争状态 Buff 的结束时刻（只读，秒）：Buff.getStateDataById(stateId).EndTime 与服务器时间比较由调用方做。
   * 自动防御用来判战争狂热（130048/130049/130132）与护盾是否在期（stateId 50001）。
   * 符号缺失/无该状态一律回 0（调用方据此判「不在该状态」——放行后仍以服务器权威拒绝为最终裁决，见 feats/battle/auto-defense）。
   * EndTime 单位实证不定时按数量级折算：>1e11 视为毫秒折回秒。
   * @param {number} stateId Buff 状态 id
   * @returns {number} 结束时刻（epoch 秒）；0=不在该状态或探测不可用
   */
  buffStateEndTime(stateId) {
    // Buff 门面是 UserData 上的 BuffPool 实例（userData().Buff），非可 require 的模块——直接 game.get('Buff') 会抛「Cannot find module」。
    // userData() 已改为实时读：切图/进战场时 UserData 被整体替换、其 .Buff 子对象一并换新，故此处绝不能再 probe 缓存该实例
    // （缓存会把首张图的 BuffPool 钉死，warFever/护盾判定读到过期 EndTime——与 selfServerId 同源的真机坑）：现读，仅校验方法在场。
    var u = userData();
    var B = u && u[SYM.dataProps.buffPool];
    if (!B || typeof B.getStateDataById !== 'function') return 0;
    try {
      var st = B.getStateDataById(+stateId);
      if (!st) return 0;
      var end = Number(st.EndTime != null ? st.EndTime : st.endTime) || 0;
      if (end <= 0) return 0;
      return end > 1e11 ? Math.floor(end / 1000) : end;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 机械大师职业 buff 读数（只读）：Buff.getBuffDataById(buffId).Value。
   * 源码实证 NWorldResourcePopup（s = UserData.Buff.getBuffDataById(e); s && s.Value && canBuildTower(s.Value)）
   * ——Value 即该资源族「本人可建的完整 buildId(bid)」（如 53006 = 粮 6 级），不是布尔/等级小数。
   * 资源族 buffId：金 1101001 / 油 1101002 / 粮 1101003 / 雷神 1101072。
   * 符号缺失、无该 buff、Value 非法一律回 0（调用方按「取不到职业上限」回退经验值）。
   * @param {number} buffId 职业 buff id
   * @returns {number} Value（完整 bid）；0=取不到
   */
  buffValueById(buffId) {
    // Buff 门面是 UserData 上的 BuffPool 实例（userData().Buff），不可 require；现读不缓存（切图整体替换 UserData）
    var u = userData();
    var B = u && u[SYM.dataProps.buffPool];
    if (!B || typeof B.getBuffDataById !== 'function') return 0;
    try {
      var d = B.getBuffDataById(+buffId);
      return (d && Number(d.Value)) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 是否处于战争狂热（禁止开盾窗口）：复刻游戏 getWarFeverState，三个狂热阶段 stateId 任一命中即真。
   * 探测不可用（Buff 符号漂移）时返回 false——放行开盾尝试，交由 910 status=3+war_fever_003 权威裁决。
   * @returns {boolean}
   */
  warFever() {
    var now = gameData.serverTime() | 0;
    if (!now) return false;
    var ids = [130048, 130049, 130132];
    for (var i = 0; i < ids.length; i++) {
      if (gameData.buffStateEndTime(ids[i]) > now) return true;
    }
    return false;
  },
  /**
   * 本人护盾是否已生效（只读，stateId 50001 的结束时刻 > 服务器时间）。探测不可用返回 false（不阻断，交由 910 裁决）。
   * @returns {boolean}
   */
  shieldActive() {
    return gameData.buffStateEndTime(50001) > (gameData.serverTime() | 0);
  },
  /**
   * 游戏权威「能否开盾」闸（只读、抑制 UI：checkShieldEnable(false)）——命中狂热/危险区/跨服限制时返回 false，一次覆盖三重判定。
   * 符号缺失返回 null（调用方降级为「不预判、直接尝试、以 910 拒绝为准」）。
   * @returns {boolean|null} true=可开 / false=不可开 / null=无从判定（符号缺失）
   */
  canShield() {
    var C = probe(SYM.modules.commonTools + '.checkShieldEnable', () => {
      var m = ns(game.get(SYM.modules.commonTools));
      return m && typeof m.checkShieldEnable === 'function' ? m : null;
    });
    if (!C) return null;
    try {
      return !!C.checkShieldEnable(false);
    } catch (e) {
      return null;
    }
  },
  /**
   * 指定世界坐标能否落城（只读，一切以游戏自身迁城判定为准，不做插件侧启发式降级）。
   * 新图优先：NWorldMapUtils.checkCanMove(x,y)（模块级函数，无需实例）；旧图回退：WorldMapController.model.checkIsPlainTile(x,y,true)（静态 model）。
   * 二者皆不可得（模块未加载/未在世界图）返回 null（→ core/defense 判「无从判定」，交上层顺延，绝不猜测）。
   * @param {number} x game x
   * @param {number} y game y
   * @returns {boolean|null} true=可落 / false=不可落 / null=无从判定
   */
  canMoveCity(x, y) {
    var A = probe(SYM.modules.nWorldMapUtils + '.checkCanMove', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapUtils);
        var U = m && (m.NWorldMapUtils || m.default || m);
        if (U && typeof U.checkCanMove === 'function') return { kind: 'utils', ref: U };
      } catch (e) {}
      try {
        var c = game.get(SYM.modules.worldMapCtrl);
        var C =
          c &&
          (c.WorldMapController || (c.default && (c.default.WorldMapController || c.default)) || c);
        var model = C && C.model;
        if (model && typeof model.checkIsPlainTile === 'function')
          return { kind: 'ctrl', ref: model };
      } catch (e) {}
      return null;
    });
    if (!A) return null;
    try {
      if (A.kind === 'utils') return !!A.ref.checkCanMove(x | 0, y | 0);
      return !!A.ref.checkIsPlainTile(x | 0, y | 0, true);
    } catch (e) {
      return null;
    }
  },
  /**
   * 城外观(skinId)占地边长（格数，只读、**场景无关**）：等价游戏 CommonTools.getCitySkinSize——直接查 SKIN 配置表 .large。
   * 用现成的 l10n.tableRow('SKIN', id) 取行、读 .large，不再 probe NWorldMapUtils.getCitySkinSize（该类无此方法，宿主应为 CommonTools，且本质就是查表）。
   * 用于把 901 单锚点还原成 footprint 格集合（4 格城 large=2）；不依赖已加载 entities，远程可用。
   * @param {number|string} skinId 城外观 id（901 城点 p.skinId，或 UserData.UsingCastleFace）
   * @returns {number|null} 边长格数（1=单格，2=2×2…）；表/行不可得或 skinId 空 → null
   */
  citySkinSize(skinId) {
    if (skinId == null) return null;
    var row = l10n.tableRow('SKIN', skinId);
    if (!row) return null;
    var s = Number(row.large != null ? row.large : row.Large) || 0;
    return s >= 1 ? s | 0 : 1;
  },
  /**
   * 本人主城外观 skinId（UserData.UsingCastleFace）；迁城落点 footprint 边长 = citySkinSize(此值)。
   * @returns {number|null} 取不到返回 null
   */
  usingCastleFace() {
    var u = userData();
    return u && u.UsingCastleFace != null ? u.UsingCastleFace : null;
  },
  /**
   * 联盟堡垒领地（禁迁区）原始条目只读快照：NWorldMapTerritoryModel 单例的 AllianceTerritory（随视口加载、出视口被 purge，故易失）。
   * 每条 {x,y,w,bw,owner,buildId} 为堡垒原点 + 旋转菱形宽高 + 归属联盟 aid；调用方据此推「实心禁迁区」（不依赖 AlliancePointPool 的奇偶采样，避免盲区漏判）。
   * 模型不可得（子包未载/未进世界图）返回 null（→ 交上层判「无从判定」，绝不猜测）；在场但当前为空返回 []。
   * @returns {Array<{x:number,y:number,w:number,bw:number,owner:number,buildId:number}>|null}
   */
  allianceTerritories() {
    // 缓存类、现读 instance：联盟领地模型与 NWorldMapData.instance 同族（subpack2 世界图单例），
    // 随视口加载/出视口 purge，切图/进战场时 instance 被重建——缓存 instance 会读到老家领地占用（真机坑）。
    var C = probe(SYM.modules.nWorldMapTerritoryModel + '.cls', function () {
      try {
        var m = game.get(SYM.modules.nWorldMapTerritoryModel);
        return (m && (m.NWorldMapTerritoryModel || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var inst = C && (C.instance || C);
    var AT = inst && inst.AllianceTerritory;
    if (!AT) return null;
    var out = [];
    for (var k in AT) {
      var it = AT[k];
      if (it && it.x != null && it.y != null)
        out.push({
          x: it.x | 0,
          y: it.y | 0,
          w: it.w | 0,
          bw: it.bw | 0,
          owner: it.owner | 0,
          buildId: it.buildId,
        });
    }
    return out;
  },
  /** 本人子服号（UserData.subServerID）；取不到返回 0——getCellIndex/cell 空间换算用 */
  subServerId() {
    try {
      return Number(userData().subServerID) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 本服是否属于 KVK（跨战区天梯）形态（GameTools.isKVK = isC4||isC8||isC8S2）。
   * **它是形态位、不是图位**（取证 extracted/GameTools__GameTools.js@34412）：三支全部走
   * `judgeKVK(e) = (1|UserData.eightServerType)-1 === e`（四国 8 / 八国 4 / 八国 S2 6），
   * 即「你这台整个赛季都算 KVK 阵营」，人回了原战区仍为真（与 CrossUtils 同名谓词同源，@1651/@1898）。
   * 需要「此刻真在跨服战场图上」的口径请读 worldState.crossMap()，不要拿本函数凑数。
   * 符号不可得保守返回 false（当本服处理，宁可多拦也不误迁被服务器拒）。
   * @returns {boolean}
   */
  isKVK() {
    var T = probe(SYM.modules.gameTools + '.isKVK', () => {
      try {
        var m = game.get(SYM.modules.gameTools);
        return (m && (m.default || m.GameTools || m)) || null;
      } catch (e) {
        return null;
      }
    });
    try {
      return !!(T && typeof T.isKVK === 'function' && T.isKVK());
    } catch (e) {
      return false;
    }
  },
  /**
   * 本服是否处于「战区/跨服对战态」（UserData.ServerState === GameDefine.ServerState.Fight）。
   * 迁城落点权威豁免源（实证 extracted WorldMapController.moveCity）：服务端「别盟堡垒领地禁迁」
   * 仅在 `(!isKVK() || !八国色号) && ServerState != Fight && owner>0 && owner!=我的Aid` 时拒绝迁入——
   * 即 ServerState==Fight（作战态）时整图放开别盟领地，与本服/KVK 图无关。符号不可得保守返回 false
   * （维持禁落，宁可不迁也不误迁）。
   * 消费方已改读 worldState.phase()（与本源同一字段、同一语义）；本函数保留作低层原语与 devtools 对照。
   * @returns {boolean} true=作战态（禁迁豁免）
   */
  serverStateIsFight() {
    try {
      var u = userData();
      var GD = probe(SYM.modules.gameDefine + '.ServerState.Fight', () =>
        ns(game.get(SYM.modules.gameDefine)),
      );
      var fight = GD && GD.ServerState && GD.ServerState.Fight;
      if (u == null || fight == null) return false;
      return u.ServerState === fight;
    } catch (e) {
      return false;
    }
  },
  /**
   * 世界格索引（NWorldMapUtils.getCellIndex(x,y,ServerId,subServerID)）：game 坐标 + 服号 + 子服 → 唯一 cell index，供 placeFlags 逐格读。符号不可得返回 null。
   * @returns {number|string|null}
   */
  mapCellIndex(x, y) {
    var U = probe(SYM.modules.nWorldMapUtils + '.getCellIndex', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapUtils);
        var u = m && (m.NWorldMapUtils || m.default || m);
        return u && typeof u.getCellIndex === 'function' ? u : null;
      } catch (e) {
        return null;
      }
    });
    if (!U) return null;
    var svr = 0,
      sub = 0;
    try {
      var u = userData();
      svr = u.ServerId | 0;
      sub = u.subServerID | 0;
    } catch (e) {}
    try {
      return U.getCellIndex(x | 0, y | 0, svr, sub);
    } catch (e) {
      return null;
    }
  },
  /**
   * settle 就绪信号：以 (x,y) 为中心 `(2r+1)²` 邻域内 placeFlags 命中格数。>0 表示该区域已随视口加载进 NWorldMapData（canMoveCity 据此可信）；
   * =0 表示区域未加载（canMoveCity 会把一切当空地误放行）。placeFlags 符号不可得返回 null（与「加载后确为空」区分）。
   * @param {number} x @param {number} y @param {number} r 邻域半宽（格）
   * @returns {number|null}
   */
  mapLoadedNear(x, y, r) {
    // 缓存类、现读 instance（与 selfServerId 同一 '.cls' 缓存）：切跨服战场时 instance（含 placeFlags）会被重建，
    // 缓存 instance 会读到老家占用（与 selfServerId 同源的真机坑）。
    var C = probe(SYM.modules.nWorldMapData + '.cls', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapData);
        return (m && (m.NWorldMapData || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var W = C && (C.instance || C);
    var pf = W && W.placeFlags;
    if (!pf || typeof pf.has !== 'function') return null;
    r = r | 0;
    var n = 0;
    for (var dx = -r; dx <= r; dx++)
      for (var dy = -r; dy <= r; dy++) {
        var idx = this.mapCellIndex((x | 0) + dx, (y | 0) + dy);
        if (idx != null && pf.has(idx)) n++;
      }
    return n;
  },
  /**
   * 每日补给（online reward）计时奖励态只读快照（UserData.timeReward，登录/630 全量下发 + 游戏 UI 领取回调回写）。
   * 可领判据由调用方算：online_reward 表第 times+1 行的 time 与 (ServerTime - rewardTime) 比较；
   * 查不到/字段非法返回 null（游戏侧 updateTimeReward 空数据时也会置 null，语义一致）。
   * @returns {{times:number, rewardTime:number}|null}
   */
  timeReward() {
    var t = userData() && userData().timeReward;
    if (!t) return null;
    var times = Number(t.times);
    var rewardTime = Number(t.rewardTime);
    if (!(times >= 0) || !(rewardTime > 0)) return null;
    return { times: times, rewardTime: rewardTime };
  },
  /**
   * 假面舞会（MASK_DANCE / cityReward 宝箱）今日领取态只读快照。
   * 数据源：push 10053 PUSH_USER_DATA_COMMON 的 `{danceRec:{<boxItemId>:次数}, myReceiveDance:[<instanceId 字符串>]}`
   *   （报文实证 dashcam 20261101T000624-2026万圣节.ndjson line 2336）。
   * 口径：
   *   - `byItem` 的键是**宝箱道具 id**（如 260617005），值是该道具今日已领次数；限额是**逐道具**口径
   *     （客户端源码实证：游戏闸门写的是 `daily_limit > itemCityRewardReceivedNum[itemId]`，
   *     ItemData.GetDes 的「今日剩余领取次数」也按单个 itemId 算），跨道具 id 求和当分母会把
   *     「每种各 N 次」误压成「全族共 N 次」，导致多道具年份提前静默封顶；
   *   - `instIds` 是**已领舞会实例 id 的字符串数组**（19 位，禁 Number 化），同实例只能领一次——`cityReward.players[]`
   *     只是展示名单不含 uid，不可作幂等判据；
   *   - 登录期是否全量下发仍未实证（§4-2 已由源码解决「字段叫什么」，未解决「什么时候有」），
   *     故拿不到字段时返回 null 而非空态——调用方须回落到自己的镜像。
   * @returns {{byItem:Object<string,number>, instIds:string[]}|null} 数据源/字段不可得返回 null
   */
  maskDanceState() {
    var u = userData();
    if (!u) return null;
    // 候选名：SYM.dataProps 登记的线上键 + 客户端源码里的语义名（UserItemCityRewardBtn 读的两个 getter）。
    // 角色一律由候选表**显式声明**，不靠名字正则猜：`itemCityRewardReceivedInstIds` 里的 "Rec" 会被次数表
    // 判据命中，而数组的 typeof 也是 'object'——一旦被误归成 rec，调用方 `for in` 会拿到 19 位实例 id 串，
    // Number 化后（精度已丢，破 Int64 红线）把「今日已领次数」拉成天文数字，导致当日静默封顶永不领取。
    var roles = [
      { role: 'rec', names: ['itemCityRewardReceivedNum', SYM.dataProps.danceRec] },
      { role: 'insts', names: ['itemCityRewardReceivedInstIds', SYM.dataProps.myReceiveDance] },
    ];
    var rec = null;
    var insts = null;
    for (var r of roles) {
      for (var name of r.names) {
        var v;
        try {
          v = u[name];
        } catch (e) {
          v = null;
        }
        if (v == null || v === '') continue;
        if (r.role === 'rec') {
          if (typeof v === 'object' && !Array.isArray(v)) rec = rec || v;
        } else if (Array.isArray(v)) {
          insts = insts || v;
        }
      }
    }
    if (!rec && !insts) return null;
    var byItem = {};
    for (var k in rec || {}) {
      var n = Number(rec[k]);
      // 安全阀：「今日已领次数」的量级不可能超过 1000，越界即视为误收的脏数据直接丢弃——
      // 封顶判据宁可少计（多发一次被拒请求），也不可被拉爆成恒真（当天一座都领不到且无法归因）。
      if (Number.isFinite(n) && n >= 0 && n <= 1000) byItem[String(k)] = n;
    }
    return { byItem: byItem, instIds: (insts || []).map(String) };
  },
  /**
   * 每日特惠（hero daily deal）免费奖励领取态只读快照（UserData.heroDailyDealGiftIsReceived，
   *   游戏字段来源 choose_hero_daily_reward：登录全量下发 + push 10053 PUSH_USER_DATA_COMMON 回写）。
   * 口径与游戏 HeroDailyDealGiftShopNode.refreshFreeRewardItem 同判据：
   *   0=今日可领、1=今日已领、-1=构造默认（数据未同步/玩法未对该玩家开），拿不到 UserData 返回 null。
   * @returns {number|null}
   */
  heroDailyDealReceived() {
    var u = userData();
    if (!u) return null;
    var v = u.heroDailyDealGiftIsReceived;
    if (v == null || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  /**
   * 联盟机甲本地态快照（Alliance.AllianceBossData 的 getter，游戏由 push 10435 / 1160 / 1161 应答刷新）。
   * 口径提醒：todayTime / todayFree 两字段由 updateData 的 `null != e.todayTime` 守卫单独维护，
   * 而 push 10435 的载荷里没有它们（只有 allianceBoss 一块）→ 未开面板时恒为构造默认 0，不可据此判免费。
   * state 构造默认 -1（未开启），与「本服没这套玩法/联盟未召唤」同义。
   * @returns {object|null} {state,bossId,x,y,exp,hp,endTime,summonTime,pointSid,help}；对象不可用返回 null
   */
  allianceBoss() {
    // 现读、不缓存：Alliance.AllianceBossData 是游戏由 push 10435/1160/1161 刷新的数据容器，
    // userData() 已实时化，切图/进战场时其 .Alliance 子链随之换新——probe 钉住首块会在刷新后读到过期机甲态。
    var a = userData() && userData().Alliance;
    var src = a && a[SYM.dataProps.allianceBoss];
    if (!src || typeof src.State !== 'number') return null;
    try {
      return {
        state: src.State | 0,
        bossId: src.BossId | 0,
        x: src.X | 0,
        y: src.Y | 0,
        exp: Number(src.Exp) || 0,
        hp: Number(src.Hp) || 0,
        endTime: Number(src.EndTime) || 0,
        summonTime: Number(src.SummonTime) || 0,
        pointSid: src.PointSid | 0,
        help: src.Help | 0,
      };
    } catch (e) {
      return null;
    }
  },
  /**
   * 联盟科技本地态快照（Alliance.scienceData 的只读 getter/方法，游戏由 1143 应答 / push 10430/10432 刷新）。
   * 口径：recommendId 为官员推荐项（0=无推荐）；costCoin 走游戏
   * getCostCoin()（PLAYER_LEVEL[等级].donation_gold，随等级变）；dailyHonor 为今日已获荣誉
   * （科技捐与遗迹捐共用同一计数：1067 应答 curPoint 直接写回 donateDailyHonor，抓包实证）。
   * firstDonateable：按游戏弹窗 showBtn 同款可捐口径扫的第一项（诊断用，快速作战 10900 已排除不会命中）——
   *   isLock()（ItemData 方法：sid=10400 恒 false，服务器初始化后为 true）且 !isMaxLevel()（未满级）
   *   且 isStatus()（status==0，即非研究中；研究中捐赠按钮被隐藏）；找不到返回 null。
   * donateTarget：本轮真正该捐的「普通科技」目标（出个人荣誉那条），已把可捐校验与优先级合成——
   *   推荐项（RecommendId，即 sid）必须自身通过同一 canDon 口径且不是排除项才被采纳，否则回退首个可捐的
   *   **非排除**项；两者皆无则 null（快速作战 10900 按用户定案不捐，从目标合成中整体排除）。
   *   这是对「满级/研究中的推荐项直接捐会被服务器拒」的修正，也是对「10900 霸占首项导致常驻高频捐赠」的修正。
   * honorCap：今日荣誉上限，走游戏 Alliance.getAllianceScienceScore()（内部读 DATACONFIG 16005），
   *   取不到为 0（上层据此不设此闸）。
   * @returns {object|null} {recommendId,recommendName,dailyHonor,honorCap,costCoin,firstDonateable,donateTarget,donateRecommended}；不在盟/数据未填充返回 null
   */
  allianceScience() {
    // 现读、不缓存（同 allianceBoss：游戏由 1143 应答 / push 10430/10432 刷新该容器，缓存会在刷新后读到过期科技态）
    var a = userData() && userData().Alliance;
    var src = a && a[SYM.dataProps.allianceScience];
    if (!src || !Array.isArray(src.scienceDevDataList) || typeof src.getCostCoin !== 'function')
      return null;
    try {
      // 可捐口径（弹窗 showBtn 的捐赠按钮分支）：已解锁且未满级且非研究中
      var canDon = function (it) {
        return !!(
          it &&
          typeof it.isLock === 'function' &&
          it.isLock() &&
          !it.isMaxLevel() &&
          it.isStatus()
        );
      };
      var nameOf = function (it) {
        return it && typeof it.getName === 'function' ? String(it.getName() || '') : '';
      };
      var recId = Number(src.RecommendId) || 0;
      // 一趟扫描收两个口径：任意首项（诊断）/ 首个可捐普通项（普通链回退）；排除项 10900 不参与任何口径
      var first = null;
      var firstNormal = null;
      var lists = [src.scienceDevDataList, src.scienceWarDataList];
      for (var li = 0; li < lists.length; li++) {
        var arr = lists[li] || [];
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!canDon(it)) continue;
          var id = Number(it.sid) || 0;
          if (id === SCIENCE_SID_EXCLUDE_DONATE) continue; // 快速作战不捐（用户定案）
          if (!first) first = { scienceId: id, name: nameOf(it) };
          if (!firstNormal) firstNormal = { scienceId: id, name: nameOf(it) };
          if (first && firstNormal) break;
        }
        if (first && firstNormal) break;
      }
      // 普通链目标：推荐项须自身可捐且非排除项才采纳，否则回退首个可捐的非排除项
      var target = null,
        recommended = false,
        recName = '';
      if (recId > 0 && recId !== SCIENCE_SID_EXCLUDE_DONATE) {
        var rec = src.getScienceItemDataByGroupId(recId);
        if (canDon(rec)) {
          target = { id: recId, name: nameOf(rec) };
          recommended = true;
          recName = target.name;
        }
      }
      if (!target && firstNormal) {
        target = { id: firstNormal.scienceId, name: firstNormal.name };
      }
      var a2 = userData().Alliance;
      var cap =
        a2 && typeof a2.getAllianceScienceScore === 'function'
          ? Number(a2.getAllianceScienceScore()) || 0
          : 0;
      return {
        recommendId: recId,
        recommendName: recName,
        dailyHonor: Number(src.donateDailyHonor) || 0,
        honorCap: cap,
        costCoin: Number(src.getCostCoin()) || 0,
        firstDonateable: first,
        donateTarget: target,
        donateRecommended: recommended,
      };
    } catch (e) {
      return null;
    }
  },
  /**
   * 联盟遗迹（要塞，WorldSite）本地态快照：本盟名下要塞（getWorldSiteArrayBy 只筛 Owner.Aid==盟 id）。
   * 可捐口径同游戏红点 checkWorldSiteDonateRedPoint / 弹窗 showBtn 的捐赠分支：
   *   未满级 CurLevel < DistrictData.upper_level_limit 且经验未满 CurExp < relic_upgrade[CurLevel-1]
   *   （升级是官员独立动作，捐赠本身不看 State）。
   * donateTarget：推荐位 recommendSite（即 1070 应答 a.recommend，与 WorldSiteData.Id 同 id 空间）
   *   必须自身命中一个可捐要塞才采纳，否则回退 firstDonateable；两者皆无返回 null。
   * recommendSite 由控制器 instance 维护（登录组装链与每日零点自动发 1070 刷新，此处只读）。
   * 遗迹没有批量捐口径（游戏弹窗只有单捐按钮），故只给目标不给枚数。
   * @returns {object|null} {recommendSite,firstDonateable,relicCostCoin,donateTarget,donateRecommended}；数据源缺失返回 null
   */
  allianceRelic() {
    var src = probe('AllianceWorldSiteController.instance', () => {
      // 该模块是 ES 命名空间具名导出（exports.AllianceWorldSiteController，无 .default），
      // 不能用 ns() 解包（会把壳的 .default 为 undefined 当成解包结果）
      var m = game.get(SYM.modules.worldSiteCtrl);
      var C =
        m &&
        (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController));
      // 先读私有 _instance（零副作用）；尚未建立时才走 instance getter 懒建（与游戏自身同一路径）
      var inst = (C && C._instance) || (C && C.instance);
      return inst && typeof inst.recommendSite === 'number' ? inst : null;
    });
    var u = userData();
    if (!src || !u || !u.Alliance || typeof u.getWorldSiteArrayBy !== 'function') return null;
    try {
      var aid = Number(u.Alliance.Aid) || 0;
      if (aid <= 0) return null;
      var sites = u.getWorldSiteArrayBy(aid) || [];
      var recSite = Number(src.recommendSite) || 0;
      var first = null,
        recDonateable = false;
      for (var i = 0; i < sites.length; i++) {
        var s = sites[i];
        var dd = s && s.DistrictData;
        if (!dd || !dd.relic_upgrade) continue;
        var need = Number(String(dd.relic_upgrade).split('|')[Number(s.CurLevel) - 1]) || 0;
        if (Number(s.CurLevel) < Number(dd.upper_level_limit) && Number(s.CurExp) < need) {
          var sid = Number(s.Id) || 0;
          if (!first) first = { siteId: sid, name: String(s.SiteName || s.SiteDefaultName || '') };
          if (recSite > 0 && sid === recSite) recDonateable = true;
        }
      }
      // 两级目标：推荐位须自身可捐才采纳，否则回退首项
      var target = null,
        recommended = false;
      if (recSite > 0 && recDonateable) {
        target = { id: recSite, name: '' };
        recommended = true;
      } else if (first) {
        target = { id: first.siteId, name: first.name };
      }
      var sd = u.Alliance[SYM.dataProps.allianceScience];
      var relicCost =
        sd && typeof sd.getCostCoin === 'function' ? Number(sd.getCostCoin(true)) || 0 : 0;
      return {
        recommendSite: recSite,
        firstDonateable: first,
        relicCostCoin: relicCost,
        donateTarget: target,
        donateRecommended: recommended,
      };
    } catch (e) {
      return null;
    }
  },
  /**
   * 联盟守卫（巨兽，AllianceBehemoth）本地态快照：只读守卫养成数据，产出可捐列表供 feat 逐条判定。
   * 数据由游戏登录/联盟刷新链（UserData.getAllianceBehemothData → 7101）填充，本方法不发包、只读内存。
   * open：功能开启闸（在盟 && FunctionOn(alliance_behemoth) && UserData.behemothIsOpen）；关则不披露 items。
   * items：每项 {behemothId, level, exp, isUnlock, levelCap}，level/exp 取服务端回写的 serverData，
   *   levelCap 取 behemoth_cultivate 表行（level>=levelCap 即满级不可捐）。是否真能捐由 feat
   *   再叠加能量池 13 与升级消耗道具（behemoth_level[level].lvup_cost）判定，这里不做消耗校验。
   * @returns {object|null} {open:boolean, items:[{behemothId,level,exp,isUnlock,levelCap}]}；UserData/Alliance 不可用返回 null
   */
  allianceBehemoth() {
    var u = userData();
    var a = u && u.Alliance;
    if (!u || !a || typeof a.isInAlliance !== 'function') return null;
    var inAlliance;
    try {
      inAlliance = !!a.isInAlliance();
    } catch (e) {
      inAlliance = false;
    }
    if (!inAlliance || !gameData.functionOn('alliance_behemoth') || !u.behemothIsOpen) {
      return { open: false, items: [] };
    }
    // 现读、不缓存（同上：a=userData().Alliance 本调用内已实时取，其 behemoth 容器随 push 刷新）
    var src = a && a[SYM.dataProps.allianceBehemoth];
    if (!src || typeof src.getAllianceBehemothData !== 'function') return { open: true, items: [] };
    try {
      var map = src.getAllianceBehemothData(); // Map<behemothId, AllianceBehemothItemData>
      var items = [];
      if (map && typeof map.forEach === 'function') {
        map.forEach(function (it) {
          var sd = it && it.serverData;
          if (!sd) return;
          items.push({
            behemothId: Number(sd.behemothId) || 0,
            level: Number(sd.level) || 0,
            exp: Number(sd.exp) || 0,
            isUnlock: !!sd.isUnlock,
            levelCap: (it.cfg && Number(it.cfg.level_cap)) || 0,
          });
        });
      }
      return { open: true, items: items };
    } catch (e) {
      return { open: true, items: [] };
    }
  },
  /**
   * 功能开关位只读查询（UserData.FunctionOn(FunctionKey 字符串名)，枚举定义在 GameDefine）。
   * 典型用法：捐遗迹前查 Relic_upgrade_time（查不到/未开返回 false，宁可不捐）。
   * @param {string} key FunctionKey 成员名
   * @returns {boolean}
   */
  functionOn(key) {
    var u = userData();
    var gd = probe(SYM.modules.gameDefine, () => ns(game.get(SYM.modules.gameDefine)));
    var k = gd && gd.FunctionKey && gd.FunctionKey[key];
    if (!u || typeof u.FunctionOn !== 'function' || typeof k !== 'string' || !k) return false;
    try {
      return !!u.FunctionOn(k);
    } catch (e) {
      return false;
    }
  },
  /**
   * 异能兽培育玩法开启闸只读查询（源码锚点 extracted/subpack/RealEnigmaBeastController 的 isOpenFunc(BeastOpenType.BREED, false)）：
   *   FunctionOn(enigma_beast_breeding) && openState ≥ BeastServerStatus.BREED —— suppressTips 传 false，纯查询不弹提示。
   * 「活动未开始/未解锁」时服务器对 1570/1582/1583/1585 干脆不回包（15s 超时），调用方据此整轮闭嘴；
   *   控制器/枚举符号缺失（subpack 未接管）一律回 false（未证实可开 = 不开，宁不发也不撞超时）。
   * @returns {boolean}
   */
  beastBreedOpen() {
    if (!gameData.functionOn('enigma_beast_breeding')) return false;
    try {
      var m = game.get(SYM.modules.enigmaBeastCtrl);
      var cls = m && (m.default || m);
      var inst = cls && typeof cls.getInstance === 'function' ? cls.getInstance() : null;
      if (!inst || typeof inst.isOpenFunc !== 'function') return false;
      var enumObj = (m && m.BeastOpenType) || (cls && cls.BeastOpenType);
      var breedType = enumObj && enumObj.BREED != null ? Number(enumObj.BREED) : 3; // 兜底实证值：BeastOpenType BREED=3
      return inst.isOpenFunc(breedType, false) === true;
    } catch (e) {
      return false;
    }
  },
  /**
   * 「一键领取 / 集中领取」(TaskRelax) 可用行只读枚举 —— 复刻游戏 TaskRelaxTool.getOpenQuickSweepList 的三级开启闸，
   *   返回空数组即代表该玩家不具备此功能（游戏主城里 bot 入口不会显示），调用方据此整功能挂起。
   *   源码锚点 extracted/subpack/TaskRelaxTool__TaskRelaxTool.js；报文实证 dashcam 20261011T172802-一键领取.ndjson（5684 INFO / 5685 REWARD）。
   *   开启闸（全部只读，不发包、不改写本地数据）：
   *     ① 账号总闸 FunctionOn(task_relax_claim_all)；
   *     ② 服务器灰度闸 serverTransferRange 命中 DataConfig 79089 白名单（缺配=未放量）；
   *     ③ 逐 task_relax 行：Level>=row.level 且该行玩法已解锁（taskRelaxTypeOpen 同口径）。
   * @returns {Array<{id:number,type:number,level:number,order:number}>} 可用行（按 order 升序）；空=功能未开启
   */
  taskRelaxOpenRows() {
    var u = userData();
    if (!u) return [];
    if (!gameData.functionOn('task_relax_claim_all')) return [];
    // 服务器灰度闸：serverTransferRange 必须在 DataConfig 79089 白名单内（缺配 → 空串 split 不含 range → 功能未放量）
    var wl = String(gameConf.dataConfig(TASK_RELAX_RANGE_CFG) || '');
    if (
      wl.split(',').indexOf(String(u.serverTransferRange == null ? '' : u.serverTransferRange)) < 0
    ) {
      return [];
    }
    var rows = l10n.tableRows('task_relax');
    var lv = gameData.level();
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (lv >= Number(r.level) && taskRelaxTypeOpen(r.type)) out.push(r);
    }
    out.sort(function (a, b) {
      return (Number(a.order) || 0) - (Number(b.order) || 0);
    });
    return out;
  },
  /**
   * 能量池快照（UserData.getEnergy(EnergyType数值)，EnergyData 的 Point getter 实时折算自然恢复）。
   * 联盟捐赠次数池实证（抓包 20260930）：type=4，pointMax=10，restoreSec=1800（每 30 分钟回 1 点）。
   * @param {number} type EnergyType 数值（如 4=ALLIANCE_DONATE_NUM）
   * @returns {object|null} {point,pointMax,nextRecoverSec}；数据源缺失返回 null
   */
  energy(type) {
    var u = userData();
    if (!u || typeof u.getEnergy !== 'function') return null;
    var e;
    try {
      e = u.getEnergy(+type);
    } catch (err) {
      return null;
    }
    if (!e) return null;
    return {
      point: Number(e.Point) || 0,
      pointMax: Number(e.PointMax) || 0,
      nextRecoverSec: Number(e.NextPointRecoverTime) || 0,
    };
  },
  /** 金币余额（UserData.Resource.Coin）；数据源缺失返回 0 */
  coins() {
    var r = userData() && userData().Resource;
    return r ? Number(r.Coin) || 0 : 0;
  },
  /**
   * 次元矿洞矿种规格表（mine_cave）全量行，惰性缓存（配置表页面生命周期内不变）。
   * 行字段实证：`id`(specId)、`type`(矿种)、`level`(矿等级)、`star`(稀有度)、`name`(语言键)、
   * `model`(矿图标)、`hero_color`/`hero_star`/`hero_level`(占领英雄需求串 `数量,门槛|…`)。
   * @returns {Array<{id:number,type:number,level:number,star:number,name:string,model:string,
   *   hero_color:string,hero_star:string,hero_level:string}>} 表未就绪返回 []
   */
  mineSpecs() {
    return (
      probe('mine_cave.specs', () => {
        var rows = l10n.tableRows('mineCave');
        return rows && rows.length ? rows : null;
      }) || []
    );
  },
  /**
   * 单个矿种规格行（按 specId 查，走 mineSpecs 缓存）；查不到返回 null。
   * @param {number|string} specId simpleInfo.specId
   * @returns {object|null}
   */
  mineSpec(specId) {
    var rows = gameData.mineSpecs();
    var sid = Number(specId);
    for (var i = 0; i < rows.length; i++) if (Number(rows[i].id) === sid) return rows[i];
    return null;
  },
  /**
   * 矿洞槽位配置行（mine_cave_level 按 pos 查）：`is_ally`(1=只能分享给盟友采)、`player_level`(解锁门槛)。
   * @param {number|string} pos simpleInfo.pos（1..5）
   * @returns {object|null} 缺行返回 null
   */
  mineSlotPos(pos) {
    return l10n.tableRow('mineCaveLevel', pos);
  },
  /**
   * 矿洞交互配置行（mine_cave_interaction）：id="3" 的 `help_accept` = 单矿可被偷次数上限（报告 §4.2 实证）。
   * @param {number|string} id 交互行 id
   * @returns {object|null}
   */
  mineInteraction(id) {
    return l10n.tableRow('mineCaveInteraction', id);
  },
  /**
   * 可用英雄池（占领矿洞派兵用）：UserData.Heros 中在场且未过期的英雄，对齐游戏
   * HeroController.getHaveHeroList 口径（Is_show===1 且非 ExpireTime 过期）。只读，不改动源。
   * @returns {Array<{id:number,level:number,star:number,quality:number}>} 数据源缺失返回 []
   */
  heroPool() {
    var u = userData();
    var heros = u && u.Heros;
    if (!heros) return [];
    var now = 0;
    try {
      now = +game.get(SYM.modules.dataCenter).DATA.ServerTime || 0;
    } catch (e) {}
    var out = [];
    for (var k in heros) {
      var h = heros[k];
      if (!h || Number(h.Is_show) !== 1) continue;
      if (h.TryOut && Number(h.ExpireTime) > 0 && Number(h.ExpireTime) < now) continue;
      out.push({
        id: Number(h.Id != null ? h.Id : k) || 0,
        level: Number(h.Level) || 0,
        star: Number(h.Star) || 0,
        quality: Number(h.Quality) || 0,
      });
    }
    return out;
  },

  // ─────────────────────── 遗迹奖励领取（只读，供 feats/alliance/relic-reward.js） ───────────────────────
  /**
   * 奖励配置 id → 道具清单（只读，经 RewardController.Instance.getRewardsArrById 实时解析，与游戏面板同源）。
   * RewardController 是 ES 命名空间具名导出（exports.RewardController=类，无 .default），故不能 ns() 解包；
   * Instance 是类上的静态单例访问器，getRewardsArrById 为其实例方法。符号缺失/解析失败返回 []。
   * @param {number|string} rewardId 奖励配置 id（如 8301745，即 1825 应答 select[] 里的值）
   * @returns {Array<{type:number,id:number,count:number,name:string}>} 道具清单；不可用返回 []
   */
  rewardItems(rewardId) {
    var C = probe(SYM.modules.rewardCtrl, function () {
      var m = game.get(SYM.modules.rewardCtrl);
      var K = m && (m.RewardController || (m.default && m.default.RewardController));
      return K && K.Instance && typeof K.Instance.getRewardsArrById === 'function' ? K : null;
    });
    if (!C || !C.Instance) return [];
    try {
      var arr = C.Instance.getRewardsArrById(Number(rewardId));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  },
  /**
   * 本盟指定等级/功能的道具遗迹候选快照（全程零发包，只读合成）。
   * 遗迹清单权威源：UserData.getWorldSiteArrayBy(盟 id)（只筛 Owner.Aid==盟 id，地图/登录时填充，始终可用）；
   * 按 DistrictData.stronghold_level==level && DistrictData.function==funType 过滤（2 级道具= level 2、funType 4=ITEM）。
   * 窗口态（select/have/joinTime/endTime/cfgId）来自 AllianceWorldSiteController.instance.myItemSiteData[wonderId]——
   *   该表仅由游戏自身的 1070/1825 应答填充（脚本直发不经游戏回调、不回写它），故可能缺省/陈旧；缺条目时
   *   select/have 为 undefined、ready=false，调用方（feat）须自行发 1825 拿权威值再判。
   * ready 口径同游戏红点 getItemWorldSiteRed：sp_fortress_item[cfgId].choose_num - have.length > 0 且
   *   ServerTime - joinTime > join_time（入盟冷却）且 otherToday != 1。
   * @param {number} level 要塞等级（2 = 道具遗迹本功能关注）
   * @param {number} funType WorldSiteFunType 数值（4 = ITEM 道具）
   * @returns {Array<{wonderId:number,cfgId:number,name:string,chooseNum:number,joinSec:number,select:Array<number>|undefined,have:Array<number>|undefined,joinTime:number,endTime:number,ready:boolean,leftTimes:number}>}
   */
  relicRewardSites(level, funType) {
    var u = userData();
    if (!u || typeof u.getWorldSiteArrayBy !== 'function') return [];
    var aid = Number(u.Alliance && u.Alliance.Aid) || 0;
    if (aid <= 0) return [];
    var inst = probe('AllianceWorldSiteController.itemInst', function () {
      var m = game.get(SYM.modules.worldSiteCtrl);
      var C =
        m &&
        (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController));
      var it = (C && C._instance) || (C && C.instance);
      return it && it.myItemSiteData ? it : null;
    });
    var mine = (inst && inst.myItemSiteData) || {};
    var now = gameData.serverTime();
    var out = [];
    var sites;
    try {
      sites = u.getWorldSiteArrayBy(aid) || [];
    } catch (e) {
      return [];
    }
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      var dd = s && s.DistrictData;
      if (!dd || Number(dd.stronghold_level) !== level || Number(dd.function) !== funType) continue;
      var wonderId = Number(s.Id) || 0;
      if (!wonderId) continue;
      var d = mine[wonderId];
      var cfgId = d ? Number(d.id) || 0 : 0;
      var row = cfgId ? l10n.tableRow('sp_fortress_item', cfgId) : null;
      var chooseNum = row ? Number(row.choose_num) || 0 : 0;
      var joinSec = row ? Number(row.join_time) || 0 : 0;
      var have = d && Array.isArray(d.have) ? d.have : undefined;
      var left = row && have ? chooseNum - have.length : 0;
      var ready =
        !!(row && have && d) &&
        Number(d.otherToday) !== 1 &&
        left > 0 &&
        now - Number(d.joinTime || 0) > joinSec;
      out.push({
        wonderId: wonderId,
        cfgId: cfgId,
        name: String((s && (s.SiteName || s.SiteDefaultName)) || ''),
        chooseNum: chooseNum,
        joinSec: joinSec,
        select: d && Array.isArray(d.select) ? d.select : undefined,
        have: have,
        joinTime: d ? Number(d.joinTime) || 0 : 0,
        endTime: d ? Number(d.endTime) || 0 : 0,
        ready: ready,
        leftTimes: left > 0 ? left : 0,
      });
    }
    return out;
  },
  /**
   * 本人行军名额快照（UserData.myMarchNum 已用 / myMarchNumMAX 上限，服务端跨场景同步、比 mapData.marches 可靠）。
   * 只读、无副作用；数据源缺失回 {used:0,max:0}（上层 freeSlots 据此算 0，不主动拦）。
   * @returns {{used:number, max:number}}
   */
  marchCount() {
    var u = userData();
    if (!u) return { used: 0, max: 0 };
    return { used: Number(u.myMarchNum) || 0, max: Number(u.myMarchNumMAX) || 0 };
  },
  // coinState 快照能力已迁 feats/player/auto-coin-collect/api.js（领域算法下沉，单消费方）
};

// ─────────────────────── 战斗预设 / 头像 → core/acl/{battle-preset,avatar}.js（片4，见文件头 import 与 re-export） ───────────────────────

export const gameConf = {
  /**
   * 配置数据表值（TableUtils.getDataConfigData；配置 id → 字符串/数值）。
   * @param {number} id 配置 id（如撤回时限 630061）
   * @returns {string|number} 模块不可用/未命中返回 ''
   */
  dataConfig(id) {
    var tu = probe(SYM.modules.tableUtils + '.getDataConfigData', () => {
      // TableUtils 为 TS 转译的 ES 命名空间（getDataConfigData 挂在 .default 下），用 ns 解包，
      // 否则取到的是命名空间壳、方法恒 undefined → 探测失败、DataConfig 读取降级（实测踩过）。
      var m = ns(game.get(SYM.modules.tableUtils));
      return m && typeof m.getDataConfigData === 'function' ? m : null;
    });
    if (!tu) return '';
    try {
      return tu.getDataConfigData(+id) || '';
    } catch (e) {
      return '';
    }
  },
};
