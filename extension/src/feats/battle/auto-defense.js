/**
 * 自动防御（reactor 说明书形态，属「战斗设置」）
 *
 * 收到服务器 push 10167 PUSH_ATTACK_ARMIES「你被攻击了」→ 用一份共享「条件快照」驱动四条可独立开关、
 *   顺序可调的防御策略，按序尝试、首个「闸门过且执行成功」即停，否则顺延下一条：
 *     · 策略 1 自动开盾（910）：背包取最短时长盾档、恒 isPurchase:0；可选战力闸门（我战力≥敌则跳过开盾但顺延），
 *       敌战力取不到按「无限高·最悲观」照常开盾；拒因 war_fever_003/kingdom_077 以 910 status=3 为最终裁决。
 *     · 策略 2 绕后攻击：迁城到敌主城 8 单位内最近合法可落点（911），迁城落地确认后以预设部队 902 打敌主城。
 *       不做行军加速——贴近即压缩行军；8 单位内无落点则放弃顺延。
 *     · 策略 3 迁城逃避：以我方主城为锚、背向敌取离敌更远的合法落点（911）迁走；本地 ±20 带内无落点则按 3×3 大扇区轮换到远处重试（离敌最远扇区优先，≤5 轮，借鉴竞品B）；迁成后镜头跟随到新落地点。
 *     · 策略 4 原地反击：不迁城，直接以预设部队 902 从当前主城攻打敌主城（闸门同绕后攻击：需全部部队回城 + 有空闲队列）。
 *
 * 坐标/战力来源（报文实证）：敌主城坐标与战力一次 630 PLAYER_INFO 按 uid 直查（应答顶层 x/y=主城、power/level），
 *   与视口/场景无关——Home 城内也能查。（曾试过 10007 MARCH_INFO push：它是视口绑定推送，视野在 Home 时不下发；
 *   又试过 909 GET_PLAYER_POINT：它是取点护盾信息、targetId 对应本地 UserData、返回的是自己，均非「按 uid 查陌生玩家」。）
 *   我方坐标走本地 UserData.WorldCoord（gameData.myWorldPos）、战力走本地 UserData.Power（gameData.myPower）。
 *   去重/终止：同 marchId 去重；attackState=0 视为已结束不再触发；attackState=1 才触发。
 *   夺宝奇兵（CSHunt）攻击不响应：星歼者 PVE、对手玩家拦截/击败夺宝飞船都推 uid=0 的 10167（marchId 恒为夺宝
 *   treasureId、无 level/arrivalTime），非主城被攻，onAttack 以「无真实攻击者 uid」闸门直接跳过。
 *
 * 决策日志（硬性要求）：每条策略评估后必落一行 `[autoDefense] marchId=… decision=… result=… reason=…`，
 *   result∈{hit|skip|fail|not-selected}；战力场景同时打印 me.power/enemy.power，未知显式记 power=unknown→assume-max。
 *   全部未命中 → 不向游戏侧告警（不聊天、不弹窗），只本地日志照记。
 *
 * 合规：只读游戏数据 + 发包（910/911/902/630），不调任何游戏 Update/Delete 改写本地数据。
 *   场景 ['Home','NWorldMap']；不声明 offInCombat——战斗模式下照常防御（与快捷战斗/奉旨出征同侧）。
 *   世界态门（B 档，见可行性报告 §7.3）：kinds ['homeland','wushuang','kvk','adp_war']——战场里城照样被打破，
 *   所以整档不停；只有秘境/征服者（副本世界体系与球体场景，不是「你的世界城被攻打」）让本 feat 整体 pause。
 *   ① 开盾这一条策略另按 kind/crossMap 降级（峡谷内护盾根本不生效、跨服战场区域内无法开盾且会清剩余时间），
 *   ②③④（迁城/攻击）在跨服图照常跑。详见 strategyShield 头部注释。
 *   高影响（自动耗盾/迁城卡、自动迁走主城）：面板默认关闭 + 逐条策略开关。
 */
import { createLog } from '../../core/log.js';
import { safeParse } from '../../core/util.js';
import { game } from '../../core/game.js';
import { gameData, l10n, march as marchApi, nav, worldMap } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { defense } from '../../core/defense.js';
import { worldState } from '../../core/world/state.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=AUTO_DEFENSE） */
const log = createLog('AUTO_DEFENSE');

// ── 协议命令号（服务器契约常量，就近定义） ──────────────────────────────
/** @type {number} ResponseId.PUSH_ATTACK_ARMIES：被攻击军队推送（来袭预警）；{uid,attackState(1来袭/0结束),level,arrivalTime,marchId} */
const CMD_PUSH_ATTACK_ARMIES = 10167;
/** @type {number} RequestId.PLAYER_INFO：按 uid 查玩家基础信息；req {uid:String}，应答顶层含 x/y(主城坐标)/power/level/allianceName（真机实证，见 chat-window 630 口径），与视口/场景无关，Home 亦可查 */
const CMD_PLAYER_INFO = 630;
/** @type {number} RequestId.PEACE_SHIELD：开护盾（背包道具，isPurchase:0）；拒 status=3+war_fever_003/kingdom_077 */
const CMD_PEACE_SHIELD = 910;
/** @type {number} RequestId.MOVE_CITY_POSITION：迁城到指定坐标（背包迁城卡，isPurchase:0）；req {itemId,amount:1,isPurchase:0,x,y} */
const CMD_MOVE_CITY_POSITION = 911;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（发）；仅用于发攻前的同 cmd 在途频控（发送走 march.attack） */
const CMD_MARCH_WORLD_POINT = 902;

/** @type {number} 预设部队号上限（与快捷战斗/奉旨出征 1..8 对齐） */
const PRESET_MAX = 8;

/** @type {{attackPlayer:number, tm:number, master:number, ava:number, teamLegend:number}} marchType 兜底数值表（同 imperial-decree，跨服漂移换算用） */
const MARCH_FALLBACK = { attackPlayer: 13, tm: 150, master: 170, ava: 110, teamLegend: 181 };

/** @type {number} 攻玩家城的基础 marchType（本服口径；经 marchApi.resolve 做跨服漂移换算） */
const MARCH_TYPE_ATTACK_PLAYER = 13;

/**
 * 四条策略的 id ↔ 中文名（multiopts 的 option.value 为数字，order 亦存数字，两处交叉引用同一套 id）。
 * @type {{shield:number, attack:number, relocate:number, counter:number}}
 */
const SID = { shield: 1, attack: 2, relocate: 3, counter: 4 };
/** @type {Object<number,string>} 数字 id → 中文标签（面板 sortlist resolve + 决策日志 decision 名） */
const STRATEGY_LABEL = { 1: '自动开盾', 2: '绕后攻击', 3: '迁城逃避', 4: '原地反击' };
/** 全量策略 id（order 规整时的补全基准） */
const ALL_SIDS = [SID.shield, SID.attack, SID.relocate, SID.counter];

/** @type {number} 已触发防御的 marchId 内存上限（FIFO 淘汰，防长会话无界增长） */
const SEEN_MAX = 200;

/** @type {number} 迁城回执后等待 myWorldPos 落地刷新的轮询间隔/上限（ms）：防「迁城未落地即攻击打空」 */
const LAND_POLL_MS = 250;
const LAND_TIMEOUT_MS = 2000;

/** @type {object|null} 网络底座（install 时取） */
var net;
/** @type {object|null} reactor 上下文；alive() 反映运行态 */
var ctxRef = null;
/** @type {boolean} install 幂等守卫 */
var installed = false;
/** @type {boolean} 单飞闸门：一条 10167 防御流程在飞，新推送合并/忽略 */
var busy = false;
/** @type {Set<string>} 已触发防御的 marchId（去重） */
var seenMarch = new Set();
/** @type {string[]} seenMarch 的插入序镜像（FIFO 淘汰用） */
var seenQueue = [];
/** @type {{strategies:number[], order:number[], preset:number, skipPowerCheck:boolean}} 面板配置（configure 推入） */
var cfg = {
  strategies: ALL_SIDS.slice(),
  order: ALL_SIDS.slice(),
  preset: 1,
  skipPowerCheck: false,
};

/**
 * 功能是否仍在运行（在飞流程 await 回来后的存活判定）。
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

// safeParse 已收口至 core/util.js（见顶部 import）

/** 数值 or null（'' / null / 非数 → null，区别于合法的 0） */
function numOrNull(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 本人当前服号（911/901 body、findRelocatableSpot、flyTo z 用）：走 game-api 实时 ACL
 * （`worldMap.serverId()` → `userData().ServerId`），跨区迁城进别区战场图后随实时 UserData 更新。
 * 不在本模块缓存 `DataCenter.DATA` 引用——那是与刚修的 probe 缓存同源的、可被整体替换的对象，
 * 会把登录/老家态的 ServerId 钉死整场，导致 findRelocatableSpot/flyTo 查错区而乱跳。取不到回 0，游戏侧自认本服。
 * @returns {number}
 */
function serverId() {
  return worldMap.serverId() | 0;
}

/**
 * 同区攻击前提校验（游戏铁律：攻击只能在同一个区内发生——敌我双方基地都须在当前战场区，才互相打得到）。
 * 能被打到的敌，其基地必在本人当前区。若 630 查得的 `enemy.serverId` 存在且 ≠ 本人当前服号
 * （`serverId()`），说明该敌并不在本区（要么尚在老家区打不到、要么 630 回的是其注册/老家服号），
 * 此时绕后迁城/flyTo 飞向那个区既违反同区规则又会被服务器拒 → 返回该区号供调用方跳过顺延；
 * 敌在我区(号相等)或 630 未回服号/为 0 时返回 null(放行)。
 * @param {object} snap 共享快照
 * @returns {number|null} 不在本区时返回敌服号，可在本区攻击时返回 null
 */
function enemyOffZone(snap) {
  var z = snap && snap.enemy && snap.enemy.serverId;
  var mine = serverId();
  return z && mine && z !== mine ? z : null;
}

/**
 * marchId 去重：已见过回 true；否则登记并按 FIFO 淘汰到 SEEN_MAX。
 * @param {string} id marchId
 * @returns {boolean} 是否已见过
 */
function alreadySeen(id) {
  if (seenMarch.has(id)) return true;
  seenMarch.add(id);
  seenQueue.push(id);
  while (seenQueue.length > SEEN_MAX) seenMarch.delete(seenQueue.shift());
  return false;
}

/**
 * 决策日志（硬性要求）：单条策略评估后必落一行。result 分级遵 core/log.js 铁律——
 *   hit/fail（关键动作/业务拒）走 info；not-selected/skip 走 info 或 debug（这里 skip 记 info、not-selected 记 debug）；
 *   真异常不在此（走各调用点 warn）。
 * @param {string} marchId
 * @param {string} name 策略名（STRATEGY_LABEL 或 feat 级标记）
 * @param {string} result hit|skip|fail|not-selected
 * @param {string} reason 可读原因（含战力、拒因译文）
 * @param {'info'|'debug'} [level='info']
 */
function decision(marchId, name, result, reason, level) {
  var line = '[autoDefense] marchId=%s decision=%s result=%s reason=%s';
  if (level === 'debug') log.debug(line, marchId, name, result, reason);
  else log.info(line, marchId, name, result, reason);
}

/**
 * 630 PLAYER_INFO 按 uid 查玩家基础信息：解析主城坐标 x/y + 战力 + 等级 + 基地服号 serverId（字段缺失记 null，永不抛）。
 * 应答顶层即含 x/y/power/level/allianceName/serverId（真机实证，同 chat-window 630 飞图口径）；
 * 与视口/场景无关，Home 城内也能查——绕后攻击据此取敌主城坐标，不依赖 10007 行军推送。
 * @param {string|number} uid 目标玩家 uid（push.uid 是 JS number，须转字符串上线，防 Int64 反序列化拒绝）
 * @returns {Promise<{x:(number|null), y:(number|null), power:(number|null), level:number, serverId:(number|null)}|null>} 请求失败/无载荷返回 null
 */
async function getPlayerInfoByUid(uid) {
  if (uid == null || uid === '') return null;
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_PLAYER_INFO,
    { uid: String(uid) },
    {
      gate: false,
      onError: function (err) {
        log.warn('630 send error. uid=%s', uid, err);
        threw = true;
      },
    },
  );
  if (threw) return null;
  if (!ret || !ret.ok) {
    log.info('630 not ok. uid=%s;code=%s', uid, ret && ret.code);
    return null;
  }
  var d = safeParse(ret.data) || {};
  var x = numOrNull(d.x),
    y = numOrNull(d.y);
  var power = numOrNull(d.power);
  var level = Number(d.level) || 0;
  // 敌基地服号：查「他人」=其基地真实所在服（chat-window 飞图口径已实证）；跨区绕后据此定落点区，勿与「查自己回注册服」混用。
  var serverId = numOrNull(d.serverId);
  if (x == null && y == null && power == null) return null; // 啥都没解析出来 → 视为查无
  return { x: x, y: y, power: power, level: level, serverId: serverId };
}

/**
 * 单条 10167 算一份共享快照，三策略复用。
 * 敌主城坐标+战力：一次 630 PLAYER_INFO 按 uid 直查（应答顶层 x/y=主城、power/level），与视口/场景无关，Home 亦可。
 * @param {object} pushData 10167 载荷 {uid,level,marchId,...}
 * @returns {Promise<object>} snapshot
 */
async function buildSnapshot(pushData) {
  var uid = pushData.uid;
  // 1) 我方坐标/战力本地读
  var mePos = gameData.myWorldPos();
  var me = { x: mePos ? mePos.x : null, y: mePos ? mePos.y : null, power: gameData.myPower() };
  // 2) 敌主城坐标+战力：630 按 uid 直查（城点固定，行军不影响）
  var info = await getPlayerInfoByUid(uid);
  if (!aliveFn()) return null;
  var enemy = info
    ? {
        x: info.x,
        y: info.y,
        power: info.power,
        level: info.level,
        serverId: info.serverId,
        src: '630',
      }
    : { x: null, y: null, power: null, level: 0, serverId: null, src: 'none' };
  // 3) 在外部队数
  var marchesOut = 0;
  var ms = await march.list();
  for (var i = 0; i < ms.length; i++) {
    if (march.isOccupying(ms[i])) marchesOut++;
  }
  return {
    marchId: pushData.marchId != null ? String(pushData.marchId) : '',
    enemy: enemy,
    me: me,
    shieldItem: defense.pickShieldItem(),
    shieldActive: gameData.shieldActive(),
    warFever: gameData.warFever(),
    canShieldByGame: gameData.canShield(),
    marchesOut: marchesOut,
    freeSlots: march.freeSlots(),
  };
}

/**
 * 发 911 迁城到 (x,y)。永不抛；返回 {ok, why}。
 * @param {number} x
 * @param {number} y
 * @returns {Promise<{ok:boolean, why:string}>}
 */
async function moveCity(x, y) {
  if (net.isSending(CMD_MOVE_CITY_POSITION)) return { ok: false, why: '911 在途' };
  var hasItem = gameData.itemAmount(defense.ITEM_MOVE_CITY) > 0;
  var body = hasItem
    ? { itemId: defense.ITEM_MOVE_CITY, amount: 1, isPurchase: 0, x: x, y: y }
    : { itemId: defense.ITEM_MOVE_CITY, amount: 0, isPurchase: 1, vipShopBuy: 1, x: x, y: y };
  if (!hasItem) log.info('911 迁城卡不足，改用钻石迁城 isPurchase=1');
  var threw = false;
  var ret = await net.sendGuarded(CMD_MOVE_CITY_POSITION, body, {
    gate: false,
    onError: function (err) {
      log.warn('911 send error. x=%d;y=%d', x, y, err);
      threw = true;
    },
  });
  if (threw) return { ok: false, why: '迁城发包异常' };
  if (!ret) return { ok: false, why: '迁城无应答' };
  if (ret.ok) return { ok: true, why: '' };
  return { ok: false, why: '迁城被拒 ' + rejectText(ret) };
}

/**
 * 迁城回执成功后等待主城坐标刷新到目标点（plan §九.2：myWorldPos 更新佐证后再发 902，防打空）。
 * @param {number} x 目标 x
 * @param {number} y 目标 y
 * @returns {Promise<boolean>} 是否在超时前落地
 */
async function waitLanded(x, y) {
  var deadline = Date.now() + LAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!aliveFn()) return false;
    var p = gameData.myWorldPos();
    if (p && (p.x | 0) === (x | 0) && (p.y | 0) === (y | 0)) return true;
    await new Promise(function (r) {
      setTimeout(r, LAND_POLL_MS);
    });
  }
  // 末次再判一次（覆盖睡眠期间的更新）
  var pf = gameData.myWorldPos();
  return !!(pf && (pf.x | 0) === (x | 0) && (pf.y | 0) === (y | 0));
}

/** 910/911/902 拒因 → 可读串：裸语言键走 l10n.net 译中，其余带 code 兜底 */
function rejectText(ret) {
  var raw = String(ret && ret.data == null ? '' : ret.data).trim();
  var zh = raw ? l10n.net(raw) : '';
  if (zh && zh !== raw) return zh;
  return '(code=' + (ret && ret.code) + (raw ? ';raw=' + raw : '') + ')';
}

/** 902 攻击拒因 → 可读串（含未发出哨兵） */
function attackFailText(ret) {
  if (ret && ret.code === march.NOT_SENT) return '发送超时或未发出';
  return rejectText(ret);
}

// ─────────────────────── 四条策略（各返回 {result, reason, stop}；stop=true 即命中收手） ───────────────────────

/**
 * 策略 1：自动开盾（910）。闸门：世界态降级（峡谷恒跳 / 跨服图按 crossMap）→ 背包有盾 & 未生效 & 非狂热 & 游戏未判不可开；可选战力闸门。
 * @param {object} snap 共享快照
 * @returns {Promise<{result:string, reason:string, stop:boolean}>}
 */
async function strategyShield(snap) {
  // 分策略降级（可行性报告 §7.3）：只有开盾这一条要按世界态收，②③④ 在跨服图照跑。
  //   · 无双峡谷（含 AVA/TM/大师/传奇四代，同族同规则）恒不开盾：ava_tips_064=在无双峡谷中保护罩无法生效…、
  //     cab_help_info_048=因磁场混乱，所以城市护盾无法生效 —— 是「盾根本不生效」，不是「城不在场」，照发纯浪费道具。
  //   · 其余跨服图（跨战区天梯 kvk_* / 盟决 adp_war）只判「此刻真在战场图上」：cross_server_info_042=在战场区域时，
  //     无法开启护盾保护、csb_tips_001=战区内无法开启护盾、shield_012=进入跨战区天梯赛战场（作为护盾消失原因）。
  //     这里必须读 crossMap 而不是 kind：kind=kvk_* 是整季形态位，你随时可能回了原战区老家（mapType 折回本服图），
  //     那时护盾照常可用，按 kind 一刀切会把赛季里的常态防御一起废掉。
  var st = worldState.current();
  if (st.kind === worldState.KIND.wushuang)
    return {
      result: 'skip',
      reason: '无双峡谷内护盾不生效，跳过开盾(gen=' + st.gen + ')',
      stop: false,
    };
  if (st.crossMap)
    return {
      result: 'skip',
      reason: '此刻在跨服战场图上(kind=' + st.kind + ')，战场区域无法开盾',
      stop: false,
    };
  if (snap.shieldItem == null) return { result: 'fail', reason: '背包无可用护盾道具', stop: false };
  if (snap.warFever) return { result: 'fail', reason: '战争狂热禁止开盾', stop: false };
  if (snap.canShieldByGame === false)
    return { result: 'fail', reason: '游戏判定不可开盾(危险区/跨服)', stop: false };
  // 战力闸门（面板勾选「跳过战力判断」则不判；定案 2/3：跳过≠放弃，仍顺延后续策略）
  var powerNote;
  if (cfg.skipPowerCheck) {
    powerNote =
      ';me.power=' + snap.me.power + ',enemy.power=' + snap.enemy.power + ';skip-power-check';
  } else {
    var ep = snap.enemy.power,
      mp = snap.me.power;
    if (ep == null) {
      powerNote = ';power=unknown→assume-max(最悲观);me.power=' + mp + ',enemy.power=null'; // 敌战力取不到按无限高，照常开盾
    } else {
      powerNote = ';me.power=' + mp + ',enemy.power=' + ep;
      if (mp != null && ep <= mp)
        return { result: 'skip', reason: '我方战力更高，无需开盾' + powerNote, stop: false };
    }
  }
  var threw = false;
  var ret = await net.sendGuarded(
    CMD_PEACE_SHIELD,
    { itemId: snap.shieldItem, amount: 1, isPurchase: 0 },
    {
      gate: false,
      onError: function (err) {
        log.warn('910 send error. itemId=%d', snap.shieldItem, err);
        threw = true;
      },
    },
  );
  if (threw) return { result: 'fail', reason: '开盾发包异常' + powerNote, stop: false };
  if (!aliveFn()) return { result: 'fail', reason: '流程已暂停' + powerNote, stop: false };
  if (ret && ret.ok)
    return { result: 'hit', reason: '开盾成功 itemId=' + snap.shieldItem + powerNote, stop: true };
  return { result: 'fail', reason: '开盾被拒 ' + rejectText(ret) + powerNote, stop: false };
}

/**
 * 策略 2：绕后攻击（迁城 911 到敌 8 单位内最近可落点 + 902 打敌主城）。无行军加速。
 * @param {object} snap 共享快照
 * @returns {Promise<{result:string, reason:string, stop:boolean}>}
 */
async function strategyAttack(snap) {
  if (snap.marchesOut !== 0)
    return {
      result: 'skip',
      reason: '有 ' + snap.marchesOut + ' 支部队在外，需全部回城',
      stop: false,
    };
  if (snap.freeSlots < 1) return { result: 'fail', reason: '无空闲行军队列', stop: false };
  var ex = snap.enemy.x,
    ey = snap.enemy.y;
  if (ex == null || ey == null)
    return { result: 'fail', reason: '敌主城坐标未知(630 未回坐标)', stop: false };
  var offz = enemyOffZone(snap);
  if (offz)
    return {
      result: 'skip',
      reason: '敌基地在 ' + offz + ' 区、非本区，跨区打不到，绕后顺延',
      stop: false,
    };
  var marchData = new Battle().plan().preset(cfg.preset).adjust().build();
  if (!marchData.armyListNew.length)
    return { result: 'fail', reason: '预设 #' + cfg.preset + ' 无兵可派', stop: false };
  var spot = await defense.findRelocatableSpot(
    { x: ex, y: ey },
    {
      mode: 'near',
      radius: defense.NEAR_RADIUS,
      exclude: { x: snap.me.x, y: snap.me.y },
      ctx: { net: net, serverId: serverId() }, // 迁城落脚点必在我当前区(同区攻击铁律)：敌既被我打到就在本区；勿用 enemy.serverId 飞向他区
    },
  );
  if (!aliveFn())
    return { result: 'fail', reason: '流程已暂停 enemy=(' + ex + ',' + ey + ')', stop: false };
  if (!spot)
    return {
      result: 'fail',
      reason: '敌 ' + defense.NEAR_RADIUS + ' 单位内无可迁落脚 enemy=(' + ex + ',' + ey + ')',
      stop: false,
    };
  try {
    nav.flyTo({ x: spot.x, y: spot.y, z: serverId() || null, subMap: null, click: false });
  } catch (e) {}
  var mv = await moveCity(spot.x, spot.y);
  if (!aliveFn()) return { result: 'fail', reason: '迁城后流程已暂停', stop: false };
  if (!mv.ok)
    return {
      result: 'fail',
      reason: '迁城到(' + spot.x + ',' + spot.y + ')失败 ' + mv.why,
      stop: false,
    };
  if (!(await waitLanded(spot.x, spot.y)))
    return { result: 'fail', reason: '迁城回执成功但坐标未落地，放弃攻击防打空', stop: false };
  var marchType = marchApi.resolve(MARCH_TYPE_ATTACK_PLAYER, MARCH_FALLBACK);
  if (net.isSending(CMD_MARCH_WORLD_POINT))
    return { result: 'fail', reason: '902 在途，稍后重试', stop: false };
  var ret = await march.attack({ marchType: marchType, target: { x: ex, y: ey }, data: marchData });
  if (!aliveFn()) return { result: 'fail', reason: '攻击发包后流程已暂停', stop: false };
  if (ret.ok)
    return {
      result: 'hit',
      reason:
        '绕后攻击已发：敌(' +
        ex +
        ',' +
        ey +
        ') 自(' +
        spot.x +
        ',' +
        spot.y +
        ') marchType=' +
        marchType,
      stop: true,
    };
  return { result: 'fail', reason: '攻击被拒 ' + attackFailText(ret), stop: false };
}

/**
 * 策略 3：迁城逃避（911 迁到背向敌、离敌更远的可落点；本地带无落点则扇区轮换重试，见 defense.relocateAway）。
 * @param {object} snap 共享快照
 * @returns {Promise<{result:string, reason:string, stop:boolean}>}
 */
async function strategyRelocate(snap) {
  if (snap.marchesOut !== 0)
    return {
      result: 'skip',
      reason: '有 ' + snap.marchesOut + ' 支部队在外，需全部回城',
      stop: false,
    };
  if (snap.me.x == null || snap.me.y == null)
    return { result: 'fail', reason: '我方主城坐标未知', stop: false };
  var ex = snap.enemy.x,
    ey = snap.enemy.y;
  var threat = ex != null && ey != null ? { x: ex, y: ey } : null;
  var spot = await defense.findRelocatableSpot(
    { x: snap.me.x, y: snap.me.y },
    {
      mode: 'away',
      radius: defense.AWAY_RADIUS,
      threat: threat,
      ctx: { net: net, serverId: serverId() },
      alive: aliveFn, // 扇区轮换逐轮前检查：上层暂停/卸载即中断，不带着旧快照继续飞图发包
    },
  );
  if (!aliveFn()) return { result: 'fail', reason: '流程已暂停', stop: false };
  if (!spot) return { result: 'fail', reason: '无背向敌的可迁落脚', stop: false };
  var mv = await moveCity(spot.x, spot.y);
  if (!aliveFn()) return { result: 'fail', reason: '迁城后流程已暂停', stop: false };
  if (mv.ok) {
    try {
      nav.flyTo({ x: spot.x, y: spot.y, z: serverId() || null, subMap: null, click: false });
    } catch (e) {} // 迁成后镜头跟随到新落地点
    return { result: 'hit', reason: '迁城逃避至(' + spot.x + ',' + spot.y + ')', stop: true };
  }
  return {
    result: 'fail',
    reason: '迁城到(' + spot.x + ',' + spot.y + ')失败 ' + mv.why,
    stop: false,
  };
}

/**
 * 策略 4：原地反击（不迁城，直接以预设部队 902 从当前主城攻打敌主城）。
 * 闸门：有空闲队列 + 敌坐标已知 + 预设非空——**不要求全部部队回城**。
 * 与绕后/迁城逃避的区别：那两条发 911 迁城，在外部队会随城迁移丢回旧址或被服务器拒，故必须清场；
 * 原地反击只发 902 不动城，无此约束。且它是被动挨打(10167)时的应急反打，若死等在外部队全部回城，
 * 那波攻击早已落到头上——反击及时性被摧毁。预设里正在外出的兵由 Battle().adjust() 自动剔除，
 * 凑不凑得出兵由下面 freeSlots 与 armyListNew.length 两道闸兜住，无需 marchesOut===0 这道过严硬闸。
 * @param {object} snap 共享快照
 * @returns {Promise<{result:string, reason:string, stop:boolean}>}
 */
async function strategyCounter(snap) {
  if (snap.freeSlots < 1) return { result: 'fail', reason: '无空闲行军队列', stop: false };
  var ex = snap.enemy.x,
    ey = snap.enemy.y;
  if (ex == null || ey == null)
    return { result: 'fail', reason: '敌主城坐标未知(630 未回坐标)', stop: false };
  var offz = enemyOffZone(snap);
  if (offz)
    return {
      result: 'skip',
      reason: '敌基地在 ' + offz + ' 区、非本区，跨区打不到，反击顺延',
      stop: false,
    };
  var marchData = new Battle().plan().preset(cfg.preset).adjust().build();
  if (!marchData.armyListNew.length)
    return { result: 'fail', reason: '预设 #' + cfg.preset + ' 无兵可派', stop: false };
  var marchType = marchApi.resolve(MARCH_TYPE_ATTACK_PLAYER, MARCH_FALLBACK);
  if (net.isSending(CMD_MARCH_WORLD_POINT))
    return { result: 'fail', reason: '902 在途，稍后重试', stop: false };
  var ret = await march.attack({ marchType: marchType, target: { x: ex, y: ey }, data: marchData });
  if (!aliveFn()) return { result: 'fail', reason: '攻击发包后流程已暂停', stop: false };
  if (ret.ok)
    return {
      result: 'hit',
      reason:
        '原地反击已发：自(' +
        snap.me.x +
        ',' +
        snap.me.y +
        ')→敌(' +
        ex +
        ',' +
        ey +
        ') marchType=' +
        marchType,
      stop: true,
    };
  return { result: 'fail', reason: '攻击被拒 ' + attackFailText(ret), stop: false };
}

/** 按 sid 分派到具体策略 */
function runStrategy(sid, snap) {
  if (sid === SID.shield) return strategyShield(snap);
  if (sid === SID.attack) return strategyAttack(snap);
  if (sid === SID.relocate) return strategyRelocate(snap);
  if (sid === SID.counter) return strategyCounter(snap);
  return Promise.resolve({ result: 'fail', reason: '未知策略 id=' + sid, stop: false });
}

/**
 * 规整生效顺序：以 cfg.order 为准，补进缺失的策略 id、剔除非法 id（面板未拖拽时也保证 1..4 全覆盖）。
 * @returns {number[]} 去重后的完整顺序
 */
function normalizeOrder() {
  var out = [];
  var src = Array.isArray(cfg.order) ? cfg.order : [];
  for (var i = 0; i < src.length; i++) {
    var v = src[i] | 0;
    if (ALL_SIDS.indexOf(v) >= 0 && out.indexOf(v) < 0) out.push(v);
  }
  for (var j = 0; j < ALL_SIDS.length; j++) {
    if (out.indexOf(ALL_SIDS[j]) < 0) out.push(ALL_SIDS[j]);
  }
  return out;
}

/**
 * 单条来袭的防御流程（永不 reject）：建快照 → 已开盾则整 feat 收手 → 按序遍历策略（跳过未勾选，首个成功即停）。
 * @param {object} pushData 10167 载荷
 */
async function runFlow(pushData) {
  busy = true;
  try {
    var snap = await buildSnapshot(pushData);
    if (!snap || !aliveFn()) return;
    log.info(
      'snapshot ready. enemy=(%s,%s) src=%s power=%s; me=(%s,%s) power=%s',
      snap.enemy.x,
      snap.enemy.y,
      snap.enemy.src,
      snap.enemy.power,
      snap.me.x,
      snap.me.y,
      snap.me.power,
    );
    if (snap.shieldActive) {
      decision(snap.marchId, 'autoDefense', 'skip', '护盾已在生效，本轮无需防御');
      return;
    }
    var order = normalizeOrder();
    var selected = new Set(Array.isArray(cfg.strategies) ? cfg.strategies : []);
    for (var k = 0; k < order.length; k++) {
      if (!aliveFn()) return; // 暂停即自然收手
      var sid = order[k];
      if (!selected.has(sid)) {
        decision(
          snap.marchId,
          STRATEGY_LABEL[sid] || '#' + sid,
          'not-selected',
          '面板未勾选该策略',
          'debug',
        );
        continue;
      }
      var r = await runStrategy(sid, snap);
      if (!aliveFn()) return;
      decision(
        snap.marchId,
        STRATEGY_LABEL[sid] || '#' + sid,
        r.result,
        r.reason,
        r.result === 'skip' ? 'debug' : 'info',
      );
      if (r.stop) return; // 首个 hit 命中即停
    }
    // 全部策略未命中：不向游戏侧告警（定案 4），逐条决策已落日志
  } catch (err) {
    log.warn('defense flow threw!', err);
  } finally {
    busy = false;
  }
}

/**
 * 10167 推送处理：解析来袭态 → 去重/终止 → 单飞闸门 → 触发防御。
 * @param {object} ev net 推送事件 {data}
 */
function onAttack(ev) {
  if (!aliveFn()) return;
  var d = ev && typeof ev.data === 'object' ? ev.data : safeParse(ev && ev.data);
  if (!d || typeof d !== 'object') {
    log.debug('10167 payload not object; skip');
    return;
  }
  var attackState = Number(d.attackState);
  var marchId = d.marchId != null ? String(d.marchId) : '';
  if (attackState === 0) {
    log.debug('attack ended. marchId=%s', marchId);
    return;
  } // 结束态：不再触发
  if (attackState !== 1) {
    log.debug('attackState not 1(%s); skip', attackState);
    return;
  }
  // 夺宝奇兵（CSHunt）攻击闸门：星歼者 PVE、对手玩家拦截/击败我的夺宝飞船，服务器都以
  //   uid=0（且缺 level/arrivalTime、marchId 恒等于夺宝 treasureId）的形态推 10167，
  //   那是「争抢的宝箱/飞船被攻打」，不是「你的世界主城被攻打」，无需开盾/迁城/反击。
  //   真主城被攻必带非 0 攻击者 uid（报文实证 20261007T214736：uid=14913381732485/level/arrivalTime 齐全）；
  //   真机 4 份夺宝日志全量核验：10167 的 uid 恒为 0，无一例外。故 uid 缺失或为 0 → 非主城被攻，直接跳过。
  if (!Number(d.uid)) {
    log.debug(
      '10167 no real attacker uid(%s); treasure-hunt/non-city attack, skip. marchId=%s',
      d.uid,
      marchId,
    );
    return;
  }
  if (alreadySeen(marchId)) return; // 同 marchId 只处理一次
  if (busy) {
    log.debug('busy, ignore concurrent attack push. marchId=%s', marchId);
    return;
  } // 单飞：在飞期新推送合并/忽略
  log.info('incoming attack, defending. uid=%s;marchId=%s;level=%s', d.uid, marchId, d.level);
  runFlow(d).catch(function (err) {
    log.warn('defense runFlow threw!', err);
  });
}

/**
 * 注入面板配置。
 * @param {object} partial {enabled, strategies, order, preset, skipPowerCheck}
 * @returns {object} 当前 cfg
 */
function configure(partial) {
  if (!partial) return cfg;
  cfg.strategies = Array.isArray(partial.strategies) ? partial.strategies.slice() : [];
  cfg.order = Array.isArray(partial.order) ? partial.order.slice() : ALL_SIDS.slice();
  cfg.preset = partial.preset | 0 || 1;
  cfg.skipPowerCheck = !!partial.skipPowerCheck;
  return cfg;
}

/**
 * 安装：取网络底座 + 数据中心。任一缺失即失败（reactor 不会激活）。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) return true;
  var missing = [];
  net = ctx.net;
  if (!net || !net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }
  var dc = game.get('DataCenter');
  if (!dc) missing.push('DataCenter');
  if (missing.length) {
    net = null;
    log.warn('install failed. missing=%s', missing.join(';'));
    return false;
  }
  installed = true;
  log.info('installed.');
  return true;
}

/**
 * 激活：订阅被攻击推送（pause 由 ctx.on.push 统一摘除）。
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  busy = false;
  ctx.on.push(CMD_PUSH_ATTACK_ARMIES, onAttack);
  log.info(
    'started, strategies=%s;order=%s;preset=%d;skipPowerCheck=%s',
    JSON.stringify(cfg.strategies),
    JSON.stringify(cfg.order),
    cfg.preset,
    cfg.skipPowerCheck,
  );
}

/** multiopts / sortlist 的策略选项（数值 id ↔ 中文名） */
const STRATEGY_OPTIONS = ALL_SIDS.map(function (id) {
  return { value: id, label: STRATEGY_LABEL[id] };
});
/** 绕后攻击 / 原地反击 预设部队下拉（1..8） */
const PRESET_OPTIONS = [];
for (var pi = 1; pi <= PRESET_MAX; pi++) PRESET_OPTIONS.push({ value: pi, label: '预设 ' + pi });
/** sortlist 行标签解析：id → [{id,name}] */
function strategyResolve(id) {
  var n = Number(id);
  return [{ id: n, name: STRATEGY_LABEL[n] || String(id) }];
}

/**
 * 向 reactor 注册本功能说明书：场景 Home/NWorldMap + 世界态 B 档；战斗设置类，不声明 offInCombat（战斗模式下照常防御）。
 * 停摆档刻意排除 pab/cnc/cnc25（秘境是副本接管世界图、征服者是球体场景，都不是「你的世界城被攻打」）；
 * adp_war 保守放行——盟决战场无静态信号确认城在场，但停防御的代价（被打不反应）大于空跑代价（最多废一张迁城卡）。
 */
reactor.register({
  id: 'autoDefense',
  label: '自动防御',
  storageKey: 'pocketcc.feat.autoDefense',
  symbols: [
    'dataCenter',
    'marchType',
    'worldUtils',
    'tableManager',
    'localManager',
    'presetMarch',
    'heroController',
    'mechaController',
    'formationAdv',
    'marchStorage',
    'buff?',
    'commonTools',
  ],
  places: ['base', 'world'],
  // B 档：跨服战场图内仍需防御（城照样被打破），开盾这一条在 strategyShield 内按 kind/crossMap 降级
  kinds: ['homeland', 'wushuang', 'kvk', 'adp_war'],
  defaults: {
    enabled: false,
    strategies: ALL_SIDS.slice(),
    order: ALL_SIDS.slice(),
    preset: 1,
    skipPowerCheck: false,
  },
  fields: [
    {
      key: 'strategies',
      type: 'multiopts',
      label: '启用策略',
      options: STRATEGY_OPTIONS,
      hint: '勾选被攻击时要自动执行的防御策略（可多选）；与总开关叠加',
    },
    {
      key: 'order',
      type: 'sortlist',
      label: '生效顺序',
      resolve: strategyResolve,
      all: function () {
        return ALL_SIDS.slice();
      },
      hint: '拖动调整策略尝试顺序；执行按此序依次尝试，首个成功即停（仅对已勾选策略生效）',
    },
    {
      key: 'skipPowerCheck',
      type: 'checkbox',
      label: '跳过战力判断',
      hint: '仅影响开盾：勾选=无论敌我战力一律尝试开盾；不勾选=我战力≥敌战力则跳过开盾（顺延下一条）',
    },
    {
      key: 'preset',
      type: 'select',
      label: '攻击部队预设',
      options: PRESET_OPTIONS,
      hint: '绕后攻击 / 原地反击 使用的预设部队号',
    },
  ],
  // 面板值经 toModuleCfg 透传给 configure（漏传则运行时恒空）
  toModuleCfg: function (c) {
    return {
      strategies: Array.isArray(c.strategies) ? c.strategies.slice() : [],
      order: Array.isArray(c.order) ? c.order.slice() : ALL_SIDS.slice(),
      preset: c.preset | 0 || 1,
      skipPowerCheck: !!c.skipPowerCheck,
    };
  },
  install: install,
  configure: configure,
  run: run,
});
