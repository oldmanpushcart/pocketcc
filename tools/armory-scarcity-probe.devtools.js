/**
 * 军火库稀缺度取证器（DevTools 一次性粘贴运行）—— 核对 feat 是否真按「最稀缺家族」选产
 *
 * 目的：把 feat armory-material.js 的选料决策链在游戏真实数据上原样复算一遍并摊开，
 *   回答三个问题：
 *     A) 可生产基础料集（type=85 && quality=1）到底有几家、都是谁；
 *     B) 每家的 familyNormalizedHoldings（沿 para1/para2 融合链折成基础料等价单位求和）是多少，
 *        其中每级持有量（getItemAmount）是否真的非 0 —— 直接验证 userData() 修复是否生效；
 *     C) 叠加在途队列投影后的稀缺度打分排序 + 最终该选的基础料 id。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，处于主世界（MAIN world）控制台上下文。只读内存，不发包。
 *
 * 数据来源与 feat 完全同源（口径一致，勿改）：
 *   - TableManager.TABLE：getTableByKey(item,'type',85,'quality',1) 取基础料集；getTableDataById(item,id) 取行。
 *   - DataCenter.DATA.UserData：getItemAmount(id) 读持有；ArmyEquipSystemMeterial={st,wait} 读队列镜像。
 *   - GameTools.getDataConfigData(920002) = 每单产量 perYield（在途投影折算）。
 */
(function armoryScarcityProbe() {
  const ARMY_MATERIAL_TYPE = 85; // ItemType.ArmyMaterial
  const BASE_QUALITY = 1; // 融合链头（可生产等级）
  const CFG_YIELD = 920002; // DATACONFIG：每单产量
  const DEFAULT_FUSION_RATIO = 4; // 行缺 para1 时按 4 合 1
  const MAX_CHAIN_DEPTH = 16; // 融合链层数上限（环/异常保护）

  const PC = window.pocketcc;
  if (!PC || !PC.game || typeof PC.game.get !== 'function') {
    console.error(
      '[armory-probe] window.pocketcc.game.get 不可用：确认已加载扩展并登录进游戏（主世界上下文）。',
    );
    return;
  }
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      console.warn('[armory-probe] game.get(%s) 失败', n, e);
      return null;
    }
  };

  const TM = G('TableManager');
  const TABLE = TM && (TM.TABLE || (TM.default && TM.default.TABLE));
  if (!TABLE || typeof TABLE.getTableByKey !== 'function') {
    console.error('[armory-probe] TableManager.TABLE 不可用（符号漂移？），拿不到内存表。');
    return;
  }
  const TNm = G('TableName');
  const TN = (TNm && (TNm.TableName || (TNm.default && TNm.default.TableName))) || {};
  const ITEM_TABLE = TN.ITEM || TN.item || 'item';

  const DC = G('DataCenter');
  const DATA = DC && (DC.DATA || (DC.default && DC.default.DATA));
  const UD = DATA && DATA.UserData;
  const serverTime = Number(DATA && DATA.ServerTime) || 0;
  const getItemAmount = (id) => {
    if (!UD || typeof UD.getItemAmount !== 'function') return 0;
    try {
      return Number(UD.getItemAmount(+id)) || 0;
    } catch (e) {
      return 0;
    }
  };

  const GT = G('GameTools');
  const gameTools = GT && GT.default ? GT.default : GT;
  const configNum = (key, def) => {
    try {
      if (gameTools && typeof gameTools.getDataConfigData === 'function') {
        const v = Number(gameTools.getDataConfigData(key));
        if (v > 0) return v;
      }
    } catch (e) {}
    return def;
  };
  const tableRow = (id) => {
    try {
      return TABLE.getTableDataById(ITEM_TABLE, String(id)) || null;
    } catch (e) {
      return null;
    }
  };

  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');

  // ── 0) 访问器体检：若这几项是坏的，稀缺度必然退化（历史上的 userData() bug）──
  H('0) 访问器体检');
  console.log({
    ITEM_TABLE,
    hasUserData: !!UD,
    getItemAmountIsFn: !!(UD && typeof UD.getItemAmount === 'function'),
    serverTime,
    perYield: configNum(CFG_YIELD, 1),
    produceTimeSec: (() => {
      try {
        return (
          Number(gameTools && gameTools.getDataConfigData && gameTools.getDataConfigData(920001)) ||
          0
        );
      } catch (e) {
        return 0;
      }
    })(),
    queueMirror: (() => {
      try {
        const m = UD && UD.ArmyEquipSystemMeterial;
        return m ? { st: m.st, wait: m.wait } : null;
      } catch (e) {
        return 'ERR';
      }
    })(),
  });
  if (!UD || typeof UD.getItemAmount !== 'function') {
    console.warn(
      '%c[armory-probe] ⚠ UserData.getItemAmount 不可用 → 所有家族持有恒 0 → 稀缺度退化成「按 id 升序盲排」。这正是你看到的症状！',
      'color:#d9534f;font-weight:bold',
    );
  }

  // ── 复刻 feat familyNormalizedHoldings，并额外记录每级明细 ──
  function familyDetail(baseId) {
    let total = 0,
      value = 1,
      cur = baseId,
      guard = 0;
    const seen = new Set(),
      steps = [];
    while (cur != null && cur > 0 && guard++ < MAX_CHAIN_DEPTH) {
      if (seen.has(cur)) {
        steps.push({ level: guard, id: cur, 备注: '环，停止' });
        break;
      }
      seen.add(cur);
      const row = tableRow(cur);
      if (!row) {
        steps.push({ level: guard, id: cur, 备注: '无表行，链断' });
        break;
      }
      const hold = getItemAmount(cur);
      total += hold * value;
      steps.push({
        level: guard,
        id: cur,
        名称: row.name || '',
        该级持有: hold,
        折合系数: value,
        计入: hold * value,
      });
      const ratio = Number(row.para1) > 0 ? Number(row.para1) : DEFAULT_FUSION_RATIO;
      const next = Number(row.para2);
      if (!(next > 0) || next === cur) break; // 链尾
      value *= ratio;
      cur = next;
    }
    return { total, steps };
  }

  // ── 1) 可生产基础料集 ──
  H('1) 可生产基础料集（type=85 && quality=1）');
  let bases = [];
  try {
    bases =
      TABLE.getTableByKey(ITEM_TABLE, 'type', ARMY_MATERIAL_TYPE, 'quality', BASE_QUALITY) || [];
  } catch (e) {
    console.error('[armory-probe] 取基础料集失败', e);
  }
  console.log('基础料家族数量:', bases.length);
  console.table(
    bases.map((r) => ({ id: r.id, 名称: r.name || '', para1: r.para1, para2: r.para2 })),
  );

  // ── 2) 每家融合链折算明细 + 归一持有 ──
  H('2) 每家融合链折算（各级持有 × 折合系数 求和 = 归一持有）');
  const holdings = {};
  for (const r of bases) {
    const b = Number(r.id);
    if (!(b > 0)) continue;
    const d = familyDetail(b);
    holdings[b] = d.total;
    console.log('基础料 id=' + b + '（' + (r.name || '') + '） 归一持有=' + d.total);
    console.table(d.steps);
  }

  // ── 3) 稀缺度打分（叠加在途队列投影）与最终选择 ──
  H('3) 稀缺度打分排序（score = 归一持有 + 队列在产条数 × perYield；score 最小者最稀缺）');
  const perYield = configNum(CFG_YIELD, 1);
  let wait = [];
  try {
    const m = UD && UD.ArmyEquipSystemMeterial;
    if (m && Array.isArray(m.wait)) wait = m.wait.map(Number);
  } catch (e) {}
  console.log(
    '当前队列 wait（feat 会用权威 shadow；此处镜像仅供对照）:',
    wait,
    '| perYield=',
    perYield,
  );
  const queuedCount = {};
  for (const id of wait) if (id > 0) queuedCount[id] = (queuedCount[id] || 0) + 1;

  const ranking = bases
    .map((r) => Number(r.id))
    .filter((b) => b > 0)
    .map((b) => ({
      id: b,
      名称: (tableRow(b) || {}).name || '',
      归一持有: holdings[b],
      队列在产条数: queuedCount[b] || 0,
      投影: (queuedCount[b] || 0) * perYield,
      score: holdings[b] + (queuedCount[b] || 0) * perYield,
    }))
    .sort((a, b) => a.score - b.score || a.id - b.id);
  console.table(ranking);

  // ── 复刻 feat scarcestBase 的选择（并列按 id 升序）──
  let best = null,
    bestScore = Infinity;
  for (const row of ranking) {
    if (row.score < bestScore || (row.score === bestScore && best != null && row.id < best)) {
      bestScore = row.score;
      best = row.id;
    }
  }
  H('4) 结论');
  console.log('feat 本应选中的最稀缺基础料 id =', best, '（score=' + bestScore + '）');
  console.log(
    '对照：若所有归一持有恒 0，则 score 只由投影/id 决定 → 会退化为「按 id 升序盲排」，与稀缺无关。请核对第 2 段各级持有是否非 0。',
  );
  console.log(
    '%c[armory-probe] 完成：把上面各段（尤其第 0/2/3 段）截图或 JSON 贴回来即可据此判断稀缺度是否真正生效。',
    'color:#2aa198;font-weight:bold',
  );
})();
