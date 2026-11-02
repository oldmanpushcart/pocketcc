/**
 * feats/activity/cs-hunt/engine-flow.js —— 夺宝奇兵（CSHunt）**场景流程编排引擎**（取代 engine-event.js）。
 *
 * 生命周期对齐源码 CSHuntPhaseType={DECIDE:"decide",EVENT:"event"}，由 TeamEngine 经 `#flowHost()` 窄接口驱动
 *   （alive/cfg/team/isLeader/sendPB/onWake/chat），本引擎不反向 import 装配层、不自己摸 net/bus、不自建定时器。
 *   一场（round）四相位（报文实证 status：WAIT=探索 → EVENT/decide=选择 → EVENT/event=交互 → FIGHT=战斗）：
 *   - `WAIT`（探索回合，status=1）转场串联（顺序）：① 有数据转换(24)→7551{24} 立即用 → 重拉背包
 *     ② 有复制(22)→7551{22,param:copySkillSpecId} 复制先知（先知溢出则转复制幸运降临18；用户策略「转换后重判是否有值得复制的科技」）；
 *     每用一发即 7550 刷新背包再判下一项；均本回合一次性去重。复制目标含队伍技能（22/24 皆 group=2 个人技，陪跑成员可用）。
 *   - `DECIDE.play`：队长且有先知(9)→7551{9} 提前揭示（先知 group=1 队长专属、type5 游戏强制仅 DECIDE，故留此阶段）。
 *   - `DECIDE.show`/剩余倒计时≤ DECIDE_ACT_MS(10s)：先知感知选法发 7532{indexDecide}（详见「选场景」段）。
 *   - `EVENT`（场景进入+交互）：按 `Math.floor(eventSpecId/100)` 命中 6 族分派给 `./scenes/*`，调 `scene.handle(ctx)`。
 *   - 结束：无动作（交 TeamEngine/游戏）。
 *
 * 横切自动项（默认开、无 UI）：
 *   - 预警式防御（竞对 onAttacking 同义，server-js.js L16548-16591）：队长节流（WARN_POLL_MS）主动轮询 901 marchInfo 抓飞向本据点敌行军
 *     → 630 取敌战力、仅 `敌 power×WARN_POWER_RATIO > 队内最强 power` 才提前布防 → 按到达 ETA：`<WARN_ETA_MS` 隐形(10) 否则闪现(11)，皆不可用兜底毫发(26)/铜墙(2)；
 *     抢在 21383 结算前规避被掠。全程 fail-safe（数据缺失不动作），与下方「来袭保命」分占 marchId/回合幂等键不叠烧；
 *   - 来袭保命：21383 marchSize>0 即立即执行（不再等战力门控）→ 队长按 DEFENSE_PRIORITY（隐形10>闪现11>毫发盾26=回合盾2>其他战中增益族）用一；
 *     盾分两类（用户口径 2026-10-25）：毫发无伤 26=次数盾，每道预警烧一张（只看持有，不受同回合去重/生效中拦截）；
 *     铜墙铁壁 2=回合盾，盾生效中或本回合已施即不再重复施；
 *   - 盾只在真被掠袭（21383 预警）时经「来袭保命」按需消耗、收到预警即烧（用户口径 2026-10-18 删「WAIT 期主动铺盾」；2026-10-24 删「敌强才防」战力门控，改为预警即保命）；
 *   - 战中策略（FIGHT 相位且**本回合真被掠袭过**才动手）：火线急救(27·择战损最大者定向施治) → 增益族逐个（FIGHT 是每回合必经结算相位，未挨打也进，无掠袭证据即不动）；
 *     掠袭回合内再叠加**敌强门控**（借鉴竞对 roundFight）：7578 双查军力，敌满员×1.3 > 我方最强 → 先垫一张毫发(26)；不达 ×1.5 → 弱敌不烧急救/增益留给强敌波；
 *     数据缺失 fail-open。此闸只管消耗路，不碰「预警即保命」自保路（用户口径 2026-10-24）；
 *   - 族级溢出提前烧（借鉴竞对 initRoundFight）：非末回合 FIGHT 相位，闪现(11)/百战(1/25)/铁壁(2) 任一「持有+回合 > ROUND_MAX」
 *     （族限窗 9 下剩余回合消化不完、终局必带出）→ 趁早烧一张回收，每拍至多一个写、每回合每 specId 尝试一次；
 *   - 末回合清空：round===ROUND_MAX(10) → **单拍串行清光**背包全部可用技（竞对 clearAllSkills 同回合连发 5+ 个 7551 实证服务器受理；
     旧逐拍一技会被掠袭保命拍挤占、回合窗内清不完；排除先知9/刷新23；**完美镜像22 排首位**，
   与转场同律带 `param:copySkillSpecId` 发（严格只复制先知、先知溢出转幸运18，无目标则跳过不空发）——
   竞对 clearAllSkills COPY 先行把余技复制出来再清，不带走不亏（server-js.js L16149-16159）；
   回合盾2 不再排除——第 10 回合后仍有「返程回合」可被攻击，铜墙铁壁抵御的正是返程，陪跑仅 personal；掠袭保命拍在末回合处置后同拍继续清空）。
 *
 * 选场景（indexDecide=1-based）——先知感知（**emit 前置：`uidDecide === 我方 uid` 轮值闸**）：
 *   - revealed = play 态 eventSpecIdList 非 0 位（先知揭示集）、hidden = 仍为 0 位；
 *   - revealed 非空 → 在 revealed 里按 [1002 rollDice,1004 pickSkill] 优先取（同族多位命中随机择位）；两者都不在 → 从 hidden 随机取一（revealed 的 1006 永不选）；
 *   - revealed 空且轮值到我 → 满 DECIDE_MIN_MS 即按 `fallbackIndex` 在非 nothing 位里随机立选（不再硬撞 20s 上限，避开服务器抢先自决 → s:3 cs_treasure371 迟交被拒）；SHOW 到点仍未发则用 `chooseFromFull`；
 *   - 非我轮值 → 整段跳过（服务器只对 `uidDecide` 那个 uid 放行 7532，其他人发一律 s:3 拒）；
 *   - 硬约束：以 21376 eventDecideInfo.timePhaseEnd 为权威倒计时，剩余 ≤ DECIDE_ACT_MS(10s) 即自主决（较旧「观测起 10s」提前落地、避开服务器 auto-decide 抢窗）；无 timePhaseEnd 异常形态才退回「进 DECIDE 起 elapsed≥DECIDE_MIN_MS」观测兜底。
 *
 * 密码大爆炸（codeBox，7537，全员）：本端视图 viewToStr 发频道 17（每回合一次）+ 收队友视图 merge 累积；
 *   汇总满 → 提交；有未知位 → 等队友视图≤15s；超时后未知≤2 → solveCandidates 兜底；未知>2 → 放弃；uidWinMap[我]=true 即停手。
 *
 * 角色门控（**陪跑轮值 dashcam 20261017T025932 修正旧「7532 全员发」口径**）：
 *   - **7532 仅 `eventDecideInfo.uidDecide` 轮值者发**（每回合服务器指定一人，其他成员发一律 s:3 d:cs_treasure371 「当前阶段不可操作」）；
 *   - 7534/7535（要奖励类）仅主跑发；
 *   - 7537/7538/7551 全员发（陪跑 uidWinMap 也能置 true）。
 * 幂等：每轮每动作一次性（#done 记 `${round}:${kind}`）；treasureId 变更（新一跑）整体重置。
 */
import { bits, gameData } from '../../../core/game-api.js';
import { csHunt } from './api.js';
import { createLog } from '../../../core/log.js';
import {
  CHAT_CHANNEL_CS_HUNT,
  EVENT_PHASE_STATE,
  EVENT_SHOW_PHASE,
  EVENT_TYPE,
  FIGHT_BUFF_SKILLS,
  HELPER_EXCLUDE_SKILLS,
  HUNT_STATUS,
  REQ_EVENT_DECIDE,
  REQ_GET_MARCH_INFOS,
  REQ_HUNT_INFO,
  REQ_REWARD_INFO,
  REQ_SKILL_BACKPACK_OPEN,
  REQ_SKILL_USE,
  ROUND_MAX,
  SKILL_AID,
  SKILL_COPY,
  SKILL_FLASH,
  SKILL_LUCKY,
  SKILL_PROPHET,
  SKILL_PROTECT_REWARD,
  SKILL_REFRESH,
  SKILL_SHIELD_BATTLE,
  SKILL_SHIELD_ROUND,
  SKILL_STEALTH,
  SKILL_TRANSFER,
  SKILL_TYPE_LIMIT,
} from './constants.js';
import {
  isFullyKnown,
  merge,
  nextUntried,
  parseCodeViews,
  solveCandidates,
  viewToStr,
} from './codebox.js';
import { canPhase, chooseCopyTarget, skillName, SKILL_BY_ID } from './skills.js';
import { handle as scenePickReward } from './scenes/pick-reward.js';
import { handle as sceneRollDice } from './scenes/roll-dice.js';
import { handle as sceneCodeBox } from './scenes/code-box.js';
import { handle as scenePickSkill } from './scenes/pick-skill.js';
import { handle as sceneDefPve } from './scenes/def-pve.js';
import { handle as sceneNothing } from './scenes/nothing.js';

/** @type {ReturnType<createLog>} feat 日志器（tag=CSHUNT） */
const log = createLog('CSHUNT');

/** @type {number} 事件阶段（status=2）兜底重扫间隔（毫秒）：事件窗口约 60s，比组队期短 */
const EVENT_TICK_MS = 4000;
/** @type {number} 探索回合（status=WAIT）兜底重扫间隔（毫秒）：转场技能一次性，主要靠 21376 推进唤醒 */
const WAIT_TICK_MS = 5000;
/** @type {number} codeBox 两次 7537 提交的最小间隔（毫秒）：穷举不逐拍打爆 */
const CODE_GAP_MS = 3500;
/** @type {number} 选场景「剩余倒计时」触发阈（毫秒）：21376 eventDecideInfo.timePhaseEnd 距今 ≤15s 即自主发 7532（用户口径 2026-10-17，原 10s；20s 总窗内早决、留 15s 给队友反应） */
const DECIDE_ACT_MS = 15000;
/** @type {number} 选场景观测兜底（毫秒）：无 timePhaseEnd 时退回「进 DECIDE 起 elapsed≥5s」，与 DECIDE_ACT_MS 对齐（20s 窗内约剩 15s） */
const DECIDE_MIN_MS = 5000;
/** @type {string} 7550 应答 pbAck 业务槽名（= REQ_FIELD[7550]） */
const REQ_OPEN_FIELD = 'crossTreasureSkillBackpackOpen';
const REQ_USE_FIELD = 'crossTreasureSkillUse';
/** @type {string} 7578 应答业务槽名（= REQ_FIELD[7578]，内含 marchInfos[]/leaderUid） */
const REQ_MARCH_FIELD = 'crossTreasureGetMarchInfos';
/** @type {string} 7572 应答业务槽名（= REQ_FIELD[7572]，内含 backpack[]） */
const REQ_REWARD_FIELD = 'crossTreasureRewardInfo';
/** @type {number} 主动侦察（#reconMarches）结果缓存复用窗口（毫秒）：节流 7578 双查，防每拍刷屏 */
const RECON_MIN_MS = 4000;
/** @type {number[]} 来袭保命优先级（用户口径 2026-10-24）：动态隐身(10) > 自由闪现(11) > 毫发无伤盾(26) = 铜墙铁壁(2) > 其他战中增益族。
 *   前四皆 group=1 队伍技=队长专属；尾部拼 FIGHT_BUFF_SKILLS 作「无专属自保技可用时以增益兜底」。 */
const DEFENSE_PRIORITY = [
  SKILL_STEALTH,
  SKILL_FLASH,
  SKILL_SHIELD_BATTLE,
  SKILL_SHIELD_ROUND,
].concat(FIGHT_BUFF_SKILLS);
/** @type {number[]} 末回合清空排除项（先知 9 有 DECIDE 事件门、全量刷新 23 仅 pickSkill 场景有意义）。
 *   铜墙铁壁(2) 不再排除（用户口径 2026-10-24）：第 10 回合后仍有「返程回合」可被攻击，回合盾抵御的正是返程，须用掉。 */
const FLUSH_EXCLUDE = [SKILL_PROPHET, SKILL_REFRESH];
/** @type {number} 21383 marchSize>0 后视为「正在被攻」的时效窗（毫秒），窗内才保命 */
const RAID_ACTIVE_MS = 30000;
/** @type {number} FIGHT 态推送唤醒的最小间隔（毫秒）：21376 每回合在 FIGHT 窗推 4~10 条，限流防把 4s 节奏加密成逐推送一拍 */
const WAKE_MIN_MS = 3000;
/** @type {number} 预警式防御主动 901 侦察的最小间隔（毫秒）：队长态每此间隔拉一次敌行军窗（竞对靠 AttackingMarchUpdate 事件被动触发，
 *   我方无该内部事件钩子，只能 tick 内轮询；此节流控制 32×20 大窗 + 630 的额外发包成本，用户口径 2026-10-27 接受） */
const WARN_POLL_MS = 7000;
/** @type {number} 预警式防御「隐形 vs 闪现」分流的到达剩余阈（毫秒）：敌行军 ETA<此值用隐形（来不及挪兵），否则闪现（竞对 onAttacking 60s 同口径） */
const WARN_ETA_MS = 60000;
/** @type {number} 预警式防御敌强门控倍率：仅当 `敌 power×此值 > 队内最强 power` 才提前布防（竞对 1.4 同口径；避免对弱敌过烧隐形/闪现） */
const WARN_POWER_RATIO = 1.4;
/** @type {number} 战中「敌强碾压」重阈（竞对 roundFight L16450 口径）：敌最弱在途军的满员战力×此值 > 我方最强在途军的现员战力 → 整队被碾压，先垫一张毫发无伤(26) */
const FIGHT_RATIO_HEAVY = 1.3;
/** @type {number} 战中「敌强」轻阈（竞对 roundFight L16453 口径）：低于此值视为弱敌掠袭，急救/增益不烧、留给强敌波 */
const FIGHT_RATIO_LIGHT = 1.5;
/** @type {number[]} 族级溢出「不带出」提前烧清单（竞对 initRoundFight L16232-16240 的 闪现type7/百战type1/铁壁type2）：
 *   此三族族级限窗（SKILL_TYPE_LIMIT=9）下每回合至多消化 1 张，「持有+当前回合 > ROUND_MAX」即终局必带出——
 *   FIGHT 相位趁早各烧一张回收，好过带出亏空（竞对口径）。百战不倒 1/25 为同族两 specId（游戏改版新增 type15 行）。 */
const DIGEST_OVERFLOW_SKILLS = [SKILL_FLASH, 1, 25, SKILL_SHIELD_ROUND];

/**
 * eventSpecId 六族 → scene 模块分派表（`Math.floor(eventSpecId/100)` 命中）。
 * @type {Object<number, (ctx:object) => Promise<void>>}
 */
const SCENES = {
  1001: scenePickReward,
  1002: sceneRollDice,
  1003: sceneCodeBox,
  1004: scenePickSkill,
  1005: sceneDefPve,
  1006: sceneNothing,
};

/**
 * @typedef {object} FlowHost TeamEngine 注入的运行底座（引擎不反向 import index，也不自摸 net/reactor）
 * @property {() => boolean} alive feat 是否仍激活
 * @property {() => object} cfg 模块配置（mode/skillPool/luckyRewards…）
 * @property {() => object|null} team 当前队伍快照（含 id/treasureId/status/maxMemberPower）
 * @property {() => boolean} isLeader 本人是否队长
 * @property {(cmd:number, inner:object, label:string) => Promise<{ok:boolean, code:number, payload:object|null}>} sendPB 发 V1 PB（复用 TeamEngine 的 REQ_FIELD 装箱与幂等闸）
 * @property {() => void} onWake 唤醒兜底循环
 * @property {(x:number, y:number, k:number) => Promise<object[]>} [worldMarches] 预警式防御：901 marchInfo 拉敌行军窗（缺则跳过预警防御）
 * @property {(uidStr:string) => Promise<number>} [playerPower] 预警式防御：630 取敌战力（缺则跳过预警防御）
 * @property {{send:(text:string, opts:object)=>Promise<object>, normalize:(raw:object)=>object|null}} chat 频道收发底座（codeBox 视图广播/汇总）
 */

export class FlowEngine {
  /** @type {FlowHost} */
  #host;
  /** @type {object|null} 最近一次 21376/7531 状态机快照（含 status/round/eventInfo） */
  #hunt = null;
  /** @type {string} 当前跑的 treasureId 记账（换跑即重置所有 per-round 状态） */
  #huntKey = '';
  /** @type {Set<string>} 已完成动作键（`${round}:${kind}`） */
  #done = new Set();
  /** @type {Object<string,Set<string>>} 每轮 codeBox 已试候选键集合 */
  #codeTried = {};
  /** @type {number} 上次 7537 提交时刻（毫秒） */
  #lastCodeAt = 0;
  /** @type {Map<number,number>} 背包个人技能 specId→持有张数（7550 personalSkillInfoList 同 id 出现次数，平铺无 count 字段） */
  #personal = new Map();
  /** @type {Map<number,number>} 背包队伍技能 specId→持有张数（7550 teamSkillInfoList，仅队长可发） */
  #teamSkills = new Map();
  /** @type {Set<number>} 生效中科技 specId（7550/7551 skillPendingEffectInfoList）——效果生效期间不重施同一科技（对齐游戏使用按钮对生效项置灰） */
  #pending = new Set();
  /** @type {boolean} 背包已拉过（每跑首次需要技能时拉一次，消耗后作废） */
  #backpackLoaded = false;
  /** @type {number} 连续读到空背包的次数（区分未就绪占位 ack vs 真·空背包：前 2 次空不固化、第 3 次认作真空） */
  #bpEmptyStreak = 0;
  /** @type {boolean} 上一次 #useSkill 已从 7551 内嵌背包权威刷新，紧随的 #reloadBackpack 可跳过 7550（省往返、规避用后瞬时空背包） */
  #bpFreshFromUse = false;
  /** @type {number} 最近一次 21383 来袭规模（>0=被真人掠夺）；处置后归零 */
  #raidSize = 0;
  /** @type {number} 最近一次收到来袭推送的时刻（毫秒，RAID_ACTIVE_MS 时效） */
  #raidAt = 0;
  /** @type {Set<number>} 被真人掠袭过的回合号（21383 marchSize>0 记账）——战中急救/增益的动手证据；不复用会被保命处置清零的 #raidSize */
  #raidRounds = new Set();
  /** @type {number} 最近一次 FIGHT 态唤醒时刻（毫秒，WAKE_MIN_MS 节流：实测 FIGHT 窗内 21376 每回合推 4~10 条，逐条唤醒会把 4s 节奏加密成逐推拍） */
  #lastFightWake = 0;
  /** @type {number} 已完成末回合清空的回合（防同回合重复批量发） */
  #flushedRound = 0;
  /** @type {Object<number,number>} 科技族(type)→最近使用回合（#5 族级限窗本回合去重账本，借鉴竞对 sci） */
  #typeUseRound = {};
  /** @type {{mine:object[],enemy:object[]}|null} 最近一次 7578 侦察结果缓存（RECON_MIN_MS 内复用，服务 #2 战力门控/#4 补武装/#2 定向急救） */
  #lastRecon = null;
  /** @type {number} 上次侦察时刻（毫秒，RECON_MIN_MS 节流） */
  #lastReconAt = 0;
  /** @type {Set<number>} 已做过「21383 漏推补武装」侦察的回合（每回合至多一次，防 FIGHT 期反复空查） */
  #reconCheckedRounds = new Set();
  /** @type {Set<string>} 预警式防御已处置过的敌来袭行军 marchId（同 marchId 只提前布防一次，换跑清；竞对 attackes[marchId] 去重同义） */
  #warnAttacked = new Set();
  /** @type {number} 上次预警式防御 901 主动侦察时刻（毫秒，WARN_POLL_MS 节流） */
  #lastWarnAt = 0;
  /** @type {Object<string,number>} 每回合进 DECIDE 的时刻（毫秒，10s 下限用） */
  #enterAt = {};
  /** @type {Object<string,number>} 每回合 pickSkill 已用全量刷新次数（≤2） */
  #refreshCount = {};
  /** @type {Object<string,Array<Array<number>>>} 每回合从频道 17 收到的队友视图 */
  #peerViews = {};
  /** @type {Object<string,boolean>} 每回合是否已广播本端视图 */
  #codeBcast = {};
  /** @type {Object<string,number>} 每回合 codeBox 首次触发时刻（用于等待队友视图超时判定） */
  #codeBoxEnterAt = {};

  /**
   * @param {FlowHost} host TeamEngine 提供的运行底座
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * 收状态机快照（TeamEngine 的 21376/7531 落地转发）。换跑重置、事件态即刻唤醒。
   * @param {object|null} payload 状态机体（`{status,round,eventInfo,...}`）
   */
  onHuntInfo(payload) {
    if (!payload || (payload.eventInfo == null && payload.status == null)) return;
    this.#hunt = payload;
    var h = hostTeamKey(this.#host);
    if (h && h !== this.#huntKey) this.#resetFor(h);
    var status = Number(payload.status) || 0;
    if (status === HUNT_STATUS.FIGHT) {
      // FIGHT 窗仅 ~13s 但 21376 每回合推 4~10 条：逐条唤醒会把 tick 节奏加密到逐推送一拍（每拍还带 7550+7531 只读包），限流 ≥3s 一次，其余交给 4s 兜底重扫
      var now = Date.now();
      if (now - this.#lastFightWake < WAKE_MIN_MS) return;
      this.#lastFightWake = now;
      this.#wake();
      return;
    }
    if (status === HUNT_STATUS.EVENT || status === HUNT_STATUS.WAIT) this.#wake();
  }

  /**
   * 21383 来袭推送（TeamEngine 转发）：marchSize>0 即被真人掠夺，置来袭态并唤醒（保命动作在 tick 里做）。
   * @param {object|null} payload `{treasureId, marchSize, playerInfos}`
   */
  onRaid(payload) {
    var size = payload ? Number(payload.marchSize) || 0 : 0;
    this.#raidSize = size;
    if (size > 0) {
      this.#raidAt = Date.now();
      // 回合级掠袭记账（战中急救/增益的动手证据；FIGHT 本身是每回合必经相位，不能当「有人受伤」依据）
      var r = Number(this.#hunt && this.#hunt.round) || 0;
      if (r > 0) this.#raidRounds.add(r);
      this.#wake();
    }
  }

  /**
   * 频道 17 入站推送（TeamEngine 转发）：归一 → 认夺宝频道且非本人 → 抽 `[-0-9]{5}` 视图 token → 按当前回合累积。
   * @param {object|null} rawMsg socket 原始推送项
   */
  onChatPush(rawMsg) {
    var chat = this.#host.chat;
    if (!chat || typeof chat.normalize !== 'function') return;
    var n = chat.normalize(rawMsg);
    if (!n || Number(n.channel) !== CHAT_CHANNEL_CS_HUNT || n.isSelf) return;
    var round = Number(this.#hunt && this.#hunt.round) || 0;
    // 队友手输密码视图：数字位=已知、任意非数字符号=未知占位（* ? - × … 不限，符号不固定但数字位固定），按位定长切分
    var views = parseCodeViews(n.text);
    if (!views.length) return;
    var bucket = this.#peerViews[round] || (this.#peerViews[round] = []);
    for (var i = 0; i < views.length; i++) bucket.push(views[i]);
  }

  /**
   * 兜底调和：把当前跑的流程推进一格，返回下一拍间隔。运行即全自动（无 autoEvent 开关）。
   * @returns {Promise<number>} 下一拍毫秒数
   */
  async tick() {
    var host = this.#host;
    if (!host.alive()) return 0;
    var team = host.team();
    if (!team) return 0;
    var treasureId = team.treasureId || team.id;
    var key = String(treasureId || '');
    if (key && key !== this.#huntKey) this.#resetFor(key);

    // 只读自愈：无快照时按兜底节奏补拉 7531
    if (!this.#hunt) {
      await host.sendPB(REQ_HUNT_INFO, { treasureId: bits.int64(treasureId) }, '拉本跑详情');
      return EVENT_TICK_MS;
    }
    var status = Number(this.#hunt.status) || 0;
    var round = Number(this.#hunt.round) || 0;
    var decideDelay = 0;
    if (status === HUNT_STATUS.EVENT && this.#hunt.eventInfo) {
      var ei = this.#hunt.eventInfo;
      var cfg = host.cfg();
      if (ei.status === EVENT_PHASE_STATE.DECIDE)
        decideDelay = await this.#handleDecide(treasureId, ei);
      else if (ei.status === EVENT_PHASE_STATE.EVENT) await this.#handleEvent(treasureId, ei, cfg);
    } else if (status === HUNT_STATUS.WAIT) {
      // 探索回合（每场 round 起始 status=1/WAIT）：数据转换→重拉背包→再判并执行完美镜像复制先知。
      //   【不再主动维持盾】：实证 20261018T190716 无人来袭时第 4/5 回合白烧唯一铜墙铁壁——盾只在真被掠袭且敌强时
      //   经 #autoStrategies（来袭保命）按需消耗；WAIT 期主动铺盾违背用户口径「无人打就不该用盾」，删除。
      await this.#explorationSkills(treasureId, round);
    } else if (status === HUNT_STATUS.FIGHT) {
      // 战斗结算相位（status=3，**每回合必经、未挨打也进**，实证 20261016T191700 全程无 21383 掠袭仍每回合成对推 fightWin 0→3）：
      //   增益/急救仅本回合真被掠袭过（#raidRounds）且过敌强门控（③竞对口径：弱敌不烧、碾压先垫盾）才动手，否则白烧急救与增益；非掠袭回合直接闲置
      await this.#fightStrategies(treasureId, round);
    }
    // #4/⑥ 主动侦察补武装（借鉴竞对）：FIGHT 态但 21383 漏推（#raidSize≤0）时，每回合至多一次判来袭；
    //   ⑥ lootMarchNum 直读优先——控制器权威计数（21383 直写）>0 即一手掠袭证据，免发 7578；仅当控制器也无（回 0）才回退 #4 轻量 7578 type2 侦察；
    //   来袭非空即补武装来袭态（交随后 #autoStrategies 走保护+门控防御），并记入掠袭回合（点燃战中急救/增益前提）
    if (
      status === HUNT_STATUS.FIGHT &&
      this.#raidSize <= 0 &&
      !this.#reconCheckedRounds.has(round)
    ) {
      this.#reconCheckedRounds.add(round);
      var lm = csHunt.lootMarchNum();
      if (lm > 0) {
        this.#raidSize = lm;
        this.#raidAt = Date.now();
        if (round > 0) this.#raidRounds.add(round);
      } else {
        var rec = await this.#reconMarches(treasureId);
        if (rec.enemy.length) {
          this.#raidSize = rec.enemy.length;
          this.#raidAt = Date.now();
          if (round > 0) this.#raidRounds.add(round);
        }
      }
    }
    // 预警式防御（借鉴竞对 onAttacking）：队长节流主动轮询 901 抓飞向本据点的敌行军，按敌战力/ETA 提前隐形/闪现，抢在 21383 结算前规避被掠
    var warnedOut = false;
    if (
      host.isLeader() &&
      status !== HUNT_STATUS.END &&
      typeof host.worldMarches === 'function' &&
      typeof host.playerPower === 'function' &&
      Date.now() - this.#lastWarnAt >= WARN_POLL_MS
    ) {
      this.#lastWarnAt = Date.now();
      warnedOut = await this.#warningDefense(treasureId, round);
    }
    // 横切自动项：掠袭保命 / 末回合清空（串行例外）/ 族级溢出提前烧（各自门控）；本拍若预警式防御已占写额（#sendPB 同 cmd 在途去重，除末回合串行外每拍至多一个 7551 写），则跳过自动项，下拍再判
    if (!warnedOut) await this.#autoStrategies(treasureId, status, round);
    // 非事件阶段：按兜底节奏只读补拉 7531（刷 round / 来袭态）
    if (status !== HUNT_STATUS.EVENT) {
      await host.sendPB(REQ_HUNT_INFO, { treasureId: bits.int64(treasureId) }, '拉本跑详情');
    }
    // EVENT/FIGHT 期默认 4s 重扫（FIGHT 窗仅 ~13-25s，需与事件态同密）；若本轮 handleDecide 给出精确倒计时（轮值到我且未到触发阈）则贴近触发点轮询，
    //   避免 4s 粒度把「倒数15s 决断」推迟到实际倒数 11~12s 才发
    return status === HUNT_STATUS.EVENT || status === HUNT_STATUS.FIGHT
      ? status === HUNT_STATUS.EVENT && decideDelay > 0
        ? decideDelay
        : EVENT_TICK_MS
      : status === HUNT_STATUS.WAIT
        ? WAIT_TICK_MS
        : 15000;
  }

  // ── DECIDE：转场串联 + 先知感知选场景 ───────────────────────────────

  /**
   * 选场景阶段：play 态先串联转场/开场技能（复制/转换/先知），再按先知感知择法发 7532。
   * @param {string|number} treasureId 本跑 id
   * @param {object} ei eventInfo（status=decide）
   * @returns {number} 建议的下一拍重扫毫秒数（轮值到我且未到触发阈时返回「距跨过 DECIDE_ACT_MS」的精确值，其它情形回 0 走常规节奏）
   */
  async #handleDecide(treasureId, ei) {
    var edi = ei.eventDecideInfo;
    if (!edi) return 0;
    var round = Number(ei.round) || 0;
    var list = Array.isArray(edi.eventSpecIdList) ? edi.eventSpecIdList : [];
    var phase = edi.phase;
    var now = Date.now();
    if (this.#enterAt[round] == null) this.#enterAt[round] = now;
    var elapsed = now - this.#enterAt[round];

    // 转场先知（仅 play 态，show 前揭示才有意义；先知对全队 eventSpecIdList 广播有效，不看轮值）
    if (phase === EVENT_SHOW_PHASE.PLAY) await this.#decideProphet(treasureId, round);

    // ── 轮值闸：7532 只对 eventDecideInfo.uidDecide 指向的那个 uid 放行，其他成员发一律 s:3 cs_treasure371
    //   报文实证 dashcam 20261017T025932 陪跑：round 1/3/5/9 uidDecide=我 → s:0；2/4/6/7/8/10 非我 → s:3（含 r=7 我方撞 20s 迟交被服务器抢先自决的案例）
    var udStr = bits.int64Str(edi.uidDecide);
    var myUidStr = gameData.myUidStr();
    if (!udStr || !myUidStr || udStr !== myUidStr) return 0;

    var dk = round + ':decide';
    if (this.#done.has(dk)) return 0;
    if (!list.length) return 0;
    // 权威倒计时优先：timePhaseEnd 距今 ≤ DECIDE_ACT_MS(15s) 即自主决（留 15s 给队友反应，避开服务器 auto-decide 抢窗）；
    //   无 timePhaseEnd（异常形态）退回「进 DECIDE 起 elapsed≥DECIDE_MIN_MS」旧口径。
    var deadlineMs = edi.timePhaseEnd ? Number(bits.int64Str(edi.timePhaseEnd)) || 0 : 0;
    var remaining = deadlineMs ? deadlineMs - csHunt.serverMs() : NaN;
    var act = isFinite(remaining) ? remaining <= DECIDE_ACT_MS : elapsed >= DECIDE_MIN_MS;
    var idx; // SHOW 与 play-达阈两条分支必赋值（play-未达阈走 else 直接 return），故不初始化为 0
    if (phase === EVENT_SHOW_PHASE.SHOW) {
      idx = chooseFromFull(list);
    } else if (act) {
      // play 态：有先知揭示按揭示择优；无揭示但已到触发阈 → 默认位序立选
      var rev = revealedIndices(list);
      idx = rev.length ? chooseProphet(list, rev) : fallbackIndex(list);
    } else {
      // play 态且未达触发阈：把下一拍精确排到「刚跨过 DECIDE_ACT_MS」处（clamp 300ms~EVENT_TICK_MS），使决断贴近倒数15s
      var toFire = isFinite(remaining) ? remaining - DECIDE_ACT_MS : DECIDE_MIN_MS - elapsed;
      return Math.min(Math.max(toFire, 300), EVENT_TICK_MS);
    }
    if (idx >= 1) {
      this.#done.add(dk);
      await this.#host.sendPB(
        REQ_EVENT_DECIDE,
        { treasureId: bits.int64(treasureId), round: round, indexDecide: idx },
        '选场景',
      );
    }
    return 0;
  }

  /**
   * 探索回合（status=WAIT）转场串联：① 数据转换(24) → 重拉背包 → ② 完美镜像(22) 复制先知。
   *   用户策略「转换后重判是否有值得复制的科技」——转换会随机把一技变成另一技，故转完必须重拉背包再判复制。
   *   复制目标=先知(9)（严格只复制先知）；陪跑成员也走此路（22/24 皆 group=2 个人技，复制目标不受队长限制）。
   *   每 (round,kind) 一次性去重；treasureId 变更由 #resetFor 清 #done。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 回合
   * @returns {Promise<boolean>} 本拍是否已发过一次 7551 写包（true=转场已占木拍写额，调用方据此跳过盾维持，避免同拍连发多条 7551）
   */
  async #explorationSkills(treasureId, round) {
    await this.#ensureBackpack();
    var wrote = false;
    // ① 数据转换（纯随机转另一科技，报文无 param）——先转，把「可能转出先知」的机会交给下一步重判
    var tk = round + ':seq:transfer';
    if (!this.#done.has(tk) && this.#usable(SKILL_TRANSFER)) {
      this.#done.add(tk);
      await this.#useSkill(treasureId, SKILL_TRANSFER, '数据转换');
      await this.#reloadBackpack();
      wrote = true;
    }
    // ② 完美镜像复制（转换后重拉背包再判）：背包有先知则复制先知，param 键名 copySkillSpecId 得证于手动成功报文（陪跑 22{copySkillSpecId:26}）
    var ck = round + ':seq:copy';
    if (!this.#done.has(ck) && this.#usable(SKILL_COPY)) {
      this.#done.add(ck);
      var copyable = this.#copyableSet();
      var target = chooseCopyTarget({ copyable: copyable });
      var prophetCnt = this.#backpackCount(SKILL_PROPHET);
      // ③ 先知溢出即转复制幸运降临（用户口径 2026-10-24）：复制发生在 WAIT(R)、先知消费在
      //   DECIDE(R) 属**同一回合**（报文实证相位 1(R)→2(R)decide→event→3(R)），可消化窗口是 ROUND_MAX-round+1，
      //   溢出判据即 backpackCount+round > ROUND_MAX（非 >=）；否则 round=10 持有 0 时会误停、白扔一张当回合立即可用的镜像。
      //   （注：pick-skill.js 剪枝已同步改回 `>`（2026-10-25 玩家反馈 r9 差一）——三处溢出判据统一为持有>剩余窗；
      //   旧注「pick-skill 用 >= 是对的」系溢出补丁前的过时定标，会把「恰好可消化」误剪，勿再采信）
      //   先知已溢出（再复制先知无用）时，若背包持有幸运降临(18) 则改复制它（翻倍奖励更值），否则本轮不复制。
      if (target === SKILL_PROPHET && prophetCnt + round > ROUND_MAX) {
        var hasLucky = copyable.indexOf(SKILL_LUCKY) >= 0;
        target = hasLucky ? SKILL_LUCKY : 0;
        // 溢出→转幸运的分流留 info（真机验证点②：镜像复制幸运是否发生、因何发生）
        log.info(
          '完美镜像·先知溢出(持有%d+回合%d>%d)→%s',
          prophetCnt,
          round,
          ROUND_MAX,
          hasLucky ? '转复制幸运降临' : '背包无幸运，本轮不复制',
        );
      }
      if (target) {
        var copyOk = await this.#useSkill(
          treasureId,
          SKILL_COPY,
          '完美镜像复制' + (target === SKILL_LUCKY ? '幸运降临' : '先知'),
          { param: JSON.stringify({ copySkillSpecId: target }) },
        );
        // 复制目标与服务器受理结果留 info（真机验证点②：copySkillSpecId=18 是否被接受，被拒时下行 sendPB 给 reason）
        log.info(
          '完美镜像·复制 %s(%d) %s',
          target === SKILL_LUCKY ? '幸运降临' : '先知',
          target,
          copyOk ? '已接受' : '被拒(见 reason)',
        );
        await this.#reloadBackpack();
        wrote = true;
      }
    }
    return wrote;
  }

  /**
   * DECIDE.play 先知探测：队长且有先知(9)→7551{9} 提前揭示候选（group=1 队长专属、type5 游戏强制仅 DECIDE 阶段可用）。
   *   本回合一次性去重；对全队 eventSpecIdList 广播有效，与 7532 轮值无关，故置于轮值闸之前。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 回合
   */
  async #decideProphet(treasureId, round) {
    await this.#ensureBackpack();
    var pk = round + ':seq:prophet';
    if (!this.#done.has(pk) && this.#host.isLeader() && this.#usable(SKILL_PROPHET)) {
      this.#done.add(pk);
      await this.#useSkill(treasureId, SKILL_PROPHET, '先知探测');
      await this.#reloadBackpack();
    }
  }

  // ── EVENT：按族分派场景模块 ─────────────────────────────────────────

  /**
   * 事件执行阶段分派（按 eventSpecId 族号命中 scenes/）。
   * @param {string|number} treasureId 本跑 id
   * @param {object} ei eventInfo（status=event）
   * @param {object} cfg 模块配置
   */
  async #handleEvent(treasureId, ei, cfg) {
    var specId = Number(ei.eventSpecId) || 0;
    var fam = Math.floor(specId / 100);
    var scene = SCENES[fam];
    if (!scene) return;
    await scene(this.#sceneCtx(treasureId, ei, cfg));
  }

  /**
   * 装配 scene 的运行上下文（注入本引擎的实时态/幂等闸/技能底座/聊天汇总，scene 不反向 import 本引擎）。
   * @param {string|number} treasureId 本跑 id
   * @param {object} ei eventInfo
   * @param {object} cfg 模块配置
   * @returns {object} ctx
   */
  #sceneCtx(treasureId, ei, cfg) {
    var self = this;
    return {
      treasureId: treasureId,
      round: Number(ei.round) || 0,
      ei: ei,
      cfg: cfg,
      alive: function () {
        return self.#host.alive();
      },
      isMain: function () {
        return cfg.mode !== 'helper';
      },
      isLeader: function () {
        return self.#host.isLeader();
      },
      sendPB: function (cmd, inner, label) {
        return self.#host.sendPB(cmd, inner, label);
      },
      ensureBackpack: function (force) {
        return self.#ensureBackpack(force);
      },
      canUse: function (id) {
        return self.#canUse(id);
      },
      backpackCount: function (id) {
        return self.#backpackCount(id);
      },
      useSkill: function (id, label, opt) {
        return self.#useSkill(treasureId, id, label, opt);
      },
      tryLucky: function (sceneKey, rewardResult, label) {
        return self.#tryLucky(treasureId, sceneKey, rewardResult, label);
      },
      // 幸运溢出提前消耗（用户口径 2026-10-25，实证 20261025T110353 第三跑 r9 持2张无 rollDice 窗、靠手动）：
      //   有奖场景动作前若 持有数 > 本回合后剩余回合数 即先烧一张翻倍本次奖励（兑底末回合清空顾不到后续回合的浪费）
      tryLuckyOverflow: function (round, label) {
        return self.#tryLuckyOverflow(treasureId, round, label);
      },
      backpackReady: function () {
        return self.#backpackLoaded;
      },
      luckyHit: function (rewardResult) {
        var pools = self.#host.cfg().luckyRewards;
        var wl = (pools && pools[EVENT_TYPE.ROLL_DICE]) || [];
        return wl.length > 0 && !!rewardResult && hitWhitelist(rewardResult, wl);
      },
      // 服务端权威幂等：本回合我已掷过（eventRollDiceInfo.memberList 里我 uid 的 rollNum>0）→ 抗引擎重启/推送重放误重掷（借鉴竞对 memberList.rollNum 判断）
      alreadyRolled: function () {
        var ml = ei.eventRollDiceInfo && ei.eventRollDiceInfo.memberList;
        if (!Array.isArray(ml)) return false;
        var me = gameData.myUidStr();
        if (!me) return false;
        for (var i = 0; i < ml.length; i++) {
          if (bits.int64Str(ml[i] && ml[i].uid) === me && Number(ml[i] && ml[i].rollNum) > 0)
            return true;
        }
        return false;
      },
      canPhase: function (id) {
        return canPhase(id, HUNT_STATUS.EVENT, EVENT_PHASE_STATE.EVENT);
      },
      invalidateBackpack: function () {
        self.#backpackLoaded = false;
      },
      done: function (k) {
        return self.#done.has(k);
      },
      markDone: function (k) {
        self.#done.add(k);
      },
      refreshCount: function (r) {
        return self.#refreshCount[r] || 0;
      },
      bumpRefresh: function (r) {
        self.#refreshCount[r] = (self.#refreshCount[r] || 0) + 1;
      },
      codeBox: {
        broadcast: function (r, str) {
          self.#broadcastCode(r, str);
        },
        peerViews: function (r) {
          return self.#peerViews[r] || [];
        },
        merged: function (r, own) {
          return merge([own].concat(self.#peerViews[r] || []));
        },
        tried: function (r) {
          return self.#codeTried[r] || (self.#codeTried[r] = new Set());
        },
        readyToSubmit: function () {
          return Date.now() - self.#lastCodeAt >= CODE_GAP_MS;
        },
        markSubmit: function () {
          self.#lastCodeAt = Date.now();
        },
        /**
         * 本回合 codeBox 首次触发到现在的毫秒差（首次返回 0 并记录时刻）。
         * @param {number} r 回合
         * @returns {number}
         */
        peerWaitMs: function (r) {
          var at = self.#codeBoxEnterAt[r];
          if (at == null) {
            self.#codeBoxEnterAt[r] = Date.now();
            return 0;
          }
          return Date.now() - at;
        },
      },
      isFullyKnown: isFullyKnown,
      viewToStr: viewToStr,
      solveCandidates: solveCandidates,
      nextUntried: nextUntried,
      log: log,
    };
  }

  // ── 横切自动项（来袭保命 / 末回合清空） ─────────────────────────────

  /**
   * 事件无关的自动技能推进：掠袭保命（队长队技）→ 末回合清空（单拍串行清光）→ 族级溢出提前烧。
   * 除末回合清空外每拍至多一个写动作（#sendPB 同 cmd 在途去重，await 应答即放行下一条）。
   * @param {string|number} treasureId 本跑 id
   * @param {number} status 本跑状态
   * @param {number} round 当前回合
   */
  async #autoStrategies(treasureId, status, round) {
    // 1) 掠袭处置（21383 推送到 或 #4 侦察补武装）：**先保护最有价值奖励（不可逆优先，#1）→ 队长收到预警即按优先级保命（#2）**
    if (this.#raidSize > 0 && Date.now() - this.#raidAt <= RAID_ACTIVE_MS) {
      var raidSize = this.#raidSize;
      var raidAgeMs = Date.now() - this.#raidAt;
      await this.#ensureBackpack();
      await this.#protectBestReward(treasureId, round); // #1：安全锁定(17) group2 个人技，主跑各保各的贵重奖励
      // 用户口径 2026-10-24：收到来袭预警即立即按 DEFENSE_PRIORITY 保命，删除旧 #enemyOverwhelms「敌强才防」战力门控
      //   （旧门控会把弱敌预警也吞掉、延误自保）；自保技皆 group=1 队长专属，非队长由 #canSpend 天然拦，故保留 isLeader 闸。
      if (this.#host.isLeader()) {
        // 用户口径 2026-10-25（报文实证 20261025T110353 第三跑 round3）：
        //   毫发无伤(26)=次数盾——每道预警烧一张，不拦同回合再消耗，生效中(#pending，命中即解除重武装)与无持有才是闸；
        //   铜墙铁壁(2)=回合盾——盾生效期间不再施，其余同旧口径；同回合已有任一「来袭保命」记账则增益不再叠烧。
        var shieldPending =
          this.#pending.has(SKILL_SHIELD_ROUND) || this.#pending.has(SKILL_SHIELD_BATTLE);
        var spentDef = false;
        for (var i = 0; i < DEFENSE_PRIORITY.length; i++) {
          var id = DEFENSE_PRIORITY[i];
          var dk = round + ':def:' + id;
          var isCountShield = id === SKILL_SHIELD_BATTLE;
          if (isCountShield) {
            // 次数盾：只认「持有>0」（#canUse，不走 #usable 的生效中拦截——用户口径「几次预警用几次」，盾在生效中
            //   又来预警说明新攻势在路上，须再垫一张；旧 :def: 记账与族级限窗把它压成一回合一张，
            //   致后续预警 falls through 连环改烧回合盾/增益）
            if (!this.#canUse(id)) continue;
          } else {
            if (id === SKILL_SHIELD_ROUND && shieldPending) continue; // 回合盾生效期间不再施（用户口径：一轮有一个在生效就够）
            if (!this.#canSpend(id) || this.#done.has(dk)) continue; // #canSpend = #usable + #5 族级限窗去重
          }
          this.#done.add(dk);
          var defOk = await this.#useSkill(treasureId, id, '来袭保命');
          // 每次消耗留 info（真机验证点①：无战力门控后是否对弱敌过烧）：记本波来袭规模/预警龄与择用技及受理结果
          log.info(
            '来袭保命·%s %s(%d)：round=%d 来袭规模=%d 预警龄=%dms%s',
            defOk ? '已消耗' : '消耗被拒',
            skillName(id),
            id,
            round,
            raidSize,
            raidAgeMs,
            isCountShield ? '（次数盾·每预警烧一张）' : '',
          );
          spentDef = true;
          break;
        }
        if (!spentDef)
          log.debug(
            '来袭保命·无可用自保技：round=%d 来袭规模=%d（皆未持有/生效中/本回合已烧）',
            round,
            raidSize,
          );
      }
      this.#raidSize = 0; // 本波已处置，等下一次 21383/侦察再武装
      // 末回合不 return（借鉴竞对 clearAllSkills 与保命路并行不互斥）：保命拍不再挤占清空进度，同拍继续往下串行清空
      if (round !== ROUND_MAX) return;
    }
    // 2) 末回合清空：round===ROUND_MAX 时**单拍串行清光**全部可用技（借鉴竞对 clearAllSkills L16149-16193——
    //   竞对同回合格斗相位连发 5+ 个 7551 实证服务器受理，逐拍一技会被掠袭保命拍挤占、回合窗内清不完背包；
    //   我方 #sendPB 在途去重使 await 串行天然逐条排队，每次 7551 应答内嵌背包回写让下一条 #usable 反映最新持有。
    //   排除先知/刷新；陪跑只刷 personal）
    if (
      status === HUNT_STATUS.EVENT &&
      round > 0 &&
      round === ROUND_MAX &&
      this.#flushedRound !== round
    ) {
      await this.#ensureBackpack();
      var pool = this.#flushCandidates();
      var flushedOne = false;
      for (var j = 0; j < pool.length; j++) {
        var sid = pool[j];
        var fk = round + ':flush:' + sid;
        if (!this.#usable(sid) || this.#done.has(fk)) continue;
        this.#done.add(fk);
        // 完美镜像(22) 置顶项须带 `param:copySkillSpecId` 才被服务器受理（协议实证见 #explorationSkills 正路，
        //   竞对 clearAllSkills L16154 同律）；无 param 的裸 7551{22} 是畸形包。择目标与转场同策略：
        //   严格只复制先知(9)，先知溢出（持有>剩余窗）转幸运(18)；皆不可用则记键跳过、继续清池内下一技（不卡死清空）。
        var flushOpt = null;
        if (sid === SKILL_COPY) {
          var fCopyable = this.#copyableSet();
          var fTarget = chooseCopyTarget({ copyable: fCopyable });
          if (fTarget === SKILL_PROPHET && this.#backpackCount(SKILL_PROPHET) + round > ROUND_MAX)
            fTarget = fCopyable.indexOf(SKILL_LUCKY) >= 0 ? SKILL_LUCKY : 0;
          if (!fTarget) {
            log.debug('末回合清空·镜像无复制目标，跳过(继续清余技)：round=%d', round);
            continue;
          }
          flushOpt = { param: JSON.stringify({ copySkillSpecId: fTarget }) };
        }
        var flushOk = await this.#useSkill(treasureId, sid, '末回合清空', flushOpt);
        // 每次清空留 info（真机验证点③：回合盾铜墙铁壁是否在末回合被用掉）：记所用技与池剩
        log.info(
          '末回合清空·%s %s(%d)：round=%d 池剩%d%s',
          flushOk ? '已用' : '用被拒',
          skillName(sid),
          sid,
          round,
          pool.length - j - 1,
          sid === SKILL_COPY
            ? ' 复制目标=' + skillName(flushOpt ? JSON.parse(flushOpt.param).copySkillSpecId : 0)
            : '',
        );
        if (sid === SKILL_COPY && !flushOk) this.#done.delete(fk); // 镜像被拒 → 回退幂等键，相位切换后（如 EVENT→FIGHT）可重试，不至整局卡死
        flushedOne = true; // 不 break：同拍继续串行清池内下一技（生效中/已用项照常 skip，等下拍自然重试）
      }
      if (!flushedOne) this.#flushedRound = round; // 池空或全部不可用→本回合清空收口（后续拍不再重扫）
    }
    // 3) 族级溢出「不带出」提前烧（借鉴竞对 initRoundFight L16232-16240）：非末回合 FIGHT 相位，闪现/百战/铁壁
    //   任一「持有+当前回合 > ROUND_MAX」（族限窗 9 下剩余回合消化不完）→ 趁早烧一张回收，每拍至多一个写。
    //   阈值用 `>` 非 `>=`（与 pick-skill ③剪枝/#tryLuckyOverflow 同律，r9 差一教训）；走 #canSpend（持有+非生效+族限窗本回合去重），
    //   尝试键记账到回合——被拒不回退，同回合不逐拍循环撞被拒写。
    if (status === HUNT_STATUS.FIGHT && round > 0 && round < ROUND_MAX) {
      await this.#ensureBackpack();
      for (var dj = 0; dj < DIGEST_OVERFLOW_SKILLS.length; dj++) {
        var ovId = DIGEST_OVERFLOW_SKILLS[dj];
        var ovk = round + ':digest:' + ovId;
        if (this.#done.has(ovk)) continue;
        var ovHeld = this.#backpackCount(ovId);
        if (ovHeld + round <= ROUND_MAX) continue;
        if (!this.#canSpend(ovId)) continue;
        this.#done.add(ovk);
        var ovOk = await this.#useSkill(treasureId, ovId, '溢出回收');
        log.info(
          '溢出回收·%s %s(%d)：round=%d 持有%d+%d>%d(族限窗剩余回合消化不完)',
          ovOk ? '已烧' : '烧被拒',
          skillName(ovId),
          ovId,
          round,
          ovHeld,
          round,
          ROUND_MAX,
        );
        return; // 每拍至多一个写（末回合串行是唯一例外，另段已处理）
      }
    }
  }

  /**
   * 预警式防御（借鉴竞对 onAttacking，server-js.js L16548-16591）：队长节流主动轮询 901，
   *   抓飞向本据点（tInfo sid/x/y）的敌掠袭行军（marchType138/state1/目标=本据点坐标）→ 630 取敌战力
   *   → 仅 `敌 power×1.4 > 队内最强 power`（竞对对弱敌不响应，省自保技）才布防 → 按到达 ETA 分流：
   *   `marchArrive-服务器时刻 < 60s` 用隐形(10)、否则闪现(11)，皆不可用兜底毫发(26)/铜墙(2)。
   *   marchId 去重（#warnAttacked，同 march 只提前布防一次）、每拍至多一个写。
   *   全程 fail-safe：无 tInfo/敌战力未知/我方战力未知/901 空应答 → 跳过不动作（不烧技），交真到达时 21383 被动保命。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 当前回合
   * @returns {Promise<boolean>} 本拍是否已发过一次 7551 写（true=占写额，tick 调用方据此跳过自动项）
   */
  async #warningDefense(treasureId, round) {
    var host = this.#host;
    var st = csHunt.readState();
    var tInfo = st && st.info && st.info.tInfo;
    if (!tInfo || tInfo.x == null || tInfo.y == null || tInfo.sid == null) return false;
    var tx = Number(tInfo.x);
    var ty = Number(tInfo.y);
    var team = host.team() || (st && st.team);
    var myMax = (team && Number(team.maxMemberPower)) || 0;
    if (!(myMax > 0)) return false; // 我方战力未知 → 不提前烧防御技（保守）
    var marches = await host.worldMarches(tx, ty, Number(tInfo.sid));
    if (!marches || !marches.length) return false;
    var nowMs = csHunt.serverMs();
    for (var i = 0; i < marches.length; i++) {
      var m = marches[i] || {};
      if (Number(m.marchType) !== 138 || Number(m.state) !== 1) continue; // 只认在途飞向夺宝点的掠袭行军
      var tgt = m.target || {};
      if (Number(tgt.tx) !== tx || Number(tgt.ty) !== ty) continue; // 只认目标为本据点
      var mid = m.marchId != null ? String(m.marchId) : '';
      if (!mid || this.#warnAttacked.has(mid)) continue;
      var eUid = bits.int64Str(m.uid);
      if (!eUid) continue;
      var ePow = await host.playerPower(eUid);
      if (!(ePow > 0) || !(ePow * WARN_POWER_RATIO > myMax)) {
        this.#warnAttacked.add(mid); // 敌战力未知/弱敌 → 记账跳过，不再重复查该 march
        continue;
      }
      this.#warnAttacked.add(mid);
      var arrStr = bits.int64Str(m.marchArrive);
      var arrMs = arrStr ? Number(arrStr) : 0;
      var eta = arrMs ? arrMs - nowMs : NaN;
      var primary = isFinite(eta) && eta < WARN_ETA_MS ? SKILL_STEALTH : SKILL_FLASH;
      var secondary = primary === SKILL_STEALTH ? SKILL_FLASH : SKILL_STEALTH;
      var order = [primary, secondary, SKILL_SHIELD_BATTLE, SKILL_SHIELD_ROUND];
      await this.#ensureBackpack();
      for (var j = 0; j < order.length; j++) {
        var id = order[j];
        var dk = round + ':warn:' + id;
        if (this.#done.has(dk)) continue;
        // 次数盾 26 只看持有>0（#canUse，同来袭保命口径）；其余走 #canSpend（持有+非生效中+族级限窗）
        if (id === SKILL_SHIELD_BATTLE ? !this.#canUse(id) : !this.#canSpend(id)) continue;
        this.#done.add(dk);
        var ok = await this.#useSkill(treasureId, id, '预警式防御');
        log.info(
          '预警式防御·%s %s(%d)：round=%d 敌uid=%s 敌战力=%d 我最强=%d ETA=%s',
          ok ? '已用' : '用被拒',
          skillName(id),
          id,
          round,
          eUid,
          ePow,
          myMax,
          isFinite(eta) ? Math.round(eta / 1000) + 's' : '未知',
        );
        if (!ok) this.#done.delete(dk); // 写被拒 → 回退幂等键（marchId 去重仍留，不重查该敌），下拍新威胁可重试
        return true; // 无论成败本拍已占一个 7551 写额
      }
      return false; // 敌强坐实但无可用自保技 → 不占写额，交自动项（被动保命兜底）
    }
    return false;
  }

  /**
   * 掠袭时保护最有价值奖励（#1，借鉴竞对 roundFight）：安全锁定(17) 是 group2 个人技，主跑各保各的贵重奖励。
   *   读 7572 奖励背包 → 滤未保护项 → 按 #rewardScore 降序择最贵重者 → 7551{17} 带 param `{protectRewardIdArr:[idStr]}`。
   *   陪跑（拿不到奖励）全程无奖励可保，直接跳过（与 HELPER_EXCLUDE_SKILLS 同调）。每回合至多保护一次。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 当前回合
   */
  async #protectBestReward(treasureId, round) {
    if (this.#host.cfg().mode === 'helper') return; // 陪跑无奖励可保
    if (!this.#usable(SKILL_PROTECT_REWARD)) return;
    var pk = round + ':protect';
    if (this.#done.has(pk)) return;
    await this.#ensureBackpack();
    if (!this.#usable(SKILL_PROTECT_REWARD)) return;
    var ret = await this.#host.sendPB(
      REQ_REWARD_INFO,
      { treasureId: bits.int64(treasureId) },
      '夺宝奖励背包',
    );
    var ack = ret && ret.payload ? ret.payload[REQ_REWARD_FIELD] : null;
    var list = ack && Array.isArray(ack.backpack) ? ack.backpack : [];
    var wl = flattenLuckyPools(this.#host.cfg().luckyRewards);
    var self = this;
    var cands = list
      .filter(function (x) {
        return x && !x.protect && x.id != null;
      })
      .sort(function (a, b) {
        return self.#rewardScore(b, wl) - self.#rewardScore(a, wl);
      });
    if (!cands.length) {
      this.#done.add(pk); // 无未保护项 → 本回合不再重复查 7572
      return;
    }
    var idStr = bits.int64Str(cands[0].id);
    if (!idStr) return;
    this.#done.add(pk);
    var ok = await this.#useSkill(treasureId, SKILL_PROTECT_REWARD, '掠袭保护奖励', {
      param: JSON.stringify({ protectRewardIdArr: [idStr] }),
    });
    if (!ok) this.#done.delete(pk); // 写被拒 → 回退幂等键，下拍重试
  }

  /**
   * 奖励项贵重度计分（#1 排序键）：道具品质为基线，神器（ITEM.type=155）额外加权，命中已勾幸运池再加最高权重。
   * @param {object} r 奖励背包项 `{itemId,...}`
   * @param {number[]} wl 幸运池 itemId 清单
   * @returns {number}
   */
  #rewardScore(r, wl) {
    var row = gameData.tableRow('ITEM', Number(r.itemId));
    var score = (Number(row && row.quality) || 0) * 10;
    if (Number(row && row.type) === 155) score += 500; // 神器（不可翻倍但最贵重）
    if (wl.indexOf(Number(r.itemId)) >= 0) score += 1000; // 命中已勾幸运池
    return score;
  }

  /**
   * 主动侦察行军军情（#2/#4 底座，借鉴竞对 7578 双查）：type1=我方（战力/伤兵齐备）、type2=来袭方。
   *   RECON_MIN_MS 内复用缓存，防每拍刷屏。失败/缺字段按空数组降级，交由调用方 fail-safe。
   * @param {string|number} treasureId 本跑 id
   * @returns {Promise<{mine:object[],enemy:object[]}>}
   */
  async #reconMarches(treasureId) {
    if (this.#lastRecon && Date.now() - this.#lastReconAt < RECON_MIN_MS) return this.#lastRecon;
    var mine = await this.#queryMarch(treasureId, 1);
    var enemy = await this.#queryMarch(treasureId, 2);
    this.#lastRecon = { mine: mine, enemy: enemy };
    this.#lastReconAt = Date.now();
    return this.#lastRecon;
  }

  /**
   * 单侧 7578 查询（#reconMarches 子步）：取 `crossTreasureGetMarchInfos.marchInfos[]`，缺省回空数组。
   * @param {string|number} treasureId 本跑 id
   * @param {number} type 1=我方、2=来袭方
   * @returns {Promise<object[]>}
   */
  async #queryMarch(treasureId, type) {
    var ret = await this.#host.sendPB(
      REQ_GET_MARCH_INFOS,
      { treasureId: bits.int64(treasureId), type: type },
      '行军军情',
    );
    var ack = ret && ret.payload ? ret.payload[REQ_MARCH_FIELD] : null;
    return ack && Array.isArray(ack.marchInfos) ? ack.marchInfos : [];
  }

  /**
   * 定向急救目标（#2，借鉴竞对按战损择人）：我方（type1）armyPower<maxArmyPower 且缺口最大者的 uid。
   *   无伤兵/数据缺失回退 ''（调用方据此不带 tarUid、由服务器自决，与原生 7551{27} 一致）。
   * @param {string|number} treasureId 本跑 id
   * @returns {Promise<string>} 最伤者 uid（字符串），无则 ''
   */
  async #mostDamagedUid(treasureId) {
    var rec = await this.#reconMarches(treasureId);
    var bestUid = '';
    var bestGap = 0;
    for (var i = 0; i < rec.mine.length; i++) {
      var m = rec.mine[i];
      var cur = toNum(m.armyPower);
      var cap = toNum(m.maxArmyPower);
      var gap = cap > cur ? cap - cur : 0;
      if (gap > bestGap) {
        bestGap = gap;
        bestUid = uidToStr(m.uid);
      }
    }
    return bestGap > 0 ? bestUid : '';
  }

  /**
   * 战中自动项（status=FIGHT 相位，每拍至多一个写动作）：
   *   **前提闸一：本回合须真被真人掠袭过（#raidRounds.has(round)）**——实证 FIGHT 是每回合必经的结算相位（无任何 21383 掠袭也逐回合推 fightWin 0→3），
   *     若只判 status=FIGHT 会每回合白烧一发急救 + 提前耗光增益，违背用户口径「无人受伤不治疗」。
   *   **前提闸二（③ 敌强门控，借鉴竞对 roundFight L16442-16458）：掠袭回合内再按 7578 双查战力分流**——
   *     敌「最弱在途军的满员战力×FIGHT_RATIO_HEAVY > 我方最强在途军的现员战力」→ 整队被碾压，先垫一张毫发无伤(26)（每回合一次、烧成即收手）；
   *     仍不达 ×FIGHT_RATIO_LIGHT → 弱敌掠袭，急救/增益不烧留给强敌波。侦察数据缺失（敌或我空）fail-open 保留无条件烧。
   *     注：此闸只管**消耗路**（急救/增益/垫盾），不碰「预警即保命」自保路（用户口径 2026-10-24 保命无战力门控）。
   *   ① 火线急救(27)（group=1 队长技）——**按战损定向施治（#2，借鉴竞对）**：7578 type1 我方 armyPower<maxArmyPower 取缺口最大者 uid 传 tarUid（`#mostDamagedUid`）；
   *     侦察失败/无伤兵数据时回退不带 tarUid、由服务器自决（与原生 7551{27} tarUid=0 一致，实证 dashcam 20261017T185937）；
   *   ② 战中增益族即用（C）——百战不倒/固定增强/战场变换/诱敌来袭按 FIGHT_BUFF_SKILLS 优先级逐个用，每 (round,specId) 一次性，且经 #canSpend 族级限窗去重。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 当前回合
   */
  async #fightStrategies(treasureId, round) {
    // 未被掠袭的回合不进（FIGHT 是常态相位，不等于有人受伤）
    if (!this.#raidRounds.has(round)) return;
    // ② 战斗已结算即收手（借鉴竞对 roundFight 顶闸 `if(!fightInfo || fightInfo.fightWin) return`）：
    //   fightWin 是枚举（报文实证取值 {0,1,2,3}，非布尔）——0=战斗中/未判定，非 0=本回合胜负已结算/结束；
    //   仅在**正向读到已结算（fightInfo 在场、fightWin 字段存在且 fightWin≠0）**时跳过；缺 fightInfo 或缺 fightWin 字段
    //   均走 fail-open（不能把「没读到」当成「已结算」误拦正常防御）：#5 显式判 != null，避免 Number(undefined)!==0 误伤。
    var fi = this.#hunt && this.#hunt.fightInfo;
    if (fi && fi.fightWin != null && Number(fi.fightWin) !== 0) return;
    await this.#ensureBackpack();
    // ③ 敌强门控（借鉴竞对 roundFight L16442-16458）：7578 双查比对军力后决定消耗动作——
    //   敌最弱在途军的满员战力(eCap)×1.3 > 我方最强在途军的现员战力(mPow) → 整队被碾压：先垫一张毫发无伤(26)（竞对 useSkill(16) 同位）；
    //   不达 ×1.5 → 弱敌掠袭，急救/增益一张不烧（留给强敌波）。数据缺失（敌或我任一为空）fail-open 保留旧无条件行为。
    //   竞对口径逐字采用：敌侧取 armyPower 最小者的 maxArmyPower（保守判据：连敌最弱队的满员都压过我方最强，才算碾压）。
    var recF = await this.#reconMarches(treasureId);
    if (recF.enemy.length && recF.mine.length) {
      var eWk = recF.enemy.slice().sort(function (a, b) {
        return toNum(a.armyPower) - toNum(b.armyPower);
      })[0];
      var mTop = recF.mine.slice().sort(function (a, b) {
        return toNum(b.armyPower) - toNum(a.armyPower);
      })[0];
      var eCap = toNum(eWk && eWk.maxArmyPower);
      var mPow = toNum(mTop && mTop.armyPower);
      if (eCap * FIGHT_RATIO_HEAVY > mPow && this.#canUse(SKILL_SHIELD_BATTLE)) {
        var fsk = round + ':fshield';
        if (!this.#done.has(fsk)) {
          this.#done.add(fsk); // 尝试级记账：被拒不回退、同回合不逐拍循环撞被拒写（次数盾「每预警一张」另属保命路）
          var shOk = await this.#useSkill(treasureId, SKILL_SHIELD_BATTLE, '掠袭碾压垫盾');
          log.info(
            '掠袭碾压垫盾·%s 毫发无伤(26)：round=%d 敌满员%d×%s=%d > 我方最强%d',
            shOk ? '已烧' : '烧被拒',
            round,
            eCap,
            FIGHT_RATIO_HEAVY,
            Math.round(eCap * FIGHT_RATIO_HEAVY),
            mPow,
          );
          if (shOk) {
            await this.#reloadBackpack();
            return; // 竞对同律：垫盾成功即本拍收手，急救/增益留下拍（碾压局先活下来再谈输出）
          }
        }
      }
      if (!(eCap * FIGHT_RATIO_LIGHT > mPow)) {
        log.debug(
          '敌强门控·弱敌掠袭省急救/增益：round=%d 敌满员%d×%s=%d ≤ 我方最强%d',
          round,
          eCap,
          FIGHT_RATIO_LIGHT,
          Math.round(eCap * FIGHT_RATIO_LIGHT),
          mPow,
        );
        return;
      }
    }
    // ① 火线急救：每回合一次，持且未生效即施治；能择到战损最重者则带 tarUid 定向施治，否则不带（服务器自决，与原生一致）
    var aidk = round + ':aid';
    if (!this.#done.has(aidk) && this.#canSpend(SKILL_AID)) {
      this.#done.add(aidk);
      var healUid = await this.#mostDamagedUid(treasureId);
      var aidOk = await this.#useSkill(
        treasureId,
        SKILL_AID,
        '火线急救',
        healUid ? { tarUid: healUid } : undefined,
      );
      if (!aidOk) this.#done.delete(aidk);
      await this.#reloadBackpack();
      return;
    }
    // ② 增益即用：本拍无急救可用/已施治 → 增益族逐个（每拍一个）
    for (var i = 0; i < FIGHT_BUFF_SKILLS.length; i++) {
      var id = FIGHT_BUFF_SKILLS[i];
      var bk = round + ':buff:' + id;
      if (!this.#canSpend(id) || this.#done.has(bk)) continue;
      this.#done.add(bk);
      var buffOk = await this.#useSkill(treasureId, id, '战中增益');
      if (!buffOk) this.#done.delete(bk); // 写被拒 → 回退幂等键，下拍重试
      await this.#reloadBackpack();
      return;
    }
  }

  // ── 技能底座（7550/7551） ───────────────────────────────────────────

  /**
   * 拉一次技能背包（7550）缓存 personal/team 两个 specId 集合。每跑首次需要时拉。
   *   **只在拿到有效 skillBackpack 应答时才置 #backpackLoaded=true**：发送失败/在途去重时 ack 空，
   *   若照样置 loaded 会把空背包固化进缓存，后续 #usable(幸运等) 全程误判 false（实证幸运在背包却漏用）。
   *   `force=true` 绕过 loaded 缓存强制作一次权威读：掷骰命中幸运池时用，杜绝 load-once 陈旧缓把「其实有幸运」误判成没有而漏用。
   * @param {boolean} [force] 忽略已落地缓存，强制重拉
   */
  async #ensureBackpack(force) {
    if (this.#backpackLoaded && !force) return;
    var team = this.#host.team();
    if (!team) return;
    var treasureId = team.treasureId || team.id;
    var ret = await this.#host.sendPB(
      REQ_SKILL_BACKPACK_OPEN,
      { treasureId: bits.int64(treasureId) },
      '开技能背包',
    );
    var ack = ret && ret.payload ? ret.payload[REQ_OPEN_FIELD] : null;
    var sb = ack && ack.skillBackpack;
    if (!sb) return; // 拉取失败（ack 空/无 skillBackpack）→ 不落地、不清旧缓存，下一拍自然重试
    var personal = specIdCount(sb.personalSkillInfoList);
    var teamS = specIdCount(sb.teamSkillInfoList);
    var pending = specIdSet(sb.skillPendingEffectInfoList);
    // **空背包（三表皆空）多半是 OPEN 首帧/在途去重的未就绪占位 ack，非「玩家真的一无所有」**：连续前 2 次空不固化、保留旧缓存下拍重试，
    //   否则会把 load-once 缓存毒化成 #personal={} → 掷骰时 #canUse(幸运) 误判 false 漏用幸运（实证 20261018T105933 round6：掷骰前一次 7550 返空 PERSONAL 被固化）
    if (personal.size === 0 && teamS.size === 0 && pending.size === 0 && this.#bpEmptyStreak < 2) {
      this.#bpEmptyStreak++;
      return;
    }
    this.#bpEmptyStreak = 0; // 非空（或连续空满配额确认为真·空）→ 落权威态、清零计数
    this.#commitBackpack(personal, teamS, pending);
  }

  /**
   * 从已算好的三张表提交一份权威背包态并置已落地；顺带清「用后已新鲜」标记（本次是 7550 重拉，非 7551 内嵌回写）。
   * @param {Map<number,number>} personal 个人技能 specId→张数
   * @param {Map<number,number>} teamS 队伍技能 specId→张数
   * @param {Set<number>} pending 生效中 specId
   */
  #commitBackpack(personal, teamS, pending) {
    this.#personal = personal;
    this.#teamSkills = teamS;
    this.#pending = pending;
    this.#backpackLoaded = true;
    this.#bpFreshFromUse = false;
  }

  /**
   * 消耗技能后重拉背包（作废缓存再取，保证 #canUse 反映最新持有）。
   */
  async #reloadBackpack() {
    // 上一步 #useSkill 已用 7551 应答内嵌的 skillBackpack（消耗后权威态）刷新 → 无需再发 7550（省一次往返，且规避「用后立刻 7550 拿到瞬时空背包」，实证 20261018T105933 每次用后 7550 均返空）
    if (this.#bpFreshFromUse) {
      this.#bpFreshFromUse = false;
      return;
    }
    this.#backpackLoaded = false;
    await this.#ensureBackpack();
  }

  /**
   * 该技能本端是否**持有可用**（张数>0；个人技能全员、队伍技能仅队长）。不含阶段/生效态判定。
   * @param {number} id skillSpecId
   * @returns {boolean}
   */
  #canUse(id) {
    if ((this.#personal.get(id) || 0) > 0) return true;
    return (this.#teamSkills.get(id) || 0) > 0 && this.#host.isLeader();
  }

  /**
   * 自动策略路径的统一闸门：持有可用 **且** 该科技当前不在生效中列表（对齐游戏「生效中不重施、逐个用」
   *   ——幸运下次奖励前只用一次、盾/隐身生效期间不叠同一效果）。scene 侧仍用 #canUse（纯持有），不受此闸影响。
   * @param {number} id skillSpecId
   * @returns {boolean}
   */
  #usable(id) {
    return this.#canUse(id) && !this.#pending.has(id);
  }

  /**
   * 自动策略统一闸门（#5，借鉴竞对 skill_limit_round + sci）：在 #usable（持有且非生效中）基础上，叠加**族级限窗本回合去重**——
   *   某 type 在 `SKILL_TYPE_LIMIT[type]` 限窗回合内本回合已用过即拦（防防御/增益类整局逐回合狂烧）。仅自动项走此闸，scene 侧仍用 #usable。
   * @param {number} id skillSpecId
   * @returns {boolean}
   */
  #canSpend(id) {
    if (!this.#usable(id)) return false;
    var row = SKILL_BY_ID[id];
    var lim = row ? SKILL_TYPE_LIMIT[row.type] : 0;
    if (!lim) return true; // 未知/不限族 → 仅受 #usable 约束
    var r = Number(this.#hunt && this.#hunt.round) || 0;
    return this.#typeUseRound[row.type] !== r || lim < r; // 竞对口径：限窗回合内本回合已用过该族→拦
  }

  /**
   * 发一条 7551 使用科技（Int64 treasureId 装箱，skillSpecId 裸数字，对齐 dashcam）。
   * @param {string|number} treasureId 本跑 id
   * @param {number} id skillSpecId
   * @param {string} label 日志标签
   * @param {{param?:string, tarUid?:string|number}} [opt] 可选 param（JSON 串，如复制）与目标 uid（Int64）
   * @returns {Promise<boolean>} 是否被接受
   */
  async #useSkill(treasureId, id, label, opt) {
    var inner = { treasureId: bits.int64(treasureId), skillSpecId: id };
    if (opt) {
      if (opt.tarUid != null) inner.tarUid = bits.int64(opt.tarUid);
      if (opt.param != null) inner.param = opt.param;
    }
    var ret = await this.#host.sendPB(REQ_SKILL_USE, inner, label);
    if (ret.ok) {
      // 优先用 7551 应答内嵌 skillBackpack（消耗后权威态：已扣持有、含最新生效中）刷新缓存，省掉随后的 7550 重拉（借鉴竞对 useSkill 用 crossTreasureSkillUse.skillBackpack 回写）
      var ackUse = ret.payload ? ret.payload[REQ_USE_FIELD] : null;
      var sb = ackUse && ackUse.skillBackpack;
      if (sb) {
        this.#commitBackpack(
          specIdCount(sb.personalSkillInfoList),
          specIdCount(sb.teamSkillInfoList),
          specIdSet(sb.skillPendingEffectInfoList),
        );
        this.#bpFreshFromUse = true; // 紧随的 #reloadBackpack 可据此跳过 7550
      } else {
        this.#backpackLoaded = false; // 无内嵌背包 → 作废缓存，紧随的 #reloadBackpack 走 7550
        this.#pending.add(id); // 乐观记入生效中，防陈旧持有态驱动幽灵重发
      }
      // #5 族级用量记账：成功用后记本回合（供 #canSpend 的限窗本回合去重闸，借鉴竞对 sci[type]=round）
      var rr = Number(this.#hunt && this.#hunt.round) || 0;
      var trow = SKILL_BY_ID[id];
      if (rr && trow && trow.type != null) this.#typeUseRound[trow.type] = rr;
    }
    return ret.ok;
  }

  /**
   * 幸运降临：只在「这次我最大」(rollDice) 场景、掷骰中奖奖励命中已勾幸运池且有个人幸运(18) 时，先 7551 用之。
   *   用户口径 2026-10-17：幸运降临仅服务于 rollDice（其余有奖场景不再触发）；背包剩余幸运的溢出兜底
   *   由 2026-10-25 新增的 #tryLuckyOverflow（有奖场景动作前提前烧）+ 末回合清空 #flushCandidates 两层承接。场景参与判定：cfg.luckyRewards.rollDice 为空（一个都没勾）则直接跳过。
   * @param {string|number} treasureId 本跑 id
   * @param {string} sceneKey 场景 key（EVENT_TYPE 值：仅 rollDice 会真正触发）
   * @param {object|null} rewardResult 含 items:[{itemId,itemCount}] 的奖励体
   * @param {string} label 日志标签
   * @returns {Promise<boolean>} 是否已触发使用幸运
   */
  async #tryLucky(treasureId, sceneKey, rewardResult, label) {
    if (sceneKey !== EVENT_TYPE.ROLL_DICE) return false; // 幸运只在 rollDice 用（溢出兜底走末回合清空）
    var pools = this.#host.cfg().luckyRewards;
    var wl = (pools && pools[sceneKey]) || [];
    if (!wl.length) {
      // 静默漏用的两大盲区之一：幸运池空（未勾任何物品）→ 留痕，使实机「有幸运却没翻倍」可判（此前唯一留痕只覆盖 #usable 分支）
      log.info('幸运×2跳过(' + label + ')：幸运池为空（该场景未勾任何物品）');
      return false;
    }
    if (!rewardResult || !hitWhitelist(rewardResult, wl)) {
      // 静默漏用的两大盲区之二：中奖奖励未命中已勾池（含勾选 id 与实际奖励 id 分歧）→ 留痕两侧 id 便于对账
      var got =
        rewardResult && Array.isArray(rewardResult.items)
          ? rewardResult.items
              .map(function (z) {
                return Number(z.itemId);
              })
              .join(',')
          : '-';
      log.info('幸运×2跳过(' + label + ')：中奖[' + got + '] ∉ 已勾池 ' + JSON.stringify(wl));
      return false;
    }
    await this.#ensureBackpack();
    if (!this.#usable(SKILL_LUCKY)) {
      // 命中已勾幸运池但幸运不可用 → 留痕（下次奖励前只翻一次的正常态 vs 背包未落地/真不持有，便于实机排查漏用）
      var held = this.#personal.get(SKILL_LUCKY) || 0;
      log.info(
        '幸运×2跳过(' +
          label +
          ')：背包已落地=' +
          (this.#backpackLoaded ? 'Y' : 'N') +
          ' 持有=' +
          held +
          ' 生效中=' +
          (this.#pending.has(SKILL_LUCKY) ? 'Y' : 'N'),
      );
      return false;
    }
    return this.#useSkill(treasureId, SKILL_LUCKY, '幸运×2(' + label + ')');
  }

  /**
   * 幸运溢出提前消耗（用户口径 2026-10-25）：有奖场景（主跑）动作前判「背包持有幸运张数是否已多于本回合之后的
   *   剩余消化窗」——剩余窗=ROUND_MAX-round 回合（每回合至多消一张），持有>剩余窗即本回合不消必浪费（实证
   *   20261025T110353 第三跑 round9 持 2 张、后两回合皆非 rollDice，引擎等到 round10 才由清空兑底、用户只能手动提前用）。
   *   溢出时不要求命中已勾池（翻倍落在何种奖励上都好过浪费）；走 #usable 闸（生效中不重施）；仅主跑。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 当前回合
   * @param {string} label 日志标签（场景名）
   * @returns {Promise<boolean>} 是否已触发使用幸运
   */
  async #tryLuckyOverflow(treasureId, round, label) {
    if (this.#host.cfg().mode === 'helper') return false; // 陪跑无奖励可翻
    await this.#ensureBackpack();
    var held = this.#backpackCount(SKILL_LUCKY);
    if (held <= ROUND_MAX - round) return false; // 未溢出：仍留机会给后续 rollDice 白名单触发
    if (!this.#usable(SKILL_LUCKY)) return false;
    var ok = await this.#useSkill(
      treasureId,
      SKILL_LUCKY,
      '幸运×2·溢出提前用(' + label + ' r' + round + ' 持' + held + ')',
    );
    if (ok)
      log.info(
        '幸运溢出：round=%d 持有%d>本回合后剩余%d窗，先在%s场景烧一张翻倍本次奖励',
        round,
        held,
        ROUND_MAX - round,
        label,
      );
    return ok;
  }

  /**
   * 本端视图广播到频道 17（每回合一次；陪跑也发，全员拼合）。
   * @param {number} round 回合
   * @param {string} str 本端视图串（viewToStr 产物）
   */
  #broadcastCode(round, str) {
    if (this.#codeBcast[round] || !str) return;
    this.#codeBcast[round] = true;
    var chat = this.#host.chat;
    if (!chat || typeof chat.send !== 'function') return;
    try {
      var p = chat.send(str, { c: CHAT_CHANNEL_CS_HUNT });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      /* 聊天不可用降级：本端视图发不出，队友汇总缺失，由兜底/留手动处理，不阻断循环 */
    }
  }

  /**
   * 背包里可复制技能集（personal ∪ team，排除 COPY 自身）。
   *   **无视队长身份含队伍技能**：完美镜像(22) 是 group=2 个人技，把队技作为复制目标不需队长权限
   *   （报文实证 20261017T041352 陪跑成员 22{copySkillSpecId:26} 复制队技成功）。否则陪跑永远看不到先知(9)→从不复制。
   * @returns {number[]}
   */
  #copyableSet() {
    var out = [];
    var add = function (m) {
      m.forEach(function (cnt, id) {
        if (id !== SKILL_COPY && cnt > 0 && out.indexOf(id) < 0) out.push(id);
      });
    };
    add(this.#personal);
    add(this.#teamSkills);
    return out;
  }

  /**
   * 背包中该 specId 的持有张数（personal + team 求和，与队长身份无关——剪枝/复制只看总持有量）。
   * @param {number} id skillSpecId
   * @returns {number}
   */
  #backpackCount(id) {
    return (this.#personal.get(id) || 0) + (this.#teamSkills.get(id) || 0);
  }

  /**
   * 末回合清空候选池：队长=team∪personal，队员=personal；剔除事件门（先知9/刷新23）。
   * @returns {number[]}
   */
  #flushCandidates() {
    var out = [];
    // 幸运降临(18) 不列入本排除集：主跑正常只在 rollDice 用，若到末回合背包仍有剩余（未被 rollDice 消化完的溢出）
    //   就在此无脑清空——这是用户口径「幸运只在 rollDice 用、溢出兜底归科技使用策略」的兜底落点。
    // 陪跑额外跳过「只对领奖有意义」的科技（幸运降临18/安全锁定17）：即使经复制/转换间接持有也不浪费在末回合清空
    var skip =
      this.#host.cfg().mode === 'helper'
        ? FLUSH_EXCLUDE.concat(HELPER_EXCLUDE_SKILLS)
        : FLUSH_EXCLUDE;
    var add = function (m) {
      m.forEach(function (cnt, id) {
        if (cnt > 0 && skip.indexOf(id) < 0 && out.indexOf(id) < 0) out.push(id);
      });
    };
    add(this.#personal);
    if (this.#host.isLeader()) add(this.#teamSkills);
    // ⑧ 完美镜像(22) 置顶（借鉴竞对 clearAllSkills 先循环 drain COPY）：末回合先把剩余科技复制出来，
    //   复制出的新技在随后拍继续被清，不带走不亏；其余保持原序（掠袭保护另有每回合 #protectBestReward 主路）。
    var ci = out.indexOf(SKILL_COPY);
    if (ci > 0) {
      out.splice(ci, 1);
      out.unshift(SKILL_COPY);
    }
    return out;
  }

  // ── 生命周期收尾 ────────────────────────────────────────────────────

  /**
   * 收引擎（TeamEngine.pause/stop 调）：清所有 per-round 与背包缓存，防 resume 后拿陈旧态重发写请求。
   */
  reset() {
    this.#hunt = null;
    this.#resetFor('');
  }

  /**
   * 换跑重置所有 per-round 状态。
   * @param {string} key 新 treasureId
   */
  #resetFor(key) {
    this.#huntKey = key;
    this.#done.clear();
    this.#codeTried = {};
    this.#lastCodeAt = 0;
    this.#personal.clear();
    this.#teamSkills.clear();
    this.#pending.clear();
    this.#backpackLoaded = false;
    this.#bpEmptyStreak = 0;
    this.#bpFreshFromUse = false;
    this.#raidSize = 0;
    this.#raidAt = 0;
    this.#raidRounds.clear();
    this.#lastFightWake = 0;
    this.#flushedRound = 0;
    this.#typeUseRound = {};
    this.#lastRecon = null;
    this.#lastReconAt = 0;
    this.#reconCheckedRounds.clear();
    this.#warnAttacked.clear();
    this.#lastWarnAt = 0;
    this.#enterAt = {};
    this.#refreshCount = {};
    this.#peerViews = {};
    this.#codeBcast = {};
    this.#codeBoxEnterAt = {};
  }

  /**
   * 唤醒兜底循环。
   */
  #wake() {
    if (this.#host && typeof this.#host.onWake === 'function') this.#host.onWake();
  }
}

/**
 * 当前队伍对应的 treasureId 记账键。
 * @param {FlowHost} host 运行底座
 * @returns {string}
 */
function hostTeamKey(host) {
  var t = host.team();
  return t ? String(t.treasureId || t.id || '') : '';
}

/**
 * play 态已揭示（非 0）的候选 0-based 下标。
 * @param {Array<number>} list eventSpecIdList
 * @returns {number[]}
 */
function revealedIndices(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) if (Number(list[i]) > 0) out.push(i);
  return out;
}

/**
 * 同族多位命中时随机择位（用户口径 2026-10-17：固定取第一个命中位会让同一位置总被选中，要「稍微随机一些」）：
 *   在 hits（0-based 下标集）里等概率取一个，回 1-based indexDecide。
 * @param {number[]} hits 0-based 命中下标（非空）
 * @returns {number} 1-based
 */
function pickRandomHit(hits) {
  return hits[Math.floor(Math.random() * hits.length)] + 1;
}

/**
 * 先知感知择法：revealed 里按 [1002 rollDice,1004 pickSkill] 优先（同族多位随机择一）；都不在 → hidden 随机（1006 永不选）；
 *   无 hidden → revealed 里随机取一个非 nothing。
 * @param {Array<number>} list 候选 eventSpecId
 * @param {number[]} rev revealed 0-based 下标
 * @returns {number} 1-based indexDecide（0=不选）
 */
function chooseProphet(list, rev) {
  var fams = list.map(function (id) {
    return Math.floor(Number(id) / 100);
  });
  var prefer = [1002, 1004];
  for (var p = 0; p < prefer.length; p++) {
    var hits = rev.filter(function (ix) {
      return fams[ix] === prefer[p];
    });
    if (hits.length) return pickRandomHit(hits);
  }
  var hidden = [];
  for (var h = 0; h < list.length; h++) if (Number(list[h]) === 0) hidden.push(h);
  if (hidden.length) return hidden[Math.floor(Math.random() * hidden.length)] + 1;
  var nonNothing = rev.filter(function (ix) {
    return fams[ix] && fams[ix] !== 1006;
  });
  if (nonNothing.length) return nonNothing[Math.floor(Math.random() * nonNothing.length)] + 1;
  return 0;
}

/**
 * show 态（全 6 位明文）择法：按 [1002,1004,1001,1003,1005] 取命中的优先族、跳过 1006，同族多位命中随机择一。
 * @param {Array<number>} list 候选 eventSpecId
 * @returns {number} 1-based indexDecide（无命中退兜底随机）
 */
function chooseFromFull(list) {
  var fams = list.map(function (id) {
    return Math.floor(Number(id) / 100);
  });
  var prefer = [1002, 1004, 1001, 1003, 1005];
  for (var p = 0; p < prefer.length; p++) {
    var hits = [];
    for (var i = 0; i < fams.length; i++) if (fams[i] === prefer[p]) hits.push(i);
    if (hits.length) return pickRandomHit(hits);
  }
  return fallbackIndex(list) || 1;
}

/**
 * 兜底择位：在所有非 0 非 nothing 的位里随机取一（用户口径：固定取首位会让同一位置总被选中）；
 *   无揭示非 nothing 位退第一个非 nothing（此时 nothing 是唯一明牌，不盲选它）；再无退 1。
 * @param {Array<number>} list 候选 eventSpecId
 * @returns {number} 1-based indexDecide
 */
function fallbackIndex(list) {
  var fams = list.map(function (id) {
    return Math.floor(Number(id) / 100);
  });
  var hits = [];
  for (var i = 0; i < fams.length; i++) if (fams[i] && fams[i] !== 1006) hits.push(i);
  if (hits.length) return pickRandomHit(hits);
  var firstNotNothing = fams.findIndex(function (f) {
    return f !== 1006;
  });
  return firstNotNothing >= 0 ? firstNotNothing + 1 : 1;
}

/**
 * 技能列表 `[{skillSpecId}]` → Map<specId, 持有张数>（同 id 出现几条即几张，背包平铺无 count 字段）。
 * @param {*} arr 原始列表
 * @returns {Map<number,number>}
 */
function specIdCount(arr) {
  var m = new Map();
  if (Array.isArray(arr)) {
    for (var i = 0; i < arr.length; i++) {
      var id = Number(arr[i] && arr[i].skillSpecId);
      if (id) m.set(id, (m.get(id) || 0) + 1);
    }
  }
  return m;
}

/**
 * 技能列表 `[{skillSpecId}]` → Set<specId>（去重；用于 skillPendingEffectInfoList 生效集，只关心「有没有生效」）。
 * @param {*} arr 原始列表
 * @returns {Set<number>}
 */
function specIdSet(arr) {
  var s = new Set();
  if (Array.isArray(arr)) {
    for (var i = 0; i < arr.length; i++) {
      var id = Number(arr[i] && arr[i].skillSpecId);
      if (id) s.add(id);
    }
  }
  return s;
}

/**
 * 奖励体的 items 是否命中幸运奖励池 itemId。
 * @param {object|null} rewardResult 含 items:[{itemId}]
 * @param {number[]} whitelist 池
 * @returns {boolean}
 */
function hitWhitelist(rewardResult, whitelist) {
  if (!whitelist || !whitelist.length) return false;
  var items = rewardResult && Array.isArray(rewardResult.items) ? rewardResult.items : [];
  for (var i = 0; i < items.length; i++) {
    if (whitelist.indexOf(Number(items[i].itemId)) >= 0) return true;
  }
  return false;
}

/**
 * 数值归一（战力/兵力门控用）：非有限或 ≤0 一律回 0，杜绝 NaN/负值污染阈值比较。
 * @param {*} v 原始值（可能是数字/字符串/undefined）
 * @returns {number}
 */
function toNum(v) {
  var n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * uid 归一为字符串（7578 marchInfos[].uid 实测为字符串，兼容对象态的 Int64）。
 * @param {*} v 原始 uid（字符串 / `{_low,_high}` 对象 / null）
 * @returns {string} 归一字符串，空则 ''
 */
function uidToStr(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'object') return bits.int64Str(v) || '';
  return String(v);
}

/**
 * cfg.luckyRewards（各场景 itemId 数组）→ 扁平去重的 itemId 清单（掠袭保护奖励 #rewardScore 的幸运加权依据）。
 * @param {Object<string,number[]>|undefined} pools 幸运池（场景 key→itemId 数组）
 * @returns {number[]}
 */
function flattenLuckyPools(pools) {
  var out = [];
  if (!pools) return out;
  var keys = Object.keys(pools);
  for (var i = 0; i < keys.length; i++) {
    var arr = pools[keys[i]];
    if (!Array.isArray(arr)) continue;
    for (var j = 0; j < arr.length; j++) {
      var id = Number(arr[j]);
      if (id && out.indexOf(id) < 0) out.push(id);
    }
  }
  return out;
}
