/**
 * 沙盘演习领域 ACL：只开放真实 UI 初始化/开战入口与面板状态，不自行构造军队、英雄或阵型。
 * 载荷由 ArenaTablePvePanel.onChanllengeClick → NBattleEmPanelNew.StartFight →
 * RealNBattleModel.start_ARENA_PVE_BATTLE 的原生链路生成；本层不读写 UserData 候选池。
 */
import { game } from '../../../core/game.js';
import { createAcl } from '../../../core/acl-engine.js';

const { ns, SYM, log, registerCaps } = createAcl('SANDBOXDOM');

const MOD = {
  arenaPanel: 'ArenaTablePvePanel',
  battlePanel: 'NBattleEmPanelNew',
  battleModel: 'NBattleModel',
  realBattleModel: 'RealNBattleModel',
  battleData: 'BattleData',
};

registerCaps({
  sandboxArena: () =>
    !!game.get(MOD.arenaPanel) && !!(game.get(MOD.battlePanel) || game.get('BattleEmPanel')),
  sandboxModel: () =>
    !!(game.get(MOD.battleModel) || game.get(MOD.realBattleModel)) && !!game.get(MOD.battleData),
});

/** @returns {object|null} UIManager 实例 */
function manager() {
  var UM = ns(game.get(SYM.modules.uiManager));
  return UM && typeof UM.Instance === 'function' ? UM.Instance() : null;
}

/**
 * @param {object} mgr UIManager
 * @param {string} name DataPool 运行时面板名
 * @param {string} method 目标组件方法
 * @returns {object|null}
 */
function component(mgr, name, method) {
  var node = mgr && mgr.DataPool && mgr.DataPool[name];
  var list = node && (node._components || node.components);
  if (!Array.isArray(list)) return null;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && typeof list[i][method] === 'function') return list[i];
  }
  return null;
}

/**
 * @param {object} mgr UIManager
 * @param {object} reg UIDataInfo
 * @param {string} member 注册表成员名
 * @returns {boolean}
 */
function closeOpen(mgr, reg, member) {
  var info = reg && reg[member];
  if (!info || !mgr || !mgr.DataPool || mgr.DataPool[info.name] == null) return false;
  mgr.CloseUI(info);
  return true;
}

export const sandboxArena = {
  /**
   * 打开真实沙盘面板；已在场则复用原组件，避免重复 OpenUI 重置页面状态。
   * @param {object} info 1661 V1 应答的原始业务体
   * @returns {{ok:boolean,reason?:string}}
   */
  open(info) {
    try {
      var mgr = manager();
      if (!mgr) return { ok: false, reason: 'ui-manager-unavailable' };
      var panel = component(mgr, 'ArenaTablePvePanelV1', 'onChanllengeClick');
      if (!panel) {
        var U = ns(game.get(SYM.modules.uiDataInfo));
        var desc = U && U.UIDataInfo && U.UIDataInfo.NArenaTablePvePanel;
        if (!desc || typeof mgr.OpenUI !== 'function') {
          return { ok: false, reason: 'sandbox-panel-unavailable' };
        }
        mgr.OpenUI(desc, info);
      }
      return { ok: true };
    } catch (e) {
      log.warn('sandbox open threw: %s', e && e.message);
      return { ok: false, reason: 'open-threw' };
    }
  },
  /**
   * 调用面板真实挑战处理器，让游戏保存当前沙盘军队/英雄并打开战斗准备。
   * @returns {{ok:boolean,reason?:string}}
   */
  prepare() {
    try {
      var mgr = manager();
      var panel = component(mgr, 'ArenaTablePvePanelV1', 'onChanllengeClick');
      if (!panel) return { ok: false, reason: 'sandbox-panel-not-ready' };
      panel.onChanllengeClick();
      return { ok: true };
    } catch (e) {
      log.warn('sandbox prepare threw: %s', e && e.message);
      return { ok: false, reason: 'prepare-threw' };
    }
  },
  /**
   * 确认当前确为 ARENA_PVE_BATTLE 且真实模型已有 attackers，再调用原生 StartFight。
   * challenge=1（无尽挑战）明确拒绝；不放过陷阱确认弹窗，不修改任何阵容。
   * @returns {{ok:boolean,reason?:string}}
   */
  start() {
    try {
      var B = ns(game.get(MOD.battleData));
      var expected = B && B.BattleType && B.BattleType.ARENA_PVE_BATTLE;
      var DC = game.get(SYM.modules.dataCenter);
      var cur = DC && DC.DATA && DC.DATA.CurBattleData;
      if (expected == null || !cur || cur.Type !== expected) {
        return { ok: false, reason: 'not-arena-pve-battle' };
      }
      if (cur.otherData && Number(cur.otherData.challenge) === 1) {
        return { ok: false, reason: 'endless-challenge-refused' };
      }
      var M = ns(game.get(MOD.battleModel) || game.get(MOD.realBattleModel));
      var model = M && M.instance;
      if (!model || !Array.isArray(model.attackers) || model.attackers.length === 0) {
        return { ok: false, reason: 'real-attackers-unavailable' };
      }
      // 原生 StartFight 会为陷阱弹确认框；自动化不代替用户确认。先验拒绝，避免“按钮已调但请求永不来”。
      if (!Array.isArray(model.attackerTraps)) {
        return { ok: false, reason: 'trap-state-unavailable' };
      }
      if (model.attackerTraps.length > 0) {
        return { ok: false, reason: 'trap-confirmation-required' };
      }
      var mgr = manager();
      var panel = component(mgr, 'NBattleMain', 'StartFight');
      if (!panel) return { ok: false, reason: 'battle-prep-not-ready' };
      var ccg = globalThis.cc;
      if (!ccg || !ccg.Event || typeof ccg.Event.EventTouch !== 'function') {
        return { ok: false, reason: 'touch-event-unavailable' };
      }
      panel.StartFight(new ccg.Event.EventTouch([], false));
      return { ok: true };
    } catch (e) {
      log.warn('sandbox native StartFight threw: %s', e && e.message);
      return { ok: false, reason: 'start-threw' };
    }
  },
  /** @returns {boolean} 原生战斗准备/战斗面板是否仍在场 */
  battleActive() {
    var mgr = manager();
    return !!component(mgr, 'NBattleMain', 'StartFight');
  },
  /**
   * 关闭本功能发起的沙盘战斗准备页。只有当前战斗仍确认为 ARENA_PVE_BATTLE 才动 UI，
   * 避免误关玩家随后打开的其他战斗；原生拒绝/未发包时由调用方使用。
   * @returns {{ok:boolean,reason?:string}}
   */
  closePreparation() {
    try {
      var B = ns(game.get(MOD.battleData));
      var expected = B && B.BattleType && B.BattleType.ARENA_PVE_BATTLE;
      var DC = game.get(SYM.modules.dataCenter);
      var cur = DC && DC.DATA && DC.DATA.CurBattleData;
      if (expected == null || !cur || cur.Type !== expected) {
        return { ok: false, reason: 'not-arena-pve-battle' };
      }
      var mgr = manager();
      var U = ns(game.get(SYM.modules.uiDataInfo));
      var desc = U && U.UIDataInfo && U.UIDataInfo.BattleMainPanel;
      if (!desc || !mgr || !mgr.DataPool || mgr.DataPool[desc.name] == null) {
        return { ok: false, reason: 'battle-prep-not-open' };
      }
      if (typeof mgr.CloseUI !== 'function') return { ok: false, reason: 'close-ui-unavailable' };
      mgr.CloseUI(desc);
      return { ok: true };
    } catch (e) {
      log.warn('sandbox closePreparation threw: %s', e && e.message);
      return { ok: false, reason: 'close-threw' };
    }
  },
  /** @returns {boolean} 沙盘结算面板是否已在场（单轮/多轮/新版） */
  resultPresent() {
    var mgr = manager();
    var pool = mgr && mgr.DataPool;
    if (!pool) return false;
    var U = ns(game.get(SYM.modules.uiDataInfo));
    var reg = U && U.UIDataInfo;
    var members = ['ArenaBattleWinPanel', 'NArenaBattleWinPanel', 'NArenaBattleWinMoreRoundPanel'];
    for (var i = 0; i < members.length; i++) {
      var info = reg && reg[members[i]];
      if (info && pool[info.name] != null) return true;
    }
    return false;
  },
  /**
   * 仅关闭由本功能发起的沙盘结算面板；返回是否关闭过面板。
   * @returns {boolean}
   */
  closeResult() {
    try {
      var mgr = manager();
      var U = ns(game.get(SYM.modules.uiDataInfo));
      var reg = U && U.UIDataInfo;
      var changed = false;
      var members = [
        'ArenaBattleWinPanel',
        'NArenaBattleWinPanel',
        'NArenaBattleWinMoreRoundPanel',
      ];
      for (var i = 0; i < members.length; i++) changed = closeOpen(mgr, reg, members[i]) || changed;
      return changed;
    } catch (e) {
      log.warn('sandbox closeResult threw: %s', e && e.message);
      return false;
    }
  },
};
