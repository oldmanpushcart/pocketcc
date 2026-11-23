// 快照通道的展示层单测：这条通道的版本号刻意钉死，「是哪一份正文」只能由摘要回答，
// 因此用户明确要求两处可见——欢迎页脚、系统 tab 的软件更新区。判据分叉在 core/update.js 的 identityOf，
// 本文件只验它落到界面上的那串字，正式通道的同批断言在 update-display.test.js（那里必须一个摘要都不出现）。
// 通道靠构建期 define 承载：本文件在任何 import 之前把 __PCC_CHANNEL__ 设为 snapshot，
// 于是 panel.js → update.js → constants.js 整条链都是同一次解析的快照态实例。
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';

globalThis.__PCC_CHANNEL__ = 'snapshot';
globalThis.__PCC_VERSION__ = '1.0.0';

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

const { buildUpdateBanner, buildUpdateSys, updateBannerView } =
  await import('../../../extension/src/core/ui/panel.js');
const { welcomeCardHTML } = await import('../../../extension/src/core/ui/welcome.js');

/** @type {string} 正在运行那份正文的摘要（包内基线） */
const RUN_SHA = '03b3905465cc522a000000000000000000000000000000000000000000000000';
/** @type {string} 本地就绪那份正文的摘要（刚下载的同号新正文） */
const READY_SHA = 'aa11bb2233445566000000000000000000000000000000000000000000000000';
/** @type {number} 固定检查时刻 */
const TS = Date.UTC(2026, 10, 23, 9, 30);

/**
 * 合成快照通道后台快照：版本号全程钉死 1.0.0，靠摘要区分两份正文
 * @param {object} [over] 需覆盖的字段
 * @returns {object}
 */
function snap(over) {
  return Object.assign(
    {
      state: 'ready',
      reason: 'newer',
      runningVer: '1.0.0',
      runningFrom: 'baseline',
      runningSha: RUN_SHA,
      readyVer: '1.0.0',
      readySha: READY_SHA,
      pendingId: '1.0.0@aa11bb22',
      checkedAt: TS,
      failCount: 0,
      lastErr: '',
      notes: '',
      shellVer: '1.0.0',
      autoCheck: true,
      locked: false,
      dismissedId: '',
      blockedId: '',
      fuseTripped: false,
      revoked: false,
    },
    over || {},
  );
}

test('系统 tab 三处版本读数都挂摘要：正在运行 / 本地已就绪 / 待生效', () => {
  const src = { ver: '1.0.0', from: 'baseline', degraded: false, shellVer: '1.0.0' };
  const html = buildUpdateSys(snap(), src);
  assert.ok(html.includes('v1.0.0@03b39054（包内基线）'), html);
  assert.ok(html.includes('v1.0.0@aa11bb22</span>'), '本地已就绪那行是纯身份串');
  assert.ok(html.includes('v1.0.0@aa11bb22（刷新即生效）'), html);
  // 排查面留全串前 12 位：与清单里的 sha256、正文文件名里那段同源
  assert.ok(html.includes('就绪包摘要'), html);
  assert.ok(html.includes('aa11bb223344'), html);
});

test('系统 tab 同号而摘要未取到时不编造：版本号孤零零也要说得出口', () => {
  const html = buildUpdateSys(snap({ runningSha: '', readySha: '', pendingId: '' }), {
    ver: '1.0.0',
    from: 'cache',
    degraded: false,
    shellVer: '1.0.0',
  });
  assert.ok(html.includes('v1.0.0（已下载的新版）'), html);
  assert.ok(!html.includes('@'), '没有摘要就不该出现身份分隔符');
});

test('横幅与「稍后」都说得出是哪一份：同号两份正文不能只写 1.0.0', () => {
  const v = updateBannerView(snap());
  assert.equal(v.tone, 'ready');
  assert.equal(v.text, '新版 v1.0.0@aa11bb22 已下载完成，刷新页面即生效');
  assert.equal(v.dismissId, '1.0.0@aa11bb22', '稍后记掉的必须是这一份，而不是整个 1.0.0');
  assert.ok(
    buildUpdateBanner(snap()).includes('新版 v1.0.0@aa11bb22 已下载完成'),
    buildUpdateBanner(snap()),
  );
});

test('欢迎页脚带摘要与通道名：玩家念一句就能定位到哪一份正文', () => {
  const plain = welcomeCardHTML(snap({ pendingId: '' }));
  assert.match(plain, /<div class="pcw-foot">pocketcc v1\.0\.0@03b39054 · snapshot<\/div>/);
  // 有待生效那份时那句并列，不吞掉版本号里的摘要
  const withNote = welcomeCardHTML(snap());
  assert.match(
    withNote,
    /pocketcc v1\.0\.0@03b39054 · snapshot · 新版 v1\.0\.0@aa11bb22 已就绪，刷新页面即生效/,
  );
});
