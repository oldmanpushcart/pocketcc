/**
 * feats/activity/cs-hunt/engine-team.js —— 夺宝奇兵（CSHunt）组队编排引擎（P1 队长最小闭环）。
 *
 * 覆盖链路（设计文档 extension/docs/feat-夺宝奇兵.md §3，分期见 §8）：
 *   1. 队长无队 → 7521 建队（`{cfg:1}`，实录报文实证）；
 *   2. 队长审批 → 21374 置脏 → 7528 复核申请池 → 池内 7523 `{uid,op:1}`（池外按配置忽略/拒绝）；
 *   3. 队长凑够 targetMemberNum 且全员派兵到位（每人 marchId 非零）→ 7527 `{op:1}` 发起出发召集（服务端随后派 21372 给全队）；
 *      凑人超时（借鉴竞对 waitmin，面板 waitMin 默认 3 分钟）：人数未达标但已到位成员皆已派兵 → 也直接召集，不永久等；
 *   4. 两角色共用：入队后表态要奖励/陪跑 7520 `{op:1|2}`（队长恒要奖励，不发此包）；
 *      本人满编出征 7519（NET.send，`{marchType:137,...}`，体内无 treasureId）；
 *      收 21372 召集 → 7527 `{op:1}` 同意出发。
 *
 * 编排时序（报文实证，勿凭直觉改）：
 *   陪跑实录趟：7522 申请 → 21371 入队 → 7520 `{op:2}` → 7519 出征 →
 *     21372 召集 → 7527 `{op:1}` → 21376 status=0（MARCHING）。
 *   **先满编出征、后应答召集**——7519 把本人部队派到集结点，7527 才是「我准备好了」。
 *   队长实录趟：7521 → 7528 → 7519 → 7523×n → 7527（人数到齐且全员派兵到位后召集）。
 *
 * 幂等与去重：
 *   - 7519 同内容连发两条间隔 23s 均 s=0（重复发包无害，报文实证），但仍按 teamId 记一次、失败才重试；
 *   - 每个写请求经 net.isSending(cmd) 在途去重；
 *   - 队伍快照一律由应答/推送落地（不镜像游戏数据、不调游戏 updateXxx，遵守 feat 只读+发包红线）；
 *   - **终局后散队闸门**：状态机 END/RETURN 时服务器队伍并未即散——夺宝飞船还在返程，到家才散队
 *     （报文实证：实录 END@+986s → 21371 散队@+1063s）。窗口内建队 7521/申请 7522
 *     会被拒 ava_team_tips_011=已加入其他队伍（游戏 UI 随之反复提示）→ #finishHunt 置 #waitHome 闸门，
 *     解除走三通道：10019 飞船(marchType=137)到家边沿推送 / 21371 队伍清空推送 / 快照轮询+超时兑底。
 *
 * 已知缺口（不阻塞本闭环）：
 *   - huntCount 只由推送 21375 喂（游戏侧同款口径：RealCSHuntController.updateUserCrossTreasureChange），
 *     新会话未收到该推送时 count 为「未知」，此时不硬拦建队，交服务器裁决；
 *   - 控制器实例未接管（没进过玩法子包）时 csHunt.readState() 恒 null，故 tick 按 INFO_REFRESH_MS 兜底周期
 *     重发一次只读 7501（应答也可能带整队，实录报文实证）。
 *
 * P2 队员/陪跑（本期新增）：
 *   - 玩法模式 cfg.mode：'main'（主跑，要奖励耗次数）/ 'helper'（陪跑，op:2 不耗次数）；角色不再靠单列开关，而是 mode 驱动；
 *   - 无队且不该自己开车（仅 helper）→ 逐个玩家池成员用 630 PLAYER_INFO 取名 → 7530 按名（likeName）搜该玩家创建的未满队 → 7522 申请入队（不再扫 7526）；main 一律自己建队开车；
 *   - 次数不足且勾了 useBeaconWhenShort → 走通用使用物品 815 消耗定位信标(47001001) 补次数（§7-6 已报文关闭）。
 */
import { CODE_NOT_SENT, todayStr, rejectText } from '../../../core/util.js';
import { Battle } from '../../../core/battle.js';
import { march } from '../../../core/march.js';
import { CMD_GET_WORLD_INFO } from '../../../core/map.js';
import { bits, gameData } from '../../../core/game-api.js';
import { csHunt } from './api.js';
import { createLog } from '../../../core/log.js';
import { storage } from '../../../core/storage.js';
import { chatApi } from '../../../core/chat.js';
import { FlowEngine } from './engine-flow.js';
import {
  ACK_APPLY_LIST,
  ACK_HUNT_INFO,
  ACK_INFO,
  ACK_SEARCH_TEAM_LIST,
  ACK_TEAM_CREATE,
  CMD_ITEM_USE,
  CMD_PLAYER_INFO,
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

/** @type {number} 建队 cfg（= 控制器 specId；真机 dump 与四趟报文恒 1，见 §9/§9.4） */
const TEAM_CFG = 1;

/** @type {number} 跑动中/凑人期的兜底重扫间隔（毫秒）：主推进靠 push，这里只是漏推自愈 */
const ACTIVE_TICK_MS = 15000;
/** @type {number} 无队且暂不可开车时的长睡间隔（毫秒） */
const IDLE_TICK_MS = 60000;
/** @type {number} 未到点等待期远窗（距下一场 >1h）的排程封顶（毫秒）：7501 应答 open 旗标变更即 #wake，长睡不漏开赛 */
const WINDOW_WAIT_CAP_FAR_MS = 3600000;
/** @type {number} 未到点等待期近窗（距下一场 ≤1h）的排程封顶（毫秒）：给「时段表被服务器改早」留自愈节拍 */
const WINDOW_WAIT_CAP_NEAR_MS = 1800000;
/** @type {number} 7501 只读拉态的兜底周期（毫秒）：控制器未接管（子包没进过）时队伍/开关态的唯一补齐通道 */
const INFO_REFRESH_MS = 90000;
/**
 * @type {number} 未开跑等待期主动轮询 7501 的间隔（毫秒）：游戏界面在夺宝页外时服务器不推队伍态
 *   （实证审批后 21371/21372 均漏达的实录：整队电平冻结 3 分钟，点开队伍页才补到）；
 *   队长 full/allMarched 召集判定不能依赖推送可达，靠应答带整队（实录应答实证）喂电平。纯读包。
 */
const TEAM_POLL_MS = 20000;
/** @type {number} 队长兜底拉申请池（7528）的最小间隔（毫秒）：审批主路是 21374 推送，此仅节流补漏，杜绝逐拍刷屏（真机实录曾 3 秒内 95 次 7528） */
const APPLY_LIST_POLL_MS = 20000;
/** @type {number} 预警式防御 630 敌战力缓存鲜度窗（毫秒）：窗内同 uid 不重查，免每拍打 630；查无/异常亦缓存 0 防同一无果 uid 反复打网络 */
const POWER_CACHE_MS = 60000;
/** @type {number} 无队找队时按名搜队（630→7530→7522）每拍只搜 1 个池成员的最小间隔（毫秒）：游标轮转，杜绝一趟连打整池网络（2026-10-25 定 5s：单拍只发 1 次 7530，8 人池扫一圈 ~40s） */
const JOIN_POLL_MS = 5000;
/** @type {number} 同一目标定位信标消耗的最小间隔（毫秒）：防 21375 未到时逐拍重复消耗（每次都是真道具） */
const BEACON_COOLDOWN_MS = 20000;
/** @type {number} 终局后等飞船回城散队的兑底超时（毫秒）：主解除靠 10019 到家/21371 散队推送，此仅防漏推死等（实证散队约在 END 后 1-2 分钟，5 分钟富余） */
const WAIT_HOME_MAX_MS = 300000;
/** @type {number} 回城等待期快照轮询重查间隔（毫秒）：行军不在队列表即判已到家 */
const HOME_POLL_MS = 10000;
/**
 * @type {number} 队长凑人超时强制发车的默认分钟数（借鉴竞对 setting.team.waitmin 默认 3）：
 *   人数未达 targetMemberNum 但已到位成员都已派兵成功，等满本分钟数即直接 7527 召集发车，
 *   杜绝「目标人数高于实时来人数」时永久等下去；0 表示在面板里显式关闭。
 *   【导出】面板 index.js 的 defaults/normalize 与此共用同一默认值，防两处口径漂移。
 */
export const DEFAULT_WAIT_MIN = 3;
/**
 * @type {Set<string>} 7531 拉本跑详情命中即「本次出征已结束」的服务器权威终局拒因（多语言键）：
 *   cs_treasure294=夺宝奇兵小队不存在（字典表.txt L42336，实证日志 `code=3 reason=cs_treasure294`）。
 *   命中即停止对已消亡 treasureId 的空拉（否则游戏会一直弹「小队不存在」），清队转下一轮。
 */
const HUNT_OVER_REASONS = new Set(['cs_treasure294']);

// ── ⑤ 每日夺宝局数上限（借鉴竞对 state.counter + setting.team.count + dayInit）──────────
//   竞对口径：每次真开跑（非陪跑）计数 +1、跳日归零、到上限当日停跑（createTeam/joinTeam 同闸）。
//   我方口径：一局严格串行（终局→等回城散队→才建下一队），故在 #finishHunt 统一收口处 +1（每完成一局计一次），
//   与竞对「开局 +1」在串行语义下等价；陪跑不耗次数、不计数、不触上限。计数持久跨页（storage.data、与配置分离）。
/** @type {string} storage.data 逻辑键：当日已跑局数、日期戳与最近计数局 id */
const DAILY_RUNS_NAME = 'csHunt.daily';
/**
 * @type {{loaded:boolean, loading:boolean, date:string, runs:number, lastId:string}} 当日局数持久态内存镜像。
 *   模块级（跨引擎重建/pause→resume/换页保留）：lastId 为**跨实例去重键**，随快照落盘，防同一局多路收敛或
 *   战斗演出导致的 pause→resume→重建引擎后对同一 treasureId 重复 +1。
 */
const dailyRuns = { loaded: false, loading: false, date: '', runs: 0, lastId: '' };

/** 跳日归零：已读回且日期非今日则重置 runs/lastId 并落盘（未读回不动，避免把内存 0 覆盘上真值）。
 */
function rollDailyDate() {
  if (!dailyRuns.loaded) return;
  var today = todayStr();
  if (dailyRuns.date !== today) {
    dailyRuns.date = today;
    dailyRuns.runs = 0;
    dailyRuns.lastId = ''; // 换日：上一局的 id 不再参与去重
    persistDailyRuns();
  }
}

/** 异步读回当日局数（首调完成前按 0 处理；读失败不置 loaded——读不到 ≠ 盘上没数据，留待下次重试）。
 *   ⑤#3 在途读单飞：未 loaded 期间多路调用只踢一笔 get，避免多个 then 反复覆写；读回时刻以**当前内存 runs**
 *   为「已发生但尚未落盘的 bump」补算（loaded 前置闸门使读回前永不写盘，故内存增量必不在盘上，相加不重复），
 *   防读回前若已完成的 bump 被盘值覆盖而少计。
 */
function ensureDailyLoaded() {
  if (dailyRuns.loaded) {
    rollDailyDate();
    return;
  }
  if (dailyRuns.loading) return;
  dailyRuns.loading = true;
  Promise.resolve(storage.data.get(DAILY_RUNS_NAME))
    .then(function (saved) {
      dailyRuns.loaded = true;
      dailyRuns.loading = false;
      var preBumps = dailyRuns.runs; // 读回前已 bump、未落盘的增量（正常恒 0）
      dailyRuns.runs = 0;
      if (saved && typeof saved === 'object' && typeof saved.date === 'string') {
        dailyRuns.date = saved.date;
        dailyRuns.runs = Number(saved.runs) || 0;
        if (!dailyRuns.lastId) dailyRuns.lastId = saved.lastId ? String(saved.lastId) : '';
      }
      rollDailyDate(); // 非今日则归零（含 date/lastId 更新）
      if (preBumps > 0) dailyRuns.runs += preBumps; // ⑤#3 补回读回前已发生的一局
      persistDailyRuns();
    })
    .catch(function (err) {
      dailyRuns.loading = false; // 读失败复位在途闸门，loaded 仍 false 留待下次重试
      log.warn('daily runs load failed, retry next. %s', err && err.message);
    });
}

/** 落盘当日局数：未 loaded 绝不写盘（否则把内存 0 覆掉盘上真值）。
 *   ⑤#8 不再自建单飞闸门/看门狗——storage.data.set 已按 blob 串行队列落盘（core/storage.js enqueue），
 *   每次都以**当前最新态**入队，队列尾那笔即最终值，在途写不会丢最新快照。
 */
function persistDailyRuns() {
  if (!dailyRuns.loaded) return;
  Promise.resolve(
    storage.data.set(DAILY_RUNS_NAME, {
      date: dailyRuns.date,
      runs: dailyRuns.runs,
      lastId: dailyRuns.lastId,
    }),
  ).catch(function () {});
}

/** 跑完一局 +1 并落盘（仅主跑调用；陪跑不计数、也不触发上限）。
 * @param {string} runId 本局 treasureId（⑤#2 去重键：与 dailyRuns.lastId 相同则不重复计）
 */
function bumpDailyRun(runId) {
  ensureDailyLoaded();
  rollDailyDate();
  if (runId && runId === dailyRuns.lastId) return; // ⑤#2 跨实例/跨页去重（模块级 + 持久化）
  if (runId) dailyRuns.lastId = runId;
  dailyRuns.runs = (dailyRuns.runs | 0) + 1;
  persistDailyRuns();
}

/** 今日是否已达夺宝局数上限（limit=0/未读回视为不限、放行）。
 * @param {number} limit 面板配置的每日上限（0=不限）
 * @returns {boolean} */
function isDailyLimitReached(limit) {
  if (!(limit > 0)) return false;
  ensureDailyLoaded();
  rollDailyDate();
  return dailyRuns.runs >= limit;
}

/** 面板展示用：今日已跑局数（读回前回 -1 占位）。
 * @returns {number} */
export function getDailyRuns() {
  return dailyRuns.loaded ? dailyRuns.runs : -1;
}

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
   * ⑥ 每日局数满后「自动转陪跑」运行时开关位（借鉴竞对 autoSwitchToHelp，面板 cfg.autoSwitchToHelper 默认关）：
   *   主跑跑满 cfg.dailyRuns 后，若开了本开关则本引擎内部把有效模式视为 'helper'（不改面板 modCfg、不动 UID 存档），
   *   走陪跑找队/表态 op:2/不计数/不发 7534-7535 全套 helper 语义；未达上限（跳日归零或调高上限）即自动复位回主跑。
   *   与面板 mode 独立：仅当 rawCfg.mode==='main' 且达上限且开关开时才置真，故开关关（默认）时行为与本字段引入前完全一致（到上限停跑）。
   * @type {boolean}
   */
  #helperForced = false;
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
  /**
   * 本人是否已在最近一次 21372 召集的 readyMember 名单内（推送是窗口当前电平的最fresh源）。
   *   tick 第 4 步据此跳过补发；换队/散队/stop 随 #marchStartTeamId 一并复位。
   * @type {boolean}
   */
  #selfReadySeen = false;
  /** @type {Set<string>} 已成功发出 7523 决策的 uid（防同一申请重复审批；跨 7528 兜底复核去重） */
  #approved = new Set();
  /**
   * 待发送的入队申请决策队列 `uid → op`（1=同意/2=拒绝）。21374 推送为主路直接入队，7528 兜底拉取补入队；
   *   由 tick 的 #drainApplyPending 串行 await 逐条发 7523（#sendPB 同 cmd 在途去重，await 到应答即放行下一条），
   *   发送成功才移出并记入 #approved——修复旧版「同步循环连发多 7523、除首条外全被在途去重吞掉却已标已处理」致卡人。
   * @type {Map<string, number>}
   */
  #applyPending = new Map();
  /** @type {number} 上次 7528 兜底拉申请池的墙上时刻（毫秒）：推送为主路，此仅节流补漏 */
  #lastApplyListAt = 0;
  /** @type {string} 已就「无兵可派」留痕过的队伍 id（每队只 info 一次，避免逐拍刷屏） */
  #noArmyLoggedTeamId = '';
  /** @type {string} 已就「不可开车」留痕的原因（同类原因只 info 一次） */
  #blockedLoggedReason = '';
  /** @type {number} 上次 7501 拉态的墙上时刻（毫秒），兜底周期闸 */
  #lastInfoAt = 0;
  /**
   * @type {number} 当前队就位（本端首次看到该 teamId）的墙上时刻（毫秒）——「凑人超时」基准（借鉴竞对 `_ctWait`/`waitmin`）。
   *   换队/散队/收引擎时与 #marchStartTeamId 一并复位；用本端观察时刻而非服务器 createTime（字典未见该字段，不臆造）。
   */
  #teamSince = 0;
  /** @type {number} 上次找队（630→7530→7522）的墙上时刻（毫秒），节流 */
  #lastJoinAt = 0;
  /** @type {number} 陪跑找队轮转游标（rolePool 下标，每拍只搜 1 个成员，走到底回卷；stop 清） */
  #joinCursor = 0;
  /** @type {string} 已向哪个队发过 7522 申请（防找队快照滞后时重复申请同一队） */
  #appliedTeamId = '';
  /** @type {Map<string,string>} 引擎级 uid→昵称缓存（陪跑找队 630 取名用；查过不重查，查无记空串避免反复打网络；stop 清空） */
  #uidName = new Map();
  /** @type {Map<string,{at:number,power:number}>} 预警式防御敌战力缓存（uid → {墙上时刻, power}）；stop 清空 */
  #uidPower = new Map();
  /** @type {number} 上次消耗定位信标的墙上时刻（毫秒），冷却闸 */
  #lastBeaconAt = 0;
  /** @type {string} 已被服务器判「小队不存在」而收口的 treasureId（防陈旧控制器把同一死队回填后再次空拉 7531；stop 清） */
  #endedTreasureId = '';
  /**
   * 终局后「等飞船回城散队」闸门：{marchId:string(空串=未知，按 type=137 匹配), deadline:number}，
   *   置位后无队分支不建队/不入队；10019 到家边沿、21371 清空推或轮询确认行军消失/超时即解除（stop 清）。
   * @type {{marchId:string, deadline:number}|null}
   */
  #waitHome = null;
  /** @type {(() => void)|null} march.onHomeReturn 订阅退订句柄（散队闸门主解除通道；stop 摘除） */
  #homeUnsub = null;
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
   * 有效模块配置：⑥ 当本引擎已因「每日局数满·自动转陪跑」置 #helperForced 时，把 mode 覆写为 'helper' 后回吐，
   *   其余字段原样透传（返回浅拷贝，绝不改指 env.cfg() 的面板 modCfg 引用）；未强制则直接回吐原配置。
   *   引擎内所有「依赖 mode 的行为分叉」（tick 表态 wantReward / 计次 / FlowEngine.isMain 门 7534-7535）一律读本方法，
   *   而非裸读 env.cfg()，使自动转陪跑的运行语义与面板手选陪跑完全一致。
   * @returns {object} 有效模块配置
   */
  #cfg() {
    var c = this.#env.cfg();
    if (this.#helperForced && c && c.mode !== 'helper')
      return Object.assign({}, c, { mode: 'helper' });
    return c;
  }

  /**
   * 供 FlowEngine 使用的运行底座：把本引擎的实时态、sendPB 幂等发包、频道 17 聊天收发暴露给它，
   *   避免流程引擎自摸 net/reactor/chat 或重复订阅（chat 底座取 core/chat 的 chatApi，install 可能早于其就绪）。
   * @returns {object} FlowHost
   */
  #flowHost() {
    return {
      alive: () => this.#env.alive(),
      cfg: () => this.#cfg(),
      team: () => this.#team,
      isLeader: () => this.#isLeader(),
      sendPB: (cmd, inner, label) => this.#sendPB(cmd, inner, label),
      onWake: () => this.#wake(),
      // 预警式防御只读通路（竞对 onAttacking 同形）：901 marchInfo 拉敌行军窗 + 630 取敌战力
      worldMarches: (x, y, k) => this.#worldMarches(x, y, k),
      playerPower: (uidStr) => this.#playerPower(uidStr),
      chat: {
        send: (text, opts) => {
          var c = chatApi;
          if (!c || typeof c.send !== 'function')
            return Promise.reject(new Error('chat unavailable'));
          return c.send(text, opts);
        },
        normalize: (raw) => {
          var c = chatApi;
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
    this.#lastApplyListAt = 0; // 冷启动：首个 tick 即拉一次 7528 兜底补漏（此后按 APPLY_LIST_POLL_MS 节流）
    ensureDailyLoaded(); // ⑤ 预热当日局数计数（异步读回，读回前按 0 放行；跳日由 rollDailyDate 归零）
    ctx.on.push(21371, (ev) => this.#onTeamChange(this.#ack(ev, FIELD_TEAM_CHANGE)));
    ctx.on.push(21372, (ev) => this.#onReadyChange(this.#ack(ev, FIELD_READY_CHANGE)));
    ctx.on.push(21373, (ev) => this.#onMemberChange(this.#ack(ev, FIELD_MEMBER_CHANGE)));
    ctx.on.push(21374, (ev) => this.#onApplyChange(this.#ack(ev, FIELD_APPLY_CHANGE)));
    ctx.on.push(21375, (ev) => this.#onUserChange(this.#ack(ev, FIELD_USER_CHANGE)));
    ctx.on.push(21376, (ev) => this.#onHuntInfo(this.#ack(ev, FIELD_HUNT_INFO_CHANGE)));
    // 21383 来袭规模（真人掠夺）：转发给事件引擎驱动 P4 保命（本引擎不在此直发写包）
    ctx.on.push(21383, (ev) => this.#flow.onRaid(this.#ack(ev, FIELD_HURT_MARCH_SIZE)));
    // 终局后散队闸门主解除通道：飞船行军(marchType=137)到家边沿（march.js 全局单点 10019 复播，已滤到 state=ARRIVED_HOME）
    this.#homeUnsub = march.onHomeReturn((m) => {
      if (!this.#env.alive() || !this.#waitHome) return;
      if (Number(m.type) !== MARCH_TYPE_CS_TEAM_HUNT) return; // 按玩法行军型过滤，其它行军到家不唤醒
      var gid = this.#waitHome.marchId;
      if (gid && String(m.id) !== gid) return; // 已知本队飞船 marchId 时精确匹配
      this.#waitHome = null;
      log.info('cs-hunt ship arrived home and disbanded, starting next round of team build/join');
      this.#wake();
    });
    // 7501 应答也可能带整队（实录报文实证）：统一在此落地，装配层只管点火发包
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
    this.#selfReadySeen = false;
    this.#called = false;
    this.#approved.clear();
    this.#applyPending.clear();
    this.#lastApplyListAt = 0;
    this.#noArmyLoggedTeamId = '';
    this.#blockedLoggedReason = '';
    this.#lastInfoAt = 0;
    this.#teamSince = 0;
    this.#lastJoinAt = 0;
    this.#joinCursor = 0;
    this.#appliedTeamId = '';
    this.#uidName.clear();
    this.#uidPower.clear();
    this.#helperForced = false;
    this.#lastBeaconAt = 0;
    this.#endedTreasureId = '';
    this.#waitHome = null;
    if (this.#homeUnsub) {
      try {
        this.#homeUnsub();
      } catch (e) {
        /* 退订异常吞掉：摘除失败不阻断编排停摆 */
      }
      this.#homeUnsub = null;
    }
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
   * 7501 只读拉态（`{header:{}}`，实录报文实证）：team 由 resp 订阅落地，本方法只管择时。
   * 控制器实例缺席（没进过玩法子包）时，这是唯一能把开关态/整队喂进来的通道；在途或未落地均静默跳过，不阻断编排。
   * @param {boolean} force 无视兜底周期强拉一次
   */
  async refreshInfo(force) {
    var now = Date.now();
    if (!force && now - this.#lastInfoAt < INFO_REFRESH_MS) return;
    this.#lastInfoAt = now;
    await this.#sendPB(REQ_INFO, {}, 'fetch-activity-overview');
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
      // 队伍清空推（服务器权威「已散队」）：回城等待闸门随之解除，下一拍即可建队/入队
      if (this.#waitHome) {
        this.#waitHome = null;
        log.debug('team disbanded push arrived, releasing return-home wait gate');
      }
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
        this.#finishHunt('team push status=' + team.status + ' (returning/home)');
      return;
    }
    if (!this.#team || this.#team.id !== team.id) {
      this.#useItemTeamId = '';
      this.#marchedTeamId = '';
      this.#marchStartTeamId = '';
      this.#selfReadySeen = false;
      this.#called = false;
      this.#approved.clear();
      this.#applyPending.clear();
      this.#lastApplyListAt = 0; // 新队就位：尽快拉一次 7528 兜底（补订阅前可能已到的申请）
      this.#noArmyLoggedTeamId = '';
      this.#appliedTeamId = ''; // 已入队，清找队申请记账
      this.#teamSince = Date.now(); // 凑人超时基准：从本端看到新队起算
      log.info('team %s ready (cfg=%d, members %d)', team.id, team.cfg, team.memberCount);
    }
    this.#team = team;
    this.#wake();
  }

  /**
   * 队伍清空（21371 不带 team / status=ARRIVE / 解散应答）。
   */
  #clearTeam() {
    if (this.#team) log.info('team %s cleared (disbanded/home)', this.#team.id);
    this.#team = null;
    this.#useItemTeamId = '';
    this.#marchedTeamId = '';
    this.#marchStartTeamId = '';
    this.#selfReadySeen = false;
    this.#called = false;
    this.#approved.clear();
    this.#applyPending.clear();
    this.#noArmyLoggedTeamId = '';
    this.#appliedTeamId = ''; // 队已清空，允许重新找队申请
    this.#teamSince = 0;
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
    // ⑤ 主跑每完成一局计一次（陪跑不耗次数、不计数）：去重闸下沉到模块级 dailyRuns.lastId（⑤#2），
    //   既挡同实例内状态机 END / 21371 到家 / 7531 拒因多路收敛重计，也挡战斗演出 pause→resume→重建引擎后
    //   对同一 treasureId 的跨实例重计（lastId 随快照持久化，跨页亦生效）。
    if (deadId && this.#cfg().mode !== 'helper') bumpDailyRun(deadId);
    // 终局≠散队：飞船还在返程，到家才散（实证 END@+986s → 散队@+1063s）；窗口内 7521/7522 会被拒
    //   ava_team_tips_011=已加入其他队伍 → 置回城等待闸门，由 10019 到家推/21371 清空推/轮询+超时解除
    var waitMarchId = t && t.selfMarchId && t.selfMarchId !== '0' ? String(t.selfMarchId) : '';
    log.info(
      'this cs-hunt march finished (%s), stop pulling run detail, moving to next round',
      source,
    );
    this.#flow.reset();
    this.#clearTeam();
    if (!this.#waitHome) {
      this.#waitHome = { marchId: waitMarchId, deadline: Date.now() + WAIT_HOME_MAX_MS };
      log.info(
        'waiting for cs-hunt ship to return home and disband before team build/join%s',
        waitMarchId ? ' (march ' + waitMarchId + ')' : '',
      );
    }
  }

  /**
   * 兜底：7531 拉本跑详情被服务器以「小队不存在」等终局拒因回绝（cs_treasure294，字典表实证）即宣告该
   *   treasureId 已消亡。主路径已由 21376 状态机 END/RETURN 推送提前约 90s 判定（见 #onHuntInfo），此处仅
   *   作**漏推兜底**——状态机推送丢失时才靠它收口。
   * @param {string} reason 服务器多语言拒因键
   */
  #endHunt(reason) {
    this.#finishHunt(
      '7531 end-reject reason ' + reason + '=cs-hunt team not found (missed-push fallback)',
    );
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
    // 名单里有没有本人——没有则说明召集窗口被重开且本人准备被重置（迟到队员到位后全员重准备的实证
    //   真机事故：同一队 ready 名单 0→1→2→3→0 循环十余次，7527 因一次性闸门再没补发，队友视角「迟迟不准备」）
    var myUid = gameData.myUidStr();
    var selfIn = false;
    for (var i = 0; i < ready.length; i++) {
      var ru = ready[i];
      if (bits.int64Str(ru && ru.uid != null ? ru.uid : ru) === myUid) selfIn = true;
    }
    this.#selfReadySeen = selfIn;
    if (!selfIn && this.#marchStartTeamId === this.#team.id) {
      this.#marchStartTeamId = ''; // 重武装召集表态闸门，交 tick 第 4 步补发 7527
      log.info(
        'rally window reopened and self not in ready list (ready=%d), re-sending ready',
        ready.length,
      );
    }
    log.debug('ready call: team %s, ready=%d self=%s', this.#team.id, ready.length, selfIn);
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
    // 成员增减不再触发拉申请池（申请由 21374 推送主路处理 + 7528 节流兜底）；仅唤醒重算凑人/召集电平
    this.#wake();
  }

  /**
   * 21374：入队申请变更（`{teamId, uid, op, apply:{uid,teamId,playerInfo,power}}`）——**审批主路**（用户口径 2026-10-18：
   *   申请本就由推送携带完整信息到达，应直接处理，7528 定期拉取仅作兜底）。op=1 新申请：按 uid 结合 rolePool 决策略
   *   入 #applyPending（同意/拒绝），交 tick 串行发 7523；op=2 撤回：从 pending 与 #approved 一并摘除（该玩家已自行离队，
   *   清账以便其再次申请时重新决策）。推送帧可能乱序/重复，#applyPending+#approved 双集合天然幂等。
   * @param {object|null} payload 申请变更体
   */
  #onApplyChange(payload) {
    if (!payload) return;
    var teamId = bits.int64Str(payload.teamId);
    if (!this.#team || (teamId && this.#team.id !== teamId)) return;
    if (!this.#isLeader()) return;
    var op = Number(payload.op) || 0;
    var uid = bits.int64Str(payload.uid || (payload.apply && payload.apply.uid));
    if (!uid) return;
    if (op === 2) {
      this.#applyPending.delete(uid); // 撤回：撤销未发出的决策
      this.#approved.delete(uid); // 清已处理账，允许其再次申请时重新审批
      this.#wake();
      return;
    }
    if (op === 1) this.#queueApplyDecision(uid);
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
      //   （报文实证实录：status=4@+986s、status=5@+1013s，而 7531 直到 +1078s 才 cs_treasure294）
      //   → 主判定走此，停掉对将消亡 treasureId 的 7531 空拉、尽快转下一轮；7531 拒因路径（#endHunt）降为漏推兜底。
      //   仅当推送 tid 与当前队一致才收口（新一轮已开跑时旧 END 迟到不误清）。
      var endTid = bits.int64Str(payload.treasureId);
      var curTid = this.#team ? String(this.#team.treasureId || this.#team.id || '') : '';
      if (this.#team && endTid && endTid === curTid) {
        this.#finishHunt(
          'state-machine push status=' + status + ' (end/return, round=' + payload.round + ')',
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
   * 7528 应答（**兜底补漏**，主路是 21374 推送）：申请池 `{apply:[{uid,teamId,playerInfo,power}]}` → 池内每个未决策
   *   uid 复用 #queueApplyDecision 入队（与推送同一决策/幂等口径），发送仍交 tick 串行 drain。已开跑（status≥MARCHING）
   *   的迟到应答忽略（不再审批）。修复旧版「同步循环连发多 7523 被在途去重吞掉却已标已处理」的卡人缺陷。
   * @param {object|null} payload 申请池体
   */
  #onApplyList(payload) {
    if (!payload || !this.#isLeader() || !this.#team) return;
    if (this.#team.status >= TEAM_STATUS.MARCHING) return; // 已开跑：迟到申请池不再审批
    var apply = Array.isArray(payload.apply) ? payload.apply : [];
    for (var i = 0; i < apply.length; i++) {
      var uid = bits.int64Str(apply[i] && apply[i].uid);
      if (uid) this.#queueApplyDecision(uid);
    }
    this.#wake(); // 有未决策项 → 唤醒尽快 drain（不等下一拍 15s）
  }

  /**
   * 依 rolePool 对某申请 uid 做决策并入待发送队列（推送主路与 7528 兜底共用；幂等：已处理/已排队即跳过）。
   *   池为空=不限角色一律同意；命中池=同意；池外且勾了拒绝=拒绝；池外未勾拒绝=忽略（留在列表，不代答）。
   * @param {string} uid 申请者 uid（字符串形态）
   */
  #queueApplyDecision(uid) {
    if (this.#approved.has(uid) || this.#applyPending.has(uid)) return;
    var cfg = this.#env.cfg();
    var pool = poolSet(cfg.rolePool);
    var op = 0;
    if (!pool.size || pool.has(uid)) op = 1;
    else if (cfg.rejectOutsidePool) op = 2;
    if (op) this.#applyPending.set(uid, op);
  }

  /**
   * 串行发送待审批决策（tick 唯一消费者）：逐条 await 7523，获服务器应答（无论成败）即移出 pending 并记 #approved；
   *   仅当未真正发出（在途去重 CODE_NOT_SENT/异常）时中断本轮、保留 pending 待下拍重试——杜绝旧版「连发被吞仍标已处理」致卡人。
   */
  async #drainApplyPending() {
    if (!this.#applyPending.size) return;
    var entries = Array.from(this.#applyPending.entries());
    for (var i = 0; i < entries.length; i++) {
      var uid = entries[i][0];
      var op = entries[i][1];
      var ret = await this.#sendPB(
        REQ_TEAM_APPLY_OP,
        { uid: bits.int64(uid), op: op },
        op === 1 ? 'approve-apply' : 'reject-outside-pool',
      );
      if (ret.code === CODE_NOT_SENT) return; // 未真正发出（在途/异常）：保留 pending 下拍重试
      this.#applyPending.delete(uid);
      this.#approved.add(uid); // 已获应答（含服务器拒因）即记账，避免对同一 uid 空转重发
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
    // ⑥ 自动转陪跑复位：已因「局数满」强制转陪跑，但当前已不达上限（跳日归零/调高上限）或关了该开关 → 复位回主跑
    var rawCfg = env.cfg();
    if (
      this.#helperForced &&
      (!isDailyLimitReached(rawCfg.dailyRuns) ||
        !rawCfg.autoSwitchToHelper ||
        rawCfg.mode === 'helper')
    ) {
      this.#helperForced = false;
      log.info(
        'daily cs-hunt runs no longer in full-quota forced state, ending auto side-run mode, back to main run',
      );
    }
    var cfg = this.#cfg();

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
        // 控制器回填路径同样要在换队时复位召集闸门与凑人超时基准（与 21371 落地处同律，否则旧队闸门残留卡死）
        if (!this.#team || this.#team.id !== st.team.id) {
          this.#marchStartTeamId = '';
          this.#selfReadySeen = false;
          this.#teamSince = Date.now();
        }
        this.#team = st.team;
      }
      if (this.#count == null && st.huntCount > 0) {
        this.#count = st.huntCount; // 控制器 huntCount 只作回填下限：推送 21375 才是权威（它没来才借这个值）
      }
    }

    if (!this.#team) {
      // 终局后回城散队闸门：飞船未到家前不建队/不入队（否则游戏 UI 持续提示「已加入其他队伍」）
      var waitSleep = await this.#homeWait();
      if (waitSleep > 0) return waitSleep;
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

    // 界面在夺宝页外时服务器队伍态推送不可达（实录实证：审批后整队冻结 3 分钟，点开队伍页才收到 21372）
    //   → 主动轮询 7501 补整队电平（应答经 ctx.on.resp(REQ_INFO) 落地 #team），不再只看 !present()：
    //   控制器在场但人在页外时镜像同样陈旧，readState 回填不可靠；召集判定改靠应答电平驱动
    if (Date.now() - this.#lastInfoAt >= TEAM_POLL_MS) await this.refreshInfo(true);

    // 1) 入队申请：先串行发送已决策项（推送/兜底入队），再按节流兜底拉 7528 补漏（主路是 21374 推送，此处仅防漏推）
    if (this.#isLeader()) {
      await this.#drainApplyPending();
      if (t.memberCount < 5 && Date.now() - this.#lastApplyListAt >= APPLY_LIST_POLL_MS) {
        this.#lastApplyListAt = Date.now();
        await this.#sendPB(REQ_TEAM_APPLY_LIST, { teamId: bits.int64(t.id) }, 'fetch-apply-pool');
      }
    }

    // 2) 本人表态要奖励/陪跑（队长不发包：建队已含队长次数消耗）；mode 决定要奖励(op:1)还是陪跑(op:2)
    if (!this.#isLeader() && this.#useItemTeamId !== t.id) {
      var wantReward = cfg.mode === 'main';
      if (wantReward && this.#count === 0) {
        // 主跑但次数为 0：勾了信标补次数则先消耗一个再等 21375 刷新（本轮不表态，下拍复查）；否则降级陪跑加入不浪费时机
        if (cfg.useBeaconWhenShort) {
          var topped = await this.#useBeacon('before-reward');
          if (topped) return ACTIVE_TICK_MS;
        }
        wantReward = false;
      }
      this.#useItemTeamId = t.id;
      await this.#sendPB(
        REQ_TEAM_USE_ITEM,
        { op: wantReward ? 1 : 2 },
        wantReward ? 'join-for-reward' : 'join-as-helper',
      );
    }

    // 3) 满编出征入队（7519 走 NET.send；无兵不发空包，等回城推送唤醒补派）
    if (this.#marchedTeamId !== t.id) {
      var sent = await this.#marchFull(t);
      if (!sent) return ACTIVE_TICK_MS; // 本轮无兵/未发成，下一拍重试（info 已按队留痕一次）
    }

    // 4) 召集出发（用户口径硬条件）：队长在「等待人数到齐」且「全员都已完成出兵」时主动发起 7527；
    //    任一角色收到 21372 召集（readyMember 含本人）后表态同意。
    //    闸门语义是「当前召集窗口内本人未表态」而非「本队终身一次」：窗口重开时 #onReadyChange 会重武装
    //    #marchStartTeamId；快照 readyUids/#selfReadySeen 已含本人则不重发（7527 若是切换语义会误取消准备）。
    //    凑人超时（借鉴竞对 waitmin L16064-16076）：人数未达目标但已到位成员皆派兵成功，等满 waitMin 分钟也发车，
    //    否则 targetMemberNum 调高（最大 5）而现场只来 2~3 人时会永久等待；仍守住 allMarched（服务器对未派兵者会拒
    //    common_159995，拒后回滚闸门交下拍重试，故超时只放宽「人数」不放宽「出兵」）。
    var selfReady =
      this.#selfReadySeen ||
      (Array.isArray(t.readyUids) && t.readyUids.indexOf(gameData.myUidStr()) >= 0);
    if (this.#marchStartTeamId !== t.id && !selfReady) {
      var called = this.#called || t.readyCount > 0; // 收到召集/已在 ready 名单 → 表态（成员/队长通用）
      // 人数到齐：memberCount 达目标（targetMemberNum）且非空
      var full = this.#isLeader() && t.memberCount > 0 && t.memberCount >= targetMembers(cfg);
      // 全员完成出兵：每个成员 marchId 非零（都派兵到集结点了）
      var allMarched = this.#isLeader() && t.memberCount > 0 && t.marchedCount === t.memberCount;
      var waitMin = cfg.waitMin == null ? DEFAULT_WAIT_MIN : Number(cfg.waitMin);
      var waitedOut =
        this.#isLeader() &&
        waitMin > 0 &&
        !!this.#teamSince &&
        Date.now() - this.#teamSince >= waitMin * 60000;
      if (called || (full && allMarched) || (waitedOut && allMarched)) {
        var wasCalled = this.#called;
        this.#marchStartTeamId = t.id;
        this.#called = false;
        if (!full && waitedOut)
          log.info(
            'people-gathering timed out after %d min, members %d/%d, launching directly (all present members have dispatched)',
            waitMin,
            t.memberCount,
            targetMembers(cfg),
          );
        var ret = await this.#sendPB(REQ_MARCH_START, { op: 1 }, 'agree-depart');
        var code = ret ? ret.code : CODE_NOT_SENT;
        // 闸门只能在 7527 真正受理后提交：过早召集被拒（common_159995=有人 7519 尚未落地）或未真正发出时回滚，
        //   交下拍全员出兵落地后重试（否则一次性闸门被拒因吃掉 → 本队永久不再召集，页外 21372 又收不到 → 卡死）
        if (code !== 0) {
          this.#marchStartTeamId = '';
          this.#called = wasCalled; // 召集电平仍在则保留，下拍据此（或 allMarched 追平后）重试
        }
      } else if (full || waitedOut) {
        // 召集闸未开的静默期留痕（对齐调度决策日志规范）：页外 21372 不可达时卡点只能靠本行事后归因。
        //   full（人已达目标）或 waitedOut（凑人超时）时打——前者是「人齐了却不发车」的真卡点，后者是「差出兵」的超时卡点
        log.info(
          'waiting for rally depart reason=%s; members=%d/%d; marched=%d; selfMarch=%s; waited=%ds (re-checked with 7501 polling roughly every %ds)',
          t.marchedCount === 0 ? 'nobody dispatched' : 'some members failed to dispatch',
          t.memberCount,
          targetMembers(cfg),
          t.marchedCount,
          t.selfMarchId && t.selfMarchId !== '0' ? 'ok' : 'MISSING',
          this.#teamSince ? Math.round((Date.now() - this.#teamSince) / 1000) : -1,
          TEAM_POLL_MS / 1000,
        );
      }
    }

    return ACTIVE_TICK_MS;
  }

  /**
   * 回城散队闸门的 tick 电平检查（仅无队分支调）：主解除靠 10019 到家推/21371 散队推，本方法是漏推兑底——
   *   读 march.js 快照（856 播种 + 10019 边沿维护，cache 零发包）：本队飞船行军仍在（含 RETURNING 返程）
   *   → 服务器尚未散队，继续等；已从列表消失/到家 → 解除闸门放行下一轮；超时兑底防死等。
   * @returns {Promise<number>} >0 = 仍在等待（下一拍毫秒数）；0 = 闸门已解除/未置，放行建队/入队
   */
  async #homeWait() {
    var wait = this.#waitHome;
    if (!wait) return 0;
    if (Date.now() >= wait.deadline) {
      this.#waitHome = null;
      log.info(
        'return-home disband wait timed out (missed-push fallback), allowing team build/join retry',
      );
      return 0;
    }
    var ms = await march.list({ cache: true });
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      var hit = wait.marchId ? m.id === wait.marchId : Number(m.type) === MARCH_TYPE_CS_TEAM_HUNT;
      if (hit && m.state !== march.State.ARRIVED_HOME) return HOME_POLL_MS; // 飞船仍在途（返程也算）：服务器未散队
    }
    this.#waitHome = null;
    log.info(
      'cs-hunt ship returned home and disbanded (confirmed by snapshot polling), starting next round of team build/join',
    );
    return 0;
  }

  /**
   * 活动双闸（每拍写包前校验，用户口径「夺宝时间窗口结束不应继续写包」）：
   *   ① 玩法进行中（open===1；休赛=3/其余未开）——控制器在场用 st.active 实时判，缺席用 7501 应答落地的 #openFlag；
   *   ② 当前落在每日 3 个夺宝时段之一（#slots 由 7501 openTime[] 解析；open===1 是赛季旗标整天为真，不等于「到点」）。
   *   任一未知则不贸然建队/加入，强拉一次 7501 后短睡等应答落地（resp 里 #openFlag/#slots 变更即 #wake 重评）；
   *   未到点则 info 一次（带下一场分钟数）并睡到下个时段（封顶阶梯：远窗 1h/近窗 30min，且绝不跨过 nextBegin；
   *   开关态变化另有 7501 应答 #wake 即时通道，封顶只兜「时段表被改早」这类无推送的漂移）。
   *   已开跑的一局（status>=MARCHING）由 tick 调用方豁免（服务端权威、一跑仅数分钟，让其跑完）。
   * @param {object|null} st csHunt 只读快照（控制器不在场为 null）
   * @returns {Promise<{proceed:boolean, sleep:number}>} proceed=true 才放行建队/找队/表态等写包
   */
  async #gateActivity(st) {
    var openKnown = st ? !!st.active : this.#openFlag != null ? this.#openFlag === 1 : null;
    if (openKnown === false) {
      this.#blockOnce(
        'off',
        'cs-hunt not in activity time now (mode not open / off-season), skip team build/join',
      );
      return { proceed: false, sleep: IDLE_TICK_MS };
    }
    if (openKnown === null) {
      await this.refreshInfo(true);
      this.#blockOnce(
        'unknown',
        'cs-hunt activity state unknown (awaiting 7501 ack), skip team build/join this round',
      );
      return { proceed: false, sleep: ACTIVE_TICK_MS };
    }
    var win = csHunt.playWindowState(this.#slots, csHunt.serverMs());
    if (!win.known) {
      await this.refreshInfo(true);
      this.#blockOnce(
        'nowin',
        'cs-hunt play-window schedule unknown (awaiting 7501 openTime), skip team build/join this round',
      );
      return { proceed: false, sleep: ACTIVE_TICK_MS };
    }
    if (!win.in) {
      var wait = win.nextBegin ? win.nextBegin - csHunt.serverMs() : IDLE_TICK_MS;
      this.#blockOnce(
        'window',
        'cs-hunt not in a daily play window now (3 runs/day), skip team build/join' +
          (win.nextBegin
            ? ', next run in about ' + Math.max(0, Math.round(wait / 60000)) + ' min'
            : ''),
      );
      var cap = wait > WINDOW_WAIT_CAP_FAR_MS ? WINDOW_WAIT_CAP_FAR_MS : WINDOW_WAIT_CAP_NEAR_MS;
      return { proceed: false, sleep: Math.min(Math.max(wait, ACTIVE_TICK_MS), cap) };
    }
    this.#blockedLoggedReason = '';
    return { proceed: true, sleep: 0 };
  }

  /**
   * 无队分支（活动双闸已由 tick 顶的 #gateActivity 放行）：按玩法模式派发——
   *   主跑 → 一律 7521 建队开车（不回退找队，避免无人建队时一直「找不到夺宝小队」）；
   *   陪跑 → 按间隔逐个搜玩家池成员按名搜队申请加入（#joinTeam，每拍只搜 1 个）。
   * @param {object} cfg 模块配置
   * @param {object|null} st csHunt 只读快照（控制器不在场为 null）
   * @returns {Promise<number>} 下一拍间隔
   */
  async #noTeam(cfg, st) {
    // ⑤ 每日局数上限（借鉴竞对 setting.team.count）：仅主跑受闸——到上限当日停跑，跳日自动归零；0/未配=不限。
    //   #1 不能放在 mode 分叉前共用：dailyRuns.runs 为模块级+持久化、跨实例共享，而字段 showIf:isMain（切陪跑只隐藏不清值），
    //   若主跑跑满额度后切陪跑会整日被误挡（面板看不到该项、statusText 也不显示），与「陪跑不计数不受此限」契约相悖。
    if (cfg.mode !== 'helper' && isDailyLimitReached(cfg.dailyRuns)) {
      // ⑥ 面板开了「满次自动转陪跑」：置强制位（下拍起 #cfg() 把有效 mode 视为 helper），立即转找队链路
      if (cfg.autoSwitchToHelper) {
        if (!this.#helperForced) {
          this.#helperForced = true;
          log.info(
            'daily cs-hunt runs reached cap (%d), auto switching to helper team-finding (panel switch; resets to main run on day roll / cap raise)',
            cfg.dailyRuns,
          );
        }
        return this.#joinTeam(cfg);
      }
      this.#blockOnce(
        'daily',
        'daily cs-hunt runs reached cap (' +
          cfg.dailyRuns +
          '), skip team build/join (auto recovers next day)',
      );
      return IDLE_TICK_MS;
    }
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
      if (cfg.useBeaconWhenShort && (await this.#useBeacon('before-team-create'))) {
        return ACTIVE_TICK_MS; // 信标已消耗，等 21375 刷新次数后下拍复查
      }
      this.#blockOnce(
        'count',
        'cs-hunt count is 0, skip team build (game refills 1 point per 10h; no beacon top-up unless checked/in-stock)',
      );
      return IDLE_TICK_MS;
    }
    var ret = await this.#sendPB(REQ_TEAM_CREATE, { cfg: TEAM_CFG }, 'create-team');
    var ack = ret && ret.payload ? ret.payload[ACK_TEAM_CREATE] : null;
    if (ack && ack.team) this.#onTeamChange(ack);
    // 服务器判旧队未散（飞船在返途中，终局刚收口而推送漏接时会走到这里）：回闸并停止逐拍连打 7521
    var rsn =
      ret && !ret.ok && ret.payload && ret.payload.header ? String(ret.payload.header.d || '') : '';
    if (rsn === 'ava_team_tips_011' && !this.#waitHome) {
      this.#waitHome = { marchId: '', deadline: Date.now() + WAIT_HOME_MAX_MS };
      log.info(
        'team build rejected ava_team_tips_011=already in another team (old disband not landed), waiting for ship return-home before retry',
      );
    }
    return ACTIVE_TICK_MS;
  }

  /**
   * 陪跑找队（用户口径「主动挨个去搜索玩家池中的玩家」，2026-10-25 调整为每拍只搜 1 个）：按 #joinCursor
   *   轮转取池内下一个有效玩家（跳过自己/无效 uid）→
   *   ① 630 PLAYER_INFO 按 uid 取昵称（#lookupName，带缓存）→ ② 7530 按昵称 likeName 搜其创建的队 →
   *   ③ 命中未满、未申请、队长即该玩家的队 → 7522 op:1 申请加入，找到即停手。
   *   每拍之间按 JOIN_POLL_MS 节流（原一趟连打整池已废弃）；游标走到底回卷重扫；申请后等 21371/21373 落地接管（不轮询等审批）。
   *   报文实证实录：630 应答 data.playerInfo(JSON 串).username=昵称；7530 请求 {likeName}，
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
    var n = pool.length;
    // 每拍只搜 1 个成员：从游标起取下一个有效玩家（跳过无效 uid/自己/查无昵称），走完全池即回卷从头再扫
    var idx = -1;
    var uidStr = '';
    var name = '';
    for (var step = 0; step < n && idx < 0; step++) {
      if (!this.#env.alive()) return IDLE_TICK_MS;
      var i = (this.#joinCursor + step) % n;
      var it = pool[i] || {};
      uidStr = bits.int64Str(it.uid);
      if (!uidStr || uidStr === myUid) continue; // 跳过无效 uid 与自己（陪跑不加本人开的队）
      name = (await this.#lookupName(net, uidStr)) || String(it.name || '').trim();
      if (!name) continue;
      idx = i;
      this.#joinCursor = (i + 1) % n;
    }
    if (idx < 0) {
      this.#blockOnce(
        'nojoin',
        'player pool empty or all invalid uid / name not found, skip team search',
      );
      return JOIN_POLL_MS;
    }
    // 本拍只搜这一个：7530 按昵称搜其创建的队，命中未满/未申请/队长即该玩家的队即 7522 申请
    var ret = await this.#sendPB(REQ_SEARCH_TEAM_LIST, { likeName: name }, 'search-team-by-name');
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
        'apply-join-team',
      );
      return ACTIVE_TICK_MS;
    }
    log.info(
      `search-team-by-name: searched ${name} this tick (pool ${n} rotating, next tick #${(idx + 1) % n}), no under-full team hit`,
    );
    return JOIN_POLL_MS;
  }

  /**
   * 630 PLAYER_INFO 按 uid 取玩家昵称（陪跑找队按名搜队用；业务强相关报文收口本 feat，不入通用 net.js）。
   *   报文实证实录：req `{uid:"字符串"}`（NET.send，非 sendPB）；应答 data.playerInfo 是 JSON 串，
   *   其内 username=显示昵称（nickname 常空，昵称可含 emoji/空格）。命中缓存直接回；查无/异常缓存空串避免反复打网络；stop() 清缓存。
   * @param {object} net 网络底座
   * @param {string} uidStr 目标玩家 uid（字符串）
   * @returns {Promise<string>} 昵称（取不到回空串）
   */
  async #lookupName(net, uidStr) {
    if (this.#uidName.has(uidStr)) return this.#uidName.get(uidStr);
    var name = '';
    // 630 异常降级：sendGuarded 永不 reject（投递失败/超时/回调异常自愈为 ok:false），查不到名字即回空串缓存，不阻断找队循环
    var ret = await net.sendGuarded(CMD_PLAYER_INFO, { uid: String(uidStr) }, { gate: false });
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
    this.#uidName.set(uidStr, name);
    return name;
  }

  /**
   * 预警式防御：单窗 901（GET_WORLD_INFO）marchInfo 拉敌行军列表（竞对 onAttacking 同形：
   *   以本据点 tInfo 为窗心、width32×height20、viewLevel0、k=tInfo.sid 跳服务服号），只回 marchList。
   *   只读发包（零副作用）；网络底座缺失/应答非 ok/解析失败一律降级空数组，交由调用方 fail-safe（不拦不烧技）。
   * @param {number} x 本据点 game x（tInfo.x）
   * @param {number} y 本据点 game y（tInfo.y）
   * @param {number} k 服号（tInfo.sid，跨服夺宝点所在服；非本服 ServerId）
   * @returns {Promise<object[]>} marchList（项含 marchId/uid/marchType/state/target{tx,ty}/marchArrive 等，形状同竞对）
   */
  async #worldMarches(x, y, k) {
    var net = this.#env.net();
    if (!net) return [];
    var body = {
      x: x,
      y: y,
      k: k | 0,
      rid: 0,
      width: 32,
      height: 20,
      marchInfo: true,
      viewLevel: 0,
    };
    var ret = await net.sendGuarded(CMD_GET_WORLD_INFO, body, { gate: false });
    if (!ret || !ret.ok) return [];
    var d = ret.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (e) {
        return [];
      }
    }
    return d && Array.isArray(d.marchList) ? d.marchList : [];
  }

  /**
   * 预警式防御：630 PLAYER_INFO 按 uid 取敌玩家战力（与队内最强 power 同口径比强）。POWER_CACHE_MS 内同 uid 不重查；
   *   查无/异常缓存 0（敌强门控据此不拦——战力未知则不提前烧技，保守）。永不 reject。
   * @param {string} uidStr 敌玩家 uid（字符串）
   * @returns {Promise<number>} 战力（取不到回 0）
   */
  async #playerPower(uidStr) {
    if (!uidStr) return 0;
    var hit = this.#uidPower.get(uidStr);
    if (hit && Date.now() - hit.at < POWER_CACHE_MS) return hit.power;
    var net = this.#env.net();
    if (!net) return 0;
    var ret = await net.sendGuarded(CMD_PLAYER_INFO, { uid: String(uidStr) }, { gate: false });
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
    var power = pi ? Number(pi.power) || 0 : 0;
    this.#uidPower.set(uidStr, { at: Date.now(), power: power });
    return power;
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
      this.#blockOnce('beacon', label + ': no loc beacon(47001001) in backpack, skip count top-up');
      return false;
    }
    if (net.isSending(CMD_ITEM_USE)) return false;
    this.#lastBeaconAt = now;
    var threw = false;
    var ret = await net.sendGuarded(
      CMD_ITEM_USE,
      { itemid: ITEM_BEACON, amount: 1 },
      {
        gate: false,
        onError: function (err) {
          log.warn('%s beacon send threw. %s', label, err && err.message);
          threw = true;
        },
      },
    );
    if (threw) return false;
    if (ret && ret.ok) {
      var remain = ret.data && ret.data.amount;
      log.info(
        '%s beacon consumed to refill count ok (remain %s)',
        label,
        remain == null ? '?' : remain,
      );
      return true;
    }
    log.info(
      '%s beacon rejected code=%s;data=%s',
      label,
      ret ? ret.code : CODE_NOT_SENT,
      rejectText(ret) || '-',
    );
    return false;
  }

  /**
   * 满编出征 7519：按 presetPool 取第一个能出兵的预设，直发 JSON 通道（**非 sendPB**）。
   * 报文体逐键对齐实录报文：`{marchType:137,armyList,armyListNew,heroList,trapList,formation:0,formationV2}`，
   *   体内无 treasureId；extraArmy 仅在有补位时才带（录制样本无此键，PB 编码空对象会多出脏字段）。
   * @param {object} t 队伍快照
   * @returns {Promise<boolean>} 是否已发出（无兵/未发出返回 false，由调用方下一拍重试）
   */
  async #marchFull(t) {
    // 游戏侧已有本人行军（marchId 非零），不再重复派；
    //   注意 bits.int64Str(Long(0,0)) 回 '0' 代表「无行军」，不可当 truthy 误判（实录事故根因）。
    if (t.selfMarchId && t.selfMarchId !== '0') {
      this.#marchedTeamId = t.id;
      return true;
    }
    var cfg = this.#env.cfg();
    var plan = buildPlanFromPool(cfg.presetPool || []);
    if (!plan) {
      if (this.#noArmyLoggedTeamId !== t.id) {
        this.#noArmyLoggedTeamId = t.id;
        log.info(
          'presetPool %j has no dispatchable army, holding march, waiting return-home wake to re-dispatch',
          cfg.presetPool || [],
        );
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
    var threw = false;
    var ret = await net.sendGuarded(REQ_TEAM_MARCH, body, {
      gate: false,
      onError: function (err) {
        log.warn('7519 send threw. %s', err && err.message);
        threw = true;
      },
    });
    if (threw) return false;
    if (ret && ret.ok) {
      this.#marchedTeamId = t.id;
      this.#noArmyLoggedTeamId = '';
      log.info(
        'full march ok (armyId=%d, squads %d, heroes %d)',
        plan.armyListNew[0].armyId,
        plan.armyListNew.length,
        plan.heroList.length,
      );
      return true;
    }
    log.info(
      'full march rejected code=%s;data=%s',
      ret ? ret.code : CODE_NOT_SENT,
      rejectText(ret) || '-',
    );
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
    var threw = false;
    var ret = await net.sendGuarded(cmd, body, {
      protocol: 'sendPB',
      gate: false,
      onError: function (err) {
        log.warn('%s (%d) send threw: %s', label, cmd, err && err.message);
        threw = true;
      },
    });
    if (threw) return { ok: false, code: CODE_NOT_SENT, payload: null };
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
