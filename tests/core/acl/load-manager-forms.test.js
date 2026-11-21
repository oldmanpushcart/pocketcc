// LoadManager 导出信封多形态兜底契约（实证事故：extracted 源尾部是具名导出 `a.LoadManager=类`、
// 文件内无 a.default —— ns() 对它不解包回壳，壳上无 loadSpriteFrame，probe 误报「symbol drift」）。
// 纪律：游戏 bundle 模块信封三形态（命名空间顶层挂静态 / ES .default 类 / 具名导出类）都实测存在过，
// getter 必须逐形态兜底。用 globalThis.__require 现挂桩（game.isReady 调用点读全局，随设随生效）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadManager, reprobe } from '../../../extension/src/core/acl-engine.js';

/**
 * 在 __require 桩下清缓存重探一次 loadManager。
 * @param {object} env 信封对象
 * @returns {*|null} probe 解析结果
 */
function withEnvelope(env) {
  reprobe('LoadManager');
  globalThis.__require = () => env;
  try {
    return loadManager();
  } finally {
    delete globalThis.__require;
    reprobe('LoadManager');
  }
}

test('loadManager：具名导出 a.LoadManager（无 .default）解析到类本身，不误报漂移', () => {
  const LM = { loadSpriteFrame() {} };
  assert.equal(withEnvelope({ __esModule: true, LoadManager: LM }), LM);
});

test('loadManager：ES .default 类形态照常解包命中', () => {
  const LM = { loadSpriteFrame() {} };
  assert.equal(withEnvelope({ __esModule: true, default: LM }), LM);
});

test('loadManager：命名空间顶层直接挂静态方法的形态命中', () => {
  const LM = { __esModule: true, loadSpriteFrame() {} };
  assert.equal(withEnvelope(LM), LM);
});

test('loadManager：信封在场但方法漂移（真改版）时回 null，交 probe 警报口径', () => {
  assert.equal(withEnvelope({ __esModule: true, LoadManager: {/* 方法名漂走 */} }), null);
});
