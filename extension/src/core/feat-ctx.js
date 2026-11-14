// 功能上下文工厂：注入给 spec.install/run 的唯一外部接触面（reactor register 期装配）。
// 依赖全部经 deps 注入（log/bus/net()/chat()/event()），本模块零 import——
// 单测可用假 deps 直驱装配契约，不必桩化浏览器全局（tests/core/feat-ctx.test.js）。
// net/chat/event 用 getter 注入：三个底座是 export let 活绑定（install 时才赋值），
// register 时机可能早于底座安装，必须读时现取（与旧 makeCtx 的 ESM 懒取语义同源）。
// 窄化纪律（2026-11-14 盘点结论）：ctx 不再暴露 game/bus——bus 零消费者；
// game 唯一消费者 global-map 改 ESM 直取 core/game.js。游戏符号访问一律走 ESM import，
// ctx 收敛为「生命周期（alive/signal/托管定时器）+ 订阅（on.*）+ 底座（net/chat）」三件套。

/**
 * @typedef {object} CtxDeps 注入依赖
 * @property {object} log 日志器（createLog 产物）
 * @property {object} bus 内部事件总线（on/off/emit/has）
 * @property {function():object|null} net net 底座取值器（活绑定，install 前为 null）
 * @property {function():object|null} chat chat 底座取值器
 * @property {function():object|null} event event 底座取值器
 */

/**
 * 装配功能上下文。
 * net/event/chat 懒取（install 时机可能早于底座安装）；alive 反映 entry.running，
 * on.push/on.chat/on.event 订阅自动登记到 entry.triggers，pause 时统一摘除（feat 卸载不靠自己记 off）。
 * signal/托管定时器是取消语义面：pause 主动 abort + 清托管定时器（详见各成员 JSDoc）。
 * @param {object} entry 功能条目（reactor Entry：spec/running/controller/timers/triggers）
 * @param {CtxDeps} deps 注入依赖
 * @returns {object} 上下文对象
 */
export function createCtx(entry, deps) {
  return {
    id: entry.spec.id,
    /** @returns {object|null} pocketcc.net 底座（ESM 导入，无 window 依赖） */
    get net() {
      return deps.net();
    },
    /** @returns {object|null} pocketcc.chat 底座（ESM 导入，无 window 依赖） */
    get chat() {
      return deps.chat();
    },
    /**
     * 功能当前是否激活，在飞流程的 await 回来之后用它判是否继续
     * @returns {boolean}
     */
    alive: function () {
      return entry.running;
    },
    /**
     * 本次激活的取消信号：每次 activate 新建，pause 时 abort（在飞流程可读 aborted 提前退出，
     * 典型用法 sleep(ms, ctx.signal) 早醒）。每次 run/await 回来现读，不跨 pause 缓存——resume 后是全新信号。
     * 首次激活前为 null。
     * @returns {AbortSignal|null}
     */
    get signal() {
      return entry.controller ? entry.controller.signal : null;
    },
    /**
     * 托管一次性定时器：pause 自动清（暂停后不会再 fire），到点 fire 时自移除托管登记。
     * 非激活态 no-op 返 -1。生命周期类延迟（唤醒去抖/错峰加入等）优先用它，替代裸 setTimeout。
     * @param {function():void} fn 回调
     * @param {number} ms 延迟毫秒
     * @returns {number} 托管句柄 id（配 ctx.clearTimeout）；非激活态 -1
     */
    setTimeout: function (fn, ms) {
      if (!entry.running) return -1;
      var id = setTimeout(function () {
        entry.timers.delete(id);
        fn();
      }, ms);
      entry.timers.set(id, { kind: 'timeout', handle: id });
      return id;
    },
    /**
     * 托管周期定时器：pause 自动清；常驻直到 ctx.clearInterval 或 pause。
     * 非激活态 no-op 返 -1。可见性/门控驱动的轮询用它托管兜底，start/stop 语义仍归 feat。
     * @param {function():void} fn 回调
     * @param {number} ms 周期毫秒
     * @returns {number} 托管句柄 id（配 ctx.clearInterval）；非激活态 -1
     */
    setInterval: function (fn, ms) {
      if (!entry.running) return -1;
      var id = setInterval(fn, ms);
      entry.timers.set(id, { kind: 'interval', handle: id });
      return id;
    },
    /**
     * 清托管一次性定时器。未知 id（已 fire 自移除/pause 已清/重复 clear）静默 no-op，
     * feat 的 stop 函数无需关心框架是否已代清。
     * @param {number} id ctx.setTimeout 返回的句柄
     */
    clearTimeout: function (id) {
      var t = entry.timers.get(id);
      if (!t) return;
      clearTimeout(t.handle);
      entry.timers.delete(id);
    },
    /**
     * 清托管周期定时器。未知 id 静默 no-op（口径同 ctx.clearTimeout）。
     * @param {number} id ctx.setInterval 返回的句柄
     */
    clearInterval: function (id) {
      var t = entry.timers.get(id);
      if (!t) return;
      clearInterval(t.handle);
      entry.timers.delete(id);
    },
    on: {
      /**
       * 订阅一条服务端推送（net.<cmd>），退订自动登记
       * @param {number} cmd 命令号
       * @param {function(object):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      push: function (cmd, handler) {
        const unsub = deps.bus.on('net.' + cmd, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一条服务端**应答**（net.resp.<cmd>），退订自动登记
       * 用于消费“本端（含游戏 UI 自己）刚发出去请求的回复”——这类应答不 emit 游戏全局事件。
       * raw 池化复用，Event 只包引用：要跨拍持有需自行快照字段。
       * @param {number} cmd 命令号
       * @param {function(object):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      resp: function (cmd, handler) {
        const unsub = deps.bus.on('net.resp.' + cmd, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一条**本端发包**（net.req.<cmd>，载荷 {cmd,key,data,ts}），退订自动登记。
       * 用途：「请求带而应答不带」的字段只能从发包侧拿（实证：秘境 8532 DROP_INFO 请求带 {x,y}，应答不带）。
       * 必须经 pocketcc.net.onReq 走——它会按需拉起发送 hook；直接 bus.on 会订到一条永不派发的空事件。
       * @param {number} cmd 命令号
       * @param {function(object):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      req: function (cmd, handler) {
        const api = deps.net();
        if (!api || !api.onReq) {
          deps.log.warn('net base unavailable, req subscribe for cmd %s is a no-op', cmd);
          return function () {};
        }
        const unsub = api.onReq(cmd, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一个游戏事件（EventCenter），底座不可用时空订阅并告警
       * @param {string} name 事件名
       * @param {function(...*):void} handler 处理器
       * @returns {function():void} 退订函数
       */
      event: function (name, handler) {
        const event = deps.event();
        if (!event || !event.install()) {
          deps.log.warn('event base unavailable, skip subscribe %s', name);
          return function () {};
        }
        const unsub = event.on(name, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
      /**
       * 订阅一条聊天推送（chat 底座直连聊天 socket，自带实例更替重挂），退订自动登记。
       * 语义 type 与 socket 事件的映射见 core/chat.js SOCKET_MAP；载荷即 socket 实参（非池化，跨拍需自行快照）。
       * @param {string} type 语义类型：push 频道消息 | pm 私聊 | update 消息更新 | del 消息删除 | reconnect 重连成功
       * @param {function(object):void} handler 处理器（reconnect 无载荷）
       * @returns {function():void} 退订函数
       */
      chat: function (type, handler) {
        const api = deps.chat();
        if (!api || !api.on) {
          deps.log.warn('chat base unavailable, skip subscribe %s', type);
          return function () {};
        }
        const unsub = api.on(type, handler);
        entry.triggers.add(unsub);
        return unsub;
      },
    },
  };
}
