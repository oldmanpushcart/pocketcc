/**
 * ACL 域切片 · 场景切换 Home ↔ 大世界（core/acl/scene.js）
 * 原 core/game-api.js 的 scene 区段，按域拆分片3逐字迁出（行为零变化）。
 * 走游戏原生 ProcedureManager（PROCE.Run），与主界面「世界/回城」按钮同一条路径。
 */
import { createLog } from '../log.js';
import { SYM, proce } from '../acl-engine.js';

/** @type {ReturnType<createLog>} 沿用拆分前 tag=GAMEAPI，日志口径零漂移 */
const log = createLog('GAMEAPI');

// ─────────────────────── 场景切换 / 原生 UI 面板 ───────────────────────

/**
 * 场景切换能力：基地城市(Home) ↔ 大世界(NWorldMap)，走游戏原生 ProcedureManager（PROCE.Run），
 * 与主界面「世界 / 回城」按钮同一条路径。只触发原生切换，不改写游戏数据（只读+调用红线）。
 * 对外只暴露 scene.name() 与互切 toggleHomeWorld()；单切不单独暴露（热键只用互切，
 * 回城类需求走 nav.flyTo 坐标飞行，语义不同）。
 */
/** 切到 Home 场景（内部） */
function goHomeScene() {
  var p = proce();
  if (!p || !p[SYM.procedures.home]) return { ok: false, err: 'unavailable' };
  try {
    p.Run(p[SYM.procedures.home]);
    return { ok: true };
  } catch (e) {
    log.warn('goHome failed: %s', e && e.message);
    return { ok: false, err: 'failed' };
  }
}

/** 切到 NWorldMap 场景（内部） */
function goWorldScene() {
  var p = proce();
  if (!p || !p[SYM.procedures.newWorld]) return { ok: false, err: 'unavailable' };
  try {
    p.Run(p[SYM.procedures.newWorld]);
    return { ok: true };
  } catch (e) {
    log.warn('goWorld failed: %s', e && e.message);
    return { ok: false, err: 'failed' };
  }
}

export const scene = {
  /** 当前场景节点名（cc.director.getScene().name）；引擎未就绪返回 '' */
  name() {
    try {
      var s = cc.director.getScene();
      return (s && s.name) || '';
    } catch (e) {
      return '';
    }
  },
  /** 基地↔大世界互切：按当前场景决定去向（走内部 goHomeScene/goWorldScene）；两者之外的场景不处理（返回 wrongscene） */
  toggleHomeWorld() {
    var cur = this.name();
    if (cur === SYM.sceneNames.newWorld) return goHomeScene();
    if (cur === SYM.sceneNames.home) return goWorldScene();
    return { ok: false, err: 'wrongscene', scene: cur };
  },
};
