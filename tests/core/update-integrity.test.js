// 完整性「两侧同口径」单测：构建侧 node:crypto 与运行侧 crypto.subtle 必须逐字节同结果。
// 发布脚本算出的 sha256/hmac 若在客户端算成另一个值，验签会恒定失败（远程通道形同虚设）；
// 这条口径校验是原准入哨「两侧同哈希」防线的迁移位置，改动摘要算法或编码时必先在此报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

const KEY = 'pcc-update-key-for-test';
globalThis.__UPDATE_KEY__ = KEY;
globalThis.__OSS_BASE__ = 'https://pcc.example.test/ext/';

const U = await import('../../extension/src/core/update.js');

/**
 * 构建侧 SHA-256 口径（发布脚本同款实现）
 * @param {string} text 正文
 * @returns {string} 小写 hex
 */
function buildSha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 构建侧 HMAC-SHA256 口径（发布脚本同款实现）
 * @param {string} text 正文
 * @param {string} key 密钥
 * @returns {string} 小写 hex
 */
function buildMac(text, key) {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/** @type {string[]} 覆盖多字节、代理对与跨 64KB 分块的样本 */
const SAMPLES = [
  'hello',
  '{"cmd":10912,"ok":true}',
  '口袋控制中心由晚风开发并免费分享',
  'emoji 🎯 surrogate pair 探针',
  'x'.repeat(70000),
  '',
];

test('SHA-256：构建侧与运行侧对同一正文逐样本同结果', async () => {
  for (const text of SAMPLES) {
    assert.equal(await U.digestHex(text), buildSha(text), `摘要不一致: ${text.slice(0, 20)}`);
  }
});

test('HMAC-SHA256：显式密钥与构建期内联密钥两条路径都同结果', async () => {
  for (const text of SAMPLES) {
    assert.equal(await U.hmacHex(text, KEY), buildMac(text, KEY));
    assert.equal(await U.hmacHex(text), buildMac(text, KEY)); // 缺省取 __UPDATE_KEY__
  }
  // 密钥不同则摘要不同（防「密钥没生效」这类静默退化）
  assert.notEqual(await U.hmacHex('abc', KEY), await U.hmacHex('abc', 'other-key'));
});

test('verifyIntegrity：双验通过回正文摘要', async () => {
  const text = 'pocketcc remote bundle 正文';
  const r = await U.verifyIntegrity(text, buildSha(text), buildMac(text, KEY));
  assert.deepEqual(r, { ok: true, reason: '', sha256: buildSha(text) });
});

test('verifyIntegrity：篡改正文判 sha 不符，换密钥判 hmac 不符，缺标记不发起校验', async () => {
  const text = '原始正文';
  const sha = buildSha(text);
  const mac = buildMac(text, KEY);

  const tampered = await U.verifyIntegrity(text + ' ', sha, mac);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'sha-mismatch');
  assert.notEqual(tampered.sha256, sha); // 回实际摘要，便于日志定位

  const wrongKey = await U.verifyIntegrity(text, sha, buildMac(text, 'attacker-key'));
  assert.equal(wrongKey.ok, false);
  assert.equal(wrongKey.reason, 'hmac-mismatch');

  assert.equal((await U.verifyIntegrity(text, '', mac)).reason, 'no-tag');
  assert.equal((await U.verifyIntegrity(text, sha, '')).reason, 'no-tag');
});

test('verifyIntegrity：摘要大小写不敏感（清单里写大写也应通过）', async () => {
  const text = 'mixed case tag';
  const ok = await U.verifyIntegrity(text, buildSha(text).toUpperCase(), buildMac(text, KEY));
  assert.equal(ok.ok, true);
});
