/**
 * 夺宝奇兵（CSHunt）配置表 + 运行时状态提取器（DevTools 一次性粘贴运行）
 *
 * 目的：坐实 feat-夺宝奇兵.md §7 的离线不可读缺口——
 *   1) cross_treasure_skill 整表：skillSpecId → {name,group,type,…}（先知/幸运降临/两种护盾/
 *      动态隐形/自由闪现/完美镜像…的中文名→specId 绑定，feat 配置下拉全靠它）；
 *   2) cross_treasure 主表实值：max_ppl_num（人数上限）、round_max（场景数）等；
 *   3) cross_treasure_event 整表：场景类型枚举与事件名（7 种场景族）；
 *   4) DataConfig 290004（夺宝次数上限文案参数）及邻域键；
 *   5) CSHuntController 当前运行时（huntCount/specId/阶段），活动未开始时应为空态——
 *      本脚本同时验证「未开始到底能拿到多少」，表在登录期下发则离线 dump 即可定稿。
 *
 * 运行前提：已加载 pocketcc 扩展并登录进游戏，主世界（MAIN world）控制台粘贴运行。
 *   只读，不发包。配置表若未加载（行数 0），活动开启期或点开夺宝面板后重跑一次即可。
 *
 * 数据来源：TableManager.TABLE（内存表）、TableName、LocalManager.LOCAL（文案解析）、
 *   TableUtils/GameTools.getDataConfigData、CSHuntController.getInstance（容错只读）。
 */
(function csHuntConfigDump() {
  const TAG = '[cs-hunt-dump] ';
  const PC = window.pocketcc;
  if (!PC || !PC.game || typeof PC.game.get !== 'function') {
    console.error(TAG + 'window.pocketcc.game.get 不可用：确认已加载扩展并登录进游戏。');
    return;
  }
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      console.warn(TAG + 'game.get(%s) 失败', n, e);
      return null;
    }
  };
  const unwrap = (m, k) => (m && (m[k] || (m.default && m.default[k]))) || null;

  const TM = unwrap(G('TableManager'), 'TABLE');
  if (!TM || typeof TM.getTableGroupArray !== 'function') {
    console.error(TAG + 'TableManager.TABLE 不可用（符号漂移？），拿不到内存表。');
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
  const tn = (member, literal) => TN[member] || TN[literal] || literal;
  const rowsOf = (t) => {
    try {
      return TM.getTableGroupArray(t) || [];
    } catch (e) {
      console.warn(TAG + ' 读表失败 %s', t, e);
      return [];
    }
  };
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');

  // ── 0) 表名发现：枚举 TableName 里所有 treasure / cross 系表，逐表报行数 ──
  H('0) 表名发现（TableName 中含 treasure / cross 的条目）');
  const found = {};
  for (const k in TN) {
    const v = String(TN[k] || '');
    if (/treasure/i.test(v) || /cross_treasure/i.test(k)) found[k] = v;
  }
  console.log('候选表名成员:', found);
  const rowCounts = {};
  for (const k in found) rowCounts[k + ' → ' + found[k]] = rowsOf(found[k]).length;
  console.table(rowCounts);
  if (!Object.keys(found).length)
    console.warn(TAG + 'TableName 里没发现夺宝系表名——可能活动表是运行期另行下发，看第 4 段控制器态。');

  const T_SKILL = tn('cross_treasure_skill', 'cross_treasure_skill');
  const T_MAIN = tn('cross_treasure', 'cross_treasure');
  const T_EVENT = tn('cross_treasure_event', 'cross_treasure_event');

  // ── 1) 技能整表：skillSpecId → 名字/group/type 全字段（feat §7-1 核心）──
  H('1) cross_treasure_skill 整表（保命/先知/幸运/复制 的 specId 绑定）');
  const skillRows = rowsOf(T_SKILL);
  console.log('行数:', skillRows.length);
  if (skillRows.length) {
    console.log('%c首行全部字段名：', 'color:#888', Object.keys(skillRows[0]));
    const named = skillRows.map((r) => ({
      id: r.id != null ? r.id : r.specId,
      name中文: text(r.name),
      nameKey: r.name,
      group: r.group, // 1=队伍技能(仅队长) 其余=个人
      type: r.type, // 5=MING_BRAND(先知/仅DECIDE) 9=保护奖励 12=COPY 等
      skill_type: r.skill_type,
      close_after: r.close_after,
      key_para: r.key_para,
      des_key_para: r.des_key_para,
      描述中文: text(r.skill_des),
    }));
    console.table(named);
    console.log('%c原始 JSON（整表，可复制贴回）：', 'color:#888');
    console.log(JSON.stringify(skillRows));
    // 快速点名：按中文名圈出 feat 关心的技能
    const wanted = ['先知', '幸运', '护盾', '毫发难伤', '抵御', '隐形', '隐身', '闪现', '迁移', '镜像', '复制', '锁定'];
    const hits = named.filter((r) => wanted.some((w) => (r.name中文 || '').includes(w) || (r.描述中文 || '').includes(w)));
    console.log('%c► 命中的关注技能（名/描述含：先知/幸运/护盾/毫发难伤/隐形/闪现/镜像/锁定…）：', 'color:#e45735;font-weight:bold');
    console.table(hits.map((r) => ({ id: r.id, name中文: r.name中文, group: r.group, type: r.type, 描述中文: r.描述中文 })));
  } else {
    console.warn(TAG + '技能表空：活动未开始可能未下发，开启期重跑。');
  }

  // ── 2) 主表实值：max_ppl_num / round_max 等 ──
  H('2) cross_treasure 主表整表（人数上限/场景数/时长实值）');
  const mainRows = rowsOf(T_MAIN);
  console.log('行数:', mainRows.length);
  if (mainRows.length) {
    console.log('%c首行全部字段名：', 'color:#888', Object.keys(mainRows[0]));
    console.table(
      mainRows.map((r) => {
        const o = {};
        for (const k in r) if (!/des|name|icon|img/i.test(k)) o[k] = r[k];
        return o;
      }),
    );
    console.log('%c原始 JSON（可复制贴回）：', 'color:#888');
    console.log(JSON.stringify(mainRows));
  } else {
    console.warn(TAG + '主表空：同上，开启期重跑。');
  }

  // ── 3) 事件表：7 种场景族与 type 枚举 ──
  H('3) cross_treasure_event 整表（场景族全量：type/name）');
  const eventRows = rowsOf(T_EVENT);
  console.log('行数:', eventRows.length);
  if (eventRows.length) {
    console.log('%c首行全部字段名：', 'color:#888', Object.keys(eventRows[0]));
    console.table(
      eventRows.map((r) => ({
        id: r.id,
        type: r.type, // pickReward/rollDice/codeBox/defPVE/pickSkill/dice/nothing 的分派依据
        name中文: text(r.name),
        nameKey: r.name,
        描述中文: text(r.skill_des != null ? r.skill_des : r.desc),
      })),
    );
    console.log('%c原始 JSON（可复制贴回）：', 'color:#888');
    console.log(JSON.stringify(eventRows));
  }

  // ── 4) DataConfig：290004（次数上限文案参）+ 290000..290012 邻域 ──
  H('4) DataConfig 290xxx（290004=夺宝次数上限，邻域找恢复间隔）');
  // TableUtils/GameTools 均可能是 ES 命名空间壳（方法挂 .default 下）；在模块对象上找方法，而非把方法当模块。
  let readCfg = null;
  let cfgOut = null;
  let ctrl = null;
  for (const name of ['TableUtils', 'GameTools']) {
    const m = G(name);
    for (const c of [m, m && m.default].filter(Boolean)) {
      if (typeof c.getDataConfigData === 'function') {
        readCfg = (id) => c.getDataConfigData(id);
        break;
      }
    }
    if (readCfg) break;
  }
  if (readCfg) {
    const cfg = {};
    for (let id = 290000; id <= 290012; id++) {
      try {
        const v = readCfg(id);
        if (v !== '' && v != null && !(typeof v === 'number' && isNaN(v))) cfg[id] = v;
      } catch (e) {
        cfg[id] = '(读失败)';
      }
    }
    cfgOut = cfg;
    console.table(cfg);
  } else {
    console.warn(TAG + 'TableUtils/GameTools.getDataConfigData 不可用（符号漂移？）。');
  }

  // ── 5) 控制器运行时：未开始时的空态验证（huntCount/specId/阶段）──
  H('5) CSHuntController 运行时（活动未开始应空/0，验证可读性）');
  try {
    const m = G('CSHuntController');
    const K = unwrap(m, 'CSHuntController') || (m && m.default) || m;
    const ins = K && typeof K.getInstance === 'function' ? K.getInstance() : null;
    if (!ins) {
      console.warn(TAG + 'getInstance() 返回空——控制器未实例化（活动未开），符合预期。');
    } else {
      const safe = (f) => {
        try {
          return f();
        } catch (e) {
          return '(抛错:' + e.message + ')';
        }
      };
      ctrl = {
        huntCount: ins.huntCount,
        lastRecoverTimeMill: ins.lastRecoverTimeMill,
        specId: safe(() => ins.specId),
        team: safe(() => (ins.team ? JSON.parse(JSON.stringify(ins.team)) : null)),
        csHuntInfo: safe(() => (ins.csHuntInfo ? JSON.parse(JSON.stringify(ins.csHuntInfo)) : null)),
        isTeamLeader: safe(() => ins.isTeamLeader && ins.isTeamLeader()),
        activityTimeTips: safe(() => ins.getActivityTimeTips && ins.getActivityTimeTips()),
        isHuntOffSeason: safe(() => ins.isHuntOffSeason && ins.isHuntOffSeason()),
        protectedTime: safe(() => ins.getHuntProtectedTime && ins.getHuntProtectedTime()),
      };
      console.log(ctrl);
    }
  } catch (e) {
    console.warn(TAG + '控制器读取失败（未实例化属正常空态）', e);
  }

  // ── 6) 定位信标道具 47001001 名字行（核验断言）──
  H('6) ITEM 表 47001001（定位信标）核验');
  const itemRows = rowsOf(tn('ITEM', 'item'));
  const beacon = itemRows.find((r) => Number(r.id) === 47001001);
  if (beacon) {
    console.log('命中行:', JSON.stringify(beacon));
    console.log('道具名:', text(beacon.name));
  } else {
    console.warn(TAG + 'ITEM 表未找到 47001001（表空或 id 漂移）。');
  }

  // ── 7) 汇总打包：一键复制到剪贴板，整体贴回即可（含最关键的技能表/主表）──
  H('7) 汇总 bundle（自动尝试 copy 到剪贴板）');
  const bundle = {
    tableFound: found,
    rowCount: rowCounts,
    skillRows,
    mainRows,
    dataConfig290: cfgOut,
    ctrl,
    beacon,
  };
  const s = JSON.stringify(bundle);
  console.log(TAG + 'bundle 字节数:', s.length, '（skillRows/mainRows 行数：' + skillRows.length + '/' + mainRows.length + '）');
  try {
    // eslint-disable-next-line no-undef -- copy() 是 DevTools 控制台命令行 API，不在 globals.browser，仅限本探针场景
    copy(s);
    console.log(TAG + '已复制到剪贴板：直接 Ctrl+V 贴回即可，不用再翻控制台。');
  } catch (e) {
    console.warn(TAG + 'copy() 不可用（非控制台上下文？），请手动贴回 1/2 段 JSON。');
  }

  console.log(
    '%c[cs-hunt-dump] 完成：把各段「原始 JSON」与控制台输出整体贴回即可据此定稿 feat §7。若 1/2/3 段行数全为 0，等活动开启期（或点开夺宝主面板触发下发）后重跑一次。',
    'color:#2aa198;font-weight:bold',
  );
})();
