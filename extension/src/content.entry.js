// MAIN world 入口：按依赖顺序导入模块（IIFE 副作用执行），末尾拼接 curated 调试面。
// feat 目录层级对齐面板菜单树（core/menu.js）五类别：player 玩家设置 / alliance 联盟设置 / activity 活动设置 / battle 战斗设置 / system 系统设置（chat 聊天窗口、map 全局地图与镜头跳转、hotkey 快捷键）。
// 导入顺序 = 旧 manifest content_scripts 顺序：net 先于 feat，feat 先于编排器 boot；
// 新增 feat 除在这里加 import 外，还须挂进 core/menu.js 菜单树，否则不会出现在面板。
import './core/net.js';
import './core/net-collect.js';
import './core/log-collect.js';
import './core/event.js';
import './core/chat.js';
import './feats/activity/floatcar.js';
import './feats/activity/titan-blessing.js';
import './feats/alliance/alliance-help.js';
import './feats/activity/domain-treasure.js';
import './feats/player/mine-cave/index.js';
import './feats/activity/launch-silo.js';
import './feats/activity/secret-realm/index.js';
import './feats/activity/cs-hunt/index.js';
import './feats/activity/mask-dance.js';
import './feats/player/auto-farm/index.js';
import './feats/player/auto-hunt.js';
import './feats/player/fear-star-rally.js';
import './feats/player/radar-task.js';
import './feats/activity/sea-treasure.js';
import './feats/activity/mecha-treasure.js';
import './feats/alliance/alliance-gift.js';
import './feats/alliance/alliance-rally.js';
import './feats/player/source-of-war/index.js';
import './feats/alliance/alliance-boss.js';
import './feats/alliance/alliance-science.js';
import './feats/alliance/alliance-behemoth.js';
import './feats/player/daily-supply.js';
import './feats/player/ad-diamond.js';
import './feats/player/auto-coin-collect.js';
import './feats/player/city-skill.js';
import './feats/player/player-like.js';
import './feats/alliance/relic-reward.js';
import './feats/player/truck-intercept.js';
import './feats/player/armory-material.js';
import './feats/player/beast-breed.js';
import './feats/player/secret-weapon-drop.js';
import './feats/player/one-click-claim.js';
import './feats/player/daily-deal.js';
import './feats/battle/quick-attack.js';
import './feats/battle/imperial-decree.js';
import './feats/battle/auto-defense.js';
import './feats/system/chat/index.js';
import './feats/system/map/global-map.js';
import './feats/system/map/quick-jump.js';
// 游戏内快捷键：core/hotkeys.js 集中注册表，非 feat——import 即 hotkeys.bind 自激活，
// 全局仅一个 window 捕获监听统一分派（打字让位/修饰键放行/场景门控/preventDefault）。
import './feats/system/hotkey/fly-home.js';
import './feats/system/hotkey/scene-toggle.js';
import './feats/system/hotkey/open-bag.js';
import './feats/system/hotkey/close-popup.js';
import './feats/system/hotkey/battle-panel.js';
import './feats/system/hotkey/aux-docs.js'; // 展示型键位（F8/Ctrl+K/Ctrl+M，行为在各 feat，仅登记进「快捷键一览」）
import './boot.js';

import { bus } from './core/bus.js';
import { game } from './core/game.js';
import { debug as gameApi, worldSignals } from './core/game-api.js';
import { storage } from './core/storage.js';
import { reactor } from './core/reactor.js';
import { defense } from './core/defense.js';
import { worldState } from './core/world/state.js';
import { installDevtools } from './core/devtools.js';

// 调试面：逆向时在控制台直接戳——pocketcc.game.get('DataCenter')、pocketcc.bus.emit('net.10912', fakeEv) 模拟推送、
// pocketcc.reactor.isRunning('floatCar') 看功能起停、pocketcc.gameApi.march.flags() 看跨服战场判定器；
// net 句柄由 net.js 自挂到 window.pocketcc.net；
// reactor 功能改为自注册说明书，不挂 window.pocketcc.<feat>。这里只并入 core 工具，不覆盖已有键。
// 聊天通道同理：pocketcc.chat.status() 看连接与房间、pocketcc.chat.on('push', fn) 收频道消息；
// on/off 直连聊天 socket 并自带实例更替重挂（登录重连/故障转移/PAB 心跳重建后订阅不丢）。
// 调试专用（不绑 feat、不入生产调用链）：世界态一览——`pocketcc.worldState.dump()` 看当前归一结果
// 与四路原始信号（kind/place/phase/gen/raw），`pocketcc.worldSignals.mapTypeName()` 等单点取原值，
// 用来验证「你现在究竟在哪一种场景里」，不必等活动复现。
window.pocketcc = Object.assign(window.pocketcc || {}, {
  bus,
  game,
  gameApi,
  storage,
  reactor,
  defense,
  worldState,
  worldSignals,
});

// dev 专属探针（testRelocateNear/flyDiag 等）已外移 core/devtools.js；
// release 构建 esbuild define __DEVTOOLS__=false → 死代码消除，不进生产包。
if (__DEVTOOLS__) installDevtools();
