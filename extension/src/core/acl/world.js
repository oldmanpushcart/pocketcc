/**
 * ACL 域切片 · 世界地图只读 + 世界态原始信号（core/acl/world.js）
 * 原 core/game-api.js 的 worldMap / worldSignals 区段（含 mapBiz/mapBizEnum/serverStateEnum/
 * enumNameOf/crossFlag helper），按域拆分片4逐字迁出（行为零变化）。
 * worldSignals 是 core/world/state.js 的唯一判据源；秘境判据经引擎 worldSlot('pabBattleMap')
 * 取 feat 回挂的适配器（未注册保守回 false）。全部只读查询，符合「只读 + 发包」红线。
 */
import { game } from '../game.js';
import { SYM, probe, ns, userData, worldSlot, sharedValue } from '../acl-engine.js';
import { scene } from './scene.js';
import { crossUtils } from './march.js';

/**
 * 世界地图只读能力（全局地图 feat 用）：地形查询、全图尺寸、当前 mapType、本服服号。
 * 全部惰性探测 + 缺失软失败——地形符号缺失时底图降级为纯色占位（terrain.js 兜底），
 * 不阻断已扫实体的渲染；这些都是只读查询，符合「只读 + 发包」红线。
 */
export const worldMap = {
  /**
   * 离线地形模型单例（NWorldMapTerrainModel.instance）：暴露 getTerrain/getAreaByWorldMap/isBlock/cols/rows。
   * @returns {object|null} 单例；符号漂移/子包未载入返回 null
   */
  terrainModel() {
    // 缓存类、现读 instance：cols/rows/currentMapType/getTerrain/isBlock 是「当前这张图」的数据，
    // 切图/进独立战场图时单例被重建（与 selfServerId/mapLoadedNear 的 NWorldMapData.instance 同族，真机已证）——
    // 缓存 instance 会让迁城落点合法性/isBlock 按老家地形判定。
    var C = probe(SYM.modules.terrainModel + '.cls', () => {
      var m = ns(game.get(SYM.modules.terrainModel));
      return (m && (m.NWorldMapTerrainModel || m.default || m)) || null;
    });
    var inst = C && C.instance;
    return inst || null;
  },
  /**
   * 当前地图类型（决定用哪张 mapFiles 与 allMapInfos 尺寸档）；取不到返回 0。
   * 首选地形模型自带 getter currentMapType（源码里它 = NWorldMapCoreBiz.mapType，随场景实时、
   * 且模块引用已在 terrainModel 就绪时解析）。
   * @returns {number}
   */
  mapType() {
    var tm = this.terrainModel();
    if (tm) {
      var t = tm.currentMapType;
      if (typeof t === 'number' && t) return t;
    }
    return 0;
  },
  /**
   * 全图尺寸（cell 口径）：优先 terrainModel.cols/rows，退 NWorldMapCommon.allMapInfos[mapType]；都缺返回 null。
   * @returns {{cols:number, rows:number}|null}
   */
  size() {
    var tm = this.terrainModel();
    if (tm && tm.cols > 0 && tm.rows > 0) return { cols: tm.cols | 0, rows: tm.rows | 0 };
    var mt = this.mapType();
    return probe('NWorldMapCommon.allMapInfos.' + mt, () => {
      var m = ns(game.get(SYM.modules.mapCommon));
      var infos = m && (m.allMapInfos || (m.NWorldMapCommon && m.NWorldMapCommon.allMapInfos));
      var info = infos && infos[mt];
      return info && info.cols > 0 && info.rows > 0
        ? { cols: info.cols | 0, rows: info.rows | 0 }
        : null;
    });
  },
  /**
   * 本服服号（901 请求体 k）：尽力从 UserData 多候选字段取；取不到返回 0（scanner 会以应答回显兜底）。
   * @returns {number}
   */
  serverId() {
    var u = userData();
    if (!u) return 0;
    var v =
      u.ServerId != null
        ? u.ServerId
        : u.serverId != null
          ? u.serverId
          : u.Sid != null
            ? u.Sid
            : u.s;
    return Number(v) || 0;
  },
  /**
   * 视角所在服号（当前正在看的区）：读 window.NWorldMapController.getCurServerId()
   * （游戏把控制器实例直接挂 window；serverData.currentServerId 在 initMap 置本服号，
   * 跨区观战/盟决/切区时由 SERVER_VIEW_CHANGE 链路更新为被看区 TargetId）。
   * 子包未载/方法缺失/返回 0 时回退本服 serverId()。
   * @returns {number}
   */
  viewServerId() {
    try {
      var c = window.NWorldMapController;
      if (c && typeof c.getCurServerId === 'function') {
        var v = Number(c.getCurServerId()) || 0;
        if (v) return v;
      }
    } catch (e) {}
    return this.serverId();
  },
  /**
   * 本图「自己所在服号」（NWorldMapData.instance.serverData.selfServerId，initMap 时按登录回包 currk 建立，
   * 跨区拖镜头/看别区都**不**随视口变化）。游戏原生「定位自己主城」（NWorldMapComponent.onKeyDown / Backspace）
   * 用的就是它，配 UserData.WorldCoord（区内局部格号）—— 两者同源同帧，才是唯一正确搭配。
   * 与 viewServerId() 的区别：后者是「此刻镜头在看哪个区」，拿来当跳转服号会把本服坐标塞进别区偏移。
   * 子包未载/字段缺失返回 0（调用方应回退 UserData.ServerId，即 nav.flyTo 不传 z 让游戏自己兜底）。
   * @returns {number}
   */
  selfServerId() {
    // 缓存 NWorldMapData 类（__require 模块缓存，跨图稳定），`.instance` 静态字段每次现读。
    // ⚠ 别缓存 instance：进图/切跨服战场时游戏会重建 instance（连带其 serverData），把 instance 交给
    //   probe 缓存会把首张图（登录/老家）的 selfServerId 钉死整场页面（真机实证：已在 4337，缓存 instance 仍返回 4336）。
    var C = probe(SYM.modules.nWorldMapData + '.cls', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapData);
        return (m && (m.NWorldMapData || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var W = C && (C.instance || C);
    return Number(W && W.serverData && W.serverData.selfServerId) || 0;
  },
  /**
   * 当前可活动地图的 game 坐标边界（迁城落点收口用）：绑游戏自身
   * NWorldMapUtils.getMapGameSizeBySubMap(subServerID)——内建 subMap 分支，比硬编码
   * 常量对活动图（KVK/天梯/CAB/无双/尺寸不同图）更准；返回 game 口径 {xMax,yMax}
   * （width 已含 x 双倍，故 -1 得合法上界）。符号缺失/尺寸非法返回 null（调用方回退硬编码常量）。
   * @returns {{xMax:number, yMax:number}|null}
   */
  gameBounds() {
    var U = probe(SYM.modules.nWorldMapUtils + '.getMapGameSizeBySubMap', () => {
      try {
        var m = game.get(SYM.modules.nWorldMapUtils);
        var u = m && (m.NWorldMapUtils || m.default || m);
        return u && typeof u.getMapGameSizeBySubMap === 'function' ? u : null;
      } catch (e) {
        return null;
      }
    });
    if (!U) return null;
    var gd = sharedValue('gameData');
    if (!gd) return null; // 插槽未注册（常态不会发生）：无从换算尺寸，调用方自兑底
    try {
      var s = U.getMapGameSizeBySubMap(gd.subServerId());
      var w = s && (s.width != null ? s.width : s.x),
        h = s && (s.height != null ? s.height : s.y);
      return w > 0 && h > 0 ? { xMax: (w | 0) - 1, yMax: (h | 0) - 1 } : null;
    } catch (e) {
      return null;
    }
  },
};

// ─────────────────────── 世界态原始信号（core/world/state.js 的唯一判据源） ───────────────────────

/**
 * NWorldMapCoreBiz 业务单例（mapType / watchingType 的权威宿主）。
 * 与 worldMap.mapType() 的口径区别：后者读离线地形模型的 currentMapType（只在世界图场景内有值），
 * 这里读游戏真正的状态位 `_currentMapType`（setter 按跨服形态折算，且只在变化时 emit MapTypeChange）。
 * 就绪判据用 `'mapType' in b`（in 不触发 getter），避免未登录时 getter 抛错把一次早探测钉死整页。
 * @returns {object|null}
 */
function mapBiz() {
  return probe(SYM.modules.mapNewBiz + '.biz', () => {
    var b = ns(game.get(SYM.modules.mapNewBiz));
    return b && 'mapType' in b && 'watchingType' in b ? b : null;
  });
}

/**
 * NWorldMapCoreBiz 模块上的枚举对象（NWorldMapType / WatchingBattleType）。
 * 这两个枚举挂在原始 namespace 上，ns() 会把它解包成业务单例从而取不到，故这里故意不走 ns()。
 * @param {string} name 枚举成员名（'NWorldMapType' | 'WatchingBattleType'）
 * @returns {object|null}
 */
function mapBizEnum(name) {
  return probe(SYM.modules.mapNewBiz + '.' + name, () => {
    var mod = game.get(SYM.modules.mapNewBiz);
    return (mod && mod[name]) || null;
  });
}

/**
 * GameDefine.ServerState 枚举对象（裸 CommonJS 直挂 exports 与 ES default 两种导出风格都兜住）。
 * @returns {object|null}
 */
function serverStateEnum() {
  return probe(SYM.modules.gameDefine + '.ServerState', () => {
    var mod = game.get(SYM.modules.gameDefine);
    var a = mod && mod.ServerState;
    var b = mod && ns(mod) && ns(mod).ServerState;
    return a || b || null;
  });
}

/**
 * 数字枚举反向取名（TS 数字枚举双写：e[1]='world'）。取不到回 ''（调用方据此降级）。
 * @param {object|null} enumObj 枚举对象
 * @param {number} value 枚举数值
 * @returns {string} 成员名；未知返回 ''
 */
function enumNameOf(enumObj, value) {
  if (!enumObj) return '';
  var n = enumObj[value];
  return typeof n === 'string' ? n : '';
}

/**
 * 安全调 CrossUtils 静态谓词：符号缺失、或子包门面未接管导致内部抛错（实证：isPabFighting 读
 * PabController.getInstance() 的字段、isC4Open 读 NEightCountryController.instance.nowOpenType，
 * 两者在接管前都会抛）一律回 undefined，由上层决定保守档位——绝不让一次判据异常把归一层带崩。
 * @param {string} name CrossUtils 静态方法名
 * @returns {boolean|undefined} undefined=无从判定（区别于 false 的「判定为否」）
 */
function crossFlag(name) {
  var C = crossUtils();
  if (!C || typeof C[name] !== 'function') return undefined;
  try {
    return !!C[name]();
  } catch (e) {
    return undefined;
  }
}

/**
 * 世界态原始信号只读组：把「你在哪一种战场/哪张图/哪个阶段」的四层判据原值摊给
 * core/world/state.js 做归一，符号名知识全收在本文件（ACL）。全部为只读 getter，
 * 不写游戏任何字段（只读+发包红线）。不做归一判断——那是 world-state 的职责。
 */
export const worldSignals = {
  /** 业务单例在场即视为信号就绪（false=引擎/登录未就绪，上层走「未就绪」分支） */
  ready() {
    return !!mapBiz();
  },
  /** NWorldMapCoreBiz 单例（仅供只读，禁止经它写游戏数据） */
  biz: mapBiz,
  /** 当前 mapType 原值（NWorldMapType）；取不到返回 0 */
  mapType() {
    var b = mapBiz();
    try {
      return b ? Number(b.mapType) || 0 : 0;
    } catch (e) {
      return 0;
    }
  },
  /** 当前 mapType 的语义名（'new_cab'/'kvk_s2'…）；未知或取不到返回 '' */
  mapTypeName() {
    return enumNameOf(mapBizEnum('NWorldMapType'), this.mapType());
  },
  /** 指定 mapType 数值 → 语义名（供一致性诊断与 adp_war 之类未落地分支取名） */
  mapTypeNameOf(value) {
    return enumNameOf(mapBizEnum('NWorldMapType'), value);
  },
  /** 当前观战/秘境态原值（WatchingBattleType，0=NONE 即实战态） */
  watchingType() {
    var b = mapBiz();
    try {
      return b ? Number(b.watchingType) || 0 : 0;
    } catch (e) {
      return 0;
    }
  },
  /** 当前观战/秘境态语义名（'NONE'/'TM_WATCHING'/'PAB'…）；取不到返回 '' */
  watchingTypeName() {
    return enumNameOf(mapBizEnum('WatchingBattleType'), this.watchingType());
  },
  /** 是否在异能秘境地图（watchingType===PAB，与 secretRealm 共用同一真相，不分两套口径） */
  pabBattleMap() {
    // 秘境适配器已下沉 feat（解耦试点）：worldSlot 已就地求值，槽未注册/取槽异常回 null → 保守 false
    //（秘境图只在玩法内可达，常态无误判风险）。
    return !!worldSlot('pabBattleMap');
  },
  /** 本服阶段位原值（UserData.ServerState）；取不到返回 0（=Normal） */
  serverState() {
    try {
      var u = userData();
      return u && u.ServerState != null ? Number(u.ServerState) || 0 : 0;
    } catch (e) {
      return 0;
    }
  },
  /** 本服阶段位语义名（Normal/Donate/Ready/Fight/Reward/Matching）；符号缺失返回 '' */
  serverStateName() {
    return enumNameOf(serverStateEnum(), this.serverState());
  },
  /** 战区形态位域原值（UserData.eightServerType，CrossUtils.judgeKVK 按 (1|n)-1 匹配赛事） */
  eightServerType() {
    try {
      return Number(userData().eightServerType) || 0;
    } catch (e) {
      return 0;
    }
  },
  /** 跨服形态号原值（CrossUtils._tmServerType：0=非跨服、5=TM、6=大师、8=传奇、9=征服者/CQ25） */
  tmServerType() {
    try {
      return Number(crossUtils()._tmServerType) || 0;
    } catch (e) {
      return 0;
    }
  },
  /** 当前 cc 场景节点名（与 scene.name() 同源，归一层的第二层「地图」判据） */
  sceneName() {
    return scene.name();
  },
  /** 世界态事件名表（core/scene-watcher.js 据此订阅，事件符号名不泄漏到上层） */
  events: SYM.events,
  /**
   * cc 场景名 → 语义键（场景名符号收在 SYM.sceneNames，上层只消费语义键）。
   * @returns {string} 'off'|'home'|'homeOther'|'newWorld'|'worldOld'|'battle'|'sphere'|'transition'|'boot'|'other'
   */
  sceneSemantic() {
    var n = scene.name();
    var S = SYM.sceneNames;
    if (!n) return 'off';
    if (n === S.home) return 'home';
    if (n === S.homeOther) return 'homeOther';
    if (n === S.newWorld) return 'newWorld';
    if (n === S.worldOld) return 'worldOld';
    if (n === S.mechaBattle || n === S.rtsGame || n === S.rtsGame3D) return 'battle';
    if (n === S.sphere || n === S.eniSphere || n === S.cq25Sphere) return 'sphere';
    if (n === S.transition || n === S.visitTransition || n === S.cq25Transition)
      return 'transition';
    if (n === S.login || n === S.launch) return 'boot';
    return 'other';
  },
  /**
   * CrossUtils 谓词族（值域 true/false/undefined，undefined=无从判定）。
   * 名后括号为源码方法名，判据优先级与游戏自身 CrossUtils.setMapTmxData 的分支顺序对齐。
   */
  cross: {
    /** isInAnyServer()：非本服常态总闸（内部含 isPabFighting，接管前会抛 → 常为 undefined） */
    anyServer() {
      return crossFlag('isInAnyServer');
    },
    /** getIsCabMap()：峡谷族战场（AVA/TM/大师/传奇）——游戏自建的「是否峡谷图」权威谓词 */
    cabMap() {
      return crossFlag('getIsCabMap');
    },
    /** isTMServer()：无双峡谷·TM 代（含 TM_WATCHING 观战态） */
    tm() {
      return crossFlag('isTMServer');
    },
    /** isMasterMatch()：大师赛（含 MASTER_WATCHING 观战态） */
    master() {
      return crossFlag('isMasterMatch');
    },
    /** isTeamLegendServer()：传奇小队/小队赛 */
    teamLegend() {
      return crossFlag('isTeamLegendServer');
    },
    /** isNewCAB()：无双峡谷·AVA 代（NewCABController.Instance.isNewCABServer()） */
    newCab() {
      return crossFlag('isNewCAB');
    },
    /** isEniNeutralMatch()：异能征服者（cnc/cnc_high） */
    eni() {
      return crossFlag('isEniNeutralMatch');
    },
    /** isCQ25NeutralMatch()：CQ25 征服者（cnc_25/cnc_high_25） */
    cq25() {
      return crossFlag('isCQ25NeutralMatch');
    },
    /** isC4()：四国（judgeKVK(8)） */
    c4() {
      return crossFlag('isC4');
    },
    /** isC8()：八国（judgeKVK(4)） */
    c8() {
      return crossFlag('isC8');
    },
    /** isC8S2()：八国 S2（judgeKVK(6)） */
    c8s2() {
      return crossFlag('isC8S2');
    },
  },
};
