/**
 * ACL 域切片 · 头像资源 URL 换算（core/acl/avatar.js）
 * 原 core/game-api.js 的 avatar 区段，按域拆分片4逐字迁出（行为零变化）。
 */
import { pathUtils } from '../acl-engine.js';

/**
 * 头像资源能力（只读）：把 630 应答里的头像字段原值转成可加载的图片 URL。游戏两种头像：
 *   - 用户/平台自定义：headimgurl / headimgurl_custom 是 http(s) 真实 URL → 原样返回；
 *   - 游戏自带：avatarurl 是图集资源名（如 hero_icon119_global，非 URL）→ 交游戏 PathUtils.GetIconURL
 *     拼成 <ResourceUrl>/DynRes/images/headpic/<name>.png（自动跟随版本与 ignoreOtherPlatform/RPZ 分支）。
 * 直接把图集名塞给 <img> 会命中页面相对路径 404（真机实证），必须经此换算。
 * @param {string} raw 头像字段原值
 * @returns {string} 可加载 URL；空值/符号缺失/不可解析返回 ''（上层走首字母占位）
 */
export const avatar = {
  iconUrl(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v) return '';
    if (/^(https?:)?\/\//i.test(v) || /^data:/i.test(v)) return v; // 平台/用户上传的真实 URL 直接用
    var P = pathUtils();
    if (P) {
      try {
        var u = P.GetIconURL(v);
        return typeof u === 'string' && u ? u : '';
      } catch (e) {}
    }
    return ''; // 游戏符号缺失且非 URL：不猜路径，交占位
  },
};
