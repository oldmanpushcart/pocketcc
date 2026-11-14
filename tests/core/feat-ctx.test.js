// createCtx（功能上下文工厂）装配契约单测：deps 全注入，零浏览器桩直驱。
// 覆盖窄化后的接触面（无 game/bus）、on.* 五口订阅登记与降级、底座 getter 懒取（活绑定语义）、
// alive/signal 现读 entry 状态、托管定时器登记形状（reactor pause 按 {kind,handle} 清）。
// 定时器/signal 的暂停-恢复集成语义仍由 tests/core/reactor.test.js 经真 reactor 覆盖，此处只钉装配契约。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCtx } from '../../extension/src/core/feat-ctx.js';

/**
 * 最小 entry（reactor Entry 的装配相关子集）
 * @param {string} id 功能 id
 * @returns {object} entry
 */
function makeEntry(id) {
  return {
    spec: { id: id },
    running: false,
    controller: null,
    timers: new Map(),
    triggers: new Set(),
  };
}

/**
 * 假 deps：bus 记录订阅、warns 记录告警、bases 可运行时换底座（模拟 install 前后活绑定变化）
 * @returns {{deps:object, subs:object[], warns:Array, bases:object}}
 */
function makeDeps() {
  const subs = [];
  const warns = [];
  const bases = { net: null, chat: null, event: null };
  const deps = {
    log: {
      info() {},
      debug() {},
      warn(...args) {
        warns.push(args);
      },
    },
    bus: {
      on(type, handler) {
        const rec = { type: type, handler: handler, off: false };
        subs.push(rec);
        return () => {
          rec.off = true;
        };
      },
    },
    net: () => bases.net,
    chat: () => bases.chat,
    event: () => bases.event,
  };
  return { deps: deps, subs: subs, warns: warns, bases: bases };
}

test('createCtx：窄化接触面 —— 无 game/bus，生命周期+订阅+底座三件套齐', () => {
  const { deps } = makeDeps();
  const ctx = createCtx(makeEntry('t-surface'), deps);
  assert.equal(ctx.id, 't-surface');
  assert.equal('game' in ctx, false, 'ctx.game 已窄化（游戏符号走 ESM 直取 core/game.js）');
  assert.equal('bus' in ctx, false, 'ctx.bus 已窄化（盘点零消费者）');
  for (const k of [
    'net',
    'chat',
    'alive',
    'signal',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'on',
  ]) {
    assert.ok(k in ctx, 'ctx 应有成员 ' + k);
  }
  for (const k of ['push', 'resp', 'req', 'event', 'chat']) {
    assert.equal(typeof ctx.on[k], 'function', 'on.' + k + ' 应是函数');
  }
});

test('createCtx：on.push/on.resp 经 bus 订阅，退订自动登记 entry.triggers', () => {
  const { deps, subs } = makeDeps();
  const entry = makeEntry('t-push');
  const ctx = createCtx(entry, deps);
  const off1 = ctx.on.push(12003, () => {});
  const off2 = ctx.on.resp(8521, () => {});
  assert.equal(subs.length, 2);
  assert.equal(subs[0].type, 'net.12003', 'push 订阅 net.<cmd>');
  assert.equal(subs[1].type, 'net.resp.8521', 'resp 订阅 net.resp.<cmd>');
  assert.equal(entry.triggers.size, 2, '退订函数须登记（reactor pause 统一摘除）');
  off1();
  off2();
  assert.ok(subs[0].off && subs[1].off, '返回的退订函数应真的退订');
});

test('createCtx：on.req 必须经 net.onReq；底座缺失空订阅并告警', () => {
  const { deps, warns, bases } = makeDeps();
  const entry = makeEntry('t-req');
  const ctx = createCtx(entry, deps);
  // 底座缺失：no-op + warn，不登记
  const noop = ctx.on.req(8532, () => {});
  assert.equal(typeof noop, 'function');
  noop(); // 不抛
  assert.equal(entry.triggers.size, 0);
  assert.equal(warns.length, 1);
  // 底座就绪：走 api.onReq（不是 bus.on——直接 bus 订 req 是永不派发的空事件）
  const reqSubs = [];
  bases.net = {
    onReq(cmd, handler) {
      const rec = { cmd: cmd, handler: handler, off: false };
      reqSubs.push(rec);
      return () => {
        rec.off = true;
      };
    },
  };
  const off = ctx.on.req(8532, () => {});
  assert.equal(reqSubs.length, 1);
  assert.equal(reqSubs[0].cmd, 8532);
  assert.equal(entry.triggers.size, 1);
  off();
  assert.ok(reqSubs[0].off);
});

test('createCtx：on.event 经 install() 闸门；底座不可用空订阅并告警', () => {
  const { deps, warns, bases } = makeDeps();
  const entry = makeEntry('t-event');
  const ctx = createCtx(entry, deps);
  // null 底座
  ctx.on.event('SomeEvent', () => {});
  assert.equal(entry.triggers.size, 0);
  assert.equal(warns.length, 1);
  // install() 失败
  bases.event = { install: () => false };
  ctx.on.event('SomeEvent', () => {});
  assert.equal(entry.triggers.size, 0);
  assert.equal(warns.length, 2);
  // install() 成功：订阅并登记
  const evSubs = [];
  bases.event = {
    install: () => true,
    on(name, handler) {
      const rec = { name: name, handler: handler, off: false };
      evSubs.push(rec);
      return () => {
        rec.off = true;
      };
    },
  };
  const off = ctx.on.event('SomeEvent', () => {});
  assert.equal(evSubs.length, 1);
  assert.equal(evSubs[0].name, 'SomeEvent');
  assert.equal(entry.triggers.size, 1);
  off();
  assert.ok(evSubs[0].off);
});

test('createCtx：on.chat 经 chat.on；底座缺失空订阅并告警', () => {
  const { deps, warns, bases } = makeDeps();
  const entry = makeEntry('t-chat');
  const ctx = createCtx(entry, deps);
  ctx.on.chat('push', () => {});
  assert.equal(entry.triggers.size, 0);
  assert.equal(warns.length, 1);
  const chatSubs = [];
  bases.chat = {
    on(type, handler) {
      const rec = { type: type, handler: handler, off: false };
      chatSubs.push(rec);
      return () => {
        rec.off = true;
      };
    },
  };
  const off = ctx.on.chat('pm', () => {});
  assert.equal(chatSubs.length, 1);
  assert.equal(chatSubs[0].type, 'pm');
  assert.equal(entry.triggers.size, 1);
  off();
  assert.ok(chatSubs[0].off);
});

test('createCtx：net/chat getter 读时现取 —— 活绑定语义，装配期不快照', () => {
  const { deps, bases } = makeDeps();
  const ctx = createCtx(makeEntry('t-lazy'), deps);
  assert.equal(ctx.net, null, 'install 前为 null');
  assert.equal(ctx.chat, null);
  const netApi = { tag: 'net' };
  const chatApi = { tag: 'chat' };
  bases.net = netApi;
  bases.chat = chatApi;
  assert.equal(
    ctx.net,
    netApi,
    '底座 install 后 getter 应现取新值（register 早于 install 的时序）',
  );
  assert.equal(ctx.chat, chatApi);
});

test('createCtx：alive/signal 现读 entry 状态，不缓存', () => {
  const entry = makeEntry('t-alive');
  const { deps } = makeDeps();
  const ctx = createCtx(entry, deps);
  assert.equal(ctx.alive(), false);
  assert.equal(ctx.signal, null, '首次激活前 signal 为 null');
  entry.running = true;
  assert.equal(ctx.alive(), true);
  entry.controller = new AbortController();
  assert.equal(ctx.signal, entry.controller.signal);
  assert.equal(ctx.signal.aborted, false);
  entry.controller.abort();
  assert.equal(ctx.signal.aborted, true, 'pause abort 后现读即见');
  entry.running = false;
  assert.equal(ctx.alive(), false);
});

test('createCtx：托管定时器登记 {kind,handle} 形状，fire 自移除，非激活返 -1', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  const entry = makeEntry('t-timers');
  const { deps } = makeDeps();
  const ctx = createCtx(entry, deps);
  entry.running = true;

  let fired = 0;
  const id = ctx.setTimeout(() => fired++, 100);
  assert.notEqual(id, -1);
  const rec = entry.timers.get(id);
  assert.equal(rec.kind, 'timeout', '登记形状须为 {kind,handle}（reactor pause 按 kind 分清）');
  assert.equal(rec.handle, id);
  mock.timers.tick(100);
  assert.equal(fired, 1);
  assert.equal(entry.timers.has(id), false, 'fire 自移除托管登记');

  const iid = ctx.setInterval(() => fired++, 100);
  assert.equal(entry.timers.get(iid).kind, 'interval');
  mock.timers.tick(300);
  assert.equal(fired, 4);
  ctx.clearInterval(iid);
  assert.equal(entry.timers.has(iid), false);
  mock.timers.tick(500);
  assert.equal(fired, 4, 'clear 后不再 tick');

  entry.running = false;
  assert.equal(
    ctx.setTimeout(() => fired++, 10),
    -1,
    '非激活态 no-op 返 -1',
  );
  assert.equal(
    ctx.setInterval(() => fired++, 10),
    -1,
  );
  ctx.clearTimeout(999999); // 未知句柄静默 no-op
  ctx.clearInterval(-1);
  mock.timers.tick(100);
  assert.equal(fired, 4);
});
