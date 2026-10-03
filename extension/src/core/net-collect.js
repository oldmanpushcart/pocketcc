/**
 * pocketcc.netCollect — 报文黑匣子录制器（可挂载，默认关）
 *
 * 职责：把「流式采集 + 定时落盘」从 net.js 剥离到此处。net.js 只保留原语（net.stream），
 * 本模块驱动 net.stream 逐条收 entry，序列化成 NDJSON 缓冲，按 flushSec 定时经
 * window.postMessage 转给 bridge(ISOLATED) → background service worker → POST 到本地 dashcam 接收器。
 *
 * 挂载性：面板「报文录制」勾选 → registry apply 调 start(cfg)；取消 → stop()。
 *   关时不注册任何 stream、net 的发送/入站 hook 不挂（wantSendHooks 判 streams/collectors/log 均假），
 *   hot path 零开销；开时仅 tap 缓冲 + 定时批量 POST，派发路径不受影响。
 * 失败纪律：无接收器 / 序列化异常一律 try/catch 吞掉 + 限频告警，绝不阻断游戏真实收发。
 */
import { createLog } from './log.js';
import { NS } from './constants.js';
import { getUid } from './player.js';

(function () {

    'use strict';

    /** @type {ReturnType<createLog>} 模块日志器（tag=REC） */
    const log = createLog('REC');

    /** @type {boolean} 是否正在录制 */
    var recording = false;
    /** @type {Function|null} net.stream().start() 返回的 unstream */
    var unstream = null;
    /** @type {Function|null} 定时 flush 的 setInterval id */
    var timer = null;
    /** @type {string} 会话标识（uid + 启动时间戳），随每批发出供 dashcam 分会话 */
    var sessionId = '';
    /** @type {string} 当前玩家 uid（未登录为 anon），供 dashcam 分目录 */
    var uid = 'anon';
    /** @type {number} 本次录制启动时刻（毫秒），供 dashcam 生成可读文件名 */
    var startTs = 0;
    /** @type {object} 当前生效配置 { ingestUrl, flushSec } */
    var cfg = {};
    /** @type {string[]} 待落盘的 NDJSON 行缓冲 */
    var pending = [];
    /** @type {number} 缓冲累计字节数（近似），超软上限提前 flush */
    var pendingBytes = 0;
    /** @type {number} 单次 flush 触发的字节软上限 */
    var FLUSH_BYTES = 256 * 1024;
    /** @type {number} 缓冲行条数硬上限；溢出丢最新并告警，绝不无界增长 */
    var MAX_LINES = 20000;
    /** @type {boolean} 溢出是否已告警（防刷屏，落一次盘后复位） */
    var overflowWarned = false;

    /**
     * 取 net 底座（懒取；面板 apply 触发时通常已 install）
     * @returns {object|null}
     */
    function netBase() {
        return (window.pocketcc && window.pocketcc.net) || null;
    }

    /**
     * net.stream 的 tap 回调：把一条 entry 序列化成一行 JSON 推入缓冲。
     * entry 由 net.js 构造（含 data/raw 快照，池化对象已拷贝），此处只读不改。
     * @param {object} e 采集条目 {dir,cmd,name,data,raw,ts,seq,rt}
     */
    function onEntry(e) {
        var line;
        try { line = JSON.stringify(e); } catch (err) { return; }   // 循环引用等极端载荷：丢弃该条，不阻断
        if (pending.length >= MAX_LINES) {
            if (!overflowWarned) { overflowWarned = true; log.warn('record buffer overflow (%d lines), dropping newest until flush.', MAX_LINES); }
            return;
        }
        pending.push(line);
        pendingBytes += line.length + 1;
        if (pendingBytes >= FLUSH_BYTES) scheduleSoon();
    }

    /**
     * 缓冲达软上限时，把定时器提前到下一次宏任务触发 flush（避免同步路径里做网络 post）。
     */
    function scheduleSoon() {
        setTimeout(function () { flush(false); }, 0);
    }

    /**
     * 把缓冲拼成 NDJSON 发往 bridge（fire-and-forget），随后清空缓冲。
     * 携带会话元数据（uid/startTs/note）；done=true 为 stop 时的终止信号，dashcam 据此定稿命名与写索引。
     * 无 bridge / 异常一律吞掉：真机若收不到只是本地不落盘，不影响游戏。
     * @param {boolean} done 是否为本次录制的最后一批
     */
    function flush(done) {
        if (!pending.length && !done) return;
        var ndjson = pending.join('\n');
        var n = pending.length;
        pending = [];
        pendingBytes = 0;
        overflowWarned = false;
        try {
            window.postMessage({
                __ns: NS, dir: 'main->bridge', op: 'dashcam-flush',
                url: cfg.ingestUrl, session: sessionId, ndjson: ndjson,
                uid: uid, startTs: startTs, note: cfg.note || '', done: !!done,
            }, '*');
            log.debug('flush %d lines%s -> %s', n, done ? ' [done]' : '', cfg.ingestUrl);
        } catch (err) {
            log.warn('flush postMessage failed, dropped %d lines.', n, err);
        }
    }

    /**
     * 开始录制。幂等：已在录制则按新配置刷新转发地址/间隔/note。
     * @param {object} config { enabled, ingestUrl, flushSec, note, ... }
     * @returns {boolean} 是否已进入录制态
     */
    function start(config) {
        if (recording) { applyConfig(config); return true; }
        var net = netBase();
        if (!net) { log.warn('start: pocketcc.net unavailable.'); return false; }
        if (!net.install()) { log.warn('start: net.install failed.'); return false; }
        applyConfig(config);
        uid = getUid() || 'anon';
        startTs = Date.now();
        sessionId = uid + '-' + startTs;
        // 全量常开：filter 恒真（心跳已在 net.recordInbound/recordSend 首行滤除）
        unstream = net.stream().filter(function () { return true; }).tap(onEntry).start();
        if (!net.isStreaming()) { log.warn('start: stream not active (net not installed?).'); unstream = null; return false; }
        recording = true;
        restartTimer();
        log.info('recording started. session=%s url=%s flushSec=%d note=%s', sessionId, cfg.ingestUrl, cfg.flushSec, cfg.note || '-');
        return true;
    }

    /**
     * 刷新转发地址、落盘间隔与预填标签 note；重开定时器（flushSec 可能变了）。
     * 仅在 recording=true 时被 start 的幂等分支或面板热更调用。
     * @param {object} config
     */
    function applyConfig(config) {
        cfg = {
            ingestUrl: (config && config.ingestUrl) || 'http://127.0.0.1:7391/ingest',
            flushSec: (config && typeof config.flushSec === 'number' && config.flushSec > 0) ? config.flushSec : 2,
            note: (config && typeof config.note === 'string') ? config.note.trim() : '',
        };
        restartTimer();
    }

    /** 按当前 cfg.flushSec 重置落盘定时器。 */
    function restartTimer() {
        if (timer) { clearInterval(timer); timer = null; }
        if (recording && cfg.flushSec > 0) timer = setInterval(function () { flush(false); }, cfg.flushSec * 1000);
    }

    /**
     * 停止录制：解除流式订阅、清空定时器、落完余量并发 done 终止信号。幂等。
     * @returns {boolean} 停止前是否处于录制态
     */
    function stop() {
        if (!recording) return false;
        recording = false;
        if (timer) { clearInterval(timer); timer = null; }
        if (unstream) { try { unstream(); } catch (e) { } unstream = null; }
        try { flush(true); } catch (e) { }   // 余量 + done：即便此批丢失，dashcam 空闲超时仍会定稿
        log.info('recording stopped. session=%s', sessionId);
        return true;
    }

    /**
     * 当前是否正在录制
     * @returns {boolean}
     */
    function isRecording() {
        return recording;
    }

    /** 对外接口面，挂到 window.pocketcc.netCollect */
    var api = {
        start: start,
        stop: stop,
        flush: function () { flush(false); },
        isRecording: isRecording,
        session: function () { return sessionId; },
    };

    window.pocketcc = window.pocketcc || {};
    window.pocketcc.netCollect = api;
    // 不自启：由 registry 的 netRecord internal 功能经面板开关驱动 start/stop

})();
