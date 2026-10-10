// 双态浮动图标 SVG（同一轮廓，冷/热两套配色）。返回完整 <svg> 字符串，由 ui/index.js 的 mountUI 塞进 .pc-icon。
//   日常：四条弧 + CC 全蓝，冷色 body。
//   战斗：body 转热、内圈警戒环、火焰渐变弧、余烬 CC。
// 光晕呼吸动画不在这里：元素 <span class="pc-halo"> 见 ui/index.js，其样式见 ui/panel-css.js 的 .pc-halo。

/** @type {string} SVG 文字字体栈（与面板 CSS 一致） */
const FONT = "system-ui,-apple-system,'Segoe UI',sans-serif";

/**
 * 按战斗态选一套配色输出图标 SVG
 * @param {boolean} combat 战斗态与否
 * @param {number} size 输出宽高（px）
 * @returns {string} svg 字符串
 */
export function iconSVG(combat, size) {
  return combat ? combatSVG(size) : dailySVG(size);
}

/**
 * 日常态：四条弧 + CC 全蓝，冷色 body
 * @param {number} size 输出宽高（px）
 * @returns {string} svg 字符串
 */
function dailySVG(size) {
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}">
    <defs>
      <radialGradient id="pcBodyCold" cx="50%" cy="42%" r="68%">
        <stop offset="0%" stop-color="#1c2b46"/><stop offset="70%" stop-color="#0e1626"/><stop offset="100%" stop-color="#070c16"/>
      </radialGradient>
    </defs>
    <circle cx="24" cy="24" r="23" fill="url(#pcBodyCold)" stroke="#22344f" stroke-width="1"/>
    <path d="M13 8.6 A19 19 0 0 1 35 8.6" fill="none" stroke="#2f9bff" stroke-width="3" stroke-linecap="round"/>
    <path d="M35 39.4 A19 19 0 0 1 13 39.4" fill="none" stroke="#2f9bff" stroke-width="3" stroke-linecap="round"/>
    <path d="M6.5 27 A18 18 0 0 1 10 12.5" fill="none" stroke="#2f9bff" stroke-width="2.2" stroke-linecap="round" opacity=".9"/>
    <path d="M41.5 21 A18 18 0 0 1 38 35.5" fill="none" stroke="#2f9bff" stroke-width="2.2" stroke-linecap="round" opacity=".9"/>
    <text x="24" y="31" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="800" letter-spacing="0.5" fill="#2f9bff">CC</text>
  </svg>`;
}

/**
 * 战斗态：body 转热、内圈警戒环、火焰渐变弧、余烬 CC
 * @param {number} size 输出宽高（px）
 * @returns {string} svg 字符串
 */
function combatSVG(size) {
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}">
    <defs>
      <radialGradient id="pcBodyHot" cx="50%" cy="42%" r="68%">
        <stop offset="0%" stop-color="#4a1410"/><stop offset="70%" stop-color="#2a0b08"/><stop offset="100%" stop-color="#170503"/>
      </radialGradient>
      <linearGradient id="pcEmber" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#fff0c2"/><stop offset="50%" stop-color="#ffc247"/><stop offset="100%" stop-color="#ff8a1e"/>
      </linearGradient>
      <linearGradient id="pcFlame" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffb03a"/><stop offset="100%" stop-color="#ff3b1f"/>
      </linearGradient>
    </defs>
    <circle cx="24" cy="24" r="23" fill="url(#pcBodyHot)" stroke="#5a1d12" stroke-width="1"/>
    <circle cx="24" cy="24" r="19.5" fill="none" stroke="#ff3b30" stroke-width="1.2" opacity=".55"/>
    <path d="M13 8.6 A19 19 0 0 1 35 8.6" fill="none" stroke="url(#pcFlame)" stroke-width="3" stroke-linecap="round"/>
    <path d="M35 39.4 A19 19 0 0 1 13 39.4" fill="none" stroke="url(#pcFlame)" stroke-width="3" stroke-linecap="round"/>
    <path d="M6.5 27 A18 18 0 0 1 10 12.5" fill="none" stroke="#ff5a2a" stroke-width="2.2" stroke-linecap="round" opacity=".95"/>
    <path d="M41.5 21 A18 18 0 0 1 38 35.5" fill="none" stroke="#ff5a2a" stroke-width="2.2" stroke-linecap="round" opacity=".95"/>
    <text x="24" y="31" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="800" letter-spacing="0.5" fill="url(#pcEmber)">CC</text>
  </svg>`;
}
