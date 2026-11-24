/**
 * pocketcc ACL 引擎（防腐层机器核）——从 game-api.js 抽出（解耦试点第一步）。
 * 职责：只拥有「探测/解包/单例取用」这套机器与跨玩法共享符号表 SYM，不含任何玩法业务能力。
 * 分工：
 *   - 共享能力区段（l10n/gameData/nav/march/bits…）仍在 game-api.js（经 ESM import 使用本引擎，SYM/probe 单点不复制）；
 *   - 活动专属适配器下沉到各 feat 目录（feats/<类别>/<name>/api.js），经 createAcl(tag) 取同一份引擎单例——
 *     游戏 bundle 符号名知识仍集中（引擎 SYM=共享域 + 各 api.js 的本地 SYM=专属域），漂移修复单点化到 feat。
 * 合规：全部原语为只读探测，不改写游戏数据。
 */
import { game } from './game.js';
import { createLog } from './log.js';

/** @type {ReturnType<createLog>} 引擎日志器（probe/checkCap 等原语的告警归 GAMEAPI tag，与拆分前一致） */
const log = createLog('GAMEAPI');

/**
 * 共享符号表：跨玩法的游戏内部名字集中于此，一眼可全审；活动专属符号名就近住进各 feat 的 api.js。
 * @type {Object<string, *>}
 */
export const SYM = {
  modules: {
    localManager: 'LocalManager',
    loadManager: 'LoadManager', // 资源加载收口：loadSpriteFrame(path, cb)（图标 dataURL 原语用，见 acl/hero-icon.js）
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
    homeMap: 'HomeMap', // 大本营地图组件类（default=cc 组件类；core/home-snap.js 钩 default.prototype.onSceneEnded 克隆离场景快照，world 空投选点回退用）
    homeMapUtils: 'HomeMapUtils', // 大本营地图工具（default.getMapPosByPosId：posId→主城小格坐标 {x,y}），空投落点换算用
    homeMapCommon: 'HomeMapCommon', // 大本营地图常量（WidthCount/HeightCount 主城网格尺寸），空投落点扫描边界用
    commonTools: 'CommonTools', // 通用工具（subpack2）：checkShieldEnable(false) 权威「能否开盾」闸（狂热/危险区/跨服一次覆盖，抑制 UI）
    worldMapCtrl: 'WorldMapController', // 旧图主控：静态 model.checkIsPlainTile(x,y,true) 为迁城落点合法性只读判定（cc 组件类无 getInstance，故取 .model）
    nWorldMapUtils: 'NWorldMapUtils', // 新图迁城工具（subpack2、模块级）：checkCanMove(x,y) 落点合法性权威判定（当前游戏默认走新图；符号缺失软失败）
    nWorldMapTerritoryModel: 'NWorldMapTerritoryModel', // 新图联盟领地单例（subpack2）：AllianceTerritory 存视口内堡垒领地条目 {x,y,w,bw,owner,buildId}，供迁城落点推「禁迁实心区」（符号缺失软失败）
    nWorldMapData: 'NWorldMapData', // 新图世界数据单例（subpack2）：instance.placeFlags 为 cell 级占用 Map，settle 就绪门按邻域命中计数（符号缺失软失败）
    gameTools: 'GameTools', // 游戏工具：isKVK() 读 eightServerType 形态位（整季为真，不是「此刻在哪张图」），迁城落点「仅本服图拦别盟领地」分区闸门（符号缺失保守当本服）
    mechaTowerCtrl: 'MechaTowerController', // 重装母舰（Mecha 塔）控制器门面：具名导出 MechaTowerController 类，静态 getInstance() 由 subpack2 Real 接管后实例才有 isOpenFunc（一键领取子玩法闸只读查询）
    enigmaBeastCtrl: 'EnigmaBeastController', // 异能兽控制器门面：default=类（静态 getInstance() 由 subpack Real 接管后才有实例），模块顶层还导出 BeastOpenType/BeastServerStatus 枚举（培育开启闸只读查询）
    mailData: 'MailData', // 邮件数据层（CommonJS 直挂 exports）：MailShowGroupType 展示分组枚举 + mailManager（NMailModel 实例，由 SubpackMain 载入时 `m.mailManager=new I.default` 挂上，故晚于核心就绪）
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
  /** 语义表名 → 游戏 TableName 字符串值（TableName 实证） */
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
    // （skin_name_1901000=柏拉图双子星），与战场无关。
    tmAttackPlayer: 'TM_ATTACK_PLAYER', // 150 无双峡谷·TeamMatch 代（组队赛，字典无独立词条）
    masterAttackPlayer: 'MASTER_ATTACK_PLAYER', // 170 环球大师赛（master_match_21）/无双峡谷-王者赛
    avaAttackPlayer: 'AVA_ATTACK_PLAYER', // 110 无双峡谷·AVA 代（mapType=new_cab）
    teamLegendAttackPlayer: 'TEAM_LEGEND_ATTACK_PLAYER', // 181 无双峡谷-小队赛/传奇赛（legend_team_match_101）
    attackWorldBoss: 'ATTACK_WORLDBOSS', // 14 普通世界 boss（quick-attack/imperial-decree 经 typeOf 取名值）
    attackWorldBossV2: 'ATTACK_WORLD_BOSS_V2', // 298 bossV2 世界 boss（同上；source-of-war 本地写死 298 未走此）
    csAttackTreasure: 'CS_ATTACK_TREASURE', // 138 拦截夺宝飞船（quick-attack 经 typeOf 取名值；同块 CROSS_TREASURE_SHIP=160 是别的玩法，别混）
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
    sq2026: 'sq_2026',
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
   * iceShakePopup 实证 UIDataInfoOther：`t.CQ26WLRemoveIceView = new e("CQ26WLRemoveIceView", UIType.TYPE_POP,
   *   "m/CQ26/prefab/wasteland", 0, 0, {frame: UIDataFrameType.None, clickBlankClose: false}, …)`——
   *   `clickBlankClose:false` 意味着这扇摇一摇弹窗点空白关不掉，只能点「发送火焰」或等 10s 倒计时自己收，
   *   所以 cq26IceShake 代摇成功后必须自己走原生 CloseUI 收窗，否则玩家手滑补点会撞 s=3「参数错误」。
   */
  uiPanels: {
    bag: 'BagPanel',
    pabFeedPopup: 'PabPetFeedEventPopup',
    iceShakePopup: 'CQ26WLRemoveIceView',
    // 报文实证：本项自己的成员名就是 CommonRewardPanel，但面板名是 rewardOutPanel
    //（UIDataInfoOther：CommonRewardPanel=new e("rewardOutPanel",TYPE_POP,"ui",3,0,
    //  {frame:None,pauseGuide:!,hideMask:!,cacheUI:!,…})）；另一张同名面板
    // CommonRewardPanelV2 读的是 .reward/.bigReward，与本面板的 .serverReward 不同口径。
    commonRewardPanel: 'CommonRewardPanel',
  },
  /**
   * 世界态可订阅事件名（值就是 EventId 常量值本身，实证游戏侧 EventId：
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

/** @type {Set<string>} 已记过「bundle 未就位」debug 的探测键（同键只提一次，不刷屏） */
const probeDeferred = new Set();

/**
 * 惰性探测：首次解析并缓存，失败记一条 warn（符号漂移警报）。
 * 失败不落缓存：这些符号都在世界地图子包，核心就绪时可能尚未注册，
 * 缓存 null 会把一次早探测钉死整个页面生命周期（自愈不了）。
 * 警报口径：`__require` 未定义（游戏 bundle 未加载）时只回 null 不 warn，
 *   调用方要区分「还没就绪」与「真读不到」用 l10n.tableReady() 一类能力。
 * @param {string} key 缓存键（符号语义名）
 * @param {Function} resolve 解析函数，返回目标对象或 null/报错
 * @returns {*|null}
 */
export function probe(key, resolve) {
  if (probes.has(key)) return probes.get(key);
  var v = null;
  try {
    v = resolve() || null;
  } catch (e) {}
  if (v) {
    probes.set(key, v);
    return v;
  }
  // 游戏 bundle 还没把 `__require` 挂上全局（内容脚本求值/面板求值期）：此窗里任何符号都解析不到，
  // 属加载时序而不属符号漂移，不打警报（否则每次刷页都误报一排「symbol drift」）；失败也不入缓存，下一拍自愈重探。
  // 完全静默会反过来掉进「真漂移了但没人说」的坑（若 `__require` 永不出现），故留一条可 grep 的 debug 轨迹；
  //   长期未就绪的最终业务结论仍由各 feat 的 install 报（missing 清单 / engine idle 是 warn 级）。
  if (!game.ready()) {
    if (!probeDeferred.has(key)) {
      probeDeferred.add(key);
      log.debug('probe deferred: game bundle not loaded yet. key=%s', key);
    }
    return null;
  }
  if (!probeWarned.has(key)) {
    probeWarned.add(key);
    log.warn(
      'probe "%s" failed: symbol drift (game update) or feature/subpackage not loaded, related capabilities will degrade',
      key,
    );
  }
  return null;
}

/**
 * 探测面状态（调试口径，业务路径不得调用）：ok=已解析并缓存的键，warned=解析失败且已警报过的键，
 *   deferred=因游戏 bundle 未就位而推迟的键（加载时序，不是漂移）。
 * 用于判定一条「probe failed」告警究竟是**加载时序**（warned 里出现过、现在 ok 里也有 → 已自愈）
 *   还是**改版符号漂移**（留在 warned、且控制台复现不了原对象）——同 pocketcc.net.secondaryStatus() 的定位。
 * @returns {{ok:string[], warned:string[], deferred:string[]}} ok=成功缓存键，warned=失败并警报过的键，deferred=推迟过的键
 */
export function probeStatus() {
  return {
    ok: Array.from(probes.keys()),
    warned: Array.from(probeWarned),
    deferred: Array.from(probeDeferred),
  };
}

/**
 * 强制重探（调试口径）：丢掉某键（或全部）的成功缓存与「只警一次 / 只 debug 一次」标记，下一次取用即按当前符号表重新解析，
 *   失败可在控制台再看到那条 warn——改版当天不必刷页，清完就地重探（同 pocketcc.net.reprobeSecondary()）。
 * @param {string} [key] 目标探测键；省略则清全部
 * @returns {string[]} 被清除的键（省略 key 时返回清除前的全部键，去重）
 */
export function reprobe(key) {
  if (key != null) {
    probes.delete(key);
    probeWarned.delete(key);
    probeDeferred.delete(key);
    return [key];
  }
  var out = [];
  var seen = {};
  [Array.from(probes.keys()), Array.from(probeWarned), Array.from(probeDeferred)].forEach(
    function (ks) {
      ks.forEach(function (k) {
        if (seen[k]) return;
        seen[k] = 1;
        out.push(k);
      });
    },
  );
  probes.clear();
  probeWarned.clear();
  probeDeferred.clear();
  return out;
}

// ─────────────────────── 能力校验表（feat 安装期依赖自检） ───────────────────────

/**
 * 能力键 → 只读校验器：feat 在 spec.symbols 里按语义名声明依赖的游戏 bundle 符号，
 * reactor 在调用 spec.install 前逐一经本表校验；任一项解析不到即安装失败并记 warn。
 * 符号名知识收在 ACL（引擎共享域 + 各 feat api.js 专属域），feat 只写语义名，不出现游戏模块名字符串。
 * 约定：
 *   - 校验只判「模块在场 + 声明的成员链可达」，不判方法签名（漂移细节仍由 probe 运行期告警）；
 *   - 名字末尾带 '?' 的软能力（feat 已有降级路径）缺失只告警不阻断，由 reactor 侧解释；
 *   - 惰性解析的实例 getter（instance）可能在安装期尚未建立，故此类能力只校验模块/类在场；
 *   - 活动专属能力键由各 feat 的 api.js 经 registerCaps 自带自注册（如 pabController/csHuntController）。
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
  // 秘密武器空投原生选点依赖：UIManager.default.Instance().HomeMap.findValidAirDropBoxArea（Home 内组件，离开即 null；
  //   此处只验门面模块在场，HomeMap 实时可用性由 feat ACL fail-closed 兜底）
  uiManager: () => !!game.get(SYM.modules.uiManager),
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
  navFly: () => !!sharedCapsProbe('navFly'),
  // 邮件只读缓存：MailData 模块在场即可（mailManager 实例由 subpack 载入时挂上，安装期未必就绪，
  //   故 feat 侧应声明为软依赖 'mailData?'，运行期再由 mail.* 内部 probe 自愈重探）
  mailData: () => !!game.get(SYM.modules.mailData),
  // CQ26 战区宝藏（发掘点候选源）：取器由 core/acl/game-data.js 经 setSharedCapsProbe 回填（同 navFly 口径，
  //   引擎不反向 import 区段）。单例实例在登录握手后即可用，但投影字段属游戏私有态，故 feat 侧
  //   声明为软依赖 'cq26NeutralCtrl?'（拿不到降级为只信 22062/22063 推送，不阻断安装）。
  cq26NeutralCtrl: () => !!sharedCapsProbe('cq26NeutralCtrl'),
  // CQ26 荒芜冰原数据侧（wasteLandData：22071/22072/22077 三份快照的宿主）：取器同样由
  //   core/acl/game-data.js 经 setSharedCapsProbe 回填。feat 侧声明为软依赖 'cq26WasteLand?'
  //   （拿不到只降级为「读自订 push 的标量副本」，不阻断安装，同 cq26NeutralCtrl 口径）。
  cq26WasteLand: () => !!sharedCapsProbe('cq26WasteLand'),
  // CQ26 能量补充车队数据侧（clearBossData.canSendWorldEnergy 宿主）：取器同样由 game-data.js
  //   经 setSharedCapsProbe 回填。feat 侧声明为软依赖 'cq26ClearBoss?'（拿不到只降级为
  //   「只信 22001 push」，不阻断安装，同 cq26WasteLand 口径）。
  cq26ClearBoss: () => !!sharedCapsProbe('cq26ClearBoss'),
};

/**
 * 活动专属能力键自注册：各 feat 的 api.js 自带自登记（模块求值即注册，早于 reactor 安装期校验——
 * content.entry 的 import 顺序保证 feats 先于 boot）。同名键直接覆盖，重复注册幂等。
 * @param {Object<string, function():boolean>} caps 能力键 → 只读校验器
 */
export function registerCaps(caps) {
  Object.assign(CAPS, caps || {});
}

/**
 * 校验一个能力键在场（未知键返回 false —— 声明笔误在开发期 F5 即暴露）。
 * @param {string} key 能力语义名（CAPS 键，可带 '?' 后缀表软依赖）
 * @returns {boolean}
 */
export function checkCap(key) {
  var k = String(key || '').replace(/\?$/, '');
  var f = CAPS[k];
  if (!f) {
    log.warn('checkCap: unregistered capability key "%s"', key);
    return false;
  }
  try {
    return !!f();
  } catch (e) {
    return false;
  }
}

/** LOCAL 翻译单例（LocalManager 导出 .LOCAL） */
export function LOCAL() {
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
export function ns(m) {
  return m && m.__esModule && m.default != null ? m.default : m;
}

/** TABLE 配置表单例（TableManager 导出 .TABLE） */
export function TABLE() {
  return probe('TableManager.TABLE', () => {
    var m = game.get(SYM.modules.tableManager);
    return (m && m.TABLE) || null;
  });
}

/** 配置表名枚举对象（TableName 模块导出 .TableName，成员名 → 游戏表名字符串；符号缺失返回 null） */
export function tableNameEnum() {
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
export function userData() {
  var m = probe('DataCenter', () => game.get(SYM.modules.dataCenter) || null);
  return (m && m.DATA && m.DATA.UserData) || null;
}

/** 场景程序管理器单例（ProcedureManager.PROCE）；PROCE.Home/NewWorld 由 ProcedureManagerInit 惰性挂上，成员每次实时读 */
export function proce() {
  return probe('ProcedureManager.PROCE', () => {
    var m = game.get(SYM.modules.procedureManager);
    return (m && m.PROCE) || null;
  });
}

/** UI 管理器门面类（UIManager.default，其静态 Instance() 返回真实接管单例或未接管兜底桩；此处只缓存类、实例每次实时取，避免缓存到兜底桩） */
export function uiMgrClass() {
  return probe(SYM.modules.uiManager + '.default', () => {
    var m = game.get(SYM.modules.uiManager);
    return (m && m.default) || null;
  });
}

/** UIDataInfo 面板描述符注册表对象（成员名→UIDataInfoClass 实例；对象引用稳定，面板由各模块惰性追加，读成员实时） */
export function uiRegistry() {
  return probe(SYM.modules.uiDataInfo + '.UIDataInfo', () => {
    var m = game.get(SYM.modules.uiDataInfo);
    return (m && m.UIDataInfo) || null;
  });
}

/** 资源路径换算器 PathUtils（ES 命名空间下取 .default 类；静态方法 GetIconURL） */
export function pathUtils() {
  return probe(SYM.modules.pathUtils, () => {
    var P = ns(game.get(SYM.modules.pathUtils));
    return P && typeof P.GetIconURL === 'function' ? P : null;
  });
}

/**
 * 资源加载器 LoadManager（静态方法 loadSpriteFrame(path, cb)）。
 * 导出信封三形态实证都存在过（多形态兜底纪律）：命名空间顶层挂静态 / ES .default 类 /
 * 具名导出 a.LoadManager（游戏反编译源码尾部即 `a.LoadManager=l`、文件内无 a.default —— ns() 对它
 * 不解包回壳，壳上无方法 → 曾误报 symbol drift，见 marchStorage 同款兜底先例）。
 */
export function loadManager() {
  return probe(SYM.modules.loadManager, () => {
    var m = game.get(SYM.modules.loadManager);
    if (!m) return null;
    var cands = [m, ns(m), m.LoadManager, m.default && m.default.LoadManager];
    for (var i = 0; i < cands.length; i++) {
      var L = cands[i];
      if (L && typeof L.loadSpriteFrame === 'function') return L;
    }
    return null;
  });
}

/** 出征档案重算器单例（MarchStorageController.getInstance()）；门面未接管或方法名漂移时返回 null */
export function marchStorage() {
  return probe('MarchStorageController.instance', () => {
    var m = game.get(SYM.modules.marchStorage);
    var C = m && (m.MarchStorageController || (m.default && m.default.MarchStorageController));
    var inst = C && C.getInstance && C.getInstance();
    return inst && typeof inst.checkPreMarchExtraList === 'function' ? inst : null;
  });
}

// ─────────────────────── 世界态活动信号插槽 ───────────────────────

/**
 * 活动侧世界信号插槽：活动专属判据（如秘境态）由各 feat 的 api.js 注册进来，
 * 使 game-api 共享区段（worldSignals）不必反向 import 活动适配器（解耦试点的桥）。
 * 未注册时各槽返回 null，消费方按「信号不可用」保守降级。
 * @type {Object<string, Function>}
 */
const worldSlots = {};

/**
 * 注册一个世界态信号（幂等，重复注册覆盖）。
 * @param {string} name 槽名（如 'pabBattleMap'）
 * @param {Function} fn 只读信号取值器
 */
export function registerWorldSlot(name, fn) {
  if (name && typeof fn === 'function') worldSlots[name] = fn;
}

/**
 * 读取一个世界态信号；槽位未注册返回 null（调用方保守降级，不得抛错）。
 * @param {string} name 槽名
 * @returns {*} 信号值；无槽回 null
 */
export function worldSlot(name) {
  var f = worldSlots[name];
  if (!f) return null;
  try {
    return f();
  } catch (e) {
    return null;
  }
}

/**
 * 共享区段能力槽回填：mapTodo（跳转协调器）等解析器住在 game-api 共享区段，
 * 引擎不反向 import 它；由 game-api 在模块求值时用 setSharedCapsProbe 把取器注册进来。
 * @type {Object<string, Function>}
 */
const sharedCapsProbes = {};

/**
 * 注册一个共享区段能力取器（供 CAPS 间接调用）。
 * @param {string} key 能力键名（与 CAPS 同名）
 * @param {Function} fn 返回在场对象的只读取器
 */
export function setSharedCapsProbe(key, fn) {
  if (key && typeof fn === 'function') sharedCapsProbes[key] = fn;
}

function sharedCapsProbe(key) {
  var f = sharedCapsProbes[key];
  return f ? f() : null;
}

// ─────────────────────── 共享能力对象插槽 ───────────────────────

/**
 * 共享能力对象插槽（l10n/gameData/gameConf/bits 等）：这些对象住在 game-api 共享区段，
 * 下沉到 feats 的活动 api.js 需要它们但不能反向 import game-api（避免 core⇄feats 循环），
 * 故由 game-api 在模块求值尾部 registerSharedValue 注册取器，活动侧运行期经 sharedValue 现取。
 * 调用时机均在全部模块求值完毕之后（方法体内），不存在 TDZ 风险。
 * @type {Object<string, Function>}
 */
const sharedValues = {};

/**
 * 注册一个共享能力对象取器（幂等，重复注册覆盖）。
 * @param {string} name 插槽名（如 'gameData'）
 * @param {Function} getter 返回该对象的只读取器
 */
export function registerSharedValue(name, getter) {
  if (name && typeof getter === 'function') sharedValues[name] = getter;
}

/**
 * 现取一个共享能力对象；槽位未注册返回 null（调用方保守降级，不得抛错）。
 * @param {string} name 插槽名
 * @returns {*} 对象本体；无槽/取器抛错回 null
 */
export function sharedValue(name) {
  var f = sharedValues[name];
  if (!f) return null;
  try {
    return f() || null;
  } catch (e) {
    return null;
  }
}

/**
 * ACL 原语束工厂：各 feat 的 api.js 用它取用同一份引擎单例（SYM/probe 缓存全工程共享，不复制状态）。
 * @param {string} tag 日志器标签（如 'SECRETAPI'），日志行仍带 [POCKETCC://<tag>] 来源
 * @returns {{log: *, probe: Function, SYM: Object<string,*>, ns: Function, userData: Function, registerCaps: Function, registerWorldSlot: Function, sharedValue: Function, CAPS: Object<string, function():boolean>, checkCap: Function}}
 */
export function createAcl(tag) {
  return {
    log: createLog(tag),
    probe,
    SYM,
    ns,
    userData,
    registerCaps,
    registerWorldSlot,
    sharedValue,
    CAPS,
    checkCap,
  };
}
