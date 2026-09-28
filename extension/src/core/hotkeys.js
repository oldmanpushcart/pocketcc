/**
 * 键盘绑定公共设施：全项目「绑裸键」功能共用的输入焦点守卫。
 *
 * 为什么需要它（而非各 feat 自己看 e.target）：辅助浮层（控制面板、聊天窗）都挂在 Shadow DOM 内，
 * 挂在 document/window 级的 keydown 监听拿到的 e.target 会被事件重定向（retargeting）成 shadow host，
 * 看不到里层真正聚焦的 <textarea>/<input>——于是「在浮层输入框打字」被误判成「在画布按热键」而触发
 * 绑键功能（实测：先选中单位露出快捷攻击面板，再在聊天框打字，数字键会误发攻击）。key 事件 composed:true，
 * e.composedPath()[0] 能穿透 shadow 边界拿到真实目标元素，故以此为准。收口于此，各 feat 复用，避免重踩。
 */

/**
 * 非文本类 <input> 的 type 集合：这些控件聚焦时不算「正在打字」（如按钮聚焦下按数字仍应触发热键）。
 * 反向判定比白名单稳（文本类 type 繁多：text/search/url/tel/email/password/number/date…）。
 * @type {Set<string>}
 */
const NON_TEXT_INPUT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'range', 'color', 'file']);

/**
 * 判定「此刻焦点是否在可文字输入元素里」，供绑键功能决定是否让位于打字。
 * @param {KeyboardEvent} e 键盘事件
 * @returns {boolean} true=正在文本输入，绑键功能应跳过本次按键（热键让位给打字）
 */
export function isTypingTarget(e) {
  // 穿透 Shadow DOM：composedPath()[0] 是事件路径最内层真实目标；老环境无 API 时退化 e.target
  var t = (e && typeof e.composedPath === 'function' ? e.composedPath()[0] : null) || (e && e.target);
  if (!t || !t.tagName) return false;
  if (t.tagName === 'TEXTAREA') return true;
  if (t.isContentEditable) return true;
  if (t.tagName === 'INPUT') return !NON_TEXT_INPUT.has((t.type || 'text').toLowerCase());
  return false;
}
