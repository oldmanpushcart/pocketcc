/**
 * CQ26 印石·保卫能量（方舟试炼 SERIES_FROST_ARK_TRIAL，marchType 306）：自动驻塔补兵 + 状态维护（cq26ArkEnergy）
 *
 * 玩法（源码 `CQ26ArkWorldPop` / `CQ26ArkData` / `CQ26ArkMainContent` + i18n `series_frost_energybattle_*` /
 *   `series_frost_silo*`，中文面板名「保卫能量」）：本服 vs 敌服跨服对抗，蓄能塔（塔 id=3 = CQ26TOWERID.ARK，
 *   实录坐标 408,508）为争夺点。阶段机 `PBEnumSeriesFrostArkTrialStageStatus`：
 *   NONE0 → PREPARE1 筹备 → DEPLOY2 部署（派兵窗）→ FIGHT3 战斗（逐波 round/maxRound=20）⇄ READY4 间歇（再派窗）→ END5。
 *   参战 = 用战斗预设向塔发一条 902（marchType 306）；部队数秒后整体返航（报文实证 10:26:14 派 → 10:26:29
 *   10019 state=4 ARRIVED_HOME），**不长期占用行军队列**，驻守以服务器侧记账为准；波次间服务器把塔红点
 *   `arkArmyRed` 复燃催补兵，补兵与首派是同一条 902-306（同预设展开、报文形状相同）——「每波补兵」在
 *   协议层没有独立报文，就是红点复燃后的重新派兵。
 *   FIGHT 阶段游戏面板禁点参战（源码 joinBattleClick 非 DEPLOY/READY 分支 tip silo347），本 feat 同口径禁派。
 *
 * 协议清单（NRequestIdV2 / NResponseIdV2，载荷形态逐键抄自实录报文，标注见各常量注释）：
 *   22007 push（SERIES_FROST 状态族）：`{cid, towerId:3, arkData{status, beginTimeSec, endTimeSec, round,
 *       maxRound:20, arkArmyRed, towerId:3, cfgId}}` —— 阶段/红点/波次的**实时真相源**。游戏侧
 *       CQ26ArkData.updateData 逐字 `this.data = e.arkData; this.cid = e.cid`（内存投影与 push 同源）；
 *       实录两帧：09:59:59 `{status:2, round:0, maxRound:20, arkArmyRed:true}` 开场催派 →
 *       10:26:29 `arkArmyRed:false` 受理确认（上周场 11-07 11:46:27 同型翻转，只派了这一次、未补兵）。
 *   2336 SERIES_FROST_ARK_TRIAL_DETAIL_INFO  req {} resp {sNum,myNum,totalNum}：面板「本服/总参战」两列的
 *       真相源（实录 10:26 `{2,6,12}` → 派兵受理后 myNum 6→8）。**自动化判据不用它、也不轮询它**
 *       （参战人数是纯展示数据；面板作战状态行只镜像 22007 与本会话派兵记账，零发包），此处仅留协议形态备查。
 *   902 MARCH_WORLD_POINT `marchType=306` 派兵 —— 走 `core/march.attack()` 组 canonical body，与录制逐键一致
 *       （实证 10:26:14：`{marchType:306, x:408, y:508, armyList/armyListNew 9 队 pos 1/2/3/11/12/13/21/22/23,
 *       heroList:[170,174,169], trapList:[], break:0, formation:0, formationV2:1001, extraArmy}`）。
 *   22002 / 22003 / 22008 push SERIES_FROST_INIT / _INFO / _INFO_CHANGE：带 `towerInfoList`
 *       （同场 22007/2331 均实证蓄能塔 `towerId:3`），是塔坐标的**纯报文回落副本**（ACL 内存投影
 *       `cq26DbTowerPos(3)` 不可用时用；口径同 mammoth.js 的 BOSS 坐标回落）。
 *
 * 闸门判据（按序短路，见 dispatchLeg）：
 *   1 活动闸 `gameData.cq26IsOpen()`；
 *   2 快照闸 22007 push 或 ACL `cq26ArkState()` 引导读达（两路皆空只巡不派，绝不用臆测阶段发写请求）；
 *   3 阶段闸 `status ∈ {2 DEPLOY, 4 READY}`（FIGHT/其余阶段游戏禁点，同口径不派）；
 *   4 红点闸 `arkArmyRed===true`（false=服务器确认已在场，再发只是重复占位）；
 *   5 重试帽 `MAX_DISPATCH_PER_EPISODE`（键 `status:round`，波次间红点复燃走同键续计）+ 被拒冷却 60s；
 *   6 在场闸 本人已有 306 在途/驻防（`march.list({cache:true})`）则等它到家（到家边沿会 kick 重判）；
 *   7 队列闸 `march.canMarch(1)`（306 只借队列数秒，但无空位时发了也只会被游戏侧拒）；
 *   8 坐标闸 ACL 投影 → 推送回落副本，两路皆空 warn 去重且不派；
 *   9 预设闸 `Battle().plan().preset()` 出得了兵才发。
 *
 * 触发源：`ctx.on.push(22007)`（阶段/红点跃迁即 kick——**波次间红点复燃的自动补兵就走这条**）+
 *   `march.onStateChange` 306 的 **state===4(ARRIVED_HOME)** 边沿（规范坑记：10019 对所有行军状态都推，
 *   唤醒只认到家态）+ `createCycle` 档位择时（红点待派 20s 短巡、派后 30s 复核红点翻转、无事长睡靠 push）。
 *
 * 用户口径：自动派兵/补兵是默认行为不设勾选，可调项仅剩战斗预设队列；面板出只读「作战状态」三行
 *   （阶段/波次/止时、红点驻守+本轮派次、最近派兵结算），全部镜像 22007 push（未启用时回落读 ACL 投影，
 *   同源零发包）与本会话记账，不为展示发任何请求；参战人数（2336）不展示——纯展示数据不值得轮询。
 *   状态行只如实镜像可读真相，不臆造中间态（口径同 energy-convoy 的亮/灭两态）。
 *
 * 刻意不做：
 *   不发 2331 MAIN_INFO（timelines/energyProgress/对面服务器是展示数据，自动化判据全部来自 22007 push，
 *     少一路依赖；2331 req 还要 cid 参数，cid 只在 push/引导投影里顺手可得，不如干脆不要）；
 *   不做结算领奖（奖励协议未在本场录制实证，臆测协议号违「逐键一致」红线）；
 *   不做 905 查时 / 920 加速（基础行军数秒到家：派兵→state=4 实录仅 15 秒）；
 *   不主动撤 306 行军（部队到家即自然释放队列，无 mammoth「建成即撤」那类需求）。
 */
import { createLog } from '../../core/log.js';
import { reactor } from '../../core/reactor.js';
import { bus, EVT } from '../../core/bus.js';
import { gameData, bits } from '../../core/game-api.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { createCycle } from '../../core/cycle.js';
import { CODE_NOT_SENT, parseData, rejectText } from '../../core/util.js';

/** @type {ReturnType<createLog>} */
const log = createLog('CQ26-ARK');

/** @type {string} reactor 功能 id（面板挂载见 core/menu.js 的 cq26 类别） */
const FEAT_ID = 'cq26ArkEnergy';

// ── 协议号 ────────────────────────────────────────────────────────────
/** @type {number} 22007 push（SERIES_FROST 状态族）：arkData{status,round,maxRound,arkArmyRed,endTimeSec}（真相源） */
const PUSH_ARK_STATUS = 22007;
/**
 * @type {number[]} 带 towerInfoList 的印石通用推送（22002 SERIES_FROST_INIT / 22003 / 22008 SERIES_FROST_INFO_CHANGE）
 * 只服务「ACL 内存投影读不到时的蓄能塔坐标回落副本」这一件事（口径与用法逐字同 mammoth.js）。
 */
const PUSH_FROST_INFO = [22002, 22003, 22008];
/** @type {number} 902 的 marchType：保卫能量驻塔（游戏侧 MarchType.SERIES_FROST_ARK_TRIAL，报文实证 306） */
const MARCH_TYPE_ARK = 306;
/** @type {number} 蓄能塔 id（游戏侧 CQ26TOWERID.ARK；22007 push 与 2331 resp 均实证 towerId=3） */
const ARK_TOWER_ID = 3;

/**
 * @type {Object<string,number>} 阶段机 PBEnumSeriesFrostArkTrialStageStatus 的本地副本（源码枚举，
 *   稳定契约值；符号漂移时不至于全线读错阶段）
 */
const ST = { NONE: 0, PREPARE: 1, DEPLOY: 2, FIGHT: 3, READY: 4, END: 5 };

/** @type {number} 同一 episode（`status:round`）内最多派几次（红点复燃/被拒后的重派用；封顶防逐拍撞队） */
const MAX_DISPATCH_PER_EPISODE = 3;
/** @type {number} 单次派兵被拒后的冷却毫秒 */
const REJECT_COOL_MS = 60 * 1000;

// ── 模块态 ────────────────────────────────────────────────────────────
/** @type {object} 运行时配置（configure 灌入） */
var MCFG = buildDefaults();
/** @type {object|null} net 实例 */
var net = null;
/** @type {boolean} 安装标志 */
var installed = false;
/**
 * @typedef {object} ArkSnap
 * @property {number} cid 赛季 cid（22007 push 顶层，只作展示镜像）
 * @property {number} status 阶段（PBEnumSeriesFrostArkTrialStageStatus）
 * @property {number} round 当前波次（FIGHT 逐波推进）
 * @property {number} maxRound 波次上限（实录 20）
 * @property {boolean} armyRed 塔红点 arkArmyRed（true=催派/催补兵，false=已在场）
 * @property {number} endTimeSec 当前阶段结束（服务器秒，0=未知；面板倒计时用）
 */
/** @type {ArkSnap|null} 22007 push（或 ACL 引导）状态快照（null=尚未读达） */
var SNAP = null;
/** @type {{x:number,y:number}|null} 蓄能塔坐标的纯报文回落副本（ACL 投影不可用时用） */
var posCache = null;
/** @type {Object<string,number>} `status:round` → 本 feat 已派次数 */
var dispatchTries = Object.create(null);
/**
 * @typedef {object} ArkSendRec
 * @property {number} atMs 派兵结算时刻（Date.now() 基准，面板折墙上钟）
 * @property {number} round 派兵时的波次
 * @property {boolean} ok 服务器是否受理
 * @property {number} troops 派出队伍数（仅 ok 时有意义）
 * @property {string} note 结果短语（已受理 / 被拒 code=… / 未发出）
 */
/** @type {ArkSendRec|null} 最近一次派兵结算（面板「最近派兵」行；null=本会话未派过；纯展示历史，跨 pause 保留） */
var lastSend = null;
/** @type {number} 派兵冷却到期时刻（Date.now() 基准） */
var coolUntilMs = 0;
/** @type {boolean} 本拍是否刚发出派兵（择时切到「复核红点翻转」档） */
var justDispatched = false;
/** @type {boolean} 红点亮着且本拍因外围闸门没派出去（择时切短巡档） */
var pendingDispatch = false;
/** @type {boolean} 「坐标两路都取不到」的 warn 去重（恢复后复位） */
var posWarned = false;
/** @type {function|null} march.onStateChange 退订句柄（模块级单挂，pause 不摘，回调自判 alive） */
var offMarch = null;

// ── 生命周期 ──────────────────────────────────────────────────────────
/**
 * 安装：只取网络底座（判据全来自 22007/通用推送与 2336/902 出网，安装期不发任何请求）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  if (installed) return true;
  net = ctx.net;
  if (!net.install()) {
    net = null;
    log.warn('install failed. missing=net');
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 配置灌入（reactor → 本模块）。翻开关即抢跑一拍，让「刚打开就赶上红点」不必等整档睡眠。
 * @param {object} partial toModuleCfg 产出
 * @returns {object}
 */
function configure(partial) {
  if (partial) MCFG = partial;
  if (installed && aliveFn()) cycle.kick();
  return MCFG;
}

/**
 * 运行：订阅 22007/通用印石推送 + 306 到家边沿 + 点火（push 退订由 reactor 托管）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctx.on.push(PUSH_ARK_STATUS, onArkPush);
  for (var i = 0; i < PUSH_FROST_INFO.length; i++) ctx.on.push(PUSH_FROST_INFO[i], onFrostInfoPush);
  // 306 到家边沿只用来「醒得快」：红点若还亮着（服务器没受理上一次），赶在阶段结束前补派。
  //   march.js 的生命周期是全局单点复播，退订管不到 reactor 之外 ⇒ 自己存句柄、只挂一次；
  //   按规范在回调内自判 alive，不在 pause 里摘（摘了 resume 会重挂成两份）。
  if (!offMarch) offMarch = march.onStateChange(onMarchEdge);
  log.info('started.');
  cycle.kick();
}

/**
 * 停用：丢掉不该跨暂停持有的陈旧判据（快照/人数/坐标副本/本拍决策位），
 *   避免 resume 后拿上一阶段的 `status`/`armyRed` 去发写请求。
 *   派兵计数刻意保留（同一 episode 重挂不该再多撞一次队列）。
 */
function pause() {
  SNAP = null;
  posCache = null;
  justDispatched = false;
  pendingDispatch = false;
}

/**
 * 存活判定（cycle 与所有 await 之后的记账都过这一闸）。
 * @returns {boolean}
 */
function aliveFn() {
  return reactor.isRunning(FEAT_ID);
}

// ── 推送入口 ──────────────────────────────────────────────────────────
/**
 * PBV2 报文取业务体：整包是 `{header,data}`，下钻一层；平铺载荷（旧 JSON 形态）原样回落。
 * @param {object} ev 推送事件
 * @returns {object|null}
 */
function pushBody(ev) {
  var o = ev && ev.data;
  if (!o || typeof o !== 'object') return null;
  return o.data || o;
}

/**
 * 22007：arkData 状态帧（阶段跃迁 / 红点翻覆 / 波次推进都从这里来）。
 *   **波次间红点复燃的自动补兵**就是这条：`status∈{DEPLOY,READY} && arkArmyRed=true` 命中即 kick。
 *   非 ark 载荷（22007 号族里不带 arkData 的其他形态）原样忽略，不动快照。
 * @param {object} ev 推送事件
 */
function onArkPush(ev) {
  var b = pushBody(ev);
  if (!b || !b.arkData || typeof b.arkData !== 'object') return;
  var d = b.arkData;
  var prev = SNAP;
  SNAP = {
    cid: Number(b.cid) || (prev ? prev.cid : 0),
    status: Number(d.status) || 0,
    round: Number(d.round) || 0,
    maxRound: Number(d.maxRound) || 0,
    armyRed: !!d.arkArmyRed,
    endTimeSec: bits.int64ToNum(d.endTimeSec),
  };
  if (prev && prev.status !== SNAP.status) {
    log.debug(
      '22007 status %d -> %d (round=%d/%d).',
      prev.status,
      SNAP.status,
      SNAP.round,
      SNAP.maxRound,
    );
  }
  if (!prev || prev.armyRed !== SNAP.armyRed) {
    log.debug('22007 arkArmyRed %s -> %s.', prev ? prev.armyRed : '?', SNAP.armyRed);
  }
  pokePanel(); // 作战状态行随 push 就地重算（面板未开时 UI_REFRESH 早退，零开销）
  if (aliveFn()) cycle.kick();
}

/**
 * 22002/22003/22008：印石通用信息推送，都可能在 `info.towerInfoList` 或顶层 `towerInfoList` 里带蓄能塔坐标。
 *   只服务「ACL 内存投影读不到时的回落副本」这一件事，取到就缓存，取不到不改旧值。
 * @param {object} ev 推送事件
 */
function onFrostInfoPush(ev) {
  var b = pushBody(ev);
  if (!b) return;
  var list = b.towerInfoList || (b.info && b.info.towerInfoList);
  var pos = pickArkPos(list);
  if (pos) {
    posCache = pos;
    posWarned = false;
  }
}

/**
 * 从 towerInfoList 里挑蓄能塔（towerId=3 = CQ26TOWERID.ARK）的坐标。
 * @param {*} list 报文里的 towerInfoList（形态不受控，非法即回 null）
 * @returns {{x:number,y:number}|null}
 */
function pickArkPos(list) {
  if (!Array.isArray(list)) return null;
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t || Number(t.towerId) !== ARK_TOWER_ID) continue;
    var p = t.pos;
    if (!p || typeof p !== 'object') return null;
    var x = Number(p.x) || 0;
    var y = Number(p.y) || 0;
    return x > 0 && y > 0 ? { x: x, y: y } : null;
  }
  return null;
}

/**
 * 306 行军的边沿回调：只在「到家」（state=4 ARRIVED_HOME）时唤醒重判。
 *   规范坑记：10019 对**所有**行军状态都推，唤醒补派只认 state===4，其余状态一律忽略。
 * @param {object} m March（归一化纯数据）
 */
function onMarchEdge(m) {
  if (!aliveFn()) return;
  if (!m || m.type !== MARCH_TYPE_ARK) return;
  if (m.state !== march.State.ARRIVED_HOME) return;
  log.debug('march 306 arrived home id=%s, kick.', m.id);
  cycle.kick();
}

// ── 快照引导 ──────────────────────────────────────────────────────────
/**
 * 服务器秒（与 `Date.now()` 解耦；endTimeSec 是服务器时刻，倒计时与阶段边界以服务器钟为准）。
 * @returns {number} 读不到回 0（调用方本拍不动作）
 */
function serverNow() {
  return Math.floor(gameData.serverTime() || 0);
}

/**
 * 中途启用引导：feat 打开时多半已错过开场 22007 push，读一次游戏内存投影
 *   （源码 CQ26ArkData.updateData 逐字 `this.data = e.arkData`，内存本体就是最近一帧 push，同源不矛盾）。
 *   投影不可用（符号漂移/子包未载/游戏还没收到过状态帧）时保持 null，此后只认自订 push。
 */
function bootstrapArkState() {
  if (SNAP) return;
  var a = gameData.cq26ArkState();
  if (!a) return;
  SNAP = a;
  log.debug(
    'ark state bootstrapped from acl projection. status=%d red=%s round=%d',
    a.status,
    a.armyRed,
    a.round,
  );
  pokePanel(); // 中途启用引导读达：作战状态行从「—」切到真实快照
}

// ── 派兵腿 ────────────────────────────────────────────────────────────
/**
 * 驻塔派兵/补兵（同一条 902-306；部队数秒到家、不长期占队列）。任一闸门不过只打日志、不动作。
 *   与 mammoth 不同：无「提前量锚点」——窗口开没开完全由 22007 的阶段/红点 push 驱动，不读 nowSec。
 * @returns {Promise<void>}
 */
async function dispatchLeg() {
  pendingDispatch = false;
  var s = SNAP;
  if (!s) return;
  // 阶段闸：只有 DEPLOY/READY 是派兵窗（源码 joinBattleClick 逐字：其余分支 ShowTips(silo347)）
  if (s.status !== ST.DEPLOY && s.status !== ST.READY) {
    if (s.status === ST.FIGHT) {
      log.debug(
        'FIGHT stage (wave %d/%d), dispatch forbidden by design (tip silo347).',
        s.round,
        s.maxRound,
      );
    }
    return;
  }
  // 红点闸：armyRed=false 即服务器确认已在场；波次间复燃（push 驱动）才会走到下面
  if (!s.armyRed) {
    log.debug('no red dot (already garrisoned), nothing to dispatch. wave=%d', s.round);
    return;
  }
  pendingDispatch = true;
  var key = s.status + ':' + s.round;
  if ((dispatchTries[key] || 0) >= MAX_DISPATCH_PER_EPISODE) {
    log.debug('dispatch tries capped (%d) for %s, wait push.', MAX_DISPATCH_PER_EPISODE, key);
    pendingDispatch = false;
    return;
  }
  if (Date.now() < coolUntilMs) {
    log.debug('dispatch cooling after reject (until %dms left).', coolUntilMs - Date.now());
    return;
  }
  // 已有一支 306 在外（在途/驻防未到家）就不重复发；读缓存快照（856 播种 + 10019 边沿维护），稳态零网络。
  //   到家那一下另有 onMarchEdge kick，不会等下一档睡眠。
  var ms = await march.list({ cache: true });
  if (!aliveFn()) return;
  for (var i = 0; i < ms.length; i++) {
    if (ms[i].type === MARCH_TYPE_ARK && ms[i].isOccupying) {
      pendingDispatch = false;
      log.debug('306 already out (id=%s state=%s), hold.', ms[i].id, ms[i].stateName);
      return;
    }
  }
  if (!march.canMarch(1)) {
    log.debug('no free march slot (used=%d), skip dispatch.', gameData.marchCount().used);
    return;
  }
  var pos = gameData.cq26DbTowerPos(ARK_TOWER_ID);
  if (pos) posWarned = false;
  if (!pos) pos = posCache;
  if (!pos) {
    if (!posWarned) {
      posWarned = true;
      log.warn(
        'ark tower pos unavailable (acl projection + frost push both empty), cannot dispatch.',
      );
    }
    return;
  }
  var plan = new Battle().plan().preset(MCFG.preset).adjust().build();
  if (!plan.armyListNew || !plan.armyListNew.length) {
    log.info('preset #%d has no dispatchable troops, skip dispatch.', MCFG.preset);
    return;
  }
  if (plan.presetHasHeroes && (!plan.heroList || !plan.heroList.length)) {
    log.debug('preset #%d heroes not released, skip dispatch.', MCFG.preset);
    return;
  }
  dispatchTries[key] = (dispatchTries[key] || 0) + 1;
  var ret = await march.attack({
    marchType: MARCH_TYPE_ARK,
    target: { x: pos.x, y: pos.y },
    data: plan,
  });
  if (!aliveFn()) return;
  pendingDispatch = false;
  if (ret && ret.code === CODE_NOT_SENT) {
    coolUntilMs = Date.now() + REJECT_COOL_MS;
    log.warn(
      '902(306) not sent (in-flight gate or send error). key=%s try=%d',
      key,
      dispatchTries[key],
    );
    noteSend(s.round, false, 0, '未发出');
    return;
  }
  if (!ret || !ret.ok) {
    coolUntilMs = Date.now() + REJECT_COOL_MS;
    log.info(
      '902(306) rejected. code=%s reason=%s key=%s try=%d',
      ret ? ret.code : 'unknown',
      rejectText(ret),
      key,
      dispatchTries[key],
    );
    noteSend(s.round, false, 0, '被拒 code=' + (ret ? ret.code : '?'));
    return;
  }
  justDispatched = true;
  // 受理后服务器会翻红点（实录 10:26:14 派 → 10:26:29 push arkArmyRed:false）并以 push 为准修快照；
  //   这里不改写 armyRed（只读+发包红线），等 push/复核自然收敛。
  var mi = (parseData(ret.data) || {}).marchInfo || {};
  log.info(
    'ark dispatch sent. pos=%d,%d troops=%d key=%s try=%d marchId=%s',
    pos.x,
    pos.y,
    plan.armyListNew.length,
    key,
    dispatchTries[key],
    // marchId 是 64 位雪花 id：只能按字符串读，Number 会丢精度
    mi.marchId != null ? bits.int64Str(mi.marchId) : '?',
  );
  noteSend(s.round, true, plan.armyListNew.length, '已受理');
}

// ── 调度 ──────────────────────────────────────────────────────────────
/**
 * 档位（毫秒）。主触发是 22007 push（阶段/红点/波次跃迁）与 306 到家边沿，轮询只兜「漏推送 + 复核」：
 *   activeMs 红点待派/在途复核短巡 / arriveMs 刚派后复核红点翻转 / idleMs 无红点事长睡（靠 push 唤醒）/
 *   farMs 阶段还剩很远（>10min）的哨兵心跳 / backoffMs 抛错兜底。
 */
const cfg = {
  activeMs: 20 * 1000,
  arriveMs: 30 * 1000,
  idleMs: 5 * 60 * 1000,
  farMs: 30 * 60 * 1000,
  backoffMs: 60 * 1000,
};

/**
 * 单拍：引导快照 → 派兵腿 → 择时。
 * @returns {Promise<number>} 下拍延迟毫秒
 */
async function cycleRun() {
  var ms = await cyclePass();
  if (cycle.pending) return 0;
  return ms;
}

/**
 * @returns {Promise<number>} 下拍睡眠毫秒
 */
async function cyclePass() {
  justDispatched = false;
  pendingDispatch = false;
  if (!gameData.cq26IsOpen()) {
    log.debug('CQ26 not open, idle.');
    return cfg.idleMs;
  }
  bootstrapArkState();
  if (!SNAP) {
    // push 未到、投影不可得：没有状态就不猜（写请求硬闸门在 dispatchLeg，走不到发包那步）
    log.debug('no ark state yet (push missed + acl projection empty), idle.');
    return cfg.idleMs;
  }
  var nowSec = serverNow();
  if (!(nowSec > 0)) {
    log.warn('server time unreadable, skip this pass.');
    return cfg.activeMs;
  }
  var s = SNAP;
  log.debug(
    'snap status=%d wave=%d/%d red=%s end=%s',
    s.status,
    s.round,
    s.maxRound,
    s.armyRed,
    s.endTimeSec
      ? new Date(s.endTimeSec * 1000).toLocaleTimeString('zh-CN', { hour12: false })
      : '-',
  );
  await dispatchLeg();
  if (!aliveFn()) return cfg.activeMs;
  if (justDispatched) return cfg.arriveMs;
  if (pendingDispatch) return cfg.activeMs;
  if (s.endTimeSec > nowSec) {
    var remSec = s.endTimeSec - nowSec;
    // 阶段跃迁本身由 22007 push 抢跑唤醒，这里只兜「漏推送」：远窗抬到 farMs
    var cap = remSec > 10 * 60 ? cfg.farMs : cfg.idleMs;
    return Math.max(cfg.activeMs, Math.min(remSec * 1000 + 15 * 1000, cap));
  }
  return cfg.idleMs;
}

const cycle = createCycle({
  log: log,
  alive: aliveFn,
  run: cycleRun,
  fallback: cfg.backoffMs,
});

// ── 面板状态（只读镜像，零发包）────────────────────────────────────────
/**
 * 状态行读源：优先本 feat 的 push 快照；缺席（未启用/刚 pause）回落 ACL 内存投影
 *   （与 22007 同源：CQ26ArkData.data 就是最近一帧 push 的副本）。两路皆空回 null，面板如实出「—」。
 * @returns {ArkSnap|null}
 */
function displaySnap() {
  return SNAP || gameData.cq26ArkState();
}

/**
 * 推一次面板刷新：作战状态行是「行结构不变、值随 push/结算变」的只读格，走 refreshTexts 就地重算。
 * 刻意**不带 rebuild**：带它会整卡重渲染、拆掉用户正在操作的预设下拉（口径同 shop.js pokePanel）。
 */
function pokePanel() {
  bus.emit(EVT.UI_REFRESH);
}

/**
 * 「最近派兵」行记账 + 推面板刷新（纯展示、不参与判据链；与日志结算同窗调用）。
 * @param {number} round 派兵时的波次
 * @param {boolean} ok 是否受理
 * @param {number} troops 派出队伍数（未受理传 0）
 * @param {string} note 结果短语
 */
function noteSend(round, ok, troops, note) {
  lastSend = { atMs: Date.now(), round: round, ok: ok, troops: troops, note: note };
  pokePanel();
}

/**
 * 阶段号 → 中文（面板展示；未知号如实给数字，不臆造语义，口径同 mammoth.statusName）。
 * @param {number} st PBEnumSeriesFrostArkTrialStageStatus
 * @returns {string}
 */
function statusName(st) {
  switch (st) {
    case ST.NONE:
      return '未开始';
    case ST.PREPARE:
      return '筹备';
    case ST.DEPLOY:
      return '部署';
    case ST.FIGHT:
      return '战斗中';
    case ST.READY:
      return '间歇';
    case ST.END:
      return '结束';
    default:
      return '阶段' + st;
  }
}

/**
 * 服务器秒 → 本地 `HH:mm`（阶段边界是服务器时刻，按服务器钟差折墙上钟才读得懂；口径同 mammoth.fmtClock）。
 * @param {number} epochSec 服务器秒
 * @returns {string}
 */
function fmtClock(epochSec) {
  var lead = serverNow() - (Number(epochSec) || 0);
  var d = new Date(Date.now() - lead * 1000);
  var p = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 本地毫秒 → `HH:mm:ss`（派兵结算按 Date.now() 记账，直接读墙上钟）。
 * @param {number} ms
 * @returns {string}
 */
function fmtTime(ms) {
  var d = new Date(ms);
  var p = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// ── descriptor ────────────────────────────────────────────────────────
/**
 * 面板 defaults（用户口径：战斗预设队列 1；自动派兵/补兵是默认行为，不设开关）。
 * @returns {object}
 */
function buildDefaults() {
  return {
    enabled: false,
    preset: 1,
  };
}

/** @type {object[]} 战斗预设下拉项（1~8；与 cq26/mammoth.js、train.js 同口径，select 回写保留原类型） */
var presetOptions = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) {
  return { value: i, label: '预设部队 ' + i };
});

/**
 * 面板 fields：3 行只读作战状态（纯镜像 22007 push / ACL 投影 + 本会话派兵记账，零发包）
 *   + 1 个可调项（战斗预设队列）。自动派兵/补兵是默认行为不设勾选（用户口径）。
 * 刻意**不列 `enabled` 字段**：功能卡片标题行已有直驱 `enabled` 的开关（core/ui/panel.js），
 *   再出一行同义 checkbox 属重复控件（口径逐字同 mammoth.js）。
 * @returns {object[]}
 */
function buildFields() {
  return [
    {
      key: '_stage',
      type: 'text',
      label: '阶段 / 波次',
      section: '作战状态',
      hint: '只读：镜像 22007 push 的阶段/波次/阶段止时（未启用时回落读游戏内存投影，同源零发包）',
      get: function () {
        var s = displaySnap();
        if (!s) return '—';
        return (
          statusName(s.status) +
          (s.maxRound > 0 ? ' R' + s.round + '/' + s.maxRound : '') +
          (s.endTimeSec > 0 ? ' · 止 ' + fmtClock(s.endTimeSec) : '')
        );
      },
    },
    {
      key: '_garrison',
      type: 'text',
      label: '驻守 / 红点',
      section: '作战状态',
      hint: '只读：红点亮=服务器催派/催补兵，灭=已确认在场；派次按「阶段:波次」窗口记账，红点复燃开新窗重新计',
      get: function () {
        var s = displaySnap();
        if (!s) return '—';
        var n = dispatchTries[s.status + ':' + s.round] || 0;
        return (s.armyRed ? '待补兵' : '已在场') + ' · 本轮派 ' + n + ' 次';
      },
    },
    {
      key: '_lastSend',
      type: 'text',
      label: '最近派兵',
      section: '作战状态',
      hint: '只读：本会话最近一次 902-306 的结算（时刻/波次/队伍数/结果），未派过如实显示「未派过」',
      get: function () {
        var r = lastSend;
        if (!r) return '未派过';
        return fmtTime(r.atMs) + ' R' + r.round + ' · ' + (r.ok ? r.troops + ' 队 ' : '') + r.note;
      },
    },
    {
      key: 'preset',
      type: 'select',
      label: '战斗预设队列',
      section: '驻塔（部队数秒到家，不长期占队列）',
      options: presetOptions,
      hint: '部署期首派与波次间补兵共用同一预设；战斗阶段游戏禁点参战，引擎同口径不派。',
    },
  ];
}

/**
 * 面板 cfg → 运行时 cfg（硬契约：`core/registry.js` 的 applyFeature 对每个 reactor 功能无条件调它）。
 * 未声明键不透传；数值区间钳制，预设默认 1（用户口径「战斗预设队列 1」）。
 * @param {object} c 面板合并后配置
 * @returns {object}
 */
function normalizeCfg(c) {
  var o = c || {};
  var preset = Math.round(Number(o.preset) || 0);
  return {
    enabled: !!o.enabled,
    preset: preset >= 1 && preset <= 8 ? preset : 1,
  };
}

// ── 注册 ──────────────────────────────────────────────────────────────
reactor.register({
  id: FEAT_ID,
  label: '保卫能量',
  storageKey: 'pocketcc.feat.cq26_ark_energy',
  // dataCenter 硬依赖（serverTime 是阶段倒计时与文案基准）；塔坐标走 ACL 投影 cq26DbTowerPos(3)，
  //   拿不到时自带 22002/22003/22008 推送的纯报文回落副本，故不作为符号依赖声明（同 mammoth 口径）
  symbols: ['dataCenter'],
  // 与 cq26 家族同口径：靠 22007 push + 902 定向出网，不依赖人真站在印石图里
  places: ['base', 'world'],
  kinds: ['homeland'],
  // 306 部队数秒到家（报文实证 15 秒）、不长期占用行军队列 ⇒ 无需战斗模式强制下线
  //   （与 mammoth「驻防真实占队列 ⇒ offInCombat:true」的口径差异正来自这条实录）
  offInCombat: false,
  defaults: buildDefaults(),
  fields: buildFields(),
  toModuleCfg: normalizeCfg,
  version: 1,
  install: install,
  configure: configure,
  run: run,
  pause: pause,
});
