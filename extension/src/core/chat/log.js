/**
 * chat 内部底座 · 日志面（core/chat/log.js）
 * 原 core/chat.js 的 hookProxy/unhookProxy/startLogSubs/stopLogSubs/setLog/isLogging 区段，
 * 阶段五逐字迁出（行为零变化）。开启=包 ctx.client.sendProxy（出站+应答打印）并经同一套 socket 订阅打印入站；
 * 关闭即全部摘除，hot path 回到无包装原样。引用方向 log→receive（借 on 订阅）→context，单向不成环。
 */
import { ctx, log, ensure, SOCKET_MAP } from './context.js';
import { on } from './receive.js';

/**
 * 单点包 ctx.client.sendProxy（自有属性遮蔽，同 event.js 的 hookEmit 口径，可对称还原）。
 * 只在日志开启期间存在；wrapper 打印出站后把 ok/err 各包一层打印应答再透传，异常全吞不影响真实发送。
 * @returns {boolean} 挂钩成功
 */
export function hookProxy() {
  if (ctx.proxyHooked) return true;
  ctx.proxyOwn = Object.prototype.hasOwnProperty.call(ctx.client, 'sendProxy');
  ctx.proxyOrig = ctx.proxyOwn
    ? ctx.client.sendProxy
    : (Object.getPrototypeOf(ctx.client) || {}).sendProxy;
  if (typeof ctx.proxyOrig !== 'function') {
    log.warn('sendProxy is missing, chat log unavailable.');
    return false;
  }
  ctx.proxyMine = function (url, ok, query, body, err, sent) {
    if (ctx.logEnabled) {
      try {
        log.info('req  proxy %s', url, query, body);
      } catch (e) {}
      var wrap = function (cb, tag) {
        if (typeof cb !== 'function') return cb;
        return function (r) {
          try {
            log.info('resp proxy %s %s', url, tag, r);
          } catch (e) {}
          return cb.apply(this, arguments);
        };
      };
      ok = wrap(ok, 'ok');
      err = wrap(err, 'err');
    }
    return ctx.proxyOrig.call(this, url, ok, query, body, err, sent);
  };
  ctx.client.sendProxy = ctx.proxyMine;
  ctx.proxyHooked = true;
  return true;
}

/** 摘 sendProxy 包装：仅当最外层还是我们的包装时才还原 */
export function unhookProxy() {
  if (!ctx.proxyHooked) return;
  // 仅当最外层还是我们的包装时才还原；被别人又包了一层就跳过，退化成直通
  if (ctx.client && ctx.client.sendProxy === ctx.proxyMine) {
    if (ctx.proxyOwn) ctx.client.sendProxy = ctx.proxyOrig;
    else delete ctx.client.sendProxy;
  }
  ctx.proxyHooked = false;
  ctx.proxyOrig = ctx.proxyMine = null;
}

/** 日志期入站订阅：订 5 个语义 type 打印原始载荷，句柄入表备摘（与业务订阅同一条重挂管道） */
export function startLogSubs() {
  Object.keys(SOCKET_MAP).forEach(function (type) {
    ctx.logInboundOffs.push(
      on(type, function (payload) {
        try {
          log.info('push %s %s', SOCKET_MAP[type], payload);
        } catch (e) {}
      }),
    );
  });
}

/** 退订全部日志期入站订阅 */
export function stopLogSubs() {
  while (ctx.logInboundOffs.length) {
    try {
      ctx.logInboundOffs.pop()();
    } catch (e) {}
  }
}

/**
 * 开关聊天日志。开启=包 ctx.client.sendProxy（出站+应答打印）并经同一套 socket 订阅打印入站；
 * 关闭即全部摘除，hot path 回到无包装原样。用于真机探测文本消息的 url/参数口径。
 * @param {boolean} on
 * @returns {boolean} 当前开关态
 */
export function setLog(on) {
  ctx.logEnabled = !!on;
  if (ctx.logEnabled) {
    if (!ensure()) {
      ctx.logEnabled = false;
      return false;
    }
    if (!hookProxy()) {
      stopLogSubs();
      ctx.logEnabled = false;
      return false;
    }
    startLogSubs();
  } else {
    stopLogSubs();
    unhookProxy();
  }
  log.info('chat log %s.', ctx.logEnabled ? 'enabled' : 'disabled');
  return ctx.logEnabled;
}

/**
 * 聊天日志是否开启
 * @returns {boolean}
 */
export function isLogging() {
  return ctx.logEnabled;
}
