/**
 * ACL 域切片 · 世界地图导航 + 难民营镜头抑制（core/acl/nav.js）
 * 原 core/game-api.js 的 nav/mapTodo/camGuard 区段，按域拆分片5逐字迁出（行为零变化）。
 * mapTodo 经 setSharedCapsProbe 注册给引擎 CAPS.navFly（引擎不反向 import 任何区段）；
 * camGuard 只在 feat 显式 install 后才包装游戏方法，模块求值期零副作用。
 */
import { game } from '../game.js';
import { createLog } from '../log.js';
import { SYM, probe, ns, setSharedCapsProbe } from '../acl-engine.js';

/** @type {ReturnType<createLog>} 沿用拆分前 tag=GAMEAPI，日志口径零漂移 */
const log = createLog('GAMEAPI');

// ─────────────────────── 世界地图导航 ───────────────────────

/** 跳转协调器（新旧地图双通道，首次探测后缓存句柄） */
function mapTodo() {
  return probe('mapTodo', () => {
    try {
      // 新图：NWorldMapCoreBiz.NWorldMapGoType + NWorldMapTodoController.instance
      var biz = game.get(SYM.modules.mapNewBiz);
      var G = biz && biz[SYM.newMap.goType];
      var cls = game.get(SYM.modules.mapNewCtrl);
      var C = cls && cls[SYM.newMap.cls];
      var inst = C && C[SYM.newMap.inst];
      if (G && inst && typeof inst.gotoWorldAndDo === 'function') return { inst: inst, G: G };
    } catch (e) {}
    try {
      // 旧图：WorldMapCommon.WorldMapToDoType + WorldMapTodoController.getInstance()
      var common = game.get(SYM.modules.mapOldCommon);
      var G2 = common && common[SYM.oldMap.todoType];
      var m2 = game.get(SYM.modules.mapOldCtrl);
      var i2 =
        m2 &&
        (typeof m2.getInstance === 'function'
          ? m2.getInstance()
          : m2.default && typeof m2.default.getInstance === 'function'
            ? m2.default.getInstance()
            : null);
      if (G2 && i2 && typeof i2.gotoWorldAndDo === 'function') return { inst: i2, G: G2 };
    } catch (e) {}
    return null;
  });
}

// mapTodo 住在共享区段：经引擎插槽注册给 CAPS.navFly，引擎不反向 import 本文件。
setSharedCapsProbe('navFly', () => mapTodo());

/**
 * 地图跳转能力。返回值统一 {ok:boolean, err?:string}，err 为技术语义键
 * （'unavailable'=协调器缺失 | 'failed'=执行异常 | 'nomarch'=该卡不支持直跳），文案归业务层。
 */
export const nav = {
  /** 坐标飞行：click=true 且有 JUMP_TO_TILE_CLICK → 飞完模拟点地块（弹城市弹窗），否则 MOVE_TO 只飞+标记。
   * opts 全字段兜底 s/k/z（新图读 k||s、旧图读 z），跨服服号放 z；子服号 subMap 有值才传
   * （新图 game2displayWithServerLimit(x,y,serverId,subMap) 跨服换算需要，缺省游戏回退本服子服）。
   * @param {{x:number, y:number, z:number|null, subMap?:number|null, click:boolean}} action
   * @returns {{ok:boolean, err?:string}}
   */
  flyTo(action) {
    var t = mapTodo();
    if (!t) return { ok: false, err: 'unavailable' };
    var A = SYM.mapActions;
    var type = action.click && t.G[A.tileClick] != null ? t.G[A.tileClick] : t.G[A.moveTo];
    if (type == null) return { ok: false, err: 'unavailable' };
    var opts = { x: action.x | 0, y: action.y | 0, mark: true };
    if (action.z != null) {
      opts.s = action.z;
      opts.k = action.z;
      opts.z = action.z;
    }
    if (action.subMap != null && action.subMap > 0) opts.subMap = action.subMap;
    try {
      t.inst.gotoWorldAndDo(type, opts);
      return { ok: true };
    } catch (e) {
      log.warn('flyTo(%s,%s) failed: %s', action.x, action.y, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
  /**
   * 行军/集结飞行：JUMP_TO_MARCH_CLICK {marchId,marchType}（游戏默认分支走通用协议 GET_MARCH_INFO_FOR_JUMP）。
   * @param {{marchId:*, marchType:*}} action
   * @returns {{ok:boolean, err?:string}}
   */
  flyMarch(action) {
    var t = mapTodo();
    if (!t) return { ok: false, err: 'unavailable' };
    if (!t.G[SYM.mapActions.marchClick] || action.marchId == null)
      return { ok: false, err: 'nomarch' };
    try {
      t.inst.gotoWorldAndDo(t.G[SYM.mapActions.marchClick], {
        marchId: action.marchId,
        marchType: action.marchType,
      });
      return { ok: true };
    } catch (e) {
      log.warn('flyMarch(%s) failed: %s', action.marchId, e && e.message);
      return { ok: false, err: 'failed' };
    }
  },
};

// ─────────────────── 难民营自动开营「镜头乱飞」抑制 ───────────────────

/**
 * 坐标命中式镜头抑制器（无时间窗口、不改写游戏数据，仅拦一处游戏 UI 相机副作用）。
 * 背景：游戏客户端在收到 10802「找到营地」推送的同步处理里，会自行把镜头 pan 到新营地
 *   （手动用求救信亦然）。auto-hunt 全程不含相机调用，连开多营时镜头反复甩动。
 * 原理：难民营玩法运行期间，把游戏两条已知「地图跳转」入口各包一层——跳转协调器
 *   gotoWorldAndDo(type,opts{x,y}) 与消息总线 WorldMapMsgs.send(Names.WorldMapJumpToTile,{x,y})；
 *   仅当一次跳转的目标坐标命中「本轮由我方自动开营刚拿到的落点」时才吞掉那一次。落点坐标
 *   由 net 的「抢在原生处理器之前」观察点（见 core/net.js onPreInbound）在 orig 前登记，确保赶在
 *   游戏发起镜头跳转之前入表——故判定与时刻无关、无竞态；玩家手动点营地/聊天坐标跳转不在表内、照常飞。
 * @type {object}
 */
const camGuard = {
  /** @type {boolean} 是否已成功装载（幂等标志） */
  installed: false,
  /** @type {Array<string>} 待吞跳转坐标键 'x,y'（自动开营落点，FIFO 有界，命中即删） */
  pending: [],
  /** @type {Array<{obj:object, key:string, orig:Function}>} 已包装入口的还原信息 */
  hooks: [],
};
/** @type {number} pending 容量上限：防某营地跳转始终未发生时无界增长（超出丢最旧） */
const CAM_GUARD_PENDING_MAX = 32;

/** 包一个对象方法：命中 pending 坐标即吞掉该次调用（返回 undefined）；已包过则跳过。 */
function camGuardWrap(obj, key, readXY) {
  if (!obj || typeof obj[key] !== 'function' || obj[key].__pcCamGuard) return false;
  var orig = obj[key];
  var wrapped = function () {
    var xy = readXY(arguments);
    if (xy) {
      var k = (xy.x | 0) + ',' + (xy.y | 0);
      var i = camGuard.pending.indexOf(k);
      if (i >= 0) {
        camGuard.pending.splice(i, 1);
        return undefined; // 命中本轮自动开营落点：静默吞掉这一次镜头跳转
      }
    }
    return orig.apply(this, arguments);
  };
  wrapped.__pcCamGuard = true;
  obj[key] = wrapped;
  camGuard.hooks.push({ obj: obj, key: key, orig: orig });
  return true;
}

/**
 * 装载抑制器（幂等）：包住两条跳转入口。控制器实例尚未就绪（不在世界图）时不置 installed，下次可重试。
 * @returns {boolean} 是否已就绪
 */
function camGuardInstall() {
  if (camGuard.installed) return true;
  var mounted = 0;
  var t = mapTodo();
  if (t && t.inst) {
    if (
      camGuardWrap(t.inst, 'gotoWorldAndDo', function (args) {
        var o = args[1];
        return o && o.x != null && o.y != null ? { x: o.x, y: o.y } : null;
      })
    )
      mounted++;
  }
  try {
    var WMM = ns(game.get(SYM.modules.worldMapMsgs));
    var jumpVal = WMM && WMM.Names && WMM.Names[SYM.mapMsgs.jumpToTile];
    if (WMM && typeof WMM.send === 'function' && jumpVal != null) {
      if (
        camGuardWrap(WMM, 'send', function (args) {
          if (args[0] !== jumpVal) return null; // 只拦「镜头跳到地块」，别的消息一律放行
          var p = args[1];
          return p && p.x != null && p.y != null ? { x: p.x | 0, y: p.y | 0 } : null;
        })
      )
        mounted++;
    }
  } catch (e) {}
  if (mounted > 0) camGuard.installed = true;
  return camGuard.installed;
}

/** 卸载抑制器：还原所有被包方法并清空待吞坐标。 */
function camGuardUninstall() {
  for (var i = 0; i < camGuard.hooks.length; i++) {
    var h = camGuard.hooks[i];
    try {
      h.obj[h.key] = h.orig;
    } catch (e) {}
  }
  camGuard.hooks = [];
  camGuard.pending = [];
  camGuard.installed = false;
}

/** 登记一个「本轮自动开营落点」坐标，令下一次飞向它的镜头跳转被吞掉。 */
function camGuardArm(x, y) {
  if (x == null || y == null) return;
  var k = (x | 0) + ',' + (y | 0);
  var i = camGuard.pending.indexOf(k);
  if (i >= 0) camGuard.pending.splice(i, 1);
  camGuard.pending.push(k);
  if (camGuard.pending.length > CAM_GUARD_PENDING_MAX) camGuard.pending.shift();
}

/**
 * 难民营镜头抑制对外能力（挂在 nav 上，供 auto-hunt 随玩法开关装/摘）。
 * @type {object}
 */
nav.camGuard = {
  /** 装载抑制器（幂等）。@returns {boolean} 是否已就绪 */
  install: camGuardInstall,
  /** 卸载抑制器，还原游戏方法。 */
  uninstall: camGuardUninstall,
  /** 登记一个待吞的自动开营落点坐标。@param {number} x @param {number} y */
  arm: camGuardArm,
};
