// 隔离世界脚本：扩展中唯一能访问 chrome.* API 的地方。
// MAIN world 的 main.js 无法调用 chrome.storage，故通过 window.postMessage 代理读写。
import { NS } from './core/constants.js';

(() => {
  /**
   * 存储代理：只认本命名空间且 dir='main->bridge' 的消息，按 op 分发到 chrome.storage.local，
   * 结果带同 id 以 dir='bridge->main' 回发（get 回值，set/remove 回 true；异常回 error 字符串）
   * @param {MessageEvent} event window message 事件
   * @returns {Promise<void>}
   */
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__ns !== NS || msg.dir !== 'main->bridge') return;

    const { id, op, key, value } = msg;
    let result;
    let error;
    try {
      if (op === 'get') {
        result = (await chrome.storage.local.get(key))[key];
      } else if (op === 'set') {
        await chrome.storage.local.set({ [key]: value });
        result = true;
      } else if (op === 'remove') {
        await chrome.storage.local.remove(key);
        result = true;
      } else {
        throw new Error(`unknown op: ${op}`);
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    window.postMessage({ __ns: NS, dir: 'bridge->main', id, result, error }, '*');
  });
})();
