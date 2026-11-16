// net 观测面：报文归一化（Event）+ cmd 名表 + 日志打印 + 采集（collecting/stream）+ 快照。
// B5 从 net.js 拆出：net.js 留 hook 装配 + 推送路由 + 发送 seam，经窄接口驱动本模块。
// 工厂 seam：createObserve(deps) 依赖全部注入（game/log/isInstalled/hbCodes/syncSendHooks），
//   单测可用假 deps 直驱（tests/core/net-observe.test.js），不必桩化浏览器全局。零 import（feat-ctx.js 同款习语）。
// 热路径不变量（与拆分前逐字节一致）：filter 只接免费 (dir,cmd)，new Event 与快照仅在至少一个订阅者通过后发生；
//   单拍共享 Event（日志/bus 派发/采集三处共用一次 JSON.parse）由 net.js recvMine 持有并递入。

/**
 * 推送事件，载荷口径与 NetReciver.js:38 一致。
 * 字段：cmd 命令号 / status 状态码 / data 业务数据 / ord 序号 / ts 接收时刻 / reqTime 该应答对应请求的发出时刻 / raw 原始报文（只读，池化复用）。
 */
export class Event {
  /**
   * 从原始报文归一化出一条推送事件
   * @param {object} e 游戏原始报文（池化复用对象，只读）
   * @param {number} [reqTime] 应答携带的**发包时刻**（epoch ms）；推送/取不到为 null。
   *   来源 verbatim：`onMessage(e,null==d?void 0:d.reqTime)`——NetMgr 与 NetMgrSimple 两条通道同形，
   *   即游戏按应答的 e.o 在 _requestPacks 里反查出当初那条请求的 reqTime 一并递进来。
   *   有它就能把「本端发包 ↔ 应答」按发送时刻精确配对（配合 onReq，见 feats 侧用法）。
   */
  constructor(e, reqTime) {
    this.cmd = e.c;
    this.status = e.s ?? e.pbAck?.header?.s ?? e.pbAckV2?.header?.s ?? null;
    this.data = Event.#dataOf(e);
    this.ord = e.o !== undefined && e.o !== null ? String(e.o) : null;
    this.ts = Date.now();
    this.reqTime = typeof reqTime === 'number' ? reqTime : null;
    this.raw = e; // 只读：报文对象会被池化复用，别在它上面挂属性
  }

  /**
   * 字符串载荷尝试 JSON.parse；非字符串或解析失败原样返回
   * @param {*} s 载荷
   * @returns {*} 解析后的对象或原值
   */
  static #parseMaybe(s) {
    if (typeof s !== 'string' || !s) return s;
    try {
      return JSON.parse(s);
    } catch (e) {
      return s;
    }
  }

  /**
   * 按报文形态取业务数据：d（JSON 串）> pbAck（V1 命名子字段整体）> pbAckV2.data（剥信封）> p；都取不到返回 null。
   * pbAckV2 与发包应答 Ret 同口径剥到内层业务体（{header,data} 的 data）：消费方直读 ev.data.<字段>，
   *   无需各自解信封；header.s 已提升到 ev.status。V1 pbAck 无统一 .data 包装（命名子字段），整体返回由调用方按 cmd 取。
   * @param {object} e 原始报文
   * @returns {*} 业务数据
   */
  static #dataOf(e) {
    try {
      if (e.d != null) return Event.#parseMaybe(e.d);
      if (e.pbAck != null) return e.pbAck;
      if (e.pbAckV2 != null) return e.pbAckV2.data != null ? e.pbAckV2.data : null;
      if (e.p != null) return Event.#parseMaybe(e.p);
    } catch (err) {}
    return null;
  }
}

/**
 * @typedef {object} ObserveDeps 注入依赖
 * @property {object} game 游戏符号解析器（game.get，名表建表用）
 * @property {object} log 日志器（createLog('NET') 产物，与 net.js 同 tag）
 * @property {function():boolean} isInstalled net 底座是否已安装（collect/stream 登记前查）
 * @property {Set<number>} hbCodes 心跳号集合（与 net.js 共享同一引用：wrapSend 自学习次通道号，观测侧滤心跳读）
 * @property {function():void} syncSendHooks 发送 hook 挂载同步（采集器/流增减时由 net.js 按需挂摘）
 */

/**
 * 装配观测面。返回窄接口供 net.js 驱动：
 *   日志支路 logReq/logInbound；采集支路 recordSend/recordInbound + recording()（热路径长度闸）；
 *   hook 需求 active()（非 null 闸，空数组也算需求，见 wantSendHooks 口径）；
 *   对外 collecting/stream/isStreaming；setLog 懒建名表 ensureNames；uninstall 清场 reset。
 * @param {ObserveDeps} deps 注入依赖
 * @returns {object} 观测面接口
 */
export function createObserve(deps) {
  const { game, log, isInstalled, hbCodes, syncSendHooks } = deps;

  /** @type {Object<number,string>|null} cmd -> 常量名 反查表（懒建） */
  var names = null;
  /** @type {boolean} 名表是否已建（日志开启时才建） */
  var namesBuilt = false;
  /** @type {Object<number,number>} pbReqName 已试过的 cmd，避免对未知 cmd 反复调 getReqName */
  var pbTried = {};
  /** @type {object|null|undefined} ProtoBufBiz.instance（undefined=未探测，null=探测失败） */
  var pb = undefined;

  // ── 采集（collecting）────────────────────────────────────────────
  /** @type {Array<{buf:Array, w:number, n:number, filters:Array<Function>, tap:Function|null, done:boolean, warned:boolean, stop:Function}>|null} 活动采集器；buf 为预分配环形槽；null=未启用 */
  var collectors = null;
  /** @type {Array<{filters:Array<Function>, tap:Function, warned:boolean}|null} 常开流式订阅者（net-collect 黑匣子用）：无环形缓冲，每条命中即 tap，直到 unstream；null=未启用 */
  var streams = null;
  /** @type {number} 全局自增序号，标注入站/发送 wrapper 两条记录路径的全局先后（并发采集器/流式订阅者间共享） */
  var collectSeq = 0;
  /** @type {number} capacity 缺省值；环形槽满后静默覆盖最旧条目，只保留最近 N 条 */
  const DEFAULT_COLLECT_CAPACITY = 1000;

  /**
   * cmd 名字来源模块（TS 反向枚举，扫数字→名）；缺失的自动跳过（game.get 返回 null）。
   * 注意：本构建无 'MsgId' 模块（真机 Cannot find module），勿加回。
   * 后两个是 push/应答侧 cmd 的专用表（导出嵌一层 exports.NResponseId，scanConsts 下钻覆盖）；
   * 追加在末尾是因为建表首见者胜，勿与 RequestId/ResponseId 抢既有映射（枚举里都有 =0 项）。
   * @type {string[]}
   */
  var NAME_MODULES = [
    'RequestId',
    'NRequestId',
    'NRequestIdV2',
    'ResponseId',
    'NResponseId',
    'NResponseIdV2',
  ];

  // ── cmd → 名字 ──────────────────────────────────────────────────────
  /**
   * 自有属性判定（绕过原型链）
   * @param {object} o 目标对象
   * @param {string} k 键
   * @returns {boolean}
   */
  function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  /**
   * TS 数字枚举对象既含 名→值 也含 值→名；这里把模块导出里所有数字常量收进 into[值]=名（首见者胜）
   * @param {object} ex 模块导出
   * @param {Object<number,string>} into 结果累加表
   * @returns {number} 本次新增条数
   */
  function scanConsts(ex, into) {
    if (!ex || typeof ex !== 'object') return 0;
    var n = 0,
      k,
      v,
      k2,
      v2;
    for (k in ex) {
      if (!has(ex, k)) continue;
      v = ex[k];
      if (typeof v === 'number' && isFinite(v)) {
        if (into[v] === undefined) {
          into[v] = k;
          n++;
        }
      } else if (v && typeof v === 'object') {
        for (k2 in v) {
          if (!has(v, k2)) continue;
          v2 = v[k2];
          if (typeof v2 === 'number' && isFinite(v2)) {
            if (into[v2] === undefined) {
              into[v2] = k2;
              n++;
            }
          }
        }
      }
    }
    return n;
  }

  /**
   * 扫描 NAME_MODULES 建 cmd→名字 反查表，结果缓存在 names
   * @returns {number} 表条目数
   */
  function buildNames() {
    var into = {},
      total = 0,
      i,
      ex;
    for (i = 0; i < NAME_MODULES.length; i++) {
      ex = game.get(NAME_MODULES[i]);
      if (ex) total += scanConsts(ex, into);
    }
    names = into;
    namesBuilt = true;
    log.debug('cmd name table built. entries=%d', total);
    return total;
  }

  /** ProtoBufBiz.instance 探测一次即缓存（undefined=还没探测，null=失败）
   * @returns {object|null} ProtoBufBiz 单例，缺失返回 null
   */
  function pbBiz() {
    if (pb === undefined) {
      var inst = null;
      try {
        var m = game.get('ProtoBufBiz');
        var o = m && (m.ProtoBufBiz || m.default || m);
        if (o && o.instance) inst = o.instance;
      } catch (e) {}
      pb = inst;
    }
    return pb;
  }

  /**
   * PB 协议 cmd 在枚举表里查不到名，用 ProtoBufBiz.getReqName 兜底（NetMgr.js:205 同款口径）
   * @param {number} cmd 命令号
   * @returns {string|null} 请求名，查不到返回 null
   */
  function pbReqName(cmd) {
    var biz = pbBiz();
    if (!biz || typeof biz.getReqName !== 'function' || pbTried[cmd]) return null;
    pbTried[cmd] = 1;
    try {
      var n = biz.getReqName(cmd);
      return typeof n === 'string' && n ? n : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * cmd → 可读常量名（枚举表优先，PB 兜底；结果回写表以免重复探测）
   * @param {number} cmd 命令号
   * @returns {string|null} 名字，未知返回 null
   */
  function nameOf(cmd) {
    if (cmd === null || cmd === undefined) return null;
    if (!names) buildNames();
    var n = names[cmd];
    if (!n) {
      n = pbReqName(cmd);
      if (n) names[cmd] = n;
    }
    return n || null;
  }

  /** 名表懒建（setLog 开启时调用；collect/stream 登记时内部同款口径） */
  function ensureNames() {
    if (!namesBuilt) buildNames();
  }

  // ── 日志打印（每条独立，data 作 console 末参可展开）──────────────────
  /**
   * 打印一条发包日志
   * @param {string} apiName 入口名 send|sendPB|sendPBV2
   * @param {number} cmd 命令号
   * @param {object} data 发送载荷
   */
  function logReq(apiName, cmd, data) {
    log.info('req  %s %s(%d)', apiName, nameOf(cmd) || '<unknown>', cmd, data);
  }

  /**
   * 入站：t===undefined 为推送，t 为数字（reqTime）为应答（NetMgr.js:578）。
   * 心跳剪除与 Event 构造都在调用方（recvMine）做完，这里只负责打印。
   * @param {number|undefined} t 应答时刻；推送为 undefined
   * @param {object} ev 本拍共享的 Event
   */
  function logInbound(t, ev) {
    var name = nameOf(ev.cmd) || '<unknown>';
    if (t === undefined) {
      log.info(
        'push %s(%d)%s',
        name,
        ev.cmd,
        ev.status != null ? ' status=' + ev.status : '',
        ev.data,
      );
    } else {
      log.info('resp %s(%d) status=%s', name, ev.cmd, ev.status, ev.data);
    }
  }

  // ── 采集（collecting）────────────────────────────────────────
  /**
   * 深拷贝快照（JSON 往返）：原始报文对象池化复用、发送载荷也可能被后续改写，
   * 采集必须存快照；序列化失败（循环引用等）退回活对象引用，不阻断采集。
   * @param {*} v 待快照的值
   * @returns {*} 快照
   */
  function snapshot(v) {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      return v;
    }
  }

  /**
   * 原始报文 → 可长期持有的快照（raw 是池化复用对象，必须拷）。
   * 与 snapshot 的差别：只对**对象值**字段做深拷（pbAck/pbAckV2 这类会被池化改写的载体），
   *   c/o/s 与 d/p（不可变原始值/字符串）直接留引用——省掉整包 stringify+parse 的往返。
   * 实测 13.5 KB 包：往返 82.6 µs → 浅拷 ~1 µs；446 KB 的地图包省掉 2.4 ms。
   * @param {object} e 原始报文
   * @returns {object} 快照（键序、字符串原文均保持）
   */
  function snapshotPacket(e) {
    var o = {};
    for (var k in e) {
      if (!has(e, k)) continue;
      var v = e[k];
      o[k] = v && typeof v === 'object' ? snapshot(v) : v;
    }
    return o;
  }

  /** @type {Object<string, Array>} tapLog 方向样式：[箭头, 主色]，键按 dir 大类取 */
  const TAP_STYLE = {
    req: ['→', '#0066CC'], // 蓝：我发的
    resp: ['←', '#1a7f37'], // 绿：服务器应答
    push: ['↑', '#b35900'], // 橙：服务器主动推
  };
  /** @type {string} %c 空串不会重置样式（上一段会拖进下一段），段间必须显式重置 */
  const TAP_RESET = 'color:inherit;font-weight:normal;background:none';

  /**
   * 内置实时观测回调（collecting().log() 的 tap 实现）：定宽列对齐 + dir/cmd 双色胶囊 + 载荷 %O 内联可展开；
   * 控制台为等宽字体，padEnd/padStart 补宽可靠；徽章内文本先补定宽使胶囊等宽，后列才钉得死
   * 裸 console 豁免：本函数用 %c 双色胶囊 + %O 内联展开做实时 tap 观测，printf-only 的 createLog logger 无法表达，
   * 且属录制/观测基础设施（非业务日志），登记为规范例外。
   * @param {object} e 采集条目
   */
  function tapLog(e) {
    var s = TAP_STYLE[String(e.dir).split(':')[0]] || ['·', '#888'];
    var badge =
      'color:#fff;background:' + s[1] + ';padding:1px 8px;border-radius:4px;font-weight:bold';
    var dirCol = (s[0] + ' ' + e.dir).padEnd(14); // 最长 '→ req:sendPBV2' = 1+1+12
    var label = e.name == null ? 'UNKNOWN(' + e.cmd + ')' : e.name + '(' + e.cmd + ')';
    label = (label.length > 40 ? label.slice(0, 39) + '…' : label).padEnd(40);
    console.log(
      '#%c' + String(e.seq).padStart(5) + '%c %c' + dirCol + '%c %c' + label + '%c%o',
      'color:#999;padding:0 4px',
      TAP_RESET, // seq 预留 5 位，中性灰+留白不抢主体
      badge,
      TAP_RESET, // dir 胶囊（箭头+通道，等宽）
      badge,
      TAP_RESET, // cmd 胶囊（等宽）
      e.raw && e.raw.api ? e.raw.data : e.data,
    ); // req 载荷在 raw.data（e.data 恒 null）
  }

  /**
   * 采集一条发包（send/sendPB/sendPBV2 wrapper 内调用）；sendPB 降级转调 send 时两条都记，保留真实路径
   * @param {string} key 入口名 send|sendPB|sendPBV2
   * @param {number} cmd 命令号
   * @param {object} data 发送载荷
   */
  function recordSend(key, cmd, data) {
    if (hbCodes.has(cmd)) return;
    var dir = 'req:' + key;
    var matched = matchAny(collectors, 'req', cmd);
    var smatched = matchAny(streams, 'req', cmd);
    if (!matched.length && !smatched.length) return;
    // 过滤全部通过后才做昂贵操作（快照）；entry 不可变，多采集器/流共享同一引用安全
    // 发送载荷既是 raw.data，也归一化到顶层 data，与 resp/push 口径一致（分析时 data 恒为业务载荷）
    var payload = snapshot(data);
    var entry = makeEntry(dir, cmd, payload, { api: key, data: payload });
    for (var i = 0; i < matched.length; i++) pushTo(matched[i], entry);
    fireTaps(matched, entry);
    fireTaps(smatched, entry);
  }

  /**
   * 采集一条入站（recvMine 内调用）；口径与日志一致：t===undefined 推送，t 为数字（reqTime）应答；滤心跳（两条通道都滤，见 hbCodes）
   * @param {object} e 原始报文
   * @param {number|undefined} t 应答时刻；推送为 undefined
   * @param {object|null} [ev] 同一拍已构造好的 Event（日志/派发侧付过那次 JSON.parse），有则复用
   */
  function recordInbound(e, t, ev) {
    if (hbCodes.has(e.c)) return;
    var dir = t === undefined ? 'push' : 'resp';
    var matched = matchAny(collectors, dir, e.c);
    var smatched = matchAny(streams, dir, e.c);
    if (!matched.length && !smatched.length) return;
    // 归一化口径与 dispatch/logInbound 一致：data 取 d/pbAck/pbAckV2.data/p；raw 存报文快照（池化对象不可直存）
    var event = ev || new Event(e, t);
    var entry = makeEntry(dir, event.cmd, event.data, snapshotPacket(e), t);
    for (var i = 0; i < matched.length; i++) pushTo(matched[i], entry);
    fireTaps(matched, entry);
    fireTaps(smatched, entry);
  }

  /**
   * 向挂了 tap 的命中采集器逐一发实时刻观测回调（入环之后触发，所见即库存）；
   * entry 为多采集器共享引用且已在环内，只读勿改；异常吞掉并按采集器告警一次，不影响采集与收发
   * @param {Array} matched 命中的采集器列表
   * @param {object} entry 已入环的条目
   */
  function fireTaps(matched, entry) {
    for (var i = 0; i < matched.length; i++) {
      var c = matched[i];
      if (!c.tap) continue;
      try {
        c.tap(entry);
      } catch (err) {
        if (!c.warned) {
          c.warned = true;
          log.warn('collect tap error, ignored.', err);
        }
      }
    }
  }

  /**
   * 依次跑一组订阅者（采集器或流）的 filter 链（(dir,cmd)=>boolean，只接触免费数据），返回全通过的子集；
   * 谓词抛异常视为不通过并按订阅者告警一次，不影响真实收发。list 为 null/空时返回空数组。
   * @param {Array|null} list 订阅者列表（collectors 或 streams）
   * @param {string} dir 大类 req|resp|push
   * @param {number} cmd 命令号
   * @returns {Array} 命中的订阅者列表
   */
  function matchAny(list, dir, cmd) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      var c = list[i],
        ok = true;
      for (var j = 0; j < c.filters.length; j++) {
        try {
          if (!c.filters[j](dir, cmd)) {
            ok = false;
            break;
          }
        } catch (err) {
          if (!c.warned) {
            c.warned = true;
            log.warn('collect filter error, treated as reject.', err);
          }
          ok = false;
          break;
        }
      }
      if (ok) out.push(c);
    }
    return out;
  }

  /**
   * 建一条采集条目（仅在至少一个采集器通过后调用，昂贵字段已在外层算好）
   * @param {string} dir 方向 req:send|req:sendPB|req:sendPBV2|resp|push
   * @param {number} cmd 命令号
   * @param {*} data 归一化业务数据（req 为发送载荷，resp/push 为应答/推送数据）
   * @param {object} raw 快照后的报文/发送载荷
   * @param {number|null} rt 应答的发包时刻 reqTime；其余为 null
   * @returns {object} 条目
   */
  function makeEntry(dir, cmd, data, raw, rt) {
    return {
      dir: dir,
      cmd: cmd,
      name: nameOf(cmd),
      data: data,
      raw: raw,
      ts: Date.now(),
      seq: ++collectSeq,
      rt: rt === undefined ? null : rt,
    };
  }

  /**
   * 写入一个采集器的环形槽：空位直写，写满后 w 回绕静默覆盖最旧条目；O(1)，无搬移
   * @param {object} c 采集器
   * @param {object} entry 条目
   */
  function pushTo(c, entry) {
    var cap = c.buf.length;
    if (c.n === cap) {
      c.buf[c.w] = entry;
      c.w = (c.w + 1) % cap;
    } else {
      c.buf[c.w] = entry;
      c.n++;
      c.w = (c.w + 1) % cap;
    }
  }

  /**
   * 读出环形槽为时序正确的普通数组：绕圈后真实起点不在 [0]，从写指针 w 处切开重接；仅 stop 时执行一次
   * @param {object} c 采集器
   * @returns {Array} 最旧→最新的条目数组
   */
  function readRing(c) {
    if (c.n === 0) return [];
    if (c.n < c.buf.length) return c.buf.slice(0, c.n); // 未绕圈
    return c.buf.slice(c.w).concat(c.buf.slice(0, c.w)); // 绕圈：w 即最旧槽位
  }

  /**
   * 开始一次网络采集的构建器（只建配置面，不启动采集）；终端 .collect() 被调用时才登记入环。
   * 过滤统一走 filter：谓词签名 (dir, cmd)=>boolean，dir 为 req|resp|push 大类，cmd 为命令号；
   * 多个 filter 逐个短路 AND，全部通过（或一个未挂）才采；白/黑名单均由调用方以 Set/条件自表。
   * 实时观测走 tap：签名 (entry)=>void，每条确定入环的条目在入环后回调一次，所见即库存；纯观测不改去留，entry 只读。
   * .log() 为内置观测预设（tapLog 彩色对齐格式），与 tap 同槽位，后挂者覆盖。
   * 性能不变量：filter 只接触免费数据，new Event 与快照仅在至少一个采集器通过后发生。
   * @returns {{capacity: function(number): object, filter: function(Function): object, tap: function(Function): object, log: function(): object, collect: function(): function(): Array}}
   */
  function collecting() {
    /** @type {number} 环形槽上限，缺省 1000 */
    var cap = DEFAULT_COLLECT_CAPACITY;
    /** @type {Array<Function>} 过滤谓词链 */
    var filters = [];
    /** @type {Function|null} 实时观测回调，缺省不挂 */
    var tap = null;
    /** @type {boolean} 终端是否已调用（builder 一次性，防一个 builder 开多个采集器） */
    var started = false;
    // 一次性 builder 的共用守卫：原先 5 个 setter 各抄一遍 throw（同一句文案重复 5 次，改一次要五处对齐）
    var guardStarted = function () {
      if (started) throw new Error('pocketcc.net.collecting: builder already started.');
    };
    var b = {
      /**
       * 设环形槽上限；非正数/非数字回落缺省并告警
       * @param {number} n 最大保留条数
       * @returns {object} this（链式）
       */
      capacity: function (n) {
        guardStarted();
        if (typeof n !== 'number' || !(n > 0)) {
          log.warn('collecting.capacity: invalid %s, fallback to %d.', n, DEFAULT_COLLECT_CAPACITY);
          n = DEFAULT_COLLECT_CAPACITY;
        }
        cap = Math.floor(n);
        return b;
      },
      /**
       * 追加一个过滤谓词 (dir, cmd)=>boolean；须为纯函数且快速返回，抛异常视为不通过
       * @param {Function} fn 谓词
       * @returns {object} this（链式）
       */
      filter: function (fn) {
        guardStarted();
        if (typeof fn !== 'function')
          throw new Error('pocketcc.net.collecting: filter requires a function.');
        filters.push(fn);
        return b;
      },
      /**
       * 挂实时观测回调 (entry)=>void：每条通过全部 filter、即将（已）入环的条目即时回调，用于确认过滤没走偏；
       * 纯观测不参与去留判定，entry 共享引用只读勿改，抛异常视为本次观测失败
       * @param {Function} fn 回调
       * @returns {object} this（链式）
       */
      tap: function (fn) {
        guardStarted();
        if (typeof fn !== 'function')
          throw new Error('pocketcc.net.collecting: tap requires a function.');
        tap = fn;
        return b;
      },
      /**
       * 开启内置实时日志观测（等价 tap(tapLog)：定宽对齐 + dir/cmd 彩色胶囊 + 载荷可展开）；
       * 与 tap 共用同一回调槽位，链上后挂者生效
       * @returns {object} this（链式）
       */
      log: function () {
        guardStarted();
        tap = tapLog;
        return b;
      },
      /**
       * 终端：登记采集器并开始入环
       * @returns {function(): Array} stop 函数；调用即解除采集，返回时序修正后的条目数组（幂等，重复调用同一数组），
       *     数组上附隐藏方法 json()（非枚举，混合格式序列化：外壳缩进、条目单行）；未安装时返回空数组 no-op
       */
      collect: function () {
        guardStarted();
        started = true;
        if (!isInstalled()) {
          log.warn('collect: net not installed.');
          var empty = asCollectResult([]);
          return function () {
            return empty;
          };
        }
        if (!namesBuilt) buildNames(); // 条目带 name，采集路径懒建名表（同 setLog 口径）
        var c = {
          buf: new Array(cap),
          w: 0,
          n: 0,
          filters: filters,
          tap: tap,
          done: false,
          warned: false,
        };
        (collectors || (collectors = [])).push(c);
        syncSendHooks();
        /** @type {Array|null} 首次 stop 后缓存结果，后续调用直接返回 */
        var result = null;
        /**
         * 结束采集并从环形槽导出时序修正后的条目数组
         * @returns {Array} 条目列表（最旧→最新）
         */
        function stop() {
          if (c.done) return result;
          c.done = true;
          result = asCollectResult(readRing(c));
          c.buf = null; // 结果已交给调用方，释放槽引用
          var i = collectors ? collectors.indexOf(c) : -1;
          if (i >= 0) collectors.splice(i, 1);
          syncSendHooks(); // 最后一个采集器停止且 log 关 → 摘发送 hook
          return result;
        }
        c.stop = stop;
        return stop;
      },
    };
    return b;
  }

  /**
   * 常开流式订阅的构建器（与 collecting 同族 filter/tap 语义，但无环形缓冲、无一次性导出）。
   * 供 net-collect 黑匣子驱动：每注册一个流式订阅者即挂发送 hook，每条报文经 filter 链命中后
   * 构造 entry（含快照）并立即回调 tap——不写环、不导出，直到返回的 unstream() 被调用。
   * 与采集器共享同一发送/入站 hook 与 makeEntry/snapshot 口径；心跳同 recordInbound/recordSend 无条件滤除。
   * 性能不变量同 collecting：filter 只接免费 (dir,cmd)，new Event 与快照仅在至少一个订阅者通过后发生。
   * @returns {{filter: function(Function): object, tap: function(Function): object, start: function(): function(): boolean}}
   */
  function stream() {
    /** @type {Array<Function>} 过滤谓词链 */
    var filters = [];
    /** @type {Function|null} 实时回调（必填） */
    var tap = null;
    /** @type {boolean} 终端是否已调用 */
    var started = false;
    // 同 collecting：三个 setter 共用一个守卫，不再各自抄一遍同句 throw
    var guardStarted = function () {
      if (started) throw new Error('pocketcc.net.stream: builder already started.');
    };
    var b = {
      filter: function (fn) {
        guardStarted();
        if (typeof fn !== 'function')
          throw new Error('pocketcc.net.stream: filter requires a function.');
        filters.push(fn);
        return b;
      },
      tap: function (fn) {
        guardStarted();
        if (typeof fn !== 'function')
          throw new Error('pocketcc.net.stream: tap requires a function.');
        tap = fn;
        return b;
      },
      /**
       * 终端：登记流式订阅者并开始逐条回调 tap（net 未安装则拒绝，返回 no-op unstream）
       * @returns {function(): boolean} unstream；调用即解除该订阅者并同步 hook 状态（幂等）
       */
      start: function () {
        guardStarted();
        started = true;
        if (!isInstalled()) {
          log.warn('stream: net not installed.');
          return function () {
            return false;
          };
        }
        if (!tap) throw new Error('pocketcc.net.stream: tap is required.');
        if (!namesBuilt) buildNames();
        var s = { filters: filters, tap: tap, warned: false, done: false };
        (streams || (streams = [])).push(s);
        syncSendHooks();
        return function () {
          if (s.done) return false;
          s.done = true;
          var i = streams ? streams.indexOf(s) : -1;
          if (i >= 0) streams.splice(i, 1);
          syncSendHooks();
          return true;
        };
      },
    };
    return b;
  }

  /**
   * 当前是否有活动流式订阅者
   * @returns {boolean}
   */
  function isStreaming() {
    return !!(streams && streams.length);
  }

  /**
   * 给采集结果数组挂隐藏方法 json()：非枚举属性，对打印/序列化/遍历透明，数组仍是纯数组；
   * 输出混合格式——数组外壳带缩进换行，每个条目单行压缩，合法 JSON，配合 copy() 直达剪贴板
   * @param {Array} a 条目数组
   * @returns {Array} 同一数组，附 json(): string=>JSON 文本
   */
  function asCollectResult(a) {
    Object.defineProperty(a, 'json', {
      enumerable: false,
      value: function () {
        return (
          '[\n' +
          this.map(function (e) {
            return JSON.stringify(e);
          }).join(',\n') +
          '\n]'
        );
      },
    });
    return a;
  }

  /**
   * 热路径记录闸：采集器或流式订阅者任一有条目才值得走 recordSend/recordInbound（长度口径）
   * @returns {boolean}
   */
  function recording() {
    return !!((collectors && collectors.length) || (streams && streams.length));
  }

  /**
   * 发送 hook 挂载需求闸（非 null 口径，与 recording 区分）：空数组也算需求——
   * collecting().collect() 已承诺挂载、还没 stop 的采集器在 collectors 数组里，
   * 避免采集空档期被误摘（net.js wantSendHooks 用）。
   * @returns {boolean}
   */
  function active() {
    return !!collectors || !!streams;
  }

  /**
   * 卸载清场：采集器随 hook 一起作废（stop 返回已采到的条目），流式订阅者一并清空。
   * recvMine 已因 installed=false 不再喂数据；net-collect 待重装后自会重开。
   */
  function reset() {
    while (collectors && collectors.length) collectors[collectors.length - 1].stop();
    collectors = null;
    streams = null;
  }

  return {
    nameOf: nameOf,
    ensureNames: ensureNames,
    logReq: logReq,
    logInbound: logInbound,
    recordSend: recordSend,
    recordInbound: recordInbound,
    recording: recording,
    active: active,
    collecting: collecting,
    stream: stream,
    isStreaming: isStreaming,
    reset: reset,
  };
}
