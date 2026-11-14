// registry 编排契约单测：启动策略（底座 install 先于 internal apply、reactor 只推启用）、
// 面板热更单 feat 推 + toModuleCfg 归一、internal 走 apply 回调、降级补载全量重推（含未启用纠偏）、
// toModuleCfg 缺声明降级。dispatch 收一份后这些编排语义是 applyFeature 单一路径的契约。
// registry 的 import 链（storage/player/net/collect）求值期有 window 副作用，故先最小桩化浏览器全局再动态 import
// （同 reactor.test.js 口径）；storage 走 window.postMessage bridge，这里用内存假 bridge 微任务应答读写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NS } from '../../extension/src/core/constants.js';

// ── 浏览器全局最小桩 + 假 storage bridge ─────────────────────────────────
const messageHandlers = [];
/** @type {Map<string,*>} fullKey（含 UID 前缀）-> 值，模拟 ISOLATED 侧 chrome.storage.local */
const fakeStore = new Map();
globalThis.window = globalThis.window || {
  addEventListener(type, fn) {
    if (type === 'message') messageHandlers.push(fn);
  },
  removeEventListener() {},
  location: { href: '' },
  document: {},
  postMessage(msg) {
    if (!msg || msg.__ns !== NS || msg.dir !== 'main->bridge') return;
    queueMicrotask(() => {
      let result;
      if (msg.op === 'get') result = fakeStore.get(msg.key);
      else if (msg.op === 'set') fakeStore.set(msg.key, msg.value);
      else if (msg.op === 'remove') fakeStore.delete(msg.key);
      const reply = {
        source: globalThis.window,
        data: { __ns: NS, dir: 'bridge->main', id: msg.id, result: result },
      };
      for (const h of messageHandlers) h(reply);
    });
  },
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
const registry = await import('../../extension/src/core/registry.js');
const { setNamespace } = await import('../../extension/src/core/storage.js');
const { bus, EVT } = await import('../../extension/src/core/bus.js');
const { netApi } = await import('../../extension/src/core/net.js');
const { eventApi } = await import('../../extension/src/core/event.js');

/** 冲刷微任务队列（假 bridge 微任务应答，setImmediate 未被劫持可用作屏障） */
function flush() {
  return new Promise((r) => setImmediate(r));
}

/**
 * 轮询等待条件成立（loadAllConfigs 逐键串行读盘，每键一次微任务应答，
 * 单个 setImmediate 屏障不保证全链 drain；带超时守卫避免挂死）
 * @param {function():boolean} cond 条件
 * @returns {Promise<void>}
 */
async function waitFor(cond) {
  for (let i = 0; i < 500 && !cond(); i++) await flush();
  assert.ok(cond(), 'waitFor 超时：条件未成立');
}

/**
 * 最小合法 spec（同 reactor.test.js 口径）：齐面板描述符必填项，无 symbols 免依赖自检。
 * @param {string} id 唯一功能 id（entries 是模块级 Map，跨用例不复用）
 * @param {object} [hooks] configure/toModuleCfg 等钩子覆盖
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

/** 为全部已注册功能补 configs（模拟 loadAllConfigs 的前置保证，避免 startFeatures 读空） */
function ensureConfigs() {
  for (const f of registry.features()) {
    if (!registry.configs[f.id]) registry.configs[f.id] = Object.assign({}, f.defaults);
  }
}

test('startFeatures：底座 install 先于 internal apply；reactor 只推启用', () => {
  const order = [];
  const realNetInstall = netApi.install;
  const realEventInstall = eventApi.install;
  netApi.install = () => {
    order.push('net.install');
    return true;
  };
  eventApi.install = () => {
    order.push('event.install');
    return true;
  };
  const realAt = globalThis.window.pocketccAntiThrottle;
  globalThis.window.pocketccAntiThrottle = {
    applyPolicy: () => order.push('keepAlive.apply'),
  };
  try {
    const pushed = [];
    reactor.register(
      makeSpec('reg-start-on', { configure: (cfg) => pushed.push(['on', cfg.enabled]) }),
    );
    reactor.register(
      makeSpec('reg-start-off', { configure: (cfg) => pushed.push(['off', cfg.enabled]) }),
    );
    ensureConfigs();
    registry.configs['reg-start-on'].enabled = true;
    registry.startFeatures();
    assert.deepEqual(
      order,
      ['net.install', 'event.install', 'keepAlive.apply'],
      '两个底座 install 必须先于 internal apply（恢复持久化态依赖底座就位）',
    );
    assert.deepEqual(
      pushed,
      [['on', true]],
      '未启用功能启动期不推（保持 reactor 默认停摆，不空推）',
    );
  } finally {
    netApi.install = realNetInstall;
    eventApi.install = realEventInstall;
    if (realAt === undefined) delete globalThis.window.pocketccAntiThrottle;
    else globalThis.window.pocketccAntiThrottle = realAt;
  }
});

test('applyFeature：热更只推目标 feat，toModuleCfg 归一后与 enabled 合并', () => {
  const seen = [];
  const other = [];
  reactor.register(
    makeSpec('reg-hot', {
      toModuleCfg: (c) => ({ delayMs: (c.delaySec | 0) * 1000 }),
      configure: (cfg) => seen.push(cfg),
    }),
  );
  reactor.register(makeSpec('reg-hot-other', { configure: (cfg) => other.push(cfg) }));
  ensureConfigs();
  registry.configs['reg-hot'].enabled = true;
  registry.configs['reg-hot'].delaySec = 3;
  const f = registry.findFeature('reg-hot');
  registry.applyFeature(f);
  assert.deepEqual(seen, [{ enabled: true, delayMs: 3000 }], '秒→毫秒归一后与 enabled 合并推入');
  assert.equal(other.length, 0, '热更不得惊动其它功能');
  registry.configs['reg-hot'].enabled = false;
  registry.applyFeature(f);
  assert.deepEqual(
    seen[1],
    { enabled: false, delayMs: 3000 },
    'enabled 翻假也推（面板关开关靠它 pause）',
  );
});

test('applyFeature：internal 走 apply 回调；无 apply 的内联 no-op', () => {
  const calls = [];
  globalThis.window.pocketccAntiThrottle = {
    applyPolicy: (en, hz) => calls.push([en, hz]),
  };
  try {
    ensureConfigs();
    registry.configs.keepAlive.enabled = true;
    registry.configs.keepAlive.idleHz = 15;
    registry.applyFeature(registry.findFeature('keepAlive'));
    assert.deepEqual(calls, [[true, 15]], 'keepAlive 经 apply 驱动 anti-throttle 档位');
    registry.applyFeature(registry.findFeature('reconnect')); // 无 apply：no-op 不抛（session hook 直读 configs）
  } finally {
    delete globalThis.window.pocketccAntiThrottle;
  }
});

test('降级补载：player.ready 后补读盘全量重推（含未启用纠偏），事件序正确', async () => {
  const pushes = [];
  reactor.register(
    makeSpec('reg-reload-a', { configure: (cfg) => pushes.push(['a', cfg.enabled]) }),
  );
  reactor.register(
    makeSpec('reg-reload-b', { configure: (cfg) => pushes.push(['b', cfg.enabled]) }),
  );
  // ① 降级启动：命名空间未设 → configs 回落 defaults（两者默认皆关）
  await registry.loadAllConfigs({ preLogin: true });
  assert.equal(registry.configs['reg-reload-a'].enabled, false);
  assert.equal(registry.configs['reg-reload-b'].enabled, false);
  // 模拟先跑时偏错的启用态：b 在降级期被误启用（已 install 在跑）——补载要能把它纠回停用
  registry.configs['reg-reload-b'].enabled = true;
  registry.applyFeature(registry.findFeature('reg-reload-b'));
  assert.equal(reactor.isRunning('reg-reload-b'), true);
  // ② UID 到位：设前缀 + 盘上种真实值（a 启用、b 停用）
  setNamespace('pocketcc.u9.');
  fakeStore.set('pocketcc.u9.pocketcc.config', {
    'test.reg-reload-a': { enabled: true },
    'test.reg-reload-b': { enabled: false },
  });
  const events = [];
  const offReload = bus.on(EVT.PLAYER_CONFIGS_RELOADED, () => events.push('reloaded'));
  const offUi = bus.on(EVT.UI_REFRESH, () => events.push('ui'));
  try {
    // ③ ready → 补载：全量重推（b 未启用也推，纠偏先跑时偏错的启用态）
    bus.emit(EVT.PLAYER_READY, { uid: '9' });
    await waitFor(() => events.length >= 2); // 事件在全部读盘+重推完成后才发，作 drain 判据
    assert.deepEqual(
      pushes.filter((p) => p[0] === 'a'),
      [['a', true]],
      'a 按盘上值启用推入',
    );
    assert.deepEqual(
      pushes.filter((p) => p[0] === 'b'),
      [
        ['b', true],
        ['b', false],
      ],
      'b 先跑时误启用，补载按盘上值纠回停用（全量重推纠偏语义，与启动期只推启用相区分）',
    );
    assert.equal(reactor.isRunning('reg-reload-b'), false, '纠偏后 b 应已 pause');
    assert.equal(reactor.isRunning('reg-reload-a'), true, 'a 按盘上值激活');
    assert.deepEqual(events, ['reloaded', 'ui'], 'configs 刷新后再通知 UI 回写控件');
    // ④ 非降级路径：再次 ready 不得触发补载
    const before = pushes.length;
    bus.emit(EVT.PLAYER_READY, { uid: '9' });
    await flush();
    await flush();
    assert.equal(pushes.length, before, 'loadedDegraded 已复位，正常路径 ready 不重推');
  } finally {
    offReload();
    offUi();
  }
});

test('applyFeature：toModuleCfg 缺声明降级只透传 enabled（不抛、不阻断开关）', () => {
  const seen = [];
  const spec = makeSpec('reg-nomodule', { configure: (cfg) => seen.push(cfg) });
  delete spec.toModuleCfg;
  reactor.register(spec); // register 期 warn 点名但不阻断
  ensureConfigs();
  registry.configs['reg-nomodule'].enabled = true;
  registry.configs['reg-nomodule'].stray = 1;
  registry.applyFeature(registry.findFeature('reg-nomodule'));
  assert.deepEqual(
    seen,
    [{ enabled: true }],
    '未声明字段不透传，开关仍生效（异常靠日志定位而不是靠崩）',
  );
});
