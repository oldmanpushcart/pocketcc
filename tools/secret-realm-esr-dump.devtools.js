/**
 * 秘境主表 esr↔BOSS 配对字段提取器（DevTools 一次性粘贴运行）—— 从运行时内存整表 dump
 *
 * 背景（2026-11-04）：pilot 的 `#pickPlane` 区域筛子现走「真 esr 对照 → 常量锚点几何判区」两级
 *   （constants.js `PAB_BOSS_ZONES`，差异A定案）。用户口径：**`enigma_secret_realm` 行上带 `type`
 *   且与 BOSS 的 type 一致** → 若属实，查表配对可直接判定「哪个 esr 区属于哪个 BOSS」，
 *   不依赖快照瓦片、不依赖几何/容差，比现行两级都干净。但仓内所有资产（竞品两处引用、
 *   逆向报告、字典表、20261101 录制）只见该表的 `roundid` 字段，**没有任何一处见过 `type`**，
 *   且 21535 权威 bossBaseInfo 只有 bossId/pos/state/stateEndTime（无 type）。本探针即为此断言取证。
 *
 * 运行前提：已加载 pocketcc 扩展并**进入异能秘境房间内**（bossBaseInfo 在房里才有值；
 *   表数据登录后即在内存，与在不在房无关）。处于主世界（MAIN world）控制台上下文。只读不发，零副作用。
 *
 * 要回答的三个问题（输出段 2/3/4 各答一个）：
 *   Q1 主表行里到底有没有 `type`（或任何 boss 指向键：bossId/boss_type/pointType/pos）？
 *   Q2 type 的值域指向什么？（=bossBaseInfo.bossId？=177/178 瓦片型别？还是别的枚举？）
 *   Q3 能否**唯一**配对：两个小BOSS 的两个区若 type 同值，查表到此断裂，仍需几何/第三键。
 */
(function secretRealmEsrDump() {
  const PC = window.pocketcc;
  if (!PC || !PC.game || typeof PC.game.get !== 'function') {
    console.error('[esr-dump] window.pocketcc.game.get 不可用：确认已加载扩展并登录进游戏（主世界上下文）。');
    return;
  }
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      console.warn('[esr-dump] game.get(%s) 失败', n, e);
      return null;
    }
  };
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a9d9d;font-weight:bold');

  const TM = G('TableManager');
  const TABLE = TM && (TM.TABLE || (TM.default && TM.default.TABLE));
  if (!TABLE || typeof TABLE.getTableGroupArray !== 'function') {
    console.error('[esr-dump] TableManager.TABLE 不可用（符号漂移？），拿不到内存表。');
    return;
  }
  const TNm = G('TableName');
  const TN = (TNm && (TNm.TableName || (TNm.default && TNm.default.TableName))) || {};
  const realmTable = TN.enigma_secret_realm || 'enigma_secret_realm';
  const buildingTable = TN.enigma_secret_realm_building || 'enigma_secret_realm_building';

  // ── 1) 运行时 BOSS 权威态（配对的"另一侧"参照系；进房才有值）──
  H('1) bossBaseInfo 运行时全字段（含 Int64 解码）');
  const decode = (v) =>
    v && typeof v === 'object' && '_low' in v ? (v._high >>> 0) * 4294967296 + (v._low >>> 0) : v;
  let bosses = [];
  try {
    const K = G('PabController');
    const inst = (K && (K.Instance || (K.default && K.default.Instance))) || null;
    bosses = (inst && inst.bossBaseInfo) || [];
  } catch (e) {
    console.warn('[esr-dump] 读 PabController.bossBaseInfo 失败（是否没在秘境房间里？）', e);
  }
  if (!Array.isArray(bosses) || !bosses.length) {
    console.warn('[esr-dump] bossBaseInfo 为空：请进入异能秘境房间后再跑，Q2/Q3 会缺参照。');
  } else {
    console.table(
      bosses.map((b) => ({
        bossId: b.bossId,
        x: b.pos && b.pos.x,
        y: b.pos && b.pos.y,
        state: b.state,
        stateEndTime: decode(b.stateEndTime),
        extraKeys: Object.keys(b)
          .filter((k) => !['bossId', 'pos', 'state', 'stateEndTime'].includes(k))
          .join(','),
      })),
    );
    console.log('原始 JSON:', JSON.stringify(bosses, (k, v) => (k === 'stateEndTime' ? decode(v) : v)));
  }

  // ── 2) Q1：主表整行原样 dump，重点看有没有 type/boss 指向键 ──
  H('2) enigma_secret_realm 整表（Q1：type/bossId/pos 类字段是否存在）');
  let rows = [];
  try {
    rows = TABLE.getTableGroupArray(realmTable) || [];
  } catch (e) {
    console.error('[esr-dump] 读主表失败', e);
  }
  console.log('行数:', rows.length);
  const KEY_RE = /^(type|boss.*|.*type$|.*point.*|pos|coords?|x|y|esr.*)$/i;
  for (const r of rows) {
    const hits = Object.keys(r).filter((k) => KEY_RE.test(k));
    console.log(`行 id=${r.id} 全键=${Object.keys(r).join(',')}  ▸候选配对键=[${hits.join(', ')}]`);
  }
  console.log('%c原始 JSON（整表，可复制贴回）：', 'color:#888');
  console.log(JSON.stringify(rows));

  // ── 3) Q2：任何"疑似配对字段"的取值与 BOSS 侧值域对表 ──
  H('3) 配对语义判定（Q2：type 值 =bossId？ =177/178 瓦片型别？ =别的？）');
  const bossIds = new Set(bosses.map((b) => Number(b.bossId)));
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!KEY_RE.test(k) || k === 'id') continue;
      const v = Number(r[k]);
      if (!Number.isFinite(v)) continue;
      const tags = [];
      if (bossIds.has(v)) tags.push('==bossId');
      if (v === 177) tags.push('==PAB_BOSS(大)');
      if (v === 178) tags.push('==PAB_BOSS_GUARD(小)');
      console.log(`  行${r.id}.${k}=${v} ${tags.length ? '▸ ' + tags.join(' / ') : '▸ 无语义命中(未知枚举)'}`);
    }
  }

  // ── 4) Q3：唯一性检验——按疑似字段能否把 esr→具体BOSS 一一对上 ──
  H('4) 唯一配对检验（Q3：两小BOSS 同 type 时查表断裂？）');
  const byField = {};
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!KEY_RE.test(k) || k === 'id' || !Number.isFinite(Number(r[k]))) continue;
      (byField[k] = byField[k] || {})[r.id] = Number(r[k]);
    }
  }
  for (const k of Object.keys(byField)) {
    const m = byField[k];
    const vals = Object.values(m);
    const uniq = new Set(vals).size === vals.length && vals.every((v) => bossIds.has(v));
    console.log(
      `  字段 ${k}: esr→值 ${JSON.stringify(m)}  ▸ ${uniq ? '可唯一配对 BOSS（查表方案成立）' : '存在撞值/非bossId → 查表断裂，仍需几何判区兜底'}`,
    );
  }

  // ── 5) 附赠：建筑表全 build_type 分布（商店 4 锚点之外的固定建筑，如 BOSS 锚是否也在表里）──
  H('5) enigma_secret_realm_building 的 build_type×group 分布（BOSS 锚若也下发，可彻底替换常量表）');
  let brows = [];
  try {
    brows = TABLE.getTableGroupArray(buildingTable) || [];
  } catch (e) {
    console.warn('[esr-dump] 读建筑表失败', e);
  }
  const bt = {};
  for (const r of brows) (bt[r.build_type] = bt[r.build_type] || []).push(`g${r.group}:${r.coords}`);
  for (const k of Object.keys(bt)) console.log(`  build_type=${k} ×${bt[k].length}`, bt[k].slice(0, 8).join(' | '));
  console.log('提示：若某 build_type 的 coords 含 (203,203)/(175,177)/(230,234)，说明 BOSS 锚也是下发数据，PAB_BOSS_ZONES 可改为读表。');
})();
