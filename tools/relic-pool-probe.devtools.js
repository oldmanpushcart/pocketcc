/**
 * 遗迹礼品池探针（DevTools 一次性粘贴运行）—— 2 级道具遗迹
 *
 * 用途：把本盟两个 2 级道具遗迹「本轮实际开出的候选」逐条解析成游戏内的真实道具名，
 *   并与 feats/daily/relic-reward.js 里当前的 L2_ITEM_POOL 比对，输出：
 *     - console.table：每条候选（遗迹 / cfgId / index / 配置id / 真实道具名 / 数量 / 是否在池内）
 *     - extra：遗迹开出、但当前池里没有的名字 → 名字对不上就照这个补进 L2_ITEM_POOL
 *     - missingFromPool：池里有、本轮没开到的（一天只开部分属正常，多跑几轮再看）
 *     - 一行可直接复制替换 L2_ITEM_POOL 的数组（本轮所见全名，需你手动排优先级）
 *
 * 运行前提（都满足才有效）：
 *   1. 已加载 pocketcc 扩展并登录进游戏，处于主世界（MAIN world）控制台上下文（DevTools 默认即可）；
 *   2. 已加入联盟（否则查不到本盟遗迹）；
 *   3. 在网络 Home / 世界地图场景（net 已由 boot.js install）。
 *
 * 口径与 feat 完全一致：遗迹筛选 stronghold_level==2 && function==4；候选道具名取
 *   RewardController.Instance.getRewardsArrById(配置id)[0].name（feat 也是按 items[0].name 匹配）。
 *
 * 注意：每轮每遗迹只开 5 个候选、两个遗迹共 ≤10 个，池是 13 项，故单次跑不全见属正常；
 *   隔天/隔轮多跑几次，把各轮的 extra 合并核对即可。
 */
(async function relicPoolProbe() {
  const LEVEL = 2;
  const FUNTYPE_ITEM = 4;
  const CMD_QUERY = 1825; // GET_FORTRESS_CHOOSE_ITEM_REWARD_DATA
  // 当前 feat 里的礼品池（若你已改过 L2_ITEM_POOL，把新值同步到这里再跑）
  const POOL = [
    '大体力药剂',
    '金币砰砰宝箱',
    '训练加速1小时',
    '紫色万能碎片',
    '技能抽卡券',
    '3级强化部件宝箱',
    '核心建筑设计图',
    '科技道具自选箱',
    '职业道具自选宝箱',
    '绿色材料随机箱',
    '元素反应器零件',
    '元素宝箱',
    '军阵通用手册',
  ];
  const norm = (s) =>
    String(s == null ? '' : s)
      .replace(/\s+/g, '')
      .toLowerCase();
  const poolNormSet = new Set(POOL.map(norm));

  const PC = window.pocketcc;
  if (!PC || !PC.game || !PC.net) {
    console.error(
      '[relic-probe] window.pocketcc 未就绪：确认已加载扩展、登录进游戏（主世界上下文）。',
    );
    return;
  }

  const DC = PC.game.get('DataCenter');
  const u = DC && DC.DATA && DC.DATA.UserData;
  if (!u || typeof u.getWorldSiteArrayBy !== 'function') {
    console.error('[relic-probe] UserData.getWorldSiteArrayBy 不可用（符号漂移或数据未就绪）。');
    return;
  }
  const aid = Number(u.Alliance && u.Alliance.Aid) || 0;
  if (!aid) {
    console.error('[relic-probe] 当前不在联盟（Aid=0），查不到本盟遗迹。先加入联盟再跑。');
    return;
  }

  const RC = PC.game.get('RewardController');
  const K = RC && (RC.RewardController || (RC.default && RC.default.RewardController));
  if (!K || !K.Instance || typeof K.Instance.getRewardsArrById !== 'function') {
    console.error('[relic-probe] RewardController.Instance.getRewardsArrById 不可用（符号漂移）。');
    return;
  }
  const rewardItems = (id) => {
    try {
      const a = K.Instance.getRewardsArrById(Number(id));
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  };

  const sites = (u.getWorldSiteArrayBy(aid) || []).filter((s) => {
    const dd = s && s.DistrictData;
    return dd && Number(dd.stronghold_level) === LEVEL && Number(dd.function) === FUNTYPE_ITEM;
  });
  if (!sites.length) {
    console.warn('[relic-probe] 本盟没有 2 级道具遗迹（stronghold_level=2 且 function=4）。');
    return;
  }

  const seen = new Map(); // 真实道具名 -> { cfgIds:Set, relics:Set }
  const rows = [];
  for (const s of sites) {
    const wonderId = Number(s.Id) || 0;
    const siteName = String(s.SiteName || s.SiteDefaultName || '遗迹' + wonderId);
    let payload;
    try {
      const ret = await PC.net.send(CMD_QUERY, { wonderId: wonderId });
      if (!ret.ok) {
        console.warn(
          '[relic-probe] 遗迹 %d(%s) 查询被拒 code=%s data=%s',
          wonderId,
          siteName,
          ret.code,
          ret.data,
        );
        continue;
      }
      payload = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data;
    } catch (e) {
      console.warn('[relic-probe] 遗迹 %d 查询异常（超时/未 install？）', wonderId, e);
      continue;
    }

    const select = Array.isArray(payload && payload.select) ? payload.select : [];
    const cfgId = Number(payload && payload.id) || 0;
    for (let idx = 0; idx < select.length; idx++) {
      const rid = select[idx];
      const items = rewardItems(rid);
      const itId = items[0] && items[0].id != null ? Number(items[0].id) : '';
      const nm = items[0] && items[0].name ? String(items[0].name) : '(解析失败)';
      const cnt = items[0] ? items[0].count : '';
      const inPool = poolNormSet.has(norm(nm));
      rows.push({
        遗迹: siteName,
        cfgId: cfgId,
        index: idx,
        配置id: rid,
        itemId: itId,
        真实道具名: nm,
        数量: cnt,
        在池内: inPool ? '✓' : '✗',
      });
      if (nm !== '(解析失败)') {
        if (!seen.has(nm)) seen.set(nm, { itemId: itId, cfgIds: new Set(), relics: new Set() });
        seen.get(nm).cfgIds.add(rid);
        seen.get(nm).relics.add(siteName);
      }
    }
  }

  console.table(rows);

  const seenNames = [...seen.keys()];
  const extra = seenNames.filter((n) => !poolNormSet.has(norm(n))); // 遗迹开出、池里没有
  const missingFromPool = POOL.filter((n) => !seenNames.some((s) => norm(s) === norm(n))); // 池里有、本轮没开到

  const H = (msg) => console.log('%c' + msg, 'color:#4a90d9;font-weight:bold');
  H('[relic-probe] 本轮实际开到的道具（itemId ← name）：');
  console.log(seenNames.map((n) => seen.get(n).itemId + '  ' + n));
  console.log(
    '%c[relic-probe] ★ 池里没有、但遗迹开出的（名字对不上就照这个补/改 L2_ITEM_POOL）：',
    'color:#e07b00;font-weight:bold',
  );
  console.log(extra.length ? extra : '（无，池已覆盖本轮全部候选）');
  console.log(
    '%c[relic-probe] 池里有、但本轮没开到的（一天只开部分属正常，多跑几轮再核）：',
    'color:#888888',
  );
  console.log(missingFromPool.length ? missingFromPool : '（无）');
  console.log(
    '%c[relic-probe] 可直接替换 L2_ITEM_POOL 的 itemId 数组（本轮所见，需你手动排优先级）：',
    'color:#2aa198;font-weight:bold',
  );
  console.log(
    'const L2_ITEM_POOL = [\n    ' +
      seenNames.map((n) => seen.get(n).itemId).join(', ') +
      ',  // ' +
      seenNames.join(' / ') +
      '\n];',
  );
})();
