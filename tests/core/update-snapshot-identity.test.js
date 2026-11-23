// 快照通道的「发布身份」单测：版本号刻意钉死（团队约定 snapshot 一律 1.0.0，不让号膨胀），
// 于是「同一版本号的另一份正文」必须能被认成新版，而这条判据只在 channel=snapshot 下成立。
// 纪律：release 侧的一切行为由 update-policy.test.js 守住（本文件不改它一个字节），这里只验分叉的那一半。
// 通道靠构建期 define 承载：本文件在 import 之前把 __PCC_CHANNEL__ 设为 snapshot，且此前不碰 constants.js，
// 这样 update.js 连同它 import 的 constants.js 都是同一次解析的新鲜实例。
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__PCC_CHANNEL__ = 'snapshot';
globalThis.__PCC_VERSION__ = '1.0.0';
globalThis.__OSS_BASE__ = 'https://pcc.example.test/ext/';
globalThis.__UPDATE_KEY__ = 'k-test';

const U = await import('../../extension/src/core/update.js');

/** 正文摘要的两段假值（同一版本号、两份正文） */
const SHA_A = '03b3905465cc522a00000000000000000000000000000000000000000009e5ca';
const SHA_B = 'aa11bb2233445566000000000000000000000000000000000000000000ff00ee';

/**
 * 造一份快照通道清单：latest 与 versions 里同一版本号挂两份正文
 * @param {object} [over] 覆盖顶层字段
 * @returns {ReturnType<U.parseLatest>}
 */
function manifest(over = {}) {
  return U.parseLatest({
    latest: '1.0.0',
    file: 'pocketcc-remote-1.0.0-aa11bb22.js',
    sha256: SHA_B,
    hmac: 'bb',
    versions: [
      {
        ver: '1.0.0',
        file: 'pocketcc-remote-1.0.0-aa11bb22.js',
        sha256: SHA_B,
        hmac: 'bb',
      },
      {
        ver: '1.0.0',
        file: 'pocketcc-remote-1.0.0-03b39054.js',
        sha256: SHA_A,
        hmac: 'aa',
      },
    ],
    ...over,
  });
}

test('快照通道身份串带摘要前 8 位：小写口径、缺摘要时退化为版本号', () => {
  assert.equal(U.identityOf('1.0.0', SHA_B), '1.0.0@aa11bb22');
  assert.equal(U.identityOf('1.0.0', SHA_B.toUpperCase()), '1.0.0@aa11bb22');
  assert.equal(U.identityOf('1.0.0', ''), '1.0.0');
  assert.equal(U.identityOf('', SHA_B), '@aa11bb22');
});

test('pendingIdentity：同版本号换摘要就是待生效，摘要没变才是已最新', () => {
  assert.equal(
    U.pendingIdentity({
      runningVer: '1.0.0',
      runningSha: SHA_A,
      readyVer: '1.0.0',
      readySha: SHA_B,
    }),
    '1.0.0@aa11bb22',
    '同号不同正文必须报出待生效身份',
  );
  assert.equal(
    U.pendingIdentity({
      runningVer: '1.0.0',
      runningSha: SHA_A,
      readyVer: '1.0.0',
      readySha: SHA_A,
    }),
    '',
    '同一份正文不得反复提示刷新',
  );
  // 本会话还没交付出任何文本（runningVer 为空）：就绪那份即待生效，与正式通道同口径
  assert.equal(U.pendingIdentity({ readyVer: '1.0.0', readySha: SHA_B }), '1.0.0@aa11bb22');
  // 同号而正在运行那份的摘要未知：不猜，宁可暂不提示
  assert.equal(U.pendingIdentity({ runningVer: '1.0.0', readyVer: '1.0.0', readySha: SHA_B }), '');
  // 版本更高照旧优先，与摘要无关
  assert.equal(
    U.pendingIdentity({ runningVer: '0.9.0', runningSha: SHA_A, readyVer: '1.0.0' }),
    '1.0.0',
  );
  // 就绪那份更旧（回滚到旧壳）则不提示
  assert.equal(
    U.pendingIdentity({
      runningVer: '1.0.0',
      runningSha: SHA_A,
      readyVer: '0.9.0',
      readySha: SHA_B,
    }),
    '',
  );
});

test('pickBundle：同号新正文照样下载，摘要相同才算了结', () => {
  const latest = manifest();
  // 本地已持有旧摘要正文 → 清单上那份新摘要必须被拉下来
  assert.deepEqual(
    U.pickBundle({ readyVer: '1.0.0', readySha: SHA_A, latest, shellVer: '1.0.0' }),
    {
      action: 'download',
      ver: '1.0.0',
      file: 'pocketcc-remote-1.0.0-aa11bb22.js',
      reason: 'newer',
    },
  );
  // 本地那份就是清单指向的那一份 → 不重复下载
  assert.deepEqual(
    U.pickBundle({ readyVer: '1.0.0', readySha: SHA_B, latest, shellVer: '1.0.0' }),
    {
      action: 'stay',
      ver: '1.0.0',
      file: '',
      reason: 'uptodate',
    },
  );
  // 本地那份的摘要未知（旧缓存记录/摘要没算出来）：宁可重下一份来核对，也不能拿「说不清是哪一份」当作已最新
  assert.equal(
    U.pickBundle({ readyVer: '1.0.0', latest, shellVer: '1.0.0' }).reason,
    'newer',
    'readySha 缺失时重下核对',
  );
  // 反过来：清单目标没带摘要（旧形态清单/仅索引条目）时不下，免得拉回一份无法验签的正文去撞熔断
  assert.equal(
    U.pickBundle({
      readyVer: '1.0.0',
      readySha: SHA_A,
      latest: manifest({ sha256: '', versions: [] }),
      shellVer: '1.0.0',
    }).reason,
    'uptodate',
  );
  // 锁定与「已下载就是最新」两件事仍按老规矩压过摘要判据
  assert.equal(
    U.pickBundle({ readyVer: '1.0.0', readySha: SHA_A, latest, shellVer: '1.0.0', locked: true })
      .reason,
    'locked',
  );
});

test('pickBundle：隔离按身份生效，同号的另一份新正文不会被旧隔离误伤', () => {
  const latest = manifest();
  const blocked = U.identityOf('1.0.0', SHA_B); // 刚抛错的那一份
  assert.equal(
    U.pickBundle({
      readyVer: '1.0.0',
      readySha: SHA_A,
      latest,
      shellVer: '1.0.0',
      blockedId: blocked,
    }).reason,
    'quarantined',
  );
  // 清单换上另一份正文（versions 里的旧摘要那份）：隔离不该把它一起闷掉
  const back = manifest({ file: 'pocketcc-remote-1.0.0-03b39054.js', sha256: SHA_A, hmac: 'aa' });
  assert.deepEqual(
    U.pickBundle({
      readyVer: '1.0.0',
      readySha: SHA_B,
      latest: back,
      shellVer: '1.0.0',
      blockedId: blocked,
    }),
    {
      action: 'download',
      ver: '1.0.0',
      file: 'pocketcc-remote-1.0.0-03b39054.js',
      reason: 'newer',
    },
    '回滚索引里那份旧正文与出错那份不是同一个发布物',
  );
});

test('tagsFor：同号多份正文靠 file 定位，标签不会张冠李戴', () => {
  const latest = manifest();
  assert.deepEqual(U.tagsFor(latest, '1.0.0', 'pocketcc-remote-1.0.0-03b39054.js'), {
    sha256: U.shaTag(SHA_A) + SHA_A.slice(8),
    hmac: 'aa',
  });
  // 只给版本时命中顶层（=刚发的那一份），与 pickBundle 选目标同口径
  assert.equal(U.tagsFor(latest, '1.0.0').sha256, U.shaTag(SHA_B) + SHA_B.slice(8));
});

test('mergeVersions：同号不同摘要是两条发布物，都得留着；同摘要才以新为准', () => {
  const prev = [{ ver: '1.0.0', file: 'a.js', sha256: SHA_A, hmac: 'aa' }];
  const added = [
    { ver: '1.0.0', file: 'b.js', sha256: SHA_B, hmac: 'bb', notes: '新' },
    { ver: '1.0.0', file: 'c.js', sha256: SHA_A, hmac: 'aa2' },
  ];
  const merged = U.mergeVersions(prev, added, 5);
  assert.equal(merged.length, 2, '两份正文两条记录，同摘要的那条被新的覆盖');
  assert.equal(merged[0].file, 'b.js');
  assert.equal(merged[1].hmac, 'aa2', '同身份以 added 为准');
});

test('makeLatest：快照通道产物仍被客户端原样读回（versions 里同号两条都在）', () => {
  const built = U.makeLatest({
    latest: '1.0.0',
    file: 'pocketcc-remote-1.0.0-aa11bb22.js',
    sha256: SHA_B,
    hmac: 'bb',
    size: 1265628,
    notes: '',
    prev: { versions: [{ ver: '1.0.0', file: 'a.js', sha256: SHA_A, hmac: 'aa' }] },
    added: [
      {
        ver: '1.0.0',
        file: 'pocketcc-remote-1.0.0-aa11bb22.js',
        notes: '',
        sha256: SHA_B,
        hmac: 'bb',
      },
    ],
    publishedAt: '2026-11-23T10:55:59.065Z',
  });
  const back = U.parseLatest(JSON.stringify(built));
  assert.equal(back.versions.length, 2, '同号两份正文都必须在回滚索引里');
  assert.equal(back.versions[0].sha256, U.shaTag(SHA_B) + SHA_B.slice(8));
  const d = U.pickBundle({ readyVer: '1.0.0', readySha: SHA_A, latest: back, shellVer: '1.0.0' });
  assert.equal(d.action, 'download');
  assert.equal(
    U.assertUrl(d.file, 'https://pcc.example.test/ext/'),
    'https://pcc.example.test/ext/pocketcc-remote-1.0.0-aa11bb22.js',
    '带摘要段的文件名必须过 assertUrl（客户端唯一的地址校验）',
  );
});

test('提示口径：pendingId 进文案，「稍后」只关掉那一份正文', () => {
  const ctx = { state: U.STATE.READY, pendingId: '1.0.0@aa11bb22' };
  assert.equal(U.shouldPromptUpdate(ctx), true);
  assert.equal(U.pendingNote(ctx), '新版 v1.0.0@aa11bb22 已就绪，刷新页面即生效');
  assert.equal(U.shouldPromptUpdate({ ...ctx, dismissedId: '1.0.0@aa11bb22' }), false);
  assert.equal(
    U.shouldPromptUpdate({ ...ctx, dismissedId: '1.0.0@03b39054' }),
    true,
    '点过旧正文的「稍后」不该把新正文也闷掉',
  );
  assert.equal(U.shouldBadge({ ...ctx, dismissedId: '1.0.0@aa11bb22' }), true);
});
