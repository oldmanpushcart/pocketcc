// 异能秘境账本原语 TtlLedger 离线单测（三-2：七账本 TTL 语义收口）。
// ledger.js 是零 import 叶子，直接静态 import，不桩浏览器全局。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlLedger } from '../../extension/src/feats/activity/secret-realm/ledger.js';

test('mark/has/get：无 TTL 标记存在性口径（dayBlack/bossDone/exhausted 档）', () => {
  const l = new TtlLedger();
  assert.equal(l.has('1,2'), false);
  l.mark('1,2');
  assert.equal(l.has('1,2'), true);
  assert.equal(l.get('1,2'), true); // 非数值哨兵，sweep 不碰
  l.delete('1,2');
  assert.equal(l.has('1,2'), false);
});

test('空键防御：mark/set/get/has/delete 对空串一律无操作', () => {
  const l = new TtlLedger();
  l.mark('');
  l.set('', 5);
  assert.equal(l.size, 0);
  assert.equal(l.get(''), undefined);
  assert.equal(l.has(''), false);
  l.delete('');
});

test('set/get 原样取值不判过期（TTL 判定归调用方，与旧读口径逐位等价）', () => {
  const l = new TtlLedger();
  l.set('3,4', 1000);
  assert.equal(l.get('3,4'), 1000); // 已过期仍原样返回，调用方自判 until > now
  assert.equal(l.get('9,9'), undefined);
});

test('sweep：数值 until<=now 清、-1 永久哨兵与非数值载荷不碰', () => {
  const l = new TtlLedger();
  l.set('a', 1000); // 已过期
  l.set('b', 3000); // 未到期
  l.set('c', -1); // 永久黑哨兵
  l.mark('d'); // 无 TTL 标记
  l.set('e', { kind: 'res', bagFree: 0 }); // 无 TTL 载荷（change 档）
  const n = l.sweep(2000);
  assert.equal(n, 1);
  assert.deepEqual(l.keys(), ['b', 'c', 'd', 'e']);
});

test('sweep 边界：until===now 即过期（与旧 marched/consumed 的 <= 口径一致）', () => {
  const l = new TtlLedger();
  l.set('a', 2000);
  assert.equal(l.sweep(2000), 1);
  assert.equal(l.size, 0);
});

test('forEach 与 Map 同序 (value,key)；keys 插入序；clear 整表清', () => {
  const l = new TtlLedger();
  l.set('a', 1);
  l.set('b', 2);
  const seen = [];
  l.forEach((v, k) => seen.push([k, v]));
  assert.deepEqual(seen, [
    ['a', 1],
    ['b', 2],
  ]);
  assert.deepEqual(l.keys(), ['a', 'b']);
  l.clear();
  assert.equal(l.size, 0);
});
