/**
 * core/defense.js —— 自动防御的行为/查询层（薄，与 march.js/item.js 同侧的协议就近模块）
 *
 * 职责边界：
 *   - 收口自动防御三策略共用的「道具选择 + 迁城落点搜索」两块重活，供 feats/battle/auto-defense.js 消费；
 *   - 护盾/迁城卡的 itemId 是稳定服务器内容常量（发协议就近定义，同 march.js 的 520001/520002），不归 core/item.js；
 *   - 迁城落点合法性走「四闸联合、逐 footprint 格」（对齐服务端 911，真机 + extracted 源码双重实证）：
 *     ① 地形/王座/已加载实体：游戏权威 gameData.canMoveCity(x,y)===true（false 必拦、null 无从判定）；其内部 checkIsPlainTileBySize 已逐 footprint 格判障碍+他人城皮，但 ignoreSelf=true 会放行「压自己城」的格；
 *     ② 障碍+他人城皮占用：主动一发 901 取 pointList，把非己方的城/BOSS/塔等按 footprint 扩格入占用集——不信易失的本地 entities（实证：邻城未入库时 canMoveCity 会对真城假阳性放行）；
 *     ③ self-overlap 硬闸：候选 footprint 命中我方现主城 footprint 扩格集即拦（补① ignoreSelf 漏，实证 (337,476) 压现城被服务器拒「位置被占用」）；
 *     ④ 联盟堡垒禁迁区（仅 `!isKVK() && ServerState!=Fight` 时启用，对齐游戏 moveCity 权威条件）：主动发 1001 取 infos（陈旧模型不可信）推旋转系「实心菱形区间」（奇偶无关，避开 AlliancePointPool 采样盲区），逐 footprint 格判越界外扩 margin=1（实证：越界 1 格仍被服务器 csb_tips_005 拒），排除己方 aid；KVK 图或作战态（ServerState==Fight）整图放开别盟领地→跳过 1001 且不建区间（实证 extracted WorldMapController.moveCity：禁迁仅在 (!isKVK||!八国色) && ServerState!=Fight && owner>0 && owner!=我的Aid 时拒绝）。
 *     判定前先 flyTo 锚点 + 订阅 net.901 + 主动 901 触发加载，经 settle 就绪门（新 901 & canMoveCity 为 boolean & 静默 800ms & 邻域 placeFlags 命中>0）后才采信；未进世界图 / 符号不可得 / 领地模型未就绪（canMoveCity 恒 null 或 901 报了领土点但 AllianceTerritory 空）即判「无从判定」返回 null 交上层顺延，绝不猜测。
 *
 * 合规：只读游戏数据 + 驱动游戏自身视口加载（nav.flyTo 切世界图/移动相机，属导航交互非数据改写），不调任何游戏 Update/Delete 改写本地数据；发包动作（910/911/902）
 *   留在 feat，本模块只产出「用哪个道具 / 迁到哪个坐标」这类决策输入。
 */
import { createLog } from './log.js';
import { item } from './item.js';
import { gameData, nav, worldMap } from './game-api.js';
import { bus } from './bus.js';

/** @type {ReturnType<createLog>} 模块日志器（tag=DEFENSE） */
const log = createLog('DEFENSE');

// ── 发协议内容常量（服务器契约，非 bundle 符号，就近收口） ─────────────
/**
 * 护盾三档（背包道具，开盾恒 isPurchase:0）：按「时长由短到长」排列，pickShieldItem 取持有者优先命中最短档。
 * 实证报文 20261007T220646：200004=4h / 200005=8h / 200006=24h。
 * @type {Array<{itemId:number, hours:number}>}
 */
const SHIELD_TIERS = [
  { itemId: 200004, hours: 4 },
  { itemId: 200005, hours: 8 },
  { itemId: 200006, hours: 24 },
];

/** @type {number} 迁城卡 itemId（背包迁城，911 单档，实证 20261007T220646；目前仅此一档） */
const ITEM_MOVE_CITY = 200003;

/** @type {number} 「贴近敌主城」的切比雪夫半径（定案：以敌基地坐标为原点周围 8 个坐标单位内取最近可落点，无则放弃顺延） */
const NEAR_RADIUS = 8;

/** @type {number} 「迁城逃避」在我方主城周围搜索的切比雪夫上限带（在此带内取背向敌、离敌更远的可落点） */
const AWAY_RADIUS = 20;

/** @type {{xMax:number, yMax:number}} 世界坐标上界「兜底」常量（core 不回引 feats/map/map-meta；实证标准本服图 gameXMax=408*2、gameYMax=952）。仅在 worldMap.gameBounds() 探测失败时退回此常量。 */
const WORLD_BOUNDS = { xMax: 816, yMax: 952 };

/** @type {number} 堡垒禁迁区实心菱形外扩格数（实证：(413,410) 越界 1 格仍被服务器 csb_tips_005 拒 → margin 保命，不可降 0） */
const RELOC_TERR_MARGIN = 1;

/**
 * @type {Set<number>} 901 pointType 中「结构性占用」即不可落者（城/占领/王座/BOSS/集结BOSS/世界遗址/联盟BOSS/资源塔/Buff塔/国度BOSS）。
 * 可覆盖类（怪/资源田/难民/空投/宝藏…）不计入阻塞，与游戏 judgeTileIfCanCover 语义对齐。
 */
const RELOC_OCC_BLOCK = new Set([1, 3, 10, 11, 12, 15, 17, 24, 25, 31]);

/** @type {{width:number, height:number, viewLevel:number}} 单发 901 视口窗口（实证覆盖 x±58/y±39，足以罩住 near(8)/away(20) 搜索带） */
const RELOC_VIEW = { width: 116, height: 76, viewLevel: 1 };

/**
 * 从背包可用护盾中挑选「时长最短的那一档」（定案：200004→200005→200006 首个 item.amount>0 者）。
 * @returns {number|null} 护盾 itemId；三档皆无返回 null（→ 开盾策略判不可行）
 */
function pickShieldItem() {
  for (var i = 0; i < SHIELD_TIERS.length; i++) {
    var id = SHIELD_TIERS[i].itemId;
    if (item.amount(id) > 0) return id;
  }
  return null;
}

/** 欧氏距离平方（比较远近无需开方，避开 Math.sqrt 噪声且保序） */
function dist2(ax, ay, bx, by) {
  var dx = ax - bx,
    dy = ay - by;
  return dx * dx + dy * dy;
}

/** 迁城落点 footprint：等价游戏 checkIsPlainTileBySize 的 L×L 菱形展开（L=城外观边长），返回占地格集合 */
function footprintCells(x, y, L) {
  var out = [];
  for (var s = 0; s < L; s++)
    for (var k = 0; k < L; k++) out.push({ x: (x | 0) + s - k, y: (y | 0) - s - k });
  return out;
}

/** 堡垒禁迁区「实心菱形区间」（旋转系、奇偶无关）：由 {x,y,w,bw} 推 S=x+y 与 D=x-y 的闭合区间（避开 AlliancePointPool 只采样单奇偶的盲区） */
function terrBounds(x, y, w, bw) {
  var Slo = x + y - w + bw,
    Dlo = x - y - w - bw + 2;
  return { Slo: Slo, Shi: Slo + 2 * (w - 1), Dlo: Dlo, Dhi: Dlo + 2 * (w - 1) };
}

/** 格 (gx,gy) 到实心区间的越界格数（0=落在区间内） */
function terrViol(b, gx, gy) {
  var S = gx + gy,
    D = gx - gy;
  return Math.max(b.Slo - S, S - b.Shi, b.Dlo - D, D - b.Dhi, 0);
}

/** 从 901 点位多子对象（p/b/r/t/m）里兜底取首个非空字段（城点信息常嵌在子对象里，字段名跨版本略有漂移） */
function pickSub(p, subs, keys) {
  for (var i = 0; i < subs.length; i++) {
    var s = p[subs[i]];
    if (s && typeof s === 'object') {
      for (var j = 0; j < keys.length; j++) {
        if (s[keys[j]] != null) return s[keys[j]];
      }
    }
  }
  for (var k = 0; k < keys.length; k++) {
    if (p[keys[k]] != null) return p[keys[k]];
  }
  return null;
}

/**
 * 构造逐候选合法性判定器 (x,y)=>boolean：对齐服务端 911 的「逐 footprint 格」口径（真机 + extracted 源码双重实证，任一闸不过即不可落）。
 *   ① 地形/王座/已加载实体：游戏权威 gameData.canMoveCity===true（false 必拦、null 无从判定）；内部 checkIsPlainTileBySize 已逐格判障碍+他人城皮，但 ignoreSelf 会放行「压自己城」。
 *   ② 障碍+他人城皮占用：主动一发 901 取 pointList，非己方 RELOC_OCC_BLOCK 类按 footprint 扩格入占用集（不信易失 entities），候选 footprint 命中即拦。
 *   ③ self-overlap 硬闸：候选 footprint 命中我方现主城 footprint 扩格集 → 拦（补① ignoreSelf 漏，防「压现城」落点，实证 (337,476) 服务器拒）。
 *   ④ 敌盟堡垒禁迁区：仅 `!isKVK() && ServerState!=Fight` 时启用（对齐游戏 moveCity）——主动一发 1001 取锚点视口 infos 推敌盟实心菱形区间（不读游戏模型，防远程切视口陈旧数据；排除己方 aid），逐候选 footprint 格判越界 ≤ RELOC_TERR_MARGIN；KVK 图或作战态（ServerState==Fight）整图不拦别盟领地（跳过 1001）。
 * 流程：flyTo 锚点 + 订阅 net.901 计回包 → 主动一发 901（兼触发 push）→ settle 就绪门（canMoveCity 为 boolean & mapLoadedNear±7>0；901 push 静默降为可选增强）→ 主动一发 1001 取领地 → 建判定器。
 * 无从建立（未就绪 / canMoveCity 恒 null / 1001 无应答且无 net 时模型未就绪）返回 null 交上层顺延；net 缺失时占用闸降级空集（退回 canMoveCity + self-overlap + 领地三闸）。
 * @param {{x:number, y:number}} anchor 搜索锚点
 * @param {{serverId?:number, net?:{send:Function}, maxWait?:number}} [opts] 服号（flyTo 换算/901 请求体 k）、已安装 net、就绪轮询上限
 * @returns {Promise<((x:number, y:number)=>boolean)|null>} 判定器；无从建立返回 null
 */
async function makeJudge(anchor, opts) {
  opts = opts || {};
  var ax = anchor.x | 0,
    ay = anchor.y | 0;
  var maxWait = opts.maxWait || 6000,
    step = 120;
  var net = opts.net;
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var fly = function () {
    try {
      nav.flyTo({ x: ax, y: ay, z: opts.serverId | 0 || null, subMap: null, click: false });
    } catch (e) {}
  };
  // 1) 订阅 net.901 回包作 settle 信号（主动发送 + 视口原生 push 均计）；bus 不可用 → 降级为纯 canMoveCity/mapLoadedNear 就绪
  var lastPush = 0;
  var off901 =
    bus && typeof bus.on === 'function'
      ? bus.on('net.901', function () {
          lastPush = Date.now();
        })
      : null;
  try {
    fly();
    // 2) 主动一发 901 取权威占用（单窗口 x±58/y±39 罩住搜索带）；同时数 pointType=13 领土点作就绪交叉校验
    var occ = {},
      terr901 = 0,
      myAid = gameData.myAid(),
      myPid = gameData.myPid();
    if (net && typeof net.send === 'function') {
      var body = {
        x: ax,
        y: ay,
        k: opts.serverId | 0 || 0,
        rid: 0,
        width: RELOC_VIEW.width,
        height: RELOC_VIEW.height,
        marchInfo: true,
        viewLevel: RELOC_VIEW.viewLevel,
      };
      var ret = null;
      try {
        ret = await net.send(901, body);
      } catch (e) {
        log.debug('makeJudge 901 send error: %s', e && e.message);
      }
      var d = ret && ret.ok ? ret.data : null;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch (e2) {
          d = null;
        }
      }
      var list = d && Array.isArray(d.pointList) ? d.pointList : null;
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var p = list[i],
            pt = p.pointType | 0;
          if (pt === 13) {
            terr901++;
            continue;
          } // 领土交④闸判，不属占地
          if (!RELOC_OCC_BLOCK.has(pt)) continue; // 可覆盖类不阻塞
          var aid = Number(pickSub(p, ['p', 'r', 'm', 't', 'b'], ['aid', 'allianceId'])) || 0;
          var pid = Number(pickSub(p, ['p', 'b', 'r', 't', 'm'], ['pid', 'ownerId'])) || 0;
          if ((aid && aid === myAid) || (pid && pid === myPid)) continue; // 己方占地不算阻塞
          var L = 1;
          if (pt === 1) {
            var sk = pickSub(p, ['p', 'b', 'r', 't', 'm'], ['skinId']);
            L = sk != null ? gameData.citySkinSize(sk) || 2 : 2;
          }
          var fc = footprintCells(p.x | 0, p.y | 0, L);
          for (var j = 0; j < fc.length; j++) {
            var key = fc[j].x + ',' + fc[j].y;
            if (!occ[key]) occ[key] = 1;
          }
        }
      }
    }
    // 3) settle 就绪门：轮询至「canMoveCity 为 boolean 且 邻域 placeFlags 有命中」（区域真正加载）；
    //    注：bus.on('net.901') 只收服务端主动推送（多数图不推 901），不卡此信号作硬闸；若确有推送则加静默期等待刷完。
    var t0 = Date.now(),
      ready = false;
    while (Date.now() - t0 < maxWait) {
      fly();
      if (typeof gameData.canMoveCity(ax, ay) === 'boolean') {
        var near = gameData.mapLoadedNear(ax, ay, 7);
        if (near == null || near > 0) {
          ready = true;
          break;
        } // placeFlags 符号不可得→不阻断；可得且有命中→就绪
      }
      await sleep(step);
    }
    if (ready && lastPush && Date.now() - lastPush < 3000) {
      var tq = Date.now();
      while (Date.now() - tq < maxWait && Date.now() - lastPush < 800) await sleep(100);
    } // 可选：若有近期推送则等静默
    if (!ready) {
      log.debug(
        'makeJudge: 锚点 settle 未就绪(canMoveCity=%s, near=%s) → 无从判定落点',
        typeof gameData.canMoveCity(ax, ay),
        gameData.mapLoadedNear(ax, ay, 7),
      );
      return null;
    }
    // 4) 敌盟禁迁区主动自取 1001（GET_TERRITORY_INFO 应答 infos 即锚点视口领地，服务端扩窗 60×60）。
    //    不读游戏模型：远程切视口时模型仍是旧视口数据——实证 20261008T232006 新视口 1001 回包比 911 晚 2ms 落地，
    //    陈旧领地放行 (412,415)（实入敌盟 buildId=101 区间）被服务器拒 csb_tips_005。net 不可用才退回读模型（同视口场景可信）。
    //    禁迁闸门控对齐游戏 moveCity 权威条件（extracted WorldMapController）：别盟堡垒领地禁迁仅在
    //    (!isKVK() || !八国色号) && ServerState != Fight 时生效——KVK 图或作战态(ServerState==Fight)整图放开别盟领地，
    //    此时跳过 1001 取领地（省一次发包）并不建 enemyBounds。八国色号那条只在「KVK 且无色号」罕见边缘收紧，此处保守沿用 KVK 即放行。
    var terrApplies = !gameData.isKVK() && !gameData.serverStateIsFight();
    var terrInfos = [];
    if (terrApplies) {
      if (net && typeof net.send === 'function') {
        var tret = null,
          t1 = Date.now();
        while (Date.now() - t1 < maxWait) {
          if (!net.isSending || !net.isSending(1001)) {
            try {
              tret = await net.send(1001, {
                x: ax,
                y: ay,
                k: opts.serverId | 0 || 0,
                rid: 0,
                width: 18,
                height: 30,
              });
            } catch (e) {
              log.debug('makeJudge 1001 send error: %s', e && e.message);
            }
            break;
          }
          await sleep(step);
        }
        if (!tret || !tret.ok) {
          log.debug('makeJudge: 1001 领地应答未就绪 → 无从判定禁迁区');
          return null;
        }
        var td = tret.data;
        if (typeof td === 'string') {
          try {
            td = JSON.parse(td);
          } catch (e3) {
            td = null;
          }
        }
        terrInfos = td && Array.isArray(td.infos) ? td.infos : [];
      } else {
        var terrs = null,
          t2 = Date.now();
        while (Date.now() - t2 < maxWait) {
          terrs = gameData.allianceTerritories();
          if (terrs && (terrs.length > 0 || terr901 === 0)) break;
          await sleep(step);
        }
        if (terrs == null || (terrs.length === 0 && terr901 > 0)) {
          log.debug('makeJudge: 堡垒领地模型未就绪(901领土点=%d) → 无从判定禁迁区', terr901);
          return null;
        }
        terrInfos = terrs;
      }
    }
    if (gameData.canMoveCity(ax, ay) === null) return null; // 地形/游戏可落判据符号不可得 → 无从判定
    // 5) 敌堡垒实心禁迁区区间（排除己方 aid；owner=-1000 中立占位自动被 owner>0 过滤）
    var enemyBounds = [];
    for (var ti = 0; ti < terrInfos.length; ti++) {
      var t = terrInfos[ti];
      if (t && t.owner > 0 && t.owner !== myAid) enemyBounds.push(terrBounds(t.x, t.y, t.w, t.bw));
    }
    var a = gameData.citySkinSize(gameData.usingCastleFace()) || 2; // 我方迁城 footprint 边长
    // 6) self-overlap 格集（我方现主城 footprint 扩 a×a），补 canMoveCity ignoreSelf 漏
    var selfSet = {},
      mp = gameData.myWorldPos();
    if (mp) {
      var sc = footprintCells(mp.x, mp.y, a);
      for (var q = 0; q < sc.length; q++) selfSet[sc[q].x + ',' + sc[q].y] = 1;
    }
    // 7) 四闸判定器：canMoveCity===true && footprint 无 901 占用 && footprint 无 self-overlap && (KVK/作战态 || footprint 不入敌禁迁区)
    return function (x, y) {
      if (gameData.canMoveCity(x | 0, y | 0) !== true) return false;
      var fp = footprintCells(x | 0, y | 0, a);
      for (var m = 0; m < fp.length; m++) {
        var k = fp[m].x + ',' + fp[m].y;
        if (occ[k]) return false;
        if (selfSet[k]) return false;
        for (var b = 0; b < enemyBounds.length; b++) {
          if (terrViol(enemyBounds[b], fp[m].x, fp[m].y) <= RELOC_TERR_MARGIN) return false;
        }
      }
      return true;
    };
  } finally {
    if (off901) off901();
  }
}

/** 由锚点向外按切比雪夫环逐格搜「距锚点最近的可落点」；exclude 非空则跳过该格（落点不得等于现有位置，命中即顺延取次近），radius 内全无 → null（不退让取更远点） */
function searchNear(anchor, judge, inBounds, radius, exclude) {
  var ax = anchor.x | 0,
    ay = anchor.y | 0;
  var ex = exclude && exclude.x != null ? exclude.x | 0 : null;
  var ey = exclude && exclude.y != null ? exclude.y | 0 : null;
  for (var r = 0; r <= radius; r++) {
    for (var dx = -r; dx <= r; dx++) {
      for (var dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // 只走本环边框
        var x = ax + dx,
          y = ay + dy;
        if (!inBounds(x, y)) continue;
        if (ex != null && ey != null && x === ex && y === ey) continue; // 落点不得等于现有位置：命中则跳过，取同环下一格/次环最近格
        if (judge(x, y)) return { x: x, y: y };
      }
    }
  }
  return null;
}

/** 在我方主城周围取「背向威胁、离威胁更远」的可落点：带内所有可落点里选距威胁最远者；无更远点 → null */
function searchAway(home, threat, judge, inBounds, radius) {
  var hx = home.x | 0,
    hy = home.y | 0;
  var thx = threat ? threat.x | 0 : hx,
    thy = threat ? threat.y | 0 : hy;
  var base = dist2(thx, thy, hx, hy);
  var best = null,
    bestD = base;
  for (var r = 1; r <= radius; r++) {
    for (var dx = -r; dx <= r; dx++) {
      for (var dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var x = hx + dx,
          y = hy + dy;
        if (!inBounds(x, y)) continue;
        if (!judge(x, y)) continue;
        var d = dist2(thx, thy, x, y);
        if (d > bestD) {
          bestD = d;
          best = { x: x, y: y };
        } // 严格比当前基线/已选更远
      }
    }
  }
  return best;
}

/**
 * 搜索一个合法可迁落点（迁城卡落点，B/C 两策略共用）。
 * @param {{x:number, y:number}} anchor 搜索锚点：near 模式=敌主城坐标；away 模式=我方主城坐标
 * @param {{mode:'near'|'away', radius?:number, threat?:{x:number,y:number}, exclude?:{x:number,y:number},
 *          bounds?:{xMax:number,yMax:number}, ctx?:{net:object, serverId:number}}} [opts]
 *   near：在 anchor 周围 radius（默认 8）内取距敌最近可落点（exclude 若给出则跳过该格，避免落点等于现有主城位）；away：在 anchor 周围 radius（默认 20）带内取背向 threat 更远可落点。
 * @returns {Promise<{x:number, y:number}|null>} 可落坐标；radius 内无落点/无从判定 → null（调用方记 fail 并顺延下一条）
 */
async function findRelocatableSpot(anchor, opts) {
  if (!anchor || anchor.x == null || anchor.y == null) return null;
  opts = opts || {};
  var bounds = opts.bounds || worldMap.gameBounds() || WORLD_BOUNDS;
  var inBounds = function (x, y) {
    return x >= 0 && y >= 0 && x <= bounds.xMax && y <= bounds.yMax;
  };
  var radius = opts.radius || (opts.mode === 'away' ? AWAY_RADIUS : NEAR_RADIUS);
  var judge = await makeJudge(anchor, {
    serverId: opts.ctx && opts.ctx.serverId,
    net: opts.ctx && opts.ctx.net,
  });
  if (!judge) {
    log.debug('findRelocatableSpot: 世界图未就绪 / canMoveCity 不可得，无从判定落点合法性');
    return null;
  }
  if (opts.mode === 'away') {
    return searchAway(anchor, opts.threat, judge, inBounds, radius);
  }
  return searchNear(anchor, judge, inBounds, radius, opts.exclude);
}

/** 自动防御行为/查询层单例 */
export const defense = {
  SHIELD_TIERS,
  ITEM_MOVE_CITY,
  NEAR_RADIUS,
  AWAY_RADIUS,
  WORLD_BOUNDS,
  pickShieldItem,
  findRelocatableSpot,
};
