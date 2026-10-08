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
    marchStorage: 'MarchStorageController', // 出征档案门面：getInstance() 由 subpack2 启动接管（Subpack2Main.main → initMarchStorageController）注入 Real 实现
    procedureManager: 'ProcedureManager', // 场景程序管理器（PROCE 单例）：Run(PROCE.Home/PROCE.NewWorld) 切场景，与主界面「世界/回城」按钮同源
    uiManager: 'UIManager',               // UI 管理器门面（default.Instance().OpenUI(UIDataInfo.xxx) 打开原生面板）
    uiDataInfo: 'UIDataInfo',             // 面板描述符注册表（UIDataInfo.<PanelName> → UIDataInfoClass 实例）
    homeMapUtils: 'HomeMapUtils',         // 大本营地图工具（default.getMapPosByPosId：posId→主城小格坐标 {x,y}），空投落点换算用
    homeMapCommon: 'HomeMapCommon',       // 大本营地图常量（WidthCount/HeightCount 主城网格尺寸），空投落点扫描边界用
    commonTools: 'CommonTools',           // 通用工具（subpack2）：checkShieldEnable(false) 权威「能否开盾」闸（狂热/危险区/跨服一次覆盖，抑制 UI）
    worldMapCtrl: 'WorldMapController',   // 旧图主控：静态 model.checkIsPlainTile(x,y,true) 为迁城落点合法性只读判定（cc 组件类无 getInstance，故取 .model）
    nWorldMapUtils: 'NWorldMapUtils',     // 新图迁城工具（subpack2、模块级）：checkCanMove(x,y) 落点合法性权威判定（当前游戏默认走新图；符号缺失软失败）
    nWorldMapTerritoryModel: 'NWorldMapTerritoryModel', // 新图联盟领地单例（subpack2）：AllianceTerritory 存视口内堡垒领地条目 {x,y,w,bw,owner,buildId}，供迁城落点推「禁迁实心区」（符号缺失软失败）
    nWorldMapData: 'NWorldMapData',       // 新图世界数据单例（subpack2）：instance.placeFlags 为 cell 级占用 Map，settle 就绪门按邻域命中计数（符号缺失软失败）
    gameTools: 'GameTools',               // 游戏工具：isKVK() 判 KVK 跨服战场图（=isC4||isC8||isC8S2），迁城落点「仅本服图拦别盟领地」分区闸门（符号缺失保守当本服）
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
  /** UserData 子对象上的数据成员名（属性链符号，Alliance.<name>；WorldCoord 为 UserData 直属成员，myWorldPos 经 SYM 引用）；buffPool=UserData.Buff 为 BuffPool 实例（非可 require 模块），getStateDataById 读战争状态/护盾 EndTime */
  dataProps: { allianceBoss: 'AllianceBossData', allianceScience: 'scienceData', allianceBehemoth: 'allianceBehemothData', worldCoord: 'WorldCoord', buffPool: 'Buff' },
  /** 行军/地块枚举成员名（只记名字，数值运行时向游戏枚举对象取） */
  marchEnum: {
    obj: 'MarchType',                                 // WorldMapCommon 导出：新旧图同一张 MarchType 表
    attackPlayer: 'ATTACK_PLAYER',                    // 13 本服攻玩家城
    tmAttackPlayer: 'TM_ATTACK_PLAYER',               // 150 双子星（无双）战场
    masterAttackPlayer: 'MASTER_ATTACK_PLAYER',       // 170 王者对战
    avaAttackPlayer: 'AVA_ATTACK_PLAYER',             // 110 新跨服战场
    teamLegendAttackPlayer: 'TEAM_LEGEND_ATTACK_PLAYER', // 181 军团传奇
    attackWorldBoss: 'ATTACK_WORLDBOSS',              // 14 普通世界 boss（quick-attack/imperial-decree 经 typeOf 取名值）
    attackWorldBossV2: 'ATTACK_WORLD_BOSS_V2'         // 298 bossV2 世界 boss（同上；source-of-war 本地写死 298 未走此）
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

// ─────────────────────── 能力校验表（feat 安装期依赖自检） ───────────────────────

/**
 * 能力键 → 只读校验器：feat 在 spec.symbols 里按语义名声明依赖的游戏 bundle 符号，
 * reactor 在调用 spec.install 前逐一经本表校验；任一项解析不到即安装失败并记 warn。
 * 符号名知识收在本文件（ACL），feat 只写语义名，不出现游戏模块名字符串。
 * 约定：
 *   - 校验只判「模块在场 + 声明的成员链可达」，不判方法签名（漂移细节仍由 probe 运行期告警）；
 *   - 名字末尾带 '?' 的软能力（feat 已有降级路径）缺失只告警不阻断，由 reactor 侧解释；
 *   - 惰性解析的实例 getter（instance）可能在安装期尚未建立，故此类能力只校验模块/类在场。
 * @type {Object<string, function():boolean>}
 */
export const CAPS = {
  dataCenter: () => { var m = game.get(SYM.modules.dataCenter); return !!(m && m.DATA); },
  localManager: () => { var m = game.get(SYM.modules.localManager); return !!(m && m.LOCAL); },
  tableManager: () => { var m = game.get(SYM.modules.tableManager); return !!(m && m.TABLE); },
  tableName: () => { var m = game.get(SYM.modules.tableName); return !!(m && (m.TableName || (m.default && m.default.TableName))); },
  tableUtils: () => { var m = game.get(SYM.modules.tableUtils); return !!(m && (typeof m.getDataConfigData === 'function' || (m.default && typeof m.default.getDataConfigData === 'function'))); },
  gameDefine: () => { var m = game.get(SYM.modules.gameDefine); return !!(m && (m.FunctionKey || (m.default && m.default.FunctionKey))); },
  long64Bit: () => { var m = game.get(SYM.modules.long64Bit); return !!(m && m.Int64); },
  chatCommon: () => !!game.get(SYM.modules.chatCommon),
  platformCore: () => !!game.get(SYM.modules.platformCore),
  eventIds: () => { var m = game.get('EventId'); return !!(m && m.EventId); },
  gameTools: () => { var m = game.get('GameTools'); return !!(m && (m.default || m)); },
  activityController: () => { var m = game.get('ActivityController'); return !!(m && m.ActivityController && m.ActivityController.Instance); },
  marchType: () => { var m = game.get(SYM.modules.mapOldCommon); return !!(m && m[SYM.marchEnum.obj]); },
  worldUtils: () => { var W = ns(game.get(SYM.modules.worldUtils)); return !!(W && typeof W.dealMarchTypeWithSpecialMarch === 'function'); },
  presetMarch: () => { var m = game.get('PresetMarchController'); return !!(m && m.default && m.default.instance); },
  heroController: () => !!game.get('HeroController'),
  mechaController: () => !!game.get('MechaController'),
  formationAdv: () => !!game.get('FightFormationAdvController'),
  marchStorage: () => { var m = game.get(SYM.modules.marchStorage); return !!(m && (m.MarchStorageController || (m.default && m.default.MarchStorageController))); },
  buff: () => { var u = userData(); var B = u && u[SYM.dataProps.buffPool]; return !!(B && typeof B.getStateDataById === 'function'); },
  commonTools: () => !!game.get(SYM.modules.commonTools),
  homeMapUtils: () => !!game.get(SYM.modules.homeMapUtils),
  homeMapCommon: () => !!game.get(SYM.modules.homeMapCommon),
  worldSite: () => { var m = game.get(SYM.modules.worldSiteCtrl); return !!(m && (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController))); },
  rewardCtrl: () => { var m = game.get(SYM.modules.rewardCtrl); return !!(m && (m.RewardController || (m.default && m.default.RewardController))); },
  enigmaBeast: () => !!game.get('EnigmaBeastController'),
  marchTools: () => !!game.get('MarchTools'),
  terrainModel: () => !!game.get(SYM.modules.terrainModel),
  navFly: () => !!mapTodo(),
};

/**
 * 校验一个能力键在场（未知键返回 false —— 声明笔误在开发期 F5 即暴露）。
 * @param {string} key 能力语义名（CAPS 键，可带 '?' 后缀表软依赖）
 * @returns {boolean}
 */
export function checkCap(key) {
  var k = String(key || '').replace(/\?$/, '');
  var f = CAPS[k];
  if (!f) { log.warn('checkCap: 未登记的能力键 "%s"', key); return false; }
  try { return !!f(); } catch (e) { return false; }
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
  /** 坐标飞行：click=true 且有 JUMP_TO_TILE_CLICK → 飞完模拟点地块（弹城市弹窗），否则 MOVE_TO 只飞+标记。
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
   * 对外供 feats 以游戏枚举为权威源取名值（如 quick-attack/imperial-decree 的世界 BOSS 行军类型），
   * resolve 内部换算亦经此。
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
  /**
   * 本人基地战力（=UserData.Power，游戏顶栏同源；真机探针实证 Power 为明文整数 48906307，与地图 p.power 同量纲）。
   * 取不到返回 null（而非 0）：自动防御开盾的战力闸门据 null 走「未知→最悲观」保守分支，不可把「取不到」误当「战力为 0 而判我更强」。
   * @returns {number|null}
   */
  myPower() { try { var p = userData() && userData().Power; return (p != null && !isNaN(Number(p))) ? Number(p) : null; } catch (e) { return null; } },
  /** 本人联盟 aid（=UserData.Alliance.Aid，与地图 p.aid 同源）；未入盟/取不到返回 0 */
  myAid() { try { var a = userData() && userData().Alliance; return Number(a && a.Aid) || 0; } catch (e) { return 0; } },
  /**
   * 本人联盟 tag 串（=UserData.Alliance.Tag，AllianceData 构造 `this.Tag = e.basic.tag` 已核对）。
   * 用于「只与同联盟成员比对」这类判据：联盟类下发（如 1585 的 ownerAllianceTag）只带 tag 不带 aid，
   * 按 aid 比对需逐 uid 反查（回调式、代价高），故 tag 字符串比对是这类全量列表的唯一可行口径。
   * @returns {string} 未入盟/取不到返回 ''（调用方据此判「无联盟」而非「匹配任意」）
   */
  myAllianceTag() { try { var a = userData() && userData().Alliance; return String((a && a.Tag) || ''); } catch (e) { return ''; } },
  /** 本人主城/账号等级（=UserData.Level，功能 open_level 门槛判据同源）；取不到返回 0 */
  level() { try { return Number(userData() && userData().Level) || 0; } catch (e) { return 0; } },
  /**
   * 本人基地世界坐标（UserData.WorldCoord，口径同 NWorldMapUIComponent 的小地图定位）。
   * @returns {{x:number, y:number}|null} 取不到/字段不全返回 null
   */
  myWorldPos() {
    var c = userData() && userData()[SYM.dataProps.worldCoord];
    if (!c || c.x == null || c.y == null) return null;
    return { x: c.x | 0, y: c.y | 0 };
  },
  /**
   * 空投支援合法落点（只读、**场景无关**）：复刻游戏 HomeMap.findValidAirDropBoxArea 的落点判定，但不依赖 HomeMap 场景组件
   *   （该组件离开 Home 即被 cpnDestroy 置 null）。原版三块数据的权威来源均可在任意场景只读获取：
   *     · 地形/可投放合法性：HomeMapUtils.checkHomeBoxLegal（静态表 HomeMapTileBlockTypeTable，任何场景可调）；
   *     · 建筑占用：DataCenter.UserData.Buildings（正是 HomeMap.InitBuildings 的数据源、服务器推送的常驻单例），
   *       footprint 复用游戏自身的等距展开函数 HomeMapUtils.getMapPosList（与 checkHomeBoxLegal 内部同一生成器，零口径漂移）；
   *     · 空投 footprint：BUILDING 表 buildingId 行的 width/height（缺省 3×3）。
   *   原版把搜索种子锚在「当前视口中心」（必然已解锁疆域）再螺旋外扩；本实现把扫描锚定在主城网格中心、按距中心由近及远，
   *   等价地优先落在玩家早期即解锁的核心地块，规避「静态表合法但疆域未解锁」的外围格被服务器拒。
   *   占用采保守口径：把 UserData.Buildings 里每个建筑的 footprint 全计为占位（含游戏侧本不计占位的地面装饰/地板）——
   *   保守只会少选几格、绝不会选到与真建筑重叠的非法格（服务器端也忽略地面装饰，避开地面格是其合法子集），故无需精确复刻 IsGround 判据。
   * @param {number} buildingId 待投放建筑 id（空投建筑=9001001）
   * @returns {{x:number, y:number, posId:number}|null} 合法空位锚点（主城小格坐标，即 4170 param 口径）；符号缺失/无空地/无建筑数据返回 null（→ 本轮不发）
   */
  homeAirDropSpot(buildingId) {
    try {
      var HU = ns(game.get(SYM.modules.homeMapUtils));
      if (!HU || typeof HU.getMapPosList !== 'function' || typeof HU.checkHomeBoxLegal !== 'function'
        || typeof HU.getMapPosByPosId !== 'function' || typeof HU.getPosIdByMapPos !== 'function') {
        log.debug('homeAirDropSpot: HomeMapUtils 符号缺失（getMapPosList/checkHomeBoxLegal/…）→ 无法定位落点');
        return null;
      }
      var GD = game.get(SYM.modules.gameDefine);
      var BI_BUILD = GD && GD.BaseItemType && GD.BaseItemType.Building;   // 必为真值：传错 checkHomeBoxLegal 会跳过地形判定
      if (BI_BUILD == null) {
        log.debug('homeAirDropSpot: GameDefine.BaseItemType.Building 缺失 → 无法定位落点');
        return null;
      }
      var air = l10n.tableRow('building', buildingId);
      var airW = air && air.width > 0 ? air.width | 0 : 3;
      var airH = air && air.height > 0 ? air.height | 0 : 3;
      var HCM = ns(game.get(SYM.modules.homeMapCommon));
      var WC = (HCM && HCM.WidthCount) || 84, HC = (HCM && HCM.HeightCount) || 104;
      // 占用格集合：所有建筑 footprint（getMapPosList 与游戏内部同一等距生成器，口径一致）
      var occ = Object.create(null);
      var list = userData() && userData().Buildings;
      if (Array.isArray(list)) {
        for (var k = 0; k < list.length; k++) {
          var b = list[k];
          if (!b || b.Pos == null) continue;
          var cfg = l10n.tableRow('building', b.BuildingId);
          if (!cfg) continue;
          var mp = HU.getMapPosByPosId(b.Pos);
          if (!mp || mp.x == null || mp.y == null) continue;
          var cells = HU.getMapPosList(mp.x, mp.y, cfg.width | 0 || 1, cfg.height | 0 || 1);
          for (var j = 0; j < cells.length; j++) { if (cells[j] !== -1) occ[cells[j]] = 1; }
        }
      }
      // 由主城网格中心向外（切比雪夫环）扫第一个「地形合法 + 空投 footprint 全空」的锚点；限环数待在核心已解锁区，宁可本轮不发也不赌外围
      var cx = WC >> 1, cy = HC >> 1, R = Math.min(WC, HC) >> 1;
      for (var r = 0; r <= R; r++) {
        for (var dx = -r; dx <= r; dx++) {
          for (var dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // 只走本环边框，避免重扫内圈
            var x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= WC || y >= HC) continue;
            var pid = HU.getPosIdByMapPos(x, y);
            if (occ[pid]) continue;                                     // 快速淘汰：锚点格已被占
            if (!HU.checkHomeBoxLegal(x, y, airW, airH, BI_BUILD, buildingId, -1)) continue;  // 地形/可投放合法性
            var ac = HU.getMapPosList(x, y, airW, airH), free = true;
            for (var q = 0; q < ac.length; q++) { if (ac[q] === -1 || occ[ac[q]]) { free = false; break; } }
            if (free) return { x: x, y: y, posId: pid };
          }
        }
      }
      log.debug('homeAirDropSpot: 核心区半径 %d 环内无合法空位（BUILDING 表 %s→ footprint=%dx%d, 网格=%dx%d, 占用格数=%d）',
        R, air ? 'OK' : 'MISSING', airW, airH, WC, HC, Object.keys(occ).length);
      return null;   // 核心区内无合法空位（空地不足）
    } catch (e) { log.debug('homeAirDropSpot threw: %s —— 落点计算中途抛错被吞，本轮不发', e && (e.stack || e.message)); return null; }
  },
  /**
   * 地面上现存的空投建筑实例 id 列表（只读遍历 UserData.Buildings，BuildingId==buildingId 者）。
   * 用于开启 feat 前已落地、不会再重推 10101 的空投播种待收（随后由 4168 按实例 id 领取）。
   * @param {number} buildingId 空投建筑 buildingId（9001001）
   * @returns {string[]} 实例 id 字符串数组（4168 targetId 口径）；无数据/符号缺失返回 []
   */
  airDropInstances(buildingId) {
    try {
      var list = userData() && userData().Buildings;
      var out = [];
      if (!Array.isArray(list)) return out;
      // 64 位实例 id 超过 JS 安全整数：优先取字符串/protobuf Long.toString()，否则由 {_low,_high}/{low,high} 用 BigInt 精确还原
      var toIdStr = function (raw) {
        if (raw == null) return '';
        if (typeof raw === 'string') return /^\d+$/.test(raw) ? raw : '';
        if (typeof raw === 'object') {
          if (typeof raw.toString === 'function') {
            var s = String(raw.toString());
            if (/^\d+$/.test(s)) return s;
          }
          var lo = (raw._low != null ? raw._low : raw.low), hi = (raw._high != null ? raw._high : raw.high);
          if (lo != null && hi != null && typeof BigInt !== 'undefined') {
            lo = Number(lo); hi = Number(hi); if (lo < 0) lo += 4294967296;
            return (BigInt(hi) * (BigInt(1) << BigInt(32)) + BigInt(lo)).toString();
          }
        }
        if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
        return '';
      };
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b || Number(b.BuildingId) !== buildingId) continue;
        var id = toIdStr(b.Id != null ? b.Id : b.id);
        if (id) out.push(id);
      }
      return out;
    } catch (e) { log.debug('airDropInstances threw: %s', e && (e.message || e)); return []; }
  },
  /**
   * 秘密武器 cd_skill 次数/冷却可用性（只读复刻 PlayerSkillController.getSkillUseEnableNum/getSkillCdTime 的 type==2 口径）。
   * 数据来自 CD_SKILL_INFO(4169) 应答里 id 对应的那条技能状态（start/end 为 protobuf Long），账号从未用过则传 null。
   * @param {number} skillId cd_skill 表 id（空投支援=2）
   * @param {object|null} skill 该技能当前状态 {id,start,cnt,end}；无则 null
   * @returns {{type:number, available:number, nextMs:number, max:number, cd:number, cnt:(number|null)}|null}
   *   available=此刻可用次数（≥1 才能发 4170）；nextMs=下一枚次数恢复的**绝对毫秒时刻**（已满则 0）；配置缺失（符号漂移）返回 null。
   */
  cdSkillAvailability(skillId, skill) {
    try {
      var cfg = l10n.tableRow('cd_skill', skillId);
      if (!cfg) return null;
      var type = Number(cfg.type) | 0;
      var cd = Number(cfg.cd) || 0;     // 每枚次数恢复间隔（分钟）
      var max = Number(cfg.max) || 0;   // 次数上限
      var serverSec = gameData.serverTime() | 0;
      var msOf = function (v) {   // protobuf Long / {_low,_high} / number → 毫秒
        if (!v) return 0;
        if (typeof v === 'number') return v;
        if (typeof v.toNumber === 'function') { try { return v.toNumber(); } catch (e) { return 0; } }
        var lo = (v._low != null ? v._low : v.low), hi = (v._high != null ? v._high : v.high);
        if (lo == null || hi == null) return 0;
        lo = Number(lo); hi = Number(hi);
        if (lo < 0) lo += 4294967296;
        return hi * 4294967296 + lo;
      };
      if (type === 2) {   // 次数型（空投支援）：可用 = min(cnt + 自 start 起已恢复的整数枚, max)
        if (!skill) return { type: type, available: max, nextMs: 0, max: max, cd: cd, cnt: null };   // 从未用过 = 满次数
        var cnt = Number(skill.cnt) || 0;
        var startSec = Math.floor(msOf(skill.start) / 1000);
        var accr = cd > 0 ? Math.floor((serverSec - startSec) / (60 * cd)) : 0;
        if (accr < 0) accr = 0;
        var avail = Math.min(cnt + accr, max);
        var nextMs = avail >= max ? 0 : (startSec + (accr + 1) * 60 * cd) * 1000;   // 下一枚恢复的绝对毫秒
        return { type: type, available: avail, nextMs: nextMs, max: max, cd: cd, cnt: cnt };
      }
      // type1/type3：单次冷却型，end（绝对毫秒）过了即可用一次
      if (!skill) return { type: type, available: 1, nextMs: 0, max: 1, cd: cd, cnt: null };
      var endMs = msOf(skill.end);
      return { type: type, available: Math.floor(endMs / 1000) < serverSec ? 1 : 0, nextMs: endMs, max: 1, cd: cd, cnt: null };
    } catch (e) { return null; }
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
   * 战争状态 Buff 的结束时刻（只读，秒）：Buff.getStateDataById(stateId).EndTime 与服务器时间比较由调用方做。
   * 自动防御用来判战争狂热（130048/130049/130132）与护盾是否在期（stateId 50001）。
   * 符号缺失/无该状态一律回 0（调用方据此判「不在该状态」——放行后仍以服务器权威拒绝为最终裁决，见 feats/battle/auto-defense）。
   * EndTime 单位实证不定时按数量级折算：>1e11 视为毫秒折回秒。
   * @param {number} stateId Buff 状态 id
   * @returns {number} 结束时刻（epoch 秒）；0=不在该状态或探测不可用
   */
  buffStateEndTime(stateId) {
    // Buff 门面是 UserData 上的 BuffPool 实例（userData().Buff），非可 require 的模块——直接 game.get('Buff') 会抛「Cannot find module」
    var B = probe('UserData.Buff.getStateDataById', () => {
      var u = userData();
      var inst = u && u[SYM.dataProps.buffPool];
      return (inst && typeof inst.getStateDataById === 'function') ? inst : null;
    });
    if (!B) return 0;
    try {
      var st = B.getStateDataById(+stateId);
      if (!st) return 0;
      var end = Number(st.EndTime != null ? st.EndTime : st.endTime) || 0;
      if (end <= 0) return 0;
      return end > 1e11 ? Math.floor(end / 1000) : end;
    } catch (e) { return 0; }
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
    for (var i = 0; i < ids.length; i++) { if (gameData.buffStateEndTime(ids[i]) > now) return true; }
    return false;
  },
  /**
   * 本人护盾是否已生效（只读，stateId 50001 的结束时刻 > 服务器时间）。探测不可用返回 false（不阻断，交由 910 裁决）。
   * @returns {boolean}
   */
  shieldActive() { return gameData.buffStateEndTime(50001) > (gameData.serverTime() | 0); },
  /**
   * 游戏权威「能否开盾」闸（只读、抑制 UI：checkShieldEnable(false)）——命中狂热/危险区/跨服限制时返回 false，一次覆盖三重判定。
   * 符号缺失返回 null（调用方降级为「不预判、直接尝试、以 910 拒绝为准」）。
   * @returns {boolean|null} true=可开 / false=不可开 / null=无从判定（符号缺失）
   */
  canShield() {
    var C = probe(SYM.modules.commonTools + '.checkShieldEnable', () => {
      var m = ns(game.get(SYM.modules.commonTools));
      return (m && typeof m.checkShieldEnable === 'function') ? m : null;
    });
    if (!C) return null;
    try { return !!C.checkShieldEnable(false); } catch (e) { return null; }
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
        var C = c && (c.WorldMapController || (c.default && (c.default.WorldMapController || c.default)) || c);
        var model = C && C.model;
        if (model && typeof model.checkIsPlainTile === 'function') return { kind: 'ctrl', ref: model };
      } catch (e) {}
      return null;
    });
    if (!A) return null;
    try {
      if (A.kind === 'utils') return !!A.ref.checkCanMove(x | 0, y | 0);
      return !!A.ref.checkIsPlainTile(x | 0, y | 0, true);
    } catch (e) { return null; }
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
    return s >= 1 ? (s | 0) : 1;
  },
  /**
   * 本人主城外观 skinId（UserData.UsingCastleFace）；迁城落点 footprint 边长 = citySkinSize(此值)。
   * @returns {number|null} 取不到返回 null
   */
  usingCastleFace() {
    var u = userData();
    return (u && u.UsingCastleFace != null) ? u.UsingCastleFace : null;
  },
  /**
   * 联盟堡垒领地（禁迁区）原始条目只读快照：NWorldMapTerritoryModel 单例的 AllianceTerritory（随视口加载、出视口被 purge，故易失）。
   * 每条 {x,y,w,bw,owner,buildId} 为堡垒原点 + 旋转菱形宽高 + 归属联盟 aid；调用方据此推「实心禁迁区」（不依赖 AlliancePointPool 的奇偶采样，避免盲区漏判）。
   * 模型不可得（子包未载/未进世界图）返回 null（→ 交上层判「无从判定」，绝不猜测）；在场但当前为空返回 []。
   * @returns {Array<{x:number,y:number,w:number,bw:number,owner:number,buildId:number}>|null}
   */
  allianceTerritories() {
    var inst = probe('NWorldMapTerritoryModel.inst', function () {
      try {
        var m = game.get(SYM.modules.nWorldMapTerritoryModel);
        var C = m && (m.NWorldMapTerritoryModel || m.default || m);
        return (C && (C.instance || C)) || null;
      } catch (e) { return null; }
    });
    var AT = inst && inst.AllianceTerritory;
    if (!AT) return null;
    var out = [];
    for (var k in AT) {
      var it = AT[k];
      if (it && it.x != null && it.y != null) out.push({ x: it.x | 0, y: it.y | 0, w: it.w | 0, bw: it.bw | 0, owner: it.owner | 0, buildId: it.buildId });
    }
    return out;
  },
  /** 本人子服号（UserData.subServerID）；取不到返回 0——getCellIndex/cell 空间换算用 */
  subServerId() { try { return Number(userData().subServerID) || 0; } catch (e) { return 0; } },
  /**
   * 当前是否 KVK 跨服战场图（GameTools.isKVK = isC4||isC8||isC8S2）。用于迁城落点分区规则：
   * false=本服普通图（须拦别盟领地），true=跨服战场图（别盟领地随便进）。
   * 符号不可得保守返回 false（当本服处理，宁可多拦也不误迁被服务器拒）。
   * @returns {boolean}
   */
  isKVK() {
    var T = probe(SYM.modules.gameTools + '.isKVK', () => {
      try { var m = game.get(SYM.modules.gameTools); return (m && (m.default || m.GameTools || m)) || null; } catch (e) { return null; }
    });
    try { return !!(T && typeof T.isKVK === 'function' && T.isKVK()); } catch (e) { return false; }
  },
  /**
   * 本服是否处于「战区/跨服对战态」（UserData.ServerState === GameDefine.ServerState.Fight）。
   * 迁城落点权威豁免源（实证 extracted WorldMapController.moveCity）：服务端「别盟堡垒领地禁迁」
   * 仅在 `(!isKVK() || !八国色号) && ServerState != Fight && owner>0 && owner!=我的Aid` 时拒绝迁入——
   * 即 ServerState==Fight（作战态）时整图放开别盟领地，与本服/KVK 图无关。符号不可得保守返回 false
   * （维持禁落，宁可不迁也不误迁）。
   * @returns {boolean} true=作战态（禁迁豁免）
   */
  serverStateIsFight() {
    try {
      var u = userData();
      var GD = probe(SYM.modules.gameDefine + '.ServerState.Fight', () => ns(game.get(SYM.modules.gameDefine)));
      var fight = GD && GD.ServerState && GD.ServerState.Fight;
      if (u == null || fight == null) return false;
      return u.ServerState === fight;
    } catch (e) { return false; }
  },
  /**
   * 世界格索引（NWorldMapUtils.getCellIndex(x,y,ServerId,subServerID)）：game 坐标 + 服号 + 子服 → 唯一 cell index，供 placeFlags 逐格读。符号不可得返回 null。
   * @returns {number|string|null}
   */
  mapCellIndex(x, y) {
    var U = probe(SYM.modules.nWorldMapUtils + '.getCellIndex', () => {
      try { var m = game.get(SYM.modules.nWorldMapUtils); var u = m && (m.NWorldMapUtils || m.default || m); return (u && typeof u.getCellIndex === 'function') ? u : null; } catch (e) { return null; }
    });
    if (!U) return null;
    var svr = 0, sub = 0;
    try { var u = userData(); svr = u.ServerId | 0; sub = u.subServerID | 0; } catch (e) { }
    try { return U.getCellIndex(x | 0, y | 0, svr, sub); } catch (e) { return null; }
  },
  /**
   * settle 就绪信号：以 (x,y) 为中心 `(2r+1)²` 邻域内 placeFlags 命中格数。>0 表示该区域已随视口加载进 NWorldMapData（canMoveCity 据此可信）；
   * =0 表示区域未加载（canMoveCity 会把一切当空地误放行）。placeFlags 符号不可得返回 null（与「加载后确为空」区分）。
   * @param {number} x @param {number} y @param {number} r 邻域半宽（格）
   * @returns {number|null}
   */
  mapLoadedNear(x, y, r) {
    var W = probe(SYM.modules.nWorldMapData + '.inst', () => {
      try { var m = game.get(SYM.modules.nWorldMapData); var C = m && (m.NWorldMapData || m.default || m); return (C && (C.instance || C)) || null; } catch (e) { return null; }
    });
    var pf = W && W.placeFlags;
    if (!pf || typeof pf.has !== 'function') return null;
    r = r | 0; var n = 0;
    for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
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
    var inAlliance = false;
    try { inAlliance = !!a.isInAlliance(); } catch (e) { inAlliance = false; }
    if (!inAlliance || !gameData.functionOn('alliance_behemoth') || !u.behemothIsOpen) {
      return { open: false, items: [] };
    }
    var src = probe('Alliance.allianceBehemothData', () => {
      var d = a[SYM.dataProps.allianceBehemoth];
      return (d && typeof d.getAllianceBehemothData === 'function') ? d : null;
    });
    if (!src) return { open: true, items: [] };
    try {
      var map = src.getAllianceBehemothData();   // Map<behemothId, AllianceBehemothItemData>
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
    } catch (e) { return { open: true, items: [] }; }
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
    // probe 的 resolve 已返回 m.Int64（Int64 类本体 r），类上直接挂 fromString/fromNumber 静态方法；
    // 曾经多写一层 L.Int64.fromString → TypeError → catch return 0，导致所有大 id（19 位兽 id）
    // 装箱失败、服务器回 enigma_beast018「找不到对应异能兽信息，已失效」。
    try { return /^\d+$/.test(v) ? L.fromString(v) : L.fromNumber(Number(v) || 0); } catch (e) { return 0; }
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
 * 对外只暴露 scene.name() 与互切 toggleHomeWorld()；单切不单独暴露（热键只用互切，
 * 回城类需求走 nav.flyTo 坐标飞行，语义不同）。
 */
/** 切到 Home 场景（内部） */
function goHomeScene() {
  var p = proce();
  if (!p || !p[SYM.procedures.home]) return { ok: false, err: 'unavailable' };
  try { p.Run(p[SYM.procedures.home]); return { ok: true }; }
  catch (e) { log.warn('goHome failed: %s', e && e.message); return { ok: false, err: 'failed' }; }
}

/** 切到 NWorldMap 场景（内部） */
function goWorldScene() {
  var p = proce();
  if (!p || !p[SYM.procedures.newWorld]) return { ok: false, err: 'unavailable' };
  try { p.Run(p[SYM.procedures.newWorld]); return { ok: true }; }
  catch (e) { log.warn('goWorld failed: %s', e && e.message); return { ok: false, err: 'failed' }; }
}

export const scene = {
  /** 当前场景节点名（cc.director.getScene().name）；引擎未就绪返回 '' */
  name() { try { var s = cc.director.getScene(); return (s && s.name) || ''; } catch (e) { return ''; } },
  /** 基地↔大世界互切：按当前场景决定去向（走内部 goHomeScene/goWorldScene）；两者之外的场景不处理（返回 wrongscene） */
  toggleHomeWorld() {
    var cur = this.name();
    if (cur === SYM.sceneNames.newWorld) return goHomeScene();
    if (cur === SYM.sceneNames.home) return goWorldScene();
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
        return (u && typeof u.getMapGameSizeBySubMap === 'function') ? u : null;
      } catch (e) { return null; }
    });
    if (!U) return null;
    try {
      var s = U.getMapGameSizeBySubMap(gameData.subServerId());
      var w = s && (s.width != null ? s.width : s.x), h = s && (s.height != null ? s.height : s.y);
      return (w > 0 && h > 0) ? { xMax: (w | 0) - 1, yMax: (h | 0) - 1 } : null;
    } catch (e) { return null; }
  },
};

/**
 * 调试面（仅供控制台，不入业务路径）：与 core 工具同挂 window.pocketcc（见 content.entry.js），
 * 逆向时 `pocketcc.gameApi.march.flags()` 看战场判定器是否解析成功、
 * `pocketcc.gameApi.march.resolve(13)` 看基础 marchType 在当前战场漂成哪个值（无需等到活动图里复现）。
 */
export const debug = { SYM, CAPS, checkCap, probe, ns, game, l10n, nav, march, gameData, gameConf, bits, session, avatar, worldMap, battlePreset, scene, ui };
