// 隔离世界脚本：扩展中唯一能访问 chrome.* API 的地方。
// MAIN world 的 boot.js 无法调用 chrome.storage，故通过 window.postMessage 代理读写。
import { NS } from './core/constants.js';

(() => {
  // 幂等守卫：同一 world 内 bridge 的 message 监听只允许绑定一次。
  // 陈旧实例与新注入并存时（场景③），两份监听会对同一条 main->bridge 各回一份同 id 的 bridge->main，
  // 造成 storage.js 侧 resolve/reject 竞态（往往是失效上下文那份先到 → 误报）；命中守卫即直接返回，不再叠加监听。
  if (window.__pocketccBridgeInited) return;
  window.__pocketccBridgeInited = true;

  /**
   * @type {boolean} 扩展上下文失效哨兵：MV3 重载/停用后 chrome.runtime.* 一律抛 'Extension context invalidated'，
   * 而 flush 旁路每批日志/报文都会触发 → 若逐次告警必刷屏。命中一次即置真，此后旁路转发静默跳过（与 storage.js
   * 的 contextInvalidated 同义、不可逆，需页面刷新重建）。
   */
  let contextDead = false;

  /**
   * 判别是否为「扩展上下文失效」抛错（重载/停用后 chrome.runtime 调用的统一报错）。
   * @param {unknown} e catch 到的异常
   * @returns {boolean}
   */
  function isContextGone(e) {
    return /Extension context invalidated/.test(String((e && e.message) || e));
  }

  /**
   * 升级通道请求中继：MAIN（壳 / 远程体）→ background 状态机，结果带同 id 以 dir='bridge->main' 回发。
   * 与 dashcam 两条 fire-and-forget 通道不同，这里必须给回执——壳拿不到远程体文本就无法启动。
   * @param {object} msg main->bridge 消息（op:'update-bundle' | 'update-cmd'）
   */
  function relayUpdate(msg) {
    /**
     * 统一回发包
     * @param {*} result 成功结果
     * @param {string} [error] 失败原因
     */
    const reply = (result, error) =>
      window.postMessage({ __ns: NS, dir: 'bridge->main', id: msg.id, result, error }, '*');
    if (contextDead) {
      reply(undefined, 'extension context invalidated');
      return;
    }
    try {
      chrome.runtime.sendMessage(
        {
          type: 'pcc-update',
          op: msg.op,
          prefer: msg.prefer,
          cmd: msg.cmd,
          ver: msg.ver,
          why: msg.why,
          value: msg.value,
        },
        (resp) => {
          // 必须读掉 lastError，否则 Chrome 就报 "Unchecked runtime.lastError"
          const le = chrome.runtime.lastError;
          if (le) reply(undefined, String(le.message || le));
          else if (resp && resp.ok === false) reply(undefined, String(resp.err || 'update failed'));
          else reply(resp && 'data' in resp ? resp.data : resp);
        },
      );
    } catch (e) {
      if (isContextGone(e)) contextDead = true;
      reply(undefined, String((e && e.message) || e));
    }
  }

  /**
   * background 升级状态广播 → MAIN（EVT.UPDATE_STATE 的载体）。
   * 只转发本命名协议关心的那一条，其余消息不响应（包括自己刚发出的请求的回执方向）。
   */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'pcc-update-state') return undefined;
    window.postMessage(
      { __ns: NS, dir: 'bridge->main', ev: 'update-state', state: msg.state },
      '*',
    );
    return undefined;
  });

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
    // fire-and-forget：不回发 MAIN（net-collect 不消费回执）；无接收器/后台错误只记一行，始终不阻断收发。
    if (msg.op === 'dashcam-flush') {
      if (contextDead) return; // 上下文失效后彻底静默（避免逐批抛错刷屏）
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
        if (isContextGone(e)) {
          contextDead = true;
          return;
        }
        console.warn('[pocketcc bridge] dashcam-flush send failed', e);
      }
      return;
    }

    // 日志上送落盘转发：MAIN(log-collect) → bridge → background 代发 POST /log。同报文通道纪律：
    // fire-and-forget、失败只记一行不阻断。
    if (msg.op === 'dashcam-log-flush') {
      if (contextDead) return; // 上下文失效后彻底静默（避免逐批抛错刷屏）
      try {
        chrome.runtime.sendMessage(
          {
            type: 'dashcam-log-flush',
            url: msg.url,
            run: msg.run,
            uid: msg.uid,
            ndjson: msg.ndjson,
          },
          () => {
            void chrome.runtime.lastError;
          },
        );
      } catch (e) {
        if (isContextGone(e)) {
          contextDead = true;
          return;
        }
        console.warn('[pocketcc bridge] dashcam-log-flush send failed', e);
      }
      return;
    }

    // 升级通道：壳取待执行文本、远程体与面板发命令，都转交 background 状态机（它才是唯一出网口）。
    if (msg.op === 'update-bundle' || msg.op === 'update-cmd') {
      relayUpdate(msg);
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
