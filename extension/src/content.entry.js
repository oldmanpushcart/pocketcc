// MAIN world 入口：按依赖顺序导入模块（IIFE 副作用执行），末尾拼接 curated 调试面。
// feat 目录层级对齐面板菜单树（core/menu.js）：daily 日常设置（含联盟集结）/ activity 活动设置 / battle 战斗设置 / map 地图设置 / chat 聊天窗口。
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
import './feats/activity/launch-silo.js';
import './feats/activity/secret-realm/index.js';
import './feats/daily/auto-farm.js';
import './feats/daily/auto-hunt.js';
import './feats/daily/fear-star-rally.js';
import './feats/daily/sea-treasure.js';
import './feats/daily/mecha-treasure.js';
import './feats/daily/alliance-gift.js';
import './feats/daily/alliance-rally.js';
import './feats/daily/source-of-war/index.js';
import './feats/daily/alliance-boss.js';
import './feats/daily/alliance-science.js';
import './feats/daily/alliance-behemoth.js';
import './feats/daily/daily-supply.js';
import './feats/daily/city-skill.js';
import './feats/daily/player-like.js';
import './feats/daily/relic-reward.js';
import './feats/daily/truck-intercept.js';
import './feats/daily/armory-material.js';
import './feats/daily/beast-breed.js';
import './feats/daily/secret-weapon-drop.js';
import './feats/daily/one-click-claim.js';
import './feats/battle/quick-attack.js';
import './feats/battle/imperial-decree.js';
import './feats/battle/auto-defense.js';
import './feats/chat/chat-window.js';
import './feats/map/global-map.js';
// 游戏内快捷键：core/hotkeys.js 集中注册表，非 feat——import 即 hotkeys.bind 自激活，
// 全局仅一个 window 捕获监听统一分派（打字让位/修饰键放行/场景门控/preventDefault）。
import './feats/hotkey/fly-home.js';
import './feats/hotkey/scene-toggle.js';
import './feats/hotkey/open-bag.js';
import './feats/hotkey/close-popup.js';
import './feats/hotkey/battle-panel.js';
import './feats/hotkey/aux-docs.js'; // 展示型键位（F8/Ctrl+K/Ctrl+M，行为在各 feat，仅登记进「快捷键一览」）
import './boot.js';

import { bus } from './core/bus.js';
import { game } from './core/game.js';
import { debug as gameApi, nav, worldMap, worldSignals } from './core/game-api.js';
import { storage } from './core/storage.js';
import { reactor } from './core/reactor.js';
import { defense } from './core/defense.js';
import { worldState } from './core/world-state.js';

// 调试面：逆向时在控制台直接戳——pocketcc.game.get('DataCenter')、pocketcc.bus.emit('net.10912', fakeEv) 模拟推送、
// pocketcc.reactor.isRunning('floatCar') 看功能起停、pocketcc.gameApi.march.flags() 看跨服战场判定器；
// net 句柄由 net.js 自挂到 window.pocketcc.net；
// reactor 功能改为自注册说明书，不挂 window.pocketcc.<feat>。这里只并入 core 工具，不覆盖已有键。
// 聊天通道同理：pocketcc.chat.status() 看连接与房间、pocketcc.chat.on('push', fn) 收频道消息。
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

// 调试专用（不绑 feat、不入生产调用链）：给定目标基地坐标，复用生产同款 defense.findRelocatableSpot 在其附近找可落点，
//   默认只找点不发包，显式传 {move:true} 才发 911 定向迁城。便于真机观察「绕后迁城」的落点搜索合法性。
//   控制台用法：
//     pocketcc.testRelocateNear(413, 415)                   // 只找点、不迁城（安全默认）
//     pocketcc.testRelocateNear(413, 415, {move:true})     // 找点并发 911 实际迁城（消耗定向迁城卡 200003）
//     pocketcc.testRelocateNear(413, 415, {radius:6})       // 自定义贴近半径（默认 8）
//     pocketcc.testRelocateNear(413, 415, {mode:'away', threatX:413, threatY:415}) // 反向：从当前点背向威胁迁远
//     pocketcc.testRelocateNear(413, 415, {probe:true})     // 诊断：逐格 901 占用/canMoveCity
//     pocketcc.testRelocateNear(413, 415, {fly:true})       // 诊断：视口加载机理
//   合规：只读探测 + 显式迁城发包(911)，不改写游戏数据，绝不发攻击(902)。
window.pocketcc.testRelocateNear = async function (x, y, opts) {
  opts = opts || {};
  var net = window.pocketcc.net;
  var gd = gameApi.gameData;
  if (!net) {
    console.warn('[testRelocateNear] pocketcc.net 不可用');
    return null;
  }
  var serverId = 0;
  try {
    var d = (game.get('DataCenter') || {}).DATA;
    var u = d && d.UserData;
    serverId = (u && u.ServerId) | 0;
  } catch (e) {}
  var anchor = { x: x | 0, y: y | 0 };
  var mode = opts.mode === 'away' ? 'away' : 'near';
  var threat =
    mode === 'away'
      ? { x: opts.threatX | 0 || anchor.x, y: opts.threatY | 0 || anchor.y }
      : undefined;
  var out = {
    anchor: anchor,
    mode: mode,
    serverId: serverId,
    beforePos: gd.myWorldPos(),
    spot: null,
    moved: false,
  };
  window.pocketcc.lastRelocate = out; // 同一引用，后续就地更新——忘加 await 时事后仍可查 pocketcc.lastRelocate
  if (opts.fly) {
    // 纯诊断（不入生产）：把游戏视口飞到锚点触发原生加载，验证 option-3 机理——加载后 checkCanMove 是否正确还原 footprint、需等多久、静态地形是否可查
    out.fly = await flyDiag(
      anchor,
      serverId,
      mode,
      threat,
      opts.radius | 0 || (mode === 'away' ? defense.AWAY_RADIUS : defense.NEAR_RADIUS),
    );
    console.info('[testRelocateNear] fly 诊断（视口加载后 canMoveCity）', out.fly);
  }
  out.spot = await defense.findRelocatableSpot(anchor, {
    mode: mode,
    radius: opts.radius | 0 || (mode === 'away' ? defense.AWAY_RADIUS : defense.NEAR_RADIUS),
    threat: threat,
    ctx: { net: net, serverId: serverId },
  });
  if (opts.probe) {
    // 诊断：拉一次 901 原始占用 + 对锚点周围 (2R+1)² 逐格打印「901 是否标占 / pointType / checkCanMove 真值」，定位 footprint 漏标 vs 符号没兜住
    var PR = Math.min(opts.radius | 0 || defense.NEAR_RADIUS, 3);
    var half = (opts.radius | 0 || defense.NEAR_RADIUS) + 2;
    var body = {
      x: anchor.x,
      y: anchor.y,
      k: serverId,
      rid: 0,
      width: half * 2,
      height: half * 2,
      marchInfo: false,
      viewLevel: 1,
    };
    var p901;
    try {
      p901 = await net.send(901, body);
    } catch (e) {
      p901 = { ok: false, err: '' + e };
    }
    var d9 =
      p901 && p901.ok
        ? typeof p901.data === 'string'
          ? (function () {
              try {
                return JSON.parse(p901.data);
              } catch (e) {
                return {};
              }
            })()
          : p901.data || {}
        : {};
    var plist = Array.isArray(d9.pointList) ? d9.pointList : [];
    var occMap = {};
    for (var i = 0; i < plist.length; i++) {
      var q = plist[i];
      if (!q) continue;
      if ((q.pointType | 0) !== 0)
        occMap[(q.x | 0) + ',' + (q.y | 0)] = {
          pt: q.pointType | 0,
          id: q.b && q.b.id,
          aid: q.b && q.b.aid,
          keys: Object.keys(q),
        };
    }
    var grid = [];
    for (var yy = anchor.y - PR; yy <= anchor.y + PR; yy++)
      for (var xx = anchor.x - PR; xx <= anchor.x + PR; xx++) {
        grid.push({
          x: xx,
          y: yy,
          occ: !!occMap[xx + ',' + yy],
          pt901: occMap[xx + ',' + yy] ? occMap[xx + ',' + yy].pt : 0,
          canMove: gd.canMoveCity(xx, yy),
        });
      }
    out.diag = {
      ok901: !!(p901 && p901.ok),
      pointCount: plist.length,
      occCount: Object.keys(occMap).length,
      anchorOcc: occMap[anchor.x + ',' + anchor.y] || null,
      spotOcc: out.spot ? !!occMap[out.spot.x + ',' + out.spot.y] : null,
      spotCanMove: out.spot ? gd.canMoveCity(out.spot.x, out.spot.y) : null,
      bandOccupiers: grid.filter(function (g) {
        return g.occ;
      }),
      bandOccupiersRaw: plist.filter(function (q) {
        return (
          q &&
          (q.pointType | 0) !== 0 &&
          Math.abs((q.x | 0) - anchor.x) <= PR + 2 &&
          Math.abs((q.y | 0) - anchor.y) <= PR + 2
        );
      }), // 原始回点对象（含 b/skin/尺寸等全字段）：定 footprint 能否从 901 直接取
      grid: grid,
    };
    console.info('[testRelocateNear] probe 诊断', out);
  }
  if (!out.spot) {
    console.info('[testRelocateNear] 无可落点 → 未迁城', out);
    return out;
  }
  if (!opts.move) {
    console.info('[testRelocateNear] 默认只找点（需 {move:true} 才真迁城）', out);
    return out;
  }
  var hasItem = gd.itemAmount && gd.itemAmount(defense.ITEM_MOVE_CITY) > 0;
  var body911 = hasItem
    ? { itemId: defense.ITEM_MOVE_CITY, amount: 1, isPurchase: 0, x: out.spot.x, y: out.spot.y }
    : {
        itemId: defense.ITEM_MOVE_CITY,
        amount: 0,
        isPurchase: 1,
        vipShopBuy: 1,
        x: out.spot.x,
        y: out.spot.y,
      };
  if (!hasItem) console.info('[testRelocateNear] 无迁城卡，用钻石迁城');
  var ret = await net.send(911, body911);
  out.send = { ok: !!(ret && ret.ok), code: ret && ret.code, data: ret && ret.data };
  out.moved = !!(ret && ret.ok);
  await new Promise(function (r) {
    setTimeout(r, 800);
  }); // 迁城回执后短暂观察坐标刷新（游戏靠 push 更新 WorldCoord）
  out.afterPos = gd.myWorldPos();
  console.info('[testRelocateNear] 结果', out);
  return out;
};

// 诊断辅助（仅 opts.fly 用）：nav.flyTo 驱动视口 → 轮询加载就绪 → 逐格采 canMoveCity 与静态地形 isBlock。
// 就绪信号：near 以「敌锚点自身城格由可落变不可落」为 entities 已加载标志（checkCanMove ignoreSelf 不影响他人城）。
async function flyDiag(anchor, serverId, mode, threat, radius) {
  var gd = gameApi.gameData;
  var tm = worldMap && worldMap.terrainModel ? worldMap.terrainModel() : null;
  function blockedCell(gx, gy) {
    try {
      return tm && typeof tm.isBlock === 'function' ? !!tm.isBlock(Math.floor(gx / 2), gy) : null;
    } catch (e) {
      return 'err:' + e;
    }
  }
  var beforeAnchor = gd.canMoveCity(anchor.x, anchor.y); // 未飞前（人在基地/视口别处）预期 true=失真
  var navRet = nav.flyTo({
    x: anchor.x,
    y: anchor.y,
    z: serverId || null,
    subMap: null,
    click: false,
  });
  var gateX = mode === 'away' && threat ? threat.x : anchor.x;
  var gateY = mode === 'away' && threat ? threat.y : anchor.y;
  var t0 = Date.now(),
    maxWait = 3500,
    step = 150,
    readyAtMs = null;
  while (Date.now() - t0 < maxWait) {
    if (gd.canMoveCity(gateX, gateY) === false) {
      readyAtMs = Date.now() - t0;
      break;
    } // 目标城格变不可落=该区已入库
    await new Promise(function (r) {
      setTimeout(r, step);
    });
  }
  await new Promise(function (r) {
    setTimeout(r, readyAtMs == null ? 400 : 500);
  }); // 无论有无信号再 settle 一拍（空区无占用信号时靠固定延时）
  var PR = Math.min(radius, 3);
  var grid = [];
  for (var yy = anchor.y - PR; yy <= anchor.y + PR; yy++)
    for (var xx = anchor.x - PR; xx <= anchor.x + PR; xx++) {
      grid.push({
        x: xx,
        y: yy,
        canMoveCity: gd.canMoveCity(xx, yy),
        blocked: blockedCell(xx, yy),
      });
    }
  function ringSpot(cx, cy, R) {
    for (var r = 0; r <= R; r++)
      for (var dx = -r; dx <= r; dx++)
        for (var dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var x = cx + dx,
            y = cy + dy;
          if (x < 0 || y < 0 || x > defense.WORLD_BOUNDS.xMax || y > defense.WORLD_BOUNDS.yMax)
            continue;
          if (gd.canMoveCity(x, y) === true) return { x: x, y: y };
        }
    return null;
  }
  var flySpot = mode === 'near' ? ringSpot(anchor.x, anchor.y, radius) : null; // 对照：纯以游戏 canMoveCity 为准的最近可落点
  return {
    navRet: navRet,
    hasTerrainModel: !!tm,
    readyAtMs: readyAtMs,
    waitedMs: Date.now() - t0,
    beforeAnchorCanMove: beforeAnchor,
    afterAnchorCanMove: gd.canMoveCity(anchor.x, anchor.y),
    occupiedVisibleInGrid: grid.filter(function (g) {
      return g.canMoveCity === false;
    }).length,
    terrainBlockedInGrid: grid.filter(function (g) {
      return g.blocked === true;
    }).length,
    flySpot: flySpot,
    grid: grid,
  };
}
