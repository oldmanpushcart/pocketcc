// 联盟集结 · 快照池迁移守卫。
// 动机：alliance-rally 的去重/延迟/过期已收进 core/snapshot-pool.js（D 原语），
//   旧 pendingTeamIds Set + scheduleJoin 手写样板若回潮，会绕过池的「拒入不续命/一次性消耗/pause 保留续跑」
//   不变量，重演重复加入与暂停后丢集结。本测试是离线源码闸，防迁移回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rallyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../extension/src/feats/alliance/alliance-rally/index.js',
);

test('alliance-rally.js 无 legacy 去重/延迟样板残留（pendingTeamIds/scheduleJoin）', () => {
  const src = readFileSync(rallyPath, 'utf8');
  for (const name of ['pendingTeamIds', 'scheduleJoin']) {
    assert.ok(
      !src.includes(name),
      'legacy 样板回潮：alliance-rally.js 出现 ' + name + '（去重/wake.at/TTL 已归快照池）',
    );
  }
  assert.ok(
    src.includes("import { createSnapshotPool } from '../../../core/snapshot-pool.js'"),
    'alliance-rally.js 必须经 core/snapshot-pool.js 入池（不得自持去重池）',
  );
  assert.ok(
    src.includes('pool.reschedule()'),
    'run() 必须调 pool.reschedule() 续跑 pause 保留的条目',
  );
});
