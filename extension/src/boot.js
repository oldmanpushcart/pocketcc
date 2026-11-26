// 口袋控制中心 — 远程体内的 MAIN world 编排器（薄壳 shell.js exec 远程体后由本文件装配生命周期）。
// 运行在页面自身 JS 上下文，可访问 cc / __require / CryptoJS 等游戏全局。
//
// 本文件只剩编排：按 cocos 引擎/场景就绪时机，串起各 core 模块。
//   core/registry.js   特征注册表（面板 UI + 存储 + 运行时编排单一真相）
//   core/auto-login.js 免扫码登录（token 缓存重放）
//   core/session.js    自动重连 + 活性监视 + 会话健康事件
//   core/ui/           浮动图标 + 手风琴面板（index.js 编排 mountUI）
//   core/scene-watcher 场景信号 → reactor 门控
// 功能模块（net.js + feats/<层级>/*.js）由 remote.entry.js 先于本文件加载并各自向 reactor 注册说明书，
// 面板层级由 core/menu.js 声明；本文件在主城就绪（HomeMapLoadFinish 或首次进入 Home/NWorldMap 场景，先到先触发）
// 后经 registry.startFeatures() 推配置起停。
// 另有 anti-throttle.js（document_start 入口）在隐藏标签页里接管 rAF/定时器并伪装可见性，
// 主城就绪闸门里由本文件降为常驻档，常驻与否由面板「后台保活」（configs.keepAlive）定。
import { createLog } from './core/log.js';
import { game } from './core/game.js';
import { bus, EVT } from './core/bus.js';
import {
  loadAllConfigs,
  startFeatures,
  migrateLegacyKeys,
  dropOrphanDataKeys,
} from './core/registry.js';
import { startPlayerWatch, waitUid } from './core/player.js';
import { installAutoLogin } from './core/auto-login.js';
import { installReconnectHooks, installLaunchWatchdog, watchLoginSuccess } from './core/session.js';
import { mountUI } from './core/ui/index.js';
import { showWelcome } from './core/ui/welcome.js';
import { revision } from './core/update.js';
import { installUpdateMirror, runSource } from './core/update-client.js';
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
   * 功能主控闸门：主城就绪放行，双路信号先到先触发（幂等只放行一次）：
   *   1) HomeMapLoadFinish 事件——常规启动，主城地图加载完成；
   *   2) scene.change 且场景为 Home/NWorldMap——重启直落世界地图等不触发 HomeMapLoadFinish 的场景。
   * 事件走 pocketcc.event 封装（on 内部会兜底 install，早于 startFeatures 也安全），
   * 场景走 bus（startSceneWatcher 已在本闸门调用前挂上）。
   * 事件名是 EventId 的值（字符串 "HomeMapLoadFinish"）。2026-09-22 真机已验证触发。
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
    offScene = bus.on(EVT.SCENE_CHANGE, onSceneChange);
    // 兜底自检：start 时可能已身处就绪场景（scene.change 已在订阅前广播过），补判一次当前场景
    onSceneChange({ name: getCurrentScene() });
  }

  /**
   * 启动：等 cocos 引擎与场景就绪后再安装 hook、监听、挂载 UI。
   * 配置按 UID 隔离：先等 UID 就绪（超时降级用默认配置，不阻断自动重连），
   * 首个 UID 确定时把旧全局键迁入命名空间，再读盘填充 configs。
   * 主城就绪后起功能与面板，并顺带弹一次署名欢迎页（只告知、不闸门：点不点都不影响启动）。
   */
  function start() {
    installUpdateMirror();
    startSceneWatcher();
    installModeGate();
    installAutoLogin();
    startPlayerWatch();
    configsReady = Promise.resolve()
      .then(() => waitUid())
      .then((uid) => {
        // uid 为 null 也要继续读盘：registry 检测 ns 未设时落默认配置并置 degraded，player.ready 后补读盘。
        // 场景口径告知降级性质：还停在登录/启动场景（未扫码）是常态走 info；已进过主城却拿不到 UID 才是 warn。
        const preLogin = READY_SCENES.indexOf(getCurrentScene()) === -1;
        return (
          Promise.resolve(uid ? migrateLegacyKeys(uid) : undefined)
            .then(() => loadAllConfigs({ preLogin: preLogin }))
            // 孤儿数据键清理排在读盘之后：只在 UID 拿得到时跑（命名空间未设时删不到目标键）
            .then(() => (uid ? dropOrphanDataKeys() : undefined))
        );
      })
      .then(() => {
        installReconnectHooks();
        installLaunchWatchdog();
      });
    watchLoginSuccess();
    watchHomeMapReady(() => {
      // 主城就绪：加载期专用的 60Hz 满速驱动到此为止，先降为常驻档兜底（配置未读到也收得住）；
      // 真正「常驻还是彻底交还」由 configs.keepAlive 决定，registry.startFeatures 里 internal apply 随后精确落位
      if (window.pocketccAntiThrottle) window.pocketccAntiThrottle.downshift();
      configsReady.then(() => {
        startFeatures();
        mountUI();
        // 欢迎页只同步挂载，不进启动链：等它的那份 promise 由用户的手速决定，不该压在功能与面板之前
        showWelcome();
      });
    });
    // 运行来源由壳交接（缓存远程体 / 包内基线 / 降级），真机排障时先看这一行再下结论
    const src = runSource();
    logCore.info(
      'initialized, rev %s (bundle v%s from %s%s, shell v%s)',
      revision(),
      src.ver || '?',
      src.from,
      src.degraded ? ', degraded to packaged baseline' : '',
      src.shellVer || '?',
    );
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
