// 服务器周界换算：每日 0 点与周一 0 点必须共用游戏本地时区偏移（UTC+8）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '', reload() {} },
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

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const { gameData } = await import('../../../extension/src/core/game-api.js');
const origServerTime = gameData.serverTime;

// 2026-11-16 00:00:00（UTC+8）为周一；2026-11-23 为其下一周界。
const MONDAY = 1794758400;
const NEXT_MONDAY = MONDAY + 7 * 86400;

test('周界：周一 00:00 当拍仍指向下一周一，00:00:01 同样指向下一周一', () => {
  assert.equal(gameData.nextWeeklyResetTs(MONDAY), NEXT_MONDAY);
  assert.equal(gameData.nextWeeklyResetTs(MONDAY + 1), NEXT_MONDAY);
});

test('周界：周日 23:59:59 指向次日上午的服务器周一零点', () => {
  assert.equal(gameData.nextWeeklyResetTs(NEXT_MONDAY - 1), NEXT_MONDAY);
});

test('周界：周一至周日各天均指向同一个下一周一', () => {
  for (let day = 0; day < 7; day++) {
    const at = MONDAY + day * 86400 + 12 * 3600;
    assert.equal(gameData.nextWeeklyResetTs(at), NEXT_MONDAY, `day=${day}`);
  }
});

test('周界：跨周边界后自动前移一周', () => {
  assert.equal(gameData.nextWeeklyResetTs(NEXT_MONDAY), NEXT_MONDAY + 7 * 86400);
  assert.equal(gameData.nextWeeklyResetTs(NEXT_MONDAY + 60), NEXT_MONDAY + 7 * 86400);
});

test('周界：不可用时钟返回 0，缺省参数读取实时服务器时间', () => {
  assert.equal(gameData.nextWeeklyResetTs(0), 0);
  gameData.serverTime = () => MONDAY + 3600;
  try {
    assert.equal(gameData.nextWeeklyResetTs(), NEXT_MONDAY);
  } finally {
    gameData.serverTime = origServerTime;
  }
});
