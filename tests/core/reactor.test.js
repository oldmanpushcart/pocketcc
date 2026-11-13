// reactor 取消语义契约单测：ctx.signal（每次激活新建/pause abort/resume 全新）+ 托管定时器
// （pause 自动清、fire 自移除、!running no-op、clear 对未知句柄安全）+ pause 顺序 + sleep(signal) 早醒。
// reactor 的 import 链（net/chat/event）求值期挂 window.pocketcc，故先最小桩化浏览器全局再动态 import
// （同 potion-craft 口径）；定时器用 node:test mock timers 驱动，零真实时钟。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── 浏览器全局最小桩（模块加载期需要，函数体不触碰）─────────────────────
globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
  document: {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.chrome = globalThis.chrome || {
  runtime: { id: 'test', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};

// core 链里若有 import 期常驻 setInterval（浏览器常驻、Node 会拖住进程），只 unref 不参与被测逻辑
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { reactor } = await import('../../extension/src/core/reactor.js');
const { sleep } = await import('../../extension/src/core/util.js');

/** 冲刷微任务队列（mock timers 下 setImmediate 未被劫持，可用作 tick 之间的屏障） */
function flush() {
  return new Promise((r) => setImmediate(r));
}

/**
 * 最小合法 spec：齐面板描述符必填项（label/storageKey/defaults/toModuleCfg），无 symbols 免依赖自检。
 * @param {string} id 唯一功能 id（entries 是模块级 Map，跨用例不复用）
 * @param {object} [hooks] install/run/pause 等钩子覆盖
 * @returns {object} spec
 */
function makeSpec(id, hooks) {
  return Object.assign(
    {
      id: id,
      label: id,
      storageKey: 'test.' + id,
      defaults: { enabled: false },
      toModuleCfg: (c) => ({ enabled: !!(c && c.enabled) }),
    },
    hooks || {},
  );
}

test('ctx.signal：每次 activate 新建，pause 后 aborted，resume 是全新信号', () => {
  const seen = [];
  let ctxRef = null;
  reactor.register(
    makeSpec('unit-signal', {
      run(ctx) {
        ctxRef = ctx;
        seen.push(ctx.signal);
      },
    }),
  );
  reactor.setConfig('unit-signal', { enabled: true });
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof AbortSignal, 'run 内应拿到真实 AbortSignal');
  assert.equal(seen[0].aborted, false);
  assert.equal(ctxRef.alive(), true);

  reactor.setConfig('unit-signal', { enabled: false });
  assert.equal(seen[0].aborted, true, 'pause 必须主动 abort');
  assert.equal(ctxRef.alive(), false);
  assert.equal(ctxRef.signal.aborted, true, 'pause 后 signal 仍可读（aborted），不是 null');

  reactor.setConfig('unit-signal', { enabled: true });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1], seen[0], 'resume 必须是全新信号，不复用已 abort 的旧信号');
  assert.equal(seen[1].aborted, false);
  reactor.setConfig('unit-signal', { enabled: false }); // 收尾
});

test('托管 setTimeout：到点 fire 且自移除；pause 后 tick 过点不 fire', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let fired = 0;
  let ctxRef = null;
  reactor.register(makeSpec('unit-timeout', { run: (ctx) => (ctxRef = ctx) }));
  reactor.setConfig('unit-timeout', { enabled: true });

  const id = ctxRef.setTimeout(() => fired++, 100);
  assert.notEqual(
    id,
    -1,
    '激活态应返回真实句柄（浏览器为数字 id，Node mock timers 为对象，不钉形状）',
  );
  mock.timers.tick(100);
  assert.equal(fired, 1, '到点应 fire');
  ctxRef.clearTimeout(id); // fire 自移除后再 clear 是安全 no-op

  const id2 = ctxRef.setTimeout(() => fired++, 100);
  reactor.setConfig('unit-timeout', { enabled: false });
  mock.timers.tick(500);
  assert.equal(fired, 1, 'pause 已清托管定时器，过点不得 fire');
  ctxRef.clearTimeout(id2); // pause 已清后再 clear 同样安全
});

test('托管 setInterval：pause 清掉，resume 可重挂，clear 后不再 tick', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let ticks = 0;
  let ctxRef = null;
  reactor.register(makeSpec('unit-interval', { run: (ctx) => (ctxRef = ctx) }));
  reactor.setConfig('unit-interval', { enabled: true });

  ctxRef.setInterval(() => ticks++, 100);
  mock.timers.tick(300);
  assert.equal(ticks, 3);

  reactor.setConfig('unit-interval', { enabled: false });
  mock.timers.tick(1000);
  assert.equal(ticks, 3, 'pause 必须清掉托管 interval');

  reactor.setConfig('unit-interval', { enabled: true });
  const id2 = ctxRef.setInterval(() => ticks++, 100);
  mock.timers.tick(200);
  assert.equal(ticks, 5, 'resume 后可重挂');
  ctxRef.clearInterval(id2);
  mock.timers.tick(500);
  assert.equal(ticks, 5, '显式 clear 后不再 tick');
  reactor.setConfig('unit-interval', { enabled: false }); // 收尾
});

test('ctx.setTimeout/setInterval：非激活态 no-op 返 -1；clear 未知句柄不抛', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let ctxRef = null;
  let fired = 0;
  reactor.register(makeSpec('unit-noop', { run: (ctx) => (ctxRef = ctx) }));
  reactor.setConfig('unit-noop', { enabled: true });
  reactor.setConfig('unit-noop', { enabled: false });

  assert.equal(
    ctxRef.setTimeout(() => fired++, 10),
    -1,
    '暂停态 setTimeout 应 no-op 返 -1',
  );
  assert.equal(
    ctxRef.setInterval(() => fired++, 10),
    -1,
    '暂停态 setInterval 应 no-op 返 -1',
  );
  mock.timers.tick(100);
  assert.equal(fired, 0);
  // 未知句柄（-1/不存在的 id）静默 no-op，feat 的 stop 函数无需关心框架是否已代清
  ctxRef.clearTimeout(-1);
  ctxRef.clearTimeout(999999);
  ctxRef.clearInterval(-1);
  ctxRef.clearInterval(999999);
});

test('pause 顺序契约：钩子内 running=false、signal 已 aborted、托管定时器已清', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let fired = 0;
  let probe = null;
  reactor.register(
    makeSpec('unit-pause-order', {
      run(ctx) {
        ctx.setTimeout(() => fired++, 50);
      },
      pause(ctx) {
        probe = {
          alive: ctx.alive(),
          aborted: ctx.signal ? ctx.signal.aborted : null,
          late: ctx.setTimeout(() => fired++, 10),
        };
      },
    }),
  );
  reactor.setConfig('unit-pause-order', { enabled: true });
  reactor.setConfig('unit-pause-order', { enabled: false });

  assert.ok(probe, 'pause 钩子应被调用');
  assert.equal(probe.alive, false, '钩子跑在 running 置否之后');
  assert.equal(probe.aborted, true, '钩子跑在 abort 之后');
  assert.equal(probe.late, -1, '钩子内再排托管定时器应 no-op（running 已否）');
  mock.timers.tick(200);
  assert.equal(fired, 0, 'pause 前挂的托管定时器必须已被清掉');
});

test('sleep(ms, ctx.signal)：pause abort 早醒，在飞流程靠 alive() 退出', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());

  let woke = false;
  let aliveAfterWake = null;
  reactor.register(
    makeSpec('unit-sleep-signal', {
      run(ctx) {
        (async () => {
          await sleep(5000, ctx.signal);
          woke = true;
          aliveAfterWake = ctx.alive();
        })();
      },
    }),
  );
  reactor.setConfig('unit-sleep-signal', { enabled: true });
  await flush();
  assert.equal(woke, false, '5s 未到不应醒');

  reactor.setConfig('unit-sleep-signal', { enabled: false });
  await flush();
  assert.equal(woke, true, 'pause abort 应让 sleep 提前 resolve（不 reject、不挂死）');
  assert.equal(aliveAfterWake, false, '早醒回来 alive() 已否，在飞流程自然退出');
  mock.timers.tick(10000); // 原 5s timer 已被 sleep 内部清掉，tick 无副作用
});
