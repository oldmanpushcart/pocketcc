/**
 * feats/activity/cs-hunt/constants.js —— 夺宝奇兵（CSHunt / CrossTreasure）线协议常量。
 *
 * 职责边界（对齐 core/march.js 的同类口径）：本文件只收「服务器契约常量」——cmd 号、pbAck 业务子字段名、
 *   PB 枚举语义数值、配置表名与道具 id。游戏 bundle 内部符号名（CSHuntController 及其枚举成员）仍收口
 *   core/game-api.js（ACL），此处不出现任何 require 名。策略私货（默认人数/时段退避等）留 index.js。
 *
 * 证据来源：
 *   - cmd 号：references/游戏逆向/extracted/Script/NRequestId__NRequestId.js / NResponseId__NResponseId.js 逐值核；
 *   - 报文形态与字段名：dashcam 20261016T190507 / T191700 / T192930 / T194018 四趟实况（主跑×2、陪跑×2），
 *     设计文档 extension/docs/feat-夺宝奇兵.md §9.4 已逐条归档；
 *   - 表名/道具 id：同文档 §9 真机 dump（活动未开始期可读）。
 *
 * Int64 铁律：本玩法所有 64 位 id（treasureId / teamId / uid / marchId）在协议层是原生 Long 对象
 *   `{_low,_high,_unsigned}`，**发包前用 bits.int64(字符串) 装箱、读包后用 bits.int64Str 归一为字符串**，
 *   绝不做 Number 转换（实证 dashcam 20261016T191700 的 team.id）。
 */

// ─────────────────────── 请求号（NRequestId 段 7501–7586，走 sendPB；7519 例外走 send） ───────────────────────

/** @type {number} CROSS_TREASURE_INFO：活动总览（open/roundTime/openTime/seasonId/poolId/lastRound/version），req 仅 `{header:{}}` */
export const REQ_INFO = 7501;
/** @type {number} CROSS_TREASURE_TEAM_MARCH：满编出征入队。**走 NET.send（JSON 通道），不是 sendPB**，体内无 treasureId（实证 dashcam 20261016T191700/190507） */
export const REQ_TEAM_MARCH = 7519;
/** @type {number} CROSS_TREASURE_TEAM_USE_ITEM：本人要奖励(op:1)/陪跑(op:2)。陪跑无需 treasureId，报文实发 `{op:2}` */
export const REQ_TEAM_USE_ITEM = 7520;
/** @type {number} CROSS_TREASURE_TEAM_CREATE：建队，req `{cfg:1}`，应答回整份 team */
export const REQ_TEAM_CREATE = 7521;
/** @type {number} CROSS_TREASURE_TEAM_APPLY_OR_CANCEL：申请/取消申请入队，req `{teamId:Long, op:1}` */
export const REQ_TEAM_APPLY_OR_CANCEL = 7522;
/** @type {number} CROSS_TREASURE_TEAM_APPLY_OP：队长按申请，req `{uid:Long, op:1同意/2拒绝}` */
export const REQ_TEAM_APPLY_OP = 7523;
/** @type {number} CROSS_TREASURE_TEAM_KICK_MEMBER：踢人 */
export const REQ_TEAM_KICK_MEMBER = 7524;
/** @type {number} CROSS_TREASURE_TEAM_DISMISS：解散 */
export const REQ_TEAM_DISMISS = 7525;
/** @type {number} CROSS_TREASURE_TEAM_LIST：可加入队伍列表，req 仅 `{header:{}}` */
export const REQ_TEAM_LIST = 7526;
/**
 * @type {number} CROSS_TREASURE_MARCH_START：出发确认，req `{op:1同意/2拒绝}`。
 * 报文实证时序（dashcam 20261016T191700）：队长凑够人后发 7527 → 服务端派 21372 召集全队；
 *   队员（含陪跑，实证 20261016T190507）先满编 7519 出征、收 21372 后再发 7527 表态。
 */
export const REQ_MARCH_START = 7527;
/** @type {number} CROSS_TREASURE_TEAM_APPLY_LIST：申请池，req `{teamId:Long}`，应答 `apply[]` */
export const REQ_TEAM_APPLY_LIST = 7528;
/** @type {number} CROSS_TREASURE_TEAM_LEAVE：退队 */
export const REQ_TEAM_LEAVE = 7529;
/** @type {number} CROSS_TREASURE_SEARCH_TEAM_LIST：按昵称搜队，req `{likeName:string}` */
export const REQ_SEARCH_TEAM_LIST = 7530;
/** @type {number} CROSS_TREASURE_HUNT_INFO：本跑状态机详情（csHuntInfo），req `{treasureId:Long}` */
export const REQ_HUNT_INFO = 7531;
/** @type {number} CROSS_TREASURE_EVENT_DECIDE：队长选场景，req `{treasureId,round,indexDecide}` */
export const REQ_EVENT_DECIDE = 7532;
/** @type {number} CROSS_TREASURE_EVENT_DECIDE_VOTE：队员投票，req `{treasureId,round,indexVote}` */
export const REQ_EVENT_DECIDE_VOTE = 7533;
/** @type {number} CROSS_TREASURE_EVENT_PICK_REWARD：先下手为强选奖励 */
export const REQ_EVENT_PICK_REWARD = 7534;
/** @type {number} CROSS_TREASURE_EVENT_ROLL_DICE：这次我最大掷骰 */
export const REQ_EVENT_ROLL_DICE = 7535;
/** @type {number} CROSS_TREASURE_EVENT_ROLL_DICE_GIVE_UP：掷骰放弃 */
export const REQ_EVENT_ROLL_DICE_GIVE_UP = 7536;
/** @type {number} CROSS_TREASURE_EVENT_CODE_BOX_UNLOCK：密码大爆炸提交，req `{treasureId,round,codeNum[5]}`（猜错 s=3/d=cs_treasure281） */
export const REQ_EVENT_CODE_BOX_UNLOCK = 7537;
/** @type {number} CROSS_TREASURE_EVENT_PICK_SKILL：奇妙新科技选位 */
export const REQ_EVENT_PICK_SKILL = 7538;
/** @type {number} CROSS_TREASURE_SKILL_BACKPACK_OPEN：开技能背包（背包数据挂应答，控制器不存） */
export const REQ_SKILL_BACKPACK_OPEN = 7550;
/** @type {number} CROSS_TREASURE_SKILL_USE：使用科技，req `{treasureId,skillSpecId,tarUid?,param?}` */
export const REQ_SKILL_USE = 7551;
/** @type {number} CROSS_TREASURE_SKILL_USE_RECORD_OPEN：使用记录 */
export const REQ_SKILL_USE_RECORD_OPEN = 7552;
/**
 * @type {number} CROSS_TREASURE_GET_MARCH_INFOS：行军军情，req `{treasureId,type:1|2}`（1=我方、2=来袭方），
 *   应答 `crossTreasureGetMarchInfos.{marchInfos[],leaderUid}`。
 *   **marchInfos 项字段**（报文实证 dashcam 20261018T105933 seq229）：`{uid(字符串,非 Long),level,playerInfo(JSON 串),power,maxArmyPower,armyPower,heros,armys,deadArmys}`。
 *   我方（type1）`armyPower/maxArmyPower` 齐备→战力门控防御与定向火线急救可判；敌方（type2）`armyPower` 常 undefined、`maxArmyPower` 可用（实证 20261016 旧结论只对敌方成立）。
 *   现由本 feat **主动查**（借鉴竞对）：掠袭时拉敌我战力做门控防御、战中拉我方战损做按 uid 火线急救、以及 21383 漏推时以 type2 侦察补武装（见 engine-flow.js `#reconMarches`）。
 */
export const REQ_GET_MARCH_INFOS = 7578;
/**
 * @type {number} CROSS_TREASURE_REWARD_INFO：夺宝奖励背包，req `{treasureId}`，
 *   应答 `crossTreasureRewardInfo.backpack[]{id(Int64),itemId,protect,…}`。掠袭时取未保护项按品质/幸运池择最贵重者用安全锁定(17)保护（借鉴竞对 roundFight）。
 */
export const REQ_REWARD_INFO = 7572;

// ─────────────────────── 推送号（NResponseId 段 21371–21386）与 pbAck 业务子字段名 ───────────────────────

/**
 * pbAck 子字段名即「cmd 唯一的业务命名槽」——V1 sendPB 的 ret.data 是整段 pbAck，
 * 推送事件 Event.data 同形（实证 dashcam 20261016T190507 每条 push 的 data 键）。
 */

/** @type {number} 队伍整体变更（含 ARRIVE 清态），载荷 `crossTreasureTeamChange.team` */
export const PUSH_TEAM_CHANGE = 21371;
export const FIELD_TEAM_CHANGE = 'crossTreasureTeamChange';
/** @type {number} 出发召集，载荷 `{teamId:Long, readyMember:Long[], readyStartTimeMill:Long}` */
export const PUSH_READY_CHANGE = 21372;
export const FIELD_READY_CHANGE = 'crossTreasureTeamReadyChange';
/** @type {number} 成员增删改，载荷 `{teamId:Long, type:number, member:{uid,playerInfo,power,level,aTag,help,marchId}}` */
export const PUSH_MEMBER_CHANGE = 21373;
export const FIELD_MEMBER_CHANGE = 'crossTreasureTeamMemberChange';
/** @type {number} 入队申请变更，载荷 `{teamId,uid,op,apply:{uid,teamId,playerInfo,power}}` */
export const PUSH_APPLY_CHANGE = 21374;
export const FIELD_APPLY_CHANGE = 'crossTreasureTeamApplyChange';
/** @type {number} 本人夺宝次数变更（**huntCount 唯一来源**），载荷 `{count:Long, lastRecoverTimeMill:Long, mark}` */
export const PUSH_USER_CHANGE = 21375;
export const FIELD_USER_CHANGE = 'userCrossTreasureChange';
/** @type {number} 状态机主推送（round/status/eventInfo/waitInfo/fightInfo/lootInfo/returnInfo） */
export const PUSH_HUNT_INFO_CHANGE = 21376;
export const FIELD_HUNT_INFO_CHANGE = 'crossTreasureHuntInfoChange';
/** @type {number} 活动信息变更 */
export const PUSH_INFO_CHANGE = 21377;
export const FIELD_INFO_CHANGE = 'crossTreasureInfoChange';
/** @type {number} 科技生效，载荷字段名是 `skillEventSpecId`（非 skillSpecId），且存在无 7551 前置的自动生效 */
export const PUSH_SKILL_TAKE_EFFECT = 21378;
export const FIELD_SKILL_TAKE_EFFECT = 'crossTreasureSkillTakeEffect';
/** @type {number} 掠夺成功（可领奖励） */
export const PUSH_REWARD_CAN_LOOT = 21379;
export const FIELD_REWARD_CAN_LOOT = 'crossTreasureRewardCanLoot';
/** @type {number} 玩家来袭规模，载荷 `{treasureId, marchSize, playerInfos:{uid:JSON 串}}`（playerInfos 需二次 parse） */
export const PUSH_HURT_MARCH_SIZE = 21383;
export const FIELD_HURT_MARCH_SIZE = 'crossTreasureHurtMarchSize';
/** @type {number} 幸运降临生效（奖励翻倍，神器除外） */
export const PUSH_REWARD_MULTIPLE = 21384;
export const FIELD_REWARD_MULTIPLE = 'crossTreasureRewardMultipleTakeEffect';

// ─────────────────────── 应答 pbAck 子字段名（发送侧按 cmd 取） ───────────────────────

/** @type {string} 7501 应答业务槽（除活动总览外**也可能带 `team`**——实证 dashcam 20261016T191700 seq88 应答含整队，与 21371 同形，可直接喂 csHunt.readTeam） */
export const ACK_INFO = 'crossTreasureInfo';
/** @type {string} 7521 应答业务槽（内含 `team`） */
export const ACK_TEAM_CREATE = 'crossTreasureTeamCreate';
/** @type {string} 7522 应答业务槽 */
export const ACK_TEAM_APPLY = 'crossTreasureTeamApplyOrCancel';
/** @type {string} 7526 应答业务槽（内含 `team[]`） */
export const ACK_TEAM_LIST = 'crossTreasureTeamList';
/** @type {string} 7528 应答业务槽（内含 `apply[]`） */
export const ACK_APPLY_LIST = 'crossTreasureTeamApplyList';
/** @type {string} 7530 应答业务槽（内含 `team[]`/`applyNum`） */
export const ACK_SEARCH_TEAM_LIST = 'crossTreasureSearchTeamList';
/** @type {string} 7531 应答业务槽（整份 csHuntInfo） */
export const ACK_HUNT_INFO = 'crossTreasureHuntInfo';
/** @type {string} 7520 应答业务槽 */
export const ACK_TEAM_USE_ITEM = 'crossTreasureTeamUseItem';

// ─────────────────────── 请求体业务槽名（**逐条取自 dashcam req 行的 data 键**，不是推断） ───────────────────────

/**
 * V1 sendPB 的请求体与应答同形（`{header:{}, <本表键>:{…}}`）；7501/7526/7575 等纯头请求不在表内（实发只有 `header`）。
 * 实证：dashcam 20261016T190507（陪跑）与 T191700（主跑）的 `dir:"req:sendPB"` 行。
 * @type {Object<number,string>}
 */
export const REQ_FIELD = {
  [REQ_TEAM_USE_ITEM]: 'crossTreasureTeamUseItem',
  [REQ_TEAM_CREATE]: 'crossTreasureTeamCreate',
  [REQ_TEAM_APPLY_OR_CANCEL]: 'crossTreasureTeamApplyOrCancel',
  [REQ_TEAM_APPLY_OP]: 'crossTreasureTeamApplyOp',
  [REQ_MARCH_START]: 'crossTreasureMarchStart',
  [REQ_TEAM_APPLY_LIST]: 'crossTreasureTeamApplyList',
  [REQ_SEARCH_TEAM_LIST]: 'crossTreasureSearchTeamList',
  [REQ_HUNT_INFO]: 'crossTreasureHuntInfo',
  [REQ_EVENT_DECIDE]: 'crossTreasureEventDecide',
  [REQ_EVENT_PICK_REWARD]: 'crossTreasureEventPickReward',
  [REQ_EVENT_ROLL_DICE]: 'crossTreasureEventRollDice',
  [REQ_EVENT_CODE_BOX_UNLOCK]: 'crossTreasureEventCodeBoxUnlock',
  [REQ_EVENT_PICK_SKILL]: 'crossTreasureEventPickSkill',
  [REQ_SKILL_BACKPACK_OPEN]: 'crossTreasureSkillBackpackOpen',
  [REQ_SKILL_USE]: 'crossTreasureSkillUse',
  [REQ_GET_MARCH_INFOS]: 'crossTreasureGetMarchInfos',
  [REQ_REWARD_INFO]: 'crossTreasureRewardInfo',
};

// ─────────────────────── PB 枚举语义数值（服务器契约，非游戏符号） ───────────────────────

/** @type {number} MarchType.CS_TEAM_HUNT——7519 出征体固定值（实证 dashcam 20261016T191700 `marchType:137`） */
export const MARCH_TYPE_CS_TEAM_HUNT = 137;

/**
 * PBEnumCrossTreasureTeamStatus：队伍生命周期。
 * @type {{WAITING:number,READY:number,MARCHING:number,HUNTING:number,RETURNING:number,ARRIVE:number}}
 */
export const TEAM_STATUS = {
  WAITING: 0,
  READY: 1,
  MARCHING: 2,
  HUNTING: 3,
  RETURNING: 4,
  ARRIVE: 5,
};

/**
 * PBEnumCrossTreasureStatus：本跑状态机（push 21376 的 status，载荷随状态换名）。
 * 实证分布（四趟）1:43 / 2:178 / 3:75 / 4:3 / 5:5 / 6:2 —— 战败判 **6→5 链**，不是 fightInfo。
 * @type {{MARCHING:number,WAIT:number,EVENT:number,FIGHT:number,END:number,RETURN:number,LOOT:number}}
 */
export const HUNT_STATUS = {
  MARCHING: 0,
  WAIT: 1,
  EVENT: 2,
  FIGHT: 3,
  END: 4,
  RETURN: 5,
  LOOT: 6,
};

/**
 * 状态机各 status 的载荷槽名（21376 / 7531 同形）。
 * @type {Object<number,string>}
 */
export const HUNT_STATUS_PAYLOAD = {
  [HUNT_STATUS.WAIT]: 'waitInfo',
  [HUNT_STATUS.EVENT]: 'eventInfo',
  [HUNT_STATUS.FIGHT]: 'fightInfo',
  [HUNT_STATUS.LOOT]: 'lootInfo',
  [HUNT_STATUS.RETURN]: 'returnInfo',
};

/**
 * eventInfo.status 二级阶段（CSHuntPhaseType 的线值：游戏侧枚举成员名收在 ACL，这里的字符串就是协议字段值）。
 * @type {{DECIDE:string,EVENT:string}}
 */
export const EVENT_PHASE_STATE = { DECIDE: 'decide', EVENT: 'event' };

/**
 * eventInfo 内的 phase 字段（CSHuntEventPhaseType 线值）。
 * **DECIDE 候选必须等 `SHOW`**：进阶段先推 `PLAY` 且 `eventSpecIdList` 全 0，1~20s 后才推 `SHOW` 明文
 * （实证 dashcam 20261016T19xxxx 四趟皆有全 0 与明文两态，读到全 0 不可动作）。
 * @type {{NONE:string,PLAY:string,SHOW:string}}
 */
export const EVENT_SHOW_PHASE = { NONE: 'none', PLAY: 'play', SHOW: 'show' };

/**
 * 随机事件类型（cross_treasure_event[eventSpecId].type；CSHuntEventType 线值，6 族）。
 * eventSpecId 词表实值：1001xx=pickReward / 1002xx=rollDice / 1003xx=codeBox /
 *   1004xx=pickSkill / 1005xx=defPVE / 1006xx=nothing（§9.4）。
 * @type {{PICK_REWARD:string,ROLL_DICE:string,DEF_PVE:string,CODE_BOX:string,PICK_SKILL:string,NOTHING:string}}
 */
export const EVENT_TYPE = {
  PICK_REWARD: 'pickReward',
  ROLL_DICE: 'rollDice',
  DEF_PVE: 'defPVE',
  CODE_BOX: 'codeBox',
  PICK_SKILL: 'pickSkill',
  NOTHING: 'nothing',
};

// ─────────────────────── 配置表名与道具 id ───────────────────────

/** @type {string} 主表（max_ppl_num/min_ppl_num/round_max/event_decide_time/defend_time…），真机 dump 仅 2 行同参 */
export const TABLE_CROSS_TREASURE = 'cross_treasure';
/** @type {string} 随机事件表（90 行，type/play_time/win|fail/grail reward），主键 eventSpecId；亦为面板 luckyRewards 幸运礼品池的枚举源（经 csHunt.readRewardPool 解包 win/fail/grail 奖励 id→itemId） */
export const TABLE_CROSS_TREASURE_EVENT = 'cross_treasure_event';
/** @type {string} 科技表（28 行，group/type/param1/close_after），主键 specId */
export const TABLE_CROSS_TREASURE_SKILL = 'cross_treasure_skill';
/** @type {string} 赛季奖池**开关配置行**（以 poolId 为主键：min_level/achievement_open/grail_open…），**不存礼品清单**（误用它做 luckyRewards 枚举是历史 bug，已改走 TABLE_CROSS_TREASURE_EVENT） */
export const TABLE_CROSS_TREASURE_POOL = 'cross_treasure_pool';
/** @type {number} 定位信标（次数不足时补 1 点，quality 5 / type 150 / bag_use 1） */
export const ITEM_BEACON = 47001001;
/**
 * @type {number} ITEM_USE：通用「使用背包道具」。**走 NET.send（JSON 通道），不是 sendPB**，
 *   req `{itemid:number, amount:number}`（**itemid 全小写**，与应答的 itemId 大小写不一致），
 *   应答 `{itemId, amount:使用后剩余持有量}`。定位信标补次数即 `send(815,{itemid:47001001,amount:1})`。
 *   实证 dashcam 多趟 `dir:"req:send"` 行 `{"itemid":600001,"amount":1}` → resp `{"itemId":600001,"amount":2329}`（§7-6 关闭）。
 */
export const CMD_ITEM_USE = 815;

// ─────────────────────── 科技 specId（真机表定稿，见设计文档 §9.2；面板可改，此处仅默认值） ───────────────────────

/** @type {number} 预料先知（type 5 仅 DECIDE，group 1 队伍技能=队长专属） */
export const SKILL_PROPHET = 9;
/** @type {number} 幸运降临（type 10，group 2 个人技能；下一次奖励×2，神器除外） */
export const SKILL_LUCKY = 18;
/** @type {number} 铜墙铁壁（回合盾，group 1） */
export const SKILL_SHIELD_ROUND = 2;
/** @type {number} 毫发难伤（战斗盾，group 1） */
export const SKILL_SHIELD_BATTLE = 26;
/** @type {number} 动态隐形（60s 不可捕捉/不可攻击，group 1） */
export const SKILL_STEALTH = 10;
/** @type {number} 自由闪现（随机迁移，group 1） */
export const SKILL_FLASH = 11;
/** @type {number} 完美镜像（COPY，可复制任一非 COPY 科技；type=12=COPY，group=2 个人） */
export const SKILL_COPY = 22;
/** @type {number} 全量刷新（仅 pickSkill 阶段重洗候选；type=13=REFRESH_SKILL_SELECT，group=2 个人） */
export const SKILL_REFRESH = 23;
/** @type {number} 数据转换（随机转另一科技；type=14=SKILL_TRANSFER，group=2 个人，转场阶段立即用） */
export const SKILL_TRANSFER = 24;
/** @type {number} 安全锁定（type=9=PRECTED_REWARD，group 2 个人技；保护已获奖励，掠袭时自动锁最贵重一项，见 #protectBestReward）*/
export const SKILL_PROTECT_REWARD = 17;
/**
 * 科技「族(type)级限窗回合内本回合去重」上限（借鉴竞对 `config.skill_limit_round`，键=cross_treasure_skill.type）：
 *   值=限窗回合号——≤该回合时、同族本回合已用过即拦（防防御/增益类整局逐回合狂烧）；缺省/0=不限。
 *   type 经 skills.js `SKILL_BY_ID[specId].type` 得到。竞对实测默认如下（1=百战不倒/2=铜墙/5=先知/6=隐形/7=闪现/10=幸运/15=百战不倒新版/16=毫发难伤）。
 * @type {Object<number,number>}
 */
export const SKILL_TYPE_LIMIT = { 1: 9, 2: 9, 5: 10, 6: 9, 7: 9, 10: 9, 15: 9, 16: 9 };
/**
 * @type {number} 火线急救（type=4=RISE_PLAYER，group 1 队伍技=队长专属；治成员伤兵）。
 *   **战损判定口径更新（借鉴竞对，报文实证 dashcam 20261018T105933 seq229）**：7578 type1（我方行军）的 `armyPower/maxArmyPower` 齐备，
 *   可择「armyPower<maxArmyPower 且缺口最大」者按 uid 定向施治（`#mostDamagedUid`）；旧结论「逐员战损不可得」只对 `team.member[].power`/fightInfo/敌方 type2 成立。
 *   侦察失败/战损数据缺失时回退「不带 tarUid、由服务器自决」（与原生 7551{27} 一致，实证 dashcam 20261017T185937 tarUid=0）。
 *   施治门控：status=FIGHT 且本回合真被掠袭过（#raidRounds）——因为 FIGHT 是每回合必经结算相位（未挨打也进），单靠 status 会每回合白烧（用户口径 2026-10-17：无人受伤不治疗）。
 */
export const SKILL_AID = 27;
/**
 * @type {number[]} 战中增益族即用优先级（status=FIGHT 敌人已到我点位时逐个用，每回合各一次性）：
 *   百战不倒(1/25 死伤兵恢复) > 固定增强(19/20/21 属性提升) > 战场变换(3-8 环境改变) > 诱敌来袭(12-16 被攻击属性增加、须战中挂)。
 *   **不含天外守护(28)**（文案未捕到，本期不碰）；group=1 项由 #canUse 天然只放行队长，group=2 固定增强全员可用。
 */
export const FIGHT_BUFF_SKILLS = [1, 25, 19, 20, 21, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16];
/**
 * 陪跑（helper，拿不到奖励）模式下引擎自动排除的科技 specId：这些只对「自己领奖」有意义，
 *   陪跑拾取/使用纯属浪费槽位。pickSkill 选技与末回合清空双双跳过；主跑不受影响。
 *   幸运降临(18) 翻倍下一次奖励、安全锁定(17) 保护已获奖励——陪跑全程无奖励可翻/可保。
 * @type {number[]}
 */
export const HELPER_EXCLUDE_SKILLS = [SKILL_LUCKY, SKILL_PROTECT_REWARD];

/** @type {number} 单跑回合上限（主表 round_max=10 实测，§9.1；末回合清空据此判定） */
export const ROUND_MAX = 10;

/** @type {number} 聊天「夺宝奇兵」频道号（密码位广播；服务器路由，不带 roomId） */
export const CHAT_CHANNEL_CS_HUNT = 17;

// ─────────────────────── 幸运礼品池静态目录（面板 luckyRewards 的保底候选源） ───────────────────────

/**
 * 幸运池 UI 分组场景：仅「有可翻倍奖励物品」的 4 个事件族（key 与 EVENT_TYPE 值一致，name 为面板折叠组标题）。
 *   pickSkill(奇妙新科技) 发的是科技非道具、nothing(空冒一场险) 空过，均不入幸运池，故不在此列。
 * @type {Array<{key:string, name:string}>}
 */
export const LUCKY_SCENES = [
  { key: EVENT_TYPE.PICK_REWARD, name: '先下手为强' },
  { key: EVENT_TYPE.ROLL_DICE, name: '这次我最大' },
  { key: EVENT_TYPE.CODE_BOX, name: '密码大爆炸' },
  { key: EVENT_TYPE.DEF_PVE, name: '最后幸存者' },
];

/**
 * 幸运降临(18) 可翻倍的礼品目录（面板展示名，协议匹配一律用 itemId 数字）。
 *   来源：报文实证 dashcam 20261016T19* 等 11 趟夺宝的 winRewardResult / posInfoList.rewardResult 去重，
 *   名取自 references/字典表.txt。作为面板幸运池的**保底源**：运行期若能从 cross_treasure_event 解包出更全的池则用之，
 *   否则（活动未开/表未下发/符号缺失）回退本表，保证面板不空、开局前即可勾选。
 *   scenes：该道具作为**可翻倍奖励**实际出现的场景族——只认引擎会喂给 #tryLucky 的字段（winRewardResult /
 *     posInfoList.rewardResult），**不含 failRewardResult 未中奖保底、不含 grail 神器**（引擎只翻倍中奖奖励，
 *     勾保底/神器是永不命中的死开关；规范顺序 pickReward→rollDice→codeBox→defPVE，报文实证 dashcam 11 趟），
 *   面板据此把物品归进对应场景折叠组；掉在多个场景的道具会在各相关组各列一份、各自独立勾选。
 * @type {Array<{id:number, name:string, scenes:string[]}>}
 */
export const LUCKY_GIFTS = [
  { id: 820015, name: '中级催化剂', scenes: ['pickReward', 'codeBox', 'defPVE'] },
  { id: 820016, name: '高级催化剂', scenes: ['rollDice'] },
  { id: 820017, name: '顶级催化剂', scenes: ['rollDice'] },
  { id: 62909, name: '低级泰坦装备随机材料箱', scenes: ['codeBox', 'defPVE'] },
  { id: 62910, name: '泰坦装备材料自选箱', scenes: ['codeBox'] },
  { id: 69159, name: '重装芯片宝箱', scenes: ['codeBox', 'defPVE'] },
  { id: 69359, name: '中级重装芯片宝箱', scenes: ['pickReward', 'codeBox', 'defPVE'] },
  { id: 69459, name: '高级重装芯片宝箱', scenes: ['rollDice'] },
  { id: 69559, name: '超级重装芯片宝箱', scenes: ['rollDice'] },
  { id: 2400007, name: '绿色重装经验书', scenes: ['codeBox'] },
  { id: 2800000, name: '军阵通用手册', scenes: ['pickReward', 'codeBox', 'defPVE'] },
  { id: 2801000, name: '军阵通用升级手册', scenes: ['codeBox'] },
  { id: 23044402, name: '军阵补给箱（新）', scenes: ['pickReward', 'defPVE'] },
  { id: 39022278, name: '军阵手册自选箱', scenes: ['rollDice'] },
  { id: 1700402, name: '绿色材料随机箱', scenes: ['defPVE'] },
  { id: 1700403, name: '蓝色材料随机箱', scenes: ['pickReward', 'defPVE'] },
  { id: 1700404, name: '紫色材料随机箱', scenes: ['rollDice'] },
  { id: 4200003, name: '3级强化自选箱', scenes: ['pickReward', 'defPVE'] },
  { id: 39200167, name: '3级稀有技能自选箱', scenes: ['rollDice'] },
  { id: 1001802, name: '全息图自选箱', scenes: ['rollDice', 'codeBox'] },
  { id: 1600029, name: '职业道具自选宝箱', scenes: ['pickReward', 'defPVE'] },
  { id: 550002, name: '职业天赋加速1小时', scenes: ['defPVE'] },
  { id: 20213232, name: '万能装饰物碎片', scenes: ['rollDice'] },
  { id: 920001, name: '石油500K', scenes: ['defPVE'] },
  { id: 940001, name: '雷神元素', scenes: ['pickReward', 'rollDice'] },
  { id: 801040, name: '装备改造图纸', scenes: ['rollDice'] },
  { id: 2100002, name: '高级招募券', scenes: ['pickReward', 'defPVE'] },
  // 以下据 11 份主/陪跑报文（win 中奖奖励语境）补录（报文实证 dashcam 2026-10-16/17）
  { id: 62908, name: '泰坦装备材料随机箱', scenes: ['defPVE'] },
  { id: 2800001, name: '突击阵研究手册', scenes: ['defPVE'] },
  { id: 2800002, name: '攻坚阵研究手册', scenes: ['pickReward'] },
  { id: 2800003, name: '防御阵研究手册', scenes: ['pickReward', 'defPVE'] },
  { id: 2400004, name: '紫色经验书', scenes: ['pickReward', 'defPVE'] },
  { id: 4200004, name: '5级强化自选箱', scenes: ['pickReward', 'defPVE'] },
  { id: 2300002, name: '紫色万能碎片', scenes: ['pickReward'] },
  { id: 2300003, name: '橙色万能碎片', scenes: ['pickReward'] },
  { id: 99910001, name: '元素反应器零件', scenes: ['defPVE'] },
  { id: 99910101, name: '元素宝箱', scenes: ['defPVE'] },
  { id: 5200001, name: '自选兵种+1宝箱', scenes: ['codeBox'] },
  { id: 5200009, name: '自选兵种+0宝箱', scenes: ['codeBox'] },
  { id: 23044405, name: '同频器自选箱', scenes: ['rollDice'] },
  // 货币/数量型（同样可翻倍，非礼箱）：
  { id: 1000006, name: '钻石50', scenes: ['pickReward'] },
  { id: 1000007, name: '钻石100', scenes: ['pickReward'] },
  { id: 10000015, name: '钻石1000', scenes: ['rollDice'] },
];
