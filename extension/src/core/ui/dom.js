// core/ui 纯文本工具：属性转义、可选 JSON 解析、630 应答取昵称。
// 无 DOM/状态依赖，被 fields/widgets/panel 复用。

/**
 * 转义写入属性选择器/属性值的双引号与尖括号、&（供可编辑文本字段回填 value）
 * @param {string} s 原值
 * @returns {string}
 */
export function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 字符串载荷尝试 JSON.parse；非串或失败原样返回
 * @param {*} s 原值
 * @returns {*} 解析结果
 */
export function parseMaybe(s) {
  if (typeof s !== 'string' || !s) return s;
  try {
    return JSON.parse(s);
  } catch (e) {
    return s;
  }
}

/**
 * 从 630 应答取展示昵称（微信资料内层串 username/nickname 优先，回退顶层 nickname/name）
 * @param {object} d 应答顶层 parse 产物
 * @returns {string}
 */
export function nickFrom630(d) {
  var wx = d && d.playerInfo;
  if (typeof wx === 'string') wx = parseMaybe(wx);
  return String((wx && (wx.username || wx.nickname)) || (d && (d.nickname || d.name)) || '');
}
