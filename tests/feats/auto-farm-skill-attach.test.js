// skillAttach 纯函数单测：装配计划（复制/补书决策表）+ 归还计划（白名单 diff）+ 表反查。
// 判据全部来自 20261121 温泰实验直证：
//   同款跨组平装放行（幂等跳过）、同族更高档挂载时低档必拒（跳过）、不同前缀段可并存、
//   表反查 = 官方 getItemIdByHeroSkill 口径（type==42 && para1==skillId && level==档）。
// 纯函数不发包不摸游戏符号；feat 模块 import 链会触到浏览器全局，先按 mech-build 同款最小桩化。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 浏览器全局最小桩（模块加载期需要，函数体不触碰）─────────────────────
globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { href: '' },
  document: {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  querySelector: () => null,
};
globalThis.chrome = globalThis.chrome || {
  runtime: { id: 'test', sendMessage() {}, getURL: (s) => s, onMessage: { addListener() {} } },
};

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = realSetInterval(fn, ms, ...rest);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

const mod = await import('../../extension/src/feats/player/auto-farm/skill-attach.js');
const {
  SKILL_BOOK_FAMILIES,
  COLLECT_BOOK_PREFIXES,
  BOOK_TYPE,
  bookPrefix,
  itemIdForSkill,
  skillFamilyPrefix,
  collectSkillWhitelist,
  planAttach,
  planDetachSlots,
} = mod;

// ── ITEM 表 fixture（温泰样本 + 字典表语义，形状 = getTableGroup('item') 行表）──────
// 温泰组2 三本：20301Lv5←2503805（泰温专属）、21205Lv6←2523506（负重稀有）、20205Lv5←2503505（负重普通）。
// 21204/21205 同为 25235 前缀族（负重稀有段的不同档）；玩家手装非采集技能用 90001（无书）。
function makeItems() {
  const t = {};
  const add = (id, para1, level) => {
    t[String(id)] = { id: id, type: BOOK_TYPE, para1: String(para1), level: level };
  };
  // 泰温专属（20301）五档
  add(2503801, 20301, 1);
  add(2503802, 20301, 2);
  add(2503803, 20301, 3);
  add(2503804, 20301, 4);
  add(2503805, 20301, 5);
  // 负重稀有（25235 段）：21204=Lv5 档、21205=Lv6 档
  add(2523501, 21200, 1);
  add(2523505, 21204, 5);
  add(2523506, 21205, 6);
  // 负重普通（25035 段）：20205=Lv5 档
  add(2503505, 20205, 5);
  // 粮食采集（25234/25034）：21106/20106 Lv6
  add(2523406, 21106, 6);
  add(2503406, 20106, 6);
  // 石油采集（25233/25033）
  add(2523306, 21103, 6);
  add(2503306, 20103, 6);
  // 金币采集（25232/25032）
  add(2523206, 21102, 6);
  add(2503206, 20102, 6);
  // 野外采集（25235 稀有/25035 普通全域段）——注意负重也住在这两段！
  // 字典表：25235=野外采集速度(稀有)、25035=野外采集速度；温泰书 2523506 装出 21205、2503505 装出 20205。
  // 故 25235 段=负重+野外共段吗？——实证否：2523506(负重稀有Lv6) 与野外稀有同段同号空间，说明
  // 「段=技能族」的口径以 para1 为准：同段可含多族书（负重/野外），族键用书前缀仅在本实现内成立，
  // 因为白名单/优先级表都以「前缀」为选择与排除单位（竞品同口径）。这里按温泰实证造表：
  add(2523507, 21207, 7); // 假设的野外稀有更高档（同段不同 para1）
  add(2503507, 20207, 7); // 假设的野外普通更高档
  return t;
}

const G1_EMPTY = [
  { skillId: 0, level: 0 },
  { skillId: 0, level: 0 },
  { skillId: 0, level: 0 },
];
const WENTAI_G2 = [
  { skillId: 20301, level: 5 },
  { skillId: 21205, level: 6 },
  { skillId: 20205, level: 5 },
];

test('反查：itemIdForSkill 按 (type,para1,level) 命中温泰三本；skillFamilyPrefix 出族键', () => {
  const items = makeItems();
  assert.equal(itemIdForSkill(items, 20301, 5), 2503805);
  assert.equal(itemIdForSkill(items, 21205, 6), 2523506);
  assert.equal(itemIdForSkill(items, 20205, 5), 2503505);
  assert.equal(itemIdForSkill(items, 20301, 9), 0); // 无此档
  assert.equal(itemIdForSkill(null, 20301, 5), 0);
  assert.equal(skillFamilyPrefix(items, 21205), 25235);
  assert.equal(skillFamilyPrefix(items, 20205), 25035);
  assert.equal(skillFamilyPrefix(items, 90001), 0); // 非技能书技能
});

test('bookPrefix/优先级表：稀有段优先（野外稀→专精稀→野外普→专精普）；雷神无专精用负重补位', () => {
  assert.equal(bookPrefix(2503805), 25038);
  assert.deepEqual(SKILL_BOOK_FAMILIES[1], [25235, 25233, 25035, 25033]);
  assert.deepEqual(SKILL_BOOK_FAMILIES[5], [25235, 25234, 25035, 25034]);
  assert.deepEqual(SKILL_BOOK_FAMILIES[7], [25235, 25232, 25035, 25032]);
  assert.deepEqual(SKILL_BOOK_FAMILIES[16], [25235, 25035, 25236, 25036]);
  for (const fam of Object.keys(SKILL_BOOK_FAMILIES)) {
    for (const p of SKILL_BOOK_FAMILIES[fam]) {
      assert.ok(COLLECT_BOOK_PREFIXES.indexOf(p) >= 0, `prefix ${p} must be whitelisted`);
    }
  }
});

test('planAttach：组1=组2 全同款 → 空计划（温泰切组后复制幂等）', () => {
  const items = makeItems();
  const plan = planAttach(items, WENTAI_G2, WENTAI_G2, [], SKILL_BOOK_FAMILIES[5]);
  assert.deepEqual(plan.copy, []);
  assert.deepEqual(plan.fill, []);
});

test('planAttach：复制装空槽（g1 有 A/B、g2 全空 → copy 两条占 index0/2），同款/同族幂等', () => {
  const items = makeItems();
  const g1 = [
    { skillId: 20301, level: 5 },
    { skillId: 0, level: 0 },
    { skillId: 20205, level: 5 },
  ];
  const g2 = [
    { skillId: 20301, level: 5 }, // 组2 已挂同款 → 跳过
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
  ];
  const plan = planAttach(items, g1, g2, [], SKILL_BOOK_FAMILIES[5]);
  assert.equal(plan.copy.length, 1); // 只剩 20205 需复制
  assert.deepEqual(plan.copy[0], { index: 1, skillId: 20205, level: 5, itemId: 2503505 });
  // trace 决策流水（调用方 debug 日志的对拍证据）：复制行 + 同款幂等跳过行
  const tr = plan.trace.join(' | ');
  assert.ok(tr.includes('copy idx=1 skill=20205 lv=5 book=2503505'), tr);
  assert.ok(tr.includes('dup skill=20301'), tr);
  assert.deepEqual(plan.fill, []); // bag 空
});

test('planAttach：组2 已挂同族更高档 → 不复制低档（温泰 L77 equip001 复现）', () => {
  const items = makeItems();
  const g1 = [
    { skillId: 21204, level: 5 }, // 低档（同 25235 族）
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
  ];
  const g2 = [
    { skillId: 21205, level: 6 }, // 组2 已挂高档
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
  ];
  const plan = planAttach(items, g1, g2, [], SKILL_BOOK_FAMILIES[5]);
  assert.deepEqual(plan.copy, []);
  // trace 跳过理由带「组2 已挂谁」：equip001 规避的证据链（attach plan debug 行直接可读）
  assert.ok(
    plan.trace.join(' | ').includes('low skill=21204 lv=5 (g2 has 21205 lv=6 fam=25235)'),
    plan.trace.join(' | '),
  );
});

test('planAttach：玩家手装非采集技能（白名单外）不拦复制、不覆盖', () => {
  const items = makeItems();
  const g1 = [
    { skillId: 20301, level: 5 },
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
  ];
  const g2 = [
    { skillId: 90001, level: 3 }, // 玩家战斗技能（无书 → 无族键）
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
  ];
  const plan = planAttach(items, g1, g2, [], SKILL_BOOK_FAMILIES[5]);
  assert.equal(plan.copy.length, 1);
  assert.equal(plan.copy[0].index, 1); // 90001 槽不动，占 index1
});

test('planAttach：补书按前缀优先级逐槽装（野外稀→专精稀→野外普，稀有段效率优先），同 para1 取最高档', () => {
  const items = makeItems();
  const bag = [
    { itemId: 2503803, amount: 1 }, // 泰温专属 Lv3（同 para1 有 Lv5）
    { itemId: 2503805, amount: 1 }, // 泰温专属 Lv5 ← 应被选中
    { itemId: 2523506, amount: 1 }, // 负重稀有 Lv6（族专精？25235 段）
    { itemId: 2503505, amount: 1 }, // 负重普通 Lv5
    { itemId: 2523406, amount: 1 }, // 粮食稀有
    { itemId: 9000005, amount: 5 }, // 非技能书 type 不符（表里没有 → 过滤）
  ];
  const plan = planAttach(items, G1_EMPTY, G1_EMPTY, bag, SKILL_BOOK_FAMILIES[5]);
  // 25235 段候选：2523506(Lv6, para1 21205)；25234 段候选：2523406(Lv6, para1 21106)；
  // 25035 段候选：2503505(Lv5, para1 20205)。泰温专属 25038 段不在 family5 表 → 不选。
  // 稀有段效率实证（20261121）：专精稀(25234) 效率 == 野外稀且 > 野外普，故第二本装专精稀。
  assert.equal(plan.fill.length, 3);
  assert.equal(plan.fill[0].itemId, 2523506);
  assert.equal(plan.fill[0].index, 0);
  assert.equal(plan.fill[1].itemId, 2523406); // 专精稀有(25234) 优先于野外普通(25035)
  assert.equal(plan.fill[1].index, 1);
  assert.equal(plan.fill[2].itemId, 2503505);
  assert.equal(plan.fill[2].index, 2);
});

test('planAttach：库存不足（bag 空/Amount=0）→ fill 空；同款已被组2 挂载 → 排除', () => {
  const items = makeItems();
  const bag = [{ itemId: 2503805, amount: 1 }];
  const g2 = [
    { skillId: 20301, level: 5 }, // 2503805 的 para1 已挂
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
  ];
  const plan = planAttach(items, G1_EMPTY, g2, bag, SKILL_BOOK_FAMILIES[5]);
  assert.deepEqual(plan.fill, []);
  const plan2 = planAttach(
    items,
    G1_EMPTY,
    G1_EMPTY,
    [{ itemId: 2503805, amount: 0 }],
    SKILL_BOOK_FAMILIES[5],
  );
  assert.deepEqual(plan2.fill, []);
});

test('planAttach：fill 与 copy 不重复占同槽/同款；跨英雄共享 bag 时消账（消 amount 由调用方做，计划层靠 taken）', () => {
  const items = makeItems();
  const g1 = [
    { skillId: 20301, level: 5 },
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
  ];
  const bag = [
    { itemId: 2503805, amount: 1 },
    { itemId: 2523506, amount: 1 },
  ];
  const plan = planAttach(items, g1, G1_EMPTY, bag, SKILL_BOOK_FAMILIES[5]);
  assert.equal(plan.copy.length, 1); // 20301 → index0
  assert.equal(plan.fill.length, 1); // 剩 index1/2 两空槽，但 2523506 同段已由 copy 占（21205→25235）？
  // copy 装的是 20301（25038 段）——25235 段未被 copy 占，fill 候选 2523506 → index1
  assert.equal(plan.fill[0].itemId, 2523506);
  assert.equal(plan.fill[0].index, 1);
});

test('planDetachSlots：白名单内且快照没有 → 卸；快照同款与白名单外手装 → 留', () => {
  const items = makeItems();
  const g2 = [
    { skillId: 21106, level: 6 }, // fill 项（feat 只补族表内书，快照该槽空）
    { skillId: 21205, level: 6 }, // copy 项（快照该槽空）
    { skillId: 90001, level: 3 }, // 玩家手装（白名单外）
  ];
  const snap = [
    { skillId: 0, level: 0 },
    { skillId: 0, level: 0 },
    { skillId: 90001, level: 3 },
  ];
  const drop = planDetachSlots(items, g2, snap);
  assert.deepEqual(drop, [
    { index: 0, skillId: 21106 },
    { index: 1, skillId: 21205 },
  ]);
  // 玩家原有采集书（快照本就有）不动；玩家的泰温专属书（25038 段不在族表）也不动
  const drop2 = planDetachSlots(items, WENTAI_G2, WENTAI_G2);
  assert.deepEqual(drop2, []);
  const drop3 = planDetachSlots(items, [{ skillId: 20301, level: 5 }], [{ skillId: 0, level: 0 }]);
  assert.deepEqual(drop3, []); // 25038 段（英雄专属）不在白名单：feat 不会补装它，也就永不误卸
});

test('collectSkillWhitelist：族表前缀的 para1 全收；英雄专属段（25038）不收——feat 补装范围的精确边界', () => {
  const items = makeItems();
  const wl = collectSkillWhitelist(items);
  assert.equal(wl['21205'], true);
  assert.equal(wl['20205'], true);
  assert.equal(wl['21106'], true);
  assert.equal(wl['90001'], undefined);
  assert.equal(wl['20301'], undefined); // 泰温专属（25038 段）不是 feat 补装对象
});

test('loadoutInfo：slot 未加载/无记录时同步安全返回 null（懒触发异步加载，不抛不挂）', () => {
  // 面板 get() 同步调它：首次必经未加载态，必须同步返回 null 且只触发后台 loadState
  assert.equal(mod.skillAttach.loadoutInfo(205), null);
  assert.equal(mod.skillAttach.loadoutInfo(0), null);
});

test('loadoutItems：结构化实装清单（空槽/空项跳过；表缺失时 name 占位、tag 空不炸）', () => {
  // 面板「队列技能」徽章数据源；桩环境下 hero_skill 表未注入，skillInfo 降级 name? 不阻塞
  const h = {
    _secondSkillList: [{ skillId: 21205, level: 6 }, null, { skillId: 0, level: 3 }],
  };
  const items = mod.skillAttach.loadoutItems(h, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].skillId, 21205);
  assert.equal(items[0].level, 6);
  assert.equal(typeof items[0].name, 'string');
  assert.equal(items[0].tag, '');
  // 组1 与空对象：都回空数组不抛
  assert.deepEqual(mod.skillAttach.loadoutItems({ _firstSkillList: [] }, 1), []);
  assert.deepEqual(mod.skillAttach.loadoutItems(null, 2), []);
});
