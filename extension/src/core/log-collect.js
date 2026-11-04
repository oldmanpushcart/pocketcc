/**
 * pocketcc.logCollect — 日志上送器（可挂载，默认关）
 *
 * 职责：把 log.js 的 tee（setSink）转成「流式缓冲 + 定时批量 POST 到本地 dashcam /log」。
 * 与报文录制（net-collect）是**两个独立开关、两个接收端点**：
 *   - 报文：会话制（面板开→关一段），带业务标签 note，dashcam 定稿命名；
 *   - 日志：长期常开、无业务语义，dashcam 端按小时轮转直写 store/_log/<uid>/，本侧无 done 概念。
 *
 * 异步纪律（镜像 net-collect，六条逐条对齐）：
 *   1. 关时零挂接：不注册 sink，log.js hot path 回落到一次判空；
 *   2. sink 回调极薄：判级 + 尾参即时串化(带硬上限) + 折叠比对 + push；绝不同步做网络。
 *      注意：rest 必须在 sink 当帧串化——net.js 的 ev/data 是「本拍共享」的池化对象，
 *      推迟到 flush 再序列化会采到被改写后的数据（比丢更糟的是错数据）。
 *   3. 缓冲有界：软上限字节提前冲、硬上限 MAX_LINES 丢新不涨、溢出合成 [dropped N] 审计行；
 *      连续同 (lvl,mod,msg) 折叠为一行 {…} + n 计数（调试期循环日志的量级报文侧不会出现）；
 *   4. flush 同步段只做 join + postMessage，到 bridge 就收手；
 *   5. 网络 I/O 在 background service worker（同报文通道）；
 *   6. 失败纪律：无接收器/异常一律 try/catch 吞掉 + 限频告警，绝不阻断游戏与 console 输出。
 * 自录回声：本模块与 REC 的日志器均 quiet（只进 console），flush 路径不会喂自己。
 *
 * 挂载性：面板「日志上送」勾选 → registry apply 调 start(cfg)；取消 → stop()。
 * 不自启：与 net-collect 同，由 registry internal 功能经面板开关驱动。
 */
import { createLog, setSink } from './log.js';
import { NS } from './constants.js';
import { getUid } from './player.js';

/**
 * 上送器接口具名导出（供 registry 走 ESM import，口径同 netCollectApi）。
 * @type {object|null}
 */
export let logCollectApi = null;

(function () {
  'use strict';

  /** @type {ReturnType<createLog>} 模块日志器（tag=LOGREC）；quiet 防自录回声 */
  const log = createLog('LOGREC', { quiet: true });

  /** @type {boolean} 是否正在上送 */
  var running = false;
  /** @type {object|null} 定时 flush 的 setInterval id */
  var timer = null;
  /** @type {string} 本次上送运行标识（uid + 启动时刻），供 dashcam 关联与诊断 */
  var runId = '';
  /** @type {string} 当前玩家 uid（未登录为 anon），供 dashcam 分目录 */
  var uid = 'anon';
  /** @type {object} 当前生效配置 { logUrl, flushSec, minLvl } */
  var cfg = {};

  /**
   * @typedef {object} LogRec dashcam /log 单行落盘格式（结构化，非纯文本）
   * @property {number} ts 客户端毫秒
   * @property {string} lvl info|debug|warn
   * @property {string} mod 模块标记（createLog 的 module）
   * @property {string} msg printf 自拼后的完整单行文本
   * @property {number} [n] 折叠计数：连续同 (lvl,mod,msg) 的重复条数，缺省 1
   */
  /** @type {LogRec[]} 待落盘缓冲（结构化对象，序列化延迟到 flush） */
  var pending = [];
  /** @type {number} 缓冲累计字符数（近似），超软上限提前 flush */
  var pendingChars = 0;
  /** @type {number} 单次 flush 触发的字节软上限 */
  var FLUSH_BYTES = 128 * 1024;
  /** @type {number} 缓冲行条数硬上限；溢出丢最新并计审计数，绝不无界增长 */
  var MAX_LINES = 5000;
  /** @type {number} 因溢出丢弃的条数（flush 成功交接后复位；失败则并入待重发行数） */
  var dropped = 0;
  /** @type {number} 单行 msg 硬上限：防「网络日志+日志上送」时全量 PB 载荷把缓冲撑爆/折叠比对退化成巨串比较 */
  var MAX_MSG = 2048;
  /** @type {boolean} flush 失败是否已告警（防刷屏，落一次盘后复位） */
  var flushWarned = false;

  /** 级别过滤器：minLvl=debug 全收；info 收 info+warn；warn 只收 warn（只升不降档语义） */
  function lvlOk(lvl) {
    if (cfg.minLvl === 'debug') return true;
    if (cfg.minLvl === 'warn') return lvl === 'warn';
    return lvl !== 'debug'; // 缺省 info 档
  }

  /**
   * log.js sink 钩子：判级 + 尾参即时串化(截断) + 折叠 + push，无网络/磁盘 IO。
   * 尾参 rest 当帧串化（池化对象不可推迟），单行截到 MAX_MSG 防全载荷落盘。
   * @param {{ts:number,lvl:string,mod:string,msg:string,rest:Array}} e
   */
  function onRecord(e) {
    if (!running || !lvlOk(e.lvl)) return;
    var msg = e.msg;
    if (e.rest && e.rest.length) {
      // 带尾参的调用（如 net.js 载荷调试）：拼进 msg，Stringify 失败降级 String，绝不抛
      try {
        msg +=
          ' ' +
          e.rest.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' ');
      } catch (err) {
        msg += ' ' + String(e.rest);
      }
    }
    if (msg.length > MAX_MSG) msg = msg.slice(0, MAX_MSG) + '…[truncated]';
    var last = pending[pending.length - 1];
    if (last && last.lvl === e.lvl && last.mod === e.mod && last.msg === msg) {
      last.n = (last.n || 1) + 1; // 连续同文案折叠：调试期一行循环日志只占一条
      return;
    }
    if (pending.length >= MAX_LINES) {
      dropped++;
      return; // 丢新不涨；审计行在 flush 头部合成
    }
    pending.push({ ts: e.ts, lvl: e.lvl, mod: e.mod, msg: msg });
    pendingChars += msg.length + e.mod.length + 32;
    if (pendingChars >= FLUSH_BYTES) scheduleSoon();
  }

  /** 缓冲达软上限：把 flush 推迟到下一次宏任务，避免同步路径里做 post。 */
  function scheduleSoon() {
    setTimeout(function () {
      flush();
    }, 0);
  }

  /**
   * uid 惰性纠偏：start 时 UID 可能未就绪（登录页/降级重载前勾选），永久停 anon 会被
   * background 的 screen(uid) 静默丢批 + dashcam 侧 logRef 配对目录对不上，故每次 flush 复核。
   */
  function syncUid() {
    var u = getUid() || 'anon';
    if (u !== uid) {
      uid = u;
      runId = uid + '-log-' + Date.now();
      log.info('uid refreshed. run=%s', runId);
    }
  }

  /**
   * 把缓冲序列化成 NDJSON 发往 bridge（fire-and-forget），随后清空。
   * 溢出审计行置于批次头，保证「丢了什么」先于内容可见。
   */
  function flush() {
    if (!pending.length && !dropped) return;
    if (running) syncUid();
    var lines = pending;
    pending = [];
    pendingChars = 0;
    if (dropped) {
      lines.unshift({
        ts: Date.now(),
        lvl: 'warn',
        mod: 'LOGREC',
        msg: '[dropped ' + dropped + ' lines: buffer overflow]',
      });
      dropped = 0;
    }
    var ndjson;
    try {
      ndjson = lines.map((r) => JSON.stringify(r)).join('\n');
    } catch (err) {
      dropped += lines.length; // 审计不丢：失败批并入下次计数（含审计行本身）
      log.warn('log serialize failed, dropped %d lines.', lines.length);
      return;
    }
    try {
      window.postMessage(
        {
          __ns: NS,
          dir: 'main->bridge',
          op: 'dashcam-log-flush',
          url: cfg.logUrl,
          run: runId,
          uid: uid,
          ndjson: ndjson,
        },
        '*',
      );
      flushWarned = false;
    } catch (err) {
      dropped += lines.length; // postMessage 失败同样回计，不谎报成功
      if (!flushWarned) {
        flushWarned = true;
        log.warn('log flush postMessage failed, dropped %d lines.', lines.length, err);
      }
    }
  }

  /**
   * 开始上送。幂等：已在跑则按新配置刷新（热更地址/间隔/级别）。
   * @param {object} config { enabled, logUrl, flushSec, minLvl }
   * @returns {boolean} 是否进入上送态
   */
  function start(config) {
    if (running) {
      applyConfig(config);
      return true;
    }
    applyConfig(config);
    uid = getUid() || 'anon';
    runId = uid + '-log-' + Date.now();
    setSink(onRecord);
    running = true;
    restartTimer();
    log.info(
      'log shipping started. run=%s url=%s flushSec=%d minLvl=%s',
      runId,
      cfg.logUrl,
      cfg.flushSec,
      cfg.minLvl,
    );
    return true;
  }

  /** 刷新配置并按新间隔重开定时器；顺带纠偏 uid（热更路径也校，覆盖 start 幂等分支）。 */
  function applyConfig(config) {
    cfg = {
      logUrl: (config && config.logUrl) || 'http://127.0.0.1:7391/log',
      flushSec:
        config && typeof config.flushSec === 'number' && config.flushSec > 0 ? config.flushSec : 5,
      minLvl:
        config && /^(debug|info|warn)$/.test(String(config.minLvl || '')) ? config.minLvl : 'info',
    };
    if (running) syncUid();
    restartTimer();
  }

  /** 按当前 cfg.flushSec 重置落盘定时器。 */
  function restartTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (running && cfg.flushSec > 0)
      timer = setInterval(function () {
        flush();
      }, cfg.flushSec * 1000);
  }

  /**
   * 停止上送：摘 sink（log hot path 即刻回落零开销）、清定时器、冲完余量。幂等。
   * @returns {boolean} 停止前是否处于上送态
   */
  function stop() {
    if (!running) return false;
    running = false;
    setSink(null);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      flush(); // 余量：日志流无 done 定稿概念，尾批丢失也只是小时文件少几行
    } catch (e) {}
    log.info('log shipping stopped. run=%s', runId);
    return true;
  }

  /** 对外接口面，挂到 window.pocketcc.logCollect */
  var api = {
    start: start,
    stop: stop,
    flush: function () {
      flush();
    },
    isRunning: function () {
      return running;
    },
    run: function () {
      return runId;
    },
  };

  window.pocketcc = window.pocketcc || {};
  window.pocketcc.logCollect = api;
  logCollectApi = api; // 具名导出：与 window 同源，供 import { logCollectApi } 使用
})();
