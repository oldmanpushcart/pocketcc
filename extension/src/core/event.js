/**
 * pocketcc.event
 * 游戏 EventCenter（cc.EventTarget 单例，EventCenter.js:111 导出为 EVENT）的薄封装：
 * 订阅按需挂（不常驻包 EVENT.on）；日志才包 EVENT.emit，且只在“事件日志”开启期间存在，关闭即摘。
 * 口径参照 net.js：单点 hook、先跑原函数再打印、只当最外层还是自己时才还原。
 *
 * 生命周期约定（feat 侧）：
 *   feat 订阅一律走 ctx.on.event(name, fn)（reactor 注入，自动登记到 entry.triggers），
 *   pause/卸载时框架统一退订；不要直接 pocketcc.event.on 后不管——EVENT 是跨场景/跨会话单例，
 *   不退订回调会一直挂游戏上。
 *   event.uninstall() 是"拆卸整个封装层"的最后防线（reload/换号路径），不是 feat 卸载的常规路径。
 *
 * 池化对象告诫（同 net.js Event.raw）：部分游戏事件载荷是复用的 model 引用，
 * 信号/队列里只取纯值，别长期持有 ev.arguments 里的对象。
 */
import { createLog } from './log.js';
import { game } from './game.js';
import { bus } from './bus.js';

(function () {
  'use strict';

  /** @type {ReturnType<createLog>} 模块日志器（tag=EVENT） */
  const log = createLog('EVENT');

  /** @type {object|null} EventCenter 单例（game.get('EventCenter').EVENT） */
  var EVENT = null;
  /** @type {boolean} 封装层是否已安装 */
  var installed = false;

  // 两级 Map：subs: name -> Map<fn, wrapper> 正向表（去重、uninstall 遍历）；
  // byWrapper: name -> Map<wrapper, fn> 反查表（退订时由 wrapper 找回配对）。
  // EventCenter.off 按 callback 引用严格匹配，我们注册时从不传 target，
  // 故 off(name, wrapper) 省略 target 也不会误删游戏自己的监听。
  /** @type {Map<string, Map<Function, Function>>} 正向表：name -> Map<fn, wrapper> */
  var subs = new Map();
  /** @type {Map<string, Map<Function, Function>>} 反查表：name -> Map<wrapper, fn> */
  var byWrapper = new Map();

  // ── 事件日志 hook（net.js 同款口径）：只在 logEnabled 期间包上 EVENT.emit，关闭即摘 ──
  /** @type {Function|null} 原 emit（实例自有属性或原型方法） */
  var emitOrig = null;
  /** @type {Function|null} 我们的 emit 包装 */
  var emitMine = null;
  /** @type {boolean} EVENT 实例原本是否有自有 emit（决定还原用赋值还是 delete） */
  var emitOwn = false;
  /** @type {boolean} emit 当前是否已被包装 */
  var emitHooked = false;

  /** @type {boolean} 事件日志总开关 */
  var logEnabled = false;
  /** @type {Object<string,string>|null} 事件值 -> EventId 常量名 反查表（日志开启时建；EventId 名与值可能不同） */
  var names = null;
  /** @type {boolean} 名表是否已建 */
  var namesBuilt = false;

  /** 对外接口面，挂到 window.pocketcc.event */
  var api = {
    install: install,
    uninstall: uninstall,
    on: on,
    once: once,
    off: off,
    emit: emit,
    stat: stat,
    setLog: setLog,
    isLogging: isLogging,
    nameOf: nameOf,
  };

  // ── EventId 反查表（值 -> 常量名），口径同 net.js 的 scanConsts，但事件值是字符串 ──
  /**
   * 扫描 EventId 建 事件值→常量名 反查表，结果缓存在 names
   * @returns {number} 表条目数
   */
  function buildNames() {
    var into = {},
      n = 0,
      ex = game.get('EventId');
    ex = ex && ex.EventId;
    if (ex && typeof ex === 'object') {
      for (var k in ex) {
        if (!Object.prototype.hasOwnProperty.call(ex, k)) continue;
        var v = ex[k];
        if (typeof v === 'string') {
          if (into[v] === undefined) {
            into[v] = k;
            n++;
          }
        }
      }
    } else {
      log.warn('EventId module is missing, name table unavailable.');
    }
    names = into;
    namesBuilt = true;
    log.debug('event name table built. entries=%d', n);
    return n;
  }

  /**
   * 事件名反查 EventId 常量名（名与值可能不同，如 Power_UPDATE="STAR_UPDATE"）
   * @param {string} name 事件名（= EventId 的值）
   * @returns {string|null} 常量名；未知返回 null
   */
  function nameOf(name) {
    if (typeof name !== 'string' || !name) return null;
    if (!names) buildNames();
    return names[name] || null;
  }

  // bus 载荷约定：'event.<name>'，payload = 实参数组（EVENT.emit 最多透传 5 个业务参数）
  // 热路径纪律：事件名/总线 type 在订阅期算一次，emit 回调内不拼串、不反查名字、不建表。
  /**
   * 生成登记到游戏上的转发包装：只做两件事——调原回调 fn、按需桥接到 bus（各独立 try/catch）
   * @param {string} name 事件名
   * @param {Function} fn 用户原回调
   * @returns {Function} wrapper
   */
  function makeWrapper(name, fn) {
    var type = 'event.' + name;
    return function () {
      try {
        fn.apply(this, arguments);
      } catch (err) {
        log.warn('callback %s threw', name, err);
      }
      try {
        // 有 bus 订阅才复制成数组（省掉无订阅事件的分配）；载荷里的对象可能是池化引用，只取值不长期持有
        if (bus.has(type)) bus.emit(type, Array.prototype.slice.call(arguments));
      } catch (err) {
        log.warn('forward %s occur error!', name, err);
      }
    };
  }

  /**
   * 单点包 EVENT.emit（实例属性遮蔽原型方法，同 net.js 的 wrapSend 口径，可对称还原）。
   * 只在日志开启期间存在；关闭后 hot path 回到无包装原样。wrapper 只读不干预派发。
   * @returns {boolean} 挂钩成功（EVENT.emit 缺失时 false）
   */
  function hookEmit() {
    if (emitHooked) return true;
    var proto = Object.getPrototypeOf(EVENT);
    emitOwn = Object.prototype.hasOwnProperty.call(EVENT, 'emit');
    emitOrig = emitOwn ? EVENT.emit : proto && proto.emit;
    if (typeof emitOrig !== 'function') {
      log.warn('EVENT.emit is missing, event log unavailable.');
      return false;
    }
    emitMine = function (name) {
      // 先让游戏自己的派发跑完（同 net 的 recvMine），再打印；任何日志异常都吞掉
      var ret = emitOrig.apply(this, arguments);
      if (logEnabled && typeof name === 'string') {
        try {
          log.info(
            'push %s',
            (names && names[name]) || name,
            ...Array.prototype.slice.call(arguments, 1),
          );
        } catch (err) {
          log.warn('log event %s occur error!', name, err);
        }
      }
      return ret;
    };
    EVENT.emit = emitMine;
    emitHooked = true;
    return true;
  }

  /** 摘 emit 包装：仅当最外层还是我们的包装时才还原 */
  function unhookEmit() {
    if (!emitHooked) return;
    // 仅当最外层还是我们的包装时才还原；被别人又包了一层就跳过，退化成直通
    if (EVENT && EVENT.emit === emitMine) {
      if (emitOwn) EVENT.emit = emitOrig;
      else delete EVENT.emit; // 原型方法走 delete
    }
    emitHooked = false;
    emitOrig = emitMine = null;
  }

  /**
   * 该事件名下是否还有我们的订阅
   * @param {string} name 事件名
   * @returns {boolean}
   */
  function hasSubs(name) {
    var m = subs.get(name);
    return !!(m && m.size);
  }

  /** 订阅清空后删掉该事件名的两张表项，防泄漏 */
  function pruneName(name) {
    if (!hasSubs(name)) {
      subs.delete(name);
      byWrapper.delete(name);
    }
  }

  /**
   * 订阅游戏事件
   * @param {string} name 事件名（EventId 的值，直接传字符串即可）
   * @param {function} fn 回调，实参与游戏 EVENT.emit 的一致（≤5）
   * @returns {function} unsubscribe；重复订阅（同 name 同 fn）为 no-op，返回等价的退订函数
   */
  function on(name, fn) {
    if (typeof name !== 'string' || !name || typeof fn !== 'function') {
      log.warn('on: invalid args (name=%s, fn=%s)', name, typeof fn);
      return function () {};
    }
    if (!installed && !install()) {
      log.warn('on %s: not installed, EventCenter unavailable.', name);
      return function () {};
    }
    // 拼写护栏：不为主建表（建表开销只属于日志路径）；日志已建过表时顺手 O(1) 提醒。
    if (names && names[name] === undefined) {
      log.warn('on %s: not an EventId value, subscribing anyway.', name);
    }
    var fwd = byWrapper.get(name);
    if (!fwd) {
      subs.set(name, new Map());
      byWrapper.set(name, (fwd = new Map()));
    }
    var existing = subs.get(name).get(fn);
    var wrapper = existing;
    if (!wrapper) {
      wrapper = makeWrapper(name, fn);
      subs.get(name).set(fn, wrapper);
      fwd.set(wrapper, fn);
      EVENT.on(name, wrapper);
    }
    return function () {
      offWrapper(name, wrapper, fn);
    };
  }

  /**
   * 一次性订阅：触发一次后自动退订（回调仍收全参）
   * @param {string} name 事件名
   * @param {function} fn 回调
   * @returns {function} unsubscribe（未触发前手动退订用）
   */
  function once(name, fn) {
    if (typeof fn !== 'function') return function () {};
    var offFn = on(name, function () {
      offFn();
      try {
        fn.apply(null, arguments);
      } catch (err) {
        log.warn('once %s callback threw', name, err);
      }
    });
    return offFn;
  }

  /**
   * 真正的退订执行：游戏 off + 两张表同步剔除 + 空名清理
   * @param {string} name 事件名
   * @param {Function} wrapper 登记时的转发包装
   * @param {Function} fn 用户原回调
   */
  function offWrapper(name, wrapper, fn) {
    if (!EVENT) return;
    var fwd = byWrapper.get(name);
    if (!fwd || !fwd.has(wrapper)) return;
    EVENT.off(name, wrapper);
    fwd.delete(wrapper);
    var m = subs.get(name);
    if (m && m.get(fn) === wrapper) m.delete(fn);
    pruneName(name);
  }

  /**
   * 显式退订（unsubscribe 的语法糖）。fn 必须是 on() 时传的同一个引用；
   * 查不到配对时静默 no-op——绝不落到"省略 callback 即删整个事件名"的游戏路径上。
   * @param {string} name 事件名
   * @param {function} fn 注册时的原函数
   */
  function off(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') return;
    var m = subs.get(name);
    var wrapper = m && m.get(fn);
    if (wrapper) offWrapper(name, wrapper, fn);
  }

  /**
   * 代理 EVENT.emit（调试面 / 主动通知游戏）
   * @param {string} name 事件名
   * @param {...*} args 实参（≤5）
   */
  function emit(name, ...args) {
    if (!installed) return;
    EVENT.emit(name, ...args);
  }

  /**
   * 诊断面（DevTools）：列出我们登记的订阅，并只读核对游戏侧是否真的挂上。
   * onEvent 读的是 EventCenter._eventList[name].size（该事件名下不同 callback 数）；
   * subs>=1 而 onEvent=0 说明注册没落到游戏实例（取错单例 / 已被别处 off）。
   * @returns {object[]} 每行 {name, const, subs, onEvent}
   */
  function stat() {
    var rows = [];
    for (const [name, m] of subs) {
      var gameCount = 0;
      try {
        var lm = EVENT && EVENT._eventList && EVENT._eventList[name];
        if (lm) gameCount = lm.size;
      } catch (err) {}
      rows.push({
        name: name,
        const: (names && names[name]) || null,
        subs: m.size,
        onEvent: gameCount,
      });
    }
    return rows;
  }

  /**
   * 开关事件日志（面板“事件日志”开关驱动，与“网络日志”互相独立）。
   * 开启=建 EventId 名表 + 包 EVENT.emit（全量打印，黑名单过滤）；关闭即摘除包装。
   * @param {boolean} on
   * @returns {boolean} 当前开关态
   */
  function setLog(on) {
    logEnabled = !!on;
    if (logEnabled) {
      if (!installed && !install()) {
        logEnabled = false;
        return false;
      }
      if (!namesBuilt) buildNames();
      if (!hookEmit()) {
        logEnabled = false;
        return false;
      }
    } else {
      unhookEmit();
    }
    log.info('event log %s.', logEnabled ? 'enabled' : 'disabled');
    return logEnabled;
  }

  /**
   * 事件日志是否开启
   * @returns {boolean}
   */
  function isLogging() {
    return logEnabled;
  }

  /**
   * 安装：取 EVENT 单例并置位。EVENT 在模块加载期即创建（EventCenter.js:111），无登录时机依赖。
   * 不挂任何全局 hook（日志 hook 由 setLog 管理）。
   * @returns {boolean} 安装成功
   */
  function install() {
    if (installed) return true;
    var mod = game.get('EventCenter');
    EVENT = mod && mod.EVENT;
    if (!EVENT || typeof EVENT.on !== 'function') {
      log.warn('install failed, EventCenter is missing.');
      EVENT = null;
      return false;
    }
    installed = true;
    log.info('installed.');
    return true;
  }

  /**
   * 卸载：摘日志 hook + 清掉所有还登记在表里的订阅（最后防线；feat 卸载只该退自己的订）。
   * @returns {boolean} 卸载成功
   */
  function uninstall() {
    if (!installed) return true;
    unhookEmit();
    for (const [name, m] of [...subs]) {
      for (const fn of [...m.keys()]) off(name, fn);
    }
    subs.clear();
    byWrapper.clear();
    installed = false;
    EVENT = null;
    log.info('uninstalled.');
    return true;
  }

  window.pocketcc = window.pocketcc || {};
  window.pocketcc.event = api;
  // 扩展内不自启：由 boot.js 在场景就绪后调用 install()（与 net.install 同一时机）
})();
