// 隔离世界脚本：扩展中唯一能访问 chrome.* API 的地方。
// MAIN world 的 boot.js 无法调用 chrome.storage，故通过 window.postMessage 代理读写。
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

    // 报文录制落盘转发：MAIN(net-collect) → bridge → background service worker 代发 POST（绕页面 CSP）。
    // fire-and-forget：不回发 MAIN（net-collect 不消费回执）；无接收器/后台错误只记一行，绝不阻断收发。
    if (msg.op === 'dashcam-flush') {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'dashcam-flush',
            url: msg.url,
            session: msg.session,
            ndjson: msg.ndjson,
            uid: msg.uid,
            startTs: msg.startTs,
            note: msg.note,
            done: msg.done,
          },
          () => {
            void chrome.runtime.lastError;
          },
        );
      } catch (e) {
        console.warn('[pocketcc bridge] dashcam-flush send failed', e);
      }
      return;
    }

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
