/**
 * 自动防御（reactor 说明书形态，属「战斗设置」）
 *
 * 收到服务器 push 10167 PUSH_ATTACK_ARMIES「你被攻击了」→ 用一份共享「条件快照」驱动三条可独立开关、
 *   顺序可调的防御策略，按序尝试、首个「闸门过且执行成功」即停，否则顺延下一条：
 *     · 策略 1 自动开盾（910）：背包取最短时长盾档、恒 isPurchase:0；可选战力闸门（我战力≥敌则跳过开盾但顺延），
 *       敌战力取不到按「无限高·最悲观」照常开盾；拒因 war_fever_003/kingdom_077 以 910 status=3 为最终裁决。
 *     · 策略 2 绕后攻击：迁城到敌主城 8 单位内最近合法可落点（911），迁城落地确认后以预设部队 902 打敌主城。
 *       不做行军加速——贴近即压缩行军；8 单位内无落点则放弃顺延。
 *     · 策略 3 迁城逃避：以我方主城为锚、背向敌取离敌更远的合法落点（911）迁走；迁成后镜头跟随到新落地点。
 *
 * 坐标/战力来源（报文实证）：敌主城坐标与战力一次 630 PLAYER_INFO 按 uid 直查（应答顶层 x/y=主城、power/level），
 *   与视口/场景无关——Home 城内也能查。（曾试过 10007 MARCH_INFO push：它是视口绑定推送，视野在 Home 时不下发；
 *   又试过 909 GET_PLAYER_POINT：它是取点护盾信息、targetId 对应本地 UserData、返回的是自己，均非「按 uid 查陌生玩家」。）
 *   我方坐标走本地 UserData.WorldCoord（gameData.myWorldPos）、战力走本地 UserData.Power（gameData.myPower）。
 *   去重/终止：同 marchId 去重；attackState=0 视为已结束不再触发；attackState=1 才触发。
 *
 * 决策日志（硬性要求）：每条策略评估后必落一行 `[autoDefense] marchId=… decision=… result=… reason=…`，
 *   result∈{hit|skip|fail|not-selected}；战力场景同时打印 me.power/enemy.power，未知显式记 power=unknown→assume-max。
 *   全部未命中 → 不向游戏侧告警（不聊天、不弹窗），只本地日志照记。
 *
 * 合规：只读游戏数据 + 发包（910/911/902/630），不调任何游戏 Update/Delete 改写本地数据。
 *   场景 ['Home','NWorldMap']；不声明 offInCombat——战斗模式下照常防御（与快捷战斗/奉旨出征同侧）。
 *   高影响（自动耗盾/迁城卡、自动迁走主城）：面板默认关闭 + 逐条策略开关。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { gameData, l10n, march as marchApi, nav } from '../../core/game-api.js';
import { reactor } from '../../core/reactor.js';
import { Battle } from '../../core/battle.js';
import { march } from '../../core/march.js';
import { defense } from '../../core/defense.js';

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
 * 三条策略的 id ↔ 中文名（multiopts 的 option.value 为数字，order 亦存数字，两处交叉引用同一套 id）。
 * @type {{shield:number, attack:number, relocate:number}}
 */
const SID = { shield: 1, attack: 2, relocate: 3 };
/** @type {Object<number,string>} 数字 id → 中文标签（面板 sortlist resolve + 决策日志 decision 名） */
const STRATEGY_LABEL = { 1: '自动开盾', 2: '绕后攻击', 3: '迁城逃避' };
/** 全量策略 id（order 规整时的补全基准） */
const ALL_SIDS = [SID.shield, SID.attack, SID.relocate];

/** @type {number} 已触发防御的 marchId 内存上限（FIFO 淘汰，防长会话无界增长） */
const SEEN_MAX = 200;

/** @type {number} 迁城回执后等待 myWorldPos 落地刷新的轮询间隔/上限（ms）：防「迁城未落地即攻击打空」 */
const LAND_POLL_MS = 250;
const LAND_TIMEOUT_MS = 2000;

/** @type {object|null} 网络底座（install 时取） */
var net;
/** @type {object|null} DataCenter.DATA */
var dataCenter;
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
var cfg = { strategies: ALL_SIDS.slice(), order: ALL_SIDS.slice(), preset: 1, skipPowerCheck: false };

/**
 * 功能是否仍在运行（在飞流程 await 回来后的存活判定）。
 * @returns {boolean}
 */
function aliveFn() { return ctxRef ? ctxRef.alive() : false; }

/**
 * JSON.parse 兜底（应答 data 可能是串也可能已对象化）。
 * @param {*} s
 * @returns {object|null}
 */
function safeParse(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** 数值 or null（'' / null / 非数 → null，区别于合法的 0） */
function numOrNull(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/** 本人服号（911/901 body 用；取不到回 0，游戏侧自认本服） */
function serverId() {
  try { var u = (dataCenter && dataCenter.UserData) || null; return (u && u.ServerId) | 0; } catch (e) { return 0; }
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
 * 630 PLAYER_INFO 按 uid 查玩家基础信息：解析主城坐标 x/y + 战力 + 等级（字段缺失记 null，永不抛）。
 * 应答顶层即含 x/y/power/level/allianceName/serverId（真机实证，同 chat-window 630 飞图口径）；
 * 与视口/场景无关，Home 城内也能查——绕后攻击据此取敌主城坐标，不依赖 10007 行军推送。
 * @param {string|number} uid 目标玩家 uid（push.uid 是 JS number，须转字符串上线，防 Int64 反序列化拒绝）
 * @returns {Promise<{x:(number|null), y:(number|null), power:(number|null), level:number}|null>} 请求失败/无载荷返回 null
 */
async function getPlayerInfoByUid(uid) {
  if (uid == null || uid === '') return null;
  var ret;
  try { ret = await net.send(CMD_PLAYER_INFO, { uid: String(uid) }); }
  catch (err) { log.warn('630 send error. uid=%s', uid, err); return null; }
  if (!ret || !ret.ok) { log.info('630 not ok. uid=%s;code=%s', uid, ret && ret.code); return null; }
  var d = safeParse(ret.data) || {};
  var x = numOrNull(d.x), y = numOrNull(d.y);
  var power = numOrNull(d.power);
  var level = Number(d.level) || 0;
  if (x == null && y == null && power == null) return null;   // 啥都没解析出来 → 视为查无
  return { x: x, y: y, power: power, level: level };
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
    ? { x: info.x, y: info.y, power: info.power, level: info.level, src: '630' }
    : { x: null, y: null, power: null, level: 0, src: 'none' };
  // 3) 在外部队数
  var marchesOut = 0;
  var ms = await march.list();
  for (var i = 0; i < ms.length; i++) { if (march.isOccupying(ms[i])) marchesOut++; }
  return {
    marchId: pushData.marchId != null ? String(pushData.marchId) : '',
    enemy: enemy,
    me: me,
    shieldItem: defense.pickShieldItem(),
    canMove: gameData.itemAmount(defense.ITEM_MOVE_CITY) > 0,
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
  var ret;
  try { ret = await net.send(CMD_MOVE_CITY_POSITION, body); }
  catch (err) { log.warn('911 send error. x=%d;y=%d', x, y, err); return { ok: false, why: '迁城发包异常' }; }
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
    await new Promise(function (r) { setTimeout(r, LAND_POLL_MS); });
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

// ─────────────────────── 三条策略（各返回 {result, reason, stop}；stop=true 即命中收手） ───────────────────────

/**
 * 策略 1：自动开盾（910）。闸门：背包有盾 & 未生效 & 非狂热 & 游戏未判不可开；可选战力闸门。
 * @param {object} snap 共享快照
 * @returns {Promise<{result:string, reason:string, stop:boolean}>}
 */
async function strategyShield(snap) {
  if (snap.shieldItem == null) return { result: 'fail', reason: '背包无可用护盾道具', stop: false };
  if (snap.warFever) return { result: 'fail', reason: '战争狂热禁止开盾', stop: false };
  if (snap.canShieldByGame === false) return { result: 'fail', reason: '游戏判定不可开盾(危险区/跨服)', stop: false };
  // 战力闸门（面板勾选「跳过战力判断」则不判；定案 2/3：跳过≠放弃，仍顺延后续策略）
  var powerNote;
  if (cfg.skipPowerCheck) {
    powerNote = ';me.power=' + snap.me.power + ',enemy.power=' + snap.enemy.power + ';skip-power-check';
  } else {
    var ep = snap.enemy.power, mp = snap.me.power;
    if (ep == null) {
      powerNote = ';power=unknown→assume-max(最悲观);me.power=' + mp + ',enemy.power=null';   // 敌战力取不到按无限高，照常开盾
    } else {
      powerNote = ';me.power=' + mp + ',enemy.power=' + ep;
      if (mp != null && ep <= mp) return { result: 'skip', reason: '我方战力更高，无需开盾' + powerNote, stop: false };
    }
  }
  var ret;
  try { ret = await net.send(CMD_PEACE_SHIELD, { itemId: snap.shieldItem, amount: 1, isPurchase: 0 }); }
  catch (err) { log.warn('910 send error. itemId=%d', snap.shieldItem, err); return { result: 'fail', reason: '开盾发包异常' + powerNote, stop: false }; }
  if (!aliveFn()) return { result: 'fail', reason: '流程已暂停' + powerNote, stop: false };
  if (ret && ret.ok) return { result: 'hit', reason: '开盾成功 itemId=' + snap.shieldItem + powerNote, stop: true };
  return { result: 'fail', reason: '开盾被拒 ' + rejectText(ret) + powerNote, stop: false };
}

/**
 * 策略 2：绕后攻击（迁城 911 到敌 8 单位内最近可落点 + 902 打敌主城）。无行军加速。
 * @param {object} snap 共享快照
 * @returns {Promise<{result:string, reason:string, stop:boolean}>}
 */
async function strategyAttack(snap) {
  if (snap.marchesOut !== 0) return { result: 'skip', reason: '有 ' + snap.marchesOut + ' 支部队在外，需全部回城', stop: false };
  if (snap.freeSlots < 1) return { result: 'fail', reason: '无空闲行军队列', stop: false };
  // canMove 不再作硬闸（钻石兜底），仅作日志参考
  var ex = snap.enemy.x, ey = snap.enemy.y;
  if (ex == null || ey == null) return { result: 'fail', reason: '敌主城坐标未知(909 未回坐标)', stop: false };
  var marchData = new Battle().plan().preset(cfg.preset).adjust().build();
  if (!marchData.armyListNew.length) return { result: 'fail', reason: '预设 #' + cfg.preset + ' 无兵可派', stop: false };
  var spot = await defense.findRelocatableSpot({ x: ex, y: ey }, { mode: 'near', radius: defense.NEAR_RADIUS, exclude: { x: snap.me.x, y: snap.me.y }, ctx: { net: net, serverId: serverId() } });
  if (!aliveFn()) return { result: 'fail', reason: '流程已暂停 enemy=(' + ex + ',' + ey + ')', stop: false };
  if (!spot) return { result: 'fail', reason: '敌 ' + defense.NEAR_RADIUS + ' 单位内无可迁落脚 enemy=(' + ex + ',' + ey + ')', stop: false };
  try { nav.flyTo({ x: spot.x, y: spot.y, z: serverId() || null, subMap: null, click: false }); } catch (e) { }
  var mv = await moveCity(spot.x, spot.y);
  if (!aliveFn()) return { result: 'fail', reason: '迁城后流程已暂停', stop: false };
  if (!mv.ok) return { result: 'fail', reason: '迁城到(' + spot.x + ',' + spot.y + ')' + mv.why, stop: false };
  if (!(await waitLanded(spot.x, spot.y))) return { result: 'fail', reason: '迁城回执成功但坐标未落地，放弃攻击防打空', stop: false };
  var marchType = marchApi.resolve(MARCH_TYPE_ATTACK_PLAYER, MARCH_FALLBACK);
  if (net.isSending(CMD_MARCH_WORLD_POINT)) return { result: 'fail', reason: '902 在途，稍后重试', stop: false };
  var ret = await march.attack({ marchType: marchType, target: { x: ex, y: ey }, data: marchData });
  if (!aliveFn()) return { result: 'fail', reason: '攻击发包后流程已暂停', stop: false };
  if (ret.ok) return { result: 'hit', reason: '绕后攻击已发：敌(' + ex + ',' + ey + ') 自(' + spot.x + ',' + spot.y + ') marchType=' + marchType, stop: true };
  return { result: 'fail', reason: '攻击被拒 ' + attackFailText(ret), stop: false };
}

/**
 * 策略 3：迁城逃避（911 迁到背向敌、离敌更远的可落点）。
 * @param {object} snap 共享快照
 * @returns {Promise<{result:string, reason:string, stop:boolean}>}
 */
async function strategyRelocate(snap) {
  if (snap.marchesOut !== 0) return { result: 'skip', reason: '有 ' + snap.marchesOut + ' 支部队在外，需全部回城', stop: false };
  if (snap.me.x == null || snap.me.y == null) return { result: 'fail', reason: '我方主城坐标未知', stop: false };
  var ex = snap.enemy.x, ey = snap.enemy.y;
  var threat = (ex != null && ey != null) ? { x: ex, y: ey } : null;
  var spot = await defense.findRelocatableSpot({ x: snap.me.x, y: snap.me.y }, { mode: 'away', radius: defense.AWAY_RADIUS, threat: threat, ctx: { net: net, serverId: serverId() } });
  if (!aliveFn()) return { result: 'fail', reason: '流程已暂停', stop: false };
  if (!spot) return { result: 'fail', reason: '无背向敌的可迁落脚', stop: false };
  var mv = await moveCity(spot.x, spot.y);
  if (!aliveFn()) return { result: 'fail', reason: '迁城后流程已暂停', stop: false };
  if (mv.ok) {
    try { nav.flyTo({ x: spot.x, y: spot.y, z: serverId() || null, subMap: null, click: false }); } catch (e) { }   // 迁成后镜头跟随到新落地点
    return { result: 'hit', reason: '迁城逃避至(' + spot.x + ',' + spot.y + ')', stop: true };
  }
  return { result: 'fail', reason: '迁城' + mv.why, stop: false };
}

/** 按 sid 分派到具体策略 */
function runStrategy(sid, snap) {
  if (sid === SID.shield) return strategyShield(snap);
  if (sid === SID.attack) return strategyAttack(snap);
  if (sid === SID.relocate) return strategyRelocate(snap);
  return Promise.resolve({ result: 'fail', reason: '未知策略 id=' + sid, stop: false });
}

/**
 * 规整生效顺序：以 cfg.order 为准，补进缺失的策略 id、剔除非法 id（面板未拖拽时也保证 1..3 全覆盖）。
 * @returns {number[]} 去重后的完整顺序
 */
function normalizeOrder() {
  var out = [];
  var src = Array.isArray(cfg.order) ? cfg.order : [];
  for (var i = 0; i < src.length; i++) {
    var v = src[i] | 0;
    if (ALL_SIDS.indexOf(v) >= 0 && out.indexOf(v) < 0) out.push(v);
  }
  for (var j = 0; j < ALL_SIDS.length; j++) { if (out.indexOf(ALL_SIDS[j]) < 0) out.push(ALL_SIDS[j]); }
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
    log.info('snapshot ready. enemy=(%s,%s) src=%s power=%s; me=(%s,%s) power=%s',
      snap.enemy.x, snap.enemy.y, snap.enemy.src, snap.enemy.power, snap.me.x, snap.me.y, snap.me.power);
    if (snap.shieldActive) { decision(snap.marchId, 'autoDefense', 'skip', '护盾已在生效，本轮无需防御'); return; }
    var order = normalizeOrder();
    var selected = new Set(Array.isArray(cfg.strategies) ? cfg.strategies : []);
    for (var k = 0; k < order.length; k++) {
      if (!aliveFn()) return;                       // 暂停即自然收手
      var sid = order[k];
      if (!selected.has(sid)) { decision(snap.marchId, STRATEGY_LABEL[sid] || ('#' + sid), 'not-selected', '面板未勾选该策略', 'debug'); continue; }
      var r = await runStrategy(sid, snap);
      if (!aliveFn()) return;
      decision(snap.marchId, STRATEGY_LABEL[sid] || ('#' + sid), r.result, r.reason, r.result === 'skip' ? 'debug' : 'info');
      if (r.stop) return;                            // 首个 hit 命中即停
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
  var d = (ev && typeof ev.data === 'object') ? ev.data : safeParse(ev && ev.data);
  if (!d || typeof d !== 'object') { log.debug('10167 payload not object; skip'); return; }
  var attackState = Number(d.attackState);
  var marchId = d.marchId != null ? String(d.marchId) : '';
  if (attackState === 0) { log.debug('attack ended. marchId=%s', marchId); return; }   // 结束态：不再触发
  if (attackState !== 1) { log.debug('attackState not 1(%s); skip', attackState); return; }
  if (d.uid == null || d.uid === '') { log.debug('10167 missing uid; skip'); return; }
  if (alreadySeen(marchId)) return;                  // 同 marchId 只处理一次
  if (busy) { log.debug('busy, ignore concurrent attack push. marchId=%s', marchId); return; }   // 单飞：在飞期新推送合并/忽略
  log.info('incoming attack, defending. uid=%s;marchId=%s;level=%s', d.uid, marchId, d.level);
  runFlow(d).catch(function (err) { log.warn('defense runFlow threw!', err); });
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
  cfg.preset = (partial.preset | 0) || 1;
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
  if (!net || !net.install()) { missing.push('pocketcc.net'); net = null; }
  var dc = game.get('DataCenter');
  dataCenter = (dc && dc.DATA) || null;
  if (!dataCenter) missing.push('DataCenter');
  if (missing.length) {
    net = null; dataCenter = null;
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
  log.info('started, strategies=%s;order=%s;preset=%d;skipPowerCheck=%s', JSON.stringify(cfg.strategies), JSON.stringify(cfg.order), cfg.preset, cfg.skipPowerCheck);
}

/** multiopts / sortlist 的策略选项（数值 id ↔ 中文名） */
const STRATEGY_OPTIONS = ALL_SIDS.map(function (id) { return { value: id, label: STRATEGY_LABEL[id] }; });
/** 绕后攻击预设部队下拉（1..8） */
const PRESET_OPTIONS = [];
for (var pi = 1; pi <= PRESET_MAX; pi++) PRESET_OPTIONS.push({ value: pi, label: '预设 ' + pi });
/** sortlist 行标签解析：id → [{id,name}] */
function strategyResolve(id) {
  var n = Number(id);
  return [{ id: n, name: STRATEGY_LABEL[n] || String(id) }];
}

/**
 * 向 reactor 注册本功能说明书：场景 Home/NWorldMap；战斗设置类，不声明 offInCombat（战斗模式下照常防御）。
 */
reactor.register({
  id: 'autoDefense',
  label: '自动防御',
  storageKey: 'pocketcc.feat.autoDefense',
  symbols: ['dataCenter', 'marchType', 'worldUtils', 'tableManager', 'localManager', 'presetMarch', 'heroController', 'mechaController', 'formationAdv', 'marchStorage', 'buff?', 'commonTools'],
  scenes: ['Home', 'NWorldMap'],
  defaults: {
    enabled: false,
    strategies: ALL_SIDS.slice(),
    order: ALL_SIDS.slice(),
    preset: 1,
    skipPowerCheck: false,
  },
  fields: [
    { key: 'strategies', type: 'multiopts', label: '启用策略', options: STRATEGY_OPTIONS, hint: '勾选被攻击时要自动执行的防御策略（可多选）；与总开关叠加' },
    { key: 'order', type: 'sortlist', label: '生效顺序', resolve: strategyResolve, hint: '拖动调整策略尝试顺序；执行按此序依次尝试，首个成功即停（仅对已勾选策略生效）' },
    { key: 'skipPowerCheck', type: 'checkbox', label: '跳过战力判断', hint: '仅影响开盾：勾选=无论敌我战力一律尝试开盾；不勾选=我战力≥敌战力则跳过开盾（顺延下一条）' },
    { key: 'preset', type: 'select', label: '绕后攻击部队', options: PRESET_OPTIONS, hint: '绕后攻击使用的预设部队号' },
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
