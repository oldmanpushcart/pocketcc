// 「设置备份」判据层单测：文件名规范（大端写所以字典序=时间序、UID 净化）、信封往返、
// 以及「一份外来 JSON 能不能落到配置 blob 上」的逐键裁决（脏键丢弃但不整份报废、注入键挡在门外）。
// 本文件只锁判据；下载/选文件/写盘那些 I/O 在 core/ui/wire.js 与 core/storage.js（后者见 storage-merge-config.test.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND,
  SCHEMA,
  buildEnvelope,
  exportFileName,
  parseSettings,
  safeUid,
} from '../../extension/src/core/settings-io.js';

/** @type {Date} 固定导出时刻（本地口径构造，与被测函数一样只看本地字段，不随机器时区漂移） */
const AT = new Date(2026, 10, 23, 9, 5, 3);

test('文件名：pocketcc-UID-年月日-时分秒，补零到位', () => {
  assert.equal(exportFileName('12345', AT), 'pocketcc-12345-20261123-090503.json');
});

test('文件名：字典序就是时间序（凌晨早于中午，11 月晚于 9 月）', () => {
  const early = exportFileName('1', new Date(2026, 8, 1, 0, 7, 9));
  const late = exportFileName('1', new Date(2026, 10, 23, 12, 30, 0));
  assert.deepEqual([early, late].slice().sort(), [early, late]);
  assert.equal(early, 'pocketcc-1-20260901-000709.json');
});

test('文件名：UID 只留路径安全字符，前导点横线一并去掉', () => {
  assert.equal(safeUid('../../etc/passwd'), 'etc_passwd');
  assert.ok(!safeUid('a/b\\c:d*e?f').includes('/'));
  assert.ok(!/^[._-]/.test(safeUid('..x')));
});

test('文件名：UID 缺失或畸形回落 anon，超长截断不撑爆路径', () => {
  assert.equal(safeUid(null), 'anon');
  assert.equal(safeUid(''), 'anon');
  assert.equal(safeUid('   '), 'anon');
  assert.equal(safeUid('9'.repeat(64)).length, 24);
  assert.equal(exportFileName(undefined, AT), 'pocketcc-anon-20261123-090503.json');
});

test('信封：字段齐备，导出件原样读得回来（含 uid 与导出时刻）', () => {
  const settings = { 'pocketcc.reconnect.config': { enabled: true, intervalSec: 45, _v: 1 } };
  const env = buildEnvelope({
    uid: '42',
    settings,
    remoteVer: '1.4.0',
    channel: 'release',
    now: AT,
  });
  assert.equal(env.kind, KIND);
  assert.equal(env.schema, SCHEMA);
  assert.deepEqual(env.from, { remote: '1.4.0', channel: 'release' });
  const r = parseSettings(JSON.stringify(env, null, 2));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.settings, settings);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.meta.uid, '42');
  assert.equal(r.meta.exportedAt, AT.toISOString());
});

test('拒收：空文件、非法 JSON、顶层不是对象', () => {
  for (const bad of [
    '',
    '   ',
    '\n\t',
    'not json at all',
    '{',
    '[1,2,3]',
    '"just a string"',
    '7',
  ]) {
    const r = parseSettings(bad);
    assert.equal(r.ok, false, `该拒收：${JSON.stringify(bad)}`);
    assert.ok(r.error && r.error.length > 0, '失败必须给一句能上界面的原因');
  }
});

test('拒收：kind 不是本程序的设置备份（凭证导出件混进来要当场认出来）', () => {
  const r = parseSettings(JSON.stringify({ kind: 'pocketcc.credentials', tokens: {} }));
  assert.equal(r.ok, false);
  assert.match(r.error, /kind=pocketcc\.credentials/);
});

test('拒收：schema 比当前程序新（宁拒不误解析），等号放行', () => {
  const newer = parseSettings(
    JSON.stringify({ kind: KIND, schema: SCHEMA + 1, settings: { 'pocketcc.a': {} } }),
  );
  assert.equal(newer.ok, false);
  assert.match(newer.error, /请先升级/);
  const same = parseSettings(
    JSON.stringify({ kind: KIND, schema: SCHEMA, settings: { 'pocketcc.a': { enabled: true } } }),
  );
  assert.equal(same.ok, true, same.error);
});

test('拒收：信封齐了但 settings 缺失或不是对象', () => {
  for (const settings of [undefined, null, 'x', [1, 2]]) {
    const r = parseSettings(JSON.stringify({ kind: KIND, schema: SCHEMA, settings }));
    assert.equal(r.ok, false);
  }
});

test('裸 map 也收（手搓或从别处拷的），但必须看得出是设置', () => {
  const ok = parseSettings(JSON.stringify({ 'pocketcc.feat.autoFarm': { enabled: true } }));
  assert.equal(ok.ok, true, ok.error);
  assert.equal(Object.keys(ok.settings).length, 1);
  assert.deepEqual(ok.meta, { uid: '', exportedAt: '', schema: 0 });
  // 没有 kind 也一个 pocketcc.* 键都没有 → 是陌生文件，不是设置
  const alien = parseSettings(JSON.stringify({ tokens: { a: 1 }, note: 'x' }));
  assert.equal(alien.ok, false);
  assert.match(alien.error, /认不出/);
});

test('逐键裁决：脏键进 dropped，合法键照收（不因个别坏键整份报废）', () => {
  const r = parseSettings(
    JSON.stringify({
      kind: KIND,
      schema: SCHEMA,
      settings: {
        'pocketcc.feat.csHunt': { enabled: true },
        'pocketcc.quickJump.hist': [1, 2, 3], // 值是数组也收：blob 里存什么形态由该键的主人说了算
        note: '手写的备注',
        '': { enabled: false },
      },
    }),
  );
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r.settings), ['pocketcc.feat.csHunt', 'pocketcc.quickJump.hist']);
  assert.deepEqual(r.dropped, ['note', '']);
});

test('注入键挡在门外：__proto__ 不得改动任何对象的原型', () => {
  // 必须拿字符串喂：对象字面量里的 `__proto__:` 是设原型，不是 own 键，造不出恶意件
  const r = parseSettings('{"__proto__":{"polluted":1},"pocketcc.a":{"enabled":true}}');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r.settings), ['pocketcc.a']);
  assert.deepEqual(r.dropped, ['__proto__']);
  assert.equal({}.polluted, undefined);
});

test('全是被拒的键时整份拒收（宁可什么都不写，也不报「已导入 0 项」）', () => {
  const r = parseSettings(JSON.stringify({ kind: KIND, schema: SCHEMA, settings: { junk: 1 } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /没有任何可用的设置项/);
});
