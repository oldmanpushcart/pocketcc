import { createLog } from './log.js';
import { bus } from './bus.js';
import { reactor } from './reactor.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=SCENE） */
const log = createLog('SCENE');

/** @type {string|null} 当前场景名；引擎尚未就绪时为 null。门控闭包直接读它 */
let current = null;
/** @type {boolean} 监听与门控是否已挂（幂等标志） */
let started = false;

/**
 * 场景启动后回调：读新场景名，变化则广播 scene.change（reactor 据此重算门控）
 */
function onLaunch() {
  const scene = cc.director.getScene();
  const name = (scene && scene.name) || '';
  if (name === current) return;
  current = name;
  log.info('scene: %s', name);
  bus.emit('scene.change', { name: name });
}

/**
 * 挂场景监听 + 注册 scene 门控 + 补一次当前场景。幂等：重复调用只生效一次。
 * cc.Director.EVENT_AFTER_SCENE_LAUNCH 的可用性已由 boot.js deferInit 真机验证。
 */
export function startSceneWatcher() {
  if (started) return;
  started = true;
  cc.director.on(cc.Director.EVENT_AFTER_SCENE_LAUNCH, onLaunch);
  // 功能声明了 scenes 才校验；未声明（或空）默认放行。
  reactor.registerGate({
    id: 'scene',
    /**
     * scene 门控判定
     * @param {object} spec 功能注册说明书
     * @returns {boolean} 是否放行
     */
    ok: function (spec) {
      return !spec.scenes || !spec.scenes.length || spec.scenes.indexOf(current) !== -1;
    },
  });
  onLaunch();
}

/**
 * 当前场景名
 * @returns {string|null} 未就绪为 null
 */
export function getCurrentScene() {
  return current;
}
