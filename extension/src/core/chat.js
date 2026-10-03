/**
 * pocketcc.chat
 * 游戏聊天通道（NetChatClient，socket.io 独立长连接）的薄封装：
 * 借用游戏自管的连接（auth/bind/故障转移/重连均不干预），只开五个面——
 *   发包：send() 文本消息走主协议 PostChatMsg(670)（真机实测口径：发送走主 socket，回声经聊天 socket 推 newChatPush）；
 *         sharePos() 发坐标分享链接（同 670，m="link" + llm 载荷）；sendEmoji() 发表情（m="link"+id + custom 载荷）；
 *   读数据：history/historyRooms/olderHistory/unread/markRead 走 sendProxy 隧道拉历史/未读/标已读（已破解 sign：md5(参数拼串+time)，插入序+字母序两套）；
 *         summary() 会话摘要+@气泡、pmList() 私聊会话列表、aroundHistory() 按 uuid 定位上下文（同 sendProxy 隧道）；
 *         systemMessages() 走主协议 PBV2 GET_CHAT_PUSH_LIST 查服务器系统消息（fu="-1" 条目，与频道历史合并）；
 *         proxy() 为 sendProxy 的 {url,query,body} 隧道通用底层（REST 代理），Promise 化 + 超时防挂死；
 *   收信：on/off 把 EventCenter 转发的聊天推送（newChatPush 等）映射为语义 type；normalize()/parseLink() 把两种推送 schema 归一为可渲染对象；
 *   日志：setLog 期间包 sendProxy 打印出站与应答 + 订阅聊天事件打印入站，关闭即摘。
 * 房间跟随游戏 _rooms（世界/联盟等由游戏自己 addRoom），本模块不 join/leave、不改写游戏任何状态。
 * 参照 net.js 口径：单点 hook、先跑原函数再打印、只当最外层还是自己时才还原。
 */
import { createLog } from './log.js';
import { game } from './game.js';
import { getUid } from './player.js';

(function(){

    'use strict';

    /** @type {ReturnType<createLog>} 模块日志器（tag=CHAT） */
    const log = createLog('CHAT');

    /** @type {object|null} NetChatClient 伪静态类单例（game.get('NetChatClient').default） */
    var client = null;
    /** @type {boolean} 封装层是否已安装 */
    var installed = false;

    /** @type {boolean} 聊天日志总开关 */
    var logEnabled = false;
    /** @type {Function|null} 原 sendProxy */
    var proxyOrig = null;
    /** @type {Function|null} 我们的 sendProxy 包装 */
    var proxyMine = null;
    /** @type {boolean} client 上 sendProxy 原本是否为自有属性（决定还原用赋值还是 delete） */
    var proxyOwn = false;
    /** @type {boolean} sendProxy 当前是否已被包装 */
    var proxyHooked = false;
    /** @type {Array<Function>} 日志期入站订阅的退订句柄 */
    var logInboundOffs = [];

    /**
     * 应答超时（毫秒）。socket.emit("proxy") 的 ack 回调只在服务器应答时触发；
     * 不应答则 sendProxy 的 ok/err 永不执行、Promise 永挂，口径同 net.js SEND_TIMEOUT_MS。
     */
    const SEND_TIMEOUT_MS = 15000;

    /**
     * 语义 type → EventCenter 事件名（NetChatClient 把 socket 事件转成这些游戏事件广播）。
     * 注意 del 取 chatdel：socket 的 chatdel 被游戏双重转发为 chatMsgDelete+chatdel，订一个即可。
     * @type {Object<string,string>}
     */
    const EVENT_MAP = {
        push: 'newChatPush',
        pm: 'chatpushpm',
        update: 'chatupdate',
        del: 'chatdel',
        reconnect: 'NETCHATCLIENT_RECONNECT',
    };

    /** @type {number|null} PostChatMsg 命令号（懒查 RequestId，查不到回落真机观测值 670） */
    var postCmd = null;

    /** @type {number|null} GET_CHAT_PUSH_LIST 命令号（懒查 NRequestIdV2，查不到回落源码观测值 954） */
    var sysCmd = null;

    /**
     * 频道语义预设：名称 → PostChatMsg 的 c 值。
     * 真机 2026-09-26 已验证：world=0（世界）、pm=1（私聊，opts.uid 必填）、alliance=2（联盟）。
     * 其余来源：chatCommon.CHAT_CHANNEL_TYPE 枚举（未逐一经流量验证，供参考）：
     *   cross=3 跨服 / mod=4 置顶 / group=5 群聊（opts.group 填 roomId）/ kvk=6 / cab=7 秘书组 / transfer=8 转会 / language=9 语种。
     * 未预设频道直接传 opts.c=数字即可。
     * @type {Object<string,number>}
     */
    const CHANNELS = { world: 0, pm: 1, alliance: 2, cross: 3, mod: 4, group: 5, kvk: 6, cab: 7, transfer: 8, language: 9 };

    /**
     * 聊天服务器固定应用号（真机与 newChatController 均硬编 102，入 sign 拼串首位）。
     * @type {number}
     */
    const APP_ID = 102;

    /** 对外接口面，挂到 window.pocketcc.chat（Ret 类因 TDZ 在文件末尾补挂） */
    var api = {
        install: install,
        uninstall: uninstall,
        isConnected: isConnected,
        status: status,
        socket: socket,
        send: send,
        sharePos: sharePos,
        sendEmoji: sendEmoji,
        channels: CHANNELS,
        chatHeads: chatHeads,
        proxy: proxy,
        history: history,
        historyRooms: historyRooms,
        olderHistory: olderHistory,
        unread: unread,
        markRead: markRead,
        summary: summary,
        pmList: pmList,
        aroundHistory: aroundHistory,
        systemMessages: systemMessages,
        toSysItem: toSysItem,
        normalize: normalize,
        parseLink: parseLink,
        on: on,
        off: off,
        setLog: setLog,
        isLogging: isLogging,
    };

    /**
     * 安装：取 NetChatClient 单例并校验关键方法在场。模块在页面加载期即注册，无场景时机依赖；
     * 各 API 首用时懒兜底 install（同 event.on 模式），boot.js 不显式调用。
     * @returns {boolean} 安装成功
     */
    function install() {
        if (installed) return true;
        var mod = game.get('NetChatClient');
        var c = mod && mod.default;
        if (!c || typeof c.sendProxy !== 'function' || typeof c.IsValid !== 'function') {
            log.warn('install failed, NetChatClient is missing.');
            return false;
        }
        client = c;
        installed = true;
        log.info('installed.');
        return true;
    }

    /**
     * 卸载：摘日志 hook、退订日志期订阅、清引用（最后防线；调用方自发退订走 on 返回的 unsubscribe）。
     * @returns {boolean} 卸载成功
     */
    function uninstall() {
        if (!installed) return true;
        if (logEnabled) setLog(false);
        installed = false;
        client = null;
        log.info('uninstalled.');
        return true;
    }

    /**
     * 聊天 socket 是否已连接（委托游戏 IsValid()：socket 在场且 _netIsValid）
     * @returns {boolean}
     */
    function isConnected() {
        if (!installed && !install()) return false;
        return !!client.IsValid();
    }

    /**
     * 连接状态只读快照（DevTools 排查用：connected / 当前 socketIp / 游戏已加入的房间列表）
     * @returns {object} {connected:boolean, socketIp:string, rooms:string[]}；rooms 为拷贝，不共享游戏数组引用
     */
    function status() {
        if (!installed && !install()) return { connected: false, socketIp: '', rooms: [], error: 'NetChatClient missing' };
        var rooms = [];
        try { rooms = (client._rooms || []).slice(); } catch (e) { }
        return { connected: !!client.IsValid(), socketIp: client._socketIp || '', rooms: rooms };
    }

    /**
     * 只读枚举游戏频道会话列表（newChatController.Instance.getAllChatList()：摊平 _chatList，
     * 与游戏 UI 当前选中频道无关；条目形如 {Channel, Id, Name}，这里拷出脱引用）。
     * 用途：动态频道（群聊 5 等）的进房是惰性的——玩家没在游戏里打开过该频道时，服务器还没
     * push roomChatChange/NetChatClient 未 addRoom，收不到推信也学不到 roomId（群聊发送的
     * group 字段必填，chatCommon.dataSameWithGroupSpecial=[5]），从频道头列表兜底发现。
     * 注：读 Instance 静态 getter 在游戏侧会懒初始化聊天控制器（登录流程本就会创建，幂等）。
     * @returns {Array<{channel:number, id:string, name:string}>} 未初始化/异常返回空数组
     */
    function chatHeads() {
        try {
            var m = game.get('newChatController');
            var cls = m && m.newChatController;
            var inst = cls && cls.Instance;
            if (!inst || typeof inst.getAllChatList !== 'function') return [];
            var list = inst.getAllChatList() || [];
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                if (!it) continue;
                out.push({ channel: Number(it.Channel), id: String(it.Id || ''), name: String(it.Name || '') });
            }
            return out;
        } catch (e) { return []; }
    }

    /**
     * 底层 socket.io 对象逃生口（调试用；勿在其上常驻 on() 监听——重连换 socket 实例会丢订阅，
     * 收消息一律走 on()/pocketcc.event 路径）
     * @returns {object|null} 未连接/模块缺失返回 null
     */
    function socket() {
        if (!installed && !install()) return null;
        try { return client.socket ? client.socket() : null; } catch (e) { return null; }
    }

    /**
     * 给一个 proxy 应答归一化：解析成功的应答对象取 code；解析失败时游戏把原始字符串传进 err 回调
     * @param {object|string} r sendProxy ok/err 回调实参
     * @returns {Ret} 应答结果
     */
    function toRet(r) {
        var code = (r && typeof r === 'object') ? (r.code != null ? r.code : null) : null;
        return Ret.from(code, r);
    }

    /**
     * 懒解析 PostChatMsg 命令号（RequestId 枚举；查不到回落真机观测值 670，防模块改版时静默错发）
     * @returns {number} 命令号
     */
    function resolvePostCmd() {
        if (postCmd != null) return postCmd;
        var v = null;
        try {
            var m = game.get('RequestId');
            if (m) {
                if (typeof m.PostChatMsg === 'number') v = m.PostChatMsg;
                else if (m.RequestId && typeof m.RequestId.PostChatMsg === 'number') v = m.RequestId.PostChatMsg;
            }
        } catch (e) { }
        postCmd = (v != null) ? v : 670;
        if (v == null) log.warn('PostChatMsg not found in RequestId, fallback to observed 670.');
        return postCmd;
    }

    /**
     * 懒解析 GET_CHAT_PUSH_LIST 命令号（NRequestIdV2 枚举；查不到回落源码观测值 954，防改版静默错发）
     * @returns {number} 命令号
     */
    function resolveSysCmd() {
        if (sysCmd != null) return sysCmd;
        var v = null;
        try {
            var m = game.get('NRequestIdV2');
            if (m) {
                if (typeof m.GET_CHAT_PUSH_LIST === 'number') v = m.GET_CHAT_PUSH_LIST;
                else if (m.NRequestIdV2 && typeof m.NRequestIdV2.GET_CHAT_PUSH_LIST === 'number') v = m.NRequestIdV2.GET_CHAT_PUSH_LIST;
            }
        } catch (e) { }
        sysCmd = (v != null) ? v : 954;
        if (v == null) log.warn('GET_CHAT_PUSH_LIST not found in NRequestIdV2, fallback to observed 954.');
        return sysCmd;
    }

    /**
     * 当前服务器秒时刻（游戏 getCustomInfo 拼 clientTime/fClientTime 的同源字段 DataCenter.DATA.ServerTime）；
     * 探不到回落本地时间。
     * @returns {number}
     */
    function serverTimeSec() {
        try {
            var dc = game.get('DataCenter');
            var st = dc && dc.DATA && dc.DATA.ServerTime;
            if (st != null) return Math.floor(+st);
        } catch (e) { }
        return Math.floor(Date.now() / 1000);
    }

    /**
     * 当前玩家 StrUid（游表口径：custom.fUid / clientTime 用 StrUid，快速登录模式下与 UID 不同；
     * UID 取不到时回落到 getUid()）。
     * @returns {string}
     */
    function getStrUid() {
        try {
            var dc = game.get('DataCenter');
            var s = dc && dc.DATA && dc.DATA.UserData && dc.DATA.UserData.StrUid;
            if (s != null && s !== '') return String(s);
        } catch (e) { }
        var u = getUid();
        return u != null ? String(u) : '';
    }

    /**
     * 拼 custom 字段（游表 newChatController.getCustomInfo 同构：时间基准 ServerTime，fUid=StrUid）。
     * 默认值对齐实发样本；opts 可透传 atData/responseData/lang/richParas/mod 等高级字段。
     * @param {string} uid 当前玩家 UID（getUid()）
     * @param {object} [opts] {mod,modPic,officialTitle,modid,atData,responseData,lang,richParas,fUid}
     * @param {number} [chan] 生效频道号（联盟/群聊 @点名时游表另拼 mentionType/mentionUidList，缺它服务器点名解析错乱）
     * @returns {string} JSON 字符串
     */
    function defaultCustom(uid, opts, chan) {
        opts = opts || {};
        var sec = serverTimeSec();
        var fUid = opts.fUid != null ? String(opts.fUid) : (getStrUid() || uid || '');
        var o = {
            mod: opts.mod != null ? opts.mod : '',
            modPic: opts.modPic != null ? opts.modPic | 0 : 0,
            officialTitle: opts.officialTitle != null ? opts.officialTitle | 0 : -1,
            clientTime: String(sec) + fUid,
            responseData: opts.responseData != null ? opts.responseData : null,
            atData: opts.atData != null ? opts.atData : null,
            modid: opts.modid != null ? opts.modid | 0 : 0,
            fUid: fUid,
            fClientTime: sec,
            lang: opts.lang || 'zh_cn',
            richParas: opts.richParas || [],
        };
        // 游表 getCustomInfo:1576-1587 同口径：联盟(2)/群聊(5)带 @点名 时必附
        // mentionType=2 + mentionUidList（逗号串）——服务器靠它识别点名对象，缺了会把回声 m 拼脏
        var at = o.atData;
        if (at && at.name && at.name.length && (chan === CHANNELS.alliance || chan === CHANNELS.group)) {
            o.mentionType = 2;
            o.mentionUidList = (at.uid || []).join(',');
        }
        return JSON.stringify(o);
    }

    /**
     * 发文本消息（主协议 PostChatMsg，真机探得口径，字段表见 references/聊天.md；
     * 应答走主 socket（status=0；ret.data 为应答字符串原文，net 不做 JSON_PARSE——成功时是
     * '{"success":1,m:...}' JSON 串需自行 parse 判 success===1，业务拒时为 '<文案键,参数>' 裸串 parse 得 null），
     * 消息回声另经聊天 socket 推回：
     * 频道消息（世界/联盟）→ newChatPush，私聊 → chatpushpm，不等价于本 Promise）。
     * @param {string} text 消息文本
     * @param {object} [opts] 选项：{channel 'world'|'pm'|'alliance'（缺省 world，显式传数字 c 可越过预设）,
     *     c 频道号, uid 私聊目标 UID（channel='pm' 时必填）, group, llm, custom 字符串（传 null 用生成值）}
     * @returns {Promise<net.Ret>} 主协议应答（ret.ok && JSON.parse(ret.data).success===1 才是发送成功）
     */
    function send(text, opts) {
        var net = window.pocketcc && window.pocketcc.net;
        if (!net) return Promise.reject(new Error('chat.send: pocketcc.net unavailable.'));
        if (typeof text !== 'string' || !text) return Promise.reject(new Error('chat.send: empty text.'));
        opts = opts || {};
        var channel = opts.channel || 'world';
        var c = opts.c;
        if (c == null) {
            if (typeof channel === 'number') c = channel;
            else if (CHANNELS[channel] != null) c = CHANNELS[channel];
            else return Promise.reject(new Error('chat.send: unknown channel ' + channel + ' (use opts.c for non-preset channels).'));
        }
        if (c === CHANNELS.pm && (opts.uid == null || opts.uid === '')) {
            return Promise.reject(new Error('chat.send: pm channel requires opts.uid (target UID).'));
        }
        var uid = getUid() || '';
        var pack = {
            c: c,                                                        // 频道号：世界=0、私聊=1、联盟=2，群聊=5 等见 chatCommon.CHAT_CHANNEL_TYPE
            m: text,
            uid: opts.uid != null ? String(opts.uid) : '',              // 私聊目标；频道消息为空
            llm: opts.llm != null ? opts.llm : '',                       // 特殊消息载荷（表情/坐标等），纯文本留空
            custom: opts.custom != null ? opts.custom : defaultCustom(uid, opts, c),
            group: opts.group != null ? opts.group : '',                 // 群聊(5)时填 roomId，其他频道为空串
        };
        return net.send(resolvePostCmd(), pack);
    }

    /**
     * 发坐标分享链接（真机 2026-09-26 实证：同 PostChatMsg，m="link"，llm={t:0, st, p:{x,y,z}, ...} JSON 串）。
     * @param {number} x 世界坐标 x
     * @param {number} y 世界坐标 y
     * @param {object} [opts] 选项：{channel（缺省 world）, uid 私聊目标, z 服号（缺省当前服，可显式指定）,
     *     st 目标物类型（实测 3=野怪点、4=玩家基地，缺省 4）, s 展示文案, icon, sk 怪名语言键, sMap, llm 整体覆盖载荷对象}
     * @returns {Promise<net.Ret>} 主协议应答
     */
    function sharePos(x, y, opts) {
        opts = opts || {};
        var payload = opts.llm && typeof opts.llm === 'object' ? opts.llm : {
            t: 0,                                        // 链接子类型：0=位置类
            st: opts.st != null ? opts.st | 0 : 4,       // 目标物类型：3=野怪/资源点，4=玩家基地
            p: { x: x | 0, y: y | 0, z: opts.z != null ? opts.z | 0 : (getServerId() | 0) },
            s: opts.s != null ? String(opts.s) : (x | 0) + ',' + (y | 0),
            uts: 1,
        };
        if (opts.icon != null && payload.icon == null) payload.icon = opts.icon;
        if (opts.sk != null && payload.sk == null) payload.sk = opts.sk;
        if (opts.sMap != null && payload.sMap == null) payload.sMap = opts.sMap | 0;
        var rest = {};
        for (var k in opts) if (k !== 'llm' && k !== 'st' && k !== 's' && k !== 'z' && k !== 'icon' && k !== 'sk' && k !== 'sMap') rest[k] = opts[k];
        return send('link', Object.assign({ llm: JSON.stringify(payload) }, rest));
    }

    /**
     * 当前服号（坐标 z 值）：读 DataCenter.DATA.UserData.ServerId（游戏地图模块拼分享坐标的同源字段），
     * 探不到返回 0，由调用方显式传 opts.z。
     * @returns {number}
     */
    function getServerId() {
        try {
            var dc = game.get('DataCenter');
            var id = dc && dc.DATA && dc.DATA.UserData && dc.DATA.UserData.ServerId;
            if (id != null) return +id | 0;
        } catch (e) { }
        return 0;
    }

    /**
     * 发表情（源码 newChatController.sendChatEmotionInfo 口径：m="link"+emotionId，
     * llm 传空串，custom 整体被替为 {emotionId,t}（不再用默认 custom）。
     * 注：收侧回声会把表情信息回填到 llm、custom 置 null（服端行为），与本函数的出站形制不同。
     * @param {number|string} emotionId 表情 id
     * @param {object} [opts] 选项：{channel（缺省 world）, uid 私聊目标, t 表情子类型（缺省 2）}
     * @returns {Promise<net.Ret>} 主协议应答
     */
    function sendEmoji(emotionId, opts) {
        opts = opts || {};
        var id = +emotionId;
        if (!id) return Promise.reject(new Error('chat.sendEmoji: emotionId required.'));
        var custom = JSON.stringify({ emotionId: id, t: opts.t != null ? opts.t | 0 : 2 });
        var rest = {};
        for (var k in opts) if (k !== 't') rest[k] = opts[k];
        return send('link' + id, Object.assign({ llm: '', custom: custom }, rest));
    }

    /**
     * 走聊天 proxy 隧道发包（emit("proxy", {url,query,body}, ack)）。
     * 未连接立即 reject——游戏 sendProxy 内部 IsValid 不过会静默丢弃、回调永不触发。
     * ok/err 两条回调都 resolve（业务成败看 Ret.ok = code===1，服务器拒绝也是有效应答）；
     * 仅超时/传输失败 reject。
     * @param {string} url 业务 url（如聊天服务器 REST 风格路径）
     * @param {object|null} [query] query 参数对象
     * @param {string|object|null} [body] body 载荷
     * @returns {Promise<Ret>} 应答结果
     */
    function proxy(url, query, body) {
        return withTimeout(new Promise(function (resolve, reject) {
            if (!installed && !install()) return reject(new Error('Chat proxy: NetChatClient is missing.'));
            if (!client.IsValid()) return reject(new Error('Chat proxy [' + url + ']: socket not connected.'));
            var settle = function (r) {
                try { resolve(toRet(r)); } catch (e) { reject(e); }
            };
            try {
                client.sendProxy(url, settle, query || null, body || '', settle);
            } catch (e) {
                reject(e);
            }
        }), 'Proxy [' + url + ']');
    }

    /**
     * 聊天服务器 REST 基址：读登录时服务器下发的 newChatController.url（静态，
     * 真机值如 http://chat-api-v5-cn-ali-inner.rivergame.net）；未登录/探不到返回空串。
     * @returns {string}
     */
    function apiBase() {
        try {
            var m = game.get('newChatController');
            var cls = m && m.newChatController;
            if (cls && cls.url) return cls.url;
        } catch (e) { }
        return '';
    }

    /**
     * 复用游戏自带 md5（与 newChatController 拼 sign 同一实现：SafeUtils.default.md5），保证与服务端验签一致。
     * @param {string} s
     * @returns {string} 32 位小写 hex
     */
    function md5(s) {
        var m = game.get('SafeUtils');
        var f = m && m.default && m.default.md5;
        if (typeof f !== 'function') throw new Error('chat: md5 unavailable via SafeUtils.');
        return f(s);
    }

    /**
     * 生成 query 签名（真机 2026-09-26 源码 + 双样本验证）：
     * sign = md5( 各参数按序拼 key+value 的连接 + time值 )，time 已含在 params 内（拼接时多尾接一次）。
     * @param {object} params 不含 sign 的参数对象（含 time）
     * @param {boolean} sort true=按 key 字母序（getStringFromParmsSort，getUnread/markRead 系），false=插入序（loadPmChat/loadHistory 系）
     * @returns {string} sign
     */
    function signParams(params, sort) {
        var keys = sort ? Object.keys(params).sort() : Object.keys(params);
        var s = '';
        for (var i = 0; i < keys.length; i++) { var k = keys[i]; if (k !== 'sign') s += k + params[k]; }
        return md5(s + params.time);
    }

    /**
     * 带签名的聊天服务器 GET（经 proxy 隧道）：自动补 time 与 sign，基址取 newChatController.url。
     * @param {string} path 端点路径（如 /pm/loadPmChat）
     * @param {object} params 业务参数（不含 time/sign；插入序端点需自行保证 key 顺序）
     * @param {object} [opts] {sort:boolean 是否按 key 字母序签名，缺省 false}
     * @returns {Promise<Ret>} 应答（ret.ok；业务体在 ret.data.data，Ret.data 是完整应答对象 {code, data}）
     */
    function apiSigned(path, params, opts) {
        opts = opts || {};
        var base = apiBase();
        if (!base) return Promise.reject(new Error('chat.' + path + ': chat server url unavailable (login first?).'));
        try {
            params.time = String(Date.now());
            params.sign = signParams(params, !!opts.sort);
        } catch (e) {
            return Promise.reject(e);
        }
        return proxy(base + path, params);
    }

    /**
     * 拉与某人的私聊历史（/pm/loadPmChat，插入序签名）。只读，不改游戏任何状态。
     * @param {string|number} targetUid 对方 UID
     * @param {object} [opts] {channel 私聊频道号，缺省 1}
     * @returns {Promise<Ret>} ret.data.data.list 为消息数组（Ret.data 是完整应答对象；schema 同 chatpushpm，含双向、按 t 升序）
     */
    function history(targetUid, opts) {
        if (targetUid == null || targetUid === '') return Promise.reject(new Error('chat.history: targetUid required.'));
        opts = opts || {};
        var q = { appId: APP_ID, uid: String(getUid() || ''), to: String(targetUid), channel: opts.channel != null ? opts.channel : CHANNELS.pm };
        return apiSigned('/pm/loadPmChat', q, { sort: false });
    }

    /**
     * 拉频道历史（/chat/loadHistoryV2，插入序签名，游戏 getHistoryData 同源口径：
     * query={appId,roomId:'房1;房2;…',time}，房号列表缺省取游戏当前 _rooms（世界/联盟等由游戏自己 join）。
     * 只读，不改游戏任何状态。应答 data.list 为历史消息数组（schema 同频道推送，项带 roomId/c；
     * 游戏侧对历史项预处理过 fu=uid、m=content，本层交给 normalize/调用方兼容）。
     * @param {string[]|null} [roomIds] 房号数组；缺省全部已 join 房间
     * @returns {Promise<Ret>} 历史列表在 ret.data.data.list（Ret.data 是完整应答对象）
     */
    function historyRooms(roomIds) {
        var ids = roomIds;
        if (!ids || !ids.length) ids = status().rooms;
        ids = (ids || []).filter(Boolean);
        if (!ids.length) return Promise.reject(new Error('chat.historyRooms: no rooms available (login/join first?).'));
        var q = { appId: APP_ID, roomId: ids.join(';') };
        return apiSigned('/chat/loadHistoryV2', q, { sort: false });
    }

    /**
     * 翻更旧的频道历史（同端点，roomId 位填游标 "<roomId>|<最旧消息uuid>"——
     * 游戏 askLastPageData 的 GroupId|MsgId 口径，MsgId 即推送/历史里的 uuid）。
     * @param {string} roomId 房间号（如 102_1_4336）
     * @param {string} beforeUuid 当前已加载最旧一条消息的 uuid
     * @returns {Promise<Ret>} 更旧一页消息在 ret.data.data.list（schema 同 historyRooms）
     */
    function olderHistory(roomId, beforeUuid) {
        if (!roomId || !beforeUuid) return Promise.reject(new Error('chat.olderHistory: roomId and beforeUuid required.'));
        return historyRooms([roomId + '|' + beforeUuid]);
    }

    /**
     * 查未读锚点 + @提及（/chat/getUnreadAnchorAndMentions，字母序签名）。
     * @param {string|number|object} target 对方 UID，或 {roomId:'...'} 查群/房间频道
     * @returns {Promise<Ret>} ret.data.data：{count, firstUnreadSeq, latestUuid, mentionCount, mentions, ...}
     */
    function unread(target) {
        var q;
        if (target && typeof target === 'object' && target.roomId != null) {
            q = { appId: APP_ID, uid: String(getUid() || ''), roomId: String(target.roomId) };
        } else {
            if (target == null || target === '') return Promise.reject(new Error('chat.unread: target uid or roomId required.'));
            q = { appId: APP_ID, uid: String(getUid() || ''), toUid: String(target) };
        }
        return apiSigned('/chat/getUnreadAnchorAndMentions', q, { sort: true });
    }

    /**
     * 标记与某人的私聊已读（/pm/readPm，插入序签名；清未读红点）。只读语义但会改变服务端未读状态。
     * @param {string|number} targetUid 对方 UID
     * @param {object} [opts] {channel 私聊频道号，缺省 1}
     * @returns {Promise<Ret>} ret.ok 即已读成功
     */
    function markRead(targetUid, opts) {
        opts = opts || {};
        if (targetUid == null || targetUid === '') return Promise.reject(new Error('chat.markRead: targetUid required.'));
        var q = { appId: APP_ID, uid: String(getUid() || ''), to: String(targetUid), channel: opts.channel != null ? opts.channel : CHANNELS.pm };
        return apiSigned('/pm/readPm', q, { sort: false });
    }

    /**
     * 拉频道会话摘要 + @提及（/chat/getChatHomeSummary，字母序签名，游戏 requestChannelTipInfo 同源：
     * query={appId,uid:StrUid,roomIds:'房1;房2',time}）。房号列表缺省取游戏当前 _rooms。
     * 用途：权威未读数/最后一条消息/@气泡——玩家未在游戏中打开过的频道也能拿到（本地 chatHeads 枚举不到）。
     * @param {string[]|null} [roomIds] 房号数组；缺省全部已 join 房间
     * @returns {Promise<Ret>} ret.data.data：{list:{"房号":{unreadCount,lastMessage,loadMoreMsgPoint}}, mentions:[...]}（Ret.data 为完整应答）
     */
    function summary(roomIds) {
        var ids = roomIds;
        if (!ids || !ids.length) ids = status().rooms;
        ids = (ids || []).filter(Boolean);
        var q = { appId: APP_ID, uid: getStrUid(), roomIds: ids.join(';') };
        return apiSigned('/chat/getChatHomeSummary', q, { sort: true });
    }

    /**
     * 拉私聊/置顶/转会等会话列表（/pm/loadChatList，插入序签名，游戏 getUserListFromServerByType 同源：
     * query={appId,uid:UID,channel,time}）。无需预先知道对方 UID 即可枚举「跟谁聊过」。
     * @param {object} [opts] {channel 会话类型：1 私聊(缺省) / 4 置顶(mod) / 8 转会，见 CHAT_CHANNEL_TYPE}
     * @returns {Promise<Ret>} ret.data.data.list 为会话条目数组（每项含双向 fu/fp/tu/tp，自己发起时取 tu/tp；schema 同私聊推送）
     */
    function pmList(opts) {
        opts = opts || {};
        var q = { appId: APP_ID, uid: String(getUid() || ''), channel: opts.channel != null ? (opts.channel | 0) : CHANNELS.pm };
        return apiSigned('/pm/loadChatList', q, { sort: false });
    }

    /**
     * 定位拉取某条消息前后的历史（/chat/loadHistoryAround，字母序签名，游戏 loadHistoryAround 同源：
     * query={appId,uid:StrUid,roomId,uuid,beforeCount,afterCount,time}）。
     * 用途：跳到未读锚点/回应目标/撤回消息时，本地缓冲缺该段历史则按 uuid 锚点补齐上下文。
     * @param {string} roomId 房间号（如 102_1_4336）
     * @param {string} uuid 锚点消息 uuid（历史/推送项的 uuid 字段）
     * @param {object} [opts] {beforeCount 锚点前拉几条（缺省 50）, afterCount 锚点后拉几条（游戏固定 50，可覆盖）}
     * @returns {Promise<Ret>} ret.data.data.list 为上下文消息数组（schema 同 historyRooms）
     */
    function aroundHistory(roomId, uuid, opts) {
        opts = opts || {};
        if (!roomId || !uuid) return Promise.reject(new Error('chat.aroundHistory: roomId and uuid required.'));
        var q = {
            appId: APP_ID, uid: getStrUid(), roomId: String(roomId), uuid: String(uuid),
            beforeCount: opts.beforeCount != null ? (opts.beforeCount | 0) : 50,
            afterCount: opts.afterCount != null ? (opts.afterCount | 0) : 50,
        };
        return apiSigned('/chat/loadHistoryAround', q, { sort: true });
    }

    /**
     * 查服务器系统消息（GET_CHAT_PUSH_LIST，主协议 PBV2 通道；游戏 requestChatSystemMsg 同源：
     * pack={beginSecsTime,channel[,aroundBeginSec,aroundEndSec]}，应答 pbAckV2.data.infos[]）。
     * 世界/联盟历史里 fu=="-1" 的系统条目即来自此，与聊天服务器历史合并展示；纯查询、只读安全。
     * 已发出未应答时（net.isSending 闸门，同游戏 checkRequestIdNoRes）直接返回空数组，不并发重复请求。
     * @param {object} [opts] {beginSecsTime 起始秒时刻（缺省当前服务器秒）, channel 频道号（缺省 -1 全部）,
     *     aroundBeginSec/aroundEndSec 定位上下文时段（成对 >0 才带上）}
     * @returns {Promise<Array<object>>} 已按游戏 createOneSysMsg 归一的系统消息数组（{c,m,roomId,t,uuid,uid:"-1",fu:"-1",isGameMsg,...params}），
     *     可直接喂 normalize/classify（fu=="-1" 命中系统模板分支）；闸门/失败返回空数组
     */
    function systemMessages(opts) {
        opts = opts || {};
        var net = window.pocketcc && window.pocketcc.net;
        if (!net) return Promise.reject(new Error('chat.systemMessages: pocketcc.net unavailable.'));
        var cmd = resolveSysCmd();
        if (net.isSending(cmd)) return Promise.resolve([]);   // 在途去重闸门（同游戏）
        var pack = {
            beginSecsTime: opts.beginSecsTime != null ? (opts.beginSecsTime | 0) : serverTimeSec(),
            channel: opts.channel != null ? (opts.channel | 0) : -1,
        };
        if (opts.aroundBeginSec > 0 && opts.aroundEndSec > 0) {
            pack.aroundBeginSec = opts.aroundBeginSec | 0;
            pack.aroundEndSec = opts.aroundEndSec | 0;
        }
        return net.sendPBV2(cmd, pack).then(function (ret) {
            var infos = (ret && ret.ok && ret.data && ret.data.infos) ? ret.data.infos : [];
            var out = [];
            for (var i = 0; i < infos.length; i++) out.push(toSysItem(infos[i]));
            return out;
        });
    }

    /**
     * 单条系统消息 infos 项 → 归一对象（游戏 createOneSysMsg 同构：uid/fu 置 "-1"，params 摊平进顶层）。
     * @param {object} e pbAckV2.data.infos 单项
     * @returns {object}
     */
    function toSysItem(e) {
        e = e || {};
        var t = {
            c: (e.channel != null ? e.channel : '') + '',
            m: e.content,
            roomId: e.roomId,
            t: e.time,
            uuid: e.uuid,
            uid: '-1',
            fu: '-1',
            isGameMsg: true,
        };
        var ps = e.params;
        if (ps && typeof ps === 'object') for (var k in ps) t[k] = ps[k];
        return t;
    }

    /**
     * 解析链接类消息（m 以 "link" 开头）。把 llm JSON 串解成对象并标注子类型。
     * @param {string} m 原始 m 字段
     * @param {string|object|null} llm 原始 llm 字段
     * @returns {object} {isLink, llm:object|null, linkType, emotionId}；linkType：0=位置/1=战报/2=表情/3=砍价（同 llm.t）
     */
    function parseLink(m, llm) {
        var out = { isLink: false, llm: null, linkType: null, emotionId: null };
        if (typeof m !== 'string' || m.indexOf('link') !== 0) return out;
        out.isLink = true;
        var payload = null;
        if (llm != null && llm !== '') {
            try { payload = typeof llm === 'string' ? JSON.parse(llm) : llm; } catch (e) { payload = null; }
        }
        out.llm = payload;
        if (payload && payload.t != null) {
            out.linkType = payload.t;
            if (payload.t === 2 || payload.t === 3) out.emotionId = payload.emotionId != null ? payload.emotionId : (+m.slice(4) || null);
        } else {
            var tail = +m.slice(4);
            if (tail) { out.linkType = 2; out.emotionId = tail; }   // 无 llm 时回退：link<id> 当表情
        }
        return out;
    }

    /**
     * 把聊天推送归一为可直接渲染的对象（频道 newChatPush 与私聊 chatpushpm 两个 schema 字段不同构，
     * 本函数抹平差异；kind 缺省据 fu/tu 是否在场所属频道自动判别）。
     * @param {object} msg socket 推来的原始对象（newChatPush 单项 / chatpushpm 单项）
     * @param {string} [kind] 'push'（频道）| 'pm'（私聊）；缺省自动
     * @returns {object|null} {kind, channel, seq, time, isSelf, from:{uid,name,face,server,lang,fUid}, to:{uid,name}|null,
     *     text, isLink, linkType, llm, emotionId, raw}；msg 非对象时返回 null
     */
    function normalize(msg, kind) {
        if (!msg || typeof msg !== 'object') return null;
        if (!kind) kind = (msg.fu != null || msg.tu != null) ? 'pm' : 'push';
        var myUid = String(getUid() || '');
        var out = {
            kind: kind,
            id: msg.id != null ? msg.id : null,
            channel: msg.c != null ? msg.c : (kind === 'pm' ? CHANNELS.pm : null),
            seq: msg.seq != null ? msg.seq : null,
            time: msg.t != null ? +msg.t : null,
            text: msg.m != null ? msg.m : '',
            from: null, to: null,
            isSelf: null,
            isLink: false, linkType: null, llm: null, emotionId: null,
            raw: msg,
        };
        // f/fu/tu 存在 JSON 字符串形态（真机历史项与部分推送同构于 chat-window buildEntry 的 safeParse 兜底）：
        // 不解析则 from.uid 取空，下游按 UID 的白名单/回声判定会静默失效
        var asObj = function (v) {
            if (v == null) return {};
            if (typeof v === 'object') return v;
            try { return JSON.parse(v) || {}; } catch (e) { return {}; }
        };
        if (kind === 'pm') {
            var fu = asObj(msg.fu), tu = asObj(msg.tu);
            out.from = { uid: fu.uid != null ? String(fu.uid) : (msg.uid != null ? String(msg.uid) : ''), name: fu.n || '', face: fu.f != null ? fu.f : null, server: fu.s != null ? fu.s : null, lang: fu.lang, fUid: fu.fUid };
            out.to = { uid: tu.uid != null ? String(tu.uid) : (typeof msg.tu === 'string' || typeof msg.tu === 'number' ? String(msg.tu) : ''), name: tu.n || '', face: tu.f != null ? tu.f : null };
        } else {
            // 联盟/群聊等频道的 newChatPush 实推项里没有 f 对象（实证报文）：发件人在顶层
            // uid/fu（字符串 UID），昵称在 fp（JSON 串的 username），需逐级兜底才能拿到 from.uid
            var f = asObj(msg.f);
            var fp = asObj(msg.fp);
            var uidV = f.uid != null ? String(f.uid)
                : msg.uid != null ? String(msg.uid)
                : (typeof msg.fu === 'string' || typeof msg.fu === 'number') ? String(msg.fu) : '';
            out.from = {
                uid: uidV,
                name: msg.u || f.n || fp.username || fp.nickname || '',
                face: f.f != null ? f.f : null,
                server: f.s != null ? f.s : null,
                lang: f.lang != null ? f.lang : (fp.lang),
                fUid: f.fUid != null ? f.fUid : (msg.fu != null && uidV === String(msg.fu) ? String(msg.fu) : undefined),
            };
        }
        out.isSelf = !!myUid && out.from.uid === myUid;
        var link = parseLink(out.text, msg.llm);
        if (link.isLink) { out.isLink = true; out.linkType = link.linkType; out.llm = link.llm; out.emotionId = link.emotionId; }
        return out;
    }

    /**
     * 给一个发包 Promise 套上超时：到点未 settle 即 reject（同 net.js，迟到应答无害空操作）
     * @param {Promise<Ret>} p 原始发包 Promise
     * @param {string} label 错误信息标签
     * @returns {Promise<Ret>}
     */
    function withTimeout(p, label) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(new Error(label + ' no server response in ' + SEND_TIMEOUT_MS + 'ms.'));
            }, SEND_TIMEOUT_MS);
            p.then(
                function (v) { clearTimeout(timer); resolve(v); },
                function (e) { clearTimeout(timer); reject(e); }
            );
        });
    }

    /**
     * 订阅聊天推送
     * @param {string} type 语义类型：push 频道消息 | pm 私聊 | update 消息更新 | del 消息删除 | reconnect 重连成功
     * @param {function(payload)} fn 回调，实参为 socket 推来的原始对象（非池化，可持有）；reconnect 无载荷
     * @returns {function} unsubscribe；type/fn 非法时为空操作函数
     */
    function on(type, fn) {
        var name = EVENT_MAP[type];
        if (!name || typeof fn !== 'function') {
            log.warn('on: invalid args (type=%s, fn=%s)', type, typeof fn);
            return function () {};
        }
        var ev = window.pocketcc && window.pocketcc.event;
        if (!ev) {
            log.warn('on %s: pocketcc.event unavailable.', type);
            return function () {};
        }
        return ev.on(name, fn);
    }

    /**
     * 显式退订（on 返回的 unsubscribe 的语法糖）。fn 必须是 on() 时的同一引用。
     * @param {string} type 语义类型
     * @param {function} fn 注册时的原回调
     */
    function off(type, fn) {
        var name = EVENT_MAP[type];
        if (!name || typeof fn !== 'function') return;
        var ev = window.pocketcc && window.pocketcc.event;
        if (ev) ev.off(name, fn);
    }

    /**
     * 单点包 client.sendProxy（自有属性遮蔽，同 event.js 的 hookEmit 口径，可对称还原）。
     * 只在日志开启期间存在；wrapper 打印出站后把 ok/err 各包一层打印应答再透传，异常全吞不影响真实发送。
     * @returns {boolean} 挂钩成功
     */
    function hookProxy() {
        if (proxyHooked) return true;
        proxyOwn = Object.prototype.hasOwnProperty.call(client, 'sendProxy');
        proxyOrig = proxyOwn ? client.sendProxy : (Object.getPrototypeOf(client) || {}).sendProxy;
        if (typeof proxyOrig !== 'function') {
            log.warn('sendProxy is missing, chat log unavailable.');
            return false;
        }
        proxyMine = function (url, ok, query, body, err, sent) {
            if (logEnabled) {
                try { log.info('req  proxy %s', url, query, body); } catch (e) { }
                var wrap = function (cb, tag) {
                    if (typeof cb !== 'function') return cb;
                    return function (r) {
                        try { log.info('resp proxy %s %s', url, tag, r); } catch (e) { }
                        return cb.apply(this, arguments);
                    };
                };
                ok = wrap(ok, 'ok');
                err = wrap(err, 'err');
            }
            return proxyOrig.call(this, url, ok, query, body, err, sent);
        };
        client.sendProxy = proxyMine;
        proxyHooked = true;
        return true;
    }

    /** 摘 sendProxy 包装：仅当最外层还是我们的包装时才还原 */
    function unhookProxy() {
        if (!proxyHooked) return;
        // 仅当最外层还是我们的包装时才还原；被别人又包了一层就跳过，退化成直通
        if (client && client.sendProxy === proxyMine) {
            if (proxyOwn) client.sendProxy = proxyOrig; else delete client.sendProxy;
        }
        proxyHooked = false;
        proxyOrig = proxyMine = null;
    }

    /** 日志期入站订阅：经 pocketcc.event 订 5 个聊天事件并打印，句柄入表备摘 */
    function startLogSubs() {
        var ev = window.pocketcc && window.pocketcc.event;
        if (!ev) return;
        for (var type in EVENT_MAP) {
            (function (type, name) {
                logInboundOffs.push(ev.on(name, function (payload) {
                    try { log.info('push %s (%s)', name, type, payload); } catch (e) { }
                }));
            })(type, EVENT_MAP[type]);
        }
    }

    /** 退订全部日志期入站订阅 */
    function stopLogSubs() {
        while (logInboundOffs.length) {
            try { logInboundOffs.pop()(); } catch (e) { }
        }
    }

    /**
     * 开关聊天日志。开启=包 client.sendProxy（出站+应答打印）并经 pocketcc.event 订阅聊天事件（入站打印）；
     * 关闭即全部摘除，hot path 回到无包装原样。用于真机探测文本消息的 url/参数口径。
     * @param {boolean} on
     * @returns {boolean} 当前开关态
     */
    function setLog(on) {
        logEnabled = !!on;
        if (logEnabled) {
            if (!installed && !install()) { logEnabled = false; return false; }
            if (!hookProxy()) { stopLogSubs(); logEnabled = false; return false; }
            startLogSubs();
        } else {
            stopLogSubs();
            unhookProxy();
        }
        log.info('chat log %s.', logEnabled ? 'enabled' : 'disabled');
        return logEnabled;
    }

    /**
     * 聊天日志是否开启
     * @returns {boolean}
     */
    function isLogging() {
        return logEnabled;
    }

    /**
     * proxy 应答结果：code 业务码（解析失败/缺字段为 null），data 完整应答对象（解析失败时为原始串）
     */
    class Ret {

        /**
         * 构造应答结果
         * @param {number|null} code 业务码
         * @param {object|string} data 完整应答
         */
        constructor(code, data) {
            this.code = code;
            this.data = data;
        }

        /**
         * 是否业务成功（聊天服务器 code===1 为成功，同 NetChatClient.sendProxy 判据）
         */
        get ok() {
            return this.code === 1;
        }

        /**
         * 创建应答结果
         * @param {number|null} code 业务码
         * @param {object|string} data 完整应答
         * @returns {Ret}
         */
        static from(code, data) {
            return new Ret(code, data);
        }

    }

    // Ret 是类声明，api 字面量在文件顶部构造时尚处 TDZ，故在此挂上
    api.Ret = Ret;

    window.pocketcc = window.pocketcc || {};
    window.pocketcc.chat = api;
    // 扩展内不自启：无场景时机依赖，各 API 首用时懒兜底 install()

})();
