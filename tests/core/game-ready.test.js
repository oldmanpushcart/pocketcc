// 「游戏 bundle 未加载」窗口的软失败契约（实证事故：模块/面板求值期读配置表，`__require` 尚未定义，
// 每取必抛 ReferenceError，再被 probe 报成「symbol drift」，把加载时序误导成改版符号漂移）。
// Node 环境天然没有 `__require`，正好当这个「加载早窗」的仿真，钉住两条不变量：
//   ① game.ready()=false 时 game.get 不调 `__require`（不抛错）直接回 null；
//   ② probe 在该窗口只回 null、不打符号漂移警报；警报只留给「bundle 已就位却解析不到」= 真漂移（同键仍只提一次）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { game } from '../../extension/src/core/game.js';
import { probe, probeStatus, reprobe } from '../../extension/src/core/acl-engine.js';

/**
 * 跑 fn 并回收期间打到 console.warn 的行（log.js 的 emit 在调用点现取 console.warn，故替换生效）。
 * @param {Function} fn 被测调用
 * @returns {{lines:string[]}} 捕获到的 warn 文本
 */
function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(String(a[0]));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return { lines };
}

test('game.ready()：__require 未定义时回 false，get/requireAll 软失败回 null 而不抛 ReferenceError', () => {
  assert.equal(game.ready(), false);
  assert.equal(game.get('TableManager'), null);
  assert.equal(game.requireAll(['TableManager']).TableManager, null);
});

test('probe：bundle 未就位时回 null 且不发「symbol drift」警报（加载时序不是漂移）', () => {
  const got = captureWarn(() => {
    assert.equal(
      probe('unit.bundle-not-loaded', () => game.get('TableManager')),
      null,
    );
  });
  assert.deepEqual(got.lines, []);
  // 推迟的键不得隐没：进 deferred 名单（可观测），重探后名单清干净
  assert.ok(probeStatus().deferred.indexOf('unit.bundle-not-loaded') >= 0, '推迟的键应可查');
  reprobe('unit.bundle-not-loaded');
  assert.equal(probeStatus().deferred.indexOf('unit.bundle-not-loaded'), -1);
});

test('probe：bundle 已就位但解析不到时照旧警报一次，且同键不重复', () => {
  const origReady = game.ready;
  game.ready = () => true;
  try {
    const first = captureWarn(() => {
      assert.equal(
        probe('unit.real-drift', () => null),
        null,
      );
    });
    assert.equal(first.lines.length, 1, '真漂移必须可观测');
    assert.match(first.lines[0], /symbol drift/);
    const second = captureWarn(() => {
      assert.equal(
        probe('unit.real-drift', () => null),
        null,
      );
    });
    assert.deepEqual(second.lines, [], '同一探测键只警报一次');
  } finally {
    game.ready = origReady;
  }
});
