// 发布通道（channel）隔离单测：dev / snapshot / release 三套构建能同时装在一个浏览器里
// （manifest.key 不同 ⇒ 扩展 ID 不同），但只要它们往同一个游戏页注入，就可能串台。
// 串台的三条通路都在「按实例命名」的符号上：postMessage 的 __ns、chrome.storage 键前缀、升级缓存字面键。
// 因此这里守住两件事：
//   1. 正式通道一字不变（后缀为空）——否则存量用户与朋友手上的数据当场蒸发；
//   2. 非正式通道的三处命名全部由同一个 CHAN_SUFFIX 派生——漏一处就留下一条跨通道互踩的通路。
// update.js / player.js 的判据用源码文本断言：它们只在浏览器环境有意义，且嵌套 import 无法按通道各起一份实例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 本文件刻意不设 __PCC_CHANNEL__：constants.js 的 typeof 兜底即「与正式构建同态」（空后缀）。
const C = await import('../../extension/src/core/constants.js');
const U = await import('../../extension/src/core/update.js');

/**
 * 读扩展源码（文本断言用）
 * @param {string} rel 相对 extension/src 的路径
 * @returns {string} 文件文本
 */
function src(rel) {
  return readFileSync(new URL(`../../extension/src/${rel}`, import.meta.url), 'utf8');
}

test('正式通道保持空后缀：NS / 存储前缀 / 升级三键一字不变', () => {
  assert.equal(C.CHANNEL_NAME, 'release');
  assert.equal(C.CHAN_SUFFIX, '');
  assert.equal(C.NS, 'pocketcc');
  assert.equal(C.STORAGE_ROOT, 'pocketcc');
  assert.deepEqual(
    [U.CACHE_KEY, U.STATE_KEY, U.PREF_KEY],
    ['pccupd:bundle', 'pccupd:state', 'pccupd:pref'],
    '升级三键改名等于让存量机器把已下载的包当没有',
  );
});

test('非正式通道各起一份实例：后缀即通道名，三通道两两可辨', async () => {
  /** @type {Object<string,string>} 通道 -> 期望后缀（正式为空后缀已在上一例守住） */
  const want = { dev: '.dev', snapshot: '.snapshot' };
  /** @type {Object<string, typeof C>} constants.js 无自身依赖，加 query 即真正独立的实例 */
  const inst = { release: C };
  for (const chan of Object.keys(want)) {
    globalThis.__PCC_CHANNEL__ = chan;
    inst[chan] = await import(`../../extension/src/core/constants.js?chan=${chan}`);
    delete globalThis.__PCC_CHANNEL__;
  }
  for (const [chan, suf] of Object.entries(want)) {
    assert.equal(inst[chan].CHAN_SUFFIX, suf, `${chan} 后缀形态`);
    assert.equal(inst[chan].NS, `pocketcc${suf}`, `${chan} 协议命名空间`);
    assert.equal(inst[chan].STORAGE_ROOT, `pocketcc${suf}`, `${chan} 存储前缀根段`);
  }
  // 两两不同是硬要求：同值即两个 bridge 互认对方的 postMessage，等于同一个账号跑了两套自动化
  for (const k of ['NS', 'STORAGE_ROOT']) {
    const vals = ['release', 'snapshot', 'dev'].map((c) => inst[c][k]);
    assert.equal(new Set(vals).size, 3, `${k} 三通道必须互不相同：${vals.join(' / ')}`);
  }
});

test('三处实例命名一律由同一后缀派生，源码里不留硬编码字面量', () => {
  const upd = src('core/update.js');
  assert.ok(
    /import \{[^}]*\bCHAN_SUFFIX\b[^}]*\} from '\.\/constants\.js'/.test(upd),
    'update.js 未从 constants 取后缀',
  );
  // 发布身份的分叉同样必须由通道常量派生：任何一处自己比字面量、或把通道名写进版本号，都是一条新串台通路
  assert.ok(
    /\bCHANNEL_NAME !== 'release'/.test(upd),
    "update.js 的发布身份分叉未挂 CHANNEL_NAME（应唯一由 `CHANNEL_NAME !== 'release'` 得出）",
  );
  for (const key of ['bundle', 'state', 'pref']) {
    assert.ok(
      upd.includes('`pccupd${CHAN_SUFFIX}:' + key + '`'),
      `update.js 的 ${key} 键未经 CHAN_SUFFIX 派生，跨通道会读到对方的缓存`,
    );
    // 反证：裸键一旦回潮，说明有人绕过 constants 另起了一套字面量
    assert.ok(!upd.includes(`'pccupd:${key}'`), `update.js 残留裸键 'pccupd:${key}'`);
  }

  const player = src('core/player.js');
  assert.ok(
    player.includes('setNamespace(`${STORAGE_ROOT}.u${uid}.`)'),
    'player.js 存储命名空间未挂 STORAGE_ROOT，dev 会写进正式包的前缀',
  );
  assert.ok(!/'pocketcc\.u/.test(player), 'player.js 残留硬编码 pocketcc.u 前缀');

  // 握手名只认 NS 常量：bridge 与 shell 各引一次，任何一侧写死字面量都会当场断链
  assert.ok(
    src('bridge.js').includes("import { NS } from './core/constants.js'"),
    'bridge.js 未引 NS',
  );
  assert.ok(src('shell.js').includes('NS'), 'shell.js 未引 NS');
});
