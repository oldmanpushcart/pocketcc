/**
 * TAB 飞回基地的「区号/坐标」数据源对拍探针（DevTools 一次性粘贴运行）
 *
 * 背景：feats/hotkey/fly-home.js 现在把「本服局部坐标 UserData.WorldCoord」和「当前视角服号
 *   worldMap.viewServerId()」拼在一起传给 game2displayWithServerLimit(x, y, k, subMap)，
 *   而 x,y 是**区内局部格号**、区偏移完全由 k 决定 —— 用错 k 就把自己的坐标塞进了别人的区。
 *   游戏原生「定位自己主城」（NWorldMapComponent.onKeyDown / Backspace）用的是
 *   NWorldMapData.instance.serverData.selfServerId + WorldCoord，两者口径不同。
 *   本探针把 5 路本地源 + 1 发 630 只读查询全打出来，用来定案：基地真正的服号该从哪取。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，处于 MAIN world 控制台上下文（window.pocketcc 可见）。
 *   **请在「那个不能正常工作」的区里跑**（不是自己本区），否则证据无意义。
 * 合规：A~E 全程只读、零发包；F 只发一次 630 PLAYER_INFO（纯查询，与面板反查玩家名同通道）。
 * 贴回：A/B/C/D/E/F 六段一起贴回即可定案。
 */
(function flyHomeProbe() {
  const PC = window.pocketcc;
  if (!PC || !PC.game) {
    console.error(
      '[fly-home-probe] window.pocketcc 未就绪：确认已加载扩展、已登录、MAIN world 上下文。',
    );
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const K = (label, v) => console.log('  ' + label + ' =', v);
  /** 模块取包后常见导出形态归一（default / 同名键 / 裸模块） */
  const unwrap = (m, name) => (m && (m[name] || m.default || m)) || null;
  const safe = (fn, fb) => {
    try {
      return fn();
    } catch (e) {
      return '(抛:' + (e && e.message) + ')' + (fb === undefined ? '' : fb);
    }
  };

  const DATA = safe(() => PC.game.get('DataCenter').DATA);
  const U = DATA && DATA.UserData;
  if (!U) {
    console.error('[fly-home-probe] 取 DataCenter.DATA.UserData 失败');
    return;
  }
  /** NWorldMapUtils 提到最前：B/D 两段都要用它算落点 */
  const U2 = safe(() => unwrap(PC.game.get('NWorldMapUtils'), 'NWorldMapUtils'));

  // 多轮对拍：只有「镜头停在出问题时那个区」的那一轮才有鉴别力，故每轮先自报视角服号并判定是不是案发现场
  window.__pcFlyProbeRound = (window.__pcFlyProbeRound || 0) + 1;
  const viewKNow = safe(() => {
    const c = window.NWorldMapController;
    return c && typeof c.getCurServerId === 'function' ? c.getCurServerId() : null;
  });
  const ownK = safe(() => U.ServerId);
  console.log(
    '%c########## fly-home-probe 第 ' +
      window.__pcFlyProbeRound +
      ' 轮 @ ' +
      new Date().toLocaleTimeString() +
      '  视角服号=' +
      viewKNow +
      '  基地服号(ServerId)=' +
      ownK +
      ' ##########',
    'color:#ff6b6b;font-weight:bold',
  );
  if (viewKNow != null && String(viewKNow) !== String(ownK)) {
    console.log(
      '%c  → 视角服号 ≠ 基地服号：本轮就是错位现场，D 段各 k 的 display 差异即问题本身（请务必贴回这一轮）。',
      'color:#ff6b6b',
    );
  } else {
    console.log(
      '%c  → 视角服号 == 基地服号：本轮在自家区，各路 k 会算出同一个落点，看不出错配。**请把镜头拖到出问题的那个区再跑一轮**。',
      'color:#e0a800',
    );
  }

  // ── A. UserData：本地身份与基地坐标（这些是「可能是 stale」的一方） ──────────
  H('A. UserData 身份/坐标（本地缓存，可能 stale）');
  const WC = U.WorldCoord;
  K(
    'WorldCoord（基地格号，区内局部口径）',
    JSON.stringify(safe(() => ({ x: WC && WC.x, y: WC && WC.y }))),
  );
  [
    'ServerId',
    'CurrServerId',
    'OriginServerId',
    'RegisterServerId',
    'subServerID',
    'UID',
    'WorldId',
    'AreaID',
    'FightServerId',
    'ServerState',
    'ServerColor',
  ].forEach((n) => {
    K(
      'UserData.' + n,
      safe(() => U[n]),
    );
  });
  // 观战/大师/PAB 战场下游戏把坐标写到 TMWatchController.OriginCoord，此时 WorldCoord 不被更新（源码 updateWorldCoord 实证）
  K(
    'CrossUtils 类战场标志 isInLimitBattleStatus',
    safe(() => {
      const C = unwrap(PC.game.get('CrossUtils'), 'CrossUtils');
      return C && typeof C.isInLimitBattleStatus === 'function'
        ? C.isInLimitBattleStatus()
        : '(无符号)';
    }),
  );
  K(
    'TMWatchController.Instance.OriginCoord（观战坐标旁路）',
    safe(() => {
      const M = unwrap(PC.game.get('TMWatchController'), 'TMWatchController');
      const o = M && M.Instance && M.Instance.OriginCoord;
      return o ? { x: o.x, y: o.y } : null;
    }),
  );

  // ── B. 地图态：serverData 矩阵与视口（「我此刻在看哪个区」的权威源） ──────────
  H('B. 地图态 serverData / viewport');
  const ND = safe(() => unwrap(PC.game.get('NWorldMapData'), 'NWorldMapData').instance);
  const SD = ND && ND.serverData;
  if (!SD) {
    console.log('  NWorldMapData.instance.serverData 取不到（子包未载？）');
  } else {
    K('serverData.selfServerId', SD.selfServerId);
    K('serverData.currentServerId', SD.currentServerId);
    K('serverData.currentSubMap', SD.currentSubMap);
    K(
      'serverData.subMapArr',
      safe(() => JSON.stringify(SD.subMapArr)),
    );
    K(
      'serverMatrix 条目（k → display 偏移）',
      safe(() => {
        const out = {};
        SD.serverMatrix.forEach((v, kkey) => {
          out[kkey] = v && v.display ? { x: v.display.x, y: v.display.y } : v;
        });
        return JSON.stringify(out);
      }),
    );
    K(
      'serverPosMatrix 条目',
      safe(() => {
        const out = {};
        SD.serverPosMatrix.forEach((v, kkey) => {
          out[kkey] = v && v.display ? { x: v.display.x, y: v.display.y } : v;
        });
        return JSON.stringify(out);
      }),
    );
    K(
      'viewport.range（含 k=视口所在服号）',
      safe(() => JSON.stringify(ND.status.viewport.range)),
    );
    K(
      'viewport.zoomLevel',
      safe(() => ND.status.viewport.zoomLevel),
    );
    K(
      'viewport.centerPixels（镜头中心）',
      safe(() => JSON.stringify(ND.status.viewport.centerPixels)),
    );
    K(
      '我的城 display vs 镜头中心（dx/dy 越大说明 TAB 要飞越多远；两者接近=本来就在眼前）',
      safe(() => {
        const d = U2.game2displayWithServerLimit(WC && WC.x, WC && WC.y, U.ServerId, U.subServerID);
        const c = ND.status.viewport.centerPixels;
        if (!d || !c) return '(算不出)';
        return JSON.stringify({
          city: { x: Math.round(d.x), y: Math.round(d.y) },
          camera: { x: Math.round(c.x), y: Math.round(c.y) },
          dx: Math.round(d.x - c.x),
          dy: Math.round(d.y - c.y),
        });
      }),
    );
    K(
      'entities / marches / placeFlags 规模',
      safe(() => ND.entities.size + ' / ' + ND.marches.size + ' / ' + ND.placeFlags.size),
    );
  }
  K(
    'window.NWorldMapController.getCurServerId()（= 我们现在当 z 用的 viewServerId）',
    safe(() => {
      const c = window.NWorldMapController;
      return c && typeof c.getCurServerId === 'function' ? c.getCurServerId() : '(无方法)';
    }),
  );
  K(
    'mapType / isKVK / 其它战场标志',
    safe(() => {
      const GT = unwrap(PC.game.get('GameTools'), 'GameTools');
      const TM = unwrap(PC.game.get('CrossUtils'), 'CrossUtils');
      const f = (o, n) => (o && typeof o[n] === 'function' ? o[n]() : undefined);
      const flags = {
        mapType: safe(() => (PC.gameApi.worldMap.terrainModel() || {}).currentMapType),
        isKVK: f(GT, 'isKVK'),
        isCAB: f(GT, 'isCAB'),
        isNewCAB: f(GT, 'isNewCAB'),
        isEightCountry: f(GT, 'isEightCountry'),
        isInBorderMap: f(GT, 'isInBorderMap'),
        isTMServer: f(TM, 'isTMServer'),
        isMasterMatch: f(TM, 'isMasterMatch'),
        isPABServer: f(TM, 'isPABServer'),
        isTeamLegendServer: f(TM, 'isTeamLegendServer'),
        isEniNeutralMatch: f(TM, 'isEniNeutralMatch'),
      };
      return JSON.stringify(flags);
    }),
  );

  // ── C. 在当前这张图的数据里找「我的城」实体（最硬的本地证据） ────────────────
  H('C. entities 里属于我的 City 点（type=1）');
  const myUid = safe(() => String(U.UID));
  const matches = [];
  let scanned = 0;
  if (ND && ND.entities) {
    ND.entities.forEach((p) => {
      if (!p || ++scanned > 40000) return;
      if (p.type !== 1) return; // NWorldMapEntityType.City = 1
      const oid = p.pid != null ? p.pid : p.ownerId != null ? p.ownerId : p.owner;
      const pi = p.extData && p.extData.playerInfo;
      let piUid = null;
      if (typeof pi === 'string') {
        piUid = safe(() => String(JSON.parse(pi).uid || ''));
      } else if (pi && typeof pi === 'object') {
        piUid = String(pi.uid || '');
      }
      if (
        String(oid) === myUid ||
        (piUid && piUid === myUid) ||
        (WC && p.tileX === WC.x && p.tileY === WC.y)
      ) {
        matches.push({
          tileX: p.tileX,
          tileY: p.tileY,
          serverId: p.serverId,
          subMap: p.subMap,
          type: p.type,
          id: p.id,
          ownerId: oid,
          piUid: piUid,
          hit:
            (WC && p.tileX === WC.x && p.tileY === WC.y ? 'coord' : '') +
            (String(oid) === myUid || piUid === myUid ? (matches.length ? '+uid' : 'uid') : ''),
        });
      }
    });
  }
  console.log(
    '  扫描 entities ' +
      scanned +
      ' 条，命中 ' +
      matches.length +
      ' 条（我的城应恰好 1 条，3×3 城皮可能多条）',
  );
  matches.slice(0, 12).forEach((m, i) => console.log('  [' + i + ']', JSON.stringify(m)));
  if (!matches.length)
    console.log(
      '  %c（当前视口内没载入我的城点 → 说明还没飞到，属正常；重点看 D/E/F 段）',
      'color:#e0a800',
    );

  // ── D. 落点差异对拍：同一组 (x,y) 换不同 k 会落到哪（直接看出 TAB 现在飞去哪） ──
  H('D. game2displayWithServerLimit(x, y, k, subMap) 逐 k 落点对拍');
  if (!U2 || typeof U2.game2displayWithServerLimit !== 'function') {
    console.log('  NWorldMapUtils 符号不可得，跳过 D 段');
  } else {
    const gx = WC && WC.x;
    const gy = WC && WC.y;
    const cands = [
      {
        name: 'viewServerId(现在用的)',
        k: safe(() => PC.gameApi.worldMap.viewServerId()),
        sub: safe(() => U.subServerID),
      },
      { name: 'selfServerId(游戏原生)', k: SD && SD.selfServerId, sub: safe(() => U.subServerID) },
      { name: 'UserData.ServerId', k: safe(() => U.ServerId), sub: safe(() => U.subServerID) },
      {
        name: 'viewport.range.k',
        k: SD && ND && ND.status.viewport.range.k,
        sub: safe(() => U.subServerID),
      },
      { name: 'UserData.ServerId + subMap=0', k: safe(() => U.ServerId), sub: 0 },
      {
        name: 'OriginServerId(老区)',
        k: safe(() => U.OriginServerId),
        sub: safe(() => U.subServerID),
      },
      { name: '-1(游戏内回退本服)', k: -1, sub: -1 },
    ];
    // 想额外比对别的区号（比如盟友所在区）：跑本探针前先执行 window.__pcFlyProbeKs = [4336, 4337]
    (window.__pcFlyProbeKs || []).forEach((kk, idx) => {
      cands.splice(1 + idx, 0, {
        name: '自定义k#' + (idx + 1),
        k: kk,
        sub: safe(() => U.subServerID),
      });
    });
    cands.forEach((c) => {
      const d = safe(() => U2.game2displayWithServerLimit(gx, gy, c.k, c.sub));
      const cell = safe(() =>
        U2.game2cell({
          x: gx,
          y: gy,
          k: c.k < 0 ? U.ServerId : c.k,
          subMap: c.sub < 0 ? U.subServerID : c.sub,
        }),
      );
      console.log(
        '  %c' +
          c.name.padEnd(26) +
          ' k=' +
          c.k +
          ' subMap=' +
          c.sub +
          '  →  display=(' +
          (d && d.x != null ? Math.round(d.x) : d) +
          ',' +
          (d && d.y != null ? Math.round(d.y) : d) +
          ')  cell=(' +
          (cell && cell.cellX) +
          ',' +
          (cell && cell.cellY) +
          ')',
        'color:#7cb342',
      );
    });
    console.log(
      '  判定：display 差得最远的那条就是现在 TAB 的落点；与「selfServerId」条一致的才是真基地位置。',
    );
  }

  // ── E. 行军出发地交叉验证（零发包，本地 marches 缓存） ───────────────────────
  H('E. 本地 marches 的 begin{bx,by,bk,br}（出发地=基地，第三条独立证据）');
  if (ND && ND.marches) {
    let n = 0;
    ND.marches.forEach((m) => {
      if (n++ >= 5) return;
      const b = m && (m.begin || m.b);
      if (!b) return;
      console.log(
        '  march[' + (m.marchId || '') + '] begin=',
        JSON.stringify({ bx: b.bx, by: b.by, bk: b.bk, br: b.br, w: b.w, h: b.h }),
        'state=',
        m.state,
        'marchType=',
        m.marchType,
      );
    });
    if (!n) console.log('  （本地无行军数据，此段无输出属正常）');
  }

  // ── F. 630 PLAYER_INFO 服务端权威自查（一发只读查询） ────────────────────────
  H('F. 630 PLAYER_INFO 自查（服务端权威 x/y/serverId）');
  const net = PC.net;
  if (!net || !net.send) {
    console.log(
      '  pocketcc.net 不可用，手动跑：await window.pocketcc.net.send(630, { uid: "' +
        myUid +
        '" })',
    );
  } else {
    console.log(
      '  已发出 630（uid=' +
        myUid +
        '）：应答稍后落地。本轮没看到下面几行就等 1~2 秒再滚到控制台底部，或手动跑 window.__pcFlyProbe630()',
    );
    /** 留一个随时重跑的口子（只读查询），免得为了 630 再跑一整轮探针 */
    window.__pcFlyProbe630 = function () {
      return net.send(630, { uid: myUid }).then((r) => {
        console.warn('  [__pcFlyProbe630] ret=', r);
        return r;
      });
    };
    net
      .send(630, { uid: myUid })
      .then((ret) => {
        if (!ret || !ret.ok) {
          console.warn('  630 被拒/超时 s=', ret && ret.s, 'data=', ret && ret.data);
          return;
        }
        let d = ret.data;
        if (typeof d === 'string') d = safe(() => JSON.parse(d));
        let inner = d && d.playerInfo;
        if (typeof inner === 'string') inner = safe(() => JSON.parse(inner));
        window.__pcFlyHome630 = { d: d, inner: inner }; // 事后仍可取：window.__pcFlyHome630
        console.log(
          '  顶层字段:',
          JSON.stringify(
            d && {
              uid: d.uid,
              x: d.x,
              y: d.y,
              serverId: d.serverId,
              worldId: d.worldId,
              k: d.k,
              s: d.s,
            },
          ),
        );
        console.log(
          '  playerInfo:',
          JSON.stringify(
            inner && {
              uid: inner.uid,
              x: inner.x,
              y: inner.y,
              serverId: inner.serverId,
              worldId: inner.worldId,
              subServerID: inner.subServerID,
              rid: inner.rid,
            },
          ),
        );
        console.warn(
          '%c  对比：WorldCoord=(' +
            (WC && WC.x) +
            ',' +
            (WC && WC.y) +
            ') / UserData.ServerId=' +
            U.ServerId +
            ' / serverData.selfServerId=' +
            (SD && SD.selfServerId) +
            ' / 630=(x,y,serverId)=(' +
            ((inner && inner.x) != null ? inner.x : d && d.x) +
            ',' +
            ((inner && inner.y) != null ? inner.y : d && d.y) +
            ',' +
            ((inner && inner.serverId) != null ? inner.serverId : d && d.serverId) +
            ')',
          'color:#e0a800;font-weight:bold',
        );
      })
      .catch((e) => console.warn('  630 发送失败:', e && e.message));
  }

  console.log(
    '%c\n贴回全部轮次（A/B/C/D/E/F）即可定案。要补的关键证据只有两条：① 镜头停在「出问题那个区」那一轮的 B/D 段；② F 段 630 的 x/y/serverId 那行。',
    'color:#7cb342',
  );
})();
