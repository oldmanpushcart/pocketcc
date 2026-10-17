/**
 * feats/activity/cs-hunt/engine-flow.js —— 夺宝奇兵（CSHunt）**场景流程编排引擎**（取代 engine-event.js）。
 *
 * 生命周期对齐源码 CSHuntPhaseType={DECIDE:"decide",EVENT:"event"}，由 TeamEngine 经 `#flowHost()` 窄接口驱动
 *   （alive/cfg/team/isLeader/sendPB/onWake/chat），本引擎不反向 import 装配层、不自己摸 net/bus、不自建定时器。
 *   一场（round）四相位（报文实证 status：WAIT=探索 → EVENT/decide=选择 → EVENT/event=交互 → FIGHT=战斗）：
 *   - `WAIT`（探索回合，status=1）转场串联（顺序）：① 有数据转换(24)→7551{24} 立即用 → 重拉背包
 *     ② 有复制(22)→7551{22,param:copySkillSpecId} 复制先知（用户策略「转换后重判是否有值得复制的科技」，严格只复制先知）；
 *     每用一发即 7550 刷新背包再判下一项；均本回合一次性去重。复制目标含队伍技能（22/24 皆 group=2 个人技，陪跑成员可用）。
 *   - `DECIDE.play`：队长且有先知(9)→7551{9} 提前揭示（先知 group=1 队长专属、type5 游戏强制仅 DECIDE，故留此阶段）。
 *   - `DECIDE.show`/剩余倒计时≤ DECIDE_ACT_MS(10s)：先知感知选法发 7532{indexDecide}（详见「选场景」段）。
 *   - `EVENT`（场景进入+交互）：按 `Math.floor(eventSpecId/100)` 命中 6 族分派给 `./scenes/*`，调 `scene.handle(ctx)`。
 *   - 结束：无动作（交 TeamEngine/游戏）。
 *
 * 横切自动项（默认开、无 UI）：
 *   - 来袭保命：21383 marchSize>0 且时效窗内 → 队长按 DEFENSE_PRIORITY（隐形10>毫发盾26>回合盾2>闪现11，皆 group=1）用一；
 *   - 盾维持：WAIT 转场串联后主动消耗一盾（毫发优先、铜墙仅 round<10），不等来袭白压到末回合；
 *   - 战中策略（FIGHT 相位且**本回合真被掠袭过**才动手）：火线急救(27·不带 tarUid 服务器自决治谁) → 增益族逐个（FIGHT 是每回合必经结算相位，未挨打也进，无掠袭证据即不动）；
 *   - 末回合清空：round===ROUND_MAX(10) → 逐拍清空背包可主动技能（排除先知9/刷新23/回合盾2——第 10 回合用它已无「下个回合」可抵御，陪跑仅 personal）。
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
import { bits, csHunt, gameData } from '../../../core/game-api.js';
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
  REQ_HUNT_INFO,
  REQ_SKILL_BACKPACK_OPEN,
  REQ_SKILL_USE,
  ROUND_MAX,
  SKILL_AID,
  SKILL_COPY,
  SKILL_FLASH,
  SKILL_LUCKY,
  SKILL_PROPHET,
  SKILL_REFRESH,
  SKILL_SHIELD_BATTLE,
  SKILL_SHIELD_ROUND,
  SKILL_STEALTH,
  SKILL_TRANSFER,
} from './constants.js';
import {
  isFullyKnown,
  merge,
  nextUntried,
  parseCodeViews,
  solveCandidates,
  viewToStr,
} from './codebox.js';
import { canPhase, chooseCopyTarget } from './skills.js';
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
/** @type {number[]} 来袭保命优先级（皆 group=1 队伍技能=队长专属）：隐形>毫发(战斗盾)>铜墙(回合盾)>闪现（用户口径 2026-10-17：闪现「下回合开始才移动」救不了当轮→降到盾后） */
const DEFENSE_PRIORITY = [SKILL_STEALTH, SKILL_SHIELD_BATTLE, SKILL_SHIELD_ROUND, SKILL_FLASH];
/** @type {number[]} 末回合清空排除项（先知 9 有 DECIDE 事件门、全量刷新 23 仅 pickSkill 场景有意义、铜墙铁壁 2 第 10 回合用「抵御下个回合」已无下回合=浪费） */
const FLUSH_EXCLUDE = [SKILL_PROPHET, SKILL_REFRESH, SKILL_SHIELD_ROUND];
/** @type {number} 21383 marchSize>0 后视为「正在被攻」的时效窗（毫秒），窗内才保命 */
const RAID_ACTIVE_MS = 30000;
/** @type {number} FIGHT 态推送唤醒的最小间隔（毫秒）：21376 每回合在 FIGHT 窗推 4~10 条，限流防把 4s 节奏加密成逐推送一拍 */
const WAKE_MIN_MS = 3000;

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
 * @property {() => object|null} team 当前队伍快照（含 id/treasureId/status）
 * @property {() => boolean} isLeader 本人是否队长
 * @property {(cmd:number, inner:object, label:string) => Promise<{ok:boolean, code:number, payload:object|null}>} sendPB 发 V1 PB（复用 TeamEngine 的 REQ_FIELD 装箱与幂等闸）
 * @property {() => void} onWake 唤醒兜底循环
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
      // 探索回合（每场 round 起始 status=1/WAIT）：数据转换→重拉背包→再判并执行完美镜像复制先知；转场未发写包时再主动维持盾（毫发/铜墙）
      var wrote = await this.#explorationSkills(treasureId, round);
      if (!wrote) await this.#shieldMaintain(treasureId, round);
    } else if (status === HUNT_STATUS.FIGHT) {
      // 战斗结算相位（status=3，**每回合必经、未挨打也进**，实证 20261016T191700 全程无 21383 掠袭仍每回合成对推 fightWin 0→3）：
      //   增益/急救仅本回合真被掠袭过（#raidRounds）才动手，否则每回合白烧急救与增益；非掠袭回合直接闲置
      await this.#fightStrategies(treasureId, round);
    }
    // 横切自动项：来袭保命 / 末回合清空（与事件阶段无关，各自门控）
    await this.#autoStrategies(treasureId, status, round);
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
      var target = chooseCopyTarget({ copyable: this.#copyableSet() });
      if (target) {
        await this.#useSkill(treasureId, SKILL_COPY, '完美镜像复制先知', {
          param: JSON.stringify({ copySkillSpecId: target }),
        });
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
      ensureBackpack: function () {
        return self.#ensureBackpack();
      },
      canUse: function (id) {
        return self.#canUse(id);
      },
      useSkill: function (id, label, opt) {
        return self.#useSkill(treasureId, id, label, opt);
      },
      tryLucky: function (sceneKey, rewardResult, label) {
        return self.#tryLucky(treasureId, sceneKey, rewardResult, label);
      },
      backpackReady: function () {
        return self.#backpackLoaded;
      },
      luckyHit: function (rewardResult) {
        var pools = self.#host.cfg().luckyRewards;
        var wl = (pools && pools[EVENT_TYPE.ROLL_DICE]) || [];
        return wl.length > 0 && !!rewardResult && hitWhitelist(rewardResult, wl);
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
   * 事件无关的自动技能推进：来袭保命（队长队技）→ 末回合清空。每拍至多一个写动作（#sendPB 同 cmd 在途去重）。
   * @param {string|number} treasureId 本跑 id
   * @param {number} status 本跑状态
   * @param {number} round 当前回合
   */
  async #autoStrategies(treasureId, status, round) {
    // 1) 来袭保命：21383 marchSize>0 且未超时效窗 → 队长按优先级用一盾/隐身/闪现（皆 group=1，队员无）
    if (this.#raidSize > 0 && Date.now() - this.#raidAt <= RAID_ACTIVE_MS) {
      await this.#ensureBackpack();
      for (var i = 0; i < DEFENSE_PRIORITY.length; i++) {
        var id = DEFENSE_PRIORITY[i];
        var dk = round + ':def:' + id;
        if (!this.#usable(id) || this.#done.has(dk)) continue;
        this.#done.add(dk);
        await this.#useSkill(treasureId, id, '来袭保命');
        break;
      }
      this.#raidSize = 0; // 本波已处置，等下一次 21383 再武装
      return;
    }
    // 2) 末回合清空：round===ROUND_MAX 时逐拍用掉一个可主动技能（排除先知/刷新；陪跑只刷 personal）
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
        await this.#useSkill(treasureId, sid, '末回合清空');
        flushedOne = true;
        break;
      }
      if (!flushedOne) this.#flushedRound = round; // 池空或全用过 → 本回合清空完成
    }
  }

  /**
   * 盾主动维持（B，用户口径 2026-10-17）：WAIT 探索回合转场串联之后主动消耗盾，不再被动压到末回合浪费。
   *   毫发难伤（战斗盾，「下次战斗抵御」→早用零损失）优先；其次铜墙铁壁（回合盾，「抵御下回合」→仅 round<10 用，
   *   第 10 回合用了也无下回合=浪费，与末回合清空剔除项同调）。每回合至多一盾；group=1 天然仅队长可用。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 当前回合
   */
  async #shieldMaintain(treasureId, round) {
    await this.#ensureBackpack();
    var mk = round + ':maint';
    if (this.#done.has(mk)) return;
    var pick = this.#usable(SKILL_SHIELD_BATTLE)
      ? SKILL_SHIELD_BATTLE
      : round < ROUND_MAX && this.#usable(SKILL_SHIELD_ROUND)
        ? SKILL_SHIELD_ROUND
        : 0;
    if (!pick) return;
    this.#done.add(mk);
    var ok = await this.#useSkill(treasureId, pick, '盾维持');
    if (!ok) this.#done.delete(mk); // 写被拒（在途去重/限额）→ 回退幂等键，下拍重试，不失一回合维持位
    await this.#reloadBackpack();
  }

  /**
   * 战中自动项（status=FIGHT 相位，每拍至多一个写动作）：
   *   **前提闸：本回合须真被真人掠袭过（#raidRounds.has(round)）**——实证 FIGHT 是每回合必经的结算相位（无任何 21383 掠袭也逐回合推 fightWin 0→3），
   *     若只判 status=FIGHT 会每回合白烧一发急救 + 提前耗光增益，违背用户口径「无人受伤不治疗」。
   *   ① 火线急救(27)（group=1 队长技）——**逐员战损字段不可得**（power 受击不降/fightInfo 无伤兵/7578 armyPower undefined），
   *     且原生 7551{27} 实发**不带 tarUid**（应答回显 tarUid=0=服务器自决治谁，实证 dashcam 20261017T185937），故跟齐原生形态不带 tarUid、由服务器裁决目标；
   *   ② 战中增益族即用（C）——百战不倒/固定增强/战场变换/诱敌来袭按 FIGHT_BUFF_SKILLS 优先级逐个用，每 (round,specId) 一次性。
   * @param {string|number} treasureId 本跑 id
   * @param {number} round 当前回合
   */
  async #fightStrategies(treasureId, round) {
    // 未被掠袭的回合不进（FIGHT 是常态相位，不等于有人受伤）
    if (!this.#raidRounds.has(round)) return;
    await this.#ensureBackpack();
    // ① 火线急救：每回合一次，持且未生效即施治（不带 tarUid，与原生一致，服务器自决目标）
    var aidk = round + ':aid';
    if (!this.#done.has(aidk) && this.#usable(SKILL_AID)) {
      this.#done.add(aidk);
      var aidOk = await this.#useSkill(treasureId, SKILL_AID, '火线急救');
      if (!aidOk) this.#done.delete(aidk);
      await this.#reloadBackpack();
      return;
    }
    // ② 增益即用：本拍无急救可用/已施治 → 增益族逐个（每拍一个）
    for (var i = 0; i < FIGHT_BUFF_SKILLS.length; i++) {
      var id = FIGHT_BUFF_SKILLS[i];
      var bk = round + ':buff:' + id;
      if (!this.#usable(id) || this.#done.has(bk)) continue;
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
   */
  async #ensureBackpack() {
    if (this.#backpackLoaded) return;
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
    this.#personal = specIdCount(sb.personalSkillInfoList);
    this.#teamSkills = specIdCount(sb.teamSkillInfoList);
    this.#pending = specIdSet(sb.skillPendingEffectInfoList);
    this.#backpackLoaded = true;
  }

  /**
   * 消耗技能后重拉背包（作废缓存再取，保证 #canUse 反映最新持有）。
   */
  async #reloadBackpack() {
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
      this.#backpackLoaded = false; // 消耗后背包态变（close_after / ×1）
      // 乐观记入生效中：使紧随的 #reloadBackpack 若拉取失败（早返回不清 #pending）也不会拿「消耗前陈旧持有态」驱动幽灵重发
      this.#pending.add(id);
    }
    return ret.ok;
  }

  /**
   * 幸运降临：只在「这次我最大」(rollDice) 场景、掷骰中奖奖励命中已勾幸运池且有个人幸运(18) 时，先 7551 用之。
   *   用户口径 2026-10-17：幸运降临仅服务于 rollDice（其余有奖场景不再触发）；背包剩余幸运的溢出兜底
   *   改由「科技使用策略·末回合清空」#flushCandidates 无脑用掉。场景参与判定：cfg.luckyRewards.rollDice 为空（一个都没勾）则直接跳过。
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
    if (!wl.length) return false; // 该场景未勾任何物品 → 不参与幸运判定
    if (!rewardResult || !hitWhitelist(rewardResult, wl)) return false;
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
    this.#raidSize = 0;
    this.#raidAt = 0;
    this.#raidRounds.clear();
    this.#lastFightWake = 0;
    this.#flushedRound = 0;
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
