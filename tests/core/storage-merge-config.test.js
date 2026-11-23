// storage.mergeConfig 契约单测（「导入设置」的落盘面）：N 项只落一次盘、逐键并入而非整块替换、
// 保留键拒收（外来文件把整份配置当成一个键塞进来会自我嵌套，data 更不属于设置）、
// 命名空间未设时必须 reject（「还不知道该写进哪个账号」绝不能静默当成写成功）。
// 假 bridge 与 tests/core/registry.test.js 同构（storage.js 的 import 链有 window 副作用，先桩全局再动态 import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NS } from '../../extension/src/core/constants.js';

const messageHandlers = [];
/** @type {Map<string,*>} fullKey（含 UID 前缀）-> 值，模拟 ISOLATED 侧 chrome.storage.local */
const fakeStore = new Map();
/** @type {number} 落盘笔数（证明「整块只写一次」） */
let setCount = 0;

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
      else if (msg.op === 'set') {
        setCount++;
        // 走一次序列化，模拟真实存储：写进去的就是盘上那份，不留内存引用别名
        fakeStore.set(msg.key, JSON.parse(JSON.stringify(msg.value == null ? null : msg.value)));
      } else if (msg.op === 'remove') fakeStore.delete(msg.key);
      const reply = {
        source: globalThis.window,
        data: { __ns: NS, dir: 'bridge->main', id: msg.id, result },
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

const { storage, setNamespace } = await import('../../extension/src/core/storage.js');

/** @type {string} 本次测试用的 UID 前缀 */
const NS_UID = 'pocketcc.u7.';
/** @type {string} 配置 blob 的落盘全键 */
const CFG = NS_UID + 'pocketcc.config';

test('命名空间未设：mergeConfig 报错而不是静默成功', async () => {
  setCount = 0;
  await assert.rejects(() => storage.mergeConfig({ 'pocketcc.a': { enabled: true } }));
  assert.equal(setCount, 0, '一次盘都不该落');
  assert.equal(fakeStore.size, 0);
});

test('逐键并入、整块只落一次盘、保留键拒收', async () => {
  // 盘上已有两项：b 要被覆盖，a 必须原样留着（并入 ≠ 替换）
  fakeStore.set(CFG, {
    'pocketcc.a': { enabled: true, keep: 1 },
    'pocketcc.b': { enabled: false },
  });
  fakeStore.set(NS_UID + 'pocketcc.data', { 'today.runs': 9 });
  setNamespace(NS_UID);
  setCount = 0;
  const res = await storage.mergeConfig({
    'pocketcc.b': { enabled: true },
    'pocketcc.c': { enabled: true },
    'pocketcc.config': { nested: 1 },
    'pocketcc.data': { runs: 1 },
  });
  assert.deepEqual(res.applied, ['pocketcc.b', 'pocketcc.c']);
  assert.deepEqual(res.rejected, ['pocketcc.config', 'pocketcc.data']);
  assert.equal(setCount, 1, '三项写入也只回写整块一次');
  const onDisk = fakeStore.get(CFG);
  assert.deepEqual(onDisk['pocketcc.a'], { enabled: true, keep: 1 }, '未提及的键不得被抹掉');
  assert.deepEqual(onDisk['pocketcc.b'], { enabled: true });
  assert.deepEqual(onDisk['pocketcc.c'], { enabled: true });
  assert.ok(!('pocketcc.config' in onDisk), '保留键绝不入 blob');
  assert.deepEqual(
    fakeStore.get(NS_UID + 'pocketcc.data'),
    { 'today.runs': 9 },
    'data blob 一字不动',
  );
});

test('getAllConfig 只给配置 blob 的拷贝，运行数据不在导出面里', async () => {
  const all = await storage.getAllConfig();
  assert.deepEqual(Object.keys(all).sort(), ['pocketcc.a', 'pocketcc.b', 'pocketcc.c']);
  assert.ok(!('today.runs' in all), 'data 混进导出面就等于「只导设置」这句假了');
  delete all['pocketcc.a']; // 浅拷贝只护顶层键集：删拷贝里的键不得动到内存 blob
  const again = await storage.getAllConfig();
  assert.ok('pocketcc.a' in again);
});
