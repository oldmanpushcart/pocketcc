/**
 * pocketcc.core.homeSnap —— HomeMap 组件离场景快照（侵入式游戏钩子，秘密武器空投 world 支持专用）
 *
 * 背景：游戏原生选点 HomeMap.findValidAirDropBoxArea 是 HomeMap 组件实例方法，组件离开 Home 即 cpnDestroy 置 null，
 *   world 里拿不到活组件 → 无法原生选点。自研复刻选点已被真机证伪（46 发零建箱，见 secret-weapon-drop 头注「投放建箱根因演进」）。
 * 方案（竞品A/B 已验证同款）：钩 HomeMap.prototype.onSceneEnded，在离开 Home 销毁前一刻把整个组件实例克隆冻结成快照，
 *   world 里对快照调原生 findValidAirDropBoxArea。选点链自包含在 this（BuildingItems/_homeLagCache/mapNode）+ 全局表/静态工具，
 *   不读 UIManager 门面，故无需改门面（比竞品少一步侵入）。快照保留原型方法 + 占用数组深拷 + 伪造 camera（保 zoomRatio 与离开时位置，
 *   原生选点锚视口中心经 convertToContainerPosition 依赖 camera/mapNode 变换）。
 * 侵入性声明（用户 2026-11-16 明确接受）：本模块 monkey-patch 游戏 HomeMap.prototype.onSceneEnded（只读克隆后调原版，不改游戏数据态），
 *   是 pocketcc「只读+发包」纪律的显式例外，仅限本用途；钩子幂等安装一次，不随 feat pause 卸载。
 * 时效边界：快照冻结于离开 Home 一刻，不追踪其后 10101/10109 占用变化（主城占用在 world 期间基本稳定，空投选点足够）。
 */
import { game } from './game.js';
import { createAcl } from './acl-engine.js';

const { ns, SYM, log } = createAcl('HOMESNAP');

/** @type {object|null} 离开 Home 时克隆冻结的 HomeMap 组件快照（world 选点用）；从未离开过 Home/钩子未装则 null */
var snap = null;
/** @type {boolean} onSceneEnded 钩子是否已安装（幂等，模块单例生命周期内只装一次） */
var hooked = false;

/**
 * 取当前 HomeMap 快照（world 里活组件缺失时的原生选点回退）。
 * @returns {object|null} 克隆的 HomeMap 实例（保留 findValidAirDropBoxArea 等原型方法）；无快照返回 null
 */
export function homeSnap() {
  return snap;
}

/**
 * 从活 HomeMap 实例克隆一份快照（竞品配方：Object.assign 新实例拷全量状态 + 占用数组深拷 + 伪造 camera）。
 * @param {object} live 活 HomeMap 组件实例
 * @returns {object|null} 快照实例；HomeMap 类缺失/live 为空返回 null
 */
function cloneFrom(live) {
  var HM = ns(game.get(SYM.modules.homeMap));
  if (!HM || !live) return null;
  var cam = live.camera;
  var camPos =
    cam && cam.node && typeof cam.node.getPosition === 'function' ? cam.node.getPosition() : null;
  var s = Object.assign(new HM(), live);
  if (Array.isArray(live.BuildingItems)) s.BuildingItems = live.BuildingItems.concat();
  if (Array.isArray(live.ObstacleItems)) s.ObstacleItems = live.ObstacleItems.concat();
  if (live.buildingItemsMap instanceof Map)
    s.buildingItemsMap = new Map(live.buildingItemsMap.entries());
  if (camPos) {
    s.camera = {
      zoomRatio: cam.zoomRatio,
      node: {
        getPosition: function () {
          return camPos;
        },
      },
    };
  }
  return s;
}

/**
 * 幂等安装 onSceneEnded 克隆钩子。HomeMap 类未加载（尚未进过 Home）返回 false，调用方下次激活重试。
 * 安装时若活组件在场（正在 Home），立即预克隆一份，免等首次离开 Home 才有快照。
 * @returns {boolean} 钩子是否已就位
 */
export function installHomeSnap() {
  if (hooked) return true;
  var HM = ns(game.get(SYM.modules.homeMap));
  if (!HM || !HM.prototype || typeof HM.prototype.onSceneEnded !== 'function') {
    log.debug(
      'installHomeSnap: HomeMap class/onSceneEnded unavailable (not entered Home yet), retry later.',
    );
    return false;
  }
  var orig = HM.prototype.onSceneEnded;
  HM.prototype.onSceneEnded = function () {
    try {
      var c = cloneFrom(this);
      if (c) {
        snap = c;
        log.debug(
          'HomeSnap captured at onSceneEnded. buildings=%d',
          (c.BuildingItems || []).length,
        );
      }
    } catch (e) {
      log.warn('HomeSnap clone threw: %s', e && (e.message || e));
    }
    return orig.apply(this, arguments);
  };
  hooked = true;
  log.info('HomeSnap hook installed (onSceneEnded clone enables world airdrop).');
  // 正在 Home：立即预克隆，免等首次离开（覆盖「在 Home 启用 feat 后立刻切 world」与「world 启用但 HomeMap 已缓存」两态）
  try {
    var UM = ns(game.get(SYM.modules.uiManager));
    var live = UM && typeof UM.Instance === 'function' ? UM.Instance().HomeMap : null;
    if (live) {
      var c0 = cloneFrom(live);
      if (c0) {
        snap = c0;
        log.debug(
          'HomeSnap pre-captured from live HomeMap. buildings=%d',
          (c0.BuildingItems || []).length,
        );
      }
    }
  } catch (e) {
    log.debug('HomeSnap pre-capture skipped: %s', e && (e.message || e));
  }
  return true;
}
