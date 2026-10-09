/**
 * 卡车「威胁判定」运行时探针（DevTools 一次性粘贴运行）
 *
 * 目的：把自动拦截"只打能赢的车"这套逻辑落地前，三个未验证的运行时事实一次性确认——
 *   A) GET_SINGLE_QUEUE_BATTLEPOWER(999)：我方出征部队战力的响应里，数字到底在哪个键（battlePower? power? …）。
 *   B) army_type 解析：hero 表（和 army 表）某行是否真有 army_type，值是否为 101陆/201海/301空。
 *   C) MAIL_GETREPORT(927)：用 scoutReportId 拉战报，reportStr 是"对象"还是"需 JSON.parse 的字符串"，
 *      以及 battle.defender 下 heroList / units 的实际形态（对方军种靠它）。
 *
 * 运行前提：
 *   1. 已加载 pocketcc 扩展并登录进游戏，处于主世界（MAIN world）控制台上下文；
 *   2. 场景在 Home / 世界地图（net 已由 boot.js install；卡车列表 6473 需此场景）；
 *   3. 已解锁"卡车争夺/日常护送"功能（否则 6473 列表为空，C/D 段会自动降级跳过，不影响 A/B）。
 *
 * 全部只读 + 直发查询类协议（999/927/6473 都只查询，不派兵、不改本地态），安全。
 * 结果都在 console，按 A/B/C/D 分段；末尾有"贴回结论"汇总，把各段 JSON 贴回来即可据此定稿判定器。
 */
(async function truckThreatProbe() {
  const CMD_POWER = 999; // GET_SINGLE_QUEUE_BATTLEPOWER（旧 send 链路）
  const CMD_REPORT = 927; // MAIL_GETREPORT（旧 send 链路）
  const CMD_TRUCK_OPEN = 6473; // ESCORT_TRUCK_LOOT_TRUCK_VIEW_OPEN（PBV2）
  const FUNC_TYPE = 1; // 日常护送

  const PC = window.pocketcc;
  if (!PC || !PC.game || !PC.net || !PC.battle) {
    console.error(
      '[truck-probe] window.pocketcc 未就绪（缺 game/net/battle）：确认已加载扩展、登录进游戏、处于主世界上下文。',
    );
    return;
  }
  const H = (m) => console.log('%c\n===== ' + m + ' =====', 'color:#4a90d9;font-weight:bold');
  const tryParse = (v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch (e) {
      return v;
    }
  };
  const netSend = async (cmd, body) => {
    try {
      const r = await PC.net.send(cmd, body);
      return { ok: r.ok, code: r.code, raw: r.data, data: tryParse(r.data) };
    } catch (e) {
      console.warn('[truck-probe] send(%d) 异常（超时/未 install？）', cmd, e);
      return null;
    }
  };
  const netPB = async (cmd, body) => {
    try {
      const r = await PC.net.sendPBV2(cmd, body);
      return { ok: r.ok, code: r.code, data: r.data };
    } catch (e) {
      console.warn('[truck-probe] sendPBV2(%d) 异常', cmd, e);
      return null;
    }
  };
  // Int64（{_low,_high} / Long / 数字 / 字符串）→ 十进制串（不做有损 Number 转换）
  const i64str = (v) => {
    if (v == null) return '';
    if (typeof v === 'object' && typeof v._high === 'number' && typeof v._low === 'number') {
      try {
        return ((BigInt(v._high) << 32n) | BigInt(v._low >>> 0)).toString();
      } catch (e) {
        return '';
      }
    }
    return String(v);
  };

  // ── 运行时表访问（照 relic-table-dump 的 TableManager.TABLE 口径）──
  const G = (n) => {
    try {
      return PC.game.get(n);
    } catch (e) {
      return null;
    }
  };
  const TM = G('TableManager');
  const TABLE = TM && (TM.TABLE || (TM.default && TM.default.TABLE));
  const TNm = G('TableName');
  const TN = (TNm && (TNm.TableName || (TNm.default && TNm.default.TableName))) || {};
  const row = (semantic, id) => {
    if (!TABLE || typeof TABLE.getTableDataById !== 'function') return null;
    const tn = TN[semantic] || TN[(semantic || '').toUpperCase()] || semantic;
    try {
      return TABLE.getTableDataById(tn, String(id));
    } catch (e) {
      return null;
    }
  };
  const armyTypeOf = (r) =>
    r && (r.army_type != null ? r.army_type : r.armyType != null ? r.armyType : undefined);

  // ══ A) 我方出征部队战力：先拿一份预设编成，喂 999 看响应键 ══
  H('A) 999 GET_SINGLE_QUEUE_BATTLEPOWER 响应形态');
  let preset = null;
  try {
    preset = PC.battle.buildFromPreset(0, 0);
  } catch (e) {
    console.warn('[truck-probe] buildFromPreset 异常', e);
  }
  if (!preset || !preset.armyListNew || !preset.armyListNew.length) {
    console.error(
      '[truck-probe] A 段跳过：预设部队 1 读不到/无兵（buildFromPreset 返回空）。换别的预设号或先在面板配好部队。',
    );
  } else {
    console.log(
      '预设编成 armyListNew 条数:',
      preset.armyListNew.length,
      ' heroList:',
      preset.heroList,
      ' formationV2:',
      preset.formationV2,
    );
    const body = {
      armyListNew: preset.armyListNew,
      heroList: preset.heroList,
      formation: 0,
      formationV2: preset.formationV2 | 0,
    };
    const r = await netSend(CMD_POWER, body);
    if (r) {
      console.log('999 ok=%s code=%s', r.ok, r.code);
      console.log('999 原始 data（typeof=%s）:', typeof r.raw, r.raw);
      console.log(
        '999 解析后 data keys:',
        r.data && typeof r.data === 'object' ? Object.keys(r.data) : r.data,
      );
      // 找出其中"像战力数字"的字段
      if (r.data && typeof r.data === 'object') {
        const nums = {};
        for (const k in r.data) {
          const v = r.data[k];
          if (typeof v === 'number') nums[k] = v;
        }
        console.log(
          '%c[truck-probe] ★ 999 里的数值字段（战力候选）：',
          'color:#e07b00;font-weight:bold',
          nums,
        );
      }
    } else console.warn('[truck-probe] A 段：999 未拿到响应。');
  }

  // ══ B/C/D 共用：拉卡车列表拿一个 scoutReportId ══
  H('取卡车列表（6473）以拿 scoutReportId');
  let firstScout = '',
    defenderHeroIds,
    defenderArmyIds = [];
  const lr = await netPB(CMD_TRUCK_OPEN, { funcType: FUNC_TYPE, localServerDisable: 1 });
  if (!lr || !lr.ok || !lr.data || !Array.isArray(lr.data.lootTruckViewList)) {
    console.warn(
      '[truck-probe] 卡车列表为空/被拒（未解锁该功能或非 Home 场景？）。C/D 段将降级；B 段仍用已知样本 id 验证。',
      lr && lr.code,
    );
  } else {
    const list = lr.data.lootTruckViewList;
    console.log(
      '列表车辆数:',
      list.length,
      ' 样例 truckSpecId/battlePower/scoutReportId:',
      list
        .slice(0, 3)
        .map((t) => ({ spec: t.truckSpecId, bp: t.battlePower, scout: i64str(t.scoutReportId) })),
    );
    const withScout = list.find((t) => i64str(t.scoutReportId));
    firstScout = withScout ? i64str(withScout.scoutReportId) : '';
  }

  // ── B) army_type：对样本英雄 id（你的 999 预设 + 已知卡车库）查 hero 表 ──
  H('B) hero 表 army_type 是否可用（101陆/201海/301空）');
  const sampleHeroIds = [
    ...new Set(
      [].concat((preset && preset.heroList) || [], [165, 173, 172, 169, 174, 170, 241, 240, 234]),
    ),
  ];
  if (!TABLE) console.error('[truck-probe] B 段跳过：TableManager.TABLE 不可用。');
  else {
    const rows = [];
    for (const hid of sampleHeroIds) {
      const r = row('HERO', hid) || row('hero', hid);
      rows.push({
        heroId: hid,
        有行: r ? '✓' : '✗',
        army_type: armyTypeOf(r),
        _keys: r ? Object.keys(r).slice(0, 12).join(',') : '',
      });
    }
    console.table(rows);
    const hit = rows.find((x) => x.army_type != null);
    console.log(
      '%c[truck-probe] ★ hero 表 army_type ' +
        (hit ? '可用，样例=' + hit.army_type : '没取到——键名可能不是 army_type，看 _keys 列'),
      'color:#e07b00;font-weight:bold',
    );
    if (hit)
      console.log(
        '该行完整字段样本:',
        JSON.stringify(row('HERO', hit.heroId) || row('hero', hit.heroId)),
      );
  }

  // ── C) 927 战报：reportStr 形态 + defender 结构 ──
  H('C) 927 MAIL_GETREPORT reportStr 形态（对象 or 需 parse 字符串）');
  if (!firstScout) console.warn('[truck-probe] C 段跳过：没拿到 scoutReportId（列表空）。');
  else {
    const rr = await netSend(CMD_REPORT, { reportId: firstScout });
    if (rr) {
      console.log('927 ok=%s code=%s; reportId=%s', rr.ok, rr.code, firstScout);
      const rsRaw = rr.data && rr.data.reportStr;
      console.log('reportStr typeof=%s', typeof rsRaw);
      const battle =
        rr.data && (rsRaw && typeof rsRaw === 'string' ? tryParse(rsRaw) : rsRaw)?.battle;
      const parsedRs = typeof rsRaw === 'string' ? tryParse(rsRaw) : rsRaw;
      const b2 = (parsedRs && parsedRs.battle) || (rr.data && rr.data.battle) || battle;
      console.log(
        '%c[truck-probe] ★ battle 路径：reportStr.battle=%s（reportStr 是字符串则需 parse）',
        'color:#4a90d9;font-weight:bold',
        b2 ? '✓' : '✗ 换个路径找',
      );
      if (b2) {
        console.log('fightType=%s  keys=%s', b2.fightType, Object.keys(b2));
        const def = b2.defender || {};
        console.log(
          'defender keys:',
          Object.keys(def),
          ' units条数:',
          (def.units || []).length,
          ' players条数:',
          (def.players || []).length,
        );
        if (def.players && def.players[0]) {
          defenderHeroIds = (def.players[0].heroList || []).map((h) =>
            h && h.id != null ? h.id : h,
          );
          console.log('defender heroList ids:', defenderHeroIds, ' career:', def.players[0].career);
        }
        if (def.units) {
          defenderArmyIds = [...new Set((def.units || []).map((u) => u.armyId))];
          console.log('defender units armyIds:', defenderArmyIds);
        }
        console.log('%c原始 reportStr（截断 1200 字，可贴回细看）：', 'color:#888');
        console.log(
          String(typeof rsRaw === 'string' ? rsRaw : JSON.stringify(rsRaw)).slice(0, 1200),
        );
      }
    } else console.warn('[truck-probe] C 段：927 未拿到响应。');
  }

  // ── D) 顺带验 army 表有没有 army_type（units armyId 直接查，作 hero 之外的第二路）──
  H('D) army 表 army_type（用战报/预设里的 armyId 直接查）');
  const armyIds = [
    ...new Set(
      [].concat(
        defenderArmyIds,
        ((preset && preset.armyListNew) || []).map((a) => a.armyId),
      ),
    ),
  ];
  if (!armyIds.length || !TABLE) console.warn('[truck-probe] D 段跳过：无 armyId 样本或表不可用。');
  else {
    const rows = armyIds.map((aid) => {
      const r = row('ARMY', aid) || row('army', aid);
      return {
        armyId: aid,
        有行: r ? '✓' : '✗',
        army_type: armyTypeOf(r),
        army_type_all: r && r.army_type_all,
        _keys: r ? Object.keys(r).slice(0, 12).join(',') : '',
      };
    });
    console.table(rows);
    console.log(
      '%c[truck-probe] 说明：机甲兵(5xxxxx/90xxxx)可能落 army_type_all 或无行——判定主用 hero.army_type，units 作辅。',
      'color:#888',
    );
  }

  // ── 汇总：需要你确认/贴回的结论点 ──
  H('结论清单（把上面各段 JSON/表贴回来即可定稿判定器）');
  console.log(
    [
      '1) A 段：999 战力数字的字段名 =？（看"999 里的数值字段"那行）',
      '2) B 段：hero 表 army_type 是否可用、值是否∈{101,201,301}（陆/海/空）',
      '3) C 段：927 的 reportStr 是字符串还是对象；battle.defender.heroList/units 形态是否如预期',
      '4) D 段：army 表 army_type 是否可用（机甲 army_type_all 情况）',
      '5) 对方军种判定策略确认：以 defender.heroList→hero.army_type 为主，units 为辅（机甲不单独判）',
    ].join('\n'),
  );
})();
