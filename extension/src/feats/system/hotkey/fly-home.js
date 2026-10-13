/**
 * 大地图 TAB 飞回基地（热键注册表形态）
 *
 * 在世界地图（NWorldMap 场景）下按 [TAB]，让镜头飞到玩家自己的基地，口径与游戏原生
 * 「定位自己主城」（NWorldMapComponent.onKeyDown / Backspace）**逐字段对齐**：
 *   坐标 = UserData.WorldCoord（区内局部格号），服号 = serverData.selfServerId（本图的「我自己」服号）。
 *
 * 为什么服号既不能用视角服号、也不能信 PLAYER_INFO(630) 的 serverId：
 *   落点换算 game2displayWithServerLimit(x, y, k, subMap) 里 x,y 是**区内局部格号**，「落在哪个区」
 *   完全由 k 查 serverMatrix 的区偏移决定，所以 k 必须与 x,y 同源：
 *   - viewServerId()（=NWorldMapController.getCurServerId()）是「此刻镜头在看哪个区」，人在别区时
 *     配本服格号就落到「别区里的我的坐标数字」上（最初上报的症状）；
 *   - 630 PLAYER_INFO 的 serverId 真机实证会回**账号归属服**（本例转服后 4338 的基地配 serverId=4336），
 *     用它当 k 就是「飞到老区、坐标却是新区的」，故本功能不再发这一包，只留 selfServerId 缺失时
 *     不传 z 的兜底——游戏 MOVE_TO 分支自会回退 UserData.ServerId（与原生同一条兜底）。
 *
 * 打字让位 / 修饰键放行 / 场景门控 / preventDefault+stopPropagation 全部由 core/hotkeys.js 注册表统一处理，
 * 本文件只声明「绑定 + 动作」。TAB 默认会移动 DOM 焦点：坐标取不到时 handler 返回 false（不消费，
 * 让 TAB 走默认焦点移动）；取到则飞行并返回 true（消费，注册表拦截默认行为）。
 */
import { createLog } from '../../../core/log.js';
import { bind } from '../../../core/hotkeys.js';
import { nav, worldMap, gameData } from '../../../core/game-api.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=FLY_HOME） */
const log = createLog('FLY_HOME');

bind({
  id: 'flyHome',
  keys: ['Tab'],
  display: 'Tab',
  label: '飞回基地',
  where: '大世界',
  scenes: ['NWorldMap'],
  // B 档（可行性报告 §7.2）：跨服战场图里正是需要「飞回自己基地」的时候（只读相机导航、无协议风险），
  // 故不能按 homeland 一刀切；只排掉 pab——异能秘境把世界图整体换成副本，本服主城不在场，
  // 飞过去只是把镜头丢进副本坐标里（游戏原生的「定位主城」同样无意义）。
  kinds: ['homeland', 'wushuang', 'kvk', 'sphere', 'adp_war'],
  handler: function () {
    var pos = gameData.myWorldPos();
    if (!pos || pos.x < 0 || pos.y < 0) {
      log.warn('base coordinate unavailable (UserData.WorldCoord), skip TAB fly.');
      return false; // 不消费：让 TAB 走默认焦点移动
    }
    // 服号与坐标同源：selfServerId（本图「我自己」的区号）→ 缺失则不传 z，交游戏回退 UserData.ServerId
    var selfK = worldMap.selfServerId();
    // 诊断串在飞之前拼：viewK 是「此刻镜头在看哪个区」，仅读数不参与计算；
    // 真机再报「落点不对」时，这一行足以判断是哪个源漂移，无需跑探针。
    var diag =
      'selfK=' +
      selfK +
      ';userK=' +
      worldMap.serverId() +
      ';viewK=' +
      worldMap.viewServerId() +
      ';sub=' +
      gameData.subServerId() +
      ';mapType=' +
      worldMap.mapType() +
      ';pos=' +
      pos.x +
      ',' +
      pos.y;
    var r = nav.flyTo({ x: pos.x, y: pos.y, z: selfK || null, click: false });
    if (r.ok) log.info('fly to base. %s', diag);
    else log.warn('fly to base failed. %s;err=%s', diag, r.err);
    return true;
  },
});
