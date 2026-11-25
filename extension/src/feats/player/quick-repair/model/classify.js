/**
 * 修理单位分类（纯判据，无游戏态访问）：军种 × 类型。
 *
 * 源码锚点：
 *   - 军种 = `army.Data.type` ∈ GameDefine.ArmyType（Land 101 / Sea 201 / Air 301）；
 *   - 雷神线 = `army.Data.thor_group>0`（FlameController.isFlameArmyById 同款判据）；
 *     超级雷神（`thor_group>=100` 或 `glorious_science_group>0`）与普通雷神（`thor_group` 1~15）
 *     在游戏中不会同时存在（升级超级后所有雷神变为超级），面板合并为单一「雷神」类型。
 *
 * 配置表对拍（解码 dynres/config_optim2_1.5.11775.txt 与 1.5.12631.txt，tools/parse-config-tables.py）：
 *   army_type_hospital===2 ⇔ thor_group>0，两版 177 行零违例（84xxxx 雷神兵 45 行 thor_group 1~15；
 *   90xxxx 超雷神 132 行 thor_group 100~600 + glorious_science_group 10000）；===1 是普通兵 780 行，空为非修理单位。
 *   该列只是「雷神系」二值标签，医院代码不区分普通/超雷神——本地/跨服/无双分流统一用
 *   FlameController.isFlameArmyById（实现即 thor_group>0），故本模块判据与游戏同源。
 *
 * 判据缺失（部队对象拿不到 / type 非三值）按「陆·普通」归并（tierOf 取不到部队返回 normal）：
 * 绝不因分类失败而漏修普通兵。
 */

/** @type {string[]} 军种枚举顺序（面板列顺序） */
export const ARMS = ['land', 'navy', 'air'];

/** @type {string[]} 类型枚举顺序（面板行顺序，由低到高） */
export const TIERS = ['normal', 'thor'];

/** @type {Object<string, string>} army.Data.type → 军种 */
const ARM_BY_TYPE = { 101: 'land', 201: 'navy', 301: 'air' };

/** @type {Object<string, string>} 军种短名（日志/面板） */
export const ARM_LABEL = { land: '陆', navy: '海', air: '空' };

/** @type {Object<string, string>} 类型短名（日志/面板） */
export const TIER_LABEL = { normal: '普通', thor: '雷神' };

/**
 * 军种判定：army.Data.type 101/201/301 → land/navy/air。
 * @param {object|null} army UserData.getArmyByArmyUuid(uuid) 结果
 * @returns {'land'|'navy'|'air'|null} 判据缺失返回 null
 */
export function armOf(army) {
  const d = army && army.Data;
  return (d && ARM_BY_TYPE[Number(d.type)]) || null;
}

/**
 * 类型判定：thor_group/glorious_science_group → normal/thor。
 * 雷神与超级雷神不会同时出现（升级后全部变为超级），合并为单一 'thor' 类型。
 * @param {object|null} army 部队对象
 * @returns {'normal'|'thor'} 判据缺失按 normal（旧版兜底口径）
 */
export function tierOf(army) {
  const d = army && army.Data;
  if (!d) return 'normal';
  const tg = Number(d.thor_group) || 0;
  if (tg > 0 || Number(d.glorious_science_group) > 0) return 'thor';
  return 'normal';
}

/**
 * 单位分类（军种 + 类型），判据缺失按 fallback 归并（缺省「陆·普通」）。
 * 战场抢修车间的跨服队列可传 fallback={arm:'land',tier:'thor'}——该场地只收雷神，
 * 部队对象拿不到时按雷神保守归类，避免被判成普通兵而从「只修雷神」的范围里漏掉。
 * @param {object|null} army 部队对象
 * @param {{arm?:string, tier?:string}} [fallback] 判据缺失时的归类
 * @returns {{arm:string, tier:string, exact:boolean}} exact=false 表示部队对象缺失、走了兜底
 */
export function classifyUnit(army, fallback) {
  const d = army && army.Data;
  const fb = fallback || {};
  return {
    arm: (d && ARM_BY_TYPE[Number(d.type)]) || fb.arm || 'land',
    tier: d ? tierOf(army) : fb.tier || 'normal',
    exact: !!d,
  };
}

/**
 * 是否雷神类型。
 * @param {string} tier 类型
 * @returns {boolean}
 */
export function isThorTier(tier) {
  return tier === 'thor';
}

/**
 * 场地 × 军种 × 类型 → 稳定键（日志/单测断言用；面板配置键见 model/schema.js 的 repairKey/speedKey）。
 * @param {string} venue 场地（base/csb/ava）
 * @param {string} arm 军种
 * @param {string} tier 类型
 * @returns {string} 形如 `base.land.normal`
 */
export function unitClassKey(venue, arm, tier) {
  return venue + '.' + arm + '.' + tier;
}
