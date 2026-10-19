/**
 * 花车空投-事件时间轮 + 活动组名额闸（reactor 说明书形态）
 *
 * 架构一句话：只留一个全局定时器——**最小堆事件时间轮**按"下一个事件时刻"精确跳变，
 * 不再每秒扫 flows；每个事件（probe/pickup/slotFree/reconcile）只存意图不存结论，
 * 触发时刻重新验证一切前提（8852 重查、名额实时枚举），过期事件由 guard 自然作废（惰性失效）。
 *
 * 探测与领取（沿用已实证的节奏事实，详见下方"流程状态机"）：
 *   probe(k) 到点定向 8852 问"这台车现在能领哪箱"；命中新箱 → 先看**同类型（getType）拾取行军名额**：
 *   有名额 → 入堆 pickup（条间 ≥1s 防 902 限流）；无名额 → 入 pending，按 nextReleaseAt 迭代打点
 *   slotFree = 最早可能释放时刻 + 安全垫（出发段行军只能按 marchArrive 先醒一次，醒来若已被返程
 *   push 合并出 returnArriveTime 再按其重排——打点只决定"何时醒"，实时枚举决定"能不能派"）。
 *   拍内真空按阶梯 +3s/+6s 补查（吸收落地抖动），替代旧带宽 Y 的每秒连查。
 *
 * 失败路由（名额语义定稿：活动组队列 per-type 上限恒 5，与战斗组 canMarch 名额互不占用）：
 *   队满 world_130516 = "行军根本没发出"，箱保留（实证 8852 仍返回该箱）→ 退回 pending 等 slotFree 重排；
 *   当日上限 mysterioustriangle_10 = 原箱不再返回（实证）→ 类型级当日熔断弃轮。
 *   pending 重排只对"回空"撤项：8852 每次只回一个当前可领箱，回的是别的坐标时按住项原样回队等腾位，
 *   不级联撤堆（否则拍网格已推进、再也探不到它们）；有按住项时末拍不收摊，pending 寿命由窗口硬止兜底。
 *   257 不占战斗组行军位（活动组行军在 push 入口被改写 uid=uid+marchId、不计 myMarchNum），
 *   但占活动组自己的队列位——名额闸把"撞墙才知道"变成"派遣前就知道"。
 *
 * ⚠️ marchId 是 64 位雪花 id（真机样本 4857138598478209026 > 2^53），任何 Number() 转换都会静默丢精度、
 *   把查询打到别的行军上——全链路只以 string 传递（8852 请求体的字段名本身就是 marchIdStr）。
 *   游戏还会把活动行军的 uid 改写成 `uid+marchId` 字符串，所以按 marchId 对账在途行军要用它判等。
 *
 * 网络一律走 promise 封装 window.pocketcc.net：send/sendPBV2(cmd, data) → Promise<Ret{code,data,ok}>。
 * 三条协议铁律（target=null、ensureServerResponse=false、无 clickInfo）由 net 封装内部固定，这里不再关心。
 * 8852 应答：net 封装已剥到内层，ret.data 就是 {x,y}；"无箱"有两种服务器口径（s!=0 被拒 / s=0 但 {x:0,y:0}）。
 * 902 应答：受理时回整份 marchInfo（字符串 marchId + marchStartTime/marchArrive；返程两字段此刻必为 0，
 *   要到回城 push 合并进游戏行军对象后才有值——这正是释放打点只能"迭代精化"、不能一次算死的原因）。
 *
 * 生命周期由 reactor 托管：install/run 两个钩子（无可调面板项，故不写 configure），places 门控限定 base/world（Home/NWorldMap）。
 *   run 挂 newChatPush 监听；pause 摘监听、alive()=false 让堆事件与在飞流程自然收手，flows/pending 表保留，resume 续跑。
 * 类型级当日熔断：某类花车的 902 回 `mysterioustriangle_10`（今日剩余次数不足）即记该类"今日已满"，
 *   当场收掉同类型全部流程 + 滤掉同类型待派项，后续该类型的发车卡不再建流程（跨类型互不影响，跨日自动失效）。
 * 被拒退避："目标被占/限流"类拒绝按指数退避再试（队满与上限各有专路、不走这里），否则会被拒的坐标每秒重派一遍。
 */
import { createLog } from '../../core/log.js';
import { game } from '../../core/game.js';
import { reactor } from '../../core/reactor.js';
import { l10n } from '../../core/game-api.js';
import { payloadOf } from '../../core/net-payload.js';
import { march } from '../../core/march.js';
import { item } from '../../core/item.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=FLOAT_CAR） */
const log = createLog('FLOAT_CAR');

/** @type {number} NRequestIdV2.FLOAT_PARADE_QUERY_CAN_REWARD_BAG，req {queryType:1, marchType:dropType[, marchIdStr]} → resp data={x,y} */
const CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG = 8852;

/** @type {number} ChatShareLinkType.PARADE_FLOAT_MARCH_SHARE，花车行军分享卡（llm.t），卡片只带 marchId + expirationTime，不带坐标 */
const SHARE_LINK_PARADE_FLOAT_MARCH = 38;

/** @type {number} 非服务器返回的哨兵 code：发送异常时用，与真实 s 码区分开 */
const CODE_NOT_SENT = -1;

/** @type {number} 每箱摊到的窗口秒数：真机三点吻合（1 箱=180s / 2 箱=360s / 8 箱=1440s） */
const BOX_WINDOW_SEC = 180;

/** @type {number} 卡片没给 expirationTime（或没给 t）时的兜底窗口长度：180 秒 = 单箱车 */
const DEFAULT_LIFE_MS = 1000 * BOX_WINDOW_SEC;

/**
 * 902 拒绝载荷里"该花车类型今日领取次数已用完"的文案键（字典表：mysterioustriangle_10=今日剩余次数不足）。
 * ⚠️ 这一族键是服务端**跨活动复用**的（同族 _01 属"神秘三角"抽奖），所以：
 * ① 只认这个精确键，其它拒绝（目标被占 / 发得太密）一律不当作上限；
 * ② 只认它出现在**本类型自己那支拾取行军的 902** 上——发车、空查、收摊都不构成上限证据
 * （每箱只有 20 次、先到先得，抢不过别人时也是 0 收获，但那不是上限）
 */
const ERR_FLOAT_DAILY_LIMIT = 'mysterioustriangle_10';

/**
 * 902 拒绝载荷里"行军队列已满"的文案键（world_130516，真机实证报文 status=3 载荷原文）。
 * ⚠️ 这个键在客户端被**跨场景复用**（战斗队满闸门也弹它），所以只认它出现在**本模块自己发出的
 * 拾取 902 的拒绝应答**上；也不进 rejects 汇总/熔断通道——队满在服务器语义里是"行军根本没发出"，
 * 箱保留、8852 仍返回（用户实证），等腾位重派即可，不构成类型级上限证据。
 */
const ERR_QUEUE_FULL = 'world_130516';

/**
 * 902 拒绝载荷里"发得太频繁"的限流文案键（march_time_control_info001）：走 per-key 指数退避专路。
 */
const ERR_RATE_LIMIT = 'march_time_control_info001';

/**
 * 花车活动配置表：DROP（投放/查询用）与 GET（派遣用）是**配对关系**，必须成对写死。
 * 源码里三组恰好都是 +1（256/257 芯片祝福、285/286 圣诞弹珠、287/288 新年弹珠），
 * 但那是命名约定不是推导依据，禁止写成 dropType + 1。
 * @type {object[]}
 */
const FLOATS = [
  { id: 'CHIP_BLESSING', label: '芯片祝福', dropType: 256, getType: 257 },
  { id: 'NEWYEAR2026_PINBALL', label: '2026新年弹珠', dropType: 287, getType: 288 },
];

/** @type {Object<number,object>} dropType → 配置项；聊天卡 extra.marchType 与 8852 请求都只认 DROP 值，故以它建索引 */
const FLOAT_BY_DROP = {};
for (var i = 0; i < FLOATS.length; i++) FLOAT_BY_DROP[FLOATS[i].dropType] = FLOATS[i];

/** @type {Object<number,boolean>} getType 集合副本：MarchTools 符号缺失时的活动行军归属回退判据 */
var GET_TYPE_FALLBACK = {};
for (var g = 0; g < FLOATS.length; g++) GET_TYPE_FALLBACK[FLOATS[g].getType] = true;

/**
 * 内置调优常量（面板只出启用开关，不暴露这些）
 * @type {object}
 */
const cfg = {
  /**
   * F 首箱延迟：收到发车卡（= 瓦片 startSecsTime = 服务器 t）之后 30 秒才投第一箱
   */
  firstBoxDelayMs: 1000 * 30,

  /**
   * P 每箱周期：相邻两箱落地间隔（= 窗口秒数 ÷ 箱数，真机 30 秒/箱）
   */
  boxPeriodMs: 1000 * 30,

  /**
   * L 提前开探量：相对每箱落地时刻提前多久开始问（吸收服务器与客户端的时间抖动）
   */
  probeLeadMs: 1000 * 2,

  /**
   * 拍内阶梯：相对第 k 箱落地打点的首查 + 补查偏移（吸收落地抖动），替代旧带宽 Y 的每秒连查；
   * 末级仍真空才结算为 miss 拍
   */
  probeLadderMs: [0, 3000, 6000],

  /**
   * M 停止阈值：连续这么多拍"真·空"（既没新箱也没被已派箱遮蔽）就判定这台车没有我能领的箱了。
   * 取 3 不取 1：拍窗口是刚性网格，服务器某箱晚落几秒就会错过一拍，M≥2 才有容错；
   * 已派箱数达到卡片推算值后本阈值自动降为 1（见 stopThreshold），8 箱车实测可省掉尾部几拍
   */
  emptyPeriodStop: 3,

  /**
   * driver 步长封顶：定时器睡到下一个事件时刻，但不超过此值——对账保底醒（真机日志按它估在途名额用的
   * 枚举判据若有边缘情况，最坏延迟一个封顶自愈）；后台节流下浏览器本就把定时器钳到 ≥1s，同阶无需特判
   */
  tickMs: 1000,

  /**
   * 活动组拾取行军队列上限，**按活动类型（getType）各自计数**（用户定稿：恒为 5）。
   * 若真机埋点显示单 type 在途 <5 仍撞 world_130516，即为跨类型共享池证据——只改 myActiveMarches
   * 的过滤器范围（放开成全体 ACT_MARCHS），闸结构不变
   */
  actQueueCap: 5,

  /**
   * slotFree 唤醒安全垫：服务器名额释放与客户端可见之间隔着 push 合并与渲染收尾（NMARCH_ENDTIME_DELAY=1s 一族），
   * 到点早醒只会多一次空枚举，晚醒才丢吞吐，故取 1.5s 偏保守
   */
  slotFreeMarginMs: 1500,

  /**
   * 释放时刻字段全缺（行军对象上没有 marchArrive/returnArriveTime）时的退化轮询间隔
   */
  slotFreePollMs: 1000 * 5,

  /**
   * 派遣重试间隔：请求发出到下次重试的最小间隔（error 兜底重排、pickup 条间下限也用它）
   */
  retryMs: 1000,

  /**
   * E 前终查提前量：reconcile 事件在窗口硬止前这么久做最后一次 8852，替代旧 tailConfirmed 就地闭合逻辑
   */
  tailCheckLeadMs: 1000 * 10,

  /**
   * 同一坐标被拒后的重试退避基数：第 n 次被拒后等 base × 2^(n-1)（封顶 rejectBackoffMaxMs）再派。
   * 没退避时回放实测：一个整窗不消失的拒绝会让同一坐标撞 151 次 902；而限流类拒绝（march_time_control_info001=操作太频繁）
   * 最怕的正是打得更密。退避到封顶后每 60 秒试一次，既不给服务器加压也不会错过恢复时机
   */
  rejectBackoffBaseMs: 1000 * 5,

  /**
   * 重试退避封顶
   */
  rejectBackoffMaxMs: 1000 * 60,
};

/** @type {object|null} 网络底座（promise 封装 pocketcc.net） */
var net;
/** @type {object|null} 数据中心（DATA.ServerTime 秒） */
var dataCenter;
/** @type {object|null} MarchTools.ACT_MARCHS 命名导出（活动行军归属判据）；缺失回退 GET_TYPE_FALLBACK */
var actMarchs = null;

/**
 * 行军加速目标（秒）：面板可让用户指定「把拾取行军加速到剩余 ≤ 多少秒」。
 * 0 = 不加速（缺省，行为与旧版一致）。由 reactor.configure 从面板配置注入。
 * 语义见 maybeAccelerate：剩余 ≤ 该目标即不消耗道具；否则用能达标的最温和一支（先普通 25%、不够再高级 50%）。
 * @type {number}
 */
var accelTargetSec = 0;

/**
 * 是否启用行军加速（面板勾选项 accelEnabled）。缺省 false=不启用；与 accelTargetSec>0 共同作为加速触发闸。
 * @type {boolean}
 */
var accelEnabled = false;

/** @type {object|null} reactor 注入的上下文；alive() 反映运行态，pause 后置否让堆事件与在飞流程自然收手 */
var ctxRef = null;

/** @type {Map<string,object>} 活跃探测流程：marchIdStr → flow */
var flows = new Map();

/** @type {number} 流程代际计数器：每条 flow 赋唯一 uid 并带进事件载荷——同 marchId 收摊后重建时，旧代际事件由 uid 判串台丢弃 */
var FLOW_UID_SEQ = 0;

/** @type {Set<string>} 已见过的 8852 "无箱"文案键（全局而非每流程：每拍首查必空，按车去重会把 info 刷成 debug 的量） */
var seenEmptyKeys = new Set();

/**
 * @type {Map<string,string>} floatId → 被服务器判为"今日已满"的日期。
 * 上限是**按花车类型各自计**的（现每类 10 次），跨类型不共用，故按类型记账。
 * 故意不落盘（口径同 alliance-help）：刷新页面后同类型第一台车会再撞一次（约 12 次查询 + 1 支必被拒的行军），
 * 换来的是"绝不因为一条脏记录整天停摆"
 */
var capReachedOn = new Map();

/**
 * @type {object[]} 无名额时的按住区（[{flow,marchId,key,x,y,getType,queuedAt}]，pause 保留、恢复续跑）。
 * 队满被拒 / 探到箱但同类型已满都进这里，等 slotFree 到点重查重派；flow 收摊或类型熔断时同步清除。
 */
var pendingPickups = [];

/** @type {Set<number>} 已排了 slotFree 事件的 getType（去重，避免同一类型堆一串腾位唤醒） */
var slotFreeScheduled = new Set();

/** @type {object} 事件最小堆（模块级单例，见 EventHeap 段） */
var heap = createEventHeap();

/** @type {number} 全局 pickup 串行闸门：上一条 902 发出时刻，条间 ≥cfg.retryMs 防限流 */
var lastPickupAt = 0;

/** @type {number|null} 唯一 driver 定时器（睡到堆顶事件时刻，封顶 tickMs；pause/堆空即熄火） */
var driverTimer = null;

/** @type {number} 下一次 driver 唤醒的目标本地时刻（bump 判是否需提前重排用） */
var driverWakeAt = 0;

/** @type {boolean} install 幂等守卫 */
var installed = false;

/**
 * 功能是否仍在运行（driver 与在飞流程的存活判定）
 * @returns {boolean}
 */
function aliveFn() {
  return ctxRef ? ctxRef.alive() : false;
}

/* ------------------------------------------------------------------ *
 * EventHeap：二叉最小堆（事件时间轮）
 *   事件 = {atMs, kind, flowId, payload, seq}，键序 atMs 升 → 同刻按 kind 优先级 → seq 稳定。
 *   优先级 slotFree(0) ≥ pickup(1) > reconcile(2) > probe(3)：先腾位、有箱先发、终查在采点前。
 *   惰性失效：弹出后过 passGuard，过期事件直接丢，不做精确删除。
 * ------------------------------------------------------------------ */

/** @type {Object<string,number>} kind → 同刻执行优先级（小者先） */
var KIND_PRIO = { slotFree: 0, pickup: 1, reconcile: 2, probe: 3 };

/**
 * 建一个二叉最小堆（比较器：atMs → KIND_PRIO → seq）
 * @returns {{push:function,peek:function():object|null,pop:function():object|null,size:function():number}}
 */
function createEventHeap() {
  /** @type {object[]} */
  var a = [];
  /** @type {number} 插入序号（同刻稳定排序） */
  var seq = 0;

  /**
   * 比较两个事件：负数表示 x 应先出
   * @param {object} x 事件
   * @param {object} y 事件
   * @returns {number}
   */
  function less(x, y) {
    if (x.atMs !== y.atMs) return x.atMs - y.atMs;
    var d = (KIND_PRIO[x.kind] || 9) - (KIND_PRIO[y.kind] || 9);
    return d !== 0 ? d : x.seq - y.seq;
  }

  /**
   * 上浮
   * @param {number} idx 待上浮下标
   */
  function siftUp(idx) {
    while (idx > 0) {
      var parent = (idx - 1) >> 1;
      if (less(a[idx], a[parent]) < 0) {
        var t = a[parent];
        a[parent] = a[idx];
        a[idx] = t;
        idx = parent;
      } else break;
    }
  }

  /**
   * 下沉
   * @param {number} idx 待下沉下标
   */
  function siftDown(idx) {
    var n = a.length;
    while (true) {
      var l = idx * 2 + 1,
        r = l + 1,
        smallest = idx;
      if (l < n && less(a[l], a[smallest]) < 0) smallest = l;
      if (r < n && less(a[r], a[smallest]) < 0) smallest = r;
      if (smallest === idx) break;
      var t = a[idx];
      a[idx] = a[smallest];
      a[smallest] = t;
      idx = smallest;
    }
  }

  return {
    /**
     * 入堆一个事件（自动补 seq）
     * @param {object} ev {atMs,kind,flowId,payload}
     */
    push: function (ev) {
      ev.seq = ++seq;
      a.push(ev);
      siftUp(a.length - 1);
    },
    /** @returns {object|null} 堆顶（不弹出） */
    peek: function () {
      return a.length ? a[0] : null;
    },
    /** @returns {object|null} 弹出堆顶 */
    pop: function () {
      if (!a.length) return null;
      var top = a[0];
      var last = a.pop();
      if (a.length) {
        a[0] = last;
        siftDown(0);
      }
      return top;
    },
    /** @returns {number} 当前事件数 */
    size: function () {
      return a.length;
    },
  };
}

/**
 * 入堆一个事件并择机重排 driver（若它比当前唤醒更早）
 * @param {number} atMs 目标本地时刻（ms）
 * @param {string} kind 事件类型
 * @param {string|null} flowId 归属流程（slotFree 传 null）
 * @param {object} payload 事件载荷
 */
function pushEvent(atMs, kind, flowId, payload) {
  heap.push({ atMs: atMs, kind: kind, flowId: flowId, payload: payload });
  bumpDriver();
}

/* ------------------------------------------------------------------ *
 * Driver：唯一定时器，睡到堆顶事件时刻（封顶 tickMs），到点批量弹出到期事件按序执行后重排。
 *   pause 不重排；resume 由 run() 重新点火，陈旧事件由 passGuard 自然作废；堆空熄火。
 * ------------------------------------------------------------------ */

/**
 * driver 点火：堆非空且未在跑就排一次。重复调用 no-op
 */
function startDriver() {
  if (driverTimer != null || !heap.size()) return;
  scheduleDriver();
}

/**
 * driver 熄火：清唯一定时器
 */
function stopDriver() {
  if (driverTimer == null) return;
  clearTimeout(driverTimer);
  driverTimer = null;
}

/**
 * 排下一次唤醒：睡到 (堆顶.atMs − now)，但不超过 tickMs（保底醒）；堆空/pause 即熄火
 */
function scheduleDriver() {
  if (driverTimer != null) {
    clearTimeout(driverTimer);
    driverTimer = null;
  }
  if (!aliveFn() || !heap.size()) return;
  var now = Date.now();
  var delta = Math.min(Math.max(0, heap.peek().atMs - now), cfg.tickMs);
  driverWakeAt = now + delta;
  driverTimer = setTimeout(onDriverWake, delta);
}

/**
 * 事件入堆后择机重排：仅当新堆顶比当前唤醒更早才重启定时器（避免 async 回调高频 push 抖动饿死唤醒）
 */
function bumpDriver() {
  if (!heap.size()) return;
  if (driverTimer == null) {
    startDriver();
    return;
  }
  if (heap.peek().atMs < driverWakeAt) scheduleDriver();
}

/**
 * 到点批量弹出全部到期事件，逐个过 guard 后 dispatch；然后重排
 */
function onDriverWake() {
  driverTimer = null;
  if (!aliveFn()) return; // pause：堆原地保留，resume 时 run() 重新点火
  var now = Date.now();
  while (heap.size() && heap.peek().atMs <= now) {
    var ev = heap.pop();
    if (!passGuard(ev, now)) continue;
    dispatch(ev);
  }
  scheduleDriver();
}

/**
 * 事件弹出前的 guard（惰性失效）：过期/归属丢失即丢事件
 * @param {object} ev 事件
 * @param {number} now 当前本地 ms
 * @returns {boolean} 是否仍需执行
 */
function passGuard(ev, now) {
  if (!aliveFn()) return false;
  if (ev.kind === 'slotFree') return true; // 全局腾位事件：只判 alive，pending 在 handler 内再筛
  var f = flows.get(ev.flowId);
  if (!f) return false;
  if (ev.kind === 'reconcile') return true; // tail 在 E 前、expire 恰在 E，都由 handler 自校验窗口
  return now < f.E; // probe / pickup 只在窗口内有效
}

/**
 * 把一个到期事件路由到对应 handler（handler 皆 async，fire-and-forget，异常兜住）
 * @param {object} ev 事件
 */
function dispatch(ev) {
  var p;
  try {
    if (ev.kind === 'probe') p = onProbe(flows.get(ev.flowId), ev.payload);
    else if (ev.kind === 'pickup') p = onPickup(ev.payload.item);
    else if (ev.kind === 'slotFree') p = onSlotFree(ev.payload.getType);
    else if (ev.kind === 'reconcile') p = onReconcile(flows.get(ev.flowId), ev.payload);
  } catch (err) {
    log.warn('dispatch threw. kind=%s', ev.kind, err);
    return;
  }
  if (p && typeof p.catch === 'function') {
    p.catch(function (err) {
      log.warn('async handler threw. kind=%s', ev.kind, err);
    });
  }
}

/**
 * 当前服务器秒时刻（与聊天卡 t/expirationTime 同域，同源字段 DataCenter.DATA.ServerTime）；探不到回落到本地秒
 * @returns {number}
 */
function serverTimeSec() {
  var st = dataCenter && dataCenter.ServerTime;
  if (st != null && +st) return +st;
  return Date.now() / 1000;
}

/**
 * 我的在途行军列表（归一化 March[]）。走 core/march.list({cache:true}) 快照读：856 播种 + 10019 边沿实时维护 + TTL 兑底刷新，
 * 稳态零网络、视口无关、Home 亦有全量（取代旧 mapData.marches 的 Map 枚举，修 Home 读空漏计在途 → 超发/重复拾取）。
 * 快照已是本人全量，无需再按 uid 过滤（旧 isMyMarch 由此退役）。March = {id,type,state,isOccupying,target:{x,y,itemId},raw}
 * @returns {Promise<object[]>}
 */
function listMarches() {
  return march.list({ cache: true });
}

/**
 * 该坐标上是否已有我的一条 getType 行军在路上（同一目标同时只允许一支；行军回程后游戏自动清除，无需自记账）
 * @param {number} x 目标横坐标
 * @param {number} y 目标纵坐标
 * @param {number} getType 拾取行军类型
 * @returns {Promise<boolean>}
 */
async function hasMarchAtTarget(x, y, getType) {
  var marches = await listMarches();
  return marches.some(function (m) {
    // 行军字段源自 856 报文，数值/字符串口径不完全可控：保留宽松相等防类型漂移漏匹配（漏匹配=重复派兵，代价更高）
    // eslint-disable-next-line eqeqeq
    return m.type == getType && m.target.x == x && m.target.y == y;
  });
}

/* ------------------------------------------------------------------ *
 * SlotModel：活动组名额（per-type 枚举即真相，无持久账本）
 * ------------------------------------------------------------------ */

/**
 * 该 marchType 是否属活动组行军：优先读 MarchTools.ACT_MARCHS 命名导出，缺失回退 FLOATS 的 getType 副本。
 * 用存在性判定（!!actMarchs[type]）而非取快照 key 列表，以便热更新的新类型自动纳入
 * @param {number} type marchType
 * @returns {boolean}
 */
function isActivityMarch(type) {
  if (actMarchs) return !!actMarchs[type];
  return !!GET_TYPE_FALLBACK[type];
}

/**
 * 我在某 getType 上的在途/返程未归活动行军。march.list({cache:true}) 快照即真相：到家(ARRIVED_HOME)自动出表，
 * 表里存在 = 仍占活动组名额（含返程，与旧「表里存在即占位」口径一致，不按 state 再筛）。快照已本人全量。
 * @param {number} getType 拾取行军类型
 * @returns {Promise<object[]>}
 */
async function myActiveMarches(getType) {
  var marches = await listMarches();
  return marches.filter(function (m) {
    // 同 hasMarchAtTarget：行军字段口径不完全可控，保留宽松相等
    // eslint-disable-next-line eqeqeq
    return m.type == getType && isActivityMarch(m.type);
  });
}

/**
 * 某 getType 当前剩余名额 = 上限 − 在途占位（clamp ≥0）
 * @param {number} getType 拾取行军类型
 * @returns {Promise<number>}
 */
async function freeSlots(getType) {
  var marches = await myActiveMarches(getType);
  return Math.max(0, cfg.actQueueCap - marches.length);
}

/**
 * 某 getType 最早可能释放名额的本地时刻（迭代式）：逐支取 returnArriveTime>0 ? returnArriveTime
 * : (marchArrive>0 ? marchArrive : now+slotFreePoll)。出发段行军只能按 marchArrive 先醒一次；醒来若已被
 * 返程 push 合并出 returnArriveTime，下一次重排自然读到它——打点只决定何时醒，枚举决定能不能派。
 * 服务器秒域比较，整体平移入本地域
 * @param {number} getType 拾取行军类型
 * @returns {Promise<number>} 本地 ms
 */
async function nextReleaseAt(getType) {
  var marches = await myActiveMarches(getType);
  if (!marches.length) return Date.now();
  var nowSec = serverTimeSec();
  var now = Date.now();
  var min = Infinity;
  for (var i = 0; i < marches.length; i++) {
    // 读归一化时刻（decode 已从 marchInfo.* 抹平）：到家时刻优先 returnArriveTime，出发段只有 marchArrive；
    //   加速(920)后的 10019 边沿会把 marchArrive 更新为更早值（state 不变），快照读它即自然收紧腾位打点。
    //   两者都缺（旧 mapData 摊平或增量推送未带时刻）才回退 slotFreePollMs 轮询唤醒。
    var m = marches[i];
    var ra = +m.returnArriveTime,
      ma = +m.marchArrive;
    // 只采用「未来」时刻：已到点(过去值)但未并进 returnArriveTime 的行军，若直接用过去的 marchArrive
    //   会把打点排到 now → 自续排成每 slotFreeMarginMs 的紧轮询（违背本模块替代每秒连查的目标）；故过去年视同无效，回退轮询。
    var relSec = ra > nowSec ? ra : ma > nowSec ? ma : nowSec + cfg.slotFreePollMs / 1000;
    if (relSec < min) min = relSec;
  }
  if (!isFinite(min)) return now;
  return now + Math.max(0, (min - nowSec) * 1000);
}

/**
 * 排一次某 getType 的腾位唤醒（同类型只留一个在途事件；到点若仍有 pending 会自续排）
 * @param {number} getType 拾取行军类型
 */
async function scheduleSlotFree(getType) {
  if (slotFreeScheduled.has(getType)) return;
  slotFreeScheduled.add(getType);
  var at = (await nextReleaseAt(getType)) + cfg.slotFreeMarginMs;
  pushEvent(Math.max(Date.now(), at), 'slotFree', null, { getType: getType });
}

/**
 * 这条聊天推送是不是"某台花车的发车分享卡"，是则解出建流程所需的种子值。
 * 判据只用 m 以 "link" 开头 + llm.t=38 + llm.extra.marchType 命中配置表；
 * 普通位置分享卡的 llm.t=0 且带 p{x,y,z}，天然不命中（真机对照组已验）
 * @param {object} msg newChatPush 载荷（单项对象，非数组）
 * @returns {object|null} {floatId, marchId, dropType, getType, tSec, expSec} 或 null
 */
function parseParadeShare(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.m !== 'string' || msg.m.indexOf('link') !== 0) return null;
  if (msg.llm == null || msg.llm === '') return null;

  var payload = msg.llm;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (err) {
      return null;
    }
  }
  if (!payload || payload.t !== SHARE_LINK_PARADE_FLOAT_MARCH) return null;

  var extra = payload.extra;
  if (!extra) return null;
  var float = FLOAT_BY_DROP[extra.marchType];
  if (!float) return null;

  // 64 位 id 只能以 string 流转，禁止 Number()
  var marchId = extra.marchId != null && extra.marchId !== '' ? String(extra.marchId) : '';
  if (!marchId) return null;

  return {
    floatId: float.id,
    marchId: marchId,
    dropType: float.dropType,
    getType: float.getType,
    tSec: +msg.t || 0,
    expSec: +extra.expirationTime || 0,
  };
}

/**
 * 按种子建一条探测流程并算出本地锚点。
 * 时间基准只用"服务器域内的相对差"折算到本地轴，绝对时钟偏差被整个消掉：
 *   delay = ServerTime − t   → 推送在服务器侧滞留了多久（补上"push 晚到、箱已落地"）
 *   S = 本地收到时刻 − delay → 发车那一刻对应的本地时刻
 *   E = S + (exp − t)        → 窗口硬止（exp−t = 箱数×180，白送的车窗长度）
 * @param {object} seed parseParadeShare 的产出
 * @param {number} nowMs 本地收到推送的时刻
 * @returns {object} flow
 */
function newFlow(seed, nowMs) {
  var tSec = seed.tSec;
  var nowSec = serverTimeSec();
  var delaySec = tSec ? Math.max(0, nowSec - tSec) : 0;
  // exp−t = 箱数 × 180（真机 1/2/8 箱三点吻合）；缺字段或非 180 整倍时不推算，避免拿脏值当判据
  var spanSec = tSec && seed.expSec > tSec ? seed.expSec - tSec : 0;
  var lifeMs = spanSec ? spanSec * 1000 : DEFAULT_LIFE_MS;
  var expect = spanSec && spanSec % BOX_WINDOW_SEC === 0 ? spanSec / BOX_WINDOW_SEC : 0;

  return {
    /** @type {number} 流程代际号（事件载荷带它判串台） */
    uid: ++FLOW_UID_SEQ,
    marchId: seed.marchId,
    floatId: seed.floatId,
    dropType: seed.dropType,
    getType: seed.getType,
    S: nowMs - delaySec * 1000,
    E: nowMs - delaySec * 1000 + lifeMs,
    /** @type {number} 当前拍号（事件 payload.k 与它比对判陈旧） */
    k: 0,
    /** @type {boolean} 本流程是否有 8852 在飞（串行化，防同拍重复探） */
    inFlight: false,
    /** @type {number} 连续真·空拍计数（命中新箱清零；被遮蔽不动） */
    missStreak: 0,
    /** @type {number} 本流程因无名额被按住的累计次数（收摊对账用，埋点④ slotWaits） */
    slotWaits: 0,
    /** @type {Set<string>} 本流程已派出的坐标（"x,y"）；902 队满/退避时退回。size 即已拿到的唯一箱数 */
    dispatched: new Set(),
    /** @type {number} 卡片推算的箱数（0=未能推算），只用于放宽收摊阈值与事后对账 */
    expect: expect,
    /**
     * @type {number} 刚性网格末拍号：expect>0 时=expect（卡片既给了箱数，第 N 箱后就不该再有箱），
     * 否则 0（未能推算箱数，不启用提前收摊，退回纯 missStreak/E 判据）。
     * 一旦观测到实领箱数超过 expect（卡片少报），当场置 0 关掉提前收摊，退回保守逐拍——错误自灭。
     */
    lastK: expect > 0 ? expect : 0,
    /** @type {Set<string>} 本流程 902 被拒的服务器文案键（收摊时汇总，每日上限就靠它露面） */
    rejects: new Set(),
    /** @type {Map<string,{untilMs:number,tries:number}>} 被拒坐标的重试退避（key → 下次可派时刻与已试次数） */
    rejectBackoff: new Map(),
    queries: 0,
  };
}

/**
 * 本拍结算时应比对的收摊阈值：已拿下的唯一箱数达到卡片推算值后，只需 1 个真空拍确认；
 * 推算不可用（缺 t/exp 或非 180 整倍）或尚未领满时，仍按 M 拍保守停止。
 * 这里刻意用 dispatched.size（唯一坐标）而不是命中事件数：902 被拒会让同一箱再次命中，事件数会虚高
 * @param {object} flow 目标流程
 * @returns {number} 需要的连续真空拍数
 */
function stopThreshold(flow) {
  return flow.expect > 0 && flow.dispatched.size >= flow.expect ? 1 : cfg.emptyPeriodStop;
}

/**
 * 第 k 拍的首个探测事件（阶梯 idx=0），并把 flow.k 钉到 k（旧拍残留事件由此判陈旧作废）
 * @param {object} flow 目标流程
 * @param {number} k 拍号（1 起）
 */
function startProbeTick(flow, k) {
  // 下一拍落地开探时刻若已越过窗口硬止，就不再排（终查/过期由 reconcile 收口）
  var nextProbeAt = flow.S + cfg.firstBoxDelayMs + cfg.boxPeriodMs * (k - 1) - cfg.probeLeadMs;
  if (k > 1 && nextProbeAt >= flow.E) return;
  flow.k = k;
  scheduleProbe(flow, k, 0);
}

/**
 * 排第 k 拍阶梯 idx 的一次探测事件（时刻早于现在则立即可跑；floorMs 给重试设最短延后，防持续故障时 0ms 空转）
 * @param {object} flow 目标流程
 * @param {number} k 拍号
 * @param {number} idx 阶梯下标（cfg.probeLadderMs）
 * @param {number} [floorMs] 该事件最早可跑时刻（本地 ms，重排/重试用的下限）
 */
function scheduleProbe(flow, k, idx, floorMs) {
  var landing = flow.S + cfg.firstBoxDelayMs + cfg.boxPeriodMs * (k - 1);
  var at = landing - cfg.probeLeadMs + (cfg.probeLadderMs[idx] || 0);
  if (floorMs != null && floorMs > at) at = floorMs;
  pushEvent(Math.max(Date.now(), at), 'probe', flow.marchId, {
    k: k,
    ladderIdx: idx,
    uid: flow.uid,
  });
}

/**
 * 结束一条流程：出队 + 清其 pending + 打一行对账日志（真机看这里判断节奏是否合适）
 * @param {object} flow 目标流程
 * @param {string} reason 结束原因
 */
function dropFlow(flow, reason) {
  flows.delete(flow.marchId);
  var heldBefore = pendingPickups.length;
  pendingPickups = pendingPickups.filter(function (it) {
    return it.flow !== flow;
  });
  log.info(
    'flow end. marchId=%s;float=%s;reason=%s;periods=%d;boxes=%d;expect=%d;gridEnd=%d;queries=%d;marchRejects=%s;pendingHeld=%d;slotWaits=%d;pendingFlows=%d',
    flow.marchId,
    flow.floatId,
    reason,
    flow.k,
    flow.dispatched.size,
    flow.expect,
    flow.lastK,
    flow.queries,
    flow.rejects.size ? Array.from(flow.rejects).join('|') : '-',
    heldBefore - pendingPickups.length,
    flow.slotWaits || 0,
    flows.size,
  );
  // 只对"实领多于推算"告警：少于推算是正常的没抢过别人（这种情况下阈值本就未被放宽，流程会走完 M 拍），
  // 而多于推算意味着 exp−t=箱数×180 这条关系改了，我们的拍网格与阈值都得重看
  if (flow.expect > 0 && flow.dispatched.size > flow.expect) {
    log.warn(
      'more boxes than card prediction. marchId=%s;got=%d;expect=%d;life=%ds',
      flow.marchId,
      flow.dispatched.size,
      flow.expect,
      Math.round((flow.E - flow.S) / 1000),
    );
  }
  if (!flows.size && !pendingPickups.length) stopDriver();
}

/**
 * 今日日期串（口径同 alliance-help：只用它做"跨日自动失效"，不追求服务器日界到小时）
 * @returns {string} "YYYY-MM-DD"
 */
function todayStr() {
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 该花车类型今天是否已被服务器判满（只能由 902 的显式文案键置位，不会因空查/收摊而误判）
 * @param {string} floatId 花车类型 id
 * @returns {boolean}
 */
function isCapReached(floatId) {
  return capReachedOn.get(floatId) === todayStr();
}

/**
 * 记下"该类型今日已满"，并当场收掉同类型的全部在飞流程与待派项：
 * 上限是类型级的，再探下去每台车只会得到同一个拒绝，纯属空转。
 * 只动同类型——其他花车类型的上限各自独立
 * @param {object} flow 触发本次判定的流程
 * @param {*} data 902 拒绝载荷原文
 */
function markCapReached(flow, data) {
  capReachedOn.set(flow.floatId, todayStr());
  pendingPickups = pendingPickups.filter(function (it) {
    return it.flow.floatId !== flow.floatId;
  });
  var closed = 0;
  for (var entry of Array.from(flows)) {
    if (entry[1].floatId === flow.floatId) {
      dropFlow(entry[1], 'daily limit reached');
      closed++;
    }
  }
  log.info(
    'float type daily pickup limit reached. float=%s;date=%s;resp=%s;why=%s;flows closed=%d;pending left=%d',
    flow.floatId,
    todayStr(),
    respText(data),
    whyText(data),
    closed,
    pendingPickups.length,
  );
}

/**
 * newChatPush 入口：同步过滤 + 建流程 + 铺首批事件。永不 throw（net/event 封装也会兜，但不依赖它）
 * @param {object} msg newChatPush 载荷（游戏 NetChatClient 把 socket "chatpush" 单参转出来）
 */
function onChatPush(msg) {
  if (!aliveFn()) return;

  var seed = parseParadeShare(msg);
  if (!seed) return;

  // 类型级当日已满：这台车的每次探测都会撞到同一个拒绝，直接不建流程（其他类型照常）
  if (isCapReached(seed.floatId)) {
    log.debug(
      'float type daily limit reached today, skip parade. float=%s;marchId=%s',
      seed.floatId,
      seed.marchId,
    );
    return;
  }

  var nowMs = Date.now();
  var nowSec = serverTimeSec();
  if (seed.expSec && nowSec >= seed.expSec) {
    log.debug(
      'stale parade share skipped. marchId=%s;lag=%ds',
      seed.marchId,
      Math.round(nowSec - seed.expSec),
    );
    return;
  }
  if (flows.has(seed.marchId)) {
    log.debug('flow exists for this parade. marchId=%s', seed.marchId);
    return;
  }

  var flow = newFlow(seed, nowMs);
  flows.set(flow.marchId, flow);
  startProbeTick(flow, 1);
  // E 前终查（tail）一次；到点再排 expire 收口，替代旧 tailConfirmed/bandEnd 就地闭合
  pushEvent(Math.max(Date.now(), flow.E - cfg.tailCheckLeadMs), 'reconcile', flow.marchId, {
    phase: 'tail',
    uid: flow.uid,
  });
  log.info(
    'parade flow started. marchId=%s;float=%s;delay=%ds;life=%ds;expect=%d;firstProbeIn=%ds;flows=%d',
    flow.marchId,
    flow.floatId,
    Math.round((nowMs - flow.S) / 1000),
    Math.round((flow.E - flow.S) / 1000),
    flow.expect,
    Math.round(
      (flow.S + cfg.firstBoxDelayMs + cfg.probeLadderMs[0] - cfg.probeLeadMs - nowMs) / 1000,
    ),
    flows.size,
  );
  startDriver();
}

/**
 * 一拍内的一次定向探测（probe 事件 handler）。命中新箱→按名额分派（立即 pickup / 入 pending）；
 * 命中已派/被占/退避中→中性推下一拍；末级阶梯仍真空→记 miss 拍并结算阈值。永不 reject
 * @param {object} flow 目标流程
 * @param {object} payload {k, ladderIdx}
 */
async function onProbe(flow, payload) {
  if (!flow || flow.uid !== payload.uid) return; // 代际不符（同 marchId 收摊后重建）：陈旧事件丢弃
  // 陈旧事件（本流程已推进到新拍）：payload.k 与 flow.k 不符直接丢
  if (payload.k !== flow.k) return;
  // 同拍在飞（理论不该发生，网络抖动兜底）：延后 retryMs 重排同事件，不并发、不 0ms 空转
  if (flow.inFlight) {
    scheduleProbe(flow, payload.k, payload.ladderIdx, Date.now() + cfg.retryMs);
    return;
  }

  flow.inFlight = true;
  flow.queries++;
  var res = await queryBox(flow.dropType, flow.marchId);
  flow.inFlight = false;

  // await 期间流程可能已被结算/过期出队，也可能整个功能已 pause
  if (!aliveFn() || flows.get(flow.marchId) !== flow) return;

  var k = payload.k,
    j = payload.ladderIdx;

  if (res.state === 'hit') {
    var key = res.x + ',' + res.y;
    // 命中已被自己遮蔽（已派/退避中/他支在途占位）→ 中性：不累加 missStreak，也不重复派遣
    if (
      flow.dispatched.has(key) ||
      inBackoff(flow, key) ||
      (await hasMarchAtTarget(res.x, res.y, flow.getType))
    ) {
      if (flow.dispatched.has(key))
        log.debug(
          'box shadowed by own march. marchId=%s;owner=%s;x=%d;y=%d',
          flow.marchId,
          marchOwnerAt(key, flow.marchId),
          res.x,
          res.y,
        );
      else
        log.debug(
          'box occupied/in-backoff, yield. marchId=%s;x=%d;y=%d',
          flow.marchId,
          res.x,
          res.y,
        );
      concludeTick(flow, k, false, false);
      return;
    }
    // 命中可动新箱：认账 + 清 miss + 推进网格，再按名额决定立即派还是按住
    flow.dispatched.add(key);
    flow.missStreak = 0;
    if (flow.lastK > 0 && flow.dispatched.size > flow.expect) flow.lastK = 0; // 卡片少报：关提前收摊
    log.info(
      'box found. marchId=%s;float=%s;x=%d;y=%d;period=%d;free=%d',
      flow.marchId,
      flow.floatId,
      res.x,
      res.y,
      k,
      await freeSlots(flow.getType),
    );
    await requestPickup(flow, key, res.x, res.y);
    concludeTick(flow, k, true, false);
    return;
  }

  if (res.state === 'empty') {
    // 空因文案键只在本次会话首次出现时报一行 info：它才能分辨"没箱"与"今日 10 次已满"
    if (res.key && !seenEmptyKeys.has(res.key)) {
      seenEmptyKeys.add(res.key);
      log.info(
        'new 8852 empty reason. marchId=%s;period=%d;code=%d;resp=%s;why=%s',
        flow.marchId,
        k,
        res.code,
        res.resp,
        res.why,
      );
    } else {
      log.debug('no box for this parade. marchId=%s;period=%d;code=%d', flow.marchId, k, res.code);
    }
    // 阶梯未走完：补查下一级；走完仍真空：记一次 miss 拍并结算
    if (j + 1 < cfg.probeLadderMs.length) scheduleProbe(flow, k, j + 1);
    else concludeTick(flow, k, false, true);
    return;
  }
  // state==='error'：网络异常，延后 retryMs 重排同一步（不留延后会在持续故障时 0ms 空转刷屏），不改动任何计数
  scheduleProbe(flow, k, j, Date.now() + cfg.retryMs);
}

/**
 * 一拍探测结论（无新箱命中时调用）：真空拍累加 missStreak，中性拍不动；再判两类提前收摊，最后推进网格
 * @param {object} flow 目标流程
 * @param {number} k 当前拍号
 * @param {boolean} gotBox 本拍是否命中可动新箱
 * @param {boolean} genuineMiss 是否为走完阶梯的"真·空"（遮蔽/退避等中性命中传 false）
 */
function concludeTick(flow, k, gotBox, genuineMiss) {
  if (genuineMiss) flow.missStreak++;

  // 刚性网格末拍：卡片既算出 N 箱，第 lastK 拍一旦没命中可动新箱就不可能再有箱 → 直接收摊（省掉尾部空转拍）。
  // 但仍有按住待派的箱时不收：拍网格只保证"不再发现新箱"，不保证已发现的箱都派出去了——
  //   远处 10 箱车前 5 在途占满名额时，后 5 箱全在 pending 等腾位，此刻收摊会连带清掉它们（漏领根因之二）；
  //   这些箱的寿命由 flow.E 的 expire 兜底，不会无限挂
  if (!gotBox && flow.lastK > 0 && k >= flow.lastK && !hasPendingFor(flow)) {
    dropFlow(flow, 'grid done');
    return;
  }
  if (!gotBox && flow.missStreak >= stopThreshold(flow) && !hasPendingFor(flow)) {
    dropFlow(flow, 'empty ' + flow.missStreak + ' periods');
    return;
  }

  startProbeTick(flow, k + 1);
}

/**
 * 该流程是否还有按住待派的箱（concludeTick 的收摊闸门用：pending 未排空前不许提前收摊）
 * @param {object} flow 目标流程
 * @returns {boolean}
 */
function hasPendingFor(flow) {
  return pendingPickups.some(function (it) {
    return it.flow === flow;
  });
}

/**
 * 该坐标是否在退避窗口内（被拒后按指数退避再试，未到点前视为中性）
 * @param {object} flow 目标流程
 * @param {string} key 坐标键
 * @returns {boolean}
 */
function inBackoff(flow, key) {
  var b = flow.rejectBackoff.get(key);
  return !!(b && Date.now() < b.untilMs);
}

/**
 * 反查"这个坐标上的在途行军是哪条流程派的"（纯诊断）。游戏侧 march 记录不带发车 marchIdStr
 * @param {string} key 坐标键 "x,y"
 * @param {string} selfId 本流程 marchIdStr（不算自己）
 * @returns {string} 归属流程的 marchIdStr，查不到回 'stale'
 */
function marchOwnerAt(key, selfId) {
  for (var entry of flows) {
    var other = entry[1];
    if (other.marchId !== selfId && other.dispatched.has(key)) return other.marchId;
  }
  return 'stale';
}

/**
 * 命中新箱后的派遣分派：有名额立即入堆 pickup，无名额入 pending 并排 slotFree
 * @param {object} flow 所属流程
 * @param {string} key 坐标键
 * @param {number} x 横坐标
 * @param {number} y 纵坐标
 */
async function requestPickup(flow, key, x, y) {
  var item = {
    flow: flow,
    marchId: flow.marchId,
    key: key,
    x: x,
    y: y,
    getType: flow.getType,
    queuedAt: Date.now(),
  };
  if ((await freeSlots(flow.getType)) > 0) {
    pushEvent(Date.now(), 'pickup', flow.marchId, { item: item });
  } else {
    addPending(item);
    flow.slotWaits++;
    await scheduleSlotFree(flow.getType);
    log.debug(
      'no act slot, held for pickup. marchId=%s;x=%d;y=%d;getType=%d',
      flow.marchId,
      x,
      y,
      flow.getType,
    );
  }
}

/**
 * 入 pending（去重 by key）
 * @param {object} item 待派项
 */
function addPending(item) {
  if (
    pendingPickups.some(function (it) {
      return it.key === item.key;
    })
  )
    return;
  pendingPickups.push(item);
}

/**
 * 取某 getType 仍有效的 pending 项（归属流程在飞且窗口未硬止）
 * @param {number} getType 拾取行军类型
 * @returns {object[]}
 */
function livePendingFor(getType) {
  var now = Date.now();
  return pendingPickups.filter(function (it) {
    return it.getType === getType && flows.get(it.marchId) === it.flow && now < it.flow.E;
  });
}

/**
 * slotFree 事件 handler：某 getType 腾位到点 → 榨干名额。逐支重查 8852 校验箱仍对我可领，
 * 一致则立即入堆 pickup（受 pickup 条间闸门自然错开 ≥1s）。⚠️ 8852 每次只回**一个**当前可领箱：
 * 回空才是"队首箱已消失/被抢"（撤 pending 项并从已派集合退回）；回的是别的坐标只说明"它不是当前可领箱"
 * （更早的按住箱可能已过期，它自己还在地上）——按住项必须原样回队等后续腾位，绝不能级联撤掉，
 * 否则整堆 pending 被一次错配清空、而拍网格已推进不会再探它（远处 10 箱车、5 箱按住等腾位时漏领 5 箱的根因）。
 * 循环至本轮占用名额达 freeSlots 上限或无 pending；仍有 pending 则按最新 nextReleaseAt 续排
 * @param {number} getType 拾取行军类型
 */
async function onSlotFree(getType) {
  slotFreeScheduled.delete(getType);
  var dispatched = 0;
  var slots = await freeSlots(getType);
  while (aliveFn() && dispatched < slots) {
    var pend = livePendingFor(getType);
    if (!pend.length) break;
    // 选所属 flow 窗口最紧（E 最小）者先派，快过期的箱优先榨名额；同堆内按入队序即拍序（=投放序，
    //   而 8852 回的正是"最早可领箱"=拍序最早者，队首比对一次即够，无需逐项重查）
    var item = pend[0];
    for (var i = 1; i < pend.length; i++) if (pend[i].flow.E < item.flow.E) item = pend[i];

    pendingPickups = pendingPickups.filter(function (it) {
      return it !== item;
    });

    var res = await queryBox(item.flow.dropType, item.flow.marchId);
    if (!aliveFn() || flows.get(item.marchId) !== item.flow) return; // 期间流程收摊/pause

    if (res.state === 'empty') {
      // 对该流程已无任何可领箱：队首项确认消失（被抢/过期/上限），从已派集合退回（中性不重派）；
      // 后续按住项留 pending——若还有活箱，下一次重查会 hit
      item.flow.dispatched.delete(item.key);
      log.debug(
        'pending box vanished before dispatch. marchId=%s;x=%d;y=%d',
        item.marchId,
        item.x,
        item.y,
      );
      continue;
    }
    if (res.state !== 'hit') {
      addPending(item); // 网络异常：原样回队，靠下次 slotFree/收摊对账，不计失败不级联
      break;
    }

    var qKey = res.x + ',' + res.y;
    if (qKey === item.key) {
      // 箱仍是当前可领箱：入堆（pickup 闸门保证条间 ≥1s）；名额已被本轮占用，dispatched 计数封顶防超发
      pushEvent(
        Math.max(Date.now(), lastPickupAt + cfg.retryMs + dispatched * cfg.retryMs),
        'pickup',
        item.marchId,
        { item: item },
      );
      dispatched++;
      continue;
    }

    // 回的是别的坐标：本项只是"不再是当前可领箱"（大概率更早、还活着），原样回队等下次腾位
    addPending(item);
    if (item.flow.dispatched.has(qKey) || inBackoff(item.flow, qKey)) {
      // 该坐标已被本流程按住（在 pending 尾/退避中）：下一轮循环会轮到它，或须等退避到点，让位退出
      break;
    }
    // 拍网格之后新冒出来的箱（如收摊闸门放开后延迟落地的箱）：当场认账派遣；本轮到此为止，
    //   下一箱要等这支的 902 真正受理后 8852 才会推进，继续重查只会拿同一个坐标空转
    item.flow.dispatched.add(qKey);
    log.info(
      'fresh box at slot-free. marchId=%s;x=%d;y=%d;held=%d',
      item.marchId,
      res.x,
      res.y,
      pendingPickups.length,
    );
    await requestPickup(item.flow, qKey, res.x, res.y);
    break;
  }
  // 仍有同类型 pending（名额不够或被本轮漏掉）→ 按最新释放估算续排
  if (livePendingFor(getType).length) await scheduleSlotFree(getType);
}

/**
 * pickup 事件 handler：派 902。全局条间闸门（≥retryMs）防 902 限流；受理则记 marchInfo 时刻（埋点①），
 * 被拒按 errKey 路由表分派。永不 reject
 * @param {object} item 待派项 {flow,marchId,key,x,y,getType,retriedOnce?}
 */
async function onPickup(item) {
  var flow = item.flow;
  if (!flow || flows.get(item.marchId) !== flow) return; // 归属已变（收摊/重建）
  var now = Date.now();
  // 条间闸门：距上条 902 不足 retryMs 就顺延自排，不并发（保留 pickup 事件语义，不阻塞堆）
  if (now - lastPickupAt < cfg.retryMs) {
    pushEvent(lastPickupAt + cfg.retryMs, 'pickup', item.marchId, { item: item });
    return;
  }
  lastPickupAt = now;

  var ret = await marchPickUp(item);
  if (!aliveFn() || flows.get(item.marchId) !== flow) return;

  if (ret.ok) {
    // 902 走旧 JSON 链路（net.send），受理时应答是整包 JSON 文本、被拒才是 "语言键,参数" 裸串；
    // payloadOf 归一化后再取 marchInfo，否则字符串取属性恒 undefined，会误报 shape unexpected 且埋点①拿不到时刻
    var raw = payloadOf(ret);
    var mi = (raw && (raw.marchInfo || (raw.data && raw.data.marchInfo) || raw)) || {};
    var hasId = mi.marchId != null;
    // 埋点①：应答自带出发/到达时刻，返程两字段此刻必为 0（回城 push 合并后才有值，见 SlotModel 迭代打点）
    log.info(
      'pick up march started. marchId=%s;x=%d;y=%d;code=%d;marchId64=%s;marchStart=%s;marchArrive=%s;retArrive=%s',
      item.marchId,
      item.x,
      item.y,
      ret.code,
      hasId ? String(mi.marchId) : '-',
      mi.marchStartTime != null ? mi.marchStartTime : '-',
      mi.marchArrive != null ? mi.marchArrive : '-',
      mi.returnArriveTime != null ? mi.returnArriveTime : '0',
    );
    if (!hasId) {
      // 应答形态与预期不符：吐一次原始结构，定位 marchId/回程时刻的真实路径（真机参数观测用）
      var peek = '<unserializable>';
      try {
        peek = String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 400);
      } catch (e) {}
      var shape =
        typeof raw === 'string'
          ? 'string'
          : raw && typeof raw === 'object'
            ? Object.keys(raw).join('|')
            : typeof raw;
      log.warn('pickup resp shape unexpected. keys=%s;raw=%s', shape, peek);
      return;
    }
    // 行军队列加速（勾选「启用行军加速」且配了目标剩余秒数才做）：对刚受理的拾取行军循环加速直到剩余 ≤ 目标（或道具耗尽/被拒），fire-and-forget
    if (accelEnabled && accelTargetSec > 0) {
      var arriveSec = +mi.marchArrive;
      if (arriveSec > 0) {
        maybeAccelerate(String(mi.marchId), arriveSec, item.getType).catch(function (err) {
          log.warn('speed up threw. marchId=%s', mi.marchId, err);
        });
      }
    }
    return;
  }

  var errKey = rejectErrKey(ret.data);
  // 服务器对成形领车请求的结构化拒绝（限流/目标被占/队满/日限额等）属预期业务态 → info；
  // 未知键首遇仍由下方 1051 的 warn 单独报警（新枚举发现机制），不丢信号。
  log.info(
    'pick up march rejected. marchId=%s;x=%d;y=%d;code=%d;resp=%s;why=%s',
    item.marchId,
    item.x,
    item.y,
    ret.code,
    respText(ret.data),
    whyText(ret.data),
  );

  // 路由表按 errKey 分派（队满不进 rejects/熔断，上限走熔断，其余走退避）
  if (errKey === ERR_FLOAT_DAILY_LIMIT) {
    flow.rejects.add(errKey);
    flow.dispatched.delete(item.key);
    markCapReached(flow, ret.data);
    return;
  }
  if (errKey === ERR_QUEUE_FULL) {
    // 队满=行军根本没发出：坐标退回 pending、不记退避、不进熔断、不进 rejects 汇总；按该 getType 打点 slotFree
    flow.dispatched.delete(item.key);
    await logQueueFullEvidence(flow); // 埋点②
    addPending(item);
    await scheduleSlotFree(item.getType);
    return;
  }

  // 其余拒绝（含限流 march_time_control_info001 / 目标被占 / 未知键）：记 rejects，坐标退回，退避/单次重派
  if (errKey) flow.rejects.add(errKey);
  flow.dispatched.delete(item.key);
  // 未知键的首次遭遇：单次立即重派，仍拒才降退避（新键发现机制）
  if (errKey && errKey !== ERR_RATE_LIMIT && !item.retriedOnce) {
    log.warn(
      'unknown reject key (first hit), single retry. marchId=%s;resp=%s',
      item.marchId,
      respText(ret.data),
    );
    pushEvent(Date.now() + cfg.retryMs, 'pickup', item.marchId, {
      item: Object.assign({}, item, { retriedOnce: true }),
    });
    return;
  }
  schedulePickupBackoff(flow, item);
}

/**
 * 被拒后按坐标指数退避排一次重派（仍在本流程窗口内才排）
 * @param {object} flow 目标流程
 * @param {object} item 待派项
 */
function schedulePickupBackoff(flow, item) {
  var tries = ((flow.rejectBackoff.get(item.key) || {}).tries || 0) + 1;
  var wait = Math.min(
    cfg.rejectBackoffBaseMs * (1 << Math.min(tries - 1, 5)),
    cfg.rejectBackoffMaxMs,
  );
  flow.rejectBackoff.set(item.key, { untilMs: Date.now() + wait, tries: tries });
  log.debug(
    'pickup retry scheduled. marchId=%s;x=%d;y=%d;tries=%d;backoff=%ds',
    flow.marchId,
    item.x,
    item.y,
    tries,
    Math.round(wait / 1000),
  );
  if (Date.now() + wait < flow.E)
    pushEvent(Date.now() + wait, 'pickup', flow.marchId, { item: item });
}

/**
 * 埋点②：队满拒绝时打印同 getType 在途数与全体 ACT_MARCHS 在途类型分布——
 * 若单 type <5 仍撞队满，即为跨类型共享池证据（触发名额口径重评）
 * @param {object} flow 触发流程
 */
async function logQueueFullEvidence(flow) {
  var sameType = (await myActiveMarches(flow.getType)).length;
  var dist = {};
  for (var m of await listMarches()) {
    if (!isActivityMarch(m.type)) continue;
    dist[m.type] = (dist[m.type] || 0) + 1;
  }
  var parts = [];
  for (var t in dist)
    if (Object.prototype.hasOwnProperty.call(dist, t)) parts.push(t + '=' + dist[t]);
  log.info(
    'queue-full evidence. marchId=%s;getType=%d;inTransit(type)=%d;cap=%d;allActMarches=%s',
    flow.marchId,
    flow.getType,
    sameType,
    cfg.actQueueCap,
    parts.length ? parts.join(',') : '-',
  );
}

/**
 * reconcile 事件 handler。phase='tail'：E 前终查一次，命中仍可动新箱就照常派遣，随后排 phase='expire' 于 E。
 * phase='expire'：窗口硬止收摊（清 pending 由 dropFlow 负责）。永不 reject
 * @param {object} flow 目标流程
 * @param {object} payload {phase:'tail'|'expire', uid}
 */
async function onReconcile(flow, payload) {
  if (!flow || flow.uid !== payload.uid) return; // 代际不符（同 marchId 收摊后重建）：陈旧 tail/expire 不得动新流程
  if (payload.phase === 'expire') {
    dropFlow(flow, 'window expired');
    return;
  }
  // tail：先把窗口硬止收口 expire 排上（即便随后 pause 让终查落空、return 提前，流程也一定会在 E 被清理），再终查一次
  pushEvent(Math.max(Date.now(), flow.E), 'reconcile', flow.marchId, {
    phase: 'expire',
    uid: flow.uid,
  });
  var res = await queryBox(flow.dropType, flow.marchId);
  if (!aliveFn() || flows.get(flow.marchId) !== flow) return;
  if (res.state === 'hit') {
    var key = res.x + ',' + res.y;
    if (
      !flow.dispatched.has(key) &&
      !inBackoff(flow, key) &&
      !(await hasMarchAtTarget(res.x, res.y, flow.getType))
    ) {
      flow.dispatched.add(key);
      if (flow.lastK > 0 && flow.dispatched.size > flow.expect) flow.lastK = 0;
      log.info(
        'box found (tail). marchId=%s;float=%s;x=%d;y=%d',
        flow.marchId,
        flow.floatId,
        res.x,
        res.y,
      );
      await requestPickup(flow, key, res.x, res.y);
    }
  }
}

/**
 * 拒绝应答里的文案键（真机口径："<语言键>,<参数>"，如 "alliance_120503,10"，与 alliance-help 同源处理）。
 * code=3 本身只代表"被拒"、不携带业务含义，"今日 10 次已满"还是"没箱"只可能从这个键区分
 * @param {*} data Ret.data
 * @returns {string|null} 不是字符串形态（空/对象）时不猜
 */
function rejectErrKey(data) {
  if (typeof data !== 'string' || !data) return null;
  var comma = data.indexOf(',');
  return comma >= 0 ? data.slice(0, comma) : data;
}

/**
 * 服务器文案键 → 游戏当前语言文本（走 ACL 的 l10n.net，与游戏自己弹的 toast 同源）。
 * 真机实例：902 撞每日上限回的是 `mysterioustriangle_10`——"神秘三角"活动的文案族被服务端跨活动复用了，
 * 光看键名无法定性；而误把未知键当"今日已满"做熔断，代价是当天从此不再领，不可逆。
 * 查不到译文（或 l10n 不可用）回 '-'，不重复打原文
 * @param {*} data Ret.data
 * @returns {string}
 */
function whyText(data) {
  if (typeof data !== 'string' || !data) return '-';
  try {
    var t = l10n.net(data);
    return t && t !== data ? t.slice(0, 60) : '-';
  } catch (err) {
    // 翻译只是附加信息，绝不能吃掉整条被拒日志（回放实测：这里抛异常时 warn 根本打不出去）
    return '-';
  }
}

/**
 * 应答载荷的一行文本形态（截断，避免对象载荷刷屏）
 * @param {*} data Ret.data
 * @returns {string}
 */
function respText(data) {
  if (data == null || data === '') return '-';
  var s;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch (err) {
    return '[unserializable]';
  }
  return s.slice(0, 60);
}

/**
 * 查这台花车当前我能领的箱坐标（游戏"查看花车附近奖励"同款请求）。
 * 永不 reject：发送异常回 error，服务器"无箱"两种口径（s!=0 被拒 / s=0 但 {x:0,y:0}）都回 empty
 * @param {number} dropType 投放行军类型（查询吃 DROP 值，不是 GET）
 * @param {string} marchIdStr 花车行军 id（string，64 位精度）
 * @returns {Promise<object>} {state:'hit',x,y} | {state:'empty',code,key,resp} | {state:'error',code}
 */
async function queryBox(dropType, marchIdStr) {
  try {
    var ret = await net.sendPBV2(CMD_FLOAT_PARADE_QUERY_CAN_REWARD_BAG, {
      queryType: 1,
      marchType: dropType,
      marchIdStr: marchIdStr,
    });
    var pos = ret.data;
    // 被拒时把原载荷留下来：这是"为什么没箱"的唯一线索（每日上限？被别人领完？箱确实不在）
    if (!ret.ok)
      return {
        state: 'empty',
        code: ret.code,
        key: rejectErrKey(pos),
        resp: respText(pos),
        why: whyText(pos),
      };
    if (!pos) return { state: 'empty', code: ret.code, key: null, resp: '-' };
    if (!pos.x || !pos.y) return { state: 'empty', code: ret.code, key: null, resp: respText(pos) };
    return { state: 'hit', x: pos.x, y: pos.y, code: ret.code };
  } catch (err) {
    log.warn('query box error! marchId=%s', marchIdStr, err);
    return { state: 'error', code: CODE_NOT_SENT };
  }
}

/**
 * 派拾取行军。永不 reject：发送异常回落到 CODE_NOT_SENT 的哨兵 Ret
 * @param {object} item 待派项 {x,y,getType}
 * @returns {Promise<Ret>} code=902 状态码
 */
async function marchPickUp(item) {
  // 零部队三键（{marchType:getType,x,y}，无 armyList）走 core/march.pickUp；频控由本 feat 的 retryMs/drain 自持
  return march.pickUp({ marchType: item.getType, target: { x: item.x, y: item.y } });
}

/**
 * 读某拾取行军当前到达时刻（服务器 epoch 秒）：走 march.list({cache:true}) 快照（920 加速后的新到达由常驻 10019 边沿并进快照）。
 * 快照里已无该行军（到家/移除）回 0。
 * @param {string} marchIdStr 拾取行军 id（string）
 * @returns {Promise<number>} 到达 epoch 秒，或 0
 */
async function pickupArriveSec(marchIdStr) {
  var ms = await march.list({ cache: true });
  for (var i = 0; i < ms.length; i++) {
    if (ms[i].id === marchIdStr) return ms[i].marchArrive > 0 ? +ms[i].marchArrive : 0;
  }
  return 0;
}

/**
 * 920 受理后轮询重读该行军到达时刻，直到比 prevArrive 更早（服务器结算加速、经 10019 并进快照）；
 * 每 ~0.6s 读一次快照，最多等 ~6s。行军消失回 0；窗口内无确认进展回 prevArrive（交调用方停止，防空耗道具）。
 * @param {string} marchIdStr 拾取行军 id
 * @param {number} prevArrive 加速前的到达时刻（epoch 秒）
 * @returns {Promise<number>}
 */
async function waitArriveDrop(marchIdStr, prevArrive) {
  var POLL_MS = 600,
    DEADLINE_MS = 6000;
  var end = Date.now() + DEADLINE_MS;
  while (Date.now() < end) {
    await new Promise(function (r) {
      setTimeout(r, POLL_MS);
    });
    if (!aliveFn()) return prevArrive;
    var a = await pickupArriveSec(marchIdStr);
    if (!(a > 0)) return a; // 行军已从快照消失
    if (a < prevArrive) return a; // 加速已反映（到达更早）
  }
  return prevArrive; // 超时未确认
}

/**
 * 对本 feat 刚派出的活动拾取行军**循环**使用加速道具，直到剩余行军时间 ≤ 面板目标秒数（省队列位/早拿箱），或道具耗尽/被拒/到达结算超时即停。
 * 语义（真机报文 dashcam 20261005T204748 实证）：普通 520001 剩余时间缩短 25%（剩 75%）、高级 520002 缩短 50%（剩 50%）；削减对「当时剩余」逐次生效。
 * 每拍选物：先核对背包持有量——普通一发即可达标(remain×0.75 ≤ 目标)就优先普通（削减更小、更省），否则用高级尽快逼近；
 *   首选缺货回退另一支，两支皆缺则停止。发一支后等 10019 把新到达并进快照再据剩余判下一支，绝不盲连发。
 * 收敛护栏：单次拾取最多连发 MAX_SHOTS 支；920 被拒 / 新到达未在窗口内确认提前 → 停（防无限烧道具）。
 * 加速把到达显著提前，而已排的 slotFree 仍按旧到达醒（10019 同态不触发重锚）：结束时清标记重排一次，让腾位读到更早的到达。
 * fire-and-forget：内部异常由调用侧 catch，绝不影响领取主流程。
 * @param {string} marchIdStr 拾取行军 id（902 应答 marchInfo.marchId，string 防 Int64）
 * @param {number} arriveSec 该行军当前段到达时刻（服务器 epoch 秒）
 * @param {number} [getType] 该拾取行军类型（用于加速后重排 slotFree 腾位打点）
 */
async function maybeAccelerate(marchIdStr, arriveSec, getType) {
  if (!accelEnabled) return; // 面板未勾选「启用行军加速」：不消耗任何道具
  var target = accelTargetSec | 0;
  if (target <= 0) return;
  var normal = march.ITEM_SPEED_UP_NORMAL,
    advanced = march.ITEM_SPEED_UP_ADVANCED;
  var arrive = arriveSec;
  var applied = 0;
  var MAX_SHOTS = 15;
  for (var shot = 0; shot < MAX_SHOTS; shot++) {
    if (!aliveFn()) break;
    if (!(arrive > 0)) break;
    var remain = arrive - serverTimeSec();
    if (!(remain > target)) break; // 已达标 / 时刻无效（NaN/非正）：停
    var prefer = remain * 0.75 <= target ? normal : advanced; // 普通一发可达标就用普通（更省），否则高级逼近
    var other = prefer === normal ? advanced : normal;
    var itemId = item.amount(prefer) > 0 ? prefer : item.amount(other) > 0 ? other : 0;
    if (!itemId) {
      log.debug(
        'no speed-up item left, stop accel. marchId=%s;remain=%ds;target=%ds',
        marchIdStr,
        Math.round(remain),
        target,
      );
      break;
    }
    var ret = await march.speedUp(marchIdStr, { itemId: itemId });
    if (!ret || !ret.ok) {
      log.info(
        'speed up rejected, stop. marchId=%s;itemId=%d;code=%d',
        marchIdStr,
        itemId,
        ret && ret.code,
      );
      break;
    }
    applied++;
    log.info(
      'speed up pickup march. marchId=%s;itemId=%d;remain=%ds;after~=%ds;target=%ds;shot=%d',
      marchIdStr,
      itemId,
      Math.round(remain),
      Math.round(remain * (itemId === advanced ? 0.5 : 0.75)),
      target,
      applied,
    );
    var newArrive = await waitArriveDrop(marchIdStr, arrive);
    if (!(newArrive > 0)) break; // 行军消失
    if (newArrive >= arrive) break; // 未确认到新到达提前：停，防空耗
    arrive = newArrive;
  }
  if (applied > 0 && getType != null) {
    try {
      slotFreeScheduled.delete(getType);
      await scheduleSlotFree(getType);
    } catch (e) {
      /* 重排失败无害，靠 TTL 兑底 */
    }
  }
}
/**
 * 注入面板配置：读行军加速开关与目标秒数（accelEnabled / accelTargetSec，0=不加速）。reactor.setConfig 每次推配置时调用。
 * @param {object} partial {enabled, accelEnabled, accelTargetSec}
 * @returns {object} 当前生效的加速开关与目标秒数（仅供日志/调试）
 */
function configure(partial) {
  accelEnabled = !!(partial && partial.accelEnabled);
  var v = partial && +partial.accelTargetSec;
  accelTargetSec = v > 0 ? v | 0 : 0;
  return { accelEnabled: accelEnabled, accelTargetSec: accelTargetSec };
}

/**
 * 安装：取网络底座 + 数据中心（ServerTime）（硬依赖，任一缺失即失败，reactor 不激活）；行军列表改走 core/march.list({cache:true}) 快照，不再依赖 NWorldMapData；
 * MarchTools 为软依赖，缺失只降级活动行军归属判据（回退 FLOATS getType 副本）+ warn，不阻断激活。
 * @param {object} ctx reactor 上下文
 * @returns {boolean}
 */
function install(ctx) {
  ctxRef = ctx;
  if (installed) {
    return true;
  }

  var missing = [];

  net = ctx.net;
  if (!net.install()) {
    missing.push('pocketcc.net');
    net = null;
  }

  var mods = game.requireAll(['DataCenter', 'MarchTools']);

  dataCenter = (mods.DataCenter && mods.DataCenter.DATA) || missing.push('DataCenter');

  // MarchTools 软依赖：命名导出 ACT_MARCHS（活动行军归属判据）；取不到只回退本地副本，不进 missing
  actMarchs =
    (mods.MarchTools &&
      (mods.MarchTools.ACT_MARCHS ||
        (mods.MarchTools.default && mods.MarchTools.default.ACT_MARCHS))) ||
    null;
  if (!actMarchs) {
    log.warn(
      'MarchTools.ACT_MARCHS missing, fallback to local getType set. missing=%s',
      mods.MarchTools ? 'export-shape' : 'module',
    );
  }

  if (missing.length) {
    net = null;
    dataCenter = null;
    log.warn('install failed. missing=%d;deps=%s', missing.length, missing.join(';'));
    return false;
  }

  installed = true;
  log.info(
    'installed. floats=%s;cap=%d',
    FLOATS.map(function (f) {
      return f.id + '(' + f.dropType + '/' + f.getType + ')';
    }).join(','),
    cfg.actQueueCap,
  );

  return true;
}

/**
 * 运行：挂聊天推送监听，driver 原位重启（pause 期间 flows/pending/堆保留，resume 后继续未探完的车，
 * 陈旧事件由 passGuard 自然作废）。reactor pause 会自动摘除此处登记的触发器
 * @param {object} ctx reactor 上下文
 */
function run(ctx) {
  ctxRef = ctx;
  ctx.on.event('newChatPush', onChatPush);
  startDriver();
  log.info(
    'started, listening event=newChatPush;flows=%d;pending=%d.',
    flows.size,
    pendingPickups.length,
  );
}

/**
 * 向 reactor 注册本功能说明书：地图限定 base/world（Home/NWorldMap），战斗模式暂停（offInCombat）。
 * 面板只出启用开关，探测节奏全部为 cfg 内置常量。
 */
reactor.register({
  id: 'floatCar',
  label: '花车空投',
  storageKey: 'pocketcc.feat.floatCar',
  symbols: ['dataCenter', 'marchTools?'],
  places: ['base', 'world'],
  kinds: ['homeland'],
  offInCombat: true,
  defaults: { enabled: false, accelEnabled: false, accelTargetSec: 0 },
  fields: [
    {
      // 花车空投已抽为独立 feature 卡片：卡片主体默认收起（点标题行展开），故「行军加速」段不再自带折叠，避免双层折叠
      key: 'accelEnabled',
      type: 'checkbox',
      label: '启用行军加速',
      section: '行军加速',
    },
    {
      key: 'accelTargetSec',
      type: 'number',
      label: '加速至剩余(秒)',
      min: 0,
      step: 1,
      section: '行军加速',
      // 行内轻提示：循环对拾取行军用加速道具直到剩余 ≤ N 秒（每支前先核背包、普通可达就优先普通）；0=不加速。
      placeholder: '0=不加速；>0 循环加速至剩余≤此秒',
    },
  ],
  toModuleCfg: function (c) {
    return {
      accelEnabled: !!(c && c.accelEnabled),
      accelTargetSec: (c && +c.accelTargetSec) > 0 ? +c.accelTargetSec | 0 : 0,
    };
  },
  configure: configure,
  install: install,
  run: run,
});
