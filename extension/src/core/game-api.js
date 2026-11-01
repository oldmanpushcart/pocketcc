/**
 * 游戏符号防腐层（ACL）：全项目唯一允许集中「游戏 bundle 内部符号名」知识的场所——
 * 模块注册名、类/单例属性链、枚举成员名、配置表名全部收在 SYM 表。游戏改版符号漂移时
 * 只改这一个文件；上层业务（feats/*、core/ui.js）只依赖能力 API，不感知符号名。
 *
 * 耦合分层立场（解耦重构的依据）：
 *   - 线路格式知识（llm 字段、ChatShareLinkType、消息模板规则）→ feats/system/chat/classify.js
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
    tableName: 'TableName', // 配置表名枚举（成员名→游戏表名字符串，如 BOSS="boss"）
    dataCenter: 'DataCenter',
    tableUtils: 'TableUtils',
    long64Bit: 'Long64Bit',
    chatCommon: 'chatCommon',
    platformCore: 'PlatformCore',
    mapNewBiz: 'NWorldMapCoreBiz',
    mapNewCtrl: 'NWorldMapTodoController',
    mapOldCommon: 'WorldMapCommon',
    mapOldCtrl: 'WorldMapTodoController',
    worldMapMsgs: 'WorldMapMsgs', // 世界地图内部消息总线（Names.WorldMapJumpToTile = 「镜头跳到地块」，聊天/坐标分享跳转同源）
    worldUtils: 'WorldUtils', // 行军类型换算（世界地图业务工具，静态类）
    crossUtils: 'CrossUtils', // 跨服战场类型判定（tmServerType 驱动）
    newCabCtrl: 'NewCABController', // 无双峡谷·AVA 代（NewCAB）控制器与活动数据
    pathUtils: 'PathUtils', // 资源路径换算（游戏自带头像图集名 → headpic CDN URL）
    gameDefine: 'GameDefine', // 全局枚举汇出（FunctionKey/EnergyType 等，CommonJS 直挂 exports）
    worldSiteCtrl: 'AllianceWorldSiteController', // 联盟遗迹（要塞）控制器门面，具名导出，实例在 _instance/instance
    rewardCtrl: 'RewardController', // 奖励配置解析器，ES 命名空间具名导出（无 .default），静态 Instance.getRewardsArrById 把奖励配置 id 解成道具清单
    terrainModel: 'NWorldMapTerrainModel', // 离线地形查询单例：getTerrain/getAreaByWorldMap/isBlock/cols/rows
    mapCommon: 'NWorldMapCommon', // 常量枚举：allMapInfos（按 mapType 的 rows/cols/subMap）、NWorldMapSettings
    marchStorage: 'MarchStorageController', // 出征档案门面：getInstance() 由 subpack2 启动接管（Subpack2Main.main → initMarchStorageController）注入 Real 实现
    procedureManager: 'ProcedureManager', // 场景程序管理器（PROCE 单例）：Run(PROCE.Home/PROCE.NewWorld) 切场景，与主界面「世界/回城」按钮同源
    uiManager: 'UIManager', // UI 管理器门面（default.Instance().OpenUI(UIDataInfo.xxx) 打开原生面板）
    uiDataInfo: 'UIDataInfo', // 面板描述符注册表（UIDataInfo.<PanelName> → UIDataInfoClass 实例）
    homeMapUtils: 'HomeMapUtils', // 大本营地图工具（default.getMapPosByPosId：posId→主城小格坐标 {x,y}），空投落点换算用
    homeMapCommon: 'HomeMapCommon', // 大本营地图常量（WidthCount/HeightCount 主城网格尺寸），空投落点扫描边界用
    commonTools: 'CommonTools', // 通用工具（subpack2）：checkShieldEnable(false) 权威「能否开盾」闸（狂热/危险区/跨服一次覆盖，抑制 UI）
    worldMapCtrl: 'WorldMapController', // 旧图主控：静态 model.checkIsPlainTile(x,y,true) 为迁城落点合法性只读判定（cc 组件类无 getInstance，故取 .model）
    nWorldMapUtils: 'NWorldMapUtils', // 新图迁城工具（subpack2、模块级）：checkCanMove(x,y) 落点合法性权威判定（当前游戏默认走新图；符号缺失软失败）
    nWorldMapTerritoryModel: 'NWorldMapTerritoryModel', // 新图联盟领地单例（subpack2）：AllianceTerritory 存视口内堡垒领地条目 {x,y,w,bw,owner,buildId}，供迁城落点推「禁迁实心区」（符号缺失软失败）
    nWorldMapData: 'NWorldMapData', // 新图世界数据单例（subpack2）：instance.placeFlags 为 cell 级占用 Map，settle 就绪门按邻域命中计数（符号缺失软失败）
    gameTools: 'GameTools', // 游戏工具：isKVK() 读 eightServerType 形态位（整季为真，不是「此刻在哪张图」），迁城落点「仅本服图拦别盟领地」分区闸门（符号缺失保守当本服）
    pabController: 'PabController', // 异能秘境（Pab）控制器门面：default=类，静态 getInstance() 由 subpack2 RealPabController 接管后返回实例（含 petCaptureOperation/getItemNumById/checkItemNumMax/roomBaseInfo/capturingInfo）
    watchNet: 'TMWatchNetMgr', // 跨服观战/秘境独立发送通道：default=类，静态 Instance 懒建单例；isPabBattleMap 时 sendPBV2 转 NetMgrSimple 独立 WebSocket（主 pocketcc.net 发不出去）
    marchCommon: 'NWorldMapMarchCommon', // 世界地图行军常量（subpack2）：模块级导出 NMarchState 枚举（MARCHING=1/ARRIVED=2/FIGHTING=12/PAB_FEED=21）
    mechaTowerCtrl: 'MechaTowerController', // 重装母舰（Mecha 塔）控制器门面：具名导出 MechaTowerController 类，静态 getInstance() 由 subpack2 Real 接管后实例才有 isOpenFunc（一键领取子玩法闸只读查询）
    enigmaBeastCtrl: 'EnigmaBeastController', // 异能兽控制器门面：default=类（静态 getInstance() 由 subpack Real 接管后才有实例），模块顶层还导出 BeastOpenType/BeastServerStatus 枚举（培育开启闸只读查询）
    csHuntCtrl: 'CSHuntController', // 夺宝奇兵（跨服寻宝）控制器门面：ES 命名空间具名导出（无 .default），静态 getInstance() 由 subpack2 RealCSHuntController 接管后返回实例；同模块还导出 CSHuntPhaseType/CSHuntEventType/CSHuntEventPhaseType/CSActivityPhaseType/CSEventSkillSpeType 字符串与数值枚举
    mailData: 'MailData', // 邮件数据层（CommonJS 直挂 exports）：MailShowGroupType 展示分组枚举 + mailManager（NMailModel 实例，由 subpack/SubpackMain 载入时 `m.mailManager=new I.default` 挂上，故晚于核心就绪）
  },
  /** 新图单例属性链：module[cls][inst]，枚举对象 module[goType] */
  newMap: { cls: 'NWorldMapTodoController', inst: 'instance', goType: 'NWorldMapGoType' },
  /** 旧图枚举对象属性名 */
  oldMap: { todoType: 'WorldMapToDoType' },
  /** 世界地图消息总线的消息名（成员名，数值运行时向游戏 Names 取） */
  mapMsgs: { jumpToTile: 'WorldMapJumpToTile' },
  /** 导航动作枚举名（按名字取值，不依赖静态数值——NWorldMapGoType 数值未落盘） */
  mapActions: {
    moveTo: 'MOVE_TO',
    tileClick: 'JUMP_TO_TILE_CLICK',
    marchClick: 'JUMP_TO_MARCH_CLICK',
  },
  /** 语义表名 → 游戏 TableName 字符串值（TableName.js 实证） */
  tables: {
    emotion: 'emotion',
    emotionNew: 'emotion_new',
    emojiGif: 'emoji_gif',
    item: 'item',
    building: 'building',
    // 次元矿洞三张表（TableName.mine_cave/_level/_interaction，报告 §6 实证；成员名与值同名小写）
    mineCave: 'mine_cave',
    mineCaveLevel: 'mine_cave_level',
    mineCaveInteraction: 'mine_cave_interaction',
    // 假面舞会/万圣节派对宝箱道具表（TableName.mask_mystery_party，成员名与值同名小写）。
    // 客户端读这张表一律 getTableByKeyFromBuffer(…, "item_id", …)（UserItemCityRewardBtn/Panel、
    // ItemData.GetDes 三处一致），主键并非 item_id，故须走 tableRowByKey 而非 tableRow。
    maskMysteryParty: 'mask_mystery_party',
  },
  /** UserData 子对象上的数据成员名（属性链符号，Alliance.<name>；WorldCoord 为 UserData 直属成员，myWorldPos 经 SYM 引用）；buffPool=UserData.Buff 为 BuffPool 实例（非可 require 模块），getStateDataById 读战争状态/护盾 EndTime */
  dataProps: {
    allianceBoss: 'AllianceBossData',
    allianceScience: 'scienceData',
    allianceBehemoth: 'allianceBehemothData',
    worldCoord: 'WorldCoord',
    buffPool: 'Buff',
    // 假面舞会今日已领次数表 / 已领实例名单：10053 PUSH_USER_DATA_COMMON 的
    // danceRec / myReceiveDance 两键回写。UserData 上的落地字段名已由客户端源码坐实（非探针）：
    // UserItemCityRewardBtn 读 UserData.itemCityRewardReceivedNum[itemId] 与
    // UserData.itemCityRewardReceivedInstIds.indexOf(String(instanceId))，故 maskDanceState() 的
    // 候选表把这两个语义名列在推送键之前（推送键保留，防不同版本落地名不同）。
    danceRec: 'danceRec',
    myReceiveDance: 'myReceiveDance',
  },
  /** 行军/地块枚举成员名（只记名字，数值运行时向游戏枚举对象取） */
  marchEnum: {
    obj: 'MarchType', // WorldMapCommon 导出：新旧图同一张 MarchType 表
    attackPlayer: 'ATTACK_PLAYER', // 13 本服攻玩家城
    // 「无双峡谷」是玩法族名而非单个 marchType（字典铁证：ava_ui_001=无双峡谷；TeamMatchBeginMatch 弹的
    // 文案 legen_team_match_052=「即将前往无双峡谷，将会重新登录」），AVA/TM/大师/传奇四代实现都进它；
    // 旧「雷神峡谷」（cab_ui_info_078）已死（CrossUtils.isCAB() 恒 false）。「双子星」是城市皮肤名
    // （skin_name_1901000=柏拉图双子星），与战场无关。命名定谳见
    // references/游戏逆向/场景识别与门控改造可行性报告.md §2。
    tmAttackPlayer: 'TM_ATTACK_PLAYER', // 150 无双峡谷·TeamMatch 代（组队赛，字典无独立词条）
    masterAttackPlayer: 'MASTER_ATTACK_PLAYER', // 170 环球大师赛（master_match_21）/无双峡谷-王者赛
    avaAttackPlayer: 'AVA_ATTACK_PLAYER', // 110 无双峡谷·AVA 代（mapType=new_cab）
    teamLegendAttackPlayer: 'TEAM_LEGEND_ATTACK_PLAYER', // 181 无双峡谷-小队赛/传奇赛（legend_team_match_101）
    attackWorldBoss: 'ATTACK_WORLDBOSS', // 14 普通世界 boss（quick-attack/imperial-decree 经 typeOf 取名值）
    attackWorldBossV2: 'ATTACK_WORLD_BOSS_V2', // 298 bossV2 世界 boss（同上；source-of-war 本地写死 298 未走此）
  },
  entityEnum: { obj: 'WorldMapEntityType', boss: 'BOSS', bossV2: 'BOSS_V2' },
  /** ProcedureManager.PROCE 单例上的场景程序成员名（各 Procedure 自带 sceneName，Run 时按 sceneName 判断是否切换） */
  procedures: { home: 'Home', newWorld: 'NewWorld' },
  /** 场景节点名（cc.director.getScene().name 口径，SceneName 枚举实证：HOME="Home"、NEWWORLD="NWorldMap"、WORLD="WorldMap"） */
  sceneNames: {
    home: 'Home',
    newWorld: 'NWorldMap',
    worldOld: 'WorldMap',
    homeOther: 'HomeOther',
    login: 'Login',
    launch: 'Launch',
    mechaBattle: 'MechaBattle',
    rtsGame: 'RTSGame',
    rtsGame3D: 'RTSGame3D',
    sphere: 'NewSphereScene',
    eniSphere: 'EniConquererSphere',
    cq25Sphere: 'CQ25Sphere',
    transition: 'TransitionScene',
    cq25Transition: 'CQ25Transition',
    visitTransition: 'VisitTransition',
  },
  /**
   * NWorldMapCoreBiz.NWorldMapType 成员名（数值运行时向枚举对象取，不写死——数字随版本漂移，
   * 且 setter 会把 world 折算成 world_withBoder/world_NTerrain* 等地形变体）
   */
  mapTypes: {
    world: 'world',
    kvk: 'kvk',
    cab: 'cab',
    c4: 'c4',
    kvkS2: 'kvk_s2',
    worldBorder: 'world_withBoder',
    newCab: 'new_cab',
    master: 'master',
    pab: 'pab',
    cnc: 'cnc',
    cncHigh: 'cnc_high',
    adpWar: 'adp_war',
    cnc25: 'cnc_25',
    cncHigh25: 'cnc_high_25',
    worldNTerrain: 'world_NTerrain',
    worldNTerrainBorder: 'world_NTerrain_border',
  },
  /** NWorldMapCoreBiz.WatchingBattleType 成员名（观战/秘境态，mapType 被它强制折算） */
  watchingTypes: {
    none: 'NONE',
    tm: 'TM_WATCHING',
    master: 'MASTER_WATCHING',
    pab: 'PAB',
    cnc: 'CNC',
    adpwar: 'ADPWAR',
  },
  /** GameDefine.ServerState 成员名（跨战区天梯赛的阶段位，非场景：捐献/准备/战斗/领奖） */
  serverStates: {
    normal: 'Normal',
    donate: 'Donate',
    ready: 'Ready',
    fight: 'Fight',
    reward: 'Reward',
    matching: 'Matching',
  },
  /**
   * 语义面板名 → UIDataInfo 注册表成员名（运行时符号，面板随版本漂移时单点维护）。
   * pabFeedPopup 实证 UIDataInfoOther：`new UIDataInfoClass("PabPetFeedEventPopup", UIType.TYPE_POP, "__subpack/Pab/WorldUI", …)`，
   *   由 PabPetCaptureNodeNew.pabPetCaptureEvent 在 push 21527 type=5 时 OpenUI。
   */
  uiPanels: { bag: 'BagPanel', pabFeedPopup: 'PabPetFeedEventPopup' },
  /**
   * 世界态可订阅事件名（值就是 EventId 常量值本身，实证 extracted EventId.js：
   * e.CHANGE_SCENE="CHANGE_SCENE"、e.MapTypeChange="MapTypeChange"、
   * e.CrossServerStateUpdate="CrossServerStateUpdate"，pocketcc.event.on 直接拿值订阅）
   */
  events: {
    changeScene: 'CHANGE_SCENE',
    mapTypeChange: 'MapTypeChange',
    crossServerStateUpdate: 'CrossServerStateUpdate',
  },
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
  try {
    v = resolve() || null;
  } catch (e) {}
  if (v) {
    probes.set(key, v);
    return v;
  }
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
  dataCenter: () => {
    var m = game.get(SYM.modules.dataCenter);
    return !!(m && m.DATA);
  },
  localManager: () => {
    var m = game.get(SYM.modules.localManager);
    return !!(m && m.LOCAL);
  },
  tableManager: () => {
    var m = game.get(SYM.modules.tableManager);
    return !!(m && m.TABLE);
  },
  tableName: () => {
    var m = game.get(SYM.modules.tableName);
    return !!(m && (m.TableName || (m.default && m.default.TableName)));
  },
  tableUtils: () => {
    var m = game.get(SYM.modules.tableUtils);
    return !!(
      m &&
      (typeof m.getDataConfigData === 'function' ||
        (m.default && typeof m.default.getDataConfigData === 'function'))
    );
  },
  gameDefine: () => {
    var m = game.get(SYM.modules.gameDefine);
    return !!(m && (m.FunctionKey || (m.default && m.default.FunctionKey)));
  },
  long64Bit: () => {
    var m = game.get(SYM.modules.long64Bit);
    return !!(m && m.Int64);
  },
  chatCommon: () => !!game.get(SYM.modules.chatCommon),
  platformCore: () => !!game.get(SYM.modules.platformCore),
  eventIds: () => {
    var m = game.get('EventId');
    return !!(m && m.EventId);
  },
  gameTools: () => {
    var m = game.get('GameTools');
    return !!(m && (m.default || m));
  },
  activityController: () => {
    var m = game.get('ActivityController');
    return !!(m && m.ActivityController && m.ActivityController.Instance);
  },
  marchType: () => {
    var m = game.get(SYM.modules.mapOldCommon);
    return !!(m && m[SYM.marchEnum.obj]);
  },
  worldUtils: () => {
    var W = ns(game.get(SYM.modules.worldUtils));
    return !!(W && typeof W.dealMarchTypeWithSpecialMarch === 'function');
  },
  presetMarch: () => {
    var m = game.get('PresetMarchController');
    return !!(m && m.default && m.default.instance);
  },
  heroController: () => !!game.get('HeroController'),
  mechaController: () => !!game.get('MechaController'),
  // 一键领取（TaskRelax）重装母舰子玩法闸依赖；软依赖（'?'）——subpack2 未接管时 isOpenFunc 不可用，该子玩法按未开降级
  mechaTower: () => {
    var m = game.get(SYM.modules.mechaTowerCtrl);
    return !!(m && (m.MechaTowerController || (m.default && m.default.MechaTowerController)));
  },
  formationAdv: () => !!game.get('FightFormationAdvController'),
  marchStorage: () => {
    var m = game.get(SYM.modules.marchStorage);
    return !!(m && (m.MarchStorageController || (m.default && m.default.MarchStorageController)));
  },
  buff: () => {
    var u = userData();
    var B = u && u[SYM.dataProps.buffPool];
    return !!(B && typeof B.getStateDataById === 'function');
  },
  // 机械大师「职业等级 buff」读数依赖：建塔面板 NWorldResourcePopup 用 Buff.getBuffDataById(resBuffId).Value
  //   拿到本人可建的完整 buildId(bid)，与上面的 getStateDataById（战争状态）不同方法，故单列能力键。
  buffValue: () => {
    var u = userData();
    var B = u && u[SYM.dataProps.buffPool];
    return !!(B && typeof B.getBuffDataById === 'function');
  },
  commonTools: () => !!game.get(SYM.modules.commonTools),
  homeMapUtils: () => !!game.get(SYM.modules.homeMapUtils),
  homeMapCommon: () => !!game.get(SYM.modules.homeMapCommon),
  worldSite: () => {
    var m = game.get(SYM.modules.worldSiteCtrl);
    return !!(
      m &&
      (m.AllianceWorldSiteController || (m.default && m.default.AllianceWorldSiteController))
    );
  },
  rewardCtrl: () => {
    var m = game.get(SYM.modules.rewardCtrl);
    return !!(m && (m.RewardController || (m.default && m.default.RewardController)));
  },
  enigmaBeast: () => !!game.get('EnigmaBeastController'),
  // 培育开启闸的结构依赖：Real 接管后的控制器实例带 isOpenFunc 才算在场（只验符号在场，不代表玩法已开；
  //   玩法开合真相运行时读 gameData.beastBreedOpen()）
  beastBreedGate: () => {
    var m = game.get(SYM.modules.enigmaBeastCtrl);
    var cls = m && (m.default || m);
    var inst = cls && typeof cls.getInstance === 'function' ? cls.getInstance() : null;
    return !!(inst && typeof inst.isOpenFunc === 'function');
  },
  marchTools: () => !!game.get('MarchTools'),
  terrainModel: () => !!game.get(SYM.modules.terrainModel),
  navFly: () => !!mapTodo(),
  // 异能秘境（Pab）三依赖：控制器类在场（实例由 subpack2 接管后才可取，故只校验类/静态方法）；观战通道单例 sendPBV2 在场；秘境地图门控 getter 在场
  pabController: () => {
    var C = ns(game.get(SYM.modules.pabController));
    return !!(C && typeof C.getInstance === 'function');
  },
  watchNet: () => {
    var C = ns(game.get(SYM.modules.watchNet));
    var inst = C && C.Instance; // 静态 getter 懒建单例（与游戏自身同路径）
    return !!(inst && typeof inst.sendPBV2 === 'function');
  },
  mapNewBiz: () => {
    var b = ns(game.get(SYM.modules.mapNewBiz)); // NWorldMapCoreBiz.default = 业务单例（isPabBattleMap 为其 getter）
    return !!(b && 'isPabBattleMap' in b);
  },
  // 夺宝奇兵：控制器类在场（实例由 subpack2 RealCSHuntController 接管后才可取，故只校验类/静态方法）
  csHuntController: () => {
    var m = game.get(SYM.modules.csHuntCtrl);
    var C = m && (m.CSHuntController || ns(m));
    return !!(C && typeof C.getInstance === 'function');
  },
  // 邮件只读缓存：MailData 模块在场即可（mailManager 实例由 subpack 载入时挂上，安装期未必就绪，
  //   故 feat 侧应声明为软依赖 'mailData?'，运行期再由 mail.* 内部 probe 自愈重探）
  mailData: () => !!game.get(SYM.modules.mailData),
};

/**
 * 校验一个能力键在场（未知键返回 false —— 声明笔误在开发期 F5 即暴露）。
 * @param {string} key 能力语义名（CAPS 键，可带 '?' 后缀表软依赖）
 * @returns {boolean}
 */
export function checkCap(key) {
  var k = String(key || '').replace(/\?$/, '');
  var f = CAPS[k];
  if (!f) {
    log.warn('checkCap: 未登记的能力键 "%s"', key);
    return false;
  }
  try {
    return !!f();
  } catch (e) {
    return false;
  }
}

/** LOCAL 翻译单例（LocalManager 导出 .LOCAL） */
function LOCAL() {
  return probe('LocalManager.LOCAL', () => {
    var m = game.get(SYM.modules.localManager);
    return (m && m.LOCAL) || null;
  });
}

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
function ns(m) {
  return m && m.__esModule && m.default != null ? m.default : m;
}

/** TABLE 配置表单例（TableManager 导出 .TABLE） */
function TABLE() {
  return probe('TableManager.TABLE', () => {
    var m = game.get(SYM.modules.tableManager);
    return (m && m.TABLE) || null;
  });
}

/** 配置表名枚举对象（TableName 模块导出 .TableName，成员名 → 游戏表名字符串；符号缺失返回 null） */
function tableNameEnum() {
  return probe(SYM.modules.tableName + '.TableName', () => {
    var m = game.get(SYM.modules.tableName);
    return (m && (m.TableName || (m.default && m.default.TableName))) || null;
  });
}

/**
 * UserData 实时读取：只缓存 DataCenter 模块（__require 的模块缓存，跨图稳定），`.DATA.UserData` 每次现读。
 * Friends/Alliance/StrUid 等仍从当次现读的 UserData 上取属性，口径不变。
 * ⚠ 别把 UserData 对象本身交给 probe 缓存：进入跨服/跨区战场图（如天梯/夺宝奇兵把城迁到别的区）时，
 *   游戏会整体替换 `.DATA.UserData`，probe 的页面级缓存会把登录/老家态的旧对象钉死整场页面生命周期，
 *   导致 serverId()/myWorldPos() 等读到老家 (346,488)@4336 而实时已是 (729,857)@4337（真机实证）。
 *   口径对齐 serverTime()（同为 game.get('DataCenter').DATA.<field> 实时读）。
 */
function userData() {
  var m = probe('DataCenter', () => game.get(SYM.modules.dataCenter) || null);
  return (m && m.DATA && m.DATA.UserData) || null;
}

/** 场景程序管理器单例（ProcedureManager.PROCE）；PROCE.Home/NewWorld 由 ProcedureManagerInit 惰性挂上，成员每次实时读 */
function proce() {
  return probe('ProcedureManager.PROCE', () => {
    var m = game.get(SYM.modules.procedureManager);
    return (m && m.PROCE) || null;
  });
}

/** UI 管理器门面类（UIManager.default，其静态 Instance() 返回真实接管单例或未接管兜底桩；此处只缓存类、实例每次实时取，避免缓存到兜底桩） */
function uiMgrClass() {
  return probe(SYM.modules.uiManager + '.default', () => {
    var m = game.get(SYM.modules.uiManager);
    return (m && m.default) || null;
  });
}

/** UIDataInfo 面板描述符注册表对象（成员名→UIDataInfoClass 实例；对象引用稳定，面板由各模块惰性追加，读成员实时） */
function uiRegistry() {
  return probe(SYM.modules.uiDataInfo + '.UIDataInfo', () => {
    var m = game.get(SYM.modules.uiDataInfo);
    return (m && m.UIDataInfo) || null;
  });
}

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
    try {
      return String(L.getText.apply(L, [String(key)].concat(args)) || '') || String(key);
    } catch (e) {
      return String(key);
    }
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
    try {
      return String(L.getNetMsgText(s) || '') || s;
    } catch (e) {
      return s;
    }
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
    if (!tn) {
      var E = tableNameEnum();
      tn = (E && E[semantic]) || semantic;
    }
    try {
      return T.getTableDataById(tn, String(id)) || null;
    } catch (e) {
      return null;
    }
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
    if (!tn) {
      var E = tableNameEnum();
      tn = (E && E[semantic]) || semantic;
    }
    try {
      return T.getTableGroupArray(tn) || [];
    } catch (e) {
      return [];
    }
  },
  /**
   * 按**任意列**取配置表首行（只读，getTableByKeyFromBuffer）。
   * 与 tableRow 的区别不是便利而是正确性：tableRow 走 getTableDataById，只认表的**主键**；
   * 而游戏侧对若干活动表是按业务列查的（实证：mask_mystery_party 全程按 `item_id` 查，
   * UserItemCityRewardBtn/Panel、ItemData.GetDes 三处一致），主键另有其列时 tableRow 恒返回 null。
   * 表未就绪/无匹配行返回 null。游戏侧比较是宽松 `!=`（数字/字符串同值即中），此处同构；
   * 内部 getTableGroup(表名) 不带精简标志时会顺手把仍是串的原始行 parseRow 完，所以「表已加载但行未解析」
   * 的首查也能拿到对象（而 getTableDataById 只解析它命中的那一行）。
   * @param {string} semantic 语义表名（同 tableRow 的名字解析优先级）
   * @param {string} field 列名（如 'item_id'）
   * @param {*} value 列值（数字或数字串）
   * @returns {object|null}
   */
  tableRowByKey(semantic, field, value) {
    var T = TABLE();
    if (!T || typeof T.getTableByKeyFromBuffer !== 'function') return null;
    var tn = SYM.tables[semantic];
    if (!tn) {
      var E = tableNameEnum();
      tn = (E && E[semantic]) || semantic;
    }
    if (value == null || value === '') return null;
    try {
      var rows = T.getTableByKeyFromBuffer(tn, field, value);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (e) {
      return null;
    }
  },
  /**
   * 频道号 → 游戏频道显示名（chatCommon.getChatToggleConfig 文案键 + 翻译，与游戏侧栏同源）。
   * @param {number} c 频道号
   * @returns {string|null} 取不到返回 null（调用方自定衍名兜底）
   */
  channelName(c) {
    var cm = probe(SYM.modules.chatCommon + '.getChatToggleConfig', () => {
      var m = game.get(SYM.modules.chatCommon);
      return m && typeof m.getChatToggleConfig === 'function' ? m : null;
    });
    if (!cm) return null;
    try {
      return l10n.net(cm.getChatToggleConfig(+c)) || null;
    } catch (e) {
      return null;
    }
  },
};

// ─────────────────────── 世界地图导航 ───────────────────────

/** 跳转协调器（新旧地图双通道，首次探测后缓存句柄） */
function mapTodo() {
  return probe('mapTodo', () => {
    try {
      // 新图：NWorldMapCoreBiz.NWorldMapGoType + NWorldMapTodoController.instance
      var biz = game.get(SYM.modules.mapNewBiz);
      var G = biz && biz[SYM.newMap.goType];
      var cls = game.get(SYM.modules.mapNewCtrl);
      var C = cls && cls[SYM.newMap.cls];
      var inst = C && C[SYM.newMap.inst];
      if (G && inst && typeof inst.gotoWorldAndDo === 'function') return { inst: inst, G: G };
    } catch (e) {}
    try {
      // 旧图：WorldMapCommon.WorldMapToDoType + WorldMapTodoController.getInstance()
      var common = game.get(SYM.modules.mapOldCommon);
      var G2 = common && common[SYM.oldMap.todoType];
      var m2 = game.get(SYM.modules.mapOldCtrl);
      var i2 =
        m2 &&
        (typeof m2.getInstance === 'function'
          ? m2.getInstance()
          : m2.default && typeof m2.default.getInstance === 'function'
            ? m2.default.getInstance()
            : null);
      if (G2 && i2 && typeof i2.gotoWorldAndDo === 'function') return { inst: i2, G: G2 };
    } catch (e) {}
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
    if (action.z != null) {
      opts.s = action.z;
      opts.k = action.z;
      opts.z = action.z;
    }
    if (action.subMap != null && action.subMap > 0) opts.subMap = action.subMap;
    try {
      t.inst.gotoWorldAndDo(type, opts);
      return { ok: true };
    } catch (e) {
      log.warn('flyTo(%s,%s) failed: %s', action.x, action.y, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
  /**
   * 行军/集结飞行：JUMP_TO_MARCH_CLICK {marchId,marchType}（游戏默认分支走通用协议 GET_MARCH_INFO_FOR_JUMP）。
   * @param {{marchId:*, marchType:*}} action
   * @returns {{ok:boolean, err?:string}}
   */
  flyMarch(action) {
    var t = mapTodo();
    if (!t) return { ok: false, err: 'unavailable' };
    if (!t.G[SYM.mapActions.marchClick] || action.marchId == null)
      return { ok: false, err: 'nomarch' };
    try {
      t.inst.gotoWorldAndDo(t.G[SYM.mapActions.marchClick], {
        marchId: action.marchId,
        marchType: action.marchType,
      });
      return { ok: true };
    } catch (e) {
      log.warn('flyMarch(%s) failed: %s', action.marchId, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
};

// ─────────────────── 难民营自动开营「镜头乱飞」抑制 ───────────────────

/**
 * 坐标命中式镜头抑制器（无时间窗口、不改写游戏数据，仅拦一处游戏 UI 相机副作用）。
 * 背景：游戏客户端在收到 10802「找到营地」推送的同步处理里，会自行把镜头 pan 到新营地
 *   （手动用求救信亦然）。auto-hunt 全程不含相机调用，连开多营时镜头反复甩动。
 * 原理：难民营玩法运行期间，把游戏两条已知「地图跳转」入口各包一层——跳转协调器
 *   gotoWorldAndDo(type,opts{x,y}) 与消息总线 WorldMapMsgs.send(Names.WorldMapJumpToTile,{x,y})；
 *   仅当一次跳转的目标坐标命中「本轮由我方自动开营刚拿到的落点」时才吞掉那一次。落点坐标
 *   由 net 的「抢在原生处理器之前」观察点（见 core/net.js onPreInbound）在 orig 前登记，确保赶在
 *   游戏发起镜头跳转之前入表——故判定与时刻无关、无竞态；玩家手动点营地/聊天坐标跳转不在表内、照常飞。
 * @type {object}
 */
const camGuard = {
  /** @type {boolean} 是否已成功装载（幂等标志） */
  installed: false,
  /** @type {Array<string>} 待吞跳转坐标键 'x,y'（自动开营落点，FIFO 有界，命中即删） */
  pending: [],
  /** @type {Array<{obj:object, key:string, orig:Function}>} 已包装入口的还原信息 */
  hooks: [],
};
/** @type {number} pending 容量上限：防某营地跳转始终未发生时无界增长（超出丢最旧） */
const CAM_GUARD_PENDING_MAX = 32;

/** 包一个对象方法：命中 pending 坐标即吞掉该次调用（返回 undefined）；已包过则跳过。 */
function camGuardWrap(obj, key, readXY) {
  if (!obj || typeof obj[key] !== 'function' || obj[key].__pcCamGuard) return false;
  var orig = obj[key];
  var wrapped = function () {
    var xy = readXY(arguments);
    if (xy) {
      var k = (xy.x | 0) + ',' + (xy.y | 0);
      var i = camGuard.pending.indexOf(k);
      if (i >= 0) {
        camGuard.pending.splice(i, 1);
        return undefined; // 命中本轮自动开营落点：静默吞掉这一次镜头跳转
      }
    }
    return orig.apply(this, arguments);
  };
  wrapped.__pcCamGuard = true;
  obj[key] = wrapped;
  camGuard.hooks.push({ obj: obj, key: key, orig: orig });
  return true;
}

/**
 * 装载抑制器（幂等）：包住两条跳转入口。控制器实例尚未就绪（不在世界图）时不置 installed，下次可重试。
 * @returns {boolean} 是否已就绪
 */
function camGuardInstall() {
  if (camGuard.installed) return true;
  var mounted = 0;
  var t = mapTodo();
  if (t && t.inst) {
    if (
      camGuardWrap(t.inst, 'gotoWorldAndDo', function (args) {
        var o = args[1];
        return o && o.x != null && o.y != null ? { x: o.x, y: o.y } : null;
      })
    )
      mounted++;
  }
  try {
    var WMM = ns(game.get(SYM.modules.worldMapMsgs));
    var jumpVal = WMM && WMM.Names && WMM.Names[SYM.mapMsgs.jumpToTile];
    if (WMM && typeof WMM.send === 'function' && jumpVal != null) {
      if (
        camGuardWrap(WMM, 'send', function (args) {
          if (args[0] !== jumpVal) return null; // 只拦「镜头跳到地块」，别的消息一律放行
          var p = args[1];
          return p && p.x != null && p.y != null ? { x: p.x | 0, y: p.y | 0 } : null;
        })
      )
        mounted++;
    }
  } catch (e) {}
  if (mounted > 0) camGuard.installed = true;
  return camGuard.installed;
}

/** 卸载抑制器：还原所有被包方法并清空待吞坐标。 */
function camGuardUninstall() {
  for (var i = 0; i < camGuard.hooks.length; i++) {
    var h = camGuard.hooks[i];
    try {
      h.obj[h.key] = h.orig;
    } catch (e) {}
  }
  camGuard.hooks = [];
  camGuard.pending = [];
  camGuard.installed = false;
}

/** 登记一个「本轮自动开营落点」坐标，令下一次飞向它的镜头跳转被吞掉。 */
function camGuardArm(x, y) {
  if (x == null || y == null) return;
  var k = (x | 0) + ',' + (y | 0);
  var i = camGuard.pending.indexOf(k);
  if (i >= 0) camGuard.pending.splice(i, 1);
  camGuard.pending.push(k);
  if (camGuard.pending.length > CAM_GUARD_PENDING_MAX) camGuard.pending.shift();
}

/**
 * 难民营镜头抑制对外能力（挂在 nav 上，供 auto-hunt 随玩法开关装/摘）。
 * @type {object}
 */
nav.camGuard = {
  /** 装载抑制器（幂等）。@returns {boolean} 是否已就绪 */
  install: camGuardInstall,
  /** 卸载抑制器，还原游戏方法。 */
  uninstall: camGuardUninstall,
  /** 登记一个待吞的自动开营落点坐标。@param {number} x @param {number} y */
  arm: camGuardArm,
};

// ─────────────────────── 行军类型（跨服漂移） ───────────────────────

/** 游戏 MarchType 枚举对象（WorldMapCommon 为裸 CommonJS 导出，枚举在顶层，无 .default） */
function marchEnum() {
  return probe(SYM.modules.mapOldCommon + '.' + SYM.marchEnum.obj, () => {
    var m = game.get(SYM.modules.mapOldCommon);
    return (m && m[SYM.marchEnum.obj]) || null;
  });
}

/** 游戏 WorldMapEntityType 枚举对象（地块实体类型，同上在裸导出顶层） */
function entityEnum() {
  return probe(SYM.modules.mapOldCommon + '.' + SYM.entityEnum.obj, () => {
    var m = game.get(SYM.modules.mapOldCommon);
    return (m && m[SYM.entityEnum.obj]) || null;
  });
}

/** 跨服判定器（CrossUtils 静态方法，ES 包装下取 .default；随 tmServerType 变化，每次实时调用，不缓存结果） */
function crossUtils() {
  return probe(SYM.modules.crossUtils, () => {
    var C = ns(game.get(SYM.modules.crossUtils));
    return C && typeof C.isTMServer === 'function' ? C : null;
  });
}

/** 新跨服战场（AVA）判定：NewCABController.default.Instance.isNewCABServer() */
function isNewCabServer() {
  try {
    var K = ns(game.get(SYM.modules.newCabCtrl));
    var I = K && (K.Instance || K.instance);
    return !!(I && typeof I.isNewCABServer === 'function' && I.isNewCABServer());
  } catch (e) {
    return false;
  }
}

/** 游戏原生换算器 WorldUtils.dealMarchTypeWithSpecialMarch（漂移表唯一真相源，在则优先用；ES 包装下取 .default） */
function worldMarchUtils() {
  return probe(SYM.modules.worldUtils + '.dealMarchTypeWithSpecialMarch', () => {
    var W = ns(game.get(SYM.modules.worldUtils));
    return W && typeof W.dealMarchTypeWithSpecialMarch === 'function' ? W : null;
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
    return typeof v === 'number' && v > 0 ? v : fallback | 0;
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
      try {
        // 游戏原生优先：服务器契约由游戏自己维护，改版自动跟随
        var v = W.dealMarchTypeWithSpecialMarch(base, {});
        if (v) return v | 0;
      } catch (e) {}
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
      try {
        o.tm = !!C.isTMServer();
        o.master = !!C.isMasterMatch();
        o.teamLegend = !!C.isTeamLegendServer();
      } catch (e) {}
    }
    o.ava = isNewCabServer();
    return o;
  },
};

// ─────────────────────── 玩家/游戏数据（只读） ───────────────────────

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
  var now = gameData.serverTime();
  if (!(now > 0)) return empty;
  var lvRow = l10n.tableRow('PLAYER_LEVEL', gameData.level());
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
      if (
        !HU ||
        typeof HU.getMapPosList !== 'function' ||
        typeof HU.checkHomeBoxLegal !== 'function' ||
        typeof HU.getMapPosByPosId !== 'function' ||
        typeof HU.getPosIdByMapPos !== 'function'
      ) {
        log.debug(
          'homeAirDropSpot: HomeMapUtils 符号缺失（getMapPosList/checkHomeBoxLegal/…）→ 无法定位落点',
        );
        return null;
      }
      var GD = game.get(SYM.modules.gameDefine);
      var BI_BUILD = GD && GD.BaseItemType && GD.BaseItemType.Building; // 必为真值：传错 checkHomeBoxLegal 会跳过地形判定
      if (BI_BUILD == null) {
        log.debug('homeAirDropSpot: GameDefine.BaseItemType.Building 缺失 → 无法定位落点');
        return null;
      }
      var air = l10n.tableRow('building', buildingId);
      var airW = air && air.width > 0 ? air.width | 0 : 3;
      var airH = air && air.height > 0 ? air.height | 0 : 3;
      var HCM = ns(game.get(SYM.modules.homeMapCommon));
      var WC = (HCM && HCM.WidthCount) || 84,
        HC = (HCM && HCM.HeightCount) || 104;
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
          for (var j = 0; j < cells.length; j++) {
            if (cells[j] !== -1) occ[cells[j]] = 1;
          }
        }
      }
      // 由主城网格中心向外（切比雪夫环）扫第一个「地形合法 + 空投 footprint 全空」的锚点；限环数待在核心已解锁区，宁可本轮不发也不赌外围
      var cx = WC >> 1,
        cy = HC >> 1,
        R = Math.min(WC, HC) >> 1;
      for (var r = 0; r <= R; r++) {
        for (var dx = -r; dx <= r; dx++) {
          for (var dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // 只走本环边框，避免重扫内圈
            var x = cx + dx,
              y = cy + dy;
            if (x < 0 || y < 0 || x >= WC || y >= HC) continue;
            var pid = HU.getPosIdByMapPos(x, y);
            if (occ[pid]) continue; // 快速淘汰：锚点格已被占
            if (!HU.checkHomeBoxLegal(x, y, airW, airH, BI_BUILD, buildingId, -1)) continue; // 地形/可投放合法性
            var ac = HU.getMapPosList(x, y, airW, airH),
              free = true;
            for (var q = 0; q < ac.length; q++) {
              if (ac[q] === -1 || occ[ac[q]]) {
                free = false;
                break;
              }
            }
            if (free) return { x: x, y: y, posId: pid };
          }
        }
      }
      log.debug(
        'homeAirDropSpot: 核心区半径 %d 环内无合法空位（BUILDING 表 %s→ footprint=%dx%d, 网格=%dx%d, 占用格数=%d）',
        R,
        air ? 'OK' : 'MISSING',
        airW,
        airH,
        WC,
        HC,
        Object.keys(occ).length,
      );
      return null; // 核心区内无合法空位（空地不足）
    } catch (e) {
      log.debug(
        'homeAirDropSpot threw: %s —— 落点计算中途抛错被吞，本轮不发',
        e && (e.stack || e.message),
      );
      return null;
    }
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
          var lo = raw._low != null ? raw._low : raw.low,
            hi = raw._high != null ? raw._high : raw.high;
          if (lo != null && hi != null && typeof BigInt !== 'undefined') {
            lo = Number(lo);
            hi = Number(hi);
            if (lo < 0) lo += 4294967296;
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
    } catch (e) {
      log.debug('airDropInstances threw: %s', e && (e.message || e));
      return [];
    }
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
      var cd = Number(cfg.cd) || 0; // 每枚次数恢复间隔（分钟）
      var max = Number(cfg.max) || 0; // 次数上限
      var serverSec = gameData.serverTime() | 0;
      var msOf = function (v) {
        // protobuf Long / {_low,_high} / number → 毫秒
        if (!v) return 0;
        if (typeof v === 'number') return v;
        if (typeof v.toNumber === 'function') {
          try {
            return v.toNumber();
          } catch (e) {
            return 0;
          }
        }
        var lo = v._low != null ? v._low : v.low,
          hi = v._high != null ? v._high : v.high;
        if (lo == null || hi == null) return 0;
        lo = Number(lo);
        hi = Number(hi);
        if (lo < 0) lo += 4294967296;
        return hi * 4294967296 + lo;
      };
      if (type === 2) {
        // 次数型（空投支援）：可用 = min(cnt + 自 start 起已恢复的整数枚, max)
        if (!skill) return { type: type, available: max, nextMs: 0, max: max, cd: cd, cnt: null }; // 从未用过 = 满次数
        var cnt = Number(skill.cnt) || 0;
        var startSec = Math.floor(msOf(skill.start) / 1000);
        var accr = cd > 0 ? Math.floor((serverSec - startSec) / (60 * cd)) : 0;
        if (accr < 0) accr = 0;
        var avail = Math.min(cnt + accr, max);
        var nextMs = avail >= max ? 0 : (startSec + (accr + 1) * 60 * cd) * 1000; // 下一枚恢复的绝对毫秒
        return { type: type, available: avail, nextMs: nextMs, max: max, cd: cd, cnt: cnt };
      }
      // type1/type3：单次冷却型，end（绝对毫秒）过了即可用一次
      if (!skill) return { type: type, available: 1, nextMs: 0, max: 1, cd: cd, cnt: null };
      var endMs = msOf(skill.end);
      return {
        type: type,
        available: Math.floor(endMs / 1000) < serverSec ? 1 : 0,
        nextMs: endMs,
        max: 1,
        cd: cd,
        cnt: null,
      };
    } catch (e) {
      return null;
    }
  },
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
  /**
   * 主城金币产出态快照（金矿场/民居到点产出 + 金币收割机可收量），口径见文件内 coinState 注释。
   * 只读、无副作用；符号/数据缺失回 {available:false}，调用方本轮不发。
   * @returns {ReturnType<typeof coinState>}
   */
  coinState(opt) {
    try {
      return coinState(opt);
    } catch (e) {
      log.debug('coinState threw: %s', e && (e.message || e));
      return { available: false };
    }
  },
};

/** 资源路径换算器 PathUtils（ES 命名空间下取 .default 类；静态方法 GetIconURL） */
function pathUtils() {
  return probe(SYM.modules.pathUtils, () => {
    var P = ns(game.get(SYM.modules.pathUtils));
    return P && typeof P.GetIconURL === 'function' ? P : null;
  });
}

/** 出征档案重算器单例（MarchStorageController.getInstance()）；门面未接管或方法名漂移时返回 null */
function marchStorage() {
  return probe('MarchStorageController.instance', () => {
    var m = game.get(SYM.modules.marchStorage);
    var C = m && (m.MarchStorageController || (m.default && m.default.MarchStorageController));
    var inst = C && C.getInstance && C.getInstance();
    return inst && typeof inst.checkPreMarchExtraList === 'function' ? inst : null;
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
  ok() {
    return !!marchStorage();
  },
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
      log.warn(
        'battlePreset.recalc threw —— 出征档案重算器不可用（符号漂移？），调用方将走降级口径',
        e,
      );
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
    if (P) {
      try {
        var u = P.GetIconURL(v);
        return typeof u === 'string' && u ? u : '';
      } catch (e) {}
    }
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

export const bits = {
  /**
   * 数字串 → Long64Bit.Int64（fromString）；非数字串按 Number 走 fromNumber，模块不可用回纯数字兜底。
   * @param {string|number} v 数值或数字串（如私聊 roomId=对端 uid）
   * @returns {*|number}
   */
  int64(v) {
    v = String(v == null ? '0' : v);
    var L = probe(SYM.modules.long64Bit + '.Int64', () => {
      var m = game.get(SYM.modules.long64Bit);
      return (m && m.Int64) || null;
    });
    if (!L) return /^\d+$/.test(v) ? Number(v) || 0 : 0;
    // probe 的 resolve 已返回 m.Int64（Int64 类本体 r），类上直接挂 fromString/fromNumber 静态方法；
    // 曾经多写一层 L.Int64.fromString → TypeError → catch return 0，导致所有大 id（19 位兽 id）
    // 装箱失败、服务器回 enigma_beast018「找不到对应异能兽信息，已失效」。
    try {
      return /^\d+$/.test(v) ? L.fromString(v) : L.fromNumber(Number(v) || 0);
    } catch (e) {
      return 0;
    }
  },

  /**
   * Int64 读侧归一：协议层的 Long 对象（{_low,_high,_unsigned}）/数字/字符串 → 十进制字符串。
   * 铁律：64 位 id 一律按字符串读与比较，不走 Number（>2^53 精度丢失，实证 dashcam 20261016T19xxxx
   *   的 treasureId/teamId/member.uid 均为原生 Long 对象，与控制器侧 19 位字符串是两套口径）。
   * 永不抛异常：null/undefined 回空串，其余取 String(v)。
   * @param {*} v Long 实例 / 数字 / 数字串
   * @returns {string} 十进制字符串（无值为空串）
   */
  int64Str(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    try {
      // Long 实例自带 toString/toNumber（unsigned 下返回无符号十进制串）
      if (typeof v.toString === 'function' && typeof v.toNumber === 'function') return v.toString();
      if (typeof v.toString === 'function') return String(v.toString());
    } catch (e) {}
    return String(v);
  },
};

// ─────────────────────── 异能秘境（Pab）跨服通道与场景门控 ───────────────────────

/** @type {number} 未真正发出的伪码（与 net.CODE_NOT_SENT 同义；watch 通道无返回句柄，超时/异常均回此值） */
const SECRET_NOT_SENT = -1;
/**
 * @type {number} 秘境发包应答超时（毫秒）：与 net.js SEND_TIMEOUT_MS 同量纲，到点未 settle 即回 SECRET_NOT_SENT。
 * 取 4s 而不是旧 15s：实测次通道 RTT 44~52ms（dashcam 20261011T195811 里 8527/8538/8546 的应答全在此量级）；
 *   而 NetMgrSimple 的 MsgIdSettings.cdTime 频控命中时 `return !1`、**包根本不上线也不报错**，
 *   门面 TMWatchNetMgr.sendPBV2 又是把三元表达式当语句用、没有 return（verbatim）→ 我们拿不到那个 false，
 *   只能靠超时感知。15s 就把这种「一秒内注定知道结果」的包空等 15 秒（实测拖慢整个拾取批次 62s/点位）。
 *   调用方语义不变：超时仍回 SECRET_NOT_SENT（未发出），不拉黑、可重试。
 */
const SECRET_TIMEOUT_MS = 4000;
/**
 * 次通道未就绪是否已经告过警（首发 warn、后续降 debug，防拾取逐拍刷屏；任一发包成功即复位）。
 * @type {boolean}
 */
var socketNotReadyWarned = false;

/**
 * NWorldMapCoreBiz 业务单例（isPabBattleMap 为其 getter）；符号缺失返回 null。
 * 只缓存单例对象，isPabBattleMap 每次现读（watchingType 随进出秘境实时变化）。
 */
function pabBiz() {
  return probe(SYM.modules.mapNewBiz, () => {
    var b = ns(game.get(SYM.modules.mapNewBiz));
    return b && 'isPabBattleMap' in b ? b : null;
  });
}

/** TMWatchNetMgr 单例（秘境/跨服观战独立发送通道）；符号缺失返回 null */
function watchNetMgr() {
  return probe(SYM.modules.watchNet + '.Instance', () => {
    var C = ns(game.get(SYM.modules.watchNet));
    var inst = C && C.Instance; // 静态 getter 懒建单例（引用稳定，可缓存）
    return inst && typeof inst.sendPBV2 === 'function' ? inst : null;
  });
}

/**
 * 构造与 net.Ret 同形的结果对象（code/data/reason/ok）；window.pocketcc.net 未就绪时降级为等价的普通对象。
 * @param {number} code 状态码（0=成功；SECRET_NOT_SENT=未发出/超时）
 * @param {*} data 业务数据（pbAckV2.data）
 * @param {string|null} reason 拒绝多语言键（pbAckV2.header.d，仅 code≠0 时有意义）
 * @returns {object} Ret 形结果
 */
function secretRet(code, data, reason) {
  var Net = window.pocketcc && window.pocketcc.net;
  var r = Net && Net.Ret ? Net.Ret.from(code, data) : { code: code, data: data, reason: null };
  if (reason != null) r.reason = reason;
  return r;
}

/**
 * 异能秘境能力组（均只读/发包，不改写游戏数据）：
 *   - 秘境协议发送走 TMWatchNetMgr 独立通道（主 pocketcc.net 在 isPabBattleMap 下发不出去），此处 promise 化并归一 Ret；
 *   - isPabBattleMap 为「是否在秘境地图」唯一真相（场景名仍是 NWorldMap，不可靠），仅作场景门控用；
 *   - getPabController 回控制器实例供上层调游戏原生动作（petCaptureOperation 等），不代跑业务；
 *   - 另有 BOSS/治疗一族**只读快照**（getRoomBaseInfo/getBossBaseInfo/getBossGuardRewardInfo/getItemNumById/isTeamLeader/teamIsMooring）：
 *     这些态全由游戏的推送与应答 Handler 写入（21521/21535/21539/21525），本层只读不镜像，不代跑业务判定。
 */
export const secretRealm = {
  /**
   * 当前是否在异能秘境地图（NWorldMapCoreBiz.isPabBattleMap getter：watchingType===PAB）。
   * 符号缺失/未就绪返回 false（宁可不进 active 档也不误判场景）。
   * @returns {boolean}
   */
  isPabBattleMap() {
    var b = pabBiz();
    return !!(b && b.isPabBattleMap);
  },
  /**
   * 异能秘境控制器实例（PabController.getInstance()）；subpack2 未接管/符号缺失返回 null。
   * 实证 getInstance 内部 `realPabController?(...):null` → 拿到的是 RealPabController 实例，
   *   roomBaseInfo / capturingInfo / capturingPetPos / petCaptureOperation 均直接可达。
   * 上层据它读 capturingPetPos（**「正在拍哪只」的唯一真相**，push 21530 写）、roomBaseInfo.marchState（行军态）、
   *   capturingInfo（8546 应答 feedInfo，仅作料源）并调原生 petCaptureOperation/getItemNumById/checkItemNumMax。
   * @returns {object|null}
   */
  getPabController() {
    var C = probe(SYM.modules.pabController, () => {
      var c = ns(game.get(SYM.modules.pabController));
      return c && typeof c.getInstance === 'function' ? c : null;
    });
    if (!C) return null;
    try {
      return C.getInstance() || null; // 实例每次现取（接管前为 null）
    } catch (e) {
      return null;
    }
  },
  /**
   * NMarchState 枚举对象（运行时取成员值，不硬编码数值）；subpack2 未载/符号缺失返回 null。
   *   注：**PAB_FEED(21) 不能当「在拍」判据**——21521 BASE_INFO 下推很稀（实测 970s 会话 58 条），
   *   整个拍宠物过程里 marchState 只给 1(MARCHING)/2(ARRIVED)，在拍真相请用 capturingPetPos。
   * @returns {object|null} {MARCHING,ARRIVED,FIGHTING,PAB_FEED,…}
   */
  getNMarchState() {
    return probe(SYM.modules.marchCommon + '.NMarchState', () => {
      var m = game.get(SYM.modules.marchCommon);
      var E = m && (m.NMarchState || (m.default && m.default.NMarchState));
      return E && E.PAB_FEED != null ? E : null;
    });
  },
  /**
   * 房间现场态 roomBaseInfo（push 21521 BASE_INFO 由游戏 Handler 写入）的**只读引用**；不在秘境/未下发回 null。
   * 实证 24 键：teamId/leaderUid/marchState/startPoint/pointType/targetPoint/fightEndTime/buffMap…
   *   Int64 字段（fightEndTime/teamId/leaderUid 等）原样返回，由调用方按口径读（不在此转 Number，防 64 位精度陷阱）。
   * @returns {object|null}
   */
  getRoomBaseInfo() {
    var p = secretRealm.getPabController();
    return (p && p.roomBaseInfo) || null;
  },
  /**
   * 三个 BOSS 的状态机快照（游戏 Handler 收到 push 21535 后 verbatim `bossBaseInfo = a.stateInfo`）。
   * @returns {Array<{bossId:number,pos:{x:number,y:number},state:number,stateEndTime:*}>|null} 未下发回 null
   */
  getBossBaseInfo() {
    var p = secretRealm.getPabController();
    return (p && p.bossBaseInfo) || null;
  },
  /**
   * 小BOSS 石头点位账本快照（push 21539；**游戏侧字段名拼写就是 Gurard**，不做纠正以免与运行时符号漂移）。
   * @returns {Array<{bossId:number,rewardInfo:Array<{pos:{x:number,y:number},rewardNum:number,rewardMaxNum:number,isFight:number}>}>|null}
   */
  getBossGuardRewardInfo() {
    var p = secretRealm.getPabController();
    return (p && p.bossGurardRewardInfo) || null;
  },
  /**
   * 队伍是否停泊在位（游戏 verbatim `teamIsMooring`：`!roomBaseInfo || marchState ∈ {ARRIVED,FIGHTING,PAB_FEED}`）。
   * 注：**不在秘境（roomBaseInfo 缺失）时游戏侧回 true**，本层保留原语义；调用方要「确实在场」得自己配合
   *   getRoomBaseInfo() 非空一起判（realmActive 已是 feat 侧前置）。
   * @returns {boolean} 符号缺失回 false（闭开：不确认停泊就不发写请求）
   */
  teamIsMooring() {
    var p = secretRealm.getPabController();
    if (!p || typeof p.teamIsMooring !== 'function') return false;
    try {
      return !!p.teamIsMooring();
    } catch (e) {
      return false;
    }
  },
  /**
   * 该 cmd 是否有「已发出、未收到应答」的在途请求（走 watch 通道自带的 checkRequestIdNoRes，非主 NET）。
   * 符号缺失返回 false（不拦，宁可重发一次也不因探测不可用而永久闭开）。
   * @param {number} cmd 命令号
   * @returns {boolean}
   */
  isSecretSending(cmd) {
    var mgr = watchNetMgr();
    if (!mgr || typeof mgr.checkRequestIdNoRes !== 'function') return false;
    try {
      return !!mgr.checkRequestIdNoRes(cmd);
    } catch (e) {
      return false;
    }
  },
  /**
   * 秘境 promise 发包：包 TMWatchNetMgr.Instance.sendPBV2(cmd, data, target, cb)，cb 读 pbAckV2.header.s（0=成功）
   * 归一成 Ret{code,data,reason,ok}。与 net.sendPBV2 同形（NetMgrSimple 回调收到的是原始报文 e，形状与主 NET 一致）。
   * 永不 reject：未就绪/发送异常/超时无应答均回 Ret(code=SECRET_NOT_SENT)。
   * @param {number} cmd 命令号（秘境 85xx）
   * @param {object|null} data 载荷（逐键对齐录制/源码；Int64 按字符串透传）
   * @returns {Promise<object>} Ret 形结果
   */
  sendSecret(cmd, data) {
    var mgr = watchNetMgr();
    if (!mgr) return Promise.resolve(secretRet(SECRET_NOT_SENT, null, null));
    // 就绪预检：门面 verbatim 是 `isPabBattleMap ? (this._socket&&this._isConnect&&this._isLogin&&this._socket.sendPBV2(…)) : NET.sendPBV2(…)`。
    //   两点约束：① 预检必须和路由同判据——非秘境态这条包其实走**主通道**、本来发得出去，无条件要求次通道就绪
    //     就会把成功的包拒成未发出（预检引入过的回归，此处收口）；
    //   ② 秘境态下三个 && 任一为假即既不发包也不报错（静默短路），不预检就只能白等 15s 超时才回落哨兵。
    //   isConnectStatus 是门面自带的只读判据（verbatim：`return this._socket&&this._isConnect&&this._isLogin`）。
    if (
      secretRealm.isPabBattleMap() &&
      typeof mgr.isConnectStatus === 'function' &&
      !mgr.isConnectStatus()
    ) {
      if (socketNotReadyWarned)
        log.debug('secondary socket still not ready, skip secret cmd %d.', cmd);
      else {
        socketNotReadyWarned = true;
        log.warn('secondary socket not ready (connect/login), skip secret cmd %d.', cmd);
      }
      return Promise.resolve(secretRet(SECRET_NOT_SENT, null, null));
    }
    // 走到这里说明当前路由态已确认可发包（秘境=次通道就绪已验、非秘境=主通道不受该门禁约束），即复位告警闸门：
    //   不等应答 code——否则「断线→warn→恢复→一串超时/业务拒→再次断线」会把第二次真断线默默降级成 debug
    socketNotReadyWarned = false;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(secretRet(SECRET_NOT_SENT, null, null));
      }, SECRET_TIMEOUT_MS);
      var done = function (code, d, reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(secretRet(code, d, reason));
      };
      try {
        mgr.sendPBV2(cmd, data || null, null, function (resp) {
          try {
            var header = (resp && resp.pbAckV2 && resp.pbAckV2.header) || {};
            var s = header.s;
            var d = resp && resp.pbAckV2 && resp.pbAckV2.data;
            done(s == null ? SECRET_NOT_SENT : s, d, s !== 0 ? header.d : null);
          } catch (e) {
            done(SECRET_NOT_SENT, null, null);
          }
        });
      } catch (e) {
        done(SECRET_NOT_SENT, null, null);
      }
    });
  },
  /**
   * 秘境房间背包余量（游戏 verbatim getItemNumById：`roomBagInfo.bagInfo`（或 `bagShareInfo`）里按 itemId 求 itemCount）。
   * @param {number|string} itemId 道具 id
   * @param {boolean} [share=false] true=读共享背包
   * @returns {number} 余量（背包未初始化/未持有回 0）
   */
  getItemNumById(itemId, share) {
    var p = secretRealm.getPabController();
    if (!p || typeof p.getItemNumById !== 'function') return 0;
    try {
      return Number(p.getItemNumById(Number(itemId), !!share)) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 秘境次通道 **JSON 版**发包（`TMWatchNetMgr.Instance.send`）——与 sendSecret（PBV2）并列的第二条口子。
   *   为什么需要：`901 GET_WORLD_INFO` 在秘境图里走的是 JSON send（竞品B enigmaSecret.asend 同款），
   *   用 sendPBV2 发它拿不到 pointList。回调形如 `{s, d}`（d 是 JSON 字符串），s!==0 或超时回 null。
   * @param {number} cmd 命令号（秘境里用于 901 等 JSON 协议）
   * @param {object|null} data 载荷
   * @returns {Promise<object|null>} 解析后的应答体；未就绪/失败/超时一律 null（永不 reject）
   */
  sendSecretJson(cmd, data) {
    var mgr = watchNetMgr();
    if (!mgr || typeof mgr.send !== 'function') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, SECRET_TIMEOUT_MS);
      var done = function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      try {
        mgr.send(cmd, data || null, null, function (resp) {
          try {
            if (!resp || Number(resp.s) !== 0) return done(null);
            done(typeof resp.d === 'string' ? JSON.parse(resp.d) : resp.d || null);
          } catch (e) {
            done(null);
          }
        });
      } catch (e) {
        done(null);
      }
    });
  },
  /**
   * **主动拉视口**（竞品B `marchResource` 的核心数据源，我们 v2 最大的缺失）。
   *   以 (cx,cy) 为中心发 901，拿回 `pointList`（每个点带 x/y/pointType/m{iNum,state,teams,esrId,rTime}）
   *   与 `marchList`（在途行军）。这是「不再依赖 10018 push 积累」的关键：push 只在镜头扫过时来，
   *   主动查才能随时拿到候选池（v2 的 tiles.size 常年 2~3 就是没这一步）。
   *   参数取竞品同款：width 20 / height 30 / viewLevel 1 / marchInfo true（实测覆盖 x±58 · y±39）。
   * @param {number} cx 视口中心 x
   * @param {number} cy 视口中心 y
   * @param {{width?:number,height?:number,viewLevel?:number,k?:number}} [opt]
   * @returns {Promise<{points:Array,marches:Array}|null>} 归一后的点/行军列表；未就绪/失败回 null
   */
  queryWorldView(cx, cy, opt) {
    var o = opt || {};
    var x = Number(cx);
    var y = Number(cy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(null);
    var k = Number(o.k) || secretRealm.pabServerId() || 0;
    return secretRealm
      .sendSecretJson(901, {
        x: x,
        y: y,
        k: k,
        rid: 0,
        width: Number(o.width) || 20,
        height: Number(o.height) || 30,
        marchInfo: true,
        viewLevel: Number(o.viewLevel) || 0,
      })
      .then(function (r) {
        if (!r) return null;
        var pts = Array.isArray(r.pointList) ? r.pointList : [];
        var ms = Array.isArray(r.marchList) ? r.marchList : [];
        return {
          points: pts,
          marches: ms.map(function (m) {
            var bb = m.begin || {};
            var tt = m.target || {};
            var inf = m.info || {};
            return {
              bx: Number(bb.bx != null ? bb.bx : bb.tx) || 0,
              by: Number(bb.by != null ? bb.by : bb.ty) || 0,
              tx: Number(tt.tx != null ? tt.tx : m.target_tx) || 0,
              ty: Number(tt.ty != null ? tt.ty : m.target_ty) || 0,
              state: Number(m.state != null ? m.state : m.marchState) || 0,
              leaderUid: inf.leaderUid != null ? String(inf.leaderUid) : '',
            };
          }),
        };
      });
  },
  /**
   * 秘境图服号（901 请求体的 k）：`NWorldMapData.instance.serverData.currentServerId`，缺失回退 selfServerId。
   * @returns {number} 取不到回 0（调用方应放弃本次查询而不是拿错区发）
   */
  pabServerId() {
    var C = probe(SYM.modules.nWorldMapData + '.cls', function () {
      try {
        var m = game.get(SYM.modules.nWorldMapData);
        return (m && (m.NWorldMapData || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var W = C && (C.instance || C);
    var sd = W && W.serverData;
    return Number(sd && (sd.currentServerId || sd.selfServerId)) || 0;
  },
  /**
   * 秘境增益值（游戏 verbatim `PabController.getPabBuffValueByType(type)`）：
   *   竞品用它算背包容量（`dataConfig 3017 + PabExtraPackItemNum`）。
   * @param {number} type BuffType 枚举值
   * @returns {number} 取不到回 0
   */
  getPabBuffValueByType(type) {
    var p = secretRealm.getPabController();
    if (!p || typeof p.getPabBuffValueByType !== 'function') return 0;
    try {
      return Number(p.getPabBuffValueByType(Number(type))) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 房间背包快照 `roomBagInfo`（push 21525 写入）的**只读引用**：bagInfo 道具 / beastInfo 野兽 / protectBeasts。
   * 竞品用它算「百兽箱是否已满」「能捡几只兽」。Int64 字段原样返回，不在此做 Number 转换。
   * @returns {object|null}
   */
  getRoomBagInfo() {
    var p = secretRealm.getPabController();
    return (p && p.roomBagInfo) || null;
  },
  /**
   * 正在拍宠的坐标 `capturingPetPos`（push 21530 写入）；未在拍回 null（或 x/y 非正）。
   * 驾驶层用它做「拍宠中不挪点」闸（挪点会清捕获进度）。
   * @returns {{x:number,y:number}|null}
   */
  getCapturingPetPos() {
    var p = secretRealm.getPabController();
    var v = p && p.capturingPetPos;
    if (!v) return null;
    var x = Number(v.x);
    var y = Number(v.y);
    return x > 0 && y > 0 ? { x: x, y: y } : null;
  },
  /**
   * 现在能不能发 8521（游戏 verbatim `isCanMarch = !!roomBaseInfo && teamIsMooring()`）。
   * 驾驶层用它当统一可发闸，避免自己拼判据漏项。
   * @returns {boolean}
   */
  isCanMarch() {
    return !!secretRealm.getRoomBaseInfo() && secretRealm.teamIsMooring();
  },
  /**
   * 全图行军列表归一（`NWorldMapData.instance.marches`）：竞品用它在选点前剔掉「已有己方行军指向该点」的目标。
   * 两种源形态不同（本地扁平 `target_tx/marchState`、901 嵌套 `target.tx/state`），此处统一成 `{bx,by,tx,ty,state,leaderUid}`。
   * @returns {Array<{bx:number,by:number,tx:number,ty:number,state:number,leaderUid:string}>}
   */
  getMarchList() {
    var C = probe(SYM.modules.nWorldMapData + '.cls', function () {
      try {
        var m = game.get(SYM.modules.nWorldMapData);
        return (m && (m.NWorldMapData || m.default || m)) || null;
      } catch (e) {
        return null;
      }
    });
    var W = C && (C.instance || C);
    var bag = (W && W.marches) || null;
    var out = [];
    if (!bag || typeof bag !== 'object') return out;
    var keys = Object.keys(bag);
    for (var i = 0; i < keys.length; i++) {
      var m = bag[keys[i]];
      if (!m) continue;
      var bb = m.begin || {};
      var tt = m.target || {};
      var inf = m.info || {};
      out.push({
        bx: Number(bb.bx != null ? bb.bx : m.begin_bx) || 0,
        by: Number(bb.by != null ? bb.by : m.begin_by) || 0,
        tx: Number(tt.tx != null ? tt.tx : m.target_tx) || 0,
        ty: Number(tt.ty != null ? tt.ty : m.target_ty) || 0,
        state: Number(m.state != null ? m.state : m.marchState) || 0,
        leaderUid: inf.leaderUid != null ? String(inf.leaderUid) : '',
      });
    }
    return out;
  },
  /**
   * 已在保护中的宠物 id 列表（游戏 verbatim `getBagPetIsPretecting` 的数据源：`roomBagInfo.protectBeasts`）。
   * 符号知识收口在此：那个数组的元素是 **protobuf Int64**（游戏侧靠 `.equals(e)` 比对），
   *   而上层拿到的是池化对象、且红线要求 64 位 ID 不做 Number 转换 → 统一在此按 `toString()` 归成字符串集。
   * @returns {string[]} 保护中的宠物 id（背包未初始化/符号缺失回空数组，上层据此**不拦**）
   */
  getProtectingPetIds() {
    var p = secretRealm.getPabController();
    var arr = (p && p.roomBagInfo && p.roomBagInfo.protectBeasts) || null;
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null) continue;
      try {
        out.push(String(typeof v.toString === 'function' ? v.toString() : v));
      } catch (e) {
        /* 单个元素取不到就跳过，不能让整表读废 */
      }
    }
    return out;
  },
  /**
   * 本人是否队长（游戏 verbatim `isTeamLeader(uid=true 口径)`：`String(UserData.UID) === roomBaseInfo.leaderUid`）。
   * 两个玩法都拿它当闸：① 上临时停泊平台（176）——verbatim `NWorldPabBossPlanePopup.refreshUI` 里
   *   `marchBtn.active = isTeamLeader()`；② 攻打 BOSS（8521）——**UI 本身不查**（`NWorldPabBossPopup.refreshUI`
   *   覆盖了基类那句 `active = _isOpen && isTeamLeader() && !_haveSelfTeam`，`state===BOSS_FIGHTING` 直接置 active），
   *   但 8521 驱动的是**全队那一条**行军（roomBaseInfo 实证为队级快照：单一 startPoint/marchState + leaderUid），
   *   多人房各自发只会互抢方向盘，故主动收到队长（竞对脚本亦同款）。治疗不要求此闸。
   * @returns {boolean} roomBaseInfo 缺失/符号缺失回 false
   */
  isTeamLeader() {
    var p = secretRealm.getPabController();
    if (!p || typeof p.isTeamLeader !== 'function') return false;
    try {
      return !!p.isTeamLeader();
    } catch (e) {
      return false;
    }
  },
  /**
   * 秘境背包已捕获宠物清单（撤离带出/拿满判据的料源）的**只读副本**。
   * 数据源 verbatim（竞品B enigmaSecret.judgeLeave / exitStage）：`PabController.roomBagInfo.beastInfo`，条目取
   *   `cfgId`（enigma_beast 主键，查 quality 用）与 `id`（protobuf Int64，即 8581 BAG_GET_SET 的 `uuIds` 元素）。
   * ⚠ `beastInfo` 键**我方未实机确认存在**（模块分析报告记的 roomBagInfo 五键里没有它，竞品同游戏版本才用得到）→
   *   读不到（缺字段/非数组）回 null 而非空数组，让上层能区分「清单为空」与「键不存在」，绝不拿读不到当「拿满」误离场。
   * 只读：`id` 原样透传（不做 Number/字符串化，与 protectBeasts 同一 Int64 形态，直接回填 8581 uuIds）。
   * @returns {Array<{cfgId:number,id:*}>|null} 不在秘境/背包未初始化/键缺失回 null
   */
  getRoomBagPets() {
    var p = secretRealm.getPabController();
    var bag = p && p.roomBagInfo;
    var list = bag && bag.beastInfo;
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b) continue;
      out.push({ cfgId: Number(b.cfgId) || 0, id: b.id });
    }
    return out;
  },
  /**
   * 宠物携带背包**总容量** = 基础格数 dataConfig(3017) + 增益 `GameDefine.BuffType.PabExtraPackItemNum` 的扩容。
   * verbatim（竞品B exitStage/judgeLeave 同式，与我方 pickup.js 文件头记的领取选择器格子数 `3017+PabExtraPackItemNum` 吻合）：
   *   `Number(getDataConfigData(3017)) + pab.getPabBuffValueByType(GameDefine.BuffType.PabExtraPackItemNum)`。
   * 任一环取不到即** fail-safe 回 0**（调用方 leave.js 把 0 当「容量未知、不触发离场」，防把未坐实的阈值当成「拿满」误发整场退出）：
   *   3017 读不到/为 0、控制器无 getPabBuffValueByType、BuffType 枚举缺成员，都收 0。
   * @returns {number} 总容量（0 = 容量不可信，不触发离场）
   */
  petPackCapacity() {
    var base = Number(gameConf.dataConfig(3017)) || 0;
    if (!(base > 0)) return 0;
    var p = secretRealm.getPabController();
    if (!p || typeof p.getPabBuffValueByType !== 'function') return base;
    var GD = probe(SYM.modules.gameDefine + '.BuffType', () =>
      ns(game.get(SYM.modules.gameDefine)),
    );
    var BT = GD && (GD.BuffType || (GD.default && GD.default.BuffType));
    var extraType = BT && BT.PabExtraPackItemNum;
    if (extraType == null) return base; // 增益类型枚举取不到 → 只算基础格（少报扩容，判满偏保守）
    var extra = 0;
    try {
      extra = Number(p.getPabBuffValueByType(extraType)) || 0;
    } catch (e) {
      extra = 0;
    }
    return base + (extra > 0 ? extra : 0);
  },
  /**
   * 行军到某瓦片（秘境 8521 MARCH_MOVE，req `{x,y}`）——「上平台」与「攻打 BOSS」同一个入口。
   * 与游戏 verbatim `sendToBuildingMarch` 同口径：先查在途（`checkRequestIdNoRes`，游戏侧同一道闸）再发，
   *   故本方法**不直调游戏方法**（游戏侧那个方法除了这两个动作不写本地态，但我们走 ACL 统一通道以便超时与
   *   Ret 归一），零本地改写。注：游戏侧是 `||` 短路——在途时直接不发。
   * @param {number} x 目标瓦片横号
   * @param {number} y 目标瓦片纵号
   * @returns {Promise<object>|false} 在途被闸门拦下回 false（未发出）；否则回 sendSecret 的 Ret promise
   */
  sendMarch(x, y) {
    var nx = Number(x);
    var ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    if (secretRealm.isSecretSending(8521)) return false;
    return secretRealm.sendSecret(8521, { x: nx, y: ny });
  },
};

// ─────────────────────── 夺宝奇兵（CSHunt / CrossTreasure）只读快照 ───────────────────────

/** Int64 时间戳读侧归一为数字（epoch 毫秒 < 2^53，转 Number 安全）；Long 实例走 toNumber，其余回 Number */
function int64Num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  try {
    if (typeof v.toNumber === 'function') return v.toNumber() || 0;
  } catch (e) {}
  return Number(v) || 0;
}

/**
 * 夺宝奇兵控制器实例（CSHuntController.getInstance()）；subpack2 Real 未接管/符号缺失回 null。
 * 实证 getInstance 内部 `realCSHuntController ? (_instance || (_instance = realCSHuntController())) : null`，
 *   即玩法子包未加载时恒 null——调用方必须自己处理降级。
 * @returns {object|null}
 */
function csHuntCtrl() {
  var C = probe(SYM.modules.csHuntCtrl, () => {
    var m = game.get(SYM.modules.csHuntCtrl);
    var K = m && (m.CSHuntController || ns(m));
    return K && typeof K.getInstance === 'function' ? K : null;
  });
  if (!C) return null;
  try {
    return C.getInstance() || null; // 实例每次现取（接管前为 null）
  } catch (e) {
    return null;
  }
}

/**
 * 夺宝奇兵能力组（均只读，不调游戏侧 updateXxx / sendXxx 方法；发包由 feat 走 pocketcc.net 逐键对齐录制报文）：
 *   - 控制器只存「游戏已收到的服务器态」（7501/7531 应答与 21371~21383 推送写入），本层只读不镜像；
 *   - 快照里所有 64 位 id 已归一为字符串（协议层是 Long 对象、控制器侧是 19 位串，两套口径在此收口）。
 */
export const csHunt = {
  /**
   * 控制器实例在场（subpack2 已接管）。
   * @returns {boolean}
   */
  present() {
    return !!csHuntCtrl();
  },
  /**
   * 玩法开关态原始值（ctrl.open：1=组队夺宝开、3=休赛，其余为雷达/未开）；符号缺失回 0。
   * @returns {number}
   */
  openFlag() {
    var c = csHuntCtrl();
    return c ? Number(c.open) || 0 : 0;
  },
  /**
   * 「能否开新一跑」的完整闸：玩法开（isOpenCSTeamHunt）且剩余次数 > 0。
   * 真机语义：huntCount 由 7501 应答/推送 21377 写入（服务端每 10h 恢复 1 点，上限 5）。
   * 控制器实例不在场（未进过玩法子包）回 false，由调用方先拉 7501 再读。
   * @returns {boolean}
   */
  canHunt() {
    var c = csHuntCtrl();
    if (!c || typeof c.isOpenCSTeamHunt !== 'function') return false;
    try {
      return !!c.isOpenCSTeamHunt() && Number(c.huntCount) > 0;
    } catch (e) {
      return false;
    }
  },
  /**
   * 当前被掠夺行军数（csHuntCtrl().lootMarchNum）：控制器权威态，由推送 21383 HURT_MARCH_SIZE 直接写入
   *   （`lootMarchNum = marchSize`，见 references/游戏逆向/夺宝奇兵分析报告.md「21383 直接写 lootMarchNum」）。
   *   借鉴竞对 roundFight 以 `lootMarchNum > 0` 作「正在被真人掠夺」的一手判据。#7 真实收益：它是游戏侧写的权威计数，
   *   **不被 feat 侧处置时把 #raidSize 置 0 的清零污染**，故能跨回合持续反映仍在场的掠袭（而非「漏推兜底」：
   *   lootMarchNum 本身也是由游戏侧 21383 handler 写入，漏推时两侧同失）；且 21383 有 ~40s 心跳复位 0，无陈旧 >0 长期误武装风险。
   *   符号缺失/控制器不在场/字段非数值一律回 0（调用方据此降级到 7578 侦察）。
   * @returns {number} 被掠夺行军数（0=无/未知）
   */
  lootMarchNum() {
    var c = csHuntCtrl();
    if (!c) return 0;
    try {
      return Number(c.lootMarchNum) || 0;
    } catch (e) {
      return 0;
    }
  },
  /**
   * 只读快照（面板展示/调度决策的唯一进数据）：字段缺失降级不抛错，控制器不在场回 null。
   * @returns {object|null} {open,active,huntCount,lastRecoverTimeMill,lastRound,leader,selfMarchId,team,info}
   *   - team：{id,uid(队长),cfg,status,treasureId,memberCount,memberUids,selfInTeam,selfMarchId,marchedCount,maxMemberPower,readyCount,readyUids,readyStartTimeMill,marchStartTimeMill,marchArriveTimeMill,marchReturnArriveTimeMill} 或 null
   *   - info：{treasureId,round,status,tInfo,eventInfo} —— eventInfo 为控制器 live 对象（其内 Int64 仍是 Long，用 bits.int64Str 读），无跑动中为 null
   */
  readState() {
    var c = csHuntCtrl();
    if (!c) return null;
    var t = c.team || null;
    var uid = '';
    try {
      var m = game.get(SYM.modules.dataCenter);
      uid = bits.int64Str(m && m.DATA && m.DATA.UserData ? m.DATA.UserData.UID : null);
    } catch (e) {}
    var team = null;
    var selfMarchId = '';
    if (t) {
      var members = Array.isArray(t.member) ? t.member : [];
      var memberUids = [];
      var marchedCount = 0;
      var maxMemberPower = 0; // 队内最强成员战力（预警式防御敌强门控用；竞对 onAttacking 同读 team.member[].power）
      for (var i = 0; i < members.length; i++) {
        var mu = bits.int64Str(members[i] && members[i].uid);
        memberUids.push(mu);
        var mid = bits.int64Str(members[i] && members[i].marchId);
        if (mid && mid !== '0') marchedCount++; // marchId 非零 = 该成员已派兵到集结点
        var mpw = Number(members[i] && members[i].power) || 0;
        if (mpw > maxMemberPower) maxMemberPower = mpw;
        if (mu && mu === uid) {
          selfMarchId = mid;
        }
      }
      var ready = Array.isArray(t.readyMember) ? t.readyMember : [];
      var readyUids = [];
      for (var j = 0; j < ready.length; j++) {
        var ru = ready[j];
        readyUids.push(bits.int64Str(ru && ru.uid != null ? ru.uid : ru));
      }
      team = {
        id: bits.int64Str(t.id),
        uid: bits.int64Str(t.uid),
        cfg: Number(t.cfg) || 0,
        status: Number(t.status) || 0,
        treasureId: bits.int64Str(t.treasureId),
        memberCount: memberUids.length,
        memberUids: memberUids,
        selfInTeam: memberUids.indexOf(uid) >= 0,
        selfMarchId: selfMarchId,
        marchedCount: marchedCount,
        maxMemberPower: maxMemberPower,
        readyCount: readyUids.length,
        readyUids: readyUids,
        readyStartTimeMill: int64Num(t.readyStartTimeMill),
        marchStartTimeMill: int64Num(t.marchStartTimeMill),
        marchArriveTimeMill: int64Num(t.marchArriveTimeMill),
        marchReturnArriveTimeMill: int64Num(t.marchReturnArriveTimeMill),
      };
    }
    var info = c.csHuntInfo || null;
    return {
      open: Number(c.open) || 0,
      active: !!(typeof c.isOpenCSTeamHunt === 'function' && c.isOpenCSTeamHunt()),
      huntCount: Number(c.huntCount) || 0,
      lastRecoverTimeMill: int64Num(c.lastRecoverTimeMill),
      lastRound: !!c.lastRound,
      leader: !!(team && uid && team.uid === uid),
      selfMarchId: selfMarchId,
      team: team,
      info: info
        ? {
            treasureId: bits.int64Str(info.treasureId),
            round: Number(info.round) || 0,
            status: Number(info.status) || 0,
            tInfo: info.tInfo || null,
            eventInfo: info.eventInfo || null,
          }
        : null,
    };
  },
  /**
   * NResponseId 跳段推送里的队伍结构归一（与 readState().team 同形）：供 feat 从 push/应答直读 team 时复用。
   * @param {object|null} raw PB team（可能为 null）
   * @returns {object|null}
   */
  readTeam(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var uid = '';
    try {
      uid = bits.int64Str(userData() ? userData().UID : null);
    } catch (e) {}
    var members = Array.isArray(raw.member) ? raw.member : [];
    var memberUids = [];
    var marchedCount = 0;
    var selfMarchId = '';
    for (var i = 0; i < members.length; i++) {
      var mu = bits.int64Str(members[i] && members[i].uid);
      memberUids.push(mu);
      var mid = bits.int64Str(members[i] && members[i].marchId);
      if (mid && mid !== '0') marchedCount++; // marchId 非零 = 该成员已派兵到集结点
      if (mu && mu === uid) selfMarchId = mid; // 与 readState().team 同形：回填本人 marchId（页外快照判「队长自己是否已出兵」的唯一依据）
    }
    var ready = Array.isArray(raw.readyMember) ? raw.readyMember : [];
    var readyUids = [];
    for (var j = 0; j < ready.length; j++) {
      var ru = ready[j];
      readyUids.push(bits.int64Str(ru && ru.uid != null ? ru.uid : ru));
    }
    return {
      id: bits.int64Str(raw.id),
      uid: bits.int64Str(raw.uid),
      cfg: Number(raw.cfg) || 0,
      status: Number(raw.status) || 0,
      treasureId: bits.int64Str(raw.treasureId),
      memberCount: memberUids.length,
      memberUids: memberUids,
      selfInTeam: memberUids.indexOf(uid) >= 0,
      selfMarchId: selfMarchId,
      marchedCount: marchedCount,
      readyCount: readyUids.length,
      readyUids: readyUids,
      readyStartTimeMill: int64Num(raw.readyStartTimeMill),
      marchStartTimeMill: int64Num(raw.marchStartTimeMill),
      marchArriveTimeMill: int64Num(raw.marchArriveTimeMill),
      marchReturnArriveTimeMill: int64Num(raw.marchReturnArriveTimeMill),
    };
  },
  /**
   * 当前服务器毫秒时刻（与玩法 timeInfo 的 beginMill/endMill 同量纲）；serverTime 秒 ×1000，取不到回 0。
   * 时段边界是分钟级，秒级误差无影响。
   * @returns {number}
   */
  serverMs() {
    return (gameData.serverTime() || 0) * 1000;
  },
  /**
   * 从 7501 应答的 `crossTreasureInfo`（或控制器 timeInfo 同构体）解析夺宝时间表（纯查询，不读控制器）。
   *   `open`：1=组队夺宝赛季开（整天为真，非「当前时刻可开跑」）、3=休赛；`openTime[]`：每天 3 个 2h 时段的 beginMill/endMill（Int64 Long）。
   *   字段缺失/非数组一律容错回空 slots（调用方据此当「未知」，不贸然动作）。
   * @param {object|null} info crossTreasureInfo 应答体（含 open / openTime）
   * @returns {{open:number, slots:Array<{begin:number,end:number}>}|null} 无 info 回 null
   */
  parseSchedule(info) {
    if (!info || typeof info !== 'object') return null;
    var raw = Array.isArray(info.openTime) ? info.openTime : [];
    var slots = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i] || {};
      var begin = int64Num(s.beginMill);
      var end = int64Num(s.endMill);
      if (begin > 0 && end > 0) slots.push({ begin: begin, end: end });
    }
    return { open: Number(info.open) || 0, slots: slots };
  },
  /**
   * 判「当前服务器毫秒时刻是否落在某个每日夺宝时段内」（纯函数，不含 open 开关判定）。
   * @param {Array<{begin:number,end:number}>|null} slots parseSchedule().slots
   * @param {number} nowMs 当前服务器毫秒（csHunt.serverMs()）
   * @returns {{known:boolean, in:boolean, nextBegin:number}} known=时段数据可用；in=此刻在时段内；nextBegin=下一个未到时段的起始毫秒（无则 0）
   */
  playWindowState(slots, nowMs) {
    if (!Array.isArray(slots) || !slots.length) return { known: false, in: false, nextBegin: 0 };
    var next = 0;
    for (var i = 0; i < slots.length; i++) {
      var sl = slots[i];
      if (!sl) continue;
      if (nowMs >= sl.begin && nowMs <= sl.end) return { known: true, in: true, nextBegin: 0 };
      if (sl.begin > nowMs && (!next || sl.begin < next)) next = sl.begin;
    }
    return { known: true, in: false, nextBegin: next };
  },
  /**
   * 幸运奖励池只读枚举（面板 luckyRewards 的候选源）：本玩法可翻倍礼品 = `cross_treasure_event`
   *   各行的 **win 中奖奖励**配置 id（`78001xxx`）经 RewardController 解包后的 itemId（**不含 fail 保底、不含 grail 神器**——
   *   引擎 #tryLucky 只喂 winRewardResult、且幸运「神器除外」，列进来会是永不命中的死勾选），
   *   去重后回 `{id,name,scenes}`（名从 `item` 表解析；scenes = 该 itemId 出现的事件场景族，规范顺序 pickReward→rollDice→codeBox→defPVE）。
   * 【为何不是 cross_treasure_pool】：那张表是以 poolId 为主键的**赛季开关配置行**（min_level/achievement_open/
   *   grail_open…），根本不存礼品清单——之前误读它才导致面板幸运池恒空。事件奖励行属登录下发的客户端配置，
   *   活动未开始时也在内存，故面板可在开局前就铺出候选供勾选。表未就绪/符号缺失/无奖励一律回 []。
   * @returns {Array<{id:number, name:string, scenes:string[]}>}
   */
  readRewardPool() {
    var rows = l10n.tableRows('cross_treasure_event');
    if (!Array.isArray(rows) || !rows.length) return [];
    // 奖励列名以真机 dump 定稿（docs §9）：幸运只翻倍中奖奖励，故**只取 win 列**（多备同义列容错）；
    //   fail_reward（未中奖保底）与 grail_reward（神器，幸运明确除外）引擎永不喂给 #tryLucky，列进来是死勾选，不收。
    var rewardCols = ['win_reward', 'reward', 'winReward', 'show_reward'];
    // 事件族主键前缀 → 场景 key（Math.floor(eventSpecId/100)：1001 pickReward/1002 rollDice/1003 codeBox/1005 defPVE；
    //   1004 pickSkill 发科技、1006 nothing 空过，均不产可翻倍道具，不入池）
    var famScene = { 1001: 'pickReward', 1002: 'rollDice', 1003: 'codeBox', 1005: 'defPVE' };
    var order = ['pickReward', 'rollDice', 'codeBox', 'defPVE'];
    var byId = Object.create(null);
    var out = [];
    var push = function (id, scene) {
      id = Number(id) || 0;
      if (id <= 0) return;
      var rec = byId[id];
      if (!rec) {
        var name = '';
        try {
          var row = l10n.tableRow('item', id);
          name = row && row.name ? l10n.text(row.name) : '';
        } catch (e) {}
        rec = byId[id] = { id: id, name: name || '道具 ' + id, _set: Object.create(null) };
        out.push(rec);
      }
      if (scene) rec._set[scene] = 1;
    };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var scene = famScene[Math.floor(Number(r.id) / 100)] || '';
      for (var j = 0; j < rewardCols.length; j++) {
        var rid = r[rewardCols[j]];
        if (rid == null) continue;
        // 一格可能装多个 reward id（如 '7800101|7800102'），按分隔符拆后逐个解包
        var parts = String(rid).split(/[|,;\s]+/);
        for (var p = 0; p < parts.length; p++) {
          var one = Number(parts[p]);
          if (!(one > 0)) continue;
          var items = gameData.rewardItems(one);
          for (var k = 0; k < items.length; k++)
            if (items[k] && items[k].id) push(Number(items[k].id), scene);
        }
      }
    }
    for (var m = 0; m < out.length; m++) {
      var set = out[m]._set;
      var arr = [];
      for (var q = 0; q < order.length; q++) if (set[order[q]]) arr.push(order[q]);
      out[m].scenes = arr;
      delete out[m]._set;
    }
    return out;
  },
};

export const session = {
  /** 触发游戏登出（PlatformCore.instance.userLogout）；符号缺失记 warn 静默 */
  logout() {
    var p = probe('PlatformCore.instance', () => {
      var m = game.get(SYM.modules.platformCore);
      return (m && m.instance) || null;
    });
    if (!p || typeof p.userLogout !== 'function') return;
    p.userLogout();
  },
};

// ─────────────────────── 邮件（只读缓存 / 原生拉取） ───────────────────────

/**
 * 邮件管理器（MailData.mailManager = NMailModel 实例）：由 subpack/SubpackMain 载入时挂上，
 * 早于它探测会拿不到——probe 失败不缓存，下次调用自愈重探。
 * @returns {object|null}
 */
function mailManager() {
  return probe('MailData.mailManager', () => {
    var m = game.get(SYM.modules.mailData);
    var mm = m && m.mailManager;
    return mm && typeof mm.getGroupMails === 'function' ? mm : null;
  });
}

/**
 * 展示分组语义名 → MailShowGroupType 数值。
 * ❗当前运行时实证 MailShowGroupType 成员名用 `t_` 前缀（t_alliance=1 / t_active=2 / t_system=3 / t_battle=4 / t_collect=5 /
 *   t_battle_pve=6 / t_store=7，另有 NULL=-1），并非早期误记的 `type_owner=1`（那是另一个枚举）。为不再因前缀漂移而静默失效，
 *   这里按「去掉 t_/type_ 前缀后的基名」不区分大小写匹配成员，且只认正数分组值（跳过 NULL 与 TS 反查的数字键）。
 * @param {string} name 分组语义基名（如 'alliance'/'system'，不带前缀）
 * @returns {number} 枚举值，未命中 0
 */
function mailGroupValue(name) {
  var m = game.get(SYM.modules.mailData);
  var E = m && m.MailShowGroupType;
  if (!E || !name) return 0;
  var want = String(name).toLowerCase();
  for (var k in E) {
    var v = E[k];
    if (typeof v !== 'number' || v <= 0) continue; // 只认成员键（数字反查键的值是字符串；NULL=-1 不算分组）
    if (k.replace(/^t(ype)?_/i, '').toLowerCase() === want) return v;
  }
  return 0;
}

/**
 * 邮件只读能力：读游戏内存缓存（group/all，零发包）与走游戏原生 933 MAIL_nGetGroupList 拉取（load）。
 * 不调任何 Delete/Read/Favorite 类改写方法（只读+发包红线）；load 也只是拉列表进游戏缓存，与玩家点开邮件面板同源。
 */
export const mail = {
  /**
   * 邮件管理器（mailManager）是否已就绪：mailManager 由 SubpackMain.main()（subpack 载入）挂上，
   * 晚于核心与部分 feat 的 run 时机。纯读探测（复用 mailManager 的 probe 缓存），供调用方在未就绪时延后重试，
   * 而非把「此刻读不到缓存」误当成永久能力缺失。
   * @returns {boolean} mailManager 在场且可 getGroupMails 则为 true
   */
  ready() {
    return !!mailManager();
  },
  /**
   * 某展示分组的邮件列表（游戏缓存，纯读）。分组实证：DATACONFIG 130157 把 mailType 归组（'1|9' ⇒ 分组值 1=t_alliance 含 mailType 9），
   * 故「遗迹区域刷新」（mailType 9）在 t_alliance(=1) 组里。
   * @param {string} name 分组语义基名（'alliance'/'system'/'store'…，不带 t_/type_ 前缀）
   * @returns {object[]} 邮件数组（{title,content,sendTime,mailType,…}），符号/分组缺失回 []
   */
  group(name) {
    var g = mailGroupValue(name);
    var mm = mailManager();
    if (!g || !mm) return [];
    try {
      var list = mm.getGroupMails(g);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },
  /**
   * 全部分组邮件扁平去重（按 mailId，sendTime 降序）：免调用方逐组点名，也免赌「某邮件在哪组」。
   * @returns {object[]}
   */
  all() {
    var mm = mailManager();
    if (!mm) return [];
    var m = game.get(SYM.modules.mailData);
    var E = (m && m.MailShowGroupType) || null;
    var out = [];
    var seen = new Set();
    var groups = new Set();
    // 按枚举「成员键→正数分组值」收集全部展示分组（当前实证 t_alliance=1..t_store=7）：不依赖成员名前缀，
    //   也自然跳过 TS 反查的数字键（其值为字符串）与 NULL=-1。
    if (E) {
      for (var key in E) {
        var gv = E[key];
        if (typeof gv === 'number' && gv > 0) groups.add(gv);
      }
    }
    groups.forEach(function (v) {
      var list;
      try {
        list = mm.getGroupMails(v);
      } catch (e) {
        return;
      }
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var mail0 = list[i];
        if (!mail0) continue;
        var id = String(mail0.mailId == null ? mail0.id || '' : mail0.mailId);
        if (id) {
          if (seen.has(id)) return;
          seen.add(id);
        }
        out.push(mail0);
      }
    });
    out.sort(function (a, b) {
      return (Number(b && b.sendTime) || 0) - (Number(a && a.sendTime) || 0);
    });
    return out;
  },
  /**
   * 拉某分组邮件进游戏缓存（原生 NMailModel.loadGroupMails → 933，首页翻页请求）。
   * 永不 reject：符号缺失/抛错/超时无回调一律回 false，调用方自行降级。
   * @param {string} name 分组语义名
   * @param {number} [timeoutMs] 回调超时（默认 10s，游戏回调在其内部 setTimeout 里投递）
   * @returns {Promise<boolean>} 是否拉到（回调已达）
   */
  load(name, timeoutMs) {
    var g = mailGroupValue(name);
    var mm = mailManager();
    if (!g || !mm || typeof mm.loadGroupMails !== 'function') return Promise.resolve(false);
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        resolve(ok);
      };
      var timer = setTimeout(function () {
        finish(false);
      }, timeoutMs || 10000);
      try {
        mm.loadGroupMails(g, {
          callback: function () {
            clearTimeout(timer);
            finish(true);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        finish(false);
      }
    });
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
  try {
    p.Run(p[SYM.procedures.home]);
    return { ok: true };
  } catch (e) {
    log.warn('goHome failed: %s', e && e.message);
    return { ok: false, err: 'failed' };
  }
}

/** 切到 NWorldMap 场景（内部） */
function goWorldScene() {
  var p = proce();
  if (!p || !p[SYM.procedures.newWorld]) return { ok: false, err: 'unavailable' };
  try {
    p.Run(p[SYM.procedures.newWorld]);
    return { ok: true };
  } catch (e) {
    log.warn('goWorld failed: %s', e && e.message);
    return { ok: false, err: 'failed' };
  }
}

export const scene = {
  /** 当前场景节点名（cc.director.getScene().name）；引擎未就绪返回 '' */
  name() {
    try {
      var s = cc.director.getScene();
      return (s && s.name) || '';
    } catch (e) {
      return '';
    }
  },
  /** 基地↔大世界互切：按当前场景决定去向（走内部 goHomeScene/goWorldScene）；两者之外的场景不处理（返回 wrongscene） */
  toggleHomeWorld() {
    var cur = this.name();
    if (cur === SYM.sceneNames.newWorld) return goHomeScene();
    if (cur === SYM.sceneNames.home) return goWorldScene();
    return { ok: false, err: 'wrongscene', scene: cur };
  },
};

/**
 * 原生 UI 面板开关能力：调游戏 UIManager.Instance().OpenUI/CloseUI(描述符)，与主界面各功能按钮、面板自身
 *   close() 同源。只触原生开窗/关窗，不改写游戏数据（close 仅收窗口实例，不动业务态）。
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
    try {
      mgr.OpenUI.apply(mgr, [info].concat(args));
      return { ok: true };
    } catch (e) {
      log.warn('ui.open(%s) failed: %s', semantic, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
  /** 打开道具背包（B 键用） */
  openBag() {
    return this.open('bag');
  },
  /**
   * 按语义面板名关闭指定面板（与面板自身关闭链路同源：BaseUI.close → UIManager.Instance().CloseUI(描述符)）。
   * **先验在场再调 CloseUI**：实证 UIManagerImpl.CloseUI 对不在场面板仍会 `EVENT.emit(CLOSEUI)` 并走 LastCloseUI
   *   （无条件 `delete LoadingPanel[name]`、改写 CurrentUIDataInfo）——空手调用有副作用，所以在场外直接返回。
   * 在场判据含「正在异步加载」：dealOpenUI 同步置 `LoadingPanel[name]=!0` 后才 load 预制体，加载回调只在
   *   `LoadingPanel[name]` 仍为真时才 ShowUI → 此时 CloseUI（LastCloseUI 删标记）等于把还没露脸的窗口收掉。
   * @param {string} semantic 语义名（SYM.uiPanels 键，如 'bag' / 'pabFeedPopup'）
   * @returns {{ok:boolean, err?:string, name?:string}} err: unavailable=符号漂移/缺方法，not_open=不在场，failed=游戏侧抛错
   */
  close(semantic) {
    var reg = uiRegistry();
    var member = reg && SYM.uiPanels[semantic];
    var info = member && reg[member];
    if (!info || !info.name) return { ok: false, err: 'unavailable' };
    var C = uiMgrClass();
    var mgr = C && typeof C.Instance === 'function' ? C.Instance() : null;
    if (!mgr || (typeof mgr.CloseUI !== 'function' && typeof mgr.Close !== 'function'))
      return { ok: false, err: 'unavailable' };
    var pool = mgr.DataPool;
    var loading = mgr.LoadingPanel;
    if ((!pool || pool[info.name] == null) && (!loading || !loading[info.name]))
      return { ok: false, err: 'not_open', name: info.name };
    try {
      if (typeof mgr.CloseUI === 'function') mgr.CloseUI(info);
      else mgr.Close(info.name);
      return { ok: true, name: info.name };
    } catch (e) {
      try {
        if (typeof mgr.Close === 'function') {
          mgr.Close(info.name);
          return { ok: true, name: info.name };
        }
      } catch (e2) {}
      log.warn('ui.close(%s) failed: %s', semantic, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
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
    try {
      mgr.CloseUI(cur);
      return { ok: true, name: nm };
    } catch (e) {
      try {
        if (typeof mgr.Close === 'function') {
          mgr.Close(nm);
          return { ok: true, name: nm };
        }
      } catch (e2) {}
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
    try {
      var s = U.getMapGameSizeBySubMap(gameData.subServerId());
      var w = s && (s.width != null ? s.width : s.x),
        h = s && (s.height != null ? s.height : s.y);
      return w > 0 && h > 0 ? { xMax: (w | 0) - 1, yMax: (h | 0) - 1 } : null;
    } catch (e) {
      return null;
    }
  },
};

// ─────────────────────── 世界态原始信号（core/world-state.js 的唯一判据源） ───────────────────────

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
 * core/world-state.js 做归一，符号名知识全收在本文件（ACL）。全部为只读 getter，
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
    return secretRealm.isPabBattleMap();
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

/**
 * 调试面（仅供控制台，不入业务路径）：与 core 工具同挂 window.pocketcc（见 content.entry.js），
 * 逆向时 `pocketcc.gameApi.march.flags()` 看战场判定器是否解析成功、
 * `pocketcc.gameApi.march.resolve(13)` 看基础 marchType 在当前战场漂成哪个值（无需等到活动图里复现）。
 */
export const debug = {
  SYM,
  CAPS,
  checkCap,
  probe,
  ns,
  game,
  l10n,
  nav,
  march,
  gameData,
  gameConf,
  bits,
  session,
  mail,
  avatar,
  worldMap,
  worldSignals,
  battlePreset,
  scene,
  ui,
  secretRealm,
};
