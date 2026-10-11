/**
 * 难民营（autoHunt 道具开营行）不激活排查探针（DevTools 一次性粘贴，MAIN world 控制台）
 *
 * 用途：背包确有 38 封求救信、但面板勾了难民营却始终不派发时，逐闸口实证「卡在哪一环」。
 *   探针不依赖 feat 内部对象，只用 window.pocketcc 暴露面（reactor/storage/gameApi/net/bus）复算
 *   auto-hunt.js cyclePass 难民营分支的每一道闸门，并可选地**亲发一次 815** 观察 10802 落点推送的真实载荷，
 *   直接验证「Event 解包取 ev.data」这条修复对不对、以及「用信是否会自动回推 10802」这条协议假设成不成立。
 *
 * 难民营链路（实证 dashcam 20261012T022955）：
 *   815 ITEM_USE req {itemid:1700039,amount:1} → 10401 PUSH_TOOL {itemId:1700039,amount:剩余} →
 *   10802 PUSH_FIND_REFUGEECAMP {x,y}（落点唯一来源）→ 1201 集结(marchType:8,x,y,time:60,armyList,armyListNew,heroList,trapList,formation:0,formationV2)
 *
 * 运行前提：已加载扩展并登录进游戏、处于 MAIN world（pocketcc 全局可见）、且在主城/世界图场景（feat kinds=['homeland']）。
 *
 * 用法：
 *   pocketcc.probeRefugee()                  // 只读：跑 A–E 五段闸门体检（不发任何包）
 *   pocketcc.probeRefugee({ use: true })     // 追加：亲发一次 815 用掉一封信，观察 10802 是否回推及载荷形态（消耗 1 封信）
 *   pocketcc.probeRefugee({ use: true, rally: true })  // 再追加：拿到落点后按 feat body 发 1201 真集结（消耗体力+占行军位，确认末端可用）
 * 末尾把控制台各段原文贴回即可定位（判读见 F 段）。
 */
window.pocketcc &&
  (window.pocketcc.probeRefugee = async function (opts) {
    opts = opts || {};
    const PC = window.pocketcc;
    if (!PC || !PC.reactor || !PC.net || !PC.gameApi || !PC.bus || !PC.storage) {
      console.error(
        '[refugee-probe] window.pocketcc 未就绪（缺 reactor/net/gameApi/bus/storage）：确认已加载扩展、已登录、MAIN world 上下文。',
      );
      return;
    }
    const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
    const OK = (m) => console.log('%c✔ ' + m, 'color:#2e9e57');
    const NO = (m) => console.log('%c✘ ' + m, 'color:#d0453b');
    const WARN = (m) => console.log('%c⚠ ' + m, 'color:#e0a53c');
    const gameData = PC.gameApi.gameData;

    // 与 auto-hunt.js 对齐的常量
    const LETTER = 1700039; // ActivityItem.refugeeLetter（求救信道具 id）
    const CMD_ITEM_USE = 815;
    const PUSH_FIND_REFUGEECAMP = 10802;
    const PUSH_TOOL = 10401;
    const CMD_CREATE_RALLY = 1201;
    const MT_RALLY = 8;
    const STAMINA_TYPE = 1;
    const WAIT_MS = 6000; // cfg.refugeeWaitMs 同值
    const MODE_COST = { rally5: 10, rally10: 20 };

    const verdicts = [];
    const V = (pass, msg) => {
      verdicts.push({ pass, msg });
      pass ? OK(msg) : NO(msg);
    };

    // ── A. feat 运行态与场景 ──────────────────────────────────────
    H('A. reactor 运行态 / 场景');
    const running = PC.reactor.isRunning('autoHunt');
    console.log("reactor.isRunning('autoHunt') =", running);
    try {
      const ws = PC.worldState && PC.worldState.dump ? PC.worldState.dump() : null;
      console.log('worldState =', ws);
    } catch (e) {
      console.log('worldState 取用异常:', e && e.message);
    }
    V(
      running,
      'feat 正在运行（若 ✘：多半是场景不在 homeland / 战斗模式 offInCombat 下线 / 面板总开关未开）',
    );

    // ── B. 背包求救信读取（双口径对照）───────────────────────────
    H('B. 背包求救信数量（ACL 口径 vs 原始 _items 口径）');
    const aclAmt = (() => {
      try {
        return gameData.itemAmount(LETTER);
      } catch (e) {
        return 'err:' + e.message;
      }
    })();
    console.log('gameData.itemAmount(1700039) =', aclAmt, '（feat 闸门用的就是这个）');
    const rawItem = (() => {
      try {
        const u = (PC.game.get('DataCenter') || {}).DATA.UserData;
        const it = (u && u._items ? u._items : []).find((x) => x && x.ItemId === LETTER);
        return it ? { ItemId: it.ItemId, Amount: it.Amount } : null;
      } catch (e) {
        return 'err:' + e.message;
      }
    })();
    console.log(
      'UserData._items[1700039] =',
      rawItem,
      '（getItemAmount 只扫 _items；此格能佐证登录是否把工具背包同步进 _items）',
    );
    V(Number(aclAmt) > 0, '闸门「背包有信」通过（读到 ' + aclAmt + '）');

    // ── C. 体力与档位 cost ────────────────────────────────────────
    H('C. 体力闸（全局下限 + 该行 cost）');
    const en = (() => {
      try {
        return gameData.energy(STAMINA_TYPE);
      } catch (e) {
        return null;
      }
    })();
    const stamina = en ? en.point : null;
    console.log('energy(1) =', en, '→ 当前体力 stamina =', stamina);

    // ── D. 存储里的面板配置（难民营行是否真勾选、预设/下限）────────
    H('D. 面板存储配置 pocketcc.feat.autoHunt');
    let cfg = null;
    try {
      cfg = await PC.storage.get('pocketcc.feat.autoHunt');
    } catch (e) {
      console.log('读配置异常（命名空间/桥接）:', e && e.message);
    }
    console.log('cfg =', cfg);
    let refugeeRow;
    if (cfg) {
      const presets = Array.isArray(cfg.presets) ? cfg.presets : [];
      V(cfg.enabled !== false, '面板总开关 enabled（=' + cfg.enabled + '）');
      V(
        presets.length > 0,
        '打野预设池非空（=' + JSON.stringify(presets) + '；空则 cyclePass 直接 idle 不派）',
      );
      refugeeRow = (Array.isArray(cfg.huntlist) ? cfg.huntlist : []).find(
        (r) => r && r.key === 'refugeeCamp',
      );
      console.log('难民营行 =', refugeeRow);
      V(
        !!(refugeeRow && refugeeRow.on),
        '难民营行已勾选 on=true（=' + (refugeeRow && refugeeRow.on) + '）',
      );
      const mode = refugeeRow ? refugeeRow.mode : 'rally5';
      const cost = MODE_COST[mode] || 0;
      console.log('该行攻打方式 mode =', mode, '→ 该行体力下限 cost =', cost);
      if (stamina != null) {
        V(
          stamina >= cost,
          'stamina(' + stamina + ') ≥ 该行 cost(' + cost + ')（不足则该行逐拍被跳过）',
        );
        const minS = Number(cfg.minStamina) || 0;
        V(
          stamina >= minS,
          'stamina(' + stamina + ') ≥ 全局体力下限 minStamina(' + minS + ')（不足则整轮早退）',
        );
      } else {
        WARN(
          '体力镜像读不到（stamina=null）：feat 会判「未就绪」本轮不动，稍后再测或确认在正确的世界场景',
        );
      }
    } else {
      WARN('未读到配置：可能未安装成功/命名空间未就绪。先确认面板能打开且勾了难民营。');
    }

    // ── E. 815 在途 / 1201 集结在途 冲突 ──────────────────────────
    H('E. 发包在途冲突（isSending）');
    const sending815 = (() => {
      try {
        return PC.net.isSending(CMD_ITEM_USE);
      } catch (e) {
        return 'err';
      }
    })();
    const sending1201 = (() => {
      try {
        return PC.net.isSending(CMD_CREATE_RALLY);
      } catch (e) {
        return 'err';
      }
    })();
    console.log(
      'net.isSending(815) =',
      sending815,
      '（true 时 openRefugeeCamp 本轮直接跳过——补体力也用 815，可能撞车）',
    );
    console.log(
      'net.isSending(1201) =',
      sending1201,
      '（true 时 cyclePass 对集结行 break，难民营本轮不派）',
    );

    // ── F. 协议链路实测（默认只观察；opts.use 才真发 815）──────────
    H('F. 10802 落点链路实测');
    const seen = { p10802: [], p10401: [], resp815: [], req815: [] };
    const offs = [];
    const onBus = (type, fn) => offs.push(PC.bus.on(type, fn));
    onBus('net.' + PUSH_FIND_REFUGEECAMP, (ev) => {
      seen.p10802.push(ev);
      const d = ev && ev.data;
      console.log(
        '%c[10802] 收到落点推送',
        'color:#2e9e57;font-weight:bold',
        'ev.data =',
        d,
        '；typeof ev.data =',
        typeof d,
        '；ev.data.x/y =',
        d && d.x,
        d && d.y,
        '；(直接读 ev.x/ev.y 会得到)',
        ev && ev.x,
        ev && ev.y,
        '← 这就是历史 bug：把 Event 当业务对象读不到 x/y',
      );
    });
    onBus('net.' + PUSH_TOOL, (ev) => {
      const d = ev && ev.data;
      if (d && d.itemId === LETTER) {
        seen.p10401.push(d);
        console.log(
          '[10401 PUSH_TOOL] 求救信数量刷新 →',
          d,
          '（这条把量写进 UserData._items，供 itemAmount 读）',
        );
      }
    });
    onBus('net.resp.' + CMD_ITEM_USE, (ev) => {
      seen.resp815.push(ev && ev.data);
      console.log('[resp 815] 应答 →', ev && ev.data);
    });
    if (PC.net.onReq) {
      offs.push(
        PC.net.onReq(CMD_ITEM_USE, (r) => {
          seen.req815.push(r && r.data);
          console.log('[req 815] 本端已发出 →', r && r.data);
        }),
      );
    }

    if (!opts.use) {
      console.log(
        '%c只读观察已挂起（60s）。要实测用信回推，请再跑：pocketcc.probeRefugee({ use:true })（消耗 1 封信）',
        'color:#e0a53c',
      );
      // 也可：不发包，直接在背包/难民营界面手动用掉一封信，看上面 [10802]/[10401] 是否打印、形态如何。
      setTimeout(() => {
        offs.forEach((f) => {
          try {
            typeof f === 'function' && f();
          } catch (e) {}
        });
        console.log('[refugee-probe] 观察窗结束，监听已摘除。');
      }, 60000);
    } else {
      H('F+. 亲发一次 815 复现 openRefugeeCamp（等待 10802 最多 ' + WAIT_MS + 'ms）');
      if (Number(aclAmt) <= 0)
        WARN(
          '背包读到 0 信，仍尝试发送（服务器多半拒绝、多半无 10802）——这正好验证「_items 未同步」假设',
        );
      if (sending815)
        WARN('此刻 815 已在途，feat 的 openRefugeeCamp 同样会因此跳过本轮；探针继续试发');
      const got = await new Promise((resolve) => {
        let done = false;
        const finish = (val) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          try {
            off && off();
          } catch (e) {}
          resolve(val);
        };
        // 只认发送之后新到的 10802（用时间戳与已有计数区隔旧包）
        const off = PC.bus.on('net.' + PUSH_FIND_REFUGEECAMP, (ev) =>
          finish((ev && ev.data) || null),
        );
        const t = setTimeout(() => finish(null), WAIT_MS);
        PC.net
          .send(CMD_ITEM_USE, { itemid: LETTER, amount: 1 })
          .then((ret) => console.log('[use:true] 815 发送返回 Ret =', ret))
          .catch((e) => console.warn('[use:true] 815 发送异常:', e && e.message));
      });
      if (got && got.x != null && got.y != null) {
        OK(
          '10802 回推正常，落点 x=' +
            (got.x | 0) +
            ' y=' +
            (got.y | 0) +
            '（feat 的 ev.data 解包口径正确，链路可打通）',
        );
        if (opts.rally) {
          H('G. 追加实测 1201 真集结（feat 同款 body，消耗体力+占行军位）');
          const rallyRet = await PC.net
            .send(CMD_CREATE_RALLY, {
              marchType: MT_RALLY,
              x: got.x | 0,
              y: got.y | 0,
              time: 60,
              armyList: [],
              armyListNew: [],
              heroList: [],
              trapList: [],
              formation: 0,
              formationV2: 0,
            })
            .then((r) => r)
            .catch((e) => ({ ok: false, err: '' + e }));
          console.log(
            '[1201] 集结返回 =',
            rallyRet,
            '（armyList 空多半被拒，仅验证请求能否成型/10802→1201 通路）',
          );
        } else {
          console.log(
            '（未加 rally:true，跳过 1201；要看末端是否可集结再跑 {use:true,rally:true}）',
          );
        }
      } else if (got) {
        NO(
          '10802 到了但载荷里没有 x/y：ev.data =',
          got,
          '← 说明回推形态与预期不符，需贴回原文核对协议',
        );
      } else {
        NO(
          '发出 815 后 ' +
            WAIT_MS +
            'ms 内没收到任何 10802 落点推送 ← 这才是难民营「不激活」的根因：用信没有自动回推营地坐标（可能需先在游戏内触发一次，或该信根本不该由 feat 直发）',
        );
      }
      // 摘除临时监听
      offs.forEach((f) => {
        try {
          typeof f === 'function' && f();
        } catch (e) {}
      });
    }

    // ── 判读汇总 ──────────────────────────────────────────────────
    H('判读速查（把以上各段原文贴回）');
    console.table(verdicts.map((v) => ({ 通过: v.pass ? 'YES' : 'NO', 闸口: v.msg })));
    console.log(
      [
        'A.isRunning=false → feat 没跑：场景非 homeland / 战斗模式下线 / 面板未启用（先解决这个，后面都无从谈起）。',
        'B.itemAmount=0 → 登录后工具背包未同步进 _items：手动用/查看一封信触发 10401 后即恢复（你背包有 38，此闸应 YES）。',
        'D.任一 NO → 对应面板配置没设好：勾选难民营行 / 预设池非空 / 体力≥该行cost / 体力≥minStamina。',
        'E.sending815/sending1201 常 true → 与其它 815 用途（补体力）或别的集结撞车，本轮被跳过。',
        'F.use:true 无 10802 → 协议假设不成立（用信不自动回推营地），这是「什么都不发也没营地」的真因，需换落点来源。',
        'F.use:true 有 x,y → 链路是通的；那问题只可能在上面 A–E 的某个闸门，按 NO 项修即可。',
      ].join('\n'),
    );
  });

// 粘贴即跑一次只读体检（要实测发信再手动调 pocketcc.probeRefugee({use:true})）
window.pocketcc && window.pocketcc.probeRefugee && window.pocketcc.probeRefugee();
