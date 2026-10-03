// 口袋控制中心 — MAIN world 入口 / 编排器。
// 运行在页面自身 JS 上下文，可访问 cc / __require / CryptoJS 等游戏全局。
// 设计依据见 references/免扫码登录技术方案.md。
//
// 本文件只剩编排：按 cocos 引擎/场景就绪时机，串起各 core 模块。
//   core/registry.js   特征注册表（面板 UI + 存储 + 运行时编排单一真相）
//   core/auto-login.js 免扫码登录（token 缓存重放）
//   core/session.js    自动重连 + 活性监视 + 会话健康事件
//   core/ui.js         浮动图标 + 手风琴面板
//   core/scene-watcher 场景信号 → reactor 门控
// 功能模块（net.js + feats/<层级>/*.js）由 content.entry.js 先于本文件加载并各自向 reactor 注册说明书，
// 面板层级由 core/menu.js 声明；本文件在主城就绪（HomeMapLoadFinish 或首次进入 Home/NWorldMap 场景，先到先触发）
// 后经 registry.startFeatures() 推配置起停。
import { createLog } from './core/log.js';
import { game } from './core/game.js';
import { bus } from './core/bus.js';
import { loadAllConfigs, startFeatures, migrateLegacyKeys } from './core/registry.js';
import { startPlayerWatch, waitUid } from './core/player.js';
import { installAutoLogin } from './core/auto-login.js';
import { installReconnectHooks, watchLoginSuccess } from './core/session.js';
import { mountUI } from './core/ui.js';
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
   */
  function start() {
    startSceneWatcher();
    installModeGate();
    installAutoLogin();
    startPlayerWatch();
    configsReady = waitUid()
      .then((uid) => (uid ? migrateLegacyKeys(uid) : undefined))
      .then(() => loadAllConfigs())
      .then(() => installReconnectHooks());
    watchLoginSuccess();
    watchHomeMapReady(() => { configsReady.then(() => { startFeatures(); mountUI(); }); });
    logCore.info('initialized');
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
