/**
 * 技能图标数据源全貌探针 v5（游戏页 DevTools Console 整段粘贴）——
 * 「面板技能图标全同/不对」的定案工具。游戏源码 HeroElementItem.UpdateSkillItem 权威口径：
 * skill_type==1 才读 hero_skill.skill_icon，其余类型走 item 表反查
 * （getTableByKey('item','type',42,'para1',skillId,'level',1)[0].icon）。
 * 本探针不需要具体 skillId，直接扫两张表输出数据源全貌：
 * ① item 表 type=42 家族全量 → para1 分组 → 每组 icon 采样（证真图标在 item 表且互不相同）；
 * ② hero_skill 表按占位值反查 → name/skill_type 分布（证非 1 行的 skill_icon 是废弃占位）；
 * ③ getTableByKey 可用参数形态实测（四参/七参）。
 * 若扩展面板重载后图标仍异常，把本 JSON 整块贴回。只读零发包。
 */
(async () => {
  const out = { item42: null, heroSkill: null, keyApi: null, err: [] };
  const R = (n) => {
    try {
      return window.__require(n);
    } catch (e) {
      return null;
    }
  };
  const done = () => {
    console.log('=== SKILL-ICON PROBE5 RESULT (整块复制) ===');
    console.log(JSON.stringify(out, null, 1));
  };

  try {
    const TM = R('TableManager');
    const T = TM && (TM.TABLE || (TM.default && TM.default.TABLE));
    if (!T || typeof T.getTableByKey !== 'function') {
      out.err.push('no TableManager.TABLE.getTableByKey');
      return done();
    }

    // getTableByKey 参数形态实测：七参（UpdateSkillItem 同款）/四参（双键）是否都可用
    out.keyApi = {
      four: (() => {
        try {
          const r = T.getTableByKey('item', 'type', 42);
          return r && r.length;
        } catch (e) {
          return 'ERR:' + e.message;
        }
      })(),
      seven: (() => {
        try {
          const r = T.getTableByKey('item', 'type', 42, 'para1', 2523506, 'level', 1);
          return r && r.length;
        } catch (e) {
          return 'ERR:' + e.message;
        }
      })(),
    };

    // ① item 表 type=42 家族全量 → para1 分组 → icon 采样（互异性一目了然）
    try {
      const all = T.getTableByKey('item', 'type', 42) || [];
      const byPara = {};
      for (let i = 0; i < all.length; i++) {
        const r = all[i] || {};
        const k = String(r.para1);
        if (!byPara[k])
          byPara[k] = { icon: String(r.icon || ''), name: r.name | 0, lv1: r.level | 0, n: 0 };
        byPara[k].n++;
      }
      const keys = Object.keys(byPara);
      out.item42 = {
        total: all.length,
        uniqPara1: keys.length,
        sample: keys.slice(0, 12).map(function (k) {
          return { para1: k, icon: byPara[k].icon, n: byPara[k].n };
        }),
      };
    } catch (e) {
      out.err.push('item42: ' + e.message);
    }

    // ② hero_skill 占位行反查：全部 skill_icon 同值行（废弃占位证据）的 name/skill_type 分布
    try {
      const ph = T.getTableByKey('hero_skill', 'skill_icon', 'skill_icon020') || [];
      out.heroSkill = {
        placeholderRows: ph.length,
        sample: ph.slice(0, 8).map(function (r) {
          return { id: r.id, name: r.name, skill_type: r.skill_type | 0 };
        }),
      };
    } catch (e) {
      out.err.push('heroSkill: ' + e.message);
    }
  } catch (e) {
    out.err.push('fatal: ' + e.message);
  }
  done();
})();
