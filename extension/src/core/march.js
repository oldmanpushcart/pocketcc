/**
 * core/march.js —— 行军统一抽象（行为/聚合层）
 *
 * 职责边界（铁律）：
 *   - 屏蔽各 feat 对「本人行军」数据结构/协议的零散获取：取列表(856)、名额(UserData)、发/撤/加速(902/904/920)、
 *     生命周期(10019) 统一收口于此，feat 只消费归一化 March + 调模块动词。
 *   - marchType 一律「外部传入」：不同活动类型各异（3 普通田/26 机械田/35 发射井/298 SOW/18 机甲/180 寻宝/
 *     13 攻玩家城…），且跨服漂移（quick-attack/imperial-decree 的 marchApi.resolve）属各 feat 业务，
 *     march.js 不解读、不换算、不代理 type 语义，仅把它当 902 body 的一个透传字段。
 *   - 纯数据 March：不持方法/闭包，可自由序列化与单测；一切动作走模块动词（march.attack/pickUp/recall/speedUp）。
 *   - 生命周期 = 全局单点常驻订阅 net.10019（非 ctx 级、非引用计数）→ 边沿检测 → 内部复播。
 *     代价（已接受）：feat 暂停仍会收到复播 → 回调内必须自判 alive；按 m.type 过滤/节流仍是 feat 策略。
 *
 * ACL 边界：本模块只含「线协议常量」（cmd 号 856/902/904/920/10019、加速道具 itemId 与 NMarchState 语义数值），
 *   这些是稳定的服务器契约常量、非游戏 bundle 符号名，故就近定义；游戏 bundle 符号名仍收口在 game-api.js SYM。
 */
import { createLog } from './log.js';
import { bus } from './bus.js';
import { gameData } from './game-api.js';
import { parseData } from './util.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=MARCH） */
const log = createLog('MARCH');

// ── 线协议常量（服务器契约，非 bundle 符号，就近收口） ─────────────────
/** @type {number} RequestId.GET_ALL_MY_MARCH_INFO：全量本人行军（视口无关，Home 亦有）→ 取列表权威源 */
const CMD_GET_ALL_MY_MARCH_INFO = 856;
/** @type {number} RequestId.MARCH_WORLD_POINT：世界地图行军（发） */
const CMD_MARCH_WORLD_POINT = 902;
/** @type {number} RequestId.RECALL_MARCH：撤回单条行军（{marchId}） */
const CMD_RECALL_MARCH = 904;
/** @type {number} ResponseId.USER_MARCH_INFO：本人行军状态推送（生命周期唤醒源） */
const CMD_USER_MARCH_INFO = 10019;
/** @type {number} RequestId.MARCH_SPEED_UP：对一条在途行军使用加速道具（{marchId,itemId}） */
const CMD_MARCH_SPEED_UP = 920;

/**
 * 加速道具 itemId（稳定内容常量，真机报文实证 dashcam 20261005T204748）：
 * 同一条行军先 520001（普通）后 520002（高级），应答均 s=0/空载荷。
 * @type {number}
 */
const ITEM_SPEED_UP_NORMAL = 520001;
/** @type {number} 高级加速道具 itemId */
const ITEM_SPEED_UP_ADVANCED = 520002;

/**
 * 行军状态语义数值（NMarchState：subpack2/NWorldMapMarchCommon）。
 * 稳定枚举，作本地权威副本（真机符号漂移时不至全线瘫痪）。
 * @type {{INIT:number,MARCHING:number,ARRIVED:number,RETURNING:number,ARRIVED_HOME:number,GATHERING:number}}
 */
const State = { INIT: 0, MARCHING: 1, ARRIVED: 2, RETURNING: 3, ARRIVED_HOME: 4, GATHERING: 5 };
/** @type {Object<number,string>} 数值 → 成员名（展示/dump 用） */
const STATE_NAME = {
  0: 'INIT',
  1: 'MARCHING',
  2: 'ARRIVED',
  3: 'RETURNING',
  4: 'ARRIVED_HOME',
  5: 'GATHERING',
};

/** @type {number} 非服务器返回的哨兵 code：发送异常/在途闸门未放开时用（收编各 feat 行军处 CODE_NOT_SENT） */
const NOT_SENT = -1;

/** @returns {object|undefined} pocketcc.net 底座（懒取，install 时机可能早于底座安装） */
function net() {
  return window.pocketcc && window.pocketcc.net;
}

/** 应答 data 归一的 parse 兜底已上收 core/util.js（单一真相），本模块经文件头 import { parseData }。 */

/** 取第一个「非 null/undefined」数值（|0），全空回 def */
function firstNum() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v != null && v !== '') return v | 0;
  }
  return 0;
}

/** 时刻专用取第一个可解析正数值（不做 |0 截断）：行军时刻为 epoch 秒（2038 前 <2^31 安全），
 *  但若某来源以毫秒下发，firstNum 的 |0 会静默截成负数、令调用方 >0 判据全体失效，故不截断。 */
function firstTime() {
  for (var i = 0; i < arguments.length; i++) {
    var v = Number(arguments[i]);
    if (isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** net 缺失时的降级 Ret（无 Ret 类可用） */
function fallbackRet() {
  return { ok: false, code: NOT_SENT, data: null };
}
/** 在途/异常哨兵 Ret */
function notSentRet() {
  var n = net();
  return n && n.Ret ? n.Ret.from(NOT_SENT, null) : fallbackRet();
}

/**
 * 是否占用矿位/名额：非返程(RETURNING)、非到家(ARRIVED_HOME)。
 * 去程/到达/采集中都算占位；唯返程与到家已让出名额。
 * @param {object} m March（或自带 state 的任意对象）
 * @returns {boolean}
 */
function isOccupying(m) {
  return !!(m && m.state !== State.RETURNING && m.state !== State.ARRIVED_HOME);
}

/**
 * 归一化行军条目 → March（屏蔽 856/10019 嵌套、mapData.marches 摊平、Int64 三坑）。
 * 兼容三种来源，字段优先级：
 *   - state：marchInfo.state → 摊平 marchState → state；
 *   - type：marchInfo.marchType → marchType；
 *   - id：marchInfo.marchId → marchId（一律 String()，>2^53 安全）；
 *   - target.x/y：摊平 target_tx/ty 优先 → 嵌套 marchInfo.target.tx/ty → entry.target.tx/ty（修历史「恒 undefined」坑）；
 *   - target.itemId：摊平 itemId 优先 → 嵌套 target.itemId → marchInfo.itemId；
 *   - target.targetType：嵌套 target.targetType（与 901 pointList[].pointType 同轴，报文实证 856 条目恒带：
 *     普通资源田 4 / 要塞遗迹 6 级田 38）。采集行军「是不是遗迹田」的硬判据，不依赖 RESOURCE 表是否就绪；
 *   - 时刻：marchStartTime/marchArrive/returnArriveTime（服务器 epoch 秒）嵌套 marchInfo.* 优先 → 摊平顶层，
 *     供「剩余行军时间/加速后到达点/腾位打点」直接读，无需再各自摸 raw 的两条路径（856/10019 均嵌在 marchInfo 下）。
 * type 仅透传展示，march.js 不解读、不做漂移。永不抛异常，非法输入回 null。
 * @param {object} rawEntry 856 条目 / 10019 推送体 / mapData.marches 摊平条目
 * @returns {object|null} March = {id:str,type,state,stateName,isOccupying,target:{x,y,itemId,targetType},marchStartTime,marchArrive,returnArriveTime,raw}
 */
function decode(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  var mi = rawEntry.marchInfo || null;
  var stateSrc = mi || rawEntry;
  var state = mi
    ? mi.state != null
      ? mi.state | 0
      : rawEntry.marchState != null
        ? rawEntry.marchState | 0
        : stateSrc.state | 0
    : rawEntry.marchState != null
      ? rawEntry.marchState | 0
      : rawEntry.state | 0;
  var type = firstNum(mi && mi.marchType, rawEntry.marchType);
  var idRaw =
    mi && mi.marchId != null
      ? mi.marchId
      : rawEntry.marchId != null
        ? rawEntry.marchId
        : rawEntry.id != null
          ? rawEntry.id
          : null;
  var id = idRaw != null ? String(idRaw) : '';
  var mt = mi && mi.target;
  var et = rawEntry.target;
  var x = firstNum(rawEntry.target_tx, mt && mt.tx, et && et.tx, mi && mi.tx);
  var y = firstNum(rawEntry.target_ty, mt && mt.ty, et && et.ty, mi && mi.ty);
  var itemId = firstNum(rawEntry.itemId, mt && mt.itemId, et && et.itemId, mi && mi.itemId);
  var targetType = firstNum(mt && mt.targetType, et && et.targetType);
  // 行军时刻（服务器 epoch 秒）：嵌套 marchInfo.* 优先，回落摊平顶层；缺省 0（不代表返程未发生，交由调用方 >0 判）。
  //   加速(920)后到达点由 10019 边沿更新到 marchInfo.marchArrive（state 不变），归一化后快照读它即拿到加速后的新到达。
  var timeSrc = mi || rawEntry;
  var marchStartTime = firstTime(timeSrc.marchStartTime, rawEntry.marchStartTime);
  var marchArrive = firstTime(timeSrc.marchArrive, rawEntry.marchArrive);
  var returnArriveTime = firstTime(timeSrc.returnArriveTime, rawEntry.returnArriveTime);
  return {
    id: id,
    type: type,
    state: state,
    stateName: STATE_NAME[state] || '',
    isOccupying: state !== State.RETURNING && state !== State.ARRIVED_HOME,
    target: { x: x, y: y, itemId: itemId, targetType: targetType },
    marchStartTime: marchStartTime,
    marchArrive: marchArrive,
    returnArriveTime: returnArriveTime,
    raw: rawEntry,
  };
}

// ── 列表（856 权威读，区分「读不到」与「确实 0 条」） ────────────────────
/** @type {Promise<object[]|null>|null} 同 tick 并发去重：复用在途 Promise（null=读不到，[]=确认无行军） */
var _listInflight = null;

/**
 * 856 权威读的内部实现：区分「确认结果」与「读不到」，list()/_refresh 共用同一在途 Promise。
 * 成功（含确认 0 条）→ March[]；读不到（net 缺/超时/被拒/结构异常）→ null。
 * 与 storage.js「未就绪读 reject 而非返回 null」同源：绝不把「读不到」伪装成「空」，否则快照刷新会误清空。
 * @returns {Promise<object[]|null>}
 */
function _fetch() {
  if (_listInflight) return _listInflight;
  _listInflight = (async function () {
    var n = net();
    if (!n) return null;
    var ret;
    try {
      ret = await n.send(CMD_GET_ALL_MY_MARCH_INFO, {});
    } catch (err) {
      log.debug('856 send failed. %s', err && err.message);
      return null;
    }
    if (!ret || !ret.ok) return null;
    var d = parseData(ret.data) || {};
    var arr = Array.isArray(d.marches) ? d.marches : Array.isArray(d.ret) ? d.ret : null;
    if (!Array.isArray(arr)) return null;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var m = decode(arr[i]);
      if (m && m.id) out.push(m);
    }
    return out;
  })();
  // Promise 落定即释放，下 tick 重新打 856
  _listInflight.then(
    function () {
      _listInflight = null;
    },
    function () {
      _listInflight = null;
    },
  );
  return _listInflight;
}

/**
 * 取本人全部行军（归一化 March[]，视口无关，Home 亦全量）。唯一对外读入口。
 * @param {{cache?:boolean}} [opt] 默认 false：每次打权威 856（写决策类逐事件用），成功后 write-through 喂快照；
 *   {cache:true}：读内存快照（供热路径 floatcar），冷启动/超 TTL 时 await 一次刷新播种，稳态零网络、由常驻 10019 边沿实时维护。
 * 失败（net 缺/超时/结构异常）默认路回 []（调用方「未知不拦」；需区分读不到 vs 确认空用内部 _fetch()）。
 * @returns {Promise<object[]>} March[]
 */
async function list(opt) {
  if (opt && opt.cache === true) return _cached();
  var fresh = await _fetch();
  _seed(fresh); // write-through：仅成功（fresh!==null）时替换快照，失败保留旧快照
  return fresh || [];
}

/**
 * 按 id 取单条行军（打一次 list 后本地筛，同 tick 复用 list 的在途 Promise）。
 * @param {string|number} id marchId
 * @returns {Promise<object|null>} March 或 null
 */
async function byId(id) {
  if (id == null || id === '') return null;
  var key = String(id);
  var ms = await list();
  for (var i = 0; i < ms.length; i++) if (ms[i].id === key) return ms[i];
  return null;
}

// ── 名额（同步读 UserData，服务端跨场景可靠）──────────────────────
/**
 * 当前空闲行军名额 = myMarchNumMAX - myMarchNum（读 UserData，跨场景可靠）。
 * 跨 feat 名额协调不再走预约账本：发射井↔auto-farm 的争抢改由「发射井撤田腾位 + 抢回城空窗期快路径补驻」收敛。
 * @returns {number} 空闲槽数（数据源缺失按 0 计）
 */
function freeSlots() {
  var c = gameData.marchCount();
  return (c.max | 0) - (c.used | 0);
}

/**
 * 是否还能派 n 条行军（默认 1）。
 * @param {number} [n=1] 需要的名额
 * @returns {boolean}
 */
function canMarch(n) {
  return freeSlots() >= (n == null ? 1 : n | 0);
}

// ── 发 / 撤 / 加速（marchType 外部传入，返回 net.Ret，永不 reject） ─────
/**
 * 发一条世界地图行军（902）。组 canonical body → isSending(902) 去重 → net.send → catch→Ret。
 * marchType 由调用方备好后传入（含跨服漂移结果）；data 为 Battle().build() 的 MarchData（5 字段）。
 * @param {{marchType:number, target:{x:number,y:number}, data:object}} opt 行军参数
 * @returns {Promise<object>} net.Ret（异常/在途回落 code=NOT_SENT）
 */
async function attack(opt) {
  opt = opt || {};
  var d = opt.data || {};
  var target = opt.target || {};
  var body = {
    marchType: opt.marchType,
    x: target.x,
    y: target.y,
    armyList: d.armyListNew,
    armyListNew: d.armyListNew,
    heroList: d.heroList,
    trapList: d.trapList,
    break: 0,
    formation: 0,
    formationV2: d.formationV2,
    extraArmy: d.extraArmy,
  };
  var n = net();
  if (!n) return fallbackRet();
  if (n.isSending(CMD_MARCH_WORLD_POINT)) return notSentRet();
  try {
    return await n.send(CMD_MARCH_WORLD_POINT, body);
  } catch (err) {
    log.warn('902 send error. x=%s;y=%s', target.x, target.y, err);
    return notSentRet();
  }
}

/**
 * 发一条「零部队」行军（902，不带兵）：空投拾取/资源挖矿/花车/宝藏这类无编队派遣。
 * 与 attack 的区别：不组 Battle MarchData，不带 break/formation/formationV2/extraArmy 编队字段。
 * 两种真机 body 由 ext 切换（保持与各 feat 录制报文逐键一致，勿合并）：
 *   - 不传 ext → 三键 `{marchType,x,y}`（海上夺宝 178 / 花车 getType 真机口径）；
 *   - 传 ext（含空对象 {}）→ 九键 `{marchType,x,y,armyList:[],armyListNew:[],heroList:[],trapList:[],ext}`（领域寻宝挖矿 180 / 泰坦祝福）。
 * bodyExtra：三键分支的「活动专属顶层标记键」透传（重装母舰 189 实证多带 `isAirCraftCarrier:true`）；不传时逐键与旧行为一致，
 *   九键分支不受影响（floatcar / sea-treasure / domain-treasure / titan-blessing 四个消费者零改动）。
 * 不内置 isSending(902)：零部队拾取的频控/限流门留各 feat（drain 单飞 / retryMs / march_time_control 各异）。
 * 永不 reject：net 缺/发送异常回 Ret(NOT_SENT)。
 * @param {{marchType:number, target:{x:number,y:number}, ext?:object, bodyExtra?:object}} opt 行军参数（target 兼容 pointX/pointY）
 * @returns {Promise<object>} net.Ret
 */
async function pickUp(opt) {
  opt = opt || {};
  var t = opt.target || {};
  var marchType = opt.marchType | 0;
  var x = t.x != null ? t.x : t.pointX;
  var y = t.y != null ? t.y : t.pointY;
  var n = net();
  if (!n) return fallbackRet();
  var body;
  if (opt.ext) {
    body = {
      marchType: marchType,
      x: x,
      y: y,
      armyList: [],
      armyListNew: [],
      heroList: [],
      trapList: [],
      ext: opt.ext,
    };
  } else {
    body = { marchType: marchType, x: x, y: y };
    if (opt.bodyExtra && typeof opt.bodyExtra === 'object') Object.assign(body, opt.bodyExtra);
  }
  try {
    return await n.send(CMD_MARCH_WORLD_POINT, body);
  } catch (err) {
    log.warn('902 pickUp error. marchType=%d;x=%s;y=%s', marchType, x, y, err);
    return notSentRet();
  }
}

/**
 * 撤回一条行军（904 {marchId}）。永不 reject；乐观记返程等业务态仍由调用方自持（如 launch-silo pendingRecall）。
 * @param {string|number} marchId 行军 id
 * @returns {Promise<object>} net.Ret
 */
async function recall(marchId) {
  var n = net();
  if (!n) return fallbackRet();
  try {
    return await n.send(CMD_RECALL_MARCH, { marchId: marchId });
  } catch (err) {
    log.warn('904 recall error. marchId=%s', marchId, err);
    return notSentRet();
  }
}

/**
 * 加速一条在途行军（920）。实证报文（dashcam 20261005T204748）：req {marchId:str, itemId:number} → resp {s:0,d:"{}"}（成功空载荷）。
 * 道具削减比（报文实测同一行军 68s→普通 −16s、−16s→高级 −24s，均对「当时剩余时间」生效）：
 *   - 普通 520001：行军剩余时间缩短 25%（剩 75%）；
 *   - 高级 520002：行军剩余时间缩短 50%（剩 50%）。
 * 加速后的新到达通过一条 10019 边沿下发（state 不变、仍 MARCHING），marchInfo.marchArrive 即新到达点；
 *   本模块快照经 _cacheApply 采用新值，故 list({cache:true}) 读到的是加速后的到达，同态不触发 onStateChange（非生命周期跃迁）。
 * 道具选择：缺省用普通加速（ITEM_SPEED_UP_NORMAL）；传 {advanced:true} 用高级；或直接 {itemId} 指定任意加速道具。
 * 永不 reject：net 缺/发送异常回 Ret(NOT_SENT)。
 * @param {string|number} marchId 行军 id
 * @param {{advanced?:boolean, itemId?:number}} [opt] 道具选择
 * @returns {Promise<object>} net.Ret
 */
async function speedUp(marchId, opt) {
  opt = opt || {};
  var itemId =
    opt.itemId != null
      ? opt.itemId | 0
      : opt.advanced
        ? ITEM_SPEED_UP_ADVANCED
        : ITEM_SPEED_UP_NORMAL;
  var n = net();
  if (!n) return fallbackRet();
  try {
    return await n.send(CMD_MARCH_SPEED_UP, { marchId: marchId, itemId: itemId });
  } catch (err) {
    log.warn('920 speedUp error. marchId=%s;itemId=%d', marchId, itemId, err);
    return notSentRet();
  }
}

// ── 生命周期（全局单点常驻 10019 → 边沿检测 → 内部复播） ────────────────
/** @type {Set<{cb:Function,to:number|null}>} onStateChange 订阅集 */
var _stateSubs = new Set();
/** @type {Map<string,object>} id → 上次已知 March（边沿比对基线） */
var _known = new Map();

/** 10019 推送处理：解码 → 同步进快照缓存 → 与上次已知态比对 → 仅状态边沿迁移时复播；到家后清基线防内存涨 */
function _onPush(ev) {
  var m = decode(ev && ev.data);
  if (!m || !m.id) return;
  _cacheApply(m);
  var prev = _known.get(m.id);
  _known.set(m.id, m);
  if (prev && prev.state !== m.state) {
    for (var sub of [..._stateSubs]) {
      if (sub.to != null && m.state !== sub.to) continue;
      try {
        sub.cb(m, prev);
      } catch (err) {
        log.warn('march state listener threw', err);
      }
    }
  }
  if (m.state === State.ARRIVED_HOME) _known.delete(m.id);
}

/**
 * 订阅行军状态边沿迁移（10019 全局单点复播）。回调收纯数据 March。
 * feat 责任：回调内自判 alive、按 m.type 过滤本玩法、自持节流（march.js 不代管）。
 * @param {function(object, object=):void} cb (m:March, prev?:March)
 * @param {{to?:number}} [opt] 只关心迁移到该 state 时传 {to:State.*}
 * @returns {Function} off（feat 需在卸载/重挂前调用防重激活重复注册）
 */
function onStateChange(cb, opt) {
  if (typeof cb !== 'function') return function () {};
  var to = opt && typeof opt.to === 'number' ? opt.to : null;
  var sub = { cb: cb, to: to };
  _stateSubs.add(sub);
  return function off() {
    _stateSubs.delete(sub);
  };
}

/**
 * onStateChange 糖：仅关心「部队到家(ARRIVED_HOME)」边沿。
 * @param {function(object, object=):void} cb (m:March, prev?:March)
 * @returns {Function} off
 */
function onHomeReturn(cb) {
  return onStateChange(cb, { to: State.ARRIVED_HOME });
}

// ── 快照（list({cache:true}) 的后端；856 播种 + 10019 边沿实时维护 + TTL 兑底刷新） ──
/** @type {Map<string,object>} id → March（本人全量在途视图，与 list() 同归一化形状） */
var _cache = new Map();
/** @type {number} 上次成功 856 全量播种的本地时刻（ms）；0=从未 */
var _lastSync = 0;
/** @type {number} 上次发起 856 刷新的时刻（ms）：失败也推进，兑住 outage 下的重试频率 */
var _lastAttempt = 0;
/** @type {Promise<void>|null} 刷新在飞闸门：并发合流，只发一条 */
var _syncing = null;
/**
 * 快照兑底重同步的最小间隔（ms）：10019 边沿提供实时更新，靠它周期清幽灵/补漏推，并节流失败重试。
 * 调小更准但 856 更密；调大更省但新行军计入名额延迟更大（floatcar 自有 dispatched 集 + 服务端 world_130516 兑底）。
 */
const SNAPSHOT_TTL_MS = 8000;

/**
 * 将一条 10019 边沿同步进快照：到家(ARRIVED_HOME)删除；其余 upsert。
 * 防御：若推送只带状态增量（坐标缺省解为 0,0 / 时刻缺省解为 0）而缓存已有更富条目，则保留旧坐标/type/时刻。
 *   注意加速(920)后的 10019 带全新 marchArrive(>0)：新值 >0 时直接采用（覆盖为加速后的新到达），
 *   只有新值解为 0（增量推送未带时刻）才回退保留旧值，绝不把加速后的更早到达又冲掉。
 * @param {object} m decode() 产出的 March
 */
function _cacheApply(m) {
  if (!m || !m.id) return;
  if (m.state === State.ARRIVED_HOME) {
    _cache.delete(m.id);
    return;
  }
  var prev = _cache.get(m.id);
  if (prev) {
    if ((!m.target || (m.target.x === 0 && m.target.y === 0)) && prev.target)
      m.target = prev.target;
    if (!m.type && prev.type) m.type = prev.type;
    if (!(m.marchArrive > 0) && prev.marchArrive > 0) m.marchArrive = prev.marchArrive;
    if (!(m.marchStartTime > 0) && prev.marchStartTime > 0) m.marchStartTime = prev.marchStartTime;
    if (!(m.returnArriveTime > 0) && prev.returnArriveTime > 0)
      m.returnArriveTime = prev.returnArriveTime;
  }
  _cache.set(m.id, m);
}

/**
 * 用一次权威读结果 wholesale 替换快照（自动清幽灵）。arr 为 null（读不到）时保留旧快照、不重置 _lastSync。
 * @param {object[]|null} arr _fetch() 结果
 */
function _seed(arr) {
  if (!arr) return;
  _cache.clear();
  for (var i = 0; i < arr.length; i++) {
    var m = arr[i];
    if (m && m.id) _cache.set(m.id, m);
  }
  _lastSync = Date.now();
}

/** 快照是否需重同步：有新鲜数据(false)；否则距上次尝试≥TTL 才再打(true)——失败也按 TTL 节流。 */
function _stale() {
  var now = Date.now();
  if (_lastSync && now - _lastSync <= SNAPSHOT_TTL_MS) return false;
  return !(_lastAttempt && now - _lastAttempt < SNAPSHOT_TTL_MS);
}

/** 打一次 856 刷新快照（成功才 _seed）。并发合流复用在飞 Promise；永不 reject。 */
function _refresh() {
  if (_syncing) return _syncing;
  _lastAttempt = Date.now();
  _syncing = (async function () {
    try {
      _seed(await _fetch());
    } finally {
      _syncing = null;
    }
  })();
  return _syncing;
}

/**
 * 快照读（list({cache:true}) 后端）：需重同步时 await 一次刷新（冷启动即播种，优于旧 fire-and-forget），否则零网络。
 * @returns {Promise<object[]>} March 数组（本人全量在途；不保证强一致：边沿实时更新 + TTL 兑底）
 */
async function _cached() {
  if (_stale()) await _refresh();
  else if (_syncing) await _syncing;
  var out = [];
  for (var m of _cache.values()) out.push(m);
  return out;
}

// 模块加载即挂一条常驻 10019（全局单点，非 ctx 级、非引用计数）；dispatch 懒构造据此判 net.10019 有人订阅
bus.on('net.' + CMD_USER_MARCH_INFO, _onPush);

/** 行军统一抽象单例 */
export const march = {
  State,
  NOT_SENT,
  ITEM_SPEED_UP_NORMAL,
  ITEM_SPEED_UP_ADVANCED,
  isOccupying,
  decode,
  list,
  byId,
  freeSlots,
  canMarch,
  attack,
  pickUp,
  recall,
  speedUp,
  onStateChange,
  onHomeReturn,
};
