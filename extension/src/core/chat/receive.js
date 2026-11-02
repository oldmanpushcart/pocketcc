/**
 * chat 内部底座 · 收信面（core/chat/receive.js）
 * 原 core/chat.js 的 on/off/订阅表/实例更替自愈/connectSocket 与 _io 包装区段，
 * 阶段五逐字迁出（行为零变化）。共享状态一律读写 context.js 的 ctx 单例；
 * 懒 install 经 context.ensure（installCore 成功后由 client.js 的回挂插槽调 hookConnect/hookIo，
 * 引用方向 receive→context 单向，不成环）。房间跟随游戏 _rooms，本模块不 join/leave。
 */
import { ctx, log, ensure, SOCKET_MAP, REBIND_CHECK_MS } from './context.js';

/**
 * 订阅聊天推送（直连 socket，自带实例更替自愈：登录重连/故障转移/PAB 心跳重建后自动重挂）
 * @param {string} type 语义类型：push 频道消息 | pm 私聊 | update 消息更新 | del 消息删除 | reconnect 重连成功
 * @param {function(payload)} fn 回调，实参为 socket 推来的原始对象（非池化，可持有）；reconnect 无载荷
 * @returns {function} unsubscribe；type/fn 非法或底座缺失时为空操作函数
 */
export function on(type, fn) {
  if (!SOCKET_MAP[type] || typeof fn !== 'function') {
    log.warn('on: invalid args (type=%s, fn=%s)', type, typeof fn);
    return function () {};
  }
  if (!ensure()) {
    log.warn('on %s: NetChatClient unavailable.', type);
    return function () {};
  }
  var set = ctx.subs.get(type);
  if (!set) ctx.subs.set(type, (set = new Set()));
  set.add(fn);
  rebind();
  startRebindTimer();
  return function () {
    offEntry(type, fn);
  };
}

/**
 * 显式退订（on 返回的 unsubscribe 的语法糖）。fn 必须是 on() 时的同一引用。
 * @param {string} type 语义类型
 * @param {function} fn 注册时的原回调
 */
export function off(type, fn) {
  if (!SOCKET_MAP[type] || typeof fn !== 'function') return;
  offEntry(type, fn);
}

/**
 * 退订一条：从表里摘；该 type 空了才从 socket 上摘 listener；全空则停自检。
 * 幂等：陈旧句柄（已退订过的）不会误伤后注册的同引用回调。
 * @param {string} type 语义类型
 * @param {function} fn 原回调
 */
export function offEntry(type, fn) {
  var set = ctx.subs.get(type);
  if (!set || !set.has(fn)) return;
  set.delete(fn);
  if (set.size) return;
  ctx.subs.delete(type);
  detach(type);
  if (!ctx.subs.size) stopRebindTimer();
}

/**
 * 把某个 type 的 fan-out listener 挂到当前 socket（幂等）。
 * 每个 type 只挂一个 listener，回调时快照订阅者集：订阅/退订发生在回调内也不影响本轮派发；
 * 每个订阅者单独 try/catch——我们的回调抛错既不打断同事件的其余订阅者，也不打断游戏自己的处理。
 * @param {string} type 语义 type
 */
export function attach(type) {
  if (ctx.bound.has(type)) return;
  var name = SOCKET_MAP[type];
  var listener = function (payload) {
    var set = ctx.subs.get(type);
    if (!set) return;
    var list = Array.from(set);
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        log.warn('callback %s threw', type, err);
      }
    }
  };
  try {
    ctx.boundSocket.on(name, listener);
    ctx.bound.set(type, listener);
  } catch (err) {
    log.warn('attach %s failed: %s', name, err && err.message);
  }
}

/**
 * 从当前 socket 摘掉某个 type 的 listener（socket 可能已被游戏 removeAllListeners，异常忽略）
 * @param {string} type 语义 type
 */
export function detach(type) {
  var listener = ctx.bound.get(type);
  if (!listener) return;
  ctx.bound.delete(type);
  try {
    if (ctx.boundSocket && typeof ctx.boundSocket.off === 'function') {
      ctx.boundSocket.off(SOCKET_MAP[type], listener);
    }
  } catch (e) {}
}

/**
 * 自愈重挂：以 ctx.client.socket() 的实例身份为锚，实例一变就把表里所有 type 重新挂上。
 * 触发点四处——on() 时、connectSocket 包装返回后、io 工厂包装（每次建 socket 的微任务）、
 * REBIND_CHECK_MS 身份自检（兜底）。未连接（socket 为 null）时只返回：订阅留在表里，等下一次触发。
 */
export function rebind() {
  var s;
  try {
    s = ctx.client && typeof ctx.client.socket === 'function' ? ctx.client.socket() : null;
  } catch (e) {
    return; // 取实例抛错（client 已失效等）同“未连接”，订阅留在表里等下次触发
  }
  if (!s) return;
  if (s !== ctx.boundSocket) {
    detachAll();
    ctx.boundSocket = s;
    log.info('chat socket bound, %d types registered.', ctx.subs.size);
  }
  Array.from(ctx.subs.keys()).forEach(function (type) {
    attach(type);
  });
}

/** 摘掉当前 socket 上挂的全部 listener 并放开身份锚（旧实例可能已被游戏整只丢弃） */
export function detachAll() {
  Array.from(ctx.bound.keys()).forEach(function (type) {
    detach(type);
  });
  ctx.boundSocket = null;
}

/** 卸载路径：清订阅表 + 摘 socket（调用方通常已全部退订，这里兜底防漏） */
export function dropAllSubs() {
  ctx.subs.clear();
  detachAll();
}

/** 起实例身份自检（仅在有订阅时跑；每拍只做一次引用比较） */
export function startRebindTimer() {
  if (ctx.rebindTimer) return;
  ctx.rebindTimer = setInterval(rebind, REBIND_CHECK_MS);
}

/** 停实例身份自检 */
export function stopRebindTimer() {
  if (!ctx.rebindTimer) return;
  clearInterval(ctx.rebindTimer);
  ctx.rebindTimer = null;
}
/**
 * 单点包 ctx.client.connectSocket（自有属性遮蔽，同 hookProxy 口径，可对称还原）。
 * 游戏每次建聊天 socket 都走它（首次登录 / CHAT_CONNECT 失败 20s 重试 / PAB 队房心跳重建），
 * 原函数返回后立刻 rebind()，让订阅跟着新实例走；故障转移不经它，由身份自检兜底。
 * @returns {boolean} 挂钩成功（失败只告警：登录早于本模块安装时，on() 首订也能直接绑上现成实例）
 */
export function hookConnect() {
  if (ctx.connectHooked) return true;
  ctx.connectOwn = Object.prototype.hasOwnProperty.call(ctx.client, 'connectSocket');
  ctx.connectOrig = ctx.connectOwn
    ? ctx.client.connectSocket
    : (Object.getPrototypeOf(ctx.client) || {}).connectSocket;
  if (typeof ctx.connectOrig !== 'function') {
    log.warn('connectSocket is missing, rely on identity poll only.');
    return false;
  }
  ctx.connectMine = function () {
    var ret = ctx.connectOrig.apply(this, arguments);
    try {
      hookIo(); // connectSocket 入口会 `_io = window.io` 把包装冲掉，返回后补包一次
      rebind();
    } catch (err) {
      log.warn('rebind after connect failed: %s', err && err.message);
    }
    return ret;
  };
  ctx.client.connectSocket = ctx.connectMine;
  ctx.connectHooked = true;
  return true;
}

/** 摘 connectSocket 包装：仅当最外层还是我们的包装时才还原 */
export function unhookConnect() {
  if (!ctx.connectHooked) return;
  if (ctx.client && ctx.client.connectSocket === ctx.connectMine) {
    if (ctx.connectOwn) ctx.client.connectSocket = ctx.connectOrig;
    else delete ctx.client.connectSocket;
  }
  ctx.connectHooked = false;
  ctx.connectOrig = ctx.connectMine = null;
}

/**
 * 包 ctx.client._io（聊天 socket 工厂）。NetChatClient 的 connectSocket 与它的内部故障转移闭包 T(t+1)
 * 都只经 `e._io(url, opts)` 建实例，所以包住工厂 = 任何一条路径建出新 socket 都能零延迟感知，
 * 不用等轮询。不碰全局 window.io：主协议走原生 WebSocket，与此无关；_io 只是聊天通道的私有副本。
 * 注：connectSocket 入口会 `e._io = window.io` 把包装冲掉，故每次 connectSocket 返回后要补包一次。
 * @returns {boolean} 是否新包上（未连接/已被包过返回 false，均不致命）
 */
export function hookIo() {
  var f = ctx.client && ctx.client._io;
  if (!f || f === ctx.ioMine) return false;
  ctx.ioOrig = f;
  ctx.ioMine = function () {
    var s = ctx.ioOrig.apply(this, arguments);
    scheduleRebind();
    return s;
  };
  ctx.client._io = ctx.ioMine;
  log.info('chat io factory hooked.');
  return true;
}

/** 摘 io 工厂包装：仅当最外层还是我们的包装时才还原 */
export function unhookIo() {
  if (!ctx.ioMine) return;
  if (ctx.client && ctx.client._io === ctx.ioMine) ctx.client._io = ctx.ioOrig;
  ctx.ioOrig = ctx.ioMine = null;
}

/**
 * 微任务重挂：等本次同步块（游戏紧接着执行 `c.on('chatpush', ...)` 与 `_socket = c`）跑完再挂。
 * 若在工厂里同步挂，我们的 listener 会排在游戏之前，回调时读到未更新的本地数据。
 */
export function scheduleRebind() {
  queueMicrotask(function () {
    try {
      rebind();
    } catch (err) {
      log.warn('deferred rebind failed: %s', err && err.message);
    }
  });
}
