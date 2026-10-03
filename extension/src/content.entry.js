// MAIN world 入口：按依赖顺序导入模块（IIFE 副作用执行），末尾拼接 curated 调试面。
// feat 目录层级对齐面板菜单树（core/menu.js）：daily 日常设置（含联盟集结）/ battle 战斗设置 / map 地图设置 / chat 聊天窗口。
// 导入顺序 = 旧 manifest content_scripts 顺序：net 先于 feat，feat 先于编排器 boot；
// 新增 feat 除在这里加 import 外，还须挂进 core/menu.js 菜单树，否则不会出现在面板。
import './core/net.js';
import './core/net-collect.js';
import './core/event.js';
import './core/chat.js';
import './feats/daily/floatcar.js';
import './feats/daily/titan-blessing.js';
import './feats/daily/alliance-help.js';
import './feats/daily/domain-treasure.js';
import './feats/daily/mine-cave/index.js';
import './feats/daily/launch-silo.js';
import './feats/daily/auto-farm.js';
import './feats/daily/sea-treasure.js';
import './feats/daily/alliance-gift.js';
import './feats/daily/alliance-rally.js';
import './feats/daily/source-of-war/index.js';
import './feats/daily/alliance-boss.js';
import './feats/daily/alliance-science.js';
import './feats/daily/city-skill.js';
import './feats/daily/player-like.js';
import './feats/daily/relic-reward.js';
import './feats/battle/quick-attack.js';
import './feats/battle/imperial-decree.js';
import './feats/chat/chat-window.js';
import './feats/map/global-map.js';
// 游戏内快捷键：core/hotkeys.js 集中注册表，非 feat——import 即 hotkeys.bind 自激活，
// 全局仅一个 window 捕获监听统一分派（打字让位/修饰键放行/场景门控/preventDefault）。
import './feats/hotkey/fly-home.js';
import './feats/hotkey/scene-toggle.js';
import './feats/hotkey/open-bag.js';
import './feats/hotkey/close-popup.js';
import './feats/hotkey/battle-panel.js';
import './feats/hotkey/aux-docs.js';   // 展示型键位（F8/Ctrl+K/Ctrl+M，行为在各 feat，仅登记进「快捷键一览」）
import './boot.js';

import { bus } from './core/bus.js';
import { game } from './core/game.js';
import { debug as gameApi } from './core/game-api.js';
import { battle } from './core/battle.js';
import { storage } from './core/storage.js';
import { reactor } from './core/reactor.js';

// 调试面：逆向时在控制台直接戳——pocketcc.game.get('DataCenter')、pocketcc.bus.emit('net.10912', fakeEv) 模拟推送、
// pocketcc.reactor.isRunning('floatCar') 看功能起停、pocketcc.gameApi.march.flags() 看跨服战场判定器、
// pocketcc.battle.buildFromPreset(0, 0) 看预设部队造出的行军字段（每格数经游戏实时重算）。
// net 句柄由 net.js 自挂到 window.pocketcc.net；
// reactor 功能改为自注册说明书，不挂 window.pocketcc.<feat>。这里只并入 core 工具与 battle 造数据面，不覆盖已有键。
// 聊天通道同理：pocketcc.chat.status() 看连接与房间、pocketcc.chat.on('push', fn) 收频道消息。
window.pocketcc = Object.assign(window.pocketcc || {}, { bus, game, gameApi, storage, reactor, battle });
