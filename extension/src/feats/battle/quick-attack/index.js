/**
 * 快捷攻击（reactor 说明书形态）
 *
 * 世界地图打开目标面板时，用键盘快捷键对面板目标发起行军（902 MARCH_WORLD_POINT）：
 *   [1]-[8]      以对应预设编队单次攻击；
 *   Shift+[1]-[8] 三连：第 1 发该预设，随后 2 发最小出征（Battle.plan().minimal()），次间固定间隔 TRIPLE_INTERVAL_MS。
 *
 * 目标区/坐标来自「方案2」：拦截面板 prototype.onShow，游戏原逻辑填好目标数据后我们读它拷成纯标量存进
 * activePanel（默认读 this[spec.field] 的 tileX/tileY；坐标形状不同时由 spec.read 接管，如遗迹面板只有
 * _siteData.X/Y）。面板消失（prototype.onDisable）即清空 activePanel 并摘键盘监听。
 *
 * 监听生命周期（机制B）：键盘事件只能挂 document（cc.Node 收不到 DOM keydown），故
 *   onShow（面板出现）→ 覆盖式挂 document keydown；onDisable（面板消失）→ 摘除。一次只展示一个面板，
 *   activePanel 单引用即可；onKeyDown 再复查 comp.isValid && node.activeInHierarchy 兜底防漏触发误发。
 *
 * 依赖游戏运行时只「读 + 发包」，不调任何 Update/Delete 改写类方法（遵守 feat 只读+发包约束）。
 * 部分场景带面板态前置闸（spec.gate，按键瞬间只读复查）：游戏自己会拦的（如夺宝飞船「今日次数已用完」）
 * 不白发包，命中即一行 info 收摊，不发 902。
 * 门控（B 档，可行性报告 §7.2）：places:['world']（NWorldMap 场景）+ kinds:['homeland','wushuang','kvk']——跨服战场图里
 * 照样要打（marchApi.resolve 已按战场换算 marchType），秘境由 world 门的 kind===pab 隔离自动拦、征服者球体/盟决不在场。
 * 属「战斗设置」：快捷战斗只在目标面板开着时按快捷键才发一波，是战斗时的手动辅助，
 * 故不声明 offInCombat（与日常行军自动化相反：战斗模式下仍照常生效）。挂钩对称可还原，功能停用即摘净。
 *
 * marchType 跨服漂移（无双峡谷等跨服战场实测）：注册表里存的是「本服基础值」，发包前经
 * core/game-api.js 的 march.resolve() 按当前战场换算（游戏原生 WorldUtils.dealMarchTypeWithSpecialMarch
 * 优先，符号漂移时降级本地兜底表 MARCH_FALLBACK）——跨服服下直接拿 13 打玩家城会被服务器拒。
 */
import { sleep } from '../../../core/util.js';
import { createLog } from '../../../core/log.js';
import { game } from '../../../core/game.js';
import { march as marchApi, gameConf, gameData } from '../../../core/game-api.js';
import { reactor } from '../../../core/reactor.js';
import { isTypingTarget } from '../../../core/hotkeys.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';

import { CMD_MARCH_WORLD_POINT } from './constants.js';

/**
 * 可攻击面板注册表（可扩展的唯一入口）：新增一个可攻击面板 = 往此数组追加一条 spec，
 * 快捷键分派 / 面板 onShow-onDisable 钩子 / 发包 / 三连逻辑全部零改动。
 * spec: { key 场景标识, label 日志展示, cls 面板类（game.get(cls).default）,
 *         field onShow 后 tileInfo 落在组件上的字段名,
 *         marchTypes.attack 本服基础 NMarchType（发包前由 marchApi.resolve 做跨服漂移换算）,
 *         marchTypes.attackV2 / .treasure / .alliance 可选：同面板其它实体（按 tileInfo.type 分流，见 pickBranch）
 *           的行军类型兜底值（世界 BOSS 面板一 class 多吃：BOSS_V2→attackV2、宝藏守卫→treasure、联盟机甲→alliance）,
 *         marchMembers 可选：行军类型以游戏 MarchType 枚举成员名为权威源（marchApi.typeOf 运行时取名，
 *           成员名收在 core/game-api.js SYM.marchEnum），marchTypes 数值仅作符号漂移兜底,
 *         gate 可选：按键瞬间的面板态前置闸 (comp)=>string|null，返回串=拒绝原因（不发 902）、null=放行,
 *         read 可选：目标适配器 (comp)=>{x,y,siteId?,serverId?,entityType?}|null——面板把坐标存在非 tileInfo
 *           形状时由它接管（见 readSiteTarget：遗迹面板只有 _siteData.X/Y）；缺省读 field 指向的 tileX/tileY };
 * NMarchType 见 WorldMapCommon 的 MarchType 枚举。
 * @type {Array<{key:string, label:string, cls:string, field:string, marchTypes:{attack:number, attackV2?:number, treasure?:number, alliance?:number}, marchMembers?:{attack:string, attackV2?:string, treasure?:string, alliance?:string}, gate?:function(object):(string|null), read?:function(object):(object|null)}>}
 */
const QUICK_ATTACK_TARGETS = [
  {
    key: 'city',
    label: '城市',
    cls: 'NWorldCityPopup',
    field: 'tileInfo',
    marchTypes: { attack: 13 },
  }, // ATTACK_PLAYER（跨服战场经 resolve 漂移到 150/170/110/181）
  {
    key: 'monster',
    label: '野怪',
    cls: 'NWorldMapEnemy',
    field: 'tileInfo',
    marchTypes: { attack: 5 },
  }, // ATTACK_MONSTER
  {
    key: 'nMonster',
    label: '新野怪',
    cls: 'NWorldMapNEnemy',
    field: '_tileInfo',
    marchTypes: { attack: 5 },
  }, // ATTACK_MONSTER
  {
    key: 'mine',
    label: '矿点',
    cls: 'NWorldResourcePopup',
    field: 'tileInfo',
    marchTypes: { attack: 3 },
  }, // GATHER_RESOURCE 位
  // 世界 BOSS 面板（一 class 吃四实体，按 tileInfo.type 分流，口径同游戏 WorldBossDetailPanel._onClickAttackBtn）：
  //   普通 Boss(11)=ATTACK_WORLDBOSS(14)；BOSS_V2 实体(298)=ATTACK_WORLD_BOSS_V2(298)；宝藏守卫（高级/低级，
  //   实体 TREASURE_MAP_WORLD_BOSS=32）=ATTACK_TREASURE_MAP_WORLD_BOSS(36)；联盟机甲（老版，实体 ALLIANCE_BOSS=17）
  //   =ALLIANCE_BOSS(18)。行军类型走游戏枚举成员名；18/298/36 均不参与跨服漂移（dealMarchTypeWithSpecialMarch
  //   只改写 ATTACK_PLAYER/THRONE/WORLD_SITE）。V3 机甲是另一套实体与面板（NWorldMapAllianceBossV3），不会命中本钩子。
  {
    key: 'boss',
    label: '世界BOSS/守卫/机甲',
    cls: 'WorldBossDetailPanel',
    field: 'tileInfo',
    marchTypes: { attack: 14, attackV2: 298, treasure: 36, alliance: 18 },
    marchMembers: {
      attack: 'attackWorldBoss',
      attackV2: 'attackWorldBossV2',
      treasure: 'attackTreasureMapWorldBoss',
      alliance: 'allianceBoss',
    },
    gate: bossGate,
  },
  // 夺宝飞船（截图中「XX小队的夺宝团」弹窗）：点世界地图 pointType=133 的点打开
  // NWorldMapCrossTreasure（NWorldMapTileClickUtils.clickCrossTreasure），「拦截」按钮走
  // BattleType.CROSS_TREASURE_ATTACK_TREASURE → 902 marchType=138 CS_ATTACK_TREASURE（实录实证：
  // 应答 target.targetType=133、body 与其余场景同形，无额外字段）。坐标取 onShow 填好的 _tileInfo.tileX/tileY。
  {
    key: 'csShip',
    label: '夺宝飞船',
    cls: 'NWorldMapCrossTreasure',
    field: '_tileInfo',
    marchTypes: { attack: 138 },
    marchMembers: { attack: 'csAttackTreasure' },
    gate: csShipGate,
  },
  // 王者遗迹（截图中「王者遗迹—守卫（西）」）：点世界地图遗迹点走 NWorldMapTileClickUtils.clickWorldSite，
  // 开 UIDataInfo.WorldSitePanel（prefab WorldSitePanelNew，组件类即 WorldSitePanelV4；bundle __subpack）。
  // 目标坐标不在 tileInfo 而在面板自己按 siteId 取回的 _siteData（X/Y，故需 read 适配器）；单人攻击链
  // onAttackClick → canAttackFortress → GameTools.WorldSiteMarch → CommonTools.sureSendWorldSiteMarch → 902
  // marchType=WORLD_SITE(17)，遗迹战时由游戏漂到 CONQUEROR_ATTACK(103)（故 resolve 要拿 siteId）。
  // 同一个面板按归属是两个动作：别盟/无主→攻打（onAttackClick），己盟占领→增援（onReinforceFight /
  // btnReinForce 进的详情面板），两者最终都调 WorldSiteMarch(siteData) → 同一包，差异由 siteGate 分闸承担。
  // relicRuleVersion!==1 的新规则遗迹走 WorldRuinedbuildPanel（bundle activity/ActivityRuined，未逆向），本钩子不命中。
  {
    key: 'site',
    label: '王者遗迹',
    cls: 'WorldSitePanelV4',
    field: '_siteData',
    marchTypes: { attack: 17 },
    marchMembers: { attack: 'worldSite' },
    read: readSiteTarget,
    gate: siteGate,
  },
  // 同一系列的「遗迹出兵详情」弹窗（WorldSiteDetailPanel.ViewType=1，由 V4 面板的 onCollect/onReinforce 调
  // ShowWorldSiteView(PointId) 开）：onFightClick 同样走 GameTools.WorldSiteMarch(this.SiteData) → 902 WORLD_SITE。
  // 该 class 还被王座(2)/盟军怪(3)/塔(4)/边境(11) 等其它 ViewType 复用（攻击函数各异，如 ThroneAttack），
  // 故由 read 把非遗迹视图挡在门外（面板复用/对象池下 SiteData 可能是上一份残留，不能只靠它判型）。
  {
    key: 'siteDetail',
    label: '遗迹出兵详情',
    cls: 'WorldSiteDetailPanel',
    field: 'SiteData',
    marchTypes: { attack: 17 },
    marchMembers: { attack: 'worldSite' },
    read: readSiteDetailTarget,
    gate: siteGate,
  },
];

/**
 * DATACONFIG 配置号：每日可拦截夺宝飞船的次数上限（源码实证 NWorldMapCrossTreasure.onBtnClickAttck：
 * `Number(getDataConfigData(290022)) - pointInfo.fightNum <= 0` → tips cs_treasure266，游戏自己不发）。
 * 取不到配置按 0（不设次数闸，交由服务器拒）。
 * @type {number}
 */
const CFG_CS_SHIP_ATTACK_LIMIT = 290022;

/**
 * DATACONFIG 配置号：每日可领取藏宝守卫（宝藏 BOSS）排名奖励的参战次数上限。源码实证
 * WorldBossDetailPanel.onClickAttackBtn：`_tAttackCount >= getDataConfigData(130168)` 且
 * `UserData.ConfirmAttackTreasure` 仍为真时游戏弹二次确认（treasure_guild_0001=继续攻击将无法获得排名奖励）。
 * 取不到配置按 0（不设闸，交由服务器拒）。
 * @type {number}
 */
const CFG_TREASURE_BOSS_REWARD_LIMIT = 130168;

/**
 * DATACONFIG 配置号：入盟后多久才能攻打联盟机甲（与 JoinTime/ServerTime 同单位，这里原样复刻游戏的
 * 比较式，不假设单位）。源码实证 WorldBossDetailPanel._onClickAttackBtn：`JoinTime + 25009 > ServerTime`
 * 时游戏只弹 allianceMachine038。取不到配置按 0（不设闸）。
 * @type {number}
 */
const CFG_ALLIANCE_JOIN_LIMIT = 25009;

/**
 * DATACONFIG 配置号：打别人联盟机甲时的每日协助次数上限（源码实证同处：`UserData.AlBossHelpCount >= 25014`
 * 时游戏弹 allianceMachine072）。取不到配置按 0（不设闸）。
 * @type {number}
 */
const CFG_ALLIANCE_HELP_LIMIT = 25014;

/**
 * 世界 BOSS 面板前置闸（只读）：按地块实体类型分派，普通/二期世界 BOSS 无闸。
 * 宝藏守卫见 treasureBossGate，联盟机甲见 allianceBossGate。符号缺失时两闸均按放行，交服务器裁决。
 * @param {object} comp WorldBossDetailPanel 组件实例
 * @returns {string|null} 拒绝原因；null=可发
 */
function bossGate(comp) {
  var tile = comp.tileInfo;
  if (!tile) return null;
  if (marchApi.isTreasureBoss(tile.type)) return treasureBossGate(comp);
  if (marchApi.isAllianceBoss(tile.type)) return allianceBossGate(comp);
  return null;
}

/**
 * 宝藏守卫前置闸：只对宝藏守卫生效——今日参战次数已达排名奖励上限、且用户本次登录还没在
 * 面板上点过「继续攻击」（游戏侧 ConfirmAttackTreasure 仍为真，点一下就会被弹确认框）时不代发这个决定，
 * 一行 info 收摊；用户已确认过（该位被游戏置 false）则照发。
 * 面板自己的 _tAttackCount 来自 GET_JION_ALL_RCTIME 应答，未落地时为 undefined（按 0 放行）。
 * @param {object} comp WorldBossDetailPanel 组件实例
 * @returns {string|null} 拒绝原因；null=可发
 */
function treasureBossGate(comp) {
  var limit = Number(gameConf.dataConfig(CFG_TREASURE_BOSS_REWARD_LIMIT)) || 0;
  if (!limit) return null;
  var used = comp._tAttackCount | 0;
  if (used < limit) return null;
  var ud = (dataCenter && dataCenter.UserData) || null;
  // 游戏把「已确认继续」存在 UserData.ConfirmAttackTreasure（默认 true，确认后置 false）；取不到 UserData
  // 时按已确认处理（宁可多发一波，也不因符号漂移把功能按死）。
  if (ud && ud.ConfirmAttackTreasure === true) {
    return 'treasure-reward-cap ' + used + '/' + limit;
  }
  return null;
}

/**
 * 联盟机甲（老版）前置闸：逐条复刻游戏 _onClickAttackBtn 的自拦与面板按钮绘制条件。
 *   1) 不在盟（游戏弹 allianceMachine079）；
 *   2) 入盟时长不足 CFG_ALLIANCE_JOIN_LIMIT（游戏弹 allianceMachine038）；
 *   3) 打别人机甲时：游戏只在「战斗期 abState=1 且已开放协助 help=1」才绘出攻击按钮，否则按钮根本不显示；
 *      协助口径下再查今日已协助次数 CFG_ALLIANCE_HELP_LIMIT（游戏弹 allianceMachine072）；
 *   4) 攻击 CD：onShow 先把 _attackCDEndTime 置 -1 再问 ALLIANCE_BOSS_CD，应答带 time 才回填——停在 -1
 *      意味着 CD 未知（游戏此时点攻击按钮无任何反应），这里同样不发；_attackCDEndTime > ServerTime 是游戏
 *      把按钮置灰的冷却期（cdLabel 显示 allianceMachine015）。体力不足（MONSTER_GROUP.cost_energy）不预校，
 *      与其余场景一致，游戏会弹 BuyEnergyPanel、服务器会拒。
 * 各闸只在对应符号/配置取得到时生效，读不到就放行（宁多发一个被拒的包，不因符号漂移把功能按死）。
 * @param {object} comp WorldBossDetailPanel 组件实例
 * @returns {string|null} 拒绝原因；null=可发
 */
function allianceBossGate(comp) {
  var ud = (dataCenter && dataCenter.UserData) || null;
  var al = ud && ud.Alliance;
  if (!al || typeof al.isInAlliance !== 'function') return null;
  var inAlliance;
  try {
    inAlliance = !!al.isInAlliance();
  } catch (e) {
    return null; // 判定器不可用：交服务器
  }
  if (!inAlliance) return 'not-in-alliance';
  var now = (+dataCenter.ServerTime || 0) | 0;
  var joinLimit = parseInt(String(gameConf.dataConfig(CFG_ALLIANCE_JOIN_LIMIT)), 10) || 0;
  var joinTime = Number(al.JoinTime) || 0;
  if (joinLimit && joinTime && now && joinTime + joinLimit > now) {
    return 'join-cd ' + (joinTime + joinLimit - now) + 's';
  }
  var ext = (comp.tileInfo && comp.tileInfo.extData) || null;
  if (ext && String(ext.allianceId) !== String(al.Aid)) {
    // 别人的机甲：abState 非战斗期或未开放协助时游戏连攻击按钮都不绘出
    var abState = Number(ext.abState);
    var help = Number(ext.help);
    if (!(abState === 1 && help === 1))
      return 'not-attackable abState=' + ext.abState + ';help=' + ext.help;
    var helpLimit = parseInt(String(gameConf.dataConfig(CFG_ALLIANCE_HELP_LIMIT)), 10) || 0;
    var helped = Number(ud.AlBossHelpCount) | 0;
    if (helpLimit && helped >= helpLimit) return 'help-limit ' + helped + '/' + helpLimit;
  }
  var cd = Number(comp._attackCDEndTime);
  if (cd === -1) return 'cd-unknown';
  if (cd > 0 && now && cd - now > 0) return 'in-cd ' + (cd - now) + 's';
  return null;
}

/**
 * 夺宝飞船面板前置闸：逐条复刻游戏 onBtnClickAttck 的三道只读判定，命中即回拒绝原因串、放行回 null。
 * 数据源是面板自己的 7571 CROSS_TREASURE_POINT_INFO 应答（_crossTreasurePointInfo），本函数不发包；
 * 应答尚未落地（面板刚打开）时一律放行——无从判定交给服务器，宁多打一个被拒的包也不误拦能打的目标。
 * @param {object} comp NWorldMapCrossTreasure 组件实例
 * @returns {string|null} 拒绝原因；null=可发
 */
function csShipGate(comp) {
  var info = comp._crossTreasurePointInfo;
  if (!info) return null;
  // 黑名单（游戏弹 cs_treasure489）：实录里服务器多数时候不下发该键，undefined 即假
  if (info.inBlackList) return 'inBlackList';
  // 归属闸：只有 pointSid==本人 ServerId（本服队伍派出的飞船）游戏才绘出「拦截」按钮
  var ud = (dataCenter && dataCenter.UserData) || null;
  var mine = ud && ud.ServerId;
  if (mine != null && info.pointSid != null && Number(info.pointSid) !== Number(mine)) {
    return 'notMyServer pointSid=' + info.pointSid + ';mine=' + mine;
  }
  // 每日次数：fightNum 为今日已拦截次数
  var limit = Number(gameConf.dataConfig(CFG_CS_SHIP_ATTACK_LIMIT)) || 0;
  if (limit && (info.fightNum | 0) >= limit) {
    return 'daily-limit ' + (info.fightNum | 0) + '/' + limit;
  }
  return null;
}

/**
 * DATACONFIG 配置号：各等级遗迹的「本盟拥有数上限」（竖线分隔，段内第二项）。源码实证
 * WorldSitePanelV4.canAttackFortress：取不到配置时默认 2；当前等级拥有数等于该上限时游戏弹
 * server_schedule_tips_022（拥有当前等级遗迹达到上限，继续占领也不会获得此遗迹）并不发 902。
 * @type {number}
 */
const CFG_SITE_OWNED_LIMIT = 133610;

/**
 * WorldSiteState 数值（GameDefine 枚举：CLOSE=0、FIGHT=1、PEACE=2）。与 radar-task 的 STAMINA_TYPE 同类：
 * 只为面板态闸取值，不为其单独扩一层符号；漂移时闸失效放行（交服务器），不影响发包。
 * @type {number}
 */
const WORLD_SITE_STATE_FIGHT = 1;
/** @type {number} 同上：和平态（未开放攻打，游戏弹 wonder_041） */
const WORLD_SITE_STATE_PEACE = 2;

/** @type {string} FunctionKey 值串：遗迹之战玩法开关（增援按钮绘制条件之一，同游戏 isNewSiteOpen） */
const FUNC_KEY_BATTLE_OF_RELICS = 'Battle_of_relics';

/**
 * 遗迹面板目标读取（read 适配器）：坐标不在 tileInfo.tileX/tileY，而在面板 onShow 里用
 * `UserData.getWorldSitgeById(siteId, serverId)` 取回的 _siteData（字段名 X/Y，大写）；老版面板同名
 * 数据挂在 SiteData（大写 S），一并兼容。siteId 取 PointId（游戏 sureSendWorldSiteMarch 同口径），
 * 它是遗迹 marchType 17→103 漂移的唯一入参。
 * @param {object} comp WorldSitePanelV4 组件实例
 * @returns {object|null} {x,y,serverId,siteId}；数据未落地返回 null（面板不登记，快捷键自然失效）
 */
function readSiteTarget(comp) {
  var site = comp._siteData || comp.SiteData;
  if (!site || site.X == null || site.Y == null) return null;
  var init = comp._initParams || null;
  return {
    x: site.X | 0,
    y: site.Y | 0,
    serverId: (init && init.serverId) || undefined,
    siteId: site.PointId != null ? site.PointId : init && init.siteId,
  };
}

/** @type {number} WorldSiteDetailPanel 的「遗迹」视图位（onShow 第一参：1=遗迹、2/9=王座、3=盟军怪、4=塔、11=边境） */
const SITE_DETAIL_VIEW_TYPE = 1;

/**
 * 遗迹出兵详情面板的目标读取：只在 ViewType=1（遗迹）时把 SiteData 交给 readSiteTarget。
 * 同一个 class 还吃王座/塔等多个视图且攻击函数不同，而面板复用/对象池下 SiteData 可能沿用上一份，
 * 故不能只靠数据字段判型；其余视图返回 null 即不登记面板，快捷键自然让位。
 * @param {object} comp WorldSiteDetailPanel 组件实例
 * @returns {object|null} {x,y,siteId,...}；非遗迹视图或数据未落地返回 null
 */
function readSiteDetailTarget(comp) {
  if ((comp._ViewType | 0) !== SITE_DETAIL_VIEW_TYPE) return null;
  return readSiteTarget(comp);
}

/**
 * 遗迹面板前置闸（按归属分派，口径同游戏自己的按钮绘制）：同一个面板在两种归属下是两个动作——
 *   己盟占领 → 增援（btnReinForce，只校在盟 + 按钮可见条件）；
 *   其它（别盟占领/无主）→ 攻打（btnAttack，逐条复刻 canAttackFortress）。
 * 两路发包完全相同（WorldSiteMarch(siteData) → 902 marchType=17，服务器按归属自行判是增援还是攻打），
 * 差异只在“游戏自己会不会拦 / 会不会绘出这个按钮”，故只需分闸、不需分行军类型分支。
 * @param {object} comp WorldSitePanelV4 / WorldSiteDetailPanel（ViewType=1）组件实例
 * @returns {string|null} 拒绝原因；null=可发
 */
function siteGate(comp) {
  var site = comp._siteData || comp.SiteData;
  if (!site) return 'no-site-data';
  var ud = (dataCenter && dataCenter.UserData) || null;
  var al = ud && ud.Alliance;
  if (!al || typeof al.isInAlliance !== 'function') return null;
  var inAlliance;
  try {
    inAlliance = !!al.isInAlliance();
  } catch (e) {
    return null; // 判定器不可用：交服务器
  }
  if (!inAlliance) return 'not-in-alliance';
  // updateView：btnReinForce.active 仅在 Owner.Aid===本盟 Aid 时置 true，otherNodes（侦查/集结/攻打）只在异或时绘出
  var mine = !!site.Owner && String(site.Owner.Aid) === String(al.Aid);
  return mine ? siteReinforceGate(site) : siteAttackGate(site, ud, al);
}

/**
 * 增援闸（己盟占领的遗迹）：游戏在 onReinforceClick 里只校在盟（wonder_037），再加按钮绘制条件
 * `isNewSiteOpen() || State===FIGHT`。功能位走 functionOnValue 三态：读不到（null）按放行，
 * 只有明确未开且不在战斗态（那时游戏根本不绘增援按钮）才拦。
 * @param {object} site 遗迹数据
 * @returns {string|null} 拒绝原因；null=可发
 */
function siteReinforceGate(site) {
  var open = gameData.functionOnValue(FUNC_KEY_BATTLE_OF_RELICS);
  if (open === false && site.State !== WORLD_SITE_STATE_FIGHT) return 'relics-off-not-fight';
  return null;
}

/**
 * 攻打闸（别盟占领/无主的遗迹）：逐条复刻游戏 canAttackFortress（体力与护盾确认不预校，口径同其余场景）。
 *   1) 遗迹处于和平态且非本盟占领 → wonder_041；
 *   2) 本盟在该 stronghold_level 上已拥有 CFG_SITE_OWNED_LIMIT 个遗迹 → server_schedule_tips_022
 *      （该闸只对攻打量存在：给自己遗迹增援不经 canAttackFortress，误用会把满级占领的盟完全面板锁死）。
 * 各闸只在对应配置/等级取得到时生效，读不到就放行（宁多发一个被拒的包，不因符号漂移把功能按死）。
 * @param {object} site 遗迹数据
 * @param {object} ud UserData
 * @param {object} al 本盟数据
 * @returns {string|null} 拒绝原因；null=可发
 */
function siteAttackGate(site, ud, al) {
  if (
    site.State === WORLD_SITE_STATE_PEACE &&
    site.Owner &&
    String(site.Owner.Aid) !== String(al.Aid)
  ) {
    return 'peace-not-ours';
  }
  var level = (site.DistrictData && site.DistrictData.stronghold_level) | 0;
  var getNum =
    typeof ud.getWorldSiteNumOwnedByLevel === 'function' ? ud.getWorldSiteNumOwnedByLevel : null;
  if (!level || !getNum) return null;
  // 段内第二项=该等级上限（游戏缺省 2）；配置或拥有数读不到时不设闸
  var limit = 2;
  var seg = String(gameConf.dataConfig(CFG_SITE_OWNED_LIMIT) || '').split('|')[level - 1];
  var parts = seg ? seg.split(',') : null;
  if (parts && parts.length > 1) limit = parseInt(parts[1], 10) || limit;
  var owned;
  try {
    owned = getNum.call(ud, al.Aid, level);
  } catch (e) {
    return null;
  }
  if (owned != null && owned === limit) return 'owned-cap L' + level + '/' + owned;
  return null;
}

/**
 * marchType 兜底数值表：只在游戏枚举/判定器符号漂移时兜底（主路径向游戏运行时取名值）。
 * 数值出处：WorldMapCommon.MarchType + WorldUtils.dealMarchTypeWithSpecialMarch 优先级链 AVA→TM→MASTER→TEAM_LEGEND。
 * @type {{attackPlayer:number, tm:number, master:number, ava:number, teamLegend:number, worldSite:number}}
 */
const MARCH_FALLBACK = {
  attackPlayer: 13,
  tm: 150,
  master: 170,
  ava: 110,
  teamLegend: 181,
  worldSite: 17,
};

/** @type {number} 三连次间间隔（毫秒，内置常量，不在面板配置） */
const TRIPLE_INTERVAL_MS = 1000;

/**
 * 生成模块 cfg：全部为内置常量——各场景默认启用、行军类型取自注册表，三连间隔用 TRIPLE_INTERVAL_MS。
 * 不从面板读取（面板只出 enabled 一个开关）。
 * @returns {object} { tripleIntervalMs, targets: { <key>: { enabled, marchTypes } } }
 */
function buildModuleCfg() {
  var targets = {};
  QUICK_ATTACK_TARGETS.forEach(function (spec) {
    targets[spec.key] = { enabled: true, marchTypes: Object.assign({}, spec.marchTypes) };
  });
  return { tripleIntervalMs: TRIPLE_INTERVAL_MS, targets: targets };
}

/** @type {ReturnType<createLog>} 模块日志器（tag=QUICK_ATTACK） */
const log = createLog('QUICK_ATTACK');

/** @type {object|null} 网络底座（install 时取） */
var net;
/** @type {object|null} DataCenter.DATA（install 依赖符；夺宝飞船归属闸读 UserData.ServerId） */
var dataCenter;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让在飞三连自然中断 */
var ctxRef = null;

/**
 * 模块内部配置：{ tripleIntervalMs:number, targets:{ <key>:{ enabled:boolean, marchTypes:{ attack:number } } } }
 * 初值即内置常量（见本文件 buildModuleCfg）；面板只出启用开关，不覆盖这些值。
 * @type {object}
 */
var cfg = buildModuleCfg();

/** @type {Object<string,object|null>} spec.cls -> 解析到的面板类（install 时填充；解析失败为 null，跳过该场景不阻断其它） */
var classOf = {};

/** @type {Map<string,Array<function():void>>} spec.cls -> 该面板当前已挂的还原函数数组（onShow/onDisable）；非空即已 hook */
var hooks = new Map();

/** @type {{spec:object, comp:object, target:object}|null} 当前在场面板；一次只展示一个，故单引用 */
var activePanel = null;

/** @type {boolean} document keydown 是否已挂（attachKey/detachKey 维护，保证全局最多一个） */
var keyListening = false;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（在飞流程的 await 回来后的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// ── 键盘监听挂/摘 ──────────────────────────────────────────────────────
/**
 * 挂 document keydown 捕获监听（幂等：已挂则直接返回）
 */
function attachKey() {
  if (keyListening) return;
  document.addEventListener('keydown', onKeyDown, true);
  keyListening = true;
}

/**
 * 摘 document keydown 监听（幂等）
 */
function detachKey() {
  if (!keyListening) return;
  document.removeEventListener('keydown', onKeyDown, true);
  keyListening = false;
}

// ── 面板 onShow / onDisable 包装（拦在面板自己身上）─────────────────────
/**
 * 面板出现：让游戏原 onShow 先跑（填好 tileInfo / _siteData），再把目标登记进 activePanel 并挂 keydown。
 * 覆盖式：先摘上一个（一次只展示一个面板，新面板直接替换旧的）。
 * @param {object} spec 场景定义
 * @param {object} comp 面板组件实例（this）
 */
function onPanelShow(spec, comp) {
  if (!aliveFn()) return;
  var t = cfg.targets[spec.key];
  if (!t || !t.enabled) return;

  // 默认适配器读 tileInfo.tileX/tileY；遗迹这类坐标不在地块信息上的面板由 spec.read 接管
  var target = spec.read ? spec.read(comp) : readTileTarget(comp[spec.field]);
  if (!target || target.x == null || target.y == null) {
    log.debug('panel shown without tile coords, skip. key=%s', spec.key);
    return;
  }

  detachKey();
  activePanel = { spec: spec, comp: comp, target: target };
  attachKey();
  log.debug('panel active. key=%s;x=%d;y=%d', spec.key, activePanel.target.x, activePanel.target.y);
}

/**
 * 默认目标适配器：从 onShow 已填好的地块信息（tileInfo/_tileInfo）拷出纯标量目标。
 * entityType 一并带上，供同面板多实体分流（见 pickBranch）。
 * @param {object} tile 面板上的地块信息对象
 * @returns {object|null} {x,y,serverId,subMap,entityType}；坐标缺失返回 null
 */
function readTileTarget(tile) {
  if (!tile || tile.tileX == null || tile.tileY == null) return null;
  return {
    x: tile.tileX | 0,
    y: tile.tileY | 0,
    serverId: tile.serverId,
    subMap: tile.subMap,
    // 地块实体类型原值（boss 场景靠它区分普通/BOSS_V2/宝藏守卫/联盟机甲）
    entityType: tile.type,
  };
}

/**
 * 面板消失：若消失的正是当前 activePanel 的面板，清空并摘 keydown。
 * @param {object} comp 面板组件实例（this）
 */
function onPanelDisable(comp) {
  if (activePanel && activePanel.comp === comp) {
    detachKey();
    activePanel = null;
  }
}

/**
 * 用一个原型方法包装：实例属性遮蔽原型，仅当最外层还是自己时才还原。
 * @param {object} proto 目标 prototype
 * @param {string} name 方法名 onShow/onDisable
 * @param {function(...):void} after 原方法执行完后回调（收 this 与实参数组）
 * @returns {function} 还原函数
 */
function wrapProto(proto, name, after) {
  var hadOwn = Object.prototype.hasOwnProperty.call(proto, name);
  var orig = hadOwn ? proto[name] : typeof proto[name] === 'function' ? proto[name] : null;
  var wrapper = function () {
    var ret;
    if (orig) ret = orig.apply(this, arguments);
    try {
      after(this, arguments);
    } catch (err) {
      log.warn('%s wrapper threw.', name, err);
    }
    return ret;
  };
  proto[name] = wrapper;
  return function () {
    if (proto[name] === wrapper) {
      if (hadOwn) proto[name] = orig;
      else delete proto[name];
    }
  };
}

/**
 * 挂一个场景的面板钩子（幂等：已 hook 的 cls 跳过）。
 * @param {object} spec 场景定义
 */
function hookSpec(spec) {
  if (hooks.has(spec.cls)) return;
  var Klass = classOf[spec.cls];
  if (!Klass || !Klass.prototype) {
    log.warn('panel class unavailable, skip hook. cls=%s', spec.cls);
    return;
  }
  var proto = Klass.prototype;
  var restores = [
    wrapProto(proto, 'onShow', function (self) {
      onPanelShow(spec, self);
    }),
    wrapProto(proto, 'onDisable', function (self) {
      onPanelDisable(self);
    }),
  ];
  hooks.set(spec.cls, restores);
}

/**
 * 摘掉全部面板钩子 + 键盘监听 + activePanel（功能停用时）。
 */
function unhookAll() {
  hooks.forEach(function (restores) {
    restores.forEach(function (r) {
      r();
    });
  });
  hooks.clear();
  detachKey();
  activePanel = null;
}

// ── 键盘分派 ───────────────────────────────────────────────────────────
/**
 * 解析按键 → { digit:1..8|null, triple:boolean }。以 event.code 为主（与 Shift 无关，最稳），
 * event.key 数字/符号兜底。ctrl/alt/meta 组合、以及「正在输入框打字」（core/hotkeys isTypingTarget，
 * 已穿透 Shadow DOM 取真实焦点元素）一律忽略，热键让位给打字。
 * @param {KeyboardEvent} e
 * @returns {{digit:number|null, triple:boolean}}
 */
function readHotkey(e) {
  if (isTypingTarget(e)) return { digit: null, triple: false };
  if (e.ctrlKey || e.altKey || e.metaKey) return { digit: null, triple: false };

  var digit = 0;
  var m = typeof e.code === 'string' && /^Digit([1-8])$/.exec(e.code);
  if (m) {
    digit = parseInt(m[1], 10);
  } else {
    var k = e.key;
    if (k >= '1' && k <= '8') digit = k.charCodeAt(0) - 48;
    else {
      var symbols = { '!': 1, '@': 2, '#': 3, $: 4, '%': 5, '^': 6, '&': 7, '*': 8 };
      if (symbols[k]) digit = symbols[k];
    }
  }
  return { digit: digit || null, triple: !!e.shiftKey };
}

/**
 * keydown 分派：校验在场面板 -> 解热键 -> 组装单次/三连计划 -> 交给 attackFlow。
 * @param {KeyboardEvent} e 键盘事件
 */
function onKeyDown(e) {
  if (!aliveFn() || !activePanel) return;

  // 兜底：onDisable 漏触发时（切场景/对象池复用未 destroy），面板实际已不在场则直接放弃并收摊
  var comp = activePanel.comp;
  var node = comp && comp.node;
  if (!comp || comp.isValid === false || (node && node.activeInHierarchy === false)) {
    detachKey();
    activePanel = null;
    return;
  }

  var hk = readHotkey(e);
  if (!hk.digit) return;

  var spec = activePanel.spec;
  var target = activePanel.target;
  var t = cfg.targets[spec.key];
  if (!t || !t.enabled) return;

  e.preventDefault();
  e.stopPropagation();

  // 面板态前置闸（可选 spec.gate）：游戏自己就会拦的场景（次数用完/黑名单/非本服飞船）不白发 902。
  // 闸内只读面板已有数据，抛错时按放行处理（宁被服务器拒也不因判据异常而静默失灵）。
  if (spec.gate) {
    var why = null;
    try {
      why = spec.gate(comp);
    } catch (err) {
      log.warn('panel gate threw, send anyway. key=%s', spec.key, err);
    }
    if (why) {
      log.info(
        'attack blocked by panel gate. key=%s;reason=%s;x=%d;y=%d',
        spec.key,
        why,
        target.x,
        target.y,
      );
      return;
    }
  }

  var planList = [{ kind: 'preset', index: hk.digit }];
  if (hk.triple) {
    planList.push({ kind: 'minimal' }, { kind: 'minimal' });
  }

  attackFlow(spec, target, planList).catch(function (err) {
    log.warn('attack flow threw!', err);
  });
}

/**
 * 一串行军流程：串行逐发、同步等待回包，永不 reject。每发前复查闸门（存活/行军槽/902 在途/兵量），
 * 发空兵或被拒即中止后续（不派空兵打世界目标）；本发回包后 sleep(tripleIntervalMs) 再发下一发。
 * @param {object} spec 场景定义
 * @param {object} target {x,y,entityType}
 * @param {object[]} planList 逐项 {kind:'preset'|'minimal', index?}
 */
async function attackFlow(spec, target, planList) {
  var t = (cfg.targets[spec.key] && cfg.targets[spec.key].marchTypes) || {};
  var base = t[pickBranch(spec, target)] | 0;
  if (!base) {
    log.warn('no marchType configured, abort. key=%s', spec.key);
    return;
  }
  var marchType = resolveMarchType(spec, target);

  for (var i = 0; i < planList.length; i++) {
    if (!aliveFn()) return;

    if (!march.canMarch()) {
      log.info('no free march slot, abort. key=%s;step=%d', spec.key, i + 1);
      return;
    }
    if (net.isSending(CMD_MARCH_WORLD_POINT)) {
      log.info('902 in flight, abort. key=%s;step=%d', spec.key, i + 1);
      return;
    }

    var step = planList[i];
    var plan = new Battle().plan();
    if (step.kind === 'preset') plan.preset(step.index).adjust();
    else plan.minimal();
    var marchData = plan.build();

    if (!marchData.armyListNew.length) {
      log.warn('no army to dispatch, abort. key=%s;step=%d;kind=%s', spec.key, i + 1, step.kind);
      return;
    }

    var ret = await march.attack({ marchType: marchType, target: target, data: marchData });
    if (!aliveFn()) return;

    if (ret.ok) {
      log.info(
        'attack ok. key=%s;step=%d/%d;marchType=%d(base=%d);x=%d;y=%d',
        spec.key,
        i + 1,
        planList.length,
        marchType,
        base,
        target.x,
        target.y,
      );
    } else {
      log.info(
        'attack rejected, abort combo. key=%s;step=%d;code=%d;marchType=%d;base=%d;flags=%s;data=%s',
        spec.key,
        i + 1,
        ret.code,
        marchType,
        base,
        JSON.stringify(marchApi.flags()),
        ret.data,
      );
      return;
    }

    if (i < planList.length - 1) {
      await sleep(cfg.tripleIntervalMs, ctxRef && ctxRef.signal);
    }
  }
}

/**
 * 同面板多实体分流：一个面板类吃多种地块实体时，按地块实体类型挑注册表里的行军类型分支名。
 * 判定序与游戏 WorldBossDetailPanel._onClickAttackBtn 一致：BOSS_V2 → attackV2、宝藏守卫 → treasure、
 * 联盟机甲 → alliance、其余（普通世界 BOSS）→ attack。四型互斥，先后序不影响结果。
 * 未声明该分支的 spec 不参与分流（恒 attack，行为与改前一致）。
 * @param {object} spec 场景定义
 * @param {object} target {x,y,entityType}
 * @returns {string} marchTypes / marchMembers 里的分支键名
 */
function pickBranch(spec, target) {
  var t = (cfg.targets[spec.key] && cfg.targets[spec.key].marchTypes) || {};
  if (t.attackV2 && marchApi.isBossV2(target.entityType)) return 'attackV2';
  if (t.treasure && marchApi.isTreasureBoss(target.entityType)) return 'treasure';
  if (t.alliance && marchApi.isAllianceBoss(target.entityType)) return 'alliance';
  return 'attack';
}

/**
 * 本次出征的 marchType：先按地块实体类型分流（世界 BOSS 面板四型），再做跨服战场漂移换算。
 * target 一并交给 resolve：遗迹的 17→103 要看 siteId（其余场景 resolve 不读它）。
 * @param {object} spec 场景定义
 * @param {object} target {x,y,entityType,siteId?}
 * @returns {number}
 */
function resolveMarchType(spec, target) {
  var t = (cfg.targets[spec.key] && cfg.targets[spec.key].marchTypes) || {};
  var branch = pickBranch(spec, target);
  // 声明了枚举成员名的分支（世界 BOSS 四型/遗迹）：以游戏 MarchType 运行时值为权威源，marchTypes 数值仅漂移兜底
  var member = spec.marchMembers && spec.marchMembers[branch];
  var base = member ? marchApi.typeOf(member, t[branch] | 0) : t[branch] | 0;
  var resolved = marchApi.resolve(base, MARCH_FALLBACK, target);
  if (resolved !== base)
    log.warn(
      'marchType drift. key=%s;base=%d->%d;flags=%s',
      spec.key,
      base,
      resolved,
      JSON.stringify(marchApi.flags()),
    );
  return resolved;
}

/**
 * 注入模块配置（toModuleCfg 产出的是内置常量，非面板可调项：面板仅出 enabled 开关）。
 * enabled=false 时顺带摘净钩子（reactor 稍后会 pause；此处保证停用不留常驻包装）。
 * @param {object} partial { enabled, tripleIntervalMs, targets:{ <key>:{enabled,marchTypes} } }
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  if (typeof partial.tripleIntervalMs === 'number' && partial.tripleIntervalMs >= 0) {
    cfg.tripleIntervalMs = partial.tripleIntervalMs;
  }
  var targets = partial.targets;
  if (targets) {
    QUICK_ATTACK_TARGETS.forEach(function (spec) {
      var t = targets[spec.key];
      if (!t) return;
      var cur =
        cfg.targets[spec.key] ||
        (cfg.targets[spec.key] = { enabled: true, marchTypes: Object.assign({}, spec.marchTypes) });
      if (typeof t.enabled === 'boolean') cur.enabled = t.enabled;
      if (t.marchTypes && typeof t.marchTypes.attack === 'number' && t.marchTypes.attack > 0) {
        cur.marchTypes.attack = t.marchTypes.attack;
      }
    });
  }
  if (partial.enabled === false) unhookAll();
  return cfg;
}

/**
 * 安装：取网络 + 数据中心，解析各场景面板类（缺类仅记日志，不阻断其它场景）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;

  var missing = [];

  net = ctx.net;
  if (!net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  dataCenter = game.get('DataCenter');
  dataCenter = (dataCenter && dataCenter.DATA) || (missing.push('DataCenter'), null);

  QUICK_ATTACK_TARGETS.forEach(function (spec) {
    var mod = game.get(spec.cls);
    classOf[spec.cls] = (mod && mod.default) || null;
    if (!classOf[spec.cls]) log.warn('panel class not found. cls=%s', spec.cls);
  });

  if (missing.length) {
    net = null;
    dataCenter = null;
    log.warn('install failed. missing=%s', missing.join(';'));
    return false;
  }

  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 运行：复位监听态后按注册表挂面板钩子（不直接挂 keydown——keydown 由面板 onShow 触发时才挂）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  activePanel = null;
  detachKey();
  QUICK_ATTACK_TARGETS.forEach(hookSpec);
  log.info('started, hooks=%d; battlefield=%s', hooks.size, JSON.stringify(marchApi.flags()));
}

/**
 * 向 reactor 注册本功能说明书：places:['world'] + kinds:['homeland','wushuang','kvk']（B 档），不声明 offInCombat（战斗设置本就是战斗时的手动辅助）。
 */
reactor.register({
  id: 'quickAttack',
  label: '快捷攻击',
  storageKey: 'pocketcc.feat.quickAttack',
  symbols: [
    'dataCenter',
    'marchType',
    'worldUtils',
    'presetMarch',
    'heroController',
    'mechaController',
    'formationAdv',
    'marchStorage',
  ],
  // B 档（可行性报告 §7.2）：本服/无双峡谷/天梯战场图都要能快捷攻击；秘境由 world 门 kind===pab 隔离、
  // 征服者球体（place=sphere）与盟决（adp_war）不在本表放行范围。
  kinds: ['homeland', 'wushuang', 'kvk'],
  places: ['world'],
  // 战斗设置类：不声明 offInCombat，战斗模式下依然生效（快捷战斗本就是战斗时的手动辅）
  defaults: { enabled: false },
  fields: [],
  toModuleCfg: buildModuleCfg,
  install: install,
  configure: configure,
  run: run,
});
