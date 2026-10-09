/**
 * 遗迹配置表提取器（DevTools 一次性粘贴运行）—— 从运行时内存整表 dump
 *
 * 目的：把 sp_fortress_item（遗迹奖励配置表）与它引用的 reward（奖励配置表）在本地的
 *   真实数据扒出来，弄清「一个遗迹的 13 项奖励池」到底存在哪、由哪些 reward id 组成，
 *   并把每个 reward id 解析成 {itemId, 道具名, 数量}。这样 L2_ITEM_POOL 可离线定稿。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏（配置表在登录流程里被下发+解析进内存），
 *   处于主世界（MAIN world）控制台上下文。不需要在网络场景，也不用发包。
 *
 * 数据来源：游戏运行时 TableManager.TABLE（_tableMap 内存表），与游戏面板同源：
 *   - 遗迹表：TableName.sp_fortress_item，行 key = cfgId（1825 应答里的 id 字段），含 choose_num / join_time 等。
 *   - 奖励表：TableName.REWARD（"reward"），行 key = reward 配置 id（1825 应答 select[] 里的那些数字）。
 *   解析口径与 feat 一致：RewardController.Instance.getRewardsArrById(rewardId)[0] → {id:itemId,name,count}。
 */
(function relicTableDump() {
  // ── 可调：暴力扫描的 reward id 区间（覆盖观测到的 8301732..8301754；不够就加大）──
  const BRUTE_LO = 8301700;
  const BRUTE_HI = 8301800;

  const PC = window.pocketcc;
  if (!PC || !PC.game || typeof PC.game.get !== 'function') {
    console.error(
      '[relic-dump] window.pocketcc.game.get 不可用：确认已加载扩展并登录进游戏（主世界上下文）。',
    );
    return;
  }
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      console.warn('[relic-dump] game.get(%s) 失败', n, e);
      return null;
    }
  };

  const TM = G('TableManager');
  const TABLE = TM && (TM.TABLE || (TM.default && TM.default.TABLE));
  if (!TABLE || typeof TABLE.getTableGroupArray !== 'function') {
    console.error('[relic-dump] TableManager.TABLE 不可用（符号漂移？），拿不到内存表。');
    return;
  }
  const TNm = G('TableName');
  const TN = (TNm && (TNm.TableName || (TNm.default && TNm.default.TableName))) || {};
  const itemTable = TN.sp_fortress_item || 'sp_fortress_item';
  const rewardTable = TN.REWARD || TN.reward || 'reward';

  const RC = G('RewardController');
  const K = RC && (RC.RewardController || (RC.default && RC.default.RewardController));
  const rewardItems = (id) => {
    try {
      const a = K && K.Instance && K.Instance.getRewardsArrById(Number(id));
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  };

  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  H('表名解析');
  console.log({
    itemTable,
    rewardTable,
    REWARD_member: TN.REWARD,
    sp_fortress_item_member: TN.sp_fortress_item,
  });

  // ── 1) sp_fortress_item 整表原样 dump ──
  H('1) sp_fortress_item 整表（遗迹奖励配置）');
  let itemRows = [];
  try {
    itemRows = TABLE.getTableGroupArray(itemTable) || [];
  } catch (e) {
    console.error('[relic-dump] 读 sp_fortress_item 失败', e);
  }
  console.log('行数:', itemRows.length);
  if (itemRows.length) {
    console.table(
      itemRows.map((r) => ({
        id: r.id,
        choose_num: r.choose_num,
        join_time: r.join_time,
        item: r.item,
        reward: r.reward,
        prize: r.prize,
        pool: r.pool,
      })),
    );
    console.log('%c原始 JSON（整表，可复制贴回）：', 'color:#888');
    console.log(JSON.stringify(itemRows));
  }

  // ── 2) 深挖每行的「数字列表」字段（疑似奖励 id 池）──
  H('2) 每行里形如 "83xxxxx,83xxxxx,..." 的数字列表字段（候选奖励池）');
  const listRe = /^\s*\d{5,}(?:\s*[,;|]\s*\d{5,})+\s*$/;
  const poolByCfg = {};
  for (const r of itemRows) {
    const found = [];
    const walk = (obj, path) => {
      if (!obj || typeof obj !== 'object') return;
      for (const k in obj) {
        const v = obj[k];
        const p = path ? path + '.' + k : k;
        if (typeof v === 'string' && listRe.test(v))
          found.push({ field: p, ids: v.split(/[,;|]/).map((x) => Number(x.trim())) });
        else if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'number'))
          found.push({ field: p, ids: v.slice() });
      }
    };
    walk(r, '');
    if (found.length) {
      poolByCfg[r.id] = found;
      console.log('cfgId=' + r.id + ' →', JSON.stringify(found));
    }
  }
  if (!Object.keys(poolByCfg).length)
    console.log('（没发现数字列表字段——奖励池可能在独立表或由服务器下发，看第 3 段暴力扫描）');

  // ── 3) 暴力扫描 reward id 区间，逐个解析 ──
  H('3) 暴力扫描 reward 表 id 区间 [' + BRUTE_LO + ',' + BRUTE_HI + ']');
  const resolved = [];
  for (let id = BRUTE_LO; id <= BRUTE_HI; id++) {
    const items = rewardItems(id);
    if (items && items.length) {
      resolved.push({
        rewardId: id,
        itemId: items[0].id,
        道具名: items[0].name,
        数量: items[0].count,
        条目数: items.length,
        全部: items.map((it) => it.id + ':' + it.name + '×' + it.count).join(' | '),
      });
    }
  }
  console.log('可解析的 reward 行数:', resolved.length);
  if (resolved.length) {
    console.table(resolved);
    console.log('%c原始 JSON（可复制贴回）：', 'color:#888');
    console.log(JSON.stringify(resolved));
  }

  // ── 4) 若第 2 段拿到 cfg 的池 id，按 cfg 归类解析成名字 ──
  H('4) 按 cfgId 归类的奖励池（若第 2 段有数字列表）');
  for (const cfg in poolByCfg) {
    const ids = new Set();
    poolByCfg[cfg].forEach((f) => f.ids.forEach((x) => ids.add(x)));
    const named = [...ids]
      .sort((a, b) => a - b)
      .map((rid) => {
        const it = rewardItems(rid)[0];
        return rid + ' → ' + (it ? it.id + ' / ' + it.name + '×' + it.count : '（未解析）');
      });
    console.log('cfgId=' + cfg + ' 池（' + ids.size + ' 项）:\n  ' + named.join('\n  '));
  }

  console.log(
    '%c[relic-dump] 完成：把上面各段 JSON 贴回来即可据此定稿 L2_ITEM_POOL。',
    'color:#2aa198;font-weight:bold',
  );
})();
