// 开发态调试面：仅 dev 构建注入（content.entry 里 `if (__DEVTOOLS__) installDevtools()`，release 构建经
// esbuild define __DEVTOOLS__=false 走死代码消除，不进生产包）。这里挂的多是「只读探测 + 显式发包」的控制台
// 探针，不参与任何生产调用链，也不进 reactor 装配。
import { game } from './game.js';
import { defense } from './defense.js';
import { debug as gameApi, nav, worldMap } from './game-api.js';

/**
 * 调试句柄登记（feat 侧唯一入口）：玩法层禁止直接摸 `window.pocketcc.*`（依赖不可见/eslint 拦截），
 *   故由 core 代挂，与 testRelocateNear 等同一个调试面。
 * 用途：把对象内部态（如自动驾驶的 10018 视口快照）开放给控制台只读，不参与生产调用链。
 * 口径：仅在 `__DEVTOOLS__` 构建下真实生效，release 构建中调用点被 esbuild 当死代码消除。
 * @param {string} name window.pocketcc 下的键名
 * @param {*} obj 待暴露的句柄
 * @returns {*} 原样回传 obj（方便链式使用）
 */
export function exposeDebug(name, obj) {
  if (!__DEVTOOLS__) return obj;
  window.pocketcc = window.pocketcc || {};
  window.pocketcc[name] = obj;
  return obj;
}

/**
 * 把 dev 专属探针挂到 window.pocketcc（幂等）。只在 __DEVTOOLS__ 为真时被调用。
 */
export function installDevtools() {
  window.pocketcc = window.pocketcc || {};

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
}
