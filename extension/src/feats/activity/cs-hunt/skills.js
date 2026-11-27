/**
 * feats/activity/cs-hunt/skills.js —— 夺宝奇兵（CSHunt）科技目录与「能否用/怎么选」纯查询。
 *
 * 定位：把「28 行 cross_treasure_skill 静态目录（specId/名/group/type）」与「阶段闸门 + 池内择优」两处
 *   纯逻辑从编排引擎里抽出来，供 scenes/*、engine-flow.js、index.js 面板 resolve 共用，避免各处硬编码 specId→名。
 *   不发包、不摸 net/reactor、不读运行期背包（背包可用性由引擎 #canUse 依据 7550 应答判定），故可独立单测。
 *
 * 证据：目录逐行取自 extension/docs/feat-夺宝奇兵.md §9.2（真机 dump 定稿，28 行）；group=1=队伍技能仅队长可用、
 *   group=2=个人技能全员可用；type 语义对齐源码 CSEventSkillSpeType 枚举（先知 5 / COPY 12 / 刷新 13 / 转换 14）。
 *
 * 3~8（战场变换×6）、12~16（诱敌来袭×5）、19~21（固定增强×3）为同类多行，真机 dump 未逐行区分专名，此处按序号命名
 *   （仅作面板展示用，不影响协议——发包一律用裸 specId）。面板「科技池」按归族键把它们**归族为一个可勾选项**
 *   （见 SKILL_GROUPS / groupMembers）：勾选一族即代表族内全部 specId 都算命中，取消一族即整族不主动选。
 *   归族键缺省 = type；游戏改版新增的「同名异 type」行（如 specId 25 百战不倒 type=15）用 `fam` 覆盖并入既有族。
 */
import { EVENT_PHASE_STATE, SKILL_REFRESH, SKILL_PROPHET } from './constants.js';

/**
 * @typedef {object} SkillRow 科技目录行
 * @property {number} specId 科技 id（7551 skillSpecId / 7538 候选位映射键）
 * @property {string} name 中文名（面板 resolve 展示用；协议层不依赖）
 * @property {number} group 1=队伍技能（仅队长可用）/ 2=个人技能（全员可用）
 * @property {number} type cross_treasure_skill.type（源码 CSEventSkillSpeType 线值，阶段/效果语义源）
 * @property {number} [fam] 归族键覆盖（缺省按 type 归族）：把游戏改版新增的「同名异 type」行并入既有族（如 specId 25 并入 specId 1 百战不倒族），type 仍保留游戏实值
 */

/**
 * 科技静态目录（§9.2 定稿 28 行）。按 specId 升序，便于面板 `all` 直接铺出全量。
 * @type {SkillRow[]}
 */
export const SKILL_CATALOG = [
  { specId: 1, name: '百战不倒', group: 1, type: 1 },
  { specId: 2, name: '铜墙铁壁', group: 1, type: 2 },
  { specId: 3, name: '战场变换Ⅰ', group: 1, type: 3 },
  { specId: 4, name: '战场变换Ⅱ', group: 1, type: 3 },
  { specId: 5, name: '战场变换Ⅲ', group: 1, type: 3 },
  { specId: 6, name: '战场变换Ⅳ', group: 1, type: 3 },
  { specId: 7, name: '战场变换Ⅴ', group: 1, type: 3 },
  { specId: 8, name: '战场变换Ⅵ', group: 1, type: 3 },
  { specId: 9, name: '预料先知', group: 1, type: 5 },
  { specId: 10, name: '动态隐形', group: 1, type: 6 },
  { specId: 11, name: '自由闪现', group: 1, type: 7 },
  { specId: 12, name: '诱敌来袭Ⅰ', group: 1, type: 8 },
  { specId: 13, name: '诱敌来袭Ⅱ', group: 1, type: 8 },
  { specId: 14, name: '诱敌来袭Ⅲ', group: 1, type: 8 },
  { specId: 15, name: '诱敌来袭Ⅳ', group: 1, type: 8 },
  { specId: 16, name: '诱敌来袭Ⅴ', group: 1, type: 8 },
  { specId: 17, name: '安全锁定', group: 2, type: 9 },
  { specId: 18, name: '幸运降临', group: 2, type: 10 },
  { specId: 19, name: '固定增强Ⅰ', group: 2, type: 11 },
  { specId: 20, name: '固定增强Ⅱ', group: 2, type: 11 },
  { specId: 21, name: '固定增强Ⅲ', group: 2, type: 11 },
  { specId: 22, name: '完美镜像', group: 2, type: 12 },
  { specId: 23, name: '全量刷新', group: 2, type: 13 },
  { specId: 24, name: '数据转换', group: 2, type: 14 },
  // 游戏改版新增行：cross_treasure_skill 里 name 仍是 cs_treasure213「百战不倒」，但 type=15（源码枚举未见）。
  //   真机 skillSpecIdList 里 specId 1(18次) 与 25(12次) 都会派发、无法断定谁取代谁 → 按用户口径 UI 上并入「百战不倒」一族
  //   （fam:1 覆盖归族键，代表 id 取族内最小 specId=1；勾选该族 = 1 或 25 命中皆算）。type 保留游戏实值 15。
  { specId: 25, name: '百战不倒', group: 1, type: 15, fam: 1 },
  { specId: 26, name: '毫发难伤', group: 1, type: 16 },
  { specId: 27, name: '火线急救', group: 1, type: 4 },
  { specId: 28, name: '天外守护', group: 1, type: 17 },
];

/**
 * specId → 目录行 索引（O(1) 查 group/type/name）。
 * @type {Object<number,SkillRow>}
 */
export const SKILL_BY_ID = SKILL_CATALOG.reduce(function (m, row) {
  m[row.specId] = row;
  return m;
}, Object.create(null));

/** @type {number[]} 全量 specId（保留给需要逐行的调用方，如末回合清空判定） */
export const SKILL_IDS = SKILL_CATALOG.map(function (r) {
  return r.specId;
});

/**
 * 科技按归族键（缺省 type，可被 `fam` 覆盖）归族（面板「科技池」的候选单元）：同族多行折叠成一个可勾选项，
 *   「勾选一类即勾选全部」——战场变换(type3, specId3-8)/诱敌来袭(type8,12-16)/固定增强(type11,19-21)；
 *   游戏改版新增的同名异 type 行（specId 25 百战不倒 fam=1）并入既有族；单行科技自成一项。
 *   代表 id = 该族最小 specId（面板 off/order 均以代表 id 落存）。
 * @type {Array<{id:number,type:number,name:string,members:number[]}>}
 */
export const SKILL_GROUPS = (function () {
  var byFam = Object.create(null);
  for (var i = 0; i < SKILL_CATALOG.length; i++) {
    var r = SKILL_CATALOG[i];
    var fam = r.fam != null ? r.fam : r.type;
    (byFam[fam] || (byFam[fam] = [])).push(r);
  }
  var fams = Object.keys(byFam)
    .map(Number)
    .sort(function (a, b) {
      return byFam[a][0].specId - byFam[b][0].specId;
    });
  var groups = [];
  for (var f = 0; f < fams.length; f++) {
    var rows = byFam[fams[f]].slice().sort(function (a, b) {
      return a.specId - b.specId;
    });
    groups.push({
      id: rows[0].specId,
      type: fams[f],
      name: familyName(rows),
      members: rows.map(function (x) {
        return x.specId;
      }),
    });
  }
  return groups;
})();

/** 族名：单行回本名；多行剥去序数后缀（Ⅰ..Ⅹ）取公共族名。 */
function familyName(rows) {
  if (rows.length === 1) return rows[0].name;
  return rows[0].name.replace(/[\u2160-\u2169]+$/, '');
}

/** @type {number[]} 各族代表 id（面板 sortlist `all` 铺源、defaults 铺全量用） */
export const SKILL_GROUP_IDS = SKILL_GROUPS.map(function (g) {
  return g.id;
});

var MEMBER_BY_GROUP = SKILL_GROUPS.reduce(function (m, g) {
  m[g.id] = g.members;
  return m;
}, Object.create(null));

// 成员 specId → 族代表 id 反查表（旧存档迁移用：把散开的同类多行收敛回一个族项）
var REP_BY_MEMBER = SKILL_GROUPS.reduce(function (m, g) {
  for (var i = 0; i < g.members.length; i++) m[g.members[i]] = g.id;
  return m;
}, Object.create(null));

/**
 * 任意 specId（族代表或成员）→ 族代表 id（旧存档 order 迁移用）。未知 id 原样回数字。
 * @param {number|string} specId 科技 specId 或已是族代表 id
 * @returns {number}
 */
export function skillGroupRep(specId) {
  var id = Number(specId);
  return REP_BY_MEMBER[id] || id;
}

/**
 * 组代表 id → 成员 specId 列表（命中判定用：勾选一族 = 其全部成员科技都算命中）。单行/未知回 [id]。
 * @param {number|string} repId 组代表 id
 * @returns {number[]}
 */
export function groupMembers(repId) {
  return MEMBER_BY_GROUP[Number(repId)] || [Number(repId)];
}

/**
 * 组代表 id → 族名（面板 resolve 展示；未知回 skillName 兜底）。
 * @param {number|string} repId 组代表 id
 * @returns {string}
 */
export function groupName(repId) {
  var id = Number(repId);
  for (var i = 0; i < SKILL_GROUPS.length; i++)
    if (SKILL_GROUPS[i].id === id) return SKILL_GROUPS[i].name;
  return skillName(id);
}

/**
 * specId → 中文科技名（面板 resolve / 日志兜底；未知 id 回 `科技 <id>`）。
 * @param {number|string} specId 科技 id
 * @returns {string}
 */
export function skillName(specId) {
  var row = SKILL_BY_ID[Number(specId)];
  return row ? row.name : '科技 ' + specId;
}

/**
 * 该科技是否队伍技能（group=1，仅队长可发）。未知 id 保守当个人技能（false）。
 * @param {number} specId 科技 id
 * @returns {boolean}
 */
export function isTeamSkill(specId) {
  var row = SKILL_BY_ID[Number(specId)];
  return !!row && row.group === 1;
}

/**
 * 阶段闸门：科技是否可在当前生命周期位使用（纯查询，不含背包持有/队长判定，那些由引擎 #canUse 负责）。
 *   - 预料先知(9，type=5)：仅 DECIDE 阶段（提前揭示候选）；
 *   - 全量刷新(23，type=13)：仅事件执行态（且调用方另判当前场景=族号 4 pickSkill）；
 *   - 其余科技：阶段不限。
 * @param {number} specId 科技 id
 * @param {number} status 本跑状态（HUNT_STATUS，DECIDE/EVENT 均属 EVENT=2；保留入参供扩展）
 * @param {string} eiStatus eventInfo.status 二级阶段（EVENT_PHASE_STATE 值）
 * @returns {boolean} 阶段是否放行
 */
export function canPhase(specId, status, eiStatus) {
  var id = Number(specId);
  if (id === SKILL_PROPHET) return eiStatus === EVENT_PHASE_STATE.DECIDE;
  if (id === SKILL_REFRESH) return eiStatus === EVENT_PHASE_STATE.EVENT;
  // COPY(22) 在探索回合（WAIT）由调用方 #explorationSkills 显式串用（数据转换→重判→复制先知），阶段不限；type5 先知才强制仅 DECIDE
  void status;
  return true;
}

/**
 * 按「用户勾选+拖拽优先级池（族代表 id）」在候选里取第一个命中位的 **1-based 下标**（pickSkill 选位用）。
 *   池项是族代表 id，经 groupMembers 展开为其全部成员 specId——勾选一族 = 族内任一成员出现在候选即命中。
 * @param {number[]} pool 用户勾选并按优先级排序的族代表 id（靠前优先，已剔除未勾项）
 * @param {number[]} candidates 本场景候选 specId 列表（如 eventPickSkillInfo.skillSpecIdList）
 * @param {number[]} [exclude] 强制排除的 specId（如陪跑不选幸运降临 18）——命中位若在此集合即跳过，继续找下一候选
 * @returns {number} 命中候选的 1-based pos；无命中回 0（调用方据此走刷新/随机兜底）
 */
export function chooseByPool(pool, candidates, exclude) {
  var order = Array.isArray(pool) ? pool : [];
  var list = Array.isArray(candidates) ? candidates.map(Number) : [];
  var excl = Array.isArray(exclude) ? exclude.map(Number) : [];
  for (var i = 0; i < order.length; i++) {
    var members = groupMembers(order[i]);
    for (var m = 0; m < members.length; m++) {
      var at = list.indexOf(Number(members[m]));
      if (at >= 0 && excl.indexOf(list[at]) < 0) return at + 1;
    }
  }
  return 0;
}

/**
 * 完美镜像(22) 复制择目标（用户策略：严格只复制先知）。
 *   候选源 = 背包里 `type≠COPY` 的科技（`copyable` 由调用方 #copyableSet 传入前已剔除 COPY 自身，
 *   且含队伍技能——完美镜像是 group=2 个人技，复制队技不需队长权限，报文实证 陪跑成员 22{copySkillSpecId:26} 成功）。
 *   择法（产品口径）：背包出现先知(9)即复制先知；**没有先知则本轮不复制**（宁可留着镜像，交转换后重判或下一回合）。
 * @param {{copyable:number[]}} opts copyable=背包可复制 specId（已排除 COPY）
 * @returns {number} 目标 specId（先知 9；0=本轮不复制）
 */
export function chooseCopyTarget(opts) {
  var o = opts || {};
  var list = Array.isArray(o.copyable) ? o.copyable : [];
  return list.indexOf(SKILL_PROPHET) >= 0 ? SKILL_PROPHET : 0;
}
