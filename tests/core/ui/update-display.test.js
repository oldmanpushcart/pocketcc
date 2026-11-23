// 升级通道的展示层纯判据与纯渲染（零 DOM 库：先最小桩化 window/document/chrome 再动态 import，同 field-types.test.js 范式）。
// 覆盖：updateBannerView 的三类互斥提示与按钮可得性、buildUpdateBanner 的空态与「无按钮就不摆空容器」、
//   buildUpdateSys 的空快照兜底、fmtCheckedAt 的「从未」/绝对时间口径、welcomeCardHTML 页脚那句的有无。
// 边界：ui-snapshot 夹具锁「逐字 HTML」，本文件锁「为什么这么说」的判据分支；真实状态来源是后台快照，此处一律喂合成快照。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 展示层含绝对时间格式化，锁 UTC 使断言不随机器时区漂移
process.env.TZ = 'UTC';

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

const { buildUpdateBanner, buildUpdateSys, fmtCheckedAt, updateBannerView } =
  await import('../../../extension/src/core/ui/panel.js');
const { welcomeCardHTML } = await import('../../../extension/src/core/ui/welcome.js');

/** @type {number} 固定检查时刻（2026-04-18 09:30 UTC） */
const TS = Date.UTC(2026, 3, 18, 9, 30);

/**
 * 合成「新版已下载待刷新」快照（后台 snapshot() 的完整形状）
 * 本文件跑在未注入 __PCC_CHANNEL__ 的同态（=正式通道），故身份串就是版本号；
 * runningSha/readySha 照样喂进来，验的是「正式通道不拿它们添字」这一半。
 * @param {object} [over] 需覆盖的字段
 * @returns {object}
 */
function snap(over) {
  return Object.assign(
    {
      state: 'ready',
      reason: 'newer',
      runningVer: '1.3.0',
      runningFrom: 'baseline',
      runningSha: '11aa22bb33cc44dd55ee66ff77aa88bb99cc00dd11ee22ff33aa44bb55cc66dd',
      readyVer: '1.4.0',
      readySha: '9f2c1b7ad4e80635f1cc07e2b83a4d6e5f70a9c1b2d3e4f506172839a0b1c2d3',
      pendingId: '1.4.0',
      checkedAt: TS,
      failCount: 0,
      lastErr: '',
      notes: '',
      shellVer: '1.3.0',
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

test('横幅判据：就绪态给绿条 + 可刷新，且「稍后」知道要记掉哪份发布身份', () => {
  const v = updateBannerView(snap());
  assert.equal(v.tone, 'ready');
  assert.equal(v.canReload, true);
  assert.equal(v.dismissId, '1.4.0');
  assert.match(v.text, /^新版 v1\.4\.0 已下载完成，刷新页面即生效$/);
});

test('横幅判据：锁定与「稍后」过同一身份都不该再开口（正交开关位不参与状态机）', () => {
  assert.equal(updateBannerView(snap({ locked: true })), null);
  assert.equal(updateBannerView(snap({ dismissedId: '1.4.0' })), null);
  // 只「稍后」过旧身份不影响对新版的提示
  assert.notEqual(updateBannerView(snap({ dismissedId: '1.3.9', pendingId: '1.4.1' })), null);
});

test('横幅判据：已停止支持优先于一切，且不给「立即刷新」（刷新无用，必须换壳）', () => {
  const v = updateBannerView(snap({ revoked: true, reason: 'shell-outdated', state: 'failed' }));
  assert.equal(v.tone, 'warn');
  assert.equal(v.canReload, false);
  assert.match(v.text, /此版本已停止支持，请重新加载扩展/);
});

test('横幅判据：验签未过是被篡改的唯一信号，必须可见但仍不许刷新', () => {
  for (const reason of ['sha-mismatch', 'hmac-mismatch', 'no-tag']) {
    const v = updateBannerView(snap({ state: 'failed', reason }));
    assert.equal(v.tone, 'warn', reason);
    assert.equal(v.canReload, false, reason);
    assert.match(v.text, /更新包校验未通过，仍在使用 v1\.3\.0/, reason);
  }
});

test('横幅判据：壳降级跑基线那句在快照缺失时也必须能说出来', () => {
  const note = '；本次已回退到本地版本 v1.3.0';
  const v = updateBannerView(null, { note });
  assert.equal(v.tone, 'warn');
  assert.equal(v.text, '本次已回退到本地版本 v1.3.0', '前导分隔符不该留在句首');
  assert.equal(updateBannerView(null), null);
  // 就绪态同时带降级口径时两句并列，不互相吞掉
  assert.match(updateBannerView(snap(), { note }).text, /刷新页面即生效；本次已回退到本地版本/);
});

test('横幅渲染：无事可说不留空块，无按钮不摆空的acts 容器', () => {
  assert.equal(buildUpdateBanner(snap({ locked: true })), '');
  assert.equal(buildUpdateBanner(null), '');
  const revoked = buildUpdateBanner(snap({ revoked: true, pendingId: '' }));
  assert.ok(!revoked.includes('pc-upd-acts'), revoked);
  assert.ok(revoked.includes('role="alert"'), revoked);
  const ready = buildUpdateBanner(snap());
  assert.ok(ready.includes('role="status"'), ready);
  for (const cls of ['pc-upd-go', 'pc-upd-later', 'pc-upd-lock']) {
    assert.ok(ready.includes(cls), ready);
  }
});

test('系统 tab 升级区：快照与来源都缺失时照常摆事实，不抛也不留空', () => {
  const html = buildUpdateSys();
  assert.match(html, /软件更新/);
  assert.match(html, /data-upd-body="1"/, '重绘要锚这块壳内的 body');
  assert.match(html, /从未/, '没检查过就明说从未');
  assert.match(html, /未就绪/);
  assert.ok(html.includes('id="pc-upd-check"') && html.includes('id="pc-upd-clear"'));
  assert.ok(html.includes('pc-upd-auto" checked'), '自动检查默认开');
  assert.match(buildUpdateSys(snap({ autoCheck: false })), /pc-upd-auto"/);
});

test('系统 tab 升级区：来源口径中文化，熔断暂停与失败原因都要摆出来', () => {
  const src = { ver: '1.4.0', from: 'cache', degraded: false, shellVer: '1.3.0' };
  const ok = buildUpdateSys(snap(), src);
  assert.ok(ok.includes('v1.4.0（已下载的新版）'), ok);
  assert.ok(ok.includes('9f2c1b7ad4e8'), 'sha 只展示前 12 位');
  assert.ok(!ok.includes('9f2c1b7ad4e80635'), '不铺满整串摘要');
  assert.ok(ok.includes('2026-04-18 09:30'), '检查时刻到分钟');
  const fused = buildUpdateSys(
    snap({
      readyVer: '1.3.0',
      pendingId: '',
      fuseTripped: true,
      lastErr: 'latest.json 请求超时（1500ms）',
    }),
    src,
  );
  assert.ok(fused.includes('连续失败已暂停'), fused);
  assert.ok(fused.includes('请求超时'), fused);
  assert.match(fused, /待生效<\/span><span class="pc-uv"[^>]*>无</);
});

test('fmtCheckedAt：0/非法值一律「从未」，有效值走绝对时间到分钟', () => {
  assert.equal(fmtCheckedAt(0), '从未');
  assert.equal(fmtCheckedAt(undefined), '从未');
  assert.equal(fmtCheckedAt('abc'), '从未');
  assert.equal(fmtCheckedAt(TS), '2026-04-18 09:30');
});

test('欢迎页脚：只有真有新版待生效才追加那句，其余情况整段干净', () => {
  const plain = welcomeCardHTML(null);
  assert.match(
    plain,
    /<div class="pcw-sign">由<span class="pcw-name">「万恶秃为首」<\/span>的<span class="pcw-author">晚风<\/span>开发并免费分享<\/div>/,
  );
  assert.ok(!/·\s*新版/.test(plain), plain);
  assert.ok(plain.includes('由<span'), '署名行是视觉重点');
  assert.ok(!plain.includes('赠予'), '不再有按人赠予的口径');
  const withNote = welcomeCardHTML(snap());
  assert.match(withNote, /pocketcc v[\w.]+ · 新版 v1\.4\.0 已就绪，刷新页面即生效<\/div>/);
  // 锁定态不该在页脚继续催刷新
  assert.ok(!welcomeCardHTML(snap({ locked: true })).includes('已就绪'), '锁定即不再提示');
});
