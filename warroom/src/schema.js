// SQLite schema as versioned migrations, applied via PRAGMA user_version.
// Design principles (see discussion):
//  - cold/hot split: hot GROUP BY fields are real columns, long-tail detail stays JSON
//  - all 64-bit ids are TEXT (report_id / uuid / march_id / uid) — never Number
//  - every parsed artifact carries dict_version for reproducible decode

/** @type {{ version: number, up: string }[]} */
export const MIGRATIONS = [
  {
    version: 1,
    up: `
    -- 一份战报一行：顶层信封 + 结论 + 落盘/解析追踪
    CREATE TABLE IF NOT EXISTS reports (
      report_id       TEXT PRIMARY KEY,
      logtime         INTEGER,
      point_str       TEXT,
      src_point_str   TEXT,
      fight_type      INTEGER,
      fight_type2     TEXT,
      result          INTEGER,
      stage           INTEGER,
      ver             INTEGER,
      server_version  TEXT,
      extra_flag      TEXT,            -- JSON
      raw_path        TEXT NOT NULL,    -- 原始 JSON 文件相对路径
      dict_version    TEXT,             -- 解析所用数据字典版本
      fetched_at      INTEGER NOT NULL, -- 下载落盘时刻(ms)
      parsed_at       INTEGER           -- 结构化解析完成时刻(ms)，未解析为 NULL
    );

    -- fightMarches[]：一场战报可含多场对决(留扩展)
    CREATE TABLE IF NOT EXISTS battle_marches (
      report_id           TEXT NOT NULL REFERENCES reports(report_id),
      seq                 INTEGER NOT NULL,
      att_march_id        TEXT,
      def_march_id        TEXT,
      att_fight_team_id   INTEGER,
      def_fight_team_id   INTEGER,
      att_power           REAL,
      def_power           REAL,
      att_max_power       REAL,
      def_max_power       REAL,
      att_battle_power    TEXT,      -- display string like "93.0M" (game NumUtils format)
      def_battle_power    TEXT,
      att_battle_power_val INTEGER,  -- raw numeric counterpart
      def_battle_power_val INTEGER,
      att_over_round      INTEGER,
      def_over_round      INTEGER,
      att_army_num        INTEGER,
      def_army_num        INTEGER,
      skill_hurts         TEXT,          -- JSON
      traps               TEXT,          -- JSON
      raw                 TEXT,          -- JSON: 未考证字段兜底
      PRIMARY KEY (report_id, seq)
    );

    -- 行军方视角：每份战报 att/def 各一行
    CREATE TABLE IF NOT EXISTS sides (
      report_id     TEXT NOT NULL REFERENCES reports(report_id),
      side          TEXT NOT NULL,       -- 'att' | 'def'
      uid           TEXT,
      march_id      TEXT,
      career        INTEGER,             -- 字典键
      al_tag        TEXT,
      fight_team_id INTEGER,
      total         INTEGER,
      survival      INTEGER,
      dead          INTEGER,
      wounded       INTEGER,
      element_levels TEXT,               -- JSON
      buffs         TEXT,                -- JSON
      mechas        TEXT,                -- JSON
      isolated      INTEGER,
      stamp         INTEGER,
      PRIMARY KEY (report_id, side)
    );

    -- side 下挂 N 个参战玩家(驻军/联盟成员)；未考证容器先 JSON
    CREATE TABLE IF NOT EXISTS side_players (
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      side       TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      uid        TEXT,
      player_info       TEXT,   -- JSON
      hero_list         TEXT,   -- JSON
      formation_v2      TEXT,   -- JSON
      army_equips       TEXT,   -- JSON
      new_army_equips   TEXT,   -- JSON
      enigmas           TEXT,   -- JSON
      ctc               TEXT,   -- JSON: CTCs
      army_mastery      TEXT,   -- JSON
      effect_skins      TEXT,   -- JSON
      effect_decorations TEXT,  -- JSON
      traps             TEXT,   -- JSON
      standings         TEXT,   -- JSON: 玩家级 allStandings
      PRIMARY KEY (report_id, side, seq)
    );

    -- units[]：编队组(语义待源码考证)
    CREATE TABLE IF NOT EXISTS side_units (
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      side       TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      army_id    INTEGER,      -- 字典键
      is_extra   INTEGER,
      max_power  INTEGER,
      max_shield INTEGER,
      max_element_power INTEGER,
      uuid_count INTEGER,
      dead_count INTEGER,
      is_dead    INTEGER,
      uid_owner  TEXT,
      uuids      TEXT,         -- JSON: [{uuid,isDead}]
      PRIMARY KEY (report_id, side, seq)
    );

    -- 个体 64 位 uuid（首期可只由 units.uuids 反范式填，供检索）
    CREATE TABLE IF NOT EXISTS unit_instances (
      uuid       TEXT NOT NULL,
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      side       TEXT NOT NULL,
      army_id    INTEGER,
      is_dead    INTEGER,
      PRIMARY KEY (uuid, report_id)
    );

    -- process[]：按 t 分型的时序事件流水，原样落库
    CREATE TABLE IF NOT EXISTS battle_events (
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      idx        INTEGER NOT NULL,
      t          INTEGER,
      source     TEXT,
      target     TEXT,
      val        INTEGER,
      self_val   INTEGER,
      power      INTEGER,
      skill      INTEGER,
      hero       INTEGER,
      buff_id    INTEGER,
      tl         INTEGER,
      raw        TEXT,          -- JSON: 完整事件对象
      PRIMARY KEY (report_id, idx)
    );

    -- 跨战报玩家档案（战力统计主对象）
    CREATE TABLE IF NOT EXISTS players (
      uid            TEXT PRIMARY KEY,
      name           TEXT,
      server         TEXT,
      first_seen     INTEGER,
      last_seen      INTEGER,
      power_latest   INTEGER,
      power_peak     INTEGER,
      battles_att    INTEGER DEFAULT 0,
      battles_def    INTEGER DEFAULT 0,
      wins           INTEGER DEFAULT 0,
      losses         INTEGER DEFAULT 0,
      draws          INTEGER DEFAULT 0,
      troops_dead    INTEGER DEFAULT 0,
      troops_wounded INTEGER DEFAULT 0
    );

    -- 解码后的数据字典快照(版本化)
    CREATE TABLE IF NOT EXISTS dict_entries (
      dict_version TEXT NOT NULL,
      category     TEXT NOT NULL,
      key          TEXT NOT NULL,
      value        TEXT NOT NULL,   -- JSON
      PRIMARY KEY (dict_version, category, key)
    );

    -- 分析输出：规则/统计结论
    CREATE TABLE IF NOT EXISTS rule_findings (
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      rule_id    TEXT NOT NULL,
      side       TEXT,               -- 'att'|'def'|NULL(整体)
      severity   TEXT,
      metric     TEXT,
      detail     TEXT,               -- JSON
      created_at INTEGER NOT NULL,
      PRIMARY KEY (report_id, rule_id, side)
    );

    -- 分析输出：LLM 报告，scope 对应整体/攻方/守方三份
    CREATE TABLE IF NOT EXISTS analyses (
      report_id      TEXT NOT NULL REFERENCES reports(report_id),
      scope          TEXT NOT NULL,  -- 'overall'|'attacker'|'defender'
      model          TEXT,
      prompt_version TEXT,
      report_md      TEXT,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (report_id, scope, prompt_version)
    );

    CREATE INDEX IF NOT EXISTS idx_reports_logtime ON reports(logtime);
    CREATE INDEX IF NOT EXISTS idx_marches_att ON battle_marches(att_march_id);
    CREATE INDEX IF NOT EXISTS idx_sides_uid ON sides(uid);
    CREATE INDEX IF NOT EXISTS idx_events_t ON battle_events(t);
    CREATE INDEX IF NOT EXISTS idx_unit_inst_army ON unit_instances(army_id);
    `,
  },
  {
    version: 2,
    up: `
    -- Phase 2c 归一表：把散落在各编配视图的数值加成统一成一行一 buff，
    -- 每行携带 source_view，使聚合统计能按来源视图分列、跨视图不重复计数。
    -- 芯片/装备/天赋等"数字属性码"均已归约到 effect_buff (见 normalize.js)。
    CREATE TABLE IF NOT EXISTS buff_effects (
      report_id    TEXT NOT NULL REFERENCES reports(report_id),
      side         TEXT NOT NULL,          -- 'att' | 'def'
      player_seq   INTEGER NOT NULL,       -- 0 = side 级聚合(effectBuffs/机甲芯片)
      source_view  TEXT NOT NULL,          -- side_effect_buffs|mecha_chip|hero_talent|hero_equip|enigma_beast|enigma_field|decoration_sublime|decoration_exp
      seq          INTEGER NOT NULL,       -- (side,player_seq,source_view) 内序号，保证 PK 唯一
      item_ref     TEXT,                   -- 来源实体: chipId/heroId/slotId/decorationId... (原样字符串)
      attr_slot    TEXT,                   -- 子槽位: 芯片 rndAttrs 码 / 装备 templateId / 兽 buff 下标
      buff_id      INTEGER,                -- 归一后的 effect_buff id (未解析视图为 NULL)
      name         TEXT,                   -- 解析中文名(effect_buff.string->locale)
      raw_value    INTEGER,                -- 战报里的原始数值(万分比按 value_type 换算, 此处存原值)
      value_type   INTEGER,                -- effect_buff.value_type: 10000=万分比 1=绝对值
      category     INTEGER,
      type         INTEGER,
      target       INTEGER,
      para_type1   TEXT,                   -- 作用域类型 (ArmyType/FightSide...)
      para1        TEXT,
      dict_version TEXT,
      PRIMARY KEY (report_id, side, player_seq, source_view, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_buff_eff_id ON buff_effects(buff_id);
    CREATE INDEX IF NOT EXISTS idx_buff_eff_view ON buff_effects(source_view);
    `,
  },
  {
    version: 3,
    up: `
    -- 伤害/效果贡献归因：战报 fightMarches[].{att,def}SkillHurts 把本场累计伤害按来源拆开——
    --   effect_buff_hurts{buffId:伤害} 是每个 effect_buff 造成的总伤害；
    --   skill_hurts{skillId:伤害} + skill_hurt_count{skillId:次数} 是每个技能的伤害与触发次数。
    -- 统一成 kind('buff'|'skill') 一源一行，供 Phase 3 做"谁贡献了伤害"归因（区别于 buff_effects 的属性加成）。
    CREATE TABLE IF NOT EXISTS damage_sources (
      report_id  TEXT NOT NULL REFERENCES reports(report_id),
      side       TEXT NOT NULL,          -- 'att' | 'def'
      kind       TEXT NOT NULL,          -- 'buff' | 'skill'
      ref        TEXT NOT NULL,          -- effect_buff id 或 hero_skill id（原样字符串）
      name       TEXT,                   -- 解析中文名(effect_buff/hero_skill -> locale)
      hurt       REAL,                   -- 累计伤害
      hits       INTEGER,                -- 触发次数(仅 skill，buff 为 NULL)
      dict_version TEXT,
      PRIMARY KEY (report_id, side, kind, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_dmg_src ON damage_sources(kind);
    `,
  },
  {
    version: 4,
    up: `
    -- process[] 语义富化：把回放事件的结构化字段从 raw JSON 提升成正式列。
    -- 纯语义列（parse.insertEvents 用 event-semantics.js 直接算出，不依赖字典）：
    --   kind        NBattlePvPDataProcessType 事件类型名 (Attack/Skill/AddSkillBuff/...)
    --   outcome     攻击命中结果 miss/crit/hit (actType→NBattleDamageFlags)
    --   act_type    原始命中标志;  e_type/e_value 元素类型/元素伤害;  old_hit 累计伤害
    --   trigger_type 技能触发方式; ev_id 事件/单位内序号 id;  targets/nums 多目标数组(JSON)
    --   buff_src    buff id 来源字段 'field'(p.buffId) | 'val'(p.val) | NULL
    --   buff_id 语义升级：不再是只取 p.buffId（会漏 3588 条 val 承载的增益/损益/控制状态），
    --   改存 buffRefOf 解析出的正确 effect_buff id（字段优先、val 兜底）。
    ALTER TABLE battle_events ADD COLUMN kind         TEXT;
    ALTER TABLE battle_events ADD COLUMN outcome      TEXT;
    ALTER TABLE battle_events ADD COLUMN act_type     INTEGER;
    ALTER TABLE battle_events ADD COLUMN e_type       INTEGER;
    ALTER TABLE battle_events ADD COLUMN e_value      INTEGER;
    ALTER TABLE battle_events ADD COLUMN old_hit      INTEGER;
    ALTER TABLE battle_events ADD COLUMN trigger_type INTEGER;
    ALTER TABLE battle_events ADD COLUMN ev_id        INTEGER;
    ALTER TABLE battle_events ADD COLUMN targets      TEXT;   -- JSON 数组
    ALTER TABLE battle_events ADD COLUMN nums         TEXT;   -- JSON 数组
    ALTER TABLE battle_events ADD COLUMN buff_src     TEXT;
    -- 字典富化列（normalize.enrichBattleEvents 按 buff_id/skill/hero 反查回填）：
    --   buff_name/effect_buff 语义 + skill_name/hero_name 连名，使眩晕/沉默/虚弱等状态可命名/可归因。
    ALTER TABLE battle_events ADD COLUMN buff_name        TEXT;
    ALTER TABLE battle_events ADD COLUMN buff_type        INTEGER;  -- effect_buff.type (行为码, 467 种)
    ALTER TABLE battle_events ADD COLUMN buff_is_minus    INTEGER;  -- effect_buff.is_minus 减益标志(状态类多为此)
    ALTER TABLE battle_events ADD COLUMN buff_target      INTEGER;
    ALTER TABLE battle_events ADD COLUMN buff_value_type  INTEGER;  -- 10000=万分比 1=绝对值
    ALTER TABLE battle_events ADD COLUMN buff_sustained   INTEGER;  -- sustained_buff → buff_show 状态显示元数据 id
    ALTER TABLE battle_events ADD COLUMN buff_debuff_time INTEGER;  -- debuff_para_time 减益持续
    ALTER TABLE battle_events ADD COLUMN skill_name       TEXT;
    ALTER TABLE battle_events ADD COLUMN hero_name        TEXT;
    CREATE INDEX IF NOT EXISTS idx_events_kind ON battle_events(kind);
    CREATE INDEX IF NOT EXISTS idx_events_buff ON battle_events(buff_id);
    `,
  },
];
