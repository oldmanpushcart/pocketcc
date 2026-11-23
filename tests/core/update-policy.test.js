// 升级判据离线单测（core/update.js）：版本比较、清单解析、地址拼接、就绪来源选择、下载决策、熔断与提示口径。
// update.js 顶层把构建期 define 读成模块常量，故须先备好全局桩再动态 import（与仓内 core 测试同款写法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__PCC_VERSION__ = '1.4.0';
globalThis.__OSS_BASE__ = 'https://pcc.example.test/ext/';
globalThis.__UPDATE_KEY__ = 'k-test';

const U = await import('../../extension/src/core/update.js');

/**
 * 造一份最小可用清单
 * @param {object} over 覆盖字段
 * @returns {ReturnType<U.parseLatest>}
 */
function manifest(over = {}) {
  return U.parseLatest({
    latest: '1.5.0',
    file: 'pocketcc-remote-1.5.0.js',
    sha256: 'aa',
    hmac: 'bb',
    ...over,
  });
}

test('revision 取构建期版本常量', () => {
  assert.equal(U.revision(), '1.4.0');
  assert.equal(U.configured(), true);
  assert.equal(U.ossBase(), 'https://pcc.example.test/ext/');
});

test('cmpVer：逐段比数值，缺段与非法段按 0 处理', () => {
  assert.equal(U.cmpVer('1.5.0', '1.4.9'), 1);
  assert.equal(U.cmpVer('1.4', '1.4.0'), 0);
  assert.equal(U.cmpVer('1.4.0', '1.10.0'), -1);
  assert.equal(U.cmpVer('2', '1.9.9'), 1);
  assert.equal(U.cmpVer('', '0.0.1'), -1);
  assert.equal(U.cmpVer('1.x.3', '1.0.9'), -1); // 非法段视 0 → 1.0.3 < 1.0.9
});

test('parseLatest：字符串与对象都吃，缺 latest/file 即判不可用', () => {
  const fromText = U.parseLatest('{"latest":"1.5.0","file":"a.js","sha256":"AA"}');
  assert.equal(fromText.latest, '1.5.0');
  assert.equal(fromText.sha256, 'aa'); // 摘要统一小写口径
  assert.equal(fromText.min, ''); // 未给字段归零，不抛
  assert.deepEqual(fromText.versions, []);

  assert.equal(U.parseLatest('not json'), null);
  assert.equal(U.parseLatest('{"latest":"1.5.0"}'), null); // 缺 file 无从下载
  assert.equal(U.parseLatest(null), null);
  assert.equal(U.parseLatest(42), null);

  const withVersions = U.parseLatest({
    latest: '1.5.0',
    file: 'a.js',
    versions: ['1.4.0', { ver: '1.3.0', file: 'c.js' }, {}, null],
  });
  assert.deepEqual(
    withVersions.versions.map((v) => v.ver),
    ['1.4.0', '1.3.0'],
  );
});

test('assertUrl：只认相对路径，协议头/绝对路径/上跳一律拒绝', () => {
  assert.equal(
    U.assertUrl('pocketcc-remote-1.5.0.js'),
    'https://pcc.example.test/ext/pocketcc-remote-1.5.0.js',
  );
  assert.equal(U.assertUrl('sub/a.js'), 'https://pcc.example.test/ext/sub/a.js');
  // 基址无结尾斜杠也要拼对
  assert.equal(U.assertUrl('a.js', 'https://x.test/ext'), 'https://x.test/ext/a.js');

  for (const bad of [
    'https://evil.test/a.js',
    'http://evil.test/a.js',
    'data:text/javascript,1',
    '//evil.test/a.js',
    '/etc/passwd',
    '../latest.json',
    'a/../../b.js',
    'a.js?token=1',
    'a.js#x',
    'a\\b.js',
    '',
    null,
    undefined,
  ]) {
    assert.equal(U.assertUrl(bad), '', `应拒绝: ${String(bad)}`);
  }
  // 左右空白按 trim 宽容（控制台手滑），名字里的空白与控制字符仍拒（拼出去必 404 或越界）
  assert.equal(U.assertUrl(' a.js '), 'https://pcc.example.test/ext/a.js');
  assert.equal(U.assertUrl('a b.js'), '');
  assert.equal(U.assertUrl('a\nb.js'), '');
  // 基址未配置（dev 包）时任何 file 都拼不出地址
  assert.equal(U.assertUrl('a.js', ''), '');
});

test('chooseReady：缓存与基线取版本高者，都为空回 none', () => {
  const cache = { ver: '1.5.0', text: 'C' };
  const base = { ver: '1.4.0', text: 'B' };
  assert.deepEqual(U.chooseReady({ cached: cache, baseline: base }), {
    from: 'cache',
    ver: '1.5.0',
    text: 'C',
  });
  // 缓存比基线旧（回滚 / 清单降级）：启动仍跑包内基线，不能拿旧包覆盖新基线
  assert.deepEqual(U.chooseReady({ cached: { ver: '1.3.0', text: 'C' }, baseline: base }), {
    from: 'baseline',
    ver: '1.4.0',
    text: 'B',
  });
  assert.deepEqual(U.chooseReady({ baseline: base }), {
    from: 'baseline',
    ver: '1.4.0',
    text: 'B',
  });
  assert.deepEqual(U.chooseReady({}), { from: 'none', ver: '', text: '' });
  // text 为空的记录视作不存在（落盘损坏/半截缓存不得被执行）
  assert.deepEqual(U.chooseReady({ cached: { ver: '9.9.9', text: '' } }), {
    from: 'none',
    ver: '',
    text: '',
  });
});

test('pickBundle：有更高版本才下载，已最新/锁定/无清单都保持不动', () => {
  const latest = manifest();
  assert.deepEqual(U.pickBundle({ readyVer: '1.4.0', latest, shellVer: '1.0.0' }), {
    action: 'download',
    ver: '1.5.0',
    file: 'pocketcc-remote-1.5.0.js',
    reason: 'newer',
  });
  assert.equal(U.pickBundle({ readyVer: '1.5.0', latest, shellVer: '1.0.0' }).action, 'stay');
  assert.equal(U.pickBundle({ readyVer: '1.5.0', latest, shellVer: '1.0.0' }).reason, 'uptodate');
  assert.equal(U.pickBundle({ readyVer: '1.6.0', latest, shellVer: '1.0.0' }).reason, 'uptodate');
  assert.equal(U.pickBundle({ readyVer: '1.4.0', latest: null }).reason, 'no-manifest');
  // 用户锁定版本：清单再新也不动
  assert.equal(
    U.pickBundle({ readyVer: '1.4.0', latest, shellVer: '1.0.0', locked: true }).reason,
    'locked',
  );
});

test('pickBundle：shellMin 命中即判「必须换壳」，刷新无用故不给下载地址', () => {
  const latest = manifest({ shellMin: '2.0.0' });
  assert.deepEqual(U.pickBundle({ readyVer: '1.4.0', latest, shellVer: '1.9.0' }), {
    action: 'block-shell',
    ver: '2.0.0',
    file: '',
    reason: 'shell-outdated',
  });
  // 壳版本达标后闸门放开
  assert.equal(U.pickBundle({ readyVer: '1.4.0', latest, shellVer: '2.0.0' }).action, 'download');
});

test('pickBundle：min 闸门——目标须够格且带地址，否则判为不支持', () => {
  // latest 高于 min：直接取 latest
  const ok = manifest({
    min: '1.4.0',
    versions: [{ ver: '1.4.2', file: 'pocketcc-remote-1.4.2.js' }],
  });
  assert.deepEqual(U.pickBundle({ readyVer: '1.3.0', latest: ok, shellVer: '1.0.0' }), {
    action: 'download',
    ver: '1.5.0',
    file: 'pocketcc-remote-1.5.0.js',
    reason: 'newer',
  });

  // latest 字段被写成低于 min 的旧版（清单自相矛盾）：从 versions 里挑够格的最高者
  const stale = manifest({
    latest: '1.1.0',
    min: '1.2.0',
    versions: [{ ver: '1.3.1', file: 'pocketcc-remote-1.3.1.js' }],
  });
  assert.deepEqual(U.pickBundle({ readyVer: '1.0.0', latest: stale, shellVer: '1.0.0' }), {
    action: 'download',
    ver: '1.3.1',
    file: 'pocketcc-remote-1.3.1.js',
    reason: 'newer',
  });

  // 够格版本只作索引（未带 file）：无地址不得下旧包正文，判为通道对该用户失效
  const noAddr = manifest({ latest: '1.1.0', min: '1.2.0', versions: [{ ver: '1.3.1' }] });
  assert.deepEqual(U.pickBundle({ readyVer: '1.0.0', latest: noAddr, shellVer: '1.0.0' }), {
    action: 'block-unsupported',
    ver: '',
    file: '',
    reason: 'below-min',
  });

  // 没有任何够格版本：同样不下发
  const dead = manifest({ latest: '1.1.0', min: '1.2.0' });
  assert.deepEqual(U.pickBundle({ readyVer: '1.0.0', latest: dead, shellVer: '1.0.0' }), {
    action: 'block-unsupported',
    ver: '',
    file: '',
    reason: 'below-min',
  });
});

test('pickBundle：通道未配置时短路保持不动（dev 包零出网）', () => {
  // configured() 由构建期常量决定，此处以「清单不可用」同路径校验 stay 语义完整
  const r = U.pickBundle({ readyVer: '1.4.0', latest: U.parseLatest('{"latest":"","file":""}') });
  assert.equal(r.action, 'stay');
});

test('fuseState/bumpFuse：成功清零，连续三次失败熔断', () => {
  assert.deepEqual(U.fuseState(0), { fails: 0, tripped: false });
  assert.deepEqual(U.fuseState(2), { fails: 2, tripped: false });
  assert.deepEqual(U.fuseState(3), { fails: 3, tripped: true });
  assert.equal(U.fuseState(null).fails, 0);
  assert.equal(U.fuseState(-7).fails, 0);
  assert.equal(U.bumpFuse(1, false), 2);
  assert.equal(U.bumpFuse(2, true), 0);
  assert.equal(U.bumpFuse(undefined, false), 1);
});

test('pickBundle：被隔离身份不重复下发（刷新即崩循环的护栏）', () => {
  const latest = manifest();
  assert.deepEqual(
    U.pickBundle({ readyVer: '1.4.0', latest, shellVer: '1.0.0', blockedId: '1.5.0' }),
    { action: 'stay', ver: '1.4.0', file: '', reason: 'quarantined' },
  );
  // 只隔离那一份：清单换上更高版本仍然放行
  assert.equal(
    U.pickBundle({
      readyVer: '1.4.0',
      latest: manifest({ latest: '1.6.0', file: 'b.js' }),
      blockedId: '1.5.0',
    }).action,
    'download',
  );
});

test('latestUrl：基址取自壳内常量，只加防缓存查询串', () => {
  assert.equal(
    U.latestUrl(1700000000000),
    'https://pcc.example.test/ext/latest.json?_t=1700000000000',
  );
  assert.equal(U.latestUrl('a', 'https://x.test/ext'), 'https://x.test/ext/latest.json?_t=a');
  // 基址未配置（dev 包）拼不出地址
  assert.equal(U.latestUrl(1, ''), '');
});

test('shouldCheck：手动放行，定时轮受自动开关与最小间隔约束', () => {
  const now = 1_000_000_000_000;
  assert.equal(U.shouldCheck({ now, force: true }), true);
  assert.equal(U.shouldCheck({ now, force: true, autoCheck: false }), true); // 关了自动也不妨碍手动
  assert.equal(U.shouldCheck({ now, autoCheck: false }), false);
  assert.equal(U.shouldCheck({ now, minIntervalMs: 60000 }), true); // 从没检过
  assert.equal(U.shouldCheck({ now, lastCheckedAt: now - 61000, minIntervalMs: 60000 }), true);
  assert.equal(U.shouldCheck({ now, lastCheckedAt: now - 30000, minIntervalMs: 60000 }), false);
  // 上次检查在未来（改过系统时钟）不能卡死通道
  assert.equal(U.shouldCheck({ now, lastCheckedAt: now + 999999, minIntervalMs: 60000 }), true);
});

test('tagsFor：latest 用顶层标签，versions 条目用自己的，查不到则空', () => {
  const latest = manifest({
    versions: [{ ver: '1.4.2', file: 'v.js', sha256: 'CC', hmac: 'DD' }],
  });
  assert.deepEqual(U.tagsFor(latest, '1.5.0'), { sha256: 'aa', hmac: 'bb' });
  assert.deepEqual(U.tagsFor(latest, '1.4.2'), { sha256: 'cc', hmac: 'dd' }); // 小写口径
  assert.deepEqual(U.tagsFor(latest, '1.0.0'), { sha256: '', hmac: '' });
  assert.deepEqual(U.tagsFor(null, '1.5.0'), { sha256: '', hmac: '' });
  // 带 file 时按名字精确定位（快照通道同号多份靠这一维分开）：先命中顶层，再命中条目
  assert.deepEqual(U.tagsFor(latest, 'whatever', 'pocketcc-remote-1.5.0.js'), {
    sha256: 'aa',
    hmac: 'bb',
  });
  assert.deepEqual(U.tagsFor(latest, 'whatever', 'v.js'), { sha256: 'cc', hmac: 'dd' });
  // file 对不上时回落到按版本，旧调用方式行为不变
  assert.deepEqual(U.tagsFor(latest, '1.4.2', 'nope.js'), { sha256: 'cc', hmac: 'dd' });
});

test('mergeVersions：同版本以新为准、降序排列、只留最近几条', () => {
  const prev = [
    { ver: '1.3.0', file: 'a.js', sha256: 'A' },
    { ver: '1.2.0', file: 'b.js' },
  ];
  const added = [
    { ver: '1.4.0', file: 'c.js', notes: '新' },
    { ver: '1.3.0', file: 'a.js', sha256: 'AA' },
  ];
  const merged = U.mergeVersions(prev, added, 3);
  assert.deepEqual(
    merged.map((v) => v.ver),
    ['1.4.0', '1.3.0', '1.2.0'],
  );
  assert.equal(merged[1].sha256, 'aa'); // added 里的同版本覆盖 prev
  assert.equal(merged[0].file, 'c.js');
  assert.deepEqual(U.mergeVersions(null, undefined, 5), []);
  assert.deepEqual(U.mergeVersions(prev, added, 0), []);
  // keep 只留前 N 条（旧 js 不删，仅供回滚索引）
  assert.equal(U.mergeVersions(prev, added, 1).length, 1);
});

test('makeLatest ↔ parseLatest：发布侧产物被客户端原样读回（清单字段名单一真相）', () => {
  const built = U.makeLatest({
    latest: '1.5.0',
    file: 'pocketcc-remote-1.5.0.js',
    sha256: 'DEADBEEF',
    hmac: 'CAFEBABE',
    size: 1234,
    notes: '修了个坑',
    min: '1.2.0',
    shellMin: '1.3.0',
    prev: {
      versions: [{ ver: '1.4.0', file: 'pocketcc-remote-1.4.0.js', sha256: 'old', hmac: 'oldmac' }],
    },
    added: [
      {
        ver: '1.5.0',
        file: 'pocketcc-remote-1.5.0.js',
        notes: '修了个坑',
        sha256: 'DEADBEEF',
        hmac: 'CAFEBABE',
      },
    ],
    publishedAt: '2026-04-18T09:30:00.000Z',
  });
  const back = U.parseLatest(JSON.stringify(built));
  assert.ok(back, '发布侧产物必须能被客户端解析');
  assert.equal(back.latest, '1.5.0');
  assert.equal(back.file, 'pocketcc-remote-1.5.0.js');
  assert.equal(back.sha256, 'deadbeef'); // 摘要归小写，与构建侧同口径
  assert.equal(back.hmac, 'cafebabe');
  assert.equal(back.size, 1234);
  assert.equal(back.notes, '修了个坑');
  assert.equal(back.min, '1.2.0');
  assert.equal(back.shellMin, '1.3.0');
  assert.deepEqual(
    back.versions.map((v) => v.ver),
    ['1.5.0', '1.4.0'],
  );
  // 客户端拿这份清单要能真跑出「下 1.5.0」的决策，并取到完整性标记与可拼地址
  assert.deepEqual(U.tagsFor(back, '1.5.0'), { sha256: 'deadbeef', hmac: 'cafebabe' });
  const d = U.pickBundle({ readyVer: '1.4.0', latest: back, shellVer: '1.4.0' });
  assert.equal(d.action, 'download');
  assert.equal(
    U.assertUrl(d.file, 'https://pcc.example.test/ext/'),
    'https://pcc.example.test/ext/pocketcc-remote-1.5.0.js',
  );
  // publishedAt 只给人看：客户端不认它，也就不拿发布时刻做任何判据
  assert.equal('publishedAt' in back, false);
  // 空参产物依旧不合法（缺 latest/file 即无从下载），避免发布脚本静默出一份废清单
  assert.equal(U.parseLatest(U.makeLatest({})), null);
});

test('isRevoked：只把「清单已停止支持」类原因算作废，网络失败不算', () => {
  assert.equal(U.isRevoked('shell-outdated'), true);
  assert.equal(U.isRevoked('below-min'), true);
  assert.equal(U.isRevoked('no-target'), true);
  assert.equal(U.isRevoked('timeout'), false);
  assert.equal(U.isRevoked('sha-mismatch'), false);
  assert.equal(U.isRevoked(''), false);
});

test('shouldPromptUpdate/pendingNote：只在确有另一份发布物待刷新时开口', () => {
  const ctx = { state: U.STATE.READY, pendingId: '1.5.0' };
  assert.equal(U.shouldPromptUpdate(ctx), true);
  assert.equal(U.pendingNote(ctx), '新版 v1.5.0 已就绪，刷新页面即生效');

  assert.equal(U.shouldPromptUpdate({ ...ctx, pendingId: '' }), false);
  assert.equal(U.shouldPromptUpdate({ ...ctx, locked: true }), false);
  assert.equal(U.shouldPromptUpdate({ ...ctx, dismissedId: '1.5.0' }), false);
  assert.equal(U.shouldPromptUpdate({ ...ctx, dismissedId: '1.4.9' }), true);
  assert.equal(U.shouldPromptUpdate({ ...ctx, state: U.STATE.UNCONFIGURED }), false);
  assert.equal(U.pendingNote({ ...ctx, locked: true }), '');
});

test('shouldBadge：与小圆点同判据，但不看「稍后」（横幅可关，角标常驻）', () => {
  const ctx = { state: U.STATE.READY, pendingId: '1.5.0' };
  assert.equal(U.shouldBadge(ctx), true);
  assert.equal(U.shouldBadge({ ...ctx, dismissedId: '1.5.0' }), true, '点了「稍后」只是关掉横幅');
  assert.equal(U.shouldBadge({ ...ctx, locked: true }), false);
  assert.equal(U.shouldBadge({ ...ctx, pendingId: '' }), false);
  assert.equal(U.shouldBadge({ ...ctx, state: U.STATE.UNCONFIGURED }), false);
});

test('发布身份（正式通道）：只看版本号，不挂摘要', () => {
  assert.equal(U.identityOf('1.5.0', 'aa'), '1.5.0');
  assert.equal(U.shaTag('AABBCCDDEEFF'), 'aabbccdd'); // 归小写、取前 8 位
  assert.equal(U.shaTag(''), '');
  // 「同号换摘要也算新版」的能力属快照通道（在 update-snapshot-identity.test.js 里验），本通道下必须一口回绝
  assert.equal(
    U.pendingIdentity({ runningVer: '1.5.0', runningSha: 'aa', readyVer: '1.5.0', readySha: 'bb' }),
    '',
  );
  assert.equal(
    U.pendingIdentity({ runningVer: '1.4.0', readyVer: '1.5.0', readySha: 'bb' }),
    '1.5.0',
  );
});
