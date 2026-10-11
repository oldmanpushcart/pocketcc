/**
 * 秘境拾取清单「同名物品」核对器（DevTools 一次性粘贴运行）
 *
 * 目的：面板「拾取清单」里出现多个同名行（如实证截图里 5 行都叫「异能模块」），需要人工核对
 *   到底是 ① ITEM 表里本来就存在多个不同 id 的同名道具（不同品质/等级），还是
 *   ② 多个 rss_station 资源点行产出同一个 itemId（名字链路 rss→.item→ITEM.name 导致必然同名），还是
 *   ③ 我们的取名链路取错了字段。本脚本按 **与 feat 面板完全同源的口径** 把三类池一次性列出：
 *     `item:{id}` / `rss:{specId}` / `pet:{cfgId}`，并额外打印每行的原始 loc 键与「组内差异字段」。
 *
 * 口径来源（与 extension/src/feats/activity/secret-realm/index.js 的 buildPickPool/itemLabel/beastLabel 一致）：
 *   - item 池：ITEM 表 `type === 171` 的行（RealPabController.checkItemNumMax 以 type==171 作「秘境背包可持有物品」判据）
 *   - rss  池：enigma_secret_realm_rss_station 表 `effect_buff === 0` 的行；名字 = `.item` → ITEM 表 `.name`
 *     （实证 rss_station 行**没有 name 字段**，PabBagItem.updateResourceItem 只读 .item/.item_num）
 *   - pet  池：enigma_beast 全表（主键 cfgId）；名字 = `enigma_beast_type[cfg.type].name1`
 *     （实证 enigma_beast 行亦无 name 字段，EnigmaBeastResCfg.getTypeCommonName 走物种表）
 *   - 译文 = LOCAL.getText(键)，与面板 l10n.text 同源。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，控制台处于主世界（MAIN world）上下文；纯读内存表，不发包。
 * 输出：console.table 明细 + 重名分组 + 末尾一段可复制贴回的原始 JSON。
 */
(function pabPickPoolDump() {
  const TAG = '[pab-pool]';
  const ITEM_TYPE_PAB = 171; // 与 constants.js ITEM_TYPE_PAB 同值
  const PC = window.pocketcc;
  if (!PC || !PC.game || typeof PC.game.get !== 'function') {
    console.error(
      TAG + ' window.pocketcc.game.get 不可用：确认已加载扩展并登录进游戏（主世界上下文）。',
    );
    return;
  }
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      console.warn(TAG + ' game.get(%s) 失败', n, e);
      return null;
    }
  };
  const unwrap = (m, k) => (m && (m[k] || (m.default && m.default[k]))) || null;

  const TM = unwrap(G('TableManager'), 'TABLE');
  if (!TM || typeof TM.getTableGroupArray !== 'function') {
    console.error(TAG + ' TableManager.TABLE 不可用（符号漂移？），拿不到内存表。');
    return;
  }
  const TN = unwrap(G('TableName'), 'TableName') || {};
  const L = unwrap(G('LocalManager'), 'LOCAL');
  const text = (k) => {
    if (!k || !L || typeof L.getText !== 'function') return String(k == null ? '' : k);
    try {
      const t = L.getText(String(k));
      return t ? String(t) : String(k);
    } catch (e) {
      return String(k);
    }
  };
  /** 表名解析：优先 TableName 枚举成员名，回退字面表名（同 game-api tableRow 的优先级） */
  const tn = (member, literal) => TN[member] || TN[literal] || literal;
  const T_ITEM = tn('ITEM', 'item');
  const T_RSS = tn('enigma_secret_realm_rss_station', 'enigma_secret_realm_rss_station');
  const T_BEAST = tn('enigma_beast', 'enigma_beast');
  const T_BTYPE = tn('enigma_beast_type', 'enigma_beast_type');
  const T_EFF = tn('EFFECTBUFF', 'effect_buff');
  const rowsOf = (t) => {
    try {
      return TM.getTableGroupArray(t) || [];
    } catch (e) {
      console.warn(TAG + ' 读表失败 %s', t, e);
      return [];
    }
  };
  const rowOf = (t, id) => {
    if (id == null || id === '') return null;
    try {
      return TM.getTableDataById(t, String(id)) || null;
    } catch (e) {
      return null;
    }
  };
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');

  // ── 0) 符号 / 表名自检 ──
  H('0) 表名解析自检');
  const itemRows = rowsOf(T_ITEM);
  const rssRows = rowsOf(T_RSS);
  const beastRows = rowsOf(T_BEAST);
  const typeRows = rowsOf(T_BTYPE);
  console.log({
    T_ITEM,
    T_RSS,
    T_BEAST,
    T_BTYPE,
    T_EFF,
    ITEM行数: itemRows.length,
    'ITEM type==171 行数': itemRows.filter((r) => Number(r && r.type) === ITEM_TYPE_PAB).length,
    'rss_station 行数': rssRows.length,
    'rss_station 非 buff 行数': rssRows.filter((r) => r && (Number(r.effect_buff) || 0) === 0)
      .length,
    'enigma_beast 行数': beastRows.length,
    'enigma_beast_type 行数': typeRows.length,
  });
  if (itemRows.length) {
    console.log(
      '%cITEM 表首行全部字段名（看有哪些可区分字段）：',
      'color:#888',
      Object.keys(itemRows[0]),
    );
    console.log('%cITEM 首行原始数据：', 'color:#888', JSON.stringify(itemRows[0]));
  }
  if (rssRows.length) {
    console.log('%crss_station 首行全部字段名：', 'color:#888', Object.keys(rssRows[0]));
    console.log('%crss_station 首行原始数据：', 'color:#888', JSON.stringify(rssRows[0]));
  }

  // ── 1) 组装三类池（与面板 buildPickPool 同口径）──
  /** @type {Array<{pool:string,key:string,name:string,rawKey:string,ref:string,row:object}>} */
  const pool = [];

  // 1a. item 池：面板 label 取行自身 .name（rowLabel），ref 记 type/quality 等常见区分字段
  for (const r of itemRows) {
    if (!r || Number(r.type) !== ITEM_TYPE_PAB || r.id == null) continue;
    pool.push({
      pool: 'item',
      key: 'item:' + r.id,
      name: text(r.name || r.itemName || r.desc) || '#' + r.id,
      rawKey: String(r.name || r.itemName || r.desc || ''),
      ref: ['type', 'quality', 'star', 'level', 'sub_type', 'para1_v1']
        .filter((f) => r[f] != null && r[f] !== '')
        .map((f) => f + '=' + r[f])
        .join(' '),
      row: r,
    });
  }

  // 1b. rss 池：名字来自它产出的道具（rss_station 行无 name 字段）
  for (const r of rssRows) {
    if (!r || r.id == null) continue;
    if ((Number(r.effect_buff) || 0) !== 0) continue; // buff 行走独立开关，不在清单里
    const itemId = r.item;
    const irow = rowOf(T_ITEM, itemId);
    pool.push({
      pool: 'rss',
      key: 'rss:' + r.id,
      name: irow ? text(irow.name || irow.itemName || irow.desc) : '#item:' + itemId,
      rawKey: String((irow && (irow.name || irow.itemName || irow.desc)) || ''),
      ref:
        'item=' +
        itemId +
        (r.item_num != null ? ' item_num=' + r.item_num : '') +
        (r.para1_v1 != null ? ' para1_v1=' + r.para1_v1 : '') +
        (irow ? ' 道具type=' + irow.type : ' 道具行缺失'),
      row: r,
    });
  }

  // 1c. pet 池：名字来自物种表 name1（enigma_beast 行无 name 字段）
  for (const r of beastRows) {
    if (!r || r.cfgId == null) continue;
    const type = Number(r.type) || 0;
    const trow = type ? rowOf(T_BTYPE, type) : null;
    const key = trow && (trow.name1 || trow.name_type);
    pool.push({
      pool: 'pet',
      key: 'pet:' + r.cfgId,
      name: key ? text(key) : '#pet:' + r.cfgId,
      rawKey: String(key || ''),
      ref:
        'type=' +
        type +
        (r.star != null ? ' star=' + r.star : '') +
        (r.quality != null ? ' quality=' + r.quality : '') +
        (trow && trow.name2 ? ' name2=' + text(trow.name2) : ''),
      row: r,
    });
  }

  H('1) 面板「拾取清单」完整池（' + pool.length + ' 行）');
  console.table(
    pool.map((p) => ({
      面板key: p.key,
      显示名: p.name,
      原始loc键: p.rawKey,
      关联字段: p.ref,
    })),
  );

  // ── 2) 同名分组：一眼看出重名来自哪一类 ──
  H('2) 同名分组（显示名相同的行）');
  const byName = new Map();
  for (const p of pool) {
    if (!p.name || p.name[0] === '#') continue; // 未解析出名字的走第 3 段单独看
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  let dupGroups = 0;
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    dupGroups++;
    // 组内差异字段：只保留「行间取值不同」的字段，直接回答"这几行凭什么不是一行"
    const fieldSet = new Set();
    for (const p of list) Object.keys(p.row || {}).forEach((f) => fieldSet.add(f));
    const diff = [];
    for (const f of fieldSet) {
      const vals = new Set(list.map((p) => JSON.stringify(p.row ? p.row[f] : null)));
      if (vals.size > 1) diff.push(f);
    }
    console.log(
      '%c● 同名「' +
        name +
        '」× ' +
        list.length +
        '（池：' +
        [...new Set(list.map((p) => p.pool))].join('/') +
        '）',
      'color:#d9534f;font-weight:bold',
    );
    console.table(
      list.map((p) => {
        const o = { 面板key: p.key, 原始loc键: p.rawKey };
        diff.slice(0, 10).forEach((f) => {
          o[f] = p.row ? p.row[f] : null;
        });
        return o;
      }),
    );
    console.log(
      '  行间不同的字段：' + (diff.length ? diff.join(', ') : '（无——这些行数据完全相同）'),
    );
  }
  if (!dupGroups) console.log('（没有同名行）');

  // ── 3) 没解析出名字的行（面板会显示 #id，需要补链路）──
  H('3) 名字未解析（面板显示 #id 的行）');
  const unnamed = pool.filter((p) => !p.name || p.name[0] === '#');
  if (!unnamed.length) console.log('（无：全部行都解析出了中文名）');
  else
    console.table(
      unnamed.map((p) => ({
        面板key: p.key,
        显示名: p.name,
        原始loc键: p.rawKey,
        关联字段: p.ref,
      })),
    );

  // ── 4) 增益 buff 类名核对（面板「增益选项」数据源，同类不应出现两个不同名）──
  H('4) 增益 buff 类（effect_buff 去重）');
  const effSeen = new Map();
  for (const r of rssRows) {
    const eff = r ? Number(r.effect_buff) || 0 : 0;
    if (!eff) continue;
    if (!effSeen.has(eff)) effSeen.set(eff, []);
    effSeen.get(eff).push(r);
  }
  console.table(
    [...effSeen.entries()].map(([eff, list]) => {
      const erow = rowOf(T_EFF, eff);
      return {
        effect_buff: eff,
        类名: erow && erow.string ? text(erow.string) : '(未解析#' + eff + ')',
        loc键: (erow && erow.string) || '',
        '该类的 specId 数': list.length,
        specIds: list.map((x) => x.id).join(','),
        buff_para: [...new Set(list.map((x) => String(x.buff_para)))].join(','),
      };
    }),
  );

  H('5) 原始 JSON（整池，可复制贴回）');
  console.log(
    JSON.stringify(
      pool.map((p) => ({
        pool: p.pool,
        key: p.key,
        name: p.name,
        rawKey: p.rawKey,
        ref: p.ref,
        row: p.row,
      })),
    ),
  );
  console.log(
    '%c' + TAG + ' 完成：把第 2/3/5 段结果贴回来即可据此修正取名链路或加区分后缀。',
    'color:#2aa198;font-weight:bold',
  );
})();
