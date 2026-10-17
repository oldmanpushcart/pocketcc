// 口袋控制中心 — 准入哨（net-guard）。
// 运行期身份比对：把登录账号与构建期内联的期望摘要做同口径哈希比对，产出「是否放行」布尔。
// 三 world（content MAIN / bridge ISOLATED / background SW）各 bundle 一份同口径实现，
// 故哈希必须是零依赖纯 JS（不依赖 crypto.subtle——ISOLATED/SW 环境不一，口径漂移会误伤自己人）。
// 无限制包（__LICENSE_HASH__ 空串）时所有判定短路放行，dev 行为零变化。
// 构建期 define 符号在 eslint.config.js 扩展段统一登记（与 cc/__require 同惯例）。

/** @type {string} 期望摘要（构建期内联，包内不落账号明文） */
const EXPECT = typeof __LICENSE_HASH__ === 'string' ? __LICENSE_HASH__ : '';
/** @type {string} 加盐口径（与构建脚本一致） */
const SALT = typeof __LICENSE_SALT__ === 'string' ? __LICENSE_SALT__ : '';
/** @type {string} 赠予对象昵称（水印展示用） */
const FRIEND = typeof __LICENSE_FRIEND__ === 'string' ? __LICENSE_FRIEND__ : '';
/** @type {string} 构建版本号 */
const VERSION = typeof __PCC_VERSION__ === 'string' ? __PCC_VERSION__ : 'dev';

// ── 纯 JS SHA-256（FIPS 180-4 标准实现，输入 UTF-8 字符串、输出小写 hex）──
/** @type {number[]} 初始哈希常数（前 32 位平方根小数部分） */
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
/** @type {number[]} 轮常数（前 64 位质数立方根小数部分，FIPS 180-4 标准表） */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * 32 位循环右移
 * @param {number} x 值
 * @param {number} n 位数
 * @returns {number}
 */
function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/**
 * 字符串 → UTF-8 字节数组
 * @param {string} s 输入
 * @returns {number[]} 字节
 */
function utf8Bytes(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 63),
          0x80 | ((cp >> 6) & 63),
          0x80 | (cp & 63),
        );
        i++;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

/**
 * SHA-256：字节数组 → 64 字符小写 hex
 * @param {number[]} bytes 输入字节
 * @returns {string} hex 摘要
 */
function sha256Hex(bytes) {
  var h = H0.slice();
  var len = bytes.length;
  // 填充：0x80 + 若干 0 + 64bit 大端长度
  var padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  var bitLenHi = Math.floor((len * 8) / 4294967296);
  var bitLenLo = (len * 8) >>> 0;
  padded.push(
    (bitLenHi >>> 24) & 255,
    (bitLenHi >>> 16) & 255,
    (bitLenHi >>> 8) & 255,
    bitLenHi & 255,
  );
  padded.push(
    (bitLenLo >>> 24) & 255,
    (bitLenLo >>> 16) & 255,
    (bitLenLo >>> 8) & 255,
    bitLenLo & 255,
  );

  var w = new Array(64);
  for (var blk = 0; blk < padded.length; blk += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] =
        ((padded[blk + t * 4] << 24) |
          (padded[blk + t * 4 + 1] << 16) |
          (padded[blk + t * 4 + 2] << 8) |
          padded[blk + t * 4 + 3]) >>>
        0;
    }
    for (t = 16; t < 64; t++) {
      var s0 = (rotr32(w[t - 15], 7) ^ rotr32(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      var s1 = (rotr32(w[t - 2], 17) ^ rotr32(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    var a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4],
      f = h[5],
      g = h[6],
      hh = h[7];
    for (t = 0; t < 64; t++) {
      var S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      var temp1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      var S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  var hex = '';
  for (t = 0; t < 8; t++) hex += (h[t] + 0x100000000).toString(16).slice(1);
  return hex;
}

/**
 * 同口径摘要：盐 + 地址 → hex（构建侧 node:crypto 与本实现结果一致）
 * @param {string} addr 待比对地址（游戏账号标识）
 * @returns {string} hex 摘要
 */
export function digest(addr) {
  return sha256Hex(utf8Bytes(SALT + addr));
}

/**
 * 是否不设限（无限制包恒真；三 world 闸门据此短路放行）
 * @returns {boolean}
 */
export function slotFree() {
  return EXPECT === '';
}

/** @type {Object<string, boolean>} addr → 判定缓存（哈希每 addr 只算一次，副闸高频路径零开销） */
const verdict = {};

/**
 * 准入判定：地址摘要与期望值是否同座（无限制包恒真）
 * @param {string|null|undefined} addr 运行期取到的账号标识
 * @returns {boolean}
 */
export function screen(addr) {
  if (EXPECT === '') return true;
  if (!addr) return false;
  var key = String(addr);
  if (verdict[key] === undefined) verdict[key] = digest(key) === EXPECT;
  return verdict[key];
}

/** @returns {string} 赠予对象昵称（无限制包为空串） */
export function peerName() {
  return FRIEND;
}

/** @returns {string} 构建版本号 */
export function revision() {
  return VERSION;
}
