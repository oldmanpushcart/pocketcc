// 隔离世界脚本：扩展中唯一能访问 chrome.* API 的地方。
// MAIN world 的 boot.js 无法调用 chrome.storage，故通过 window.postMessage 代理读写。
// 准入副闸（分布式闸门之二）：本 bundle 自带同源哨（net-guard），只认持有正确摘要的账号放行存储代理；
// 不设限包构建期即短路放行（零行为变化），授权包未收/未过 'hello' 复验前 get 回空、写静默丢弃。
import { NS } from './core/constants.js';
import { screen, slotFree } from './core/net-guard.js';

(() => {
  // 幂等守卫：同一 world 内 bridge 的 message 监听只允许绑定一次。
  // 陈旧实例与新注入并存时（场景③），两份监听会对同一条 main->bridge 各回一份同 id 的 bridge->main，
  // 造成 storage.js 侧 resolve/reject 竞态（往往是失效上下文那份先到 → 误报）；命中守卫即直接返回，不再叠加监听。
  if (window.__pocketccBridgeInited) return;
  window.__pocketccBridgeInited = true;

  /** @type {boolean} 存储代理放行态：不设限包恒真；授权包由 'hello' 消息携带的账号经本侧独立复验后置真 */
  let unlocked = slotFree();

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

    // 准入交接：MAIN 侧首验后经此夹带账号，本侧用同源哨独立复验（不信任对岸断言，摘要对不上不放行）
    if (msg.op === 'hello') {
      if (!slotFree()) unlocked = screen(msg.uid);
      return;
    }

    // 报文录制落盘转发：MAIN(net-collect) → bridge → background service worker 代发 POST（绕页面 CSP）。
    // fire-and-forget：不回发 MAIN（net-collect 不消费回执）；无接收器/后台错误只记一行，绝不阻断收发。
    if (msg.op === 'dashcam-flush') {
      if (!unlocked) return; // 未放行：录制旁路同样静默丢弃
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
    // 准入副闸未开：读回空、写静默成功丢弃（与上下文失效降级同款容错风格：回真实形状、不 reject、不挂死在途队列）
    if (!unlocked) {
      window.postMessage(
        { __ns: NS, dir: 'bridge->main', id, result: op === 'get' ? undefined : true },
        '*',
      );
      return;
    }
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
