/**
 * 游戏符号防腐层（ACL）：全项目唯一允许集中「游戏 bundle 内部符号名」知识的场所——
 * 模块注册名、类/单例属性链、枚举成员名、配置表名全部收在 SYM 表。游戏改版符号漂移时
 * 只改这一个文件；上层业务（feats/*、core/ui.js）只依赖能力 API，不感知符号名。
 *
 * 耦合分层立场（解耦重构的依据）：
 *   - 线路格式知识（llm 字段、ChatShareLinkType、消息模板规则）→ feats/chat/classify.js
 *     纯函数层。属服务器↔客户端契约，变化极少，带源码锚点，不算病态耦合；
 *   - 运行时符号知识（本文件）→ 游戏 bundle 实现细节，随版本漂移。收敛于此，
 *     惰性探测 + 缓存 + 失败一次性 warn，使漂移可观测、修复单点化。
 *
 * 合规：全部能力为只读查询或调用游戏原生导航/UI 动作，不改写游戏数据（只读+发包红线）。
 */
import { game } from './game.js';
import { createLog } from './log.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=GAMEAPI） */
const log = createLog('GAMEAPI');

/**
 * 符号表：所有游戏内部名字集中于此，一眼可全审。
 * @type {object}
 */
const SYM = {
  modules: {
    localManager: 'LocalManager',
    tableManager: 'TableManager',
    tableName: 'TableName',        // 配置表名枚举（成员名→游戏表名字符串，如 BOSS="boss"）
    dataCenter: 'DataCenter',
    tableUtils: 'TableUtils',
    long64Bit: 'Long64Bit',
    chatCommon: 'chatCommon',
    platformCore: 'PlatformCore',
    mapNewBiz: 'NWorldMapCoreBiz',
    mapNewCtrl: 'NWorldMapTodoController',
    mapOldCommon: 'WorldMapCommon',
    mapOldCtrl: 'WorldMapTodoController',
    worldUtils: 'WorldUtils',      // 行军类型换算（世界地图业务工具，静态类）
    crossUtils: 'CrossUtils',      // 跨服战场类型判定（tmServerType 驱动）
    newCabCtrl: 'NewCABController', // 新跨服战场（AVA）控制器
    pathUtils: 'PathUtils',        // 资源路径换算（游戏自带头像图集名 → headpic CDN URL）
    gameDefine: 'GameDefine',      // 全局枚举汇出（FunctionKey/EnergyType 等，CommonJS 直挂 exports）
    worldSiteCtrl: 'AllianceWorldSiteController', // 联盟遗迹（要塞）控制器门面，具名导出，实例在 _instance/instance
    rewardCtrl: 'RewardController',      // 奖励配置解析器，ES 命名空间具名导出（无 .default），静态 Instance.getRewardsArrById 把奖励配置 id 解成道具清单
    terrainModel: 'NWorldMapTerrainModel', // 离线地形查询单例：getTerrain/getAreaByWorldMap/isBlock/cols/rows
    mapCommon: 'NWorldMapCommon',           // 常量枚举：allMapInfos（按 mapType 的 rows/cols/subMap）、NWorldMapSettings
    mapData: 'NWorldMapData',               // 数据单例：mapFiles[mapType]、currentMapFile（注：mapType 不在此，在 NWorldMapCoreBiz，经 terrainModel.currentMapType 读）
    mapAssets: 'NWorldMapAssets',           // 地形图集资源表：NMapAssets[mapType] = {terrainTexture, tileMap(tileId→[frameName]), waterIds, hillIds, terrainScale}
    vassetCache: 'VirtualAssetCache',       // 资源缓存：getSpriteFrameFromAtlas(name, atlas)→cc.SpriteFrame(rect/texture.nativeUrl)、getSpriteAtlasFromCache
    marchStorage: 'MarchStorageController', // 出征档案门面：getInstance() 由 subpack2 启动接管（Subpack2Main.main → initMarchStorageController）注入 Real 实现
    procedureManager: 'ProcedureManager', // 场景程序管理器（PROCE 单例）：Run(PROCE.Home/PROCE.NewWorld) 切场景，与主界面「世界/回城」按钮同源
    uiManager: 'UIManager',               // UI 管理器门面（default.Instance().OpenUI(UIDataInfo.xxx) 打开原生面板）
    uiDataInfo: 'UIDataInfo',             // 面板描述符注册表（UIDataInfo.<PanelName> → UIDataInfoClass 实例）
  },
  /** 新图单例属性链：module[cls][inst]，枚举对象 module[goType] */
  newMap: { cls: 'NWorldMapTodoController', inst: 'instance', goType: 'NWorldMapGoType' },
  /** 旧图枚举对象属性名 */
  oldMap: { todoType: 'WorldMapToDoType' },
  /** 导航动作枚举名（按名字取值，不依赖静态数值——NWorldMapGoType 数值未落盘） */
  mapActions: { moveTo: 'MOVE_TO', tileClick: 'JUMP_TO_TILE_CLICK', marchClick: 'JUMP_TO_MARCH_CLICK' },
  /** 语义表名 → 游戏 TableName 字符串值（TableName.js 实证） */
  tables: {
    emotion: 'emotion', emotionNew: 'emotion_new', emojiGif: 'emoji_gif', item: 'item', building: 'building',
    // 次元矿洞三张表（TableName.mine_cave/_level/_interaction，报告 §6 实证；成员名与值同名小写）
    mineCave: 'mine_cave', mineCaveLevel: 'mine_cave_level', mineCaveInteraction: 'mine_cave_interaction',
  },
  /** UserData 子对象上的数据成员名（属性链符号，Alliance.<name>） */
  dataProps: { allianceBoss: 'AllianceBossData', allianceScience: 'scienceData', worldCoord: 'WorldCoord' },
  /** 行军/地块枚举成员名（只记名字，数值运行时向游戏枚举对象取） */
  marchEnum: {
    obj: 'MarchType',                                 // WorldMapCommon 导出：新旧图同一张 MarchType 表
    attackPlayer: 'ATTACK_PLAYER',                    // 13 本服攻玩家城
    tmAttackPlayer: 'TM_ATTACK_PLAYER',               // 150 双子星（无双）战场
    masterAttackPlayer: 'MASTER_ATTACK_PLAYER',       // 170 王者对战
    avaAttackPlayer: 'AVA_ATTACK_PLAYER',             // 110 新跨服战场
    teamLegendAttackPlayer: 'TEAM_LEGEND_ATTACK_PLAYER', // 181 军团传奇
    attackWorldBoss: 'ATTACK_WORLDBOSS',              // 14 普通世界 boss
    attackWorldBossV2: 'ATTACK_WORLD_BOSS_V2'         // 298 bossV2 世界 boss
  },
  entityEnum: { obj: 'WorldMapEntityType', boss: 'BOSS', bossV2: 'BOSS_V2' },
  /** ProcedureManager.PROCE 单例上的场景程序成员名（各 Procedure 自带 sceneName，Run 时按 sceneName 判断是否切换） */
  procedures: { home: 'Home', newWorld: 'NewWorld' },
  /** 场景节点名（cc.director.getScene().name 口径，SceneName 枚举实证：HOME="Home"、NEWWORLD="NWorldMap"、WORLD="WorldMap"） */
  sceneNames: { home: 'Home', newWorld: 'NWorldMap' },
  /** 语义面板名 → UIDataInfo 注册表成员名（运行时符号，面板随版本漂移时单点维护） */
  uiPanels: { bag: 'BagPanel' },
};

/** @type {Map<string, *>} 惰性探测的成功缓存（页面生命周期与游戏版本一致，缓存后无需重探） */
const probes = new Map();

/** @type {Set<string>} 已记过 warn 的探测键：失败不缓存（下次自愈重探），但只警报一次 */
const probeWarned = new Set();

/**
 * 惰性探测：首次解析并缓存，失败记一条 warn（符号漂移警报）。
 * 失败不落缓存：这些符号都在世界地图子包，核心就绪时可能尚未注册，
 * 缓存 null 会把一次早探测钉死整个页面生命周期（自愈不了）。
 * @param {string} key 缓存键（符号语义名）
 * @param {Function} resolve 解析函数，返回目标对象或 null/报错
 * @returns {*|null}
 */
function probe(key, resolve) {
  if (probes.has(key)) return probes.get(key);
  var v = null;
  try { v = resolve() || null; } catch (e) { }
  if (v) { probes.set(key, v); return v; }
  if (!probeWarned.has(key)) {
    probeWarned.add(key);
    log.warn('probe "%s" failed —— 符号漂移（游戏更新）或功能/子包未加载，相关能力将降级', key);
  }
  return null;
}

/** LOCAL 翻译单例（LocalManager 导出 .LOCAL） */
function LOCAL() { return probe('LocalManager.LOCAL', () => { var m = game.get(SYM.modules.localManager); return (m && m.LOCAL) || null; }); }

/**
 * ES 模块包装解包：本 bundle 混用两种导出风格——裸 CommonJS（如 WorldMapCommon，`t.exports=a`，
 * 枚举直接挂顶层）与 TS 转译的 ES 命名空间（如 WorldUtils/CrossUtils/NewCABController，
 * `Object.defineProperty(exports,"__esModule",{value:true})` + `exports.default=R`，类/单例挂在 .default 下）。
 * 按方法名探测时须先看 .default，否则取到的是命名空间壳，一切方法都是 undefined。
 * 判据用 __esModule 标志而非 typeof default==='object'：TS 静态类的 default 是 constructor（typeof==='function'），
 * 只认 object 会漏解包导致跨服 marchType 换算主路径静默失效（实测踩坑）。
 * @param {object|null} m 模块导出
 * @returns {object|null} ES 命名空间则取其 .default，否则原样
 */
function ns(m) { return (m && m.__esModule && m.default != null) ? m.default : m; }

/** TABLE 配置表单例（TableManager 导出 .TABLE） */
function TABLE() { return probe('TableManager.TABLE', () => { var m = game.get(SYM.modules.tableManager); return (m && m.TABLE) || null; }); }

/** 配置表名枚举对象（TableName 模块导出 .TableName，成员名 → 游戏表名字符串；符号缺失返回 null） */
function tableNameEnum() { return probe(SYM.modules.tableName + '.TableName', () => { var m = game.get(SYM.modules.tableName); return (m && (m.TableName || (m.default && m.default.TableName))) || null; }); }

/** UserData 对象引用缓存（Friends/Alliance/StrUid 为其上属性，读值仍实时） */
function userData() { return probe('DataCenter.UserData', () => { var m = game.get(SYM.modules.dataCenter); return (m && m.DATA && m.DATA.UserData) || null; }); }

/** 场景程序管理器单例（ProcedureManager.PROCE）；PROCE.Home/NewWorld 由 ProcedureManagerInit 惰性挂上，成员每次实时读 */
function proce() { return probe('ProcedureManager.PROCE', () => { var m = game.get(SYM.modules.procedureManager); return (m && m.PROCE) || null; }); }

/** UI 管理器门面类（UIManager.default，其静态 Instance() 返回真实接管单例或未接管兜底桩；此处只缓存类、实例每次实时取，避免缓存到兜底桩） */
function uiMgrClass() { return probe(SYM.modules.uiManager + '.default', () => { var m = game.get(SYM.modules.uiManager); return (m && m.default) || null; }); }

/** UIDataInfo 面板描述符注册表对象（成员名→UIDataInfoClass 实例；对象引用稳定，面板由各模块惰性追加，读成员实时） */
function uiRegistry() { return probe(SYM.modules.uiDataInfo + '.UIDataInfo', () => { var m = game.get(SYM.modules.uiDataInfo); return (m && m.UIDataInfo) || null; }); }

// ─────────────────────── 本地化 / 配置表 ───────────────────────

export const l10n = {
  /** 翻译能力是否可用 */
  ok() { return !!LOCAL(); },
  /**
   * 语言键+参数 → 游戏当前语言文本（与游戏 getText(key,...paras) 同源；查不到回键原文）。
   * @param {string} key 语言键
   * @param {...*} paras 模板参数
   * @returns {string}
   */
  text(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var L = LOCAL();
    if (!L || typeof L.getText !== 'function') return String(key);
    try { return String(L.getText.apply(L, [String(key)].concat(args)) || '') || String(key); } catch (e) { return String(key); }
  },
  /**
   * 服务器应答 '<键,参数1|参数2>' 裸串 → 译文（getNetMsgText 同源；查不到回原文）。
   * @param {*} s 应答 data 原文
   * @returns {string}
   */
  net(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return s;
    var L = LOCAL();
    if (!L || typeof L.getNetMsgText !== 'function') return s;
    try { return String(L.getNetMsgText(s) || '') || s; } catch (e) { return s; }
  },
  /**
   * 配置表行查询（只读）。
   * @param {string} semantic 语义表名（emotion/emotionNew/emojiGif/item/building）、游戏 TableName 成员名（如 'BOSS'），也可直接传游戏表名串
   * @param {*} id 行 id
   * @returns {object|null}
   */
  tableRow(semantic, id) {
    var T = TABLE();
    if (!T) return null;
    // 名字解析优先级：语义别名表 → 游戏 TableName 枚举成员（BOSS→"boss"，随游戏版本自维护）→ 原样作游戏表名
    var tn = SYM.tables[semantic];
    if (!tn) { var E = tableNameEnum(); tn = (E && E[semantic]) || semantic; }
    try { return T.getTableDataById(tn, String(id)) || null; } catch (e) { return null; }
  },
  /**
   * 配置表整表行数组（只读，getTableGroupArray）。表未就绪/符号缺失返回 []。
   * @param {string} semantic 语义表名（同 tableRow 的名字解析优先级）
   * @returns {object[]}
   */
  tableRows(semantic) {
    var T = TABLE();
    if (!T || typeof T.getTableGroupArray !== 'function') return [];
    var tn = SYM.tables[semantic];
    if (!tn) { var E = tableNameEnum(); tn = (E && E[semantic]) || semantic; }
    try { return T.getTableGroupArray(tn) || []; } catch (e) { return []; }
  },
  /**
   * 频道号 → 游戏频道显示名（chatCommon.getChatToggleConfig 文案键 + 翻译，与游戏侧栏同源）。
   * @param {number} c 频道号
   * @returns {string|null} 取不到返回 null（调用方自定衍名兜底）
   */
  channelName(c) {
    var cm = probe(SYM.modules.chatCommon + '.getChatToggleConfig', () => {
      var m = game.get(SYM.modules.chatCommon);
      return (m && typeof m.getChatToggleConfig === 'function') ? m : null;
    });
    if (!cm) return null;
    try { return l10n.net(cm.getChatToggleConfig(+c)) || null; } catch (e) { return null; }
  },
};

// ─────────────────────── 世界地图导航 ───────────────────────

/** 跳转协调器（新旧地图双通道，首次探测后缓存句柄） */
function mapTodo() {
  return probe('mapTodo', () => {
    try { // 新图：NWorldMapCoreBiz.NWorldMapGoType + NWorldMapTodoController.instance
      var biz = game.get(SYM.modules.mapNewBiz);
      var G = biz && biz[SYM.newMap.goType];
      var cls = game.get(SYM.modules.mapNewCtrl);
      var C = cls && cls[SYM.newMap.cls];
      var inst = C && C[SYM.newMap.inst];
      if (G && inst && typeof inst.gotoWorldAndDo === 'function') return { inst: inst, G: G };
    } catch (e) { }
    try { // 旧图：WorldMapCommon.WorldMapToDoType + WorldMapTodoController.getInstance()
      var common = game.get(SYM.modules.mapOldCommon);
      var G2 = common && common[SYM.oldMap.todoType];
      var m2 = game.get(SYM.modules.mapOldCtrl);
      var i2 = m2 && (typeof m2.getInstance === 'function' ? m2.getInstance()
        : (m2.default && typeof m2.default.getInstance === 'function' ? m2.default.getInstance() : null));
      if (G2 && i2 && typeof i2.gotoWorldAndDo === 'function') return { inst: i2, G: G2 };
    } catch (e) { }
    return null;
  });
}

/**
 * 地图跳转能力。返回值统一 {ok:boolean, err?:string}，err 为技术语义键
 * （'unavailable'=协调器缺失 | 'failed'=执行异常 | 'nomarch'=该卡不支持直跳），文案归业务层。
 */
export const nav = {
  /** 导航能力是否可用 */
  ok() { return !!mapTodo(); },
  /**
   * 坐标飞行：click=true 且有 JUMP_TO_TILE_CLICK → 飞完模拟点地块（弹城市弹窗），否则 MOVE_TO 只飞+标记。
   * opts 全字段兜底 s/k/z（新图读 k||s、旧图读 z），跨服服号放 z；子服号 subMap 有值才传
   * （新图 game2displayWithServerLimit(x,y,serverId,subMap) 跨服换算需要，缺省游戏回退本服子服）。
   * @param {{x:number, y:number, z:number|null, subMap?:number|null, click:boolean}} action
   * @returns {{ok:boolean, err?:string}}
   */
  flyTo(action) {
    var t = mapTodo();
    if (!t) return { ok: false, err: 'unavailable' };
    var A = SYM.mapActions;
    var type = action.click && t.G[A.tileClick] != null ? t.G[A.tileClick] : t.G[A.moveTo];
    if (type == null) return { ok: false, err: 'unavailable' };
    var opts = { x: action.x | 0, y: action.y | 0, mark: true };
    if (action.z != null) { opts.s = action.z; opts.k = action.z; opts.z = action.z; }
    if (action.subMap != null && action.subMap > 0) opts.subMap = action.subMap;
    try { t.inst.gotoWorldAndDo(type, opts); return { ok: true }; }
    catch (e) { log.warn('flyTo(%s,%s) failed: %s', action.x, action.y, e && e.message); return { ok: false, err: 'failed' }; }
  },
  /**
   * 行军/集结飞行：JUMP_TO_MARCH_CLICK {marchId,marchType}（游戏默认分支走通用协议 GET_MARCH_INFO_FOR_JUMP）。
   * @param {{marchId:*, marchType:*}} action
   * @returns {{ok:boolean, err?:string}}
   */
  flyMarch(action) {
    var t = mapTodo();
    if (!t) return { ok: false, err: 'unavailable' };
    if (!t.G[SYM.mapActions.marchClick] || action.marchId == null) return { ok: false, err: 'nomarch' };
    try { t.inst.gotoWorldAndDo(t.G[SYM.mapActions.marchClick], { marchId: action.marchId, marchType: action.marchType }); return { ok: true }; }
    catch (e) { log.warn('flyMarch(%s) failed: %s', action.marchId, e && e.message); return { ok: false, err: 'failed' }; }
  },
};

// ─────────────────────── 行军类型（跨服漂移） ───────────────────────

/** 游戏 MarchType 枚举对象（WorldMapCommon 为裸 CommonJS 导出，枚举在顶层，无 .default） */
function marchEnum() { return probe(SYM.modules.mapOldCommon + '.' + SYM.marchEnum.obj, () => { var m = game.get(SYM.modules.mapOldCommon); return (m && m[SYM.marchEnum.obj]) || null; }); }

/** 游戏 WorldMapEntityType 枚举对象（地块实体类型，同上在裸导出顶层） */
function entityEnum() { return probe(SYM.modules.mapOldCommon + '.' + SYM.entityEnum.obj, () => { var m = game.get(SYM.modules.mapOldCommon); return (m && m[SYM.entityEnum.obj]) || null; }); }

/** 跨服判定器（CrossUtils 静态方法，ES 包装下取 .default；随 tmServerType 变化，每次实时调用，不缓存结果） */
function crossUtils() { return probe(SYM.modules.crossUtils, () => { var C = ns(game.get(SYM.modules.crossUtils)); return (C && typeof C.isTMServer === 'function') ? C : null; }); }

/** 新跨服战场（AVA）判定：NewCABController.default.Instance.isNewCABServer() */
function isNewCabServer() {
  try {
    var K = ns(game.get(SYM.modules.newCabCtrl));
    var I = K && (K.Instance || K.instance);
    return !!(I && typeof I.isNewCABServer === 'function' && I.isNewCABServer());
  } catch (e) { return false; }
}

/** 游戏原生换算器 WorldUtils.dealMarchTypeWithSpecialMarch（漂移表唯一真相源，在则优先用；ES 包装下取 .default） */
function worldMarchUtils() {
  return probe(SYM.modules.worldUtils + '.dealMarchTypeWithSpecialMarch', () => {
    var W = ns(game.get(SYM.modules.worldUtils));
    return (W && typeof W.dealMarchTypeWithSpecialMarch === 'function') ? W : null;
  });
}

/**
 * 行军类型能力：把「本服基础 marchType」换算成「当前战场实际 marchType」。
 * 跨服战场（无双/王者/军团传奇/新跨服）下玩家城等目标的 marchType 与基础值不同，
 * 直接用基础值发 902 会被服务器拒；换算优先调游戏原生函数，游戏侧符号漂移时降级本地兜底。
 */
export const march = {
  /**
   * 枚举成员名 → 数值（运行时向游戏枚举对象取，取不到回 fallback）。
   * @param {string} member SYM.marchEnum 里的成员名（如 'tmAttackPlayer'）
   * @param {number} fallback 游戏符号缺失时的兜底数值（可能过期，仅作降级）
   * @returns {number}
   */
  typeOf(member, fallback) {
    var E = marchEnum();
    var v = E && E[SYM.marchEnum[member]];
    return (typeof v === 'number' && v > 0) ? v : (fallback | 0);
  },
  /**
   * 地块实体类型是否 bossV2（世界 boss 二期，行军类型与普怪不同）。
   * @param {*} entityType tileInfo.type 原值
   * @returns {boolean}
   */
  isBossV2(entityType) {
    var E = entityEnum();
    return !!(E && entityType != null && entityType === E[SYM.entityEnum.bossV2]);
  },
  /**
   * 地块实体类型是否普通世界 boss（一期，行军类型 ATTACK_WORLDBOSS=14）。
   * 成员缺失（符号漂移）时恒 false——宁可回「无可攻打目标」也不猜服务器契约。
   * @param {*} entityType tileInfo.type / 901 pointType 原值
   * @returns {boolean}
   */
  isBoss(entityType) {
    var E = entityEnum();
    var v = E && E[SYM.entityEnum.boss];
    return !!(E && typeof v === 'number' && entityType != null && entityType === v);
  },
  /**
   * 基础 marchType → 当前战场实际 marchType（等价游戏 WorldUtils.getMarchTypeByBattleData 的换算分支）。
   * @param {number} base 基础 marchType（本服口径，如 ATTACK_PLAYER=13）
   * @param {{attackPlayer?:number, tm?:number, master?:number, ava?:number, teamLegend?:number}} fb
   *   游戏符号缺失时的本地兜底数值表（调用方传注册表常量，保证语义一致）
   * @returns {number} 换算结果；判定器全部不可用时原样返回 base（宁可少功能，不猜服务器契约）
   */
  resolve(base, fb) {
    base = base | 0;
    fb = fb || {};
    if (base !== this.typeOf('attackPlayer', fb.attackPlayer)) return base; // 仅攻玩家城参与漂移换算
    var W = worldMarchUtils();
    if (W) {
      try { // 游戏原生优先：服务器契约由游戏自己维护，改版自动跟随
        var v = W.dealMarchTypeWithSpecialMarch(base, {});
        if (v) return v | 0;
      } catch (e) { }
    }
    var C = crossUtils();
    if (isNewCabServer()) return this.typeOf('avaAttackPlayer', fb.ava);
    if (C) {
      if (C.isTMServer()) return this.typeOf('tmAttackPlayer', fb.tm);
      if (C.isMasterMatch()) return this.typeOf('masterAttackPlayer', fb.master);
      if (C.isTeamLegendServer()) return this.typeOf('teamLegendAttackPlayer', fb.teamLegend);
    }
    log.warn('march.resolve 降级：WorldUtils/CrossUtils 均不可用，按本服 marchType=%d 发送', base);
    return base;
  },
  /**
   * 战场判定器快照（仅诊断用，日志排查「漂移解析成了什么、凭什么」）。
   * @returns {object} {tm, master, teamLegend, ava, resolver} 判定器缺失记 null
   */
  flags() {
    var C = crossUtils();
    var o = { resolver: !!worldMarchUtils(), tm: null, master: null, teamLegend: null, ava: null };
    if (C) {
      try { o.tm = !!C.isTMServer(); o.master = !!C.isMasterMatch(); o.teamLegend = !!C.isTeamLegendServer(); } catch (e) { }
    }
    o.ava = isNewCabServer();
    return o;
  },
};

// ─────────────────────── 玩家/游戏数据（只读） ───────────────────────

export const gameData = {
  /** 数据源是否可用 */
  ok() { return !!userData(); },
  /** 当前服务器时间（秒），实时取值不缓存；取不到返回 0 */
  serverTime() { try { return +game.get(SYM.modules.dataCenter).DATA.ServerTime || 0; } catch (e) { return 0; } },
  /** 本人 StrUid（快速登录模式下与数字 UID 不同）；取不到返回 '' */
  strUid() { var s = userData() && userData().StrUid; return (s != null && s !== '') ? String(s) : ''; },
  /** 好友 Map（登录下发 + push 维护，CheckIsMyFriend 同源）；无数据源返回 null */
  friends() {
    var fr = userData() && userData().Friends;
    return (fr && typeof fr.has === 'function' && typeof fr.keys === 'function') ? fr : null;
  },
  /** 联盟对象（Aid/MemberCount…）；不在盟/无数据源返回 null */
  alliance() { return (userData() && userData().Alliance) || null; },
  /** 本人数字 pid（=UserData.UID，与世界地图 p.pid 同源，已用实录核对）；取不到返回 0 */
  myPid() { try { return Number(userData() && userData().UID) || 0; } catch (e) { return 0; } },
  /** 本人联盟 aid（=UserData.Alliance.Aid，与地图 p.aid 同源）；未入盟/取不到返回 0 */
  myAid() { try { var a = userData() && userData().Alliance; return Number(a && a.Aid) || 0; } catch (e) { return 0; } },
  /** 本人主城/账号等级（=UserData.Level，功能 open_level 门槛判据同源）；取不到返回 0 */
  level() { try { return Number(userData() && userData().Level) || 0; } catch (e) { return 0; } },
  /**
   * 本人基地世界坐标（UserData.WorldCoord，口径同 NWorldMapUIComponent 的小地图定位）。
   * @returns {{x:number, y:number}|null} 取不到/字段不全返回 null
   */
  myWorldPos() {
    var c = userData() && userData().WorldCoord;
    if (!c || c.x == null || c.y == null) return null;
    return { x: c.x | 0, y: c.y | 0 };
  },
  /**
   * 道具背包持有量（UserData.getItemAmount，只读）。机甲碎片 3200001 等都走这里。
   * @param {number} itemId 道具 id
   * @returns {number} 持有数量；数据源/方法不可用返回 0
   */
  itemAmount(itemId) {
    var u = userData();
    if (!u || typeof u.getItemAmount !== 'function') return 0;
    try { return Number(u.getItemAmount(+itemId)) || 0; } catch (e) { return 0; }
  },
  /**
   * 联盟机甲本地态快照（Alliance.AllianceBossData 的 getter，游戏由 push 10435 / 1160 / 1161 应答刷新）。
   * 口径提醒：todayTime / todayFree 两字段由 updateData 的 `null != e.todayTime` 守卫单独维护，
   * 而 push 10435 的载荷里没有它们（只有 allianceBoss 一块）→ 未开面板时恒为构造默认 0，不可据此判免费。
   * state 构造默认 -1（未开启），与「本服没这套玩法/联盟未召唤」同义。
   * @returns {object|null} {state,bossId,x,y,exp,hp,endTime,summonTime,pointSid,help}；对象不可用返回 null
   */
  allianceBoss() {
    var src = probe('Alliance.AllianceBossData', () => {
      var a = userData() && userData().Alliance;
      var d = a && a[SYM.dataProps.allianceBoss];
      return (d && typeof d.State === 'number') ? d : null;
    });
    if (!src) return null;
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
    } catch (e) { return null; }
  },
  /**
   * 联盟科技本地态快照（Alliance.scienceData 的只读 getter/方法，游戏由 1143 应答 / push 10430/10432 刷新）。
   * 口径：recommendId 为官员推荐项（0=无推荐）；costCoin 走游戏
   * getCostCoin()（PLAYER_LEVEL[等级].donation_gold，随等级变）；dailyHonor 为今日已获荣誉
   * （科技捐与遗迹捐共用同一计数：1067 应答 curPoint 直接写回 donateDailyHonor，抓包实证）。
   * firstDonateable：按游戏弹窗 showBtn 同款可捐口径扫的第一项（无有效推荐时的回退目标）——
   *   isLock()（ItemData 方法：sid=10400 恒 false，服务器初始化后为 true）且 !isMaxLevel()（未满级）
   *   且 isStatus()（status==0，即非研究中；研究中捐赠按钮被隐藏）；找不到返回 null。
   * donateTarget：本轮真正该捐的目标，已把「推荐优先/回退首项」两级策略与可捐校验合成——
   *   推荐项（RecommendId，即 sid）必须自身通过同一 canDon 口径才算数，否则回退 firstDonateable，
   *   两者皆无则 null（上层跳过）。这是对「满级/研究中的推荐项直接捐会被服务器拒」的修正。
   * honorCap：今日荣誉上限，走游戏 Alliance.getAllianceScienceScore()（内部读 DATACONFIG 16005），
   *   取不到为 0（上层据此不设此闸）。
   * @returns {object|null} {recommendId,recommendName,dailyHonor,honorCap,costCoin,firstDonateable,donateTarget,donateRecommended}；不在盟/数据未填充返回 null
   */
  allianceScience() {
    var src = probe('Alliance.scienceData', () => {
      var a = userData() && userData().Alliance;
      var d = a && a[SYM.dataProps.allianceScience];
      return (d && Array.isArray(d.scienceDevDataList) && typeof d.getCostCoin === 'function') ? d : null;
    });
    if (!src) return null;
    try {
      // 可捐口径（弹窗 showBtn 的捐赠按钮分支）：已解锁且未满级且非研究中
      var canDon = function (it) {
        return !!(it && typeof it.isLock === 'function' && it.isLock() && !it.isMaxLevel() && it.isStatus());
      };
      var nameOf = function (it) {
        return (it && typeof it.getName === 'function') ? String(it.getName() || '') : '';
      };
      var recId = Number(src.RecommendId) || 0;
      var first = null;
      var lists = [src.scienceDevDataList, src.scienceWarDataList];
      for (var li = 0; li < lists.length && !first; li++) {
        var arr = lists[li] || [];
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (canDon(it)) { first = { scienceId: Number(it.sid) || 0, name: nameOf(it) }; break; }
        }
      }
      // 两级目标：推荐项须自身可捐才采纳，否则回退首项
      var target = null, recommended = false, recName = '';
      if (recId > 0) {
        var rec = src.getScienceItemDataByGroupId(recId);
        if (canDon(rec)) { target = { id: recId, name: nameOf(rec) }; recommended = true; recName = target.name; }
      }
      if (!target && first) { target = { id: first.scienceId, name: first.name }; }
      var a2 = userData().Alliance;
      var cap = (a2 && typeof a2.getAllianceScienceScore === 'function') ? (Number(a2.getAllianceScienceScore()) || 0) : 0;
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
    } catch (e) { return null; }
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
      var C = m && (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController));
      // 先读私有 _instance（零副作用）；尚未建立时才走 instance getter 懒建（与游戏自身同一路径）
      var inst = (C && C._instance) || (C && C.instance);
      return (inst && typeof inst.recommendSite === 'number') ? inst : null;
    });
    var u = userData();
    if (!src || !u || !u.Alliance || typeof u.getWorldSiteArrayBy !== 'function') return null;
    try {
      var aid = Number(u.Alliance.Aid) || 0;
      if (aid <= 0) return null;
      var sites = u.getWorldSiteArrayBy(aid) || [];
      var recSite = Number(src.recommendSite) || 0;
      var first = null, recDonateable = false;
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
      var target = null, recommended = false;
      if (recSite > 0 && recDonateable) { target = { id: recSite, name: '' }; recommended = true; }
      else if (first) { target = { id: first.siteId, name: first.name }; }
      var sd = u.Alliance[SYM.dataProps.allianceScience];
      var relicCost = (sd && typeof sd.getCostCoin === 'function') ? (Number(sd.getCostCoin(true)) || 0) : 0;
      return {
        recommendSite: recSite,
        firstDonateable: first,
        relicCostCoin: relicCost,
        donateTarget: target,
        donateRecommended: recommended,
      };
    } catch (e) { return null; }
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
    try { return !!u.FunctionOn(k); } catch (e) { return false; }
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
    var e = null;
    try { e = u.getEnergy(+type); } catch (err) { return null; }
    if (!e) return null;
    return { point: Number(e.Point) || 0, pointMax: Number(e.PointMax) || 0, nextRecoverSec: Number(e.NextPointRecoverTime) || 0 };
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
    var cached = probe('mine_cave.specs', () => {
      var rows = l10n.tableRows('mineCave');
      return rows && rows.length ? rows : null;
    }) || [];
    return cached;
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
    try { now = +game.get(SYM.modules.dataCenter).DATA.ServerTime || 0; } catch (e) { }
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

  // ─────────────────────── 遗迹奖励领取（只读，供 feats/daily/relic-reward.js） ───────────────────────
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
      return (K && K.Instance && typeof K.Instance.getRewardsArrById === 'function') ? K : null;
    });
    if (!C || !C.Instance) return [];
    try {
      var arr = C.Instance.getRewardsArrById(Number(rewardId));
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
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
      var C = m && (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController));
      var it = (C && C._instance) || (C && C.instance);
      return (it && it.myItemSiteData) ? it : null;
    });
    var mine = (inst && inst.myItemSiteData) || {};
    var now = gameData.serverTime();
    var out = [];
    var sites;
    try { sites = u.getWorldSiteArrayBy(aid) || []; } catch (e) { return []; }
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
      var left = (row && have) ? (chooseNum - have.length) : 0;
      var ready = !!(row && have && d) && Number(d.otherToday) !== 1 && left > 0 && (now - Number(d.joinTime || 0)) > joinSec;
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
};

/** 资源路径换算器 PathUtils（ES 命名空间下取 .default 类；静态方法 GetIconURL） */
function pathUtils() {
  return probe(SYM.modules.pathUtils, () => {
    var P = ns(game.get(SYM.modules.pathUtils));
    return (P && typeof P.GetIconURL === 'function') ? P : null;
  });
}

/** 出征档案重算器单例（MarchStorageController.getInstance()）；门面未接管或方法名漂移时返回 null */
function marchStorage() {
  return probe('MarchStorageController.instance', () => {
    var m = game.get(SYM.modules.marchStorage);
    var C = m && (m.MarchStorageController || (m.default && m.default.MarchStorageController));
    var inst = C && C.getInstance && C.getInstance();
    return (inst && typeof inst.checkPreMarchExtraList === 'function') ? inst : null;
  });
}

/**
 * 出征档案实时重算能力：把「每格能派多少兵」这件事交回游戏自己算。
 * 游戏侧公式（RealMarchStorageController.getMaxCoutByPos，实证）：
 *   普通格 = 1 + floor(add/cells) + (add % cells > pos ? 1 : 0)，
 *     add = Buff(BattleArmyAddNum=153) 全量聚合（城皮/VIP/科技等一律收敛于此）
 *         + HeroController.getMarchHeroArmyAdd(heroIds)（英雄统率×配置20006 + 技能 153 加成）
 *     cells = FunctionOn(monster_battle_replace) ? 按等级查 960600/960601 : 5
 *   补位格(pos=30) = 军阵 buff ReplenishArmyCount(useFormationV2Id=formationV2)
 * 之所以用它而不是自己套公式：加成因素（城皮技能、英雄技能、VIP、科技、活动…）穷举不完，
 * 而该路径不读 CurBattleData / myMaxArmysNum（这两个是战斗面板打开时才写的残留态），Home 场景同样准。
 */
export const battlePreset = {
  /** 重算能力是否可用（subpack2 已接管且方法在场） */
  ok() { return !!marchStorage(); },
  /**
   * 让游戏重算一份出征档案的每格上阵数。**只改写传入的 entry（必须是自建副本）**，不触碰游戏数据。
   * entry 会被就地改写：armyInfo[].num 重写为实时值（num<=0 的条目被剔除）、heroIds 截断为可派遣名单、
   * 军阵在途名额用尽时 formationV2 打回 0、extraArmy 无补位容量时置 null。
   * @param {object} entry {armyInfo:[{armyId,num,pos,heroCap}], heroIds:[id], formationV2, extraArmy:{armyId,armyNum}|null}
   * @param {boolean} [checkMarch=true] true=按可派遣口径（兵不在外征战、英雄可派、军阵有剩余名额）
   * @returns {object|null} 改写后的 entry；符号缺失或游戏抛错返回 null（调用方自行降级）
   */
  recalc(entry, checkMarch) {
    var inst = marchStorage();
    if (!inst || !entry) return null;
    try {
      inst.checkPreMarchExtraList([entry], { checkMarch: checkMarch !== false });
      return entry;
    } catch (e) {
      log.warn('battlePreset.recalc threw —— 出征档案重算器不可用（符号漂移？），调用方将走降级口径', e);
      return null;
    }
  },
  /**
   * 单格实时上限（调试/对照用，不改写任何东西）。
   * @param {number} pos 0 基格子索引（补位格传 30）
   * @param {number} formationV2 军阵 id（补位格容量由它决定）
   * @param {number[]} heroIds 出征英雄 id 列表
   * @returns {number|null} 上限；符号缺失返回 null
   */
  posMax(pos, formationV2, heroIds) {
    var inst = marchStorage();
    if (!inst || typeof inst.getMaxCoutByPos !== 'function') return null;
    try { return inst.getMaxCoutByPos(pos | 0, formationV2 | 0, heroIds || []) | 0; } catch (e) { return null; }
  },
};

/**
 * 头像资源能力（只读）：把 630 应答里的头像字段原值转成可加载的图片 URL。游戏两种头像：
 *   - 用户/平台自定义：headimgurl / headimgurl_custom 是 http(s) 真实 URL → 原样返回；
 *   - 游戏自带：avatarurl 是图集资源名（如 hero_icon119_global，非 URL）→ 交游戏 PathUtils.GetIconURL
 *     拼成 <ResourceUrl>/DynRes/images/headpic/<name>.png（自动跟随版本与 ignoreOtherPlatform/RPZ 分支）。
 * 直接把图集名塞给 <img> 会命中页面相对路径 404（真机实证），必须经此换算。
 * @param {string} raw 头像字段原值
 * @returns {string} 可加载 URL；空值/符号缺失/不可解析返回 ''（上层走首字母占位）
 */
export const avatar = {
  iconUrl(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v) return '';
    if (/^(https?:)?\/\//i.test(v) || /^data:/i.test(v)) return v; // 平台/用户上传的真实 URL 直接用
    var P = pathUtils();
    if (P) { try { var u = P.GetIconURL(v); return (typeof u === 'string' && u) ? u : ''; } catch (e) { } }
    return ''; // 游戏符号缺失且非 URL：不猜路径，交占位
  },
};

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
      return (m && typeof m.getDataConfigData === 'function') ? m : null;
    });
    if (!tu) return '';
    try { return tu.getDataConfigData(+id) || ''; } catch (e) { return ''; }
  },
};

export const bits = {
  /**
   * 数字串 → Long64Bit.Int64（fromString）；非数字串按 Number 走 fromNumber，模块不可用回纯数字兜底。
   * @param {string|number} v 数值或数字串（如私聊 roomId=对端 uid）
   * @returns {*|number}
   */
  int64(v) {
    v = String(v == null ? '0' : v);
    var L = probe(SYM.modules.long64Bit + '.Int64', () => { var m = game.get(SYM.modules.long64Bit); return (m && m.Int64) || null; });
    if (!L) return /^\d+$/.test(v) ? Number(v) || 0 : 0;
    try { return /^\d+$/.test(v) ? L.Int64.fromString(v) : L.Int64.fromNumber(Number(v) || 0); } catch (e) { return 0; }
  },
};

export const session = {
  /** 触发游戏登出（PlatformCore.instance.userLogout）；符号缺失记 warn 静默 */
  logout() {
    var p = probe('PlatformCore.instance', () => { var m = game.get(SYM.modules.platformCore); return (m && m.instance) || null; });
    if (!p || typeof p.userLogout !== 'function') return;
    p.userLogout();
  },
};

// ─────────────────────── 场景切换 / 原生 UI 面板 ───────────────────────

/**
 * 场景切换能力：基地城市(Home) ↔ 大世界(NWorldMap)，走游戏原生 ProcedureManager（PROCE.Run），
 * 与主界面「世界 / 回城」按钮同一条路径。只触发原生切换，不改写游戏数据（只读+调用红线）。
 */
export const scene = {
  /** 当前场景节点名（cc.director.getScene().name）；引擎未就绪返回 '' */
  name() { try { var s = cc.director.getScene(); return (s && s.name) || ''; } catch (e) { return ''; } },
  /** 回基地（切到 Home 场景） */
  goHome() {
    var p = proce();
    if (!p || !p[SYM.procedures.home]) return { ok: false, err: 'unavailable' };
    try { p.Run(p[SYM.procedures.home]); return { ok: true }; }
    catch (e) { log.warn('scene.goHome failed: %s', e && e.message); return { ok: false, err: 'failed' }; }
  },
  /** 进大世界（切到 NWorldMap 场景） */
  goWorld() {
    var p = proce();
    if (!p || !p[SYM.procedures.newWorld]) return { ok: false, err: 'unavailable' };
    try { p.Run(p[SYM.procedures.newWorld]); return { ok: true }; }
    catch (e) { log.warn('scene.goWorld failed: %s', e && e.message); return { ok: false, err: 'failed' }; }
  },
  /** 基地↔大世界互切：按当前场景决定去向；两者之外的场景不处理（返回 wrongscene） */
  toggleHomeWorld() {
    var cur = this.name();
    if (cur === SYM.sceneNames.newWorld) return this.goHome();
    if (cur === SYM.sceneNames.home) return this.goWorld();
    return { ok: false, err: 'wrongscene', scene: cur };
  },
};

/**
 * 原生 UI 面板打开能力：调用游戏 UIManager.Instance().OpenUI(描述符)，与主界面各功能按钮同源。
 * 仅触发原生开窗，不改写游戏数据。
 */
export const ui = {
  /**
   * 按语义面板名打开面板（semantic 经 SYM.uiPanels 映射到 UIDataInfo 注册表成员名）。
   * @param {string} semantic 语义名（如 'bag'）
   * @param {...*} args 传给游戏 OpenUI 的后续参数（如背包分页 index、目标道具）
   * @returns {{ok:boolean, err?:string}}
   */
  open(semantic) {
    var reg = uiRegistry();
    var member = reg && SYM.uiPanels[semantic];
    var info = member && reg[member];
    if (!info) return { ok: false, err: 'unavailable' };
    var C = uiMgrClass();
    var mgr = C && typeof C.Instance === 'function' ? C.Instance() : null;
    if (!mgr || typeof mgr.OpenUI !== 'function') return { ok: false, err: 'unavailable' };
    var args = Array.prototype.slice.call(arguments, 1);
    try { mgr.OpenUI.apply(mgr, [info].concat(args)); return { ok: true }; }
    catch (e) { log.warn('ui.open(%s) failed: %s', semantic, e && e.message); return { ok: false, err: 'failed' }; }
  },
  /** 打开道具背包（B 键用） */
  openBag() { return this.open('bag'); },
  /**
   * 关闭当前顶层弹窗（Q 键用）：读游戏原生 UIManager.Instance().CurrentUIDataInfo（最近打开、即栈顶的面板描述符），
   * 非空则调 CloseUI(描述符)（走面板自身关闭链路，等价 back 键/点遮罩）；回退 Close(name)。
   * 无弹窗在场（CurrentUIDataInfo 为空，如干净的大本营/世界地图）返回 {ok:false,err:'nothing'}。
   * @returns {{ok:boolean, err?:string, name?:string}}
   */
  closeTop() {
    var C = uiMgrClass();
    var mgr = C && typeof C.Instance === 'function' ? C.Instance() : null;
    if (!mgr || typeof mgr.CloseUI !== 'function') return { ok: false, err: 'unavailable' };
    var cur = mgr.CurrentUIDataInfo;
    if (!cur || !cur.name) return { ok: false, err: 'nothing' };
    var nm = cur.name;
    try { mgr.CloseUI(cur); return { ok: true, name: nm }; }
    catch (e) {
      try { if (typeof mgr.Close === 'function') { mgr.Close(nm); return { ok: true, name: nm }; } } catch (e2) { }
      log.warn('ui.closeTop(%s) failed: %s', nm, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
};

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
    return probe('NWorldMapTerrainModel.instance', () => {
      var m = ns(game.get(SYM.modules.terrainModel));
      var C = m && (m.NWorldMapTerrainModel || m.default || m);
      var inst = C && C.instance;
      return (inst && typeof inst.getTerrain === 'function') ? inst : (inst || null);
    });
  },
  /**
   * 当前地图类型（决定用哪张 mapFiles 与 allMapInfos 尺寸档）；取不到返回 0。
   * 首选地形模型自带 getter currentMapType（源码里它 = NWorldMapCoreBiz.mapType，随场景实时、
   * 且模块引用已在 terrainModel 就绪时解析）；mapType 并不挂在 NWorldMapData 上（那是 currentMapFile 源）。
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
      return (info && info.cols > 0 && info.rows > 0) ? { cols: info.cols | 0, rows: info.rows | 0 } : null;
    });
  },
  /**
   * 本服服号（901 请求体 k）：尽力从 UserData 多候选字段取；取不到返回 0（scanner 会以应答回显兜底）。
   * @returns {number}
   */
  serverId() {
    var u = userData();
    if (!u) return 0;
    var v = u.ServerId != null ? u.ServerId : (u.serverId != null ? u.serverId : (u.Sid != null ? u.Sid : u.s));
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
    } catch (e) { }
    return this.serverId();
  },
  /**
   * 【调试探针】扫描 Cocos 场景，查清「抓取游戏实时小地图」所需的三个事实：
   *   ① 小地图相机是否离屏到可读的 RenderTexture（camera.targetTexture）；
   *   ② 主 canvas 的 WebGL 是否 preserveDrawingBuffer（决定能否直接 toDataURL/readPixels）；
   *   ③ 小地图节点的名字/屏幕矩形（供 readPixels 裁剪）。
   * 控制台：pocketcc.gameApi.worldMap.probeMinimap()（需先进入世界地图、小地图可见）
   * @returns {object} 汇总（同时 console.table 打印）
   */
  probeMinimap() {
    var out = { cc: !!window.cc, cameras: [], miniNodes: [], bigSprites: [], canvas: null, gl: null, error: null };
    try {
      var cc = window.cc;
      if (!cc || !cc.director) { out.error = 'no cc/director'; return out; }
      var scene = cc.director.getScene();
      if (!scene) { out.error = 'no scene (不在游戏场景?)'; return out; }
      var path = [];
      (function walk(node) {
        if (!node) return;
        path.push(node.name || '?');
        try {
          if (cc.Camera && node.getComponent && node.getComponent(cc.Camera)) {
            var cam = node.getComponent(cc.Camera);
            var rt = cam.targetTexture || null;
            out.cameras.push({
              path: path.join('/'), enabled: !!cam.enabled, clearFlags: cam.clearFlags,
              visibility: cam.visibility, hasTargetTexture: !!rt,
              rtSize: rt ? (rt.width + 'x' + rt.height) : null,
            });
          }
          // 大尺寸 Sprite 纹理：若存在烘焙好的静态地图底图，会在这里暴露（名字含 map 的优先看）
          if (cc.Sprite && node.getComponent && node.getComponent(cc.Sprite) && out.bigSprites.length < 80) {
            var sf = node.getComponent(cc.Sprite).spriteFrame;
            var tex = sf && sf.getTexture && sf.getTexture();
            if (tex && tex.width >= 256 && tex.height >= 256) {
              out.bigSprites.push({ path: path.join('/'), name: node.name, tex: tex.width + 'x' + tex.height });
            }
          }
          var cs = node.getContentSize && node.getContentSize();
          var nm = (node.name || '').toLowerCase();
          if (cs && cs.width > 60 && cs.width <= 640 && Math.abs(cs.width - cs.height) < 120 &&
              (nm.indexOf('mini') >= 0 || nm.indexOf('map') >= 0 || nm.indexOf('小地图') >= 0)) {
            var bb = node.getBoundingBoxToWorld ? node.getBoundingBoxToWorld() : null;
            out.miniNodes.push({
              path: path.join('/'), name: node.name, active: !!node.active,
              size: Math.round(cs.width) + 'x' + Math.round(cs.height),
              worldRect: bb ? [Math.round(bb.x), Math.round(bb.y), Math.round(bb.width), Math.round(bb.height)] : null,
            });
          }
        } catch (e) { /* 单节点异常不影响遍历 */ }
        var ch = node.children;
        if (ch) for (var i = 0; i < ch.length; i++) walk(ch[i]);
        path.pop();
      })(scene);
      var canvas = (cc.game && cc.game.canvas) || document.querySelector('#GameCanvas') || document.querySelector('canvas');
      if (canvas) {
        out.canvas = { id: canvas.id, w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight };
        try {
          var gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          out.gl = gl ? { ok: true, preserveDrawingBuffer: !!(gl.getContextAttributes && gl.getContextAttributes().preserveDrawingBuffer) } : { ok: false };
        } catch (e) { out.gl = { ok: false, err: String(e && e.message) }; }
      }
      console.log('%c[pocketcc] probeMinimap', 'color:#4a9fff;font-weight:bold', out);
      if (out.cameras.length) console.table(out.cameras);
      if (out.miniNodes.length) console.table(out.miniNodes);
      if (out.bigSprites.length) console.table(out.bigSprites);
      console.log('[pocketcc] canvas=', out.canvas, 'gl=', out.gl);
    } catch (e) { out.error = String((e && (e.stack || e.message)) || e); }
    return out;
  },
  /**
   * 【调试探针】尝试把「静态纹理」blit 成 dataURL，验证抓取游戏地形底图的可行性。
   * 思路：小地图节点(minimap)子树里的 cc.Sprite 若引用的是已加载的静态图集贴图，
   *   其 texture._image / texture.image（HTMLImageElement|ImageBitmap|canvas）是被保留的，
   *   可直接 drawImage 到 2D canvas 再 toDataURL —— 与 preserveDrawingBuffer 无关。
   * 控制台：pocketcc.gameApi.worldMap.grabTerrain()（需先进入世界地图、小地图可见）
   * @param {boolean} [preview] 默认 true：把抓到的最大纹理弹成 <img> 预览，便于肉眼确认。
   * @returns {object} { found:[{path,name,texW,texH,imgType,ok,len}], bestPath, bestLen, error }
   */
  grabTerrain(preview) {
    var out = { found: [], error: null };
    try {
      var cc = window.cc;
      if (!cc || !cc.director) { out.error = 'no cc/director'; return out; }
      var scene = cc.director.getScene();
      if (!scene) { out.error = 'no scene (不在世界地图场景?)'; return out; }
      if (preview === undefined) preview = true;
      // Cocos 3.x 上传 GPU 后释放了 CPU 侧图（drawImage 报 detached），gfx 纹理类名又被混淆（挖不到 WebGLTexture）。
      // 但贴图本来就是静态 PNG（nativeUrl），直接用 <img crossOrigin> 重新加载再 drawImage 即可（命中 HTTP 缓存）。
      var panel = null;
      if (preview) {
        panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;left:16px;top:110px;z-index:2147483647;background:#0d1117;padding:8px;border:2px solid #4a9fff;max-width:470px;max-height:82vh;overflow:auto;font:12px monospace;color:#cfe3ff;box-shadow:0 8px 40px rgba(0,0,0,.6)';
        var hd = document.createElement('div'); hd.textContent = 'grabTerrain — 异步加载中…（点此关闭）'; hd.style.cssText = 'cursor:pointer;margin-bottom:6px'; hd.onclick = function () { panel.remove(); };
        panel.appendChild(hd); document.body.appendChild(panel);
      }
      var base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : location.href;
      var urlVariants = function (raw) {
        var arr = []; if (!raw) return arr; arr.push(raw);
        try { arr.push(new URL(raw, base).href); } catch (e) {}
        try { arr.push(location.protocol + '//' + location.host + '/' + String(raw).replace(/^\/+/, '')); } catch (e) {}
        try { if (cc.assetManager && cc.assetManager.remoteServerRoot) arr.push(cc.assetManager.remoteServerRoot + raw); } catch (e) {}
        var seen = {}, u = []; for (var i = 0; i < arr.length; i++) { if (arr[i] && !seen[arr[i]]) { seen[arr[i]] = 1; u.push(arr[i]); } } return u;
      };
      var tryLoad = function (urls, i, rec, done) {
        if (i >= urls.length) { rec.imgType = 'IMG_ERR'; rec.err = rec.lastErr || 'all urls failed'; if (panel) { var e0 = document.createElement('div'); e0.style.cssText = 'color:#ff8f8f;margin:2px 0'; e0.textContent = (rec.name || '') + ' ✗ ' + (rec.err || ''); panel.appendChild(e0); } done(); return; }
        var img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            var c = document.createElement('canvas'); c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            var durl = c.toDataURL('image/png');
            rec.imgType = 'IMG_OK'; rec.usedUrl = urls[i]; rec.len = durl.length; rec.ok = true; rec.imgW = w; rec.imgH = h;
            if (panel) { var one = document.createElement('div'); one.style.cssText = 'margin-bottom:8px';
              var lab = document.createElement('div'); lab.style.cssText = 'color:#8fd0ff;margin:2px 0';
              lab.textContent = (rec.name || '') + ' ' + w + 'x' + h + ' (' + Math.round(durl.length / 1024) + 'KB) · ' + rec.path.split('/').slice(-2).join('/');
              var im2 = document.createElement('img'); im2.src = durl; im2.style.cssText = 'max-width:430px;max-height:430px;display:block;image-rendering:pixelated;border:1px solid #333';
              one.appendChild(lab); one.appendChild(im2); panel.appendChild(one);
            }
            done();
          } catch (e) { rec.imgType = 'TAINTED'; rec.err = String(e && e.message); done(); }
        };
        img.onerror = function () { rec.lastErr = 'err@' + urls[i]; tryLoad(urls, i + 1, rec, done); };
        img.src = urls[i];
      };
      var path = [];
      var seenTex = [];
      (function walk(node) {
        if (!node) return;
        path.push(node.name || '?');
        try {
          var inMini = path.join('/').toLowerCase().indexOf('minimap') >= 0;
          if (inMini && cc.Sprite && node.getComponent) {
            var sp = node.getComponent(cc.Sprite);
            var sf = sp && sp.spriteFrame;
            var tex = sf && sf.getTexture && sf.getTexture();
            if (tex && tex.width >= 256 && tex.height >= 256 && seenTex.indexOf(tex) < 0) {
              seenTex.push(tex);
              out.found.push({
                path: path.join('/'), name: node.name, texW: tex.width, texH: tex.height,
                rawUrl: tex.nativeUrl || tex._nativeUrl || null, imgType: 'PENDING', ok: false, len: 0,
              });
            }
          }
        } catch (e) { /* ignore single node */ }
        var ch = node.children;
        if (ch) for (var i = 0; i < ch.length; i++) walk(ch[i]);
        path.pop();
      })(scene);
      console.log('%c[pocketcc] grabTerrain', 'color:#4a9fff;font-weight:bold', out.found);
      if (out.found.length) console.table(out.found.map(function (r) { return { name: r.name, tex: r.texW + 'x' + r.texH, url: r.rawUrl }; }));
      out.found.forEach(function (rec) { tryLoad(urlVariants(rec.rawUrl), 0, rec, function () { console.log('[pocketcc] loaded', rec.name, rec.imgType, rec.usedUrl || rec.err || ''); }); });
      if (panel && !out.found.length) { var e1 = document.createElement('div'); e1.textContent = '未发现 minimap 下 ≥256 的纹理'; panel.appendChild(e1); }
    } catch (e) { out.error = String((e && (e.stack || e.message)) || e); }
    return { found: out.found.map(function (r) { return { path: r.path, name: r.name, url: r.rawUrl, imgType: r.imgType, ok: r.ok }; }), error: out.error };
  },
  /**
   * 【调试探针】抓取游戏当前渲染到屏幕的那一帧（真实世界地图外观）。
   * 关键：Cocos 3.x 的 cc.Director.EVENT_AFTER_DRAW 在引擎画完、浏览器合成/清屏「之前」同步触发，
   *   此刻对「默认帧缓冲」readPixels 能拿到真实合成结果——与 preserveDrawingBuffer 无关，
   *   也绕开「单张纹理被 detached / gfx 句柄被混淆」两条死路（我们读的是整屏合成，不是某张纹理）。
   * 用法：进到世界地图、把地图缩放到想复刻的视野，控制台执行 pocketcc.gameApi.worldMap.grabScreen()
   *   下一帧弹出整屏截图预览，dataURL 暂存到 window.__pocketccScreen。
   * @param {object} [opt] { x,y,w,h } 可选裁剪（CSS 像素，原点左上）；默认整屏。
   * @returns {object} { scheduled, note, error }
   */
  grabScreen(opt) {
    var out = { scheduled: false, error: null };
    try {
      var cc = window.cc;
      if (!cc || !cc.director) { out.error = 'no cc/director'; return out; }
      if (!cc.Director || !cc.Director.EVENT_AFTER_DRAW) { out.error = 'no cc.Director.EVENT_AFTER_DRAW'; return out; }
      var cnv = (cc.game && cc.game.canvas) || document.querySelector('#GameCanvas') || document.querySelector('canvas');
      var gl = cnv && (cnv.getContext('webgl2') || cnv.getContext('webgl'));
      if (!gl) { out.error = 'no webgl context'; return out; }
      opt = opt || {};
      var dpr = (window.devicePixelRatio || 1);
      var handler = function () {
        try { cc.director.off(cc.Director.EVENT_AFTER_DRAW, handler); } catch (e) {}
        try {
          var DW = gl.drawingBufferWidth, DH = gl.drawingBufferHeight;
          var cw = opt.w ? Math.round(opt.w * dpr) : DW;
          var chh = opt.h ? Math.round(opt.h * dpr) : DH;
          var cx = opt.x != null ? Math.round(opt.x * dpr) : 0;
          var cyCss = opt.y != null ? Math.round(opt.y * dpr) : 0;
          cx = Math.max(0, Math.min(DW - 1, cx));
          cw = Math.max(1, Math.min(DW - cx, cw)); chh = Math.max(1, Math.min(DH, chh));
          var cy = Math.max(0, Math.min(DH - chh, DH - cyCss - chh));
          var prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          var px = new Uint8Array(cw * chh * 4);
          gl.readPixels(cx, cy, cw, chh, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (prevFB) gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
          var c = document.createElement('canvas'); c.width = cw; c.height = chh;
          var ctx = c.getContext('2d'); var imgd = ctx.createImageData(cw, chh);
          for (var y = 0; y < chh; y++) { var src = (chh - 1 - y) * cw * 4, dst = y * cw * 4; imgd.data.set(px.subarray(src, src + cw * 4), dst); }
          ctx.putImageData(imgd, 0, 0);
          var url = c.toDataURL('image/png');
          window.__pocketccScreen = url;
          var nonzero = 0; for (var i = 0; i < px.length; i += 4) { if (px[i] || px[i + 1] || px[i + 2]) { nonzero = 1; break; } }
          console.log('%c[pocketcc] grabScreen', 'color:#4a9fff;font-weight:bold', { w: cw, h: chh, kb: Math.round(url.length / 1024), blank: !nonzero });
          var panel = document.createElement('div');
          panel.style.cssText = 'position:fixed;left:16px;top:110px;z-index:2147483647;background:#0d1117;padding:8px;border:2px solid #4a9fff;max-width:60vw;max-height:86vh;overflow:auto;font:12px monospace;color:#cfe3ff;box-shadow:0 8px 40px rgba(0,0,0,.6)';
          var hd = document.createElement('div'); hd.style.cssText = 'cursor:pointer;margin-bottom:6px';
          hd.textContent = 'grabScreen — ' + cw + 'x' + chh + (nonzero ? '' : '  (全黑：AFTER_DRAW 早于最终合成，需换 hook)') + ' · 点此关闭';
          hd.onclick = function () { panel.remove(); };
          var im = document.createElement('img'); im.src = url; im.style.cssText = 'max-width:100%;display:block;border:1px solid #333';
          panel.appendChild(hd); panel.appendChild(im); document.body.appendChild(panel);
        } catch (e) { console.warn('[pocketcc] grabScreen readPixels failed', e); }
      };
      cc.director.on(cc.Director.EVENT_AFTER_DRAW, handler);
      out.scheduled = true;
      out.note = 'capturing on next after-draw frame; keep the world map visible';
    } catch (e) { out.error = String((e && (e.stack || e.message)) || e); }
    return out;
  },
  /**
   * 【调试探针】判定「从 mapFile per-cell 数据重建真实地形底图」的可行性（需先进入世界地图）。
   *   实证结论（源码）：地形/装饰/阻挡都是 mapFiles[mapType].blocks[].levels[zoom].cells[layer]
   *   的逐格数据（layer: terrain=0/addon=1/area=2/block=3），经 NWorldMapTerrainModel 的
   *   getTerrain/getAddon/isBlock(cellX,cellY,scale) 读取；tileId→biome 名走 NMapAssets[type]
   *   .tileTextureMap.get(1)（地形）、.get(2)（装饰），名里含 desert/snow/water/forest/volcano/dx/th 等
   *   即生物群系类别（mapType=202 的 tileMap 为空，名字全在 tileTextureMap，故必须用它解析）。
   *   本探针一次性回官：mapFile 是否已加载 + blocks 结构 + 逐格 terrain/block/addon 覆盖分布
   *   + 每类 biome 占比 + top tileId→biome 名。控制台：pocketcc.gameApi.worldMap.probeTerrainData()
   * @returns {object} 汇总（同时 console.table 打印 topTiles / topAddons）
   */
  probeTerrainData() {
    var out = { error: null };
    try {
      var mapType = this.mapType();
      out.mapType = mapType;
      var model = this.terrainModel();
      out.hasModel = !!model;
      var mc = ns(game.get(SYM.modules.mapCommon));
      var infos = mc && (mc.allMapInfos || (mc.NWorldMapCommon && mc.NWorldMapCommon.allMapInfos));
      var S = mc && (mc.NWorldMapSettings || (mc.NWorldMapCommon && mc.NWorldMapCommon.NWorldMapSettings));
      var info = infos && infos[mapType];
      out.info = info ? { cols: info.cols, rows: info.rows, terrainNum: info.terrainNum, settings: info.settings } : null;
      if (S && info) out.settings = {
        outline: !!(info.settings & S.outline), terrainTiled: !!(info.settings & S.terrainTiled),
        newTerrain: !!(info.settings & S.newTerrain), newTerrainV2: !!(info.settings & S.newTerrainV2),
        haveDefaultTerrain: !!(info.settings & S.haveDefaultTerrain), borderTerrain: !!(info.settings & S.borderTerrain),
      };
      // mapFile 原始结构（blocks / levels / cells 各层字节长度）
      var md = ns(game.get(SYM.modules.mapData));
      var inst = md && (md.instance || (md.NWorldMapData && md.NWorldMapData.instance));
      var mf = inst && inst.mapFiles && inst.mapFiles[mapType];
      out.mapFileLoaded = !!mf;
      if (mf) {
        out.mapFile = {
          ver: mf.ver, blockCount: mf.blocks && mf.blocks.length,
          blocks: (mf.blocks || []).map(function (b) {
            var lv = {};
            if (b.levels && b.levels.forEach) b.levels.forEach(function (l, z) {
              var cl = [];
              if (l.cells) for (var k in l.cells) { var arr = l.cells[k]; cl.push('L' + k + ':' + (arr && arr.length)); }
              lv['zoom' + z] = cl.join(' ');
            });
            return { cols: b.cols, rows: b.rows, posMode: b.posMode, posModeArgs: (b.posModeArgs || []).slice(0, 10), levels: lv, mountain: (b.mountain || []).length };
          }),
        };
      }
      var cols = (info && info.cols) || (this.size() && this.size().cols) || 408;
      var rows = (info && info.rows) || (this.size() && this.size().rows) || 952;
      out.dims = { cols: cols, rows: rows };
      // assets：优先 tileTextureMap（202 在此），退化 tileMap
      var ma = game.get(SYM.modules.mapAssets);
      var NMapAssets = ma && (ma.NMapAssets || (ma.default && ma.default.NMapAssets));
      var assets = NMapAssets && NMapAssets[mapType];
      var tt1 = assets && assets.tileTextureMap && assets.tileTextureMap.get ? assets.tileTextureMap.get(1) : null;
      var tt2 = assets && assets.tileTextureMap && assets.tileTextureMap.get ? assets.tileTextureMap.get(2) : null;
      var biomeOf = function (tid) { var e = (tt1 && tt1.get(tid)) || (assets && assets.tileMap && assets.tileMap.get(tid)); return (e && e[0]) || null; };
      var addonOf = function (aid) { var e = (tt2 && tt2.get(aid)) || (assets && assets.tileMap && assets.tileMap.get(aid)); return (e && e[0]) || null; };
      var cat = function (name) { if (!name) return 'none'; var n = String(name).toLowerCase();
        if (n.indexOf('water') >= 0) return 'water';
        if (n.indexOf('snow') >= 0) return 'snow';
        if (n.indexOf('volcano') >= 0) return 'volcano';
        if (n.indexOf('desert') >= 0) return 'desert';
        if (n.indexOf('forest') >= 0) return 'forest';
        if (n.indexOf('dx') >= 0) return 'dx';
        if (n.indexOf('th1') >= 0 || n.indexOf('th2') >= 0) return 'grass';
        if (n.indexOf('default') >= 0) return 'default';
        return 'other'; };
      // 全网格抽样：terrain / block / addon 覆盖 + biome 类别直方图
      var hist = {}, catHist = {}, addonHist = {}, total = 0, nonZero = 0, blockCnt = 0, addonCnt = 0;
      var step = Math.max(1, Math.floor(Math.min(cols, rows) / 60));
      if (model && typeof model.getTerrain === 'function') {
        for (var y = 0; y < rows; y += step) for (var x = 0; x < cols; x += step) {
          var tid; try { tid = model.getTerrain(x, y, 1) | 0; } catch (e) { tid = -999; }
          total++; if (tid) nonZero++;
          hist[tid] = (hist[tid] || 0) + 1;
          var c = cat(biomeOf(tid)); catHist[c] = (catHist[c] || 0) + 1;
          try { if (typeof model.isBlock === 'function' && model.isBlock(x, y)) blockCnt++; } catch (e) { }
          try { if (typeof model.getAddon === 'function') { var aid = model.getAddon(x, y, 1) | 0; if (aid) { addonCnt++; var an = addonOf(aid) || ('#' + aid); addonHist[an] = (addonHist[an] || 0) + 1; } } } catch (e) { }
        }
      } else out.getTerrain = 'no getTerrain fn';
      out.sample = { total: total, nonZero: nonZero, blockCnt: blockCnt, addonCnt: addonCnt, distinctTiles: Object.keys(hist).length };
      out.catHist = catHist;
      out.topTiles = Object.keys(hist).map(function (k) { return { tid: Number(k), n: hist[k], biome: biomeOf(Number(k)) || '', cat: cat(biomeOf(Number(k))) }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 24);
      out.topAddons = Object.keys(addonHist).map(function (k) { return { addon: k, n: addonHist[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 18);
      if (assets) out.assets = { terrainTexture: assets.terrainTexture, addonTexture: assets.addonTexture, specTerrainTexture: assets.specTerrainTexture || null, terrainScale: assets.terrainScale, hasTileTextureMap: !!assets.tileTextureMap, tileMapSize: assets.tileMap && assets.tileMap.size, tt1Size: tt1 && tt1.size, tt2Size: tt2 && tt2.size, waterIds: assets.waterIds, hillCount: assets.hillIds && assets.hillIds.length };
      else out.assets = 'NMapAssets[' + mapType + '] missing';
    } catch (e) { out.error = String((e && (e.stack || e.message)) || e); }
    console.log('%c[pocketcc] probeTerrainData', 'color:#4a9fff;font-weight:bold', out);
    if (out.topTiles && out.topTiles.length) console.table(out.topTiles);
    if (out.topAddons && out.topAddons.length) console.table(out.topAddons);
    if (out.mapFile && out.mapFile.blocks) console.table(out.mapFile.blocks);
    return out;
  },
  /**
   * 【调试探针】遍历整个场景，抽出所有材质/Sprite 纹理（含 nativeUrl），并列出名字含 terrain 的节点及其组件类型。
   *   目的：定位 newTerrainV2（mapType 202）地形网格用的纹理——若有一张覆盖全图的大地形纹理，直接按 nativeUrl 抓下来当底图。
   *   控制台：pocketcc.gameApi.worldMap.probeNewTerrainAssets()（需先进入世界地图）
   * @returns {object} { terrainNodes, textures:[{tag,w,h,url}], newTerrainV2, matKeys }
   */
  probeNewTerrainAssets() {
    var out = { error: null, textures: [], terrainNodes: [], matKeys: null, newTerrainV2: null };
    try {
      var cc = window.cc;
      if (!cc || !cc.director) { out.error = 'no cc/director'; return out; }
      var scene = cc.director.getScene();
      if (!scene) { out.error = 'no scene (不在世界地图?)'; return out; }
      var seen = {};
      var pushTex = function (tex, tag) {
        try {
          if (!tex || !tex.width) return;
          var url = tex.nativeUrl || tex._nativeUrl || null;
          var key = (url || '') + '@' + tex.width + 'x' + tex.height;
          if (seen[key]) return; seen[key] = 1;
          out.textures.push({ tag: tag, w: tex.width | 0, h: tex.height | 0, url: url });
        } catch (e) { }
      };
      var grabMat = function (m, tag) {
        if (!m) return;
        if (!out.matKeys && m.getTexture) { try { out.matKeys = Object.keys(m).slice(0, 30); } catch (e) { } }
        var names = ['mainTexture', 'texture', 'albedoMap', 'diffuseMap', 'baseMap'];
        try { if (typeof m.getTexture === 'function') for (var i = 0; i < names.length; i++) { var t = m.getTexture(names[i]); if (t) pushTex(t, tag + ':' + names[i]); } } catch (e) { }
        try { if (m.texture) pushTex(m.texture, tag + '.texture'); } catch (e) { }
        try { if (m._texture) pushTex(m._texture, tag + '._texture'); } catch (e) { }
        try { if (m.effect && m.effect.textures) { for (var k in m.effect.textures) pushTex(m.effect.textures[k], tag + '.eff.' + k); } } catch (e) { }
      };
      var walk = function (node, path) {
        if (!node) return;
        var nm = node.name || '?';
        var p = path + '/' + nm;
        try {
          if (/terrain/i.test(nm) && out.terrainNodes.length < 30) {
            var comps = node._components || [];
            var cn = [];
            for (var q = 0; q < comps.length && cn.length < 8; q++) { try { cn.push(comps[q] && (comps[q].__type__ || (comps[q].constructor && comps[q].constructor.name))); } catch (e) { } }
            out.terrainNodes.push({ path: p, comps: cn.join(',') });
          }
          var cs = node._components;
          if (cs) for (var ci = 0; ci < cs.length; ci++) {
            var c = cs[ci]; if (!c) continue;
            try { if (c.spriteFrame) { var t = c.spriteFrame.getTexture && c.spriteFrame.getTexture(); if (t) pushTex(t, p + '#sprite'); } } catch (e) { }
            try { if (typeof c.getMaterial === 'function') { for (var mi = 0; mi < 4; mi++) { var mm = c.getMaterial(mi); if (mm) grabMat(mm, p + '#m' + mi); } } } catch (e) { }
            try { if (c.materials) for (var qi = 0; qi < c.materials.length; qi++) grabMat(c.materials[qi], p + '#ms' + qi); } catch (e) { }
            try { if (c.sharedMaterials) for (var ri = 0; ri < c.sharedMaterials.length; ri++) grabMat(c.sharedMaterials[ri], p + '#sms' + ri); } catch (e) { }
            try { if (c._materials) for (var si = 0; si < c._materials.length; si++) grabMat(c._materials[si], p + '#_m' + si); } catch (e) { }
          }
        } catch (e) { }
        var ch = node.children; if (ch) for (var j = 0; j < ch.length; j++) walk(ch[j], p);
      };
      walk(scene, '');
      var mc = ns(game.get(SYM.modules.mapCommon));
      var infos = mc && (mc.allMapInfos || (mc.NWorldMapCommon && mc.NWorldMapCommon.allMapInfos));
      var info = infos && infos[this.mapType()];
      if (info && info.newTerrainV2) { var nv = info.newTerrainV2; out.newTerrainV2 = { defaultPrefab: nv.defaultPrefab, hasSubMapPrefabs: !!nv.subMapPrefabs, hasSubMap: !!nv.subMap }; }
      out.textures.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });
      out.textures = out.textures.slice(0, 50);
    } catch (e) { out.error = String((e && (e.stack || e.message)) || e); }
    console.log('%c[pocketcc] probeNewTerrainAssets', 'color:#4a9fff;font-weight:bold', out);
    if (out.terrainNodes.length) console.table(out.terrainNodes);
    if (out.textures.length) console.table(out.textures);
    return out;
  },
};

/**
 * 调试面（仅供控制台，不入业务路径）：与 core 工具同挂 window.pocketcc（见 content.entry.js），
 * 逆向时 `pocketcc.api.march.flags()` 看战场判定器是否解析成功、
 * `pocketcc.api.march.resolve(13)` 看基础 marchType 在当前战场漂成哪个值（无需等到活动图里复现）。
 */
export const debug = { SYM, probe, ns, game, l10n, nav, march, gameData, gameConf, bits, session, avatar, worldMap, battlePreset, scene, ui };
