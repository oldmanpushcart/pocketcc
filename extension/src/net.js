/**
 * pocketcc.net
 */
import { createLog } from './core/log.js';
import { game } from './core/game.js';
import { bus } from './core/bus.js';

(function(){

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
    // 设计：入站复用已有的单一 hook（NetReciver.onMessage）加一行打印；发送侧的三个入口（NET.send/sendPB/sendPBV2）
    // 仅在 log 开启期间挂载 wrapper、关闭即摘除（hot path 不留常驻包装）。不引入 netsniff 的在途配对表/投递令牌/环形缓冲。
    /** @type {boolean} log 总开关；开=挂发送 hook+入站打印，关=摘发送 hook+入站直通 */
    var logEnabled = false;
    /** @type {number} install 时读 net._heartbeatCode（=RequestId.NO_QUEUE_HEART=0，NetMgr.js:153），日志滤心跳防刷屏 */
    var heartbeatCode = -1;
    /** @type {boolean} 重入标志：sendPB 降级会同步转调 this.send（NetMgr.js sendPB 末尾），置位让嵌套 send 跳过打印以消重 */
    var inPB = false;
    /** @type {Object<number,string>|null} cmd -> 常量名 反查表（懒建） */
    var names = null;
    /** @type {boolean} 名表是否已建（日志开启时才建） */
    var namesBuilt = false;
    /** @type {Object<number,number>} pbReqName 已试过的 cmd，避免对未知 cmd 反复调 getReqName */
    var pbTried = {};
    /** @type {object|null|undefined} ProtoBufBiz.instance（undefined=未探测，null=探测失败） */
    var pb = undefined;
    /** @type {Array<{key:string, orig:Function, mine:Function}>} 发送 hook 还原表；有 log/collect 需求时非空 */
    var sendHooks = [];

    // ── 采集（collecting）────────────────────────────────────────────
    /** @type {Array<{buf:Array, w:number, n:number, filters:Array<Function>, tap:Function|null, done:boolean, warned:boolean, stop:Function}>|null} 活动采集器；buf 为预分配环形槽；null=未启用 */
    var collectors = null;
    /** @type {number} 全局自增序号，标注入站/发送 wrapper 两条记录路径的全局先后（并发采集器间共享） */
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
    var NAME_MODULES = ['RequestId', 'NRequestId', 'NRequestIdV2', 'ResponseId', 'NResponseId', 'NResponseIdV2'];

    /** 对外接口面，挂到 window.pocketcc.net（Ret 类因 TDZ 在文件末尾补挂） */
    var api ={
        install: install,
        uninstall: uninstall,
        send: send,
        sendPB: sendPB,
        sendPBV2: sendPBV2,
        isSending: isSending,
        setLog: setLog,
        isLogging: isLogging,
        collecting: collecting
    }

    /**
     * 推送事件，载荷口径与 NetReciver.js:38 一致。
     * 字段：cmd 命令号 / status 状态码 / data 业务数据 / ord 序号 / ts 接收时刻 / raw 原始报文（只读，池化复用）。
     */
    class Event {

        /**
         * 从原始报文归一化出一条推送事件
         * @param {object} e 游戏原始报文（池化复用对象，只读）
         */
        constructor(e) {
            this.cmd = e.c;
            this.status = e.s ?? e.pbAck?.header?.s ?? e.pbAckV2?.header?.s ?? null;
            this.data = Event.#dataOf(e);
            this.ord = (e.o !== undefined && e.o !== null) ? String(e.o) : null;
            this.ts = Date.now();
            this.raw = e;           // 只读：报文对象会被池化复用，别在它上面挂属性
        }

        /**
         * 字符串载荷尝试 JSON.parse；非字符串或解析失败原样返回
         * @param {*} s 载荷
         * @returns {*} 解析后的对象或原值
         */
        static #parseMaybe(s) {
            if (typeof s !== 'string' || !s) return s;
            try { return JSON.parse(s); } catch (e) { return s; }
        }

        /**
         * 按报文形态取业务数据：d（JSON 串）> pbAck > pbAckV2 > p；都取不到返回 null
         * @param {object} e 原始报文
         * @returns {*} 业务数据
         */
        static #dataOf(e) {
            try {
                if (e.d != null) return Event.#parseMaybe(e.d);
                if (e.pbAck != null) return e.pbAck;
                if (e.pbAckV2 != null) return e.pbAckV2;
                if (e.p != null) return Event.#parseMaybe(e.p);
            } catch (err) { }
            return null;
        }

    }

    /**
     * 游戏推送 → bus 事件 net.<cmd>。懒构造：没人订阅该 cmd 就不 new Event（省一次 JSON.parse）。
     * @param {object} e 原始报文
     */
    function dispatch(e) {
        var type = 'net.' + e.c;
        if (!bus.has(type)) return;
        bus.emit(type, new Event(e));
    }

    // ── cmd → 名字 ──────────────────────────────────────────────────────
    /**
     * 自有属性判定（绕过原型链）
     * @param {object} o 目标对象
     * @param {string} k 键
     * @returns {boolean}
     */
    function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

    /**
     * TS 数字枚举对象既含 名→值 也含 值→名；这里把模块导出里所有数字常量收进 into[值]=名（首见者胜）
     * @param {object} ex 模块导出
     * @param {Object<number,string>} into 结果累加表
     * @returns {number} 本次新增条数
     */
    function scanConsts(ex, into) {
        if (!ex || typeof ex !== 'object') return 0;
        var n = 0, k, v, k2, v2;
        for (k in ex) {
            if (!has(ex, k)) continue;
            v = ex[k];
            if (typeof v === 'number' && isFinite(v)) {
                if (into[v] === undefined) { into[v] = k; n++; }
            } else if (v && typeof v === 'object') {
                for (k2 in v) {
                    if (!has(v, k2)) continue;
                    v2 = v[k2];
                    if (typeof v2 === 'number' && isFinite(v2)) {
                        if (into[v2] === undefined) { into[v2] = k2; n++; }
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
        var into = {}, total = 0, i, ex;
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
            } catch (e) { }
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
        } catch (e) { return null; }
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
        if (!n) { n = pbReqName(cmd); if (n) names[cmd] = n; }
        return n || null;
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
     * 入站：t===undefined 为推送，t 为数字（reqTime）为应答（NetMgr.js:578）
     * @param {object} e 原始报文
     * @param {number|undefined} t 应答时刻；推送为 undefined
     */
    function logInbound(e, t) {
        if (e.c === heartbeatCode) return;
        var ev = new Event(e);
        var name = nameOf(ev.cmd) || '<unknown>';
        if (t === undefined) {
            log.info('push %s(%d)%s', name, ev.cmd, ev.status != null ? ' status=' + ev.status : '', ev.data);
        } else {
            log.info('resp %s(%d) status=%s', name, ev.cmd, ev.status, ev.data);
        }
    }

    /**
     * 开关网络日志。开启时懒建 cmd→名字表。
     * @param {boolean} on
     * @returns {boolean} 当前开关态
     */
    function setLog(on) {
        logEnabled = !!on;
        if (logEnabled && !namesBuilt) buildNames();
        syncSendHooks();   // 开则按需挂 hook；关且无采集时摘除，hot path 回到无包装原样
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

    // ── 采集（collecting）────────────────────────────────────────
    /**
     * 深拷贝快照（JSON 往返）：原始报文对象池化复用、发送载荷也可能被后续改写，
     * 采集必须存快照；序列化失败（循环引用等）退回活对象引用，不阻断采集。
     * @param {*} v 待快照的值
     * @returns {*} 快照
     */
    function snapshot(v) {
        try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
    }

    /** @type {Object<string, Array>} tapLog 方向样式：[箭头, 主色]，键按 dir 大类取 */
    const TAP_STYLE = {
        req:  ['→', '#0066CC'],   // 蓝：我发的
        resp: ['←', '#1a7f37'],   // 绿：服务器应答
        push: ['↑', '#b35900'],   // 橙：服务器主动推
    };
    /** @type {string} %c 空串不会重置样式（上一段会拖进下一段），段间必须显式重置 */
    const TAP_RESET = 'color:inherit;font-weight:normal;background:none';

    /**
     * 内置实时观测回调（collecting().log() 的 tap 实现）：定宽列对齐 + dir/cmd 双色胶囊 + 载荷 %O 内联可展开；
     * 控制台为等宽字体，padEnd/padStart 补宽可靠；徽章内文本先补定宽使胶囊等宽，后列才钉得死
     * @param {object} e 采集条目
     */
    function tapLog(e) {
        var s = TAP_STYLE[String(e.dir).split(':')[0]] || ['·', '#888'];
        var badge = 'color:#fff;background:' + s[1] + ';padding:1px 8px;border-radius:4px;font-weight:bold';
        var dirCol = (s[0] + ' ' + e.dir).padEnd(14);   // 最长 '→ req:sendPBV2' = 1+1+12
        var label = e.name == null ? 'UNKNOWN(' + e.cmd + ')' : e.name + '(' + e.cmd + ')';
        label = (label.length > 40 ? label.slice(0, 39) + '…' : label).padEnd(40);
        console.log('#%c' + String(e.seq).padStart(5) + '%c %c' + dirCol + '%c %c' + label + '%c%o',
            'color:#999;padding:0 4px', TAP_RESET,   // seq 预留 5 位，中性灰+留白不抢主体
            badge, TAP_RESET,                        // dir 胶囊（箭头+通道，等宽）
            badge, TAP_RESET,                        // cmd 胶囊（等宽）
            e.raw && e.raw.api ? e.raw.data : e.data);   // req 载荷在 raw.data（e.data 恒 null）
    }

    /**
     * 采集一条发包（send/sendPB/sendPBV2 wrapper 内调用）；sendPB 降级转调 send 时两条都记，保留真实路径
     * @param {string} key 入口名 send|sendPB|sendPBV2
     * @param {number} cmd 命令号
     * @param {object} data 发送载荷
     */
    function recordSend(key, cmd, data) {
        if (cmd === heartbeatCode) return;
        var matched = matchedCollectors('req', cmd);
        if (!matched.length) return;
        // 过滤全部通过后才做昂贵操作（快照）；entry 不可变，多采集器共享同一引用安全
        var entry = makeEntry('req:' + key, cmd, null, { api: key, data: snapshot(data) });
        for (var i = 0; i < matched.length; i++) pushTo(matched[i], entry);
        fireTaps(matched, entry);
    }

    /**
     * 采集一条入站（recvMine 内调用）；口径与日志一致：t===undefined 推送，t 为数字（reqTime）应答；滤心跳
     * @param {object} e 原始报文
     * @param {number|undefined} t 应答时刻；推送为 undefined
     */
    function recordInbound(e, t) {
        if (e.c === heartbeatCode) return;
        var dir = t === undefined ? 'push' : 'resp';
        var matched = matchedCollectors(dir, e.c);
        if (!matched.length) return;
        // 归一化口径与 dispatch/logInbound 一致：data 取 d/pbAck/pbAckV2/p；raw 存报文快照（池化对象不可直存）
        var ev = new Event(e);
        var entry = makeEntry(dir, ev.cmd, ev.data, snapshot(e), t === undefined ? null : t);
        for (var i = 0; i < matched.length; i++) pushTo(matched[i], entry);
        fireTaps(matched, entry);
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
            try { c.tap(entry); } catch (err) {
                if (!c.warned) { c.warned = true; log.warn('collect tap error, ignored.', err); }
            }
        }
    }

    /**
     * 依次跑各采集器的 filter 链（(dir,cmd)=>boolean，只接触免费数据），返回全通过的采集器；
     * 谓词抛异常视为不通过并按采集器告警一次，不影响真实收发
     * @param {string} dir 大类 req|resp|push
     * @param {number} cmd 命令号
     * @returns {Array} 命中的采集器列表
     */
    function matchedCollectors(dir, cmd) {
        var out = [];
        for (var i = 0; i < collectors.length; i++) {
            var c = collectors[i], ok = true;
            for (var j = 0; j < c.filters.length; j++) {
                try {
                    if (!c.filters[j](dir, cmd)) { ok = false; break; }
                } catch (err) {
                    if (!c.warned) { c.warned = true; log.warn('collect filter error, treated as reject.', err); }
                    ok = false; break;
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
     * @param {*} data 归一化业务数据（req 为 null，载荷在 raw.data）
     * @param {object} raw 快照后的报文/发送载荷
     * @param {number|null} rt 应答的发包时刻 reqTime；其余为 null
     * @returns {object} 条目
     */
    function makeEntry(dir, cmd, data, raw, rt) {
        return { dir: dir, cmd: cmd, name: nameOf(cmd), data: data, raw: raw, ts: Date.now(), seq: ++collectSeq, rt: rt === undefined ? null : rt };
    }

    /**
     * 写入一个采集器的环形槽：空位直写，写满后 w 回绕静默覆盖最旧条目；O(1)，无搬移
     * @param {object} c 采集器
     * @param {object} entry 条目
     */
    function pushTo(c, entry) {
        var cap = c.buf.length;
        if (c.n === cap) { c.buf[c.w] = entry; c.w = (c.w + 1) % cap; }
        else { c.buf[c.w] = entry; c.n++; c.w = (c.w + 1) % cap; }
    }

    /**
     * 读出环形槽为时序正确的普通数组：绕圈后真实起点不在 [0]，从写指针 w 处切开重接；仅 stop 时执行一次
     * @param {object} c 采集器
     * @returns {Array} 最旧→最新的条目数组
     */
    function readRing(c) {
        if (c.n === 0) return [];
        if (c.n < c.buf.length) return c.buf.slice(0, c.n);           // 未绕圈
        return c.buf.slice(c.w).concat(c.buf.slice(0, c.w));          // 绕圈：w 即最旧槽位
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
        var b = {
            /**
             * 设环形槽上限；非正数/非数字回落缺省并告警
             * @param {number} n 最大保留条数
             * @returns {object} this（链式）
             */
            capacity: function (n) {
                if (started) throw new Error('pocketcc.net.collecting: builder already started.');
                if (typeof n !== 'number' || !(n > 0)) { log.warn('collecting.capacity: invalid %s, fallback to %d.', n, DEFAULT_COLLECT_CAPACITY); n = DEFAULT_COLLECT_CAPACITY; }
                cap = Math.floor(n);
                return b;
            },
            /**
             * 追加一个过滤谓词 (dir, cmd)=>boolean；须为纯函数且快速返回，抛异常视为不通过
             * @param {Function} fn 谓词
             * @returns {object} this（链式）
             */
            filter: function (fn) {
                if (started) throw new Error('pocketcc.net.collecting: builder already started.');
                if (typeof fn !== 'function') throw new Error('pocketcc.net.collecting: filter requires a function.');
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
                if (started) throw new Error('pocketcc.net.collecting: builder already started.');
                if (typeof fn !== 'function') throw new Error('pocketcc.net.collecting: tap requires a function.');
                tap = fn;
                return b;
            },
            /**
             * 开启内置实时日志观测（等价 tap(tapLog)：定宽对齐 + dir/cmd 彩色胶囊 + 载荷可展开）；
             * 与 tap 共用同一回调槽位，链上后挂者生效
             * @returns {object} this（链式）
             */
            log: function () {
                if (started) throw new Error('pocketcc.net.collecting: builder already started.');
                tap = tapLog;
                return b;
            },
            /**
             * 终端：登记采集器并开始入环
             * @returns {function(): Array} stop 函数；调用即解除采集，返回时序修正后的条目数组（幂等，重复调用同一数组），
             *     数组上附隐藏方法 json()（非枚举，混合格式序列化：外壳缩进、条目单行）；未安装时返回空数组 no-op
             */
            collect: function () {
                if (started) throw new Error('pocketcc.net.collecting: builder already started.');
                started = true;
                if (!installed) {
                    log.warn('collect: net not installed.');
                    var empty = asCollectResult([]);
                    return function () { return empty; };
                }
                if (!namesBuilt) buildNames();   // 条目带 name，采集路径懒建名表（同 setLog 口径）
                var c = { buf: new Array(cap), w: 0, n: 0, filters: filters, tap: tap, done: false, warned: false };
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
                    c.buf = null;   // 结果已交给调用方，释放槽引用
                    var i = collectors ? collectors.indexOf(c) : -1;
                    if (i >= 0) collectors.splice(i, 1);
                    syncSendHooks();   // 最后一个采集器停止且 log 关 → 摘发送 hook
                    return result;
                }
                c.stop = stop;
                return stop;
            }
        };
        return b;
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
                return '[\n' + this.map(function (e) { return JSON.stringify(e); }).join(',\n') + '\n]';
            },
        });
        return a;
    }


    /**
     * 挂到 NetReciver.getInstance().onMessage —— 游戏自己的推送分发器。
     * NetMgr.js:578 每处理一条报文就实时属性查找调它一次，替换实例方法即可被看到，
     * 没有 NetMgr.js:160 那个 bind 陷阱：单点、无嵌套、可干净还原。
     * 缓存态（disableOnMessage）的报文根本到不了 578，等重放（NetMgr.js:104）时才走这里，天然只派发一次。
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
            // t 由 NetMgr.js:578 传入：推送 = void 0，应答 = _.reqTime（数字，见 :247/:327/:419）
            // 先调 orig 让游戏自己的推送处理器跑完（NetReciver.js:34-44），再派发给我们的 listener
            var ret = recvOrig.apply(this, arguments);
            if (installed && e) {
                if (logEnabled) {
                    try { logInbound(e, t); } catch (err) { log.warn('log inbound cmd[%d] occur error!', e.c, err); }
                }
                if (t === undefined) {
                    try { dispatch(e); } catch (err) { log.warn('dispatch cmd[%d] occur error!', e.c, err); }
                }
                if (collectors && collectors.length) { try { recordInbound(e, t); } catch (err) { } }
            }
            return ret;
        };
        inst.onMessage = recvMine;
        return true;
    }

    /**
     * 包装一个发送入口（NET.send/sendPB/sendPBV2）：实例属性遮蔽原型方法，同 netsniff 口径，可对称还原。
     * wrapper 只读 cmd/data 做日志打印与采集记录（各自判开关），原样透传 arguments 与返回值——不碰 success 回调（应答日志/采集走 recvMine）。
     * 任何日志异常都吞掉，绝不影响真实发送。
     * @param {string} key send|sendPB|sendPBV2
     * @returns {object|null} 还原条目 {key,orig,mine}；入口缺失返回 null
     */
    function wrapSend(key) {
        var orig = net[key];
        if (typeof orig !== 'function') {
            log.warn('NET.%s is missing, skip send log hook.', key);
            return null;
        }
        var mine = function (cmd, data) {
            if (collectors && collectors.length) recordSend(key, cmd, data);
            if (logEnabled) {
                try {
                    // 滤心跳；sendPB/V2 降级会同步转调 this.send，inPB 置位时跳过嵌套 send 的重复打印。
                    // 传活对象给 console（展开即见），不做深拷贝——stringify+parse 每条发包一次太贵（真机反馈卡）
                    if (cmd !== heartbeatCode && !(key === 'send' && inPB)) {
                        logReq(key, cmd, data);
                    }
                } catch (e) { }
            }
            if (key === 'send') return orig.apply(this, arguments);
            inPB = true;
            try { return orig.apply(this, arguments); } finally { inPB = false; }
        };
        net[key] = mine;
        return { key: key, orig: orig, mine: mine };
    }

    /**
     * 发送 hook 挂载闸门：log 开启或有活动采集器时保持挂载，两者都没有即摘除。
     * 空数组也算需求（collecting().collect() 已承诺挂载、还没 stop 的采集器在 collectors 数组里），
     * 所以只在「从未 collect 且 log 关」时返回 false，避免采集空档期被误摘。
     * @returns {boolean} 当前是否应有 hook 挂载需求
     */
    function wantSendHooks() {
        return logEnabled || !!collectors;
    }

    /**
     * 按需挂载全部发送入口 hook（幂等：已挂则不重复包）
     * @returns {number} 当前已挂 hook 数
     */
    function hookSend() {
        if (sendHooks.length) return sendHooks.length;   // 幂等：已挂不重复包
        var keys = ['send', 'sendPB', 'sendPBV2'];
        for (var i = 0; i < keys.length; i++) {
            var h = wrapSend(keys[i]);
            if (h) sendHooks.push(h);
        }
        return sendHooks.length;
    }

    /**
     * 摘发送 hook：仅当最外层还是我们的包装时才还原；被别人又包了一层就跳过，退化成直通
     */
    function unhookSend() {
        for (var i = sendHooks.length - 1; i >= 0; i--) {
            var h = sendHooks[i];
            if (net && net[h.key] === h.mine) net[h.key] = h.orig;
        }
        sendHooks = [];
    }

    /**
     * 同步发送 hook 挂载状态（log/collect 共用同一组 wrapper，wrapper 内部各自判开关）
     */
    function syncSendHooks() {
        if (wantSendHooks()) hookSend(); else unhookSend();
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
        if(installed) return true;
        var netMgr = game.get('NetMgr');
        net = netMgr && netMgr.NET;
        if (!net) {
            log.warn('install failed, NetMgr is missing.');
            return false;
        }
        if (!hook()) return false;
        heartbeatCode = (typeof net._heartbeatCode === 'number') ? net._heartbeatCode : -1;
        installed = true;
        // 发送 hook 由 log/collect 共同驱动（syncSendHooks 管理）；此处只兜底"先开 log/collect 后 install"的顺序
        if (wantSendHooks()) hookSend();
        log.info('installed. heartbeatCode=%d;log=%s', heartbeatCode, logEnabled);
        return true;
    }

    /**
     * 卸载
     * @returns {boolean} 卸载成功
     */
    function uninstall() {
        if(!installed) return true;
        installed = false;
        unhook();
        // 采集器随 hook 一起作废：stop 返回已采到的条目
        while (collectors && collectors.length) collectors[collectors.length - 1].stop();
        collectors = null;
        log.info('uninstalled.');
        return true;
    }

    /**
     * 发送应答超时（毫秒）。NetMgr.send 把回调存进 _requestPacks[gid]，只在收到匹配应答时触发；
     * 我们以 ensureServerResponse=false 发送（NetMgr.js:382,421，:592 仅 true 才重发），
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
                reject(new Error(label + ' [' + cmd + '] no server response in ' + SEND_TIMEOUT_MS + 'ms.'));
            }, SEND_TIMEOUT_MS);
            p.then(
                function (v) { clearTimeout(timer); resolve(v); },
                function (e) { clearTimeout(timer); reject(e); }
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
        return withTimeout(new Promise((resolve, reject) => {
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
        }), cmd, 'Send');
    }

    /**
     * 带PB的发送网络请求
     * @param {number} cmd 命令号
     * @param {object} data 数据
     * @returns {Promise<Ret>} 请求结果
     */
    function sendPB(cmd, data) {
        return withTimeout(new Promise((resolve, reject) => {
            const ok = net.sendPB(cmd, data, null, (ret) => {
                try {
                    const s = ret.pbAck.header.s;
                    const d = ret.pbAck.data;
                    resolve(Ret.from(s, d));
                } catch (e) {
                    reject(e);
                }
            })
        }), cmd, 'SendPB');
    }

    /**
     * 带PB的V2发送网络请求
     * @param {number} cmd 命令号
     * @param {object} data 数据
     * @returns {Promise<Ret>} 请求结果
     */
    function sendPBV2(cmd, data) {
        return withTimeout(new Promise((resolve, reject) => {
            const ok = net.sendPBV2(cmd, data, null, (ret) => {
                try {
                    const s = ret.pbAckV2.header.s;
                    const d = ret.pbAckV2.data;
                    resolve(Ret.from(s, d));
                } catch (e) {
                    reject(e);
                }
            });
            if (!ok) {
                reject(new Error('SendPBV2 [' + cmd + '] failed.'));
            }
        }), cmd, 'SendPBV2');
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
    // 扩展内不自启：由 main.js 在登录成功、场景就绪后调用 install()

})();
