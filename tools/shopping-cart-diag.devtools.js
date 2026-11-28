/**
 * 购物车「今日已完成」误判取证探针 v1（控制台整段粘贴；只读，只发 4204 查询，绝不发 4203 购买）。
 *
 * 用法：登录出问题的号并进入游戏页面（Console 上下文 = top）→ 整段粘贴 → 把输出的 JSON 全部贴回。
 * 前置：dev 构建（window.pocketcc 在场）+ 扩展网络底座已 install（登录完成）；release 构建无调试面无输出。
 *
 * 判读口径（输出末尾 conclusion 已是人话结论）：
 * - rows 里每行的 verdict 与 feat 规划器同口径（done / capped / pending / planned）；
 *   gameRemain = 游戏「今日剩余N次」（buy_limit − purchasedBuyNum，仅限购项）；
 *   gameWouldBuy = 游戏一键兑换这一次会替该项买几件 = min(max(buy_limit − purchased, 0), chooseNum)。
 * - feat 口径 gap = chooseNum − purchasedBuyNum：gap ≤ 0 即判「今日已完成」，不看限购余量。
 *   若某行 verdict=done 但 gameRemain>0 → 本报告的典型形态：勾选数与限购余量的语义分歧。
 * - skipped 行 = ACL fail-closed（配置缺失 / 联盟折扣读不到等）；面板在「全了结」时直接显示
 *   「今日已完成」，不披露被跳过的项（statusText 提前 return 的分支）。
 * - 若 probePlan 会发包而 panelText 仍显示「今日已完成」→ 面板是旧快照（购物车在上一轮扫描后
 *   才变化，而 feat 全了结后会睡到日界，期间零发包）。
 */
(() => {
  const P = window.pocketcc;
  if (!P || !P.net || !P.gameApi || !P.game) {
    console.log(
      '[cart-diag] window.pocketcc 未就绪：需要 dev 构建 + 游戏页 top 上下文 + 已登录（release 构建无调试面）',
    );
    return;
  }
  const GD = P.gameApi.gameData;
  const BITS = P.gameApi.bits;
  const L10N = P.gameApi.l10n;
  const TABLES = {
    2: 'SHOP',
    3: 'VIP_SHOP',
    4: 'LEGIONSHOP',
    5: 'EXPEDITION_SHOP',
    6: 'ISLAND_SHOP',
    7: 'MINING',
    12: 'csb_shop',
    13: 'ALLIANCE_SHOP',
    14: 'recovery_shop',
    16: 'behemoth_shop',
  };
  const SHOP_NAMES = {
    1: 'SUPPLY_GIFT(补给)',
    2: 'ITEM_SHOP(道具商店)',
    3: 'VIP_SHOP(VIP商店)',
    4: 'LEGION_SHOP(军团商店)',
    5: 'ADVENTURE_SHOP(远征商店)',
    6: 'ISLANDBATTLE_SHOP(海岛商店)',
    7: 'ITEMEXCHANGE_SHOP(道具兑换)',
    12: 'CROSS_SERVER_BATTLE_SHOP(跨服战场)',
    13: 'ALLIANCE_SHOP(联盟商店)',
    14: 'ITEM_RECYCLE(道具回收)',
    15: 'DECORATION_SHOP(装饰商店)',
    16: 'ALLIANCE_BEBEMOTH_SHOP(联盟巨兽)',
    17: 'DECORATION_RESIDENT_SHOP(居民商店)',
  };
  const out = { at: new Date().toISOString() };
  out.serverTime = GD.serverTime();
  out.nextDailyReset = GD.nextDailyResetTs();
  out.featRunning = !!(P.reactor && P.reactor.isRunning && P.reactor.isRunning('shoppingCart'));
  try {
    const spec = (P.reactor.list() || []).find((s) => s.id === 'shoppingCart');
    out.panelText =
      spec && spec.fields && spec.fields[0] && spec.fields[0].get ? spec.fields[0].get() : null;
  } catch (e) {
    out.panelText = 'err:' + (e && e.message);
  }

  (async () => {
    const q = await P.net.sendGuarded(4204, { header: {} }, { protocol: 'sendPB', gate: false });
    out.query = { ok: !!(q && q.ok), code: q ? q.code : null, reason: (q && q.reason) || null };
    const ack = q && q.data && q.data.shoppingCarInfo;
    if (!ack || !Array.isArray(ack.singleShopData)) {
      out.note = '4204 应答没有 shoppingCarInfo.singleShopData（查询失败或协议形态变了）';
      console.log(JSON.stringify(out, null, 1));
      return;
    }
    const raw = ack.singleShopData;
    out.tableReady = !!(L10N && L10N.tableReady && L10N.tableReady());
    out.rawKeys =
      raw[0] && raw[0].productPurchasedData && raw[0].productPurchasedData[0]
        ? Object.keys(raw[0].productPurchasedData[0])
        : [];

    // ---- 与 feat 完全同源的 ACL 投影（gameData.shoppingCart = normalizeShoppingCart）----
    const cart = GD.shoppingCart(raw);
    out.projection = cart ? { items: cart.items, skipped: cart.skipped } : null;

    // ---- 货币快照（投影里 balance 的取数来源）----
    let u = null;
    try {
      u = P.game.get('DataCenter').DATA.UserData;
    } catch (e) {
      // DataCenter 取不到就留空，balances 输出 null
    }
    out.balances = u
      ? {
          Gold: u.Resource && u.Resource.Gold,
          BountyMilitary: u.Resource && u.Resource.BountyMilitary,
          AdventureCoin: u.Resource && u.Resource.AdventureCoin,
          CsbRes: u.Resource && u.Resource.CsbRes,
          Honor: u.Resource && u.Resource.Honor,
          IslandPoints: u.IslandBattleData && u.IslandBattleData.points,
        }
      : null;
    // ---- 游戏本地已买表（UI「今日剩余N次」与游戏一键同源；用于和 4204 应答对账）----
    try {
      const m = u && u.shoppingCollectMap;
      out.localCollectMap = {};
      if (m && typeof m.forEach === 'function') {
        m.forEach((rows, k) => {
          out.localCollectMap[k] = (rows || []).map((r) => ({
            productId: String(r.productId),
            chooseNum: r.chooseNum,
            purchasedBuyNum: r.purchasedBuyNum,
          }));
        });
      }
    } catch (e) {
      out.localCollectMap = 'err:' + (e && e.message);
    }

    // ---- 逐行 verdict：复刻 plan.js（feat 口径）+ openOneClickBuyPanel（游戏口径）----
    const items = (cart && cart.items) || [];
    const skippedRows = (cart && cart.skipped) || [];
    const byKey = new Map(items.map((it) => [it.shopType + ':' + it.productId, it]));
    const skipByKey = new Map(skippedRows.map((s) => [s.shopType + ':' + s.productId, s.reason]));
    const pool = Object.create(null);
    const rows = [];
    const cfgBrief = (table, productId) => {
      if (!table) return null;
      const cfg = L10N.tableRow(table, productId);
      if (!cfg) return null;
      let itemName = null;
      try {
        const itemCfg = cfg.item_id != null ? L10N.tableRow('ITEM', cfg.item_id) : null;
        itemName = itemCfg && itemCfg.name ? L10N.text(itemCfg.name) : null;
      } catch (e) {
        // 名称只是附属信息，读不到就留空
      }
      return {
        id: cfg.id,
        item_id: cfg.item_id,
        itemName,
        price_shop: cfg.price_shop,
        buy_limit: cfg.buy_limit,
        timeBuyLimit: cfg.timeBuyLimit,
        limit: cfg.limit,
        needItem: cfg.needItem,
        costItemId: cfg.costItemId,
        costItemNum: cfg.costItemNum,
      };
    };
    for (let i = 0; i < raw.length; i++) {
      const shop = raw[i];
      const shopType = Number(shop && shop.shopType) || 0;
      const table = TABLES[shopType] || null;
      const list = (shop && shop.productPurchasedData) || [];
      for (let j = 0; j < list.length; j++) {
        const r = list[j];
        const productId =
          BITS && BITS.int64Str ? BITS.int64Str(r && r.productId) : String(r && r.productId);
        const chooseNum = Number(r.chooseNum) || 0;
        const purchased = Number(r.purchasedBuyNum) || 0;
        const key = shopType + ':' + productId;
        const it = byKey.get(key);
        const row = {
          shopType,
          shopName: SHOP_NAMES[shopType] || 'unknown(' + shopType + ')',
          table,
          productId,
          chooseNum,
          purchasedBuyNum: purchased,
          gap: chooseNum - purchased,
        };
        if (!it) {
          row.verdict = skipByKey.has(key)
            ? 'skipped:' + skipByKey.get(key)
            : 'dropped(not-in-projection)';
          row.cfg = cfgBrief(table, productId);
          rows.push(row);
          continue;
        }
        row.price = it.price;
        row.buyLimit = it.buyLimit;
        row.currencyKey = it.currencyKey;
        row.balance = it.balance;
        row.gameRemain = Number.isFinite(it.buyLimit) ? Math.max(it.buyLimit - purchased, 0) : null;
        if (row.gap <= 0) {
          row.verdict = 'done';
        } else if (!Number.isFinite(it.buyLimit) || it.buyLimit < -1) {
          row.verdict = 'capped(limit-invalid)';
        } else {
          const want = it.buyLimit === -1 ? row.gap : Math.min(row.gap, it.buyLimit - purchased);
          if (!(want > 0)) {
            row.verdict = 'capped(limit-used)';
          } else {
            const k = String(it.currencyKey);
            if (pool[k] == null) pool[k] = Number(it.balance) || 0;
            const qty = Math.min(want, it.price > 0 ? Math.floor(pool[k] / it.price) : want);
            if (!(qty > 0)) {
              row.verdict = 'pending(no-balance)';
            } else {
              pool[k] -= it.price * qty;
              row.verdict = 'planned x' + qty;
              row.buyQty = qty;
            }
          }
        }
        // 游戏 openOneClickBuyPanel 口径：T = min(max(limit − have, 0), collectNum)
        if (Number.isFinite(it.buyLimit) && it.buyLimit >= -1) {
          const g = it.buyLimit === -1 ? Number.MAX_SAFE_INTEGER : it.buyLimit;
          row.gameWouldBuy = Math.min(Math.max(g - purchased, 0), chooseNum);
        }
        rows.push(row);
      }
    }
    out.rows = rows;
    out.probePlan = {
      items: items.length,
      skipped: skippedRows.length,
      done: rows.filter((x) => x.verdict === 'done').length,
      capped: rows.filter((x) => /^capped/.test(x.verdict)).length,
      pending: rows.filter((x) => /^pending/.test(x.verdict)).length,
      planned: rows.filter((x) => /^planned/.test(x.verdict)).length,
    };
    out.conclusion = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const head = row.shopName + ' #' + row.productId;
      if (row.verdict === 'done' && row.gameWouldBuy > 0) {
        out.conclusion.push(
          head +
            ': chooseNum=' +
            row.chooseNum +
            ' purchased=' +
            row.purchasedBuyNum +
            ' limit=' +
            row.buyLimit +
            ' → feat 判 done，但限购还剩 ' +
            row.gameRemain +
            '（游戏一键会再买 ' +
            row.gameWouldBuy +
            ' 件）【语义分歧】',
        );
      } else if (/^skipped|^dropped/.test(row.verdict)) {
        out.conclusion.push(
          head + ': 未进规划（' + row.verdict + '）→ 面板「今日已完成」时不披露该项',
        );
      } else if (/^pending/.test(row.verdict)) {
        out.conclusion.push(
          head +
            ': 余额不足 price=' +
            row.price +
            ' balance=' +
            row.balance +
            ' → 该显示「等余额」，不该是「今日已完成」',
        );
      } else if (/^planned/.test(row.verdict)) {
        out.conclusion.push(
          head +
            ': 此刻规划会买 ' +
            row.verdict +
            ' → 面板若仍显示「今日已完成」，即为旧快照（扫描后购物车变了/已睡到日界）',
        );
      }
    }
    if (!out.conclusion.length) out.conclusion.push('未发现异常：此刻规划与服务端状态一致');
    console.log('[cart-diag] 取证结果（整段贴回即可）：');
    console.log(JSON.stringify(out, null, 1));
  })();
})();
