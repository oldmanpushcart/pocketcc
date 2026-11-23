/**
 * player/auto-farm · 采集技能装载子引擎（skill-attach）
 *
 * 「组1 模板 + 组2 复制补齐 + 借还轮转」：派兵前把预设英雄切到技能组2，复制其组1 内容并按
 * 资源族补装采集书；派兵受理（增益此刻写进行军快照，事后卸下不丢收益）后卸掉补装项并切回组1，
 * 书即回池供下一队轮转。机制与账目全部由 20261120/20261121 三段真人录制实证：
 *
 *   账目 = (heroId, itemId) 一份账 —— 897 新登记扣账；同英雄跨组平装同款同档放行不扣账（复制免费）；
 *   898 注销最后一个登记 → 10401 amount+1 还账（60ms 内）；另一组还有同款登记 → 不还账。
 *   同英雄已有同族更高档时装低档被拒（应答 data="hero_skill_equip001" 裸串且无 10906 跟随）。
 *   1345 切组纯指针：两组内容零变化、账零变化，10906 在 66~74ms 即时镜像翻转（先于 resp）。
 *   排他粒度 = 英雄：一个英雄同族只能挂 1 本（planAttach 的 fams/taken 按英雄各建一份），但同一队
 *   的不同英雄可以各挂一本——同款多本（同 itemId Amount>1）即为此准备：借出逐本消账（-1），
 *   有 N 本就能同队发给 N 个英雄（20261122 用户实证「2 本 Lv5 野外稀每队却只装了 1 本」）。
 *   「技能族」的可靠键 = 能装出该技能的书 itemId 前缀 floor(id/100)：同前缀族内已有更高档挂载时
 *   装低档必拒；不同前缀（25235 稀有段 vs 25035 普通段）互不干扰、可并存（温泰实验 L77/L108 双向实证）。
 *
 * 与竞品B（helper.pro.gatherResource attachSkill/detachSkill）的差异化：
 *   - 台账精确归还 vs 内容白名单反推：本模块只卸自己补装的项（kind:'fill' 入账），组2 里的玩家手装
 *     技能与复制项（组1 原件占账、卸不还账）一概不动；白名单只作台账丢失后的 reconcile 兜底。
 *   - 底层 _firstSkillList/_secondSkillList 直读 vs 遮蔽 getter：穿皮肤时 index0 的 skill_type==3
 *     技能会被 replaceHeroExclusiveSkill 就地换 id，读 getter 会误判。
 *   - 10906 事件驱动确认 vs asleep(1000) 盲等：每次写包等 10906 槽位生效（实测 <100ms），3s 超时兜底；
 *     waiter 必须先注册再发包——10906 恒先于 resp 到达（录制实证 t+11.3 req → t+11.4 push → t+11.4 resp），
 *     await send 之后才注册推送早已分发完，确认 100% 错过（20261121 真机 20/20 全超时教训）。
 *   - 897 专属频控（march_time_control_info001=「操作过快」toast）：窗口从上次受理起算，300ms 内第二发
 *     必拒、3s 间隔 9 连发全受理（真机 20261121 双轮实证；与 902 行军限流同键但窗口独立——同窗 march 902
 *     间隔 8s 三连发全成功互不影响）。studySlot 发包前主动等满 STUDY_GAP_MS。
 *   - release 必须进 finally（调用方纪律）：march 抛错也不锁死书池。
 *
 * v1 边界：只装配普通技能槽 3 格（isBuffSlot 恒 false）；专精槽（Star≥5 且 Level≥120 才有）留二期。
 */
import { createLog } from '../../../core/log.js';
import { storage } from '../../../core/storage.js';
import { netApi } from '../../../core/net.js';
import { SYM, userData, TABLE, tableNameEnum } from '../../../core/acl-engine.js';
import { l10n } from '../../../core/acl/l10n.js';
import { sleep } from '../../../core/util.js';
import {
  CMD_STUDY_HERO_SKILL,
  CMD_FORGET_HERO_SKILL,
  CMD_CHANGE_HERO_SKILLS_INDEX,
  PUSH_HERO_INFO,
} from './constants.js';

/** @type {ReturnType<typeof createLog>} 模块日志器（tag=AUTO-FARM-SKILL） */
const log = createLog('AUTO-FARM-SKILL');

// ─────────────────────────── 纯函数层（单测直驱，不碰网络/游戏态） ───────────────────────────

/**
 * 资源 family → 技能书 itemId 前缀优先级表（竞品取证 + 字典表逐族复核 + 效率实证校准 20261121）。
 * 排序轴 = 稀有段优先：采集对应资源时野外采集速度稀有(25235) 与族专精稀有 效率数值相同
 * 且高于普通段（用户实证），故每族序为 野外稀 → 专精稀 → 野外普 → 专精普（竞品B 同序）——
 * 3 普通槽装满时第三本落在专精稀（而非野外普），库存不足降级时也优先保稀有段。
 * 每族恒带「野外采集速度」稀有+普通两本（全域增益），再按族补专精：石油→石油采集速度、
 * 粮食→粮食采集速度、金矿→金币采集速度（产量族 25031/25231 不采，与竞品同判据）；
 * 雷神无专属采集技能，负重（25236/25036）是雷神矿专属补位——其他族不用负重（竞品原序不动）。
 * 键与面板 familyOptions 一致（1=石油 5=粮食 7=金矿 16=雷神，priority.js FAMILY_RANK 同源）。
 * @type {Object<string, number[]>}
 */
export const SKILL_BOOK_FAMILIES = {
  1: [25235, 25233, 25035, 25033],
  5: [25235, 25234, 25035, 25034],
  7: [25235, 25232, 25035, 25032],
  16: [25235, 25035, 25236, 25036],
};

/** @type {number[]} 全部采集相关书前缀（白名单 = 各族表值的并集；reconcile 兜底与恢复按钮共用） */
export const COLLECT_BOOK_PREFIXES = [
  25235, 25035, 25234, 25034, 25233, 25033, 25232, 25032, 25236, 25036,
];

/** @type {number} ITEM 表里技能书行的 type 值（官方 getItemIdByHeroSkill 同判据） */
export const BOOK_TYPE = 42;

/**
 * 技能书 itemId → 族键（前缀）。同前缀 = 同技能族（含档位段）。
 * @param {number} itemId
 * @returns {number}
 */
export function bookPrefix(itemId) {
  return Math.floor((itemId | 0) / 100);
}

/**
 * ITEM 表反查：技能 + 档位 → 书 itemId（官方 HeroManager.getItemIdByHeroSkill 口径：
 * type==42 && para1==String(skillId) && level==档）。查无返回 0。
 * @param {Object<string, object>|null} items getTableGroup(ITEM) 行表（行含 {id,type,para1,level}）
 * @param {number} skillId 技能 id
 * @param {number} level 技能档位
 * @returns {number}
 */
export function itemIdForSkill(items, skillId, level) {
  if (!items) return 0;
  const want = String(skillId | 0);
  const lv = level | 0;
  for (const id in items) {
    const r = items[id];
    if (r && (r.type | 0) === BOOK_TYPE && String(r.para1) === want && (r.level | 0) === lv) {
      return r.id | 0;
    }
  }
  return 0;
}

/**
 * 技能 → 族键（能装出它的书前缀）。非技能书技能（如天赋/被动）返回 0。
 * @param {Object<string, object>|null} items
 * @param {number} skillId
 * @returns {number}
 */
export function skillFamilyPrefix(items, skillId) {
  if (!items || !(skillId | 0)) return 0;
  const want = String(skillId | 0);
  for (const id in items) {
    const r = items[id];
    if (r && (r.type | 0) === BOOK_TYPE && String(r.para1) === want) return bookPrefix(r.id);
  }
  return 0;
}

/**
 * ITEM 表 → 采集书技能白名单（para1 集合）：前缀 ∈ COLLECT_BOOK_PREFIXES 的全部 para1。
 * @param {Object<string, object>|null} items
 * @returns {Object<string, boolean>}
 */
export function collectSkillWhitelist(items) {
  const set = {};
  if (!items) return set;
  for (const id in items) {
    const r = items[id];
    if (r && (r.type | 0) === BOOK_TYPE && COLLECT_BOOK_PREFIXES.indexOf(bookPrefix(r.id)) >= 0) {
      set[String(r.para1)] = true;
    }
  }
  return set;
}

/**
 * 装配计划：组1 内容复制进组2 空槽 + 剩余空槽按族补采集书。
 *
 * 复制判定（逐条对应温泰实验）：
 *   - 组2 已挂同款（同 skillId）→ 跳过（幂等：组2 有 20205Lv5 时组1 的 20205Lv5 不再发 897）；
 *   - 组2 已挂同族（书前缀相同）→ 跳过（组2 已挂 25235 族更高档时复制低档必撞 hero_skill_equip001；
 *     组2 的玩家手装非采集技能不在任何书族内，不拦复制）；
 *   - 表里查不到对应档位的书 → 跳过（不该发生，防脏表发盲包）。
 * 补书判定（以下 taken/fams 均为「本英雄范围内」的占用表，逐英雄重建——同队不同英雄互不影响，
 *   同款多本可各装一本；单英雄同族仍只 1 本，与游戏排他一致）：
 *   - 背包 Amount>0 且书前缀 ∈ 该族优先级表；
 *   - 同款（para1 已被组2 挂载/复制计划占用）跳过；同族（前缀已被占用）跳过——一个英雄同族就一本，
 *     同族第二本要么撞 equip001 要么挤占空槽；
 *   - 同 para1 多档书（如泰温专属 2503801~2503805）取背包有货的最高档；
 *   - 前缀表顺序即优先级（野外稀 → 专精稀 → 野外普 → 专精普，稀有段效率优先），逐槽从高到低填。
 * 组2 的非空槽永不覆盖（玩家手装内容按征用快照语义原样保留）。
 *
 * @param {Object<string, object>|null} items ITEM 行表
 * @param {Array<{skillId:number,level:number}>} g1 组1 槽位（底层 _firstSkillList 摊平）
 * @param {Array<{skillId:number,level:number}>} g2 组2 槽位（底层 _secondSkillList 摊平）
 * @param {Array<{itemId:number,amount:number}>} bag 背包技能书摊平（Amount>0）
 * @param {number[]} prefixes 该资源族的书前缀优先级（SKILL_BOOK_FAMILIES 值）
 * @returns {{copy:Array<{index:number,skillId:number,level:number,itemId:number}>, fill:Array<{index:number,skillId:number,level:number,itemId:number}>, trace:Array<string>}}
 *   决策理由逐条落 trace（人类可读流水，调用方 debug 输出；纯函数自身不直接打日志）
 */
export function planAttach(items, g1, g2, bag, prefixes) {
  const copy = [];
  const fill = [];
  if (!items) return { copy: copy, fill: fill, trace: trace };
  const g2Arr = Array.isArray(g2) ? g2 : [];
  const g1Arr = Array.isArray(g1) ? g1 : [];
  const trace = []; // 决策流水：每条 copy/fill/skip 一行（供调用方 debug 输出，验证选书对拍用）
  const g2Ids = {}; // 组2 已挂 skillId
  const fams = {}; // 族键 → {skillId,level,from:'g2'|'copy'|'fill'}（trace 要打「组2 已挂谁」故存明细）
  const taken = {}; // 已占 para1（同款只装一本）
  const free = []; // 组2 空槽下标
  for (let i = 0; i < g2Arr.length; i++) {
    const s = g2Arr[i] || {};
    const sid = s.skillId | 0;
    if (sid) {
      g2Ids[sid] = true;
      taken[String(sid)] = true;
      const f = skillFamilyPrefix(items, sid);
      if (f) fams[f] = { skillId: sid, level: s.level | 0, from: 'g2' };
    } else {
      free.push(i);
    }
  }
  // 复制：组1 非空 → 组2 空槽
  let fi = 0;
  for (let i = 0; i < g1Arr.length && fi < free.length; i++) {
    const s1 = g1Arr[i] || {};
    const sid = s1.skillId | 0;
    if (!sid || g2Ids[sid]) {
      if (sid) trace.push('dup skill=' + sid + ' lv=' + (s1.level | 0)); // 组2 已挂同款（幂等跳过）
      continue;
    }
    const fam = skillFamilyPrefix(items, sid);
    if (fam && fams[fam]) {
      // 组2 同族已有挂载：复制低档必撞 hero_skill_equip001（温泰 L77 直证），trace 带已挂档位
      trace.push(
        'low skill=' +
          sid +
          ' lv=' +
          (s1.level | 0) +
          ' (g2 has ' +
          fams[fam].skillId +
          ' lv=' +
          fams[fam].level +
          ' fam=' +
          fam +
          ')',
      );
      continue;
    }
    const itemId = itemIdForSkill(items, sid, s1.level | 0);
    if (!itemId) {
      trace.push('no-book skill=' + sid + ' lv=' + (s1.level | 0)); // 表里查无此档书（防脏表发盲包）
      continue;
    }
    const idx = free[fi++];
    copy.push({ index: idx, skillId: sid, level: s1.level | 0, itemId: itemId });
    trace.push('copy idx=' + idx + ' skill=' + sid + ' lv=' + (s1.level | 0) + ' book=' + itemId);
    taken[String(sid)] = true;
    if (fam) fams[fam] = { skillId: sid, level: s1.level | 0, from: 'copy' };
  }
  // 补书：剩余空槽
  const left = free.slice(fi);
  if (!left.length || !Array.isArray(prefixes)) return { copy: copy, fill: fill, trace: trace };
  const bySkill = {}; // para1 → 背包有货的最高档书
  for (let i = 0; i < (bag || []).length; i++) {
    const b = bag[i] || {};
    const iid = b.itemId | 0;
    if (!iid || !(b.amount | 0)) continue;
    const row = items[String(iid)] || items[iid];
    if (!row || (row.type | 0) !== BOOK_TYPE) continue;
    const pfx = bookPrefix(iid);
    if (prefixes.indexOf(pfx) < 0) continue;
    const pid = String(row.para1);
    if (taken[pid]) continue; // 同款已占
    if (fams[pfx]) continue; // 同族已占（组2 手装/复制计划/已选 fill）
    const cur = bySkill[pid];
    if (!cur || (row.level | 0) > (cur.level | 0)) {
      bySkill[pid] = { itemId: iid, level: row.level | 0, skillId: row.para1 | 0, prefix: pfx };
    }
  }
  for (let i = 0; i < prefixes.length && left.length; i++) {
    let best = null;
    for (const pid in bySkill) {
      const c = bySkill[pid];
      if (c.prefix !== prefixes[i]) continue;
      if (!best || c.level > best.level) best = c;
    }
    if (!best) {
      trace.push('no-stock prefix=' + prefixes[i]); // 优先级表此段背包无货（选书表 vs 库存对拍点）
      continue;
    }
    delete bySkill[String(best.skillId)];
    const fidx = left.shift();
    fill.push({
      index: fidx,
      skillId: best.skillId,
      level: best.level,
      itemId: best.itemId,
    });
    trace.push(
      'fill idx=' +
        fidx +
        ' book=' +
        best.itemId +
        ' skill=' +
        best.skillId +
        ' lv=' +
        best.level +
        ' prefix=' +
        best.prefix,
    );
    taken[String(best.skillId)] = true;
    fams[best.prefix] = { skillId: best.skillId, level: best.level, from: 'fill' };
  }
  return { copy: copy, fill: fill, trace: trace };
}

/**
 * 归还计划（台账丢失后的 reconcile 兜底 / 恢复按钮的第一步）：组2 逐槽找出
 * 「属于采集白名单 && 快照该槽没有同款」的技能 → 898 卸。快照本就有的（玩家原有采集书）
 * 与白名单外的（玩家手装战斗技能）一律不动。
 * @param {Object<string, object>|null} items
 * @param {Array<{skillId:number,level:number}>} g2
 * @param {Array<{skillId:number,level:number}>|null} snapshot 征用时组2 快照（null = 全白名单命中）
 * @returns {Array<{index:number,skillId:number}>}
 */
export function planDetachSlots(items, g2, snapshot) {
  const out = [];
  if (!items) return out;
  const wl = collectSkillWhitelist(items);
  const snap = Array.isArray(snapshot) ? snapshot : [];
  const g2Arr = Array.isArray(g2) ? g2 : [];
  for (let i = 0; i < g2Arr.length; i++) {
    const s = g2Arr[i] || {};
    const sid = s.skillId | 0;
    if (!sid || !wl[String(sid)]) continue;
    const ss = snap[i] || {};
    if ((ss.skillId | 0) === sid) continue; // 快照本就有
    out.push({ index: i, skillId: sid });
  }
  return out;
}

// ─────────────────────────── 协议流程层（台账 + 发包 + 确认） ───────────────────────────

/** @type {string} storage.slot 独立键（UID 前缀隔离，ledger/snapshot 分片不大、单键整存） */
const SLOT_KEY = 'autoFarm.skill';

/** @type {{ledger:Array, snapshot:Object, snapAt:number, loadouts:Object}} 内存态（懒加载自 slot，写后回盘；loadouts[heroId]={str,ts} 最近装配快照） */
var state = { ledger: [], snapshot: {}, snapAt: 0, loadouts: {} };
/** @type {boolean} slot 已加载标记（UID 切换后 blob 缓存换前缀，本键随 namespace 隔离，无需手动失效） */
var loaded = false;

async function loadState() {
  if (loaded) return state;
  try {
    const s = await storage.slot.get(SLOT_KEY);
    state.ledger = s && Array.isArray(s.ledger) ? s.ledger : [];
    state.snapshot = s && s.snapshot && typeof s.snapshot === 'object' ? s.snapshot : {};
    state.snapAt = (s && s.snapAt) | 0;
    state.loadouts = s && s.loadouts && typeof s.loadouts === 'object' ? s.loadouts : {};
  } catch (e) {
    log.warn('skill state load failed, start clean: %s', e && e.message);
  }
  loaded = true;
  return state;
}

function persistState() {
  const copy = {
    ledger: state.ledger.slice(),
    snapshot: state.snapshot,
    snapAt: state.snapAt,
    loadouts: state.loadouts,
  };
  storage.slot.set(SLOT_KEY, copy).catch(function (err) {
    log.warn('skill state persist failed: %s', err && err.message);
  });
}

// ── 游戏态只读（底层字段直读，避开皮肤遮蔽 getter） ──

function heroData(heroId) {
  const u = userData();
  const heros = u && u.Heros;
  if (!heros) return null;
  return heros[String(heroId)] || heros[heroId] || null;
}

function heroSkillsIndex(h) {
  return h ? h._skillsIndex | 0 || 1 : 1;
}

/**
 * 槽位摊平：组1(1)/组2(2)。直读 _firstSkillList/_secondSkillList——SecondSkillList getter 会走
 * replaceHeroExclusiveSkill，穿皮肤且 index0 为 skill_type==3 时 id 被换，不能用于装配判定。
 */
function heroSkillSlots(h, idx) {
  if (!h) return [];
  const arr = idx === 1 ? h._firstSkillList : idx === 2 ? h._secondSkillList : null;
  if (!Array.isArray(arr)) return [];
  return arr.map(function (s) {
    return { skillId: (s && s.skillId) | 0, level: (s && s.level) | 0 };
  });
}

function itemTable() {
  // 走 ACL 收口原语（probe 剥信封 + 失败重探）：游戏模块导出是信封（{TableName:{...}}），
  // 裸 game.get('TableName').ITEM 恒 undefined → getTableGroup(undefined) 游戏侧静默返回 undefined
  //（真机 20261121 实证：两支队伍间隔 10s 都撞「item table unavailable」，非时序问题是形态问题）。
  const T = TABLE();
  const E = tableNameEnum(); // TableName 枚举成员 ITEM="item"（TableName.js 实证，大小写混合）
  const name = (E && E.ITEM) || (SYM.tables && SYM.tables.item) || 'item';
  let grp; // try/catch 两分支必赋值（eslint no-useless-assignment：初始值不写）
  try {
    grp = T && typeof T.getTableGroup === 'function' ? T.getTableGroup(name) : null;
  } catch (e) {
    grp = null;
  }
  if (!grp) log.debug('item table unavailable. T=%s enum=%s name=%s', !!T, !!E, name); // 归因：T 缺失 / 枚举缺失 / 表未加载
  return grp;
}

/** 背包技能书摊平 [{itemId, amount}]（官方 getItemsByType(42)，Amount>0 已滤） */
function bagSkillItems() {
  const u = userData();
  if (!u || typeof u.getItemsByType !== 'function') return [];
  const arr = u.getItemsByType(BOOK_TYPE) || [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    const iid = it && it.ItemId != null ? it.ItemId | 0 : 0;
    const amt = it ? it.Amount | 0 : 0;
    if (iid > 0 && amt > 0) out.push({ itemId: iid, amount: amt });
  }
  return out;
}

function bagFind(bag, itemId) {
  for (let i = 0; i < bag.length; i++) if ((bag[i].itemId | 0) === (itemId | 0)) return bag[i];
  return null;
}

/**
 * 借出一本实体书：内存 bag 按 itemId 逐本消账（Amount-1），清空才归零。
 * 账目粒度是 (heroId,itemId)——同 itemId 有 N 本就能在同一次装配里发给 N 个不同英雄
 * （每英雄同族仍只 1 本，由 planAttach 保证）；整条清零等于「同款全局只借一本」，
 * 会让多本同款在一队里只有一位英雄用上（服务端 10401 也是 -1 而非清零）。
 * @param {Array<{itemId:number,amount:number}>} bag bagSkillItems 摊平结果（就地消账）
 * @param {number} itemId 借出的书
 * @returns {boolean} 是否有货并完成消账
 */
export function consumeBagBook(bag, itemId) {
  const bk = Array.isArray(bag) ? bagFind(bag, itemId) : null;
  if (!bk || !(bk.amount | 0)) return false;
  bk.amount = Math.max(0, (bk.amount | 0) - 1);
  return true;
}

/** 槽位上下文格式化（debug 决策日志用）：`[20301:5,0:0,20205:5]`，空槽 0:0 */
function slotsStr(arr) {
  return (
    '[' +
    (arr || [])
      .map(function (s) {
        return ((s && s.skillId) | 0) + ':' + ((s && s.level) | 0);
      })
      .join(',') +
    ']'
  );
}

/** 背包书清单格式化（debug 决策日志用）：`2503805:1,2523506:1`（itemId:amount，Amount>0 已滤） */
function bagStr(bag) {
  return (bag || [])
    .map(function (b) {
      return (b.itemId | 0) + ':' + (b.amount | 0);
    })
    .join(',');
}

// ── 实装清单输出（装配完成后逐英雄汇报组2 最终态，用户要求可验证） ──

/** 技能表行 → {name, tag, icon}：skillId → hero_skill 表行（HeroSkillPanelV1 同链路：
 *  TABLE.getTableDataById('hero_skill', String(skillId)).name）；quality=2 稀有 / 1 普通 / 0 主动 3 专属
 *  （同名不同 id 的通用装备技 20116/21116 同链路，warroom 渲染器实证）；tag 供徽章着色；行/表缺失降级 name? 不阻塞。
 *  图标按游戏权威口径分支（HeroElementItem.UpdateSkillItem 源码实锤）：skill_type==1 走
 *  hero_skill.skill_icon（裸名拼 image/hero_skill/ 前缀）；其余类型图标在 item 表
 *  （type=42 家族、para1=skillId、level=1 行的 icon，已是完整 bundle 路径形态）——
 *  非 skill_type=1 行的 skill_icon 是废弃占位（真机实证全表同值 skill_icon020 金红书图，
 *  与实际技能不符），照抄必全同错图 */
function skillInfo(skillId) {
  const T = TABLE();
  const E = tableNameEnum();
  const tn = (E && E.HEROSKILL) || 'hero_skill';
  let row; // try/catch 两分支必赋值（eslint no-useless-assignment：初始值不写）
  try {
    row =
      T && typeof T.getTableDataById === 'function'
        ? T.getTableDataById(tn, String(skillId))
        : null;
  } catch (e) {
    row = null;
  }
  if (!row || !row.name) return { name: 'name?', tag: '', icon: '' };
  const q = row.quality | 0;
  let icon = '';
  try {
    if ((row.skill_type | 0) === 1) {
      icon = row.skill_icon ? 'image/hero_skill/' + row.skill_icon : '';
    } else if (typeof T.getTableByKey === 'function') {
      // 游戏 UpdateSkillItem 同款：item 表 type=42 家族按 para1=skillId 反查 level=1 行
      const inKey = (E && E.ITEM) || 'item';
      const it = T.getTableByKey(inKey, 'type', 42, 'para1', skillId, 'level', 1);
      icon = it && it.length && it[0] && it[0].icon ? String(it[0].icon) : '';
    }
  } catch (e) {
    icon = '';
  }
  return {
    name: l10n.text(row.name) || 'name?',
    tag: q === 2 ? '稀' : q === 1 ? '普' : q === 0 ? '主动' : '',
    icon,
  };
}

/** 技能名称（+稀有度标记）：`野外采集速度[稀]`（loadoutStr 日志格式沿用：只标 稀/普，其余不追加） */
function skillName(skillId) {
  const si = skillInfo(skillId);
  return si.name + (si.tag === '稀' || si.tag === '普' ? '[' + si.tag + ']' : '');
}

/** 组2 实装清单格式化：`21205 野外采集速度[稀] lv6 | 20205 野外采集速度[普] lv6`（空槽跳过，全空回 empty） */
function loadoutStr(h, idx) {
  const slots = heroSkillSlots(h, idx) || [];
  const parts = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || !(s.skillId | 0)) continue;
    parts.push((s.skillId | 0) + ' ' + skillName(s.skillId) + ' lv' + (s.level | 0));
  }
  return parts.length ? parts.join(' | ') : 'empty';
}

/** 组2 实装清单结构化（面板「队列技能」徽章数据源）：[{skillId,name,tag,level}]（空槽跳过，可回 []） */
function loadoutItems(h, idx) {
  const slots = heroSkillSlots(h, idx) || [];
  const items = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || !(s.skillId | 0)) continue;
    const si = skillInfo(s.skillId);
    items.push({
      skillId: s.skillId | 0,
      name: si.name,
      tag: si.tag,
      icon: si.icon,
      level: s.level | 0,
    });
  }
  return items;
}

// ── 10906 等待（常驻订阅 + waiter 注册表；install 挂订阅，pause 放行全部 waiter） ──

/** @type {Array<{heroId:number,pred:Function,resolve:Function,timer:number}>} */
var heroWaiters = [];
var subscribed = false; // 10906 订阅在挂与否（install 置 true / pause 置 false）；pause 后新 waiter 直通

function onHeroInfoPush(ev) {
  // ev 是 net 事件对象（raw 池化复用，载荷在 ev.data，同 tower-scanner 10452 先例）；
  // 10906 载荷 = {hero:{...}} 包裹（20261121 温泰录制直证），hero 含 id/skillsIndex/firstSkills/subSkills/skills
  const d = ev && ev.data;
  const h = d && d.hero;
  const hid = h ? Number(h.id) | 0 : 0;
  if (!hid) return;
  for (let i = heroWaiters.length - 1; i >= 0; i--) {
    const w = heroWaiters[i];
    if (w.heroId !== hid) continue;
    let ok = false;
    try {
      ok = w.pred(h);
    } catch (e) {
      /* pred 只读比较，异常按未命中处理 */
    }
    if (ok) {
      heroWaiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(h);
    }
  }
}

/**
 * 等某英雄的 10906 满足 pred（实测 66~104ms；超时 resolve null，调用方以本地态兜底继续）。
 * 返回 promise 带 cancel()：请求被拒/未发出时主动放行，不留 3s 悬挂（pause 放行同语义）。
 * @param {number} heroId
 * @param {(hero:Object)=>boolean} pred
 * @param {number} timeoutMs
 * @returns {Promise<Object|null>} 带 cancel 方法的 promise（pause 直通态 cancel 为空实现）
 */
function waitHeroInfo(heroId, pred, timeoutMs) {
  if (!subscribed) {
    // pause 后订阅被 reactor 摘除，10906 永不到来：直通 null（带空 cancel 保持调用侧形状），
    // 在途 release 不再逐项 3s 白等（20261121 真机：pause 后 11 项 forget 白等 33s）
    const p0 = Promise.resolve(null);
    p0.cancel = function () {};
    return p0;
  }
  let cancel = null;
  const p = new Promise(function (resolve) {
    const w = { heroId: heroId | 0, pred: pred, resolve: resolve, timer: null };
    cancel = function () {
      if (w.timer) clearTimeout(w.timer);
      const i = heroWaiters.indexOf(w);
      if (i >= 0) heroWaiters.splice(i, 1);
      resolve(null);
    };
    w.timer = setTimeout(cancel, timeoutMs);
    heroWaiters.push(w);
  });
  p.cancel = cancel;
  return p;
}

// ── 发包原语（V1 send 通道——温泰录制里 897/898/1345 的 raw.api 恒 "send"） ──

function send(cmd, body) {
  const n = netApi;
  if (!n || typeof n.sendGuarded !== 'function') return Promise.resolve(null);
  return n.sendGuarded(cmd, body, { protocol: 'send' });
}

function rejectKey(ret) {
  if (!ret) return 'not-sent';
  if (ret.data && typeof ret.data === 'string') return String(ret.data); // hero_skill_equip001 等裸串
  return String(ret.code);
}

/** 897 最小间隔：窗口从上次受理起算——300ms 内第二发必拒、3s 间隔 9 连发全受理（真机 20261121
 *  双轮实证），取 4s = 实测通过值 + 1s 余量；与 902 行军限流同键不同窗，无需跨模块协调 */
var STUDY_GAP_MS = 4000;
var lastStudyOkTs = 0; // 页面生命周期内共享；0=从未受理（首把立即发）；被拒不重置窗口

/** @type {number} 单条台账 898 的最大重试轮数；超过即清账交 reconcile 的快照 diff 兜底（防永久残留逐轮撞拒刷屏） */
var FORGET_RETRY_MAX = 3;

/**
 * 切技能组（1345）。受理后等 10906 skillsIndex 翻转确认；超时则信任游戏本地态继续。
 * @param {number} heroId
 * @param {number} idx 目标组（1|2）
 * @returns {Promise<boolean>}
 */
async function switchGroup(heroId, idx) {
  const t0 = Date.now();
  // 10906 先于 resp 到达（录制实证）：waiter 必须先注册再发包——await send 之后才注册，
  // 推送早已分发完，确认 100% 错过（20261121 真机 20/20 全超时教训）。ack 耗时（实证 66~104ms）
  // 从注册起算打进 debug，验证 10906 时序不必再翻录制。
  const ack = waitHeroInfo(
    heroId,
    function (x) {
      return (x.skillsIndex | 0) === idx;
    },
    3000,
  );
  const ret = await send(CMD_CHANGE_HERO_SKILLS_INDEX, { heroId: heroId, skillsIndex: idx });
  if (!ret || !ret.ok) {
    ack.cancel();
    log.info('group switch rejected. heroId=%d idx=%d reason=%s', heroId, idx, rejectKey(ret));
    return false;
  }
  const h = await ack;
  if (!h) log.warn('switch ack timeout, trust local state. heroId=%d idx=%d', heroId, idx);
  else log.debug('group switched. heroId=%d idx=%d (ack %dms)', heroId, idx, Date.now() - t0);
  return true;
}

/**
 * 装书（897）。受理后等 10906 组2 该槽出现目标技能；拒绝（含 hero_skill_equip001）走 info 不中断。
 * @param {number} heroId
 * @param {{index:number,skillId:number,level:number,itemId:number}} plan
 * @returns {Promise<boolean>}
 */
async function studySlot(heroId, plan, aliveFn) {
  if (aliveFn && !aliveFn()) return false; // feat 已停：不发包不占频控窗口
  // 897 频控节流必须先于 waiter 注册（否则等待期间 waiter 已 3s 超时放行，造成假 timeout）
  const gap = STUDY_GAP_MS - (Date.now() - lastStudyOkTs);
  if (gap > 0) await sleep(gap);
  if (aliveFn && !aliveFn()) return false; // 等待期间被停（最多滞后一个节流窗口，不再发包）
  const t0 = Date.now();
  const ack = waitHeroInfo(
    heroId,
    function (x) {
      const slots = x.subSkills || [];
      const s = slots[plan.index];
      return !!s && (s.skillId | 0) === (plan.skillId | 0);
    },
    3000,
  ); // 10906 先于 resp：先注册 waiter 再发包（switchGroup 处时序注释）
  const ret = await send(CMD_STUDY_HERO_SKILL, {
    heroId: heroId,
    index: plan.index,
    itemId: plan.itemId,
    isBuffSlot: false,
    skillsIndex: 2,
  });
  if (ret && ret.ok) {
    lastStudyOkTs = Date.now();
    const h = await ack;
    if (!h)
      log.warn('study ack timeout. heroId=%d index=%d itemId=%d', heroId, plan.index, plan.itemId);
    else
      log.debug(
        'study accepted. heroId=%d index=%d itemId=%d skillId=%d (ack %dms)',
        heroId,
        plan.index,
        plan.itemId,
        plan.skillId,
        Date.now() - t0,
      );
    return true;
  }
  ack.cancel();
  log.info(
    'study rejected. heroId=%d index=%d itemId=%d reason=%s',
    heroId,
    plan.index,
    plan.itemId,
    rejectKey(ret),
  );
  return false;
}

/**
 * 卸书（898，按槽位寻址）。受理后等 10906 组2 该槽清空。
 * @param {number} heroId
 * @param {number} index
 * @returns {Promise<boolean>}
 */
async function forgetSlot(heroId, index) {
  const t0 = Date.now();
  const ack = waitHeroInfo(
    heroId,
    function (x) {
      const slots = x.subSkills || [];
      const s = slots[index];
      return !!s && !(s.skillId | 0);
    },
    3000,
  ); // 10906 先于 resp：先注册 waiter 再发包（switchGroup 处时序注释）
  const ret = await send(CMD_FORGET_HERO_SKILL, {
    heroId: heroId,
    index: index,
    isBuffSlot: false,
    skillsIndex: 2,
  });
  if (ret && ret.ok) {
    const h = await ack;
    if (!h) log.warn('forget ack timeout. heroId=%d index=%d', heroId, index);
    else
      log.debug('forget accepted. heroId=%d index=%d (ack %dms)', heroId, index, Date.now() - t0);
    return true;
  }
  ack.cancel();
  log.info('forget rejected. heroId=%d index=%d reason=%s', heroId, index, rejectKey(ret));
  return false;
}

// ── 对外流程 ──

/**
 * 装配（acquire）：逐英雄 快照组2 → 切组2 → 复制组1 → 空槽补采集书。
 * fill 项逐条入台账（kind:'fill'）；copy 项不入账（组1 原件占账，卸不还账，永不必卸）。
 * 内存 bag 按实体本数逐本消账（consumeBagBook）：同款多本可同队发给多个英雄，账目镜像服务端 10401。
 * @param {number[]} heroIds 预设英雄集（plan.presetHeroIds）
 * @param {number} family 资源 family（cand.family，选书表键）
 * @param {function():boolean} [aliveFn] 宿主存活门（auto-farm 引擎 alive）：每英雄/每槽前检查，
 *        false 即中止装配（已完成英雄不回滚，调用方 finally 的 release 统一归还）
 * @returns {Promise<number>} 完成装配动作的英雄数（0 = 全部跳过/无表/无书/中止）
 */
async function attachHeroes(heroIds, family, aliveFn) {
  if (!Array.isArray(heroIds) || !heroIds.length) return 0;
  await loadState();
  const items = itemTable();
  if (!items) {
    log.warn('skill attach skipped: item table unavailable.');
    return 0;
  }
  const prefixes = SKILL_BOOK_FAMILIES[family | 0];
  if (!prefixes) {
    log.warn('no skill book plan for family %s.', family);
    return 0;
  }
  const bag = bagSkillItems();
  log.debug(
    'attach begin. heroes=%s family=%d prefixes=%s bag=[%s]',
    heroIds.join(','),
    family | 0,
    prefixes.join('+'),
    bagStr(bag),
  );
  let heroes = 0;
  for (let i = 0; i < heroIds.length; i++) {
    const hid = heroIds[i] | 0;
    if (!hid) continue;
    if (aliveFn && !aliveFn()) {
      log.debug(
        'attach aborted. heroes=%d/%d (feat paused mid-run, rest skipped).',
        heroes,
        heroIds.length,
      );
      break;
    }
    let h = heroData(hid);
    if (!h) {
      log.debug('hero %d data unavailable, skip attach.', hid);
      continue;
    }
    if (heroSkillsIndex(h) === 2) {
      log.debug('hero already on group2. heroId=%d', hid);
    } else if (!(await switchGroup(hid, 2))) continue;
    // 首次征用前整组存快照（1345 零内容变化，切组前后读等价；面板「归还」按此还原）
    if (!state.snapshot[String(hid)]) {
      state.snapshot[String(hid)] = heroSkillSlots(h, 2);
      state.snapAt = Date.now();
      persistState();
      log.debug(
        'snapshot stored. heroId=%d g2=%s (first borrow; restore button plays this back)',
        hid,
        slotsStr(state.snapshot[String(hid)]),
      );
    }
    const g1 = heroSkillSlots(h, 1);
    const g2 = heroSkillSlots(h, 2);
    const plan = planAttach(items, g1, g2, bag, prefixes);
    log.debug(
      'attach plan. heroId=%d g1=%s g2=%s decisions=[%s]',
      hid,
      slotsStr(g1),
      slotsStr(g2),
      plan.trace.join(' | '),
    );
    let done = 0;
    for (let c = 0; c < plan.copy.length; c++) {
      if (await studySlot(hid, plan.copy[c], aliveFn)) done++;
    }
    for (let f = 0; f < plan.fill.length; f++) {
      const pf = plan.fill[f];
      const bk = bagFind(bag, pf.itemId);
      if (!bk || !(bk.amount | 0)) {
        log.info('skill book out of stock, skip. heroId=%d itemId=%d', hid, pf.itemId);
        continue;
      }
      if (!(await studySlot(hid, pf, aliveFn))) continue;
      done++;
      consumeBagBook(bag, pf.itemId); // 逐本消账：同款还剩货就继续发给下一位英雄（跨队轮转靠 release 还账后重读背包）
      state.ledger.push({
        heroId: hid,
        index: pf.index,
        isBuffSlot: false,
        itemId: pf.itemId,
        skillId: pf.skillId,
        kind: 'fill',
        ts: Date.now(),
      });
      log.debug(
        'ledger push. heroId=%d index=%d itemId=%d skillId=%d (ledger=%d)',
        hid,
        pf.index,
        pf.itemId,
        pf.skillId,
        state.ledger.length,
      );
    }
    if (done) {
      heroes++;
      // 记录最近装配清单（面板「队列技能」字段读）：借还轮转下英雄身上随即卸空，
      // 这份出发瞬间的实装快照是核对「这队带了什么书」的唯一持久证据（与日志 loadout 行同源）；
      // items 是徽章渲染用的结构化孪生（旧档无 items，面板侧降级走 str 文本行）
      const hh = heroData(hid) || h;
      state.loadouts[String(hid)] = {
        str: loadoutStr(hh, 2),
        items: loadoutItems(hh, 2),
        ts: Date.now(),
      };
      persistState();
      log.info('skill loadout. heroId=%d skills=[%s]', hid, state.loadouts[String(hid)].str);
      log.info(
        'skill attach done. heroId=%d copy=%d fill=%d (ledger=%d)',
        hid,
        plan.copy.length,
        plan.fill.length,
        state.ledger.length,
      );
    } else {
      log.debug(
        'attach idle. heroId=%d copy=%d fill=%d (nothing accepted; plan empty or all rejected)',
        hid,
        plan.copy.length,
        plan.fill.length,
      );
    }
  }
  log.debug('attach end. attached=%d/%d', heroes, heroIds.length);
  return heroes;
}

/**
 * 归还（release）：逐英雄 卸台账 fill 项（组2 生效态）→ 切回组1 → 清台账。
 * ❗调用方必须放 finally——march 抛错/中止也不能跳过本函数，否则书池被钉死。
 * 收尾粒度 = 本轮派兵的英雄集（不是「有台账的英雄」）：纯 copy 装配不入账，按台账分组会把整位
 * 英雄跳过——生效组停在组2、组2 留着采集镜像，直到下轮 reconcile 才擦净（真机 20261122 石太郎
 * heroId=122：release 只报 heroes=2 slots=8，122 既没卸也没切回）。
 * 卸书失败（898 被拒 / 未发出）的台账条目不整批清：留在账上下轮 release 重试，满 FORGET_RETRY_MAX
 * 轮才清账并交给 reconcile 的快照 diff 兜底（槽已空则直接销账，不必每轮撞同一个拒）。
 * @param {number[]} heroIds
 * @returns {Promise<number>} 成功卸下的槽数
 */
async function releaseHeroes(heroIds) {
  if (!Array.isArray(heroIds) || !heroIds.length) return 0;
  await loadState();
  const ids = heroIds.map(function (x) {
    return x | 0;
  });
  log.debug('release begin. heroes=%s ledger=%d', ids.join(','), state.ledger.length);
  const byHero = {};
  for (let i = state.ledger.length - 1; i >= 0; i--) {
    const e = state.ledger[i];
    if (!e || ids.indexOf(e.heroId | 0) < 0) continue;
    (byHero[e.heroId] = byHero[e.heroId] || []).push(e);
  }
  let slots = 0;
  let kept = 0;
  let back = 0;
  for (let i = 0; i < ids.length; i++) {
    const hid = ids[i];
    if (!hid) continue;
    const list = byHero[hid];
    if (list && list.length) {
      let keep = list; // 默认整批留账：英雄数据读不到 / 切不到组2，一笔都没动
      const h = heroData(hid);
      if (h && (heroSkillsIndex(h) === 2 || (await switchGroup(hid, 2)))) {
        keep = [];
        const g2 = heroSkillSlots(h, 2); // h 是游戏 HeroData 活引用，此处读到的是卸书前的当下槽态
        for (let j = 0; j < list.length; j++) {
          const e = list[j];
          if (await forgetSlot(hid, e.index)) {
            slots++;
            continue;
          }
          const cur = g2[e.index | 0] || {};
          if (!(cur.skillId | 0)) continue; // 槽已空 = 书已不在身上（玩家手卸/重复归还），留账只会每轮撞拒
          e.tries = (e.tries | 0) + 1;
          if (e.tries >= FORGET_RETRY_MAX) {
            log.warn(
              'forget giving up after %d tries, leave to reconcile. heroId=%d index=%d itemId=%d',
              e.tries,
              hid,
              e.index,
              e.itemId | 0,
            );
            continue;
          }
          keep.push(e);
        }
      }
      if (keep.length !== list.length) {
        state.ledger = state.ledger.filter(function (e2) {
          return (e2.heroId | 0) !== hid || keep.indexOf(e2) >= 0;
        });
      }
      kept += keep.length;
      log.debug(
        'ledger settled. heroId=%d released=%d kept=%d',
        hid,
        list.length - keep.length,
        keep.length,
      );
    }
    // 切回组1：feat 征用过的英雄（有快照）或本轮动过台账的都须还原生效组；玩家自己的组2（无快照）不干预
    const hb = heroData(hid);
    const borrowed = !!(list && list.length) || !!state.snapshot[String(hid)];
    if (borrowed && hb && heroSkillsIndex(hb) === 2 && (await switchGroup(hid, 1))) back++;
  }
  if (slots || kept || back) {
    persistState();
    log.info(
      'skill release done. heroes=%d slots=%d back=%d kept=%d',
      Object.keys(byHero).length,
      slots,
      back,
      kept,
    );
  }
  return slots;
}

/**
 * 残留归还（reconcile）：启动/pause/换 UID 各挂一次。
 * ① 台账 fill 项逐条 898（槽上没书时服务器拒绝走 info，无副作用）→ 切回组1；
 * ② 有快照的英雄扫 skillsIndex==2：组2 与快照 diff 出的采集白名单残留照卸 + 切回组1
 *    （无快照的英雄是玩家自己的组2，feat 无权干预，聚合 warn 一条）。
 * @returns {Promise<number>} 归还动作数
 */
async function reconcile() {
  await loadState();
  const items = itemTable();
  log.debug(
    'reconcile begin. ledger=%d snapshots=%d',
    state.ledger.length,
    snapshotHeroIds().length,
  );
  let ops = 0;
  if (state.ledger.length) {
    const byHero = {};
    for (let i = 0; i < state.ledger.length; i++) {
      const e = state.ledger[i];
      (byHero[e.heroId] = byHero[e.heroId] || []).push(e);
    }
    state.ledger = [];
    persistState();
    for (const key in byHero) {
      const hid = key | 0;
      let h = heroData(hid);
      if (heroSkillsIndex(h) !== 2 && !(await switchGroup(hid, 2))) continue;
      const list = byHero[key];
      for (let j = 0; j < list.length; j++) {
        if (await forgetSlot(hid, list[j].index)) ops++;
      }
      await switchGroup(hid, 1);
    }
  }
  if (items) {
    const u = userData();
    const heros = u && u.Heros;
    let orphan = 0;
    for (const k in heros || {}) {
      const h = heros[k];
      if (!h || heroSkillsIndex(h) !== 2) continue;
      const hid = h.Id != null ? h.Id | 0 : 0;
      const snap = state.snapshot[String(hid)];
      if (!snap) {
        orphan++;
        continue; // 玩家自己的组2：不卸不切
      }
      const drop = planDetachSlots(items, heroSkillSlots(h, 2), snap);
      if (!drop.length) {
        log.debug('reconcile no residual. heroId=%d (switch back only)', hid);
        await switchGroup(hid, 1); // 无残留，只切回
        ops++;
        continue;
      }
      log.debug(
        'reconcile residual. heroId=%d drop=[%s]',
        hid,
        drop
          .map(function (x) {
            return x.index + ':' + x.skillId;
          })
          .join(','),
      );
      for (let d = 0; d < drop.length; d++) {
        if (await forgetSlot(hid, drop[d].index)) ops++;
      }
      await switchGroup(hid, 1);
      ops += drop.length;
    }
    if (orphan)
      log.info('heroes on group2 without feat snapshot (user-owned, left alone): %d', orphan);
  }
  if (ops) log.info('skill reconcile done. ops=%d', ops);
  return ops;
}

/**
 * 归还按钮：按快照把组2 恢复到征用前原样（卸白名单残留 → 空槽装回快照内容）并清快照。
 * 仅当无在借台账时可用（调用方判 ledgerCount()==0）。书不在包内时该槽跳过（info）。
 * @param {number[]} heroIds（缺省 = 全部快照英雄）
 * @returns {Promise<number>} 动作数
 */
async function restoreSnapshots(heroIds) {
  await loadState();
  const items = itemTable();
  if (!items) return 0;
  const ids =
    Array.isArray(heroIds) && heroIds.length
      ? heroIds.map(function (x) {
          return x | 0;
        })
      : snapshotHeroIds();
  const bag = bagSkillItems();
  log.debug('restore begin. heroes=%s bag=[%s]', ids.join(','), bagStr(bag));
  let ops = 0;
  for (let i = 0; i < ids.length; i++) {
    const hid = ids[i];
    const snap = state.snapshot[String(hid)];
    if (!snap) continue;
    let h = heroData(hid);
    if (!h) continue;
    if (heroSkillsIndex(h) !== 2 && !(await switchGroup(hid, 2))) continue;
    const drop = planDetachSlots(items, heroSkillSlots(h, 2), snap);
    for (let d = 0; d < drop.length; d++) {
      if (await forgetSlot(hid, drop[d].index)) ops++;
    }
    const g2 = heroSkillSlots(h, 2);
    for (let s = 0; s < snap.length && s < g2.length; s++) {
      const want = snap[s] || {};
      const sid = want.skillId | 0;
      if (!sid) continue;
      const cur = g2[s] || {};
      if (cur.skillId | 0) {
        log.debug(
          'restore skip occupied. heroId=%d index=%d cur=%d want=%d (never overwrite)',
          hid,
          s,
          cur.skillId | 0,
          sid,
        );
        continue; // 槽仍被占（残留非白名单/玩家新装）不覆盖
      }
      const itemId = itemIdForSkill(items, sid, want.level | 0);
      if (!itemId) continue;
      const bk = bagFind(bag, itemId);
      if (!bk || !(bk.amount | 0)) {
        log.info('restore skip (book not in bag). heroId=%d itemId=%d', hid, itemId);
        continue;
      }
      if (await studySlot(hid, { index: s, skillId: sid, level: want.level | 0, itemId: itemId })) {
        ops++;
        consumeBagBook(bag, itemId);
      }
    }
    await switchGroup(hid, 1);
    delete state.snapshot[String(hid)];
    persistState();
    log.debug('snapshot cleared. heroId=%d (restore finished)', hid);
  }
  log.info('skill snapshot restore done. heroes=%d ops=%d', ids.length, ops);
  return ops;
}

function snapshotHeroIds() {
  const out = [];
  for (const k in state.snapshot) {
    const n = k | 0;
    if (n) out.push(n);
  }
  return out;
}

// ── 面板/宿主接口 ──

/**
 * 最近装配清单（面板「队列技能」字段读）：同步读内存态。面板 get() 是同步的，slot 尚未加载时
 * 顺带懒触发异步加载（本轮返回 null，下一轮面板刷新补齐）。
 * @param {number} heroId
 * @returns {{str:string,ts:number}|null} str = 出发瞬间组2 实装清单（loadoutStr 口径）
 */
function loadoutInfo(heroId) {
  if (!loaded) void loadState();
  return (loaded && state.loadouts[String(heroId | 0)]) || null;
}

/**
 * 在借台账规模（面板「归还技能组2」按钮的可用性判据：>0 时归还按钮禁用，先 run 完轮转）。
 * @returns {Promise<number>}
 */
async function ledgerCount() {
  await loadState();
  return state.ledger.length;
}

/**
 * 快照规模（面板按钮显示判据：0 = 从未征用过，隐藏）。
 * @returns {Promise<number>}
 */
async function snapshotCount() {
  await loadState();
  return snapshotHeroIds().length;
}

/**
 * 宿主接线：挂 10906 常驻订阅（waiter 分发）。ctx.on.push 的退订由 reactor 在宿主 pause 时统一摘除。
 * @param {object} ctx 宿主 feat ctx
 */
function install(ctx) {
  subscribed = true;
  ctx.on.push(PUSH_HERO_INFO, onHeroInfoPush);
}

/** pause 钩子：置订阅不在挂（新 waiter 直通）+ 放行全部在途 waiter（resolve null），
 *  避免订阅被 reactor 摘除后 waiter 挂满超时 */
function pause() {
  subscribed = false;
  const ws = heroWaiters.splice(0, heroWaiters.length);
  for (let i = 0; i < ws.length; i++) {
    clearTimeout(ws[i].timer);
    ws[i].resolve(null);
  }
}

export const skillAttach = {
  install: install,
  pause: pause,
  reconcile: reconcile,
  attachHeroes: attachHeroes,
  releaseHeroes: releaseHeroes,
  restoreSnapshots: restoreSnapshots,
  ledgerCount: ledgerCount,
  snapshotCount: snapshotCount,
  loadoutInfo: loadoutInfo,
  heroData: heroData,
  loadoutItems: loadoutItems,
  /** 技能图标 bundle 路径（按 skillId 现查表；旧快照 items 无 icon 字段时的渲染期兜底） */
  skillIconPath: (skillId) => skillInfo(skillId).icon,
};
