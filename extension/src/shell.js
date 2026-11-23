// 口袋控制中心 — 薄壳入口（MAIN world，document_idle）。
// 壳只做三件事：向后台要「本地已就绪的最优远程体文本」→ 在 MAIN world 执行它 → 顺手触发一次后台复检。
// 两条纪律在本文件收口：
//   1. 启动路径绝不阻塞网络——要的是后台本地读盘结果（缓存远程体 > 包内基线），不等 OSS、不 await 检查结果；
//   2. 远程体只在启动时执行一次，运行期永不热替换（会打断在途行军与 reactor 状态），新版只在下一次刷新生效。
// 壳不 import feats 与 core/ui（.dependency-cruiser 的 shell-stays-thin 禁边守住：壳变肥就等于每次发版都要重发所有人的扩展包）。
// 因此这里的 postMessage 请求-应答是最小自实现，不复用 core/storage.js（那是远程体内部件，且带 UID 命名空间语义）。
import { NS, CHANNEL_NAME } from './core/constants.js';
import { ASK_TIMEOUT_MS, revision } from './core/update.js';

(() => {
  // 幂等守卫：扩展重载后陈旧壳实例可能与新实例并存，同一 world 内只允许一份壳在跑。
  // 同一个标志顺手挡住「多个发布通道同时启用」：三套构建的扩展 ID 不同、能同时装进浏览器，
  // 但它们都往同一个游戏页的 MAIN world 注入，两份远程体并存等于同一个账号跑两套自动化（重复出征、互相踩状态）。
  // 因此只让先到的那份跑，后到的留一条可诊断的告警，而不是静默退出。
  if (window.__pccShellInited) {
    if (window.__pccShellInited !== CHANNEL_NAME) {
      console.warn(
        `[pocketcc shell] ${CHANNEL_NAME} 通道没启动：本页已由「${window.__pccShellInited}」通道占用。` +
          ' 去扩展管理页只启用一个通道（同时启用等于同一账号跑两套自动化）。',
      );
    }
    return;
  }
  window.__pccShellInited = CHANNEL_NAME;

  /** @type {number} 请求-应答关联自增序号 */
  let seq = 0;
  /** @type {Map<string, {resolve: Function, reject: Function}>} 消息 id -> 在途请求 */
  const pending = new Map();

  /**
   * @param {unknown} e 异常
   * @returns {string} 可读原因
   */
  function why(e) {
    return String((e && e.message) || e);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__ns !== NS || msg.dir !== 'bridge->main') return;
    const entry = pending.get(msg.id);
    // id 不属于本壳（远程体自己的存储代理回执）直接放过，不干扰其 resolve/reject
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  });

  /**
   * 向 bridge 发一次请求并等回执；超时即 reject，绝不让启动链无限挂起。
   * @param {string} op 协议操作名
   * @param {object} [payload] 随请求带上的字段
   * @param {number} [timeoutMs] 等待上限
   * @returns {Promise<*>} bridge 回传的 result
   */
  function ask(op, payload, timeoutMs = ASK_TIMEOUT_MS) {
    const id = `${NS}-shell-${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout: ${op}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      window.postMessage({ __ns: NS, dir: 'main->bridge', id, op, ...payload }, '*');
    });
  }

  /**
   * 后台不等回信的单向通知（触发复检、上报执行失败）：失败只在控制台留一行，绝不影响已起的功能。
   * @param {string} cmd 后台命令名
   * @param {object} [extra] 附带参数
   */
  function tell(cmd, extra) {
    // 后台未应答属正常场景（SW 冷启动失败/上下文失效），故吞掉 reject；检查细节由 background 侧日志留痕
    ask('update-cmd', { cmd, ...extra }).catch(() => {});
  }

  /**
   * 取一份可执行文本。
   * @param {'ready'|'baseline'} prefer 取「本地最优」还是强制取包内基线
   * @returns {Promise<{text:string, ver:string, from:string}>}
   */
  function fetchBundle(prefer) {
    return ask('update-bundle', { prefer }).then((r) => {
      if (!r || !r.text) throw new Error(`empty bundle (${prefer})`);
      return r;
    });
  }

  /**
   * 交接信息：exec 前挂到 window，远程体只读它取「壳版本 / 运行来源」，不做任何闸门。
   * @param {{ver:string, from:string}} bundle 即将执行的包
   * @param {boolean} degraded 是否为降级执行的包内基线
   */
  function handOff(bundle, degraded) {
    window.__pccShell__ = Object.freeze({
      shellVer: revision(),
      ver: bundle.ver || '',
      from: bundle.from || 'none',
      degraded: !!degraded,
    });
  }

  /**
   * 执行远程体文本。游戏页 CSP 若禁 eval 类原语，这里当场抛错 → 由 run() 降级跑包内基线。
   * @param {string} text 包正文
   */
  function exec(text) {
    new Function(text)();
  }

  /**
   * 启动主流程：取本地最优 → 执行 → 触发后台复检；任一环节塌了都退到包内基线，保证功能总能起来。
   */
  function run() {
    fetchBundle('ready')
      .then((bundle) => {
        handOff(bundle, false);
        try {
          exec(bundle.text);
        } catch (e) {
          // 只有「什么都没跑起来」才值得再用基线试一次；已置位的启动标志说明远程体已生效，重试只会二次装配
          if (window.__pocketccInited) {
            console.warn('[pocketcc shell] remote threw after partial boot, keep as is', e);
            tell('check');
            return;
          }
          console.warn(
            '[pocketcc shell] remote exec failed, fall back to packaged baseline:',
            why(e),
          );
          tell('quarantine', { ver: bundle.ver, why: why(e) });
          return bootBaseline(true);
        }
        // 已就绪的远程体跑起来后补一次例行检查（非强制：靠 4h 闹钟与最小间隔自愈，不让刷新页面变成刷 OSS）
        tell('check');
        return undefined;
      })
      .catch((e) => {
        console.warn('[pocketcc shell] cannot get remote bundle from background:', why(e));
        return bootBaseline(false);
      });
  }

  /**
   * 降级路径：直接要包内基线（绕开缓存），跑成即算保住功能。
   * @param {boolean} afterExecFail 是否为「远程体执行抛错」后的降级
   */
  function bootBaseline(afterExecFail) {
    return fetchBundle('baseline')
      .then((base) => {
        handOff(base, true);
        exec(base.text);
        if (!afterExecFail) tell('check');
      })
      .catch((e) => {
        console.error('[pocketcc shell] baseline unusable, features did not start:', why(e));
      });
  }

  run();
})();
