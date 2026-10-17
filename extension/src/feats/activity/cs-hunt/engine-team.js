/**
 * feats/activity/cs-hunt/engine-team.js —— 夺宝奇兵（CSHunt）组队编排引擎（P1 队长最小闭环）。
 *
 * 覆盖链路（设计文档 extension/docs/feat-夺宝奇兵.md §3，分期见 §8）：
 *   1. 队长无队 → 7521 建队（`{cfg:1}`，报文实证 dashcam 20261016T191700）；
 *   2. 队长审批 → 21374 置脏 → 7528 复核申请池 → 池内 7523 `{uid,op:1}`（池外按配置忽略/拒绝）；
 *   3. 队长凑够 targetMemberNum 且全员派兵到位（每人 marchId 非零）→ 7527 `{op:1}` 发起出发召集（服务端随后派 21372 给全队）；
 *   4. 两角色共用：入队后表态要奖励/陪跑 7520 `{op:1|2}`（队长恒要奖励，不发此包）；
 *      本人满编出征 7519（NET.send，`{marchType:137,...}`，体内无 treasureId）；
 *      收 21372 召集 → 7527 `{op:1}` 同意出发。
 *
 * 编排时序（报文实证，勿凭直觉改）：
 *   陪跑趟 dashcam 20261016T190507：7522 申请 → 21371 入队 → 7520 `{op:2}` → 7519 出征 →
 *     21372 召集 → 7527 `{op:1}` → 21376 status=0（MARCHING）。
 *   **先满编出征、后应答召集**——7519 把本人部队派到集结点，7527 才是「我准备好了」。
 *   队长趟 dashcam 20261016T191700：7521 → 7528 → 7519 → 7523×n → 7527（人数到齐且全员派兵到位后召集）。
 *
 * 幂等与去重：
 *   - 7519 同内容连发两条间隔 23s 均 s=0（重复发包无害，报文实证），但仍按 teamId 记一次、失败才重试；
 *   - 每个写请求经 net.isSending(cmd) 在途去重；
 *   - 队伍快照一律由应答/推送落地（不镜像游戏数据、不调游戏 updateXxx，遵守 feat 只读+发包红线）。
 *
 * 已知缺口（不阻塞本闭环）：
 *   - huntCount 只由推送 21375 喂（游戏侧同款口径：RealCSHuntController.updateUserCrossTreasureChange），
 *     新会话未收到该推送时 count 为「未知」，此时不硬拦建队，交服务器裁决；
 *   - 控制器实例未接管（没进过玩法子包）时 csHunt.readState() 恒 null，故 tick 按 INFO_REFRESH_MS 兜底周期
 *     重发一次只读 7501（应答也可能带整队，实证 dashcam 20261016T191700 seq88）。
 *
 * P2 队员/陪跑（本期新增）：
 *   - 玩法模式 cfg.mode：'main'（主跑，要奖励耗次数）/ 'helper'（陪跑，op:2 不耗次数）；角色不再靠单列开关，而是 mode 驱动；
 *   - 无队且不该自己开车（仅 helper）→ 逐个玩家池成员用 630 PLAYER_INFO 取名 → 7530 按名（likeName）搜该玩家创建的未满队 → 7522 申请入队（不再扫 7526）；main 一律自己建队开车；
 *   - 次数不足且勾了 useBeaconWhenShort → 走通用使用物品 815 消耗定位信标(47001001) 补次数（§7-6 已报文关闭）。
 */
import { Battle } from '../../../core/battle.js';
import { bits, csHunt, gameData } from '../../../core/game-api.js';
import { createLog } from '../../../core/log.js';
import { FlowEngine } from './engine-flow.js';
import {
  ACK_APPLY_LIST,
  ACK_HUNT_INFO,
  ACK_INFO,
  ACK_SEARCH_TEAM_LIST,
  ACK_TEAM_CREATE,
  CMD_ITEM_USE,
  FIELD_APPLY_CHANGE,
  FIELD_HUNT_INFO_CHANGE,
  FIELD_HURT_MARCH_SIZE,
  FIELD_MEMBER_CHANGE,
  FIELD_READY_CHANGE,
  FIELD_TEAM_CHANGE,
  FIELD_USER_CHANGE,
  HUNT_STATUS,
  HUNT_STATUS_PAYLOAD,
  ITEM_BEACON,
  MARCH_TYPE_CS_TEAM_HUNT,
  REQ_HUNT_INFO,
  REQ_MARCH_START,
  REQ_INFO,
  REQ_TEAM_APPLY_LIST,
  REQ_TEAM_APPLY_OP,
  REQ_TEAM_APPLY_OR_CANCEL,
  REQ_TEAM_CREATE,
  REQ_SEARCH_TEAM_LIST,
  REQ_FIELD,
  REQ_TEAM_MARCH,
  REQ_TEAM_USE_ITEM,
  TEAM_STATUS,
} from './constants.js';

/** @type {ReturnType<createLog>} feat 日志器（tag=CSHUNT） */
const log = createLog('CSHUNT');

/** @type {number} 未真正发出的哨兵码（与 core/march.js / alliance-behemoth.js 同义） */
const CODE_NOT_SENT = -1;

/** @type {number} 建队 cfg（= 控制器 specId；真机 dump 与四趟报文恒 1，见 §9/§9.4） */
const TEAM_CFG = 1;

/** @type {number} 跑动中/凑人期的兜底重扫间隔（毫秒）：主推进靠 push，这里只是漏推自愈 */
const ACTIVE_TICK_MS = 15000;
/** @type {number} 无队且暂不可开车时的长睡间隔（毫秒） */
const IDLE_TICK_MS = 60000;
/** @type {number} 7501 只读拉态的兜底周期（毫秒）：控制器未接管（子包没进过）时队伍/开关态的唯一补齐通道 */
const INFO_REFRESH_MS = 90000;
/** @type {number} 630 PLAYER_INFO：按 uid 查玩家昵称（陪跑按名搜队用；业务强相关报文，收口本 feat，不入通用 net.js） */
const CMD_PLAYER_INFO = 630;
/** @type {number} 无队找队时逐个按名搜队（630→7530→7522）的最小拉取间隔（毫秒）：一趟遍历多打网络，不逐拍刷 */
const JOIN_POLL_MS = 25000;
/** @type {number} 同一目标定位信标消耗的最小间隔（毫秒）：防 21375 未到时逐拍重复消耗（每次都是真道具） */
const BEACON_COOLDOWN_MS = 20000;
/**
 * @type {Set<string>} 7531 拉本跑详情命中即「本次出征已结束」的服务器权威终局拒因（多语言键）：
 *   cs_treasure294=夺宝奇兵小队不存在（字典表.txt L42336，实证日志 `code=3 reason=cs_treasure294`）。
 *   命中即停止对已消亡 treasureId 的空拉（否则游戏会一直弹「小队不存在」），清队转下一轮。
 */
const HUNT_OVER_REASONS = new Set(['cs_treasure294']);

/**
 * @typedef {object} TeamEnv 引擎的外部依赖（由 index.js 注入，避免引擎直接摸 reactor/core 单例造成环）
 * @property {() => boolean} alive feat 是否仍激活（在飞 await 回来后的唯一退出判据）
 * @property {() => object} cfg 当前模块配置（presetPool/targetMemberNum/rolePool/needRewardAsMember…）
 * @property {() => object|null} net 网络底座（懒取：install 可能早于 pocketcc.net 就绪）
 * @property {(s:string) => void} onWake 状态变更唤醒（接 createCycle.kick）
 */

/**
 * 归一化 uid 列表 → Set<string>（rolePool 是 uidlist `[{uid,name}]`，也接受裸字符串数组）。
 * @param {*} raw 面板配置原值
 * @returns {Set<string>} 非空 uid 集合
 */
function poolSet(raw) {
  var s = new Set();
  var arr = Array.isArray(raw) ? raw : [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i];
    var uid = bits.int64Str(it && typeof it === 'object' ? it.uid : it);
    if (uid) s.add(uid);
  }
  return s;
}

/**
 * 从池里挑第一个「能出兵」的战斗预设并组 MarchData（纯本地读预设 + adjust 排除在途，零发包）。
 * 与 auto-hunt / 惧星集结同语义：armyListNew 空多半是该部队全在外；配了英雄但可派英雄为空是回城推送
 *   与英雄释放的竞争窗口——均视为该预设本轮不可用、顺延下一个。
 * @param {number[]} presets 预设池（1~8，有序去重）
 * @returns {object|null} MarchData 或 null（全池无兵）
 */
function buildPlanFromPool(presets) {
  for (var i = 0; i < presets.length; i++) {
    var plan = new Battle().plan().preset(presets[i]).adjust().build();
    if (!plan.armyListNew.length) continue;
    if (plan.presetHasHeroes && !plan.heroList.length) continue;
    return plan;
  }
  return null;
}

/**
 * 夺宝奇兵组队引擎。生命周期由 index.js 的 reactor spec 管：start(ctx) 订阅、tick() 兜底调和、stop() 收自建状态。
 */
export class TeamEngine {
  /** @type {TeamEnv} 外部依赖 */
  #env;
  /**
   * 当前队伍快照（csHunt.readTeam 同形：id/uid/cfg/status/treasureId/memberCount/memberUids/readyCount/readyUids…）。
   * @type {object|null}
   */
  #team = null;
  /** @type {number|null} 剩余夺宝次数（唯一来源是推送 21375，null=本会话还没收到过，即「未知」） */
  #count = null;
  /**
   * 活动开关态（crossTreasureInfo.open：1=组队夺宝开、3=休赛，其余未开/雷达）。控制器不在场（子包未接管）时
   *   readState 恒 null，这是建队/找队前判「活动是否进行中」的唯一依据；由 7501 应答落地，null=本会话未收到（未知）。
   * @type {number|null}
   */
  #openFlag = null;
  /**
   * 每日夺宝时段表（csHunt.parseSchedule 解析 7501 应答 openTime[] 而得，每项 {begin,end} 服务器毫秒）。
   *   open===1 是赛季旗标（整天为真），真正「到点可开跑」须落在某个时段内；null=本会话未收到 7501（未知）。
   * @type {Array<{begin:number,end:number}>|null}
   */
  #slots = null;
  /** @type {string} 已发过 7520（要奖励/陪跑表态）的队伍 id */
  #useItemTeamId = '';
  /** @type {string} 已发过 7519（满编出征）的队伍 id */
  #marchedTeamId = '';
  /** @type {string} 已发过 7527（召集/表态）的队伍 id——本端主动召集与应答召集共用此闸 */
  #marchStartTeamId = '';
  /** @type {boolean} 收到过本队 21372 召集（召集已发出，队员只需表态同意） */
  #called = false;
  /** @type {Set<string>} 已处理过的入队申请 uid（防同一申请重复审批） */
  #approved = new Set();
  /** @type {boolean} 申请池脏（收到 21374 或刚建队）：下一拍拉 7528 复核 */
  #applyDirty = false;
  /** @type {string} 已就「无兵可派」留痕过的队伍 id（每队只 info 一次，避免逐拍刷屏） */
  #noArmyLoggedTeamId = '';
  /** @type {string} 已就「不可开车」留痕的原因（同类原因只 info 一次） */
  #blockedLoggedReason = '';
  /** @type {number} 上次 7501 拉态的墙上时刻（毫秒），兜底周期闸 */
  #lastInfoAt = 0;
  /** @type {number} 上次找队（630→7530→7522）的墙上时刻（毫秒），节流 */
  #lastJoinAt = 0;
  /** @type {string} 已向哪个队发过 7522 申请（防找队快照滞后时重复申请同一队） */
  #appliedTeamId = '';
  /** @type {Map<string,string>} 引擎级 uid→昵称缓存（陪跑找队 630 取名用；查过不重查，查无记空串避免反复打网络；stop 清空） */
  #uidName = new Map();
  /** @type {number} 上次消耗定位信标的墙上时刻（毫秒），冷却闸 */
  #lastBeaconAt = 0;
  /** @type {string} 已被服务器判「小队不存在」而收口的 treasureId（防陈旧控制器把同一死队回填后再次空拉 7531；stop 清） */
  #endedTreasureId = '';
  /**
   * 场景流程引擎（P3/P4）：本队开跑后由 tick 委托驱动，共享同一 env/net/队伍快照与 sendPB 幂等闸。
   * @type {FlowEngine}
   */
  #flow;
  /** @type {(() => void)|null} 频道 17 聊天入站订阅退订句柄（codeBox 队友视图汇总；stop 摘除） */
  #chatUnsub = null;

  /**
   * @param {TeamEnv} env 外部依赖
   */
  constructor(env) {
    this.#env = env;
    this.#flow = new FlowEngine(this.#flowHost());
  }

  /**
   * 供 FlowEngine 使用的运行底座：把本引擎的实时态、sendPB 幂等发包、频道 17 聊天收发暴露给它，
   *   避免流程引擎自摸 net/reactor/chat 或重复订阅（chat 底座懒取 window.pocketcc.chat，install 可能早于其就绪）。
   * @returns {object} FlowHost
   */
  #flowHost() {
    return {
      alive: () => this.#env.alive(),
      cfg: () => this.#env.cfg(),
      team: () => this.#team,
      isLeader: () => this.#isLeader(),
      sendPB: (cmd, inner, label) => this.#sendPB(cmd, inner, label),
      onWake: () => this.#wake(),
      chat: {
        send: (text, opts) => {
          var c = window.pocketcc && window.pocketcc.chat;
          if (!c || typeof c.send !== 'function')
            return Promise.reject(new Error('chat unavailable'));
          return c.send(text, opts);
        },
        normalize: (raw) => {
          var c = window.pocketcc && window.pocketcc.chat;
          return c && typeof c.normalize === 'function' ? c.normalize(raw) : null;
        },
      },
    };
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /**
   * 订阅组队段推送（21371~21376）并置脏唤醒；退订由 reactor 托管（禁止本引擎自己摸 bus）。
   * @param {object} ctx reactor 上下文
   */
  start(ctx) {
    this.#applyDirty = true;
    ctx.on.push(21371, (ev) => this.#onTeamChange(this.#ack(ev, FIELD_TEAM_CHANGE)));
    ctx.on.push(21372, (ev) => this.#onReadyChange(this.#ack(ev, FIELD_READY_CHANGE)));
    ctx.on.push(21373, (ev) => this.#onMemberChange(this.#ack(ev, FIELD_MEMBER_CHANGE)));
    ctx.on.push(21374, (ev) => this.#onApplyChange(this.#ack(ev, FIELD_APPLY_CHANGE)));
    ctx.on.push(21375, (ev) => this.#onUserChange(this.#ack(ev, FIELD_USER_CHANGE)));
    ctx.on.push(21376, (ev) => this.#onHuntInfo(this.#ack(ev, FIELD_HUNT_INFO_CHANGE)));
    // 21383 来袭规模（真人掠夺）：转发给事件引擎驱动 P4 保命（本引擎不在此直发写包）
    ctx.on.push(21383, (ev) => this.#flow.onRaid(this.#ack(ev, FIELD_HURT_MARCH_SIZE)));
    // 7501 应答也可能带整队（报文实证 dashcam 20261016T191700 seq88）：统一在此落地，装配层只管点火发包
    ctx.on.resp(REQ_INFO, (ev) => {
      var ack = this.#ack(ev, ACK_INFO);
      if (!ack) return;
      // 活动开关态 + 每日时段表（报文实证 7501 crossTreasureInfo 的 open / openTime[]）：控制器缺席时这是建队/找队前判「进行中 + 到点」的唯一真相
      var sched = csHunt.parseSchedule(ack);
      if (sched) {
        if (sched.open !== this.#openFlag) {
          this.#openFlag = sched.open;
          this.#wake(); // 开关态变化（如开赛/休赛）立即重评，不等下一拍
        }
        this.#slots = sched.slots;
      }
      if (ack.team) this.#onTeamChange({ team: ack.team });
    });
    // 7531 应答是「本跑详情」的另一条落地通道（游戏面板与我们的 tick 都可能拉）：只取状态机快照，不重复驱动
    ctx.on.resp(REQ_HUNT_INFO, (ev) => this.#onHuntInfo(this.#ack(ev, ACK_HUNT_INFO)));
    ctx.on.resp(REQ_TEAM_APPLY_LIST, (ev) => this.#onApplyList(this.#ack(ev, ACK_APPLY_LIST)));
    // 频道 17 聊天入站（codeBox 队友视图汇总）：chat 是 socket.io 独立通道、非 net bus，退订自持（stop 摘除）
    var chatApi = window.pocketcc && window.pocketcc.chat;
    if (chatApi && typeof chatApi.on === 'function') {
      this.#chatUnsub = chatApi.on('push', (payload) => {
        var items = Array.isArray(payload) ? payload : [payload];
        for (var i = 0; i < items.length; i++) this.#flow.onChatPush(items[i]);
      });
    }
  }

  /**
   * 收引擎（pause 调）：只清本地编排状态，事件退订交 reactor。
   * 必须清：resume 后若继续用陈旧 team 快照，会对已解散/已开跑的队重发写请求。
   */
  stop() {
    this.#team = null;
    this.#useItemTeamId = '';
    this.#marchedTeamId = '';
    this.#marchStartTeamId = '';
    this.#called = false;
    this.#approved.clear();
    this.#applyDirty = true;
    this.#noArmyLoggedTeamId = '';
    this.#blockedLoggedReason = '';
    this.#lastInfoAt = 0;
    this.#lastJoinAt = 0;
    this.#appliedTeamId = '';
    this.#uidName.clear();
    this.#lastBeaconAt = 0;
    this.#endedTreasureId = '';
    if (this.#chatUnsub) {
      try {
        this.#chatUnsub();
      } catch (e) {
        /* 退订异常吞掉：摘除失败不阻断编排停摆 */
      }
      this.#chatUnsub = null;
    }
    this.#flow.reset();
  }

  /**
   * 7501 只读拉态（`{header:{}}`，报文实证 dashcam 20261016T191700 seq7）：team 由 resp 订阅落地，本方法只管择时。
   * 控制器实例缺席（没进过玩法子包）时，这是唯一能把开关态/整队喂进来的通道；在途或未落地均静默跳过，不阻断编排。
   * @param {boolean} force 无视兜底周期强拉一次
   */
  async refreshInfo(force) {
    var now = Date.now();
    if (!force && now - this.#lastInfoAt < INFO_REFRESH_MS) return;
    this.#lastInfoAt = now;
    await this.#sendPB(REQ_INFO, {}, '拉活动总览');
  }

  /**
   * 面板只读快照（供 fields 的 text.get 直接展示，不做任何 IO）。
   * @returns {{count:number|null, team:object|null, ctrl:object|null}}
   */
  snapshot() {
    return { count: this.#count, team: this.#team, ctrl: csHunt.readState() };
  }

  // ── 推送落地（一律以应答/推送为准，不镜像游戏数据） ──────────────────

  /**
   * 从 Event 里按 pbAck 子字段名取业务载荷。
   * @param {object} ev net Event（push/resp）
   * @param {string} field pbAck 业务槽名
   * @returns {object|null}
   */
  #ack(ev, field) {
    var d = ev && ev.data;
    if (!d || typeof d !== 'object') return null;
    return d[field] || null;
  }

  /**
   * 21371/7521：整队变更。team 为 null 即队已散/已到家（status ARRIVE 后游戏清态），全部编排闸复位。
   * @param {object|null} payload `{team}`
   */
  #onTeamChange(payload) {
    var raw = payload && payload.team;
    if (!raw || raw.id == null) {
      this.#clearTeam();
      return;
    }
    var team = csHunt.readTeam(raw);
    if (!team || !team.id) return; // 归一失败（异常形态）宁可不驱动
    // 队伍已回城/到家（status≥RETURNING）或 id 命中已结束死队 → 视为本次出征结束，**不接管**：
    //   否则 21376 END 迟到/漏推后，终局的 21371（status=ARRIVE、id 仍在非 null）会把旧队回填、重启对死 treasureId 的 7531 空拉
    var tidStr = String(team.treasureId || team.id);
    if (team.status >= TEAM_STATUS.RETURNING || tidStr === this.#endedTreasureId) {
      if (this.#team && this.#team.id === team.id)
        this.#finishHunt('队伍 push status=' + team.status + '（回城/到家）');
      return;
    }
    if (!this.#team || this.#team.id !== team.id) {
      this.#useItemTeamId = '';
      this.#marchedTeamId = '';
      this.#marchStartTeamId = '';
      this.#called = false;
      this.#approved.clear();
      this.#noArmyLoggedTeamId = '';
      this.#appliedTeamId = ''; // 已入队，清找队申请记账
      log.info('team %s 就位（cfg=%d，成员 %d）', team.id, team.cfg, team.memberCount);
    }
    this.#team = team;
    this.#applyDirty = true;
    this.#wake();
  }

  /**
   * 队伍清空（21371 不带 team / status=ARRIVE / 解散应答）。
   */
  #clearTeam() {
    if (this.#team) log.info('队伍 %s 已清空（散队/到家）', this.#team.id);
    this.#team = null;
    this.#useItemTeamId = '';
    this.#marchedTeamId = '';
    this.#marchStartTeamId = '';
    this.#called = false;
    this.#approved.clear();
    this.#noArmyLoggedTeamId = '';
    this.#appliedTeamId = ''; // 队已清空，允许重新找队申请
    this.#applyDirty = false;
    this.#wake();
  }

  /**
   * 结束本次出征、转下一轮的**统一收口**（push 状态机 END/RETURN、21371 到家、7531 终局拒因三条路都汇到这里）：
   *   记下该死 treasureId（防陈旧控制器/后续 21371 把同一队回填重启 7531 空拉）→ 复位流程引擎（停对将消亡
   *   treasureId 的空拉——否则游戏会一直弹「小队不存在」）→ 清空队伍快照与全部编排闸并唤醒，下一拍即走无队
   *   分支重新建队/找队进入下一轮出征。
   * @param {string} source 结束来源（日志用：状态机 push / 队伍 push / 7531 拒因）
   */
  #finishHunt(source) {
    var t = this.#team;
    var deadId = String((t && (t.treasureId || t.id)) || '');
    if (deadId) this.#endedTreasureId = deadId;
    log.info('本次夺宝出征已结束（%s），停止拉本跑详情，转下一轮', source);
    this.#flow.reset();
    this.#clearTeam();
  }

  /**
   * 兜底：7531 拉本跑详情被服务器以「小队不存在」等终局拒因回绝（cs_treasure294，字典表实证）即宣告该
   *   treasureId 已消亡。主路径已由 21376 状态机 END/RETURN 推送提前约 90s 判定（见 #onHuntInfo），此处仅
   *   作**漏推兜底**——状态机推送丢失时才靠它收口。
   * @param {string} reason 服务器多语言拒因键
   */
  #endHunt(reason) {
    this.#finishHunt('7531 终局拒因 ' + reason + '=夺宝奇兵小队不存在（漏推兜底）');
  }

  /**
   * 21372：出发召集（`{teamId, readyMember:Long[], readyStartTimeMill}`）。
   * 召集窗口只有主表 `waiting_time=14s`（§9.1），故落地即唤醒，下一拍马上表态。
   * @param {object|null} payload 召集体
   */
  #onReadyChange(payload) {
    if (!payload) return;
    var teamId = bits.int64Str(payload.teamId);
    if (!this.#team || (teamId && this.#team.id !== teamId)) return;
    var ready = Array.isArray(payload.readyMember) ? payload.readyMember : [];
    this.#called = true;
    log.debug('ready call: team %s, ready=%d', this.#team.id, ready.length);
    this.#wake();
  }

  /**
   * 21373：成员增删改（`{teamId, type, member}`）。人数是凑人/召集的电平量，交 tick 重读快照。
   * @param {object|null} payload 成员变更体
   */
  #onMemberChange(payload) {
    if (!payload) return;
    var teamId = bits.int64Str(payload.teamId);
    if (this.#team && teamId && this.#team.id !== teamId) return;
    this.#applyDirty = true;
    this.#wake();
  }

  /**
   * 21374：入队申请变更（`{teamId, uid, op, apply}`）。只置脏，真正的审批在 tick 里按 7528 复核结果做
   *   （设计 §3.1 步骤 2：申请池以 7528 应答为权威，避免按推送单帧误批）。
   * @param {object|null} payload 申请变更体
   */
  #onApplyChange(payload) {
    if (!payload) return;
    var teamId = bits.int64Str(payload.teamId);
    if (!this.#team || (teamId && this.#team.id !== teamId)) return;
    if (!this.#isLeader()) return;
    this.#applyDirty = true;
    this.#wake();
  }

  /**
   * 21375：本人次数变更（`{count, lastRecoverTimeMill, mark}`）——huntCount 的唯一来源。
   * @param {object|null} payload 变更体
   */
  #onUserChange(payload) {
    if (!payload) return;
    this.#count = Number(bits.int64Str(payload.count)) || 0;
    log.debug('hunt count = %d', this.#count);
    this.#wake();
  }

  /**
   * 21376 / 7531 应答：状态机快照。P1 只做只读转储（P0 闭环）——场景分派与技能在 P3/P4 接。
   * @param {object|null} payload 状态机体
   */
  #onHuntInfo(payload) {
    if (!payload) return;
    var status = Number(payload.status) || 0;
    var slot = HUNT_STATUS_PAYLOAD[status];
    // P3/P4：状态机快照转发流程引擎（选场景 / 6 族事件 / 技能），换跑与 per-round 幂等由其自持
    this.#flow.onHuntInfo(payload);
    if (status === HUNT_STATUS.END || status === HUNT_STATUS.RETURN) {
      // 状态机到 END(4)/RETURN(5) 即「本次出征结束」的**服务器权威推送**，比 7531 cs_treasure294 早约 90s
      //   （报文实证 dashcam 20261017T120320：status=4@+986s、status=5@+1013s，而 7531 直到 +1078s 才 cs_treasure294）
      //   → 主判定走此，停掉对将消亡 treasureId 的 7531 空拉、尽快转下一轮；7531 拒因路径（#endHunt）降为漏推兜底。
      //   仅当推送 tid 与当前队一致才收口（新一轮已开跑时旧 END 迟到不误清）。
      var endTid = bits.int64Str(payload.treasureId);
      var curTid = this.#team ? String(this.#team.treasureId || this.#team.id || '') : '';
      if (this.#team && endTid && endTid === curTid) {
        this.#finishHunt(
          '状态机 push status=' + status + '（终局/回城，round=' + payload.round + '）',
        );
      }
      return;
    }
    log.debug(
      'hunt status=%d(%s) round=%s payload=%s',
      status,
      slot || '-',
      payload.round,
      slot ? 'yes' : 'no',
    );
  }

  /**
   * 7528 应答：申请池 `{apply:[{uid,teamId,playerInfo,power}]}` → 池内逐个 7523 通过。
   * @param {object|null} payload 申请池体
   */
  #onApplyList(payload) {
    if (!payload || !this.#isLeader() || !this.#team) return;
    var apply = Array.isArray(payload.apply) ? payload.apply : [];
    if (!apply.length) return;
    var cfg = this.#env.cfg();
    var pool = poolSet(cfg.rolePool);
    for (var i = 0; i < apply.length; i++) {
      var uid = bits.int64Str(apply[i] && apply[i].uid);
      if (!uid || this.#approved.has(uid)) continue;
      this.#approved.add(uid);
      if (!pool.size || pool.has(uid)) {
        this.#sendPB(REQ_TEAM_APPLY_OP, { uid: bits.int64(uid), op: 1 }, '审批通过');
      } else if (cfg.rejectOutsidePool) {
        this.#sendPB(REQ_TEAM_APPLY_OP, { uid: bits.int64(uid), op: 2 }, '拒绝池外申请');
      }
    }
  }

  // ── 兜底调和 ────────────────────────────────────────────────────────

  /**
   * cycle 单轮：按当前电平把组队链路往前推一格，返回下一拍间隔。
   * 顺序即依赖顺序（表态 → 出征 → 召集），每一步都有 teamId 级幂等闸，重复调用无副作用。
   * @returns {Promise<number>} 下一次兜底重扫的毫秒数（<=0 立即再跑）
   */
  async tick() {
    var env = this.#env;
    if (!env.alive()) return 0;
    var cfg = env.cfg();

    // 控制器不在场（子包未接管）时 readState 恒 null，队伍/开关态只能靠 7501 应答补齐：按兜底周期拉一次（漏推自愈）
    if (!csHunt.present()) await this.refreshInfo(false);

    // 控制器在场时交叉回填（面板打开/子包接管后游戏已读到的队伍与次数，插件不必重发一遍）
    var st = csHunt.readState();
    if (st) {
      var stTid = String((st.team && (st.team.treasureId || st.team.id)) || '');
      if (
        st.team &&
        stTid !== this.#endedTreasureId && // 已被服务器判「小队不存在」的死 id 不再从陈旧控制器回填
        (!this.#team || this.#team.id !== st.team.id || st.team.status !== this.#team.status)
      ) {
        this.#team = st.team;
      }
      if (this.#count == null && st.huntCount > 0) {
        this.#count = st.huntCount; // 控制器 huntCount 只作回填下限：推送 21375 才是权威（它没来才借这个值）
      }
    }

    if (!this.#team) {
      var gate = await this.#gateActivity(st);
      if (!gate.proceed) return gate.sleep;
      return this.#noTeam(cfg, st);
    }

    var t = this.#team;
    if (t.status >= TEAM_STATUS.MARCHING) {
      // 已开跑：把场景决策/事件执行/技能交流程引擎驱动（运行即全自动，内部含只读自愈）
      //   活动闸不拦已开跑的一局（服务端权威且一跑仅数分钟），让其跑完
      return this.#flow.tick();
    }

    // 未开跑（等待人数/表态/出征/召集期）：每拍同样先过活动闸（用户口径：窗口结束不应继续写包）
    {
      var gate2 = await this.#gateActivity(st);
      if (!gate2.proceed) return gate2.sleep;
    }

    var dirty = this.#applyDirty;
    if (dirty) this.#applyDirty = false;

    // 1) 队长复核申请池（7528 只读，应答侧审批）
    if (dirty && this.#isLeader()) {
      await this.#sendPB(REQ_TEAM_APPLY_LIST, { teamId: bits.int64(t.id) }, '拉申请池');
    }

    // 2) 本人表态要奖励/陪跑（队长不发包：建队已含队长次数消耗）；mode 决定要奖励(op:1)还是陪跑(op:2)
    if (!this.#isLeader() && this.#useItemTeamId !== t.id) {
      var wantReward = cfg.mode === 'main';
      if (wantReward && this.#count === 0) {
        // 主跑但次数为 0：勾了信标补次数则先消耗一个再等 21375 刷新（本轮不表态，下拍复查）；否则降级陪跑加入不浪费时机
        if (cfg.useBeaconWhenShort) {
          var topped = await this.#useBeacon('要奖励前');
          if (topped) return ACTIVE_TICK_MS;
        }
        wantReward = false;
      }
      this.#useItemTeamId = t.id;
      await this.#sendPB(
        REQ_TEAM_USE_ITEM,
        { op: wantReward ? 1 : 2 },
        wantReward ? '要奖励入队' : '陪跑入队',
      );
    }

    // 3) 满编出征入队（7519 走 NET.send；无兵不发空包，等回城推送唤醒补派）
    if (this.#marchedTeamId !== t.id) {
      var sent = await this.#marchFull(t);
      if (!sent) return ACTIVE_TICK_MS; // 本轮无兵/未发成，下一拍重试（info 已按队留痕一次）
    }

    // 4) 召集出发（用户口径硬条件）：队长在「等待人数到齐」且「全员都已完成出兵」时主动发起 7527；
    //    任一角色收到 21372 召集（readyMember 含本人）后表态同意。
    if (this.#marchStartTeamId !== t.id) {
      var called = this.#called || t.readyCount > 0; // 收到召集/已在 ready 名单 → 表态（成员/队长通用）
      // 人数到齐：memberCount 达目标（targetMemberNum）且非空
      var full = this.#isLeader() && t.memberCount > 0 && t.memberCount >= targetMembers(cfg);
      // 全员完成出兵：每个成员 marchId 非零（都派兵到集结点了）
      var allMarched = this.#isLeader() && t.memberCount > 0 && t.marchedCount === t.memberCount;
      if (called || (full && allMarched)) {
        this.#marchStartTeamId = t.id;
        this.#called = false;
        await this.#sendPB(REQ_MARCH_START, { op: 1 }, '同意出发');
      }
    }

    return ACTIVE_TICK_MS;
  }

  /**
   * 活动双闸（每拍写包前校验，用户口径「夺宝时间窗口结束不应继续写包」）：
   *   ① 玩法进行中（open===1；休赛=3/其余未开）——控制器在场用 st.active 实时判，缺席用 7501 应答落地的 #openFlag；
   *   ② 当前落在每日 3 个夺宝时段之一（#slots 由 7501 openTime[] 解析；open===1 是赛季旗标整天为真，不等于「到点」）。
   *   任一未知则不贸然建队/加入，强拉一次 7501 后短睡等应答落地（resp 里 #openFlag/#slots 变更即 #wake 重评）；
   *   未到点则 info 一次（带下一场分钟数）并睡到下个时段（封顶 IDLE，保持对开关态变化的响应）。
   *   已开跑的一局（status>=MARCHING）由 tick 调用方豁免（服务端权威、一跑仅数分钟，让其跑完）。
   * @param {object|null} st csHunt 只读快照（控制器不在场为 null）
   * @returns {Promise<{proceed:boolean, sleep:number}>} proceed=true 才放行建队/找队/表态等写包
   */
  async #gateActivity(st) {
    var openKnown = st ? !!st.active : this.#openFlag != null ? this.#openFlag === 1 : null;
    if (openKnown === false) {
      this.#blockOnce('off', '夺宝奇兵当前不在活动时间（玩法未开/休赛），暂不建队/加入');
      return { proceed: false, sleep: IDLE_TICK_MS };
    }
    if (openKnown === null) {
      await this.refreshInfo(true);
      this.#blockOnce('unknown', '夺宝奇兵活动态未知（等 7501 应答），本轮不建队/加入');
      return { proceed: false, sleep: ACTIVE_TICK_MS };
    }
    var win = csHunt.playWindowState(this.#slots, csHunt.serverMs());
    if (!win.known) {
      await this.refreshInfo(true);
      this.#blockOnce('nowin', '夺宝奇兵时段表未知（等 7501 openTime），本轮不建队/加入');
      return { proceed: false, sleep: ACTIVE_TICK_MS };
    }
    if (!win.in) {
      var wait = win.nextBegin ? win.nextBegin - csHunt.serverMs() : IDLE_TICK_MS;
      this.#blockOnce(
        'window',
        '夺宝奇兵当前不在每日夺宝时段内（每天 3 场），暂不建队/加入' +
          (win.nextBegin ? '，下一场约 ' + Math.max(0, Math.round(wait / 60000)) + ' 分钟后' : ''),
      );
      return { proceed: false, sleep: Math.min(Math.max(wait, ACTIVE_TICK_MS), IDLE_TICK_MS) };
    }
    this.#blockedLoggedReason = '';
    return { proceed: true, sleep: 0 };
  }

  /**
   * 无队分支（活动双闸已由 tick 顶的 #gateActivity 放行）：按玩法模式派发——
   *   主跑 → 一律 7521 建队开车（不回退找队，避免无人建队时一直「找不到夺宝小队」）；
   *   陪跑 → 逐个玩家池成员按名搜队申请加入（#joinTeam）。
   * @param {object} cfg 模块配置
   * @param {object|null} st csHunt 只读快照（控制器不在场为 null）
   * @returns {Promise<number>} 下一拍间隔
   */
  async #noTeam(cfg, st) {
    if (cfg.mode === 'main') return this.#tryCreate(cfg, st);
    return this.#joinTeam(cfg);
  }

  /**
   * 主跑开车：建队 7521。次数为 0 时按 useBeaconWhenShort 先消耗定位信标补次数（消耗后等 21375 刷新再下拍复查）。
   * 次数「未知」（新会话没收到 21375 且控制器未给）时不硬拦，交服务器裁决。
   * @param {object} cfg 模块配置
   * @param {object|null} st csHunt 只读快照
   * @returns {Promise<number>} 下一拍间隔
   */
  async #tryCreate(cfg, st) {
    var cnt = this.#count != null ? this.#count : st ? st.huntCount : null;
    if (cnt === 0) {
      if (cfg.useBeaconWhenShort && (await this.#useBeacon('建队前'))) {
        return ACTIVE_TICK_MS; // 信标已消耗，等 21375 刷新次数后下拍复查
      }
      this.#blockOnce(
        'count',
        '夺宝次数为 0，暂不建队（游戏侧每 10h 恢复 1 点；未勾选/无信标则不补）',
      );
      return IDLE_TICK_MS;
    }
    var ret = await this.#sendPB(REQ_TEAM_CREATE, { cfg: TEAM_CFG }, '建队');
    var ack = ret && ret.payload ? ret.payload[ACK_TEAM_CREATE] : null;
    if (ack && ack.team) this.#onTeamChange(ack);
    return ACTIVE_TICK_MS;
  }

  /**
   * 陪跑找队（用户口径「主动挨个去搜索玩家池中的玩家」）：遍历 rolePool 每个玩家 uid（跳过自己）→
   *   ① 630 PLAYER_INFO 按 uid 取昵称（#lookupName，带缓存）→ ② 7530 按昵称 likeName 搜其创建的队 →
   *   ③ 命中未满、未申请、队长即该玩家的队 → 7522 op:1 申请加入，找到即停手。
   *   整趟按 JOIN_POLL_MS 节流；申请后等 21371/21373 落地接管（不轮询等审批）。
   *   报文实证 dashcam 20261016T190507：630 应答 data.playerInfo(JSON 串).username=昵称；7530 请求 {likeName}，
   *   应答 crossTreasureSearchTeamList.team[]（row.id/uid 为 Long，members/maxMembers/applied）；7522 {teamId:Long,op:1}。
   *   已知局限：likeName 是子串匹配，昵称含 emoji/空格时整串搜可能搜不到（真机手动也常剥字搜），故查无即跳过下一个成员。
   * @param {object} cfg 模块配置（rolePool: uidlist `[{uid,name}]`）
   * @returns {Promise<number>} 下一拍间隔
   */
  async #joinTeam(cfg) {
    var net = this.#env.net();
    if (!net) return IDLE_TICK_MS;
    var now = Date.now();
    if (now - this.#lastJoinAt < JOIN_POLL_MS) return IDLE_TICK_MS;
    this.#lastJoinAt = now;
    var pool = Array.isArray(cfg.rolePool) ? cfg.rolePool : [];
    var myUid = gameData.myUidStr();
    for (var i = 0; i < pool.length; i++) {
      if (!this.#env.alive()) return IDLE_TICK_MS;
      var it = pool[i] || {};
      var uidStr = bits.int64Str(it.uid);
      if (!uidStr || uidStr === myUid) continue; // 跳过无效 uid 与自己（陪跑不加本人开的队）
      var name = (await this.#lookupName(net, uidStr)) || String(it.name || '').trim();
      if (!name) continue;
      var ret = await this.#sendPB(REQ_SEARCH_TEAM_LIST, { likeName: name }, '按名搜队');
      var payload = ret && ret.payload ? ret.payload[ACK_SEARCH_TEAM_LIST] : null;
      var teams = payload && Array.isArray(payload.team) ? payload.team : [];
      for (var k = 0; k < teams.length; k++) {
        var row = teams[k] || {};
        var teamId = bits.int64Str(row.id);
        var leaderUid = bits.int64Str(row.uid);
        if (!teamId || row.applied || teamId === this.#appliedTeamId) continue;
        if (Number(row.members) >= Number(row.maxMembers || 5)) continue; // 已满
        if (leaderUid && leaderUid !== uidStr) continue; // 只要「该玩家创建」的队（同名他人一律跳过）
        this.#blockedLoggedReason = '';
        this.#appliedTeamId = teamId;
        await this.#sendPB(
          REQ_TEAM_APPLY_OR_CANCEL,
          { teamId: bits.int64(teamId), op: 1 },
          '申请入队',
        );
        return ACTIVE_TICK_MS;
      }
    }
    this.#blockOnce('nojoin', '玩家池中暂无已创建可加入小队的成员（按名逐个搜未命中未满队）');
    return JOIN_POLL_MS;
  }

  /**
   * 630 PLAYER_INFO 按 uid 取玩家昵称（陪跑找队按名搜队用；业务强相关报文收口本 feat，不入通用 net.js）。
   *   报文实证 dashcam 20261016T190507：req `{uid:"字符串"}`（NET.send，非 sendPB）；应答 data.playerInfo 是 JSON 串，
   *   其内 username=显示昵称（nickname 常空，昵称可含 emoji/空格）。命中缓存直接回；查无/异常缓存空串避免反复打网络；stop() 清缓存。
   * @param {object} net 网络底座
   * @param {string} uidStr 目标玩家 uid（字符串）
   * @returns {Promise<string>} 昵称（取不到回空串）
   */
  async #lookupName(net, uidStr) {
    if (this.#uidName.has(uidStr)) return this.#uidName.get(uidStr);
    var name = '';
    try {
      var ret = await net.send(CMD_PLAYER_INFO, { uid: String(uidStr) });
      var d = ret && ret.ok ? ret.data : null;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch (e) {
          d = null;
        }
      }
      var pi = d && d.playerInfo;
      if (typeof pi === 'string') {
        try {
          pi = JSON.parse(pi);
        } catch (e) {
          pi = null;
        }
      }
      if (pi) name = String(pi.username || pi.nickname || '').trim();
    } catch (err) {
      /* 630 异常降级：查不到名字即跳过该玩家，交下一个成员/下一拍，不阻断找队循环 */
    }
    this.#uidName.set(uidStr, name);
    return name;
  }

  /**
   * 消耗一个定位信标补次数：走通用使用物品 815（JSON 通道，req `{itemid:47001001,amount:1}`，非 sendPB）。
   * 先查背包库存（gameData.itemAmount），无货直接 false；BEACON_COOLDOWN_MS 内不重复消耗（每次都是真道具）。
   * @param {string} label 日志标签（建队前/要奖励前）
   * @returns {Promise<boolean>} 是否已发出并被接受（true 后由 21375 推送刷新次数）
   */
  async #useBeacon(label) {
    var net = this.#env.net();
    if (!net) return false;
    var now = Date.now();
    if (now - this.#lastBeaconAt < BEACON_COOLDOWN_MS) return false;
    if (gameData.itemAmount(ITEM_BEACON) <= 0) {
      this.#blockOnce('beacon', label + '：背包无定位信标(47001001)，不补次数');
      return false;
    }
    if (net.isSending(CMD_ITEM_USE)) return false;
    this.#lastBeaconAt = now;
    var ret;
    try {
      ret = await net.send(CMD_ITEM_USE, { itemid: ITEM_BEACON, amount: 1 });
    } catch (err) {
      log.warn('%s 信标发包 throw. %s', label, err && err.message);
      return false;
    }
    if (ret && ret.ok) {
      var remain = ret.data && ret.data.amount;
      log.info('%s消耗定位信标补次数 ok（剩余 %s）', label, remain == null ? '?' : remain);
      return true;
    }
    log.info('%s信标被拒 code=%s', label, ret ? ret.code : CODE_NOT_SENT);
    return false;
  }

  /**
   * 满编出征 7519：按 presetPool 取第一个能出兵的预设，直发 JSON 通道（**非 sendPB**）。
   * 报文体逐键对齐 dashcam 20261016T191700：`{marchType:137,armyList,armyListNew,heroList,trapList,formation:0,formationV2}`，
   *   体内无 treasureId；extraArmy 仅在有补位时才带（录制样本无此键，PB 编码空对象会多出脏字段）。
   * @param {object} t 队伍快照
   * @returns {Promise<boolean>} 是否已发出（无兵/未发出返回 false，由调用方下一拍重试）
   */
  async #marchFull(t) {
    // 游戏侧已有本人行军（marchId 非零），不再重复派；
    //   注意 bits.int64Str(Long(0,0)) 回 '0' 代表「无行军」，不可当 truthy 误判（dashcam 20261017T031255 根因）。
    if (t.selfMarchId && t.selfMarchId !== '0') {
      this.#marchedTeamId = t.id;
      return true;
    }
    var cfg = this.#env.cfg();
    var plan = buildPlanFromPool(cfg.presetPool || []);
    if (!plan) {
      if (this.#noArmyLoggedTeamId !== t.id) {
        this.#noArmyLoggedTeamId = t.id;
        log.info('presetPool %j 全无可派部队，暂不出征，等回城唤醒补派', cfg.presetPool || []);
      }
      return false;
    }
    var net = this.#env.net();
    if (!net || net.isSending(REQ_TEAM_MARCH)) return false;
    var body = {
      marchType: MARCH_TYPE_CS_TEAM_HUNT,
      armyList: plan.armyListNew,
      armyListNew: plan.armyListNew,
      heroList: plan.heroList,
      trapList: plan.trapList,
      formation: 0,
      formationV2: plan.formationV2,
    };
    if (plan.extraArmy && plan.extraArmy.armyId) body.extraArmy = plan.extraArmy;
    var ret;
    try {
      ret = await net.send(REQ_TEAM_MARCH, body);
    } catch (err) {
      log.warn('7519 send threw. %s', err && err.message);
      return false;
    }
    if (ret && ret.ok) {
      this.#marchedTeamId = t.id;
      this.#noArmyLoggedTeamId = '';
      log.info(
        '满编出征 ok（armyId=%d, 兵队 %d, 英雄 %d）',
        plan.armyListNew[0].armyId,
        plan.armyListNew.length,
        plan.heroList.length,
      );
      return true;
    }
    log.info('满编出征被拒 code=%s', ret ? ret.code : CODE_NOT_SENT);
    return false;
  }

  // ── 小工具 ──────────────────────────────────────────────────────────

  /**
   * 本人是否队长（队伍快照 uid 与 myUidStr 字符串比较；64 位 id 绝不做 Number 比较）。
   * @returns {boolean}
   */
  #isLeader() {
    if (!this.#team) return false;
    var uid = gameData.myUidStr();
    return !!uid && this.#team.uid === uid;
  }

  /**
   * 直发一条 V1 PB 请求（永不 reject）。业务槽名由 cmd 查 constants.REQ_FIELD（逐条取自录制报文 req 行的 data 键）。
   * @param {number} cmd 命令号
   * @param {object} inner 业务载荷（Int64 字段须已用 bits.int64 装箱）；纯头请求传 {}
   * @param {string} label 日志标签
   * @returns {Promise<{ok:boolean, code:number, payload:object|null}>} 归一结果（payload=整段 pbAck）
   */
  async #sendPB(cmd, inner, label) {
    var net = this.#env.net();
    if (!net || net.isSending(cmd)) return { ok: false, code: CODE_NOT_SENT, payload: null };
    var field = REQ_FIELD[cmd]; // 查不到即「裸 header 请求」（7501 实发 `{header:{}}`），多塞一个空对象会偏离录制形态
    var body = field ? { header: {}, [field]: inner } : { header: {} };
    var ret;
    try {
      ret = await net.sendPB(cmd, body);
    } catch (err) {
      log.debug('%s (%d) send failed: %s', label, cmd, err && err.message);
      return { ok: false, code: CODE_NOT_SENT, payload: null };
    }
    var d = ret && ret.data;
    var payload = d && typeof d === 'object' ? d : null;
    var code = ret ? ret.code : CODE_NOT_SENT;
    if (code === 0) {
      log.debug('%s ok (%d/%s)', label, cmd, field);
    } else {
      // V1 PB 的拒因在 pbAck.header.{s,d}（d 是多语言键）；可预期业务拒走 info，不升 warn
      var reason = payload && payload.header ? payload.header.d : null;
      log.info('%s rejected. cmd=%d code=%s reason=%s', label, cmd, code, reason || '-');
      // 7531 命中「小队不存在」等终局拒因 → 服务器权威宣告本跑已结束：立即收口转下一轮，停止空拉
      if (cmd === REQ_HUNT_INFO && reason && HUNT_OVER_REASONS.has(reason)) this.#endHunt(reason);
    }
    return { ok: !!(ret && ret.ok), code: code, payload: payload };
  }

  /**
   * 同类阻塞原因只 info 一次（循环态不刷屏），原因变化即重新留痕。
   * @param {string} key 原因标识
   * @param {string} msg 展示文案
   */
  #blockOnce(key, msg) {
    if (this.#blockedLoggedReason === key) return;
    this.#blockedLoggedReason = key;
    log.info(msg);
  }

  /**
   * 唤醒兜底循环（在飞时由 createCycle 合并为「补扫一轮」）。
   */
  #wake() {
    if (this.#env && typeof this.#env.onWake === 'function') this.#env.onWake();
  }
}

/**
 * 凑够多少人就召集出发（≤ 主表 max_ppl_num=5；2 人也能开完整局，§9.3 实样，故下限交服务器判）。
 * @param {object} cfg 模块配置
 * @returns {number}
 */
function targetMembers(cfg) {
  var n = Number(cfg && cfg.targetMemberNum) || 0;
  if (n < 2) n = 2;
  if (n > 5) n = 5;
  return n;
}
