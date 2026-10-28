// 口袋控制中心 — MAIN world 入口 / 编排器。
// 运行在页面自身 JS 上下文，可访问 cc / __require / CryptoJS 等游戏全局。
// 设计依据见 references/免扫码登录技术方案.md。
//
// 本文件只剩编排：按 cocos 引擎/场景就绪时机，串起各 core 模块。
//   core/registry.js   特征注册表（面板 UI + 存储 + 运行时编排单一真相）
//   core/auto-login.js 免扫码登录（token 缓存重放）
//   core/session.js    自动重连 + 活性监视 + 会话健康事件
//   core/ui/           浮动图标 + 手风琴面板（index.js 编排 mountUI）
//   core/scene-watcher 场景信号 → reactor 门控
// 功能模块（net.js + feats/<层级>/*.js）由 content.entry.js 先于本文件加载并各自向 reactor 注册说明书，
// 面板层级由 core/menu.js 声明；本文件在主城就绪（HomeMapLoadFinish 或首次进入 Home/NWorldMap 场景，先到先触发）
// 后经 registry.startFeatures() 推配置起停。
// 另有 anti-throttle.js（document_start 入口）在隐藏标签页里接管 rAF/定时器并伪装可见性，
// 主城就绪闸门里由本文件降为常驻档，常驻与否由面板「后台保活」（configs.keepAlive）定；
// 授权被拒/降级这两条不 startFeatures、不 mountUI 的链路上，面板开关无从生效，由 antiThrottleOff() 直接交还原生。
import { createLog } from './core/log.js';
import { game } from './core/game.js';
import { bus } from './core/bus.js';
import { NS } from './core/constants.js';
import { loadAllConfigs, startFeatures, migrateLegacyKeys } from './core/registry.js';
import { startPlayerWatch, waitUid } from './core/player.js';
import { installAutoLogin } from './core/auto-login.js';
import { installReconnectHooks, installLaunchWatchdog, watchLoginSuccess } from './core/session.js';
import { mountUI } from './core/ui/index.js';
import { showWelcome } from './core/ui/welcome.js';
import { screen, slotFree, revision } from './core/net-guard.js';
import { startSceneWatcher, getCurrentScene } from './core/scene-watcher.js';
import { installModeGate } from './core/mode.js';

(() => {
  if (window.__pocketccInited) return;
  window.__pocketccInited = true;

  /** @type {ReturnType<createLog>} 启动编排日志器（tag=CORE） */
  const logCore = createLog('CORE');

  /** @type {Promise<void>} 配置读盘完成的 promise（主城门控放行后据此推功能配置） */
  let configsReady = Promise.resolve();

  /** @type {string[]} 视为「主城就绪」的场景名：重启直落世界地图时不会触发 HomeMapLoadFinish，靠场景信号兜底 */
  const READY_SCENES = ['Home', 'NWorldMap'];

  /**
   * 撤除反节流：交还原生 rAF/定时器并恢复真实可见性（applyPolicy(false) 幂等）。
   * 与 downshift() 的区别：降频只是把满速驱动收为常驻档，撤防才真正把可见性伪装摘掉。
   */
  function antiThrottleOff() {
    const at = window.pocketccAntiThrottle;
    if (at) at.applyPolicy(false);
  }

  /**
   * 功能主控闸门：主城就绪放行，双路信号先到先触发（幂等只放行一次）：
   *   1) HomeMapLoadFinish 事件——常规启动，主城地图加载完成；
   *   2) scene.change 且场景为 Home/NWorldMap——重启直落世界地图等不触发 HomeMapLoadFinish 的场景。
   * 事件走 pocketcc.event 封装（on 内部会兜底 install，早于 startFeatures 也安全），
   * 场景走 bus（startSceneWatcher 已在本闸门调用前挂上）。
   * 事件名是 EventId 的值（字符串 "HomeMapLoadFinish"，EventId.js:732）。2026-09-22 真机已验证触发。
   * deferInit 在首个场景首个子节点加入时即 start()，远早于主城加载，一次性事件不会错过。
   * 这是文档里承认的“框架级长订阅”例外：只此一条、跟页面同生命周期；就绪后主动退订场景信号，事件路留幂等标志。
   * @param {function():void} onReady 主城就绪回调（只放行一次）
   */
  function watchHomeMapReady(onReady) {
    let fired = false;
    /** 就绪放行：置幂等标志，摘掉 scene.change 兜底订阅 */
    const fire = () => {
      if (fired) return;
      fired = true;
      offScene();
      onReady();
    };
    /** @type {Function|null} scene.change 退订句柄 */
    let offScene = () => {};
    const EventId = game.get('EventId').EventId;
    const event = window.pocketcc && window.pocketcc.event;
    if (!event) {
      logCore.warn('pocketcc.event unavailable, home map gate not installed.');
    } else {
      event.on(EventId.HomeMapLoadFinish, () => {
        if (fired) return;
        logCore.info('HomeMapLoadFinish captured');
        fire();
      });
    }
    const onSceneChange = ({ name }) => {
      if (fired || READY_SCENES.indexOf(name) === -1) return;
      logCore.info('ready via scene: %s', name);
      fire();
    };
    offScene = bus.on('scene.change', onSceneChange);
    // 兜底自检：start 时可能已身处就绪场景（scene.change 已在订阅前广播过），补判一次当前场景
    onSceneChange({ name: getCurrentScene() });
  }

  /**
   * 启动：等 cocos 引擎与场景就绪后再安装 hook、监听、挂载 UI。
   * 配置按 UID 隔离：先等 UID 就绪（超时降级用默认配置，不阻断自动重连），
   * 首个 UID 确定时把旧全局键迁入命名空间，再读盘填充 configs。
   * 准入闸门（仅授权包生效）：UID 到手先过 screen 比对——不设限包恒真，dev 零变化；
   * 不符则只弹告知页，后续配置/功能/重连全不拉起；通屏则等主城就绪弹问候页，
   * 用户点「进入使用」后才继续（时序位置与现链路一致，满足「游戏正式加载后展示」）。
   */
  function start() {
    startSceneWatcher();
    installModeGate();
    installAutoLogin();
    startPlayerWatch();
    /** @type {string|null} 本轮启动定屏的登录 UID（问候页展示用） */
    let bootUid = null;
    configsReady = Promise.resolve()
      .then(() => waitUid())
      .then((uid) => {
        bootUid = uid;
        if (uid && !screen(uid)) {
          logCore.info('greet: withheld (rev %s)', revision());
          showWelcome('fail', uid);
          // 阻断：返回永不 settle 的链——不迁移/不读盘/不装重连钩子，主城放行侧同样挂在此链上，功能全停
          // 反节流同步撤防：后台保活是扩展赋予的增值行为，未授权不享受；
          //   且此链上 mountUI 不执行，面板开关永无机会生效，不主动摘就只能靠刷新页面恢复
          antiThrottleOff();
          return new Promise(() => {});
        }
        if (!uid && !slotFree()) {
          // 授权包降级态（登录卡死取不到 UID）：无从比对，同样挂起链不拉功能（与旧降级仍跑自动重连不同，授权优先）
          logCore.info('greet: silent (no uid to match, rev %s)', revision());
          antiThrottleOff();
          return new Promise(() => {});
        }
        handOffBridge(uid); // 先放行 bridge 存储代理，再升配置读写
        // uid 为 null 也要继续读盘（无限制包 slotFree 不走上面的挂起闸）：registry 检测 ns 未设时
        // 落默认配置并置 degraded，player.ready 后补读盘。空分支须用 Promise 兜住，否则 .then 崩整条启动链。
        // 场景口径告知降级性质：还停在登录/启动场景（未扫码）是常态走 info；已进过主城却拿不到 UID 才是 warn。
        const preLogin = READY_SCENES.indexOf(getCurrentScene()) === -1;
        return Promise.resolve(uid ? migrateLegacyKeys(uid) : undefined).then(() =>
          loadAllConfigs({ preLogin: preLogin }),
        );
      })
      .then(() => {
        installReconnectHooks();
        installLaunchWatchdog();
      });
    watchLoginSuccess();
    watchHomeMapReady(() => {
      // 主城就绪：加载期专用的 60Hz 满速驱动到此为止，先降为常驻档兜底（授权挂起/配置未读到也收得住）；
      // 真正「常驻还是彻底交还」由 configs.keepAlive 决定，registry.startFeatures 里 internal apply 随后精确落位
      if (window.pocketccAntiThrottle) window.pocketccAntiThrottle.downshift();
      configsReady
        .then(() => greet(bootUid))
        .then(() => {
          startFeatures();
          mountUI();
        });
    });
    logCore.info('initialized, rev %s', revision());
  }

  /**
   * 主城就绪后的问候页：仅授权包且 UID 已定屏时弹；
   * 不设限包/登录卡死降级态（UID 未取到）直接放行，不打扰流程。
   * @param {string|null} uid 登录 UID
   * @returns {Promise<void>}
   */
  function greet(uid) {
    if (slotFree() || !uid) return Promise.resolve();
    return showWelcome('ok', uid);
  }

  /**
   * 把准入态同步给隔离世界的存储代理（bridge）：授权包读盘完成后夹带一次 uid，
   * bridge 用自己 bundle 里的同源哨独立复验（不信任本侧断言），此后才代读写存储。
   * 不设限包不发（bridge 侧构建期已标记不设限，零消息）。
   * @param {string|null} uid 登录 UID
   */
  function handOffBridge(uid) {
    if (slotFree() || !uid) return;
    try {
      window.postMessage({ __ns: NS, dir: 'main->bridge', op: 'hello', uid: String(uid) }, '*');
    } catch (e) {} // bridge 未就位（上下文失效等）：静默，存储侧自会因未放行而拒绝服务
  }

  /**
   * 等引擎就绪：cc 未出现则挂 load 重试；场景已有则等首个子节点加入（CHILD_ADDED），
   * 否则等 EVENT_AFTER_SCENE_LAUNCH 后重新自查。真机验证的 cocos 启动时机唯一可靠写法。
   */
  function deferInit() {
    if (!window.cc) {
      window.addEventListener('load', deferInit);
      return;
    }
    if (cc.director._scene) {
      cc.director._scene.once(cc.Node.EventType.CHILD_ADDED, start);
    } else {
      cc.director.once(cc.Director.EVENT_AFTER_SCENE_LAUNCH, deferInit);
    }
  }

  deferInit();
})();
