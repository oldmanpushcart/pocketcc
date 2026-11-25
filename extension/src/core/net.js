/**
 * pocketcc.net
 * 观测面（Event 归一化/cmd 名表/日志打印/采集 collecting/stream/快照）在 net-observe.js，
 * 本文件留 hook 装配 + 入站路由 + 发送 seam，经 createObserve 窄接口驱动观测面。
 */
import { createLog } from './log.js';
import { game } from './game.js';
import { bus } from './bus.js';
import { createObserve, Event } from './net-observe.js';

/**
 * net 底座具名导出（供 reactor/feat 走 ESM import，替代 window.pocketcc.net 全局摸取）。
 * IIFE 内在 api 构造完成后回赋值；bundle 同步求值，importer 读取时必已就绪。
 * 命名用 netApi 而非 net：IIFE 内部已有局部 `var net`（NetMgr.NET 实例）会遮蔽同名导出。
 * @type {object|null}
 */
export let netApi = null;

(function () {
  'use strict';

  /** @type {ReturnType<createLog>} 模块日志器（tag=NET） */
  const log = createLog('NET');

  /** @type {object|null} NetMgr.NET，send/sendPB/sendPBV2 用 */
  var net;
  /** @type {object|null} NetReciver.getInstance()，推送 hook 挂在它上面 */
  var recv;
  /** @type {Function|null} 还原用：原 onMessage 与我们的包装 */
  var recvOrig, recvMine;
  /** @type {boolean} hook 是否已挂上 */
  var installed = false;

  // ── 网络日志（log 开关）────────────────────────────────────────────
  // 设计：入站复用已有的单一 hook（NetReciver.onMessage）加一行打印；发送侧的入口
  // 仅在 log 开启期间挂载 wrapper、关闭即摘除（hot path 不留常驻包装）。不引入 netsniff 的在途配对表/投递令牌/环形缓冲。
  //
  // 发送侧有**两条通道**（实证：只 hook 主通道会让秘境的 req 整族消失）：
  //   ① 主通道 `NetMgr.NET` 单例的 send/sendPB/sendPBV2（本模块 hook 为实例属性遮蔽）。
  //   ② 次通道 `NetMgrSimple.prototype` 的 send/sendPB/sendPBV2 —— TMWatchNetMgr.sendPBV2 的门禁分叉
  //      （verbatim：`h.default.isPabBattleMap ? this._socket&&…&&this._socket.sendPBV2(…) : o.NET.sendPBV2(…)`），
  //      而 `_socket = new NetMgrSimple("test")` 是**另一条 websocket**。异能秘境 85xx 在战斗地图内全走它，
  //      既不经过 NET 实例，也就完全落在 ① 的 hook 视野外（本端 sendSecret 与游戏 UI 的 requestData 都是）。
  //   入站不受此影响：NetMgrSimple.onMessage 末尾同样转调 `NetReciver.getInstance().onMessage(e, reqTime)`
  //   （verbatim：`r.getInstance().onMessage(e,null==d?void 0:d.reqTime)`），单点 hook 天然覆盖两条通道。
  //   次通道只包**原型**（不包 TMWatchNetMgr 门面）：门面在地图外会转调 NET，包门面会让同一条包记两次；
  //   原型则与 `_socket` 的销毁重建无关（连接时 `new`、断开时置 null），一次挂钩长期有效。
  // 三个 bus 命名空间：`net.<cmd>`（推送）、`net.resp.<cmd>`（应答）、`net.req.<cmd>`（本端发包，见 onReq）。
  /** @type {boolean} log 总开关；开=挂发送 hook+入站打印，关=摘发送 hook+入站直通 */
  var logEnabled = false;
  /** @type {number} install 时读 net._heartbeatCode（=RequestId.NO_QUEUE_HEART=0，NetMgr）；只取不到时留 -1，取到值一律入 hbCodes */
  var heartbeatCode = -1;
  /**
   * 已知心跳号集合（两条通道各一个）：主通道 install 时放入，次通道由发送 wrapper 读
   *   `this._heartbeatCode` 时自学习放入（verbatim：NetMgr 构造 =0/NO_QUEUE_HEART，NetMgrSimple 构造 =6385/TM_WATCH_HEART）。
   * 为什么必须是集合而不是单值：入站只在 NetReciver 单点挂钩，两条通道汇聚同一入口、报文里认不出通道归属，
   *   拿主通道号去滤入站会让次通道的心跳应答整族漏进日志/采集/dashcam。
   *   报文实证（异能秘境队长趟实录）：1177 行入站里 68 行是 cmd 6385 的心跳应答（10s 一条，占 5.8%）。
   * @type {Set<number>}
   */
  var hbCodes = new Set();
  /** @type {boolean} 次通道心跳号「读出来不是 number」是否已告警过（字段改名才会走到，只报一次防刷屏） */
  var hbWarned = false;
  /** @type {boolean} 重入标志：sendPB 降级会同步转调 this.send（NetMgr sendPB 末尾），置位让嵌套 send 跳过打印以消重 */
  var inPB = false;
  /** @type {Array<{host:object, key:string, orig:Function, mine:Function}>} 发送 hook 还原表；有 log/collect 需求时非空 */
  var sendHooks = [];
  /** @type {object|null|undefined} 次通道挂点（NetMgrSimple.prototype）；undefined=未探测，null=探测失败 */
  var simpleProto = undefined;
  /**
   * 次通道挂点探测状态，供 install 日志与调试面读：
   *   pending=还没探过（发送 hook 从未挂上）/ ok=原型已解析 / missing=探测失败即本局降级为「次通道不可观测」。
   * missing 不会自愈（NetMgrSimple 与 NetMgr 同在 Script bundle，探不到只可能是符号改版，重试无意义），
   *   改版当天用 pocketcc.net.reprobeSecondary() 手动重探。
   * @type {string}
   */
  var secondaryState = 'pending';
  /** @type {number} 存活的「本端发包」订阅数（onReq 计）：>0 就必须保持发送 hook 挂载，否则 net.req.<cmd> 无处产生 */
  var reqSubs = 0;

  /**
   * 观测面装配（net-observe.js）：hbCodes 传同一 Set 引用（wrapSend 自学习次通道号，观测侧滤心跳读）；
   * syncSendHooks 为函数声明提升，采集器/流增减时由观测面回调按需挂摘发送 hook。
   */
  const observe = createObserve({
    game: game,
    log: log,
    isInstalled: function () {
      return installed;
    },
    hbCodes: hbCodes,
    syncSendHooks: syncSendHooks,
  });

  /** 对外接口面，挂到 window.pocketcc.net（Ret 类因 TDZ 在文件末尾补挂） */
  var api = {
    install: install,
    uninstall: uninstall,
    send: send,
    sendPB: sendPB,
    sendPBV2: sendPBV2,
    sendGuarded: sendGuarded,
    isSending: isSending,
    onReq: onReq,
    onPreInbound: onPreInbound,
    secondaryStatus: secondaryStatus,
    reprobeSecondary: reprobeSecondary,
    setLog: setLog,
    isLogging: isLogging,
    collecting: observe.collecting,
    stream: observe.stream,
    isStreaming: observe.isStreaming,
  };

  /**
   * 游戏入站报文 → bus 事件。推送 = `net.<cmd>`，应答 = `net.resp.<cmd>`（分别对应 ctx.on.push / ctx.on.resp）。
   * 懒构造：没人订阅该 type 就不 new Event（省一次 JSON.parse）。
   * 应答也派发的缘由：游戏自己的 INFO 应答（如秘境 8526）**只回调刷新组件、不 emit 任何全局事件**，
   *   玩法侧要拿“本端刚取到的明细”只能从应答入手；raw 是池化复用对象，Event 只包引用，
   *   所以订阅者必须同拍读完（bus 恒同步派发）或自行快照字段。
   * @param {object} e 原始报文
   * @param {number|undefined} reqTime 应答的发包时刻（NetMgr 递入的 t；推送为 undefined 即非应答）
   * @param {object|null} [ev] 同一拍已构造好的 Event（日志/录制侧给的）；有则复用，省掉重复 JSON.parse
   * @returns {object|null} 本拍用于派发的 Event（供录制侧接着复用）；无人订阅该 type 时为 null
   */
  function dispatch(e, reqTime, ev) {
    var type = (typeof reqTime === 'number' ? 'net.resp.' : 'net.') + e.c;
    if (!bus.has(type)) return null;
    var out = ev || new Event(e, reqTime);
    bus.emit(type, out);
    return out;
  }

  /**
   * 订阅**本端刚发出的一条请求**（bus 事件 `net.req.<cmd>`，载荷 `{cmd,key,data,ts}`）。
   * 与 push/resp 的分工：那两条看到的是**入站报文**，这一条看到的是**发送 hook 入口的 cmd/data**——
   *   即「请求带而应答不带」的那类字段只能从发包侧取（实证：秘境 8532 DROP_INFO 的请求是 `{x,y}`，
   *   而应答 inner 只有 `{info,dropBeastInfo,bagGetNum,beastGetNum,endTime}`，无坐标）。
   * 订阅计数即发送 hook 的挂载需求之一（见 wantSendHooks）：无人订阅就不包发送入口，热路径零开销。
   * 配对与口径（订阅方据此决定怎么把 req 和 resp 对上）：
   *   - **只在包真上线之后派发**：两条通道的 send/sendPB/sendPBV2 都在 needDisable / MsgIDSettings 限制 /
   *     cdTime「请求太过频繁，请求被拦」/ encode 失败 这几道门禁处 `return!1`（verbatim 已核）。此时一个字节
   *     都没出去、也永不会有应答，照派就是在配对队列里埋一条幽灵项，故按返回值 !== false 把关；
   *   - ts 取在 orig.apply **之前**，与游戏内部打点的 reqTime 同源可比（reqTime 恒 >= ts），所以
   *     「ts <= Event.reqTime 中最大的那条」就是精确配对，不依赖先后顺序；
   *   - 载荷 data 是调用方传进来的对象本体（游戏面板多为就地字面量），不深拷、只读，要跨拍持有请自行快照；
   *   - 事件名用的是**逻辑 cmd**（hook 入参），而 resp 侧是**线上 cmd**（报文 e.c）：主通道存在
   *     `msgIdReplaceMap` 换号、sendPB 还有降级 `getOldCmd`（verbatim：`var C=ProtoBufBiz.instance.getOldCmd(e);this.send(C,T,…)`），
   *     这类包换号时 req/resp 会落进不同 cmd，订阅方需自行按同族号段兜底；次通道 NetMgrSimple 无换号表，不属该情形；
   *   - sendPB 降级嵌套的那层 send 不重复派发（与 logReq 同口径的 inPB 消重）；sendPBV2 无降级转调，它自建 pack 后直接 doSend。
   * @param {number} cmd 命令号
   * @param {function(object):void} handler 处理器（bus 同步派发，同拍读完）
   * @returns {function():void} 退订函数（幂等，重复调用不会把订阅计数扣成负数）
   */
  function onReq(cmd, handler) {
    if (typeof handler !== 'function') return function () {};
    var unsub = bus.on('net.req.' + cmd, handler);
    reqSubs++;
    if (installed) syncSendHooks();
    var done = false;
    return function () {
      if (done) return;
      done = true;
      unsub();
      if (--reqSubs < 0) reqSubs = 0;
      if (installed) syncSendHooks();
    };
  }

  // ── 「抢在游戏原生处理器之前」的入站观察 ──────────────────────────────
  /** @type {Map<number, Set<function(object):void>>} cmd → 观察器集合 */
  var preInbound = new Map();
  /** @type {number} preInbound 订阅总数：热路径门，0 时 recvMine 完全跳过、零开销 */
  var preSubs = 0;

  /**
   * 订阅「入站报文在游戏原生 onMessage 处理之前」的观察事件，载荷与 dispatch 同为 Event（同拍只读）。
   * 用途：游戏客户端常在收到某推送的**同步处理里**就把镜头甩到目标点（如难民营 10802 找到营地），
   *   常规 ctx.on.push 在 recvOrig 之后派发、来不及抢跑；本接口让订阅方在 orig 之前拿到坐标等先去抑制。
   * 计数把关：无人订阅时 recvMine 根本不进这里，热路径零开销。
   * @param {number} cmd 命令号
   * @param {function(object):void} handler 观察器（收到 Event）
   * @returns {function():void} 退订函数（幂等，重复调用不会把计数扣成负数）
   */
  function onPreInbound(cmd, handler) {
    if (typeof handler !== 'function') return function () {};
    var set = preInbound.get(cmd);
    if (!set) {
      set = new Set();
      preInbound.set(cmd, set);
    }
    set.add(handler);
    preSubs++;
    return function () {
      if (!set.has(handler)) return;
      set.delete(handler);
      if (--preSubs < 0) preSubs = 0;
      if (set.size === 0) preInbound.delete(cmd);
    };
  }

  /**
   * 在 recvOrig 之前派发 pre-inbound 观察。仅在 preSubs>0 时被调用。
   * @param {object} e 原始报文
   * @param {number|undefined} reqTime 应答的发包时刻（推送为 undefined）
   */
  function runPreInbound(e, reqTime) {
    var set = preInbound.get(e.c);
    if (!set) return;
    var ev = new Event(e, reqTime);
    set.forEach(function (h) {
      try {
        h(ev);
      } catch (err) {
        log.warn('preInbound cmd[%d] handler error. %s', e.c, err);
      }
    });
  }

  /**
   * 开关网络日志。开启时懒建 cmd→名字表。
   * @param {boolean} on
   * @returns {boolean} 当前开关态
   */
  function setLog(on) {
    logEnabled = !!on;
    if (logEnabled) observe.ensureNames();
    syncSendHooks(); // 开则按需挂 hook；关且无采集时摘除，hot path 回到无包装原样
    log.info('net log %s.', logEnabled ? 'enabled' : 'disabled');
    return logEnabled;
  }

  /**
   * 网络日志是否开启
   * @returns {boolean}
   */
  function isLogging() {
    return logEnabled;
  }

  /**
   * 挂到 NetReciver.getInstance().onMessage —— 游戏自己的推送分发器。
   * NetMgr 每处理一条报文就实时属性查找调它一次，替换实例方法即可被看到，
   * 没有 NetMgr 那个 bind 陷阱：单点、无嵌套、可干净还原。
   * 缓存态（disableOnMessage）的报文根本到不了那一处理点，等重放（NetMgr）时才走这里，天然只派发一次。
   * @returns {boolean} 挂钩成功（NetReciver 缺失时 false）
   */
  function hook() {
    var reciver = game.get('NetReciver');
    var inst = reciver && reciver.getInstance();
    if (!inst || typeof inst.onMessage !== 'function') {
      log.warn('install failed, NetReciver is missing.');
      return false;
    }
    recv = inst;
    recvOrig = inst.onMessage;
    recvMine = function (e, t) {
      // t 由 NetMgr 传入：推送 = void 0，应答 = _.reqTime（数字）
      // 「抢在原生处理器之前」的观察点：仅当有 pre-inbound 订阅（如需赶在游戏飞镜头前登记坐标）才付出
      //   构造 Event 的代价；热路径靠 preSubs 计数把关，无人订阅则完全跳过。
      if (preSubs > 0) {
        try {
          runPreInbound(e, t);
        } catch (err) {
          log.warn('preInbound cmd[%d] occur error!', e && e.c, err);
        }
      }
      // 先调 orig 让游戏自己的推送处理器跑完（NetReciver），再派发给我们的 listener
      var ret = recvOrig.apply(this, arguments);
      if (installed && e) {
        // 单拍共享：日志 / bus 派发 / 采集三处消费者共用同一个 Event——e.d 的 JSON.parse 每包只付一次
        //   （实测 13.5 KB 包每次 41.5 µs；地图 901 既被 defense 订阅又被录制时原本要 parse 两遍）。
        //   用局部变量而非模块级槽位：handler 里若同步引发嵌套入站，各自持有自己的 ev，不会串包。
        var ev = null;
        // 心跳在 log 支路剪掉（hbCodes 见文件头），不必为它构造 Event
        if (logEnabled && !hbCodes.has(e.c)) {
          try {
            ev = new Event(e, t);
            observe.logInbound(t, ev);
          } catch (err) {
            log.warn('log inbound cmd[%d] occur error!', e.c, err);
          }
        }
        // 推送走 net.<cmd>，应答走 net.resp.<cmd>（t 由 NetMgr 传入：推送=void 0，应答=_.reqTime）
        try {
          ev = dispatch(e, t, ev) || ev;
        } catch (err) {
          log.warn('dispatch cmd[%d] occur error!', e.c, err);
        }
        // 采集闸门须与发送侧 wrapSend 对称：collectors（一次性环采）或 streams（常开黑匣子）任一非空都要落入站
        if (observe.recording()) {
          try {
            observe.recordInbound(e, t, ev);
          } catch (err) {}
        }
      }
      return ret;
    };
    inst.onMessage = recvMine;
    return true;
  }

  /**
   * 次通道挂点探测（懒建、一次定终身）：`NetMgrSimple` 模块导出的类的 prototype。
   * 拿不到只告警一次并降级为「次通道不可观测」，不影响主通道收发与采集。
   * @returns {object|null} NetMgrSimple.prototype；缺失返回 null
   */
  function secondaryProto() {
    if (simpleProto !== undefined) return simpleProto;
    var m = game.get('NetMgrSimple');
    var C = m && m.NetMgrSimple;
    simpleProto =
      C && C.prototype && typeof C.prototype.sendPBV2 === 'function' ? C.prototype : null;
    secondaryState = simpleProto ? 'ok' : 'missing';
    if (!simpleProto)
      log.warn(
        'NetMgrSimple is missing, secondary send channel is not observable; reprobe via pocketcc.net.reprobeSecondary().',
      );
    else log.debug('secondary send channel resolved: NetMgrSimple.prototype.');
    return simpleProto;
  }

  /**
   * 次通道挂点当前状态（只读，不触发探测）
   * @returns {string} pending|ok|missing
   */
  function secondaryStatus() {
    return secondaryState;
  }

  /**
   * 重探次通道挂点：清掉负缓存并重挂发送 hook，游戏改版当天不必刷新页面即可恢复「次通道发包可观测」。
   * hook 还挂着才走 unhook→rehook（hookSend 对已挂是幂等短路）；没挂就只清缓存，下次 syncSendHooks 自然重探。
   * 使用前提：本入口只在异常场景手动敲一次。若我们的包装已被别的脚本盖在头上，`unhookSend` 会放弃还原，
   *   重探就变成二次包裹（同一条包派两次 log/req）；拿不准时先刷页。
   * @returns {string} 重探后的状态 pending|ok|missing
   */
  function reprobeSecondary() {
    simpleProto = undefined;
    secondaryState = 'pending';
    if (installed && sendHooks.length) {
      unhookSend();
      hookSend();
    }
    log.info('secondary channel reprobe: %s', secondaryState);
    return secondaryState;
  }

  /**
   * 包装一个发送入口：实例属性遮蔽原型方法（主通道 NET）或直接包原型方法（次通道 NetMgrSimple），同 netsniff 口径，可对称还原。
   * wrapper 只读 cmd/data 做日志打印与采集记录（各自判开关），原样透传 arguments 与返回值——不碰 success 回调（应答日志/采集走 recvMine）。
   * 任何日志异常都吞掉，绝不影响真实发送。
   * @param {object} host 挂点对象（NET 单例 / NetMgrSimple.prototype）
   * @param {string} key send|sendPB|sendPBV2
   * @param {boolean} perInstanceHb 心跳号是否取调用实例的 `_heartbeatCode`（次通道每条 socket 自带心跳号，如 TM_WATCH_HEART）
   * @returns {object|null} 还原条目 {host,key,orig,mine}；入口缺失返回 null
   */
  function wrapSend(host, key, perInstanceHb) {
    var orig = host[key];
    if (typeof orig !== 'function') {
      log.warn(
        '%s.%s is missing, skip send log hook.',
        perInstanceHb ? 'NetMgrSimple' : 'NET',
        key,
      );
      return null;
    }
    var mine = function (cmd, data) {
      // 两条通道的心跳号不同（NET=_heartbeatCode/NO_QUEUE_HEART，TMWatch socket=TM_WATCH_HEART），
      // 此处先按**本通道**号剪掉：logReq 无过滤，recordSend/入站那三处只有集合口径（它们分不出这条包来自哪条通道）。
      // 次通道那个号顺手登记进 hbCodes：入站在 NetReciver 单点、认不出通道归属，缺它就滤不掉心跳应答。
      var hb = -1;
      if (perInstanceHb) {
        if (this && typeof this._heartbeatCode === 'number') {
          hb = this._heartbeatCode;
          hbCodes.add(hb);
        } else if (!hbWarned) {
          hbWarned = true;
          log.warn('secondary _heartbeatCode is not a number, heartbeat filtering degraded.');
        }
      } else {
        hb = heartbeatCode;
      }
      // net.req 的派发条件与时刻先在这里定完：ts 必须落在 orig.apply **之前**（与游戏内部 reqTime 同源可比），
      //   而派发动作要等 apply 回来按返回值决定（门禁拦下的包永无应答，见 onReq 注释）
      var wantReq =
        cmd !== hb && reqSubs > 0 && !(key === 'send' && inPB) && bus.has('net.req.' + cmd);
      var reqTs = wantReq ? Date.now() : 0;
      if (cmd !== hb) {
        if (observe.recording()) observe.recordSend(key, cmd, data);
        if (logEnabled) {
          try {
            // 滤心跳；sendPB 降级会同步转调 this.send，inPB 置位时跳过嵌套 send 的重复打印
            //   （sendPBV2 无降级转调：自建 pack 后直接 doSend，门禁不过 return!1）。
            // 传活对象给 console（展开即见），不做深拷贝——stringify+parse 每条发包一次太贵（真机反馈卡）
            if (!(key === 'send' && inPB)) {
              observe.logReq(key, cmd, data);
            }
          } catch (e) {}
        }
      }
      var r;
      if (key === 'send') r = orig.apply(this, arguments);
      else {
        inPB = true;
        try {
          r = orig.apply(this, arguments);
        } finally {
          inPB = false;
        }
      }
      // 本端发包订阅：包真上线才派（消重口径同 logReq，降级嵌套的那层 send 已由 wantReq 判掉）
      if (wantReq && r !== false) {
        try {
          bus.emit('net.req.' + cmd, { cmd: cmd, key: key, data: data, ts: reqTs });
        } catch (e) {}
      }
      return r;
    };
    host[key] = mine;
    return { host: host, key: key, orig: orig, mine: mine };
  }

  /**
   * 发送 hook 挂载闸门：log 开启、或有活动采集器、或有流式订阅者、或有本端发包订阅（reqSubs）时保持挂载，
   * 四者都没有即摘除。
   * 空数组也算需求（collecting().collect() 已承诺挂载、还没 stop 的采集器在 collectors 数组里），
   * 所以只在「从未 collect/stream 且 log 关且无人订 req」时返回 false，避免采集空档期被误摘。
   * 非 null 口径由 observe.active() 承载（与热路径长度闸 observe.recording() 区分）。
   * @returns {boolean} 当前是否应有 hook 挂载需求
   */
  function wantSendHooks() {
    return logEnabled || observe.active() || reqSubs > 0;
  }

  /**
   * 按需挂载全部发送入口 hook：主通道（NET 实例）+ 次通道（NetMgrSimple 原型）（幂等：已挂则不重复包）
   * @returns {number} 当前已挂 hook 数
   */
  function hookSend() {
    if (sendHooks.length) return sendHooks.length; // 幂等：已挂不重复包
    var keys = ['send', 'sendPB', 'sendPBV2'];
    for (var i = 0; i < keys.length; i++) {
      var h = wrapSend(net, keys[i], false);
      if (h) sendHooks.push(h);
    }
    // 秘境/跨服观战走独立 socket（TMWatchNetMgr._socket），不包这一层就录不到本族发包（含 sendSecret）
    var sp = secondaryProto();
    if (sp) {
      for (var j = 0; j < keys.length; j++) {
        if (typeof sp[keys[j]] !== 'function') continue; // 原型上缺哪个入口就跳过哪个
        var h2 = wrapSend(sp, keys[j], true);
        if (h2) sendHooks.push(h2);
      }
    }
    return sendHooks.length;
  }

  /**
   * 摘发送 hook：仅当最外层还是我们的包装时才还原；被别人又包了一层就跳过，退化成直通
   */
  function unhookSend() {
    for (var i = sendHooks.length - 1; i >= 0; i--) {
      var h = sendHooks[i];
      if (h.host && h.host[h.key] === h.mine) h.host[h.key] = h.orig;
    }
    sendHooks = [];
  }

  /**
   * 同步发送 hook 挂载状态（log/collect 共用同一组 wrapper，wrapper 内部各自判开关）
   */
  function syncSendHooks() {
    if (wantSendHooks()) hookSend();
    else unhookSend();
  }

  /**
   * 摘入站 hook 并连带摘发送 hook（uninstall 用）
   */
  function unhook() {
    // 仅当最外层还是我们的包装时才还原；被别人又包了一层就跳过，退化成直通
    if (recv && recv.onMessage === recvMine) recv.onMessage = recvOrig;
    recv = recvOrig = recvMine = null;
    unhookSend();
  }

  /**
   * 安装
   * @returns {boolean} 安装成功
   */
  function install() {
    if (installed) return true;
    var netMgr = game.get('NetMgr');
    net = netMgr && netMgr.NET;
    if (!net) {
      log.warn('install failed, NetMgr is missing.');
      return false;
    }
    if (!hook()) return false;
    heartbeatCode = typeof net._heartbeatCode === 'number' ? net._heartbeatCode : -1;
    if (heartbeatCode !== -1) hbCodes.add(heartbeatCode); // 主通道心跳号入过滤集（次通道号由 wrapSend 自学习）
    installed = true;
    // 发送 hook 由 log/collect 共同驱动（syncSendHooks 管理）；此处只兜底"先开 log/collect 后 install"的顺序
    if (wantSendHooks()) hookSend();
    log.info(
      'installed. heartbeatCode=%d;log=%s;secondary=%s',
      heartbeatCode,
      logEnabled,
      secondaryState,
    );
    return true;
  }

  /**
   * 卸载
   * @returns {boolean} 卸载成功
   */
  function uninstall() {
    if (!installed) return true;
    installed = false;
    unhook();
    // 采集器随 hook 一起作废（stop 返回已采到的条目），流式订阅者一并清空（observe.reset）
    observe.reset();
    log.info('uninstalled.');
    return true;
  }

  /**
   * 发送应答超时（毫秒）。NetMgr.send 把回调存进 _requestPacks[gid]，只在收到匹配应答时触发；
   * 我们以 ensureServerResponse=false 发送（NetMgr，仅 true 才重发），
   * 故服务器一旦不应答该 gid，回调永不触发、Promise 永不 settle。
   * 调用方（drain/execTask）的 await 会就此挂死，consuming 闸门卡 true，整个功能队列停摆
   * （真机：联盟帮助 RECEIVE 在途时一条 1141 无应答，HELP_ALL/RECEIVE 永久 "already queued"）。
   * 超时即 reject —— 各发包函数已 try/catch 回落 CODE_NOT_SENT 哨兵，drain 继续、下一轮重试，功能自愈。
   */
  const SEND_TIMEOUT_MS = 15000;

  /**
   * 给一个发包 Promise 套上超时：到点未 settle 即 reject。
   * 迟到应答再 resolve/reject 已 settle 的 Promise 是无害空操作。
   * @param {Promise<Ret>} p 原始发包 Promise
   * @param {number} cmd 命令号（仅用于错误信息）
   * @param {string} label Send/SendPB/SendPBV2（仅用于错误信息）
   * @returns {Promise<Ret>}
   */
  function withTimeout(p, cmd, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(
          new Error(label + ' [' + cmd + '] no server response in ' + SEND_TIMEOUT_MS + 'ms.'),
        );
      }, SEND_TIMEOUT_MS);
      p.then(
        function (v) {
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * 发送网络请求
   * @param {number} cmd 命令号
   * @param {object} data 数据
   * @returns {Promise<Ret>} 请求结果
   */
  function send(cmd, data) {
    return withTimeout(
      new Promise((resolve, reject) => {
        const ok = net.send(cmd, data, null, (ret) => {
          try {
            const s = ret.s;
            const d = ret.d;
            resolve(Ret.from(s, d));
          } catch (e) {
            reject(e);
          }
        });
        if (!ok) {
          reject(new Error('Send [' + cmd + '] failed.'));
        }
      }),
      cmd,
      'Send',
    );
  }

  /**
   * 带PB的发送网络请求
   * @param {number} cmd 命令号
   * @param {object} data 数据
   * @returns {Promise<Ret>} 请求结果
   */
  function sendPB(cmd, data) {
    return withTimeout(
      new Promise((resolve, reject) => {
        const ok = net.sendPB(cmd, data, null, (ret) => {
          try {
            const ack = ret && ret.pbAck;
            if (!ack) throw new Error('SendPB [' + cmd + '] missing pbAck.');
            const header = ack.header || {};
            const s = header.s;
            // V1 PB 的业务数据是 pbAck 下的命名子字段（如 allianceBehemothDonate/allianceBehemothList），
            // 不像 V2 那样有统一的 .data 包装；故整体返回 pbAck，调用方按 cmd 取自己的子字段。
            const r = Ret.from(s, ack);
            // 拒绝原因的多语言 key 落在 header.d（非子字段），s≠0 时保留供上层判读（口径同 sendPBV2，否则上层只看到 code 无从区分具体拒因）。
            if (s !== 0 && header.d != null) r.reason = header.d;
            resolve(r);
          } catch (e) {
            reject(e);
          }
        });
        // 与 send/sendPBV2 一致：门禁/编码失败返回 false 时立刻 reject，不能挂满 15 秒等永不来的应答。
        if (!ok) reject(new Error('SendPB [' + cmd + '] failed.'));
      }),
      cmd,
      'SendPB',
    );
  }

  /**
   * 带PB的V2发送网络请求
   * @param {number} cmd 命令号
   * @param {object} data 数据
   * @returns {Promise<Ret>} 请求结果
   */
  function sendPBV2(cmd, data) {
    return withTimeout(
      new Promise((resolve, reject) => {
        const ok = net.sendPBV2(cmd, data, null, (ret) => {
          try {
            const header = ret.pbAckV2.header || {};
            const s = header.s;
            const d = ret.pbAckV2.data;
            const r = Ret.from(s, d);
            // 拒绝原因的多语言 key 落在 header.d（非 data），s≠0 时保留供上层判读（否则 rejectText 只看到空 data）
            if (s !== 0 && header.d != null) r.reason = header.d;
            resolve(r);
          } catch (e) {
            reject(e);
          }
        });
        if (!ok) {
          reject(new Error('SendPBV2 [' + cmd + '] failed.'));
        }
      }),
      cmd,
      'SendPBV2',
    );
  }

  /**
   * 在途哨兵码：与 core/util.js 的 CODE_NOT_SENT（=-1）同值。此处用字面量保持发送 seam 不依赖 util
   * （不为一个常量引入跨模块依赖；观测面拆出后本文件仅 import log/game/bus/net-observe）。
   */
  const CODE_NOT_SENT = -1;

  /**
   * 带在途闸门与异常自愈的归一发包。三个 promise 版 send 有「双通道失败」契约：
   * 业务拒绝走 resolve(Ret{ok:false})，而投递失败(!ok)/超时(withTimeout)/回调异常走 reject。
   * 这层壳此前被各 feat 逐份手写（truck/relic/science/behemoth/boss/beast/help/mine-cave 等），
   * 本方法把「闸门 → 协议分派 → catch 回落哨兵 Ret → 永不 reject」的核收回 net 自己手里。
   * 日志刻意不收回：各 feat 的 tag 与文案不同（零漂移铁律），由 onError 透传异常就地打。
   * @param {number} cmd 命令号
   * @param {object} body 载荷
   * @param {object} [opts] 选项
   * @param {'send'|'sendPB'|'sendPBV2'} [opts.protocol] 协议通道，默认 send（旧 JSON）
   * @param {boolean} [opts.gate=true] 是否启用 isSending 在途闸门；无闸门的裸 try/catch 壳传 false
   * @param {boolean} [opts.defaultBody] 载荷为空时兜底 {}（对齐部分 feat 旧壳的 body||{} 语义）
   * @param {Ret} [opts.fallback] 闸门命中/异常时的回落值，默认 Ret.from(CODE_NOT_SENT,null)
   * @param {(err:Error, cmd:number)=>void} [opts.onError] 异常自愈回调（仅 catch 分支触发，闸门分支不调）
   * @returns {Promise<Ret>} 永不 reject 的归一结果
   */
  async function sendGuarded(cmd, body, opts) {
    opts = opts || {};
    const fallback = opts.fallback || Ret.from(CODE_NOT_SENT, null);
    if (opts.gate !== false && net && net.checkRequestIdNoRes(cmd)) return fallback;
    let p = body;
    if (opts.defaultBody && (p == null || p === '')) p = {};
    const api =
      opts.protocol === 'sendPBV2' ? sendPBV2 : opts.protocol === 'sendPB' ? sendPB : send;
    try {
      return await api(cmd, p);
    } catch (err) {
      if (opts.onError) opts.onError(err, cmd);
      return fallback;
    }
  }

  /**
   * 该 cmd 是否有"已发出、还没收到应答"的在途请求（委托 NetMgr.checkRequestIdNoRes）。
   * 注意：查的是在途/挂起状态，不是发送动作本身；发送是瞬时的，之后到收到应答前都算 true。
   * 典型用作发送前去重闸门：if (!net.isSending(CMD)) net.send(CMD, data);
   * @param {number} cmd 命令号
   * @returns {boolean} 有在途未应答的请求
   */
  function isSending(cmd) {
    return net.checkRequestIdNoRes(cmd);
  }

  /**
   * 请求结果
   */
  class Ret {
    /**
     * 构造请求结果
     * @param {number} code 错误码
     * @param {object} data 数据
     */
    constructor(code, data) {
      this.code = code;
      this.data = data;
      /** @type {string|null} PBV2 拒绝原因的多语言 key（落在 pbAckV2.header.d，与业务 data 不同位）；仅 s≠0 且带 key 时非空 */
      this.reason = null;
    }

    /**
     * 是否成功
     */
    get ok() {
      return this.code === 0;
    }

    /**
     * 创建请求结果
     * @param {number} code 错误码
     * @param {object} data 数据
     * @returns {Ret} 请求结果
     */
    static from(code, data) {
      return new Ret(code, data);
    }
  }

  // Ret 是类声明，api 字面量在文件顶部构造时尚处 TDZ，故在此挂上
  api.Ret = Ret;

  window.pocketcc = window.pocketcc || {};
  window.pocketcc.net = api;
  netApi = api; // 具名导出：与 window 同源，供 import { netApi } 使用
  // 扩展内不自启：由 boot.js 在登录成功、场景就绪后调用 install()
})();
